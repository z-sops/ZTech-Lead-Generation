'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion } = require('./helpers');
const { detectChanges, detectChangesDetailed } = require('../../src/main/lead-intelligence/research/changeDetection');
const { deriveSignals, UNSUPPORTED_SIGNALS, SIGNAL_TYPES } = require('../../src/main/lead-intelligence/research/signals');
const { computeDigitalFootprint } = require('../../src/main/lead-intelligence/research/digitalFootprint');
const { toLeadView } = require('../../src/main/lead-intelligence/contracts/leadView');

async function twoPackets(firstResult = {}, secondResult = {}) {
  const ctx = build({ scenarios: { 'acme.com': { result: firstResult } } });
  await researchToCompletion(ctx, 'L1');
  ctx.fake.scenarios['acme.com'].result = secondResult;
  ctx.clock.advance(60000);
  await researchToCompletion(ctx, 'L1', { force: true });
  const [newer, older] = await ctx.store.packets.listMetaByLead('L1');
  return { ctx, prev: await ctx.store.packets.get(older.packet_id), next: await ctx.store.packets.get(newer.packet_id) };
}

const facts = (over) => {
  const base = [
    { key: 'http.reachable', area: 'technical', label: 'Website reachable', value: true, sourceUrl: null, untrusted: false },
    { key: 'http.final_status', area: 'technical', label: 'Final HTTP status', value: 200, sourceUrl: null, untrusted: false },
    { key: 'crawl.html_pages', area: 'crawl', label: 'Crawlable HTML pages', value: 12, sourceUrl: null, untrusted: false },
    { key: 'tls.valid', area: 'technical', label: 'TLS certificate valid', value: true, sourceUrl: null, untrusted: false },
    { key: 'tech.platform', area: 'technical', label: 'Detected platform', value: 'WordPress', sourceUrl: null, untrusted: false },
  ];
  return base.map((f) => (over[f.key] !== undefined ? { ...f, value: over[f.key] } : f));
};

test('changes: changed fact is detected with fact refs and provenance', async () => {
  const { prev, next, ctx } = await twoPackets({}, { facts: facts({ 'tech.platform': 'Shopify' }) });
  const changes = detectChanges(prev, next);
  const c = changes.find((x) => x.type === 'fact_changed' && x.subject === 'tech.platform');
  assert.ok(c);
  assert.equal(c.previousValue, 'WordPress');
  assert.equal(c.newValue, 'Shopify');
  assert.equal(c.lead_id, 'L1');
  assert.equal(c.fact_refs.previous.length, 1);
  assert.equal(c.fact_refs.current.length, 1);
  assert.equal(c.provenance.previous_packet_id, prev.packet_id);
  assert.equal(c.provenance.current_packet_id, next.packet_id);
  assert.ok(c.detectedAt);
  // also persisted automatically after the second run
  const stored = await ctx.store.changes.listByLead('L1');
  assert.ok(stored.some((x) => x.change_id === c.change_id));
});

test('changes: identical evidence produces no changes', async () => {
  const { prev, next } = await twoPackets();
  assert.deepEqual(detectChanges(prev, next), []);
});

test('changes: insufficient evidence is never reported as a change', async () => {
  const { prev, next } = await twoPackets({}, { areas: { technical: 'measured', crawl: 'not_measured', content: 'measured', visibility: 'not_measured' }, facts: facts({ 'crawl.html_pages': 2 }) });
  const d = detectChangesDetailed(prev, next);
  assert.ok(!d.changes.some((c) => c.subject === 'crawl.html_pages'));
  assert.ok(d.insufficient.some((i) => i.subject === 'fact:crawl.html_pages'));
});

test('changes: failed run -> no website comparisons, only completeness', async () => {
  const failed = { outcome: 'failed', areas: { technical: 'failed' }, facts: [], findings: [], strengths: [], notMeasured: [], limitations: [{ code: 'X', message: 'y' }] };
  const { prev, next } = await twoPackets({}, failed);
  const d = detectChangesDetailed(prev, next);
  assert.deepEqual(d.changes.map((c) => c.type), ['research_completeness_changed']);
  assert.ok(d.insufficient.some((i) => i.subject === 'evidence'));
});

