'use strict';

/**
 * PgCrm - the CRM tables (migration 023) for one workspace.
 *
 * Every method runs inside the store's scoped transaction, so the workspace
 * context is set and row-level security decides what is visible: a row of
 * another workspace is not found, not "forbidden". The workspace column is
 * added by the store, never taken from the caller.
 *
 * Writes use optimistic concurrency: an update names the version it read,
 * and loses (returns null) when someone saved in between.
 */

const ACCOUNT_COLUMNS = [
  'account_id', 'name', 'website', 'phone', 'address', 'stage', 'lost_reason', 'owner_user_id',
  'estimated_value_cents', 'currency', 'next_step', 'next_step_at', 'source', 'source_job_id',
  'source_business_id', 'source_url', 'research_score', 'created_by', 'created_at', 'updated_by',
  'updated_at', 'archived_at', 'version',
];
const UPDATABLE = new Set([
  'name', 'website', 'phone', 'address', 'stage', 'lost_reason', 'owner_user_id', 'estimated_value_cents',
  'currency', 'next_step', 'next_step_at', 'archived_at', 'updated_by', 'updated_at',
]);

function account(row) {
  if (!row) return null;
  return {
    ...row,
    // BIGINT arrives as a string from the driver.
    estimated_value_cents: row.estimated_value_cents === null || row.estimated_value_cents === undefined ? null : Number(row.estimated_value_cents),
  };
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => `\\${m}`);
}

class PgCrm {
  constructor(store) { this.store = store; }

  async createAccount(rec) {
    const row = await this.store.insert('li_crm_accounts', ACCOUNT_COLUMNS, ACCOUNT_COLUMNS.map((c) => rec[c] === undefined ? null : rec[c]));
    return account(row);
  }

  async getAccount(accountId) {
    return account(await this.store.one('li_crm_accounts', 'SELECT * FROM li_crm_accounts WHERE account_id = ?', [accountId]));
  }

  async findBySourceBusiness(businessId) {
    return account(await this.store.one('li_crm_accounts', 'SELECT * FROM li_crm_accounts WHERE source_business_id = ?', [businessId]));
  }

  /**
   * @param {{q?: string, stage?: string, ownerUserId?: string|null, unassigned?: boolean,
   *          includeArchived?: boolean, limit: number, offset: number}} query
   */
  async listAccounts(query) {
    const where = [];
    const params = [];
    if (!query.includeArchived) where.push('archived_at IS NULL');
    if (query.stage) { where.push('stage = ?'); params.push(query.stage); }
    if (query.unassigned) where.push('owner_user_id IS NULL');
    else if (query.ownerUserId) { where.push('owner_user_id = ?'); params.push(query.ownerUserId); }
    if (query.q) {
      where.push("(name ILIKE ? ESCAPE '\\' OR coalesce(website, '') ILIKE ? ESCAPE '\\')");
      const like = `%${escapeLike(query.q)}%`;
      params.push(like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await this.store.q('li_crm_accounts',
      `SELECT * FROM li_crm_accounts ${clause} ORDER BY updated_at DESC, account_id LIMIT ? OFFSET ?`,
      [...params, query.limit + 1, query.offset]);
    return { rows: rows.slice(0, query.limit).map(account), more: rows.length > query.limit };
  }

  /** Apply `patch` only if the row is still at `version`. The new row, or null on a conflict. */
  async updateAccount(accountId, version, patch) {
    const cols = Object.keys(patch).filter((c) => UPDATABLE.has(c));
    if (!cols.length) throw new Error('nothing to update');
    const encoded = this.store.encodeRow('li_crm_accounts', cols, cols.map((c) => patch[c]));
    const sets = cols.map((c) => `${c} = ?`).join(', ');
    const row = await this.store.one('li_crm_accounts',
      `UPDATE li_crm_accounts SET ${sets}, version = version + 1 WHERE account_id = ? AND version = ? RETURNING *`,
      [...encoded, accountId, version]);
    return account(row);
  }

  async addNote(rec) {
    return this.store.insert('li_crm_notes', ['note_id', 'account_id', 'body', 'author_user_id', 'created_at'],
      [rec.note_id, rec.account_id, rec.body, rec.author_user_id, rec.created_at]);
  }

  async listNotes(accountId, limit = 100) {
    return this.store.q('li_crm_notes',
      'SELECT * FROM li_crm_notes WHERE account_id = ? ORDER BY created_at DESC, note_id LIMIT ?', [accountId, limit]);
  }

  async addActivity(rec) {
    return this.store.insert('li_crm_activity', ['activity_id', 'account_id', 'kind', 'detail', 'actor_user_id', 'at'],
      [rec.activity_id, rec.account_id, rec.kind, rec.detail || {}, rec.actor_user_id, rec.at]);
  }

  async listActivity(accountId, limit = 100) {
    return this.store.q('li_crm_activity',
      'SELECT * FROM li_crm_activity WHERE account_id = ? ORDER BY at DESC, activity_id LIMIT ?', [accountId, limit]);
  }

  /** Accounts and estimated value per stage (archived accounts excluded). */
  async pipelineSummary() {
    const rows = await this.store.q('li_crm_accounts',
      `SELECT stage, count(*)::int AS accounts, coalesce(sum(estimated_value_cents), 0)::bigint AS value_cents
         FROM li_crm_accounts WHERE archived_at IS NULL GROUP BY stage`);
    return rows.map((r) => ({ stage: r.stage, accounts: Number(r.accounts), value_cents: Number(r.value_cents) }));
  }
}

module.exports = { PgCrm, ACCOUNT_COLUMNS };
