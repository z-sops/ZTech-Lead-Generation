'use strict';

// F1 - the product identity and the data directory, and the SAFETY of the
// migration between the product's previous name and its current one.
//
// The product used to be shipped as "phone全球获客" (package name
// `phone-global-leads`, appId `com.whatsapp.automation`). Electron derives the
// user-data directory from the application name, so the rename would have
// pointed the app at an EMPTY directory and every existing user would have
// silently lost their lead library, their credentials, their mailbox tokens,
// their consent records and their settings.
//
// The rules under test:
//   1. the old directory is COPIED and VERIFIED, never renamed away;
//   2. the ORIGINAL is never deleted - it stays as the user's rollback copy;
//   3. a failed migration leaves the product on the ORIGINAL directory;
//   4. a corrupt database, a truncated file, an unparseable settings file and
//      a full disk all end with the user's data intact;
//   5. a rollback is possible, and it is verified before it is accepted.
//
// The checks are SYNCHRONOUS, so the resolution can run while the product's
// modules are still loading.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveUserDataPath,
  findLegacyDirectory,
  copyDirectoryVerified,
  rollbackUserData,
  verifyDirectoryIntegrity,
  listFilesRecursive,
  hashFile,
  directoryHasContent,
  PRODUCT_FOLDER,
  LEGACY_FOLDERS,
  MIGRATION_MARKER,
} = require('../src/main/paths');
const { verifyDatabase, verifySettings, verifyUserData } = require('../src/main/dataIntegrity');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-identity-'));
}

/**
 * Remove a directory tree, tolerating a Windows file lock.
 *
 * The first CI run crashed one Windows job with STATUS_STACK_BUFFER_OVERRUN
 * while this file was creating and deleting a dozen temporary trees in a row.
 * The crash is in the file system, not in the assertions, so the cleanup is
 * made patient and a cleanup failure never fails a test.
 */
function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // A locked file must never fail a test that already passed.
  }
}

/** A realistic installation: a database, a settings file and a log. */
function seedInstall(root, folder, files = ['data/whatsapp.db', 'config.json', 'logs/app-2026-10-20.log']) {
  for (const f of files) {
    const full = path.join(root, folder, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `content of ${f}`);
  }
}

/** A minimal but structurally valid SQLite file (header + one page). */
function seedSqlite(root, folder) {
  const dir = path.join(root, folder, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const page = Buffer.alloc(4096);
  page.write('SQLite format 3\0', 0, 'latin1');
  page.writeUInt16BE(4096, 16);
  page.writeUInt8(1, 18);
  page.writeUInt8(1, 19);
  fs.writeFileSync(path.join(dir, 'whatsapp.db'), page);
  fs.writeFileSync(path.join(root, folder, 'config.json'), JSON.stringify({ settings: { a: 1 }, providers: {} }));
}

/* ------------------------------------------------------------- migration -- */

test('a fresh installation uses the product folder', () => {
  const root = tempRoot();
  const r = resolveUserDataPath({ appData: root });
  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.dataPath, path.join(root, PRODUCT_FOLDER, 'data'));
  assert.equal(r.logPath, path.join(root, PRODUCT_FOLDER, 'logs'));
  assert.equal(r.reason, 'fresh');
  assert.equal(r.migratedFrom, null);
  cleanup(root);
});

test('an installation under the previous product name is COPIED, and the original is KEPT', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.migratedFrom, path.join(root, 'phone全球获客'));
  assert.equal(r.migrationMode, 'copy');
  assert.equal(r.reason, 'migrated');
  assert.equal(r.integrity.ok, true, 'the copy verified');
  assert.equal(r.integrity.verified, true);

  // The data is where the product now looks for it.
  assert.equal(fs.readFileSync(path.join(r.dataPath, 'whatsapp.db'), 'utf8'), 'content of data/whatsapp.db');
  assert.ok(fs.existsSync(path.join(r.userDataPath, 'config.json')), 'the settings came across too');
  assert.ok(fs.existsSync(path.join(r.logPath, 'app-2026-10-20.log')), 'the logs came across too');

  // THE ORIGINAL IS NOT DELETED. It is the user's rollback copy.
  assert.ok(fs.existsSync(path.join(root, 'phone全球获客', 'data', 'whatsapp.db')), 'the original database is preserved');
  assert.ok(fs.existsSync(path.join(root, 'phone全球获客', 'config.json')), 'the original settings are preserved');

  // The marker records where the original is, and that it is preserved.
  const marker = JSON.parse(fs.readFileSync(path.join(r.userDataPath, MIGRATION_MARKER), 'utf8'));
  assert.equal(marker.migratedFrom, path.join(root, 'phone全球获客'));
  assert.equal(marker.sourcePreserved, true);
  assert.equal(marker.verified, true);
  cleanup(root);
});

