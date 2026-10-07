'use strict';

// F12 Batch 2 — the sixth renderer-reachable Lead Intelligence channel.
//
// Scope: expose the ALREADY-IMPLEMENTED pitch enumeration (Batch 1's
// SqlPitches.list / MemPitches.list) through the existing, narrowly scoped outreach
// IPC registrar and the existing live preload surface. Nothing new is invented here:
// no new pitch state, no gate evaluation, no campaign, no queue, no send path and no
// database change. The handler is read-only and delegates to OutreachService.list.
//
// What this file locks down:
//   1. the channel exists, is registered, and is the ONLY addition
//   2. pagination and status reach the store unchanged
//   3. the sender check is enforced exactly as it is for the other five channels
//   4. the renderer cannot smuggle a sort field, an ordering, a column or a SQL fragment
//   5. email.send and EMAIL_SEND remain unreachable
//   6. the five pre-existing methods are untouched

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { registerOutreachIpc, CHANNELS: OUTREACH_CHANNELS } = require('../../src/main/lead-intelligence/outreach-ipc');
const { OutreachService } = require('../../src/main/lead-intelligence/outreach/OutreachService');
const { MemoryStore } = require('../../src/main/lead-intelligence/persistence/MemoryStore');
const { PITCH_STATUSES, PITCH_LIST_MAX_LIMIT, PITCH_LIST_MAX_OFFSET } = require('../../src/main/lead-intelligence/persistence/contract');

const ROOT = path.join(__dirname, '..', '..');
const SILENT = { warn() {}, error() {}, info() {} };
const PREVIOUS_FIVE = [
  'lead-intel:outreach-approve',
  'lead-intel:outreach-gate',
  'lead-intel:pitch-generate',
  'lead-intel:pitch-get',
  'lead-intel:pitch-update',
];

function pitchRec(over = {}) {
  return {
    pitch_id: 'pitch_1',
    lead_id: 'L1',
    packet_id: 'pkt_1',
    research_status: 'complete',
    target_id: null,
    icp_fit_status: null,
    subject: 'A few notes on www.example.com',
    opening: 'Hi Example team,',
    observations: [{ text: 'No meta description', refs: ['find_1', 'fact_1'], provenance: [] }],
    valueProposition: 'We fix what the audit found.',
    callToAction: 'Would a short call be useful?',
    evidenceReferences: [],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: 'hash_1',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

/** A real MemoryStore-backed OutreachService, so these tests exercise the real chain. */
async function realService(pitches = []) {
  const store = new MemoryStore();
  for (const p of pitches) await store.pitches.upsert(p);
  const service = new OutreachService({
    store,
    contexts: { getContext: async () => { throw new Error('getContext must never be called by list'); } },
    leadSource: { getLead: async () => { throw new Error('leadSource must never be called by list'); } },
    freshness: { isExpiredAt: () => false, isFresh: () => true },
    fieldMap: undefined,
    config: {},
  });
  return { store, service };
}

function harness(outreach, { trusted = true } = {}) {
  const handlers = new Map();
  const reg = registerOutreachIpc({
    ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler: (c) => handlers.delete(c) },
    outreach,
    isTrustedSender: () => trusted,
    logger: SILENT,
  });
  return { handlers, reg, invoke: (c, payload, event = {}) => handlers.get(c)(event, payload) };
}

// F21 declared lock update: the registrar also requires the read-only send-ledger read.
// This stub includes it so all channels can register.
const stubOutreach = (list) => ({
  generate: async () => ({}), get: async () => ({}), latestForLead: async () => null,
  update: async () => ({}), approve: async () => ({}), gate: async () => ({}), list,
  send: async () => ({}),
  sendEmail: async () => ({}),
  sendWhatsApp: async () => ({}),
  sendList: async () => ({ rows: [], total: 0, limit: 0, offset: 0 }),
});

// --- 1. the channel exists and is registered -----------------------------------

test('F12 B2: the outreach:list channel exists with the approved name', () => {
  assert.equal(OUTREACH_CHANNELS.OUTREACH_LIST, 'lead-intel:outreach-list');
});

// F21 declared lock update: the read-only send-ledger read was added alongside the send
// boundary. It is a read channel, so the "no batch/queue/schedule/campaign channel"
// invariant holds.
test('F12 B2: outreach:list is registered, and the five previous channels are unchanged', () => {
  const { reg, handlers } = harness(stubOutreach(async () => ({ rows: [], total: 0, limit: 20, offset: 0, status: null })));
  const registered = reg.channels.slice().sort();
  // F15 declared lock update: outreach:activity is also registered, so outreach:list is no
  // longer the newest channel. This test pins that F12's own channel is untouched.
  // F18 declared lock update: + the single read-only prepare channel.
  // F19 declared lock update: + the single send boundary.
  // F21 declared lock update: + the single read-only send-ledger read.
  assert.deepEqual(registered, [...PREVIOUS_FIVE, 'lead-intel:outreach-list', 'lead-intel:outreach-activity', 'lead-intel:outreach-prepare', 'lead-intel:outreach-ready', 'lead-intel:outreach-send', 'lead-intel:outreach-sends'].sort());
  // F15/F16 declared lock update: the read-only activity and ready channels are now also
  // registered. F18 declared lock update: + prepare. F19 declared lock update: 9 -> 10.
  // F21 declared lock update: 10 -> 11, the read-only send-ledger read.
  assert.equal(handlers.size, 11);
  for (const c of PREVIOUS_FIVE) assert.ok(handlers.has(c), 'previous channel must survive: ' + c);
  assert.ok(handlers.has('lead-intel:outreach-list'));
  // No new channel beyond these: email-send, searches, segments, enrichment,
  // agent and export all stay outside the renderer-reachable surface.
  for (const forbidden of ['lead-intel:email-send', 'lead-intel:searches-list', 'lead-intel:segments-list',
    'lead-intel:enrichment-request', 'lead-intel:agent-analyze', 'lead-intel:export-research',
    'lead-intel:outreach-schedule', 'lead-intel:outreach-queue', 'lead-intel:campaign-run']) {
    assert.ok(!handlers.has(forbidden), 'must not be registered: ' + forbidden);
  }
});

// --- 2-6. the real IPC -> OutreachService -> store chain -------------------------

test('F12 B2: a valid empty query returns the list envelope', async () => {
  const { service } = await realService([]);
  const { invoke } = harness(service);
  const res = await invoke('lead-intel:outreach-list', {});
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { rows: [], total: 0, limit: 20, offset: 0, status: null });
});

