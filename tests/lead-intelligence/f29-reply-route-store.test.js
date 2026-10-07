'use strict';

// F29 - migration 013 and the reply-route repositories (SqlJs + Memory twins). No network anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { MIGRATIONS } = require(path.join(LI, 'persistence', 'migrations'));

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';
const SILENT = { warn() {}, info() {}, error() {} };
const T = '2026-10-08T10:00:00.000Z';
const EV = (n) => 'gm_' + String(n).padStart(40, '0');

async function stores() {
  const out = [['memory', new MemoryStore()]];
  if (initSqlJs) {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const s = new SqlJsStore({ db, logger: SILENT });
    await s.migrate();
    out.push(['sql', s, db]);
  }
  return out;
}
const route = (o = {}) => ({
  event_id: EV(1), lead_id: 'L1', mailbox_id: 'mbx_aaaaaaaaaaaa', kind: 'reply', suggested: 'pricing_request', rule_id: 'subject_pricing',
  input: 'subject', confidence: 'high', confirmed: null, confirmed_by: null, confirmed_at: null, routed_at: T, ...o,
});

test('F29 store: migration 013 creates li_reply_routes with closed CHECKs and NO text column', { skip }, async () => {
  assert.equal(MIGRATIONS.at(-1).version, 13);
  assert.equal(MIGRATIONS.at(-1).name, '013_reply_routes.sql');
  const [, , db] = (await stores())[1];
  const cols = db.exec('PRAGMA table_info(li_reply_routes)')[0].values.map((r) => r[1]);
  assert.deepEqual(cols, ['event_id', 'lead_id', 'mailbox_id', 'kind', 'suggested', 'rule_id', 'input', 'confidence', 'confirmed', 'confirmed_by', 'confirmed_at', 'routed_at']);
  for (const c of cols) assert.ok(!/subject|snippet|body|text|address|email/.test(c), c);
  const insert = (o) => db.run('INSERT INTO li_reply_routes (event_id, lead_id, mailbox_id, kind, suggested, rule_id, input, confidence, routed_at) VALUES (?,?,?,?,?,?,?,?,?)',
    [o.event_id, 'L1', 'mbx', o.kind || 'reply', o.suggested || 'unknown', o.rule_id || 'no_signal', o.input || 'subject', o.confidence || 'low', T]);
  assert.throws(() => insert({ event_id: EV(2), kind: 'bounce' }), /CHECK/);
  assert.throws(() => insert({ event_id: EV(3), suggested: 'spam' }), /CHECK/);
  assert.throws(() => insert({ event_id: EV(4), input: 'snippet' }), /CHECK/, 'there is no snippet input in the fallback');
  assert.throws(() => insert({ event_id: EV(5), confidence: 'certain' }), /CHECK/);
  insert({ event_id: EV(6) });
  assert.throws(() => db.run("UPDATE li_reply_routes SET confirmed = 'maybe' WHERE event_id = ?", [EV(6)]), /CHECK/);
});

test('F29 store: put is idempotent on event id; confirm changes only the confirmation; twins agree', async () => {
  const results = [];
  for (const [name, s] of await stores()) {
    const a = await s.replyRoutes.put(route());
    assert.equal(a.created, true, name);
    const b = await s.replyRoutes.put(route({ suggested: 'not_interested', rule_id: 'subject_not_interested' }));
    assert.equal(b.created, false, name);
    assert.equal(b.row.suggested, 'pricing_request', `${name}: the first route stays`);
    const c = await s.replyRoutes.confirm(EV(1), { category: 'meeting_request', by: 'Zee', at: T });
    assert.equal(c.confirmed, 'meeting_request');
    assert.equal(c.suggested, 'pricing_request', 'the suggestion is kept');
    assert.equal(await s.replyRoutes.confirm(EV(9), { category: 'later', by: 'Zee', at: T }), null, `${name}: unknown event`);
    await assert.rejects(s.replyRoutes.confirm(EV(1), { category: 'spam', by: 'Zee', at: T }));
    await assert.rejects(s.replyRoutes.put(route({ event_id: EV(2), input: 'snippet' })));
    await assert.rejects(s.replyRoutes.put(route({ event_id: EV(2), kind: 'complaint' })));
    await assert.rejects(s.replyRoutes.put(route({ event_id: EV(2), confirmed: 'later' })), 'a confirmation needs who and when');
    await s.replyRoutes.put(route({ event_id: EV(3), kind: 'away', suggested: 'out_of_office', rule_id: 'header_auto_reply', input: 'headers', routed_at: '2026-10-08T11:00:00.000Z' }));
    await s.replyRoutes.put(route({ event_id: EV(4), lead_id: 'L2', routed_at: '2026-10-08T12:00:00.000Z' }));
    const all = (await s.replyRoutes.list({})).map((r) => r.event_id);
    const replies = (await s.replyRoutes.list({ kinds: ['reply', 'unsubscribe'] })).map((r) => r.event_id);
    const l1 = (await s.replyRoutes.forLead('L1')).map((r) => r.event_id);
    results.push({ all, replies, l1 });
    assert.deepEqual(all, [EV(4), EV(3), EV(1)], 'newest first');
    assert.deepEqual(replies, [EV(4), EV(1)]);
    assert.deepEqual(l1, [EV(3), EV(1)]);
    assert.deepEqual((await s.replyRoutes.list({ limit: 1, offset: 1 })).map((r) => r.event_id), [EV(3)], `${name}: offset pages`);
    assert.deepEqual((await s.replyRoutes.list({ limit: 5, offset: 3 })).map((r) => r.event_id), [], `${name}: past the end`);
    await s.purgeLead('L1');
    assert.deepEqual((await s.replyRoutes.list({})).map((r) => r.event_id), [EV(4)], `${name}: the lead's routes go with it`);
  }
  if (results.length === 2) assert.deepEqual(results[0], results[1], 'SQL and Memory twins agree');
});

test('F29 store: the runtime declares li_reply_routes, and nothing in the store holds text', () => {
  const rt = fs.readFileSync(path.join(LI, 'lead-intelligence-runtime.js'), 'utf8');
  assert.ok(rt.includes("'li_reply_routes',"));
  const repo = fs.readFileSync(path.join(LI, 'persistence', 'replyRouteRepos.js'), 'utf8');
  assert.ok(!/subject|snippet|body/i.test(repo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')), 'the repository has no text field');
});
