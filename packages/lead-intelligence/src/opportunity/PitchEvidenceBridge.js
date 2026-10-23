'use strict';

const { newId, stableId } = require('../core/ids');
const { makeProvenance } = require('../contracts/provenance');
const { PACKET_CONTRACT_VERSION, BASES } = require('../contracts/constants');
const { validateEvidencePacket, indexPacket } = require('../contracts/evidencePacket');

/**
 * Pitch Evidence Bridge: OI IntelligenceReport -> EvidencePacket-compatible context.
 *
 * WHY A BRIDGE AND NOT A REUSE
 * ----------------------------
 * PitchGenerator reads exactly one shape: an EvidencePacket with `findings`
 * carrying severity + basis + observed text, plus facts those findings reference.
 * OI has a richer and differently-typed model. So the bridge projects the small
 * slice of OI that is genuinely useful for a pitch into that shape, and carries
 * OI's own identifiers alongside it.
 *
 * THE ONE RULE THAT MATTERS: A CLAIM KIND IS NEVER UPGRADED
 * ----------------------------------------------------------
 * OI says `fact`, `estimate` or `inference`. ZTech's EvidencePacket says `basis`
 * in (standard / research / heuristic / unknown). The mapping is one-way and
 * deliberately unequal:
 *
 *   fact      -> standard     an observed, provider-sourced fact
 *   estimate  -> research     derived from evidence but not directly observed
 *   inference -> heuristic    a conclusion drawn by the engine
 *   (absent)  -> unknown      never defaulted to fact
 *
 * The asymmetry matters: PitchGenerator only draws observations from findings
 * whose basis is `standard` or `research`, so an `inference` lands on `heuristic`
 * and is therefore structurally EXCLUDED from pitch observations. An OI
 * opportunity - always an inference - cannot reach a pitch observation through
 * this bridge even if someone asked for it.
 *
 * Because `heuristic` cannot fully express "this was an engine inference with a
 * confidence of 0.6", the OI claim_kind is preserved verbatim in a sidecar
 * `claim_kinds` map keyed by the generated fact_id / finding_id, plus per-item
 * `oi_claim_kind` / `oi_confidence` / `oi_ids` on the bridge result. Nothing is
 * flattened into the weaker type: it is carried next to it.
 *
 * WHAT IT BRIDGES, and nothing else: verified prospect observations, competitor
 * differences, high-confidence opportunities (as evidence, never as the claim
 * itself), sales-angle evidence, and limitations/provenance.
 *
 * WHAT IT NEVER DOES:
 *   - invent a fact
 *   - turn an inference into a fact
 *   - turn an estimate into an observed fact
 *   - score, re-rank or re-word an opportunity
 *   - create an observation for a provider that was unavailable
 */

const BOUNDS = Object.freeze({
  maxFacts: 200,
  maxFindings: 40,
  maxStrengths: 20,
  maxLimitations: 50,
  maxUrlsPerFinding: 5,
  minConfidence: 0.5,
});

/** Severity ranking used only to order already-pitch-eligible findings. */
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

/** ClaimKind -> EvidencePacket basis. One-way. Nothing maps back to `standard` except `fact`. */
const CLAIM_KIND_TO_BASIS = Object.freeze({
  fact: 'standard',
  estimate: 'research',
  inference: 'heuristic',
});

function basisFor(claimKind) {
  return CLAIM_KIND_TO_BASIS[claimKind] || 'unknown';
}

/** pitch-eligible means: OI claim_kind is fact or estimate. Never inference. */
function isPitchEligible(claimKind) {
  return claimKind === 'fact' || claimKind === 'estimate';
}

/**
 * Build the bridge result.
 *
 * @param {object} input
 * @param {object} input.report   a validated IntelligenceReport (raw OI shape)
 * @param {string|number} input.leadId
 * @param {object} input.view     the lead view (name/domain/etc.), as PitchGenerator expects
 * @param {object} [input.freshness] { staleAfterHours }
 * @param {Date}   [input.now]
 * @param {Function} [input.freshnessPolicy] optional injected clock/policy for tests
 * @returns {object} { packet, claim_kinds, oi, counts, excluded }
 */
