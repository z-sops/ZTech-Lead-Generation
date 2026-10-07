'use strict';

// F26.5 - the trust checks at the ONE send boundary (lock-list items 1, 3, 4, 5, 6 and 10).
//
// Real createLeadIntelligence, real OutreachService, real gate, real MemoryStore, the REAL
// ResendEmailProvider and MetaCloudWhatsAppProvider with spy transports. The fakes are the
// clock, the configuration source and the transports. Real network is forbidden.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

globalThis.fetch = async () => { throw new Error('F26.5 TEST GUARD: real network is forbidden'); };

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { ResendEmailProvider } = require(path.join(LI, 'outreach', 'email', 'ResendEmailProvider.js'));
const { EmailProvider } = require(path.join(LI, 'outreach', 'email', 'EmailProvider.js'));
const { lintSubject, TRUST_CODES, transportPolicyOf } = require(path.join(LI, 'trust', 'TrustPolicy.js'));
const { grantTrust } = require('./trust-fixture');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const {
  NOW, HOUR, LEAD_EMAIL, LEAD_PHONE, OFFER, lead, runtime, approved, iso, suppress, inbound, reply, waConsent,
} = require('./f265-harness');

async function expectRefusal(li, pitch, channel, code) {
  let err = null;
  try { await li.outreach.send({ pitchId: pitch.pitch_id, channel }); } catch (e) { err = e; }
  assert.ok(err, 'the send was refused');
  assert.strictEqual(err.code, code, `expected ${code}, got ${err.code}: ${err.message}`);
  return err;
}
async function blockedRows(li) {
  return (await li.outreach.activityList({ limit: 100 })).rows.filter((r) => r.activity_type === 'OUTREACH_SEND_BLOCKED');
}

/* ============================== 1. suppression ============================== */

test('1a. a suppressed email refuses with CONTACT_SUPPRESSED: zero transport calls, one blocked row, no ledger row', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await suppress(store, 'email', '  HELLO@Acme.Example.com ');
  await expectRefusal(li, pitch, 'email', 'CONTACT_SUPPRESSED');
  assert.strictEqual(emailSpy.calls.length, 0);
  const rows = await blockedRows(li);
  assert.strictEqual(rows.length, 1, 'exactly one blocked row');
  assert.strictEqual(rows[0].metadata.blockedCode, 'CONTACT_SUPPRESSED');
  assert.strictEqual(rows[0].metadata.channel, 'email');
  assert.ok(!JSON.stringify(rows[0]).toLowerCase().includes('hello@acme'), 'the activity row names no address');
  assert.strictEqual((await li.outreach.sendList({ limit: 10 })).rows.length, 0, 'no send-ledger row');
});

test('1b. a suppressed number refuses WhatsApp even with consent and an open session (formatting does not matter)', async () => {
  const { li, store, waSpy } = runtime();
  const pitch = await approved(li);
  await waConsent(store);
  await inbound(store);
  await suppress(store, 'whatsapp', '+92 300-123-4567');
  await expectRefusal(li, pitch, 'whatsapp', 'CONTACT_SUPPRESSED');
  assert.strictEqual(waSpy.calls.length, 0);
});

test('1c. suppression is by address: a second lead with the same email is blocked too', async () => {
  const leads = { L1: lead({}), L2: lead({ id: 'L2', title: 'Acme Bakery Branch', website: 'https://branch.acme.example.com', email: 'Hello@ACME.example.com' }) };
  const { li, store, emailSpy } = runtime({ leads });
  await approved(li, 'L1');
  const p2 = await approved(li, 'L2');
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await suppress(store, 'email', LEAD_EMAIL);
  await expectRefusal(li, p2, 'email', 'CONTACT_SUPPRESSED');
  assert.strictEqual(emailSpy.calls.length, 0);
});

test('1d. an already-accepted pitch replays after suppression without contacting anyone', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const first = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(first.outcome, 'accepted');
  await suppress(store, 'email', LEAD_EMAIL);
  const again = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(again.outcome, 'replayed');
  assert.strictEqual(emailSpy.calls.length, 1, 'the replay reached no provider');
});

