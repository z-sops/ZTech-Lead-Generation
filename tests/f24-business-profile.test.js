'use strict';

// ============================================================ F24 PART A
// PLUG & PLAY BUSINESS / OFFER PROFILE - the safety contract (§23).
//
// F23 identified the last customer-specific hard-code: the F13 LEAD_INTEL_CONFIG offer
// identity (a representative name and a company name baked into main.js). F24 makes the
// offer identity CONFIGURATION and proves, in the order the phase specification lists
// them:
//
//   - no Zee/ZuniTech hard-coded F13 identity remains in the ACTIVE offer path
//   - another business profile can be injected/configured with no source-code edit
//   - missing profile produces honest missing-configuration behaviour (never an invented
//     identity)
//   - secrets are not stored in the Business Profile
//   - existing approved pitch integrity semantics remain valid
//
// Test fixtures and historical text are deliberately NOT swept: the instruction is to fix
// active customer-specific behaviour, not to mechanically erase legitimate test data or
// documentation prose. The "active path" below is therefore defined precisely: the
// comment-STRIPPED source of the production modules that compose an offer, plus the
// runtime behaviour of a generated pitch.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const mainSource = read('main.js');
const serviceSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'OutreachService.js'));
const pitchSource = read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js'));
const runtimeSource = read(path.join('src', 'main', 'lead-intelligence', 'lead-intelligence-runtime.js'));
const preloadSource = read('preload.js');
const rendererSource = read(path.join('src', 'renderer', 'renderer.js'));

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const { readBusinessProfile, emptyBusinessProfile, BUSINESS_PROFILE_FIELDS } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'businessProfile.js'));
const { generatePitch, renderPitchText, contentHash } =
  require(path.join(root, 'src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js'));
const { MemoryStore } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'MemoryStore.js'));
const { createLeadIntelligence } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'index.js'));
const { round1PacketMapper } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'round1PacketMapper.js'));
const { round1Record, zuniV1Packet } = require(path.join(root, 'tests', 'lead-intelligence', 'fixtures', 'round1Record.js'));

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const CLOCK_ISO = '2026-10-05T10:00:00.000Z';
const CAPTURED_AT = '2026-10-01T10:00:00.000Z';
const clock = () => new Date(CLOCK_ISO);
const SILENT = { info() {}, warn() {}, error() {} };

// The identities that must never appear in the active offer path again.
const BANNED_IDENTITY = [/Zee\b/, /ZuniTech/, /zunitechai/i];

const lead = (o) => Object.assign({
  id: 'L1', title: 'Acme Bakery', website: 'https://acme.example.com', email: 'hello@acme.example.com',
  phone: '+923001234567', address: '12 Road', qualification: 'qualified',
}, o);

/** Configuration source double: reads from a plain object, counts every `set`. */
function fakeConfigStore(settings = {}) {
  const data = { settings };
  const calls = { set: 0, gets: [] };
  return {
    calls,
    data,
    get(key, fallback) {
      calls.gets.push(key);
      const v = data[key];
      return v === undefined ? fallback : v;
    },
    set(key, value) { calls.set += 1; data[key] = value; },
  };
}

// Two COMPLETE, neutral business profiles - neither of them any developer's identity.
// They exist only inside this test's injected configuration.
const PROFILE_A = Object.freeze({
  businessRepresentativeName: 'Dana Whitfield',
  businessCompanyName: 'Ridgeline Supply',
  businessValueProposition: 'We help local businesses fix the website issues found in an audit like this one.',
  businessCallToAction: 'Would a short call next week be useful to go through these points?',
});
const PROFILE_B = Object.freeze({
  businessRepresentativeName: 'Marcos Herrera',
  businessCompanyName: 'Cobalt Freight',
  businessValueProposition: 'We rebuild the conversion paths an audit like this one exposes.',
  businessCallToAction: 'Would 20 minutes this Thursday work for you?',
});

