'use strict';

/**
 * F26.6 Microsoft 365 mailbox transport - IDENTITY AND INTERFACE ONLY (Step 1B deferred).
 *
 * Until a real Microsoft 365 mailbox test proves MIME List-Unsubscribe survival, an
 * authoritative sent-message identifier with a read-back path, reply headers, the narrowest
 * read scope and tenant/admin consent behaviour, this class claims NOTHING:
 *
 *   status MAILBOX_PROVIDER_UNVERIFIED, canConnect/canSend/canSyncReplies = false,
 *   unsubscribeHeaderSupport = 'unknown'.
 *
 * It deliberately declares no transportPolicy, so TrustPolicy applies the strict default, and it
 * is not `live`, so the send boundary's capability check refuses it before any trust check. Its
 * methods refuse without touching the network. Mail.ReadWrite is never requested as a workaround.
 */

const { EmailProvider } = require('../../outreach/email/EmailProvider');
const { LiError } = require('../../core/errors');
const { PROVIDER_CAPABILITY, PROVIDER_NOTICE } = require('../mailboxContract');

const CODE = PROVIDER_CAPABILITY.microsoft365.code;

class GraphMailboxTransport extends EmailProvider {
  get id() { return 'microsoft365'; }
  get live() { return false; }
  get capability() { return PROVIDER_CAPABILITY.microsoft365; }

  validate() { return { valid: false, errors: [{ field: 'provider', message: PROVIDER_NOTICE.microsoft365 }] }; }
  async connect() { throw new LiError(CODE, PROVIDER_NOTICE.microsoft365); }
  async send() { throw new LiError(CODE, PROVIDER_NOTICE.microsoft365); }
  async syncReplies() { throw new LiError(CODE, PROVIDER_NOTICE.microsoft365); }
  async getStatus(messageId) { return { messageId, status: 'unknown' }; }
}

module.exports = { GraphMailboxTransport };
