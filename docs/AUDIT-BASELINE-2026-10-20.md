# ZTech Lead Generation — Codebase Audit (F0 Baseline)

**Date:** 2026-10-20
**Auditor:** ZuniTech engineering (automated deep audit + manual verification)
**Scope:** 3 ZTech repositories + 1 external integration dependency (ZuniSEO, read-only)
**Status:** Audit complete. No product code changed as part of this audit.

---

## 0. Source-of-truth verification (done before any analysis)

All work is based on **GitHub clones at the exact origin HEAD**, not on the supplied ZIP.

| Repo | Local working dir | Remote | Branch | HEAD | `git status --short` | Audit source |
|---|---|---|---|---|---|---|
| ZTech Lead Generation | `...\ZTech-Lead-Generation` | `https://github.com/z-sops/ZTech-Lead-Generation` | `feat/lead-intelligence-v0.3` | `58ecf11a0bd5044344ceb06b3b39a22076cbbf48` | clean | GitHub clone (0 ahead / 0 behind origin) |
| ZTech Opportunity Intelligence | `...\ztech-opportunity-intelligence` | `https://github.com/z-sops/ztech-opportunity-intelligence` | `main` | `03e8de861e50c9440a23927aab06cfaecee6ffb5` | clean | GitHub clone (0 ahead / 0 behind origin) |
| ZTech Legal | `...\ztech-legal` | `https://github.com/z-sops/ztech-legal` | `main` | `4d738d6ac6ded415801e0973047ec7a283f10767` | clean | GitHub clone (0 ahead / 0 behind origin) |
| ZuniSEO *(external, inspect-only)* | `...\zuni-seo` | `https://github.com/z-sops/zuni-seo` | `feature/geo-growth-intelligence` | `dbfc2d5e65ee42e14171223db31b1031d116edeb` | clean | GitHub clone — **read-only, never modified** |

**The supplied ZIP is an outdated snapshot and was discarded.**
`ZTech-Lead-Generation-main (1).zip` extracts to 18 files, contains **no `tests/`** and **no
`src/main/lead-intelligence/`**. It corresponds to `origin/main` @ `fc264e8` (2026-09-24), which is
**116 commits behind** `feat/lead-intelligence-v0.3` @ `58ecf11` (2026-10-15).
The entire Lead Intelligence layer (ICP, research, outreach, mailbox, sequences, trust, opportunity)
exists **only** on `feat/lead-intelligence-v0.3`. Working from the ZIP would have discarded the
entire product.

### Reproducible baseline (verified 2026-10-20)

```
ZTech-Lead-Generation         node v24.15.0   npm ci          -> 467 packages, lockfileVersion 3
  node tests/run-all.js       -> Total: 1921 tests (1921 passed, 0 failed), Files: 88
  node tests/lead-intelligence.test.js
                             -> 391 passed, 0 failed   (nested tests/lead-intelligence/*)
  COMBINED BASELINE          -> 2312 passing assertions, 0 failing

ztech-opportunity-intelligence  Python 3.13.14  .venv  pip install -e ".[rest,dev]"
  pytest -q                  -> 247 passed, 1 skipped in 10.22s
```

No live paid API was called and no outreach was triggered during the audit. The only
network-touching code paths (CoreClaw, ZuniSEO, OI, Resend, Meta WhatsApp) were inspected
statically; every provider test in the suite runs against fakes.

---

## 1. Architecture as it exists today

### 1.1 Startup flow (ZTech Lead Generation)

`main.js` (2,492 lines) is the single composition root.

| Step | Location | Behaviour |
|---|---|---|
| Module load | `main.js:3-30` | 20 top-level `require`s. Two perform I/O **at import time**: `accountStore.js:6` (`app.getPath('userData')`) and `logger.js:6,10-12` (`mkdirSync(LOG_DIR)`). |
| Single-instance lock | `main.js:58-61` | `app.requestSingleInstanceLock()`; on failure `app.quit()` — but execution continues; the real guard is `if (!gotTheLock) return;` at `main.js:2387`. |
| Crash handlers | `main.js:73-83` | `uncaughtException` and `unhandledRejection` are **logged and swallowed**; the process keeps running with a possibly-corrupt in-memory state. |
| `whenReady` | `main.js:2386-2421` | `initServices()` → `initResearch()` → `createMainWindow()` → `registerIpcHandlers()` → `initLeadIntelligence()` → `registerLeadIntelIpcHandlers()` → `registerOiConfigIpcHandlers()` → `startOiSupervisor()` → `registerOutreachSettingsIpcHandlers()` → proxy config → `startResearch()`. |
| Window | `main.js:837-896` | 1400×900, `contextIsolation:true`, `nodeIntegration:false`, **no `sandbox`**, CSP via `<meta>` in `index.html:6`, `will-navigate` blocked in production (`main.js:866-874`). |
| Persistence | `accountStore.js:1395` | sql.js (WASM SQLite) at `<userData>/data/whatsapp.db`, whole-file export rewritten on every save (`accountStore.js:1765-1777`). |

### 1.2 Layer map (as-implemented, not as-intended)

| Intended layer | Reality |
|---|---|
| Domain | `src/main/lead-intelligence/core/**`, `contracts/**`, `icp/**`, `outreach/OutreachGate.js` — genuinely pure, no Electron. |
| Application | `src/main/lead-intelligence/{research,sequences,replies,enrichment,search,timeline,opportunity,mailbox}/**` — mostly pure; `OutreachService.js:431,457` and `outreachSettings.js:61` and `oiProviderConfig.js:124` are the only Electron bleed (all behind injectable seams). |
| Provider | `src/main/providers/**`, `coreClawClient.js`, `prospect-research/**` (vendored bundle), `lead-intelligence/providers/**`, `outreach/email/**`, `outreach/whatsapp/**`, `trust/RelayClient.js`. |
| Persistence | `accountStore.js` (sql.js, no version table) + `lead-intelligence/persistence/**` (13 versioned migrations, rollback-on-failure). |
| Presentation | `index.html` (155 KB) + `src/renderer/renderer.js` (542 KB / 10,944 lines) + `src/renderer/lead-intelligence/**`. |

**Cloud-extraction readiness (measured):** `src/main/lead-intelligence/**` is ~95 % portable as-is.
Exactly **two** module-scope Electron reads block extraction (`accountStore.js:6`, `logger.js:6`)
plus a `credentialVault` implementation to supply. This is a favourable finding — the handover's
"Do not rewrite the existing business logic" instruction is achievable.

---

## 2. Capability matrix — implemented vs. incomplete

| # | Capability | State | Evidence |
|---|---|---|---|
| 1 | Google Maps business collection | **Implemented** (CoreClaw) | `coreClawClient.js:98-159`, `coreclawAdapter.js:37-72` |
| 2 | Multi-source discovery (Brave/Bing/OSM/etc.) | **Absent** — registry supports N, N=1 | `main.js:943`; `providerManager.js:9-73` |
| 3 | Lead library + dedup / identity rules | **Implemented** | `accountStore.js:666-737` (`DUPLICATE_REVIEW_RULES`) |
| 4 | Structured Company / Branch / Person entities | **Absent** — flat phone-centric rows | `accountStore.js:1441-1461` |
| 5 | ICP fit | **Implemented** | `icp/icpFit.js`, `IcpService.js` |
| 6 | Website research (ZuniSEO) | **Implemented via vendored bundle**; module-mode path is dead code | `prospect-research.cjs` (live, via `lead-intelligence-runtime.js:187` forcing `mode:'round1'`) vs `lead-intelligence/providers/**` (unreachable) |
| 7 | Evidence packets + contract validation | **Implemented** | `contracts/evidencePacket.js`, `migrations/001-008` |
| 8 | Opportunity Intelligence integration | **Implemented but timeouts at 30 s vs 20-90 s server** | `OpportunityIntelligenceGateway.js:56` vs OI `LIMITATIONS.md:35` |
| 9 | Pitch / outreach drafts | **Implemented** | `outreach/PitchGenerator.js`, `agent/LeadAgent.js` |
| 10 | Outreach gate (11 checks) | **Implemented** | `outreach/OutreachGate.js:28-84` |
| 11 | Email (Gmail + Resend) | **Implemented** | `mailbox/gmail/*`, `outreach/email/ResendEmailProvider.js` |
| 12 | WhatsApp (Meta Cloud API) | **Implemented, no template approval flow** | `outreach/whatsapp/MetaCloudWhatsAppProvider.js:28-35,100` |
| 13 | Trust / consent / suppression | **Implemented** | `trust/TrustService.js`, `migrations/008_trust_foundation.sql` |
| 14 | Sequences + reply routing | **Implemented** | `sequences/**`, `replies/ReplyRouterService.js` |
| 15 | Background jobs surviving browser close | **Partial** — in-process `setInterval` only, all `unref()`ed | `index.js:176,183`, `lead-intelligence-runtime.js:263`, `SequenceScheduler.js:76`, `RelayClient.js:157` |
| 16 | Multi-tenant workspace isolation | **Absent** (no tenant concept anywhere) | `rg -i tenant` over the repo: 2 incidental hits |
| 17 | Authentication (customer login) | **Absent** — single-user desktop app | — |
| 18 | Subscription / usage credits | **Absent** | — |
| 19 | Cloud deployment | **Absent** — Electron only | `package.json:28-55` |
| 20 | Legal/compliance for SaaS | **Materially incomplete** | `ztech-legal/privacy.html`, `terms.html` |

