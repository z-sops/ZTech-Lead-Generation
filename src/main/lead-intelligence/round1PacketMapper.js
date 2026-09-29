'use strict';

/**
 * A10 — Round-1 result mapper (anti-corruption layer).
 *
 * `prospect_research.record_json` stores Round-1's OWN record shape, not the raw
 * Zuni-SEO envelope. That record carries:
 *
 *   id, leadRef, website, phase, providerJobId, createdAt, updatedAt, finishedAt,
 *   pendingReason, failureReason, failureMessage, version,
 *   packet: <the Zuni-SEO Evidence Envelope v1 that Round-1 stored>
 *
 * This file is the single place that knows how to read it. It is INJECTED into
 * Round1ResearchBridge; the bridge itself holds no Round-1-specific knowledge.
 *
 * Two envelope dialects are accepted, and nothing is ever guessed:
 *
 *  1. Zuni-SEO Evidence Envelope v1 (what Round-1 actually stores):
 *     run.engine_version, run.status, run.captured_at, subject.requested_url,
 *     subject.audited_url, completeness.<section>.status, facts[].fact_id,
 *     findings[].finding_id / .observation / .affected_urls / .fact_ids,
 *     strengths[].fact_ids, not_measured[].item, limits[], packet.availability.
 *
 *  2. The flat/legacy alias dialect the vendored module tests use:
 *     engine.version, status, captured_at, target.requested_url, coverage,
 *     facts[].key, findings[].id / .observed / .urls / .fact_keys.
 *
 * A dialect is only selected when its marker is genuinely present, so a value is
 * never inferred from an absent field. Everything that cannot be established from
 * the stored Round-1 data falls back to the explicit UNKNOWN / unavailable
 * semantics below rather than to an invented value.
 */

const { mapZuniSeoEnvelope } = require('./providers/envelopeMapper');
const { AREAS, AREA_STATUS } = require('./contracts/constants');

/**
 * Explicit A10 defaults. Each one is a deliberate "we do not know" answer, never
 * a semantic guess about the prospect.
 */
const DEFAULTS = Object.freeze({
  /** Round-1 records a fact's identity as its id; that id IS the fact key. */
  factKey: 'fact_id',
  /** Round-1 findings state no epistemic basis in the v1 contract. */
  observedBasis: 'unknown',
  /** Round-1 has no canonical ZTech "ai_access" area. */
  aiAccessArea: 'other',
  /** A round-1 result with no crawlable content is a failed research outcome. */
  noCrawlableContentOutcome: 'failed',
  severity: 'info',
  basis: 'unknown',
  area: 'other',
  areaStatus: 'not_measured',
  outcome: 'failed',
});

