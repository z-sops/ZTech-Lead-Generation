'use strict';

// F26.5 - mail-app handoff (frozen corrections 1 and 5), unsubscribe handling (lock item 2) and
// trust-event intake (lock item 8), plus the TrustService user actions (correction 4).

const path = require('path');
const assert = require('assert');

globalThis.fetch = async () => { throw new Error('F26.5 TEST GUARD: real network is forbidden'); };

const LI = path.join(__dirname, '..', 'src', 'main', 'lead-intelligence');
const { validateEmailMessage } = require(path.join(LI, 'outreach', 'email', 'EmailProvider.js'));
const { deriveRelayKeys, recipientRefFor, signEvent } = require(path.join(LI, 'trust', 'relaySignature.js'));
const { unsubscribeHeaders, isValidUnsubscribeHeader, complianceFooter } = require(path.join(LI, 'trust', 'unsubscribe.js'));
const { LeadTimeline } = require(path.join(LI, 'timeline', 'LeadTimeline.js'));
const { grantTrust } = require('./trust-fixture');
const {
  NOW, HOUR, LEAD_EMAIL, LEAD_PHONE, OFFER, lead, runtime, approved, iso, suppress, waConsent,
} = require('./f265-harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const SECRET = 'relay-shared-secret-for-tests-only-0123456789';
const RELAY = 'https://relay.example.test';
const payloadOf = (call) => JSON.parse(call.body);

function opener() {
  const urls = [];
  return { urls, open: async (u) => { urls.push(u); } };
}
function withRelay(li) {
  const keys = deriveRelayKeys(SECRET);
  li.trust.setRelayKeys(keys);
  li.outreach.setRelayLinks({
    linkFor: (channel, address) => {
      const ref = recipientRefFor(keys.refKey, channel, address);
      return ref ? { url: `${RELAY}/u/${ref}`, recipientRef: ref } : null;
    },
  });
  return keys;
}
let seq = 0;
function relayEvent(keys, fields) {
  const e = Object.assign({ event_id: 'rly_' + (++seq), received_at: iso(NOW - HOUR), recipient_ref: null }, fields);
  e.signature = signEvent(keys.signKey, e);
  return e;
}
async function activityTypes(li) {
  return (await li.outreach.activityList({ limit: 100 })).rows.map((r) => r.activity_type);
}

/* =========================== handoff (corrections 1 and 5) =========================== */

test('H1. "Open in my mail app" for a COLD lead: one mailto opened, compliant footer, no send, no Resend call', async () => {
  const o = opener();
  const { li, emailSpy } = runtime({ openExternal: o.open });
  const pitch = await approved(li);
  const r = await li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' });
  assert.strictEqual(o.urls.length, 1);
  assert.ok(o.urls[0].startsWith('mailto:' + LEAD_EMAIL + '?subject='), 'the To address keeps its @ (some mail apps do not decode %40)');
  const body = decodeURIComponent(o.urls[0].split('&body=')[1]);
  assert.strictEqual(body, r.body, 'the mail app gets exactly the text the result reports');
  assert.ok(body.includes(OFFER.sender_company) && body.includes(OFFER.postal_address), 'business name and postal address in the footer');
  assert.ok(/Reply "unsubscribe"/.test(body), 'an opt-out line in the footer');
  assert.strictEqual(r.sent, false);
  assert.strictEqual(r.headersGuaranteed, false, 'correction 5: a handoff cannot promise headers');
  assert.match(r.headerNote, /cannot add the unsubscribe headers/);
  assert.strictEqual(emailSpy.calls.length, 0, 'Resend is never contacted');
  assert.strictEqual((await li.outreach.sendList({ limit: 10 })).total, 0, 'no send-ledger row');
  const types = await activityTypes(li);
  assert.strictEqual(types.filter((t) => t === 'OUTREACH_HANDOFF_CREATED').length, 1);
  assert.ok(!types.some((t) => /^OUTREACH_SEND_/.test(t)), 'correction 1: never a send event');
});

test('H2. "Copy" opens nothing; the same content and kind is recorded once; a different kind is its own row', async () => {
  const o = opener();
  const { li } = runtime({ openExternal: o.open });
  const pitch = await approved(li);
  const a = await li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' });
  await li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' });
  assert.strictEqual(o.urls.length, 0);
  assert.strictEqual(a.to, LEAD_EMAIL);
  let rows = (await li.outreach.activityList({ limit: 100 })).rows.filter((r) => r.activity_type === 'OUTREACH_HANDOFF_CREATED');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(Object.keys(rows[0].metadata).sort(), ['channel', 'contentHash', 'handoffKind']);
  assert.strictEqual(rows[0].metadata.handoffKind, 'copy');
  await li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' });
  rows = (await li.outreach.activityList({ limit: 100 })).rows.filter((r) => r.activity_type === 'OUTREACH_HANDOFF_CREATED');
  assert.strictEqual(rows.length, 2);
});

test('H3. a handoff still honours suppression, identity, subject lint and the gate - and records nothing when refused', async () => {
  const o = opener();
  const cases = [
    ['CONTACT_SUPPRESSED', async (rt) => { await suppress(rt.store, 'email', LEAD_EMAIL); return approved(rt.li); }, {}],
    ['SENDER_IDENTITY_INCOMPLETE', (rt) => approved(rt.li), { offer: { ...OFFER, postal_address: '' } }],
    ['SUBJECT_MISLEADING', async (rt) => {
      await rt.li.research.sync({ leadId: 'L1' });
      const p = await rt.li.outreach.generate({ leadId: 'L1' });
      const e = await rt.li.outreach.update({ pitchId: p.pitch_id, edits: { subject: 'Re: following up' } });
      await rt.li.outreach.approve({ pitchId: e.pitch_id });
      return e;
    }, {}],
    ['NOT_READY', async (rt) => { await rt.li.research.sync({ leadId: 'L1' }); return rt.li.outreach.generate({ leadId: 'L1' }); }, {}],
  ];
  for (const [code, prep, opts] of cases) {
    const rt = runtime({ openExternal: o.open, ...opts });
    const pitch = await prep(rt);
    await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' }), (e) => e.code === code, code);
    assert.ok(!(await activityTypes(rt.li)).includes('OUTREACH_HANDOFF_CREATED'), code + ': nothing recorded');
  }
  assert.strictEqual(o.urls.length, 0, 'no mail app was opened for any refusal');
  const rt = runtime();
  const pitch = await approved(rt.li);
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'mailto' }), (e) => e.code === 'HANDOFF_UNAVAILABLE');
  await assert.rejects(rt.li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'smtp' }), (e) => e.code === 'VALIDATION_FAILED');
});

