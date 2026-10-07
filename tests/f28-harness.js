'use strict';

// F28 shared test harness (not a test file). The real F26.5/F26.6 runtime (real LI, MemoryStore,
// trust, OutreachService, MailboxService) on a FAKE Gmail that behaves as Step 1A observed the real
// one, plus: it honours `threadId` on send (the follow-up joins the thread), and a movable clock.
// No live call is ever made.

const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const { MailboxService } = require(path.join(LI, 'mailbox', 'MailboxService.js'));
const { GoogleOAuth, GOOGLE, GMAIL_SCOPES } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { MAILBOX_DEFAULTS } = require(path.join(LI, 'mailbox', 'mailboxContract.js'));
const { SequenceService } = require(path.join(LI, 'sequences', 'SequenceService.js'));
const { SequenceScheduler } = require(path.join(LI, 'sequences', 'SequenceScheduler.js'));
const { LEAD_EMAIL, runtime, approved, iso, NOW, HOUR, allowMarket, lead } = require('./f265-harness');

const DAY = 24 * HOUR;
const MBX = 'mbx_aaaaaaaaaaaaaaaaaaaaaaaa';
const MBX_ADDR = 'dana@ridgeline.example';
const CLIENT = { clientId: '1234567890-abcdefg.apps.googleusercontent.com', clientSecret: 'GOCSPX-never-leaks' };
const REFRESH = '1//refresh-never-leaks';
const ACCESS = 'ya29.access-never-leaks';

/**
 * A fake Gmail. `st.next` can script the NEXT /messages/send answers:
 *   { status: 429 } | { status: 401 } | { status: 400 } | { status: 503 } | { throw: true } | { noId: true }
 */
function fakeGmail() {
  const st = { sent: [], messages: new Map(), history: [], historyId: '500', calls: [], n: 0, next: [] };
  const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  const parse = (raw) => {
    const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const [head, ...rest] = text.split('\r\n\r\n');
    const headers = {};
    let last = null;
    for (const line of head.split('\r\n')) {
      if (/^\s/.test(line) && last) { headers[last] += ' ' + line.trim(); continue; } // folded line
      const i = line.indexOf(':');
      last = line.slice(0, i).toLowerCase();
      headers[last] = line.slice(i + 1).trim();
    }
    return { headers, text, body: Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8') };
  };
  st.fetch = async (url, init = {}) => {
    const u = String(url);
    st.calls.push({ url: u, method: init.method || 'GET' });
    if (u === GOOGLE.TOKEN_URL) return json(200, { access_token: ACCESS, scope: GMAIL_SCOPES.join(' '), expires_in: 3599 });
    if (u.startsWith(GOOGLE.REVOKE_URL)) return json(200, {});
    assert.strictEqual(init.headers.Authorization, `Bearer ${ACCESS}`);
    const api = u.slice(GOOGLE.GMAIL_API.length);
    if (api === '/profile') return json(200, { emailAddress: MBX_ADDR, historyId: st.historyId });
    if (api === '/messages/send') {
      const body = JSON.parse(init.body);
      const scripted = st.next.shift();
      const m = parse(body.raw);
      if (scripted && scripted.throw) { st.lost = (st.lost || 0) + 1; throw new Error('socket hang up'); }
      if (scripted && scripted.status) return json(scripted.status, { error: { errors: [{ reason: scripted.status === 429 ? 'userRateLimitExceeded' : 'x', message: 'REMOTE TEXT' }] } });
      st.n += 1;
      const id = `msg${st.n}`;
      const threadId = body.threadId || `t${st.n}`;
      st.sent.push({ id, threadId, requestThreadId: body.threadId || null, ...m });
      st.messages.set(id, { headers: { ...m.headers, 'message-id': `<CAstored-${st.n}@mail.gmail.com>` }, labelIds: ['SENT'], threadId });
      if (scripted && scripted.noId) return json(200, { threadId });
      return json(200, { id, threadId, labelIds: ['SENT'] });
    }
    let m = api.match(/^\/messages\/([A-Za-z0-9_-]+)\?format=metadata&(.*)$/);
    if (m) {
      const msg = st.messages.get(m[1]);
      if (!msg) return json(404, {});
      const names = [...m[2].matchAll(/metadataHeaders=([^&]+)/g)].map((x) => decodeURIComponent(x[1]).toLowerCase());
      const headers = names.filter((n) => msg.headers[n] !== undefined).map((n) => ({ name: n, value: msg.headers[n] }));
      return json(200, { id: m[1], threadId: msg.threadId, labelIds: msg.labelIds, payload: { headers } });
    }
    m = api.match(/^\/history\?(.*)$/);
    if (m) {
      const q = new URLSearchParams(m[1]);
      const after = st.history.filter((h) => Number(h.id) > Number(q.get('startHistoryId')));
      return json(200, { history: after.map((h) => ({ id: h.id, messagesAdded: [{ message: { id: h.msgId, labelIds: h.labelIds } }] })), historyId: st.historyId });
    }
    return json(404, {});
  };
  st.deliver = (id, headers, labelIds = ['INBOX', 'UNREAD']) => {
    st.messages.set(id, { headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), labelIds, threadId: 'tx' });
    st.historyId = String(Number(st.historyId) + 1);
    st.history.push({ id: st.historyId, msgId: id, labelIds });
  };
  return st;
}

