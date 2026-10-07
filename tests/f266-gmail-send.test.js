'use strict';

// F26.6 - Gmail transport (after the Step 1A live pass): Check mailbox, the connected-mailbox send
// boundary with every gate, provider-STORED Message-ID read-back, and headers-only reply sync into
// the trust intake. Work-order tests 2-8. Everything runs against a FAKE Gmail that behaves the way
// Step 1A observed the real one: it REPLACES the supplied Message-ID, keeps List-Unsubscribe, and a
// real reply cites the STORED id. No live call is made.

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { GoogleOAuth, GOOGLE, GMAIL_SCOPES } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { buildRawMessage, parseMessageIds, parseFromAddress, mailboxEventId, encodeWord } = require(path.join(LI, 'mailbox', 'gmail', 'rfc2822.js'));
const { MAILBOX_DEFAULTS } = require(path.join(LI, 'mailbox', 'mailboxContract.js'));
const { INPUT_SCHEMAS, CHANNELS } = require(path.join(LI, 'outreach-ipc.js'));
const { LEAD_EMAIL, runtime, approved, iso, NOW, HOUR, allowMarket, suppress, lead } = require('./f265-harness');
const { grantTrust } = require('./trust-fixture');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const MBX = 'mbx_aaaaaaaaaaaaaaaaaaaaaaaa';
const MBX_ADDR = 'dana@ridgeline.example';
const CLIENT = { clientId: '1234567890-abcdefg.apps.googleusercontent.com', clientSecret: 'GOCSPX-never-leaks' };
const REFRESH = '1//refresh-never-leaks';
const ACCESS = 'ya29.access-never-leaks';

