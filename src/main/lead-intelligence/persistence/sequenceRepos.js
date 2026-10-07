'use strict';

/**
 * F28: follow-up sequence repositories (migration 012), SqlJs and Memory twins.
 *
 * Every write that changes a status or a step state is a compare-and-set (`expect`), so the
 * scheduler and a human acting at the same moment can never both win: the loser gets null and
 * re-reads. Nothing here sends or decides anything.
 */

const { normalizeSequence, normalizeStep, normalizeEvent, OPEN_STATUSES } = require('../sequences/sequenceContract');

const SEQ_COLS = ['sequence_id', 'lead_id', 'mailbox_id', 'first_send_id', 'first_pitch_id', 'thread_id', 'first_subject', 'recipient_address', 'first_accepted_at', 'status', 'hold_code', 'resume_at', 'replies_gap_at', 'stop_reason', 'activated_at', 'created_at', 'updated_at'];
const STEP_COLS = ['sequence_id', 'step_no', 'pitch_id', 'delay_days', 'state', 'due_at', 'next_attempt_at', 'send_id', 'sent_at', 'last_code', 'limit_strikes', 'draft_json', 'updated_at'];
const EVENT_COLS = ['event_id', 'sequence_id', 'step_no', 'actor', 'event', 'code', 'at'];
const SEQ_PATCHABLE = new Set(['status', 'hold_code', 'resume_at', 'replies_gap_at', 'stop_reason', 'activated_at', 'updated_at']);
const STEP_PATCHABLE = new Set(['state', 'due_at', 'next_attempt_at', 'send_id', 'sent_at', 'last_code', 'limit_strikes', 'draft', 'updated_at']);
const MAX_LIST = 500;

function sqlRows(db, sql, params = []) {
  const st = db.prepare(sql);
  try {
    st.bind(params);
    const out = [];
    while (st.step()) out.push(st.getAsObject());
    return out;
  } finally {
    st.free();
  }
}
const sqlRow = (db, sql, params) => sqlRows(db, sql, params)[0] || null;
const ph = (cols) => cols.map(() => '?').join(', ');
const freeze = (r) => (r ? Object.freeze({ ...r }) : null);
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIST, Number.isInteger(n) ? n : MAX_LIST));

function checkPatch(patch, allowed) {
  for (const k of Object.keys(patch || {})) if (!allowed.has(k)) throw new TypeError(`sequence repo: ${k} is not patchable`);
}

function stepFromRow(r) {
  if (!r) return null;
  let draft = null;
  try { draft = JSON.parse(r.draft_json); } catch { draft = null; }
  const { draft_json: _ignored, ...rest } = r;
  return Object.freeze({ ...rest, draft });
}

function stepToRow(v) {
  return { ...v, draft_json: JSON.stringify(v.draft) };
}

/* =============================== SQL =============================== */

class SqlSequences {
  constructor(store) { this.s = store; }

  _seq(id) { return freeze(sqlRow(this.s.db, `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE sequence_id = ?`, [String(id)])); }

  _step(id, no) { return stepFromRow(sqlRow(this.s.db, `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE sequence_id = ? AND step_no = ?`, [String(id), no])); }

  /** Create a draft sequence and all its steps in ONE transaction. */
  async create(sequence, steps) {
    const seq = normalizeSequence(sequence);
    const rows = steps.map((s) => stepToRow(normalizeStep(s)));
    return this.s.tx(() => {
      this.s.db.run(`INSERT INTO li_sequences (${SEQ_COLS.join(', ')}) VALUES (${ph(SEQ_COLS)})`, SEQ_COLS.map((c) => seq[c]));
      for (const r of rows) this.s.db.run(`INSERT INTO li_sequence_steps (${STEP_COLS.join(', ')}) VALUES (${ph(STEP_COLS)})`, STEP_COLS.map((c) => r[c]));
      return this._seq(seq.sequence_id);
    });
  }

  async get(sequenceId) { return this._seq(sequenceId); }

  async steps(sequenceId) {
    return sqlRows(this.s.db, `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE sequence_id = ? ORDER BY step_no ASC`, [String(sequenceId)]).map(stepFromRow);
  }

  async openForLead(leadId) {
    return freeze(sqlRow(this.s.db, `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE lead_id = ? AND status IN ('draft', 'active', 'paused') LIMIT 1`, [String(leadId)]));
  }

  async latestForLead(leadId) {
    return freeze(sqlRow(this.s.db, `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE lead_id = ? ORDER BY created_at DESC, sequence_id DESC LIMIT 1`, [String(leadId)]));
  }

