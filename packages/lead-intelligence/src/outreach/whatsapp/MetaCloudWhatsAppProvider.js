'use strict';

const { WhatsAppProvider } = require('./WhatsAppProvider');
const { LiError } = require('../../core/errors');

/**
 * MetaCloudWhatsAppProvider — F24's REAL WHATSAPP TRANSPORT boundary, behind the existing
 * WhatsAppProvider contract. This is the ONE production-capable adapter: the official
 * Meta WhatsApp Cloud API. Provider replaceability lives behind the interface - the
 * provider choice itself is configuration (`settings.whatsappProvider`), never business
 * logic in this file.
 *
 * WHAT THIS CLASS IS ALLOWED TO DO (and nothing else):
 *   - build a valid Cloud API "send text" request from a COMPLETE, already-validated send
 *     command it receives from the controlled pipeline,
 *   - authenticate with a token that exists ONLY in the main process,
 *   - submit that request through an injected transport,
 *   - normalize the provider's response or failure into ZTech-owned facts.
 *
 * WHAT IT MUST NEVER DO - these decisions belong upstream in the controlled pipeline
 * (F13 approval, F16 readiness, F19/F20 send boundary): query leads, query pitches, decide
 * readiness, approve or rewrite content, choose or change the recipient, select a channel,
 * pick a sender identity, generate or transform message text, decide readiness, or
 * silently choose another channel. The command it receives is FINAL; this class only
 * serializes it. The message body is submitted BYTE FOR BYTE as `message.body` - there is
 * no formatting pass, no copy rewrite and no content decision of any kind.
 *
 * MESSAGE SHAPE / TEMPLATE HONESTY: this adapter sends the Cloud API's plain `text`
 * message, which is exactly what the shipped message contract supports (plain text, no
 * template rendering - see WhatsAppProvider.js). The Cloud API additionally requires an
 * approved template for outbound messages outside a customer-initiated 24-hour session
 * window; this build has NO template configuration and claims none. When a provider
 * rejects a message for that reason the rejection is normalized into the honest
 * WHATSAPP_PROVIDER_TEMPLATE_REJECTED failure code above - never softened, never retried,
 * never reworded into another channel. Approved-template content generation is upstream,
 * visible work for a future phase; it is deliberately NOT simulated here.
 *
 * SECRETS: the access token arrives as a `getAccessToken()` closure supplied by the main
 * process (electron-store `providers.meta-cloud.credentials.apiKey`, revealed via
 * credentialVault). It is read at send time, attached only to the outgoing Authorization
 * header, and never stored on this instance, never logged, never returned, and never
 * present in any payload this class hands back. The renderer can never reach this class:
 * it lives in the main process behind the send boundary.
 *
 * TRANSPORT INJECTION: the actual HTTP call is a dependency. Tests inject a spy transport
 * and therefore prove invocation counts without any network. The default transport below
 * is real fetch and is only ever reached when a send has already passed every upstream
 * check - which, for the current installation (no provider selected, no credential, no
 * connected number), never happens.
 *
 * SENDER vs RECIPIENT: `message.to` is the lead's stored candidate number (chosen
 * upstream from stored contact facts); the sending account is the CONFIGURED
 * phone-number id, resolved through a closure and placed in the request path. This class
 * never derives either from anything but the command and its closures.
 *
 * RESULT NORMALIZATION: `send()` resolves only `{ messageId, status: 'queued' }` - the
 * F20 contract. "Accepted by provider" is the strongest claim this class ever makes;
 * there is no delivery, read or click status here because F24 has no tracking system,
 * and provider acceptance is never translated into "delivered".
 *
 * ERROR NORMALIZATION: provider failures become LiError with one of the stable codes in
 * WHATSAPP_TRANSPORT_ERRORS below. The provider's raw response text, the Authorization
 * header and the token never leave this class.
 */

const WHATSAPP_TRANSPORT_ERRORS = Object.freeze({
  CREDENTIAL_MISSING: 'WHATSAPP_CREDENTIAL_MISSING',
  ACCOUNT_MISSING: 'WHATSAPP_ACCOUNT_MISSING',
  AUTH_FAILED: 'WHATSAPP_PROVIDER_AUTH_FAILED',
  RATE_LIMITED: 'WHATSAPP_PROVIDER_RATE_LIMITED',
  INVALID_SENDER: 'WHATSAPP_PROVIDER_INVALID_SENDER',
  INVALID_RECIPIENT: 'WHATSAPP_PROVIDER_INVALID_RECIPIENT',
  TEMPLATE_REJECTED: 'WHATSAPP_PROVIDER_TEMPLATE_REJECTED',
  PROVIDER_UNAVAILABLE: 'WHATSAPP_PROVIDER_UNAVAILABLE',
  TIMEOUT: 'WHATSAPP_PROVIDER_TIMEOUT',
  BAD_RESPONSE: 'WHATSAPP_PROVIDER_BAD_RESPONSE',
});

