// Runs the real server code (src/*.js) in a VM against an in-memory fake of the Calendar API.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');

class FakeCalendar {
  constructor() {
    this.cals = {}; // calId -> Map(eventId -> event)
    this.clock = 0;
    this.failNextListWith410 = false;
  }
  cal(id) { return (this.cals[id] = this.cals[id] || new Map()); }
  put(calId, ev) { this.cal(calId).set(ev.id, { ...ev, _v: ++this.clock }); }
  live(calId) { return [...this.cal(calId).values()].filter(e => e.status !== 'cancelled'); }

  get Events() {
    const self = this;
    const err = (msg) => { throw new Error('API call failed with error: ' + msg); };
    return {
      list(calId, p) {
        if (p.syncToken && self.failNextListWith410) {
          self.failNextListWith410 = false;
          err('Sync token is no longer valid, a full sync is required.');
        }
        let items = [...self.cal(calId).values()];
        if (p.privateExtendedProperty) {
          const [k, v] = p.privateExtendedProperty.split('=');
          items = items.filter(e => e.status !== 'cancelled' &&
            e.extendedProperties && e.extendedProperties.private && e.extendedProperties.private[k] === v);
        } else if (p.syncToken) {
          const since = +p.syncToken.slice(1);
          items = items.filter(e => e._v > since);
        } else {
          items = items.filter(e => e.status !== 'cancelled');
        }
        const start = p.pageToken ? +p.pageToken : 0;
        const page = items.slice(start, start + 2); // tiny pages to exercise paging
        const more = start + 2 < items.length;
        return {
          items: page.map(e => JSON.parse(JSON.stringify(e))),
          nextPageToken: more ? String(start + 2) : undefined,
          nextSyncToken: more ? undefined : 'v' + self.clock,
        };
      },
      update(body, calId, id) {
        const c = self.cal(calId);
        if (!c.has(id)) {
          const master = id.split('_')[0];
          if (id.includes('_') && c.has(master) && c.get(master).status !== 'cancelled') {
            self.put(calId, { ...body, id });
            return;
          }
          err('Not Found');
        }
        self.put(calId, { ...body, id });
      },
      insert(body, calId) {
        if (self.cal(calId).has(body.id)) err('The requested identifier already exists.');
        self.put(calId, body);
      },
      patch(body, calId, id) {
        const c = self.cal(calId);
        if (!c.has(id)) err('Not Found');
        self.put(calId, { ...c.get(id), ...body });
      },
      remove(calId, id) {
        const c = self.cal(calId);
        if (!c.has(id)) {
          const master = id.split('_')[0];
          if (id.includes('_') && c.has(master)) { self.put(calId, { id, status: 'cancelled' }); return; }
          err('Not Found');
        }
        if (c.get(id).status === 'cancelled') err('Resource has been deleted');
        self.put(calId, { ...c.get(id), status: 'cancelled' });
      },
    };
  }
}

function makeEnv() {
  const fake = new FakeCalendar();
  const props = new Map();
  const ctx = {
    console: { log() {}, error() {} },
    Calendar: { Events: fake.Events },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (props.has(k) ? props.get(k) : null),
        setProperty: (k, v) => props.set(k, v),
        deleteProperty: (k) => props.delete(k),
      }),
    },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'sha256' },
      Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, s) => [...crypto.createHash(alg).update(s).digest()].map(b => (b > 127 ? b - 256 : b)),
      sleep() {},
    },
  };
  vm.createContext(ctx);
  for (const f of fs.readdirSync(SRC).filter(f => f.endsWith('.js'))) {
    vm.runInContext(fs.readFileSync(path.join(SRC, f), 'utf8'), ctx, { filename: f });
  }
  return { fake, ctx };
}

const SRC_CAL = 'src@kse.org.ua';
const TARGET = 'merged@group.calendar.google.com';
const soon = (h) => new Date(Date.now() + h * 3600e3).toISOString();

function setup(mode = 'full') {
  const env = makeEnv();
  env.ctx.ccSaveConfig({ merged: [{ id: TARGET, name: 'All', sources: [{ calendarId: SRC_CAL, mode }] }] });
  return env;
}

