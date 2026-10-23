# The ZuniSEO contract: two different checks, and what each one proves

**The short version:** the CI job called *zuni-seo contract drift* is **green
even when the cross-repository comparison never ran**. A green run of that job
therefore proves that the **committed** contract is unmodified — it does **not**
prove that the vendored copy still matches the zuni-seo repository.

This document says exactly what each check proves, so nobody reads more into a
green job than it establishes.

---

## The two checks

### A — The always-on local guard (the SHA-256 manifest)

| | |
|---|---|
| **What it is** | `tests/lead-intelligence/zuniseo-envelope.test.js` verifies the vendored contract schema and the golden fixtures against their recorded SHA-256 values in `src/main/lead-intelligence/contracts/zuni-seo/v1/contract.manifest.json`. |
| **When it runs** | **Always** — in the ordinary test matrix (Windows and Ubuntu, Node 20 and 22), on every commit and every pull request. It needs no network and no secret. |
| **What it proves** | The files **in this repository** are byte-identical to the state that was recorded when they were vendored. Nothing in this repository has drifted, been edited by accident, or been tampered with. |
| **What it does NOT prove** | That the vendored copy still equals what **zuni-seo** publishes today. The manifest is a record of the past, not a comparison with the source of truth. |

### B — The external cross-repository drift check

| | |
|---|---|
| **What it is** | `node scripts/sync-zuniseo-contract.js --from zuni-seo --check` compares the vendored contract against a checkout of `z-sops/zuni-seo` at `feature/geo-growth-intelligence`. |
| **When it runs** | Only when the job can check zuni-seo out. The repository is **private**, so the job's own `GITHUB_TOKEN` cannot read it; the job needs a token that can. Without that token the checkout step is skipped (`continue-on-error`), the comparison step is **skipped**, and a notice is printed instead. |
| **What it proves** | The vendored copy is identical to the zuni-seo source **at that ref, at that moment**. This is the only check that can detect zuni-seo having changed. |
| **What it does NOT prove** | Anything about a ref other than the one checked out, and nothing at all when it is skipped. |

---

## The current state

**B has not run.** The zuni-seo repository is private and no token with access
to it is configured for the workflow, so every run of the job has taken the
"skipped" path and printed the notice.

**Consequence: external parity is NOT verified.** The status of the vendored
contract is *last verified against zuni-seo at the point of vendoring*, not
*verified as of today*. No statement of external parity may be made from a
green CI run of this job alone.

The zuni-seo repository is **read only** here and is never modified. Its
own repository is not part of the ZTech Cloud SaaS programme's scope.

---

## Turning B on

B needs a secret with **read** access to `z-sops/zuni-seo` on the
`ZTech-Lead-Generation` repository, named `ZUNI_SEO_READ_TOKEN`. The owner of
the repository configures it in the repository settings; it is not requested,
discussed or handled in chat, and it is not committed anywhere.

Once the secret exists, the checkout step succeeds, the comparison step runs
and becomes a **required** check, and a green job then genuinely proves both
A and B.

Until then, the job is honest about what it did: the notice it prints says
that the cross-repository comparison could not run and names the always-on
gate that still applies.

---

## What a reviewer should ask

| Question | Answer |
|---|---|
| Is the vendored contract unmodified in this repository? | **Yes** — check A, always on. |
| Does the vendored contract still match zuni-seo? | **Not verified** — check B has not run. |
| Was zuni-seo modified? | **No.** It is read only in every path. |
| Is the ZuniSEO *mapping* correct? | Yes — `tests/lead-intelligence/zuniseo-envelope.test.js` maps zuni-seo's **own** golden fixtures, including the native v1 dialect, and the M0 boundary suite re-checks the mapper after the extraction. That is a check of the mapping against the vendored fixtures, **not** a check of external parity. |