test('H4. the mailto URL cannot carry injected headers: every part is percent-encoded', async () => {
  const o = opener();
  const { li } = runtime({ openExternal: o.open });
  await li.research.sync({ leadId: 'L1' });
  const p = await li.outreach.generate({ leadId: 'L1' });
  const e = await li.outreach.update({ pitchId: p.pitch_id, edits: { subject: 'Ideas & notes?cc=attacker@evil.test' } });
  await li.outreach.approve({ pitchId: e.pitch_id });
  await li.outreach.handoff({ pitchId: e.pitch_id, kind: 'mailto' });
  const url = o.urls[0];
  assert.strictEqual(url.split('?').length, 2, 'exactly one query separator');
  assert.deepStrictEqual(url.split('?')[1].split('&').map((kv) => kv.split('=')[0]), ['subject', 'body']);
  assert.ok(!/[\r\n]/.test(url));
});

test('H5. the timeline shows a handoff as a handoff - never as sent or delivered', async () => {
  const o = opener();
  const { li, store } = runtime({ openExternal: o.open });
  const pitch = await approved(li);
  await li.outreach.handoff({ pitchId: pitch.pitch_id, kind: 'copy' });
  const leads = { L1: lead({}) };
  const tl = new LeadTimeline({ store, leadSource: { getLead: async (id) => leads[id] || null } });
  const page = await tl.forLead('L1');
  const ev = page.events.find((x) => x.kind === 'OUTREACH_HANDOFF_CREATED');
  assert.ok(ev, 'the handoff is on the timeline');
  assert.match(ev.title, /cannot see whether it was sent/);
});