/** A fake Gmail with the behaviour Step 1A observed. */
function fakeGmail({ stripListUnsubscribe = false, readBackFails = false, sendStatus = 200, storedIdMissing = false, pageSize = 0, apiStatus = 0 } = {}) {
  const st = { sent: [], messages: new Map(), history: [], historyId: '500', calls: [], n: 0, failMeta: new Set(), apiStatus, sendStatus };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const parse = (raw) => {
    const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const [head, ...rest] = text.split('\r\n\r\n');
    const headers = {};
    for (const line of head.split('\r\n')) { const i = line.indexOf(':'); headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
    return { headers, text, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
  };
  st.fetch = async (url, init = {}) => {
    const u = String(url);
    st.calls.push({ url: u, method: init.method || 'GET', auth: init.headers && init.headers.Authorization });
    if (u === GOOGLE.TOKEN_URL) return json(200, { access_token: ACCESS, scope: GMAIL_SCOPES.join(' '), expires_in: 3599 });
    if (u.startsWith(GOOGLE.REVOKE_URL)) return json(200, {});
    assert.strictEqual(init.headers.Authorization, `Bearer ${ACCESS}`, 'every Gmail call carries the access token');
    const api = u.slice(GOOGLE.GMAIL_API.length);
    if (st.apiStatus) return json(st.apiStatus, { error: { errors: [{ reason: 'authError', message: 'REMOTE TEXT' }] } });
    if (api === '/profile') return json(200, { emailAddress: MBX_ADDR, historyId: st.historyId });
    if (api === '/messages/send') {
      if (st.sendStatus !== 200) return json(st.sendStatus, { error: { errors: [{ reason: 'userRateLimitExceeded', message: 'REMOTE TEXT' }] } });
      const m = parse(JSON.parse(init.body).raw);
      st.n += 1;
      const id = `msg${st.n}`;
      const stored = { ...m.headers, 'message-id': `<CAstored-${st.n}@mail.gmail.com>` }; // Gmail REPLACES it
      if (storedIdMissing) delete stored['message-id'];
      if (stripListUnsubscribe) delete stored['list-unsubscribe'];
      st.sent.push({ id, ...m });
      st.messages.set(id, { headers: stored, labelIds: ['SENT'], threadId: `t${st.n}` });
      return json(200, { id, threadId: `t${st.n}`, labelIds: ['SENT'] });
    }
    let m = api.match(/^\/messages\/([A-Za-z0-9_-]+)\?format=metadata&(.*)$/);
    if (m) {
      if (readBackFails || st.failMeta.has(m[1])) return json(503, {});
      const msg = st.messages.get(m[1]);
      if (!msg) return json(404, {});
      const names = [...m[2].matchAll(/metadataHeaders=([^&]+)/g)].map((x) => decodeURIComponent(x[1]).toLowerCase());
      const headers = names.filter((n) => msg.headers[n] !== undefined).map((n) => ({ name: n, value: msg.headers[n] }));
      return json(200, { id: m[1], threadId: msg.threadId, labelIds: msg.labelIds, payload: { headers } });
    }
    m = api.match(/^\/history\?(.*)$/);
    if (m) {
      const q = new URLSearchParams(m[1]);
      if (q.get('startHistoryId') === '1') return json(404, {}); // older than Gmail keeps
      let after = st.history.filter((h) => Number(h.id) > Number(q.get('startHistoryId')));
      const offset = q.get('pageToken') ? Number(q.get('pageToken').slice(1)) : 0;
      let next;
      if (pageSize) { next = offset + pageSize < after.length ? `p${offset + pageSize}` : undefined; after = after.slice(offset, offset + pageSize); }
      return json(200, { history: after.map((h) => ({ id: h.id, messagesAdded: [{ message: { id: h.msgId, labelIds: h.labelIds } }] })), historyId: st.historyId, ...(next ? { nextPageToken: next } : {}) });
    }
    return json(404, {});
  };
  /** Deliver an inbound message (as Gmail would) and record it in history. */
  st.deliver = (id, headers, labelIds = ['INBOX', 'UNREAD']) => {
    st.messages.set(id, { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), labelIds, threadId: 'tx' });
    st.historyId = String(Number(st.historyId) + 1);
    st.history.push({ id: st.historyId, msgId: id, labelIds });
  };
  return st;
}

/** The f265 runtime (real LI, real stores, real trust) + a real MailboxService on the fake Gmail. */
async function setup({ gmail = fakeGmail(), ready = true, leads, now } = {}) {
  const rt = runtime({ ...(leads ? { leads } : {}), ...(now ? { now } : {}) });
  const tokens = new Map([[MBX, REFRESH]]);
  const svc = new MailboxService({
    store: rt.store, clock: () => new Date(now ? now() : NOW), fetch: gmail.fetch, trust: rt.li.trust,
    tokenStore: { get: (id) => tokens.get(id) || null, set: (id, t) => tokens.set(id, t), remove: (id) => tokens.delete(id) },
    clientConfig: { get: () => CLIENT, set() {}, clear() {} },
    googleOAuth: new GoogleOAuth({ fetch: gmail.fetch, openExternal: () => {} }),
    operator: 'Zee', defaultTimeZone: 'Asia/Karachi',
  });
  rt.li.outreach.setMailboxes(svc);
  const at = iso(NOW - 2 * HOUR);
  await rt.store.mailboxes.upsert({
    mailbox_id: MBX, provider: 'gmail', email_address: MBX_ADDR, display_name: null, status: ready ? 'ready' : 'needs_check',
    status_code: ready ? null : 'MAILBOX_CHECK_REQUIRED', paused_until: null, ...MAILBOX_DEFAULTS, time_zone: 'Asia/Karachi',
    is_default: 1, sync_cursor: '500', connected_at: at, updated_at: at,
  });
  return { ...rt, svc, gmail, tokens };
}

const sendCalls = (g) => g.calls.filter((c) => c.url.endsWith('/messages/send'));
const blocked = async (li) => (await li.outreach.activityList({ limit: 50 })).rows.filter((r) => r.activity_type === 'OUTREACH_SEND_BLOCKED').map((r) => r.metadata.blockedCode || r.metadata.reason);

/* ================================== pure helpers ================================== */

test('0. the raw message: From = mailbox, encoded subject, base64 body, NO Message-ID, header injection refused', () => {
  const raw = buildRawMessage({ from: MBX_ADDR, fromName: 'Dana "D" Smith', to: 'a@b.example', subject: 'Karachi café audit', text: 'Hello\nworld', headers: { 'List-Unsubscribe': '<mailto:x@y.example?subject=unsubscribe>' }, date: new Date('2026-10-07T10:00:00Z') });
  assert.ok(raw.startsWith('From: "Dana \\"D\\" Smith" <dana@ridgeline.example>\r\nTo: a@b.example\r\nSubject: =?UTF-8?B?'));
  assert.ok(raw.includes('\r\nDate: Wed, 07 Oct 2026 10:00:00 +0000\r\n'));
  assert.ok(!/^message-id:/im.test(raw), 'ZTech never supplies a Message-ID');
  assert.ok(raw.includes('Content-Transfer-Encoding: base64\r\n\r\nSGVsbG8Kd29ybGQ=\r\n'));
  assert.throws(() => buildRawMessage({ from: MBX_ADDR, to: 'a@b.example', subject: 's', text: 't', headers: { 'Message-ID': '<x@y>' } }), /never supplied/);
  assert.throws(() => buildRawMessage({ from: MBX_ADDR, to: 'a@b.example\r\nBcc: z@z', subject: 's', text: 't' }), /single line/);
  assert.strictEqual(encodeWord('plain'), 'plain');
  assert.deepStrictEqual(parseMessageIds('<a@x> <b@y>\r\n <c@z>'), ['<a@x>', '<b@y>', '<c@z>']);
  assert.strictEqual(parseFromAddress('"Owner" <Owner@Acme.Example.com>'), 'owner@acme.example.com');
  assert.ok(/^gm_[a-f0-9]{40}$/.test(mailboxEventId(MBX, 'msg1')));
  assert.strictEqual(mailboxEventId(MBX, 'msg1'), mailboxEventId(MBX, 'msg1'), 'stable: a re-read is a duplicate');
});

/* ================================== Check mailbox ================================== */

test('2a. Check mailbox: ONE self-message, stored copy read back; List-Unsubscribe kept + readable Message-ID -> Ready', async () => {
  const s = await setup({ ready: false });
  const r = await s.svc.check({ mailboxId: MBX });
  assert.deepStrictEqual(r.check, { passed: true, listUnsubscribeKept: true, storedMessageIdReadable: true });
  assert.strictEqual(r.mailbox.status, 'ready');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  const sent = s.gmail.sent[0];
  assert.strictEqual(sent.headers.to, MBX_ADDR, 'to itself - never to a lead');
  assert.strictEqual(sent.headers['list-unsubscribe'], `<mailto:${MBX_ADDR}?subject=unsubscribe>`);
  assert.ok(!('message-id' in sent.headers), 'no supplied Message-ID');
  await assert.rejects(s.svc.check({ mailboxId: MBX }), (e) => e.code === 'MAILBOX_CHECK_TOO_SOON');
  assert.strictEqual(sendCalls(s.gmail).length, 1, 'nothing sent by the refused second click');
});

test('2b. Check mailbox fails closed: a stripped List-Unsubscribe keeps the mailbox out of Ready', async () => {
  const s = await setup({ ready: false, gmail: fakeGmail({ stripListUnsubscribe: true }) });
  const r = await s.svc.check({ mailboxId: MBX });
  assert.strictEqual(r.check.passed, false);
  assert.strictEqual(r.mailbox.status, 'needs_check');
  assert.strictEqual(r.mailbox.statusCode, 'MAILBOX_HEADER_STRIPPED');
});

/* ============================== the mailbox send boundary ============================== */

test('3a. a send from the mailbox: every gate passes, ONE Gmail call, no Message-ID supplied, the STORED id persisted', async () => {
  const s = await setup();
  await allowMarket(s.store);
  const pitch = await approved(s.li);
  const r = await s.li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r.outcome, 'accepted');
  assert.strictEqual(r.providerId, 'gmail');
  assert.strictEqual(r.providerMessageId, 'msg1', "Gmail's own message id");
  assert.strictEqual(r.replyMatching, 'ready');
  assert.strictEqual(r.unsubscribeHeadersKept, true);
  assert.strictEqual(r.deliveryStatus, 'unknown');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  assert.strictEqual(s.emailSpy.calls.length, 0, 'the transactional provider is never touched');
  const sent = s.gmail.sent[0];
  assert.strictEqual(sent.headers.from, MBX_ADDR.replace(/^/, '"Ridgeline Supply" <') + '>');
  assert.strictEqual(sent.headers.to, LEAD_EMAIL);
  assert.ok(!('message-id' in sent.headers));
  assert.strictEqual(sent.headers['list-unsubscribe'], `<mailto:${MBX_ADDR}?subject=unsubscribe>`, 'opt-outs go to the mailbox itself');
  assert.ok(sent.body.includes('Ridgeline Supply') && sent.body.includes('Reply "unsubscribe"'), 'the compliance footer');
  const row = await s.store.sends.get(r.sendId);
  assert.strictEqual(row.mailbox_id, MBX);
  assert.strictEqual(row.state, 'accepted');
  const stored = await s.store.mailboxSent.get(r.sendId);
  assert.strictEqual(stored.stored_message_id, '<CAstored-1@mail.gmail.com>', 'the provider-STORED id, never the attempted one');
  assert.strictEqual(stored.provider_message_id, 'msg1');
  const json = JSON.stringify(r);
  assert.ok(!json.includes(ACCESS) && !json.includes(REFRESH) && !json.includes(CLIENT.clientSecret));
});

