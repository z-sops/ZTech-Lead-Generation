# F2 — ZTech Cloud SaaS architecture and implementation plan

**Date:** 2026-10-20 · **Revision 2** (after the architecture review decisions)
**Branch:** `feat/f2-cloud-saas-architecture` (based on the F0/F1 heads)
**Status:** **DESIGN FOR REVIEW — no implementation has started.**
**Author:** ZuniTech engineering

**Revision 2** incorporates the review decisions of 2026-10-20: Q5 (billing)
and Q6 (platform super admin) approved as modelled; Q7 (OI isolation)
approved as per-tenant, with §8.8 added; **Q8 (CRM identity resolution)
modified** — no automatic merge on a single signal — with §6.3 rewritten. The
seven critical requirements are traced in §1.4.

---

## 0. Summary for the reviewer

F0 and F1 produced a well-tested, evidence-first desktop application: a
Lead Intelligence engine with evidence provenance, ICP fitting, an 11-check
outreach gate, consent/suppression, mailbox pacing, follow-up sequences, reply
routing, and integrations with CoreClaw, ZuniSEO and Opportunity Intelligence.

**What F2 must not do is rewrite that.** The intelligence engine, the trust
model and the evidence contracts are the product's value. F2 turns them into a
**multi-tenant cloud service** and adds a **native CRM** around them.

Four decisions define the design:

1. **The intelligence engine is extracted, not rewritten.** Every module under
   `src/main/lead-intelligence/` that has no Electron dependency moves into a
   shared package (`@zunitech/lead-intelligence`) that both the desktop app and
   the cloud service import. The pure-domain inventory in §2.3 shows that
   roughly 70 % of the engine is already portable.
2. **PostgreSQL with row-level security is the isolation mechanism.** Every
   tenant-owned table carries `workspace_id`, and RLS policies are the *only*
   thing standing between two customers. The application role is **not** a
   table owner, so it cannot bypass RLS.
3. **The desktop app becomes a thin client of the same service.** The SQLite
   store is retired behind a repository interface; the desktop build keeps
   working against a local PostgreSQL (or a local single-tenant mode) while the
   cloud runs the same code multi-tenant.
4. **Every paid provider call is a durable job with a lease.** The
   idempotency key that already protects email sends is generalised into a
   `provider_invocations` ledger, so a retry can never bill CoreClaw twice or
   send a second email.

The full plan is §1–§12. §11 lists the milestones and their acceptance
criteria; §12 lists the risks and the decisions we need from you.

---

## 1. Scope, goals and non-goals

### 1.1 Goals

| # | Goal | How it is measured |
|---|---|---|
| G1 | Every customer is an isolated workspace | Automated cross-tenant denial tests (§5.6); no query path may reach another workspace's rows |
| G2 | A first-class CRM, not a lead list | The entity model in §6 exists with its own tables, workflows and audit |
| G3 | Each customer has an independent dashboard | The navigation in §7 is complete and role-filtered |
| G4 | PostgreSQL is the system of record | Every existing row in §3.3 is mapped to a table or an explicit discard decision |
| G5 | Work survives the browser closing | Jobs are leased, retried, recovered; the browser is never the owner of a run |
| G6 | The existing engines are reused, not rebuilt | §2.3 lists what moves unchanged and what changes |
| G7 | Platform administration is separate and audited | Admin access to customer data is a distinct, logged, break-glass path |
| G8 | Billing is a foundation, not a live charge | Entitlements, credits, metering, invoices exist; **no real payment or provider spend is activated** |

### 1.2 Non-goals for F2

- **No frontend rewrite.** The Electron renderer is not replaced. F2 adds a
  browser client as a *new* surface; the desktop app continues to work.
- **No real billing.** The schema, the entitlement engine and the metering
  pipeline are built and exercised in a simulated mode. No card is charged.
- **No change to ZuniSEO.** It stays an independent, read-only integration
  dependency. Its contract is consumed, never modified.
- **No live paid provider spend** without an explicit approval. The CoreClaw
  and OI adapters are wired, but the default entitlement for a new workspace
  is **zero credits**, so nothing is billable until an operator grants it.
- **The desktop app is not deprecated** in F2. It is supported.

### 1.3 What "complete commercial Cloud SaaS" means here

F2 delivers the *platform*; the commercial surface (plans, pricing, marketing
site, self-service signup flow) is a later phase that consumes it. The
difference matters architecturally: F2 builds the entitlements, credits,
metering and invoicing primitives **so that** billing can be switched on without
a schema change, not to switch it on.

### 1.4 The critical requirements, and where each is answered

| # | Requirement | Where | How it is proved |
|---|---|---|---|
| **R1** | Tenant isolation is enforced **at the PostgreSQL level** with carefully tested RLS. Application roles must not bypass RLS or accept untrusted workspace context. | §5.2, §5.3, §5.3.1, §5.3.2 | The startup role assertions (§5.3.1) fail the service if the app role is superuser, has `BYPASSRLS` or owns a tenant table. The denial suite (§5.6) asserts isolation **at the database level**. A request carrying a workspace identifier is **rejected**, not ignored. |
| **R2** | Isolation must hold across **APIs, background jobs, caches, file storage, search results and logs**. | §5.6, §5.8, §8.7 | §5.8 gives each surface its own rule and its own test: workspace-prefixed cache keys, workspace-prefixed object paths, a partitioned search index, and a closed allow-list of log fields. |
| **R3** | The existing Lead Intelligence security and outreach invariants must be preserved. | §2.4 | The 15 invariants are listed explicitly and are the **acceptance criteria** of the extraction (M0). The existing 1,990 assertions must pass unchanged. |
| **R4** | A local idempotency ledger alone cannot guarantee exactly-once execution by external providers. Uncertain outcomes must be modelled, and provider-side reconciliation must happen **before** a chargeable or message-sending operation is retried. | §8.4, §8.6 | The ledger models `reserved / attempted / accepted / failed / blocked / outcome_unknown`. A retry of an `attempted` invocation **does not call the provider** — it queues for reconciliation. The reconciliation probes are provider-side and bounded. |
| **R5** | The native CRM and the per-customer dashboards are **mandatory first-class parts** of the product. | §6, §7 | §6 defines the CRM entities, workflows and contracts; §7 defines 18 workspace screens and the platform console, each with its role visibility. |
| **R6** | All existing advanced features and historical records must be preserved through **tested** migrations. | §10 | §10.3 maps every legacy table; §10.4 states the conversion rules, including that the user's data is never deleted; M7's acceptance includes a round-trip test and an idempotency test. |
| **R7** | ZuniSEO remains an **independent** service. | §2.3, §3.1 | ZuniSEO appears only as an external dependency in the topology, is read-only, and its vendored contract is drift-checked in CI. Nothing in F2 modifies the ZuniSEO repository. |

### 1.5 The decisions taken at the architecture review (2026-10-20)

| # | Decision | Effect on this document |
|---|---|---|
| **Q5 — Billing** | **Approved.** A configurable model combining subscription plans, team seats, feature entitlements and usage credits. Credits are tracked in an auditable transaction ledger with reservations, settlement, refunds, spending limits and reconciliation. No real billing is activated and no prices are fixed. | §9.3 — the credit ledger is now a transaction ledger with the five operations, and the cost caps have four levels. |
| **Q6 — Platform super admin** | **Approved.** Controlled, time-limited, audited break-glass access only. No permanent unrestricted access to customer CRM records, messages, credentials or prospect information. | §5.7 — unchanged in intent, reinforced: the break-glass path is a temporary workspace membership, so every query still goes through the normal RLS policy and is captured by the audit triggers. |
| **Q7 — OI isolation** | **Approved.** Per-tenant OI isolation initially, with isolated storage, credentials and execution. Provisioning, operational costs, lifecycle management and a future migration path to a shared service must be documented. **Shared OI processing must not be activated until the cross-tenant isolation and security tests pass.** | §8.8 is new: the concrete isolation layers, the provisioning flow, the cost model, the lifecycle table, and the five-part activation gate for the shared instance. |
| **Q8 — CRM identity resolution** | **Modified.** No automatic merge on a single phone number or domain. Parent companies, branches, persons and contact points are separate. An automatic merge requires high-confidence, **corroborated** identity evidence; ambiguous matches go to human review. An audit trail and merge reversal are kept. | §6.3 is rewritten: the four records are separated, the signals have independence groups, and an automatic merge requires **two independent signals from different groups, no conflict, and no prior manual decision**. A single domain or a single phone number now only ever raises a **candidate**. |

---

## 2. Deliverable 1 — Current-code reuse and dependency map

### 2.1 What the desktop application actually is today

```
Electron main (main.js, 2,348 lines)
├── ipcMain            24 legacy channels + 12 Lead Intelligence registrars
├── AccountStore       sql.js (WASM SQLite) — ONE file: whatsapp.db
│   ├── numbers / jobs / targets / saved_searches / segments   (legacy, 5 tables)
│   ├── li_* (26 tables)  Lead Intelligence
│   ├── prospect_research / prospect_research_quarantine       (Round-1 bundle)
│   └── electron-store config.json  (settings + sealed credentials)
├── ProviderManager → CoreClawAdapter → coreClawClient         (collection)
├── Lead Intelligence runtime
│   ├── OutreachService (1,997 lines) · OutreachGate · TrustService
│   ├── MailboxService · SequenceService/Scheduler · ReplyRouterService
│   ├── ResearchCoordinator · ProspectIntelligenceGateway · Round1ResearchBridge
│   ├── OpportunityIntelligenceService/Gateway/AssociationStore/RefreshLedger
│   ├── EnrichmentService · IcpService · LeadContextService · ProfileService
│   └── LeadAgent · PitchGenerator · ExportService · LeadTimeline
├── prospect-research (vendored bundle) + credential-source + quarantine-sink
└── OI supervisor (spawns a Python child process)
```

### 2.2 The dependency problem, stated precisely

Three facts dominate the F2 design:

1. **There are zero foreign keys in the entire schema.** All 31 tables are
   linked by unenforced application-level string ids (`lead_id`, `pitch_id`,
   `sequence_id`, `mailbox_id`, `send_id`, `job_id`). This is deliberate and
   documented in the migrations. It is also the single biggest semantic change
   a PostgreSQL migration has to make, because PostgreSQL can enforce what
   SQLite could not — and enforcing it retroactively can fail on the user's
   existing dirty data.
2. **Idempotency is expressed as partial unique indexes**, not as a separate
   table: `li_jobs_one_active`, `li_ejobs_one_active`, `li_sends_one_accepted`
   (`WHERE state = 'accepted'`), `li_oi_refresh_one_pending`,
   `li_sequences_one_open`, `li_trust_events_once` (`WHERE state != 'rejected'`),
   `li_mailbox_sent_stored_id`, `li_suppressions_one` (an **expression index**
   over `IFNULL(workspace_id,'')`).
3. **Roughly half the tables store a serialised JSON document** in a `*_json`
   column (`packet_json`, `draft_json`, `definition_json`, `options_json`,
   `steps_json`, `value_json`, `record_json`, …). These are the *contract*
   objects (`EvidencePacket`, `PitchDraft`, `ResearchJob`, `EnrichmentJob`,
   `ResearchChange`) and they are already versioned by the Lead Intelligence
   contract layer. They should stay JSON in PostgreSQL — the contract is the
   API, and a relational projection of an evidence packet would be a new
   contract to maintain.

### 2.3 Reuse map — what moves unchanged, what changes, what is dropped

Legend: **MOVE** = extracted to the shared package unchanged ·
**ADAPT** = moved with a narrow, enumerated change · **KEEP-DESKTOP** = stays
in the Electron app · **REPLACE** = superseded by a cloud-native design.

| Module | Disposition | Notes |
|---|---|---|
| `LI/core/*` (`ids`, `objects`, `urls`, `validate`, `errors`) | **MOVE** | Pure. `validate.js` is a dependency-free JSON-schema subset validator — keep it; it is what makes the contracts portable. |
| `LI/contracts/*` (`constants`, `evidencePacket`, `provenance`, `leadView`, `validate`) | **MOVE** | The evidence contract, the provenance model, the `FACT_KEYS`/`AREAS`/`BASES` vocabulary. **This is the product's moat and it does not change.** |
| `LI/icp/*` (`icpFit`, `IcpService`) | **MOVE** | Pure ICP evaluation. |
| `LI/outreach/OutreachGate.js` | **MOVE** | Pure. The 11 checks, the reason codes, the defaults. Unchanged semantics. |
| `LI/outreach/PitchGenerator.js` | **MOVE** | Pure. `detectUnsupportedClaims`, `contentHash`, `PROHIBITED_CLAIM`. |
| `LI/agent/*` (`LeadAgent`, `sanitize`) | **MOVE** | Pure. `sanitizeUntrusted` / `INJECTION_PATTERNS` / `WITHHELD` are the untrusted-text boundary and must move intact. |
| `LI/research/*` (state machine, signals, freshness, digitalFootprint, changeDetection) | **MOVE** | The research state machine, `FreshnessPolicy` (a failed packet is never fresh evidence), change detection. |
| `LI/trust/*` (`trustContract`, `TrustPolicy`, `unsubscribe`, `relaySignature`) | **MOVE** | The consent/suppression vocabulary and the RFC 2369/8058 header rules. |
| `LI/mailbox/pacing.js`, `mailboxContract.js` | **MOVE** | The daily/hourly caps and the send-window rules. |
| `LI/sequences/sequenceContract.js`, `replyRules.js`, `replyRouteContract.js` | **MOVE** | The sequence/reply vocabularies and the classifier rules. |
| `LI/persistence/contract.js` | **MOVE** | `sendIdempotencyKey`, `normalizeSendRecord`, `ACTIVITY_TYPES`, `normalizeActivityQuery`. **The idempotency key is the seed of the provider-invocation ledger (§8).** |
| `LI/persistence/*Repos.js` (trust, mailbox, sequence, replyRoute) | **ADAPT** | The SQL is hand-written and SQLite-flavoured (`INSERT OR IGNORE`, `IFNULL` index, `COLLATE NOCASE`, `rowid`). They become repository implementations over a `pg` driver, with the same method names and the same semantics, plus `workspace_id` on every statement. |
| `LI/persistence/SqlJsStore.js` | **REPLACE** | The single-database, single-tenant, whole-file-rewrite store becomes a PostgreSQL pool behind the same repository method names. The **repository interface is preserved** so the callers do not change. |
| `LI/research/ResearchCoordinator.js` | **ADAPT** | The state machine, the retry policy and the `request_key` stay. The in-process `tick()` becomes a **leased worker** (§8). |
| `LI/research/ProspectIntelligenceGateway.js`, `Round1ResearchBridge.js` | **ADAPT** | Keep the identity rules, the block codes and the "never search for a domain" invariant. The provider transport becomes the cloud transport. |
| `LI/opportunity/*` (Service, Gateway, AssociationStore, RefreshLedger) | **ADAPT** | The refresh ledger's "write the intent *before* the request leaves" invariant becomes the durable job intent (§8.3). The gateway's contract validation stays. |
| `LI/outreach/OutreachService.js` | **ADAPT** | The **send order** (§2.4) is preserved exactly. The Electron-specific config stores (`electron-store`) are replaced by the server-side credential service (§9). The 1,997 lines are split: the pure decision part moves, the provider-adapter part stays behind an interface. |
| `LI/mailbox/MailboxService.js` | **ADAPT** | Gmail OAuth moves to a server-side mailbox service with per-workspace tokens; the pacing, the headers-only reply sync, the "a reply counts only when it cites a provider-stored Message-ID" rule and the market rules are unchanged. |
| `LI/sequences/SequenceService.js` + `SequenceScheduler.js` | **ADAPT** | The scheduler becomes a leased worker; the service's decision logic is unchanged. |
| `LI/enrichment/*` | **MOVE / ADAPT** | The waterfall, the field catalog and the job state machine move; the persistence becomes PostgreSQL. |
| `LI/search/*`, `LI/profile/*`, `LI/export/*`, `LI/timeline/*` | **MOVE** | The filters, the profile builder, the CSV/JSON export and the timeline. |
| `LI/providers/envelopeMapper.js` | **KEEP (shared)** | Just repaired in F0 (G-40). It is the anti-corruption layer for the ZuniSEO contract and must move **unchanged**, with the vendored contract and its drift test. |
| `LI/providers/transports/*` (REST, MCP, ArtifactImporter) | **ADAPT** | The REST transport is fixed in F0 (G-39). Move to the cloud with a server-side credential. |
| `src/main/providers/*` (CoreClaw adapter, ProviderManager, collectionProvider) | **ADAPT** | The `collectionProvider` contract (`REQUIRED_COLLECTION_METHODS`, `APPROVED_METADATA_FIELDS`) is the boundary for a multi-provider discovery layer (F3). |
| `src/main/coreclawClient.js` | **ADAPT** | Needs the F0 resilience policy (retry, breaker, health) before it can be called from a server with other tenants' money. |
| `src/main/prospect-research/*` (the vendored bundle) | **KEEP-DESKTOP for now** | It is a 2,446-line generated bundle (audit gap G-63). Moving it is a separate work item; the **cloud uses the ZuniSEO service directly** through the repaired transport, and the desktop keeps the bundle. |
| `src/main/lead-intelligence/trust/RelayClient.js` | **ADAPT** | The hosted relay is a per-deployment service; the HMAC auth scheme and the `RELAY_LIMITS` stay. |
| `src/main/accountStore.js` (3,521 lines) | **REPLACE** | It is the legacy single-tenant store. Its **behaviour** (the dedup rules, the target/segment/saved-search semantics, the quality report) is preserved in the CRM services (§6); the storage is replaced. |
| `main.js` IPC registrars | **REPLACE** | The desktop IPC becomes a thin adapter over the same HTTP API the browser client uses. |
| `src/renderer/**` | **KEEP-DESKTOP** | Not rewritten in F2. The browser client is new work. |
| `ztech-opportunity-intelligence` | **ADAPT (separate repo)** | It already has an HTTP surface. It needs: tenant scoping (G-46), a durable job store, and a per-workspace credential. Its engine code is reused as-is. |
| `zuni-seo` | **INTEGRATION ONLY** | Read-only. Consumed through the vendored contract. **Never modified.** |

