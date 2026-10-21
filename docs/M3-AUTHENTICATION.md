# M3 — authentication, organizations, memberships and role-based authorization

**A tenant boundary is not a database role.** M2 made the database refuse a
cross-tenant read; it could not tell two customers of the same service
apart, because they shared the role `ztech_app`. M3 makes the boundary an
**authenticated user**, an **organization**, a **membership** and a
**session** — and the database enforces it.

| | |
|---|---|
| **The package** | `packages/lead-intelligence-api` |
| **The identity schema** | `packages/lead-intelligence-postgres/src/migrations/015_identity_and_sessions.sql` (the `id` schema) |
| **The API suite** | `tests/api/http.test.js` — real HTTP, real PostgreSQL 16, real roles |
| **The M2 handoff** | `docs/M3-SECURITY-HANDOFF.md` — the rules M3 inherits |

---

## The architecture

```
browser ──cookie──▶ API ──▶ the identity service ──▶ the `id` schema
                        │                              (users, sessions, orgs,
                        │                               memberships, invitations)
                        │                              (the service's own role:
                        │                               ztech_identity)
                        └──▶ the store ──▶ the `li` schema
                                     (the tenant tables; the runtime role:
                                      ztech_app; the row-level security)
```

Three roles, three jobs:

| Role | May | May not |
|---|---|---|
| `ztech_identity` | read and write the identity tables; issue and grant the workspace tokens | read a single tenant row; bypass the policies |
| `ztech_app` | read and write the tenant tables, with a context | issue a token; read the identity tables; bypass the policies |
| `ztech_control` | issue a workspace token | anything else at all |

## The tables (the `id` schema)

| Table | What it holds |
|---|---|
| `id.users` | the people: the email, and a **scrypt** verifier of the password |
| `id.organizations` | the customer companies |
| `id.workspaces` | the workspaces; a workspace **is** a tenant, and its id is the `workspace_id` every tenant table is keyed by |
| `id.workspace_memberships` | a user's membership of a workspace, with the **role** they hold there and the **team** that scopes what they may see |
| `id.sessions` | the sessions: the token is **never** stored, only its SHA-256, and the CSRF token's hash |
| `id.invitations` | the invitations, with the role they grant, their expiry, and who invited |
| `id.authorization_audit` | every authorization decision: who, in which workspace, and allow or deny |

## The session-bound token

The M2 token was bound to a **workspace** and a **role**. It is now bound to
**four** things — the workspace, the role, the **session** and the **user** —
and to a lifetime.

```
li.issue_workspace_token(workspace, role, session, user, ttl)
```

The database checks, at issue time and again at every read:

- the **session** is alive, is not revoked, has not expired, and belongs to
  that user;
- the **user** is a member of that workspace, and the membership has not been
  withdrawn;
- the **role** is granted the workspace — the ceiling;
- the token has not expired.

`li.current_workspace()` re-checks the session and the membership on **every
read**, so a revocation or a membership change takes effect against a
transaction that is **already open**. The suite proves it: a transaction
that is open while the membership is withdrawn loses its access at the next
statement.

## The five roles and the permission matrix

| Permission | owner | admin | manager | member | viewer |
|---|---|---|---|---|---|
| `workspace.read` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `workspace.write` | ✓ | ✓ | ✓ | ✓ | |
| `workspace.create` | ✓ | ✓ | | | |
| `workspace.delete` | ✓ | | | | |
| `member.read` | ✓ | ✓ | ✓ | | |
| `member.invite` | ✓ | ✓ | ✓ | | |
| `member.remove` | ✓ | ✓ | | | |
| `member.role` | ✓ | ✓ | | | |
| `settings.write` | ✓ | ✓ | | | |
| `audit.read` | ✓ | ✓ | ✓ | | |
| `suppression.check` | ✓ | ✓ | ✓ | ✓ | ✓ |

The matrix is in **one place** (`packages/lead-intelligence-api/src/security.js`)
and the API's authorization, the audit's reason and the tests all read it.

**The role is per workspace.** An owner in workspace A is a viewer in
workspace B, and stays a viewer there. **The team** on a membership narrows
what that member may see of the workspace's identities.

**The ownership protection:** only an owner may remove an owner or change
an owner's role, and a workspace always keeps at least one owner.

## The endpoints

| Method | Path | Who |
|---|---|---|
| `POST` | `/api/auth/register` | anybody: the user, the organization, the first workspace and the owner's membership |
| `POST` | `/api/auth/login` | anybody, throttled |
| `POST` | `/api/auth/logout` | the session, with the CSRF token |
| `GET` | `/api/session` | the session: the user and the memberships |
| `POST` | `/api/organizations` | the session |
| `POST` | `/api/organizations/:orgId/workspaces` | an owner or an admin of that organization |
| `POST` | `/api/workspaces/:workspaceId/invitations` | `member.invite` |
| `POST` | `/api/invitations/accept` | the invited address |
| `GET` | `/api/workspaces/:workspaceId/members` | `member.read` |
| `DELETE` | `/api/workspaces/:workspaceId/members/:userId` | `member.remove` |
| `PATCH` | `/api/workspaces/:workspaceId/members/:userId` | `member.role` |
| `GET` | `/api/workspaces/:workspaceId/records` | `workspace.read` |
| `POST` | `/api/workspaces/:workspaceId/suppressions/check` | `suppression.check`, rate-limited |

