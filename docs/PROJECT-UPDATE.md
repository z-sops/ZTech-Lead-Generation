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

### M0 — the shared Lead Intelligence package (2026-10-20)

**Branch:** `feat/m0-shared-lead-intelligence` (from the approved F2 revision 3
head `f8d9490c`). **Status: implementation complete, awaiting review.**

The Lead Intelligence domain and application logic now live in
`packages/lead-intelligence` — the package `@zunitech/lead-intelligence`.

**The move set was computed, not hand-written.** It is closed over the relative
requires and excludes everything that transitively depends on `electron`, the
file system, a child process, the OS credential store, or the local OAuth
callback server. **96 modules moved; 20 stayed behind** for exactly those
reasons, and 9 more stayed by policy (the composition roots, the SQLite
persistence adapter that M1 replaces, and a persistence adapter).

**There is no second implementation.** Every original path keeps a
compatibility shim that RE-EXPORTS the package:

```js
module.exports = require('../../leadIntPackage').load('core/ids');
```

so the desktop application, the tests and every existing require path keep
working unchanged, and the new boundary test asserts that the shim and the
package resolve to the **same module instance** for all 96 modules.

**The shared core has no forbidden dependency** — no Electron, no file system,
no child process, no credential store — and never reaches outside itself. The
boundary test proves it by reading every file in the package.

**No database schema change.** All 13 migration files and the embedded copies
are byte-identical to the F0/F1 baseline, and the boundary test asserts it.
The check is anchored on a recorded SHA-256 manifest
(`src/main/lead-intelligence/persistence/migrations.manifest.json`), so it
holds in the shallow checkout CI does; the comparison against the base ref
runs as a second check whenever that ref is available.

**The packaged desktop application still works.** The shared package is inside
the asar (99 files), the workspace link is not, and the resolver falls back to
the in-repo source path — so the packaged app loads the package. This is
verified by running the PACKAGED Electron, and it is now a permanent CI step
(`scripts/check-packaged-package.js`).

**Tests:** 123 files, 2,000 assertions, 0 failed, 0 skipped. The **1,990
pre-existing assertions are unchanged**; the 10 new ones are the boundary
suite.

