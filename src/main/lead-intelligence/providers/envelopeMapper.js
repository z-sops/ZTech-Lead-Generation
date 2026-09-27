'use strict';

const { pick, getPath } = require('../core/objects');
const { ProviderError } = require('../core/errors');
const { normalizeDomain } = require('../core/urls');
const { AREAS, SEVERITIES, BASES, FACT_KEYS } = require('../contracts/constants');

/**
 * Anti-corruption layer: Zuni-SEO Evidence Envelope v1  ->  ZTech ProviderResult.
 *
 * VERIFY (QwenCoder): the exact envelope field names are defined by the shared JSON
 * Schema in the zuni-seo repo (Evidence Envelope v1, draft 2020-12) and by the
 * golden fixtures shipped with zuni-seo v0.13.0. The path lists below accept several
 * likely spellings. Before enabling the real provider:
 *   1. Load one golden fixture envelope from zuni-seo.
 *   2. Run test/mapper.test.js with that fixture added.
 *   3. If a field is missing, add the real path to the FRONT of the matching list.
 * Do NOT change the ZTech EvidencePacket to match the envelope; change this file only.
 *
 * If the existing ztech-prospect-research bundle (dist/prospect-research.cjs) already
 * has a mapper that passes against the golden fixtures, reuse its field paths here.
 */
const ENVELOPE_PATHS = Object.freeze({
  contractVersion: ['contract_version', 'envelope_version', 'schema_version', 'version'],
  engineVersion: ['engine.version', 'engine_version', 'generator.version', 'tool.version'],
  outcome: ['status', 'outcome', 'result.status', 'research_status'],
  capturedAt: ['captured_at', 'generated_at', 'completed_at', 'created_at'],
  requestedUrl: ['target.requested_url', 'target.url', 'request.url', 'requested_url', 'url'],
  auditedUrl: ['target.final_url', 'target.audited_url', 'final_url', 'audited_url'],
  redirectChain: ['target.redirect_chain', 'redirect_chain', 'target.redirects', 'redirects'],
  areas: ['coverage', 'areas', 'completeness.areas'],
  facts: ['facts', 'evidence.facts'],
  findings: ['findings', 'evidence.findings'],
  strengths: ['strengths', 'evidence.strengths'],
  notMeasured: ['not_measured', 'evidence.not_measured', 'unmeasured'],
  limitations: ['limitations', 'caveats', 'warnings'],
  sources: ['sources', 'source_references', 'evidence.sources'],
});

/** Envelope fact key -> canonical ZTech fact key. VERIFY against the real envelope. */
const FACT_KEY_MAP = Object.freeze({
  'http.reachable': FACT_KEYS.HTTP_REACHABLE,
  reachable: FACT_KEYS.HTTP_REACHABLE,
  'site.reachable': FACT_KEYS.HTTP_REACHABLE,
  'http.final_status': FACT_KEYS.HTTP_FINAL_STATUS,
  'http.status': FACT_KEYS.HTTP_FINAL_STATUS,
  final_status: FACT_KEYS.HTTP_FINAL_STATUS,
  'crawl.html_pages': FACT_KEYS.CRAWL_HTML_PAGES,
  'crawl.pages': FACT_KEYS.CRAWL_HTML_PAGES,
  html_pages: FACT_KEYS.CRAWL_HTML_PAGES,
  pages_crawled: FACT_KEYS.CRAWL_HTML_PAGES,
  'tls.valid': FACT_KEYS.TLS_VALID,
  'tech.tls_valid': FACT_KEYS.TLS_VALID,
  'tech.platform': FACT_KEYS.TECH_PLATFORM,
  platform: FACT_KEYS.TECH_PLATFORM,
  'site.title': FACT_KEYS.SITE_TITLE,
  'home.title': FACT_KEYS.SITE_TITLE,
  'site.language': FACT_KEYS.SITE_LANGUAGE,
  'home.language': FACT_KEYS.SITE_LANGUAGE,
});

/** Facts whose value is text copied from the website -> untrusted (prompt-injection risk). */
const UNTRUSTED_FACT_KEYS = new Set([FACT_KEYS.SITE_TITLE, FACT_KEYS.SITE_LANGUAGE]);
const UNTRUSTED_KEY_HINT = /(title|description|heading|h1|text|excerpt|snippet|content|anchor|alt|body|name)/i;

