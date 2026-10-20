# Project update log

Running log for the ZTech Lead Generation cloud-SaaS programme. Newest first.

**Owner:** ZuniTech engineering
**Last updated:** 2026-10-20

---

## 2026-10-20 — F0 foundation started (branch `feat/cloud-saas-f0-foundation`)

### Repository scope

ZTech is **three** repositories:

| Repository | Base branch | Working branch |
|---|---|---|
| `z-sops/ZTech-Lead-Generation` | `feat/lead-intelligence-v0.3` @ `58ecf11` | `feat/cloud-saas-f0-foundation` |
| `z-sops/ztech-opportunity-intelligence` | `main` @ `03e8de8` | `feat/cloud-saas-f0-foundation` |
| `z-sops/ztech-legal` | `main` @ `4d738d6` | `feat/cloud-saas-f0-foundation` |

`z-sops/zuni-seo` is a **separate ZuniTech product** and an external
integration dependency of ZTech. It is inspected read-only to verify contract
compatibility. **Nothing in ZuniSEO is modified, committed or pushed.**

### Source of truth

The ZIP supplied with the handover (`ZTech-Lead-Generation-main (1).zip`) is an
**outdated snapshot** of `origin/main` @ `fc264e8` (2026-09-24): 18 files, no
`tests/`, no `src/main/lead-intelligence/`. It is **116 commits behind** the
required base branch and was discarded. All work is based on GitHub clones
verified at the exact origin HEAD.

### Audit (delivered)

`docs/AUDIT-BASELINE-2026-10-20.md` — 66 evidence-based gaps across the three
ZTech repositories, each with the exact file and function, the current
behaviour, the problem, the recommended change, a risk level and test and
acceptance criteria. It also records the capabilities that already work and
**must not be rebuilt** (identity resolution, ICP fit, the 11-check outreach
gate, evidence contracts, trust/consent, mailbox pacing, the ZuniSEO round-1
transport, OI contract validation, OI idempotency and recovery).

The audit's most consequential findings:

| # | Finding | Risk |
|---|---|---|
| G-10 | The primary database had **no backup and no restore** | Critical |
| G-39/G-40 | The ZuniSEO REST transport sends the idempotency key in the wrong place, and the envelope mapper **silently drops every fact and every finding** | Critical |
| G-44 | Opportunity Intelligence research takes 20-90 s but the ZTech gateway times out at 30 s | Critical |
| G-38 | No tenant or workspace concept exists anywhere | Critical |
| G-58 | The legal repository describes a local-only, Gmail-only desktop app that the product no longer is | Critical |
| G-25 | A timed-out collection submit can be **billed twice** | High |
| G-26 | No cost estimate, spend limit or budget per job | High |
| G-24 | The paid provider has no retry, no circuit breaker, no health check | High |
| G-27 | Multi-source discovery does not exist — the registry supports N, N = 1 | High |
| G-53 | The credential vault does not check the OS keyring backend, so Linux without a keyring stores keys in `basic_text` | High |

### F0 — ZTech Lead Generation (done)

| Item | Result |
|---|---|
| Lockfile | **Regenerated.** `npm ci` was failing on the committed lockfile with 32 missing entries — a hard blocker for any reproducible install. |
| Test runner | **Rewritten.** Recursive discovery, exit code authoritative, failure output printed, per-file timeout, `sql.js` a hard requirement, skip counts reported. |
| Nested suites | The 28 suites under `tests/lead-intelligence/` are now executed by the runner itself. The old re-execution bridge became a **discovery guard**. |
| CI | `.github/workflows/ci.yml` — Ubuntu + Windows, Node 20 + 22, `npm ci` → hygiene check → suite → production audit → Windows packaging smoke test. Plus `dependabot.yml`. |
| Hygiene check | `scripts/check-repo.js` — lockfile agreement, no committed credentials, no NUL bytes, no absolute paths, packaged-asset completeness, gitignore coverage, test discoverability. |
| Backup & recovery | `saveDB()` now writes through the shared `writeFileAtomic()` (temp → `fsync` → rolling `.bak` → rename), and a corrupt primary file is **restored from the backup at startup**. Previously a crash mid-write destroyed the only copy of every lead. |
| Migrations | New test proves all 13 migrations apply, are idempotent, and that a **failing migration is rolled back** leaving the schema at the last good version. |
| Dependencies | `electron-builder` 25.1.8 → 26.x (build verified); `@modelcontextprotocol/client` 2.1.0 → 2.3.1, clearing the only 2 production advisories. **Production advisories: 0.** |
| Encoding | The stray NUL byte in `persistence/contract.js` is now `\u0000`; the idempotency key bytes are unchanged. |
| Docs | `CHANGELOG.md`, `docs/RELEASE.md`, `docs/DEPENDENCIES.md`, this log. |

