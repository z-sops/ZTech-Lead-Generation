'use strict';

// F0 (audit gap G-10): the primary store is the sql.js database export, which
// is rewritten wholesale on every save. Before this test existed there was no
// backup, no restore path, and no test proving either. A crash mid-write
// could destroy the only copy of every lead, suppression and consent record.
//
// This suite proves three things:
//   1. every successful save leaves a readable rolling `.bak` of the previous file;
//   2. a corrupt primary file is recovered from that `.bak` instead of silently
//      presenting the user with an empty lead library;
//   3. a failed save leaves the previous good file untouched and removes its
//      own temporary file.

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

function loadAccountStore(testRoot) {
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
  delete require.cache[accountStorePath];
  return require(accountStorePath);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-backup-'));
  const { AccountStore } = loadAccountStore(testRoot);

  const dbPath = path.join(testRoot, 'data', 'whatsapp.db');
  const backupPath = dbPath + '.bak';

  const store = new AccountStore();
  await store.ready;

  test('1. the store opened in SQL mode (the SQL path is the one under test)', () => {
    assert.ok(store.db, 'a sql.js database is open');
    assert.ok(fs.existsSync(dbPath), 'the database file exists on disk');
  });

  test('2. a save creates a rolling .bak of the previous database file', async () => {
    await store.addNumbers([{ phone: '+10000000001', title: 'Alpha Trading' }]);
    store.saveDB();
    assert.ok(fs.existsSync(backupPath), 'a .bak file exists after the first save');

    // The backup must be a real, openable database - not a truncated file.
    const SQL = await require('sql.js')();
    const backup = fs.readFileSync(backupPath);
    const db = new SQL.Database(backup);
    const rows = db.exec('SELECT COUNT(*) FROM numbers');
    assert.ok(rows.length > 0, 'the backup contains the numbers table');
    db.close();
  });

  test('3. the .bak is exactly the file as it was before the last write', async () => {
    const before = fs.readFileSync(dbPath);

    // One controlled write, so the "one write behind" relationship is exact.
    store.db.run("INSERT INTO numbers (id, phone, title) VALUES ('manual-1', '+10000000009', 'Delta Trading')");
    store.saveDB();

    assert.ok(
      fs.readFileSync(backupPath).equals(before),
      'the .bak is byte-identical to the file as it was before the last write'
    );

    const SQL = await require('sql.js')();
    const current = new SQL.Database(fs.readFileSync(dbPath));
    const rows = current.exec("SELECT phone FROM numbers WHERE id = 'manual-1'");
    assert.strictEqual(rows.length, 1, 'the primary file holds the new lead');
    current.close();
  });

  test('4. a corrupt primary file is recovered from the .bak', async () => {
    const before = fs.readFileSync(backupPath);
    fs.writeFileSync(dbPath, Buffer.from('this is definitely not a sqlite database'));

    const reopened = new AccountStore();
    await reopened.ready;

    assert.ok(reopened.db, 'the store reopened the SQL database instead of falling back to JSON');
    assert.ok(
      fs.readFileSync(dbPath).equals(before),
      'the primary file was restored byte-for-byte from the backup'
    );

    const quarantined = fs.readdirSync(path.dirname(dbPath))
      .filter((n) => n.startsWith('whatsapp.db.corrupt-'));
    assert.ok(quarantined.length >= 1, 'the unreadable original was preserved for diagnosis');

    const status = await reopened.getStorageStatus();
    assert.ok(status.dataMayBeIncomplete, 'the UI is told the data may be one save behind');
  });

  test('5. a failed save leaves the previous good file untouched', async () => {
    const good = fs.readFileSync(dbPath);
    const realExport = store.db.export;
    store.db.export = () => { throw new Error('simulated export failure'); };
    let threw = false;
    try {
      store.saveDB();
    } catch (err) {
      threw = true;
    }
    store.db.export = realExport;

    assert.ok(threw, 'the failed save reported the error to its caller');
    assert.ok(fs.readFileSync(dbPath).equals(good), 'the previous database file is byte-identical');

    const leftovers = fs.readdirSync(path.dirname(dbPath))
      .filter((n) => n.includes('.tmp') && n.startsWith('.whatsapp.db'));
    assert.strictEqual(leftovers.length, 0, 'no temporary file was left behind');
  });

  test('6. the store still works normally after the recovery', async () => {
    const reopened = new AccountStore();
    await reopened.ready;
    await reopened.addNumbers([{ phone: '+10000000003', title: 'Gamma Trading' }]);
    reopened.saveDB();
    const rows = await reopened.getCollectedNumbers();
    assert.ok(rows.some((r) => r.phone === '+10000000003'), 'new leads can still be written');
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

  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (cleanupErr) { /* best effort */ }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log(String((err && err.stack) || err));
  console.log('0 passed, 1 failed');
  process.exit(1);
});
