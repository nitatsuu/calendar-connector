/**
 * Merged calendars: creation, colour, sharing, trigger.
 */

/** Written into the description of every merged calendar, so other accounts can find them. */
var CC_MARKER = 'Managed by Calendar Connector';

function ccCreateMergedCalendar(name, color) {
  var tz = ccCall_(function () { return Calendar.Settings.get('timezone'); }).value;
  var cal = ccCall_(function () {
    return Calendar.Calendars.insert({ summary: name, description: CC_MARKER, timeZone: tz });
  });
  if (color) ccSetColor(cal.id, color);
  var cfg = ccLoadConfig();
  cfg.merged.push({ id: cal.id, name: name, color: color || '', sources: [] });
  ccSaveConfig(cfg);
  return cal.id;
}

/**
 * Use a merged calendar created in another account (shared with this one as "make changes"):
 * this account's script will push its own calendars into it.
 */
function ccAttachMergedCalendar(calId) {
  var cal = ccEnsureInCalendarList_(calId);
  if (cal.accessRole !== 'owner' && cal.accessRole !== 'writer') {
    throw new Error('Нет права на запись в этот календарь. Выдай этому аккаунту «Внесение изменений».');
  }
  calId = cal.id; // the real id, also when "primary" or the account e-mail was given
  var cfg = ccLoadConfig();
  if (!ccFindMerged_(cfg, calId)) {
    cfg.merged.push({ id: calId, name: cal.summaryOverride || cal.summary, color: '', sources: [] });
    ccSaveConfig(cfg);
  }
}

/**
 * Calendar-list entry of a calendar, adding it to this account's list first if needed.
 * Inserting a calendar that is already listed (e.g. the account's own primary) can fail,
 * so look it up before inserting.
 */
function ccEnsureInCalendarList_(calId) {
  var me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();
  if (calId === 'primary' || calId.toLowerCase() === me) {
    return ccCall_(function () { return Calendar.CalendarList.get('primary'); });
  }
  try {
    return ccCall_(function () { return Calendar.CalendarList.get(calId); });
  } catch (e) {
    if (ccHttpCode_(e) !== 404) throw e;
  }
  try {
    ccCall_(function () { Calendar.CalendarList.insert({ id: calId }); });
  } catch (e) {
    var code = ccHttpCode_(e);
    if (code === 404 || code === 403) {
      throw new Error('Календарь ' + calId + ' не найден или не расшарен на этот аккаунт (' +
        String((e && e.message) || e) + ')');
    }
    if (code !== 409) throw e;
  }
  return ccCall_(function () { return Calendar.CalendarList.get(calId); });
}

/** Calendar colour as this account sees it (each viewer picks their own colour). */
function ccSetColor(calId, hex) {
  ccCall_(function () {
    Calendar.CalendarList.patch({ backgroundColor: hex, foregroundColor: '#ffffff' }, calId,
      { colorRgbFormat: true });
  });
}

function ccRenameCalendar(calId, name) {
  ccCall_(function () { Calendar.Calendars.patch({ summary: name }, calId); });
}

/** role: 'freeBusyReader' | 'reader' | 'writer' */
function ccShareWithUser(calId, email, role) {
  ccCall_(function () {
    Calendar.Acl.insert({ role: role, scope: { type: 'user', value: email } }, calId,
      { sendNotifications: true });
  });
}

/** role: 'none' | 'freeBusyReader' | 'reader'. Public access is what makes the share link work. */
function ccSetPublicAccess(calId, role) {
  if (role === 'none') {
    try {
      ccCall_(function () { Calendar.Acl.remove(calId, 'default'); });
    } catch (e) {
      if (ccHttpCode_(e) !== 404) throw e;
    }
    return;
  }
  ccCall_(function () { Calendar.Acl.insert({ role: role, scope: { type: 'default' } }, calId); });
}

function ccListAcl(calId) {
  var r = ccCall_(function () { return Calendar.Acl.list(calId); });
  return (r.items || []).map(function (a) {
    return { id: a.id, role: a.role, type: a.scope.type, value: a.scope.value || '' };
  });
}

function ccRemoveAcl(calId, ruleId) {
  ccCall_(function () { Calendar.Acl.remove(calId, ruleId); });
}

function ccShareLinks(calId) {
  var enc = encodeURIComponent(calId);
  return {
    web: 'https://calendar.google.com/calendar/embed?src=' + enc,
    ics: 'https://calendar.google.com/calendar/ical/' + enc + '/public/basic.ics',
    add: 'https://calendar.google.com/calendar/u/0?cid=' +
      Utilities.base64Encode(calId, Utilities.Charset.UTF_8).replace(/=+$/, ''),
  };
}

function ccTriggerInstalled_() {
  return ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'ccSyncAll';
  });
}

/** Run every 5 minutes. Safe to call repeatedly. */
function ccInstallTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ccSyncAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ccSyncAll').timeBased().everyMinutes(5).create();
}
