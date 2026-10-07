'use strict';

/**
 * F26.6 MailboxService - connected mailboxes, their pacing, and the market rules. MAIN ONLY.
 *
 * Everything it returns to a caller that may reach the renderer is SANITIZED (sanitizeMailbox):
 * mailbox_id, provider, address, display name, connection status, pacing status. Refresh tokens
 * live in the injected tokenStore (sealed by the credential vault in main.js); the Google client
 * secret lives in the injected clientConfig. Neither is ever returned, logged or put in an error.
 *
 * Capability is decided by verification (PROVIDER_CAPABILITY), never by configuration:
 *   - Gmail: may connect; may not send or sync until Step 1A passes, and a mailbox is Ready only
 *     after its own Check mailbox passes.
 *   - Microsoft 365: identity only (MAILBOX_PROVIDER_UNVERIFIED) - no connect, send or sync.
 *
 * Nothing here queues, schedules or retries. Pacing answers "may this mailbox send ONE message
 * now?" for one human click.
 */

const crypto = require('crypto');
const { LiError, ValidationError } = require('../core/errors');
const {
  MAILBOX_PROVIDERS, PROVIDER_CAPABILITY, PROVIDER_LABEL, PROVIDER_NOTICE, MAILBOX_DEFAULTS, MAILBOX_ID_RE,
  isTimeZone, sanitizeMailbox, normalizeLimits, MARKET_RULES,
} = require('./mailboxContract');
const { evaluatePacing, pacingMessage, PACING_CODE } = require('./pacing');
const { GoogleOAuth, gmailProfile, MailboxAuthError } = require('./gmail/GoogleOAuth');

const DAY_MS = 24 * 3600 * 1000;
const LIMIT_KEYS = Object.freeze({
  dailyCap: 'daily_cap', hourlyCap: 'hourly_cap', minGapSeconds: 'min_gap_seconds',
  windowStart: 'window_start', windowEnd: 'window_end', windowDays: 'window_days', timeZone: 'time_zone',
});

function localTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isTimeZone(tz) ? tz : 'UTC';
  } catch { return 'UTC'; }
}

/** Errors that may cross IPC: our own code and our own text, never remote text. */
function mailboxError(err) {
  if (err instanceof MailboxAuthError) return new LiError(err.code, err.message);
  return err;
}

class MailboxService {
  /**
   * @param {{store: object, clock?: () => Date, tokenStore: {get, set, remove},
   *          clientConfig: {get: () => ({clientId, clientSecret}|null), set: Function, clear: Function},
   *          googleOAuth?: GoogleOAuth, fetch?: Function, operator?: string,
   *          defaultTimeZone?: string, newId?: () => string, logger?: object}} deps
   */
  constructor({ store, clock = () => new Date(), tokenStore, clientConfig, googleOAuth = null, fetch: fetchImpl = globalThis.fetch,
    operator = 'local-user', defaultTimeZone = localTimeZone(), newId = () => 'mbx_' + crypto.randomBytes(12).toString('hex'), logger = null } = {}) {
    if (!store || !store.mailboxes || !store.marketRules || !store.sends) throw new TypeError('MailboxService needs a store with the F26.6 repositories');
    if (!tokenStore || typeof tokenStore.set !== 'function' || typeof tokenStore.remove !== 'function') throw new TypeError('MailboxService needs a tokenStore');
    if (!clientConfig || typeof clientConfig.get !== 'function') throw new TypeError('MailboxService needs a clientConfig');
    this.store = store;
    this.clock = clock;
    this.tokenStore = tokenStore;
    this.clientConfig = clientConfig;
    this.googleOAuth = googleOAuth;
    this.fetch = fetchImpl;
    this.operator = typeof operator === 'string' && operator.trim() ? operator.trim().slice(0, 80) : 'local-user';
    this.defaultTimeZone = isTimeZone(defaultTimeZone) ? defaultTimeZone : 'UTC';
    this.newId = newId;
    this.logger = logger;
    this._connecting = null;
  }

