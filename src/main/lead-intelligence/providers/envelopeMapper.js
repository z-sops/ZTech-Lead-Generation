'use strict';

const { pick, getPath } = require('../core/objects');
const { ProviderError } = require('../core/errors');
const { normalizeDomain } = require('../core/urls');
const { AREAS, SEVERITIES, BASES, FACT_KEYS } = require('../contracts/constants');

/**
 * Anti-corruption layer: Zuni-SEO Evidence Envelope v1  ->  ZTech ProviderResult.
 *
 * TWO DIALECTS ARE ACCEPTED, and the dialect is detected from the data, never
 * assumed:
 *
 *   1. Zuni-SEO Evidence Envelope v1 - the real thing. The contract is
 *      vendored at contracts/zuni-seo/v1/contract.schema.json and the golden
 *      fixtures at tests/fixtures/zuni-seo/v1/. Its shape is:
 *        contract_version, subject{requested_url, audited_url, domain,
 *        redirected_from, identity{}}, run{job_id, engine_version, status,
 *        depth, max_pages, requested_at, finished_at, captured_at, crawl{}},
 *        completeness{technical, ai_access, content}, facts[{fact_id,
 *        statement, value, unit, basis, source{type, url, fetch_time,
 *        response_hash, excerpt}}], findings[{finding_id, rule_version,
 *        severity, basis, section, area, title, observation, affected_urls,
 *        affected_url_count, fact_ids, recommendation, what_it_means}],
 *        strengths[{strength_id, section, statement, fact_ids}],
 *        not_measured[{item, reason}], limits[], links{}
 *      This is mapped natively by mapZuniV1Envelope().
 *
 *   2. The flat/legacy alias dialect, which is what the Round-1 bridge
 *      normalises a v1 envelope into (engine.version, target.*, coverage,
 *      facts[].key, findings[].id, limitations[]). It is mapped by
 *      mapFlatEnvelope() and is unchanged.
 *
 * WHY THIS MATTERED (audit gap G-40): the flat dialect was the only one the
 * mapper understood, and it does not match the real v1 envelope. Against a
 * genuine ZuniSEO v1 envelope the old mapper threw MALFORMED_ENVELOPE, or -
 * worse - produced a result with EVERY FACT AND EVERY FINDING DROPPED, because
 * the real ids are `fact_id` / `finding_id` and the flat mapper looked for
 * `key` / `id` / `rule_id`. The v1 dialect is now mapped natively, so genuine
 * facts, findings, strengths, limitations, provenance and timestamps survive.
 *
 * Do NOT change the ZTech EvidencePacket to match the envelope; change this file only.
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
  // The research contract's ai_access section has no ZTech area of its own. It is
  // reported under `other` rather than being folded into `content` or
  // `visibility`, which would misstate where the evidence came from.
  ai_access: 'other', 'ai access': 'other',
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

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/* ------------------------------------------------------------------ v1 --- */

/** The research contract v1 version is `1.<minor>`. */
const ZUNI_V1_CONTRACT_PATTERN = /^1\.[0-9]+$/;
/** The contract's fact id pattern. */
const ZUNI_V1_FACT_ID_PATTERN = /^f[0-9]{3,}$/;
/** The contract's finding id pattern: a stable rule identifier. */
const ZUNI_V1_FINDING_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
/**
 * The contract's three research sections and the ZTech area each maps to.
 * `ai_access` has no ZTech area, so it is reported under `other`.
 */
const ZUNI_V1_SECTION_AREAS = Object.freeze({ technical: 'technical', content: 'content', ai_access: 'other' });

/**
 * Is this a Zuni-SEO Evidence Envelope v1?
 *
 * Marker-driven: a v1 envelope has a `run` block AND a `subject` or
 * `completeness` block, or declares a `1.x` contract version. The flat dialect
 * has `engine` / `target` / `coverage` and no `run` block, so it is never
 * mistaken for v1 - which is what keeps the Round-1 path unchanged.
 *
 * @param {unknown} envelope
 * @returns {boolean}
 */
