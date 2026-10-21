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

## The proofs

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