/* =============================== unsubscribe (lock 2) =============================== */

test('U1. ZTech transport: every email carries List-Unsubscribe (mailto to the sender\'s own mailbox) and the footer', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const p = payloadOf(emailSpy.calls[0]);
  assert.strictEqual(p.headers['List-Unsubscribe'], '<mailto:sender@verified-domain.test?subject=unsubscribe>');
  assert.ok(!('List-Unsubscribe-Post' in p.headers), 'no one-click claim without an HTTPS link (RFC 8058)');
  assert.ok(p.text.includes(OFFER.postal_address) && /Reply "unsubscribe"/.test(p.text));
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.content.finalBody, p.text, 'Prepare shows the exact bytes, footer included');
});

test('U2. with a relay: the one-click HTTPS link + List-Unsubscribe-Post; the ref is kept locally before the send', async () => {
  const { li, store, emailSpy } = runtime();
  const keys = withRelay(li);
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const prep = await li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  assert.ok(prep.content.finalBody.includes(`${RELAY}/u/[personal unsubscribe link]`), 'Prepare shows where the link goes');
  assert.ok(!prep.content.finalBody.includes(ref) && !/rref_/.test(JSON.stringify(prep)), 'the recipient_ref never reaches the renderer');
  assert.strictEqual(await store.recipientRefs.resolve(ref), null, 'Prepare writes nothing');
  await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  const h = payloadOf(emailSpy.calls[0]).headers;
  assert.strictEqual(h['List-Unsubscribe'], `<${RELAY}/u/${ref}>, <mailto:sender@verified-domain.test?subject=unsubscribe>`);
  assert.strictEqual(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(payloadOf(emailSpy.calls[0]).text.includes(`${RELAY}/u/${ref}`), 'the real email carries the real link');
  assert.strictEqual((await store.recipientRefs.resolve(ref)).normalized_address, LEAD_EMAIL, 'resolvable when the click comes back');
});

test('U3. only well-formed unsubscribe headers pass email validation', () => {
  const base = { to: 'a@b.co', from: 'c@d.co', subject: 's', text: 't' };
  const ok = (headers) => validateEmailMessage({ ...base, headers }).valid;
  assert.ok(ok(unsubscribeHeaders({ mailbox: 'c@d.co' })));
  assert.ok(ok(unsubscribeHeaders({ mailbox: 'c@d.co', oneClickUrl: `${RELAY}/u/rref_${'a'.repeat(64)}` })));
  for (const bad of [
    { 'List-Unsubscribe': '<mailto:c@d.co?subject=unsubscribe>\r\nBcc: x@y.z' },
    { 'List-Unsubscribe': '<http://relay.example.test/u/rref_' + 'a'.repeat(64) + '>' },
    { 'List-Unsubscribe': '<mailto:c@d.co?subject=unsubscribe&cc=x@y.z>' },
    { 'List-Unsubscribe-Post': 'List-Unsubscribe=Yes' },
    { Cc: 'x@y.z' },
    { Bcc: 'x@y.z' },
  ]) assert.strictEqual(ok(bad), false, JSON.stringify(bad));
  assert.strictEqual(unsubscribeHeaders({ mailbox: 'not-an-address' }), null);
  assert.strictEqual(isValidUnsubscribeHeader('List-Unsubscribe', '<mailto:c@d.co?subject=unsubscribe>'), true);
  assert.ok(!complianceFooter({ company: '', postalAddress: '' }).includes('undefined'), 'nothing is invented');
});

test('U4. "Mark unsubscribed" suppresses at once (global, recorded as a user event) and the next send is refused', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  const view = await li.trust.suppressLead({ leadId: 'L1', channel: 'email', reason: 'unsubscribe' });
  assert.strictEqual(view.channels.email.suppression.reason, 'unsubscribe');
  assert.strictEqual(view.channels.email.suppression.scope, 'global');
  assert.strictEqual(view.channels.email.suppression.removable, false);
  const ev = (await store.trustEvents.list()).rows[0];
  assert.deepStrictEqual([ev.kind, ev.source, ev.state], ['unsubscribe', 'user', 'applied']);
  await assert.rejects(li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => e.code === 'CONTACT_SUPPRESSED');
  assert.strictEqual(emailSpy.calls.length, 0);
  await assert.rejects(li.trust.liftSuppression({ leadId: 'L1', channel: 'email', suppressionId: view.channels.email.suppression.id }), (e) => e.code === 'SUPPRESSION_NOT_REMOVABLE');
});

