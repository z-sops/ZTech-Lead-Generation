'use strict';

const { contentHash, detectUnsupportedClaims } = require('./PitchGenerator');
const { EMAIL } = require('../contracts/leadView');

/**
 * OutreachGate — every check must pass before any outreach. Returns reasons for each
 * failed check. It never sends anything.
 *
 * Checks:
 *   LEAD_IDENTITY       lead has a name
 *   CONTACT_FIELD       channel contact exists (email for "email")
 *   QUALIFICATION       lead qualification status is in config.allowedQualification
 *   ICP_FIT             not "not_fit" (unknown is a warning, blocked if config.requireIcpFit)
 *   EVIDENCE_PRESENT    pitch was built from a packet, and it is the latest packet
 *   EVIDENCE_FRESH      packet is within freshness policy
 *   EVIDENCE_COMPLETE   packet status complete (partial only if config.allowPartialEvidence)
 *   PROHIBITED_CLAIMS   no unsupported/prohibited claims (re-checked here)
 *   PITCH_INTEGRITY     stored content hash matches content
 *   HUMAN_APPROVAL      an approval exists for this exact content hash
 */
const DEFAULTS = Object.freeze({
  allowedQualification: ['qualified'],
  allowPartialEvidence: false,
  requireIcpFit: false,
});

function evaluateOutreachGate({ view, pitch, packet, latestPacketId, icpFit = null, approval = null, channel = 'email', freshness, now = new Date(), config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const reasons = [];
  const warnings = [];
  const block = (code, message) => reasons.push({ code, message });

  if (!view || !view.name) block('LEAD_IDENTITY', 'The lead has no business name.');

  if (channel === 'email') {
    if (!view || !view.email || !EMAIL.test(view.email)) block('CONTACT_FIELD', 'The lead has no valid email address.');
  } else {
    block('CHANNEL_NOT_SUPPORTED', `Outreach channel "${channel}" is not supported yet.`);
  }

  const q = view ? view.qualification_status : null;
  if (!q) block('QUALIFICATION', 'The lead has no qualification status recorded.');
  else if (!cfg.allowedQualification.map((x) => x.toLowerCase()).includes(q)) block('QUALIFICATION', `Qualification "${q}" is not allowed for outreach.`);

  if (icpFit && icpFit.fitStatus === 'not_fit') block('ICP_FIT', `The lead does not fit the selected ICP: ${icpFit.reason}`);
  else if (icpFit && icpFit.fitStatus === 'unknown') {
    if (cfg.requireIcpFit) block('ICP_FIT', 'ICP fit is unknown.');
    else warnings.push({ code: 'ICP_FIT_UNKNOWN', message: 'ICP fit could not be fully evaluated.' });
  } else if (!icpFit && cfg.requireIcpFit) block('ICP_FIT', 'No ICP was evaluated for this lead.');

  if (!pitch) {
    block('PITCH_MISSING', 'No pitch draft exists.');
  } else {
    if (!packet || !pitch.packet_id || pitch.packet_id !== packet.packet_id) {
      block('EVIDENCE_PRESENT', 'The pitch is not linked to stored research evidence.');
    } else {
      if (latestPacketId && latestPacketId !== packet.packet_id) block('EVIDENCE_OUTDATED', 'Newer research exists; regenerate the pitch.');
      if (!freshness.isFresh(packet, now)) block('EVIDENCE_FRESH', `Research evidence from ${packet.captured_at.slice(0, 10)} is stale; run research again.`);
      if (packet.research_status === 'failed') block('EVIDENCE_COMPLETE', 'The latest research failed.');
      else if (packet.research_status === 'partial' && !cfg.allowPartialEvidence) block('EVIDENCE_COMPLETE', 'Research is partial; complete research is required for outreach.');
      else if (packet.research_status === 'partial') warnings.push({ code: 'EVIDENCE_PARTIAL', message: 'Research is partial.' });
    }

    const claims = detectUnsupportedClaims(pitch, packet);
    if (claims.length) block('PROHIBITED_CLAIMS', `${claims.length} unsupported or prohibited claim(s) must be removed.`);
    if (!pitch.observations || !pitch.observations.length) block('EVIDENCE_PRESENT', 'The pitch has no evidence-backed observations.');

    const hash = contentHash(pitch);
    if (hash !== pitch.content_hash) block('PITCH_INTEGRITY', 'The pitch content does not match its stored hash.');
    if (!approval) block('HUMAN_APPROVAL', 'A person must approve this pitch before outreach.');
    else if (approval.content_hash !== hash) block('HUMAN_APPROVAL', 'The pitch changed after it was approved; approve it again.');
  }

  return {
    decision: reasons.length ? 'blocked' : 'allowed',
    reasons,
    warnings,
    channel,
    pitch_id: pitch ? pitch.pitch_id : null,
    packet_id: packet ? packet.packet_id : null,
    checkedAt: now.toISOString(),
  };
}

module.exports = { evaluateOutreachGate, GATE_DEFAULTS: DEFAULTS };
