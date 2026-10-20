'use strict';

/**
 * PostgresStore - the PostgreSQL 16 implementation of the repository seam.
 *
 * It is the counterpart of the desktop's SqlJsStore and must produce the SAME
 * results for the same calls. The differences between the two engines are
 * absorbed here and in dialect.js, so the repository code below reads the
 * same as the desktop's:
 *
 *   * `?` placeholders are rewritten to `$1, $2, ...`;
 *   * timestamps are TIMESTAMPTZ and come back as the same canonical ISO
 *     string the desktop keeps;
 *   * the JSON documents are JSONB and come back as the same objects;
 *   * a unique violation is translated into the same typed errors
 *     (DUPLICATE_ACTIVE_JOB, CONFLICT, NOT_FOUND), so the caller cannot tell
 *     which backend it is talking to.
 *
 * TENANCY. The store is bound to ONE workspace. Every row it writes carries
 * that workspace, and every read is scoped to it. The structures are ready
 * for the row-level security of M2, but M1 proves NO isolation: the filter
 * here is application-level, and it is not a security boundary. The RLS
 * policies, the role ladder and the cross-tenant denial suite belong to M2.
 */

const { ConflictError, NotFoundError, DuplicateActiveJobError, LiError } = require('@zunitech/lead-intelligence/core/errors');
const { packetMeta, normalizePitchListQuery, ACTIVITY_TYPES, normalizeActivityQuery, normalizeSendRecord, normalizeSendQuery } = require('@zunitech/lead-intelligence/persistence/contract');
const { MAILBOX_ID_RE } = require('@zunitech/lead-intelligence/mailbox/mailboxContract');
const { AsyncLocalStorage } = require('node:async_hooks');
const { rewritePlaceholders, encodeValue, decodeValue, isUniqueViolation, violatedConstraint, PLATFORM_WORKSPACE_ID } = require('./dialect');

const ACTIVE_SQL = "('requested','preflight','started','polling','pending')";
const E_ACTIVE_SQL = "('requested','running','pending')";

/** A workspace identifier is a UUID, as the F2 architecture requires. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const JOB_COLS = [
  'job_id', 'lead_id', 'provider_id', 'request_key', 'requested_domain', 'domain_key', 'state', 'provider_job_id',
  'attempts', 'poll_count', 'next_attempt_at', 'last_error_code', 'last_error_message', 'packet_id', 'options_json',
  'created_at', 'updated_at', 'started_at', 'finished_at', 'version',
];
const EJOB_COLS = ['job_id', 'lead_id', 'state', 'fields_json', 'steps_json', 'next_attempt_at', 'last_error_code', 'created_at', 'updated_at', 'finished_at', 'version'];
const META_SELECT = 'packet_id, lead_id, job_id, research_status, footprint_state, requested_domain, captured_at, expires_at, created_at';
const OI_ASSOC_COLS = ['research_id', 'lead_id', 'snapshot_id', 'entity_key', 'status', 'generated_at', 'recorded_at'];
const OI_REFRESH_COLS = ['request_id', 'lead_id', 'state', 'research_id', 'error_code', 'created_at', 'updated_at'];

/** The columns the store adds for its own bookkeeping; they are never returned. */
const INTERNAL_COLUMNS = ['workspace_id', 'seq'];

/**
 * The tables that are NOT tenant-owned: the migration ledger, and the
 * per-country market rules (a market rule is the same in every workspace, so
 * it is reference data the platform owns). They carry no workspace, so the
 * store neither writes nor filters one.
 *
 * li_sequence_control is NOT global: one customer's pause-all must not pause
 * another customer's sequences, so it is scoped like every other tenant table.
 */
const GLOBAL_TABLES = new Set(['li_schema_migrations', 'li_market_rules']);

/**
 * The reserved workspace of the PLATFORM. A global suppression belongs to it,
 * so a global row is never NULL-scoped and every key stays tenant-safe.
 */

class PostgresStore {
  /**
   * @param {{pool: object, workspaceId?: string, role?: 'tenant'|'platform', logger?: object, now?: () => Date}} opts
   */
  constructor({ pool, workspaceId, role = 'tenant', logger = console, now = () => new Date() }) {
    if (!pool || typeof pool.query !== 'function') throw new TypeError('a pg Pool is required');
    const ws = String(workspaceId || '');
    const isPlatform = ws === PLATFORM_WORKSPACE_ID;
    if (!isPlatform && !UUID_RE.test(ws)) {
      throw new TypeError('the workspace id must be a UUID (the F2 architecture scopes every tenant table by a uuid)');
    }
    if (role !== 'tenant' && role !== 'platform') throw new TypeError('the role must be tenant or platform');
    if (isPlatform && role !== 'platform') {
      throw new TypeError('the platform workspace may only be used by the platform role');
    }
    this.pool = pool;
    this.workspaceId = ws;
    this.role = role;
    this.logger = logger;
    this.now = now;
    this.corruptRows = [];
    /**
     * The transaction context. AsyncLocalStorage, NOT a field on the store:
     * a field would be shared by every operation running on this instance, so
     * two concurrent transactions could pick up each other's client.
     */
    this.txContext = new AsyncLocalStorage();

    this.jobs = new PgJobs(this);
    this.packets = new PgPackets(this);
    this.changes = new PgChanges(this);
    this.savedSearches = new PgSavedSearches(this);
    this.segments = new PgSegments(this);
    this.pitches = new PgPitches(this);
    this.approvals = new PgApprovals(this);
    this.activity = new PgActivity(this);
    this.sends = new PgSends(this);
    this.enrichmentJobs = new PgEnrichmentJobs(this);
    this.enrichmentObservations = new PgEnrichmentObservations(this);
    this.oiAssociations = new PgOiAssociations(this);
    this.oiRefreshRequests = new PgOiRefreshRequests(this);

    const trust = require('./postgresTrustRepos');
    this.suppressions = new trust.PgSuppressions(this);
    this.consents = new trust.PgConsents(this);
    this.provenance = new trust.PgProvenance(this);
    this.trustEvents = new trust.PgTrustEvents(this);
    this.recipientRefs = new trust.PgRecipientRefs(this);

    const mailbox = require('./postgresMailboxRepos');
    this.mailboxes = new mailbox.PgMailboxes(this);
    this.mailboxSent = new mailbox.PgMailboxSent(this);
    this.marketRules = new mailbox.PgMarketRules(this);
    this.replyReviews = new mailbox.PgReplyReviews(this);

    const sequences = require('./postgresSequenceRepos');
    this.sequences = new sequences.PgSequences(this);

    const routes = require('./postgresReplyRouteRepos');
    this.replyRoutes = new routes.PgReplyRoutes(this);
  }

