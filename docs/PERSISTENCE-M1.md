# M1 — the persistence seam and the PostgreSQL schema

**The desktop's sql.js store and the PostgreSQL 16 store are two
implementations of ONE repository seam. The seam is
`@zunitech/lead-intelligence/persistence/interfaces`; the contract suite in
`tests/persistence-contract/` runs the same assertions against both.**

| | |
|---|---|
| **The seam** | `packages/lead-intelligence/src/persistence/interfaces.js` — the repositories, their methods, and the invariants a store must preserve. |
| **The desktop implementation** | `src/main/lead-intelligence/persistence/SqlJsStore.js` — unchanged in behaviour; it now satisfies the seam. |
| **The PostgreSQL implementation** | `packages/lead-intelligence-postgres/` — a separate package, because it needs the `pg` driver and the shared core package has no dependencies at all. |
| **The contract suite** | `tests/persistence-contract/contract-suite.js` — one suite, two backends, identical results. |
| **The column mapping** | this document, checked by `tests/persistence-contract/mapping.test.js`. |
| **The PostgreSQL schema** | `packages/lead-intelligence-postgres/src/migrations/` — thirteen migrations that mirror the desktop's thirteen, one for one. |

---

## The type mapping

| The desktop (SQLite) | The PostgreSQL counterpart | Why |
|---|---|---|
| `TEXT` | `TEXT` | the same. |
| `INTEGER` | `INTEGER` | the same. |
| `INTEGER` (a 0/1 flag) | `BOOLEAN` | a flag is a fact, not a number. The application still sees `0` or `1`, so no caller changes. |
| `TEXT` (an ISO timestamp) | `TIMESTAMPTZ` | a timestamp is an instant, not a string. The application still sees the same ISO string. |
| `TEXT` (a JSON document) | `JSONB` | a document is a document. The application still sees the same object. |
| `TEXT` (a time of day, `HH:MM`) | `TIME` | the sending window is a time, not an instant. The application still sees `HH:MM`. |
| `rowid` (the insertion order) | `seq BIGSERIAL` | "newest first, insertion order for ties" has to mean the same thing on both engines. |

## The additions

| The column | Why |
|---|---|
| `workspace_id` | the tenant column. Every tenant-owned table carries it, so the structure is ready for the row-level security of M2. **M1 proves no isolation**: the filter is application-level, and M2 is what makes it a boundary. |
| `seq` | the insertion order, on the seven tables the desktop orders by `rowid`. |

Three tables are **global** and carry no workspace: `li_schema_migrations`
(the ledger), `li_market_rules` (a market rule is the same in every
workspace) and `li_sequence_control` (the one "Pause all follow-ups" switch).

`li_suppressions` keeps its own `workspace_id`: a suppression with scope
`global` has none and is visible to every workspace, exactly as on the
desktop.

## The table mapping

