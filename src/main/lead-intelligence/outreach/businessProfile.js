'use strict';

/**
 * F24 PLUG & PLAY BUSINESS / OFFER PROFILE - the authoritative, minimal reader for the
 * customer identity an approved pitch carries.
 *
 * WHAT THIS MODULE IS
 *   - a SAFE CONFIGURATION PARSER: `readBusinessProfile(store)` reads the main-process
 *     configuration source (the same electron-store instance that owns settings) and
 *     returns the bounded offer identity the PitchGenerator already consumes:
 *     sender_name, sender_company, value_proposition, call_to_action.
 *   - NOTHING IS HARD-CODED. An absent store, unreadable settings or absent keys all
 *     read back as EMPTY STRINGS - the honest "Not configured" state. No representative
 *     name, no company name, no domain and no contact identity is ever invented here or
 *     anywhere downstream: with no configuration the pitch composes an identity-free
 *     opening rather than falling back to a built-in one.
 *
 * WHAT THIS MODULE IS NOT
 *   - NO SECRETS. These four fields are plain, renderer-visible identity text. API keys,
 *     access tokens, passwords and provider credentials are NOT part of the Business
 *     Profile and are never read from or written to a `settings.business*` key; they stay
 *     in the existing protected credential mechanism (providers.<id>.credentials,
 *     revealed only through credentialVault inside the main process).
 *   - NO WRITES, NO I/O, NO SCHEMA. `readBusinessProfile` is a pure read of its
 *     argument. There is no CRM, no company-management subsystem, no table and no
 *     migration - only these four settings keys.
 *   - NO VALIDATION THEATER. Values are bounded plain text with control characters
 *     stripped; they describe THIS business, never the prospect, and the PitchGenerator
 *     still runs its own untrusted-text sanitiser and claim detection over them.
 *
 * WHY THE FIELDS ARE EXACTLY THESE FOUR
 *   They are the only offer fields existing product behaviour reads (PitchGenerator:
 *   the opening line's representative + company, the value proposition and the call to
 *   action). Conceptual fields like website, business email or phone are NOT added:
 *   nothing consumes them today, so adding them would be speculative surface.
 */

// The PitchGenerator's own slice bounds, repeated as compile-time constants so the
// reader and the generator cannot drift silently (same convention as the lead-field
// validators in main.js).
const MAX = Object.freeze({ sender_name: 80, sender_company: 120, value_proposition: 1200, call_to_action: 400, postal_address: 300 });

/**
 * The profile shape and the settings key each field is read from. Frozen, so a caller
 * can enumerate exactly what "the Business Profile" means - four identity fields and
 * nothing else, which is also what the secret-isolation tests assert against.
 */
const BUSINESS_PROFILE_FIELDS = Object.freeze([
  Object.freeze({ key: 'sender_name', setting: 'businessRepresentativeName', max: MAX.sender_name, multiline: false }),
  Object.freeze({ key: 'sender_company', setting: 'businessCompanyName', max: MAX.sender_company, multiline: false }),
  Object.freeze({ key: 'value_proposition', setting: 'businessValueProposition', max: MAX.value_proposition, multiline: true }),
  Object.freeze({ key: 'call_to_action', setting: 'businessCallToAction', max: MAX.call_to_action, multiline: true }),
  // F26.5: the sender's physical postal address. CAN-SPAM requires a valid postal address in
  // every commercial email, and every ZTech email footer carries it. The send boundary refuses
  // to send without it (SENDER_IDENTITY_INCOMPLETE). It is never invented or defaulted.
  Object.freeze({ key: 'postal_address', setting: 'businessPostalAddress', max: MAX.postal_address, multiline: true }),
]);

/** The unconfigured profile: every field present, every field empty. Never a default identity. */
function emptyBusinessProfile() {
  return {
    sender_name: '',
    sender_company: '',
    value_proposition: '',
    call_to_action: '',
    postal_address: '',
  };
}

/**
 * One bounded field. Non-strings read back as '' (a configuration source that answers
 * with an object or a number is "not configured", never "configured"). Control
 * characters are stripped; single-line fields also lose every CR/LF so header-shaped or
 * paragraph-shaped text cannot enter a one-line identity slot. The result is trimmed and
 * sliced to the field's own bound.
 */
function cleanField(value, max, multiline) {
  if (typeof value !== 'string') return '';
  let s = multiline ? value.replace(/\r\n?/g, '\n') : value.replace(/[\r\n]/g, '');
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  s = s.replace(/\s+$/, '').replace(/^\s+/, '');
  return s.slice(0, max);
}

/**
 * SAFE CONFIGURATION PARSER.
 *
 * @param {{get: Function}|null|undefined} store the main-process configuration source.
 *        `null`/`undefined` means "this process has no configuration source", which is a
 *        normal state in tests and in any non-Electron process - and maps to the honest
 *        unconfigured profile, never to an identity.
 * @returns {object} a frozen profile: exactly the four offer fields, values bounded.
 */
function readBusinessProfile(store) {
  const out = emptyBusinessProfile();
  if (!store || typeof store.get !== 'function') return Object.freeze(out);

  let settings = {};
  try {
    const raw = store.get('settings', null);
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) settings = raw;
  } catch {
    // A store that cannot be read is "not configured" - never "configured with a default".
  }

  for (const field of BUSINESS_PROFILE_FIELDS) {
    out[field.key] = cleanField(settings[field.setting], field.max, field.multiline);
  }
  return Object.freeze(out);
}

module.exports = { readBusinessProfile, emptyBusinessProfile, BUSINESS_PROFILE_FIELDS, MAX_PROFILE_LENGTHS: MAX };
