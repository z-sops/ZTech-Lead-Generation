'use strict';

/**
 * I3 - Opportunity Intelligence provider configuration (main process only).
 *
 * A closed catalog, sealed storage, a write-only IPC surface and the environment
 * builder the OI service supervisor calls when it launches a MANAGED child.
 *
 * WHAT CROSSES IPC
 *   The renderer may SET or CLEAR a key, and set four non-secret settings. It reads
 *   back only `{ stored, readable }` booleans per key, the non-secret settings, and
 *   what the running OI service reports it loaded. A key is never echoed, never
 *   returned, never logged and never written in plaintext.
 *
 * WHERE KEYS GO
 *   electron-store `oi.credentials.<id>` = credentialVault.seal(value). They are
 *   revealed ONLY by `childEnv()`, which only the supervisor calls, and only for a
 *   child it launched itself (managed mode). External mode never receives them.
 *
 * WHAT THIS MODULE NEVER DOES
 *   It contacts no provider and makes no network call of any kind. There is no
 *   "test key" path: a test call would spend the customer's API credit.
 */

// NB: the vault exports its API directly; do not destructure (see resendConfig.js).
const credentialVault = require('../../credentialVault');
const { LiError } = require('../core/errors');

/** Secret keys. Closed set: the renderer can only name one of these ids. */
const OI_SECRET_PROVIDERS = Object.freeze({
  brave: Object.freeze({ env: 'BRAVE_API_KEY', label: 'Brave Search', unlocks: 'Competitor discovery' }),
  serper: Object.freeze({ env: 'SERPER_API_KEY', label: 'Serper', unlocks: 'Competitor discovery (alternative)' }),
  serpapi: Object.freeze({ env: 'SERPAPI_API_KEY', label: 'SerpApi', unlocks: 'Google Ads transparency' }),
  meta: Object.freeze({ env: 'META_ACCESS_TOKEN', label: 'Meta Ad Library', unlocks: 'Meta ads' }),
  x: Object.freeze({ env: 'X_BEARER_TOKEN', label: 'X (Twitter)', unlocks: 'X / Twitter activity' }),
  llm: Object.freeze({ env: 'LLM_API_KEY', label: 'LLM', unlocks: 'Better content classification (optional)' }),
});

/**
 * Non-secret settings. Every one is UNSET by default: an unset value is simply not
 * passed to OI, so OI applies its own contract default. No market is assumed by the
 * product - a country list is customer configuration.
 */
const OI_SETTINGS = Object.freeze({
  search_provider: Object.freeze({ env: 'ZTECH_OI_SEARCH_PROVIDER' }),
  meta_countries: Object.freeze({ env: 'META_AD_COUNTRIES' }),
  llm_base_url: Object.freeze({ env: 'LLM_BASE_URL' }),
  llm_model: Object.freeze({ env: 'LLM_MODEL' }),
});

const SECRET_IDS = Object.freeze(Object.keys(OI_SECRET_PROVIDERS));
const SETTING_IDS = Object.freeze(Object.keys(OI_SETTINGS));
const SECRET_MIN = 8;
const SECRET_MAX = 512;
const STORE_CREDENTIALS = 'oi.credentials';
const STORE_SETTINGS = 'settings.oi.providers';

/** ZTech-authored, safe-to-show refusal (publicError exposes LiError messages). */
class OiConfigError extends LiError {
  constructor(code, message) {
    super(code, message);
    this.name = 'OiConfigError';
  }
}

