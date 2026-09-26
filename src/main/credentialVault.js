'use strict';

const SEALED_PREFIX = 'enc:v1:';
const CREDENTIAL_FIELDS = ['apiKey', 'taskKey'];

let injectedSafeStorage;

function setSafeStorageForTests(stub) {
  injectedSafeStorage = stub;
}

function resolveSafeStorage() {
  if (injectedSafeStorage !== undefined) return injectedSafeStorage;
  try {
    const electron = require('electron');
    return electron && electron.safeStorage ? electron.safeStorage : null;
  } catch {
    return null;
  }
}

function isAvailable() {
  const safeStorage = resolveSafeStorage();
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') return false;
  try {
    return safeStorage.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

function isSealed(value) {
  return typeof value === 'string' && value.startsWith(SEALED_PREFIX);
}

function seal(plaintext) {
  if (typeof plaintext !== 'string') {
    throw new Error('vault: plaintext must be a string');
  }
  if (!isAvailable()) {
    throw new Error('vault: encryption unavailable');
  }
  const safeStorage = resolveSafeStorage();
  let buffer;
  try {
    buffer = safeStorage.encryptString(plaintext);
  } catch {
    throw new Error('vault: encryption failed');
  }
  if (!buffer || typeof buffer.toString !== 'function') {
    throw new Error('vault: encryption produced no output');
  }
  return SEALED_PREFIX + buffer.toString('base64');
}

function unseal(value) {
  if (typeof value !== 'string') {
    throw new Error('vault: sealed value must be a string');
  }
  if (!isSealed(value)) {
    throw new Error('vault: value is not sealed');
  }
  const payload = value.slice(SEALED_PREFIX.length);
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    throw new Error('vault: sealed payload is malformed');
  }
  if (!isAvailable()) {
    throw new Error('vault: encryption unavailable');
  }
  const safeStorage = resolveSafeStorage();
  let plaintext;
  try {
    plaintext = safeStorage.decryptString(Buffer.from(payload, 'base64'));
  } catch {
    throw new Error('vault: decryption failed');
  }
  if (typeof plaintext !== 'string') {
    throw new Error('vault: decryption produced no output');
  }
  return plaintext;
}

function reveal(value) {
  if (typeof value !== 'string' || value === '') return '';
  if (isSealed(value)) return unseal(value);
  return value;
}

function isPresent(value) {
  if (typeof value !== 'string' || value === '') return false;
  if (isSealed(value)) {
    try {
      return unseal(value).length > 0;
    } catch {
      return true;
    }
  }
  return true;
}

function planCredentialUpdate(currentValue, input) {
  const options = (input && typeof input === 'object') ? input : {};
  if (options.clear === true) {
    return { action: 'clear', next: '' };
  }
  const value = options.value;
  if (typeof value === 'string' && value.length > 0) {
    return { action: 'set', next: seal(value), plaintext: value };
  }
  return { action: 'keep', next: currentValue };
}

function migrateStoredCredentials(store, providerId) {
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    return { status: 'failed', reason: 'invalid-store', sealed: 0, removed: 0 };
  }
  if (!isAvailable()) {
    return { status: 'deferred', reason: 'encryption-unavailable', sealed: 0, removed: 0 };
  }
  try {
    const providersRaw = store.get('providers', null);
    const providers = (providersRaw && typeof providersRaw === 'object' && !Array.isArray(providersRaw))
      ? providersRaw
      : {};
    const settingsRaw = store.get('settings', null);
    const settings = (settingsRaw && typeof settingsRaw === 'object' && !Array.isArray(settingsRaw))
      ? settingsRaw
      : {};

    let providersSealed = 0;
    let proxySealed = 0;
    let removed = 0;

    const nextProviders = {};
    for (const pid of Object.keys(providers)) {
      const record = providers[pid];
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        nextProviders[pid] = record;
        continue;
      }
      const credentials = (record.credentials && typeof record.credentials === 'object' && !Array.isArray(record.credentials))
        ? record.credentials
        : null;
      if (!credentials) {
        nextProviders[pid] = record;
        continue;
      }
      const nextCredentials = { ...credentials };
      for (const field of CREDENTIAL_FIELDS) {
        const value = nextCredentials[field];
        if (typeof value !== 'string' || value === '' || isSealed(value)) continue;
        const candidate = seal(value);
        if (unseal(candidate) !== value) {
          return { status: 'failed', reason: 'seal-verification-failed', sealed: 0, removed: 0 };
        }
        nextCredentials[field] = candidate;
        providersSealed += 1;
      }
      nextProviders[pid] = { ...record, credentials: nextCredentials };
    }

    const nextSettings = { ...settings };
    for (const field of CREDENTIAL_FIELDS) {
      const legacyValue = settings[field];
      if (typeof legacyValue !== 'string' || legacyValue === '' || isSealed(legacyValue)) continue;
      const targetRecord = (typeof providerId === 'string' && providerId) ? nextProviders[providerId] : undefined;
      const targetCredentials = (targetRecord && targetRecord.credentials && typeof targetRecord.credentials === 'object')
        ? targetRecord.credentials
        : null;
      if (!targetCredentials) continue;
      let counterpart = targetCredentials[field];
      if (typeof counterpart !== 'string' || counterpart === '') {
        const candidate = seal(legacyValue);
        if (unseal(candidate) !== legacyValue) {
          return { status: 'failed', reason: 'seal-verification-failed', sealed: 0, removed: 0 };
        }
        targetCredentials[field] = candidate;
        providersSealed += 1;
        counterpart = candidate;
      }
      let matches = false;
      if (isSealed(counterpart)) {
        try {
          matches = unseal(counterpart) === legacyValue;
        } catch {
          matches = false;
        }
      } else {
        matches = counterpart === legacyValue;
      }
      if (matches) {
        delete nextSettings[field];
        removed += 1;
      }
    }

    const proxyValue = settings.proxyUrl;
    if (typeof proxyValue === 'string' && proxyValue !== '' && !isSealed(proxyValue)) {
      const candidate = seal(proxyValue);
      if (unseal(candidate) !== proxyValue) {
        return { status: 'failed', reason: 'seal-verification-failed', sealed: 0, removed: 0 };
      }
      nextSettings.proxyUrl = candidate;
      proxySealed += 1;
    }

    if (providersSealed > 0) store.set('providers', nextProviders);
    if (removed > 0 || proxySealed > 0) store.set('settings', nextSettings);

    return { status: 'complete', sealed: providersSealed + proxySealed, removed };
  } catch (err) {
    return {
      status: 'failed',
      reason: (err && err.message) ? err.message : 'write-failed',
      sealed: 0,
      removed: 0
    };
  }
}

module.exports = {
  SEALED_PREFIX,
  setSafeStorageForTests,
  isAvailable,
  isSealed,
  seal,
  unseal,
  reveal,
  isPresent,
  planCredentialUpdate,
  migrateStoredCredentials
};
