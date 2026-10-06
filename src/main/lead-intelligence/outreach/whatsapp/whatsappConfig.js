'use strict';

const { checkFromNumber } = require('./sendConfig');
// NB: the vault module exports its API directly (there is no `credentialVault` property on
// it), so it must NOT be destructured here - same rule as resendConfig.js. Destructuring
// yields `undefined`, which would make every `reveal()` call throw and silently report a
// perfectly good stored token as unreadable.
const credentialVault = require('../../../credentialVault');

/**
 * F24: WHATSAPP PROVIDER CONFIGURATION FOUNDATION - the authoritative, minimal WhatsApp
 * configuration layer, mirroring the F22/F23 email (resendConfig) architecture exactly.
 *
 * WHAT THIS MODULE IS
 *   - a SAFE CONFIGURATION PARSER: `readWhatsAppConfig(store)` reads the main-process
 *     configuration source (the electron-store instance that already owns provider
 *     credentials) and returns a bounded, non-secret configuration snapshot.
 *   - a CAPABILITY RESOLVER: `evaluateWhatsAppConfig(config)` turns that snapshot into
 *     one stable, factual verdict - `canSend` plus a stable `code`/`message` reason.
 *
 * WHAT THIS MODULE IS NOT
 *   - It performs NO outbound communication of any kind. No fetch, no HTTP client, no SDK
 *     import and no provider construction here. A `canSend: true` verdict promises only
 *     that the CONFIGURATION is structurally complete; it sends nothing and contacts
 *     nobody, and - like the email resolver - it says nothing about whether a provider
 *     instance exists or whether sending is enabled (those are the send boundary's own
 *     earlier checks).
 *   - It has NO write path. This module never mutates anything; `readWhatsAppConfig` is a
 *     pure read of its argument, so no schema and no migration is required.
 *   - It NEVER returns a secret. The access token is read only to answer two boolean
 *     questions - "is one stored?" and "can it be read back?" - and is discarded. Neither
 *     the token, nor an Authorization header, nor a Bearer value, nor the configuration
 *     record it came from is ever placed on the returned snapshot. The booleans are named
 *     `keyConfigured`/`keyReadable` deliberately, because the IPC scrub drops any key
 *     matching /credential|token|bearer/i as a last line of defence and this payload
 *     leans on that control instead of fighting it.
 *
 * LEAD NUMBER VS SENDING NUMBER - TWO SEPARATE FACTS
 *   `fromNumber` here is OUR connected WhatsApp Business SENDING number, read from
 *   settings. A stored lead's phone number is the recipient candidate (F17) and lives
 *   somewhere else entirely. Neither fact proves anything about the other, and nothing
 *   here ever reads, writes or claims anything about a lead.
 *
 * HONESTY
 *   Nothing is hard-coded as configured, verified or existing. No provider is "selected"
 *   until the settings say so; a number reads back as `unknown`/`pending`/`failed` unless
 *   the configuration says `verified`; an account reads back as missing until BOTH the
 *   phone-number id and the business account id are present. There is no fallback
 *   identity, no default number and no invented verification.
 */

/**
 * The ONE supported provider strategy for F24: the official Meta WhatsApp Cloud API.
 * The provider CHOICE is configuration (`settings.whatsappProvider`); this module only
 * reports whether the chosen value names a provider this build actually implements. No
 * second adapter exists - replaceability lives behind the WhatsAppProvider interface.
 */
const PROVIDER_ID = 'meta-cloud';
const PROVIDER_DISPLAY = 'WhatsApp Cloud API';
const KNOWN_PROVIDERS = Object.freeze([PROVIDER_ID]);

/** Stable refusal codes. They are a closed vocabulary: a caller may switch on them. */
const WHATSAPP_REFUSALS = Object.freeze({
  PROVIDER_NOT_SELECTED: 'WHATSAPP_PROVIDER_NOT_SELECTED',
  CREDENTIAL_MISSING: 'WHATSAPP_CREDENTIAL_MISSING',
  CREDENTIAL_INVALID: 'WHATSAPP_CREDENTIAL_INVALID',
  ACCOUNT_MISSING: 'WHATSAPP_ACCOUNT_MISSING',
  SENDER_NUMBER_MISSING: 'WHATSAPP_SENDER_NUMBER_MISSING',
  SENDER_NUMBER_INVALID: 'WHATSAPP_SENDER_NUMBER_INVALID',
  NUMBER_NOT_VERIFIED: 'WHATSAPP_NUMBER_NOT_VERIFIED',
  NUMBER_VERIFICATION_FAILED: 'WHATSAPP_NUMBER_VERIFICATION_FAILED',
});