## The session's own security

- The session is a **cookie**: `HttpOnly`, `SameSite=Strict`, `Path=/`, and
  `Secure` in production. The token is **never** in a response body.
- Every state-changing request must carry the **CSRF token** the session was
  issued, in the `X-CSRF-Token` header, compared in constant time.
- The **password** is a scrypt verifier with a random salt; the parameters
  are in the stored string, so a verifier can be checked and re-hashed later.
- The **login is throttled**: five failures for an address, then a refusal.
- The **suppression check is throttled** and authorized, and it answers with
  a **boolean** — never an address, never a row.
- **Nothing from the database** — no credential, no workspace token — is ever
  returned to the browser.

## The corrections the security review required

### Nobody grants a role above their own authority

The roles are ordered, and the first is the strongest. A grant may not be
stronger than the one the inviter holds, on **every** path:

- an **invitation** may not name a role above the inviter's — so a manager
  or an admin cannot invite themselves as an owner, and the invitation is
  refused before it is written;
- a **role change** may not name a role above the actor's;
- only an **owner** may grant the owner role, because the owner is above
  everybody else.

### An invitation is not a role change

An invitation may not **upgrade** an existing membership: accepting one
when the user is already a member is refused (`already_a_member`), and the
membership is untouched. A role change goes through the role-change path,
with its own authority checks, its own last-owner protection and its own
audit.

### The invitation's authority is revalidated

The inviter may have been removed, or demoted, since the invitation was
written. So when the invitation is **accepted**, the grant it names is
checked against the inviter's **current** role — and against the
last-owner protection. An invitation written by somebody who has since
been demoted no longer grants what it says.

### The last owner, on every path

A workspace always keeps at least one owner: on a removal, on a role
change, and on an acceptance. Two owners removed at the same time cannot
leave a workspace without one, because the membership rows are **locked**
for the duration of the decision.

### The transactions are on one connection

A PostgreSQL transaction belongs to **one connection**: the BEGIN, the
statements and the COMMIT must all run on the connection that was acquired
for it. A pool hands out a different connection for every query, so a
transaction spread over the pool is not a transaction at all.

Every multi-step identity mutation — the registration, the invitation
acceptance, the removal, the role change — runs through one helper that
acquires a client, runs everything on it, and always gives it back: on
success, on failure, and on a rollback that failed too.

The consequences are proved: a registration that fails after its first
INSERT leaves **no** organization, **no** workspace and **no** membership;
an invitation's membership and its consumption are committed **together**,
with the invitation row locked, so two simultaneous acceptances cannot both
take it; and concurrent registrations all land, none of them half-written.

### The suppression check runs in the session's context

The check is a query, and a query needs a context: the session's, bound to
the session and the user, with the entitlement re-checked by the database
on every read. A logout, a withdrawn membership or a revoked session
therefore stops the check — and the answer is a **boolean**, never an
address and never a row.

### The control plane may only issue tokens

The workspace ceiling is the identity service's business. The control
plane may issue a token and **nothing else** — it may not grant a
workspace, and the privilege is not in its hands.

### The login throttle keys on the connection

The throttle's key is the **connection's** address and the email address
together: a failure from one place must not lock out the same person from
another. The address is the socket's, **not** a header's: a proxy header
is written by the client, so believing it would let an attacker spread a
spray over a thousand fake addresses. Behind a proxy the deployment says
how many proxies it trusts (`trustedProxyHops`); with the default of zero,
no header is believed at all.

**The throttle is in memory.** With more than one service instance the
counter must be shared — a deployment requirement, recorded as RG-8.

### What a workspace token is, and is not

**The token is a bearer credential, and the database cannot tell a copy
from the original.** Every connection of `ztech_app` is the same
principal, so a token copied to another connection under that role **will**
open a context there. The suite proves exactly that, rather than claiming
a binding that does not exist.

What prevents the abuse is the **server**: the token is minted
server-side, for the session the server has authenticated, it stays in the
server's memory, and the API **never accepts one from a client** — a
client-supplied token is ignored and the session's own context is used.

And the entitlement is still the database's: a token for a session that
has been revoked, or for a membership that has been withdrawn, is refused
**wherever** it is presented. So a leaked token is a credential, and it
lives for the lifetime of the session it was minted for — five minutes at
most, by default.

| | |
|---|---|
| **The database is the boundary for** | the entitlement: who may act for which workspace, and whether that is still true |
| **The server is the boundary for** | the token: it is minted, kept and used server-side, and never accepted from a client |



`tests/api/http.test.js` — 18 tests, over real HTTP, against a real
PostgreSQL 16, with the real roles:

- a user cannot reach another organization's records, and the record does not
  leak;
- an owner in A is a viewer in B, and stays one;
- a logout ends the access;
- removing a membership revokes **that user** and nobody else, even though
  they share the database role;
- a role change is enforced immediately;
- one session cannot use another session's reach;
- an invitation cannot be used twice, cannot be accepted by the wrong
  address, and grants exactly the role it names;
- the last owner cannot be removed, and an owner is protected;
- the suppression check is authenticated, authorized and rate-limited;
- a membership withdrawn mid-transaction kills the open transaction;
- thirty concurrent requests across two sessions keep the isolation;
- every decision, allow or deny, is audited.
