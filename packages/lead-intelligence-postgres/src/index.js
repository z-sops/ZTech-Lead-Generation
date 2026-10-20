'use strict';

/**
 * @zunitech/lead-intelligence-postgres
 *
 * The PostgreSQL 16 implementation of the Lead Intelligence repository seam.
 *
 * It is a SEPARATE package from the shared core, and that is deliberate: the
 * core package has no dependencies at all - no Electron, no file system, no
 * process, and no database driver - while this one needs the `pg` driver.
 * The seam itself (the interface both stores satisfy) lives in the core
 * package, at `@zunitech/lead-intelligence/persistence/interfaces`.
 */

const fs = require('node:fs');
const path = require('node:path');
const { PostgresStore } = require('./PostgresStore');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * The PostgreSQL migrations, in order.
 *
 * They mirror the desktop's thirteen migrations one for one, so a column can
 * be traced from one backend to the other. Every file is idempotent: applying
 * it twice changes nothing.
 *
 * @returns {{version: number, name: string, sql: string}[]}
 */
function migrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  return files.map((name) => ({
    version: Number(name.slice(0, 3)),
    name,
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8'),
  }));
}

const MIGRATIONS = migrations();

module.exports = { PostgresStore, MIGRATIONS, MIGRATIONS_DIR };
