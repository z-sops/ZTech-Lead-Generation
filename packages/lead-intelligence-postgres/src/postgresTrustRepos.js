'use strict';

/**
 * The PostgreSQL trust repositories (M1): suppressions, consents, provenance,
 * trust events and recipient refs.
 *
 * They mirror the desktop's trust repositories exactly, with one addition: the
 * rows carry the store's workspace, and every read is scoped to it. A
 * suppression with scope 'global' has no workspace and is visible everywhere -
 * that is the one table whose own workspace column means something different
 * from the store's.
 */

const SUPPRESSION_COLS = ['suppression_id', 'scope', 'workspace_id', 'channel', 'normalized_address', 'reason', 'source', 'created_at'];
const CONSENT_COLS = ['consent_id', 'lead_id', 'channel', 'normalized_address', 'method', 'evidence_note', 'recorded_by', 'consented_at', 'recorded_at', 'source', 'event_id'];
const PROVENANCE_COLS = ['lead_id', 'field', 'source_kind', 'source_ref', 'collected_at', 'backfilled', 'recorded_at'];
const EVENT_COLS = ['row_id', 'event_id', 'kind', 'channel', 'recipient_ref', 'normalized_address', 'source', 'state', 'reject_code', 'received_at', 'recorded_at'];
const REF_COLS = ['recipient_ref', 'channel', 'normalized_address', 'created_at'];

const LIST_MAX = 100;

function clampLimit(limit, fallback = 20) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, LIST_MAX);
}

function clampOffset(offset) {
  const n = Number(offset);
  if (!Number.isInteger(n) || n < 0) return 0;
  return Math.min(n, 100000);
}

const freeze = (r) => (r ? Object.freeze({ ...r }) : null);

class PgSuppressions {
  constructor(store) { this.s = store; }

  async add(rec) {
    const v = { ...rec };
    if (!v.workspace_id && v.scope === 'workspace') v.workspace_id = this.s.workspaceId;
    await this.s.insert('li_suppressions', SUPPRESSION_COLS, SUPPRESSION_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: '*', returning: false });
    return this.s.one('li_suppressions', `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE scope = ? AND COALESCE(workspace_id, '') = ? AND channel = ? AND normalized_address = ?`, [v.scope, v.workspace_id || '', v.channel, v.normalized_address]);
  }

  async find({ channel, address, workspaceId }) {
    const ws = workspaceId || this.s.workspaceId;
    return freeze(await this.s.one('li_suppressions', `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE channel = ? AND normalized_address = ? AND (scope = 'global' OR workspace_id = ?) ORDER BY created_at DESC, suppression_id DESC LIMIT 1`, [channel, address, ws]));
  }

  async listForAddress({ channel, address }) {
    return (await this.s.q('li_suppressions', `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE channel = ? AND normalized_address = ? AND (scope = 'global' OR workspace_id = ?) ORDER BY created_at ASC, suppression_id ASC`, [channel, address, this.s.workspaceId])).map(freeze);
  }

  async list({ limit, offset } = {}) {
    const total = await this.s.one('li_suppressions', 'SELECT COUNT(*) AS n FROM li_suppressions WHERE scope = ? OR workspace_id = ?', ['workspace', this.s.workspaceId]);
    const rows = await this.s.q('li_suppressions', `SELECT ${SUPPRESSION_COLS.join(', ')} FROM li_suppressions WHERE scope = ? OR workspace_id = ? ORDER BY created_at DESC, suppression_id DESC LIMIT ? OFFSET ?`, ['workspace', this.s.workspaceId, clampLimit(limit), clampOffset(offset)]);
    return { rows: rows.map(freeze), total: total ? Number(total.n) : 0, limit: clampLimit(limit), offset: clampOffset(offset) };
  }

  async removeManual(suppressionId) {
    const n = await this.s.run("DELETE FROM li_suppressions WHERE suppression_id = ? AND reason = 'manual' AND source = 'user'", [String(suppressionId)]);
    return n > 0;
  }
}

class PgConsents {
  constructor(store) { this.s = store; }

  async record(rec) {
    const v = { ...rec };
    const row = await this.s.insert('li_contact_consents', CONSENT_COLS, CONSENT_COLS.map((c) => (v[c] === undefined ? null : v[c])));
    return freeze(row);
  }

  async latestFor({ channel, address }) {
    return freeze(await this.s.one('li_contact_consents', `SELECT ${CONSENT_COLS.join(', ')} FROM li_contact_consents WHERE channel = ? AND normalized_address = ? AND workspace_id = ? ORDER BY consented_at DESC, recorded_at DESC, consent_id DESC LIMIT 1`, [channel, address, this.s.workspaceId]));
  }

  async listByLead(leadId, limit = 20) {
    const list = await this.s.q('li_contact_consents', `SELECT ${CONSENT_COLS.join(', ')} FROM li_contact_consents WHERE lead_id = ? AND workspace_id = ? ORDER BY recorded_at DESC, consent_id DESC LIMIT ?`, [String(leadId), this.s.workspaceId, clampLimit(limit)]);
    return list.map(freeze);
  }

  async deleteByLead(leadId) {
    await this.s.run('DELETE FROM li_contact_consents WHERE lead_id = ? AND workspace_id = ?', [String(leadId), this.s.workspaceId]);
  }
}

