# Phase 1 — Windows Development Startup

This document is the reproducible Windows startup for the Phase 1 durable
background research workflow: the SaaS API and the background worker, both
against a real PostgreSQL 16 database with least-privilege roles.

> This is a **development** startup. It is not a production deployment, and it
> is not validated on the owner's Windows machine by Linux CI. The steps below
> must be run and verified on Windows before Phase 1 is accepted.

## Prerequisites

- **Node.js >= 20.19** and **npm** on `PATH`.
- **PostgreSQL 16** reachable at the base URL in `ZTECH_PG_URL`.
- The role credentials in the environment (see below).

## 1. Provision the development database (once)

```powershell
$env:ZTECH_PG_URL = "postgres://postgres:postgres@localhost:5432/postgres"
$env:ZTECH_PG_PASSWORD_ZTECH_MIGRATOR = "<a strong migrator credential>"
$env:ZTECH_PG_PASSWORD_ZTECH_IDENTITY  = "<a strong identity credential>"
$env:ZTECH_PG_PASSWORD_ZTECH_APP       = "<a strong app credential>"
$env:ZTECH_PG_PASSWORD_ZTECH_WORKER    = "<a strong worker credential>"
$env:ZTECH_PG_PASSWORD_ZTECH_PLATFORM  = "<a strong platform credential>"
$env:ZTECH_PG_PASSWORD_ZTECH_CONTROL   = "<a strong control credential>"

npm run db:dev:setup
```

`scripts/setup-dev-db.js`:

- refuses to run against a non-development database name (only `ztech_dev*`,
  `ztech_test*`, `test_*` are allowed);
- creates the roles `NOLOGIN` with no password, then sets each credential as a
  SCRAM verifier (never clear text) and enables login;
- enforces that no runtime role is a superuser, that only `ztech_migrator` has
  `BYPASSRLS`, and that `ztech_worker` **can** log in (it connects as
  `ztech_worker` to claim jobs);
- applies the migrations as `ztech_migrator` and aborts on the first failure;
- never deletes an existing database or Docker volume.

## 2. Start the API and the worker

```powershell
.\scripts\start-dev.ps1
```

The script validates Node/npm, `ZTECH_PG_URL` and the role credentials, then
starts two processes:

| Process | Command | Database role |
|---|---|---|
| SaaS API | `node scripts/start-saas.js --postgres` | `ztech_app` (plus `ztech_identity`, `ztech_control`) |
| Worker | `node scripts/start-worker.js` | `ztech_worker` (plus `ztech_control` to mint its identity credential) |

Stop both with **Ctrl+C**.

### Start them separately

```powershell
# API only
npm run saas:postgres

# Worker only (in a second terminal)
npm run worker
```

## 3. The role separation

| Role | Used by | Authority |
|---|---|---|
| `ztech_migrator` | `db:dev:setup` only | owns the schema; `BYPASSRLS`; never used by a running service |
| `ztech_identity` | the API | reads/writes identity tables; issues workspace tokens |
| `ztech_app` | the API | tenant-scoped reads/writes; no `BYPASSRLS` |
| `ztech_worker` | the worker | job-scoped claim/execute; no `BYPASSRLS`; never a workspace grant |
| `ztech_control` | the API and the worker startup | issues workspace/worker identity tokens only |
| `ztech_platform` | the platform console | global reference data only |

The worker never receives the migrator, control-plane or any administrative
credential. `scripts/start-worker.js` holds the control-plane credential only
long enough to mint the worker's identity credential, then hands off to the
worker runtime.

## 4. Diagnostics

- **`ZTECH_PG_URL is not set`** — set the base PostgreSQL URL.
- **`Missing role credential(s): ...`** — run `npm run db:dev:setup` with the
  credentials in the environment.
- **`PostgreSQL integration connection failed`** — the API refuses to fall back
  to in-memory storage; check the database is reachable and the credentials are
  correct.
- **`worker.identity_refused`** — the worker connected as a role other than
  `ztech_worker`; it refuses to start (fail-closed).

## 5. Development vs production

- Development uses `ztech_dev*` databases and the `--postgres` flag; demo
  auto-login and seeding are allowed only outside production.
- Production (`NODE_ENV=production` or `ZTECH_ENV=production`) forbids demo
  seeding and auto-login, and requires `ZTECH_PG_URL`.
- This document does not claim production readiness.
