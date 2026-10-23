'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateIcpFit, assertIcp, targetToIcp } = require('../../src/main/lead-intelligence/icp/icpFit');
const { toLeadView } = require('../../src/main/lead-intelligence/contracts/leadView');
const { build, researchToCompletion, sampleIcp } = require('./helpers');

const NOW = new Date('2026-09-01T10:00:00.000Z');
const v = (raw) => toLeadView({ id: 'X', ...raw });

test('icp: fit — every required criterion met, explained, no score', () => {
  const r = evaluateIcpFit({ view: v({ name: 'A', city: 'karachi', category: 'bakery', website: 'a.com' }), icp: sampleIcp(), now: NOW });
  assert.equal(r.fitStatus, 'fit');
  assert.equal(r.matchedCriteria.length, 3);
  assert.equal(r.unmetCriteria.length + r.exclusions.length, 0);
  // qualification is not recorded: the exclusion is reported as unknown but does not exclude
  assert.deepEqual(r.unknownCriteria.map((c) => [c.criterion_id, c.exclusion]), [['x_unqualified', true]]);
  assert.equal(r.evaluatedAt, NOW.toISOString());
  assert.ok(!('score' in r) && !('probability' in r));
  assert.match(r.matchedCriteria[1].explanation, /must be one of \[Bakery, Restaurant, Cafe\]; actual: "bakery"/);
});

test('icp: not_fit — required criterion unmet, with actual value', () => {
  const r = evaluateIcpFit({ view: v({ name: 'A', city: 'Lahore', category: 'Bakery', website: 'a.com' }), icp: sampleIcp(), now: NOW });
  assert.equal(r.fitStatus, 'not_fit');
  assert.equal(r.unmetCriteria[0].criterion_id, 'c_city');
  assert.equal(r.unmetCriteria[0].actual, 'Lahore');
  assert.equal(r.unmetCriteria[0].source, 'lead');
});

test('icp: unknown — missing data is unknown, NOT not_fit', () => {
  const r = evaluateIcpFit({ view: v({ name: 'A', website: 'a.com' }), icp: sampleIcp(), now: NOW });
  assert.equal(r.fitStatus, 'unknown');
  assert.deepEqual(r.unknownCriteria.map((c) => c.criterion_id).sort(), ['c_city', 'c_industry', 'x_unqualified']);
  assert.equal(r.unmetCriteria.length, 0);
  assert.match(r.unknownCriteria[0].explanation, /unknown/);
});

test('icp: exclusions win over matched criteria; unknown exclusions never exclude', () => {
  const excluded = evaluateIcpFit({ view: v({ city: 'Karachi', category: 'Bakery', website: 'a.com', qualification_status: 'unqualified' }), icp: sampleIcp(), now: NOW });
  assert.equal(excluded.fitStatus, 'not_fit');
  assert.equal(excluded.exclusions[0].criterion_id, 'x_unqualified');
  assert.match(excluded.exclusions[0].explanation, /^Excluded:/);
  const noQual = evaluateIcpFit({ view: v({ city: 'Karachi', category: 'Bakery', website: 'a.com' }), icp: sampleIcp(), now: NOW });
  assert.equal(noQual.fitStatus, 'fit');
  assert.ok(noQual.unknownCriteria.some((c) => c.exclusion));
});

test('icp: missing fields & evidence criteria stay unknown until research exists', async () => {
  const icp = { ...sampleIcp(), criteria: [...sampleIcp().criteria, { id: 'c_platform', label: 'Runs WordPress', field: 'fact:tech.platform', op: 'eq', value: 'WordPress' }, { id: 'c_no_schema', label: 'Missing org schema', field: 'finding:org_schema_missing', op: 'eq', value: true }] };
  const before = evaluateIcpFit({ view: v({ city: 'Karachi', category: 'Bakery', website: 'a.com' }), icp, packet: null, now: NOW });
  assert.equal(before.fitStatus, 'unknown');
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  const packet = await ctx.store.packets.latestForLead('L1');
  const after = evaluateIcpFit({ view: toLeadView(ctx.leads.L1), icp, packet, now: NOW });
  assert.equal(after.fitStatus, 'fit');
  const platform = after.matchedCriteria.find((c) => c.criterion_id === 'c_platform');
  assert.equal(platform.source, 'evidence');
  assert.equal(platform.fact_ids.length, 1);
  const schema = after.matchedCriteria.find((c) => c.criterion_id === 'c_no_schema');
  assert.equal(schema.finding_ids.length, 1);
});

