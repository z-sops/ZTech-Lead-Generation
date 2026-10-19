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

### Test evidence

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

Baseline for comparison, before F0: 89 test files executed, 2,312 assertions
counted by scraping console output, 0 failing, up to 37 assertions silently
skipped, and `npm ci` failing outright.

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

F0 completion for the remaining two repositories (Opportunity Intelligence and
Legal), then F1.
