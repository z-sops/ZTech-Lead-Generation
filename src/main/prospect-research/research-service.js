'use strict';

// A5 - composition root for prospect research in the Electron MAIN process.
//
// Wiring (as approved):
//   - initResearchService() constructs objects only. It performs NO network I/O.
//   - gateway.start() is called afterwards and deliberately NOT awaited, so an
//     offline or slow Zuni-SEO server can never delay the main window.
//
// A6 (deferred until a Lead Agent exists):
//   ZTech has no Lead Agent. gateway.evidenceForLeadAgent() is therefore never
//   called from this process, is never re-exported from here, and must not be
//   given a preload method. When a Lead Agent is built, its prospect input
//   should be replaced with `await gateway.evidenceForLeadAgent(leadRef)` and it
//   must be given no tools for research.

const { createProspectResearch } = require('./prospect-research.cjs');
const { SqlResearchStateStore } = require('./sql-research-store.js');
const { SqlQuarantineSink } = require('./quarantine-sink.js');
const { ZuniSeoCredentialSource } = require('./credential-source.js');

const LOOPBACK_DEV_BASE_URL = 'http://127.0.0.1:8000';
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

// Every value here is a ZTech code default, not a Zuni-SEO limit. Real plan limits
// come from zuni_capabilities at runtime. Per the approved scope, the ONLY
// user-editable research setting is the base URL (transport optional); everything
// below stays a code default.
const RESEARCH_DEFAULTS = {
  zuniSeo: {
    // Production base URL is still a placeholder in HANDOFF 4.4; plain HTTP is
    // accepted only for loopback, so the dev default is the loopback URL.
    baseUrl: LOOPBACK_DEV_BASE_URL,
    transport: 'mcp',
    timeoutMs: 30_000,
    preflightTimeoutMs: 60_000,
    retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000 },
    breaker: { failureThreshold: 5, openMs: 60_000 }
  },
  freshness: { staleAfterHours: 720, reuseMaxAgeHours: 24 },
  coordinator: { depth: 'quick', maxPages: null, backoff: { baseDelayMs: 5_000, maxDelayMs: 900_000 } },
  schedulerTickMs: 5_000,
  artifactMaxBytes: 10 * 1024 * 1024
};

const ALLOWED_TRANSPORTS = ['mcp', 'rest'];

/**
 * A8 settings validation for the one user-editable research setting.
 * HTTPS is required except for loopback development hosts.
 */
function validateBaseUrl(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') throw new Error('Zuni-SEO base URL is required.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Zuni-SEO base URL is not a valid URL.');
  }
  if (url.username || url.password) {
    throw new Error('Zuni-SEO base URL must not contain credentials.');
  }
  if (url.protocol === 'https:') return url.href;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname)) return url.href;
  throw new Error('Zuni-SEO base URL must use HTTPS (plain HTTP is allowed only for localhost development).');
}

function validateTransport(raw) {
  if (raw === undefined || raw === null || raw === '') return RESEARCH_DEFAULTS.zuniSeo.transport;
  if (typeof raw !== 'string' || !ALLOWED_TRANSPORTS.includes(raw)) {
    throw new Error(`Zuni-SEO transport must be one of: ${ALLOWED_TRANSPORTS.join(', ')}.`);
  }
  return raw;
}

/** Normalise whatever electron-store held into a usable settings object. */
function readResearchSettings(stored) {
  const raw = (stored && typeof stored === 'object' && !Array.isArray(stored)) ? stored : {};
  return {
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.trim() !== ''
      ? raw.baseUrl.trim()
      : RESEARCH_DEFAULTS.zuniSeo.baseUrl,
    transport: ALLOWED_TRANSPORTS.includes(raw.transport) ? raw.transport : RESEARCH_DEFAULTS.zuniSeo.transport
  };
}

/** True when stored settings differ from what the running service was built with. */
function researchSettingsChanged(current, stored) {
  if (!current) return false;
  const next = readResearchSettings(stored);
  return next.baseUrl !== current.baseUrl || next.transport !== current.transport;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(overrides) {
  const base = RESEARCH_DEFAULTS;
  const o = isPlainObject(overrides) ? overrides : {};
  return {
    zuniSeo: { ...base.zuniSeo, ...(isPlainObject(o.zuniSeo) ? o.zuniSeo : {}), clientVersion: o.clientVersion },
    freshness: { ...base.freshness, ...(isPlainObject(o.freshness) ? o.freshness : {}) },
    coordinator: { ...base.coordinator, ...(isPlainObject(o.coordinator) ? o.coordinator : {}) },
    schedulerTickMs: typeof o.schedulerTickMs === 'number' ? o.schedulerTickMs : base.schedulerTickMs,
    artifactMaxBytes: typeof o.artifactMaxBytes === 'number' ? o.artifactMaxBytes : base.artifactMaxBytes
  };
}

/**
 * @param {{
 *   accountStore: any,
 *   secretsDir: string,
 *   clientVersion?: string,
 *   researchSettings?: { baseUrl?: string, transport?: string },
 *   onChange?: Function,
 *   log?: (msg: string, detail?: unknown) => void
 * }} options
 */
function initResearchService(options) {
  const opts = isPlainObject(options) ? options : {};
  if (!opts.accountStore) throw new Error('prospect-research: accountStore is required');
  if (typeof opts.secretsDir !== 'string' || opts.secretsDir === '') {
    throw new Error('prospect-research: secretsDir is required');
  }
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const settings = readResearchSettings(opts.researchSettings);

  const store = new SqlResearchStateStore(opts.accountStore);
  const quarantine = new SqlQuarantineSink(opts.accountStore, {
    maxPayloadBytes: 1024 * 1024,
    retentionMs: RESEARCH_DEFAULTS.freshness.staleAfterHours * 60 * 60 * 1000
  });
  const keys = new ZuniSeoCredentialSource({ secretsDir: opts.secretsDir });

  const research = createProspectResearch(
    mergeConfig({ zuniSeo: { baseUrl: settings.baseUrl, transport: settings.transport }, clientVersion: opts.clientVersion }),
    {
      store,
      quarantine,
      credentials: keys,
      log,
      ...(typeof opts.onChange === 'function' ? { onChange: opts.onChange } : {})
    }
  );

  return { ...research, baseUrl: settings.baseUrl, transport: settings.transport, keys, quarantine, store };
}

module.exports = {
  ALLOWED_TRANSPORTS,
  LOOPBACK_DEV_BASE_URL,
  LOOPBACK_HOSTS,
  RESEARCH_DEFAULTS,
  initResearchService,
  mergeConfig,
  readResearchSettings,
  researchSettingsChanged,
  validateBaseUrl,
  validateTransport
};
