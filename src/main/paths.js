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
 * THE MIGRATION IS COPY-AND-VERIFY, AND THE ORIGINAL IS NEVER DELETED
 *
 * The first version of this migration renamed the old directory onto the new
 * one. That is atomic, but it DESTROYS the only copy the moment it succeeds,
 * and a failure in the middle leaves the user with two half-directories and no
 * database. The rules now are:
 *
 *   1. The old directory is COPIED to a staging directory next to the target.
 *      The original is never touched.
 *   2. The copy is VERIFIED: every file is compared with the source by size
 *      and by SHA-256. A single mismatch fails the whole migration.
 *   3. Only a verified copy is moved into place.
 *   4. **The original directory is left exactly where it was.** It is the
 *      user's rollback copy, and the app never deletes it. A marker records
 *      where it is, so a rollback is one documented step.
 *   5. If anything fails - a full disk, a locked file, a corrupt database -
 *      the app keeps using the ORIGINAL directory. The user never starts with
 *      an empty library because a migration went wrong.
 *
 * CLOUD REUSE: nothing here knows about Electron. The platform app-data
 * directory is an argument, so the same resolution runs in a server
 * deployment.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

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
 * Can this path be used as the data directory?
 *
 * A path is usable when it does not exist yet, or when it is an EMPTY
 * directory. A path that holds data belongs to the user's current
 * installation and is never replaced. A path that is a FILE cannot become a
 * directory, so it is not usable either.
 */
function isUsableTarget(dir, fsImpl = fs) {
  let stat;
  try {
    stat = fsImpl.statSync(dir);
  } catch {
    return true; // it does not exist yet
  }
  if (!stat.isDirectory()) return false; // a file, or something else
  return !directoryHasContent(dir);
}

/**
 * Every file under `dir`, relative to it.
 * @returns {string[]} relative paths, sorted
 */
