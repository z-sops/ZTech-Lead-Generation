'use strict';

/**
 * F26.6 - the minimal Gmail REST client. MAIN PROCESS ONLY.
 *
 * Exactly the calls Step 1A proved under gmail.send + gmail.metadata, and nothing else:
 *   users.getProfile          (gmail.metadata)  address + current historyId
 *   users.messages.send       (gmail.send)      one raw message
 *   users.messages.get        (gmail.metadata)  format=metadata, named headers only - never a body
 *   users.history.list        (gmail.metadata)  messageAdded since a cursor
 *
 * The access token comes from an injected function per request and is never stored here,
 * returned or put into an error. Errors carry ZTech's own code and text only - never Google's.
 */

const { LiError } = require('../../core/errors');
const { GOOGLE } = require('./GoogleOAuth');

const LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded']);
const MAX_ID = 200;

function idOk(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id); }

class GmailApi {
  /** @param {{fetch?: Function, getAccessToken: () => Promise<string>}} deps */
  constructor({ fetch: fetchImpl = globalThis.fetch, getAccessToken } = {}) {
    if (typeof getAccessToken !== 'function') throw new TypeError('GmailApi needs getAccessToken');
    this.fetch = fetchImpl;
    this.getAccessToken = getAccessToken;
  }

  async _call(method, path, body = undefined) {
    const token = await this.getAccessToken();
    let res;
    try {
      res = await this.fetch(`${GOOGLE.GMAIL_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      throw new LiError('MAILBOX_PROVIDER_UNAVAILABLE', 'Gmail could not be reached. Nothing was retried.');
    }
    let json = {};
    try { json = await res.json(); } catch { json = {}; }
    if (res.ok) return json || {};
    const reason = json && json.error && Array.isArray(json.error.errors) && json.error.errors[0] ? json.error.errors[0].reason : null;
    if (res.status === 401) throw new LiError('MAILBOX_RECONNECT_NEEDED', 'This mailbox needs to be reconnected.');
    if (res.status === 429 || (res.status === 403 && LIMIT_REASONS.has(reason))) throw new LiError('MAILBOX_PROVIDER_LIMIT', 'Gmail refused because a sending or usage limit was reached. Nothing was retried.');
    if (res.status === 403) throw new LiError('MAILBOX_RECONNECT_NEEDED', 'Gmail refused this permission. Reconnect the mailbox and grant both permissions.');
    if (res.status === 404) throw new LiError('MAILBOX_REMOTE_NOT_FOUND', 'Gmail did not find what ZTech asked for.');
    if (res.status === 400) throw new LiError('MAILBOX_PROVIDER_REJECTED', 'Gmail rejected the request.');
    throw new LiError('MAILBOX_PROVIDER_UNAVAILABLE', 'Gmail could not process the request right now. Nothing was retried.');
  }

  async profile() {
    const j = await this._call('GET', '/profile');
    return { emailAddress: typeof j.emailAddress === 'string' ? j.emailAddress : null, historyId: j.historyId != null ? String(j.historyId) : null };
  }

  /** Send one raw (base64url) message. Returns Gmail's own ids only. */
  async sendRaw(rawBase64Url) {
    const j = await this._call('POST', '/messages/send', { raw: rawBase64Url });
    if (!idOk(j.id)) throw new LiError('MAILBOX_PROVIDER_REJECTED', 'Gmail did not return a message id.');
    return { id: j.id, threadId: idOk(j.threadId) ? j.threadId : null, labelIds: Array.isArray(j.labelIds) ? j.labelIds.slice(0, 20).map(String) : [] };
  }

  /** Named headers of one message (format=metadata). Never the body. */
  async metadata(id, names) {
    if (!idOk(id)) throw new LiError('MAILBOX_PROVIDER_REJECTED', 'Invalid Gmail message id.');
    const q = names.map((n) => `metadataHeaders=${encodeURIComponent(n)}`).join('&');
    const j = await this._call('GET', `/messages/${id}?format=metadata&${q}`);
    const headers = {};
    for (const h of ((j.payload && j.payload.headers) || []).slice(0, 200)) {
      if (!h || typeof h.name !== 'string' || typeof h.value !== 'string') continue;
      const k = h.name.toLowerCase();
      if (!(k in headers)) headers[k] = h.value.slice(0, 2000);
    }
    return {
      id: j.id, threadId: idOk(j.threadId) ? j.threadId : null,
      labelIds: Array.isArray(j.labelIds) ? j.labelIds.slice(0, 50).map(String) : [], headers,
    };
  }

  /** One page of history (messageAdded, INBOX) since a cursor. */
  async history({ startHistoryId, pageToken = null }) {
    if (!/^\d{1,30}$/.test(String(startHistoryId))) throw new LiError('MAILBOX_PROVIDER_REJECTED', 'Invalid history cursor.');
    const q = new URLSearchParams({ startHistoryId: String(startHistoryId), historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' });
    if (pageToken) q.set('pageToken', String(pageToken).slice(0, MAX_ID));
    const j = await this._call('GET', `/history?${q}`);
    const added = [];
    let lastRecordId = null;
    for (const h of Array.isArray(j.history) ? j.history : []) {
      if (h && h.id != null && /^\d{1,30}$/.test(String(h.id))) lastRecordId = String(h.id);
      for (const a of Array.isArray(h.messagesAdded) ? h.messagesAdded : []) {
        const m = a && a.message;
        if (m && idOk(m.id)) added.push({ id: m.id, labelIds: Array.isArray(m.labelIds) ? m.labelIds.map(String) : [] });
      }
    }
    return {
      added,
      lastRecordId,
      historyId: j.historyId != null && /^\d{1,30}$/.test(String(j.historyId)) ? String(j.historyId) : null,
      nextPageToken: typeof j.nextPageToken === 'string' ? j.nextPageToken : null,
    };
  }
}

module.exports = { GmailApi };
