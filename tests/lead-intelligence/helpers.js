'use strict';

/**
 * Shared test fixtures. Builds the full service graph on MemoryStore (or a supplied
 * store) with the FakeResearchProvider and a controllable clock.
 */
const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
const { FakeResearchProvider } = require('../../src/main/lead-intelligence/providers/FakeResearchProvider');
const { createLeadIntelligence } = require('../../src/main/lead-intelligence/index');

function makeClock(startIso = '2026-09-01T10:00:00.000Z') {
  let now = new Date(startIso);
  const clock = () => new Date(now.getTime());
  clock.advance = (ms) => { now = new Date(now.getTime() + ms); return clock(); };
  clock.set = (iso) => { now = new Date(iso); return clock(); };
  return clock;
}

const DAY = 24 * 60 * 60 * 1000;

function sampleLeads() {
  return {
    L1: { id: 'L1', name: 'Acme Bakery', website: 'https://acme.com', email: 'hello@acme.com', phone: '+92 300 1234567', city: 'Karachi', country: 'Pakistan', category: 'Bakery', type: 'restaurant', qualification: { status: 'qualified' }, quality: 'high' },
    L2: { id: 'L2', name: 'Beta Traders', website: '', email: '', phone: '+92 21 111 222', city: 'Lahore', country: 'Pakistan', category: 'Wholesale', type: 'store', qualification: { status: 'unqualified' }, quality: 'medium' },
    L3: { id: 'L3', name: 'Gamma Clinic', website: 'gamma-clinic.pk', email: 'info@gamma-clinic.pk', phone: null, city: 'Karachi', country: 'Pakistan', category: 'Clinic', type: 'health', qualification: { status: 'qualified' }, quality: 'high' },
    L4: { id: 'L4', name: null, website: null, email: null, phone: '0300 0000000' },
    L5: { id: 'L5', name: 'Local Only', website: 'http://127.0.0.1', email: 'x@y.com', city: 'Karachi' },
  };
}

function makeLeadSource(leads) {
  return {
    leads,
    getLead: async (id) => leads[String(id)] || null,
    listLeads: async () => Object.values(leads),
  };
}

function sampleIcp() {
  return {
    icp_id: 'icp_karachi_food',
    name: 'Karachi food businesses with a website',
    criteria: [
      { id: 'c_city', label: 'Based in Karachi', field: 'city', op: 'eq', value: 'Karachi' },
      { id: 'c_industry', label: 'Food industry', field: 'industry', op: 'in', value: ['Bakery', 'Restaurant', 'Cafe'] },
      { id: 'c_site', label: 'Has a website', field: 'has_website', op: 'eq', value: true },
    ],
    exclusions: [
      { id: 'x_unqualified', label: 'Marked unqualified', field: 'qualification_status', op: 'eq', value: 'unqualified' },
    ],
  };
}

function makeTargetSource(targets = { T1: { id: 'T1', icp: sampleIcp() } }) {
  return { getTarget: async (id) => targets[String(id)] || null };
}

function build({ leads = sampleLeads(), store = new MemoryStore(), scenarios = {}, config = {}, clock = makeClock(), providers, llmComplete, emailProvider, enrichmentProviders = [] } = {}) {
  const fake = new FakeResearchProvider({ clock, scenarios });
  const leadSource = makeLeadSource(leads);
  const li = createLeadIntelligence({
    store,
    leadSource,
    targetSource: makeTargetSource(),
    providers: providers || new Map([['fake', fake]]),
    clock,
    logger: { warn() {}, error() {}, info() {} },
    llmComplete,
    emailProvider,
    enrichmentProviders,
    config: {
      research: { providerId: 'fake', pollIntervalMs: 1000, retry: { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 4000 }, ...(config.research || {}) },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7, ...(config.freshness || {}) },
      offer: {
        sender_name: 'Zee',
        sender_company: 'ZuniTech',
        value_proposition: 'ZuniTech helps local businesses fix website issues found in audits like this one.',
        call_to_action: 'Would a 15-minute call next week be useful to go through these points?',
        ...(config.offer || {}),
      },
      outreach: { allowedQualification: ['qualified'], ...(config.outreach || {}) },
      email: { enabled: false, fromAddress: 'zee@zunitech.example', ...(config.email || {}) },
      ...Object.fromEntries(Object.entries(config).filter(([k]) => !['research', 'freshness', 'offer', 'outreach', 'email'].includes(k))),
    },
  });
  return { li, fake, leadSource, store, clock, leads };
}

/** Run research for a lead with the fake provider until it finishes. */
async function researchToCompletion(ctx, leadId, { force = false } = {}) {
  const r = await ctx.li.gateway.requestResearch({ leadId, force });
  await ctx.li.gateway.idle();
  for (let i = 0; i < 20; i += 1) {
    const s = await ctx.li.gateway.getStatus(leadId);
    if (!['requested', 'preflight', 'started', 'polling', 'pending'].includes(s.research_state)) return { request: r, status: s };
    ctx.clock.advance(5000);
    await ctx.li.coordinator.tick();
  }
  throw new Error('research did not finish');
}

module.exports = { makeClock, DAY, sampleLeads, makeLeadSource, sampleIcp, makeTargetSource, build, researchToCompletion };
