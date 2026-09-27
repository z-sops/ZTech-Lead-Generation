'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion } = require('./helpers');
const { matchLead, assertFilter } = require('../../src/main/lead-intelligence/search/filters');
const { toLeadView } = require('../../src/main/lead-intelligence/contracts/leadView');

const ctxOf = (raw, extra = {}) => ({ view: toLeadView({ id: 'X', ...raw }), research_state: 'not_researched', footprint_state: 'NOT_CHECKED', icp_fit: null, ...extra });

test('filters: each dimension matches correctly and reports failures', () => {
  const c = ctxOf({ name: 'Acme Bakery', city: 'Karachi', country: 'Pakistan', category: 'Bakery', type: 'restaurant', website: 'acme.com', email: 'a@acme.com', qualification_status: 'Qualified', quality: 'high' });
  assert.equal(matchLead({}, c).matched, true);
  assert.equal(matchLead({ text: 'acme' }, c).matched, true);
  assert.equal(matchLead({ location: { cities: ['karachi'] } }, c).matched, true);
  assert.deepEqual(matchLead({ location: { cities: ['Lahore'] } }, c).failed, ['location.cities']);
  assert.equal(matchLead({ industries: ['BAKERY'], business_types: ['restaurant'] }, c).matched, true);
  assert.equal(matchLead({ website: 'present', email: 'present', phone: 'absent' }, c).matched, true);
  assert.deepEqual(matchLead({ phone: 'present' }, c).failed, ['phone']);
  assert.equal(matchLead({ qualification: ['qualified'], data_quality: ['high'] }, c).matched, true);
  assert.equal(matchLead({ research_status: ['not_researched'], digital_footprint: ['NOT_CHECKED'] }, c).matched, true);
  assert.deepEqual(matchLead({ icp_fit: ['fit'], target_id: 'T1' }, c).failed, ['icp_fit']);
  assert.equal(matchLead({ icp_fit: ['fit'], target_id: 'T1' }, { ...c, icp_fit: { fitStatus: 'fit' } }).matched, true);
});

test('filters: schema rejects unknown dimensions and icp_fit without target', () => {
  assert.throws(() => assertFilter({ revenue: 5 }));
  assert.throws(() => assertFilter({ website: 'maybe' }));
  assert.throws(() => assertFilter({ icp_fit: ['fit'] }), /target_id/);
  assert.ok(assertFilter({ icp_fit: ['unknown'], target_id: 'T1' }));
});

test('saved searches: persist name + full filter, update keeps createdAt', async () => {
  const ctx = build();
  const filter = { location: { cities: ['Karachi'] }, website: 'present', qualification: ['qualified'], research_status: ['not_researched', 'complete'], digital_footprint: ['NOT_CHECKED', 'DIGITAL_FOOTPRINT_FOUND'], target_id: 'T1', icp_fit: ['fit', 'unknown'], data_quality: ['high'], industries: ['Bakery', 'Clinic'], business_types: ['restaurant', 'health'], email: 'any', phone: 'any' };
  const s = await ctx.li.savedSearches.save({ name: '  Karachi with sites ', filter });
  assert.equal(s.name, 'Karachi with sites');
  assert.deepEqual(s.filter, filter);
  ctx.clock.advance(60000);
  const s2 = await ctx.li.savedSearches.save({ searchId: s.search_id, name: 'Renamed', filter });
  assert.equal(s2.created_at, s.created_at);
  assert.notEqual(s2.updated_at, s.updated_at);
  assert.equal((await ctx.li.savedSearches.list()).length, 1);
  await assert.rejects(ctx.li.savedSearches.save({ searchId: 'srch_missing', name: 'x', filter: {} }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(ctx.li.savedSearches.save({ name: '', filter: {} }), (e) => e.code === 'VALIDATION_FAILED');
});

test('saved searches: run evaluates live Lead Library data', async () => {
  const ctx = build();
  const s = await ctx.li.savedSearches.save({ name: 'Karachi + website', filter: { location: { cities: ['Karachi'] }, website: 'present' } });
  let r = await ctx.li.savedSearches.run({ searchId: s.search_id });
  assert.deepEqual(r.rows.map((x) => x.lead_id).sort(), ['L1', 'L3', 'L5']);
  ctx.leads.L3.city = 'Lahore'; // lead edited in the Lead Library
  r = await ctx.li.savedSearches.run({ searchId: s.search_id });
  assert.deepEqual(r.rows.map((x) => x.lead_id).sort(), ['L1', 'L5']);
});

test('saved searches: research and footprint filters use current research state', async () => {
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  const done = await ctx.li.savedSearches.run({ filter: { research_status: ['complete'] } });
  assert.deepEqual(done.rows.map((x) => x.lead_id), ['L1']);
  const noSite = await ctx.li.savedSearches.run({ filter: { digital_footprint: ['NO_WEBSITE'] } });
  assert.deepEqual(noSite.rows.map((x) => x.lead_id).sort(), ['L2', 'L4']);
  const fit = await ctx.li.savedSearches.run({ filter: { target_id: 'T1', icp_fit: ['fit'] } });
  assert.deepEqual(fit.rows.map((x) => x.lead_id), ['L1']);
  assert.equal(fit.rows[0].icp_fit_status, 'fit');
});

test('segments: dynamic segment re-evaluates against current leads', async () => {
  const ctx = build();
  const seg = await ctx.li.segments.save({ name: 'Qualified', kind: 'dynamic', filter: { qualification: ['qualified'] } });
  let m = await ctx.li.segments.members(seg.segment_id);
  assert.deepEqual(m.rows.map((r) => r.lead_id).sort(), ['L1', 'L3']);
  ctx.leads.L2.qualification.status = 'qualified';
  m = await ctx.li.segments.members(seg.segment_id);
  assert.deepEqual(m.rows.map((r) => r.lead_id).sort(), ['L1', 'L2', 'L3']);
});

test('segments: static membership stores references only and reports deleted leads', async () => {
  const ctx = build();
  const seg = await ctx.li.segments.save({ name: 'Hand-picked', kind: 'static' });
  await ctx.li.segments.addLeads(seg.segment_id, ['L1', 'L3', 'L3']);
  let m = await ctx.li.segments.members(seg.segment_id);
  assert.deepEqual(m.rows.map((r) => r.lead_id), ['L1', 'L3']);
  assert.deepEqual(await ctx.store.segments.members(seg.segment_id), ['L1', 'L3']); // ids only, no copies
  delete ctx.leads.L3; // deleted from the Lead Library
  m = await ctx.li.segments.members(seg.segment_id);
  assert.deepEqual(m.rows.map((r) => r.lead_id), ['L1']);
  assert.deepEqual(m.missing_lead_ids, ['L3']);
  await ctx.li.segments.removeLeads(seg.segment_id, ['L1']);
  assert.equal((await ctx.li.segments.members(seg.segment_id)).total, 0);
  await assert.rejects(ctx.li.segments.addLeads(seg.segment_id, ['nope']), (e) => e.code === 'VALIDATION_FAILED');
});

test('segments: kind rules are enforced', async () => {
  const ctx = build();
  const dyn = await ctx.li.segments.save({ name: 'D', kind: 'dynamic', filter: {} });
  await assert.rejects(ctx.li.segments.addLeads(dyn.segment_id, ['L1']), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(ctx.li.segments.save({ name: 'S', kind: 'static', filter: {} }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(ctx.li.segments.save({ segmentId: dyn.segment_id, name: 'D', kind: 'static' }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(ctx.li.segments.save({ name: 'X', kind: 'smart' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.deepEqual(await ctx.li.segments.delete(dyn.segment_id), { deleted: true });
});
