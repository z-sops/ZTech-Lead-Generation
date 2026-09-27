'use strict';

const { scrubSecrets } = require('../core/objects');
const { ValidationError } = require('../core/errors');

/**
 * Research export. Extends — does not replace — ZTech's existing export.
 *
 * INTEGRATION POINT (QwenCoder): find the existing export code (Lead Library export).
 * - If it already writes CSV/JSON: append RESEARCH_COLUMNS to its column list and fill
 *   them from buildResearchRows(); keep its file dialog and file naming.
 * - If it supports other formats (e.g. XLSX), report which ones and map the same rows;
 *   do not add a new format library without approval.
 *
 * Guarantees:
 * - No secrets: every row passes scrubSecrets(); credential stores are never read here.
 * - Provenance kept: provider, engine/contract version, packet id and each finding id.
 * - CSV formula injection guarded (cells starting with = + - @ tab CR are prefixed).
 * - CSV and JSON carry exactly the same fields per lead (parity).
 */
const RESEARCH_COLUMNS = Object.freeze([
  'lead_id', 'name', 'email', 'phone', 'website', 'city', 'country', 'industry', 'business_type',
  'qualification_status', 'data_quality',
  'icp_fit_status', 'icp_unmet', 'icp_unknown', 'icp_exclusions',
  'research_state', 'research_captured_at', 'research_expires_at', 'research_fresh', 'research_completeness',
  'digital_footprint', 'audited_domain',
  'findings_count', 'findings', 'strengths',
  'pitch_status', 'pitch_subject', 'pitch_id',
  'provenance_provider', 'provenance_engine_version', 'provenance_contract_version', 'packet_id',
]);

function joinList(items) {
  return items.join(' | ');
}

/**
 * @param {{contexts: object[], packets: Map<string,object>, pitches: Map<string,object>, freshness: object, now: Date}} input
 */
function buildResearchRows({ contexts, packets, pitches, freshness, now = new Date() }) {
  return contexts.map((c) => {
    const v = c.view;
    const p = packets.get(v.id) || null;
    const pitch = pitches.get(v.id) || null;
    const fit = c.icp_fit;
    const row = {
      lead_id: v.id,
      name: v.name,
      email: v.email,
      phone: v.phone,
      website: v.website,
      city: v.city,
      country: v.country,
      industry: v.industry,
      business_type: v.business_type,
      qualification_status: v.qualification_status,
      data_quality: v.data_quality,
      icp_fit_status: fit ? fit.fitStatus : null,
      icp_unmet: fit ? joinList(fit.unmetCriteria.map((x) => x.label)) : null,
      icp_unknown: fit ? joinList(fit.unknownCriteria.map((x) => x.label)) : null,
      icp_exclusions: fit ? joinList(fit.exclusions.map((x) => x.label)) : null,
      research_state: c.research_state,
      research_captured_at: p ? p.captured_at : null,
      research_expires_at: p ? p.freshness.expires_at : null,
      research_fresh: p ? freshness.isFresh(p, now) : false,
      research_completeness: p ? p.completeness.level : null,
      digital_footprint: c.footprint_state,
      audited_domain: p ? p.audited_domain : null,
      findings_count: p ? p.findings.length : 0,
      findings: p ? joinList(p.findings.map((g) => `${g.severity}: ${g.title} [${g.finding_id}]`)) : null,
      strengths: p ? joinList(p.strengths.map((s) => `${s.statement} [${s.strength_id}]`)) : null,
      pitch_status: pitch ? pitch.status : null,
      pitch_subject: pitch ? pitch.subject : null,
      pitch_id: pitch ? pitch.pitch_id : null,
      provenance_provider: p ? p.provenance.provider : null,
      provenance_engine_version: p ? p.provenance.engine_version : null,
      provenance_contract_version: p ? p.provenance.contract_version : null,
      packet_id: p ? p.packet_id : null,
    };
    return scrubSecrets(row);
  });
}

/** Structured JSON export: same rows plus per-finding provenance. */
function buildResearchJson({ rows, packets }) {
  return scrubSecrets({
    export_version: 'ztech.research-export/1',
    columns: RESEARCH_COLUMNS,
    leads: rows.map((r) => {
      const p = packets.get(r.lead_id) || null;
      return {
        ...r,
        evidence: p ? {
          packet_id: p.packet_id,
          provenance: p.provenance,
          findings: p.findings.map((g) => ({ finding_id: g.finding_id, rule_id: g.rule_id, area: g.area, severity: g.severity, basis: g.basis, title: g.title, observed: g.observed, fact_ids: g.fact_ids, provenance: g.provenance })),
          not_measured: p.not_measured,
          limitations: p.limitations,
        } : null,
      };
    }),
  });
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsv(rows, columns = RESEARCH_COLUMNS) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvCell(r[c])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}

class ExportService {
  constructor({ contexts, store, segments, savedSearches, freshness, clock = () => new Date() }) {
    this.contexts = contexts;
    this.store = store;
    this.segments = segments;
    this.savedSearches = savedSearches;
    this.freshness = freshness;
    this.clock = clock;
  }

  async _leadIds(scope) {
    if (scope.leadIds) return new Set(scope.leadIds.map(String));
    if (scope.segmentId) return new Set(await this.segments.memberIds(scope.segmentId));
    if (scope.searchId) return new Set((await this.savedSearches.run({ searchId: scope.searchId })).rows.map((r) => r.lead_id));
    throw new ValidationError('export scope is required', [{ path: '$.scope', message: 'give leadIds, segmentId or searchId' }]);
  }

  /** @returns {Promise<{filename: string, mimeType: string, content: string, count: number}>} */
  async export({ scope, format, targetId }) {
    const ids = await this._leadIds(scope);
    const ctxs = (await this.contexts.listContexts({ targetId })).filter((c) => ids.has(c.view.id));
    const packets = new Map();
    const pitches = new Map();
    for (const c of ctxs) {
      const p = await this.store.packets.latestForLead(c.view.id);
      if (p) packets.set(c.view.id, p);
      const pitch = await this.store.pitches.latestForLead(c.view.id);
      if (pitch) pitches.set(c.view.id, pitch);
    }
    const now = this.clock();
    const rows = buildResearchRows({ contexts: ctxs, packets, pitches, freshness: this.freshness, now });
    const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    if (format === 'csv') return { filename: `ztech-research-${stamp}.csv`, mimeType: 'text/csv', content: toCsv(rows), count: rows.length };
    if (format === 'json') return { filename: `ztech-research-${stamp}.json`, mimeType: 'application/json', content: JSON.stringify(buildResearchJson({ rows, packets }), null, 2), count: rows.length };
    throw new ValidationError('unsupported export format', [{ path: '$.format', message: 'csv or json' }]);
  }
}

module.exports = { ExportService, RESEARCH_COLUMNS, buildResearchRows, buildResearchJson, toCsv, csvCell };
