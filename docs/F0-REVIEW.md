# F0 review summary — ZTech Lead Generation cloud-SaaS programme

**Date:** 2026-10-20
**Scope:** Phase F0 (foundation, tests, release engineering) across the three
ZTech repositories.
**Status:** submitted for review. **Nothing has been pushed or merged.**
**Branches:** `feat/cloud-saas-f0-foundation` in each of the three ZTech
repositories, each created from its own correct remote base branch.

---

## 1. Branch tracking — verified against the correct remote base branches

| Repository | Base branch | Base commit (origin) | Working branch | HEAD | Base is an ancestor of HEAD | Ahead | Behind |
|---|---|---|---|---|---|---|---|
| ZTech-Lead-Generation | `feat/lead-intelligence-v0.3` | `58ecf11a0bd5044344ceb06b3b39a22076cbbf48` | `feat/cloud-saas-f0-foundation` | `8f3b794` | **YES** | 3 | 0 |
| ztech-opportunity-intelligence | `main` | `03e8de861e50c9440a23927aab06cfaecee6ffb5` | `feat/cloud-saas-f0-foundation` | `12ac792` | **YES** | 1 | 0 |
| ztech-legal | `main` | `4d738d6ac6ded415801e0973047ec7a283f10767` | `feat/cloud-saas-f0-foundation` | `5e25311` | **YES** | 1 | 0 |

Verification commands and their results:

```
git merge-base --is-ancestor origin/<base> HEAD   -> exit 0 for all three
git merge-base origin/<base> HEAD
  ZTech   -> 58ecf11a0bd5044344ceb06b3b39a22076cbbf48  (== origin/feat/lead-intelligence-v0.3)
  OI      -> 03e8de861e50c9440a23927aab06cfaecee6ffb5  (== origin/main)
  Legal   -> 4d738d6ac6ded415801e0973047ec7a283f10767  (== origin/main)
git rev-list --count HEAD..origin/<base>           -> 0 for all three
```

**The base branches were not modified.** The local `feat/lead-intelligence-v0.3`,
`main` and `main` still point at exactly their origin commits. The working
branches are local only — `git branch -r` shows no `origin/feat/cloud-saas-f0-foundation`
in any repository, so **nothing has been pushed**.

### Source of truth

The ZIP supplied with the handover (`ZTech-Lead-Generation-main (1).zip`) is an
**outdated snapshot** of `origin/main` @ `fc264e8` (2024-09-24 → 2026-09-24): 18
files, **no `tests/`**, **no `src/main/lead-intelligence/`**. It is **116 commits
behind** the required base branch. It was discarded; all work is on GitHub
clones verified at the exact origin HEAD.

`z-sops/zuni-seo` is a **separate ZuniTech product** and an external
integration dependency. It was inspected read-only to verify the contract in
G-39/G-40. **It has not been modified, committed to, or pushed.**

---

## 2. Actual changed-file diff

