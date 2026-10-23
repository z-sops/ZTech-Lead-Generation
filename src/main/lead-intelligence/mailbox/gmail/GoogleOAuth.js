'use strict';

/**
 * F26.6 Google OAuth for a connected Gmail / Google Workspace mailbox. MAIN PROCESS ONLY.
 *
 * Installed-app flow as Google documents it for desktop apps: the system browser, a loopback
 * redirect on 127.0.0.1 (custom URI schemes and the OOB flow are deprecated), PKCE (S256) and a
 * `state` check. Under D1 the client is the customer's own "Desktop app" client; Google states a
 * desktop client secret is not treated as confidential, but ZTech still keeps it in main only.
 *
 * Nothing here is ever returned to the renderer or logged: not the auth code, the PKCE verifier,
 * the access token, the refresh token or the client secret. Callers receive the refresh token in
 * main and hand it straight to the token store.
 *
 * Scopes are the narrowest that Step 1A is verifying: gmail.send (send only) and gmail.metadata
 * (headers and labels, never bodies). A grant missing either is refused.
 */

const http = require('http');
const crypto = require('crypto');

const GOOGLE = Object.freeze({
  AUTH_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  TOKEN_URL: 'https://oauth2.googleapis.com/token',
  REVOKE_URL: 'https://oauth2.googleapis.com/revoke',
  GMAIL_API: 'https://gmail.googleapis.com/gmail/v1/users/me',
});
const GMAIL_SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.metadata',
]);
const CLIENT_ID_RE = /^[A-Za-z0-9._-]{8,200}\.apps\.googleusercontent\.com$/;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

class MailboxAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'MailboxAuthError'; this.code = code; }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const LANDING = '<!doctype html><meta charset="utf-8"><title>ZTech</title><p style="font-family:sans-serif">ZTech received the Google sign-in. You can close this tab and return to ZTech.</p>';

class GoogleOAuth {
  /**
   * @param {{fetch?: Function, openExternal: (url: string) => Promise<void>|void,
   *          createServer?: Function, randomBytes?: Function, timeoutMs?: number}} deps
   */
  constructor({ fetch: fetchImpl = globalThis.fetch, openExternal, createServer = http.createServer, randomBytes = crypto.randomBytes, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof openExternal !== 'function') throw new TypeError('GoogleOAuth needs openExternal');
    this.fetch = fetchImpl;
    this.openExternal = openExternal;
    this.createServer = createServer;
    this.randomBytes = randomBytes;
    this.timeoutMs = timeoutMs;
  }

  static validClientId(id) { return typeof id === 'string' && CLIENT_ID_RE.test(id); }