### 2.1 Stub / fake code that must not be mistaken for a working feature

| File | Type | Reachability |
|---|---|---|
| `enrichment/FakeEnrichmentProvider.js` | scripted fake | reachable only when `research.enableFakeProvider === true`; **nothing in `main.js` ever sets it** |
| `outreach/email/FakeEmailProvider.js` | fake transport | test/dev only |
| `providers/FakeResearchProvider.js` | fake research | registered only by `zuniSeoFactory.js:70-72` in module mode — **unreachable** |
| `research-service.js:31-32` | *"Production base URL is still a placeholder in HANDOFF 4.4"* → default `http://127.0.0.1:8000` | ZuniSEO research **non-functional out of the box** until the user configures a URL |

---

## 3. Gap register

Risk: **C**ritical (data loss / security / feature broken) · **H**igh · **M**edium · **L**ow.

Each gap states: exact file + function → current behaviour → problem → recommended change →
risk → test & acceptance criteria.

---

### 3.1 F0 — Foundation, tests, release engineering

#### G-01 · Test runner is not recursive — nested suites are one directory deep by accident
- **File/function:** `tests/run-all.js:8-11` `readdirSync(TEST_DIR)` (non-recursive); bridge `tests/lead-intelligence.test.js:26-37` `discoverModuleTests()` (non-recursive).
- **Behaviour:** 88 top-level files run directly. The 27 files in `tests/lead-intelligence/` run only because a hand-written bridge re-executes them via `spawnSync` and scrapes `ℹ pass N` lines with a regex (`tests/lead-intelligence.test.js:46-57`).
- **Problem:** any new subdirectory (`tests/lead-intelligence/mailbox/`) is **silently ignored** and the suite stays green. The runner cannot detect a missing test file.
- **Change:** replace the bespoke scraper with recursive discovery + `node --test` per file; make the count come from the exit code and a machine-readable result, not from log scraping.
- **Risk:** **H**
- **Tests/acceptance:** a new test file in a nested directory increments the reported file count; `npm test` fails if a discovered file throws; `tests/runtime-containment.test.js:177-178` (`files.length >= 13`) is replaced by an exact expected-file-count assertion.

#### G-02 · A failing test's output is discarded
- **File/function:** `tests/run-all.js:36-38` — `summaryLine` is printed; every `FAIL -` line and stack trace is dropped.
- **Problem:** a red suite reports only counts; diagnosis requires re-running 88 files by hand.
- **Change:** print the full captured output of any file that fails; keep the summary for passing files.
- **Risk:** **M**
- **Acceptance:** a deliberately failing fixture prints its assertion message in `npm test` output and the runner still exits 1.

#### G-03 · False green: a summary line overrides a non-zero exit code
- **File/function:** `tests/run-all.js:40-46` — `if (match) {...} else if (code !== 0) { totalFailed += 1; }`.
- **Behaviour:** a file that prints `N passed, 0 failed` and *then* exits non-zero (unhandled rejection after the summary — the pattern in `tests/f23-email-transport.test.js:672`, `tests/f24-business-profile.test.js:345`, `tests/f24-whatsapp-provider.test.js:1031`) is counted as a **pass**.
- **Change:** treat a non-zero exit code as a failure regardless of the summary line.
- **Risk:** **H**
- **Acceptance:** a fixture that prints a green summary then throws is reported as failed.

#### G-04 · No per-file timeout — one hung promise blocks CI forever
- **File/function:** `tests/run-all.js:29` `fork(...)` with no kill timer; `tests/lead-intelligence.test.js:69` `spawnSync` with no `timeout` option.
- **Change:** per-file timeout (e.g. 120 s) with SIGTERM→SIGKILL escalation; the runner reports the offending file.
- **Risk:** **M**
- **Acceptance:** a fixture that never resolves is killed and reported as a failure within the timeout.

#### G-05 · SQL persistence tests are silently skipped
- **File/function:** `tests/lead-intelligence/persistence.test.js:14-20` — 17 of 26 tests use `{ skip: initSqlJs ? false : 'sql.js is not installed…' }`.
- **Problem:** the entire `SqlJsStore` / migration / atomic-write layer can be untested and the suite still reports green. (`node:test` reports skips and exits 0; the bridge only reads pass/fail.)
- **Change:** make `sql.js` a hard requirement of the test run — fail the suite if it is not installed, and report skipped counts separately from passed counts.
- **Risk:** **H**
- **Acceptance:** `npm ci && npm test` reports `0 skipped`; removing `sql.js` makes the run fail with an actionable message.

#### G-06 · No CI anywhere
- **File/function:** repo-wide — no `.github/`, no `.gitlab-ci.yml`, no `Jenkinsfile`, no `azure-pipelines.yml`; `origin/main` contains **no `tests/` at all**.
- **Problem:** the 2.7 MB test suite is entirely manual. The 115 test files and ~20 "no new dependency" drift guards depend on a developer remembering to run `npm test`.
- **Change:** add `.github/workflows/ci.yml` (Windows + Ubuntu matrix, `npm ci`, `npm test`, `npm audit --audit-level=high`, `npm run build` smoke) and `dependabot.yml`.
- **Risk:** **H**
- **Acceptance:** a CI run on a pushed branch executes the same 2,312 assertions and fails on any regression.

#### G-07 · No lint, format, or type gates
- **File/function:** repo-wide — no `.eslintrc*`, `eslint.config.*`, `.prettierrc*`, `tsconfig.json`, `jsconfig.json`, `.editorconfig`.
- **Change:** add ESLint (flat config) + Prettier with the repo's existing style (2-space, single quotes, semicolons, `'use strict'`), and a `checkJs` JSDoc-based type pass over `src/main/lead-intelligence/**`.
- **Risk:** **M**
- **Acceptance:** `npm run lint` and `npm run typecheck` exist and pass on the baseline commit.

#### G-08 · Outdated / EOL dependencies with no audit gate
- **File/function:** `package.json:13-27` — `electron 33.4.11` (EOL Chromium 130), `electron-builder 25.1.8` (2024-era), `vite ^5.4.0` → 5.4.21 (out of support window), `ajv 8.20.0`, `sql.js 1.14.1`.
- **Problem:** an EOL Electron is a standing CVE surface on the shipping target; the app is CSP-only via `<meta>` (`index.html:6`) with no `webRequest` hardening. `npm audit` is not run anywhere.
- **Change:** upgrade Electron to a supported line, electron-builder to 26.x, Vite to 6/7 as compatible; add `npm audit --audit-level=high` to CI; record accepted exceptions in `docs/DEPENDENCIES.md`.
- **Risk:** **H** (Electron) / **M** (others)
- **Acceptance:** `npm ci && npm audit --audit-level=high` exits 0 or has a documented, dated exception; the app still starts and the full test suite passes after the upgrade.