### F0 — ZTech Opportunity Intelligence (done)

Branch `feat/cloud-saas-f0-foundation` off `main` @ `03e8de8`.

| Item | Result |
|---|---|
| CI | `.github/workflows/ci.yml` — Ubuntu + Windows, Python 3.11 + 3.13: install → pytest → ruff → mypy → JSON-schema drift check. Plus a **Node MCP contract job** (the ZTech ↔ OI integration proof) and a **container job** that builds the image and asserts `/v1/health` answers. |
| Container image | `Dockerfile` + `.dockerignore` — python:3.12-slim, non-root uid 10001, a `/data` volume, a `HEALTHCHECK`, the service on `0.0.0.0:8099`. The Host-header DNS-rebinding check and the bearer token remain the protections. |
| Lint | `ruff` was configured but never run. 4 findings → 3 auto-fixed, 1 false positive on the `AUTH_TOKEN_ENV` *name* given an explicit `# noqa` with a reason. `ruff check` now passes. |
| Types | `mypy` was configured but never run. 1 error (`ErrorCode(err.get("error"))` could receive `None`) fixed. `mypy src` now passes on all 48 source files. |
| REST contract | G-49: the `research_id` path parameter was unvalidated on the REST routes while the MCP adapter already enforced `^[a-z]+_[A-Za-z0-9_]+$`. Both report routes now use the same pattern — a malformed id is a **422**, a well-formed but unknown id is a **404 NOT_FOUND**, never a 500. 5 new tests. |

Evidence: `252 passed, 1 skipped` · `ruff: All checks passed!` ·
`mypy: no issues found in 48 source files` · the container command path was
verified outside a container (`/v1/health` → 200; a non-loopback `Host` header
→ 421), because Docker's daemon was not running in this environment — the
image build itself is verified by the CI `image` job.

### F0 — ZTech Legal (done)

Branch `feat/cloud-saas-f0-foundation` off `main` @ `4d738d6`.

| Item | Result |
|---|---|
| CI | `.github/workflows/ci.yml` — a dependency-free document validation, a UTF-8 / control-character check and a structural completeness check. |
| Validation | `scripts/check-legal.js` separates **regressions** (fail CI: broken links, missing effective date, missing scope disclosure, legacy product names) from **known gaps** (reported and tracked). |
| Gap register | `docs/LEGAL-GAPS.md` — 18 tracked gaps with an id, severity, owner and the wording that would close each one. |
| README | What the repository is, how to validate it, and the document-control rules. |

Evidence: `0 regressions, 13 known gaps`. **No legal wording was changed** —
rewriting a privacy policy is a legal decision, and the rewrite needs the
registered entity name, the governing law, the subprocessor list and the
retention periods. The documents still describe a local-only, Gmail-only
desktop app while the product also collects from a third-party provider, sends
WhatsApp, drafts with an LLM and calls ZuniSEO. That is G-58, rated Critical,
and it is a commercial blocker.

### Test evidence

ZTech Lead Generation:

```
npm ci
  added 467 packages in 27s

node tests/run-all.js
  Test files: 117 (117 passed, 0 failed)
  Assertions: 1937 (1937 passed, 0 failed, 0 skipped)

node scripts/check-repo.js
  Repository check: clean.

npm audit --omit=dev --audit-level=low
  found 0 vulnerabilities

npx electron-builder --dir --config.win.signAndEditExecutable=false
  electron-builder version=26.17.0
  artifact: dist\win-unpacked\... (180MB)
```

Opportunity Intelligence:

```
python -m venv .venv && pip install -e ".[rest,dev]" ruff mypy
python -m pytest -q                    -> 252 passed, 1 skipped
python -m ruff check src tests scripts -> All checks passed!
python -m mypy src                     -> Success: no issues found in 48 source files
```

ZTech Legal:

```
node scripts/check-legal.js
  regressions: 0
  known gaps: 13 (tracked in docs/LEGAL-GAPS.md)
  No regressions.
```

