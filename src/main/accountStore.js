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
    this.ready = this.initDB();
  }

  async initDB() {
    if (!initSQL) {
      this.db = null;
      this.fallbackToJson();
      logger.warn('accountStore', 'sql.js not available, using JSON fallback storage');
      return;
    }

    try {
      const SQL = await initSQL();
      let buffer = null;
      if (fs.existsSync(this.dbPath)) {
        buffer = fs.readFileSync(this.dbPath);
      }
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

      this.saveDB();

      this.migrateJsonData();
      logger.info('accountStore', 'database initialized', { dbPath: this.dbPath });
    } catch (err) {
      logger.error('accountStore', 'database init failed, falling back to JSON storage', { error: err.message });
      this.db = null;
      this.fallbackToJson();
    }
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
    try {
      const data = this.db.export();
      fs.writeFileSync(this.dbPath, Buffer.from(data));
    } catch (err) {
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
      const existing = new Set((this._numbers || []).map(n => n.phone));
      const unique = newNumbers.filter(n => {
        if (existing.has(n.phone)) return false;
        existing.add(n.phone);
        return true;
      });
      this._numbers.push(...unique);
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      const result = { added: unique.length, duplicates: newNumbers.length - unique.length };
      logger.info('collector', 'numbers added', { input: newNumbers.length, added: result.added, duplicates: result.duplicates, storage: 'json' });
      return result;
    }

    let added = 0, duplicates = 0;
    for (const n of newNumbers) {
      const exists = this.db.exec('SELECT 1 FROM numbers WHERE phone = ?', [n.phone]);
      if (exists.length && exists[0].values.length) {
        duplicates++;
        continue;
      }
      this.db.run(
        'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
        [n.id || randomUUID(),
         n.phone, n.source || '', n.keyword || '', n.status || 'pending', n.collectedAt || new Date().toISOString()]
      );
      added++;
    }
    this.saveDB();
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
      this._numbers = (this._numbers || []).filter(n => !ids.includes(n.id));
      try {
        fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      } catch (err) {
        logger.error('accountStore', 'failed to write numbers.json', { error: err.message });
        throw err;
      }
      logger.info('collector', 'numbers deleted', { count: ids.length, storage: 'json' });
      return { success: true };
    }
    for (const id of ids) {
      this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
    }
    this.saveDB();
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
