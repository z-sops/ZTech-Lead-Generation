'use strict';

// F26.6 - Native Mailbox Transport: migration 010, the mailbox repositories (SqlJs + Memory twins),
// the per-mailbox send-time query and the pure pacing rules. No network anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { MIGRATIONS } = require(path.join(LI, 'persistence', 'migrations'));
const M = require(path.join(LI, 'mailbox', 'mailboxContract'));
const { evaluatePacing, nextWindowOpen, localParts, pacingMessage } = require(path.join(LI, 'mailbox', 'pacing'));

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';
const SILENT = { warn() {}, info() {}, error() {} };
const SQL10 = fs.readFileSync(path.join(LI, 'migrations', '010_mailbox_transport.sql'), 'utf8');

async function sqlStore(upTo = Infinity) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, logger: SILENT });
  if (upTo === Infinity) await store.migrate();
  return { store, db, SQL };
}
const mbx = (o = {}) => ({
  mailbox_id: 'mbx_aaaaaaaaaaaa', provider: 'gmail', email_address: 'Dana@Ridgeline.Example', display_name: null,
  status: 'needs_check', status_code: 'MAILBOX_PROVIDER_STEP1_PENDING', paused_until: null, ...M.MAILBOX_DEFAULTS,
  time_zone: 'Asia/Karachi', is_default: 0, sync_cursor: null, connected_at: '2026-10-07T05:00:00.000Z', updated_at: '2026-10-07T05:00:00.000Z', ...o,
});
const send = (o = {}) => ({
  send_id: 'snd_' + Math.random().toString(16).slice(2), lead_id: 'L1', pitch_id: 'p1', channel: 'email', content_hash: 'h'.repeat(64),
  idempotency_key: 'k_' + Math.random().toString(16).slice(2), state: 'attempted', provider_id: 'gmail', provider_message_id: null,
  created_at: '2026-10-07T05:00:00.000Z', updated_at: '2026-10-07T05:00:00.000Z', ...o,
});
const checkOf = (sql, table, col) => {
  const body = sql.slice(sql.indexOf(table));
  const m = body.match(new RegExp(`\\b${col}\\s+\\w+[^,]*CHECK \\(${col} IN \\(([^)]*)\\)`));
  assert.ok(m, table + '.' + col);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
};

/* ================================ migration 010 ================================ */

test('M1. 010 is the tenth migration; its CHECK lists equal the mailbox contract (one vocabulary)', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(checkOf(SQL10, 'CREATE TABLE IF NOT EXISTS li_mailboxes', 'provider'), [...M.MAILBOX_PROVIDERS]);
  assert.deepEqual(checkOf(SQL10, 'CREATE TABLE IF NOT EXISTS li_mailboxes', 'status'), [...M.MAILBOX_STATUSES]);
  assert.deepEqual(checkOf(SQL10, 'CREATE TABLE IF NOT EXISTS li_market_rules', 'rule'), [...M.MARKET_RULES]);
  assert.ok(/daily_cap\s+INTEGER NOT NULL CHECK \(daily_cap BETWEEN 1 AND 200\)/.test(SQL10));
  assert.ok(/hourly_cap\s+INTEGER NOT NULL CHECK \(hourly_cap BETWEEN 1 AND 30\)/.test(SQL10));
  assert.ok(/min_gap_seconds INTEGER NOT NULL CHECK \(min_gap_seconds >= 60\)/.test(SQL10));
  assert.equal(M.MAILBOX_LIMITS.DAILY_MAX, 200);
  assert.equal(M.MAILBOX_LIMITS.HOURLY_MAX, 30);
  assert.equal(M.MAILBOX_LIMITS.MIN_GAP_MIN, 60);
});

test('M2. no table in 010 can hold a token, an auth code, a PKCE verifier or a client secret', () => {
  const ddl = SQL10.replace(/--.*$/gm, '');
  assert.ok(!/token|secret|verifier|auth_code|password|credential/i.test(ddl), 'no secret-shaped column');
  assert.ok(!/sync_cursor\s+TEXT NOT NULL/.test(ddl));
});

