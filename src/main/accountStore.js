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

// B4 local collection-job ledger. Status vocabulary is limited to the three
// states evidenced by the repository's polling/history behaviour; no other
// lifecycle state exists (there is no cancel/partial/retry API anywhere).
const JOB_STATUS_VALUES = ['running', 'succeeded', 'failed'];
// Provider run-identifier shape (RFC 3986 unreserved characters, max 200) —
// the same format the collection adapter validates, re-checked here so the
// store never persists unvalidated provider-supplied text.
const JOB_RUN_SLUG_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
// ISO-8601 shape gate for startedAt/completedAt (plus Date.parse sanity).
const JOB_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_JOB_PROVIDER_ID_LENGTH = 100;
const MAX_JOB_QUERY_LENGTH = 20000;
const MAX_JOB_ERROR_LENGTH = 500;
const MAX_JOB_TIME_LENGTH = 100;
const JOB_TEXT_FIELDS = ['runSlug', 'providerId', 'query', 'startedAt', 'completedAt', 'status', 'error'];

// B2 query layer. Free-text search covers the human-meaningful lead fields
// (runSlug is an opaque run identifier and is not searched); filters are
// exact-match only; sort identifiers reach SQL exclusively through the
// QUERY_SORT_COLUMNS values, which are compile-time literals.
const QUERY_SEARCH_FIELDS = ['phone', 'title', 'website', 'email', 'address', 'source', 'keyword'];
const QUERY_FILTER_FIELDS = ['status', 'source', 'keyword'];
const QUERY_SORT_COLUMNS = {
  collectedAt: 'collectedAt',
  title: 'title',
  phone: 'phone',
  source: 'source',
  keyword: 'keyword'
};

// SQLite LIKE folds ASCII letters only; the JSON fallback must apply the
// identical folding or the two storages diverge on non-ASCII case.
function asciiFold(value) {
  return value.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
}

// Escape LIKE wildcards so a search term matches literally on both storages.
function escapeLikePattern(term) {
  return term.replace(/[\\%_]/g, (ch) => '\\' + ch);
}

// NULL sorts smallest (SQLite default); otherwise compare as SQLite's
// BINARY collation does (code-unit order matches byte order for BMP text).
function compareQueryValues(a, b) {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    return aNull ? -1 : 1;
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

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

// B4 ledger: validate and normalise one job record. Returns { ok: false,
// error } or { ok: true, row } with a freshly generated local id. The input
// is constructed in the main process from already-validated data, but every
// field is re-checked here so malformed input can never reach either storage.
function validateJobRecord(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) {
    return { ok: false, error: 'Invalid job (object required)' };
  }
  if (typeof job.runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(job.runSlug)) {
    return { ok: false, error: 'Invalid job: runSlug' };
  }
  if (typeof job.providerId !== 'string' || job.providerId.length < 1 ||
      job.providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
    return { ok: false, error: 'Invalid job: providerId' };
  }
  const query = job.query === undefined || job.query === null ? '' : job.query;
  if (typeof query !== 'string' || query.length > MAX_JOB_QUERY_LENGTH) {
    return { ok: false, error: 'Invalid job: query' };
  }
  if (typeof job.startedAt !== 'string' || !job.startedAt ||
      job.startedAt.length > MAX_JOB_TIME_LENGTH ||
      !JOB_TIME_PATTERN.test(job.startedAt) || Number.isNaN(Date.parse(job.startedAt))) {
    return { ok: false, error: 'Invalid job: startedAt' };
  }
  const completedAt = job.completedAt === undefined || job.completedAt === null ? '' : job.completedAt;
  if (completedAt !== '' && (typeof completedAt !== 'string' ||
      completedAt.length > MAX_JOB_TIME_LENGTH ||
      !JOB_TIME_PATTERN.test(completedAt) || Number.isNaN(Date.parse(completedAt)))) {
    return { ok: false, error: 'Invalid job: completedAt' };
  }
  if (!JOB_STATUS_VALUES.includes(job.status)) {
    return { ok: false, error: 'Invalid job: status' };
  }
  const resultCount = job.resultCount === undefined || job.resultCount === null ? null : job.resultCount;
  if (resultCount !== null && (!Number.isInteger(resultCount) || resultCount < 0)) {
    return { ok: false, error: 'Invalid job: resultCount' };
  }
  const error = typeof job.error === 'string' ? job.error.slice(0, MAX_JOB_ERROR_LENGTH) : '';
  return {
    ok: true,
    row: {
      id: randomUUID(),
      runSlug: job.runSlug,
      providerId: job.providerId,
      query,
      startedAt: job.startedAt,
      completedAt,
      status: job.status,
      resultCount,
      error
    }
  };
}

