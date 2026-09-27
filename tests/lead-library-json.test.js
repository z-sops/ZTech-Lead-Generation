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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b1-json-'));

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

  const sqlJsPath = require.resolve('sql.js');
  require.cache[sqlJsPath] = {
    id: sqlJsPath, filename: sqlJsPath, loaded: true,
    exports: function initSQL() {
      return Promise.reject(new Error('sql.js disabled in tests (JSON fallback path under test)'));
    }
  };

  const accountStorePath = path.join(__dirname, '..', 'src', 'main', 'accountStore.js');
  const source = fs.readFileSync(accountStorePath, 'utf8');
  const { AccountStore, normalizeLeadRow } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  const numbersPath = path.join(dataDir, 'numbers.json');

  const LEGACY = [
    {
      id: 'j1', phone: '+66111111111', source: 'Coffee Corner', keyword: 'coffee',
      status: 'pending', collectedAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'j2', phone: '+66122222222', source: '手动导入', keyword: '',
      status: 'pending', collectedAt: '2026-01-02T00:00:00.000Z'
    }
  ];

  function seedFile() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(numbersPath, JSON.stringify(LEGACY, null, 2), 'utf-8');
  }

  function readFile() {
    return fs.readFileSync(numbersPath, 'utf-8');
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    assert.strictEqual(store.storageStatus.mode, 'json-fallback', 'expected JSON fallback mode');
    return store;
  }

  test('1. legacy numbers.json rows gain the B1 fields on load without rewriting the file', async () => {
    seedFile();
    const bytesBefore = readFile();
    const store = await openStore();
    assert.strictEqual(store._numbers.length, LEGACY.length, 'all legacy rows kept');
    const j1 = store._numbers.find(r => r.id === 'j1');
    const j2 = store._numbers.find(r => r.id === 'j2');
    assert.strictEqual(j1.title, 'Coffee Corner', 'legacy title recovered from source');
    assert.strictEqual(j1.source, 'Coffee Corner', 'source byte-preserved');
    assert.strictEqual(j1.website, '');
    assert.strictEqual(j1.email, '');
    assert.strictEqual(j1.address, '');
    assert.strictEqual(j1.runSlug, '');
    assert.strictEqual(j2.title, '', 'import provenance is not a business title');
    assert.strictEqual(j2.source, '手动导入', 'provenance literal byte-preserved');
    assert.strictEqual(readFile(), bytesBefore, 'load-time normalisation must not rewrite numbers.json');
  });

  test('2. second open is idempotent (row values identical, file untouched)', async () => {
    const before = readFile();
    const store = await openStore();
    const snapshot = JSON.stringify(store._numbers);
    const again = await openStore();
    assert.strictEqual(JSON.stringify(again._numbers), snapshot, 'restart must not alter rows');
    assert.strictEqual(readFile(), before, 'restart must not rewrite numbers.json');
    const probe = normalizeLeadRow({ ...LEGACY[0], title: 'x', website: '', email: '', address: '', runSlug: '',
      qualification: 'unqualified', tags: [], notes: '',
      phoneStatus: 'unknown', emailStatus: 'unknown', websiteStatus: 'unknown', businessStatus: 'unknown',
      // P1-D: an already-normalised JSON row already carries the derived key
      // and the nullable pointer.
      companyKey: '', companyId: null });
    assert.strictEqual(probe.changed, false, 'already-normalised row reports no change');
  });

  test('3. JSON save path persists the new fields', async () => {
    const store = await openStore();
    const res = store._addNumbers([{
      id: 'j3', phone: '+66133333333', source: '', keyword: 'b1', status: 'pending',
      collectedAt: '2026-02-01T00:00:00.000Z',
      title: 'B1 Cafe', website: 'https://b1.example', email: 'b1@example.com',
      address: '9 Silom Rd', runSlug: 'run-json'
    }]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 });
    const parsed = JSON.parse(readFile());
    const row = parsed.find(r => r.id === 'j3');
    assert.ok(row, 'new row written to numbers.json');
    assert.strictEqual(row.title, 'B1 Cafe');
    assert.strictEqual(row.website, 'https://b1.example');
    assert.strictEqual(row.email, 'b1@example.com');
    assert.strictEqual(row.address, '9 Silom Rd');
    assert.strictEqual(row.runSlug, 'run-json');
    const legacyRow = parsed.find(r => r.id === 'j1');
    assert.strictEqual(legacyRow.source, 'Coffee Corner', 'other rows untouched');
    assert.strictEqual(legacyRow.title, 'Coffee Corner');
  });

  test('4. JSON dedup fills empty fields only, first writer wins', async () => {
    const store = await openStore();
    const res = store._addNumbers([{
      id: 'j1-dup', phone: '+66111111111', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-02-02T00:00:00.000Z',
      title: 'Replacement', website: 'https://filled.example', email: 'filled@example.com',
      address: '', runSlug: ''
    }]);
    assert.deepStrictEqual(res, { added: 0, duplicates: 1 });
    const row = store._numbers.find(r => r.id === 'j1');
    assert.strictEqual(row.title, 'Coffee Corner', 'existing title must win');
    assert.strictEqual(row.source, 'Coffee Corner', 'existing source must win');
    assert.strictEqual(row.website, 'https://filled.example', 'empty field filled');
    assert.strictEqual(row.email, 'filled@example.com', 'empty field filled');
    const parsed = JSON.parse(readFile());
    assert.strictEqual(parsed.find(r => r.id === 'j1').website, 'https://filled.example');
  });

  test('5. JSON delete preserves the new fields of remaining rows', async () => {
    const store = await openStore();
    const res = await store.deleteNumbers(['j1']);
    assert.deepStrictEqual(res, { success: true });
    const parsed = JSON.parse(readFile());
    assert.ok(!parsed.some(r => r.id === 'j1'), 'deleted row removed');
    const j2 = parsed.find(r => r.id === 'j2');
    assert.ok(j2, 'other rows kept');
    assert.strictEqual(j2.source, '手动导入');
    assert.strictEqual(j2.title, '');
    assert.strictEqual(j2.runSlug, '', 'B1 fields of survivors untouched');
    const j3 = parsed.find(r => r.id === 'j3');
    assert.ok(j3 && j3.title === 'B1 Cafe' && j3.runSlug === 'run-json',
      'B1 fields of survivors untouched');
  });

  test('6. JSON normalisation never writes numbers.json directly at load time', () => {
    const direct = source.split("fs.writeFileSync(path.join(DATA_DIR, 'numbers.json')").length - 1;
    assert.strictEqual(direct, 0, 'no direct fs.writeFileSync of numbers.json');
    const callSites = source.split("writeJsonAtomic(path.join(DATA_DIR, 'numbers.json')").length - 1;
    assert.strictEqual(callSites, 5, 'atomic write helper call sites (add, delete, B6 write, P1-C status write, P1-D legacy-JSON companyId pointer restore)');
    assert.ok(source.includes('function normalizeLeadRow('), 'normaliser must exist');
    assert.ok(source.includes('for (const row of parsed) normalizeLeadRow(row)'), 'fallback load must normalise');
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
