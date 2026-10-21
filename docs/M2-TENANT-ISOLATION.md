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
| **The provisioning** | `scripts/provision-postgres.js` |
| **The startup assertion** | `packages/lead-intelligence-postgres/src/assertRoles.js` |
| **The denial suite** | `tests/persistence-contract/denial.test.js` |
| **The forgery suite** | `tests/persistence-contract/context-forgery.test.js` |
| **The production-roles suite** | `tests/persistence-contract/production-roles.test.js` |
| **The role suite** | `tests/persistence-contract/roles.test.js` |
| **The concurrency suite** | `tests/persistence-contract/concurrency.test.js` |
| **The multi-workspace suite** | `tests/persistence-contract/multi-workspace.test.js` |

---

## The trust boundary

The database is told which tenant a session is acting for. The question this
milestone answers is **who is allowed to say that, and how is it proved?**

### The mistake that was made, and why it was a breach

The first implementation kept the context in the custom setting
`app.workspace_id`, and the policy compared the row's workspace with
`current_setting('app.workspace_id')`.

A custom setting is ordinary configuration, and **any** role may write one:

```sql
SELECT set_config('app.workspace_id', '<another tenant>', false);
```

So a session authorised for workspace A could write workspace B's id into the
setting, and the policy — which trusted the setting — handed it B's rows. The
policy trusted a value the **caller** controlled. That was a complete
cross-tenant breach: read **and** write. It was reproduced against a real
PostgreSQL 16 before it was fixed.

PostgreSQL 16 cannot close that door by locking the setting down:
`REVOKE SET ON PARAMETER` applies to **known** parameters, and a custom
placeholder is not one. The ACL is recorded and ignored — `ztech_app` could
still `SET` and `set_config` the parameter. **The setting stays writable, and
it must not be trusted.**

### What the context is now

The context does not live in a setting. It lives in a **table the runtime
roles cannot write**, and it is opened with a **token only the control plane
can issue**.

| | |
|---|---|
| **The context** | a row in `li.workspace_context`, which the runtime roles have **no** privilege on — not SELECT, not INSERT, not UPDATE, not DELETE, not TRUNCATE |
| **The proof** | a **workspace token**: HMAC-SHA256, signed with a secret that never leaves the database, bound to the workspace, to the role and to a lifetime |
| **The issuer** | `li.issue_workspace_token()`, which only the **control plane** (`ztech_control`) may execute. A runtime session may *present* a token; it may never *ask* for one |
| **The lifetime** | the context row carries the transaction id, so a context belongs to **one transaction** and to **one role** |

```sql
-- the control plane issues a token for (role, workspace)
SELECT li.issue_workspace_token('11111111-1111-4111-8111-111111111111', 'ztech_app', 300);

-- the runtime session presents it
SELECT li.set_workspace('11111111-1111-4111-8111-111111111111', '<the token>');
```

`li.set_workspace()` checks the signature (in constant time), that the token
is for **this** workspace, that it is for **this** role, that it has not
expired, and that the calling role is granted the workspace. Then it writes
the context row, inside the caller's transaction.

`li.current_workspace()` reads the row back, and returns the workspace only
if the transaction id matches, the role matches, and the grant still holds.
Otherwise it returns **NULL** — and NULL matches no row and allows no write,
so a missing, invalid, expired or mismatched context **fails closed**.

### The grant is a ceiling, not the authority

A role that is granted two workspaces may not reach the second one without a
token for it. **This is what makes the isolation per-customer**, and not
"one role, many tenants": a session authorised for A holds a token for A, and
no amount of SQL in that session can turn it into a session for B. The
forgery suite proves exactly that, with a role that is granted **both**
workspaces.

### Who is trusted

| Principal | Trusted for | Not trusted for |
|---|---|---|
| **The control plane** (`ztech_control`) | issuing a workspace token | reading a row, writing a row, opening a context of its own |
| **The application service** | deciding *which* workspace a request is for | anything the database refuses |
| **The runtime session** | nothing | it may not choose its own tenant |

**The trust boundary runs between the application and the database.** The
application is the authority on *which* tenant a request is for; the database
is the authority on *whether* that claim is well-formed, current, and
effective. M3 binds the authenticated user and session to the application's
side of that line — the server must not be able to set a context it has not
authenticated, and it must ask the control plane for a token rather than
carrying the secret.

---

## The three parts

### 1. The workspace context

As above: a row in a table the runtime roles cannot write, opened with a
token, valid for one transaction and one role.

### 2. The policies

