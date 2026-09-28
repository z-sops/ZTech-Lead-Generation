'use strict';

// A4 - the seven prospect-research IPC channels.
//
// The prebuilt bundle does NOT export registerProspectResearchIpc or
// SafeStorageCredentialStore, so ZTech registers these channels itself against the
// gateway methods that ARE exported. The module's adapters/ipc.ts is the behavioural
// reference; this is ZTech's own implementation.
//
// Security rules
// - Every handler runs the trusted-sender check FIRST and throws on failure.
// - The import channel takes NO path from the renderer. Main opens the file dialog
//   and passes the chosen path to the gateway, so the renderer can never name a file.
// - Website and company name come from ZTech's own database, never from the payload.
// - Every channel returns renderer-safe views only. set-api-key returns a boolean and
//   the provider state; the key itself never crosses back over IPC.

const LEAD_REF_FORMAT = /^[A-Za-z0-9._:-]{1,128}$/;

const CHANNELS = {
  request: 'prospect-research:request',
  get: 'prospect-research:get',
  // F7: read-only overview for the Research workspace (Queue / Completed).
  list: 'prospect-research:list',
  importArtifact: 'prospect-research:import-artifact',
  providerHealth: 'prospect-research:provider-health',
  setApiKey: 'prospect-research:set-api-key',
  clearApiKey: 'prospect-research:clear-api-key',
  keyStatus: 'prospect-research:key-status'
};

