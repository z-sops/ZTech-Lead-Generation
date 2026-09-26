const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');

const DATA_DIR = path.join(require('electron').app.getPath('userData'), 'data');

function csvField(value) {
  let s = value === undefined || value === null ? '' : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s.replace(/"/g, '""');
}

function canonicalPhone(phone) {
  if (typeof phone !== 'string') return phone;
  return phone.replace(/[\s\-.()]/g, '');
}

// B1 lead schema: new persisted fields. Naming follows the existing
// camelCase convention (cf. collectedAt / runSlug in the renderer).
const LEAD_NEW_FIELDS = ['title', 'website', 'email', 'address', 'runSlug'];

// Exact provenance literal written by the manual-import save path
// (renderer.js: source: '手动导入'). Used to map legacy `source` values.
const LEGACY_IMPORT_SOURCE = '手动导入';

function asText(value) {
  return typeof value === 'string' ? value : '';
}

// Legacy `source` was overloaded: the collection save path wrote the business
// title into it (renderer wrote source: item.title), the import path wrote the
// provenance literal. Map the title meaning best-effort for NEW fields only;
// the original `source` value itself is never modified or destroyed.
function legacySourceTitle(sourceValue) {
  if (sourceValue === LEGACY_IMPORT_SOURCE) return '';
  return asText(sourceValue);
}

// Adds missing B1 fields to a lead row without touching existing values.
// Idempotent: a row that already carries the fields is returned unchanged.
// Returns { row, changed }.
function normalizeLeadRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return { row, changed: false };
  let changed = false;
  if (row.title === undefined || row.title === null) {
    row.title = legacySourceTitle(row.source);
    changed = true;
  }
  for (const field of ['website', 'email', 'address', 'runSlug']) {
    if (row[field] === undefined || row[field] === null) {
      row[field] = '';
      changed = true;
    }
  }
  return { row, changed };
}

// One-time schema extension for an existing 6-column numbers table.
// Adds missing B1 columns, backfills title from the legacy `source` value
// (import provenance literal maps to an empty title; `source` untouched),
// and normalises NULLs to ''. Returns the number of columns added.
// Returns 0 on an already-migrated or fresh table (zero writes / idempotent).
function migrateSchema(db) {
  if (!db) return 0;
  let info;
  try {
    info = db.exec('PRAGMA table_info(numbers)');
  } catch {
    return 0;
  }
  if (!info.length || !info[0].values.length) return 0;
  const existing = new Set(info[0].values.map(r => r[1]));
  const added = [];
  for (const field of LEAD_NEW_FIELDS) {
    if (existing.has(field)) continue;
    db.run(`ALTER TABLE numbers ADD COLUMN ${field} TEXT`);
    added.push(field);
  }
  if (!added.length) return 0;
  if (added.includes('title')) {
    db.run(
      "UPDATE numbers SET title = CASE WHEN source = ? THEN '' ELSE IFNULL(source, '') END",
      [LEGACY_IMPORT_SOURCE]
    );
  }
  for (const field of added) {
    db.run(`UPDATE numbers SET ${field} = '' WHERE ${field} IS NULL`);
  }
  return added.length;
}

// Map a positional SELECT row to an object using the result's column names,
// so reads work both before and after the B1 column migration. Original
// columns keep their raw values; B1 columns default to '' when absent.
function rowToObject(columns, values) {
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  for (const field of LEAD_NEW_FIELDS) {
    if (out[field] === undefined || out[field] === null) out[field] = '';
  }
  return out;
}

// Duplicate-phone merge rule: existing non-empty values win (first writer
// wins); empty/missing metadata fields are filled from the incoming row.
// Applies to the original four fields plus the B1 fields.
function mergeEmptyLeadFields(existing, incoming) {
  let changed = false;
  for (const field of ['source', 'keyword', 'status', 'collectedAt', ...LEAD_NEW_FIELDS]) {
    const cur = existing[field];
    const inc = incoming[field];
    const curEmpty = cur === undefined || cur === null || (typeof cur === 'string' && cur.trim() === '');
    const incFilled = inc !== undefined && inc !== null && !(typeof inc === 'string' && inc.trim() === '');
    if (curEmpty && incFilled) {
      existing[field] = inc;
      changed = true;
    }
  }
  return changed;
}

