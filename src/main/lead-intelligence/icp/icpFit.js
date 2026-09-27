'use strict';

const { S, assertValid } = require('../core/validate');
const { FIT, FOOTPRINT } = require('../contracts/constants');
const { pick } = require('../core/objects');

/**
 * Deterministic, explainable ICP / Target Fit.
 *
 * No score, no probability, no ranking. Each criterion is matched, unmet or unknown,
 * with the actual value and where it came from (lead record or evidence fact/finding).
 *
 * Sources: lead record, research evidence (fact:/finding:), or — for an EMPTY lead field
 * only — a fresh, non-conflicting enriched value (source "enrichment", with provenance_ids).
 *
 * Decision rule (in this order):
 *   1. any exclusion matched                     -> not_fit
 *   2. any required criterion unmet              -> not_fit
 *   3. any required criterion unknown            -> unknown   (unknown is NOT not_fit)
 *   4. otherwise                                 -> fit
 * Unknown exclusions are reported in unknownCriteria but never exclude a lead.
 * Optional criteria (required: false) are reported but do not decide the status.
 */

const LEAD_FIELDS = ['name', 'city', 'country', 'industry', 'business_type', 'qualification_status', 'data_quality'];
const LEAD_BOOL_FIELDS = ['has_website', 'has_phone', 'has_email'];
const RESEARCH_FIELDS = ['digital_footprint', 'research_status'];
// `location` = the lead's city OR country (ZTech targets store one combined `locations` list).
const MULTI_FIELDS = ['location'];
const FIELD_PATTERN = new RegExp(`^(?:${[...LEAD_FIELDS, ...LEAD_BOOL_FIELDS, ...RESEARCH_FIELDS, ...MULTI_FIELDS].join('|')}|fact:[A-Za-z0-9_.:-]{1,190}|finding:[A-Za-z0-9_.:-]{1,190})$`);
const OPS = ['eq', 'neq', 'in', 'not_in', 'contains', 'exists', 'not_exists', 'gte', 'lte'];

const valueSchema = {
  anyOf: [
    { type: 'string', maxLength: 200 },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', maxItems: 100, items: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'number' }, { type: 'boolean' }] } },
  ],
};

const CRITERION_SCHEMA = {
  type: 'object',
  required: ['id', 'label', 'field', 'op'],
  properties: {
    id: S.id,
    label: { type: 'string', minLength: 1, maxLength: 200 },
    field: { type: 'string', maxLength: 200, pattern: FIELD_PATTERN },
    op: { type: 'string', enum: OPS },
    value: valueSchema,
    required: { type: 'boolean' },
  },
  additionalProperties: false,
};

const ICP_SCHEMA = {
  type: 'object',
  required: ['icp_id', 'name', 'criteria'],
  properties: {
    icp_id: S.id,
    name: { type: 'string', minLength: 1, maxLength: 200 },
    criteria: { type: 'array', maxItems: 50, items: CRITERION_SCHEMA },
    exclusions: { type: 'array', maxItems: 50, items: CRITERION_SCHEMA },
    // Target settings that could not be converted into criteria (reported, never guessed).
    unmapped: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 200 } },
  },
  additionalProperties: false,
};

function assertIcp(icp) {
  assertValid(ICP_SCHEMA, icp, 'ICP definition');
  for (const c of [...icp.criteria, ...(icp.exclusions || [])]) {
    const needsArray = c.op === 'in' || c.op === 'not_in';
    const needsNothing = c.op === 'exists' || c.op === 'not_exists';
    if (needsArray && !Array.isArray(c.value)) throw new TypeError(`criterion ${c.id}: ${c.op} needs an array value`);
    if (!needsArray && !needsNothing && (c.value === undefined || Array.isArray(c.value))) throw new TypeError(`criterion ${c.id}: ${c.op} needs a single value`);
    if ((c.op === 'gte' || c.op === 'lte') && typeof c.value !== 'number') throw new TypeError(`criterion ${c.id}: ${c.op} needs a number`);
  }
  return icp;
}

const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);

/**
 * Resolve a field to {known, value, source, fact_ids, finding_ids}.
 * ctx: { view, packet, researchState, footprintState }
 */
