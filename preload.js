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

  // 日志
  logs: {
    exportLogs: () => ipcRenderer.invoke('logs:export'),
    getLogDir: () => ipcRenderer.invoke('logs:dir'),
    report: (payload) => ipcRenderer.invoke('logs:report', payload)
  }
});