class PgProvenance {
  constructor(store) { this.s = store; }

  async put(rec, { ifAbsent = false } = {}) {
    const v = { ...rec };
    if (ifAbsent) {
      await this.s.insert('li_contact_provenance', PROVENANCE_COLS, PROVENANCE_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: 'lead_id,field', update: false, returning: false });
    } else {
      await this.s.insert('li_contact_provenance', PROVENANCE_COLS, PROVENANCE_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: 'lead_id,field', update: PROVENANCE_COLS.filter((c) => c !== 'lead_id' && c !== 'field') });
    }
    return this.s.one('li_contact_provenance', `SELECT ${PROVENANCE_COLS.join(', ')} FROM li_contact_provenance WHERE lead_id = ? AND field = ? AND workspace_id = ?`, [v.lead_id, v.field, this.s.workspaceId]);
  }

  async putMany(recs, { ifAbsent = false } = {}) {
    for (const rec of recs) await this.put(rec, { ifAbsent });
  }

  async leadIds() {
    const list = await this.s.q('li_contact_provenance', 'SELECT DISTINCT lead_id FROM li_contact_provenance WHERE workspace_id = ?', [this.s.workspaceId]);
    return new Set(list.map((r) => r.lead_id));
  }

  async listByLead(leadId) {
    const list = await this.s.q('li_contact_provenance', `SELECT ${PROVENANCE_COLS.join(', ')} FROM li_contact_provenance WHERE lead_id = ? AND workspace_id = ? ORDER BY field ASC`, [String(leadId), this.s.workspaceId]);
    return list.map(freeze);
  }

  async deleteByLead(leadId) {
    await this.s.run('DELETE FROM li_contact_provenance WHERE lead_id = ? AND workspace_id = ?', [String(leadId), this.s.workspaceId]);
  }
}

class PgTrustEvents {
  constructor(store) { this.s = store; }

  async append(rec) {
    const v = { ...rec };
    await this.s.insert('li_trust_events', EVENT_COLS, EVENT_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: '*', returning: false });
    return v.state === 'rejected'
      ? freeze(await this.s.one('li_trust_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE row_id = ? AND workspace_id = ?`, [v.row_id, this.s.workspaceId]))
      : freeze(await this.s.one('li_trust_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE event_id = ? AND state != 'rejected' AND workspace_id = ?`, [v.event_id, this.s.workspaceId]));
  }

  async get(eventId) {
    return freeze(await this.s.one('li_trust_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE event_id = ? AND state != 'rejected' AND workspace_id = ?`, [String(eventId), this.s.workspaceId]));
  }

  async latestFor({ channel, address, kinds, sources }) {
    const where = ['channel = ?', 'normalized_address = ?', "state != 'rejected'", 'workspace_id = ?'];
    const params = [channel, address, this.s.workspaceId];
    if (kinds && kinds.length) {
      where.push(`kind IN (${kinds.map(() => '?').join(',')})`);
      params.push(...kinds);
    }
    if (sources && sources.length) {
      where.push(`source IN (${sources.map(() => '?').join(',')})`);
      params.push(...sources);
    }
    return freeze(await this.s.one('li_trust_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE ${where.join(' AND ')} ORDER BY received_at DESC, row_id DESC LIMIT 1`, params));
  }

  async list({ limit, offset } = {}) {
    const total = await this.s.one('li_trust_events', 'SELECT COUNT(*) AS n FROM li_trust_events WHERE workspace_id = ?', [this.s.workspaceId]);
    const rows = await this.s.q('li_trust_events', `SELECT ${EVENT_COLS.join(', ')} FROM li_trust_events WHERE workspace_id = ? ORDER BY recorded_at DESC, row_id DESC LIMIT ? OFFSET ?`, [this.s.workspaceId, clampLimit(limit), clampOffset(offset)]);
    return { rows: rows.map(freeze), total: total ? Number(total.n) : 0, limit: clampLimit(limit), offset: clampOffset(offset) };
  }
}

class PgRecipientRefs {
  constructor(store) { this.s = store; }

  async ensure(rec) {
    const v = { ...rec };
    await this.s.insert('li_recipient_refs', REF_COLS, REF_COLS.map((c) => (v[c] === undefined ? null : v[c])), { onConflict: '*', returning: false });
    return freeze(await this.s.one('li_recipient_refs', `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE recipient_ref = ? AND workspace_id = ?`, [v.recipient_ref, this.s.workspaceId]));
  }

  async resolve(recipientRef) {
    return freeze(await this.s.one('li_recipient_refs', `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE recipient_ref = ? AND workspace_id = ?`, [String(recipientRef), this.s.workspaceId]));
  }

  async forAddress({ channel, address }) {
    return freeze(await this.s.one('li_recipient_refs', `SELECT ${REF_COLS.join(', ')} FROM li_recipient_refs WHERE channel = ? AND normalized_address = ? AND workspace_id = ? ORDER BY created_at DESC, recipient_ref DESC LIMIT 1`, [channel, address, this.s.workspaceId]));
  }
}

module.exports = { PgSuppressions, PgConsents, PgProvenance, PgTrustEvents, PgRecipientRefs };
