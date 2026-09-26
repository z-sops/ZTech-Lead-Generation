'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b1-schema-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const SQL = await require('sql.js')();

  const accountStorePath = path.join(__dirname, '..', 'src', 'main', 'accountStore.js');
  const storeSource = fs.readFileSync(accountStorePath, 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

  const { AccountStore, migrateSchema, normalizeLeadRow } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');

  const LEGACY_ROWS = [
    ['legacy-1', '+66811111111', 'Bangkok Cafe', 'cafe', 'pending', '2026-01-01T00:00:00.000Z'],
    ['legacy-2', '+66822222222', '手动导入', '', 'pending', '2026-01-02T00:00:00.000Z'],
    ['legacy-3', '+66833333333', null, 'kw', 'pending', '2026-01-03T00:00:00.000Z']
  ];

  const EXPECTED_COLUMNS = [
    'id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
    'title', 'website', 'email', 'address', 'runSlug',
    'qualification', 'tags', 'notes'
  ];

  function schemaColumns(db) {
    const info = db.exec('PRAGMA table_info(numbers)');
    if (!info.length) return [];
    return info[0].values.map(r => r[1]);
  }

  function seedLegacyDb() {
    const db = new SQL.Database();
    db.run(`CREATE TABLE numbers (
      id TEXT PRIMARY KEY,
      phone TEXT,
      source TEXT,
      keyword TEXT,
      status TEXT DEFAULT 'pending',
      collectedAt TEXT
    )`);
    db.run(`CREATE INDEX idx_numbers_phone ON numbers(phone)`);
    db.run(`CREATE INDEX idx_numbers_status ON numbers(status)`);
    for (const r of LEGACY_ROWS) {
      db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
        r
      );
    }
    fs.writeFileSync(dbPath, Buffer.from(db.export()));
    db.close();
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  async function findByPhone(store, phone) {
    const rows = await store.getCollectedNumbers();
    return rows.find(r => r.phone === phone) || null;
  }

  // --- 1. fresh database -------------------------------------------------
  test('1. fresh database is created with the full B1 schema', async () => {
    fs.rmSync(dbPath, { force: true });
    const fresh = await openStore();
    assert.deepStrictEqual(schemaColumns(fresh.db), EXPECTED_COLUMNS);
    assert.strictEqual(migrateSchema(fresh.db), 0, 'fresh schema needs no migration');
    fs.rmSync(dbPath, { force: true });
  });

  // --- 2. migration of an existing 6-column database ----------------------
  test('2. migration adds the B1 and B6 columns to a legacy 6-column database', async () => {
    seedLegacyDb();
    const store = await openStore();
    assert.deepStrictEqual(schemaColumns(store.db), EXPECTED_COLUMNS);
    assert.ok(!EXPECTED_COLUMNS.includes('country') && !EXPECTED_COLUMNS.includes('city'),
      'country/city are not implemented (no reliable derivation)');
  });

  test('3. migration preserves every legacy row byte-for-byte (source included)', async () => {
    const store = await openStore();
    const rows = await store.getCollectedNumbers();
    assert.strictEqual(rows.length, LEGACY_ROWS.length, 'no row may be added or lost');
    for (const [id, phone, source, keyword, status, collectedAt] of LEGACY_ROWS) {
      const row = rows.find(r => r.id === id);
      assert.ok(row, `row ${id} must survive migration`);
      assert.strictEqual(row.phone, phone);
      assert.strictEqual(row.source, source, `source of ${id} must be preserved exactly`);
      assert.strictEqual(row.keyword, keyword);
      assert.strictEqual(row.status, status);
      assert.strictEqual(row.collectedAt, collectedAt);
    }
  });

  test('4. migration backfills title from legacy source, never modifying source', async () => {
    const store = await openStore();
    const rows = await store.getCollectedNumbers();
    const byId = new Map(rows.map(r => [r.id, r]));
    assert.strictEqual(byId.get('legacy-1').title, 'Bangkok Cafe', 'legacy title recovered from source');
    assert.strictEqual(byId.get('legacy-2').title, '', 'import provenance is not a business title');
    assert.strictEqual(byId.get('legacy-3').title, '', 'NULL source maps to empty title');
    assert.strictEqual(byId.get('legacy-1').source, 'Bangkok Cafe', 'source column untouched');
    assert.strictEqual(byId.get('legacy-2').source, '手动导入', 'provenance literal untouched');
    assert.strictEqual(byId.get('legacy-3').source, null, 'NULL source untouched');
    for (const row of rows) {
      assert.strictEqual(row.website, '');
      assert.strictEqual(row.email, '');
      assert.strictEqual(row.address, '');
      assert.strictEqual(row.runSlug, '');
    }
  });

  test('5. migrateSchema is idempotent and performs zero writes when already migrated', async () => {
    const store = await openStore();
    const before = Buffer.from(store.db.export());
    assert.strictEqual(migrateSchema(store.db), 0, 'second run must report zero added columns');
    const after = Buffer.from(store.db.export());
    assert.ok(before.equals(after), 'already-migrated database must not be rewritten');
  });

  test('6. restart keeps schema and rows identical', async () => {
    const first = await openStore();
    const rowsBefore = await first.getCollectedNumbers();
    const second = await openStore();
    assert.deepStrictEqual(schemaColumns(second.db), EXPECTED_COLUMNS);
    assert.strictEqual(migrateSchema(second.db), 0, 'restart migration must be a no-op');
    const rowsAfter = await second.getCollectedNumbers();
    assert.deepStrictEqual(rowsAfter, rowsBefore, 'restart must not alter any row');
  });

  // --- 7. save path --------------------------------------------------------
  test('7. save path persists title, website, email, address and runSlug', async () => {
    const store = await openStore();
    const res = await store.addNumbers([{
      id: 'lead-full',
      phone: '+66844444444',
      source: '',
      keyword: 'noodle',
      status: 'pending',
      collectedAt: '2026-02-01T00:00:00.000Z',
      title: 'Noodle Shop',
      website: 'https://example.com',
      email: 'owner@example.com',
      address: '12 Sukhumvit Rd',
      runSlug: 'run-abc'
    }]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
    const row = await findByPhone(store, '+66844444444');
    assert.ok(row);
    assert.strictEqual(row.title, 'Noodle Shop');
    assert.strictEqual(row.website, 'https://example.com');
    assert.strictEqual(row.email, 'owner@example.com');
    assert.strictEqual(row.address, '12 Sukhumvit Rd');
    assert.strictEqual(row.runSlug, 'run-abc');
  });

  test('8. rows without the new fields receive empty-string defaults', async () => {
    const store = await openStore();
    const res = await store.addNumbers([{
      id: 'lead-minimal',
      phone: '+66855555555',
      status: 'pending',
      collectedAt: '2026-02-02T00:00:00.000Z'
    }]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
    const row = await findByPhone(store, '+66855555555');
    assert.strictEqual(row.title, '');
    assert.strictEqual(row.website, '');
    assert.strictEqual(row.email, '');
    assert.strictEqual(row.address, '');
    assert.strictEqual(row.runSlug, '');
  });

  // --- 9. dedup / merge ----------------------------------------------------
  test('9. duplicate detection still canonicalises phone formatting', async () => {
    const store = await openStore();
    const first = await store.addNumbers([{
      id: 'dedup-a', phone: '+66 86-111-1111', source: 'first-writer',
      status: 'pending', collectedAt: '2026-02-03T00:00:00.000Z'
    }]);
    assert.deepStrictEqual(first, { added: 1, duplicates: 0 });
    const second = await store.addNumbers([{
      id: 'dedup-b', phone: '+66861111111', source: 'second-writer',
      status: 'pending', collectedAt: '2026-02-04T00:00:00.000Z'
    }]);
    assert.deepStrictEqual(second, { added: 0, duplicates: 1 }, 'same canonical phone must dedup');
    const rows = await store.getCollectedNumbers();
    const matches = rows.filter(r => r.phone.replace(/[\s\-.()]/g, '') === '+66861111111');
    assert.strictEqual(matches.length, 1, 'exactly one stored row per canonical phone');
    assert.strictEqual(matches[0].phone, '+66 86-111-1111', 'stored phone stays the first writer\'s value');
    assert.strictEqual(matches[0].source, 'first-writer', 'first writer wins for non-empty fields');
  });

  test('10. merge rule fills empty fields only, existing non-empty values win', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'merge-base', phone: '+66877777777', source: 'collected', keyword: 'kw',
      status: 'pending', collectedAt: '2026-02-05T00:00:00.000Z',
      title: 'Original Title', website: '', email: '', address: '', runSlug: ''
    }]);
    const dup = await store.addNumbers([{
      id: 'merge-dup', phone: '+66877777777', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-02-06T00:00:00.000Z',
      title: 'Replacement Title', website: 'https://filled.example', email: 'filled@example.com',
      address: '42 Wireless Rd', runSlug: 'run-2'
    }]);
    assert.deepStrictEqual(dup, { added: 0, duplicates: 1 });
    const row = await findByPhone(store, '+66877777777');
    assert.strictEqual(row.title, 'Original Title', 'existing title must win');
    assert.strictEqual(row.source, 'collected', 'existing source must win');
    assert.strictEqual(row.keyword, 'kw', 'existing keyword must win');
    assert.strictEqual(row.website, 'https://filled.example', 'empty field must be filled');
    assert.strictEqual(row.email, 'filled@example.com', 'empty field must be filled');
    assert.strictEqual(row.address, '42 Wireless Rd', 'empty field must be filled');
    assert.strictEqual(row.runSlug, 'run-2', 'empty field must be filled');
  });

  test('11. manual import keeps source 手动导入 with an empty title', async () => {
    const store = await openStore();
    const res = await store.addNumbers([{
      id: 'lead-import', phone: '+66888888888', source: '手动导入',
      status: 'pending', collectedAt: '2026-02-07T00:00:00.000Z'
    }]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
    const row = await findByPhone(store, '+66888888888');
    assert.strictEqual(row.source, '手动导入', 'provenance must be preserved');
    assert.strictEqual(row.title, '', 'import rows carry no business title');
  });

  // --- 12/13. export --------------------------------------------------------
  test('12. CSV export carries the extended header and quotes formula-like values', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'lead-csv', phone: '+66899999999', source: 'csv-src', keyword: 'csvkw',
      status: 'pending', collectedAt: '2026-02-08T00:00:00.000Z',
      title: '=HYPERLINK("http://evil")', website: 'https://site.example',
      email: 'csv@example.com', address: '8 Rama IV', runSlug: 'run-csv'
    }]);
    const csv = await store.exportNumbers('csv');
    const lines = csv.split('\n');
    assert.strictEqual(lines[0], 'phone,source,keyword,status,collected_at,title,website,email,address,run_slug');
    assert.ok(csv.includes('"\'=HYPERLINK'), 'leading = must be neutralised by csvField');
    assert.ok(csv.includes('run-csv'), 'runSlug value must be exported');
    assert.strictEqual(csv.split('\n').length, 1 + (await store.getCollectedNumbers()).length);
  });

  test('13. JSON export includes the new fields as plain object keys', async () => {
    const store = await openStore();
    const parsed = JSON.parse(await store.exportNumbers('json'));
    assert.ok(Array.isArray(parsed) && parsed.length > 0);
    for (const row of parsed) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'title'));
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'website'));
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'email'));
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'address'));
      assert.ok(Object.prototype.hasOwnProperty.call(row, 'runSlug'));
    }
    const full = parsed.find(r => r.phone === '+66844444444');
    assert.ok(full && full.title === 'Noodle Shop' && full.runSlug === 'run-abc');
  });

  // --- 14-18. source contracts ---------------------------------------------
  test('14. renderer save handler maps all five new fields and stops overloading source', () => {
    assert.ok(rendererSource.includes("title: item.title || ''"), 'title must be persisted');
    assert.ok(rendererSource.includes("website: item.website || ''"), 'website must be persisted');
    assert.ok(rendererSource.includes("email: item.email_1 || item.all_emails || ''"), 'email must be persisted');
    assert.ok(rendererSource.includes("address: item.address || ''"), 'address must be persisted');
    assert.ok(rendererSource.includes("runSlug: currentResultsRunSlug || ''"), 'runSlug must be persisted');
    assert.ok(rendererSource.includes("source: '',"), 'source must no longer carry the title');
    assert.ok(!rendererSource.includes('source: item.title'), 'legacy title-into-source mapping must be gone');
  });

  test('15. renderer tracks the active run slug for saved leads', () => {
    assert.ok(rendererSource.includes('let currentResultsRunSlug = null'), 'state must exist');
    const clearSites = rendererSource.split('currentResultsRunSlug = null').length - 1;
    assert.strictEqual(clearSites, 2, 'declared once and cleared in clearCurrentResultPresentation');
    assert.ok(rendererSource.includes('currentResultsRunSlug = currentRunSlug'), 'set when polling result loads');
    assert.ok(rendererSource.includes('currentResultsRunSlug = slug'), 'set when history result is viewed');
  });

  test('16. numbers table UI exposes title and website columns', () => {
    assert.ok(htmlSource.includes('<th>Title</th>'), 'title column header present');
    assert.ok(htmlSource.includes('<th>Website</th>'), 'website column header present');
    assert.ok(rendererSource.includes('${escapeHtml(n.title || \'-\')}'), 'title cell rendered');
    assert.ok(rendererSource.includes('${escapeHtml(n.website || \'-\')}'), 'website cell rendered');
  });

  test('17. main process validates the new fields with the existing string guard', () => {
    assert.ok(mainSource.includes(
      "for (const key of ['source', 'keyword', 'collectedAt', 'title', 'website', 'email', 'address', 'runSlug'])"
    ), 'validateNumbersPayload must cover the B1 fields');
    assert.ok(mainSource.includes('assertOptionalString(n[key]'), 'existing guard reused');
  });

  test('18. scope: no country/city fields, import provenance and renderer contracts intact', () => {
    assert.ok(!storeSource.toLowerCase().includes('country'), 'country not implemented');
    assert.ok(!storeSource.toLowerCase().includes('city'), 'city not implemented');
    assert.ok(!rendererSource.includes('canonicalPhone'), 'renderer must stay free of dedup logic');
    assert.ok(rendererSource.includes("source: '手动导入'"), 'import provenance literal unchanged');
    assert.ok(storeSource.includes('migrateSchema'), 'migration entry point present');
    assert.strictEqual(
      storeSource.split("writeJsonAtomic(path.join(DATA_DIR, 'numbers.json')").length - 1, 3,
      'JSON write call sites: add, delete and the B6 user-field write'
    );
    assert.strictEqual(
      storeSource.split('new Set(ids)').length - 1, 2,
      'delete Set usage unchanged'
    );
    assert.ok(!storeSource.includes('ids.includes'));
    assert.ok(storeSource.includes('INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug, qualification, tags, notes) VALUES'),
      '14-column delete rollback insert preserved (B6 data cannot be lost)');
  });

  test('19. normalizeLeadRow is idempotent for already-normalised rows', () => {
    const row = {
      id: 'r1', phone: '+66100000001', source: '手动导入', keyword: '', status: 'pending',
      collectedAt: '2026-01-01T00:00:00.000Z', title: '', website: '', email: '', address: '', runSlug: '',
      // B6 user-owned fields: an already-normalised row carries them too, so
      // this test still measures idempotency rather than first-run defaults.
      qualification: 'unqualified', tags: [], notes: ''
    };
    const snapshot = JSON.stringify(row);
    const second = normalizeLeadRow(row);
    assert.strictEqual(second.changed, false, 'second pass must change nothing');
    assert.strictEqual(JSON.stringify(row), snapshot, 'row must stay byte-identical');
    const legacy = normalizeLeadRow({ source: 'Legacy Title', phone: '+66100000002' });
    assert.strictEqual(legacy.changed, true);
    assert.strictEqual(legacy.row.title, 'Legacy Title');
    assert.strictEqual(legacy.row.website, '');
    assert.strictEqual(legacy.row.qualification, 'unqualified', 'B6 default applied to a legacy row');
    assert.deepStrictEqual(legacy.row.tags, [], 'B6 tags default applied to a legacy row');
    assert.strictEqual(legacy.row.notes, '', 'B6 notes default applied to a legacy row');
    const bogus = normalizeLeadRow(null);
    assert.strictEqual(bogus.changed, false);
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