function buildPitchEvidenceBridge({ report, leadId, view = {}, freshness = {}, now = new Date() }) {
  if (!report || typeof report !== 'object') throw new TypeError('buildPitchEvidenceBridge requires a report');
  if (leadId === undefined || leadId === null || leadId === '') throw new TypeError('buildPitchEvidenceBridge requires leadId');

  const generatedAt = report.generated_at || now.toISOString();
  const packetId = newId('pkt');
  const lead = String(leadId);
  const jobId = oiJobId(report);
  const providerId = 'opportunity-intelligence';
  const engineVersion = `ztech-oi/${String(report.schema_version || '1.0')}`;

  // Provider status per channel, so every fact records WHICH provider produced it
  // and the bridge can honestly mark a channel as not measured.
  const channelStatus = channelStatusMap(report);

  const baseProv = {
    provider: providerId,
    captured_at: generatedAt,
    engine_version: engineVersion,
    contract_version: OI_SOURCE_CONTRACT_VERSION,
    lead_id: lead,
    packet_id: packetId,
  };

  /** claim_kinds[id] = the OI ClaimKind, kept verbatim next to the packet. */
  const claimKinds = Object.create(null);
  const oiIds = Object.create(null);
  const excluded = { inferences: 0, low_confidence: 0, no_evidence: 0, unresolved_refs: 0, opportunities_not_bridged: 0 };

  const evidenceByOiId = new Map(); // oi evidence_id -> generated fact_id

  // ---------------------------------------------------------------- facts ----
  const facts = [];
  for (const e of report.evidence || []) {
    if (facts.length >= BOUNDS.maxFacts) break;
    const kind = normKind(e.claim_kind);
    const conf = typeof e.confidence === 'number' ? e.confidence : 0;
    if (conf < BOUNDS.minConfidence) { excluded.low_confidence += 1; continue; }
    if (!e.claim || String(e.claim).trim() === '') { excluded.no_evidence += 1; continue; }

    const factId = stableId('fact', packetId, String(e.evidence_id), facts.length);
    evidenceByOiId.set(String(e.evidence_id), factId);
    claimKinds[factId] = kind;
    oiIds[factId] = { evidence_id: String(e.evidence_id), provider: String(e.provider || ''), confidence: conf };

    facts.push({
      fact_id: factId,
      key: `oi.${String(e.provider || 'unknown')}.${slug(e.metric || e.claim)}`,
      area: areaFor(e),
      label: truncate(String(e.claim), 300),
      // The VALUE is always OI's own value. For an inference OI's `value` is
      // usually null and the claim text carries the conclusion; that is preserved
      // rather than being promoted into a numeric observation.
      value: e.value === undefined ? null : boundedValue(e.value),
      untrusted: false,
      source_url: e.source_url ? truncate(String(e.source_url), 2048) : null,
      provenance: makeProvenance({ ...baseProv, source_url: e.source_url, fact_id: factId }),
    });
  }

  // ------------------------------------------------------------- findings ----
  // Only claim kinds that are NOT inference become findings at all. An inference
  // is represented by the evidence it rests on, never by a finding that a pitch
  // could quote.
  const findings = [];
  const strengthCandidates = [];

  const addFinding = ({ ruleId, title, observed, severity, claimKind, confidence, sourceUrl, refOids, area }) => {
    if (findings.length >= BOUNDS.maxFindings) return null;
    const findingId = stableId('find', packetId, String(ruleId), findings.length);
    const factIds = [];
    for (const oid of refOids) {
      const fid = evidenceByOiId.get(String(oid));
      if (fid) factIds.push(fid);
      else excluded.unresolved_refs += 1;
    }
    if (factIds.length === 0) { excluded.no_evidence += 1; return null; }
    claimKinds[findingId] = claimKind;
    oiIds[findingId] = { rule_id: String(ruleId), confidence, evidence_refs: refOids.map(String) };
    findings.push({
      finding_id: findingId,
      rule_id: String(ruleId),
      area: area || 'other',
      title: truncate(title, 300),
      severity,
      basis: basisFor(claimKind),
      observed: truncate(observed, 4000),
      recommendation: '',
      urls: sourceUrl ? [truncate(String(sourceUrl), 2048)].slice(0, BOUNDS.maxUrlsPerFinding) : [],
      fact_ids: [...new Set(factIds)],
      provenance: makeProvenance({ ...baseProv, source_url: sourceUrl, finding_id: findingId }),
    });
    return findingId;
  };

  // 1. Verified prospect observations: OI evidence of kind `fact` on the prospect.
  for (const e of report.evidence || []) {
    if (findings.length >= BOUNDS.maxFindings) break;
    const kind = normKind(e.claim_kind);
    if (kind === 'inference') continue;
    if (String(e.entity_id) !== String((report.prospect || {}).entity_id)) continue;
    addFinding({
      ruleId: `oi.observed.${slug(e.metric || e.claim)}`,
      title: truncate(String(e.claim), 300),
      observed: describeClaim(e, kind),
      severity: 'medium',
      claimKind: kind,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
      sourceUrl: e.source_url,
      refOids: [e.evidence_id],
    });
  }

  // 2. Competitor differences: OI comparisons, projected as findings that cite
  //    the evidence on BOTH sides. ZTech does not compute the difference; it
  //    carries OI's own comparison and its interpretation.
  //
  //    OI's Comparison model has NO claim_kind field, so the bridge does not
  //    invent one: it derives the kind from the evidence the comparison cites,
  //    strongest first. A comparison resting only on inferences produces no
  //    finding at all, and a comparison with no resolvable evidence cannot
  //    produce one either.
  for (const c of report.comparisons || []) {
    if (findings.length >= BOUNDS.maxFindings) break;
    const refs = c.evidence_refs || [];
    if (!refs.length) { excluded.no_evidence += 1; continue; }
    const kind = strongestKindAmong(report, refs);
    if (!kind || kind === 'inference') { excluded.inferences += 1; continue; }
    const competitor = (report.competitors || []).find((x) => String(x.entity_id) === String(c.competitor_id));
    const prospectObs = c.prospect_observed;
    const competitorObs = c.competitor_observed;
    addFinding({
      ruleId: `oi.comparison.${slug(c.dimension)}`,
      title: `${slug(c.dimension).replace(/^./, (m) => m.toUpperCase())}${competitor ? ` vs ${truncate(competitor.company_name, 80)}` : ''}`,
      observed: `OI comparison on ${c.dimension}: prospect ${fmt(prospectObs)}${c.unit ? ` ${c.unit}` : ''}, competitor ${fmt(competitorObs)}${c.unit ? ` ${c.unit}` : ''}. OI interpretation: ${c.interpretation}.`
        + (c.note ? ` Note: ${truncate(String(c.note), 300)}` : ''),
      severity: 'medium',
      claimKind: kind,
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      sourceUrl: null,
      refOids: refs,
    });
  }

  // 3. Sales-angle evidence: OI's angles become findings so a pitch can cite the
  //    evidence behind an angle. The ANGLE ITSELF is an inference in OI terms,
  //    so the finding carries the angle's supporting evidence and is typed by the
  //    kind of that evidence - never by the angle being "a fact".
  for (const a of report.sales_angles || []) {
    if (findings.length >= BOUNDS.maxFindings) break;
    const refs = a.evidence_refs || [];
    if (!refs.length) { excluded.no_evidence += 1; continue; }
    const strongest = strongestKindAmong(report, refs);
    if (!strongest || strongest === 'inference') { excluded.inferences += 1; continue; }
    addFinding({
      ruleId: `oi.angle.${slug(a.angle)}`,
      title: truncate(String(a.angle), 300),
      observed: `${truncate(String(a.summary), 600)} (OI confidence ${fmt(a.confidence)}; the angle is OI's inference, the cited evidence is ${strongest}.)`,
      severity: 'medium',
      claimKind: strongest,
      confidence: typeof a.confidence === 'number' ? a.confidence : 0,
      sourceUrl: null,
      refOids: refs,
    });
    strengthCandidates.push({ statement: truncate(String(a.summary), 1000), refOids: refs });
  }

  // Opportunities are NEVER findings. OI types every opportunity as `inference`,
  // and the basis they would map to (`heuristic`) is excluded from pitch
  // observations by PitchGenerator. They are counted here so the bridge can
  // report that it saw them and declined to bridge them.
  const opportunitiesSeen = (report.opportunities || []).length;
  excluded.opportunities_not_bridged = opportunitiesSeen;

  // ------------------------------------------------------------ strengths ----
  const strengths = [];
  for (const s of strengthCandidates) {
    if (strengths.length >= BOUNDS.maxStrengths) break;
    const factIds = s.refOids.map((o) => evidenceByOiId.get(String(o))).filter(Boolean);
    if (!factIds.length) { excluded.no_evidence += 1; continue; }
    const sid = stableId('str', packetId, s.statement, strengths.length);
    strengths.push({
      strength_id: sid,
      area: 'other',
      statement: s.statement,
      fact_ids: [...new Set(factIds)],
      finding_ids: [],
      provenance: makeProvenance({ ...baseProv, fact_id: factIds[0], finding_id: null }),
    });
  }

  // ------------------------------------------------------------- areas -------
  // An area is `not_measured` when NO provider supporting it succeeded. This is
  // how an unavailable provider stays visible in the packet rather than being
  // silently dropped.
  const areas = {
    identity: facts.length > 0 ? 'measured' : 'not_measured',
    technical: 'not_measured',
    content: channelOk(channelStatus, 'content') ? 'measured' : 'not_measured',
    visibility: channelOk(channelStatus, 'visibility') ? 'measured' : 'not_measured',
    crawl: 'not_measured',
    other: 'measured',
  };

  // OI status -> ZTech research_status. `partial` stays `partial`; a failed OI
  // report stays failed so PitchGenerator refuses to draw observations.
  const researchStatus = report.status === 'failed' ? 'failed'
    : (report.status === 'completed' && Object.values(areas).every((v) => v === 'measured') ? 'complete' : 'partial');
  const outcome = researchStatus === 'failed' ? 'failed' : (facts.length > 0 || strengths.length > 0 ? 'complete' : 'partial');

  const notMeasured = [];
  for (const [area, state] of Object.entries(areas)) {
    if (state === 'not_measured') {
      notMeasured.push({ area, reason: `No successful Opportunity Intelligence provider produced ${area} data.` });
    }
  }

  const limitations = [];
  for (const l of (report.limitations || []).slice(0, BOUNDS.maxLimitations)) {
    limitations.push({ code: 'OI_LIMITATION', message: truncate(String(l), 1000) });
  }
  // Every unavailable / unsupported / failed provider becomes an explicit
  // limitation, so a degraded report cannot be read as a complete one.
  for (const ps of flatProviderStatus(report)) {
    if (ps.status === 'success') continue;
    limitations.push({
      code: `OI_PROVIDER_${ps.status.toUpperCase()}`,
      message: `OI provider "${ps.provider}" reported ${ps.status} for ${ps.entity_key}. Its data is absent from this packet, not refuted.`,
    });
  }
  if (excluded.opportunities_not_bridged > 0) {
    limitations.push({
      code: 'OI_OPPORTUNITIES_NOT_BRIDGED',
      message: `${excluded.opportunities_not_bridged} OI opportunity/opportunities were not bridged into EvidencePacket findings: OI types every opportunity as an inference and inferences are not pitch-observable. They remain available in the Opportunity Intelligence view.`,
    });
  }
  if (excluded.inferences > 0) {
    limitations.push({
      code: 'OI_INFERENCES_NOT_BRIDGED',
      message: `${excluded.inferences} inference-typed comparison(s)/angle(s) were not bridged as findings; only their underlying evidence was carried.`,
    });
  }
  if (excluded.low_confidence > 0) {
    limitations.push({
      code: 'OI_LOW_CONFIDENCE_DROPPED',
      message: `${excluded.low_confidence} evidence item(s) below confidence ${BOUNDS.minConfidence} were not bridged.`,
    });
  }
  if (excluded.unresolved_refs > 0) {
    limitations.push({
      code: 'OI_UNRESOLVED_REF',
      message: `${excluded.unresolved_refs} evidence reference(s) could not be resolved in this report and were not carried.`,
    });
  }

  const staleAfterHours = Number.isInteger(freshness.staleAfterHours) ? freshness.staleAfterHours : 720;
  const expiresAt = new Date(new Date(generatedAt).getTime() + staleAfterHours * 3600_000).toISOString();

  const packet = {
    packet_id: packetId,
    lead_id: lead,
    job_id: jobId,
    contract_version: PACKET_CONTRACT_VERSION,
    identity: {
      company_name: (report.prospect && report.prospect.company_name) || view.name || null,
      lead_domain: (report.prospect && report.prospect.domain) || view.domain || null,
      phone: view.phone === undefined ? null : view.phone,
      city: (report.prospect && report.prospect.location) || view.city || null,
      country: view.country === undefined ? null : view.country,
    },
    requested_domain: (report.prospect && report.prospect.domain) || view.domain || 'unknown',
    audited_domain: (report.prospect && report.prospect.domain) || view.domain || null,
    redirect_chain: [],
    research_status: outcome,
    captured_at: generatedAt,
    provider: { id: providerId, name: 'Opportunity Intelligence', provider_job_id: jobId },
    source_contract_version: OI_SOURCE_CONTRACT_VERSION,
    engine_version: engineVersion,
    completeness: {
      level: outcome === 'failed' ? 'none' : (researchStatus === 'complete' ? 'complete' : 'partial'),
      areas,
    },
    facts,
    findings,
    strengths,
    not_measured: notMeasured,
    limitations,
    provenance: {
      provider: providerId,
      provider_job_id: jobId,
      captured_at: generatedAt,
      engine_version: engineVersion,
      contract_version: OI_SOURCE_CONTRACT_VERSION,
      packet_contract_version: PACKET_CONTRACT_VERSION,
      lead_id: lead,
      job_id: jobId,
    },
    freshness: { captured_at: generatedAt, expires_at: expiresAt, max_age_days: Math.ceil(staleAfterHours / 24) },
    source_references: buildSourceReferences(report, evidenceByOiId),
    digital_footprint: {
      state: footprintState(researchStatus, areas),
      scope: 'opportunity-intelligence',
      reasons: footprintReasons(areas, researchStatus),
      fact_ids: facts.map((f) => f.fact_id),
    },
    created_at: now.toISOString(),
  };

  const validation = validateEvidencePacket(packet);

  return {
    ok: validation.valid,
    packet,
    packet_errors: validation.errors,
    // The OI claim kind survives, per generated id, next to the weaker basis.
    claim_kinds: Object.freeze({ ...claimKinds }),
    oi: Object.freeze({
      research_id: String(report.research_id),
      snapshot_id: String(report.snapshot_id),
      previous_snapshot_id: report.previous_snapshot_id ? String(report.previous_snapshot_id) : null,
      entity_key: String((report.prospect || {}).entity_key),
      schema_version: String(report.schema_version),
      status: String(report.status),
      generated_at: generatedAt,
      provider_status: Object.freeze(flatProviderStatus(report).map((p) => Object.freeze(p))),
      source_contract_version: OI_SOURCE_CONTRACT_VERSION,
      bridge_contract: 'ztech.oi-pitch-bridge/1',
    }),
    oi_ids: Object.freeze({ ...oiIds }),
    counts: {
      facts: facts.length,
      findings: findings.length,
      strengths: strengths.length,
      limitations: limitations.length,
      pitch_eligible_findings: findings.filter((f) => isPitchEligible(claimKinds[f.finding_id])).length,
      inference_findings: findings.filter((f) => normKind(claimKinds[f.finding_id]) === 'inference').length,
    },
    excluded,
  };
}

