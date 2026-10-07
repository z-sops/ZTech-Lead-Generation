'use strict';

const { validateServiceBaseUrl, normalizeDomain } = require('../core/urls');
const {
  OI_SERVICE_STATES, validateIntelligenceReport, summariseProviders,
} = require('./oiContract');

/**
 * OpportunityIntelligenceGateway - the ZTech-side client for the local
 * Opportunity Intelligence service.
 *
 * This is the sibling of the Zuni-SEO `ProspectIntelligenceGateway`, and it is
 * deliberately NOT a second version of it. The two systems answer different
 * questions and keep different contracts:
 *
 *   Zuni-SEO (ProspectIntelligenceGateway)  ONE prospect: website / technical /
 *                                            content / AI-access research, folded
 *                                            into the EvidencePacket contract.
 *   Opportunity Intelligence (this file)    MANY entities: prospect + competitors +
 *                                            ads + social + content + comparisons +
 *                                            opportunities + angles + timeline. It
 *                                            keeps its own IntelligenceReport.
 *
 * What this gateway DOES, and nothing else:
 *   - bounded HTTP against one configured base URL (loopback by default)
 *   - health / capability
 *   - request normalisation (identity + domain come from the lead, never the renderer)
 *   - response validation against the OI contract
 *   - timeouts
 *   - honest unavailable / partial semantics
 *   - canonical report retrieval by research_id
 *
 * What this gateway MUST NOT do, and does not:
 *   - calculate opportunities, scores or angles
 *   - discover competitors
 *   - reproduce OI scoring, confidence maths or taxonomy
 *   - implement Meta / Google / X research
 *   - rewrite, summarise away or "fix" an OI fact
 *
 * There is no outbound-message path anywhere in this file. OI is research
 * context; it can never send outreach and can never affect Ready.
 */

/** Route paths are fixed in code. The renderer cannot influence any of them. */
const ROUTES = Object.freeze({
  health: '/v1/health',
  engine: '/v1/engine',
  research: '/v1/research',
  discover: '/v1/competitors/discover',
  report: (researchId) => `/v1/reports/${encodeURIComponent(researchId)}`,
  analyze: (researchId) => `/v1/reports/${encodeURIComponent(researchId)}/analyze`,
  timeline: '/v1/timeline',
});

const BOUNDS = Object.freeze({
  timeoutMs: 30_000,
  maxHealthTimeoutMs: 5_000,
  maxResponseBytes: 8 * 1024 * 1024,
  maxCompetitors: 25,
  maxTimelineEvents: 2000,
});

/** Config defaults. Safe AND local: loopback only, no key, bounded timeout. */
const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  baseUrl: 'http://127.0.0.1:8099',
  timeoutMs: BOUNDS.timeoutMs,
  healthTimeoutMs: BOUNDS.maxHealthTimeoutMs,
  allowLocalhost: true,
  maxCompetitors: 5,
});

/** Ids OI mints. Refusing anything else keeps a caller from steering OI's store. */
const OI_ID = { type: 'string', minLength: 1, maxLength: 128, pattern: /^res_[0-9]{8}[0-9]{6}_[a-f0-9]{8,32}$/ };
const SNAP_ID = { type: 'string', minLength: 1, maxLength: 128, pattern: /^snap_[0-9]{8}[0-9]{6}_[a-f0-9]{8,32}$/ };
const ENTITY_KEY = { type: 'string', minLength: 1, maxLength: 300 };

class OpportunityIntelligenceGateway {
  // I4: the managed service's per-launch bearer token. A private field, so it can never
  // be reached by JSON.stringify, a spread, a log line or anything sent over IPC.
  #authToken = null;

  /**
   * @param {object} input
   * @param {object} [input.config]      { enabled, baseUrl, timeoutMs, healthTimeoutMs, allowLocalhost, maxCompetitors }
   * @param {Function} [input.fetchImpl] injected for tests; defaults to global fetch
   * @param {Function} [input.clock]
   * @param {object} [input.logger]
   */
  constructor({ config = {}, fetchImpl = globalThis.fetch, clock = () => new Date(), logger = console } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('OpportunityIntelligenceGateway requires a fetch implementation');
    this.fetchImpl = fetchImpl;
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
      timeoutMs: Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : BOUNDS.timeoutMs,
      healthTimeoutMs: Number(config.healthTimeoutMs) > 0 ? Number(config.healthTimeoutMs) : BOUNDS.maxHealthTimeoutMs,
      maxCompetitors: Math.min(
        Math.max(1, Number(config.maxCompetitors) || DEFAULT_CONFIG.maxCompetitors),
        BOUNDS.maxCompetitors,
      ),
    };

