'use strict';

// Windows acceptance bug (8 Oct 2026): a pitch drafted BEFORE research finished stayed
// "insufficient evidence" forever - the Pitch tab offered no way to rebuild it, and the gate
// stayed blocked on EVIDENCE_PRESENT. Fix: "Regenerate from latest research" rebuilds an
// UNAPPROVED, UNSENT draft in place from the latest stored research. Real LeadIntelligence,
// real MemoryStore, real outreach IPC handlers and the REAL F11 renderer block. No network.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(LI, 'index.js'));
const { round1PacketMapper } = require(path.join(LI, 'round1PacketMapper.js'));
const { registerOutreachIpc } = require(path.join(LI, 'outreach-ipc.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));
const { lead, OFFER, SILENT, NOW, CAPTURED_AT } = require('./f265-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** A runtime whose Round-1 research can be "finished" mid-test (records start empty). */
function runtime(store = new MemoryStore()) {
  const leads = { L1: lead({}) };
  const records = [];
  const li = createLeadIntelligence({
    store,
    leadSource: { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) },
    round1: {
      async getLatest(id) { return records.filter((r) => r.leadRef === id).at(-1) || null; },
      async listByLead(id) { return records.filter((r) => r.leadRef === id); },
      async listLatestPerLead() { return new Map(records.map((r) => [r.leadRef, r])); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer: OFFER,
    },
    clock: () => new Date(NOW),
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
  });
  const finishResearch = (n = 1) => {
    const domain = 'acme.example.com';
    const at = new Date(Date.parse(CAPTURED_AT) + (n - 1) * 3600000).toISOString(); // each run is newer
    records.push(round1Record({
      id: `rec_L1_${n}`, leadRef: 'L1', domain, providerJobId: `job_L1_${n}`,
      packet: zuniV1Packet({ domain, capturedAt: at }), createdAt: at, updatedAt: at,
    }));
  };
  const handlers = {};
  registerOutreachIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, outreach: li.outreach, isTrustedSender: () => true, logger: SILENT });
  const ipc = (channel, payload) => handlers[channel]({}, payload);
  return { li, store, finishResearch, ipc, handlers };
}

const gateCodes = (g) => g.reasons.map((r) => r.code);

/* ============================ backend path ============================ */

test('1-8. no research -> draft is insufficient; research completes -> Regenerate gives an evidence-backed draft that still needs approval', async () => {
  const r = runtime();
  // 1-2. a lead with no research: the draft has no evidence.
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  assert.strictEqual(stale.status, 'insufficient_evidence');
  assert.strictEqual(stale.packet_id, null);
  assert.strictEqual(stale.research_status, null, 'what the Pitch tab shows as "Research state unknown"');
  assert.deepStrictEqual(stale.observations, []);
  let g = await r.li.outreach.gate({ pitchId: stale.pitch_id });
  assert.ok(gateCodes(g).includes('EVIDENCE_PRESENT'));
  // 3. research completes and is stored.
  r.finishResearch();
  // The stale draft does NOT fix itself (that was the acceptance bug): it still has no evidence.
  assert.strictEqual((await r.li.outreach.get(stale.pitch_id)).packet_id, null);
  // 4. regenerate.
  const fresh = await r.li.outreach.regenerate({ pitchId: stale.pitch_id });
  // 5. the current draft references the stored evidence, in place (same pitch id).
  assert.strictEqual(fresh.pitch_id, stale.pitch_id, 'rebuilt in place: the stale text no longer exists');
  assert.strictEqual(fresh.created_at, stale.created_at);
  const latest = await r.store.packets.latestForLead('L1');
  assert.ok(latest, 'research was stored as an evidence packet');
  assert.strictEqual(fresh.packet_id, latest.packet_id);
  assert.strictEqual(fresh.research_status, 'complete');
  assert.ok(fresh.evidenceReferences.length > 0);
  // 6. observations > 0.
  assert.ok(fresh.observations.length > 0);
  assert.strictEqual(fresh.status, 'draft');
  assert.deepStrictEqual(await r.li.outreach.latestForLead('L1'), fresh, 'the drawer re-reads the regenerated draft');
  assert.strictEqual(r.store.pitches.rows ? [...r.store.pitches.rows.values()].filter((p) => p.lead_id === 'L1').length : 1, 1, 'no second draft was added');
  // 7. the gate's evidence checks pass; 8. approval is still required.
  g = await r.li.outreach.gate({ pitchId: fresh.pitch_id });
  for (const code of ['EVIDENCE_PRESENT', 'EVIDENCE_OUTDATED', 'EVIDENCE_FRESH', 'EVIDENCE_COMPLETE', 'PITCH_INTEGRITY']) assert.ok(!gateCodes(g).includes(code), code);
  assert.deepStrictEqual(gateCodes(g), ['HUMAN_APPROVAL'], 'only the human approval is missing');
  await r.li.outreach.approve({ pitchId: fresh.pitch_id });
  assert.strictEqual((await r.li.outreach.gate({ pitchId: fresh.pitch_id })).decision, 'allowed');
});

test('9. the old stale draft can never be sent: its text is gone, and an approved or sent pitch is never rewritten', async () => {
  const r = runtime();
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  r.finishResearch();
  const fresh = await r.li.outreach.regenerate({ pitchId: stale.pitch_id });
  assert.notStrictEqual(fresh.content_hash, stale.content_hash);
  const all = [...r.store.pitches.rows.values()].filter((p) => p.lead_id === 'L1');
  assert.ok(all.every((p) => p.content_hash !== stale.content_hash), 'the stale content is stored nowhere');
  // An approved pitch whose research is current is not rewritten.
  await r.li.outreach.approve({ pitchId: fresh.pitch_id });
  await assert.rejects(r.li.outreach.regenerate({ pitchId: fresh.pitch_id }), (e) => e.code === 'PITCH_APPROVED');
  assert.strictEqual((await r.li.outreach.get(fresh.pitch_id)).content_hash, fresh.content_hash, 'unchanged');
  // Editing withdraws the approval; then it may be regenerated, and needs a NEW approval.
  const edited = await r.li.outreach.update({ pitchId: fresh.pitch_id, edits: { callToAction: 'Different words for a call?' } });
  assert.notStrictEqual(edited.content_hash, fresh.content_hash);
  const again = await r.li.outreach.regenerate({ pitchId: fresh.pitch_id });
  assert.strictEqual(again.packet_id, (await r.store.packets.latestForLead('L1')).packet_id, 'built from the newest research');
  // Even when the rebuilt text equals content approved earlier, a regenerated draft needs a NEW approval.
  assert.strictEqual(again.content_hash, fresh.content_hash, 'same research content -> same text as the earlier approval');
  assert.ok(gateCodes(await r.li.outreach.gate({ pitchId: again.pitch_id })).includes('HUMAN_APPROVAL'), 'approval is required again');
  assert.strictEqual(await r.store.approvals.latestForPitch(again.pitch_id), null, 'earlier approvals were withdrawn');
  assert.ok(await r.store.activity.latestForPitch(again.pitch_id, 'APPROVAL_INVALIDATED'), 'and that is recorded');
  // A pitch with a recorded send attempt is history and is never rewritten.
  await r.store.sends.record({
    send_id: 'send_x1', lead_id: 'L1', pitch_id: again.pitch_id, channel: 'email', content_hash: again.content_hash, idempotency_key: 'k1',
    state: 'attempted', provider_id: 'gmail', provider_message_id: null, failure_code: null, failure_message: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString(),
  });
  await assert.rejects(r.li.outreach.regenerate({ pitchId: again.pitch_id }), (e) => e.code === 'PITCH_ALREADY_SENT');
  await assert.rejects(r.li.outreach.regenerate({ pitchId: 'pitch_missing' }), (e) => e.code === 'NOT_FOUND');
});

test('I1. the regenerate channel: closed schema, the pitch must belong to the lead, refusals carry a code', async () => {
  const r = runtime();
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  r.finishResearch();
  const C = 'lead-intel:pitch-regenerate';
  assert.strictEqual((await r.ipc(C, { pitchId: stale.pitch_id })).ok, false, 'leadId is required');
  assert.strictEqual((await r.ipc(C, { leadId: 'L1' })).ok, false, 'pitchId is required');
  assert.strictEqual((await r.ipc(C, { leadId: 'L1', pitchId: stale.pitch_id, approve: true })).ok, false, 'no extra keys');
  const other = await r.ipc(C, { leadId: 'L2', pitchId: stale.pitch_id });
  assert.strictEqual(other.ok, false);
  assert.strictEqual(other.error.code, 'NOT_FOUND', 'another lead cannot rewrite this pitch');
  assert.strictEqual((await r.li.outreach.get(stale.pitch_id)).packet_id, null, 'nothing changed');
  const res = await r.ipc(C, { leadId: 'L1', pitchId: stale.pitch_id });
  assert.strictEqual(res.ok, true);
  assert.ok(res.data.observations.length > 0);
  assert.strictEqual(await r.store.approvals.latestForPitch(stale.pitch_id), null, 'regenerate never approves');
});

test('F1. a follow-up step (F28) is never regenerated here: it belongs to its sequence', async () => {
  const h = require('./f28-harness');
  const s = await h.setup();
  await h.firstEmail(s);
  const view = await s.sequences.create({ leadId: 'L1', delays: [3] });
  const stepPitch = view.steps[0].pitchId;
  const before = await s.li.outreach.get(stepPitch);
  await assert.rejects(s.li.outreach.regenerate({ pitchId: stepPitch }), (e) => e.code === 'PITCH_REGENERATE_FOLLOWUP');
  assert.strictEqual((await s.li.outreach.get(stepPitch)).content_hash, before.content_hash, 'unchanged');
  // The first email itself was sent, so it is history too.
  const first = await s.li.outreach.latestForLead('L1');
  await assert.rejects(s.li.outreach.regenerate({ pitchId: first.pitch_id }), (e) => e.code === 'PITCH_ALREADY_SENT');
});

test('O1. an APPROVED pitch with newer research (EVIDENCE_OUTDATED) can be regenerated explicitly; the approval is withdrawn', async () => {
  const r = runtime();
  r.finishResearch();
  const p = await r.li.outreach.generate({ leadId: 'L1' });
  await r.li.outreach.approve({ pitchId: p.pitch_id });
  r.finishResearch(2);
  const g = await r.li.outreach.gate({ pitchId: p.pitch_id });
  assert.ok(gateCodes(g).includes('EVIDENCE_OUTDATED') && !gateCodes(g).includes('HUMAN_APPROVAL'));
  const t = tab(r);
  await t.ui.loadLeadDrawerPitch({ id: 'L1', website: 'https://acme.example.com' });
  t.button('Regenerate from latest research').fire('click');
  assert.ok(/WITHDRAWS your approval/.test(t.box().textContent));
  t.button('Yes, regenerate').fire('click');
  await settle();
  const after = await r.li.outreach.get(p.pitch_id);
  assert.strictEqual(after.packet_id, (await r.store.packets.latestForLead('L1')).packet_id, 'rebuilt from the newest research');
  assert.strictEqual(await r.store.approvals.latestForPitch(p.pitch_id), null, 'the approval was withdrawn');
  assert.deepStrictEqual(gateCodes(await r.li.outreach.gate({ pitchId: p.pitch_id })), ['HUMAN_APPROVAL']);
  assert.ok(await r.store.activity.latestForPitch(p.pitch_id, 'APPROVAL_INVALIDATED'));
});

test('R1. race: an approve or a send that lands while the draft is rebuilt makes Regenerate refuse - nothing sent is ever rewritten', async () => {
  const r = runtime();
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  r.finishResearch();
  const real = r.li.outreach.contexts.getContext.bind(r.li.outreach.contexts);
  // A send attempt is recorded while regenerate is reading the research.
  let once = true;
  r.li.outreach.contexts.getContext = async (...a) => {
    if (once) once = false; else return real(...a);
    await r.store.sends.record({ send_id: 'send_r1', lead_id: 'L1', pitch_id: stale.pitch_id, channel: 'email', content_hash: stale.content_hash, idempotency_key: 'kr1', state: 'attempted', provider_id: 'gmail', provider_message_id: null, failure_code: null, failure_message: null, created_at: new Date(NOW).toISOString(), updated_at: new Date(NOW).toISOString() });
    return real(...a);
  };
  await assert.rejects(r.li.outreach.regenerate({ pitchId: stale.pitch_id }), (e) => e.code === 'PITCH_ALREADY_SENT');
  assert.strictEqual((await r.li.outreach.get(stale.pitch_id)).content_hash, stale.content_hash, 'unchanged');
  // An edit that lands mid-rebuild is not overwritten either.
  const r2 = runtime();
  r2.finishResearch();
  const p2 = await r2.li.outreach.generate({ leadId: 'L1' });
  const real2 = r2.li.outreach.contexts.getContext.bind(r2.li.outreach.contexts);
  let once2 = true;
  r2.li.outreach.contexts.getContext = async (...a) => { if (!once2) return real2(...a); once2 = false; await r2.li.outreach.update({ pitchId: p2.pitch_id, edits: { callToAction: 'Edited meanwhile?' } }); return real2(...a); };
  await assert.rejects(r2.li.outreach.regenerate({ pitchId: p2.pitch_id }), (e) => e.code === 'PITCH_CHANGED');
  assert.strictEqual((await r2.li.outreach.get(p2.pitch_id)).callToAction, 'Edited meanwhile?');
  // An approval of the current content that lands mid-rebuild: refused (research is current).
  const r3 = runtime();
  r3.finishResearch();
  const p3 = await r3.li.outreach.generate({ leadId: 'L1' });
  const real3 = r3.li.outreach.contexts.getContext.bind(r3.li.outreach.contexts);
  let once3 = true;
  r3.li.outreach.contexts.getContext = async (...a) => { if (!once3) return real3(...a); once3 = false; await r3.li.outreach.approve({ pitchId: p3.pitch_id }); return real3(...a); };
  await assert.rejects(r3.li.outreach.regenerate({ pitchId: p3.pitch_id }), (e) => e.code === 'PITCH_APPROVED');
  assert.strictEqual((await r3.li.outreach.gate({ pitchId: p3.pitch_id })).decision, 'allowed', 'the approval stands');
});

test('S2. the whole path on the SQL store: packet link and status are stored in the row too', async () => {
  let initSqlJs;
  try { initSqlJs = require('sql.js'); } catch { return; }
  const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore.js'));
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  const store = new SqlJsStore({ db, logger: SILENT });
  await store.migrate();
  const r = runtime(store);
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  r.finishResearch();
  const fresh = await r.li.outreach.regenerate({ pitchId: stale.pitch_id });
  assert.ok(fresh.observations.length > 0);
  const row = db.exec('SELECT packet_id, status, content_hash FROM li_pitch_drafts WHERE pitch_id = ?', [stale.pitch_id])[0].values[0];
  assert.deepStrictEqual(row, [fresh.packet_id, 'draft', fresh.content_hash]);
  assert.deepStrictEqual(gateCodes(await r.li.outreach.gate({ pitchId: fresh.pitch_id })), ['HUMAN_APPROVAL']);
});

test('S1. SQL store: withdrawing approvals of one pitch leaves every other pitch untouched (twin of Memory)', async () => {
  let initSqlJs;
  try { initSqlJs = require('sql.js'); } catch { return; }
  const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore.js'));
  const SQL = await initSqlJs();
  const s = new SqlJsStore({ db: new SQL.Database(), logger: SILENT });
  await s.migrate();
  for (const [id, pid] of [['a1', 'p1'], ['a2', 'p1'], ['a3', 'p2']]) await s.approvals.insert({ approval_id: id, pitch_id: pid, content_hash: 'h', approved_by: 'Zee', approved_at: new Date(NOW).toISOString() });
  await s.approvals.deleteForPitches(['p1']);
  assert.strictEqual(await s.approvals.latestForPitch('p1'), null);
  assert.strictEqual((await s.approvals.latestForPitch('p2')).approval_id, 'a3');
  await s.approvals.deleteForPitches([]);
  assert.strictEqual((await s.approvals.latestForPitch('p2')).approval_id, 'a3');
});

/* ============================ the real Pitch tab ============================ */

const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const F11 = rendererSource.slice(rendererSource.indexOf('// === F11 Outreach: Lead Drawer Pitch tab ==='), rendererSource.indexOf('// === F13 Outreach: human approval of one pitch ==='));

class FakeEl {
  constructor(tag) { this.tagName = String(tag).toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.className = ''; this._text = ''; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.type = ''; }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { throw new Error('innerHTML must not be used'); }
  appendChild(c) { this.children.push(c); return c; }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t) { for (const fn of this.listeners[t] || []) fn({}); }
  all() { return this.children.flatMap((c) => [c, ...c.all()]); }
}
const settle = async () => { for (let i = 0; i < 40; i += 1) await new Promise((res) => setImmediate(res)); };

