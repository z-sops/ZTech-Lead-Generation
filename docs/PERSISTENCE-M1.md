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

## The workspace identifier

**`workspace_id` is a UUID**, as the F2 architecture requires (§4.1: *"Every
tenant-owned table has `workspace_id uuid not null` and a leading index on
it"*).

| | |
|---|---|
| **The cloud (PostgreSQL)** | `workspace_id UUID NOT NULL`, and it is the **leading column of every primary key** and of every index. The store refuses to be constructed with a workspace that is not a UUID. |
| **The desktop (sql.js)** | unchanged. Its database is a single local install, its column stays `TEXT`, its value stays `local`, and **its data and its schema are untouched** — the thirteen desktop migrations are still byte-identical to the F0/F1 baseline. |
| **The reserved platform** | `00000000-0000-0000-0000-000000000000` is the platform's workspace. A global suppression belongs to it, so a global row is never NULL-scoped. Only the `platform` role may use it. |

The business identifiers keep their existing formats (`pkt_`, `mbx_`, `seq_`,
`li_`…), as F2 §4.1 requires. Only the *scoping* column changed its type.

## The tenant-safe keys

A key that is not scoped by the workspace lets one customer's row block
another customer's row, and lets a lookup cross the boundary. So:

| | The desktop | PostgreSQL |
|---|---|---|
| **The primary key** | the id alone | `(workspace_id, id)` |
| **One active research job per request key** | `(request_key)` | `(workspace_id, request_key)` |
| **One active enrichment job per lead** | `(lead_id)` | `(workspace_id, lead_id)` |
| **One pending OI refresh intent per lead** | `(lead_id)` | `(workspace_id, lead_id)` |
| **One accepted send per (channel, idempotency key)** | `(channel, idempotency_key)` | `(workspace_id, channel, idempotency_key)` |
| **One trust event per event id** | `(event_id)` | `(workspace_id, event_id)` |
| **One reply review per event** | `(event_id)` | `(workspace_id, event_id)` |
| **One open sequence per lead** | `(lead_id)` | `(workspace_id, lead_id)` |
| **One sequence per first email** | `(first_send_id)` | `(workspace_id, first_send_id)` |
| **One pitch per step** | `(pitch_id)` | `(workspace_id, pitch_id)` |
| **One mailbox per address** | `(provider, email_address)` | `(workspace_id, provider, email_address)` |
| **One stored message id per mailbox** | `(mailbox_id, stored_message_id)` | `(workspace_id, mailbox_id, stored_message_id)` |

Every index **leads with the workspace**, as F2 §4.1 requires. The mapping
test proves it, from the migration files, on every run.

**Foreign keys:** the legacy schema has none — deliberately, because the
existing ZTech tables' keys are not known to this module. M1 adds none
either. The workspace-aware composite foreign keys the F2 plan calls for
(§4.8) belong to M2, with the tenancy proof.

## The global tables, and who may write them

| Table | Scope | Who may write it |
|---|---|---|
| `li_schema_migrations` | global | the migration role |
| `li_market_rules` | global — a market rule is the same in every workspace | **the platform only.** A tenant store's `marketRules.set` throws `FORBIDDEN`; a tenant may READ the rules, because they decide what is permitted. |
| `li_sequence_control` | **workspace-scoped** | the tenant, for its own workspace. One customer's "pause all follow-ups" must not pause another customer's sequences, so the switch is keyed `(workspace_id, id)`. |
| `li_suppressions` | the tenant's own rows, plus the platform's global rows | the tenant for its own rows; the platform for the global ones. |

### The global suppression, and the contact information it holds

A global suppression is a record of a contact. A tenant may be **blocked** by
it — that is its whole purpose — but it must never be **shown** one:

- `suppressions.find` returns the tenant's own row in full, and a global row
  **redacted**: the address is removed, the reason is kept, because the
  caller needs to know *why* the address is blocked;
- `suppressions.list` and `listForAddress` return the tenant's own rows only
  — a global row is never listed;
- `suppressions.isSuppressed` answers the yes-or-no question without
  returning any row at all.

The desktop is a single install, so a "global" row there belongs to the same
operator and is returned in full. That is not a difference in the rule, it is
a difference in what "global" can mean when there is only one workspace.

## The transactions

The transaction's client used to be a field on the store. That is shared
state: two transactions running at the same time could pick up each other's
client. It is now held in an **AsyncLocalStorage** context, so it belongs to
the operation that opened the transaction and to nothing else.

- **A nested transaction joins the outer one** through a `SAVEPOINT`.
  PostgreSQL has no nested transactions, and a nested one that opened its own
  connection would deadlock against the outer transaction's locks. A failure
  inside the nested transaction rolls back to its savepoint only; the outer
  transaction decides what happens next.
- **An operation outside a transaction** uses the pool, never a
  transaction's client.

The concurrency tests prove all of it against a real PostgreSQL 16:
simultaneous transactions on different connections, isolation between them,
rollback isolation, the pool, savepoints, and that the pool is still usable
after a failed transaction.

## What the multi-workspace tests prove

`tests/persistence-contract/multi-workspace.test.js` runs two workspaces
against one PostgreSQL 16 and proves that they can hold the **same** request
key, lead id, job id, packet id, idempotency key, sequence, trust event,
reply review, stored message id and mailbox address **without blocking each
other**, and that neither can read or write the other's rows.

**These are structural proofs, not security proofs.** They show that the
schema and the store's scoping are tenant-safe. They do NOT show that a
customer cannot reach another customer's data by any other route: row-level
security, the role ladder, the `SECURITY DEFINER` grants, the startup role
assertion and the cross-tenant denial suite are **M2**, and nothing in this
branch may be read as a claim that they exist.

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
| `workspace_id` | the tenant column: a **UUID**, and the leading column of every key and index. See *The workspace identifier* above. |
| `seq` | the insertion order, on the seven tables the desktop orders by `rowid`. |

Two tables are **global** and carry no workspace: `li_schema_migrations`
(the ledger) and `li_market_rules` (a market rule is the same in every
workspace, and only the platform may write it). `li_sequence_control` is
**workspace-scoped**. See *The global tables* above.

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
