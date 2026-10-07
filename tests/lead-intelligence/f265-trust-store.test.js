'use strict';

// F26.5 - Compliance & Trust Foundation, work-order step 1 (lock-list item 11 and the store
// semantics every later step relies on). Runs the REAL SqlJsStore (sql.js, migrations 001-009)
// and the MemoryStore twin through the same assertions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { MIGRATIONS } = require(path.join(LI, 'persistence', 'migrations'));
const { TRUST_TABLE_COLUMNS } = require(path.join(LI, 'persistence', 'trustRepos'));
const C = require(path.join(LI, 'trust', 'trustContract'));

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';
const SILENT = { warn() {}, info() {}, error() {} };
const T = (n) => new Date(Date.UTC(2026, 9, 7, 12, 0, n)).toISOString();
const SQL_DIR = path.join(LI, 'migrations');
const TRUST_TABLES = ['li_contact_consents', 'li_contact_provenance', 'li_recipient_refs', 'li_suppressions', 'li_trust_events'];

async function sqlStore() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  return { store, db, SQL };
}
const tables = (db) => db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
const schemaOf = (db) => Object.fromEntries(db.exec("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")[0].values);

const sup = (o = {}) => ({ suppression_id: 'sup_' + Math.random().toString(16).slice(2), scope: 'global', workspace_id: null, channel: 'email', normalized_address: 'Owner@Acme.Example', reason: 'unsubscribe', source: 'user', created_at: T(1), ...o });
const consent = (o = {}) => ({ consent_id: 'con_' + Math.random().toString(16).slice(2), lead_id: 'L1', channel: 'whatsapp', normalized_address: '+92 300 1234567', method: 'in_person', evidence_note: 'Met at the expo; asked us to WhatsApp the audit.', recorded_by: 'Zee', consented_at: T(2), recorded_at: T(3), source: 'user', event_id: null, ...o });
const ev = (o = {}) => ({ row_id: 'tev_' + Math.random().toString(16).slice(2), event_id: 'evt_1', kind: 'unsubscribe', channel: 'email', recipient_ref: null, normalized_address: 'owner@acme.example', source: 'user', state: 'applied', reject_code: null, received_at: T(4), recorded_at: T(5), ...o });
const REF = 'rref_' + 'a'.repeat(32);

/* ------------------------------ 11. migrations 008 / 009 ------------------------------ */

test('11a. 008 creates exactly the five trust tables, with exactly the declared columns', { skip }, async () => {
  const sql8 = fs.readFileSync(path.join(SQL_DIR, '008_trust_foundation.sql'), 'utf8').replace(/--.*$/gm, '');
  assert.deepEqual([...sql8.matchAll(/CREATE TABLE[^(]*\b(li_\w+)/g)].map((m) => m[1]).sort(), TRUST_TABLES);
  const { db } = await sqlStore();
  for (const t of TRUST_TABLES) {
    const cols = db.exec(`PRAGMA table_info(${t})`)[0].values.map((r) => r[1]);
    assert.deepEqual(cols, TRUST_TABLE_COLUMNS[t], t);
  }
});

test('11b. 008 references no existing table and stores no content, research or secret column', () => {
  const sql8 = fs.readFileSync(path.join(SQL_DIR, '008_trust_foundation.sql'), 'utf8').replace(/--.*$/gm, '');
  const named = new Set([...sql8.matchAll(/\b(li_[a-z_]+)\b/g)].map((m) => m[1]));
  for (const n of named) assert.ok(TRUST_TABLES.includes(n) || /^li_(suppressions|consents|trust_events|recipient_refs)_/.test(n), 'unexpected reference: ' + n);
  assert.equal(/\b(ALTER|DROP|INSERT|UPDATE|DELETE)\b/i.test(sql8), false, '008 only creates');
  for (const banned of ['body', 'subject', 'pitch', 'packet', 'research', 'report', 'token', 'secret', 'credential', 'api_key', 'password', 'hash']) {
    assert.equal(new RegExp('\\b\\w*' + banned + '\\w*\\s+(TEXT|INTEGER)', 'i').test(sql8), false, 'no ' + banned + ' column');
  }
});

test('11c. 008 on top of a version-7 install changes no existing table definition; 009 changes only the activity CHECK', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 7)) {
    db.exec(m.sql);
    db.run('INSERT INTO li_schema_migrations VALUES (?, ?)', [m.version, T(0)]);
  }
  const before = schemaOf(db);
  db.exec(MIGRATIONS.find((m) => m.version === 8).sql);
  const after8 = schemaOf(db);
  for (const [name, def] of Object.entries(before)) assert.equal(after8[name], def, '008 left ' + name + ' unchanged');
  assert.deepEqual(tables(db).filter((t) => !Object.keys(before).includes(t)).sort(), TRUST_TABLES);
  db.exec(MIGRATIONS.find((m) => m.version === 9).sql);
  const after9 = schemaOf(db);
  for (const [name, def] of Object.entries(after8)) {
    if (name === 'li_outreach_activity') continue;
    assert.equal(after9[name], def, '009 left ' + name + ' unchanged');
  }
  assert.ok(after9.li_outreach_activity.includes("'OUTREACH_HANDOFF_CREATED'"));
  assert.equal(after9.li_outreach_activity.replace(",'OUTREACH_HANDOFF_CREATED'", '').replace('li_outreach_activity_f265', 'X'),
    after8.li_outreach_activity.replace('li_outreach_activity_f19', 'X'), 'only the one CHECK value was added');
});

