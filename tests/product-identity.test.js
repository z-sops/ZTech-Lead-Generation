'use strict';

// F1 - the product identity and the data directory.
//
// The product used to be shipped as "phone全球获客" (package name
// `phone-global-leads`, appId `com.whatsapp.automation`). Electron derives the
// user-data directory from the application name, so the rename would have
// pointed the app at an EMPTY directory and every existing user would have
// silently lost their lead library, their credentials, their mailbox tokens,
// their consent records and their settings.
//
// These tests prove that the old directory is MIGRATED, that a failure to
// migrate falls back to the old directory rather than losing data, and that
// nothing is moved when the new directory already holds data.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolveUserDataPath,
  findLegacyDirectory,
  moveDirectoryContents,
  directoryHasContent,
  PRODUCT_FOLDER,
  LEGACY_FOLDERS,
  MIGRATION_MARKER,
} = require('../src/main/paths');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-identity-'));
}

function seedInstall(root, folder, files = ['data/whatsapp.db', 'config.json']) {
  for (const f of files) {
    const full = path.join(root, folder, f);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `content of ${f}`);
  }
}

test('a fresh installation uses the product folder', () => {
  const root = tempRoot();
  const r = resolveUserDataPath({ appData: root });
  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.dataPath, path.join(root, PRODUCT_FOLDER, 'data'));
  assert.equal(r.logPath, path.join(root, PRODUCT_FOLDER, 'logs'));
  assert.equal(r.reason, 'fresh');
  assert.equal(r.migratedFrom, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('an installation under the previous product name is MIGRATED, not abandoned', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.migratedFrom, path.join(root, 'phone全球获客'));
  assert.ok(['rename', 'copy'].includes(r.migrationMode));
  assert.equal(r.reason, 'migrated');

  // The data is where the product now looks for it.
  const db = path.join(r.dataPath, 'whatsapp.db');
  assert.ok(fs.existsSync(db), 'the database is in the new location');
  assert.equal(fs.readFileSync(db, 'utf8'), 'content of data/whatsapp.db');
  assert.ok(fs.existsSync(path.join(r.userDataPath, 'config.json')), 'the settings came across too');

  // The old location is gone, and the migration is recorded.
  assert.equal(fs.existsSync(path.join(root, 'phone全球获客')), false);
  const marker = JSON.parse(fs.readFileSync(path.join(r.userDataPath, MIGRATION_MARKER), 'utf8'));
  assert.equal(marker.migratedFrom, path.join(root, 'phone全球获客'));
  assert.ok(marker.migratedAt);
  fs.rmSync(root, { recursive: true, force: true });
});

test('every previous directory name is migrated', () => {
  for (const folder of LEGACY_FOLDERS) {
    const root = tempRoot();
    seedInstall(root, folder);
    const r = resolveUserDataPath({ appData: root });
    assert.equal(r.migratedFrom, path.join(root, folder), folder + ' is migrated');
    assert.ok(fs.existsSync(path.join(r.dataPath, 'whatsapp.db')), folder + ': the database moved');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an installation that already has the new folder is NOT overwritten', () => {
  const root = tempRoot();
  seedInstall(root, PRODUCT_FOLDER, ['data/whatsapp.db', 'data/current-only.txt']);
  seedInstall(root, 'phone全球获客', ['data/whatsapp.db']);

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  assert.equal(r.migratedFrom, null, 'nothing was migrated');
  assert.ok(fs.existsSync(path.join(r.dataPath, 'current-only.txt')), 'the current data is untouched');
  assert.ok(fs.existsSync(path.join(root, 'phone全球获客', 'data', 'whatsapp.db')), 'the old directory is left alone');
  fs.rmSync(root, { recursive: true, force: true });
});

test('an empty old directory is not treated as an installation', () => {
  const root = tempRoot();
  fs.mkdirSync(path.join(root, 'phone全球获客'), { recursive: true });
  const r = resolveUserDataPath({ appData: root });
  assert.equal(r.migratedFrom, null);
  assert.equal(r.reason, 'fresh');
  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a caller that has chosen its own directory keeps it', () => {
  const root = tempRoot();
  const chosen = path.join(root, 'a-chosen-directory');
  fs.mkdirSync(chosen, { recursive: true });
  const r = resolveUserDataPath({ appData: root, userDataPath: chosen, defaultUserDataPath: path.join(root, PRODUCT_FOLDER) });
  assert.equal(r.userDataPath, chosen);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Electron's own default directory is not treated as a chosen one", () => {
  const root = tempRoot();
  const r = resolveUserDataPath({
    appData: root,
    userDataPath: path.join(root, PRODUCT_FOLDER),
    defaultUserDataPath: path.join(root, PRODUCT_FOLDER),
  });
  assert.equal(r.userDataPath, path.join(root, PRODUCT_FOLDER));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a move that cannot be completed falls back to the old directory, so no data is lost', () => {
  const root = tempRoot();
  seedInstall(root, 'phone全球获客');
  const legacy = path.join(root, 'phone全球获客');

  // A move onto an existing file cannot succeed.
  const blocked = path.join(root, PRODUCT_FOLDER);
  fs.writeFileSync(blocked, 'not a directory');

  const r = resolveUserDataPath({ appData: root });

  assert.equal(r.userDataPath, legacy, 'the old directory is used');
  assert.equal(r.reason, 'legacy-fallback');
  assert.equal(r.dataPath, path.join(legacy, 'data'));
  assert.ok(fs.existsSync(path.join(legacy, 'data', 'whatsapp.db')), 'the data is still there');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the helpers behave', () => {
  const root = tempRoot();
  assert.equal(directoryHasContent(path.join(root, 'nope')), false);
  fs.mkdirSync(path.join(root, 'empty'), { recursive: true });
  assert.equal(directoryHasContent(path.join(root, 'empty')), false);
  fs.writeFileSync(path.join(root, 'empty', 'f.txt'), 'x');
  assert.equal(directoryHasContent(path.join(root, 'empty')), true);
  assert.equal(findLegacyDirectory(root, LEGACY_FOLDERS), null);

  const moved = moveDirectoryContents(path.join(root, 'empty'), path.join(root, 'moved'));
  assert.equal(moved.moved, true);
  assert.ok(fs.existsSync(path.join(root, 'moved', 'f.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});
