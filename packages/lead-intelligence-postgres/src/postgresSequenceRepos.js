'use strict';

/**
 * The PostgreSQL sequence repositories (M1).
 *
 * They mirror the desktop's exactly, and they reuse the desktop's own
 * normalisation (`normalizeSequence`, `normalizeStep`, `checkPatch`,
 * `stepFromRow`, `stepToRow`) so that the rules are not written twice.
 *
 * The compare-and-set semantics are the important part: every write that
 * changes a status or a step state checks its precondition first, so a human
 * and the scheduler can never both win. In PostgreSQL the same check is done,
 * inside the same transaction.
 *
 * li_sequence_control - the one global "Pause all follow-ups" switch - is
 * global and carries no workspace.
 */

const { normalizeSequence, normalizeStep, normalizeEvent } = require('@zunitech/lead-intelligence/sequences/sequenceContract');
const { stepFromRow, stepToRow, checkPatch, SEQ_PATCHABLE, STEP_PATCHABLE, MAX_LIST } = require('@zunitech/lead-intelligence/persistence/sequenceRepos');

const SEQ_COLS = ['sequence_id', 'lead_id', 'mailbox_id', 'first_send_id', 'first_pitch_id', 'thread_id', 'first_subject', 'recipient_address', 'first_accepted_at', 'status', 'hold_code', 'resume_at', 'replies_gap_at', 'stop_reason', 'activated_at', 'created_at', 'updated_at'];
const STEP_COLS = ['sequence_id', 'step_no', 'pitch_id', 'delay_days', 'state', 'due_at', 'next_attempt_at', 'send_id', 'sent_at', 'last_code', 'limit_strikes', 'draft_json', 'updated_at'];
const EVENT_COLS = ['event_id', 'sequence_id', 'step_no', 'actor', 'event', 'code', 'at'];

const freeze = (r) => (r ? Object.freeze({ ...r }) : null);
const clampLimit = (n) => Math.max(1, Math.min(MAX_LIST, Number.isInteger(n) ? n : MAX_LIST));

class PgSequences {
  constructor(store) { this.s = store; }

  async _seq(id) {
    return freeze(await this.s.one('li_sequences', `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE sequence_id = ? AND workspace_id = ?`, [String(id), this.s.workspaceId]));
  }

  async _step(id, no) {
    return stepFromRow(await this.s.one('li_sequence_steps', `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE sequence_id = ? AND step_no = ? AND workspace_id = ?`, [String(id), no, this.s.workspaceId]));
  }

  async create(sequence, steps) {
    const seq = normalizeSequence(sequence);
    const rows = steps.map((s) => stepToRow(normalizeStep(s)));
    return this.s.tx(async () => {
      await this.s.insert('li_sequences', SEQ_COLS, SEQ_COLS.map((c) => seq[c]));
      for (const r of rows) {
        await this.s.insert('li_sequence_steps', STEP_COLS, STEP_COLS.map((c) => r[c]));
      }
      return this._seq(seq.sequence_id);
    });
  }

  async get(sequenceId) {
    return this._seq(sequenceId);
  }

  async steps(sequenceId) {
    const list = await this.s.q('li_sequence_steps', `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE sequence_id = ? AND workspace_id = ? ORDER BY step_no ASC`, [String(sequenceId), this.s.workspaceId]);
    return list.map(stepFromRow);
  }

  async openForLead(leadId) {
    return freeze(await this.s.one('li_sequences', `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE lead_id = ? AND status IN ('draft', 'active', 'paused') AND workspace_id = ? LIMIT 1`, [String(leadId), this.s.workspaceId]));
  }

  async latestForLead(leadId) {
    return freeze(await this.s.one('li_sequences', `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE lead_id = ? AND workspace_id = ? ORDER BY created_at DESC, sequence_id DESC LIMIT 1`, [String(leadId), this.s.workspaceId]));
  }

  async forFirstSend(sendId) {
    return freeze(await this.s.one('li_sequences', `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE first_send_id = ? AND workspace_id = ?`, [String(sendId), this.s.workspaceId]));
  }

