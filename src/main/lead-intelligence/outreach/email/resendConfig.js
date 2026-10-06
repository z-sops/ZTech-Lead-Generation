'use strict';

const { EMAIL } = require('../../contracts/leadView');
// NB: the vault module exports its API directly (there is no `credentialVault` property on
// it), so it must NOT be destructured here. Destructuring yields `undefined`, which would
// make every `reveal()` call throw and silently report a perfectly good stored key as
// unreadable - capability unavailable for a configuration that is actually complete.
const credentialVault = require('../../../credentialVault');

/**
 * F22: PROVIDER CONFIGURATION FOUNDATION - the authoritative, minimal Resend
 * configuration layer.
 *
 * WHAT THIS MODULE IS
 *   - a SAFE CONFIGURATION PARSER: `readResendConfig(store)` reads the main-process
 *     configuration source (the electron-store instance that already owns provider
 *     credentials) and returns a bounded, non-secret configuration snapshot.
 *   - a CAPABILITY RESOLVER: `evaluateResendCapability(config)` turns that snapshot into
 *     one stable, factual verdict - `canSend` plus a stable `code`/`message` reason.
 *
 * WHAT THIS MODULE IS NOT
 *   - It performs NO outbound communication of any kind. There is no fetch, no HTTP
 *     client, no SDK import and no provider construction here. A `canSend: true` verdict
 *     promises only that the CONFIGURATION is structurally complete; it sends nothing and
 *     contacts nobody.
 *   - It has NO write path. F22 deliberately adds no configuration writer: credentials
 *     already reach the store through the existing provider credential path, and this
 *     module never mutates anything. `readResendConfig` is a pure read of its argument.
 *   - It NEVER returns a secret. The API key is read only to answer two boolean
 *     questions - "is one stored?" and "can it be read back?" - and is discarded. Neither
 *     the key, nor an Authorization header, nor a Bearer token, nor the configuration
 *     object it came from is ever placed on the returned snapshot.
 *   - It stores nothing in whatsapp.db. The whole model lives in the main-process
 *     configuration source, so no schema and no migration is required.
 *
 * DOMAIN / SENDER HONESTY
 *   Nothing here is hard-coded as configured, verified or existing. A domain that has
 *   not been configured reads back as not configured; a configured domain that has not
 *   been marked verified reads back as `unknown`/`pending`/`failed`, never `verified`.
 *   `zunitechai.com` (or any other domain) is therefore never claimed to be owned,
 *   verified, or to have a sender mailbox that exists - the configuration has to say so.
 */

const PROVIDER_ID = 'resend';
const PROVIDER_DISPLAY = 'Resend';

/** Stable refusal codes. They are a closed vocabulary: a caller may switch on them. */
const RESEND_REFUSALS = Object.freeze({
  PROVIDER_NOT_SELECTED: 'EMAIL_PROVIDER_NOT_SELECTED',
  CREDENTIAL_MISSING: 'EMAIL_CREDENTIAL_MISSING',
  CREDENTIAL_INVALID: 'EMAIL_CREDENTIAL_INVALID',
  SENDER_MISSING: 'EMAIL_SENDER_MISSING',
  SENDER_INVALID: 'EMAIL_SENDER_INVALID',
  DOMAIN_NOT_CONFIGURED: 'EMAIL_DOMAIN_NOT_CONFIGURED',
  DOMAIN_NOT_VERIFIED: 'EMAIL_DOMAIN_NOT_VERIFIED',
  DOMAIN_VERIFICATION_FAILED: 'EMAIL_DOMAIN_VERIFICATION_FAILED',
  // F23: a reply-to address is part of the sender profile. If it is present but not a
  // single valid address the configuration is structurally incomplete, so capability
  // fails closed here rather than letting a malformed header reach a provider.
  REPLYTO_INVALID: 'EMAIL_REPLYTO_INVALID',
});

