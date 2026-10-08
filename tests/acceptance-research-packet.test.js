'use strict';

// Windows acceptance bug #2 (8 Oct 2026): research showed "Complete, 40 facts / 19 findings" but
// the pitch stayed evidence-free even after Regenerate. Root cause: a real Round-1 record stores the
// prospect-research gateway's OWN normalised packet (packetVersion 1: provenance, sections, issues,
// notMeasured ...). The Round-1 bridge's mapper knew only the raw Zuni-SEO v1 envelope and the
// legacy flat dialect, sent this one down the flat path and refused it ("Envelope has no contract
// version" -> MALFORMED_RESULT), so no evidence packet was ever stored.
//
// These tests build the record with the REAL prospect-research bundle (artifact import of a valid
// Zuni-SEO v1 envelope -> the exact record shape the app stores), then run the real Lead
// Intelligence runtime, the real outreach IPC and the real F11 Pitch tab. No network.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const bundle = require(path.join(root, 'src', 'main', 'prospect-research', 'prospect-research.cjs'));
const { mergeConfig } = require(path.join(root, 'src', 'main', 'prospect-research', 'research-service.js'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(LI, 'index.js'));
const { round1PacketMapper, detectDialect } = require(path.join(LI, 'round1PacketMapper.js'));
const { normalizeRound1Record } = require(path.join(LI, 'research', 'Round1ResearchBridge.js'));
const { registerOutreachIpc } = require(path.join(LI, 'outreach-ipc.js'));
const { lead, OFFER, SILENT } = require('./f265-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const DOMAIN = 'acme.example.com';

/** A valid Zuni-SEO Evidence Envelope v1, as Zuni-SEO returns it (the bundle validates it). */
function envelope(capturedAt, { runStatus = 'done', content = 'complete', contentReason = null, basis = null } = {}) {
  const url = `https://www.${DOMAIN}/`;
  const hash = (n) => 'sha256:' + String(n).repeat(64);
  const fact = (id, statement, value) => ({ fact_id: id, statement, value, unit: null, basis: 'observed',
    source: { type: 'crawl_page', url, fetch_time: capturedAt, response_hash: hash(id.slice(-1)), excerpt: null } });
  return {
    contract_version: '1.0',
    subject: { requested_url: url, audited_url: url, domain: `www.${DOMAIN}`, redirected_from: null,
      identity: { title: 'Acme home', site_name: 'Acme', org_name: null } },
    run: { job_id: 'job_00000000000000a1', status: runStatus, depth: 'standard', max_pages: 40, engine_version: '2.3.0',
      requested_at: capturedAt, finished_at: capturedAt, captured_at: capturedAt,
      crawl: { pages_fetched: 14, html_pages: 14, discovered_urls: 20, coverage_limited: false, rendering_mode: 'raw' } },
    completeness: { technical: { status: 'complete', reason: null }, ai_access: { status: 'complete', reason: null },
      content: { status: content, reason: contentReason } },
    facts: [fact('f001', 'Homepage responded with HTTP 200', 200), fact('f002', 'Pages without a meta description', 4), fact('f003', 'Server response time (s)', 2.4)],
    findings: [
      { finding_id: 'meta_description_missing', rule_version: '2.3.0', area: 'meta', section: 'content', severity: 'medium', basis: basis || 'standard',
        title: 'Pages without a meta description', observation: '4 of 14 pages have no meta description.', affected_urls: [url], affected_url_count: 4,
        fact_ids: ['f002'], recommendation: 'Write a unique meta description for each page.', what_it_means: 'Search results show less useful snippets.' },
      { finding_id: 'slow_server_response', rule_version: '2.3.0', area: 'performance', section: 'technical', severity: 'high', basis: basis || 'research',
        title: 'Slow server response time', observation: 'The server took 2.4s to respond.', affected_urls: [url], affected_url_count: 1,
        fact_ids: ['f003'], recommendation: 'Investigate hosting response time.', what_it_means: null },
    ],
    strengths: [{ strength_id: 's_ok', area: 'http', section: 'technical', statement: 'The homepage answers with HTTP 200.', fact_ids: ['f001'] }],
    not_measured: [{ item: 'backlinks', reason: 'No third-party data source.' }],
    limits: ['Only the first 40 pages were crawled.'],
    links: null,
  };
}

/** The exact record the app stores in prospect_research.record_json, made by the real bundle. */
async function realRound1Record(leadRef, capturedAt = iso(NOW - 3600000), opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-acc-'));
  const store = new bundle.InMemoryResearchStateStore();
  const engine = bundle.createProspectResearch(mergeConfig({}), { store, quarantine: new bundle.InMemoryQuarantine(), credentials: { getApiKey: async () => null }, log: () => {} });
  const file = path.join(tmp, 'envelope.json');
  fs.writeFileSync(file, JSON.stringify(envelope(capturedAt, opts)));
  await engine.gateway.importArtifact(leadRef, file);
  const rec = await store.latestForLead(leadRef);
  await engine.close();
  return JSON.parse(JSON.stringify(rec)); // as stored (record_json)
}

function runtime() {
  const store = new MemoryStore();
  const leads = { L1: lead({ website: `https://www.${DOMAIN}/` }) };
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
  });
  const handlers = {};
  registerOutreachIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, outreach: li.outreach, isTrustedSender: () => true, logger: SILENT });
  return { li, store, records, ipc: (c, p) => handlers[c]({}, p) };
}
const gateCodes = (g) => g.reasons.map((r) => r.code);

