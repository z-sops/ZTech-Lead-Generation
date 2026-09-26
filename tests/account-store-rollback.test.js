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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b2-rollback-'));

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

  const accountStorePath = path.join(__dirname, '..', 'src', 'main', 'accountStore.js');
  const { AccountStore } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    assert.ok(store.db, 'SQL mode required for rollback coverage');
    return store;
  }

  // Instance-level persistence failure: no production code is patched.
  function failPersist(store) {
    store.saveDB = () => {
      throw new Error('injected persist failure');
    };
  }

  async function snapshot(store) {
    const rows = JSON.parse(JSON.stringify(await store.getCollectedNumbers()));
    // Failed-persist rollback re-inserts rows with fresh rowids, so row order
    // may legitimately shift; compare by id, values must stay exact.
    rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
  }

  async function expectThrow(fn) {
    let thrown = null;
    try {
      await fn();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'persist error must be rethrown');
    assert.strictEqual(thrown.message, 'injected persist failure');
    return thrown;
  }

  test('1. failed persist during add rolls back every inserted row', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'rb-a', phone: '+66100000001', source: 's1', keyword: 'k1',
      status: 'pending', collectedAt: '2026-03-01T00:00:00.000Z'
    }]);
    const before = await snapshot(store);
    failPersist(store);
    await expectThrow(() => store.addNumbers([{
      id: 'rb-new', phone: '+66100000002', source: 's2', keyword: 'k2',
      status: 'pending', collectedAt: '2026-03-02T00:00:00.000Z',
      title: 'New Lead', website: 'https://new.example', email: 'new@example.com',
      address: '2 New Rd', runSlug: 'run-new'
    }]));
    const after = await snapshot(store);
    assert.deepStrictEqual(after, before, 'library must be pristine after a failed add');
    assert.ok(!after.some(r => r.id === 'rb-new'), 'inserted row must be absent');
  });

  test('2. failed persist during duplicate merge restores the pristine merged row', async () => {
    const store = await openStore();
    await store.addNumbers([{
      id: 'rb-m', phone: '+66100000003', source: 'base-src', keyword: 'base-kw',
      status: 'pending', collectedAt: '2026-03-03T00:00:00.000Z',
      title: 'Base Title', website: '', email: '', address: '', runSlug: ''
    }]);
    const before = await snapshot(store);
    failPersist(store);
    await expectThrow(() => store.addNumbers([{
      id: 'rb-m-dup', phone: '+66100000003', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-03-04T00:00:00.000Z',
      title: 'Would Merge', website: 'https://filled.example', email: 'filled@example.com',
      address: '99 Test Rd', runSlug: 'run-merge'
    }]));
    const after = await snapshot(store);
    assert.deepStrictEqual(after, before, 'merge must be fully rolled back to pristine values');
    const row = after.find(r => r.id === 'rb-m');
    assert.ok(row, 'merged row must survive');
    assert.strictEqual(row.title, 'Base Title', 'existing title untouched');
    assert.strictEqual(row.website, '', 'filled website must be restored to empty');
    assert.strictEqual(row.email, '', 'filled email must be restored to empty');
    assert.strictEqual(row.runSlug, '', 'filled runSlug must be restored to empty');
    assert.strictEqual(row.source, 'base-src', 'first-writer source preserved');
    assert.strictEqual(row.keyword, 'base-kw', 'first-writer keyword preserved');
    assert.strictEqual(row.collectedAt, '2026-03-03T00:00:00.000Z', 'original timestamp preserved');
  });

  test('3. failed persist during delete restores every field of the removed rows', async () => {
    const store = await openStore();
    await store.addNumbers([
      {
        id: 'rb-d1', phone: '+66100000004', source: 'src-4', keyword: 'kw-4',
        status: 'pending', collectedAt: '2026-03-05T00:00:00.000Z',
        title: 'Del One', website: 'https://one.example', email: 'one@example.com',
        address: '1 One Rd', runSlug: 'run-d1'
      },
      {
        id: 'rb-d2', phone: '+66100000005', source: '', keyword: '',
        status: 'pending', collectedAt: '2026-03-06T00:00:00.000Z'
      }
    ]);
    const before = await snapshot(store);
    failPersist(store);
    await expectThrow(() => store.deleteNumbers(['rb-d1']));
    const after = await snapshot(store);
    assert.deepStrictEqual(after, before, 'delete rollback must restore all 11 fields exactly');
    assert.strictEqual(after.length, before.length, 'no row may be lost or duplicated');
    const restored = after.find(r => r.id === 'rb-d1');
    assert.ok(restored, 'removed row must be restored');
    assert.strictEqual(restored.title, 'Del One');
    assert.strictEqual(restored.website, 'https://one.example');
    assert.strictEqual(restored.email, 'one@example.com');
    assert.strictEqual(restored.address, '1 One Rd');
    assert.strictEqual(restored.runSlug, 'run-d1');
    assert.strictEqual(restored.source, 'src-4');
    assert.strictEqual(restored.keyword, 'kw-4');
  });

  test('4. library stays consistent on disk and writable after a rolled-back failure', async () => {
    const store = await openStore();
    failPersist(store);
    await expectThrow(() => store.addNumbers([{
      id: 'rb-x', phone: '+66100000006', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-03-07T00:00:00.000Z'
    }]));
    delete store.saveDB;
    const res = await store.addNumbers([{
      id: 'rb-y', phone: '+66100000007', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-03-08T00:00:00.000Z'
    }]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 0 }, 'subsequent add must succeed');
    const rows = await snapshot(store);
    assert.ok(!rows.some(r => r.id === 'rb-x'), 'failed row never enters the library');
    assert.ok(rows.some(r => r.id === 'rb-y'), 'recovered row present in memory');

    const reopened = await openStore();
    const diskRows = await snapshot(reopened);
    assert.ok(!diskRows.some(r => r.id === 'rb-x'), 'failed row never reaches the database file');
    assert.ok(diskRows.some(r => r.id === 'rb-y'), 'recovered row persisted to the database file');
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
