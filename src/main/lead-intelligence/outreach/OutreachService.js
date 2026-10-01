'use strict';

const { newId } = require('../core/ids');
const { NotFoundError, LiError, ValidationError } = require('../core/errors');
const { toLeadView } = require('../contracts/leadView');
const { generatePitch, editPitch, renderPitchText } = require('./PitchGenerator');
const { evaluateOutreachGate } = require('./OutreachGate');
const { normalizeActivityMetadata, normalizeReadyQuery } = require('../persistence/contract');

/**
 * OutreachService — pitch drafts, human approval, gate evaluation and (optional,
 * human-triggered) email hand-off. No scheduling, no batch sending, no auto-send.
 */
class OutreachService {
  constructor({ store, contexts, leadSource, freshness, config = {}, emailProvider = null, fieldMap, clock = () => new Date(), logger = null }) {
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
    // F15: used only to report that an activity row could not be written. It never
    // carries activity content, pitch text or anything from the renderer.
    this.logger = logger;
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

  /**
   * F12 Batch 2: enumerate persisted pitch drafts. Read-only.
   *
   * A thin delegation on purpose: validation, status filtering, clamping and ordering all
   * live in the repository contract (persistence/contract.js), so there is exactly one
   * definition of them. No gate is evaluated, no packet is read, no pitch is created,
   * edited, approved or deleted, and this adds no state of its own.
   *
   * @param {{limit?: number, offset?: number, status?: string|null}} [query]
   * @returns {Promise<{rows: object[], total: number, limit: number, offset: number, status: string|null}>}
   */
  async list(query) {
    return this.store.pitches.list(query);
  }

  // === F15: outreach activity ===
  //
  // Activity rows are written from EXACTLY two places in this file, and both are
  // mutation boundaries where the event is a provable fact:
  //   update()  - the pitch content actually changed on disk
  //   approve() - an approval row was actually persisted
  //
  // They are never written from a read. outreach.list, outreach.gate and the renderer
  // never call this, so refreshing the workspace, re-reading a gate or opening the app
  // cannot manufacture history.
  //
  // A failure to record activity never fails the transition that produced it: the
  // pitch was still approved, and pretending otherwise would be worse than a missing
  // history line.
  async _recordActivity(pitch, type, metadata) {
    try {
      const normalized = normalizeActivityMetadata(metadata);
      if (!normalized.ok) return null;
      return await this.store.activity.append({
        activity_id: newId('act'),
        lead_id: pitch.lead_id,
        pitch_id: pitch.pitch_id,
        activity_type: type,
        metadata: normalized.value,
        created_at: this.clock().toISOString()
      });
    } catch (err) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('[lead-intelligence] outreach activity not recorded', { type, error: err && err.message });
      }
      return null;
    }
  }

  /** Newest-first activity history. Read-only; this is what the workspace lists. */
  async activityList(query) {
    return this.store.activity.list(query);
  }

  async update({ pitchId, edits }) {
    const p = await this.get(pitchId);
    const packet = p.packet_id ? await this.store.packets.get(p.packet_id) : null;
    const next = editPitch(p, edits, packet, this.clock());
    await this.store.pitches.upsert(next);

    // F15: the content changed, so any approval made for the OLD content no longer
    // applies. That is provable here, at the mutation boundary - the approval row is
    // still stored and its hash no longer equals the new content hash. It is recorded
    // once per (approval, new hash) pair so re-editing to the same content cannot
    // manufacture duplicates.
    const approval = await this.store.approvals.latestForPitch(next.pitch_id);
    if (approval && approval.content_hash !== next.content_hash) {
      const previous = await this.store.activity.latestForPitch(next.pitch_id, 'APPROVAL_INVALIDATED');
      if (!previous || previous.metadata.contentHash !== next.content_hash) {
        await this._recordActivity(next, 'APPROVAL_INVALIDATED', {
          reason: 'The pitch changed after it was approved.',
          contentHash: next.content_hash
        });
      }
    }
    return next;
  }

  async approve({ pitchId }) {
    const p = await this.get(pitchId);
    if (p.status !== 'draft') {
      throw new ValidationError('only a clean draft can be approved', [{ path: '$.status', message: `pitch status is ${p.status}` }]);
    }
    const rec = { approval_id: newId('appr'), pitch_id: p.pitch_id, content_hash: p.content_hash, approved_by: this.operator, approved_at: this.clock().toISOString() };
    await this.store.approvals.insert(rec);
    // F15: the approval exists now, so PITCH_APPROVED is a fact.
    await this._recordActivity(p, 'PITCH_APPROVED', { approvedBy: rec.approved_by, contentHash: rec.content_hash });

    // OUTREACH_READY is only recorded when the gate genuinely allows this content right
    // now, and only when this exact content has not already been recorded as ready - so
    // a second approval of the same content adds no duplicate line. If the gate cannot
    // be evaluated here it is simply not recorded; it is never assumed.
    try {
      const verdict = await this.gate({ pitchId: p.pitch_id });
      if (verdict && verdict.decision === 'allowed') {
        const previous = await this.store.activity.latestForPitch(p.pitch_id, 'OUTREACH_READY');
        if (!previous || previous.metadata.contentHash !== p.content_hash) {
          await this._recordActivity(p, 'OUTREACH_READY', { contentHash: p.content_hash });
        }
      }
    } catch (err) {
      if (this.logger && typeof this.logger.warn === 'function') {
        this.logger.warn('[lead-intelligence] ready transition not recorded', { error: err && err.message });
      }
    }
    return rec;
  }

  // === F16: the derived Ready view ===
  //
  // Readiness is not a status, not a column and not a flag. It is exactly one thing:
  // the existing OutreachGate currently returns `allowed` for this pitch.
  //
  // How it is derived, and why the envelope has no total:
  //  - Candidates come from the EXISTING bounded pitch list contract, in its fixed
  //    `updated_at DESC, pitch_id DESC` order, so the scan position is a stable cursor and
  //    the result is deterministic for a given store.
  //  - Each candidate is evaluated by the EXISTING gate. This class never re-implements
  //    qualification, evidence, integrity, approval or freshness rules; it only asks the
  //    gate that already owns them.
  //  - A candidate whose gate cannot be read is EXCLUDED. Unknown is never Ready.
  //  - An exact row count would require gate-evaluating every persisted pitch, so no
  //    `total` is returned. The caller gets `hasMore`/`nextCursor`/`scanned` instead, which
  //    is the truth rather than a number nobody computed.
  //  - `scanLimit` bounds the work per call. A caller cannot make this evaluate an
  //    unbounded number of gates.
  //  - Nothing is written. This is a read: it records no activity and sends nothing.
  async ready(query) {
    const { cursor, limit, scanLimit } = normalizeReadyQuery(query);
    const page = await this.store.pitches.list({ limit: scanLimit, offset: cursor });
    const candidates = page && Array.isArray(page.rows) ? page.rows : [];
    const persistedTotal = page && Number.isFinite(page.total) ? page.total : candidates.length;

    const rows = [];
    let scanned = 0;
    for (const candidate of candidates) {
      // Stop before evaluating anything we would not return. This keeps `scanned`
      // equal to the work actually performed, and never skips a ready row: the next
      // call resumes at exactly this position.
      if (rows.length >= limit) break;
      scanned++;
      let verdict;
      try {
        verdict = await this.gate({ pitchId: candidate.pitch_id });
      } catch (err) {
        // An unreadable gate is not a pass. It is simply not Ready.
        continue;
      }
      if (!verdict || verdict.decision !== 'allowed') continue;
      let lead = { id: candidate.lead_id === undefined ? null : candidate.lead_id, name: null };
      try {
        // The lead identity the gate ALREADY resolved for its own check. No extra
        // enrichment is performed and no field is invented: `name` stays null when the
        // lead carries no business name.
        const ctx = await this.contexts.getContext(candidate.lead_id, { targetId: candidate.target_id ?? undefined });
        if (ctx && ctx.view && typeof ctx.view.name === 'string') lead = { ...lead, name: ctx.view.name };
      } catch (err) {
        // Keep the honest lead reference with no name.
      }
      rows.push({ pitch: candidate, gate: verdict, lead });
    }

    const nextCursor = cursor + scanned;
    const hasMore = nextCursor < persistedTotal;
    return {
      rows,
      scanned,
      cursor,
      nextCursor: hasMore ? nextCursor : null,
      hasMore,
      // No `total`: it is not known without an unbounded scan, and is not invented here.
      limit
    };
  }

  async gate({ pitchId, channel = 'email' }) {
    const pitch = await this.get(pitchId);
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const packet = pitch.packet_id ? await this.store.packets.get(pitch.packet_id) : null;
    const approval = await this.store.approvals.latestForPitch(pitch.pitch_id);
    const gate = evaluateOutreachGate({
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
    // F14: report the DELIVERY capability alongside the gate decision, so a caller can
    // say honestly whether an allowed pitch could actually be delivered.
    //
    // This adds no state and no new capability. Both booleans are read from the
    // configuration this service was constructed with: `this.email.enabled` and whether
    // an email provider was ever supplied. No provider is created, required or enabled
    // here, and no send path is added - `send()` is still refused unless both are true,
    // which in this build they never are. The gate verdict itself is returned unchanged.
    return {
      ...gate,
      delivery: {
        channel,
        emailEnabled: this.email.enabled === true,
        providerConfigured: this.emailProvider !== null && this.emailProvider !== undefined
      }
    };
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
