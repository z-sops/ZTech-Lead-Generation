'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Atomic file helpers.
 *
 * Use-case 1: if ZTech's existing saveDB() writes the sql.js export straight over the
 * DB file, a crash mid-write can corrupt it. `writeFileAtomic` writes to a temp file in
 * the same folder, fsyncs, keeps one `.bak` of the previous file, then renames.
 * QwenCoder: report how saveDB() writes today; only switch it to writeFileAtomic with
 * the user's approval.
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
  } finally {
    fsImpl.closeSync(fd);
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
