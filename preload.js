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
    prepare: (payload) => ipcRenderer.invoke('lead-intel:outreach-prepare', payload || {})
  })
}));