test('U5. "Do not contact" (manual) can be scoped to this workspace and lifted by the person', async () => {
  const { li } = runtime();
  const v = await li.trust.suppressLead({ leadId: 'L1', channel: 'whatsapp', reason: 'manual', scope: 'workspace' });
  assert.deepStrictEqual([v.channels.whatsapp.suppression.scope, v.channels.whatsapp.suppression.removable], ['workspace', true]);
  const after = await li.trust.liftSuppression({ leadId: 'L1', channel: 'whatsapp', suppressionId: v.channels.whatsapp.suppression.id });
  assert.strictEqual(after.channels.whatsapp.suppression, null);
});

/* =============================== consent (correction 4) =============================== */

test('C1. consent records method, date, evidence note and the operator as recorder - and refuses the reply shortcut', async () => {
  const { li } = runtime();
  await assert.rejects(li.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'inbound_message', consentedAt: iso(NOW - HOUR), evidenceNote: 'They replied' }),
    (e) => e.code === 'CONSENT_METHOD_NOT_ALLOWED');
  await assert.rejects(li.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'website_form', consentedAt: iso(NOW + 2 * HOUR), evidenceNote: 'Form' }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(li.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'website_form', consentedAt: iso(NOW - HOUR), evidenceNote: ' ' }), (e) => e.code === 'VALIDATION_FAILED');
  await assert.rejects(li.trust.recordConsent({ leadId: 'L1', channel: 'email', method: 'they_replied', consentedAt: iso(NOW - HOUR), evidenceNote: 'x y z' }), (e) => e.code === 'VALIDATION_FAILED');
  const v = await li.trust.recordConsent({ leadId: 'L1', channel: 'whatsapp', method: 'inbound_message', consentedAt: iso(NOW - HOUR), evidenceNote: 'Messaged our WhatsApp from the shop flyer', recordedBy: 'someone-else' });
  assert.deepStrictEqual(v.channels.whatsapp.consent, { method: 'inbound_message', consentedAt: iso(NOW - HOUR), recordedBy: 'local-user', evidenceNote: 'Messaged our WhatsApp from the shop flyer', source: 'user' });
  const json = JSON.stringify(v);
  assert.ok(!json.includes('@') && !json.includes(LEAD_PHONE) && !/rref_|signature/.test(json), 'no address, ref or signature in the view');
});

/* =============================== intake (lock 8) =============================== */

test('I1. a signed relay bounce resolves its recipient_ref locally and suppresses; a repeat is a no-op', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: ref, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 2 * HOUR) });
  const e = relayEvent(keys, { kind: 'bounce', channel: 'email', recipient_ref: ref });
  assert.deepStrictEqual(await li.trust.intake(e, { source: 'relay' }), { accepted: true, state: 'applied' });
  assert.strictEqual((await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL })).reason, 'bounce');
  const again = await li.trust.intake(e, { source: 'relay' });
  assert.strictEqual(again.duplicate, true);
  assert.strictEqual((await store.trustEvents.list()).total, 1);
  assert.strictEqual((await store.suppressions.list()).total, 1);
});