    this.health = { state: 'not_checked', message: 'OI health has not been checked yet.' };
    this.clock = clock;
    this.logger = logger;

    // The base URL is validated ONCE, at construction. It comes from main-process
    // configuration only: there is no code path, here or in the IPC layer, that
    // accepts a base URL from the renderer or from a research request body.
    const checked = validateServiceBaseUrl(String(this.config.baseUrl || ''), {
      allowLocalhost: this.config.allowLocalhost !== false,
    });
    if (!checked.ok) {
      this.config.enabled = false;
      this.health = { state: 'misconfigured', message: `OI base URL rejected: ${checked.reason}` };
      this.baseUrl = null;
    } else {
      this.baseUrl = checked.base;
    }
    this.initialBaseUrl = this.baseUrl;
    // I4: a supervisor may close the gate (managed service stopped, crashed, not set
    // up, turned off). A closed gate answers with the supervisor's own plain message.
    this.gate = null;
    this.inflightResearch = 0;
  }

  /**
   * I4 - point the gateway at the service the supervisor launched (main process only;
   * there is no IPC path to this). `port` is a loopback port; `authToken` is the managed
   * child's per-launch token, or null for an external developer service (which never
   * receives ZTech's token). `port: null` restores the configured destination.
   */
  reconfigure({ port = null, authToken = null } = {}) {
    if (port === null) {
      this.baseUrl = this.initialBaseUrl;
    } else {
      const n = Number(port);
      if (!Number.isInteger(n) || n < 1 || n > 65535) throw new TypeError('reconfigure: port must be an integer 1-65535');
      this.baseUrl = `http://127.0.0.1:${n}`;
    }
    this.#authToken = typeof authToken === 'string' && authToken ? authToken : null;
    this.health = { state: 'not_checked', message: 'OI health has not been checked yet.' };
  }

  /** Whether this gateway currently sends a bearer token. Never the token itself. */
  get authenticated() { return this.#authToken !== null; }

  /** I4 - `fn()` returns null when OI may be called, else the plain reason it may not. */
  setGate(fn) { this.gate = typeof fn === 'function' ? fn : null; }

  gateReason() {
    if (!this.gate) return null;
    try {
      const r = this.gate();
      return typeof r === 'string' && r ? r : null;
    } catch {
      return 'Opportunity Intelligence is unavailable.';
    }
  }

  get enabled() { return Boolean(this.config.enabled && this.baseUrl); }

  /** True when ZTech can legitimately try OI at all. */
  get usable() { return this.enabled && this.health.state !== 'misconfigured'; }

  /** Report the reason ZTech cannot use OI right now, in one sentence. */
  unavailableReason() {
    if (!this.config.enabled) return 'Opportunity Intelligence is disabled in configuration.';
    if (!this.baseUrl) return this.health.message || 'Opportunity Intelligence base URL is not usable.';
    return null;
  }

  // --- transport -------------------------------------------------------------

  /**
   * One bounded HTTP call. Never throws for a network or protocol problem:
   * an unreachable service is a normal, expected state that must not propagate
   * as an exception into ZTech's startup or into any outreach path.
   */
  async call(route, { method = 'GET', body, timeoutMs, signal } = {}) {
    if (!this.usable) {
      return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    }
    const closed = this.gateReason();
    if (closed) return { ok: false, state: 'unavailable', error: closed };
    const url = `${this.baseUrl}${route}`;
    const budget = timeoutMs || (route === ROUTES.health ? this.config.healthTimeoutMs : this.config.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    if (timer.unref) timer.unref();
    const onOuterAbort = () => controller.abort();
    if (signal) signal.addEventListener('abort', onOuterAbort, { once: true });

    try {
      const init = {
        method,
        // Never follow a redirect: a compromised or misconfigured local service
        // must not be able to bounce ZTech at an unrelated origin, and no
        // credential is attached to these calls anyway.
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: controller.signal,
      };
      // I4: only a MANAGED child ever has a token, and only it receives one.
      if (this.#authToken && route !== ROUTES.health) init.headers.authorization = `Bearer ${this.#authToken}`;
      if (body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      const res = await this.fetchImpl(url, init);
      const text = await readBounded(res, BOUNDS.maxResponseBytes);
      if (text.bytes_exceeded) {
        return { ok: false, state: 'invalid_response', error: 'OI response exceeded the size bound' };
      }
      let parsed = null;
      if (text.body) {
        try {
          parsed = JSON.parse(text.body);
        } catch {
          return { ok: false, state: 'invalid_response', error: 'OI returned a non-JSON body', status: res.status };
        }
      }
      if (!res.ok) {
        return { ok: false, state: 'unavailable', status: res.status, error: describeHttp(res.status, parsed), body: parsed };
      }
      return { ok: true, status: res.status, body: parsed };
    } catch (e) {
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        state: 'unavailable',
        error: aborted ? `OI did not respond within ${budget}ms` : `OI is not reachable: ${describeNetError(e)}`,
        cause: e && e.name,
      };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onOuterAbort);
    }
  }

  // --- health / capability ---------------------------------------------------

  /**
   * Probe OI. This is the only call ZTech makes during startup, and a failure
   * here is swallowed by design: ZTech must start and work regardless.
   */
  async checkHealth() {
    if (!this.usable) {
      this.health = { state: this.config.enabled ? 'misconfigured' : 'disabled', message: this.unavailableReason() };
      return this.health;
    }
    const res = await this.call(ROUTES.health);
    if (!res.ok) {
      this.health = { state: res.state, message: res.error, checked_at: this.clock().toISOString() };
      return this.health;
    }
    const body = res.body || {};
    if (body.status !== 'ok' || typeof body.schema_version !== 'string') {
      this.health = { state: 'invalid_response', message: 'OI health payload is not the OI contract', checked_at: this.clock().toISOString() };
      return this.health;
    }
    this.health = {
      state: 'available',
      message: 'Opportunity Intelligence is reachable.',
      schema_version: body.schema_version,
      checked_at: this.clock().toISOString(),
    };
    return this.health;
  }

  /** Capability description straight from the engine. OI's own words, not ours. */
  async describeEngine() {
    const res = await this.call(ROUTES.engine);
    if (!res.ok) return { ok: false, state: res.state, error: res.error };
    const body = res.body || {};
    return {
      ok: true,
      engine: typeof body.engine === 'string' ? body.engine : null,
      schema_version: typeof body.schema_version === 'string' ? body.schema_version : null,
      providers: Array.isArray(body.providers) ? body.providers : [],
      configuration: body.configuration && typeof body.configuration === 'object' ? body.configuration : {},
    };
  }

  // --- research --------------------------------------------------------------

  /**
   * Ask OI to research a prospect.
   *
   * The prospect payload is built HERE from the lead's own identity. The caller
   * supplies lead id / company / domain; it never supplies a destination URL,
   * a provider name or a credential. `options` is a closed whitelist.
   *
   * @returns {{ok:true, report:object} | {ok:false, state:string, error:string}}
   */
  async requestResearch({ leadId, companyName, domain, location = null, industry = null, options = {}, signal } = {}) {
    if (!this.usable) return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    const company = cleanText(companyName, 300);
    if (!company) return fail('badInput', 'companyName is required');
    let dom = null;
    if (domain != null && String(domain).trim() !== '') {
      dom = normalizeDomainForOi(String(domain));
      if (!dom) return fail('badInput', 'domain is not a public hostname');
    }
    const payload = {
      prospect: {
        company_name: company,
        domain: dom,
        location: cleanText(location, 300),
        industry: cleanText(industry, 200),
      },
      options: whitelistOptions(options),
    };
    // Counted so a supervisor never restarts the service under a research request.
    this.inflightResearch += 1;
    let res;
    try {
      res = await this.call(ROUTES.research, { method: 'POST', body: payload, signal });
    } finally {
      this.inflightResearch -= 1;
    }
    return this.#reportOrError(res, { leadId, company, domain: dom });
  }

  /** Candidate competitors only. OI still decides what a competitor is. */
  async discoverCompetitors({ companyName, domain, maxCompetitors, signal } = {}) {
    if (!this.usable) return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    const company = cleanText(companyName, 300);
    if (!company) return fail('badInput', 'companyName is required');
    const n = Math.min(Math.max(1, Number(maxCompetitors) || this.config.maxCompetitors), this.config.maxCompetitors);
    const res = await this.call(ROUTES.discover, {
      method: 'POST',
      body: {
        prospect: { company_name: company, domain: domain ? normalizeDomainForOi(String(domain)) : null },
        max_competitors: n,
      },
      signal,
    });
    if (!res.ok) return { ok: false, state: res.state, error: res.error, status: res.status };
    return { ok: true, discovery: res.body };
  }

  /** Canonical report retrieval by research_id. */
  async getReport(researchId, { sections = null, signal } = {}) {
    if (!this.usable) return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    const id = String(researchId == null ? '' : researchId);
    if (!OI_ID.pattern.test(id)) return fail('badInput', 'researchId is not an OI research id');
    const route = ROUTES.report(id) + (Array.isArray(sections) && sections.length ? `?sections=${encodeURIComponent(sections.filter(isSectionName).join(','))}` : '');
    const res = await this.call(route, { signal });
    return this.#reportOrError(res, { researchId: id });
  }

  /** Re-run OI's own opportunity analysis over a stored report. */
  async analyzeReport(researchId, { signal } = {}) {
    if (!this.usable) return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    const id = String(researchId == null ? '' : researchId);
    if (!OI_ID.pattern.test(id)) return fail('badInput', 'researchId is not an OI research id');
    const res = await this.call(ROUTES.analyze(id), { method: 'POST', signal });
    if (!res.ok) return { ok: false, state: res.state, error: res.error, status: res.status };
    return { ok: true, analysis: res.body };
  }

  /** OI's research timeline. Distinct from ZTech's operational Activity ledger. */
  async getTimeline({ researchId = null, entityKey = null, signal } = {}) {
    if (!this.usable) return { ok: false, state: this.config.enabled ? 'misconfigured' : 'disabled', error: this.unavailableReason() };
    const qs = [];
    if (researchId != null && String(researchId) !== '') {
      const id = String(researchId);
      if (!OI_ID.pattern.test(id)) return fail('badInput', 'researchId is not an OI research id');
      qs.push(`research_id=${encodeURIComponent(id)}`);
    }
    if (entityKey != null && String(entityKey) !== '') {
      // OI's timeline filters on research_id, domain or company_name - never on
      // an entity_key. `dom:<host>` is the one entity_key shape that maps onto a
      // real OI filter, so that is the only one accepted; anything else is
      // refused rather than silently turned into a company name search.
      const k = String(entityKey);
      if (!k.startsWith('dom:')) return fail('badInput', 'only a dom: entity key can be used as a timeline filter');
      const host = normalizeDomainForOi(k.slice(4));
      if (!host) return fail('badInput', 'the dom: entity key is not a public hostname');
      qs.push(`domain=${encodeURIComponent(host)}`);
    }
    const res = await this.call(`${ROUTES.timeline}${qs.length ? `?${qs.join('&')}` : ''}`, { signal });
    if (!res.ok) return { ok: false, state: res.state, error: res.error, status: res.status };
    const body = res.body || {};
    const events = Array.isArray(body.events) ? body.events.slice(0, BOUNDS.maxTimelineEvents) : [];
    return { ok: true, timeline: { ...body, events } };
  }

  // --- response handling -----------------------------------------------------

  /**
   * Validate a report before ZTech believes it. A report that fails the contract
   * is rejected and reported as `invalid_response`: it is never partially
   * applied and never rendered as if it were complete.
   */
  #reportOrError(res, context) {
    if (!res.ok) return { ok: false, state: res.state, error: res.error, status: res.status, oiError: oiErrorOf(res.body) };
    const report = res.body;
    const check = validateIntelligenceReport(report);
    if (!check.valid) {
      return {
        ok: false,
        state: 'invalid_response',
        error: 'OI returned something that is not a valid IntelligenceReport',
        errors: check.errors,
      };
    }
    return {
      ok: true,
      report,
      providers: summariseProviders(report),
      context,
    };
  }
}

