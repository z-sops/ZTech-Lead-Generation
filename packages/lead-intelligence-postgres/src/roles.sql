-- PostgreSQL 16 roles (M2).
--
-- FIVE roles, with different powers:
--
--   ztech_migrator  LOGIN. OWNS the schema, the tables and the SECURITY
--                   DEFINER functions. It is the only role that may change
--                   the schema, and it is NEVER used by a running service.
--                   It is the role that applies the migrations.
--                   It has BYPASSRLS - it is the trusted role, and the
--                   policies do not apply to it. That is a deliberate,
--                   stated privilege: a role that could bypass the
--                   policies must never serve a request.
--
--   ztech_control   LOGIN. The CONTROL PLANE. It may do exactly one
--                   thing: ask the database to issue a workspace token.
--                   It may not read a row, write a row, or open a context
--                   of its own. It exists so that the token issuer is not
--                   the role that runs the tenant's queries.
--
--   ztech_app       LOGIN. The API service. It is NOT the owner, it is NOT a
--                   superuser and it does NOT have BYPASSRLS, so the
--                   policies apply to it. It may read and write the tenant
--                   tables, and it may open a context for a workspace it
--                   holds a TOKEN for.
--
--   ztech_worker    LOGIN. The background worker. The same powers as the API
--                   for the tenant tables, and no more: it cannot touch the
--                   platform data.
--
--   ztech_platform  LOGIN. The platform console. It may READ the global
--                   reference data and WRITE the platform's own rows: the
--                   global suppressions and the market rules. It cannot
--                   write a tenant's rows.
--
-- ---------------------------------------------------------------------------
-- THERE IS NO DEFAULT PASSWORD.
-- ---------------------------------------------------------------------------
--
-- Every role is created NOLOGIN, with NO password at all. A role that has
-- no credential cannot be logged into, so a role that is created and never
-- configured is closed rather than open.
--
-- The credential comes from the deployment's environment, and
-- `scripts/provision-postgres.js` sets it and only then enables the login.
-- If the credential is missing or malformed, that script changes nothing
-- and fails. An earlier version of this file gave the roles a `CHANGE_ME_*`
-- password: a password that is written down in the repository is not a
-- password, and every role that still has one must be rotated with
-- `scripts/rotate-postgres-role.js`.
--
-- Applied by scripts/provision-postgres.js, as the cluster administrator.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ztech_migrator') THEN
    CREATE ROLE ztech_migrator NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ztech_control') THEN
    CREATE ROLE ztech_control NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ztech_app') THEN
    CREATE ROLE ztech_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ztech_worker') THEN
    CREATE ROLE ztech_worker NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ztech_platform') THEN
    CREATE ROLE ztech_platform NOLOGIN;
  END IF;
END;
$$;

-- The runtime roles must not be superusers and must not bypass the row
-- security system. These are the properties the startup assertion checks in
-- the LIVE database, and this is where they are established.
ALTER ROLE ztech_app NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE ztech_worker NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE ztech_platform NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- The control plane may not bypass the row-level security either: it never
-- reads a row, and a role that could read every tenant's rows would be a
-- prize worth stealing.
ALTER ROLE ztech_control NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- The migration role: not a superuser, but it IS the trusted role that
-- bypasses the policies. It owns the tables, and the migrations it applies
-- are the ones that install the policies. It never serves a request.
ALTER ROLE ztech_migrator BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;

-- The grants on the schema, the tables and the functions are applied by the
-- schema migration (014_tenant_isolation.sql), which runs after the tables
-- exist. This file only creates the roles and their attributes, because a
-- role must exist before it can be granted anything.
