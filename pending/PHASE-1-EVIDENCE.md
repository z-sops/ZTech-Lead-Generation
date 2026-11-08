# Phase 1 Evidence Ledger

**Ledger initialized:** 2026-10-26. This document records observed engineering evidence only. Copying these documents into the user's Windows repository, making commits, pushing branches and executing tests must be performed and verified by ARGON; they have **not** been executed merely by the existence of this package.

| Gate | Current state | Actual evidence (2026-11-08, independently reproduced) |
|---|---|---|
| M5 baseline (historical only) | VERIFIED baseline, **not Phase 1** | SHA `e0954832a305b1ca8ef5c5e19599072baf31bd51`; GitHub Actions run `40215788539` succeeded |
| Phase 1 remote branch | VERIFIED | `git ls-remote origin feat/phase1-durable-research` = `76823b862630ab577841f9434c79ad4db7f29145` (repair commit) |
| Five pending docs in the repository | VERIFIED | `pending/` is tracked on the branch; this ledger and the register were corrected on 2026-11-08 |
| Regression of 30-31 Oct (76f0162..fcbef4e) | FIXED | `setup-dev-db.js`/`migrate-dev-db.js` loaded `require('node:pg')` and called undefined functions; CI failed on every run from 41040905010 to 41282435991. Repaired in `76823b8` |
| M4 queue import and migrations 016-021 | EXECUTED in CI | `tests/persistence-contract/job-queue-migration.test.js`, `job-queue.test.js` on PostgreSQL 16 (run 42490098037, "postgres persistence contract": success) |
| Worker claim/no-op and fencing | EXECUTED in CI | `worker-e2e.test.js`, `worker-security.test.js` (same run) |
| Authenticated API and tenant isolation | EXECUTED | `node --test tests/api/*.test.js` on real PostgreSQL 16: 86 pass, 0 fail (local, 2026-11-08) and in run 42490098037 |
| Retry/cancel/recovery | EXECUTED in CI | `job-queue.test.js`, `tests/api/research-jobs-contract.test.js` (same run) |
| Dashboard persistent status | EXECUTED in CI | Playwright `research-jobs-browser-e2e.test.js` against PostgreSQL 16 (run 42490098037, "playwright postgres browser acceptance": success) |
| Development database setup | EXECUTED | `tests/persistence-contract/dev-provisioning.test.js` 11/11 on PostgreSQL 16: fresh setup, safe re-run, migrate-only, no-ledger refusal, concurrent runners |
| Phase 1 CI | GREEN | Run 42490098037 on `76823b8`: all 8 jobs success (4 test matrix, persistence contract, Playwright, contract drift, Windows package smoke) |
| Actual owner-ready SaaS and worker CLI | NOT EXECUTED on owner machine | `npm run db:dev:setup` then `node scripts/start-saas.js --postgres` on the owner's Windows PC; the only gate left before P01/P02/P13/P14 can be `Verified` |
| Draft PR | CREATED | [#18](https://github.com/z-sops/ZTech-Lead-Generation/pull/18), Draft, base `feat/m5-product-vertical-slice`, unmerged |

## Open risks

- Previous ARGON reports contained unverified/fabricated-looking commit SHA and test claims; the table above lists only what was reproduced on 2026-11-08.
- Owner Windows machine installation is not proven by GitHub Actions alone; `scripts/start-dev.ps1` and `docs/PHASE-1-WINDOWS-STARTUP.md` created but not executed on owner machine.
- M4 queue migration security contracts and M5 persistence/startup may conflict; resolve through testable integration rather than bypassing roles.
- The `@zunitech/lead-intelligence` module-resolution blocker noted earlier no longer reproduces: `npm ci` links the workspace and all 154 test files run (CI run 42490098037).

## Agent update format

For each gate record: UTC timestamp; full branch/commit SHA; exact command/test; observed result with exit code; counts of passed, failed and skipped; CI URL or screenshot/artifact; reason if blocked. Never replace these with planned output or example values.