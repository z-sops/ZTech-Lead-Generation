'use strict';

// F29 - the Reply Router (D1 fallback: subject + headers only; D2-D6, Zee 8 Oct 2026).
// Fake Gmail only; no live call. Each test states the rule it pins.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const LI = path.join(root, 'src', 'main', 'lead-intelligence');
const h = require('./f28-harness');
const { ReplyRouterService } = require(path.join(LI, 'replies', 'ReplyRouterService.js'));
const { classifyReply, normalizeSubject, RULE_IDS } = require(path.join(LI, 'replies', 'replyRules.js'));
const { REPLY_CATEGORIES, SUGGESTED_REVIEW } = require(path.join(LI, 'replies', 'replyRouteContract.js'));
const { registerReplyRouterIpc, REPLY_ROUTER_CHANNELS_IPC, REPLY_ROUTER_SCHEMAS } = require(path.join(LI, 'replies', 'reply-router-ipc.js'));
const { GMAIL_SCOPES } = require(path.join(LI, 'mailbox', 'gmail', 'GoogleOAuth.js'));
const { mailboxEventId } = require(path.join(LI, 'mailbox', 'gmail', 'rfc2822.js'));

const { DAY, MBX, LEAD_EMAIL, setup, firstEmail, approvedSequence, sendCalls } = h;
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const FIRST = 'A few notes on www.acme.example.com';
const STORED = '<CAstored-1@mail.gmail.com>';
const FROM = `"Owner" <${LEAD_EMAIL}>`;
const cites = (id = STORED) => ({ 'In-Reply-To': id, References: id });
const reply = (subject, extra = {}) => ({ From: FROM, Subject: subject, ...cites(), ...extra });
const eventOf = (gmailId) => mailboxEventId(MBX, gmailId);

/** F28 setup + the Reply Router wired exactly as the runtime wires it. */
async function env(opts = {}) {
  const s = await setup(opts);
  const logs = [];
  const router = new ReplyRouterService({
    store: opts.routerStore ? opts.routerStore(s.store) : s.store, clock: () => new Date(s.clock.t), operator: 'Zee',
    leadName: async (id) => { const c = await s.li.outreach.contexts.getContext(id); return c && c.view ? c.view.name : null; },
    logger: { warn: (m) => logs.push(m) },
  });
  if (opts.router !== false) s.svc.setReplyRouter((m) => router.onMailboxMessage(m));
  return { ...s, router, rlogs: logs };
}
const sync = (e) => e.svc.syncReplies({ mailboxId: MBX });

/** Every Memory repo's rows, with random ids replaced so two runs can be compared byte for byte. */
function dump(store, skip = ['replyRoutes']) {
  const out = {};
  for (const [name, repo] of Object.entries(store)) {
    if (skip.includes(name) || !repo || !(repo.rows instanceof Map)) continue;
    // Random ids, and the hashes of content that embeds them (the per-send unsubscribe token).
    const vals = [...repo.rows.values()].map((v) => JSON.stringify(v).replace(/"[a-z]{2,6}_[A-Za-z0-9-]{8,}"/g, '"<id>"').replace(/[0-9a-f]{64}/g, '<hash>'));
    out[name] = vals.sort();
  }
  return JSON.stringify(out);
}

/* ================================ 1. rules ================================ */

test('R1. "Re: <our subject>" is unknown (subject_echo); prefixes and case never matter', () => {
  for (const s of [`Re: ${FIRST}`, `RE: Fwd: ${FIRST.toUpperCase()}`, `Re[2]: ${FIRST}`, `AW: ${FIRST}`, `[EXT] Re: ${FIRST}`]) {
    assert.deepStrictEqual(classifyReply({ kind: 'reply', subject: s, firstSubject: FIRST }), { category: 'unknown', ruleId: 'subject_echo', input: 'subject', confidence: 'low' }, s);
  }
  assert.strictEqual(classifyReply({ kind: 'reply', subject: '', firstSubject: FIRST }).ruleId, 'no_subject');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Hello there', firstSubject: FIRST }).ruleId, 'no_signal');
  assert.strictEqual(normalizeSubject('Re: Re:  Fwd:Hello,   World!'), 'hello world');
});