// --- helpers -----------------------------------------------------------------

function fail(code, message) {
  return { ok: false, state: 'invalid_input', error: message, code };
}

function cleanText(v, max) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Reuse ZTech's existing public-hostname rule so OI never receives a private,
 * reserved or IP-literal domain. This is the same normalisation the Zuni-SEO
 * path uses, deliberately: one definition of "safe target domain".
 */
function normalizeDomainForOi(input) {
  const d = normalizeDomain(input);
  return d.ok ? d.host : null;
}

/**
 * The wire contract, mirrored from the OI service's own models. OI declares
 * `model_config = ConfigDict(extra="forbid")`, so ANY key not listed here is a
 * 422 from OI, not something OI ignores. Keep this in lock-step with:
 *   G:\ZTech-Services\opportunity-intelligence\src\ztech_oi\domain\models.py
 *     class ProspectInput   company_name, domain, location, industry,
 *                           products_services, known_competitors, icp
 *     class ResearchOptions max_competitors (0..5), discover_competitors,
 *                           providers, idempotency_key
 *
 * `lead_id` is deliberately NOT sent to OI. The lead <-> research_id association
 * is ZTech's, held in OpportunityAssociationStore; OI has no lead concept.
 */
const OI_PROSPECT_FIELDS = Object.freeze(['company_name', 'domain', 'location', 'industry', 'products_services']);
const OI_OPTION_FIELDS = Object.freeze(['max_competitors', 'discover_competitors', 'providers', 'idempotency_key']);
const OI_MAX_COMPETITORS = 5;
const OI_MAX_PROVIDER_LIST = 5;

