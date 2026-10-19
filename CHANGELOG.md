# Changelog

All notable changes to ZTech Lead Generation are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The product is **proprietary software owned by ZuniTech** — see `README.md`
for the licence terms.

> **Version note.** `package.json` still carries `1.0.0`. The advanced Lead
> Intelligence line lives on `feat/lead-intelligence-v0.3` and has never been
> released as a tagged build. The version scheme is being reset as part of F1
> (branding) and F0 (release process) — see `docs/RELEASE.md`.

---

## [Unreleased] — F0 foundation (branch `feat/cloud-saas-f0-foundation`)

### Fixed

- **The committed `package-lock.json` was out of sync with `package.json`.**
  `npm ci` — the only reproducible install — failed with 32 missing entries
  (`archiver`, `electron-builder-squirrel-windows`, `fs-extra` and their
  transitive tree). No CI existed to catch it. The lockfile is regenerated and
  `npm ci` now succeeds from a clean checkout.
- **The test runner could not see nested test directories.** `tests/run-all.js`
  used a flat `readdirSync`, so the 28 suites under `tests/lead-intelligence/`
  only ran because a hand-written bridge re-executed them and scraped their
  console output. A new nested directory would have been silently ignored while
  the suite still reported green. Discovery is now recursive and shared.
- **A test file that printed a green summary and then exited non-zero was
  counted as a pass.** The exit code is now authoritative.
- **Failure output was discarded.** A red suite reported only counts; the
  captured output of every failing file is now printed.
- **A hung test could block the run forever.** There is now a per-file timeout.
- **The SQL persistence layer could be silently skipped.** 37 assertions are
  guarded by `{ skip }` when `sql.js` is absent, and `node:test` exits 0 for a
  fully skipped file. The runner now refuses to start without `sql.js`.
- **A stray NUL byte in `persistence/contract.js`** made the file register as
  binary to `rg`, breaking diff and merge tooling. It is now written as
  `\u0000`; the idempotency key bytes are unchanged.
- **`dist-renderer/` was not git-ignored** even though `vite.config.js` names
  it as the build output directory.

### Added

- **CI** (`.github/workflows/ci.yml`): Ubuntu + Windows, Node 20 and 22 —
  `npm ci`, repository hygiene check, full test suite, production dependency
  audit, and a Windows packaging smoke test. No step contacts a paid provider
  or triggers outreach.
- **Dependabot** (`.github/dependabot.yml`).
- **Database backup and recovery** (audit gap G-10). The primary store is
  rewritten wholesale on every save; a crash mid-write could destroy the only
  copy of every lead, suppression and consent record. `saveDB()` now writes
  through the shared `writeFileAtomic()` helper — temp file, `fsync`, one
  rolling `.bak` of the previous file, then rename — and a corrupt primary
  file is **restored from that backup at startup** instead of silently
  presenting an empty lead library. The unreadable original is preserved for
  diagnosis and the UI is told the data may be one save behind.
- **Migration tests** (`tests/lead-intelligence/migrations-apply.test.js`):
  all 13 migrations apply to a fresh database and record contiguous versions;
  re-running is a no-op; and a deliberately broken migration is **rolled back**,
  leaving the schema at the last good version with no partial table.
- **Backup/recovery tests** (`tests/backup-recovery.test.js`): a `.bak` is
  written and is a real, openable database; the `.bak` is exactly the file as
  it was before the last write; a corrupt primary is recovered; and a failed
  save leaves the previous good file byte-identical with no temp file left
  behind.
- **Repository hygiene check** (`scripts/check-repo.js`, `npm run check:repo`):
  package.json ⇄ lockfile agreement, no committed credentials, no NUL bytes,
  no hardcoded absolute paths, every local asset referenced by `index.html`
  exists *and* is covered by the electron-builder `files` list, build output
  directories ignored, and every test file reachable by the shared discovery.
- **Release and rollback runbook** (`docs/RELEASE.md`).
- **Dependency audit record** (`docs/DEPENDENCIES.md`).
- **Audit report** (`docs/AUDIT-BASELINE-2026-10-20.md`) — 66 evidence-based
  gaps across the three ZTech repositories, with file, function, current
  behaviour, problem, recommended change, risk level and acceptance criteria.
- **Project update log** (`docs/PROJECT-UPDATE.md`).

### Changed

- `electron-builder` 25.1.8 → 26.x (build-time only; the Windows directory
  package was rebuilt and verified).
- `@modelcontextprotocol/client` 2.1.0 → 2.3.1 (transitive, within the
  declared `^2.1.0` range) — this cleared the only two **production**
  dependency advisories (`fast-uri` host-confusion / SSRF).
- `tests/lead-intelligence.test.js` changed from a re-execution bridge to a
  **discovery guard**, because the runner now executes the nested suites
  directly. Keeping the bridge would have double-executed and double-counted
  them.
- `tests/account-store-json.test.js` scope guard updated: it previously
  asserted the old non-atomic SQL save path, and now asserts the new atomic
  + backup contract.

### Test baseline

| | Before | After |
|---|---|---|
| Test files executed | 89 (88 + 1 bridge) | **117** (all discovered, recursively) |
| Assertions | 2,312 (counted via console scraping) | **1,937** (counted from real exit codes) |
| Failing | 0 | **0** |
| Skipped silently | up to 37 | **0** |
