'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b6-qual-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  // Counting logger stub: proves the B6 write path never logs tag or note
  // content (the payload is only ever the lead id and success flags).
  const logRecords = [];
  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: {
      info(category, message, data) { logRecords.push({ level: 'info', category, message, data }); },
      warn(category, message, data) { logRecords.push({ level: 'warn', category, message, data }); },
      error(category, message, data) { logRecords.push({ level: 'error', category, message, data }); },
      ok(category, message, data) { logRecords.push({ level: 'ok', category, message, data }); }
    } }
  };

const root = path.join(__dirname, '..');
const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
const storeSource = fs.readFileSync(accountStorePath, 'utf8');
const { AccountStore, migrateSchema } = require(accountStorePath);

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}


  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');
  const jsonPath = path.join(dataDir, 'numbers.json');

  const PROVIDER_INSERT =
    'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  const B6_COLUMNS = ['qualification', 'tags', 'notes'];

  function schemaColumns(db) {
    const info = db.exec('PRAGMA table_info(numbers)');
    if (!info.length) return [];
    return info[0].values.map(r => r[1]);
  }

  function rawRow(store, id) {
    const stmt = store.db.prepare(
      'SELECT qualification, tags, notes FROM numbers WHERE id = ?'
    );
    try {
      stmt.bind([id]);
      if (!stmt.step()) return null;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  // A store forced onto the JSON branch while keeping the real JSON code
  // paths (writeJsonAtomic, in-memory rows) under test.
  async function openJsonStore() {
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    store._numbers = [];
    return store;
  }

  function readJsonFile() {
    return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  }

  async function findById(store, id) {
    const result = await store.queryNumbers({ limit: 1, offset: 0, id });
    return result.rows[0] || null;
  }

  function seedLegacySixColumnDb() {
    const initSQL = require('sql.js');
    return initSQL().then(SQL => {
      const db = new SQL.Database();
      db.run(`CREATE TABLE numbers (
        id TEXT PRIMARY KEY,
        phone TEXT,
        source TEXT,
        keyword TEXT,
        status TEXT DEFAULT 'pending',
        collectedAt TEXT
      )`);
      db.run('CREATE INDEX idx_numbers_phone ON numbers(phone)');
      db.run('CREATE INDEX idx_numbers_status ON numbers(status)');
      db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ['legacy-b6', '+66900000000', 'Legacy B6', 'kw', 'pending', '2026-04-01T00:00:00.000Z']
      );
      db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
        ['legacy-b6-null', '+66900000001', null, 'kw', 'pending', '2026-04-02T00:00:00.000Z']
      );
      fs.writeFileSync(dbPath, Buffer.from(db.export()));
      db.close();
    });
  }

  // --- 1. fresh schema ----------------------------------------------------
  test('1. fresh database is created with the 14-column lead schema', async () => {
    fs.rmSync(dbPath, { force: true });
    const fresh = await openStore();
    const columns = schemaColumns(fresh.db);
    assert.deepStrictEqual(columns, [
      'id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug',
      'qualification', 'tags', 'notes'
    ], 'exactly the 11 B1 columns plus the three B6 columns, in order');
    assert.strictEqual(migrateSchema(fresh.db), 0, 'fresh schema needs no migration');
  });

  // --- 2/3. legacy migration ----------------------------------------------
  test('2. legacy 6-column database gains all eight missing columns', async () => {
    await seedLegacySixColumnDb();
    const store = await openStore();
    assert.deepStrictEqual(schemaColumns(store.db), [
      'id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug',
      'qualification', 'tags', 'notes'
    ], 'migration completes the schema');
    assert.strictEqual(migrateSchema(store.db), 0, 'nothing left to add after init');
  });

  test('3. migration backfills the B6 defaults on every legacy row', async () => {
    await seedLegacySixColumnDb();
    const store = await openStore();
    const row = rawRow(store, 'legacy-b6');
    assert.strictEqual(row.qualification, 'unqualified', 'qualification default backfilled');
    assert.strictEqual(row.tags, '[]', 'tags default backfilled as an empty JSON array');
    assert.strictEqual(row.notes, '', 'notes default backfilled as an empty string');
    const nullSource = rawRow(store, 'legacy-b6-null');
    assert.strictEqual(nullSource.qualification, 'unqualified', 'NULL-source row also backfilled');
    assert.strictEqual(nullSource.tags, '[]');
    assert.strictEqual(nullSource.notes, '');
    // A migrated row must expose the same logical values as a fresh row.
    const apiRow = await findById(store, 'legacy-b6');
    assert.strictEqual(apiRow.qualification, 'unqualified');
    assert.deepStrictEqual(apiRow.tags, [], 'migrated tags read back as an array');
    assert.strictEqual(apiRow.notes, '');
    assert.strictEqual(apiRow.title, 'Legacy B6', 'B1 backfill unaffected');
  });

  test('4. migration is idempotent and rewrites nothing when already migrated', async () => {
    const store = await openStore();
    const before = Buffer.from(store.db.export());
    assert.strictEqual(migrateSchema(store.db), 0, 'second run reports zero added columns');
    const after = Buffer.from(store.db.export());
    assert.ok(before.equals(after), 'an already-migrated database must not be rewritten');
  });

  // --- 5/6. parity and safe normalisation ---------------------------------
  test('5. SQL and JSON stores expose identical logical B6 values', async () => {
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      const res = await store.addNumbers([{
        id: 'parity-1', phone: '+66911110000', source: 'src', keyword: 'kw',
        status: 'pending', collectedAt: '2026-04-03T00:00:00.000Z'
      }]);
      assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
      const saved = await store.setLeadUserFields({
        id: 'parity-1', qualification: 'qualified', tags: ['VIP', 'vip', '  Wholesale  '],
        notes: 'Line one\nLine two'
      });
      assert.deepStrictEqual(saved, { success: true, updated: true });
    }
    const sqlRow = await findById(sqlStore, 'parity-1');
    const jsonRow = await findById(jsonStore, 'parity-1');
    for (const field of B6_COLUMNS) {
      assert.deepStrictEqual(sqlRow[field], jsonRow[field], 'parity for field: ' + field);
    }
    assert.strictEqual(sqlRow.qualification, 'qualified');
    assert.deepStrictEqual(sqlRow.tags, ['VIP', 'Wholesale'], 'case-insensitive dedup, first occurrence kept, order preserved');
    assert.strictEqual(sqlRow.notes, 'Line one\nLine two', 'stored notes stay lossless');
    assert.strictEqual(rawRow(sqlStore, 'parity-1').tags, '["VIP","Wholesale"]', 'SQL stores tags as a JSON array string');
    assert.ok(Array.isArray(jsonStore._numbers[0].tags), 'JSON store keeps a native array');
  });

  test('6. empty, NULL and malformed stored B6 values normalise without throwing', async () => {
    const sqlStore = await openStore();
    const rows = [
      ['norm-empty', 'unqualified', '', ''],
      ['norm-null', null, null, null],
      ['norm-bad-tags', 'bogus-state', 'not-json', 12345],
      ['norm-json-object', 'qualified', '{"a":1}', ''],
      ['norm-json-not-array', 'qualified', '"plain"', 'ok'],
      ['norm-missing-tags', 'qualified', undefined, '']
    ];
    for (const [id, qualification, tags, notes] of rows) {
      sqlStore.db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug, qualification, tags, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [id, '+6692222' + id.length.toString().padStart(4, '0'), 'src', 'kw', 'pending',
          '2026-04-04T00:00:00.000Z', '', '', '', '', '',
          qualification === undefined ? 'qualified' : qualification,
          tags === undefined ? '["x"]' : tags,
          notes === undefined ? '' : notes]
      );
    }
    const expectations = {
      'norm-empty': { qualification: 'unqualified', tags: [], notes: '' },
      'norm-null': { qualification: 'unqualified', tags: [], notes: '' },
      // SQLite TEXT affinity coerces the numeric literal to text, so from the
      // store's point of view a non-string note can only ever arrive as NULL.
      'norm-bad-tags': { qualification: 'unqualified', tags: [], notes: '12345' },
      'norm-json-object': { qualification: 'qualified', tags: [], notes: '' },
      'norm-json-not-array': { qualification: 'qualified', tags: [], notes: 'ok' },
      'norm-missing-tags': { qualification: 'qualified', tags: ['x'], notes: '' }
    };
    for (const [id, expected] of Object.entries(expectations)) {
      const row = await findById(sqlStore, id);
      assert.ok(row, 'row survives normalisation: ' + id);
      assert.deepStrictEqual(row.qualification, expected.qualification, 'qualification for ' + id);
      assert.deepStrictEqual(row.tags, expected.tags, 'tags for ' + id);
      assert.strictEqual(row.notes, expected.notes, 'notes for ' + id);
    }
  });

  // --- 7/8/9. ownership boundary ------------------------------------------
  test('7. addNumbers cannot inject user-owned fields on either storage', async () => {
    // Fresh database: the CREATE TABLE defaults therefore back the columns, so
    // the raw bytes can be asserted too. (On a migrated database the B6
    // columns are added by ALTER TABLE and carry no SQL default; the read
    // projection still returns the same logical values - see test 3.)
    fs.rmSync(dbPath, { force: true });
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      const res = await store.addNumbers([{
        id: 'inject-1', phone: '+66933330000', source: 'src', keyword: 'kw',
        status: 'pending', collectedAt: '2026-04-05T00:00:00.000Z',
        title: 'Injected Co', website: '', email: '', address: '', runSlug: 'run-x',
        qualification: 'qualified',
        tags: ['smuggled'],
        notes: 'smuggled note'
      }]);
      assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
    }
    const sqlRow = rawRow(sqlStore, 'inject-1');
    assert.strictEqual(sqlRow.qualification, 'unqualified', 'SQL column default, payload ignored');
    assert.strictEqual(sqlRow.tags, '[]');
    assert.strictEqual(sqlRow.notes, '');
    const sqlApi = await findById(sqlStore, 'inject-1');
    assert.strictEqual(sqlApi.qualification, 'unqualified');
    assert.deepStrictEqual(sqlApi.tags, []);
    assert.strictEqual(sqlApi.notes, '');
    assert.strictEqual(sqlApi.title, 'Injected Co', 'provider fields are still stored');

    const jsonRow = jsonStore._numbers.find(r => r.id === 'inject-1');
    assert.strictEqual(jsonRow.qualification, 'unqualified', 'JSON store defaults, payload stripped');
    assert.deepStrictEqual(jsonRow.tags, []);
    assert.strictEqual(jsonRow.notes, '');
    assert.strictEqual(jsonRow.title, 'Injected Co');
  });

  test('8. re-collection of the same phone never overwrites B6 data', async () => {
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.addNumbers([{
        id: 'recol-1', phone: '+66944440000', source: 'first', keyword: 'kw',
        status: 'pending', collectedAt: '2026-04-06T00:00:00.000Z',
        title: 'Base Title', website: '', email: '', address: '', runSlug: ''
      }]);
      await store.setLeadUserFields({
        id: 'recol-1', qualification: 'qualified', tags: ['Keep'], notes: 'user note'
      });
      const again = await store.addNumbers([{
        id: 'recol-1-dup', phone: '+66 94-444-0000', source: 'second', keyword: 'kw2',
        status: 'pending', collectedAt: '2026-04-07T00:00:00.000Z',
        title: 'Filled Title', website: 'https://filled.example', email: '', address: '', runSlug: '',
        qualification: 'unqualified', tags: ['other'], notes: 'other note'
      }]);
      assert.deepStrictEqual(again, { added: 0, duplicates: 1 }, 'same canonical phone dedups');
      const row = await findById(store, 'recol-1');
      assert.strictEqual(row.qualification, 'qualified', 'qualification survives re-collection');
      assert.deepStrictEqual(row.tags, ['Keep'], 'tags survive re-collection');
      assert.strictEqual(row.notes, 'user note', 'notes survive re-collection');
      assert.strictEqual(row.source, 'first', 'provider first-writer-wins merge unchanged');
      assert.strictEqual(row.title, 'Base Title', 'existing non-empty provider field still wins');
      assert.strictEqual(row.website, 'https://filled.example', 'empty provider field still merged in');
    }
  });

  test('9. dedup never merges B6 fields from the incoming row', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'dedup-b6', phone: '+66955550000', source: 'base', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-08T00:00:00.000Z'
    }]);
    await store.setLeadUserFields({ id: 'dedup-b6', qualification: 'qualified', tags: ['A', 'b'], notes: 'mine' });
    const dup = await store.addNumbers([{
      id: 'dedup-b6-2', phone: '+66955550000', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-04-09T00:00:00.000Z',
      qualification: 'unqualified', tags: ['incoming'], notes: 'incoming note'
    }]);
    assert.deepStrictEqual(dup, { added: 0, duplicates: 1 });
    const row = await findById(store, 'dedup-b6');
    assert.strictEqual(row.qualification, 'qualified');
    assert.deepStrictEqual(row.tags, ['A', 'b']);
    assert.strictEqual(row.notes, 'mine');
  });

  // --- 10. delete rollback -------------------------------------------------
  test('10. failed persist during delete restores every B6 value exactly', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'del-b6', phone: '+66966660000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-10T00:00:00.000Z',
      title: 'Del Co', website: 'https://del.example', email: 'del@example.com',
      address: '1 Del Rd', runSlug: 'run-del'
    }]);
    await store.setLeadUserFields({
      id: 'del-b6', qualification: 'qualified', tags: ['Keep', 'me'], notes: 'note to restore'
    });
    const before = JSON.parse(JSON.stringify(await findById(store, 'del-b6')));

    const realSave = store.saveDB;
    store.saveDB = () => { throw new Error('injected persist failure'); };
    let thrown = null;
    try {
      await store.deleteNumbers(['del-b6']);
    } catch (err) {
      thrown = err;
    }
    store.saveDB = realSave;
    assert.ok(thrown, 'persist error must be rethrown');
    assert.strictEqual(thrown.message, 'injected persist failure');

    const after = await findById(store, 'del-b6');
    assert.ok(after, 'removed row must be restored');
    assert.deepStrictEqual(after, before, 'all 14 fields restored, B6 included');
    assert.strictEqual(rawRow(store, 'del-b6').tags, '["Keep","me"]', 'tag text restored exactly');
  });

  // --- 11/12. write success ------------------------------------------------
  test('11. setLeadUserFields updates the three B6 fields on SQL storage', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'write-sql', phone: '+66977770000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-11T00:00:00.000Z'
    }]);
    const res = await store.setLeadUserFields({
      id: 'write-sql', qualification: 'qualified', tags: [' Alpha ', 'alpha', 'Beta'], notes: 'hello'
    });
    assert.deepStrictEqual(res, { success: true, updated: true });
    const row = await findById(store, 'write-sql');
    assert.strictEqual(row.qualification, 'qualified');
    assert.deepStrictEqual(row.tags, ['Alpha', 'Beta'], 'trimmed and case-deduplicated');
    assert.strictEqual(row.notes, 'hello');
    const unchanged = await store.setLeadUserFields({
      id: 'write-sql', qualification: 'qualified', tags: ['Alpha', 'Beta'], notes: 'hello'
    });
    assert.deepStrictEqual(unchanged, { success: true, updated: false, reason: 'unchanged' },
      'an identical save never persists');
    const missing = await store.setLeadUserFields({
      id: 'no-such-lead', qualification: 'qualified', tags: [], notes: ''
    });
    assert.deepStrictEqual(missing, { success: true, updated: false, reason: 'not-found' });
  });

  test('12. setLeadUserFields updates the three B6 fields on JSON storage', async () => {
    const store = await openJsonStore();
    await store.addNumbers([{
      id: 'write-json', phone: '+66988880000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-12T00:00:00.000Z'
    }]);
    const res = await store.setLeadUserFields({
      id: 'write-json', qualification: 'qualified', tags: ['Gamma', 'gamma', 'Delta'], notes: 'json note'
    });
    assert.deepStrictEqual(res, { success: true, updated: true });
    const persisted = readJsonFile().find(r => r.id === 'write-json');
    assert.strictEqual(persisted.qualification, 'qualified');
    assert.deepStrictEqual(persisted.tags, ['Gamma', 'Delta'], 'persisted as a native array');
    assert.strictEqual(persisted.notes, 'json note');
    const row = await findById(store, 'write-json');
    assert.deepStrictEqual(row.tags, ['Gamma', 'Delta'], 'read back identically');
    const unchanged = await store.setLeadUserFields({
      id: 'write-json', qualification: 'qualified', tags: ['Gamma', 'Delta'], notes: 'json note'
    });
    assert.deepStrictEqual(unchanged, { success: true, updated: false, reason: 'unchanged' });
    const missing = await store.setLeadUserFields({
      id: 'no-such-lead', qualification: 'unqualified', tags: [], notes: ''
    });
    assert.deepStrictEqual(missing, { success: true, updated: false, reason: 'not-found' });
  });

  // --- 13/14. write rollback ----------------------------------------------
  test('13. failed persist during a B6 write restores the prior SQL values', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'rb-write-sql', phone: '+66999990000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-13T00:00:00.000Z'
    }]);
    await store.setLeadUserFields({
      id: 'rb-write-sql', qualification: 'qualified', tags: ['Before'], notes: 'before note'
    });
    const before = JSON.parse(JSON.stringify(await findById(store, 'rb-write-sql')));
    const realSave = store.saveDB;
    store.saveDB = () => { throw new Error('injected persist failure'); };
    let thrown = null;
    try {
      await store.setLeadUserFields({
        id: 'rb-write-sql', qualification: 'unqualified', tags: ['After'], notes: 'after note'
      });
    } catch (err) {
      thrown = err;
    }
    store.saveDB = realSave;
    assert.ok(thrown, 'persist error must be rethrown');
    assert.strictEqual(thrown.message, 'injected persist failure');
    const after = await findById(store, 'rb-write-sql');
    assert.deepStrictEqual(after, before, 'in-database and reverted values match the prior state');
  });

  test('14. failed write during a B6 JSON update restores the prior values', async () => {
    const store = await openJsonStore();
    await store.addNumbers([{
      id: 'rb-write-json', phone: '+66100000000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-14T00:00:00.000Z'
    }]);
    await store.setLeadUserFields({
      id: 'rb-write-json', qualification: 'qualified', tags: ['Before'], notes: 'before note'
    });
    const before = JSON.parse(JSON.stringify(store._numbers.find(r => r.id === 'rb-write-json')));
    // Fault injection without patching production code: a self-reference makes
    // the atomic write's JSON.stringify throw inside the guarded region.
    store._numbers[0].__self = store._numbers[0];
    let thrown = null;
    try {
      await store.setLeadUserFields({
        id: 'rb-write-json', qualification: 'unqualified', tags: ['After'], notes: 'after note'
      });
    } catch (err) {
      thrown = err;
    }
    delete store._numbers[0].__self;
    assert.ok(thrown, 'write error must be rethrown');
    const after = store._numbers.find(r => r.id === 'rb-write-json');
    assert.deepStrictEqual(after, before, 'in-memory row restored to the prior state');
    const persisted = readJsonFile().find(r => r.id === 'rb-write-json');
    assert.strictEqual(persisted.qualification, 'qualified', 'on-disk row untouched');
    assert.deepStrictEqual(persisted.tags, ['Before']);
    assert.strictEqual(persisted.notes, 'before note');
  });

  // --- contract guards ----------------------------------------------------
  test('15. the B6 write path never logs tag or note content', async () => {
    const region = storeSource.slice(
      storeSource.indexOf('  // === B6 user-owned lead fields ==='),
      storeSource.indexOf('  async exportNumbers(')
    );
    assert.ok(region.length > 0, 'B6 write region located');
    assert.ok(!/logger\.[a-z]+\([^)]*(notes|tags)\s*[:,)]/i.test(region),
      'no logger call may carry notes/tags content');
    const logged = logRecords.filter(r => r.message === 'lead user fields updated');
    assert.ok(logged.length > 0, 'the B6 write is logged');
    for (const record of logged) {
      assert.deepStrictEqual(Object.keys(record.data).sort(), ['leadId', 'storage', 'updated'],
        'only the lead id, storage and outcome are logged');
    }
  });

  test('16. B6 fields stay out of the provider merge and insert surface', () => {
    const mergeFn = storeSource.slice(
      storeSource.indexOf('function mergeEmptyLeadFields('),
      storeSource.indexOf('function writeJsonAtomic(')
    );
    assert.ok(mergeFn.includes("['source', 'keyword', 'status', 'collectedAt', ...LEAD_NEW_FIELDS]"),
      'merge field list unchanged');
    for (const field of B6_COLUMNS) {
      assert.ok(!mergeFn.includes(field), 'B6 field absent from the merge list: ' + field);
    }
    const providerInsert = storeSource.slice(
      storeSource.indexOf("'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title"),
      storeSource.indexOf('byPhone.set(key, row)')
    );
    assert.ok(providerInsert.includes('runSlug) VALUES'), 'provider insert still covers 11 columns');
    for (const field of B6_COLUMNS) {
      assert.ok(!providerInsert.includes(field), 'B6 field absent from the provider insert: ' + field);
    }
  });

  test('17. store guard rejects out-of-contract user-owned payloads', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'guard-1', phone: '+66110000000', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-04-15T00:00:00.000Z'
    }]);
    const base = { id: 'guard-1', qualification: 'qualified', tags: [], notes: '' };
    const rejects = [
      { ...base, qualification: 'QUALIFIED' },
      { ...base, qualification: '' },
      { ...base, qualification: null },
      { ...base, id: '' },
      { ...base, id: 'x'.repeat(101) },
      { ...base, tags: 'not-an-array' },
      { ...base, tags: ['ok', ''] },
      { ...base, tags: ['ok', '   '] },
      { ...base, tags: ['x'.repeat(51)] },
      { ...base, tags: new Array(21).fill('tag') },
      { ...base, tags: [42] },
      { ...base, notes: 123 },
      { ...base, notes: 'n'.repeat(5001) }
    ];
    for (const payload of rejects) {
      const res = await store.setLeadUserFields(payload);
      assert.strictEqual(res.success, false, 'payload must be refused: ' + JSON.stringify(payload).slice(0, 60));
      assert.ok(typeof res.error === 'string' && res.error.length > 0, 'a reason is returned');
    }
    const row = await findById(store, 'guard-1');
    assert.strictEqual(row.qualification, 'unqualified', 'no rejected payload changed storage');
    assert.deepStrictEqual(row.tags, []);
    assert.strictEqual(row.notes, '');
    const accepted = await store.setLeadUserFields({ ...base, notes: 'n'.repeat(5000) });
    assert.deepStrictEqual(accepted, { success: true, updated: true }, 'exactly 5000 chars is accepted');
    const nonObject = await store.setLeadUserFields('garbage');
    assert.strictEqual(nonObject.success, false, 'non-object payload refused');
  });

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