Full patches are on disk for review:
`C:\Users\EC\AppData\Local\Temp\zcode-acp\15816-61d26694\opencode\diffs\`
(`ZTech-Lead-Generation.diff` 710 KB, `ztech-opportunity-intelligence.diff`
40 KB, `ztech-legal.diff` 49 KB). Reproduce with
`git diff origin/<base>..HEAD` in each repository.

### 2.1 ZTech Lead Generation — 30 files, +4,414 / −1,897

```
 .github/dependabot.yml                             |   30 +
 .github/workflows/ci.yml                            |  101 +
 .gitignore                                         |    1 +
 CHANGELOG.md                                       |  102 +
 docs/AUDIT-BASELINE-2026-10-20.md                  |  701 +
 docs/DEPENDENCIES.md                               |  139 +
 docs/PROJECT-UPDATE.md                             |  211 +
 docs/RELEASE.md                                    |  194 +
 eslint.config.js                                   |  190 +
 package-lock.json                                  | 3358 +++---
 package.json                                       |   18 +-
 scripts/check-repo.js                              |  264 +
 scripts/demo-backup-recovery.js                    |  117 +
 scripts/reconcile-test-counts.js                   |  155 +
 src/main/accountStore.js                           |   66 +-
 src/main/lead-intelligence/persistence/atomicFile.js |  18 +-
 src/main/lead-intelligence/persistence/contract.js |    2 +-
 tests/account-store-json.test.js                   |   13 +-
 tests/backup-recovery.test.js                      |  163 +
 tests/collection-quality-report.test.js            |    4 +-
 tests/company-foundation.test.js                   |    4 +-
 tests/f26-live-apply.test.js                       |    1 -
 tests/frontend3-leads-workspace.test.js            |    4 +-
 tests/frontend5-lead-drawer.test.js                |    2 +-
 tests/identity-resolution.test.js                  |    4 +-
 tests/lead-intelligence.test.js                    |  160 +-
 tests/lead-intelligence/migrations-apply.test.js   |  147 +
 tests/lead-qualification.test.js                   |    4 +-
 tests/lib/discover.js                              |   86 +
 tests/run-all.js                                  |  288 +-
 tests/runtime-containment.test.js                  |   32 +-
 tests/targets.test.js                              |    4 +-
```

**The entire production-source change is 3 files and 4 functional edits.** No
renderer, IPC, provider, research, outreach, trust, mailbox or sequence
behaviour was touched. Full production diff:

| File | Change | Why |
|---|---|---|
| `src/main/accountStore.js` | `saveDB()` now writes through `writeFileAtomic()`; `initDB()` restores a corrupt primary from the `.bak`; two new helpers `_canOpenDatabase()` / `_restoreFromBackup()` | G-10 — the primary store had no backup and no restore |
| `src/main/lead-intelligence/persistence/atomicFile.js` | `writeFileAtomic()` removes its temp file and leaves the target untouched on failure; stale "with the user's approval" comment replaced | G-10 — the helper existed but had **zero call sites** |
| `src/main/lead-intelligence/persistence/contract.js` | one literal NUL byte written as `\u0000` | G-23 — the file registered as binary to `rg`; the key bytes are unchanged |

Everything else is tests, CI, tooling and documentation.

### 2.2 Opportunity Intelligence — 10 files, +375 / −9

```
 .dockerignore                                |  37 +
 .github/workflows/ci.yml                      | 117 +
 Dockerfile                                    |  56 +
 docs/PROJECT-UPDATE.md                       |  96 +
 src/ztech_oi/adapters/rest.py                |  13 +-
 src/ztech_oi/application/research_service.py |   2 +-
 src/ztech_oi/persistence/memory.py           |   3 +-
 src/ztech_oi/persistence/sqlite.py           |   2 +-
 tests/test_local_service_launcher.py         |   1 -
 tests/test_rest_report_routes.py             |  57 +
```

Production changes: `rest.py` adds the `research_id` path pattern (G-49) and
imports `Path`; `research_service.py` wraps one `ErrorCode(...)` argument in
`str()` (the mypy fix); `memory.py` / `sqlite.py` are import-order only; one
unused `import os` removed from a test.

### 2.3 Legal — 5 files, +496 / −1

```
 .github/workflows/ci.yml |  84 +
 README.md                |  64 +-
 docs/LEGAL-GAPS.md       |  56 +
 docs/PROJECT-UPDATE.md   |  99 +
 scripts/check-legal.js   | 194 +