Every tenant-owned table has row-level security **ENABLED and FORCED**, with
one policy:

```sql
CREATE POLICY tenant_isolation ON li.<table>
  USING      (workspace_id = li.current_workspace())
  WITH CHECK (workspace_id = li.current_workspace());
```

`FORCE` matters: without it the table **owner** would still see every
tenant's rows. The policy reads the context from the table, never from a
setting, so a forged setting changes nothing.

**The 28 tenant tables:** `li_research_jobs`, `li_evidence_packets`,
`li_research_changes`, `li_saved_searches`, `li_segments`,
`li_segment_members`, `li_pitch_drafts`, `li_outreach_approvals`,
`li_outreach_activity`, `li_outreach_sends`, `li_enrichment_jobs`,
`li_enrichment_observations`, `li_oi_associations`, `li_oi_refresh_requests`,
`li_suppressions`, `li_contact_consents`, `li_contact_provenance`,
`li_trust_events`, `li_recipient_refs`, `li_mailboxes`, `li_mailbox_sent`,
`li_reply_reviews`, `li_sequences`, `li_sequence_steps`, `li_sequence_events`,
`li_sequence_gaps`, `li_sequence_control`, `li_reply_routes`.

**The global tables:** `li_schema_migrations` and `li_market_rules` — they
carry no workspace, and the privileges are what separate them.

**The security tables** — `workspace_grants`, `workspace_context` and
`control_plane_secret` — are the platform's own, and no runtime role may read
or write them.

### 3. The relationships

The foreign keys are workspace-aware, so a tenant can neither **reference**
nor **collide with** another tenant's record:

```sql
FOREIGN KEY (workspace_id, sequence_id) REFERENCES li_sequences (workspace_id, sequence_id) ON DELETE CASCADE;
FOREIGN KEY (workspace_id, pitch_id)    REFERENCES li_pitch_drafts (workspace_id, pitch_id) ON DELETE CASCADE;
```

The business identifiers are unchanged: the composite key is
`(workspace_id, <id>)` and the id keeps its format.

---

## The roles

| Role | Owns the tables | Superuser | BYPASSRLS | May issue a token | May write the platform data |
|---|---|---|---|---|---|
| `ztech_migrator` | **yes** | no | **yes** (the trusted role) | yes | yes |
| `ztech_control` | no | no | **no** | **yes** | no |
| `ztech_app` | no | no | **no** | no | no |
| `ztech_worker` | no | no | **no** | no | no |
| `ztech_platform` | no | no | **no** | no | **yes** |

The runtime roles may read and write the tenant tables, open a context **with
a token**, and read the market rules. They may not create tables, own them,
bypass the policies, read the security tables, issue a token, or write the
platform's rows.

The **control plane** may do exactly one thing: issue a token. It may not
read a row, write a row, or open a context of its own. It is not a superuser
and it does not bypass the policies.

The **migration role** owns the schema, the tables and the SECURITY DEFINER
functions. It has BYPASSRLS — it is the trusted role, and it never serves a
request. It is not a superuser, and it cannot create roles or databases.

`PUBLIC` holds **no** privileges: not on the schema, not on the tables, not
on the functions. The market rules are `SELECT` for a tenant and
`SELECT/INSERT/UPDATE/DELETE` for the platform.

### The owner matters

A SECURITY DEFINER function runs with the rights of its **owner**, so the
owner is part of the security boundary. All four are owned by
`ztech_migrator`, which is not a superuser. The test harness applies the
migrations **as the migration role** for exactly this reason: a suite that
applied them as the administrator would prove properties that no deployment
has.

## The startup assertion

Before the service serves anything, `assertRuntimeRoles()` checks the **live
database**:

1. the runtime role is not a superuser, has no `BYPASSRLS`, and cannot create
   roles or databases;
2. it does **not** own any tenant table — or any function;
3. every tenant table has row-level security ENABLED **and** FORCED;
4. every tenant table has the isolation policy, and no restrictive policy;
5. the tenant-table **inventory** matches — a table that was added and not
   protected is caught, and so is one that was protected and dropped;
6. `PUBLIC` holds no privileges on the schema, the tables or the functions;
7. the market rules are read-only for the tenant role;
8. the grants table is unreadable by the runtime role;
9. the context and the secret are unreadable and unwritable by the runtime
   role;
10. the runtime role may **not** issue a workspace token;
11. every security function is SECURITY DEFINER, owned by the migration role,
    owned by nobody who is a superuser, and pins its `search_path`;
