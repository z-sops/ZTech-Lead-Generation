const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } = require('electron');
const path = require('path');
const { AccountStore, normalizeListQuery } = require('./src/main/accountStore');
const { logger } = require('./src/main/logger');
const { ProviderManager } = require('./src/main/providers/providerManager');
const { CoreClawAdapter } = require('./src/main/providers/coreclawAdapter');
const { migrateLegacySettingsToProviders } = require('./src/main/providers/legacySettingsMigration');
const credentialVault = require('./src/main/credentialVault');
const prospectResearch = require('./src/main/prospect-research/research-service');
const { registerResearchIpc, ALL_CHANNELS: RESEARCH_CHANNELS } = require('./src/main/prospect-research/research-ipc');
const { createTrustedSender } = require('./src/main/prospect-research/trusted-sender');
// F8: the Lead Intelligence ICP contract (pure, deterministic; no LI runtime).
const { targetToIcp, evaluateIcpFit } = require('./src/main/lead-intelligence/icp/icpFit');
const { toLeadView } = require('./src/main/lead-intelligence/contracts/leadView');
// A10: the Lead Intelligence outreach runtime (pitch + gate) on the shared db.
const { initializeLeadIntelligenceRuntime } = require('./src/main/lead-intelligence/lead-intelligence-runtime');
const { registerUnavailableOpportunityIpc } = require('./src/main/lead-intelligence/opportunity');
const { createOiProviderConfig } = require('./src/main/lead-intelligence/opportunity/oiProviderConfig');
const { registerOiConfigIpc } = require('./src/main/lead-intelligence/opportunity/oi-config-ipc');
const { OpportunityServiceSupervisor } = require('./src/main/lead-intelligence/opportunity/OpportunityServiceSupervisor');
const { registerOiServiceIpc } = require('./src/main/lead-intelligence/opportunity/oi-service-ipc');
const { createOutreachSettings } = require('./src/main/lead-intelligence/outreach/outreachSettings');
const { registerOutreachSettingsIpc } = require('./src/main/lead-intelligence/outreach/outreach-settings-ipc');
const { registerOutreachIpc, CHANNELS: LEAD_INTEL_CHANNELS } = require('./src/main/lead-intelligence/outreach-ipc');
const { registerTimelineIpc } = require('./src/main/lead-intelligence/timeline/timeline-ipc');
const { registerTrustIpc } = require('./src/main/lead-intelligence/trust/trust-ipc');

let mainWindow = null;
let providerManager = null;
let accountStore = null;
let researchService = null;
let researchClosing = false;
let researchTrustedSender = null;
// F6: the same trusted-sender rule, applied to the Lists channels.
let listsTrustedSender = null;
// A10: Lead Intelligence runtime handle + the trusted sender for its channels.
let leadIntelRuntime = null;
let leadIntelIpc = null;
let leadIntelTrustedSender = null;
// I3: Opportunity Intelligence provider configuration (sealed keys, main process only).
let oiProviderConfig = null;
// I4: the one supervisor of the local OI service process (managed / external / off).
let oiSupervisor = null;
let oiQuitDone = false;
// F26: the writer for the outreach configuration F22-F25 read (keys sealed, write-only).
let outreachSettings = null;
// F23: the electron-store instance from initServices, kept so the Resend transport can
// read the customer's own API credential at send time - inside the main process only.
// No key is ever copied out of this store into code, config objects or the renderer.
let electronStore = null;

const isDev = process.env.NODE_ENV === 'development';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow === null) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch (err) {
    logger.warn('app', 'second-instance focus failed', { error: err.message });
  }
});

process.on('uncaughtException', (err) => {
  try {
    logger.error('process', 'uncaughtException', { error: err.message, stack: err.stack });
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error('process', 'unhandledRejection', { error: String(reason) });
  } catch {}
});

const MAX_KEY_LENGTH = 500;

function invalidParams(message) {
  const err = new Error(message);
  err.invalidParams = true;
  return err;
}

function rejectLog(channel, message) {
  logger.warn('ipc', `validation rejected: ${channel}`, { error: message });
}

function rejectEnvelope(channel, message) {
  rejectLog(channel, message);
  return { success: false, error: message };
}

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidParams(`Invalid params: ${name} (object required)`);
  }
}

function assertOptionalString(value, name, maxLength) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string') throw invalidParams(`Invalid params: ${name} (string required)`);
  if (value.length > maxLength) throw invalidParams(`Invalid params: ${name} (max ${maxLength} chars)`);
}

function validateProxyUrl(proxyUrl) {
  if (typeof proxyUrl !== 'string') throw invalidParams('Invalid params: proxyUrl (string required)');
  if (!proxyUrl) return '';
  try {
    const parsed = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'socks5:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw invalidParams('Invalid params: proxyUrl (expected http/https/socks5 URL)');
  }
  return proxyUrl;
}

async function applyProxyConfiguration(proxyUrl) {
  try {
    if (!session || !session.defaultSession || typeof session.defaultSession.setProxy !== 'function') {
      logger.warn('proxy', 'proxy configuration skipped', { reason: 'session-unavailable' });
      return { applied: false, reason: 'session-unavailable' };
    }
    const proxyRules = proxyUrl ? validateProxyUrl(proxyUrl) : '';
    await session.defaultSession.setProxy(proxyRules ? { proxyRules } : { mode: 'direct' });
    logger.info('proxy', 'proxy configuration applied', { hasProxy: !!proxyRules });
    return { applied: true };
  } catch (err) {
    logger.warn('proxy', 'proxy configuration failed', { error: err.message });
    return { applied: false, reason: err.message };
  }
}

function validateSettingsPayload(settings) {
  assertPlainObject(settings, 'settings');
  const out = { apiKey: '', taskKey: '', proxyUrl: '', clearApiKey: false, clearTaskKey: false };
  for (const key of ['apiKey', 'taskKey', 'proxyUrl']) {
    const value = settings[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw invalidParams(`Invalid settings: ${key} (string required)`);
    if (value.length > MAX_KEY_LENGTH) throw invalidParams(`Invalid settings: ${key} (max ${MAX_KEY_LENGTH} chars)`);
    out[key] = value;
  }
  for (const flag of ['clearApiKey', 'clearTaskKey']) {
    const value = settings[flag];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'boolean') throw invalidParams(`Invalid settings: ${flag} (boolean required)`);
    out[flag] = value;
  }
  out.proxyUrl = validateProxyUrl(out.proxyUrl);
  // A8: the only user-editable research settings are the Zuni-SEO base URL and,
  // optionally, the transport. Every other research value stays a code default.
  if (settings.research !== undefined && settings.research !== null) {
    assertPlainObject(settings.research, 'settings.research');
    const research = {
      baseUrl: prospectResearch.validateBaseUrl(settings.research.baseUrl),
      transport: prospectResearch.validateTransport(settings.research.transport)
    };
    out.research = research;
  }
  return out;
}

function validateSubmitShape(params) {
  assertPlainObject(params, 'params');

  if (!Array.isArray(params.keywords)) {
    throw invalidParams('Invalid params: keywords (array required)');
  }
  for (const keyword of params.keywords) {
    if (typeof keyword !== 'string') throw invalidParams('Invalid params: keywords (strings only)');
  }
  const keywords = params.keywords.map(k => k.trim()).filter(k => k.length > 0);
  if (keywords.length < 1) throw invalidParams('Invalid params: keywords (at least one non-empty keyword)');
  if (keywords.length > 50) throw invalidParams('Invalid params: keywords (max 50)');
  for (const keyword of keywords) {
    if (keyword.length > 200) throw invalidParams('Invalid params: keywords (max 200 chars each)');
  }
  params.keywords = keywords;

  return params;
}

function validateNumbersPayload(numbers) {
  if (!Array.isArray(numbers)) throw invalidParams('Invalid params: numbers (array required)');
  if (numbers.length > 50000) throw invalidParams('Invalid params: numbers (max 50000)');
  numbers.forEach((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw invalidParams(`Invalid params: numbers[${i}]`);
    if (typeof n.phone !== 'string' || !n.phone.trim() || n.phone.length > 50) {
      throw invalidParams(`Invalid params: numbers[${i}].phone`);
    }
    if (n.id !== undefined && n.id !== null && (typeof n.id !== 'string' || n.id.length > 100)) {
      throw invalidParams(`Invalid params: numbers[${i}].id`);
    }
    for (const key of ['source', 'keyword', 'collectedAt', 'title', 'website', 'email', 'address', 'runSlug']) {
      assertOptionalString(n[key], `numbers[${i}].${key}`, 500);
    }
    if (n.status !== undefined && n.status !== null && n.status !== 'pending') {
      throw invalidParams(`Invalid params: numbers[${i}].status`);
    }
  });
  return numbers;
}

function validateIdList(ids) {
  if (!Array.isArray(ids)) throw invalidParams('Invalid params: ids (array required)');
  if (ids.length > 10000) throw invalidParams('Invalid params: ids (max 10000)');
  ids.forEach((id, i) => {
    if (typeof id !== 'string' || !id || id.length > 100) {
      throw invalidParams(`Invalid params: ids[${i}]`);
    }
  });
  return ids;
}

// B6 user-owned lead fields. This is the authoritative validator: the
// renderer is never trusted, so every bound below is enforced here before
// the payload reaches the store. Limits are compile-time constants shared by
// contract, not by import, so main and store cannot drift silently.
const LEAD_QUALIFICATION_VALUES = ['unqualified', 'qualified'];
const MAX_LEAD_TAGS = 20;
const MAX_LEAD_TAG_LENGTH = 50;
const MAX_LEAD_NOTES_LENGTH = 5000;

// Validates one collector:update-lead payload and returns the normalised
// { id, qualification, tags, notes } written to storage. Tags are trimmed,
// empties rejected and deduplicated case-insensitively with the first
// occurrence kept, so the renderer may send optimistic input.
function validateLeadUpdatePayload(payload) {
  assertPlainObject(payload, 'lead update');
  // Same bounds and messages as the B3 single-lead id predicate.
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
    throw invalidParams('Invalid params: id (non-empty required)');
  }
  if (!LEAD_QUALIFICATION_VALUES.includes(payload.qualification)) {
    throw invalidParams('Invalid params: qualification (unqualified|qualified required)');
  }
  if (!Array.isArray(payload.tags)) {
    throw invalidParams('Invalid params: tags (array required)');
  }
  if (payload.tags.length > MAX_LEAD_TAGS) {
    throw invalidParams(`Invalid params: tags (max ${MAX_LEAD_TAGS})`);
  }
  const tags = [];
  for (let i = 0; i < payload.tags.length; i++) {
    const raw = payload.tags[i];
    if (typeof raw !== 'string') {
      throw invalidParams(`Invalid params: tags[${i}] (string required)`);
    }
    const tag = raw.trim();
    if (!tag) {
      throw invalidParams(`Invalid params: tags[${i}] (non-empty required)`);
    }
    if (tag.length > MAX_LEAD_TAG_LENGTH) {
      throw invalidParams(`Invalid params: tags[${i}] (max ${MAX_LEAD_TAG_LENGTH} chars)`);
    }
    const key = tag.toLowerCase();
    if (tags.some(existing => existing.toLowerCase() === key)) continue;
    tags.push(tag);
  }
  if (typeof payload.notes !== 'string') {
    throw invalidParams('Invalid params: notes (string required)');
  }
  if (payload.notes.length > MAX_LEAD_NOTES_LENGTH) {
    throw invalidParams(`Invalid params: notes (max ${MAX_LEAD_NOTES_LENGTH} chars)`);
  }
  return { id: payload.id, qualification: payload.qualification, tags, notes: payload.notes };
}

