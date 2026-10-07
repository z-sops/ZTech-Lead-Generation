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
  if (SAFE_ATOM.test(s) && !s.includes('=?')) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/**
 * A Subject value folded per RFC 5322 / 2047: plain short ASCII stays as is; anything else becomes
 * encoded-words of at most 75 characters (whole code points, never split), joined by CRLF + space.
 */
function foldedSubject(text) {
  const s = String(text);
  if (SAFE_ATOM.test(s) && !s.includes('=?') && s.length <= 66) return s;
  const words = [];
  let chunk = '';
  // 45 UTF-8 bytes -> a 72-char encoded-word; the first is shorter so "Subject: " + it stays <= 78.
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > (words.length ? 45 : 39)) { words.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
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
  assertSingleLine('Subject', m.subject);
  lines.push(`Subject: ${foldedSubject(m.subject)}`);
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

/**
 * The bare address of a From value, lower-cased, or null. Quoted strings and comments are removed
 * FIRST, so a display name like "\"<ceo@big.co>\" <x@evil.example>" yields x@evil.example; then the
 * LAST angle-address wins; a bare address is accepted only when it is the whole value.
 */
function parseFromAddress(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let s = value.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
  for (let i = 0; i < 5 && /\([^()]*\)/.test(s); i += 1) s = s.replace(/\([^()]*\)/g, ' ');
  const angles = [...s.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)];
  if (angles.length) return angles[angles.length - 1][1].toLowerCase();
  const bare = s.trim().match(/^([^\s<>"(),;:]+@[^\s<>"(),;:]+)$/);
  return bare ? bare[1].toLowerCase() : null;
}

/** A stable trust-event id for one Gmail message in one mailbox (idempotent intake). */
function mailboxEventId(mailboxId, gmailMessageId) {
  return 'gm_' + crypto.createHash('sha256').update(`${mailboxId}:${gmailMessageId}`).digest('hex').slice(0, 40);
}

module.exports = { buildRawMessage, toBase64Url, encodeWord, foldedSubject, displayName, parseMessageIds, parseFromAddress, mailboxEventId };
