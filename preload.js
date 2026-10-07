const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appAPI', {
  provider: {
    testConnection: (apiKey, taskKey, providerId, useStored) => ipcRenderer.invoke('provider:test-connection', { providerId, apiKey, taskKey, useStored })
  },

  collection: {
    submit: (params, providerId) => ipcRenderer.invoke('collection:submit', { providerId, params }),
    getStatus: (jobId, providerId) => ipcRenderer.invoke('collection:job-status', { providerId, jobId }),
    getResult: (jobId, options, providerId) => ipcRenderer.invoke('collection:job-result', { providerId, jobId, ...(options || {}) }),
    getHistory: (limit = 20, offset = 0, providerId) => ipcRenderer.invoke('collection:job-history', { providerId, limit, offset })
  },

  // 设置
  settings: {
    save: (settings) => ipcRenderer.invoke('settings:save', settings),
    load: () => ipcRenderer.invoke('settings:load')
  },
  // F26: Outreach Settings. Keys are WRITE-ONLY (setKey seals in main; nothing returns
  // them). Methods take a channel ('email' | 'whatsapp'), never a provider id.
  // verify asks main for one read-only provider check and returns only
  // { status, checkedAt, message }.
  outreachSettings: Object.freeze({
    status: () => ipcRenderer.invoke('outreach-settings:status', {}),
    saveBusiness: (payload) => ipcRenderer.invoke('outreach-settings:save-business', payload || {}),
    saveEmail: (payload) => ipcRenderer.invoke('outreach-settings:save-email', payload || {}),
    saveWhatsApp: (payload) => ipcRenderer.invoke('outreach-settings:save-whatsapp', payload || {}),
    setKey: (channel, key) => ipcRenderer.invoke('outreach-settings:set-key', { channel, key }),
    clearKey: (channel) => ipcRenderer.invoke('outreach-settings:clear-key', { channel }),
    verify: (channel) => ipcRenderer.invoke('outreach-settings:verify', { channel }),
  }),

  // 官网调研 (prospect research). Every method passes through a trusted-sender
  // check in main. The API key is write-only from here: no method returns it.
  // importArtifact takes no path - main owns the file dialog.
  research: {
    request: (leadRef, force) => ipcRenderer.invoke('prospect-research:request', leadRef, force === true),
    get: (leadRef) => ipcRenderer.invoke('prospect-research:get', leadRef),
    // F7: read-only research overview (no parameters).
    list: () => ipcRenderer.invoke('prospect-research:list'),
    importArtifact: (leadRef) => ipcRenderer.invoke('prospect-research:import-artifact', leadRef),
    providerHealth: () => ipcRenderer.invoke('prospect-research:provider-health'),
    setApiKey: (key) => ipcRenderer.invoke('prospect-research:set-api-key', key),
    clearApiKey: () => ipcRenderer.invoke('prospect-research:clear-api-key'),
    keyStatus: () => ipcRenderer.invoke('prospect-research:key-status')
  },

  // 代理
  proxy: {
    detect: () => ipcRenderer.invoke('proxy:detect')
  },

  // 采集结果
  collector: {
    getNumbers: (query) => ipcRenderer.invoke('collector:get-numbers', query),
    addNumbers: (numbers, context) => ipcRenderer.invoke('collector:add-numbers', numbers, context),
    exportNumbers: (format) => ipcRenderer.invoke('collector:export-numbers', format),
    deleteNumbers: (ids) => ipcRenderer.invoke('collector:delete-numbers', ids),
    storageStatus: () => ipcRenderer.invoke('collector:storage-status'),
    getJobs: (query) => ipcRenderer.invoke('collector:get-jobs', query),
    updateLead: (payload) => ipcRenderer.invoke('collector:update-lead', payload),
    updateLeadQuality: (payload) => ipcRenderer.invoke('collector:update-lead-quality', payload),
    // P1-E: read-only duplicate review. The only P1-E method, and it can only
    // pass a review rule and paging bounds to the main process.
    duplicateReview: (query) => ipcRenderer.invoke('collector:duplicate-review', query),
    // P1-G: the read-only Collection Quality Report for one run, and the
    // attached target's required-field completeness. Neither can write.
    qualityReport: (query) => ipcRenderer.invoke('collector:quality-report', query),
    qualityTargetReport: (query) => ipcRenderer.invoke('collector:quality-target-report', query)
  },

  // P1-F 目标定义 (targets): user-owned prospecting definitions, provider-
  // independent. These three methods cannot read or write a lead.
  targets: {
    list: () => ipcRenderer.invoke('targets:list'),
    save: (payload) => ipcRenderer.invoke('targets:save', payload),
    setStatus: (payload) => ipcRenderer.invoke('targets:set-status', payload)
  },
  // F6 Lists: saved searches (query definitions) and segments (static member
  // lists or dynamic rules). User-owned definitions; none can write a lead.
  lists: {
    listSavedSearches: () => ipcRenderer.invoke('saved-searches:list'),
    saveSavedSearch: (payload) => ipcRenderer.invoke('saved-searches:save', payload),
    deleteSavedSearch: (payload) => ipcRenderer.invoke('saved-searches:delete', payload),
    listSegments: () => ipcRenderer.invoke('segments:list'),
    saveSegment: (payload) => ipcRenderer.invoke('segments:save', payload),
    updateSegmentMembers: (payload) => ipcRenderer.invoke('segments:members', payload),
    deleteSegment: (payload) => ipcRenderer.invoke('segments:delete', payload)
  },
  // F8 Intelligence: read-only ICP fit (Lead Intelligence contract).
  intelligence: {
    icpFit: (payload) => ipcRenderer.invoke('intelligence:icp', payload)
  },

  // 日志
  logs: {
    exportLogs: () => ipcRenderer.invoke('logs:export'),
    getLogDir: () => ipcRenderer.invoke('logs:dir'),
    report: (payload) => ipcRenderer.invoke('logs:report', payload)
  }
});