### 2.4 The invariants that must survive the extraction

These are the properties the existing tests already protect. They are the
acceptance criteria for the extraction, and they are listed here so that a
reviewer can check the migration against them.

| # | Invariant | Enforced today by |
|---|---|---|
| I1 | An email/WhatsApp send is recorded as `attempted` **before** the provider is called, and a replay of the same `(channel, pitch_id, content_hash)` contacts nobody. | `OutreachService.sendEmail` order; `li_sends_one_accepted` partial unique index; `sendIdempotencyKey` |
| I2 | The outreach gate is re-evaluated immediately before every send, not only at approval time. | `OutreachService` step 3; `OutreachGate` |
| I3 | A failed research packet is never "fresh evidence". | `FreshnessPolicy` (`failedMaxAgeDays = 1`) |
| I4 | Website-derived text is untrusted and can never be a claim. | `sanitizeUntrusted`, `INJECTION_PATTERNS`, `WITHHELD`, `detectUnsupportedClaims` |
| I5 | A suppression is irreversible inside the product; it is only lifted explicitly, with a reason. | `TrustService.liftSuppression`, `li_suppressions_one` |
| I6 | The recipient of a send is re-read from stored facts at send time, not taken from the pitch. | `OutreachService` step 5 |
| I7 | A research job's identity is `(lead, domain, provider)`; a repeat reuses the job, never a second provider run. | `requestKeyFor`, `li_jobs_one_active` |
| I8 | A research result is bound to a lead by an explicit association, never by a name match; a `research_id` already owned by another lead is refused. | `OpportunityAssociationStore.assertLeadAssociation` |
| I9 | A refresh intent is written **before** the request leaves; a failure to record means nothing is sent. | `OpportunityRefreshLedger.open` |
| I10 | One mailbox may have at most one open sequence per lead, and a verified reply, an unsubscribe, a manual stop or a contact change stops it permanently. | `li_sequences_one_open`, `SequenceService._stopReason` |
| I11 | A reply counts only when it cites a provider-stored Message-ID of that mailbox's own sends **and** comes from the address the send went to. | `ReplyRouterService._route`, `MailboxService._intakeOne` |
| I12 | A capability is decided by **verification**, not by configuration. | `MailboxService.providers` |
| I13 | Every fact, finding and strength carries its own provenance. | `buildEvidencePacket` + `makeProvenance` |
| I14 | The research engine never invents a domain; it only researches the lead's own website. | `ProspectIntelligenceGateway` block codes |
| I15 | Only `standard` and `research` findings may be pitched. | `LeadAgent`, `PitchEvidenceBridge`, `OpportunityIntelligenceService` |

---

## 3. Deliverable 2 — Proposed cloud service architecture

### 3.1 The three-process topology

```
                      ┌──────────────────────────────────────────────┐
  Browser client ───► │  Edge: API gateway + web app                 │
  (React SPA)         │  · session cookie, CSRF, rate limit          │
                      │  · routes to the API service                  │
  Desktop app   ───►  │  · static assets (SPA)                        │
  (Electron)           └───────────────┬──────────────────────────────┘
                                      │  Authorization: Bearer <workspace token>
                      ┌───────────────▼──────────────────────────────┐
                      │  API service (Node.js, stateless)            │
                      │  · @zunitech/lead-intelligence (shared core) │
                      │  · CRM services, campaigns, dashboard        │
                      │  · REST /v1/*  (the desktop's IPC surface)  │
                      └──┬──────────────┬──────────────┬───────────┘
                         │              │              │
        ┌────────────────▼──┐  ┌────────▼──────┐  ┌───▼──────────────────┐
        │ PostgreSQL         │  │ Redis         │  │ Object storage (S3)   │
        │ + RLS              │  │ queue + cache │  │ artifacts, exports   │
        └────────────────────┘  └───────┬───────┘  └──────────────────────┘
                                         │
                      ┌──────────────────▼───────────────────────────┐
                      │  Job workers (N replicas, leasing)          │
                      │  research · collection · enrichment         │
                      │  qualification · sequences · billing        │
                      └──────┬────────────┬───────────┬─────────────┘
                             │        │           │
              ┌──────────────▼─┐ ┌────▼─────┐ ┌───▼──────────────┐
              │ ZuniSEO (read)  │ │ CoreClaw │ │ Opportunity      │
              │ OI service      │ │ (paid)   │ │ Intelligence      │
              └─────────────────┘ └──────────┘ └──────────────────┘
```

### 3.2 Service boundaries and why

| Service | Language | Holds | Why separate |
|---|---|---|---|
| **edge** | Node (Fastify) | Sessions, CSRF, rate limits, static SPA | Security choke point; the only thing that touches the browser |
| **api** | Node (Fastify) + TypeScript | All synchronous domain work | Stateless; scales horizontally; shares the core package with the desktop app |
| **worker** | Node (Fastify worker threads) | Everything long-running | A slow provider call must never hold an HTTP request; workers are the only place a paid call happens |
| **platform-admin** | Node (Fastify) + a separate SPA | Subscriptions, organizations, service health, provider spend, support, break-glass | A separate binary, a separate database role, a separate network policy, separate audit log |
| **oi** | Python (existing repo) | Competitive/opportunity research | Already a service; gains tenant scoping and a durable job store |
| **postgres** | PostgreSQL 16 | Everything | Row-level security is the isolation primitive |
| **redis** | Redis 7 | Queue, leases, rate-limit counters, short cache | Leases need TTL semantics Postgres does not give cheaply |
| **object storage** | S3-compatible | Research artifacts, exports, avatars, attachments | Large blobs never enter the database |

### 3.3 The shared core package

The critical architectural move. A workspace package:

```
packages/
  lead-intelligence/          @zunitech/lead-intelligence   (new)
    src/core/                 ← LI/core/*            (pure)
    src/contracts/            ← LI/contracts/*       (pure)
    src/icp/                  ← LI/icp/*             (pure)
    src/outreach/             ← LI/outreach/*        (pure parts only)
    src/agent/                ← LI/agent/*           (pure)
    src/research/             ← LI/research/*        (pure parts only)
    src/trust/                ← LI/trust/*           (pure parts only)
    src/mailbox/              ← LI/mailbox/*         (pure parts only)
    src/sequences/            ← LI/sequences/*       (pure parts only)
    src/enrichment/           ← LI/enrichment/*      (pure parts only)
    src/search/               ← LI/search/*          (pure)
    src/profile/              ← LI/profile/*         (pure)
    src/export/               ← LI/export/*          (pure)
    src/timeline/             ← LI/timeline/*        (pure)
    src/replies/              ← LI/replies/*         (pure)
    src/providers/            ← LI/providers/*       (envelope mapper + transports)
    src/persistence/          ← NEW: repository interfaces + PG implementation
    package.json              exports: no electron, no fs, no child_process
```

**Rule: the package must not import `electron`, must not touch the file
system, and must not spawn processes.** A test enforces this (the same shape as
the existing "no electron in the core" checks in the Lead Intelligence tests).

The desktop app imports the package. The cloud API imports the package. **There
is one implementation of the intelligence engine.**

### 3.4 The repository seam

Today the persistence is called directly (`store.jobs.insert(...)`). F2
introduces an interface, so the same service code can run against PostgreSQL
(cloud) or the existing sql.js store (desktop, during the transition):

```ts
// packages/lead-intelligence/src/persistence/interfaces.ts
export interface ResearchJobStore {
  insert(job: ResearchJobRecord): Promise<void>;
  update(job: ResearchJobRecord, expectedVersion: number): Promise<void>;
  get(jobId: string, ctx: WorkspaceCtx): Promise<ResearchJobRecord | null>;
  findActive(requestKey: string, ctx: WorkspaceCtx): Promise<ResearchJobRecord | null>;
  listByLead(leadId: string, ctx: WorkspaceCtx): Promise<ResearchJobRecord[]>;
  listDue(nowIso: string, ctx: WorkspaceCtx, limit: number): Promise<ResearchJobRecord[]>;
}
```

`WorkspaceCtx` is **required on every method** — the tenant is a parameter, not
an ambient global. A repository that forgets it cannot compile.

### 3.5 The desktop app in the new world

The desktop app keeps:
- its renderer (F2 does not rewrite the frontend),
- its local mode (a single-workspace deployment against a local PostgreSQL, or
  the existing sql.js store behind the same interfaces),
- its CoreClaw / ZuniSEO / OI connections for the local-service case.

It gains: a **sync** path to the cloud for customers who want their desktop
data in their workspace. That is a separate, later work item; F2 does not
assume it.

### 3.6 What runs where — the decision matrix

| Capability | Edge | API | Worker | Desktop |
|---|---|---|---|---|
| Session / auth | ✓ | verify | | |
| CRM read/write | | ✓ | | |
| Dashboard aggregates | | ✓ | | |
| Research (ZuniSEO) | | enqueue | **execute** | local (bundle) |
| Collection (CoreClaw) | | enqueue | **execute** | ✓ (existing) |
| Enrichment | | enqueue | **execute** | ✓ (existing) |
| Opportunity research (OI) | | enqueue | **execute** | ✓ (existing, local OI child) |
| Outreach draft / approve / gate | | ✓ | | ✓ |
| **Send** (email / WhatsApp) | | approve + enqueue | **execute** | ✓ (existing) |
| Sequence scheduling | | enqueue | **execute** | ✓ (existing) |
| Reply sync / routing | | enqueue | **execute** | ✓ (existing) |
| Usage metering | | record | aggregate | |
| Invoicing | | | ✓ (scheduled) | |

### 3.7 The external API surface (REST /v1)

The desktop app's ~80 IPC channels become REST resources. The mapping is
mechanical and the **channel names are preserved as the resource names**, so the
desktop adapter and the browser client speak the same language.

| Desktop channel (today) | Cloud resource | Method |
|---|---|---|
| `collector:get-numbers` | `/v1/leads` | GET (query, filter, page) |
| `collector:add-numbers` | `/v1/leads` | POST |
| `collector:update-lead` | `/v1/leads/{leadId}` | PATCH |
| `collector:quality-report` | `/v1/leads/quality-report` | GET |
| `collector:duplicate-review` | `/v1/leads/duplicates` | GET / POST (resolve) |
| `targets:list` / `targets:save` | `/v1/targets` | GET / POST / PATCH |
| `saved-searches:*` | `/v1/saved-searches` | CRUD |
| `segments:*` | `/v1/segments` | CRUD |
| `intelligence:icp` | `/v1/leads/{leadId}/icp` | POST |
| `prospect-research:request` | `/v1/research-jobs` | POST (202) |
| `prospect-research:get` | `/v1/research-jobs/{id}` | GET |
| `lead-intel:research-history` | `/v1/leads/{leadId}/research` | GET |
| `lead-intel:evidence-get` | `/v1/evidence-packets/{packetId}` | GET |
| `lead-intel:changes-list` | `/v1/leads/{leadId}/changes` | GET |
| `lead-intel:profile-get` | `/v1/leads/{leadId}/profile` | GET |
| `lead-intel:agent-analyze` | `/v1/leads/{leadId}/analysis` | POST |
| `lead-intel:pitch-generate` | `/v1/pitches` | POST |
| `lead-intel:pitch-get` / `pitch-update` | `/v1/pitches/{pitchId}` | GET / PATCH |
| `lead-intel:outreach-approve` | `/v1/pitches/{pitchId}/approval` | POST |
| `lead-intel:outreach-gate` | `/v1/pitches/{pitchId}/gate` | POST |
| `lead-intel:outreach-send` | `/v1/sends` | POST (202) |
| `lead-intel:outreach-sends` | `/v1/sends` | GET |
| `lead-intel:outreach-activity` | `/v1/activities` | GET |
| `lead-intel:outreach-ready` | `/v1/outreach/ready` | GET |
| `lead-intel:trust-*` | `/v1/trust/...` | CRUD |
| `lead-intel:mailbox-*` | `/v1/mailboxes/...` | CRUD |
| `lead-intel:sequence-*` | `/v1/sequences/...` | CRUD |
| `lead-intel:reply-routes` | `/v1/reply-routes` | GET / POST |
| `lead-intel:timeline` | `/v1/leads/{leadId}/timeline` | GET |
| `lead-intel:opportunity-*` | `/v1/opportunity/...` | GET / POST |
| `lead-intel:enrichment-*` | `/v1/enrichment-jobs` | POST / GET |
| `lead-intel:export-research` | `/v1/exports` | POST (202 → download URL) |
| `collection:submit` | `/v1/collection-jobs` | POST (202) |
| `settings:*` | `/v1/settings`, `/v1/provider-credentials` | GET / PATCH |
| `logs:export` | `/v1/audit-log` | GET |

**New in F2 (no desktop equivalent):**

| Resource | Purpose |
|---|---|
| `/v1/auth/*` | login, MFA, session, password reset |
| `/v1/orgs/*`, `/v1/members/*`, `/v1/invitations/*` | workspace and membership management |
| `/v1/roles`, `/v1/permissions` | the role catalogue |
| `/v1/companies`, `/v1/contacts`, `/v1/deals`, `/v1/pipelines`, `/v1/tasks`, `/v1/notes` | the native CRM |
| `/v1/campaigns`, `/v1/campaign-events` | campaigns and interaction history |
| `/v1/usage`, `/v1/credits`, `/v1/subscription` | entitlements, metering, plan |
| `/v1/jobs/{id}` | the unified job status surface |

**Conventions:**
- Every request carries an `Authorization: Bearer` workspace token issued by
  the edge; the API resolves it to a `WorkspaceCtx` (`workspaceId`, `userId`,
  `roles`, `permissions`, `entitlements`).
- Every response is `{ data, meta }`; every error is
  `{ error: { code, message, details? } }` with the **same code vocabulary**
  the desktop already uses (`INVALID_TRANSITION`, `ALREADY_ACCEPTED`,
  `NOT_FOUND`, `FORBIDDEN`, `MALFORMED_RESULT`, …) so that error handling
  does not fork.
- Idempotency: mutating endpoints accept `Idempotency-Key`; the service
  records it in the `provider_invocations` ledger (§8.4) and replays the
  stored outcome.

---

## 4. Deliverable 3 — PostgreSQL entity relationship design

### 4.1 Design rules

