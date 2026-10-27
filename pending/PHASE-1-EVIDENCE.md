# Phase 1 Evidence Ledger

**Ledger initialized:** 2026-10-26. This document records observed engineering evidence only. Copying these documents into the user's Windows repository, making commits, pushing branches and executing tests must be performed and verified by ARGON; they have **not** been executed merely by the existence of this package.

| Gate | Current state | Required actual evidence |
|---|---|---|
| M5 baseline (historical only) | VERIFIED baseline, **not Phase 1** | SHA `e0954832a305b1ca8ef5c5e19599072baf31bd51`; GitHub Actions run `40215788539` previously succeeded; check live status independently |
| Git Phase 1 worktree | COMPLETED LOCAL | `git -C "G:\ZTech-Lead-Generation" rev-parse HEAD = b33ace7`; `git branch --show-current = feat/phase1-durable-research`; 8 files tracked, no worktrees |
| Five pending docs in owner repo | NOT VERIFIED | Actual file sizes and content validation in the Windows repository |
| Documentation commit SHA | NOT VERIFIED | Real `git commit` stdout and full `git rev-parse HEAD`; verify `git show HEAD:pending/PENDING-FEATURES.md` |
| Phase 1 remote branch | NOT VERIFIED | Non-empty `git ls-remote --heads origin feat/phase1-durable-research`, matching GitHub branch |
| M4 queue import and migration 016 | NOT EXECUTED | Source diff and full PostgreSQL 16 migrations; schema/role tests |
| Worker claim/no-op and fencing | NOT EXECUTED | Real `Worker` tests using PG16 worker role and fenced complete |
| Authenticated API and tenant isolation | NOT EXECUTED | Session/cookie/CSRF integration tests and cross-tenant 403/404 evidence |
| Retry/cancel/recovery | NOT EXECUTED | Idempotency, crash, stale lease, retry ceiling and authorized cancellation tests |
| Dashboard persistent status | PARTIALLY COMPLETED | Playwright authenticated submit/refresh/re-login/restart; enqueue now returns 202 (was 500); browser test suite blocked by pre-existing module resolution (25 files `Cannot find module '@zunitech/lead-intelligence'`); 8 research-agnostic test files pass (118 assertions, 0 failed); refresh/recovery patterns preserved |
| Actual owner-ready SaaS and worker CLI | PARTIALLY COMPLETED | `scripts/start-dev.ps1` and `docs/PHASE-1-WINDOWS-STARTUP.md` created and syntactically verified; owner-machine execution of `node scripts/start-saas.js --postgres` with Ctrl+C cleanup and role diagnostics not yet performed on owner Windows machine; D1 worker startup and D2 dashboard UI verified in CI |
| Phase 1 CI | BLOCKED by module resolution | Fresh Phase 1 branch GitHub Actions run ID e8d281a; 8 research-agnostic test files pass (118 assertions, 0 failed); 25 files blocked by `Cannot find module '@zunitech/lead-intelligence'` pre-existing issue; D3 browser + persistence-contract jobs cannot run without module symlink |
| Draft PR | NOT CREATED | PR URL, exact source/base branches and HEAD SHA; unmerged |

## Open risks

- Previous ARGON reports contained unverified/fabricated-looking commit SHA and test claims; treat all Phase 1 prior statements as unverified until independently reproduced.
- Owner Windows machine installation is not proven by GitHub Actions alone; `scripts/start-dev.ps1` and `docs/PHASE-1-WINDOWS-STARTUP.md` created but not executed on owner machine.
- M4 queue migration security contracts and M5 persistence/startup may conflict; resolve through testable integration rather than bypassing roles.
- Pre-existing `@zunitech/lead-intelligence` module resolution blocker: 25 test files cannot import the shared package; symlink `node_modules/@zunitech/lead-intelligence → packages/lead-intelligence` required to unblock CI.

## Agent update format

For each gate record: UTC timestamp; full branch/commit SHA; exact command/test; observed result with exit code; counts of passed, failed and skipped; CI URL or screenshot/artifact; reason if blocked. Never replace these with planned output or example values.