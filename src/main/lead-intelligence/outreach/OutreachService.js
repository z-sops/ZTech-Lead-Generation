'use strict';

const { newId } = require('../core/ids');
const { NotFoundError, LiError, ValidationError } = require('../core/errors');
const { EMAIL } = require('../contracts/leadView');
const { normalizeFieldValue } = require('../enrichment/catalog');
const { generatePitch, editPitch, renderPitchText } = require('./PitchGenerator');
const { evaluateOutreachGate } = require('./OutreachGate');
const { normalizeActivityMetadata, normalizeReadyQuery, sendIdempotencyKey } = require('../persistence/contract');
const { evaluateSendCapability } = require('./email/sendConfig');

// === F17: factual contact facts for the derived Ready row ===
//
// These helpers report only what the canonical lead view ALREADY asserts, and they run
// through the EXISTING normalisers rather than re-implementing validation:
//   - email validity  : leadView.EMAIL, the same regex the Outreach Gate itself uses to
//                       decide CONTACT_FIELD, so this can never disagree with the gate.
//   - present-vs-invalid: leadView keeps `email_raw_present` for exactly this case, so a
//                       malformed stored email stays distinguishable from no email.
//   - phone / website : catalog.normalizeFieldValue - the same normalisers the enrichment
//                       catalog uses (INVALID_PHONE / INVALID_DOMAIN_*).
//
// WHAT THIS DELIBERATELY DOES NOT DO
//  - It does NOT classify a number as mobile or landline. AccountStore stores ONE `phone`
//    column with no mobile/landline field and no line-type evidence, so such a claim
//    would be an invention. Mobile-vs-landline is a labelled UI heuristic and stays in the
//    renderer, where the existing isMobileNumber() already lives.
//  - It does NOT claim anything about WhatsApp, registration, provider configuration or
//    deliverability. There is no verifier in this build, so none of that is knowable.
//  - It creates, persists and changes nothing. Pure read model.
//
// READINESS vs CONTACTABILITY vs DELIVERY are three separate facts. Readiness is the gate
// verdict alone. Contactability is what is written here. Delivery capability is the
// `delivery` block the gate already reports. None of them can influence another.
//
// THE REAL PRODUCT CHAIN, which this read model reports but may never alter:
//   ready() -> this.gate() -> OutreachGate -> channel "email" -> a valid email address is
//   required (CONTACT_FIELD) -> decision "allowed" -> the row is decorated with contact
//   facts.
// So in practice every row returned here carries a valid email. That is the GATE's rule,
// not this read model's: a lead with no (or a malformed) email is excluded upstream of the
// decoration below, and no contact fact is ever consulted while selecting a row.

/** { present, valid, value } for one already-validated lead-view string. */
function contactFact(rawValue, isValid) {
  const present = typeof rawValue === 'string' && rawValue.trim().length > 0;
  if (!present) return { present: false, valid: null, value: null };
  const valid = isValid === true;
  // A rejected value is never re-surfaced: the caller gets the FLAG, not the bad string,
  // because leadView already refused to accept it as a contact value.
  return { present: true, valid, value: valid ? rawValue : null };
}

/** Run the existing catalog normaliser; it already returns { ok } for us. */
function catalogAccepts(field, value) {
  try {
    return normalizeFieldValue(field, value).ok === true;
  } catch (err) {
    return false;
  }
}

/**
 * The factual contact/channel read model for ONE lead view. Pure: no store access, no
 * network, no provider lookup.
 *
 * In practice every view reaching here belongs to an ALREADY-ALLOWED row, so under the
 * current email gate `email.state` is "available". The "missing" / "invalid" states are
 * DEFENSIVE reporting for a malformed or unexpected payload - they are not reachable
 * product states today, and nothing here may be changed to make them reachable (that would
 * mean weakening the gate).
 *
 * @param {object} view           a leadView (the gate already resolved one)
 * @param {boolean} rawEmailPresent leadView's `email_raw_present`
 */
