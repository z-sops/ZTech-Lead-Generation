# M4 — engineering plan, revision R1

**Status: a design for approval. Nothing here is implemented.** No M4
migration exists, no M4 code exists, and no provider has been called. This
revision corrects the credit accounting, the claim and recovery logic, the
worker's authorization, the dispatch guarantees, the team-level RLS, the
pre-authentication throttle, and the owner decisions.

| | |
|---|---|
| **Predecessor** | M3, accepted at `50d55dd8`; the M3 documentation closed at `c22d217` |
| **What M4 must not break** | the M0–M3 contracts, the desktop application, the Lead Intelligence functionality, and the ZuniSEO repository boundary |
| **Release gates it inherits** | RG-7 (the workspace token is a bearer credential), RG-8 (the login throttle is in memory — **a tracked security dependency, not solved by this milestone**) |

---

## 0. The R1–R7 correction matrix

| | What was wrong | What it says now | Where |
|---|---|---|---|
| **R1** | The reservation reduced `credit_balance` **and** the available credits were computed by subtracting the reserved ones — the same credits were counted twice | One model: `credit_balance` is the total unspent credits **including the held ones**, `credit_reserved` is the portion held, and `available = balance - reserved`. A reservation raises the hold and does **not** touch the balance | §4 |
| **R2** | The claim statement selected only `queued` rows, so its expired-lease condition could never fire | Recovery of expired `leased`/`running` jobs is a **separate statement** with its own decision, and claiming is a second statement over `queued` rows only | §3.4, §3.5 |
| **R3** | The worker had no authorization of its own, and reusing a customer session was not viable | A **job-scoped worker credential**, bound to the job, the workspace, the worker, the lease and the fencing token, issued by the control plane — never a borrowed customer session | §5 |
| **R4** | The unique `(provider, idempotency_key)` constraint was described as preventing duplicate charges | It prevents duplicate **ledger identities**; it does **not** prevent a repeated physical request or a repeated charge. The dispatch moments are separated, and an uncertain outcome is never automatically retried | §6 |
| **R5** | The proposed team predicate and the treatment of a teamless member did not match | One predicate family, with the team scope taken from a **protected** context, and the fail-closed behaviour made explicit for a member with no team | §7 |
| **R6** | The throttle was treated as if tenant RLS were available before authentication, and the reconciliation was open to an unauthenticated operator | The throttle is **pre-authentication**, has its own least-privileged role and its own tables, and M4 provides **reconciliation data only** — no manual operator endpoint | §9, §10 |
| **R7** | D1–D8 recommended directions that did not match the corrections | The eight decisions are retained and revised, each with a recommendation and the reason | §12 |

---

## 1. The shape of the problem

M4 turns a service that answers requests into one that does work
**reliably, once, and in the background**: research jobs, enrichment, and
the provider calls that cost money.

Three things make that hard:

1. **Work must survive a crash.** A worker dies mid-job; the job must be
   picked up again, and the provider call that was in flight must not be
   paid for twice.
2. **Money must be spent once — and only once, and never blindly.** A
   request that may already have been processed must not be repeated
   automatically.
3. **The tenant boundary must hold in the background too.** A job that runs
   for another workspace must never reach it, and the M2 contracts must not
   have to be re-implemented in the queue's own SQL.

---

## 2. The proposed tables

Everything lives in the `li` schema, owned by the migration role, as in
M1–M3. The queue is **PostgreSQL-native**: no broker, no Redis, no new
infrastructure.

### 2.1 `li.job_queue`

