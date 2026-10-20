'use strict';

/**
 * F1 - integrity checks for a copied user-data directory.
 *
 * A copy that verifies byte-for-byte can still be USELESS: a truncated
 * database file can hash differently from the source (so the copy check
 * passes) while not being a database at all, and a settings file that was
 * written to disk at the wrong moment can be unparseable.
 *
 * The checks here decide whether the product may start on the copied
 * directory or must fall back to the original:
 *
 *   - the database carries the SQLite file header and its length is a whole
 *     number of pages, so a truncated or foreign file is rejected;
 *   - the settings file parses and still carries the expected shape.
 *
 * The checks are SYNCHRONOUS on purpose: the product resolves its directory
 * while its modules are being loaded, before the database is opened.
 *
 * ENCRYPTED CREDENTIALS. The provider credentials, the mailbox tokens and the
 * OAuth client secret are sealed with the operating system's key store
 * (Windows DPAPI), which is bound to the USER ACCOUNT, not to the file. A copy
 * of the settings file on the SAME machine therefore still decrypts. A copy
 * that does not parse, or that lost a key, is treated as a failed migration:
 * the product falls back to the original directory rather than starting with
 * credentials it cannot read.
 */

const fs = require('node:fs');
const path = require('node:path');

/** The files that must be readable in a user-data directory. */
const DATABASE_FILE = 'whatsapp.db';
const SETTINGS_FILE = 'config.json';

/** The exact 16-byte header every SQLite database starts with. */
const SQLITE_HEADER = 'SQLite format 3\0';

/**
 * Is this file a structurally valid SQLite database?
 *
 * The check is the header plus the page geometry, which is what a truncated
 * or foreign file fails. It does not read a single page, so it stays cheap.
 *
 * @returns {{ok: boolean, pageSize: number, pages: number, error: string|null}}
 */
function verifyDatabase(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) {
    return { ok: false, pageSize: 0, pages: 0, error: 'the database file is missing' };
  }
  let buf;
  try {
    buf = fsImpl.readFileSync(file);
  } catch (err) {
    return { ok: false, pageSize: 0, pages: 0, error: (err && err.message) || 'the database file could not be read' };
  }
  if (buf.length < 16) {
    return { ok: false, pageSize: 0, pages: 0, error: 'the database file is too short to be a database' };
  }
  const header = buf.subarray(0, 16).toString('latin1');
  if (header !== SQLITE_HEADER) {
    return { ok: false, pageSize: 0, pages: 0, error: 'the database file is not a SQLite database' };
  }
  if (buf.length < 100) {
    return { ok: false, pageSize: 0, pages: 0, error: 'the database file is too short to be a database' };
  }
  const rawPageSize = buf.readUInt16BE(16);
  const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
  if (!Number.isInteger(pageSize) || pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) {
    return { ok: false, pageSize: 0, pages: 0, error: 'the database file has an invalid page size' };
  }
  if (buf.length % pageSize !== 0) {
    return {
      ok: false,
      pageSize,
      pages: 0,
      error: 'the database file is truncated (its length is not a whole number of pages)',
    };
  }
  return { ok: true, pageSize, pages: buf.length / pageSize, error: null };
}

/**
 * Can the settings file be parsed, and does it still have the expected shape?
 * @returns {{ok: boolean, keys: string[], error: string|null}}
 */
function verifySettings(file, fsImpl = fs) {
  if (!fsImpl.existsSync(file)) {
    // No settings file is a valid state: a fresh install has none.
    return { ok: true, keys: [], error: null };
  }
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, keys: [], error: 'the settings file is not an object' };
    }
    return { ok: true, keys: Object.keys(parsed), error: null };
  } catch (err) {
    return { ok: false, keys: [], error: (err && err.message) || 'the settings file could not be parsed' };
  }
}

/**
 * The full check of a user-data directory.
 *
 * @param {string} userDataPath
 * @returns {{ok: boolean, database: object, settings: object, error: string|null}}
 */
function verifyUserData(userDataPath, fsImpl = fs) {
  const database = verifyDatabase(path.join(userDataPath, 'data', DATABASE_FILE), fsImpl);
  const settings = verifySettings(path.join(userDataPath, SETTINGS_FILE), fsImpl);
  const error = database.ok ? settings.error : database.error;
  return { ok: database.ok && settings.ok, database, settings, error: error || null };
}

module.exports = {
  DATABASE_FILE,
  SETTINGS_FILE,
  SQLITE_HEADER,
  verifyDatabase,
  verifySettings,
  verifyUserData,
};