  async forFirstSend(sendId) {
    return freeze(sqlRow(this.s.db, `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE first_send_id = ?`, [String(sendId)]));
  }

  async listOpen(limit = MAX_LIST) {
    return sqlRows(this.s.db, `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE status IN ('draft', 'active', 'paused') ORDER BY updated_at DESC, sequence_id DESC LIMIT ?`, [clampLimit(limit)]).map(freeze);
  }

  /**
   * Compare-and-set on status (and, with `expectHold`, on the exact hold code). Returns the new row,
   * or null when the expectation no longer holds.
   */
  async update(sequenceId, patch, { expect = null, expectHold = undefined } = {}) {
    checkPatch(patch, SEQ_PATCHABLE);
    return this.s.tx(() => {
      const cur = this._seq(sequenceId);
      if (!cur) return null;
      if (expect && !expect.includes(cur.status)) return null;
      if (expectHold !== undefined && cur.hold_code !== expectHold) return null;
      const next = normalizeSequence({ ...cur, ...patch });
      this.s.db.run('UPDATE li_sequences SET status = ?, hold_code = ?, resume_at = ?, replies_gap_at = ?, stop_reason = ?, activated_at = ?, updated_at = ? WHERE sequence_id = ?',
        [next.status, next.hold_code, next.resume_at, next.replies_gap_at, next.stop_reason, next.activated_at, next.updated_at, next.sequence_id]);
      return this._seq(sequenceId);
    });
  }

  /**
   * The ONE transition into 'sending', atomic with its preconditions: the step is still
   * 'scheduled', its sequence is still 'active' with no reply gap, and "Pause all" is off.
   * A human Pause / Stop / Pause all that lands first always wins.
   */
  async claimStep(sequenceId, stepNo, updatedAt) {
    return this.s.tx(() => {
      const seq = this._seq(sequenceId);
      const ctl = sqlRow(this.s.db, 'SELECT paused FROM li_sequence_control WHERE id = 1');
      const cur = this._step(sequenceId, stepNo);
      if (!seq || seq.status !== 'active' || seq.replies_gap_at || (ctl && ctl.paused === 1) || !cur || cur.state !== 'scheduled') return null;
      this.s.db.run("UPDATE li_sequence_steps SET state = 'sending', updated_at = ? WHERE sequence_id = ? AND step_no = ? AND state = 'scheduled'", [String(updatedAt), String(sequenceId), stepNo]);
      return this._step(sequenceId, stepNo);
    });
  }

  /** Compare-and-set on step state. */
  async updateStep(sequenceId, stepNo, patch, { expect = null } = {}) {
    checkPatch(patch, STEP_PATCHABLE);
    return this.s.tx(() => {
      const cur = this._step(sequenceId, stepNo);
      if (!cur) return null;
      if (expect && !expect.includes(cur.state)) return null;
      const r = stepToRow(normalizeStep({ ...cur, ...patch }));
      this.s.db.run('UPDATE li_sequence_steps SET state = ?, due_at = ?, next_attempt_at = ?, send_id = ?, sent_at = ?, last_code = ?, limit_strikes = ?, draft_json = ?, updated_at = ? WHERE sequence_id = ? AND step_no = ?',
        [r.state, r.due_at, r.next_attempt_at, r.send_id, r.sent_at, r.last_code, r.limit_strikes, r.draft_json, r.updated_at, r.sequence_id, r.step_no]);
      return this._step(sequenceId, stepNo);
    });
  }

  async stepByPitch(pitchId) {
    return stepFromRow(sqlRow(this.s.db, `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE pitch_id = ?`, [String(pitchId)]));
  }

  /** Scheduled steps of ACTIVE sequences whose next attempt has come, oldest first. */
  async dueSteps(nowIso, limit = 50) {
    return sqlRows(this.s.db,
      `SELECT ${STEP_COLS.map((c) => `st.${c}`).join(', ')} FROM li_sequence_steps st JOIN li_sequences sq ON sq.sequence_id = st.sequence_id
       WHERE sq.status = 'active' AND st.state = 'scheduled' AND st.next_attempt_at IS NOT NULL AND st.next_attempt_at <= ?
       ORDER BY st.next_attempt_at ASC, st.sequence_id ASC LIMIT ?`, [String(nowIso), clampLimit(limit)]).map(stepFromRow);
  }

  async stepsInState(state, limit = MAX_LIST) {
    return sqlRows(this.s.db, `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE state = ? ORDER BY updated_at ASC, sequence_id ASC, step_no ASC LIMIT ?`, [String(state), clampLimit(limit)]).map(stepFromRow);
  }

