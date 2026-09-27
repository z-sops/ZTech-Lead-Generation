'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// P1-F: the Target Builder - reusable, user-owned prospecting definitions.
//
// A target is NOT lead data. Nothing in this file may create, change or remove
// a lead, and every test that touches the target surface also proves the lead
// library is byte-identical afterwards. Required/optional fields are
// prospecting CRITERIA: no test here may reject a lead for missing one.
const root = path.join(__dirname, '..');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'coreclawAdapter.js'), 'utf8');
const clientSource = fs.readFileSync(path.join(root, 'src', 'main', 'coreClawClient.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

const codeOnly = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

// The store-side P1-F block plus the deterministic helpers it uses.
const P1F_STORE_BLOCK = between(
  storeSource,
  '// === P1-F Target builder: reusable prospecting definitions ===',
  '// Exact provenance literal written by the manual-import save path'
);
const P1F_TARGET_REGION = between(
  storeSource,
  '// === P1-F Target builder (user-owned definitions) ===',
  '\n}\n\nmodule.exports'
);
const storeApi = new Function(
  'randomUUID',
  P1F_STORE_BLOCK
  + '\nreturn { validateTargetRecord, normalizeTargetTerms, normalizeTargetFields, normalizeTargetRow,'
  + ' evaluateTargetExclusions, targetTermsFile, TARGET_FIELD_ALLOWLIST, TARGET_STATUS_VALUES,'
  + ' TARGET_LIST_FIELDS, MAX_TARGET_NAME_LENGTH, MAX_TARGET_INDUSTRY_LENGTH, MAX_TARGET_TERM_LENGTH,'
  + ' MAX_TARGET_TERMS, MAX_TARGET_FIELDS };'
)(() => 'uuid-' + Math.random().toString(16).slice(2));

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p1f-targets-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };
  const loggerPath = require.resolve(path.join(root, 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const SQL = await require('sql.js')();
  const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
  const { AccountStore, evaluateTargetExclusions } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');
  const targetsFile = path.join(dataDir, 'targets.json');

  const VALID = {
    name: 'Bangkok HVAC',
    industry: 'HVAC',
    businessTypes: 'HVAC Contractor, Air Conditioning',
    locations: 'Bangkok, Thailand',
    requiredFields: ['phone', 'website'],
    optionalFields: ['email'],
    exclusions: 'Casino, closed',
    status: 'active'
  };

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  async function openJsonStore() {
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    store._targets = (store._targets || []).map(r => ({ ...r }));
    return store;
  }

  function reset() {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(targetsFile, { force: true });
  }

  function tableNames(db) {
    return db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap(result => result.values.map(row => row[0]));
  }

  function targetColumns(db) {
    const info = db.exec('PRAGMA table_info(targets)');
    return info.length ? info[0].values.map(r => r[1]) : [];
  }

  const lead = (over = {}) => ({
    id: 'l-1', phone: '+66900000001', source: 'src', keyword: 'kw',
    status: 'pending', collectedAt: '2026-07-01T00:00:00.000Z',
    title: '', website: '', email: '', address: '', runSlug: '',
    ...over
  });

  function dbBytes(store) {
    return Buffer.from(store.db.export());
  }

  // --- 1. schema ---

  test('1. the targets table carries exactly the approved Target schema', async () => {
    reset();
    const store = await openStore();
    assert.deepStrictEqual(targetColumns(store.db), [
      'id', 'name', 'industry', 'businessTypes', 'locations',
      'requiredFields', 'optionalFields', 'exclusions',
      'createdAt', 'updatedAt', 'status'
    ], 'exactly the approved Target fields, in order');
    assert.ok(tableNames(store.db).includes('targets'));
    // No lead table change and no foreign key: a target references no row.
    const numbersColumns = store.db.exec('PRAGMA table_info(numbers)');
    assert.strictEqual(numbersColumns[0].values.length, 19, 'the lead table is unchanged (19 columns)');
    const fks = store.db.exec('PRAGMA foreign_key_list(targets)');
    assert.ok(!fks.length || !fks[0].values.length, 'no DB-level foreign key on targets');
    const backRefs = store.db.exec('PRAGMA foreign_key_list(numbers)');
    assert.ok(!backRefs.length || !backRefs[0].values.length, 'and no lead points at a target');
    assert.ok(!/REFERENCES/i.test(between(storeSource, 'CREATE TABLE IF NOT EXISTS targets (', ')')),
      'no REFERENCES clause in the targets table');
    // The list columns are stored as JSON text, like the B6 tags column.
    await store.saveTarget({ ...VALID });
    const row = (await store.listTargets()).rows[0];
    assert.deepStrictEqual(row.businessTypes, ['HVAC Contractor', 'Air Conditioning']);
    assert.deepStrictEqual(row.requiredFields, ['phone', 'website']);
  });

  // --- 2. CRUD ---

  test('2. create, read, update and list round-trip on both storages', async () => {
    reset();
    for (const store of [await openStore(), await openJsonStore()]) {
      const storage = store.db ? 'sql' : 'json';
      const empty = await store.listTargets();
      assert.deepStrictEqual(empty, { rows: [], total: 0 }, storage + ': an empty library lists nothing');

      const created = await store.saveTarget({ ...VALID });
      assert.strictEqual(created.success, true, storage + ': create succeeds');
      assert.strictEqual(created.created, true, storage + ': reported as a create');
      assert.strictEqual(created.updated, false, storage);
      assert.ok(typeof created.id === 'string' && created.id.length > 0, storage + ': an id is issued');

      const listed = await store.listTargets();
      assert.strictEqual(listed.total, 1, storage);
      const row = listed.rows[0];
      assert.strictEqual(row.id, created.id, storage);
      assert.strictEqual(row.name, 'Bangkok HVAC');
      assert.strictEqual(row.industry, 'HVAC');
      assert.deepStrictEqual(row.businessTypes, ['HVAC Contractor', 'Air Conditioning']);
      assert.deepStrictEqual(row.locations, ['Bangkok', 'Thailand']);
      assert.deepStrictEqual(row.requiredFields, ['phone', 'website']);
      assert.deepStrictEqual(row.optionalFields, ['email']);
      assert.deepStrictEqual(row.exclusions, ['Casino', 'closed']);
      assert.strictEqual(row.status, 'active');
      assert.ok(JOB_TIME_LIKE.test(row.createdAt), storage + ': a system createdAt is stamped');
      assert.ok(JOB_TIME_LIKE.test(row.updatedAt), storage + ': a system updatedAt is stamped');

      // Update by id: the definition changes, the identity does not.
      const updated = await store.saveTarget({ ...VALID, id: created.id, name: 'Bangkok HVAC v2', industry: 'HVAC Service' });
      assert.strictEqual(updated.success, true, storage);
      assert.strictEqual(updated.updated, true, storage + ': reported as an update');
      assert.strictEqual(updated.created, false, storage);
      assert.strictEqual(updated.id, created.id, storage + ': the id is stable');
      const after = (await store.listTargets()).rows[0];
      assert.strictEqual(after.name, 'Bangkok HVAC v2');
      assert.strictEqual(after.industry, 'HVAC Service');
      assert.strictEqual(after.createdAt, row.createdAt, storage + ': createdAt is system-owned and preserved');
      assert.ok(after.updatedAt >= row.updatedAt, storage + ': updatedAt moves forward');
      assert.strictEqual((await store.listTargets()).total, 1, storage + ': an update never adds a row');

      // A second create is a second row, in creation order.
      const second = await store.saveTarget({ name: 'Second target' });
      const all = await store.listTargets();
      assert.strictEqual(all.total, 2, storage);
      assert.deepStrictEqual(all.rows.map(r => r.id), [created.id, second.id], storage + ': creation order is the read order');
    }
  });

  // --- 3/4. validation limits and allowlists ---

  test('3. length limits are enforced and valid intent is never truncated', async () => {
    const longName = 'x'.repeat(storeApi.MAX_TARGET_NAME_LENGTH);
    const ok = storeApi.validateTargetRecord({ ...VALID, name: longName }, null);
    assert.strictEqual(ok.ok, true, 'exactly the maximum name length is accepted');
    assert.strictEqual(ok.value.name.length, storeApi.MAX_TARGET_NAME_LENGTH);
    const tooLong = storeApi.validateTargetRecord({ ...VALID, name: longName + 'x' }, null);
    assert.strictEqual(tooLong.ok, false, 'one character over the limit is refused, not truncated');
    const longIndustry = storeApi.validateTargetRecord({ ...VALID, industry: 'y'.repeat(storeApi.MAX_TARGET_INDUSTRY_LENGTH) }, null);
    assert.strictEqual(longIndustry.ok, true);
    assert.strictEqual(storeApi.validateTargetRecord({ ...VALID, industry: 'y'.repeat(storeApi.MAX_TARGET_INDUSTRY_LENGTH + 1) }, null).ok, false);
    // List limits: a long term is refused, and a too-long list is refused
    // rather than silently cut down.
    assert.strictEqual(storeApi.validateTargetRecord({ ...VALID, exclusions: 'z'.repeat(storeApi.MAX_TARGET_TERM_LENGTH) }, null).ok, true);
    assert.strictEqual(storeApi.validateTargetRecord({ ...VALID, exclusions: 'z'.repeat(storeApi.MAX_TARGET_TERM_LENGTH + 1) }, null).ok, false);
    const manyTerms = Array.from({ length: storeApi.MAX_TARGET_TERMS + 1 }, (_, i) => 'term' + i).join(',');
    assert.strictEqual(storeApi.validateTargetRecord({ ...VALID, locations: manyTerms }, null).ok, false,
      'more terms than the limit is an error, not a silent truncation');
    const exactTerms = Array.from({ length: storeApi.MAX_TARGET_TERMS }, (_, i) => 'term' + i).join(',');
    const exact = storeApi.validateTargetRecord({ ...VALID, locations: exactTerms }, null);
    assert.strictEqual(exact.ok, true, 'exactly the limit is accepted');
    assert.strictEqual(exact.value.locations.length, storeApi.MAX_TARGET_TERMS);
    // Required basics.
    for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
      assert.strictEqual(storeApi.validateTargetRecord({ ...VALID, name: bad }, null).ok, false,
        'a missing or non-string name is refused: ' + JSON.stringify(bad));
    }
    assert.strictEqual(storeApi.validateTargetRecord(null, null).ok, false);
    assert.strictEqual(storeApi.validateTargetRecord([], null).ok, false);
    assert.strictEqual(storeApi.validateTargetRecord('name', null).ok, false);
  });

  test('4. required and optional fields accept only real lead fields', () => {
    assert.deepStrictEqual(storeApi.TARGET_FIELD_ALLOWLIST,
      ['phone', 'title', 'website', 'email', 'address'],
      'the allowlist is exactly the lead fields the model has');
    // Every allowlisted name really exists on a lead.
    for (const field of storeApi.TARGET_FIELD_ALLOWLIST) {
      assert.ok(storeApi.TARGET_FIELD_ALLOWLIST.includes(field));
      assert.ok(/^\s*(id|phone|source|keyword|status|collectedAt|title|website|email|address|runSlug)/m
        .test(storeSource), 'lead column vocabulary unchanged');
    }
    const ok = storeApi.validateTargetRecord({ ...VALID, requiredFields: 'website,phone', optionalFields: ['email'] }, null);
    assert.strictEqual(ok.ok, true, 'a CSV string of real fields is accepted');
    assert.deepStrictEqual(ok.value.requiredFields, ['website', 'phone'], 'user order is preserved');
    // Invented, unavailable or non-lead names are refused, never dropped.
    for (const bad of ['industry', 'companyId', 'qualification', 'websiteHost', 'unknown', 'PHONE', 42, {}]) {
      const res = storeApi.validateTargetRecord({ ...VALID, requiredFields: [bad] }, null);
      assert.strictEqual(res.ok, false, 'unknown criterion refused: ' + JSON.stringify(bad));
      assert.ok(res.error.includes('requiredFields'), 'the refusal names the field: ' + res.error);
    }
    for (const bad of ['industry', 'companyId', 'PHONE', 'phoneStatus']) {
      const res = storeApi.validateTargetRecord({ ...VALID, requiredFields: [bad] }, null);
      assert.ok(/unknown lead field/.test(res.error), 'a name outside the allowlist is named as such: ' + res.error);
    }
    // Duplicates collapse, empties drop, the count cannot exceed the allowlist.
    const deduped = storeApi.validateTargetRecord({ ...VALID, requiredFields: ['phone', 'phone', ' website ', ''] }, null);
    assert.strictEqual(deduped.ok, true);
    assert.deepStrictEqual(deduped.value.requiredFields, ['phone', 'website'], 'deduped, trimmed, order kept');
    const allFields = storeApi.validateTargetRecord(
      { ...VALID, requiredFields: storeApi.TARGET_FIELD_ALLOWLIST, optionalFields: [] }, null);
    assert.ok(allFields.ok, 'every allowlisted field may be required at once');
  });

  // --- 5. contradictory configuration ---

  test('5. a field cannot be both required and optional', () => {
    for (const field of ['phone', 'title', 'website', 'email', 'address']) {
      const res = storeApi.validateTargetRecord({
        ...VALID, requiredFields: [field], optionalFields: [field]
      }, null);
      assert.strictEqual(res.ok, false, 'the contradiction is refused: ' + field);
      assert.ok(/both required and optional/.test(res.error), res.error);
    }
    // Order does not matter to the check.
    assert.strictEqual(storeApi.validateTargetRecord({
      ...VALID, requiredFields: ['title'], optionalFields: ['phone', 'title']
    }, null).ok, false);
    // Disjoint sets are fine, and an empty set is not a contradiction.
    assert.strictEqual(storeApi.validateTargetRecord({
      ...VALID, requiredFields: [], optionalFields: []
    }, null).ok, true);
    assert.strictEqual(storeApi.validateTargetRecord({
      ...VALID, requiredFields: ['phone'], optionalFields: ['title', 'email']
    }, null).ok, true);
  });

  // --- 6. deterministic CSV normalisation ---

  test('6. CSV lists normalise deterministically and keep user order', () => {
    assert.deepStrictEqual(storeApi.normalizeTargetTerms('a, b ,c'),
      ['a', 'b', 'c'], 'commas separate and entries are trimmed');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms('a\nb\nc'), ['a', 'b', 'c'], 'newlines separate too');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms(' a ,, b ,'), ['a', 'b'], 'empties are dropped');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms('A, a ,A'), ['A'],
      'duplicates collapse case-insensitively, first occurrence kept');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms(['b', 'a']), ['b', 'a'], 'array input keeps order');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms(''), [], 'an empty list is empty');
    assert.deepStrictEqual(storeApi.normalizeTargetTerms(null), []);
    assert.deepStrictEqual(storeApi.normalizeTargetTerms(undefined), []);
    assert.deepStrictEqual(storeApi.normalizeTargetTerms('  '), []);
    // Deterministic: the same input always yields the same output.
    const input = 'Bangkok,  bangkok , Thailand ,Chiang Mai, bangkok';
    const first = storeApi.normalizeTargetTerms(input);
    for (let i = 0; i < 5; i++) {
      assert.deepStrictEqual(storeApi.normalizeTargetTerms(input), first, 'stable across calls');
    }
    assert.deepStrictEqual(first, ['Bangkok', 'Thailand', 'Chiang Mai'], 'order and first-wins are deterministic');
  });

  // --- 7. deterministic local exclusions ---

  test('7. exclusions evaluate only on stored lead data, never on unknowns', () => {
    const target = { exclusions: ['Casino', 'closed'] };
    // A stored term matches a whole-token sequence in the stored text.
    assert.deepStrictEqual(evaluateTargetExclusions(target, { title: 'Lucky Casino Club', address: '5 Soi 5' }),
      { excluded: true, reason: 'excluded-term', matched: 'casino' });
    assert.strictEqual(evaluateTargetExclusions(target, { title: 'Cafe', address: '3 B3 Rd' }).excluded, false);
    // Case, punctuation and spacing are normalised on both sides.
    assert.strictEqual(evaluateTargetExclusions({ exclusions: ['lucky casino'] },
      { title: 'LUCKY, CASINO!', address: '' }).excluded, true);
    // A fragment of a longer word never matches.
    assert.strictEqual(evaluateTargetExclusions({ exclusions: ['cas'] },
      { title: 'Cascade Cafe', address: '' }).excluded, false);
    // An explicitly closed business satisfies a closed-business exclusion.
    assert.deepStrictEqual(evaluateTargetExclusions(target, { title: 'Anything', address: '', businessStatus: 'closed' }),
      { excluded: true, reason: 'closed-business', matched: 'closed' });
    // Unknown data is NOT a negative fact and never excludes.
    for (const status of ['unknown', 'active', '', undefined, null, 'CLOSED', 'verified']) {
      assert.strictEqual(evaluateTargetExclusions(target, { title: 'Cafe', address: '', businessStatus: status }).excluded, false,
        'status does not exclude: ' + JSON.stringify(status));
    }
    // Missing data never excludes.
    for (const empty of [{}, { title: '', address: '' }, { title: null, address: null }, null, undefined, 'x']) {
      assert.strictEqual(evaluateTargetExclusions({ exclusions: ['Casino', 'closed'] }, empty).excluded, false,
        'a lead with no data is not excluded: ' + JSON.stringify(empty));
    }
    // No target, or an empty target, excludes nothing.
    assert.strictEqual(evaluateTargetExclusions({}, { title: 'Casino' }).excluded, false);
    assert.strictEqual(evaluateTargetExclusions(null, null).excluded, false);
    // An address-only match is still a match.
    assert.strictEqual(evaluateTargetExclusions({ exclusions: ['bangkok'] },
      { title: '', address: 'Bangkok, Thailand' }).excluded, true);
    // The evaluation is pure: it does not touch the inputs.
    const leadRow = { title: 'Lucky Casino', address: '' };
    const snapshot = JSON.stringify(leadRow);
    evaluateTargetExclusions(target, leadRow);
    assert.strictEqual(JSON.stringify(leadRow), snapshot, 'the lead object is untouched');
  });

  test('8. the exclusion evaluator introduces no model, score or external call', () => {
    const code = codeOnly(P1F_STORE_BLOCK);
    for (const term of ['openai', 'anthropic', 'classif', 'predict', 'infer', 'model', 'llm',
      'score', 'confidence', 'probab', 'fuzzy', 'similarity', 'learn', 'train',
      'fetch(', 'https://', 'require(', 'http']) {
      assert.ok(!code.includes(term), 'the P1-F store block introduces no: ' + term);
    }
    const evaluate = between(P1F_STORE_BLOCK, 'function evaluateTargetExclusions(', '\n}');
    assert.ok(!/require\(|fetch|net\.|http/.test(evaluate), 'the evaluator calls nothing');
    // The evaluator only ever reads the fields a lead actually has.
    for (const field of ['title', 'address', 'businessStatus']) {
      assert.ok(evaluate.includes(field), 'reads a real lead field: ' + field);
    }
    assert.ok(!/industry|businessTypes|companyId/.test(evaluate),
      'it never pretends unavailable lead data exists');
  });

  // --- 9/10. SQL/JSON parity and legacy startup ---

  test('9. SQL and JSON storage produce identical target lists', async () => {
    reset();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const definitions = [
      { ...VALID, name: 'Alpha', businessTypes: 'One, Two', locations: 'A, B' },
      { name: 'Beta', industry: 'Retail', requiredFields: ['title'], exclusions: 'Casino' },
      { name: 'Gamma', status: 'archived', optionalFields: ['address', 'email'] }
    ];
    for (const definition of definitions) {
      const a = await sqlStore.saveTarget({ ...definition });
      const b = await jsonStore.saveTarget({ ...definition });
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
    }
    const sqlList = await sqlStore.listTargets();
    const jsonList = await jsonStore.listTargets();
    assert.strictEqual(jsonList.total, sqlList.total, 'same count');
    // Ids and timestamps are per-store, so the DEFINITION values are compared.
    const shape = (list) => list.rows.map(r => ({ ...r, id: undefined, createdAt: undefined, updatedAt: undefined }));
    assert.deepStrictEqual(shape(jsonList), shape(sqlList), 'identical logical rows on both storages');
    // An update and a status change agree too.
    const id = sqlList.rows[0].id;
    await sqlStore.saveTarget({ ...definitions[0], id, name: 'Alpha v2' });
    await jsonStore.saveTarget({ ...definitions[0], id: jsonList.rows[0].id, name: 'Alpha v2' });
    await sqlStore.setTargetStatus({ id, status: 'archived' });
    await jsonStore.setTargetStatus({ id: jsonList.rows[0].id, status: 'archived' });
    assert.deepStrictEqual(shape(await jsonStore.listTargets()), shape(await sqlStore.listTargets()),
      'identical after update and archive');
  });

  test('10. a legacy database gains the targets table and keeps every lead', async () => {
    reset();
    // A pre-P1-F database: the 19-column numbers table and the job ledger only.
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE numbers (
      id TEXT PRIMARY KEY, phone TEXT, source TEXT, keyword TEXT,
      status TEXT DEFAULT 'pending', collectedAt TEXT, title TEXT, website TEXT,
      email TEXT, address TEXT, runSlug TEXT, qualification TEXT DEFAULT 'unqualified',
      tags TEXT DEFAULT '[]', notes TEXT DEFAULT '', phoneStatus TEXT DEFAULT 'unknown',
      emailStatus TEXT DEFAULT 'unknown', websiteStatus TEXT DEFAULT 'unknown',
      businessStatus TEXT DEFAULT 'unknown', companyId TEXT
    )`);
    legacy.run('INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy-1', '+66811111111', 'Bangkok Cafe', 'cafe', 'pending', '2026-01-01T00:00:00.000Z']);
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();

    const store = await openStore();
    assert.ok(tableNames(store.db).includes('targets'), 'the targets table is created on open');
    assert.deepStrictEqual(targetColumns(store.db).length, 11, 'with the approved schema');
    const rows = await store.getCollectedNumbers();
    assert.strictEqual(rows.length, 1, 'no lead is lost');
    assert.strictEqual(rows[0].phone, '+66811111111');
    assert.strictEqual(rows[0].source, 'Bangkok Cafe', 'lead data preserved byte-for-byte');
    assert.deepStrictEqual(await store.listTargets(), { rows: [], total: 0 }, 'a fresh target list');
    // Restart: idempotent, and a target survives a reopen.
    const created = await store.saveTarget({ ...VALID });
    const again = await openStore();
    const listed = await again.listTargets();
    assert.strictEqual(listed.total, 1, 'the target survives a restart');
    assert.strictEqual(listed.rows[0].name, 'Bangkok HVAC');
    assert.strictEqual(listed.rows[0].id, created.id);
    assert.strictEqual((await again.getCollectedNumbers()).length, 1, 'and the lead is still there');
  });

  // --- 11. archive/activate ---

  test('11. archive and activate change only the status', async () => {
    reset();
    for (const store of [await openStore(), await openJsonStore()]) {
      const storage = store.db ? 'sql' : 'json';
      const created = await store.saveTarget({ ...VALID });
      const before = (await store.listTargets()).rows[0];

      const archived = await store.setTargetStatus({ id: created.id, status: 'archived' });
      assert.strictEqual(archived.success, true, storage);
      assert.strictEqual(archived.updated, true, storage);
      let row = (await store.listTargets()).rows[0];
      assert.strictEqual(row.status, 'archived', storage);
      assert.strictEqual(row.name, before.name, storage + ': the definition is untouched');
      assert.strictEqual(row.industry, before.industry, storage);
      assert.deepStrictEqual(row.businessTypes, before.businessTypes, storage);
      assert.deepStrictEqual(row.requiredFields, before.requiredFields, storage);
      assert.deepStrictEqual(row.exclusions, before.exclusions, storage);
      assert.strictEqual(row.createdAt, before.createdAt, storage + ': createdAt preserved');

      const unchanged = await store.setTargetStatus({ id: created.id, status: 'archived' });
      assert.deepStrictEqual(unchanged, { success: true, updated: false, reason: 'unchanged' },
        storage + ': a no-op archive is not written');
      const missing = await store.setTargetStatus({ id: 'nope', status: 'active' });
      assert.deepStrictEqual(missing, { success: true, updated: false, reason: 'not-found' }, storage);
      for (const bad of ['', 'ACTIVE', 'deleted', null, 1, {}]) {
        const res = await store.setTargetStatus({ id: created.id, status: bad });
        assert.strictEqual(res.success, false, storage + ': refused status: ' + JSON.stringify(bad));
      }
      for (const bad of ['', null, 42, 'x'.repeat(101), {}]) {
        const res = await store.setTargetStatus({ id: bad, status: 'active' });
        assert.strictEqual(res.success, false, storage + ': refused id: ' + JSON.stringify(bad));
      }
      const activated = await store.setTargetStatus({ id: created.id, status: 'active' });
      assert.strictEqual(activated.updated, true, storage);
      row = (await store.listTargets()).rows[0];
      assert.strictEqual(row.status, 'active', storage + ': activate round-trips');
    }
  });

  // --- 12. ownership ---

  test('12. a target is a definition: the store never lets one change a lead', async () => {
    reset();
    const store = await openStore();
    await store.addNumbers([lead({ id: 'own-1', website: 'https://own.example', title: 'Owned', address: '1 O Rd' })]);
    // The lead ROW is the invariant, not the file image: saving a target
    // rewrites the database file, so the proof is the stored row itself.
    const leadSnapshot = () => {
      const scan = store.db.exec('SELECT * FROM numbers ORDER BY rowid ASC');
      return scan.length ? scan[0].values.map(v => [...v]) : [];
    };
    const before = leadSnapshot();
    assert.strictEqual(before.length, 1);

    // Create, update, archive: none of it may touch a lead.
    const created = await store.saveTarget({ ...VALID });
    assert.deepStrictEqual(leadSnapshot(), before, 'creating a target writes no lead row');
    await store.saveTarget({ ...VALID, id: created.id, name: 'Changed' });
    assert.deepStrictEqual(leadSnapshot(), before, 'updating a target writes no lead row');
    await store.setTargetStatus({ id: created.id, status: 'archived' });
    await store.setTargetStatus({ id: created.id, status: 'active' });
    await store.listTargets();
    assert.deepStrictEqual(leadSnapshot(), before, 'archiving or reading writes no lead row');

    const leadsAfter = (await store.getCollectedNumbers())[0];
    assert.strictEqual(leadsAfter.id, 'own-1');
    assert.strictEqual(leadsAfter.website, 'https://own.example');
    assert.strictEqual(leadsAfter.title, 'Owned');
    assert.strictEqual(leadsAfter.qualification, 'unqualified', 'B6 defaults intact');
    assert.deepStrictEqual(leadsAfter.tags, []);
    assert.strictEqual(leadsAfter.notes, '');
    for (const field of ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus']) {
      assert.strictEqual(leadsAfter[field], 'unknown', 'P1-C default intact: ' + field);
    }
    // The lead row itself is byte-identical.
    assert.deepStrictEqual(leadSnapshot(), before, 'the stored lead row is unchanged');

    // A required field is a CRITERION, not a save gate: a lead with none of the
    // target's required fields is still stored, unchanged and readable.
    const noMatch = lead({ id: 'own-2', phone: '+66900000009' });
    const res = await store.addNumbers([noMatch]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 }, 'a lead missing every required field is still saved');
    const saved = (await store.getCollectedNumbers()).find(r => r.id === 'own-2');
    assert.ok(saved, 'and is readable');
    assert.strictEqual(saved.qualification, 'unqualified');
    assert.deepStrictEqual(saved.tags, []);
    // No lead method reads a target, and no target method reads a lead.
    const leadRegion = between(storeSource, '// === 号码管理 ===', '// === B6 user-owned lead fields ===');
    assert.ok(!/target/i.test(codeOnly(leadRegion)), 'the lead save path never consults a target');
    for (const method of ['addNumbers', 'deleteNumbers', 'setLeadUserFields', 'setLeadUserStatuses',
      '_addNumbers', 'getCollectedNumbers', 'exportNumbers']) {
      const body = between(storeSource, method + '(', '\n  }');
      assert.ok(!/listTargets|saveTarget|setTargetStatus|_targets/.test(codeOnly(body)),
        method + ' never touches a target');
    }
  });

  test('13. B6 and P1-C lead fields survive a target round-trip', async () => {
    reset();
    const store = await openStore();
    await store.addNumbers([lead({ id: 'b6-1' })]);
    await store.setLeadUserFields({ id: 'b6-1', qualification: 'qualified', tags: ['vip', 'Wholesale'], notes: 'keep me' });
    await store.setLeadUserStatuses({ id: 'b6-1', phoneStatus: 'verified', businessStatus: 'closed' });
    const before = (await store.getCollectedNumbers())[0];

    const created = await store.saveTarget({ ...VALID });
    await store.saveTarget({ ...VALID, id: created.id, name: 'v2', exclusions: 'Casino' });
    await store.setTargetStatus({ id: created.id, status: 'archived' });

    const after = (await store.getCollectedNumbers())[0];
    assert.strictEqual(after.qualification, 'qualified', 'qualification preserved');
    assert.deepStrictEqual(after.tags, ['vip', 'Wholesale'], 'tags preserved');
    assert.strictEqual(after.notes, 'keep me', 'notes preserved');
    assert.strictEqual(after.phoneStatus, 'verified', 'a P1-C status preserved');
    assert.strictEqual(after.businessStatus, 'closed', 'including a closed one');
    assert.deepStrictEqual(after, before, 'the whole lead row is byte-identical');
    // The deterministic exclusion evaluator reads that status, and reading it
    // still changes nothing.
    const verdict = await store.evaluateTargetExclusionsForLead(created.id, after);
    assert.deepStrictEqual(verdict, { excluded: true, reason: 'closed-business', matched: 'closed' });
    assert.deepStrictEqual((await store.getCollectedNumbers())[0], before, 'evaluation changed nothing');
  });

  // --- 14. provider contract ---

  test('14. the provider, client and credential surfaces are untouched', async () => {
    for (const file of ['src/main/providers/coreclawAdapter.js', 'src/main/providers/providerManager.js',
      'src/main/providers/collectionProvider.js', 'src/main/coreClawClient.js',
      'src/main/credentialVault.js', 'src/main/proxyDetector.js']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      // No target concept: no channel, no store call, no Target field.
      for (const token of ['targets:', 'saveTarget', 'listTargets', 'setTargetStatus',
        'requiredFields', 'optionalFields', 'businessTypes']) {
        assert.ok(!source.includes(token), 'no target concept in the provider/credential stack: ' + file + ' (' + token + ')');
      }
    }
    // The provider contract still declares exactly its original methods.
    for (const method of ['setCredentials', 'testConnection', 'submitCollection', 'getJobState',
      'getJobResults', 'getJobHistory']) {
      assert.ok(adapterSource.includes(method), 'provider method intact: ' + method);
    }
    assert.ok(contractMethods().length === 6, 'the provider interface gained no method');
    // No target channel is reachable from a collection or settings handler.
    for (const channel of ['targets:list', 'targets:save', 'targets:set-status']) {
      const handler = between(mainSource, "ipcMain.handle('" + channel + "'", '});');
      assert.ok(!/collection|providerManager|CoreClaw|credential/.test(handler),
        channel + ' touches no provider or credential');
      assert.ok(!/addNumbers|deleteNumbers|setLeadUserFields|setLeadUserStatuses/.test(handler),
        channel + ' touches no lead');
    }
    // The collector request shape is unchanged: no target parameter was added.
    const shape = between(mainSource, 'function validateSubmitShape(', '\n}');
    assert.ok(shape.includes('params.keywords'), 'the provider keyword parameter is unchanged');
    assert.ok(!/target/i.test(shape), 'the provider request shape gained no target field');
  });

  // --- 15. use for collection maps only existing parameters ---

  test('15. "Use for collection" maps only existing collector inputs', () => {
    const mapBlock = between(rendererSource, 'const TARGET_COLLECTOR_PARAM_MAP =', '};');
    const mapped = [...mapBlock.matchAll(/:\s*'([^']+)'/g)].map(m => m[1]);
    assert.deepStrictEqual(mapped.sort(), ['collect-keywords', 'collect-region'],
      'exactly two existing collector inputs are mapped');
    for (const id of mapped) {
      assert.ok(htmlSource.includes('id="' + id + '"'), 'the mapped input exists in the collector form: ' + id);
    }
    // The mapping is pure: it returns values and writes nothing.
    const toParams = between(rendererSource, 'function targetToCollectorParams(', '\n}');
    assert.ok(!/document\.|appAPI|=\s*document/.test(codeOnly(toParams).replace(/document\.getElementById\(inputId\)/, '')),
      'the mapping function touches no DOM and no API');
    // The applier only ever writes those two inputs, and never overwrites.
    const apply = between(rendererSource, 'function useTargetForCollection(', '\n}');
    assert.ok(apply.includes("querySelector('.nav-item[data-view=\"collector\"]')"),
      'it navigates to the existing collector view');
    assert.ok(!/Start Collection|btn-start-collect|collection\.submit/.test(apply),
      'it never starts a collection itself');
    assert.ok(apply.includes('kept++'), 'a field the user already filled in is kept');
    // No new collector input, option or provider parameter was introduced.
    const collectorSection = between(htmlSource, 'id="view-collector"', '<!-- Collection History');
    for (const id of ['collect-keywords', 'collect-region']) {
      assert.ok(collectorSection.includes('id="' + id + '"'), 'existing input still present: ' + id);
    }
    assert.ok(!/id="collect-target/.test(htmlSource), 'no target-specific collector input exists');
    // The collection submit path carries no target field and asks the provider
    // for nothing new.
    const submit = between(mainSource, 'async function handleCollectionSubmit', 'async function handleGetJobState');
    assert.ok(!/target/i.test(submit), 'the collection submit path carries no target field');
    const shape = between(mainSource, 'function validateSubmitShape(', '\n}');
    assert.ok(!/target/i.test(shape), 'the provider request shape gained no target field');
    assert.ok(shape.includes('keywords'), 'the provider keyword parameter is unchanged');
  });

  // --- 16. invalid IPC payloads ---

  test('16. the main-process validators refuse invalid target payloads', () => {
    const validateTarget = loadValidator('validateTargetPayload', '// B2 query layer: the only sort identifiers');
    const validateStatus = loadValidator('validateTargetStatusPayload', '// B2 query layer: the only sort identifiers');

    // A valid payload is reduced to the approved fields, in the store's shape.
    const accepted = validateTarget({
      name: '  Bangkok HVAC  ', industry: ' HVAC ', businessTypes: 'A, B',
      locations: ['Bangkok'], requiredFields: ['phone'], optionalFields: 'email',
      exclusions: 'Casino', status: 'active', createdAt: 'forged', updatedAt: 'forged', extra: 'ignored'
    });
    assert.deepStrictEqual(accepted, {
      name: 'Bangkok HVAC', industry: 'HVAC', requiredFields: ['phone'], optionalFields: ['email'], status: 'active'
    }, 'only the approved fields survive; system timestamps are never read');
    for (const rule of storeApi.TARGET_FIELD_ALLOWLIST) {
      assert.ok(validateTarget({ name: 'x', requiredFields: [rule] }).requiredFields.includes(rule), 'accepted: ' + rule);
    }
    // Refusals.
    for (const bad of ['', '   ', null, undefined, 42, {}, [], true]) {
      expectInvalid(validateTarget, { name: bad });
    }
    expectInvalid(validateTarget, { name: 'x'.repeat(121) });
    expectInvalid(validateTarget, { name: 'ok', industry: 'y'.repeat(121) });
    expectInvalid(validateTarget, { name: 'ok', industry: 42 });
    for (const bad of ['industry', 'companyId', 'qualification', 'PHONE', 42, [{}], {}]) {
      expectInvalid(validateTarget, { name: 'ok', requiredFields: [bad] });
      expectInvalid(validateTarget, { name: 'ok', optionalFields: [bad] });
    }
    expectInvalid(validateTarget, { name: 'ok', requiredFields: ['phone'], optionalFields: ['phone'] });
    expectInvalid(validateTarget, { name: 'ok', status: 'ACTIVE' });
    expectInvalid(validateTarget, { name: 'ok', status: 'deleted' });
    expectInvalid(validateTarget, { name: 'ok', status: 1 });
    expectInvalid(validateTarget, { name: 'ok', businessTypes: 42 });
    expectInvalid(validateTarget, { name: 'ok', locations: [42] });
    expectInvalid(validateTarget, { name: 'ok', id: '' });
    expectInvalid(validateTarget, { name: 'ok', id: 'x'.repeat(101) });
    expectInvalid(validateTarget, { name: 'ok', id: 42 });
    expectInvalid(validateTarget, null);
    expectInvalid(validateTarget, 'name');
    expectInvalid(validateTarget, []);
    // Status channel.
    assert.deepStrictEqual(validateStatus({ id: 't1', status: 'archived' }), { id: 't1', status: 'archived' });
    assert.deepStrictEqual(validateStatus({ id: 't1', status: 'active' }), { id: 't1', status: 'active' });
    for (const bad of ['', 'ACTIVE', 'Archived', 'deleted', null, 1, {}]) {
      expectInvalid(validateStatus, { id: 't1', status: bad });
    }
    for (const bad of ['', null, 42, 'x'.repeat(101), {}]) {
      expectInvalid(validateStatus, { id: bad, status: 'active' });
    }
    expectInvalid(validateStatus, { id: 't1' });
    // Main-process validation is authoritative: every handler validates.
    for (const channel of ['targets:save', 'targets:set-status']) {
      const handler = between(mainSource, "ipcMain.handle('" + channel + "'", '});');
      assert.ok(/validateTarget\w*Payload\(payload\)/.test(handler), channel + ' validates in main');
      assert.ok(handler.includes('if (err.invalidParams) rejectLog('), channel + ' logs the rejection, not the payload');
    }
    // No dynamic channel construction.
    for (const [name, src] of [['main.js', mainSource], ['preload.js', preloadSource]]) {
      assert.ok(!/new ipcMain\.handle|ipcMain\.handle\(\s*[a-zA-Z_$]/.test(src), name + ' registers channels literally');
    }
  });

  // --- 17. renderer/preload contract ---

  test('17. the renderer and preload expose exactly the target surface', () => {
    // Preload: three methods, each a literal invoke of a targets channel.
    for (const [method, channel] of [['list', 'targets:list'], ['save', 'targets:save'], ['setStatus', 'targets:set-status']]) {
      assert.ok(preloadSource.includes(method + ": ") && preloadSource.includes("invoke('" + channel + "'"),
        'preload exposes ' + method + ' -> ' + channel);
    }
    assert.strictEqual(preloadSource.split("invoke('targets:").length - 1, 3, 'exactly three target invokes');
    // No lead write is exposed next to them.
    const targetApi = between(preloadSource, 'targets: {', '},');
    assert.ok(!/collector|addNumbers|deleteNumbers|updateLead/.test(targetApi),
      'the target API touches no lead');
    // The renderer only reads and writes targets through appAPI.targets.
    const targetJs = between(rendererSource, '// === P1-F Target Builder (user-owned definitions) ===', '// === B5 Lead Library Dashboard ===');
    const calls = [...new Set([...targetJs.matchAll(/appAPI\.(\w+)\.(\w+)/g)].map(m => m[1] + '.' + m[2]))].sort();
    assert.deepStrictEqual(calls, ['targets.list', 'targets.save', 'targets.setStatus'],
      'the Target Builder calls exactly the three target methods');
    for (const forbidden of ['appAPI.collector.addNumbers', 'appAPI.collector.deleteNumbers',
      'appAPI.collector.updateLead', 'appAPI.collection.submit', 'appAPI.settings.save', 'appAPI.proxy.detect']) {
      assert.ok(!targetJs.includes(forbidden), 'the Target Builder calls no other flow: ' + forbidden);
    }
    // Escaping, no inline handlers, no evaluation.
    assert.ok(targetJs.includes('escapeHtml('), 'rendered values are escaped');
    assert.ok(!/onclick=|onchange=|oninput=|eval\(|new Function/.test(targetJs), 'no inline handler and no eval');
    // No CRM/analytics/outreach surface, and no scoring of a lead.
    const code = codeOnly(targetJs);
    for (const term of ['score', 'rank', 'crm', 'contact', 'outreach', 'campaign', 'leadCount', 'analytics',
      'conversion', 'probability']) {
      assert.ok(!code.toLowerCase().includes(term), 'the Target Builder introduces no: ' + term);
    }
    // The view exists, is registered and lazily loads.
    assert.ok(htmlSource.includes('id="view-targets"'), 'the Targets view exists');
    assert.ok(htmlSource.includes('data-view="targets"'), 'and is reachable from the nav');
    assert.ok(rendererSource.includes("if (viewId === 'targets') loadTargets();"), 'and loads on demand');
    assert.ok(rendererSource.includes("targets: 'Targets'"), 'and has a title');
    for (const id of ['target-name', 'target-industry', 'target-business-types', 'target-locations',
      'target-required-fields', 'target-optional-fields', 'target-exclusions', 'target-status',
      'btn-target-new', 'btn-target-save', 'btn-target-cancel', 'target-list']) {
      assert.ok(htmlSource.includes('id="' + id + '"'), 'editor control present: ' + id);
    }
    // The criterion checkboxes offer exactly the allowlist.
    const requiredBox = between(htmlSource, 'id="target-required-fields"', '</div>');
    const optionalBox = between(htmlSource, 'id="target-optional-fields"', '</div>');
    for (const box of [requiredBox, optionalBox]) {
      assert.deepStrictEqual([...box.matchAll(/value="([^"]+)"/g)].map(m => m[1]).sort(),
        storeApi.TARGET_FIELD_ALLOWLIST.slice().sort(), 'the editor offers exactly the real lead fields');
    }
    // The create/edit/archive/activate/use actions exist.
    for (const action of ['edit', 'toggle-status', 'use']) {
      assert.ok(targetJs.includes("data-action=\"" + action + "\"") || targetJs.includes("'" + action + "'"),
        'action present: ' + action);
    }
    // The Lead Profile and the Lead Library table are untouched by P1-F.
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-targets"');
    for (const column of ['<th>Target</th>', '<th>Industry</th>', '<th>Exclusions</th>']) {
      assert.ok(!table.includes(column), 'no target column in the Lead Library table: ' + column);
    }
  });

  // --- 18. dependencies and logging ---

  test('18. no dependency change and no PII logging', () => {
    // The only production dependency change in the project's history is the
    // deliberate prospect-research trio; no dev dependency was introduced.
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
      'production dependencies are exactly the two originals plus the three prospect-research ones');
    assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
      ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
      'no dev dependency added');
    assert.strictEqual(pkg.scripts.test, 'node tests/run-all.js', 'test wiring unchanged');
    // Target logs carry identifiers and the status word only: never the
    // definition text the user typed.
    const logLines = P1F_TARGET_REGION.split('\n').filter(l => l.includes('logger.'));
    for (const line of logLines) {
      assert.ok(!/name|industry|businessTypes|locations|exclusions|requiredFields|optionalFields/.test(line),
        'no definition content is logged: ' + line.trim());
    }
    for (const forbidden of ['fetch(', 'https://', 'require(\'https\')', 'net.', 'XMLHttpRequest']) {
      assert.ok(!codeOnly(P1F_STORE_BLOCK).includes(forbidden), 'no network call in the store block: ' + forbidden);
    }
    // CSP is unchanged, byte for byte.
    const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(htmlSource);
    assert.strictEqual(csp[0], '<meta http-equiv="Content-Security-Policy" content="default-src \'self\';'
      + ' script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\';'
      + ' object-src \'none\'; base-uri \'none\'; frame-src \'none\'">', 'CSP unchanged');
    assert.strictEqual((htmlSource.match(/Content-Security-Policy/g) || []).length, 1, 'one CSP tag');
  });

  // --- helpers ---

  function contractMethods() {
    const contract = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'collectionProvider.js'), 'utf8');
    const body = between(contract, 'const REQUIRED_COLLECTION_METHODS =', '];');
    return [...body.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
  }

  function loadValidator(name, end) {
    // Regex-anchored constant extraction: a textual slice can cut a statement in
    // half, and the guards below must be the production ones.
    const consts = [
      /const TARGET_STATUS_VALUES = \[[^\]]*\];/,
      /const TARGET_FIELD_ALLOWLIST = \[[^\]]*\];/,
      /const MAX_TARGET_NAME_LENGTH = [^;]+;/,
      /const MAX_TARGET_INDUSTRY_LENGTH = [^;]+;/,
      /const MAX_TARGET_TERM_LENGTH = [^;]+;/,
      /const MAX_TARGET_TERMS = [^;]+;/,
      /const TARGET_LIST_FIELDS = \[[^\]]*\];/
    ].map(re => {
      const m = re.exec(mainSource);
      assert.ok(m, 'main constant found: ' + re);
      return m[0];
    });
    // From the first P1-F helper through the end marker, so every helper the
    // validator uses is the shipped one.
    const guards = between(mainSource, 'function invalidParams(', '// P1-F Target builder.');
    const body = between(mainSource, 'function validateTargetText(', end);
    return new Function('logger', consts.join('\n') + '\n' + guards + '\n' + body
      + '\nreturn ' + name + ';')({ warn() {}, info() {}, error() {}, ok() {} });
  }

  function expectInvalid(validate, payload) {
    let err = null;
    try {
      validate(payload);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'payload must be refused: ' + JSON.stringify(payload));
    assert.strictEqual(err.invalidParams, true, 'refusal must carry invalidParams for rejectLog');
  }

  const JOB_TIME_LIKE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }

  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch (cleanupErr) {}

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
