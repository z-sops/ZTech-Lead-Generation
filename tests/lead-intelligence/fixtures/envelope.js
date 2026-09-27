'use strict';

/**
 * ASSUMED Zuni-SEO Evidence Envelope shape (no golden fixture exists yet — Step 0 #9).
 * QwenCoder: replace/extend with a real `zuni_research_result` payload (or a real
 * `prospect_research` row's stored result) once Zee authorises a live run.
 */
function sampleEnvelope({ domain = 'acme.com', platform = 'Shopify', pages = 14, capturedAt = '2026-09-01T10:00:00Z', engine = '0.14.0', status = 'complete' } = {}) {
  return {
    contract_version: 'zseo.evidence-envelope/1',
    engine: { version: engine },
    status,
    captured_at: capturedAt,
    target: {
      requested_url: `https://${domain}`,
      final_url: `https://www.${domain}/`,
      redirect_chain: [{ url: `https://${domain}/`, status: 301 }, { url: `https://www.${domain}/`, status: 200 }],
    },
    coverage: { tech: 'measured', crawl: 'measured', geo: 'measured', visibility: 'not_measured' },
    facts: [
      { key: 'http.reachable', value: true, area: 'tech' },
      { key: 'pages_crawled', value: pages, area: 'crawl' },
      { key: 'platform', value: platform, area: 'tech' },
      { key: 'home.title', value: 'Acme | Home', area: 'content' },
    ],
    findings: [
      { id: 'meta_description_missing', title: 'Pages without a meta description', severity: 'medium', basis: 'standard', category: 'geo', observed: `4 of ${pages} pages.`, recommendation: 'Write one.', urls: [`https://www.${domain}/a`], fact_keys: ['pages_crawled'] },
    ],
    strengths: [{ statement: 'HTTPS works', fact_keys: ['http.reachable'], category: 'tech' }],
    not_measured: [{ area: 'visibility', reason: 'No API keys.' }],
    limitations: [],
    sources: [`https://www.${domain}/`],
  };
}

module.exports = { sampleEnvelope };