test('I2. a bad signature is refused and recorded, with no effect; the genuine event still lands afterwards', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: ref, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 2 * HOUR) });
  const genuine = relayEvent(keys, { kind: 'complaint', channel: 'email', recipient_ref: ref });
  const forged = { ...genuine, signature: genuine.signature.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) };
  assert.deepStrictEqual(await li.trust.intake(forged, { source: 'relay' }), { accepted: false, state: 'rejected', code: 'BAD_SIGNATURE' });
  const tampered = { ...genuine, kind: 'unsubscribe' };
  assert.strictEqual((await li.trust.intake(tampered, { source: 'relay' })).code, 'BAD_SIGNATURE', 'a signed field changed');
  assert.strictEqual(await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL }), null);
  assert.strictEqual((await store.trustEvents.list()).rows.filter((r) => r.state === 'rejected').length, 2);
  assert.strictEqual((await li.trust.intake(genuine, { source: 'relay' })).state, 'applied');
  assert.strictEqual((await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL })).reason, 'complaint');
});

test('I3. without a relay secret every relay event is refused (RELAY_NOT_CONFIGURED)', async () => {
  const { li, store } = runtime();
  const keys = deriveRelayKeys(SECRET);
  const r = await li.trust.intake(relayEvent(keys, { kind: 'unsubscribe', channel: 'email', recipient_ref: recipientRefFor(keys.refKey, 'email', LEAD_EMAIL) }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: false, state: 'rejected', code: 'RELAY_NOT_CONFIGURED' });
  assert.strictEqual((await store.suppressions.list()).total, 0);
});

test('I4. a relay reply is stored for F28, triggers nothing else, and is the verified prior contact Resend needs', async () => {
  const { li, store, emailSpy } = runtime();
  const keys = withRelay(li);
  const pitch = await approved(li);
  await assert.rejects(li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => e.code === 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD');
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: ref, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 2 * HOUR) });
  assert.deepStrictEqual(await li.trust.intake(relayEvent(keys, { kind: 'reply', channel: 'email', recipient_ref: ref }), { source: 'relay' }), { accepted: true, state: 'stored' });
  assert.strictEqual((await store.suppressions.list()).total, 0);
  assert.strictEqual((await store.consents.listByLead('L1')).length, 0, 'a reply is not turned into a consent');
  const r = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(emailSpy.calls.length, 1);
});

test('I5. a relay WhatsApp inbound (ref computed by the relay, never seen locally) records a consent and opens the 24h window', async () => {
  const { li, store, waSpy } = runtime();
  const keys = withRelay(li);
  const pitch = await approved(li);
  const ref = recipientRefFor(keys.refKey, 'whatsapp', LEAD_PHONE);
  const r = await li.trust.intake(relayEvent(keys, { kind: 'whatsapp_inbound', channel: 'whatsapp', recipient_ref: ref, received_at: iso(NOW - HOUR) }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: true, state: 'applied' });
  const consent = (await store.consents.listByLead('L1'))[0];
  assert.deepStrictEqual([consent.method, consent.source, consent.recorded_by], ['inbound_message', 'relay', 'relay']);
  const v = await li.trust.leadTrust({ leadId: 'L1' });
  assert.strictEqual(v.channels.whatsapp.sessionOpenUntil, iso(NOW + 23 * HOUR));
  const sent = await li.outreach.send({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.strictEqual(sent.outcome, 'accepted');
  assert.strictEqual(waSpy.calls.length, 1);
});

test('I6. an unknown recipient_ref is stored as unresolved with no effect', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const r = await li.trust.intake(relayEvent(keys, { kind: 'unsubscribe', channel: 'email', recipient_ref: 'rref_' + 'f'.repeat(64) }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: true, state: 'unresolved' });
  assert.strictEqual((await store.suppressions.list()).total, 0);
});

test('I7. a user can never enter a reply or an inbound message; malformed or future events are refused', async () => {
  const { li, store } = runtime();
  for (const kind of ['reply', 'whatsapp_inbound']) {
    const channel = kind === 'reply' ? 'email' : 'whatsapp';
    const r = await li.trust.intake({ event_id: 'u_' + kind, kind, channel, address: channel === 'email' ? LEAD_EMAIL : LEAD_PHONE, received_at: iso(NOW) }, { source: 'user' });
    assert.deepStrictEqual(r, { accepted: false, state: 'rejected', code: 'KIND_NOT_USER_RECORDABLE' });
  }
  for (const bad of [{ event_id: 'has space' }, { kind: 'opened' }, { kind: 'whatsapp_inbound', channel: 'email' }, { received_at: iso(NOW + 2 * HOUR) }, { received_at: 'soon' }]) {
    const r = await li.trust.intake(Object.assign({ event_id: 'ok_1', kind: 'bounce', channel: 'email', address: LEAD_EMAIL, received_at: iso(NOW) }, bad), { source: 'user' });
    assert.strictEqual(r.code, 'EVENT_INVALID', JSON.stringify(bad));
  }
  assert.strictEqual((await store.consents.listByLead('L1')).length, 0);
  assert.strictEqual(await store.trustEvents.latestFor({ channel: 'email', address: LEAD_EMAIL, kinds: ['reply'] }), null);
});

test('I8. a manual bounce or complaint entered by the user suppresses globally', async () => {
  const { li, store } = runtime();
  const r = await li.trust.intake({ event_id: 'u_bounce_1', kind: 'bounce', channel: 'email', address: 'HELLO@acme.example.com', received_at: iso(NOW) }, { source: 'user' });
  assert.deepStrictEqual(r, { accepted: true, state: 'applied' });
  const s = await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL });
  assert.deepStrictEqual([s.reason, s.scope, s.source], ['bounce', 'global', 'user']);
});

