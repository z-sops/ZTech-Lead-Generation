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

  // The logger is required lazily - it needs the log path, so requiring it
  // before the paths are known would be circular.
  try {
    const { logger } = require('./logger');
    if (cached.reason === 'migrated') {
      logger.info('paths', 'the product data directory was migrated', {
        from: cached.migratedFrom,
        to: cached.userDataPath,
        mode: cached.migrationMode,
      });
    } else if (cached.reason === 'legacy-fallback') {
      logger.warn('paths', 'the product data directory could not be migrated; the previous location is used', {
        from: cached.migratedFrom,
        to: cached.userDataPath,
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
