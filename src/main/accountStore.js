const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(require('electron').app.getPath('userData'), 'data');

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
    this.ready = this.initDB();
  }

  async initDB() {
    if (!initSQL) {
      this.db = null;
      this.fallbackToJson();
      return;
    }

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

    // 迁移旧 JSON 数据
    this.migrateJsonData();
  }

  migrateJsonData() {
    const oldNumbers = path.join(DATA_DIR, 'numbers.json');

    if (fs.existsSync(oldNumbers)) {
      try {
        const data = JSON.parse(fs.readFileSync(oldNumbers, 'utf-8'));
        if (data.length) this.addNumbers(data);
        fs.renameSync(oldNumbers, oldNumbers + '.bak');
      } catch {}
    }
  }

  fallbackToJson() {
    this._numbers = [];
    const nf = path.join(DATA_DIR, 'numbers.json');
    try { if (fs.existsSync(nf)) this._numbers = JSON.parse(fs.readFileSync(nf, 'utf-8')); } catch {}
  }

  saveDB() {
    if (!this.db) return;
    const data = this.db.export();
    fs.writeFileSync(this.dbPath, Buffer.from(data));
  }

  // === 号码管理 ===
  getCollectedNumbers() {
    if (!this.db) return this._numbers || [];
    const rows = this.db.exec('SELECT * FROM numbers ORDER BY rowid DESC');
    if (!rows.length) return [];
    return rows[0].values.map(r => ({
      id: r[0], phone: r[1], source: r[2], keyword: r[3], status: r[4], collectedAt: r[5]
    }));
  }

  addNumbers(newNumbers) {
    if (!this.db) {
      const existing = new Set((this._numbers || []).map(n => n.phone));
      const unique = newNumbers.filter(n => !existing.has(n.phone));
      this._numbers.push(...unique);
      fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      return { added: unique.length, duplicates: newNumbers.length - unique.length };
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
        [n.id || `num-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
         n.phone, n.source || '', n.keyword || '', n.status || 'pending', n.collectedAt || new Date().toISOString()]
      );
      added++;
    }
    this.saveDB();
    return { added, duplicates };
  }

  updateNumberStatus(phone, status) {
    if (!this.db) return;
    this.db.run('UPDATE numbers SET status = ? WHERE phone = ?', [status, phone]);
    this.saveDB();
  }

  deleteNumbers(ids) {
    if (!this.db) {
      this._numbers = (this._numbers || []).filter(n => !ids.includes(n.id));
      fs.writeFileSync(path.join(DATA_DIR, 'numbers.json'), JSON.stringify(this._numbers, null, 2));
      return { success: true };
    }
    for (const id of ids) {
      this.db.run('DELETE FROM numbers WHERE id = ?', [id]);
    }
    this.saveDB();
    return { success: true };
  }

  exportNumbers(format = 'csv') {
    const numbers = this.getCollectedNumbers();
    if (format === 'csv') {
      const header = 'phone,source,keyword,status,collected_at\n';
      const rows = numbers.map(n =>
        `"${n.phone}","${n.source || ''}","${n.keyword || ''}","${n.status || ''}","${n.collectedAt || ''}"`
      ).join('\n');
      return header + rows;
    }
    return JSON.stringify(numbers, null, 2);
  }

}

module.exports = { AccountStore };
