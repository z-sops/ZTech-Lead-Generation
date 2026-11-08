# Three-Phase Product Completion Roadmap

The objective is an opportunity-first B2B research SaaS: industry/location/requirements -> sourced businesses -> evidence-backed needs -> prioritized opportunities -> human-reviewed proposal -> CRM and controlled outreach. The accepted M5 vertical slice uses synthetic data; it must not be described as real research.

## Phase 1 — Owner Installation and Durable Background Research (AUTHORIZED)

**Features:** P01, P02, P13, P14.

**Prerequisite:** accepted M5 release-candidate baseline `e0954832a305b1ca8ef5c5e19599072baf31bd51` and frozen M4 P1 work at `ebadd3e68d33bfcee76df16902e4601db6abaf86`.

**Build:** reproducible Windows/disposable PostgreSQL 16 setup; integrate the original M4 P1 `li.job_queue` and job-scoped worker; authenticated asynchronous API; real queue status/history in browser; idempotency, cancellation, bounded retries, fencing and restart recovery. Execution is no-op; opportunity data remains explicitly synthetic and is materialized only via authorized application context.

**Acceptance gate:** actual CLI SaaS startup; queue submit/claim/complete; cross-tenant denial; persisted browser status through refresh and API/worker restart; real PostgreSQL and Playwright acceptance; new Phase 1 CI run(s); separate Draft PR, unmerged. Preserve M4 P1 and M5 PRs.

## Phase 2 — Real AI Business Opportunity Intelligence (PLANNING ONLY)

**Features:** P03, P04, P05, P06, P07, P08, P15.

**Prerequisite:** Phase 1 independently accepted and owner grants Phase 2 implementation approval.

**Build:** source-backed real company discovery; website and technical gap inspection; attributable evidence, confidence and freshness; explainable scoring; human-reviewed AI proposals; advanced opportunity analytics.

**Acceptance gate:** actual company identities and evidence verified, provenance/permission policies tested, evaluation datasets and false-positive criteria documented; no invented facts or autonomous outbound actions.

## Phase 3 — CRM, Automation and Commercial Release (PLANNING ONLY)

**Features:** P09, P10, P11, P12, P16, P17, P18, P19, P20, P21.

**Prerequisite:** Phase 2 accepted and owner separately approves Phase 3.

**Build:** complete CRM and account activity history; reminders and approved follow-ups; secure email connectors; controlled outreach; exports/CRM integrations; billing; operations, onboarding, launch-quality testing and deployment.

**Acceptance gate:** billing and entitlements, consent/suppression, permissions, backups, observability and security tests complete; owner authorizes production launch separately.

## Non-negotiable gates

- No deadlines are promised in this roadmap.
- PR #7 (M4 P1) and PR #16 (M5) stay Draft/unmerged unless owner authorizes otherwise.
- Do not execute paid providers, production migrations, real outreach or Phase 2/3 development under Phase 1 approval.
- Track every P01–P21 item in `PENDING-FEATURES.md` and only mark verified with cited executable evidence.