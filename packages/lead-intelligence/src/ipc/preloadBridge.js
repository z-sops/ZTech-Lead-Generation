'use strict';

/**
 * Preload bridge. Exposes ONLY fixed channels as functions; the renderer can never pass
 * a channel name, a URL, a file path or a credential.
 *
 * INTEGRATION POINT (QwenCoder):
 * - If ZTech's BrowserWindow uses `sandbox: true`, a sandboxed preload cannot require()
 *   this file. In that case copy the CHANNELS object and buildLeadIntelligenceApi()
 *   verbatim into the existing preload script instead of requiring it.
 * - Add the API under ONE new key (default "ztechLeadIntel") next to the existing
 *   contextBridge.exposeInMainWorld call. Do not change the existing key.
 */
const { CHANNELS: C } = require('./channels');

function buildLeadIntelligenceApi(ipcRenderer) {
  const call = (ch) => (args) => ipcRenderer.invoke(ch, args === undefined ? {} : args);
  return Object.freeze({
    research: Object.freeze({
      request: call(C.RESEARCH_REQUEST),
      importArtifact: call(C.RESEARCH_IMPORT_ARTIFACT),
      status: call(C.RESEARCH_STATUS),
      history: call(C.RESEARCH_HISTORY),
      evidence: call(C.EVIDENCE_GET),
      changes: call(C.CHANGES_LIST),
    }),
    profile: Object.freeze({ get: call(C.PROFILE_GET) }),
    icp: Object.freeze({ evaluate: call(C.ICP_EVALUATE) }),
    searches: Object.freeze({
      list: call(C.SEARCHES_LIST),
      save: call(C.SEARCHES_SAVE),
      delete: call(C.SEARCHES_DELETE),
      run: call(C.SEARCHES_RUN),
    }),
    segments: Object.freeze({
      list: call(C.SEGMENTS_LIST),
      save: call(C.SEGMENTS_SAVE),
      delete: call(C.SEGMENTS_DELETE),
      members: call(C.SEGMENTS_MEMBERS),
      addLeads: call(C.SEGMENTS_ADD_LEADS),
      removeLeads: call(C.SEGMENTS_REMOVE_LEADS),
    }),
    agent: Object.freeze({ analyze: call(C.AGENT_ANALYZE) }),
    pitch: Object.freeze({
      generate: call(C.PITCH_GENERATE),
      get: call(C.PITCH_GET),
      update: call(C.PITCH_UPDATE),
    }),
    outreach: Object.freeze({
      approve: call(C.OUTREACH_APPROVE),
      gate: call(C.OUTREACH_GATE),
    }),
    exports: Object.freeze({ research: call(C.EXPORT_RESEARCH) }),
    email: Object.freeze({ send: call(C.EMAIL_SEND) }),
    enrichment: Object.freeze({
      request: call(C.ENRICHMENT_REQUEST),
      status: call(C.ENRICHMENT_STATUS),
      profile: call(C.ENRICHMENT_PROFILE),
      providers: call(C.ENRICHMENT_PROVIDERS),
    }),
  });
}

function exposeLeadIntelligence({ contextBridge, ipcRenderer }, key = 'ztechLeadIntel') {
  contextBridge.exposeInMainWorld(key, buildLeadIntelligenceApi(ipcRenderer));
}

module.exports = { buildLeadIntelligenceApi, exposeLeadIntelligence };
