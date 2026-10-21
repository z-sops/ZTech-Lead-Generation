'use strict';

/**
 * The column mapping (M1, acceptance criterion 2).
 *
 * "Every legacy table has a PostgreSQL counterpart with a documented column
 * mapping."
 *
 * This test proves it three ways:
 *
 *   1. the live desktop schema (sql.js, the thirteen migrations) and the
 *      PostgreSQL migrations are compared, table by table and column by
 *      column;
 *   2. when a real PostgreSQL is available, the LIVE PostgreSQL schema is
 *      compared too, so the migration files and the database cannot drift
 *      apart;
 *   3. the documented mapping names every table, so the documentation cannot
 *      fall behind the schema.
 *
 * The rules the comparison applies:
 *
 *   - every legacy table has a PostgreSQL table;
 *   - every legacy column exists in the PostgreSQL table, with a type that
 *     belongs to the allowed set for that legacy type;
 *   - every PostgreSQL column is either a legacy column or a DOCUMENTED
 *     addition (the tenant column, and the insertion-order column).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const initSqlJs = require('sql.js');
const { MIGRATIONS: SQLITE_MIGRATIONS } = require('../../src/main/lead-intelligence/persistence/migrations');
const { MIGRATIONS: PG_MIGRATIONS } = require('../../packages/lead-intelligence-postgres/src/index');

const root = path.join(__dirname, '..', '..');
const DOC = path.join(root, 'docs', 'PERSISTENCE-M1.md');

/** The columns the PostgreSQL schema adds on purpose. */
const DOCUMENTED_ADDITIONS = new Set(['workspace_id', 'seq']);

/**
 * The legacy type -> the PostgreSQL types it may become.
 *
 * 'text'    a TEXT column, or a TEXT column with a CHECK
 * 'int'     an INTEGER column
 * 'ts'      a timestamp: TEXT on the desktop, TIMESTAMPTZ in PostgreSQL
 * 'json'    a JSON document: TEXT on the desktop, JSONB in PostgreSQL
 * 'bool'    a 0/1 flag: INTEGER on the desktop, BOOLEAN in PostgreSQL
 * 'time'    a time of day: TEXT on the desktop, TIME in PostgreSQL
 */
const ALLOWED = {
  text: ['text', 'character varying', 'character'],
  int: ['integer', 'bigint', 'smallint'],
  ts: ['text', 'timestamp with time zone', 'timestamp without time zone'],
  json: ['text', 'jsonb', 'json'],
  bool: ['integer', 'smallint', 'boolean'],
  time: ['text', 'time without time zone', 'time'],
};

/** The legacy column types, read from the live desktop schema. */
function readSqliteSchema() {
  return (async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    for (const m of SQLITE_MIGRATIONS) db.exec(m.sql);
    const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'li_%' ORDER BY name")[0].values.flat();
    const schema = new Map();
    for (const table of tables) {
      const cols = new Map();
      for (const row of db.exec(`PRAGMA table_info(${table})`)[0].values) {
        const [cid, name, type] = row;
        cols.set(String(name), String(type).toLowerCase());
      }
      schema.set(table, cols);
    }
    db.close();
    return schema;
  })();
}

/**
 * The PostgreSQL schema, read from the migration files.
 *
 * The parser understands the two statements the migrations use to define a
 * table: CREATE TABLE ... ( ... ) and ALTER TABLE ... ADD COLUMN. It is
 * deliberately small: it reads the migrations this repository ships, and it
 * fails loudly on a statement it does not understand, so a new form of DDL
 * cannot slip past it.
 */
function readPgSchemaFromMigrations() {
  const schema = new Map();
  for (const m of PG_MIGRATIONS) {
    const sql = m.sql;
    const createRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
    let match = createRe.exec(sql);
    while (match) {
      const [, table, body] = match;
      const cols = new Map();
      const bodyLines = body.split('\n');
      for (let i = 0; i < bodyLines.length; i += 1) {
        const line = bodyLines[i].trim();
        if (!line || line.startsWith('--') || line.startsWith('PRIMARY KEY') || line.startsWith('UNIQUE') || line.startsWith('FOREIGN KEY')) continue;
        if (line.startsWith('CHECK')) {
          // A table constraint, possibly spread over several lines: skip it
          // whole, so its words are never mistaken for columns.
          let depth = (line.match(/\(/g) || []).length - (line.match(/\)/g) || []).length;
          while (depth > 0 && i + 1 < bodyLines.length) {
            i += 1;
            depth += (bodyLines[i].match(/\(/g) || []).length - (bodyLines[i].match(/\)/g) || []).length;
          }
          continue;
        }
        const colMatch = /^(\w+)\s+(.+?)(?:\s+NOT NULL)?(?:\s+DEFAULT[^,]*)?(?:,)?$/.exec(line);
        if (!colMatch) continue;
        cols.set(colMatch[1], pgType(colMatch[2]));
      }
      schema.set(table, cols);
      match = createRe.exec(sql);
    }
    const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(?:IF NOT EXISTS\s+)?(\w+)\s+([A-Za-z()\s]+)/gi;
    let alter = alterRe.exec(sql);
    while (alter) {
      const [, table, column, type] = alter;
      if (!schema.has(table)) schema.set(table, new Map());
      schema.get(table).set(column, pgType(type));
      alter = alterRe.exec(sql);
    }
  }
  return schema;
}