// Map a positional SELECT row of the jobs table to an object with the fixed
// B4 field set; text columns normalise NULL to '' (mirrors rowToObject's B1
// handling) while resultCount keeps null as the explicit "unknown" value.
function jobRowToObject(columns, values) {
  const out = {};
  for (let i = 0; i < columns.length; i++) out[columns[i]] = values[i];
  if (out.id === undefined || out.id === null) out.id = '';
  for (const field of JOB_TEXT_FIELDS) {
    if (out[field] === undefined || out[field] === null) out[field] = '';
  }
  if (out.resultCount === undefined) out.resultCount = null;
  return out;
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
    this._jobs = [];
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

      // B4 job ledger: one row per local collection execution, keyed uniquely
      // by (providerId, runSlug) so a repeated reference to the same provider
      // run is always the same row. No foreign key to numbers on purpose:
      // lead provenance stays exactly as B1/B3 defined it.
      this.db.run(`CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        runSlug TEXT,
        providerId TEXT,
        query TEXT,
        startedAt TEXT,
        completedAt TEXT,
        status TEXT,
        resultCount INTEGER,
        error TEXT,
        UNIQUE(providerId, runSlug)
      )`);

      this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_startedAt ON jobs(startedAt)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_jobs_provider_run ON jobs(providerId, runSlug)`);
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
    // B4: load the job ledger with the same tolerance as numbers.json —
    // missing file means an empty ledger, unreadable/non-array content is
    // logged and ignored rather than crashing the fallback path.
    this._jobs = [];
    const jf = path.join(DATA_DIR, 'jobs.json');
    if (fs.existsSync(jf)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(jf, 'utf-8'));
        if (Array.isArray(parsed)) {
          this._jobs = parsed;
        } else {
          logger.warn('accountStore', 'jobs.json is not an array, ignoring');
        }
      } catch (err) {
        logger.error('accountStore', 'failed to read jobs.json', { error: err.message });
      }
    }
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

  // B2 query layer: server-side search/filter/sort/paging over the lead
  // library. Returns { rows, total, limit, offset }. Read-only: never calls
  // saveDB and never mutates stored rows on either storage branch.
  async queryNumbers(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const normalized = {
      limit: Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 100 ? q.limit : 20,
      offset: Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= 100000 ? q.offset : 0,
      search: typeof q.search === 'string' ? q.search.trim() : '',
      filters: {},
      sort: typeof q.sort === 'string' && QUERY_SORT_COLUMNS[q.sort] ? q.sort : '',
      order: q.order === 'desc' ? 'desc' : 'asc'
    };
    if (q.filters && typeof q.filters === 'object' && !Array.isArray(q.filters)) {
      for (const field of QUERY_FILTER_FIELDS) {
        const value = q.filters[field];
        if (typeof value === 'string') normalized.filters[field] = value;
      }
    }
    // B3 single-lead lookup: an optional exact id predicate. Omitted id
    // keeps list semantics; a provided id must be a non-empty string of at
    // most 100 chars or the lookup short-circuits to an empty envelope, so
    // malformed input behaves identically on both storages and can never be
    // coerced by SQL type affinity.
    if (q.id !== undefined && q.id !== null) {
      const valid = typeof q.id === 'string' && q.id.length > 0 && q.id.length <= 100;
      if (!valid) {
        return { rows: [], total: 0, limit: normalized.limit, offset: normalized.offset };
      }
      normalized.id = q.id;
    }
    if (!this.db) return this._queryNumbersJson(normalized);
    return this._queryNumbersSql(normalized);
  }

  _queryNumbersSql(query) {
    const where = [];
    const params = [];
    if (query.id !== undefined) {
      where.push('id = ?');
      params.push(query.id);
    }
    if (query.search) {
      const pattern = '%' + escapeLikePattern(query.search) + '%';
      where.push('(' + QUERY_SEARCH_FIELDS.map(f => `${f} LIKE ? ESCAPE '\\'`).join(' OR ') + ')');
      for (let i = 0; i < QUERY_SEARCH_FIELDS.length; i++) params.push(pattern);
    }
    for (const field of QUERY_FILTER_FIELDS) {
      const value = query.filters[field];
      if (value === undefined || value === null) continue;
      where.push(`${field} = ?`);
      params.push(value);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const orderSql = query.sort
      ? `ORDER BY ${QUERY_SORT_COLUMNS[query.sort]} ${query.order === 'desc' ? 'DESC' : 'ASC'}, rowid DESC`
      : 'ORDER BY rowid DESC';

    let total = 0;
    const countStmt = this.db.prepare(`SELECT COUNT(*) AS c FROM numbers${whereSql}`);
    try {
      countStmt.bind(params);
      if (countStmt.step()) total = countStmt.getAsObject().c;
    } finally {
      countStmt.free();
    }

    const rowStmt = this.db.prepare(`SELECT * FROM numbers${whereSql} ${orderSql} LIMIT ? OFFSET ?`);
    try {
      rowStmt.bind([...params, query.limit, query.offset]);
      const rows = [];
      let columns = null;
      while (rowStmt.step()) {
        if (!columns) columns = rowStmt.getColumnNames();
        rows.push(rowToObject(columns, rowStmt.get()));
      }
      return { rows, total, limit: query.limit, offset: query.offset };
    } finally {
      rowStmt.free();
    }
  }

  _queryNumbersJson(query) {
    const search = query.search ? asciiFold(query.search) : '';
    const matched = (this._numbers || []).filter((row) => {
      if (query.id !== undefined && row.id !== query.id) return false;
      if (search) {
        let hit = false;
        for (const field of QUERY_SEARCH_FIELDS) {
          const raw = row[field];
          const hay = raw === null || raw === undefined ? '' : asciiFold(String(raw));
          if (hay.includes(search)) {
            hit = true;
            break;
          }
        }
        if (!hit) return false;
      }
      for (const field of QUERY_FILTER_FIELDS) {
        const value = query.filters[field];
        if (value === undefined || value === null) continue;
        if (row[field] !== value) return false;
      }
      return true;
    });
    const total = matched.length;
    let ordered;
    if (query.sort) {
      const dir = query.order === 'desc' ? -1 : 1;
      const indexed = matched.map((row, i) => ({ row, i }));
      indexed.sort((a, b) => {
        const cmp = compareQueryValues(a.row[query.sort], b.row[query.sort]);
        if (cmp !== 0) return cmp * dir;
        return b.i - a.i;
      });
      ordered = indexed.map((entry) => entry.row);
    } else {
      // Default mirrors the SQL branch: newest insert first (rowid DESC).
      ordered = matched.slice().reverse();
    }
    return {
      rows: ordered.slice(query.offset, query.offset + query.limit),
      total,
      limit: query.limit,
      offset: query.offset
    };
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

  // === B4 local collection-job ledger ===
  // Ledger writes are best-effort from the collection handlers' perspective:
  // a persistence failure is reverted in memory, logged and rethrown HERE so
  // the caller (which wraps every ledger call in try/catch) can log it without
  // affecting the already-successful provider result.

  async insertJob(job) {
    await this.ready;
    const validated = validateJobRecord(job);
    if (!validated.ok) return { success: false, error: validated.error };
    return this._insertJob(validated.row);
  }

  async updateJobState(providerId, runSlug, status, errorMessage) {
    await this.ready;
    if (typeof providerId !== 'string' || providerId.length < 1 ||
        providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
      return { success: false, error: 'Invalid job: providerId' };
    }
    if (typeof runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(runSlug)) {
      return { success: false, error: 'Invalid job: runSlug' };
    }
    if (status !== 'succeeded' && status !== 'failed') {
      return { success: false, error: 'Invalid job: status' };
    }
    const errorText = typeof errorMessage === 'string' ? errorMessage.slice(0, MAX_JOB_ERROR_LENGTH) : '';
    if (!this.db) return this._updateJobStateJson(providerId, runSlug, status, errorText);
    return this._updateJobStateSql(providerId, runSlug, status, errorText);
  }

  async setJobResultCount(providerId, runSlug, resultCount) {
    await this.ready;
    if (typeof providerId !== 'string' || providerId.length < 1 ||
        providerId.length > MAX_JOB_PROVIDER_ID_LENGTH) {
      return { success: false, error: 'Invalid job: providerId' };
    }
    if (typeof runSlug !== 'string' || !JOB_RUN_SLUG_PATTERN.test(runSlug)) {
      return { success: false, error: 'Invalid job: runSlug' };
    }
    if (!Number.isInteger(resultCount) || resultCount < 0) {
      return { success: false, error: 'Invalid job: resultCount' };
    }
    if (!this.db) return this._setJobResultCountJson(providerId, runSlug, resultCount);
    return this._setJobResultCountSql(providerId, runSlug, resultCount);
  }

  // B5-ready read API: same {rows,total,limit,offset} envelope and paging
  // bounds as the lead library, newest job first. Never an unbounded read.
  async queryJobs(query) {
    await this.ready;
    const q = (query && typeof query === 'object' && !Array.isArray(query)) ? query : {};
    const normalized = {
      limit: Number.isInteger(q.limit) && q.limit >= 1 && q.limit <= 100 ? q.limit : 20,
      offset: Number.isInteger(q.offset) && q.offset >= 0 && q.offset <= 100000 ? q.offset : 0
    };
    if (!this.db) return this._queryJobsJson(normalized);
    return this._queryJobsSql(normalized);
  }

  _findJobSql(providerId, runSlug) {
    const stmt = this.db.prepare('SELECT * FROM jobs WHERE providerId = ? AND runSlug = ?');
    try {
      stmt.bind([providerId, runSlug]);
      if (stmt.step()) {
        return jobRowToObject(stmt.getColumnNames(), stmt.get());
      }
      return null;
    } finally {
      stmt.free();
    }
  }

  _insertJob(row) {
    if (!this.db) return this._insertJobJson(row);
    const existing = this._findJobSql(row.providerId, row.runSlug);
    if (existing) {
      this.db.run(
        'UPDATE jobs SET query = ?, startedAt = ?, completedAt = ?, status = ?, resultCount = ?, error = ? WHERE providerId = ? AND runSlug = ?',
        [row.query, row.startedAt, row.completedAt, row.status, row.resultCount, row.error,
         row.providerId, row.runSlug]
      );
      try {
        this.saveDB();
      } catch (err) {
        try {
          this.db.run(
            'UPDATE jobs SET query = ?, startedAt = ?, completedAt = ?, status = ?, resultCount = ?, error = ? WHERE providerId = ? AND runSlug = ?',
            [existing.query, existing.startedAt, existing.completedAt, existing.status,
             existing.resultCount, existing.error, row.providerId, row.runSlug]
          );
        } catch (revertErr) {
          logger.error('accountStore', 'in-memory job restore after failed persistence incomplete', { error: revertErr.message });
        }
        throw err;
      }
      logger.info('job', 'job recorded', { jobId: existing.id, providerId: row.providerId, status: row.status, storage: 'sql' });
      return { success: true, id: existing.id };
    }
    this.db.run(
      'INSERT INTO jobs (id, runSlug, providerId, query, startedAt, completedAt, status, resultCount, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [row.id, row.runSlug, row.providerId, row.query, row.startedAt, row.completedAt,
       row.status, row.resultCount, row.error]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run('DELETE FROM jobs WHERE id = ?', [row.id]);
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job rollback after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job recorded', { jobId: row.id, providerId: row.providerId, status: row.status, storage: 'sql' });
    return { success: true, id: row.id };
  }

  _insertJobJson(row) {
    if (!this._jobs) this._jobs = [];
    const backup = this._jobs.map(j => ({ ...j }));
    const existing = this._jobs.find(j => j.providerId === row.providerId && j.runSlug === row.runSlug);
    let id;
    if (existing) {
      Object.assign(existing, {
        query: row.query, startedAt: row.startedAt, completedAt: row.completedAt,
        status: row.status, resultCount: row.resultCount, error: row.error
      });
      id = existing.id;
    } else {
      this._jobs.push(row);
      id = row.id;
    }
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      this._jobs = backup;
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job recorded', { jobId: id, providerId: row.providerId, status: row.status, storage: 'json' });
    return { success: true, id };
  }

  _updateJobStateSql(providerId, runSlug, status, errorText) {
    const existing = this._findJobSql(providerId, runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // State-change gate: an unchanged canonical status never persists.
    if (existing.status === status) return { success: true, updated: false, reason: 'unchanged' };
    // completedAt is stamped once, on the first terminal transition only.
    const completedAt = existing.completedAt ? existing.completedAt : new Date().toISOString();
    const errorValue = status === 'failed' ? errorText : existing.error;
    this.db.run(
      'UPDATE jobs SET status = ?, completedAt = ?, error = ? WHERE providerId = ? AND runSlug = ?',
      [status, completedAt, errorValue, providerId, runSlug]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run(
          'UPDATE jobs SET status = ?, completedAt = ?, error = ? WHERE providerId = ? AND runSlug = ?',
          [existing.status, existing.completedAt, existing.error, providerId, runSlug]
        );
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job state restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job state updated', { runSlug, providerId, status, storage: 'sql' });
    return { success: true, updated: true };
  }

  _updateJobStateJson(providerId, runSlug, status, errorText) {
    if (!this._jobs) this._jobs = [];
    const existing = this._jobs.find(j => j.providerId === providerId && j.runSlug === runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // State-change gate: an unchanged canonical status never persists.
    if (existing.status === status) return { success: true, updated: false, reason: 'unchanged' };
    const backup = { ...existing };
    existing.completedAt = existing.completedAt ? existing.completedAt : new Date().toISOString();
    existing.status = status;
    if (status === 'failed') existing.error = errorText;
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      Object.assign(existing, backup);
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job state updated', { runSlug, providerId, status, storage: 'json' });
    return { success: true, updated: true };
  }

  _setJobResultCountSql(providerId, runSlug, resultCount) {
    const existing = this._findJobSql(providerId, runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    // Set-once: an already-finalised count is never overwritten, and an
    // unknown count stays NULL rather than being coerced to zero.
    if (existing.resultCount !== null && existing.resultCount !== undefined) {
      return { success: true, updated: false, reason: 'already-set' };
    }
    this.db.run(
      'UPDATE jobs SET resultCount = ? WHERE providerId = ? AND runSlug = ?',
      [resultCount, providerId, runSlug]
    );
    try {
      this.saveDB();
    } catch (err) {
      try {
        this.db.run(
          'UPDATE jobs SET resultCount = NULL WHERE providerId = ? AND runSlug = ?',
          [providerId, runSlug]
        );
      } catch (revertErr) {
        logger.error('accountStore', 'in-memory job count restore after failed persistence incomplete', { error: revertErr.message });
      }
      throw err;
    }
    logger.info('job', 'job result count recorded', { runSlug, providerId, resultCount, storage: 'sql' });
    return { success: true, updated: true };
  }

  _setJobResultCountJson(providerId, runSlug, resultCount) {
    if (!this._jobs) this._jobs = [];
    const existing = this._jobs.find(j => j.providerId === providerId && j.runSlug === runSlug);
    if (!existing) return { success: true, updated: false, reason: 'not-found' };
    if (existing.resultCount !== null && existing.resultCount !== undefined) {
      return { success: true, updated: false, reason: 'already-set' };
    }
    const previous = existing.resultCount === undefined ? null : existing.resultCount;
    existing.resultCount = resultCount;
    try {
      writeJsonAtomic(path.join(DATA_DIR, 'jobs.json'), JSON.stringify(this._jobs, null, 2));
    } catch (err) {
      existing.resultCount = previous;
      logger.error('accountStore', 'failed to write jobs.json', { error: err.message });
      throw err;
    }
    logger.info('job', 'job result count recorded', { runSlug, providerId, resultCount, storage: 'json' });
    return { success: true, updated: true };
  }

  _queryJobsSql(query) {
    let total = 0;
    const countStmt = this.db.prepare('SELECT COUNT(*) AS c FROM jobs');
    try {
      if (countStmt.step()) total = countStmt.getAsObject().c;
    } finally {
      countStmt.free();
    }
    const rowStmt = this.db.prepare('SELECT * FROM jobs ORDER BY startedAt DESC, rowid DESC LIMIT ? OFFSET ?');
    try {
      rowStmt.bind([query.limit, query.offset]);
      const rows = [];
      let columns = null;
      while (rowStmt.step()) {
        if (!columns) columns = rowStmt.getColumnNames();
        rows.push(jobRowToObject(columns, rowStmt.get()));
      }
      return { rows, total, limit: query.limit, offset: query.offset };
    } finally {
      rowStmt.free();
    }
  }

  _queryJobsJson(query) {
    const source = this._jobs || [];
    const indexed = source.map((row, i) => ({ row, i }));
    // Mirrors SQL: startedAt DESC (NULLs smallest, i.e. last), later insert
    // wins the tie-break exactly like rowid DESC.
    indexed.sort((a, b) => {
      const cmp = compareQueryValues(b.row.startedAt, a.row.startedAt);
      if (cmp !== 0) return cmp;
      return b.i - a.i;
    });
    const ordered = indexed.map(entry => entry.row);
    return {
      rows: ordered.slice(query.offset, query.offset + query.limit),
      total: source.length,
      limit: query.limit,
      offset: query.offset
    };
  }

}

module.exports = { AccountStore, migrateSchema, normalizeLeadRow };
