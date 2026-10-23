'use strict';

// F26.5 - contact provenance (lock item 7): capture on save, one-time backfill, never invented.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore.js'));
const { TrustService } = require(path.join(LI, 'trust', 'TrustService.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

let now = Date.parse('2026-10-07T10:00:00.000Z');
const clock = () => new Date(now);

function setup(leads) {
  const store = new MemoryStore();
  const leadSource = { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) };
  return { store, trust: new TrustService({ store, leadSource, clock }) };
}
const byField = (rows) => Object.fromEntries(rows.map((r) => [r.field, r]));

test('7a. backfill marks every present contact field "unknown" with no source and no date; absent fields get nothing', async () => {
  const leads = { L1: { id: 'L1', phone: '+923001234567', email: 'a@b.co', website: '', collectedAt: '2026-01-01T00:00:00Z', runSlug: 'run-1' } };
  const { store, trust } = setup(leads);
  const r = await trust.backfillProvenance();
  assert.deepStrictEqual(r, { leads: 1, recorded: 2 });
  const rows = byField(await store.provenance.listByLead('L1'));
  assert.deepStrictEqual(Object.keys(rows).sort(), ['email', 'phone']);
  for (const row of Object.values(rows)) {
    assert.deepStrictEqual([row.source_kind, row.source_ref, row.collected_at, row.backfilled], ['unknown', null, null, 1],
      'the lead record\'s run metadata is NOT turned into a field-level claim');
  }
  assert.deepStrictEqual(await trust.backfillProvenance(), { leads: 1, recorded: 0 }, 'a second run writes nothing');
});

test('7b. a new lead saved by a collection run gets source, run reference and date for each saved field', async () => {
  const leads = {};
  const { store, trust } = setup(leads);
  await trust.backfillProvenance();
  leads.L2 = { id: 'L2', phone: '+923009999999', email: 'shop@new.example', website: 'https://new.example' };
  const r = await trust.captureSave({ rows: [{ phone: '+92 300 9999999', email: 'Shop@New.example', website: 'https://new.example' }], providerId: 'coreclaw', runSlug: 'run-42' });
  assert.deepStrictEqual(r, { recorded: 3 });
  const rows = byField(await store.provenance.listByLead('L2'));
  for (const f of ['phone', 'email', 'website']) {
    assert.deepStrictEqual([rows[f].source_kind, rows[f].source_ref, rows[f].collected_at, rows[f].backfilled],
      ['collection_run', 'coreclaw/run-42', new Date(now).toISOString(), 0], f);
  }
});

test('7c. an import save is recorded as import with no run reference', async () => {
  const leads = { L3: { id: 'L3', phone: '+923007777777', email: '', website: '' } };
  const { store, trust } = setup(leads);
  await trust.captureSave({ rows: [{ phone: '+923007777777' }] });
  const row = (await store.provenance.listByLead('L3'))[0];
  assert.deepStrictEqual([row.field, row.source_kind, row.source_ref], ['phone', 'import', null]);
});

test('7d. a merge that kept an older value never re-attributes it; an earlier backfill stays unknown', async () => {
  const leads = { L4: { id: 'L4', phone: '+923006666666', email: 'old@shop.example', website: '' } };
  const { store, trust } = setup(leads);
  await trust.backfillProvenance();
  leads.L4.website = 'https://shop.example'; // filled by this save's merge
  await trust.captureSave({ rows: [{ phone: '+923006666666', email: 'different@shop.example', website: 'https://shop.example' }], providerId: 'coreclaw', runSlug: 'run-9' });
  const rows = byField(await store.provenance.listByLead('L4'));
  assert.strictEqual(rows.email.source_kind, 'unknown', 'the stored email was not this save\'s value');
  assert.strictEqual(rows.phone.source_kind, 'unknown', 'the phone predates this save');
  assert.strictEqual(rows.website.source_kind, 'collection_run', 'the merged website is attributed to this save');
});

test('7h. with no earlier provenance, a field is attributed only when the stored value IS the saved value', async () => {
  const leads = { L7: { id: 'L7', phone: '+923003333333', email: 'kept@shop.example', website: '' } };
  const { store, trust } = setup(leads);
  await trust.captureSave({ rows: [{ phone: '+923003333333', email: 'other@shop.example', website: 'https://ignored.example' }], providerId: 'coreclaw', runSlug: 'run-3' });
  assert.deepStrictEqual((await store.provenance.listByLead('L7')).map((r) => r.field), ['phone'], 'neither the different email nor the unsaved website is attributed');
});

test('7e. a later save of the same lead never overwrites its first capture', async () => {
  const leads = { L5: { id: 'L5', phone: '+923005555555', email: '', website: '' } };
  const { store, trust } = setup(leads);
  await trust.captureSave({ rows: [{ phone: '+923005555555' }], providerId: 'coreclaw', runSlug: 'run-1' });
  now += 3600000;
  await trust.captureSave({ rows: [{ phone: '+923005555555' }], providerId: 'coreclaw', runSlug: 'run-2' });
  assert.strictEqual((await store.provenance.listByLead('L5'))[0].source_ref, 'coreclaw/run-1');
});

test('7f. provenance shows in the lead trust view (no address, no ref)', async () => {
  const leads = { L6: { id: 'L6', phone: '+923004444444', email: 'x@y.example', website: '' } };
  const { trust } = setup(leads);
  await trust.captureSave({ rows: [{ phone: '+923004444444', email: 'x@y.example' }], providerId: 'coreclaw', runSlug: 'run-7' });
  const v = await trust.leadTrust({ leadId: 'L6' });
  assert.deepStrictEqual(v.provenance.map((p) => [p.field, p.sourceKind, p.sourceRef, p.backfilled]),
    [['email', 'collection_run', 'coreclaw/run-7', false], ['phone', 'collection_run', 'coreclaw/run-7', false]]);
});

test('7g. wiring: the runtime backfills once at start; main.js captures only AFTER a successful save, never blocking it', () => {
  const runtime = fs.readFileSync(path.join(LI, 'lead-intelligence-runtime.js'), 'utf8');
  assert.ok(/await li\.trust\.backfillProvenance\(\)/.test(runtime));
  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const handler = main.slice(main.indexOf("ipcMain.handle('collector:add-numbers'"), main.indexOf("ipcMain.handle('collector:quality-report'"));
  const save = handler.indexOf('accountStore.addNumbers(payload)');
  const cap = handler.indexOf('capturePostSaveProvenance(result, payload, saveContext)');
  assert.ok(save > 0 && cap > save, 'capture follows the save');
  const fn = main.slice(main.indexOf('function capturePostSaveProvenance('), main.indexOf("// The local collection save."));
  assert.ok(/\.catch\(/.test(fn) && !/throw/.test(fn), 'a capture failure is logged, never thrown into the save');
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