/* ============================== 3. sender identity ============================== */

test('3. no postal address, no company, or no sender name refuses with SENDER_IDENTITY_INCOMPLETE; nothing is invented', async () => {
  const cases = [
    ['email', { ...OFFER, postal_address: '' }],
    ['email', { ...OFFER, sender_company: '   ' }],
    ['whatsapp', { ...OFFER, postal_address: '' }],
  ];
  for (const [channel, offer] of cases) {
    const { li, store, emailSpy, waSpy } = runtime({ offer });
    const pitch = await approved(li);
    await grantTrust(store, { email: LEAD_EMAIL, phone: LEAD_PHONE, now: iso(NOW) });
    const err = await expectRefusal(li, pitch, channel, 'SENDER_IDENTITY_INCOMPLETE');
    assert.match(err.message, /Business Profile/);
    assert.strictEqual(emailSpy.calls.length + waSpy.calls.length, 0, channel);
  }
  // Email also needs a sender name: from the profile or the configured From name.
  const { li, store, emailSpy } = runtime({ offer: { ...OFFER, sender_name: '' } });
  li.outreach.emailConfigStore().data.settings.emailFromName = '';
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const err = await expectRefusal(li, pitch, 'email', 'SENDER_IDENTITY_INCOMPLETE');
  assert.match(err.message, /sender name/);
  assert.strictEqual(emailSpy.calls.length, 0);
});

/* ============================== 4. subject lint ============================== */

test('4a. subject lint: Re:/Fwd: prefixes and billing claims are refused; normal subjects pass', () => {
  for (const bad of ['Re: your website', 'RE: Quick question', 'Fwd: audit', 'FW:notes', 'Re[2]: hi', 'AW: Angebot', 'Your invoice is ready', 'Payment overdue', 'Order #1234 confirmed', 'Final notice for Acme', 'Your account suspended']) {
    assert.ok(lintSubject(bad), 'refused: ' + bad);
  }
  for (const good of ['A few notes on www.acme.com', 'Three quick fixes for Acme Bakery', 'Idea for your online orders page', 'Regarding your website speed', 'Freshly baked: a site audit']) {
    assert.strictEqual(lintSubject(good), null, 'allowed: ' + good);
  }
});

test('4b. a misleading subject refuses the send with SUBJECT_MISLEADING and zero transport calls', async () => {
  const { li, store, emailSpy } = runtime();
  await li.research.sync({ leadId: 'L1' });
  const pitch = await li.outreach.generate({ leadId: 'L1' });
  const edited = await li.outreach.update({ pitchId: pitch.pitch_id, edits: { subject: 'Re: your invoice' } });
  await li.outreach.approve({ pitchId: edited.pitch_id });
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await expectRefusal(li, edited, 'email', 'SUBJECT_MISLEADING');
  assert.strictEqual(emailSpy.calls.length, 0);
});

/* ============================== 5. WhatsApp gate ============================== */

test('5a. no recorded opt-in -> WHATSAPP_CONSENT_REQUIRED and zero Meta calls', async () => {
  const { li, store, waSpy } = runtime();
  const pitch = await approved(li);
  await inbound(store); // even an inbound event alone is not a recorded opt-in
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_CONSENT_REQUIRED');
  assert.strictEqual(waSpy.calls.length, 0);
});

test('5b. opt-in without an open 24h session -> WHATSAPP_SESSION_CLOSED; user-sourced or stale inbound never opens it', async () => {
  const { li, store, waSpy } = runtime();
  const pitch = await approved(li);
  await waConsent(store);
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_SESSION_CLOSED');
  await inbound(store, { source: 'user', at: NOW - HOUR });
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_SESSION_CLOSED');
  await inbound(store, { source: 'relay', at: NOW - 25 * HOUR });
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_SESSION_CLOSED');
  assert.strictEqual(waSpy.calls.length, 0);
});