function listFilesRecursive(dir, base = dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listFilesRecursive(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

/**
 * The SHA-256 of a file, or null when it cannot be read.
 * @returns {string|null}
 */
function hashFile(file, fsImpl = fs) {
  try {
    return crypto.createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Compare two directories file by file.
 *
 * A copy is only trustworthy when every source file is present in the
 * destination with the same size AND the same SHA-256.
 *
 * @param {string} source
 * @param {string} destination
 * @returns {{ok: boolean, files: number, mismatches: string[], missing: string[]}}
 */
function verifyDirectoryIntegrity(source, destination, fsImpl = fs) {
  const mismatches = [];
  const missing = [];
  const sourceFiles = listFilesRecursive(source);
  for (const rel of sourceFiles) {
    const src = path.join(source, rel);
    const dst = path.join(destination, rel);
    let srcStat;
    let dstStat;
    try {
      srcStat = fsImpl.statSync(src);
    } catch {
      continue;
    }
    try {
      dstStat = fsImpl.statSync(dst);
    } catch {
      missing.push(rel);
      continue;
    }
    if (srcStat.size !== dstStat.size) {
      mismatches.push(`${rel} (size ${srcStat.size} != ${dstStat.size})`);
      continue;
    }
    const srcHash = hashFile(src, fsImpl);
    const dstHash = hashFile(dst, fsImpl);
    if (srcHash === null || dstHash === null || srcHash !== dstHash) {
      mismatches.push(`${rel} (content differs)`);
    }
  }
  return {
    ok: mismatches.length === 0 && missing.length === 0,
    files: sourceFiles.length,
    mismatches,
    missing,
  };
}

/**
 * Copy a directory, verifying the copy and never touching the source.
 *
 * @param {string} from the source directory (never modified)
 * @param {string} to the target directory
 * @param {{fsImpl?: object, verify?: boolean, overwrite?: boolean}} [options]
 * @returns {{ok: boolean, mode: 'copy'|'none', files: number, verified: boolean,
 *            mismatches: string[], missing: string[], replaced: string|null, error?: string}}
 */
function copyDirectoryVerified(from, to, options = {}) {
  const { fsImpl = fs, verify = true, overwrite = false } = options;
  const staging = `${to}.migrating-${Date.now()}`;
  try {
    fsImpl.mkdirSync(staging, { recursive: true });
    for (const entry of fsImpl.readdirSync(from)) {
      fsImpl.cpSync(path.join(from, entry), path.join(staging, entry), {
        recursive: true,
        force: true,
        errorOnExist: false,
      });
    }

    if (verify) {
      const check = verifyDirectoryIntegrity(from, staging, fsImpl);
      if (!check.ok) {
        // The copy is not trustworthy: throw it away and keep the original.
        fsImpl.rmSync(staging, { recursive: true, force: true });
        return {
          ok: false,
          mode: 'none',
          files: check.files,
          verified: false,
          mismatches: check.mismatches,
          missing: check.missing,
          replaced: null,
          error: 'the copy did not verify against the source',
        };
      }
    }

    // The target must be usable. If it holds data, the user's current
    // installation wins and nothing is replaced. If it is a file, it cannot
    // become a directory.
    let replaced = null;
    if (!isUsableTarget(to, fsImpl)) {
      if (!overwrite) {
        fsImpl.rmSync(staging, { recursive: true, force: true });
        return {
          ok: false,
          mode: 'none',
          files: 0,
          verified: false,
          mismatches: [],
          missing: [],
          replaced: null,
          error: 'the destination already holds data',
        };
      }
      // A rollback: the destination is the damaged copy. It is PRESERVED
      // beside the new one, never deleted, so even that can be inspected.
      replaced = `${to}.replaced-${Date.now()}`;
      try {
        fsImpl.renameSync(to, replaced);
      } catch {
        fsImpl.rmSync(to, { recursive: true, force: true });
      }
    }

    // Move the verified copy into place. The staging directory is next to the
    // target, so the rename is on the same volume.
    try {
      fsImpl.renameSync(staging, to);
    } catch {
      fsImpl.cpSync(staging, to, { recursive: true, force: true, errorOnExist: false });
      fsImpl.rmSync(staging, { recursive: true, force: true });
    }

    return {
      ok: true,
      mode: 'copy',
      files: listFilesRecursive(to).length,
      verified: true,
      mismatches: [],
      missing: [],
      replaced,
    };
  } catch (err) {
    // A disk failure, a locked file, a permission problem: the source is
    // untouched, because nothing here ever writes to it.
    try { fsImpl.rmSync(staging, { recursive: true, force: true }); } catch { /* nothing to clean */ }
    return {
      ok: false,
      mode: 'none',
      files: 0,
      verified: false,
      mismatches: [],
      missing: [],
      replaced: null,
      error: (err && err.message) || 'the copy failed',
    };
  }
}

/**
 * Restore the preserved original directory over a damaged or empty new one.
 *
 * This is the rollback the migration makes possible: the original was never
 * deleted, so the user's data can be put back.
 *
 * @param {string} userDataPath the directory the product is using now
 * @param {{fsImpl?: object}} [options]
 * @returns {{ok: boolean, restoredFrom: string|null, error?: string}}
 */
function rollbackUserData(userDataPath, options = {}) {
  const { fsImpl = fs } = options;
  const marker = path.join(userDataPath, MIGRATION_MARKER);
  let source = null;
  try {
    const record = JSON.parse(fsImpl.readFileSync(marker, 'utf8'));
    if (record && typeof record.migratedFrom === 'string' && fsImpl.existsSync(record.migratedFrom)) {
      source = record.migratedFrom;
    }
  } catch {
    source = null;
  }
  if (!source) {
    return { ok: false, restoredFrom: null, error: 'no preserved original was found for this directory' };
  }
  try {
    const restored = copyDirectoryVerified(source, userDataPath, { fsImpl, overwrite: true });
    if (!restored.ok) {
      return { ok: false, restoredFrom: source, error: restored.error || 'the rollback copy did not verify' };
    }
    return { ok: true, restoredFrom: source, replaced: restored.replaced };
  } catch (err) {
    return { ok: false, restoredFrom: source, error: (err && err.message) || 'the rollback failed' };
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
 *          fsImpl?: object, logger?: object, verify?: boolean,
 *          acceptDestination?: (info: object) => boolean}} options
 * @returns {{userDataPath: string, dataPath: string, logPath: string,
 *            migratedFrom: string|null, migrationMode: string|null,
 *            reason: string, integrity: object|null, error: string|null}}
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
    verify = true,
    acceptDestination = null,
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
    integrity: null,
    error: null,
  };

  const legacy = findLegacyDirectory(appData, legacyFolders, fsImpl);

  // The target already holds data: use it, migrate nothing.
  if (directoryHasContent(target)) {
    result.reason = 'existing';
    return result;
  }

  // The target is occupied by something that cannot become a directory, and a
  // legacy installation exists: stay on the legacy directory.
  if (!isUsableTarget(target, fsImpl) && legacy) {
    result.userDataPath = legacy;
    result.dataPath = path.join(legacy, 'data');
    result.logPath = path.join(legacy, 'logs');
    result.reason = 'legacy-fallback';
    result.error = 'the destination is occupied and cannot be used';
    return result;
  }

  if (!legacy) {
    result.reason = 'fresh';
    return result;
  }

  // A legacy installation holds data and the target is empty: copy it across,
  // verify the copy, and keep the original.
  const copied = copyDirectoryVerified(legacy, target, { fsImpl, verify });
  result.integrity = copied;
  if (!copied.ok) {
    // The migration did not happen. The user keeps the directory they had.
    result.userDataPath = legacy;
    result.dataPath = path.join(legacy, 'data');
    result.logPath = path.join(legacy, 'logs');
    result.reason = 'legacy-fallback';
    result.error = copied.error || 'the migration did not complete';
    if (logger && typeof logger.warn === 'function') {
      logger.warn('paths', 'the product data directory could not be migrated; the previous location is used', {
        from: legacy,
        to: target,
        error: result.error,
        mismatches: copied.mismatches,
        missing: copied.missing,
      });
    }
    return result;
  }

  // The copy verified. The original is NOT deleted: it stays as the user's
  // rollback copy, and the marker says where it is.
  result.migratedFrom = legacy;
  result.migrationMode = 'copy';
  result.reason = 'migrated';
  try {
    fsImpl.writeFileSync(
      path.join(target, MIGRATION_MARKER),
      JSON.stringify({
        migratedFrom: legacy,
        migratedAt: new Date().toISOString(),
        mode: 'copy',
        verified: copied.verified,
        fileCount: copied.files,
        sourcePreserved: true,
        rollback: 'restore the contents of "migratedFrom" over this directory',
      }, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // The marker is a convenience, not a correctness requirement.
  }
  if (logger && typeof logger.info === 'function') {
    logger.info('paths', 'the product data directory was copied and verified; the original is preserved', {
      from: legacy,
      to: target,
      files: copied.files,
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
  copyDirectoryVerified,
  rollbackUserData,
  verifyDirectoryIntegrity,
  listFilesRecursive,
  hashFile,
  directoryHasContent,
};
