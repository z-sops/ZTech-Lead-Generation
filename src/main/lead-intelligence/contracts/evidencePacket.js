'use strict';

const { S, validate } = require('../core/validate');
const { newId, stableId } = require('../core/ids');
const {
  PACKET_CONTRACT_VERSION, AREAS, AREA_STATUS, PACKET_OUTCOMES, COMPLETENESS_LEVELS,
  SEVERITIES, BASES, FOOTPRINT_STATES,
} = require('./constants');
const { PROVENANCE_SCHEMA, makeProvenance } = require('./provenance');
const { computeDigitalFootprint } = require('../research/digitalFootprint');

/**
 * EvidencePacket — the canonical ZTech research record.
 * The Lead Agent, pitch generator, gate, profile and export only ever read this.
 * Raw MCP/REST/file output never leaves the provider layer.
 */

const refList = { type: 'array', maxItems: 100, items: S.id };
const scalar = {
  anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};

const FACT_SCHEMA = {
  type: 'object',
  required: ['fact_id', 'key', 'area', 'label', 'value', 'untrusted', 'source_url', 'provenance'],
  properties: {
    fact_id: S.id,
    key: { type: 'string', minLength: 1, maxLength: 200, pattern: /^[A-Za-z0-9_.:-]+$/ },
    area: { type: 'string', enum: AREAS },
    label: S.text(300),
    value: scalar,
    untrusted: { type: 'boolean' },
    source_url: S.nullableText(2048),
    provenance: PROVENANCE_SCHEMA,
  },
  additionalProperties: false,
};

const FINDING_SCHEMA = {
  type: 'object',
  required: ['finding_id', 'rule_id', 'area', 'title', 'severity', 'basis', 'observed', 'recommendation', 'urls', 'fact_ids', 'provenance'],
  properties: {
    finding_id: S.id,
    rule_id: { type: 'string', minLength: 1, maxLength: 200 },
    area: { type: 'string', enum: AREAS },
    title: { type: 'string', minLength: 1, maxLength: 300 },
    severity: { type: 'string', enum: SEVERITIES },
    basis: { type: 'string', enum: BASES },
    observed: S.text(4000),
    recommendation: S.text(4000),
    urls: S.stringList(50, 2048),
    fact_ids: refList,
    provenance: PROVENANCE_SCHEMA,
  },
  additionalProperties: false,
};

const STRENGTH_SCHEMA = {
  type: 'object',
  required: ['strength_id', 'area', 'statement', 'fact_ids', 'finding_ids', 'provenance'],
  properties: {
    strength_id: S.id,
    area: { type: 'string', enum: AREAS },
    statement: { type: 'string', minLength: 1, maxLength: 1000 },
    fact_ids: refList,
    finding_ids: refList,
    provenance: PROVENANCE_SCHEMA,
  },
  additionalProperties: false,
};

