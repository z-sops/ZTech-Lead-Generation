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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p10-l3-'));

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
  const { AccountStore } = require(accountStorePath);

  const store = new AccountStore();
  await store.ready;
  store.db = null; // force JSON fallback path

  const numbersPath = path.join(testRoot, 'data', 'numbers.json');
  const tmpPath = numbersPath + '.tmp';
  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  const realUnlink = fs.unlinkSync;

  function seedFile(content) {
    realWrite.call(fs, numbersPath, content, 'utf-8');
  }

  function readDest() {
    return fs.readFileSync(numbersPath, 'utf-8');
  }

  function restoreFs() {
    fs.writeFileSync = realWrite;
    fs.renameSync = realRename;
    fs.unlinkSync = realUnlink;
  }

  function runExpectingError(fn) {
    try {
      fn();
      return { thrown: null };
    } catch (err) {
      return { thrown: err };
    } finally {
      restoreFs();
    }
  }

  test('1. successful write replaces destination', () => {
    seedFile(JSON.stringify([{ id: 'stale', phone: '+66111111111' }], null, 2));
    store._numbers = [];
    const res = store._addNumbers([{ id: 'new1', phone: '+66222222222' }]);
    assert.strictEqual(res.added, 1);
    const parsed = JSON.parse(readDest());
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].id, 'new1');
    assert.ok(!fs.existsSync(tmpPath), 'temporary file must not remain after success');
  });

  test('2. failed temp write preserves existing destination', () => {
    seedFile(JSON.stringify([{ id: 'old', phone: '+66111111111' }], null, 2));
    store._numbers = [{ id: 'old', phone: '+66111111111' }];
    const before = readDest();
    const injected = new Error('injected: temp write failure');
    fs.writeFileSync = function (p, ...rest) {
      if (String(p).endsWith('.tmp')) {
        realWrite.call(fs, p, '[{"partial', 'utf-8');
        throw injected;
      }
      return realWrite.call(fs, p, ...rest);
    };
    const { thrown } = runExpectingError(() => store._addNumbers([{ id: 'newX', phone: '+66333333333' }]));
    assert.strictEqual(thrown, injected);
    assert.strictEqual(readDest(), before, 'destination must be byte-identical after failed temp write');
    assert.deepStrictEqual(store._numbers, [{ id: 'old', phone: '+66111111111' }], 'in-memory backup must be restored');
  });

  test('3. failed replacement preserves existing destination', () => {
    seedFile(JSON.stringify([{ id: 'old', phone: '+66111111111' }], null, 2));
    store._numbers = [{ id: 'old', phone: '+66111111111' }];
    const before = readDest();
    const injected = new Error('injected: rename failure');
    fs.renameSync = function (p, ...rest) {
      if (String(p).endsWith('numbers.json.tmp')) throw injected;
      return realRename.call(fs, p, ...rest);
    };
    const { thrown } = runExpectingError(() => store._addNumbers([{ id: 'newY', phone: '+66444444444' }]));
    assert.strictEqual(thrown, injected);
    assert.strictEqual(readDest(), before, 'destination must be byte-identical after failed replacement');
    assert.ok(!fs.existsSync(tmpPath), 'temporary file must be removed after failed replacement');
  });

  test('4. temporary file cleanup is attempted', () => {
    seedFile('[]');
    store._numbers = [];
    const injected = new Error('injected: rename failure');
    const unlinkCalls = [];
    fs.renameSync = function (p, ...rest) {
      if (String(p).endsWith('numbers.json.tmp')) throw injected;
      return realRename.call(fs, p, ...rest);
    };
    fs.unlinkSync = function (p) {
      unlinkCalls.push(String(p));
      return realUnlink.call(fs, p);
    };
    runExpectingError(() => store._addNumbers([{ id: 'newZ', phone: '+66777777777' }]));
    assert.ok(unlinkCalls.some(p => p.endsWith('numbers.json.tmp')), 'cleanup must be attempted for the temporary file');
    assert.ok(!fs.existsSync(tmpPath), 'temporary file must be gone after cleanup');
  });

  test('5. original error is rethrown', () => {
    seedFile('[]');
    store._numbers = [];

    const writeErr = new Error('injected: temp write failure');
    fs.writeFileSync = function (p, ...rest) {
      if (String(p).endsWith('.tmp')) throw writeErr;
      return realWrite.call(fs, p, ...rest);
    };
    const r1 = runExpectingError(() => store._addNumbers([{ id: 'a1', phone: '+66888888888' }]));
    assert.strictEqual(r1.thrown, writeErr, 'temp write failure must rethrow the original error');

    const renameErr = new Error('injected: rename failure');
    fs.renameSync = function (p, ...rest) {
      if (String(p).endsWith('numbers.json.tmp')) throw renameErr;
      return realRename.call(fs, p, ...rest);
    };
    const r2 = runExpectingError(() => store._addNumbers([{ id: 'a2', phone: '+66999999999' }]));
    assert.strictEqual(r2.thrown, renameErr, 'replacement failure must rethrow the original error');
  });

  test('6. JSON content remains valid after successful write', () => {
    store._numbers = [];
    seedFile('[]');
    store._addNumbers([{
      id: 'j1',
      phone: '+66 81-234.5678',
      status: 'pending',
      source: 'test',
      collectedAt: '2026-01-01T00:00:00.000Z'
    }]);
    const parsed = JSON.parse(readDest());
    assert.ok(Array.isArray(parsed));
    assert.strictEqual(parsed.length, 1);
    assert.strictEqual(parsed[0].phone, '+66 81-234.5678', 'stored phone must be byte-identical (no normalization)');
    assert.strictEqual(parsed[0].status, 'pending');
    assert.ok(!fs.existsSync(tmpPath));
  });

  test('7. deleteNumbers JSON path performs atomic write', async () => {
    store._numbers = [{ id: 'd1', phone: '+66555555555' }, { id: 'd2', phone: '+66666666666' }];
    seedFile(JSON.stringify(store._numbers, null, 2));
    const res = await store.deleteNumbers(['d1']);
    assert.deepStrictEqual(res, { success: true });
    const parsed = JSON.parse(readDest());
    assert.deepStrictEqual(parsed.map(n => n.id), ['d2']);
    assert.ok(!fs.existsSync(tmpPath));
  });

  test('8. atomic helper wired at both JSON call sites, no direct writes remain', () => {
    assert.ok(source.includes('function writeJsonAtomic('), 'helper must exist');
    assert.ok(source.includes('fs.renameSync(tmpPath, filePath)'), 'helper must use rename replacement');
    assert.ok(source.includes('fs.unlinkSync(tmpPath)'), 'helper must attempt temporary file cleanup');
    assert.ok(source.includes('throw err'), 'helper must rethrow the original error');
    const callSites = source.split("writeJsonAtomic(path.join(DATA_DIR, 'numbers.json')").length - 1;
    assert.strictEqual(callSites, 2, 'both JSON write sites must use the helper');
    const direct = source.split("fs.writeFileSync(path.join(DATA_DIR, 'numbers.json')").length - 1;
    assert.strictEqual(direct, 0, 'no direct fs.writeFileSync of numbers.json may remain');
  });

  test('9. scope guards: canonicalPhone and SQL persistence untouched', () => {
    assert.ok(source.includes("return phone.replace(/[\\s\\-.()]/g, '');"), 'canonicalPhone must be byte-identical');
    assert.ok(source.includes('fs.renameSync(tmpPath, this.dbPath)'), 'SQL saveDB path must remain as before');
    assert.ok(source.includes("this.db.run('DELETE FROM numbers WHERE id = ?', [id])"), 'SQL delete must remain');
    assert.ok(source.includes('INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES'), 'SQL rollback insert must remain');
  });

  test('10. delete removes exactly matching ids, preserves order and handles duplicate ids', async () => {
    store._numbers = [
      { id: 'x1', phone: '+66111111111' },
      { id: 'x2', phone: '+66222222222' },
      { id: 'x3', phone: '+66333333333' },
      { id: 'x4', phone: '+66444444444' }
    ];
    seedFile(JSON.stringify(store._numbers, null, 2));
    const res = await store.deleteNumbers(['x2', 'x2', 'x999']);
    assert.deepStrictEqual(res, { success: true });
    assert.deepStrictEqual(store._numbers.map(n => n.id), ['x1', 'x3', 'x4']);
    assert.deepStrictEqual(JSON.parse(readDest()).map(n => n.id), ['x1', 'x3', 'x4']);
    assert.ok(!fs.existsSync(tmpPath));
  });

  test('11. failed delete preserves destination file and in-memory state', async () => {
    store._numbers = [{ id: 'y1', phone: '+66111111111' }, { id: 'y2', phone: '+66222222222' }];
    seedFile(JSON.stringify(store._numbers, null, 2));
    const before = readDest();
    const injected = new Error('injected: rename failure during delete');
    fs.renameSync = function (p, ...rest) {
      if (String(p).endsWith('numbers.json.tmp')) throw injected;
      return realRename.call(fs, p, ...rest);
    };
    let thrown = null;
    try {
      await store.deleteNumbers(['y1']);
    } catch (err) {
      thrown = err;
    } finally {
      restoreFs();
    }
    assert.strictEqual(thrown, injected);
    assert.strictEqual(readDest(), before, 'destination must be byte-identical after failed delete');
    assert.deepStrictEqual(store._numbers.map(n => n.id), ['y1', 'y2'], 'in-memory backup must be restored');
    assert.ok(!fs.existsSync(tmpPath));
  });

  test('12. delete uses Set membership, no O(rows x ids) includes scans remain', () => {
    const setCount = source.split('new Set(ids)').length - 1;
    assert.strictEqual(setCount, 2, 'both JSON and SQL delete paths must build an id Set');
    assert.ok(!source.includes('ids.includes'), 'per-row ids.includes scans must be gone');
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
