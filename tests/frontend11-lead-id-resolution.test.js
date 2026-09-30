'use strict';

// F11 regression: lead id resolution at the AccountStore integration boundary.
//
// THE BUG
// accountStoreLeadSource.getLead() coerced a digit-only lead id to Number before
// calling accountStore.queryNumbers(). queryNumbers() validates the id with
// `typeof q.id === 'string'` and returns an EMPTY envelope for any other type
// (accountStore.js, "B3 single-lead lookup"). Every normal ZTech lead id is
// digit-only, so every one of them was rejected, getLead() returned null, and
// LeadContextService.getContext() threw NotFoundError('Lead') -- surfacing in the
// F11 drawer as "Could not complete: NOT_FOUND / Lead not found".
//
// Six leadSource.getLead callers were affected, not just pitch.generate:
//   LeadContextService.js:88        (pitch.generate)
//   Round1ResearchBridge.js:202    (round-1 -> EvidencePacket sync)
//   ProspectIntelligenceGateway.js:46
//   EnrichmentService.js:95
//   SearchServices.js:120
//   OutreachService.js:91           (email send path, disabled)
//
// THE FIX
// mainProcess.js getLead() normalises the id to a string and passes it through
// unchanged. accountStore.js is NOT modified and its string-id guard is NOT
// weakened: that guard is a deliberate type-safety boundary, and the bug was the
// caller violating it.
//
// WHAT THESE TESTS PIN
// The invariant is that a lead id round-trips through getLead() regardless of
// whether it arrives as a string or a number, and that pitch.generate() for a
// lead with no research reaches the honest insufficient_evidence path instead of
// a false NOT_FOUND.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) { tests.push([name, fn]); }

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-f11-leadid-'));

  // accountStore reads app.getPath('userData'); redirect it at the temp dir so
  // this suite can never touch the real user database.
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const root = path.join(__dirname, '..');
  const integrationPath = path.join(root, 'src', 'main', 'lead-intelligence', 'integration', 'mainProcess.js');
  const { AccountStore } = require(path.join(root, 'src', 'main', 'accountStore.js'));
  const { accountStoreLeadSource } = require(integrationPath);

  fs.mkdirSync(path.join(testRoot, 'data'), { recursive: true });

  // The seed mirrors the live isolated verification profile: digit-only TEXT ids.
  const ACME = {
    id: '5', phone: '+92 300 1234567', source: 'Google Maps', status: 'sent',
    collectedAt: '2026-09-01T10:00:00.000Z', title: 'Acme Bakery',
    website: 'https://acme.com', email: 'hello@acme.com', address: '12 Road',
    runSlug: 'seed-run', qualification: 'qualified'
  };
  const BETA = {
    id: '6', phone: '+92 21 1112222', source: 'Google Maps', status: 'sent',
    collectedAt: '2026-09-01T10:00:00.000Z', title: 'Beta Traders',
    website: 'https://beta.test', email: 'hi@beta.test', address: '9 Street',
    runSlug: 'seed-run', qualification: 'unqualified'
  };

  const accountStore = new AccountStore();
  await accountStore.ready;
  await accountStore.addNumbers([ACME, BETA]);

  const leadSource = accountStoreLeadSource(accountStore);

  // --- 1. string id resolves the lead -----------------------------------------
  test('1. getLead("5") resolves Acme Bakery (string id)', async () => {
    const lead = await leadSource.getLead('5');
    assert.ok(lead, 'a lead row is returned for the string id "5"');
    assert.strictEqual(lead.title, 'Acme Bakery');
    assert.strictEqual(String(lead.id), '5');
  });

  // --- 2. numeric id resolves the same lead -----------------------------------
  test('2. getLead(5) resolves Acme Bakery (numeric id)', async () => {
    const lead = await leadSource.getLead(5);
    assert.ok(lead, 'a lead row is returned for the numeric id 5');
    assert.strictEqual(lead.title, 'Acme Bakery');
  });

  // --- 3. both id shapes are identical ---------------------------------------
  test('3. both ID shapes resolve identically', async () => {
    const asString = await leadSource.getLead('6');
    const asNumber = await leadSource.getLead(6);
    assert.ok(asString, 'string id resolves');
    assert.ok(asNumber, 'numeric id resolves');
    assert.strictEqual(asString.title, 'Beta Traders');
    assert.deepStrictEqual(
      { ...asString }, { ...asNumber },
      'string and numeric id shapes return the identical lead row'
    );
  });

  // --- 4. unknown id is a clean null, never a wrong row or a throw -------------
  test('4. unknown ID returns null', async () => {
    assert.strictEqual(await leadSource.getLead('does-not-exist'), null);
    assert.strictEqual(await leadSource.getLead(999999), null);
  });

  // --- 5. the AccountStore string-id guard is intact, not weakened -------------
  test('5. AccountStore string-id validation is untouched', async () => {
    // The guard rejects non-string ids with an empty envelope. That behaviour is
    // the documented type-safety boundary and must survive this fix.
    const viaStore = await accountStore.queryNumbers({ limit: 1, offset: 0, id: 5 });
    assert.deepStrictEqual(viaStore.rows, [], 'AccountStore still rejects a numeric id');
    const viaStoreStr = await accountStore.queryNumbers({ limit: 1, offset: 0, id: '5' });
    assert.strictEqual(viaStoreStr.rows.length, 1, 'AccountStore resolves a string id');
    // No new lead table or identity store was introduced.
    const tables = accountStore.db.exec("SELECT name FROM sqlite_master WHERE type='table'");
    const names = tables[0].values.map(v => v[0]);
    assert.ok(!names.includes('leads'), 'no duplicate `leads` table');
    assert.ok(names.includes('numbers'), '`numbers` remains the lead table of record');
  });

  // --- 6. listLeads still works (no regression on the list path) --------------
  test('6. existing lead listing still works', async () => {
    const listed = await leadSource.listLeads();
    assert.ok(Array.isArray(listed), 'listLeads returns an array');
    const titles = listed.map(r => r.title).sort();
    assert.deepStrictEqual(titles, ['Acme Bakery', 'Beta Traders']);
  });

  // --- 7. Round1ResearchBridge can resolve an existing lead -------------------
  test('7. Round1ResearchBridge resolves an existing lead through getLead', async () => {
    // The bridge's lead read is the same getLead call that was broken. Drive it
    // through the shared adapter rather than duplicating the id contract.
    const round1 = {
      getLatest: async () => null,
      listByLead: async () => [],
      listLatestPerLead: async () => new Map()
    };
    const bridge = new (require(
      path.join(root, 'src', 'main', 'lead-intelligence', 'research', 'Round1ResearchBridge.js')
    ).Round1ResearchBridge)({ round1, leadSource });
    const raw = await bridge.leadSource.getLead('5');
    assert.ok(raw, 'bridge leadSource resolves the existing lead');
    assert.strictEqual(raw.title, 'Acme Bakery');
    const asNumber = await bridge.leadSource.getLead(5);
    assert.strictEqual(asNumber.title, 'Acme Bakery',
      'the bridge resolves a numeric id too, so round-1 sync is unblocked');
  });

  // --- 8. pitch.generate reaches insufficient_evidence, not NOT_FOUND ---------
  test('8. pitch.generate for a lead with NO research reaches insufficient_evidence', async () => {
    // The reported symptom: a real lead, no research evidence, and generate
    // answered NOT_FOUND / "Lead not found". With the id boundary fixed, the same
    // call must get past LeadContextService.getContext and land on the honest
    // no-evidence path, which PitchGenerator.statusFor() maps to
    // 'insufficient_evidence'.
    const { LeadContextService } = require(
      path.join(root, 'src', 'main', 'lead-intelligence', 'search', 'LeadContextService.js')
    );
    const { OutreachService } = require(
      path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js')
    );
    const { MemoryStore } = require(
      path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js')
    );
    const { FreshnessPolicy } = require(
      path.join(root, 'src', 'main', 'lead-intelligence', 'research', 'FreshnessPolicy.js')
    );

    const store = new MemoryStore();
    const contexts = new LeadContextService({
      leadSource,
      targetSource: null,
      store,
      freshness: new FreshnessPolicy(),
      fieldMap: undefined
    });
    const outreach = new OutreachService({
      store, contexts, leadSource,
      freshness: new FreshnessPolicy(),
      fieldMap: undefined,
      config: {}
    });

    // The exact call the F11 drawer makes, with a numeric id.
    const pitch = await outreach.generate({ leadId: 5 });
    assert.ok(pitch, 'generate returned a pitch instead of throwing NOT_FOUND');
    assert.strictEqual(String(pitch.lead_id), '5', 'pitch is bound to the requested lead');
    assert.strictEqual(pitch.status, 'insufficient_evidence',
      'a lead with no stored evidence yields insufficient_evidence, never NOT_FOUND');
    assert.strictEqual(pitch.observations.length, 0, 'no observations are fabricated');
    assert.deepStrictEqual(pitch.unsupportedClaims, [], 'no unsupported claims are invented');
  });

  // --- 9. the fixed adapter carries no numeric coercion ------------------------
  test('9. getLead carries no numeric coercion', () => {
    const src = fs.readFileSync(integrationPath, 'utf8');
    const block = src.slice(src.indexOf('async getLead(id)'), src.indexOf('async listLeads()'));
    assert.ok(block.length > 0, 'getLead block located');
    // Strip comments so the check inspects executable code, not prose. A comment
    // may legitimately name the old bug without reintroducing it.
    const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/Number\s*\(/.test(code), 'getLead must not coerce the id to a number');
    assert.ok(!/parseInt\s*\(/.test(code), 'getLead must not parse the id as an integer');
    assert.ok(code.includes('String(id)'), 'getLead normalises the id to a string');
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }

  try { fs.rmSync(testRoot, { recursive: true, force: true }); } catch (e) {}

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
