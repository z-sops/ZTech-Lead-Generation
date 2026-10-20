'use strict';

const crypto = require('crypto');

/**
 * I5 (decision E4) - one persisted idempotency key per HUMAN refresh intent.
 *
 *   one user refresh intent
 *     -> one persisted request_id (= the idempotency_key OI receives)
 *     -> every retry reuses it, across timeouts and app restarts
 *     -> a terminal success / failure closes it; only the next deliberate Refresh mints a new one
 *
 * The row is written BEFORE the request leaves ZTech. If that write fails, nothing is sent:
 * an un-recorded key could not be reused, and a retry could then pay OI providers twice.
 *
 * Backing: store.oiRefreshRequests (migration 007). Without a backing (a store-less dev or
 * test runtime) an in-process twin is used, which keeps the same rules for this session only.
 */
class OpportunityRefreshLedger {
  constructor({ backing = null, clock = () => new Date() } = {}) {
    this.clock = clock;
    this.backing = backing && typeof backing.open === 'function' && typeof backing.pendingForLead === 'function'
      ? backing
      : new (require('../persistence/MemoryStore').MemoryStore)().oiRefreshRequests;
    this.persistent = Boolean(backing && this.backing === backing);
  }

  /** The open intent for a lead, or null. Throws if the store cannot be read. */
  async pending(leadId) {
    return this.backing.pendingForLead(String(leadId));
  }

  /** Record a NEW intent and return its request_id. Throws if it could not be recorded. */
  async open(leadId) {
    const request_id = mintRequestId(leadId);
    await this.backing.open({ request_id, lead_id: String(leadId), created_at: this.clock().toISOString() });
    return request_id;
  }

  async succeed(requestId, researchId) {
    return this.backing.close(requestId, { state: 'succeeded', research_id: researchId, updated_at: this.clock().toISOString() });
  }

  async fail(requestId, errorCode) {
    return this.backing.close(requestId, { state: 'failed', error_code: errorCode || 'FAILED', updated_at: this.clock().toISOString() });
  }
}

/**
 * `ztech-<lead>-<96 random bits>`. Only OI's key charset (A-Z a-z 0-9 . _ : -), at most
 * 128 characters, and unique per intent - never the lead id alone, which would make every
 * later refresh replay the first report.
 */
function mintRequestId(leadId) {
  const lead = String(leadId).replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 64);
  return `ztech-${lead}-${crypto.randomBytes(12).toString('hex')}`;
}

module.exports = { OpportunityRefreshLedger, mintRequestId };