const RESEND_REFUSAL_MESSAGES = Object.freeze({
  [RESEND_REFUSALS.PROVIDER_NOT_SELECTED]: 'No email provider is selected.',
  [RESEND_REFUSALS.CREDENTIAL_MISSING]: 'No email provider API key is configured.',
  [RESEND_REFUSALS.CREDENTIAL_INVALID]: 'The configured email provider API key could not be read back.',
  [RESEND_REFUSALS.SENDER_MISSING]: 'No sender address is configured.',
  [RESEND_REFUSALS.SENDER_INVALID]: 'The configured sender address is not a valid email address.',
  [RESEND_REFUSALS.DOMAIN_NOT_CONFIGURED]: 'No sending domain is configured.',
  [RESEND_REFUSALS.DOMAIN_NOT_VERIFIED]: 'The sending domain has not been verified.',
  [RESEND_REFUSALS.DOMAIN_VERIFICATION_FAILED]: 'The sending domain verification failed.',
  [RESEND_REFUSALS.REPLYTO_INVALID]: 'The configured reply-to address is not a valid email address.',
});

/** The four verification states, plus nothing. There is no fifth invented state. */
const VERIFICATION_STATUSES = Object.freeze({
  UNKNOWN: 'unknown',
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
});

const KNOWN_VERIFICATION = Object.freeze(Object.values(VERIFICATION_STATUSES));

/**
 * The empty configuration: what an unconfigured build reads back as. Every field is a
 * fact about configuration only - never about delivery, never about a remote service.
 *
 * Deliberately NOT frozen: `readResendConfig` starts from this shape and fills it in. The
 * snapshot it hands back is the frozen one.
 */
function emptyResendConfig() {
  return {
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    // Resend is the provider F22 is a foundation for, but "selected" means the
    // configuration source actually holds a Resend record - not that we hope it will.
    providerSelected: false,
    // Boolean answers only. The key itself is never carried on this object.
    keyConfigured: false,
    keyReadable: false,
    fromName: '',
    fromAddress: '',
    senderConfigured: false,
    // F23 Plug & Play sender profile - non-secret identity fields, read from the same
    // configuration source. Empty means "the customer has not configured this", which is
    // a valid supported state, never a default identity.
    replyTo: '',
    signature: '',
    domain: '',
    domainConfigured: false,
    domainVerification: VERIFICATION_STATUSES.UNKNOWN,
  };
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * SAFE CONFIGURATION PARSER.
 *
 * @param {{get: Function}|null|undefined} store the main-process configuration source.
 *        `null`/`undefined` means "there is no configuration source in this process",
 *        which is a normal, expected state in tests and in any non-Electron process.
 * @returns {object} a frozen, bounded, non-secret configuration snapshot.
 */
function readResendConfig(store) {
  const out = emptyResendConfig();
  if (!store || typeof store.get !== 'function') return Object.freeze(out);

  let settings = {};
  try {
    const raw = store.get('settings', null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) settings = raw;
  } catch { /* a store that cannot be read is treated as unconfigured, never as configured */ }

  let providers = {};
  try {
    const raw = store.get('providers', null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) providers = raw;
  } catch { /* same: unreadable is unconfigured */ }

  const record = providers[PROVIDER_ID];
  const hasRecord = Boolean(record && typeof record === 'object');
  const legacySelected = str(settings.emailProvider).toLowerCase() === PROVIDER_ID;
  out.providerSelected = hasRecord || legacySelected;

  // --- The credential: presence and readability ONLY. The value never leaves this block.
  if (hasRecord && record.credentials && typeof record.credentials === 'object') {
    const stored = record.credentials.apiKey;
    if (typeof stored === 'string' && stored.length > 0) {
      out.keyConfigured = true;
      try {
        // `reveal` returns '' for an empty value and throws for a sealed value this
        // process cannot decrypt. Either way the plaintext is dropped on the next line.
        out.keyReadable = credentialVault.reveal(stored).length > 0;
      } catch {
        out.keyReadable = false;
      }
    }
  }

  out.fromName = str(settings.emailFromName).slice(0, 120);
  out.fromAddress = str(settings.emailFromAddress);
  out.senderConfigured = out.fromAddress.length > 0;
  // F23: bounded reads of the optional sender-profile fields. They are identity text,
  // never credentials - and like everything else in this parser, no write ever happens.
  out.replyTo = str(settings.emailReplyTo).slice(0, 320);
  out.signature = str(settings.emailSignature).slice(0, 500);
  out.domain = str(settings.emailDomain).toLowerCase();
  out.domainConfigured = out.domain.length > 0;

  const verification = str(settings.emailDomainVerification).toLowerCase();
  // A verification status is a claim ABOUT a domain. With no domain configured there is
  // nothing it could verify, so a stale `emailDomainVerification: "verified"` left behind
  // after the domain was cleared must read back as "unknown" - never as verified.
  out.domainVerification = out.domainConfigured && KNOWN_VERIFICATION.includes(verification)
    ? verification
    : VERIFICATION_STATUSES.UNKNOWN;

  return Object.freeze(out);
}

/**
 * Structural syntax only: is this string a single valid address with no line break?
 * It says nothing about whether the mailbox exists.
 */
function validateEmailAddress(address) {
  if (typeof address !== 'string' || address.trim().length === 0) {
    return { ok: false, code: RESEND_REFUSALS.SENDER_MISSING };
  }
  const value = address.trim();
  if (/[\r\n]/.test(value) || !EMAIL.test(value)) {
    return { ok: false, code: RESEND_REFUSALS.SENDER_INVALID };
  }
  return { ok: true, value };
}

/**
 * Structural syntax only: is this string a plausible domain? It cannot tell you whether
 * the domain is owned, parked, or verified anywhere.
 */
function validateDomain(domain) {
  if (typeof domain !== 'string' || domain.trim().length === 0) {
    return { ok: false, code: RESEND_REFUSALS.DOMAIN_NOT_CONFIGURED };
  }
  const value = domain.trim().toLowerCase();
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) {
    return { ok: false, code: RESEND_REFUSALS.DOMAIN_NOT_CONFIGURED };
  }
  return { ok: true, value };
}