// Validates one collector:update-lead-quality payload and returns the
// normalised { id, ...statuses } to store. A USER ASSERTION about a lead: the
// wording is deliberate, because the app must never present one of these as a
// third-party verification. A partial update is allowed, but at least one
// recognised status field must be present, and any other key is refused.
function validateLeadQualityPayload(payload) {
  assertPlainObject(payload, 'lead quality update');
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
    throw invalidParams('Invalid params: id (non-empty required)');
  }
  const supported = new Set(Object.keys(LEAD_USER_STATUS_VALUES));
  for (const key of Object.keys(payload)) {
    if (key === 'id') continue;
    if (!supported.has(key)) {
      throw invalidParams(`Invalid params: ${key} (unsupported field)`);
    }
  }
  const out = { id: payload.id };
  let provided = 0;
  for (const [field, allowed] of Object.entries(LEAD_USER_STATUS_VALUES)) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    if (!allowed.includes(value)) {
      throw invalidParams(`Invalid params: ${field} (${allowed.join('|')} required)`);
    }
    out[field] = value;
    provided++;
  }
  if (provided === 0) {
    throw invalidParams('Invalid params: no lead status field supplied');
  }
  return out;
}

function validateHistoryPaging(payload) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const limit = p.limit === undefined ? 20 : p.limit;
  const offset = p.offset === undefined ? 0 : p.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidParams('Invalid params: limit (integer 1-100)');
  }
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000) {
    throw invalidParams('Invalid params: offset (integer 0-100000)');
  }
  return { limit, offset };
}

// P1-E duplicate review: the rule vocabulary is an explicit allowlist, exactly
// like the B2 sort identifiers and the P1-C quality filters. A value outside it
// is a validation error, never a silently ignored or interpolated term, and it
// is never used to build SQL.
const DUPLICATE_REVIEW_RULES = ['all', 'canonicalPhone', 'website-host', 'email', 'title+address'];

// Validates the read-only duplicate-review payload. It can only choose which
// deterministic rule to review and how much of it to page through: there is no
// id, no write target and no field that could carry a value to store. Bounds are
// the shared validateHistoryPaging contract.
function validateDuplicateReviewPayload(payload) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const { limit, offset } = validateHistoryPaging(p);
  const rule = p.rule === undefined || p.rule === null ? 'all' : p.rule;
  if (typeof rule !== 'string' || !DUPLICATE_REVIEW_RULES.includes(rule)) {
    throw invalidParams('Invalid params: rule');
  }
  return { rule, limit, offset };
}

// P1-G Collection Quality Report. Run-scoped and read-only: the payload can
// only name a run and page through the result, so nothing here can select which
// leads to read or write anything. The runSlug is gated by the same RFC 3986
// pattern the collection submit path uses.
const QUALITY_REPORT_RUN_SLUG_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;

function validateQualityReportPayload(payload, activeProviderId) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const { limit, offset } = validateHistoryPaging(p);
  if (typeof p.runSlug !== 'string' || !QUALITY_REPORT_RUN_SLUG_PATTERN.test(p.runSlug)) {
    throw invalidParams('Invalid params: runSlug');
  }
  return { runSlug: p.runSlug, providerId: activeProviderId, limit, offset };
}

// P1-G: the run context of a local save. Only a run identifier and the target
// the user applied; both are optional, and an unknown target id is refused
// rather than recorded. Nothing here can carry a value into a lead.
//
// The provider identity is NOT taken from the renderer: it is resolved from the
// registered provider (the same convention settings:save uses), and a renderer
// that supplies one must name the same registered provider or the payload is
// refused. The counters and the report are therefore keyed by the existing
// (providerId, runSlug) job identity.
function validateSaveContext(context, activeProviderId) {
  const out = { runSlug: '', targetId: null, providerId: activeProviderId };
  if (context === undefined || context === null) return out;
  if (typeof context !== 'object' || Array.isArray(context)) {
    throw invalidParams('Invalid params: save context');
  }
  if (context.runSlug !== undefined && context.runSlug !== null && context.runSlug !== '') {
    assertOptionalString(context.runSlug, 'runSlug', 200);
    if (!QUALITY_REPORT_RUN_SLUG_PATTERN.test(context.runSlug)) {
      throw invalidParams('Invalid params: runSlug');
    }
    out.runSlug = context.runSlug;
  }
  if (context.targetId !== undefined && context.targetId !== null && context.targetId !== '') {
    assertOptionalString(context.targetId, 'targetId', 100);
    out.targetId = context.targetId;
  }
  // An optional providerId is accepted only when it names the registered
  // provider this session is actually using; anything else is refused rather
  // than resolved, so the renderer can never redirect a run's counters.
  if (context.providerId !== undefined && context.providerId !== null && context.providerId !== '') {
    assertOptionalString(context.providerId, 'providerId', 100);
    if (context.providerId !== activeProviderId) {
      throw invalidParams('Invalid params: providerId');
    }
  }
  return out;
}

// The registered collection provider, resolved exactly as the settings and
// collection handlers resolve it. An unresolvable registry is reported as an
// empty id: the save itself must still succeed.
function resolveActiveProviderId() {
  try {
    const adapter = providerManager.resolveCollectionProvider();
    return adapter && typeof adapter.providerId === 'string' ? adapter.providerId : '';
  } catch {
    return '';
  }
}

// P1-G: the report reads exactly one run of one provider. The target report
// needs no paging, so it validates the run identifier alone.
function validateQualityReportRunSlug(payload, activeProviderId) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  if (typeof p.runSlug !== 'string' || !QUALITY_REPORT_RUN_SLUG_PATTERN.test(p.runSlug)) {
    throw invalidParams('Invalid params: runSlug');
  }
  return { runSlug: p.runSlug, providerId: activeProviderId };
}

// P1-F Target builder. Targets are user-owned prospecting DEFINITIONS, not
// lead data: none of these three channels can read or write a lead, and none of
// them is reachable from a collection or import payload. The field and status
// vocabularies are explicit allowlists, so an unknown value is a validation
// error and never an interpolated term.
const TARGET_STATUS_VALUES = ['active', 'archived'];
// Only lead fields the current model actually has. Nothing is invented.
const TARGET_FIELD_ALLOWLIST = ['phone', 'title', 'website', 'email', 'address'];
const MAX_TARGET_NAME_LENGTH = 120;
const MAX_TARGET_INDUSTRY_LENGTH = 120;
const MAX_TARGET_TERM_LENGTH = 50;
const MAX_TARGET_TERMS = 20;
const TARGET_LIST_FIELDS = ['businessTypes', 'locations', 'exclusions'];

function validateTargetText(value, field, maxLength, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw invalidParams('Invalid target: ' + field);
    return '';
  }
  if (typeof value !== 'string') throw invalidParams('Invalid target: ' + field);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalidParams('Invalid target: ' + field);
  if (trimmed.length > maxLength) throw invalidParams('Invalid target: ' + field);
  return trimmed;
}

// A CSV-style list: an array of strings or one comma/newline-separated string.
// The store normalises and caps it; here only the shape is checked, so a valid
// list is never rejected for formatting the user is allowed to use.
function assertTargetList(value, field) {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry !== 'string') throw invalidParams('Invalid target: ' + field);
    }
    return;
  }
  if (typeof value !== 'string') throw invalidParams('Invalid target: ' + field);
}

// A criterion set: a subset of the allowlist, in the user's order, without
// duplicates. Anything outside the allowlist is refused, never dropped.
function validateTargetFieldList(value, field) {
  if (value === undefined || value === null) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') throw invalidParams('Invalid target: ' + field);
    const name = entry.trim();
    if (!name) continue;
    if (!TARGET_FIELD_ALLOWLIST.includes(name)) {
      throw invalidParams('Invalid target: ' + field + ': unknown lead field ' + name);
    }
    if (!out.includes(name)) out.push(name);
  }
  if (out.length > TARGET_FIELD_ALLOWLIST.length) throw invalidParams('Invalid target: ' + field);
  return out;
}

// Validates a target create/update payload. createdAt/updatedAt are system-owned
// and are never read from input; id is accepted only to select an existing row,
// never to forge one. Unknown keys are ignored (validateSettingsPayload
// convention).
function validateTargetPayload(payload) {
  assertPlainObject(payload, 'target');
  const out = {};
  if (payload.id !== undefined && payload.id !== null) {
    assertOptionalString(payload.id, 'id', 100);
    if (!payload.id) throw invalidParams('Invalid target: id (non-empty required)');
    out.id = payload.id;
  }
  out.name = validateTargetText(payload.name, 'name', MAX_TARGET_NAME_LENGTH, { required: true });
  out.industry = validateTargetText(payload.industry, 'industry', MAX_TARGET_INDUSTRY_LENGTH);
  // A9: the checked lists are passed through unchanged (an array is copied);
  // the store normalises and caps them. An omitted list stays omitted.
  for (const field of TARGET_LIST_FIELDS) {
    assertTargetList(payload[field], field);
    const value = payload[field];
    if (value !== undefined && value !== null) out[field] = Array.isArray(value) ? value.slice() : value;
  }
  out.requiredFields = validateTargetFieldList(payload.requiredFields, 'requiredFields');
  out.optionalFields = validateTargetFieldList(payload.optionalFields, 'optionalFields');
  for (const name of out.requiredFields) {
    if (out.optionalFields.includes(name)) {
      throw invalidParams('Invalid target: field is both required and optional: ' + name);
    }
  }
  if (payload.status !== undefined && payload.status !== null) {
    if (!TARGET_STATUS_VALUES.includes(payload.status)) throw invalidParams('Invalid target: status');
    out.status = payload.status;
  }
  return out;
}

function validateTargetStatusPayload(payload) {
  assertPlainObject(payload, 'target status');
  assertOptionalString(payload.id, 'id', 100);
  if (!payload.id) throw invalidParams('Invalid target status: id (non-empty required)');
  if (!TARGET_STATUS_VALUES.includes(payload.status)) throw invalidParams('Invalid target status: status');
  return { id: payload.id, status: payload.status };
}

// B2 query layer: the only sort identifiers ever handed to the store.
const NUMBERS_QUERY_SORT_FIELDS = ['collectedAt', 'title', 'phone', 'source', 'keyword'];

// P1-C user-owned lead status vocabularies. These are user assertions, not a
// provider capability: the values mirror the store contract exactly.
const LEAD_USER_STATUS_VALUES = {
  phoneStatus: ['unknown', 'verified', 'unverified', 'invalid'],
  emailStatus: ['unknown', 'verified', 'unverified', 'risky'],
  websiteStatus: ['unknown', 'live', 'dead', 'redirect'],
  businessStatus: ['unknown', 'active', 'closed']
};

// B6/P1-C query layer: derived data-quality filters. These are computed from
// stored column values in the store, so they are allowlisted per filter rather
// than accepted as free strings: an unknown value is a validation error, never
// a silently ignored or interpolated term.
const LEAD_QUALITY_QUERY_FILTERS = {
  phoneQuality: ['valid', 'invalid', 'unknown'],
  emailQuality: ['valid', 'invalid', 'unknown'],
  websiteQuality: ['valid', 'invalid', 'unknown'],
  // Only 'unknown' is derivable today; active/closed are accepted so the
  // vocabulary is stable once a user-provided value exists.
  businessQuality: ['active', 'closed', 'unknown'],
  // Completeness is a count of the five lead fields, reported as "N of 5".
  completeness: ['0', '1', '2', '3', '4', '5']
};

