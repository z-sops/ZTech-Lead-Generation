'use strict';

/**
 * F26 - Outreach Settings: the WRITER for the configuration F22-F25 already READ.
 *
 * Every value written here lands on exactly the electron-store key that
 * readResendConfig / readWhatsAppConfig / readBusinessProfile read, and is validated by
 * the validators those modules already own. This module adds no send path and changes
 * no send semantics: F19/F20, the OutreachGate, approval, Ready and the ledgers are not
 * touched. It only writes configuration and reports the existing capability verdicts.
 *
 * SECRETS: the Resend API key and the Meta access token are sealed with credentialVault
 * into providers.<id>.credentials.apiKey (the record the providers already read). They
 * are never returned, logged or echoed - status carries { keyStored, keyReadable }.
 *
 * VERIFICATION (D1): never typed by the user. `verify(provider)` makes ONE read-only GET
 * to the provider, reduces the answer to unknown | pending | verified | failed, and stores
 * that state with an internal checkedAt. Raw provider responses never leave this module.
 * Changing the sending domain, the sending number, the phone-number id or the business
 * account id resets the state to unknown and checkedAt to null. So does replacing or
 * clearing that channel's key: a check proves what one credential's account says, so it
 * is not trusted for another. The user runs Check again; nothing re-checks by itself.
 * Nothing polls.
 *
 * IDENTITY: nothing here has a default identity. Empty means "not configured".
 */

// NB: the vault exports its API directly; do not destructure (see resendConfig.js).
const credentialVault = require('../../credentialVault');
const { LiError } = require('../core/errors');
const resend = require('./email/resendConfig');
const wa = require('./whatsapp/whatsappConfig');
const { readBusinessProfile, BUSINESS_PROFILE_FIELDS } = require('./businessProfile');
const { ENDPOINT: META_GRAPH } = require('./whatsapp/MetaCloudWhatsAppProvider');

const RESEND_DOMAINS_URL = 'https://api.resend.com/domains';
const PROVIDERS = Object.freeze({ resend: 'resend', meta: 'meta-cloud' });
const KEY_PROVIDERS = Object.freeze([PROVIDERS.resend, PROVIDERS.meta]);
const STATES = Object.freeze(['unknown', 'pending', 'verified', 'failed']);
const VERIFY_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const KEY_MIN = 8;
const KEY_MAX = 2048;

/** Store keys for the internal verification timestamps (F26 addition). */
const CHECKED_AT = Object.freeze({ email: 'emailDomainCheckedAt', whatsapp: 'whatsappNumberCheckedAt' });

class OutreachSettingsError extends LiError {
  constructor(code, message) {
    super(code, message);
    this.name = 'OutreachSettingsError';
  }
}