test('5c. opt-in plus a relay inbound within 24h unlocks WhatsApp: exactly one Meta call', async () => {
  const { li, store, waSpy } = runtime();
  const pitch = await approved(li);
  await waConsent(store);
  await inbound(store, { at: NOW - 23 * HOUR });
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(waSpy.calls.length, 1);
});

test('5d. the session closes at exactly 24h after the inbound message', async () => {
  let now = NOW;
  const { li, store, waSpy } = runtime({ now: () => now });
  const pitch = await approved(li);
  await waConsent(store);
  await inbound(store, { at: NOW - 24 * HOUR });
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_SESSION_CLOSED');
  now = NOW - 1;
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(waSpy.calls.length, 1);
});

/* ============================== 6. email transport policy ============================== */

test('6a. a cold lead on Resend -> EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD and zero Resend calls', async () => {
  const { li, emailSpy } = runtime();
  const pitch = await approved(li);
  const err = await expectRefusal(li, pitch, 'email', 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD');
  assert.match(err.message, /mail app/);
  assert.strictEqual(emailSpy.calls.length, 0);
  assert.strictEqual((await blockedRows(li))[0].metadata.blockedCode, 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD');
});

test('6b. a user-entered "reply" never unlocks Resend; a relay-verified reply does', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await reply(store, { source: 'user' });
  await expectRefusal(li, pitch, 'email', 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD');
  await reply(store, { source: 'relay' });
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(emailSpy.calls.length, 1);
});

test('6c. a recorded email consent unlocks Resend as before (one call, same recipient)', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(emailSpy.calls.length, 1);
  assert.ok(JSON.stringify(JSON.parse(emailSpy.calls[0].body).to).includes(LEAD_EMAIL));
});

test('6d. the rule belongs to the transport: Resend declares it, the base class is strict, a transport may declare otherwise', async () => {
  assert.strictEqual(new ResendEmailProvider({}).transportPolicy.requiresPriorRelationship, true);
  assert.strictEqual(transportPolicyOf(null).requiresPriorRelationship, true, 'undeclared is strict');
  assert.strictEqual(transportPolicyOf({ transportPolicy: {} }).requiresPriorRelationship, true);
  class OwnMailbox extends EmailProvider {
    constructor() { super(); this.sent = []; }
    get id() { return 'own-mailbox-test'; }
    get live() { return true; }
    get transportPolicy() { return { requiresPriorRelationship: false, enforcesUnsubscribeHeaders: true }; }
    validate() { return { valid: true, errors: [] }; }
    async send(m) { this.sent.push(m); return { messageId: 'om_1', status: 'queued' }; }
  }
  const own = new OwnMailbox();
  const { li } = runtime({ emailProvider: own });
  li.outreach.emailConfigStore().data.settings.emailProvider = 'resend'; // configuration status stays verified
  const pitch = await approved(li);
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(r.outcome, 'accepted', 'a transport whose terms allow 1:1 cold email is not held to Resend\'s rule');
  assert.strictEqual(own.sent.length, 1);
});

/* ============================== 10. order of checks ============================== */

test('10a. email order: suppression -> identity -> transport -> subject, each before any provider', async () => {
  const { li, store, emailSpy } = runtime({ offer: { ...OFFER, postal_address: '' } });
  await li.research.sync({ leadId: 'L1' });
  const draft = await li.outreach.generate({ leadId: 'L1' });
  const pitch = await li.outreach.update({ pitchId: draft.pitch_id, edits: { subject: 'Fwd: invoice' } });
  await li.outreach.approve({ pitchId: pitch.pitch_id });
  const sup = await suppress(store, 'email', LEAD_EMAIL, { reason: 'manual' });
  await expectRefusal(li, pitch, 'email', 'CONTACT_SUPPRESSED');
  await store.suppressions.removeManual(sup.row.suppression_id);
  await expectRefusal(li, pitch, 'email', 'SENDER_IDENTITY_INCOMPLETE');
  li.outreach.reconfigure({ offer: OFFER });
  await expectRefusal(li, pitch, 'email', 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD');
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await expectRefusal(li, pitch, 'email', 'SUBJECT_MISLEADING');
  assert.strictEqual(emailSpy.calls.length, 0);
  // One blocked row per refusal (the frozen clock gives them one timestamp, so compare as a set;
  // the sequence above already proves the order).
  assert.deepStrictEqual((await blockedRows(li)).map((r) => r.metadata.blockedCode).sort(),
    ['CONTACT_SUPPRESSED', 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD', 'SENDER_IDENTITY_INCOMPLETE', 'SUBJECT_MISLEADING']);
});

test('10b. WhatsApp order: suppression -> identity -> consent -> session, each before any provider', async () => {
  const { li, store, waSpy } = runtime({ offer: { ...OFFER, postal_address: '' } });
  const pitch = await approved(li);
  const sup = await suppress(store, 'whatsapp', LEAD_PHONE, { reason: 'manual' });
  await expectRefusal(li, pitch, 'whatsapp', 'CONTACT_SUPPRESSED');
  await store.suppressions.removeManual(sup.row.suppression_id);
  await expectRefusal(li, pitch, 'whatsapp', 'SENDER_IDENTITY_INCOMPLETE');
  li.outreach.reconfigure({ offer: OFFER });
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_CONSENT_REQUIRED');
  await waConsent(store);
  await expectRefusal(li, pitch, 'whatsapp', 'WHATSAPP_SESSION_CLOSED');
  assert.strictEqual(waSpy.calls.length, 0);
});

test('10c. in source, both boundaries run the trust checks after the recipient and before validate / attempt / provider', () => {
  const src = fs.readFileSync(path.join(LI, 'outreach', 'OutreachService.js'), 'utf8');
  for (const [start, end] of [['async sendEmail(', 'async sendWhatsApp('], ['async sendWhatsApp(', '_sendResult({ pitch, outcome, send, gate, providerStatus = null']]) {
    const body = src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start) + 10));
    const at = (needle) => { const i = body.indexOf(needle); assert.ok(i > 0, start + ' has ' + needle); return i; };
    const trust = at('await this._enforceTrust(');
    assert.ok(at("'CHANNEL_UNAVAILABLE'") < trust, 'after the recipient is resolved');
    assert.ok(trust < at('Provider.validate('), 'before provider validation');
    assert.ok(trust < at('this.store.sends.record('), 'before the durable attempt');
    assert.ok(trust < at('Provider.send('), 'before the provider');
  }
});

test('10d. a store without trust repositories fails CLOSED (TRUST_UNAVAILABLE), never open', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  li.outreach.trust = null;
  await expectRefusal(li, pitch, 'email', 'TRUST_UNAVAILABLE');
  assert.strictEqual(emailSpy.calls.length, 0);
});