// --- helpers -----------------------------------------------------------------

/** OI's own source contract string, preserved. */
const OI_SOURCE_CONTRACT_VERSION = 'opportunity-intelligence/1.0';

/**
 * OI's research_id as a ZTech job id. Derived, not invented: a caller can always
 * get back from the packet to the exact OI report it came from.
 */
function oiJobId(report) {
  const rid = String(report.research_id || 'unknown');
  return `oi_${rid}`.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128);
}

function normKind(k) {
  const s = k == null ? null : String(k);
  return s === 'fact' || s === 'estimate' || s === 'inference' ? s : null;
}

/**
 * The claim kind of a set of evidence references, strongest first.
 *
 * Used where OI itself does not state a claim kind (Comparison, SalesAngle).
 * It returns the kind of the strongest evidence cited, so a conclusion is never
 * typed more strongly than what it is built on. Returns null when nothing
 * resolves, which callers treat as "do not bridge".
 */
function strongestKindAmong(report, refs) {
  const byId = new Map((report.evidence || []).map((e) => [String(e.evidence_id), normKind(e.claim_kind)]));
  const kinds = refs.map((r) => byId.get(String(r))).filter(Boolean);
  if (!kinds.length) return null;
  if (kinds.includes('fact')) return 'fact';
  if (kinds.includes('estimate')) return 'estimate';
  return 'inference';
}