test('R2. each category from a changed subject, English and Roman Urdu', () => {
  const want = {
    'Please unsubscribe me': 'unsubscribe', 'Stop emailing us': 'unsubscribe', "Don't contact me again": 'unsubscribe', 'Take me off your list': 'unsubscribe', 'mujhe email na karein': 'unsubscribe',
    'Out of office: back Monday': 'out_of_office', 'Automatic reply: notes': 'out_of_office', 'On leave until 20th': 'out_of_office',
    'Not interested': 'not_interested', 'No thanks': 'not_interested', "We're all set": 'not_interested', 'zaroorat nahi': 'not_interested',
    'Call next week?': 'meeting_request', 'Can we schedule a meeting': 'meeting_request', 'baat karte hain': 'meeting_request',
    'Pricing?': 'pricing_request', 'How much would it cost': 'pricing_request', 'kitne ka hoga': 'pricing_request', 'qeemat batayein': 'pricing_request',
    'Maybe next quarter': 'later', 'abhi nahi, baad mein': 'later',
    'Interested!': 'interested', 'Sounds good': 'interested', 'Tell me more': 'interested',
  };
  for (const [subject, cat] of Object.entries(want)) assert.strictEqual(classifyReply({ kind: 'reply', subject, firstSubject: FIRST }).category, cat, subject);
});

test('R3. negations: "not interested" is never interested; "no need to call" / "don\'t call" is never a meeting', () => {
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'not interested in a call', firstSubject: FIRST }).category, 'not_interested');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'No need to call', firstSubject: FIRST }).category, 'not_interested');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: "please don't call", firstSubject: FIRST }).category, 'unknown');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'never interested', firstSubject: FIRST }).category, 'unknown');
  // Review fix: weak "no" phrases rank below a meeting / pricing ask and are low confidence.
  assert.strictEqual(classifyReply({ kind: 'reply', subject: "No need to wait - let's schedule a call", firstSubject: FIRST }).category, 'meeting_request');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Already have a slot: meeting Tuesday', firstSubject: FIRST }).category, 'meeting_request');
  assert.deepStrictEqual(classifyReply({ kind: 'reply', subject: 'interested? not really', firstSubject: FIRST }), { category: 'not_interested', ruleId: 'subject_not_interested_weak', input: 'subject', confidence: 'low' });
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'No need to call', firstSubject: FIRST }).confidence, 'low');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Not interested', firstSubject: FIRST }).confidence, 'high');
  for (const s of ["don't email", 'dont email us', 'do not contact']) assert.strictEqual(classifyReply({ kind: 'reply', subject: s, firstSubject: FIRST }).category, 'unsubscribe', s);
  // Our subject is removed as whole words only; many prefixes are still stripped.
  assert.strictEqual(classifyReply({ kind: 'reply', subject: `${'Re: '.repeat(15)}${FIRST}`, firstSubject: FIRST }).ruleId, 'subject_echo');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Hi, call me', firstSubject: 'Hi' }).category, 'meeting_request', 'a very short first subject is not stripped');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Re: Notes - call me', firstSubject: 'Notes' }).category, 'meeting_request', 'our words go, theirs stay');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Re: All - call me', firstSubject: 'All' }).category, 'meeting_request', 'removed as whole words: "call" keeps its "all"');
});

test('R4. priority: opt-out beats everything; out-of-office beats interest; our own subject words never count', () => {
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Interested but please unsubscribe me', firstSubject: FIRST }).category, 'unsubscribe');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Out of office - interested in pricing', firstSubject: FIRST }).category, 'out_of_office');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: 'Pricing call next week', firstSubject: FIRST }).category, 'meeting_request');
  const ours = 'Quick call about pricing';
  assert.strictEqual(classifyReply({ kind: 'reply', subject: `Re: ${ours}`, firstSubject: ours }).ruleId, 'subject_echo');
  assert.strictEqual(classifyReply({ kind: 'reply', subject: `Re: ${ours} - not now`, firstSubject: ours }).category, 'later', 'only the words they added count');
});

