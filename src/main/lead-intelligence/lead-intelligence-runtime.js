'use strict';

const { LeadTimeline } = require('./timeline/LeadTimeline');

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
const { createOpportunityIntelligence } = require('./opportunity');

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
  // I3: lead <-> Opportunity Intelligence research ids. IDs only; the report stays in OI.
  'li_oi_associations',
  // I5: one persisted idempotency key per human OI refresh intent. IDs and state only.
  'li_oi_refresh_requests',
  // F26.5 (migration 008): suppressions, consents, provenance, trust events and the
  // desktop-only recipient_ref map. Codes, ids, normalized addresses and timestamps only.
  'li_suppressions',
  'li_contact_consents',
  'li_contact_provenance',
  'li_trust_events',
  'li_recipient_refs',
  // F26.6 (migration 010): connected mailboxes (sanitized identity, status, limits - never a
  // token), provider-stored ids of each mailbox send, and the per-country market rules.
  'li_mailboxes',
  'li_mailbox_sent',
  'li_market_rules',
  // F26.6 follow-up (migration 011): the human review of a verified mailbox reply.
  'li_reply_reviews',
  // F28 (migration 012): follow-up sequences and their steps (each with its own follow-up pitch),
  // the append-only sequence audit (ids, codes, times) and the one "Pause all follow-ups" switch.
  'li_sequences',
  'li_sequence_steps',
  'li_sequence_events',
  'li_sequence_control',
  // F28 review fix: the latest reply-history gap per mailbox (mailbox id + time only).
  'li_sequence_gaps',
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
 * @param {object} [p.emailProvider] F23: the email EmailProvider instance (ResendEmailProvider
 *        in the main process). `null`/omitted means no provider instance exists and the send
 *        boundary refuses with EMAIL_PROVIDER_NOT_SET - the pre-F23 default, unchanged.
 * @param {object} [p.whatsappProvider] F24: the WhatsApp WhatsAppProvider instance (the
 *        single MetaCloudWhatsAppProvider adapter in the main process). `null`/omitted means
 *        no provider instance exists and the send boundary refuses with
 *        WHATSAPP_PROVIDER_NOT_SET - the pre-F24 default, unchanged for every caller that
*        does not supply one.
 * @param {object} [p.opportunity] Phase I2 Opportunity Intelligence wiring:
 *        { config?, fetchImpl? }. OI is a SEPARATE local FastAPI service with its
 *        OWN database. ZTech persists only the lead <-> research ids (migration 006,
 *        li_oi_associations); no report content enters the shared whatsapp.db. Constructing it cannot fail and cannot
 *        affect `li`: if OI is down, misconfigured or disabled, `li` is returned
 *        exactly as it would have been without this parameter.
 */
