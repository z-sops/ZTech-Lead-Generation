'use strict';

/**
 * A10 — Lead Intelligence runtime for the ZTech Electron main process.
 *
 * Responsibilities (and ONLY these):
 *   - initialise Lead Intelligence against the EXISTING shared database
 *     (userData/data/whatsapp.db, owned by AccountStore) — no second database;
 *   - run the LI additive migrations (`li_*` tables) on that same database;
 *   - construct the Lead Intelligence runtime in round1 mode, so the existing
 *     PitchGenerator / OutreachService / OutreachGate / EmailProvider are used
 *     exactly as shipped;
 *   - connect the Round1ResearchBridge to a READ-ONLY Round-1 port;
 *   - expose clean shutdown.
 *
 * It never starts background work: `li.start()` is NOT called, no timer is
 * created, and Round-1 research is never started, polled or retried from here.
 * Round-1 remains the only research engine.
 *
 * Initialisation happens strictly after `await accountStore.ready`.
 */

const { SqlJsStore } = require('./persistence/SqlJsStore');
const { createLeadIntelligence } = require('./index');
const { accountStoreLeadSource } = require('./integration/mainProcess');
const { round1PacketMapper } = require('./round1PacketMapper');

/**
 * The 11 additive Lead Intelligence tables, exactly as the shipped migrations
 * create them. None of these is an existing ZTech table: they are all `li_*`
 * names, created with CREATE TABLE IF NOT EXISTS on the shared database.
 */
const LI_TABLES = Object.freeze([
  'li_schema_migrations',
  'li_research_jobs',
  'li_evidence_packets',
  'li_research_changes',
  'li_saved_searches',
  'li_segments',
  'li_segment_members',
  'li_pitch_drafts',
  'li_outreach_approvals',
  // F15: the append-only outreach activity ledger.
  'li_outreach_activity',
  'li_enrichment_jobs',
  'li_enrichment_observations',
  // F19: the outbound send ledger. At most one accepted row per idempotency key, so the
  // same approved content can never be accepted twice.
  'li_outreach_sends',
]);

const ROUND1_TABLE = 'prospect_research';

function rowsFrom(db, sql, params) {
  let result;
  try {
    result = db.exec(sql, params);
  } catch (e) {
    // The table belongs to the Round-1 engine. If it does not exist yet there is
    // simply no Round-1 research to read; that is an empty result, not a crash.
    if (/no such table/i.test(String(e && e.message))) return [];
    throw e;
  }
  if (!result || !result.length) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const out = {};
    for (let i = 0; i < columns.length; i += 1) out[columns[i]] = row[i];
    return out;
  });
}

function recordFromRow(row) {
  try {
    return JSON.parse(row.record_json);
  } catch {
    return null;
  }
}

/**
 * READ-ONLY Round-1 port over the existing `prospect_research` table.
 * It never writes, never transitions a phase and never controls the Round-1
 * engine; it only reads records the engine already finished.
 */
function createRound1Port(db) {
  if (!db) throw new Error('Lead Intelligence runtime needs the open database');
  return {
    async getLatest(leadId) {
      const rows = rowsFrom(db, `SELECT record_json FROM ${ROUND1_TABLE} WHERE lead_ref = ? ORDER BY updated_at DESC`, [String(leadId)]);
      for (const row of rows) {
        const record = recordFromRow(row);
        if (record) return record;
      }
      return null;
    },
    async listByLead(leadId) {
      const rows = rowsFrom(db, `SELECT record_json FROM ${ROUND1_TABLE} WHERE lead_ref = ? ORDER BY updated_at DESC`, [String(leadId)]);
      return rows.map(recordFromRow).filter(Boolean);
    },
    async listLatestPerLead() {
      const rows = rowsFrom(db, `SELECT record_json FROM ${ROUND1_TABLE} ORDER BY updated_at DESC`);
      const out = new Map();
      for (const row of rows) {
        const record = recordFromRow(row);
        if (!record) continue;
        const key = String(record.leadRef);
        if (!out.has(key)) out.set(key, record);
      }
      return out;
    },
  };
}

/**
 * @param {object} p
 * @param {object} p.accountStore  the app's existing AccountStore (already awaited .ready)
 * @param {object} [p.targetSource] { getTarget(id) } over the existing targets table
 * @param {object} [p.config]      lead-intelligence config (research.mode is forced to "round1")
 * @param {object} [p.logger]
 * @param {object} [p.round1Port]  injected read-only Round-1 port (tests); defaults to the table reader
 */
async function initializeLeadIntelligenceRuntime({ accountStore, targetSource = null, config = {}, logger = console, round1Port = null, clock }) {
  if (!accountStore || typeof accountStore !== 'object') throw new TypeError('accountStore is required');
  // A10 contract: the runtime initialises ONLY after the shared database is open.
  await accountStore.ready;
  if (!accountStore.db) throw new Error('AccountStore database is not open');

  // No second persistence: the LI store wraps the SAME sql.js handle and flushes
  // through the app's existing synchronous saveDB().
  const store = new SqlJsStore({ db: accountStore.db, persist: () => accountStore.saveDB(), logger });
  await store.migrate();

  const port = round1Port || createRound1Port(accountStore.db);
  const leadSource = accountStoreLeadSource(accountStore);

  const li = createLeadIntelligence({
    store,
    leadSource,
    targetSource,
    round1: port,
    config: { ...config, research: { ...(config.research || {}), mode: 'round1' } },
    logger,
    // Forwarded only when the caller supplies one, so the production path (main.js passes
    // no clock) keeps createLeadIntelligence's own `() => new Date()` default and is
    // byte-for-byte unchanged. This exists because createLeadIntelligence already accepts
    // an injected clock; without the pass-through a caller had no way to evaluate evidence
    // freshness against a chosen "now", which made any freshness assertion depend on the
    // wall clock rather than on the data.
    ...(clock ? { clock } : {}),
    llmComplete: null,
    // No email provider in this phase: the channel is not registered and no
    // send path exists. OutreachService keeps its EMAIL_DISABLED default.
    emailProvider: null,
    // The Round-1 record shape is mapped by the injectable A10 mapper.
    round1ResultMapper: round1PacketMapper,
  });

  let closed = false;
  return {
    li,
    store,
    round1Port: port,
    get available() { return !closed; },
    /** Clean shutdown: stops nothing that was never started, closes LI resources. */
    async shutdown() {
      if (closed) return;
      closed = true;
      li.stop();
      if (typeof store.close === 'function') await store.close();
    },
  };
}

module.exports = { initializeLeadIntelligenceRuntime, createRound1Port, LI_TABLES, ROUND1_TABLE };