test('R5. headers: an auto-reply is out_of_office from headers; an intake unsubscribe stays unsubscribe; results hold codes only', () => {
  assert.deepStrictEqual(classifyReply({ kind: 'away', subject: 'Interested!' }), { category: 'out_of_office', ruleId: 'header_auto_reply', input: 'headers', confidence: 'high' });
  assert.strictEqual(classifyReply({ kind: 'unsubscribe', subject: 'whatever' }).category, 'unsubscribe');
  const r = classifyReply({ kind: 'reply', subject: 'CANARY-77 pricing', firstSubject: FIRST });
  assert.ok(!JSON.stringify(r).includes('CANARY'), 'no text in a result');
  for (const id of RULE_IDS) assert.ok(/^[a-z][a-z0-9_]{0,39}$/.test(id), id);
  assert.deepStrictEqual(REPLY_CATEGORIES, ['interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown']);
  assert.deepStrictEqual(SUGGESTED_REVIEW, { interested: 'interested', meeting_request: 'interested', pricing_request: 'interested', not_interested: 'not_interested', unsubscribe: 'unsubscribe', later: null, out_of_office: null, unknown: null });
});

/* ================================ 2. routing in reply sync ================================ */

test('S1. a verified reply gets a route after the intake accepted it; "Re: <first subject>" is unknown', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply(`Re: ${FIRST}`));
  const sum = await sync(e);
  assert.strictEqual(sum.replies, 1);
  const r = await e.store.replyRoutes.get(eventOf('in1'));
  assert.deepStrictEqual({ ...r }, {
    event_id: eventOf('in1'), lead_id: 'L1', mailbox_id: MBX, kind: 'reply', suggested: 'unknown', rule_id: 'subject_echo', input: 'subject', confidence: 'low',
    confirmed: null, confirmed_by: null, confirmed_at: null, routed_at: h.iso(e.clock.t),
  });
  const list = await e.router.list();
  assert.strictEqual(list.replies.length, 1);
  assert.strictEqual(list.replies[0].leadName, 'Acme Bakery');
  assert.strictEqual(list.replies[0].state, 'pending');
});

test('S2. no route for anything unverified: an unmatched id, a forward from another address, list mail, a bounce', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('a', reply('Pricing?', cites('<CAnot-ours@mail.gmail.com>')));
  e.gmail.deliver('b', { ...reply('Pricing?'), From: '"Colleague" <someone@else.example>' });
  e.gmail.deliver('c', { ...reply('Out of office'), 'Auto-Submitted': 'auto-replied', 'List-Id': '<x.list>' });
  e.gmail.deliver('d', { ...reply('Out of office'), 'Precedence': 'bulk' });
  e.gmail.deliver('f', { ...reply('Delivery Status Notification'), From: 'mailer-daemon@googlemail.com' });
  e.gmail.deliver('g', { ...reply('Automatic reply'), From: '"Colleague" <someone@else.example>', 'Auto-Submitted': 'auto-replied' });
  e.gmail.deliver('i', { From: FROM, Subject: 'Pricing?' }); // cites nothing
  await sync(e);
  assert.strictEqual(e.store.replyRoutes.rows.size, 0);
  // The sync offers the router only what the intake ACCEPTED (and auto-replies citing an id).
  const seen = [];
  e.svc.setReplyRouter((m) => { seen.push(m.kind); });
  e.gmail.deliver('j', reply('Pricing?', cites('<CAnot-ours-2@mail.gmail.com>')));
  e.gmail.deliver('k', { ...reply('Pricing?'), From: '"Colleague" <someone@else.example>' });
  await sync(e);
  assert.deepStrictEqual(seen, [], 'a rejected reply is never offered to the router');
});

