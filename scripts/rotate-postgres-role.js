'use strict';

/**
 * Rotate a database role's credential (M2, correction C3).
 *
 * The earlier provisioning created the roles with a KNOWN placeholder
 * password. A password that is in the repository is not a password, so
 * every role that still has one must be rotated - and the rotation must be
 * safe: a role is not left open, and a role is not left locked out.
 *
 * The procedure, in this order:
 *
 *   1. the role is made NOLOGIN, so no NEW session can use it;
 *   2. the new credential is set;
 *   3. the role is made LOGIN again;
 *   4. the result is VERIFIED against the live database: the new
 *      credential works, the old one does not, and no known placeholder
 *      works.
 *
 * Between 1 and 3 the role cannot be logged into, so the window in which a
 * stale credential would work is closed before the new one is in place.
 * Sessions that are ALREADY open are not affected - PostgreSQL does not
 * re-check a credential mid-session - so a rotation is followed by a
 * restart of the services, which is the deployment's business.
 *
 *   ZTECH_PG_ADMIN_URL        the administrator's connection string
 *   ZTECH_PG_ROTATE_ROLE      the role to rotate, e.g. ztech_app
 *   ZTECH_PG_PASSWORD_<ROLE>  the NEW credential
 *   ZTECH_PG_OLD_PASSWORD     the OLD credential, if it is known (optional)
 *
 * Usage: node scripts/rotate-postgres-role.js
 */

const { Pool } = require('pg');
const {
  passwordEnvVar, validateCredential, setCredential, disableLogin, roleProperties,
  canLogIn, describeRole, PLACEHOLDERS,
} = require('./lib/postgres-credentials');

const ADMIN_URL = process.env.ZTECH_PG_ADMIN_URL || '';
const ROLE = process.env.ZTECH_PG_ROTATE_ROLE || '';

async function main() {
  if (!ADMIN_URL) {
    console.error('ZTECH_PG_ADMIN_URL is required: this script runs as the cluster administrator.');
    process.exit(2);
  }
  if (!ROLE) {
    console.error('ZTECH_PG_ROTATE_ROLE is required: the role to rotate.');
    process.exit(2);
  }
  const env = passwordEnvVar(ROLE);
  const password = process.env[env];
  const check = validateCredential(ROLE, password);
  if (!check.ok) {
    console.error(`${env} ${check.reason}.`);
    console.error('Nothing has been changed: the role keeps whatever credential it has.');
    process.exit(1);
  }

  const admin = new Pool({ connectionString: ADMIN_URL });
  try {
    const before = await roleProperties(admin, ROLE);
    if (!before) {
      console.error(`the role ${ROLE} does not exist.`);
      process.exit(1);
    }
    console.log(`  before: ${describeRole(before)}`);

    // 1. No new logins with the old credential.
    await disableLogin(admin, ROLE);
    // 2. The new credential.
    await setCredential(admin, ROLE, password);
    // 3. Logins again.
    const { rows } = await admin.query("SELECT format('ALTER ROLE %I LOGIN', $1::text) AS statement", [ROLE]);
    await admin.query(rows[0].statement);

    // 4. The verification.
    const after = await roleProperties(admin, ROLE);
    const problems = [];
    if (!after || !after.rolcanlogin) problems.push('the role may not log in');
    if (after && after.rolsuper) problems.push('the role is a superuser');
    if (!(await canLogIn(ADMIN_URL, ROLE, password))) problems.push('the new credential does not work');
    const old = process.env.ZTECH_PG_OLD_PASSWORD;
    if (old && await canLogIn(ADMIN_URL, ROLE, old)) problems.push('the old credential still works');
    for (const placeholder of PLACEHOLDERS) {
      if (placeholder === password) continue;
      if (await canLogIn(ADMIN_URL, ROLE, placeholder)) problems.push(`the placeholder ${placeholder} still works`);
    }
    console.log(`  after:  ${describeRole(after)}`);
    if (problems.length) {
      console.error('');
      for (const p of problems) console.error(`  ${p}`);
      process.exit(1);
    }
    console.log('');
    console.log('The role is rotated. Restart the services that use it, so that the');
    console.log('sessions that are already open are gone as well.');
  } finally {
    await admin.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
