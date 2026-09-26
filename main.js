const { app, BrowserWindow, ipcMain, Menu, session, shell } = require('electron');
const path = require('path');
const { AccountStore } = require('./src/main/accountStore');
const { logger } = require('./src/main/logger');
const { ProviderManager } = require('./src/main/providers/providerManager');
const { CoreClawAdapter } = require('./src/main/providers/coreclawAdapter');
const { migrateLegacySettingsToProviders } = require('./src/main/providers/legacySettingsMigration');
const credentialVault = require('./src/main/credentialVault');

let mainWindow = null;
let providerManager = null;
let accountStore = null;

const isDev = process.env.NODE_ENV === 'development';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow === null) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  } catch (err) {
    logger.warn('app', 'second-instance focus failed', { error: err.message });
  }
});

process.on('uncaughtException', (err) => {
  try {
    logger.error('process', 'uncaughtException', { error: err.message, stack: err.stack });
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    logger.error('process', 'unhandledRejection', { error: String(reason) });
  } catch {}
});

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

async function applyProxyConfiguration(proxyUrl) {
  try {
    if (!session || !session.defaultSession || typeof session.defaultSession.setProxy !== 'function') {
      logger.warn('proxy', 'proxy configuration skipped', { reason: 'session-unavailable' });
      return { applied: false, reason: 'session-unavailable' };
    }
    const proxyRules = proxyUrl ? validateProxyUrl(proxyUrl) : '';
    await session.defaultSession.setProxy(proxyRules ? { proxyRules } : { mode: 'direct' });
    logger.info('proxy', 'proxy configuration applied', { hasProxy: !!proxyRules });
    return { applied: true };
  } catch (err) {
    logger.warn('proxy', 'proxy configuration failed', { error: err.message });
    return { applied: false, reason: err.message };
  }
}