test('S2b. the router re-verifies what it is handed: no trust event, a different kind, or an auto-reply that has one is skipped', async () => {
  const e = await env({ router: false });
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Pricing?'));
  await sync(e);
  const base = { mailboxId: MBX, from: LEAD_EMAIL, refs: [STORED], subject: 'Pricing?' };
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'reply', eventId: eventOf('never-accepted') }), 'skipped', 'no trust event');
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'unsubscribe', eventId: eventOf('in1') }), 'skipped', 'the trust event is a reply, not an unsubscribe');
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'away', eventId: eventOf('in1') }), 'skipped', 'a message with a trust event is never "away"');
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'reply', eventId: eventOf('in1'), refs: [] }), 'skipped', 'no cited id');
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'reply', eventId: eventOf('in1'), from: 'other@else.example' }), 'skipped', 'not the recipient');
  assert.strictEqual(e.store.replyRoutes.rows.size, 0);
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'reply', eventId: eventOf('in1') }), 'routed');
  assert.strictEqual(await e.router.onMailboxMessage({ ...base, kind: 'reply', eventId: eventOf('in1') }), 'duplicate');
});

test('S3. D4: an out-of-office auto-reply citing our id is an "Away" note only - intake still skips it and F28 still sends', async () => {
  const e = await env();
  const { view } = await approvedSequence(e);
  await e.sequences.activate({ sequenceId: view.sequenceId });
  e.gmail.deliver('ooo', { ...reply('Automatic reply: A few notes'), 'Auto-Submitted': 'auto-replied', 'X-Autoreply': 'yes' });
  const sum = await sync(e);
  assert.strictEqual(sum.skippedAutomatic, 1);
  assert.strictEqual(sum.replies, 0);
  assert.strictEqual(await e.store.trustEvents.get(eventOf('ooo')), null, 'no trust event for an auto-reply');
  const r = await e.store.replyRoutes.get(eventOf('ooo'));
  assert.strictEqual(r.kind, 'away');
  assert.strictEqual(r.suggested, 'out_of_office');
  assert.strictEqual(r.input, 'headers');
  e.advance(3 * DAY + 1000);
  const tick = await e.scheduler.tick();
  assert.deepStrictEqual(tick.outcomes, ['sent'], 'an Away note never stops a follow-up');
  assert.strictEqual((await e.sequences.forLead({ leadId: 'L1' })).status, 'active');
  const fl = await e.router.forLead({ leadId: 'L1' });
  assert.strictEqual(fl.latest, null);
  assert.strictEqual(fl.away.routedAt, r.routed_at);
  assert.deepStrictEqual((await e.router.list({ show: 'all' })).replies, [], 'Away notes are not replies');
  await assert.rejects(e.router.confirm({ eventId: eventOf('ooo'), category: 'interested' }), (x) => x.code === 'REPLY_ROUTE_AWAY');
});

test('S4. an "unsubscribe" subject: the intake suppresses (unchanged); the route says so and needs no review', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('u1', reply('Unsubscribe'));
  const sum = await sync(e);
  assert.strictEqual(sum.unsubscribes, 1);
  const r = await e.store.replyRoutes.get(eventOf('u1'));
  assert.strictEqual(r.kind, 'unsubscribe');
  assert.strictEqual(r.suggested, 'unsubscribe');
  assert.deepStrictEqual((await e.router.list()).replies, [], 'already acted on: not pending');
  const all = await e.router.list({ show: 'all' });
  assert.strictEqual(all.replies[0].state, 'unsubscribed');
  assert.strictEqual((await e.router.forLead({ leadId: 'L1' })).latest.kind, 'unsubscribe');
});

test('S5. D5 fallback: an opt-out phrase in the SUBJECT ("stop emailing") is suggested unsubscribe and listed first - nothing is suppressed', async () => {
  const e = await env({ leads: { L1: h.lead({}), L2: h.lead({ id: 'L2', title: 'Beta Cafe', website: 'https://beta.example.com', email: 'owner@beta.example.com' }) } });
  await firstEmail(e, 'L1');
  e.advance(10 * 60 * 1000); // the mailbox's pacing gap
  await firstEmail(e, 'L2');
  e.gmail.deliver('p1', reply('Pricing?'));
  e.advance(1000);
  e.gmail.deliver('s1', { From: '"B" <owner@beta.example.com>', Subject: 'Stop emailing me', ...cites('<CAstored-2@mail.gmail.com>') });
  await sync(e);
  const list = (await e.router.list()).replies;
  assert.deepStrictEqual(list.map((v) => [v.leadId, v.category, v.possibleOptOut]), [['L2', 'unsubscribe', true], ['L1', 'pricing_request', false]]);
  assert.strictEqual(await e.store.suppressions.find({ channel: 'email', address: 'owner@beta.example.com' }), null, 'a category never suppresses');
  assert.strictEqual(list[0].suggestedReview, 'unsubscribe');
  assert.strictEqual(list[1].suggestedReview, 'interested');
});