const refuse = (code, message) => { throw new OutreachSettingsError(code, message); };
const isCtrl = (s, allowNewline) => (allowNewline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(s);
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function defaultSafeStorage() {
  try {
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

function assertSecureBackend(safeStorage) {
  let ok = false;
  try { ok = Boolean(safeStorage && safeStorage.isEncryptionAvailable() === true); } catch { ok = false; }
  if (!ok) refuse('OUTREACH_KEYSTORE_UNAVAILABLE', 'The operating system credential store is not available; the key was not saved.');
  let backend = null;
  try { backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : null; } catch { backend = null; }
  if (backend === 'basic_text') refuse('OUTREACH_KEYSTORE_UNAVAILABLE', 'No system keyring is available (basic_text). Install or unlock a keyring to store the key.');
}

function validateKey(value) {
  if (typeof value !== 'string') refuse('OUTREACH_KEY_INVALID', 'The key must be text.');
  if (value.length < KEY_MIN || value.length > KEY_MAX) refuse('OUTREACH_KEY_INVALID', `The key must be ${KEY_MIN} to ${KEY_MAX} characters.`);
  if (/[\s\u0000-\u001f\u007f]/.test(value)) refuse('OUTREACH_KEY_INVALID', 'The key must not contain spaces, line breaks or control characters.');
  return value;
}

/** The address must be on the sending domain or one of its subdomains. */
function addressOnDomain(address, domain) {
  const host = String(address).split('@')[1] || '';
  const h = host.toLowerCase();
  return h === domain || h.endsWith(`.${domain}`);
}

/** Bounded, normalised verification state for the renderer. Never a raw response. */
function verificationView(state, checkedAt) {
  return {
    status: STATES.includes(state) ? state : 'unknown',
    checkedAt: typeof checkedAt === 'string' && !Number.isNaN(Date.parse(checkedAt)) ? checkedAt : null,
  };
}

/** Resend domain status -> one of four states. Anything unrecognised is unknown. */
function mapResendStatus(s) {
  const v = String(s || '').toLowerCase();
  if (v === 'verified') return 'verified';
  if (v === 'pending' || v === 'not_started') return 'pending';
  if (v === 'failed' || v === 'temporary_failure') return 'failed';
  return 'unknown';
}

/** Digits only, for comparing a Meta display number with our E.164 sending number. */
const digits = (s) => String(s || '').replace(/\D/g, '');

/**
 * Meta phone-number object -> one of four states. Verified only when Meta reports the
 * number verified, it is the number we are configured to send from, and it is not
 * banned, flagged, restricted or disconnected.
 */
function mapMetaNumber(body, fromNumber) {
  if (!body || typeof body !== 'object') return 'unknown';
  const shown = digits(body.display_phone_number);
  if (shown && digits(fromNumber) && shown !== digits(fromNumber)) return 'failed';
  const status = String(body.status || '').toUpperCase();
  if (['BANNED', 'FLAGGED', 'RESTRICTED', 'DISCONNECTED', 'DELETED', 'RATE_LIMITED'].includes(status)) return 'failed';
  const code = String(body.code_verification_status || '').toUpperCase();
  if (code === 'VERIFIED') return 'verified';
  if (code === 'NOT_VERIFIED' || code === 'EXPIRED' || status === 'PENDING') return 'pending';
  return 'unknown';
}

/** One bounded read-only GET. Never throws; returns { ok, status, body } or { ok:false, reason }. */
async function boundedGet(fetchImpl, url, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);
  if (timer.unref) timer.unref();
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) return { ok: false, reason: 'too_large' };
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} p
 * @param {object} p.store            electron-store (dot-path get/set)
 * @param {object} [p.safeStorage]    injectable for tests
 * @param {Function} [p.fetchImpl]    used ONLY by verify(); injectable for tests
 * @param {Function} [p.clock]
 * @param {Function} [p.onChange]     called after every successful write (D2 live apply)
 */
function createOutreachSettings({ store, safeStorage = defaultSafeStorage(), fetchImpl = globalThis.fetch, clock = () => new Date(), onChange = null, logger = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('electron-store is required');

  const settings = () => {
    const s = store.get('settings', null);
    return s && typeof s === 'object' && !Array.isArray(s) ? { ...s } : {};
  };
  const writeSettings = (patch) => {
    const next = { ...settings(), ...patch };
    store.set('settings', next);
  };
  const providers = () => {
    const p = store.get('providers', null);
    return p && typeof p === 'object' && !Array.isArray(p) ? { ...p } : {};
  };
  const changed = (what) => {
    if (typeof onChange === 'function') {
      try { onChange(what); } catch (e) { if (logger && logger.warn) logger.warn(`outreach settings apply failed: ${e && e.message}`); }
    }
  };

  function revealKey(providerId) {
    const rec = providers()[providerId];
    const sealed = rec && rec.credentials && typeof rec.credentials.apiKey === 'string' ? rec.credentials.apiKey : '';
    if (!sealed) return null;
    try {
      const plain = credentialVault.reveal(sealed);
      return typeof plain === 'string' && plain ? plain : null;
    } catch {
      return null;
    }
  }

  function status() {
    const s = settings();
    const emailCfg = resend.readResendConfig(store);
    const waCfg = wa.readWhatsAppConfig(store);
    const emailCap = resend.evaluateResendCapability(emailCfg);
    const waCap = wa.evaluateWhatsAppConfig(waCfg);
    const profile = readBusinessProfile(store);
    return {
      business: {
        representativeName: profile.sender_name,
        companyName: profile.sender_company,
        valueProposition: profile.value_proposition,
        callToAction: profile.call_to_action,
        postalAddress: profile.postal_address,
      },
      email: {
        enabled: s.emailEnabled === true,
        fromName: emailCfg.fromName,
        fromAddress: emailCfg.fromAddress,
        replyTo: emailCfg.replyTo,
        domain: emailCfg.domain,
        signature: emailCfg.signature,
        keyStored: emailCfg.keyConfigured,
        keyReadable: emailCfg.keyReadable,
        verification: verificationView(emailCfg.domainVerification, s[CHECKED_AT.email]),
        capability: { canSend: emailCap.canSend, code: emailCap.code, message: emailCap.message },
      },
      whatsapp: {
        enabled: s.whatsappEnabled === true,
        provider: wa.PROVIDER_DISPLAY,
        fromNumber: waCfg.fromNumber,
        phoneNumberId: waCfg.phoneNumberId,
        businessAccountId: waCfg.businessAccountId,
        keyStored: waCfg.keyConfigured,
        keyReadable: waCfg.keyReadable,
        verification: verificationView(waCfg.numberVerification, s[CHECKED_AT.whatsapp]),
        capability: { canSend: waCap.canSend, code: waCap.code, message: waCap.message },
        // D3: honest, fixed notice until F27.
        templates: 'unsupported',
      },
    };
  }

  function saveBusiness(input) {
    const i = input && typeof input === 'object' ? input : {};
    const map = { representativeName: 'businessRepresentativeName', companyName: 'businessCompanyName', valueProposition: 'businessValueProposition', callToAction: 'businessCallToAction', postalAddress: 'businessPostalAddress' };
    const patch = {};
    for (const [field, setting] of Object.entries(map)) {
      const spec = BUSINESS_PROFILE_FIELDS.find((f) => f.setting === setting);
      const raw = i[field] === undefined || i[field] === null ? '' : i[field];
      if (typeof raw !== 'string') refuse('OUTREACH_VALUE_INVALID', `${field} must be text.`);
      const v = spec.multiline ? raw.replace(/\r\n?/g, '\n').trim() : raw.trim();
      if (v.length > spec.max) refuse('OUTREACH_VALUE_INVALID', `${field} must be at most ${spec.max} characters.`);
      if (isCtrl(v, spec.multiline)) refuse('OUTREACH_VALUE_INVALID', `${field} must not contain control characters${spec.multiline ? '' : ' or line breaks'}.`);
      patch[setting] = v;
    }
    writeSettings(patch);
    changed('business');
    return { ok: true };
  }

  function saveEmail(input) {
    const i = input && typeof input === 'object' ? input : {};
    if (i.enabled !== undefined && typeof i.enabled !== 'boolean') refuse('OUTREACH_VALUE_INVALID', 'enabled must be true or false.');
    const name = resend.validateFromName(i.fromName);
    if (!name.ok) refuse('OUTREACH_VALUE_INVALID', 'The From name must be 1-120 characters on one line.');
    let fromAddress = '';
    if (str(i.fromAddress)) {
      const a = resend.validateEmailAddress(i.fromAddress);
      if (!a.ok) refuse('OUTREACH_VALUE_INVALID', resend.RESEND_REFUSAL_MESSAGES[a.code] || 'The From address is not valid.');
      fromAddress = a.value;
    }
    const reply = resend.validateReplyTo(i.replyTo);
    if (!reply.ok) refuse('OUTREACH_VALUE_INVALID', resend.RESEND_REFUSAL_MESSAGES[reply.code] || 'The reply-to address is not valid.');
    let domain = '';
    if (str(i.domain)) {
      const d = resend.validateDomain(i.domain);
      if (!d.ok) refuse('OUTREACH_VALUE_INVALID', 'The sending domain is not a valid domain name.');
      domain = d.value;
    }
    if (fromAddress && domain && !addressOnDomain(fromAddress, domain)) {
      refuse('OUTREACH_VALUE_INVALID', 'The From address must be on the sending domain or one of its subdomains.');
    }
    const sig = resend.validateSignature(i.signature);
    if (!sig.ok) refuse('OUTREACH_VALUE_INVALID', 'The signature must be at most 500 characters of plain text.');

    const cur = settings();
    const patch = {
      emailProvider: PROVIDERS.resend,
      emailFromName: name.value,
      emailFromAddress: fromAddress,
      emailReplyTo: reply.value,
      emailDomain: domain,
      emailSignature: sig.value,
    };
    if (i.enabled !== undefined) patch.emailEnabled = i.enabled;
    if (str(cur.emailDomain).toLowerCase() !== domain) {
      patch.emailDomainVerification = 'unknown';
      patch[CHECKED_AT.email] = null;
    }
    writeSettings(patch);
    changed('email');
    return { ok: true };
  }

  function saveWhatsApp(input) {
    const i = input && typeof input === 'object' ? input : {};
    if (i.enabled !== undefined && typeof i.enabled !== 'boolean') refuse('OUTREACH_VALUE_INVALID', 'enabled must be true or false.');
    let fromNumber = '';
    if (str(i.fromNumber)) {
      const n = wa.checkFromNumber(i.fromNumber);
      if (!n.ok) refuse('OUTREACH_VALUE_INVALID', wa.WHATSAPP_REFUSAL_MESSAGES[wa.WHATSAPP_REFUSALS.SENDER_NUMBER_INVALID]);
      fromNumber = n.value;
    }
    const id = (v, label) => {
      const s = str(v);
      if (s && !/^\d{1,120}$/.test(s)) refuse('OUTREACH_VALUE_INVALID', `${label} must contain digits only.`);
      return s;
    };
    const phoneNumberId = id(i.phoneNumberId, 'The phone number ID');
    const businessAccountId = id(i.businessAccountId, 'The business account ID');
    const cur = settings();
    const patch = {
      whatsappProvider: wa.PROVIDER_ID,
      whatsappFromNumber: fromNumber,
      whatsappPhoneNumberId: phoneNumberId,
      whatsappBusinessAccountId: businessAccountId,
    };
    if (i.enabled !== undefined) patch.whatsappEnabled = i.enabled;
    const curNumber = (() => { const n = wa.checkFromNumber(str(cur.whatsappFromNumber)); return n.ok ? n.value : str(cur.whatsappFromNumber); })();
    if (curNumber !== fromNumber || str(cur.whatsappPhoneNumberId) !== phoneNumberId || str(cur.whatsappBusinessAccountId) !== businessAccountId) {
      patch.whatsappNumberVerification = 'unknown';
      patch[CHECKED_AT.whatsapp] = null;
    }
    writeSettings(patch);
    changed('whatsapp');
    return { ok: true };
  }

  /** A credential change invalidates that channel's verification (F26 follow-up). */
  function resetVerificationFor(provider) {
    if (provider === PROVIDERS.resend) writeSettings({ emailDomainVerification: 'unknown', [CHECKED_AT.email]: null });
    else writeSettings({ whatsappNumberVerification: 'unknown', [CHECKED_AT.whatsapp]: null });
  }

  function setKey(provider, key) {
    if (!KEY_PROVIDERS.includes(provider)) refuse('OUTREACH_PROVIDER_UNKNOWN', 'Unknown provider.');
    validateKey(key);
    assertSecureBackend(safeStorage);
    let sealed;
    try { sealed = credentialVault.seal(key); } catch { refuse('OUTREACH_KEYSTORE_UNAVAILABLE', 'The key could not be encrypted on this system; it was not saved.'); }
    const all = providers();
    const existing = all[provider] && typeof all[provider] === 'object' ? all[provider] : {};
    all[provider] = {
      ...existing,
      providerId: provider,
      credentials: { ...(existing.credentials && typeof existing.credentials === 'object' ? existing.credentials : {}), apiKey: sealed },
    };
    store.set('providers', all);
    resetVerificationFor(provider);
    changed(provider === PROVIDERS.resend ? 'email' : 'whatsapp');
    return { ok: true, stored: true };
  }

  function clearKey(provider) {
    if (!KEY_PROVIDERS.includes(provider)) refuse('OUTREACH_PROVIDER_UNKNOWN', 'Unknown provider.');
    const all = providers();
    const existing = all[provider] && typeof all[provider] === 'object' ? all[provider] : null;
    if (existing) {
      all[provider] = { ...existing, credentials: { ...(existing.credentials || {}), apiKey: '' } };
      store.set('providers', all);
    }
    resetVerificationFor(provider);
    changed(provider === PROVIDERS.resend ? 'email' : 'whatsapp');
    return { ok: true, stored: false };
  }

  /**
   * D1 - one user-triggered, read-only provider check. Never polls, never sends.
   * Returns only { status, checkedAt, message } - the raw response stays here.
   */
  async function verify(provider) {
    if (!KEY_PROVIDERS.includes(provider)) refuse('OUTREACH_PROVIDER_UNKNOWN', 'Unknown provider.');
    const s = settings();
    const token = revealKey(provider);
    const now = clock().toISOString();
    if (provider === PROVIDERS.resend) {
      const domain = str(s.emailDomain).toLowerCase();
      if (!domain) refuse('OUTREACH_VERIFY_NOT_READY', 'Set the sending domain first.');
      if (!token) refuse('OUTREACH_VERIFY_NOT_READY', 'Save the Resend API key first.');
      const r = await boundedGet(fetchImpl, RESEND_DOMAINS_URL, token);
      let state = 'unknown';
      let message;
      if (!r.ok && r.status === undefined) {
        message = 'Resend could not be reached. Nothing was changed.';
        return { ...verificationView(s.emailDomainVerification, s[CHECKED_AT.email]), message };
      }
      if (r.status === 401 || r.status === 403) {
        message = 'Resend did not accept the API key.';
      } else if (!r.ok) {
        message = 'Resend could not answer right now. Nothing was changed.';
        return { ...verificationView(s.emailDomainVerification, s[CHECKED_AT.email]), message };
      } else {
        const list = r.body && Array.isArray(r.body.data) ? r.body.data : [];
        const hit = list.find((d) => d && typeof d.name === 'string' && d.name.toLowerCase() === domain);
        if (!hit) {
          state = 'failed';
          message = 'This domain is not in the Resend account for this API key.';
        } else {
          state = mapResendStatus(hit.status);
          message = state === 'verified' ? 'Resend reports the domain as verified.'
            : state === 'pending' ? 'Resend is still verifying the domain DNS records.'
              : state === 'failed' ? 'Resend reports the domain verification failed.'
                : 'Resend returned a status ZTech does not recognise.';
        }
      }
      writeSettings({ emailDomainVerification: state, [CHECKED_AT.email]: now });
      changed('email');
      return { ...verificationView(state, now), message };
    }

    const phoneNumberId = str(s.whatsappPhoneNumberId);
    const fromNumber = str(s.whatsappFromNumber);
    if (!phoneNumberId || !fromNumber) refuse('OUTREACH_VERIFY_NOT_READY', 'Set the sending number and phone number ID first.');
    if (!/^\d{1,120}$/.test(phoneNumberId)) refuse('OUTREACH_VERIFY_NOT_READY', 'The phone number ID must contain digits only.');
    if (!token) refuse('OUTREACH_VERIFY_NOT_READY', 'Save the Meta access token first.');
    const url = `${META_GRAPH}/${phoneNumberId}?fields=display_phone_number,code_verification_status,status`;
    const r = await boundedGet(fetchImpl, url, token);
    if (!r.ok && r.status === undefined) {
      return { ...verificationView(s.whatsappNumberVerification, s[CHECKED_AT.whatsapp]), message: 'Meta could not be reached. Nothing was changed.' };
    }
    let state = 'unknown';
    let message;
    if (r.status === 401 || r.status === 403) {
      message = 'Meta did not accept the access token.';
    } else if (r.status === 400 || r.status === 404) {
      state = 'failed';
      message = 'Meta does not know this phone number ID for this token.';
    } else if (!r.ok) {
      return { ...verificationView(s.whatsappNumberVerification, s[CHECKED_AT.whatsapp]), message: 'Meta could not answer right now. Nothing was changed.' };
    } else {
      state = mapMetaNumber(r.body, fromNumber);
      message = state === 'verified' ? 'Meta reports the sending number as verified.'
        : state === 'pending' ? 'Meta has not finished verifying this number.'
          : state === 'failed' ? 'Meta reports a different number, or the number is restricted.'
            : 'Meta returned a status ZTech does not recognise.';
    }
    writeSettings({ whatsappNumberVerification: state, [CHECKED_AT.whatsapp]: now });
    changed('whatsapp');
    return { ...verificationView(state, now), message };
  }

  return { status, saveBusiness, saveEmail, saveWhatsApp, setKey, clearKey, verify };
}

module.exports = {
  createOutreachSettings,
  OutreachSettingsError,
  PROVIDERS,
  KEY_PROVIDERS,
  STATES,
  CHECKED_AT,
  RESEND_DOMAINS_URL,
  mapResendStatus,
  mapMetaNumber,
  verificationView,
  addressOnDomain,
};
