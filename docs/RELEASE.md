# Release and rollback runbook

**Owner:** ZuniTech engineering
**Applies to:** ZTech Lead Generation (`ZTech-Lead-Generation`)
**Status:** F0 — this replaces an undocumented, manual process.

> Before this document existed there was no release process at all: the version
> in `package.json` had never been changed since the first commit, there were
> no git tags, no changelog, and `npm run build` produced an unpacked folder
> rather than a distributable artifact. See audit gap G-13.

---

## 1. Versioning

- `package.json` `version` is the single source of truth for the shipped
  version. `main.js` reports it in the log line at startup and sends it to the
  collection provider as `clientVersion`.
- Semantic versioning is used: `MAJOR.MINOR.PATCH`.
  - **MAJOR** — a change to the Lead Intelligence domain model, the outreach
    gate, the trust/consent rules, or the persistence schema that existing
    users would notice.
  - **MINOR** — a new capability that does not change existing behaviour.
  - **PATCH** — a fix that changes no behaviour.
- The product name and identity are being reset in F1. The legacy identifiers
  (`phone-global-leads`, `phone全球获客`, `com.whatsapp.automation`) determine
  the `userData` directory, so **the data-directory compatibility layer must
  ship in the same release as the rename** (audit gap G-50).
- Every release is tagged: `git tag -a v<version> -m "ZTech Lead Generation <version>"`.
  A release without a tag is not a release.

---

## 2. Pre-release checklist

Every box must be ticked on the branch that is about to be tagged.

```bash
# 1. The working tree is clean and the branch is the release branch.
git status --short

# 2. A reproducible install works from the committed lockfile.
npm ci

# 3. The repository hygiene check passes.
npm run check:repo

# 4. The full suite passes - every discovered file, no skips.
npm test
#    Expected: "Test files: N (N passed, 0 failed)" and "0 skipped".

# 5. The shipped dependency tree has no advisories.
npm run audit:prod

# 6. The changelog describes this release.
#    (edit the [Unreleased] section of CHANGELOG.md into a version heading)
```

`npm run verify` runs steps 3, 4 and 5 in one command.

**The suite must report 0 skipped.** The Lead Intelligence persistence layer
guards 37 assertions behind `{ skip }` when `sql.js` is missing, and a fully
skipped file still exits 0 — the runner now refuses to start without `sql.js`
precisely so this cannot hide.

---

## 3. Building a release

### 3.1 What the current build produces

`npm run build` uses the electron-builder configuration in `package.json`:

- `win.target` is `dir` — an **unpacked folder**, not an installer.
- `asar` is enabled, with `node_modules/sql.js/dist/sql-wasm.wasm` unpacked so
  the WASM binary is readable from inside the archive.
- `build.files` whitelists `index.html`, `main.js`, `preload.js`,
  `package.json` and `src/**/*`. The renderer is shipped **unminified**
  (audit gap G-14) and `vite build` is never invoked.
- The build is **not code-signed** (audit gap G-15).

### 3.2 Windows build

```bash
npm run build:win
```

This is `electron-builder --dir --config.win.signAndEditExecutable=false`. The
workaround exists because the default build path needs Windows symlink
privileges that a plain developer account does not have; without it the build
fails on a stock Windows machine.

Output: `dist/win-unpacked/`. Verify the artifact exists and contains the
renderer:

```powershell
Get-ChildItem dist\win-unpacked -Filter *.exe
```

CI performs the same check on `windows-latest` (`package` job).

### 3.3 Producing an installer (not yet done)

There is no `nsis` target yet. Adding one is F1/F2 work, together with code
signing. Until then **a release is an unpacked folder**, and the release notes
must say so.

---

## 4. Publishing

Nothing is published from this repository yet. There is no
`electron-updater` dependency and no update channel, so an installed copy is
updated by hand.

When a release channel exists, the rules are:

1. The tag is the release. The build is produced **from the tagged commit**.
2. The artifact checksum is recorded in the release notes.
3. A release that touches the persistence schema ships with a tested migration
   path and a stated rollback procedure (section 5).
4. `CHANGELOG.md` is updated **before** the tag is pushed, never after.

---

## 5. Rollback

### 5.1 Rolling back code

```bash
git tag                     # find the last good tag
git revert <bad-commit>     # or: git checkout v<version> && rebuild
```

The working tree is always releasable from a tag, so a bad build is rolled
back by building from the previous tag.

### 5.2 Rolling back data — this is the important one

The Lead Intelligence schema is migrated **forward only** by
`persistence/SqlJsStore.js:migrate()`. There is no down-migration. If a
released migration turns out to be defective, the recovery path is the
database backup:

```
%APPDATA%\<app>\data\whatsapp.db        the live database
%APPDATA%\<app>\data\whatsapp.db.bak    the previous write (one save behind)
%APPDATA%\<app>\data\whatsapp.db.corrupt-<ts>   preserved unreadable originals
```

- Since F0, `saveDB()` writes through `writeFileAtomic()`: temp file →
  `fsync` → copy the previous file to `.bak` → rename. **The `.bak` is always
  the file as it was immediately before the last write.**
- If the primary file cannot be opened at startup, ZTech **restores it from
  the `.bak` automatically** and reports `dataMayBeIncomplete` so the UI can
  tell the user that the data may be one save behind.
- An unreadable primary is **never deleted** — it is preserved as
  `whatsapp.db.corrupt-<timestamp>`.

Manual restore:

```powershell
Copy-Item "$env:APPDATA\<app>\data\whatsapp.db.bak" "$env:APPDATA\<app>\data\whatsapp.db" -Force
```

> **Known limitation (audit gap G-11).** The `.bak` is a *single* generation
> behind. If a defect is only discovered after several further writes, the
> `.bak` may already contain it. A versioned, multi-generation backup is
> scheduled and is tracked as gap G-11.

### 5.3 Rolling back the `userData` directory

The user data directory is **not** under the user's control once the app has
run. A full reset is:

```powershell
Remove-Item -Recurse -Force "$env:APPDATA\<app>"
```

This destroys every lead, suppression, consent record, mailbox token and
credential. It is a last resort, and it must never be offered as a routine
support step. The suppression and consent tables are **irreversible inside
the app by design** — see `tools/acceptance/reset-email-suppression.js`, which
is a deliberate, audited, out-of-app maintenance tool and is the only
supported way to clear one suppression for an acceptance run.

---

## 6. Post-release

1. Update `CHANGELOG.md` with the release date and the artifact checksum.
2. Record the release in `docs/PROJECT-UPDATE.md`.
3. Confirm the `main` branch still has a green CI run for the tagged commit.
4. Keep the tag reachable — do not delete or move it.
