# M3 — security handoff: authentication, organizations and roles

M2 made the **database** safe: a session cannot choose its tenant, a token
is bound to a workspace, a role and a lifetime, and the control plane is the
only issuer. What M2 deliberately did **not** do is decide **who the caller
is**.

This is the handoff. M3 binds an authenticated human, an organization, a
membership and a workspace together, and the rules below are the ones the
M2 architecture makes necessary. They are not aspirations: each of them
closes a hole that the M2 design would otherwise leave open.

---

## 1. The token is minted from the session, never from the request

**A workspace token is never minted from a client-provided workspace id.**

The API receives a request. The request says which *resource* it wants. The
request does **not** say which *tenant* it is. The tenant comes from the
authenticated session, and the workspace comes from the **membership** of
the authenticated user in the authenticated organization.

```
request  ->  session (who)  ->  membership (which tenant)  ->  token (for that tenant)
```

A client that asks for another tenant's data must be answered with
`403` — not with a token for that tenant, and not with a token for the
caller's own tenant either if the request's workspace does not match the
membership.

**Rule.** `issue_workspace_token(workspace, role, ttl)` is called by the
control plane with a workspace that has already been resolved from the
membership table. The API never passes a workspace straight from a request
parameter to the control plane, and it never asks the control plane for a
token "for whatever the client said".

## 2. The control plane is not reachable from a browser

**The control-plane credential and the token-minting call are server-side
only.**

- The credential lives in the server's secret store. It is never in a
  bundle, never in a page, never in a response body, and never in a log.
- The minting call is made by the server, over the private network, to the
  database. It is not an HTTP endpoint. There is no route in the API that
  mints a token.
- A browser talks to the API, never to the database and never to the
  control plane.
- The API's own credential is the **runtime** role (`ztech_app`), which
  cannot mint a token at all: `li.issue_workspace_token()` is not executable
  by it. Minting goes through the control-plane role, from the server's
  control path.

**Rule.** A user-facing request can never cause a token to be minted for a
workspace the server has not resolved from the membership table.

## 3. A token is not shared between sessions

**Avoid sharing reusable workspace tokens across independent user sessions.**

A workspace token is bound to a *role*, and a role is shared by every
session of that service. Two users in the same organization would therefore
share a token — and a token is a bearer credential, so a leak would be a
leak to both.

M3 issues a **session-bound** token: the payload carries the session
identifier, and the database checks it. The `li.issue_workspace_token()`
function gains a session argument, and `li.set_workspace()` refuses a token
whose session is not the caller's.

**Rule.** Two independent user sessions never hold the same token, and a
token that is presented in a session it was not issued for is refused.

### 3a. The grant is per role; M3 needs it per session

**This is the sharpest thing M3 has to get right.**

Today the database grant is `li.workspace_grants (role_name, workspace_id)`:
it says *this PostgreSQL role may act for this workspace*. Every end user
of the service shares the role `ztech_app`. So a grant is **per service
role, not per end user**, and that has two consequences that M3 must
resolve:

- **Removing one user's membership must not remove access for every other
  legitimate user who shares `ztech_app`.** Withdrawing the
  `(ztech_app, workspace)` grant would lock out *every* user of that
  workspace at once. That is not a revocation, it is an outage.
- **Removing one user's membership must not leave that user's session
  authorized.** Leaving the grant in place, because other users still need
  it, leaves the removed user's session working — with the same token
  shape, on the same role, in the same workspace.

The resolution is to make the **session** the unit of the grant, not the
role:

```
li.workspace_grants (role_name, workspace_id)          -- the service's ceiling
li.session_grants   (session_id, workspace_id, user_id) -- the user's entitlement
```

- the **role's** grant stays the **ceiling**: a session may never reach a
  workspace the role is not granted;
- the **session's** grant is the **entitlement**: it names the user, and it
  is withdrawn when the membership ends;
- the token carries the **session**, and `li.current_workspace()` re-checks
  the session's entitlement on every read — the same way it re-checks the
  role's grant today, which is what makes a withdrawal take effect at once.

**Rule.** The database can tell one user's session from another's, so a
membership is revoked for **that user** and for **that user only**.

### 3b. The proofs M3 must produce, against the real authentication system

Not against a mock, and not against the database alone — against the
**authentication system** that M3 itself builds:

| Proof | What it must show |
|---|---|
| **Logout** | the session's entitlement is withdrawn, the token is refused, and the context it opened stops working — at once, not at the next token |
| **Membership removal** | the removed user's session loses access, and **every other legitimate user of the same workspace keeps it** |
| **Role change** | the old role's access ends and the new one begins, in the same session, without a window in which both or neither holds |
| **Concurrent user sessions** | two users in one workspace, in two sessions, with two tokens, do not interfere: neither sees the other's, and neither can present the other's token |
| **Invitation permissions** | a user who has been invited but has not accepted holds **no** access; accepting it grants exactly the invited workspace, and no more |
| **Cross-workspace HTTP denial** | a request for another workspace's resource over the real API is refused with `403`, and no token is minted for it |

**Rule.** Each of these is proved by a test that runs against the real
authentication system, and the M2 suites stay green underneath them.

## 4. Access ends when it should

**Revoke access promptly on logout, on membership removal, and on a role
change.**

Three events must take effect immediately, not at the next token refresh:

| Event | What must happen |
|---|---|
| **Logout** | the session is ended, its token is revoked, and the context it opened is closed |
| **Membership removal** | the user's grant in `li.workspace_grants` is withdrawn, so `li.current_workspace()` returns NULL for them from that moment — the re-check at read time is what makes this immediate |
| **Role change** | the same: the grant is withdrawn, and the new role's grants are added; a session that has not re-authenticated keeps neither |

The re-check of the grant inside `li.current_workspace()` is already in
place — it is why a withdrawal takes effect at once, and not at the next
token. M3 must use it rather than relying on token expiry.

**Rule.** No access outlives the permission that justified it, and the
mechanism for that is the grant, not the clock.

## 5. The suppression check is rate-limited and authorized

**Rate-limit and authorize the global suppression checks, so that they
cannot be used to enumerate addresses.**

`li.is_suppressed(channel, address)` answers a yes-or-no question about an
address. That is a privacy-preserving shape, but it is still an oracle: an
attacker who can ask about many addresses can learn which of them are
suppressed, and the global rows are the platform's own record of contacts
that asked to be left alone.

M3 must therefore:

- **authorize** the call: only a session that may act for the workspace may
  ask about an address in it;
- **rate-limit** it per session, per organization and per address;
- **not** expose it as an unauthenticated endpoint;
- **not** let a client enumerate the global rows by any other path — the
  database already refuses that, and the denial suite proves it.

**Rule.** The suppression oracle is behind the same authentication and
authorization as the rest of the API, and behind a rate limit.

## 6. The privileged credentials stay out of the runtime

**Keep the migration and BYPASSRLS credentials out of all runtime
services.**

| Credential | Who holds it | Never in |
|---|---|---|
| `ztech_migrator` (BYPASSRLS, owns the schema) | the migration job only | the API, the worker, the platform console, a browser, a CI job that is not the migration |
| `ztech_control` (issues tokens) | the server's control path | a browser, the worker, the platform console |
| `ztech_app`, `ztech_worker` | their own services | a browser, each other |
| `ztech_platform` | the platform console service | the API, the worker |

The runtime roles have no BYPASSRLS, own nothing, and cannot issue a token.
That is M2's work, and it is only true if the *credentials* are also kept
where they belong.

**Rule.** A service's credential is the least privileged one it needs, and
the privileged ones are not in its environment.

## 7. The credentials themselves

M2 removed the default passwords, and M3 inherits that:

- every LOGIN role's credential comes from the deployment's secret store;
- a role with no credential stays **NOLOGIN** — closed, not open;
- `scripts/provision-postgres.js` fails closed if a credential is missing or
  malformed, and it verifies the real role properties afterwards;
- `scripts/rotate-postgres-role.js` rotates a credential safely, and proves
  that the old one no longer works;
- no credential is ever printed, logged, or committed.

---

## What M3 must not break

The M2 guarantees are proved by tests. M3 must keep them green:

- the **forgery suite** — a forged context changes nothing, and a role
  granted many workspaces reaches only the one it holds a token for;
- the **denial suite** — cross-tenant reads and writes are refused;
- the **token-lifetime suite** — a context does not outlive its token, and
  a long-running transaction loses its access;
- the **credentials suite** — no default password, and the provisioning
  fails closed;
- the **production-roles suite** — the ownership and the effective
  privileges are the production ones.

A change to the token, the context or the roles is a change to the
**security boundary**, and it needs the same evidence M2 gave.