function writeJsonAtomic(filePath, contents) {
  const tmpPath = filePath + '.tmp';
  try {
    fs.writeFileSync(tmpPath, contents, 'utf-8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {}
    throw err;
  }
}

let initSQL;
try {
  initSQL = require('sql.js');
} catch (e) {
  initSQL = null;
}

class AccountStore {
  constructor() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    this.dbPath = path.join(DATA_DIR, 'whatsapp.db');
    this.db = null;
    this._numbers = [];
    this._sessionQuarantine = null;
    this.storageStatus = { mode: 'json-fallback', reason: null, quarantine: null, dataMayBeIncomplete: false };
    this.ready = this.initDB();
  }

  async initDB() {
    if (!initSQL) {
      this.db = null;
      this.fallbackToJson();
      logger.warn('accountStore', 'sql.js not available, using JSON fallback storage');
      this._completeStatus('json-fallback', 'sqljs-unavailable');
      return;
    }

    let SQL;
    try {
      SQL = await initSQL();
    } catch (err) {
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      this.db = null;
      this.fallbackToJson();
      this._completeStatus('json-fallback', 'sqljs-unavailable');
      return;
    }

    let buffer = null;
    if (fs.existsSync(this.dbPath)) {
      try {
        buffer = fs.readFileSync(this.dbPath);
      } catch (err) {
        logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
        this.db = null;
        this.fallbackToJson();
        this._completeStatus('json-fallback', 'read-failed');
        return;
      }
    }

    const hasExisting = !!(buffer && buffer.length);
    try {
      this.db = buffer ? new SQL.Database(buffer) : new SQL.Database();

      this.db.run(`CREATE TABLE IF NOT EXISTS numbers (
        id TEXT PRIMARY KEY,
        phone TEXT,
        source TEXT,
        keyword TEXT,
        status TEXT DEFAULT 'pending',
        collectedAt TEXT,
        title TEXT,
        website TEXT,
        email TEXT,
        address TEXT,
        runSlug TEXT
      )`);

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_phone ON numbers(phone)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status)`);
    } catch (err) {
      this.db = null;
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      if (hasExisting) this._quarantineCorrupt(err);
      this.fallbackToJson();
      this._completeStatus('json-fallback', hasExisting ? 'corrupt-open' : 'init-failed');
      return;
    }

    try {
      const migratedColumns = migrateSchema(this.db);
      if (migratedColumns) {
        logger.info('accountStore', 'lead schema migration applied', { columns: migratedColumns });
      }
      this.saveDB();
    } catch (err) {
      this.db = null;
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      this.fallbackToJson();
      this._completeStatus('json-fallback', 'init-write-failed');
      return;
    }

    this.migrateJsonData();
    logger.info('accountStore', 'database initialized', { dbPath: this.dbPath });
    this._completeStatus('sql', null);
  }

  _quarantineCorrupt(openErr) {
    const target = this.dbPath + '.corrupt-' + Date.now();
    try {
      fs.renameSync(this.dbPath, target);
      this._sessionQuarantine = target;
      logger.error('accountStore', 'unreadable database preserved', { error: openErr.message, preserved: target });
    } catch (renameErr) {
      this._sessionQuarantine = null;
      logger.error('accountStore', 'failed to preserve unreadable database', { error: renameErr.message, dbPath: this.dbPath });
    }
  }

  _scanQuarantine() {
    const prefix = path.basename(this.dbPath) + '.corrupt-';
    try {
      let newest = null;
      let newestM = -1;
      for (const name of fs.readdirSync(path.dirname(this.dbPath))) {
        if (!name.startsWith(prefix)) continue;
        const full = path.join(path.dirname(this.dbPath), name);
        const m = fs.statSync(full).mtimeMs;
        if (m >= newestM) {
          newestM = m;
          newest = full;
        }
      }
      return newest;
    } catch (err) {
      return null;
    }
  }

  _completeStatus(mode, reason) {
    const quarantine = this._sessionQuarantine || this._scanQuarantine();
    this.storageStatus = {
      mode,
      quarantine,
      reason,
      dataMayBeIncomplete: quarantine !== null || (mode === 'json-fallback' && fs.existsSync(this.dbPath))
    };
  }

  async getStorageStatus() {
    await this.ready;
    return { ...this.storageStatus };
  }

  migrateJsonData() {
    const oldNumbers = path.join(DATA_DIR, 'numbers.json');

    if (!fs.existsSync(oldNumbers)) return;
    try {
      const data = JSON.parse(fs.readFileSync(oldNumbers, 'utf-8'));
      if (Array.isArray(data) && data.length) {
        const result = this._addNumbers(data);
        logger.info('accountStore', 'legacy JSON data migrated', {
          input: data.length,
          added: result.added,
          duplicates: result.duplicates
        });
      } else {
        logger.info('accountStore', 'legacy JSON file found, no rows to migrate');
      }
      fs.renameSync(oldNumbers, oldNumbers + '.bak');
    } catch (err) {
      logger.error('accountStore', 'legacy JSON migration failed', { error: err.message });
    }
  }

  fallbackToJson() {
    this._numbers = [];
    const nf = path.join(DATA_DIR, 'numbers.json');
    if (!fs.existsSync(nf)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(nf, 'utf-8'));
      if (Array.isArray(parsed)) {
        for (const row of parsed) normalizeLeadRow(row);
        this._numbers = parsed;
      } else {
        logger.warn('accountStore', 'numbers.json is not an array, ignoring');
      }
    } catch (err) {
      logger.error('accountStore', 'failed to read numbers.json', { error: err.message });
    }
  }

  saveDB() {
    if (!this.db) return;
    const tmpPath = this.dbPath + '.tmp';
    try {
      const data = this.db.export();
      fs.writeFileSync(tmpPath, Buffer.from(data));
      fs.renameSync(tmpPath, this.dbPath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (cleanupErr) {}
      logger.error('accountStore', 'failed to persist database', { error: err.message });
      throw err;
    }
  }

  // === 号码管理 ===
  async getCollectedNumbers() {
    await this.ready;
    if (!this.db) return this._numbers || [];
    const rows = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    if (!rows.length) return [];
    return rows[0].values.map(r => rowToObject(rows[0].columns, r));
  }

  async addNumbers(newNumbers) {
    await this.ready;
    return this._addNumbers(newNumbers);
  }

  _addNumbers(newNumbers) {
    for (const n of newNumbers) normalizeLeadRow(n);
    if (!this.db) {
      const backup = (this._numbers || []).map(n => ({ ...n }));
      const byPhone = new Map();
      for (const n of this._numbers || []) {
        const key = canonicalPhone(n.phone);
        if (!byPhone.has(key)) byPhone.set(key, n);
      }
      let added = 0, duplicates = 0;
      for (const n of newNumbers) {
        const key = canonicalPhone(n.phone);
        const existing = byPhone.get(key);
        if (existing) {
          mergeEmptyLeadFields(existing, n);
          duplicates++;
          continue;
        }
        byPhone.set(key, n);
        this._numbers.push(n);
        added++;
      }
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        this._numbers = backup;
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      const result = { added, duplicates };
      logger.info('collector', 'numbers added', { input: newNumbers.length, added: result.added, duplicates: result.duplicates, storage: 'json' });
      return result;
    }

    let added = 0, duplicates = 0;
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    const byPhone = new Map();
    if (scan.length) {
      for (const r of scan[0].values) {
        const row = rowToObject(scan[0].columns, r);
        byPhone.set(canonicalPhone(row.phone), row);
      }
    }
    const pristine = new Map();
    const mergedIds = new Set();
    const insertedIds = [];
    for (const n of newNumbers) {
      const key = canonicalPhone(n.phone);
      const existing = byPhone.get(key);
      if (existing) {
        if (!pristine.has(existing.id)) {
          pristine.set(existing.id, {
            id: existing.id, source: existing.source, keyword: existing.keyword,
            status: existing.status, collectedAt: existing.collectedAt,
            title: existing.title, website: existing.website, email: existing.email,
            address: existing.address, runSlug: existing.runSlug
          });
        }
        if (mergeEmptyLeadFields(existing, n)) {
          this.db.run(
            'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ?, title = ?, website = ?, email = ?, address = ?, runSlug = ? WHERE id = ?',
            [existing.source, existing.keyword, existing.status, existing.collectedAt,
              existing.title, existing.website, existing.email, existing.address, existing.runSlug,
              existing.id]
          );
          mergedIds.add(existing.id);
        }
        duplicates++;
        continue;
      }
      const row = {
        id: n.id || randomUUID(),
        phone: n.phone,
        source: n.source || '',
        keyword: n.keyword || '',
        status: n.status || 'pending',
        collectedAt: n.collectedAt || new Date().toISOString(),
        title: n.title || '',
        website: n.website || '',
        email: n.email || '',
        address: n.address || '',
        runSlug: n.runSlug || ''
      };
      this.db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt,
          row.title, row.website, row.email, row.address, row.runSlug]
      );
      byPhone.set(key, row);
      insertedIds.push(row.id);
      added++;
    }
    try {
      this.saveDB();
    } catch (err) {
      try {
        for (const id of insertedIds) {
          this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
        }
        for (const id of mergedIds) {
          const prev = pristine.get(id);
          if (prev) {
            this.db.run(
              'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ?, title = ?, website = ?, email = ?, address = ?, runSlug = ? WHERE id = ?',
              [prev.source, prev.keyword, prev.status, prev.collectedAt,
                prev.title, prev.website, prev.email, prev.address, prev.runSlug, id]
            );
          }
        }
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('collector', 'numbers added', { input: newNumbers.length, added, duplicates, storage: 'sql' });
    return { added, duplicates };
  }

  async deleteNumbers(ids) {
    await this.ready;
    if (!this.db) {
      const backup = (this._numbers || []).map(n => ({ ...n }));
      const idSet = new Set(ids);
      this._numbers = (this._numbers || []).filter(n => !idSet.has(n.id));
      try {
        writeJsonAtomic(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        this._numbers = backup;
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'json' });
      return { success: true };
    }
    const idSet = new Set(ids);
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    const removed = scan.length
      ? scan[0].values
          .map(r => rowToObject(scan[0].columns, r))
          .filter(row => idSet.has(row.id))
      : [];
    for (const id of ids) {
      this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
    }
    try {
      this.saveDB();
    } catch (err) {
      try {
        for (const row of removed) {
          this.db.run(
            'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
            [row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt]
          );
          this.db.run(
            'UPDATE numbers SET title = ?, website = ?, email = ?, address = ?, runSlug = ? WHERE id = ?',
            [row.title || '', row.website || '', row.email || '', row.address || '', row.runSlug || '', row.id]
          );
        }
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'sql' });
    return { success: true };
  }

  async exportNumbers(format = 'csv') {
    await this.ready;
    const numbers = await this.getCollectedNumbers();
    logger.info('collector', 'numbers exported', { format: format === 'json' ? 'json' : 'csv', count: numbers.length });
    if (format === 'csv') {
      const header = 'phone,source,keyword,status,collected_at,title,website,email,address,run_slug\n';
      const rows = numbers.map(n =>
        `"${csvField(n.phone)}","${csvField(n.source || '')}","${csvField(n.keyword || '')}","${csvField(n.status || '')}","${csvField(n.collectedAt || '')}","${csvField(n.title || '')}","${csvField(n.website || '')}","${csvField(n.email || '')}","${csvField(n.address || '')}","${csvField(n.runSlug || '')}"`
      ).join('\n');
      return header + rows;
    }
    return JSON.stringify(numbers, null, 2);
  }

}

module.exports = { AccountStore, migrateSchema, normalizeLeadRow };