const AREA_ALIASES = Object.freeze({
  identity: 'identity',
  tech: 'technical', technical: 'technical', security: 'technical', infrastructure: 'technical', performance: 'technical', vitals: 'technical',
  geo: 'content', aeo: 'content', content: 'content', schema: 'content', onpage: 'content', 'on-page': 'content',
  visibility: 'visibility', ai_visibility: 'visibility', serp: 'visibility', reputation: 'visibility', backlinks: 'visibility',
  crawl: 'crawl', indexing: 'crawl', robots: 'crawl', sitemap: 'crawl', ai_bots: 'crawl',
});

function mapArea(v) {
  if (typeof v !== 'string') return 'other';
  const k = v.toLowerCase().trim();
  if (AREAS.includes(k)) return k;
  return AREA_ALIASES[k] || 'other';
}

function mapOutcome(v) {
  const s = String(v || '').toLowerCase();
  if (['complete', 'completed', 'ok', 'success', 'succeeded', 'done'].includes(s)) return 'complete';
  if (['partial', 'incomplete', 'degraded'].includes(s)) return 'partial';
  if (['failed', 'error', 'unreachable'].includes(s)) return 'failed';
  return null;
}

function mapAreaStatus(v) {
  const s = String(v || '').toLowerCase();
  if (['measured', 'ok', 'complete', 'completed', 'done', 'assessed', 'true'].includes(s)) return 'measured';
  if (['failed', 'error'].includes(s)) return 'failed';
  return 'not_measured';
}

function mapSeverity(v) {
  const s = String(v || '').toLowerCase();
  return SEVERITIES.includes(s) ? s : 'info';
}

function mapBasis(v) {
  const s = String(v || '').toLowerCase();
  return BASES.includes(s) ? s : 'unknown';
}