function areaFor(e) {
  const t = String(e.observation_type || e.source_type || '').toLowerCase();
  if (t.startsWith('content')) return 'content';
  if (t.startsWith('ads')) return 'visibility';
  if (t.startsWith('website')) return 'identity';
  if (t.startsWith('social')) return 'visibility';
  return 'other';
}

function describeClaim(e, kind) {
  const base = String(e.claim);
  const bits = [];
  if (e.metric && e.value !== undefined && e.value !== null) bits.push(`measured ${e.value}${e.unit ? ` ${e.unit}` : ''}`);
  if (kind === 'estimate') bits.push('this is an OI estimate, not a direct observation');
  if (e.freshness && e.freshness !== 'fresh') bits.push(`freshness ${e.freshness}`);
  return bits.length ? `${base} (${bits.join('; ')})` : base;
}

function channelStatusMap(report) {
  const out = { content: false, visibility: false, social: false };
  const bucket = (obj) => {
    for (const entity of Object.values(obj || {})) {
      for (const c of Array.isArray(entity) ? entity : []) {
        if (c && (c.status === 'success' || c.status === 'partial')) return true;
      }
    }
    return false;
  };
  out.content = bucket(report.content_intelligence);
  out.social = bucket(report.social_intelligence);
  out.visibility = bucket(report.advertising_intelligence) || out.social;
  return out;
}