test('M3. 010 on a populated v9 database: legacy sends keep mailbox_id NULL, trust events and suppressions are copied verbatim', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 9)) {
    db.exec(m.sql);
    db.run('INSERT INTO li_schema_migrations VALUES (?, ?)', [m.version, '2026-10-01T00:00:00.000Z']);
  }
  db.run("INSERT INTO li_outreach_sends (send_id, lead_id, pitch_id, channel, content_hash, idempotency_key, state, provider_id, provider_message_id, failure_code, failure_message, created_at, updated_at) VALUES ('s_old','L1','p1','email','h','k1','accepted','resend','re_1',NULL,NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z')");
  db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('tev_1','evt_1','unsubscribe','email',NULL,'a@b.example','relay','applied',NULL,'2026-10-01T00:00:00.000Z','2026-10-01T00:00:01.000Z')");
  db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('tev_2','evt_1','unsubscribe','email',NULL,NULL,'relay','rejected','BAD_SIGNATURE','2026-10-01T00:00:00.000Z','2026-10-01T00:00:02.000Z')");
  db.run("INSERT INTO li_suppressions (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at) VALUES ('sup_1','global',NULL,'email','a@b.example','unsubscribe','relay','2026-10-01T00:00:00.000Z')");
  const before = {
    ev: db.exec('SELECT * FROM li_trust_events ORDER BY row_id')[0].values,
    sup: db.exec('SELECT * FROM li_suppressions ORDER BY suppression_id')[0].values,
  };
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  await store.migrate();
  assert.deepEqual(db.exec('SELECT version FROM li_schema_migrations')[0].values.flat(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(db.exec('SELECT * FROM li_trust_events ORDER BY row_id')[0].values, before.ev, 'trust events byte for byte');
  assert.deepEqual(db.exec('SELECT * FROM li_suppressions ORDER BY suppression_id')[0].values, before.sup, 'suppressions byte for byte');
  const old = await store.sends.get('s_old');
  assert.equal(old.mailbox_id, null, 'a legacy / transactional-provider send keeps NULL');
  assert.equal(old.provider_id, 'resend');
  // The rebuilt indexes still hold: one accepted event per event_id, one suppression per address.
  assert.throws(() => db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('tev_3','evt_1','reply','email',NULL,'a@b.example','mailbox','stored',NULL,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')"), /UNIQUE/);
  db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('tev_4','evt_9','reply','email',NULL,'a@b.example','mailbox','stored',NULL,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')");
  assert.throws(() => db.run("INSERT INTO li_suppressions (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at) VALUES ('sup_2','global',NULL,'email','a@b.example','unsubscribe','mailbox','2026-10-02T00:00:00.000Z')"), /UNIQUE/);
  db.run("INSERT INTO li_suppressions (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at) VALUES ('sup_3','global',NULL,'email','c@d.example','unsubscribe','mailbox','2026-10-02T00:00:00.000Z')");
  assert.throws(() => db.run("INSERT INTO li_trust_events (row_id, event_id, kind, channel, recipient_ref, normalized_address, source, state, reject_code, received_at, recorded_at) VALUES ('tev_5','evt_10','reply','email',NULL,'a@b.example','bogus','stored',NULL,'2026-10-02T00:00:00.000Z','2026-10-02T00:00:00.000Z')"), /CHECK/);
});

/* ================================ repositories ================================ */

for (const kind of ['sql', 'memory']) {
  const make = async () => (kind === 'sql' ? (await sqlStore()).store : new MemoryStore());
  const opt = { skip: kind === 'sql' ? skip : false };

  test(`R1 ${kind}. the first mailbox is the default; a reconnect refreshes identity and keeps limits; remove promotes a new default`, opt, async () => {
    const store = await make();
    const a = await store.mailboxes.upsert(mbx());
    assert.equal(a.is_default, 1);
    assert.equal(a.email_address, 'dana@ridgeline.example', 'addresses are stored lower-case');
    await store.mailboxes.setLimits(a.mailbox_id, { daily_cap: 12 }, '2026-10-07T06:00:00.000Z');
    const again = await store.mailboxes.upsert(mbx({ mailbox_id: 'mbx_bbbbbbbbbbbb', email_address: 'dana@ridgeline.example', status: 'needs_check' }));
    assert.equal(again.mailbox_id, a.mailbox_id, 'the same provider + address is the same mailbox');
    assert.equal(again.daily_cap, 12, 'a reconnect never resets the user\'s limits');
    const b = await store.mailboxes.upsert(mbx({ mailbox_id: 'mbx_cccccccccccc', email_address: 'ops@ridgeline.example', connected_at: '2026-10-07T07:00:00.000Z' }));
    assert.equal(b.is_default, 0);
    await store.mailboxes.setDefault(b.mailbox_id, '2026-10-07T08:00:00.000Z');
    assert.equal((await store.mailboxes.getDefault()).mailbox_id, b.mailbox_id);
    assert.equal(await store.mailboxes.remove(b.mailbox_id), true);
    assert.equal((await store.mailboxes.getDefault()).mailbox_id, a.mailbox_id, 'the remaining mailbox became the default');
    assert.equal((await store.mailboxes.list()).length, 1);
  });

  test(`R2 ${kind}. limits are validated: caps, minimum gap, HH:MM window, weekdays, hourly <= daily`, opt, async () => {
    const store = await make();
    const a = await store.mailboxes.upsert(mbx());
    const at = '2026-10-07T06:00:00.000Z';
    for (const bad of [{ daily_cap: 201 }, { daily_cap: 0 }, { hourly_cap: 31 }, { min_gap_seconds: 59 }, { window_start: '9:00' }, { window_start: '18:00' }, { window_days: '7' }, { window_days: '1,1' }, { daily_cap: 5, hourly_cap: 6 }]) {
      await assert.rejects(store.mailboxes.setLimits(a.mailbox_id, bad, at), /Invalid mailbox record/, JSON.stringify(bad));
    }
    const ok = await store.mailboxes.setLimits(a.mailbox_id, { daily_cap: 200, hourly_cap: 30, min_gap_seconds: 60, window_days: '5,1,3' }, at);
    assert.equal(ok.window_days, '1,3,5');
    await assert.rejects(store.mailboxes.setLimits(a.mailbox_id, { time_zone: 'Mars/Olympus' }, at), /Invalid mailbox record/);
  });

  test(`R3 ${kind}. sends carry an optional mailbox_id; mailboxSendTimes is keyed by mailbox and ignores blocked rows`, opt, async () => {
    const store = await make();
    await store.sends.record(send({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaaaaaa', created_at: '2026-10-07T05:00:00.000Z' }));
    await store.sends.record(send({ send_id: 's2', mailbox_id: 'mbx_aaaaaaaaaaaa', created_at: '2026-10-07T05:10:00.000Z' }));
    await store.sends.block({ sendId: 's2', failureCode: 'X', failureMessage: 'x', at: '2026-10-07T05:10:00.000Z' });
    await store.sends.record(send({ send_id: 's3', mailbox_id: 'mbx_bbbbbbbbbbbb', created_at: '2026-10-07T05:20:00.000Z' }));
    await store.sends.record(send({ send_id: 's4', created_at: '2026-10-07T05:30:00.000Z' }));
    assert.equal((await store.sends.get('s4')).mailbox_id, null, 'no mailbox = NULL, exactly as before');
    assert.deepEqual(await store.sends.mailboxSendTimes('mbx_aaaaaaaaaaaa', '2026-10-06T00:00:00.000Z'), ['2026-10-07T05:00:00.000Z']);
    assert.deepEqual(await store.sends.mailboxSendTimes('mbx_bbbbbbbbbbbb', '2026-10-07T05:25:00.000Z'), []);
    await assert.rejects(store.sends.record(send({ mailbox_id: 'not-a-mailbox' })), /mailbox_id/);
  });

  test(`R4 ${kind}. provider-stored sent ids: one row per send, matched only by stored id within the mailbox`, opt, async () => {
    const store = await make();
    await store.mailboxSent.record({ send_id: 's1', mailbox_id: 'mbx_aaaaaaaaaaaa', provider_message_id: '18c', stored_message_id: '<CAstored@mail.gmail.com>', thread_id: 't1', recorded_at: '2026-10-07T05:00:01.000Z' });
    const hit = await store.mailboxSent.findByStoredIds('mbx_aaaaaaaaaaaa', ['<nope@x>', '<CAstored@mail.gmail.com>']);
    assert.equal(hit.send_id, 's1');
    assert.equal(await store.mailboxSent.findByStoredIds('mbx_bbbbbbbbbbbb', ['<CAstored@mail.gmail.com>']), null, 'another mailbox never matches');
    assert.equal(await store.mailboxSent.findByStoredIds('mbx_aaaaaaaaaaaa', []), null);
    await assert.rejects(store.mailboxSent.record({ send_id: 's2', mailbox_id: 'mbx_aaaaaaaaaaaa', stored_message_id: '<CAstored@mail.gmail.com>', recorded_at: '2026-10-07T05:00:02.000Z' }), /UNIQUE/, 'one stored id belongs to one send');
  });

  test(`R5 ${kind}. market rules need a country code, a known rule, a review note, a reviewer and a date`, opt, async () => {
    const store = await make();
    const ok = { country_code: 'us', rule: 'opt_out_allowed', note: 'Reviewed CAN-SPAM with counsel', reviewed_by: 'Zee', reviewed_at: '2026-10-07T05:00:00.000Z' };
    const saved = await store.marketRules.set(ok);
    assert.equal(saved.country_code, 'US');
    for (const bad of [{ country_code: 'USA' }, { rule: 'cold_allowed' }, { note: 'ok' }, { reviewed_by: '' }, { reviewed_at: 'yesterday' }]) {
      await assert.rejects(store.marketRules.set({ ...ok, ...bad }), /Invalid mailbox record/, JSON.stringify(bad));
    }
    assert.equal((await store.marketRules.get('us')).rule, 'opt_out_allowed');
    await store.marketRules.remove('US');
    assert.equal(await store.marketRules.get('US'), null);
  });
}

test('R6. the sanitized record carries identity, status and pacing only - never a secret-shaped key', () => {
  const view = M.sanitizeMailbox({ ...mbx(), email_address: 'dana@ridgeline.example', is_default: 1, sync_cursor: '12345' }, { allowed: false, nextAllowedAt: '2026-10-07T06:00:00.000Z', reason: 'min_gap', counts: { day: 3, hour: 1 } });
  assert.deepEqual(Object.keys(view).sort(), ['connectedAt', 'displayName', 'emailAddress', 'isDefault', 'limits', 'mailboxId', 'pacing', 'pausedUntil', 'provider', 'providerLabel', 'status', 'statusCode']);
  assert.ok(!/token|secret|verifier|code_|cursor/i.test(JSON.stringify(Object.keys(view)) + JSON.stringify(Object.keys(view.limits)) + JSON.stringify(Object.keys(view.pacing))));
  assert.equal(view.pacing.sentToday, 3);
});

test('R7. provider capability: Gmail may connect but not send or sync yet; Microsoft claims nothing', () => {
  assert.deepEqual({ ...M.PROVIDER_CAPABILITY.gmail }, { code: 'MAILBOX_PROVIDER_STEP1_PENDING', canConnect: true, canSend: false, canSyncReplies: false, unsubscribeHeaderSupport: 'unknown' });
  assert.deepEqual({ ...M.PROVIDER_CAPABILITY.microsoft365 }, { code: 'MAILBOX_PROVIDER_UNVERIFIED', canConnect: false, canSend: false, canSyncReplies: false, unsubscribeHeaderSupport: 'unknown' });
  assert.equal(M.PROVIDER_NOTICE.microsoft365, 'Microsoft 365 — verification required before activation');
});

/* ==================================== pacing ==================================== */

// Wed 7 Oct 2026, 10:00 in Karachi (UTC+5) = 05:00Z. Window 09:00-17:00 Mon-Fri.
const K = (hhmm, day = '07') => new Date(`2026-10-${day}T${hhmm}:00+05:00`);
const box = (o = {}) => ({ ...mbx(), ...o });

test('P1. inside the window with no history: allowed', () => {
  const v = evaluatePacing({ mailbox: box(), sendTimes: [], now: K('10:00') });
  assert.equal(v.allowed, true);
  assert.deepEqual(v.counts, { day: 0, hour: 0 });
});

test('P2. the minimum gap refuses with MAILBOX_PACING and the exact next time; nothing is queued', () => {
  const v = evaluatePacing({ mailbox: box(), sendTimes: [K('09:59').toISOString()], now: K('10:00') });
  assert.equal(v.allowed, false);
  assert.equal(v.code, 'MAILBOX_PACING');
  assert.equal(v.reason, 'min_gap');
  assert.equal(v.nextAllowedAt, new Date(K('09:59').getTime() + 180000).toISOString());
  assert.match(pacingMessage(v), /Nothing was queued/);
});

test('P3. the hourly cap is a rolling 60 minutes; the daily cap a rolling 24 hours', () => {
  const hourly = Array.from({ length: 8 }, (_, i) => new Date(K('09:00').getTime() + i * 4 * 60000).toISOString());
  const h = evaluatePacing({ mailbox: box(), sendTimes: hourly, now: K('09:40') });
  assert.equal(h.reason, 'hourly_cap');
  assert.equal(h.nextAllowedAt, new Date(K('09:00').getTime() + 3600000).toISOString(), 'when the oldest of the eight leaves the hour');
  const daily = Array.from({ length: 30 }, (_, i) => new Date(K('09:00', '06').getTime() + i * 15 * 60000).toISOString());
  const d = evaluatePacing({ mailbox: box(), sendTimes: daily, now: K('16:30', '06') });
  assert.equal(d.reason, 'daily_cap');
  assert.equal(d.counts.day, 30);
  // The oldest leaves the window 24h after it was sent (Thu 09:00 Karachi) - inside the window.
  assert.equal(d.nextAllowedAt, new Date(K('09:00', '06').getTime() + 86400000).toISOString());
});

test('P4. the sending window is judged in the mailbox time zone: evening, weekend and early morning roll to the next opening', () => {
  const evening = evaluatePacing({ mailbox: box(), sendTimes: [], now: K('17:00') });
  assert.equal(evening.reason, 'outside_window');
  assert.equal(evening.nextAllowedAt, K('09:00', '08').toISOString(), 'Thursday 09:00 Karachi');
  const friday = evaluatePacing({ mailbox: box(), sendTimes: [], now: K('18:30', '09') });
  assert.equal(friday.nextAllowedAt, K('09:00', '12').toISOString(), 'Friday evening -> Monday 09:00');
  const early = evaluatePacing({ mailbox: box(), sendTimes: [], now: K('07:15') });
  assert.equal(early.nextAllowedAt, K('09:00').toISOString());
  // The same instant in a New York mailbox (UTC-4 in October) is 01:00 - outside its window.
  const ny = evaluatePacing({ mailbox: box({ time_zone: 'America/New_York' }), sendTimes: [], now: K('10:00') });
  assert.equal(ny.allowed, false);
  assert.equal(ny.nextAllowedAt, '2026-10-07T13:00:00.000Z');
  assert.deepEqual(localParts(Date.parse('2026-10-07T13:00:00.000Z'), 'America/New_York'), { day: 3, minute: 540 });
});

test('P5. a gap that ends after the window closes rolls to the next opening, not to the gap end', () => {
  const v = evaluatePacing({ mailbox: box({ min_gap_seconds: 3600 }), sendTimes: [K('16:30').toISOString()], now: K('16:45') });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'min_gap');
  assert.equal(v.nextAllowedAt, K('09:00', '08').toISOString());
});

test('P6. DST: a window in a zone that changes its clocks still opens at local 09:00', () => {
  // London leaves BST on Sun 25 Oct 2026. Mon 26 Oct 09:00 London = 09:00Z.
  const t = nextWindowOpen(Date.parse('2026-10-24T12:00:00.000Z'), { ...box(), time_zone: 'Europe/London' });
  assert.equal(new Date(t).toISOString(), '2026-10-26T09:00:00.000Z');
});

test('P7. unparseable times are ignored; a send dated after now (clock moved back) counts AS now', () => {
  assert.equal(evaluatePacing({ mailbox: box(), sendTimes: ['garbage'], now: K('10:00') }).allowed, true);
  const v = evaluatePacing({ mailbox: box(), sendTimes: [K('11:00').toISOString()], now: K('10:00') });
  assert.equal(v.allowed, false, 'a clock change never reopens a cap or the gap');
  assert.equal(v.reason, 'min_gap');
  assert.equal(v.counts.hour, 1);
});

test('P6b. DST spring-forward night: the next opening is the exact local 09:00, not an hour late', () => {
  // New York springs forward on Sun 8 Mar 2026. From Sat 7 Mar 18:00 EST, Mon 9 Mar 09:00 EDT = 13:00Z.
  const t = nextWindowOpen(Date.parse('2026-03-07T23:00:00.000Z'), { ...box(), time_zone: 'America/New_York' });
  assert.equal(new Date(t).toISOString(), '2026-03-09T13:00:00.000Z');
  const sun = nextWindowOpen(Date.parse('2026-03-07T23:00:00.000Z'), { ...box(), time_zone: 'America/New_York', window_days: '0,1,2,3,4,5,6' });
  assert.equal(new Date(sun).toISOString(), '2026-03-08T13:00:00.000Z', 'the spring-forward Sunday itself opens at 09:00 EDT');
});

test('P9. country normalisation: aliases first, ISO codes only - "UK" is GB, "EN" is unknown; a rule must use an ISO code', async () => {
  assert.equal(M.normalizeCountry('UK'), 'GB');
  assert.equal(M.normalizeCountry('uk'), 'GB');
  assert.equal(M.normalizeCountry('United States'), 'US');
  assert.equal(M.normalizeCountry('pk'), 'PK');
  assert.equal(M.normalizeCountry('EN'), null);
  assert.equal(M.normalizeCountry('Atlantis'), null);
  const store = new MemoryStore();
  await assert.rejects(store.marketRules.set({ country_code: 'UK', rule: 'opt_out_allowed', note: 'reviewed', reviewed_by: 'Zee', reviewed_at: '2026-10-07T05:00:00.000Z' }), /Invalid mailbox record/);
});

test('P8. pacing is pure: no timers, no queue, no store, no network', () => {
  const src = fs.readFileSync(path.join(LI, 'mailbox', 'pacing.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.ok(!/setTimeout|setInterval|require\(['"](?!\.)|fetch|store|queue\s*[=.(]/i.test(src), 'no side effects in pacing.js');
});