| Column | Type | Why |
|---|---|---|
| `job_id` | `UUID PRIMARY KEY` | the identity of the job |
| `workspace_id` | `UUID NOT NULL` | **the tenant boundary** |
| `job_type` | `TEXT NOT NULL` | `research`, `enrichment`, `suppression_check`, … |
| `idempotency_key` | `TEXT NOT NULL` | the caller's key |
| `payload` | `JSONB NOT NULL` | the job's **arguments**, never credentials |
| `state` | `TEXT NOT NULL` | `queued`, `leased`, `running`, `succeeded`, `failed`, `cancelled`, `uncertain` |
| `priority` | `INTEGER NOT NULL DEFAULT 100` | lower runs first |
| `attempt_count` | `INTEGER NOT NULL DEFAULT 0` | the retry count of the **job** |
| `max_attempts` | `INTEGER NOT NULL DEFAULT 5` | the retry limit of the job |
| `next_attempt_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | the backoff schedule |
| `lease_owner` | `TEXT` | the worker that holds the lease |
| `lease_expires_at` | `TIMESTAMPTZ` | when the lease lapses |
| `fencing_token` | `BIGINT NOT NULL DEFAULT 0` | **monotonic** — a stale worker cannot write |
| `last_error` | `TEXT` | the last failure, for the operator |
| `created_at`, `updated_at`, `started_at`, `finished_at` | `TIMESTAMPTZ` | the timeline |
| `result` | `JSONB` | the outcome, for a `succeeded` job |

**Indexes:** `(state, next_attempt_at, priority)` for the claim; a unique
`(workspace_id, job_type, idempotency_key)` for the idempotency guarantee;
`(workspace_id, created_at DESC)` for the listing.

**Checks:** `state` over the seven states; `attempt_count >= 0`;
`max_attempts >= 1`.

### 2.2 `li.provider_ledger`

| Column | Type | Why |
|---|---|---|
| `invocation_id` | `UUID PRIMARY KEY` | the identity of the provider call |
| `workspace_id` | `UUID NOT NULL` | the tenant |
| `job_id` | `UUID NOT NULL REFERENCES li.job_queue` | the job that caused it |
| `provider` | `TEXT NOT NULL` | `zuniseo`, … |
| `operation` | `TEXT NOT NULL` | what was asked for |
| `idempotency_key` | `TEXT NOT NULL` | **the key the provider is told** |
| `request_hash` | `TEXT NOT NULL` | the hash of the request: the same key with a different request is a **conflict** |
| `chargeable` | `BOOLEAN NOT NULL` | whether this call costs money |
| `state` | `TEXT NOT NULL` | `prepared`, `dispatched`, `confirmed`, `failed`, `uncertain` |
| `estimated_credits` | `INTEGER NOT NULL` | the reservation |
| `actual_credits` | `INTEGER` | what the provider reported |
| `overrun_credits` | `INTEGER NOT NULL DEFAULT 0` | the cost above the reservation |
| `provider_request_id` | `TEXT` | the provider's own id, when it gives one |
| `response_digest` | `TEXT` | a **hash** of the response, not the response: the ledger is not a data store |
| `dispatched_at`, `confirmed_at` | `TIMESTAMPTZ` | the timeline |

**Unique:** `(provider, idempotency_key)` ✔ — a duplicate ledger *identity*
is impossible. **What it does not do:** prevent a second physical HTTP
request with that key (§6).

### 2.3 `li.credit_accounts` and `li.credit_reservations`

| `li.credit_accounts` | |
|---|---|
| `workspace_id` | `UUID PRIMARY KEY` |
| `credit_balance` | `INTEGER NOT NULL DEFAULT 0` — the **total unspent** credits, **including the held ones**. It may go **negative**, and a negative balance is the **debt** a workspace owes |
| `credit_reserved` | `INTEGER NOT NULL DEFAULT 0` — the portion currently **held**; never negative |
| `version` | `BIGINT NOT NULL DEFAULT 0` — the optimistic-lock counter |
| `updated_at` | `TIMESTAMPTZ` |

**Check:** `credit_reserved >= 0` ✔.

| `li.credit_reservations` | |
|---|---|
| `reservation_id` | `UUID PRIMARY KEY` |
| `workspace_id` | `UUID NOT NULL` |
| `invocation_id` | `UUID NOT NULL REFERENCES li.provider_ledger` — one reservation per invocation |
| `amount` | `INTEGER NOT NULL` — the **held** amount; `CHECK (amount > 0)` |
| `actual_credits` | `INTEGER` — what was consumed |
| `overrun_credits` | `INTEGER NOT NULL DEFAULT 0` |
| `state` | `TEXT NOT NULL` — `held`, `settled`, `released` |
| `idempotency_key` | `TEXT NOT NULL UNIQUE` — the settlement is idempotent |
| `created_at`, `settled_at` | `TIMESTAMPTZ` |

**Unique:** `invocation_id` ✔ (one reservation per invocation ✔) and
`idempotency_key` ✔ (one settlement per logical settlement ✔).

### 2.4 `li.job_events`

Append-only: every state transition, with the worker, the fencing token
and the reason. This is what makes "why did this job run twice?"
answerable.

### 2.5 `li.throttle_counters` — the pre-authentication throttle (§9)

| Column | Type | Why |
|---|---|---|
| `bucket_key` | `TEXT PRIMARY KEY` | the hashed (email, address) pair, and the (email) pair |
| `window_started_at` | `TIMESTAMPTZ NOT NULL` | when the window opened |
| `attempt_count` | `INTEGER NOT NULL` | the failures in the window |
| `updated_at` | `TIMESTAMPTZ` | |

### 2.6 The migrations

| Migration | Contents |
|---|---|
| `016_job_queue.sql` | `li.job_queue`, its indexes and checks, the workspace RLS policy, the **worker-token functions** (§5) and the claim/release functions |
| `017_provider_ledger.sql` | `li.provider_ledger`, the unique idempotency constraint, the RLS policy |
| `018_credits.sql` | `li.credit_accounts`, `li.credit_reservations`, the **reservation / settlement / release functions** (§4), the RLS policy |
| `019_job_events.sql` | `li.job_events`, append-only, the RLS policy |
| `020_team_scope.sql` | the `team_id` strategy (§7) — **a separate migration, on purpose** |
| `021_throttle.sql` | `li.throttle_counters` and the throttle function (§9) |

Every migration is idempotent, as M1–M3's are. Every table is
workspace-scoped with RLS **enabled and forced**, so the M2 contract holds
for the background system with no new code.

---

## 3. The job state machine

### 3.1 The legal transitions

| From | To | Who | The condition |
|---|---|---|---|
| — | `queued` | the API, or the recovery of a free job | the job is created, or it is requeued |
| `queued` | `leased` | the claim function | the job is due and no live lease holds it |
| `leased` | `running` | the worker | the worker starts the job, with the current fencing token |
| `leased` | `queued` | the recovery | the lease expired **and** the ledger proves nothing was dispatched |
| `running` | `succeeded` | the worker | the work is done, with the current fencing token |
| `running` | `failed` | the worker | a **confirmed** failure, with the current fencing token |
| `running` | `uncertain` | the worker, or the recovery | the dispatch may have happened (§6) |
| `running` | `cancelled` | the worker | a cancellation was requested and honoured at a checkpoint |
| `failed` | `queued` | the recovery | the attempt limit has not been reached; the backoff is applied |
| `failed` | `uncertain` | the recovery | the failure was not confirmed, and the dispatch may have happened |
| `uncertain` | `succeeded` | the reconciliation | the provider confirms the work was done |
| `uncertain` | `failed` | the reconciliation | the provider confirms it was not done, and the credits are released |
| `uncertain` | `cancelled` | the operator (M6) | a human decides |
| `cancelled` | — | — | **terminal** |
| `succeeded` | — | — | **terminal** |

**A `queued` job is never cancelled directly**: a cancellation is a request
that a worker observes at its next checkpoint, because a job that is already
inside a provider call cannot be cancelled — the call may already have been
charged (§6).

### 3.2 The times are the server's

Every time comparison uses **`now()`** — the transaction timestamp — never
the application's clock. A lease expiry, a backoff and an expiry check are
therefore all evaluated against the **same** clock, at the same instant,
inside the same transaction: the decision is deterministic, and two
instances with different clocks cannot disagree about a lease.

The clock skew between the database and the workers is therefore irrelevant
to correctness. What it does affect is the *display* of a job's timings, and
nothing else.

### 3.3 The fencing token

Every claim increments `fencing_token`. A worker may only write a result
`WHERE job_id = $1 AND fencing_token = $2`. A worker that was paused (a GC
pause, a partition) and comes back with a stale token therefore **cannot**
write: its update affects **zero rows**, and it is discarded.

This is the single most important mechanism in the design: it is what makes
"two workers ran the same job" safe, and it is what makes the lease
meaningless to a worker that has lost it.

### 3.4 The recovery of an expired lease

**A separate statement from the claim**, because it is a different decision
with different consequences.

```sql
-- 1. the jobs whose lease has lapsed, locked and skipped by the others
WITH expired AS (
  SELECT job_id FROM li.job_queue
   WHERE state IN ('leased', 'running')
     AND lease_expires_at IS NOT NULL
     AND lease_expires_at <= now()
   ORDER BY lease_expires_at
   FOR UPDATE SKIP LOCKED
   LIMIT $1
)
SELECT q.* FROM li.job_queue q JOIN expired e ON e.job_id = q.job_id;
```

For each such job, **in the same transaction** as the lock, the recovery
looks at the **provider ledger** before it does anything else:

| The ledger says | The dispatch | The recovery does | The credits |
|---|---|---|---|
| there is no invocation | none happened | **requeue** with a backoff, and increment `fencing_token` so the old worker's write is refused | nothing was held |
| `prepared` | never dispatched | **requeue** with a backoff; the same invocation row is reused, with the same idempotency key | the hold is **kept** (the invocation is still coming) |
| `dispatched` | **may have happened** | the job goes to **`uncertain`**; the fencing token is incremented | the hold is **kept** |
| `confirmed` | it happened and succeeded | the job goes to **`succeeded`**, with the ledger's outcome | the reservation is **settled** |
| `failed` | it happened and definitively failed | the job goes to **`failed`**, and the retry policy applies | the reservation is **released** |
| `uncertain` | unknown | the job **stays** `uncertain` | the hold is **kept** |

**A chargeable job is never blindly requeued.** The recovery reads the
ledger, and only a ledger that proves the dispatch never happened may
requeue it.

### 3.5 Claiming a `queued` job

```sql
WITH candidate AS (
  SELECT job_id FROM li.job_queue
   WHERE state = 'queued'
     AND next_attempt_at <= now()
   ORDER BY priority, next_attempt_at, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE li.job_queue q
   SET state = 'leased',
       lease_owner = $1,                    -- the worker identity
       lease_expires_at = now() + $2::interval,
       fencing_token = q.fencing_token + 1,
       attempt_count = q.attempt_count + 1,
       started_at = now(),
       updated_at = now()
  FROM candidate c
 WHERE q.job_id = c.job_id
RETURNING q.*;
```

`SKIP LOCKED` lets ten workers claim ten different jobs without
contention. The claim is **one statement in one transaction**: the state
change and the token increment cannot come apart.

### 3.6 The lease and the heartbeat

A worker renews its lease every 30 seconds:

```sql
UPDATE li.job_queue
   SET lease_expires_at = now() + $3::interval, updated_at = now()
 WHERE job_id = $1 AND fencing_token = $2 AND state IN ('leased', 'running');
```

Zero rows means the worker has lost the lease: it must **stop**, and it
must not write a result. A worker that stops heart-beating loses its lease
after 5 minutes, and the job becomes reclaimable (§3.4).

### 3.7 Retry and backoff

`attempt_count` is bounded by `max_attempts`. The backoff is exponential
with a cap and a jitter: `min(base * 2^attempt_count, max) + random(0, jitter)`,
so a fleet of workers that failed together does not retry together.

**The retry limit belongs to the JOB; the re-dispatch rule belongs to the
INVOCATION** (§6, D2). A job may be retried; a chargeable **invocation**
may not, once its outcome is uncertain.

---

## 4. The credit accounting (R1)

### 4.1 One model

| Term | Meaning |
|---|---|
| `credit_balance` | the **total unspent** credits — the purchased credits minus what has been **settled**. It **includes** the credits that are currently held. It may be **negative**, and a negative balance is the **debt** a workspace owes |
| `credit_reserved` | the portion currently **held** by a reservation. Never negative |
| **`available`** | `credit_balance - credit_reserved` — what may still be spent |

The three operations:

| Operation | `credit_balance` | `credit_reserved` | `available` |
|---|---|---|---|
| **Reserve** `amount` | **unchanged** | **+ amount** | − amount |
| **Settle** `actual` | **− actual** | **− held** | + (held − actual) |
| **Release** `held` | **unchanged** | **− held** | + held |

**The reservation raises the hold and does not touch the balance.** The
earlier double-count — reducing the balance *and* subtracting the reserve —
counted the same credits twice and made every workspace look poorer than
it was.

### 4.2 The SQL

**Reserve** — atomic, and the only place a hold is taken:

```sql
-- li.reserve_credits(workspace, amount, invocation_id, idempotency_key)
UPDATE li.credit_accounts
   SET credit_reserved = credit_reserved + $2,
       version = version + 1,
       updated_at = now()
 WHERE workspace_id = $1
   AND (credit_balance - credit_reserved) >= $2      -- the available check
RETURNING credit_balance, credit_reserved;
```

**Zero rows returned means insufficient credit** → the job is `failed` with
that reason, and **nothing is dispatched**. The `UPDATE … WHERE` is a single
statement, so two workers cannot both take the last credit: the second one
re-evaluates the predicate after the first one commits and sees zero
available.

**Settle** — idempotent, because the reservation's state guards it:

```sql
-- li.settle_credits(reservation_id, actual)
-- 1. the reservation, locked, and only while it is HELD
UPDATE li.credit_reservations
   SET state = 'settled',
       actual_credits = $2,
       overrun_credits = GREATEST(0, $2 - amount),
       settled_at = now()
 WHERE reservation_id = $1 AND state = 'held'
RETURNING workspace_id, amount;
-- zero rows: it is already settled or released -> the call is a NO-OP
--             (idempotent), and the account is NOT touched again

-- 2. the account, only when the reservation was actually settled
UPDATE li.credit_accounts
   SET credit_balance = credit_balance - $2,     -- the ACTUAL cost
       credit_reserved = credit_reserved - $3,   -- the whole hold is released
       version = version + 1,
       updated_at = now()
 WHERE workspace_id = $4;
```

**Release** — idempotent, and it never charges the customer:

```sql
-- 1. the reservation, only while it is HELD
UPDATE li.credit_reservations
   SET state = 'released', settled_at = now()
 WHERE reservation_id = $1 AND state = 'held'
RETURNING workspace_id, amount;
-- zero rows: already settled or released -> a NO-OP

-- 2. the account
UPDATE li.credit_accounts
   SET credit_reserved = credit_reserved - $2,   -- the hold is released
       version = version + 1,
       updated_at = now()
 WHERE workspace_id = $3;
```

### 4.3 The invariants, and how concurrency protects them

| Invariant | How it is protected |
|---|---|
| `credit_reserved >= 0` | a `CHECK` ✔, and every operation that lowers it is guarded by `WHERE state = 'held'` (or by the same arithmetic in the same statement) ✔ |
| the balance is never changed by a reservation | the reserve statement does not touch it ✔ — the model, not a race ✔ |
| the available is never over-committed | the reserve's predicate is evaluated inside the single `UPDATE` ✔, so the check and the increment are one atomic step ✔ |
| a settlement is applied once | the reservation's `state = 'held'` guard ✔, plus the unique `idempotency_key` on the reservation ✔ |
| a release is applied once | the same guard ✔ |
| the account row is not lost to a lost update | every write takes the row lock (an `UPDATE` on the row ✔) and bumps `version` ✔; the writes are short and never nested inside another lock on the same row ✔ |
| the hold and the account move together | the reservation and the account are written in **one transaction** ✔ — the same `tx()` discipline as M3's identity mutations ✔ |
| a workspace cannot spend another workspace's credits | the account is keyed by `workspace_id` ✔ and the function takes the workspace from the **job's** row, under RLS ✔ — never from a request ✔ |

### 4.4 The positive-amount validation

| Where | The rule |
|---|---|
| the table | `CHECK (amount > 0)` on `li.credit_reservations` ✔ |
| the function | the amount is rejected if it is not a positive integer ✔, and the *estimated* amount is compared with the platform's price for the operation (§12, D4) ✔ |
| the settlement | the actual amount is rejected if it is negative ✔; a zero actual is allowed (a free call that cost nothing) ✔ and releases the whole hold ✔ |
| the reservation | the amount is the **ceiling** of the hold; the actual may be lower (the difference is released) ✔ or higher (the difference is the overrun) ✔ |

### 4.5 When the actual cost exceeds the reservation

The provider's price can be higher than the estimate. The call has already
happened, so the cost is real and the workspace owes it.

**The policy.**

1. The reservation is settled with the **actual** amount ✔.
2. The account's balance is reduced by the actual amount ✔ — it **may go
   negative**, and that negative balance **is the debt** ✔.
3. The difference is recorded on the reservation as `overrun_credits` ✔, so
   the overrun is visible and reconcilable ✔.
4. The available is now negative, so the workspace **cannot reserve
   anything else** until the debt is cleared ✔ — the next reservation's
   predicate (`available >= amount`) refuses ✔.

**Why the balance may go negative rather than being floored at zero:** a
floor at zero would silently forgive part of a real charge — the platform
would absorb the difference and the workspace would never learn about it.
The debt is honest, it is visible, and it blocks further spending ✔.

**What the platform does with a debt** — a commercial decision, and the
one D4 asks about: the debt is a receivable, and the platform's policy on
it (a grace period, a service suspension) is **not** an engineering
decision. It is recorded, and it blocks reservations; what happens next is
D4's companion decision.

### 4.6 The worked example

A workspace buys **100 credits**. `credit_balance = 100`,
`credit_reserved = 0`, `available = 100`.

**A. Reserve 20** for a chargeable research call.

```sql
UPDATE li.credit_accounts
   SET credit_reserved = credit_reserved + 20, version = version + 1
 WHERE workspace_id = $1 AND (credit_balance - credit_reserved) >= 20;
```

| | balance | reserved | available |
|---|---|---|---|
| before | 100 | 0 | 100 |
| after | **100** | **20** | **80** |

**B. Settle 18** — the provider charged 18, the estimate was 20.

| | balance | reserved | available |
|---|---|---|---|
| after the settlement | **82** (100 − 18) | **0** (20 − 20) | **82** |

The whole hold is released and the balance falls by the **actual** cost ✔.
The unused 2 credits are simply never spent ✔.

**C. Release 20** — the call was definitively refused, so nothing was
charged.

| | balance | reserved | available |
|---|---|---|---|
| after the release | **100** (unchanged) | **0** | **100** |

The customer is not charged ✔.

**D. Settle 24** — the provider charged **more** than the estimate.

| | balance | reserved | available |
|---|---|---|---|
| after the settlement | **76** (100 − 24) | **0** | **76** |

No overrun here, because the hold was 20 and the actual 24: the balance
falls by the actual 24 ✔ and the hold falls by the 20 that was held ✔, so
the workspace is charged the 4 extra ✔ and the `overrun_credits` column
records 4 ✔.

**E. The debt.** Now suppose the balance is 5 and a 20-credit call is
made with a 20-credit reservation:

| | balance | reserved | available |
|---|---|---|---|
| before | 5 | 0 | 5 |
| after the reservation | 5 | 20 | **−15** |

The reservation's predicate (`available >= 20`) would have **refused** it —
so this state is only reachable when the reservation was taken when the
credits were available and the balance fell afterwards (for example by
another settlement). If the actual cost is then 20, the balance becomes
5 − 20 = **−15**, and the workspace **owes 15 credits** ✔ and cannot
reserve anything else ✔.

**F. The concurrent contention.** Two workers try to reserve 60 credits
each, and the balance is 100:

- worker A: `UPDATE … WHERE available >= 60` → available is 100 → the
  predicate holds → the row is locked → `reserved = 60`, `available = 40` ✔
- worker B: the same `UPDATE` **blocks** on the row lock ✔ → when A
  commits, B re-evaluates the predicate against the new row (`available =
  40`) → 40 ≥ 60 is **false** → **zero rows** → B is refused ✔

**Exactly one reservation succeeds**, and the loser is told it has
insufficient credit ✔. No application-level lock is involved, and no
`SELECT … FOR UPDATE` is needed: the conditional `UPDATE` **is** the lock ✔.

---

## 5. The worker's authorization and the tenant boundary (R3)

### 5.1 The problem

M3's workspace token is bound to an **authenticated user session** and to a
**membership**. A durable worker cannot borrow one: a session is revoked on
logout, a worker's job may outlive any session, and a worker must be able
to act for a workspace **its job** names, not for one a user happens to
hold.

So the worker needs **its own credential**, with its own contract.

### 5.2 The contract

| | |
|---|---|
| **Who discovers and claims the jobs** | the **worker process** — but only through `li.claim_job()`, a `SECURITY DEFINER` function owned by the migration role, executable by the worker role only |
| **Who issues the execution credential** | the **control plane** (`ztech_control` ✔, or a dedicated issuer) — it signs a **job-scoped worker token** with the control-plane secret, the same secret the M2/M3 tokens use |
| **What the token binds** | `workspace_id`, `job_id`, `worker_id`, the job's **fencing token**, the **lease expiry**, the **issued-at** and the **expiry** |
| **How the worker opens a context** | `li.set_workspace_for_job(job_id, token)` — a `SECURITY DEFINER` function that verifies the token, checks the job, and writes the context **on the worker role's own connection**, so the RLS policies apply exactly as they do for a user ✔ |
| **How the authority ends** | the token's expiry, the **lease** expiry, the **fencing token** (a re-claim increments it, so the old worker's token is stale ✔), and the job's **state** (a cancelled or completed job invalidates it ✔) |
| **Who may execute each `SECURITY DEFINER` function** | the table in §5.6 ✔ |
| **Why a caller cannot claim or execute another tenant's job** | the claim function is executable **only** by the worker role ✔; the tenant runtime role (`ztech_app`) cannot execute it ✔; and the token is bound to **one** job, so it cannot reach another tenant's rows ✔ |

**The migrator and the `BYPASSRLS` credential are never in a worker
process.** The worker connects with `ztech_worker` ✔ (no `BYPASSRLS` ✔, no
ownership ✔), and every privileged operation it needs is a `SECURITY
DEFINER` function with a narrow grant ✔.

### 5.3 The token

The payload, like the M3 session token:

```
workspace_id | job_id | worker_id | fencing_token | issued_at | expires_at | kind='job'
```

signed with the control-plane secret ✔ (HMAC-SHA256 ✔), hex-encoded ✔, and
**bound to the job** ✔.

### 5.4 The context

`li.workspace_context` gains two columns: `context_kind` (`'session'` or
`'job'`) and `job_id`. A job context has **no** session and **no** user ✔ —
the authority is the job ✔.

`li.current_workspace()` then has two branches, and **both fail closed**:

| The context kind | The entitlement, re-checked on every read |
|---|---|
| `session` | the session is alive, it belongs to the user, and the user is an active member of the workspace ✔ (M3's rule ✔) |
| `job` | the job exists, it is `leased` or `running`, its `workspace_id` matches, **its `fencing_token` matches the context's**, and the lease has not expired ✔ |

So a job context dies the moment the job is re-claimed (the fencing token
moves ✔), the lease lapses ✔, the job is cancelled ✔ or completed ✔.

### 5.5 The failure modes, and what each one does

| | The worker's context | The worker's write of a result | The provider call |
|---|---|---|---|
| The worker crashes | the lease expires; the recovery decides (§3.4) | — | see §6 |
| The worker is paused and comes back | its token's fencing token is **stale** ✔ | refused: the `WHERE fencing_token = $2` matches **zero rows** ✔ | it must not dispatch: the ledger's `prepared` row is reused ✔ |
| The job is cancelled | the context is refused (the state is no longer `leased`/`running`) ✔ | refused ✔ | if the call is in flight, it becomes `uncertain` ✔ |
| The lease expires | the context is refused (the lease check) ✔ | refused ✔ | the recovery decides ✔ |

### 5.6 Who may execute what

| Function | `SECURITY DEFINER` | Executable by | Why |
|---|---|---|---|
| `li.claim_job(worker, lease)` | yes | **`ztech_worker`** only | it hands out jobs; the tenant roles may not call it |
| `li.renew_lease(job, fencing_token, lease)` | yes | `ztech_worker` | it extends a lease |
| `li.set_workspace_for_job(job, token)` | yes | `ztech_worker` | it opens a job-scoped context; it verifies the token, so it is safe to expose |
| `li.current_workspace()` | yes | the runtime roles | the RLS policies call it |
| `li.issue_worker_token(job, worker)` | yes | **`ztech_control`** | only the control plane signs worker credentials |
| `li.reserve_credits(...)`, `li.settle_credits(...)`, `li.release_credits(...)` | yes | **`ztech_worker`** | the worker holds and settles the credits, scoped to the job's workspace |
| `li.grant_workspace(workspace, role)` | yes | `ztech_identity` | the ceiling is the identity service's |

**Nothing in that table is executable by `ztech_app`** except
`li.current_workspace()` ✔, and `current_workspace()` only ever *reads* the
context ✔.

### 5.7 Why a tenant cannot reach another tenant's job

1. `ztech_app` **cannot execute** `li.claim_job()` ✔ — the grant is to
   `ztech_worker` only ✔.
2. `ztech_app` **cannot execute** `li.set_workspace_for_job()` ✔ — the
   grant is to `ztech_worker` only ✔.
3. Even a worker cannot open a context for a job it does not hold: the
   function checks the job's **fencing token** ✔, which only the current
   lease holder has ✔.
4. And the RLS policies on the queue's tables are **workspace-scoped and
   forced** ✔ — so even a statement that names another workspace's
   `job_id` returns nothing ✔.

### 5.8 The negative raw-SQL tests

Run as the **runtime role**, with raw SQL, not through the API:

| The attempt | The expected refusal |
|---|---|
| `SELECT li.claim_job('me', '5 minutes')` as `ztech_app` | **permission denied for function claim_job** ✔ |
| `SELECT li.set_workspace_for_job('<uuid>', '<token>')` as `ztech_app` | **permission denied** ✔ |
| `UPDATE li.job_queue SET state = 'succeeded' WHERE job_id = '<another workspace's job>'` as `ztech_app` | **zero rows** (the RLS policy) ✔ |
| `SELECT * FROM li.job_queue WHERE workspace_id = '<another workspace>'` as `ztech_app` | **zero rows** ✔ |
| `SELECT li.set_workspace('<another workspace>', '<forged context>')` as `ztech_app` | **no context**: the token is invalid, or the entitlement check fails ✔ |
| `SELECT li.issue_worker_token('<job>', 'me')` as `ztech_app` | **permission denied** ✔ |
| a worker using a token whose fencing token is stale | the context is refused ✔, and the result write affects **zero rows** ✔ |
| `set_config('app.workspace_id', '<uuid>', false)` as any runtime role | **no effect**: the context is not a setting ✔ (M2's C1 finding) ✔ |

---

## 6. The provider dispatch and its guarantees (R4)

### 6.1 What the unique constraint does, and what it does not

The unique `(provider, idempotency_key)` constraint makes a duplicate
**ledger identity** impossible: there is one row per logical invocation ✔.

It does **not** prevent:
- a second **physical HTTP request** with the same key ✔ — the row exists,
  but the network call is a separate thing ✔;
- a second **charge** — if the provider does not deduplicate, two calls
  cost twice ✔.

**Our database alone cannot guarantee exactly-once external charging.** We
can guarantee that *we* dispatch a logical invocation once, and we can make
the duplicate visible ✔; whether the provider charges once is a property of
**the provider's** deduplication ✔, and it is not ours to assume ✔.

### 6.2 The dispatch moments

| Moment | What is true | What the ledger says | What may be done next |
|---|---|---|---|
| **1. The transaction committed, before the network request began** | nothing was sent ✔ | `prepared` | the invocation may be dispatched ✔ — this is the only case where a dispatch is safe ✔ |
| **2. The request may have been sent** | it is unknown whether the provider received it ✔ | `dispatched` | **not** a re-dispatch ✔ → `uncertain` ✔ |
| **3. The provider acknowledged the request** | the provider accepted it ✔ | `confirmed` | the work may proceed ✔; the credits are settled ✔ |
| **4. The provider definitively rejected it, without charging** | it refused ✔ | `failed` | a re-dispatch is safe ✔ (nothing was charged ✔) — the retry policy applies ✔ |
| **5. The provider may have charged, but the response was lost** | the charge may have happened ✔ | `uncertain` | **not** a re-dispatch ✔ → reconcile, or a human decides ✔ |

**The rule: whenever the dispatch may have happened, the outcome is
`uncertain`, the reservation is retained, and an automatic retry is
prohibited** — unless the provider's deduplication guarantee for that
specific operation has been **verified** and recorded (§6.5) ✔.

### 6.3 The invocation lifecycle

```
prepare ──▶ dispatch ──▶ confirmed        (the provider acknowledged it)
   │            │
   │            ├──▶ failed              (the provider refused it; nothing charged)
   │            └──▶ uncertain           (the outcome is unknown)
   │
   └──▶ (the reservation is HELD; the job is queued but nothing was sent)
```

1. **prepare** — the worker inserts a ledger row in state `prepared` with
   the **idempotency key it will give the provider** and a
   `request_hash` ✔. The unique constraint makes a second prepare
   impossible ✔: a repeated job finds the existing row and continues it ✔.
2. **reserve** — the credits are reserved (§4) and the row moves to
   `dispatched` **in the same transaction as the reservation** ✔ — so a
   reservation and a "we are about to dispatch" are one fact ✔.
3. **dispatch** — the provider is called, with the idempotency key passed
   through ✔.
4. **confirm / fail / uncertain** — as §6.2 ✔.

### 6.4 The idempotency key, and the request-hash conflict

The key is **provider-scoped and tenant-namespaced**:

```
ztech:<provider>:<workspace_id>:<job_id>:<operation>:<attempt_kind>
```

- **provider-scoped** — two providers may use the same key ✔;
- **tenant-namespaced** — the workspace is in the key, so two tenants can
  never collide ✔;
- **stable across the retries of one logical invocation** — the same key is
  presented again ✔, so a provider that deduplicates deduplicates ✔;
- **different for a genuinely new invocation** — a new attempt of the same
  operation on the same job keeps the key ✔ (it is the *same* logical
  invocation ✔) and a different job gets a different key ✔.

**The request-hash conflict.** The row also stores `request_hash`, the hash
of the request. If the same key arrives with a **different** request, that
is a **conflict**, not a duplicate: the provider would treat it as the same
call with different arguments, and the outcome would be undefined. The
worker therefore **fails the job loudly** rather than dispatching a
conflicting request ✔.

### 6.5 The provider capability record

Whether a provider deduplicates is a **fact about that provider**, and it
is recorded, not assumed:

| | |
|---|---|
| `li.provider_capabilities` | `(provider, operation, supports_idempotency_key BOOL, supports_status_lookup BOOL, verified_at, notes)` |
| the effect | a re-dispatch of an `uncertain` invocation is permitted **only** where `supports_idempotency_key` is true **and** verified ✔ |
| the default | **false** for every provider and every operation ✔ — so an unverified provider is never automatically retried ✔ |

### 6.6 The corrected failure matrix

| Failure | The ledger | The credits | The job | The provider called again? |
|---|---|---|---|---|
| The worker crashes **before** the dispatch | `prepared` | the hold is **kept** | the lease expires → the recovery sees `prepared` → **requeued** ✔ | **Yes** ✔ — nothing was sent, and the same key is presented ✔ |
| The worker crashes **after** the dispatch, before the answer | `dispatched` | the hold is **kept** | the recovery sees `dispatched` → **`uncertain`** ✔ | **No** ✔ — unless the provider's deduplication is verified ✔ |
| The provider answers "no" | `failed` | the reservation is **released** ✔ | `failed` → backoff → `queued` (until the job's `max_attempts`) ✔ | **Yes** ✔ — a confirmed failure is safe to retry ✔ |
| The provider times out | `uncertain` | the hold is **kept** | `uncertain` ✔ | **No** ✔ — reconciled, or a human decides ✔ |
| The provider charged and the response was lost | `uncertain` | the hold is **kept** | `uncertain` ✔ | **No** ✔ |
| The worker is paused and returns with a stale fencing token | unchanged | unchanged | its result write affects **zero rows** ✔ | **No** ✔ — the work is discarded ✔ |
| The API creates the same job twice (the same idempotency key) | one row | one reservation | one job — the second request returns the first ✔ | **No** ✔ — the unique constraint is the guarantee ✔ |
| Two workers claim the same job | one row, one fencing token | one reservation | the loser's write affects zero rows ✔ | **No** ✔ |
| The reservation fails (insufficient credit) | `prepared`, never dispatched | nothing held | `failed` with a clear reason ✔ | **No** ✔ |
| The lease expires while the worker is working | `dispatched` | held | the recovery marks it `uncertain` ✔; the slow worker's write is fenced out ✔ | **No** ✔ |
| The same key is presented with a **different** request | — | — | the job **fails loudly** ✔ — a conflict, not a duplicate ✔ | **No** ✔ |

---

## 7. The team-level RLS (R5)

### 7.1 The model

| | |
|---|---|
| **The column** | `team_id UUID NULL` on the team-visible tables — the **saved searches** and the **pitch drafts** first, then the M1–M2 tables as they are needed |
| **`team_id IS NULL`** | the **workspace's general scope**: visible to every member of the workspace ✔. **No existing row is rewritten**, and no migration guesses which team an old record belonged to ✔ |
| **The team identity** | comes from the **protected authorization context** — the caller's membership — and **never** from a client-controlled session variable or a request parameter ✔ |

### 7.2 The scope functions

`li.current_team()` is a `SECURITY DEFINER` function, and it returns three
different things, so that "the member has no team" and "the context is
unknown" are **not** confused:

| It returns | When |
|---|---|
| the team `UUID` | the caller is a member with a team ✔ |
| the sentinel `'00000000-0000-0000-0000-000000000000'` | the caller is an **owner or an admin**, or a member whose membership carries **no** team ✔ |
| **`NULL`** | the caller's context is **unknown** or **not entitled** ✔ — and `NULL` is the **fail-closed** answer ✔ |

`li.current_write_team()` returns the team a caller may **write** into: the
member's own team ✔, `NULL` for a caller who may not write a team-scoped
row at all ✔ (a viewer ✔), and the sentinel for an owner or an admin ✔.

### 7.3 The exact predicates

Let `cw = li.current_workspace()` ✔ and `ct = li.current_team()` ✔.

| The actor | `USING` (read) | `WITH CHECK` (write) |
|---|---|---|
| **The organization / workspace owner** | `workspace_id = cw` ✔ | `workspace_id = cw` ✔, and any `team_id` ✔ |
| **The admin** | `workspace_id = cw` ✔ | `workspace_id = cw` ✔, and any `team_id` ✔ |
| **A member of team A** | `workspace_id = cw AND (ct = '<sentinel>' OR team_id IS NULL OR team_id = ct)` ✔ — so team A's rows and the general scope ✔ | `workspace_id = cw AND (ct = '<sentinel>' OR team_id IS NOT DISTINCT FROM ct)` ✔ — team A's own rows only ✔ |
| **A member of team B** | the same predicate, with team B's own scope ✔ | the same, with team B's own scope ✔ |
| **A member with no team** | `workspace_id = cw` ✔ — they see everything in the workspace ✔ (the sentinel ✔) | `workspace_id = cw AND (ct = '<sentinel>' OR team_id IS NULL)` ✔ — the general scope only ✔ |
| **A viewer** | the same predicate as a member ✔ (a viewer's limit is a **permission**, not a row) ✔ | **no write at all** ✔ — enforced by the **table grant** ✔: the viewer's role holds no INSERT/UPDATE/DELETE on a team-scoped table ✔ |
| **A worker with a job-scoped authority** | `workspace_id = cw` ✔ — its context is the job's workspace ✔ — and the team scope is the **job's** team ✔ (the sentinel when the job has none ✔) | the same ✔, plus the job's own scope ✔ |

**The fail-closed property.** When `ct` is `NULL` — the context is unknown,
or the caller's entitlement failed — every predicate above is `NULL` or
`false` ✔, and the policy reads **no rows** ✔ and **permits no write** ✔.
The corrected predicate for a teamless member is the sentinel case ✔, which
is what the earlier draft got wrong: it read as if a teamless member saw
only the general scope, where the intended treatment is that they see the
whole workspace ✔.

### 7.4 The protected membership check

`li.current_team()` reads the caller's **membership**, under the same
protection as M3's `li.session_entitled()` ✔: the function is
`SECURITY DEFINER` ✔, the runtime role may not read the identity tables
directly ✔, and the check is re-evaluated on every read ✔ — so a withdrawn
membership takes effect at once ✔.

For a **job** context, the team comes from the **job's** row ✔ (the
workspace's team scope that the job was created in ✔) and never from a
request ✔.

### 7.5 The forbidden team reassignment

The `WITH CHECK` above already prevents a team member from writing a row
**into** another team ✔. It does not, by itself, prevent an `UPDATE` from
**moving** a row from one team to another, because the `USING` clause sees
the old row and the `WITH CHECK` the new one — and a row that is visible
to team A and written into team B would be refused ✔, but a row that is
**general scope** and moved **into** team A would be allowed by the
predicate ✔ (team A may write team A's rows ✔).

**The rule the design needs:** a member may not change a row's team at all;
only an owner or an admin may. That is a **`BEFORE UPDATE` trigger** ✔,
because a policy cannot see the old value:

```sql
-- BEFORE UPDATE ON the team-scoped table
IF NEW.team_id IS DISTINCT FROM OLD.team_id THEN
  IF li.current_team() <> '<sentinel>' THEN    -- not an owner or an admin
    RAISE EXCEPTION 'the team of a record may not be changed here'
      USING ERRCODE = '42501';
  END IF;
END IF;
```

### 7.6 The cross-team exploit tests (raw SQL, as the runtime role)

| The attempt | The expected refusal |
|---|---|
| a member of team A reads a row of team B | **zero rows** ✔ |
| a member of team A updates a row of team B | **zero rows** ✔ |
| a member of team A deletes a row of team B | **zero rows** ✔ |
| a member of team A inserts a row with `team_id` = team B's | **row-level security violation** ✔ |
| a member of team A moves a general-scope row into team A | **refused by the trigger** ✔ (the team's may not be changed here ✔) |
| a member of team A moves a row into team B | **refused** ✔ |
| a member with no team reads a team-A row | **the row is visible** ✔ — that is the intended treatment ✔ |
| a member of workspace B reads any row of workspace A | **zero rows** ✔ |
| a client sends `team_id` in a request body | the value is **ignored** ✔ — the team's scope comes from the membership ✔; a write into another team is refused by the `WITH CHECK` ✔ |
| a client sets `team_id` through a session variable or a GUC | **no effect** ✔ — the scope comes from the protected function ✔ |

### 7.7 `CREATE INDEX CONCURRENTLY` with the transactional migration runner

`CREATE INDEX CONCURRENTLY` **cannot run inside a transaction block** ✔, and
the migration runner applies each migration in a transaction ✔. The runner
therefore needs a **declared** exception:

| | |
|---|---|
| the mechanism | a migration may declare itself **non-transactional** ✔ (a flag in the migration list ✔) |
| the rule | a non-transactional migration runs its statements **outside** a transaction ✔, one statement at a time ✔, and is **re-runnable** ✔ — which is why the index's creation is written to be idempotent ✔ (`IF NOT EXISTS` ✔) |
| the `team_id` migration | the column is added in a **transactional** migration ✔ (`020a` ✔), the index is created in a **non-transactional** migration ✔ (`020b` ✔), and the policy is added in a **transactional** migration ✔ (`020c` ✔) — **after** the column and the index exist ✔ |
| why the order matters | a policy that references a column that does not exist fails to be created ✔, and an index built before the column cannot be concurrent ✔ |
| the safety | the index is built **concurrently**, so the table is never locked for the duration ✔, and the migration is **repeatable** ✔ — a second run finds the index and does nothing ✔ |
| the visibility rule | until the policy is added, the table has **no** team restriction — which is the **pre-migration** behaviour ✔ (no visibility change) ✔ — and the whole sequence is applied in one deployment ✔ |

---

## 8. The worker and the API boundaries

| | The API | The worker |
|---|---|---|
| **Runs** | in the request/response path | in the background, on a timer |
| **Database role** | `ztech_app` | `ztech_worker` |
| **May** | create jobs, read a job's status, request a cancellation | claim jobs, execute them, write results, ledger rows and credit movements |
| **May not** | claim or execute a job, write a result, touch the credits directly | open a context for a job it does not hold, or for a workspace that is not the job's |
| **The workspace context** | the caller's **session** ✔ (M3 ✔) | the **job** ✔, through a job-scoped worker credential (§5 ✔) |

The worker never trusts the job's payload for authority: the payload carries
**data** ✔, and the authority is the workspace of the job, obtained from the
job row under RLS ✔.

The API never calls a provider directly: it creates a job and returns ✔. A
synchronous provider call is a **synchronous job** with a short lease ✔,
and the same ledger, the same credits and the same idempotency apply ✔.

---

## 9. The pre-authentication throttle (R6)

### 9.1 The problem, stated exactly

The login throttle is a **pre-authentication** control ✔: it runs **before**
there is a session, before there is a workspace, and before any tenant RLS
could apply ✔. So the authenticated tenant model — the workspace-scoped
policies, the session-bound token, the `current_workspace()` — **does not
exist yet** at that moment ✔, and the throttle must not pretend otherwise.

### 9.2 The design

| | |
|---|---|
| **The store** | `li.throttle_counters` ✔ — a table with **no** `workspace_id` ✔, because there is no workspace yet ✔ |
| **The role** | a **dedicated, least-privileged role** — `ztech_throttle` ✔ — that may read and write **only** `li.throttle_counters` ✔, and **nothing else** ✔. It may not read the tenant tables ✔, the identity tables ✔, or the queue ✔ |
| **The key** | the **email** and the **connection's address** ✔ — hashed ✔, so the table holds no email addresses ✔ |
| **Two buckets** | one for `(email, address)` ✔ and one for `(email)` alone ✔ — so a spray from many addresses is still limited per account ✔, and a failure from one address does not lock the same person out from another ✔ |
| **The atomic update** | one statement, in one transaction ✔:

```sql
INSERT INTO li.throttle_counters (bucket_key, window_started_at, attempt_count)
VALUES ($1, now(), 1)
ON CONFLICT (bucket_key) DO UPDATE
   SET attempt_count = CASE
           WHEN li.throttle_counters.window_started_at
                < now() - $2::interval THEN 1          -- the window expired
           ELSE li.throttle_counters.attempt_count + 1
       END,
       window_started_at = CASE
           WHEN li.throttle_counters.window_started_at
                < now() - $2::interval THEN now()
           ELSE li.throttle_counters.window_started_at
       END,
       updated_at = now()
WHERE li.throttle_counters.window_started_at < now() - $2::interval
   OR li.throttle_counters.attempt_count < $3
RETURNING attempt_count;
```

  Zero rows returned means **the limit is reached** ✔ → the attempt is
  refused ✔. The check and the increment are **one atomic statement** ✔,
  so N workers cannot each slip past the limit ✔.
| **The window** | 15 minutes ✔, and the counter row is **expiry-based** ✔: the row is reused when the window has passed ✔, so the table does not grow without bound ✔ |
| **The address** | the **connection's** address ✔ — never a header ✔ (M3's C4 finding ✔). Behind a proxy, the deployment declares how many proxies it trusts ✔, and the address is taken from the rightmost **untrusted** hop ✔. A forged `X-Forwarded-For` cannot spread the failures ✔, because the throttle also counts per **email** ✔ |
| **The data** | the bucket key is a **hash** ✔: the table holds no email address and no address ✔ |

**RG-8 stays OPEN** until this is implemented **and** tested against a
real PostgreSQL with a **pool of one** and with concurrent attempts from
several connections ✔. The plan does not claim it is solved ✔.

### 9.3 The reconciliation is data, not an endpoint

For the `uncertain` provider invocations, M4 may provide:

- the **data** ✔ — the ledger rows, the reservations, the `uncertain` jobs,
  and a reconciliation report that compares the ledger's confirmed totals
  with the provider's invoices ✔;
- a **backend-safe mechanism** ✔ — a function that records an operator's
  decision (with the decision, the actor, the reason and the timestamp ✔)
  ✔, callable **only** by a role that an authenticated operator surface
  holds ✔ — and that surface is **M6** ✔.

**M4 must not expose an unauthenticated manual operator endpoint** ✔, and
must not expose the ledger, the credits or the `uncertain` jobs to a
tenant through an unauthenticated path ✔. The reconciliation report is
therefore **not** served by the customer API ✔; it is a table and a
function, and the UI that reads them is M6's ✔.

---

## 10. The crash, retry and idempotency state table (R4, updated)

| Failure | The ledger | The credits | The job | The provider called again? |
|---|---|---|---|---|
| The worker crashes **before** the dispatch | `prepared` | held | the recovery sees `prepared` → **requeued** ✔ | **Yes** ✔ — nothing was sent ✔ |
| The worker crashes **after** the dispatch, before the answer | `dispatched` | held | the recovery sees `dispatched` → **`uncertain`** ✔ | **No** ✔ — unless the provider's deduplication is verified ✔ |
| The provider acknowledged the request | `confirmed` | **settled** ✔ | `succeeded` ✔ | — |
| The provider definitively refused it, without charging | `failed` | **released** ✔ | `failed` → backoff → `queued` ✔ | **Yes** ✔ — a confirmed failure is safe to retry ✔ |
| The provider may have charged and the response was lost | `uncertain` | held | `uncertain` ✔ | **No** ✔ |
| The worker is paused and returns with a stale fencing token | unchanged | unchanged | its result write affects **zero rows** ✔ | **No** ✔ |
| The API creates the same job twice | one row | one reservation | one job ✔ | **No** ✔ |
| Two workers claim the same job | one row, one token | one reservation | the loser's write affects zero rows ✔ | **No** ✔ |
| The reservation fails (insufficient credit) | `prepared`, never dispatched | nothing held | `failed` ✔ | **No** ✔ |
| The lease expires while the worker works | `dispatched` | held | the recovery marks it `uncertain` ✔; the slow write is fenced out ✔ | **No** ✔ |
| The same key with a **different** request | — | — | the job **fails loudly** ✔ | **No** ✔ |
| The provider's price is higher than the estimate | `confirmed` | settled with the **actual** ✔; the overrun is recorded ✔ | `succeeded` ✔ | — |
| The account's balance cannot cover the actual | `confirmed` | settled; the balance may go **negative** (the debt) ✔ | `succeeded` ✔ | — |

---

## 11. The test plan

Everything runs against a **real PostgreSQL 16**, with the real roles, and
**no real provider is ever called** ✔: the tests use a **mock provider**
that records its calls ✔, a deterministic clock where the plan needs one ✔,
and a fake billing account ✔.

| Area | The tests |
|---|---|
| **The state machine** | every legal transition; every illegal one refused; the state `CHECK` |
| **The credit model** | the four operations of §4.1; **the available is computed once** ✔ (the worked example of §4.6 is a test ✔); the balance is **unchanged** by a reservation ✔; a release does not charge ✔; a settlement charges the **actual** ✔; an overrun is recorded and the balance may go negative ✔ |
| **Credit concurrency** | two reservations of 60 against a balance of 100 → **exactly one** succeeds ✔; 1,000 concurrent reservations never drive the available below zero ✔; a settlement and a release racing on the same reservation → **one** applies ✔ |
| **Idempotency** | the same key creates one job; a **different** request with the same key is a **conflict** ✔; the same key in two workspaces is two jobs ✔ |
| **Claiming** | ten workers claim ten different jobs (`SKIP LOCKED`) ✔; the fencing token increments on every claim ✔ |
| **The fencing token** | a stale token writes **zero rows** ✔ |
| **The lease** | a crashed worker's job is reclaimed after the lease ✔; a heartbeating worker keeps its lease ✔; a worker whose lease lapsed loses its context ✔ |
| **The recovery** | the recovery of a `leased` job with no ledger row → requeued ✔; with `prepared` → requeued ✔; with `dispatched` → `uncertain` ✔; with `confirmed` → `succeeded` ✔; with `failed` → `failed` ✔ |
| **The dispatch** | the five moments of §6.2 ✔; a timed-out call is **never** automatically re-dispatched ✔ (counted at the mock provider ✔); the reservation is retained ✔; the capability record decides ✔ |
| **The worker credential** | a job-scoped token opens a context ✔; a token for another job is refused ✔; a stale fencing token is refused ✔; an expired lease is refused ✔; a cancelled job is refused ✔; a token issued for another workspace is refused ✔ |
| **The raw SQL, as the runtime role** | the table of §5.8 ✔; and the team table of §7.6 ✔ |
| **The throttle** | the limit is enforced ✔; the window expires ✔; two buckets ✔; the atomic update under concurrency ✔; a forged proxy header does not spread the failures ✔; **with a pool of one** ✔ |
| **Tenant isolation** | a worker for workspace A cannot read, write or claim a job of workspace B ✔ — asserted with raw SQL ✔ |
| **Regression** | the whole M0–M3 suite stays green ✔ — the persistence contract ✔, the API authorization suites ✔, the production provisioning path ✔, and the desktop suites ✔ |

**The measurable acceptance criteria.**

| # | Criterion |
|---|---|
| 1 | The available credits are computed **once**: after a reservation of `a` on a balance of `b`, the available is `b - a` and the balance is still `b` ✔ (asserted with the worked example) |
| 2 | No credit account's available is over-committed, under any concurrent schedule (1,000 concurrent reservations) ✔ |
| 3 | A settlement is applied **once**, and a release is applied **once** (asserted by repeating both) ✔ |
| 4 | Zero automatic re-dispatches of an `uncertain` chargeable invocation (counted at the mock provider) ✔ |
| 5 | A stale fencing token can never write a result (asserted with zero rows) ✔ |
| 6 | Cross-tenant, cross-team and cross-job access is impossible through raw SQL as the runtime role ✔ |
| 7 | The throttle's limit holds under concurrency, with a pool of one ✔ — and **only then** is RG-8 closed ✔ |
| 8 | The M0–M3 suites stay green, unchanged ✔ |

---

## 12. The owner decisions (D1–D8, revised)

These are **recommended design directions**, not an approval to implement
them ✔.

| | Decision | The options | The recommendation, and why |
|---|---|---|---|
| **D1** | **The worker's authority** | (a) a job-scoped worker credential, issued by the control plane; (b) a borrowed customer session; (c) the migrator's `BYPASSRLS` credential | **(a)** ✔ — a credential bound to one job, one workspace, one worker, one lease and one fencing token ✔ (§5 ✔). (b) dies with the user's session ✔; (c) would put the `BYPASSRLS` credential in a runtime process ✔ — which M2 forbids ✔ |
| **D2** | **The retry policy** | (a) one attempt, then `uncertain`; (b) up to five, with the ledger deduplicating; (c) unlimited | **A job's retry limit and an invocation's re-dispatch rule are different things** ✔: a job may be retried up to `max_attempts` ✔, but a **chargeable invocation** whose outcome is uncertain is **never automatically re-dispatched** ✔ (§6.2 ✔). The default is therefore "no automatic re-dispatch" ✔, and the job's own limit applies only to a *confirmed* failure ✔ |
| **D3** | **The `uncertain` resolution** | (a) the provider's status API, automatically; (b) an operator, manually; (c) both, in that order | **(c)** ✔ — but the automatic path is only available where the provider's capability is **verified** ✔ (§6.5 ✔), and the manual path **awaits a properly authenticated operator mechanism** ✔, which is M6 ✔ (§9.3 ✔). M4 provides the data and the backend-safe recording function, and **no endpoint** ✔ |
| **D4** | **The credit price** | (a) a fixed price per operation; (b) a platform-owned price table; (c) the provider's quote | **(b)** ✔ — a platform-owned price table, **snapshotted onto the reservation before the hold is taken** ✔, so the reservation's ceiling is the price at that moment ✔, with an explicit **cost-overrun policy** (§4.5 ✔): the actual is charged, the overrun is recorded, and the balance may go **negative** as a debt ✔ that blocks further reservations ✔. The commercial treatment of that debt is a product decision, and it is **not** settled here ✔ |
| **D5** | **The `team_id` default** | (a) `NULL` = the whole workspace; (b) a backfill into a "general" team | **(a)** ✔ — nullable general-scope team data ✔, with the **fail-closed** predicates of §7.3 ✔ and **no** migration guess ✔. A backfill would silently reinterpret history ✔ |
| **D6** | **The retention of the results** | (a) forever; (b) a fixed window with a workspace override; (c) per workspace | **(b)** ✔ — defined defaults: a job's **result** 30 days ✔, the **ledger** 400 days ✔ (the accounting needs it ✔), the **job events** 90 days ✔, and the **credit reservations** 400 days ✔. A workspace may **shorten** a window ✔ and may not extend one beyond the default ✔ — the safeguard is that the ledger's retention is a **platform** obligation ✔ (an accounting record) ✔ and a workspace may not shorten **it** ✔, because the reconciliation needs it ✔ |
| **D7** | **The shared throttle** | (a) the `li` schema's own tables, with a dedicated least-privileged role; (b) Redis; (c) one instance for the login path | **(a)** ✔ — a **pre-authentication** throttle with **its own** tables and **its own** role ✔, and **separate authorization boundaries** from the tenant data ✔ (§9 ✔). It is not the job queue's business ✔, and RG-8 stays open until it is implemented and tested ✔ |
| **D8** | **Real provider calls** | (a) mock providers only, during engineering; (b) a real provider with a spending cap | **(a)** ✔ — **mock providers only** during engineering ✔, with no real chargeable call without **separate owner approval** ✔. The first real call is the first real risk of a real charge ✔, and it is a decision, not a step ✔ |

**Genuinely unresolved, and needing the owner:**

| | The question | Why it is not decided here |
|---|---|---|
| **U1** | The **commercial treatment of a credit debt** — a grace period, a service suspension, a write-off? | A product decision ✔: the engineering records the debt and blocks the spending ✔; what happens next is commercial ✔ |
| **U2** | The **price of each operation** in ZTech's commercial terms, and the provider's own price per call | A commercial fact ✔, and it is an input to D4's table ✔ |
| **U3** | Whether the **providers support an idempotency key** and a **status lookup**, per provider and per operation | A fact about the providers ✔ that P0 must establish ✔ — and the plan's default is the safe one ✔ (no automatic re-dispatch ✔) |
| **U4** | The **team model** beyond the `team_id` column — teams as first-class entities, nested teams, cross-team sharing | A product model ✔; this plan proposes only the column and the predicates ✔ |
| **U5** | The **result retention** defaults (30/400/90/400 days) as commercial terms | The recommendation is stated ✔ (§D6 ✔); the numbers are the owner's ✔ |

---

## 13. The implementation phases, with their acceptance criteria

| Phase | What | The acceptance criteria |
|---|---|---|
| **P0 — the decisions** | D1–D8, and the provider facts (U2, U3) | the decisions are recorded; each provider's idempotency support, status-lookup support and price are known ✔ |
| **P1 — the queue** | `016_job_queue.sql`, the state machine, the claim and the recovery, the **job-scoped worker credentials** (§5), a worker that runs a no-op job | the state machine's tests pass ✔; ten workers claim ten jobs ✔; a stale fencing token writes zero rows ✔; a crashed worker's job is reclaimed, and the recovery's four ledger-driven decisions all hold ✔; a worker cannot open a context for a job it does not hold ✔ |
| **P2 — the ledger** | `017_provider_ledger.sql`, the mock provider, the dispatch lifecycle, the capability record | a repeated prepare is impossible ✔; the five dispatch moments hold ✔; a timed-out call is never automatically re-dispatched ✔; the request-hash conflict fails loudly ✔ |
| **P3 — the credits** | `018_credits.sql`, the reservation, the settlement, the release, the overrun | the worked example holds as a test ✔; the balance is unchanged by a reservation ✔; two concurrent reservations of 60 on a balance of 100 → one succeeds ✔; 1,000 concurrent reservations never over-commit ✔; the settlement and the release are idempotent ✔ |
| **P4 — the API surface** | the job endpoints, the cancellation, the ledger and credit **readings** (per the permission matrix), the permissions | a customer sees only their own workspace's jobs ✔; the matrix applies ✔; the cancellation is honoured at the next checkpoint ✔; **no unauthenticated operator endpoint exists** ✔ |
| **P5 — the team scope** | `020a/020b/020c`, the `team_id` column, the index, the policy, the trigger | the cross-team table of §7.6 holds, asserted with raw SQL ✔; the existing rows' visibility is **unchanged** ✔; the trigger refuses the reassignment ✔ |
| **P6 — the throttle** | `021_throttle.sql`, the dedicated role, the two buckets | the limit holds under concurrency ✔ with a pool of one ✔; a forged proxy header does not spread the failures ✔ — and **only then** is RG-8 closed ✔ |
| **P7 — the reconciliation** | the reconciliation report, the backend-safe operator recording function | the report never edits a confirmed record ✔; the recording function is callable only by the role the operator surface holds ✔; **no unauthenticated endpoint** ✔ |

**P0 is the only phase that may start before this plan is approved** ✔. P1–P7
are each separately approvable ✔ and each ends with its own green suite ✔.

---

## 14. The security boundaries, and the prohibited credential paths

**The boundaries.**

| The boundary | What it protects | What enforces it |
|---|---|---|
| The **control plane** | the secrets, the worker credentials, the token signing | the `ztech_control` role ✔, the control-plane secret ✔, the `SECURITY DEFINER` functions ✔ |
| The **worker** | the queue, the ledger, the credits — for the jobs it holds | the `ztech_worker` role ✔, the job-scoped credential ✔, the fencing token ✔, the lease ✔, the RLS policies ✔ |
| The **identity service** | the users, the sessions, the memberships, the invitations | the `ztech_identity` role ✔, the session-bound tokens ✔ |
| The **tenant runtime** | the tenant's own rows | the `ztech_app` role ✔, the RLS policies ✔, the session-bound context ✔ |
| The **throttle** | the login attempts, before any of the above exists | the `ztech_throttle` role ✔, its own tables ✔, no other privilege ✔ |

**The prohibited credential paths — these must never happen, and the
startup assertion should check them.**

| The prohibition | Why |
|---|---|
| The **migrator** (or any `BYPASSRLS` role) in a **worker** process | a worker would then read every tenant's rows without a context ✔ — the M2 boundary, dissolved ✔ |
| The **migrator** in the **API** process | the same ✔ |
| The **control-plane secret** in the **worker's** environment | the worker could sign its own credentials ✔ |
| The **control-plane secret** in a **browser** or a **mobile client** | anybody could mint a token ✔ |
| A **tenant's** credential in a **worker** process | the worker would act as a customer ✔ |
| The **database URL** with a superuser password in any runtime configuration | the superuser bypasses every policy ✔ |
| A **workspace token** in a **log**, a **header echo** or an **error message** | it is a bearer credential (RG-7 ✔) |

---

## 15. Explicitly out of scope

- **The platform console and the break-glass path** (M6): the operator
  authentication, the audit view, and the UI that reads the `uncertain` jobs
  and the reconciliation report ✔. M4 builds the data and the backend-safe
  recording function ✔ — and **no endpoint** ✔.
- **Authentication of the operators** (M6) ✔.
- **The CRM, the dashboards and the commercial surface** ✔ — the queue
  serves them ✔.
- **The providers themselves** ✔ — the queue calls them ✔.
- **Multi-region and sharding** ✔ — the queue is one PostgreSQL cluster's
  table ✔.
- **A message broker** ✔ — the queue is PostgreSQL ✔.
- **The desktop application** ✔ — it keeps its own sql.js store ✔.
- **ZuniSEO** ✔ — read-only, as always ✔.
- **A general-purpose workflow engine** ✔ — M4's queue is for AI and
  enrichment work ✔, not for arbitrary business workflows ✔.

---

## 16. What is not decided, and what is not known

- The providers' **idempotency and status-lookup support** is not
  confirmed per provider — U3 ✔, and the plan's default is the safe one ✔.
- The providers' **credit pricing** is not confirmed — U2 ✔.
- The **commercial treatment of a credit debt** is not decided — U1 ✔.
- The **result retention** defaults are a recommendation — U5 ✔.
- The **team model** beyond the column is not designed — U4 ✔.

**Nothing in this document is implemented. Awaiting approval.**
