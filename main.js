const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { CoreClawClient } = require('./src/main/coreClawClient');
const { AccountStore } = require('./src/main/accountStore');

let mainWindow = null;
let coreClawClient = null;
let accountStore = null;

const isDev = process.env.NODE_ENV === 'development';

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
}

function initServices() {
  accountStore = new AccountStore();
  coreClawClient = new CoreClawClient();
}

function registerIpcHandlers() {
  // CoreClaw 采集相关
  ipcMain.handle('coreclaw:set-api-key', (_, key) => {
    coreClawClient.setApiKey(key);
    return { success: true };
  });

  ipcMain.handle('coreclaw:run-google-maps', (_, params) => {
    return coreClawClient.runGoogleMaps(params);
  });

  ipcMain.handle('coreclaw:get-run-result', (_, runSlug) => {
    return coreClawClient.getRunResult(runSlug);
  });

  ipcMain.handle('coreclaw:get-run-status', (_, runSlug) => {
    return coreClawClient.getRunStatus(runSlug);
  });

  ipcMain.handle('coreclaw:get-store', () => {
    return coreClawClient.getStore();
  });

  ipcMain.handle('coreclaw:get-history', (_, { limit, offset }) => {
    return coreClawClient.getRunHistory(limit, offset);
  });

  ipcMain.handle('coreclaw:test-connection', async (_, { apiKey, taskKey }) => {
    coreClawClient.setApiKey(apiKey);
    const result = await coreClawClient.getWorkerInputSchema('coreclaw~google-maps-scraper');
    if (!result.success) {
      return { success: false, error: 'API Key 无效或网络错误: ' + result.error };
    }
    let taskKeyValid = false;
    if (taskKey) {
      const runs = await coreClawClient.request('GET', `/api/v2/worker-runs?task_key=${taskKey}`);
      taskKeyValid = runs.success;
    }
    return { success: true, apiKeyValid: true, taskKeyValid };
  });

  ipcMain.handle('settings:save', (_, settings) => {
    const Store = require('electron-store');
    const store = new Store();
    const nextSettings = {
      apiKey: settings.apiKey || '',
      taskKey: settings.taskKey || '',
      proxyUrl: settings.proxyUrl || ''
    };
    store.set('settings', nextSettings);
    if (nextSettings.apiKey) coreClawClient.setApiKey(nextSettings.apiKey);
    return { success: true };
  });

  ipcMain.handle('settings:load', () => {
    const Store = require('electron-store');
    const store = new Store();
    return store.get('settings', {});
  });

  // 采集结果管理
  ipcMain.handle('collector:get-numbers', () => {
    return accountStore.getCollectedNumbers();
  });

  ipcMain.handle('collector:add-numbers', (_, numbers) => {
    return accountStore.addNumbers(numbers);
  });

  ipcMain.handle('collector:export-numbers', (_, format) => {
    return accountStore.exportNumbers(format);
  });

  ipcMain.handle('collector:delete-numbers', (_, ids) => {
    return accountStore.deleteNumbers(ids);
  });

  ipcMain.handle('logs:export', () => {
    const { logger } = require('./src/main/logger');
    return logger.exportLogs();
  });

  ipcMain.handle('logs:dir', () => {
    const { logger } = require('./src/main/logger');
    return logger.getLogDir();
  });

  ipcMain.handle('proxy:detect', async () => {
    const { autoDetectProxy } = require('./src/main/proxyDetector');
    const result = await autoDetectProxy();
    return result || { source: null, proxyUrl: null };
  });

}

app.whenReady().then(() => {
  createMainWindow();
  initServices();
  registerIpcHandlers();
});

app.on('window-all-closed', () => {
  app.quit();
});
