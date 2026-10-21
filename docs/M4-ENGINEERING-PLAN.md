# M4 — engineering plan: the durable background AI processing system

**Status: a design for approval. Nothing here is implemented.** No M4
migration exists, no M4 code exists, and no provider has been called. The
plan is written so that the decisions can be made before the first table is
created, because several of them are expensive to change later.

| | |
|---|---|
| **Predecessor** | M3, accepted at `50d55dd8` — the tenant boundary, the session model, the five roles and the RLS contracts |
| **What M4 must not break** | the M0–M3 contracts, the desktop application, the Lead Intelligence functionality, and the ZuniSEO repository boundary |
| **Release gates it inherits** | RG-7 (the workspace token is a bearer credential), RG-8 (the login throttle is in memory — **a tracked security dependency, not solved by this milestone**) |

---

## 1. The shape of the problem

M4 turns a service that answers requests into a service that does work
**reliably, once, and in the background**: research jobs, enrichment,
suppression checks, and the provider calls that cost money.

Three things make that hard, and M4 is really about the three of them:

1. **Work must survive a crash.** A worker dies mid-job; the job must be
   picked up again, and the provider call that was in flight must not be
   paid for twice.
2. **Money must be spent once.** A provider request that may have been
   processed but whose outcome we did not hear back about must never be
   repeated automatically.
3. **The tenant boundary must hold in the background too.** A job that runs
   for another workspace must never be able to read or write it, and the
   RLS contracts from M2 must not have to be re-implemented in the queue's
   own SQL.

---

## 2. Proposed database tables and migrations

Everything lives in the `li` schema and is owned by the migration role, as
in M1–M3. The queue is **PostgreSQL-native**: no Redis, no separate
broker, no new infrastructure.

### 2.1 `li.job_queue` — the durable job

