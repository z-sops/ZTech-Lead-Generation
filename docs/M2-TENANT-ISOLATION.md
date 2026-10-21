# M2 — secure multi-tenant database isolation

**A customer in workspace A must never be able to read, modify, delete,
reference or control workspace B's records — even when the application's
workspace filters are missing or wrong.**

This milestone makes that a property of the **database**, not of the
application. The row-level security policies are the isolation; the
application's filters are a convenience on top of them.

| | |
|---|---|
| **The migration** | `packages/lead-intelligence-postgres/src/migrations/014_tenant_isolation.sql` |
| **The roles** | `packages/lead-intelligence-postgres/src/roles.sql` |
| **The startup assertion** | `packages/lead-intelligence-postgres/src/assertRoles.js` |
| **The denial suite** | `tests/persistence-contract/denial.test.js` |
| **The role suite** | `tests/persistence-contract/roles.test.js` |
| **The concurrency suite** | `tests/persistence-contract/concurrency.test.js` |
| **The multi-workspace suite** | `tests/persistence-contract/multi-workspace.test.js` |

---

## The three parts

### 1. The workspace context

The context is a transaction-local setting, `app.workspace_id`, and it is set
by the **server**, from the authenticated session — never from the request.

```sql
SELECT li.set_workspace('11111111-1111-4111-8111-111111111111');
```

`li.set_workspace()` is `SECURITY DEFINER` (the runtime role may not read the
grants table) and it checks that the **calling role** is entitled to the
workspace:

```sql
SELECT EXISTS (SELECT 1 FROM li.workspace_grants g
                WHERE g.role_name = session_user AND g.workspace_id = p_workspace)
```

So a caller that passes somebody else's workspace id gets an error and **no
context**: the request can never choose the security context. The setting is
`SET LOCAL`, so it disappears at COMMIT or ROLLBACK and a pooled connection
can never carry one tenant's context into another tenant's work.

`li.current_workspace()` returns the context, or **NULL** when there is none
or when it is not a uuid. NULL matches no row and allows no write, so a
missing, invalid or mismatched context **fails closed**.

### 2. The policies

Every tenant-owned table has row-level security **ENABLED and FORCED**, with
one policy:

```sql
CREATE POLICY tenant_isolation ON li.<table>
  USING      (workspace_id = li.current_workspace())
  WITH CHECK (workspace_id = li.current_workspace());
```

`FORCE` matters: without it the table **owner** would still see every
tenant's rows.

The **28 tenant-owned tables**: `li_research_jobs`, `li_evidence_packets`,
`li_research_changes`, `li_saved_searches`, `li_segments`,
`li_segment_members`, `li_pitch_drafts`, `li_outreach_approvals`,
`li_outreach_activity`, `li_outreach_sends`, `li_enrichment_jobs`,
`li_enrichment_observations`, `li_oi_associations`, `li_oi_refresh_requests`,
`li_suppressions`, `li_contact_consents`, `li_contact_provenance`,
`li_trust_events`, `li_recipient_refs`, `li_mailboxes`, `li_mailbox_sent`,
`li_reply_reviews`, `li_sequences`, `li_sequence_steps`, `li_sequence_events`,
`li_sequence_gaps`, `li_sequence_control`, `li_reply_routes`.

