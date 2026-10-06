'use strict';

const { EmailProvider } = require('./EmailProvider');
const { LiError } = require('../../core/errors');

/**
 * ResendEmailProvider — F23's REAL EMAIL TRANSPORT boundary, behind the existing
 * EmailProvider contract.
 *
 * WHAT THIS CLASS IS ALLOWED TO DO (and nothing else):
 *   - construct a valid Resend "send email" request from a COMPLETE, already-validated
 *     send command it receives from the controlled pipeline,
 *   - authenticate using a secret that exists ONLY in the main process,
 *   - submit that request through an injected transport,
 *   - normalize the provider's response or failure into ZTech-owned facts.
 *
 * WHAT IT MUST NEVER DO - these decisions belong upstream in the controlled pipeline
 * (F13 approval, F16 readiness, F19 send boundary): query leads, query pitches, decide
 * readiness, approve or rewrite content, choose or change the recipient, select a channel,
 * pick a sender identity, or generate subject/body text. The command it receives is
 * FINAL; this class only serializes it.
 *
 * SECRETS: the API key arrives as a `getApiKey()` closure supplied by the main process
 * (electron-store `providers.resend.credentials.apiKey`, revealed via credentialVault).
 * It is read at send time, attached only to the outgoing Authorization header, and never
 * stored on this instance, never logged, never returned, and never present in any payload
 * this class hands back. The renderer can never reach this class: it lives in the main
 * process behind the send boundary.
 *
 * TRANSPORT INJECTION: the actual HTTP call is a dependency. Tests inject a spy transport
 * and therefore prove invocation counts without any network. The default transport below
 * is real fetch and is only ever reached when a send has already passed every upstream
 * check - which, for the current installation (no credential, no verified domain), never
 * happens.
 *
 * RESULT NORMALIZATION: `send()` resolves only `{ messageId, status: 'queued' }` - the
 * F19 contract. "Accepted by provider" is the strongest claim this class ever makes;
 * there is no delivery, open or click status here because F23 has no tracking system,
 * and provider acceptance is never translated into "delivered".
 *
 * ERROR NORMALIZATION: provider failures become LiError with one of the stable codes in
 * RESEND_TRANSPORT_ERRORS below. The provider's raw response text, the Authorization
 * header and the API key never leave this class.
 */

const RESEND_TRANSPORT_ERRORS = Object.freeze({
  CREDENTIAL_MISSING: 'EMAIL_CREDENTIAL_MISSING',
  AUTH_FAILED: 'EMAIL_PROVIDER_AUTH_FAILED',
  RATE_LIMITED: 'EMAIL_PROVIDER_RATE_LIMITED',
  INVALID_SENDER: 'EMAIL_PROVIDER_INVALID_SENDER',
  INVALID_RECIPIENT: 'EMAIL_PROVIDER_INVALID_RECIPIENT',
  DOMAIN_REJECTED: 'EMAIL_PROVIDER_DOMAIN_REJECTED',
  PROVIDER_UNAVAILABLE: 'EMAIL_PROVIDER_UNAVAILABLE',
  TIMEOUT: 'EMAIL_PROVIDER_TIMEOUT',
  BAD_RESPONSE: 'EMAIL_PROVIDER_BAD_RESPONSE',
});

const ERROR_MESSAGES = Object.freeze({
  [RESEND_TRANSPORT_ERRORS.CREDENTIAL_MISSING]: 'No email provider API key is configured.',
  [RESEND_TRANSPORT_ERRORS.AUTH_FAILED]: 'The email provider rejected the stored credential.',
  [RESEND_TRANSPORT_ERRORS.RATE_LIMITED]: 'The email provider is rate limiting requests. Try again later.',
  [RESEND_TRANSPORT_ERRORS.INVALID_SENDER]: 'The email provider refused the configured sender identity.',
  [RESEND_TRANSPORT_ERRORS.INVALID_RECIPIENT]: 'The email provider refused the recipient address.',
  [RESEND_TRANSPORT_ERRORS.DOMAIN_REJECTED]: 'The email provider refused the sending domain.',
  [RESEND_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE]: 'The email provider is unavailable right now.',
  [RESEND_TRANSPORT_ERRORS.TIMEOUT]: 'The email provider did not respond in time.',
  [RESEND_TRANSPORT_ERRORS.BAD_RESPONSE]: 'The email provider returned an unrecognised response.',
});

const ENDPOINT = 'https://api.resend.com/emails';

// The underlying cause object is deliberately NOT accepted: raw fetch/provider errors can
// carry response fragments, so only the bounded code + factual message ever leaves here.
function transportError(code) {
  return new LiError(code, ERROR_MESSAGES[code] || 'The email provider could not accept the message.');
}

/**
 * The DEFAULT transport: real HTTPS via fetch, main process only. It returns a bounded
 * { status, body } pair and throws normalized transport errors for network-level
 * failures. It logs nothing and echoes nothing.
 */