test('every previous directory name is copied across', () => {
  for (const folder of LEGACY_FOLDERS) {
    const root = tempRoot();
    seedInstall(root, folder);
    const r = resolveUserDataPath({ appData: root });
    assert.equal(r.migratedFrom, path.join(root, folder), folder + ' is copied');
    assert.equal(r.integrity.ok, true);
    assert.ok(fs.existsSync(path.join(root, folder, 'data', 'whatsapp.db')), folder + ': the original is preserved');
    cleanup(root);
  }
});

test('an installation that already has the new folder is NOT overwritten', () => {
  const root = tempRoot();
  seedInstall(root, PRODUCT_FOLDER, ['data/whatsapp.db', 'data/current-only.txt']);
  seedInstall(root, 'phone全球获客', ['data/whatsapp.db']);

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.migratedFrom, null, 'nothing was copied');
  assert.ok(fs.existsSync(path.join(r.dataPath, 'current-only.txt')), 'the current data is untouched');
  assert.ok(fs.existsSync(path.join(root, 'phone全球获客', 'data', 'whatsapp.db')), 'the old directory is left alone');
  cleanup(root);
});

test('an empty old directory is not treated as an installation', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'phone全球获客'), { recursive: true });
  const r = resolveUserDataPath({ appData: root });
  assert.equal(r.migratedFrom, null);
  assert.equal(r.reason, 'fresh');
  cleanup(root);
});

test('a caller that has chosen its own directory keeps it', () => {
  const root = tempRoot();
  const chosen = path.join(root, 'a-chosen-directory');
  fs.mkdirSync(chosen, { recursive: true });
  const r = resolveUserDataPath({ appData: root, userDataPath: chosen, defaultUserDataPath: path.join(root, PRODUCT_FOLDER) });
  assert.equal(r.userDataPath, chosen);
  cleanup(root);
});

test("Electron's own default directory is not treated as a chosen one", () => {
  const root = tempRoot();
  const r = resolveUserDataPath({
    appData: root,
    userDataPath: path.join(root, PRODUCT_FOLDER),
    defaultUserDataPath: path.join(root, PRODUCT_FOLDER),
  });
  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  cleanup(root);
});

/* ----------------------------------------------------------- failure modes -- */

test('a copy that does not verify leaves the product on the ORIGINAL directory', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');
  const legacy = path.join(root, 'phone全球获客');

  // A destination that is a FILE cannot be a directory: the copy cannot land.
  const blocked = path.join(root, PRODUCT_FOLDER);
  fs.writeFileSync(blocked, 'not a directory');

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, legacy, 'the original directory is used');
  assert.equal(r.reason, 'legacy-fallback');
  assert.ok(r.error, 'the reason is reported');
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'whatsapp.db')), 'the data is still there');
  cleanup(root);
});

test('a disk failure during the copy leaves the original intact', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');
  const legacy = path.join(root, 'phone全球获客');

  // Only the WRITE path fails, exactly as a full disk would.
  const enospc = new Error('ENOSPC: no space left on device');
  const broken = {
    existsSync: fs.existsSync,
    mkdirSync: (p, o) => { if (String(p).includes('.migrating-')) throw enospc; return fs.mkdirSync(p, o); },
    readdirSync: fs.readdirSync,
    renameSync: () => { throw enospc; },
    cpSync: () => { throw enospc; },
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
  };

  const r = resolveUserDataPath({ appData: root, fsImpl: broken });

  assert.equal(r.userDataPath, legacy, 'the original directory is used');
  assert.equal(r.reason, 'legacy-fallback');
  assert.ok(r.error, 'the disk failure is reported');
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'whatsapp.db')), 'the data is still there');
  cleanup(root);
});

test('an INTERRUPTED migration leaves no half-copied directory in place', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');

  // The copy is interrupted part-way through, exactly as a crash would do.
  let copies = 0;
  const interrupted = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    readdirSync: fs.readdirSync,
    renameSync: fs.renameSync,
    cpSync: (...args) => {
      copies += 1;
      if (copies > 1) throw new Error('the process was interrupted');
      return fs.cpSync(...args);
    },
    rmSync: fs.rmSync,
    writeFileSync: fs.writeFileSync,
    statSync: fs.statSync,
    readFileSync: fs.readFileSync,
  };

  const r = resolveUserDataPath({ appData: root, fsImpl: interrupted });

  assert.ok(copies > 1, 'the copy was attempted');
  assert.equal(r.reason, 'legacy-fallback', 'the product stays on the original');
  assert.equal(r.userDataPath, path.join(root, 'phone全球获客'));
  assert.ok(fs.existsSync(path.join(root, 'phone全球获客', 'data', 'whatsapp.db')), 'the data is intact');
  // Nothing half-copied was left where the product would look.
  assert.equal(fs.existsSync(path.join(root, PRODUCT_FOLDER, 'data', 'whatsapp.db')), false);
  // And no staging directory was left behind.
  const leftovers = fs.readdirSync(root).filter((n) => n.includes('.migrating-'));
  assert.deepEqual(leftovers, [], 'the staging directory was cleaned up');
  cleanup(root);
});

/* --------------------------------------------------------------- integrity -- */