The **2 global tables**: `li_schema_migrations` (the ledger) and
`li_market_rules` (the platform's reference data). They carry no workspace
and are not isolated — the privileges are what separate them.

`li_suppressions` has **two** policies: the tenant's own rows, and the
platform's global rows. A tenant sees neither the platform's rows nor another
tenant's.

### 3. The relationships

The foreign keys are **workspace-aware**, so a row may only point at a record
of the same workspace:

```sql
FOREIGN KEY (workspace_id, sequence_id)  REFERENCES li_sequences (workspace_id, sequence_id)
FOREIGN KEY (workspace_id, pitch_id)     REFERENCES li_pitch_drafts (workspace_id, pitch_id)
```

The business identifiers are unchanged: the composite key is
`(workspace_id, <id>)` and the id keeps its format. A tenant can therefore
neither **reference** another tenant's record nor **collide** with it.

The legacy schema has no foreign keys at all (deliberately — the existing
ZTech tables' keys are not known to this module), and M2 adds none beyond the
two above, whose targets are owned by this schema.

---

## The roles

| Role | Owns the tables | Superuser | BYPASSRLS | May write the platform data |
|---|---|---|---|---|
| `ztech_migrator` | **yes** | no | yes (the trusted role) | yes |
| `ztech_app` | no | no | **no** | no |
| `ztech_worker` | no | no | **no** | no |
| `ztech_platform` | no | no | **no** | **yes** |

The runtime roles may read and write the tenant tables, set the workspace
context for the workspaces they are granted, and read the market rules. They
may not create tables, own them, bypass the policies, read the grants table,
or write the platform's rows.

`PUBLIC` holds **no** privileges: not on the schema, not on the tables, not
on the functions. The market rules are `SELECT` for a tenant and
`SELECT/INSERT/UPDATE/DELETE` for the platform.

## The startup assertion

Before the service serves anything, `assertRuntimeRoles()` checks the **live
database**:

1. the runtime role is not a superuser, has no `BYPASSRLS`, and cannot create
   roles or databases;
2. it does **not** own any tenant table;
3. every tenant table has row-level security ENABLED **and** FORCED;
4. every tenant table has the isolation policy, and no restrictive policy;
5. the tenant-table **inventory** matches — a table that was added and not
   protected is caught, and so is one that was protected and dropped;
6. `PUBLIC` holds no privileges on the schema, the tables or the functions;
7. the market rules are read-only for the tenant role;
8. the grants table is unreadable by the runtime role.

The test proves the assertion is real by showing it **failing** for a
privileged role.

## The denial suite

`tests/persistence-contract/denial.test.js` runs raw SQL as the **runtime
role** — not the owner, not a superuser — so the only thing that stops it is
the database. It proves:

- `SELECT` of another tenant's row returns nothing, and the row is not
  counted by an aggregate;
- `INSERT` into another tenant's workspace is refused;
- `UPDATE` and `DELETE` of another tenant's row change nothing;
- an `UPSERT` (`ON CONFLICT DO UPDATE`) into another tenant is refused;
- a `JOIN` cannot bring the other tenant's row into the result;
- an aggregate cannot derive a value from the other tenant;
- two tenants may hold the **same** primary key, request key, lead id,
  idempotency key, sequence, trust event, reply review, stored message id and
  mailbox address without blocking each other;
- a tenant may not **reference** another tenant's record;
- a **missing** context sees nothing and writes nothing;
- an **invalid** context fails closed;
- a **mismatched** context (context A, writing workspace B) is refused;
- the context does **not** survive the transaction, so a pooled connection
  cannot leak it.

## The global suppression, and the platform data

A platform-global suppression is the platform's own record of a contact. A
tenant may be **blocked** by it — that is its purpose — but it may never
**see** it:

- the tenant's `suppressions.add({scope:'global'})` is refused by the
  application (`FORBIDDEN`) **and** by the database (the row-level policy);
- the tenant's `suppressions.find` and `list` return only the tenant's own
  rows — the global rows are invisible, so there is nothing to redact;
- the question "is this address suppressed, here or globally?" is answered by
  the authorized function `li.is_suppressed(channel, address)`, which returns a
  **boolean** and never a row.

The market rules are platform data: a tenant **reads** them (they decide what
is permitted) and may not write them — the application refuses, and the
database refuses.

## The SECURITY DEFINER functions

Three functions are `SECURITY DEFINER`, because the runtime role may not do
what they do:

| Function | Why it is a definer | How it is restricted |
|---|---|---|
| `li.set_workspace(uuid)` | it reads the grants table, which the runtime role may not read | it only writes a transaction-local setting, and only for a workspace the **calling role** is granted; `EXECUTE` revoked from PUBLIC |
| `li.is_suppressed(text, text)` | it must see the platform's rows to answer the question | it returns a **boolean**; `EXECUTE` revoked from PUBLIC; the `search_path` is pinned |
| `li.current_workspace()` | — it is a plain `STABLE` function, not a definer | `EXECUTE` revoked from PUBLIC |

Every one of them pins its `search_path` (`pg_catalog, li`), so nothing in it
can be redirected through a caller's schema, and none of them can be
executed by `PUBLIC`.

---

## What is NOT done here

- **Authentication and sessions** are M3: this milestone proves that the
  DATABASE isolates the tenants, not that the service knows which tenant the
  caller is.
- **The durable job queue and the invocation ledger** are M4.
- **The break-glass path** (the platform console reaching a tenant's data)
  is M6, and it is deliberately not built here: the platform role cannot
  read the tenant tables at all, which is the safe default.
- **The cross-tenant denial suite for the service's own HTTP surface** (the
  API's authorisation) is M3's work; what is proved here is the database
  below it.

The workspace context is set by the server from the authenticated session.
**This milestone makes the database's answer to that context safe; it does
not yet decide who the caller is.** That is the next milestone, and the two
belong together: the server must not be able to set a context it has not
authenticated.