  _now() { return this.clock(); }

  /* --------------------------------- providers --------------------------------- */

  /** What each provider can do in this build, and why. No secret, no client secret. */
  providers() {
    const client = this._client();
    return MAILBOX_PROVIDERS.map((p) => ({
      provider: p,
      label: PROVIDER_LABEL[p],
      notice: PROVIDER_NOTICE[p],
      code: PROVIDER_CAPABILITY[p].code,
      canConnect: PROVIDER_CAPABILITY[p].canConnect,
      canSend: PROVIDER_CAPABILITY[p].canSend,
      canSyncReplies: PROVIDER_CAPABILITY[p].canSyncReplies,
      unsubscribeHeaderSupport: PROVIDER_CAPABILITY[p].unsubscribeHeaderSupport,
      // Gmail uses the customer's own Google client (D1). The client ID is not a secret and is
      // shown so the user can tell which client is in use; the secret never leaves main.
      ...(p === 'gmail' ? { clientConfigured: Boolean(client), clientId: client ? client.clientId : null } : {}),
    }));
  }

  _client() {
    const c = this.clientConfig.get();
    return c && GoogleOAuth.validClientId(c.clientId) && typeof c.clientSecret === 'string' && c.clientSecret ? c : null;
  }

  /** Save the customer's Google Desktop-app client (D1). Write-only: nothing is echoed back. */
  async setGoogleClient({ clientId, clientSecret } = {}) {
    const id = typeof clientId === 'string' ? clientId.trim() : '';
    const secret = typeof clientSecret === 'string' ? clientSecret.trim() : '';
    if (!GoogleOAuth.validClientId(id)) throw new ValidationError('Invalid Google client', [{ path: '$.clientId', message: 'must be a Google OAuth client ID ending in .apps.googleusercontent.com' }]);
    if (!secret || secret.length > 200 || /\s/.test(secret)) throw new ValidationError('Invalid Google client', [{ path: '$.clientSecret', message: 'must be the client secret of that Desktop-app client' }]);
    await this.clientConfig.set({ clientId: id, clientSecret: secret });
    return { clientConfigured: true, clientId: id };
  }

  async clearGoogleClient() {
    await this.clientConfig.clear();
    return { clientConfigured: false, clientId: null };
  }

  /* --------------------------------- mailboxes --------------------------------- */

  async _rowOrThrow(mailboxId) {
    if (typeof mailboxId !== 'string' || !MAILBOX_ID_RE.test(mailboxId)) throw new ValidationError('Invalid mailbox', [{ path: '$.mailboxId', message: 'is not a mailbox id' }]);
    const row = await this.store.mailboxes.get(mailboxId);
    if (!row) throw new LiError('MAILBOX_NOT_FOUND', 'That mailbox is not connected.');
    return row;
  }

  async _pacingFor(row) {
    const now = this._now();
    const since = new Date(now.getTime() - DAY_MS).toISOString();
    const sendTimes = await this.store.sends.mailboxSendTimes(row.mailbox_id, since);
    return evaluatePacing({ mailbox: row, sendTimes, now });
  }

  async list() {
    const rows = await this.store.mailboxes.list();
    const out = [];
    for (const r of rows) out.push(sanitizeMailbox(r, await this._pacingFor(r)));
    return out;
  }

  async get(mailboxId) {
    const row = await this._rowOrThrow(mailboxId);
    return sanitizeMailbox(row, await this._pacingFor(row));
  }