| Column | Type | Why |
|---|---|---|
| `job_id` | `UUID PRIMARY KEY` | the identity of the job |
| `workspace_id` | `UUID NOT NULL` | **the tenant boundary**: every job is workspace-scoped |
| `job_type` | `TEXT NOT NULL` | `research`, `enrichment`, `suppression_check`, … |
| `idempotency_key` | `TEXT NOT NULL` | the caller's key: the same key means the same job |
| `payload` | `JSONB NOT NULL` | the job's arguments, never credentials |
| `state` | `TEXT NOT NULL` | `queued`, `leased`, `running`, `succeeded`, `failed`, `cancelled`, `uncertain` |
| `priority` | `INTEGER NOT NULL DEFAULT 100` | lower runs first; a paid-now job may be raised |
| `attempt_count` | `INTEGER NOT NULL DEFAULT 0` | the retry count |
| `max_attempts` | `INTEGER NOT NULL DEFAULT 5` | the retry limit |
| `next_attempt_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | the backoff schedule |
| `lease_owner` | `TEXT` | the worker that holds the lease |
| `lease_expires_at` | `TIMESTAMPTZ` | when the lease lapses and the job is reclaimable |
| `fencing_token` | `BIGINT NOT NULL DEFAULT 0` | **monotonic**: a worker with a stale token cannot write |
| `last_error` | `TEXT` | the last failure, for the operator |
| `created_at`, `updated_at`, `started_at`, `finished_at` | `TIMESTAMPTZ` | the timeline |
| `result` | `JSONB` | the outcome, for a `succeeded` job |

**Indexes:** `(state, next_attempt_at, priority)` for the claim query;
a **unique** `(workspace_id, job_type, idempotency_key)` for the
idempotency guarantee; `(workspace_id, created_at DESC)` for the listing.

**Constraints:** `state` is a `CHECK` over the seven states; the
workspace foreign key is `(workspace_id, …)`-aware, as in M3.

### 2.2 `li.provider_ledger` — every external invocation

| Column | Type | Why |
|---|---|---|
| `invocation_id` | `UUID PRIMARY KEY` | the identity of the provider call |
| `workspace_id` | `UUID NOT NULL` | the tenant |
| `job_id` | `UUID NOT NULL REFERENCES li.job_queue` | the job that caused it |
| `provider` | `TEXT NOT NULL` | `zuniseo`, `apollo`-style data providers, … |
| `operation` | `TEXT NOT NULL` | what was asked for |
| `idempotency_key` | `TEXT NOT NULL` | **the key the provider is told**, so the provider can deduplicate |
| `request_hash` | `TEXT NOT NULL` | the hash of the request: the same key with a different request is a **conflict**, not a duplicate |
| `chargeable` | `BOOLEAN NOT NULL` | whether this call costs money |
| `state` | `TEXT NOT NULL` | `prepared`, `dispatched`, `confirmed`, `failed`, `uncertain` |
| `estimated_credits` | `INTEGER` | the reservation |
| `actual_credits` | `INTEGER` | what the provider reported |
| `provider_request_id` | `TEXT` | the provider's own id, when it gives one |
| `response_digest` | `TEXT` | a hash of the response, not the response: the ledger must not hold customer data |
| `dispatched_at`, `confirmed_at` | `TIMESTAMPTZ` | the timeline |

**Unique:** `(provider, idempotency_key)`. A second dispatch of the same
key is therefore impossible at the database level.

### 2.3 `li.credit_accounts` and `li.credit_reservations`

| `li.credit_accounts` | |
|---|---|
| `workspace_id` | `UUID PRIMARY KEY` |
| `credit_balance` | `INTEGER NOT NULL DEFAULT 0` — the **available** credits |
| `credit_reserved` | `INTEGER NOT NULL DEFAULT 0` — the **reserved** ones |
| `version` | `BIGINT` — the optimistic-lock counter |
| `updated_at` | `TIMESTAMPTZ` |

| `li.credit_reservations` | |
|---|---|
| `reservation_id` | `UUID PRIMARY KEY` |
| `workspace_id` | `UUID NOT NULL` |
| `invocation_id` | `UUID NOT NULL REFERENCES li.provider_ledger` — the reservation is for **one** call |
| `amount` | `INTEGER NOT NULL` |
| `state` | `TEXT NOT NULL` — `held`, `settled`, `released` |
| `idempotency_key` | `TEXT NOT NULL UNIQUE` — the settlement is idempotent |
| `created_at`, `settled_at` | `TIMESTAMPTZ` |

**Invariant:** `credit_balance >= 0` always, enforced by a `CHECK`, and the
reservation is taken with a single conditional `UPDATE` (see §4).

### 2.4 `li.job_events` — the audit trail of the queue

Append-only: every state transition, with the worker, the fencing token and
the reason. This is what makes "why did this job run twice?" answerable.

### 2.5 The migrations

| Migration | Contents |
|---|---|
| `016_job_queue.sql` | `li.job_queue`, its indexes, the state `CHECK`, the RLS policy (workspace-scoped, `FORCE`d) and the `SECURITY DEFINER` claim/release functions |
| `017_provider_ledger.sql` | `li.provider_ledger`, the unique idempotency constraint, the RLS policy |
| `018_credits.sql` | `li.credit_accounts`, `li.credit_reservations`, the atomic reservation function, the RLS policy |
| `019_job_events.sql` | `li.job_events`, append-only, the RLS policy |
| `020_team_scope.sql` | the `team_id` strategy (§6) — **a separate migration, on purpose** |

**Every migration is idempotent** (as M1–M3's are) and **every table is
workspace-scoped with RLS enabled and forced**, so the M2 contract holds for
the background system without any new code: a worker that opens a context
for workspace A cannot read workspace B's jobs, whatever the SQL says.

**The new roles.** The queue needs a role that may *claim* jobs but not
read a tenant's data: `ztech_worker` already exists (M2) and may read the
tenant tables, so the queue's claim function is a `SECURITY DEFINER`
function owned by the migration role, and the worker role may only execute
it. The migration role keeps its `BYPASSRLS` and is never a runtime role.

---

## 3. The job state machine

```
                    ┌──────────────── cancel ────────────────┐
                    │                                        ▼
  create ──▶ queued ──claim──▶ leased ──start──▶ running ──┴──▶ cancelled
                ▲                 │                   │
                │                 │ lease expires      ├──▶ succeeded
                │                 ▼                   │
                │             queued ◀──────────────────┤
                │                                     ├──▶ failed (retryable)
                └────────────── backoff ◀──────────────┘
                                                      └──▶ uncertain