function channelOk(map, key) { return Boolean(map[key]); }

function flatProviderStatus(report) {
  const out = [];
  for (const entityKey of Object.keys(report.provider_status || {}).sort()) {
    const providers = report.provider_status[entityKey] || {};
    for (const provider of Object.keys(providers).sort()) {
      out.push({ entity_key: entityKey, provider, status: providers[provider] });
    }
  }
  return out;
}

function buildSourceReferences(report, evidenceByOiId) {
  const refs = [];
  const seen = new Set();
  for (const e of report.evidence || []) {
    const url = e.source_url ? String(e.source_url) : null;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const fid = evidenceByOiId.get(String(e.evidence_id));
    if (!fid) continue;
    refs.push({ ref_id: fid, url: url.slice(0, 2048), kind: 'opportunity-intelligence' });
    if (refs.length >= 500) break;
  }
  return refs;
}

function footprintState(researchStatus, areas) {
  if (researchStatus === 'failed') return 'RESEARCH_FAILED';
  const measured = Object.values(areas).filter((v) => v === 'measured').length;
  if (measured === 0) return 'NOT_CHECKED';
  if (researchStatus === 'partial') return 'RESEARCH_PARTIAL';
  return 'DIGITAL_FOOTPRINT_FOUND';
}

function footprintReasons(areas, researchStatus) {
  const out = [];
  if (researchStatus === 'failed') out.push('Opportunity Intelligence reported no usable research for this prospect.');
  const missing = Object.entries(areas).filter(([, v]) => v !== 'measured').map(([k]) => k);
  if (missing.length) out.push(`Not measured by Opportunity Intelligence: ${missing.join(', ')}.`);
  return out.slice(0, 10);
}

function boundedValue(v) {
  if (v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  const s = String(v);
  return s.length > 5000 ? s.slice(0, 5000) : s;
}

function slug(s) {
  const out = String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return out || 'item';
}

function fmt(v) {
  if (v === null || v === undefined) return 'not observed';
  if (typeof v === 'number') return String(Math.round(v * 100) / 100);
  return String(v);
}

function truncate(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) : t;
}

module.exports = {
  buildPitchEvidenceBridge,
  CLAIM_KIND_TO_BASIS,
  isPitchEligible,
  basisFor,
  BOUNDS,
  SEVERITY_ORDER,
  OI_SOURCE_CONTRACT_VERSION,
  BASES,
  indexPacket,
};