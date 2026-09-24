const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appAPI', {
  // CoreClaw 采集
  coreclaw: {
    setApiKey: (key) => ipcRenderer.invoke('coreclaw:set-api-key', key),
    runGoogleMaps: (params) => ipcRenderer.invoke('coreclaw:run-google-maps', params),
    getRunResult: (runSlug) => ipcRenderer.invoke('coreclaw:get-run-result', runSlug),
    getRunStatus: (runSlug) => ipcRenderer.invoke('coreclaw:get-run-status', runSlug),
    getStore: () => ipcRenderer.invoke('coreclaw:get-store'),
    testConnection: (apiKey, taskKey) => ipcRenderer.invoke('coreclaw:test-connection', { apiKey, taskKey }),
    getHistory: (limit = 20, offset = 0) => ipcRenderer.invoke('coreclaw:get-history', { limit, offset })
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
    deleteNumbers: (ids) => ipcRenderer.invoke('collector:delete-numbers', ids)
  },

  // 日志
  logs: {
    exportLogs: () => ipcRenderer.invoke('logs:export'),
    getLogDir: () => ipcRenderer.invoke('logs:dir')
  },

  // 事件监听
  on: (channel, callback) => {
    const validChannels = [
      'coreclaw:run-complete'
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, (_, data) => callback(data));
    }
  },

  removeListener: (channel, callback) => {
    ipcRenderer.removeListener(channel, callback);
  }
});
