'use strict';

const { E164 } = require('../../contracts/leadView');
const { LiError } = require('../../core/errors');

/**
 * WhatsAppProvider — abstraction only. No WhatsApp Business API provider is connected
 * in this phase. A real provider implements the same methods later, after it is verified.
 *
 * interface WhatsAppProvider {
 *   id: string
 *   live: boolean   // does this provider actually reach a real WhatsApp service?
 *   validate(message): { valid: boolean, errors: {field, message}[] }
 *   send(message): Promise<{ messageId: string, status: 'queued'|'sent' }>
 *   getStatus(messageId): Promise<{ messageId, status: 'queued'|'sent'|'delivered'|'read'|'failed'|'unknown' }>
 * }
 *
 * `live` is F20's safety interlock, identical to EmailProvider. It is FALSE on this base
 * class and on every in-memory double, so a test or simulated provider cannot be wired
 * into the send boundary by accident: evaluateSendCapability() refuses anything that is
 * not live. A real adapter must opt in deliberately, by overriding `live`, and its `id`
 * then appears in the activity ledger - so every send row names the provider that actually
 * accepted it.
 *
 * `send()` returning only `messageId` + `status` is deliberate and load-bearing: a provider
 * acknowledgement is NOT a delivery receipt. Adapters must never translate their own
 * acceptance into delivered / read / clicked, and ZTech never infers it.
 *
 * message: { to, from, body, headers? } — plain text only (no template rendering).
 */

function validateWhatsAppMessage(m) {
  const errors = [];
  const bad = (field, message) => errors.push({ field, message });
  if (!m || typeof m !== 'object') return { valid: false, errors: [{ field: 'message', message: 'is required' }] };
  for (const f of ['to', 'from', 'body']) if (typeof m[f] !== 'string' || !m[f].trim()) bad(f, 'is required');
  for (const f of ['to', 'from']) {
    if (typeof m[f] === 'string' && /[\r\n]/.test(m[f])) bad(f, 'must not contain line breaks');
  }
  if (typeof m.to === 'string' && !E164.test(m.to.trim())) bad('to', 'is not a valid E.164 phone number');
  if (typeof m.from === 'string' && !E164.test(m.from.trim())) bad('from', 'is not a valid E.164 phone number');
  if (typeof m.body === 'string' && m.body.length > 4096) bad('body', 'exceeds WhatsApp 4096 character limit');
  return { valid: errors.length === 0, errors };
}

class WhatsAppProvider {
  /** F20: false by default, so nothing becomes sendable without an explicit override. */
  get id() { return 'abstract'; }
  get live() { return false; }
  validate(message) { return validateWhatsAppMessage(message); }
  async send() { throw new LiError('WHATSAPP_PROVIDER_NOT_CONFIGURED', 'No WhatsApp provider is configured'); }
  async getStatus(messageId) { return { messageId, status: 'unknown' }; }
}

module.exports = { WhatsAppProvider, validateWhatsAppMessage };