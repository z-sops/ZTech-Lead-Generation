'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion, DAY } = require('./helpers');
const { ProviderError } = require('../../src/main/lead-intelligence/core/errors');
const { FakeResearchProvider } = require('../../src/main/lead-intelligence/providers/FakeResearchProvider');

test('gateway: uses the configured provider and completes research', async () => {
  const ctx = build();
  const { request, status } = await researchToCompletion(ctx, 'L1');
  assert.equal(request.outcome, 'started');
  assert.equal(request.job.provider_id, 'fake');
  assert.equal(status.research_state, 'complete');
  assert.equal(status.packet.provider, 'fake');
  assert.equal(status.fresh, true);
  assert.deepEqual(ctx.fake.calls.map((c) => c[0]).slice(0, 2), ['preflight', 'start']);
});

test('gateway: provider selection — unknown provider id is blocked, not guessed', async () => {
  const ctx = build({ config: { research: { providerId: 'zuni-seo' } } });
  const r = await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason.code, 'PROVIDER_NOT_CONFIGURED');
  assert.equal(ctx.fake.calls.length, 0);
});

test('gateway: provider selection — explicit provider id picks that provider', async () => {
  const other = new FakeResearchProvider({ id: 'other', name: 'Other' });
  const ctx = build({ providers: new Map([['fake', new FakeResearchProvider()], ['other', other]]), config: { research: { providerId: 'other' } } });
  await researchToCompletion(ctx, 'L1');
  assert.ok(other.calls.length > 0);
});

test('gateway: no-domain lead is blocked with an explicit reason and never researched', async () => {
  const ctx = build();
  const r = await ctx.li.gateway.requestResearch({ leadId: 'L2' });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason.code, 'NO_DOMAIN');
  assert.match(r.reason.message, /does not search the web/);
  assert.equal(ctx.fake.calls.length, 0);
  const s = await ctx.li.gateway.getStatus('L2');
  assert.equal(s.research_state, 'blocked');
  assert.equal(s.digital_footprint.state, 'NO_WEBSITE');
  assert.match(s.digital_footprint.reasons[0], /does not mean the company has no online presence/);
});

test('gateway: lead without name or website is blocked for identity', async () => {
  const ctx = build();
  const r = await ctx.li.gateway.requestResearch({ leadId: 'L4' });
  assert.equal(r.reason.code, 'INSUFFICIENT_IDENTITY');
});

test('gateway: unsafe domains (IP/localhost) are blocked before any provider call', async () => {
  const ctx = build();
  const r = await ctx.li.gateway.requestResearch({ leadId: 'L5' });
  assert.equal(r.outcome, 'blocked');
  assert.equal(r.reason.code, 'INVALID_DOMAIN');
  assert.equal(ctx.fake.calls.length, 0);
});

test('gateway: unknown lead id -> NOT_FOUND', async () => {
  const ctx = build();
  await assert.rejects(ctx.li.gateway.requestResearch({ leadId: 'nope' }), (e) => e.code === 'NOT_FOUND');
});

test('gateway: duplicate prevention — concurrent requests create one job and one provider start', async () => {
  const ctx = build({ scenarios: { 'acme.com': { polls: ['running', 'running', 'complete'] } } });
  const [a, b, c] = await Promise.all([
    ctx.li.gateway.requestResearch({ leadId: 'L1' }),
    ctx.li.gateway.requestResearch({ leadId: 'L1' }),
    ctx.li.gateway.requestResearch({ leadId: 'L1', force: true }),
  ]);
  await ctx.li.gateway.idle();
  const outcomes = [a.outcome, b.outcome, c.outcome].sort();
  assert.deepEqual(outcomes, ['already_active', 'already_active', 'started']);
  const jobs = await ctx.store.jobs.listByLead('L1');
  assert.equal(jobs.length, 1);
  assert.equal(ctx.fake.calls.filter((x) => x[0] === 'start').length, 1);
});

test('gateway: fresh evidence skips research; force re-runs it', async () => {
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  const again = await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  assert.equal(again.outcome, 'fresh');
  const forced = await researchToCompletion(ctx, 'L1', { force: true });
  assert.equal(forced.request.outcome, 'started');
  assert.equal((await ctx.store.packets.listMetaByLead('L1')).length, 2);
});

test('gateway: stale research is reported and allows a new run', async () => {
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  ctx.clock.advance(31 * DAY);
  await ctx.li.coordinator.tick();
  const s = await ctx.li.gateway.getStatus('L1');
  assert.equal(s.research_state, 'stale');
  assert.equal(s.fresh, false);
  assert.equal(s.job.state, 'stale');
  const r = await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  assert.equal(r.outcome, 'started');
});

test('gateway: non-retryable provider failure -> failed with reason', async () => {
  const ctx = build({ scenarios: { 'acme.com': { startErrors: [new ProviderError('PROVIDER_REJECTED', 'rejected', { retryable: false })] } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'failed');
  assert.equal(status.job.last_error_code, 'PROVIDER_REJECTED');
});

test('gateway: retryable failure goes pending, then retries and completes', async () => {
  const ctx = build({ scenarios: { 'acme.com': { startErrors: [new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true })] } } });
  await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx.li.gateway.idle();
  let s = await ctx.li.gateway.getStatus('L1');
  assert.equal(s.research_state, 'pending');
  assert.equal(s.job.attempts, 1);
  assert.ok(s.job.next_attempt_at > ctx.clock().toISOString());
  await ctx.li.coordinator.tick(); // not due yet
  assert.equal((await ctx.li.gateway.getStatus('L1')).research_state, 'pending');
  ctx.clock.advance(1500);
  await ctx.li.coordinator.tick();
  ctx.clock.advance(1500);
  await ctx.li.coordinator.tick();
  s = await ctx.li.gateway.getStatus('L1');
  assert.equal(s.research_state, 'complete');
});

test('gateway: retries are bounded (RETRIES_EXHAUSTED)', async () => {
  const err = () => new ProviderError('PROVIDER_UNAVAILABLE', 'down', { retryable: true });
  const ctx = build({ scenarios: { 'acme.com': { preflightErrors: [err(), err(), err(), err()] } } });
  await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx.li.gateway.idle();
  for (let i = 0; i < 6; i += 1) { ctx.clock.advance(5000); await ctx.li.coordinator.tick(); }
  const s = await ctx.li.gateway.getStatus('L1');
  assert.equal(s.research_state, 'failed');
  assert.equal(s.job.last_error_code, 'RETRIES_EXHAUSTED');
});

test('gateway: auth errors block instead of retrying', async () => {
  const ctx = build({ scenarios: { 'acme.com': { preflight: { ok: false, blocking: true, code: 'PROVIDER_AUTH' } } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'blocked');
  assert.equal(status.job.last_error_code, 'PROVIDER_AUTH');
});

test('gateway: history lists jobs and packets', async () => {
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  await researchToCompletion(ctx, 'L1', { force: true });
  const h = await ctx.li.gateway.getHistory('L1');
  assert.equal(h.jobs.length, 2);
  assert.equal(h.packets.length, 2);
  assert.ok(!('options' in h.jobs[0]));
});