/** Closed whitelist. Anything a caller adds that is not listed here is dropped. */
function whitelistOptions(input) {
  const out = {};
  const src = input && typeof input === 'object' ? input : {};
  const bool = (k) => (typeof src[k] === 'boolean' ? { [k]: src[k] } : {});
  const int = (k, max) => {
    const n = Number(src[k]);
    return Number.isInteger(n) && n >= 0 ? { [k]: Math.min(n, max) } : {};
  };
  const str = (k, maxLen) => {
    const s = src[k];
    if (typeof s !== 'string') return {};
    const t = s.trim().slice(0, maxLen);
    return t ? { [k]: t } : {};
  };
  Object.assign(out, bool('discover_competitors'), int('max_competitors', OI_MAX_COMPETITORS),
    str('providers', OI_MAX_PROVIDER_LIST), str('idempotency_key', 128));
  return out;
}

function isSectionName(s) {
  return typeof s === 'string' && /^[a-z_]{1,40}$/.test(s);
}

async function readBounded(res, maxBytes) {
  let size = 0;
  let body = '';
  const declared = res.headers && typeof res.headers.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(declared) && declared > maxBytes) return { body: null, bytes_exceeded: true };
  if (typeof res.text !== 'function') return { body: null, bytes_exceeded: false };
  const text = await res.text();
  size = Buffer.byteLength(String(text), 'utf8');
  if (size > maxBytes) return { body: null, bytes_exceeded: true };
  return { body: String(text), bytes_exceeded: false };
}

