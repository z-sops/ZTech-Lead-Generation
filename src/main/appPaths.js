'use strict';

/**
 * The resolved application paths, computed once.
 *
 * This is the ONE place that knows where the product keeps its data. It is
 * deliberately tiny and deliberately free of business logic: it resolves the
 * directories, and the migration between the product's old and new identity
 * happens exactly once, before anything else reads them.
 *
 * CLOUD REUSE: the resolution itself lives in ./paths.js and takes the
 * platform app-data directory as an argument, so it is not Electron-specific.
 * This module is the thin Electron adapter around it.
 */

const { resolveUserDataPath, PRODUCT_FOLDER } = require('./paths');
const { verifyUserData } = require('./dataIntegrity');

let cached = null;

/**
 * Resolve the paths, once.
 *
 * @returns {{userDataPath: string, dataPath: string, logPath: string,
 *            migratedFrom: string|null, migrationMode: string|null, reason: string}}
 */
function getAppPaths() {
  if (cached) return cached;

  const { app } = require('electron');
  const appData = app.getPath('appData');
  const userDataPath = app.getPath('userData');
  let defaultUserDataPath = null;
  try {
    if (typeof app.getName === 'function') {
      defaultUserDataPath = require('node:path').join(appData, app.getName());
    }
  } catch {
    defaultUserDataPath = null;
  }

  // The result is cached BEFORE the logger is loaded: the logger's own module
  // body asks for the log path, and that ask must not start a second
  // resolution.
  cached = resolveUserDataPath({ appData, userDataPath, defaultUserDataPath });

  // A copied directory that verifies byte-for-byte can still be unusable: a
  // truncated database, or a settings file that was written at the wrong
  // moment. If the copy cannot be USED, the product falls back to the
  // original directory, which was never deleted.
  if (cached.reason === 'migrated' && cached.migratedFrom) {
    const integrity = verifyUserData(cached.userDataPath);
    if (!integrity.ok) {
      const original = cached.migratedFrom;
      cached.userDataPath = original;
      cached.dataPath = require('node:path').join(original, 'data');
      cached.logPath = require('node:path').join(original, 'logs');
      cached.reason = 'legacy-fallback';
      cached.error = `the copied data could not be used: ${integrity.error}`;
      cached.integrity = integrity;
    }
  }

  // The logger is required lazily - it needs the log path, so requiring it
  // before the paths are known would be circular.
  try {
    const { logger } = require('./logger');
    if (cached.reason === 'migrated') {
      logger.info('paths', 'the product data directory was copied and verified; the original is preserved', {
        from: cached.migratedFrom,
        to: cached.userDataPath,
        files: cached.integrity && cached.integrity.files,
      });
    } else if (cached.reason === 'legacy-fallback') {
      logger.warn('paths', 'the product data directory could not be migrated; the previous location is used', {
        from: cached.migratedFrom,
        to: cached.userDataPath,
        error: cached.error || null,
      });
    }
  } catch {
    // The logger is optional here: a host without one still gets the paths.
  }

  return cached;
}

/**
 * Point Electron's own user-data directory at the resolved one, so every
 * consumer - electron-store, the SQLite store, the logs - follows the same
 * place. A no-op when the resolved path is already Electron's own.
 */
function applyUserDataPath() {
  const resolved = getAppPaths();
  try {
    const { app } = require('electron');
    if (app.getPath('userData') !== resolved.userDataPath) {
      app.setPath('userData', resolved.userDataPath);
    }
  } catch {
    // A non-Electron host (a test, a server) has no path to set.
  }
  return resolved;
}

module.exports = { getAppPaths, applyUserDataPath, PRODUCT_FOLDER };