// Validates the optional collector:get-numbers query payload. Paging bounds
// are reused verbatim from validateHistoryPaging; unknown keys are ignored
// (validateSettingsPayload convention); a non-object payload collapses to
// the paging defaults; order is only meaningful together with sort; an
// optional id (B3) restricts the query to a single lead by primary key.
function validateNumbersQuery(payload) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const { limit, offset } = validateHistoryPaging(p);
  const out = { limit, offset };
  assertOptionalString(p.search, 'search', MAX_KEY_LENGTH);
  if (typeof p.search === 'string' && p.search.trim()) out.search = p.search.trim();
  // B3 single-lead lookup: optional exact id (mirrors validateIdList bounds).
  if (p.id !== undefined && p.id !== null) {
    assertOptionalString(p.id, 'id', 100);
    if (!p.id) throw invalidParams('Invalid params: id (non-empty required)');
    out.id = p.id;
  }
  // F6: optional segment scope (additive). Omitted keeps every existing query
  // exactly as before; the store resolves the id to its current membership.
  if (p.segmentId !== undefined && p.segmentId !== null) {
    assertOptionalString(p.segmentId, 'segmentId', 100);
    if (!p.segmentId) throw invalidParams('Invalid params: segmentId (non-empty required)');
    out.segmentId = p.segmentId;
  }
  if (p.filters !== undefined && p.filters !== null) {
    assertPlainObject(p.filters, 'filters');
    const filters = {};
    for (const key of ['status', 'source', 'keyword', 'qualification']) {
      const value = p.filters[key];
      if (value === undefined || value === null) continue;
      assertOptionalString(value, `filters.${key}`, MAX_KEY_LENGTH);
      filters[key] = value;
    }
    for (const [key, allowed] of Object.entries(LEAD_QUALITY_QUERY_FILTERS)) {
      const value = p.filters[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string' || !allowed.includes(value)) {
        throw invalidParams(`Invalid params: filters.${key}`);
      }
      filters[key] = value;
    }
    out.filters = filters;
  }
  if (p.sort !== undefined && p.sort !== null) {
    if (typeof p.sort !== 'string' || !NUMBERS_QUERY_SORT_FIELDS.includes(p.sort)) {
      throw invalidParams('Invalid params: sort');
    }
    out.sort = p.sort;
    out.order = 'asc';
    if (p.order !== undefined && p.order !== null) {
      if (p.order !== 'asc' && p.order !== 'desc') {
        throw invalidParams('Invalid params: order');
      }
      out.order = p.order;
    }
  }
  return out;
}

// === F6 Lists: saved searches and segments ===
// Shape validation at the IPC boundary. Query / rule VOCABULARY is checked by
// the store's normalizeListQuery (the single definition of what a list may
// store), called here too so a bad definition is refused before the store.
const MAX_LIST_NAME_LENGTH = 120;
const MAX_LIST_DESCRIPTION_LENGTH = 500;
const MAX_SEGMENT_MEMBER_IDS = 10000;

function validateListId(value, name) {
  assertOptionalString(value, name, 100);
  if (!value) throw invalidParams(`Invalid params: ${name} (non-empty required)`);
  return value;
}

function validateListText(payload, out, field, maxLength, required) {
  if (payload[field] === undefined) {
    if (required) throw invalidParams(`Invalid params: ${field} (required)`);
    return;
  }
  assertOptionalString(payload[field], field, maxLength);
  if (required && !(typeof payload[field] === 'string' && payload[field].trim())) {
    throw invalidParams(`Invalid params: ${field} (non-empty required)`);
  }
  out[field] = payload[field];
}

function validateListDefinition(value, options) {
  const result = normalizeListQuery(value, options);
  if (!result.ok) throw invalidParams('Invalid params: ' + result.error);
  return result.value;
}

function validateIdArray(value, name) {
  if (!Array.isArray(value)) throw invalidParams(`Invalid params: ${name} (array required)`);
  if (value.length > MAX_SEGMENT_MEMBER_IDS) throw invalidParams(`Invalid params: ${name} (max ${MAX_SEGMENT_MEMBER_IDS})`);
  value.forEach((id, i) => validateListId(id, `${name}[${i}]`));
  return value.slice();
}

function validateSavedSearchPayload(payload) {
  assertPlainObject(payload, 'saved search');
  const out = {};
  const isUpdate = payload.id !== undefined && payload.id !== null;
  if (isUpdate) out.id = validateListId(payload.id, 'id');
  validateListText(payload, out, 'name', MAX_LIST_NAME_LENGTH, !isUpdate);
  validateListText(payload, out, 'description', MAX_LIST_DESCRIPTION_LENGTH, false);
  if (payload.query !== undefined) out.query = validateListDefinition(payload.query, { allowSort: true, label: 'query' });
  return out;
}

function validateSegmentPayload(payload) {
  assertPlainObject(payload, 'segment');
  const out = {};
  const isUpdate = payload.id !== undefined && payload.id !== null;
  if (isUpdate) out.id = validateListId(payload.id, 'id');
  validateListText(payload, out, 'name', MAX_LIST_NAME_LENGTH, !isUpdate);
  validateListText(payload, out, 'description', MAX_LIST_DESCRIPTION_LENGTH, false);
  if (payload.type !== undefined && payload.type !== null) {
    if (payload.type !== 'static' && payload.type !== 'dynamic') throw invalidParams('Invalid params: type');
    out.type = payload.type;
  } else if (!isUpdate) {
    throw invalidParams('Invalid params: type (required)');
  }
  if (payload.memberIds !== undefined && payload.memberIds !== null) out.memberIds = validateIdArray(payload.memberIds, 'memberIds');
  if (payload.rules !== undefined && payload.rules !== null) {
    out.rules = validateListDefinition(payload.rules, { allowTextRules: true, label: 'rules' });
  }
  return out;
}

function validateSegmentMembersPayload(payload) {
  assertPlainObject(payload, 'segment members');
  const out = { id: validateListId(payload.id, 'id') };
  if (payload.add !== undefined && payload.add !== null) out.add = validateIdArray(payload.add, 'add');
  if (payload.remove !== undefined && payload.remove !== null) out.remove = validateIdArray(payload.remove, 'remove');
  if (!out.add && !out.remove) throw invalidParams('Invalid params: add or remove (required)');
  return out;
}

function validateListDeletePayload(payload, name) {
  assertPlainObject(payload, name);
  return { id: validateListId(payload.id, 'id') };
}

// === F8 Intelligence: ICP fit ===
// Read-only. Evaluates stored leads against one stored Target with the Lead
// Intelligence ICP contract exactly as shipped: targetToIcp converts the Target
// (unconvertible settings are reported in `unmapped`, never guessed),
// toLeadView reads the lead record, evaluateIcpFit returns fit / not_fit /
// unknown with per-criterion explanations. No score, no inference, no write,
// no research call, no Lead Intelligence runtime or schema.
function validateIcpPayload(payload) {
  assertPlainObject(payload, 'icp');
  const out = { targetId: validateListId(payload.targetId, 'targetId') };
  if (payload.leadId !== undefined && payload.leadId !== null) out.leadId = validateListId(payload.leadId, 'leadId');
  return out;
}

function icpCriterionView(entry) {
  return {
    id: entry.criterion_id,
    label: entry.label,
    field: entry.field,
    required: entry.required !== false,
    expected: entry.expected === undefined ? null : entry.expected,
    actual: entry.actual === undefined ? null : entry.actual,
    source: entry.source,
    factIds: Array.isArray(entry.fact_ids) ? entry.fact_ids.slice() : [],
    findingIds: Array.isArray(entry.finding_ids) ? entry.finding_ids.slice() : [],
    exclusion: entry.exclusion === true,
    explanation: entry.explanation
  };
}

async function evaluateIcpForTarget({ targetId, leadId }) {
  const targets = await accountStore.listTargets();
  const target = (targets && Array.isArray(targets.rows) ? targets.rows : []).find((row) => row.id === targetId);
  if (!target) return { success: false, error: 'Target not found' };
  const icp = targetToIcp(target);
  let leads;
  if (leadId) {
    const found = await accountStore.queryNumbers({ limit: 1, offset: 0, id: leadId });
    leads = found && Array.isArray(found.rows) ? found.rows : [];
  } else {
    leads = await accountStore.getCollectedNumbers();
  }
  const now = new Date();
  const rows = [];
  for (const lead of Array.isArray(leads) ? leads : []) {
    let fit;
    try {
      fit = evaluateIcpFit({ view: toLeadView(lead), icp, now });
    } catch (err) {
      continue; // a row the contract cannot read is skipped, never given a status
    }
    rows.push({
      leadId: lead.id,
      title: typeof lead.title === 'string' ? lead.title : '',
      phone: typeof lead.phone === 'string' ? lead.phone : '',
      website: typeof lead.website === 'string' ? lead.website : '',
      fitStatus: fit.fitStatus,
      reason: fit.reason,
      matched: fit.matchedCriteria.map(icpCriterionView),
      unmet: fit.unmetCriteria.map(icpCriterionView),
      unknown: fit.unknownCriteria.map(icpCriterionView),
      exclusions: fit.exclusions.map(icpCriterionView)
    });
  }
  return {
    success: true,
    target: { id: target.id, name: target.name, status: target.status },
    icp: {
      criteria: icp.criteria.map((c) => ({ id: c.id, label: c.label, field: c.field, required: c.required !== false })),
      unmapped: Array.isArray(icp.unmapped) ? icp.unmapped.slice() : []
    },
    evaluatedAt: now.toISOString(),
    rows,
    total: rows.length
  };
}

// === B4 local collection-job ledger hooks ===
// Every ledger call is best-effort: the provider-side operation has already
// succeeded when these run, so a ledger persistence failure must never
// change the collection IPC result (it is logged and swallowed instead —
// a reported failure for an accepted run would invite duplicate submits).

// Mirrors the poll-side terminal mapping in the renderer: only the states
// evidenced by the repository are recognised; anything else is non-terminal
// and the ledger stays untouched.
function normalizeJobStatus(rawState) {
  if (rawState === 'succeeded' || rawState === 'completed' || rawState === 'success') return 'succeeded';
  if (rawState === 'failed' || rawState === 'error') return 'failed';
  return null;
}

async function recordJobSubmitted(providerId, shaped, submitResult) {
  try {
    if (!submitResult || submitResult.success !== true) return;
    const runSlug = submitResult.data && submitResult.data.run_slug;
    if (typeof runSlug !== 'string') return;
    await accountStore.insertJob({
      runSlug,
      providerId,
      query: Array.isArray(shaped.keywords) ? shaped.keywords.join(', ') : '',
      startedAt: new Date().toISOString(),
      completedAt: '',
      status: 'running',
      resultCount: null,
      error: ''
    });
  } catch (err) {
    logger.error('job', 'job ledger write failed', { error: err.message });
  }
}

async function recordJobState(providerId, jobId, stateResult) {
  try {
    if (!stateResult || stateResult.success !== true) return;
    const data = stateResult.data && typeof stateResult.data === 'object' ? stateResult.data : {};
    const rawState = data.status !== undefined && data.status !== null ? data.status : data.state;
    const canonical = normalizeJobStatus(rawState);
    if (!canonical) return;
    const errorText = canonical === 'failed' && typeof data.error === 'string' ? data.error : '';
    await accountStore.updateJobState(providerId, jobId, canonical, errorText);
  } catch (err) {
    logger.error('job', 'job ledger state update failed', { error: err.message });
  }
}

async function recordJobResultCount(providerId, jobId, options, result) {
  try {
    if (!result || result.success !== true) return;
    const list = result.data && Array.isArray(result.data.list) ? result.data.list : null;
    if (!list) return;
    const limit = options && Number.isInteger(options.limit) ? options.limit : 100;
    const offset = options && Number.isInteger(options.offset) ? options.offset : 0;
    // Final-page rule: only a short page proves the run's result set ends
    // here. Full pages (including duplicate-page terminations) are not
    // reliable counts and leave resultCount NULL rather than guessing.
    if (list.length >= limit) return;
    await accountStore.setJobResultCount(providerId, jobId, offset + list.length);
  } catch (err) {
    logger.error('job', 'job ledger result count failed', { error: err.message });
  }
}

function createMainWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 760,
    title: 'phone全球获客',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler?.(({ url }) => {
    let protocol = null;
    try {
      protocol = new URL(url).protocol;
    } catch {}
    if (protocol === 'http:' || protocol === 'https:') {
      Promise.resolve()
        .then(() => shell.openExternal(url))
        .catch((err) => logger.warn('app', 'openExternal failed', { url, error: err.message }));
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev) {
      try {
        const devOrigin = new URL(`http://localhost:${process.env.VITE_PORT || 5173}`).origin;
        if (new URL(url).origin === devOrigin) return;
      } catch {}
    }
    event.preventDefault();
  });

  if (isDev) {
    const port = process.env.VITE_PORT || 5173;
    mainWindow.loadURL(`http://localhost:${port}`);
  } else {
    mainWindow.loadFile('index.html');
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    app.quit();
  });

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    try {
      logger.error('renderer', 'render-process-gone', {
        reason: details.reason,
        exitCode: details.exitCode
      });
    } catch {}
  });
}

function persistProviderCredentials(store, providerId, credentials) {
  const providers = store.get('providers', null);
  const existing = providers && typeof providers === 'object' && providers[providerId] && typeof providers[providerId] === 'object'
    ? providers[providerId]
    : {};
  const record = {
    ...existing,
    providerId,
    enabled: existing.enabled !== undefined ? existing.enabled : true,
    configuration: existing.configuration && typeof existing.configuration === 'object' ? existing.configuration : {},
    credentials: {
      apiKey: typeof credentials.apiKey === 'string' ? credentials.apiKey : '',
      taskKey: typeof credentials.taskKey === 'string' ? credentials.taskKey : ''
    }
  };
  store.set('providers', {
    ...(providers && typeof providers === 'object' ? providers : {}),
    [providerId]: record
  });
  return record;
}

function loadProviderCredentials(store, providerId) {
  const providers = store.get('providers', null);
  if (!providers || typeof providers !== 'object') return null;
  const record = providers[providerId];
  if (!record || typeof record !== 'object') return null;
  if (!record.credentials || typeof record.credentials !== 'object') return null;
  return record.credentials;
}

function canRevealCredential(value) {
  if (!credentialVault.isPresent(value)) return false;
  if (!credentialVault.isSealed(value)) return true;
  try {
    return credentialVault.unseal(value).length > 0;
  } catch {
    logger.warn('vault', 'stored credential could not be decrypted');
    return false;
  }
}

async function initServices() {
  accountStore = new AccountStore();
  providerManager = new ProviderManager();
  const adapter = providerManager.register(new CoreClawAdapter());
  const Store = require('electron-store');
  const store = new Store();
  electronStore = store;
  migrateLegacySettingsToProviders(store, adapter.providerId);
  const migration = credentialVault.migrateStoredCredentials(store, adapter.providerId);
  if (migration.status === 'complete') {
    if (migration.sealed > 0 || migration.removed > 0) {
      logger.info('vault', 'credential encryption migration complete', {
        sealed: migration.sealed,
        removed: migration.removed
      });
    }
  } else {
    logger.warn('vault', 'credential encryption migration deferred', {
      status: migration.status,
      reason: migration.reason || 'unknown'
    });
  }
  const credentials = loadProviderCredentials(store, adapter.providerId);
  if (credentials) {
    const plaintext = {};
    for (const field of ['apiKey', 'taskKey']) {
      const raw = credentials[field];
      if (typeof raw !== 'string' || raw === '') continue;
      try {
        plaintext[field] = credentialVault.reveal(raw);
      } catch {
        logger.warn('vault', 'stored credential could not be decrypted', { field });
      }
    }
    if (Object.keys(plaintext).length > 0) {
      providerManager.setCredentials(adapter.providerId, plaintext);
    }
  }
  // The database must be open before prospect research is constructed (A1/A5).
  await accountStore.ready;
}

// A5: constructs the research objects only. It performs NO network I/O, so a
// slow or offline Zuni-SEO server can never delay the main window. gateway.start()
// is called separately and is deliberately not awaited.
function loadResearchSettings() {
  try {
    const Store = require('electron-store');
    const stored = new Store().get('settings', {});
    return stored && typeof stored.research === 'object' && stored.research !== null
      ? stored.research
      : null;
  } catch (err) {
    logger.warn('research', 'stored research settings could not be read', { error: err.message });
    return null;
  }
}

function initResearch() {
  try {
    researchService = prospectResearch.initResearchService({
      accountStore,
      secretsDir: path.join(app.getPath('userData'), 'secrets'),
      clientVersion: app.getVersion(),
      researchSettings: loadResearchSettings(),
      log: (msg, detail) => {
        const fields = (detail && typeof detail === 'object') ? detail : {};
        logger.warn('research', String(msg), fields);
      }
    });
    logger.info('research', 'research service constructed');
  } catch (err) {
    researchService = null;
    logger.error('research', 'research service unavailable', { error: err.message });
  }
}

// Starts the gateway without blocking startup, then prunes quarantined payloads to
// the same retention as research data.
function startResearch() {
  if (!researchService) return;
  researchService.gateway.start()
    .then(() => researchService.quarantine.prune().catch((err) => {
      logger.warn('research', 'quarantine prune failed', { error: err.message });
    }))
    .catch((err) => {
      logger.error('research', 'research start failed', { error: err.message });
    });
}

// A8: the base URL is the only user-editable research setting. When it changes the
// running service is closed and rebuilt, so the app never keeps using the old
// endpoint silently.
async function recreateResearchService() {
  const previous = researchService;
  researchService = null;
  if (previous) {
    try {
      await Promise.race([
        previous.close(),
        new Promise((resolve) => setTimeout(resolve, 3000))
      ]);
    } catch (err) {
      logger.warn('research', 'previous research service did not close cleanly', { error: err.message });
    }
  }
  initResearch();
  startResearch();
}

// A4: the lead's website and name always come from ZTech's own database.
// market/language stay null: the lead schema has no such columns and none are added.
async function loadResearchLead(leadRef) {
  const result = await accountStore.queryNumbers({ limit: 1, offset: 0, id: leadRef });
  const rows = result && Array.isArray(result.rows) ? result.rows : [];
  const lead = rows[0];
  if (!lead) return null;
  const asText = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
  return {
    leadRef: lead.id,
    website: asText(lead.website),
    companyName: asText(lead.title),
    market: null,
    language: null
  };
}

// F7: every stored lead's identity fields, for the read-only research overview.
// Only the four fields the overview shows leave this function.
async function listResearchLeads() {
  const rows = await accountStore.getCollectedNumbers();
  return (Array.isArray(rows) ? rows : []).map((lead) => ({
    id: lead.id, title: lead.title, phone: lead.phone, website: lead.website
  }));
}

// A4/A7: the renderer never names a file. Main opens the dialog and passes the path.
async function pickResearchArtifactFile() {
  try {
    const result = await dialog.showOpenDialog(mainWindow || undefined, {
      title: 'Import Zuni-SEO research file',
      filters: [{ name: 'Zuni-SEO envelope', extensions: ['json'] }],
      properties: ['openFile']
    });
    if (!result || result.canceled) return null;
    const paths = Array.isArray(result.filePaths) ? result.filePaths : [];
    return paths.length > 0 ? paths[0] : null;
  } catch (err) {
    logger.warn('research', 'artifact file dialog failed', { error: err.message });
    return null;
  }
}

// The research IPC handlers are registered once, but A8 replaces the service
// when the base URL changes. They are therefore handed views that resolve the
// CURRENT service on every call, never the instance that existed when they were
// registered. While a replacement is in progress there is no current service,
// and the call is refused rather than sent to the closing one.
function currentResearchService() {
  if (!researchService) throw new Error('The research service is not available right now. Try again.');
  return researchService;
}

const currentResearchGateway = {
  get providerHealth() { return currentResearchService().gateway.providerHealth; },
  requestResearch: (request) => currentResearchService().gateway.requestResearch(request),
  getResearch: (leadRef) => currentResearchService().gateway.getResearch(leadRef),
  importArtifact: (leadRef, filePath) => currentResearchService().gateway.importArtifact(leadRef, filePath),
  credentialsChanged: () => currentResearchService().gateway.credentialsChanged()
};

const currentResearchKeys = {
  setApiKey: (key) => currentResearchService().keys.setApiKey(key),
  clearApiKey: () => currentResearchService().keys.clearApiKey(),
  hasApiKey: () => currentResearchService().keys.hasApiKey()
};

function registerResearchIpcHandlers() {
  if (!researchService) return;
  if (!researchTrustedSender) {
    researchTrustedSender = createTrustedSender(() => mainWindow, {
      isDev,
      port: Number(process.env.VITE_PORT) || undefined,
      indexPath: path.join(__dirname, 'index.html'),
      onReject: (reason) => logger.warn('ipc', `prospect-research rejected: ${reason}`)
    });
  }
  try {
    registerResearchIpc(ipcMain, {
      gateway: currentResearchGateway,
      keys: currentResearchKeys,
      isTrustedSender: researchTrustedSender,
      loadLead: loadResearchLead,
      listLeads: listResearchLeads,
      showOpenDialog: pickResearchArtifactFile,
      logger: { warn: (scope, msg, fields) => logger.warn(scope, msg, fields), error: (scope, msg, fields) => logger.error(scope, msg, fields) }
    });
    logger.info('research', `registered ${RESEARCH_CHANNELS.length} research channels`);
  } catch (err) {
    logger.error('research', 'research IPC registration failed', { error: err.message });
  }
}

// A10: the Lead Intelligence target source, over the app's EXISTING `targets`
// table. Read-only: it can only resolve a stored user-owned definition, and it
// never creates, edits or archives one.
function leadIntelTargetSource() {
  return {
    async getTarget(id) {
      try {
        const listed = await accountStore.listTargets();
        const rows = listed && Array.isArray(listed.rows) ? listed.rows : [];
        return rows.find((row) => String(row.id) === String(id)) || null;
      } catch (err) {
        logger.warn('lead-intel', 'target lookup failed', { error: err.message });
        return null;
      }
    },
  };
}

// A10: the runtime is constructed ONLY after `await accountStore.ready` (done in
// initServices). It reuses the same whatsapp.db, runs the additive li_* migrations
// and does NOT call li.start(): no background timer, no scheduler, no research.

// F23 PLUG & PLAY: email identity comes from the customer's configuration, never from
// code. Both helpers below are read-only views over the same electron-store instance;
// with no configuration they return the OFF state, which is the honest current state of
// this installation (no sender, no domain) and a fully supported product state.
//
// CONFIGURATION KEYS (non-secret; the API credential is NOT one of these):
//   settings.emailEnabled       true to enable the send boundary at all (default false)
//   settings.emailFromName      From Name, plain text, <=120 chars
//   settings.emailFromAddress   From Email, one valid address
//   settings.emailReplyTo       optional Reply-To, one valid address
//   settings.emailDomain        the sending domain (must be verified in Resend)
//   settings.emailDomainVerification  unknown|pending|verified|failed
//   settings.emailSignature     optional signature appended to the canonical pitch body
//   providers.resend.credentials.apiKey  THE SECRET - main-process/electron-store only,
//       revealed through credentialVault at send time, never read by or exposed to the
//       renderer, never stored in whatsapp.db, and never displayed anywhere.
function emailConfigFromSettings() {
  try {
    const settings = electronStore ? electronStore.get('settings', null) : null;
    const s = settings && typeof settings === 'object' ? settings : {};
    const from = typeof s.emailFromAddress === 'string' ? s.emailFromAddress.trim() : '';
    return { enabled: s.emailEnabled === true, fromAddress: from || null };
  } catch {
    // A configuration source that cannot be read means "not configured", never "enabled".
    return { enabled: false, fromAddress: null };
  }
}