function isZuniSeoV1Envelope(envelope) {
  if (!isObject(envelope)) return false;
  if (!isObject(envelope.run)) return false;
  if (isObject(envelope.subject) || isObject(envelope.completeness)) return true;
  return typeof envelope.contract_version === 'string' && ZUNI_V1_CONTRACT_PATTERN.test(envelope.contract_version);
}

/**
 * The integrity rules the research contract states but JSON Schema cannot
 * express. ZuniSEO enforces the same rules on its side
 * (zuni-seo/src/zunitech_seo/contract.py:envelope_integrity), so an envelope
 * that breaks them is not a contract envelope and must not be mapped into a
 * packet that would then carry dangling evidence references.
 *
 * @param {object} envelope
 * @throws {ProviderError} MALFORMED_ENVELOPE
 */
function assertZuniV1Integrity(envelope) {
  const factIds = new Set();
  for (const f of asArray(envelope.facts)) {
    if (!isObject(f)) continue;
    const id = typeof f.fact_id === 'string' ? f.fact_id : '';
    if (factIds.has(id)) throw malformed(`Envelope has a duplicate fact id: ${id}`);
    factIds.add(id);
  }
  for (const [group, idKey] of [['findings', 'finding_id'], ['strengths', 'strength_id']]) {
    const seen = new Set();
    for (const item of asArray(envelope[group])) {
      if (!isObject(item)) continue;
      const id = typeof item[idKey] === 'string' ? item[idKey] : '';
      if (seen.has(id)) throw malformed(`Envelope has a duplicate ${idKey}: ${id}`);
      seen.add(id);
      for (const ref of asArray(item.fact_ids)) {
        if (typeof ref !== 'string') continue;
        if (!factIds.has(ref)) throw malformed(`Envelope ${group} item ${id} references an unknown fact: ${ref}`);
      }
    }
  }
  for (const g of asArray(envelope.findings)) {
    if (!isObject(g)) continue;
    const count = g.affected_url_count;
    const urls = asArray(g.affected_urls);
    if (Number.isInteger(count) && count < urls.length) {
      throw malformed('Envelope finding reports fewer affected URLs than it lists');
    }
  }
}

/**
 * Map a genuine Zuni-SEO Evidence Envelope v1 to the ZTech ProviderResult.
 *
 * Every field the contract defines is read from the place the contract defines
 * it. Nothing is inferred from an absent field: a fact with no area is
 * reported under `other`, a finding that references no known fact keeps no
 * references, and a fact whose source has no URL keeps a null source URL.
 *
 * @param {object} envelope parsed Zuni-SEO v1 envelope
 * @param {{requestedDomain: string, providerJobId: string}} ctx
 * @returns {object} ProviderResult
 */