/* ============================ the mapper ============================ */

test('M1. the stored Round-1 packet is recognised as its own dialect and maps without loss', async () => {
  const rec = await realRound1Record('L1');
  assert.strictEqual(rec.packet.packetVersion, 1, 'the real bundle stores its normalised packet');
  assert.ok(Array.isArray(rec.packet.issues) && rec.packet.provenance, 'issues + provenance, no contract_version at the top');
  assert.strictEqual(rec.packet.contract_version, undefined);
  assert.strictEqual(detectDialect(rec.packet), 'round1-packet');
  const result = round1PacketMapper(normalizeRound1Record(rec), { requestedDomain: `www.${DOMAIN}`, providerJobId: rec.providerJobId || rec.id });
  assert.strictEqual(result.outcome, 'complete');
  assert.strictEqual(result.facts.length, 3);
  assert.strictEqual(result.findings.length, 2);
  assert.deepStrictEqual(result.facts.map((f) => f.key).sort(), ['f001', 'f002', 'f003'], 'the fact id stays the fact key');
  assert.deepStrictEqual(result.findings.map((g) => g.factKeys).flat().sort(), ['f002', 'f003'], 'findings keep their fact references');
  assert.ok(result.findings.every((g) => ['standard', 'research'].includes(g.basis)));
  assert.strictEqual(result.areas.technical, 'measured', 'section state complete -> area measured');
  assert.strictEqual(result.areas.content, 'measured');
});

test('M3. a stored packet without a recorded contract version is named as a Round-1 packet, never left blank', async () => {
  const rec = await realRound1Record('L1');
  delete rec.packet.provenance.contractVersion;
  const result = round1PacketMapper(normalizeRound1Record(rec), { requestedDomain: `www.${DOMAIN}` });
  assert.strictEqual(result.contractVersion, 'round1.packet/1');
  assert.strictEqual(result.engineVersion, '2.3.0');
});

test('M2. the older dialects still map exactly as before (no regression)', () => {
  const { round1Record, zuniV1Packet } = require('./lead-intelligence/fixtures/round1Record.js');
  const r = round1Record({ id: 'r1', leadRef: 'L1', domain: DOMAIN, providerJobId: 'j1', packet: zuniV1Packet({ domain: DOMAIN, capturedAt: iso(NOW) }), createdAt: iso(NOW), updatedAt: iso(NOW) });
  assert.strictEqual(detectDialect(r.packet), 'zuni-v1');
  assert.ok(round1PacketMapper(normalizeRound1Record(r), { requestedDomain: DOMAIN }).facts.length > 0);
  assert.strictEqual(detectDialect({ coverage: {}, issues: [] }), 'flat', 'without packetVersion + provenance it is not the new dialect');
  assert.strictEqual(detectDialect({ packetVersion: 1, provenance: {} }), 'unknown', 'no issues[] -> not guessed');
});

/* ============================ the real stale-draft scenario ============================ */