const ZUNI_V1_AREAS = Object.freeze({
  technical: 'technical',
  ai_access: DEFAULTS.aiAccessArea,
  content: 'content',
});

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function text(v, max) {
  if (v === undefined || v === null) return '';
  return String(v).slice(0, max);
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Dialect detection. Marker-driven only: `run.engine_version` + `subject.*` prove
 * the v1 envelope; `engine.version` or a top-level `contract_version` with
 * `target.*` proves the flat dialect. Anything else is not rewritten.
 */
function detectDialect(packet) {
  if (!isObject(packet)) return 'unknown';
  if (isObject(packet.run) && (isObject(packet.subject) || packet.subject === undefined && isObject(packet.completeness))) return 'zuni-v1';
  if (isObject(packet.run)) return 'zuni-v1';
  if (isObject(packet.target) || isObject(packet.engine) || isObject(packet.coverage)) return 'flat';
  return 'unknown';
}

/** Round-1's own availability vocabulary -> a ZTech research outcome. */
function outcomeFor(record, envelope) {
  // `state` is the bridge's normalised terminal state; `phase` is the raw field.
  const phase = text((record && (record.state || record.rawState)) || (record && record.phase), 60).toLowerCase();
  const availability = text(
    (envelope && (envelope.availability || (isObject(envelope.run) && envelope.run.availability))) || (record && record.availability),
    60
  ).toLowerCase();
  if (availability === 'no_crawlable_content') return DEFAULTS.noCrawlableContentOutcome;
  if (phase === 'complete') return 'complete';
  if (phase === 'partial') return 'partial';
  if (phase === 'failed') return DEFAULTS.noCrawlableContentOutcome;
  return DEFAULTS.outcome;
}

/** Rewrite Zuni-SEO Evidence Envelope v1 into the flat dialect the mapper reads. */
function fromZuniV1(packet, record) {
  const run = isObject(packet.run) ? packet.run : {};
  const subject = isObject(packet.subject) ? packet.subject : {};
  const provenance = isObject(packet.provenance) ? packet.provenance : {};
  const availability = packet.availability || run.availability || null;
  const outcome = outcomeFor(record, { ...packet, availability });

  const completeness = {};
  const rawCompleteness = isObject(packet.completeness) ? packet.completeness : {};
  for (const [section, entry] of Object.entries(rawCompleteness)) {
    const area = ZUNI_V1_AREAS[section] || DEFAULTS.area;
    if (area === DEFAULTS.area) continue;
    const status = isObject(entry) ? text(entry.status, 30).toLowerCase() : text(entry, 30).toLowerCase();
    if (AREA_STATUS.includes(status)) completeness[area] = status;
  }

  const facts = asArray(packet.facts).map((f) => {
    if (!isObject(f)) return null;
    // "fact key = fact ID": the stored fact id is the key. No other key is invented.
    const factId = text(f.fact_id !== undefined ? f.fact_id : f.id, 200);
    const source = isObject(f.source) ? f.source : {};
    return {
      key: factId,
      label: text(f.statement, 300) || factId,
      value: f.value === undefined ? null : f.value,
      area: text(f.area, 40),
      untrusted: true,
      source_url: text(source.url, 2048) || null,
    };
  }).filter(Boolean);

  const factsById = new Set(facts.map((f) => f.key));

  const findings = asArray(packet.findings).map((g) => {
    if (!isObject(g)) return null;
    const findingId = text(g.finding_id !== undefined ? g.finding_id : g.id, 200);
    const title = text(g.title, 300);
    if (!title) return null;
    return {
      // rule_id: v1 has no separate rule id, so the finding's stable id is used.
      id: findingId || `finding_${title}`,
      title,
      severity: text(g.severity, 30).toLowerCase(),
      // v1 DOES carry a basis; it is passed through so genuine data is not
      // discarded. The shared mapper reduces a basis outside the ZTech
      // vocabulary (e.g. v1 "observed") to `unknown` rather than guessing.
      basis: text(g.basis, 30).toLowerCase() || DEFAULTS.observedBasis,
      area: text(g.area, 40) || text(g.section, 40),
      // observation -> observed
      observed: text(g.observation, 4000),
      recommendation: text(g.recommendation, 4000),
      // affectedUrls -> urls
      urls: asArray(g.affected_urls).filter((u) => typeof u === 'string').slice(0, 50).map((u) => text(u, 2048)),
      // factIds -> fact_keys, keeping only ids this record actually carries.
      fact_keys: asArray(g.fact_ids).filter((x) => typeof x === 'string' && factsById.has(x)).slice(0, 50),
    };
  }).filter(Boolean);

  const strengths = asArray(packet.strengths).map((s) => {
    if (!isObject(s)) return null;
    const statement = text(s.statement, 1000);
    if (!statement) return null;
    return {
      statement,
      area: text(s.area, 40) || text(s.section, 40),
      fact_keys: asArray(s.fact_ids).filter((x) => typeof x === 'string' && factsById.has(x)).slice(0, 50),
    };
  }).filter(Boolean);

  const notMeasured = asArray(packet.not_measured).map((n) => {
    if (typeof n === 'string') return { area: text(n, 40), reason: 'Not measured by Round-1 research.' };
    if (!isObject(n)) return null;
    // not_measured[].item is a free-text ITEM, not a ZTech area: it is reported
    // verbatim under `other` rather than being mapped onto a guessed area.
    return { area: text(n.area, 40) || DEFAULTS.area, reason: `${text(n.item, 200)}: ${text(n.reason, 800)}`.slice(0, 1000) };
  }).filter(Boolean);

  const limitations = asArray(packet.limits).map((l) => {
    if (typeof l === 'string') return { code: 'ROUND1_LIMIT', message: text(l, 1000) };
    if (isObject(l)) return { code: text(l.code, 100) || 'ROUND1_LIMIT', message: text(l.message, 1000) };
    return null;
  }).filter(Boolean);

  const redirectedFrom = text(subject.redirected_from, 2048);
  // Round-1's own `availability` is authoritative for the outcome: a job can be
  // reported "partial" while the packet says it found no crawlable content.
  const hasAvailability = Boolean(availability);
  const mappedStatus = ['complete', 'partial', 'failed'].includes(outcome) ? outcome : text(run.status, 30);

  return {
    contract_version: text(packet.contract_version, 100) || 'round1.packet/1',
    engine: { version: text(run.engine_version || provenance.engine_version, 100) },
    status: hasAvailability ? mappedStatus : (text(run.status, 30) || mappedStatus),
    captured_at: text(run.captured_at || provenance.capturedAt || provenance.finishedAt, 100) || text(record && (record.updatedAt || record.createdAt), 100),
    target: {
      requested_url: text(subject.requested_url || record.website, 2048),
      final_url: text(subject.audited_url, 2048) || null,
      redirect_chain: redirectedFrom ? [{ url: redirectedFrom, status: null }] : [],
    },
    coverage: completeness,
    facts,
    findings,
    strengths,
    not_measured: notMeasured,
    limitations,
    // v1 records no per-URL source list; nothing is invented.
    sources: [],
  };
}

/**
 * Round-1's v1 contract gives a fact no canonical ZTech key, so the shared
 * envelope mapper namespaces it as "zseo.<id>". The A10 default is explicit:
 * the FACT ID is the fact key. This restores that, and rewrites the references
 * to it, so a Round-1 fact id stays the same key the provider recorded.
 */
function restoreFactIdKeys(result, view) {
  const ids = asArray(view.facts).map((f) => f && f.key).filter((k) => typeof k === 'string' && k !== '');
  if (!ids.length) return result;
  const alias = new Map(ids.map((id) => [`zseo.${id}`, id]));
  for (const f of result.facts) if (alias.has(f.key)) f.key = alias.get(f.key);
  for (const g of result.findings) g.factKeys = (g.factKeys || []).map((k) => (alias.has(k) ? alias.get(k) : k));
  for (const s of result.strengths) s.factKeys = (s.factKeys || []).map((k) => (alias.has(k) ? alias.get(k) : k));
  return result;
}

/**
 * A10 mapper. Maps ONE completed Round-1 record to the ProviderResult shape the
 * EvidencePacket builder consumes. Throws on a record that cannot be mapped; the
 * bridge turns that into a `MALFORMED_RESULT` rejection.
 *
 * @param {object} record normalised Round-1 record (normalizeRound1Record output)
 * @param {{requestedDomain?: string, providerJobId?: string}} [ctx]
 */
function round1PacketMapper(record, ctx = {}) {
  if (!isObject(record)) throw new Error('Round-1 record is not an object');
  const envelope = isObject(record.result) ? record.result
    : isObject(record.packet) ? record.packet
      : null;
  if (!envelope) throw new Error('Round-1 record carries no packet envelope');

  const dialect = detectDialect(envelope);
  if (dialect === 'unknown') throw new Error('Round-1 packet matches no known envelope dialect');

  const view = dialect === 'zuni-v1' ? fromZuniV1(envelope, record) : envelope;
  const requestedDomain = ctx.requestedDomain
    || text(record.domain, 2048)
    || text(envelope.subject && envelope.subject.requested_url, 2048)
    || text(record.website, 2048);
  const providerJobId = ctx.providerJobId || record.providerJobId || record.recordId;

  const result = mapZuniSeoEnvelope(view, { requestedDomain, providerJobId });
  if (dialect === 'zuni-v1') restoreFactIdKeys(result, view);

  // A10 explicit defaults that survive mapping: an availability the mapper cannot
  // express, and the areas Round-1 does not measure.
  if (!result.areas[DEFAULTS.aiAccessArea]) result.areas[DEFAULTS.aiAccessArea] = DEFAULTS.areaStatus;
  if (result.outcome === DEFAULTS.noCrawlableContentOutcome) {
    for (const f of result.findings) if (!f.basis) f.basis = DEFAULTS.observedBasis;
  }
  return result;
}

module.exports = { round1PacketMapper, detectDialect, fromZuniV1, outcomeFor, restoreFactIdKeys, DEFAULTS, ZUNI_V1_AREAS };
