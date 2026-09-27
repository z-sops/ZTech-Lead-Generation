'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { build, researchToCompletion, makeClock, sampleLeads, makeLeadSource } = require('./helpers');
const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
const { FakeResearchProvider } = require('../../src/main/lead-intelligence/providers/FakeResearchProvider');
const { ResearchCoordinator } = require('../../src/main/lead-intelligence/research/ResearchCoordinator');
const { FreshnessPolicy } = require('../../src/main/lead-intelligence/research/FreshnessPolicy');
const { canTransition, assertTransition } = require('../../src/main/lead-intelligence/research/stateMachine');
const { RESEARCH_STATES } = require('../../src/main/lead-intelligence/contracts/constants');

test('state machine: allowed and forbidden transitions', () => {
  assert.ok(canTransition('requested', 'preflight'));
  assert.ok(canTransition('polling', 'pending'));
  assert.ok(canTransition('complete', 'stale'));
  assert.ok(!canTransition('failed', 'polling'));
  assert.ok(!canTransition('complete', 'polling'));
  assert.throws(() => assertTransition('blocked', 'started'), (e) => e.code === 'INVALID_TRANSITION');
  assert.equal(RESEARCH_STATES.length, 10);
});

test('research: polling persists provider_job_id and poll count until complete', async () => {
  const ctx = build({ scenarios: { 'acme.com': { polls: ['running', 'running', 'running', 'complete'] } } });
  await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx.li.gateway.idle();
  let [job] = await ctx.store.jobs.listByLead('L1');
  assert.equal(job.state, 'polling');
  assert.match(job.provider_job_id, /^fake-job-/);
  for (let i = 0; i < 3; i += 1) { ctx.clock.advance(1100); await ctx.li.coordinator.tick(); }
  [job] = await ctx.store.jobs.listByLead('L1');
  assert.equal(job.state, 'polling');
  assert.ok(job.poll_count >= 2);
  ctx.clock.advance(1100);
  await ctx.li.coordinator.tick();
  [job] = await ctx.store.jobs.listByLead('L1');
  assert.equal(job.state, 'complete');
  assert.ok(job.packet_id);
});

test('research: restart recovery resumes polling without starting a second provider job', async () => {
  const clock = makeClock();
  const store = new MemoryStore();
  const provider = new FakeResearchProvider({ clock, scenarios: { 'acme.com': { polls: ['running', 'running', 'complete'] } } });
  const ctx1 = build({ store, clock, providers: new Map([['fake', provider]]) });
  await ctx1.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx1.li.gateway.idle();
  const [before] = await store.jobs.listByLead('L1');
  assert.equal(before.state, 'polling');

  // "Restart": brand-new service graph over the same persisted store and provider.
  const ctx2 = build({ store, clock, providers: new Map([['fake', provider]]) });
  clock.advance(2000);
  await ctx2.li.coordinator.recover();
  clock.advance(2000);
  await ctx2.li.coordinator.tick();
  clock.advance(2000);
  await ctx2.li.coordinator.tick();
  const [after] = await store.jobs.listByLead('L1');
  assert.equal(after.job_id, before.job_id);
  assert.equal(after.state, 'complete');
  assert.equal(provider.calls.filter((c) => c[0] === 'start').length, 1);
});

test('research: a job interrupted in "started" (before polling was persisted) resumes', async () => {
  const clock = makeClock();
  const store = new MemoryStore();
  const provider = new FakeResearchProvider({ clock });
  const leads = sampleLeads();
  const coord = new ResearchCoordinator({ store, providers: new Map([['fake', provider]]), freshness: new FreshnessPolicy(), clock, logger: { warn() {}, error() {} } });
  const { job } = await coord.createJob({ leadId: 'L1', providerId: 'fake', domain: { host: 'acme.com', key: 'acme.com' } });
  const started = await provider.startResearch({ domain: 'acme.com', idempotencyKey: job.job_id });
  await store.jobs.update({ ...job, state: 'started', provider_job_id: started.providerJobId, started_at: clock().toISOString(), version: 2 }, 1);
  const restarted = new ResearchCoordinator({ store, providers: new Map([['fake', provider]]), freshness: new FreshnessPolicy(), clock, logger: { warn() {}, error() {} }, identityForLead: async () => ({ identity: null, view: null }) });
  await restarted.recover();
  const j = await store.jobs.get(job.job_id);
  assert.equal(j.state, 'complete');
  assert.equal(provider.calls.filter((c) => c[0] === 'start').length, 1);
  assert.ok(makeLeadSource(leads));
});

