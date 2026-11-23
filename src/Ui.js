/**
 * Web app (visible only to the account that deployed it) and the server functions it calls.
 */

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Calendar Connector')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function ccUiState() {
  var cfg = ccLoadConfig();
  var cals = ccListCalendars();
  var byId = {};
  cals.forEach(function (c) { byId[c.id] = c; });
  var configured = {};
  cfg.merged.forEach(function (m) { configured[m.id] = true; });

  return {
    email: Session.getEffectiveUser().getEmail(),
    triggerInstalled: ccTriggerInstalled_(),
    // Merged calendars can be sources too ("cascade"): only events that came from
    // calendars this script does not read itself are passed on (see ccPlanEvent).
    sources: cals.filter(function (c) { return c.role !== 'freeBusyReader'; }),
    attachable: cals.filter(function (c) {
      return c.merged && !configured[c.id] && (c.role === 'owner' || c.role === 'writer');
    }),
    merged: cfg.merged.map(function (m) {
      var cal = byId[m.id];
      var owner = !!cal && cal.role === 'owner';
      var statuses = {};
      (m.sources || []).forEach(function (s) { statuses[s.calendarId] = ccLoadStatus_(m.id, s.calendarId); });
      return Object.assign({}, m, {
        missing: !cal,
        owner: owner,
        primary: !!cal && cal.primary,
        statuses: statuses,
        acl: owner ? ccListAcl(m.id) : [],
        links: ccShareLinks(m.id),
      });
    }),
  };
}

function ccUiCreate(name, color) {
  name = String(name || '').trim();
  if (!name) throw new Error('Нужно название');
  ccCreateMergedCalendar(name, color);
  if (!ccTriggerInstalled_()) ccInstallTrigger();
  return ccUiState();
}

/**
 * Add a calendar shared with this account to its calendar list, so it can be a source.
 * Google does not always add shared calendars by itself (the recipient has to click the
 * link in the sharing e-mail). For a primary calendar the id is the account's e-mail.
 */
function ccUiAddSource(calId) {
  calId = String(calId || '').trim();
  if (!calId) throw new Error('Нужен ID календаря или email аккаунта');
  ccEnsureInCalendarList_(calId);
  return ccUiState();
}

function ccUiAttach(calId) {
  ccAttachMergedCalendar(calId);
  if (!ccTriggerInstalled_()) ccInstallTrigger();
  return ccUiState();
}

/** Save name, colour, busy label and sources of one merged calendar. */
function ccUiSave(input) {
  var cfg = ccLoadConfig();
  var mc = ccFindMerged_(cfg, input.id);
  if (!mc) throw new Error('Календарь не найден в настройках');

  var mergedIds = {};
  ccListCalendars().forEach(function (c) { if (c.merged) mergedIds[c.id] = true; });

  var busyLabel = String(input.busyLabel || '').trim();
  var busyLabelChanged = busyLabel !== (mc.busyLabel || '');
  var old = {};
  (mc.sources || []).forEach(function (s) { old[s.calendarId] = s; });

  var sources = (input.sources || [])
    .filter(function (s) { return s.calendarId && s.calendarId !== mc.id; })
    .map(function (s) {
      return {
        calendarId: String(s.calendarId),
        mode: s.mode === 'busy' ? 'busy' : 'full',
        cascade: !!mergedIds[String(s.calendarId)],
        prefix: String(s.prefix || '').trim(),
      };
    });

  // A source whose copies would look different must be re-read in full.
  sources.forEach(function (s) {
    var o = old[s.calendarId];
    var changed = !o || o.mode !== s.mode || (o.prefix || '') !== s.prefix || !!o.cascade !== s.cascade ||
      (s.mode === 'busy' && busyLabelChanged);
    if (changed) ccResetState_(mc.id, s.calendarId);
  });
  var removed = Object.keys(old).filter(function (id) {
    return !sources.some(function (s) { return s.calendarId === id; });
  });

  var name = String(input.name || '').trim() || mc.name;
  var color = String(input.color || '');
  if (name !== mc.name) {
    var entry = ccCall_(function () { return Calendar.CalendarList.get(mc.id); });
    // Never rename someone's primary calendar: it is named after the account.
    if (entry.accessRole === 'owner' && !entry.primary) ccRenameCalendar(mc.id, name);
  }
  if (color && color !== mc.color) ccSetColor(mc.id, color);

  mc.name = name;
  mc.color = color;
  mc.busyLabel = busyLabel;
  mc.sources = sources;
  ccSaveConfig(cfg);

  removed.forEach(function (id) {
    ccResetState_(mc.id, id);
    ccPurgeSource_(mc.id, id);
  });
  return ccUiState();
}

/** Stop syncing into a merged calendar. The calendar itself is kept; copies too unless purge. */
function ccUiDetach(calId, purge) {
  var cfg = ccLoadConfig();
  var mc = ccFindMerged_(cfg, calId);
  if (!mc) return ccUiState();
  (mc.sources || []).forEach(function (s) {
    ccResetState_(mc.id, s.calendarId);
    if (purge) ccPurgeSource_(mc.id, s.calendarId);
  });
  cfg.merged = cfg.merged.filter(function (m) { return m.id !== calId; });
  ccSaveConfig(cfg);
  return ccUiState();
}

function ccUiSyncNow() {
  ccSyncAll();
  return ccUiState();
}

function ccUiInstallTrigger() {
  ccInstallTrigger();
  return ccUiState();
}

function ccUiShare(calId, email, role) {
  email = String(email || '').trim();
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error('Неверный email');
  if (['freeBusyReader', 'reader', 'writer'].indexOf(role) === -1) throw new Error('Неверная роль');
  ccShareWithUser(calId, email, role);
  return ccUiState();
}

function ccUiUnshare(calId, ruleId) {
  ccRemoveAcl(calId, ruleId);
  return ccUiState();
}

function ccUiSetPublic(calId, role) {
  if (['none', 'freeBusyReader', 'reader'].indexOf(role) === -1) throw new Error('Неверная роль');
  ccSetPublicAccess(calId, role);
  return ccUiState();
}