function resolveField(field, ctx) {
  const { view, packet } = ctx;
  if (LEAD_BOOL_FIELDS.includes(field)) return { known: true, value: Boolean(view[field]), source: 'lead', fact_ids: [], finding_ids: [] };
  if (LEAD_FIELDS.includes(field)) {
    const v = view[field];
    if (v !== null && v !== undefined && v !== '') return { known: true, value: v, source: 'lead', fact_ids: [], finding_ids: [] };
    // Round 1: an empty lead field may be filled by a fresh, non-conflicting enriched value.
    // The Lead Library value always wins; enrichment never overwrites it.
    const e = ctx.enriched && ctx.enriched[field];
    if (e) {
      return { known: true, value: e.value, source: 'enrichment', fact_ids: [], finding_ids: [], provenance_ids: [e.provenance_id], enrichment_provider: e.provider_id };
    }
    return { known: false, value: null, source: 'lead', fact_ids: [], finding_ids: [] };
  }
  if (field === 'location') {
    const vals = [];
    const ids = [];
    for (const f of ['city', 'country']) {
      const r = resolveField(f, ctx);
      if (r.known) {
        vals.push(r.value);
        ids.push(...(r.provenance_ids || []));
      }
    }
    if (!vals.length) return { known: false, value: null, source: 'lead', fact_ids: [], finding_ids: [], reason: 'no city or country recorded' };
    return { known: true, value: vals, multi: true, source: ids.length ? 'enrichment' : 'lead', fact_ids: [], finding_ids: [], provenance_ids: ids };
  }
  if (field === 'research_status') {
    return { known: true, value: ctx.researchState || 'not_researched', source: 'research', fact_ids: [], finding_ids: [] };
  }
  if (field === 'digital_footprint') {
    const st = ctx.footprintState || FOOTPRINT.NOT_CHECKED;
    const known = ![FOOTPRINT.NOT_CHECKED, FOOTPRINT.RESEARCH_FAILED].includes(st);
    const ids = packet && packet.digital_footprint ? packet.digital_footprint.fact_ids : [];
    return { known, value: st, source: 'research', fact_ids: ids, finding_ids: [] };
  }
  if (field.startsWith('fact:')) {
    const key = field.slice(5);
    if (!packet) return { known: false, value: null, source: 'evidence', fact_ids: [], finding_ids: [], reason: 'not researched' };
    const f = packet.facts.find((x) => x.key === key);
    if (!f || f.value === null) return { known: false, value: null, source: 'evidence', fact_ids: [], finding_ids: [], reason: 'fact not in evidence' };
    return { known: true, value: f.value, source: 'evidence', fact_ids: [f.fact_id], finding_ids: [] };
  }
  if (field.startsWith('finding:')) {
    const rule = field.slice(8);
    if (!packet) return { known: false, value: null, source: 'evidence', fact_ids: [], finding_ids: [], reason: 'not researched' };
    const hits = packet.findings.filter((g) => g.rule_id === rule);
    if (hits.length) return { known: true, value: true, source: 'evidence', fact_ids: [], finding_ids: hits.map((h) => h.finding_id) };
    // Absence only counts as "known false" when the research was complete in every area.
    if (packet.research_status === 'complete' && packet.completeness.level === 'complete') {
      return { known: true, value: false, source: 'evidence', fact_ids: [], finding_ids: [] };
    }
    return { known: false, value: null, source: 'evidence', fact_ids: [], finding_ids: [], reason: 'research incomplete' };
  }
  return { known: false, value: null, source: 'unknown', fact_ids: [], finding_ids: [] };
}

function test(op, actual, expected) {
  if (Array.isArray(actual)) {
    // Multi-valued field (location): positive ops pass if ANY value passes,
    // negative ops pass only if EVERY value passes.
    const negative = op === 'neq' || op === 'not_in' || op === 'not_exists';
    return negative ? actual.every((v) => test(op, v, expected)) : actual.some((v) => test(op, v, expected));
  }
  const a = norm(actual);
  switch (op) {
    case 'eq': return a === norm(expected);
    case 'neq': return a !== norm(expected);
    case 'in': return expected.map(norm).includes(a);
    case 'not_in': return !expected.map(norm).includes(a);
    case 'contains': return typeof a === 'string' && typeof expected === 'string' && a.includes(norm(expected));
    case 'exists': return actual !== null && actual !== undefined && actual !== '' && actual !== false;
    case 'not_exists': return actual === null || actual === undefined || actual === '' || actual === false;
    case 'gte': return typeof actual === 'number' && actual >= expected;
    case 'lte': return typeof actual === 'number' && actual <= expected;
    default: return false;
  }
}