test('full then incremental sync: create, update, delete, recurring exception', () => {
  const { fake, ctx } = setup();
  fake.put(SRC_CAL, { id: 'a', status: 'confirmed', summary: 'A', start: { dateTime: soon(1) }, end: { dateTime: soon(2) },
    attendees: [{ email: 'x@y.z' }] });
  fake.put(SRC_CAL, { id: 'b', status: 'confirmed', summary: 'B', start: { dateTime: soon(3) }, end: { dateTime: soon(4) } });
  fake.put(SRC_CAL, { id: 's', status: 'confirmed', summary: 'Series', start: { dateTime: soon(5) }, end: { dateTime: soon(6) },
    recurrence: ['RRULE:FREQ=WEEKLY'] });
  fake.put(SRC_CAL, { id: 'old', status: 'confirmed', summary: 'Old', start: { date: '2020-01-01' }, end: { date: '2020-01-02' } });

  ctx.ccSyncAll();
  let copies = fake.live(TARGET);
  assert.deepEqual(copies.map(e => e.summary).sort(), ['A', 'B', 'Series']);
  assert.ok(copies.every(e => !e.attendees && e.id.startsWith('cc')));

  // Incremental: rename A, cancel B, move one occurrence of the series.
  fake.put(SRC_CAL, { ...fake.cal(SRC_CAL).get('a'), summary: 'A2' });
  fake.put(SRC_CAL, { id: 'b', status: 'cancelled' });
  fake.put(SRC_CAL, { id: 's_20991231T100000Z', recurringEventId: 's', status: 'confirmed', summary: 'Series moved',
    originalStartTime: { dateTime: '2099-12-31T10:00:00Z' }, start: { dateTime: soon(30) }, end: { dateTime: soon(31) } });
  ctx.ccSyncAll();

  copies = fake.live(TARGET);
  const names = copies.map(e => e.summary).sort();
  assert.deepEqual(names, ['A2', 'Series', 'Series moved']);
  const seriesCopy = copies.find(e => e.summary === 'Series');
  const moved = copies.find(e => e.summary === 'Series moved');
  assert.equal(moved.id, seriesCopy.id + '_20991231T100000Z');
  assert.equal(moved.recurringEventId, seriesCopy.id);

  const st = ctx.ccLoadStatus_(TARGET, SRC_CAL);
  assert.equal(st.errors, 0, st.lastError);
});

test('a deleted copy is revived when the source event comes back', () => {
  const { fake, ctx } = setup('busy');
  const ev = { id: 'a', status: 'confirmed', summary: 'Secret', start: { dateTime: soon(1) }, end: { dateTime: soon(2) } };
  fake.put(SRC_CAL, ev);
  ctx.ccSyncAll();
  assert.equal(fake.live(TARGET)[0].summary, 'Busy');

  fake.put(SRC_CAL, { ...ev, transparency: 'transparent' }); // marked "free" -> removed in busy mode
  ctx.ccSyncAll();
  assert.equal(fake.live(TARGET).length, 0);

  fake.put(SRC_CAL, { ...ev, transparency: 'opaque' });
  ctx.ccSyncAll();
  assert.equal(fake.live(TARGET).length, 1);
});

test('expired sync token triggers a full re-read', () => {
  const { fake, ctx } = setup();
  fake.put(SRC_CAL, { id: 'a', status: 'confirmed', summary: 'A', start: { dateTime: soon(1) }, end: { dateTime: soon(2) } });
  ctx.ccSyncAll();
  fake.put(SRC_CAL, { id: 'c', status: 'confirmed', summary: 'C', start: { dateTime: soon(1) }, end: { dateTime: soon(2) } });
  fake.failNextListWith410 = true;
  ctx.ccSyncAll();
  assert.deepEqual(fake.live(TARGET).map(e => e.summary).sort(), ['A', 'C']);
  assert.equal(ctx.ccLoadStatus_(TARGET, SRC_CAL).errors, 0);
});

test('purging a source removes only its copies', () => {
  const { fake, ctx } = setup();
  fake.put(SRC_CAL, { id: 'a', status: 'confirmed', summary: 'A', start: { dateTime: soon(1) }, end: { dateTime: soon(2) } });
  ctx.ccSyncAll();
  fake.put(TARGET, { id: 'manual', status: 'confirmed', summary: 'Manual' });
  ctx.ccPurgeSource_(TARGET, SRC_CAL);
  assert.deepEqual(fake.live(TARGET).map(e => e.id), ['manual']);
});

test('KSE account: own events go to United, other accounts come back as Busy, no loops', () => {
  const env = makeEnv();
  const { fake, ctx } = env;
  const KSE = 'me@kse.org.ua';
  const UNITED = 'united@group.calendar.google.com';
  // United already holds a copy made by the personal script from another account.
  fake.put(UNITED, { id: 'ccfromgrants', status: 'confirmed', summary: 'Grant call',
    start: { dateTime: soon(1) }, end: { dateTime: soon(2) },
    extendedProperties: { private: { ccSrcCal: 'grants@gmail.com', ccSrcId: 'g1' } } });
  fake.put(KSE, { id: 'k1', status: 'confirmed', summary: 'Lecture', start: { dateTime: soon(3) }, end: { dateTime: soon(4) } });
  ctx.ccSaveConfig({ merged: [
    { id: UNITED, name: 'United', sources: [{ calendarId: KSE, mode: 'full' }] },
    { id: KSE, name: 'Ivan Sidun', sources: [{ calendarId: UNITED, mode: 'busy', cascade: true }] },
  ] });

  for (let i = 0; i < 3; i++) ctx.ccSyncAll(); // several rounds: nothing may multiply

  const kse = fake.live(KSE).map(e => e.summary).sort();
  const united = fake.live(UNITED).map(e => e.summary).sort();
  assert.deepEqual(kse, ['Busy', 'Lecture']);         // the grant call as Busy, KSE lecture untouched
  assert.deepEqual(united, ['Grant call', 'Lecture']); // the lecture copied once, no Busy coming back
});
