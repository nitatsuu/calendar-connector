/**
 * Thin wrappers over the Calendar advanced service: error codes, retries, idempotent writes.
 */

var CC_SEND = { sendUpdates: 'none' };

/** HTTP status of an advanced-service error (they only expose it in the message). */
function ccHttpCode_(e) {
  if (e && e.details && e.details.code) return e.details.code;
  var m = String((e && e.message) || e);
  if (/not found/i.test(m)) return 404;
  if (/has been deleted|no longer valid|gone/i.test(m)) return 410;
  if (/already exists|duplicate/i.test(m)) return 409;
  if (/rate limit|quota|too many/i.test(m)) return 429;
  var num = /\b(4\d\d|5\d\d)\b/.exec(m);
  return num ? +num[1] : 0;
}

function ccIsRateLimit_(e) {
  var code = ccHttpCode_(e);
  var m = String((e && e.message) || e);
  return code === 429 || (code === 403 && /rate|quota|limit/i.test(m)) || code >= 500;
}

/** Run fn, retrying rate-limit and server errors with exponential backoff. */
function ccCall_(fn) {
  for (var attempt = 0; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      if (attempt >= 4 || !ccIsRateLimit_(e)) throw e;
      Utilities.sleep(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 500));
    }
  }
}

/** Delete an event; a missing or already deleted event is fine. */
function ccRemove_(calId, eventId) {
  try {
    ccCall_(function () { Calendar.Events.remove(calId, eventId, CC_SEND); });
    return true;
  } catch (e) {
    var code = ccHttpCode_(e);
    if (code === 404 || code === 410) return false;
    throw e;
  }
}

/**
 * Create or overwrite a copy with a known id. Update also revives a previously deleted
 * copy (body.status is 'confirmed'); insert is only needed the first time.
 */
function ccUpsertMaster_(calId, eventId, body) {
  try {
    ccCall_(function () { Calendar.Events.update(body, calId, eventId, CC_SEND); });
    return;
  } catch (e) {
    var code = ccHttpCode_(e);
    if (code !== 404 && code !== 410) throw e;
  }
  var withId = Object.assign({ id: eventId }, body);
  try {
    ccCall_(function () { Calendar.Events.insert(withId, calId, CC_SEND); });
  } catch (e) {
    if (ccHttpCode_(e) !== 409) throw e;
    // Id exists as a deleted event: restore it, then write the body.
    ccCall_(function () { Calendar.Events.patch({ status: 'confirmed' }, calId, eventId, CC_SEND); });
    ccCall_(function () { Calendar.Events.update(body, calId, eventId, CC_SEND); });
  }
}

/** Update one occurrence of a copied series. Returns false if the series copy does not exist yet. */
function ccUpdateInstance_(calId, instanceId, body) {
  try {
    ccCall_(function () { Calendar.Events.update(body, calId, instanceId, CC_SEND); });
    return true;
  } catch (e) {
    var code = ccHttpCode_(e);
    if (code === 404 || code === 410 || code === 400) return false;
    throw e;
  }
}

/** All calendars in this account's calendar list. */
function ccListCalendars() {
  var out = [];
  var pageToken;
  do {
    var r = ccCall_(function () {
      return Calendar.CalendarList.list({ maxResults: 250, pageToken: pageToken, showHidden: true });
    });
    (r.items || []).forEach(function (c) {
      out.push({
        id: c.id,
        name: c.summaryOverride || c.summary || c.id,
        role: c.accessRole,
        color: c.backgroundColor,
        primary: !!c.primary,
        merged: (c.description || '').indexOf(CC_MARKER) !== -1,
      });
    });
    pageToken = r.nextPageToken;
  } while (pageToken);
  return out;
}
