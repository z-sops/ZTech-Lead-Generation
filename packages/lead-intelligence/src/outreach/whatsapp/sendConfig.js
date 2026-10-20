'use strict';

const { E164, toE164 } = require('../../contracts/leadView');

/**
 * F20: evaluate whether WhatsApp sending is actually possible, and report it HONESTLY.
 *
 * This is pure configuration logic. It reads no store, performs no I/O, and returns a
 * verdict plus the ONE reason it failed. The send boundary refuses on a non-sendable
 * verdict, so this function is what decides whether a WhatsApp message can leave the
 * process at all.
 *
 * WHY THIS IS NOT JUST A BOOLEAN
 * The gate already answers "should this pitch be contacted?". This answers a completely
 * different question: "is this product even capable of putting a WhatsApp message on the wire?".
 * Conflating them is how a product ends up telling a user "sent" while nothing was
 * configured. So the verdict is always accompanied by:
 *   - a stable machine code, so the renderer can render a specific refusal, and
 *   - the provider's own `id` and whether it is `live`, so the UI can say exactly what
 *     would happen instead of gesturing at "no provider".
 *
 * THE FOUR REFUSALS, in evaluation order. Each is a distinct product state with its own
 * remediation, which is why they are separate codes rather than one boolean:
 *   WHATSAPP_DISABLED         sending is switched off in configuration
 *   WHATSAPP_PROVIDER_NOT_SET no provider instance was supplied at all
 *   WHATSAPP_PROVIDER_NOT_LIVE a provider exists but is simulated / not live (tests, doubles,
 *                              and this build's default). This is the interlock that stops a
 *                              fake provider from ever producing a believable "sent".
 *   WHATSAPP_FROM_MISSING     no configured from-address (sender phone number)
 *   WHATSAPP_FROM_INVALID     the from-address is not a valid E.164 number
 *
 * A `canSend: true` verdict still promises NOTHING about delivery. It means only that the
 * send boundary is permitted to call a live provider.
 */

const SEND_REFUSALS = Object.freeze({
  DISABLED: 'WHATSAPP_DISABLED',
  NO_PROVIDER: 'WHATSAPP_PROVIDER_NOT_SET',
  NOT_LIVE: 'WHATSAPP_PROVIDER_NOT_LIVE',
  FROM_MISSING: 'WHATSAPP_FROM_MISSING',
  FROM_INVALID: 'WHATSAPP_FROM_INVALID'
});

const REFUSAL_MESSAGES = Object.freeze({
  [SEND_REFUSALS.DISABLED]: 'WhatsApp sending is switched off in this build.',
  [SEND_REFUSALS.NO_PROVIDER]: 'No WhatsApp provider is configured.',
  [SEND_REFUSALS.NOT_LIVE]: 'The configured WhatsApp provider cannot deliver real messages.',
  [SEND_REFUSALS.FROM_MISSING]: 'No from-number is configured, so there is nothing to send as.',
  [SEND_REFUSALS.FROM_INVALID]: 'The configured from-number is not a valid E.164 phone number. Use international format, e.g. +923001234567.'
});

/**
 * A from-number must be ONE syntactically valid E.164 address with no line break.
 *
 * The configured value is NORMALISED through toE164() rather than merely trimmed, because a
 * catalogue-shaped value like "+92 300 1111111" is a normal thing for a human to configure and
 * it must not fail for formatting alone. The normalised form is what is returned, so the number
 * the capability approved is byte-for-byte the number the boundary later sends: there is no
 * second parse between the check and the wire, and therefore no way for them to disagree.
 *
 * This never contacts anything and never sends.
 */
function checkFromNumber(fromNumber) {
  if (typeof fromNumber !== 'string' || fromNumber.trim().length === 0) {
    return { ok: false, code: SEND_REFUSALS.FROM_MISSING };
  }
  if (/[\r\n]/.test(fromNumber)) return { ok: false, code: SEND_REFUSALS.FROM_INVALID };
  // A TRUNK PREFIX IS NEVER GUESSED. Writing "+44 (0)20 ..." is a national convention for
  // dropping the trunk zero, but stripping it here would quietly produce +4402071234567 - a
  // DIFFERENT, wrong number - and a wrong number is indistinguishable from a delivered
  // message. So this shape is refused outright and the human is asked to write the number in
  // international form instead.
  if (/\(\s*0\s*\)/.test(fromNumber)) return { ok: false, code: SEND_REFUSALS.FROM_INVALID };
  const value = toE164(fromNumber);
  if (!value || !E164.test(value)) return { ok: false, code: SEND_REFUSALS.FROM_INVALID };
  return { ok: true, value };
}

/**
 * Pure, side-effect-free capability evaluator. Returns:
 *   canSend: boolean
 *   code: string|null (one of SEND_REFUSALS if not canSend)
 *   message: string|null (human-readable explanation)
 *   providerId: string|null
 *   providerLive: boolean
 *   fromNumber: string|null - the NORMALISED configured sender number, and ONLY ever on a
 *     canSend verdict. The send boundary needs the exact string the capability approved, so
 *     it is carried here rather than re-derived from config: a number that was trimmed and
 *     pattern-checked here is the same number that goes on the wire, with no second parse.
 */
function evaluateSendCapability({ enabled, provider, fromNumber }) {
  if (enabled !== true) {
    return { canSend: false, code: SEND_REFUSALS.DISABLED, message: REFUSAL_MESSAGES[SEND_REFUSALS.DISABLED], providerId: null, providerLive: false, fromNumber: null };
  }
  if (!provider) {
    return { canSend: false, code: SEND_REFUSALS.NO_PROVIDER, message: REFUSAL_MESSAGES[SEND_REFUSALS.NO_PROVIDER], providerId: null, providerLive: false, fromNumber: null };
  }
  if (provider.live !== true) {
    const id = (typeof provider.id === 'function' ? provider.id() : provider.id) || 'unknown';
    return { canSend: false, code: SEND_REFUSALS.NOT_LIVE, message: REFUSAL_MESSAGES[SEND_REFUSALS.NOT_LIVE], providerId: String(id), providerLive: false, fromNumber: null };
  }
  const fromCheck = checkFromNumber(fromNumber);
  if (!fromCheck.ok) {
    const id = (typeof provider.id === 'function' ? provider.id() : provider.id) || 'unknown';
    return { canSend: false, code: fromCheck.code, message: REFUSAL_MESSAGES[fromCheck.code], providerId: String(id), providerLive: true, fromNumber: null };
  }
  const id = (typeof provider.id === 'function' ? provider.id() : provider.id) || 'unknown';
  return { canSend: true, code: null, message: null, providerId: String(id), providerLive: true, fromNumber: fromCheck.value };
}

module.exports = { evaluateSendCapability, SEND_REFUSALS, REFUSAL_MESSAGES, checkFromNumber };