function makeRuntime(leads, offer) {
  const store = new MemoryStore();
  const records = Object.values(leads).map((l) => {
    const host = new URL(l.website).host;
    return round1Record({
      id: 'rec_' + l.id, leadRef: l.id, domain: host, providerJobId: 'job_' + l.id,
      packet: zuniV1Packet({ domain: host, capturedAt: CAPTURED_AT }),
      createdAt: CAPTURED_AT, updatedAt: CAPTURED_AT,
    });
  });
  const li = createLeadIntelligence({
    store,
    leadSource: { getLead: async (id) => leads[String(id)] || null, listLeads: async () => Object.values(leads) },
    round1: {
      async getLatest(leadId) { return records.find((r) => r.leadRef === leadId) || null; },
      async listByLead(leadId) { return records.filter((r) => r.leadRef === leadId); },
      async listLatestPerLead() { return new Map(records.map((r) => [r.leadRef, r])); },
    },
    config: {
      research: { mode: 'round1' },
      freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
      outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
      offer,
      whatsapp: { enabled: false, fromNumber: null },
      email: { enabled: false, fromAddress: null },
    },
    clock,
    logger: SILENT,
    round1ResultMapper: round1PacketMapper,
  });
  return { li, store };
}

async function runLead(li, leadId) {
  await li.research.sync({ leadId });
  const pitch = await li.outreach.generate({ leadId });
  const approval = await li.outreach.approve({ pitchId: pitch.pitch_id });
  const gate = await li.outreach.gate({ pitchId: pitch.pitch_id });
  return { pitch, approval, gate };
}

// ============================================================ 1. the hard-code is gone

test('1. no Zee/ZuniTech identity remains in the ACTIVE offer path', () => {
  // The active path, precisely: comment-stripped source of the modules that compose an
  // offer, plus main.js, which wires configuration into them.
  for (const [name, src] of [['main.js', mainSource], ['OutreachService', serviceSource],
    ['PitchGenerator', pitchSource], ['runtime', runtimeSource]]) {
    const code = stripComments(src);
    for (const banned of BANNED_IDENTITY) {
      assert.ok(!banned.test(code), `${name} (code only) must contain no ${banned} identity`);
    }
  }
  // The offer literal in LEAD_INTEL_CONFIG is the empty, unconfigured profile...
  const offerMatch = mainSource.match(/offer:\s*\{([^}]*)\}/);
  assert.ok(offerMatch, 'the LEAD_INTEL_CONFIG offer block exists');
  const offerBlock = offerMatch[1];
  for (const banned of BANNED_IDENTITY) assert.ok(!banned.test(offerBlock), 'the offer default carries no identity');
  assert.ok(/sender_name:\s*''/.test(offerBlock) && /sender_company:\s*''/.test(offerBlock),
    'the shipped default is empty, not a built-in identity');
  // ...and the runtime offer comes from CONFIGURATION, not from this literal.
  assert.ok(/offer:\s*businessProfileFromSettings\(\)/.test(stripComments(mainSource)),
    'initLeadIntelligence overrides the offer with the configured business profile');
  assert.ok(/whatsapp:\s*whatsappConfigFromSettings\(\)/.test(stripComments(mainSource)),
    'and the WhatsApp configuration the same way');
  // No renderer or preload surface invents an identity either.
  for (const [name, src] of [['preload', preloadSource], ['renderer', rendererSource]]) {
    for (const banned of BANNED_IDENTITY) assert.ok(!banned.test(src), `${name} carries no ${banned} identity`);
  }
});

test('2. the Business Profile is EXACTLY five non-secret fields', () => {
  // F26.5 declared lock update: four -> five, adding postal_address (CAN-SPAM; required to send).
  assert.deepStrictEqual(
    BUSINESS_PROFILE_FIELDS.map((f) => f.key).sort(),
    ['call_to_action', 'postal_address', 'sender_company', 'sender_name', 'value_proposition'],
    'the profile enumerates only the fields existing product behaviour reads');
  assert.deepStrictEqual(Object.keys(emptyBusinessProfile()).sort(),
    ['call_to_action', 'postal_address', 'sender_company', 'sender_name', 'value_proposition'],
    'the empty profile has the same five keys and nothing else');
  // A configuration source carrying credential-shaped keys next to the identity keys
  // never leaks them into the profile.
  const secret = 'sk_f24_profile_secret_never_leak_99';
  const store = fakeConfigStore(Object.assign({}, PROFILE_A, {
    apiKey: secret, accessToken: secret, password: secret, businessApiKey: secret,
  }));
  const profile = readBusinessProfile(store);
  const json = JSON.stringify(profile);
  assert.ok(!json.includes(secret), 'no secret value enters the Business Profile');
  assert.deepStrictEqual(Object.keys(profile).sort(),
    ['call_to_action', 'postal_address', 'sender_company', 'sender_name', 'value_proposition'],
    'and no credential-shaped key is carried either');
  // The reader touches ONLY `settings` - never the providers/credentials record.
  assert.deepStrictEqual([...new Set(store.calls.gets)], ['settings'], 'the reader reads only settings');
});