  /* ----------------------------- migrations ----------------------------- */

  /**
   * Apply the pending migrations, one transaction each. Idempotent: a
   * migration that has already been applied is never applied again, and every
   * migration file is itself written so that applying it twice changes
   * nothing.
   */
  async migrate() {
    const { MIGRATIONS } = require('./index');
    await this.run('CREATE TABLE IF NOT EXISTS li_schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL)');
    const applied = new Set((await this.q('li_schema_migrations', 'SELECT version FROM li_schema_migrations')).map((r) => Number(r.version)));
    let changed = false;
    for (const m of MIGRATIONS) {
      if (applied.has(m.version)) continue;
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO li_schema_migrations (version, applied_at) VALUES ($1, $2)', [m.version, this.now().toISOString()]);
        await client.query('COMMIT');
        changed = true;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw new LiError('MIGRATION_FAILED', `Lead-intelligence migration ${m.version} failed`, { version: m.version, cause: String(err && err.message) });
      } finally {
        client.release();
      }
    }
    return { applied: MIGRATIONS.map((m) => m.version), changed };
  }

  /**
   * Remove a lead's data. The same rows go as on the desktop: the lead's
   * packets, jobs, pitches, approvals, changes, segments, enrichment, OI
   * links, sequences and routes go with it, while the address-keyed history
   * (suppressions, trust events, recipient refs) is kept.
   */
  async purgeLead(leadId) {
    const id = String(leadId);
    const ws = this.workspaceId;
    return this.tx(async () => {
      await this.run('DELETE FROM li_outreach_approvals WHERE pitch_id IN (SELECT pitch_id FROM li_pitch_drafts WHERE lead_id = ? AND workspace_id = ?)', [id, ws]);
      await this.sequences.deleteByLead(id);
      await this.replyRoutes.deleteByLead(id);
      await this.run('DELETE FROM li_pitch_drafts WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_research_changes WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_evidence_packets WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_research_jobs WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_segment_members WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_enrichment_observations WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_oi_associations WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_oi_refresh_requests WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.run('DELETE FROM li_enrichment_jobs WHERE lead_id = ? AND workspace_id = ?', [id, ws]);
      await this.provenance.deleteByLead(id);
      await this.consents.deleteByLead(id);
    });
  }

  /* ----------------------------- the SQL layer ----------------------------- */

  /**
   * The connection a statement runs on.
   *
   * It is the CLIENT OF THE TRANSACTION THIS OPERATION IS INSIDE, and only
   * that one. The context comes from AsyncLocalStorage, so it follows the
   * asynchronous call chain of the operation that opened the transaction: a
   * concurrent operation on the same store instance - or on another instance
   * of the same pool - can never pick up a foreign transaction's client.
   */
  get client() {
    const context = this.txContext.getStore();
    return context ? context.client : this.pool;
  }

  /** Is this operation inside a transaction? */
  get inTransaction() {
    return Boolean(this.txContext.getStore());
  }

  /**
   * Run a query and convert the rows.
   * @param {string} table the table the query reads, for the type conversion
   */
  async q(table, sql, params = []) {
    const res = await this.client.query(rewritePlaceholders(sql), params);
    return res.rows.map((r) => this.fromRow(table, r));
  }

  /** One row, or null. */
  async one(table, sql, params = []) {
    const rows = await this.q(table, sql, params);
    return rows[0] || null;
  }

  /** A statement that returns no rows. The number of affected rows. */
  async run(sql, params = []) {
    const res = await this.client.query(rewritePlaceholders(sql), params);
    return res.rowCount;
  }

  /**
   * Insert one row. The workspace is added, and the values are converted to
   * the PostgreSQL types.
   * @param {string} table
   * @param {string[]} columns
   * @param {Array} values
   * @param {{onConflict?: string, update?: string[], returning?: string[]}} [opts]
   */
  async insert(table, columns, values, opts = {}) {
    const owns = !GLOBAL_TABLES.has(table);
    const cols = owns && !columns.includes('workspace_id') ? ['workspace_id', ...columns] : [...columns];
    const encoded = values.map((v, i) => encodeValue(table, columns[i], v));
    for (let i = 0; i < encoded.length; i += 1) {
      if (encoded[i].corrupt) this.reportCorrupt(table, columns[i], 'malformed value');
    }
    const params = owns && !columns.includes('workspace_id') ? [this.workspaceId, ...encoded.map((e) => e.value)] : encoded.map((e) => e.value);
    let sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    if (opts.onConflict === '*') {
      // The desktop's INSERT OR IGNORE: any unique conflict is ignored.
      sql += ' ON CONFLICT DO NOTHING';
    } else if (opts.onConflict) {
      sql += ` ON CONFLICT(${opts.onConflict}) DO ${opts.update ? `UPDATE SET ${opts.update.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'NOTHING'}`;
    }
    if (opts.returning !== false) sql += ' RETURNING *';
    const res = await this.client.query(rewritePlaceholders(sql), params);
    return res.rows.length ? this.fromRow(table, res.rows[0]) : null;
  }

  /**
   * Convert a row of values for the way in, without running the statement.
   * The UPDATE paths need this: their values are built the same way as an
   * INSERT's, so they are converted the same way too.
   *
   * @param {string} table
   * @param {string[]} columns
   * @param {Array} values
   * @returns {Array} the encoded values
   */
  encodeRow(table, columns, values) {
    const out = [];
    for (let i = 0; i < values.length; i += 1) {
      const encoded = encodeValue(table, columns[i], values[i]);
      if (encoded.corrupt) this.reportCorrupt(table, columns[i], 'malformed value');
      out.push(encoded.value);
    }
    return out;
  }

  /**
   * Convert a row: the types that differ between the engines are converted,
   * and the store's own bookkeeping columns are removed, so a row read from
   * PostgreSQL is shaped exactly like a row read from the desktop's database.
   */
  fromRow(table, row) {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      if (INTERNAL_COLUMNS.includes(key)) continue;
      const decoded = decodeValue(table, key, value);
      if (decoded.corrupt) {
        this.reportCorrupt(table, key, 'malformed value');
        out[key] = null;
        continue;
      }
      out[key] = decoded.value;
    }
    return out;
  }

  /**
   * A JSON document that could not be read. It is reported and treated as
   * absent - never trusted, never fatal.
   */
  parse(value, table, id) {
    if (value === undefined || value === null) {
      this.reportCorrupt(table, id, 'missing JSON document');
      return undefined;
    }
    let parsed = value;
    if (typeof value === 'string') {
      try {
        parsed = JSON.parse(value);
      } catch {
        this.reportCorrupt(table, id, 'malformed JSON');
        return undefined;
      }
    }
    if (!parsed || typeof parsed !== 'object') {
      this.reportCorrupt(table, id, 'the JSON document is not an object');
      return undefined;
    }
    return parsed;
  }

  reportCorrupt(table, id, why) {
    this.corruptRows.push({ table, id });
    if (this.logger && this.logger.warn) {
      this.logger.warn(`[lead-intelligence] corrupt ${why} in ${table} row ${id}; row skipped`);
    }
  }

  /**
   * Run fn inside a transaction. fn may be async; the transaction is only
   * committed once it has finished.
   */
  /**
   * Run fn inside a transaction.
   *
   * The transaction's client is held in the AsyncLocalStorage context, so it
   * belongs to THIS operation and to nothing else: two transactions running
   * at the same time, on this store or on another one, never share a client.
   *
   * A NESTED transaction joins the outer one through a SAVEPOINT: PostgreSQL
   * has no nested transactions, and a nested one that opened its own
   * connection would deadlock against the outer transaction's locks. A
   * failure inside the nested transaction rolls back to its savepoint only;
   * the outer transaction decides what happens next.
   */
  async tx(fn) {
    const outer = this.txContext.getStore();
    if (outer) return this.nestedTx(fn, outer);

    const client = await this.pool.connect();
    const context = { client, savepoint: 0 };
    try {
      await client.query('BEGIN');
      const result = await this.txContext.run(context, () => fn(this));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* the connection is already broken */ }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * A transaction inside a transaction: a SAVEPOINT on the outer client.
   */
  async nestedTx(fn, context) {
    context.savepoint += 1;
    const name = `ztech_sp_${context.savepoint}`;
    await context.client.query(`SAVEPOINT ${name}`);
    try {
      const result = await fn(this);
      await context.client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      try { await context.client.query(`ROLLBACK TO SAVEPOINT ${name}`); } catch { /* the transaction is already broken */ }
      throw err;
    }
  }

  /**
   * The typed errors, so a caller cannot tell the two backends apart.
   * @param {Error} err
   * @param {{unique?: string[], conflict?: string[]}} rules
   */
  translate(err, rules = {}) {
    if (isUniqueViolation(err)) {
      const constraint = violatedConstraint(err);
      if (rules.unique && rules.unique.some((c) => constraint.includes(c))) return rules.uniqueError;
      if (rules.conflict && rules.conflict.some((c) => constraint.includes(c))) return rules.conflictError;
    }
    return null;
  }
}

/* ------------------------------ jobs ------------------------------ */

function jobToRow(j) {
  return [
    j.job_id, String(j.lead_id), j.provider_id, j.request_key, j.requested_domain ?? null, j.domain_key ?? null, j.state,
    j.provider_job_id ?? null, j.attempts || 0, j.poll_count || 0, j.next_attempt_at ?? null, j.last_error_code ?? null,
    j.last_error_message ?? null, j.packet_id ?? null, j.options || {}, j.created_at, j.updated_at,
    j.started_at ?? null, j.finished_at ?? null, j.version,
  ];
}

class PgJobs {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    // The JSON document is already a document here: the column is JSONB.
    const options = r.options_json && typeof r.options_json === 'object' ? r.options_json : {};
    const out = { ...r, options };
    delete out.options_json;
    return out;
  }

  async insert(job) {
    try {
      await this.s.insert('li_research_jobs', JOB_COLS, jobToRow(job));
    } catch (e) {
      const translated = this.s.translate(e, {
        unique: ['li_jobs_one_active'],
        conflict: ['li_research_jobs_pkey'],
        uniqueError: new DuplicateActiveJobError(job.request_key),
        conflictError: new ConflictError('Job id already exists'),
      });
      if (translated) throw translated;
      throw e;
    }
    return { ...job };
  }

  async update(job, expectedVersion) {
    const sets = JOB_COLS.filter((c) => c !== 'job_id').map((c) => `${c} = ?`).join(', ');
    const values = jobToRow(job).slice(1);
    let modified = 0;
    try {
      await this.s.tx(async () => {
        modified = await this.s.run(
          `UPDATE li_research_jobs SET ${sets} WHERE job_id = ? AND version = ? AND workspace_id = ?`,
          [...this.s.encodeRow('li_research_jobs', JOB_COLS.slice(1), values), job.job_id, expectedVersion, this.s.workspaceId],
        );
        if (modified === 0) throw new ConflictError('Research job was changed by another operation', { jobId: job.job_id });
      });
    } catch (e) {
      const translated = this.s.translate(e, {
        unique: ['li_jobs_one_active'],
        uniqueError: new DuplicateActiveJobError(job.request_key),
      });
      if (translated) throw translated;
      if (e instanceof ConflictError) {
        const exists = await this.s.one('li_research_jobs', 'SELECT job_id FROM li_research_jobs WHERE job_id = ? AND workspace_id = ?', [job.job_id, this.s.workspaceId]);
        if (!exists) throw new NotFoundError('Research job', job.job_id);
      }
      throw e;
    }
    return { ...job };
  }

  async get(id) {
    return this._from(await this.s.one('li_research_jobs', 'SELECT * FROM li_research_jobs WHERE job_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async findActive(requestKey) {
    return this._from(await this.s.one('li_research_jobs', `SELECT * FROM li_research_jobs WHERE request_key = ? AND state IN ${ACTIVE_SQL} AND workspace_id = ? LIMIT 1`, [requestKey, this.s.workspaceId]));
  }

  async listByLead(leadId) {
    return (await this.s.q('li_research_jobs', 'SELECT * FROM li_research_jobs WHERE lead_id = ? AND workspace_id = ? ORDER BY created_at DESC, seq DESC', [String(leadId), this.s.workspaceId])).map((r) => this._from(r));
  }

  async listDue(nowIso) {
    return (await this.s.q('li_research_jobs', `SELECT * FROM li_research_jobs WHERE (state IN ('requested','preflight','started')
      OR (state IN ('polling','pending') AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) AND workspace_id = ? ORDER BY created_at ASC`, [nowIso, this.s.workspaceId])).map((r) => this._from(r));
  }

  async listByStates(states) {
    if (!states.length) return [];
    return (await this.s.q('li_research_jobs', `SELECT * FROM li_research_jobs WHERE state IN (${states.map(() => '?').join(',')}) AND workspace_id = ?`, [...states, this.s.workspaceId])).map((r) => this._from(r));
  }

  async latestPerLead() {
    const out = new Map();
    const list = await this.s.q('li_research_jobs', 'SELECT * FROM li_research_jobs WHERE workspace_id = ? ORDER BY created_at DESC, seq DESC', [this.s.workspaceId]);
    for (const r of list) {
      if (!out.has(r.lead_id)) out.set(r.lead_id, this._from(r));
    }
    return out;
  }
}

/* ----------------------------- packets ----------------------------- */

class PgPackets {
  constructor(s) { this.s = s; }

  _full(r) {
    if (!r) return null;
    const p = this.s.parse(r.packet_json, 'li_evidence_packets', r.packet_id);
    return p && typeof p === 'object' ? p : null;
  }

  async insert(packet) {
    const m = packetMeta(packet);
    try {
      await this.s.insert('li_evidence_packets', [...META_SELECT.split(', '), 'packet_json'], [
        m.packet_id, m.lead_id, m.job_id, m.research_status, m.footprint_state, m.requested_domain, m.captured_at, m.expires_at, m.created_at, packet,
      ]);
    } catch (e) {
      const translated = this.s.translate(e, { conflict: ['li_evidence_packets_pkey'], conflictError: new ConflictError('Packet id already exists') });
      if (translated) throw translated;
      throw e;
    }
    return m;
  }

  async get(id) {
    return this._full(await this.s.one('li_evidence_packets', 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE packet_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async latestForLead(leadId) {
    const list = await this.s.q('li_evidence_packets', 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE lead_id = ? AND workspace_id = ? ORDER BY captured_at DESC, created_at DESC, seq DESC', [String(leadId), this.s.workspaceId]);
    for (const r of list) {
      const p = this._full(r);
      if (p) return p;
    }
    return null;
  }

  async previousForLead(leadId, packetId) {
    const list = await this.s.q('li_evidence_packets', 'SELECT packet_id, packet_json FROM li_evidence_packets WHERE lead_id = ? AND workspace_id = ? ORDER BY captured_at DESC, created_at DESC, seq DESC', [String(leadId), this.s.workspaceId]);
    const idx = list.findIndex((r) => r.packet_id === packetId);
    if (idx === -1) return null;
    for (const r of list.slice(idx + 1)) {
      const p = this._full(r);
      if (p) return p;
    }
    return null;
  }

  async listMetaByLead(leadId) {
    return this.s.q('li_evidence_packets', `SELECT ${META_SELECT} FROM li_evidence_packets WHERE lead_id = ? AND workspace_id = ? ORDER BY captured_at DESC, created_at DESC, seq DESC`, [String(leadId), this.s.workspaceId]);
  }

  async getMeta(id) {
    return this.s.one('li_evidence_packets', `SELECT ${META_SELECT} FROM li_evidence_packets WHERE packet_id = ? AND workspace_id = ?`, [id, this.s.workspaceId]);
  }

  async latestMetaPerLead() {
    const out = new Map();
    const list = await this.s.q('li_evidence_packets', `SELECT ${META_SELECT} FROM li_evidence_packets WHERE workspace_id = ? ORDER BY captured_at DESC, created_at DESC, seq DESC`, [this.s.workspaceId]);
    for (const r of list) {
      if (!out.has(r.lead_id)) out.set(r.lead_id, r);
    }
    return out;
  }
}

/* ----------------------------- changes ----------------------------- */

class PgChanges {
  constructor(s) { this.s = s; }

  async insertMany(changes) {
    if (!changes.length) return 0;
    await this.s.tx(async () => {
      for (const c of changes) {
        await this.s.insert('li_research_changes', ['change_id', 'lead_id', 'from_packet_id', 'to_packet_id', 'type', 'change_json', 'detected_at'], [
          c.change_id, c.lead_id, c.provenance.previous_packet_id, c.provenance.current_packet_id, c.type, c, c.detectedAt,
        ], { onConflict: '*', returning: false });
      }
    });
    return changes.length;
  }

  async listByLead(leadId) {
    const list = await this.s.q('li_research_changes', 'SELECT change_id, change_json FROM li_research_changes WHERE lead_id = ? AND workspace_id = ? ORDER BY detected_at DESC, seq DESC', [String(leadId), this.s.workspaceId]);
    return list
      .map((r) => this.s.parse(r.change_json, 'li_research_changes', r.change_id))
      .filter((c) => c && typeof c === 'object');
  }
}

/* -------------------------- saved searches -------------------------- */

class PgSavedSearches {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const def = this.s.parse(r.definition_json, 'li_saved_searches', r.search_id);
    if (!def || typeof def !== 'object') return null;
    return { search_id: r.search_id, name: r.name, filter: def.filter, created_at: r.created_at, updated_at: r.updated_at };
  }

  async upsert(rec) {
    await this.s.insert('li_saved_searches', ['search_id', 'name', 'definition_json', 'created_at', 'updated_at'], [
      rec.search_id, rec.name, { filter: rec.filter }, rec.created_at, rec.updated_at,
    ], { onConflict: 'workspace_id,search_id', update: ['name', 'definition_json', 'updated_at'] });
    return this.get(rec.search_id);
  }

  async get(id) {
    return this._from(await this.s.one('li_saved_searches', 'SELECT * FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async list() {
    const list = await this.s.q('li_saved_searches', 'SELECT * FROM li_saved_searches WHERE workspace_id = ? ORDER BY lower(name)', [this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async delete(id) {
    const n = await this.s.run('DELETE FROM li_saved_searches WHERE search_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
    return n > 0;
  }
}

/* ----------------------------- segments ----------------------------- */

class PgSegments {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const def = this.s.parse(r.definition_json, 'li_segments', r.segment_id);
    if (!def || typeof def !== 'object') return null;
    return { segment_id: r.segment_id, name: r.name, kind: r.kind, filter: def.filter ?? null, created_at: r.created_at, updated_at: r.updated_at };
  }

  async upsert(rec) {
    await this.s.insert('li_segments', ['segment_id', 'name', 'kind', 'definition_json', 'created_at', 'updated_at'], [
      rec.segment_id, rec.name, rec.kind, { filter: rec.filter ?? null }, rec.created_at, rec.updated_at,
    ], { onConflict: 'workspace_id,segment_id', update: ['name', 'kind', 'definition_json', 'updated_at'] });
    return this.get(rec.segment_id);
  }

  async get(id) {
    return this._from(await this.s.one('li_segments', 'SELECT * FROM li_segments WHERE segment_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async list() {
    const list = await this.s.q('li_segments', 'SELECT * FROM li_segments WHERE workspace_id = ? ORDER BY lower(name)', [this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async delete(id) {
    let n = 0;
    await this.s.tx(async () => {
      await this.s.run('DELETE FROM li_segment_members WHERE segment_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
      n = await this.s.run('DELETE FROM li_segments WHERE segment_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
    });
    return n > 0;
  }

  async addMembers(id, leadIds, atIso) {
    await this.s.tx(async () => {
      for (const l of leadIds) {
        await this.s.insert('li_segment_members', ['segment_id', 'lead_id', 'added_at'], [id, String(l), atIso], { onConflict: '*', returning: false });
      }
    });
    const r = await this.s.one('li_segment_members', 'SELECT COUNT(*) AS n FROM li_segment_members WHERE segment_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
    return Number(r.n);
  }

  async removeMembers(id, leadIds) {
    await this.s.tx(async () => {
      for (const l of leadIds) {
        await this.s.run('DELETE FROM li_segment_members WHERE segment_id = ? AND lead_id = ? AND workspace_id = ?', [id, String(l), this.s.workspaceId]);
      }
    });
    const r = await this.s.one('li_segment_members', 'SELECT COUNT(*) AS n FROM li_segment_members WHERE segment_id = ? AND workspace_id = ?', [id, this.s.workspaceId]);
    return Number(r.n);
  }

  async members(id) {
    const list = await this.s.q('li_segment_members', 'SELECT lead_id FROM li_segment_members WHERE segment_id = ? AND workspace_id = ? ORDER BY added_at, lead_id', [id, this.s.workspaceId]);
    return list.map((r) => r.lead_id);
  }
}

/* ------------------------ pitches / approvals ------------------------ */

class PgPitches {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const d = this.s.parse(r.draft_json, 'li_pitch_drafts', r.pitch_id);
    return d && typeof d === 'object' ? d : null;
  }

  async upsert(rec) {
    await this.s.insert('li_pitch_drafts', ['pitch_id', 'lead_id', 'packet_id', 'status', 'content_hash', 'draft_json', 'created_at', 'updated_at'], [
      rec.pitch_id, rec.lead_id, rec.packet_id ?? null, rec.status, rec.content_hash, rec, rec.created_at, rec.updated_at,
    ], { onConflict: 'workspace_id,pitch_id', update: ['packet_id', 'status', 'content_hash', 'draft_json', 'updated_at'] });
    return { ...rec };
  }

  async get(id) {
    return this._from(await this.s.one('li_pitch_drafts', 'SELECT pitch_id, draft_json FROM li_pitch_drafts WHERE pitch_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async latestForLead(leadId) {
    return this._from(await this.s.one('li_pitch_drafts', 'SELECT pitch_id, draft_json FROM li_pitch_drafts WHERE lead_id = ? AND workspace_id = ? ORDER BY updated_at DESC, seq DESC LIMIT 1', [String(leadId), this.s.workspaceId]));
  }

  async listByLead(leadId, limit = 500) {
    const n = Math.max(1, Math.min(500, Number.isInteger(limit) ? limit : 500));
    const list = await this.s.q('li_pitch_drafts', 'SELECT pitch_id, draft_json FROM li_pitch_drafts WHERE lead_id = ? AND workspace_id = ? ORDER BY created_at DESC, pitch_id DESC LIMIT ?', [String(leadId), this.s.workspaceId, n]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async list(query) {
    const { status, limit, offset } = normalizePitchListQuery(query);
    const where = status ? ' WHERE status = ? AND workspace_id = ?' : ' WHERE workspace_id = ?';
    const params = status ? [status, this.s.workspaceId] : [this.s.workspaceId];
    const total = await this.s.one('li_pitch_drafts', `SELECT COUNT(*) AS c FROM li_pitch_drafts${where}`, params);
    const page = await this.s.q('li_pitch_drafts', `SELECT pitch_id, draft_json FROM li_pitch_drafts${where} ORDER BY updated_at DESC, pitch_id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { rows: page.map((r) => this._from(r)).filter(Boolean), total: total ? Number(total.c) : 0, limit, offset, status };
  }
}

class PgApprovals {
  constructor(s) { this.s = s; }

  async insert(rec) {
    await this.s.insert('li_outreach_approvals', ['approval_id', 'pitch_id', 'content_hash', 'approved_by', 'approved_at'], [
      rec.approval_id, rec.pitch_id, rec.content_hash, rec.approved_by, rec.approved_at,
    ]);
    return { ...rec };
  }

  async latestForPitch(pitchId) {
    return this.s.one('li_outreach_approvals', 'SELECT * FROM li_outreach_approvals WHERE pitch_id = ? AND workspace_id = ? ORDER BY approved_at DESC, seq DESC LIMIT 1', [pitchId, this.s.workspaceId]);
  }

  async deleteForPitches(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String);
    if (!list.length) return;
    await this.s.run(`DELETE FROM li_outreach_approvals WHERE pitch_id IN (${list.map(() => '?').join(', ')}) AND workspace_id = ?`, [...list, this.s.workspaceId]);
  }
}

/* ---------------------------- outreach activity ---------------------------- */

class PgActivity {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    let metadata = {};
    if (r.metadata_json) {
      const parsed = this.s.parse(r.metadata_json, 'li_outreach_activity', r.activity_id);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    }
    return {
      activity_id: r.activity_id,
      lead_id: r.lead_id,
      pitch_id: r.pitch_id === undefined ? null : r.pitch_id,
      activity_type: r.activity_type,
      metadata,
      created_at: r.created_at,
    };
  }

  async append(rec) {
    if (!ACTIVITY_TYPES.includes(rec.activity_type)) {
      throw new LiError('VALIDATION_FAILED', 'Invalid activity: activity_type');
    }
    await this.s.insert('li_outreach_activity', ['activity_id', 'lead_id', 'pitch_id', 'activity_type', 'metadata_json', 'created_at'], [
      rec.activity_id, rec.lead_id, rec.pitch_id ?? null, rec.activity_type, rec.metadata || {}, rec.created_at,
    ]);
    return { ...rec, metadata: { ...(rec.metadata || {}) } };
  }

  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeActivityQuery(query);
    const where = [];
    const params = [];
    if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
    if (pitchId) { where.push('pitch_id = ?'); params.push(pitchId); }
    where.push('workspace_id = ?');
    params.push(this.s.workspaceId);
    const clause = ' WHERE ' + where.join(' AND ');
    const total = await this.s.one('li_outreach_activity', `SELECT COUNT(*) AS c FROM li_outreach_activity${clause}`, params);
    const page = await this.s.q('li_outreach_activity', `SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity${clause} ORDER BY created_at DESC, activity_id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return {
      rows: page.map((r) => this._from(r)).filter(Boolean),
      total: total ? Number(total.c) : 0,
      limit,
      offset,
      leadId,
      pitchId,
    };
  }

  async latestForPitch(pitchId, activityType) {
    const r = await this.s.one('li_outreach_activity', 'SELECT activity_id, lead_id, pitch_id, activity_type, metadata_json, created_at FROM li_outreach_activity WHERE pitch_id = ? AND activity_type = ? AND workspace_id = ? ORDER BY created_at DESC, activity_id DESC LIMIT 1', [String(pitchId), activityType, this.s.workspaceId]);
    return this._from(r);
  }
}

/* ------------------------------ sends ------------------------------ */

function sendMailboxId(rec) {
  if (rec.mailbox_id == null) return null;
  if (typeof rec.mailbox_id !== 'string' || !MAILBOX_ID_RE.test(rec.mailbox_id)) throw new LiError('VALIDATION_FAILED', 'send: mailbox_id');
  return rec.mailbox_id;
}

class PgSends {
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
      mailbox_id: r.mailbox_id == null ? null : r.mailbox_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  async mailboxSendTimes(mailboxId, sinceIso) {
    const list = await this.s.q('li_outreach_sends', "SELECT created_at FROM li_outreach_sends WHERE mailbox_id = ? AND created_at >= ? AND state = 'accepted' AND workspace_id = ? ORDER BY created_at ASC", [String(mailboxId), String(sinceIso), this.s.workspaceId]);
    return list.map((r) => r.created_at);
  }

  async findAccepted(idempotencyKey) {
    return this._from(await this.s.one('li_outreach_sends', "SELECT * FROM li_outreach_sends WHERE idempotency_key = ? AND state = 'accepted' AND workspace_id = ? LIMIT 1", [String(idempotencyKey), this.s.workspaceId]));
  }

  async record(rec) {
    const n = normalizeSendRecord(rec);
    if (!n.ok) throw new LiError('VALIDATION_FAILED', n.error);
    if (n.value.state !== 'attempted') {
      throw new LiError('VALIDATION_FAILED', 'A send attempt must be recorded as attempted before it can change state');
    }
    const mailboxId = sendMailboxId(rec);
    await this.s.insert('li_outreach_sends', ['send_id', 'lead_id', 'pitch_id', 'channel', 'content_hash', 'idempotency_key', 'state', 'provider_id', 'provider_message_id', 'failure_code', 'failure_message', 'created_at', 'updated_at', 'mailbox_id'], [
      rec.send_id, rec.lead_id, rec.pitch_id, n.value.channel, rec.content_hash, rec.idempotency_key, 'attempted',
      n.value.provider_id, n.value.provider_message_id, null, null, rec.created_at, rec.updated_at, mailboxId,
    ]);
    return this.get(rec.send_id);
  }

  async accept({ sendId, providerId, providerMessageId, at }) {
    const existing = await this.findAcceptedBySend(sendId);
    if (existing) return { ok: true, row: existing };
    try {
      await this.s.run("UPDATE li_outreach_sends SET state = 'accepted', provider_id = ?, provider_message_id = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted' AND workspace_id = ?", [
        providerId === undefined ? null : providerId, providerMessageId === undefined ? null : providerMessageId, at, String(sendId), this.s.workspaceId,
      ]);
    } catch (err) {
      const winner = await this.findAcceptedForSendOfKey(sendId);
      if (winner) return { ok: false, code: 'ALREADY_ACCEPTED', row: winner };
      throw err;
    }
    return { ok: true, row: await this.get(sendId) };
  }

  async fail({ sendId, failureCode, failureMessage, at }) {
    await this.s.run("UPDATE li_outreach_sends SET state = 'failed', failure_code = ?, failure_message = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted' AND workspace_id = ?", [
      failureCode === undefined ? null : failureCode, failureMessage === undefined ? null : failureMessage, at, String(sendId), this.s.workspaceId,
    ]);
    return this.get(sendId);
  }

  async block({ sendId, failureCode, failureMessage, at }) {
    await this.s.run("UPDATE li_outreach_sends SET state = 'blocked', failure_code = ?, failure_message = ?, updated_at = ? WHERE send_id = ? AND state = 'attempted' AND workspace_id = ?", [
      failureCode === undefined ? null : failureCode, failureMessage === undefined ? null : failureMessage, at, String(sendId), this.s.workspaceId,
    ]);
    return this.get(sendId);
  }

  async findAcceptedBySend(sendId) {
    return this._from(await this.s.one('li_outreach_sends', "SELECT * FROM li_outreach_sends WHERE send_id = ? AND state = 'accepted' AND workspace_id = ? LIMIT 1", [String(sendId), this.s.workspaceId]));
  }

  async findAcceptedForSendOfKey(sendId) {
    return this._from(await this.s.one('li_outreach_sends', "SELECT accepted.* FROM li_outreach_sends AS accepted JOIN li_outreach_sends AS mine ON mine.idempotency_key = accepted.idempotency_key AND accepted.state = 'accepted' WHERE mine.send_id = ? AND mine.workspace_id = ? LIMIT 1", [String(sendId), this.s.workspaceId]));
  }

  async get(sendId) {
    return this._from(await this.s.one('li_outreach_sends', 'SELECT * FROM li_outreach_sends WHERE send_id = ? AND workspace_id = ?', [sendId, this.s.workspaceId]));
  }

  async list(query) {
    const { limit, offset, leadId, pitchId } = normalizeSendQuery(query);
    const where = [];
    const params = [];
    if (leadId) { where.push('lead_id = ?'); params.push(leadId); }
    if (pitchId) { where.push('pitch_id = ?'); params.push(pitchId); }
    where.push('workspace_id = ?');
    params.push(this.s.workspaceId);
    const clause = ' WHERE ' + where.join(' AND ');
    const total = await this.s.one('li_outreach_sends', `SELECT COUNT(*) AS c FROM li_outreach_sends${clause}`, params);
    const page = await this.s.q('li_outreach_sends', `SELECT * FROM li_outreach_sends${clause} ORDER BY created_at DESC, send_id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { rows: page.map((r) => this._from(r)).filter(Boolean), total: total ? Number(total.c) : 0, limit, offset };
  }
}

