'use strict';

/**
 * F29 - the Reply Router contract: closed sets and the route record normalizer. Pure; no I/O.
 *
 * A route is a SUGGESTION about a verified reply. It carries ids, closed codes and times only -
 * never the subject, a snippet or a body (there is no field for any text).
 */

const { ValidationError } = require('../core/errors');

const REPLY_CATEGORIES = Object.freeze([
  'interested', 'not_interested', 'pricing_request', 'meeting_request', 'later', 'out_of_office', 'unsubscribe', 'unknown',
]);
const ROUTE_KINDS = Object.freeze(['reply', 'unsubscribe', 'away']);
const ROUTE_INPUTS = Object.freeze(['subject', 'headers']);
const ROUTE_CONFIDENCE = Object.freeze(['high', 'low']);
const RULE_ID_RE = /^[a-z][a-z0-9_]{0,39}$/;
const EVENT_ID_RE = /^[A-Za-z0-9_.:-]{8,200}$/;
const ROUTE_COLS = Object.freeze(['event_id', 'lead_id', 'mailbox_id', 'kind', 'suggested', 'rule_id', 'input', 'confidence', 'confirmed', 'confirmed_by', 'confirmed_at', 'routed_at']);

/**
 * D6: the reply review a category points to, named in words only. The review itself is recorded
 * ONLY by the human's click on the existing review buttons (TrustService.reviewReply).
 */
const SUGGESTED_REVIEW = Object.freeze({
  interested: 'interested',
  meeting_request: 'interested',
  pricing_request: 'interested',
  not_interested: 'not_interested',
  unsubscribe: 'unsubscribe',
  later: null,
  out_of_office: null,
  unknown: null,
});

const isIso = (v) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const isId = (v) => typeof v === 'string' && v.length >= 1 && v.length <= 200 && /^[A-Za-z0-9_.:-]+$/.test(v);

/** Normalize and validate one route row. Throws ValidationError on anything outside the closed sets. */
function normalizeRoute(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const v = {
    event_id: r.event_id, lead_id: r.lead_id, mailbox_id: r.mailbox_id, kind: r.kind, suggested: r.suggested,
    rule_id: r.rule_id, input: r.input, confidence: r.confidence,
    confirmed: r.confirmed == null ? null : r.confirmed,
    confirmed_by: r.confirmed_by == null ? null : r.confirmed_by,
    confirmed_at: r.confirmed_at == null ? null : r.confirmed_at,
    routed_at: r.routed_at,
  };
  const errs = [];
  if (typeof v.event_id !== 'string' || !EVENT_ID_RE.test(v.event_id)) errs.push('event_id');
  if (!isId(v.lead_id)) errs.push('lead_id');
  if (!isId(v.mailbox_id)) errs.push('mailbox_id');
  if (!ROUTE_KINDS.includes(v.kind)) errs.push('kind');
  if (!REPLY_CATEGORIES.includes(v.suggested)) errs.push('suggested');
  if (typeof v.rule_id !== 'string' || !RULE_ID_RE.test(v.rule_id)) errs.push('rule_id');
  if (!ROUTE_INPUTS.includes(v.input)) errs.push('input');
  if (!ROUTE_CONFIDENCE.includes(v.confidence)) errs.push('confidence');
  if (v.confirmed !== null && !REPLY_CATEGORIES.includes(v.confirmed)) errs.push('confirmed');
  if (v.confirmed !== null && (typeof v.confirmed_by !== 'string' || !v.confirmed_by || v.confirmed_by.length > 200 || !isIso(v.confirmed_at))) errs.push('confirmed_by');
  if (v.confirmed === null && (v.confirmed_by !== null || v.confirmed_at !== null)) errs.push('confirmed_by');
  if (!isIso(v.routed_at)) errs.push('routed_at');
  if (errs.length) throw new ValidationError('Invalid reply route', errs.map((p) => ({ path: `$.${p}`, message: 'invalid' })));
  return v;
}

module.exports = {
  REPLY_CATEGORIES, ROUTE_KINDS, ROUTE_INPUTS, ROUTE_CONFIDENCE, ROUTE_COLS, SUGGESTED_REVIEW, RULE_ID_RE, normalizeRoute,
};