// F24 PLUG & PLAY: the bounded Business/Offer Profile that feeds config.offer. It is the
// SAME read-only view over the same electron-store instance; with no configuration it
// returns four empty strings - the honest "Not configured" state of this installation -
// and the PitchGenerator then composes an identity-free pitch instead of inventing one.
//
// CONFIGURATION KEYS (non-secret, plain identity text; credentials are NOT part of the
// Business Profile and never live under these keys):
//   settings.businessRepresentativeName   who signs the pitch, plain text, <=80 chars
//   settings.businessCompanyName          the sender company, plain text, <=120 chars
//   settings.businessValueProposition     the offer's value proposition, <=1200 chars
//   settings.businessCallToAction         the offer's call to action, <=400 chars
//   settings.businessPostalAddress        F26.5: physical postal address, <=300 chars (required to send)
function businessProfileFromSettings() {
  try {
    const { readBusinessProfile } = require('./src/main/lead-intelligence/outreach/businessProfile');
    return readBusinessProfile(electronStore);
  } catch {
    // A profile that cannot be read is "not configured" - never a default identity.
    return { sender_name: '', sender_company: '', value_proposition: '', call_to_action: '', postal_address: '' };
  }
}

// F24 PLUG & PLAY: WhatsApp send configuration, mirroring emailConfigFromSettings above.
// Read-only, non-secret, main-process only. With no configuration it returns the OFF
// state, which is the honest current state of this installation (no enabled switch, no
// sender number) and a fully supported product state.
//
// CONFIGURATION KEYS (non-secret; the access token is NOT one of these):
//   settings.whatsappEnabled        true to enable the send boundary at all (default false)
//   settings.whatsappFromNumber     the connected WhatsApp Business sending number, E.164
//   settings.whatsappProvider       the selected supported provider id ('meta-cloud')
//   settings.whatsappPhoneNumberId         the connected phone-number id (account fact)
//   settings.whatsappBusinessAccountId     the WhatsApp Business account id (account fact)
//   settings.whatsappNumberVerification    unknown|pending|verified|failed
//   providers.meta-cloud.credentials.apiKey  THE SECRET - main-process/electron-store only,
//       revealed through credentialVault at send time, never read by or exposed to the
//       renderer, never stored in whatsapp.db, and never displayed anywhere.
function whatsappConfigFromSettings() {
  try {
    const settings = electronStore ? electronStore.get('settings', null) : null;
    const s = settings && typeof settings === 'object' ? settings : {};
    const from = typeof s.whatsappFromNumber === 'string' ? s.whatsappFromNumber.trim() : '';
    return { enabled: s.whatsappEnabled === true, fromNumber: from || null };
  } catch {
    // A configuration source that cannot be read means "not configured", never "enabled".
    return { enabled: false, fromNumber: null };
  }
}

// F23: the operational Resend transport, constructed once for the main process. Building
// it performs no I/O and no network call - the credential is read lazily at send time and
// the transport only runs after the send boundary has approved an attempt. With this
// installation's current configuration the capability check refuses long before this
// object is ever asked to send anything.
// F26.5: Hosted Trust Relay configuration. settings.trustRelayUrl is plain (https) text; the
// shared secret is a sealed credential under providers['trust-relay'], revealed only here.
// The pull cursor is a plain setting. With either part missing the relay is simply off.
function trustRelayFromSettings() {
  try {
    if (!electronStore) return null;
    const settings = electronStore.get('settings', {}) || {};
    const url = typeof settings.trustRelayUrl === 'string' ? settings.trustRelayUrl : '';
    if (!url) return null;
    return {
      url,
      getSecret: () => {
        try {
          const providers = electronStore.get('providers', null);
          const record = providers && typeof providers === 'object' ? providers['trust-relay'] : null;
          const stored = record && record.credentials ? record.credentials.apiKey : null;
          if (typeof stored !== 'string' || !stored) return null;
          const revealed = credentialVault.reveal(stored);
          return typeof revealed === 'string' && revealed ? revealed : null;
        } catch {
          return null;
        }
      },
      cursorStore: {
        get: () => { const s = electronStore.get('settings', {}) || {}; return typeof s.trustRelayCursor === 'string' ? s.trustRelayCursor : null; },
        set: (c) => { const s = electronStore.get('settings', {}) || {}; electronStore.set('settings', { ...s, trustRelayCursor: String(c) }); },
      },
    };
  } catch {
    return null;
  }
}

function buildResendEmailProvider() {
  try {
    const { ResendEmailProvider } = require('./src/main/lead-intelligence/outreach/email/ResendEmailProvider');
    return new ResendEmailProvider({
      getApiKey: () => {
        try {
          if (!electronStore) return null;
          const providers = electronStore.get('providers', null);
          const record = providers && typeof providers === 'object' ? providers.resend : null;
          const stored = record && record.credentials ? record.credentials.apiKey : null;
          if (typeof stored !== 'string' || stored.length === 0) return null;
          const revealed = credentialVault.reveal(stored);
          return typeof revealed === 'string' && revealed.length > 0 ? revealed : null;
        } catch {
          // Unreadable credential = not configured. The boundary fails closed with the
          // capability refusal; no key value is ever logged.
          return null;
        }
      }
    });
  } catch {
    // If the adapter cannot even be constructed, the product behaves as it did before
    // F23: no provider instance, EMAIL_PROVIDER_NOT_SET. Unrelated functionality is
    // never disabled by this.
    return null;
  }
}

// F24: the operational WhatsApp transport - ONE official Cloud API adapter, constructed
// once for the main process. Building it performs no I/O and no network call: the access
// token and the phone-number id are read lazily through closures at send time, and the
// transport only runs after the send boundary has approved an attempt. With this
// installation's current configuration (no provider selected, no credential, no connected
// number) the capability check refuses long before this object is ever asked to send.
// The provider choice stays configuration (settings.whatsappProvider); the adapter below
// is the single supported implementation behind the existing WhatsAppProvider interface.
function buildWhatsAppProvider() {
  try {
    const { MetaCloudWhatsAppProvider } = require('./src/main/lead-intelligence/outreach/whatsapp/MetaCloudWhatsAppProvider');
    return new MetaCloudWhatsAppProvider({
      getAccessToken: () => {
        try {
          if (!electronStore) return null;
          const providers = electronStore.get('providers', null);
          const record = providers && typeof providers === 'object' ? providers['meta-cloud'] : null;
          const stored = record && record.credentials ? record.credentials.apiKey : null;
          if (typeof stored !== 'string' || stored.length === 0) return null;
          const revealed = credentialVault.reveal(stored);
          return typeof revealed === 'string' && revealed.length > 0 ? revealed : null;
        } catch {
          // Unreadable credential = not configured. The boundary fails closed with the
          // capability refusal; no token value is ever logged.
          return null;
        }
      },
      getPhoneNumberId: () => {
        try {
          if (!electronStore) return null;
          const settings = electronStore.get('settings', null);
          const id = settings && typeof settings === 'object' ? settings.whatsappPhoneNumberId : null;
          return typeof id === 'string' && id.trim().length > 0 ? id.trim() : null;
        } catch {
          return null;
        }
      }
    });
  } catch {
    // If the adapter cannot even be constructed, WhatsApp behaves as it did before F24:
    // no provider instance, WHATSAPP_PROVIDER_NOT_SET. Unrelated functionality is never
    // disabled by this.
    return null;
  }
}

async function initLeadIntelligence() {
  try {
    if (!accountStore || !accountStore.db) {
      logger.warn('lead-intel', 'lead intelligence unavailable', { reason: 'no-database' });
      return;
    }
    // The Round-1 table is created by the Round-1 store; make sure it exists
    // before Lead Intelligence reads it. This is Round-1's own idempotent
    // CREATE IF NOT EXISTS — it adds nothing and controls nothing.
    if (researchService && researchService.store && typeof researchService.store.ready === 'function') {
      try {
        await researchService.store.ready();
      } catch (err) {
        logger.warn('lead-intel', 'round-1 store not ready', { error: err.message });
      }
    }
    leadIntelRuntime = await initializeLeadIntelligenceRuntime({
      accountStore,
      targetSource: leadIntelTargetSource(),
      // F23/F24: every customer-specific value comes from configuration, never from code.
      config: {
        ...LEAD_INTEL_CONFIG,
        email: emailConfigFromSettings(),
        whatsapp: whatsappConfigFromSettings(),
        offer: businessProfileFromSettings(),
      },
      // F23: the operational Resend transport (main-process only, credential closure).
      emailProvider: buildResendEmailProvider(),
      // F24: the operational WhatsApp transport (main-process only, token closure).
      whatsappProvider: buildWhatsAppProvider(),
      // Phase I2: Opportunity Intelligence. A SEPARATE local FastAPI service with its
      // own database, loopback by default, and no credential anywhere in ZTech. The
      // destination comes from configuration and the environment only; the renderer
      // can never supply it. OI being down is not an error here.
      opportunity: { config: opportunityConfigFromEnv() },
      // F26.5: the Hosted Trust Relay (F26.5b server). OFF unless settings.trustRelayUrl AND a
      // 'trust-relay' secret in the credential vault both exist. Neither ever reaches the renderer.
      trustRelay: trustRelayFromSettings(),
      // F26.5: the mail-app handoff. ONLY a mailto: URL is ever opened; anything else is refused.
      openExternal: (url) => {
        if (typeof url !== 'string' || !/^mailto:[^\s]+$/i.test(url)) throw new Error('only mailto: links can be opened');
        return shell.openExternal(url);
      },
      logger: {
        warn: (msg) => logger.warn('lead-intel', String(msg)),
        error: (msg) => logger.error('lead-intel', String(msg)),
        info: (msg) => logger.info('lead-intel', String(msg)),
      },
    });
    logger.info('lead-intel', 'runtime initialised', { mode: leadIntelRuntime.li.mode });
  } catch (err) {
    leadIntelRuntime = null;
    logger.error('lead-intel', 'runtime initialisation failed', { error: err.message });
  }
}

/**
 * Phase I2: Opportunity Intelligence connection settings.
 *
 * These are the ONLY inputs the OI gateway accepts, and they come from the
 * main-process environment only. There is deliberately no settings key, no
 * renderer control and no IPC channel that can change them: an OI destination is
 * a deployment fact, not user content.
 *
 * `enabled` defaults to TRUE because the default destination is loopback, where a
 * service that is not running simply reports "unavailable". Setting
 * `ZTECH_OI_ENABLED=0` turns the feature off entirely.
 *
 * No provider credential is read here. Since I3, OI provider keys are sealed in
 * electron-store by oiProviderConfig and injected ONLY into a child that the I4
 * supervisor launched itself (managed mode); they never cross IPC. In external mode
 * this env-configured destination is used, with no key and no token.
 */
function opportunityConfigFromEnv() {
  const timeout = Number(process.env.ZTECH_OI_TIMEOUT_MS);
  const healthTimeout = Number(process.env.ZTECH_OI_HEALTH_TIMEOUT_MS);
  const maxCompetitors = Number(process.env.ZTECH_OI_MAX_COMPETITORS);
  const out = {
    enabled: String(process.env.ZTECH_OI_ENABLED || '1') !== '0',
    baseUrl: process.env.ZTECH_OI_BASE_URL || 'http://127.0.0.1:8099',
  };
  if (Number.isFinite(timeout) && timeout > 0) out.timeoutMs = timeout;
  if (Number.isFinite(healthTimeout) && healthTimeout > 0) out.healthTimeoutMs = healthTimeout;
  if (Number.isFinite(maxCompetitors) && maxCompetitors > 0) out.maxCompetitors = maxCompetitors;
  // allowLocalhost stays true: an operator who sets a REMOTE base URL still gets it
  // refused unless it is HTTPS, because validateServiceBaseUrl enforces that.
  return out;
}