  async listOpen(limit = MAX_LIST) {
    const list = await this.s.q('li_sequences', `SELECT ${SEQ_COLS.join(', ')} FROM li_sequences WHERE status IN ('draft', 'active', 'paused') AND workspace_id = ? ORDER BY updated_at DESC, sequence_id DESC LIMIT ?`, [this.s.workspaceId, clampLimit(limit)]);
    return list.map(freeze);
  }

  async update(sequenceId, patch, { expect = null, expectHold = undefined } = {}) {
    checkPatch(patch, SEQ_PATCHABLE);
    return this.s.tx(async () => {
      const cur = await this._seq(sequenceId);
      if (!cur) return null;
      if (expect && !expect.includes(cur.status)) return null;
      if (expectHold !== undefined && cur.hold_code !== expectHold) return null;
      const next = normalizeSequence({ ...cur, ...patch });
      await this.s.run('UPDATE li_sequences SET status = ?, hold_code = ?, resume_at = ?, replies_gap_at = ?, stop_reason = ?, activated_at = ?, updated_at = ? WHERE sequence_id = ? AND workspace_id = ?', [
        next.status, next.hold_code, next.resume_at, next.replies_gap_at, next.stop_reason, next.activated_at, next.updated_at, next.sequence_id, this.s.workspaceId,
      ]);
      return this._seq(sequenceId);
    });
  }

  async claimStep(sequenceId, stepNo, updatedAt) {
    return this.s.tx(async () => {
      const seq = await this._seq(sequenceId);
      const ctl = await this.s.one('li_sequence_control', 'SELECT paused FROM li_sequence_control WHERE workspace_id = ? AND id = 1', [this.s.workspaceId]);
      const cur = await this._step(sequenceId, stepNo);
      if (!seq || seq.status !== 'active' || seq.replies_gap_at || (ctl && Number(ctl.paused) === 1) || !cur || cur.state !== 'scheduled') return null;
      await this.s.run("UPDATE li_sequence_steps SET state = 'sending', updated_at = ? WHERE sequence_id = ? AND step_no = ? AND state = 'scheduled' AND workspace_id = ?", [String(updatedAt), String(sequenceId), stepNo, this.s.workspaceId]);
      return this._step(sequenceId, stepNo);
    });
  }

  async updateStep(sequenceId, stepNo, patch, { expect = null } = {}) {
    checkPatch(patch, STEP_PATCHABLE);
    return this.s.tx(async () => {
      const cur = await this._step(sequenceId, stepNo);
      if (!cur) return null;
      if (expect && !expect.includes(cur.state)) return null;
      const r = stepToRow(normalizeStep({ ...cur, ...patch }));
      await this.s.run('UPDATE li_sequence_steps SET state = ?, due_at = ?, next_attempt_at = ?, send_id = ?, sent_at = ?, last_code = ?, limit_strikes = ?, draft_json = ?, updated_at = ? WHERE sequence_id = ? AND step_no = ? AND workspace_id = ?', [
        r.state, r.due_at, r.next_attempt_at, r.send_id, r.sent_at, r.last_code, r.limit_strikes, r.draft_json, r.updated_at, r.sequence_id, r.step_no, this.s.workspaceId,
      ]);
      return this._step(sequenceId, stepNo);
    });
  }

  async stepByPitch(pitchId) {
    return stepFromRow(await this.s.one('li_sequence_steps', `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE pitch_id = ? AND workspace_id = ?`, [String(pitchId), this.s.workspaceId]));
  }

  async dueSteps(nowIso, limit = 50) {
    const list = await this.s.q('li_sequence_steps', `SELECT ${STEP_COLS.map((c) => `st.${c}`).join(', ')} FROM li_sequence_steps st JOIN li_sequences sq ON sq.sequence_id = st.sequence_id
      WHERE sq.status = 'active' AND st.state = 'scheduled' AND st.next_attempt_at IS NOT NULL AND st.next_attempt_at <= ?
      AND sq.workspace_id = ? AND st.workspace_id = ?
      ORDER BY st.next_attempt_at ASC, st.sequence_id ASC LIMIT ?`, [String(nowIso), this.s.workspaceId, this.s.workspaceId, clampLimit(limit)]);
    return list.map(stepFromRow);
  }