/**
 * I5: the three facts ZTech needs from an OI error body to settle a refresh intent - the
 * stable code, retryable, and whether it is a replay of a stored outcome. Nothing else
 * from the body is kept (no message text, no details beyond the replay flag).
 */
function oiErrorOf(body) {
  if (!body || typeof body !== 'object' || typeof body.error !== 'string') return null;
  const code = /^[A-Z_]{2,40}$/.test(body.error) ? body.error : null;
  if (!code) return null;
  return {
    code,
    retryable: body.retryable === true,
    replay: Boolean(body.details && typeof body.details === 'object' && body.details.idempotent_replay === true),
  };
}

function describeHttp(status, parsed) {
  const detail = parsed && typeof parsed === 'object'
    ? (parsed.message || parsed.detail || parsed.error)
    : null;
  if (status === 404) return 'OI has no such report (404).';
  if (status === 400) return `OI rejected the request as invalid${detail ? `: ${truncate(String(detail))}` : '.'}`;
  if (status === 429) return 'OI is rate limited (429).';
  if (status === 401 || status === 403) return `OI refused the request (${status}).`;
  if (status >= 500) return `OI reported a server error (${status}).`;
  return `OI responded with HTTP ${status}${detail ? `: ${truncate(String(detail))}` : '.'}`;
}

function describeNetError(e) {
  const m = (e && e.message) || String(e);
  if (/ECONNREFUSED|ECONNRESET|EPIPE/.test(m)) return 'connection refused';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return 'host not found';
  if (/timeout|abort/i.test(m)) return 'request timed out';
  return truncate(m, 120);
}

function truncate(s, n = 200) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

module.exports = {
  OpportunityIntelligenceGateway,
  ROUTES,
  BOUNDS,
  DEFAULT_CONFIG,
  OI_ID,
  SNAP_ID,
  ENTITY_KEY,
  OI_PROSPECT_FIELDS,
  OI_OPTION_FIELDS,
  OI_MAX_COMPETITORS,
};