const PACKET_SCHEMA = {
  type: 'object',
  required: [
    'packet_id', 'lead_id', 'job_id', 'contract_version', 'identity', 'requested_domain', 'audited_domain',
    'redirect_chain', 'research_status', 'captured_at', 'provider', 'source_contract_version', 'engine_version',
    'completeness', 'facts', 'findings', 'strengths', 'not_measured', 'limitations', 'provenance', 'freshness',
    'source_references', 'digital_footprint', 'created_at',
  ],
  properties: {
    packet_id: S.id,
    lead_id: S.text(128),
    job_id: S.id,
    contract_version: { type: 'string', enum: [PACKET_CONTRACT_VERSION] },
    identity: {
      type: 'object',
      required: ['company_name', 'lead_domain', 'phone', 'city', 'country'],
      properties: {
        company_name: S.nullableText(300),
        lead_domain: S.nullableText(2048),
        phone: S.nullableText(50),
        city: S.nullableText(120),
        country: S.nullableText(120),
      },
      additionalProperties: false,
    },
    requested_domain: S.text(253),
    audited_domain: S.nullableText(253),
    redirect_chain: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['url', 'status'],
        properties: { url: S.text(2048), status: { type: 'integer', nullable: true, minimum: 0, maximum: 999 } },
        additionalProperties: false,
      },
    },
    research_status: { type: 'string', enum: PACKET_OUTCOMES },
    captured_at: S.isoDate,
    provider: {
      type: 'object',
      required: ['id', 'name', 'provider_job_id'],
      properties: { id: S.text(100), name: S.text(200), provider_job_id: S.text(200) },
      additionalProperties: false,
    },
    source_contract_version: S.text(100),
    engine_version: S.text(100),
    completeness: {
      type: 'object',
      required: ['level', 'areas'],
      properties: {
        level: { type: 'string', enum: COMPLETENESS_LEVELS },
        areas: {
          type: 'object',
          properties: Object.fromEntries(AREAS.map((a) => [a, { type: 'string', enum: AREA_STATUS }])),
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    facts: { type: 'array', maxItems: 2000, items: FACT_SCHEMA },
    findings: { type: 'array', maxItems: 1000, items: FINDING_SCHEMA },
    strengths: { type: 'array', maxItems: 200, items: STRENGTH_SCHEMA },
    not_measured: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        required: ['area', 'reason'],
        properties: { area: { type: 'string', enum: AREAS }, reason: S.text(1000) },
        additionalProperties: false,
      },
    },
    limitations: {
      type: 'array',
      maxItems: 150,
      items: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: S.text(100), message: S.text(1000) },
        additionalProperties: false,
      },
    },
    provenance: {
      type: 'object',
      required: ['provider', 'provider_job_id', 'captured_at', 'engine_version', 'contract_version', 'packet_contract_version', 'lead_id', 'job_id'],
      properties: {
        provider: S.text(100),
        provider_job_id: S.text(200),
        captured_at: S.isoDate,
        engine_version: S.text(100),
        contract_version: S.text(100),
        packet_contract_version: S.text(100),
        lead_id: S.text(128),
        job_id: S.id,
      },
      additionalProperties: false,
    },
    freshness: {
      type: 'object',
      required: ['captured_at', 'expires_at', 'max_age_days'],
      properties: { captured_at: S.isoDate, expires_at: S.isoDate, max_age_days: { type: 'integer', minimum: 0 } },
      additionalProperties: false,
    },
    source_references: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['ref_id', 'url', 'kind'],
        properties: { ref_id: S.id, url: S.text(2048), kind: S.text(50) },
        additionalProperties: false,
      },
    },
    digital_footprint: {
      type: 'object',
      required: ['state', 'scope', 'reasons', 'fact_ids'],
      properties: {
        state: { type: 'string', enum: FOOTPRINT_STATES },
        scope: S.text(500),
        reasons: S.stringList(10, 500),
        fact_ids: refList,
      },
      additionalProperties: false,
    },
    created_at: S.isoDate,
  },
  additionalProperties: false,
};

/**
 * Build a packet from a validated ProviderResult.
 * Every fact/finding/strength receives its own provenance.
 * Strengths or findings that reference unknown facts keep only the refs that resolve;
 * strengths with zero resolvable refs are dropped (untraceable claim) and recorded
 * as a limitation.
 */