  /**
   * The send-side gate for one mailbox and one click, in order: provider capability -> mailbox
   * status -> pacing. Returns { allowed: true, mailbox } or { allowed: false, code, message,
   * nextAllowedAt? }. Read-only; sends nothing.
   */
  async sendGate(mailboxId) {
    const row = await this._rowOrThrow(mailboxId);
    const cap = PROVIDER_CAPABILITY[row.provider];
    if (!cap || !cap.canSend) return { allowed: false, code: cap ? cap.code : 'MAILBOX_PROVIDER_UNVERIFIED', message: PROVIDER_NOTICE[row.provider] || 'This mailbox provider cannot send yet.' };
    if (row.status !== 'ready') return { allowed: false, code: 'MAILBOX_NOT_READY', message: 'Run "Check mailbox" for this mailbox before sending from it.' };
    const pacing = await this._pacingFor(row);
    if (!pacing.allowed) return { allowed: false, code: PACING_CODE, message: pacingMessage(pacing), nextAllowedAt: pacing.nextAllowedAt, reason: pacing.reason };
    return { allowed: true, mailbox: sanitizeMailbox(row, pacing) };
  }

  /**
   * Connect a mailbox with ONE browser consent. Gmail only in this build. The new mailbox is
   * 'needs_check': it cannot send until its own Check mailbox passes (and Step 1A has passed).
   */
  async connect({ provider } = {}) {
    if (!MAILBOX_PROVIDERS.includes(provider)) throw new ValidationError('Invalid provider', [{ path: '$.provider', message: 'must be gmail or microsoft365' }]);
    const cap = PROVIDER_CAPABILITY[provider];
    if (!cap.canConnect) throw new LiError(cap.code, PROVIDER_NOTICE[provider]);
    if (this._connecting) throw new LiError('MAILBOX_CONNECT_IN_PROGRESS', 'A mailbox sign-in is already open in your browser.');
    this._connecting = this._connectGmail().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _connectGmail() {
    const client = this._client();
    if (!client) throw new LiError('MAILBOX_CLIENT_NOT_CONFIGURED', 'Add your Google OAuth client ID and secret in Settings > Mailboxes first.');
    if (!this.googleOAuth) throw new LiError('MAILBOX_UNAVAILABLE', 'Mailbox sign-in is not available here.');
    // Refuse BEFORE any consent if the token could not be stored safely afterwards.
    if (typeof this.tokenStore.available === 'function' && this.tokenStore.available() !== true) {
      throw new LiError('MAILBOX_VAULT_UNAVAILABLE', 'Secure storage is not available on this computer, so no mailbox can be connected.');
    }
    let tokens;
    try {
      tokens = await this.googleOAuth.authorize(client);
    } catch (e) { throw mailboxError(e); }
    let profile;
    try {
      profile = await gmailProfile(this.fetch, tokens.accessToken);
    } catch (e) {
      await this.googleOAuth.revoke(tokens.refreshToken);
      throw mailboxError(e);
    }
    const nowIso = this._now().toISOString();
    const existing = (await this.store.mailboxes.list()).find((m) => m.provider === 'gmail' && m.email_address === profile.emailAddress.trim().toLowerCase());
    const mailboxId = existing ? existing.mailbox_id : this.newId();
    const previous = existing ? await this._tokenOf(mailboxId) : null;
    let row;
    try {
      // Token first: a row never exists without the credential it needs.
      await this.tokenStore.set(mailboxId, tokens.refreshToken);
      row = await this.store.mailboxes.upsert({
        mailbox_id: mailboxId, provider: 'gmail', email_address: profile.emailAddress, display_name: null,
        status: 'needs_check', status_code: PROVIDER_CAPABILITY.gmail.code, paused_until: null,
        ...MAILBOX_DEFAULTS, time_zone: this.defaultTimeZone, is_default: 0, sync_cursor: null,
        connected_at: nowIso, updated_at: nowIso,
      });
    } catch {
      // Never leave a live grant (or an orphaned sealed token) behind a failed connect.
      await this.googleOAuth.revoke(tokens.refreshToken);
      try {
        if (previous) await this.tokenStore.set(mailboxId, previous);
        else await this.tokenStore.remove(mailboxId);
      } catch { /* the grant is already revoked */ }
      throw new LiError('MAILBOX_CONNECT_FAILED', 'The mailbox could not be saved on this computer. Nothing was connected.');
    }
    // A reconnect replaces the grant: the superseded refresh token is revoked (best effort).
    if (previous && previous !== tokens.refreshToken) await this.googleOAuth.revoke(previous);
    return sanitizeMailbox(row, await this._pacingFor(row));
  }

  /** Disconnect: revoke (best effort), forget the token, remove the row. Past sends keep their history. */
  async disconnect({ mailboxId } = {}) {
    const row = await this._rowOrThrow(mailboxId);
    // An unreadable token (vault reset, decryption failure) must never make a mailbox impossible
    // to disconnect: revoke what can be revoked, then forget everything locally.
    const token = await this._tokenOf(mailboxId);
    if (token && row.provider === 'gmail' && this.googleOAuth) await this.googleOAuth.revoke(token);
    try { await this.tokenStore.remove(mailboxId); } catch { /* removing the row still disconnects it */ }
    await this.store.mailboxes.remove(mailboxId);
    return { mailboxId, disconnected: true };
  }

  /** The stored refresh token, or null if it is missing or cannot be revealed. Main-only. */
  async _tokenOf(mailboxId) {
    try { return (await this.tokenStore.get(mailboxId)) || null; } catch { return null; }
  }

  async setDefault({ mailboxId } = {}) {
    await this._rowOrThrow(mailboxId);
    const row = await this.store.mailboxes.setDefault(mailboxId, this._now().toISOString());
    return sanitizeMailbox(row, await this._pacingFor(row));
  }

  /** Change pacing limits. Accepts the renderer's camelCase keys only; the ZTech maximums hold. */
  async setLimits({ mailboxId, limits } = {}) {
    const current = await this._rowOrThrow(mailboxId);
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new ValidationError('Invalid limits', [{ path: '$.limits', message: 'is required' }]);
    const patch = {};
    for (const [k, v] of Object.entries(limits)) {
      if (!LIMIT_KEYS[k]) throw new ValidationError('Invalid limits', [{ path: `$.limits.${k}`, message: 'is not a pacing setting' }]);
      patch[LIMIT_KEYS[k]] = v;
    }
    if (patch.time_zone !== undefined && !isTimeZone(patch.time_zone)) throw new ValidationError('Invalid limits', [{ path: '$.limits.timeZone', message: 'is not a time zone' }]);
    const check = normalizeLimits(patch, current);
    if (!check.ok) throw new ValidationError('Invalid limits', [{ path: '$.limits', message: check.error.replace(/^limits: /, '') }]);
    const row = await this.store.mailboxes.setLimits(mailboxId, patch, this._now().toISOString());
    return sanitizeMailbox(row, await this._pacingFor(row));
  }

  /* -------------------------------- market rules -------------------------------- */

  async marketRules() {
    return (await this.store.marketRules.list()).map((r) => ({ countryCode: r.country_code, rule: r.rule, note: r.note, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at }));
  }

  /** Record Zee's reviewed rule for one country. The reviewer is the operator, set here. */
  async setMarketRule({ countryCode, rule, note } = {}) {
    if (!MARKET_RULES.includes(rule)) throw new ValidationError('Invalid market rule', [{ path: '$.rule', message: 'must be consent_required or opt_out_allowed' }]);
    const r = await this.store.marketRules.set({ country_code: countryCode, rule, note, reviewed_by: this.operator, reviewed_at: this._now().toISOString() });
    return { countryCode: r.country_code, rule: r.rule, note: r.note, reviewedBy: r.reviewed_by, reviewedAt: r.reviewed_at };
  }

  async removeMarketRule({ countryCode } = {}) {
    if (typeof countryCode !== 'string' || !/^[A-Za-z]{2}$/.test(countryCode)) throw new ValidationError('Invalid country', [{ path: '$.countryCode', message: 'must be a two-letter country code' }]);
    return { countryCode: countryCode.toUpperCase(), removed: await this.store.marketRules.remove(countryCode) };
  }
}

module.exports = { MailboxService, LIMIT_KEYS };