test('F12 B2: persisted pitches are enumerated through the real chain', async () => {
  const { service } = await realService([
    pitchRec({ pitch_id: 'pitch_1', updated_at: '2026-01-01T00:00:00.000Z' }),
    pitchRec({ pitch_id: 'pitch_2', updated_at: '2026-03-01T00:00:00.000Z', status: 'needs_revision' }),
  ]);
  const { invoke } = harness(service);
  const res = await invoke('lead-intel:outreach-list', {});
  assert.equal(res.ok, true);
  assert.equal(res.data.total, 2);
  assert.deepEqual(res.data.rows.map((p) => p.pitch_id), ['pitch_2', 'pitch_1']);
  // The full persisted pitch object crosses the boundary intact.
  assert.deepEqual(res.data.rows[0], pitchRec({ pitch_id: 'pitch_2', updated_at: '2026-03-01T00:00:00.000Z', status: 'needs_revision' }));
});

test('F12 B2: pagination parameters reach the store unchanged', async () => {
  const seen = [];
  const { invoke } = harness(stubOutreach(async (q) => { seen.push(q); return { rows: [], total: 0, limit: q.limit, offset: q.offset, status: null }; }));
  await invoke('lead-intel:outreach-list', { limit: 5, offset: 10 });
  await invoke('lead-intel:outreach-list', { limit: 1, offset: 0 });
  assert.deepEqual(seen, [{ limit: 5, offset: 10, status: undefined }, { limit: 1, offset: 0, status: undefined }]);
  // And the real store honours them.
  const { service } = await realService([1, 2, 3, 4, 5].map((i) =>
    pitchRec({ pitch_id: `pitch_${i}`, updated_at: `2026-01-0${i}T00:00:00.000Z` })));
  const { invoke: real } = harness(service);
  const page = await real('lead-intel:outreach-list', { limit: 2, offset: 1 });
  assert.deepEqual(page.data.rows.map((p) => p.pitch_id), ['pitch_4', 'pitch_3']);
  assert.equal(page.data.total, 5);
});