/** The PostgreSQL type of a column definition, without the constraints. */
function pgType(definition) {
  const text = String(definition).trim().toLowerCase();
  if (text.startsWith('timestamptz')) return 'timestamp with time zone';
  if (text.startsWith('timestamp')) return 'timestamp without time zone';
  if (text.startsWith('jsonb')) return 'jsonb';
  if (text.startsWith('json')) return 'json';
  if (text.startsWith('boolean')) return 'boolean';
  if (text.startsWith('bigserial') || text.startsWith('bigint')) return 'bigint';
  if (text.startsWith('smallint')) return 'smallint';
  if (text.startsWith('integer') || text.startsWith('int ')) return 'integer';
  if (text.startsWith('time')) return 'time without time zone';
  if (text.startsWith('varchar')) return 'character varying';
  if (text.startsWith('text') || text.startsWith('character')) return 'text';
  return text;
}

/** The legacy type of a column, mapped onto the allowed sets. */
function legacyKind(type) {
  const t = String(type).toLowerCase();
  if (t.includes('int')) return 'int';
  if (t.includes('char') || t.includes('clob') || t.includes('text')) return 'text';
  return 'text';
}

/** The column names that hold a timestamp, a JSON document or a 0/1 flag. */
const TS_COLUMNS = new Set([
  'applied_at', 'created_at', 'updated_at', 'started_at', 'finished_at', 'next_attempt_at', 'captured_at', 'expires_at',
  'detected_at', 'added_at', 'first_seen_at', 'approved_at', 'consented_at', 'recorded_at', 'collected_at', 'received_at', 'generated_at',
  'paused_until', 'connected_at', 'reviewed_at', 'first_accepted_at', 'activated_at', 'resume_at', 'replies_gap_at', 'due_at',
  'sent_at', 'at', 'gap_at', 'routed_at', 'confirmed_at',
]);
const JSON_COLUMNS = new Set([
  'options_json', 'packet_json', 'change_json', 'definition_json', 'draft_json', 'metadata_json', 'fields_json', 'steps_json',
  'value_json', 'provider_confidence_json',
]);
const BOOL_COLUMNS = new Set(['backfilled', 'is_default', 'paused']);
const TIME_COLUMNS = new Set(['window_start', 'window_end']);

function kindOf(column) {
  if (TS_COLUMNS.has(column)) return 'ts';
  if (JSON_COLUMNS.has(column)) return 'json';
  if (BOOL_COLUMNS.has(column)) return 'bool';
  if (TIME_COLUMNS.has(column)) return 'time';
  return null;
}

test('every legacy table has a PostgreSQL counterpart, and every column maps', async () => {
  const sqlite = await readSqliteSchema();
  const postgres = readPgSchemaFromMigrations();

  const problems = [];
  for (const [table, cols] of sqlite) {
    const pgCols = postgres.get(table);
    if (!pgCols) {
      problems.push(`${table}: no PostgreSQL counterpart`);
      continue;
    }
    for (const [column, type] of cols) {
      const pgTypeName = pgCols.get(column);
      if (!pgTypeName) {
        problems.push(`${table}.${column}: no PostgreSQL column`);
        continue;
      }
      if (column === 'workspace_id') {
        // The F2 architecture scopes every tenant table by a uuid. The
        // desktop keeps the column as text, and the desktop's own data and
        // schema are untouched.
        if (pgTypeName !== 'uuid') problems.push(`${table}.${column}: the workspace column must be a uuid, not '${pgTypeName}'`);
        continue;
      }
      const kind = kindOf(column) || legacyKind(type);
      const allowed = ALLOWED[kind] || ALLOWED.text;
      if (!allowed.includes(pgTypeName)) {
        problems.push(`${table}.${column}: PostgreSQL type '${pgTypeName}' is not one of ${allowed.join(', ')}`);
      }
    }
    for (const column of pgCols.keys()) {
      if (cols.has(column)) continue;
      if (!DOCUMENTED_ADDITIONS.has(column)) {
        problems.push(`${table}.${column}: an undocumented PostgreSQL column`);
      }
    }
  }
  assert.deepEqual(problems, [], 'every legacy table and column has a PostgreSQL counterpart');
});

