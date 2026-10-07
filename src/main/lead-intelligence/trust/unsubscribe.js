'use strict';

/**
 * F26.5 unsubscribe handling - the footer and the RFC 2369 / RFC 8058 headers.
 *
 * ON ZTECH'S OWN TRANSPORT (Resend today) every email carries:
 *   - a footer with the business name, the postal address and a way to opt out;
 *   - List-Unsubscribe: <mailto:{the sender's own reply mailbox}?subject=unsubscribe>, plus
 *     the one-click HTTPS link <https://{relay}/u/{recipient_ref}> once a relay is configured;
 *   - List-Unsubscribe-Post: List-Unsubscribe=One-Click - ONLY with the HTTPS link, because
 *     RFC 8058 defines one-click for an HTTPS URI and a mailto alone cannot honour it.
 *
 * ON A MAIL-APP HANDOFF ZTech supplies the same footer in the body, but it cannot make the
 * person's own mail app send custom headers. That limit is stated, never papered over.
 *
 * Until the relay exists, an emailed "unsubscribe" lands in the sender's own inbox, and the
 * person records it with "Mark unsubscribed" (a suppression, applied at once). Resend's AUP
 * requires opt-outs within 7 days; Gmail and Yahoo expect 2 days for bulk senders.
 *
 * Pure: no I/O. Nothing here is invented - a missing company or address is simply absent,
 * and the send boundary refuses to send without them (SENDER_IDENTITY_INCOMPLETE).
 */

const { EMAIL } = require('../contracts/leadView');

const UNSUBSCRIBE_LIMITS = Object.freeze({ URL_MAX: 300, HEADER_MAX: 700 });
const ONE_CLICK_VALUE = 'List-Unsubscribe=One-Click';
const HTTPS_LINK = /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/u\/rref_[a-f0-9]{32,64}$/;

const HANDOFF_HEADER_NOTE = 'Your mail app sends this message, so ZTech cannot add the unsubscribe headers. The footer below still gives the contact a way to opt out.';

function oneLine(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join(', ');
}

/** The opt-out footer. `oneClickUrl` is included only when a relay link exists. */
function complianceFooter({ company, postalAddress, oneClickUrl = null } = {}) {
  const lines = ['--'];
  const c = oneLine(company);
  const a = oneLine(postalAddress);
  if (c) lines.push(c);
  if (a) lines.push(a);
  lines.push("Don't want emails from us? Reply \"unsubscribe\" and we will not contact you again.");
  if (oneClickUrl && HTTPS_LINK.test(oneClickUrl)) lines.push(`Or unsubscribe in one click: ${oneClickUrl}`);
  return lines.join('\n');
}

/** Body + footer, separated by one blank line. */
function withFooter(body, footer) {
  return `${String(body).replace(/\s+$/, '')}\n\n${footer}`;
}

/**
 * The unsubscribe headers for ZTech's own transport, or null when no valid mailbox exists.
 * @param {{mailbox: string, oneClickUrl?: string|null}} input
 */
function unsubscribeHeaders({ mailbox, oneClickUrl = null } = {}) {
  const box = typeof mailbox === 'string' ? mailbox.trim() : '';
  if (!EMAIL.test(box)) return null;
  const parts = [];
  const https = oneClickUrl && HTTPS_LINK.test(oneClickUrl) ? oneClickUrl : null;
  if (https) parts.push(`<${https}>`);
  parts.push(`<mailto:${box}?subject=unsubscribe>`);
  const headers = { 'List-Unsubscribe': parts.join(', ') };
  if (https) headers['List-Unsubscribe-Post'] = ONE_CLICK_VALUE;
  return headers;
}

/** Validator used by the email provider contract for exactly these two headers. */
function isValidUnsubscribeHeader(name, value) {
  if (typeof value !== 'string' || /[\r\n]/.test(value)) return false;
  if (name === 'List-Unsubscribe-Post') return value === ONE_CLICK_VALUE;
  if (name !== 'List-Unsubscribe' || value.length > UNSUBSCRIBE_LIMITS.HEADER_MAX) return false;
  const items = value.split(/,\s*/);
  if (items.length < 1 || items.length > 2) return false;
  return items.every((item) => {
    const m = item.match(/^<(.+)>$/);
    if (!m) return false;
    if (m[1].startsWith('mailto:')) return /^mailto:[^\s<>?]+\?subject=unsubscribe$/.test(m[1]) && EMAIL.test(m[1].slice(7, m[1].indexOf('?')));
    return HTTPS_LINK.test(m[1]);
  });
}

/**
 * A mailto: URL for the handoff. Every part is percent-encoded, so no header can be injected.
 * Long bodies can be cut off by some mail apps, which `tooLongForMailto` reports honestly.
 */
function mailtoUrl({ to, subject, body }) {
  const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  return { url, tooLongForMailto: url.length > 1900 };
}

module.exports = {
  complianceFooter, withFooter, unsubscribeHeaders, isValidUnsubscribeHeader, mailtoUrl,
  HANDOFF_HEADER_NOTE, ONE_CLICK_VALUE, UNSUBSCRIBE_LIMITS, HTTPS_LINK,
};
