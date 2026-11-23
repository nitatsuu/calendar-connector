/**
 * Configuration and sync state, stored in this script's ScriptProperties.
 *
 * Config shape:
 * {
 *   merged: [{
 *     id: '<target calendar id>', name, color: '#rrggbb', busyLabel?,
 *     sources: [{ calendarId, mode: 'full'|'busy', prefix? }]
 *   }]
 * }
 */

var CC_CONFIG_KEY = 'cc.config';

function ccProps_() {
  return PropertiesService.getScriptProperties();
}

function ccLoadConfig() {
  var raw = ccProps_().getProperty(CC_CONFIG_KEY);
  var cfg = raw ? JSON.parse(raw) : {};
  cfg.merged = cfg.merged || [];
  return cfg;
}

function ccSaveConfig(cfg) {
  ccProps_().setProperty(CC_CONFIG_KEY, JSON.stringify(cfg));
}

function ccFindMerged_(cfg, id) {
  for (var i = 0; i < cfg.merged.length; i++) {
    if (cfg.merged[i].id === id) return cfg.merged[i];
  }
  return null;
}

function ccSha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); })
    .join('');
}

function ccPairKey_(prefix, targetId, srcId) {
  return prefix + ccSha256Hex_(targetId + '\n' + srcId).slice(0, 24);
}

/** Sync state of one (target, source) pair: {syncToken?, pageToken?}. */
function ccLoadState_(targetId, srcId) {
  var raw = ccProps_().getProperty(ccPairKey_('cc.state.', targetId, srcId));
  return raw ? JSON.parse(raw) : {};
}

function ccSaveState_(targetId, srcId, st) {
  ccProps_().setProperty(ccPairKey_('cc.state.', targetId, srcId), JSON.stringify(st));
}

/** Forget the sync token: the next run re-reads the whole source and rewrites the copies. */
function ccResetState_(targetId, srcId) {
  ccProps_().deleteProperty(ccPairKey_('cc.state.', targetId, srcId));
}

/** Result of the last run for one pair, shown in the UI. */
function ccLoadStatus_(targetId, srcId) {
  var raw = ccProps_().getProperty(ccPairKey_('cc.status.', targetId, srcId));
  return raw ? JSON.parse(raw) : null;
}

function ccSaveStatus_(targetId, srcId, status) {
  ccProps_().setProperty(ccPairKey_('cc.status.', targetId, srcId), JSON.stringify(status));
}