test('11d. 009 copies every existing activity row byte for byte, and the new type is accepted', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('CREATE TABLE li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 8)) {
    db.exec(m.sql);
    db.run('INSERT INTO li_schema_migrations VALUES (?, ?)', [m.version, T(0)]);
  }
  const ins = 'INSERT INTO li_outreach_activity (activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)';
  db.run(ins, ['a1', 'L1', 'p1', 'PITCH_APPROVED', '{"approvedBy":"Zee — ✓"}', T(1)]);
  db.run(ins, ['a2', 'L1', null, 'OUTREACH_SEND_BLOCKED', null, T(2)]);
  assert.throws(() => db.run(ins, ['a3', 'L1', 'p1', 'OUTREACH_HANDOFF_CREATED', '{}', T(3)]), /CHECK/);
  const rowsBefore = db.exec('SELECT * FROM li_outreach_activity ORDER BY activity_id')[0].values;
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  assert.deepEqual(db.exec('SELECT * FROM li_outreach_activity ORDER BY activity_id')[0].values, rowsBefore);
  db.run(ins, ['a3', 'L1', 'p1', 'OUTREACH_HANDOFF_CREATED', '{"handoffKind":"mailto"}', T(3)]);
  assert.equal(db.exec("SELECT COUNT(*) FROM li_outreach_activity WHERE activity_type = 'OUTREACH_HANDOFF_CREATED'")[0].values[0][0], 1);
  await store.migrate();
  // F26.6 declared lock update: the migration list now ends at 010.
  assert.deepEqual(db.exec('SELECT version FROM li_schema_migrations')[0].values.flat(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]); // F28 declared lock update: + 012 sequences; F29: + 013 reply routes
});