Baseline for comparison, before F0: 89 test files executed, **1,921** assertions
counted by scraping console output, 0 failing, up to 37 assertions silently
skipped, `npm ci` failing outright, **no CI in any of the three
repositories**, ruff reporting 4 errors and mypy 1 error, and the legal
documents with no validation of any kind.

The assertion count reconciles exactly: `1,921 − 385 (the rewritten bridge)
+ 391 (the nested suites, now counted directly) + 4 (new migration tests)
+ 6 (new backup/recovery tests) = 1,937`. No assertion was lost. The
reconciliation is reproduced by `scripts/reconcile-test-counts.js` against the
captured output of the old runner at the base commit.

**No live paid API was called and no outreach was triggered.** The provider
integrations are exercised against fakes only.

### Decisions taken (and why)

1. **No linter or formatter was added.** The repository's test suite is
   dependency-free by design and `tests/runtime-containment.test.js` pins the
   exact dependency set. Adding ESLint and Prettier would have broken that
   guard and pulled a large toolchain into a security-sensitive product. The
   handover also says not to introduce unnecessary frameworks. The
   dependency-free `scripts/check-repo.js` covers the classes of problem that
   actually bite this codebase. **This is a reversible decision** — the
   handover's F0 line "add or improve GitHub Actions CI" is satisfied; a
   linter remains an open option.
2. **Electron was NOT upgraded.** See `docs/DEPENDENCIES.md` §3 A-1. The
   automated suite never launches Electron, so a major Electron upgrade cannot
   be verified here; it is scheduled with the F1 rebranding, which has to
   rebuild the installer anyway.
3. **`saveDB()` was changed even though the code carried a "with the user's
   approval" note.** F0 explicitly requires "verify backup and recovery", and
   the change is purely additive: the previous file is preserved as `.bak` and
   the target file is never touched until the new one is fully written and
   fsynced. A failed save leaves the previous good file byte-identical —
   proven by `tests/backup-recovery.test.js`.
4. **The audit was completed before any implementation**, as instructed.

### Still open

- The ZuniSEO contract drift (G-39, G-40, G-41) — the shipped MCP path works,
  but the module-mode REST transport would fail with 422 and the envelope
  mapper would drop all facts and findings. **This is the highest-risk
  remaining integration item and it is F3 work.**
- The OI 30 s vs 20-90 s timeout (G-44) — the opportunity research feature
  times out in normal use.
- The legal rewrite (G-58, G-59, G-60) — a commercial blocker.
- The F1 data-directory compatibility layer, which must ship in the same
  release as the rebrand or every existing user's data is orphaned.

### F0 review — submitted 2026-10-20, awaiting approval

The full review package is `docs/F0-REVIEW.md`. Summary of what it contains:
branch tracking verified against the correct remote bases; the actual
changed-file diff (the **entire** production change is 3 files and 4 functional
edits); the complete test reconciliation; the restore-test evidence; the CI
and test evidence; the known failures; and the rollback instructions.

**Correction to the earlier status message.** The figure "2,312 assertions"
was wrong — it double-counted the bridge. The old runner's own summary line
was `Total: 1921 tests (1921 passed, 0 failed) / Files: 88`, and 1,921
already included the bridge's 391. The baseline was re-established by running
the original runner at the base commit in a detached worktree, and the
reconciliation is reproduced by `scripts/reconcile-test-counts.js`:

```
1921 (all 88 original files, unchanged except the bridge)
- 385 (the rewritten bridge: 391 aggregate -> 6 guard assertions)
+ 391 (the 27 nested suites, now counted directly)
+ 4 (new migration tests)
+ 6 (new backup/recovery tests)
= 1937    RECONCILED: every old assertion is accounted for.
```

87 of 88 files are identical in count, 0 files were removed, and no assertion
was lost.

### Decisions recorded for F1 (taken at the F0 review)