12. the control plane is not a superuser, does not bypass the policies, is a
    member of no other role, holds no privilege on any table, and may execute
    the token issuer;
13. the migration role is not a superuser.

The test proves the assertion is real by showing it **failing** for a
privileged role.

## The suites

### The denial suite

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

### The forgery suite (C1)

`tests/persistence-contract/context-forgery.test.js` proves the exploit is
closed. It runs as the runtime role, with raw SQL, against a role that is
granted **both** workspaces:

- the setting `app.workspace_id` **can** be written — the test asserts that
  the forgery succeeds at the setting level, so there is no doubt about what
  PostgreSQL does and does not do — and it changes **nothing**: the session
  still sees only its own tenant, and still cannot write the other one;
- a direct `SET`, a `set_config` with a **prepared statement**, and the
  transaction-local form are all equally powerless;
- a reused connection carries no context at all;
- the context table cannot be inserted into, updated, deleted or truncated by
  the runtime role;
- the runtime role may not issue a token;
- a token is bound to its workspace, to its role, and to its lifetime: a
  token for A will not open B, another role's token will not open A, a
  tampered signature is refused, and an expired token is refused;
- a role granted many workspaces reaches only the one it holds a token for.

### The production-roles suite (C2)

`tests/persistence-contract/production-roles.test.js` proves the ownership and
the effective privileges are the production ones:

- every table and every SECURITY DEFINER function is owned by the **migration
  role**, and **no** table is owned by a superuser;
- the real properties of every role: SUPERUSER, BYPASSRLS, CREATEROLE,
  CREATEDB;
- no runtime role owns a table, a sequence or a function;
- the effective privileges: the runtime role may consume (set the context,
  ask the current one, ask about a suppression) and may **not** issue a token
  or read the security tables;
- the control plane may issue a token and may do nothing else;
- `li.is_suppressed()` for a tenant's own address (**true**), for a platform
  global address (**true**), for an address that is not suppressed (**false**)
  and on the wrong channel (**false**);
- the answer is a **boolean** — one column, nothing else;
- a tenant cannot **enumerate** the global suppression rows, and cannot even
  count them;
- the function cannot be used to read or write tenant data: it is STABLE, so
  it cannot write, and the global rows stay invisible through every other
  path.

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

| Function | Why it is a definer | How it is restricted |
|---|---|---|
| `li.set_workspace(uuid, text)` | it reads the secret and writes the context table, which the runtime role may not do | it takes a **token**, and writes a row for **one** transaction and **one** role; `EXECUTE` revoked from PUBLIC |
| `li.current_workspace()` | it reads the context table, which the runtime role may not read | it answers with a uuid or NULL; `EXECUTE` revoked from PUBLIC |
| `li.issue_workspace_token(uuid, text, integer)` | it reads the secret | only the **control plane** may execute it; `EXECUTE` revoked from PUBLIC and from every runtime role |
| `li.is_suppressed(text, text)` | it must see the platform's rows to answer the question | it returns a **boolean**; `EXECUTE` revoked from PUBLIC; the `search_path` is pinned |

Every one of them pins its `search_path` (`pg_catalog, li`), so nothing in it
can be redirected through a caller's schema, and none of them can be
executed by `PUBLIC`. The helpers — `hmac_sha256`, `bytea_xor`,
`constant_time_equals`, `to_hex`, `from_hex` — are `IMMUTABLE`, and no
runtime role may execute them.

---

## What is NOT done here

- **Authentication and sessions** are M3: this milestone proves that the
  DATABASE isolates the tenants and that it will not take a tenant's word for
  it, but it does not decide **who the caller is**. M3 binds the
  authenticated user and session to the application's side of the trust
  boundary, and the application will ask the control plane for a token
  rather than carrying the secret.
- **The durable job queue and the invocation ledger** are M4.
- **The break-glass path** (the platform console reaching a tenant's data)
  is M6, and it is deliberately not built here: the platform role cannot
  read the tenant tables at all, which is the safe default.
- **The cross-tenant denial suite for the service's own HTTP surface** (the
  API's authorisation) is M3's work; what is proved here is the database
  below it.
- **The control plane is a credential in the application's environment.** It
  can issue a token for any workspace the role is granted, so it is worth
  protecting like any other credential. In a larger deployment it becomes a
  separate issuer service; nothing else has to change.
- **The token is bound to the role, not to the connection.** A token that
  leaked could be used by another session of the same role until it expired
  (at most an hour, at most five minutes by default). Binding it to the
  connection would need a round trip to the control plane per transaction.