function buildEvidencePacket({ leadId, jobId, identity, provider, result, freshness, now = new Date(), leadView = null, limitedPageThreshold }) {
  const packetId = newId('pkt');
  const lead = String(leadId);
  const base = {
    provider: provider.id,
    captured_at: result.capturedAt,
    engine_version: result.engineVersion,
    contract_version: result.contractVersion,
    lead_id: lead,
    packet_id: packetId,
  };
  const limitations = result.limitations.map((l) => ({ code: l.code, message: l.message }));

  const keyToIds = new Map();
  const facts = result.facts.map((f, i) => {
    const factId = stableId('fact', packetId, f.key, i);
    if (!keyToIds.has(f.key)) keyToIds.set(f.key, []);
    keyToIds.get(f.key).push(factId);
    return {
      fact_id: factId,
      key: f.key,
      area: f.area,
      label: f.label || f.key,
      value: f.value,
      untrusted: Boolean(f.untrusted),
      source_url: f.sourceUrl == null ? null : f.sourceUrl,
      provenance: makeProvenance({ ...base, source_url: f.sourceUrl, fact_id: factId }),
    };
  });

  const resolve = (keys, where) => {
    const ids = [];
    for (const k of keys || []) {
      const hit = keyToIds.get(k);
      if (hit) ids.push(...hit);
      else limitations.push({ code: 'UNRESOLVED_FACT_REFERENCE', message: `${where} referenced fact "${k}" that the provider did not return.` });
    }
    return [...new Set(ids)];
  };

  const ruleToIds = new Map();
  const findings = result.findings.map((g, i) => {
    const findingId = stableId('find', packetId, g.ruleId, i);
    if (!ruleToIds.has(g.ruleId)) ruleToIds.set(g.ruleId, []);
    ruleToIds.get(g.ruleId).push(findingId);
    return {
      finding_id: findingId,
      rule_id: g.ruleId,
      area: g.area,
      title: g.title,
      severity: g.severity,
      basis: g.basis,
      observed: g.observed,
      recommendation: g.recommendation || '',
      urls: (g.urls || []).slice(0, 50),
      fact_ids: resolve(g.factKeys, `Finding ${g.ruleId}`),
      provenance: makeProvenance({ ...base, source_url: (g.urls && g.urls[0]) || null, finding_id: findingId }),
    };
  });

  const strengths = [];
  result.strengths.forEach((s, i) => {
    const factIds = resolve(s.factKeys, 'A strength');
    const findingIds = [...new Set((s.ruleIds || []).flatMap((r) => ruleToIds.get(r) || []))];
    if (factIds.length === 0 && findingIds.length === 0) {
      limitations.push({ code: 'UNTRACEABLE_STRENGTH_DROPPED', message: 'A strength without any evidence reference was not included.' });
      return;
    }
    const strengthId = stableId('str', packetId, s.statement, i);
    strengths.push({
      strength_id: strengthId,
      area: s.area,
      statement: s.statement,
      fact_ids: factIds,
      finding_ids: findingIds,
      provenance: makeProvenance({ ...base, fact_id: factIds[0] || null, finding_id: findingIds[0] || null }),
    });
  });

  const areas = { ...result.areas };
  const areaValues = Object.values(areas);
  let researchStatus = result.outcome;
  if (researchStatus === 'complete' && areaValues.includes('failed')) researchStatus = 'partial';
  let level;
  if (researchStatus === 'failed') level = 'none';
  else if (researchStatus === 'complete' && areaValues.length > 0 && areaValues.every((v) => v === 'measured')) level = 'complete';
  else level = areaValues.includes('measured') || facts.length > 0 ? 'partial' : 'none';

  const packet = {
    packet_id: packetId,
    lead_id: lead,
    job_id: jobId,
    contract_version: PACKET_CONTRACT_VERSION,
    identity: {
      company_name: identity ? identity.company_name : null,
      lead_domain: identity ? identity.lead_domain : null,
      phone: identity ? identity.phone : null,
      city: identity ? identity.city : null,
      country: identity ? identity.country : null,
    },
    requested_domain: result.requestedDomain,
    audited_domain: result.auditedDomain,
    redirect_chain: result.redirectChain.map((r) => ({ url: r.url, status: r.status == null ? null : r.status })),
    research_status: researchStatus,
    captured_at: result.capturedAt,
    provider: { id: provider.id, name: provider.name, provider_job_id: result.providerJobId },
    source_contract_version: result.contractVersion,
    engine_version: result.engineVersion,
    completeness: { level, areas },
    facts,
    findings,
    strengths,
    not_measured: result.notMeasured.map((n) => ({ area: n.area, reason: n.reason })),
    limitations: limitations.slice(0, 150),
    provenance: {
      provider: provider.id,
      provider_job_id: result.providerJobId,
      captured_at: result.capturedAt,
      engine_version: result.engineVersion,
      contract_version: result.contractVersion,
      packet_contract_version: PACKET_CONTRACT_VERSION,
      lead_id: lead,
      job_id: jobId,
    },
    freshness: freshness.describe(result.capturedAt, researchStatus),
    source_references: result.sourceReferences.map((r, i) => ({
      ref_id: stableId('src', packetId, r.url, i),
      url: r.url,
      kind: r.kind,
    })),
    digital_footprint: null,
    created_at: now.toISOString(),
  };
  packet.digital_footprint = computeDigitalFootprint({ packet, leadView, limitedPageThreshold });
  return packet;
}

