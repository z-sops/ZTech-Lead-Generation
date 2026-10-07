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
 *   - Gmail: Step 1A passed live. A mailbox is Ready only after its own Check mailbox passes
 *     (a self-send whose stored copy keeps List-Unsubscribe and shows a readable Message-ID).
 *   - Microsoft 365: identity only (MAILBOX_PROVIDER_UNVERIFIED) - no connect, send or sync.
 *
 * Reply sync is headers-only polling (history.list + messages.get format=metadata). A message
 * counts as a REPLY only when it cites a provider-STORED Message-ID of this mailbox; an
 * "unsubscribe" subject suppresses; auto-replies and delivery reports are skipped (bounce
 * detection is deferred).
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
const { GmailApi } = require('./gmail/GmailApi');
const { GmailMailboxTransport } = require('./gmail/GmailMailboxTransport');
const { parseMessageIds, parseFromAddress, mailboxEventId } = require('./gmail/rfc2822');
const { unsubscribeHeaders } = require('../trust/unsubscribe');

const CHECK_MIN_INTERVAL_MS = 60 * 1000;
const SYNC_MAX_PAGES = 10;
const SYNC_MAX_MESSAGES = 200;
const REPLY_HEADERS = Object.freeze(['From', 'Subject', 'In-Reply-To', 'References', 'Auto-Submitted', 'Content-Type', 'Precedence', 'X-Autoreply', 'X-Autorespond', 'List-Id']);
const ACCESS_TOKEN_TTL_MS = 45 * 60 * 1000; // Google issues ~60 min tokens; refreshed well before
const UNSUBSCRIBE_SUBJECT = /\b(unsubscribe|remove me|opt[ -]?out)\b/i;
const DELIVERY_REPORT_FROM = /^(mailer-daemon|postmaster)@/i;

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
    operator = 'local-user', defaultTimeZone = localTimeZone(), newId = () => 'mbx_' + crypto.randomBytes(12).toString('hex'), logger = null, trust = null } = {}) {
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
    this.trust = trust;
    this._connecting = null;
    this._busy = new Set(); // mailbox_ids with a send or check in flight (one at a time per mailbox)
    this._lastCheck = new Map();
    this._syncing = null;
    this._syncByMailbox = new Map(); // one reply sync per mailbox at a time (timer and button share it)
    this._accessCache = new Map(); // mailbox_id -> { token, until } - main-only, memory only
  }

  /** The trust service that receives mailbox events (main-only). */
  setTrust(trust) { this.trust = trust || null; }

  /**
   * F28: told when Gmail could no longer give the reply history (cursor reset), whoever ran the
   * sync (timer, button or the scheduler), so follow-ups of that mailbox wait for a human.
   */
  setRepliesGapListener(fn) { this._onRepliesGap = typeof fn === 'function' ? fn : null; }

  /**
   * F29: the Reply Router listener - called once per message AFTER the trust intake decided (or,
   * for an automatic reply, after it was skipped). It only suggests a category; it cannot change
   * what the sync records, and its failure never fails the sync.
   */
  setReplyRouter(fn) { this._onReplyRouted = typeof fn === 'function' ? fn : null; }

  async _routeReply(message) {
    if (!this._onReplyRouted) return;
    try { await this._onReplyRouted(message); } catch (err) {
      if (this.logger && this.logger.warn) this.logger.warn(`[mailbox] reply router failed: ${(err && err.code) || 'ERROR'}`);
    }
  }

  async _repliesGap(mailboxId) {
    if (!this._onRepliesGap) return;
    try { await this._onRepliesGap(mailboxId, this._now().toISOString()); } catch (err) {
      if (this.logger && this.logger.warn) this.logger.warn(`[mailbox] reply-gap note failed: ${(err && err.code) || 'ERROR'}`);
    }
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
  async sendGate(mailboxId, { pacing = true } = {}) {
    const row = await this._rowOrThrow(mailboxId);
    const cap = PROVIDER_CAPABILITY[row.provider];
    if (!cap || !cap.canSend) return { allowed: false, code: cap ? cap.code : 'MAILBOX_PROVIDER_UNVERIFIED', message: PROVIDER_NOTICE[row.provider] || 'This mailbox provider cannot send yet.' };
    if (row.status !== 'ready') return { allowed: false, code: 'MAILBOX_NOT_READY', message: 'Run "Check mailbox" for this mailbox before sending from it.' };
    const verdict = await this._pacingFor(row);
    if (pacing && !verdict.allowed) return { allowed: false, code: PACING_CODE, message: pacingMessage(verdict), nextAllowedAt: verdict.nextAllowedAt, reason: verdict.reason };
    return { allowed: true, mailbox: sanitizeMailbox(row, verdict) };
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
        status: 'needs_check', status_code: 'MAILBOX_CHECK_REQUIRED', paused_until: null,
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
    // Reply sync starts from "now": nothing that arrived before the connect is read.
    if (!row.sync_cursor && profile.historyId) {
      await this.store.mailboxes.setSyncCursor(mailboxId, profile.historyId, nowIso);
      row = await this.store.mailboxes.get(mailboxId);
    }
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

  /* ------------------------------ Gmail transport ------------------------------ */

  async _accessToken(row) {
    const client = this._client();
    if (!client || !this.googleOAuth) throw new LiError('MAILBOX_CLIENT_NOT_CONFIGURED', 'Add your Google OAuth client ID and secret in Settings > Mailboxes first.');
    const refreshToken = await this._tokenOf(row.mailbox_id);
    if (!refreshToken) {
      await this._mark(row, 'reconnect_needed', 'MAILBOX_RECONNECT_NEEDED');
      throw new LiError('MAILBOX_RECONNECT_NEEDED', 'This mailbox needs to be reconnected.');
    }
    const cached = this._accessCache.get(row.mailbox_id);
    const nowMs = this._now().getTime();
    if (cached && cached.until > nowMs) return cached.token;
    try {
      const token = await this.googleOAuth.accessToken({ ...client, refreshToken });
      this._accessCache.set(row.mailbox_id, { token, until: nowMs + ACCESS_TOKEN_TTL_MS });
      return token;
    } catch (e) {
      const err = mailboxError(e);
      if (err && err.code === 'MAILBOX_RECONNECT_NEEDED') await this._mark(row, 'reconnect_needed', 'MAILBOX_RECONNECT_NEEDED');
      throw err;
    }
  }

  async _mark(row, status, code) {
    try {
      await this.store.mailboxes.setStatus(row.mailbox_id, { status, status_code: code, updated_at: this._now().toISOString() });
    } catch { /* the refusal itself still reaches the caller */ }
  }

  _api(row) {
    return new GmailApi({
      fetch: this.fetch,
      getAccessToken: () => this._accessToken(row),
      // Gmail itself refused the grant (revoked scope, 401): forget the token in memory and mark
      // the mailbox "Reconnect needed", so neither sends nor syncs keep failing against it.
      onAuthFailure: async () => {
        this._accessCache.delete(row.mailbox_id);
        await this._mark(row, 'reconnect_needed', 'MAILBOX_RECONNECT_NEEDED');
      },
    });
  }

  /**
   * The transport for ONE send from ONE mailbox (main-only). Refuses a provider that is not
   * capability-enabled; the caller (the send boundary) runs sendGate() first.
   */
  async transportFor(mailboxId) {
    const row = await this._rowOrThrow(mailboxId);
    const cap = PROVIDER_CAPABILITY[row.provider];
    if (!cap || !cap.canSend || row.provider !== 'gmail') throw new LiError(cap ? cap.code || 'MAILBOX_PROVIDER_UNVERIFIED' : 'MAILBOX_PROVIDER_UNVERIFIED', PROVIDER_NOTICE[row.provider] || 'This mailbox provider cannot send.');
    const api = this._api(row);
    return new GmailMailboxTransport({ api, mailbox: row });
  }

  /** One send or check per mailbox at a time: a second click while one is in flight is refused. */
  async withMailboxLock(mailboxId, fn) {
    if (this._busy.has(mailboxId)) throw new LiError('MAILBOX_BUSY', 'This mailbox is already sending one message. Nothing was queued; try again when it finishes.');
    this._busy.add(mailboxId);
    try { return await fn(); } finally { this._busy.delete(mailboxId); }
  }

  /** After a real send: a stripped unsubscribe header takes the mailbox out of Ready. */
  async noteReadBack(mailboxId, readBack) {
    if (!readBack) return; // a failed READ is not evidence about the mailbox
    const code = readBack.listUnsubscribeKept === false ? 'MAILBOX_HEADER_STRIPPED' : (!readBack.storedMessageId ? 'MAILBOX_MESSAGE_ID_UNREADABLE' : null);
    if (code) {
      const row = await this.store.mailboxes.get(mailboxId);
      if (row) await this._mark(row, 'needs_check', code);
    }
  }

  /**
   * "Check mailbox": ONE message from the mailbox to itself, then a read-back of the stored copy.
   * Ready only when the stored copy keeps List-Unsubscribe and shows a readable Message-ID - the
   * two things every real send and reply match depend on. Nothing is retried.
   */
  async check({ mailboxId } = {}) {
    const row = await this._rowOrThrow(mailboxId);
    const cap = PROVIDER_CAPABILITY[row.provider];
    if (!cap || !cap.canSend) throw new LiError(cap ? cap.code || 'MAILBOX_PROVIDER_UNVERIFIED' : 'MAILBOX_PROVIDER_UNVERIFIED', PROVIDER_NOTICE[row.provider] || 'This mailbox provider is not available.');
    const last = this._lastCheck.get(mailboxId);
    const nowMs = this._now().getTime();
    if (last && nowMs - last < CHECK_MIN_INTERVAL_MS) throw new LiError('MAILBOX_CHECK_TOO_SOON', 'This mailbox was checked less than a minute ago. Nothing was sent.');
    return this.withMailboxLock(mailboxId, async () => {
      this._lastCheck.set(mailboxId, nowMs);
      const transport = await this.transportFor(mailboxId);
      const headers = unsubscribeHeaders({ mailbox: row.email_address });
      const message = {
        to: row.email_address, from: row.email_address, subject: 'ZTech mailbox check',
        text: 'ZTech sent this message from your mailbox to itself to confirm that Gmail keeps the unsubscribe header and a readable Message-ID. You can delete it.',
        headers: { ...headers, 'X-ZTech-Check': crypto.randomBytes(8).toString('hex') },
      };
      const sent = await transport.send(message);
      const rb = await transport.readBack(sent.messageId, { expectListUnsubscribe: headers['List-Unsubscribe'] });
      const passed = rb.listUnsubscribeKept && Boolean(rb.storedMessageId);
      const code = passed ? null : (!rb.listUnsubscribeKept ? 'MAILBOX_HEADER_STRIPPED' : 'MAILBOX_MESSAGE_ID_UNREADABLE');
      await this.store.mailboxes.setStatus(mailboxId, { status: passed ? 'ready' : 'needs_check', status_code: code, updated_at: this._now().toISOString() });
      // Reply sync starts here if it had no cursor yet.
      const fresh = await this.store.mailboxes.get(mailboxId);
      if (!fresh.sync_cursor) {
        const p = await this._api(fresh).profile().catch(() => null);
        if (p && p.historyId) await this.store.mailboxes.setSyncCursor(mailboxId, p.historyId, this._now().toISOString());
      }
      const after = await this.store.mailboxes.get(mailboxId);
      return { mailbox: sanitizeMailbox(after, await this._pacingFor(after)), check: { passed, listUnsubscribeKept: rb.listUnsubscribeKept, storedMessageIdReadable: Boolean(rb.storedMessageId) } };
    });
  }

  /**
   * Headers-only reply sync for ONE mailbox. Reads what arrived in the Inbox since the cursor and
   * hands each candidate to the trust intake as a 'mailbox' event:
   *   - a delivery report (multipart/report, mailer-daemon, postmaster) is SKIPPED - bounces deferred;
   *   - an automatic message (Auto-Submitted, X-Autoreply, Precedence bulk/auto_reply) is skipped;
   *   - an "unsubscribe" subject -> 'unsubscribe' (suppresses; needs no match);
   *   - otherwise a message citing ids -> 'reply' (the intake accepts it ONLY if a cited id is a
   *     STORED Message-ID of this mailbox's own sends).
   * The cursor advances only after every candidate was handed over.
   */
  async syncReplies({ mailboxId } = {}) {
    // The timer and "Check replies now" share one run per mailbox: never two cursors in flight.
    const running = this._syncByMailbox.get(mailboxId);
    if (running) return running;
    const run = this._syncRepliesOnce({ mailboxId }).finally(() => this._syncByMailbox.delete(mailboxId));
    this._syncByMailbox.set(mailboxId, run);
    return run;
  }

  async _syncRepliesOnce({ mailboxId }) {
    const row = await this._rowOrThrow(mailboxId);
    const cap = PROVIDER_CAPABILITY[row.provider];
    if (!cap || !cap.canSyncReplies || row.provider !== 'gmail') throw new LiError(cap ? cap.code || 'MAILBOX_PROVIDER_UNVERIFIED' : 'MAILBOX_PROVIDER_UNVERIFIED', PROVIDER_NOTICE[row.provider] || 'Reply sync is not available for this mailbox.');
    if (row.status === 'reconnect_needed') throw new LiError('MAILBOX_RECONNECT_NEEDED', 'This mailbox needs to be reconnected.');
    if (!this.trust || typeof this.trust.intake !== 'function') throw new LiError('TRUST_UNAVAILABLE', 'The do-not-contact records cannot be written, so replies are not read.');
    const api = this._api(row);
    const summary = { mailboxId, read: 0, replies: 0, unsubscribes: 0, unmatched: 0, skippedAutomatic: 0, skippedDeliveryReports: 0, cursorReset: false, complete: true };
    if (!row.sync_cursor) {
      const p = await api.profile();
      if (p.historyId) await this.store.mailboxes.setSyncCursor(mailboxId, p.historyId, this._now().toISOString());
      return summary;
    }
    // Page by page: every message of a page is handed to the intake, THEN the cursor moves to
    // that page's last history record. A long backlog (app closed for days) is worked through
    // over several runs; nothing is skipped and nothing is read twice into a second effect
    // (event ids are stable, so a re-read is a duplicate no-op).
    const seen = new Set();
    let cursor = row.sync_cursor;
    let pageToken = null;
    for (let page = 0; page < SYNC_MAX_PAGES && summary.read < SYNC_MAX_MESSAGES; page += 1) {
      let h;
      try {
        h = await api.history({ startHistoryId: row.sync_cursor, pageToken });
      } catch (e) {
        if (e && e.code === 'MAILBOX_REMOTE_NOT_FOUND' && page === 0) {
          // The cursor is too old for Gmail's history. Restart from now and SAY so: anything in
          // the gap is not read, and ZTech never claims a reply it did not see.
          const p = await api.profile();
          if (p.historyId) await this.store.mailboxes.setSyncCursor(mailboxId, p.historyId, this._now().toISOString());
          await this._repliesGap(mailboxId);
          return { ...summary, cursorReset: true, complete: true };
        }
        throw e;
      }
      for (const m of h.added) {
        if (seen.has(m.id) || m.labelIds.includes('SENT') || m.labelIds.includes('DRAFT')) continue;
        seen.add(m.id);
        await this._intakeOne(api, row, m.id, summary);
      }
      cursor = h.nextPageToken ? (h.lastRecordId || cursor) : (h.historyId || h.lastRecordId || cursor);
      if (cursor && cursor !== row.sync_cursor) await this.store.mailboxes.setSyncCursor(mailboxId, cursor, this._now().toISOString());
      pageToken = h.nextPageToken;
      if (!pageToken) break;
    }
    // F28: `complete` says whether EVERYTHING up to now was read. A backlog beyond one run's limits
    // is read on the next run; until then a follow-up is not sent (a reply may be in it).
    return { ...summary, complete: !pageToken };
  }

  async _intakeOne(api, row, id, summary) {
    let m;
    try {
      m = await api.metadata(id, REPLY_HEADERS);
    } catch (e) {
      if (e && e.code === 'MAILBOX_REMOTE_NOT_FOUND') { summary.read += 1; return; } // deleted since it arrived
      throw e;
    }
    summary.read += 1;
    const h = m.headers;
    const from = parseFromAddress(h.from || '');
    if (!from || from === row.email_address) return;
    if (DELIVERY_REPORT_FROM.test(from) || /multipart\/report/i.test(h['content-type'] || '')) { summary.skippedDeliveryReports += 1; return; }
    const auto = h['auto-submitted'] && h['auto-submitted'].trim().toLowerCase() !== 'no';
    // Automatic and mailing-list traffic is never a person replying (and never their opt-out).
    if (auto || h['x-autoreply'] || h['x-autorespond'] || h['list-id'] || /^(auto_reply|bulk|junk|list)$/i.test((h.precedence || '').trim())) {
      summary.skippedAutomatic += 1;
      // F29 D4: an auto-reply (not list or bulk mail) that cites one of our stored ids may be noted
      // as "Away". The trust intake still skips it: never a reply, never permission, never a stop.
      if (!h['list-id'] && !/^(bulk|junk|list)$/i.test((h.precedence || '').trim())) {
        const autoRefs = [...parseMessageIds(h['in-reply-to']), ...parseMessageIds(h.references)];
        if (autoRefs.length) await this._routeReply({ kind: 'away', mailboxId: row.mailbox_id, eventId: mailboxEventId(row.mailbox_id, id), from, refs: autoRefs, subject: h.subject || '' });
      }
      return;
    }
    const refs = [...parseMessageIds(h['in-reply-to']), ...parseMessageIds(h.references)];
    const kind = UNSUBSCRIBE_SUBJECT.test(h.subject || '') ? 'unsubscribe' : 'reply';
    if (kind === 'reply' && !refs.length) return;
    const r = await this.trust.intake({
      event_id: mailboxEventId(row.mailbox_id, id), kind, channel: 'email', address: from,
      received_at: this._now().toISOString(), mailbox_id: row.mailbox_id, reference_ids: refs,
    }, { source: 'mailbox' });
    if (r && r.accepted && !r.duplicate) summary[kind === 'reply' ? 'replies' : 'unsubscribes'] += 1;
    else if (r && r.code === 'REPLY_NOT_MATCHED') summary.unmatched += 1;
    // F29: only what the intake ACCEPTED is offered to the router (a re-read is a no-op there).
    if (r && r.accepted) await this._routeReply({ kind, mailboxId: row.mailbox_id, eventId: mailboxEventId(row.mailbox_id, id), from, refs, subject: h.subject || '' });
  }

  /** Sync every Gmail mailbox that can be synced. One at a time; a failure never stops the rest. */
  async syncAll() {
    if (this._syncing) return this._syncing;
    this._syncing = (async () => {
      const out = [];
      for (const row of await this.store.mailboxes.list()) {
        if (row.provider !== 'gmail' || row.status === 'reconnect_needed' || !PROVIDER_CAPABILITY.gmail.canSyncReplies) continue;
        try { out.push(await this.syncReplies({ mailboxId: row.mailbox_id })); } catch (e) { out.push({ mailboxId: row.mailbox_id, error: (e && e.code) || 'MAILBOX_SYNC_FAILED' }); }
      }
      return out;
    })().finally(() => { this._syncing = null; });
    return this._syncing;
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