/** The runtime + a Ready Gmail mailbox + the F28 service and scheduler, all on one movable clock. */
async function setup({ gmail = fakeGmail(), leads, windowDays = '0,1,2,3,4,5,6', start = NOW } = {}) {
  const clock = { t: start };
  const now = () => clock.t;
  const rt = runtime({ ...(leads ? { leads } : {}), now });
  const tokens = new Map([[MBX, REFRESH]]);
  const svc = new MailboxService({
    store: rt.store, clock: () => new Date(now()), fetch: gmail.fetch, trust: rt.li.trust,
    tokenStore: { get: (id) => tokens.get(id) || null, set: (id, t) => tokens.set(id, t), remove: (id) => tokens.delete(id) },
    clientConfig: { get: () => CLIENT, set() {}, clear() {} },
    googleOAuth: new GoogleOAuth({ fetch: gmail.fetch, openExternal: () => {} }),
    operator: 'Zee', defaultTimeZone: 'Asia/Karachi',
  });
  rt.li.outreach.setMailboxes(svc);
  const at = iso(start - 2 * HOUR);
  await rt.store.mailboxes.upsert({
    mailbox_id: MBX, provider: 'gmail', email_address: MBX_ADDR, display_name: null, status: 'ready', status_code: null, paused_until: null,
    ...MAILBOX_DEFAULTS, window_start: '00:00', window_end: '23:59', window_days: windowDays, time_zone: 'Asia/Karachi',
    is_default: 1, sync_cursor: '500', connected_at: at, updated_at: at,
  });
  const logs = [];
  const sequences = new SequenceService({ store: rt.store, outreach: rt.li.outreach, mailboxes: svc, clock: () => new Date(now()), logger: { warn: (m) => logs.push(m) } });
  rt.li.outreach.setSequences(sequences);
  const scheduler = new SequenceScheduler({ sequences, store: rt.store, clock: () => new Date(now()), logger: { warn: (m) => logs.push(m) } });
  return { ...rt, svc, gmail, tokens, sequences, scheduler, clock, logs, advance: (ms) => { clock.t += ms; } };
}

/** A first email from the mailbox, accepted and read back. */
async function firstEmail(s, leadId = 'L1') {
  await allowMarket(s.store);
  const pitch = await approved(s.li, leadId);
  const send = await s.li.outreach.send({ pitchId: pitch.pitch_id, channel: 'email', mailboxId: MBX });
  assert.strictEqual(send.outcome, 'accepted');
  return { pitch, send };
}

/** First email + a drafted sequence with every step approved (not yet activated). */
async function approvedSequence(s, { delays, leadId = 'L1' } = {}) {
  const first = await firstEmail(s, leadId);
  const view = await s.sequences.create({ leadId, ...(delays ? { delays } : {}) });
  for (const st of view.steps) await s.li.outreach.approve({ pitchId: st.pitchId });
  return { ...first, view: await s.sequences.forLead({ leadId }) };
}

const sendCalls = (g) => g.calls.filter((c) => c.url.endsWith('/messages/send'));

module.exports = {
  DAY, MBX, MBX_ADDR, ACCESS, REFRESH, CLIENT, LEAD_EMAIL, NOW, HOUR, iso, lead,
  fakeGmail, setup, firstEmail, approvedSequence, sendCalls,
};