function validateSettingsPayload(settings) {
  assertPlainObject(settings, 'settings');
  const out = { apiKey: '', taskKey: '', proxyUrl: '', clearApiKey: false, clearTaskKey: false };
  for (const key of ['apiKey', 'taskKey', 'proxyUrl']) {
    const value = settings[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string') throw invalidParams(`Invalid settings: ${key} (string required)`);
    if (value.length > MAX_KEY_LENGTH) throw invalidParams(`Invalid settings: ${key} (max ${MAX_KEY_LENGTH} chars)`);
    out[key] = value;
  }
  for (const flag of ['clearApiKey', 'clearTaskKey']) {
    const value = settings[flag];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'boolean') throw invalidParams(`Invalid settings: ${flag} (boolean required)`);
    out[flag] = value;
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
    for (const key of ['source', 'keyword', 'collectedAt', 'title', 'website', 'email', 'address', 'runSlug']) {
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

// B6 user-owned lead fields. This is the authoritative validator: the
// renderer is never trusted, so every bound below is enforced here before
// the payload reaches the store. Limits are compile-time constants shared by
// contract, not by import, so main and store cannot drift silently.
const LEAD_QUALIFICATION_VALUES = ['unqualified', 'qualified'];
const MAX_LEAD_TAGS = 20;
const MAX_LEAD_TAG_LENGTH = 50;
const MAX_LEAD_NOTES_LENGTH = 5000;

// Validates one collector:update-lead payload and returns the normalised
// { id, qualification, tags, notes } written to storage. Tags are trimmed,
// empties rejected and deduplicated case-insensitively with the first
// occurrence kept, so the renderer may send optimistic input.
function validateLeadUpdatePayload(payload) {
  assertPlainObject(payload, 'lead update');
  // Same bounds and messages as the B3 single-lead id predicate.
  if (typeof payload.id !== 'string' || !payload.id || payload.id.length > 100) {
    throw invalidParams('Invalid params: id (non-empty required)');
  }
  if (!LEAD_QUALIFICATION_VALUES.includes(payload.qualification)) {
    throw invalidParams('Invalid params: qualification (unqualified|qualified required)');
  }
  if (!Array.isArray(payload.tags)) {
    throw invalidParams('Invalid params: tags (array required)');
  }
  if (payload.tags.length > MAX_LEAD_TAGS) {
    throw invalidParams(`Invalid params: tags (max ${MAX_LEAD_TAGS})`);
  }
  const tags = [];
  for (let i = 0; i < payload.tags.length; i++) {
    const raw = payload.tags[i];
    if (typeof raw !== 'string') {
      throw invalidParams(`Invalid params: tags[${i}] (string required)`);
    }
    const tag = raw.trim();
    if (!tag) {
      throw invalidParams(`Invalid params: tags[${i}] (non-empty required)`);
    }
    if (tag.length > MAX_LEAD_TAG_LENGTH) {
      throw invalidParams(`Invalid params: tags[${i}] (max ${MAX_LEAD_TAG_LENGTH} chars)`);
    }
    const key = tag.toLowerCase();
    if (tags.some(existing => existing.toLowerCase() === key)) continue;
    tags.push(tag);
  }
  if (typeof payload.notes !== 'string') {
    throw invalidParams('Invalid params: notes (string required)');
  }
  if (payload.notes.length > MAX_LEAD_NOTES_LENGTH) {
    throw invalidParams(`Invalid params: notes (max ${MAX_LEAD_NOTES_LENGTH} chars)`);
  }
  return { id: payload.id, qualification: payload.qualification, tags, notes: payload.notes };
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

// B2 query layer: the only sort identifiers ever handed to the store.
const NUMBERS_QUERY_SORT_FIELDS = ['collectedAt', 'title', 'phone', 'source', 'keyword'];

// Validates the optional collector:get-numbers query payload. Paging bounds
// are reused verbatim from validateHistoryPaging; unknown keys are ignored
// (validateSettingsPayload convention); a non-object payload collapses to
// the paging defaults; order is only meaningful together with sort; an
// optional id (B3) restricts the query to a single lead by primary key.
function validateNumbersQuery(payload) {
  const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
  const { limit, offset } = validateHistoryPaging(p);
  const out = { limit, offset };
  assertOptionalString(p.search, 'search', MAX_KEY_LENGTH);
  if (typeof p.search === 'string' && p.search.trim()) out.search = p.search.trim();
  // B3 single-lead lookup: optional exact id (mirrors validateIdList bounds).
  if (p.id !== undefined && p.id !== null) {
    assertOptionalString(p.id, 'id', 100);
    if (!p.id) throw invalidParams('Invalid params: id (non-empty required)');
    out.id = p.id;
  }
  if (p.filters !== undefined && p.filters !== null) {
    assertPlainObject(p.filters, 'filters');
    const filters = {};
    for (const key of ['status', 'source', 'keyword', 'qualification']) {
      const value = p.filters[key];
      if (value === undefined || value === null) continue;
      assertOptionalString(value, `filters.${key}`, MAX_KEY_LENGTH);
      filters[key] = value;
    }
    out.filters = filters;
  }
  if (p.sort !== undefined && p.sort !== null) {
    if (typeof p.sort !== 'string' || !NUMBERS_QUERY_SORT_FIELDS.includes(p.sort)) {
      throw invalidParams('Invalid params: sort');
    }
    out.sort = p.sort;
    out.order = 'asc';
    if (p.order !== undefined && p.order !== null) {
      if (p.order !== 'asc' && p.order !== 'desc') {
        throw invalidParams('Invalid params: order');
      }
      out.order = p.order;
    }
  }
  return out;
}

// === B4 local collection-job ledger hooks ===
// Every ledger call is best-effort: the provider-side operation has already
// succeeded when these run, so a ledger persistence failure must never
// change the collection IPC result (it is logged and swallowed instead —
// a reported failure for an accepted run would invite duplicate submits).

// Mirrors the poll-side terminal mapping in the renderer: only the states
// evidenced by the repository are recognised; anything else is non-terminal
// and the ledger stays untouched.
function normalizeJobStatus(rawState) {
  if (rawState === 'succeeded' || rawState === 'completed' || rawState === 'success') return 'succeeded';
  if (rawState === 'failed' || rawState === 'error') return 'failed';
  return null;
}

async function recordJobSubmitted(providerId, shaped, submitResult) {
  try {
    if (!submitResult || submitResult.success !== true) return;
    const runSlug = submitResult.data && submitResult.data.run_slug;
    if (typeof runSlug !== 'string') return;
    await accountStore.insertJob({
      runSlug,
      providerId,
      query: Array.isArray(shaped.keywords) ? shaped.keywords.join(', ') : '',
      startedAt: new Date().toISOString(),
      completedAt: '',
      status: 'running',
      resultCount: null,
      error: ''
    });
  } catch (err) {
    logger.error('job', 'job ledger write failed', { error: err.message });
  }
}

async function recordJobState(providerId, jobId, stateResult) {
  try {
    if (!stateResult || stateResult.success !== true) return;
    const data = stateResult.data && typeof stateResult.data === 'object' ? stateResult.data : {};
    const rawState = data.status !== undefined && data.status !== null ? data.status : data.state;
    const canonical = normalizeJobStatus(rawState);
    if (!canonical) return;
    const errorText = canonical === 'failed' && typeof data.error === 'string' ? data.error : '';
    await accountStore.updateJobState(providerId, jobId, canonical, errorText);
  } catch (err) {
    logger.error('job', 'job ledger state update failed', { error: err.message });
  }
}

async function recordJobResultCount(providerId, jobId, options, result) {
  try {
    if (!result || result.success !== true) return;
    const list = result.data && Array.isArray(result.data.list) ? result.data.list : null;
    if (!list) return;
    const limit = options && Number.isInteger(options.limit) ? options.limit : 100;
    const offset = options && Number.isInteger(options.offset) ? options.offset : 0;
    // Final-page rule: only a short page proves the run's result set ends
    // here. Full pages (including duplicate-page terminations) are not
    // reliable counts and leave resultCount NULL rather than guessing.
    if (list.length >= limit) return;
    await accountStore.setJobResultCount(providerId, jobId, offset + list.length);
  } catch (err) {
    logger.error('job', 'job ledger result count failed', { error: err.message });
  }
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

  mainWindow.webContents.setWindowOpenHandler?.(({ url }) => {
    let protocol = null;
    try {
      protocol = new URL(url).protocol;
    } catch {}
    if (protocol === 'http:' || protocol === 'https:') {
      Promise.resolve()
        .then(() => shell.openExternal(url))
        .catch((err) => logger.warn('app', 'openExternal failed', { url, error: err.message }));
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev) {
      try {
        const devOrigin = new URL(`http://localhost:${process.env.VITE_PORT || 5173}`).origin;
        if (new URL(url).origin === devOrigin) return;
      } catch {}
    }
    event.preventDefault();
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

  mainWindow.webContents.on('render-process-gone', (event, details) => {
    try {
      logger.error('renderer', 'render-process-gone', {
        reason: details.reason,
        exitCode: details.exitCode
      });
    } catch {}
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

function canRevealCredential(value) {
  if (!credentialVault.isPresent(value)) return false;
  if (!credentialVault.isSealed(value)) return true;
  try {
    return credentialVault.unseal(value).length > 0;
  } catch {
    logger.warn('vault', 'stored credential could not be decrypted');
    return false;
  }
}

function initServices() {
  accountStore = new AccountStore();
  providerManager = new ProviderManager();
  const adapter = providerManager.register(new CoreClawAdapter());
  const Store = require('electron-store');
  const store = new Store();
  migrateLegacySettingsToProviders(store, adapter.providerId);
  const migration = credentialVault.migrateStoredCredentials(store, adapter.providerId);
  if (migration.status === 'complete') {
    if (migration.sealed > 0 || migration.removed > 0) {
      logger.info('vault', 'credential encryption migration complete', {
        sealed: migration.sealed,
        removed: migration.removed
      });
    }
  } else {
    logger.warn('vault', 'credential encryption migration deferred', {
      status: migration.status,
      reason: migration.reason || 'unknown'
    });
  }
  const credentials = loadProviderCredentials(store, adapter.providerId);
  if (credentials) {
    const plaintext = {};
    for (const field of ['apiKey', 'taskKey']) {
      const raw = credentials[field];
      if (typeof raw !== 'string' || raw === '') continue;
      try {
        plaintext[field] = credentialVault.reveal(raw);
      } catch {
        logger.warn('vault', 'stored credential could not be decrypted', { field });
      }
    }
    if (Object.keys(plaintext).length > 0) {
      providerManager.setCredentials(adapter.providerId, plaintext);
    }
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
      const result = await adapter.submitCollection(shaped);
      await recordJobSubmitted(adapter.providerId, shaped, result);
      return result;
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobState(channel, providerId, jobId) {
    try {
      const adapter = providerManager.resolveCollectionProvider(providerId);
      const result = await adapter.getJobState(jobId);
      await recordJobState(adapter.providerId, jobId, result);
      return result;
    } catch (err) {
      if (err.invalidParams) return rejectEnvelope(channel, err.message);
      logger.error('ipc', `${channel} failed`, { error: err.message });
      return { success: false, error: err.message };
    }
  }

  async function handleGetJobResults(channel, providerId, jobId, options) {
    try {
      if (options && typeof options === 'object') {
        if (options.offset !== undefined &&
            (!Number.isInteger(options.offset) || options.offset < 0 || options.offset > 100000)) {
          throw invalidParams('Invalid params: offset (integer 0-100000)');
        }
        if (options.limit !== undefined &&
            (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000)) {
          throw invalidParams('Invalid params: limit (integer 1-10000)');
        }
      }
      const adapter = providerManager.resolveCollectionProvider(providerId);
      const result = await adapter.getJobResults(jobId, options);
      await recordJobResultCount(adapter.providerId, jobId, options, result);
      return result;
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

  async function handleTestConnection(channel, providerId, payload) {
    const p = (payload && typeof payload === 'object' && !Array.isArray(payload)) ? payload : {};
    if (p.useStored === true) {
      let activeProviderId = providerId;
      if (typeof activeProviderId !== 'string' || activeProviderId === '') {
        try {
          activeProviderId = providerManager.resolveCollectionProvider().providerId;
        } catch (err) {
          if (err.invalidParams) return rejectEnvelope(channel, err.message);
          logger.error('ipc', `${channel} failed`, { error: err.message });
          return { success: false, error: err.message };
        }
      }
      const Store = require('electron-store');
      const credentials = loadProviderCredentials(new Store(), activeProviderId) || {};
      let apiKey = '';
      let taskKey = '';
      try {
        apiKey = credentialVault.reveal(typeof credentials.apiKey === 'string' ? credentials.apiKey : '');
        taskKey = credentialVault.reveal(typeof credentials.taskKey === 'string' ? credentials.taskKey : '');
      } catch {
        logger.warn('ipc', 'stored credentials could not be decrypted');
        return { success: false, error: 'Stored credentials could not be decrypted' };
      }
      if (!apiKey && !taskKey) {
        return { success: false, error: 'No stored credentials' };
      }
      try {
        const adapter = providerManager.resolveCollectionProvider(activeProviderId);
        return await adapter.testConnection({ apiKey, taskKey });
      } catch (err) {
        if (err.invalidParams) return rejectEnvelope(channel, err.message);
        logger.error('ipc', `${channel} failed`, { error: err.message });
        return { success: false, error: err.message };
      }
    }
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

  ipcMain.handle('settings:save', async (_, settings) => {
    let nextSettings;
    try {
      nextSettings = validateSettingsPayload(settings);
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    const Store = require('electron-store');
    const store = new Store();
    let activeProviderId;
    try {
      activeProviderId = providerManager.resolveCollectionProvider().providerId;
    } catch (err) {
      if (err.invalidParams) rejectLog('settings:save', err.message);
      throw err;
    }
    const currentCredentials = loadProviderCredentials(store, activeProviderId) || {};
    let plannedApiKey;
    let plannedTaskKey;
    let proxySealed = '';
    try {
      plannedApiKey = credentialVault.planCredentialUpdate(
        typeof currentCredentials.apiKey === 'string' ? currentCredentials.apiKey : '',
        { value: nextSettings.apiKey, clear: nextSettings.clearApiKey }
      );
      plannedTaskKey = credentialVault.planCredentialUpdate(
        typeof currentCredentials.taskKey === 'string' ? currentCredentials.taskKey : '',
        { value: nextSettings.taskKey, clear: nextSettings.clearTaskKey }
      );
      proxySealed = nextSettings.proxyUrl ? credentialVault.seal(nextSettings.proxyUrl) : '';
    } catch {
      logger.warn('settings', 'settings could not be encrypted', { reason: 'encryption-unavailable' });
      return { success: false, error: 'Settings could not be encrypted on this system' };
    }
    const storedSettings = store.get('settings', null);
    const settingsRecord = (storedSettings && typeof storedSettings === 'object' && !Array.isArray(storedSettings))
      ? { ...storedSettings }
      : {};
    if (plannedApiKey.action !== 'keep') delete settingsRecord.apiKey;
    if (plannedTaskKey.action !== 'keep') delete settingsRecord.taskKey;
    settingsRecord.proxyUrl = proxySealed;
    persistProviderCredentials(store, activeProviderId, {
      apiKey: plannedApiKey.next,
      taskKey: plannedTaskKey.next
    });
    store.set('settings', settingsRecord);
    const memoryCredentials = {};
    if (plannedApiKey.action === 'set') memoryCredentials.apiKey = plannedApiKey.plaintext;
    else if (plannedApiKey.action === 'clear') memoryCredentials.apiKey = '';
    if (plannedTaskKey.action === 'set') memoryCredentials.taskKey = plannedTaskKey.plaintext;
    else if (plannedTaskKey.action === 'clear') memoryCredentials.taskKey = '';
    if (Object.keys(memoryCredentials).length > 0) {
      providerManager.setCredentials(activeProviderId, memoryCredentials);
    }
    logger.info('settings', 'settings saved', {
      hasApiKey: !!nextSettings.apiKey,
      hasTaskKey: !!nextSettings.taskKey,
      hasProxy: !!nextSettings.proxyUrl
    });
    const proxyResult = await applyProxyConfiguration(nextSettings.proxyUrl);
    return { success: true, proxyApplied: proxyResult.applied };
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
    const storedApiKey = credentials && typeof credentials.apiKey === 'string' ? credentials.apiKey : '';
    const storedTaskKey = credentials && typeof credentials.taskKey === 'string' ? credentials.taskKey : '';
    const legacyApiKey = typeof base.apiKey === 'string' ? base.apiKey : '';
    const legacyTaskKey = typeof base.taskKey === 'string' ? base.taskKey : '';
    const hasApiKey = canRevealCredential(storedApiKey) || canRevealCredential(legacyApiKey);
    const hasTaskKey = canRevealCredential(storedTaskKey) || canRevealCredential(legacyTaskKey);
    let proxyUrl = '';
    try {
      proxyUrl = credentialVault.reveal(typeof base.proxyUrl === 'string' ? base.proxyUrl : '');
    } catch {
      logger.warn('proxy', 'stored proxy could not be decrypted');
    }
    return { hasApiKey, hasTaskKey, proxyUrl };
  });

  // 采集结果管理
  ipcMain.handle('collector:get-numbers', (_, query) => {
    try {
      return accountStore.queryNumbers(validateNumbersQuery(query));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:get-numbers', err.message);
      throw err;
    }
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

  ipcMain.handle('collector:storage-status', () => {
    return accountStore.getStorageStatus();
  });

  // B5: read-only access to the local collection-job ledger for the
  // dashboard. Same validated paging contract as the other list reads;
  // returns the accountStore.queryJobs envelope unchanged.
  ipcMain.handle('collector:get-jobs', (_, query) => {
    try {
      return accountStore.queryJobs(validateHistoryPaging(query));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:get-jobs', err.message);
      throw err;
    }
  });

  // B6.2: the single write path for the user-owned lead fields. Validation is
  // authoritative here; the store re-checks defensively. Responses follow the
  // B4 job-state precedent ({success, updated} plus a reason when nothing was
  // written). Nothing in this handler logs tags or notes content.
  ipcMain.handle('collector:update-lead', (_, payload) => {
    try {
      return accountStore.setLeadUserFields(validateLeadUpdatePayload(payload));
    } catch (err) {
      if (err.invalidParams) rejectLog('collector:update-lead', err.message);
      throw err;
    }
  });

  ipcMain.handle('logs:export', () => {
    return logger.exportLogs();
  });

  ipcMain.handle('logs:dir', () => {
    return logger.getLogDir();
  });

  ipcMain.handle('logs:report', (_, payload) => {
    try {
      if (!payload || typeof payload !== 'object') return { success: false };
      const message = typeof payload.message === 'string' ? payload.message.slice(0, 500) : 'Unknown renderer error';
      const context = payload.context && typeof payload.context === 'object' ? payload.context : {};
      const sanitized = {};
      for (const [k, v] of Object.entries(context)) {
        if (typeof v === 'string' && v.length > 200) sanitized[k] = v.slice(0, 200) + '...';
        else sanitized[k] = v;
      }
      logger.error('renderer', message, sanitized);
      return { success: true };
    } catch {
      return { success: false };
    }
  });

  ipcMain.handle('proxy:detect', async () => {
    const { autoDetectProxy } = require('./src/main/proxyDetector');
    const result = await autoDetectProxy();
    return result || { source: null, proxyUrl: null };
  });

}

app.whenReady().then(() => {
    if (!gotTheLock) return;
    logger.info('app', 'application started', { version: app.getVersion(), isDev });
    createMainWindow();
    initServices();
    registerIpcHandlers();
    let storedProxyUrl = '';
    try {
      const Store = require('electron-store');
      const stored = new Store().get('settings', {});
      const rawProxyUrl = (stored && typeof stored.proxyUrl === 'string') ? stored.proxyUrl : '';
      if (rawProxyUrl) {
        storedProxyUrl = credentialVault.reveal(rawProxyUrl);
      }
    } catch {
      storedProxyUrl = '';
      logger.warn('proxy', 'stored proxy could not be decrypted');
    }
    applyProxyConfiguration(storedProxyUrl);
  }).catch((err) => {
    try {
      logger.error('app', 'whenReady failed', { error: err.message, stack: err.stack });
    } catch {}
  });

app.on('window-all-closed', () => {
  app.quit();
});