function describe(c, actual) {
  const show = (v) => (Array.isArray(v) ? `[${v.join(', ')}]` : v === null || v === undefined ? 'not recorded' : JSON.stringify(v));
  const ops = { eq: 'equal', neq: 'not equal', in: 'be one of', not_in: 'not be one of', contains: 'contain', gte: 'be at least', lte: 'be at most' };
  if (c.op === 'exists') return `${c.field} must be present; actual: ${show(actual)}`;
  if (c.op === 'not_exists') return `${c.field} must be absent; actual: ${show(actual)}`;
  return `${c.field} must ${ops[c.op]} ${show(c.value)}; actual: ${show(actual)}`;
}

function evaluateCriterion(c, ctx) {
  const r = resolveField(c.field, ctx);
  if (r.multi && (c.op === 'gte' || c.op === 'lte')) return { outcome: 'unknown', entry: { criterion_id: c.id, label: c.label, field: c.field, op: c.op, expected: c.value ?? null, actual: r.value, source: r.source, fact_ids: [], finding_ids: [], provenance_ids: [], required: c.required !== false, explanation: `${c.op} is not defined for ${c.field}.` } };
  const entry = {
    criterion_id: c.id,
    label: c.label,
    field: c.field,
    op: c.op,
    expected: c.value === undefined ? null : c.value,
    actual: r.value,
    source: r.source,
    fact_ids: r.fact_ids,
    finding_ids: r.finding_ids,
    provenance_ids: r.provenance_ids || [],
    required: c.required !== false,
  };
  if (r.enrichment_provider) entry.enrichment_provider = r.enrichment_provider;
  const isExistOp = c.op === 'exists' || c.op === 'not_exists';
  const knownForOp = r.known || (isExistOp && r.source === 'lead');
  if (!knownForOp) {
    return { outcome: 'unknown', entry: { ...entry, explanation: `${c.field} is unknown${r.reason ? ` (${r.reason})` : ''}; cannot evaluate "${c.label}".` } };
  }
  const ok = test(c.op, r.value, c.value);
  return { outcome: ok ? 'matched' : 'unmet', entry: { ...entry, explanation: describe(c, r.value) } };
}

/**
 * @param {{view: object, icp: object, packet?: object|null, researchState?: string, footprintState?: string, now?: Date}} input
 */
function evaluateIcpFit({ view, icp, packet = null, researchState, footprintState, enriched = null, now = new Date() }) {
  assertIcp(icp);
  const ctx = { view, packet, researchState, footprintState, enriched };
  const matchedCriteria = [];
  const unmetCriteria = [];
  const unknownCriteria = [];
  const exclusions = [];

  for (const c of icp.criteria) {
    const { outcome, entry } = evaluateCriterion(c, ctx);
    if (outcome === 'matched') matchedCriteria.push(entry);
    else if (outcome === 'unmet') unmetCriteria.push(entry);
    else unknownCriteria.push(entry);
  }
  for (const x of icp.exclusions || []) {
    const { outcome, entry } = evaluateCriterion(x, ctx);
    if (outcome === 'matched') exclusions.push({ ...entry, explanation: `Excluded: ${entry.explanation}` });
    else if (outcome === 'unknown') unknownCriteria.push({ ...entry, exclusion: true });
  }

  let fitStatus;
  let reason;
  if (exclusions.length) {
    fitStatus = FIT.NOT_FIT;
    reason = `${exclusions.length} exclusion rule(s) matched.`;
  } else if (unmetCriteria.some((c) => c.required)) {
    fitStatus = FIT.NOT_FIT;
    reason = `${unmetCriteria.filter((c) => c.required).length} required criterion/criteria not met.`;
  } else if (unknownCriteria.some((c) => c.required && !c.exclusion)) {
    fitStatus = FIT.UNKNOWN;
    reason = `${unknownCriteria.filter((c) => c.required && !c.exclusion).length} required criterion/criteria could not be evaluated with the available data.`;
  } else {
    fitStatus = FIT.FIT;
    reason = 'All required criteria are met and no exclusion matched.';
  }

  return {
    icp_id: icp.icp_id,
    lead_id: view.id,
    packet_id: packet ? packet.packet_id : null,
    fitStatus,
    reason,
    matchedCriteria,
    unmetCriteria,
    unknownCriteria,
    exclusions,
    evaluatedAt: now.toISOString(),
  };
}

