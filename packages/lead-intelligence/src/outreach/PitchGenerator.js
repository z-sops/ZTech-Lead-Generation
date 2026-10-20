'use strict';

const { newId, stableHash } = require('../core/ids');
const { provenanceList } = require('../contracts/provenance');
const { indexPacket } = require('../contracts/evidencePacket');
const { sanitizeUntrusted } = require('../agent/sanitize');

/**
 * Deterministic, evidence-backed pitch drafts. Never sent automatically.
 *
 * - Observations come ONLY from findings (severity critical/high/medium, basis
 *   standard/research) and cite finding_id + fact_ids.
 * - The value proposition and call to action are the user's own offer text from
 *   settings (config.offer). They describe ZTech's user, not the prospect, and are
 *   checked so they do not claim a prospect problem without evidence.
 * - unsupportedClaims lists every sentence that states a prospect problem, a guarantee
 *   or an outcome without evidence. A draft with unsupported claims cannot pass the
 *   Outreach Gate.
 */

const PROBLEM_CLAIM = /\byour\b[^.?!]{0,80}\b(is|are|has|have|isn't|aren't|lacks?|missing|broken|slow|losing|outdated|poor|bad|invisible|failing|hurting|behind|weak|terrible|not\s+ranking|not\s+showing)\b/i;
const PROHIBITED_CLAIM = /\b(guarantee[sd]?|#1|number\s+one|first\s+page\s+of\s+google|double\s+your|triple\s+your|10x|100%|risk[-\s]free|you\s+are\s+losing|you're\s+losing)\b/i;

const MAX = { subject: 150, opening: 600, valueProposition: 1200, callToAction: 400, observation: 500 };

function sentences(text) {
  return String(text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * @returns {{field: string, text: string, reason: string}[]}
 */
function detectUnsupportedClaims(draft, packet) {
  const out = [];
  const idx = packet ? indexPacket(packet) : null;
  const checkFree = (field, text) => {
    for (const s of sentences(text)) {
      if (PROHIBITED_CLAIM.test(s)) out.push({ field, text: s, reason: 'PROHIBITED_CLAIM' });
      else if (PROBLEM_CLAIM.test(s)) out.push({ field, text: s, reason: 'PROBLEM_CLAIM_WITHOUT_EVIDENCE' });
    }
  };
  checkFree('subject', draft.subject);
  checkFree('opening', draft.opening);
  checkFree('valueProposition', draft.valueProposition);
  checkFree('callToAction', draft.callToAction);
  (draft.observations || []).forEach((o, i) => {
    const refs = Array.isArray(o.refs) ? o.refs : [];
    if (!refs.length || !idx || !refs.every((r) => idx.hasRef(r))) {
      out.push({ field: `observations[${i}]`, text: String(o.text || '').slice(0, 300), reason: 'OBSERVATION_WITHOUT_EVIDENCE' });
    } else if (PROHIBITED_CLAIM.test(o.text || '')) {
      out.push({ field: `observations[${i}]`, text: String(o.text || '').slice(0, 300), reason: 'PROHIBITED_CLAIM' });
    }
  });
  return out;
}

function contentHash(d) {
  return stableHash(d.subject, d.opening, (d.observations || []).map((o) => [o.text, o.refs]), d.valueProposition, d.callToAction);
}

function statusFor(d) {
  if (!d.packet_id || d.research_status === 'failed') return 'insufficient_evidence';
  if (d.unsupportedClaims.length) return 'needs_revision';
  if (!d.observations.length) return 'insufficient_evidence';
  return 'draft';
}

function finalize(d) {
  d.unsupportedClaims = detectUnsupportedClaims(d, d._packet);
  d.status = statusFor(d);
  d.content_hash = contentHash(d);
  delete d._packet;
  return d;
}

/**
 * @param {{view: object, packet: object|null, icpFit?: object|null, offer: object, now?: Date, targetId?: string|null}} input
 */
function generatePitch({ view, packet, icpFit = null, offer = {}, now = new Date(), targetId = null }) {
  const nowIso = now.toISOString();
  const observations = [];
  if (packet && packet.research_status !== 'failed') {
    const eligible = [...packet.findings]
      .filter((g) => ['critical', 'high', 'medium'].includes(g.severity) && ['standard', 'research'].includes(g.basis))
      .sort((a, b) => ['critical', 'high', 'medium'].indexOf(a.severity) - ['critical', 'high', 'medium'].indexOf(b.severity));
    for (const g of eligible) {
      if (observations.length >= 3) break;
      const t = sanitizeUntrusted(g.title, 200);
      const o = sanitizeUntrusted(g.observed, 300);
      if (t.flagged || o.flagged) continue;
      const refs = [g.finding_id, ...g.fact_ids];
      observations.push({ text: o.text ? `${t.text} — ${o.text}` : t.text, refs, provenance: provenanceList(packet, refs) });
    }
  }
  const nameRes = sanitizeUntrusted(view.name || '', 120);
  const name = nameRes.flagged ? '' : nameRes.text;
  const domain = packet ? packet.audited_domain || packet.requested_domain : null;
  const sender = sanitizeUntrusted(offer.sender_name || '', 80).text;
  const company = sanitizeUntrusted(offer.sender_company || '', 120).text;

  const subject = domain ? `A few notes on ${domain}` : `Introduction${company ? ` from ${company}` : ''}`;
  const greeting = name ? `Hi ${name} team,` : 'Hello,';
  const intro = domain
    ? `${greeting} I'm ${sender || 'writing'}${company ? ` from ${company}` : ''}. I reviewed a website audit of ${domain} captured on ${packet.captured_at.slice(0, 10)}, and noted the points below.`
    : `${greeting} I'm ${sender || 'writing'}${company ? ` from ${company}` : ''}.`;

  const allRefs = [...new Set(observations.flatMap((o) => o.refs))];
  const d = {
    pitch_id: newId('pitch'),
    lead_id: view.id,
    packet_id: packet ? packet.packet_id : null,
    research_status: packet ? packet.research_status : null,
    target_id: targetId,
    icp_fit_status: icpFit ? icpFit.fitStatus : null,
    subject: subject.slice(0, MAX.subject),
    opening: intro.slice(0, MAX.opening),
    observations,
    valueProposition: String(offer.value_proposition || '').slice(0, MAX.valueProposition),
    callToAction: String(offer.call_to_action || 'Would a short call next week be useful to go through these points?').slice(0, MAX.callToAction),
    evidenceReferences: packet ? provenanceList(packet, allRefs) : [],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: '',
    created_at: nowIso,
    updated_at: nowIso,
    _packet: packet,
  };
  return finalize(d);
}

/**
 * F28: a deterministic follow-up draft for step `stepNo` (1-3) of a sequence started by `first`
 * (the first email's pitch, unchanged since it was sent). It carries the SAME evidence link
 * (packet) and ONE of the first email's evidence-backed observations, so it passes the same
 * Outreach Gate checks as any pitch. The subject is the first email's subject: the threaded send
 * adds "Re: " (D4); it is never editable. Nothing here claims anything about the prospect.
 */
const FOLLOWUP_OPENINGS = Object.freeze([
  (g, about, date) => `${g} I'm following up on my note${date ? ` from ${date}` : ''} about ${about}.`,
  (g, about) => `${g} a short follow-up on ${about}, in case my earlier emails were missed.`,
  (g, about) => `${g} a last note on ${about}. I won't write about it again unless you reply.`,
]);

function generateFollowUp({ first, packet, view, stepNo, sequenceId, firstSentAt = null, now = new Date() }) {
  if (!first || !Number.isInteger(stepNo) || stepNo < 1 || stepNo > FOLLOWUP_OPENINGS.length) throw new TypeError('generateFollowUp: first pitch and step 1-3 are required');
  const nowIso = now.toISOString();
  const nameRes = sanitizeUntrusted((view && view.name) || '', 120);
  const name = nameRes.flagged ? '' : nameRes.text;
  const greeting = name ? `Hi ${name} team,` : 'Hello,';
  const domain = packet ? packet.audited_domain || packet.requested_domain : null;
  const about = domain || 'my earlier email';
  const date = typeof firstSentAt === 'string' ? firstSentAt.slice(0, 10) : null;
  const observations = (first.observations || []).slice(0, 1).map((o) => ({ ...o, refs: [...(o.refs || [])] }));
  const allRefs = [...new Set(observations.flatMap((o) => o.refs))];
  const d = {
    pitch_id: newId('pitch'),
    kind: 'followup',
    sequence_id: sequenceId,
    step_no: stepNo,
    parent_pitch_id: first.pitch_id,
    lead_id: first.lead_id,
    packet_id: first.packet_id,
    research_status: first.research_status ?? (packet ? packet.research_status : null),
    target_id: first.target_id ?? null,
    icp_fit_status: first.icp_fit_status ?? null,
    subject: String(first.subject).slice(0, MAX.subject),
    opening: FOLLOWUP_OPENINGS[stepNo - 1](greeting, about, date).slice(0, MAX.opening),
    observations,
    valueProposition: '',
    callToAction: String(first.callToAction || '').slice(0, MAX.callToAction),
    evidenceReferences: packet ? provenanceList(packet, allRefs) : [],
    unsupportedClaims: [],
    status: 'draft',
    content_hash: '',
    created_at: nowIso,
    updated_at: nowIso,
    _packet: packet,
  };
  return finalize(d);
}

/** Apply user edits to text fields and re-check. Observations are not editable (evidence). */
function editPitch(pitch, edits, packet, now = new Date()) {
  const d = { ...pitch, observations: pitch.observations.map((o) => ({ ...o })) };
  for (const k of ['subject', 'opening', 'valueProposition', 'callToAction']) {
    if (edits[k] !== undefined) d[k] = String(edits[k]).slice(0, MAX[k]);
  }
  if (Array.isArray(edits.removeObservations)) {
    const drop = new Set(edits.removeObservations);
    d.observations = d.observations.filter((_, i) => !drop.has(i));
    d.evidenceReferences = packet ? provenanceList(packet, [...new Set(d.observations.flatMap((o) => o.refs))]) : [];
  }
  d.updated_at = now.toISOString();
  d._packet = packet;
  return finalize(d);
}

/** Plain-text email body from a pitch. */
function renderPitchText(p) {
  const lines = [p.opening, ''];
  for (const o of p.observations) lines.push(`- ${o.text}`);
  if (p.observations.length) lines.push('');
  if (p.valueProposition) lines.push(p.valueProposition, '');
  lines.push(p.callToAction);
  return lines.join('\n');
}

module.exports = { generatePitch, generateFollowUp, editPitch, detectUnsupportedClaims, renderPitchText, contentHash, PROBLEM_CLAIM, PROHIBITED_CLAIM };
