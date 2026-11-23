/**
 * Pure event-transformation logic: decides what to do with a source event and builds
 * the body of its copy. Uses no Apps Script services, so it runs (and is tested) in Node.
 */

var CC_PROP_SRC_CAL = 'ccSrcCal';
var CC_PROP_SRC_ID = 'ccSrcId';
var CC_DEFAULT_BUSY_LABEL = 'Busy';

/** Event types that make no sense as copies. */
var CC_SKIPPED_EVENT_TYPES = { workingLocation: true, birthday: true };

/** True if the event is a copy made by this tool (never copy copies: prevents loops). */
function ccIsOwnCopy(ev) {
  var p = ev.extendedProperties && ev.extendedProperties.private;
  return !!(p && p[CC_PROP_SRC_CAL]);
}

function ccIsDeclinedBySelf(ev) {
  return (ev.attendees || []).some(function (a) {
    return a.self && a.responseStatus === 'declined';
  });
}

function ccTimeToMs(t) {
  if (!t) return NaN;
  return t.dateTime ? Date.parse(t.dateTime) : Date.parse(t.date + 'T00:00:00Z');
}

/** True if every RRULE has an UNTIL before cutoff (series is over). */
function ccSeriesEndedBefore(recurrence, cutoffMs) {
  var rrules = (recurrence || []).filter(function (r) { return /^RRULE:/i.test(r); });
  if (!rrules.length) return false;
  return rrules.every(function (r) {
    var m = /UNTIL=(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?/i.exec(r);
    if (!m) return false;
    var until = Date.UTC(+m[1], +m[2] - 1, +m[3],
      m[4] ? +m[4] : 23, m[5] ? +m[5] : 59, m[6] ? +m[6] : 59);
    return until < cutoffMs;
  });
}

/**
 * Suffix Google uses for ids of recurring-event instances:
 * "<masterId>_20261123T080000Z" for timed events, "<masterId>_20261123" for all-day.
 */
function ccInstanceSuffix(originalStartTime) {
  if (originalStartTime.date) return originalStartTime.date.replace(/-/g, '');
  var iso = new Date(Date.parse(originalStartTime.dateTime)).toISOString();
  return iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** String hashed into the deterministic id of a copy. */
function ccIdSeed(targetCalId, srcCalId, srcEventId) {
  return [targetCalId, srcCalId, srcEventId].join('\n');
}

/**
 * Event id of a copy, from a hex hash of ccIdSeed(). Hex digits are valid base32hex,
 * which is what the Calendar API allows for client-chosen ids.
 */
function ccTargetIdFromHash(hashHex) {
  return 'cc' + hashHex.slice(0, 40).toLowerCase();
}

function ccMeetingLink(ev) {
  if (ev.hangoutLink) return ev.hangoutLink;
  var eps = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  for (var i = 0; i < eps.length; i++) {
    if (eps[i].entryPointType === 'video' && eps[i].uri) return eps[i].uri;
  }
  return '';
}

function ccCopyTime(t) {
  var out = {};
  if (t.date) out.date = t.date;
  if (t.dateTime) out.dateTime = t.dateTime;
  if (t.timeZone) out.timeZone = t.timeZone;
  return out;
}

/**
 * Decide what to do with one source event.
 *
 * @param {Object} ev      Calendar API event from the source calendar.
 * @param {Object} source  {calendarId, mode: 'full'|'busy', prefix?, busyLabel?}
 * @param {Object} ctx     {cutoffMs, busyLabel?}
 * @return {{action: 'upsert'|'delete'|'skip', kind: 'master'|'instance',
 *           masterSrcId: string, instanceSuffix?: string, body?: Object, reason?: string}}
 */
function ccPlanEvent(ev, source, ctx) {
  var isInstance = !!ev.recurringEventId;
  var plan = {
    kind: isInstance ? 'instance' : 'master',
    masterSrcId: isInstance ? ev.recurringEventId : ev.id,
  };
  if (isInstance) plan.instanceSuffix = ccInstanceSuffix(ev.originalStartTime);

  function result(action, reason) {
    plan.action = action;
    if (reason) plan.reason = reason;
    return plan;
  }

  if (ccIsOwnCopy(ev)) {
    // Copies are only passed on from a merged calendar used as a source ("cascade"),
    // and only if they came from a calendar this script does not read itself.
    // Otherwise they would come back as duplicates or loop forever.
    var origin = ev.extendedProperties.private[CC_PROP_SRC_CAL];
    var local = ctx.localOrigins || {};
    if (!source.cascade || local[origin]) return result('skip', 'own-copy');
  }
  if (ev.status === 'cancelled') return result('delete', 'cancelled');
  if (CC_SKIPPED_EVENT_TYPES[ev.eventType]) return result('skip', 'event-type');
  if (ccIsDeclinedBySelf(ev)) return result('delete', 'declined');

  var busy = source.mode === 'busy';
  if (busy && ev.transparency === 'transparent') return result('delete', 'free-time');

  if (ev.recurrence && ev.recurrence.length) {
    if (ccSeriesEndedBefore(ev.recurrence, ctx.cutoffMs)) return result('skip', 'too-old');
  } else if (ccTimeToMs(ev.end || ev.start) < ctx.cutoffMs) {
    return result('skip', 'too-old');
  }

  var priv = {};
  priv[CC_PROP_SRC_CAL] = source.calendarId;
  priv[CC_PROP_SRC_ID] = ev.id;

  var body = {
    status: 'confirmed',
    start: ccCopyTime(ev.start),
    end: ccCopyTime(ev.end),
    transparency: ev.transparency || 'opaque',
    // No reminders: the source calendar already notifies.
    reminders: { useDefault: false },
    extendedProperties: { private: priv },
  };
  // Attendees are never copied, otherwise Google would send invitations.

  if (!isInstance && ev.recurrence && ev.recurrence.length) {
    body.recurrence = ev.recurrence.slice();
  }
  if (isInstance) body.originalStartTime = ccCopyTime(ev.originalStartTime);

  if (busy) {
    body.summary = source.busyLabel || ctx.busyLabel || CC_DEFAULT_BUSY_LABEL;
  } else {
    var title = ev.summary || '(no title)';
    body.summary = source.prefix ? source.prefix + ' ' + title : title;
    var desc = ev.description || '';
    var link = ccMeetingLink(ev);
    if (link && desc.indexOf(link) === -1) desc = (desc ? desc + '\n\n' : '') + link;
    if (desc) body.description = desc;
    if (ev.location) body.location = ev.location;
    if (ev.visibility) body.visibility = ev.visibility;
  }

  plan.body = body;
  return result('upsert');
}

if (typeof module !== 'undefined') {
  module.exports = {
    ccPlanEvent: ccPlanEvent,
    ccInstanceSuffix: ccInstanceSuffix,
    ccSeriesEndedBefore: ccSeriesEndedBefore,
    ccTargetIdFromHash: ccTargetIdFromHash,
    ccIdSeed: ccIdSeed,
    ccIsOwnCopy: ccIsOwnCopy,
  };
}