// The user's own offer text. It is USER content, not a credential, and it never
// leaves the main process: the pitch draft is composed here and the renderer only
// ever receives the finished, scrubbed draft.
const LEAD_INTEL_CONFIG = Object.freeze({
  freshness: { completeMaxAgeDays: 30, partialMaxAgeDays: 7 },
  outreach: { allowedQualification: ['qualified'], allowPartialEvidence: false, requireIcpFit: false },
  // F24 PLUG & PLAY: this is the UNCONFIGURED default and it is deliberately EMPTY.
  // The business/offer identity is configuration, never code: businessProfileFromSettings()
  // reads the customer's own four settings keys at runtime (below) and overrides this
  // object in initLeadIntelligence(). No representative, no company and no value
  // proposition is baked into source, so another customer can install this product with
  // zero source edits - and an installation that configured nothing reads back as empty
  // strings, the honest "Not configured" state, rather than falling back to a built-in
  // identity.
  offer: { sender_name: '', sender_company: '', value_proposition: '', call_to_action: '' },
  // Email stays abstract: no provider is configured, so no send path exists.
  email: { enabled: false, fromAddress: null },
});

// A10: registers EXACTLY the five approved Lead Intelligence channels, behind the
// same trusted-sender rule as the research and Lists channels. Email sending is
// deliberately not registered.
function registerLeadIntelIpcHandlers() {
  if (!leadIntelRuntime) return;
  if (!leadIntelTrustedSender) {
    leadIntelTrustedSender = createTrustedSender(() => mainWindow, {
      isDev,
      port: Number(process.env.VITE_PORT) || undefined,
      indexPath: path.join(__dirname, 'index.html'),
      onReject: (reason) => logger.warn('ipc', `lead-intel rejected: ${reason}`)
    });
  }
  try {
    leadIntelIpc = registerOutreachIpc({
      ipcMain,
      outreach: leadIntelRuntime.li.outreach,
      isTrustedSender: (event) => {
        try {
          return leadIntelTrustedSender(event) === true;
        } catch {
          return false;
        }
      },
      logger: { warn: (msg) => logger.warn('lead-intel', String(msg)) },
    });
    logger.info('lead-intel', `registered ${leadIntelIpc.channels.length} channels`);
  } catch (err) {
    leadIntelIpc = null;
    logger.error('lead-intel', 'IPC registration failed', { error: err.message });
  }

  registerOpportunityIntelIpcHandlers();

  // I6: the read-only lead timeline channel. Same trusted-sender rule as every LI channel.
  try {
    if (leadIntelRuntime.timeline) {
      registerTimelineIpc({
        ipcMain,
        timeline: leadIntelRuntime.timeline,
        isTrustedSender: (event) => {
          try {
            return leadIntelTrustedSender(event) === true;
          } catch {
            return false;
          }
        },
        logger: { warn: (msg) => logger.warn('lead-intel', String(msg)) },
      });
    }
  } catch (err) {
    logger.error('lead-intel', 'timeline IPC registration failed', { error: err.message });
  }

  // F26.5: suppression, consent, provenance view and the mail-app handoff. Same trusted-sender
  // rule; addresses, refs and relay secrets never cross this boundary.
  try {
    if (leadIntelRuntime.li && leadIntelRuntime.li.trust) {
      registerTrustIpc({
        ipcMain,
        trust: leadIntelRuntime.li.trust,
        outreach: leadIntelRuntime.li.outreach,
        isTrustedSender: (event) => {
          try {
            return leadIntelTrustedSender(event) === true;
          } catch {
            return false;
          }
        },
        copyText: (text) => {
          const { clipboard } = require('electron');
          clipboard.writeText(String(text || ''));
        },
        logger: { warn: (msg) => logger.warn('lead-intel', String(msg)) },
      });
    }
  } catch (err) {
    logger.error('lead-intel', 'trust IPC registration failed', { error: err.message });
  }
}

/**
 * I3: write-only Opportunity Intelligence configuration channels (oi-config:*).
 * Keys are sealed into electron-store by oiProviderConfig and never returned. The
 * same trusted-sender rule as every Lead Intelligence channel applies.
 */
function oiTrustedSender() {
  if (!leadIntelTrustedSender) {
    leadIntelTrustedSender = createTrustedSender(() => mainWindow, {
      isDev,
      port: Number(process.env.VITE_PORT) || undefined,
      indexPath: path.join(__dirname, 'index.html'),
      onReject: (reason) => logger.warn('ipc', `lead-intel rejected: ${reason}`)
    });
  }
  return (event) => {
    try {
      return leadIntelTrustedSender(event) === true;
    } catch {
      return false;
    }
  };
}

function registerOiConfigIpcHandlers() {
  try {
    if (!oiProviderConfig) {
      oiProviderConfig = createOiProviderConfig({
        store: electronStore,
        logger: { warn: (msg) => logger.warn('lead-intel', String(msg)) },
      });
    }
    const channels = registerOiConfigIpc({
      ipcMain,
      config: oiProviderConfig,
      isTrustedSender: oiTrustedSender(),
      serviceView: () => (oiSupervisor ? oiSupervisor.healthView() : null),
      reported: () => (oiSupervisor ? oiSupervisor.reportedConfiguration() : null),
      logger: { warn: (msg) => logger.warn('lead-intel', String(msg)) },
    });
    logger.info('lead-intel', `registered ${channels.length} opportunity-intelligence config channels`);
  } catch (err) {
    logger.error('lead-intel', 'opportunity-intelligence config IPC registration failed', { error: err.message });
  }
}

/**
 * I4: start supervising the local OI service. Fire-and-forget: the window is already
 * up, and nothing here is awaited by startup. The supervisor reconfigures the existing
 * OI gateway in place (port + per-launch token) - the OI IPC handlers are not rebuilt.
 * The OI folder is chosen in a native dialog opened HERE; the renderer never sends a path.
 */
function startOiSupervisor() {
  try {
    if (!oiProviderConfig) return;
    const oi = leadIntelRuntime && leadIntelRuntime.opportunity ? leadIntelRuntime.opportunity : null;
    oiSupervisor = new OpportunityServiceSupervisor({
      gateway: oi ? oi.gateway : null,
      providerConfig: oiProviderConfig,
      store: electronStore,
      logger: {
        info: (msg) => logger.info('oi-service', String(msg)),
        warn: (msg) => logger.warn('oi-service', String(msg)),
      },
    });
    const channels = registerOiServiceIpc({
      ipcMain,
      supervisor: oiSupervisor,
      isTrustedSender: oiTrustedSender(),
      pickFolder: async () => {
        const res = await dialog.showOpenDialog(mainWindow, {
          title: 'Choose the Opportunity Intelligence folder',
          properties: ['openDirectory'],
        });
        return res && !res.canceled && Array.isArray(res.filePaths) && res.filePaths[0] ? res.filePaths[0] : null;
      },
      copyText: (text) => {
        const { clipboard } = require('electron');
        clipboard.writeText(String(text || ''));
      },
      logger: { warn: (msg) => logger.warn('oi-service', String(msg)) },
    });
    logger.info('oi-service', `registered ${channels.length} opportunity-intelligence service channels`);
    oiSupervisor.start();
  } catch (err) {
    logger.error('oi-service', 'opportunity-intelligence supervisor could not start', { error: err.message });
  }
}

/**
 * F26: Outreach Settings channels (outreach-settings:*). Writes exactly the store keys
 * F22-F25 already read; keys are sealed and never returned; verification is a
 * user-triggered, read-only provider check. No send path is added or changed here.
 */
function registerOutreachSettingsIpcHandlers() {
  try {
    if (!outreachSettings) {
      outreachSettings = createOutreachSettings({
        store: electronStore,
        onChange: () => applyOutreachSettings(),
        logger: { warn: (msg) => logger.warn('outreach-settings', String(msg)) },
      });
    }
    const channels = registerOutreachSettingsIpc({
      ipcMain,
      settings: outreachSettings,
      isTrustedSender: oiTrustedSender(),
      logger: { warn: (msg) => logger.warn('outreach-settings', String(msg)) },
    });
    logger.info('outreach-settings', `registered ${channels.length} outreach settings channels`);
  } catch (err) {
    logger.error('outreach-settings', 'outreach settings IPC registration failed', { error: err.message });
  }
}

/**
 * F26 (D2): live-apply a Settings save. Re-reads the same three values initLeadIntelligence
 * reads at startup and hands them to the running OutreachService. No restart, and no send
 * logic is touched - providers read their credentials lazily already.
 */
function applyOutreachSettings() {
  const outreach = leadIntelRuntime && leadIntelRuntime.li ? leadIntelRuntime.li.outreach : null;
  if (!outreach || typeof outreach.reconfigure !== 'function') return;
  outreach.reconfigure({
    email: emailConfigFromSettings(),
    whatsapp: whatsappConfigFromSettings(),
    offer: businessProfileFromSettings(),
  });
}

/**
 * Phase I2: Opportunity Intelligence channels.
 *
 * Same trusted-sender rule as every other Lead Intelligence channel, and the same
 * treatment when OI is absent: the channels are still registered, and each one
 * answers `{ available: false }` instead of leaving the renderer with an unhandled
 * invoke. Nothing here can send, approve or schedule anything - there is no such
 * channel in the OI set, and OI is not consulted by OutreachGate.
 */
function registerOpportunityIntelIpcHandlers() {
  if (!leadIntelRuntime) return;
  if (!leadIntelTrustedSender) {
    leadIntelTrustedSender = createTrustedSender(() => mainWindow, {
      isDev,
      port: Number(process.env.VITE_PORT) || undefined,
      indexPath: path.join(__dirname, 'index.html'),
      onReject: (reason) => logger.warn('ipc', `lead-intel rejected: ${reason}`)
    });
  }
  const isTrusted = (event) => {
    try {
      return leadIntelTrustedSender(event) === true;
    } catch {
      return false;
    }
  };
  const oiLogger = { warn: (msg) => logger.warn('lead-intel', String(msg)) };
  try {
    const oi = leadIntelRuntime.opportunity;
    if (!oi) {
      // Not constructed at all (construction threw). Register the honest stub so
      // the renderer always gets an answer.
      registerUnavailableOpportunityIpc({
        ipcMain,
        isTrustedSender: isTrusted,
        reason: 'Opportunity Intelligence is not available in this build.',
        logger: oiLogger,
      });
      logger.info('lead-intel', 'opportunity-intelligence registered as unavailable');
      return;
    }
    const channels = oi.registerIpc({ ipcMain, isTrustedSender: isTrusted, leadSource: oi.leadSource, offer: () => businessProfileFromSettings(), logger: oiLogger });
    logger.info('lead-intel', `registered ${channels.length} opportunity-intelligence channels`);
  } catch (err) {
    logger.error('lead-intel', 'opportunity-intelligence IPC registration failed', { error: err.message });
  }
}