test('F12 B2: the status filter reaches the store and narrows the result', async () => {
  const seen = [];
  const { invoke } = harness(stubOutreach(async (q) => { seen.push(q); return { rows: [], total: 0, limit: 20, offset: 0, status: q.status }; }));
  for (const status of PITCH_STATUSES) {
    const res = await invoke('lead-intel:outreach-list', { status });
    assert.equal(res.ok, true, `${status} must be accepted`);
    assert.equal(res.data.status, status);
  }
  assert.deepEqual(seen.map((q) => q.status), ['draft', 'insufficient_evidence', 'needs_revision']);

  // Real store: each status selects only its own rows.
  const { service } = await realService([
    pitchRec({ pitch_id: 'pitch_d', status: 'draft' }),
    pitchRec({ pitch_id: 'pitch_i', status: 'insufficient_evidence' }),
    pitchRec({ pitch_id: 'pitch_n', status: 'needs_revision' }),
  ]);
  const { invoke: real } = harness(service);
  for (const [status, id] of [['draft', 'pitch_d'], ['insufficient_evidence', 'pitch_i'], ['needs_revision', 'pitch_n']]) {
    const res = await real('lead-intel:outreach-list', { status });
    assert.deepEqual(res.data.rows.map((p) => p.pitch_id), [id]);
    assert.equal(res.data.total, 1);
  }
  // No status means every pitch.
  assert.equal((await real('lead-intel:outreach-list', {})).data.total, 3);
});

test('F12 B2: a non-persisted status is rejected, and gate.decision is not a status', async () => {
  const { service } = await realService([pitchRec()]);
  const { invoke } = harness(service);
  for (const bad of ['approved', 'approval_required', 'sent', 'failed', 'blocked', 'allowed', 'DRAFT', 'pending', 'queued']) {
    const res = await invoke('lead-intel:outreach-list', { status: bad });
    assert.equal(res.ok, false, `${bad} must not be accepted as a pitch status`);
    assert.equal(res.error.code, 'VALIDATION_FAILED');
  }
  // The rejected calls changed nothing.
  assert.equal((await invoke('lead-intel:outreach-list', {})).data.total, 1);
});

test('F12 B2: the schema refuses smuggled fields, sorts and SQL fragments', async () => {
  const { service } = await realService([pitchRec()]);
  const { invoke } = harness(service);
  // additionalProperties:false is what stops a client choosing an ordering or column.
  for (const smuggled of [
    { orderBy: 'lead_id ASC' }, { sort: 'created_at' }, { order: 'asc' }, { sortBy: 'status' },
    { columns: 'draft_json' }, { fields: ['draft_json'] }, { sql: 'SELECT * FROM li_pitch_drafts' },
    { where: '1=1' }, { table: 'numbers' }, { path: '../../secret' }, { provider_id: 'p1' },
    { limit: 5, orderBy: '1' },
  ]) {
    const res = await invoke('lead-intel:outreach-list', smuggled);
    assert.equal(res.ok, false, 'smuggled field must be rejected: ' + JSON.stringify(smuggled));
    assert.equal(res.error.code, 'VALIDATION_FAILED');
  }
  // Structural bounds are enforced at the boundary too.
  for (const bad of [{ limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: 'ten' }, { limit: PITCH_LIST_MAX_LIMIT + 1 },
    { offset: -1 }, { offset: 1.5 }, { offset: PITCH_LIST_MAX_OFFSET + 1 }, { status: 42 }, { status: [] }]) {
    const res = await invoke('lead-intel:outreach-list', bad);
    assert.equal(res.ok, false, 'out-of-bounds input must be rejected: ' + JSON.stringify(bad));
    assert.equal(res.error.code, 'VALIDATION_FAILED');
  }
  // In-range values still pass.
  assert.equal((await invoke('lead-intel:outreach-list', { limit: PITCH_LIST_MAX_LIMIT, offset: 0 })).ok, true);
});

// --- 7-8. the sender check is enforced exactly as for the other five ------------

test('F12 B2: an untrusted sender is refused before the service is called', async () => {
  let called = false;
  const { invoke } = harness(stubOutreach(async () => { called = true; return { rows: [], total: 0, limit: 20, offset: 0, status: null }; }), { trusted: false });
  const res = await invoke('lead-intel:outreach-list', {});
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'FORBIDDEN');
  assert.equal(called, false, 'the service must not be reached by an untrusted sender');
  // The same is already true for the other five; assert it so the new one is not special.
  for (const c of PREVIOUS_FIVE) {
    const r = await invoke(c, { pitchId: 'p', leadId: 'L1' });
    assert.equal(r.ok, false, c + ' must stay sender-checked');
    assert.equal(r.error.code, 'FORBIDDEN');
  }
});