  async appendEvent(rec) {
    const v = normalizeEvent(rec);
    return this.s.tx(() => {
      this.s.db.run(`INSERT INTO li_sequence_events (${EVENT_COLS.join(', ')}) VALUES (${ph(EVENT_COLS)})`, EVENT_COLS.map((c) => v[c]));
      return freeze(v);
    });
  }

  async events(sequenceId, limit = 100) {
    return sqlRows(this.s.db, `SELECT ${EVENT_COLS.join(', ')} FROM li_sequence_events WHERE sequence_id = ? ORDER BY at DESC, rowid DESC LIMIT ?`, [String(sequenceId), clampLimit(limit)]).map(freeze);
  }

  async control() {
    const r = sqlRow(this.s.db, 'SELECT paused, updated_at FROM li_sequence_control WHERE id = 1');
    return Object.freeze({ paused: Boolean(r && r.paused === 1), updatedAt: r ? r.updated_at : null });
  }

  async setControl({ paused, updatedAt }) {
    return this.s.tx(() => {
      this.s.db.run('INSERT INTO li_sequence_control (id, paused, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at', [paused ? 1 : 0, String(updatedAt)]);
      return Object.freeze({ paused: Boolean(paused), updatedAt: String(updatedAt) });
    });
  }

  /** purgeLead, inside its transaction: a lead's sequences, steps and step approvals go; events stay. */
  _deleteByLeadSql(leadId) {
    const id = String(leadId);
    this.s.db.run('DELETE FROM li_outreach_approvals WHERE pitch_id IN (SELECT st.pitch_id FROM li_sequence_steps st JOIN li_sequences sq ON sq.sequence_id = st.sequence_id WHERE sq.lead_id = ?)', [id]);
    this.s.db.run('DELETE FROM li_sequence_steps WHERE sequence_id IN (SELECT sequence_id FROM li_sequences WHERE lead_id = ?)', [id]);
    this.s.db.run('DELETE FROM li_sequences WHERE lead_id = ?', [id]);
  }
}

/* ============================= MEMORY ============================== */

class MemSequences {
  constructor() {
    this.seqs = new Map();
    this.stepRows = new Map(); // `${sequenceId}#${stepNo}` -> step
    this.eventRows = [];
    this.ctl = { paused: false, updatedAt: null };
  }

  _key(id, no) { return `${id}#${no}`; }
  _stepsOf(id) { return [...this.stepRows.values()].filter((s) => s.sequence_id === id).sort((a, b) => a.step_no - b.step_no); }

  async create(sequence, steps) {
    const seq = normalizeSequence(sequence);
    const rows = steps.map((s) => normalizeStep(s));
    if (this.seqs.has(seq.sequence_id)) throw new Error('UNIQUE constraint failed: li_sequences.sequence_id');
    if (OPEN_STATUSES.includes(seq.status) && [...this.seqs.values()].some((r) => r.lead_id === seq.lead_id && OPEN_STATUSES.includes(r.status))) {
      throw new Error('UNIQUE constraint failed: li_sequences.lead_id');
    }
    if ([...this.seqs.values()].some((r) => r.first_send_id === seq.first_send_id)) throw new Error('UNIQUE constraint failed: li_sequences.first_send_id');
    for (const r of rows) {
      if ([...this.stepRows.values()].some((x) => x.pitch_id === r.pitch_id)) throw new Error('UNIQUE constraint failed: li_sequence_steps.pitch_id');
    }
    this.seqs.set(seq.sequence_id, seq);
    for (const r of rows) this.stepRows.set(this._key(r.sequence_id, r.step_no), r);
    return freeze(seq);
  }

  async get(sequenceId) { return freeze(this.seqs.get(String(sequenceId)) || null); }
  async steps(sequenceId) { return this._stepsOf(String(sequenceId)).map(freeze); }
  async openForLead(leadId) { return freeze([...this.seqs.values()].find((r) => r.lead_id === String(leadId) && OPEN_STATUSES.includes(r.status)) || null); }
  async latestForLead(leadId) {
    return freeze([...this.seqs.values()].filter((r) => r.lead_id === String(leadId))
      .sort((a, b) => (a.created_at === b.created_at ? (a.sequence_id < b.sequence_id ? 1 : -1) : (a.created_at < b.created_at ? 1 : -1)))[0] || null);
  }
  async forFirstSend(sendId) { return freeze([...this.seqs.values()].find((r) => r.first_send_id === String(sendId)) || null); }
  async listOpen(limit = MAX_LIST) {
    return [...this.seqs.values()].filter((r) => OPEN_STATUSES.includes(r.status))
      .sort((a, b) => (a.updated_at === b.updated_at ? (a.sequence_id < b.sequence_id ? 1 : -1) : (a.updated_at < b.updated_at ? 1 : -1)))
      .slice(0, clampLimit(limit)).map(freeze);
  }