const WHATSAPP_REFUSAL_MESSAGES = Object.freeze({
  [WHATSAPP_REFUSALS.PROVIDER_NOT_SELECTED]: 'No WhatsApp provider is selected.',
  [WHATSAPP_REFUSALS.CREDENTIAL_MISSING]: 'No WhatsApp provider access token is configured.',
  [WHATSAPP_REFUSALS.CREDENTIAL_INVALID]: 'The configured WhatsApp provider access token could not be read back.',
  [WHATSAPP_REFUSALS.ACCOUNT_MISSING]: 'No WhatsApp Business account is configured (phone-number id and business account id are both required).',
  [WHATSAPP_REFUSALS.SENDER_NUMBER_MISSING]: 'No WhatsApp sending number is configured.',
  [WHATSAPP_REFUSALS.SENDER_NUMBER_INVALID]: 'The configured WhatsApp sending number is not a valid E.164 phone number. Use international format, e.g. +923001234567.',
  [WHATSAPP_REFUSALS.NUMBER_NOT_VERIFIED]: 'The configured WhatsApp sending number has not been verified.',
  [WHATSAPP_REFUSALS.NUMBER_VERIFICATION_FAILED]: 'The configured WhatsApp sending number verification failed.',
});

/** The four number-verification states, plus nothing. There is no fifth invented state. */
const NUMBER_VERIFICATION_STATUSES = Object.freeze({
  UNKNOWN: 'unknown',
  PENDING: 'pending',
  VERIFIED: 'verified',
  FAILED: 'failed',
});

const KNOWN_VERIFICATION = Object.freeze(Object.values(NUMBER_VERIFICATION_STATUSES));

/**
 * The empty configuration: what an unconfigured build reads back as. Every field is a
 * fact about configuration only - never about delivery, never about a remote service,
 * never about a lead.
 *
 * Deliberately NOT frozen: `readWhatsAppConfig` starts from this shape and fills it in.
 * The snapshot it hands back is the frozen one.
 */
