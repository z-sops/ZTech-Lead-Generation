'use strict';

const { ConflictError, NotFoundError, DuplicateActiveJobError, LiError } = require('../core/errors');
const { MIGRATIONS } = require('./migrations');
const { packetMeta, normalizePitchListQuery, ACTIVITY_TYPES, normalizeActivityQuery, normalizeSendRecord, normalizeSendQuery } = require('./contract');

/**
 * SqlJsStore — repository contract on top of ZTech's EXISTING sql.js Database.
 *
 * INTEGRATION POINT (QwenCoder):
 *   - `db` is the sql.js Database instance ZTech already opens (do not open a new file).
 *   - `persist` is ZTech's existing save function (e.g. saveDB()). It is called after
 *     every committed write, matching the round-1 decision "saveDB() inside insert/update".
 *   - If ZTech's saveDB() writes the file non-atomically, see src/persistence/atomicFile.js
 *     and report it; do not change saveDB() without approval.
 *
 * Corruption handling: JSON columns are parsed defensively. A corrupt row is skipped,
 * recorded in `store.corruptRows`, and reported through `logger.warn`. It never crashes
 * the app and is never silently rewritten.
 */

const ACTIVE_SQL = "('requested','preflight','started','polling','pending')";

function rows(db, sql, params = []) {
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

function row(db, sql, params = []) {
  return rows(db, sql, params)[0] || null;
}

class SqlJsStore {
  /**
   * @param {{db: object, persist?: () => (void|Promise<void>), logger?: object, now?: () => Date}} opts
   */
  constructor({ db, persist = () => {}, logger = console, now = () => new Date() }) {
    if (!db || typeof db.prepare !== 'function' || typeof db.run !== 'function') throw new TypeError('sql.js Database required');
    this.db = db;
    this.persist = persist;
    this.logger = logger;
    this.now = now;
    this.corruptRows = [];
    this.jobs = new SqlJobs(this);
    this.packets = new SqlPackets(this);
    this.changes = new SqlChanges(this);
    this.savedSearches = new SqlSavedSearches(this);
    this.segments = new SqlSegments(this);
    this.pitches = new SqlPitches(this);
    this.approvals = new SqlApprovals(this);
    this.activity = new SqlActivity(this);
    this.sends = new SqlSends(this);
    this.enrichmentJobs = new SqlEnrichmentJobs(this);
    this.enrichmentObservations = new SqlEnrichmentObservations(this);
    this.oiAssociations = new SqlOiAssociations(this);
    this.oiRefreshRequests = new SqlOiRefreshRequests(this);
  }

  /** Apply pending migrations in one transaction each. Idempotent. */
  async migrate() {
    this.db.run('CREATE TABLE IF NOT EXISTS li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(rows(this.db, 'SELECT version FROM li_schema_migrations').map((r) => r.version));
    let changed = false;
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      this.db.run('BEGIN');
      try {
        this.db.exec(m.sql);
        this.db.run('INSERT INTO li_schema_migrations (version, applied_at) VALUES (?, ?)', [m.version, this.now().toISOString()]);
        this.db.run('COMMIT');
        changed = true;
      } catch (e) {
        this.db.run('ROLLBACK');
        throw new LiError('MIGRATION_FAILED', `Lead-intelligence migration ${m.version} failed`, { version: m.version, cause: String(e && e.message) });
      }
    }
    if (changed) await this.persist();
    return { applied: MIGRATIONS.map((m) => m.version) };
  }

  parse(text, table, id) {
    try {
      return JSON.parse(text);
    } catch {
      this.corruptRows.push({ table, id });
      if (this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] corrupt JSON in ${table} row ${id}; row skipped`);
      return undefined;
    }
  }

  /** Run fn inside a transaction and persist once after commit. */
  async tx(fn) {
    this.db.run('BEGIN');
    let result;
    try {
      result = fn();
      this.db.run('COMMIT');
    } catch (e) {
      this.db.run('ROLLBACK');
      throw e;
    }
    await this.persist();
    return result;
  }

  async purgeLead(leadId) {
    const id = String(leadId);
    return this.tx(() => {
      this.db.run('DELETE FROM li_outreach_approvals WHERE pitch_id IN (SELECT pitch_id FROM li_pitch_drafts WHERE lead_id = ?)', [id]);
      this.db.run('DELETE FROM li_pitch_drafts WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_research_changes WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_evidence_packets WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_research_jobs WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_segment_members WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_enrichment_observations WHERE lead_id = ?', [id]);
      // The link to OI goes with the lead; the report itself lives in OI's store.
      this.db.run('DELETE FROM li_oi_associations WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_oi_refresh_requests WHERE lead_id = ?', [id]);
      this.db.run('DELETE FROM li_enrichment_jobs WHERE lead_id = ?', [id]);
    });
  }
}

/* ------------------------------ jobs ------------------------------ */

const JOB_COLS = [
  'job_id', 'lead_id', 'provider_id', 'request_key', 'requested_domain', 'domain_key', 'state', 'provider_job_id',
  'attempts', 'poll_count', 'next_attempt_at', 'last_error_code', 'last_error_message', 'packet_id', 'options_json',
  'created_at', 'updated_at', 'started_at', 'finished_at', 'version',
];

function jobToRow(j) {
  return [
    j.job_id, String(j.lead_id), j.provider_id, j.request_key, j.requested_domain ?? null, j.domain_key ?? null, j.state,
    j.provider_job_id ?? null, j.attempts || 0, j.poll_count || 0, j.next_attempt_at ?? null, j.last_error_code ?? null,
    j.last_error_message ?? null, j.packet_id ?? null, JSON.stringify(j.options || {}), j.created_at, j.updated_at,
    j.started_at ?? null, j.finished_at ?? null, j.version,
  ];
}

class SqlJobs {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const options = this.s.parse(r.options_json, 'li_research_jobs', r.job_id);
    const out = { ...r, options: options && typeof options === 'object' ? options : {} };
    delete out.options_json;
    return out;
  }

  _isUnique(e) { return /UNIQUE constraint failed: li_research_jobs\.request_key/.test(String(e && e.message)); }

  async insert(job) {
    try {
      await this.s.tx(() => this.s.db.run(`INSERT INTO li_research_jobs (${JOB_COLS.join(',')}) VALUES (${JOB_COLS.map(() => '?').join(',')})`, jobToRow(job)));
    } catch (e) {
      if (this._isUnique(e)) throw new DuplicateActiveJobError(job.request_key);
      if (/UNIQUE constraint failed: li_research_jobs\.job_id/.test(String(e && e.message))) throw new ConflictError('Job id already exists');
      throw e;
    }
    return { ...job };
  }

  async update(job, expectedVersion) {
    const sets = JOB_COLS.filter((c) => c !== 'job_id').map((c) => `${c} = ?`).join(', ');
    const values = jobToRow(job).slice(1);
    let modified = 0;
    try {
      await this.s.tx(() => {
        this.s.db.run(`UPDATE li_research_jobs SET ${sets} WHERE job_id = ? AND version = ?`, [...values, job.job_id, expectedVersion]);
        modified = this.s.db.getRowsModified();
        if (modified === 0) throw new ConflictError('Research job was changed by another operation', { jobId: job.job_id });
      });
    } catch (e) {
      if (this._isUnique(e)) throw new DuplicateActiveJobError(job.request_key);
      if (e instanceof ConflictError) {
        const exists = row(this.s.db, 'SELECT job_id FROM li_research_jobs WHERE job_id = ?', [job.job_id]);
        if (!exists) throw new NotFoundError('Research job', job.job_id);
      }
      throw e;
    }
    return { ...job };
  }

  async get(id) { return this._from(row(this.s.db, 'SELECT * FROM li_research_jobs WHERE job_id = ?', [id])); }

  async findActive(requestKey) {
    return this._from(row(this.s.db, `SELECT * FROM li_research_jobs WHERE request_key = ? AND state IN ${ACTIVE_SQL} LIMIT 1`, [requestKey]));
  }

  async listByLead(leadId) {
    return rows(this.s.db, 'SELECT * FROM li_research_jobs WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC', [String(leadId)]).map((r) => this._from(r));
  }

  async listDue(nowIso) {
    return rows(this.s.db, `SELECT * FROM li_research_jobs WHERE state IN ('requested','preflight','started')
      OR (state IN ('polling','pending') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) ORDER BY created_at ASC`, [nowIso]).map((r) => this._from(r));
  }

  async listByStates(states) {
    if (!states.length) return [];
    return rows(this.s.db, `SELECT * FROM li_research_jobs WHERE state IN (${states.map(() => '?').join(',')})`, states).map((r) => this._from(r));
  }

  async latestPerLead() {
    const out = new Map();
    for (const r of rows(this.s.db, 'SELECT * FROM li_research_jobs ORDER BY created_at DESC, rowid DESC')) {
      if (!out.has(r.lead_id)) out.set(r.lead_id, this._from(r));
    }
    return out;
  }
}

/* ----------------------------- packets ----------------------------- */

const META_SELECT = 'packet_id, lead_id, job_id, research_status, footprint_state, requested_domain, captured_at, expires_at, created_at';

class SqlPackets {
  constructor(s) { this.s = s; }

  _full(r) {
    if (!r) return null;
    const p = this.s.parse(r.packet_json, 'li_evidence_packets', r.packet_id);
    return p && typeof p === 'object' ? p : null;
  }

  async insert(packet) {
    const m = packetMeta(packet);
    try {
      await this.s.tx(() => this.s.db.run(
        `INSERT INTO li_evidence_packets (${META_SELECT}, packet_json) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [m.packet_id, m.lead_id, m.job_id, m.research_status, m.footprint_state, m.requested_domain, m.captured_at, m.expires_at, m.created_at, JSON.stringify(packet)],
      ));
    } catch (e) {
      if (/UNIQUE constraint failed/.test(String(e && e.message))) throw new ConflictError('Packet id already exists');
      throw e;
    }
    return m;
  }

  async get(id) { return this._full(row(this.s.db, 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE packet_id = ?', [id])); }

  async latestForLead(leadId) {
    // Walk newest-first so a corrupt newest row falls back to the next readable packet.
    for (const r of rows(this.s.db, 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE lead_id = ? ORDER BY captured_at DESC, created_at DESC, rowid DESC', [String(leadId)])) {
      const p = this._full(r);
      if (p) return p;
    }
    return null;
  }

  async previousForLead(leadId, packetId) {
    const list = rows(this.s.db, 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE lead_id = ? ORDER BY captured_at DESC, created_at DESC, rowid DESC', [String(leadId)]);
    const idx = list.findIndex((r) => r.packet_id === packetId);
    if (idx === -1) return null;
    for (const r of list.slice(idx + 1)) {
      const p = this._full(r);
      if (p) return p;
    }
    return null;
  }

  async listMetaByLead(leadId) {
    return rows(this.s.db, `SELECT ${META_SELECT} FROM li_evidence_packets WHERE lead_id = ? ORDER BY captured_at DESC, created_at DESC, rowid DESC`, [String(leadId)]);
  }

  async getMeta(id) { return row(this.s.db, `SELECT ${META_SELECT} FROM li_evidence_packets WHERE packet_id = ?`, [id]); }

  async latestMetaPerLead() {
    const out = new Map();
    for (const r of rows(this.s.db, `SELECT ${META_SELECT} FROM li_evidence_packets ORDER BY captured_at DESC, created_at DESC, rowid DESC`)) {
      if (!out.has(r.lead_id)) out.set(r.lead_id, r);
    }
    return out;
  }
}

/* ----------------------------- changes ----------------------------- */

class SqlChanges {
  constructor(s) { this.s = s; }

  async insertMany(changes) {
    if (!changes.length) return 0;
    await this.s.tx(() => {
      for (const c of changes) {
        this.s.db.run(
          'INSERT OR IGNORE INTO li_research_changes (change_id, lead_id, from_packet_id, to_packet_id, type, change_json, detected_at) VALUES (?,?,?,?,?,?,?)',
          [c.change_id, c.lead_id, c.provenance.previous_packet_id, c.provenance.current_packet_id, c.type, JSON.stringify(c), c.detectedAt],
        );
      }
    });
    return changes.length;
  }

  async listByLead(leadId) {
    return rows(this.s.db, 'SELECT change_id, change_json FROM li_research_changes WHERE lead_id = ? ORDER BY detected_at DESC, rowid DESC', [String(leadId)])
      .map((r) => this.s.parse(r.change_json, 'li_research_changes', r.change_id))
      .filter((c) => c && typeof c === 'object');
  }
}

/* -------------------------- saved searches -------------------------- */

class SqlSavedSearches {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const def = this.s.parse(r.definition_json, 'li_saved_searches', r.search_id);
    if (!def || typeof def !== 'object') return null;
    return { search_id: r.search_id, name: r.name, filter: def.filter, created_at: r.created_at, updated_at: r.updated_at };
  }

  async upsert(rec) {
    await this.s.tx(() => this.s.db.run(
      `INSERT INTO li_saved_searches (search_id, name, definition_json, created_at, updated_at) VALUES (?,?,?,?,?)
       ON CONFLICT(search_id) DO UPDATE SET name = excluded.name, definition_json = excluded.definition_json, updated_at = excluded.updated_at`,
      [rec.search_id, rec.name, JSON.stringify({ filter: rec.filter }), rec.created_at, rec.updated_at],
    ));
    return this.get(rec.search_id);
  }

  async get(id) { return this._from(row(this.s.db, 'SELECT * FROM li_saved_searches WHERE search_id = ?', [id])); }

  async list() { return rows(this.s.db, 'SELECT * FROM li_saved_searches ORDER BY name COLLATE NOCASE').map((r) => this._from(r)).filter(Boolean); }

  async delete(id) {
    let n = 0;
    await this.s.tx(() => { this.s.db.run('DELETE FROM li_saved_searches WHERE search_id = ?', [id]); n = this.s.db.getRowsModified(); });
    return n > 0;
  }
}

/* ----------------------------- segments ----------------------------- */

class SqlSegments {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const def = this.s.parse(r.definition_json, 'li_segments', r.segment_id);
    if (!def || typeof def !== 'object') return null;
    return { segment_id: r.segment_id, name: r.name, kind: r.kind, filter: def.filter ?? null, created_at: r.created_at, updated_at: r.updated_at };
  }

  async upsert(rec) {
    await this.s.tx(() => this.s.db.run(
      `INSERT INTO li_segments (segment_id, name, kind, definition_json, created_at, updated_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(segment_id) DO UPDATE SET name = excluded.name, kind = excluded.kind, definition_json = excluded.definition_json, updated_at = excluded.updated_at`,
      [rec.segment_id, rec.name, rec.kind, JSON.stringify({ filter: rec.filter ?? null }), rec.created_at, rec.updated_at],
    ));
    return this.get(rec.segment_id);
  }

  async get(id) { return this._from(row(this.s.db, 'SELECT * FROM li_segments WHERE segment_id = ?', [id])); }

  async list() { return rows(this.s.db, 'SELECT * FROM li_segments ORDER BY name COLLATE NOCASE').map((r) => this._from(r)).filter(Boolean); }

  async delete(id) {
    let n = 0;
    await this.s.tx(() => {
      this.s.db.run('DELETE FROM li_segment_members WHERE segment_id = ?', [id]);
      this.s.db.run('DELETE FROM li_segments WHERE segment_id = ?', [id]);
      n = this.s.db.getRowsModified();
    });
    return n > 0;
  }

  async addMembers(id, leadIds, atIso) {
    await this.s.tx(() => {
      for (const l of leadIds) this.s.db.run('INSERT OR IGNORE INTO li_segment_members (segment_id, lead_id, added_at) VALUES (?,?,?)', [id, String(l), atIso]);
    });
    return row(this.s.db, 'SELECT COUNT(*) AS n FROM li_segment_members WHERE segment_id = ?', [id]).n;
  }

  async removeMembers(id, leadIds) {
    await this.s.tx(() => {
      for (const l of leadIds) this.s.db.run('DELETE FROM li_segment_members WHERE segment_id = ? AND lead_id = ?', [id, String(l)]);
    });
    return row(this.s.db, 'SELECT COUNT(*) AS n FROM li_segment_members WHERE segment_id = ?', [id]).n;
  }

  async members(id) {
    return rows(this.s.db, 'SELECT lead_id FROM li_segment_members WHERE segment_id = ? ORDER BY added_at, lead_id', [id]).map((r) => r.lead_id);
  }
}

/* ------------------------ pitches / approvals ------------------------ */

class SqlPitches {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const d = this.s.parse(r.draft_json, 'li_pitch_drafts', r.pitch_id);
    return d && typeof d === 'object' ? d : null;
  }

  async upsert(rec) {
    await this.s.tx(() => this.s.db.run(
      `INSERT INTO li_pitch_drafts (pitch_id, lead_id, packet_id, status, content_hash, draft_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(pitch_id) DO UPDATE SET status = excluded.status, content_hash = excluded.content_hash, draft_json = excluded.draft_json, updated_at = excluded.updated_at`,
      [rec.pitch_id, rec.lead_id, rec.packet_id ?? null, rec.status, rec.content_hash, JSON.stringify(rec), rec.created_at, rec.updated_at],
    ));
    return { ...rec };
  }

  async get(id) { return this._from(row(this.s.db, 'SELECT pitch_id, draft_json FROM li_pitch_drafts WHERE pitch_id = ?', [id])); }

  async latestForLead(leadId) {
    return this._from(row(this.s.db, 'SELECT pitch_id, draft_json FROM li_pitch_drafts WHERE lead_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1', [String(leadId)]));
  }

  /**
   * F12 Batch 1: enumerate persisted pitch drafts. Read-only enumeration only - it
   * computes no gate, reads no packet, evaluates no ICP and never generates, edits,
   * approves or deletes a pitch.
   *
   * `status` filters the PERSISTED li_pitch_drafts.status column, so the filter runs in
   * SQL and `total` reflects the filtered set. `blocked`/`allowed` are not pitch
   * statuses: they are OutreachGate.decision, computed on read and never stored, so
   * they are rejected here rather than quietly returning an empty page.
   *
   * Ordering is updated_at DESC with pitch_id DESC as the tie-breaker, so rows sharing a
   * timestamp still come back in one fixed order across calls. Envelope shape matches
   * ZTech's existing paginated query convention (AccountStore.queryNumbers).
   *
   * @param {{limit?: number, offset?: number, status?: string|null}} [query]
   * @returns {Promise<{rows: object[], total: number, limit: number, offset: number, status: string|null}>}
   */
  async list(query) {
    const { status, limit, offset } = normalizePitchListQuery(query);
    const where = status ? ' WHERE status = ?' : '';
    const params = status ? [status] : [];
    const total = row(this.s.db, `SELECT COUNT(*) AS c FROM li_pitch_drafts${where}`, params);
    const page = rows(
      this.s.db,
      `SELECT pitch_id, draft_json FROM li_pitch_drafts${where} ORDER BY updated_at DESC, pitch_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return { rows: page.map((r) => this._from(r)).filter(Boolean), total: total ? total.c : 0, limit, offset, status };
  }
}

class SqlApprovals {
  constructor(s) { this.s = s; }

  async insert(rec) {
    await this.s.tx(() => this.s.db.run(
      'INSERT INTO li_outreach_approvals (approval_id, pitch_id, content_hash, approved_by, approved_at) VALUES (?,?,?,?,?)',
      [rec.approval_id, rec.pitch_id, rec.content_hash, rec.approved_by, rec.approved_at],
    ));
    return { ...rec };
  }

  async latestForPitch(pitchId) {
    return row(this.s.db, 'SELECT * FROM li_outreach_approvals WHERE pitch_id = ? ORDER BY approved_at DESC, rowid DESC LIMIT 1', [pitchId]);
  }
}

/* ---------------------------- outreach activity ---------------------------- */

/**
 * F15: the append-only outreach activity ledger.
 *
 * Writes come only from trusted backend transitions (OutreachService). `append` refuses
 * any type outside the contract's closed allowlist, so a new event type cannot appear
 * without that allowlist being changed deliberately.
 *
 * `list` is bounded by the contract's paging clamp, so no caller can pull an unbounded
 * history. Ordering is created_at DESC with activity_id DESC as the tie-breaker, so rows
 * written inside the same millisecond still come back in one fixed order across calls.
 */
class SqlActivity {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    let metadata = {};
    if (r.metadata_json) {
      try {
        const parsed = JSON.parse(r.metadata_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
      } catch {
        metadata = {};
      }
    }
    return {
      activity_id: r.activity_id,
      lead_id: r.lead_id,
      pitch_id: r.pitch_id === undefined ? null : r.pitch_id,
      activity_type: r.activity_type,
      metadata,
      created_at: r.created_at
    };
  }

  async append(rec) {
    if (!ACTIVITY_TYPES.includes(rec.activity_type)) {
      throw new LiError('VALIDATION_FAILED', 'Invalid activity: activity_type');
    }
    await this.s.tx(() => this.s.db.run(
      'INSERT INTO li_outreach_activity (activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at) VALUES (?,?,?,?,?,?)',
      [rec.activity_id, rec.lead_id, rec.pitch_id ?? null, rec.activity_type,
        JSON.stringify(rec.metadata || {}), rec.created_at],
    ));
    return { ...rec, metadata: { ...(rec.metadata || {}) } };
  }

  /** Read-only history. `leadId` and `pitchId` narrow it; neither is required. */
  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeActivityQuery(query);
    const where = [];
    const params = [];
    if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
    if (pitchId) { where.push('pitch_id = ?'); params.push(pitchId); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = row(this.s.db, `SELECT COUNT(*) AS c FROM li_outreach_activity${clause}`, params);
    const page = rows(
      this.s.db,
      `SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity${clause} ORDER BY created_at DESC, activity_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      rows: page.map((r) => this._from(r)).filter(Boolean),
      total: total ? total.c : 0,
      limit,
      offset,
      leadId,
      pitchId
    };
  }

  /** Newest-first rows for one pitch, for the duplicate guard on the ready transition. */
  async latestForPitch(pitchId, activityType) {
    const r = row(this.s.db,
      'SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity WHERE pitch_id = ? AND activity_type = ? ORDER BY created_at DESC, activity_id DESC LIMIT 1',
      [String(pitchId), activityType]);
    return this._from(r);
  }
}

/* ------------------------------ sends (F19) ------------------------------ */

/**
 * F19: the send ledger - one row per send ATTEMPT, and the place the idempotency
 * guarantee actually lives.
 *
 * `record` writes the 'attempted' row BEFORE the provider is called, so a crash mid-send
 * still leaves durable proof that the provider was reached. `accept` then moves that row to
 * 'accepted', and `fail` moves it to 'failed' with ZTech's own failure code.
 *
 * The uniqueness rule is enforced by the DATABASE (li_sends_one_accepted, a partial unique
 * index over state='accepted'), not by a read-then-write check here. A check-then-act race
 * would let two concurrent sends both observe "not yet accepted" and both put a message on
 * the wire; the unique index makes the second write fail instead. `accept` therefore
 * translates that constraint violation into a typed ALREADY_ACCEPTED signal so the caller
 * can report an honest idempotent replay rather than a crash.
 *
 * Like the activity ledger, send rows deliberately SURVIVE purgeLead: a historical fact
 * about a real send must not vanish when the lead it referred to is removed.
 */
class SqlSends {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    return {
      send_id: r.send_id,
      lead_id: r.lead_id,
      pitch_id: r.pitch_id,
      channel: r.channel,
      content_hash: r.content_hash,
      idempotency_key: r.idempotency_key,
      state: r.state,
      provider_id: r.provider_id === undefined ? null : r.provider_id,
      provider_message_id: r.provider_message_id === undefined ? null : r.provider_message_id,
      failure_code: r.failure_code === undefined ? null : r.failure_code,
      failure_message: r.failure_message === undefined ? null : r.failure_message,
      created_at: r.created_at,
      updated_at: r.updated_at
    };
  }

  /** The already-accepted send for this key, or null. This is the replay lookup. */
  async findAccepted(idempotencyKey) {
    return this._from(row(this.s.db,
      "SELECT * FROM li_outreach_sends WHERE idempotency_key = ? AND state = 'accepted' LIMIT 1",
      [String(idempotencyKey)]));
  }

  /**
   * Write the 'attempted' row. Called BEFORE provider contact so the attempt itself is
   * durable. Refuses a state other than 'attempted', so a caller cannot smuggle in an
   * 'accepted' row without the provider ever having been called.
   */
  async record(rec) {
    const n = normalizeSendRecord(rec);
    if (!n.ok) throw new LiError('VALIDATION_FAILED', n.error);
    if (n.value.state !== 'attempted') {
      throw new LiError('VALIDATION_FAILED', 'A send attempt must be recorded as attempted before it can change state');
    }
    await this.s.tx(() => this.s.db.run(
      'INSERT INTO li_outreach_sends (send_id, lead_id, pitch_id, channel, content_hash, idempotency_key, state, provider_id, provider_message_id, failure_code, failure_message, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [rec.send_id, rec.lead_id, rec.pitch_id, n.value.channel, rec.content_hash, rec.idempotency_key, 'attempted',
        n.value.provider_id, n.value.provider_message_id, null, null, rec.created_at, rec.updated_at]
    ));
    return this.get(rec.send_id);
  }

  /**
   * Move an attempt to 'accepted'. Returns { ok:true, row } on success, or
   * { ok:false, code:'ALREADY_ACCEPTED', row } when another attempt already won the key.
   */
  async accept({ sendId, providerId, providerMessageId, at }) {
    const existing = await this.findAcceptedBySend(sendId);
    if (existing) return { ok: true, row: existing };
    try {
      await this.s.tx(() => this.s.db.run(
        "UPDATE li_outreach_sends SET state = 'accepted', provider_id = ?, provider_message_id = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted'",
        [providerId === undefined ? null : providerId, providerMessageId === undefined ? null : providerMessageId, at, String(sendId)]
      ));
    } catch (err) {
      // The partial unique index refused a second accepted row for this key: a concurrent
      // send already won. That is an idempotent replay, not a failure.
      const winner = await this.findAcceptedForSendOfKey(sendId);
      if (winner) return { ok: false, code: 'ALREADY_ACCEPTED', row: winner };
      throw err;
    }
    return { ok: true, row: await this.get(sendId) };
  }

  /** Move an attempt to 'failed'. failure_code is ZTech's own code; no remote text. */
  async fail({ sendId, failureCode, failureMessage, at }) {
    await this.s.tx(() => this.s.db.run(
      "UPDATE li_outreach_sends SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted'",
      [failureCode === undefined ? null : failureCode, failureMessage === undefined ? null : failureMessage, at, String(sendId)]
    ));
    return this.get(sendId);
  }

  /** Move an attempt to 'blocked'. Used when the refusal happens before provider contact. */
  async block({ sendId, failureCode, failureMessage, at }) {
    await this.s.tx(() => this.s.db.run(
      "UPDATE li_outreach_sends SET state = 'blocked', failure_code = ?, failure_message = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted'",
      [failureCode === undefined ? null : failureCode, failureMessage === undefined ? null : failureMessage, at, String(sendId)]
    ));
    return this.get(sendId);
  }

  async findAcceptedBySend(sendId) {
    const r = row(this.s.db, "SELECT * FROM li_outreach_sends WHERE send_id = ? AND state = 'accepted' LIMIT 1", [String(sendId)]);
    return this._from(r);
  }

  async findAcceptedForSendOfKey(sendId) {
    const r = row(this.s.db,
      "SELECT accepted.* FROM li_outreach_sends AS accepted JOIN li_outreach_sends AS mine ON mine.idempotency_key = accepted.idempotency_key AND accepted.state = 'accepted' WHERE mine.send_id = ? LIMIT 1",
      [String(sendId)]);
    return this._from(r);
  }

  async get(sendId) {
    return this._from(row(this.s.db, 'SELECT * FROM li_outreach_sends WHERE send_id = ?', [String(sendId)]));
  }

  /** Newest-first, bounded. Mirrors the activity ledger's read contract. */
  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeSendQuery(query);
    const where = [];
    const params = [];
    if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
    if (pitchId) { where.push('pitch_id = ?'); params.push(pitchId); }
    const clause = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = row(this.s.db, `SELECT COUNT(*) AS c FROM li_outreach_sends${clause}`, params);
    const page = rows(this.s.db,
      `SELECT * FROM li_outreach_sends${clause} ORDER BY created_at DESC, send_id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]);
    return { rows: page.map((r) => this._from(r)), total: total ? total.c : 0, limit, offset };
  }
}

/* ---------------------------- enrichment ---------------------------- */

const E_ACTIVE_SQL = "('requested','running','pending')";
const EJOB_COLS = ['job_id', 'lead_id', 'state', 'fields_json', 'steps_json', 'next_attempt_at', 'last_error_code', 'created_at', 'updated_at', 'finished_at', 'version'];

function ejobRow(j) {
  return [j.job_id, String(j.lead_id), j.state, JSON.stringify(j.fields || []), JSON.stringify(j.steps || []), j.next_attempt_at ?? null, j.last_error_code ?? null, j.created_at, j.updated_at, j.finished_at ?? null, j.version];
}

class SqlEnrichmentJobs {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const fields = this.s.parse(r.fields_json, 'li_enrichment_jobs', r.job_id);
    const steps = this.s.parse(r.steps_json, 'li_enrichment_jobs', r.job_id);
    if (!Array.isArray(fields) || !Array.isArray(steps)) return null;
    const out = { ...r, fields, steps };
    delete out.fields_json;
    delete out.steps_json;
    return out;
  }

  _unique(e) { return /UNIQUE constraint failed: li_enrichment_jobs\.lead_id/.test(String(e && e.message)); }

  async insert(job) {
    try {
      await this.s.tx(() => this.s.db.run(`INSERT INTO li_enrichment_jobs (${EJOB_COLS.join(',')}) VALUES (${EJOB_COLS.map(() => '?').join(',')})`, ejobRow(job)));
    } catch (e) {
      if (this._unique(e)) throw new DuplicateActiveJobError(`enrich:${job.lead_id}`);
      if (/UNIQUE constraint failed: li_enrichment_jobs\.job_id/.test(String(e && e.message))) throw new ConflictError('Job id already exists');
      throw e;
    }
    return { ...job };
  }

  async update(job, expectedVersion) {
    const sets = EJOB_COLS.filter((c) => c !== 'job_id').map((c) => `${c} = ?`).join(', ');
    try {
      await this.s.tx(() => {
        this.s.db.run(`UPDATE li_enrichment_jobs SET ${sets} WHERE job_id = ? AND version = ?`, [...ejobRow(job).slice(1), job.job_id, expectedVersion]);
        if (this.s.db.getRowsModified() === 0) throw new ConflictError('Enrichment job was changed by another operation', { jobId: job.job_id });
      });
    } catch (e) {
      if (this._unique(e)) throw new DuplicateActiveJobError(`enrich:${job.lead_id}`);
      if (e instanceof ConflictError && !row(this.s.db, 'SELECT job_id FROM li_enrichment_jobs WHERE job_id = ?', [job.job_id])) {
        throw new NotFoundError('Enrichment job', job.job_id);
      }
      throw e;
    }
    return { ...job };
  }

  async get(id) { return this._from(row(this.s.db, 'SELECT * FROM li_enrichment_jobs WHERE job_id = ?', [id])); }

  async findActiveForLead(leadId) {
    return this._from(row(this.s.db, `SELECT * FROM li_enrichment_jobs WHERE lead_id = ? AND state IN ${E_ACTIVE_SQL} LIMIT 1`, [String(leadId)]));
  }

  async listByLead(leadId) {
    return rows(this.s.db, 'SELECT * FROM li_enrichment_jobs WHERE lead_id = ? ORDER BY created_at DESC, rowid DESC', [String(leadId)]).map((r) => this._from(r)).filter(Boolean);
  }

  async listDue(nowIso) {
    return rows(this.s.db, `SELECT * FROM li_enrichment_jobs WHERE state IN ('requested','running')
      OR (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)) ORDER BY created_at ASC`, [nowIso]).map((r) => this._from(r)).filter(Boolean);
  }

  async listByStates(states) {
    if (!states.length) return [];
    return rows(this.s.db, `SELECT * FROM li_enrichment_jobs WHERE state IN (${states.map(() => '?').join(',')})`, states).map((r) => this._from(r)).filter(Boolean);
  }
}

class SqlEnrichmentObservations {
  constructor(s) { this.s = s; }

  _from(r) {
    const value = r.value_json === null ? null : this.s.parse(r.value_json, 'li_enrichment_observations', r.observation_id);
    if (value === undefined) return null;
    const conf = r.provider_confidence_json === null ? null : this.s.parse(r.provider_confidence_json, 'li_enrichment_observations', r.observation_id);
    const out = { ...r, value, provider_confidence: conf === undefined ? null : conf };
    delete out.value_json;
    delete out.provider_confidence_json;
    return out;
  }

  async upsertMany(list) {
    if (!list.length) return 0;
    await this.s.tx(() => {
      for (const o of list) {
        this.s.db.run(
          `INSERT INTO li_enrichment_observations (observation_id, lead_id, job_id, field, status, value_json, provider_id, tier, source_ref, provider_confidence_json, collected_at, first_seen_at, provenance_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(observation_id) DO UPDATE SET collected_at = excluded.collected_at, job_id = excluded.job_id`,
          [o.observation_id, String(o.lead_id), o.job_id, o.field, o.status, o.value === null ? null : JSON.stringify(o.value), o.provider_id, o.tier, o.source_ref ?? null,
            o.provider_confidence ? JSON.stringify(o.provider_confidence) : null, o.collected_at, o.collected_at, o.provenance_id],
        );
      }
    });
    return list.length;
  }

  async listByLead(leadId) {
    return rows(this.s.db, 'SELECT * FROM li_enrichment_observations WHERE lead_id = ? ORDER BY observation_id', [String(leadId)]).map((r) => this._from(r)).filter(Boolean);
  }

  async listAllGrouped() {
    const out = new Map();
    for (const r of rows(this.s.db, 'SELECT * FROM li_enrichment_observations ORDER BY lead_id, observation_id')) {
      const o = this._from(r);
      if (!o) continue;
      if (!out.has(o.lead_id)) out.set(o.lead_id, []);
      out.get(o.lead_id).push(o);
    }
    return out;
  }
}


/* ------------------------ opportunity intelligence ------------------------ */

/**
 * I3: lead <-> Opportunity Intelligence research associations (migration 006).
 * Exactly seven columns, IDs and metadata only. `listAll` is read once at start-up by
 * OpportunityAssociationStore; `put` is idempotent on research_id and prunes a lead to
 * its newest `keep` rows.
 */
const OI_ASSOC_COLS = ['research_id', 'lead_id', 'snapshot_id', 'entity_key', 'status', 'generated_at', 'recorded_at'];

class SqlOiAssociations {
  constructor(store) { this.s = store; }

  async listAll() {
    return rows(this.s.db, `SELECT ${OI_ASSOC_COLS.join(', ')} FROM li_oi_associations ORDER BY lead_id, recorded_at DESC, research_id DESC`);
  }

  async put(rec, { keep = 50 } = {}) {
    const values = OI_ASSOC_COLS.map((c) => (rec[c] === undefined || rec[c] === null ? null : String(rec[c])));
    return this.s.tx(() => {
      this.s.db.run(
        `INSERT OR IGNORE INTO li_oi_associations (${OI_ASSOC_COLS.join(', ')}) VALUES (${OI_ASSOC_COLS.map(() => '?').join(', ')})`,
        values
      );
      this.s.db.run(
        'DELETE FROM li_oi_associations WHERE lead_id = ? AND research_id NOT IN '
        + '(SELECT research_id FROM li_oi_associations WHERE lead_id = ? ORDER BY recorded_at DESC, research_id DESC LIMIT ?)',
        [String(rec.lead_id), String(rec.lead_id), keep]
      );
      return row(this.s.db, `SELECT ${OI_ASSOC_COLS.join(', ')} FROM li_oi_associations WHERE research_id = ?`, [String(rec.research_id)]);
    });
  }
}

/* ------------------------- OI refresh requests (I5, 007) ------------------------- */

const OI_REFRESH_COLS = ['request_id', 'lead_id', 'state', 'research_id', 'error_code', 'created_at', 'updated_at'];

class SqlOiRefreshRequests {
  constructor(store) { this.s = store; }

  async pendingForLead(leadId) {
    return row(this.s.db, `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE lead_id = ? AND state = 'pending'`, [String(leadId)]);
  }

  async listAllPending() {
    return rows(this.s.db, `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE state = 'pending' ORDER BY lead_id`);
  }

  async listByLead(leadId, limit = 20) {
    return rows(this.s.db, `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE lead_id = ? ORDER BY created_at DESC, request_id DESC LIMIT ?`, [String(leadId), limit]);
  }

  /** Insert a NEW pending intent. Throws when the lead already has one (partial unique index). */
  async open(rec) {
    return this.s.tx(() => {
      this.s.db.run(
        `INSERT INTO li_oi_refresh_requests (${OI_REFRESH_COLS.join(', ')}) VALUES (?, ?, 'pending', NULL, NULL, ?, ?)`,
        [String(rec.request_id), String(rec.lead_id), String(rec.created_at), String(rec.created_at)]
      );
      return row(this.s.db, `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE request_id = ?`, [String(rec.request_id)]);
    });
  }

  /** Close a pending intent as succeeded / failed. Only a pending row moves; history is pruned to `keep` per lead. */
  async close(requestId, { state, research_id = null, error_code = null, updated_at }, { keep = 20 } = {}) {
    if (state !== 'succeeded' && state !== 'failed') throw new Error('close() takes succeeded or failed');
    return this.s.tx(() => {
      this.s.db.run(
        "UPDATE li_oi_refresh_requests SET state = ?, research_id = ?, error_code = ?, updated_at = ? WHERE request_id = ? AND state = 'pending'",
        [state, research_id == null ? null : String(research_id), error_code == null ? null : String(error_code), String(updated_at), String(requestId)]
      );
      const r = row(this.s.db, `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE request_id = ?`, [String(requestId)]);
      if (r) {
        this.s.db.run(
          "DELETE FROM li_oi_refresh_requests WHERE lead_id = ? AND state != 'pending' AND request_id NOT IN "
          + "(SELECT request_id FROM li_oi_refresh_requests WHERE lead_id = ? AND state != 'pending' ORDER BY created_at DESC, request_id DESC LIMIT ?)",
          [r.lead_id, r.lead_id, keep]
        );
      }
      return r;
    });
  }
}

module.exports = { SqlJsStore };