```

**No legal wording was changed.** `README.md` is the only existing document
touched, and only to describe the repository.

---

## 3. Complete test reconciliation

### 3.1 The error in the earlier report

The figure **2,312** reported in the previous status message was **wrong** — it
double-counted. The old runner's own summary line was:

```
=== SUMMARY ===
Total: 1921 tests (1921 passed, 0 failed)
Files: 88
```

1,921 already **includes** the bridge's 391. Adding a separate bridge run gave
the erroneous 2,312. **The true baseline is 1,921 assertions in 88 files.**

### 3.2 How the baseline was established

The original runner was executed at the base commit in a detached worktree, so
the comparison is against the real historical behaviour, not a recollection:

```
git worktree add --detach <tmp> 58ecf11
node <tmp>/tests/run-all.js
  === SUMMARY ===
  Total: 1921 tests (1921 passed, 0 failed)
  Files: 88
```

### 3.3 The reconciliation, per file

`scripts/reconcile-test-counts.js` parses the captured output of both runners
and compares them file by file:

```
=== TEST COUNT RECONCILIATION ===

OLD runner (base commit 58ecf11) : 88 files, 1921 assertions
NEW runner (F0 branch)            : 117 files, 1937 assertions

identical                 : 87 file(s), 1530 assertion(s)
count changed             : 1 file(s)
    lead-intelligence.test.js: 391 -> 6  (-385)