/** Secret shape check. No whitespace or control characters: blocks env injection through a paste. */
function validateSecret(value) {
  if (typeof value !== 'string') throw new OiConfigError('OI_KEY_INVALID', 'The key must be text.');
  if (value.length < SECRET_MIN || value.length > SECRET_MAX) {
    throw new OiConfigError('OI_KEY_INVALID', `The key must be ${SECRET_MIN} to ${SECRET_MAX} characters.`);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(value)) {
    throw new OiConfigError('OI_KEY_INVALID', 'The key must not contain spaces, line breaks or control characters.');
  }
  if (value[0] === '=') throw new OiConfigError('OI_KEY_INVALID', 'The key must not start with "=".');
  return value;
}

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Normalise one non-secret setting, or throw. Empty string = unset. */
function normaliseSetting(name, value) {
  if (!SETTING_IDS.includes(name)) throw new OiConfigError('OI_SETTING_UNKNOWN', 'Unknown setting.');
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new OiConfigError('OI_SETTING_INVALID', 'The value must be text.');
  const v = value.trim();
  if (v === '') return '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) throw new OiConfigError('OI_SETTING_INVALID', 'The value must not contain control characters.');
  switch (name) {
    case 'search_provider':
      if (v !== 'brave' && v !== 'serper') throw new OiConfigError('OI_SETTING_INVALID', 'Search provider must be "brave" or "serper".');
      return v;
    case 'meta_countries': {
      const codes = v.split(',').map((c) => c.trim().toUpperCase()).filter(Boolean);
      if (!codes.length || codes.length > 30 || codes.some((c) => !/^[A-Z]{2}$/.test(c))) {
        throw new OiConfigError('OI_SETTING_INVALID', 'Countries must be two-letter codes separated by commas, e.g. PK,AE.');
      }
      return [...new Set(codes)].join(',');
    }
    case 'llm_base_url': {
      let u;
      try { u = new URL(v); } catch { throw new OiConfigError('OI_SETTING_INVALID', 'The LLM base URL is not a valid URL.'); }
      if (u.username || u.password) throw new OiConfigError('OI_SETTING_INVALID', 'The LLM base URL must not contain credentials.');
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) {
        throw new OiConfigError('OI_SETTING_INVALID', 'The LLM base URL must use HTTPS (http is allowed only for localhost).');
      }
      return u.toString().replace(/\/$/, '');
    }
    case 'llm_model':
      if (v.length > 100 || /\s/.test(v)) throw new OiConfigError('OI_SETTING_INVALID', 'The model name must be at most 100 characters, without spaces.');
      return v;
    default:
      throw new OiConfigError('OI_SETTING_UNKNOWN', 'Unknown setting.');
  }
}