  async update(sequenceId, patch, { expect = null, expectHold = undefined } = {}) {
    checkPatch(patch, SEQ_PATCHABLE);
    const cur = this.seqs.get(String(sequenceId));
    if (!cur) return null;
    if (expect && !expect.includes(cur.status)) return null;
    if (expectHold !== undefined && cur.hold_code !== expectHold) return null;
    const next = normalizeSequence({ ...cur, ...patch });
    this.seqs.set(next.sequence_id, next);
    return freeze(next);
  }

  async claimStep(sequenceId, stepNo, updatedAt) {
    const seq = this.seqs.get(String(sequenceId));
    const k = this._key(String(sequenceId), stepNo);
    const cur = this.stepRows.get(k);
    if (!seq || seq.status !== 'active' || seq.replies_gap_at || this.ctl.paused || !cur || cur.state !== 'scheduled') return null;
    const next = normalizeStep({ ...cur, state: 'sending', updated_at: String(updatedAt) });
    this.stepRows.set(k, next);
    return freeze(next);
  }

  async updateStep(sequenceId, stepNo, patch, { expect = null } = {}) {
    checkPatch(patch, STEP_PATCHABLE);
    const k = this._key(String(sequenceId), stepNo);
    const cur = this.stepRows.get(k);
    if (!cur) return null;
    if (expect && !expect.includes(cur.state)) return null;
    const next = normalizeStep({ ...cur, ...patch });
    this.stepRows.set(k, next);
    return freeze(next);
  }

  async stepByPitch(pitchId) { return freeze([...this.stepRows.values()].find((s) => s.pitch_id === String(pitchId)) || null); }

  async dueSteps(nowIso, limit = 50) {
    return [...this.stepRows.values()]
      .filter((s) => s.state === 'scheduled' && s.next_attempt_at && s.next_attempt_at <= String(nowIso) && (this.seqs.get(s.sequence_id) || {}).status === 'active')
      .sort((a, b) => (a.next_attempt_at === b.next_attempt_at ? (a.sequence_id < b.sequence_id ? -1 : 1) : (a.next_attempt_at < b.next_attempt_at ? -1 : 1)))
      .slice(0, clampLimit(limit)).map(freeze);
  }

  async stepsInState(state, limit = MAX_LIST) {
    return [...this.stepRows.values()].filter((s) => s.state === String(state))
      .sort((a, b) => (a.updated_at === b.updated_at ? (a.sequence_id === b.sequence_id ? a.step_no - b.step_no : (a.sequence_id < b.sequence_id ? -1 : 1)) : (a.updated_at < b.updated_at ? -1 : 1)))
      .slice(0, clampLimit(limit)).map(freeze);
  }

  async appendEvent(rec) {
    const v = normalizeEvent(rec);
    if (this.eventRows.some((e) => e.event_id === v.event_id)) throw new Error('UNIQUE constraint failed: li_sequence_events.event_id');
    this.eventRows.push(v);
    return freeze(v);
  }

  async events(sequenceId, limit = 100) {
    // Newest first; events at the same instant keep their insertion order (like SQL rowid).
    return this.eventRows.map((e, i) => [e, i]).filter(([e]) => e.sequence_id === String(sequenceId))
      .sort(([a, ia], [b, ib]) => (a.at === b.at ? ib - ia : (a.at < b.at ? 1 : -1)))
      .slice(0, clampLimit(limit)).map(([e]) => freeze(e));
  }

  async control() { return Object.freeze({ paused: this.ctl.paused, updatedAt: this.ctl.updatedAt }); }
  async setControl({ paused, updatedAt }) { this.ctl = { paused: Boolean(paused), updatedAt: String(updatedAt) }; return this.control(); }

  /** Returns the step pitch ids that were removed (the store drops their approvals). */
  deleteByLead(leadId) {
    const ids = [...this.seqs.values()].filter((r) => r.lead_id === String(leadId)).map((r) => r.sequence_id);
    const pitchIds = [];
    for (const [k, s] of [...this.stepRows.entries()]) {
      if (ids.includes(s.sequence_id)) { pitchIds.push(s.pitch_id); this.stepRows.delete(k); }
    }
    for (const id of ids) this.seqs.delete(id);
    return pitchIds;
  }
}

module.exports = {
  SqlSequences, MemSequences,
  SEQUENCE_TABLE_COLUMNS: Object.freeze({ li_sequences: SEQ_COLS, li_sequence_steps: STEP_COLS, li_sequence_events: EVENT_COLS }),
};