/**
 * Convert a ZTech Target (Target Builder) into an ICP definition.
 *
 * VERIFIED column names of ZTech `targets` (Step 0, 2026-09-27): id, name, industry,
 * businessTypes, locations, requiredFields, optionalFields, exclusions, status.
 * Value SHAPES were not verified, so each list accepts a JS array, a JSON-encoded array
 * or a comma-separated string. Anything that cannot be converted without guessing is
 * listed in `icp.unmapped` (e.g. `exclusions`, whose meaning is UNKNOWN).
 * If the target already carries `icp` in this module's schema, it is used as is.
 */
const TARGET_FIELD_PATHS = Object.freeze({
  id: ['id', 'target_id', 'targetId'],
  name: ['name', 'title'],
  industries: ['industry', 'industries', 'categories'],
  businessTypes: ['businessTypes', 'business_types'],
  locations: ['locations', 'location'],
  cities: ['cities'],
  countries: ['countries'],
  requiredFields: ['requiredFields', 'required_fields'],
  exclusions: ['exclusions'],
});

/** requiredFields value -> ICP criterion (only fields ZTech leads actually have). */
const REQUIRED_FIELD_CRITERIA = Object.freeze({
  website: { field: 'has_website', label: 'Has a website' },
  email: { field: 'has_email', label: 'Has an email address' },
  phone: { field: 'has_phone', label: 'Has a phone number' },
  address: { field: 'address', label: 'Has an address', op: 'exists' },
  title: { field: 'name', label: 'Has a business name', op: 'exists' },
  name: { field: 'name', label: 'Has a business name', op: 'exists' },
});

function toList(v) {
  if (v === undefined || v === null || v === '') return [];
  let x = v;
  if (typeof x === 'string') {
    const s = x.trim();
    if (s.startsWith('[')) {
      try { x = JSON.parse(s); } catch { return []; }
    } else {
      x = s.split(',');
    }
  }
  if (!Array.isArray(x)) return [];
  return [...new Set(x.filter((i) => typeof i === 'string' && i.trim()).map((i) => i.trim().slice(0, 200)))].slice(0, 100);
}

function targetToIcp(target, paths = TARGET_FIELD_PATHS) {
  if (!target) return null;
  if (target.icp && typeof target.icp === 'object') return assertIcp(target.icp);
  const p = { ...TARGET_FIELD_PATHS, ...(paths || {}) };
  const get = (k) => pick(target, (p[k] || []).filter((x) => typeof x === 'string'));
  const id = String(get('id') ?? 'target').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 100);
  const criteria = [];
  const unmapped = [];
  const industries = toList(get('industries'));
  const types = toList(get('businessTypes'));
  const locations = toList(get('locations'));
  const cities = toList(get('cities'));
  const countries = toList(get('countries'));
  if (industries.length) criteria.push({ id: 'industry', label: 'Industry matches target', field: 'industry', op: 'in', value: industries });
  if (types.length) criteria.push({ id: 'business_type', label: 'Business type matches target', field: 'business_type', op: 'in', value: types });
  if (locations.length) criteria.push({ id: 'location', label: 'Location matches target', field: 'location', op: 'in', value: locations });
  if (cities.length) criteria.push({ id: 'city', label: 'City matches target', field: 'city', op: 'in', value: cities });
  if (countries.length) criteria.push({ id: 'country', label: 'Country matches target', field: 'country', op: 'in', value: countries });
  for (const f of toList(get('requiredFields'))) {
    const m = REQUIRED_FIELD_CRITERIA[f.toLowerCase()];
    if (!m) { unmapped.push(`requiredFields:${f}`); continue; }
    const cid = `required_${f.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    if (criteria.some((c) => c.id === cid)) continue;
    criteria.push(m.op === 'exists'
      ? { id: cid, label: m.label, field: m.field, op: 'exists' }
      : { id: cid, label: m.label, field: m.field, op: 'eq', value: true });
  }
  const ex = get('exclusions');
  if (ex !== undefined && ex !== null && toList(ex).length) unmapped.push('exclusions');
  const icp = { icp_id: `target_${id}`, name: String(get('name') || 'Target').slice(0, 200), criteria, exclusions: [] };
  if (unmapped.length) icp.unmapped = unmapped;
  return assertIcp(icp);
}

module.exports = { ICP_SCHEMA, CRITERION_SCHEMA, OPS, assertIcp, evaluateIcpFit, resolveField, targetToIcp, TARGET_FIELD_PATHS };