test('3b. gates, in order, each refusing BEFORE Gmail: not Ready, market, suppression, pacing; replays contact nobody', async () => {
  const notReady = await setup({ ready: false });
  await allowMarket(notReady.store);
  const p0 = await approved(notReady.li);
  await assert.rejects(notReady.li.outreach.send({ pitchId: p0.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_NOT_READY');
  assert.deepStrictEqual(await blocked(notReady.li), ['MAILBOX_NOT_READY']);

  const cold = await setup({ leads: { L1: lead({ country: 'Atlantis' }) } });
  const p1 = await approved(cold.li);
  await assert.rejects(cold.li.outreach.send({ pitchId: p1.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MARKET_CONSENT_REQUIRED');
  assert.strictEqual(sendCalls(cold.gmail).length, 0, 'the transport allows cold email; the market gate still decides');

  const sup = await setup();
  await allowMarket(sup.store);
  await suppress(sup.store, 'email', LEAD_EMAIL.toLowerCase());
  const p2 = await approved(sup.li);
  await assert.rejects(sup.li.outreach.send({ pitchId: p2.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'CONTACT_SUPPRESSED');
  assert.strictEqual(sendCalls(sup.gmail).length, 0);

  const paced = await setup({ leads: { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) } });
  await allowMarket(paced.store);
  const a = await approved(paced.li, 'L1');
  const b = await approved(paced.li, 'L2');
  await paced.li.outreach.send({ pitchId: a.pitch_id, channel: 'email', mailboxId: MBX });
  const replay = await paced.li.outreach.send({ pitchId: a.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(replay.outcome, 'replayed', 'the same content is never sent twice');
  await assert.rejects(paced.li.outreach.send({ pitchId: b.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_PACING' && /Nothing was queued/.test(e.message));
  assert.strictEqual(sendCalls(paced.gmail).length, 1, 'one click = one message; the paced click sent nothing and queued nothing');

  const wa = await setup();
  const p3 = await approved(wa.li);
  await assert.rejects(wa.li.outreach.send({ pitchId: p3.pitch_id, channel: 'whatsapp', mailboxId: MBX }), (e) => e.code === 'VALIDATION_FAILED');
});

test('3c. one send per mailbox at a time: a second click while Gmail is answering is refused (MAILBOX_BUSY)', async () => {
  const s = await setup({ leads: { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) } });
  await allowMarket(s.store);
  const a = await approved(s.li, 'L1');
  const b = await approved(s.li, 'L2');
  const [ra, rb] = await Promise.allSettled([
    s.li.outreach.send({ pitchId: a.pitch_id, channel: 'email', mailboxId: MBX }),
    s.li.outreach.send({ pitchId: b.pitch_id, channel: 'email', mailboxId: MBX }),
  ]);
  const codes = [ra, rb].map((x) => (x.status === 'fulfilled' ? 'accepted' : x.reason.code)).sort();
  assert.ok(codes[0] === 'MAILBOX_BUSY' || codes[0] === 'MAILBOX_PACING', codes.join(','));
  assert.strictEqual(codes[1], 'accepted');
  assert.strictEqual(sendCalls(s.gmail).length, 1);
});

test('3d. read-back problems never fake a match: unreadable -> replyMatching unavailable; stripped header -> mailbox leaves Ready', async () => {
  const fail = await setup({ gmail: fakeGmail({ readBackFails: true }) });
  await allowMarket(fail.store);
  const p = await approved(fail.li);
  const r = await fail.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r.outcome, 'accepted', 'the message did go out');
  assert.strictEqual(r.replyMatching, 'unavailable');
  assert.strictEqual((await fail.store.mailboxSent.get(r.sendId)).stored_message_id, null);

  const strip = await setup({ gmail: fakeGmail({ stripListUnsubscribe: true }) });
  await allowMarket(strip.store);
  const p2 = await approved(strip.li);
  const r2 = await strip.li.outreach.send({ pitchId: p2.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r2.unsubscribeHeadersKept, false);
  const m = await strip.store.mailboxes.get(MBX);
  assert.strictEqual(m.status, 'needs_check');
  assert.strictEqual(m.status_code, 'MAILBOX_HEADER_STRIPPED');
});

test('3e. a Gmail refusal is recorded as failed with ZTech text only; nothing is retried', async () => {
  const s = await setup({ gmail: fakeGmail({ sendStatus: 429 }) });
  await allowMarket(s.store);
  const p = await approved(s.li);
  await assert.rejects(s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_PROVIDER_LIMIT' && !/REMOTE TEXT/.test(e.message));
  assert.strictEqual(sendCalls(s.gmail).length, 1);
  const rows = (await s.store.sends.list({ limit: 5 })).rows;
  assert.strictEqual(rows[0].state, 'failed');
  assert.strictEqual(rows[0].mailbox_id, MBX);
});

test('3f. Prepare shows the mailbox line: the sanitized mailbox, its gate and the trust verdict under the mailbox policy', async () => {
  const s = await setup();
  const pitch = await approved(s.li);
  let prep = await s.li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.mailbox.mailbox.emailAddress, MBX_ADDR);
  assert.strictEqual(prep.mailbox.gate.allowed, true);
  assert.deepStrictEqual(prep.mailbox.trust, { allowed: false, code: 'MARKET_CONSENT_REQUIRED', message: prep.mailbox.trust.message });
  assert.strictEqual(prep.mailbox.canSend, false);
  await allowMarket(s.store);
  prep = await s.li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'email' });
  assert.strictEqual(prep.mailbox.canSend, true, 'a reviewed opt-out market + Ready mailbox + pacing room');
  assert.strictEqual(prep.trust.code, 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD', 'the transactional provider keeps its own rule');
  assert.strictEqual(sendCalls(s.gmail).length, 0, 'Prepare sends nothing');
  const wa = await s.li.outreach.prepare({ pitchId: pitch.pitch_id, channel: 'whatsapp' });
  assert.ok(!('mailbox' in wa), 'no mailbox line on WhatsApp');
  assert.ok(!/ya29|1\/\/|GOCSPX|rref_/.test(JSON.stringify(prep.mailbox)));
});

test('3h. the Gmail transport only ever sends AS the connected mailbox, with List-Unsubscribe', async () => {
  const s = await setup();
  const t = await s.svc.transportFor(MBX);
  const base = { to: LEAD_EMAIL, from: MBX_ADDR, subject: 'Hi', text: 'Body', headers: { 'List-Unsubscribe': `<mailto:${MBX_ADDR}?subject=unsubscribe>` } };
  assert.strictEqual(t.validate(base).valid, true);
  assert.strictEqual(t.validate({ ...base, from: 'someone-else@ridgeline.example' }).valid, false, 'never another From');
  assert.strictEqual(t.validate({ ...base, headers: {} }).valid, false, 'never without List-Unsubscribe');
  assert.deepStrictEqual({ ...t.transportPolicy }, { requiresPriorRelationship: false, enforcesUnsubscribeHeaders: true });
  await assert.rejects(t.send({ ...base, from: 'someone-else@ridgeline.example' }), (e) => e.code === 'VALIDATION_FAILED');
  assert.strictEqual(sendCalls(s.gmail).length, 0);
});

test('3g. the send IPC admits only an optional mailbox id - never an address, token or provider', () => {
  const schema = INPUT_SCHEMAS[CHANNELS.OUTREACH_SEND];
  assert.strictEqual(schema.additionalProperties, false);
  assert.deepStrictEqual(Object.keys(schema.properties), ['pitchId', 'channel', 'mailboxId']);
  assert.ok(schema.properties.mailboxId.pattern.test(MBX));
  assert.ok(!schema.properties.mailboxId.pattern.test('dana@ridgeline.example'));
});

/* ================================== reply sync ================================== */

async function sentOnce() {
  const s = await setup();
  await allowMarket(s.store);
  const p = await approved(s.li);
  const r = await s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX });
  return { ...s, pitch: p, send: r };
}

test('4a. a real reply cites the STORED id -> verified reply (source mailbox); the attempted id or "same sender" never count', async () => {
  const s = await sentOnce();
  s.gmail.deliver('in1', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Re: hello', 'In-Reply-To': '<ztech-attempted@ridgeline.example>' });
  s.gmail.deliver('in2', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Another thing' });
  let sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.replies, 0);
  assert.strictEqual(sum.unmatched, 1);
  assert.strictEqual((await s.li.trust.leadTrust({ leadId: 'L1' })).channels.email.verifiedReply, null);
  s.gmail.deliver('in3', { From: `"Owner" <${LEAD_EMAIL}>`, Subject: 'Re: hello', 'In-Reply-To': '<CAstored-1@mail.gmail.com>', References: '<CAstored-1@mail.gmail.com>' });
  sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.replies, 1);
  const lt = await s.li.trust.leadTrust({ leadId: 'L1' });
  assert.ok(lt.channels.email.verifiedReply, 'the verified reply is on the lead');
  assert.strictEqual((await s.store.mailboxes.get(MBX)).sync_cursor, s.gmail.historyId, 'the cursor moved past what was read');
  const again = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(again.read, 0, 'nothing is read twice');
});

test('4b. an "unsubscribe" reply suppresses at once (source mailbox) and the next send is refused', async () => {
  const s = await sentOnce();
  s.gmail.deliver('u1', { From: LEAD_EMAIL, Subject: 'unsubscribe' });
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.unsubscribes, 1);
  const sup = await s.store.suppressions.find({ channel: 'email', address: LEAD_EMAIL.toLowerCase(), workspaceId: 'default' });
  assert.strictEqual(sup.source, 'mailbox');
  const p2 = await s.li.outreach.update({ pitchId: s.pitch.pitch_id, edits: { subject: 'A second idea' } });
  await s.li.outreach.approve({ pitchId: p2.pitch_id });
  await assert.rejects(s.li.outreach.send({ pitchId: p2.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'CONTACT_SUPPRESSED');
});

test('4c. headers-only: auto-replies and delivery reports are skipped (bounces deferred); sent mail and own messages are ignored', async () => {
  const s = await sentOnce();
  const cite = { 'In-Reply-To': '<CAstored-1@mail.gmail.com>' };
  s.gmail.deliver('a1', { From: LEAD_EMAIL, Subject: 'Out of office', 'Auto-Submitted': 'auto-replied', ...cite });
  s.gmail.deliver('a2', { From: LEAD_EMAIL, Subject: 'Away', 'X-Autoreply': 'yes', ...cite });
  s.gmail.deliver('d1', { From: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', Subject: 'Delivery Status Notification (Failure)', 'Content-Type': 'multipart/report; report-type=delivery-status', ...cite });
  s.gmail.deliver('s1', { From: MBX_ADDR, Subject: 'Re: hello', ...cite }, ['SENT']);
  s.gmail.deliver('o1', { From: MBX_ADDR, Subject: 'note to self', ...cite });
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.skippedAutomatic, 2);
  assert.strictEqual(sum.skippedDeliveryReports, 1);
  assert.strictEqual(sum.replies, 0);
  assert.strictEqual(await s.store.suppressions.find({ channel: 'email', address: LEAD_EMAIL.toLowerCase(), workspaceId: 'default' }), null, 'a delivery report never suppresses here');
  const metaReads = s.gmail.calls.filter((c) => /\/messages\/(a1|a2|d1|s1|o1)\?/.test(c.url)).length;
  assert.strictEqual(metaReads, 4, 'SENT-labelled messages are not even read');
  assert.ok(s.gmail.calls.every((c) => !/format=(full|raw)/.test(c.url)), 'never a body');
});

test('4d. an expired cursor restarts from now and SAYS so - no reply is ever invented for the gap', async () => {
  const s = await sentOnce();
  await s.store.mailboxes.setSyncCursor(MBX, '1', iso(NOW));
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.cursorReset, true);
  assert.strictEqual((await s.store.mailboxes.get(MBX)).sync_cursor, s.gmail.historyId);
});

test('4e. syncAll reads every Gmail mailbox, never sends, and a revoked grant marks the mailbox "Reconnect needed"', async () => {
  const s = await sentOnce();
  const before = sendCalls(s.gmail).length;
  s.tokens.delete(MBX);
  const out = await s.svc.syncAll();
  assert.deepStrictEqual(out, [{ mailboxId: MBX, error: 'MAILBOX_RECONNECT_NEEDED' }]);
  assert.strictEqual((await s.store.mailboxes.get(MBX)).status, 'reconnect_needed');
  assert.strictEqual(sendCalls(s.gmail).length, before, 'sync never sends');
  const p = await approved(s.li);
  await assert.rejects(s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_NOT_READY');
});

/* ============================ independent-review fixes ============================ */

test('5a. a spoofed display name cannot pick the address, and only the person written to can verify a reply', async () => {
  assert.strictEqual(parseFromAddress('"\\"<ceo@big.co>\\" x" <x@evil.example>'), 'x@evil.example');
  assert.strictEqual(parseFromAddress('"<ceo@big.co>" <x@evil.example>'), 'x@evil.example');
  assert.strictEqual(parseFromAddress('x@evil.example (<ceo@big.co>)'), 'x@evil.example');
  assert.strictEqual(parseFromAddress('nonsense <ceo@big.co'), null);
  assert.strictEqual(parseFromAddress('<x@evil.example> "<ceo@big.co>"'), 'x@evil.example', 'an address inside a quoted string never counts');
  const s = await sentOnce();
  const cite = { 'In-Reply-To': '<CAstored-1@mail.gmail.com>' };
  s.gmail.deliver('sp1', { From: '"<ceo@big.co>" <x@evil.example>', Subject: 'Re: hello', ...cite });
  s.gmail.deliver('fw1', { From: 'colleague@acme.example.com', Subject: 'Re: hello', ...cite });
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.replies, 0);
  for (const a of ['ceo@big.co', 'x@evil.example', 'colleague@acme.example.com']) {
    assert.strictEqual(await s.store.trustEvents.latestFor({ channel: 'email', address: a, kinds: ['reply'] }).then((e) => e && e.state !== 'rejected' ? e : null), null, a);
  }
});

test('5b. one in-flight send per content across transports: the configured provider and the mailbox never both send', async () => {
  const s = await setup();
  await allowMarket(s.store);
  await grantTrust(s.store, { email: LEAD_EMAIL, now: iso(NOW - HOUR) }); // so the transactional provider may send too
  const p = await approved(s.li);
  const results = await Promise.allSettled([
    s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX }),
    s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email' }),
  ]);
  const contacted = sendCalls(s.gmail).length + s.emailSpy.calls.length;
  assert.strictEqual(contacted, 1, 'exactly one provider was contacted: ' + results.map((x) => x.status === 'fulfilled' ? x.value.outcome : x.reason.code).join(','));
  const after = await s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(after.outcome, 'replayed');
});

test('5c. tokens: one refresh serves a whole sync; Gmail refusing the grant marks the mailbox "Reconnect needed"', async () => {
  const s = await sentOnce();
  const tokenCalls = () => s.gmail.calls.filter((c) => c.url === GOOGLE.TOKEN_URL).length;
  const before = tokenCalls();
  for (let i = 0; i < 3; i += 1) s.gmail.deliver(`r${i}`, { From: LEAD_EMAIL, Subject: 'Re: hello', 'In-Reply-To': '<CAstored-1@mail.gmail.com>' });
  await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(tokenCalls() - before, 0, 'the access token from the send is reused (cached in memory, main only)');
  s.gmail.apiStatus = 401;
  await assert.rejects(s.svc.syncReplies({ mailboxId: MBX }), (e) => e.code === 'MAILBOX_RECONNECT_NEEDED' && !/REMOTE TEXT/.test(e.message));
  assert.strictEqual((await s.store.mailboxes.get(MBX)).status, 'reconnect_needed');
});

test('5d. "Check replies now" and the timer share ONE run per mailbox (never two cursors in flight)', async () => {
  const s = await sentOnce();
  s.gmail.deliver('c1', { From: LEAD_EMAIL, Subject: 'Re: hello', 'In-Reply-To': '<CAstored-1@mail.gmail.com>' });
  const [a, b] = await Promise.all([s.svc.syncReplies({ mailboxId: MBX }), s.svc.syncAll()]);
  assert.strictEqual(a.read, 1);
  assert.strictEqual(b[0].read, 1, 'the same run, not a second one');
  assert.strictEqual(s.gmail.calls.filter((c) => /\/messages\/c1\?/.test(c.url)).length, 1);
});

test('5e. pagination: the cursor moves page by page; an interrupted run resumes without skipping or double-counting', async () => {
  const s = await setup({ gmail: fakeGmail({ pageSize: 2 }) });
  await allowMarket(s.store);
  const p = await approved(s.li);
  await s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX });
  for (let i = 0; i < 5; i += 1) s.gmail.deliver(`pg${i}`, { From: LEAD_EMAIL, Subject: i === 4 ? 'unsubscribe' : 'Re: hello', 'In-Reply-To': '<CAstored-1@mail.gmail.com>' });
  s.gmail.failMeta.add('pg3'); // page 2 breaks mid-run
  await assert.rejects(s.svc.syncReplies({ mailboxId: MBX }), (e) => e.code === 'MAILBOX_PROVIDER_UNAVAILABLE');
  const page1End = s.gmail.history.find((h) => h.msgId === 'pg1').id;
  assert.strictEqual((await s.store.mailboxes.get(MBX)).sync_cursor, page1End, 'the cursor stops after the last COMPLETE page');
  s.gmail.failMeta.clear();
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.read, 3, 'only pg2-pg4 are read again');
  assert.strictEqual(sum.unsubscribes, 1);
  assert.strictEqual((await s.store.mailboxes.get(MBX)).sync_cursor, s.gmail.historyId);
});

test('5f. headers: a long or non-ASCII subject is folded into <=75-char encoded-words; mailing-list mail never suppresses', async () => {
  const raw = buildRawMessage({ from: MBX_ADDR, to: 'a@b.example', subject: 'Ã'.repeat(70), text: 'x' });
  const subj = raw.slice(raw.indexOf('Subject: '), raw.indexOf('\r\nDate:'));
  for (const line of subj.split('\r\n')) assert.ok(line.length <= 78, line.length);
  assert.ok(subj.split('\r\n').slice(1).every((l) => l.startsWith(' =?UTF-8?B?')));
  const decoded = subj.replace('Subject: ', '').split('\r\n ').map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('');
  assert.strictEqual(decoded, 'Ã'.repeat(70));
  assert.ok(buildRawMessage({ from: MBX_ADDR, to: 'a@b.example', subject: 'see =?x?=', text: 'x' }).includes('Subject: =?UTF-8?B?'), 'a literal =? is encoded, never decoded by a client');
  const s = await sentOnce();
  s.gmail.deliver('l1', { From: LEAD_EMAIL, Subject: 'Unsubscribe instructions', 'List-Id': '<news.acme.example.com>' });
  const sum = await s.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.unsubscribes, 0);
  assert.strictEqual(sum.skippedAutomatic, 1);
});

test('5g. a stored copy without a readable Message-ID takes the mailbox out of Ready (replies could not be matched)', async () => {
  const s = await setup({ gmail: fakeGmail({ storedIdMissing: true }) });
  await allowMarket(s.store);
  const p = await approved(s.li);
  const r = await s.li.outreach.send({ pitchId: p.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r.replyMatching, 'unavailable');
  const m = await s.store.mailboxes.get(MBX);
  assert.strictEqual(m.status, 'needs_check');
  assert.strictEqual(m.status_code, 'MAILBOX_MESSAGE_ID_UNREADABLE');
});

/* ======================== F26.6 follow-up: review + accepted-only pacing ======================== */

test('6a. a synced verified reply stops being "permission": the next email needs a human review; "interested" re-opens it', async () => {
  // A lead in a consent-required market whose ONLY possible basis is the reply to an earlier
  // mailbox send (its stored id and recipient are on record).
  const s2 = await setup({ leads: { L1: lead({ country: 'Atlantis' }) } });
  const p2 = await approved(s2.li);
  await s2.store.mailboxSent.record({ send_id: 'sx', mailbox_id: MBX, provider_message_id: 'm0', stored_message_id: '<CAold@mail.gmail.com>', thread_id: 't0', recipient_address: LEAD_EMAIL, recorded_at: iso(NOW - HOUR) });
  s2.gmail.deliver('rv1', { From: LEAD_EMAIL, Subject: 'Re: hello', 'In-Reply-To': '<CAold@mail.gmail.com>' });
  const sum = await s2.svc.syncReplies({ mailboxId: MBX });
  assert.strictEqual(sum.replies, 1);
  await assert.rejects(s2.li.outreach.send({ pitchId: p2.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'REPLY_REVIEW_REQUIRED');
  const prep = await s2.li.outreach.prepare({ pitchId: p2.pitch_id, channel: 'email' });
  assert.strictEqual(prep.mailbox.trust.code, 'REPLY_REVIEW_REQUIRED');
  assert.strictEqual(prep.trust.replyReviewPending, true);
  await s2.li.trust.reviewReply({ leadId: 'L1', outcome: 'interested' });
  const r = await s2.li.outreach.send({ pitchId: p2.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r.outcome, 'accepted');
});

test('6b. pacing counts ONLY provider-accepted sends: a Gmail refusal or a trust/market refusal uses up nothing', async () => {
  const s = await setup({ gmail: fakeGmail({ sendStatus: 429 }), leads: { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }), L3: lead({ id: 'L3', email: 'three@acme.example.com', website: 'https://three.example.com', country: 'Atlantis' }) } });
  await allowMarket(s.store);
  const a = await approved(s.li, 'L1');
  const b = await approved(s.li, 'L2');
  const c = await approved(s.li, 'L3');
  await assert.rejects(s.li.outreach.send({ pitchId: c.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MARKET_CONSENT_REQUIRED');
  await assert.rejects(s.li.outreach.send({ pitchId: a.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_PROVIDER_LIMIT');
  s.gmail.sendStatus = 200;
  // Same instant: had the failed attempt counted, the 180 s gap would refuse this.
  const ok = await s.svc.sendGate(MBX);
  assert.strictEqual(ok.allowed, true, 'neither the market refusal nor the Gmail refusal counted');
  assert.strictEqual(ok.mailbox.pacing.sentToday, 0);
  const rows = (await s.store.sends.list({ limit: 10 })).rows;
  assert.ok(rows.some((r) => r.state === 'failed' && r.mailbox_id === MBX), 'the failed attempt is kept for audit');
  assert.strictEqual((await s.li.outreach.send({ pitchId: b.pitch_id, channel: 'email', mailboxId: MBX })).outcome, 'accepted', 'the next click goes through at once');
});

test('6c. an accepted send counts even when its read-back failed', async () => {
  const s = await setup({ gmail: fakeGmail({ readBackFails: true }), leads: { L1: lead({}), L2: lead({ id: 'L2', email: 'two@acme.example.com', website: 'https://two.example.com' }) } });
  await allowMarket(s.store);
  const a = await approved(s.li, 'L1');
  const b = await approved(s.li, 'L2');
  const r = await s.li.outreach.send({ pitchId: a.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(r.replyMatching, 'unavailable');
  await assert.rejects(s.li.outreach.send({ pitchId: b.pitch_id, channel: 'email', mailboxId: MBX }), (e) => e.code === 'MAILBOX_PACING');
  assert.strictEqual((await s.svc.get(MBX)).pacing.sentToday, 1);
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
