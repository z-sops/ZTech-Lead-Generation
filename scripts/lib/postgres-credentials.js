'use strict';

/**
 * The credentials of the database roles (M2, correction C3).
 *
 * A database role's password is a secret, and a secret with a known default
 * is not a secret at all. This module is the one place that handles them:
 *
 *   - it VALIDATES a credential before it is used, and refuses a malformed
 *     one;
 *   - it SETS a credential without ever writing it to a log, an error
 *     message, a file or a command line;
 *   - it VERIFIES what the database actually says afterwards, by logging in
 *     with the credential and by reading the role's real properties.
 *
 * The rule: a role is created NOLOGIN, with no password at all, and it is
 * enabled only when a credential has been supplied. There is no default
 * password, and there is no way to end up with one.
 */

const { Pool } = require('pg');
const { URL: Url } = require('node:url');

/** The shortest credential that is accepted. */
const MIN_LENGTH = 16;

/**
 * The placeholders the earlier provisioning used. They must never work, and
 * a credential that equals one of them is refused.
 */
const PLACEHOLDERS = Object.freeze([
  'CHANGE_ME_migrator', 'CHANGE_ME_control', 'CHANGE_ME_app', 'CHANGE_ME_worker', 'CHANGE_ME_platform',
]);

/** The roles, and what each of them is. */
const ROLES = Object.freeze([
  { name: 'ztech_migrator', bypassesRls: true, service: 'the migration job' },
  { name: 'ztech_control', bypassesRls: false, service: 'the token issuer' },
  { name: 'ztech_app', bypassesRls: false, service: 'the API' },
  { name: 'ztech_worker', bypassesRls: false, service: 'the worker' },
  { name: 'ztech_platform', bypassesRls: false, service: 'the platform console' },
]);

/**
 * The environment variable that carries a role's credential.
 *
 * `ztech_app` -> `ZTECH_PG_PASSWORD_ZTECH_APP`. The name is derived from the
 * role, so a role that is added later needs no new rule.
 */
function passwordEnvVar(role) {
  return `ZTECH_PG_PASSWORD_${String(role).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

/**
 * Validate a credential.
 *
 * The reason never contains the value: a reason is safe to print.
 *
 * @returns {{ok: boolean, reason: string}}
 */
function validateCredential(role, value) {
  if (value === undefined || value === null) return { ok: false, reason: 'is not set' };
  if (value === '') return { ok: false, reason: 'is empty' };
  if (typeof value !== 'string') return { ok: false, reason: 'is not a string' };
  if (value.length < MIN_LENGTH) return { ok: false, reason: `is shorter than ${MIN_LENGTH} characters` };
  if (/[\r\n\0]/.test(value)) return { ok: false, reason: 'contains a line break or a null byte' };
  if (/^CHANGE_ME/i.test(value)) return { ok: false, reason: 'is a placeholder' };
  if (PLACEHOLDERS.includes(value)) return { ok: false, reason: 'is a known placeholder' };
  if (value === role) return { ok: false, reason: 'is the role name' };
  return { ok: true };
}

/**
 * The credentials of every role, read from the environment.
 *
 * @param {string[]} [names] the roles to collect (default: the five)
 * @returns {{credentials: Array, missing: string[], malformed: string[]}}
 *   `missing` and `malformed` hold environment variable NAMES, never values.
 */
function collectCredentials(names = ROLES.map((r) => r.name)) {
  const credentials = [];
  const missing = [];
  const malformed = [];
  for (const name of names) {
    const role = ROLES.find((r) => r.name === name) || { name, bypassesRls: false, service: 'the service' };
    const env = passwordEnvVar(name);
    const value = process.env[env];
    const check = validateCredential(name, value);
    if (!check.ok) {
      if (value === undefined || value === null || value === '') missing.push(env);
      else malformed.push(`${env} (${check.reason})`);
      continue;
    }
    credentials.push({ ...role, name, env, password: value });
  }
  return { credentials, missing, malformed };
}

/**
 * Set a role's credential and enable it.
 *
 * `ALTER ROLE ... PASSWORD` cannot take a bind parameter, so the statement
 * is built server-side with `format()` and the value is transported as a
 * parameter. The credential is never written to a log, an error message or
 * a file.
 */
async function setCredential(admin, role, password) {
  const { rows } = await admin.query(
    "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS statement",
    [role, password],
  );
  await admin.query(rows[0].statement);
  const { rows: login } = await admin.query("SELECT format('ALTER ROLE %I LOGIN', $1::text) AS statement", [role]);
  await admin.query(login[0].statement);
}

/**
 * Disable a role's logins. Existing sessions are not affected; new ones
 * are refused.
 */
async function disableLogin(admin, role) {
  const { rows } = await admin.query("SELECT format('ALTER ROLE %I NOLOGIN', $1::text) AS statement", [role]);
  await admin.query(rows[0].statement);
}

/**
 * The role's real properties, as the database sees them.
 */
async function roleProperties(admin, role) {
  const { rows } = await admin.query(
    `SELECT rolname, rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolvaliduntil
       FROM pg_roles WHERE rolname = $1`,
    [role],
  );
  return rows[0] || null;
}

/**
 * A connection string for a role, with a credential.
 *
 * The credential is put in the URL, so it must never be logged. Nothing in
 * this project logs a connection string.
 */
function credentialUrl(adminUrl, role, password) {
  const url = new Url(adminUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

/**
 * Can this role log in with this credential? The answer comes from the
 * server, not from an assumption.
 */
async function canLogIn(adminUrl, role, password, database) {
  const url = new Url(adminUrl);
  if (database) url.pathname = `/${database}`;
  const pool = new Pool({ connectionString: credentialUrl(url.toString(), role, password) });
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

/**
 * A safe summary of a role, for a log. It never contains a credential.
 */
function describeRole(properties) {
  if (!properties) return 'absent';
  return [
    properties.rolname,
    properties.rolcanlogin ? 'may log in' : 'NOLOGIN',
    properties.rolsuper ? 'SUPERUSER' : 'not a superuser',
    properties.rolbypassrls ? 'bypasses RLS' : 'no BYPASSRLS',
    properties.rolvaliduntil ? `valid until ${properties.rolvaliduntil.toISOString()}` : 'no expiry',
  ].join(', ');
}

module.exports = {
  MIN_LENGTH, PLACEHOLDERS, ROLES, passwordEnvVar, validateCredential, collectCredentials,
  setCredential, disableLogin, roleProperties, credentialUrl, canLogIn, describeRole,
};
