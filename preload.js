const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appAPI', {
  provider: {
    testConnection: (apiKey, taskKey, providerId) => ipcRenderer.invoke('provider:test-connection', { providerId, apiKey, taskKey })
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
    getNumbers: () => ipcRenderer.invoke('collector:get-numbers'),
    addNumbers: (numbers) => ipcRenderer.invoke('collector:add-numbers', numbers),
    exportNumbers: (format) => ipcRenderer.invoke('collector:export-numbers', format),
    deleteNumbers: (ids) => ipcRenderer.invoke('collector:delete-numbers', ids),
    storageStatus: () => ipcRenderer.invoke('collector:storage-status')
  },

  // 日志
  logs: {
    exportLogs: () => ipcRenderer.invoke('logs:export'),
    getLogDir: () => ipcRenderer.invoke('logs:dir'),
    report: (payload) => ipcRenderer.invoke('logs:report', payload)
  }
});
