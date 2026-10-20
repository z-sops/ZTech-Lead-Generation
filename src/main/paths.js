'use strict';

/**
 * F1 - the product identity and the data directory.
 *
 * The product is **ZTech Lead Generation**, the technology brand is
 * **ZuniTech**, and the parent company is **Zuni Enterprise**. No registered
 * address, company number or jurisdiction appears here, because none has been
 * confirmed; the legal documents carry a clearly flagged placeholder instead.
 *
 * WHY THIS MODULE EXISTS
 *
 * The application used to be shipped as "phone全球获客" (package name
 * `phone-global-leads`, appId `com.whatsapp.automation`). On Windows, Electron
 * derives the user-data directory from the application name, so renaming the
 * product WITHOUT this module would point the app at an empty directory and
 * every existing user would silently lose their lead library, their
 * credentials, their mailbox tokens, their consent records and their settings.
 *
 * So the data directory is resolved EXPLICITLY, and an old directory is
 * migrated rather than abandoned:
 *
 *   1. The target is the product's own folder under the platform app-data
 *      directory - UNLESS the caller has already chosen a directory of its
 *      own (which is what a test, or an explicit `app.setPath`, looks like).
 *   2. If the target already holds data, it is used unchanged.
 *   3. Otherwise, if a LEGACY directory holds data, it is MOVED to the target
 *      (a rename on the same volume is atomic; a copy is used when the rename
 *      is not possible) and the target is used.
 *   4. If the migration cannot be completed, the LEGACY directory is used
 *      unchanged, so the user keeps their data even when the move fails.
 *
 * The migration is recorded with a marker file, so it is never repeated.
 *
 * CLOUD REUSE: nothing here knows about Electron. The platform app-data
 * directory is an argument, so the same resolution runs in a server
 * deployment.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The product's data folder on disk. */
const PRODUCT_FOLDER = 'ZTech Lead Generation';

/**
 * The directories the product used to keep its data in. Every one of them is
 * a real place an existing installation may have its data:
 *
 *   - `phone全球获客` was the electron-builder productName, so Electron's
 *     userData directory was `%APPDATA%\phone全球获客`.
 *   - `phone-global-leads` was the package name, used by the acceptance
 *     tooling and by some installs.
 *   - `com.whatsapp.automation` was the appId, used by some installers.
 */
const LEGACY_FOLDERS = Object.freeze(['phone全球获客', 'phone-global-leads', 'com.whatsapp.automation']);

/** The marker that records a completed migration. */
const MIGRATION_MARKER = '.ztech-identity-migration.json';

/**
 * Does this directory hold anything worth migrating?
 * A directory that exists but is empty is not a user installation.
 */
function directoryHasContent(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Move `from` to `to`, without ever destroying the source.
 *
 * A rename is tried first: it is atomic on the same volume. If the rename
 * fails (a different volume, a locked file), the contents are copied, the
 * copy is verified, and only then is the source removed. If anything goes
 * wrong the source is left exactly as it was.
 *
 * @returns {{moved: boolean, mode: 'rename'|'copy'|'none', error?: string}}
 */
function moveDirectoryContents(from, to) {
  try {
    fs.mkdirSync(to, { recursive: true });
    fs.renameSync(from, to);
    return { moved: true, mode: 'rename' };
  } catch {
    // Fall through to a copy. A failed rename leaves the source untouched.
  }

  try {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from)) {
      fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true, force: true, errorOnExist: false });
    }
    // The source is removed only after every entry was copied.
    for (const entry of fs.readdirSync(from)) {
      fs.rmSync(path.join(from, entry), { recursive: true, force: true });
    }
    fs.rmdirSync(from);
    return { moved: true, mode: 'copy' };
  } catch (copyErr) {
    return { moved: false, mode: 'none', error: copyErr && copyErr.message };
  }
}

/**
 * The first legacy directory that holds data.
 * @returns {string|null}
 */
function findLegacyDirectory(appData, legacyFolders, fsImpl = fs) {
  for (const folder of legacyFolders) {
    const candidate = path.join(appData, folder);
    try {
      if (!fsImpl.existsSync(candidate)) continue;
    } catch {
      continue;
    }
    if (!directoryHasContent(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Resolve the directory the product keeps its data in.
 *
 * @param {{appData: string, productFolder?: string, legacyFolders?: string[],
 *          userDataPath?: string, defaultUserDataPath?: string,
 *          fsImpl?: object, logger?: object}} options
 * @returns {{userDataPath: string, dataPath: string, logPath: string,
 *            migratedFrom: string|null, migrationMode: string|null, reason: string}}
 */
function resolveUserDataPath(options = {}) {
  const {
    appData,
    productFolder = PRODUCT_FOLDER,
    legacyFolders = LEGACY_FOLDERS,
    userDataPath = null,
    defaultUserDataPath = null,
    fsImpl = fs,
    logger = null,
  } = options;

  if (!appData) throw new TypeError('resolveUserDataPath needs the platform app-data directory');

  const productPath = path.join(appData, productFolder);

  // The target is the product's own folder, unless the caller has already
  // chosen a directory of its own (a test, or an explicit app.setPath call).
  const chosen = userDataPath && userDataPath !== defaultUserDataPath ? userDataPath : null;
  const target = chosen || productPath;

  const result = {
    userDataPath: target,
    dataPath: path.join(target, 'data'),
    logPath: path.join(target, 'logs'),
    migratedFrom: null,
    migrationMode: null,
    reason: 'fresh',
  };

  const legacy = findLegacyDirectory(appData, legacyFolders, fsImpl);

  // The target already holds data: use it, migrate nothing.
  if (directoryHasContent(target)) {
    result.reason = legacy ? 'existing' : 'existing';
    return result;
  }

  if (!legacy) {
    result.reason = 'fresh';
    return result;
  }

  // A legacy installation holds data and the target is empty: move it.
  const moved = moveDirectoryContents(legacy, target);
  if (moved.moved) {
    result.migratedFrom = legacy;
    result.migrationMode = moved.mode;
    result.reason = 'migrated';
    if (logger && typeof logger.info === 'function') {
      logger.info('paths', 'the product data directory was migrated', { from: legacy, to: target, mode: moved.mode });
    }
    try {
      fsImpl.writeFileSync(
        path.join(target, MIGRATION_MARKER),
        JSON.stringify({ migratedFrom: legacy, migratedAt: new Date().toISOString(), mode: moved.mode }, null, 2) + '\n',
        'utf8',
      );
    } catch {
      // The marker is a convenience, not a correctness requirement.
    }
    return result;
  }

  // The move failed: keep using the legacy directory, so the user does not
  // lose their data because of a file lock.
  result.userDataPath = legacy;
  result.dataPath = path.join(legacy, 'data');
  result.logPath = path.join(legacy, 'logs');
  result.reason = 'legacy-fallback';
  if (logger && typeof logger.warn === 'function') {
    logger.warn('paths', 'the product data directory could not be migrated; the previous location is used', {
      from: legacy,
      to: target,
      error: moved.error || null,
    });
  }
  return result;
}

module.exports = {
  PRODUCT_FOLDER,
  LEGACY_FOLDERS,
  MIGRATION_MARKER,
  resolveUserDataPath,
  findLegacyDirectory,
  moveDirectoryContents,
  directoryHasContent,
};