// ============================================================ 3. missing profile = honest

test('3. a missing profile produces honest missing-configuration behaviour, never an identity', async () => {
  for (const store of [null, undefined, fakeConfigStore({})]) {
    const profile = readBusinessProfile(store);
    assert.deepStrictEqual(Object.values(profile).every((v) => v === ''), true,
      'an absent configuration source reads back as four empty strings');
  }
  assert.ok(Object.isFrozen(readBusinessProfile(null)), 'and the snapshot is frozen');

  // Through the real generator: with no profile the pitch composes an identity-FREE
  // opening rather than falling back to a built-in one.
  const { li } = makeRuntime({ L1: lead({}) }, readBusinessProfile(fakeConfigStore({})));
  const { pitch, gate } = await runLead(li, 'L1');
  const text = renderPitchText(pitch);
  for (const banned of BANNED_IDENTITY) {
    assert.ok(!banned.test(pitch.opening), 'the opening carries no built-in identity');
    assert.ok(!banned.test(text), 'the rendered pitch carries no built-in identity');
  }
  assert.ok(!/from [A-Z]/.test(pitch.opening), 'no company name is invented when none is configured');
  assert.strictEqual(pitch.valueProposition, '', 'no value proposition is invented');
  assert.ok(pitch.opening.includes("I'm writing"), 'the honest identity-free opening is used');
  // Honesty does not break the product: the pitch is still a real draft a human can
  // approve, and the gate still decides readiness.
  assert.strictEqual(pitch.status, 'draft', 'an unconfigured identity does not corrupt the draft status');
  assert.ok(pitch.content_hash && pitch.content_hash.length > 0, 'and it still carries a content hash');
  assert.strictEqual(gate.decision, 'allowed', 'the gate still decides readiness as before');
});

test('4. another business profile can be configured with NO source-code edit', async () => {
  // Same product source, two different configuration sources: two different identities.
  const a = makeRuntime({ L1: lead({}) }, readBusinessProfile(fakeConfigStore(PROFILE_A)));
  const runA = await runLead(a.li, 'L1');
  const b = makeRuntime({ L1: lead({}) }, readBusinessProfile(fakeConfigStore(PROFILE_B)));
  const runB = await runLead(b.li, 'L1');

  assert.ok(runA.pitch.opening.includes('Dana Whitfield') && runA.pitch.opening.includes('Ridgeline Supply'),
    'profile A appears in the pitch: ' + runA.pitch.opening);
  assert.ok(runB.pitch.opening.includes('Marcos Herrera') && runB.pitch.opening.includes('Cobalt Freight'),
    'profile B appears in the pitch: ' + runB.pitch.opening);
  assert.ok(!runA.pitch.opening.includes('Marcos') && !runB.pitch.opening.includes('Dana'),
    'neither profile leaks into the other');
  // The offer text flows through too - it is the same configuration surface.
  const textA = renderPitchText(runA.pitch);
  const textB = renderPitchText(runB.pitch);
  assert.ok(textA.includes(PROFILE_A.businessValueProposition), 'value proposition A is in the body');
  assert.ok(textA.includes(PROFILE_A.businessCallToAction), 'call to action A is in the body');
  assert.ok(textB.includes(PROFILE_B.businessValueProposition), 'value proposition B is in the body');
  assert.ok(!textA.includes(PROFILE_B.businessValueProposition), 'and B never appears in A');
  // The source file that produced both is byte-identical - the only thing that changed
  // was configuration.
  assert.strictEqual(read(path.join('src', 'main', 'lead-intelligence', 'outreach', 'PitchGenerator.js')),
    pitchSource, 'no source file was edited between the two profiles');
});

