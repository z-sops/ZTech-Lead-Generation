'use strict';

const { assertValid, S } = require('../core/validate');
const { publicError, ForbiddenError, ValidationError } = require('../core/errors');

/**
 * Opportunity Intelligence channels.
 *
 * Every channel here is a READ, plus ONE explicitly human-triggered research
 * request. The security properties that matter:
 *
 *   - NO CHANNEL ACCEPTS A URL. Not the OI base URL, not a prospect website, not
 *     a redirect target. The destination is configured once in the main process
 *     and every route path is fixed in code in the gateway. There is no
 *     `baseUrl`, `url`, `endpoint` or `host` property in any schema below, and
 *     because every schema is additionalProperties:false, a payload carrying one
 *     is REFUSED rather than ignored.
 *   - NO CHANNEL ACCEPTS A CREDENTIAL. There is no key, token or provider name in
 *     any schema. OI's provider secrets live in the OI process environment and
 *     never cross this boundary in either direction.
 *   - NO CHANNEL SENDS ANYTHING. There is no send, approve, schedule, queue or
 *     campaign channel on this bridge. OI is research context only.
 *   - UNAVAILABLE IS NOT AN ERROR. A stopped OI service produces
 *     `{ ok: true, data: { available: false, ... } }` so the renderer renders an
 *     honest "unavailable" panel instead of a crash or a spinner that never ends.
 */
const CHANNELS = Object.freeze({
  HEALTH: 'lead-intel:opportunity-health',
  ENGINE: 'lead-intel:opportunity-engine',
  REQUEST: 'lead-intel:opportunity-request',
  REPORT: 'lead-intel:opportunity-report',
  LATEST: 'lead-intel:opportunity-latest',
  ASSOCIATIONS: 'lead-intel:opportunity-associations',
  PITCH_CONTEXT: 'lead-intel:opportunity-pitch-context',
});

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** An OI research id. Closed pattern: the renderer cannot point OI at an arbitrary store path. */
const OI_RESEARCH_ID = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: /^res_[0-9]{8}[0-9]{6}_[a-f0-9]{8,32}$/,
};

const INPUT_SCHEMAS = Object.freeze({
  // No parameters at all. The renderer cannot influence the destination.
  [CHANNELS.HEALTH]: obj({}),
  [CHANNELS.ENGINE]: obj({}),
  // The renderer says WHICH LEAD and nothing else. Identity, domain and options
  // are all derived in the main process.
  [CHANNELS.REQUEST]: obj({ leadId: S.leadId, force: { type: 'boolean' } }, ['leadId']),
  [CHANNELS.REPORT]: obj({ leadId: S.leadId, researchId: OI_RESEARCH_ID }, ['researchId']),
  [CHANNELS.LATEST]: obj({ leadId: S.leadId }, ['leadId']),
  [CHANNELS.ASSOCIATIONS]: obj({ leadId: S.leadId }, ['leadId']),
  [CHANNELS.PITCH_CONTEXT]: obj({ leadId: S.leadId }, ['leadId']),
});

/** True when a renderer payload tried to smuggle a destination or a credential. */
const FORBIDDEN_RENDERER_KEYS = Object.freeze([
  'baseUrl', 'base_url', 'url', 'endpoint', 'host', 'hostname', 'origin', 'address',
  'apiKey', 'api_key', 'token', 'secret', 'credential', 'password', 'auth',
  'providerKey', 'braveApiKey', 'serperApiKey', 'llmApiKey', 'metaAccessToken', 'serpapiKey', 'xBearerToken',
]);

/**
 * Fail loudly on a smuggled key. The schema already refuses it; this exists so
 * the refusal is named in tests and in a log line rather than being an anonymous
 * "additionalProperties" validation error.
 */
function assertNoDestination(input, channel) {
  if (!input || typeof input !== 'object') return;
  for (const key of FORBIDDEN_RENDERER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      // A ZTech-authored ValidationError, not a bare Error: publicError only
      // exposes messages that came from ZTech code, and this one is safe to show.
      throw new ValidationError(`${channel} does not accept ${key}`, [{
        path: key,
        message: 'the OI destination and credentials are main-process configuration and are never accepted from the renderer',
      }]);
    }
  }
}

/**
 * The renderer never supplies the lead view. Main resolves it from the store, so
 * a compromised renderer cannot invent a company name or domain to research.
 */
async function resolveLeadView(leadSource, leadId) {
  if (!leadSource || typeof leadSource.get !== 'function') return {};
  try {
    const view = await leadSource.get(leadId);
    return view && typeof view === 'object' ? view : {};
  } catch {
    return {};
  }
}

function registerOpportunityIpc({ ipcMain, opportunity, isTrustedSender, leadSource = null, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!opportunity || typeof opportunity.healthView !== 'function') throw new TypeError('opportunity service is required');

  const registered = [];

  const handle = (channel, fn) => {
    const schema = INPUT_SCHEMAS[channel];
    if (!schema) throw new Error(`No input schema for ${channel}`);
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertNoDestination(args, channel);
        assertValid(schema, args, channel);
        const data = await fn(args);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[opportunity-intelligence] ${channel} failed: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };

  handle(CHANNELS.HEALTH, () => opportunity.healthView());
  handle(CHANNELS.ENGINE, () => opportunity.describeEngine());
  handle(CHANNELS.REQUEST, async (a) => {
    const leadView = await resolveLeadView(leadSource, a.leadId);
    // `force` is a ZTech-side intent, not an OI option: OI has no "force" field
    // (ResearchOptions is extra="forbid") and mints a new research_id per run
    // anyway. Every REQUEST is therefore already a fresh OI run; `force` is
    // recorded for the caller's benefit and adds nothing to the wire payload.
    return opportunity.researchForLead({ leadId: a.leadId, leadView, force: Boolean(a.force), options: {} });
  });
  handle(CHANNELS.REPORT, (a) => opportunity.reportForResearchId({ leadId: a.leadId, researchId: a.researchId }));
  handle(CHANNELS.LATEST, (a) => opportunity.latestForLead({ leadId: a.leadId }));
  handle(CHANNELS.ASSOCIATIONS, (a) => opportunity.associationsForLead({ leadId: a.leadId }));
  handle(CHANNELS.PITCH_CONTEXT, async (a) => {
    const leadView = await resolveLeadView(leadSource, a.leadId);
    return opportunity.pitchContextForLead({ leadId: a.leadId, leadView });
  });

  return registered;
}

/**
 * Used when the service could not be constructed at all (misconfigured base URL
 * at boot, for example). Answers every channel honestly instead of leaving the
 * renderer with an unhandled invoke.
 */
function registerUnavailableOpportunityIpc({ ipcMain, isTrustedSender, reason = 'Opportunity Intelligence is not configured.', logger = console }) {
  const registered = [];
  for (const channel of Object.values(CHANNELS)) {
    ipcMain.handle(channel, async (event) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        return { ok: true, data: { available: false, state: 'unavailable', message: reason, affects_outreach: false } };
      } catch (e) {
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  }
  if (logger && logger.warn) logger.warn(`[opportunity-intelligence] channels registered as unavailable: ${reason}`);
  return registered;
}

module.exports = {
  CHANNELS,
  INPUT_SCHEMAS,
  FORBIDDEN_RENDERER_KEYS,
  registerOpportunityIpc,
  registerUnavailableOpportunityIpc,
  assertNoDestination,
  OI_RESEARCH_ID,
};