test('research: MCP outage while polling -> pending, then resumes polling the SAME job', async () => {
  const { ProviderError } = require('../../src/main/lead-intelligence/core/errors');
  const ctx = build({ scenarios: { 'acme.com': { polls: ['running', 'complete'], pollErrors: [new ProviderError('PROVIDER_UNAVAILABLE', 'outage', { retryable: true })] } } });
  await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx.li.gateway.idle();
  ctx.clock.advance(1100);
  await ctx.li.coordinator.tick();
  let [job] = await ctx.store.jobs.listByLead('L1');
  assert.equal(job.state, 'pending');
  const providerJob = job.provider_job_id;
  for (let i = 0; i < 4; i += 1) { ctx.clock.advance(1500); await ctx.li.coordinator.tick(); }
  [job] = await ctx.store.jobs.listByLead('L1');
  assert.equal(job.state, 'complete');
  assert.equal(job.provider_job_id, providerJob);
  assert.equal(ctx.fake.calls.filter((c) => c[0] === 'start').length, 1);
});

test('research: partial result -> partial state and RESEARCH_PARTIAL footprint', async () => {
  const ctx = build({ scenarios: { 'acme.com': { polls: ['partial'] } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'partial');
  assert.equal(status.digital_footprint.state, 'RESEARCH_PARTIAL');
  assert.equal(status.packet.completeness.level, 'partial');
});

test('research: provider-reported failure -> failed without a packet', async () => {
  const ctx = build({ scenarios: { 'acme.com': { polls: ['running', 'failed'] } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'failed');
  assert.equal(status.job.last_error_code, 'PROVIDER_JOB_FAILED');
  assert.equal(status.packet, null);
});

test('research: malformed result -> failed MALFORMED_RESULT, nothing stored', async () => {
  const ctx = build({ scenarios: { 'acme.com': { malformed: true } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.job.last_error_code, 'MALFORMED_RESULT');
  assert.equal((await ctx.store.packets.listMetaByLead('L1')).length, 0);
});

test('research: result for a different website is rejected (DOMAIN_MISMATCH)', async () => {
  const ctx = build({ scenarios: { 'acme.com': { result: { requestedDomain: 'evil.example' } } } });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.job.last_error_code, 'DOMAIN_MISMATCH');
});

test('research: site unreachable outcome stores evidence and footprint SITE_UNREACHABLE', async () => {
  const ctx = build({
    scenarios: {
      'acme.com': {
        result: {
          outcome: 'failed',
          areas: { technical: 'measured', crawl: 'failed' },
          facts: [
            { key: 'http.reachable', area: 'technical', label: 'Website reachable', value: false, sourceUrl: null, untrusted: false },
            { key: 'http.final_status', area: 'technical', label: 'Final HTTP status', value: 503, sourceUrl: null, untrusted: false },
          ],
          findings: [],
          strengths: [],
          notMeasured: [],
          limitations: [{ code: 'SITE_UNREACHABLE', message: 'Timed out.' }],
        },
      },
    },
  });
  const { status } = await researchToCompletion(ctx, 'L1');
  assert.equal(status.research_state, 'failed');
  assert.equal(status.digital_footprint.state, 'SITE_UNREACHABLE');
  assert.equal(status.packet.research_status, 'failed');
  assert.match(status.digital_footprint.reasons[0], /503/);
});

test('research: stale marking runs on tick and leaves the packet readable', async () => {
  const ctx = build({ config: { freshness: { completeMaxAgeDays: 1 } } });
  await researchToCompletion(ctx, 'L1');
  ctx.clock.advance(2 * 86400000);
  const r = await ctx.li.coordinator.tick();
  assert.equal(r.staled, 1);
  const packet = await ctx.store.packets.latestForLead('L1');
  assert.ok(packet);
});

test('research: renderer reload is harmless — status is read from the store', async () => {
  const ctx = build({ scenarios: { 'acme.com': { polls: ['running', 'complete'] } } });
  await ctx.li.gateway.requestResearch({ leadId: 'L1' });
  await ctx.li.gateway.idle();
  const a = await ctx.li.gateway.getStatus('L1');
  const b = await ctx.li.gateway.getStatus('L1');
  assert.deepEqual(a, b);
  assert.equal(ctx.fake.calls.filter((c) => c[0] === 'start').length, 1);
});
