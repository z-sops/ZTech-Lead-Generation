'use strict';

const { EMAIL } = require('../../contracts/leadView');
const { LiError } = require('../../core/errors');

/**
 * EmailProvider — abstraction only. No Gmail/SMTP/API provider is connected in this
 * phase. A real provider implements the same three methods later, after it is verified.
 *
 * interface EmailProvider {
 *   id: string
 *   live: boolean   // does this provider actually reach a real mail service?
 *   validate(message): { valid: boolean, errors: {field, message}[] }
 *   send(message): Promise<{ messageId: string, status: 'queued'|'sent' }>
 *   getStatus(messageId): Promise<{ messageId, status: 'queued'|'sent'|'delivered'|'bounced'|'failed'|'unknown' }>
 * }
 *
 * `live` is F19's safety interlock. It is FALSE on this base class and on every in-memory
 * double, so a test or simulated provider cannot be wired into the send boundary by
 * accident: evaluateSendCapability() refuses anything that is not live. A real adapter must
 * opt in deliberately, by overriding `live`, and its `id` then appears in the activity
 * ledger - so every send row names the provider that actually accepted it.
 *
 * `send()` returning only `messageId` + `status` is deliberate and load-bearing: a provider
 * acknowledgement is NOT a delivery receipt. Adapters must never translate their own
 * acceptance into delivered / opened / clicked, and ZTech never infers it.
 *
 * message: { to, from, subject, text, headers? }  — plain text only (no HTML rendering).
 */

function validateEmailMessage(m) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  if (!m || typeof m !== 'object') return { valid: false, errors: [{ field: 'message', message: 'is required' }] };
  for (const f of ['to', 'from', 'subject', 'text']) if (typeof m[f] !== 'string' || !m[f].trim()) bad(f, 'is required');
  for (const f of ['to', 'from', 'subject']) {
    if (typeof m[f] === 'string' && /[\r\n]/.test(m[f])) bad(f, 'must not contain line breaks');
  }
  if (typeof m.to === 'string' && !EMAIL.test(m.to.trim())) bad('to', 'is not a valid single email address');
  if (typeof m.from === 'string' && !EMAIL.test(m.from.trim())) bad('from', 'is not a valid email address');
  if (typeof m.subject === 'string' && m.subject.length > 200) bad('subject', 'is too long');
  if (typeof m.text === 'string' && m.text.length > 20000) bad('text', 'is too long');
  if (m.html !== undefined) bad('html', 'HTML email is not supported');
  if (m.headers !== undefined) {
    if (!m.headers || typeof m.headers !== 'object' || Array.isArray(m.headers)) bad('headers', 'must be an object');
    else {
      for (const [k, v] of Object.entries(m.headers)) {
        if (!/^X-[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 200) bad(`headers.${k}`, 'only simple X- headers are allowed');
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

class EmailProvider {
  get id() { return 'abstract'; }
  /** F19: false by default, so nothing becomes sendable without an explicit override. */
  get live() { return false; }
  validate(message) { return validateEmailMessage(message); }
  async send() { throw new LiError('EMAIL_PROVIDER_NOT_CONFIGURED', 'No email provider is configured'); }
  async getStatus(messageId) { return { messageId, status: 'unknown' }; }
}

module.exports = { EmailProvider, validateEmailMessage };
