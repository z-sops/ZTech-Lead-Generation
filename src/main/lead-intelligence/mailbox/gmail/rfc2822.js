'use strict';

/**
 * F26.6 - pure RFC 5322 / 2045 / 2047 helpers for the Gmail transport. No I/O.
 *
 * buildRawMessage() produces the exact message Gmail's messages.send receives (base64url of it).
 * It deliberately writes NO Message-ID: Step 1A proved Gmail replaces a client-supplied one, and
 * the canonical rule is to read back and persist the provider-STORED id instead.
 *
 * Header values reaching here were already validated by validateEmailMessage (no CR/LF, closed
 * header set). This module still refuses a line break in any header value (defence in depth).
 */

const crypto = require('crypto');

const SAFE_ATOM = /^[\x20-\x7e]*$/;

function assertSingleLine(name, value) {
  if (/[\r\n]/.test(String(value))) throw new TypeError(`header ${name} must be a single line`);
}

/** RFC 2047 encoded-word when the text is not plain printable ASCII. */
function encodeWord(text) {
  const s = String(text);
  if (SAFE_ATOM.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** A display name for From:, quoted (ASCII) or encoded (non-ASCII). */
function displayName(name) {
  const s = String(name).trim();
  if (!s) return '';
  if (!SAFE_ATOM.test(s)) return encodeWord(s);
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function base64Lines(text) {
  const b64 = Buffer.from(String(text), 'utf8').toString('base64');
  return b64.match(/.{1,76}/g) || [''];
}

/**
 * @param {{from: string, fromName?: string, to: string, subject: string, text: string,
 *          headers?: Record<string,string>, date?: Date, boundaryId?: string}} m
 * @returns {string} the raw message, CRLF line endings
 */
function buildRawMessage(m) {
  const lines = [];
  const add = (name, value) => { assertSingleLine(name, value); lines.push(`${name}: ${value}`); };
  const name = m.fromName ? displayName(m.fromName) : '';
  add('From', name ? `${name} <${m.from}>` : m.from);
  add('To', m.to);
  add('Subject', encodeWord(m.subject));
  add('Date', (m.date instanceof Date ? m.date : new Date()).toUTCString().replace('GMT', '+0000'));
  for (const [k, v] of Object.entries(m.headers || {})) {
    if (/^message-id$/i.test(k)) throw new TypeError('a Message-ID is never supplied: Gmail stores its own');
    add(k, v);
  }
  add('MIME-Version', '1.0');
  add('Content-Type', 'text/plain; charset=UTF-8');
  add('Content-Transfer-Encoding', 'base64');
  return `${lines.join('\r\n')}\r\n\r\n${base64Lines(m.text).join('\r\n')}\r\n`;
}

const toBase64Url = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Every <msg-id> token in an In-Reply-To / References value (bounded). */
function parseMessageIds(value, max = 50) {
  if (typeof value !== 'string') return [];
  return (value.match(/<[^<>\s]{3,298}>/g) || []).slice(-max);
}

/** The bare address of a From value ("Name <a@b>" or "a@b"), lower-cased, or null. */
function parseFromAddress(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/<([^<>\s]+@[^<>\s]+)>/) || value.match(/([^\s<>"]+@[^\s<>"]+)/);
  return m ? m[1].toLowerCase() : null;
}

/** A stable trust-event id for one Gmail message in one mailbox (idempotent intake). */
function mailboxEventId(mailboxId, gmailMessageId) {
  return 'gm_' + crypto.createHash('sha256').update(`${mailboxId}:${gmailMessageId}`).digest('hex').slice(0, 40);
}

module.exports = { buildRawMessage, toBase64Url, encodeWord, displayName, parseMessageIds, parseFromAddress, mailboxEventId };