test('F12 B2: a trusted sender succeeds and a no-event sender is still refused', async () => {
  const { service } = await realService([pitchRec()]);
  const { invoke } = harness(service, { trusted: true });
  assert.equal((await invoke('lead-intel:outreach-list', {}, { senderFrame: { url: 'file://app/index.html' } })).ok, true);
  // The registrar's own default check, exercised for real. It requires the invoking
  // frame to BE the main frame (same object), so a subframe, a foreign origin and a
  // missing event are all refused.
  const { makeIsTrustedSender } = require('../../src/main/lead-intelligence/ipc/registerLeadIntelligenceIpc');
  const isTrusted = makeIsTrustedSender({ allowedUrlPrefixes: ['file://'] });
  const mainFrame = { url: 'file://app/index.html' };
  assert.equal(isTrusted({ senderFrame: mainFrame, sender: { mainFrame } }), true, 'the app main frame is trusted');
  assert.equal(isTrusted({ senderFrame: { url: 'https://evil.example/' }, sender: { mainFrame: { url: 'file://app/index.html' } } }), false, 'a foreign origin is refused');
  assert.equal(isTrusted({ senderFrame: { url: 'file://app/child.html' }, sender: { mainFrame } }), false, 'a subframe is refused even on an allowed origin');
  assert.equal(isTrusted({}), false, 'a missing event is refused');
  assert.equal(isTrusted({ senderFrame: { url: 'file://app/index.html' } }), true, 'the origin check stands alone when there is no sender');
  // Wrong origin prefix set entirely.
  const strict = makeIsTrustedSender({ allowedUrlPrefixes: ['app://ztech'] });
  assert.equal(strict({ senderFrame: { url: 'file://app/index.html' } }), false);
  assert.throws(() => makeIsTrustedSender({ allowedUrlPrefixes: [] }), /allowedUrlPrefixes is required/);
});

// --- 9-12. the live preload surface ---------------------------------------------