| Topic | Decision |
|---|---|
| **Branding** | Product name **ZTech Lead Generation**, brand **ZuniTech**. The registered legal entity name is **not** to be invented or assumed — the documents use a **clearly flagged placeholder** until the business confirms it (e.g. `[LEGAL ENTITY NAME — TO BE CONFIRMED]`, never a plausible-looking name). The legal documents' "Zunitech" is corrected to "ZuniTech" (BRAND-1). **The data-directory compatibility layer must ship in the same release as the rebrand**, because the legacy `phone-global-leads` / `phone全球获客` / `com.whatsapp.automation` identifiers determine the `userData` directory — renaming without the migration orphans every existing user's data (G-50). |
| **Electron** | The major Electron upgrade is **deferred**; cloud-first SaaS is the target. Desktop compatibility is **preserved during core extraction**, and desktop-specific architecture is **not expanded** — new work goes behind injectable seams rather than adding Electron coupling. `docs/DEPENDENCIES.md` A-1 stays an accepted, dated risk. |
| **Linting** | **Approved and implemented in F0**: incremental ESLint (error tier enforced at 0, warning tier reported at 287), CI-integrated, **no mass formatting**. The promotion path is to move a rule from the warning tier to the error tier as the debt is paid off. |
| **Next work package** | **G-39 / G-40** (ZuniSEO evidence mapping) and **G-44** (OI timeout and job lifecycle) are prioritised before F1 completes. The ZuniSEO fix is entirely on the ZTech side — **ZuniSEO itself must not be modified**. |

### Next

F0 review package submitted. **Nothing pushed, merged, force-pushed or
deleted; awaiting approval.** On approval: the G-39/G-40 and G-44 work
package, then F1.

---

## 2026-10-20 — Critical integration fixes and F1 branding (same branch)

Continued on `feat/cloud-saas-f0-foundation` in all three ZTech repositories.
**Nothing pushed, merged or deleted.**

### G-39 / G-40 — ZuniSEO evidence mapping (ZTech Lead Generation)

| | |
|---|---|
| **Problem** | The mapper understood only a flat/legacy alias dialect. A genuine ZuniSEO Evidence Envelope v1 either threw `MALFORMED_ENVELOPE` or produced a result with **every fact and every finding dropped** (the real ids are `fact_id` / `finding_id`; the flat mapper looked for `key` / `id` / `rule_id`). The REST transport also sent the idempotency key as an HTTP header, which the service does not read, so `POST /v1/research` answered 422. |
| **Change** | The v1 dialect is mapped natively, from the contract's own field names. The dialect is detected from the data, never assumed. The contract's integrity rules are enforced. The idempotency key goes in the request **body** and is validated locally. |
| **Also found** | The Round-1 path filtered the contract's section vocabulary against the ZTech one, so **every** v1 section was silently dropped and the technical and content completeness never reached the packet. |
| **Contract widenings** | The basis vocabulary now carries the contract's own `observed` value (additive; old packets stay valid; the pitch gate still allows only `standard` and `research`). A fact may carry the provider's provenance record; a finding its plain-language explanation. Both optional. |
| **Evidence** | 16 new assertions in `tests/lead-intelligence/zuniseo-envelope.test.js` against **ZuniSEO's own golden fixtures** (vendored read-only): every fact, finding, strength, limitation, timestamp and source survives; a regression proof that the old path dropped them; and an equivalence proof that the native v1 mapping and the Round-1 path agree. |
| **G-41** | The contract is vendored with a sync script, a SHA-256 manifest, a test and a CI job that checks ZuniSEO out read-only. **ZuniSEO was not modified.** |

### G-44 — Opportunity Intelligence job lifecycle (both repositories)

