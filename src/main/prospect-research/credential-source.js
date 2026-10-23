'use strict';

// A3 - per-user Zuni-SEO API key storage for the Electron MAIN process.
//
// Reuses ZTech's existing secrets service (src/main/credentialVault.js, safeStorage +
// the enc:v1: sealed format). It is NOT a second secrets system.
//
// credentialVault.js is deliberately NOT modified: its isAvailable(), seal(),
// migrateStoredCredentials() and provider apiKey/taskKey handling behave exactly as
// they do today. The Linux `basic_text` refusal lives HERE and applies only to the
// Zuni-SEO key, because that refusal is a product decision about a key ZTech stores
// on the user's behalf, not a change to how existing provider credentials behave.
//
// Rules
// - One key per ZTech user, entered by that user in Settings. Never shipped in the app.
// - The key is never returned to the renderer, never logged, never passed anywhere
//   except the Zuni-SEO transport's Authorization header.
// - Plain HTTP / `basic_text` storage is refused rather than pretended to be safe.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const credentialVault = require('../credentialVault');

const KEY_FORMAT = /^zsk_[A-Za-z0-9_-]{20,200}$/;
const KEY_FILE = 'zuni-seo.key';
const KEY_FILE_MODE = 0o600;

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

/** Zuni-SEO-key-only guard. Never applied to existing provider credentials. */
function assertSecureBackend() {
  const safeStorage = resolveSafeStorage();
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== 'function') {
    throw new Error('The operating system credential store is not available; the key was not saved.');
  }
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable() === true;
  } catch {
    available = false;
  }
  if (!available) {
    throw new Error('The operating system credential store is not available; the key was not saved.');
  }
  let backend = null;
  try {
    backend = typeof safeStorage.getSelectedStorageBackend === 'function'
      ? safeStorage.getSelectedStorageBackend()
      : null;
  } catch {
    backend = null;
  }
  if (backend === 'basic_text') {
    throw new Error('No system keyring is available (basic_text). Install or unlock a keyring to store the key.');
  }
  return true;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {{ secretsDir: string, maxKeyLength?: number }} options
 *   secretsDir: absolute path, e.g. path.join(app.getPath('userData'), 'secrets')
 */
class ZuniSeoCredentialSource {
  constructor(options) {
    const opts = isPlainObject(options) ? options : {};
    if (typeof opts.secretsDir !== 'string' || opts.secretsDir === '') {
      throw new Error('prospect-research: secretsDir is required');
    }
    this.secretsDir = opts.secretsDir;
    this.filePath = path.join(this.secretsDir, KEY_FILE);
    this.cache = undefined;
  }

  /** CredentialSource: called by the transport for every Zuni-SEO request. */
  async getApiKey() {
    if (this.cache !== undefined) return this.cache;
    let stored = null;
    try {
      stored = fs.readFileSync(this.filePath, 'utf8');
    } catch {
      stored = null;
    }
    if (typeof stored !== 'string' || stored === '') {
      this.cache = null;
      return this.cache;
    }
    try {
      const revealed = credentialVault.reveal(stored);
      this.cache = typeof revealed === 'string' && revealed !== '' ? revealed : null;
    } catch {
      this.cache = null;
    }
    return this.cache;
  }

  /** ZuniSeoKeyWriter. */
  async setApiKey(key) {
    if (typeof key !== 'string') throw new Error('That does not look like a Zuni-SEO API key (zsk_...).');
    const trimmed = key.trim();
    if (!KEY_FORMAT.test(trimmed)) throw new Error('That does not look like a Zuni-SEO API key (zsk_...).');
    assertSecureBackend();
    // seal() already refuses when encryption is unavailable, and verifies format.
    const sealed = credentialVault.seal(trimmed);
    if (credentialVault.reveal(sealed) !== trimmed) {
      throw new Error('The stored Zuni-SEO key could not be verified; it was not saved.');
    }
    fs.mkdirSync(this.secretsDir, { recursive: true });
    const tmpPath = `${this.filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(tmpPath, sealed, { encoding: 'utf8', mode: KEY_FILE_MODE });
      fs.renameSync(tmpPath, this.filePath);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`The Zuni-SEO key could not be saved: ${err.message}`);
    }
    this.cache = trimmed;
  }

  /** ZuniSeoKeyWriter. */
  async clearApiKey() {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // A key that cannot be removed must not leave a usable cache behind.
    }
    this.cache = null;
  }

  /** ZuniSeoKeyWriter. Drives only a boolean; never the key itself. */
  async hasApiKey() {
    return (await this.getApiKey()) !== null;
  }
}

module.exports = {
  KEY_FILE,
  KEY_FORMAT,
  ZuniSeoCredentialSource,
  assertSecureBackend,
  setSafeStorageForTests
};
