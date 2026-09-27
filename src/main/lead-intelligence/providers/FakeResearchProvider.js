'use strict';

const { ProviderError } = require('../core/errors');
const { FACT_KEYS } = require('../contracts/constants');

/**
 * FakeResearchProvider — deterministic provider for tests and offline development.
 * Never enabled in production builds unless config.research.enableFakeProvider is true.
 *
 * Scenarios are keyed by domain:
 * {
 *   preflight: { ok, retryable, blocking, code },     // default { ok: true }
 *   preflightErrors: [ProviderError, ...],            // thrown in order
 *   startErrors: [ProviderError, ...],
 *   pollErrors: [ProviderError, ...],
 *   fetchErrors: [ProviderError, ...],
 *   polls: ['running', 'running', 'complete'],        // last value repeats
 *   startStatus: 'running' | 'complete',
 *   result: { ...ProviderResult overrides },
 *   malformed: true                                   // fetchResult returns junk
 * }
 */
class FakeResearchProvider {
  constructor({ id = 'fake', name = 'Fake research provider', scenarios = {}, clock = () => new Date() } = {}) {
    this.id = id;
    this.name = name;
    this.scenarios = scenarios;
    this.clock = clock;
    this.jobs = new Map();
    this.byIdempotencyKey = new Map();
    this.calls = [];
    this.seq = 0;
  }

  _s(domain) {
    if (!this.scenarios[domain]) this.scenarios[domain] = {};
    return this.scenarios[domain];
  }

  _throwNext(list) {
    if (list && list.length) throw list.shift();
  }

  async preflight({ domain }) {
    this.calls.push(['preflight', domain]);
    const s = this._s(domain);
    this._throwNext(s.preflightErrors);
    return s.preflight || { ok: true };
  }

  async startResearch({ domain, idempotencyKey }) {
    this.calls.push(['start', domain]);
    if (idempotencyKey && this.byIdempotencyKey.has(idempotencyKey)) {
      const id = this.byIdempotencyKey.get(idempotencyKey);
      return { providerJobId: id, status: 'running' };
    }
    const s = this._s(domain);
    this._throwNext(s.startErrors);
    this.seq += 1;
    const id = `fake-job-${this.seq}`;
    this.jobs.set(id, { domain, polls: [...(s.polls || ['complete'])] });
    if (idempotencyKey) this.byIdempotencyKey.set(idempotencyKey, id);
    return { providerJobId: id, status: s.startStatus || 'running' };
  }

  async pollResearch(providerJobId) {
    this.calls.push(['poll', providerJobId]);
    const job = this.jobs.get(providerJobId);
    if (!job) throw new ProviderError('PROVIDER_JOB_NOT_FOUND', 'Research job not found', { retryable: false });
    this._throwNext(this._s(job.domain).pollErrors);
    const status = job.polls.length > 1 ? job.polls.shift() : job.polls[0];
    return { status };
  }

  async fetchResult(providerJobId) {
    this.calls.push(['fetch', providerJobId]);
    const job = this.jobs.get(providerJobId);
    if (!job) throw new ProviderError('PROVIDER_JOB_NOT_FOUND', 'Research job not found', { retryable: false });
    const s = this._s(job.domain);
    this._throwNext(s.fetchErrors);
    if (s.malformed) return { junk: true };
    const outcome = job.polls[job.polls.length - 1] === 'partial' ? 'partial' : 'complete';
    return { ...defaultFakeResult(job.domain, providerJobId, this.clock(), outcome), ...(s.result || {}) };
  }
}

function defaultFakeResult(domain, providerJobId, now = new Date(), outcome = 'complete') {
  const partial = outcome === 'partial';
  return {
    requestedDomain: domain,
    auditedDomain: `www.${domain.replace(/^www\./, '')}`,
    redirectChain: [
      { url: `https://${domain}/`, status: 301 },
      { url: `https://www.${domain.replace(/^www\./, '')}/`, status: 200 },
    ],
    outcome,
    capturedAt: now.toISOString(),
    engineVersion: '0.14.0-fake',
    contractVersion: 'zseo.evidence-envelope/1',
    providerJobId,
    areas: {
      technical: 'measured',
      crawl: 'measured',
      content: partial ? 'not_measured' : 'measured',
      visibility: 'not_measured',
    },
    facts: [
      { key: FACT_KEYS.HTTP_REACHABLE, area: 'technical', label: 'Website reachable', value: true, sourceUrl: `https://${domain}/`, untrusted: false },
      { key: FACT_KEYS.HTTP_FINAL_STATUS, area: 'technical', label: 'Final HTTP status', value: 200, sourceUrl: `https://${domain}/`, untrusted: false },
      { key: FACT_KEYS.CRAWL_HTML_PAGES, area: 'crawl', label: 'Crawlable HTML pages', value: 12, sourceUrl: null, untrusted: false },
      { key: FACT_KEYS.TLS_VALID, area: 'technical', label: 'TLS certificate valid', value: true, sourceUrl: null, untrusted: false },
      { key: FACT_KEYS.TECH_PLATFORM, area: 'technical', label: 'Detected platform', value: 'WordPress', sourceUrl: null, untrusted: false },
      { key: FACT_KEYS.SITE_TITLE, area: 'content', label: 'Homepage title', value: 'Example Co | Home', sourceUrl: `https://${domain}/`, untrusted: true },
    ],
    findings: partial ? [
      { ruleId: 'security_headers_missing', area: 'technical', title: 'Security headers missing', severity: 'low', basis: 'standard', observed: '3 of 6 recommended security headers are not set.', recommendation: 'Add the missing headers at the web server or CDN.', urls: [`https://${domain}/`], factKeys: [FACT_KEYS.HTTP_FINAL_STATUS] },
    ] : [
      { ruleId: 'meta_description_missing', area: 'content', title: 'Pages without a meta description', severity: 'medium', basis: 'standard', observed: '4 of 12 pages have no meta description.', recommendation: 'Write a unique meta description for each page.', urls: [`https://${domain}/about`], factKeys: [FACT_KEYS.CRAWL_HTML_PAGES] },
      { ruleId: 'org_schema_missing', area: 'content', title: 'No Organization structured data', severity: 'medium', basis: 'standard', observed: 'The homepage has no Organization or LocalBusiness JSON-LD.', recommendation: 'Add Organization JSON-LD with name, url, logo and contact.', urls: [`https://${domain}/`], factKeys: [] },
      { ruleId: 'security_headers_missing', area: 'technical', title: 'Security headers missing', severity: 'low', basis: 'standard', observed: '3 of 6 recommended security headers are not set.', recommendation: 'Add the missing headers at the web server or CDN.', urls: [`https://${domain}/`], factKeys: [FACT_KEYS.HTTP_FINAL_STATUS] },
    ],
    strengths: [
      { statement: 'HTTPS certificate is valid.', area: 'technical', factKeys: [FACT_KEYS.TLS_VALID], ruleIds: [] },
    ],
    notMeasured: [
      { area: 'visibility', reason: 'AI answer visibility was not run (requires provider API keys).' },
      ...(partial ? [{ area: 'content', reason: 'Content audit did not finish.' }] : []),
    ],
    limitations: [],
    sourceReferences: [{ url: `https://${domain}/`, kind: 'page' }],
  };
}

module.exports = { FakeResearchProvider, defaultFakeResult };
