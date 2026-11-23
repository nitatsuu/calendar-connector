/**
 * Incremental sync: source calendars -> merged (target) calendars.
 * Entry point for the time trigger: ccSyncAll().
 */

var CC_LOOKBACK_DAYS = 30;
// Apps Script kills a run after 6 minutes; stop starting new work well before that.
var CC_TIME_BUDGET_MS = 4.5 * 60 * 1000;

function ccSyncAll() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    console.log('Another sync is still running, skipping this one');
    return;
  }
  try {
    var deadline = Date.now() + CC_TIME_BUDGET_MS;
    var cfg = ccLoadConfig();
    var localOrigins = ccLocalOrigins_(cfg);
    cfg.merged.forEach(function (mc) {
      (mc.sources || []).forEach(function (source) {
        if (Date.now() < deadline) ccSyncSource_(mc, source, deadline, localOrigins);
      });
    });
  } finally {
    lock.releaseLock();
  }
}

/** Id of the copy of a source event (or series) in the target calendar. */
function ccCopyId_(targetId, srcCalId, srcEventId) {
  return ccTargetIdFromHash(ccSha256Hex_(ccIdSeed(targetId, srcCalId, srcEventId)));
}

/**
 * Calendars this script itself reads or writes. Copies that originate from them are never
 * taken from a cascade source: this script already handles those events directly.
 */
function ccLocalOrigins_(cfg) {
  var local = {};
  cfg.merged.forEach(function (m) {
    local[m.id] = true;
    (m.sources || []).forEach(function (s) {
      if (!s.cascade) local[s.calendarId] = true;
    });
  });
  return local;
}

function ccSyncSource_(mc, source, deadline, localOrigins) {
  var st = ccLoadState_(mc.id, source.calendarId);
  var status = { at: new Date().toISOString(), upserted: 0, deleted: 0, skipped: 0, errors: 0 };
  var ctx = {
    cutoffMs: Date.now() - CC_LOOKBACK_DAYS * 864e5,
    busyLabel: mc.busyLabel,
    localOrigins: localOrigins || {},
  };
  var deferred = [];
  var resetOnce = false;

  try {
    for (;;) {
      var params = { maxResults: 250, singleEvents: false };
      if (st.syncToken) params.syncToken = st.syncToken;
      if (st.pageToken) params.pageToken = st.pageToken;

      var resp;
      try {
        resp = ccCall_(function () { return Calendar.Events.list(source.calendarId, params); });
      } catch (e) {
        if (ccHttpCode_(e) === 410 && !resetOnce) {
          // Sync token expired: start over with a full read (copies are idempotent).
          resetOnce = true;
          st = {};
          ccSaveState_(mc.id, source.calendarId, st);
          continue;
        }
        throw e;
      }

      // Series before their exceptions, so occurrence updates find the copied series.
      var items = (resp.items || []).slice().sort(function (a, b) {
        return (a.recurringEventId ? 1 : 0) - (b.recurringEventId ? 1 : 0);
      });
      items.forEach(function (ev) { ccApplyEvent_(mc, source, ev, ctx, status, deferred); });

      if (resp.nextPageToken) {
        st.pageToken = resp.nextPageToken;
        ccSaveState_(mc.id, source.calendarId, st);
        if (Date.now() > deadline) {
          status.partial = true;
          break;
        }
      } else {
        st = { syncToken: resp.nextSyncToken };
        ccSaveState_(mc.id, source.calendarId, st);
        break;
      }
    }

    // Occurrences whose series showed up on a later page.
    deferred.forEach(function (d) {
      if (ccUpdateInstance_(mc.id, d.id, d.body)) status.upserted++;
      else status.skipped++;
    });
  } catch (e) {
    status.errors++;
    status.lastError = String((e && e.message) || e);
    console.error('Sync ' + source.calendarId + ' -> ' + mc.id + ': ' + status.lastError);
  }

  ccSaveStatus_(mc.id, source.calendarId, status);
  return status;
}

function ccApplyEvent_(mc, source, ev, ctx, status, deferred) {
  var plan = ccPlanEvent(ev, source, ctx);
  if (plan.action === 'skip') {
    status.skipped++;
    return;
  }
  var masterId = ccCopyId_(mc.id, source.calendarId, plan.masterSrcId);
  try {
    if (plan.kind === 'master') {
      if (plan.action === 'delete') {
        if (ccRemove_(mc.id, masterId)) status.deleted++;
      } else {
        ccUpsertMaster_(mc.id, masterId, plan.body);
        status.upserted++;
      }
      return;
    }
    var instanceId = masterId + '_' + plan.instanceSuffix;
    if (plan.action === 'delete') {
      if (ccRemove_(mc.id, instanceId)) status.deleted++;
    } else {
      plan.body.recurringEventId = masterId;
      if (ccUpdateInstance_(mc.id, instanceId, plan.body)) status.upserted++;
      else deferred.push({ id: instanceId, body: plan.body });
    }
  } catch (e) {
    status.errors++;
    status.lastError = String((e && e.message) || e);
    console.error('Event ' + ev.id + ' from ' + source.calendarId + ': ' + status.lastError);
  }
}

/** Delete every copy that came from one source (used when a source is removed). */
function ccPurgeSource_(targetId, srcCalId) {
  var removed = 0;
  var pageToken;
  do {
    var r = ccCall_(function () {
      return Calendar.Events.list(targetId, {
        privateExtendedProperty: CC_PROP_SRC_CAL + '=' + srcCalId,
        maxResults: 250,
        pageToken: pageToken,
      });
    });
    (r.items || []).forEach(function (ev) {
      if (ccRemove_(targetId, ev.id)) removed++;
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return removed;
}