async function initializeLeadIntelligenceRuntime({ accountStore, targetSource = null, config = {}, logger = console, round1Port = null, clock, emailProvider = null, whatsappProvider = null, opportunity = null, openExternal = null, trustRelay = null, mailbox = null }) {
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
    // F23: the email provider instance is INJECTED by the caller (main.js builds
    // ResendEmailProvider with a main-process-only API-key closure and an injectable
    // transport). Omitted/null - every test harness and the previous behaviour - means no
    // provider instance exists, and the F19 boundary refuses before anything is read.
    // The channel is never registered from here and no send path is invented here.
    emailProvider,
    // F24: the WhatsApp provider instance is INJECTED by the caller exactly like the email
    // provider (main.js builds MetaCloudWhatsAppProvider with a main-process-only token
    // closure and an injectable transport). Omitted/null - every test harness and the
    // previous behaviour - means no provider instance exists, and the F20 boundary refuses
    // with WHATSAPP_PROVIDER_NOT_SET before anything is read. The channel is never
    // registered from here and no send path is invented here.
    whatsappProvider,
    // The Round-1 record shape is mapped by the injectable A10 mapper.
    round1ResultMapper: round1PacketMapper,
    // F26.5: opens a mailto: URL in the person's own mail app (main.js restricts it to mailto).
    openExternal,
  });

  // F26.5: one-time provenance backfill - every existing contact field without provenance is
  // marked 'unknown' (nothing inferred). It never fails initialisation.
  if (li.trust) {
    try {
      await li.trust.backfillProvenance();
    } catch (err) {
      if (logger && logger.warn) logger.warn(`[lead-intelligence] provenance backfill skipped: ${err && err.message}`);
    }
  }

  // F26.5: the Hosted Trust Relay client - OFF unless BOTH a relay URL and a secret are
  // configured (trustRelay: { url, getSecret, cursorStore, fetchImpl }). The secret stays in
  // this process; nothing about it reaches the renderer.
  let relay = null;
  if (li.trust && trustRelay) {
    try {
      const { buildRelayClient } = require('./trust/RelayClient');
      relay = buildRelayClient({ ...trustRelay, trust: li.trust, logger });
      if (relay) {
        li.outreach.setRelayLinks(relay);
        relay.start(trustRelay.intervalMs);
      }
    } catch (err) {
      relay = null;
      if (logger && logger.warn) logger.warn(`[lead-intelligence] trust relay disabled: ${err && err.message}`);
    }
  }

  // F26.6: connected mailboxes. OFF unless main.js injects the main-only token store and Google
  // client config ({ tokenStore, clientConfig, openBrowser, fetchImpl, operator }). Tokens, the
  // client secret and the OAuth exchange never leave this process.
  li.mailboxes = null;
  let mailboxSyncTimer = null;
  if (mailbox) {
    try {
      const { MailboxService } = require('./mailbox/MailboxService');
      const { GoogleOAuth } = require('./mailbox/gmail/GoogleOAuth');
      const fetchImpl = mailbox.fetchImpl || globalThis.fetch;
      li.mailboxes = new MailboxService({
        store, clock, tokenStore: mailbox.tokenStore, clientConfig: mailbox.clientConfig, fetch: fetchImpl,
        googleOAuth: mailbox.openBrowser ? new GoogleOAuth({ fetch: fetchImpl, openExternal: mailbox.openBrowser }) : null,
        operator: mailbox.operator || config.operatorName || 'local-user', logger, trust: li.trust,
      });
      li.outreach.setMailboxes(li.mailboxes);
      // Reply sync (D4): headers-only polling while the app is open. It READS; it never sends,
      // queues or retries a message. A failure is logged by code and the next tick tries again.
      const every = Number.isInteger(mailbox.syncIntervalMs) && mailbox.syncIntervalMs >= 60000 ? mailbox.syncIntervalMs : 5 * 60 * 1000;
      mailboxSyncTimer = setInterval(() => {
        li.mailboxes.syncAll().catch((err) => { if (logger && logger.warn) logger.warn(`[lead-intelligence] mailbox sync failed: ${(err && err.code) || 'ERROR'}`); });
      }, every);
      if (mailboxSyncTimer.unref) mailboxSyncTimer.unref();
    } catch (err) {
      li.mailboxes = null;
      if (logger && logger.warn) logger.warn(`[lead-intelligence] mailboxes disabled: ${err && err.message}`);
    }
  }

  // F28: follow-up sequences. The service always exists (drafting, review, stop); the scheduler -
  // the ONE thing that sends an approved step of an activated sequence by itself (D1) - runs only
  // when connected mailboxes exist, and only while the app is open.
  li.sequences = null;
  let sequenceScheduler = null;
  try {
    const { SequenceService } = require('./sequences/SequenceService');
    li.sequences = new SequenceService({ store, outreach: li.outreach, mailboxes: li.mailboxes, clock: clock || (() => new Date()), logger });
    li.outreach.setSequences(li.sequences);
    if (li.mailboxes) {
      // A reply-history gap seen by ANY sync (timer, button, scheduler) holds that mailbox's follow-ups.
      li.mailboxes.setRepliesGapListener((mailboxId, at) => li.sequences.noteRepliesGap(mailboxId, at));
      const { SequenceScheduler } = require('./sequences/SequenceScheduler');
      sequenceScheduler = new SequenceScheduler({ sequences: li.sequences, store, clock: clock || (() => new Date()), logger });
      sequenceScheduler.start(mailbox && Number.isInteger(mailbox.sequenceIntervalMs) ? mailbox.sequenceIntervalMs : undefined);
    }
  } catch (err) {
    li.sequences = null;
    sequenceScheduler = null;
    if (logger && logger.warn) logger.warn(`[lead-intelligence] follow-ups disabled: ${err && err.message}`);
  }
  li.sequenceScheduler = sequenceScheduler;

  let closed = false;

  // --- Phase I2: Opportunity Intelligence -----------------------------------
  // Built last, in its own try/catch, and never awaited in a way that could delay
  // or fail Lead Intelligence. OI is read-only research context with its own store;
  // it shares nothing with `li` except lead_id.
  const oi = buildOpportunity(opportunity, leadSource, logger, store);
  // I3: reload persisted associations so a researched lead still opens its report after
  // a restart. load() never throws; a failure leaves the store empty ("not researched").
  if (oi && typeof oi.loadAssociations === 'function') await oi.loadAssociations();

  // I6: the read-only lead timeline. It reads the stores above and OI's LOCAL association
  // ledger; it writes nothing and calls no service.
  const timeline = new LeadTimeline({ store, leadSource, round1: port, opportunity: oi ? oi.service : null });

  return {
    li,
    store,
    round1Port: port,
    opportunity: oi,
    timeline,
    relay,
    get available() { return !closed; },
    /** Clean shutdown: stops nothing that was never started, closes LI resources. */
    async shutdown() {
      if (closed) return;
      closed = true;
      if (relay) relay.stop();
      if (mailboxSyncTimer) clearInterval(mailboxSyncTimer);
      // Let a follow-up that is mid-send finish recording before the store closes.
      if (sequenceScheduler) await sequenceScheduler.stop();
      li.stop();
      // OI holds no socket and no timer, so this is a no-op that exists so the
      // shutdown path is explicit rather than accidental.
      if (oi) { try { await oi.stop(); } catch { /* never block shutdown */ } }
      if (typeof store.close === 'function') await store.close();
    },
  };
}