| The desktop table | The PostgreSQL table | Notes |
|---|---|---|
| `li_schema_migrations` | `li_schema_migrations` | global |
| `li_research_jobs` | `li_research_jobs` | one active job per request key (partial unique index) |
| `li_evidence_packets` | `li_evidence_packets` | the packet document is `JSONB` |
| `li_research_changes` | `li_research_changes` | |
| `li_saved_searches` | `li_saved_searches` | |
| `li_segments` | `li_segments` | |
| `li_segment_members` | `li_segment_members` | |
| `li_pitch_drafts` | `li_pitch_drafts` | the draft document is `JSONB` |
| `li_outreach_approvals` | `li_outreach_approvals` | |
| `li_outreach_activity` | `li_outreach_activity` | the closed activity allowlist is a CHECK |
| `li_outreach_sends` | `li_outreach_sends` | at most one accepted send per (channel, idempotency key) |
| `li_enrichment_jobs` | `li_enrichment_jobs` | one active job per lead (partial unique index) |
| `li_enrichment_observations` | `li_enrichment_observations` | the provenance columns are kept |
| `li_oi_associations` | `li_oi_associations` | |
| `li_oi_refresh_requests` | `li_oi_refresh_requests` | one pending intent per lead (partial unique index) |
| `li_suppressions` | `li_suppressions` | its own `workspace_id`; global rows have none |
| `li_contact_consents` | `li_contact_consents` | |
| `li_contact_provenance` | `li_contact_provenance` | `backfilled` is a BOOLEAN |
| `li_trust_events` | `li_trust_events` | one event per `event_id`, except a rejected one |
| `li_recipient_refs` | `li_recipient_refs` | |
| `li_mailboxes` | `li_mailboxes` | the sending window is a TIME |
| `li_mailbox_sent` | `li_mailbox_sent` | |
| `li_market_rules` | `li_market_rules` | global |
| `li_reply_reviews` | `li_reply_reviews` | |
| `li_sequences` | `li_sequences` | one open sequence per lead (partial unique index) |
| `li_sequence_steps` | `li_sequence_steps` | |
| `li_sequence_events` | `li_sequence_events` | |
| `li_sequence_gaps` | `li_sequence_gaps` | |
| `li_sequence_control` | `li_sequence_control` | global |
| `li_reply_routes` | `li_reply_routes` | |

**Thirty tables, one for one. The mapping test proves it** — against the
migration files, and against a live PostgreSQL when one is available.

---

## What the migration does differently, and why

The desktop's migrations rebuild a table when a CHECK constraint has to
widen, because SQLite cannot alter a constraint. PostgreSQL can: the
constraint is dropped and re-added, so **no row is copied, dropped or
reworded** — the history is preserved exactly.

The partial unique indexes — one active job per request key, one active
enrichment job per lead, one pending OI refresh intent per lead, one
accepted send per key, one trust event per event id, one open sequence per
lead, one reply review per event, one mailbox send per stored message id —
are the same rules, expressed the same way. **The idempotency guarantee is
enforced by the database on both engines, not by application code.**

## The conversions

| | The desktop | PostgreSQL | The rule |
|---|---|---|---|
| a timestamp | the ISO text the caller gave | an instant | a well-formed instant survives unchanged; a value that is not an instant becomes NULL and is **reported**, never guessed at. |
| a JSON document | TEXT | JSONB | a document survives unchanged; a value that is not JSON becomes NULL and is reported. |
| a 0/1 flag | INTEGER | BOOLEAN | the application sees `0` or `1` on both. |
| a time of day | `HH:MM` text | TIME | the application sees `HH:MM` on both. |

## The two deliberate differences

Both are documented, and both are about **how a corruption is made**, not
about what the store does with it.

1. **A corrupt row.** The desktop's JSON column is TEXT, so a corrupted file
   contains broken text; the contract suite writes `'{broken'`. A JSONB
   column cannot hold broken text — that is the point of the type — so the
   PostgreSQL runner writes a document that is valid JSON but is not a
   packet. The **observable behaviour is the same on both**: the row is
   skipped, it is reported in `corruptRows`, and the read never fails.
2. **A malformed timestamp.** The desktop keeps the caller's text and
   compares it as text. PostgreSQL refuses a value that is not an instant, so
   the store checks it first: a malformed timestamp becomes NULL and is
   reported. The desktop's behaviour for the same value is to keep the text.
   The store never guesses, and never stores a wrong instant.

## What M1 does **not** do

- It does not enable row-level security, and it does not prove isolation.
  The `workspace_id` column and the store's filter are **preparation**; the
  RLS policies, the role ladder, the startup role assertion and the
  cross-tenant denial suite are **M2**.
- It does not change the desktop's behaviour. The desktop's store gained a
  public `deleteByLead` on four repositories, an awaited `tx`, and two
  helpers (`run`, `query`) so that one contract test can drive both stores.
  Nothing else changed, and the 1,990 pre-existing assertions still pass.
- It does not change the database schema of the desktop: the thirteen
  migration files are byte-identical to the F0/F1 baseline, and the boundary
  test proves it.
