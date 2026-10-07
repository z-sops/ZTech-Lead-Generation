'use strict';

/**
 * F26.5 relay crypto - the HMAC envelope of a trust event and the opaque recipient_ref.
 *
 * One shared secret (stored only in the main process's credential vault, never sent over IPC)
 * yields two independent keys:
 *   signKey  HMAC-SHA256 over the canonical event string; the desktop rejects any event whose
 *            signature does not match (constant-time compare).
 *   refKey   recipient_ref = 'rref_' + HMAC-SHA256(refKey, channel ':' normalized address).
 *            The relay can compute it from a webhook's address and then DISCARD the address;
 *            only the desktop keeps ref -> address (li_recipient_refs). The ref is not
 *            reversible and not guessable without the key.
 *
 * Pure: no I/O, no clock.
 */

const crypto = require('crypto');
const { normalizeAddress, RECIPIENT_REF_RE } = require('./trustContract');

const SIGNATURE_RE = /^[a-f0-9]{64}$/;
const MIN_SECRET_LENGTH = 32;

function hmac(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

/** Derive the two keys. Throws for a secret too short to be a real key. */
function deriveRelayKeys(sharedSecret) {
  if (typeof sharedSecret !== 'string' || sharedSecret.length < MIN_SECRET_LENGTH) {
    throw new TypeError('relay secret must be at least 32 characters');
  }
  return Object.freeze({
    signKey: hmac(sharedSecret, 'ztech-relay-v1 sign'),
    refKey: hmac(sharedSecret, 'ztech-relay-v1 recipient-ref'),
  });
}

function recipientRefFor(refKey, channel, address) {
  const a = normalizeAddress(channel, address);
  if (!a) return null;
  return 'rref_' + hmac(refKey, `${channel}:${a}`).toString('hex');
}

/** The exact bytes that are signed. Field order is fixed; absent ref is the empty string. */
function canonicalEvent(e) {
  return ['ztech-trust-event-v1', e.event_id, e.kind, e.channel, e.recipient_ref || '', e.received_at].join('\n');
}

function signEvent(signKey, e) {
  return hmac(signKey, canonicalEvent(e)).toString('hex');
}

function verifyEvent(signKey, e) {
  if (!e || typeof e.signature !== 'string' || !SIGNATURE_RE.test(e.signature)) return false;
  if (e.recipient_ref != null && !RECIPIENT_REF_RE.test(String(e.recipient_ref))) return false;
  const expected = Buffer.from(signEvent(signKey, e), 'hex');
  const given = Buffer.from(e.signature, 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

module.exports = { deriveRelayKeys, recipientRefFor, canonicalEvent, signEvent, verifyEvent, SIGNATURE_RE, MIN_SECRET_LENGTH };
