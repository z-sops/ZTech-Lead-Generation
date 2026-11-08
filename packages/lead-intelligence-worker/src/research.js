'use strict';

/**
 * The research job executor (Phase 2).
 *
 * A research job whose payload is { kind: "business_research", criteria }
 * runs the real pipeline: OpenStreetMap discovery, website inspection through
 * the guarded fetcher, evidence, needs, scoring. Every other job is handed to
 * the no-op executor exactly as in Phase 1 (so the Phase 1 jobs and tests
 * behave as before), and a chargeable job is still refused: nothing in this
 * pipeline costs money.
 *
 * Configuration (environment):
 *   ZTECH_RESEARCH_USER_AGENT   the User-Agent; must identify the service and
 *                               a contact URL (default below)
 *   ZTECH_RESEARCH_CONCURRENCY  websites inspected at once (1-5, default 3)
 *   ZTECH_NOMINATIM_URL / ZTECH_OVERPASS_URL   other instances (e.g. self-hosted)
 *   ZTECH_INSPECT_HOST_MAP="host=port,..."  TESTS ONLY: serve named sites locally
 *   ZTECH_INSPECT_ALLOW_PRIVATE=1  TESTS ONLY: allow private addresses; refused
 *                               when NODE_ENV or ZTECH_ENV is "production"
 */

const { intel } = require('@zunitech/lead-intelligence');
const { createSafeFetch } = require('./safeFetch');
const { executeNoop } = require('./noop');

const DEFAULT_USER_AGENT = 'ZTechResearchBot/1.0 (+https://zunitech.ai/bot)';
const RESEARCH_KIND = 'business_research';

function isProduction(env) {
  return env.NODE_ENV === 'production' || env.ZTECH_ENV === 'production';
}

function researchConfig(env = process.env) {
  const allowPrivate = env.ZTECH_INSPECT_ALLOW_PRIVATE === '1';
  if (allowPrivate && isProduction(env)) {
    throw new Error('ZTECH_INSPECT_ALLOW_PRIVATE is for tests only and is refused in production');
  }
  const concurrency = env.ZTECH_RESEARCH_CONCURRENCY ? Number(env.ZTECH_RESEARCH_CONCURRENCY) : 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) {
    throw new Error('ZTECH_RESEARCH_CONCURRENCY must be a whole number from 1 to 5');
  }
  const userAgent = String(env.ZTECH_RESEARCH_USER_AGENT || DEFAULT_USER_AGENT).trim();
  if (!/^[\x20-\x7e]{8,200}$/.test(userAgent) || !/https?:\/\//.test(userAgent)) {
    throw new Error('ZTECH_RESEARCH_USER_AGENT must be one printable line that includes a contact URL');
  }
  let hostMap = null;
  if (env.ZTECH_INSPECT_HOST_MAP) {
    if (!allowPrivate) throw new Error('ZTECH_INSPECT_HOST_MAP is for tests only and needs ZTECH_INSPECT_ALLOW_PRIVATE=1');
    hostMap = new Map();
    for (const pair of String(env.ZTECH_INSPECT_HOST_MAP).split(',')) {
      const [h, ports] = pair.split('=').map((x) => x.trim());
      const m = /^(\d{2,5})(?::(\d{2,5}))?$/.exec(ports || '');
      if (!h || !m) throw new Error('ZTECH_INSPECT_HOST_MAP must look like "host=httpPort[:httpsPort],..."');
      hostMap.set(h.toLowerCase(), { http: Number(m[1]), https: m[2] ? Number(m[2]) : null });
    }
  }
  return {
    allowPrivate,
    hostMap,
    concurrency,
    userAgent,
    nominatimUrl: env.ZTECH_NOMINATIM_URL || undefined,
    overpassUrl: env.ZTECH_OVERPASS_URL || undefined,
  };
}

/**
 * @param {{env?: object, fetcher?: {request: Function, fetchPage: Function}, now?: () => Date}} [options]
 * @returns {(job: object) => Promise<object>}
 */
function createResearchExecutor(options = {}) {
  const cfg = researchConfig(options.env || process.env);
  const fetcher = options.fetcher || createSafeFetch({ userAgent: cfg.userAgent, allowPrivate: cfg.allowPrivate, hostMap: cfg.hostMap });
  // Map data APIs get a longer deadline than a website: an Overpass query
  // over a city may take a while to compute.
  const apiFetcher = options.fetcher || createSafeFetch({ userAgent: cfg.userAgent, allowPrivate: cfg.allowPrivate, hostMap: cfg.hostMap, timeoutMs: 40000, maxBytes: 8388608 });
  const now = options.now || (() => new Date());

  return async function executeJob(job) {
    const payload = job.payload || {};
    if (job.jobType !== 'research' || payload.kind !== RESEARCH_KIND) return executeNoop(job);
    if (job.jobClass && job.jobClass !== 'noop') return executeNoop(job); // refused there, loudly

    const discovery = new intel.discovery.OsmDiscovery({
      request: apiFetcher.request,
      userAgent: cfg.userAgent,
      now,
      nominatimUrl: cfg.nominatimUrl,
      overpassUrl: cfg.overpassUrl,
    });
    try {
      return await intel.pipeline.runResearch({
        criteria: payload.criteria,
        discovery,
        fetchPage: fetcher.fetchPage,
        now,
        signal: job.signal,
        concurrency: cfg.concurrency,
        isCancelled: job.isCancelled,
      });
    } catch (err) {
      // A criteria or discovery failure becomes the job's error message: it
      // is shown to the customer, so it says what happened and what to do.
      if (err && (err.name === 'CriteriaError' || err.name === 'DiscoveryError')) {
        const e = new Error(`${err.code}: ${err.message}`);
        e.code = err.code;
        throw e;
      }
      throw err;
    }
  };
}

module.exports = { createResearchExecutor, researchConfig, RESEARCH_KIND, DEFAULT_USER_AGENT };