| Rule | Reason |
|---|---|
| **Every tenant-owned table has `workspace_id uuid not null`** and a leading index on it | RLS needs a single, uniform scoping column |
| **RLS is enabled and forced on every tenant table** | `FORCE ROW LEVEL SECURITY` applies the policy even to the table owner |
| **The application role is not the table owner and has no `BYPASSRLS`** | An owner bypasses RLS unless it is forced; the migration role owns, the app role does not. **The app role is additionally asserted to have neither `SUPERUSER` nor `BYPASSRLS` at startup** (§5.3) |
| **The workspace context is never accepted from the request** | A client-supplied tenant is the classic isolation bug. The context is set by the server, transaction-locally, from the authenticated session only |
| **No `SECURITY DEFINER` function may read a tenant table without a policy** | A definer function runs with the owner's rights and can silently bypass RLS; they are reviewed and, where unavoidable, carry their own `workspace_id` guard |
| **`created_at`/`updated_at` are `timestamptz`** | The legacy schema used `TEXT` ISO strings; a migration must convert them (§11) |
| **JSONB for the contract documents, columns for the queryable facts** | The evidence packet stays a document; the fields you filter on become columns |
| **Foreign keys are added, but `NOT VALID` then validated** | The legacy data has dangling ids; the migration must not fail on day one |
| **Ids keep their existing formats** (`li_*`, `pkt_`, `mbx_`, `seq_`, `res_`) | The contracts, the exported files and the tests all depend on them |

### 4.2 The ERD — platform and tenancy

```
                        ┌──────────────────────┐
                        │      platforms       │  singleton row
                        │ platform_state       │
                        └──────────┬───────────┘
                                   │ 1
                                   │
        ┌──────────────────────────▼───────────────────────────┐
        │                      orgs                             │  a customer company
        │  org_id            uuid PK                          │
        │  legal_name        text        (may be a placeholder)│
        │  slug              citext UNIQUE                     │
        │  status            text  (trial|active|suspended|closed)│
        │  plan_code         text                              │
        │  created_at        timestamptz                       │
        └───────┬────────────────────────────┬─────────────────┘
                │ 1                          │ 1
                │ N                          │ N
   ┌────────────▼─────────────┐   ┌──────────▼──────────────┐
   │        users             │   │      org_memberships    │
   │ user_id    uuid PK       │   │ membership_id uuid PK   │
   │ email      citext UNIQUE │◄──┤ user_id      uuid FK    │
   │ name       text          │ N │ org_id       uuid FK    │
   │ mfa_secret text (sealed) │   │ role        text        │
   │ status     text          │   │ status      text        │
   └──────────────────────────┘   │ invited_by  uuid FK     │
                                  │ created_at  timestamptz │
                                  └──────────────────────────┘

   ┌──────────────────────┐   ┌──────────────────────────┐
   │      invitations     │   │        roles             │  the role catalogue
   │ invitation_id  uuid  │   │ role_key   text PK       │
   │ org_id    uuid FK     │   │ label      text          │
   │ email     citext      │   │ rank       int           │
   │ role      text        │   │ permissions jsonb        │
   │ token_hash text       │   └──────────────────────────┘
   │ expires_at timestamptz│
   │ accepted_at timestamptz│   ┌──────────────────────────┐
   └──────────────────────┘   │     subscriptions        │
                              │ subscription_id uuid PK  │
                              │ org_id      uuid FK     │
                              │ plan_code   text        │
                              │ status      text        │
                              │ period_start timestamptz│
                              │ period_end   timestamptz│
                              │ credits_granted int     │
                              │ credits_used   int      │
                              │ provider_budget_cents int│
                              └──────────────────────────┘
```

### 4.3 The ERD — the CRM

```
   ┌──────────────────────┐         ┌──────────────────────────┐
   │       companies      │         │       locations         │
   │ company_id  uuid PK  │1───────N│ location_id  uuid PK    │
   │ workspace_id uuid    │         │ workspace_id uuid        │
   │ name        text     │         │ company_id  uuid FK     │
   │ domain      citext   │         │ kind        text        │ (hq|office|factory|store|remote)
   │ industry    text     │         │ address1..3 text        │
   │ category    text     │         │ city/region/postal/country│
   │ size_band   text     │         │ country_code char(2)    │
   │ lifecycle   text     │         │ lat/lng    numeric      │
   │ parent_company_id uuid FK NULL  │ is_primary boolean      │
   │ merged_into uuid FK  │         │ created_at  timestamptz│
   │ created_at  timestamptz│        └──────────────────────────┘
   └──────┬───────────────┘
          │ 1
          │ N
   ┌──────▼────────────────────────────────────────────────────┐
   │                          people                            │
   │ person_id   uuid PK                                        │
   │ workspace_id uuid                                          │
   │ full_name   text                                          │
   │ title       text        (decision-maker role)              │
   │ seniority   text                                          │
   │ is_decision_maker boolean                                 │
   │ company_id  uuid FK     NULL  (an independent contact)     │
   │ created_at  timestamptz                                   │
   └──────┬────────────────────────────────────────────────────┘
          │ 1
          │ N
   ┌──────▼────────────────────────────────────────────────────┐
   │                    contact_points                          │
   │ contact_point_id uuid PK                                  │
   │ workspace_id uuid                                          │
   │ person_id   uuid FK  NULL                                  │
   │ company_id  uuid FK  NULL                                  │
   │ channel     text  (email|phone|whatsapp|linkedin|other)    │
   │ value       text     (normalised)                         │
   │ e164        text     (phones only)                        │
   │ label       text     (work|mobile|direct)                 │
   │ verification text    (verified|unverified|invalid|unknown) │
   │ verified_at timestamptz NULL                              │
   │ source_observation_id uuid FK NULL                         │
   │ is_primary  boolean                                     │
   │ do_not_contact boolean                                    │
   │ UNIQUE (workspace_id, channel, value)                     │
   └─────────────────────────────────────────────────────────────┘
```

### 4.4 The ERD — pipeline, deals and activities

```
   ┌──────────────────────┐   ┌──────────────────────┐   ┌──────────────────────┐
   │      pipelines       │   │        deals         │   │      stages         │
   │ pipeline_id uuid PK  │1─N│ deal_id     uuid PK  │N─1│ stage_id    uuid PK  │
   │ workspace_id uuid    │   │ workspace_id uuid    │   │ workspace_id uuid    │
   │ name        text     │   │ pipeline_id uuid FK  │   │ pipeline_id uuid FK  │
   │ is_default  boolean  │   │ company_id  uuid FK  │   │ name        text     │
   │ position    int      │   │ contact_id  uuid FK  │   │ position    int      │
   │ UNIQUE(workspace_id,name)│ │ title       text     │   │ category   text     │ (open|won|lost)
   └──────────────────────┘   │ amount_cents bigint  │   │ probability numeric │
                              │ currency    char(3)   │   │ is_won/lost boolean │
   ┌──────────────────────┐   │ stage_id    uuid FK  │   └──────────────────────┘
   │       leads          │   │ owner_id    uuid FK  │
   │ lead_id     uuid PK  │N─1│ expected_close date   │
   │ workspace_id uuid    │   │ closed_at   timestamptz│
   │ company_id  uuid FK  │   │ created_at  timestamptz│
   │ contact_id  uuid FK  │   └───────────┬──────────┘
   │ qualification text  │               │ 1
   │ (unqualified|qualified|rejected)    │ N
   │ source        text  │   ┌───────────▼─────────────────────────┐
   │ status         text  │   │           activities               │
   │ owner_id       uuid │   │ activity_id  uuid PK               │
   │ created_at timestamptz│ │ workspace_id uuid                   │
   └──────────────────────┘   │ type      text (note|task|event|  │
                              │            call|meeting|email|   │
                              │            reply|research|stage)  │
   ┌──────────────────────┐   │ subject   text                     │
   │        tasks         │   │ body      text                     │
   │ task_id     uuid PK  │   │ due_at    timestamptz              │
   │ workspace_id uuid    │   │ done_at   timestamptz              │
   │ lead_id/company_id/  │   │ actor_id  uuid FK                  │
   │   contact_id/deal_id │   │ lead_id   uuid FK NULL             │
   │ title      text      │   │ company_id uuid FK NULL            │
   │ due_at     timestamptz│   │ created_at timestamptz              │
   │ status     text      │   └────────────────────────────────────┘
   │ assignee_id uuid FK  │
   └──────────────────────┘   ┌────────────────────────────────────┐
                              │            notes                   │
   ┌──────────────────────┐   │ note_id   uuid PK                   │
   │      campaigns       │   │ workspace_id uuid                   │
   │ campaign_id uuid PK  │   │ body     text                      │
   │ workspace_id uuid    │   │ lead_id/company_id/contact_id uuid │
   │ name        text     │   │ author_id uuid FK                  │
   │ channel     text     │   │ created_at timestamptz              │
   │ (email|whatsapp|research)│ └────────────────────────────────────┘
   │ status      text     │
   │ started_at/ended_at  │   ┌────────────────────────────────────┐
   │ UNIQUE(workspace_id,name)│ │      campaign_interactions          │
   └──────────┬───────────┘   │ interaction_id uuid PK            │
              │ 1             │ workspace_id uuid                │
              │ N             │ campaign_id uuid FK               │
   ┌──────────▼───────────┐   │ lead_id/contact_id uuid FK NULL   │
   │ campaign_interactions│   │ channel   text                   │
   │ interaction_id uuid  │   │ direction text (outbound|inbound)│
   │ campaign_id uuid FK  │   │ event     text (sent|opened|     │
   │ direction text       │   │  replied|clicked|bounced|        │
   │ (outbound|inbound)   │   │  unsubscribed|complained)        │
   │ event     text       │   │ provider_message_id text        │
   │ provider_message_id  │   │ occurred_at timestamptz          │
   │ occurred_at timestamptz│ └────────────────────────────────────┘
   └──────────────────────┘
```

### 4.5 The ERD — the Lead Intelligence core (preserved)

The existing `li_*` tables become the same tables with `workspace_id`, typed
timestamps, and a `jsonb` document column. **No column is dropped.**

| Existing table | New table | Change |
|---|---|---|
| `numbers` | `leads` | The legacy flat lead row is **kept** as `leads.legacy_row jsonb` for the first phase, then decomposed into `companies` + `people` + `contact_points` (§11.3). The `qualification`, `tags`, `notes` and the four `*Status` columns become real columns with CHECK constraints, because the CRM needs them queryable. |
| `jobs` | `collection_jobs` | `workspace_id` added; `query` renamed `query_text` (it is a reserved-ish word); `UNIQUE(provider_id, run_slug)` preserved. |
| `targets` | `icp_targets` | `workspace_id` added; the four JSON array columns become `jsonb`. |
| `saved_searches` | `saved_searches` | `workspace_id` added; `query` → `definition jsonb`. |
| `segments` | `segments` | `workspace_id` added; **the legacy `memberIds` JSON array and the `li_segment_members` table are merged** into one `segment_members` table (the duplication is a real defect — there are two segment stores today). |
| `li_research_jobs` | `research_jobs` | `workspace_id`; `state` keeps its CHECK; `options_json` → `jsonb`; the partial unique index on `request_key` becomes a partial unique index on `(workspace_id, request_key)`. |
| `li_evidence_packets` | `evidence_packets` | `workspace_id`; `packet_json` → `jsonb`; **plus** the `provenance` and `source_contract_version` columns that the document already carries, projected so they can be indexed. |
| `li_research_changes` | `research_changes` | `workspace_id`; `change_json` → `jsonb`. |
| `li_pitch_drafts` | `pitches` | `workspace_id`; `draft_json` → `jsonb`. |
| `li_outreach_approvals` | `pitch_approvals` | `workspace_id`. |
| `li_outreach_activity` | `activities` | **Merged with the CRM `activities`** — one activity ledger for both. The `activity_type` CHECK is widened with the CRM types. |
| `li_outreach_sends` | `sends` | `workspace_id`; `idempotency_key` preserved; the partial unique index becomes `(workspace_id, channel, idempotency_key) WHERE state='accepted'`. |
| `li_enrichment_jobs` / `li_enrichment_observations` | `enrichment_jobs` / `enrichment_observations` | `workspace_id`; `*_json` → `jsonb`. |
| `li_oi_associations` | `opportunity_associations` | `workspace_id`; the "never a name match" rule is now also a **unique constraint on `(workspace_id, research_id)`**. |
| `li_oi_refresh_requests` | `refresh_requests` | `workspace_id`; the partial unique index becomes `(workspace_id, lead_id) WHERE state='pending'`. |
| `li_suppressions` | `suppressions` | **This table already has a `workspace_id` column** (scope `global`/`workspace`). The global scope is the *platform* suppression list, owned by the admin role and readable by every RLS policy through a `platform` policy. |
| `li_contact_consents` | `contact_consents` | `workspace_id`. |
| `li_contact_provenance` | `contact_provenance` | `workspace_id`; PK becomes `(workspace_id, lead_id, field)`. |
| `li_trust_events` | `trust_events` | `workspace_id`; the partial unique index on `event_id` becomes `(workspace_id, event_id)`. |
| `li_recipient_refs` | `recipient_refs` | `workspace_id`. |
| `li_mailboxes` / `li_mailbox_sent` | `mailboxes` / `mailbox_sent` | `workspace_id`; the OAuth tokens move to the secret store (§9.3) — **the row keeps only the reference**. |
| `li_market_rules` | `market_rules` | `workspace_id`; PK becomes `(workspace_id, country_code)`. |
| `li_reply_reviews` | `reply_reviews` | `workspace_id`. |
| `li_sequences` / `li_sequence_steps` / `li_sequence_events` / `li_sequence_gaps` / `li_sequence_control` | same names | `workspace_id`; `li_sequence_control` becomes one row **per workspace** (`PK (workspace_id, id)` with `id = 1`). |
| `li_reply_routes` | `reply_routes` | `workspace_id`. |
| `prospect_research` / `prospect_research_quarantine` | `provider_research` / `provider_quarantine` | `workspace_id`; `record_json` → `jsonb`. |
| `li_schema_migrations` | `schema_migrations` | Unchanged semantics; a **separate** migration stream per service is preferred (§11.1). |

### 4.6 New tables introduced by F2

| Table | Purpose |
|---|---|
| `provider_invocations` | The **idempotency ledger for every paid provider call and every outbound message** (§8.4). Columns: `invocation_id`, `workspace_id`, `kind` (research|collection|enrichment|email|whatsapp|opportunity), `idempotency_key` (unique per workspace), `provider`, `provider_ref`, `state` (reserved|attempted|accepted|failed|blocked|unknown), `cost_cents`, `credits`, `request_fingerprint`, `response_digest`, `created_at`, `completed_at`. |
| `job_queue` | The durable job ledger (§8.2): `job_id`, `workspace_id`, `kind`, `state`, `payload jsonb`, `attempts`, `max_attempts`, `lease_owner`, `lease_expires_at`, `next_attempt_at`, `idempotency_key`, `cost_estimate_cents`, `cancel_requested_at`, `last_error`, `created_at`, `updated_at`. |
| `usage_events` | Metering: `usage_event_id`, `workspace_id`, `kind`, `quantity`, `unit`, `credits`, `occurred_at`, `source_invocation_id`. |
| `credit_ledger` | The credit balance: `entry_id`, `workspace_id`, `delta`, `reason` (grant|usage|refund|adjustment), `usage_event_id`, `created_at`. |
| `invoices` / `invoice_lines` | The billing record (§9.4), generated in **simulated** mode. |
| `audit_log` | Every privileged action, append-only: `audit_id`, `workspace_id`, `actor_type` (user|system|admin), `actor_id`, `action`, `resource_type`, `resource_id`, `before jsonb`, `after jsonb`, `ip`, `created_at`. |
| `entity_identities` | The identity-resolution graph: `identity_id`, `workspace_id`, `kind` (company|contact), `canonical_id`, `alias_type` (domain|phone|email|name), `alias_value`, `confidence`, `method` (rule|model|manual), `decided_by`, `created_at`. |
| `duplicate_candidates` | The queue of detected duplicates awaiting resolution: `candidate_id`, `workspace_id`, `left_kind/id`, `right_kind/id`, `score`, `signals jsonb`, `state` (open|merged|ignored), `resolved_by`, `created_at`, `resolved_at`. |
| `sso_connections` | Enterprise SSO (later phase): `connection_id`, `workspace_id`, `idp`, `metadata jsonb`, `domain`. |

### 4.7 Index and constraint translation notes

