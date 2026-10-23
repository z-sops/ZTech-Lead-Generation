'use strict';

/**
 * Live demonstration of the F0 database backup and restore path.
 *
 * This is the evidence for the F0 review: it shows, on a real file system,
 * that a corrupted primary database is recovered from the rolling `.bak`,
 * that the unreadable original is preserved, and that a failed save leaves
 * the last good copy byte-identical.
 *
 * Usage: node scripts/demo-backup-recovery.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-restore-demo-'));

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => root } },
};
const realLogger = require.resolve(path.join(process.cwd(), 'src', 'main', 'logger.js'));
require.cache[realLogger] = {
  id: realLogger, filename: realLogger, loaded: true,
  exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } },
};

const { AccountStore } = require(path.join(process.cwd(), 'src', 'main', 'accountStore.js'));

const dbPath = path.join(root, 'data', 'whatsapp.db');
const bakPath = dbPath + '.bak';

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}
function line(label, value) {
  console.log(`  ${label.padEnd(38)} ${value}`);
}

(async () => {
  console.log('ZTech F0 - database backup and restore demonstration');
  console.log(`  data directory: ${path.join(root, 'data')}`);
  console.log('');

  const store = new AccountStore();
  await store.ready;
  await store.addNumbers([{ phone: '+10000000001', title: 'Alpha Trading', email: 'a@example.com' }]);
  store.saveDB();

  console.log('STEP 1 - after the first save');
  line('primary exists', fs.existsSync(dbPath));
  line('primary size (bytes)', fs.statSync(dbPath).size);
  line('backup exists', fs.existsSync(bakPath));
  line('backup size (bytes)', fs.statSync(bakPath).size);
  const primaryHash1 = sha(dbPath);
  line('primary sha256[0:16]', primaryHash1);
  console.log('');

  console.log('STEP 2 - exactly one more write; the .bak becomes the previous state');
  const beforeWrite = sha(dbPath);
  reopened_probe: {
    // A single controlled write, so the "one write behind" relationship is exact.
    store.db.run("INSERT INTO numbers (id, phone, title) VALUES ('demo-1', '+10000000009', 'Delta Trading')");
    store.saveDB();
  }
  const primaryHash2 = sha(dbPath);
  line('primary sha256[0:16] (new)', primaryHash2);
  line('backup sha256[0:16] (previous)', sha(bakPath));
  line('backup == the file before the write', sha(bakPath) === beforeWrite);
  line('primary != backup', primaryHash2 !== sha(bakPath));
  console.log('');

  console.log('STEP 3 - the primary file is corrupted (simulated disk damage)');
  fs.writeFileSync(dbPath, Buffer.from('CORRUPTED - this is not a sqlite database'));
  line('primary sha256[0:16]', sha(dbPath));
  line('backup sha256[0:16]', sha(bakPath));
  console.log('');

  console.log('STEP 4 - the app starts again and recovers');
  const reopened = new AccountStore();
  await reopened.ready;
  const status = await reopened.getStorageStatus();
  line('storage mode', status.mode);
  line('data may be incomplete', status.dataMayBeIncomplete);
  line('recovered primary sha256[0:16]', sha(dbPath));
  line('restored from the .bak', sha(dbPath) === sha(bakPath));
  const quarantined = fs.readdirSync(path.join(root, 'data')).filter((n) => n.includes('.corrupt-'));
  line('unreadable original preserved', quarantined.length > 0 ? quarantined.join(', ') : 'NONE');
  const leads = await reopened.getCollectedNumbers();
  line('leads readable after recovery', leads.length);
  console.log('');

  console.log('STEP 5 - a failed save must not damage the last good copy');
  const goodHash = sha(dbPath);
  const realExport = reopened.db.export;
  reopened.db.export = () => { throw new Error('simulated export failure'); };
  let threw = false;
  try { reopened.saveDB(); } catch { threw = true; }
  reopened.db.export = realExport;
  line('the failure was reported to the caller', threw);
  line('primary unchanged (sha matches)', sha(dbPath) === goodHash);
  const leftovers = fs.readdirSync(path.join(root, 'data')).filter((n) => n.includes('.tmp'));
  line('no temporary file left behind', leftovers.length === 0);
  console.log('');

  fs.rmSync(root, { recursive: true, force: true });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