  async stepsInState(state, limit = MAX_LIST) {
    const list = await this.s.q('li_sequence_steps', `SELECT ${STEP_COLS.join(', ')} FROM li_sequence_steps WHERE state = ? AND workspace_id = ? ORDER BY updated_at ASC, sequence_id ASC, step_no ASC LIMIT ?`, [String(state), this.s.workspaceId, clampLimit(limit)]);
    return list.map(stepFromRow);
  }

  async appendEvent(rec) {
    const v = normalizeEvent(rec);
    await this.s.insert('li_sequence_events', EVENT_COLS, EVENT_COLS.map((c) => v[c]));
    return freeze(v);
  }

  async events(sequenceId, limit = 100) {
    const list = await this.s.q('li_sequence_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_sequence_events WHERE sequence_id = ? AND workspace_id = ? ORDER BY at DESC, seq DESC LIMIT ?`, [String(sequenceId), this.s.workspaceId, clampLimit(limit)]);
    return list.map(freeze);
  }

  async noteGap(mailboxId, atIso) {
    // The desktop keeps the LATEST gap. The comparison is on the instant, so
    // it means the same thing here as it does on the desktop's text column.
    await this.s.run('INSERT INTO li_sequence_gaps (workspace_id, mailbox_id, gap_at) VALUES (?, ?, ?) '
      + 'ON CONFLICT (mailbox_id) DO UPDATE SET gap_at = CASE WHEN excluded.gap_at > li_sequence_gaps.gap_at THEN excluded.gap_at ELSE li_sequence_gaps.gap_at END',
    [this.s.workspaceId, String(mailboxId), String(atIso)]);
    return true;
  }

  async gapFor(mailboxId) {
    const r = await this.s.one('li_sequence_gaps', 'SELECT gap_at FROM li_sequence_gaps WHERE mailbox_id = ? AND workspace_id = ?', [String(mailboxId), this.s.workspaceId]);
    return r ? r.gap_at : null;
  }

  /**
   * The "Pause all follow-ups" switch of THIS workspace. One customer's
   * pause must not pause another customer's sequences, so the row is scoped
   * by the workspace.
   */
  async control() {
    const r = await this.s.one('li_sequence_control', 'SELECT paused, updated_at FROM li_sequence_control WHERE workspace_id = ? AND id = 1', [this.s.workspaceId]);
    return Object.freeze({ paused: Boolean(r && Number(r.paused) === 1), updatedAt: r ? r.updated_at : null });
  }

  async setControl({ paused, updatedAt }) {
    await this.s.run('INSERT INTO li_sequence_control (workspace_id, id, paused, updated_at) VALUES (?, 1, ?, ?) '
      + 'ON CONFLICT (workspace_id, id) DO UPDATE SET paused = excluded.paused, updated_at = excluded.updated_at',
    [this.s.workspaceId, Boolean(paused), updatedAt]);
    return this.control();
  }

  async deleteByLead(leadId) {
    const id = String(leadId);
    await this.s.run('DELETE FROM li_outreach_approvals WHERE pitch_id IN (SELECT st.pitch_id FROM li_sequence_steps st JOIN li_sequences sq ON sq.sequence_id = st.sequence_id WHERE sq.lead_id = ? AND sq.workspace_id = ?)', [id, this.s.workspaceId]);
    await this.s.run('DELETE FROM li_sequence_steps WHERE sequence_id IN (SELECT sequence_id FROM li_sequences WHERE lead_id = ? AND workspace_id = ?)', [id, this.s.workspaceId]);
    await this.s.run('DELETE FROM li_sequences WHERE lead_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
  }
}

module.exports = { PgSequences };