async function defaultTransport({ url, headers, body, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw transportError(RESEND_TRANSPORT_ERRORS.TIMEOUT);
    }
    throw transportError(RESEND_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE);
  } finally {
    clearTimeout(timer);
  }
  let parsed = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  return { status: res.status, body: parsed };
}

/** Escape a display name for a RFC5322 `Name <addr>` header value. Plain text only. */
function formatFrom(displayName, address) {
  const name = typeof displayName === 'string' ? displayName.replace(/["\\]/g, '') : '';
  return name ? `${name} <${address}>` : address;
}

class ResendEmailProvider extends EmailProvider {
  /**
   * @param {object} [options]
   * @param {Function} [options.transport] injected transport ({url, headers, body,
   *        timeoutMs}) => {status, body}. Tests inject spies here so NO network is used.
   * @param {Function} [options.getApiKey] main-process closure returning the revealed
   *        API key (or null). Never a plain key on the options object.
   * @param {number} [options.timeoutMs]
   */
  constructor({ transport = null, getApiKey = null, timeoutMs = 15000 } = {}) {
    super();
    this._transport = typeof transport === 'function' ? transport : defaultTransport;
    this._getApiKey = typeof getApiKey === 'function' ? getApiKey : null;
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  }

  get id() { return 'resend'; }
  /** F19's interlock: this adapter DOES reach a real mail service, so it opts in. */
  get live() { return true; }

  /**
   * The ONLY method that can touch the outside world. It receives the complete,
   * already-validated command from the send boundary and performs no decision of its own.
   * @returns {Promise<{messageId: string, status: 'queued'}>} acceptance only - never
   *          delivered/opened/clicked.
   */
  async send(message) {
    if (!this._getApiKey) throw transportError(RESEND_TRANSPORT_ERRORS.CREDENTIAL_MISSING);
    let key = null;
    try { key = this._getApiKey(); } catch { key = null; }
    if (typeof key !== 'string' || key.length === 0) {
      throw transportError(RESEND_TRANSPORT_ERRORS.CREDENTIAL_MISSING);
    }

    const payload = {
      from: formatFrom(message.fromName, message.from),
      to: [message.to],
      subject: message.subject,
      text: message.text,
    };
    if (message.replyTo) payload.reply_to = message.replyTo;
    // The stable idempotency key travels WITH the request as one more replay defence on
    // top of the ZTech ledger that already gates this call.
    if (message.headers && Object.keys(message.headers).length) {
      payload.headers = { ...message.headers };
    }

    const response = await this._transport({
      url: ENDPOINT,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': (message.headers && message.headers['X-ZTech-Send-Key']) || '',
      },
      body: JSON.stringify(payload),
      timeoutMs: this._timeoutMs,
    });

    const status = response && Number(response.status);
    const body = response && response.body && typeof response.body === 'object' ? response.body : null;

    if (status >= 200 && status < 300) {
      const id = body && typeof body.id === 'string' && body.id ? body.id : null;
      if (!id) throw transportError(RESEND_TRANSPORT_ERRORS.BAD_RESPONSE);
      return { messageId: id, status: 'queued' };
    }

    throw this._normalizeFailure(status, body);
  }

  /** Map a non-2xx provider response to one stable ZTech code + safe factual message. */
  _normalizeFailure(status, body) {
    const name = body && typeof body.name === 'string' ? body.name.toLowerCase() : '';
    const message = body && typeof body.message === 'string' ? body.message.toLowerCase() : '';
    const detail = `${name} ${message}`;
    if (status === 401 || status === 403) {
      if (/domain|verified|verification/.test(detail)) {
        return transportError(RESEND_TRANSPORT_ERRORS.DOMAIN_REJECTED);
      }
      return transportError(RESEND_TRANSPORT_ERRORS.AUTH_FAILED);
    }
    if (status === 429) return transportError(RESEND_TRANSPORT_ERRORS.RATE_LIMITED);
    if (status === 422 || status === 400) {
      if (/to\b|recipient|invalid.*email/.test(detail)) {
        return transportError(RESEND_TRANSPORT_ERRORS.INVALID_RECIPIENT);
      }
      return transportError(RESEND_TRANSPORT_ERRORS.INVALID_SENDER);
    }
    if (status >= 500) return transportError(RESEND_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE);
    return transportError(RESEND_TRANSPORT_ERRORS.BAD_RESPONSE);
  }

  /**
   * F23 has no delivery tracking: the provider's acceptance proves nothing beyond
   * acceptance, so the honest status of any message id is "unknown".
   */
  async getStatus() {
    return { messageId: null, status: 'unknown' };
  }
}

module.exports = { ResendEmailProvider, RESEND_TRANSPORT_ERRORS, defaultTransport, ENDPOINT };
