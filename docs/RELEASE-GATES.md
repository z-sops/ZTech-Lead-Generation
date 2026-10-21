# Release gates

A gate is a requirement that must be **proved** before a release. A gate is
not a task: it is a condition, and it is closed only by evidence.

| # | Gate | Status | Evidence |
|---|---|---|---|
| RG-1 | The database roles are provisioned with a **supported role-management operation**, never by writing the catalogue directly | **CLOSED** | `scripts/lib/postgres-credentials.js` — `setCredential()` uses `ALTER ROLE ... PASSWORD` with a pre-computed SCRAM verifier; the direct `UPDATE pg_authid` is gone. Proved by `tests/persistence-contract/provisioning.test.js` and `tests/persistence-contract/credentials.test.js` |
| RG-2 | No credential appears in a SQL statement, and no verifier appears in a statement log | **CLOSED** | The verifier is transported as a bind parameter into a server-side `format()`; the session's statement logging is off while the statement runs. Proved by the log test in `provisioning.test.js` and by the source checks in the same suite |
| RG-3 | A credential can be rotated, and the old one stops working | **CLOSED** | `scripts/rotate-postgres-role.js`; proved by the credentials suite |
| RG-4 | A role with no credential cannot be logged into | **CLOSED** | The roles are created NOLOGIN; proved by the credentials suite |
| RG-5 | The provisioning fails closed when a credential is missing or malformed | **CLOSED** | Proved by the credentials suite and by the production provisioning suite |
| RG-6 | The production provisioning path is exercised on every CI run | **CLOSED** | The workflow gives the job an isolated PostgreSQL 16 cluster and runs the provisioning suite as its own required step |
| RG-7 | The **workspace token** is understood for what it is: a bearer credential, with the server as the boundary and the database as the boundary for the entitlement | **CLOSED** | 	ests/api/security.test.js - a copied token opens a context on another connection under the same role (proved, not denied), the API never accepts a token from a client, and a revoked session's token is refused wherever it is presented |
| RG-8 | The **login throttle** is shared across the service instances | **OPEN - deployment** | The limiter is in memory: with more than one instance the counter must be shared. The key is the connection's address and the email address together, and no proxy header is believed |

---

## RG-1 — the role-management operation

**The gate.** The M2 provisioning wrote `pg_authid.rolpassword` directly.
That works, and it is not a role-management operation: it bypasses the
catalogue's own rules, it depends on an internal layout, and it is the kind
of thing a release should not ship.

**What replaced it.** The password is turned into a **SCRAM-SHA-256
verifier** in the provisioning script, and the verifier is set with the
supported operation:

```sql
ALTER ROLE "ztech_app" PASSWORD 'SCRAM-SHA-256$4096:<salt>$<stored>:<server>'
```

PostgreSQL stores a value that is already a verifier **verbatim**, so the
credential is set the supported way and the password never reaches the
database as a password.

**Why the security is preserved.**

- The password is never in a statement. The verifier is built in the
  script and transported as a **bind parameter** into a server-side
  `format()`.
- The stored value is **one-way**. The verifier cannot be turned back into
  the password, and — this is SCRAM's design — the verifier alone cannot
  be used to authenticate: the client proves knowledge of the *client key*,
  and the stored key is its SHA-256, which does not yield it.
- The statement that carries the verifier is **not logged**: the session's
  `log_statement` is switched off around it, so neither the server's
  statement log nor a proxy's can contain it.
- The rotation and the login behaviour are proved by tests, not by
  assertion.

**The evidence.**

| Test | What it proves |
|---|---|
| `provisioning.test.js` — *the stored value is a verifier* | what is stored in `pg_authid.rolpassword` is a `SCRAM-SHA-256$` verifier, the password is not in it, and no statement in any of the scripts puts a password into the SQL text |
| `provisioning.test.js` — *the verifier is in no statement log* | the server's own log, with `log_statement = all` turned on for the cluster, does not contain the verifier after the provisioning has run |
| `provisioning.test.js` — *the production path configures all five roles* | each role may log in with the credential it was given, and with nothing else |
| `credentials.test.js` — *a placeholder credential can be rotated away safely* | the old credential stops working and the new one works |
| `credentials.test.js` — *a role with no credential cannot be logged into* | a role that was created and never configured is closed, not open |

**Status: CLOSED.**
