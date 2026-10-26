# Phase 1 Engineering Directive — Durable Background Research

**Agent:** ARGON. **Repo:** `https://github.com/z-sops/ZTech-Lead-Generation`. **Windows checkout:** `G:\ZTech-Lead-Generation`. **Integration branch:** `feat/phase1-durable-research` at the verified M5 base `e0954832a305b1ca8ef5c5e19599072baf31bd51`. **Frozen M4 P1:** `ebadd3e68d33bfcee76df16902e4601db6abaf86`.

## Delivery objective

Authenticated customer submits synthetic research -> durable PostgreSQL job -> actual M4 worker claims and executes a no-op -> job status persists -> browser displays backend status/history -> browser/API/worker restart does not lose the job. Real external business discovery is not authorized in Phase 1.

## Ordered milestones

### A. Git/worktree and owner installation

1. Run `git -C "G:\ZTech-Lead-Generation" status --porcelain=v1 -uall`, `git branch --show-current`, `git rev-parse HEAD`, `git worktree list --porcelain` and `git ls-remote --heads origin feat/phase1-durable-research`. Capture real output; do not infer a local branch is pushed.
2. Preserve all existing untracked reports/docs and both frozen Draft PRs. If the branch exists locally, resume it; do not reset, force switch or clean.
3. Verify the five `pending/` files, make a real documentation commit, capture full SHA with `git rev-parse HEAD`, push and independently verify the remote ref. No invented hashes.
4. Resolve real setup/runtime credential and database-name mismatches in `scripts/setup-dev-db.js`, `scripts/start-saas.js` and `scripts/lib/postgres-credentials.js`. Use disposable PostgreSQL 16, correct migration allow-list, generated safe credentials and restricted roles. Test actual `npm run saas` CLI; do not wipe existing data.

### B. Import original M4 P1 queue safely

1. Inspect `packages/lead-intelligence-postgres/src/migrations/016_job_queue.sql` and `packages/lead-intelligence-worker/` from the frozen M4 P1 source, plus associated queue/worker security tests.
2. Preserve the existing schema: `li.job_queue` with `job_id`, `workspace_id`, `job_type`, `idempotency_key`, `state`, `job_class`, `attempt_count`, `lease_owner`, `lease_expires_at`, `fencing_token`, etc. Do not invent a competing `status`/`lease_token` schema.
3. Review migration ordering and overlaps against M5. Apply the compatible migration chain in an isolated disposable database; do not run 016 against an otherwise empty schema or execute production migrations.
4. Preserve job-scoped authority, worker identity checks, heartbeat, lease fencing, idempotency, cancellation and retry limitations. Original no-op worker must stay no-op and refuse chargeable jobs.

### C. Async SaaS API

1. Extend the real M5 API router (`packages/lead-intelligence-api/src/server.js`), preserving **HttpOnly session cookie + CSRF + server-side membership**; do not replace it with an invented JWT Bearer authorization contract.
2. Add authenticated job submission (HTTP 202 accepted), status, history and authorized cancel/retry operations consistent with queue SQL functions and existing persistence interfaces. Use server-generated UUID identifiers; reject cross-tenant queries, forged workspace IDs and stale sessions.
3. Preserve existing M5 synchronous synthetic demo functionality via tested compatibility behavior. Use real database state names: queued, leased, running, succeeded, failed, cancelled, uncertain.

### D. Worker and results

1. Start the actual worker via `packages/lead-intelligence-worker/src/index.js` and its documented env/config/identity checks. Do not invent `worker.js --workspace-id` flags.
2. Confirm real worker claim, heartbeat, job-scoped execution, fenced completion, recovery and negative-authority tests.
3. If synthetic opportunities are materialized after a successful no-op, use an expressly authorized tenant-scoped application process; do not give worker access to unrelated workspace tables.

### E. Dashboard

1. Update accepted M5 browser client (`src/saas-client/app.js` as applicable) to submit and display real persisted job state/history, retry and cancellation.
2. Read status from backend; do not simulate progress from timers or rely on localStorage as the authoritative record.
3. Validate refresh, re-login, API restart, worker restart, authenticated evidence/result retrieval and accessible errors.

### F. Verification/CI

1. Use real PostgreSQL 16 for queue migration, API, worker, fencing, idempotency, cancellation, retry and cross-tenant tests. Mandatory PostgreSQL suites cannot be counted as passing if skipped.
2. Run the M5 browser acceptance harness at `tools/saas-browser-tests/` (Node `node --test`-based tests), plus existing M3/M4/M5 relevant regression and Windows packaging smoke.
3. Prove actual SaaS/worker CLI startup, capture command, database context, stdout/stderr, exit status, test counts and new Phase 1 GitHub Actions run IDs. Historical M5 CI run 40215788539 is background baseline only.
4. Push reviewed changes to `feat/phase1-durable-research`, open a separate Draft PR targeting the M5 development baseline; never merge or retarget existing PR #7 or PR #16.

## Reporting and acceptance

Maintain `PHASE-1-EVIDENCE.md` with real local/remote SHA, tests, exact no-skip PostgreSQL outcomes, screenshots and blockers. `NOT EXECUTED`, `IMPLEMENTED — UNVERIFIED`, and `VERIFIED` must remain distinct.

Phase 1 requires proof of the complete API -> real PostgreSQL queue -> actual no-op worker -> persistent browser history workflow, and fresh CI. Do not claim completion based on Markdown files or mock behavior.

**Not authorized:** Phase 2/3 implementation; M4 P2; paid research providers; production database operations; PR merges; autonomous outbound communications.