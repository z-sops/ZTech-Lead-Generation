'use strict';

const { EMAIL } = require('../../contracts/leadView');

/**
 * F19: evaluate whether email sending is actually possible, and report it HONESTLY.
 *
 * This is pure configuration logic. It reads no store, performs no I/O, and returns a
 * verdict plus the ONE reason it failed. The send boundary refuses on a non-sendable
 * verdict, so this function is what decides whether an email can leave the process at all.
 *
 * WHY THIS IS NOT JUST A BOOLEAN
 * The gate already answers "should this pitch be contacted?". This answers a completely
 * different question: "is this product even capable of putting a message on the wire?".
 * Conflating them is how a product ends up telling a user "sent" while nothing was
 * configured. So the verdict is always accompanied by:
 *   - a stable machine code, so the renderer can render a specific refusal, and
 *   - the provider's own `id` and whether it is `live`, so the UI can say exactly what
 *     would happen instead of gesturing at "no provider".
 *
 * THE FOUR REFUSALS, in evaluation order. Each is a distinct product state with its own
 * remediation, which is why they are separate codes rather than one boolean:
 *   EMAIL_DISABLED            sending is switched off in configuration
 *   EMAIL_PROVIDER_NOT_SET    no provider instance was supplied at all
 *   EMAIL_PROVIDER_NOT_LIVE   a provider exists but is simulated / not live (tests, doubles,
 *                             and this build's default). This is the interlock that stops a
 *                             fake provider from ever producing a believable "sent".
 *   EMAIL_FROM_MISSING        no configured from-address
 *   EMAIL_FROM_INVALID        the from-address is not a single valid address
 *
 * A `canSend: true` verdict still promises NOTHING about delivery. It means only that the
 * send boundary is permitted to call a live provider.
 */
const SEND_REFUSALS = Object.freeze({
  DISABLED: 'EMAIL_DISABLED',
  NO_PROVIDER: 'EMAIL_PROVIDER_NOT_SET',
  NOT_LIVE: 'EMAIL_PROVIDER_NOT_LIVE',
  FROM_MISSING: 'EMAIL_FROM_MISSING',
  FROM_INVALID: 'EMAIL_FROM_INVALID'
});

const REFUSAL_MESSAGES = Object.freeze({
  [SEND_REFUSALS.DISABLED]: 'Email sending is switched off in this build.',
  [SEND_REFUSALS.NO_PROVIDER]: 'No email provider is configured.',
  [SEND_REFUSALS.NOT_LIVE]: 'The configured email provider cannot deliver real mail.',
  [SEND_REFUSALS.FROM_MISSING]: 'No from-address is configured, so there is nothing to send as.',
  [SEND_REFUSALS.FROM_INVALID]: 'The configured from-address is not a valid email address.'
});

/**
 * A from-address must be ONE syntactically valid address with no line break. The same rules
 * the message validator applies, so a from-address that passes here cannot fail later for a
 * different reason. This never contacts anything and never sends.
 */
function checkFromAddress(fromAddress) {
  if (typeof fromAddress !== 'string' || fromAddress.trim().length === 0) {
    return { ok: false, code: SEND_REFUSALS.FROM_MISSING };
  }
  const value = fromAddress.trim();
  if (/[\r\n]/.test(value) || !EMAIL.test(value)) {
    return { ok: false, code: SEND_REFUSALS.FROM_INVALID };
  }
  return { ok: true, value };
}

/**
 * @param {{enabled?: boolean, provider?: object|null, fromAddress?: string|null}} input
 * @returns {{canSend: boolean, code: string|null, message: string|null,
 *            providerId: string|null, providerLive: boolean}}
 */
function evaluateSendCapability({ enabled = false, provider = null, fromAddress = null } = {}) {
  const providerId = provider && typeof provider.id === 'string' && provider.id ? provider.id : null;
  const providerLive = Boolean(provider && provider.live === true);

  // Refuse in a fixed order so the reported reason is deterministic and is the FIRST
  // problem a person must fix, rather than whichever check happened to run first.
  if (enabled !== true) return refuse(SEND_REFUSALS.DISABLED, providerId, providerLive);
  if (!provider || typeof provider.send !== 'function') return refuse(SEND_REFUSALS.NO_PROVIDER, providerId, providerLive);
  // The interlock. A simulated provider is refused BEFORE the from-address is even
  // considered, so the message can never be "your from-address is wrong" when the real
  // problem is that nothing can deliver.
  if (!providerLive) return refuse(SEND_REFUSALS.NOT_LIVE, providerId, providerLive);
  const from = checkFromAddress(fromAddress);
  if (!from.ok) return refuse(from.code, providerId, providerLive);

  return { canSend: true, code: null, message: null, providerId, providerLive, fromAddress: from.value };
}

function refuse(code, providerId, providerLive) {
  return { canSend: false, code, message: REFUSAL_MESSAGES[code], providerId, providerLive };
}

module.exports = { evaluateSendCapability, checkFromAddress, SEND_REFUSALS, REFUSAL_MESSAGES };