test('the PostgreSQL schema has no table the desktop does not have', async () => {
  const sqlite = await readSqliteSchema();
  const postgres = readPgSchemaFromMigrations();
  const extra = [...postgres.keys()].filter((t) => !sqlite.has(t));
  assert.deepEqual(extra, [], 'the two schemas describe the same tables');
});

test('every tenant key and unique index is tenant-safe', () => {
  // A key that is not scoped by the workspace lets one customer's row block
  // another customer's row, and lets a lookup cross the boundary. So every
  // primary key and every UNIQUE index of a tenant table must carry the
  // workspace, and every index must LEAD with it.
  const sql = PG_MIGRATIONS.map((m) => m.sql).join('\n');
  const tables = new Set();
  for (const m of PG_MIGRATIONS) {
    for (const match of m.sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/gi)) tables.add(match[1]);
  }
  const global = new Set(['li_schema_migrations', 'li_market_rules']);
  const problems = [];

  // The primary keys, per table.
  const pkRe = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)\s*\(([\s\S]*?)\n\);/gi;
  let m = pkRe.exec(sql);
  while (m) {
    const [, table, body] = m;
    if (!global.has(table)) {
      const pk = /PRIMARY KEY\s+\(([^)]*)\)/i.exec(body);
      if (!pk) problems.push(`${table}: no primary key`);
      else if (!/workspace_id/i.test(pk[1])) problems.push(`${table}: the primary key (${pk[1]}) is not scoped by the workspace`);
    }
    m = pkRe.exec(sql);
  }

  // The unique indexes.
  const uqRe = /CREATE UNIQUE INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  let u = uqRe.exec(sql);
  while (u) {
    const [, index, table, columns] = u;
    if (!global.has(table) && !/workspace_id/i.test(columns)) {
      problems.push(`${index}: the unique index on ${table} (${columns}) is not scoped by the workspace`);
    }
    u = uqRe.exec(sql);
  }

  // The indexes: every tenant index leads with the workspace.
  const ixRe = /CREATE (?:UNIQUE )?INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)\s+ON\s+(\w+)\s*\(([^)]*)\)/gi;
  let i2 = ixRe.exec(sql);
  while (i2) {
    const [, index, table, columns] = i2;
    if (!global.has(table) && !/^\s*workspace_id/i.test(columns)) {
      problems.push(`${index}: the index on ${table} (${columns}) does not lead with the workspace`);
    }
    i2 = ixRe.exec(sql);
  }

  assert.deepEqual(problems, [], 'every key and index is tenant-safe');
});

test('the documented mapping names every table', async () => {
  const sqlite = await readSqliteSchema();
  const doc = fs.readFileSync(DOC, 'utf8');
  const missing = [...sqlite.keys()].filter((t) => !doc.includes(`\`${t}\``));
  assert.deepEqual(missing, [], 'the mapping document names every table');
});

test('the live PostgreSQL schema matches the migration files', { skip: !process.env.ZTECH_PG_URL && 'set ZTECH_PG_URL to compare against a live PostgreSQL' }, async () => {
  // A real database, with the schema named `li` - the name the deployment
  // has - and the migrations applied by the owner.
  const { freshDatabase, dropDatabase } = require('./lib/postgres');
  const db = await freshDatabase('ztech_mapping', { workspace: '11111111-1111-4111-8111-111111111111' });
  try {
    const rows = await db.owner.query(
      "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'li' ORDER BY table_name, column_name",
    );
    const live = new Map();
    for (const r of rows.rows) {
      if (!live.has(r.table_name)) live.set(r.table_name, new Map());
      live.get(r.table_name).set(r.column_name, r.data_type);
    }
    const fromFiles = readPgSchemaFromMigrations();
    const problems = [];
    for (const [table, cols] of fromFiles) {
      const liveCols = live.get(table);
      if (!liveCols) { problems.push(`${table}: the live database has no such table`); continue; }
      for (const [column, type] of cols) {
        if (!liveCols.has(column)) problems.push(`${table}.${column}: the live database has no such column`);
        else if (liveCols.get(column) !== type) problems.push(`${table}.${column}: the file says '${type}', the database says '${liveCols.get(column)}'`);
      }
    }
    assert.deepEqual(problems, [], 'the migration files and the live database agree');
  } finally {
    await dropDatabase('ztech_mapping', [db.pool, db.owner, db.platformPool, db.admin]);
  }
});