function emptyWhatsAppConfig() {
  return {
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    // "selected" means the configuration source actually names this supported provider -
    // not that we hope it will.
    providerSelected: false,
    // Boolean answers only. The token itself is never carried on this object.
    keyConfigured: false,
    keyReadable: false,
    // The connected WhatsApp Business account facts (identifiers, not credentials).
    phoneNumberId: '',
    businessAccountId: '',
    accountConfigured: false,
    // OUR sending number, never a lead's number.
    fromNumber: '',
    senderConfigured: false,
    numberVerification: NUMBER_VERIFICATION_STATUSES.UNKNOWN,
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
function readWhatsAppConfig(store) {
  const out = emptyWhatsAppConfig();
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

  // Provider selection is CONFIGURATION: the settings must name a provider this build
  // actually implements. An unknown id is not "selected" - it is unsupported, which the
  // resolver reports honestly as nothing selected rather than pretending to support it.
  const selected = str(settings.whatsappProvider).toLowerCase();
  out.providerSelected = KNOWN_PROVIDERS.includes(selected);

  // --- The credential: presence and readability ONLY. The value never leaves this block.
  const record = providers[PROVIDER_ID];
  if (record && typeof record === 'object' && record.credentials && typeof record.credentials === 'object') {
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

  // --- The connected account: BOTH identifiers are required. Identifiers, never secrets.
  out.phoneNumberId = str(settings.whatsappPhoneNumberId).slice(0, 120);
  out.businessAccountId = str(settings.whatsappBusinessAccountId).slice(0, 120);
  out.accountConfigured = out.phoneNumberId.length > 0 && out.businessAccountId.length > 0;

  // --- OUR sending number. The raw configured value is kept (bounded); its E.164
  // validation happens in the resolver, so "absent" and "present but malformed" remain
  // distinguishable facts with distinct refusal codes - exactly like the email parser.
  out.fromNumber = str(settings.whatsappFromNumber);
  out.senderConfigured = out.fromNumber.length > 0;

  // A verification status is a claim ABOUT the configured sending number. With no number
  // configured there is nothing it could verify, so a stale
  // `whatsappNumberVerification: "verified"` left behind after the number was cleared
  // must read back as "unknown" - never as verified.
  const verification = str(settings.whatsappNumberVerification).toLowerCase();
  out.numberVerification = out.senderConfigured && KNOWN_VERIFICATION.includes(verification)
    ? verification
    : NUMBER_VERIFICATION_STATUSES.UNKNOWN;

  return Object.freeze(out);
}

/**
 * CAPABILITY RESOLVER.
 *
 * Evaluates a configuration snapshot in a fixed order so the reported reason is always
 * the FIRST thing a person must fix, never whichever check happened to run first:
 *
 *   1. provider selected      WHATSAPP_PROVIDER_NOT_SELECTED
 *   2. credential configured  WHATSAPP_CREDENTIAL_MISSING / WHATSAPP_CREDENTIAL_INVALID
 *   3. account configured     WHATSAPP_ACCOUNT_MISSING
 *   4. sending number set     WHATSAPP_SENDER_NUMBER_MISSING / _INVALID
 *   5. number verified        WHATSAPP_NUMBER_NOT_VERIFIED / _FAILED
 *
 * `canSend: true` means only: the local configuration is structurally complete AND marked
 * verified. It promises NOTHING about delivery, causes nothing to be executed here, and
 * (like the email resolver) does not check the enabled switch or a provider instance -
 * those remain the send boundary's earlier, separate checks. Test F of the F24 matrix is
 * satisfied by a snapshot with all five facts configured.
 *
 * @param {object} config the snapshot from `readWhatsAppConfig`.
 * @returns {{canSend: boolean, code: string|null, message: string|null,
 *            providerId: string, providerDisplay: string, providerLive: boolean,
 *            fromNumber: string|null, numberVerification: string}}
 */
function evaluateWhatsAppConfig(config) {
  const c = (config && typeof config === 'object') ? config : emptyWhatsAppConfig();

  if (c.providerSelected !== true) return refuse(WHATSAPP_REFUSALS.PROVIDER_NOT_SELECTED, c);
  if (c.keyConfigured !== true) return refuse(WHATSAPP_REFUSALS.CREDENTIAL_MISSING, c);
  if (c.keyReadable !== true) return refuse(WHATSAPP_REFUSALS.CREDENTIAL_INVALID, c);
  if (c.accountConfigured !== true) return refuse(WHATSAPP_REFUSALS.ACCOUNT_MISSING, c);
  if (c.senderConfigured !== true) return refuse(WHATSAPP_REFUSALS.SENDER_NUMBER_MISSING, c);
  // Structural syntax only: one valid E.164 number, no line break, no guessed trunk
  // prefix. The NORMALISED number travels with the verdict so the boundary cannot
  // re-parse a different string than the one that was checked.
  const number = checkFromNumber(c.fromNumber);
  if (!number.ok) return refuse(WHATSAPP_REFUSALS.SENDER_NUMBER_INVALID, c);
  if (c.numberVerification !== NUMBER_VERIFICATION_STATUSES.VERIFIED) {
    return refuse(
      c.numberVerification === NUMBER_VERIFICATION_STATUSES.FAILED
        ? WHATSAPP_REFUSALS.NUMBER_VERIFICATION_FAILED
        : WHATSAPP_REFUSALS.NUMBER_NOT_VERIFIED,
      c
    );
  }

  return {
    canSend: true,
    code: null,
    message: null,
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    // `providerLive` describes the CONFIGURATION verdict shape only - the same convention
    // as the email resolver. It is not a claim that a live transport exists; the send
    // boundary's own instance check decides that separately.
    providerLive: true,
    fromNumber: number.value,
    numberVerification: NUMBER_VERIFICATION_STATUSES.VERIFIED,
  };
}

function refuse(code, config) {
  const c = (config && typeof config === 'object') ? config : emptyWhatsAppConfig();
  return {
    canSend: false,
    code,
    message: WHATSAPP_REFUSAL_MESSAGES[code] || null,
    providerId: PROVIDER_ID,
    providerDisplay: PROVIDER_DISPLAY,
    providerLive: false,
    fromNumber: str(c.fromNumber) || null,
    numberVerification: KNOWN_VERIFICATION.includes(c.numberVerification)
      ? c.numberVerification
      : NUMBER_VERIFICATION_STATUSES.UNKNOWN,
  };
}

module.exports = {
  PROVIDER_ID,
  PROVIDER_DISPLAY,
  KNOWN_PROVIDERS,
  WHATSAPP_REFUSALS,
  WHATSAPP_REFUSAL_MESSAGES,
  NUMBER_VERIFICATION_STATUSES,
  emptyWhatsAppConfig,
  readWhatsAppConfig,
  evaluateWhatsAppConfig,
  // Re-exported so callers never need a second E.164 rule: the config resolver and the
  // instance capability share ONE number check.
  checkFromNumber,
};