```

| State | Meaning | Who moves it |
|---|---|---|
| `queued` | ready to run | the claim function (from `leased`/`running` on a lease expiry or a failure) |
| `leased` | a worker has reserved it, but has not started | the claim function; the worker's heartbeat extends `lease_expires_at` |
| `running` | a worker is executing it | the worker (to `succeeded`, `failed`, `uncertain`, `cancelled`) |
| `succeeded` | done, with a result | the worker, **only** with the current fencing token |
| `failed` | a confirmed failure, retryable until `attempt_count = max_attempts` | the worker, then the claim function's backoff |
| `cancelled` | a cancellation was requested and honoured | the worker or the API |
| `uncertain` | **the provider may already have processed the request** | the worker, when the call timed out or the connection broke |

### The fencing token

Every claim increments `fencing_token`. A worker may only write a result
`WHERE job_id = $1 AND fencing_token = $2`. A worker that was paused (a GC
pause, a network partition) and comes back with a stale token therefore
**cannot** write a result: its update affects zero rows, and it is
discarded. This is the single most important mechanism in the design: it is
what makes "two workers ran the same job" safe.

### The claim query

One statement, inside a transaction, using `FOR UPDATE SKIP LOCKED`:

```sql
UPDATE li.job_queue SET
  state = 'leased', lease_owner = $1, lease_expires_at = now() + $2,
  fencing_token = fencing_token + 1, attempt_count = attempt_count + 1
