# Phase 1 Evidence Ledger

**Ledger initialized:** 2026-10-26. This document records observed engineering evidence only. Copying these documents into the user's Windows repository, making commits, pushing branches and executing tests must be performed and verified by ARGON; they have **not** been executed merely by the existence of this package.

| Gate | Current state | Required actual evidence |
|---|---|---|
| M5 baseline (historical only) | VERIFIED baseline, **not Phase 1** | SHA `e0954832a305b1ca8ef5c5e19599072baf31bd51`; GitHub Actions run `40215788539` previously succeeded; check live status independently |
| Git Phase 1 worktree | AGENT-REPORTED LOCAL | `git -C "G:\ZTech-Lead-Generation" rev-parse HEAD`; `git branch --show-current`; `git worktree list --porcelain` |
| Five pending docs in owner repo | NOT VERIFIED | Actual file sizes and content validation in the Windows repository |
| Documentation commit SHA | NOT VERIFIED | Real `git commit` stdout and full `git rev-parse HEAD`; verify `git show HEAD:pending/PENDING-FEATURES.md` |
| Phase 1 remote branch | NOT VERIFIED | Non-empty `git ls-remote --heads origin feat/phase1-durable-research`, matching GitHub branch |
| M4 queue import and migration 016 | NOT EXECUTED | Source diff and full PostgreSQL 16 migrations; schema/role tests |
| Worker claim/no-op and fencing | NOT EXECUTED | Real `Worker` tests using PG16 worker role and fenced complete |
| Authenticated API and tenant isolation | NOT EXECUTED | Session/cookie/CSRF integration tests and cross-tenant 403/404 evidence |
| Retry/cancel/recovery | NOT EXECUTED | Idempotency, crash, stale lease, retry ceiling and authorized cancellation tests |
| Dashboard persistent status | NOT EXECUTED | Playwright authenticated submit/refresh/re-login/restart, screenshots |
| Actual owner-ready SaaS and worker CLI | NOT EXECUTED | Startup command/process logs and validated database roles |
| Phase 1 CI | NOT EXECUTED | Fresh Phase 1 branch GitHub Actions run ID, job summaries and skips |
| Draft PR | NOT CREATED | PR URL, exact source/base branches and HEAD SHA; unmerged |

## Open risks

- Previous ARGON reports contained unverified/fabricated-looking commit SHA and test claims; treat all Phase 1 prior statements as unverified until independently reproduced.
- Owner Windows machine installation is not proven by GitHub Actions alone.
- M4 queue migration security contracts and M5 persistence/startup may conflict; resolve through testable integration rather than bypassing roles.

## Agent update format

For each gate record: UTC timestamp; full branch/commit SHA; exact command/test; observed result with exit code; counts of passed, failed and skipped; CI URL or screenshot/artifact; reason if blocked. Never replace these with planned output or example values.