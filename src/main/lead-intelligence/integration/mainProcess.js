'use strict';

/**
 * Main-process wiring for ZTech — Option A (research.mode "round1").
 *
 * The right-hand names are ZTech facts verified in Step 0 (2026-09-27); anything marked
 * INTEGRATION POINT must still be written by QwenCoder against the real code:
 *
 *   sql.js db + save       -> accountStore.db, accountStore.saveDB()          (accountStore.js)
 *   JSON fallback          -> accountStore.db === null after fallbackToJson()  -> NOT_AVAILABLE
 *   leadSource.getLead     -> accountStore.queryNumbers({ limit: 1, offset: 0, id }).rows[0]
 *   leadSource.listLeads   -> accountStore.getCollectedNumbers()
 *   targetSource.getTarget -> the `targets` table / targets:list data            (INTEGRATION POINT)
 *   round1 port            -> round-1 prospect_research records                 (INTEGRATION POINT)
 *   isTrustedSender        -> round-1 createTrustedSender(getWindow, options)   (src/main/prospect-research/trusted-sender.js)
 *   lead deletion          -> after accountStore.deleteNumbers(ids): await store.purgeLead(id) for each id
 */
const { SqlJsStore } = require('../persistence/SqlJsStore');
const { createLeadIntelligence } = require('../index');
const { registerLeadIntelligenceIpc, registerUnavailableLeadIntelligenceIpc } = require('../ipc/registerLeadIntelligenceIpc');

/**
 * @param {object} p
 * @param {object} p.ipcMain
 * @param {object|null} p.db          accountStore.db (null in JSON fallback mode)
 * @param {Function} p.persist        () => accountStore.saveDB()
 * @param {object} p.leadSource       { getLead(id), listLeads() }
 * @param {object} p.targetSource     { getTarget(id) }
 * @param {object} p.round1           { getLatest(leadId), listByLead(leadId), listLatestPerLead() }
 * @param {Function} p.isTrustedSender
 * @param {object} p.config           lead-intelligence config (research.mode "round1")
 * @param {object} [p.logger]
 */
async function setupLeadIntelligence(p) {
  const logger = p.logger || console;
  if (!p.db) {
    // JSON fallback mode: no second persistence is created; every channel answers NOT_AVAILABLE.
    const ipc = registerUnavailableLeadIntelligenceIpc({ ipcMain: p.ipcMain, isTrustedSender: p.isTrustedSender });
    return { li: null, store: null, ipc, available: false };
  }
  const store = new SqlJsStore({ db: p.db, persist: p.persist, logger });
  await store.migrate();

  const config = { ...p.config, research: { ...(p.config.research || {}), mode: 'round1' } };
  const li = createLeadIntelligence({
    store,
    leadSource: p.leadSource,
    targetSource: p.targetSource,
    round1: p.round1,
    config,
    logger,
    llmComplete: null, // no LLM client in ZTech (Step 0 #17)
    emailProvider: null, // no email provider in this phase
  });
  const ipc = registerLeadIntelligenceIpc({ ipcMain: p.ipcMain, li, isTrustedSender: p.isTrustedSender, dialogs: {}, logger });
  // Non-blocking background work: round-1 result sync + enrichment ticks.
  li.start();
  return { li, store, ipc, available: true };
}

/**
 * leadSource over ZTech's AccountStore (verified method names, Step 0 #1).
 * queryNumbers returns { rows, total, limit, offset }.
 */
function accountStoreLeadSource(accountStore) {
  return {
    async getLead(id) {
      // accountStore.queryNumbers validates `id` with `typeof q.id === 'string'` and
      // returns an EMPTY envelope for anything else (accountStore.js, "B3 single-lead
      // lookup"). ZTech `numbers.id` is declared TEXT and holds string ids, so the id is
      // normalised to a string and passed through unchanged. A previous numeric
      // coercion (Number(id)) made every digit-only lead id fail that guard, which
      // surfaced as NotFoundError('Lead') from LeadContextService.getContext.
      const key = typeof id === 'string' ? id : String(id);
      const r = await accountStore.queryNumbers({ limit: 1, offset: 0, id: key });
      return r && Array.isArray(r.rows) && r.rows[0] ? r.rows[0] : null;
    },
    async listLeads() {
      const rows = await accountStore.getCollectedNumbers();
      return Array.isArray(rows) ? rows : [];
    },
  };
}

module.exports = { setupLeadIntelligence, accountStoreLeadSource };