function tab(r) {
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || new FakeEl('div')), createElement: (t) => new FakeEl(t), createTextNode: (t) => Object.assign(new FakeEl('#text'), { _text: String(t) }) };
  const calls = [];
  const call = (c) => async (p) => { calls.push([c, p]); return r.ipc(c, p || {}); };
  const api = {
    pitch: { generate: call('lead-intel:pitch-generate'), get: call('lead-intel:pitch-get'), update: call('lead-intel:pitch-update'), regenerate: call('lead-intel:pitch-regenerate') },
    outreach: { gate: call('lead-intel:outreach-gate'), approve: call('lead-intel:outreach-approve') },
  };
  const ui = new Function('window', 'document', F11 + '\nreturn { loadLeadDrawerPitch };')({ ztechLeadIntel: api }, document);
  const box = () => els['lead-drawer-pitch'];
  const button = (label) => box().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) || null;
  return { ui, box, button, calls };
}

test('U1. the Pitch tab: a stale draft offers "Regenerate from latest research" (two clicks); the result is evidence-backed and still needs approval', async () => {
  const r = runtime();
  await r.li.outreach.generate({ leadId: 'L1' });
  r.finishResearch();
  const t = tab(r);
  await t.ui.loadLeadDrawerPitch({ id: 'L1', website: 'https://acme.example.com' });
  assert.ok(/Insufficient evidence/.test(t.box().textContent));
  assert.ok(/Regenerate from latest research/.test(t.box().textContent), 'the stuck state now names the way out');
  const regen = t.button('Regenerate from latest research');
  assert.ok(regen);
  regen.fire('click');
  assert.ok(/Unsaved edits on screen are lost, and the new draft must be approved again\./.test(t.box().textContent));
  assert.strictEqual(t.calls.filter((c) => c[0] === 'lead-intel:pitch-regenerate').length, 0, 'the first click only asks');
  t.button('Yes, regenerate').fire('click');
  await settle();
  assert.deepStrictEqual(t.calls.find((c) => c[0] === 'lead-intel:pitch-regenerate')[1].leadId, 'L1');
  const text = t.box().textContent;
  assert.ok(/Draft/.test(text) && !/Insufficient evidence/.test(text), text.slice(0, 200));
  assert.ok(!/This pitch has no evidence-backed observations/.test(text));
  assert.ok(/Human approval/.test(text), 'the gate still asks for a human approval');
  assert.ok(!t.calls.some((c) => c[0] === 'lead-intel:outreach-approve'), 'nothing was approved');
});

test('U2. an approved pitch shows no Regenerate control', async () => {
  const r = runtime();
  r.finishResearch();
  const p = await r.li.outreach.generate({ leadId: 'L1' });
  await r.li.outreach.approve({ pitchId: p.pitch_id });
  const t = tab(r);
  await t.ui.loadLeadDrawerPitch({ id: 'L1', website: 'https://acme.example.com' });
  assert.strictEqual(t.button('Regenerate from latest research'), null);
  assert.ok(/Allowed/.test(t.box().textContent));
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failed += 1; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