test('I9. a WhatsApp consent survives intake re-delivery (stable consent id per event and lead)', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const ref = recipientRefFor(keys.refKey, 'whatsapp', LEAD_PHONE);
  const e = relayEvent(keys, { kind: 'whatsapp_inbound', channel: 'whatsapp', recipient_ref: ref });
  await li.trust.intake(e, { source: 'relay' });
  await waConsent(store); // an unrelated manual consent
  await li.trust.intake(e, { source: 'relay' });
  assert.strictEqual((await store.consents.listByLead('L1')).filter((c) => c.source === 'relay').length, 1);
});

test('R1. key rotation: an unsubscribe carrying an old OR a new ref still resolves and suppresses', async () => {
  const { li, store } = runtime();
  const oldKeys = deriveRelayKeys(SECRET);
  const oldRef = recipientRefFor(oldKeys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: oldRef, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - 3 * HOUR) });
  const newKeys = deriveRelayKeys(SECRET + '-rotated');
  li.trust.setRelayKeys(newKeys);
  const newRef = recipientRefFor(newKeys.refKey, 'email', LEAD_EMAIL);
  await store.recipientRefs.ensure({ recipient_ref: newRef, channel: 'email', normalized_address: LEAD_EMAIL, created_at: iso(NOW - HOUR) });
  assert.strictEqual((await store.recipientRefs.resolve(oldRef)).normalized_address, LEAD_EMAIL, 'the old ref still resolves');
  assert.strictEqual((await store.recipientRefs.forAddress({ channel: 'email', address: LEAD_EMAIL })).recipient_ref, newRef, 'the newest ref is current');
  const r = await li.trust.intake(relayEvent(newKeys, { kind: 'unsubscribe', channel: 'email', recipient_ref: oldRef }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: true, state: 'applied' });
});

test('R2. an email ref this desktop never stored (link minted under another key) is resolved from the lead list', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const ref = recipientRefFor(keys.refKey, 'email', LEAD_EMAIL);
  assert.strictEqual(await store.recipientRefs.resolve(ref), null);
  const r = await li.trust.intake(relayEvent(keys, { kind: 'unsubscribe', channel: 'email', recipient_ref: ref }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: true, state: 'applied' });
  assert.ok(await store.suppressions.find({ channel: 'email', address: LEAD_EMAIL }));
});