test('S6. a re-read of the same message, and a second sync, change nothing (idempotent on event id)', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Pricing?'));
  await sync(e);
  await e.router.confirm({ eventId: eventOf('in1'), category: 'meeting_request' });
  const before = JSON.stringify([...e.store.replyRoutes.rows.values()]);
  e.store.mailboxes.rows.get(MBX).sync_cursor = '500'; // read the whole history again
  await sync(e);
  assert.strictEqual(await e.router.onMailboxMessage({ kind: 'reply', mailboxId: MBX, eventId: eventOf('in1'), from: LEAD_EMAIL, refs: [STORED], subject: 'Not interested' }), 'duplicate');
  assert.strictEqual(JSON.stringify([...e.store.replyRoutes.rows.values()]), before);
});

/* ================================ 3. it only suggests ================================ */

test('T1. trust, suppression, reviews and F28 are byte-identical with the router on and off', async () => {
  async function run(on) {
    const e = await env({ router: on });
    const { view } = await approvedSequence(e);
    await e.sequences.activate({ sequenceId: view.sequenceId });
    e.gmail.deliver('r1', reply('Pricing? Call next week'));
    e.gmail.deliver('o1', { ...reply('Out of office'), 'Auto-Submitted': 'auto-replied' });
    e.gmail.deliver('x1', { ...reply('Not interested'), From: '"Fwd" <fwd@else.example>' });
    e.gmail.deliver('u1', reply('Remove me'));
    const sum = await sync(e);
    e.advance(3 * DAY + 1000);
    const tick = await e.scheduler.tick();
    return { sum, tick, dump: dump(e.store), trust: await e.li.trust.leadTrust({ leadId: 'L1' }), seq: await e.sequences.forLead({ leadId: 'L1' }), sends: sendCalls(e.gmail).length, routes: e.store.replyRoutes.rows.size };
  }
  const a = await run(true);
  const b = await run(false);
  assert.strictEqual(a.routes, 3, 'reply, away and unsubscribe routed with the router on');
  assert.strictEqual(b.routes, 0);
  assert.deepStrictEqual(a.sum, b.sum);
  assert.deepStrictEqual(a.tick, b.tick);
  assert.strictEqual(a.sends, b.sends);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(a.trust).replace(/"[a-z]{2,6}_[A-Za-z0-9-]{8,}"/g, '"<id>"')), JSON.parse(JSON.stringify(b.trust).replace(/"[a-z]{2,6}_[A-Za-z0-9-]{8,}"/g, '"<id>"')));
  assert.strictEqual(a.seq.status, b.seq.status);
  assert.strictEqual(a.seq.stopReason, b.seq.stopReason);
  assert.strictEqual(a.dump, b.dump, 'every other table is identical');
});

test('T2. the router can write ONLY its own table (every other repo is read-only to it)', async () => {
  const WRITE = /^(put|add|append|record|update|upsert|set|remove|delete|confirm|ensure|claim|note|purge|_)/;
  const readOnly = (store) => new Proxy(store, {
    get(t, name) {
      const repo = t[name];
      if (name === 'replyRoutes' || !repo || typeof repo !== 'object') return repo;
      return new Proxy(repo, { get(r, m) { const v = r[m]; if (typeof v === 'function' && WRITE.test(String(m))) return () => { throw Object.assign(new Error('write'), { code: 'WRITE_BLOCKED' }); }; return typeof v === 'function' ? v.bind(r) : v; } });
    },
  });
  const e = await env({ routerStore: readOnly });
  await firstEmail(e);
  e.gmail.deliver('r1', reply('Pricing?'));
  e.gmail.deliver('o1', { ...reply('Out of office'), 'Auto-Submitted': 'auto-replied' });
  await sync(e);
  assert.strictEqual(e.store.replyRoutes.rows.size, 2);
  assert.deepStrictEqual(e.rlogs, [], 'no write was attempted anywhere else');
  await e.router.confirm({ eventId: eventOf('r1'), category: 'interested' });
  assert.deepStrictEqual(e.rlogs, []);
});