/** Schema + referential integrity + provenance consistency. */
function validateEvidencePacket(packet) {
  const errors = validate(PACKET_SCHEMA, packet);
  if (errors.length) return { valid: false, errors };

  const ids = new Set();
  const dup = (id, where) => {
    if (ids.has(id)) errors.push({ path: where, message: `duplicate id ${id}` });
    ids.add(id);
  };
  const factIds = new Set();
  const findingIds = new Set();
  packet.facts.forEach((f, i) => {
    dup(f.fact_id, `$.facts[${i}]`);
    factIds.add(f.fact_id);
    if (f.provenance.fact_id !== f.fact_id) errors.push({ path: `$.facts[${i}].provenance.fact_id`, message: 'does not match fact_id' });
    if (f.provenance.lead_id !== packet.lead_id) errors.push({ path: `$.facts[${i}].provenance.lead_id`, message: 'does not match packet lead_id' });
    if (f.provenance.packet_id !== packet.packet_id) errors.push({ path: `$.facts[${i}].provenance.packet_id`, message: 'does not match packet_id' });
  });
  packet.findings.forEach((g, i) => {
    dup(g.finding_id, `$.findings[${i}]`);
    findingIds.add(g.finding_id);
    if (g.provenance.finding_id !== g.finding_id) errors.push({ path: `$.findings[${i}].provenance.finding_id`, message: 'does not match finding_id' });
    if (g.provenance.lead_id !== packet.lead_id) errors.push({ path: `$.findings[${i}].provenance.lead_id`, message: 'does not match packet lead_id' });
    g.fact_ids.forEach((id) => {
      if (!factIds.has(id)) errors.push({ path: `$.findings[${i}].fact_ids`, message: `unknown fact ${id}` });
    });
  });
  packet.strengths.forEach((s, i) => {
    dup(s.strength_id, `$.strengths[${i}]`);
    if (s.fact_ids.length + s.finding_ids.length === 0) errors.push({ path: `$.strengths[${i}]`, message: 'has no evidence reference' });
    s.fact_ids.forEach((id) => {
      if (!factIds.has(id)) errors.push({ path: `$.strengths[${i}].fact_ids`, message: `unknown fact ${id}` });
    });
    s.finding_ids.forEach((id) => {
      if (!findingIds.has(id)) errors.push({ path: `$.strengths[${i}].finding_ids`, message: `unknown finding ${id}` });
    });
  });
  packet.digital_footprint.fact_ids.forEach((id) => {
    if (!factIds.has(id)) errors.push({ path: '$.digital_footprint.fact_ids', message: `unknown fact ${id}` });
  });
  if (packet.freshness.captured_at !== packet.captured_at) errors.push({ path: '$.freshness.captured_at', message: 'does not match captured_at' });
  if (packet.provenance.lead_id !== packet.lead_id) errors.push({ path: '$.provenance.lead_id', message: 'does not match lead_id' });
  if (packet.research_status === 'complete' && packet.completeness.level === 'none') {
    errors.push({ path: '$.completeness.level', message: 'cannot be none for a complete packet' });
  }
  return { valid: errors.length === 0, errors };
}

/** Fast lookup helpers used by the agent, pitch and gate. */
function indexPacket(packet) {
  const facts = new Map(packet.facts.map((f) => [f.fact_id, f]));
  const findings = new Map(packet.findings.map((f) => [f.finding_id, f]));
  const strengths = new Map(packet.strengths.map((s) => [s.strength_id, s]));
  return {
    facts,
    findings,
    strengths,
    hasRef: (id) => facts.has(id) || findings.has(id) || strengths.has(id),
    factByKey: (key) => packet.facts.find((f) => f.key === key) || null,
  };
}

/** Small summary used in lists, exports and the renderer. */
function summarizePacket(packet) {
  if (!packet) return null;
  return {
    packet_id: packet.packet_id,
    lead_id: packet.lead_id,
    research_status: packet.research_status,
    captured_at: packet.captured_at,
    expires_at: packet.freshness.expires_at,
    requested_domain: packet.requested_domain,
    audited_domain: packet.audited_domain,
    provider: packet.provider.id,
    engine_version: packet.engine_version,
    contract_version: packet.source_contract_version,
    completeness: packet.completeness,
    digital_footprint: packet.digital_footprint.state,
    counts: {
      facts: packet.facts.length,
      findings: packet.findings.length,
      strengths: packet.strengths.length,
      not_measured: packet.not_measured.length,
      limitations: packet.limitations.length,
    },
  };
}

module.exports = {
  PACKET_SCHEMA,
  FACT_SCHEMA,
  FINDING_SCHEMA,
  STRENGTH_SCHEMA,
  buildEvidencePacket,
  validateEvidencePacket,
  indexPacket,
  summarizePacket,
};