test('R3. a relay event from a clock ahead of this desktop is ACCEPTED (an opt-out is never lost) and clamped to now', async () => {
  const { li, store } = runtime();
  const keys = withRelay(li);
  const ref = recipientRefFor(keys.refKey, 'whatsapp', LEAD_PHONE);
  const r = await li.trust.intake(relayEvent(keys, { kind: 'whatsapp_inbound', channel: 'whatsapp', recipient_ref: ref, received_at: iso(NOW + 6 * HOUR) }), { source: 'relay' });
  assert.deepStrictEqual(r, { accepted: true, state: 'applied' });
  const ev = (await store.trustEvents.list()).rows[0];
  assert.strictEqual(ev.received_at, iso(NOW), 'clamped: a future time can never stretch the 24h window');
  const user = await li.trust.intake({ event_id: 'u_future', kind: 'bounce', channel: 'email', address: LEAD_EMAIL, received_at: iso(NOW + 6 * HOUR) }, { source: 'user' });
  assert.strictEqual(user.code, 'EVENT_INVALID', 'a user event still cannot claim the future');
});

test('R4. timestamps must be UTC ISO with Z: a zone-less time is refused', async () => {
  const { li } = runtime();
  const keys = withRelay(li);
  const e = relayEvent(keys, { kind: 'reply', channel: 'email', recipient_ref: recipientRefFor(keys.refKey, 'email', LEAD_EMAIL), received_at: '2026-10-07T09:00:00' });
  assert.strictEqual((await li.trust.intake(e, { source: 'relay' })).code, 'EVENT_INVALID');
});

test('R5. a consent dated "today" in Karachi before 05:00 is accepted; a date after today anywhere is refused', async () => {
  const { li } = runtime({ now: () => Date.parse('2026-10-07T21:30:00.000Z') }); // 02:30 on 8 Oct in Karachi
  const v = await li.trust.recordConsent({ leadId: 'L1', channel: 'whatsapp', method: 'in_person', consentedAt: '2026-10-08', evidenceNote: 'Signed up at our stall this morning' });
  assert.strictEqual(v.channels.whatsapp.consent.consentedAt, '2026-10-08T12:00:00.000Z', 'stored as noon UTC: the same calendar day from UTC-11 to UTC+11');
  await assert.rejects(li.trust.recordConsent({ leadId: 'L1', channel: 'whatsapp', method: 'in_person', consentedAt: '2026-10-10', evidenceNote: 'too early' }), (e) => e.code === 'VALIDATION_FAILED');
});

test('R6. a transport that enforces unsubscribe headers never sends without them', async () => {
  const { li, store, emailSpy } = runtime();
  const pitch = await approved(li);
  await grantTrust(store, { email: LEAD_EMAIL, now: iso(NOW) });
  // Simulate an unusable mailbox by making the capability's From address unparseable for the header builder.
  li.outreach.emailConfigStore().data.settings.emailReplyTo = undefined;
  const cap = li.outreach.sendCapability.bind(li.outreach);
  li.outreach.sendCapability = (ch) => (ch === 'email' ? { ...cap(ch), fromAddress: 'not-a-mailbox' } : cap(ch));
  await assert.rejects(li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email' }), (e) => e.code === 'UNSUBSCRIBE_HEADERS_UNAVAILABLE');
  assert.strictEqual(emailSpy.calls.length, 0);
});

test('R7. the handoff IPC result never carries the body (it can hold the personal unsubscribe link)', async () => {
  const { registerTrustIpc, TRUST_CHANNELS_IPC } = require(path.join(LI, 'trust', 'trust-ipc.js'));
  const o = opener();
  const { li } = runtime({ openExternal: o.open });
  withRelay(li);
  const pitch = await approved(li);
  const handlers = {};
  const copied = [];
  registerTrustIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, trust: li.trust, outreach: li.outreach, isTrustedSender: () => true, copyText: (t) => copied.push(t), logger: { warn() {} } });
  const res = await handlers[TRUST_CHANNELS_IPC.HANDOFF]({}, { pitchId: pitch.pitch_id, kind: 'copy' });
  assert.strictEqual(res.ok, true);
  assert.ok(!('body' in res.data) && !/rref_/.test(JSON.stringify(res)), 'nothing with a ref reaches the renderer');
  assert.ok(/\/u\/rref_/.test(copied[0]), 'main copied the real text, link included');
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