test('T3. confirming a category never records a review, never suppresses and never changes the lead\'s trust', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Not interested'));
  await sync(e);
  const before = await e.li.trust.leadTrust({ leadId: 'L1' });
  for (const c of REPLY_CATEGORIES) await e.router.confirm({ eventId: eventOf('in1'), category: c });
  const v = await e.router.confirm({ eventId: eventOf('in1'), category: 'unsubscribe' });
  assert.strictEqual(v.confirmed, 'unsubscribe');
  assert.strictEqual(v.suggestedReview, 'unsubscribe');
  assert.strictEqual(e.store.replyReviews.rows.size, 0, 'no review recorded');
  assert.strictEqual(e.store.suppressions.rows.size, 0, 'nobody suppressed');
  assert.deepStrictEqual(await e.li.trust.leadTrust({ leadId: 'L1' }), before);
  assert.strictEqual(before.channels.email.mailboxReply.reviewPending, true);
  // The review buttons behave exactly as in F26.6: the human review is still the only effect.
  await e.li.trust.reviewReply({ leadId: 'L1', outcome: 'not_interested', replyReceivedAt: before.channels.email.mailboxReply.receivedAt });
  assert.strictEqual(e.store.suppressions.rows.size, 1);
  assert.strictEqual((await e.router.list()).replies.length, 0, 'a reviewed reply leaves the pending list');
  assert.strictEqual((await e.router.list({ show: 'all' })).replies[0].reviewOutcome, 'not_interested');
});

test('T3b. review fix: a reply whose contact is already on do-not-contact is not pending and not a possible opt-out', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Stop emailing me'));
  await sync(e);
  assert.strictEqual((await e.router.list()).replies[0].possibleOptOut, true);
  await e.li.trust.suppressLead({ leadId: 'L1', channel: 'email', reason: 'manual', scope: 'global' }); // the "Do not contact" button
  assert.deepStrictEqual((await e.router.list()).replies, []);
  const all = (await e.router.list({ show: 'all' })).replies;
  assert.deepStrictEqual(all.map((v) => [v.state, v.possibleOptOut]), [['suppressed', false]]);
  assert.strictEqual((await e.router.forLead({ leadId: 'L1' })).latest, null, 'the drawer no longer asks for a review it cannot take');
  // An "unsubscribe" reply cannot be re-categorised either.
  e.gmail.deliver('u1', reply('Unsubscribe'));
  await sync(e);
  await assert.rejects(e.router.confirm({ eventId: eventOf('u1'), category: 'interested' }), (x) => x.code === 'REPLY_ROUTE_UNSUBSCRIBED');
});

test('T3c. review fix: an old pending reply stays listed behind any number of newer reviewed ones', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('old', reply('Stop emailing me'));
  await sync(e);
  const base = (await e.store.replyRoutes.get(eventOf('old')));
  for (let i = 0; i < 450; i += 1) {
    await e.store.replyRoutes.put({ ...base, event_id: 'gm_' + String(i).padStart(40, 'a'), routed_at: h.iso(e.clock.t + 1000 + i) });
  }
  const pending = (await e.router.list()).replies;
  assert.deepStrictEqual(pending.map((v) => v.eventId), [eventOf('old')], 'found on the third page');
  assert.strictEqual(pending[0].possibleOptOut, true);
  assert.strictEqual(pending[0].leadName, 'Acme Bakery');
  assert.strictEqual((await e.router.list({ show: 'all' })).replies.length, 200, '"all" shows the newest 200');
});

test('T4. the review applies to the NEWEST reply: an older one is shown as superseded, never pending', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Pricing?'));
  await sync(e);
  e.advance(60 * 1000);
  e.gmail.deliver('in2', reply('Call next week?'));
  await sync(e);
  const all = (await e.router.list({ show: 'all' })).replies;
  assert.deepStrictEqual(all.map((v) => [v.category, v.state]), [['meeting_request', 'pending'], ['pricing_request', 'superseded']]);
  assert.strictEqual((await e.router.forLead({ leadId: 'L1' })).latest.category, 'meeting_request');
  assert.deepStrictEqual((await e.router.list({ category: 'pricing_request' })).replies, []);
});