test('F12 B2: preload exposes outreach.list and no email.send', () => {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  const invoked = [...source.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const leadIntel = invoked.filter((c) => c.startsWith('lead-intel:'));
// F15/F16 declared lock update: EXACT allowlist of eight - a ninth or a substitution fails here.
    // F18 declared lock update: + the single read-only prepare method, so the exact set is now nine.
    // F19 declared lock update: + the single send boundary, so the exact set is now ten.
    // F21 declared lock update: + the single read-only send-ledger read, so the exact set is now eleven.
    // Phase I2: + 7 Opportunity Intelligence channels, so the exact set is now eighteen.
    const OI_CHANNELS = [
      'lead-intel:opportunity-associations',
      'lead-intel:opportunity-engine',
      'lead-intel:opportunity-health',
      'lead-intel:opportunity-latest',
      'lead-intel:opportunity-pitch-context',
      'lead-intel:opportunity-pitch-preview', // I7 declared lock update
      'lead-intel:opportunity-report',
      'lead-intel:opportunity-request',
    ];
    const EXPECTED = [...PREVIOUS_FIVE, 'lead-intel:outreach-list', 'lead-intel:outreach-activity', 'lead-intel:outreach-prepare', 'lead-intel:outreach-ready', 'lead-intel:outreach-send', 'lead-intel:outreach-sends', ...OI_CHANNELS, 'lead-intel:timeline', 'lead-intel:trust-consent', 'lead-intel:trust-handoff', 'lead-intel:trust-lead', 'lead-intel:trust-lift', 'lead-intel:trust-review', 'lead-intel:trust-suppress', 'lead-intel:market-rule-remove', 'lead-intel:market-rule-set', 'lead-intel:market-rules', 'lead-intel:mailbox-connect', 'lead-intel:mailbox-default', 'lead-intel:mailbox-disconnect', 'lead-intel:mailbox-google-client', 'lead-intel:mailbox-limits', 'lead-intel:mailbox-list', 'lead-intel:mailbox-capabilities', 'lead-intel:mailbox-check', 'lead-intel:mailbox-replies'].sort(); // I6 declared lock update: + timeline; F26.5: + five trust channels; F26.6: + twelve mailbox channels
    assert.deepEqual(leadIntel.slice().sort(), EXPECTED);
    assert.equal(leadIntel.length, 38); // F26.6 declared lock update: 25 -> 37; follow-up + trust-review = 38
    assert.equal(leadIntel.filter((c) => /send/.test(c)).length, 2, 'the send boundary and its ledger read exist; exactly one sends');
    assert.ok(leadIntel.includes('lead-intel:outreach-list'), 'outreach.list must be exposed');
    assert.ok(!leadIntel.includes('lead-intel:email-send'), 'email.send must never be exposed');

  const block = source.slice(source.indexOf("exposeInMainWorld('ztechLeadIntel'"));
  assert.ok(/outreach:\s*Object\.freeze\(\{[\s\S]*?\blist:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('lead-intel:outreach-list'/.test(block),
    'list must live in the frozen outreach namespace and hit only the fixed channel');
  assert.ok(!/email\s*:/.test(block), 'no email namespace is exposed');
  // No generic forwarding escape hatch.
  assert.ok(!/exposeInMainWorld\([^)]{0,80}ipcRenderer/.test(source), 'ipcRenderer is never exposed directly');
  assert.ok(!/\bsend\s*:/.test(block), 'no send method is exposed');
  assert.ok(!/\b(eval|Function|require)\s*\(/.test(block), 'the block evaluates nothing and requires nothing');
});

test('F12 B2: the five pre-existing preload methods are untouched', () => {
  const source = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
  for (const [ns, method, channel] of [
    ['pitch', 'generate', 'lead-intel:pitch-generate'],
    ['pitch', 'get', 'lead-intel:pitch-get'],
    ['pitch', 'update', 'lead-intel:pitch-update'],
    ['outreach', 'approve', 'lead-intel:outreach-approve'],
    ['outreach', 'gate', 'lead-intel:outreach-gate'],
  ]) {
    const re = new RegExp(`${ns}:\\s*Object\\.freeze\\(\\{[\\s\\S]*?${method}:\\s*\\(payload\\)\\s*=>\\s*ipcRenderer\\.invoke\\('${channel}'`);
    assert.ok(re.test(source), `${ns}.${method} must still invoke ${channel}`);
  }
  // appAPI, the pre-existing renderer surface, is unchanged in shape by this batch.
  assert.ok(/exposeInMainWorld\('appAPI'/.test(source));
  assert.ok(!/exposeInMainWorld\('ztechLeadIntel'[\s\S]*exposeInMainWorld\(/.test(source), 'no second Lead Intelligence key');
});

test('F12 B2: the registrar refuses to start without a list-capable outreach service', () => {
  const ipcMain = { handle() {}, removeHandler() {} };
  // The five previous channels' guard still applies.
  assert.throws(() => registerOutreachIpc({ ipcMain, isTrustedSender: () => true }), /outreach service is required/);
  // A service with generate but no list would register a channel that only fails at
  // invoke time, so it is refused up front instead.
  assert.throws(() => registerOutreachIpc({
    ipcMain, isTrustedSender: () => true,
    outreach: { generate: async () => ({}) },
  }), /must implement list/);
});

test('F12 B2: list is read-only - it never writes, generates, approves or gates', async () => {
  const store = new MemoryStore();
  await store.pitches.upsert(pitchRec());
  const touched = [];
  const service = new OutreachService({
    store,
    contexts: new Proxy({}, { get: (_t, k) => { touched.push('contexts.' + String(k)); throw new Error('contexts must not be used'); } }),
    leadSource: { getLead: async () => { touched.push('leadSource.getLead'); throw new Error('leadSource must not be used'); } },
    freshness: {},
    fieldMap: undefined,
    config: {},
  });
  const before = await service.list({});
  await service.list({ limit: 10, status: 'draft' });
  // Nothing but the pitch store was touched, and the rows are unchanged.
  assert.deepEqual(touched, []);
  assert.equal(await store.pitches.latestForLead('L1').then((p) => p.content_hash), 'hash_1');
  assert.equal((await service.list({})).total, before.total);
  for (const method of ['generate', 'update', 'approve', 'gate', 'send']) {
    assert.equal(before[method], undefined, 'list must not return any mutation surface');
  }
});
