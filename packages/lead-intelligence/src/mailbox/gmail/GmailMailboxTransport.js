'use strict';

/**
 * F26.6 Gmail / Google Workspace mailbox transport. MAIN PROCESS ONLY.
 *
 * Verified live in Step 1A (7 Oct 2026, a real cross-mailbox test): gmail.send sends a raw
 * message with List-Unsubscribe, mailto + HTTPS, and List-Unsubscribe-Post intact; gmail.metadata
 * reads the stored copy back; Gmail REPLACES a client-supplied Message-ID; and a real reply's
 * In-Reply-To / References cite the STORED id. So this transport:
 *   - never supplies a Message-ID;
 *   - after every send reads the stored message back and returns its Message-ID, which the
 *     send boundary persists and reply matching uses;
 *   - declares its transport policy: no Resend-style prior-relationship rule (one human click
 *     from the user's own mailbox), and unsubscribe headers are mandatory.
 * A transport policy describes the transport only: the market gate and every trust check still
 * decide whether this person may be contacted.
 */

const { EmailProvider, validateEmailMessage } = require('../../outreach/email/EmailProvider');
const { LiError } = require('../../core/errors');
const { buildRawMessage, toBase64Url } = require('./rfc2822');

const READBACK_HEADERS = Object.freeze(['Message-ID', 'List-Unsubscribe', 'List-Unsubscribe-Post']);
const STORED_ID_RE = /^<[^<>\s]{3,298}>$/;

class GmailMailboxTransport extends EmailProvider {
  /** @param {{api: import('./GmailApi').GmailApi, mailbox: {mailbox_id: string, email_address: string}}} deps */
  constructor({ api, mailbox } = {}) {
    super();
    if (!api || !mailbox) throw new TypeError('GmailMailboxTransport needs an api and a mailbox');
    this.api = api;
    this.mailbox = mailbox;
  }

  get id() { return 'gmail'; }
  get live() { return true; }
  get transportPolicy() { return Object.freeze({ requiresPriorRelationship: false, enforcesUnsubscribeHeaders: true }); }

  validate(message) {
    const v = validateEmailMessage(message);
    const errors = [...v.errors];
    if (message && typeof message.from === 'string' && message.from.trim().toLowerCase() !== this.mailbox.email_address) {
      errors.push({ field: 'from', message: 'must be the connected mailbox address' });
    }
    if (!message || !message.headers || !message.headers['List-Unsubscribe']) errors.push({ field: 'headers.List-Unsubscribe', message: 'is required' });
    // F28: a threaded follow-up names its Gmail thread and the STORED ids it answers.
    if (message && message.thread !== undefined) {
      const t = message.thread;
      const refs = t && Array.isArray(t.references) ? t.references : [];
      if (!t || typeof t.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(t.threadId)) errors.push({ field: 'thread.threadId', message: 'is not a Gmail thread id' });
      if (!t || !STORED_ID_RE.test(String(t.inReplyTo || '')) || !refs.length || refs.length > 10 || !refs.every((x) => STORED_ID_RE.test(String(x))) || refs[refs.length - 1] !== t.inReplyTo) {
        errors.push({ field: 'thread.references', message: 'must be stored Message-IDs ending with In-Reply-To' });
      }
    }
    return { valid: errors.length === 0, errors };
  }

  /** One message. Returns Gmail's own ids; the caller reads the stored copy back next. */
  async send(message) {
    const v = this.validate(message);
    if (!v.valid) throw new LiError('VALIDATION_FAILED', 'The email message is invalid.');
    const thread = message.thread ? { inReplyTo: message.thread.inReplyTo, references: message.thread.references } : undefined;
    const raw = buildRawMessage({ from: this.mailbox.email_address, fromName: message.fromName, to: message.to, subject: message.subject, text: message.text, headers: message.headers, thread });
    const r = await this.api.sendRaw(toBase64Url(raw), { threadId: message.thread ? message.thread.threadId : null });
    return { messageId: r.id, threadId: r.threadId, status: null };
  }

  /**
   * Read the STORED sent message back (headers only). Returns the authoritative Message-ID (or
   * null when Gmail shows none) and whether the unsubscribe headers survived.
   */
  async readBack(gmailMessageId, { expectListUnsubscribe = null } = {}) {
    const m = await this.api.metadata(gmailMessageId, READBACK_HEADERS);
    const stored = (m.headers['message-id'] || '').trim();
    const lu = (m.headers['list-unsubscribe'] || '').replace(/\s+/g, ' ').trim();
    return {
      storedMessageId: STORED_ID_RE.test(stored) ? stored : null,
      threadId: m.threadId,
      listUnsubscribeKept: Boolean(lu) && (expectListUnsubscribe === null || lu === expectListUnsubscribe.replace(/\s+/g, ' ').trim()),
      listUnsubscribePostKept: (m.headers['list-unsubscribe-post'] || '').trim() === 'List-Unsubscribe=One-Click',
    };
  }

  async getStatus(messageId) { return { messageId, status: 'unknown' }; }
}

module.exports = { GmailMailboxTransport, STORED_ID_RE };