test('T5. a router failure never fails the sync: the summary, trust and cursor are as without it; logs carry a code only', async () => {
  const e = await env();
  await firstEmail(e);
  e.store.replyRoutes.put = async () => { const x = new Error('CANARY subject text Pricing?'); x.code = 'BOOM'; throw x; };
  e.gmail.deliver('in1', reply('CANARY-SUBJECT Pricing?'));
  const sum = await sync(e);
  assert.strictEqual(sum.replies, 1);
  assert.ok(await e.store.trustEvents.get(eventOf('in1')), 'the reply is still recorded');
  assert.deepStrictEqual(e.rlogs, ['[lead-intelligence] reply router: route failed: BOOM']);
  // A listener that throws is contained by the sync too.
  const t = await env({ router: false });
  t.svc.setReplyRouter(async () => { throw Object.assign(new Error('x'), { code: 'LISTENER' }); });
  await firstEmail(t);
  t.gmail.deliver('in1', reply('Pricing?'));
  assert.strictEqual((await sync(t)).replies, 1);
});

test('T6. canary: the subject never reaches the store, a log, an IPC result or an error', async () => {
  const e = await env();
  await firstEmail(e);
  const handlers = {};
  registerReplyRouterIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, replyRouter: e.router, isTrustedSender: () => true, logger: { warn: (m) => e.rlogs.push(m) } });
  e.gmail.deliver('in1', reply('CANARY-91c Pricing?'));
  e.gmail.deliver('o1', { ...reply('CANARY-91c Out of office'), 'Auto-Submitted': 'auto-replied' });
  await sync(e);
  const results = [
    await handlers[REPLY_ROUTER_CHANNELS_IPC.LIST]({}, { show: 'all' }),
    await handlers[REPLY_ROUTER_CHANNELS_IPC.FOR_LEAD]({}, { leadId: 'L1' }),
    await handlers[REPLY_ROUTER_CHANNELS_IPC.CONFIRM]({}, { eventId: eventOf('in1'), category: 'later' }),
    await handlers[REPLY_ROUTER_CHANNELS_IPC.CONFIRM]({}, { eventId: eventOf('o1'), category: 'later' }),
  ];
  const everything = JSON.stringify({ store: Object.fromEntries(Object.entries(e.store).filter(([, r]) => r && r.rows instanceof Map).map(([k, r]) => [k, [...r.rows.values()]])), logs: [...e.logs, ...e.rlogs], results });
  assert.ok(!/CANARY/.test(everything), 'no subject text anywhere');
  assert.ok(!everything.includes(LEAD_EMAIL) || !JSON.stringify(results).includes(LEAD_EMAIL), 'no address in an IPC result');
  assert.ok(!JSON.stringify(results).includes('@'), 'no address of any kind crosses IPC');
});

/* ================================ 4. IPC ================================ */

