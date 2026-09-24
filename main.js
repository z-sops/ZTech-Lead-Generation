const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { CoreClawClient } = require('./src/main/coreClawClient');
const { AccountStore } = require('./src/main/accountStore');
const { logger } = require('./src/main/logger');

let mainWindow = null;
let coreClawClient = null;
let accountStore = null;

const isDev = process.env.NODE_ENV === 'development';

const ALLOWED_LANGS = new Set(['en', 'zh', 'es', 'fr', 'de', 'ar', 'pt', 'ja', 'ko']);
const ALLOWED_TITLE_MATCH_MODES = new Set(['all', 'exact', 'contains']);
const ALLOWED_MIN_RATINGS = new Set(['all', '4.5', '4.0', '3.5', '3.0']);
const ALLOWED_WEBSITE_FILTERS = new Set(['all', 'has_website', 'no_website']);
const ALLOWED_REVIEW_SORTS = new Set(['newest', 'highest', 'lowest', 'most_relevant']);
const COLLECT_BOOL_KEYS = [
  'skipClosed', 'fetchSocialInfo', 'facebook', 'instagram', 'youtube', 'tiktok',
  'linkedin', 'fetchPlaceDetails', 'fetchReservation', 'fetchOnlineOrder',
  'fetchWebResult', 'emailVerification', 'fetchReviews', 'includeReviewerInfo'
];
const RUN_SLUG_PATTERN = /^[A-Za-z0-9._~-]{1,200}$/;
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

function assertOptionalEnum(value, name, allowed) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw invalidParams(`Invalid params: ${name}`);
  }
}

function assertOptionalInt(value, name, min, max) {
  if (value === undefined || value === null) return;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw invalidParams(`Invalid params: ${name} (integer ${min}-${max})`);
  }
}

function validateRunSlug(runSlug) {
  if (typeof runSlug !== 'string' || !RUN_SLUG_PATTERN.test(runSlug)) {
    throw invalidParams('Invalid params: runSlug');
  }
  return runSlug;
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

function validateCollectParams(params) {
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

  assertOptionalString(params.location, 'location', 200);
  assertOptionalEnum(params.lang, 'lang', ALLOWED_LANGS);
  assertOptionalInt(params.maxResults, 'maxResults', 1, 500);
  assertOptionalEnum(params.titleMatchMode, 'titleMatchMode', ALLOWED_TITLE_MATCH_MODES);
  assertOptionalEnum(params.minRating, 'minRating', ALLOWED_MIN_RATINGS);
  assertOptionalEnum(params.websiteFilter, 'websiteFilter', ALLOWED_WEBSITE_FILTERS);
  assertOptionalEnum(params.reviewSortBy, 'reviewSortBy', ALLOWED_REVIEW_SORTS);
  assertOptionalInt(params.maxReviewsPerPlace, 'maxReviewsPerPlace', 1, 50);
  assertOptionalString(params.reviewKeyword, 'reviewKeyword', 200);

  for (const key of COLLECT_BOOL_KEYS) {
    if (params[key] !== undefined && params[key] !== null) {
      params[key] = params[key] === true;
    }
  }

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

function initServices() {
  accountStore = new AccountStore();
  coreClawClient = new CoreClawClient();
}

function registerIpcHandlers() {
  // CoreClaw 采集相关
  ipcMain.handle('coreclaw:set-api-key', (_, key) => {
    if (typeof key !== 'string' || key.length > MAX_KEY_LENGTH) {
      return rejectEnvelope('coreclaw:set-api-key', 'Invalid params: apiKey');
    }
    coreClawClient.setApiKey(key);
    return { success: true };
  });

  ipcMain.handle('coreclaw:run-google-maps', async (_, params) => {
    try {
      return await coreClawClient.runGoogleMaps(validateCollectParams(params));
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope('coreclaw:run-google-maps', err.message);
      logger.error('ipc', 'coreclaw:run-google-maps failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('coreclaw:get-run-result', (_, runSlug) => {
    try {
      validateRunSlug(runSlug);
    } catch (err) {
      return rejectEnvelope('coreclaw:get-run-result', err.message);
    }
    return coreClawClient.getRunResult(runSlug);
  });

  ipcMain.handle('coreclaw:get-run-status', (_, runSlug) => {
    try {
      validateRunSlug(runSlug);
    } catch (err) {
      return rejectEnvelope('coreclaw:get-run-status', err.message);
    }
    return coreClawClient.getRunStatus(runSlug);
  });

  ipcMain.handle('coreclaw:get-store', () => {
    return coreClawClient.getStore();
  });

  ipcMain.handle('coreclaw:get-history', (_, payload) => {
    try {
      const { limit, offset } = validateHistoryPaging(payload);
      return coreClawClient.getRunHistory(limit, offset);
    } catch (err) {
      return rejectEnvelope('coreclaw:get-history', err.message);
    }
  });

  ipcMain.handle('coreclaw:test-connection', async (_, payload) => {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    const apiKey = p.apiKey;
    const taskKey = p.taskKey;
    if (typeof apiKey !== 'string' || !apiKey || apiKey.length > MAX_KEY_LENGTH) {
      return rejectEnvelope('coreclaw:test-connection', 'Invalid params: apiKey');
    }
    if (taskKey !== undefined && taskKey !== null && (typeof taskKey !== 'string' || taskKey.length > MAX_KEY_LENGTH)) {
      return rejectEnvelope('coreclaw:test-connection', 'Invalid params: taskKey');
    }

    const testClient = new CoreClawClient();
    testClient.setApiKey(apiKey);

    const result = await testClient.getWorkerInputSchema('coreclaw~google-maps-scraper');
    if (!result.success) {
      logger.info('coreclaw', 'connection test failed', { apiKeyValid: false, hasTaskKey: !!taskKey, error: result.error });
      return { success: false, error: 'API Key 无效或网络错误: ' + result.error };
    }
    let taskKeyValid = false;
    if (taskKey) {
      const runs = await testClient.request('GET', `/api/v2/worker-runs?task_key=${encodeURIComponent(taskKey)}`);
      taskKeyValid = runs.success;
    }
    logger.info('coreclaw', 'connection test succeeded', { apiKeyValid: true, taskKeyValid, hasTaskKey: !!taskKey });
    return { success: true, apiKeyValid: true, taskKeyValid };
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
    coreClawClient.setApiKey(nextSettings.apiKey);
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
    return store.get('settings', {});
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