| SQLite construct | PostgreSQL equivalent |
|---|---|
| `CREATE UNIQUE INDEX … WHERE state='accepted'` | `CREATE UNIQUE INDEX … ON sends (workspace_id, channel, idempotency_key) WHERE state='accepted'` — and `ON CONFLICT` must repeat the predicate to infer the index |
| `IFNULL(workspace_id,'')` expression index | `COALESCE(workspace_id::text,'')` expression index |
| `INSERT OR IGNORE` | `INSERT … ON CONFLICT DO NOTHING` (the conflict target must be named) |
| `ON CONFLICT(x) DO UPDATE SET …` | identical syntax, but the target must be a unique index — the partial ones need the predicate |
| `COLLATE NOCASE` | `citext` (for names) or `ILIKE` |
| `rowid` / `last_insert_rowid()` | `RETURNING id` / `ctid` (never `rowid`) |
| `PRAGMA table_info(x)` | `information_schema.columns` |
| `TEXT` timestamps | `timestamptz`; the migration parses the ISO strings |
| `INTEGER 0/1` booleans | `boolean` |
| `db.getRowsModified()` | `rowCount` from the driver |
| `db.exec()` multi-statement | one statement per call, or a single multi-statement string inside an explicit transaction |
| `BEGIN/COMMIT` (sql.js is synchronous) | `BEGIN/COMMIT` around an async transaction; **the repository methods become `async`** |

**The last row is the most consequential change**: sql.js is synchronous, so
every repository method today is synchronous. The PostgreSQL implementation is
asynchronous. The repository interface (§3.4) therefore becomes `async`
throughout, and the services that call it become `async` — most already are
(the Lead Intelligence services are already promise-based), but a few
synchronous call sites in `OutreachService` and `SequenceService` will need
`await`. This is a **source-level change to the callers**, which is why the
extraction is staged (§11).

---

## 5. Deliverable 4 — Tenant isolation and access-control model

### 5.1 The isolation boundary

There are exactly **four** places where a tenant boundary can be crossed.
Each has one mechanism, and each mechanism is testable.

