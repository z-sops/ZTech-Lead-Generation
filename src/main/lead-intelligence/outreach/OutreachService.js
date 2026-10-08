'use strict';

const { newId } = require('../core/ids');
const { NotFoundError, LiError, ValidationError } = require('../core/errors');
const { EMAIL, toE164 } = require('../contracts/leadView');
const { normalizeFieldValue } = require('../enrichment/catalog');
const { generatePitch, editPitch, renderPitchText } = require('./PitchGenerator');
const { evaluateOutreachGate } = require('./OutreachGate');
const { normalizeActivityMetadata, normalizeReadyQuery, normalizeSendQuery, sendIdempotencyKey } = require('../persistence/contract');
const { evaluateSendCapability } = require('./email/sendConfig');
const { evaluateResendCapability } = require('./email/resendConfig');
const { evaluateSendCapability: evalWhatsAppCapability } = require('./whatsapp/sendConfig');
// F24: the WhatsApp provider CONFIGURATION resolver - the same main-process-only,
// read-only layer as evaluateResendCapability above, imported for the same purpose
// (_deliveryBlock's channel-specific configuration override).
const { evaluateWhatsAppConfig } = require('./whatsapp/whatsappConfig');
const { WhatsAppProvider } = require('./whatsapp/WhatsAppProvider');
// F26.5: the trust checks of the send boundary (suppression, identity, transport, lint, consent).
const { TrustPolicy } = require('../trust/TrustPolicy');
const { complianceFooter, withFooter, unsubscribeHeaders, mailtoUrl, HANDOFF_HEADER_NOTE } = require('../trust/unsubscribe');
const { normalizeEmail } = require('../trust/trustContract');

