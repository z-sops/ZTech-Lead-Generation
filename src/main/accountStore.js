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

function mergeEmptyLeadFields(existing, incoming) {
  let changed = false;
  for (const field of ['source', 'keyword', 'status', 'collectedAt']) {
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
        collectedAt TEXT
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
    return rows[0].values.map(r => ({
      id: r[0], phone: r[1], source: r[2], keyword: r[3], status: r[4], collectedAt: r[5]
    }));
  }

  async addNumbers(newNumbers) {
    await this.ready;
    return this._addNumbers(newNumbers);
  }

  _addNumbers(newNumbers) {
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
        fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
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
        byPhone.set(canonicalPhone(r[1]), {
          id: r[0], phone: r[1], source: r[2], keyword: r[3], status: r[4], collectedAt: r[5]
        });
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
            status: existing.status, collectedAt: existing.collectedAt
          });
        }
        if (mergeEmptyLeadFields(existing, n)) {
          this.db.run(
            'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ? WHERE id = ?',
            [existing.source, existing.keyword, existing.status, existing.collectedAt, existing.id]
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
        collectedAt: n.collectedAt || new Date().toISOString()
      };
      this.db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt]
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
              'UPDATE numbers SET source = ?, keyword = ?, status = ?, collectedAt = ? WHERE id = ?',
              [prev.source, prev.keyword, prev.status, prev.collectedAt, id]
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

  async updateNumberStatus(phone, status) {
    await this.ready;
    if (!this.db) return;
    this.db.run('UPDATE numbers SET status = ? WHERE phone = ?', [status, phone]);
    this.saveDB();
  }

  async deleteNumbers(ids) {
    await this.ready;
    if (!this.db) {
      const backup = (this._numbers || []).map(n => ({ ...n }));
      this._numbers = (this._numbers || []).filter(n => !ids.includes(n.id));
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        this._numbers = backup;
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'json' });
      return { success: true };
    }
    const scan = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    const removed = scan.length
      ? scan[0].values
          .filter(r => ids.includes(r[0]))
          .map(r => ({ id: r[0], phone: r[1], source: r[2], keyword: r[3], status: r[4], collectedAt: r[5] }))
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
      const header = 'phone,source,keyword,status,collected_at\n';
      const rows = numbers.map(n =>
        `"${csvField(n.phone)}","${csvField(n.source || '')}","${csvField(n.keyword || '')}","${csvField(n.status || '')}","${csvField(n.collectedAt || '')}"`
      ).join('\n');
      return header + rows;
    }
    return JSON.stringify(numbers, null, 2);
  }

}

module.exports = { AccountStore };