/* ---------------------------- enrichment ---------------------------- */

function ejobRow(j) {
  return [j.job_id, String(j.lead_id), j.state, j.fields || [], j.steps || [], j.next_attempt_at ?? null, j.last_error_code ?? null, j.created_at, j.updated_at, j.finished_at ?? null, j.version];
}

class PgEnrichmentJobs {
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

  async insert(job) {
    try {
      await this.s.insert('li_enrichment_jobs', EJOB_COLS, ejobRow(job));
    } catch (e) {
      const translated = this.s.translate(e, {
        unique: ['li_ejobs_one_active'],
        conflict: ['li_enrichment_jobs_pkey'],
        uniqueError: new DuplicateActiveJobError(`enrich:${job.lead_id}`),
        conflictError: new ConflictError('Job id already exists'),
      });
      if (translated) throw translated;
      throw e;
    }
    return { ...job };
  }

  async update(job, expectedVersion) {
    const sets = EJOB_COLS.filter((c) => c !== 'job_id').map((c) => `${c} = ?`).join(', ');
    try {
      await this.s.tx(async () => {
        const modified = await this.s.run(`UPDATE li_enrichment_jobs SET ${sets} WHERE job_id = ? AND version = ? AND workspace_id = ?`, [
          ...this.s.encodeRow('li_enrichment_jobs', EJOB_COLS.slice(1), ejobRow(job).slice(1)), job.job_id, expectedVersion, this.s.workspaceId,
        ]);
        if (modified === 0) throw new ConflictError('Enrichment job was changed by another operation', { jobId: job.job_id });
      });
    } catch (e) {
      const translated = this.s.translate(e, { unique: ['li_ejobs_one_active'], uniqueError: new DuplicateActiveJobError(`enrich:${job.lead_id}`) });
      if (translated) throw translated;
      if (e instanceof ConflictError) {
        const exists = await this.s.one('li_enrichment_jobs', 'SELECT job_id FROM li_enrichment_jobs WHERE job_id = ? AND workspace_id = ?', [job.job_id, this.s.workspaceId]);
        if (!exists) throw new NotFoundError('Enrichment job', job.job_id);
      }
      throw e;
    }
    return { ...job };
  }

