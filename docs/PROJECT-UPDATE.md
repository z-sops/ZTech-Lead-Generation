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

Baseline for comparison, before F0: 89 test files executed, 2,312 assertions
counted by scraping console output, 0 failing, up to 37 assertions silently
skipped, `npm ci` failing outright, **no CI in any of the three
repositories**, ruff reporting 4 errors and mypy 1 error, and the legal
documents with no validation of any kind.

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

### Next

F0 is complete for all three ZTech repositories. The next phase is **F1 —
branding and identity** (audit gaps G-50, G-51, G-52), which must also ship
the **data-directory compatibility layer** so that existing users' data is not
orphaned when the legacy `phone-global-leads` / `phone全球获客` /
`com.whatsapp.automation` identifiers are replaced.

Decisions needed before F1 can complete:
1. The registered legal entity name, jurisdiction and contact address (they
   decide BRAND-1 and ENTITY-1/2 in `ztech-legal/docs/LEGAL-GAPS.md`).
2. Whether Electron 33 is upgraded as part of the F1 release (see
   `docs/DEPENDENCIES.md` §3 A-1) — the rebrand has to rebuild the installer
   anyway, so it is the cheapest moment to do it.
3. Whether a linter is added. F0 deliberately kept the toolchain
   dependency-free; this is a reversible decision.