test('1-10. lead -> pitch before research -> real Round-1 research stored -> Regenerate -> evidence-backed draft, gate needs only approval', async () => {
  const r = runtime();
  // 1-2. the lead exists; a pitch is drafted before research.
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  assert.strictEqual(stale.status, 'insufficient_evidence');
  assert.strictEqual(stale.packet_id, null);
  // 3. completed research + evidence is stored exactly as the app stores it.
  r.records.push(await realRound1Record('L1'));
  // 4. regenerate (through the real IPC channel the Pitch tab uses).
  const res = await r.ipc('lead-intel:pitch-regenerate', { leadId: 'L1', pitchId: stale.pitch_id });
  assert.strictEqual(res.ok, true, JSON.stringify(res.error));
  const current = await r.li.outreach.latestForLead('L1');
  assert.strictEqual(current.pitch_id, stale.pitch_id);
  // 5. the persisted current pitch has evidence refs.
  const packet = await r.store.packets.latestForLead('L1');
  assert.ok(packet, 'the Round-1 result became a stored evidence packet');
  assert.strictEqual(current.packet_id, packet.packet_id);
  assert.ok(current.evidenceReferences.length > 0);
  // 6. observations > 0.
  assert.ok(current.observations.length > 0);
  assert.ok(current.observations.every((o) => o.refs.length > 0), 'every observation cites evidence');
  // 7. research state is complete and fresh.
  assert.strictEqual(current.research_status, 'complete');
  assert.strictEqual(current.status, 'draft');
  // 8. the gate has only HUMAN_APPROVAL.
  assert.deepStrictEqual(gateCodes(await r.li.outreach.gate({ pitchId: current.pitch_id })), ['HUMAN_APPROVAL']);
  // 10. the old stale draft is unsendable: its content is stored nowhere, and approving now
  // approves the evidence-backed content only.
  assert.ok([...r.store.pitches.rows.values()].every((p) => p.content_hash !== stale.content_hash));
  await r.li.outreach.approve({ pitchId: current.pitch_id });
  assert.strictEqual((await r.li.outreach.gate({ pitchId: current.pitch_id })).decision, 'allowed');
});

test('9. the real Pitch tab: after Regenerate, the draft shows evidence and "Approve pitch" is enabled', async () => {
  const r = runtime();
  const stale = await r.li.outreach.generate({ leadId: 'L1' });
  r.records.push(await realRound1Record('L1'));
  const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const F11 = rendererSource.slice(rendererSource.indexOf('// === F11 Outreach: Lead Drawer Pitch tab ==='), rendererSource.indexOf('// === F13 Outreach: human approval of one pitch ==='));
  class El {
    constructor(t) { this.tagName = String(t).toUpperCase(); this.children = []; this.attributes = {}; this.dataset = {}; this.className = ''; this._text = ''; this.listeners = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.type = ''; }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    set textContent(v) { this._text = String(v); this.children = []; }
    appendChild(c) { this.children.push(c); return c; }
    replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
    fire(t) { for (const fn of this.listeners[t] || []) fn({}); }
    all() { return this.children.flatMap((c) => [c, ...c.all()]); }
  }
  const els = {};
  const document = { getElementById: (id) => (els[id] = els[id] || new El('div')), createElement: (t) => new El(t), createTextNode: (t) => Object.assign(new El('#text'), { _text: String(t) }) };
  const call = (c) => async (p) => r.ipc(c, p || {});
  const api = {
    pitch: { generate: call('lead-intel:pitch-generate'), get: call('lead-intel:pitch-get'), update: call('lead-intel:pitch-update'), regenerate: call('lead-intel:pitch-regenerate') },
    outreach: { gate: call('lead-intel:outreach-gate'), approve: call('lead-intel:outreach-approve'), activity: call('lead-intel:outreach-activity') },
  };
  const ui = new Function('window', 'document', F11 + '\nreturn { loadLeadDrawerPitch };')({ ztechLeadIntel: api }, document);
  const box = () => els['lead-drawer-pitch'];
  const button = (label) => box().all().find((e) => e.tagName === 'BUTTON' && e.textContent === label) || null;
  const settle = async () => { for (let i = 0; i < 60; i += 1) await new Promise((res) => setImmediate(res)); };
  await ui.loadLeadDrawerPitch({ id: 'L1', website: `https://www.${DOMAIN}/` });
  assert.strictEqual(button('Approve pitch').disabled, true, 'the stale draft cannot be approved');
  button('Regenerate from latest research').fire('click');
  button('Yes, regenerate').fire('click');
  await settle();
  const text = box().textContent;
  assert.ok(!/Research state unknown/.test(text), 'the research state is known now');
  assert.ok(!/No stored research evidence for this lead yet/.test(text));
  assert.ok(!/This pitch has no evidence-backed observations/.test(text));
  assert.ok(/Slow server response time/.test(text), 'an evidence-backed observation is shown');
  assert.strictEqual(button('Approve pitch').disabled, false, 'Approve pitch is enabled');
  assert.ok(/Human approval/.test(text) && !/Evidence link/.test(text), 'the gate asks only for approval');
  assert.strictEqual(await r.store.approvals.latestForPitch(stale.pitch_id), null, 'nothing was approved by Regenerate');
});