/* ============================== Prepare preview ============================== */

test('P. Prepare shows the trust verdict the send will apply - verdicts and dates only, no address, ref or hash', async () => {
  const { li, store } = runtime();
  const pitch = await approved(li);
  const cold = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.deepStrictEqual(Object.keys(cold.trust).sort(), ['allowed', 'code', 'consent', 'handoffAvailable', 'message', 'sessionOpenUntil', 'suppressed', 'verifiedReply']);
  assert.strictEqual(cold.trust.allowed, false);
  assert.strictEqual(cold.trust.code, TRUST_CODES.EMAIL_COLD);
  assert.strictEqual(cold.trust.handoffAvailable, true, 'a cold lead is offered the mail-app handoff');
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const warm = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(warm.trust.allowed, true);
  assert.strictEqual(warm.trust.consent.method, 'website_form');
  await suppress(store, 'email', LEAD_EMAIL);
  const blocked = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(blocked.trust.code, 'CONTACT_SUPPRESSED');
  assert.strictEqual(blocked.trust.handoffAvailable, false, 'never a handoff to a suppressed contact');
  const json = JSON.stringify(blocked.trust);
  assert.ok(!json.includes('@') && !/rref_|sup_|[a-f0-9]{32}/.test(json), json);
  const wa = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(wa.trust.code, 'WHATSAPP_CONSENT_REQUIRED');
  assert.strictEqual(wa.trust.handoffAvailable, false);
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