function defaultSafeStorage() {
  try {
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

/** Refuse to store a key where the OS cannot protect it (same rule as the Zuni-SEO key). */
function assertSecureBackend(safeStorage) {
  let available = false;
  try { available = Boolean(safeStorage && safeStorage.isEncryptionAvailable() === true); } catch { available = false; }
  if (!available) {
    throw new OiConfigError('OI_KEYSTORE_UNAVAILABLE', 'The operating system credential store is not available; the key was not saved.');
  }
  let backend = null;
  try { backend = typeof safeStorage.getSelectedStorageBackend === 'function' ? safeStorage.getSelectedStorageBackend() : null; } catch { backend = null; }
  if (backend === 'basic_text') {
    throw new OiConfigError('OI_KEYSTORE_UNAVAILABLE', 'No system keyring is available (basic_text). Install or unlock a keyring to store the key.');
  }
}

/**
 * Map OI's own `GET /v1/engine` -> `configuration` (Settings.describe(): booleans only)
 * to "did OI actually load this key". `null` = OI has not been asked / is not running.
 */
function reportedFromEngine(configuration) {
  const c = configuration && typeof configuration === 'object' ? configuration : null;
  if (!c) return Object.fromEntries(SECRET_IDS.map((id) => [id, null]));
  const search = typeof c.search === 'string' ? c.search : null;
  return {
    brave: search === 'brave',
    serper: search === 'serper',
    serpapi: c.google_ads_transparency_via_serpapi === true,
    meta: Boolean(c.meta_ad_library && c.meta_ad_library.configured === true),
    x: c.x_api === true,
    llm: Boolean(c.llm && c.llm.configured === true),
  };
}

/**
 * @param {object} p
 * @param {{get:Function,set:Function,delete:Function}} p.store  electron-store instance
 * @param {object} [p.safeStorage]  injectable for tests
 * @param {object} [p.logger]
 */
function createOiProviderConfig({ store, safeStorage = defaultSafeStorage(), logger = null } = {}) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') throw new TypeError('electron-store is required');
  const listeners = new Set();
  const warn = (m) => { if (logger && typeof logger.warn === 'function') logger.warn(String(m)); };
  const notify = (what) => { for (const fn of listeners) { try { fn(what); } catch { /* a listener never breaks a save */ } } };

  const sealedFor = (id) => {
    const v = store.get(`${STORE_CREDENTIALS}.${id}`);
    return typeof v === 'string' ? v : '';
  };

  function revealSecret(id) {
    const sealed = sealedFor(id);
    if (!sealed) return null;
    try {
      const plain = credentialVault.unseal(sealed);
      return typeof plain === 'string' && plain ? plain : null;
    } catch {
      return null;
    }
  }

  function readSettings() {
    const raw = store.get(STORE_SETTINGS);
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const id of SETTING_IDS) {
      try { out[id] = normaliseSetting(id, typeof obj[id] === 'string' ? obj[id] : ''); } catch { out[id] = ''; }
    }
    return out;
  }

  return {
    /** Renderer-safe status: booleans and non-secret settings only. */
    status({ reported = null } = {}) {
      const rep = reportedFromEngine(reported);
      const providers = {};
      for (const id of SECRET_IDS) {
        const stored = Boolean(sealedFor(id));
        providers[id] = { stored, readable: stored ? revealSecret(id) !== null : false, reported: rep[id] };
      }
      return { providers, settings: readSettings(), linkedin: 'unsupported' };
    },

    setKey(provider, key) {
      if (!SECRET_IDS.includes(provider)) throw new OiConfigError('OI_PROVIDER_UNKNOWN', 'Unknown provider.');
      validateSecret(key);
      assertSecureBackend(safeStorage);
      let sealed;
      try { sealed = credentialVault.seal(key); } catch { throw new OiConfigError('OI_KEYSTORE_UNAVAILABLE', 'The key could not be encrypted on this system; it was not saved.'); }
      store.set(`${STORE_CREDENTIALS}.${provider}`, sealed);
      notify({ kind: 'key', provider });
      return { ok: true, stored: true };
    },

    clearKey(provider) {
      if (!SECRET_IDS.includes(provider)) throw new OiConfigError('OI_PROVIDER_UNKNOWN', 'Unknown provider.');
      if (typeof store.delete === 'function') store.delete(`${STORE_CREDENTIALS}.${provider}`);
      else store.set(`${STORE_CREDENTIALS}.${provider}`, '');
      notify({ kind: 'key', provider });
      return { ok: true, stored: false };
    },

    setSetting(name, value) {
      const v = normaliseSetting(name, value);
      const cur = readSettings();
      cur[name] = v;
      store.set(STORE_SETTINGS, cur);
      notify({ kind: 'setting', name });
      return { ok: true, value: v };
    },

    /**
     * The OI variables for a MANAGED child. Only the supervisor calls this. Unset keys
     * and unset settings are left out entirely, so OI applies its own defaults.
     */
    childEnv() {
      const env = {};
      for (const id of SECRET_IDS) {
        const plain = revealSecret(id);
        if (plain) env[OI_SECRET_PROVIDERS[id].env] = plain;
        else if (sealedFor(id)) warn(`[opportunity-intelligence] stored ${id} key could not be read; it was not passed to OI`);
      }
      const s = readSettings();
      for (const id of SETTING_IDS) if (s[id]) env[OI_SETTINGS[id].env] = s[id];
      return env;
    },

    /** Every revealed secret, for log redaction in the supervisor. Never leaves main. */
    secretValues() {
      return SECRET_IDS.map(revealSecret).filter(Boolean);
    },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

module.exports = {
  OI_SECRET_PROVIDERS,
  OI_SETTINGS,
  SECRET_IDS,
  SETTING_IDS,
  OiConfigError,
  createOiProviderConfig,
  validateSecret,
  normaliseSetting,
  reportedFromEngine,
  assertSecureBackend,
};
