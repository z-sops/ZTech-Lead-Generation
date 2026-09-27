'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion, DAY } = require('./helpers');
const { detectUnsupportedClaims, generatePitch, renderPitchText } = require('../../src/main/lead-intelligence/outreach/PitchGenerator');
const { indexPacket } = require('../../src/main/lead-intelligence/contracts/evidencePacket');
const { FakeEmailProvider } = require('../../src/main/lead-intelligence/outreach/email/FakeEmailProvider');
const { validateEmailMessage, EmailProvider } = require('../../src/main/lead-intelligence/outreach/email/EmailProvider');
const { toLeadView } = require('../../src/main/lead-intelligence/contracts/leadView');

async function readyPitch(opts = {}) {
  const ctx = build(opts);
  await researchToCompletion(ctx, 'L1');
  const pitch = await ctx.li.outreach.generate({ leadId: 'L1', targetId: 'T1' });
  return { ctx, pitch };
}

test('pitch: observations are evidence-backed and cite finding/fact ids', async () => {
  const { ctx, pitch } = await readyPitch();
  const packet = await ctx.store.packets.latestForLead('L1');
  const idx = indexPacket(packet);
  assert.equal(pitch.status, 'draft');
  assert.equal(pitch.observations.length, 2); // only medium+ with standard/research basis
  for (const o of pitch.observations) {
    assert.ok(o.refs.length > 0);
    assert.ok(o.refs.every((r) => idx.hasRef(r)));
    assert.ok(o.provenance.every((p) => p.lead_id === 'L1' && p.packet_id === packet.packet_id));
  }
  assert.ok(pitch.evidenceReferences.length >= 2);
  assert.deepEqual(pitch.unsupportedClaims, []);
  assert.equal(pitch.subject, 'A few notes on www.acme.com');
  assert.ok(!/losing|guarantee|#1/i.test(renderPitchText(pitch)));
  assert.ok(pitch.content_hash);
});

test('pitch: unsupported claims in user text are detected and block approval', async () => {
  const { ctx, pitch } = await readyPitch();
  const edited = await ctx.li.outreach.update({ pitchId: pitch.pitch_id, edits: { valueProposition: 'Your website is slow and you are losing customers. We guarantee #1 on Google.' } });
  assert.equal(edited.status, 'needs_revision');
  const reasons = edited.unsupportedClaims.map((c) => c.reason);
  assert.ok(reasons.includes('PROBLEM_CLAIM_WITHOUT_EVIDENCE') || reasons.includes('PROHIBITED_CLAIM'));
  assert.ok(reasons.includes('PROHIBITED_CLAIM'));
  assert.notEqual(edited.content_hash, pitch.content_hash);
  await assert.rejects(ctx.li.outreach.approve({ pitchId: pitch.pitch_id }), (e) => e.code === 'VALIDATION_FAILED');
});

test('pitch: observations without evidence refs are flagged', () => {
  const claims = detectUnsupportedClaims({ subject: 's', opening: 'o', valueProposition: '', callToAction: '', observations: [{ text: 'Your SEO is broken', refs: [] }] }, null);
  assert.equal(claims[0].reason, 'OBSERVATION_WITHOUT_EVIDENCE');
});

test('pitch: no evidence -> insufficient_evidence, no invented observations', async () => {
  const ctx = build();
  const p = await ctx.li.outreach.generate({ leadId: 'L2' });
  assert.equal(p.status, 'insufficient_evidence');
  assert.deepEqual(p.observations, []);
  const direct = generatePitch({ view: toLeadView({ id: 'Z', name: 'Z' }), packet: null, offer: {} });
  assert.equal(direct.status, 'insufficient_evidence');
});

test('gate: allowed only after human approval of the exact content', async () => {
  const { ctx, pitch } = await readyPitch();
  let g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.equal(g.decision, 'blocked');
  assert.deepEqual(g.reasons.map((r) => r.code), ['HUMAN_APPROVAL']);
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.equal(g.decision, 'allowed', JSON.stringify(g.reasons));
  await ctx.li.outreach.update({ pitchId: pitch.pitch_id, edits: { callToAction: 'Can we talk on Tuesday?' } });
  g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.equal(g.decision, 'blocked');
  assert.match(g.reasons.find((r) => r.code === 'HUMAN_APPROVAL').message, /changed after it was approved/);
});

test('gate: stale evidence blocks', async () => {
  const { ctx, pitch } = await readyPitch();
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  ctx.clock.advance(31 * DAY);
  const g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.ok(g.reasons.some((r) => r.code === 'EVIDENCE_FRESH'));
});

test('gate: missing contact blocks', async () => {
  const { ctx, pitch } = await readyPitch();
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  ctx.leads.L1.email = 'not-an-email';
  const g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.ok(g.reasons.some((r) => r.code === 'CONTACT_FIELD'));
});

test('gate: incomplete (partial) research blocks unless explicitly allowed', async () => {
  const partial = await readyPitch({ scenarios: { 'acme.com': { polls: ['partial'], result: { findings: [
    { ruleId: 'org_schema_missing', area: 'technical', title: 'No Organization structured data', severity: 'medium', basis: 'standard', observed: 'x', recommendation: 'y', urls: [], factKeys: [] },
  ] } } } });
  await partial.ctx.li.outreach.approve({ pitchId: partial.pitch.pitch_id });
  let g = await partial.ctx.li.outreach.gate({ pitchId: partial.pitch.pitch_id });
  assert.ok(g.reasons.some((r) => r.code === 'EVIDENCE_COMPLETE'));
  const allowed = await readyPitch({ config: { outreach: { allowPartialEvidence: true } }, scenarios: { 'acme.com': { polls: ['partial'], result: { findings: [
    { ruleId: 'org_schema_missing', area: 'technical', title: 'No Organization structured data', severity: 'medium', basis: 'standard', observed: 'x', recommendation: 'y', urls: [], factKeys: [] },
  ] } } } });
  await allowed.ctx.li.outreach.approve({ pitchId: allowed.pitch.pitch_id });
  g = await allowed.ctx.li.outreach.gate({ pitchId: allowed.pitch.pitch_id });
  assert.equal(g.decision, 'allowed', JSON.stringify(g.reasons));
  assert.ok(g.warnings.some((w) => w.code === 'EVIDENCE_PARTIAL'));
});

test('gate: identity, qualification, not_fit and outdated evidence all block with reasons', async () => {
  const { ctx, pitch } = await readyPitch();
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  ctx.leads.L1.name = '';
  ctx.leads.L1.qualification.status = 'unqualified';
  let g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  const codes = g.reasons.map((r) => r.code);
  assert.ok(codes.includes('LEAD_IDENTITY'));
  assert.ok(codes.includes('QUALIFICATION'));
  assert.ok(codes.includes('ICP_FIT'));
  ctx.leads.L1.name = 'Acme Bakery';
  ctx.leads.L1.qualification.status = 'qualified';
  await researchToCompletion(ctx, 'L1', { force: true });
  g = await ctx.li.outreach.gate({ pitchId: pitch.pitch_id });
  assert.ok(g.reasons.some((r) => r.code === 'EVIDENCE_OUTDATED'));
});

test('email: fake provider sends only when enabled and the gate allows', async () => {
  const email = new FakeEmailProvider();
  const { ctx, pitch } = await readyPitch({ emailProvider: email, config: { email: { enabled: true } } });
  let r = await ctx.li.outreach.send({ pitchId: pitch.pitch_id });
  assert.equal(r.sent, false);
  assert.equal(email.outbox.length, 0);
  await ctx.li.outreach.approve({ pitchId: pitch.pitch_id });
  r = await ctx.li.outreach.send({ pitchId: pitch.pitch_id });
  assert.equal(r.sent, true);
  assert.equal(email.outbox.length, 1);
  assert.equal(email.outbox[0].message.to, 'hello@acme.com');
  assert.equal(email.outbox[0].message.headers['X-ZTech-Pitch'], pitch.pitch_id);
  assert.deepEqual(await email.getStatus(r.messageId), { messageId: r.messageId, status: 'sent' });
});

test('email: disabled by default', async () => {
  const { ctx, pitch } = await readyPitch({ emailProvider: new FakeEmailProvider() });
  await assert.rejects(ctx.li.outreach.send({ pitchId: pitch.pitch_id }), (e) => e.code === 'EMAIL_DISABLED');
});

test('email: validation blocks header injection, HTML and bad addresses', () => {
  const ok = { to: 'a@b.com', from: 'z@zunitech.example', subject: 'Hi', text: 'Body' };
  assert.equal(validateEmailMessage(ok).valid, true);
  assert.equal(validateEmailMessage({ ...ok, subject: 'Hi\r\nBcc: x@y.com' }).valid, false);
  assert.equal(validateEmailMessage({ ...ok, to: 'a@b.com, c@d.com' }).valid, false);
  assert.equal(validateEmailMessage({ ...ok, html: '<b>x</b>' }).valid, false);
  assert.equal(validateEmailMessage({ ...ok, headers: { Bcc: 'x@y.com' } }).valid, false);
  assert.equal(validateEmailMessage(null).valid, false);
});

test('email: provider failures surface as errors; abstract provider refuses to send', async () => {
  const failing = new FakeEmailProvider({ failWith: 'send' });
  await assert.rejects(failing.send({ to: 'a@b.com', from: 'z@zunitech.example', subject: 'Hi', text: 'x' }), (e) => e.code === 'EMAIL_SEND_FAILED');
  await assert.rejects(new FakeEmailProvider().send({ to: 'bad', from: 'z@zunitech.example', subject: 'Hi', text: 'x' }), (e) => e.code === 'EMAIL_INVALID');
  await assert.rejects(new EmailProvider().send({}), (e) => e.code === 'EMAIL_PROVIDER_NOT_CONFIGURED');
  await assert.rejects(new FakeEmailProvider({ failWith: 'status' }).getStatus('x'), (e) => e.code === 'EMAIL_STATUS_FAILED');
});