test('5. the parser bounds, trims and sanitises configured values', () => {
  const store = fakeConfigStore({
    businessRepresentativeName: '  Dana Whitfield  ',
    businessCompanyName: 'Ridgeline\nSupply',
    businessValueProposition: 'x'.repeat(5000),
    businessCallToAction: 'Call us.\r\nSoon',
    somethingElse: 'ignored',
  });
  const profile = readBusinessProfile(store);
  assert.strictEqual(profile.sender_name, 'Dana Whitfield', 'single-line fields are trimmed');
  assert.ok(!/[\r\n]/.test(profile.sender_company), 'a newline never survives into a one-line identity field');
  assert.strictEqual(profile.value_proposition.length, 1200, 'the value proposition is bounded');
  assert.strictEqual(profile.call_to_action, 'Call us.\nSoon', 'CRLF is normalised in multiline fields');

  // Non-strings are "not configured", never "configured".
  const junk = readBusinessProfile(fakeConfigStore({
    businessRepresentativeName: 42, businessCompanyName: { a: 1 }, businessValueProposition: null, businessCallToAction: ['x'],
  }));
  assert.deepStrictEqual(Object.values(junk).every((v) => v === ''), true, 'a non-string reads back as unconfigured');

  // The reader NEVER writes.
  const writer = fakeConfigStore(PROFILE_A);
  readBusinessProfile(writer);
  assert.strictEqual(writer.calls.set, 0, 'the configuration source is never written to');
});

// ============================================================ 6. pitch integrity

test('6. approved pitch integrity semantics remain valid for any profile', async () => {
  const { li } = makeRuntime({ L1: lead({}) }, readBusinessProfile(fakeConfigStore(PROFILE_A)));
  const { pitch, approval, gate } = await runLead(li, 'L1');
  assert.ok(approval, 'the pitch was approved through the existing F13 flow');
  assert.strictEqual(gate.decision, 'allowed', 'and the existing gate allows it');
  // The content hash still covers the identity text: the same profile, re-generated,
  // hashes identically; a changed profile changes the hash.
  const regenerated = generatePitch({
    view: (await li.contexts.getContext('L1')).view,
    packet: (await li.contexts.getContext('L1')).packet,
    offer: readBusinessProfile(fakeConfigStore(PROFILE_A)),
    now: clock(),
  });
  assert.strictEqual(regenerated.content_hash, contentHash(regenerated), 'the hash is derived from the content');
  const other = generatePitch({
    view: (await li.contexts.getContext('L1')).view,
    packet: (await li.contexts.getContext('L1')).packet,
    offer: readBusinessProfile(fakeConfigStore(PROFILE_B)),
    now: clock(),
  });
  assert.notStrictEqual(other.content_hash, regenerated.content_hash,
    'a different configured identity is different approved content, so it hashes differently');
  // Claim detection still applies to configured offer text: a prohibited claim in the
  // profile is caught exactly as it was before F24.
  const claimed = generatePitch({
    view: (await li.contexts.getContext('L1')).view,
    packet: (await li.contexts.getContext('L1')).packet,
    offer: readBusinessProfile(fakeConfigStore(Object.assign({}, PROFILE_A, {
      businessCallToAction: 'We guarantee first page of Google for you.',
    }))),
    now: clock(),
  });
  assert.ok(claimed.unsupportedClaims.length > 0 || claimed.status !== 'draft',
    'configured offer text is still subject to the existing claim checks');
});

test('7. main.js wires the profile and the WhatsApp provider through configuration only', () => {
  const code = stripComments(mainSource);
  assert.ok(/function businessProfileFromSettings\(\)/.test(code), 'the profile reader exists in main.js');
  assert.ok(/function whatsappConfigFromSettings\(\)/.test(code), 'the WhatsApp configuration reader exists');
  assert.ok(/function buildWhatsAppProvider\(\)/.test(code), 'the WhatsApp adapter builder exists');
  assert.ok(/readBusinessProfile\(electronStore\)/.test(code), 'the profile is read from the configuration source');
  assert.ok(/whatsappProvider:\s*buildWhatsAppProvider\(\)/.test(code), 'the adapter is built from configuration closures');
  assert.ok(/require\('\.\/src\/main\/lead-intelligence\/outreach\/businessProfile'\)/.test(code),
    'the reader is a main-process module');
  // The secret path stays on the existing credential mechanism, main-process only.
  assert.ok(/providers\[.'meta-cloud.'\]/.test(code) || /providers\['meta-cloud'\]/.test(code),
    'the token is read from the provider credential record');
  assert.ok(/credentialVault\.reveal/.test(code), 'revealed only through the existing vault');
  assert.ok(!/graph\.facebook/.test(code), 'main.js names no provider endpoint');
});

// ============================================================ runner

(async () => {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log('ok - ' + t.name);
    } catch (err) {
      failed += 1;
      console.log('FAIL - ' + t.name);
      console.log((err && err.stack) || err);
    }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