function text(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

function scalarValue(v) {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return Number.isNaN(v) ? null : v;
  if (typeof v === 'string') return v.slice(0, 5000);
  if (v === undefined) return null;
  return JSON.stringify(v).slice(0, 5000);
}

function hostOf(url) {
  if (!url) return null;
  const d = normalizeDomain(String(url));
  return d.ok ? d.host : null;
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function malformed(message) {
  return new ProviderError('MALFORMED_ENVELOPE', message, { retryable: false });
}

/**
 * @param {object} envelope parsed JSON from Zuni-SEO
 * @param {{requestedDomain: string, providerJobId: string}} ctx
 * @returns {ProviderResult}
 */
function mapZuniSeoEnvelope(envelope, { requestedDomain, providerJobId }) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw malformed('Envelope is not an object');
  const P = ENVELOPE_PATHS;

  const contractVersion = pick(envelope, P.contractVersion);
  const engineVersion = pick(envelope, P.engineVersion);
  const outcome = mapOutcome(pick(envelope, P.outcome));
  const capturedAtRaw = pick(envelope, P.capturedAt);
  if (!contractVersion) throw malformed('Envelope has no contract version');
  if (!engineVersion) throw malformed('Envelope has no engine version');
  if (!outcome) throw malformed('Envelope has no recognised status');
  const capturedMs = Date.parse(capturedAtRaw);
  if (!capturedAtRaw || Number.isNaN(capturedMs)) throw malformed('Envelope has no valid capture time');

  const requestedHost = hostOf(pick(envelope, P.requestedUrl)) || requestedDomain;
  const auditedHost = hostOf(pick(envelope, P.auditedUrl));

  const redirectChain = asArray(pick(envelope, P.redirectChain))
    .slice(0, 20)
    .map((r) => (typeof r === 'string' ? { url: text(r, 2048), status: null } : {
      url: text(r && (r.url || r.location), 2048),
      status: Number.isInteger(r && r.status) ? r.status : null,
    }))
    .filter((r) => r.url);

  const areas = {};
  const rawAreas = pick(envelope, P.areas);
  if (rawAreas && typeof rawAreas === 'object' && !Array.isArray(rawAreas)) {
    for (const [k, v] of Object.entries(rawAreas)) {
      const area = mapArea(k);
      if (area === 'other') continue;
      const status = typeof v === 'object' && v !== null ? mapAreaStatus(v.status) : mapAreaStatus(v);
      areas[area] = status;
    }
  }

  const facts = [];
  const seenFactKeys = new Set();
  for (const f of asArray(pick(envelope, P.facts)).slice(0, 2000)) {
    if (!f || typeof f !== 'object') continue;
    const rawKey = text(f.key || f.id || f.name, 200);
    if (!rawKey || !/^[A-Za-z0-9_.:-]+$/.test(rawKey)) continue;
    const key = FACT_KEY_MAP[rawKey] || (rawKey.startsWith('zseo.') ? rawKey : `zseo.${rawKey}`).slice(0, 200);
    if (seenFactKeys.has(key)) continue;
    seenFactKeys.add(key);
    const untrusted = f.untrusted === true || UNTRUSTED_FACT_KEYS.has(key) || (typeof f.value === 'string' && UNTRUSTED_KEY_HINT.test(rawKey));
    facts.push({
      key,
      area: mapArea(f.area || f.category),
      label: text(f.label || f.title || rawKey, 300),
      value: scalarValue(f.value),
      sourceUrl: f.source_url || f.url ? text(f.source_url || f.url, 2048) : null,
      untrusted,
    });
  }
  const factKeyFor = (k) => FACT_KEY_MAP[k] || (String(k).startsWith('zseo.') ? k : `zseo.${k}`);

  const findings = [];
  for (const g of asArray(pick(envelope, P.findings)).slice(0, 1000)) {
    if (!g || typeof g !== 'object') continue;
    const ruleId = text(g.rule_id || g.id || g.code, 200);
    const title = text(g.title, 300);
    if (!ruleId || !/^[A-Za-z0-9_.:-]+$/.test(ruleId) || !title) continue;
    const refs = asArray(g.fact_keys || g.fact_ids || g.facts || getPath(g, 'evidence.facts'))
      .filter((x) => typeof x === 'string')
      .map(factKeyFor);
    findings.push({
      ruleId,
      area: mapArea(g.area || g.category || g.module),
      title,
      severity: mapSeverity(g.severity),
      basis: mapBasis(g.basis),
      observed: text(g.observed || g.evidence_text || g.detail, 4000),
      recommendation: text(g.recommendation || g.fix, 4000),
      urls: asArray(g.urls).filter((u) => typeof u === 'string').slice(0, 50).map((u) => u.slice(0, 2048)),
      factKeys: refs.slice(0, 50),
    });
  }

  const strengths = [];
  for (const s of asArray(pick(envelope, P.strengths)).slice(0, 200)) {
    if (!s || typeof s !== 'object') continue;
    const statement = text(s.statement || s.title || s.text, 1000);
    if (!statement) continue;
    strengths.push({
      statement,
      area: mapArea(s.area || s.category),
      factKeys: asArray(s.fact_keys || s.fact_ids || s.facts).filter((x) => typeof x === 'string').map(factKeyFor).slice(0, 50),
      ruleIds: asArray(s.rule_ids || s.finding_ids).filter((x) => typeof x === 'string').slice(0, 50),
    });
  }

  const notMeasured = [];
  for (const n of asArray(pick(envelope, P.notMeasured)).slice(0, 50)) {
    if (typeof n === 'string') notMeasured.push({ area: mapArea(n), reason: 'Not measured by the provider.' });
    else if (n && typeof n === 'object') notMeasured.push({ area: mapArea(n.area || n.category), reason: text(n.reason || n.message || 'Not measured by the provider.', 1000) });
  }
  for (const n of notMeasured) {
    if (n.area !== 'other' && !areas[n.area]) areas[n.area] = 'not_measured';
  }

  const limitations = [];
  for (const l of asArray(pick(envelope, P.limitations)).slice(0, 100)) {
    if (typeof l === 'string') limitations.push({ code: 'PROVIDER_NOTE', message: text(l, 1000) });
    else if (l && typeof l === 'object') limitations.push({ code: text(l.code || 'PROVIDER_NOTE', 100), message: text(l.message || l.text || '', 1000) });
  }

  const sourceReferences = [];
  for (const s of asArray(pick(envelope, P.sources)).slice(0, 500)) {
    if (typeof s === 'string') sourceReferences.push({ url: s.slice(0, 2048), kind: 'page' });
    else if (s && typeof s.url === 'string') sourceReferences.push({ url: s.url.slice(0, 2048), kind: text(s.kind || 'page', 50) });
  }

  return {
    requestedDomain: requestedHost,
    auditedDomain: auditedHost,
    redirectChain,
    outcome,
    capturedAt: new Date(capturedMs).toISOString(),
    engineVersion: text(engineVersion, 100),
    contractVersion: text(contractVersion, 100),
    providerJobId,
    areas,
    facts,
    findings,
    strengths,
    notMeasured,
    limitations,
    sourceReferences,
  };
}

module.exports = { mapZuniSeoEnvelope, ENVELOPE_PATHS, FACT_KEY_MAP, mapArea, mapOutcome };