  async get(id) {
    return this._from(await this.s.one('li_enrichment_jobs', 'SELECT * FROM li_enrichment_jobs WHERE job_id = ? AND workspace_id = ?', [id, this.s.workspaceId]));
  }

  async findActiveForLead(leadId) {
    return this._from(await this.s.one('li_enrichment_jobs', `SELECT * FROM li_enrichment_jobs WHERE lead_id = ? AND state IN ${E_ACTIVE_SQL} AND workspace_id = ? LIMIT 1`, [String(leadId), this.s.workspaceId]));
  }

  async listByLead(leadId) {
    const list = await this.s.q('li_enrichment_jobs', 'SELECT * FROM li_enrichment_jobs WHERE lead_id = ? AND workspace_id = ? ORDER BY created_at DESC, seq DESC', [String(leadId), this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async listDue(nowIso) {
    const list = await this.s.q('li_enrichment_jobs', `SELECT * FROM li_enrichment_jobs WHERE (state IN ('requested','running')
      OR (state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))) AND workspace_id = ? ORDER BY created_at ASC`, [nowIso, this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async listByStates(states) {
    if (!states.length) return [];
    const list = await this.s.q('li_enrichment_jobs', `SELECT * FROM li_enrichment_jobs WHERE state IN (${states.map(() => '?').join(',')}) AND workspace_id = ?`, [...states, this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }
}

class PgEnrichmentObservations {
  constructor(s) { this.s = s; }

  _from(r) {
    if (!r) return null;
    const value = r.value_json === null ? null : r.value_json;
    const conf = r.provider_confidence_json === null ? null : r.provider_confidence_json;
    const out = { ...r, value, provider_confidence: conf };
    delete out.value_json;
    delete out.provider_confidence_json;
    return out;
  }

  async upsertMany(list) {
    if (!list.length) return 0;
    await this.s.tx(async () => {
      for (const o of list) {
        await this.s.insert('li_enrichment_observations', ['observation_id', 'lead_id', 'job_id', 'field', 'status', 'value_json', 'provider_id', 'tier', 'source_ref', 'provider_confidence_json', 'collected_at', 'first_seen_at', 'provenance_id'], [
          o.observation_id, String(o.lead_id), o.job_id, o.field, o.status, o.value === null ? null : o.value, o.provider_id, o.tier, o.source_ref ?? null,
          o.provider_confidence ? o.provider_confidence : null, o.collected_at, o.collected_at, o.provenance_id,
        ], { onConflict: 'workspace_id,observation_id', update: ['collected_at', 'job_id'] });
      }
    });
    return list.length;
  }

  async listByLead(leadId) {
    const list = await this.s.q('li_enrichment_observations', 'SELECT * FROM li_enrichment_observations WHERE lead_id = ? AND workspace_id = ? ORDER BY observation_id', [String(leadId), this.s.workspaceId]);
    return list.map((r) => this._from(r)).filter(Boolean);
  }

  async listAllGrouped() {
    const out = new Map();
    const list = await this.s.q('li_enrichment_observations', 'SELECT * FROM li_enrichment_observations WHERE workspace_id = ? ORDER BY lead_id, observation_id', [this.s.workspaceId]);
    for (const r of list) {
      const o = this._from(r);
      if (!o) continue;
      if (!out.has(o.lead_id)) out.set(o.lead_id, []);
      out.get(o.lead_id).push(o);
    }
    return out;
  }
}

/* ------------------------ opportunity intelligence ------------------------ */

class PgOiAssociations {
  constructor(store) { this.s = store; }

  async listAll() {
    return this.s.q('li_oi_associations', `SELECT ${OI_ASSOC_COLS.join(', ')} FROM li_oi_associations WHERE workspace_id = ? ORDER BY lead_id, recorded_at DESC, research_id DESC`, [this.s.workspaceId]);
  }

  async put(rec, { keep = 50 } = {}) {
    return this.s.tx(async () => {
      await this.s.insert('li_oi_associations', OI_ASSOC_COLS, OI_ASSOC_COLS.map((c) => (rec[c] === undefined || rec[c] === null ? null : String(rec[c]))), { onConflict: '*', returning: false });
      await this.s.run('DELETE FROM li_oi_associations WHERE lead_id = ? AND workspace_id = ? AND research_id NOT IN '
        + '(SELECT research_id FROM li_oi_associations WHERE lead_id = ? AND workspace_id = ? ORDER BY recorded_at DESC, research_id DESC LIMIT ?)', [String(rec.lead_id), this.s.workspaceId, String(rec.lead_id), this.s.workspaceId, keep]);
      return this.s.one('li_oi_associations', `SELECT ${OI_ASSOC_COLS.join(', ')} FROM li_oi_associations WHERE research_id = ? AND workspace_id = ?`, [String(rec.research_id), this.s.workspaceId]);
    });
  }
}

class PgOiRefreshRequests {
  constructor(store) { this.s = store; }

  async pendingForLead(leadId) {
    return this.s.one('li_oi_refresh_requests', `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE lead_id = ? AND state = 'pending' AND workspace_id = ?`, [String(leadId), this.s.workspaceId]);
  }

  async listAllPending() {
    return this.s.q('li_oi_refresh_requests', `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE state = 'pending' AND workspace_id = ? ORDER BY lead_id`, [this.s.workspaceId]);
  }

  async listByLead(leadId, limit = 20) {
    return this.s.q('li_oi_refresh_requests', `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE lead_id = ? AND workspace_id = ? ORDER BY created_at DESC, request_id DESC LIMIT ?`, [String(leadId), this.s.workspaceId, limit]);
  }

  async open(rec) {
    return this.s.tx(async () => {
      try {
        await this.s.insert('li_oi_refresh_requests', OI_REFRESH_COLS, [String(rec.request_id), String(rec.lead_id), 'pending', null, null, String(rec.created_at), String(rec.created_at)]);
      } catch (e) {
        const translated = this.s.translate(e, { unique: ['li_oi_refresh_one_pending'], uniqueError: new ConflictError('The lead already has a pending refresh request') });
        if (translated) throw translated;
        throw e;
      }
      return this.s.one('li_oi_refresh_requests', `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE request_id = ? AND workspace_id = ?`, [String(rec.request_id), this.s.workspaceId]);
    });
  }

  async close(requestId, { state, research_id = null, error_code = null, updated_at }, { keep = 20 } = {}) {
    if (state !== 'succeeded' && state !== 'failed') throw new Error('close() takes succeeded or failed');
    return this.s.tx(async () => {
      await this.s.run("UPDATE li_oi_refresh_requests SET state = ?, research_id = ?, error_code = ?, updated_at = ? WHERE request_id = ? AND state = 'pending' AND workspace_id = ?", [
        state, research_id == null ? null : String(research_id), error_code == null ? null : String(error_code), String(updated_at), String(requestId), this.s.workspaceId,
      ]);
      const r = await this.s.one('li_oi_refresh_requests', `SELECT ${OI_REFRESH_COLS.join(', ')} FROM li_oi_refresh_requests WHERE request_id = ? AND workspace_id = ?`, [String(requestId), this.s.workspaceId]);
      if (r) {
        await this.s.run("DELETE FROM li_oi_refresh_requests WHERE lead_id = ? AND state != 'pending' AND workspace_id = ? AND request_id NOT IN "
          + "(SELECT request_id FROM li_oi_refresh_requests WHERE lead_id = ? AND state != 'pending' AND workspace_id = ? ORDER BY created_at DESC, request_id DESC LIMIT ?)", [r.lead_id, this.s.workspaceId, r.lead_id, this.s.workspaceId, keep]);
      }
      return r;
    });
  }
}

module.exports = { PostgresStore, PLATFORM_WORKSPACE_ID };
