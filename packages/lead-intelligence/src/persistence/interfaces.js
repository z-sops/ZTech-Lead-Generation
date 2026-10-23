'use strict';

/**
 * The repository seam (M1).
 *
 * The persistence layer used to be called directly: `store.jobs.insert(...)`.
 * This module is the EXPLICIT interface both backing stores satisfy - the
 * desktop's sql.js store and the PostgreSQL store - so that the same service
 * code can run against either, and so that a third store cannot silently
 * grow a different surface.
 *
 * It is pure: no database, no file system, no process. It declares the
 * surface and checks it, so a store that forgets a method fails a test
 * rather than a production call.
 *
 * The repositories, and what each one owns:
 *
 *   jobs                   research jobs: one active job per request key
 *   packets                evidence packets (the packet itself, plus its meta)
 *   changes                the detected differences between two packets
 *   savedSearches          saved lead filters
 *   segments               static and dynamic segments, and their members
 *   pitches                pitch drafts
 *   approvals              the human approval of a pitch's content hash
 *   activity               the append-only outreach activity ledger
 *   sends                  the send ledger, with the idempotency guarantee
 *   enrichmentJobs         enrichment waterfall runs
 *   enrichmentObservations the observations, with their provenance
 *   oiAssociations         the lead <-> Opportunity Intelligence link
 *   oiRefreshRequests      the human refresh intents (the idempotency key)
 *   suppressions           who must never be contacted again
 *   consents               recorded opt-ins
 *   provenance             where each contact field came from
 *   trustEvents            the append-only trust inbox
 *   recipientRefs          the desktop-only recipient_ref map
 *   mailboxes              the connected mailboxes and their limits
 *   mailboxSent            what the provider stored for each mailbox send
 *   marketRules            the per-country market rule
 *   replyReviews           the human review of a verified reply
 *   sequences              the follow-up sequences, their steps and their audit
 *   replyRoutes            the suggested reply categories
 *
 * and on the store itself: `migrate()`, `purgeLead(leadId)`, `tx(fn)` and the
 * `corruptRows` list.
 *
 * The invariants a store MUST preserve are listed in INVARIANTS. They are not
 * a description of the current implementation: they are the properties the
 * contract suite proves, on every backend.
 */

/** The repositories a store must expose, and the methods each one must have. */
const REPOSITORIES = Object.freeze({
  jobs: ['insert', 'update', 'get', 'findActive', 'listByLead', 'listDue', 'listByStates', 'latestPerLead'],
  packets: ['insert', 'get', 'latestForLead', 'previousForLead', 'listMetaByLead', 'getMeta', 'latestMetaPerLead'],
  changes: ['insertMany', 'listByLead'],
  savedSearches: ['upsert', 'get', 'list', 'delete'],
  segments: ['upsert', 'get', 'list', 'delete', 'addMembers', 'removeMembers', 'members'],
  pitches: ['upsert', 'get', 'latestForLead', 'listByLead', 'list'],
  approvals: ['insert', 'latestForPitch', 'deleteForPitches'],
  activity: ['append', 'list', 'latestForPitch'],
  sends: ['mailboxSendTimes', 'findAccepted', 'record', 'accept', 'fail', 'block', 'findAcceptedBySend', 'findAcceptedForSendOfKey', 'get', 'list'],
  enrichmentJobs: ['insert', 'update', 'get', 'findActiveForLead', 'listByLead', 'listDue', 'listByStates'],
  enrichmentObservations: ['upsertMany', 'listByLead', 'listAllGrouped'],
  oiAssociations: ['listAll', 'put'],
  oiRefreshRequests: ['pendingForLead', 'listAllPending', 'listByLead', 'open', 'close'],
  suppressions: ['add', 'find', 'listForAddress', 'list', 'removeManual'],
  consents: ['record', 'latestFor', 'listByLead', 'deleteByLead'],
  provenance: ['put', 'putMany', 'leadIds', 'listByLead', 'deleteByLead'],
  trustEvents: ['append', 'get', 'latestFor', 'list'],
  recipientRefs: ['ensure', 'resolve', 'forAddress'],
  mailboxes: ['upsert', 'get', 'list', 'getDefault', 'setStatus', 'setLimits', 'setDefault', 'setSyncCursor', 'remove'],
  mailboxSent: ['record', 'get', 'findByStoredIds'],
  marketRules: ['set', 'get', 'list', 'remove'],
  replyReviews: ['put', 'forEvent', 'latestFor'],
  sequences: ['create', 'get', 'steps', 'openForLead', 'latestForLead', 'forFirstSend', 'listOpen', 'update', 'claimStep', 'updateStep', 'stepByPitch', 'dueSteps', 'stepsInState', 'appendEvent', 'events', 'noteGap', 'gapFor', 'control', 'setControl', 'deleteByLead'],
  replyRoutes: ['put', 'get', 'confirm', 'forLead', 'list', 'deleteByLead'],
});

/** The methods the store itself must have. */
const STORE_METHODS = Object.freeze(['migrate', 'purgeLead', 'tx']);

/**
 * The properties a store must preserve. The contract suite proves each of
 * them on every backend; a store that breaks one is wrong even when every
 * method exists.
 */
const INVARIANTS = Object.freeze([
  'one active research job per request key',
  'one active enrichment job per lead',
  'one pending OI refresh request per lead',
  'at most one accepted send per (channel, idempotency key)',
  'one trust event per event_id, except a rejected one',
  'one open sequence per lead',
  'one reply review per reply event',
  'a corrupt row is skipped and reported, never fatal',
  'a compare-and-set on a stale version is refused',
  'a duplicate primary key is a conflict, not a silent overwrite',
  'malformed JSON and malformed timestamps are never trusted',
  'purgeLead removes the lead data and keeps the address-keyed history',
]);

/**
 * Check that an object satisfies the repository seam.
 *
 * @param {object} store
 * @returns {string[]} the problems; empty when the store satisfies the seam
 */
function checkRepositoryShape(store) {
  const problems = [];
  if (!store || typeof store !== 'object') return ['the store is not an object'];
  for (const method of STORE_METHODS) {
    if (typeof store[method] !== 'function') problems.push(`store.${method} is missing`);
  }
  if (!Array.isArray(store.corruptRows)) problems.push('store.corruptRows is missing');
  for (const [name, methods] of Object.entries(REPOSITORIES)) {
    const repo = store[name];
    if (!repo || typeof repo !== 'object') {
      problems.push(`store.${name} is missing`);
      continue;
    }
    for (const method of methods) {
      if (typeof repo[method] !== 'function') problems.push(`store.${name}.${method} is missing`);
    }
  }
  return problems;
}

/**
 * Check that a store satisfies the seam, and throw if it does not.
 * @param {object} store
 * @param {string} [label] what the store is called, in the error
 */
function assertRepositoryShape(store, label = 'store') {
  const problems = checkRepositoryShape(store);
  if (problems.length) {
    throw new TypeError(`${label} does not satisfy the repository seam: ${problems.join('; ')}`);
  }
  return store;
}

module.exports = {
  REPOSITORIES,
  STORE_METHODS,
  INVARIANTS,
  checkRepositoryShape,
  assertRepositoryShape,
};