const ERROR_MESSAGES = Object.freeze({
  [WHATSAPP_TRANSPORT_ERRORS.CREDENTIAL_MISSING]: 'No WhatsApp provider access token is configured.',
  [WHATSAPP_TRANSPORT_ERRORS.ACCOUNT_MISSING]: 'No WhatsApp Business account is configured.',
  [WHATSAPP_TRANSPORT_ERRORS.AUTH_FAILED]: 'The WhatsApp provider rejected the stored credential.',
  [WHATSAPP_TRANSPORT_ERRORS.RATE_LIMITED]: 'The WhatsApp provider is rate limiting requests. Try again later.',
  [WHATSAPP_TRANSPORT_ERRORS.INVALID_SENDER]: 'The WhatsApp provider refused the configured sending number or account.',
  [WHATSAPP_TRANSPORT_ERRORS.INVALID_RECIPIENT]: 'The WhatsApp provider refused the recipient number.',
  [WHATSAPP_TRANSPORT_ERRORS.TEMPLATE_REJECTED]: 'The WhatsApp provider requires a message template for this conversation, and this product has not been configured with one.',
  [WHATSAPP_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE]: 'The WhatsApp provider is unavailable right now.',
  [WHATSAPP_TRANSPORT_ERRORS.TIMEOUT]: 'The WhatsApp provider did not respond in time.',
  [WHATSAPP_TRANSPORT_ERRORS.BAD_RESPONSE]: 'The WhatsApp provider returned an unrecognised response.',
});

const PROVIDER_ID = 'meta-cloud';
// The official Graph API endpoint, pinned to a stable version. It is never constructed
// from user input and never appears in the renderer, preload or IPC surface.
const ENDPOINT = 'https://graph.facebook.com/v21.0';

// Cloud API error codes that factually mean "this conversation needs an approved
// template" (or its window/closest equivalent). Matched as exact strings so a longer
// code can never satisfy them by substring accident.
const TEMPLATE_ERROR_CODES = Object.freeze(['470', '131047', '133010', '133016']);

// The underlying cause object is deliberately NOT accepted: raw fetch/provider errors can
// carry response fragments, so only the bounded code + factual message ever leaves here.
function transportError(code) {
  return new LiError(code, ERROR_MESSAGES[code] || 'The WhatsApp provider could not accept the message.');
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
      throw transportError(WHATSAPP_TRANSPORT_ERRORS.TIMEOUT);
    }
    throw transportError(WHATSAPP_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE);
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

class MetaCloudWhatsAppProvider extends WhatsAppProvider {
  /**
   * @param {object} [options]
   * @param {Function} [options.transport] injected transport ({url, headers, body,
   *        timeoutMs}) => {status, body}. Tests inject spies here so NO network is used.
   * @param {Function} [options.getAccessToken] main-process closure returning the revealed
   *        access token (or null). Never a plain token on the options object.
   * @param {Function} [options.getPhoneNumberId] main-process closure returning the
   *        configured phone-number id (or null) - the sending account identity.
   * @param {number} [options.timeoutMs]
   */
  constructor({ transport = null, getAccessToken = null, getPhoneNumberId = null, timeoutMs = 15000 } = {}) {
    super();
    this._transport = typeof transport === 'function' ? transport : defaultTransport;
    this._getAccessToken = typeof getAccessToken === 'function' ? getAccessToken : null;
    this._getPhoneNumberId = typeof getPhoneNumberId === 'function' ? getPhoneNumberId : null;
    this._timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15000;
  }

  get id() { return PROVIDER_ID; }
  /** F20's interlock: this adapter DOES reach a real WhatsApp service, so it opts in. */
  get live() { return true; }

