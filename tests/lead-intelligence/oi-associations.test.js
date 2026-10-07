'use strict';

/**
 * I3 - migration 006: lead <-> Opportunity Intelligence research associations.
 *
 * Executes the real SqlJsStore, the real runtime (initializeLeadIntelligenceRuntime)
 * and the real OI service over a fake OI REST service. The headline test closes the
 * database, reopens it from its bytes and proves a researched lead still opens its
 * report - the restart case Zee hit in I2.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { MIGRATIONS } = require(path.join(LI, 'persistence', 'migrations'));
const { initializeLeadIntelligenceRuntime } = require(path.join(LI, 'lead-intelligence-runtime'));
const { OpportunityAssociationStore } = require(path.join(LI, 'opportunity', 'OpportunityAssociationStore'));
const fixtures = require('./opportunity-fixtures');

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const BASE = 'http://127.0.0.1:8099';
const RID = 'res_20261005120000_abcdef01';
const LEADS = { 5: { id: 5, phone: '+923001234567', title: 'Acme Bakery', website: 'https://acmebakery.pk' } };

function resp(status, body) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

function fakeOi({ reportStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const key = `${init.method || 'GET'} ${url}`;
    calls.push(key);
    if (key === `GET ${BASE}/v1/health`) return resp(200, { status: 'ok', schema_version: '1.0', instance_id: null });
    if (key === `POST ${BASE}/v1/research`) return resp(200, fixtures.report());
    if (key === `GET ${BASE}/v1/reports/${RID}`) {
      return reportStatus === 200 ? resp(200, fixtures.report()) : resp(reportStatus, { error: 'NOT_FOUND', message: 'unknown research_id' });
    }
    return resp(404, { error: 'NOT_FOUND' });
  };
  return { fetchImpl, calls };
}

function fakeAccountStore(db) {
  return {
    db,
    ready: Promise.resolve(),
    saveDB() {},
    queryNumbers: async (q) => ({ rows: q && LEADS[q.id] ? [LEADS[q.id]] : [], total: 0, limit: 1, offset: 0 }),
    getCollectedNumbers: async () => Object.values(LEADS),
    listTargets: async () => ({ rows: [] }),
  };
}

async function runtimeOn(db, oi) {
  return initializeLeadIntelligenceRuntime({
    accountStore: fakeAccountStore(db),
    logger: SILENT,
    opportunity: { config: { baseUrl: BASE }, fetchImpl: oi.fetchImpl },
  });
}

const tableCols = (db, t) => db.exec(`PRAGMA table_info(${t})`)[0].values.map((r) => r[1]).sort();

test('006 is the sixth migration and creates exactly the seven approved columns', { skip }, async () => {
  // I5 declared lock update: + 7 (li_oi_refresh_requests). 006 itself is unchanged.
  // F26.5 declared lock update: + 8 (five trust tables) and 9 (activity CHECK + handoff).
  // F26.6 declared lock update: + 10 (mailbox transport).
  assert.deepEqual(MIGRATIONS.map((m) => m.version), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  await new SqlJsStore({ db, logger: SILENT }).migrate();
  assert.deepEqual(tableCols(db, 'li_oi_associations'),
    ['entity_key', 'generated_at', 'lead_id', 'recorded_at', 'research_id', 'snapshot_id', 'status']);
});

test('006 applies on top of a database already at version 5, and only once', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // Build the version-5 schema exactly as a shipped F25 install has it.
  db.run('CREATE TABLE li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
    db.exec(m.sql);
    db.run('INSERT INTO li_schema_migrations VALUES (?, ?)', [m.version, '2026-10-01T00:00:00.000Z']);
  }
  const before = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  assert.equal(before.includes('li_oi_associations'), false);
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  await store.migrate();
  // I5 declared lock update: the same upgrade now also applies 007.
  // F26.5 declared lock update: the same upgrade now also applies 008 (five new trust tables) and 009.
  // F26.6 declared lock update: ... and 010 (mailbox transport).
  assert.deepEqual(db.exec('SELECT version FROM li_schema_migrations')[0].values.flat(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  const after = db.exec("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")[0].values.flat();
  assert.deepEqual(after.filter((t) => !before.includes(t)), ['li_contact_consents', 'li_contact_provenance', 'li_mailbox_sent', 'li_mailboxes', 'li_market_rules', 'li_oi_associations', 'li_oi_refresh_requests', 'li_recipient_refs', 'li_reply_reviews', 'li_suppressions', 'li_trust_events']); // F26.6 follow-up: + li_reply_reviews (011)
});

for (const kind of ['sql', 'memory']) {
  test(`${kind}: put is idempotent on research_id and keeps the newest N per lead`, { skip: kind === 'sql' ? skip : false }, async () => {
    let assoc;
    if (kind === 'sql') {
      const SQL = await initSqlJs();
      const s = new SqlJsStore({ db: new SQL.Database(), logger: SILENT });
      await s.migrate();
      assoc = s.oiAssociations;
    } else {
      assoc = new MemoryStore().oiAssociations;
    }
    const rec = (i, lead = 'L1') => ({
      research_id: `res_2026100512${String(i).padStart(4, '0')}_abcdef${String(i).padStart(2, '0')}`,
      lead_id: lead, snapshot_id: `snap_${i}`, entity_key: 'dom:acme.pk', status: 'partial',
      generated_at: '2026-10-05T12:00:00Z', recorded_at: `2026-10-05T12:00:${String(i).padStart(2, '0')}.000Z`,
    });
    await assoc.put(rec(1));
    await assoc.put({ ...rec(1), lead_id: 'L9' }); // same research id: ignored, never re-pointed
    assert.equal((await assoc.listAll()).length, 1);
    assert.equal((await assoc.listAll())[0].lead_id, 'L1');
    for (let i = 2; i <= 5; i += 1) await assoc.put(rec(i), { keep: 3 });
    await assoc.put(rec(7, 'L2'), { keep: 3 });
    const all = await assoc.listAll();
    assert.deepEqual(all.filter((r) => r.lead_id === 'L1').map((r) => r.snapshot_id), ['snap_5', 'snap_4', 'snap_3']);
    assert.equal(all.filter((r) => r.lead_id === 'L2').length, 1, 'pruning one lead never touches another');
    for (const r of all) assert.deepEqual(Object.keys(r).sort(), ['entity_key', 'generated_at', 'lead_id', 'recorded_at', 'research_id', 'snapshot_id', 'status']);
  });
}

test('restart: a researched lead still opens its report after the database is closed and reopened', { skip }, async () => {
  const SQL = await initSqlJs();
  const db1 = new SQL.Database();
  db1.run('CREATE TABLE numbers (id INTEGER PRIMARY KEY, phone TEXT, title TEXT)');
  const oi1 = fakeOi();
  const rt1 = await runtimeOn(db1, oi1);
  const ran = await rt1.opportunity.service.researchForLead({ leadId: '5', leadView: { company_name: 'Acme Bakery', domain: 'acmebakery.pk' } });
  assert.equal(ran.available, true, ran.message);
  await rt1.opportunity.service.associations.flush();
  const stored = db1.exec('SELECT lead_id, research_id, status FROM li_oi_associations')[0].values;
  assert.deepEqual(stored, [['5', RID, fixtures.report().status]]);
  // Nothing from the report body reached whatsapp.db.
  const dump = JSON.stringify(db1.exec('SELECT * FROM li_oi_associations'));
  for (const s of ['opportunities', 'sales_angles', 'evidence', 'claim', 'provider_status']) assert.equal(dump.includes(s), false, s);
  await rt1.shutdown();

  // "Restart": a brand-new database object from the saved bytes, a brand-new runtime.
  const db2 = new SQL.Database(db1.export());
  const oi2 = fakeOi();
  const rt2 = await runtimeOn(db2, oi2);
  const latest = await rt2.opportunity.service.latestForLead({ leadId: '5' });
  assert.equal(latest.available, true, latest.message);
  assert.equal(latest.model.research_id, RID);
  assert.equal(latest.model.lead_id, '5');
  assert.ok(oi2.calls.includes(`GET ${BASE}/v1/reports/${RID}`), 'the report was re-fetched from OI by id');
  assert.equal(oi2.calls.includes(`POST ${BASE}/v1/research`), false, 'reopening never re-runs research');
  await rt2.shutdown();
});

test('a link whose report OI no longer holds renders report_missing, never a crash or a fake report', { skip }, async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const rt1 = await runtimeOn(db, fakeOi());
  await rt1.opportunity.service.researchForLead({ leadId: '5', leadView: { company_name: 'Acme Bakery', domain: 'acmebakery.pk' } });
  await rt1.shutdown();
  const rt2 = await runtimeOn(new SQL.Database(db.export()), fakeOi({ reportStatus: 404 }));
  const v = await rt2.opportunity.service.latestForLead({ leadId: '5' });
  assert.equal(v.state, 'report_missing');
  assert.equal(v.model, null);
  // I5 (E2) declared copy update: the approved wording.
  assert.equal(v.message, "This lead's reports are no longer available. Run research again.");
  await rt2.shutdown();
});

test('purgeLead removes the lead\'s OI links (and only its links)', { skip }, async () => {
  const SQL = await initSqlJs();
  const s = new SqlJsStore({ db: new SQL.Database(), logger: SILENT });
  await s.migrate();
  const base = { snapshot_id: 'snap_1', entity_key: 'dom:a.pk', status: 'completed', generated_at: 'g', recorded_at: '2026-10-05T00:00:00Z' };
  await s.oiAssociations.put({ ...base, research_id: 'res_20261005000000_aaaaaaaa', lead_id: 'L1' });
  await s.oiAssociations.put({ ...base, research_id: 'res_20261005000000_bbbbbbbb', lead_id: 'L2' });
  await s.purgeLead('L1');
  assert.deepEqual((await s.oiAssociations.listAll()).map((r) => r.lead_id), ['L2']);
});

test('load skips rows without valid OI ids and survives a backing that throws', async () => {
  const good = { research_id: 'res_20261005120000_abcdef01', lead_id: 'L1', snapshot_id: 'snap_20261005120000_abcdef01', entity_key: 'dom:acme.pk', status: 'partial', generated_at: 'g', recorded_at: '2026-10-05T12:00:00Z' };
  const store = new OpportunityAssociationStore({
    backing: { listAll: async () => [good, { ...good, research_id: 'bogus' }, { ...good, research_id: 'res_20261005120000_abcdef02', snapshot_id: '../x' }], put: async () => null },
  });
  assert.equal(await store.load(), 1);
  assert.equal(store.latestForLead('L1').research_id, good.research_id);
  const broken = new OpportunityAssociationStore({ backing: { listAll: async () => { throw new Error('disk'); }, put: async () => null }, logger: SILENT });
  assert.equal(await broken.load(), 0);
  assert.equal(broken.latestForLead('L1'), null);
});

test('a failing write-through never fails the research call', async () => {
  const warnings = [];
  const store = new OpportunityAssociationStore({
    backing: { listAll: async () => [], put: async () => { throw new Error('disk full'); } },
    logger: { warn: (m) => warnings.push(m) },
  });
  const r = store.assertLeadAssociation({ leadId: 'L1', report: fixtures.report() });
  assert.equal(r.ok, true);
  await store.flush();
  assert.ok(warnings.some((w) => w.includes('could not be saved')));
  assert.equal(store.latestForLead('L1').research_id, RID, 'the in-session link still works');
});
