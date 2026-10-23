# ZuniTech brand and product identity

**Status:** approved at the F0/F1 review, 2026-10-20.

---

## 1. The identity hierarchy

Three names, three jobs. They are never used interchangeably.

| Name | Role | Where it appears |
|---|---|---|
| **Zuni Enterprise** | The parent company | The legal documents, the README's identity table |
| **ZuniTech** | The technology brand | The product mark, the window chrome, the legal documents |
| **ZTech Lead Generation** | The product | The window title, the package metadata, the READMEs, the legal documents |

> **The registered entity name, registration number and registered address are
> NOT confirmed and are NOT stated anywhere.** The legal documents carry a
> clearly flagged placeholder, and `ztech-legal/scripts/check-legal.js` fails
> if that placeholder is removed. Nothing about a registration is ever
> invented.

### What the product is not

- It is not "Zunitech" (lowercase t). That spelling was in the legal documents
  until F1 and is now corrected everywhere.
- It is not "phone全球获客", `phone-global-leads` or `com.whatsapp.automation`.
  Those were the product's previous identifiers. They survive **only** where
  they are needed to find an existing installation's data — see §5.

---

## 2. The mark

`src/renderer/brand/zunitech-mark.svg` — a rounded square in the brand
gradient with a white "Z" knocked out of it.

The PNG icons (`icon-64/128/256/512.png`) and the Windows icon
(`build/icon.ico`) are **generated**, not hand-drawn, so they are reproducible
and identical at every size:

```bash
npm run build:brand
```

`scripts/build-brand-assets.js` is the generator. It contains the geometry
(rounded-square radius, the two bars, the diagonal) and a minimal PNG and ICO
encoder, so no image toolchain is needed.

---

## 3. The palette

The single source is `src/renderer/brand/tokens.css`. The twelve legacy
tokens in `styles.css` are **preserved by name** and now derive from the brand
tokens, so the whole application took the brand without a single screen being
redesigned and without a single selector changing.

| Token | Value | Used for |
|---|---|---|
| `--zuni-primary` | `#1f4fd8` | The brand, the primary action |
| `--zuni-primary-hover` | `#1a42b8` | Hover |
| `--zuni-primary-soft` | `#e8eefc` | Selected rows, tinted surfaces |
| `--zuni-ink` | `#10182b` | Primary text |
| `--zuni-ink-soft` | `#5a6478` | Secondary text |
| `--zuni-ink-faint` | `#8b93a7` | Hints, the product line under the mark |
| `--zuni-surface` | `#ffffff` | Cards, inputs |
| `--zuni-canvas` | `#f4f6fa` | The application background |
| `--zuni-canvas-sunken` | `#eceff6` | The sidebar, sunken areas |
| `--zuni-line` | `#dde3ee` | Borders |
| `--zuni-success` | `#0e9f6e` | Success, a healthy provider |
| `--zuni-warning` | `#c97f1a` | Warning, a degraded provider |
| `--zuni-danger` | `#d23b57` | Destructive actions, a failed provider |

Each of those also has a `-soft` companion for tinted backgrounds, so a status
is never carried by colour alone.

**Elevation.** Exactly two shadows, as the product has always had: a raised
card and an overlay. Cards are separated by borders, not by shadows.

**Focus.** Every interactive element gets a visible two-ring focus state
(`--zuni-focus-ring`). Keyboard users must always be able to see where they
are.

---

## 4. Typography

`--zuni-font-sans` is the system stack, with **CJK fallbacks included**:
`"PingFang SC"`, `"Microsoft YaHei"`, `"Noto Sans CJK SC"`. The China-region
functionality the handover requires to be preserved depends on those
fallbacks.

`--zuni-font-mono` is the stack for ids, run slugs and hashes.

**The Chinese text that remains in `src/renderer/renderer.js` is internal
source comments** documenting the China-region phone-number rules. It is not
customer-facing branding, and it is preserved on purpose. Translating it would
also break the frontend tests, which slice the renderer by those comment
markers.

---

## 5. The data directory, and why the old names still exist

On Windows the product keeps everything in one directory:

```
%APPDATA%\ZTech Lead Generation\
  data\         the lead library, the job ledger and the Lead Intelligence tables
  logs\         the application logs
  config.json   the settings and the sealed credentials
```

The old identifiers determined that directory, so the rename would have
pointed the application at an empty folder. The migration is therefore
**copy-and-verify**, and the rules are in `src/main/paths.js`:

1. The old directory is **copied** to a staging directory. The original is
   never touched.
2. The copy is **verified** — every file compared by size and SHA-256.
3. Only a verified copy is moved into place.
4. **The original directory is never deleted.** It stays as the user's
   rollback copy, and the marker file records where it is.
5. If anything fails — a full disk, a locked file, a corrupt database — the
   product **keeps using the original directory**. The user never starts with
   an empty library because a migration went wrong.

That is why the old names still appear in `README.md` and in
`tools/acceptance/reset-email-suppression.js`: to find an installation that
has not been migrated yet. They appear nowhere else.

---

## 6. Rules

1. The product name, the brand and the parent company are used exactly as in
   §1, and never interchangeably.
2. Colours, spacing, radii and type come from the token layer. A raw colour
   in a selector is a review comment, not a style.
3. No new shadow. Two are the whole system.
4. Every interactive element keeps a visible focus state.
5. Nothing customer-facing may name the old product.
6. No registration detail is ever stated until the business confirms it.

---

## 7. What is still open

- **The visual identity is not finished.** The token layer, the mark, the
  app icon and the chrome are in place; the screens themselves have not been
  restyled onto the new palette, because the handover forbids a frontend
  rewrite in this phase. The legacy tokens still drive most selectors, and
  several of them are not brand colours yet.
- **The packaged application has not been smoke-tested.** The branding and
  the data migration are covered by unit tests, not by a real launch of the
  packaged build against an existing installation. That test is required
  before the rebrand ships.
- The application icon is generated for Windows (`.ico`). No macOS or Linux
  package is built yet.
