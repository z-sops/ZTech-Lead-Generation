'use strict';

/**
 * The optional AI model for proposal drafts.
 *
 * Off unless BOTH are set:
 *   GEMINI_API_KEY   a Google AI (Gemini API) key - from a PAID project: the
 *                    free tier may use prompts to improve Google's products,
 *                    and these prompts contain your customers' research
 *   ZTECH_LLM_MODEL  the model id, exactly as Google publishes it
 *
 * The key is held in memory, sent only to generativelanguage.googleapis.com
 * in a header, and never logged or returned.
 */

const ENDPOINT_HOST = 'generativelanguage.googleapis.com';
const TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 262144;

/** A tiny transport over the built-in fetch, fixed to the Gemini host. */
async function request({ method, url, headers, body, signal }) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.hostname !== ENDPOINT_HOST) {
    return { ok: false, error: 'refused_host' };
  }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const res = await fetch(u, { method, headers, body, signal: combined, redirect: 'error' });
    const text = await res.text();
    return { ok: true, status: res.status, body: text.slice(0, MAX_RESPONSE_BYTES) };
  } catch (err) {
    return { ok: false, error: err && err.name === 'TimeoutError' ? 'timeout' : 'network_error' };
  }
}

/**
 * @returns {{request: Function, apiKey: string, model: string}|null}
 */
function llmConfigFromEnv(env) {
  const apiKey = String(env.GEMINI_API_KEY || '').trim();
  const model = String(env.ZTECH_LLM_MODEL || '').trim();
  if (!apiKey || !model) return null;
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(model)) {
    throw new Error('ZTECH_LLM_MODEL must be a model id such as the one Google lists (letters, digits, ".", "-", "_")');
  }
  return { request, apiKey, model };
}

module.exports = { llmConfigFromEnv, request, ENDPOINT_HOST };
