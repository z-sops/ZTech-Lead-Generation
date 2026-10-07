'use strict';

/**
 * F26.5 RelayClient - the DESKTOP side of the Hosted Trust Relay contract (the server is F26.5b).
 *
 * OFF BY DEFAULT. It exists only when BOTH a relay URL (settings.trustRelayUrl) and a relay
 * secret (credential vault, main process only) are configured. Nothing else turns it on.
 *
 * THE WHOLE CONTRACT - and nothing more crosses the boundary:
 *   GET  {base}/v1/events?after={cursor}&limit={n}
 *        <- { events: [{ event_id, kind, channel, recipient_ref, received_at, signature }],
 *             next_cursor }
 *   POST {base}/v1/events/ack   { event_ids: [...] }
 *   Authorization: Bearer {hex HMAC(secret, 'ztech-relay-v1 auth')} - derived, never the secret.
 *   Unsubscribe links: {base}/u/{recipient_ref} (built locally; the relay serves the page).
 *
 * NO LEAD, RESEARCH OR PITCH DATA EVER LEAVES. Requests carry a cursor, a limit and event ids.
 * The relay sees recipient_refs it can compute from an address it already received from a
 * provider webhook or a click, and never a clear address from ZTech.
 *
 * Every pulled event goes through TrustService.intake (signature verified, idempotent by
 * event_id), then is acknowledged. The cursor is persisted only after the batch is processed,
 * so a crash re-delivers and intake ignores what it already has. Pulls are sequential and
 * bounded; a failure is reported, never thrown into the app.
 */

const crypto = require('crypto');
const { deriveRelayKeys, recipientRefFor } = require('./relaySignature');
const { normalizeAddress } = require('./trustContract');

const RELAY_LIMITS = Object.freeze({ PULL_LIMIT: 100, MAX_BYTES: 512 * 1024, TIMEOUT_MS: 15000, MIN_INTERVAL_MS: 60000, CURSOR_MAX: 200 });
const CURSOR_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** A relay base URL: https only (http only for a loopback host, for local development). */
function normalizeRelayUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u;
  try { u = new URL(raw.trim()); } catch { return null; }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  if (u.username || u.password || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

class RelayClient {
  /**
   * @param {{baseUrl: string, secret: string, trust: object, fetchImpl?: Function,
   *          cursorStore?: {get: () => string|null, set: (c: string) => void}, logger?: object}} opts
   */
  constructor({ baseUrl, secret, trust, fetchImpl = globalThis.fetch, cursorStore = null, logger = null }) {
    const base = normalizeRelayUrl(baseUrl);
    if (!base) throw new TypeError('relay URL must be https');
    if (!trust || typeof trust.intake !== 'function') throw new TypeError('TrustService required');
    this.base = base;
    this.keys = deriveRelayKeys(secret);
    this.auth = crypto.createHmac('sha256', secret).update('ztech-relay-v1 auth').digest('hex');
    this.trust = trust;
    this.fetchImpl = fetchImpl;
    this.cursorStore = cursorStore;
    this.logger = logger;
    this.timer = null;
    this.running = false;
    trust.setRelayKeys(this.keys);
  }

  /** The one-click unsubscribe link for an address. Pure: no I/O, no write. */
  linkFor(channel, address) {
    const a = normalizeAddress(channel, address);
    const ref = a ? recipientRefFor(this.keys.refKey, channel, a) : null;
    return ref ? { url: `${this.base}/u/${ref}`, recipientRef: ref } : null;
  }

  _cursor() {
    try {
      const c = this.cursorStore ? this.cursorStore.get() : null;
      return typeof c === 'string' && CURSOR_RE.test(c) ? c : null;
    } catch { return null; }
  }

  async _request(method, path, body) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), RELAY_LIMITS.TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.auth}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await res.text();
      if (text.length > RELAY_LIMITS.MAX_BYTES) return { ok: false, code: 'RELAY_RESPONSE_TOO_LARGE' };
      if (!res.ok) return { ok: false, code: `RELAY_HTTP_${res.status}` };
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { return { ok: false, code: 'RELAY_RESPONSE_INVALID' }; }
      return { ok: true, json };
    } catch {
      return { ok: false, code: 'RELAY_UNREACHABLE' };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Pull one batch, intake every event, acknowledge them, then advance the cursor.
   * @returns {Promise<{ok: boolean, code?: string, pulled?: number, applied?: number, rejected?: number}>}
   */
  async pullOnce() {
    if (this.running) return { ok: false, code: 'RELAY_PULL_IN_PROGRESS' };
    this.running = true;
    try {
      const after = this._cursor();
      const q = `?limit=${RELAY_LIMITS.PULL_LIMIT}${after ? `&after=${encodeURIComponent(after)}` : ''}`;
      const got = await this._request('GET', `/v1/events${q}`);
      if (!got.ok) return got;
      const events = got.json && Array.isArray(got.json.events) ? got.json.events.slice(0, RELAY_LIMITS.PULL_LIMIT) : null;
      const next = got.json ? got.json.next_cursor : null;
      if (!events || (next != null && (typeof next !== 'string' || !CURSOR_RE.test(next)))) return { ok: false, code: 'RELAY_RESPONSE_INVALID' };
      const ids = [];
      let applied = 0;
      let rejected = 0;
      for (const raw of events) {
        const e = raw && typeof raw === 'object' ? {
          event_id: raw.event_id, kind: raw.kind, channel: raw.channel, recipient_ref: raw.recipient_ref == null ? null : raw.recipient_ref,
          received_at: raw.received_at, signature: raw.signature,
        } : {};
        const r = await this.trust.intake(e, { source: 'relay' });
        if (r.state === 'applied' && !r.duplicate) applied += 1;
        if (!r.accepted) rejected += 1;
        if (typeof e.event_id === 'string' && e.event_id.length <= 128) ids.push(e.event_id);
      }
      if (ids.length) {
        const ack = await this._request('POST', '/v1/events/ack', { event_ids: ids });
        if (!ack.ok) return { ok: false, code: ack.code, pulled: events.length, applied, rejected };
      }
      if (next && this.cursorStore) this.cursorStore.set(next);
      return { ok: true, pulled: events.length, applied, rejected };
    } finally {
      this.running = false;
    }
  }

  /** Start periodic pulls (never more often than once a minute). Unref'd: it never keeps the app alive. */
  start(intervalMs = 5 * 60 * 1000) {
    if (this.timer) return;
    const every = Math.max(Number(intervalMs) || 0, RELAY_LIMITS.MIN_INTERVAL_MS);
    const tick = () => this.pullOnce().then((r) => {
      if (!r.ok && this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] trust relay pull failed: ${r.code}`);
    });
    tick();
    this.timer = setInterval(tick, every);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Build the client only when BOTH a valid relay URL and a secret exist. Otherwise null - the
 * default, and a fully supported state (local suppression + mailto unsubscribe).
 */
function buildRelayClient({ url, getSecret, trust, fetchImpl, cursorStore, logger }) {
  const base = normalizeRelayUrl(url);
  if (!base || typeof getSecret !== 'function') return null;
  let secret = null;
  try { secret = getSecret(); } catch { secret = null; }
  if (typeof secret !== 'string' || secret.length < 32) return null;
  return new RelayClient({ baseUrl: base, secret, trust, fetchImpl, cursorStore, logger });
}

module.exports = { RelayClient, buildRelayClient, normalizeRelayUrl, RELAY_LIMITS };