function contactFactsFromView(view, rawEmailPresent) {
  const v = view && typeof view === 'object' ? view : {};
  const emailValid = typeof v.email === 'string' && EMAIL.test(v.email.trim());
  const email = contactFact(v.email, emailValid);
  // When leadView rejected the stored email but knows one was there, this is INVALID and
  // not MISSING - that distinction already exists in the view, and is only carried through.
  const emailState = !email.present
    ? (rawEmailPresent === true ? 'invalid' : 'missing')
    : (email.valid === true ? 'available' : 'invalid');
  const phone = contactFact(v.phone, catalogAccepts('company.phone', v.phone));
  const website = contactFact(v.website, catalogAccepts('company.website', v.website));
  return {
    contacts: {
      email: { ...email, state: emailState },
      phone,
      website
    },
    channels: {
      // "available" means ONLY: a syntactically valid contact email exists. It does NOT
      // mean a provider is configured, that sending is enabled, or that it is deliverable.
      email: { state: emailState, contact: email.valid === true ? email.value : null, providerConfigured: null },
      // Conservative by construction. A phone is at most a CANDIDATE. With no verifier in
      // this build `verified` can never be true and WhatsApp has no `available` state.
      whatsapp: {
        state: phone.valid === true ? 'candidate' : 'missing',
        contact: phone.valid === true ? phone.value : null,
        verified: false,
        verifiedSource: null
      }
    }
  };
}

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
      let contact = null;
      try {
        // The lead identity the gate ALREADY resolved for its own check. No extra
        // enrichment is performed and no field is invented: `name` stays null when the
        // lead carries no business name.
        const ctx = await this.contexts.getContext(candidate.lead_id, { targetId: candidate.target_id ?? undefined });
        if (ctx && ctx.view) {
          if (typeof ctx.view.name === 'string') lead = { ...lead, name: ctx.view.name };
          // F17: the SAME resolved view yields the factual contact facts. This is a
          // widening of a view we already read, not a second AccountStore lookup, and it
          // cannot affect readiness - `verdict.decision === 'allowed'` above already
          // decided this row, before any contact data was consulted.
          contact = contactFactsFromView(ctx.view, ctx.view.email_raw_present);
        }
      } catch (err) {
        // Keep the honest lead reference with no name.
      }
      rows.push(contact ? { pitch: candidate, gate: verdict, lead, ...contact } : { pitch: candidate, gate: verdict, lead });
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
    // F19 sharpened this. It used to report `providerConfigured: this.emailProvider !== null`,
    // which was true even for a simulated test provider and so overstated readiness. It now
    // delegates to the SAME evaluateSendCapability() the send boundary itself uses, so the
    // block can never disagree with whether a send would actually be permitted. `canSend` is
    // the one flag a renderer should gate a send control on; `code`/`message` say exactly
    // which configuration gap is responsible.
    //
    // This still adds no state and no capability: the verdict is pure configuration, no
    // provider is created or contacted, and the gate decision itself is returned unchanged.
    const capability = evaluateSendCapability({
      enabled: this.email.enabled,
      provider: this.emailProvider,
      fromAddress: this.email.fromAddress
    });
    return {
      ...gate,
      delivery: {
        channel,
        emailEnabled: this.email.enabled === true,
        providerConfigured: this.emailProvider !== null && this.emailProvider !== undefined,
        // F19: honest send capability.
        canSend: capability.canSend,
        blockedCode: capability.code,
        blockedMessage: capability.message,
        providerId: capability.providerId,
        providerLive: capability.providerLive,
        // Never claimed here, and never derivable from a gate verdict.
        deliveryStatus: 'unknown',
        openStatus: 'unknown',
        clickStatus: 'unknown'
      }
    };
  }

  // === F18: outreach preparation (review only — nothing is sent) ===
  //
  // Preparation is a DERIVED PREVIEW for ONE already-ready pitch. It is not a state, not a
  // column and not a write: it reuses exactly three things that already exist and adds
  // nothing.
  //   - the EXISTING gate verdict, re-evaluated right now by this.gate() on the same
  //     channel the Ready queue uses. A pitch the gate no longer allows cannot be
  //     prepared, whatever its contacts look like - contact data can never manufacture
  //     access, only narrow it.
  //   - the EXISTING F17 contact facts (contactFactsFromView - the same read model the
  //     Ready rows carry). No second AccountStore lookup: the view comes from the same
  //     contexts.getContext the gate already resolves.
  //   - the EXISTING canonical pitch text (PitchGenerator.renderPitchText) - the same
  //     transformation the disabled send path uses. Nothing new is composed here.
  //
  // READINESS vs PREPARATION CHANNEL - two separate decisions, always in this order:
  //   1. READINESS: this.gate({ pitchId }) evaluates the EXISTING OutreachGate on its
  //      default channel ("email"). OutreachGate is the only readiness decider in this
  //      build and is NOT redesigned or re-parameterised here: WhatsApp contact
  //      availability has no vote in it, cannot create an allowed verdict, and cannot
  //      weaken any of its checks.
  //   2. CHANNEL: only AFTER the verdict is "allowed" does preparation consult the F17
  //      contact facts to ask whether the requested contact channel exists. Contact data
  //      can only NARROW what preparation offers - never widen what the gate allows.
  // A WhatsApp candidate can therefore be prepared only for a pitch that is already Ready
  // under the product's readiness contract, and `readiness` below is that same
  // email-channel gate verdict carried verbatim - never a WhatsApp-derived readiness.
  //
  // The returned shape is CHANNEL-NEUTRAL on purpose, so a later email adapter, WhatsApp
  // adapter or MCP surface can consume it without redesigning the Ready queue or F17:
  //   { leadId, pitchId, channel, leadName, recipient, content, readiness, contactFacts }
  // `recipient` IS the F17 channel object, verbatim. For WhatsApp that means
  // { state: 'candidate', contact, verified: false, verifiedSource: null }: preparation
  // never upgrades a stored phone into a verified or available WhatsApp number.
  //
  // This method writes nothing, sends nothing, schedules nothing and records no activity.
  // The only errors it raises itself are honest refusals: NOT_READY when the gate does
  // not currently allow the pitch, CHANNEL_UNAVAILABLE when the chosen channel has no
  // valid contact point, CONTACT_FACTS_UNAVAILABLE when the context resolves without a
  // usable view, and VALIDATION_FAILED for an unknown channel. A genuine internal
  // failure in a store read is never converted into one of those - it propagates as
  // itself, so the caller is never told a working pipeline "has no contact facts".
  async prepare({ pitchId, channel }) {
    if (channel !== 'email' && channel !== 'whatsapp') {
      throw new ValidationError('unknown preparation channel', [{ path: '$.channel', message: 'channel must be "email" or "whatsapp"' }]);
    }
    const pitch = await this.get(pitchId);
    // Readiness is re-checked by the EXISTING gate, exactly as the Ready queue checked
    // it. A blocked pitch cannot reach preparation even with perfect contact data.
    const verdict = await this.gate({ pitchId });
    if (!verdict || verdict.decision !== 'allowed') {
      throw new LiError('NOT_READY', 'Only a pitch the Outreach Gate currently allows can be prepared.');
    }
    // The context read is deliberately NOT wrapped in a swallowing catch. The gate just
    // resolved the SAME context successfully, so a failure here is a genuine internal
    // failure (a store error, a lead that vanished between the two reads, a programming
    // error) and it must surface as itself: NotFoundError, the store's typed error, or an
    // unknown error the IPC boundary already renders as INTERNAL_ERROR. Masking it as
    // "no contact facts" would fabricate a wrong, reassuring refusal.
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    let facts = null;
    let leadName = null;
    if (ctx && ctx.view) {
      // The SAME resolved view the gate used - no extra enrichment, no second lookup.
      if (typeof ctx.view.name === 'string') leadName = ctx.view.name;
      facts = contactFactsFromView(ctx.view, ctx.view.email_raw_present);
    }
    if (!facts) {
      // Expected absence ONLY: the context resolved but carries no usable view. A context
      // read FAILURE never reaches this line (see above). Nothing is logged here, so no
      // contact value can ever reach a log through preparation.
      throw new LiError('CONTACT_FACTS_UNAVAILABLE', 'The stored contact facts for this lead could not be read.');
    }
    const recipient = facts.channels[channel];
    const available = channel === 'email'
      ? facts.channels.email.state === 'available'
      : facts.channels.whatsapp.state === 'candidate';
    if (!available) {
      // Honest, specific refusals. A channel is never simulated and never downgraded to
      // a maybe: without a valid contact point there is nothing to prepare.
      const reason = channel === 'email'
        ? (facts.contacts.email.state === 'invalid'
          ? 'The stored email address is not a valid address.'
          : 'No valid email address is stored for this lead.')
        : (facts.contacts.phone.present === true
          ? 'The stored phone number is not a valid number.'
          : 'No phone number is stored for this lead.');
      throw new LiError('CHANNEL_UNAVAILABLE', reason);
    }
    return {
      leadId: pitch.lead_id,
      pitchId: pitch.pitch_id,
      channel,
      // The business name the gate's own view already carries, or null. Read-only
      // convenience so consumers never need a second lookup; never invented.
      leadName: leadName,
      // The F17 channel shape, verbatim. providerConfigured stays null for email: no
      // provider configuration is claimed. WhatsApp stays candidate/unverified.
      recipient,
      // The existing canonical pitch text. For email this IS the body. For WhatsApp no
      // transformation exists in this build, so the same text is the message SOURCE and
      // transformationNote says so plainly.
      content: {
        subject: pitch.subject,
        body: renderPitchText(pitch),
        bodySource: 'renderPitchText',
        evidenceReferences: Array.isArray(pitch.evidenceReferences) ? pitch.evidenceReferences : [],
        transformationNote: channel === 'whatsapp'
          ? 'No WhatsApp-specific message transformation exists in this build. The canonical pitch text is shown unchanged as the message source.'
          : null
      },
      // The same verdict the Ready queue reports, carried verbatim. Preparation never
      // re-decides readiness and can never influence it.
      readiness: verdict,
      contactFacts: facts
    };
  }

  /**
   * Human-triggered send of ONE approved pitch. Only available when email is enabled
   * in config AND a provider is configured. Re-runs the gate right before sending.
   *
   * F19 SUPERSEDES THIS METHOD. It is retained only as a deprecated alias for
   * sendEmail() so any pre-F19 caller keeps working, and it is deliberately thin: the real
   * boundary, with the gate re-check, idempotency, the durable attempt record and the
   * honest acknowledgement-only result, is sendEmail(). New code must call that.
   *
   * @deprecated use sendEmail()
   */
  async send({ pitchId }) {
    return this.sendEmail({ pitchId });
  }

  // === F19: the email send boundary ===
  //
  // This is the ONE place in the product where an outbound message is authorised. It is
  // human-triggered and single-message: there is no batch, no queue, no scheduler, no retry
  // loop and no auto-send anywhere in this method or its callees.
  //
  // THE ORDER OF THE STEPS IS THE SAFETY PROPERTY, and it is not incidental:
  //   1. capability   - can this product send AT ALL? (enabled, live provider, from-address)
  //   2. pitch        - does it exist?
  //   3. GATE RE-CHECK- re-run the EXISTING OutreachGate immediately before sending. This is
  //                     the same gate the Ready queue and F18 preparation used, re-evaluated
  //                     at the last possible moment, so evidence that expired, an approval
  //                     that was invalidated, or an edit made while the panel sat open all
  //                     block the send. A pitch being Ready ten minutes ago proves nothing.
  //   4. idempotency  - has THIS EXACT content already been accepted? If so, replay the
  //                     recorded outcome and contact nobody. Same content = same key,
  //                     derived from the content hash, never from a timestamp or counter.
  //   5. recipient    - re-read from the stored contact facts, never from the caller.
  //   6. validate     - the provider's own message validation, before any provider contact.
  //   7. RECORD       - persist an 'attempted' send row and an OUTREACH_SEND_ATTEMPTED
  //                     activity BEFORE calling the provider. If the process dies mid-call,
  //                     the ledger still proves the provider was reached, instead of
  //                     silently losing a real-world side effect.
  //   8. provider     - the only call that can touch the outside world.
  //   9. settle       - 'accepted' or 'failed', each with its own activity event.
  //
  // WHAT THE RESULT IS ALLOWED TO SAY. A provider returning a message id proves it accepted
  // the message. It does NOT prove the message arrived, was opened, or was clicked, and this
  // build observes no inbox. So the result reports `providerAcknowledged: true` alongside
  // explicit `deliveryStatus / openStatus / clickStatus: 'unknown'`. Those three are the
  // string 'unknown' and never false: "not delivered" is itself a claim ZTech cannot make.
  // There is no `delivered: false` anywhere in this method, because there is no observer
  // that could support it.
  async sendEmail({ pitchId }) {
    // (1) Capability. Refused before anything is read or written beyond the refusal itself.
    const capability = this.sendCapability();
    if (!capability.canSend) {
      // A disabled or unconfigured provider is a refusal a human asked for and did not get,
      // so it IS an event worth recording. It records no provider id and no message id,
      // because no provider was contacted.
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: capability.message, channel: 'email' });
      throw new LiError(capability.code, capability.message);
    }

    // (2) Existence. A missing pitch is not a gate decision, so it is not recorded as one.
    const pitch = await this.get(pitchId);

    // (3) THE RE-CHECK. Same gate, same channel, same rules as every other readiness path.
    const verdict = await this.gate({ pitchId, channel: 'email' });
    if (!verdict || verdict.decision !== 'allowed') {
      const first = verdict && Array.isArray(verdict.reasons) && verdict.reasons.length ? verdict.reasons[0] : null;
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: first ? first.message : 'The Outreach Gate does not allow this pitch right now.',
        channel: 'email',
        contentHash: pitch.content_hash
      });
      throw new LiError('NOT_READY', 'The Outreach Gate does not allow this pitch right now.');
    }

    // (4) IDEMPOTENCY, checked against the content that was just gate-approved. A replay
    // contacts nobody: it returns the recorded provider outcome and says so.
    const idempotencyKey = sendIdempotencyKey({ channel: 'email', pitchId: pitch.pitch_id, contentHash: pitch.content_hash });
    const already = await this.store.sends.findAccepted(idempotencyKey);
    if (already) return this._sendResult({ pitch, outcome: 'replayed', send: already, gate: verdict });

    // (5) Recipient from the STORED contact facts. The caller cannot supply one: the IPC
    // schema admits only { pitchId }.
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const facts = ctx && ctx.view ? contactFactsFromView(ctx.view, ctx.view.email_raw_present) : null;
    if (!facts || facts.channels.email.state !== 'available' || !facts.channels.email.contact) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: 'No valid email address is stored for this lead.',
        channel: 'email',
        contentHash: pitch.content_hash
      });
      throw new LiError('CHANNEL_UNAVAILABLE', 'No valid email address is stored for this lead.');
    }

    // (6) Provider validation, before any provider contact.
    const message = {
      to: facts.channels.email.contact,
      from: capability.fromAddress,
      subject: pitch.subject,
      text: renderPitchText(pitch),
      headers: {
        'X-ZTech-Pitch': pitch.pitch_id,
        // The idempotency key travels WITH the message, so a provider that supports
        // de-duplication can recognise a retry ZTech itself would treat as a replay.
        'X-ZTech-Send-Key': idempotencyKey
      }
    };
    const valid = this.emailProvider.validate(message);
    if (!valid || valid.valid !== true) {
      const detail = Array.isArray(valid && valid.errors) && valid.errors.length ? valid.errors[0].message : 'the message is invalid';
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: `The email message did not validate: ${detail}`,
        channel: 'email',
        contentHash: pitch.content_hash
      });
      throw new ValidationError('email message is invalid',
        (valid && valid.errors ? valid.errors : []).map((e) => ({ path: `$.${e.field}`, message: e.message })));
    }

    // (7) THE DURABLE ATTEMPT, written BEFORE the provider is touched.
    const sendId = newId('send');
    const now = this.clock().toISOString();
    await this.store.sends.record({
      send_id: sendId,
      lead_id: pitch.lead_id,
      pitch_id: pitch.pitch_id,
      channel: 'email',
      content_hash: pitch.content_hash,
      idempotency_key: idempotencyKey,
      state: 'attempted',
      provider_id: capability.providerId,
      created_at: now,
      updated_at: now
    });
    await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ATTEMPTED', {
      channel: 'email',
      contentHash: pitch.content_hash,
      providerId: capability.providerId,
      idempotencyKey
    });

    // (8) The only call that can reach the outside world.
    let receipt;
    try {
      receipt = await this.emailProvider.send(message);
    } catch (err) {
      // (9a) Failure. Record ZTech's own code and a ZTech-authored message; the provider's
      // own text is deliberately NOT copied into the row, a log or the renderer.
      const at = this.clock().toISOString();
      const code = err && err.code ? String(err.code) : 'EMAIL_SEND_FAILED';
      const safe = err instanceof LiError ? err.message : 'The email provider could not accept the message.';
      await this.store.sends.fail({ sendId, failureCode: code, failureMessage: safe, at });
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_FAILED', {
        channel: 'email', contentHash: pitch.content_hash, providerId: capability.providerId,
        idempotencyKey, failureCode: code, reason: safe
      });
      if (err instanceof LiError) throw err;
      throw new LiError(code, safe);
    }

    // (9b) Acknowledgement. Recorded as ACCEPTED - never as delivered, opened or clicked.
    const at = this.clock().toISOString();
    const settled = await this.store.sends.accept({
      sendId,
      providerId: capability.providerId,
      providerMessageId: receipt && receipt.messageId ? String(receipt.messageId) : null,
      at
    });
    const winner = settled && settled.ok === false ? settled.row : await this.store.sends.get(sendId);
    if (settled && settled.ok === false) {
      // A concurrent send won this key. Report the winner's outcome rather than pretending
      // this attempt was the one that got through.
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ACCEPTED', {
        channel: 'email', contentHash: pitch.content_hash, providerId: capability.providerId,
        idempotencyKey, providerMessageId: winner.provider_message_id
      });
      return this._sendResult({ pitch, outcome: 'replayed', send: winner, gate: verdict });
    }
    await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ACCEPTED', {
      channel: 'email', contentHash: pitch.content_hash, providerId: capability.providerId,
      idempotencyKey, providerMessageId: winner.provider_message_id
    });
    return this._sendResult({ pitch, outcome: 'accepted', send: winner, gate: verdict, providerStatus: receipt && receipt.status });
  }

  /**
   * The honest send result. `providerAcknowledged` is the ONLY true fact about the outside
   * world here, and the three delivery facts are explicitly 'unknown' - never false, because
   * ZTech has no observer that could support either answer.
   */
  _sendResult({ pitch, outcome, send, gate, providerStatus = null }) {
    return {
      outcome, // 'accepted' | 'replayed' - never 'delivered'
      channel: 'email',
      pitchId: pitch.pitch_id,
      leadId: pitch.lead_id,
      contentHash: pitch.content_hash,
      idempotencyKey: send.idempotency_key,
      sendId: send.send_id,
      providerId: send.provider_id,
      providerMessageId: send.provider_message_id,
      // The provider's OWN status word, passed through untranslated and un-interpreted.
      providerStatus: providerStatus === null ? null : String(providerStatus),
      // The single truthful claim about the outside world.
      providerAcknowledged: send.state === 'accepted',
      // Explicitly unknown. Not false: nothing observes an inbox, a read receipt or a
      // click, so reporting false would itself be a fabricated observation.
      deliveryStatus: 'unknown',
      openStatus: 'unknown',
      clickStatus: 'unknown',
      gate
    };
  }

  /** F19: the current, honest email-send capability verdict. Read-only, no side effects. */
  sendCapability() {
    return evaluateSendCapability({
      enabled: this.email.enabled,
      provider: this.emailProvider,
      fromAddress: this.email.fromAddress
    });
  }

  /**
   * Record one send-boundary activity event.
   *
   * Unlike _recordActivity, which requires a pitch object, this one is called at refusal
   * points where the pitch may not have been loaded yet (the capability check runs first).
   * A missing pitch simply yields no row - recording a send event for a pitch that does not
   * exist would be inventing history.
   */
  async _recordSendEvent(pitchId, type, metadata) {
    let pitch = null;
    try {
      pitch = await this.store.pitches.get(pitchId);
    } catch (err) {
      return null;
    }
    if (!pitch) return null;
    return this._recordActivity(pitch, type, metadata);
  }
}

module.exports = { OutreachService };