test('a truncated or foreign database is rejected', () => {
  const root = tempRoot();
  const dir = path.join(root, 'data');
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(dir, 'whatsapp.db'), 'this is not a database at all');
  const foreign = verifyDatabase(path.join(dir, 'whatsapp.db'));
  assert.equal(foreign.ok, false);
  assert.ok(/not a SQLite database/.test(foreign.error));

  const page = Buffer.alloc(4096);
  page.write('SQLite format 3\0', 0, 'latin1');
  page.writeUInt16BE(4096, 16);
  fs.writeFileSync(path.join(dir, 'whatsapp.db'), page.subarray(0, 2000));
  const truncated = verifyDatabase(path.join(dir, 'whatsapp.db'));
  assert.equal(truncated.ok, false);
  assert.ok(/truncated/.test(truncated.error));

  fs.writeFileSync(path.join(dir, 'whatsapp.db'), page);
  const good = verifyDatabase(path.join(dir, 'whatsapp.db'));
  assert.equal(good.ok, true);
  assert.equal(good.pages, 1);
  cleanup(root);
});

test('an unparseable settings file is rejected, and a missing one is fine', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'config.json'), '{not json');
  const broken = verifySettings(path.join(root, 'config.json'));
  assert.equal(broken.ok, false);

  const missing = verifySettings(path.join(root, 'absent.json'));
  assert.equal(missing.ok, true, 'a fresh install has no settings file');
  cleanup(root);
});

test('the whole user-data directory is checked at once', () => {
  const root = tempRoot();
  seedSqlite(root, PRODUCT_FOLDER);
  const good = verifyUserData(path.join(root, PRODUCT_FOLDER));
  assert.equal(good.ok, true, JSON.stringify(good));

  fs.writeFileSync(path.join(root, PRODUCT_FOLDER, 'data', 'whatsapp.db'), 'broken');
  const bad = verifyUserData(path.join(root, PRODUCT_FOLDER));
  assert.equal(bad.ok, false);
  cleanup(root);
});

test('a copy whose database is corrupt is not adopted, and the original keeps the data', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');
  const legacy = path.join(root, 'phone全球获客');

  // The copy lands, but the database in it is not a database.
  const original = resolveUserDataPath({ appData: root });
  assert.equal(original.reason, 'migrated');
  fs.writeFileSync(path.join(original.userDataPath, 'data', 'whatsapp.db'), 'not a database');

  const integrity = verifyUserData(original.userDataPath);
  assert.equal(integrity.ok, false, 'the copied data is rejected');

  // The original still has the user's data, and the product can go back to it.
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'whatsapp.db')));
  cleanup(root);
});

/* ---------------------------------------------------------------- rollback -- */

test('the preserved original can be rolled back over a damaged new directory', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');

  const migrated = resolveUserDataPath({ appData: root });
  assert.equal(migrated.reason, 'migrated');

  // The new directory is damaged.
  fs.writeFileSync(path.join(migrated.userDataPath, 'data', 'whatsapp.db'), 'broken');

  const rolled = rollbackUserData(migrated.userDataPath);
  assert.equal(rolled.ok, true, JSON.stringify(rolled));
  assert.equal(rolled.restoredFrom, path.join(root, 'phone全球获客'));
  assert.equal(
    fs.readFileSync(path.join(migrated.userDataPath, 'data', 'whatsapp.db'), 'utf8'),
    'content of data/whatsapp.db',
    'the original data is back',
  );
  cleanup(root);
});

test('a rollback with nothing preserved reports it instead of pretending', () => {
  const root = tempRoot();
  const r = rollbackUserData(path.join(root, PRODUCT_FOLDER));
  assert.equal(r.ok, false);
  assert.ok(r.error);
  cleanup(root);
});

/* ----------------------------------------------------------------- helpers -- */

test('the helpers behave', () => {
  const root = tempRoot();
  assert.equal(directoryHasContent(path.join(root, 'nope')), false);
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
  assert.equal(directoryHasContent(path.join(root, 'empty')), false);
  fs.writeFileSync(path.join(root, 'empty', 'f.txt'), 'x');
  assert.equal(directoryHasContent(path.join(root, 'empty')), true);
  assert.equal(findLegacyDirectory(root, LEGACY_FOLDERS), null);
  assert.equal(hashFile(path.join(root, 'empty', 'f.txt')).length, 64);
  assert.deepEqual(listFilesRecursive(path.join(root, 'empty')), ['f.txt']);

  // The integrity check compares the two directories.
  fs.mkdirSync(path.join(root, 'copy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'copy', 'f.txt'), 'x');
  const same = verifyDirectoryIntegrity(path.join(root, 'empty'), path.join(root, 'copy'));
  assert.equal(same.ok, true);
  fs.writeFileSync(path.join(root, 'copy', 'f.txt'), 'different');
  const different = verifyDirectoryIntegrity(path.join(root, 'empty'), path.join(root, 'copy'));
  assert.equal(different.ok, false);
  assert.equal(different.mismatches.length, 1);
  cleanup(root);
});
