'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Atomic file helpers.
 *
 * Use-case 1: ZTech's primary store (the sql.js database export) is rewritten
 * wholesale on every save. Writing it straight over the target can leave a
 * truncated file if the process dies mid-write. `writeFileAtomic` writes to a
 * temp file in the same folder, fsyncs, keeps one `.bak` of the previous file,
 * then renames. On failure the temp file is removed and the previous file is
 * left untouched, so a failed save can never destroy the last good copy.
 *
 * Use-case 2: legacy JSON settings files (if ZTech keeps any, e.g. saved filters in a
 * JSON file). `readJsonWithRecovery` reads the file; on corrupt JSON it falls back to
 * the `.bak` copy and reports which one it used. It never throws on corruption.
 */

function writeFileAtomic(filePath, data, { keepBackup = true, fsImpl = fs } = {}) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fsImpl.openSync(tmp, 'w');
  try {
    fsImpl.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));
    fsImpl.fsyncSync(fd);
  } catch (err) {
    // Never leave a partial temp file behind, and never touch the target.
    try { fsImpl.closeSync(fd); } catch (closeErr) { /* already closed */ }
    try { fsImpl.unlinkSync(tmp); } catch (unlinkErr) { /* nothing to clean */ }
    throw err;
  } finally {
    try { fsImpl.closeSync(fd); } catch (closeErr) { /* already closed */ }
  }
  if (keepBackup && fsImpl.existsSync(filePath)) {
    fsImpl.copyFileSync(filePath, `${filePath}.bak`);
  }
  fsImpl.renameSync(tmp, filePath);
}

/**
 * @returns {{value: any, source: 'primary'|'backup'|'default', corrupt: boolean}}
 */
function readJsonWithRecovery(filePath, defaultValue, { fsImpl = fs, logger = console } = {}) {
  const tryRead = (p) => {
    if (!fsImpl.existsSync(p)) return { ok: false, missing: true };
    try {
      return { ok: true, value: JSON.parse(fsImpl.readFileSync(p, 'utf8')) };
    } catch {
      return { ok: false, missing: false };
    }
  };
  const primary = tryRead(filePath);
  if (primary.ok) return { value: primary.value, source: 'primary', corrupt: false };
  const backup = tryRead(`${filePath}.bak`);
  if (!primary.missing && logger && logger.warn) logger.warn(`[lead-intelligence] ${path.basename(filePath)} is corrupt; using ${backup.ok ? 'backup' : 'default'}`);
  if (backup.ok) return { value: backup.value, source: 'backup', corrupt: !primary.missing };
  return { value: defaultValue, source: 'default', corrupt: !primary.missing };
}

module.exports = { writeFileAtomic, readJsonWithRecovery };