const ALL_CHANNELS = Object.values(CHANNELS);

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOrNull(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

// F7: one renderer-safe row per lead. The research fields are the gateway's own
// view (availability, staleness, phase, reasons, timestamps) exactly as
// getResearch returns them - nothing is recomputed here. The evidence packet
// body is NOT copied: only its availability, counts, section states and
// provenance travel, so no untrusted site text is carried by the list.
function researchSummary(lead, view) {
  const v = isPlainObject(view) ? view : {};
  const packet = isPlainObject(v.packet) ? v.packet : null;
  const count = (value) => (Array.isArray(value) ? value.length : 0);
  let evidence = null;
  if (packet) {
    const sections = {};
    if (isPlainObject(packet.sections)) {
      for (const [name, section] of Object.entries(packet.sections)) {
        if (isPlainObject(section) && typeof section.state === 'string') sections[name] = section.state;
      }
    }
    const prov = isPlainObject(packet.provenance) ? packet.provenance : {};
    evidence = {
      availability: textOrNull(packet.availability),
      facts: count(packet.facts),
      findings: count(packet.issues),
      strengths: count(packet.strengths),
      notMeasured: count(packet.notMeasured),
      sections,
      provider: textOrNull(prov.provider),
      capturedAt: textOrNull(prov.capturedAt) || textOrNull(prov.finishedAt) || textOrNull(prov.importedAt)
    };
  }
  return {
    leadId: lead.id,
    title: textOrNull(lead.title),
    phone: textOrNull(lead.phone),
    leadWebsite: textOrNull(typeof lead.website === 'string' ? lead.website.trim() : null),
    availability: textOrNull(v.availability),
    phase: textOrNull(v.phase),
    stale: v.stale === true,
    researchedWebsite: textOrNull(v.website),
    requestedAt: textOrNull(v.requestedAt),
    updatedAt: textOrNull(v.updatedAt),
    failureReason: textOrNull(v.failureReason),
    pendingReason: textOrNull(v.pendingReason),
    message: textOrNull(v.message),
    evidence
  };
}

function leadRefOf(value) {
  if (typeof value !== 'string' || !LEAD_REF_FORMAT.test(value)) throw new Error('Invalid lead id.');
  return value;
}

/**
 * @param {any} ipcMain
 * @param {{
 *   gateway: any,
 *   keys: any,
 *   isTrustedSender: (event: any) => boolean,
 *   loadLead: (leadRef: string) => Promise<any>,
 *   listLeads: () => Promise<Array<{ id: string, title?: string, phone?: string, website?: string }>>,
 *   showOpenDialog: () => Promise<string | null>,
 *   logger?: { warn: Function, error: Function }
 * }} deps
 */
function registerResearchIpc(ipcMain, deps) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    throw new Error('prospect-research: ipcMain is required');
  }
  const d = isPlainObject(deps) ? deps : {};
  if (!d.gateway) throw new Error('prospect-research: gateway is required');
  if (!d.keys) throw new Error('prospect-research: keys is required');
  if (typeof d.isTrustedSender !== 'function') {
    throw new Error('prospect-research: isTrustedSender is required');
  }
  if (typeof d.loadLead !== 'function') throw new Error('prospect-research: loadLead is required');
  if (typeof d.listLeads !== 'function') throw new Error('prospect-research: listLeads is required');
  if (typeof d.showOpenDialog !== 'function') {
    throw new Error('prospect-research: showOpenDialog is required');
  }
  const log = isPlainObject(d.logger) ? d.logger : null;

  const guard = (fn) => async (event, ...args) => {
    let trusted = false;
    try {
      trusted = d.isTrustedSender(event) === true;
    } catch (err) {
      if (log) log.error('ipc', 'prospect-research sender check failed', { error: err.message });
      throw new Error('Untrusted sender.');
    }
    if (!trusted) {
      if (log) log.warn('ipc', 'prospect-research rejected: untrusted sender');
      throw new Error('Untrusted sender.');
    }
    return fn(...args);
  };

  ipcMain.handle(CHANNELS.request, guard(async (leadRef, force) => {
    const lead = await d.loadLead(leadRefOf(leadRef));
    if (!lead) throw new Error('Lead not found.');
    return d.gateway.requestResearch({
      leadRef: lead.leadRef,
      website: lead.website === undefined ? null : lead.website,
      companyName: lead.companyName === undefined ? null : lead.companyName,
      market: lead.market === undefined ? null : lead.market,
      language: lead.language === undefined ? null : lead.language,
      force: force === true
    });
  }));

  ipcMain.handle(CHANNELS.get, guard(async (leadRef) => d.gateway.getResearch(leadRefOf(leadRef))));

  // F7: read-only. Takes no renderer parameters. Every row comes from the
  // gateway's getResearch for a stored lead id - no provider call, no write, no
  // second state machine. A lead whose id is not a valid research reference
  // cannot be researched at all; it is counted, never given an invented state.
  ipcMain.handle(CHANNELS.list, guard(async (query) => {
    if (query !== undefined && query !== null && !isPlainObject(query)) {
      throw new Error('Invalid research list query.');
    }
    const leads = await d.listLeads();
    const rows = [];
    let unresearchable = 0;
    for (const lead of Array.isArray(leads) ? leads : []) {
      if (!isPlainObject(lead) || typeof lead.id !== 'string' || !LEAD_REF_FORMAT.test(lead.id)) {
        unresearchable += 1;
        continue;
      }
      rows.push(researchSummary(lead, await d.gateway.getResearch(lead.id)));
    }
    return { rows, total: rows.length, unresearchable };
  }));

  ipcMain.handle(CHANNELS.importArtifact, guard(async (leadRef) => {
    const ref = leadRefOf(leadRef);
    // The renderer supplies only WHICH lead, never WHICH file.
    const filePath = await d.showOpenDialog();
    if (typeof filePath !== 'string' || filePath === '') return null;
    return d.gateway.importArtifact(ref, filePath);
  }));

  ipcMain.handle(CHANNELS.providerHealth, guard(async () => {
    const health = d.gateway.providerHealth;
    if (health && health.state === 'ready') {
      const caps = health.capabilities || {};
      return { state: health.state, plan: caps.plan ?? null, limits: caps.limits ?? null };
    }
    return health;
  }));

  ipcMain.handle(CHANNELS.setApiKey, guard(async (key) => {
    if (typeof key !== 'string') throw new Error('Invalid key.');
    await d.keys.setApiKey(key);
    const health = await d.gateway.credentialsChanged();
    return { configured: true, provider: health ? health.state : 'not_checked' };
  }));

  ipcMain.handle(CHANNELS.clearApiKey, guard(async () => {
    await d.keys.clearApiKey();
    return { configured: false };
  }));

  ipcMain.handle(CHANNELS.keyStatus, guard(async () => ({ configured: await d.keys.hasApiKey() })));

  return { channels: ALL_CHANNELS.slice() };
}

module.exports = {
  ALL_CHANNELS,
  CHANNELS,
  LEAD_REF_FORMAT,
  leadRefOf,
  registerResearchIpc,
  researchSummary
};
