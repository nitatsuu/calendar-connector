const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const T = require('../src/Transform.js');

const NOW = Date.parse('2026-11-23T12:00:00Z');
const ctx = { cutoffMs: NOW - 30 * 864e5 };
const full = { calendarId: 'me@gmail.com', mode: 'full' };
const busy = { calendarId: 'me@kse.org.ua', mode: 'busy' };

const timed = {
  id: 'abc',
  status: 'confirmed',
  summary: 'Lecture',
  description: 'Room notes',
  location: 'Room 1',
  start: { dateTime: '2026-11-24T10:00:00+02:00', timeZone: 'Europe/Kyiv' },
  end: { dateTime: '2026-11-24T11:00:00+02:00', timeZone: 'Europe/Kyiv' },
  attendees: [{ email: 'a@x.com' }, { email: 'me@gmail.com', self: true, responseStatus: 'accepted' }],
  hangoutLink: 'https://meet.google.com/xyz',
};

test('full mode copies details, drops attendees and reminders, tags source', () => {
  const p = T.ccPlanEvent(timed, full, ctx);
  assert.equal(p.action, 'upsert');
  assert.equal(p.kind, 'master');
  assert.equal(p.body.summary, 'Lecture');
  assert.equal(p.body.location, 'Room 1');
  assert.equal(p.body.description, 'Room notes\n\nhttps://meet.google.com/xyz');
  assert.equal(p.body.attendees, undefined);
  assert.deepEqual(p.body.reminders, { useDefault: false });
  assert.deepEqual(p.body.extendedProperties.private, { ccSrcCal: 'me@gmail.com', ccSrcId: 'abc' });
  assert.deepEqual(p.body.start, timed.start);
});

test('prefix is prepended in full mode', () => {
  const p = T.ccPlanEvent(timed, { ...full, prefix: '[KSE]' }, ctx);
  assert.equal(p.body.summary, '[KSE] Lecture');
});

test('busy mode hides everything but time', () => {
  const p = T.ccPlanEvent(timed, busy, ctx);
  assert.equal(p.action, 'upsert');
  assert.equal(p.body.summary, 'Busy');
  assert.equal(p.body.description, undefined);
  assert.equal(p.body.location, undefined);
  assert.equal(T.ccPlanEvent(timed, { ...busy, busyLabel: 'Зайнятий' }, ctx).body.summary, 'Зайнятий');
  assert.equal(T.ccPlanEvent(timed, busy, { ...ctx, busyLabel: 'Занят' }).body.summary, 'Занят');
});

test('busy mode removes free (transparent) events, full mode keeps them as free', () => {
  const free = { ...timed, transparency: 'transparent' };
  assert.equal(T.ccPlanEvent(free, busy, ctx).action, 'delete');
  assert.equal(T.ccPlanEvent(free, full, ctx).body.transparency, 'transparent');
});

test('cancelled and declined events delete the copy', () => {
  assert.equal(T.ccPlanEvent({ id: 'abc', status: 'cancelled' }, full, ctx).action, 'delete');
  const declined = { ...timed, attendees: [{ email: 'me', self: true, responseStatus: 'declined' }] };
  assert.equal(T.ccPlanEvent(declined, full, ctx).action, 'delete');
});

test('own copies, working location and birthdays are skipped', () => {
  const copy = { ...timed, extendedProperties: { private: { ccSrcCal: 'x', ccSrcId: 'y' } } };
  assert.equal(T.ccPlanEvent(copy, full, ctx).reason, 'own-copy');
  assert.equal(T.ccPlanEvent({ ...timed, eventType: 'workingLocation' }, full, ctx).action, 'skip');
  assert.equal(T.ccPlanEvent({ ...timed, eventType: 'birthday' }, full, ctx).action, 'skip');
  assert.equal(T.ccPlanEvent({ ...timed, eventType: 'outOfOffice' }, full, ctx).action, 'upsert');
});

test('old single events are skipped, old but ongoing series are kept', () => {
  const old = { ...timed, start: { date: '2025-01-01' }, end: { date: '2025-01-02' } };
  assert.equal(T.ccPlanEvent(old, full, ctx).reason, 'too-old');
  const ongoing = { ...old, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'] };
  const p = T.ccPlanEvent(ongoing, full, ctx);
  assert.equal(p.action, 'upsert');
  assert.deepEqual(p.body.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
  const ended = { ...old, recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20250301T000000Z'] };
  assert.equal(T.ccPlanEvent(ended, full, ctx).reason, 'too-old');
});

test('exception of a recurring event maps to instance of the copied series', () => {
  const ex = {
    ...timed,
    id: 'abc_20261124T080000Z',
    recurringEventId: 'abc',
    originalStartTime: { dateTime: '2026-11-24T10:00:00+02:00', timeZone: 'Europe/Kyiv' },
  };
  const p = T.ccPlanEvent(ex, full, ctx);
  assert.equal(p.kind, 'instance');
  assert.equal(p.masterSrcId, 'abc');
  assert.equal(p.instanceSuffix, '20261124T080000Z');
  assert.equal(p.body.recurrence, undefined);
  assert.deepEqual(p.body.originalStartTime, ex.originalStartTime);

  const cancelledInstance = { id: 'abc_20261201', status: 'cancelled', recurringEventId: 'abc',
    originalStartTime: { date: '2026-12-01' } };
  const c = T.ccPlanEvent(cancelledInstance, full, ctx);
  assert.equal(c.action, 'delete');
  assert.equal(c.kind, 'instance');
  assert.equal(c.instanceSuffix, '20261201');
});

test('target ids are deterministic and valid base32hex', () => {
  const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
  const a = T.ccTargetIdFromHash(hash(T.ccIdSeed('t', 's', 'abc')));
  const b = T.ccTargetIdFromHash(hash(T.ccIdSeed('t', 's', 'abc')));
  const c = T.ccTargetIdFromHash(hash(T.ccIdSeed('t2', 's', 'abc')));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-v]{5,1024}$/);
});

test('cascade source passes on copies from other accounts only', () => {
  const copyFrom = (origin) => ({ ...timed, extendedProperties: { private: { ccSrcCal: origin, ccSrcId: 'x' } } });
  const united = { calendarId: 'united@group', mode: 'busy', cascade: true };
  const cctx = { ...ctx, localOrigins: { 'me@kse.org.ua': true, 'united@group': true } };
  assert.equal(T.ccPlanEvent(copyFrom('grants@gmail.com'), united, cctx).action, 'upsert');
  assert.equal(T.ccPlanEvent(copyFrom('me@kse.org.ua'), united, cctx).reason, 'own-copy');
  // Without the cascade flag copies are never passed on.
  assert.equal(T.ccPlanEvent(copyFrom('grants@gmail.com'), { ...united, cascade: false }, cctx).reason, 'own-copy');
  // A copy of a copy points at the cascade source, not the original account.
  const p = T.ccPlanEvent(copyFrom('grants@gmail.com'), united, cctx);
  assert.equal(p.body.extendedProperties.private.ccSrcCal, 'united@group');
});