test('11e. every CHECK list in 008 equals the trust contract list (one vocabulary)', () => {
  const sql8 = fs.readFileSync(path.join(SQL_DIR, '008_trust_foundation.sql'), 'utf8');
  const checkOf = (table, col) => {
    const body = sql8.slice(sql8.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
    const m = body.match(new RegExp(`\\b${col}\\s+\\w+[^,]*CHECK \\(${col} IN \\(([^)]*)\\)`));
    assert.ok(m, table + '.' + col);
    return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
  };
  assert.deepEqual(checkOf('li_suppressions', 'scope'), [...C.SUPPRESSION_SCOPES]);
  assert.deepEqual(checkOf('li_suppressions', 'reason'), [...C.SUPPRESSION_REASONS]);
  // F26.6 declared lock update: 010 also rebuilds li_suppressions to admit 'mailbox'.
  assert.deepEqual(checkOf('li_suppressions', 'source'), C.SUPPRESSION_SOURCES.filter((x) => x !== 'mailbox'));
  assert.deepEqual(checkOf('li_contact_consents', 'method'), [...C.CONSENT_METHODS]);
  assert.deepEqual(checkOf('li_contact_consents', 'source'), [...C.CONSENT_SOURCES]);
  assert.deepEqual(checkOf('li_contact_provenance', 'field'), [...C.PROVENANCE_FIELDS]);
  assert.deepEqual(checkOf('li_contact_provenance', 'source_kind'), [...C.PROVENANCE_SOURCE_KINDS]);
  assert.deepEqual(checkOf('li_trust_events', 'kind'), [...C.TRUST_EVENT_KINDS]);
  // F26.6 declared lock update: 010 rebuilds li_trust_events to admit 'mailbox'; 008's list is the
  // contract list minus that one addition, and 010's list equals the contract list exactly.
  assert.deepEqual(checkOf('li_trust_events', 'source'), C.TRUST_EVENT_SOURCES.filter((s) => s !== 'mailbox'));
  const sql10 = fs.readFileSync(path.join(SQL_DIR, '010_mailbox_transport.sql'), 'utf8');
  const m10 = sql10.match(/source\s+TEXT NOT NULL CHECK \(source IN \(([^)]*)\)\)/);
  assert.ok(m10, '010 li_trust_events.source CHECK');
  assert.deepEqual(m10[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...C.TRUST_EVENT_SOURCES]);
  const s10 = sql10.slice(sql10.indexOf('CREATE TABLE li_suppressions_f266'));
  const ms10 = s10.match(/source\s+TEXT NOT NULL CHECK \(source IN \(([^)]*)\)\)/);
  assert.ok(ms10, '010 li_suppressions.source CHECK');
  assert.deepEqual(ms10[1].split(',').map((s) => s.trim().replace(/'/g, '')), [...C.SUPPRESSION_SOURCES]);
  assert.deepEqual(checkOf('li_trust_events', 'state'), [...C.TRUST_EVENT_STATES]);
  for (const t of TRUST_TABLES.filter((x) => x !== 'li_contact_provenance')) assert.deepEqual(checkOf(t, 'channel'), [...C.TRUST_CHANNELS], t);
});

test('11f. the database itself refuses a global row with a workspace id, and a workspace row without one', { skip }, async () => {
  const { db } = await sqlStore();
  const ins = 'INSERT INTO li_suppressions (suppression_id, scope, workspace_id, channel, normalized_address, reason, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)';
  assert.throws(() => db.run(ins, ['s1', 'global', 'local', 'email', 'a@b.co', 'manual', 'user', T(1)]), /CHECK/);
  assert.throws(() => db.run(ins, ['s2', 'workspace', null, 'email', 'a@b.co', 'manual', 'user', T(1)]), /CHECK/);
});

/* ------------------------------ twin store semantics ------------------------------ */

const KINDS = [['sql', sqlStore], ['memory', async () => ({ store: new MemoryStore() })]];

for (const [kind, make] of KINDS) {
  const opts = { skip: kind === 'sql' ? skip : false };

  test(`${kind}: normalization - email case/space and phone formatting match one suppression`, opts, async () => {
    const { store } = await make();
    const a = await store.suppressions.add(sup({ normalized_address: '  Owner@ACME.example ' }));
    assert.equal(a.created, true);
    assert.equal(a.row.normalized_address, 'owner@acme.example');
    assert.ok(await store.suppressions.find({ channel: 'email', address: 'OWNER@acme.EXAMPLE' }));
    assert.equal(await store.suppressions.find({ channel: 'whatsapp', address: 'owner@acme.example' }), null, 'channel is part of the key');
    await store.suppressions.add(sup({ channel: 'whatsapp', normalized_address: '+92 (300) 123-4567' }));
    assert.ok(await store.suppressions.find({ channel: 'whatsapp', address: '+923001234567' }));
    assert.ok(await store.suppressions.find({ channel: 'whatsapp', address: '+92 300 1234567' }));
    assert.equal(await store.suppressions.find({ channel: 'email', address: 'not an address' }), null);
  });

  test(`${kind}: suppression is idempotent per (scope, workspace, channel, address)`, opts, async () => {
    const { store } = await make();
    const first = await store.suppressions.add(sup());
    const again = await store.suppressions.add(sup({ reason: 'bounce', created_at: T(9) }));
    assert.equal(again.created, false);
    assert.equal(again.row.suppression_id, first.row.suppression_id, 'the first fact is kept');
    const ws = await store.suppressions.add(sup({ scope: 'workspace', workspace_id: 'local' }));
    assert.equal(ws.created, true, 'a workspace row is a different scope');
    assert.equal((await store.suppressions.listForAddress({ channel: 'email', address: 'owner@acme.example' })).length, 2);
  });

  test(`${kind}: global blocks every workspace; a workspace row blocks only its own workspace`, opts, async () => {
    const { store } = await make();
    await store.suppressions.add(sup({ scope: 'workspace', workspace_id: 'local', normalized_address: 'w@x.co' }));
    assert.ok(await store.suppressions.find({ channel: 'email', address: 'w@x.co' }), 'default workspace is local');
    assert.equal(await store.suppressions.find({ channel: 'email', address: 'w@x.co', workspaceId: 'other' }), null);
    await store.suppressions.add(sup({ normalized_address: 'w@x.co', created_at: T(7) }));
    const hit = await store.suppressions.find({ channel: 'email', address: 'w@x.co', workspaceId: 'other' });
    assert.equal(hit.scope, 'global');
    assert.equal((await store.suppressions.find({ channel: 'email', address: 'w@x.co' })).scope, 'global', 'a global row wins');
  });

  test(`${kind}: only a manual user suppression can be lifted`, opts, async () => {
    const { store } = await make();
    const unsub = await store.suppressions.add(sup());
    const manual = await store.suppressions.add(sup({ normalized_address: 'm@x.co', reason: 'manual' }));
    const relay = await store.suppressions.add(sup({ normalized_address: 'r@x.co', reason: 'manual', source: 'relay' }));
    assert.equal(await store.suppressions.removeManual(unsub.row.suppression_id), false);
    assert.equal(await store.suppressions.removeManual(relay.row.suppression_id), false);
    assert.equal(await store.suppressions.removeManual(manual.row.suppression_id), true);
    assert.equal(await store.suppressions.find({ channel: 'email', address: 'm@x.co' }), null);
    assert.ok(await store.suppressions.find({ channel: 'email', address: 'owner@acme.example' }));
  });

  test(`${kind}: invalid suppression records are refused, never coerced`, opts, async () => {
    const { store } = await make();
    for (const bad of [{ scope: 'team' }, { scope: 'global', workspace_id: 'local' }, { scope: 'workspace', workspace_id: null },
      { channel: 'sms' }, { normalized_address: 'nope' }, { reason: 'dislike' }, { source: 'renderer' }, { created_at: 'yesterday' }]) {
      await assert.rejects(store.suppressions.add(sup(bad)), /Invalid trust record/, JSON.stringify(bad));
    }
  });

  test(`${kind}: consent records method, timestamp, evidence note and recorder; the newest wins`, opts, async () => {
    const { store } = await make();
    for (const bad of [{ evidence_note: '   ' }, { recorded_by: '' }, { method: 'they_replied' }, { method: 'reply' }, { consented_at: null }, { source: 'renderer' }]) {
      await assert.rejects(store.consents.record(consent(bad)), /Invalid trust record/, JSON.stringify(bad));
    }
    const older = await store.consents.record(consent({ consented_at: T(1) }));
    const newer = await store.consents.record(consent({ consented_at: T(6), method: 'website_form', evidence_note: 'Form #42' }));
    assert.equal(older.normalized_address, '+923001234567');
    const latest = await store.consents.latestFor({ channel: 'whatsapp', address: '+92-300-123-4567' });
    assert.equal(latest.consent_id, newer.consent_id);
    assert.equal(await store.consents.latestFor({ channel: 'email', address: '+923001234567' }), null);
    assert.equal((await store.consents.listByLead('L1')).length, 2);
  });

  test(`${kind}: provenance - a capture replaces, a backfill never overwrites, unknown carries nothing`, opts, async () => {
    const { store } = await make();
    const bf = await store.provenance.put({ lead_id: 'L1', field: 'phone', source_kind: 'unknown', backfilled: true, recorded_at: T(1) });
    assert.equal(bf.written, true);
    const cap = await store.provenance.put({ lead_id: 'L1', field: 'phone', source_kind: 'collection_run', source_ref: 'run-2026-10-07', collected_at: T(2), recorded_at: T(3) });
    assert.equal(cap.row.source_kind, 'collection_run');
    const again = await store.provenance.put({ lead_id: 'L1', field: 'phone', source_kind: 'unknown', backfilled: true, recorded_at: T(4) });
    assert.equal(again.written, false);
    assert.equal(again.row.source_kind, 'collection_run', 'the capture survives a later backfill');
    await assert.rejects(store.provenance.put({ lead_id: 'L1', field: 'email', source_kind: 'unknown', collected_at: T(1), recorded_at: T(1) }), /Invalid trust record/);
    await assert.rejects(store.provenance.put({ lead_id: 'L1', field: 'address', source_kind: 'manual', recorded_at: T(1) }), /Invalid trust record/);
    assert.deepEqual((await store.provenance.listByLead('L1')).map((r) => r.field), ['phone']);
  });

  test(`${kind}: trust events are append-only and idempotent; a rejected copy never shadows the genuine event`, opts, async () => {
    const { store } = await make();
    const forged = await store.trustEvents.append(ev({ state: 'rejected', reject_code: 'BAD_SIGNATURE', source: 'relay' }));
    assert.equal(forged.created, true);
    assert.equal(await store.trustEvents.get('evt_1'), null, 'a rejected row is not the event');
    const real = await store.trustEvents.append(ev());
    assert.equal(real.created, true);
    const dup = await store.trustEvents.append(ev({ kind: 'complaint' }));
    assert.equal(dup.created, false);
    assert.equal(dup.row.row_id, real.row.row_id);
    const lateForgery = await store.trustEvents.append(ev({ state: 'rejected', reject_code: 'BAD_SIGNATURE', source: 'relay' }));
    assert.equal(lateForgery.created, true, 'a later forged copy is still recorded as rejected');
    assert.equal(lateForgery.row.state, 'rejected');
    assert.equal((await store.trustEvents.get('evt_1')).row_id, real.row.row_id);
    assert.equal((await store.trustEvents.list()).total, 3);
    await store.trustEvents.append(ev({ event_id: 'evt_2', kind: 'reply', received_at: T(8) }));
    assert.equal((await store.trustEvents.latestFor({ channel: 'email', address: 'OWNER@acme.example', kinds: ['reply'] })).event_id, 'evt_2');
    assert.equal(await store.trustEvents.latestFor({ channel: 'email', address: 'owner@acme.example', kinds: ['bounce'] }), null);
    for (const bad of [{ event_id: 'has space' }, { kind: 'opened' }, { kind: 'whatsapp_inbound', channel: 'email' }, { recipient_ref: 'owner@acme.example' },
      { state: 'rejected' }, { reject_code: 'X' }, { source: 'renderer' }]) {
      await assert.rejects(store.trustEvents.append(ev({ event_id: 'evt_bad', ...bad })), /Invalid trust record/, JSON.stringify(bad));
    }
  });

  test(`${kind}: recipient refs - idempotent per ref, several refs per address (key rotation), resolvable only locally`, opts, async () => {
    const { store } = await make();
    const REF2 = 'rref_' + 'b'.repeat(32);
    const r1 = await store.recipientRefs.ensure({ recipient_ref: REF, channel: 'email', normalized_address: 'Owner@Acme.Example', created_at: T(1) });
    const again = await store.recipientRefs.ensure({ recipient_ref: REF, channel: 'email', normalized_address: 'other@acme.example', created_at: T(3) });
    assert.equal(again.normalized_address, r1.normalized_address, 'a ref keeps its first address');
    const r2 = await store.recipientRefs.ensure({ recipient_ref: REF2, channel: 'email', normalized_address: 'owner@acme.example', created_at: T(2) });
    assert.equal(r2.recipient_ref, REF2, 'a rotated ref for the same address is stored too');
    assert.equal((await store.recipientRefs.resolve(REF)).normalized_address, 'owner@acme.example');
    assert.equal((await store.recipientRefs.resolve(REF2)).normalized_address, 'owner@acme.example');
    assert.equal(await store.recipientRefs.resolve('rref_' + 'c'.repeat(32)), null);
    assert.equal((await store.recipientRefs.forAddress({ channel: 'email', address: 'OWNER@acme.example' })).recipient_ref, REF2, 'the newest ref is current');
    await assert.rejects(store.recipientRefs.ensure({ recipient_ref: 'owner@acme.example', channel: 'email', normalized_address: 'a@b.co', created_at: T(1) }), /Invalid trust record/);
  });

  test(`${kind}: purgeLead removes provenance and consents but KEEPS suppressions, events and refs`, opts, async () => {
    const { store } = await make();
    await store.provenance.put({ lead_id: 'L1', field: 'email', source_kind: 'manual', recorded_at: T(1) });
    await store.consents.record(consent());
    await store.suppressions.add(sup());
    await store.trustEvents.append(ev());
    await store.recipientRefs.ensure({ recipient_ref: REF, channel: 'email', normalized_address: 'owner@acme.example', created_at: T(1) });
    await store.provenance.put({ lead_id: 'L2', field: 'email', source_kind: 'manual', recorded_at: T(1) });
    await store.purgeLead('L1');
    assert.deepEqual(await store.provenance.listByLead('L1'), []);
    assert.deepEqual(await store.consents.listByLead('L1'), []);
    assert.equal((await store.provenance.listByLead('L2')).length, 1, 'other leads untouched');
    assert.ok(await store.suppressions.find({ channel: 'email', address: 'owner@acme.example' }), 'a purged address stays suppressed');
    assert.ok(await store.trustEvents.get('evt_1'));
    assert.ok(await store.recipientRefs.resolve(REF));
  });
}

test('sql: trust writes persist through the existing save hook', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  let saves = 0;
  const store = new SqlJsStore({ db, persist: () => { saves += 1; }, logger: SILENT });
  await store.migrate();
  const before = saves;
  await store.suppressions.add(sup());
  await store.consents.record(consent());
  assert.equal(saves, before + 2);
  const bytes = db.export();
  const reopened = new SqlJsStore({ db: new SQL.Database(bytes), logger: SILENT });
  await reopened.migrate();
  assert.ok(await reopened.suppressions.find({ channel: 'email', address: 'owner@acme.example' }));
});