test('changes: finding appeared/resolved only when area measured in both runs with the same engine', async () => {
  const first = {};
  const second = {
    findings: [
      { ruleId: 'org_schema_missing', area: 'content', title: 'No Organization structured data', severity: 'medium', basis: 'standard', observed: 'x', recommendation: 'y', urls: [], factKeys: [] },
      { ruleId: 'security_headers_missing', area: 'technical', title: 'Security headers missing', severity: 'low', basis: 'standard', observed: 'x', recommendation: 'y', urls: [], factKeys: [] },
      { ruleId: 'robots_blocks_ai', area: 'technical', title: 'robots.txt blocks AI crawlers', severity: 'high', basis: 'standard', observed: 'x', recommendation: 'y', urls: [], factKeys: [] },
    ],
  };
  const { prev, next } = await twoPackets(first, second);
  const types = detectChanges(prev, next).map((c) => `${c.type}:${c.subject}`).sort();
  assert.deepEqual(types, ['content_finding_resolved:meta_description_missing', 'technical_finding_appeared:robots_blocks_ai']);
  const other = await twoPackets({}, { ...second, engineVersion: '0.15.0' });
  const d = detectChangesDetailed(other.prev, other.next);
  assert.ok(!d.changes.some((c) => c.type.endsWith('_finding_appeared')));
  assert.ok(d.insufficient.some((i) => /Engine version differs/.test(i.reason)));
});

test('changes: footprint and domain changes', async () => {
  const { prev, next } = await twoPackets({}, { auditedDomain: 'shop.acme.com', facts: facts({ 'crawl.html_pages': 1 }) });
  const t = detectChanges(prev, next).map((c) => c.type);
  assert.ok(t.includes('domain_changed'));
  assert.ok(t.includes('digital_footprint_changed'));
  assert.ok(t.includes('fact_changed'));
});

test('changes: packets of different leads are rejected', async () => {
  const { prev, next } = await twoPackets();
  assert.throws(() => detectChanges(prev, { ...next, lead_id: 'L9' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.deepEqual(detectChanges(prev, prev), []);
  assert.equal(detectChangesDetailed(null, next).changes.length, 0);
});

test('signals: only evidence-backed signal types are derived', async () => {
  const { prev, next } = await twoPackets({}, { auditedDomain: 'shop.acme.com', facts: facts({ 'tech.platform': 'Shopify', 'crawl.html_pages': 30 }) });
  const signals = deriveSignals(detectChanges(prev, next));
  const types = signals.map((s) => s.type).sort();
  assert.deepEqual(types, [SIGNAL_TYPES.CONTENT_ACTIVITY, SIGNAL_TYPES.TECHNOLOGY_CHANGE, SIGNAL_TYPES.WEBSITE_CHANGE].sort());
  for (const s of signals) {
    assert.equal(s.status, 'observed');
    assert.equal(s.confidence_basis, 'direct_comparison_of_two_measured_research_runs');
    assert.equal(s.source, 'fake');
    assert.ok(s.observedAt && s.provenance.current_packet_id);
  }
  assert.ok(signals.find((s) => s.type === 'technology_change').factIds.length === 2);
  assert.deepEqual(UNSUPPORTED_SIGNALS.map((u) => u.type), ['hiring_signal', 'business_expansion']);
  assert.ok(!signals.some((s) => ['hiring_signal', 'business_expansion'].includes(s.type)));
});

test('footprint: no website is explicitly not "no online presence"', () => {
  const noSite = computeDigitalFootprint({ packet: null, leadView: toLeadView({ id: 'a', name: 'A' }) });
  assert.equal(noSite.state, 'NO_WEBSITE');
  assert.match(noSite.reasons[0], /does not mean the company has no online presence/);
  assert.match(noSite.scope, /Social profiles, marketplaces, directories and maps listings were not checked/);
  const unchecked = computeDigitalFootprint({ packet: null, leadView: toLeadView({ id: 'a', website: 'a.com' }) });
  assert.equal(unchecked.state, 'NOT_CHECKED');
});

test('footprint: limited / no crawlable content thresholds are explicit', async () => {
  const limited = await twoPackets({ facts: facts({ 'crawl.html_pages': 2 }) }, { facts: facts({ 'crawl.html_pages': 0 }) });
  assert.equal(limited.prev.digital_footprint.state, 'LIMITED_DIGITAL_FOOTPRINT');
  assert.match(limited.prev.digital_footprint.reasons[0], /fewer than 3/);
  assert.equal(limited.next.digital_footprint.state, 'NO_CRAWLABLE_CONTENT');
});