WHERE job_id = (
  SELECT job_id FROM li.job_queue
   WHERE state = 'queued' AND next_attempt_at <= now()
     AND (state <> 'leased' OR lease_expires_at < now())
   ORDER BY priority, next_attempt_at, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
RETURNING *;
```

`SKIP LOCKED` is what lets ten workers claim ten different jobs without
contention. The whole claim is **one transaction**: the state change and the
token increment cannot come apart.

### The lease and the heartbeat

A worker renews its lease every `lease_interval` (30 s) with
`UPDATE … SET lease_expires_at = now() + lease_duration WHERE job_id = $1
AND fencing_token = $2`. A worker that stops heart-beating loses the lease
after `lease_duration` (5 minutes), and the job becomes reclaimable.

### Crash recovery

A crashed worker's job is reclaimed when its lease expires. The reclaim
does **not** assume anything about what the worker did: the job goes back
to `queued` with a backoff, and **the provider ledger decides what happens
next** (§4). The crash may have happened *after* the provider processed the
request — that is what the `uncertain` state and the ledger are for.

### Retry and backoff

`attempt_count` is bounded by `max_attempts` (5 by default, and the bound
may be lower for chargeable jobs — see §4). The backoff is exponential
with a cap: `min(base * 2^attempt_count, max)` with jitter, so a fleet of
workers that failed together does not retry together.

### Cancellation

A cancellation is a request, not a kill: the API records the intent
(`cancel_requested_at`), the worker observes it at its next checkpoint and
moves the job to `cancelled`. A job that is already inside a provider call
cannot be cancelled — the call may already be charged — so the job goes to
`uncertain`, not `cancelled`, and the ledger decides.

---

## 4. The provider-ledger architecture and the credit reservation lifecycle

### The rule

> **Never automatically repeat a chargeable invocation when the provider may
> already have processed it.**

The ledger makes that possible by making the *dispatch* idempotent, and
the credits make it possible by making the *money* idempotent.

### The invocation lifecycle

```
prepare ──▶ dispatch ──▶ confirmed
   │            │
   │            └──▶ failed          (the provider said no: a confirmed failure)
   │            └──▶ uncertain       (timeout, broken connection, no answer)
   │
   └──▶ (the reservation is held; the job is queued but not dispatched)
```

1. **prepare** — the worker inserts a ledger row in state `prepared` with
   the **idempotency key it will give the provider** and a
   `request_hash`. The unique constraint on `(provider, idempotency_key)`
   makes a second prepare impossible: a repeated job finds the existing row
   and continues it rather than starting a new one.
2. **reserve** — the credits are reserved (below) and the row moves to
   `dispatched` in the **same transaction** as the reservation.
3. **dispatch** — the provider is called, with the idempotency key passed
   through, so a provider that supports it deduplicates. The provider's own
   request id is recorded when it gives one.
4. **confirm** — the provider answered. The row moves to `confirmed`, the
   actual credits are recorded, the reservation is **settled**, and the job
   may move to `succeeded`.
   - a provider that answered "no" → `failed`, the reservation is
     **released**, and the job is retryable (a confirmed failure is safe to
     retry, because nothing was charged);
   - a provider that did **not** answer (timeout, broken connection) →
     `uncertain`, the reservation is **held** (not released and not
     settled), and the job goes to `uncertain`.

### What happens to an `uncertain` invocation

**Not** an automatic retry. The options, in order of preference:

1. **Reconcile first** — the provider's own status API (if it has one) is
   asked about the idempotency key. If the provider supports it, the
   outcome is *known* and the ledger is corrected.
2. **A human decides** — the job sits in `uncertain` with the reservation
   held, and an operator resolves it from the admin console (M6). The
   credits stay reserved, so the accounting is honest while it is unknown.
3. **Never** an automatic re-dispatch of a chargeable call. The
   `uncertain` job may be retried only if the provider's operation is
   proven idempotent **and** the ledger records the attempt, so the
   duplicate is visible.

### The credit reservation lifecycle

```
available ──reserve──▶ held ──settle──▶ consumed (the balance falls)
                        │
                        └──release──▶ available (the balance is unchanged)
```

- **Availability check** — `credit_balance - credit_reserved >= amount`.
- **Atomic reservation** — a single conditional update, so two workers
  cannot both reserve the last credit:

  ```sql
  UPDATE li.credit_accounts
     SET credit_balance = credit_balance - $2,
         credit_reserved = credit_reserved + $2,
         version = version + 1
   WHERE workspace_id = $1 AND credit_balance - credit_reserved >= $2
  RETURNING *;
  ```

  Zero rows returned means **insufficient credit** → the job is `failed`
  with a clear reason, and nothing is dispatched.
- **Settlement** — idempotent, keyed by `idempotency_key`: the reservation
  moves to `settled`, the reserved amount falls, and the **actual** amount
  is what the balance is reduced by. A repeated settlement affects zero
  rows and is not an error.
- **Release** — the reservation moves to `released` and the reserved
  amount falls; the balance is untouched. This is the path for a confirmed
  failure, and for an `uncertain` invocation that reconciliation proved was
  never charged.
- **Uncertain outcomes** — the reservation is **held**. The credits are not
  returned and not consumed, and the workspace's *usable* balance is
  reduced while the question is open. That is the conservative direction:
  the tenant cannot spend the same credits twice.
- **Reconciliation** — a periodic job compares the ledger's confirmed
  totals with the provider's invoices, and reports the difference. It
  never edits a confirmed record; it adds a reconciliation record.

**No real payments and no chargeable provider calls during engineering
tests.** The tests use a fake provider that records its calls, a fake
billing account, and a deterministic clock.

---

## 5. The worker and the API boundaries

| | The API | The worker |
|---|---|---|
| **Runs** | in the request/response path | in the background, on a timer |
| **Database role** | `ztech_app` (the tenant runtime role) | `ztech_worker` |
| **May** | create jobs, read a job's status, request a cancellation | claim jobs, execute them, write results and ledger rows |
| **May not** | claim or execute a job, write a result, touch the credits directly | open a context for a workspace it was not given, read another tenant's rows |
| **Workspace context** | the caller's session, bound to the session and the user | a **job-scoped** context: the job's `workspace_id`, opened with a token bound to the job's session (M3) or a dedicated worker token (M4) — see the decision list |

The worker never trusts the job's payload for authority: the payload carries
**data**, and the authority is the workspace the job was created in, which
the worker obtains from the job row under RLS, not from the payload.

The API never calls a provider directly: it creates a job and returns. A
synchronous provider call is a **synchronous job** with a short lease, and
the same ledger, the same credits and the same idempotency apply.

---

## 6. Tenant and team security

### The M2/M3 contracts are preserved

- The row-level security policies on the new tables are workspace-scoped
  and **forced**, exactly as the 28 tenant tables are.
- The **session-bound token** mechanism is reused: a worker opens a
  context with a token bound to a session and a user, and the database
  re-checks the entitlement on every read.
- The **five roles** apply to the queue's *customer-visible* operations:
  who may **create** a job, who may **read** a job, who may **cancel** a
  job, and who may read the **ledger** and the **credits** are a new
  permission set that follows the same matrix (the owner and the admin see
  the spending, the member sees their own jobs, the viewer sees the status
  only).
- A job created by a member of a workspace is visible to that workspace's
  members, and to nobody else — the RLS policy is the boundary, not the
  API.

### The `team_id` strategy (a data-level decision)

**The problem.** M3's team filter narrows the *identities* and the *audit*;
the tenant tables have no team column, so team-scoped visibility of the
*data* is not expressible.

**The proposal.**

| | |
|---|---|
| **The column** | `team_id UUID NULL` on the tables that are team-visible — the **saved searches** and the **pitch drafts** first (the workspace's own research surface), and then the M1–M2 tables as they are needed |
| **Existing records** | `team_id = NULL` means **the workspace's general scope**, visible to every member of the workspace. No existing row is rewritten, and **no migration guess** is made about which team an old record belonged to |
| **Visibility** | a member whose membership carries a `team_id` sees the rows with that `team_id` **and** the rows with `team_id IS NULL`; a member without a team sees everything in the workspace. A team member does **not** see another team's rows |
| **Who may set it** | the row's author, at write time; and a member with `member.role` permission (the owner and the admin) may change it afterwards. It is not client-controlled on read, and it is **not** settable by a viewer |
| **Migration safety** | the column is added nullable, in its own migration (`020_team_scope.sql`), with **no backfill**: `NULL` is the workspace's general scope, so the migration changes no existing visibility. The index is created **concurrently** (it cannot be inside a transaction) and the policy is added **after** the column exists |
| **The RLS predicate** | `workspace_id = current_workspace() AND (team_id IS NULL OR team_id = current_team())`, where `current_team()` is a `SECURITY DEFINER` function that reads the caller's membership and is `NULL` for a member without a team (so the predicate degrades to "everything in the workspace" ✔) |
| **Negative tests** | a member of team A cannot read, write or delete a row of team B; a member of team A cannot move a row into team B by supplying a `team_id` in a request; the general-scope rows (`NULL`) are visible to every member of the workspace; a member of another workspace sees nothing at all |

### RG-8 is a tracked dependency, not a solution

The distributed login throttle is **not** solved by the job queue, and the
plan does not pretend otherwise. M4 adds a **tracked security dependency**:
before the service runs on more than one instance, the login throttle must
move to a shared store (the `li` schema's own tables, with the same
transaction discipline as the credits), or the service must be pinned to one
instance for the login path. The gate stays **OPEN** until one of those is
done, and M4's own acceptance criteria do not claim it.

---

## 7. The crash / retry / idempotency failure matrix

| Failure | What the ledger says | What the credits do | What the job does | Is the provider called again? |
|---|---|---|---|---|
| The worker crashes **before** the dispatch | `prepared` | the reservation is **held** | the lease expires → `queued` → re-claimed | **Yes** — the call was never made, and the same idempotency key is used ✔ |
| The worker crashes **after** the dispatch, before the answer | `dispatched` | the reservation is **held** | the lease expires → the reclaim finds a `dispatched` row → the job goes to `uncertain` | **No** — the outcome is reconciled, or a human decides |
| The provider answers "no" | `failed` | the reservation is **released** | `failed` → backoff → `queued` (until `max_attempts`) | **Yes** — a confirmed failure is safe to retry |
| The provider times out | `uncertain` | the reservation is **held** | `uncertain` | **No** — reconciled, or a human decides |
| The worker is paused and comes back with a stale fencing token | unchanged | unchanged | its result update affects **zero rows** | No — the work is discarded ✔ |
| The API creates the same job twice (the same idempotency key) | one row | one reservation | one job — the second request returns the first | **No** — the unique constraint is the guarantee |
| Two workers claim the same job | one row, one token | one reservation | the loser's update affects zero rows | **No** |
| The reservation fails (insufficient credit) | `prepared`, never dispatched | nothing reserved | `failed` with a clear reason | **No** — nothing was called |
| The worker's lease expires while it is still working | `dispatched` | held | the reclaim marks it `uncertain`; the slow worker's write is fenced out | **No** |
| The provider is called twice with the same idempotency key | one row | one reservation | one job | The **provider** deduplicates; the ledger records the second attempt ✔ |

---

## 8. The test plan

Everything runs against a **real PostgreSQL 16**, with the real roles, and
**no real provider is ever called**: the tests use a fake provider that
records its calls, and a deterministic clock.

| Area | The tests |
|---|---|
| **The state machine** | every legal transition; every illegal transition is refused; the state `CHECK` |
| **Idempotency** | the same key creates one job; a **different** request with the same key is a conflict; the same key in **two** workspaces is two jobs |
| **Claiming** | ten workers claim ten different jobs (`SKIP LOCKED`), never the same one |
| **The fencing token** | a worker with a stale token cannot write a result, and its write affects zero rows |
| **Lease expiry** | a crashed worker's job is reclaimed after the lease; a heartbeating worker keeps its lease |
| **Crash recovery** | the worker is killed at each of: before the dispatch, after the dispatch, before the answer — and the ledger, the credits and the job state are each asserted |
| **The ledger** | a repeated dispatch of the same key is impossible; a second attempt is recorded but not a second charge |
| **Uncertain** | a timed-out provider call is **never** automatically re-dispatched; the reservation stays held; reconciliation settles it; a human path exists |
| **The credits** | the balance never goes negative; two concurrent reservations cannot both take the last credit; the settlement is idempotent (twice is once); the release returns the credits; the insufficient-credit case dispatches nothing |
| **Tenant isolation** | a worker for workspace A cannot read, write or claim a job of workspace B, **whatever the SQL says** — the RLS policy is the boundary |
| **Team scope** | a member of team A cannot read or move a row of team B; the general-scope rows are visible to the whole workspace; another workspace sees nothing |
| **Concurrency** | every test that involves two actors uses a **barrier**, not a sleep: the M3 suite's pause points and barrier are the pattern, and the queue adds its own |
| **Regression** | the whole M0–M3 suite stays green: the persistence contract, the API authorization suites, the production provisioning path, and the desktop suites |

**Acceptance criteria (measurable).**

| # | Criterion |
|---|---|
| 1 | Zero duplicate provider charges: a ledger row exists for every dispatch, and the sum of the *settled* charges equals the sum of the provider's reported charges in every crash test |
| 2 | Zero automatic re-dispatch of an `uncertain` chargeable invocation (asserted by counting the provider's calls) |
| 3 | No credit account is ever negative, under any concurrent schedule (asserted with a randomized concurrent test over 1,000 reservations) |
| 4 | A job is executed at most once **logically**: at most one row reaches `succeeded` per job, and the provider is called at most once per *confirmed* attempt |
| 5 | Cross-tenant and cross-team access is impossible through the API **and** through direct SQL, as the runtime role (asserted with raw SQL, not through the API) |
| 6 | Every crash point in §7 has a test, and the ledger, the credits and the job state are each asserted at that point |
| 7 | The M0–M3 suites stay green, unchanged |

---

## 9. Deployment dependencies and the release gates M4 would add

| Dependency | Why | Status |
|---|---|---|
| **A shared login throttle (RG-8)** | a multi-instance deployment must not let a spray spread across instances | **OPEN** — a tracked security dependency, not solved here |
| **A shared clock** | the lease, the backoff and the credit expiry depend on the instances' clocks agreeing | to decide: use the **database's** clock everywhere (`now()`), never the application's |
| **A provider that accepts an idempotency key** | without it, a crash after the dispatch is unresolvable automatically | to confirm per provider; where it is absent, the job stays `uncertain` |
| **A per-provider credit price** | the reservation needs an amount before the call | to confirm; a price change between the reservation and the settlement is recorded, not hidden |
| **A migration role in the runtime image** | the queue's claim functions are `SECURITY DEFINER` | the migration role must stay out of the runtime services — the same rule as M2 |
| **The `ztech_worker` role's grants** | the worker may claim and execute, and may read the tenant tables it is given | to be granted by the migration, and asserted by the startup assertion |

**The release gates M4 would add.**

| # | Gate |
|---|---|
| RG-14 | No chargeable provider invocation is ever automatically repeated when the outcome is uncertain |
| RG-15 | No credit account can go negative, under any concurrency |
| RG-16 | A worker with a stale fencing token can never write a result |
| RG-17 | The queue's tables are workspace-scoped with RLS enabled and forced, and the startup assertion checks it |
| RG-18 | The team-scoped rows are invisible to another team, asserted with raw SQL as the runtime role |
| RG-19 | The distributed login throttle is shared — **RG-8 closed** |

---

## 10. Implementation phases, with acceptance criteria

| Phase | What | Acceptance criteria |
|---|---|---|
| **P0 — the decisions** | the decisions in §11, and the provider and pricing facts | the decisions are recorded; each provider's idempotency support and price are known |
| **P1 — the queue** | `016_job_queue.sql`, the claim/release functions, the state machine, a worker that runs a no-op job | the state machine's tests pass; ten workers claim ten jobs; a stale fencing token cannot write; a crashed worker's job is reclaimed |
| **P2 — the ledger** | `017_provider_ledger.sql`, the fake provider, the invocation lifecycle | a repeated dispatch is impossible; a crashed-after-dispatch call is `uncertain` and is never automatically re-dispatched; the crash matrix's rows pass |
| **P3 — the credits** | `018_credits.sql`, the reservation, the settlement, the reconciliation | the balance never goes negative; the settlement is idempotent; insufficient credit dispatches nothing; 1,000 concurrent reservations keep the invariant |
| **P4 — the API surface** | the job endpoints, the cancellation, the ledger and credit endpoints, the permissions | a customer sees only their own workspace's jobs; the permission matrix applies; the cancellation is honoured at the next checkpoint |
| **P5 — the team scope** | `020_team_scope.sql`, the `team_id` column, the policy, the negative tests | a team member cannot read or move another team's rows, asserted with raw SQL; the existing rows' visibility is unchanged |
| **P6 — the reconciliation** | the reconciliation job, the operator view of the `uncertain` jobs | the reconciliation reports the difference without editing a confirmed record; the `uncertain` jobs have an operator path |
| **P7 — the release** | the gates, the runbook, the deployment | RG-14…RG-19 are closed or explicitly accepted as open with a date |

**P0 is the only phase that may start before the approval of this plan.**
P1–P7 are each separately approvable, and each ends with its own green
suite.

---

## 11. The decisions that need the owner's approval

| # | Decision | The options | What I would choose, and why |
|---|---|---|---|
| **D1** | **The worker's workspace context** | (a) a dedicated worker token per workspace, issued by the control plane; (b) a per-job session that the API creates and the worker borrows; (c) the worker runs as `ztech_migrator` and bypasses RLS | **(a)** — a worker token bound to the workspace, issued by the control plane, never to a user. (b) would put a user's session in the background, and a session is revoked on logout; (c) would put the BYPASSRLS credential in the runtime, which M2 explicitly forbids |
| **D2** | **The max lifetime of a chargeable job** | (a) one attempt, then `uncertain`; (b) up to 5 attempts, with the ledger deduplicating; (c) unlimited, with the ledger deduplicating | **(a)** for a chargeable job, **(b)** for a free one. Retrying a chargeable call is exactly the thing the ledger says is unsafe |
| **D3** | **The `uncertain` resolution** | (a) the provider's status API, automatically; (b) an operator, manually; (c) both, in that order | **(c)** — the automatic path where the provider supports it, and a manual path otherwise. The credits stay held until it is resolved |
| **D4** | **The credit price** | (a) a fixed price per operation; (b) a price per operation from a table the platform owns; (c) the provider's own quote | **(b)** — a platform-owned price table, so the reservation is computable before the call and the settlement can record a price change |
| **D5** | **The `team_id` default** | (a) `NULL` = the whole workspace; (b) a backfill into a "general" team | **(a)** — no backfill, no guess, and no change to any existing row's visibility. A backfill would be a silent reinterpretation of history |
| **D6** | **The job result's retention** | (a) forever; (b) a fixed window; (c) per workspace | **(b)** — a window with a workspace-level override, because a job result is customer data and the ledger's `response_digest` is the part that is kept for accounting |
| **D7** | **The login throttle's shared store** | (a) the `li` schema's own tables; (b) Redis; (c) one instance for the login path | **(a)** — the same database, the same transaction discipline, no new infrastructure, and it closes RG-8 without a new service |
| **D8** | **Whether M4 may call a provider in a staging environment** | (a) no real provider, ever, in engineering; (b) a real provider with a spending cap | **(a)** for the engineering phase; **(b)** is a separate, explicitly approved step with a hard spending cap, because the first real call is the first real risk of a real charge |

---

## 12. Explicitly out of scope

- **The platform console and the break-glass path** (M6): the operator
  authentication, the audit view and the manual resolution of the
  `uncertain` jobs are **M6's** work. M4 builds the data and the hooks.
- **Authentication of the operators** (M6): M4 does not invent one.
- **The CRM, the dashboards and the commercial surface**: the job queue
  serves them; it does not build them.
- **The providers themselves**: the data and research providers are what
  the queue calls; M4 does not change what they do.
- **Multi-region, multi-tenant sharding**: the queue is a single
  PostgreSQL cluster's table, and the plan says so.
- **A message broker**: the queue is PostgreSQL. Adding one is a different
  milestone with a different cost.
- **The desktop application**: it keeps its own sql.js store and its own
  local behaviour; M4 is the cloud service only.
- **ZuniSEO**: read-only, as always. The `zuniseo` provider is called
  through the ledger like any other, and the repository is never modified.

---

## 13. What is NOT decided, and what is not known

- The providers' **idempotency support** is not confirmed per provider —
  D3's automatic reconciliation depends on it.
- The providers' **credit pricing** is not confirmed (D4).
- The **price of a research operation** in ZTech's commercial terms is a
  product decision, not an engineering one, and the credit ledger needs it
  before P3.
- Whether the **ledger should hold the response** or only a digest is D6 —
  the plan proposes a digest, because the ledger is not a data store.
- The **team model** beyond the `team_id` column: teams are a membership
  attribute in M3, and M4 proposes to make them a data attribute on a few
  tables. The full team model (teams as first-class entities, nested
  teams) is **not** in this plan.

**Nothing in this document is implemented. Awaiting approval.**
