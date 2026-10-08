'use strict';

/**
 * F26.6 main-only persistence for connected mailboxes, moved out of main.js (acceptance fix,
 * 8 Oct 2026) so it can be tested. Sealed values only; nothing here is ever returned to the
 * renderer or logged.
 *   mailboxTokens.<mailbox_id>   sealed refresh token
 *   mailboxOAuth.google          { clientId, clientSecret (sealed) }   - D1, the customer's own client
 *
 * The bug it fixes: main.js built these on `new Store()` while `Store` was only declared inside
 * initServices, so every save / read threw a ReferenceError that reached the renderer as
 * "Internal error" and the client was never stored. Here the store comes from one injected
 * factory, and every failure becomes a ZTech error with a reason a person can act on (never the
 * secret, never a stack).
 */

const { LiError } = require('../core/errors');

const VAULT_REASONS = new Set([
  'vault: plaintext must be a string',
  'vault: encryption failed',
  'vault: encryption produced no output',
]);

/** A vault / store failure -> a stable code and a plain reason. The secret is never part of it. */
function persistenceError(err, what) {
  const msg = err && typeof err.message === 'string' ? err.message : '';
  if (/^vault: encryption unavailable/.test(msg)) {
    return new LiError('MAILBOX_VAULT_UNAVAILABLE', `Windows secure storage is not available, so the ${what} was not saved. Nothing was stored.`);
  }
  if (/^vault: /.test(msg)) {
    // Only known, fixed vault reasons are shown; anything else is not echoed.
    const reason = VAULT_REASONS.has(msg) ? msg.slice(7) : 'unexpected vault error';
    return new LiError('MAILBOX_VAULT_FAILED', `The ${what} could not be encrypted (${reason}). Nothing was stored.`);
  }
  return new LiError('MAILBOX_SETTINGS_WRITE_FAILED', `The ${what} could not be written to ZTech's settings file. Nothing was stored.`);
}

/**
 * @param {{storeFactory: () => {get: Function, set: Function}, vault: {seal: Function, reveal: Function, isAvailable: Function}, openExternal: (url: string) => any}} deps
 */
function createMailboxPersistence({ storeFactory, vault, openExternal }) {
  if (typeof storeFactory !== 'function') throw new TypeError('storeFactory is required');
  if (!vault || typeof vault.seal !== 'function' || typeof vault.reveal !== 'function') throw new TypeError('vault is required');
  const store = () => storeFactory();
  const tokens = () => store().get('mailboxTokens', {}) || {};
  const readClient = () => {
    const g = (store().get('mailboxOAuth', {}) || {}).google;
    if (!g || typeof g.clientId !== 'string' || typeof g.clientSecret !== 'string') return null;
    return { clientId: g.clientId, clientSecret: vault.reveal(g.clientSecret) };
  };
  return {
    tokenStore: {
      available: () => { try { return vault.isAvailable() === true; } catch { return false; } },
      get: (id) => {
        const sealed = tokens()[id];
        return typeof sealed === 'string' && sealed ? vault.reveal(sealed) : null;
      },
      set: (id, refreshToken) => {
        let sealed;
        try { sealed = vault.seal(String(refreshToken)); } catch (e) { throw persistenceError(e, 'mailbox sign-in'); }
        try {
          const s = store();
          s.set('mailboxTokens', { ...(s.get('mailboxTokens', {}) || {}), [id]: sealed });
        } catch (e) { throw persistenceError(e, 'mailbox sign-in'); }
      },
      remove: (id) => {
        const s = store();
        const all = { ...(s.get('mailboxTokens', {}) || {}) };
        delete all[id];
        s.set('mailboxTokens', all);
      },
    },
    clientConfig: {
      /** The stored client, or null when there is none or it cannot be read on this computer. */
      get: () => { try { return readClient(); } catch { return null; } },
      set: ({ clientId, clientSecret }) => {
        // Seal first: if encryption fails, nothing at all is written.
        let sealed;
        try { sealed = vault.seal(clientSecret); } catch (e) { throw persistenceError(e, 'Google client secret'); }
        let prev;
        try {
          const s = store();
          const cur = s.get('mailboxOAuth', {}) || {};
          prev = cur.google;
          s.set('mailboxOAuth', { ...cur, google: { clientId, clientSecret: sealed } });
        } catch (e) { throw persistenceError(e, 'Google client'); }
        // Read it back the way Connect will: a value that cannot be revealed is not "Saved".
        let back = null;
        try { back = readClient(); } catch { back = null; }
        if (!back || back.clientId !== clientId || back.clientSecret !== clientSecret) {
          // Roll back to exactly what was there before (a previously working client is kept).
          try {
            const s = store();
            const next = { ...(s.get('mailboxOAuth', {}) || {}) };
            if (prev === undefined) delete next.google; else next.google = prev;
            s.set('mailboxOAuth', next);
          } catch { /* an unreadable client reads as null, so the status is never a false "Set" */ }
          throw new LiError('MAILBOX_CLIENT_NOT_SAVED', 'The Google client was written but could not be read back on this computer, so it is not saved. Any earlier client is unchanged. Try again.');
        }
      },
      clear: () => {
        const s = store();
        const next = { ...(s.get('mailboxOAuth', {}) || {}) };
        delete next.google;
        s.set('mailboxOAuth', next);
      },
    },
    openBrowser: (url) => {
      if (typeof url !== 'string' || !url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')) throw new Error('only the Google consent URL can be opened');
      return openExternal(url);
    },
  };
}

module.exports = { createMailboxPersistence, persistenceError };
