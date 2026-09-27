'use strict';

const { newId } = require('../core/ids');
const { NotFoundError, LiError, ValidationError } = require('../core/errors');
const { toLeadView } = require('../contracts/leadView');
const { generatePitch, editPitch, renderPitchText } = require('./PitchGenerator');
const { evaluateOutreachGate } = require('./OutreachGate');

/**
 * OutreachService — pitch drafts, human approval, gate evaluation and (optional,
 * human-triggered) email hand-off. No scheduling, no batch sending, no auto-send.
 */
class OutreachService {
  constructor({ store, contexts, leadSource, freshness, config = {}, emailProvider = null, fieldMap, clock = () => new Date() }) {
    this.store = store;
    this.contexts = contexts;
    this.leadSource = leadSource;
    this.freshness = freshness;
    this.offer = config.offer || {};
    this.gateConfig = config.outreach || {};
    this.email = { enabled: false, fromAddress: null, ...(config.email || {}) };
    this.operator = config.operatorName || 'local-user';
    this.emailProvider = emailProvider;
    this.fieldMap = fieldMap;
    this.clock = clock;
  }

  async generate({ leadId, targetId }) {
    const ctx = await this.contexts.getContext(leadId, { targetId });
    const pitch = generatePitch({ view: ctx.view, packet: ctx.packet, icpFit: ctx.icp_fit, offer: this.offer, now: this.clock(), targetId: targetId ?? null });
    await this.store.pitches.upsert(pitch);
    return pitch;
  }

  async get(pitchId) {
    const p = await this.store.pitches.get(pitchId);
    if (!p) throw new NotFoundError('Pitch', pitchId);
    return p;
  }

  async latestForLead(leadId) {
    return this.store.pitches.latestForLead(leadId);
  }

  async update({ pitchId, edits }) {
    const p = await this.get(pitchId);
    const packet = p.packet_id ? await this.store.packets.get(p.packet_id) : null;
    const next = editPitch(p, edits, packet, this.clock());
    await this.store.pitches.upsert(next);
    return next;
  }

  async approve({ pitchId }) {
    const p = await this.get(pitchId);
    if (p.status !== 'draft') {
      throw new ValidationError('only a clean draft can be approved', [{ path: '$.status', message: `pitch status is ${p.status}` }]);
    }
    const rec = { approval_id: newId('appr'), pitch_id: p.pitch_id, content_hash: p.content_hash, approved_by: this.operator, approved_at: this.clock().toISOString() };
    await this.store.approvals.insert(rec);
    return rec;
  }

  async gate({ pitchId, channel = 'email' }) {
    const pitch = await this.get(pitchId);
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const packet = pitch.packet_id ? await this.store.packets.get(pitch.packet_id) : null;
    const approval = await this.store.approvals.latestForPitch(pitch.pitch_id);
    return evaluateOutreachGate({
      view: ctx.view,
      pitch,
      packet,
      latestPacketId: ctx.packet ? ctx.packet.packet_id : null,
      icpFit: ctx.icp_fit,
      approval,
      channel,
      freshness: this.freshness,
      now: this.clock(),
      config: this.gateConfig,
    });
  }

  /**
   * Human-triggered send of ONE approved pitch. Only available when email is enabled
   * in config AND a provider is configured. Re-runs the gate right before sending.
   */
  async send({ pitchId }) {
    if (!this.email.enabled || !this.emailProvider) throw new LiError('EMAIL_DISABLED', 'Email sending is not enabled');
    const gate = await this.gate({ pitchId, channel: 'email' });
    if (gate.decision !== 'allowed') return { sent: false, gate };
    const pitch = await this.get(pitchId);
    const raw = await this.leadSource.getLead(pitch.lead_id);
    const view = toLeadView(raw, this.fieldMap);
    const message = { to: view.email, from: this.email.fromAddress, subject: pitch.subject, text: renderPitchText(pitch), headers: { 'X-ZTech-Pitch': pitch.pitch_id } };
    const v = this.emailProvider.validate(message);
    if (!v.valid) throw new ValidationError('email message is invalid', v.errors.map((e) => ({ path: `$.${e.field}`, message: e.message })));
    const r = await this.emailProvider.send(message);
    return { sent: true, messageId: r.messageId, status: r.status, gate };
  }
}

module.exports = { OutreachService };
