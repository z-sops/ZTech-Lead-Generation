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
  registerResearchIpc
};
