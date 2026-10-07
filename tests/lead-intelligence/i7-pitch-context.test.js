'use strict';

/**
 * I7 - OI -> Pitch integration polish: review-only context and an unsaved preview.
 *
 * Runs the REAL OpportunityIntelligenceService, PitchEvidenceBridge, PitchGenerator,
 * association store (SqlJsStore backing) and the real IPC registrar against a fake OI
 * report service. Nothing here can write a pitch, an approval or an Activity row.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const OP = path.join(LI, 'opportunity');
const { OpportunityIntelligenceService, OI_CONTEXT_EXPIRED, I5_COPY } = require(path.join(OP, 'OpportunityIntelligenceService'));
const { CHANNELS, registerOpportunityIpc } = require(path.join(OP, 'opportunity-ipc'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const fixtures = require('./opportunity-fixtures');

const BASE = 'http://127.0.0.1:8099';
const LEAD = '5';
const DAY = 86400000;
const T0 = Date.parse('2026-10-05T12:00:00.000Z'); // the fixture report's generated_at
const VIEW = { company_name: 'Acme Bakery', domain: 'acmebakery.pk' };
const SILENT = { info() {}, warn() {}, error() {} };

const resp = (status, body) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const reportN = (n, daysAfter = 0) => fixtures.report({
  research_id: `res_2026100${n}120000_abcdef0${n}`,
  snapshot_id: `snap_2026100${n}120000_abcdef0${n}`,
  generated_at: new Date(T0 + daysAfter * DAY).toISOString(),
});

function build({ now = T0 + 2 * DAY, reports = [fixtures.report()], store = new MemoryStore(), down = () => false } = {}) {
  const served = new Map(reports.map((r) => [r.research_id, r]));
  const calls = [];
  const clock = { t: now };
  const svc = new OpportunityIntelligenceService({
    config: { enabled: true, baseUrl: BASE },
    clock: () => new Date(clock.t),
    logger: SILENT,
    associationBacking: store.oiAssociations,
    refreshBacking: store.oiRefreshRequests,
    fetchImpl: async (url, init = {}) => {
      calls.push(`${init.method || 'GET'} ${url}`);
      if (url === `${BASE}/v1/health`) return resp(200, { status: 'ok', schema_version: '1.0', instance_id: null });
      if (down(url)) throw new Error('connect ECONNREFUSED');
      const m = url.match(/\/v1\/reports\/([^/?]+)/);
      if (m) return served.has(m[1]) ? resp(200, served.get(m[1])) : resp(404, { error: 'NOT_FOUND', message: 'no report', retryable: false });
      return resp(404, { error: 'NOT_FOUND' });
    },
  });
  // Associations in report order (oldest first), so the last one is the newest.
  let i = 0;
  for (const r of reports) {
    clock.t = now - (reports.length - i) * 1000;
    svc.associations.assertLeadAssociation({ leadId: LEAD, report: r });
    i += 1;
  }
  clock.t = now;
  return { svc, served, calls, clock, store };
}

test('1. the pitch context and the drawer pick the SAME report, including the older-report walk', async () => {
  const b = build({ reports: [reportN(1), reportN(2, 1)] });
  b.served.delete(reportN(2, 1).research_id);
  const drawer = await b.svc.latestForLead({ leadId: LEAD });
  const ctx = await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  assert.equal(drawer.state, 'older_report');
  assert.equal(ctx.state, 'older_report');
  assert.equal(ctx.source.research_id, drawer.model.research_id);
  assert.equal(ctx.older.message, 'Showing an older report because the latest report is no longer available.');
  assert.equal(ctx.older.missing_newer, 1);
  const net = build({ reports: [reportN(1)], down: (u) => /\/v1\/reports\//.test(u) });
  const c2 = await net.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  assert.equal(c2.state, 'unavailable', 'a network failure is unavailable, never missing');
  const none = build({ reports: [] });
  assert.equal((await none.svc.pitchContextForLead({ leadId: LEAD })).state, 'not_researched');
});

test('2. bridge freshness comes from the one policy: expires 30 days after generated_at', async () => {
  const b = build();
  const ctx = await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  const f = ctx.bridge.packet.freshness;
  assert.equal(f.max_age_days, 30);
  assert.equal(Date.parse(f.expires_at) - Date.parse(f.captured_at), 30 * DAY);
  assert.equal(ctx.freshness.state, 'fresh');
  const src = fs.readFileSync(path.join(OP, 'OpportunityIntelligenceService.js'), 'utf8');
  assert.match(src, /OI_FRESHNESS_POLICY\.EXPIRED_AFTER_DAYS \* 24/, 'the 30 days come from oiFreshness, not a new number');
});

test('3. expired or unknown age: nothing is eligible and the preview is refused with OI_CONTEXT_EXPIRED', async () => {
  for (const [now, label] of [[T0 + 31 * DAY, 'expired'], [T0 - 2 * DAY, 'unknown (future generated_at)']]) {
    const b = build({ now });
    const ctx = await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
    assert.equal(ctx.eligible, false, label);
    assert.equal(ctx.code, OI_CONTEXT_EXPIRED, label);
    assert.equal(ctx.message, I5_COPY.refreshFirst);
    assert.ok(ctx.items.length > 0 && ctx.items.every((x) => x.eligible === false), label);
    const p = await b.svc.previewPitchFromOI({ leadId: LEAD, leadView: VIEW });
    assert.equal(p.available, false);
    assert.equal(p.code, OI_CONTEXT_EXPIRED);
    assert.equal(p.pitch, null);
  }
  const stale = build({ now: T0 + 12 * DAY });
  const s = await stale.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  assert.equal(s.freshness.state, 'stale');
  assert.equal(s.eligible, true, 'stale is labelled but still eligible');
});

test('4. the preview passes freshness THROUGH to the bridge (the old silent drop is fixed)', async () => {
  const b = build();
  const seen = [];
  const orig = b.svc.bridge.bind(b.svc);
  b.svc.bridge = (args) => { seen.push(args.freshness); return orig(args); };
  await b.svc.previewPitchFromOI({ leadId: LEAD, leadView: VIEW, freshness: { staleAfterHours: 48 } });
  assert.deepEqual(seen, [{ staleAfterHours: 48 }]);
});

test('5. eligibility is unchanged: only facts and estimates; no inference, opportunity or sales angle is listed', async () => {
  const b = build();
  const ctx = await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  assert.ok(ctx.items.length > 0);
  for (const it of ctx.items) {
    assert.ok(['fact', 'estimate'].includes(it.claim_kind), it.claim_kind);
    assert.ok(['standard', 'research'].includes(it.basis));
  }
  const ruleOf = new Map(ctx.bridge.packet.findings.map((f) => [f.finding_id, f.rule_id]));
  assert.ok(ctx.items.every((it) => !String(ruleOf.get(it.finding_id)).startsWith('oi.angle.')), 'angles stay in the OI tab');
  const opp = fixtures.report().opportunities || [];
  const titles = ctx.items.map((x) => x.title).join('\n');
  for (const o of opp) if (o.title) assert.ok(!titles.includes(o.title), 'an opportunity is never listed');
  const p = await b.svc.previewPitchFromOI({ leadId: LEAD, leadView: VIEW });
  // Packet ids are minted per bridge call, so match each observation to its finding by title.
  assert.ok(p.pitch.observations.length > 0);
  for (const o of p.pitch.observations) {
    const f = ctx.bridge.packet.findings.find((x) => o.text.startsWith(x.title.slice(0, 40)));
    assert.ok(f, 'each observation comes from a bridged finding: ' + o.text.slice(0, 60));
    assert.ok(['standard', 'research'].includes(f.basis), 'observations rest on facts/estimates only');
  }
});

test('6. every context item carries provenance: research id, generated date, claim kind, basis, evidence ids', async () => {
  const b = build();
  const ctx = await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
  assert.deepEqual(Object.keys(ctx.source).sort(), ['generated_at', 'research_id', 'snapshot_id']);
  for (const it of ctx.items) {
    assert.deepEqual(Object.keys(it).sort(), ['basis', 'claim_kind', 'eligible', 'evidence_ids', 'finding_id', 'observed', 'title']);
    assert.ok(it.evidence_ids.length > 0, 'every item rests on evidence');
  }
});

test('7. read-only: database bytes identical after 50 context reads and 50 previews', { skip }, async () => {
  const SQL = await initSqlJs();
  const store = new SqlJsStore({ db: new SQL.Database(), logger: SILENT });
  await store.migrate();
  const b = build({ store });
  await b.svc.associations.flush();
  const hash = () => crypto.createHash('sha256').update(Buffer.from(store.db.export())).digest('hex');
  const before = hash();
  for (let i = 0; i < 50; i += 1) {
    await b.svc.pitchContextForLead({ leadId: LEAD, leadView: VIEW });
    await b.svc.previewPitchFromOI({ leadId: LEAD, leadView: VIEW });
  }
  await b.svc.associations.flush();
  assert.equal(hash(), before);
  const tables = store.db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('li_pitch_drafts','li_outreach_approvals','li_outreach_activity','li_evidence_packets')")[0].values.flat();
  for (const t of tables) assert.equal(store.db.exec(`SELECT COUNT(*) FROM ${t}`)[0].values[0][0], 0, t);
});

test('8. the real pipeline is untouched: OI modules still reference no outreach/gate module and no pitch table', () => {
  for (const f of fs.readdirSync(OP).filter((x) => x.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(OP, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const banned of ['OutreachGate', 'OutreachService', 'li_pitch_drafts', 'pitches.upsert', 'approvals.insert', 'activity.append']) {
      assert.equal(src.includes(banned), false, `${f} must not reference ${banned}`);
    }
  }
});

test('9. the preview is never saved, approved or sendable, and carries no id any channel accepts', async () => {
  const b = build();
  const p = await b.svc.previewPitchFromOI({ leadId: LEAD, leadView: VIEW, offer: { sender_name: 'Dana', sender_company: 'Ridgeline' } });
  assert.equal(p.available, true);
  assert.deepEqual([p.persisted, p.approved, p.sendable, p.affects_outreach], [false, false, false, false]);
  const wire = JSON.stringify(p.pitch);
  assert.equal(/pitch_id|packet_id|content_hash|_packet|lead_id/.test(wire), false);
  assert.deepEqual(Object.keys(p.pitch).sort(), ['callToAction', 'observations', 'opening', 'subject', 'unsupportedClaims', 'valueProposition']);
  assert.ok(p.pitch.opening.includes('Dana'), 'the sender identity comes from the main-process profile');
});

test('10. IPC: trusted sender, closed {leadId} schema, forbidden keys refused, identity and offer from main', async () => {
  const b = build();
  const handlers = {};
  let offerReads = 0;
  registerOpportunityIpc({
    ipcMain: { handle: (c, f) => { handlers[c] = f; } },
    opportunity: b.svc,
    isTrustedSender: (e) => !(e && e.untrusted),
    leadSource: { getLead: async () => ({ id: LEAD, title: 'Acme Bakery', website: 'https://acmebakery.pk' }) },
    offer: () => { offerReads += 1; return { sender_name: 'Dana' }; },
    logger: { warn() {} },
  });
  const call = (p, ev = {}) => handlers[CHANNELS.PITCH_PREVIEW](ev, p);
  assert.equal((await call({ leadId: LEAD }, { untrusted: true })).ok, false);
  for (const bad of [{}, { leadId: LEAD, offer: { sender_name: 'Evil' } }, { leadId: LEAD, url: 'http://x' }, { leadId: LEAD, token: 'x' }, { leadId: LEAD, freshness: { staleAfterHours: 99999 } }]) {
    assert.equal((await call(bad)).ok, false, JSON.stringify(bad));
  }
  const ok = await call({ leadId: LEAD });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.sendable, false);
  assert.equal(offerReads, 1);
  const ctx = await handlers[CHANNELS.PITCH_CONTEXT]({}, { leadId: LEAD });
  assert.equal(ctx.ok, true);
  assert.ok(Array.isArray(ctx.data.items));
});