  /**
   * The ONLY method that can touch the outside world. It receives the complete,
   * already-validated command from the send boundary and performs no decision of its own.
   * @returns {Promise<{messageId: string, status: 'queued'}>} acceptance only - never
   *          delivered/read/clicked.
   */
  async send(message) {
    // Credential, resolved at send time through the main-process closure. No token is
    // ever read from the message, the configuration snapshot or a plain field.
    if (!this._getAccessToken) throw transportError(WHATSAPP_TRANSPORT_ERRORS.CREDENTIAL_MISSING);
    let token = null;
    try { token = this._getAccessToken(); } catch { token = null; }
    if (typeof token !== 'string' || token.length === 0) {
      throw transportError(WHATSAPP_TRANSPORT_ERRORS.CREDENTIAL_MISSING);
    }

    // The sending account identity, also resolved through a closure. The id is checked
    // against a digits-only shape before it enters a URL path segment, so a malformed
    // value can never redirect or inject into the request target.
    if (!this._getPhoneNumberId) throw transportError(WHATSAPP_TRANSPORT_ERRORS.ACCOUNT_MISSING);
    let phoneNumberId = null;
    try { phoneNumberId = this._getPhoneNumberId(); } catch { phoneNumberId = null; }
    if (typeof phoneNumberId !== 'string' || !/^\d{1,64}$/.test(phoneNumberId)) {
      throw transportError(WHATSAPP_TRANSPORT_ERRORS.ACCOUNT_MISSING);
    }

    // The EXACT approved body, submitted unchanged. The recipient is the command's own
    // `to`; the sending number is identified by the configured phone-number id above.
    // No template, no formatting pass, no content decision happens here.
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: message.to,
      type: 'text',
      text: { preview_url: false, body: message.body },
    };

    // The stable send key rides with the request as a correlation header only. The Cloud
    // API defines no provider-level idempotency key, so de-duplication remains exactly
    // what it already is: the upstream ZTech send ledger, which gates this call.
    const sendKey = message.headers && typeof message.headers['X-ZTech-Send-Key'] === 'string'
      ? message.headers['X-ZTech-Send-Key']
      : '';

    const response = await this._transport({
      url: `${ENDPOINT}/${phoneNumberId}/messages`,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(sendKey ? { 'X-ZTech-Send-Key': sendKey } : {}),
      },
      body: JSON.stringify(payload),
      timeoutMs: this._timeoutMs,
    });

    const status = response && Number(response.status);
    const body = response && response.body && typeof response.body === 'object' ? response.body : null;

    if (status >= 200 && status < 300) {
      const first = body && Array.isArray(body.messages) ? body.messages[0] : null;
      const id = first && typeof first.id === 'string' && first.id ? first.id : null;
      if (!id) throw transportError(WHATSAPP_TRANSPORT_ERRORS.BAD_RESPONSE);
      return { messageId: id, status: 'queued' };
    }

    throw this._normalizeFailure(status, body);
  }

  /** Map a non-2xx provider response to one stable ZTech code + safe factual message. */
  _normalizeFailure(status, body) {
    const err = body && body.error && typeof body.error === 'object' ? body.error : {};
    const message = typeof err.message === 'string' ? err.message.toLowerCase() : '';
    const type = typeof err.type === 'string' ? err.type.toLowerCase() : '';
    const data = err.error_data && typeof err.error_data === 'object' && typeof err.error_data.description === 'string'
      ? err.error_data.description.toLowerCase()
      : '';
    const code = err.code !== undefined && err.code !== null ? String(err.code) : '';
    const detail = `${message} ${type} ${data}`;

    if (status === 401 || status === 403) return transportError(WHATSAPP_TRANSPORT_ERRORS.AUTH_FAILED);
    if (status === 429) return transportError(WHATSAPP_TRANSPORT_ERRORS.RATE_LIMITED);
    if (status === 400 || status === 422) {
      // Most specific first: a template/window rejection is a distinct product fact with
      // its own remediation, and must not be swallowed as a generic sender/recipient
      // fault. It is reported as a FAILURE - this build has no approved template and
      // never claims one.
      if (TEMPLATE_ERROR_CODES.includes(code) || /template|24[- ]?hour|re-?engagement|session window/.test(detail)) {
        return transportError(WHATSAPP_TRANSPORT_ERRORS.TEMPLATE_REJECTED);
      }
      if (/recipient|invalid (to|parameter: to)|'to'|"to"|to number/.test(detail)) {
        return transportError(WHATSAPP_TRANSPORT_ERRORS.INVALID_RECIPIENT);
      }
      return transportError(WHATSAPP_TRANSPORT_ERRORS.INVALID_SENDER);
    }
    if (status >= 500) return transportError(WHATSAPP_TRANSPORT_ERRORS.PROVIDER_UNAVAILABLE);
    return transportError(WHATSAPP_TRANSPORT_ERRORS.BAD_RESPONSE);
  }

  // getStatus() is deliberately the BASE contract, unmodified: F24 has no delivery
  // tracking, so any message id's status is honestly "unknown" - never delivered, read or
  // seen. There is deliberately no status-polling method here; polling would be an
  // observer this build does not have.
}

module.exports = { MetaCloudWhatsAppProvider, WHATSAPP_TRANSPORT_ERRORS, defaultTransport, ENDPOINT, PROVIDER_ID };
