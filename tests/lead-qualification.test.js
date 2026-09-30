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
const P1C_COLUMNS = ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus'];

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
  test('1. fresh database is created with the 15-column lead schema', async () => {
    fs.rmSync(dbPath, { force: true });
    const fresh = await openStore();
    const columns = schemaColumns(fresh.db);
    assert.deepStrictEqual(columns, [
      'id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug',
      'qualification', 'tags', 'notes',
      'phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus',
      // P1-D: the nullable system pointer. companyKey is derived on read and
      // is therefore not a column, and no companies table exists.
      'companyId'
    ], 'exactly the 11 B1, 3 B6, 4 P1-C and 1 P1-D column, in order');
    assert.strictEqual(migrateSchema(fresh.db), 0, 'fresh schema needs no migration');
  });

  // --- 2/3. legacy migration ----------------------------------------------
  test('2. legacy 6-column database gains all nine missing columns', async () => {
    await seedLegacySixColumnDb();
    const store = await openStore();
    assert.deepStrictEqual(schemaColumns(store.db), [
      'id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug',
      'qualification', 'tags', 'notes',
      'phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus',
      'companyId'
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

  // === B6.2 main-process validation and IPC surface ===
  // The B6.2 contract is a main-process contract, so the validator is
  // extracted from main.js and executed here for real, and the handler
  // registration, preload exposure and channel count are asserted against the
  // actual sources. Storage behaviour is proven separately in the B6.1 block.

  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const providerSource =
    fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'providerManager.js'), 'utf8') +
    fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'collectionProvider.js'), 'utf8') +
    fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'coreclawAdapter.js'), 'utf8');

  function between(source, start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
    return source.slice(from, to);
  }

  function mainChannels() {
    return [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
  }

  // A4: the seven research channels live in src/main/prospect-research/research-ipc.js,
  // so a main.js scan alone no longer sees the complete set.
  function researchChannels() {
    const src = fs.readFileSync(path.join(root, 'src', 'main', 'prospect-research', 'research-ipc.js'), 'utf8');
    return [...src.matchAll(/ipcMain\.handle\(CHANNELS\.(\w+)/g)]
      .map(m => `prospect-research:${m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`);
  }

  // A10: the five approved Lead Intelligence channels live in their own narrowly
  // scoped registrar (src/main/lead-intelligence/outreach-ipc.js), so a main.js
  // scan alone does not see them either.
  function leadIntelChannels() {
    const src = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach-ipc.js'), 'utf8');
    return [...src.matchAll(/'(lead-intel:[a-z-]+)'/g)].map(m => m[1]);
  }

  function allChannels() {
    return [...mainChannels(), ...researchChannels(), ...leadIntelChannels()];
  }

  // Loads the real validator out of main.js together with the guards it uses
  // (invalidParams, assertPlainObject), so the tests exercise production code
  // rather than a copy of it.
  function loadValidator() {
    const slice = between(mainSource, 'function invalidParams(', 'function validateHistoryPaging(');
    const factory = new Function('logger', slice + '\nreturn validateLeadUpdatePayload;');
    return factory({ warn() {}, info() {}, error() {}, ok() {} });
  }

  const validateLeadUpdatePayload = loadValidator();

  function expectInvalid(payload) {
    let err = null;
    try {
      validateLeadUpdatePayload(payload);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'payload must be refused: ' + JSON.stringify(payload));
    assert.strictEqual(err.invalidParams, true, 'refusal must carry invalidParams for rejectLog');
    return err;
  }

  const VALID = { id: 'lead-b6-2', qualification: 'qualified', tags: ['VIP'], notes: 'note' };

  test('18. valid qualified and unqualified payloads are accepted and normalised', () => {
    assert.deepStrictEqual(validateLeadUpdatePayload({ ...VALID }), {
      id: 'lead-b6-2', qualification: 'qualified', tags: ['VIP'], notes: 'note'
    });
    const unqualified = validateLeadUpdatePayload({
      id: 'lead-b6-2', qualification: 'unqualified', tags: [], notes: ''
    });
    assert.deepStrictEqual(unqualified, {
      id: 'lead-b6-2', qualification: 'unqualified', tags: [], notes: ''
    });
  });

  test('19. qualification must be exactly unqualified or qualified', () => {
    for (const bad of ['QUALIFIED', 'Qualified', 'scored', 'pending', '', null, undefined, 1, true, {}, []]) {
      expectInvalid({ ...VALID, qualification: bad });
    }
    expectInvalid({ id: 'lead-b6-2', tags: [], notes: '' });
  });

  test('20. id must be a non-empty string of at most 100 characters', () => {
    for (const bad of ['', null, undefined, 42, {}, [], 'x'.repeat(101)]) {
      expectInvalid({ ...VALID, id: bad });
    }
    expectInvalid({ qualification: 'qualified', tags: [], notes: '' });
    const boundary = validateLeadUpdatePayload({ ...VALID, id: 'x'.repeat(100) });
    assert.strictEqual(boundary.id.length, 100, 'exactly 100 characters is accepted');
  });

  test('21. tags must be an array of at most 20 strings of at most 50 characters', () => {
    const distinct = (count) => Array.from({ length: count }, (_, i) => 'tag' + i);
    for (const bad of ['not-an-array', null, undefined, 42, {}, new Set(['a'])]) {
      expectInvalid({ ...VALID, tags: bad });
    }
    expectInvalid({ ...VALID, tags: distinct(21) });
    const atLimit = validateLeadUpdatePayload({ ...VALID, tags: distinct(20) });
    assert.strictEqual(atLimit.tags.length, 20, 'exactly 20 distinct tags is accepted');
    expectInvalid({ ...VALID, tags: ['ok', 42] });
    expectInvalid({ ...VALID, tags: ['ok', '   '] });
    expectInvalid({ ...VALID, tags: ['', 'ok'] });
    expectInvalid({ ...VALID, tags: ['x'.repeat(51)] });
    const atTagLimit = validateLeadUpdatePayload({ ...VALID, tags: ['y'.repeat(50)] });
    assert.strictEqual(atTagLimit.tags[0].length, 50, 'exactly 50 characters is accepted');
  });

  test('22. tags are trimmed and deduplicated case-insensitively, first occurrence wins', () => {
    const out = validateLeadUpdatePayload({
      ...VALID,
      tags: ['  Alpha  ', 'alpha', 'ALPHA', 'Beta', ' beta ', 'Gamma']
    });
    assert.deepStrictEqual(out.tags, ['Alpha', 'Beta', 'Gamma'],
      'trimmed, case-insensitively deduplicated, original order preserved');
  });

  test('23. notes must be a string of at most 5000 characters and is never coerced', () => {
    for (const bad of [null, undefined, 42, true, {}, ['note'], new String('x')]) {
      expectInvalid({ ...VALID, notes: bad });
    }
    expectInvalid({ ...VALID, notes: 'n'.repeat(5001) });
    const boundary = validateLeadUpdatePayload({ ...VALID, notes: 'n'.repeat(5000) });
    assert.strictEqual(boundary.notes.length, 5000, 'exactly 5000 characters is accepted');
    const multiline = validateLeadUpdatePayload({ ...VALID, notes: 'line one\nline two' });
    assert.strictEqual(multiline.notes, 'line one\nline two', 'newlines preserved verbatim');
  });

  test('24. the payload must be a plain object', () => {
    for (const bad of [null, undefined, 'garbage', 42, [], true]) {
      expectInvalid(bad);
    }
  });

  test('25. the handler delegates the validated payload to the B6.1 store method', () => {
    const handler = between(mainSource, "ipcMain.handle('collector:update-lead'", '  });\n');
    assert.ok(handler.includes('validateLeadUpdatePayload(payload)'),
      'handler validates before touching the store');
    assert.ok(handler.includes('accountStore.setLeadUserFields('),
      'handler delegates to the existing B6.1 store method');
    assert.ok(handler.includes("if (err.invalidParams) rejectLog('collector:update-lead', err.message);"),
      'invalid params are logged through rejectLog');
    assert.ok(handler.includes('throw err'), 'refusals propagate to the renderer');
    const storeSlice = between(storeSource, 'async setLeadUserFields(payload)', '  _findLeadSql(id) {');
    assert.ok(!storeSlice.includes('status'), 'the B6 store method never touches the status column');
  });

  test('26. exactly 33 IPC channels exist and the user-owned writes are registered once', () => {
    const channels = allChannels();
    // P1-E declared lock update: 20 -> 21, the single addition being the
    // read-only collector:duplicate-review. Both user-owned writes are still
    // registered exactly once.
    // A4 declared lock update: 26 -> 33, the seven additions being the
    // prospect-research channels, all sender-checked and none user-owned writes.
    // F6 declared lock update: 33 -> 40, the seven sender-checked Lists channels.
    // F7 declared lock update: 40 -> 41, the read-only prospect-research:list channel.
    // F8 declared lock update: 41 -> 42, intelligence:icp.
    // F12 Batch 2 declared lock update: 47 -> 48, the six approved Lead Intelligence
    // channels (3 pitch + outreach approve/gate). No email-send channel exists.
    assert.strictEqual(channels.length, 48, 'exactly 48 channels');
    assert.strictEqual(new Set(channels).size, 48, 'no duplicate channel names');
    const occurrences = mainSource.split("ipcMain.handle('collector:update-lead'").length - 1;
    assert.strictEqual(occurrences, 1, 'collector:update-lead registered exactly once');
    assert.ok(channels.includes('collector:update-lead'), 'the B6 write channel is registered');
    for (const ch of ['collector:get-numbers', 'collector:add-numbers', 'collector:export-numbers',
      'collector:delete-numbers', 'collector:storage-status', 'collector:get-jobs']) {
      assert.ok(channels.includes(ch), 'pre-existing collector channel intact: ' + ch);
    }
  });

  test('27. preload exposes collector.updateLead and nothing else new', () => {
    assert.ok(preloadSource.includes(
      "updateLead: (payload) => ipcRenderer.invoke('collector:update-lead', payload)"),
      'preload exposes updateLead on the collector namespace');
    const invocations = [...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]);
    assert.strictEqual(invocations.filter(ch => ch === 'collector:update-lead').length, 1,
      'the channel is invoked exactly once');
    assert.deepStrictEqual(
      [...new Set(invocations)].sort(),
      allChannels().filter(ch => ch !== 'provider:set-credentials').sort(),
      'preload channel set matches main plus the research module (provider:set-credentials stays unexposed)'
    );
    assert.ok(!preloadSource.includes('setLeadUserFields'), 'preload stays store-agnostic');
    assert.ok(!preloadSource.includes('queryJobs'), 'preload never leaks store internals');
    assert.ok(!/exposeInMainWorld\([^)]{0,80}ipcRenderer/.test(preloadSource),
      'ipcRenderer is never exposed directly');
  });

  test('28. the B6 write surface leaks no credentials and no raw channel name', () => {
    const validator = between(mainSource, 'function validateLeadUpdatePayload(', 'function validateHistoryPaging(');
    const handler = between(mainSource, "ipcMain.handle('collector:update-lead'", '  });\n');
    const preload = between(preloadSource, 'updateLead:', '  },');
    for (const [name, region] of [['validator', validator], ['handler', handler], ['preload', preload]]) {
      assert.ok(!/apiKey|taskKey|credentials|Bearer|authorization/i.test(region),
        'no credential surface in the B6 ' + name);
    }
    assert.ok(!/logger\.[a-z]+\([^)]*(notes|tags)\s*[:,)]/i.test(validator),
      'the validator never logs notes or tags content');
    assert.ok(!rendererSource.includes('collector:update-lead'),
      'the renderer never references the raw channel name (B6.3 will use the preload API)');
    assert.ok(!rendererSource.includes('setLeadUserFields'),
      'the renderer never sees the store method');
  });

  test('29. provider neutrality: no provider surface in the B6 write path', () => {
    const handler = between(mainSource, "ipcMain.handle('collector:update-lead'", '  });\n');
    const validator = between(mainSource, 'function validateLeadUpdatePayload(', 'function validateHistoryPaging(');
    assert.ok(!/providerId|providerManager|CoreClaw|coreclaw/.test(handler),
      'the B6 handler references no provider identifier');
    assert.ok(!/providerId|providerManager|CoreClaw|coreclaw/.test(validator),
      'the B6 validator references no provider identifier');
    assert.ok(!/qualification|tags|notes|setLeadUserFields/.test(providerSource),
      'provider sources carry no B6 code');
    const queryBlock = storeSource.slice(
      storeSource.indexOf('// B2 query layer: server-side search'),
      storeSource.indexOf('async addNumbers(')
    );
    assert.ok(!/qualification/.test(queryBlock),
      'the B2 query layer is untouched by B6.1/B6.2 (filtering arrives in B6.4)');
  });

  // === B6.3 Lead Profile UI ===
  // The renderer cannot be executed in this harness, so the B6.3 contract is
  // asserted against the real renderer source and the shipped markup: the form
  // exists, is populated from the existing single-lead read, writes only
  // through the preload API, and never autosaves or leaks content.

  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

  const b6Start = rendererSource.indexOf('// === B6 Lead Profile: user-owned qualification');
  const b6End = rendererSource.indexOf("document.getElementById('btn-delete-selected')");
  const b6Region = between(rendererSource, '// === B6 Lead Profile:', "getElementById('btn-delete-selected')");
  const b6Save = between(b6Region, 'async function saveLeadDetail()', "getElementById('btn-save-lead-detail').addEventListener");
  const b6Tags = between(b6Region, 'function addLeadDetailTag()', 'function populateLeadDetailB6(');

  test('30. the Lead Profile exposes the B6 form with English labels and no table columns', () => {
    assert.ok(b6Start > -1 && b6End > b6Start, 'B6 renderer block located');
    for (const id of ['lead-detail-b6', 'lead-detail-qualification', 'lead-detail-tag-list',
      'lead-detail-tag-input', 'btn-lead-detail-add-tag', 'lead-detail-notes', 'btn-save-lead-detail']) {
      assert.ok(htmlSource.includes('id="' + id + '"'), 'markup present: ' + id);
    }
    assert.ok(/id="lead-detail-b6" hidden/.test(htmlSource), 'the form starts hidden until a lead loads');
    assert.ok(htmlSource.includes('<option value="unqualified">Unqualified</option>'), 'Unqualified option');
    assert.ok(htmlSource.includes('<option value="qualified">Qualified</option>'), 'Qualified option');
    assert.ok(htmlSource.includes('>Add tag</button>'), 'English add-tag label');
    assert.ok(htmlSource.includes('>Save</button>'), 'English save label');
    assert.ok(htmlSource.includes('>Notes</label>'), 'English notes label');
    assert.ok(htmlSource.includes('>Tags</label>'), 'English tags label');
    assert.ok(htmlSource.includes('>Qualification</label>'), 'English qualification label');
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
    for (const column of ['<th>Qualification</th>', '<th>Tags</th>', '<th>Notes</th>']) {
      assert.ok(!table.includes(column), 'no B6 column in the Lead Library table: ' + column);
    }
  });

  test('31. the form is populated from the existing single-lead read path', () => {
    const openRegion = between(rendererSource, 'async function openLeadDetail', 'function closeLeadDetail');
    assert.ok(openRegion.includes("getNumbers({ limit: 1, offset: 0, id })"),
      'B3 single-lead read unchanged - no second read architecture');
    assert.ok(openRegion.includes('populateLeadDetailB6(lead)'), 'load populates the B6 form');
    const populate = between(b6Region, 'function populateLeadDetailB6(', 'async function saveLeadDetail()');
    assert.ok(populate.includes("row.qualification === 'qualified'"), 'qualification read from the lead');
    assert.ok(populate.includes('Array.isArray(row.tags)'), 'tags read defensively from the lead');
    assert.ok(populate.includes("typeof row.notes === 'string'"), 'notes read defensively from the lead');
    assert.ok(populate.includes('region.hidden = !leadDetailContext.id'), 'form only shown for a real lead');
    assert.ok(!/getNumbers|queryNumbers|updateLead/.test(b6Tags), 'the tag editor performs no I/O');
  });

  test('32. save sends only the four contract fields through the preload API', () => {
    assert.ok(b6Save.includes('window.appAPI.collector.updateLead({'), 'save uses the preload API');
    assert.ok(b6Save.includes('id,'), 'sends id');
    assert.ok(b6Save.includes('qualification:'), 'sends qualification');
    assert.ok(b6Save.includes('tags: leadDetailContext.tags.slice()'), 'sends a copy of the tags');
    assert.ok(b6Save.includes('notes: noteValue'), 'sends notes');
    const payload = b6Save.slice(
      b6Save.indexOf('window.appAPI.collector.updateLead({'),
      b6Save.indexOf('});', b6Save.indexOf('window.appAPI.collector.updateLead({'))
    );
    for (const forbidden of ['phone', 'title', 'email', 'address', 'runSlug', 'status', 'source',
      'keyword', 'collectedAt', 'providerId', 'apiKey', 'taskKey', 'credentials']) {
      assert.ok(!payload.includes(forbidden), 'the B6 save must not send: ' + forbidden);
    }
    assert.ok(!rendererSource.includes('collector:update-lead'), 'no raw channel name in the renderer');
    assert.ok(!b6Region.includes('queryJobs'), 'no store internals in the renderer');
  });

  test('33. no autosave: the form only writes from the Save control', () => {
    assert.strictEqual(b6Save.split('appAPI.collector.updateLead').length - 1, 1,
      'exactly one update call site');
    const writeCallers = between(b6Region, 'async function saveLeadDetail()', "getElementById('lead-detail-tag-list').addEventListener");
    assert.ok(!/addEventListener\('(input|change)'/.test(writeCallers),
      'no input/change listener can trigger a save');
    for (const hook of ['setInterval', 'setTimeout', 'requestAnimationFrame']) {
      assert.ok(!b6Region.includes(hook), 'no ' + hook + ' in the B6 renderer block');
    }
    assert.ok(rendererSource.includes(
      "getElementById('btn-save-lead-detail').addEventListener('click', safeAsync(() => saveLeadDetail()))"),
      'the Save button is the only save trigger');
    assert.ok(b6Save.includes('if (leadDetailSaveInFlight) return;'), 'duplicate submits are refused');
    assert.ok(b6Save.includes('setLeadDetailControlsEnabled(false)'), 'controls disabled while saving');
    assert.ok(b6Save.includes('leadDetailSaveInFlight = false;'), 'in-flight flag always cleared');
  });

  test('34. a failed save preserves the user input and reports through the existing UI', () => {
    assert.ok(b6Save.includes('if (seq !== detailLoadSeq) return;'),
      'a stale save result is discarded after a close/reopen');
    assert.ok(b6Save.includes("toast(msg, 'error')"), 'failures surface through toast');
    assert.ok(b6Save.includes("reportError(msg, { handler: 'saveLeadDetail' })"),
      'failures are reported through reportError');
    const catchBlock = b6Save.slice(b6Save.indexOf('} catch (err) {'));
    for (const forbidden of ['populateLeadDetailB6(', 'closeLeadDetail(', ".value = ''"]) {
      assert.ok(!catchBlock.includes(forbidden), 'the failure path must not touch the form: ' + forbidden);
    }
    assert.ok(b6Save.includes('if (result && result.success === false)'),
      'a store-level refusal is reported, not swallowed');
    assert.ok(b6Save.includes("result.reason === 'unchanged'"), 'the unchanged response is handled');
  });

  test('35. tag editing enforces the contract client-side and escapes every value', () => {
    assert.ok(b6Tags.includes("input.value.trim()"), 'tags are trimmed before use');
    assert.ok(b6Tags.includes('if (!tag)'), 'empty tags refused');
    assert.ok(b6Tags.includes('tag.length > LEAD_TAG_MAX_LENGTH'), '50-character bound enforced');
    assert.ok(b6Tags.includes('leadDetailContext.tags.length >= LEAD_TAG_MAX'), '20-tag bound enforced');
    assert.ok(b6Tags.includes("existing.toLowerCase() === key"), 'case-insensitive duplicate detection');
    const render = between(b6Region, 'function renderLeadDetailTags()', 'function addLeadDetailTag()');
    assert.ok(render.includes('escapeHtml(tag)'), 'rendered tag text is escaped');
    assert.ok(render.includes('data-tag-index'), 'the remove control carries an index, not tag text');
    assert.ok(!render.includes('data-tag-text'), 'tag text is never placed in an attribute');
    const notesInput = between(htmlSource, 'id="lead-detail-notes"', '</textarea>');
    assert.ok(notesInput.includes('maxlength="5000"'), 'notes input is bounded at 5000 characters');
    assert.ok(htmlSource.includes('maxlength="50"'), 'tag input is bounded at 50 characters');
  });

  test('36. the B6 form adds no provider, credential, dashboard or B6.4 surface', () => {
    for (const forbidden of ['providerId', 'providerManager', 'apiKey', 'taskKey', 'credentials', 'Bearer',
      'collection.submit', 'dashboard', 'GROUP BY', 'exportNumbers', 'renderNumbers(', 'numbersQueryPayload']) {
      assert.ok(!b6Region.includes(forbidden), 'the B6 renderer block must not reference: ' + forbidden);
    }
    assert.ok(!b6Region.includes('lead-detail-filters'), 'no B6 filtering in this batch');
    assert.ok(!b6Region.includes('run_slug'), 'no CSV export work in this batch');
    assert.ok(!/lead-detail-b6[^{]*\{[^}]*display:\s*flex[^}]*\}\s*\.dashboard/.test(cssSource),
      'dashboard layout untouched');
    const b6StyleStart = cssSource.indexOf('/* Lead Profile B6 user-owned fields');
    assert.ok(b6StyleStart > -1, 'B6 style block located');
    const b6Styles = cssSource.slice(b6StyleStart);
    for (const selector of ['.lead-detail-b6', '.lead-tag-list', '.lead-tag', '.lead-tag-remove', '.lead-tag-add']) {
      assert.ok(b6Styles.includes(selector), 'expected B6 selector: ' + selector);
    }
    assert.ok(!b6Styles.includes('@import') && !/url\(/i.test(b6Styles), 'no new imports or external resources');
    assert.ok(cssSource.includes("frame-src 'none'") || htmlSource.includes("frame-src 'none'"),
      'CSP frame-src canary intact');
  });

  // === B6.4.1 startup NULL repair and CSV export ===
  // A row inserted after the B6.1 ALTER TABLE migration stores NULL for the
  // three user-owned columns (SQLite cannot attach a default that way), so
  // initDB repairs the bytes once. The repair is proven here against real
  // databases, including the per-column safety property and idempotency.

  async function seedMigratedDbWithNullB6() {
    const initSQL = require('sql.js');
    const SQL = await initSQL();
    const db = new SQL.Database();
    db.run(`CREATE TABLE numbers (
      id TEXT PRIMARY KEY, phone TEXT, source TEXT, keyword TEXT,
      status TEXT DEFAULT 'pending', collectedAt TEXT
    )`);
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
    // First open migrates the schema; rows added afterwards inherit NULL B6
    // columns because the provider INSERT is limited to the 11 B1 columns.
    const first = await openStore();
    await first.addNumbers([{
      id: 'null-b6', phone: '+66170000001', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-05-01T00:00:00.000Z', title: 'Keep Me'
    }]);
    return first;
  }

  test('37. initDB repairs NULL user-owned bytes on the next startup', async () => {
    fs.rmSync(dbPath, { force: true });
    const first = await seedMigratedDbWithNullB6();
    const beforeRepair = rawRow(first, 'null-b6');
    assert.strictEqual(beforeRepair.qualification, null, 'precondition: NULL qualification stored');
    assert.strictEqual(beforeRepair.tags, null, 'precondition: NULL tags stored');
    assert.strictEqual(beforeRepair.notes, null, 'precondition: NULL notes stored');

    const second = await openStore();
    const afterRepair = rawRow(second, 'null-b6');
    assert.strictEqual(afterRepair.qualification, 'unqualified', 'NULL qualification repaired');
    assert.strictEqual(afterRepair.tags, '[]', 'NULL tags repaired to an empty array');
    assert.strictEqual(afterRepair.notes, '', 'NULL notes repaired to an empty string');
    const row = await findById(second, 'null-b6');
    assert.strictEqual(row.title, 'Keep Me', 'unrelated B1 fields untouched by the repair');
    assert.strictEqual(row.source, 'src', 'unrelated source untouched');
    assert.strictEqual(row.status, 'pending', 'unrelated status untouched');
    assert.strictEqual(row.phone, '+66170000001', 'unrelated phone untouched');
  });

  test('38. the repair preserves non-NULL user values and is idempotent', async () => {
    fs.rmSync(dbPath, { force: true });
    const first = await seedMigratedDbWithNullB6();
    // Set real user values on a row, then wipe only one column directly in SQL
    // to model a partially-NULL row: the other two must survive untouched.
    first.db.run(
      "UPDATE numbers SET qualification = 'qualified', tags = '[\"Keep\"]', notes = 'kept note' WHERE id = 'null-b6'"
    );
    first.db.run("UPDATE numbers SET notes = NULL WHERE id = 'null-b6'");
    first.saveDB();

    const second = await openStore();
    const repaired = rawRow(second, 'null-b6');
    assert.strictEqual(repaired.notes, '', 'the NULL column is repaired');
    assert.strictEqual(repaired.qualification, 'qualified',
      'a non-NULL qualification is never rewritten by the repair of another column');
    assert.strictEqual(repaired.tags, '["Keep"]', 'non-NULL tags survive the repair');

    const bytesBefore = Buffer.from(second.db.export());
    const third = await openStore();
    assert.ok(bytesBefore.equals(Buffer.from(third.db.export())),
      'a second startup changes nothing: the repair is idempotent');
    assert.strictEqual(rawRow(third, 'null-b6').qualification, 'qualified',
      'still qualified after repeated startups');
  });

  test('39. CSV export appends the B6 columns with the approved representation', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'csv-b6', phone: '+66170000002', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-05-02T00:00:00.000Z'
    }]);
    await store.setLeadUserFields({
      id: 'csv-b6', qualification: 'qualified', tags: ['Alpha', 'Beta'],
      notes: 'line one\nline two'
    });
    const csv = await store.exportNumbers('csv');
    const lines = csv.split('\n');
    assert.strictEqual(lines[0],
      'phone,source,keyword,status,collected_at,title,website,email,address,run_slug,qualification,tags,notes,phone_status,email_status,website_status,business_status',
      'exact 17-column header');
    assert.strictEqual(lines[1].split('","').length, 17, 'exactly 17 CSV fields per row');
    assert.ok(csv.includes('"qualified"'), 'qualification mapped');
    assert.ok(csv.includes('"Alpha;Beta"'), 'tags joined with ;');
    assert.ok(csv.includes('"line one line two"'), 'notes collapsed for CSV only');
    assert.ok(!csv.includes('line one\nline two'), 'no raw newline survives inside a CSV field');
    const stored = (await store.getCollectedNumbers()).find(r => r.id === 'csv-b6');
    assert.strictEqual(stored.notes, 'line one\nline two', 'stored note remains lossless');
    const jsonRow = JSON.parse(await store.exportNumbers('json')).find(r => r.id === 'csv-b6');
    assert.deepStrictEqual(jsonRow.tags, ['Alpha', 'Beta'], 'JSON tags stay a native array');
    assert.strictEqual(jsonRow.notes, 'line one\nline two', 'JSON notes stay verbatim');
  });

  test('40. a NULL-origin lead exports as the documented defaults in both formats', async () => {
    fs.rmSync(dbPath, { force: true });
    await seedMigratedDbWithNullB6();
    const store = await openStore();
    const row = await findById(store, 'null-b6');
    assert.strictEqual(row.qualification, 'unqualified');
    assert.deepStrictEqual(row.tags, []);
    assert.strictEqual(row.notes, '');
    const csvLine = (await store.exportNumbers('csv')).split('\n')[1];
    assert.ok(csvLine.endsWith('"unqualified","","","unknown","unknown","unknown","unknown"'),
      'CSV shows the defaults for a repaired row, statuses included');
    const jsonRow = JSON.parse(await store.exportNumbers('json')).find(r => r.id === 'null-b6');
    assert.strictEqual(jsonRow.qualification, 'unqualified');
    assert.deepStrictEqual(jsonRow.tags, []);
    assert.strictEqual(jsonRow.notes, '');
  });

  test('41. the repair is scoped to the B6 columns and never logs field values', () => {
    const repair = between(storeSource, 'function repairLeadUserFields(db) {', '// Map a positional SELECT row');
    // Coverage of the three columns comes from the shared B6 literal, not from
    // three hand-written statements, so the two lists can never diverge.
    assert.ok(repair.includes('for (const field of LEAD_USER_OWNED_FIELDS)'),
      'iterates every user-owned field list (B6 and P1-C)');
    assert.ok(repair.includes('LEAD_B6_DEFAULTS[field]'), 'writes the shared B6 defaults');
    for (const forbidden of ['status', 'phone', 'source', 'keyword', 'collectedAt', 'title', 'website',
      'email', 'address', 'runSlug']) {
      assert.ok(!repair.includes(forbidden), 'repair must not touch column: ' + forbidden);
    }
    assert.ok(repair.includes('WHERE ${field} IS NULL'), 'per-column NULL predicate only');
    assert.ok(!/logger\./.test(repair), 'the repair logs nothing itself');
    const initRegion = between(storeSource, 'const migratedColumns = migrateSchema(this.db);', 'this.migrateJsonData();');
    assert.ok(initRegion.includes('repairLeadUserFields(this.db)'), 'repair runs during initDB');
    const repairIdx = initRegion.indexOf('repairLeadUserFields(this.db)');
    const saveIdx = initRegion.indexOf('this.saveDB()');
    assert.ok(repairIdx > -1 && saveIdx > repairIdx, 'the repair runs before the first saveDB');
    assert.ok(!/logger\.[a-z]+\([^)]*(notes|tags|qualification)\s*[:,)]/i.test(initRegion),
      'the repair log records counts, never field values');
    const migrateFn = between(storeSource, 'function migrateSchema(db) {', 'function repairLeadUserFields');
    assert.ok(!migrateFn.includes('repairLeadUserFields'), 'migrateSchema semantics unchanged');
  });

  // === B6.4.2 qualification filter plumbing ===
  // The filter rides the existing B2 query path: one allowlist token in the
  // store, one in the main-process validator, one select in the Lead Library
  // and a merged filters object in the renderer. No new IPC channel and no
  // query-time NULL special case (B6.4.1's startup repair is canonical).

  function loadNumbersQueryValidator() {
    // Two contiguous production slices: the shared guards (invalidParams,
    // assertPlainObject, assertOptionalString) and the query validator with
    // its paging/sort helpers. Nothing is re-implemented here.
    const head = between(mainSource, 'const MAX_KEY_LENGTH = 500;', 'function validateNumbersPayload(');
    const tail = between(mainSource, 'function validateHistoryPaging(', '// === B4 local collection-job ledger hooks ===');
    const factory = new Function('logger', head + '\n' + tail + '\nreturn validateNumbersQuery;');
    return factory({ warn() {}, info() {}, error() {}, ok() {} });
  }

  const validateNumbersQuery = loadNumbersQueryValidator();

  async function seedQualificationDataset(store) {
    await store.addNumbers([
      { id: 'q-a', phone: '+66180000001', source: 'src', keyword: 'cafe', status: 'pending', collectedAt: '2026-06-01T00:00:00.000Z', title: 'Cafe A' },
      { id: 'q-b', phone: '+66180000002', source: 'src', keyword: 'spa', status: 'pending', collectedAt: '2026-06-02T00:00:00.000Z', title: 'Spa B' },
      { id: 'q-c', phone: '+66180000003', source: 'other', keyword: 'cafe', status: 'pending', collectedAt: '2026-06-03T00:00:00.000Z', title: 'Cafe C' }
    ]);
    await store.setLeadUserFields({ id: 'q-b', qualification: 'qualified', tags: [], notes: '' });
  }

  const idsOf = (result) => result.rows.map(r => r.id).sort();

  test('42. main-process validation accepts qualification and keeps rejecting junk', () => {
    const out = validateNumbersQuery({ limit: 20, offset: 0, filters: { qualification: 'qualified' } });
    assert.deepStrictEqual(out.filters, { qualification: 'qualified' }, 'qualification is forwarded');
    const both = validateNumbersQuery({
      limit: 20, offset: 0, filters: { status: 'pending', qualification: 'unqualified' }
    });
    assert.deepStrictEqual(both.filters, { status: 'pending', qualification: 'unqualified' },
      'status and qualification coexist in one filters object');
    const none = validateNumbersQuery({ limit: 20, offset: 0, filters: {} });
    assert.deepStrictEqual(none.filters, {}, 'an empty filter object stays empty');
    // Unknown keys are still dropped, non-string values still refused.
    assert.deepStrictEqual(
      validateNumbersQuery({ limit: 20, offset: 0, filters: { bogus: 'x' } }).filters, {},
      'unknown filter keys are ignored as before'
    );
    for (const bad of [42, true, {}, ['qualified']]) {
      let err = null;
      try {
        validateNumbersQuery({ limit: 20, offset: 0, filters: { qualification: bad } });
      } catch (e) {
        err = e;
      }
      assert.ok(err && err.invalidParams, 'non-string qualification refused: ' + JSON.stringify(bad));
    }
    let notObject = null;
    try {
      validateNumbersQuery({ limit: 20, offset: 0, filters: 'nope' });
    } catch (e) {
      notObject = e;
    }
    assert.ok(notObject && notObject.invalidParams, 'non-object filters still refused');
  });

  test('43. SQL storage filters qualification exactly', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await seedQualificationDataset(store);
    const all = await store.queryNumbers({ limit: 20, offset: 0 });
    assert.strictEqual(all.total, 3, 'no filter returns every lead');
    assert.deepStrictEqual(idsOf(all), ['q-a', 'q-b', 'q-c']);
    const unqualified = await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'unqualified' } });
    assert.deepStrictEqual(idsOf(unqualified), ['q-a', 'q-c'], 'unqualified returns only unqualified leads');
    assert.strictEqual(unqualified.total, 2);
    const qualified = await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'qualified' } });
    assert.deepStrictEqual(idsOf(qualified), ['q-b'], 'qualified returns only qualified leads');
    assert.strictEqual(qualified.total, 1);
    const unknown = await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'scored' } });
    assert.deepStrictEqual(idsOf(unknown), [], 'an out-of-vocabulary value matches nothing');
  });

  test('44. JSON fallback storage filters qualification identically', async () => {
    const store = await openJsonStore();
    await seedQualificationDataset(store);
    assert.strictEqual((await store.queryNumbers({ limit: 20, offset: 0 })).total, 3);
    assert.deepStrictEqual(
      idsOf(await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'unqualified' } })),
      ['q-a', 'q-c'], 'JSON unqualified');
    assert.deepStrictEqual(
      idsOf(await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'qualified' } })),
      ['q-b'], 'JSON qualified');
    assert.deepStrictEqual(
      idsOf(await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'scored' } })),
      [], 'JSON out-of-vocabulary value');
  });

  test('45. SQL and JSON produce equivalent qualification filter results', async () => {
    fs.rmSync(dbPath, { force: true });
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    await seedQualificationDataset(sqlStore);
    await seedQualificationDataset(jsonStore);
    for (const query of [
      { limit: 20, offset: 0 },
      { limit: 20, offset: 0, filters: { qualification: 'unqualified' } },
      { limit: 20, offset: 0, filters: { qualification: 'qualified' } },
      { limit: 1, offset: 1, filters: { qualification: 'unqualified' } }
    ]) {
      const sql = await sqlStore.queryNumbers(query);
      const json = await jsonStore.queryNumbers(query);
      assert.strictEqual(json.total, sql.total, 'parity total for ' + JSON.stringify(query));
      assert.deepStrictEqual(idsOf(json), idsOf(sql), 'parity rows for ' + JSON.stringify(query));
    }
  });

  test('46. qualification combines with search, sort and the other filters', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await seedQualificationDataset(store);
    const withSearch = await store.queryNumbers({
      limit: 20, offset: 0, search: 'cafe', filters: { qualification: 'unqualified' }
    });
    assert.deepStrictEqual(idsOf(withSearch), ['q-a', 'q-c'], 'search AND qualification');
    const withStatus = await store.queryNumbers({
      limit: 20, offset: 0, filters: { status: 'pending', qualification: 'qualified' }
    });
    assert.deepStrictEqual(idsOf(withStatus), ['q-b'], 'status AND qualification');
    const withSource = await store.queryNumbers({
      limit: 20, offset: 0, filters: { source: 'other', qualification: 'unqualified' }
    });
    assert.deepStrictEqual(idsOf(withSource), ['q-c'], 'source AND qualification');
    const withKeyword = await store.queryNumbers({
      limit: 20, offset: 0, filters: { keyword: 'cafe', qualification: 'qualified' }
    });
    assert.deepStrictEqual(idsOf(withKeyword), [], 'keyword AND qualification both apply (no match)');
    const withMatchingKeyword = await store.queryNumbers({
      limit: 20, offset: 0, filters: { keyword: 'spa', qualification: 'qualified' }
    });
    assert.deepStrictEqual(idsOf(withMatchingKeyword), ['q-b'], 'keyword AND qualification combine');
    const sorted = await store.queryNumbers({
      limit: 20, offset: 0, filters: { qualification: 'unqualified' }, sort: 'title', order: 'asc'
    });
    assert.deepStrictEqual(idsOf(sorted), ['q-a', 'q-c'], 'sort still applies with a filter');
    const paged = await store.queryNumbers({
      limit: 1, offset: 1, filters: { qualification: 'unqualified' }
    });
    assert.strictEqual(paged.total, 2, 'total ignores paging');
    assert.strictEqual(paged.rows.length, 1, 'paging applies inside the filtered set');
    const contradicted = await store.queryNumbers({
      limit: 20, offset: 0, search: 'spa', filters: { qualification: 'unqualified' }
    });
    assert.strictEqual(contradicted.total, 0, 'contradicting filters return nothing');
  });

  test('47. the query layer keeps its read-only guarantees and gained no NULL special case', () => {
    const queryBlock = storeSource.slice(
      storeSource.indexOf('// B2 query layer: server-side search'),
      storeSource.indexOf('async addNumbers(')
    );
    assert.ok(storeSource.includes("const QUERY_FILTER_FIELDS = ['status', 'source', 'keyword', 'qualification'];"),
      'the store allowlist gained exactly one field');
    assert.ok(!queryBlock.includes('saveDB('), 'query path still never persists');
    assert.ok(!queryBlock.includes('logger.'), 'query path still logs nothing');
    assert.ok(!queryBlock.includes('IS NULL'), 'no query-time NULL condition was introduced');
    assert.ok(!queryBlock.includes('UPDATE numbers'), 'the query path still updates nothing');
    const sqlBranch = storeSource.slice(
      storeSource.indexOf('for (const field of QUERY_FILTER_FIELDS) {', storeSource.indexOf('_queryNumbersSql')),
      storeSource.indexOf('const whereSql', storeSource.indexOf('_queryNumbersSql'))
    );
    assert.ok(sqlBranch.includes('where.push(`${field} = ?`)'), 'the generic SQL predicate loop is reused');
    const jsonBranch = storeSource.slice(
      storeSource.indexOf('for (const field of QUERY_FILTER_FIELDS) {', storeSource.indexOf('_queryNumbersJson')),
      storeSource.indexOf('const total = matched.length;', storeSource.indexOf('_queryNumbersJson'))
    );
    assert.ok(jsonBranch.includes('row[field] !== value'), 'the generic JSON predicate loop is reused');
  });

  test('48. the Lead Library filter UI is wired through the existing query flow', () => {
    assert.ok(htmlSource.includes('id="number-filter-qualification"'), 'qualification select exists');
    const select = between(htmlSource, '<select id="number-filter-qualification">', '</select>');
    const options = [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(m => [m[1], m[2]]);
    assert.deepStrictEqual(options, [['all', 'All'], ['unqualified', 'Unqualified'], ['qualified', 'Qualified']],
      'exactly the three approved options with English labels');
    // F3 moved the filter controls into compact popovers, so the label carries
    // an explicit `for` instead of relying on a wrapping form-item. The
    // contract - an accessible English label bound to the control - is
    // unchanged, and is now asserted in the form F3 actually ships.
    assert.ok(htmlSource.includes('<label for="number-filter-qualification">Qualification</label>'),
      'English label bound to the qualification filter');
    const payload = between(rendererSource, 'function numbersQueryPayload()', 'function updateNumbersSortHeaders()');
    assert.ok(payload.includes('const filters = {};'), 'a single filters object is built');
    assert.ok(payload.includes("filters.status = filterStatus"), 'status filter preserved');
    assert.ok(payload.includes("filters.qualification = filterQualification"), 'qualification merged in');
    assert.strictEqual(payload.split('query.filters =').length - 1, 1,
      'query.filters is assigned exactly once');
    assert.ok(payload.includes("if (Object.keys(filters).length) query.filters = filters;"),
      'an all/all selection sends no filters at all');
    const listener = between(rendererSource,
      "getElementById('number-filter-qualification').addEventListener",
      "document.querySelector('#view-numbers .data-table thead')");
    assert.ok(listener.includes('numbersPage = 1;'), 'page resets to 1 on change');
    assert.ok(listener.includes('renderNumbers();'), 'reloads through the existing flow');
    assert.ok(listener.includes('safeAsync('), 'the new listener is guarded');
    const statusListener = between(rendererSource,
      "getElementById('number-filter-status').addEventListener",
      "getElementById('number-filter-qualification').addEventListener");
    assert.ok(!statusListener.includes('numbersPage'), 'existing status-filter behaviour untouched');
  });

  test('49. B6.4.2 adds no channel, table column, tag filter, metric or export change', () => {
    // F6 declared lock update: 26 -> 33, the seven sender-checked Lists channels.
    // F8 declared lock update: 33 -> 34, intelligence:icp.
    assert.strictEqual(mainChannels().length, 34,
      '34 IPC channels: B6.4.2 added none, P1-E/P1-F/P1-G added six, F6 seven, F8 one');
    assert.ok(!mainSource.includes('ipcMain.handle(\'collector:filter'), 'no filter-specific channel');
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
    for (const column of ['<th>Qualification</th>', '<th>Tags</th>', '<th>Notes</th>']) {
      assert.ok(!table.includes(column), 'no B6 column in the Lead Library table: ' + column);
    }
    assert.ok(!rendererSource.includes('number-filter-tag'), 'no tag filtering UI');
    assert.ok(!/tags:\s*row\.tags|filters\.tags|tagFilter/.test(rendererSource), 'no tag filter logic');
    const exportFn = between(storeSource, 'async exportNumbers(', '// === B4 local collection-job ledger ===');
    assert.ok(exportFn.includes('run_slug,qualification,tags,notes,phone_status,email_status,website_status,business_status'),
      'the export carries the appended user-owned columns');
    assert.ok(!exportFn.includes('QUERY_FILTER_FIELDS'), 'export does not consult the filter allowlist');
    const dash = between(rendererSource, '// === B5 Lead Library Dashboard ===', '// === 视图切换时加载数据 ===');
    assert.ok(!/qualification|qualified/.test(dash), 'no dashboard qualification metric');
    assert.ok(!mainSource.includes('providerId.*qualification'), 'no provider coupling');
  });

  test('50. repaired legacy NULL rows filter as unqualified, without a query-time rule', async () => {
    fs.rmSync(dbPath, { force: true });
    await seedMigratedDbWithNullB6();
    const store = await openStore();
    const unqualified = await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'unqualified' } });
    assert.deepStrictEqual(idsOf(unqualified), ['null-b6'],
      'the repaired row is matched by the plain equality predicate');
    const qualified = await store.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'qualified' } });
    assert.strictEqual(qualified.total, 0, 'it is not reported as qualified');
  });

  // === B6.4.3 final contract verification (test-only batch) ===
  // No new functionality: these tests only pin the contracts the B6 batches
  // already established. Anything found broken here is reported, not fixed.

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const exportFn = between(storeSource, 'async exportNumbers(', '// === B4 local collection-job ledger ===');
  // Only the B6 regions are scanned for banned product surface; slicing the
  // whole files would sweep in pre-existing unrelated code (taskKey, pipeline
  // comments, credential handling) and produce false positives.
  const b6Code = [
    between(storeSource, '// B6 user-owned lead fields', '// Exact provenance literal'),
    between(storeSource, 'function repairLeadUserFields(db) {', '// Map a positional SELECT row'),
    between(storeSource, '// === B6 user-owned lead fields ===', 'async exportNumbers('),
    between(mainSource, '// B6 user-owned lead fields.', 'function validateHistoryPaging('),
    between(mainSource, "ipcMain.handle('collector:update-lead'", "ipcMain.handle('logs:export'"),
    between(rendererSource, '// === B6 Lead Profile:', "document.getElementById('btn-save-lead-detail')")
  ].join('\n');

  test('51. combined-filter parity holds on both storages, values included', async () => {
    fs.rmSync(dbPath, { force: true });
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    await seedQualificationDataset(sqlStore);
    await seedQualificationDataset(jsonStore);
    await sqlStore.setLeadUserFields({ id: 'q-a', qualification: 'qualified', tags: [], notes: '' });
    await jsonStore.setLeadUserFields({ id: 'q-a', qualification: 'qualified', tags: [], notes: '' });
    const cases = [
      { label: 'all', q: { limit: 20, offset: 0 } },
      { label: 'unqualified', q: { limit: 20, offset: 0, filters: { qualification: 'unqualified' } } },
      { label: 'qualified', q: { limit: 20, offset: 0, filters: { qualification: 'qualified' } } },
      { label: 'search+qualification', q: { limit: 20, offset: 0, search: 'cafe', filters: { qualification: 'qualified' } } },
      { label: 'sort+qualification', q: { limit: 20, offset: 0, filters: { qualification: 'unqualified' }, sort: 'title', order: 'asc' } },
      { label: 'status+qualification', q: { limit: 20, offset: 0, filters: { status: 'pending', qualification: 'unqualified' } } },
      { label: 'source+qualification', q: { limit: 20, offset: 0, filters: { source: 'other', qualification: 'unqualified' } } },
      { label: 'keyword+qualification', q: { limit: 20, offset: 0, filters: { keyword: 'cafe', qualification: 'qualified' } } },
      { label: 'paged+qualification', q: { limit: 1, offset: 1, filters: { qualification: 'unqualified' } } }
    ];
    for (const { label, q } of cases) {
      const sql = await sqlStore.queryNumbers(q);
      const json = await jsonStore.queryNumbers(q);
      assert.strictEqual(json.total, sql.total, 'parity total: ' + label);
      assert.deepStrictEqual(idsOf(json), idsOf(sql), 'parity ids: ' + label);
      const sqlValues = sql.rows.map(r => `${r.id}:${r.qualification}`).sort();
      const jsonValues = json.rows.map(r => `${r.id}:${r.qualification}`).sort();
      assert.deepStrictEqual(jsonValues, sqlValues, 'parity qualification values: ' + label);
      for (const row of sql.rows) {
        assert.ok(['unqualified', 'qualified'].includes(row.qualification),
          'every returned qualification is in the vocabulary: ' + label);
      }
    }
    const qualifiedBoth = await sqlStore.queryNumbers({ limit: 20, offset: 0, filters: { qualification: 'qualified' } });
    assert.deepStrictEqual(idsOf(qualifiedBoth), ['q-a', 'q-b'], 'two qualified leads after the second save');
  });

  test('52. CSV contract: 13 columns, stable prefix, representation and losslessness', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'csv-contract', phone: '+66190000001', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-07-01T00:00:00.000Z',
      title: 'T', website: 'w', email: 'e', address: 'a', runSlug: 'r'
    }]);
    await store.setLeadUserFields({
      id: 'csv-contract', qualification: 'qualified', tags: ['One', 'Two'],
      notes: 'a\r\nb\rc\nd'
    });
    const csv = await store.exportNumbers('csv');
    const header = csv.split('\n')[0];
    const columns = header.split(',');
    assert.deepStrictEqual(columns, [
      'phone', 'source', 'keyword', 'status', 'collected_at', 'title', 'website', 'email',
      'address', 'run_slug', 'qualification', 'tags', 'notes',
      'phone_status', 'email_status', 'website_status', 'business_status'
    ], 'exactly the 17 contract columns, in order');
    assert.strictEqual(columns.length, 17, 'header has exactly 17 columns');
    assert.deepStrictEqual(columns.slice(0, 10),
      ['phone', 'source', 'keyword', 'status', 'collected_at', 'title', 'website', 'email', 'address', 'run_slug'],
      'the original ten columns keep their exact names and order');
    const dataLines = csv.split('\n').slice(1).filter(line => line.length);
    assert.strictEqual(dataLines.length, (await store.getCollectedNumbers()).length,
      'one physical CSV row per lead');
    const row = dataLines[0];
    assert.strictEqual(row.split('","').length, 17, 'each row carries 17 quoted fields');
    assert.ok(row.includes('"qualified"'), 'qualification exported');
    assert.ok(row.includes('"One;Two"'), 'tags joined with ;');
    assert.ok(row.includes('"a b c d"'), 'CRLF, CR and LF all collapse to single spaces');
    assert.ok(!row.includes('\r'), 'no carriage return survives into a CSV row');
    const stored = (await store.getCollectedNumbers()).find(r => r.id === 'csv-contract');
    assert.strictEqual(stored.notes, 'a\r\nb\rc\nd', 'stored note is lossless');
    const jsonRow = JSON.parse(await store.exportNumbers('json')).find(r => r.id === 'csv-contract');
    assert.strictEqual(jsonRow.notes, 'a\r\nb\rc\nd', 'JSON note is lossless');
  });

  test('53. formula protection covers all three B6 CSV fields', async () => {
    // The row template must wrap every B6 field in csvField, and the enum
    // guard makes a formula-like qualification unreachable through the API.
    assert.ok(exportFn.includes('csvField(n.qualification || \'\')'), 'qualification goes through csvField');
    assert.ok(exportFn.includes("csvField((n.tags || []).join(';'))"), 'tags go through csvField');
    assert.ok(exportFn.includes('csvField(csvNotes(n.notes))'), 'notes go through csvField');
    for (const field of ['n.phone', 'n.source', 'n.runSlug']) {
      assert.ok(exportFn.includes('csvField(' + field), 'pre-existing field still guarded: ' + field);
    }
    const store = await openStore();
    await store.addNumbers([{
      id: 'csv-guard', phone: '+66190000002', status: 'pending', collectedAt: '2026-07-02T00:00:00.000Z'
    }]);
    const refused = await store.setLeadUserFields({
      id: 'csv-guard', qualification: '=cmd', tags: ['ok'], notes: ''
    });
    assert.strictEqual(refused.success, false, 'a formula-like qualification is refused at the boundary');
    await store.setLeadUserFields({
      id: 'csv-guard', qualification: 'qualified', tags: ['=1+1', '@user', '+plus', '-minus'],
      notes: '=SUM(A1:A9)'
    });
    const csv = await store.exportNumbers('csv');
    assert.ok(csv.includes("\"'=1+1;@user;+plus;-minus\""), 'a leading formula char in the joined tags cell is prefixed');
    assert.ok(csv.includes("\"'=SUM(A1:A9)\""), 'a leading formula char in a note is prefixed');
    assert.ok(!csv.includes('"=1+1'), 'no raw = cell');
    assert.ok(!csv.includes('"=SUM'), 'no raw formula cell');
  });

  test('54. final B6 scope, IPC and dependency guards', () => {
    // JSON production code is untouched by this batch and still native.
    assert.ok(exportFn.includes('return JSON.stringify(numbers, null, 2);'), 'JSON export unchanged');
    assert.ok(!/JSON\.stringify\((n|row)\.(tags|notes)\)/.test(exportFn), 'tags are never stringified for JSON');
    // IPC: the filter still rides collector:get-numbers.
    // F6 declared lock update: 33 -> 40, the seven sender-checked Lists channels.
    // F7 declared lock update: 40 -> 41, the read-only prospect-research:list channel.
    // F8 declared lock update: 41 -> 42, intelligence:icp.
    // F12 Batch 2 declared lock update: 47 -> 48, the six approved Lead Intelligence channels.
    assert.strictEqual(allChannels().length, 48, 'exactly 48 channels (A4 + F7 research, F6 Lists, F8 ICP, A10 Lead Intelligence)');
    const getNumbersHandler = between(mainSource, "ipcMain.handle('collector:get-numbers'", '  });\n');
    assert.ok(getNumbersHandler.includes('accountStore.queryNumbers(validateNumbersQuery(query))'),
      'collector:get-numbers is still the qualification filter path');
    assert.ok(preloadSource.includes("getNumbers: (query) => ipcRenderer.invoke('collector:get-numbers', query)"),
      'preload still forwards the query payload unchanged');
    // No query-time NULL workaround and a per-column repair remain.
    const queryBlock = storeSource.slice(
      storeSource.indexOf('// B2 query layer: server-side search'),
      storeSource.indexOf('async addNumbers(')
    );
    assert.ok(!queryBlock.includes('IS NULL'), 'no IS NULL in the query layer');
    const repair = between(storeSource, 'function repairLeadUserFields(db) {', '// Map a positional SELECT row');
    assert.ok(repair.includes('WHERE ${field} IS NULL'), 'the per-column startup repair is the NULL remedy');
    assert.ok(!repair.includes('OR tags IS NULL'), 'no combined OR repair was reintroduced');
    // Banned product surface across every B6 code block. Feature-shaped
    // identifiers are used (e.g. 'assignee'), not bare words, so ordinary
    // JavaScript assignment is not a false positive.
    for (const term of ['pipeline', 'stage', 'activity', 'reminder', 'scoring', 'probability',
      'enrichment', 'assignee', 'assignedTo', 'leadOwner', 'revenue', 'ROI', 'conversion',
      'Zuni', 'MCP', 'multi-tenant']) {
      assert.ok(!new RegExp(term, 'i').test(b6Code), 'no B6 code may reference: ' + term);
    }
    assert.ok(!b6Code.includes('apiKey') && !b6Code.includes('taskKey'), 'no credentials in B6 code');
    // Dependencies unchanged (the exact sets are also pinned by
    // runtime-containment test 12; this is the B6-scoped restatement). The
    // prospect-research trio is the one deliberate production addition.
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
      'production dependencies are exactly the two originals plus the three prospect-research ones');
    assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
      ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
      'no dev dependency added');
    assert.ok(pkg.scripts.test.includes('run-all.js'), 'test runner wiring unchanged');
    const dash = between(rendererSource, '// === B5 Lead Library Dashboard ===', '// === 视图切换时加载数据 ===');
    assert.ok(!/qualification|qualified|tags|notes/.test(dash), 'no B6 metric in the dashboard');
    assert.ok(dash.includes("'Run counts cover the most recent ' + rows.length + ' runs'"),
      'the pre-existing B5 window-note text is untouched by B6');
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
    for (const column of ['<th>Qualification</th>', '<th>Tags</th>', '<th>Notes</th>']) {
      assert.ok(!table.includes(column), 'no B6 column added to the Lead Library table: ' + column);
    }
    const statusSelect = between(htmlSource, 'id="number-filter-status"', '</select>');
    assert.ok(statusSelect.includes('<option value="pending">Pending</option>'), 'status options unchanged');
    assert.ok(!statusSelect.includes('qualified'), 'no qualification value in the status filter');
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