// F26.5: the person's own mail app, as a "transport". It is not Resend, so Resend's rule does not
// apply; and ZTech cannot make it carry headers, which the handoff result states plainly.
const HANDOFF_TRANSPORT = Object.freeze({ transportPolicy: Object.freeze({ requiresPriorRelationship: false, enforcesUnsubscribeHeaders: false }) });
const HANDOFF_KINDS = Object.freeze(['mailto', 'copy']);

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
  constructor({ store, contexts, leadSource, freshness, config = {}, emailProvider = null, emailConfigStore = undefined, whatsappConfigStore = undefined, fieldMap, clock = () => new Date(), logger = null, openExternal = null }) {
    this.store = store;
    this.contexts = contexts;
    this.leadSource = leadSource;
    this.freshness = freshness;
    this.offer = config.offer || {};
    this.gateConfig = config.outreach || {};
    this.email = { enabled: false, fromAddress: null, ...(config.email || {}) };
    // F20: WhatsApp send config. Same shape as email: enabled + fromNumber + provider.
    this.whatsapp = { enabled: false, fromNumber: null, ...(config.whatsapp || {}) };
    this.operator = config.operatorName || 'local-user';
    this.emailProvider = emailProvider;
    // F22: the provider CONFIGURATION source, injected by the main process. It is
    // deliberately optional: a process that is not the Electron main process (a unit test,
    // a script) has no configuration source, and "no configuration source" is reported as
    // "not configured" rather than being papered over with a default.
    //
    // `undefined` means "resolve lazily" so constructing the service never reaches for
    // electron; `null` means "this process has no configuration source".
    this._emailConfigStoreInput = emailConfigStore;
    this._emailConfigStoreResolved = false;
    this._emailConfigStoreValue = null;
    // F24: the WhatsApp provider CONFIGURATION source, injected by the main process under
    // its own name. It is the same kind of optional, read-only source as the email one and
    // resolves by the same rule: `undefined` = lazy resolution (a unit test or script
    // never reaches for electron), `null` = "this process has no configuration source".
    // It is a SEPARATE injection point so a test can give WhatsApp configuration without
    // implying email configuration, and vice versa.
    this._whatsappConfigStoreInput = whatsappConfigStore;
    this._whatsappConfigStoreResolved = false;
    this._whatsappConfigStoreValue = null;
    this.fieldMap = fieldMap;
    this.clock = clock;
    // F15: used only to report that an activity row could not be written. It never
    // carries activity content, pitch text or anything from the renderer.
    this.logger = logger;
    // F26.5: the trust checks. They need the trust repositories of migration 008; a store
    // without them cannot prove anything, so every send then FAILS CLOSED (TRUST_UNAVAILABLE).
    this.trust = store && store.suppressions && store.consents && store.trustEvents
      ? new TrustPolicy({ store, clock })
      : null;
    // F26.5: opens a mailto: URL in the person's own mail app (main process: shell.openExternal).
    // Absent in tests and non-Electron processes, where a 'mailto' handoff is refused honestly.
    this.openExternal = typeof openExternal === 'function' ? openExternal : null;
    // F26.5: the relay link source ({ linkFor(channel, address) -> {url, recipientRef} | null }).
    // Null until a relay is configured (F26.5b); then emails gain the one-click HTTPS link.
    this.relayLinks = null;
  }

  /** F26.5: inject the relay link source once a relay is configured. Pure HMAC, no I/O. */
  setRelayLinks(links) {
    this.relayLinks = links && typeof links.linkFor === 'function' ? links : null;
  }

  /** The one-click unsubscribe link for an address, or null. Pure: writes nothing. */
  _oneClickFor(address) {
    if (!this.relayLinks) return null;
    try {
      const link = this.relayLinks.linkFor('email', address);
      return link && typeof link.url === 'string' ? link : null;
    } catch {
      return null;
    }
  }

  /** Persist the ref -> address mapping for a link that is about to leave ZTech. */
  async _rememberRef(link, address) {
    if (!link || !this.store.recipientRefs) return;
    await this.store.recipientRefs.ensure({ recipient_ref: link.recipientRef, channel: 'email', normalized_address: address, created_at: this.clock().toISOString() });
  }

  /**
   * F26.5: run the trust checks for one send and, on refusal, record ONE OUTREACH_SEND_BLOCKED
   * row (with the stable code, never the address) and throw. Runs after the recipient is known
   * and BEFORE the message is validated, recorded as attempted or handed to any provider.
   */
  async _enforceTrust(pitch, channel, recipient, { fromName = null, provider = null, country = null } = {}) {
    if (!this.trust) {
      const message = 'The do-not-contact and consent records cannot be read, so nothing is sent.';
      await this._recordSendEvent(pitch.pitch_id, 'OUTREACH_SEND_BLOCKED', { reason: message, channel, contentHash: pitch.content_hash, blockedCode: 'TRUST_UNAVAILABLE' });
      throw new LiError('TRUST_UNAVAILABLE', message);
    }
    const verdict = await this.trust.evaluate({ channel, recipient, offer: this.offer, sender: { fromName }, subject: pitch.subject, provider, country });
    if (verdict.allowed) return verdict;
    await this._recordSendEvent(pitch.pitch_id, 'OUTREACH_SEND_BLOCKED', { reason: verdict.message, channel, contentHash: pitch.content_hash, blockedCode: verdict.code });
    throw new LiError(verdict.code, verdict.message);
  }

  /**
   * F26.5: the read-only trust preview Prepare shows beside readiness and delivery. It carries
   * verdicts and dates only - never the normalized address, a recipient_ref or a hash.
   */
  async _trustPreview(pitch, channel, recipient, country = null) {
    // The transport's declared policy is read here (a getter, never a call that reaches out),
    // so Prepare itself names no provider.
    const provider = channel === 'email' ? this.emailProvider : this.whatsappProvider;
    const fromName = channel === 'email' ? this._senderProfile().displayName : null;
    if (!this.trust) return { allowed: false, code: 'TRUST_UNAVAILABLE', message: 'The do-not-contact and consent records cannot be read.', suppressed: null, consent: null, verifiedReply: false, sessionOpenUntil: null, market: null, handoffAvailable: false };
    const v = await this.trust.evaluate({ channel, recipient, offer: this.offer, sender: { fromName }, subject: pitch.subject, provider, country });
    const f = v.facts || {};
    return {
      allowed: v.allowed === true,
      code: v.allowed ? null : v.code,
      message: v.allowed ? null : v.message,
      suppressed: Boolean(f.suppression),
      consent: f.consent ? { method: f.consent.method, consentedAt: f.consent.consented_at, recordedBy: f.consent.recorded_by } : null,
      verifiedReply: Boolean(f.reply),
      // F26.6 follow-up: a mailbox reply waiting for its human review (a reply is not permission).
      replyReviewPending: Boolean(f.replyReviewPending),
      sessionOpenUntil: f.sessionOpenUntil || null,
      // F26.6: the market rule this email is judged by (country code + rule; never the address).
      market: f.market ? { countryCode: f.market.countryCode || null, rule: f.market.rule, reviewed: f.market.reviewed === true } : null,
      // A mail-app handoff is offered only for email, and never to a suppressed contact.
      // F26.6: nor where the market gate would refuse it (no consent, no verified reply and no
      // reviewed opt-out rule for the lead's country).
      handoffAvailable: channel === 'email' && Boolean(f.address) && !f.suppression
        && Boolean(f.consent || f.reply || (f.market && f.market.rule === 'opt_out_allowed')),
    };
  }

  // F20: allow the WhatsApp provider to be injected after construction, mirroring
  // the emailProvider pattern (passed at construct time).
  setWhatsAppProvider(provider) {
    if (!(provider instanceof WhatsAppProvider)) throw new TypeError('provider must be a WhatsAppProvider');
    this.whatsappProvider = provider;
  }


  async generate({ leadId, targetId }) {
    const ctx = await this.contexts.getContext(leadId, { targetId });
    const pitch = generatePitch({ view: ctx.view, packet: ctx.packet, icpFit: ctx.icp_fit, offer: this.offer, now: this.clock(), targetId: targetId ?? null });
    await this.store.pitches.upsert(pitch);
    return pitch;
  }

  /**
   * Acceptance fix (8 Oct 2026): rebuild a pitch draft from the lead's latest stored research, IN
   * PLACE (same pitch_id). A draft written before research finished (no evidence) or before newer
   * research arrived (EVIDENCE_OUTDATED) is otherwise stuck. In place on purpose: the stale text no
   * longer exists anywhere, so it can never be approved or sent by mistake.
   *
   * Refused - nothing changes - for:
   *   a follow-up step (F28 drafts belong to their sequence);
   *   a pitch with any recorded send attempt (attempted / accepted / failed: it is history);
   *   a pitch approved for its CURRENT content whose evidence is still the latest research (an
   *     approved pitch is never rewritten without reason). When newer research exists the gate
   *     already blocks it (EVIDENCE_OUTDATED), and an explicit Regenerate withdraws the approval.
   * Every earlier approval of the pitch is withdrawn and recorded (APPROVAL_INVALIDATED): a
   * regenerated draft ALWAYS needs a fresh human approval, even if its text equals content approved
   * before. Approval and send state are checked again right before the write, so an approve or a
   * send that lands while the draft is being rebuilt makes it refuse instead of overwriting.
   */
  async regenerate({ pitchId }) {
    const p = await this._pitchById(pitchId);
    if (!p) throw new NotFoundError('Pitch', pitchId);
    if (p.kind === 'followup') throw new LiError('PITCH_REGENERATE_FOLLOWUP', 'A follow-up is written from its first email and cannot be regenerated here.');
    await this._regenerateAllowed(p, null);
    const ctx = await this.contexts.getContext(p.lead_id, { targetId: p.target_id ?? undefined });
    const fresh = generatePitch({ view: ctx.view, packet: ctx.packet, icpFit: ctx.icp_fit, offer: this.offer, now: this.clock(), targetId: p.target_id ?? null });
    const next = { ...fresh, pitch_id: p.pitch_id, created_at: p.created_at };
    // Re-check against what is stored NOW. The awaits between this check and the writes are store
    // calls only, and the production store persists synchronously (accountStore.saveDB), so no IPC
    // handler runs in between. If persistence ever becomes truly async, this needs a per-pitch lock.
    // An approve that still lands later approves the OLD hash, which the new content does not match.
    const current = await this.store.pitches.get(p.pitch_id);
    if (!current || current.content_hash !== p.content_hash) throw new LiError('PITCH_CHANGED', 'The pitch changed while it was being rebuilt. Look at it, then regenerate again.');
    const approval = await this._regenerateAllowed(current, ctx.packet);
    if (approval) await this.store.approvals.deleteForPitches([p.pitch_id]);
    await this.store.pitches.upsert(next);
    if (approval) await this._recordActivity(next, 'APPROVAL_INVALIDATED', { reason: 'The pitch was regenerated from the latest research.', contentHash: next.content_hash });
    return next;
  }

  /** Throws when `p` may not be regenerated; returns its latest approval (or null). */
  async _regenerateAllowed(p, latestPacket) {
    for (let offset = 0; ; offset += 50) {
      const page = await this.store.sends.list({ pitchId: p.pitch_id, limit: 50, offset });
      const rows = page.rows || [];
      if (rows.some((r) => r.state !== 'blocked')) {
        throw new LiError('PITCH_ALREADY_SENT', 'This pitch was already sent (or a send was attempted), so it is kept as it is.');
      }
      if (rows.length < 50) break;
    }
    const approval = await this.store.approvals.latestForPitch(p.pitch_id);
    if (approval && approval.content_hash === p.content_hash) {
      // Approved for this exact content: only newer research (EVIDENCE_OUTDATED) is a reason to
      // rebuild it. Before the research is read, `latestPacket` is null and the stored packet is
      // looked up instead.
      const latest = latestPacket || (await this.store.packets.latestForLead(p.lead_id));
      if (!latest || latest.packet_id === p.packet_id) {
        throw new LiError('PITCH_APPROVED', 'This pitch is approved and its research is current, so it is not rewritten.');
      }
    }
    return approval;
  }

  async get(pitchId) {
    const p = await this._pitchById(pitchId);
    if (!p) throw new NotFoundError('Pitch', pitchId);
    return p;
  }

  /**
   * F28: a pitch is either an ordinary draft (li_pitch_drafts) or a follow-up step's draft
   * (li_sequence_steps). Follow-ups never appear in the pitch list, the Ready queue or a lead's
   * latest pitch; they are reachable by id only, for edit / approve / their sequence's send.
   */
  async _pitchById(pitchId) {
    const p = await this.store.pitches.get(pitchId);
    if (p) return p;
    if (!this.store.sequences) return null;
    const step = await this.store.sequences.stepByPitch(pitchId);
    return step && step.draft ? step.draft : null;
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


  /**
   * F26 (D2) - live-apply Settings. Replaces ONLY the three values the constructor
   * already accepts from configuration (email/whatsapp enable + sender, and the business
   * profile used as the pitch offer), so a Settings save takes effect without a restart.
   * It changes no send logic: the providers, the gate, approval, idempotency and both
   * send boundaries are untouched, and every send still re-checks the capability verdict.
   * An omitted part keeps its current value.
   */
  reconfigure({ email, whatsapp, offer } = {}) {
    if (email !== undefined) this.email = { enabled: false, fromAddress: null, ...(email && typeof email === 'object' ? email : {}) };
    if (whatsapp !== undefined) this.whatsapp = { enabled: false, fromNumber: null, ...(whatsapp && typeof whatsapp === 'object' ? whatsapp : {}) };
    if (offer !== undefined) this.offer = offer && typeof offer === 'object' ? offer : {};
  }

  /**
   * F22: the provider CONFIGURATION source, resolved lazily and at most once.
   *
   * `emailConfigStore` was injected by the main process if there is one. If it was not
   * injected, this asks electron for one - but ONLY when it is actually running inside
   * Electron's main process. A plain Node process (a unit test, a script) has no
   * configuration source and gets `null`, which the parser reports as "not configured".
   *
   * It is never written to. It is read by `readResendConfig` and nothing else.
   */
  emailConfigStore() {
    if (this._emailConfigStoreResolved) return this._emailConfigStoreValue;
    this._emailConfigStoreResolved = true;
    if (this._emailConfigStoreInput !== undefined) {
      this._emailConfigStoreValue = this._emailConfigStoreInput;
      return this._emailConfigStoreValue;
    }
    try {
      const electron = require('electron');
      if (!electron || typeof electron !== 'object' || !electron.app) {
        this._emailConfigStoreValue = null;
      } else {
        const Store = require('electron-store');
        this._emailConfigStoreValue = new Store();
      }
    } catch {
      this._emailConfigStoreValue = null;
    }
    return this._emailConfigStoreValue;
  }

  /**
   * F24: the provider CONFIGURATION source for WhatsApp, resolved lazily and at most
   * once, by exactly the same rule as `emailConfigStore()` above. It is never written to.
   * It is read by `readWhatsAppConfig` and nothing else.
   */
  whatsappConfigStore() {
    if (this._whatsappConfigStoreResolved) return this._whatsappConfigStoreValue;
    this._whatsappConfigStoreResolved = true;
    if (this._whatsappConfigStoreInput !== undefined) {
      this._whatsappConfigStoreValue = this._whatsappConfigStoreInput;
      return this._whatsappConfigStoreValue;
    }
    try {
      const electron = require('electron');
      if (!electron || typeof electron !== 'object' || !electron.app) {
        this._whatsappConfigStoreValue = null;
      } else {
        const Store = require('electron-store');
        this._whatsappConfigStoreValue = new Store();
      }
    } catch {
      this._whatsappConfigStoreValue = null;
    }
    return this._whatsappConfigStoreValue;
  }

  /**
   * F24: the parsed WhatsApp provider configuration for this process, or `null` when this
   * process has no configuration source at all. A read and nothing else.
   */
  _whatsappProviderConfiguration() {
    const store = this.whatsappConfigStore();
    if (!store) return null;
    const { readWhatsAppConfig } = require('./whatsapp/whatsappConfig');
    return readWhatsAppConfig(store);
  }

  /**
   * F22: the parsed provider configuration for this process, or `null` when this process
   * has no configuration source at all. A read and nothing else.
   */
  _emailProviderConfiguration() {
    const store = this.emailConfigStore();
    if (!store) return null;
    const { readResendConfig } = require('./email/resendConfig');
    return readResendConfig(store);
  }

  /**
   * F22: read-only provider configuration status (the bounded read model).
   *
   * The chain is exactly: configuration source -> safe parser -> capability resolver ->
   * this object. Nothing here executes anything: no network call, no provider is
   * constructed, nothing is written and no activity is recorded. It answers only:
   * which provider, are the three structural facts configured, is the domain verified,
   * and what is the resolver's single stable factual reason.
   *
   * SECRETS NEVER LEAVE THE CONFIGURATION BOUNDARY. The API key is read only to answer
   * "is one stored?" and "can it be read back?", and is discarded immediately, so this
   * object carries two booleans and never a key, a token, an Authorization header or the
   * configuration record it came from. The IPC boundary scrubs it once more on the way
   * out; the booleans are named `keyConfigured`/`keyReadable` precisely because that scrub
   * drops any key matching /credential/i as a last line of defence, and this payload
   * leans on that control instead of fighting it. The same fact also arrives as
   * `capability.code`, which is a value rather than a key and is never scrubbed.
   *
   * NOTHING IS CLAIMED THAT THE CONFIGURATION DOES NOT SAY. An absent domain reads back
   * as not configured and `unknown`, never as verified; no sender mailbox and no domain
   * is assumed to exist.
   */
  async getEmailProviderStatus() {
    const { readResendConfig, evaluateResendCapability } = require('./email/resendConfig');
    const config = readResendConfig(this.emailConfigStore());
    const capability = evaluateResendCapability(config);
    return {
      providerId: config.providerId,
      providerDisplay: config.providerDisplay,
      providerSelected: config.providerSelected,
      keyConfigured: config.keyConfigured,
      keyReadable: config.keyReadable,
      senderConfigured: config.senderConfigured,
      fromName: config.fromName || null,
      fromAddress: config.fromAddress || null,
      replyTo: config.replyTo || null,
      signature: config.signature || null,
      domainConfigured: config.domainConfigured,
      domain: config.domain || null,
      domainVerification: config.domainVerification,
      capability
    };
  }

  /**
   * F24: read-only WHATSAPP provider configuration status (the bounded read model),
   * mirroring getEmailProviderStatus() exactly.
   *
   * The chain is exactly: configuration source -> safe parser -> capability resolver ->
   * this object. Nothing here executes anything: no network call, no provider is
   * constructed, nothing is written and no activity is recorded. It answers only: which
   * provider, are the structural facts configured (credential presence, connected account,
   * sending number), what the number-verification status is, and what the resolver's
   * single stable factual reason is.
   *
   * SECRETS NEVER LEAVE THE CONFIGURATION BOUNDARY. The access token is read only to
   * answer "is one stored?" and "can it be read back?", and is discarded immediately, so
   * this object carries two booleans and never a token, an Authorization header or the
   * configuration record it came from. The IPC boundary scrubs it once more on the way
   * out; the booleans are named `keyConfigured`/`keyReadable` precisely because that scrub
   * drops any key matching /credential|token|bearer/i as a last line of defence. The same
   * fact also arrives as `capability.code`, which is a value rather than a key and is
   * never scrubbed.
   *
   * NOTHING IS CLAIMED THAT THE CONFIGURATION DOES NOT SAY. An absent account reads back
   * as not configured; an absent or unverified sending number reads back as `unknown`,
   * never as verified; and none of this says anything about any lead's phone number -
   * that is a separate, stored candidate and is never read here.
   */
  async getWhatsAppProviderStatus() {
    const { readWhatsAppConfig, evaluateWhatsAppConfig } = require('./whatsapp/whatsappConfig');
    const config = readWhatsAppConfig(this.whatsappConfigStore());
    const capability = evaluateWhatsAppConfig(config);
    return {
      providerId: config.providerId,
      providerDisplay: config.providerDisplay,
      providerSelected: config.providerSelected,
      keyConfigured: config.keyConfigured,
      keyReadable: config.keyReadable,
      accountConfigured: config.accountConfigured,
      senderConfigured: config.senderConfigured,
      fromNumber: config.fromNumber || null,
      numberVerification: config.numberVerification,
      capability
    };
  }

  /** Newest-first activity history. Read-only; this is what the workspace lists. */
  async activityList(query) {
    return this.store.activity.list(query);
  }

  /**
   * F23 PLUG & PLAY: the bounded, non-secret sender identity for the email channel.
   *
   * Every field is read from the customer's own configuration source. Nothing here is
   * hard-coded - no company name, no address, no domain - so an installation that has not
   * configured a sender reads back as `configured: false` with null fields, which is an
   * honest supported state rather than a missing feature. The API key is never part of
   * this object; capability carries its own `keyConfigured`/`keyReadable` booleans.
   */
  _senderProfile() {
    const { readResendConfig } = require('./email/resendConfig');
    const config = readResendConfig(this.emailConfigStore());
    return {
      providerId: config.providerId,
      providerDisplay: config.providerDisplay,
      providerSelected: config.providerSelected,
      displayName: config.fromName || null,
      fromAddress: config.fromAddress || null,
      replyTo: config.replyTo || null,
      domain: config.domain || null,
      domainVerification: config.domainVerification,
      signatureConfigured: Boolean(config.signature),
      configured: Boolean(config.providerSelected && config.senderConfigured && config.domainConfigured)
    };
  }

  /**
   * F24 PLUG & PLAY: the bounded, non-secret sender identity for the WhatsApp channel.
   *
   * Every field is read from the customer's own configuration source. Nothing here is
   * hard-coded - no provider, no number, no account - so an installation that has not
   * configured WhatsApp reads back as `configured: false` with null fields, which is an
   * honest supported state rather than a missing feature. This is OUR sending identity
   * only: it never contains, implies or reads a lead's phone number, and the stored lead
   * number stays what F17 declared it to be - a candidate.
   *
   * The access token is never part of this object; capability carries its own
   * `keyConfigured`/`keyReadable` booleans (names that survive the IPC secret scrub).
   */
  _whatsappSenderProfile() {
    const { readWhatsAppConfig, evaluateWhatsAppConfig } = require('./whatsapp/whatsappConfig');
    const config = readWhatsAppConfig(this.whatsappConfigStore());
    const capability = evaluateWhatsAppConfig(config);
    return {
      providerId: config.providerId,
      providerDisplay: config.providerDisplay,
      providerSelected: config.providerSelected,
      fromNumber: config.fromNumber || null,
      senderConfigured: config.senderConfigured,
      accountConfigured: config.accountConfigured,
      numberVerification: config.numberVerification,
      keyConfigured: config.keyConfigured,
      keyReadable: config.keyReadable,
      configured: capability.canSend === true
    };
  }

  /**
   * F23: the EXACT text the email provider will receive for this pitch.
   *
   * The canonical approved pitch body, plus the configured signature when one exists -
   * and nothing else. This single function is used by BOTH Prepare (so a human sees the
   * final bytes before confirming) and the send boundary (so the provider gets those same
   * bytes). The signature is added here, upstream of the provider: transport never edits
   * content, and the approval's content_hash still covers the canonical pitch underneath.
   */
  _emailFinalBody(pitch, { oneClickUrl = null } = {}) {
    const body = renderPitchText(pitch);
    const { readResendConfig, validateSignature } = require('./email/resendConfig');
    const check = validateSignature(readResendConfig(this.emailConfigStore()).signature);
    // A signature that fails validation is simply not appended: the payload falls back to
    // the canonical approved body rather than shipping unsafe text. Prepare and the send
    // boundary both come through this ONE function, so the bytes always match.
    const signed = check.ok && check.value ? `${body}\n\n${check.value}` : body;
    // F26.5: every email carries the opt-out footer (business name, postal address, how to
    // unsubscribe). It is added here so Prepare, the send boundary and the mail-app handoff all
    // show and send the same bytes. Nothing is invented: absent identity is simply absent, and
    // the send boundary refuses to send without it.
    const o = this.offer && typeof this.offer === 'object' ? this.offer : {};
    return withFooter(signed, complianceFooter({ company: o.sender_company, postalAddress: o.postal_address, oneClickUrl }));
  }

  /**
   * F21: newest-first send-ledger history. Read-only, and ONLY a read.
   *
   * The renderer can ask "what send attempts are recorded" with paging plus at most one
   * id filter, and nothing else: the query is clamped by the same contract normaliser the
   * store uses, so no caller can ask for the whole ledger, choose a sort, or filter by
   * provider, state or channel. It cannot write a row, mark one accepted, delete one, or
   * trigger another attempt - a further attempt must go back through the send boundary.
   *
   * Rows are projected to the renderer's own camelCase read shape. Two columns are
   * deliberately NOT projected: `content_hash` and `idempotency_key` are internal
   * integrity facts the workspace has no use for, so they never cross the boundary.
   * `retryable` is a fact about the ROW (an accepted row would be a no-op replay), not a
   * permission: it grants nothing and bypasses no check.
   */
  async sendList(query) {
    const page = await this.store.sends.list(normalizeSendQuery(query));
    return {
      rows: (page.rows || []).map((r) => ({
        sendId: r.send_id,
        leadId: r.lead_id,
        pitchId: r.pitch_id,
        channel: r.channel,
        state: r.state,
        providerId: r.provider_id === undefined ? null : r.provider_id,
        providerMessageId: r.provider_message_id === undefined ? null : r.provider_message_id,
        failureCode: r.failure_code === undefined ? null : r.failure_code,
        failureMessage: r.failure_message === undefined ? null : r.failure_message,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        retryable: r.state !== 'accepted'
      })),
      total: page.total,
      limit: page.limit,
      offset: page.offset
    };
  }

  async update({ pitchId, edits }) {
    const p = await this.get(pitchId);
    const packet = p.packet_id ? await this.store.packets.get(p.packet_id) : null;
    // F28: a follow-up keeps the first email's subject (the threaded send adds "Re: "), and a step
    // that was sent, or whose sequence ended, is history and cannot change.
    if (p.kind === 'followup' && edits && edits.subject !== undefined && String(edits.subject) !== p.subject) {
      throw new ValidationError('a follow-up keeps the first email subject', [{ path: '$.edits.subject', message: 'a follow-up is sent as a reply in the same thread, so its subject cannot change' }]);
    }
    const next = editPitch(p, edits, packet, this.clock());
    if (p.kind === 'followup') {
      if (!this.sequences) throw new LiError('SEQUENCES_UNAVAILABLE', 'Follow-ups are not available here.');
      await this.sequences.saveStepDraft(next);
    } else {
      await this.store.pitches.upsert(next);
    }

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
    // F28: approving the last unapproved step of a sequence held for approval lets it continue.
    if (p.kind === 'followup' && this.sequences) {
      try { await this.sequences.onStepApproved(p); } catch (err) {
        if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lead-intelligence] sequence approval note failed', { error: err && err.code ? err.code : 'ERROR' });
      }
    }

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

  async gate({ pitchId, channel = 'email' }, { sequenceSend = false } = {}) {
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
    // F20: the gate verdict above is returned UNCHANGED; only the `delivery` block is
    // added, and it is built by the shared _deliveryBlock() helper so gate() and prepare()
    // can never report two different capability verdicts for the same channel.
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
    // F28: a follow-up step is sent ONLY by its own activated sequence (as a reply in the first
    // email's thread). Every other path - Prepare, a human send on any channel, the mail-app
    // handoff - finds it blocked here, so it can never go out unthreaded or out of turn.
    if (pitch.kind === 'followup' && sequenceSend !== true) {
      gate.reasons.push({ code: 'FOLLOWUP_SEQUENCE_ONLY', message: 'This follow-up is sent only by its sequence, as a reply in the same thread.' });
      gate.decision = 'blocked';
    }
    return {
      ...gate,
      delivery: this._deliveryBlock(channel)
    };
  }

  /**
   * F20/F22: the ONE definition of the `delivery` block.
   *
   * `delivery` is PROVIDER CAPABILITY and is deliberately a separate fact from READINESS.
   * Readiness is the OutreachGate verdict and nothing else; this block reports whether
   * the configured provider for ONE channel could actually be contacted right now. The
   * two are carried side by side and neither can influence the other: changing provider
   * configuration can never add a lead to Ready, remove one, reorder it, change a
   * qualification, an evidence freshness or an approval - it only changes what this block
   * says.
   *
   * It is built by ONE helper so `gate()` and `prepare()` cannot disagree, it evaluates
   * pure configuration through `sendCapability()`, and it never constructs, calls or
   * contacts a provider. The three status words are always 'unknown', because nothing in
   * this build observes an inbox.
   */
  _deliveryBlock(channel) {
    let capability = this.sendCapability(channel);
    // F22: when this process HAS a provider configuration source, the configuration
    // verdict is the more specific fact, so it replaces the generic reason. That is how
    // the existing Prepare/send surface reports provider status to the operator: the
    // panel says exactly which configuration fact is missing (no key, no sender, domain
    // not verified) instead of a blanket "switched off". With no configuration source
    // - every unit test, any non-Electron process - this block is untouched.
    if (channel === 'email') {
      const config = this._emailProviderConfiguration();
      if (config) {
        const resolved = evaluateResendCapability(config);
        if (!resolved.canSend) capability = resolved;
      }
    }
    // F24: the identical override for WhatsApp. When this process HAS a WhatsApp
    // configuration source, the configuration verdict (provider selected, credential,
    // connected account, sending number, number verification) is the more specific fact,
    // so it replaces the generic reason - the panel says exactly which configuration gap
    // is responsible instead of a blanket "switched off". It only ever NARROWS: a complete
    // configuration leaves the instance verdict above untouched, and with no configuration
    // source this block is unchanged.
    if (channel === 'whatsapp') {
      const config = this._whatsappProviderConfiguration();
      if (config) {
        const resolved = evaluateWhatsAppConfig(config);
        if (!resolved.canSend) capability = resolved;
      }
    }
    return {
      channel,
      emailEnabled: channel === 'email' ? this.email.enabled === true : false,
      providerConfigured: channel === 'email' ? this.emailProvider !== null && this.emailProvider !== undefined : (this.whatsappProvider !== null && this.whatsappProvider !== undefined),
      // Honest send capability, from the SAME evaluator the send boundary itself calls.
      canSend: capability.canSend,
      blockedCode: capability.code,
      blockedMessage: capability.message,
      providerId: capability.providerId,
      providerLive: capability.providerLive,
      // Never claimed here, and never derivable from a gate verdict.
      deliveryStatus: 'unknown',
      openStatus: 'unknown',
      clickStatus: 'unknown'
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
        // F23: for email, the byte-for-byte payload the provider would receive (canonical
        // body + configured signature). Prepare shows THIS for email so what a human
        // confirms is exactly what the transport sends. WhatsApp keeps the canonical body
        // unchanged - F24 owns any future WhatsApp message shaping.
        // F26.5: with a relay, the real email carries the contact's personal one-click link. The
        // preview shows the same text with that link MASKED: its recipient_ref never reaches the
        // renderer. Without a relay there is nothing to mask and the bytes are identical.
        ...(channel === 'email' ? { finalBody: this._emailFinalBody(pitch, { oneClickUrl: (this._oneClickFor(recipient.contact) || {}).url || null }).replace(/\/u\/rref_[a-f0-9]{32,64}/g, '/u/[personal unsubscribe link]') } : {}),
        evidenceReferences: Array.isArray(pitch.evidenceReferences) ? pitch.evidenceReferences : [],
        transformationNote: channel === 'whatsapp'
          ? 'No WhatsApp-specific message transformation exists in this build. The canonical pitch text is shown unchanged as the message source.'
          : null
      },
      // The same verdict the Ready queue reports, carried verbatim. Preparation never
      // re-decides readiness and can never influence it.
      readiness: verdict,
      // F20/F22/F23: PROVIDER CAPABILITY for this tab, carried BESIDE readiness and never
      // inside it. A pitch can be Ready while this block says the provider cannot send;
      // the renderer shows both facts and conflates neither.
      delivery: this._deliveryBlock(channel),
      // F23: the non-secret sender identity for the email channel (null on WhatsApp), so
      // Prepare can show From / Reply-To / Provider without a second IPC surface.
      // F24: WhatsApp now carries ITS bounded sender profile for the same reason - the
      // panel can show provider / account / sending number / number status / credential /
      // capability / reason without a second IPC surface and without a secret.
      sender: channel === 'email'
        ? this._senderProfile()
        : (channel === 'whatsapp' ? this._whatsappSenderProfile() : null),
      contactFacts: facts,
      // F26.5: the trust verdict the send boundary WILL apply (suppression, identity, transport,
      // subject, consent, session) - read-only, beside readiness and delivery, never inside them.
      trust: await this._trustPreview(pitch, channel, recipient.contact, ctx && ctx.view ? ctx.view.country : null),
      // F26.6: the sending mailbox line - the default connected mailbox, its gate (capability,
      // Ready, pacing) and the trust verdict under ITS transport policy. Read-only; email only.
      ...(channel === 'email' ? { mailbox: await this._mailboxPreview(pitch, recipient.contact, ctx && ctx.view ? ctx.view.country : null) } : {})
    };
  }

  /**
   * Human-triggered send of ONE approved pitch on ONE EXPLICITLY NAMED CHANNEL.
   *
   * F25: THIS METHOD IS THE UNIFIED DISPATCHER, AND IT DECLARES NO BEHAVIOUR OF ITS OWN.
   * The channel is required and closed: 'email' delegates to sendEmail(), 'whatsapp'
   * delegates to sendWhatsApp(), and ANY other value - including a missing channel - throws
   * ValidationError BEFORE any boundary, ledger row or provider call. There is deliberately
   * no default channel, so a caller that does not name one cannot inherit email by accident.
   *
   * THE CHANNEL IS NEVER CHOSEN HERE. Each boundary names its channel explicitly and
   * re-runs the capability check, the OutreachGate, the approval and content-integrity check,
   * the recipient lookup and the idempotency rule inside its own method.
   *
   * THERE IS NO AUTOMATIC FALLBACK IN EITHER DIRECTION. This dispatcher never observes that
   * the OTHER channel happens to be able to send and never routes there: if the selected
   * channel's capability is unavailable the call FAILS CLOSED with that channel's own
   * factual capability refusal and contacts nobody. A human who selected email is never
   * silently written to on WhatsApp, and a human who selected WhatsApp is never silently
   * written to by email. Channel selection is explicit intent, never a capability lottery.
   *
   * The renderer cannot widen the choice either. The IPC schema admits EXACTLY
   * { pitchId, channel } with channel restricted to the two factual channels and
   * additionalProperties:false, so no recipient, provider or body can be smuggled in.
   *
   * @param {{ pitchId: string, channel: 'email' | 'whatsapp' }} request
   * @returns {Promise<object>} the selected channel boundary's own result
   * @throws {ValidationError} when the channel is missing or not one of the two enum values
   */
  async send({ pitchId, channel, mailboxId = undefined }) {
    // F26.6: an email from the user's own connected mailbox. The transactional-provider path
    // below is untouched; WhatsApp never takes a mailbox.
    if (channel === 'email' && mailboxId !== undefined) return this.sendFromMailbox({ pitchId, mailboxId });
    if (mailboxId !== undefined) throw new ValidationError('mailbox is email-only', [{ path: '$.mailboxId', message: 'a mailbox can only send email' }]);
    if (channel === 'email') return this.sendEmail({ pitchId });
    if (channel === 'whatsapp') return this.sendWhatsApp({ pitchId });
    throw new ValidationError('unknown send channel', [
      { path: '$.channel', message: 'channel must be "email" or "whatsapp"' },
    ]);
  }

  /**
   * F26.5 (C1): the MAIL-APP HANDOFF for an email pitch - "Open in my mail app" or "Copy".
   *
   * THIS IS NOT A SEND. ZTech hands the approved, compliant text to the person's own mail app
   * (or clipboard) and cannot know whether they send it. So it:
   *   - writes NO li_outreach_sends row and is never counted as a send;
   *   - records one OUTREACH_HANDOFF_CREATED activity (per content and kind), never
   *     OUTREACH_SEND_ATTEMPTED / ACCEPTED;
   *   - claims nothing about delivery.
   *
   * The same safety holds as for a send: the gate re-check (approved, current evidence), the
   * stored recipient (never the caller's), then suppression -> sender identity -> subject lint.
   * Resend's transport rule does not apply - this is not Resend - and that is the whole point
   * of C1: a first contact leaves from the person's own mailbox, under their own name.
   *
   * The footer (business name, postal address, opt-out line) is in the body. Custom headers
   * cannot be guaranteed by another program, and the result says so in `headerNote`.
   *
   * @param {{pitchId: string, kind: 'mailto'|'copy'}} request
   */
  async handoff({ pitchId, kind }) {
    if (!HANDOFF_KINDS.includes(kind)) {
      throw new ValidationError('unknown handoff kind', [{ path: '$.kind', message: 'kind must be "mailto" or "copy"' }]);
    }
    if (kind === 'mailto' && !this.openExternal) {
      throw new LiError('HANDOFF_UNAVAILABLE', 'Opening your mail app is not available here. Use Copy instead.');
    }
    const pitch = await this.get(pitchId);
    const verdict = await this.gate({ pitchId });
    if (!verdict || verdict.decision !== 'allowed') {
      throw new LiError('NOT_READY', 'Only a pitch the Outreach Gate currently allows can be handed off.');
    }
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const facts = ctx && ctx.view ? contactFactsFromView(ctx.view, ctx.view.email_raw_present) : null;
    if (!facts || facts.channels.email.state !== 'available' || !facts.channels.email.contact) {
      throw new LiError('CHANNEL_UNAVAILABLE', 'No valid email address is stored for this lead.');
    }
    if (!this.trust) throw new LiError('TRUST_UNAVAILABLE', 'The do-not-contact and consent records cannot be read.');
    const to = facts.channels.email.contact;
    const check = await this.trust.evaluate({
      channel: 'email', recipient: to, offer: this.offer, sender: { fromName: this._senderProfile().displayName },
      subject: pitch.subject, provider: HANDOFF_TRANSPORT, country: ctx.view.country,
    });
    if (!check.allowed) throw new LiError(check.code, check.message);

    const address = normalizeEmail(to);
    const oneClick = this._oneClickFor(address);
    const body = this._emailFinalBody(pitch, { oneClickUrl: oneClick ? oneClick.url : null });
    const link = mailtoUrl({ to, subject: pitch.subject, body });
    await this._rememberRef(oneClick, address);
    if (kind === 'mailto') {
      if (!/^mailto:/.test(link.url)) throw new LiError('HANDOFF_UNAVAILABLE', 'The mail link could not be built.');
      await this.openExternal(link.url);
    }

    // One activity row per (content, kind): opening the same text twice adds no duplicate line.
    const previous = await this.store.activity.latestForPitch(pitch.pitch_id, 'OUTREACH_HANDOFF_CREATED');
    const duplicate = previous && previous.metadata && previous.metadata.contentHash === pitch.content_hash && previous.metadata.handoffKind === kind;
    if (!duplicate) {
      await this._recordActivity(pitch, 'OUTREACH_HANDOFF_CREATED', { channel: 'email', contentHash: pitch.content_hash, handoffKind: kind });
    }
    return {
      kind,
      pitchId: pitch.pitch_id,
      leadId: pitch.lead_id,
      to,
      subject: pitch.subject,
      body,
      mailtoTooLong: link.tooLongForMailto,
      // Never a send: no ledger row, no provider, no delivery claim.
      sent: false,
      headersGuaranteed: false,
      headerNote: HANDOFF_HEADER_NOTE,
    };
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
    const capability = this.sendCapability('email');
    if (!capability.canSend) {
      // A disabled or unconfigured provider is a refusal a human asked for and did not get,
      // so it IS an event worth recording. It records no provider id and no message id,
      // because no provider was contacted.
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: capability.message, channel: 'email' });
      throw new LiError(capability.code, capability.message);
    }

    // (1b) F22: PROVIDER CONFIGURATION capability - the one additional fail-closed check
    // this phase is allowed to add. It only ever NARROWS: if this process has a provider
    // configuration source and that configuration is not structurally complete AND
    // verified, the send is refused with that configuration's own factual reason before
    // anything else is read. With no configuration source (every non-Electron process,
    // every unit test) it has nothing to say and the F19 check above remains the answer.
    //
    // After this check PASSES, F23 may proceed to a REAL provider invocation at step (8)
    // - but only through the existing interlocks: a live provider instance, message
    // validation, and the durable attempt record. With incomplete configuration (the
    // current installation: no credential, no verified domain) this check refuses first
    // and no transport exists to call. Nothing is ever fabricated from here: no
    // providerMessageId and no acceptance can appear without an actual provider response.
    const configured = this.emailConfigStore();
    const providerStatus = configured ? await this.getEmailProviderStatus() : null;
    if (providerStatus && !providerStatus.capability.canSend) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: providerStatus.capability.message,
        channel: 'email'
      });
      throw new LiError(providerStatus.capability.code, providerStatus.capability.message);
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

    // (5b) F26.5 TRUST CHECKS, in the frozen order: suppression -> sender identity -> transport
    // eligibility (this transport's own policy) -> subject lint. A refusal records one
    // OUTREACH_SEND_BLOCKED row and contacts nobody.
    await this._enforceTrust(pitch, 'email', facts.channels.email.contact, {
      fromName: providerStatus && providerStatus.fromName ? providerStatus.fromName : null,
      provider: this.emailProvider,
      country: ctx && ctx.view ? ctx.view.country : null,
    });

    // (6) Provider validation, before any provider contact. The command is COMPLETE and
    // final here: recipient and sender address come from stored configuration, the subject
    // is the approved pitch's own subject, and the text is the byte-for-byte body Prepare
    // showed (canonical pitch + configured signature). The provider gets no discretion.
    // F26.5: ZTech's own transport ALWAYS carries the unsubscribe headers. The mailto goes to
    // the sender's own reply mailbox; the one-click HTTPS link is added once a relay exists.
    const recipientAddress = normalizeEmail(facts.channels.email.contact);
    const oneClick = this._oneClickFor(recipientAddress);
    const unsubscribe = unsubscribeHeaders({
      mailbox: (providerStatus && providerStatus.replyTo) || capability.fromAddress,
      oneClickUrl: oneClick ? oneClick.url : null,
    });
    // F26.5: a transport that must carry unsubscribe headers never sends without them.
    const { transportPolicyOf } = require('../trust/TrustPolicy');
    if (!unsubscribe && transportPolicyOf(this.emailProvider).enforcesUnsubscribeHeaders) {
      const reason = 'The unsubscribe header could not be built from the sender mailbox, so nothing is sent.';
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason, channel: 'email', contentHash: pitch.content_hash, blockedCode: 'UNSUBSCRIBE_HEADERS_UNAVAILABLE' });
      throw new LiError('UNSUBSCRIBE_HEADERS_UNAVAILABLE', reason);
    }
    const message = {
      to: facts.channels.email.contact,
      from: capability.fromAddress,
      ...(providerStatus && providerStatus.fromName ? { fromName: providerStatus.fromName } : {}),
      ...(providerStatus && providerStatus.replyTo ? { replyTo: providerStatus.replyTo } : {}),
      subject: pitch.subject,
      text: this._emailFinalBody(pitch, { oneClickUrl: oneClick ? oneClick.url : null }),
      headers: {
        'X-ZTech-Pitch': pitch.pitch_id,
        // The idempotency key travels WITH the message, so a provider that supports
        // de-duplication can recognise a retry ZTech itself would treat as a replay.
        'X-ZTech-Send-Key': idempotencyKey,
        ...(unsubscribe || {})
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

    // F26.5: the one-click link is about to leave ZTech, so its ref -> address mapping is kept
    // first - an unsubscribe that comes back through the relay can then always be resolved.
    await this._rememberRef(oneClick, recipientAddress);

    // F26.6: one in-flight send per content across every email transport; replay re-checked inside.
    return this._withSendKey(idempotencyKey, async () => {
    const replayInside = await this.store.sends.findAccepted(idempotencyKey);
    if (replayInside) return this._sendResult({ pitch, outcome: 'replayed', send: replayInside, gate: verdict });
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
    });
  }

  /**
   * F26.6: what Prepare shows about sending from the default mailbox. Verdicts and the sanitized
   * mailbox record only - no token, no address of the contact, no ref.
   */
  async _mailboxPreview(pitch, recipient, country) {
    if (!this.mailboxes) return null;
    const row = await this.mailboxes.store.mailboxes.getDefault();
    if (!row) return { mailbox: null, gate: null, trust: null, canSend: false };
    const gate = await this.mailboxes.sendGate(row.mailbox_id);
    let trust = { allowed: false, code: gate.code || 'MAILBOX_PROVIDER_UNVERIFIED', message: gate.message || null };
    if (this.trust) {
      let transport = null;
      try { transport = await this.mailboxes.transportFor(row.mailbox_id); } catch { transport = null; }
      if (transport) {
        const v = await this.trust.evaluate({ channel: 'email', recipient, offer: this.offer, sender: { fromName: this._senderProfile().displayName || row.display_name || null }, subject: pitch.subject, provider: transport, country });
        trust = { allowed: v.allowed === true, code: v.allowed ? null : v.code, message: v.allowed ? null : v.message };
      }
    }
    const mailbox = gate.allowed ? gate.mailbox : await this.mailboxes.get(row.mailbox_id);
    return {
      mailbox,
      gate: { allowed: gate.allowed === true, code: gate.allowed ? null : gate.code, message: gate.allowed ? null : gate.message, nextAllowedAt: gate.nextAllowedAt || null },
      trust,
      canSend: gate.allowed === true && trust.allowed === true,
    };
  }

  /**
   * F26.6: ONE send in flight per idempotency key, across EVERY email transport (the configured
   * provider and any mailbox). Two confirms of the same content - on two transports, or two
   * mailboxes - can no longer both reach a provider before either is accepted. Inside the guard
   * the accepted-replay lookup runs again.
   */
  async _withSendKey(idempotencyKey, fn) {
    if (!this._sendKeysInFlight) this._sendKeysInFlight = new Set();
    if (this._sendKeysInFlight.has(idempotencyKey)) throw new LiError('SEND_IN_PROGRESS', 'This exact email is already being sent. Nothing else was sent; wait for that result.');
    this._sendKeysInFlight.add(idempotencyKey);
    try { return await fn(); } finally { this._sendKeysInFlight.delete(idempotencyKey); }
  }

  /** F26.6: the connected-mailbox service (main-only), set by the runtime. */
  setMailboxes(mailboxes) { this.mailboxes = mailboxes || null; }

  /** F28: the follow-up sequence service (main-only), set by the runtime. */
  setSequences(sequences) { this.sequences = sequences || null; }

  // === F26.6: the connected-mailbox send boundary ===
  //
  // The SAME safety order as sendEmail, with the mailbox in place of the configured provider:
  //   1. mailbox gate - provider capability (verified) and mailbox Ready (its Check passed)
  //   ...
  //   6b. PACING for THIS mailbox_id (caps, gap, window), inside the per-mailbox lock, right before
  //       the attempt is recorded - so a replay (which contacts nobody) is never paced, and two
  //       racing clicks are judged on the ledger as it is. Refusal = MAILBOX_PACING with the next
  //       allowed time. Nothing is queued.
  //   2-5. pitch, Outreach Gate re-check, idempotency (same key as any email of this content, so
  //        one approved content is accepted once across every transport), stored recipient
  //   5b. trust checks with the mailbox transport's own policy - suppression, sender identity,
  //       the market gate, subject lint
  //   6. validation: from = the mailbox address, List-Unsubscribe mandatory, NO Message-ID
  //   7. durable attempt row (mailbox_id, provider 'gmail') BEFORE the provider is touched
  //   8. one provider call, under a per-mailbox lock (a second click while one is in flight is refused)
  //   9. settle accepted/failed, then READ BACK the stored copy and persist the provider-STORED
  //      Message-ID (li_mailbox_sent). Replies are matched against that id only.
  //
  // F28: `followUp` is set ONLY by the SequenceService (main process) for a due step of an
  // activated sequence; no IPC caller can supply it (send() passes one argument). It adds:
  //   - the step's pitch must be that follow-up, and the mailbox the sequence's own mailbox;
  //   - the recipient must still be the address the first email went to (CONTACT_CHANGED);
  //   - threading: the first email's Gmail thread, In-Reply-To = the previous message's STORED
  //     Message-ID, References = every earlier stored id, Subject "Re: <first subject>" (D4).
  // Every other step above and below is unchanged.
  async sendFromMailbox({ pitchId, mailboxId }, { followUp = null } = {}) {
    if (!this.mailboxes) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: 'Mailboxes are not available here.', channel: 'email', blockedCode: 'MAILBOX_UNAVAILABLE' });
      throw new LiError('MAILBOX_UNAVAILABLE', 'Mailboxes are not available here.');
    }
    // (1) Mailbox gate: capability -> Ready. Read-only. (Pacing is step 6b.)
    const gate = await this.mailboxes.sendGate(mailboxId, { pacing: false });
    if (!gate.allowed) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: gate.message, channel: 'email', blockedCode: gate.code });
      const err = new LiError(gate.code, gate.message);
      if (gate.nextAllowedAt) err.details = { nextAllowedAt: gate.nextAllowedAt };
      throw err;
    }
    const mailbox = gate.mailbox;
    const transport = await this.mailboxes.transportFor(mailboxId);

    // (2) Existence and (3) the Outreach Gate re-check.
    const pitch = await this.get(pitchId);
    if (followUp && (pitch.kind !== 'followup' || followUp.pitchId !== pitch.pitch_id || followUp.mailboxId !== mailboxId || followUp.firstSubject !== pitch.subject)) {
      throw new LiError('SEQUENCE_MISMATCH', 'This follow-up does not belong to that sequence or mailbox. Nothing was sent.');
    }
    const verdict = await this.gate({ pitchId, channel: 'email' }, { sequenceSend: Boolean(followUp) });
    if (!verdict || verdict.decision !== 'allowed') {
      const first = verdict && Array.isArray(verdict.reasons) && verdict.reasons.length ? verdict.reasons[0] : null;
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: first ? first.message : 'The Outreach Gate does not allow this pitch right now.', channel: 'email', contentHash: pitch.content_hash });
      throw new LiError('NOT_READY', 'The Outreach Gate does not allow this pitch right now.');
    }

    // (4) Idempotency across every email transport.
    const idempotencyKey = sendIdempotencyKey({ channel: 'email', pitchId: pitch.pitch_id, contentHash: pitch.content_hash });
    const already = await this.store.sends.findAccepted(idempotencyKey);
    if (already) return this._sendResult({ pitch, outcome: 'replayed', send: already, gate: verdict });

    // (5) Recipient from the STORED contact facts only.
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const facts = ctx && ctx.view ? contactFactsFromView(ctx.view, ctx.view.email_raw_present) : null;
    if (!facts || facts.channels.email.state !== 'available' || !facts.channels.email.contact) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: 'No valid email address is stored for this lead.', channel: 'email', contentHash: pitch.content_hash });
      throw new LiError('CHANNEL_UNAVAILABLE', 'No valid email address is stored for this lead.');
    }

    // F28: a follow-up goes only to the address the first email went to.
    if (followUp && normalizeEmail(facts.channels.email.contact) !== followUp.recipient) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: 'The lead\'s email address changed since the first email.', channel: 'email', contentHash: pitch.content_hash, blockedCode: 'CONTACT_CHANGED' });
      throw new LiError('CONTACT_CHANGED', 'The lead\'s email address changed since the first email, so this follow-up is not sent.');
    }

    // (5b) Trust: suppression -> identity -> transport policy (the mailbox's) -> MARKET -> subject.
    const fromName = this._senderProfile().displayName || mailbox.displayName || null;
    await this._enforceTrust(pitch, 'email', facts.channels.email.contact, {
      fromName, provider: transport, country: ctx && ctx.view ? ctx.view.country : null,
    });

    // (6) The complete message. Unsubscribe headers go to the mailbox's OWN address.
    const recipientAddress = normalizeEmail(facts.channels.email.contact);
    const oneClick = this._oneClickFor(recipientAddress);
    const unsubscribe = unsubscribeHeaders({ mailbox: mailbox.emailAddress, oneClickUrl: oneClick ? oneClick.url : null });
    if (!unsubscribe) {
      const reason = 'The unsubscribe header could not be built from the mailbox address, so nothing is sent.';
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason, channel: 'email', contentHash: pitch.content_hash, blockedCode: 'UNSUBSCRIBE_HEADERS_UNAVAILABLE' });
      throw new LiError('UNSUBSCRIBE_HEADERS_UNAVAILABLE', reason);
    }
    const message = {
      to: facts.channels.email.contact,
      from: mailbox.emailAddress,
      ...(fromName ? { fromName } : {}),
      subject: followUp ? `Re: ${pitch.subject}` : pitch.subject,
      text: this._emailFinalBody(pitch, { oneClickUrl: oneClick ? oneClick.url : null }),
      headers: { 'X-ZTech-Pitch': pitch.pitch_id, 'X-ZTech-Send-Key': idempotencyKey, ...unsubscribe },
      ...(followUp ? { thread: { threadId: followUp.threadId, inReplyTo: followUp.inReplyTo, references: [...followUp.references] } } : {}),
    };
    const valid = transport.validate(message);
    if (!valid || valid.valid !== true) {
      const detail = Array.isArray(valid && valid.errors) && valid.errors.length ? valid.errors[0].message : 'the message is invalid';
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: `The email message did not validate: ${detail}`, channel: 'email', contentHash: pitch.content_hash });
      throw new ValidationError('email message is invalid', (valid && valid.errors ? valid.errors : []).map((e) => ({ path: `$.${e.field}`, message: e.message })));
    }
    await this._rememberRef(oneClick, recipientAddress);

    return this._withSendKey(idempotencyKey, () => this.mailboxes.withMailboxLock(mailboxId, async () => {
      const replay = await this.store.sends.findAccepted(idempotencyKey);
      if (replay) return this._sendResult({ pitch, outcome: 'replayed', send: replay, gate: verdict });
      // (6b) Pacing, inside the lock: judged on the ledger as it is now.
      const again = await this.mailboxes.sendGate(mailboxId);
      if (!again.allowed) {
        await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: again.message, channel: 'email', contentHash: pitch.content_hash, blockedCode: again.code });
        const refusal = new LiError(again.code, again.message);
        // F28: the scheduler moves the step to exactly this time (never a blind retry).
        if (again.nextAllowedAt !== undefined) refusal.details = { nextAllowedAt: again.nextAllowedAt || null };
        throw refusal;
      }
      // (7) The durable attempt.
      const sendId = newId('send');
      const now = this.clock().toISOString();
      await this.store.sends.record({
        send_id: sendId, lead_id: pitch.lead_id, pitch_id: pitch.pitch_id, channel: 'email', content_hash: pitch.content_hash,
        idempotency_key: idempotencyKey, state: 'attempted', provider_id: transport.id, mailbox_id: mailboxId, created_at: now, updated_at: now,
      });
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ATTEMPTED', { channel: 'email', contentHash: pitch.content_hash, providerId: transport.id, idempotencyKey });

      // (8) The only call that reaches the outside world.
      let receipt;
      try {
        receipt = await transport.send(message);
      } catch (err) {
        const at = this.clock().toISOString();
        const code = err && err.code ? String(err.code) : 'EMAIL_SEND_FAILED';
        const safe = err instanceof LiError ? err.message : 'The mailbox could not send the message.';
        await this.store.sends.fail({ sendId, failureCode: code, failureMessage: safe, at });
        await this._recordSendEvent(pitchId, 'OUTREACH_SEND_FAILED', { channel: 'email', contentHash: pitch.content_hash, providerId: transport.id, idempotencyKey, failureCode: code, reason: safe });
        throw err instanceof LiError ? err : new LiError(code, safe);
      }

      // (9) Accepted - never delivered, opened or clicked.
      const at = this.clock().toISOString();
      const settled = await this.store.sends.accept({ sendId, providerId: transport.id, providerMessageId: receipt.messageId, at });
      const winner = settled && settled.ok === false ? settled.row : await this.store.sends.get(sendId);
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ACCEPTED', { channel: 'email', contentHash: pitch.content_hash, providerId: transport.id, idempotencyKey, providerMessageId: winner.provider_message_id });

      // (9b) READ BACK the stored copy: its Message-ID is the one replies cite (Step 1A).
      let readBack = null;
      try {
        readBack = await transport.readBack(receipt.messageId, { expectListUnsubscribe: unsubscribe['List-Unsubscribe'] });
      } catch {
        readBack = null; // the send happened; matching for it is simply unavailable
      }
      let matchable = Boolean(readBack && readBack.storedMessageId);
      try {
        await this.store.mailboxSent.record({
          send_id: sendId, mailbox_id: mailboxId, provider_message_id: receipt.messageId,
          stored_message_id: readBack ? readBack.storedMessageId : null, thread_id: (readBack && readBack.threadId) || receipt.threadId || null,
          recipient_address: recipientAddress, recorded_at: this.clock().toISOString(),
        });
      } catch (err) {
        // The email DID go out; only reply matching for it is lost. Never report the send as failed.
        matchable = false;
        if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lead-intelligence] mailbox sent id not recorded', { error: err && err.code ? err.code : 'ERROR' });
      }
      // The email DID go out: a failure to note the read-back must never turn into "not sent".
      try { await this.mailboxes.noteReadBack(mailboxId, readBack); } catch (err) {
        if (this.logger && typeof this.logger.warn === 'function') this.logger.warn('[lead-intelligence] mailbox read-back note failed', { error: err && err.code ? err.code : 'ERROR' });
      }
      const result = this._sendResult({ pitch, outcome: settled && settled.ok === false ? 'replayed' : 'accepted', send: winner, gate: verdict });
      return {
        ...result,
        mailboxId,
        // F28: the provider-STORED Message-ID and thread of THIS message (main-only use: the
        // sequence threads its next step on it). Not sensitive, but only the sequence reads it.
        ...(followUp ? { threaded: true } : {}),
        // Whether a reply to THIS message can be recognised: only with a readable stored Message-ID.
        replyMatching: matchable ? 'ready' : 'unavailable',
        unsubscribeHeadersKept: readBack ? readBack.listUnsubscribeKept : null,
      };
    }));
  }

  // === F20: the WhatsApp send boundary ===
  //
  // Mirrors the email send boundary exactly, with channel-specific differences:
  // - Channel is 'whatsapp' instead of 'email'
  // - Uses WhatsApp capability evaluator (checks phone number, not email)
  // - Uses WhatsApp provider (whatsappProvider) instead of emailProvider
  // - Validates E.164 phone number instead of email address
  // - Uses WhatsAppProvider instead of EmailProvider
  // - All safety interlocks (capability, gate, idempotency, approval) are identical
  async sendWhatsApp({ pitchId }) {
    // (1) Capability. Refused before anything is read or written beyond the refusal itself.
    const capability = this.sendCapability('whatsapp');
    if (!capability.canSend) {
      // A disabled or unconfigured provider is a refusal a human asked for and did not get,
      // so it IS an event worth recording. It records no provider id and no message id,
      // because no provider was contacted.
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', { reason: capability.message, channel: 'whatsapp' });
      throw new LiError(capability.code, capability.message);
    }

    // (1b) F24: PROVIDER CONFIGURATION capability - the same fail-closed check the email
    // boundary has run since F22, now for WhatsApp. It only ever NARROWS: if this process
    // has a WhatsApp configuration source and that configuration is not structurally
    // complete AND marked verified, the send is refused with that configuration's own
    // factual reason before anything else is read. With no configuration source (every
    // non-Electron process, every unit test) it has nothing to say and the F20 check above
    // remains the answer.
    //
    // After this check PASSES, the adapter may proceed to a REAL provider invocation at
    // step (8) - but only through the existing interlocks: a live provider instance,
    // message validation and the durable attempt record. With incomplete configuration
    // (the current installation: no provider selected, no credential, no connected
    // number) this check refuses first and no transport exists to call. Nothing is ever
    // fabricated from here: no providerMessageId and no acceptance can appear without an
    // actual provider response.
    const waConfigured = this.whatsappConfigStore();
    const waProviderStatus = waConfigured ? await this.getWhatsAppProviderStatus() : null;
    if (waProviderStatus && !waProviderStatus.capability.canSend) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: waProviderStatus.capability.message,
        channel: 'whatsapp'
      });
      throw new LiError(waProviderStatus.capability.code, waProviderStatus.capability.message);
    }

    // (2) Existence. A missing pitch is not a gate decision, so it is not recorded as one.
    const pitch = await this.get(pitchId);

    // (3) THE RE-CHECK. The gate is asked on ITS OWN default channel ("email") - the same
    // readiness decision the Ready queue and F18 preparation made. WhatsApp contact data
    // has no vote in readiness and never had one; what is WhatsApp-specific happens BELOW,
    // where a missing or invalid number can only REMOVE a send.
    const verdict = await this.gate({ pitchId });
    if (!verdict || verdict.decision !== 'allowed') {
      const first = verdict && Array.isArray(verdict.reasons) && verdict.reasons.length ? verdict.reasons[0] : null;
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: first ? first.message : 'The Outreach Gate does not allow this pitch right now.',
        channel: 'whatsapp',
        contentHash: pitch.content_hash
      });
      throw new LiError('NOT_READY', 'The Outreach Gate does not allow this pitch right now.');
    }

    // (4) IDEMPOTENCY, checked against the content that was just gate-approved. A replay
    // contacts nobody: it returns the recorded provider outcome and says so.
    const idempotencyKey = sendIdempotencyKey({ channel: 'whatsapp', pitchId: pitch.pitch_id, contentHash: pitch.content_hash });
    const already = await this.store.sends.findAccepted(idempotencyKey);
    if (already) return this._sendResult({ pitch, outcome: 'replayed', send: already, gate: verdict });

    // (5) Recipient from the STORED contact facts. The caller cannot supply one: the IPC
    // schema admits only { pitchId }.
    const ctx = await this.contexts.getContext(pitch.lead_id, { targetId: pitch.target_id ?? undefined });
    const facts = ctx && ctx.view ? contactFactsFromView(ctx.view, ctx.view.email_raw_present) : null;
    if (!facts || facts.channels.whatsapp.state !== 'candidate' || !facts.channels.whatsapp.contact) {
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: 'No valid WhatsApp number is stored for this lead.',
        channel: 'whatsapp',
        contentHash: pitch.content_hash
      });
      throw new LiError('CHANNEL_UNAVAILABLE', 'No valid WhatsApp number is stored for this lead.');
    }

    // (5b) F26.5 TRUST CHECKS, in the frozen order: suppression -> sender identity -> recorded
    // opt-in for this number -> open 24-hour session. A refusal records one
    // OUTREACH_SEND_BLOCKED row and contacts nobody.
    await this._enforceTrust(pitch, 'whatsapp', facts.channels.whatsapp.contact, { provider: this.whatsappProvider });

    // (6) Provider validation, before any provider contact. The command is COMPLETE and
    // final here: the recipient comes from the stored contact facts, the sender number
    // comes from the configuration the capability approved, and the body is the canonical
    // approved pitch text byte for byte - exactly what Prepare displayed. The provider
    // gets no discretion and performs no transformation of its own.
    const whatsappTo = toE164(facts.channels.whatsapp.contact);
    const message = {
      to: whatsappTo,
      from: capability.fromNumber,
      body: renderPitchText(pitch),
      // The stable idempotency key travels WITH the command, mirroring the email
      // boundary. The Cloud API defines no provider-level de-duplication, so this is a
      // correlation fact only - the ledger above remains the idempotency authority.
      headers: {
        'X-ZTech-Send-Key': idempotencyKey
      }
    };
    const valid = this.whatsappProvider.validate(message);
    if (!valid || valid.valid !== true) {
      const detail = Array.isArray(valid && valid.errors) && valid.errors.length ? valid.errors[0].message : 'the message is invalid';
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_BLOCKED', {
        reason: 'The WhatsApp message did not validate: ' + detail,
        channel: 'whatsapp',
        contentHash: pitch.content_hash
      });
      throw new ValidationError('whatsapp message is invalid',
        (valid && valid.errors ? valid.errors : []).map((e) => ({ path: '$.' + e.field, message: e.message })));
    }

    // (7) THE DURABLE ATTEMPT, written BEFORE the provider is touched.
    const sendId = newId('send');
    const now = this.clock().toISOString();
    await this.store.sends.record({
      send_id: sendId,
      lead_id: pitch.lead_id,
      pitch_id: pitch.pitch_id,
      channel: 'whatsapp',
      content_hash: pitch.content_hash,
      idempotency_key: idempotencyKey,
      state: 'attempted',
      provider_id: capability.providerId,
      created_at: now,
      updated_at: now
    });
    await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ATTEMPTED', {
      channel: 'whatsapp',
      contentHash: pitch.content_hash,
      providerId: capability.providerId,
      idempotencyKey
    });

    // (8) The only call that can reach the outside world.
    let receipt;
    try {
      receipt = await this.whatsappProvider.send(message);
    } catch (err) {
      // (9a) Failure. Record ZTech's own code and a ZTech-authored message; the provider's
      // own text is deliberately NOT copied into the row, a log or the renderer.
      const at = this.clock().toISOString();
      const code = err && err.code ? String(err.code) : 'WHATSAPP_SEND_FAILED';
      const safe = err instanceof LiError ? err.message : 'The WhatsApp provider could not accept the message.';
      await this.store.sends.fail({ sendId, failureCode: code, failureMessage: safe, at });
      await this._recordSendEvent(pitchId, 'OUTREACH_SEND_FAILED', {
        channel: 'whatsapp', contentHash: pitch.content_hash, providerId: capability.providerId,
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
        channel: 'whatsapp', contentHash: pitch.content_hash, providerId: capability.providerId,
        idempotencyKey, providerMessageId: winner.provider_message_id
      });
      return this._sendResult({ pitch, outcome: 'replayed', send: winner, gate: verdict, channel: 'whatsapp' });
    }
    await this._recordSendEvent(pitchId, 'OUTREACH_SEND_ACCEPTED', {
      channel: 'whatsapp', contentHash: pitch.content_hash, providerId: capability.providerId,
      idempotencyKey, providerMessageId: winner.provider_message_id
    });
    return this._sendResult({ pitch, outcome: 'accepted', send: winner, gate: verdict, providerStatus: receipt && receipt.status, channel: 'whatsapp' });
  }

  /**
   * The honest send result. `providerAcknowledged` is the ONLY true fact about the outside
   * world here, and the three delivery facts are explicitly 'unknown' - never false, because
   * ZTech has no observer that could support either answer.
   */
  _sendResult({ pitch, outcome, send, gate, providerStatus = null, channel = 'email' }) {
    return {
      outcome, // 'accepted' | 'replayed' - never 'delivered'
      channel,
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

  /** F19/F20: the current, honest send capability verdict for a given channel. Read-only, no side effects. */
  sendCapability(channel) {
    if (channel === 'whatsapp') {
      return evalWhatsAppCapability({
        enabled: this.whatsapp.enabled,
        provider: this.whatsappProvider,
        fromNumber: this.whatsapp.fromNumber
      });
    }
    // Default to email
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
      pitch = await this._pitchById(pitchId);
    } catch (err) {
      return null;
    }
    if (!pitch) return null;
    return this._recordActivity(pitch, type, metadata);
  }
}

module.exports = { OutreachService };