#### G-09 · The whole database is rewritten on every transaction
- **File/function:** `accountStore.js:1765-1777` `saveDB()` (`db.export()` → write `.tmp` → `rename`); `persistence/SqlJsStore.js:120-132` `tx()` awaits `persist()` after **every** COMMIT; `lead-intelligence-runtime.js:176` binds `persist` to `accountStore.saveDB()`.
- **Problem:** cost is O(database size) per write, synchronous on the Electron main thread. A single enrichment observation rewrites the entire file.
- **Change:** batch/debounce persistence, or move to a real SQLite driver with WAL for the cloud target. Interim: coalesce writes within a tick and flush on quit.
- **Risk:** **M**
- **Acceptance:** a benchmark writing 1,000 observations completes within an agreed budget; no data is lost on quit (flush on `before-quit`).

#### G-10 · The primary database has no backup and no restore
- **File/function:** `accountStore.js:1765-1777` — no `.bak`, no `fsync`. `persistence/atomicFile.js:20-34` `writeFileAtomic()` **does** keep a `.bak` and `fsync`s — but it has **zero call sites in `src/main`**. `atomicFile.js:9-13` explicitly defers the switch: *"only switch it to writeFileAtomic with the user's approval."*
- **Problem:** `whatsapp.db` holds every lead, suppression, consent record, mailbox reference and send log. A crash during the whole-file rewrite, or a corrupt DB, is **unrecoverable** — the app quarantines it and starts empty (`accountStore.js:1577-1587`).
- **Change:** route the DB write through `writeFileAtomic()` (keeps one `.bak` + fsync) and add a startup recovery that offers the `.bak` when the primary fails to open. **This is the one change explicitly gated on approval — approval requested in §6.**
- **Risk:** **C**
- **Acceptance:** (a) a forced crash mid-write leaves a readable `.bak`; (b) corrupting the DB causes the app to recover the previous state rather than present an empty library; (c) an existing test asserts the backup is created.

#### G-11 · Forward-only migrations with no downgrade path
- **File/function:** `persistence/migrations.js:370-384` (13 frozen migrations) applied by `persistence/SqlJsStore.js:88-107` — per-migration `BEGIN`/`ROLLBACK` on failure (good), but **no down-migration**.
- **Problem:** if migration 013 is defective, recovery requires restoring a backup — which does not exist (G-10).
- **Change:** add a `down` SQL per migration and a `migrate --to <version>` path; add a migration test that applies 1→13 and rolls back to 0.
- **Risk:** **H**
- **Acceptance:** `tests/lead-intelligence/persistence.test.js` gains a round-trip test (forward then backward) that passes on the current schema.

#### G-12 · Migration embedding is inconsistent and its guard is stale
- **File/function:** `persistence/migrations.js:13-173` (001-004 embedded as string literals) vs `:311-368` (005-013 `fs.readFileSync` at require time). The header comment at `migrations.js:3-8` references `node scripts/embed-migrations.js` and `test/migrations.test.js` — **neither exists in the repo**.
- **Problem:** 005-013 are read from disk at runtime, contradicting the "no fs reads at runtime" invariant; the drift guard in `tests/lead-intelligence/persistence.test.js:31-36` only byte-compares the embedded copies.
- **Change:** embed all 13 uniformly and generate them from a single source; delete the stale script references or add the script.
- **Risk:** **M**
- **Acceptance:** the existing byte-equality test covers all 13 migrations and no runtime `fs` read of `migrations/` remains.

#### G-13 · No release, versioning, or rollback process
- **File/function:** `package.json:3` `"version": "1.0.0"` — never bumped across 116 commits; no git tags; no `CHANGELOG.md`; no release script; `main.js:2388` logs `app.getVersion()` and `:1003` sends `clientVersion` to the provider.
- **Problem:** the branch name `feat/lead-intelligence-v0.3` is the only version signal, and it is not reflected in the binary.
- **Change:** add `CHANGELOG.md`, a documented release/rollback runbook (`docs/RELEASE.md`), version bump discipline, and git tags.
- **Risk:** **M**
- **Acceptance:** a release checklist exists; the app reports a version that matches a git tag.

#### G-14 · The renderer ships unminified and the Vite build pipeline is dead
- **File/function:** `package.json:7-12` (no `build:renderer` script), `package.json:28-37` (`build.files` excludes `dist-renderer`), `vite.config.js:12` (`build.outDir: 'dist-renderer'`), `main.js:876-881` (production loads `loadFile('index.html')`).
- **Problem:** `vite build` is never invoked and its output is never consumed or packaged. Production ships the raw 542 KB renderer and 155 KB HTML. `dist-renderer/` is also not in `.gitignore`.
- **Change:** either wire `build:renderer` into the packaging path or remove the dead config; add `dist-renderer/` to `.gitignore` either way.
- **Risk:** **M**
- **Acceptance:** `npm run build` produces an artifact whose renderer loads, and the packaged `files` list provably contains every asset `index.html` references.

#### G-15 · Packaging produces a folder, not an installer, and is unsigned
- **File/function:** `package.json:38-44` — `win.target: [{ target: 'dir', arch: ['x64'] }]`, no signing config.
- **Problem:** `npm run build` yields `dist/win-unpacked/`. The README's documented default path also hits the Windows symlink-permission failure that the `--dir --config.win.signAndEditExecutable=false` workaround exists for.
- **Change:** add an `nsis` target + code signing; add the workaround as a documented script.
- **Risk:** **M**
- **Acceptance:** `npm run build:win` produces a signed installer on a clean Windows runner.

#### G-16 · `VITE_PORT` is honoured by Electron but ignored by Vite
- **File/function:** `vite.config.js:8` hardcodes `port: 5173`; `main.js:877` and `vite.config.js:3` honour `process.env.VITE_PORT`; `package.json:8` waits on `tcp:5173` literally.
- **Change:** read `VITE_PORT` in `vite.config.js` and in the dev script.
- **Risk:** **L**
- **Acceptance:** `VITE_PORT=3000 npm run dev` serves on 3000 and Electron loads it.

#### G-17 · Diagnostics: logs are plaintext, unredacted, and exportable to the renderer
- **File/function:** `logger.js:42-53` (payload JSON, truncated to 500 chars), `:55-61` (`appendFileSync`, all exceptions swallowed), `:97-107` `exportLogs()`; `main.js:2349-2351` IPC `logs:export`.
- **Problem:** there is **no redaction filter at the logger level** — today call sites only log booleans, but any future `logger.info(scope, msg, { apiKey })` is written to disk in the clear.
- **Change:** add a key/pattern-based redaction filter in the logger; redact proxy URLs that embed `user:pass@`.
- **Risk:** **M**
- **Acceptance:** a unit test asserts that a log payload containing `apiKey`/`token`/`password` is masked.

#### G-18 · Crash handlers swallow exceptions in the process that owns the database
- **File/function:** `main.js:73-83`.
- **Change:** keep the log, then exit non-zero for `uncaughtException` in the main process; keep the process alive only for `unhandledRejection` in the renderer path.
- **Risk:** **M**
- **Acceptance:** a fault-injection test asserts the app exits rather than continuing in a corrupt state.

#### G-19 · Window is created before the IPC handlers it will call
- **File/function:** `main.js:2392` `createMainWindow()` precedes `:2393` `registerIpcHandlers()`, `:2396` `initLeadIntelligence()`, `:2397` `registerLeadIntelIpcHandlers()`.
- **Problem:** the renderer can fire an IPC call before the handler is registered → `No handler registered for '…'`. Worse, if `initLeadIntelligence()` fails, `registerLeadIntelIpcHandlers()` returns early (`main.js:1470`) and **all** Lead Intelligence channels silently never exist. The OI path already handles this correctly with `registerUnavailableOpportunityIpc` (`main.js:1799`).
- **Change:** register all IPC handlers before creating the window; register the "unavailable" stub for the LI path as the OI path does.
- **Risk:** **M**
- **Acceptance:** an integration test that calls every channel immediately after window creation succeeds.

