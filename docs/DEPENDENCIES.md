# Dependency audit

**Date:** 2026-10-20 · **Repository:** ZTech Lead Generation
**Scope:** `package.json` + `package-lock.json` (the shipped runtime and the
build toolchain).

The audit is re-run on every CI run:
`npm run audit:prod` is **blocking**, `npm run audit:all` is advisory.

---

## 1. Current posture

| | Before F0 | After F0 |
|---|---|---|
| `npm ci` from the committed lockfile | **FAILED** (32 missing entries) | **works** |
| Production advisories (`npm audit --omit=dev`) | 2 high | **0** |
| Total advisories (including dev tooling) | 33 (26 high, 2 critical) | 12 (3 high, 9 moderate) — all build-time only |
| Blocking CI gate | none | `npm run audit:prod` |

### Installed versions

| Package | Range | Installed | Role | Verdict |
|---|---|---|---|---|
| `electron` | `33.4.11` (pinned) | 33.4.11 | **shipped runtime** | ⚠ **EOL — see §3** |
| `electron-store` | `^8.0.1` | 8.2.0 | shipped (settings, credentials) | ok |
| `sql.js` | `^1.10.3` | 1.14.1 | shipped (primary datastore) | ok — WASM SQLite, not covered by the npm CVE feed |
| `@modelcontextprotocol/client` | `^2.1.0` | **2.3.1** | shipped (ZuniSEO MCP client) | ok — updated by F0, cleared the `fast-uri` advisories |
| `ajv` | `^8.20.0` | 8.20.0 | shipped (contract validation) | ok |
| `ajv-formats` | `^3.0.1` | 3.0.1 | shipped | ok |
| `vite` | `^5.4.0` | 5.4.21 | build/dev only | ⚠ out of support window — §3 |
| `electron-builder` | `^26.0.0` | 26.17.x | build only | ok — **upgraded from 25.1.8 by F0** |
| `concurrently`, `cross-env`, `wait-on` | — | — | dev only | ok |

No dependency is unused: every one of the 11 is genuinely imported, and
`tests/runtime-containment.test.js` pins the exact set so a new dependency
cannot be added silently.

---

## 2. What F0 changed

1. **The lockfile was regenerated.** The committed `package-lock.json` did not
   contain the `archiver` / `electron-builder-squirrel-windows` / `fs-extra`
   tree that `electron-builder` needs, so `npm ci` failed with:

   ```
   npm error `npm ci` can only install packages when your package.json and package-lock.json
   npm error are in sync. Please update your lock file with `npm install` before continuing.
   npm error Missing: electron-builder-squirrel-windows@25.1.8 from lock file
   npm error Missing: archiver@5.3.2 from lock file
   ... 32 entries in total
   ```

   This was a hard blocker for any reproducible install, and therefore for CI.
   `npm run check:repo` now fails if package.json and the lockfile ever drift
   apart again.

2. **`electron-builder` 25.1.8 → 26.x.** The Windows directory package was
   rebuilt and verified with the new version.

3. **`@modelcontextprotocol/client` 2.1.0 → 2.3.1** (transitive, inside the
   declared `^2.1.0` range — `package.json` was not edited). This cleared the
   only two production advisories: `fast-uri` host-confusion and SSRF issues
   reachable through the ZuniSEO MCP client.

---

## 3. Accepted risks (with an owner and a date)

### A-1 · Electron 33.4.11 is end-of-life — **HIGH**

`npm audit` reports `electron` as **high** severity. Electron 33 ships an
old Chromium and has left the support window. The app's only web hardening is
a `<meta>` CSP (`index.html:6`) plus a `will-navigate` guard
(`main.js:866-874`); there is no `webRequest` filtering.

**Why it is not fixed in F0.** An Electron major upgrade moves the bundled
Chromium and Node versions and needs a real desktop smoke test — the
automated suite never launches Electron (the suite itself prints
`RUNTIME-REQUIRED (not unit-testable without launching Electron)`). Upgrading
blind would risk the Lead Intelligence features, the preload bridge and the
CSP for no verified gain.

**Planned fix.** Upgrade to the current supported Electron line, then:
1. run the full suite;
2. launch the packaged app and walk the Signup → Search → Research →
   Opportunity → Outreach path manually;
3. confirm the preload bridge still exposes exactly the same surface
   (`tests/lead-intelligence/ipc-security.test.js` and
   `tests/ipc-hygiene.test.js` assert the channel set);
4. confirm the CSP is still byte-exact (`tests/csp-policy.test.js`).

**Target:** the first release after the F1 rebranding, which changes the
`appId`/`productName` and therefore has to rebuild the installer anyway.
**Owner:** engineering. **Review:** at the start of F1.

### A-2 · Vite 5.4.21 is out of its support window — **MEDIUM**

Build/dev only; it never ships. The dev server binds to `localhost` with
`strictPort: true`. The Vite **build** pipeline is not even used (audit gap
G-14) — production loads the raw `index.html` from the asar.

**Planned fix.** Upgrade together with A-1, and either wire `vite build` into
the packaging path or delete the dead configuration.

### A-3 · 12 advisories in the build toolchain — **LOW**

All remaining advisories are in `electron-builder`'s transitive tree
(`node-gyp`, `tar`, `cacache`) and are **not shipped** — they only affect a
developer machine while packaging. `npm audit fix --force` would move
`electron-builder` to a pre-release, which is not acceptable.

**Planned fix.** Upgrade `electron-builder` to a stable release that clears
them, on the same cycle as A-1.

### A-4 · `sql.js` is a WASM build and is invisible to the npm CVE feed — **LOW**

The primary datastore is a WASM SQLite build. It is not covered by the usual
node-gyp/SQLite advisory feed and sits inside `app.asar` (unpacked), out of
reach of Node's normal patching. This is a known, accepted characteristic of
the current architecture and is part of the reason F4 moves the data layer to
a server-side database.

---

## 4. Policy

1. **Production advisories block a release.** `npm run audit:prod` runs in CI
   and must exit 0.
2. **Build-time advisories are advisory.** They are reported by
   `npm run audit:all` and tracked in §3, not silently ignored.
3. **No new dependency without a deliberate decision.** The exact dependency
   set is pinned by `tests/runtime-containment.test.js`; changing it means
   changing that test on purpose, in the same commit.
4. **The toolchain stays dependency-free.** The test suite, the repository
   hygiene check and the CI workflow use only Node's standard library. This is
   why no linter framework was added in F0 — see `docs/PROJECT-UPDATE.md`.
5. **Every accepted risk has an owner and a review date.** §3 is that list.