test('I1. three channels, closed schemas, trusted sender only; none can send, suppress, permit or review', async () => {
  const e = await env();
  await firstEmail(e);
  e.gmail.deliver('in1', reply('Pricing?'));
  await sync(e);
  const handlers = {};
  let trusted = true;
  const names = registerReplyRouterIpc({ ipcMain: { handle: (c, f) => { handlers[c] = f; } }, replyRouter: e.router, isTrustedSender: () => trusted, logger: { warn() {} } });
  assert.deepStrictEqual(names.sort(), ['lead-intel:reply-route-confirm', 'lead-intel:reply-route-lead', 'lead-intel:reply-routes']);
  for (const schema of Object.values(REPLY_ROUTER_SCHEMAS)) assert.strictEqual(schema.additionalProperties, false);
  const C = REPLY_ROUTER_CHANNELS_IPC;
  const bad = async (ch, payload) => { const r = await handlers[ch]({}, payload); assert.strictEqual(r.ok, false, JSON.stringify(payload)); return r; };
  await bad(C.LIST, { category: 'spam' });
  await bad(C.LIST, { show: 'everything' });
  await bad(C.LIST, { send: true });
  await bad(C.CONFIRM, { eventId: eventOf('in1') });
  await bad(C.CONFIRM, { eventId: eventOf('in1'), category: 'interested', review: 'interested' });
  for (const eventId of ['gm_' + 'z'.repeat(40), 'gm_' + 'a'.repeat(39), 'tev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'x']) {
    assert.strictEqual((await bad(C.CONFIRM, { eventId, category: 'interested' })).error.code, 'VALIDATION_FAILED', eventId);
  }
  await bad(C.CONFIRM, { eventId: eventOf('in1'), category: 'interested', to: 'x@y.example' });
  await bad(C.FOR_LEAD, { leadId: 'L1', mailboxId: MBX });
  const missing = await bad(C.CONFIRM, { eventId: eventOf('nope'), category: 'interested' });
  assert.strictEqual(missing.error.code, 'NOT_FOUND');
  trusted = false;
  assert.strictEqual((await handlers[C.LIST]({}, {})).ok, false, 'untrusted sender refused');
  trusted = true;
  const ok = await handlers[C.LIST]({}, { category: 'pricing_request' });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.data.replies.length, 1);
  assert.strictEqual(sendCalls(e.gmail).length, 1, 'no IPC call sent anything');
  assert.strictEqual(e.store.replyReviews.rows.size, 0);
});

/* ================================ 5. static guards ================================ */

test('G1. no new permission, no send path, no body read, no Microsoft, no campaign: the F29 code says so', () => {
  assert.deepStrictEqual([...GMAIL_SCOPES], ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata'], 'gmail.readonly is not added');
  const dir = path.join(LI, 'replies');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '');
  const src = fs.readdirSync(dir).map((f) => strip(fs.readFileSync(path.join(dir, f), 'utf8'))).join('\n');
  for (const banned of [/gmail\.readonly/, /format=full|format=raw/, /snippet/i, /(?:^|[^.\w'"])send\w*\s*\(|\.send(?:Raw|Email|FromMailbox)?\s*\(/i, /sendFromMailbox|outreachSend/, /reviewReply|replyReviews\.put/, /suppressions\.add|suppressLead/, /trustEvents\.append|\.intake\(/, /consents\.record/, /sequences\.(?:create|activate|resume|stop|pause)/, /microsoft|graph\.microsoft/i, /campaign|bulk/i, /\bfetch\s*\(/, /setInterval|setTimeout/, /console\./]) {
    assert.ok(!banned.test(src), 'F29 code must not contain ' + banned);
  }
  const mbx = fs.readFileSync(path.join(LI, 'mailbox', 'MailboxService.js'), 'utf8');
  assert.ok(mbx.includes("const REPLY_HEADERS = Object.freeze(['From', 'Subject', 'In-Reply-To', 'References', 'Auto-Submitted', 'Content-Type', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'List-Id']);"), 'the headers read are unchanged');
  const sql = fs.readFileSync(path.join(LI, 'migrations', '013_reply_routes.sql'), 'utf8').replace(/--.*$/gm, '');
  const cols = [...sql.matchAll(/^\s+([a-z_]+)\s+TEXT/gm)].map((m) => m[1]);
  assert.deepStrictEqual(cols, ['event_id', 'lead_id', 'mailbox_id', 'kind', 'suggested', 'rule_id', 'input', 'confidence', 'confirmed', 'confirmed_by', 'confirmed_at', 'routed_at'], 'no text column');
  const policy = fs.readdirSync(path.join(LI, 'trust')).map((f) => fs.readFileSync(path.join(LI, 'trust', f), 'utf8')).join('\n')
    + fs.readdirSync(path.join(LI, 'sequences')).map((f) => fs.readFileSync(path.join(LI, 'sequences', f), 'utf8')).join('\n')
    + fs.readFileSync(path.join(LI, 'outreach', 'OutreachService.js'), 'utf8');
  assert.ok(!/replyRoutes|reply_routes|ReplyRouter/.test(policy), 'trust, gates and F28 never read a category');
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
