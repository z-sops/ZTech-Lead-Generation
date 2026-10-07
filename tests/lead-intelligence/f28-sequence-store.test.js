'use strict';

// F28 - migration 012 and the sequence repositories (SqlJs + Memory twins). No network anywhere.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const LI = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence');
const { SqlJsStore } = require(path.join(LI, 'persistence', 'SqlJsStore'));
const { MemoryStore } = require(path.join(LI, 'persistence', 'MemoryStore'));
const { MIGRATIONS } = require(path.join(LI, 'persistence', 'migrations'));
const C = require(path.join(LI, 'sequences', 'sequenceContract'));

let initSqlJs = null;
try { initSqlJs = require('sql.js'); } catch { initSqlJs = null; }
const skip = initSqlJs ? false : 'sql.js not installed';
const SILENT = { warn() {}, info() {}, error() {} };
const SQL12 = fs.readFileSync(path.join(LI, 'migrations', '012_sequences.sql'), 'utf8');
const T = '2026-10-07T10:00:00.000Z';
/** A refusal that names `field` (in the message or the validation details). */
const names = (field) => (e) => (String(e.message) + JSON.stringify(e.details || {})).includes(field);

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
const seq = (o = {}) => ({
  sequence_id: 'seq_aaaaaaaa-0001', lead_id: 'L1', mailbox_id: 'mbx_aaaaaaaaaaaa', first_send_id: 'send_1', first_pitch_id: 'pitch_1',
  thread_id: 't1', first_subject: 'A few notes', recipient_address: 'Hello@Acme.example', first_accepted_at: T, status: 'draft',
  hold_code: null, resume_at: null, stop_reason: null, activated_at: null, created_at: T, updated_at: T, ...o,
});
const step = (no, o = {}) => ({
  sequence_id: 'seq_aaaaaaaa-0001', step_no: no, pitch_id: `pitch_f${no}`, delay_days: [3, 7, 14][no - 1], state: 'waiting',
  draft: { pitch_id: `pitch_f${no}`, kind: 'followup', subject: 'A few notes' }, updated_at: T, ...o,
});
const checkOf = (table, col) => {
  const body = SQL12.slice(SQL12.indexOf(`CREATE TABLE IF NOT EXISTS ${table}`));
  const m = body.match(new RegExp(`\\b${col}\\s+\\w+[^,]*CHECK \\(${col}(?: IS NULL OR ${col})? IN \\(([^)]*)\\)`));
  assert.ok(m, table + '.' + col);
  return m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
};

test('S1. 012 is the twelfth migration; its CHECK lists equal the sequence contract (one vocabulary)', () => {
  assert.equal(MIGRATIONS[11].version, 12);
  assert.equal(MIGRATIONS[11].name, '012_sequences.sql');
  assert.deepEqual(checkOf('li_sequences', 'status'), [...C.SEQUENCE_STATUSES]);
  assert.deepEqual(checkOf('li_sequences', 'stop_reason'), [...C.STOP_REASONS]);
  assert.deepEqual(checkOf('li_sequence_steps', 'state'), [...C.STEP_STATES]);
  assert.deepEqual(checkOf('li_sequence_events', 'actor'), [...C.EVENT_ACTORS]);
  assert.deepEqual(checkOf('li_sequence_events', 'event'), [...C.SEQUENCE_EVENTS]);
  assert.ok(!/token|secret|body|address_raw/i.test(SQL12.replace(/--.*$/gm, '')), 'no token, secret or message body column');
});