test('icp: absent finding is unknown when research was not complete in every area', async () => {
  const icp = { icp_id: 'i', name: 'n', criteria: [{ id: 'c', label: 'Has security finding', field: 'finding:nonexistent_rule', op: 'eq', value: false }] };
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  const packet = await ctx.store.packets.latestForLead('L1'); // visibility not measured -> partial completeness
  const r = evaluateIcpFit({ view: toLeadView(ctx.leads.L1), icp, packet, now: NOW });
  assert.equal(r.fitStatus, 'unknown');
});

test('icp: schema validation rejects bad definitions', () => {
  assert.throws(() => assertIcp({ icp_id: 'x', name: 'n', criteria: [{ id: 'a', label: 'l', field: 'revenue', op: 'eq', value: 1 }] }));
  assert.throws(() => assertIcp({ icp_id: 'x', name: 'n', criteria: [{ id: 'a', label: 'l', field: 'city', op: 'in', value: 'Karachi' }] }));
  assert.throws(() => assertIcp({ icp_id: 'x', name: 'n', criteria: [{ id: 'a', label: 'l', field: 'city', op: 'gte', value: 'x' }] }));
  assert.throws(() => assertIcp({ icp_id: 'x', name: 'n', criteria: [], score: 5 }));
});

test('icp: Target Builder adapter maps the real ZTech target columns; unknowns are reported, not guessed', () => {
  const icp = targetToIcp({ id: 7, name: 'Clinics', industry: '["Clinic","Dentist"]', businessTypes: ['health'], locations: 'Karachi, Pakistan', requiredFields: ['email', 'website', 'fax'], exclusions: '["chains"]' });
  assert.equal(icp.icp_id, 'target_7');
  assert.deepEqual(icp.criteria.map((c) => [c.field, c.op]), [['industry', 'in'], ['business_type', 'in'], ['location', 'in'], ['has_email', 'eq'], ['has_website', 'eq']]);
  assert.deepEqual(icp.criteria[0].value, ['Clinic', 'Dentist']);
  assert.deepEqual(icp.criteria[2].value, ['Karachi', 'Pakistan']);
  assert.deepEqual(icp.unmapped, ['requiredFields:fax', 'exclusions']);
  assert.deepEqual(icp.exclusions, []);
  const single = targetToIcp({ id: 'a b', name: 'X', industry: 'Bakery' });
  assert.equal(single.icp_id, 'target_a_b');
  assert.deepEqual(single.criteria[0].value, ['Bakery']);
  const passthrough = targetToIcp({ id: 1, icp: sampleIcp() });
  assert.equal(passthrough.icp_id, 'icp_karachi_food');
});

test('icp: location matches city OR country; unknown when neither is recorded', () => {
  const icp = { icp_id: 'l', name: 'loc', criteria: [{ id: 'loc', label: 'In Pakistan', field: 'location', op: 'in', value: ['pakistan'] }] };
  assert.equal(evaluateIcpFit({ view: v({ city: 'Lahore', country: 'Pakistan' }), icp, now: NOW }).fitStatus, 'fit');
  assert.equal(evaluateIcpFit({ view: v({ city: 'Dubai', country: 'UAE' }), icp, now: NOW }).fitStatus, 'not_fit');
  assert.equal(evaluateIcpFit({ view: v({ name: 'No location' }), icp, now: NOW }).fitStatus, 'unknown');
  const notIn = { ...icp, criteria: [{ id: 'x', label: 'Not in UAE', field: 'location', op: 'not_in', value: ['uae'] }] };
  assert.equal(evaluateIcpFit({ view: v({ city: 'Lahore', country: 'UAE' }), icp: notIn, now: NOW }).fitStatus, 'not_fit');
});

test('icp service: evaluates via target id; unknown target -> NOT_FOUND', async () => {
  const ctx = build();
  const r = await ctx.li.icp.evaluate({ leadId: 'L1', targetId: 'T1' });
  assert.equal(r.fitStatus, 'fit');
  await assert.rejects(ctx.li.icp.evaluate({ leadId: 'L1', targetId: 'nope' }), (e) => e.code === 'NOT_FOUND');
});