removed                   : 0 file(s)
added                     : 29 file(s)
    backup-recovery.test.js: 6 assertion(s)
    lead-intelligence/*: 27 pre-existing nested suites, 391 assertion(s) total
    lead-intelligence\migrations-apply.test.js: 4 assertion(s) (new)

The bridge file was rewritten from a re-executor into a discovery guard:
    old: reported 391 (the aggregate of 27 nested node:test suites)
    new: reports  6 (6 guard assertions)
    the 391 nested assertions are now executed and counted directly
    by the runner, once, as 27 separate files.

=== ARITHMETIC ===
OLD total  = 1921
NEW total  = 1937
difference = +16

  1921 (all 88 original files, unchanged except the bridge)
+ -385 (the rewritten bridge: 391 aggregate -> 6 guard assertions)
+ 391 (the 27 nested suites, now counted directly rather than through the bridge)
+ 4 (new migration tests)
+ 6 (new backup/recovery tests)
= 1937

RECONCILED: every old assertion is accounted for.
```

**No assertion was lost. 0 files were removed. 87 of 88 files are byte-identical
in count.** The +16 is entirely new coverage plus the bridge's change of role.

| | Before | After |
|---|---|---|
| Test files executed | 88 | **117** |
| Assertions | 1,921 | **1,937** (+16) |
| Failing | 0 | **0** |
| Skipped silently | up to 37 | **0** |
| Assertions counted from | scraped console output | **real exit codes** |

### 3.4 The four runner defects this exposed

| Defect | Old behaviour | New behaviour |
|---|---|---|
| Flat discovery | `readdirSync(tests)` — the 28 nested suites were reachable only through a bridge that scraped their output. A new nested directory would have been **silently ignored while the suite stayed green**. | Recursive discovery via `tests/lib/discover.js`; `tests/lead-intelligence.test.js` is now a **discovery guard** that proves no suite can be dropped. |
| False green | A file that printed `N passed, 0 failed` and *then* exited non-zero was counted as a **pass** (the `else if (code !== 0)` branch was unreachable once a summary line existed). | The **exit code is authoritative**. |
| Discarded output | A red suite printed only counts; every `FAIL -` line and stack trace was thrown away. | The captured stdout/stderr of every failing file is printed. |
| No timeout | A hung promise blocked the run **forever**. | Per-file timeout (120 s default), with the offending file named. |
| Silent skips | 37 persistence assertions are `{ skip }`-guarded when `sql.js` is missing, and a fully-skipped file still exits 0. | The runner **refuses to start** without `sql.js`, and skip counts are reported. |

---

## 4. Restore-test evidence

The F0 backup/restore path is proven by a unit test and by a live
demonstration on a real file system.

### 4.1 Unit test — `tests/backup-recovery.test.js` (6 assertions)

```
ok - 1. the store opened in SQL mode (the SQL path is the one under test)
ok - 2. a save creates a rolling .bak of the previous database file
ok - 3. the .bak is exactly the file as it was before the last write
ok - 4. a corrupt primary file is recovered from the .bak
ok - 5. a failed save leaves the previous good file untouched
ok - 6. the store still works normally after the recovery
6 passed, 0 failed
```

### 4.2 Live demonstration — `scripts/demo-backup-recovery.js`

```
ZTech F0 - database backup and restore demonstration
  data directory: ...\ztech-restore-demo-wUSTCa\data

STEP 1 - after the first save
  primary exists                         true
  primary size (bytes)                   65536
  backup exists                          true
  backup size (bytes)                    65536
  primary sha256[0:16]                   1873f35a1bdf451b

STEP 2 - exactly one more write; the .bak becomes the previous state
  primary sha256[0:16] (new)             3a4ffc4da388cc1c
  backup sha256[0:16] (previous)         1873f35a1bdf451b
  backup == the file before the write    true
  primary != backup                      true

STEP 3 - the primary file is corrupted (simulated disk damage)
  primary sha256[0:16]                   33b0116ff4eb6b54
  backup sha256[0:16]                    1873f35a1bdf451b

STEP 4 - the app starts again and recovers
  storage mode                           sql
  data may be incomplete                 true
  recovered primary sha256[0:16]         1873f35a1bdf451b
  restored from the .bak                 true
  unreadable original preserved          whatsapp.db.corrupt-1792442738783
  leads readable after recovery          1

STEP 5 - a failed save must not damage the last good copy
  the failure was reported to the caller true
  primary unchanged (sha matches)        true
  no temporary file left behind          true
```

### 4.3 What this changes for the user

Before F0, a crash during the whole-file database rewrite destroyed the **only**
copy of every lead, suppression record, consent record, mailbox reference and
send log. Now:

- every save keeps the **previous** file as `whatsapp.db.bak`;
- a corrupted primary is **restored automatically at startup** — the user sees
  their data, not an empty lead library;
- the unreadable original is **never deleted** (preserved as
  `whatsapp.db.corrupt-<timestamp>`);
- the UI is told the data may be one save behind
  (`storageStatus.dataMayBeIncomplete`);
- a failed save leaves the last good file **byte-identical**.

**Known limitation, unchanged by F0:** the `.bak` is a *single* generation
behind. If a defect is discovered several writes later, the `.bak` may already
contain it. A multi-generation, versioned backup is audit gap **G-11** and is
not done.

---

## 5. CI and test evidence

### 5.1 What CI now runs

| Repository | Workflow | Jobs |
|---|---|---|
| ZTech | `.github/workflows/ci.yml` | `test` on **ubuntu-latest + windows-latest × Node 20 + 22**: `npm ci` → `check:repo` → `lint` → `npm test` → `audit:prod`; and `package` on windows-latest: `npm run build:win` + artifact check |
| ZTech | `.github/dependabot.yml` | weekly npm + monthly actions |
| OI | `.github/workflows/ci.yml` | `test` on **ubuntu-latest + windows-latest × Python 3.11 + 3.13**: install → `pytest` → `ruff` → `mypy` → JSON-schema drift check; `contract` (Node MCP contract test, the ZTech ↔ OI proof); `image` (build the Docker image, assert `/v1/health` answers) |
| Legal | `.github/workflows/ci.yml` | `check` on ubuntu-latest: `check-legal.js` → UTF-8/control-character check → structural completeness check |

**No CI step contacts a paid provider, sends mail, or triggers outreach.** The
provider integrations are exercised against fakes only.

### 5.2 Locally executed equivalents

The workflows cannot run in this environment (no GitHub runner, and Docker's
daemon is not running). Every step was therefore executed directly:

```
# ZTech
npm ci
  added 379 packages in 30s
npm run check:repo
  Repository check: clean.
npm run lint
  ✖ 287 problems (0 errors, 287 warnings)
npm test
  Test files: 117 (117 passed, 0 failed)
  Assertions: 1937 (1937 passed, 0 failed, 0 skipped)
npm run audit:prod
  found 0 vulnerabilities
npm run build:win
  electron-builder version=26.17.0
  artifact: dist\win-unpacked\... (180MB)

# Opportunity Intelligence
python -m venv .venv && pip install -e ".[rest,dev]" ruff mypy
python -m pytest -q                    -> 252 passed, 1 skipped
python -m ruff check src tests scripts -> All checks passed!
python -m mypy src                     -> Success: no issues found in 48 source files
python scripts/export_schema.py        -> schemas/ unchanged (examples/ carry a
                                          timestamp and a research id by design)

# Legal
node scripts/check-legal.js
  regressions: 0
  known gaps: 13 (tracked in docs/LEGAL-GAPS.md)
  No regressions.
```

The OI container command path was verified outside a container (the image build
itself is verified by the CI `image` job):

```
python -m uvicorn ztech_oi.adapters.rest:app --host 0.0.0.0 --port 8099
  GET /v1/health  (Host: 127.0.0.1)   -> 200 {"status":"ok","schema_version":"1.0"}
  GET /v1/engine  (Host: evil.example)-> 421 MISDIRECTED_REQUEST
```

### 5.3 Lint — incremental, as approved

- **ESLint 10.13.0** + `globals`, flat config, **no formatting rules and no
  stylistic rules** — the existing house style stays a human convention, so the
  diff does not obscure the real changes.
- **Error tier** (enforced from day one, must stay at 0): correctness rules the
  codebase already satisfies — `no-undef`, `no-unreachable`, the duplicate
  family, the assignment family, `no-eval`/`no-implied-eval`, `valid-typeof`,
  `use-isnan` and the rest. **0 violations across 272 files.**
- **Warning tier** (reported, counted, not enforced): the visible debt —
  `eqeqeq` (100), `no-var` (117), `no-unused-vars`, `prefer-const`,
  `no-new-func` and others. **287 warnings.**
- Two rules are reported rather than enforced **on purpose**:
  `no-control-regex` and `no-irregular-whitespace`. Every violation in this
  codebase is a regex that *deliberately* matches control characters —
  stripping NUL bytes from untrusted input is a **security control** here
  (`agent/sanitize.js`, `trust/trustContract.js`,
  `mailbox/mailboxContract.js`, `providers/envelopeMapper.js`).
- The vendored round-1 bundle (generated code from an external module, and
  itself an audit blind spot — G-63) is not linted.
- The test files keep their two deliberate techniques: `new Function` to unit
  test a helper inside the 542 KB renderer, and `javascript:` URL assertions.
  One now-redundant `eslint-disable` directive was removed.
- The dependency-set guard in 7 test files was updated: the **approved** lint
  toolchain is now the expected dev dependency set, and the **production**
  dependency set is still asserted to be unchanged.

---

## 6. Known failures and known gaps

### 6.1 Test failures

**None.** 117/117 files, 1,937/1,937 assertions, 0 skipped, across all three
repositories (OI: 252 passed, 1 skipped).

### 6.2 Things that are NOT verified locally

| Item | Why | Where it is verified |
|---|---|---|
| The GitHub Actions workflows themselves | No GitHub runner in this environment | The first push to a branch will run them |
| The OI Docker image build | Docker's daemon is not running here | CI `image` job |
| The OI Node MCP contract test | Requires `npm ci` in `clients/node` and a live MCP stdio subprocess | CI `contract` job |
| The Electron desktop app actually launching | The automated suite never launches Electron; it prints `RUNTIME-REQUIRED (not unit-testable without launching Electron)` | A manual desktop smoke test — **required before the F1 rebrand ships** |

### 6.3 Known issues carried forward (unchanged by F0)

| Gap | Severity | Note |
|---|---|---|
| G-39 / G-40 | Critical | ZuniSEO REST transport sends the idempotency key as a header, not in the body (422); the envelope mapper drops every fact and every finding. **The shipped MCP path is unaffected** — the module-mode transport is unreachable today. Scheduled for the next work package. |
| G-44 | Critical | OI research is synchronous (20-90 s) against a 30 s client timeout. |
| G-38 | Critical | No tenant or workspace concept exists. |
| G-58 | Critical | The legal documents describe a local-only, Gmail-only desktop app. |
| G-10 residual | Medium | The `.bak` is one generation behind (G-11: no multi-generation backup). |
| G-08 A-1 | High | Electron 33.4.11 is EOL — **deliberately not upgraded**, see §7. |
| G-12 | Medium | Migrations 005-013 are still read from disk at require time while 001-004 are embedded. |
| G-63 | Medium | `prospect-research.cjs` is a 2,446-line generated bundle with no source in the repo. |

### 6.4 Deliberate decisions that a reviewer should challenge

1. **No linter was added in the first F0 pass** (now reversed — see §7, ESLint
   is added). The reasoning was the dependency-free guard; the reviewer's
   approval superseded it.
2. **Electron was not upgraded.** See §7.
3. **`saveDB()` was changed even though the code carried a "with the user's
   approval" note.** The change is purely additive: the previous file is kept
   as `.bak` and the target is never touched until the new one is written and
   fsynced. A failed save leaves the last good file byte-identical — proven in
   §4.
4. **The OI `examples/` directory is not drift-checked in CI** because it
   carries a research id and a generation timestamp and therefore changes on
   every run by design. Only `schemas/` is drift-checked.

---

## 7. Decisions recorded for F1

Taken at the F0 review, 2026-10-20.

### 7.1 Branding

- Product name: **ZTech Lead Generation**. Brand: **ZuniTech**.
- **The registered legal entity name must not be invented or assumed.** The
  documents use a **clearly flagged placeholder** until the business confirms
  it. The placeholder must be visibly a placeholder — e.g.
  `[LEGAL ENTITY NAME — TO BE CONFIRMED]` — never a plausible-looking name.
- The legal documents currently say **"Zunitech"** and the product repository
  says **"ZuniTech"**. The product spelling is canonical; the legal documents
  are corrected in F1 (audit gap BRAND-1).
- **The data-directory compatibility layer must ship in the same release as
  the rebrand.** The legacy identifiers `phone-global-leads`,
  `phone全球获客` and `com.whatsapp.automation` determine the `userData`
  directory, so renaming without a migration orphans every existing user's
  database, settings and credentials. This is audit gap G-50 and is a
  **data-loss risk**, not a cosmetic change.

### 7.2 Electron

- **The major Electron upgrade is deferred.** Cloud-first SaaS is the target.
- **Desktop compatibility must be preserved during core extraction** — the
  existing desktop build keeps working, and the shared core must not acquire
  Electron-only assumptions.
- **Desktop-specific architecture must not be expanded.** The two module-scope
  Electron reads (`accountStore.js:6`, `logger.js:6`) are the boundary; new
  work goes behind injectable seams rather than adding new Electron coupling.
- Consequently `docs/DEPENDENCIES.md` A-1 (Electron 33 EOL) stays an accepted
  risk with an owner and a review date, and the upgrade is re-evaluated when
  the desktop build's own lifecycle is decided.

### 7.3 Linting

- **Approved and implemented in F0** (see §5.3): incremental ESLint rules and
  CI integration, **without mass-formatting existing files**.
- Promotion path: move a rule from the warning tier to the error tier as the
  debt is paid off. The warning count must only go down.

### 7.4 Next work package (before F1 completes)

Per the review instruction, the two critical integration findings are
prioritised:

1. **G-39 / G-40 — ZuniSEO evidence mapping.** Move the idempotency key into
   the request body; rewrite `envelopeMapper.js` against the published
   contract v1 schema; vendor the contract schema into ZTech with a drift
   test; use ZuniSEO's own golden fixtures as test data. **ZuniSEO itself must
   not be modified** — the fix is entirely on the ZTech side. Evidence
   provenance and the existing security gates must be preserved.
2. **G-44 — Opportunity Intelligence timeout and job lifecycle.** Add an async
   job API to OI (`POST /v1/research` → `{research_id, status:"running"}` +
   `GET /v1/research/{id}`) and make the ZTech gateway poll, so the research
   survives a closed browser. This also requires the tenant scoping in G-46
   to be designed at the same time, because the job result must belong to a
   workspace.

---

## 8. Rollback instructions

### 8.1 Code

Nothing has been pushed, so rollback is entirely local.

```bash
# Option A - discard the F0 work completely and return to the base branch
cd <repo>
git checkout feat/lead-intelligence-v0.3   # or: git checkout main
# the working branch stays on disk; delete it when convenient
git branch -D feat/cloud-saas-f0-foundation

# Option B - undo only the last commit
git reset --hard HEAD~1

# Option C - keep the work but rewind to the base commit
git reset --hard origin/feat/lead-intelligence-v0.3
```

Base commits to reset to:

| Repository | Base commit |
|---|---|
| ZTech-Lead-Generation | `58ecf11a0bd5044344ceb06b3b39a22076cbbf48` |
| ztech-opportunity-intelligence | `03e8de861e50c9440a23927aab06cfaecee6ffb5` |
| ztech-legal | `4d738d6ac6ded415801e0973047ec7a283f10767` |

Because the base branches were never modified, `git checkout <base>` is always
a valid, working state.

### 8.2 Dependencies

`package.json` and `package-lock.json` changed. To restore the dependency set
exactly:

```bash
git checkout origin/feat/lead-intelligence-v0.3 -- package.json package-lock.json
npm ci
```

### 8.3 Data

**The F0 data change is additive and does not need a data rollback.** The
`.bak` file is new; `whatsapp.db` keeps its format and content. Rolling the
code back leaves an extra `whatsapp.db.bak` on disk, which the pre-F0 code
simply ignores.

If a rollback is ever needed for the data itself:

```powershell
Copy-Item "$env:APPDATA\<app>\data\whatsapp.db.bak" "$env:APPDATA\<app>\data\whatsapp.db" -Force
```

> The suppression and consent tables are **irreversible inside the app by
> design**. `tools/acceptance/reset-email-suppression.js` is the only
> supported way to clear one suppression, and it is an audited, out-of-app
> maintenance tool. Do not reset user data as a rollback step.

### 8.4 The rollback test itself

`tests/backup-recovery.test.js` and `scripts/demo-backup-recovery.js` are the
regression guard for the change. If the persistence behaviour ever needs to be
undone, they are also the evidence that it can be: the pre-F0 code path
(`fs.writeFileSync(tmp)` + `fs.renameSync`) is a three-line revert in
`accountStore.js:saveDB()`.

---

## 9. Review checklist

| # | Item | Where |
|---|---|---|
| 1 | Branch tracking against the correct remote bases | §1 |
| 2 | Actual changed-file diff | §2 (full patches on disk) |
| 3 | Complete test reconciliation, 1,921 → 1,937 | §3 |
| 4 | Restore-test evidence | §4 |
| 5 | CI and test evidence | §5 |
| 6 | Known failures and known gaps | §6 |
| 7 | Rollback instructions | §8 |
| 8 | F1 decisions recorded | §7 |
| 9 | Audit report | `docs/AUDIT-BASELINE-2026-10-20.md` (66 gaps) |
| 10 | Programme log | `docs/PROJECT-UPDATE.md` (and the OI and Legal logs) |

**Nothing has been pushed, merged, force-pushed, or deleted. Awaiting
approval.**