function registerIpcHandlers() {
  function providerIdFrom(payload) {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return p.providerId;
  }

  function handleSetCredentials(channel, providerId, credentials) {
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
      return rejectEnvelope(channel, 'Invalid params: credentials');
    }
    const { apiKey, taskKey } = credentials;
    if (apiKey !== undefined && apiKey !== null && (typeof apiKey !== 'string' || apiKey.length > MAX_KEY_LENGTH)) {
      return rejectEnvelope(channel, 'Invalid params: apiKey');
    }
    if (taskKey !== undefined && taskKey !== null && (typeof taskKey !== 'string' || taskKey.length > MAX_KEY_LENGTH)) {
      return rejectEnvelope(channel, 'Invalid params: taskKey');
    }
    try {
      providerManager.setCredentials(providerId, {
        ...(apiKey !== undefined && apiKey !== null ? { apiKey } : {}),
        ...(taskKey !== undefined && taskKey !== null ? { taskKey } : {})
      });
      return { success: true };
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleCollectionSubmit(channel, providerId, params) {
    try {
      const shaped = validateSubmitShape(params);
      const adapter = providerManager.resolveCollectionProvider(providerId);
      const result = await adapter.submitCollection(shaped);
      await recordJobSubmitted(adapter.providerId, shaped, result);
      return result;
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobState(channel, providerId, jobId) {
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      const result = await adapter.getJobState(jobId);
      await recordJobState(adapter.providerId, jobId, result);
      return result;
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobResults(channel, providerId, jobId, options) {
    try {
      if (options && typeof options === 'object') {
        if (options.offset !== undefined &&
            (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 100000)) {
          throw invalidParams('Invalid params: offset (integer 0-100000)');
        }
        if (options.limit !== undefined &&
            (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000)) {
          throw invalidParams('Invalid params: limit (integer 1-10000)');
        }
      }
      const adapter = providerManager.resolveCollectionProvider(providerId);
      const result = await adapter.getJobResults(jobId, options);
      await recordJobResultCount(adapter.providerId, jobId, options, result);
      return result;
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobHistory(channel, providerId, payload) {
    try {
      const { limit, offset } = validateHistoryPaging(payload);
      const adapter = providerManager.resolveCollectionProvider(providerId);
      return await adapter.getJobHistory({ limit, offset });
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleTestConnection(channel, providerId, payload) {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    if (p.useStored === true) {
      let activeProviderId = providerId;
      if (typeof activeProviderId !== 'string' || activeProviderId === '') {
        try {
          activeProviderId = providerManager.resolveCollectionProvider().providerId;
        } catch (err) {
          if (err.invalidParams) return rejectEnvelope(channel, err.message);
          logger.error('ipc', `${channel} failed`, { error: err.message });
          return { success: false, error: err.message };
        }
      }
      const Store = require('electron-store');
      const credentials = loadProviderCredentials(new Store(), activeProviderId) || {};
      let apiKey = '';
      let taskKey = '';
      try {
        apiKey = credentialVault.reveal(typeof credentials.apiKey === 'string' ? credentials.apiKey : '');
        taskKey = credentialVault.reveal(typeof credentials.taskKey === 'string' ? credentials.taskKey : '');
      } catch {
        logger.warn('ipc', 'stored credentials could not be decrypted');
        return { success: false, error: 'Stored credentials could not be decrypted' };
      }
      if (!apiKey && !taskKey) {
        return { success: false, error: 'No stored credentials' };
      }
      try {
        const adapter = providerManager.resolveCollectionProvider(activeProviderId);
        return await adapter.testConnection({ apiKey, taskKey });
      } catch (err) {
        if (err.invalidParams) return rejectEnvelope(channel, err.message);
        logger.error('ipc', `${channel} failed`, { error: err.message });
        return { success: false, error: err.message };
      }
    }
    const apiKey = p.apiKey;
    const taskKey = p.taskKey;
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > MAX_KEY_LENGTH) {
      return rejectEnvelope(channel, 'Invalid params: apiKey');
    }
    if (taskKey !== undefined && taskKey !== null && (typeof taskKey !== 'string' || taskKey.length > MAX_KEY_LENGTH)) {
      return rejectEnvelope(channel, 'Invalid params: taskKey');
    }
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      return await adapter.testConnection({ apiKey, taskKey });
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  ipcMain.handle('provider:set-credentials', (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return handleSetCredentials('provider:set-credentials', p.providerId, p.credentials);
  });

  ipcMain.handle('provider:test-connection', (_, payload) => {
    return handleTestConnection('provider:test-connection', providerIdFrom(payload), payload);
  });

  ipcMain.handle('collection:submit', (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return handleCollectionSubmit('collection:submit', p.providerId, p.params);
  });

  ipcMain.handle('collection:job-status', (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return handleGetJobState('collection:job-status', p.providerId, p.jobId);
  });

  ipcMain.handle('collection:job-result', (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return handleGetJobResults('collection:job-result', p.providerId, p.jobId, {
      offset: p.offset,
      limit: p.limit
    });
  });

  ipcMain.handle('collection:job-history', (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    return handleGetJobHistory('collection:job-history', p.providerId, p);
  });

  ipcMain.handle('settings:save', async (_, settings) => {
    let nextSettings;
    try {
      nextSettings = validateSettingsPayload(settings);
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    const Store = require('electron-store');
    const store = new Store();
    let activeProviderId;
    try {
      activeProviderId = providerManager.resolveCollectionProvider().providerId;
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    const currentCredentials = loadProviderCredentials(store, activeProviderId) || {};
    let plannedApiKey;
    let plannedTaskKey;
    let proxySealed = '';
    try {
      plannedApiKey = credentialVault.planCredentialUpdate(
        typeof currentCredentials.apiKey === 'string' ? currentCredentials.apiKey : '',
        { value: nextSettings.apiKey, clear: nextSettings.clearApiKey }
      );
      plannedTaskKey = credentialVault.planCredentialUpdate(
        typeof currentCredentials.taskKey === 'string' ? currentCredentials.taskKey : '',
        { value: nextSettings.taskKey, clear: nextSettings.clearTaskKey }
      );
      proxySealed = nextSettings.proxyUrl ? credentialVault.seal(nextSettings.proxyUrl) : '';
    } catch {
      logger.warn('settings', 'settings could not be encrypted', { reason: 'encryption-unavailable' });
      return { success: false, error: 'Settings could not be encrypted on this system' };
    }
    const storedSettings = store.get('settings', null);
    const settingsRecord = (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings))
      ? { ...storedSettings }
      : {};
    if (plannedApiKey.action !== 'keep') delete settingsRecord.apiKey;
    if (plannedTaskKey.action !== 'keep') delete settingsRecord.taskKey;
    settingsRecord.proxyUrl = proxySealed;
    if (nextSettings.research) settingsRecord.research = nextSettings.research;
    persistProviderCredentials(store, activeProviderId, {
      apiKey: plannedApiKey.next,
      taskKey: plannedTaskKey.next
    });
    store.set('settings', settingsRecord);
    const memoryCredentials = {};
    if (plannedApiKey.action === 'set') memoryCredentials.apiKey = plannedApiKey.plaintext;
    else if (plannedApiKey.action === 'clear') memoryCredentials.apiKey = '';
    if (plannedTaskKey.action === 'set') memoryCredentials.taskKey = plannedTaskKey.plaintext;
    else if (plannedTaskKey.action === 'clear') memoryCredentials.taskKey = '';
    if (Object.keys(memoryCredentials).length > 0) {
      providerManager.setCredentials(activeProviderId, memoryCredentials);
    }
    logger.info('settings', 'settings saved', {
      hasApiKey: !!nextSettings.apiKey,
      hasTaskKey: !!nextSettings.taskKey,
      hasProxy: !!nextSettings.proxyUrl
    });
    const proxyResult = await applyProxyConfiguration(nextSettings.proxyUrl);
    // A8: the endpoint changed, so the running service is closed and rebuilt
    // rather than silently continuing against the old one. The success envelope
    // stays exactly { success, proxyApplied }.
    if (nextSettings.research && prospectResearch.researchSettingsChanged(researchService, nextSettings.research)) {
      await recreateResearchService();
    }
    return { success: true, proxyApplied: proxyResult.applied };
  });

  ipcMain.handle('settings:load', async () => {
    const Store = require('electron-store');
    const store = new Store();
    const legacy = store.get('settings', {});
    const base = (legacy && typeof legacy === 'object') ? legacy : {};
    let activeProviderId = null;
    try {
      activeProviderId = providerManager.resolveCollectionProvider().providerId;
    } catch {
      activeProviderId = null;
    }
    const credentials = activeProviderId ? loadProviderCredentials(store, activeProviderId) : null;
    const storedApiKey = credentials && typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
    const storedTaskKey = credentials && typeof credentials.taskKey === 'string' ? credentials.taskKey : '';
    const legacyApiKey = typeof base.apiKey === 'string' ? base.apiKey : '';
    const legacyTaskKey = typeof base.taskKey === 'string' ? base.taskKey : '';
    const hasApiKey = canRevealCredential(storedApiKey) || canRevealCredential(legacyApiKey);
    const hasTaskKey = canRevealCredential(storedTaskKey) || canRevealCredential(legacyTaskKey);
    let proxyUrl = '';
    try {
      proxyUrl = credentialVault.reveal(typeof base.proxyUrl === 'string' ? base.proxyUrl : '');
    } catch {
      logger.warn('proxy', 'stored proxy could not be decrypted');
    }
    // A8: research settings are non-secret and may be returned. The Zuni-SEO key
    // is never returned - only whether one is stored.
    const researchSettings = prospectResearch.readResearchSettings(base.research);
    let researchHasKey = false;
    try {
      researchHasKey = Boolean(researchService && await researchService.keys.hasApiKey());
    } catch (err) {
      logger.warn('research', 'stored research key could not be read', { error: err.message });
    }
    return {
      hasApiKey,
      hasTaskKey,
      proxyUrl,
      research: { ...researchSettings, hasApiKey: researchHasKey }
    };
  });

  // 采集结果管理
  ipcMain.handle('collector:get-numbers', (_, query) => {
    try {
      return accountStore.queryNumbers(validateNumbersQuery(query));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:get-numbers', err.message);
      throw err;
    }
  });

  // F26.5: provenance capture after a successful collection/import save. addNumbers may return a
  // promise; capture waits for it and never throws into the save path.
  function capturePostSaveProvenance(result, payload, saveContext) {
    const trust = leadIntelRuntime && leadIntelRuntime.li ? leadIntelRuntime.li.trust : null;
    if (!trust) return;
    Promise.resolve(result)
      .then(() => trust.captureSave({ rows: payload, providerId: saveContext.providerId || null, runSlug: saveContext.runSlug || null }))
      .catch((err) => logger.warn('lead-intel', 'provenance capture skipped', { error: err && err.message }));
  }

  // The local collection save. The optional second argument carries the run
  // context of THIS save (the run it came from, and the target the user
  // applied). It never reaches the provider: the numbers payload and the
  // provider request shape are unchanged.
  ipcMain.handle('collector:add-numbers', (_, numbers, context) => {
    // The provider identity comes from the registry, never from the renderer.
    const activeProviderId = resolveActiveProviderId();
    let payload;
    let saveContext;
    try {
      payload = validateNumbersPayload(numbers);
      saveContext = validateSaveContext(context, activeProviderId);
    } catch (err) {
      // Validation happens BEFORE the save, so a refused context can never
      // leave a half-recorded run behind.
      if (err.invalidParams) rejectLog('collector:add-numbers', err.message);
      throw err;
    }
    const result = accountStore.addNumbers(payload);
    // F26.5: record where each saved contact field came from (this run or an import) and when.
    // Best effort and after the save: a provenance failure never loses or blocks saved leads.
    capturePostSaveProvenance(result, payload, saveContext);
    // P1-G: the report counters are the ones this save really produced - the
    // submitted count and addNumbers' own added/duplicates - added to what the
    // run already recorded. Recorded only here, after a successful save, and
    // never from a provider response.
    if (saveContext.runSlug && saveContext.providerId) {
      try {
        accountStore.recordJobSaveMetrics({
          providerId: saveContext.providerId,
          runSlug: saveContext.runSlug,
          submittedCount: payload.length,
          addedCount: result.added,
          duplicateCount: result.duplicates,
          targetId: saveContext.targetId
        });
      } catch (err) {
        // A report-counter failure must never lose the saved leads.
        logger.error('collector', 'failed to record job save metrics', { error: err.message });
      }
    }
    return result;
  });

  // P1-G: the read-only Collection Quality Report for one run of the
  // registered provider. It derives counts from what is already stored and
  // writes nothing.
  ipcMain.handle('collector:quality-report', (_, query) => {
    try {
      return accountStore.collectionQualityReport(
        validateQualityReportPayload(query, resolveActiveProviderId())
      );
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:quality-report', err.message);
      throw err;
    }
  });

  // P1-G: the attached target's required-field completeness for one run. Null
  // when no target is attached - never an invented compliance metric.
  ipcMain.handle('collector:quality-target-report', (_, query) => {
    try {
      return accountStore.collectionQualityTargetReport(
        validateQualityReportRunSlug(query, resolveActiveProviderId())
      );
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:quality-target-report', err.message);
      throw err;
    }
  });

  ipcMain.handle('collector:export-numbers', (_, format) => {
    const fmt = (format === undefined || format === null) ? 'csv' : format;
    if (fmt !== 'csv' && fmt !== 'json') {
      rejectLog('collector:export-numbers', 'Invalid params: format');
      throw invalidParams('Invalid params: format');
    }
    return accountStore.exportNumbers(fmt);
  });

  ipcMain.handle('collector:delete-numbers', (_, ids) => {
    try {
      return accountStore.deleteNumbers(validateIdList(ids));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:delete-numbers', err.message);
      throw err;
    }
  });

  ipcMain.handle('collector:storage-status', () => {
    return accountStore.getStorageStatus();
  });

  // B5: read-only access to the local collection-job ledger for the
  // dashboard. Same validated paging contract as the other list reads;
  // returns the accountStore.queryJobs envelope unchanged.
  ipcMain.handle('collector:get-jobs', (_, query) => {
    try {
      return accountStore.queryJobs(validateHistoryPaging(query));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:get-jobs', err.message);
      throw err;
    }
  });

  // P1.3: the single write path for the user-owned lead fields. Validation is
  // authoritative here; the store re-checks defensively. Responses follow the
  // B4 job-state precedent ({success, updated} plus a reason when nothing was
  // written). Nothing in this handler logs tags or notes content.
  ipcMain.handle('collector:update-lead', (_, payload) => {
    try {
      return accountStore.setLeadUserFields(validateLeadUpdatePayload(payload));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:update-lead', err.message);
      throw err;
    }
  });

  // P1-C: user-provided data-quality statuses for one lead. Deliberately
  // separate from collector:update-lead so a status assertion can never touch
  // qualification/tags/notes and vice versa.
  ipcMain.handle('collector:update-lead-quality', (_, payload) => {
    try {
      return accountStore.setLeadUserStatuses(validateLeadQualityPayload(payload));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:update-lead-quality', err.message);
      throw err;
    }
  });

  // P1-E: read-only duplicate review. The handler forwards a validated
  // {rule, limit, offset} to the store and returns the classification envelope
  // unchanged. It deliberately has no sibling write handler in this batch: no
  // combination of records, no survivor selection, no data movement.
  ipcMain.handle('collector:duplicate-review', (_, query) => {
    try {
      return accountStore.reviewDuplicates(validateDuplicateReviewPayload(query));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:duplicate-review', err.message);
      throw err;
    }
  });

  // P1-F Target builder. listTargets is a read; saveTarget creates or updates a
  // user-owned definition and setTargetStatus archives or activates one.
  // None of the three can reach a lead row, and none is called by a collection
  // or import path.
  ipcMain.handle('targets:list', () => {
    return accountStore.listTargets();
  });

  ipcMain.handle('targets:save', (_, payload) => {
    try {
      return accountStore.saveTarget(validateTargetPayload(payload));
    } catch (err) {
      if (err.invalidParams) rejectLog('targets:save', err.message);
      throw err;
    }
  });

  ipcMain.handle('targets:set-status', (_, payload) => {
    try {
      return accountStore.setTargetStatus(validateTargetStatusPayload(payload));
    } catch (err) {
      if (err.invalidParams) rejectLog('targets:set-status', err.message);
      throw err;
    }
  });

  // F6 Lists. Seven channels for user-owned list definitions. Every handler
  // runs the trusted-sender check first (the same rule as the research
  // channels), validates its payload, and returns the store's structured
  // envelope. None of them can write a lead row.
  function isListsSender(event) {
    if (!listsTrustedSender) {
      listsTrustedSender = createTrustedSender(() => mainWindow, {
        isDev,
        port: Number(process.env.VITE_PORT) || undefined,
        indexPath: path.join(__dirname, 'index.html'),
        onReject: (reason) => logger.warn('ipc', `lists rejected: ${reason}`)
      });
    }
    try {
      return listsTrustedSender(event) === true;
    } catch {
      return false;
    }
  }

  function listsHandler(channel, handler) {
    return async (event, payload) => {
      if (!isListsSender(event)) {
        rejectLog(channel, 'untrusted sender');
        throw new Error('Untrusted sender.');
      }
      try {
        return await handler(payload);
      } catch (err) {
        if (err.invalidParams) rejectLog(channel, err.message);
        throw err;
      }
    };
  }

  ipcMain.handle('saved-searches:list', listsHandler('saved-searches:list',
    () => accountStore.listSavedSearches()));
  ipcMain.handle('saved-searches:save', listsHandler('saved-searches:save',
    (payload) => accountStore.saveSavedSearch(validateSavedSearchPayload(payload))));
  ipcMain.handle('saved-searches:delete', listsHandler('saved-searches:delete',
    (payload) => accountStore.deleteSavedSearch(validateListDeletePayload(payload, 'saved search'))));
  ipcMain.handle('segments:list', listsHandler('segments:list',
    () => accountStore.listSegments()));
  ipcMain.handle('segments:save', listsHandler('segments:save',
    (payload) => accountStore.saveSegment(validateSegmentPayload(payload))));
  ipcMain.handle('segments:members', listsHandler('segments:members',
    (payload) => accountStore.updateSegmentMembers(validateSegmentMembersPayload(payload))));
  ipcMain.handle('segments:delete', listsHandler('segments:delete',
    (payload) => accountStore.deleteSegment(validateListDeletePayload(payload, 'segment'))));

  // F8 Intelligence: read-only ICP fit through the Lead Intelligence contract,
  // behind the same trusted-sender guard as the Lists channels.
  ipcMain.handle('intelligence:icp', listsHandler('intelligence:icp',
    (payload) => evaluateIcpForTarget(validateIcpPayload(payload))));

  ipcMain.handle('logs:export', () => {
    return logger.exportLogs();
  });

  ipcMain.handle('logs:dir', () => {
    return logger.getLogDir();
  });

  ipcMain.handle('logs:report', (_, payload) => {
    try {
      if (!payload || typeof payload !== 'object') return { success: false };
      const message = typeof payload.message === 'string' ? payload.message.slice(0, 500) : 'Unknown renderer error';
      const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
      const sanitized = {};
      for (const [k, v] of Object.entries(context)) {
        if (typeof v === 'string' && v.length > 200) sanitized[k] = v.slice(0, 200) + '...';
        else sanitized[k] = v;
      }
      logger.error('renderer', message, sanitized);
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('proxy:detect', async () => {
    const { autoDetectProxy } = require('./src/main/proxyDetector');
    const result = await autoDetectProxy();
    return result || { source: null, proxyUrl: null };
  });

  // A4: research channels are registered last, so the service and its trusted
  // sender exist before any research handler can be invoked.
  registerResearchIpcHandlers();

}

app.whenReady().then(async () => {
    if (!gotTheLock) return;
    logger.info('app', 'application started', { version: app.getVersion(), isDev });
    // 1. create AccountStore, 2. await AccountStore.ready (inside initServices)
    await initServices();
    initResearch();
    createMainWindow();
    registerIpcHandlers();
    // 3. initialise the Lead Intelligence runtime (after the db is open), then
    // 4. register its five IPC handlers. li.start() is deliberately NOT called.
    await initLeadIntelligence();
    registerLeadIntelIpcHandlers();
    // I3: OI provider configuration. Registered whether or not the LI runtime started,
    // so Settings can always show and edit it. Never awaited on anything network-bound.
    registerOiConfigIpcHandlers();
    // I4: supervise the local OI service. Not awaited: a slow or failing OI never
    // delays the window or anything else that starts after it.
    startOiSupervisor();
    // F26: Outreach Settings (business profile, Resend, WhatsApp). Registered whether or
    // not the LI runtime started, so the customer can always configure.
    registerOutreachSettingsIpcHandlers();
    let storedProxyUrl = '';
    try {
      const Store = require('electron-store');
      const stored = new Store().get('settings', {});
      const rawProxyUrl = (stored && typeof stored.proxyUrl === 'string') ? stored.proxyUrl : '';
      if (rawProxyUrl) {
        storedProxyUrl = credentialVault.reveal(rawProxyUrl);
      }
    } catch {
      storedProxyUrl = '';
      logger.warn('proxy', 'stored proxy could not be decrypted');
    }
    applyProxyConfiguration(storedProxyUrl);
    startResearch();
  }).catch((err) => {
    try {
      logger.error('app', 'whenReady failed', { error: err.message, stack: err.stack });
    } catch {}
  });

// A5: stop the research scheduler and close the Zuni-SEO transport on quit.
// The re-entrancy flag makes the preventDefault/app.quit() pair safe, and the
// 3s race bounds shutdown so a transport that will not close cannot trap the app.
// I4: the managed OI child must not outlive ZTech. will-quit runs after every window is
// closed; the shutdown is graceful, bounded at 3.5 s, then the process tree is forced.
app.on('will-quit', (event) => {
  if (!oiSupervisor || oiQuitDone || !oiSupervisor.child) return;
  event.preventDefault();
  oiQuitDone = true;
  Promise.race([
    oiSupervisor.shutdown(),
    new Promise((resolve) => setTimeout(resolve, 3500))
  ]).catch(() => {}).finally(() => {
    try { oiSupervisor.killSync(); } catch {}
    app.quit();
  });
});

// Last resort if ZTech exits without will-quit (crash path): kill the OI tree synchronously.
process.on('exit', () => {
  try { if (oiSupervisor) oiSupervisor.killSync(); } catch {}
});

app.on('before-quit', (event) => {
  // A10: Lead Intelligence holds no timers of its own (li.start() was never
  // called). Its handlers and runtime are torn down synchronously and the
  // database is left to the existing AccountStore lifecycle, so no race and no
  // second close is introduced.
  if (leadIntelIpc) {
    try {
      leadIntelIpc.dispose();
    } catch {}
    leadIntelIpc = null;
  }
  if (leadIntelRuntime) {
    const runtime = leadIntelRuntime;
    leadIntelRuntime = null;
    Promise.race([
      runtime.shutdown(),
      new Promise((resolve) => setTimeout(resolve, 2000))
    ]).catch((err) => {
      try {
        logger.warn('lead-intel', 'shutdown did not complete cleanly', { error: err && err.message });
      } catch {}
    });
  }
  if (!researchService || researchClosing) return;
  event.preventDefault();
  researchClosing = true;
  const service = researchService;
  researchService = null;
  Promise.race([
    service.close(),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]).catch((err) => {
    try {
      logger.error('research', 'close failed', { error: err.message });
    } catch {}
  }).finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
