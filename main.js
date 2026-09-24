const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { AccountStore } = require('./src/main/accountStore');
const { logger } = require('./src/main/logger');
const { ProviderManager } = require('./src/main/providers/providerManager');
const { CoreClawAdapter } = require('./src/main/providers/coreclawAdapter');
const { migrateLegacySettingsToProviders } = require('./src/main/providers/legacySettingsMigration');

let mainWindow = null;
let providerManager = null;
let legacyProviderId = null;
let accountStore = null;

const isDev = process.env.NODE_ENV === 'development';

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

function validateSettingsPayload(settings) {
  assertPlainObject(settings, 'settings');
  const out = { apiKey: '', taskKey: '', proxyUrl: '' };
  for (const key of ['apiKey', 'taskKey', 'proxyUrl']) {
    const value = settings[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw invalidParams(`Invalid settings: ${key} (string required)`);
    if (value.length > MAX_KEY_LENGTH) throw invalidParams(`Invalid settings: ${key} (max ${MAX_KEY_LENGTH} chars)`);
    out[key] = value;
  }
  out.proxyUrl = validateProxyUrl(out.proxyUrl);
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
    for (const key of ['source', 'keyword', 'collectedAt']) {
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

function initServices() {
  accountStore = new AccountStore();
  providerManager = new ProviderManager();
  const adapter = providerManager.register(new CoreClawAdapter());
  legacyProviderId = adapter.providerId;
  const Store = require('electron-store');
  const store = new Store();
  migrateLegacySettingsToProviders(store, adapter.providerId);
  const credentials = loadProviderCredentials(store, adapter.providerId);
  if (credentials) {
    providerManager.setCredentials(adapter.providerId, credentials);
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
      return await adapter.submitCollection(shaped);
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobState(channel, providerId, jobId) {
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      return await adapter.getJobState(jobId);
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobResults(channel, providerId, jobId, options) {
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      return await adapter.getJobResults(jobId, options);
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

  async function handleGetStore(channel, providerId) {
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      if (typeof adapter.getStore !== 'function') {
        return { success: false, error: 'not supported' };
      }
      return await adapter.getStore();
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleTestConnection(channel, providerId, payload) {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
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

  ipcMain.handle('collection:store', (_, payload) => {
    return handleGetStore('collection:store', providerIdFrom(payload));
  });

  ipcMain.handle('coreclaw:set-api-key', (_, key) => {
    if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) {
      return rejectEnvelope('coreclaw:set-api-key', 'Invalid params: apiKey');
    }
    return handleSetCredentials('coreclaw:set-api-key', legacyProviderId, { apiKey: key });
  });

  ipcMain.handle('coreclaw:run-google-maps', (_, params) => {
    return handleCollectionSubmit('coreclaw:run-google-maps', legacyProviderId, params);
  });

  ipcMain.handle('coreclaw:get-run-result', (_, runSlug) => {
    return handleGetJobResults('coreclaw:get-run-result', legacyProviderId, runSlug);
  });

  ipcMain.handle('coreclaw:get-run-status', (_, runSlug) => {
    return handleGetJobState('coreclaw:get-run-status', legacyProviderId, runSlug);
  });

  ipcMain.handle('coreclaw:get-store', () => {
    return handleGetStore('coreclaw:get-store', legacyProviderId);
  });

  ipcMain.handle('coreclaw:get-history', (_, payload) => {
    return handleGetJobHistory('coreclaw:get-history', legacyProviderId, payload);
  });

  ipcMain.handle('coreclaw:test-connection', (_, payload) => {
    return handleTestConnection('coreclaw:test-connection', legacyProviderId, payload);
  });

  ipcMain.handle('settings:save', (_, settings) => {
    let nextSettings;
    try {
      nextSettings = validateSettingsPayload(settings);
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    const Store = require('electron-store');
    const store = new Store();
    store.set('settings', nextSettings);
    let activeProviderId;
    try {
      activeProviderId = providerManager.resolveCollectionProvider().providerId;
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    persistProviderCredentials(store, activeProviderId, {
      apiKey: nextSettings.apiKey,
      taskKey: nextSettings.taskKey
    });
    providerManager.setCredentials(activeProviderId, {
      apiKey: nextSettings.apiKey,
      taskKey: nextSettings.taskKey
    });
    logger.info('settings', 'settings saved', {
      hasApiKey: !!nextSettings.apiKey,
      hasTaskKey: !!nextSettings.taskKey,
      hasProxy: !!nextSettings.proxyUrl
    });
    return { success: true };
  });

  ipcMain.handle('settings:load', () => {
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
    return {
      apiKey: credentials && typeof credentials.apiKey === 'string'
        ? credentials.apiKey
        : (typeof base.apiKey === 'string' ? base.apiKey : ''),
      taskKey: credentials && typeof credentials.taskKey === 'string'
        ? credentials.taskKey
        : (typeof base.taskKey === 'string' ? base.taskKey : ''),
      proxyUrl: typeof base.proxyUrl === 'string' ? base.proxyUrl : ''
    };
  });

  // 采集结果管理
  ipcMain.handle('collector:get-numbers', () => {
    return accountStore.getCollectedNumbers();
  });

  ipcMain.handle('collector:add-numbers', (_, numbers) => {
    try {
      return accountStore.addNumbers(validateNumbersPayload(numbers));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:add-numbers', err.message);
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

  ipcMain.handle('logs:export', () => {
    return logger.exportLogs();
  });

  ipcMain.handle('logs:dir', () => {
    return logger.getLogDir();
  });

  ipcMain.handle('proxy:detect', async () => {
    const { autoDetectProxy } = require('./src/main/proxyDetector');
    const result = await autoDetectProxy();
    return result || { source: null, proxyUrl: null };
  });

}

app.whenReady().then(() => {
  logger.info('app', 'application started', { version: app.getVersion(), isDev });
  createMainWindow();
  initServices();
  registerIpcHandlers();
});

app.on('window-all-closed', () => {
  app.quit();
});