test('Q1. a section that did not complete is never cited, and is named; a failed run stays failed', async () => {
  // Run done, content section partial: content findings are not usable for claims.
  const rec = await realRound1Record('L1', iso(NOW - 3600000), { content: 'partial', contentReason: 'Page limit reached' });
  const result = round1PacketMapper(normalizeRound1Record(rec), { requestedDomain: `www.${DOMAIN}` });
  assert.ok(!result.findings.some((g) => /meta description/i.test(g.title)), 'the content finding is not offered');
  assert.ok(result.findings.some((g) => /Slow server/.test(g.title)), 'the technical finding (complete section) still is');
  assert.ok(result.limitations.some((l) => l.code === 'ROUND1_SECTION_NOT_USABLE' && /content/.test(l.message)));
  const r = runtime();
  r.records.push(rec);
  const p = await r.li.outreach.generate({ leadId: 'L1' });
  assert.ok(p.observations.every((o) => !/meta description/i.test(o.text)), 'the pitch never cites it');
  // An item WITHOUT the gateway flag from a section that did not complete is not trusted either.
  const unflagged = JSON.parse(JSON.stringify(rec));
  for (const g of unflagged.packet.issues) delete g.usableForClaims;
  const r2 = round1PacketMapper(normalizeRound1Record(unflagged), { requestedDomain: `www.${DOMAIN}` });
  assert.ok(!r2.findings.some((g) => /meta description/i.test(g.title)));
  assert.ok(r2.findings.some((g) => /Slow server/.test(g.title)));
  // And the gateway's own "not usable" flag is honoured even where the section state says complete.
  const full = await realRound1Record('L1');
  full.packet.issues.find((g) => /Slow server/.test(g.title)).usableForClaims = false;
  const r3 = round1PacketMapper(normalizeRound1Record(full), { requestedDomain: `www.${DOMAIN}` });
  assert.ok(!r3.findings.some((g) => /Slow server/.test(g.title)));
  // A run Zuni-SEO reported as failed is a failed outcome, not partial.
  const failedRec = await realRound1Record('L1', iso(NOW - 3600000), { runStatus: 'failed' });
  assert.strictEqual(failedRec.packet.availability, 'failed');
  assert.strictEqual(round1PacketMapper(normalizeRound1Record(failedRec), { requestedDomain: `www.${DOMAIN}` }).outcome, 'failed');
});

test('Q2. findings whose basis is only "observed" map fine but give the pitch nothing to cite (existing eligibility rule, stated)', async () => {
  const rec = await realRound1Record('L1', iso(NOW - 3600000), { basis: 'observed' });
  const r = runtime();
  r.records.push(rec);
  const p = await r.li.outreach.generate({ leadId: 'L1' });
  assert.ok(p.packet_id, 'the evidence packet IS stored');
  assert.strictEqual(p.observations.length, 0, 'but the pitch only cites standard / research findings');
  assert.strictEqual(p.status, 'insufficient_evidence');
});

test('B1. a record in a dialect nobody knows is still refused (never guessed), so a pitch stays honestly evidence-free', async () => {
  const r = runtime();
  const rec = await realRound1Record('L1');
  rec.packet = { packetVersion: 1, provenance: rec.packet.provenance, facts: rec.packet.facts }; // no issues[] -> unknown
  r.records.push(rec);
  const p = await r.li.outreach.generate({ leadId: 'L1' });
  assert.strictEqual(p.packet_id, null);
  assert.strictEqual(p.status, 'insufficient_evidence');
  assert.strictEqual(await r.store.packets.latestForLead('L1'), null);
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
