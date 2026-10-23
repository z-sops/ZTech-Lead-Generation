'use strict';

/**
 * A10 — a GENUINE Round-1 fixture.
 *
 * This is the record shape `prospect_research.record_json` actually stores, as
 * written by the Round-1 research coordinator (see
 * src/main/prospect-research/prospect-research.cjs): a camelCase record whose
 * `packet` is a Zuni-SEO Evidence Envelope v1.
 *
 * It is deliberately NOT the flat/alias dialect the vendored module tests use —
 * that difference is exactly what A10's mapper has to bridge.
 */

const CAPTURED_AT = '2026-09-01T10:00:00.000Z';

function zuniV1Packet({
  domain = 'acme.com',
  platform = 'Shopify',
  pages = 14,
  capturedAt = CAPTURED_AT,
  engine = '1.4.2',
  status = 'done',
  availability = 'complete',
} = {}) {
  return {
    contract_version: '1.0',
    subject: {
      requested_url: `https://${domain}`,
      audited_url: `https://www.${domain}/`,
      domain,
      redirected_from: null,
      identity: { title: 'Acme | Home', site_name: 'Acme', org_name: 'Acme Bakery' },
    },
    run: {
      job_id: 'job_0123456789abcdef',
      engine_version: engine,
      status,
      depth: 'quick',
      max_pages: 20,
      requested_at: capturedAt,
      finished_at: capturedAt,
      captured_at: capturedAt,
      crawl: {
        pages_fetched: pages,
        html_pages: pages,
        discovered_urls: pages * 3,
        coverage_limited: false,
        rendering_mode: 'raw',
      },
    },
    completeness: {
      technical: { status: 'complete', reason: null },
      ai_access: { status: 'complete', reason: null },
      content: { status: 'partial', reason: 'Some checks failed.' },
    },
    facts: [
      {
        fact_id: 'f001',
        statement: 'The homepage returned HTTP 200.',
        value: true,
        unit: null,
        basis: 'observed',
        source: { type: 'http_response', url: `https://www.${domain}/`, fetch_time: capturedAt, response_hash: null, excerpt: null },
      },
      {
        fact_id: 'f002',
        statement: `The site is built on ${platform}.`,
        value: platform,
        unit: null,
        basis: 'observed',
        source: { type: 'crawl_page', url: `https://www.${domain}/`, fetch_time: capturedAt, response_hash: null, excerpt: null },
      },
      {
        fact_id: 'f003',
        statement: 'The crawl fetched this many HTML pages.',
        value: pages,
        unit: 'pages',
        basis: 'observed',
        source: { type: 'crawl_summary', url: `https://www.${domain}/`, fetch_time: capturedAt, response_hash: null, excerpt: null },
      },
    ],
    findings: [
      {
        finding_id: 'meta_description_missing',
        rule_version: engine,
        severity: 'medium',
        // A missing meta description is a rule evaluated against a published
        // standard, so the genuine v1 basis is `standard` — not `observed`.
        basis: 'standard',
        section: 'content',
        area: 'content',
        title: 'Pages without a meta description',
        observation: `${pages - 10} of ${pages} pages have no meta description.`,
        affected_urls: [`https://www.${domain}/a`, `https://www.${domain}/b`],
        affected_url_count: pages - 10,
        fact_ids: ['f003'],
        recommendation: 'Write a unique meta description for each page.',
        what_it_means: 'Search engines may invent a snippet for those pages.',
      },
      {
        finding_id: 'slow_server_response',
        rule_version: engine,
        severity: 'high',
        // A measured latency value: genuinely observed, which is NOT a basis the
        // ZTech contract can express, so it must become `unknown`, not "standard".
        basis: 'observed',
        section: 'technical',
        area: 'technical',
        title: 'Slow server response time',
        observation: 'The server took 2.4s to respond to the first request.',
        affected_urls: [`https://www.${domain}/`],
        affected_url_count: 1,
        fact_ids: ['f001'],
        recommendation: 'Investigate the hosting provider response time.',
        what_it_means: null,
      },
    ],
    strengths: [
      {
        strength_id: 's001',
        section: 'technical',
        statement: 'The homepage answered with HTTP 200.',
        fact_ids: ['f001'],
      },
    ],
    not_measured: [
      { item: 'backlink profile', reason: 'No third-party data source was available.' },
    ],
    limits: ['Only the first 20 pages were crawled.'],
    links: null,
    availability,
  };
}

/** A completed Round-1 record exactly as the Round-1 store persists it. */
function round1Record({
  id = 'r1_0001',
  leadRef = '5',
  domain = 'acme.com',
  phase = 'complete',
  providerJobId = 'job_0123456789abcdef',
  packet = zuniV1Packet({ domain }),
  createdAt = CAPTURED_AT,
  updatedAt = CAPTURED_AT,
  failureReason = null,
  failureMessage = null,
} = {}) {
  return {
    id,
    leadRef,
    website: `https://${domain}`,
    companyName: 'Acme Bakery',
    market: null,
    language: null,
    depth: 'quick',
    maxPages: 20,
    reuseMaxAgeHours: 24,
    providerId: 'zuni-seo',
    idempotencyKey: `zt:${id}`,
    phase,
    resumePhase: null,
    pendingReason: null,
    failureReason,
    failureMessage,
    providerJobId,
    reusedProviderResult: false,
    preflight: null,
    attempts: 0,
    nextAttemptAt: null,
    packet,
    createdAt,
    updatedAt,
    finishedAt: phase === 'requested' ? null : updatedAt,
    version: 4,
  };
}

module.exports = { zuniV1Packet, round1Record, CAPTURED_AT };
