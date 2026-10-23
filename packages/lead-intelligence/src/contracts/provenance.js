'use strict';

const { S } = require('../core/validate');
const { ValidationError } = require('../core/errors');

/**
 * One provenance shape used everywhere in ZTech (facts, findings, strengths,
 * changes, signals, agent statements, pitch references, exports).
 */
const PROVENANCE_SCHEMA = {
  type: 'object',
  required: ['provider', 'captured_at', 'engine_version', 'contract_version', 'lead_id', 'packet_id'],
  properties: {
    provider: S.text(100),
    source_url: S.nullableText(2048),
    captured_at: S.isoDate,
    engine_version: S.text(100),
    contract_version: S.text(100),
    fact_id: S.nullableText(128),
    finding_id: S.nullableText(128),
    lead_id: S.text(128),
    packet_id: S.text(128),
  },
  additionalProperties: false,
};

function makeProvenance(p) {
  const out = {
    provider: p.provider,
    source_url: p.source_url == null ? null : String(p.source_url),
    captured_at: p.captured_at,
    engine_version: p.engine_version,
    contract_version: p.contract_version,
    fact_id: p.fact_id == null ? null : p.fact_id,
    finding_id: p.finding_id == null ? null : p.finding_id,
    lead_id: String(p.lead_id),
    packet_id: p.packet_id,
  };
  for (const k of ['provider', 'captured_at', 'engine_version', 'contract_version', 'lead_id', 'packet_id']) {
    if (!out[k]) throw new ValidationError('provenance is incomplete', [{ path: `$.${k}`, message: 'is required' }]);
  }
  return out;
}

/**
 * Look up the provenance of a fact or finding id inside a packet.
 * Returns null when the id is not part of the packet.
 */
function provenanceFor(packet, refId) {
  if (!packet || !refId) return null;
  const f = packet.facts.find((x) => x.fact_id === refId);
  if (f) return f.provenance;
  const g = packet.findings.find((x) => x.finding_id === refId);
  if (g) return g.provenance;
  const s = packet.strengths.find((x) => x.strength_id === refId);
  if (s) return s.provenance;
  return null;
}

/** Provenance entries for a list of refs, in order, dropping unknown ids. */
function provenanceList(packet, refIds) {
  const out = [];
  for (const id of refIds || []) {
    const p = provenanceFor(packet, id);
    if (p) out.push({ ref_id: id, ...p });
  }
  return out;
}

module.exports = { PROVENANCE_SCHEMA, makeProvenance, provenanceFor, provenanceList };