| # | Boundary | Mechanism | Test |
|---|---|---|---|
| B1 | **Request → workspace** | The edge authenticates the session and resolves exactly one `workspace_id` (plus the user's memberships). The body may never carry a tenant. | A request with a `workspaceId` in the body is rejected (`TENANT_MISMATCH`). |
| B2 | **Workspace → data** | PostgreSQL **row-level security** on every tenant table. The app role is not the owner, and the policies are `FORCE`d. | The cross-tenant denial suite (§5.6). |
| B3 | **Data → credential** | A secret is stored per `(workspace_id, provider)`. A request may only name a credential that belongs to its workspace. | A test that reads another workspace's credential by id. |
| B4 | **Data → outbound** | A job may only call a provider with the workspace's own credential and may only spend that workspace's credits. | A test that a job with a foreign credential is refused. |

### 5.2 Row-level security

```sql
-- Run by the migration role. The API role is NOT the owner.
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE  ROW LEVEL SECURITY;   -- applies even to the owner

CREATE POLICY leads_tenant_isolation ON leads
  USING      (workspace_id = current_setting('app.workspace_id')::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id')::uuid);
```

The API sets the tenant **per transaction**, never per session:

```ts
await tx(async (t) => {
  await t.set_config('app.workspace_id', ctx.workspaceId, true);  -- true = transaction-local
  return t.query('SELECT ... FROM leads WHERE ...');
});
```

`set_config(..., true)` is transaction-local, so a pooled connection cannot leak
one tenant's setting into another request. A `SET LOCAL` is not used because it
is not available on every driver path.

**Two policy classes exist:**

| Policy | Applies to | Rule |
|---|---|---|
| `*_tenant_isolation` | every tenant table | `workspace_id = current_setting('app.workspace_id')` |
| `*_platform_read` | `suppressions` (global scope), `market_rules` (platform defaults) | `workspace_id IS NULL OR workspace_id = current_setting(...)` — a **global** row is readable by every tenant but writable only by the platform role |
| `*_admin_breakglass` | every tenant table | `EXISTS (SELECT 1 FROM admin_grants WHERE ... AND expires_at > now())` — see §5.5 |

### 5.3 The role ladder

| Role | Grants |
|---|---|
| `ztech_migrator` | owns the schema; runs migrations; never used at runtime |
| `ztech_app` | `SELECT/INSERT/UPDATE/DELETE` on the app tables; **not** the owner; **no** `BYPASSRLS`; **no** `SUPERUSER` |
| `ztech_worker` | the same as `ztech_app`, plus `UPDATE job_queue` for leasing; still RLS-bound |
| `ztech_platform_admin` | the platform tables; **no** access to tenant tables except through the break-glass path |
| `ztech_breakglass` | a short-lived, logged role grant on a single workspace, issued by the admin console and expiring automatically |
| `ztech_readonly_analyst` | `SELECT` on de-identified views; never on raw tenant rows |

`ztech_app` is granted table privileges but **not** ownership, and RLS is
`FORCE`d, so a bug in the application code cannot read another tenant's rows.
This is the property that makes the isolation claim true rather than
aspirational.

#### 5.3.1 The role properties are asserted at runtime, not assumed

A migration that accidentally granted the wrong privileges would defeat every
policy. The service therefore **asserts its own role properties at startup**
and refuses to serve traffic if any of them is false:

```ts
// Run once, at boot, by the API and by every worker.
const r = await db.query(`
  SELECT rolsuper, rolbypassrls, (rolname = ANY (SELECT array_agg(rolname) FROM pg_roles
                                    WHERE pg_has_role(current_user, oid, 'USAGE')))
         AS is_owner_of_tenant_tables
  FROM pg_roles WHERE rolname = current_user`);
assert(!r.rolsuper,      'the application role must not be superuser');
assert(!r.rolbypassrls,  'the application role must not bypass RLS');
assert(!r.is_owner_of_tenant_tables, 'the application role must not own tenant tables');
```

**A failed assertion stops the service**, rather than starting it with a
weakened boundary. The same assertion runs in CI against a real PostgreSQL,
so a migration that grants the wrong privilege fails the build.

#### 5.3.2 The workspace context is server-derived, and it is not trusted

Three rules, enforced together:

1. The **only** source of `workspace_id` is the authenticated session
   (`session.workspace_id`), resolved by the edge from the membership table.
2. A request body, query string or header that contains a workspace
   identifier is **rejected** (`TENANT_CONTEXT_UNACCEPTED`) rather than
   ignored — silently ignoring it hides a client bug and makes an
   authorisation check ambiguous.
3. The context is set **transaction-locally** (`set_config(..., true)`), so a
   pooled connection cannot carry one tenant's context into another request.
   A transaction that forgets to set it sees **no rows** (the policy's
   `current_setting` is empty → the comparison is false), not all rows.

A worker is no different: it reads `workspace_id` from the **job row**, and
the job row was written by a request that had already passed authorisation.
A worker never accepts a workspace from a message payload.

### 5.4 Authentication

| Concern | Design |
|---|---|
| **Session** | An opaque, httpOnly, `Secure`, `SameSite=Lax` session cookie, stored server-side in Redis with a sliding expiry. **No JWT in a cookie** — a JWT cannot be revoked, and a customer must be able to cut off a departing user's access immediately. |
| **Password** | Argon2id (memory-hard), a per-user salt, and a rehash-on-login policy when the parameters change. |
| **MFA** | TOTP, optional but required for admins; the secret is sealed at rest (§9.3). |
| **Sessions and tokens for machine access** | A workspace API token: a random 32-byte secret, **only a SHA-256 hash stored**, a prefix for identification, scopes, and an expiry. Shown once. |
| **Invitation** | A single-use token, stored hashed, with an expiry, an org id, a role and an email binding. |
| **Brute force** | Per-account and per-IP rate limits at the edge, plus an exponential backoff on failed logins. |
| **CSRF** | A double-submit token for cookie-authenticated mutations; the API also accepts `Authorization: Bearer` for machine clients, which is not cookie-based and needs no CSRF token. |
| **Step-up** | Sending, exporting, deleting a workspace, and rotating a credential require a recent authentication. |

### 5.5 Authorisation model — roles and permissions

Five roles, each a bundle of permissions. A user's effective permissions are
the **union** of the memberships' role permissions, minus the explicit denials.

| Role | Scope | Can do |
|---|---|---|
| `owner` | the whole workspace | Everything, including billing, member management, workspace deletion and credential rotation. |
| `admin` | the whole workspace | Everything except billing ownership and workspace deletion. Can invite and remove members, rotate credentials, export. |
| `manager` | the whole workspace | CRM, pipeline, campaigns, research, approve pitches. **Cannot** manage members, credentials or billing. **Cannot** approve their own pitch (separation of duties). |
| `member` | the whole workspace | Read everything, work on assigned leads, draft and edit pitches. **Cannot** approve a pitch, send, manage members or see billing. |
| `viewer` | the whole workspace | Read-only. No drafts, no sends, no exports of contact data. |

**Two rules that are enforced in code, not just in the UI:**

1. **Self-approval is refused.** A pitch may only be approved by someone other
   than its author (`role >= manager` and `actor_id != pitch.author_id`). This
   preserves the meaning of the existing `HUMAN_APPROVAL` gate, which is a
   product safety property, not a UI convention.
2. **Export of contact data is a privileged action.** It is restricted to
   `admin` and `owner`, it is written to the audit log, and it is metered.

**Permission catalogue** (the fine-grained set behind the roles):

```
leads.read  leads.write  leads.assign  leads.merge
companies.read  companies.write
contacts.read  contacts.write  contacts.export
deals.read  deals.write  deals.advance_stage
pipelines.manage  tasks.manage  notes.manage
campaigns.read  campaigns.write  campaigns.send
research.run  research.read
pitches.draft  pitches.approve  pitches.send
mailboxes.read  mailboxes.manage  mailboxes.send
sequences.read  sequences.manage
trust.read  trust.write  trust.lift_suppression
credentials.read  credentials.write
members.read  members.invite  members.remove
roles.read  billing.read  billing.manage
workspace.delete  workspace.export
audit.read  usage.read
```

Every permission is checked **at the data-access boundary**, not only in the
handler, so a new endpoint that forgets a check fails its own tests.

### 5.6 Automated cross-tenant access-denial tests

This is the suite that makes the isolation claim testable. It is a mandatory
gate on every pull request, and it runs for **every** tenant table.

```
tests/tenancy/
  cross-tenant-denial.test.ts        every tenant table, every repository method
  rls-policies.test.ts              the policies themselves, against a real Postgres
  session-tenant-binding.test.ts     the edge never lets the body choose a tenant
  credential-isolation.test.ts       B3
  outbound-credential-isolation.test.ts  B4
  role-permission-matrix.test.ts     the full role × permission matrix
  breakglass-audit.test.ts           admin access is logged and expires
  bulk-export-isolation.test.ts      exports never cross a boundary
  background-job-isolation.test.ts    a worker cannot read another workspace's job
```

The core assertion, run against every table:

```ts
// workspace A creates a row; workspace B must not see it, even by primary key
const a = await asWorkspace('A').leads.insert(fixture);
await expect(asWorkspace('B').leads.get(a.id)).resolves.toBeNull();
await expect(asWorkspace('B').leads.update(a.id, {name: 'hijacked'}))
  .rejects.toMatchObject({ code: 'FORBIDDEN' });
// and the database agrees, independently of the application
await expect(db.query('SELECT * FROM leads WHERE id = $1', [a.id]))
  .resolves.toEqual([]);       // RLS, not the application
```

**The second assertion is the important one**: it proves the isolation comes
from the database, not from a `WHERE workspace_id = ?` that a future bug could
drop.

### 5.7 Platform administration and break-glass

The platform console is a **separate application** with its own binary, its own
role, and its own network policy (it can reach the API, the API's admin
endpoints are on a separate listener).

| Platform capability | Access to customer data |
|---|---|
| Manage organizations, plans, subscriptions | none |
| Service health, provider spend, queue depth | aggregate metrics only, never a customer row |
| Support request | a customer opens a support ticket; the admin sees **what the customer shares**, not the CRM |
| Break-glass | **explicit, time-boxed, logged**: the admin requests access, states a reason, a second admin (or the customer) approves, a 4-hour grant is created, every read is written to `audit_log` with the reason, and the grant expires automatically. The customer sees a banner in their dashboard. |

**Break-glass implementation**: a row in `admin_grants` `(grant_id, workspace_id,
admin_user_id, reason, granted_by, expires_at, revoked_at)`. The admin's
Postgres role gets a temporary membership row in the target workspace, so
**every query still goes through the normal RLS policy** and is captured by the
audit triggers. There is no `superuser` path into tenant data.

**Audit triggers** are installed on the sensitive tables (`leads`, `people`,
`contact_points`, `sends`, `credentials`, `audit_log` itself) so that a change
made outside the application is still recorded.

### 5.8 Isolation beyond the database

RLS protects the rows. It does not protect the **cache**, the **object
store**, the **search index** or the **logs** — and a leak in any of those is
just as serious. Each of the four is designed with the tenant in the key, not
around it.

| Surface | The rule | The test |
|---|---|---|
| **Cache (Redis)** | Every key is **prefixed with the workspace**: `z:{workspace_id}:…`. A cache read is built from the server-derived context, never from a request parameter. A cache entry is **not** shared between workspaces, even for a reference dataset that is identical. | A test writes a cached value for workspace A under A's prefix, then asks for the same key as workspace B and asserts a **miss**, not A's value. |
| **Object storage (S3)** | Every object lives under a **workspace-prefixed path**: `w/{workspace_id}/…`. The bucket policy grants `s3:PutObject` only for `w/${workspace_id}/*` for the workspace's own role. Object URLs are **short-lived and signed per workspace**; a URL issued for A cannot read B's object. | A test signs a URL for workspace A and fetches an object belonging to B; the fetch is denied by the bucket policy. |
| **Search** | The search index is **partitioned by workspace** (`index-{workspace_id}` or a mandatory `workspace_id` filter with a test that asserts the filter is present in every query). The platform's global search covers the **platform** tables only, never a tenant's rows. | A test issues a search as workspace B for a term that exists only in A, and asserts zero results — and asserts the query builder **refuses** to run without a workspace filter. |
| **Logs and traces** | **No tenant data is logged.** The log schema has a **closed allow-list of fields**; a field not on the list is not written. Workspace identifiers are logged as an **opaque hash**, not the raw id. A trace carries the workspace hash, never a contact point, a message body or a research document. | A test logs a full request context and asserts that no email address, phone number, domain, message body or research document appears in the output. |
| **Error messages** | A `404` is returned where a row exists in another workspace — the API never distinguishes "not yours" from "does not exist", so an error cannot be used to probe another tenant's ids. | A test asserts the status and the body are identical for "missing" and "belongs to another workspace". |
| **Background jobs** | A worker reads `workspace_id` from the job row; a job payload never carries a tenant. The worker's database session sets the context from the job row before every statement. | A test enqueues a job for A and asserts that a worker processing it cannot read B's rows, and that a tampered payload cannot redirect the job to another workspace. |
| **Backups and exports** | A backup is encrypted and held by the platform; a **customer export** is produced by a job that reads through the tenant's own context, so the export cannot contain another workspace's rows. | A test exports a workspace and asserts every row in the archive carries that workspace id. |

**The rule underneath all seven:** the tenant is part of every **key**, every
**path**, every **query** and every **log field** — not only of the table
predicate. A system that scopes the database but shares the cache has no
isolation at all.

---

## 6. Deliverable 5 — Native CRM workflows and data contracts

### 6.1 The CRM is a separate layer from the Lead Intelligence layer

The distinction the handover requires: **a SaaS subscriber is not a prospect**.

| | The subscriber | The prospect |
|---|---|---|
| Record | `orgs` / `users` | `companies` / `people` / `leads` |
| Lives in | the platform tables | a workspace's CRM tables |
| Is a lead | **never** | yes |
| Appears in campaigns | never | yes |
| Is emailed | never | yes, subject to consent and the gates |

A customer's own team members are **not** prospects. There is no path by which
a user record becomes a contact point, and the CRM tables have no
`workspace_id` exemption — the subscriber is *above* the workspace, not inside
it.

### 6.2 Entity contracts

Each contract states the invariants the code enforces. These are the same
"closed vocabulary" style the Lead Intelligence layer already uses.

**Company**
```
company_id      uuid
workspace_id    uuid          -- RLS
name            text          1..300
domain          citext        nullable, normalised, public hostname only
industry        text          nullable
category        text          nullable
size_band       text          enum(1|5|25|100|500|1000|5000|unknown)
lifecycle       text          enum(prospect|marketing|qualified|opportunity|customer|churned|rejected)
merged_into_id  uuid          nullable FK companies
source          text          enum(manual|collection|import|research|enrichment|api)
created_at      timestamptz
```
* A company with a domain is unique per workspace: `UNIQUE (workspace_id, domain) WHERE domain IS NOT NULL`.
* Merging sets `merged_into_id`; the merged record is read-only and hidden from the default list.

**Person**
```
person_id    uuid
workspace_id uuid
company_id   uuid  nullable   -- NULL means an independent contact
full_name    text  1..300
title        text  nullable
seniority    text  enum(exec|vp|director|manager|individual|unknown|not_applicable)
is_decision_maker boolean
```
* A person may hold several roles at one company over time: `person_roles(person_id, company_id, title, is_primary, from_at, to_at)`.
* A decision-maker **must** have at least one contact point to be pitchable — enforced by the outreach gate (the existing `CONTACT_FIELD` check), not by the schema.

**Contact point**
```
contact_point_id  uuid
person_id         uuid  nullable
company_id        uuid  nullable
channel           text  enum(email|phone|whatsapp|linkedin|other)
value             text  normalised (email lower-cased; phone E.164)
label             text  enum(work|mobile|direct|main|switchboard|unknown)
verification      text  enum(verified|unverified|invalid|unknown)
verified_at       timestamptz nullable
source_observation_id uuid nullable FK
is_primary        boolean
do_not_contact    boolean
```
* `UNIQUE (workspace_id, channel, value)` — one contact point per channel per value per workspace.
* **`verification` defaults to `unknown`.** A value is only `verified` when a source observation says so. **The system never fabricates a contact point**: enrichment records an *observation*, and a contact point is created only from an observation or a human entry. This is the F4 requirement expressed as a data rule.
* `do_not_contact = true` is set by a suppression and is **not** reversible by the CRM — only by the trust layer, which requires a reason (§6.5).

### 6.3 Duplicate detection and identity resolution

The existing desktop dedup rules (`DUPLICATE_REVIEW_RULES` with the precedence
`all → canonicalPhone → website-host → email → title+address`) are the
**starting point** and are preserved exactly. F2 adds a scale-appropriate
layer — and it **narrows** the automatic behaviour, per the approved
decision on identity resolution (Q8, modified).

#### 6.3.1 The four records are not the same thing

The CRM separates four things the legacy flat row conflated:

| Record | What it is | Never merged on |
|---|---|---|
| **Company** | A legal or trading entity. `parent_company_id` models a holding group. | — |
| **Location** | A place a company operates: an office, a factory, a shop, a remote site. | **A branch is never a duplicate of its parent.** Two locations of one company are two locations, not two companies. |
| **Person** | A human. One person may work for several companies. | — |
| **Contact point** | A channel address for a person or a company. | — |

A same-name company with a different domain is **not** a duplicate — it is a
different company. A company that appears at two addresses is **one company
with two locations**. A person who changed jobs is **one person with two
roles**. The legacy flat row cannot express any of this, which is exactly why
the promotion step (§10.3) groups rows rather than copying them.

#### 6.3.2 Candidate generation

Deterministic signals, generated inside the same transaction as the insert:

| Signal | Strength | Independence group |
|---|---|---|
| Normalised domain | strong | `domain` |
| Normalised phone (E.164) | medium | `phone` |
| Normalised email | strong | `email` |
| Name + locality | weak | `name` |
| Trading name / registration number | strong | `registration` |

#### 6.3.3 Resolution — no automatic merge on a single signal

**A single signal never merges anything.** A matching phone number alone does
not merge two companies, and a matching domain alone does not either: a shared
domain may be a franchise, a group company, a shared mailbox, or a
re-registration. Phone numbers are reassigned.

An **automatic merge** requires **corroborated, high-confidence evidence**:

1. **At least two independent signals** from **different independence
   groups** (for example: domain **and** phone; domain **and** a verified
   email; registration number **and** domain).
2. **No conflicting signal** — the records must not disagree on a
   discriminating field (a different registered address, a different trading
   name, a different company type).
3. **No manual-merge history** against either record (a human decision is
   never overridden by a later automatic one).
4. **Neither record is a parent of the other** — a branch is never merged into
   its parent.

Everything else is routed to **human review**.

| Evidence | Outcome |
|---|---|
| Two independent strong signals, no conflict | **auto-merge** (still audited and reversible) |
| One strong signal + one weak, no conflict | **review** |
| One signal only (domain, or phone) | **review** — never an automatic merge |
| Conflicting signals | **review**, flagged as a likely conflict |
| Different domains, same name | **not a duplicate** — recorded, so it is not re-proposed |
| Same domain, different address | **not a duplicate** — one company, two locations |

#### 6.3.4 The merge itself

- The **canonical** record is chosen deterministically (the oldest surviving
  id, so a merge is stable), and the other is merged into it.
- The loser's fields fill **only the gaps**; nothing is overwritten.
- The loser is **not deleted**. It is marked `merged_into_id`, kept for the
  audit trail, and hidden from the default list.
- `entity_identities` records every alias, so an **un-merge is a data
  operation, not a re-import**.
- Every merge writes an `audit_log` entry with the score, the signals, the
  decision and the actor.
- A merge **never touches** a suppression, a consent record or a sent
  message: those are address-keyed and historical, and they stay where they
  are.

#### 6.3.5 Identity resolution across the lead and the CRM

A collected lead is promoted into a company/contact by the same engine, and
the provenance of every field is preserved: a `contact_points.source_observation_id`
points at the `li_enrichment_observations` row that produced it, so a human
can always see *where* a phone number came from and *when*.

**A contact point is never created without a source.** Either an observation
exists, or a human entered it. The system does not fabricate a contact point,
and it does not fabricate the *evidence* for one.

### 6.4 Lead lifecycle and qualification

```
        collected ──► unqualified ──► qualified ──► in_opportunity ──► won
             │              │              │                │
             │              └────► rejected               └──► lost
             │
             └──► (research) evidence attached, ICP fitted
```

The existing `qualification` values (`unqualified`, `qualified`, `rejected`)
and the `QUALIFICATION` gate check are preserved. F2 adds the
`in_opportunity` / `won` / `lost` stages as **pipeline stages**, not as
qualification values, so the gate's meaning does not change.

**ICP fit is unchanged.** `evaluateIcpFit` and `targetToIcp` move verbatim; the
CRM's ICP is a `icp_targets` row, exactly as the desktop's `targets` table is
today. A target can be attached to a lead, a company or a contact — which is
new, and is the CRM's first real gain over the desktop.

### 6.5 Trust, consent and suppression, in the CRM

The trust layer is the **single owner** of contactability. The CRM reads it; it
never writes it.

| Rule | Where it is enforced |
|---|---|
| A suppressed address may not be contacted on that channel | `TrustService`, checked in the send path and in the CRM's contact panel |
| A contact point with `do_not_contact` is not selectable for a campaign | The CRM UI and the campaign builder refuse it |
| Consent is recorded with a method, a timestamp and an evidence note | `TrustService.recordConsent` (unchanged) |
| Lifting a suppression requires a reason and is audited | `TrustService.liftSuppression` + `audit_log` |
| A global suppression applies to every workspace | The `platform_read` RLS policy on `suppressions` |

**The CRM cannot create a contact point that is already suppressed.** Creating
one is allowed (a business may legitimately have a suppressed address on one
channel), but every read of the contact panel shows the suppression, and every
campaign selection excludes it.

### 6.6 Campaigns and interaction history

A campaign is a named, channel-bound batch of outreach to a selected set of
leads, with a lifecycle (`draft → scheduled → running → paused → completed →
cancelled`).

```
campaigns
  campaign_id, workspace_id, name, channel, status,
  started_at, ended_at, created_by

campaign_memberships        -- the selected leads
  campaign_id, lead_id, contact_point_id, state

campaign_interactions       -- the event ledger
  interaction_id, workspace_id, campaign_id, lead_id, contact_point_id,
  direction (outbound|inbound), event, provider_message_id, occurred_at
```

**Interaction events**: `sent`, `delivered`, `opened`, `clicked`, `replied`,
`bounced`, `unsubscribed`, `complained`.

**The interaction ledger is the source for the reply history.** The existing
`li_reply_routes` and `li_reply_reviews` become *derived views* over it: a
reply is an inbound interaction; the router classifies it and the human
confirms it, and the confirmation is stored on the route, not on the raw event.

**Campaign selection reuses the existing filter engine.** `matchLead(filter,
ctx)` and `resultRow(ctx)` move unchanged, so a saved search, a segment and a
campaign target all evaluate identically — one filter language, not three.

### 6.7 Assignment, follow-up and reminders

| Concept | Model |
|---|---|
| **Lead assignment** | `leads.owner_id` → a user. A bulk reassign writes an `activities` row of type `assigned` for each lead. |
| **Round-robin assignment** | A `assignment_rules` table per workspace: `(lead_source, industry, region)` → `owner_id`, with a daily cap. |
| **Follow-up** | A `tasks` row with `due_at`, `assignee_id`, `status` (open|done|cancelled), and a `reminders` schedule. |
| **Reminder** | A `tasks` row with `remind_at`; the worker creates a `notifications` row and, if the mail channel is enabled, a *notification* — **not** an outreach email. A reminder is an internal task, never a message to a prospect. |
| **Activity** | The single ledger for `note`, `task`, `event`, `call`, `meeting`, `email`, `reply`, `research`, `stage_change`, `assignment`. It is the CRM's timeline and it merges with the existing `li_outreach_activity`. |

### 6.8 The data contracts the CRM adds

| Contract | Contents |
|---|---|
| `CompanyContract` | the fields above, plus `source`, plus the merge fields |
| `PersonContract` | the fields above, plus `roles[]` |
| `ContactPointContract` | the fields above, plus `provenance` (source observation id, collected at, tier) |
| `LeadContract` | `lead_id`, `company_id`, `contact_point_id`, `qualification`, `status`, `owner_id`, `source`, `research_state`, `icp_fit`, `evidence_packet_id` |
| `PipelineContract` / `StageContract` | a pipeline is an ordered list of stages; a stage has a category, a probability and a won/lost flag |
| `DealContract` | `deal_id`, `pipeline_id`, `stage_id`, `company_id`, `primary_contact_id`, `amount_cents`, `currency`, `probability`, `expected_close`, `owner_id` |
| `TaskContract` / `NoteContract` | as above, with `due_at`, `assignee_id`, `status` |
| `CampaignContract` | the campaign, its membership and its interaction ledger |
| `DuplicateCandidateContract` | the pair, the score, the signals, the decision and who decided |
| `AuditEventContract` | `action`, `resource_type`, `resource_id`, `before`, `after`, `actor`, `at` |

---

## 7. Deliverable 6 — Customer dashboard navigation and feature specification

### 7.1 Two dashboards, not one

| Dashboard | Audience | Data |
|---|---|---|
| **Workspace dashboard** (the customer) | A customer and their team | Their leads, opportunities, research, pipeline, sales activity, campaigns, performance and subscription usage. **Strictly role-filtered.** |
| **Platform console** (ZuniTech) | ZuniTech staff | Subscriptions, organisations, service health, provider spending, support and system operations. **Never a customer's CRM rows** (§5.7). |

### 7.2 Workspace navigation

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ZuniTech · Acme Ltd ▾            [Search ⌘K]      [Credits 240]  [⚙] [👤] │
├────────────────┬─────────────────────────────────────────────────────────────┤
│                │  Acme Ltd · Overview                       [Invite member]    │
│ ⌂ Overview     │  ┌──────────┐┌──────────┐┌──────────┐┌──────────┐┌───────┐ │
│                │  │ New leads││ Qualified││ Pipeline ││ Campaigns││Usage  │ │
│ ◈ Leads        │  │   128    ││    34    ││  €412k   ││   6      ││ 62%   │ │
│  ├ Companies   │  └──────────┘└──────────┘└──────────┘└──────────┘└───────┘ │
│  ├ Contacts    │  ┌───────────────────────────┐┌───────────────────────────┐  │
│  └ Pipelines   │  │ Pipeline funnel          ││ Research queue           │  │
│                │  │  ████████ 28 new         ││ ● collecting 2  ⏱ 1     │  │
│ ⚑ Opportunities│  │  █████ 12 qualified      ││ ● enriching 4            │  │
│                │  │  ███ 7 proposal         ││ ● analysing 1            │  │
│ ✉ Campaigns   │  │  █ 3 won                 ││ Last sync 2 min ago      │  │
│                │  └───────────────────────────┘└───────────────────────────┘  │
│ ◷ Activities   │  ┌───────────────────────────┐┌───────────────────────────┐  │
│                │  │ Recent activity          ││ Needs your attention     │  │
│ 🔬 Research    │  │ · pitch approved (2)     ││ ! 3 replies to confirm   │  │
│                │  │ · reply from Rival Co    ││ ! mailbox needs reconnect│  │
│ ⚙ Settings    │  │ · research completed     ││ ! 1 deal closing soon    │  │
│                │  └───────────────────────────┘└───────────────────────────┘  │
│ ↳ Mailboxes   │                                                                     │
│ ↳ Team & roles│                                                                     │
│ ↳ Usage & plan│                                                                     │
└────────────────┴─────────────────────────────────────────────────────────────┘
```

### 7.3 The screens, with their role visibility

The role column says **who can see the screen at all**; the column filter
inside a screen further narrows the rows.

| # | Screen | What it does | Role visibility |
|---|---|---|---|
| 1 | **Overview** | Lead funnel, pipeline value, research queue, recent activity, "needs your attention" | owner, admin, manager, member, viewer (viewer: counts only, no names) |
| 2 | **Leads** | The lead list: the existing `collector:get-numbers` query, now with company, contact, owner, status, qualification, research state, ICP fit | all; viewer read-only; member sees assigned first (a filter, not a restriction) |
| 3 | **Company detail** | Company, its locations, its people and contact points, its deals, its timeline, its research, its duplicate candidates | all (read-only for viewer/member) |
| 4 | **Contact detail** | The person, their contact points, consent and suppression state, interactions, tasks | all |
| 5 | **Pipeline** | A drag-and-drop board of deals by stage; stage configuration; weighted forecast | owner, admin, manager, member (member: own deals only) |
| 6 | **Opportunities** | The OI research view — the existing opportunity panel, per lead and per company | all; viewer sees the summary but not the raw evidence |
| 7 | **Research** | The research job queue, the evidence packets, the changes over time, the ICP fit | all; viewer sees the packet summary, not the full evidence document |
| 8 | **Campaigns** | Build, schedule, run, pause a campaign; the interaction ledger; the reply history | owner, admin, manager, member (member: draft and read; send is manager+) |
| 9 | **Activities** | The unified timeline: notes, tasks, emails, replies, research events, stage changes. Filterable by type, lead, owner, date | all; member sees their own + their leads |
| 10 | **Tasks** | My tasks, team tasks, due today, overdue; reminders | all |
| 11 | **Mailboxes** | Connected mailboxes, their limits, the pacing window, the market rules, the reply sync status | owner, admin, manager (member: read their own sends) |
| 12 | **Sequences** | Follow-up sequences, their steps, their state, the pause-all switch | owner, admin, manager |
| 13 | **Suppressions & consent** | The suppression list, the consent records, the lift action | owner, admin, manager (member: read; lift is admin+) |
| 14 | **Team & roles** | Members, invitations, roles, permissions | owner, admin (owner only: remove an owner) |
| 15 | **Credentials** | Provider credentials, per workspace; write-only, never displayed | owner, admin |
| 16 | **Usage & plan** | Credits, the meter, the period, the invoices (simulated) | owner (read), admin (read) |
| 17 | **Audit log** | Every privileged action in the workspace | owner, admin |
| 18 | **Settings** | Business profile, the outreach offer, the email and WhatsApp configuration | owner, admin |

**Role filtering is applied at the query, not in the UI.** A member who
requests a lead they may not see receives a `403`, not an empty row.

### 7.4 The platform console navigation

```
┌────────────────────────────────────────────────────────────────────────┐
│ ZuniTech Platform Console                        [admin] [break-glass]│
├──────────────────┬─────────────────────────────────────────────────────┤
│ ⌂ Overview       │  MRR · active orgs · jobs queued · provider spend   │
│ 🏢 Organizations │  Acme Ltd  plan=Scale  credits 240/500  seats 4/8   │
│ 👤 Users          │  Globex    plan=Starter suspended  credits 0/50      │
│ 💳 Subscriptions │  Initech   plan=Scale  trial ends 2026-11-02       │
│ 📊 Usage & spend │  CoreClaw today: €41.20 / €500 daily cap          │
│ ⚙ Providers      │  ZuniSEO   3 runs, 1 failed, p95 41 s              │
│ 🩺 Service health │  OI        6/6 workers healthy, queue depth 2       │
│ 🎫 Support       │  Ticket #412  "cannot find my lead"  org=Acme Ltd     │
│ 🛡 Audit         │  break-glass grants: 1 active, expires in 2h       │
│ ⚙ Configuration  │  credit grants, plan catalogue, feature flags      │
└──────────────────┴─────────────────────────────────────────────────────┘
```

**The console never renders a customer's CRM rows.** A support action opens a
*customer-initiated* support session whose scope the customer granted.

### 7.5 Dashboard performance and the aggregation strategy

Dashboards read **materialised aggregates**, not the raw tables.

| Aggregate | Refresh | Serves |
|---|---|---|
| `agg_lead_funnel` (per workspace, per day) | hourly + on change | the funnel |
| `agg_pipeline_value` (per workspace, per stage) | on deal change | the pipeline value |
| `agg_research_queue` (per workspace) | every 30 s | the research queue |
| `agg_campaign_events` (per workspace, per campaign) | every 5 min | the campaign counters |
| `agg_usage_daily` (per workspace, per day) | every 15 min | the usage panel |

The aggregates are **per workspace** and are themselves RLS-protected, so they
cannot leak a tenant's numbers.

---

## 8. Deliverable 7 — Background-job and recovery design

### 8.1 The problem, stated from the existing code

Three job systems already exist, each with its own scheduler, and all of them
are **in-process**:

| System | Today | Problem in the cloud |
|---|---|---|
| `ResearchCoordinator` | `setInterval` tick every 15 s, `recover()` on start | The tick dies with the process; a job in flight is lost |
| `EnrichmentService` | `tick()` every 30 s, `recover()` on start | same |
| `SequenceScheduler` | `setInterval` every 60 s, `sweep()` | a sequence step due while the process is down is sent late, and a step that was *being* sent is ambiguous |
| `OpportunityIntelligenceService` | a single in-flight request per lead, a refresh ledger | the ledger is in-process; a crash loses the intent |
| `OpportunityRefreshLedger` | an in-memory or SQLite-backed intent | the "write the intent before the request leaves" property must survive a crash |

**And the most important constraint:** the paid providers must not be billed
twice, and a prospect must never receive two identical emails.

### 8.2 The unified job model

One table, one queue, one lease protocol, for every kind of work.

```
job_queue
  job_id             uuid pk
  workspace_id       uuid          -- RLS
  kind               text          enum(research|collection|enrichment|opportunity|
                                     sequence_step|reply_sync|qualification|export|billing)
  state              text          enum(queued|leased|running|succeeded|failed|
                                     cancelled|dead_letter|blocked)
  payload            jsonb         -- the kind-specific request
  idempotency_key    text          -- UNIQUE (workspace_id, idempotency_key)
  attempts           int
  max_attempts       int
  lease_owner        text          -- the worker instance
  lease_expires_at   timestamptz
  next_attempt_at    timestamptz
  cost_estimate_cents bigint
  cost_actual_cents  bigint
  cancel_requested_at timestamptz
  last_error         jsonb
  created_at         timestamptz
  updated_at         timestamptz
  completed_at       timestamptz
```

**The lease protocol** (the standard, and the reason a worker crash is
recoverable):

```sql
-- Claim up to N jobs, atomically, skipping any whose lease is still live.
UPDATE job_queue SET
  state = 'leased',
  lease_owner = $worker,
  lease_expires_at = now() + interval '60 seconds',
  attempts = attempts + 1,
  updated_at = now()
WHERE job_id IN (
  SELECT job_id FROM job_queue
  WHERE state IN ('queued')
     OR (state IN ('leased','running') AND lease_expires_at < now())
  ORDER BY next_attempt_at
  FOR UPDATE SKIP LOCKED
  LIMIT $n
)
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` means N workers never contend for the same row, and
a worker that dies has its lease expire, after which the job is claimable
again. **A job is never lost and never runs twice concurrently.**

**Recovery** on worker start and on a periodic sweep:
1. `leased`/`running` with an expired lease → back to `queued` (if attempts
   remain) or `dead_letter`.
2. `queued` past `next_attempt_at` → claimable (that is the normal path).
3. `running` with no lease owner (a process died before leasing) → reclaimable.

**Retries** are exponential with jitter, capped, and **bounded by attempts**:

```
delay = min(base * 2^(attempts-1), max) + random(0, jitter)
```

| Job kind | `max_attempts` | Retryable errors | Non-retryable |
|---|---|---|---|
| `research` | 5 | timeout, 5xx, provider unavailable | invalid domain, blocked identity, contract violation |
| `collection` | 3 | timeout, 5xx | invalid parameters, budget exceeded |
| `enrichment` | 3 | timeout, provider unavailable | field not found, contract violation |
| `sequence_step` | 3 | mailbox temporarily unavailable | unsubscribed, suppressed, gate blocked |
| `reply_sync` | 5 | timeout, 5xx, token refresh failure | mailbox disconnected |
| `export` | 2 | timeout | quota exceeded |

### 8.3 From the existing models to the unified model

| Today | Becomes | Preserved property |
|---|---|---|
| `ResearchCoordinator` + `li_research_jobs` | A `job_queue` row of kind `research` **plus** the `research_jobs` row it already keeps | The `request_key` (`stableHash('research', leadId, domainKey, providerId)`) becomes the job's `idempotency_key`, and the partial unique index `li_jobs_one_active` becomes `UNIQUE (workspace_id, idempotency_key) WHERE state IN (...)`. **One active research per (lead, domain, provider) survives.** |
| `EnrichmentService` + `li_enrichment_jobs` | A `job_queue` row of kind `enrichment` **plus** the `enrichment_jobs` row | The partial unique index `li_ejobs_one_active` on `(lead_id)` becomes `(workspace_id, lead_id)`. |
| `OpportunityRefreshLedger` | A `job_queue` row of kind `opportunity` | **The intent is written before the request leaves** — now durable, in PostgreSQL, not in memory. |
| `SequenceScheduler.sweep()` | A `job_queue` row of kind `sequence_step` | The "at most one step per mailbox per tick" rule becomes a per-mailbox lease. |
| `CollectionJob` (`jobs` table) | A `job_queue` row of kind `collection` | `UNIQUE (provider_id, run_slug)` becomes the job's idempotency key. |
| Mailbox reply sync | A `job_queue` row of kind `reply_sync` | The reply-detection rule (a stored Message-ID) is unchanged. |

**The two tables are not merged.** The `job_queue` is the *execution* ledger;
`research_jobs` / `enrichment_jobs` are the *domain* ledgers with their own
state machines and their own partial unique indexes. The queue row points at
the domain row by id. This preserves the existing state machines verbatim and
adds durability around them.

### 8.4 The provider-invocation ledger — the no-double-billing guarantee

This is the most important new table.

```
provider_invocations
  invocation_id       uuid pk
  workspace_id        uuid
  kind                text      enum(research|collection|enrichment|email|whatsapp|opportunity)
  idempotency_key     text      -- UNIQUE (workspace_id, kind, idempotency_key)
  provider            text
  provider_ref        text      -- the provider's own job/message id
  state               text      enum(reserved|attempted|accepted|failed|blocked|outcome_unknown)
  request_fingerprint text      -- sha256 of the request
  response_digest     text      -- sha256 of the response, for replay verification
  cost_cents          bigint
  credits             int
  created_at          timestamptz
  completed_at        timestamptz
```

**The protocol, in order — this is the existing send order, generalised:**

```
1. Reserve.  INSERT INTO provider_invocations (state='reserved', idempotency_key=...)
              ON CONFLICT (workspace_id, kind, idempotency_key) DO NOTHING
              → 0 rows inserted means this exact intent already exists.
2. Re-check the workspace's entitlement and the credit balance.
   → if the balance is insufficient, mark 'blocked' and stop. NO provider call.
3. Mark 'attempted' and COMMIT.            -- before the provider is contacted
4. Call the provider.
5. Settle: 'accepted' | 'failed' | 'outcome_unknown'.
6. Record the cost and debit the credit ledger.
```

**Why this prevents double billing and double sending:**

A local ledger can prove that *we* called the provider once. It **cannot**
prove what the provider did with that call. The network can fail between the
provider accepting a request and the response arriving, and the provider may
have charged, or sent, while we never learn the outcome. A ledger that treats
that as "not called" and retries produces **exactly the double charge and the
duplicate message the ledger was meant to prevent**.

So the ledger does not model success and failure. It models **uncertainty**:

| State | Meaning | May the worker retry the provider call? |
|---|---|---|
| `reserved` | We intend to call. Nothing has been sent. | **yes** — the call was not made |
| `attempted` | The request was written and the provider was called. **The outcome is unknown.** | **NO** |
| `accepted` | The provider confirmed. | no — and a repeat replays this outcome |
| `failed` | The provider refused, and we know it. | **yes**, with backoff, and the refusal is recorded |
| `blocked` | A policy or a budget stopped us before the call. | **yes**, once the blocker is cleared |
| `outcome_unknown` | We called and we do not know what happened. | **NO — reconcile first** |

**The rule, stated once:** *a chargeable or message-sending operation whose
outcome is unknown is never retried on a guess. It is reconciled against the
provider first, and only then resolved to `accepted` or `failed`.*

That is why `attempted` and `outcome_unknown` are different states, and why
the worker's retry path is:

```
re-entry at step 1
  |- the row is 'reserved'    -> the call was not made; proceed to call
  |- the row is 'accepted'    -> replay the stored outcome; do not call
  |- the row is 'failed'      -> the provider refused; a retry is allowed
  |- the row is 'blocked'     -> a policy or a budget stopped us; a retry is allowed
  `- the row is 'attempted'   -> UNCERTAIN. Do not call. Queue for reconciliation.
```

**Reconciliation is provider-side, not guesswork** (§8.6). Until it resolves,
the invocation stays `attempted` and the job stays in a `reconciling` state —
visible to the customer as "we are checking whether this went through", which
is the truth.

The same discipline applies to **every** chargeable or message-sending
operation: collection runs (CoreClaw), research runs (ZuniSEO, OI), enrichment
provider calls, **email sends** and **WhatsApp messages**. The existing
desktop rule — a replay of the same `(channel, pitch_id, content_hash)`
contacts nobody — is the same rule, generalised.

A **duplicate request** (the user clicks twice, or the browser retries) hits
the unique index and replays the stored outcome.

A **worker crash** between steps 3 and 5 leaves the row in `attempted`. The
lease expires, the job is retried, and step 1 finds the existing row and
**refuses to re-call the provider**. The job moves to `reconciling`, and the
reconciliation probe resolves it.

### 8.5 Cancellation, cost limits and status reporting

| Concern | Design |
|---|---|
| **Cancellation** | `cancel_requested_at` is set. A worker checks it before each step and between provider calls, and stops. A job already inside a provider call cannot be recalled — it settles as `outcome_unknown`. The UI says exactly that. |
| **Cost limits** | Three layers: a per-workspace **daily** and **monthly** provider budget; a per-job `cost_estimate_cents` checked before the call; and a per-workspace **credit** balance. A job whose estimate exceeds the remaining budget is `blocked` with `BUDGET_EXCEEDED` and **never calls the provider**. |
| **Status reporting** | `GET /v1/jobs/{jobId}` returns the state, the attempts, the last error, the cost, the lease, and the provider reference. The desktop's `research-status` / `enrichment-status` channels map onto it. |
| **Backpressure** | The queue depth per workspace is bounded; a workspace that floods the queue is throttled, not allowed to starve others. Workers poll a **fair** subset (round-robin over workspaces) so one tenant cannot monopolise the workers. |
| **Dead letters** | A `dead_letter` job is visible in the workspace UI and in the platform console, with the reason and a retry button that creates a **new** job with a new idempotency key. |

### 8.6 Reconciliation

A scheduled job resolves `attempted` / `outcome_unknown` invocations **against
the provider**, never by retrying the call.

| Provider | The probe | How the outcome is resolved |
|---|---|---|
| **Collection (CoreClaw)** | The provider's own run history is queryable (`getJobHistory`). | The run slug is looked up. A run that exists → `accepted`, with its result adopted. A run that does not exist → `failed`, and a **new** invocation with a new key may be created. |
| **Research (ZuniSEO)** | The research id is known from the request. | The job status is polled. A finished job → the envelope is re-fetched and `accepted`. A job that never existed → `failed`. |
| **Opportunity (OI)** | The research id is known from the request. | The report route is queried. A report → `accepted`. No report and the job is gone → `failed`. |
| **Enrichment** | The provider's own field lookup is not re-readable. | The **observation** is not created, the invocation is `outcome_unknown`, and a human is notified. The field is simply not enriched — nothing is fabricated. |
| **Email (Gmail)** | The sent-message lookup finds the provider's message id for the thread. | Found → `accepted`. Not found and the message is past the provider's retention → the send is confirmed lost, `failed`, and **the mail is not retried**. The prospect never receives a duplicate. |
| **WhatsApp** | The message id is looked up through the Meta API. | Same rule. A `failed` WhatsApp send is never retried automatically, because a duplicate conversation message is worse than a missed one. |

**The probe is bounded and audited.** Each probe is itself recorded as an
attempt against the invocation, so a probe loop cannot become a retry loop.
After `MAX_PROBES` (default 5, over 24 hours) an unresolved invocation is
marked `outcome_unknown` permanently, the workspace is notified, and the
platform console shows it. **An unresolved outcome is never "assumed failed"
and never "assumed succeeded"** — it stays uncertain, which is the truth, and
the credit is not refunded or charged until it is resolved.

### 8.7 The desktop app's behaviour in the cloud

The desktop's in-process schedulers stay for the **local** mode. In the cloud
mode the desktop becomes a **client**: it submits a job, polls
`GET /v1/jobs/{id}`, and the cloud worker executes it. The desktop's
`research-status` and `enrichment-status` channels already have the right
shape; only the transport changes.

### 8.8 The Opportunity Intelligence isolation model (per tenant)

Approved: OI runs **per tenant** initially, with isolated storage, isolated
credentials and isolated execution. Shared OI processing is **not** activated
until the cross-tenant isolation and security tests pass.

#### 8.8.1 What "per tenant" means concretely

| Layer | Isolation |
|---|---|
| **Process** | One OI service instance (and its own worker pool) per tenant. A separate service account, a separate memory and a separate port. |
| **Storage** | A **dedicated database** (or a dedicated schema with a dedicated role) per tenant. The OI instance's role is not the owner of any other tenant's data, and the platform's OI instances are provisioned from a template that cannot see sideways. |
| **Credentials** | Each OI instance holds **its own** provider credentials (Brave, Serper, the LLM, Meta). No credential is shared between tenants, so a cross-tenant request cannot even be *authorised* by a leaked token. |
| **Execution** | A job is routed to the OI instance of the workspace that owns it. There is no shared queue, no shared worker and no shared cache between tenants. |
| **Network** | Each instance is reachable only by the platform worker that belongs to that tenant. The instances are not addressable from the public internet. |

#### 8.8.2 Provisioning

```
workspace created
  -> provision OI instance
       - a dedicated role and database (or schema) in the OI PostgreSQL
       - a dedicated service account and credentials in the secret store
       - a dedicated queue namespace and cache prefix
       - a dedicated network policy and a private endpoint
       - a per-tenant ZTECH_OI_AUTH_TOKEN, generated at provisioning time
  -> the OI instance is registered in the tenant's configuration
  -> the tenant's research jobs are routed to it
```

Provisioning is **asynchronous and idempotent**: it is a platform job with its
own state, so a partially-provisioned tenant is visible and recoverable
rather than silently broken. Until provisioning completes, the workspace's
opportunity research is **blocked with `OI_NOT_PROVISIONED`**, and the
workspace sees that reason in its dashboard. It never silently shares
another tenant's instance.

#### 8.8.3 Operational cost

This is the price of the safer model, and it must be measured before it is
accepted:

| Cost | Effect |
|---|---|
| **Memory and CPU per instance** | An OI instance has a baseline footprint (the engine, the provider clients, the connection pools). At N tenants this is N times the baseline. |
| **Connection pools** | Each instance holds its own PostgreSQL pool and its own HTTP pools. A large tenant count exhausts the database's connection budget. |
| **Cold start** | A new instance must boot, migrate and warm its caches before the first research. Provisioning is therefore a background job with a readiness probe, not a synchronous step. |
| **Operational surface** | N instances means N things to patch, restart, monitor and upgrade. The upgrade must be a rolling, per-tenant procedure with a per-tenant health gate. |
| **Licence and quota** | Each instance may consume provider quotas independently, so the aggregate provider spend must still be capped centrally (§9.3). |

The plan therefore records the **cost per tenant** as a platform metric
(instance count × baseline cost) and sets a **tenant-count ceiling** at which
the migration to a shared instance (§8.8.5) is triggered. The decision is
made on evidence, not on optimism.

#### 8.8.4 Lifecycle management

| Event | Action |
|---|---|
| **Workspace created** | Provision (asynchronous, idempotent, with a readiness probe). |
| **Workspace suspended** | Stop the OI instance; keep its data; do not delete it. |
| **Workspace closed** | Export the workspace's OI data (the customer owns it), then decommission the instance after the retention period. The deletion is a separate, explicit, audited operation. |
| **Engine upgrade** | A rolling upgrade: one instance at a time, with a health gate and an automatic rollback. A tenant on an older engine version is fine for the duration of the roll. |
| **Instance failure** | The instance is restarted with a backoff; a workspace with more than `MAX_INSTANCE_FAILURES` is moved to `OI_DEGRADED`, its research jobs are retried, and the customer is told. Its data is untouched. |
| **Cost anomaly** | An instance whose spend exceeds the workspace's budget is **paused**, not killed. The workspace's research returns `BUDGET_EXCEEDED`. |

#### 8.8.5 The path to a shared instance (not yet)

A shared OI instance is the right end state, but it is **not** activated by
optimism. The gate is explicit:

1. The OI service gains **tenant scoping** in its storage layer, with the
   same RLS discipline as the main database (§5.2) and the same startup
   role assertions (§5.3.1).
2. The **cross-tenant denial suite** (§5.6) is extended to the OI service:
   the OI reports, entities, evidence, snapshots and jobs are all
   workspace-scoped, and a request from workspace B cannot read A's report.
3. The **credential separation** test passes: a shared instance holds
   per-workspace credentials and never sends one workspace's request with
   another workspace's credential.
4. The **job routing** test passes: a job is executed under the workspace that
   owns it, and a tampered payload cannot redirect it.
5. The **data migration** from per-tenant instances to the shared one is
   tested, with the same round-trip and idempotency guarantees as the
   desktop migration (§10.3).

**Until all five pass, the platform runs per-tenant instances.** The shared
instance is a change that requires the same review as any other isolation
change, and the plan treats it as a separate milestone with its own
acceptance criteria — not as an optimisation that can be slipped in.

---

## 9. Deliverable 8 — Authentication, secrets and billing boundaries

### 9.1 The three boundaries, stated plainly

```
┌──────────────────────┬──────────────────────────────────────────────────────┐
│  THE TENANT BOUNDARY │  Whose data? Which rows? Which keys?                │
│                      │  Enforced by: RLS + the workspace context            │
├──────────────────────┼──────────────────────────────────────────────────────┤
│  THE SECRET BOUNDARY │  Whose keys? Which mailboxes? Which provider tokens? │
│                      │  Enforced by: the secret store, keyed by workspace    │
├──────────────────────┼──────────────────────────────────────────────────────┤
│  THE MONEY BOUNDARY  │  Whose credits? Whose provider spend? Whose invoice?  │
│                      │  Enforced by: the credit ledger + the usage meter     │
└──────────────────────┴──────────────────────────────────────────────────────┘
```

A leak in any one of them is a different incident with a different
containment, so they are separated deliberately.

### 9.2 The secret store

Secrets are **not** in PostgreSQL. A `credential_secrets` table holds only a
*reference*; the value lives in a dedicated secret store.

| Secret | Store | Access |
|---|---|---|
| Session token | Redis | the edge only |
| User password hash | PostgreSQL (`users`) | the auth service only |
| MFA secret | the secret store, sealed | the auth service only |
| Workspace API token | PostgreSQL (hash only) + prefix | the API |
| Provider API key (CoreClaw, ZuniSEO, OI) | the secret store, per workspace | the worker, on demand |
| Gmail / Microsoft 365 OAuth refresh token | the secret store, per mailbox | the worker, on demand |
| WhatsApp credentials, Meta token | the secret store, per workspace | the worker, on demand |
| Billing provider keys | the secret store, platform scope | the billing job only |
| The break-glass signing key | an HSM or the secret store | the platform console only |

**Rules:**
- A secret is fetched **by the worker, at the moment of use**, with a short
  TTL in memory. It is never returned by an API, never logged, and never
  included in an export.
- A secret is **never rendered** after it is written: the API returns
  `{configured: true, last4: '…'}` — the same shape the desktop's
  `settings:load` already returns (`hasApiKey`, never the key).
- The secret store is **per environment** and **per deployment**; a customer
  cannot reach it, and the API never holds a store credential that would let
  it read another workspace's secret: the worker fetches the secret **using
  the workspace's own reference**, so the store's own ACL is not the isolation
  boundary — the RLS-scoped reference is.
- Rotation is supported: a rotated secret creates a new version; the old one
  is revoked after a grace period.

**The desktop behaviour is preserved**: `electron-store` plus the OS key store
(`safeStorage`) becomes, in the cloud, the secret store; in the local mode it
stays exactly as it is.

### 9.3 Billing boundaries — a foundation, not a charge

**Nothing in F2 activates a real payment or a real paid provider call.** The
following is built and exercised in a **simulated** mode.

| Object | Table | Purpose |
|---|---|---|
| Plan | `plans` (a platform catalogue, not a table per plan) | the features and limits a plan grants |
| Subscription | `subscriptions` | a workspace's plan, period, state |
| Entitlement | derived from the plan + the subscription state | the permission to use a feature |
| Credit grant | `credit_ledger` (a `grant` entry) | credits added |
| Credit use | `credit_ledger` (a `usage` entry) | credits consumed |
| Balance | `SUM(delta)` over the ledger | the current balance |
| Usage | `usage_events` | what was consumed, when, by which invocation |
| Meter | a scheduled aggregation of `usage_events` | the billable period's totals |
| Invoice | `invoices` + `invoice_lines` | the generated bill |
| Reconciliation | `provider_spend` vs `usage_events` | did the provider's bill match our meter? |

**The credit model.** A credit is the unit of *work*, not of money. Each
operation costs credits:

| Operation | Credits | Notes |
|---|---|---|
| One Google Maps collection run | 1 per result | the CoreClaw cost, converted |
| One website research (ZuniSEO) | 1 | |
| One competitor research (OI) | 2 | |
| One enrichment field | 0.25 | rounded up per job |
| One email send | 0 | the mailbox caps apply instead |
| One WhatsApp message | 0 | the Meta conversation caps apply instead |
| One export | 0 | metered as a page, not a credit |

**The credit ledger is a transaction ledger, not a counter.** The balance is
`SUM(delta)` over the entries, and it is **auditable**: every entry names the
usage event or the invocation that caused it.

| Operation | Ledger entry | Effect on the balance |
|---|---|---|
| **Grant** | `delta = +N`, `reason = 'grant'` | the balance rises |
| **Reservation** | `delta = -N`, `reason = 'reservation'`, `invocation_id` set | the credits are **held** so a concurrent job cannot spend them |
| **Settlement** | the reservation is closed and a `delta = 0` `settlement` entry records the **actual** cost | the difference is released (`delta = +unused`) |
| **Refund** | `delta = +N`, `reason = 'refund'`, linked to the invocation | the credits come back — after a provider failure, or after an **unresolved** outcome is resolved as `failed` |
| **Adjustment** | `delta = ±N`, `reason = 'adjustment'`, `actor_id` set | an operator correction, always with an actor and a reason |

**Reservations are what make the limit meaningful.** Without a reservation,
two jobs can both pass the balance check and jointly overspend. The
reservation is taken **before** the provider call, inside the same transaction
as the `provider_invocations` row, so a balance check and a reservation are
atomic. A crashed worker's reservation expires with its lease and is
released; the invocation then reconciles (§8.6) and settles or refunds.

**The enforcement point is the provider-invocation ledger (§8.4), step 2.**
A job whose reservation cannot be taken is `blocked` with
`BUDGET_EXCEEDED` and **never reaches the provider**. A new workspace's
default balance is **zero**, so nothing is billable until an operator grants
credits. This is the switch the handover asks for.

**Cost caps at four levels:**

| Level | Where | Default |
|---|---|---|
| Per invocation | the job's `cost_estimate_cents` | estimated before the call |
| Per workspace, per day | `subscriptions.provider_budget_cents` | 0 until granted |
| Per workspace, per month | `subscriptions.monthly_budget_cents` | 0 until granted |
| Per platform, per day | a platform-level budget | an operator setting |

**Reconciliation.** The daily job compares the provider's own invoice
(where the provider exposes one) with the metered `usage_events`, and raises
a platform alert when they diverge by more than a configured threshold. This
is the mechanism that would have caught the F0 finding that a timed-out
collection submit can be billed twice. It also reconciles the **credit
ledger** against the invocation ledger: every accepted invocation must have
exactly one settlement, and every reservation must be closed or expired.

**Prices are not fixed and no real billing is integrated.** The plan, the
entitlement set and the credit rates are all **configuration**; the price
table is a platform setting that is not populated in F2.

### 9.4 What the platform admin can and cannot do

| Can | Cannot |
|---|---|
| Manage orgs, users, plans, subscriptions | Read a customer's CRM rows without a break-glass grant |
| See aggregate usage and provider spend | Read a customer's contact data, credentials or messages |
| Grant and revoke break-glass access, with a reason and an expiry | Change a customer's data outside an audited grant |
| Suspend an organisation (which stops its jobs and its sends) | Grant itself a permanent access path |
| Adjust credits (recorded in the credit ledger, never edited) | Edit the audit log — it is append-only |
| Configure provider budgets and plan entitlements | Bypass the credit check for a customer job |

---

## 10. Deliverable 9 — Incremental migration plan from the Electron application

### 10.1 The principles

1. **No big bang.** Every phase ships and is verifiable on its own.
2. **The desktop application keeps working** through every phase.
3. **No data is rewritten until the new store is proven.** The migration is
   read-old → write-new → verify → cut over, never a destructive conversion.
4. **Every phase is reversible** until the cut-over, and the rollback is a
   command, not a project.
5. **The existing tests are the acceptance criteria.** A phase is done when
   the corresponding existing tests pass against the new implementation.

### 10.2 The phases

| Phase | What moves | Verification | Reversible |
|---|---|---|---|
| **P0 — Foundations** | The `packages/lead-intelligence` workspace package is created and the pure modules move into it, unchanged. The desktop imports the package instead of the local files. | The existing 1,990 assertions pass unchanged. A new test asserts the package has no `electron` / `fs` / `child_process` import. | yes (a path change) |
| **P1 — Repository seam** | The repository **interfaces** are extracted from the current `SqlJsStore`; the sql.js implementation is kept as `SqlJsStore` and satisfies them. | The existing persistence tests pass against the interface. | yes |
| **P2 — PostgreSQL schema** | The PostgreSQL schema is created by migrations that **mirror** the SQLite schema exactly, plus `workspace_id` and the typed timestamps. A `pg` implementation of the repositories is added behind the same interface. | The persistence test suite runs twice: once against sql.js, once against PostgreSQL, and both must produce identical results for the same fixtures. | yes (the desktop still uses sql.js) |
| **P3 — Tenant isolation** | The RLS policies, the role ladder, the session/workspace context, and the cross-tenant denial suite. | The denial suite (§5.6) is a required CI gate. | yes |
| **P4 — Auth and tenancy API** | The auth service, the org/membership/invitation/role endpoints, the session cookie, the edge. | A new API test suite; the denial suite runs against it. | yes |
| **P5 — CRM** | The CRM tables, the services, the workflows, the dashboard API. | New CRM contract tests; the lead library's data still comes from the legacy store in the first cut. | yes |
| **P6 — The job queue** | The `job_queue` table, the leasing worker, the provider-invocation ledger, the credit checks. The research, enrichment, collection, opportunity and sequence schedulers become queue-backed. | A new job test suite: lease expiry, retry, cancellation, double-billing prevention, credit exhaustion. | yes (the desktop schedulers still run locally) |
| **P7 — The data migration** | The one-time import of an existing desktop installation into a workspace, and the ongoing sync of a desktop installation with its workspace. | A round-trip test: import → export → compare, on a synthetic dataset with dirty data. | yes |
| **P8 — The browser client** | The dashboard SPA, the admin console. | The API contract tests are the acceptance criteria; the SPA has its own component tests. | yes (the desktop is unaffected) |
| **P9 — Billing** | The entitlement engine, the credit ledger, the meter, the invoice generation — in simulated mode. | The meter reconciles against the invocation ledger in a test. | yes |

### 10.3 How the existing data is migrated — and what is *not* migrated

The desktop's single SQLite file becomes a workspace. The mapping is
mechanical because the legacy schema is flat and the CRM is new.

| Legacy | Becomes | Notes |
|---|---|---|
| `numbers` (one row per phone number) | **one `company` + one `person` + one `contact_point`**, and a `lead` row that references them | **The single most important transformation.** A row with a `title` becomes a company; a row with an `email` becomes a contact point on a person; the row itself becomes the lead. The **phone is not the identity** — the F4 requirement — so the migration must group rows. Rows sharing a normalised domain or a normalised email become one company. |
| `numbers.qualification`, `tags`, `notes`, `*Status` | `leads.qualification`, `leads.tags jsonb`, `leads.notes`, `leads.*_status` | The user-owned fields are preserved **verbatim**, including the values the desktop's UI produces. |
| `numbers.companyId` | `entity_identities` (an alias) | The desktop's company pointer becomes an identity-resolution edge, not a foreign key. |
| `jobs` | `collection_jobs` + a `job_queue` row per run | |
| `targets` | `icp_targets` | The `requiredFields` / `exclusions` JSON becomes the same JSON in `jsonb`. |
| `saved_searches` | `saved_searches` | |
| `segments` + `li_segment_members` | `segments` + `segment_members` | The two segment stores are merged; the union of the members is taken. |
| `li_*` (26 tables) | the same tables with `workspace_id` | Row for row, with the timestamp conversion (§10.4). |
| `prospect_research` | `provider_research` | The Round-1 records are preserved, **including their `record_json`**, so the desktop's research history survives. |
| `electron-store` `config.json` | the workspace settings + the secret store references | The **sealed** credentials are re-sealed server-side: the desktop's DPAPI ciphertext cannot be decrypted on a server, so a credential must be **re-entered** by the user on the cloud. This is stated in the migration UI; it is not silently lost. |
| `logs/*.log` | **not migrated** | They are diagnostic. The audit log is the record that matters. |

### 10.4 The data conversion rules

| Rule | Detail |
|---|---|
| **Timestamps** | `TEXT` ISO-8601 → `timestamptz`. Unparseable values become `NULL` and are counted in a migration report, not silently dropped. |
| **JSON columns** | `TEXT` → `jsonb`. A value that does not parse is preserved verbatim in a `legacy_row jsonb` column on the row and reported. |
| **Booleans** | `INTEGER 0/1` → `boolean`. |
| **Orphaned references** | A `lead_id` that points at a deleted lead is **kept** with the id preserved and `orphaned = true`, not deleted. A `NOT VALID` foreign key is added and a separate validation report is produced. |
| **Duplicate ids** | The legacy ids are **not** reused as PostgreSQL primary keys (the CRM uses uuids). Every migrated row keeps its legacy id in a `legacy_id` column, and the **stable id** helpers (`stableId('fact', …)`) that generate the Lead Intelligence ids stay byte-identical, so the provenance chain inside a packet does not break. |
| **Deduplication** | The migration runs the **existing** dedup rules to group the legacy rows. It does not invent a new merge policy, and every merge it performs is recorded. |
| **The migration is idempotent** | Re-running it produces the same result. It is keyed by `(workspace_id, legacy_id)`. |
| **It is verifiable** | After the import, a report states: rows imported per table, rows grouped, merges performed, values that could not be parsed, and a total that matches the source. |

### 10.5 The desktop in the cloud era

| Mode | Where the data lives | Who runs the jobs |
|---|---|---|
| **Local** (existing) | The desktop's SQLite file | The desktop's in-process schedulers |
| **Synced** | The workspace in PostgreSQL | The cloud workers; the desktop is a client |
| **Cloud-only** | The workspace in PostgreSQL | The cloud workers |

A user may move from local to synced and back. The sync is a **replication of the same domain records**, not a re-import: the desktop keeps its local store as a cache and reconciles by `(entity, legacy_id)`.

### 10.6 The cut-over plan

1. The workspace is created and the import runs (§10.3). The desktop is untouched.
2. The desktop is switched to "synced" mode. It now reads and writes the
   workspace. The local file becomes a cache.
3. The job schedulers in the desktop are disabled in synced mode (the cloud
   runs them) — a single flag, and the flag is reversible.
4. The cloud's data is reconciled against the desktop's local store for a
   defined period, and the discrepancies are reported.

**The cut-over is reversible at every step.** Steps 1-3 do not delete
anything; the local file is retained until the customer confirms.

---

## 11. Deliverable 10 — Implementation milestones with acceptance criteria and tests

Each milestone is independently shippable and independently verifiable. The
**acceptance criteria** are the definition of done.

### M0 — The shared package (F2.1)

| | |
|---|---|
| **Scope** | Create `packages/lead-intelligence`; move the pure modules; the desktop imports it. |
| **Acceptance** | ① The existing 1,990 assertions pass **unchanged**. ② A test asserts the package has no `electron`, `fs` or `child_process` import. ③ The desktop build produces the same behaviour. |
| **Tests** | the existing suite, plus `packages/lead-intelligence/no-node-coupling.test.ts` |
| **Risk** | Low — a move, not a change. |
| **Size** | ~2 weeks |

### M1 — The repository seam and the PostgreSQL schema (F2.2)

| | |
|---|---|
| **Scope** | The repository interfaces; the PostgreSQL schema mirroring the SQLite one; the `pg` implementation. |
| **Acceptance** | ① The persistence test suite runs against **both** backends and produces identical results. ② Every legacy table has a PostgreSQL counterpart with a documented column mapping. ③ The migration is idempotent. ④ Every timestamp and JSON conversion is covered by a test, including the malformed cases. |
| **Tests** | `persistence-contract.test.ts` (a shared suite, two backends), `pg-migration.test.ts` |
| **Risk** | Medium — the SQLite-flavoured SQL (`INSERT OR IGNORE`, the `IFNULL` expression index, the partial unique indexes) must be translated exactly. |
| **Size** | ~4 weeks |

### M2 — Tenancy, RLS and the denial suite (F2.3)

| | |
|---|---|
| **Scope** | The role ladder, the RLS policies, the workspace context, the cross-tenant denial suite. |
| **Acceptance** | ① Every tenant table has an enabled, forced RLS policy. ② The application role is not the owner and has no `BYPASSRLS`. ③ The denial suite proves isolation **at the database level**, not only in the application. ④ A read of another workspace's row by primary key returns nothing and an update returns `FORBIDDEN`. |
| **Tests** | `tests/tenancy/*` (§5.6) — a required CI gate |
| **Risk** | High if done late, low if done early. **This is the milestone that must not be deferred.** |
| **Size** | ~3 weeks |

### M3 — Authentication, organisations and roles (F2.4)

| | |
|---|---|
| **Scope** | The auth service, the session cookie, the org/member/invitation/role endpoints, the edge. |
| **Acceptance** | ① A session is revocable within one request cycle. ② A user cannot act outside their memberships. ③ Self-approval is refused. ④ The role × permission matrix test passes for all five roles. ⑤ Every privileged action is in the audit log. |
| **Tests** | `auth.test.ts`, `roles.test.ts`, `invitations.test.ts`, `session-tenant-binding.test.ts` |
| **Risk** | Medium |
| **Size** | ~4 weeks |

### M4 — The durable job queue and the invocation ledger (F2.5)

| | |
|---|---|
| **Scope** | `job_queue`, the leasing worker, `provider_invocations`, the credit checks, the reconciliation. |
| **Acceptance** | ① A worker killed mid-job does not lose the job (the lease expires and it is reclaimed). ② **A retried job never calls a paid provider twice** — proven by a test that counts the provider calls. ③ A job with an insufficient balance is `blocked` and the provider is never contacted. ④ A cancelled job stops before the provider call. ⑤ A duplicate request replays the stored outcome. ⑥ `outcome_unknown` is reconciled, not retried. |
| **Tests** | `job-lease.test.ts`, `no-double-billing.test.ts`, `credit-exhaustion.test.ts`, `cancellation.test.ts`, `reconciliation.test.ts` |
| **Risk** | High — this is where money and messages are at stake. |
| **Size** | ~4 weeks |

### M5 — The native CRM (F2.6)

| | |
|---|---|
| **Scope** | The CRM tables, the services, the workflows: companies, locations, contacts, decision-makers, leads, pipelines, stages, deals, tasks, notes, reminders, activities, assignment, campaigns, interaction history, duplicate detection, identity resolution, the audit trail. |
| **Acceptance** | ① A company with two locations and two contact points is representable, and a branch is never merged into its parent. ② A person may hold several roles. ③ Duplicate detection uses the **existing** rules, and **an automatic merge requires two independent signals from different groups with no conflict** — a single domain or a single phone number only ever raises a candidate, and an ambiguous match is routed to human review. ④ The merge is reversible and audited. ⑤ **No contact point is ever created without a source observation or a human entry** — a test asserts it. ⑥ A campaign excludes a suppressed address. ⑦ A user record never becomes a contact point. ⑧ Every CRM change is in the audit log. |
| **Tests** | `crm-companies.test.ts`, `crm-contacts.test.ts`, `crm-pipeline.test.ts`, `crm-campaigns.test.ts`, `duplicate-resolution.test.ts`, `identity-resolution.test.ts`, `crm-trust.test.ts` |
| **Risk** | Medium |
| **Size** | ~6 weeks |

### M6 — The customer dashboard API and the browser client (F2.7)

| | |
|---|---|
| **Scope** | The dashboard API, the aggregates, the SPA, the platform console. |
| **Acceptance** | ① Every screen in §7.3 exists and is role-filtered **at the query**. ② A member who requests a forbidden lead receives `403`, not an empty row. ③ The console never renders a customer's CRM row. ④ A break-glass access shows a banner in the customer's dashboard and an audit entry. |
| **Tests** | `dashboard-api.test.ts`, `role-visibility.test.ts`, `console-isolation.test.ts`, the SPA component tests |
| **Risk** | Medium |
| **Size** | ~8 weeks |

### M7 — The data migration and the desktop sync (F2.8)

| | |
|---|---|
| **Scope** | The import of an existing desktop installation; the sync mode; the cut-over. |
| **Acceptance** | ① The import is idempotent. ② A round trip (import → export → compare) is byte-identical for a synthetic dataset. ③ The migration report states every row imported, every group formed, every merge, and every unparseable value. ④ **The user's data is never deleted** — the local file is retained. ⑤ The credential re-entry is stated, not silent. |
| **Tests** | `migration-round-trip.test.ts`, `migration-dirty-data.test.ts`, `migration-idempotency.test.ts` |
| **Risk** | High — this is where customer data is at risk. |
| **Size** | ~4 weeks |

### M8 — The billing foundation (F2.9)

| | |
|---|---|
| **Scope** | The entitlements, the credit ledger, the usage meter, the invoice generation — in **simulated** mode. |
| **Acceptance** | ① A new workspace has a zero balance and cannot call a paid provider. ② Every provider invocation debits exactly once. ③ The meter reconciles against the invocation ledger. ④ A simulated invoice is produced and matches the meter. ⑤ **No real payment is integrated and no real charge can occur.** |
| **Tests** | `entitlements.test.ts`, `credit-ledger.test.ts`, `meter-reconciliation.test.ts`, `invoice-generation.test.ts`, `no-live-billing.test.ts` |
| **Risk** | Low (simulation only) |
| **Size** | ~3 weeks |

### 11.1 The critical path

```
M0 package ──► M1 schema ──► M2 tenancy ──► M4 jobs ──► M5 CRM ──► M6 dashboard
                    │                │              │
                    └──► M3 auth ────┘              └──► M8 billing
                              └──► M7 migration
```

**M2 (tenancy) must land before any customer data is written.** M4 (jobs) must
land before any paid provider is called from the cloud. Those two orderings are
not negotiable.

### 11.2 What each milestone must not change

| Milestone | Must not change |
|---|---|
| M0 | any behaviour |
| M1 | any behaviour (the same data, a different store) |
| M2 | any behaviour for a single-tenant deployment |
| M3 | the desktop's flows |
| M4 | the outreach gate, the send order, the idempotency key derivation |
| M5 | the trust rules, the ICP logic, the evidence provenance |
| M6 | the desktop renderer |
| M7 | the user's data |
| M8 | the credit balance of an existing workspace |

---

## 12. Risks, open questions and the decisions we need

### 12.1 The risks that could still hurt us

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **A tenant isolation hole.** | Low | **Catastrophic** | RLS as the only boundary; the denial suite as a CI gate; the application role is not the owner; a third party reviews the policies before M2 lands. |
| R2 | **A paid provider is billed twice.** | Medium | High | The invocation ledger with a unique key; the "attempted before the call" order; `outcome_unknown` instead of a blind retry; daily reconciliation. |
| R3 | **A prospect receives two emails.** | Medium | High | The existing `sendIdempotencyKey` generalised into the ledger; the send order preserved. |
| R4 | **The migration loses a customer's data.** | Medium | **Catastrophic** | Read-old/write-new; never delete; the local file is retained; the round-trip test; a migration report the customer can read. |
| R5 | **The extraction changes the intelligence engine's behaviour.** | Medium | High | The existing 1,990 assertions are the acceptance criteria; the pure modules move unchanged; the equivalence test between the desktop and cloud paths. |
| R6 | **The OI service cannot be made tenant-safe in time.** | Medium | High | OI is a separate repository with its own release cadence. The interim: the cloud runs **one OI instance per tenant** (a strong isolation boundary at the process level) until the shared-instance tenant scoping lands. |
| R7 | **The scope is too large.** | High | Medium | The milestones are independently shippable; M0-M4 deliver a usable, safe product with the existing feature set; the CRM and the dashboard follow. |
| R8 | **Performance.** A workspace with 100k leads. | Medium | Medium | The aggregates; the pagination that already exists; the composite indexes on `(workspace_id, …)`. |
| R9 | **The desktop and the cloud diverge.** | Medium | Medium | One shared package; the same contracts; the equivalence test. |
| R10 | **Cost control fails.** | Low | High | Zero credits by default; the budget check before the call; the platform-level daily cap. |

### 12.2 The decisions we need from you

| # | Question | Our recommendation | Blocks |
|---|---|---|---|
| Q1 | **Should the cloud be multi-region, or one region initially?** | One region, with the data directory and the secret store co-located, and a documented path to a second region. | M6 |
| Q2 | **Who may be a `manager`?** Is a "team lead" a distinct role from a "manager"? | No — keep the five roles. Add a *team* concept as a `groups` table and a permission filter, not a sixth role. | M3, M5 |
| Q3 | **Do we keep the desktop product, or retire it after the cloud is mature?** | Keep it. The desktop is the offline and local-first mode, and it is the migration source. | M7 |
| Q4 | **Is a prospect's email a "contact point" or a "lead"?** | Both: a `lead` is a *commercial* record (a company being worked); a `contact point` is a *channel address*. A lead points at a contact point. | M5 |
| Q5 | ~~**Do we bill per credit, per seat, or per usage?**~~ | **DECIDED (2026-10-20):** plans + seats + entitlements + credits, with an auditable credit ledger carrying reservations, settlement, refunds, spending limits and reconciliation. No real billing is activated; no prices are fixed. See §9.3. | — |
| Q6 | ~~**Should the platform admin be able to see a customer's data at all?**~~ | **DECIDED (2026-10-20):** time-limited, audited break-glass only; no permanent unrestricted access. See §5.7. | — |
| Q7 | ~~**Which OI isolation model: shared instance with tenant scoping, or one instance per tenant?**~~ | **DECIDED (2026-10-20):** per-tenant instances first; shared processing is gated on the five-part test suite in §8.8.5. | — |
| Q8 | ~~**Is the CRM's duplicate merge allowed to be automatic?**~~ | **DECIDED, MODIFIED (2026-10-20):** no automatic merge on a single signal; corroborated evidence required; ambiguous matches go to human review; the merge is audited and reversible. See §6.3. | — |
| **Q9** | **Should an automatic merge be possible at all, or should every candidate go to a human?** | Automatic is permitted, but only on corroborated evidence (§6.3.3). If the review prefers zero automatic merges, the auto-merge branch is deleted and every candidate is routed to a human — a one-line change with no schema impact. | M5 |
| **Q10** | **Who may approve a break-glass request — the platform admin, or the customer?** | Both may *request*; only the customer, or a second platform admin, may *approve*. A single admin can never grant themselves access. | M2, M6 |

### 12.3 What is explicitly *not* in F2

- A public API for third parties (the workspace API token exists, but the
  public product surface is the dashboard).
- A native mobile application.
- A data-residency choice per customer.
- Real billing.
- A public marketing site.
- Replacing the renderer.

### 12.4 The recommendation

Proceed with **M0 and M1** immediately — they are mechanical, low-risk, and
they de-risk everything else. **M2 (tenancy) must be complete before a single
customer row is written.** M4 (the job queue and the invocation ledger) must be
complete before a single paid provider is called from the cloud. The CRM and
the dashboard follow on the strength of those foundations.

---

## Appendix A — the glossary

| Term | Meaning in this document |
|---|---|
| **Organisation / workspace** | One paying customer. The isolation boundary. `orgs` in the platform tables, `workspace_id` on every tenant row. |
| **Subscriber** | A human who works in a workspace. **Not** a prospect. |
| **Prospect** | A company or person that a workspace is trying to sell to. |
| **Company / person / contact point** | The CRM's entities. |
| **Lead** | A commercial record: a company being worked, with a qualification status. |
| **Deal / pipeline / stage** | The commercial pipeline. |
| **Campaign** | A named batch of outreach to a selected set of leads. |
| **Evidence packet** | The immutable research result: facts, findings, strengths, provenance. |
| **Invocation** | One call to a provider or one outbound message, recorded in the ledger. |
| **Job** | One unit of queued work. |
| **Credit** | The unit of billable work. |
| **Break-glass** | A time-boxed, audited grant of platform-admin access to one workspace. |

## Appendix B — the file map of the existing code this plan refers to

| Concern | Where it is today |
|---|---|
| The evidence contract | `src/main/lead-intelligence/contracts/evidencePacket.js` |
| The provenance model | `src/main/lead-intelligence/contracts/provenance.js` |
| The vocabulary | `src/main/lead-intelligence/contracts/constants.js` |
| The outreach gate | `src/main/lead-intelligence/outreach/OutreachGate.js` |
| The send order | `src/main/lead-intelligence/outreach/OutreachService.js` (`sendEmail`) |
| The idempotency key | `src/main/lead-intelligence/persistence/contract.js` (`sendIdempotencyKey`) |
| The trust rules | `src/main/lead-intelligence/trust/*` |
| The ICP engine | `src/main/lead-intelligence/icp/icpFit.js` |
| The research state machine | `src/main/lead-intelligence/research/stateMachine.js` |
| The research coordinator | `src/main/lead-intelligence/research/ResearchCoordinator.js` |
| The refresh ledger | `src/main/lead-intelligence/opportunity/OpportunityRefreshLedger.js` |
| The association store | `src/main/lead-intelligence/opportunity/OpportunityAssociationStore.js` |
| The OI gateway | `src/main/lead-intelligence/opportunity/OpportunityIntelligenceGateway.js` |
| The ZuniSEO mapper | `src/main/lead-intelligence/providers/envelopeMapper.js` |
| The ZuniSEO transports | `src/main/lead-intelligence/providers/transports/*` |
| The CoreClaw client | `src/main/coreclawClient.js` |
| The mailbox pacing | `src/main/lead-intelligence/mailbox/pacing.js` |
| The sequence contract | `src/main/lead-intelligence/sequences/sequenceContract.js` |
| The reply rules | `src/main/lead-intelligence/replies/replyRules.js` |
| The legacy store | `src/main/accountStore.js` |
| The migrations | `src/main/lead-intelligence/migrations/001..013` |
| The repository | `src/main/lead-intelligence/persistence/SqlJsStore.js` |
| The IPC registrars | `src/main/lead-intelligence/{outreach,trust,mailbox,sequences,replies,timeline,opportunity}-ipc.js` |
| The OI service | `ztech-opportunity-intelligence/src/ztech_oi/**` |
| The legal documents | `ztech-legal/{index,privacy,terms}.html` |