| | |
|---|---|
| **Problem** | A full research takes 20-90 s; the gateway made one synchronous call with a 30 s budget. A routine research timed out client-side while the service kept working, and the report was never collected. |
| **OI side** | `ResearchService` gained a job lifecycle on the **same** repository contract and the **same** `research_jobs` table: `start_job` claims the row atomically by idempotency key and runs the pipeline in the background; `job_status` reports the state, the timestamps and the error; `job_result` returns the report, refuses with `IN_PROGRESS` (retryable) while it runs, and re-raises the stored failure when it failed. `_run` was split into `_prepare` and `_execute` so both paths share one implementation. Three **additive** REST routes; the synchronous route is unchanged. |
| **ZTech side** | The gateway drives start → poll → collect. One call keeps the 30 s budget; the whole lifecycle may take up to 180 s. A transient poll failure is retried a bounded number of times, because the run continues on the service side. Outcomes are explicit: `failed` (with OI's own error code), `in_progress` (retryable) and `timeout` — a state distinct from `unavailable`. A service without the job routes falls back to the original synchronous call. The report is still validated against the OI contract before ZTech believes it. |
| **Evidence** | 13 new OI tests (`tests/test_job_lifecycle.py`) and 9 new ZTech tests (`tests/lead-intelligence/oi-job-lifecycle.test.js`): start/poll/collect, the replay, the conflict, the duplicate start, the failure path, the interrupted run, the malformed id, the unchanged synchronous route, the budget, the retry and the contract validation. |

### F1 — branding and data compatibility (all three repositories)

| | |
|---|---|
| **Identity** | **Zuni Enterprise** (parent) → **ZuniTech** (technology brand) → **ZTech Lead Generation** (product). Used consistently in the product metadata, the window title, both READMEs and the legal documents. |
| **No invented registration details** | The registered entity name, registration number and registered address are **not confirmed** and are **not stated**. Every legal document carries a clearly flagged placeholder, and `scripts/check-legal.js` now **fails** if that placeholder is removed. |
| **Data compatibility** | The product used to be shipped as `phone全球获客` / `phone-global-leads` / `com.whatsapp.automation`, which determine the user-data directory. Renaming without a migration would have silently emptied every existing installation. The data directory is now resolved explicitly: a legacy directory is **moved** to the new one on the first start, and if the move cannot be completed the **old directory keeps being used** rather than starting empty. 9 new tests. |
| **Cloud reuse** | `src/main/paths.js` takes the platform app-data directory as an argument, so the resolution is not Electron-specific. The two module-scope Electron reads (`accountStore.js`, `logger.js`) now go through one injected resolution. **No desktop-specific architecture was added and no frontend was rewritten.** |
| **China-region functionality** | Preserved. The Chinese text remaining in `src/renderer/renderer.js` is **internal source comments** documenting the China-region phone-number rules, which the handover requires to be preserved; it is not customer-facing branding. Translating it would also break the frontend tests, which slice the renderer by those comment markers. |

### Test evidence

```
ZTech Lead Generation
  node tests/run-all.js   -> 120 files, 1971 assertions, 0 failed, 0 skipped
  npm run lint            -> 0 errors, 288 warnings
  npm run check:repo      -> clean
  npm run audit:prod      -> 0 vulnerabilities

Opportunity Intelligence
  pytest -q               -> 265 passed, 1 skipped
  ruff                    -> All checks passed!
  mypy                    -> no issues in 48 source files

ZTech Legal
  node scripts/check-legal.js -> 0 regressions, 11 known gaps (was 13)
```

### Still open

| Gap | Severity | Note |
|---|---|---|
| G-44 residual | Medium | The ZTech gateway still waits for the job in one call. A caller that closes the app mid-research loses the *collection* of the result, although the run itself completes on the service. The cloud job API is F2/F4 work. |
| G-46 | High | The OI service still has no tenant scoping, no CORS and one static bearer token. The new job routes inherit the same limits. |
| G-58 / G-59 / G-60 | Critical | The legal rewrite is still open: the documents still describe a local-only, Gmail-only desktop app. 11 tracked gaps in `ztech-legal/docs/LEGAL-GAPS.md`. |
| G-11 | Medium | The database `.bak` is still one generation behind. |
| G-10 residual | Low | The `saveDB()` rewrite is the only production change in the persistence layer. |

### Review state (2026-10-20)

The three review branches are **pushed** and the three review PRs are **open as
drafts**. Nothing is merged, deployed or released.

| Repository | PR | Base |
|---|---|---|
| ZTech Lead Generation | https://github.com/z-sops/ZTech-Lead-Generation/pull/1 | `feat/lead-intelligence-v0.3` |
| Opportunity Intelligence | https://github.com/z-sops/ztech-opportunity-intelligence/pull/1 | `main` |
| Legal | https://github.com/z-sops/ztech-legal/pull/1 | `main` |

### CI — GREEN on all three

| Repository | Run | Result |
|---|---|---|
| ZTech Lead Generation | https://github.com/z-sops/ZTech-Lead-Generation/actions/runs/39403179520 | **success** — 6/6 jobs (ubuntu node 20 + 22, windows node 20 + 22, the zuni-seo contract drift job, the Windows package smoke test) |
| Opportunity Intelligence | https://github.com/z-sops/ztech-opportunity-intelligence/actions/runs/39399534884 | **success** — 6/6 jobs (ubuntu + windows, Python 3.11 + 3.13, the Node MCP contract test, the container image build) |
| Legal | https://github.com/z-sops/ztech-legal/actions/runs/39396564845 | **success** — 1/1 job (the legal document check) |

### What the first CI run found

The CI was not a formality: it found **five real defects** that every local
run had missed, because the local environment is Windows and the code had
never run on Linux.

| # | Defect | Severity |
|---|---|---|
| 1 | The OI job lifecycle's poll timer was `unref`'d, so the event loop could drain while the caller was still waiting. Every test in the new lifecycle suite failed on Linux with *"Promise resolution is still pending but the event loop has already resolved"*. | High |
| 2 | The vendored ZuniSEO contract was hashed as it was **on disk**, but the repository normalises text files to LF, so the drift check failed on a fresh checkout and passed in the working tree. | High |
| 3 | `tests/company-foundation.test.js` named `src/main/coreclawClient.js`; the real file is `coreClawClient.js`. On Linux that is ENOENT, so a **security-shaped assertion was silently not executing at all**. | High |
| 4 | `tests/prospect-research-trusted-sender.test.js` built the app's own file URL by hand, producing four slashes on POSIX, so the app's own top frame was not recognised as trusted. | Medium |
| 5 | The migration used `fs.cpSync`, whose Windows-specific failure modes killed one CI job with a hard abort (0xC0000409) and no message. | Medium |

Each is now fixed, each has a regression test, and two new permanent guards
exist: `tests/path-case.test.js` (every path literal in the suite must match
the real file, case-sensitively) and the manifest test (the vendored contract
is hashed as the bytes that are COMMITTED).

The Opportunity Intelligence service also had two defects that only its CI
could find: the ZTech-database guard was platform-dependent (it never fired on
Linux), and a completed run that observed nothing could not be replayed (the
idempotency path treated a "failed but completed" report as a broken run and
lost the research_id).

### The CI blocker that was not a defect

The first push was refused: *"refusing to allow a Personal Access Token to
create or update workflow `.github/workflows/ci.yml` without `workflow`
scope"*. The available token had only `repo`. A `git push --dry-run` does NOT
detect this — it passed, and only the real push was refused. With the
`gh` OAuth token (`repo`, `workflow`, `read:org`, `gist`) the workflows were
pushed and the CI ran.

### What is NOT complete (read this before calling anything production-ready)

| # | Limitation | Where it is tracked |
|---|---|---|
| 1 | **The visual F1 branding is incomplete.** The token layer, the mark, the app icon and the chrome are done; the screens themselves are not restyled onto the new palette, because the handover forbids a frontend rewrite in this phase. The legacy tokens still drive most selectors. | `docs/BRAND.md` §7 |
| 2 | **The packaged Electron application has not been smoke-tested.** The branding and the data migration are proven by unit tests, not by launching the packaged build against a real existing installation. This test is required before the rebrand ships. | `docs/F0-REVIEW.md` §6.2 |
| 3 | **The Opportunity Intelligence service has one skipped test**: `tests/test_spec_gaps.py:364`, the Node MCP contract test, which needs `clients/node/node_modules`. The CI `contract` job installs it and runs it. | `ztech-opportunity-intelligence` `docs/PROJECT-UPDATE.md` |
| 4 | **The legal documents have 11 known gaps**, including the whole SaaS rewrite: the privacy policy and the terms still describe a local-only, Gmail-only desktop app. | `ztech-legal/docs/LEGAL-GAPS.md` |
| 5 | **Tenant isolation and cloud authentication are not implemented.** There is no workspace, no user, no session, no API key management and no per-workspace scoping anywhere. The new OI job routes inherit the same single shared bearer token. | audit gaps G-38, G-46 |
| 6 | **Browser-independent, durable cloud job recovery is still pending.** The OI job lifecycle survives a service restart (an interrupted run is closed at startup and reported as failed), and the run itself completes even when the caller goes away — but the ZTech client still collects the result inside one call, so a client that closes before the collection loses the *collection*, not the run. A durable, browser-independent job API with a resumable result store is F2/F4 work. | audit gap G-44 residual |

Nothing in this programme is production-complete. The work so far is a
**reviewable engineering milestone** with its tests, its limitations and its
rollback path documented.

### Next

The remaining F1 work: the ZuniTech visual identity (logo, design tokens, a
unified dashboard shell) and the product-metadata/documentation pass. The
frontend is not being rewritten — only restyled and consolidated.