#### G-20 · Renderer window is not sandboxed
- **File/function:** `main.js:840-851` `webPreferences` — `contextIsolation:true`, `nodeIntegration:false`, `sandbox` unset (defaults to `false`); `preload.js` therefore has full Node access.
- **Change:** set `sandbox: true` and verify the preload needs no Node APIs, or document the exception.
- **Risk:** **M**
- **Acceptance:** the app starts and the full test suite passes with `sandbox: true`.

#### G-21 · Renderer crash is logged but never recovered
- **File/function:** `main.js:888-895` `render-process-gone` — logs only; the window is left dead; `main.js:883-886` nulls `mainWindow` on `closed`.
- **Change:** recreate the window (with a backoff) on `render-process-gone`.
- **Risk:** **L**
- **Acceptance:** a simulated renderer crash yields a usable window.

#### G-22 · No Windows baseline in automation
- **File/function:** repo-wide; `README.md:84-90` documents the electron-builder symlink workaround; `scripts/sync-prospect-research.ps1:19-20` hardcodes `G:\ztech-integration\ztech-prospect-research`.
- **Change:** a Windows CI job; replace the hardcoded `G:\` path with a parameter; make the sync script's version pin a content hash (currently a string compare of `package.json` `version`, `sync-prospect-research.ps1:43-46`).
- **Risk:** **M**
- **Acceptance:** CI runs green on `windows-latest`; the sync script accepts a `-ModuleRoot` parameter.

#### G-23 · Invisible NUL byte in source
- **File/function:** `persistence/contract.js` — literal `\0` inside `sendIdempotencyKey` (offset ~11986).
- **Problem:** the delimiter is correct, but the raw control character makes the file register as **binary** to `rg`, breaking diff/merge tooling and linting.
- **Change:** write it as `\u0000`.
- **Risk:** **L**
- **Acceptance:** `rg` treats the file as text; the idempotency key is byte-identical.

---

### 3.2 F3 — Lead discovery engine

#### G-24 · The paid provider has no resilience whatsoever
- **File/function:** `coreClawClient.js:27-83` `request()` — one attempt, `AbortSignal.timeout(30000)` (`:42`), error mapping (`:53-77`). No retry, no backoff, no circuit breaker, no health check, no `Retry-After` handling, no cost ledger. `BASE_URL` (`:3`) and worker id (`:4`) are hardcoded.
- **Contrast:** the ZuniSEO path in the same app *does* have timeout + retry + breaker + contract validation + quarantine (`prospect-research.cjs:1912-1958`, `:281-299`, `:2219-2226`).
- **Change:** wrap the client in the same resilience policy (bounded retries with jitter, a circuit breaker, a health probe, `Retry-After` parsing) and make the base URL + worker id configurable.
- **Risk:** **H**
- **Acceptance:** unit tests drive a fake transport through 5 consecutive failures → the breaker opens → calls are rejected without a network call; a `429` with `Retry-After: 30` is honoured.

#### G-25 · A timed-out collection submit can be billed twice
- **File/function:** `accountStore.js:1470-1488` — `jobs` has `UNIQUE(providerId, runSlug)`; `main.js:786-804` `recordJobSubmitted` writes the row **only after a successful response**. `runSlug` is generated client-side per submit.
- **Problem:** if the submit times out (the run may have been accepted and billed upstream), the user retries, a **new** `runSlug` is generated, and the job runs again — a duplicate billable collection.
- **Change:** derive the idempotency key from the *intent* (provider + normalised query + target + window) rather than from a random slug, and persist the intent **before** the request; reconcile with the provider's run history before resubmitting.
- **Risk:** **H**
- **Acceptance:** a test submits the identical intent twice and asserts only one upstream run is created and only one job row exists.

#### G-26 · No cost estimate, spend limit, or budget per job
- **File/function:** `coreclawAdapter.js:37-55` validates `maxResults` (1-500) and `maxReviewsPerPlace` (≤50), but the expensive flags `emailVerification` and `fetchReviews` are **not cost-gated** and are accepted from the renderer; `main.js:174-192` validates only `keywords` at the IPC boundary.
- **Problem:** no estimate is shown before a billable run, and no ceiling exists.
- **Change:** a cost estimator per provider capability, a per-workspace daily/monthly credit ceiling, and hard caps on the enrichment flags.
- **Risk:** **H**
- **Acceptance:** a run whose estimated cost exceeds the remaining budget is rejected **before** the upstream call, with an observable error.

#### G-27 · Multi-source discovery does not exist (registry supports N, N = 1)
- **File/function:** `main.js:5` imports only `CoreClawAdapter`; `main.js:943` registers exactly one provider. `providers/providerManager.js:45-61` `resolveCollectionProvider()` and `collectionProvider.js:3-20` (`REQUIRED_COLLECTION_METHODS`, `APPROVED_METADATA_FIELDS`) are built for N but never exercised with N > 1.
- **Change:** implement the provider-independent discovery layer and at least one non-CoreClaw source (Brave/Bing/OSM) behind the existing `collectionProvider` contract. **Do not claim an integration works until it is implemented and tested.**
- **Risk:** **H**
- **Acceptance:** a second provider is registered, passes the same contract assertions, and a test asserts the manager selects correctly and falls back on failure.

#### G-28 · Provider health is unchecked, and "Test connection" spends provider requests
- **File/function:** `coreclawAdapter.js:79-95` `testConnection()` performs **two live API calls**; invoked from `main.js:1907-1942` `provider:test-connection` with `useStored:true`. There is no cooldown between presses and no health-check background task.
- **Change:** cache the health result with a TTL, add a cooldown on manual test, and expose provider health in the UI.
- **Risk:** **M**
- **Acceptance:** pressing "Test" twice within the cooldown performs zero additional upstream calls.

#### G-29 · Collection results are not normalised into standard records
- **File/function:** `accountStore.js:1441-1461` `CREATE TABLE numbers` — one flat row per *phone number*: `id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug, qualification, tags, notes, phoneStatus, emailStatus, websiteStatus, businessStatus, companyId`.
- **Problem:** the storage unit is the phone, not the business. Two branches of one company are two rows; one company with two phone numbers is two rows; a company with no phone cannot be represented.
- **Change:** introduce canonical Company / Location / ContactPoint records (see §4) and keep `numbers` as a compatibility view during migration.
- **Risk:** **H**
- **Acceptance:** a company with two branches and two phone numbers is stored as one company with two locations and two contact points, and the existing lead library still lists it.

#### G-30 · No recovery from an interrupted collection job
- **File/function:** `jobs` table (`accountStore.js:1470-1488`) records `status`, but there is no requeue/resume path; `rg "recover|resume|requeue|interrupted"` over `src/main` returns only the OI/sequence/reply paths, not collection.
- **Change:** on startup, mark orphaned `RUNNING` collection jobs as interrupted and offer a resumable re-pull using the stored `runSlug`.
- **Risk:** **H**
- **Acceptance:** a job left `RUNNING` at shutdown is recovered on the next start and its results are pulled exactly once.

#### G-31 · Provenance, freshness, and verification status are partial
- **File/function:** `numbers` has `source`, `collectedAt`, and the four `*Status` columns; `li_enrichment_observations` and `li_contact_provenance` (`migrations/002`, `008`) hold provider-level observations for enrichment and contact provenance.
- **Problem:** there is no general **source observation ledger** — per company, per field, per provider, per timestamp, per verification state. Freshness cannot be answered globally.
- **Change:** add a `source_observations` ledger written by every collector, and define `verified | unverified | invalid | unknown` semantics per field.
- **Risk:** **H**
- **Acceptance:** every stored field can be traced to a provider observation with a timestamp and a verification state; "never fabricate contact information" is enforceable by making the field nullable and provenance-bound.

---

### 3.3 F4 — Business data and identity foundation

Current schema (verified from the 13 SQL files):

| Migration | Tables |
|---|---|
| `001_lead_intelligence.sql` | `li_schema_migrations, li_research_jobs, li_evidence_packets, li_research_changes, li_saved_searches, li_segments, li_segment_members, li_pitch_drafts, li_outreach_approvals` |
| `002_enrichment.sql` | `li_enrichment_jobs, li_enrichment_observations` |
| `003_outreach_activity.sql` | `li_outreach_activity` |
| `004_email_send.sql` | `li_outreach_activity_f19, li_outreach_sends` |
| `005_whatsapp_send.sql` | `li_outreach_sends_f20` |
| `006_oi_associations.sql` | `li_oi_associations` |
| `007_oi_refresh_requests.sql` | `li_oi_refresh_requests` |
| `008_trust_foundation.sql` | `li_suppressions, li_contact_consents, li_contact_provenance, li_trust_events, li_recipient_refs` |
| `009_outreach_handoff_activity.sql` | `li_outreach_activity_f265` |
| `010_mailbox_transport.sql` | `li_mailboxes, li_mailbox_sent, li_market_rules, li_trust_events_f266, li_suppressions_f266` |
| `011_reply_reviews.sql` | `li_reply_reviews` |
| `012_sequences.sql` | `li_sequences, li_sequence_steps, li_sequence_events, li_sequence_gaps, li_sequence_control` |
| `013_reply_routes.sql` | `li_reply_routes` |

Plus the non-versioned `numbers`, `jobs`, `targets`, `saved_searches`, `segments` in `accountStore.js:1441-1535`.

| F4 required entity | State | Evidence | Gap |
|---|---|---|---|
| Company | **Absent** (implicit `numbers.companyId` + `title`/`website` on a phone row) | `accountStore.js:1441-1461` | **G-32** |
| Business location / branch | **Absent** (flat `address` string) | `accountStore.js:1450` | **G-33** |
| Person / decision-maker | **Absent** (no entity anywhere) | `rg -i "person\|decision_maker\|contact_person"` → none | **G-34** — product goal 7 is unimplemented |
| Email & phone contact points | **Flat columns**, not normalised; one email + one phone per row, no per-contact verification | `accountStore.js:1445,1448` | **G-35** |
| Data source observation | **Partial** — `li_enrichment_observations` + `li_contact_provenance` only | `migrations/002, 008` | **G-31** |
| Research evidence | **Present** | `li_evidence_packets`, `li_research_changes`, `contracts/evidencePacket.js` | — |
| Opportunity | **Partial** — `li_oi_associations` links to an OI-owned opportunity; no local entity | `migrations/006` | **G-36** |
| Campaign & interaction history | **Partial** — rich interaction history (`li_outreach_activity`, `li_outreach_sends`, `li_sequences*`, `li_reply_reviews`, `li_reply_routes`) but **no campaign entity** | `migrations/003-013` | **G-37** |
| Consent & suppression | **Present** | `li_contact_consents`, `li_suppressions`, `li_trust_events` | — |
| Tenant / workspace | **Absent** | `rg -i tenant` → 2 incidental hits | **G-38** |

#### G-32 · No Company entity
- **Change:** a `companies` table (canonical name, domain, industry, category, status, first_seen, last_seen) keyed independently of any phone number; `numbers` becomes a contact-point child.
- **Risk:** **H**
- **Acceptance:** a migration test proves existing rows are grouped into companies without data loss; the lead library still lists every current lead.

#### G-33 · No Branch / Location entity
- **Change:** a `company_locations` table (company_id, address, country, city, region, postal, lat/lng, is_primary) — one company may have many.
- **Risk:** **H**
- **Acceptance:** one company with two branch addresses is representable and both are shown.

#### G-34 · No Person / decision-maker entity
- **Change:** a `people` table and a `person_roles` table (person_id, company_id, role, is_primary_decision_maker, source, verification).
- **Risk:** **H**
- **Acceptance:** a person may hold multiple roles across companies and several verified contact methods; **no contact point may be invented** — a person without a sourced contact is valid.

#### G-35 · Contact points are not normalised
- **Change:** a `contact_points` table (company_id/person_id, type=email|phone, value_normalized, label, verification_state, source_observation_id, is_primary, do_not_contact).
- **Risk:** **H**
- **Acceptance:** the same value may exist for two different companies; a duplicate phone does **not** merge two businesses (the existing `DUPLICATE_REVIEW_RULES` in `accountStore.js:666-737` already encodes this and must be preserved).

#### G-36 · No local Opportunity entity
- **Change:** a local `opportunities` table referencing the OI report id, with a cached projection so the UI does not require OI to be up.
- **Risk:** **M**
- **Acceptance:** opportunities remain visible when the OI service is unavailable.

#### G-37 · No Campaign entity
- **Change:** a `campaigns` table; link `li_sequences`, `li_outreach_sends`, and `li_outreach_activity` to a campaign.
- **Risk:** **M**
- **Acceptance:** activity can be reported per campaign.

#### G-38 · No tenant / workspace isolation
- **Change:** a `workspaces` + `workspaces_members` model, a `workspace_id` on every tenant-owned table, and a repository-level scoping rule that is impossible to bypass.
- **Risk:** **C**
- **Acceptance:** a test asserts that a repository query from workspace A can never return a workspace B row, for every tenant-owned table.

---

### 3.4 Cross-repository integration contracts

#### G-39 · ZuniSEO REST transport sends the idempotency key in the wrong place — request fails with 422
- **File/function:** `lead-intelligence/providers/transports/RestTransport.js:59,87` sends `{ url }` in the body and an `Idempotency-Key` **header**.
- **Contract:** ZuniSEO requires `idempotency_key` **in the JSON body** (`^[A-Za-z0-9._:-]{8,128}$`) and **does not read the `Idempotency-Key` header** (`zuni-seo/src/zunitech_seo/server/service.py:237-303`; `zuni-seo/src/zunitech_seo/contracts/v1/contract.schema.json:337-406`).
- **Effect:** `POST /v1/research` → **422 INVALID_INPUT**.
- **Important:** the **shipped** path is the MCP round-1 bundle, which passes `idempotency_key` as a tool argument (`zuni-seo/src/zunitech_seo/server/mcp_app.py:123-125`) and is **correct**. Only the module-mode REST transport is broken — and that path is currently unreachable (`lead-intelligence-runtime.js:187` forces `mode:'round1'`).
- **Change:** move `idempotency_key` into the body in `RestTransport.js`; keep the header as well for forward compatibility.
- **Risk:** **H** (becomes **C** as soon as module mode is enabled)
- **Acceptance:** a contract test against the published ZuniSEO schema asserts the request body validates; the header form is no longer relied on.

#### G-40 · The ZuniSEO envelope mapper silently drops every fact and every finding
- **File/function:** `lead-intelligence/providers/envelopeMapper.js:25-37,142-149,177-179,197,211,239,245` — written speculatively (its own header at `:11-21` says *"VERIFY (QwenCoder)"*).
- **Contract (ZuniSEO v1):** `subject.requested_url/audited_url`, `run.status/engine_version/captured_at`, `facts[].fact_id/statement`, `findings[].finding_id/affected_urls`, `limits[]`, `facts[].source` (`zuni-seo/src/zunitech_seo/envelope.py:325-347`; `contract.schema.json:687-993`).
- **Effect:** the mapper looks for `target.*`, top-level `status`/`engine_version`/`captured_at`, `facts[].key|id|name`, `findings[].rule_id|id|code`, `limitations|caveats|warnings`, and a top-level `sources` — **none of which exist**. The result is `MALFORMED_ENVELOPE`, or (worse) a successful parse with **zero facts and zero findings**.
- **Change:** rewrite the mapper against the published contract schema, and add a **contract-fixture test** using ZuniSEO's own golden fixtures (`zuni-seo/src/zunitech_seo/contracts/v1/fixtures/*.json`).
- **Risk:** **C** (silent data loss)
- **Acceptance:** a fixture test maps every golden envelope and asserts the fact count, finding count, sources, and limits survive; a schema-drift test fails if the contract version is unsupported.

#### G-41 · ZTech does not hold a copy of the ZuniSEO contract
- **File/function:** `zuni-seo/docs/ZTECH-HANDOFF.md:24` instructs *"Keep the contract files identical on both sides (`npm run sync-contract`)"* — ZTech has no `contract.schema.json` copy; `src/main/lead-intelligence/contracts/` holds only ZTech-internal contracts.
- **Change:** vendor the contract schema into ZTech with a sync script + a drift test.
- **Risk:** **H**
- **Acceptance:** a test fails when the vendored schema differs from the published one.

#### G-42 · ZuniSEO production base URL is a placeholder — the research feature is off by default
- **File/function:** `prospect-research/research-service.js:31-32` — *"Production base URL is still a placeholder in HANDOFF 4.4"*; default `http://127.0.0.1:8000`.
- **Change:** configure a real endpoint per deployment; ship the placeholder only as a dev default and surface a clear "not configured" state in the UI.
- **Risk:** **H**
- **Acceptance:** with no URL configured the UI says "not configured" instead of offering a research action that cannot work.

#### G-43 · Two divergent ZuniSEO client stacks — one of them is dead code
- **File/function:** `prospect-research/prospect-research.cjs` (live, 2,446-line vendored bundle) vs `lead-intelligence/providers/**` + `transports/**` (5 files, ~440 lines, unreachable).
- **Problem:** divergent timeouts (30 s vs 60 s), divergent error vocabularies (`unauthorized`/`rate_limited` vs `PROVIDER_AUTH`/`PROVIDER_UNAVAILABLE`), divergent breaker implementations. `ajv`, `ajv-formats`, and `@modelcontextprotocol/client` are reachable **only** through the bundle.
- **Change:** pick one stack, delete or clearly quarantine the other, and stop shipping a generated bundle without its source.
- **Risk:** **M**
- **Acceptance:** exactly one ZuniSEO client implementation exists, with a single error vocabulary.

#### G-44 · OI research is synchronous (20-90 s) but ZTech's gateway times out at 30 s
- **File/function:** `OpportunityIntelligenceGateway.js:56` `BOUNDS.timeoutMs: 30_000`; OI `POST /v1/research` runs the whole pipeline inline (`ztech-opportunity-intelligence/src/ztech_oi/adapters/rest.py:106-109`; `LIMITATIONS.md:35` — *"Expect roughly 20-90 s for a prospect plus 3 competitors"*).
- **Effect:** routine research **times out client-side** while the server keeps working. There is no `202 Accepted` + job-id + polling route on the OI side and no polling path in the gateway.
- **Change:** add an async job API to OI (`POST /v1/research` → `{research_id, status:"running"}` + `GET /v1/research/{id}`) and make the gateway poll; **or** raise the gateway budget to ≥120 s. The async route is required for the cloud product regardless.
- **Risk:** **C** (feature is broken in normal use)
- **Acceptance:** a research that takes 90 s completes end-to-end in the UI, and an interrupted client does not lose the run.

#### G-45 · The OI gateway has no retry or circuit breaker
- **File/function:** `OpportunityIntelligenceGateway.js:181-240` `call()` — one attempt, `AbortController`, bounded body, never throws.
- **Change:** bounded retry for retryable codes, plus a breaker, mirroring the ZuniSEO policy.
- **Risk:** **M**
- **Acceptance:** a fake transport that fails N times opens the breaker.

#### G-46 · OI has no tenancy, no CORS, one static bearer token, no rate limiting
- **File/function:** `ztech-opportunity-intelligence/src/ztech_oi/adapters/rest.py:80-92` (single static token, `hmac.compare_digest` ✓; **no auth at all** when `ZTECH_OI_AUTH_TOKEN` is unset), no `CORSMiddleware` anywhere in `src/`, no rate limiter; `persistence/sqlite.py` has **no tenant column** — `GET /v1/reports/{research_id}` returns **any** report to **any** authenticated caller.
- **Change:** per-workspace credentials, tenant scoping in the repository, CORS restricted to the ZTech origin, and a rate limiter.
- **Risk:** **H**
- **Acceptance:** a report belonging to workspace A is not retrievable by workspace B.

#### G-47 · OI has no migration tooling
- **File/function:** `ztech-opportunity-intelligence/src/ztech_oi/persistence/sqlite.py:27,113-118` — `SCHEMA_VERSION = 1`; DDL is `CREATE TABLE IF NOT EXISTS` on every open; a newer on-disk version **raises**, and there is **no upgrade path**.
- **Change:** a real migration runner (Alembic or an ordered SQL list) with forward migrations and a test that migrates a v1 database to head.
- **Risk:** **M**
- **Acceptance:** a v1 fixture DB migrates to head without data loss.

#### G-48 · OI has no CI and no container image
- **File/function:** repo-wide — no `.github/`, no `Dockerfile`, no `docker-compose.yml`, no `requirements.txt` (deps live in `pyproject.toml`).
- **Change:** add a CI workflow (pytest + ruff + mypy) and a Dockerfile.
- **Risk:** **M**
- **Acceptance:** CI runs the 247 tests on every push.

#### G-49 · OI's `research_id` path parameter is unvalidated
- **File/function:** `rest.py:115-124` — the MCP path enforces `^[a-z]+_[A-Za-z0-9_]+$` (`adapters/mcp_server.py:29`) but the REST path does not.
- **Change:** apply the same pattern on the REST routes.
- **Risk:** **L**
- **Acceptance:** a malformed id returns 422, not a DB error.

---

### 3.5 F1 — Branding and identity

#### G-50 · Legacy Chinese product identity is still the shipping identity
- **File/function:** `package.json:2` `"name": "phone-global-leads"`, `:4` `"description": "phone全球获客"`, `:29` `"appId": "com.whatsapp.automation"`, `:30` `"productName": "phone全球获客"`; `main.js:841` window `title: 'phone全球获客'`; `index.html`; `README.md` / `README_EN.md`; `tools/acceptance/reset-email-suppression.js:144` resolves `%APPDATA%\phone-global-leads` **and** `phone全球获客`; `ztech-legal/index.html:3,24` and `privacy.html`/`terms.html` use **"Zunitech"** (lowercase t) while the product README uses **"ZuniTech"**.
- **Problem:** three names for one product, one of them from a *different* product (`com.whatsapp.automation` collides with the WhatsApp Business namespace). The `appId`/`productName` also determine the `userData` path, so **renaming without a compatibility path orphans every existing user's database**.
- **Change:** rebrand to *ZTech Lead Generation* / *ZuniTech*; introduce a **data-directory compatibility layer** that resolves the legacy `phone-global-leads` / `phone全球获客` / `com.whatsapp.automation` paths and migrates them; keep useful international and China-region functionality.
- **Risk:** **H** (data loss if the path changes without migration)
- **Acceptance:** a test installs the app under the legacy `userData` path, starts the app, and asserts the existing lead library, settings, and credentials are all present and readable.

#### G-51 · No ZuniTech visual identity
- **File/function:** `src/renderer/styles.css` (4,800+ lines), `index.html` — no logo asset, no brand token layer, no typographic scale.
- **Change:** introduce a design-token layer (colour, type, spacing, radius), a ZuniTech logo, and a unified dashboard shell; remove the ad-hoc per-view styling.
- **Risk:** **M**
- **Acceptance:** all colours and spacing resolve to tokens; the shell is shared by every view.

#### G-52 · Product metadata and documentation still describe a phone-number list tool
- **File/function:** `README.md:6,10-16` (collects landlines/mobiles), `README_EN.md`.
- **Problem:** the documentation sells a list of phone numbers, while the product is now evidence-backed opportunity intelligence.
- **Change:** rewrite both READMEs around the qualified-opportunity workflow; keep the collection features documented.
- **Risk:** **L**
- **Acceptance:** the README describes the same workflow the UI presents.

---

### 3.6 Security

#### G-53 · The credential vault does not check the OS keyring backend
- **File/function:** `credentialVault.js:12-20,36-42` — uses `electron.safeStorage`; **never inspects `getSelectedStorageBackend()`**.
- **Contrast:** the three other secret paths *do* check and refuse `basic_text` — `prospect-research/credential-source.js:69-71`, `lead-intelligence/opportunity/oiProviderConfig.js:140-142`, `lead-intelligence/outreach/outreachSettings.js:73-74`.
- **Effect:** on Linux without a keyring, `safeStorage` silently falls back to **`basic_text` (plaintext obfuscation)**, so the CoreClaw provider key and proxy URL are stored unencrypted — with **no warning**.
- **Change:** refuse `basic_text` in `credentialVault` exactly as the other paths do, and surface the degradation in the UI.
- **Risk:** **H**
- **Acceptance:** a test with a `basic_text` safeStorage stub asserts that sealing fails closed and the user is told why.

#### G-54 · Legacy plaintext credentials can persist indefinitely
- **File/function:** `credentialVault.js:113-219` `migrateStoredCredentials()` returns `{ status: 'deferred' }` when the vault is unavailable (`:117-119`); `main.js:956-961` logs *"credential encryption migration deferred"* and continues. `legacySettingsMigration.js:27-44` copies the plaintext key into electron-store first.
- **Problem:** the app then runs with an **unencrypted provider key on disk** and no user-facing warning.
- **Change:** warn visibly, refuse provider use until sealed, and re-run the migration on every start (not only on first run).
- **Risk:** **H**
- **Acceptance:** a test asserts the plaintext key is removed from `config.json` after the vault becomes available.

#### G-55 · No key rotation for sealed credentials
- **File/function:** `credentialVault.js:3` `SEALED_PREFIX = 'enc:v1:'`; `:151,165` skip already-sealed values.
- **Change:** support `enc:v2:` and a re-seal routine.
- **Risk:** **M**
- **Acceptance:** a re-seal routine upgrades v1 values and the test proves round-trip integrity.

#### G-56 · The decrypted proxy URL is returned to the renderer
- **File/function:** `main.js:2080-2081` `settings:load` returns `proxyUrl` in the clear; `main.js:114-126` `validateProxyUrl` does **not** reject embedded `user:pass@`.
- **Effect:** proxy credentials reach the renderer process and would be captured by any renderer compromise.
- **Change:** return only a redacted form (host, port, scheme, `has_credentials`); keep the secret in main.
- **Risk:** **M**
- **Acceptance:** `settings:load` never returns the credential portion.

#### G-57 · The OI supervisor executes a Python interpreter from a user-selected folder
- **File/function:** `lead-intelligence/opportunity/OpportunityServiceSupervisor.js:83-110` — `validateOiFolder()` checks the folder *contains* a `pyproject.toml` naming `ztech-opportunity-intelligence` and a `.venv` python, then `resolveLaunchCommand()` **executes that interpreter**.
- **Mitigations already present (good):** `shell:false`, allowlisted env (`ENV_ALLOWLIST` `:55-56` — ZTech's own secrets never reach the child), a native folder picker, and instance-id verification.
- **Problem:** a user who selects a malicious folder gets arbitrary code execution in the ZTech process context.
- **Change:** in the cloud product, the OI service is a **managed remote service** — the supervisor's "managed child" mode is the correct architecture. For the desktop build, verify the interpreter against a pinned hash/allow-list.
- **Risk:** **H**
- **Acceptance:** the managed mode is the only path used by the cloud build.

#### G-58 · The legal repository describes a product that no longer exists
- **File/function:** `ztech-legal/privacy.html:26-49`, `terms.html:26-47`, `index.html:24,31`.
- **Current text:** a **local-only, Gmail-only desktop app** — *"Everything ZTech stores runs and stays on your own computer"* (`index.html:31`), *"no Zunitech server receives Google data"* (`privacy.html:37`).
- **Reality:** ZTech collects from a third-party provider (CoreClaw), sends WhatsApp via the Meta Cloud API, drafts pitches with an LLM (`lead-intelligence/agent/LeadAgent.js`), and calls the ZuniSEO research service — i.e. **ZuniTech operates a server that receives lead identifiers and prospect-site data**. The policy never mentions it.
- **Change:** rewrite the privacy policy and terms for the actual data flows and the SaaS model. See §5 for the full gap list.
- **Risk:** **C** (commercial blocker)
- **Acceptance:** every outbound data flow in the code has a corresponding, accurate disclosure.

#### G-59 · No legal entity, jurisdiction, or governing law
- **File/function:** `ztech-legal/privacy.html:60`, `terms.html:51` — footer reads *"ZTech is built by Zunitech, Karachi, Pakistan. Contact: z.sdevops1@gmail.com"*.
- **Problem:** no registered company name, no registration number, no registered address, no VAT/EORI, **no governing-law clause and no jurisdiction**, no support address, no DPO, no EU/UK representative, a personal Gmail as the sole contact, and no subscription/licence/SLA/refund terms.
- **Change:** a legal-entity page, a governing-law clause, and SaaS commercial terms.
- **Risk:** **H**
- **Acceptance:** every document names the legal entity, the jurisdiction, and a monitored contact address.

#### G-60 · Missing GDPR/US commercial artefacts
- **File/function:** `ztech-legal/` — no Art. 28 DPA, **no subprocessor list** (the real subprocessors are Google/Gmail, Meta WhatsApp Cloud API, CoreClaw, the ZuniSEO service, and the LLM provider — none named), no SCCs/transfer impact assessment (ZuniTech is in Pakistan), no data-residency statement, no DSAR intake or erasure workflow, no cookie/consent policy, no retention schedule, no Art. 30 record of processing, no DPIA for systematic lead scoring, no AI/LLM disclosure, no WhatsApp Business messaging-policy compliance section, and no lawful-basis analysis for B2B outbound (no Art. 6(1)(f) LIA, no Art. 14 notice mechanism, no CAN-SPAM/PECR/UWG/CASL rules, no source attribution or "how to be removed" path for data-sourced contacts).
- **Change:** produce the missing artefacts as a coordinated set; ZuniSEO's own `docs/DEPLOY.md:44-45` already flags *"Publish a privacy policy and a DPA before selling in the EU/UK"*.
- **Risk:** **H**
- **Acceptance:** a documented subprocessor register matches the live integrations; a retention schedule covers leads, drafts, approvals, consent, research envelopes, logs, and quarantined payloads.

---

### 3.7 F2 — Application architecture

#### G-61 · Two module-scope Electron reads block cloud extraction
- **File/function:** `accountStore.js:6` (`app.getPath('userData')` at module scope) and `logger.js:6,10-12` (same + `mkdirSync` at import).
- **Change:** inject the data directory and the log directory; the module-scope constants become constructor parameters.
- **Risk:** **M** (small change, high leverage)
- **Acceptance:** both modules import cleanly under plain Node with no `electron` module present.

#### G-62 · `electron-store` is required in eight places, several instances throwaway
- **File/function:** `main.js:944,987,1920,2001,2065,2409`; `outreach/OutreachService.js:435,461`; `mailbox/mailboxPersistence.js` (injected factory).
- **Problem:** each `new Store()` re-reads and re-parses the same file, so an in-memory divergence is silently overwritten on the next write.
- **Change:** one store instance, injected.
- **Risk:** **M**
- **Acceptance:** one `Store` instance exists; a test asserts settings persist and reload correctly.

#### G-63 · A 2,446-line generated bundle is shipped as the only source of the research engine
- **File/function:** `prospect-research/prospect-research.cjs` (79 KB) — an esbuild bundle of a TypeScript tree that lives **outside** this repository (`scripts/sync-prospect-research.ps1:19` → `G:\ztech-integration\ztech-prospect-research`).
- **Problem:** the largest single piece of the research engine is **not reviewable in this repo**; it is also the only consumer of `ajv`, `ajv-formats`, and `@modelcontextprotocol/client`. A dead `0 && (module.exports = {...})` block remains at `:2440-2446`.
- **Change:** bring the source into the repo (or a published, versioned package) so it is reviewable and testable in place.
- **Risk:** **M**
- **Acceptance:** the research engine's source is in-repo and covered by the CI test run.

#### G-64 · The renderer is a single 10,944-line file
- **File/function:** `src/renderer/renderer.js` (542 KB) + `index.html` (155 KB) + `src/renderer/lead-intelligence/**` (split modules exist for the LI layer only).
- **Problem:** the presentation layer cannot be lifted into a browser SaaS without a rewrite, and the existing frontend tests extract functions by **string slicing** (`tests/frontend9-home-settings.test.js:27-40` `between()` / `functionSource()`), which is brittle.
- **Change:** split the renderer into feature modules with explicit boundaries before the SaaS frontend work.
- **Risk:** **M**
- **Acceptance:** no renderer file exceeds a defined size, and the string-slicing tests are replaced by importable units.

#### G-65 · Business rules are duplicated between the legacy and the Lead Intelligence layers
- **File/function:** dedup exists in `accountStore.js:666-737` and in `lead-intelligence/**`; outreach gating in `outreach/OutreachGate.js`; trust in `trust/**`.
- **Problem:** the legacy and LI layers each hold a partial view of the same rules, which is exactly the "duplicated business rules" risk in the handover.
- **Change:** a single source of truth per rule, with the legacy path delegating to it.
- **Risk:** **M**
- **Acceptance:** a test proves the legacy and LI paths produce identical decisions for the same input.

#### G-66 · No explicit typed or validated interfaces between layers
- **File/function:** `src/main/lead-intelligence/core/validate.js:5-6` — *"Minimal JSON-schema-like validator with no dependencies"* — a hand-rolled validator standing in for `ajv`, while `ajv` is in `package.json` and used only by the vendored bundle.
- **Change:** adopt `ajv` (already a dependency) for the validated boundaries, with generated or hand-written schemas per contract.
- **Risk:** **M**
- **Acceptance:** every cross-layer contract validates against a schema, and a schema-drift test fails on mismatch.

---

## 4. F4 target data model (proposal, to be validated in F4)

```
workspaces ──< workspaces_members >── users
      │
      ├──< companies ──< company_locations
      │        │  └──< contacts ──< contact_points ──> source_observations
      │        ├──< people ──< person_roles >── companies
      │        ├──< research_evidence
      │        ├──< opportunities ──> (OI research_id)
      │        └──< campaigns ──< outreach_activity / outreach_sends
      │                         ├──< sequences ──< sequence_steps
      │                         └──< reply_reviews ──< reply_routes
      └──< contact_consents / suppressions / trust_events
```

Rules that must hold:
- A company may have **many** locations, many contacts, many people.
- A person may have **many** roles and **several** verified contact methods.
- A duplicate phone number does **not** imply a duplicate business (preserve `DUPLICATE_REVIEW_RULES`).
- Every field carries provenance, timestamp, and a verification state (`verified | unverified | invalid | unknown`).
- **Contact information is never fabricated** — a field is either sourced or null.
- Deletion is safe: soft-delete + audit trail, then a physical purge job.

---

## 5. What must **not** be rebuilt (already correct and working)

Per the handover: *"Do not recreate features that already exist and work correctly."*

| Capability | Location | Note |
|---|---|---|
| Identity resolution / dedup rules | `accountStore.js:666-737` | 5 rules with documented precedence; well tested |
| ICP fit evaluation | `icp/icpFit.js`, `IcpService.js` | covered by `tests/lead-intelligence/icp.test.js` (27 assertions) |
| Outreach gate — 11 checks | `outreach/OutreachGate.js:28-84` | lead identity, contact, qualification, ICP, evidence presence/freshness/completeness, prohibited claims, pitch integrity, human approval |
| Evidence packet contract | `contracts/evidencePacket.js`, `contracts/provenance.js` | validated, not free-form |
| Trust / consent / suppression + RFC 2369 & 8058 | `trust/**`, `migrations/008` | irreversible inside the app by design |
| Mailbox pacing caps | `mailbox/pacing.js`, `migrations/010` | daily/hourly caps, min gap, time zone, window |
| ZuniSEO round-1 transport | `prospect-research/prospect-research.cjs` | breaker + retry + `Retry-After` + contract validation + quarantine |
| OI contract validation | `OpportunityIntelligenceGateway.js:398-416` | every report is validated before it is believed |
| OI server-side idempotency | `research_service.py:278-352` | per-caller-intent key, atomic claim, replay semantics |
| OI interrupted-job recovery | `research_service.py:234-242` | time-based closure at startup |
| ZuniSEO contract v1 + envelope integrity | `zuni-seo/contracts/v1/contract.schema.json`, `contract.py:67-85` | versioned, integrity-checked, golden fixtures |
| Versioned `li_*` migrations with rollback-on-failure | `persistence/SqlJsStore.js:88-107` | 13 migrations, per-migration transaction |
| Atomic JSON write + `.bak` + recovery reader | `persistence/atomicFile.js:20-54` | written and tested — **just never wired in** (see G-10) |
| IPC input schemas + sender guard | `ipc/schemas.js`, `ipc/registerLeadIntelligenceIpc.js` | 15 hostile payloads rejected before any service call |
| CSP policy | `index.html:6` | byte-exact, pinned by test |
| Dependency drift guards | ~20 test files | "no new dependency" assertions |

---

## 6. Recommended execution order

| Phase | Gaps | Notes |
|---|---|---|
| **F0** | G-01 … G-23, G-48, G-22 | Test harness, CI, dependency posture, backup/restore, migrations, release process. **G-10 needs approval** (it changes how the database is written). |
| **F1** | G-50, G-51, G-52 | Rebrand + a **safe** `userData` compatibility layer. |
| **F2** | G-61 … G-66 | Extract a cloud-compatible core; no behaviour changes. |
| **F3** | G-24 … G-31, G-39, G-40, G-42, G-43, G-44, G-45 | Discovery resilience, second source, contract fixes. |
| **F4** | G-32 … G-38 | The structured business model, with a safe migration. |
| **Legal** (parallel) | G-58, G-59, G-60 | Required before any commercial sale. |

### Approval required
1. **G-10** — switching the database write to `writeFileAtomic()` (keeps a `.bak`, adds `fsync`).
   `persistence/atomicFile.js:9-13` explicitly says *"only switch it to writeFileAtomic with the user's approval."* The change is **additive and non-destructive** (it keeps a rolling backup of the previous file) but it alters the durability characteristics of the primary store.

---

## 7. Appendix — evidence index

| Area | Primary sources read |
|---|---|
| Startup / IPC / window | `main.js` (2,492 L), `preload.js` (269 L) |
| Persistence | `src/main/accountStore.js`, `lead-intelligence/persistence/*` (9 files), `migrations/*.sql` (13) |
| Providers | `coreClawClient.js`, `providers/*` (4), `prospect-research/*` (7 + bundle), `lead-intelligence/providers/*` (7), `lead-intelligence/enrichment/*` (7) |
| Outreach | `lead-intelligence/outreach/*` (17), `mailbox/*` (9), `trust/*` (5), `replies/*` (3), `sequences/*` (4) |
| Opportunity | `lead-intelligence/opportunity/*` (12) |
| Research | `lead-intelligence/research/*` (9), `lead-intelligence/agent/*` (2), `lead-intelligence/contracts/*` (4) |
| Tests | 115 test files, 3 harnesses, 2 fixtures, 2 harnesses |
| Build / CI | `package.json`, `package-lock.json`, `vite.config.js`, `scripts/`, `tools/` |
| OI engine | `src/ztech_oi/**` (85 files), `tests/` (12), `schemas/`, `examples/`, `clients/node/` |
| Legal | `ztech-legal/{index,privacy,terms}.html`, `README.md` |
| ZuniSEO (read-only) | `src/zunitech_seo/server/*`, `contracts/v1/contract.schema.json`, `docs/ZTECH-HANDOFF.md` |