test('S2. both twins: one open sequence per lead, one sequence per first email, compare-and-set transitions', async () => {
  for (const [kind, store] of await stores()) {
    const created = await store.sequences.create(seq(), [step(1), step(2), step(3)]);
    assert.equal(created.recipient_address, 'hello@acme.example', kind + ': address normalized');
    await assert.rejects(store.sequences.create(seq({ sequence_id: 'seq_aaaaaaaa-0002', first_send_id: 'send_2' }), []), /UNIQUE/, kind);
    assert.equal((await store.sequences.steps(created.sequence_id)).map((s) => s.draft.kind).join(), 'followup,followup,followup');
    assert.equal(await store.sequences.update(created.sequence_id, { status: 'active', updated_at: T }, { expect: ['paused'] }), null, kind + ': CAS refuses');
    const a = await store.sequences.update(created.sequence_id, { status: 'active', activated_at: T, updated_at: T }, { expect: ['draft'] });
    assert.equal(a.status, 'active');
    await assert.rejects(store.sequences.update(created.sequence_id, { status: 'stopped', updated_at: T }), names('stop_reason'), kind + ': stopped needs a reason');
    await assert.rejects(store.sequences.update(created.sequence_id, { status: 'paused', updated_at: T }), names('hold_code'), kind + ': paused needs a hold');
    await assert.rejects(store.sequences.update(created.sequence_id, { lead_id: 'L9' }), /not patchable/, kind);
    assert.equal(await store.sequences.updateStep(created.sequence_id, 1, { state: 'sent', updated_at: T }, { expect: ['scheduled'] }), null);
    await store.sequences.updateStep(created.sequence_id, 1, { state: 'scheduled', due_at: T, next_attempt_at: T, updated_at: T }, { expect: ['waiting'] });
    assert.equal((await store.sequences.dueSteps('2026-10-07T10:00:01.000Z')).length, 1, kind + ': due');
    assert.equal((await store.sequences.dueSteps('2026-10-07T09:59:59.000Z')).length, 0, kind + ': not yet');
    await store.sequences.update(created.sequence_id, { status: 'paused', hold_code: 'MANUAL', updated_at: T });
    assert.equal((await store.sequences.dueSteps('2026-10-08T00:00:00.000Z')).length, 0, kind + ': a paused sequence has no due steps');
    assert.equal((await store.sequences.stepByPitch('pitch_f2')).step_no, 2);
    const stopped = await store.sequences.update(created.sequence_id, { status: 'stopped', stop_reason: 'manual', hold_code: null, updated_at: T });
    assert.equal(stopped.status, 'stopped');
    await assert.doesNotReject(store.sequences.create(seq({ sequence_id: 'seq_aaaaaaaa-0003', first_send_id: 'send_3' }), []), kind + ': a new first email may start a new sequence');
    await assert.rejects(store.sequences.create(seq({ sequence_id: 'seq_aaaaaaaa-0004', lead_id: 'L2' }), []), /UNIQUE/, kind + ': never twice from one first email');
  }
});

test('S3. both twins: purgeLead removes sequences, steps and step approvals; keeps the audit and the switch', async () => {
  for (const [kind, store] of await stores()) {
    await store.sequences.create(seq(), [step(1)]);
    await store.approvals.insert({ approval_id: 'appr_1', pitch_id: 'pitch_f1', content_hash: 'h', approved_by: 'Zee', approved_at: T });
    await store.sequences.appendEvent({ event_id: 'sev_aaaaaaaa-1', sequence_id: 'seq_aaaaaaaa-0001', actor: 'operator', event: 'created', at: T });
    await store.sequences.setControl({ paused: true, updatedAt: T });
    await store.purgeLead('L1');
    assert.equal(await store.sequences.get('seq_aaaaaaaa-0001'), null, kind);
    assert.equal(await store.sequences.stepByPitch('pitch_f1'), null, kind);
    assert.equal(await store.approvals.latestForPitch('pitch_f1') || null, null, kind + ': step approvals go too');
    assert.equal((await store.sequences.events('seq_aaaaaaaa-0001')).length, 1, kind + ': the audit stays');
    assert.equal((await store.sequences.control()).paused, true, kind);
  }
});

test('S4. events carry codes only; an invalid record never reaches the table', async () => {
  for (const [kind, store] of await stores()) {
    await assert.rejects(store.sequences.appendEvent({ event_id: 'sev_aaaaaaaa-2', sequence_id: 'seq_aaaaaaaa-0001', actor: 'renderer', event: 'sent', at: T }), names('actor'), kind);
    await assert.rejects(store.sequences.appendEvent({ event_id: 'sev_aaaaaaaa-3', sequence_id: 'seq_aaaaaaaa-0001', actor: 'scheduler', event: 'sent', code: 'hello@acme.example', at: T }), names('code'), kind);
    await assert.rejects(store.sequences.create(seq({ first_subject: 'a\r\nBcc: x@y.z' }), []), names('first_subject'), kind);
    await assert.rejects(store.sequences.create(seq(), [step(1, { delay_days: 1 })]), names('delay_days'), kind + ': D6 minimum gap 2 days');
    await assert.rejects(store.sequences.create(seq(), [step(1, { draft: { pitch_id: 'pitch_f1', kind: 'pitch' } })]), names('draft'), kind);
  }
});