function mapZuniV1Envelope(envelope, { requestedDomain, providerJobId }) {
  if (!isObject(envelope)) throw malformed('Envelope is not an object');
  assertZuniV1Integrity(envelope);

  const run = isObject(envelope.run) ? envelope.run : {};
  const subject = isObject(envelope.subject) ? envelope.subject : {};
  const completeness = isObject(envelope.completeness) ? envelope.completeness : {};

  const contractVersion = text(envelope.contract_version, 100);
  if (!contractVersion) throw malformed('Envelope has no contract version');
  if (!ZUNI_V1_CONTRACT_PATTERN.test(contractVersion)) {
    throw malformed(`Unsupported Zuni-SEO research contract version: ${contractVersion}`);
  }
  const engineVersion = text(run.engine_version, 100);
  if (!engineVersion) throw malformed('Envelope has no engine version');
  const outcome = mapOutcome(run.status);
  if (!outcome) throw malformed('Envelope has no recognised status');
  const capturedRaw = run.captured_at || run.finished_at || run.requested_at;
  const capturedMs = Date.parse(capturedRaw);
  if (!capturedRaw || Number.isNaN(capturedMs)) throw malformed('Envelope has no valid capture time');

  const requestedHost = hostOf(subject.requested_url) || requestedDomain;
  const auditedHost = hostOf(subject.audited_url);

  const redirectChain = [];
  const redirectedFrom = text(subject.redirected_from, 2048);
  if (redirectedFrom) redirectChain.push({ url: redirectedFrom, status: null });

  // The contract's section status vocabulary is complete | partial | not_run |
  // failed. ZTech's area status vocabulary is measured | not_measured | failed.
  //
  // The contract has three sections and ZTech has no `ai_access` area. That
  // section is therefore NOT folded into an area: its status is reported as a
  // limitation instead, so nothing is claimed about an area the evidence does
  // not belong to.
  const areas = {};
  const sectionLimitations = [];
  for (const [section, entry] of Object.entries(completeness)) {
    const area = ZUNI_V1_SECTION_AREAS[section];
    const rawStatus = text(isObject(entry) ? entry.status : entry, 30).toLowerCase();
    if (!area || area === 'other') {
      if (rawStatus && rawStatus !== 'complete') {
        sectionLimitations.push({
          code: 'PROVIDER_SECTION_INCOMPLETE',
          message: `The ${section} section of the research did not complete (${rawStatus}).`,
        });
      }
      continue;
    }
    areas[area] = mapAreaStatus(rawStatus);
  }

  // FACTS. The contract's fact id IS the evidence identity, and findings
  // reference facts by that id, so the id is kept as the ZTech fact key. It is
  // NOT namespaced, because a namespaced key would break the finding -> fact
  // references unless every reference were rewritten with it.
  const facts = [];
  const factIds = new Set();
  for (const f of asArray(envelope.facts).slice(0, 2000)) {
    if (!isObject(f)) continue;
    const factId = text(f.fact_id, 200);
    if (!factId || !ZUNI_V1_FACT_ID_PATTERN.test(factId)) continue;
    if (factIds.has(factId)) continue;
    factIds.add(factId);
    const source = isObject(f.source) ? f.source : {};
    facts.push({
      key: factId,
      // The contract gives a fact no area of its own. `other` is the honest
      // answer; the source type is preserved in `source.type`.
      area: 'other',
      label: text(f.statement, 300) || factId,
      value: scalarValue(f.value),
      sourceUrl: source.url ? text(source.url, 2048) : null,
      // The contract states that source excerpts are verbatim text from the
      // target site and must be treated as untrusted data.
      untrusted: true,
      source: {
        type: text(source.type, 50),
        url: source.url ? text(source.url, 2048) : null,
        fetch_time: source.fetch_time ? text(source.fetch_time, 40) : null,
        response_hash: source.response_hash ? text(source.response_hash, 80) : null,
        excerpt: source.excerpt ? text(source.excerpt, 300) : null,
      },
    });
  }

  // FINDINGS. The contract's finding_id is the stable rule identifier, so it
  // becomes the ZTech rule id. A reference to a fact this envelope does not
  // carry is dropped rather than kept dangling - the contract's own integrity
  // rules forbid it, and assertZuniV1Integrity has already rejected it.
  const findings = [];
  for (const g of asArray(envelope.findings).slice(0, 1000)) {
    if (!isObject(g)) continue;
    const ruleId = text(g.finding_id, 200);
    const title = text(g.title, 300);
    if (!ruleId || !ZUNI_V1_FINDING_ID_PATTERN.test(ruleId) || !title) continue;
    findings.push({
      ruleId,
      area: mapArea(g.area || g.section),
      title,
      severity: mapSeverity(g.severity),
      basis: mapBasis(g.basis),
      observed: text(g.observation, 4000),
      recommendation: text(g.recommendation, 4000),
      whatItMeans: g.what_it_means ? text(g.what_it_means, 2000) : null,
      urls: asArray(g.affected_urls).filter((u) => typeof u === 'string').slice(0, 50).map((u) => text(u, 2048)),
      factKeys: asArray(g.fact_ids).filter((x) => typeof x === 'string' && factIds.has(x)).slice(0, 50),
    });
  }

  // STRENGTHS.
  const strengths = [];
  for (const s of asArray(envelope.strengths).slice(0, 200)) {
    if (!isObject(s)) continue;
    const statement = text(s.statement, 1000);
    if (!statement) continue;
    strengths.push({
      statement,
      area: mapArea(s.area || s.section),
      factKeys: asArray(s.fact_ids).filter((x) => typeof x === 'string' && factIds.has(x)).slice(0, 50),
      ruleIds: [],
    });
  }

  // NOT MEASURED. The contract's `item` is a free-text item, not an area, so
  // it is reported verbatim under `other` rather than being mapped onto a
  // guessed area.
  const notMeasured = [];
  for (const n of asArray(envelope.not_measured).slice(0, 50)) {
    if (typeof n === 'string') {
      notMeasured.push({ area: 'other', reason: 'Not measured by the provider.' });
    } else if (isObject(n)) {
      notMeasured.push({
        area: mapArea(n.area),
        reason: `${text(n.item, 200)}: ${text(n.reason, 800)}`.slice(0, 1000),
      });
    }
  }
  for (const n of notMeasured) {
    if (n.area !== 'other' && !areas[n.area]) areas[n.area] = 'not_measured';
  }

  // LIMITATIONS. The contract's field is `limits`, an array of strings.
  const limitations = [];
  for (const l of asArray(envelope.limits).slice(0, 100)) {
    if (typeof l === 'string') limitations.push({ code: 'PROVIDER_LIMIT', message: text(l, 1000) });
    else if (isObject(l)) limitations.push({ code: text(l.code, 100) || 'PROVIDER_LIMIT', message: text(l.message || l.text, 1000) });
  }
  limitations.push(...sectionLimitations);

  // SOURCE REFERENCES. The contract records no top-level source list; the
  // provenance of a fact is its own source. Distinct (kind, url) pairs become
  // the packet's source references, so the provenance survives.
  const sourceReferences = [];
  const seenSources = new Set();
  for (const f of facts) {
    const src = f.source;
    if (!src || !src.url) continue;
    const key = `${src.type}|${src.url}`;
    if (seenSources.has(key)) continue;
    seenSources.add(key);
    sourceReferences.push({ url: src.url, kind: src.type || 'page' });
  }

  return {
    requestedDomain: requestedHost,
    auditedDomain: auditedHost,
    redirectChain,
    outcome,
    capturedAt: new Date(capturedMs).toISOString(),
    engineVersion,
    contractVersion,
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

/**
 * @param {object} envelope parsed JSON from Zuni-SEO
 * @param {{requestedDomain: string, providerJobId: string}} ctx
 * @returns {ProviderResult}
 */
function mapZuniSeoEnvelope(envelope, { requestedDomain, providerJobId }) {
  // A genuine v1 envelope is mapped natively. The flat dialect is mapped by
  // mapFlatEnvelope(), whose behaviour is unchanged.
  if (isZuniSeoV1Envelope(envelope)) return mapZuniV1Envelope(envelope, { requestedDomain, providerJobId });
  return mapFlatEnvelope(envelope, { requestedDomain, providerJobId });
}

/**
 * The flat/legacy alias dialect. Unchanged in behaviour; it is still what the
 * Round-1 bridge normalises a v1 envelope into, and what the vendored module
 * tests use.
 */
function mapFlatEnvelope(envelope, { requestedDomain, providerJobId }) {
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
      // A provider that reports its own provenance for a fact keeps it.
      ...(isObject(f.source) ? {
        source: {
          type: text(f.source.type, 50),
          url: f.source.url ? text(f.source.url, 2048) : null,
          fetch_time: f.source.fetch_time ? text(f.source.fetch_time, 40) : null,
          response_hash: f.source.response_hash ? text(f.source.response_hash, 80) : null,
          excerpt: f.source.excerpt ? text(f.source.excerpt, 300) : null,
        },
      } : {}),
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
      whatItMeans: g.what_it_means || g.whatItMeans ? text(g.what_it_means || g.whatItMeans, 2000) : null,
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

module.exports = {
  mapZuniSeoEnvelope,
  mapZuniV1Envelope,
  mapFlatEnvelope,
  isZuniSeoV1Envelope,
  assertZuniV1Integrity,
  ENVELOPE_PATHS,
  FACT_KEY_MAP,
  mapArea,
  mapOutcome,
  ZUNI_V1_SECTION_AREAS,
  ZUNI_V1_CONTRACT_PATTERN,
};