/**
 * F23 PLUG & PLAY SENDER-PROFILE VALIDATION.
 *
 * These bound what a customer may configure. They accept plain, bounded text and nothing
 * else: no control characters (header-injection shaped), no line breaks where a header
 * value will go, no executable content. They never construct an identity of their own -
 * an empty value is an honest "not configured", never a default.
 */

/** From Name: optional, 1-120 characters of plain text, no control characters. */
function validateFromName(name) {
  if (name === undefined || name === null || name === '') return { ok: true, value: '' };
  if (typeof name !== 'string') return { ok: false, code: RESEND_REFUSALS.SENDER_INVALID };
  const value = name.trim();
  if (value.length === 0 || value.length > 120) return { ok: false, code: RESEND_REFUSALS.SENDER_INVALID };
  if (/[\r\n]/.test(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    return { ok: false, code: RESEND_REFUSALS.SENDER_INVALID };
  }
  return { ok: true, value };
}

/** Reply-To: optional; empty means "do not set one". When present, one valid address. */
function validateReplyTo(address) {
  if (address === undefined || address === null || address === '') return { ok: true, value: '' };
  if (typeof address !== 'string' || /[\r\n]/.test(address) || !EMAIL.test(address.trim())) {
    return { ok: false, code: RESEND_REFUSALS.REPLYTO_INVALID };
  }
  return { ok: true, value: address.trim() };
}

/** Signature: optional, at most 500 characters, plain text with newlines only. */
function validateSignature(text) {
  if (text === undefined || text === null || text === '') return { ok: true, value: '' };
  if (typeof text !== 'string') return { ok: false };
  const value = text.replace(/\s+$/, '');
  if (value.length > 500) return { ok: false };
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(value)) return { ok: false };
  return { ok: true, value };
}