  /** Build the consent URL (pure; exported for tests). */
  static authUrl({ clientId, redirectUri, challenge, state, loginHint = null }) {
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GMAIL_SCOPES.join(' '),
      code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
    });
    if (loginHint) q.set('login_hint', loginHint);
    return `${GOOGLE.AUTH_URL}?${q}`;
  }

  /**
   * Run the browser consent once. Resolves { refreshToken, accessToken } (main-only values).
   * Exactly one loopback request is honoured; the listener closes on success, refusal or timeout.
   */
  async authorize({ clientId, clientSecret }) {
    if (!GoogleOAuth.validClientId(clientId)) throw new MailboxAuthError('MAILBOX_CLIENT_NOT_CONFIGURED', 'Add your Google OAuth client ID in Settings > Mailboxes first.');
    if (typeof clientSecret !== 'string' || !clientSecret) throw new MailboxAuthError('MAILBOX_CLIENT_NOT_CONFIGURED', 'Add your Google OAuth client secret in Settings > Mailboxes first.');
    const verifier = b64url(this.randomBytes(48));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(this.randomBytes(24));
    const server = this.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const redirectUri = `http://127.0.0.1:${server.address().port}`;
    let timer = null;
    try {
      const code = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new MailboxAuthError('MAILBOX_AUTH_TIMEOUT', 'The Google sign-in was not finished in time. Try Connect again.')), this.timeoutMs);
        let settled = false;
        server.on('request', (req, res) => {
          const q = new URL(req.url, redirectUri).searchParams;
          if (settled || (!q.has('code') && !q.has('error'))) { res.writeHead(404); res.end(); return; } // favicon etc.
          // A request without OUR state is ignored, not fatal: a local process probing the port
          // cannot cancel (or complete) the sign-in. The timeout still bounds the wait.
          if (q.get('state') !== state) { res.writeHead(400); res.end(); return; }
          settled = true;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(LANDING);
          if (q.get('error')) return reject(new MailboxAuthError('MAILBOX_AUTH_REFUSED', 'Google sign-in was cancelled or refused.'));
          return resolve(q.get('code'));
        });
        Promise.resolve(this.openExternal(GoogleOAuth.authUrl({ clientId, redirectUri, challenge, state }))).catch(() => {
          reject(new MailboxAuthError('MAILBOX_AUTH_FAILED', 'The browser could not be opened for Google sign-in.'));
        });
      });
      const tokens = await this._token({
        client_id: clientId, client_secret: clientSecret, code, code_verifier: verifier, grant_type: 'authorization_code', redirect_uri: redirectUri,
      });
      const granted = new Set(String(tokens.scope || '').split(/\s+/).filter(Boolean));
      if (!GMAIL_SCOPES.every((s) => granted.has(s))) {
        await this.revoke(tokens.refresh_token || tokens.access_token);
        throw new MailboxAuthError('MAILBOX_SCOPE_MISSING', 'Both requested Gmail permissions (send, and read message headers) are needed. Nothing was connected.');
      }
      if (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token) {
        await this.revoke(tokens.access_token);
        throw new MailboxAuthError('MAILBOX_AUTH_FAILED', 'Google did not issue a lasting sign-in. Try Connect again.');
      }
      return { refreshToken: tokens.refresh_token, accessToken: tokens.access_token };
    } finally {
      clearTimeout(timer);
      server.close();
    }
  }

  /** A fresh access token from a refresh token (main-only value). */
  async accessToken({ clientId, clientSecret, refreshToken }) {
    const t = await this._token({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' });
    if (typeof t.access_token !== 'string' || !t.access_token) throw new MailboxAuthError('MAILBOX_RECONNECT_NEEDED', 'This mailbox needs to be reconnected.');
    return t.access_token;
  }

  /** Best-effort revoke. Never throws; the caller removes the local token regardless. */
  async revoke(token) {
    if (typeof token !== 'string' || !token) return false;
    try {
      const res = await this.fetch(GOOGLE.REVOKE_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }).toString() });
      return Boolean(res && res.ok);
    } catch { return false; }
  }

  async _token(form) {
    let res;
    try {
      res = await this.fetch(GOOGLE.TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form).toString() });
    } catch {
      throw new MailboxAuthError('MAILBOX_NETWORK', 'Google could not be reached.');
    }
    let json = {};
    try { json = await res.json(); } catch { json = {}; }
    if (!res.ok) {
      // invalid_grant = revoked or expired refresh token: the user must reconnect. No remote text is surfaced.
      if (json && json.error === 'invalid_grant') throw new MailboxAuthError('MAILBOX_RECONNECT_NEEDED', 'This mailbox needs to be reconnected.');
      throw new MailboxAuthError('MAILBOX_AUTH_FAILED', 'Google refused the sign-in.');
    }
    return json || {};
  }
}

/**
 * The minimal Gmail read used at connect time: users.getProfile, allowed under gmail.metadata.
 * Returns { emailAddress, historyId } only (historyId = the reply-sync starting cursor).
 */
async function gmailProfile(fetchImpl, accessToken) {
  let res;
  try {
    res = await fetchImpl(`${GOOGLE.GMAIL_API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  } catch {
    throw new MailboxAuthError('MAILBOX_NETWORK', 'Gmail could not be reached.');
  }
  if (!res.ok) throw new MailboxAuthError('MAILBOX_AUTH_FAILED', 'Gmail did not return the mailbox address.');
  const json = await res.json().catch(() => ({}));
  if (!json || typeof json.emailAddress !== 'string') throw new MailboxAuthError('MAILBOX_AUTH_FAILED', 'Gmail did not return the mailbox address.');
  return { emailAddress: json.emailAddress, historyId: json.historyId != null && /^\d{1,30}$/.test(String(json.historyId)) ? String(json.historyId) : null };
}

module.exports = { GoogleOAuth, gmailProfile, MailboxAuthError, GOOGLE, GMAIL_SCOPES };
