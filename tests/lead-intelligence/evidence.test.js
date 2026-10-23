'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildEvidencePacket, validateEvidencePacket, indexPacket, summarizePacket } = require('../../src/main/lead-intelligence/contracts/evidencePacket');
const { validateProviderResult } = require('../../src/main/lead-intelligence/providers/ProspectResearchProvider');
const { defaultFakeResult } = require('../../src/main/lead-intelligence/providers/FakeResearchProvider');
const { FreshnessPolicy } = require('../../src/main/lead-intelligence/research/FreshnessPolicy');
const { toLeadView, identityFromView } = require('../../src/main/lead-intelligence/contracts/leadView');
const { provenanceFor } = require('../../src/main/lead-intelligence/contracts/provenance');
const { PACKET_CONTRACT_VERSION } = require('../../src/main/lead-intelligence/contracts/constants');

const NOW = new Date('2026-09-01T10:00:00.000Z');
const view = toLeadView({ id: 'L1', name: 'Acme', website: 'https://acme.com', email: 'a@acme.com' });

function build(result = defaultFakeResult('acme.com', 'job-1', NOW)) {
  return buildEvidencePacket({
    leadId: 'L1', jobId: 'rjob_1', identity: identityFromView(view), provider: { id: 'fake', name: 'Fake' },
    result, freshness: new FreshnessPolicy(), now: NOW, leadView: view,
  });
}

test('evidence: a packet built from a valid provider result passes schema + integrity', () => {
  const p = build();
  const v = validateEvidencePacket(p);
  assert.equal(v.valid, true, JSON.stringify(v.errors));
  assert.equal(p.contract_version, PACKET_CONTRACT_VERSION);
  assert.equal(p.requested_domain, 'acme.com');
  assert.equal(p.audited_domain, 'www.acme.com');
  assert.equal(p.redirect_chain.length, 2);
  assert.equal(p.digital_footprint.state, 'DIGITAL_FOOTPRINT_FOUND');
  assert.equal(p.freshness.max_age_days, 30);
  assert.equal(p.completeness.level, 'partial'); // visibility not measured
  assert.ok(p.not_measured.some((n) => n.area === 'visibility'));
  assert.equal(summarizePacket(p).counts.findings, 3);
});

test('evidence: every fact, finding and strength carries complete provenance', () => {
  const p = build();
  for (const f of p.facts) {
    assert.equal(f.provenance.fact_id, f.fact_id);
    assert.equal(f.provenance.lead_id, 'L1');
    assert.equal(f.provenance.packet_id, p.packet_id);
    assert.equal(f.provenance.provider, 'fake');
    assert.equal(f.provenance.engine_version, '0.14.0-fake');
    assert.equal(f.provenance.contract_version, 'zseo.evidence-envelope/1');
    assert.equal(f.provenance.captured_at, NOW.toISOString());
  }
  for (const g of p.findings) {
    assert.equal(g.provenance.finding_id, g.finding_id);
    for (const id of g.fact_ids) assert.ok(indexPacket(p).facts.has(id));
  }
  for (const s of p.strengths) assert.ok(s.fact_ids.length + s.finding_ids.length > 0);
  assert.equal(provenanceFor(p, p.findings[0].finding_id).finding_id, p.findings[0].finding_id);
  assert.equal(provenanceFor(p, 'nope'), null);
});

test('evidence: malformed provider results are rejected before packet building', () => {
  assert.equal(validateProviderResult({ junk: true }).valid, false);
  const r = defaultFakeResult('acme.com', 'job-1', NOW);
  assert.equal(validateProviderResult({ ...r, outcome: 'maybe' }).valid, false);
  assert.equal(validateProviderResult({ ...r, capturedAt: 'yesterday' }).valid, false);
  assert.equal(validateProviderResult({ ...r, facts: [{ key: 'bad key!', area: 'technical', value: 1 }] }).valid, false);
  assert.equal(validateProviderResult({ ...r, extra: 1 }).valid, false);
});

test('evidence: tampered packets fail integrity checks', () => {
  const p = build();
  const broken = JSON.parse(JSON.stringify(p));
  broken.findings[0].fact_ids = ['fact_doesnotexist000000000000'];
  assert.equal(validateEvidencePacket(broken).valid, false);
  const wrongLead = JSON.parse(JSON.stringify(p));
  wrongLead.facts[0].provenance.lead_id = 'L2';
  assert.equal(validateEvidencePacket(wrongLead).valid, false);
  const dup = JSON.parse(JSON.stringify(p));
  dup.facts[1].fact_id = dup.facts[0].fact_id;
  dup.facts[1].provenance.fact_id = dup.facts[0].fact_id;
  assert.equal(validateEvidencePacket(dup).valid, false);
});

test('evidence: incomplete/partial packets are marked and untraceable strengths dropped', () => {
  const r = defaultFakeResult('acme.com', 'job-2', NOW, 'partial');
  r.strengths.push({ statement: 'Great brand', area: 'content', factKeys: ['does.not.exist'], ruleIds: [] });
  const p = build(r);
  assert.equal(validateEvidencePacket(p).valid, true);
  assert.equal(p.research_status, 'partial');
  assert.equal(p.completeness.level, 'partial');
  assert.equal(p.freshness.max_age_days, 7);
  assert.equal(p.digital_footprint.state, 'RESEARCH_PARTIAL');
  assert.ok(!p.strengths.some((s) => s.statement === 'Great brand'));
  assert.ok(p.limitations.some((l) => l.code === 'UNTRACEABLE_STRENGTH_DROPPED'));
  assert.ok(p.limitations.some((l) => l.code === 'UNRESOLVED_FACT_REFERENCE'));
});

test('evidence: complete outcome with a failed area is downgraded to partial', () => {
  const r = defaultFakeResult('acme.com', 'job-3', NOW);
  r.areas.visibility = 'failed';
  const p = build(r);
  assert.equal(p.research_status, 'partial');
});

test('freshness policy', () => {
  const f = new FreshnessPolicy({ completeMaxAgeDays: 30 });
  const p = build();
  assert.equal(f.isFresh(p, NOW), true);
  assert.equal(f.isFresh(p, new Date(NOW.getTime() + 31 * 86400000)), false);
  assert.equal(f.isFresh({ ...p, research_status: 'failed' }, NOW), false);
  assert.throws(() => new FreshnessPolicy({ completeMaxAgeDays: -1 }));
});