// A10 Lead Intelligence (outreach only). Exactly six methods, each a fixed
// channel: the renderer can never pass a channel name, a URL, a file path or a
// credential. There is deliberately NO email.send — the email provider stays
// abstract in this phase, so no send path is exposed to the renderer at all.
//
// outreach.list is read-only enumeration of stored pitch drafts. It passes a fixed
// payload shape only; the renderer cannot choose a sort field, an ordering or any
// column, because the main-process schema rejects any other property.
contextBridge.exposeInMainWorld('ztechLeadIntel', Object.freeze({
  pitch: Object.freeze({
    generate: (payload) => ipcRenderer.invoke('lead-intel:pitch-generate', payload || {}),
    get: (payload) => ipcRenderer.invoke('lead-intel:pitch-get', payload || {}),
    update: (payload) => ipcRenderer.invoke('lead-intel:pitch-update', payload || {})
  }),
  outreach: Object.freeze({
    approve: (payload) => ipcRenderer.invoke('lead-intel:outreach-approve', payload || {}),
    gate: (payload) => ipcRenderer.invoke('lead-intel:outreach-gate', payload || {}),
    list: (payload) => ipcRenderer.invoke('lead-intel:outreach-list', payload || {}),
    // F15: read-only activity history. This is the ONLY activity method: there is no
    // create/update/delete bridge, so the renderer cannot invent an activity record.
    activity: (payload) => ipcRenderer.invoke('lead-intel:outreach-activity', payload || {}),
    // F16: the derived Ready queue. Read-only: it reports what the existing OutreachGate
    // currently allows. There is no send, schedule or provider method anywhere on this
    // bridge, and readiness is derived, never written.
    ready: (payload) => ipcRenderer.invoke('lead-intel:outreach-ready', payload || {}),
    // F18: read-only preparation of ONE ready pitch on ONE factual channel. The payload
    // is exactly { pitchId, channel }; the recipient always comes from the stored contact
    // facts in the main process. This is a preview read: nothing is sent, queued,
    // scheduled or recorded, and no provider is reachable through it.
    prepare: (payload) => ipcRenderer.invoke('lead-intel:outreach-prepare', payload || {}),
    // F19: the send boundary. This is the ONLY method on this bridge that can cause an
    // outbound message to leave the process, and its payload is EXACTLY { pitchId }.
    //
    // The renderer cannot supply a recipient, a from-address, a subject, a body, a
    // provider, a channel or a template: the IPC schema admits only pitchId, and
    // everything else is re-derived in the main process from the stored contact facts,
    // the configured from-address and the canonical pitch text. The OutreachGate is
    // re-checked there immediately before a provider is contacted, and the same approved
    // content can never be accepted twice.
    //
    // The resolved value reports provider ACKNOWLEDGEMENT only. `providerAcknowledged` is
    // the single fact about the outside world; `deliveryStatus`, `openStatus` and
    // `clickStatus` are always 'unknown', never true and never false, because nothing in
    // this build observes an inbox. There is deliberately no sendAll, sendBatch, schedule,
    // queue or campaign method anywhere on this bridge.
    outreachSend: (payload) => ipcRenderer.invoke('lead-intel:outreach-send', payload || {}),
    // F21: read-only send history. F19/F20 already persisted one row per send attempt but
    // nothing could read it back, so a provider call that really happened could not be
    // audited or explained. This is that read, and ONLY that read.
    //
    // Its payload is limit/offset plus at most one of leadId/pitchId, and the main-process
    // schema is additionalProperties:false, so the renderer cannot name a recipient, a
    // provider, a channel or a message payload here. There is deliberately NO sendRetry,
    // sendAgain, sendBatch, schedule or queue method on this bridge: another attempt goes
    // back through outreachSend above, so the capability check, the OutreachGate, the
    // approval and content integrity, the recipient lookup and the idempotency rule all run
    // again. Nothing on this bridge can mark a row accepted, delete one, or invent one.
    sends: (payload) => ipcRenderer.invoke('lead-intel:outreach-sends', payload || {})
  }),
  // Phase I2: Opportunity Intelligence - read-only research context.
  //
  // This is a SEPARATE intelligence system from Zuni-SEO. It answers a different
  // question (multi-entity, opportunities, competitors, ads, social, timeline)
  // and has its own channels, its own store and its own contract (IntelligenceReport).
  // The renderer CANNOT supply a URL, a host, an endpoint or a credential.
  // The renderer CANNOT trigger a send, an approve, a schedule or a campaign.
  // The only write is REQUEST: asking the main process to run OI for a lead,
  // where the identity comes from the main store, never the renderer.
  opportunity: Object.freeze({
    health: () => ipcRenderer.invoke('lead-intel:opportunity-health'),
    engine: () => ipcRenderer.invoke('lead-intel:opportunity-engine'),
    // Request OI research for a lead. Payload is exactly { leadId, force? }.
    // The renderer supplies ONLY the leadId and a boolean "force" flag.
    // Company name, domain, location, industry come from the main store.
    request: (payload) => ipcRenderer.invoke('lead-intel:opportunity-request', payload || {}),
    // Get a specific OI report by research_id. Payload is { leadId?, researchId }.
    report: (payload) => ipcRenderer.invoke('lead-intel:opportunity-report', payload || {}),
    // The lead's latest OI report, if one was recorded this session.
    latest: (payload) => ipcRenderer.invoke('lead-intel:opportunity-latest', payload || {}),
    // Association ledger for a lead: ids only, no report content.
    associations: (payload) => ipcRenderer.invoke('lead-intel:opportunity-associations', payload || {}),
    // Pitch Evidence Bridge: bounded context for the existing PitchGenerator.
    // Returns { available, bridge: { packet, claim_kinds, oi, counts, excluded, boundaries } }.
    pitchContext: (payload) => ipcRenderer.invoke('lead-intel:opportunity-pitch-context', payload || {}),
    // I7: an unsaved preview built from OI facts and estimates. Payload is { leadId }. The
    // result has no pitch id: it can never be approved, saved or sent.
    pitchPreview: (payload) => ipcRenderer.invoke('lead-intel:opportunity-pitch-preview', payload || {}),
  }),
  // I6: the read-only unified lead timeline. Payload is { leadId, limit?, before?, sources? };
  // it returns events built from ZTech's own records. Nothing on it can write or send.
  timeline: Object.freeze({
    forLead: (payload) => ipcRenderer.invoke('lead-intel:timeline', payload || {}),
  }),
  // F26.5: Compliance & Trust. Every payload names a lead (or a pitch) and a channel - never an
  // address: main reads the address from the stored lead. There is no "they replied" method:
  // a reply counts only when it arrives as a verified relay event. handoff() opens the person's
  // own mail app (mailto) or copies the text; it is NOT a send and records no send.
  trust: Object.freeze({
    forLead: (payload) => ipcRenderer.invoke('lead-intel:trust-lead', payload || {}),
    suppress: (payload) => ipcRenderer.invoke('lead-intel:trust-suppress', payload || {}),
    lift: (payload) => ipcRenderer.invoke('lead-intel:trust-lift', payload || {}),
    recordConsent: (payload) => ipcRenderer.invoke('lead-intel:trust-consent', payload || {}),
    handoff: (payload) => ipcRenderer.invoke('lead-intel:trust-handoff', payload || {}),
  }),
  // I3: Opportunity Intelligence provider configuration - WRITE-ONLY for keys.
  // setKey sends a key to the main process, which seals it; nothing ever returns it.
  // status returns booleans per provider (stored / readable / loaded by OI) and the
  // four non-secret settings. No path, port, URL or token is reachable from here.
  opportunitySettings: Object.freeze({
    status: () => ipcRenderer.invoke('oi-config:status', {}),
    setKey: (provider, key) => ipcRenderer.invoke('oi-config:set-key', { provider, key }),
    clearKey: (provider) => ipcRenderer.invoke('oi-config:clear-key', { provider }),
    setSetting: (name, value) => ipcRenderer.invoke('oi-config:set-setting', { name, value }),
    // I4: the local OI service. No path, port or command is ever sent or returned:
    // chooseFolder asks main to open a native folder dialog.
    chooseFolder: () => ipcRenderer.invoke('oi-service:choose-folder', {}),
    setMode: (mode) => ipcRenderer.invoke('oi-service:set-mode', { mode }),
    start: () => ipcRenderer.invoke('oi-service:start', {}),
    stop: () => ipcRenderer.invoke('oi-service:stop', {}),
    restart: () => ipcRenderer.invoke('oi-service:restart', {}),
    copyLog: () => ipcRenderer.invoke('oi-service:copy-log', {}),
  })
}));