/**
 * Construct the OI service, or return a handle whose every method answers
 * "unavailable". NEVER throws: a broken OI must not be able to break ZTech.
 */
function buildOpportunity(spec, leadSource, logger, store = null) {
  if (!spec) return null;
  const safeWarn = (m) => { if (logger && logger.warn) logger.warn('lead-intel', String(m)); };
  try {
    const oi = createOpportunityIntelligence({
      config: spec.config || {},
      fetchImpl: spec.fetchImpl,
      clock: spec.clock,
      associationBacking: store && store.oiAssociations ? store.oiAssociations : null,
      refreshBacking: store && store.oiRefreshRequests ? store.oiRefreshRequests : null,
      logger: { warn: safeWarn, error: (m) => { if (logger && logger.error) logger.error('lead-intel', String(m)); }, info: () => {} },
    });
    // `oiSource` is the one thing OI is given from ZTech: a leadId -> view reader.
    // It cannot express a destination or a credential, which is the whole point.
    oi.leadSource = leadSource;
    // Health is probed in the BACKGROUND: startup must not wait on OI, and a slow
    // or dead OI must not delay the ZTech window. .catch keeps an unhandled
    // rejection out of the process.
    oi.healthProbe = oi.start().catch((e) => safeWarn(`opportunity-intelligence probe failed: ${e && e.message}`));
    return oi;
  } catch (e) {
    safeWarn(`opportunity-intelligence could not be constructed: ${e && e.message}`);
    return null;
  }
}

module.exports = { initializeLeadIntelligenceRuntime, createRound1Port, LI_TABLES, ROUND1_TABLE };