**The source-text assertions were pointed at the implementation.** A number of
tests assert on the SOURCE of a module ("the outreach gate must mention the
approval check"). Those assertions are about the implementation, so they now
follow it through `tests/lead-intelligence/impl.js`. Their intent is unchanged.

### The M0 review follow-ups (2026-10-20)

The M0 review accepted the extraction and asked for four things before M1.
All four are done, on the same branch, in the same draft pull request.

**1. The package boundary is now the ABSOLUTE package boundary.** The guard
resolved a relative import against the **repository root**, so an import that
left the package but stayed inside the repository was not reported. It now
resolves against the absolute `packages/lead-intelligence/src` boundary, and a
sibling directory that merely shares the name prefix is not inside it either.

**2. The guard is exercised by a regression test.** The check is now a
function, and a test feeds it three synthetic files: one that imports outside
the package, one that imports outside the repository, and one that stays
inside. The first two must be reported, the third must not.

**3. The package loads through its public name.** `require('@zunitech/lead-intelligence')`
and the subpath exports work, and they are the **same module instances** as the
in-repo paths. The exports map had a real defect: a subpath **with** the
`.js` extension resolved to `ids.js.js`. The map now publishes both
spellings, and a path the map does not publish is proven to be unreachable.

**4. The ZuniSEO distinction is documented — and it matters.**
`docs/ZUNISEO-CONTRACT-DRIFT.md` separates the two checks:

| Check | Status | Proves |
|---|---|---|
| The **local** SHA-256 manifest gate (`tests/lead-intelligence/zuniseo-envelope.test.js`) | **always on**, green | the vendored contract in this repository is unmodified |
| The **external** cross-repository comparison (`scripts/sync-zuniseo-contract.js --from zuni-seo --check`) | **SKIPPED** — zuni-seo is private and the job has no token for it | the vendored copy still matches zuni-seo |

**The cross-repository comparison has not run, so external parity is NOT
verified.** The green *zuni-seo contract drift* job does not mean otherwise,
and the job now says so in a notice. Turning it on needs the
`ZUNI_SEO_READ_TOKEN` secret, which the repository owner configures in the
repository settings — it is not requested or handled in chat, and zuni-seo
itself is never modified.

**Tests:** 123 files, **2,002 assertions**, 0 failed, 0 skipped. The 1,990
pre-existing assertions are unchanged; the boundary suite is now 12
assertions.

### Next

M0 is submitted as a **draft pull request** for review. **Nothing merged,
force-pushed, deployed or deleted; the base branch is untouched.** On
approval: M1 — the repository seam and the PostgreSQL schema.

---

## 2026-10-20 — M1: the repository seam and the PostgreSQL schema

**Branch:** `feat/m1-postgres-repository` (from the reviewed M0 head
`26d5efbd`). **Status: implementation complete, awaiting review.**

The Lead Intelligence persistence is now **one interface with two
implementations**: the desktop's sql.js store, and a PostgreSQL 16 store.

**The seam is explicit.** `packages/lead-intelligence/src/persistence/interfaces.js`
declares the twenty-five repositories, their methods and the twelve
invariants a store must preserve. A store that forgets a method fails a test,
not a production call. The desktop's store satisfies the seam; so does the
PostgreSQL one.

**The PostgreSQL implementation is a separate package**,
`packages/lead-intelligence-postgres`, because it needs the `pg` driver and
the shared core package has **no dependencies at all**. The shared core's
boundary test still holds: no Electron, no file system, no process, no
external module.

**The schema mirrors the desktop, one table for one.** Thirteen PostgreSQL
migrations mirror the thirteen desktop migrations. The differences are the
ones PostgreSQL is better at: `TIMESTAMPTZ` instead of text timestamps,
`JSONB` instead of text documents, `BOOLEAN` instead of 0/1 flags, `TIME` for
the sending window, and a `seq` column where the desktop uses `rowid` (so
"newest first, insertion order for ties" means the same thing on both
engines). **The partial unique indexes are kept exactly**: one active job
per request key, one active enrichment job per lead, one pending OI refresh
intent per lead, one accepted send per (channel, idempotency key), one trust
event per event id, one open sequence per lead. The idempotency guarantee is
enforced by the database on both engines, not by application code.

**The tenancy structures are prepared, and nothing more.** Every
tenant-owned table carries a `workspace_id`, and the store is bound to one
workspace. **M1 proves no isolation**: the filter is application-level, the
RLS policies and the cross-tenant denial suite are M2.

**The contract suite is one suite with two backends.**
`tests/persistence-contract/contract-suite.js` runs the same thirty
assertions against the sql.js store and against a real PostgreSQL 16, and the
two produce identical results. The mapping, the conversions (including the
malformed cases) and the migration idempotency are proved in the same place.
The PostgreSQL job runs a **PostgreSQL 16 service container** in CI; without
one, those assertions are **skipped, and the skip says so**.

**The desktop is untouched in behaviour.** The desktop's store gained a
public `deleteByLead` on four repositories, a `tx` that also accepts an
asynchronous callback (a synchronous one still commits in the same tick, as
before), and two helpers so that one contract test can drive both stores.
The 1,990 pre-existing assertions still pass unchanged, and the thirteen
desktop migration files are still byte-identical to the F0/F1 baseline.

**The packaged desktop application is unchanged.** The shared package is
inside the asar (126 entries); the PostgreSQL package and the `pg` driver are
**not** in it (0 entries) — the desktop never loads them.

**Tests:** 128 files, **2,053 assertions**, 0 failed (2,046 passed, 7 skipped
without a PostgreSQL; all 2,053 pass with one).

### Next

M1 is submitted as a **draft pull request** for review. **Nothing merged,
force-pushed, deployed or deleted; the base branch is untouched.** On
approval: M2 — tenancy, row-level security and the cross-tenant denial
suite.

### The M1 review corrections (2026-10-20)

The M1 review accepted the shared repository approach and asked for five
corrections before M2. All five are done, on the same branch, in the same
draft pull request.

**1. The transaction's client is no longer shared state.** It used to be a
field on the store, so two transactions running at the same time could pick
up each other's client. It is now held in an **AsyncLocalStorage** context,
so it belongs to the operation that opened the transaction and to nothing
else. A **nested transaction joins the outer one** through a `SAVEPOINT` —
PostgreSQL has no nested transactions, and a nested one that opened its own
connection would deadlock against the outer transaction's locks. The
concurrency tests prove it against a real PostgreSQL 16: simultaneous
transactions on different connections, isolation between them, rollback
isolation, the pool, savepoints, and that the pool survives a failed
transaction.

**2. The workspace identifier is a UUID**, as F2 §4.1 requires
(`workspace_id uuid not null`, with a leading index). Every primary key and
every index now leads with it, and the store refuses to be constructed with
a workspace that is not a UUID. **The desktop's own data and schema are
untouched**: its column stays `TEXT`, its value stays `local`, and its
thirteen migration files are still byte-identical to the F0/F1 baseline.

**3. Every key and unique index is tenant-safe.** The active-research index
on `request_key` was the example the review named; it now carries the
workspace, and so do all of them: the enrichment job's lead, the OI refresh
intent's lead, the accepted send's (channel, idempotency key), the trust
event's id, the reply review's event, the sequence's lead and first email,
the step's pitch, the mailbox's address and the stored message id. The
mapping test proves it from the migration files on every run. Two workspaces
can now hold the **same** business key without blocking each other, and
neither can read or write the other's rows.

**4. The global tables are reviewed.**
`li_sequence_control` is **workspace-scoped** — one customer's pause-all no
longer pauses another customer's sequences. The market rules stay global, and
only the **platform** may write them: a tenant store's write throws
`FORBIDDEN`, and a tenant may still read them. A **global suppression**
blocks every workspace, but it never exposes the contact information it
holds: the address is redacted, the reason is kept, and the global row is
never listed to a tenant.

**5. The tests.** The SQLite/PostgreSQL equivalence suite is retained, and
two new suites run against a real PostgreSQL 16: the concurrency suite
(8 assertions) and the multi-workspace suite (7). The mapping test gained
the tenant-safety gate.

**Tenant security is NOT implemented.** These are structural proofs: the
schema and the store's scoping are tenant-safe. Row-level security, the
role ladder, the `SECURITY DEFINER` grants, the startup role assertion and
the cross-tenant denial suite remain **M2**, and nothing in this branch may
be read as a claim that they exist.

**Tests:** 130 files, **2,097 assertions**, 0 failed, 0 skipped (with a
real PostgreSQL 16); 2,068 with 22 skipped without one.

### Next

M1 is submitted as a **draft pull request** for review. **Nothing merged,
force-pushed, deployed or deleted; the base branch is untouched.** M2 —
row-level security, tenant isolation, role boundaries and the cross-tenant
denial suite — is **awaiting authorization**.

---

## 2026-10-21 — M2: secure multi-tenant database isolation

**Branch:** `feat/m2-tenant-isolation` (from the accepted M1 head
`02795dc4`). **Status: implementation complete, awaiting review.**

**The tenant boundary is now a property of the DATABASE, not of the
application.** A customer in workspace A cannot read, modify, delete,
reference or control workspace B's records — **even when the application's
workspace filters are missing or wrong**, because the row-level security
policies refuse it.

- **Row-level security** is ENABLED and **FORCED** on all 28 tenant-owned
  tables, with one policy each: the row's workspace must equal the
  transaction's context.
  - **The context is server-derived, transactional and PROVED.** It is set by
    `li.set_workspace(workspace, token)`, a `SECURITY DEFINER` function that
    verifies a **signed token** — HMAC-SHA256, bound to the workspace, to the
    role and to a lifetime — before it writes the context. The context lives
    in a table the runtime roles cannot write, and it carries the
    transaction id, so it belongs to one transaction and one role.
  - **The token is the authority; the grant is a ceiling.** Only the
    **control plane** (`ztech_control`) may issue a token — a runtime
    session may present one, never ask for one. A role granted many
    workspaces still reaches only the one it holds a token for, so the
    isolation is per-customer, not "one role, many tenants".
  - **Missing, invalid, expired and mismatched contexts fail closed.** The
    context function returns NULL, and NULL matches no row and allows no
    write.
  - **Five database roles**: the migrator owns the schema, the tables and the
    SECURITY DEFINER functions; the **control plane** may issue a token and
    nothing else; the app, worker and platform roles do not own a table, are
    not superusers and have no `BYPASSRLS`. `PUBLIC` holds no privileges at
    all.
- **The startup assertion** checks the live database — the role's own
  properties, the ownership of every table, RLS enabled and forced on every
  tenant table, the policy on every table, the tenant-table inventory, the
  `PUBLIC` privileges, and the platform data's write permissions. The test
  proves the assertion is real by showing it failing for a privileged role.
- **The workspace-aware foreign keys** mean a tenant can neither reference nor
  collide with another tenant's record. The business identifiers are
  unchanged.
- **The global suppression** blocks every workspace and exposes nothing: a
  tenant may not create, change or delete one (the application refuses, and
  so does the database), cannot see one, and asks the authorized
  `li.is_suppressed()` — which answers with a yes or a no, never a row.
- **The market rules** are platform data: a tenant reads them, only the
  platform writes them.

**The evidence.** The denial suite runs raw SQL as the **runtime role** — not
the owner — and proves that `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `UPSERT`,
joins, aggregates and cross-tenant references are all refused across two
independent tenants, that two tenants may hold the same business keys, and
that a missing, invalid or mismatched context fails closed. The concurrency
suite proves the transaction's client belongs to the operation that opened
it, that the context does not survive the transaction, and that eight
concurrent transactions get eight connections.

  **The tests now run against a real PostgreSQL 16 with the production roles**,
  in a database whose schema is named `li` — the name the deployment has — and
  with the migrations applied **as the migration role**, so the tables and the
  SECURITY DEFINER functions are owned by the role that owns them in
  production, and not by the administrator. What the tests exercise is what a
  deployment runs.

  **Security review corrections (the same branch).** The review found a real
  breach and a real gap in the evidence, and both are fixed:

  - **C1 — the forged workspace context.** The context was kept in the custom
    setting `app.workspace_id`, and the policy trusted it. A custom setting
    is writable by **any** role with `set_config()`, so a session authorised
    for workspace A could write workspace B's id into it and read — and
    write — B's rows. It was **reproduced against a real PostgreSQL 16**
    before it was fixed. PostgreSQL 16 cannot close that door by locking the
    setting down (`REVOKE SET ON PARAMETER` applies to known parameters, not
    to placeholders), so the context no longer lives in a setting at all: it
    lives in a table the runtime roles cannot write, and it is opened with a
    signed token that only the control plane may issue. The new **forgery
    suite** proves that a forged setting — direct `SET`, `set_config`, a
    prepared statement, and a reused connection — changes nothing, that the
    context table cannot be written by a runtime role, that a runtime role may
    not issue a token, and that a token is bound to its workspace, its role
    and its lifetime.
  - **C2 — the production ownership.** The test harness applied the
    migrations through the administrator, so the functions under test were
    owned by a superuser — a property no deployment has. The harness now
    applies them **as the migration role**, and the new **production-roles
    suite** proves the ownership, the real role properties (SUPERUSER,
    BYPASSRLS, CREATEROLE, CREATEDB), the effective privileges, that
    `li.is_suppressed()` answers for a tenant's own address, a platform
    global address and an unsuppressed address, that a tenant cannot
    enumerate the global rows, and that the function cannot be used to read
    or write tenant data.
  - **A discrepancy corrected**: the documentation said the migration role
    bypasses the row-level security; `roles.sql` never said so, and the
    database said no. It is now stated in `roles.sql`, and the test asserts
    it.

  **Final review corrections (the same branch).** Two more issues, both
  fixed and both proved by new suites:

  - **C3 — the predictable credentials.** `roles.sql` created the roles
    with a known `CHANGE_ME_*` password, and the provisioning carried on
    when the environment had none, so the placeholder stayed in force. A
    password that is in the repository is not a password. Every role is now
    created **NOLOGIN with no password at all**, the credential comes from
    the environment, and the role is enabled only once the credential is
    set. The provisioning **fails closed**: a missing or malformed
    credential changes nothing and exits with an error that names the
    variables and never their values. The result is then **verified**
    against the live database — the role may log in, it is not a
    superuser, it does not bypass the policies, the new credential works,
    and no known placeholder does. A safe **rotation** procedure
    (`scripts/rotate-postgres-role.js`) disables the login, sets the new
    credential, re-enables it and proves that the old one stopped working.
    The harness provisions the cluster's roles the same way, so the tests
    exercise what a deployment runs.
  - **C4 — the token lifetime.** `li.set_workspace()` checked the expiry
    when it opened the context, and `li.current_workspace()` did not check
    it afterwards — so a context could outlive its credential for as long
    as the transaction lived. The expiry is now written into the context
    record, in a table the runtime role cannot write, and it is checked on
    **every read**: a transaction that is still open when the token expires
    loses its access there and then — a `SELECT` sees nothing, an `UPDATE`
    changes nothing, an `INSERT` is refused — and fails closed. A token may
    not be issued with a lifetime beyond the explicit maximum
    (`li.max_token_lifetime()`, 300 seconds). A rollback still takes the
    context with it, a nested SAVEPOINT still keeps it, and a reused
    connection still carries none.

  **The M3 handoff is written down** (`docs/M3-SECURITY-HANDOFF.md`), so the
  next milestone inherits the rules instead of reinventing them: a token is
  minted from the session's membership and never from a client-provided
  workspace id; the control-plane credential and the minting call are
  server-side only, with no HTTP route that mints a token; two independent
  sessions never share a token; logout, a membership removal and a role
  change revoke access at once, through the grant rather than the clock;
  the global suppression check is authorized and rate-limited so it cannot
  be used to enumerate addresses; the migration and BYPASSRLS credentials
  stay out of every runtime service; and the credentials themselves come
  from the secret store, never a default.

  **The final provisioning patch.** The review found one defect on the
  production path: `GRANT CREATE ON DATABASE` single-quoted the database
  name as a **string literal** rather than quoting it as an **identifier**.
  Every name is now quoted by PostgreSQL's own `format('%I', ...)`, and a
  role name that is not a plain identifier is refused outright. The
  credential path was also hardened: `ALTER ROLE ... PASSWORD` cannot take
  a bind parameter, so the secret would have had to appear in the SQL text
  — and SQL text is what a statement log contains. The **SCRAM-SHA-256
  verifier** is now computed in the script and written to `pg_authid` as a
  **bind parameter**, so the password is in no statement, in no log, and
  the stored value is one-way.

  **The production path is now a required CI step.** A new suite runs the
  **real** script, with its **real default role list** — all five roles —
  against an **isolated** PostgreSQL 16 cluster of its own (a second
  service container in the workflow). It proves that a missing or an
  invalid credential fails **before anything is changed**, that all five
  roles are configured with the right properties, that the **migrator** can
  create the `li` schema and apply the migrations and owns the tables with
  RLS enabled and forced, that a **runtime role can create neither**, that
  the stored value is a verifier, and that no known placeholder works.

  **M3 has to solve the per-user grant.** The database grant today is per
  PostgreSQL **role**, not per end user: every user shares `ztech_app`. So
  removing one user's membership must neither lock out every other
  legitimate user of that workspace, nor leave the removed user's session
  authorized. The handoff says how — the session becomes the unit of the
  grant, alongside the role's ceiling — and lists the proofs M3 must
  produce against the real authentication system: logout, membership
  removal, role changes, concurrent user sessions, invitation permissions
  and cross-workspace HTTP denial.

  **What this does NOT do:** it does not authenticate anybody (M3), and it does
  not add the job queue (M4) or the break-glass path (M6). The platform role
  cannot read the tenant tables at all, which is the safe default; the audited
  break-glass path is M6's work. And the **trust boundary** runs between the
  application and the database: the application decides *which* tenant a
  request is for, the database decides *whether* that claim is well-formed,
  current and effective. M3 binds the authenticated user and session to the
  application's side of that line, and the application will ask the control
  plane for a token rather than carrying the secret.

Full detail: `docs/M2-TENANT-ISOLATION.md`.

### Next

M2 is submitted as a **draft pull request** for review. **Nothing merged,
force-pushed, deployed or deleted; the base branch is untouched.** M3 —
authentication, organisations and roles — is **awaiting authorization**.

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

### F2 — architecture and implementation plan (2026-10-20)

**Branch:** `feat/f2-cloud-saas-architecture` (based on the F0/F1 head `9ac4801`).
**Status: DESIGN FOR REVIEW — no implementation has started.**

`docs/F2-CLOUD-SAAS-ARCHITECTURE.md` (1,778 lines) delivers the ten required
items:

| # | Deliverable | Section |
|---|---|---|
| 1 | Current-code reuse and dependency map | §2 |
| 2 | Proposed cloud service architecture | §3 |
| 3 | PostgreSQL entity relationship design | §4 |
| 4 | Tenant isolation and access-control model | §5 |
| 5 | Native CRM workflows and data contracts | §6 |
| 6 | Customer dashboard navigation and feature specification | §7 |
| 7 | Background-job and recovery design | §8 |
| 8 | Authentication, secrets and billing boundaries | §9 |
| 9 | Incremental migration plan from the Electron application | §10 |
| 10 | Implementation milestones with acceptance criteria and tests | §11 |

**The four decisions that define it:**

1. **The intelligence engine is extracted, not rewritten.** The pure modules
   under `src/main/lead-intelligence/` move into a shared
   `@zunitech/lead-intelligence` package that both the desktop app and the
   cloud service import. The **15 invariants** the existing tests already
   protect (§2.4) are the acceptance criteria for the extraction.
2. **PostgreSQL row-level security is the isolation mechanism.** Every
   tenant-owned table carries `workspace_id` with a `FORCE`d RLS policy, and
   the application role is **not** the table owner, so it cannot bypass the
   policy. The cross-tenant denial suite asserts isolation *at the database
   level*, not only in the application.
3. **The desktop app becomes a thin client of the same service**, keeping its
   local mode. The renderer is **not** rewritten in F2.
4. **Every paid provider call is a durable job with a lease**, recorded in a
   `provider_invocations` ledger whose unique idempotency key is the existing
   `sendIdempotencyKey` pattern generalised. A retry can never bill CoreClaw
   twice or send a second email.

**Two orderings are not negotiable:** M2 (tenancy) lands before any customer
row is written; M4 (the job queue and the invocation ledger) lands before any
paid provider is called from the cloud.

**The plan deliberately does not close these known gaps yet** — they are F2
work, and they stay open until it is done: no tenant isolation, no cloud
authentication, no browser-independent durable job recovery, and an OI service
that still has one shared bearer token.

### F2 architecture review decisions (2026-10-20) — revision 2

| # | Decision | Effect on the plan |
|---|---|---|
| **Q5 — Billing** | **Approved.** Plans + seats + entitlements + credits. Credits are an **auditable transaction ledger** with reservations, settlement, refunds, spending limits and reconciliation. No real billing, no prices fixed. | Section 9.3 — the ledger gained the five operations, and the cost caps gained a monthly level. |
| **Q6 — Platform super admin** | **Approved.** Time-limited, audited break-glass only. No permanent unrestricted access. | Section 5.7 — reinforced: break-glass is a temporary workspace **membership**, so every query still passes the normal RLS policy and is captured by the audit triggers. |
| **Q7 — OI isolation** | **Approved.** Per-tenant OI instances first, with isolated storage, credentials and execution. Shared processing must not be activated until the cross-tenant isolation and security tests pass. | **Section 8.8 is new** — the concrete isolation layers, the provisioning flow, the operational cost model, the lifecycle table, and the **five-part activation gate** for the shared instance. |
| **Q8 — CRM identity resolution** | **Modified.** No automatic merge on a single phone or domain. Parent companies, branches, persons and contact points are separate. Automatic merges need **corroborated** evidence; ambiguous matches go to human review; the audit trail and merge reversal are kept. | **Section 6.3 is rewritten** — the four records are separated, the signals have **independence groups**, and an automatic merge now needs two independent signals from different groups, no conflict and no prior manual decision. |

The seven critical requirements are traced to their sections in the plan's
**section 1.4**, so a reviewer can verify coverage without reading the whole
document: RLS enforcement and the runtime role assertions (5.2, 5.3.1, 5.3.2),
isolation across caches, object storage, search and logs (**5.8**), the
preserved Lead Intelligence invariants (2.4), the uncertain-outcome model
(8.4, 8.6), the first-class CRM and dashboards (6, 7), the tested migrations
(10), and ZuniSEO's independence (2.3, 3.1).

### F2 architecture review, revision 3 (2026-10-20)

**The architecture is approved in principle.** Seven specific design issues were
raised, and the plan is corrected. The document is now **2,790 lines**.

| # | Correction | Where |
|---|---|---|
| **C1** | Tenant permissions resolve **strictly inside the active authenticated workspace**. A user who is owner in A and viewer in B stays a **viewer in B**. | §5.3.3 — the resolver's signature requires a workspace, there is no “all my roles” query, and a static test asserts the SQL filters `org_id = $2`. |
| **C2** | The startup role assertion now inspects the **actual ownership and effective privileges** of every tenant table, and the behaviour **without a workspace context** is defined and asserted. | §5.3.1, §5.3.1.1, §5.2.1 — the assertion catches a table created by the app role, a table whose RLS is enabled but not forced, and a table missing from the tenant list. The isolation suite runs against **real PostgreSQL roles** created by the production migration. |
| **C3** | Job leasing gains **due-time eligibility**, a **fenced heartbeat**, safe recovery, and a **tenant-safe claim**. | §8.2.1 — the claim runs inside the workspace's context (RLS applies), `lease_epoch` fences every heartbeat and every commit, and an expired lease cannot produce concurrent provider calls. |
| **C4** | A lookup that returns nothing is **not** a failure unless that provider's API is conclusive; credit **reservations are held** while an outcome is uncertain; the invocation and job enums are aligned. | §8.6.1, §8.4.1, §8.4.2 — a per-provider conclusiveness table, one shared state vocabulary, and a reservation that only settles on a known outcome. |
| **C5** | A person may work for **several companies over time**; a **shared corporate contact point** no longer violates uniqueness; **workspace-aware composite foreign keys** stop a cross-tenant reference in the database. | §4.3, §4.8, §6.2 — `person_employments` and `person_contact_points`, plus composite foreign keys that make a cross-tenant reference impossible even if the application is wrong. |
| **C6** | The migration **merges nothing automatically**; the round trip is **semantically equivalent**, with exact source preservation, count reconciliation and field-level loss reporting. | §10.3.1, §10.4.1 — the byte-identical claim is withdrawn and replaced by V1-V4, each testable. |
| **C7** | Break-glass **read** auditing, because DML triggers do not audit `SELECT`. | §5.7.2 — the break-glass role has **no** `SELECT` on the tenant tables; its only route is a `SECURITY DEFINER` function that writes the audit row in the same transaction before returning anything. A direct read is permission-denied. |

**Q9 decided:** automatic CRM merging is **disabled**. The system produces
**ranked duplicate candidates** for authorised human review; manual merges stay
reversible and audited. Automation may be reconsidered only after **measured
accuracy and false-positive testing**.

**Q10 decided:** **routine** break-glass requires **customer authorisation**;
**genuine emergencies** require **two independent** platform administrators,
**immediate customer notification**, **minimum necessary scope**, a **short
expiry** and **full auditing**. **Self-approval is prohibited** — enforced by
a database trigger, not a UI check.

**Scope decisions recorded** (§1.6): one region initially; five roles with a
team/group organisation; the desktop is preserved but the **browser SaaS is the
priority**, and desktop synchronisation is **out of the F2 critical path** unless
separately approved; a lead is a commercial record and a contact point is a
channel address.

### Next

The F2 plan is submitted for review. On approval the work starts at **M0**
(extract the shared package) and **M1** (the repository seam and the
PostgreSQL schema) — the two milestones that are mechanical, low-risk, and that
de-risk everything else. **M2 (tenancy and RLS) must complete before a single
customer row is written.**

The remaining F1 work — the dashboard shell and the product-metadata pass —
runs alongside, without touching the cloud design.