/**
 * CAPABILITY RESOLVER.
 *
 * Evaluates a configuration snapshot in a fixed order so the reported reason is always
 * the FIRST thing a person must fix, never whichever check happened to run first.
 *
 * `canSend: true` means only: the local configuration is structurally complete AND
 * marked verified. It promises NOTHING about delivery and, in this phase, causes
 * nothing to be executed - operational provider execution is F23's, not F22's.
 *
 * @param {object} config the snapshot from `readResendConfig`.
 * @returns {{canSend: boolean, code: string|null, message: string|null,
 *            providerId: string, providerDisplay: string, providerLive: boolean,
 *            fromAddress: string|null, fromName: string|null,
 *            domain: string|null, domainVerification: string}}
 */
function evaluateResendCapability(config) {
  const c = (config && typeof config === 'object') ? config : emptyResendConfig();

  if (c.providerSelected !== true) return refuse(RESEND_REFUSALS.PROVIDER_NOT_SELECTED, c);
  if (c.keyConfigured !== true) return refuse(RESEND_REFUSALS.CREDENTIAL_MISSING, c);
  if (c.keyReadable !== true) return refuse(RESEND_REFUSALS.CREDENTIAL_INVALID, c);

  const fromCheck = validateEmailAddress(c.fromAddress);
  if (!fromCheck.ok) return refuse(fromCheck.code, c);

  // F23: the display name is part of the sender profile. Present-but-malformed (line
  // breaks, control characters) is a structural fault and fails closed here rather than
  // letting header-shaped text reach a provider.
  const nameCheck = validateFromName(c.fromName);
  if (!nameCheck.ok) return refuse(RESEND_REFUSALS.SENDER_INVALID, c);

  // F23: an optional reply-to must be valid IF present. An empty reply-to is normal and
  // passes; a malformed one is a structural configuration fault and fails closed.
  const replyCheck = validateReplyTo(c.replyTo);
  if (!replyCheck.ok) return refuse(RESEND_REFUSALS.REPLYTO_INVALID, c);

  const domainCheck = validateDomain(c.domain);
  if (!domainCheck.ok) return refuse(domainCheck.code, c);

  if (c.domainVerification !== VERIFICATION_STATUSES.VERIFIED) {
    return refuse(
      c.domainVerification === VERIFICATION_STATUSES.FAILED
        ? RESEND_REFUSALS.DOMAIN_VERIFICATION_FAILED
        : RESEND_REFUSALS.DOMAIN_NOT_VERIFIED,
      c
    );
  }

  return {
    canSend: true,
    code: null,
    message: null,
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    // `providerLive` describes the CONFIGURATION verdict shape only. It is not a claim
    // that a live transport exists in this phase; F22 never constructs one.
    providerLive: true,
    fromAddress: fromCheck.value,
    fromName: str(c.fromName) || null,
    domain: domainCheck.value,
    domainVerification: VERIFICATION_STATUSES.VERIFIED,
  };
}

function refuse(code, config) {
  const c = (config && typeof config === 'object') ? config : emptyResendConfig();
  return {
    canSend: false,
    code,
    message: RESEND_REFUSAL_MESSAGES[code] || null,
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    providerLive: false,
    fromAddress: str(c.fromAddress) || null,
    fromName: str(c.fromName) || null,
    domain: str(c.domain) || null,
    domainVerification: KNOWN_VERIFICATION.includes(c.domainVerification)
      ? c.domainVerification
      : VERIFICATION_STATUSES.UNKNOWN,
  };
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_DISPLAY,
  RESEND_REFUSALS,
  RESEND_REFUSAL_MESSAGES,
  VERIFICATION_STATUSES,
  emptyResendConfig,
  readResendConfig,
  evaluateResendCapability,
  validateEmailAddress,
  validateDomain,
  validateFromName,
  validateReplyTo,
  validateSignature,
};
