'use strict';

/**
 * Is the database a service is about to use actually a ZTech database?
 *
 * `npm run db:dev:setup` creates the schema in the DEVELOPMENT database
 * (ztech_dev by default) while it connects to the administrative database
 * (usually `postgres`). A service started with ZTECH_PG_URL still pointing at
 * the administrative database connects fine and then fails on the first
 * request with "relation id.users does not exist" - an "internal_error" to
 * the person in the browser. This check turns that into one clear message at
 * start-up.
 *
 * It reads the system catalogue only, which every role may read, so it does
 * not depend on the role's grants.
 */

const REQUIRED = [['id', 'users'], ['li', 'job_queue']];

async function assertZtechSchema(pool) {
  const result = await pool.query(
    `SELECT current_database() AS db,
            array_agg(n.nspname || '.' || c.relname) FILTER (WHERE c.oid IS NOT NULL) AS found
       FROM (VALUES ${REQUIRED.map((_, i) => `($${i * 2 + 1}::text, $${i * 2 + 2}::text)`).join(', ')}) AS r(nsp, rel)
       LEFT JOIN pg_catalog.pg_namespace n ON n.nspname = r.nsp
       LEFT JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = r.rel`,
    REQUIRED.flat(),
  );
  const { db } = result.rows[0];
  const found = new Set(result.rows[0].found || []);
  const missing = REQUIRED.map(([s, t]) => `${s}.${t}`).filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(
      `database "${db}" has no ZTech schema (missing ${missing.join(', ')}). `
      + 'ZTECH_PG_URL must name the development database that `npm run db:dev:setup` created - '
      + 'for example postgres://localhost:5432/ztech_dev - not the administrative "postgres" database. '
      + 'Run `npm run db:dev:setup` first if you have not',
    );
  }
  return db;
}

module.exports = { assertZtechSchema };
