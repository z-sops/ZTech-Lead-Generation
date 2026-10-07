'use strict';

/**
 * F26.5 TrustService - the main-process owner of suppressions, consents, provenance views and
 * trust-event intake.
 *
 * ADDRESSES NEVER COME FROM THE RENDERER. Every user action names a lead and a channel; the
 * address is read from the stored lead here, exactly like the send boundary reads its
 * recipient. A relay event names an opaque recipient_ref, which only this process can resolve.
 *
 * WHAT THE RENDERER GETS (leadTrust): verdicts, reasons, methods, dates and notes the person
 * wrote - never a normalized address, a recipient_ref, a hash, a signature or a relay secret.
 *
 * INTAKE (one function for every event):
 *   - idempotent by event_id: a known event is acknowledged and changes nothing again;
 *   - a relay event must carry a valid signature; a bad one is recorded as REJECTED and has no
 *     effect;
 *   - unsubscribe / bounce / complaint -> a GLOBAL suppression (reason = the kind);
 *   - whatsapp_inbound -> a consent (method inbound_message, source relay) for every lead with
 *     that number, and - by the event itself - an open 24-hour window;
 *   - reply -> stored for F28 (stop-on-reply). It also counts as the verified prior contact
 *     that lets an email transport with requiresPriorRelationship write back. Nothing else.
 *   - a USER may enter only unsubscribe / bounce / complaint. A user can never enter a reply
 *     or an inbound message: those are facts only a provider can prove.
 */

const { newId, stableId } = require('../core/ids');
const { LiError, ValidationError, NotFoundError } = require('../core/errors');
const { toLeadView } = require('../contracts/leadView');
const {
  DEFAULT_WORKSPACE_ID, TRUST_CHANNELS, CONSENT_METHODS, TRUST_EVENT_KINDS, TRUST_LIMITS,
  normalizeAddress, cleanText, isIso, EVENT_ID_RE, RECIPIENT_REF_RE,
} = require('./trustContract');
const { verifyEvent } = require('./relaySignature');
const { HANDOFF_HEADER_NOTE } = require('./unsubscribe');

const USER_EVENT_KINDS = Object.freeze(['unsubscribe', 'bounce', 'complaint']);
// F26.6: what a connected mailbox may report. Bounce (DSN) parsing is deferred.
const MAILBOX_EVENT_KINDS = Object.freeze(['reply', 'unsubscribe']);
const { VERIFIED_REPLY_SOURCES } = require('./TrustPolicy');
const SUPPRESSING_KINDS = Object.freeze(['unsubscribe', 'bounce', 'complaint']);
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const LEAD_SCAN_MAX = 20000;

const TRUST_SERVICE_MESSAGES = Object.freeze({
  EMAIL_REPLY_NOT_RECORDABLE: 'A reply cannot be recorded by hand. It counts only when it arrives as a verified event. Choose how the person opted in instead.',
  CHANNEL_UNAVAILABLE: 'This lead has no valid contact for that channel.',
});

class TrustService {
  /**
   * @param {{store: object, leadSource?: object, fieldMap?: object, clock?: () => Date,
   *          operator?: string, workspaceId?: string, logger?: object}} opts
   */
  constructor({ store, leadSource = null, fieldMap, clock = () => new Date(), operator = 'local-user', workspaceId = DEFAULT_WORKSPACE_ID, logger = null } = {}) {
    if (!store || !store.suppressions || !store.consents || !store.trustEvents || !store.provenance) throw new TypeError('TrustService needs the F26.5 trust repositories');
    this.store = store;
    this.leadSource = leadSource;
    this.fieldMap = fieldMap;
    this.clock = clock;
    this.operator = cleanText(operator, TRUST_LIMITS.RECORDED_BY_MAX) || 'local-user';
    this.workspaceId = workspaceId;
    this.logger = logger;
    // Set by the relay client once a relay secret is configured (main process only).
    this.relayKeys = null;
  }

  setRelayKeys(keys) {
    this.relayKeys = keys && keys.signKey && keys.refKey ? keys : null;
  }

  now() { return this.clock(); }

  /** The stored lead's view, or NotFoundError. */
  async _view(leadId) {
    if (!this.leadSource || typeof this.leadSource.getLead !== 'function') throw new NotFoundError('Lead', leadId);
    const raw = await this.leadSource.getLead(String(leadId));
    if (!raw) throw new NotFoundError('Lead', leadId);
    return toLeadView(raw, this.fieldMap);
  }

  _addressOf(view, channel) {
    if (channel === 'email') return normalizeAddress('email', view.email);
    if (channel === 'whatsapp') return normalizeAddress('whatsapp', view.phone);
    return null;
  }

  _channel(channel) {
    if (!TRUST_CHANNELS.includes(channel)) throw new ValidationError('unknown channel', [{ path: '$.channel', message: 'channel must be "email" or "whatsapp"' }]);
    return channel;
  }

  /* ------------------------------ read model ------------------------------ */

  /** The renderer-safe trust view of one lead. Verdicts and dates only. */
  async leadTrust({ leadId }) {
    const view = await this._view(leadId);
    const channels = {};
    for (const channel of TRUST_CHANNELS) {
      const address = this._addressOf(view, channel);
      if (!address) { channels[channel] = { available: false, suppression: null, consent: null, verifiedReply: null, sessionOpenUntil: null }; continue; }
      const [suppression, consent] = await Promise.all([
        this.store.suppressions.find({ channel, address, workspaceId: this.workspaceId }),
        this.store.consents.latestFor({ channel, address }),
      ]);
      const reply = channel === 'email' ? await this.store.trustEvents.latestFor({ channel, address, kinds: ['reply'] }) : null;
      const inbound = channel === 'whatsapp' ? await this.store.trustEvents.latestFor({ channel, address, kinds: ['whatsapp_inbound'] }) : null;
      const verifiedInbound = inbound && inbound.source === 'relay' ? inbound : null;
      channels[channel] = {
        available: true,
        suppression: suppression ? {
          id: suppression.suppression_id, reason: suppression.reason, scope: suppression.scope, source: suppression.source,
          createdAt: suppression.created_at, removable: suppression.reason === 'manual' && suppression.source === 'user',
        } : null,
        consent: consent ? { method: consent.method, consentedAt: consent.consented_at, recordedBy: consent.recorded_by, evidenceNote: consent.evidence_note, source: consent.source } : null,
        verifiedReply: reply && VERIFIED_REPLY_SOURCES.includes(reply.source) ? { receivedAt: reply.received_at } : null,
        sessionOpenUntil: verifiedInbound ? new Date(Date.parse(verifiedInbound.received_at) + TRUST_LIMITS.WHATSAPP_SESSION_MS).toISOString() : null,
      };
    }
    const provenance = (await this.store.provenance.listByLead(view.id)).map((p) => ({
      field: p.field, sourceKind: p.source_kind, sourceRef: p.source_ref, collectedAt: p.collected_at, backfilled: p.backfilled === 1,
    }));
    return { leadId: view.id, channels, provenance, handoffHeaderNote: HANDOFF_HEADER_NOTE };
  }

  /* ------------------------------ user actions ------------------------------ */

  /**
   * "Mark unsubscribed" (reason unsubscribe: goes through intake as a user event, so it is
   * recorded once and suppresses globally) or "Do not contact" (reason manual: a suppression the
   * person may later lift, in the chosen scope).
   */
  async suppressLead({ leadId, channel, reason, scope = 'global' }) {
    this._channel(channel);
    if (reason !== 'unsubscribe' && reason !== 'manual') throw new ValidationError('unknown reason', [{ path: '$.reason', message: 'reason must be "unsubscribe" or "manual"' }]);
    if (scope !== 'global' && scope !== 'workspace') throw new ValidationError('unknown scope', [{ path: '$.scope', message: 'scope must be "global" or "workspace"' }]);
    const view = await this._view(leadId);
    const address = this._addressOf(view, channel);
    if (!address) throw new LiError('CHANNEL_UNAVAILABLE', TRUST_SERVICE_MESSAGES.CHANNEL_UNAVAILABLE);
    const at = this.now().toISOString();
    if (reason === 'unsubscribe') {
      await this.intake({ event_id: newId('evt').replace(/-/g, ''), kind: 'unsubscribe', channel, address, received_at: at }, { source: 'user' });
    } else {
      await this.store.suppressions.add({
        suppression_id: newId('sup'), scope, workspace_id: scope === 'workspace' ? this.workspaceId : null,
        channel, normalized_address: address, reason: 'manual', source: 'user', created_at: at,
      });
    }
    return this.leadTrust({ leadId: view.id });
  }

  /** Lift a MANUAL suppression of this lead's own address. Opt-outs and bounces are never lifted here. */
  async liftSuppression({ leadId, channel, suppressionId }) {
    this._channel(channel);
    const view = await this._view(leadId);
    const address = this._addressOf(view, channel);
    const rows = address ? await this.store.suppressions.listForAddress({ channel, address }) : [];
    const row = rows.find((r) => r.suppression_id === String(suppressionId));
    if (!row || !(await this.store.suppressions.removeManual(row.suppression_id))) {
      throw new LiError('SUPPRESSION_NOT_REMOVABLE', 'Only a "Do not contact" you added yourself can be removed. Unsubscribes, bounces and complaints stay.');
    }
    return this.leadTrust({ leadId: view.id });
  }

  /**
   * Record an opt-in: method + when it was given + an evidence note + who recorded it (the
   * operator, set here, never by the caller). For email, 'inbound_message' is refused: that
   * would be the "they replied" shortcut, and a reply counts only as a verified event.
   */
  async recordConsent({ leadId, channel, method, consentedAt, evidenceNote }) {
    this._channel(channel);
    if (!CONSENT_METHODS.includes(method)) throw new ValidationError('unknown method', [{ path: '$.method', message: 'unknown consent method' }]);
    if (channel === 'email' && method === 'inbound_message') throw new LiError('CONSENT_METHOD_NOT_ALLOWED', TRUST_SERVICE_MESSAGES.EMAIL_REPLY_NOT_RECORDABLE);
    const note = cleanText(evidenceNote, TRUST_LIMITS.EVIDENCE_NOTE_MAX);
    if (note.length < 3) throw new ValidationError('evidence note required', [{ path: '$.evidenceNote', message: 'describe how and where the person opted in' }]);
    const now = this.now();
    // A calendar day (YYYY-MM-DD) is the day the person chose in THEIR time zone. It is stored as
    // noon UTC (the same calendar day from UTC-11 to UTC+11) and refused only when it is later
    // than "today" anywhere on Earth (UTC+14), so a Karachi morning is never "in the future".
    const dayOnly = typeof consentedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(consentedAt);
    const latestToday = new Date(now.getTime() + 14 * 3600000).toISOString().slice(0, 10);
    const consentIso = dayOnly ? `${consentedAt}T12:00:00.000Z` : consentedAt;
    const badDay = dayOnly && (consentedAt > latestToday || !Number.isFinite(Date.parse(consentIso)));
    const badStamp = !dayOnly && (!isIso(consentedAt) || Date.parse(consentedAt) > now.getTime() + FUTURE_SKEW_MS);
    if (badDay || badStamp) {
      throw new ValidationError('invalid date', [{ path: '$.consentedAt', message: 'the opt-in date must be a real date, not in the future' }]);
    }
    const view = await this._view(leadId);
    const address = this._addressOf(view, channel);
    if (!address) throw new LiError('CHANNEL_UNAVAILABLE', TRUST_SERVICE_MESSAGES.CHANNEL_UNAVAILABLE);
    await this.store.consents.record({
      consent_id: newId('con'), lead_id: view.id, channel, normalized_address: address, method,
      evidence_note: note, recorded_by: this.operator, consented_at: new Date(Date.parse(consentIso)).toISOString(),
      recorded_at: now.toISOString(), source: 'user', event_id: null,
    });
    return this.leadTrust({ leadId: view.id });
  }

  /* ------------------------------ intake ------------------------------ */

  /**
   * The ONE intake for trust events.
   * @param {object} event  relay: { event_id, kind, channel, recipient_ref, received_at, signature }
   *                        user:  { event_id, kind, channel, address, received_at } (main-built)
   *                        mailbox (F26.6): { event_id, kind: 'reply'|'unsubscribe', channel: 'email',
   *                                       address (the From), received_at, mailbox_id,
   *                                       reference_ids (In-Reply-To + References) } built in
   *                                       main by mailbox sync from headers only
   * @param {{source: 'relay'|'user'|'mailbox'}} opts
   * @returns {Promise<{accepted: boolean, duplicate?: boolean, state: string, code?: string}>}
   */
  async intake(event, { source }) {
    const e = event && typeof event === 'object' ? event : {};
    const nowIso = this.now().toISOString();
    if (!['relay', 'user', 'mailbox'].includes(source)) throw new ValidationError('unknown source', [{ path: '$.source', message: 'source must be relay, user or mailbox' }]);
    const shapeOk = typeof e.event_id === 'string' && EVENT_ID_RE.test(e.event_id)
      && TRUST_EVENT_KINDS.includes(e.kind) && TRUST_CHANNELS.includes(e.channel)
      && !(e.kind === 'whatsapp_inbound' && e.channel !== 'whatsapp')
      && isIso(e.received_at)
      // A user event may not claim the future. A relay event may (this desktop's clock can be
      // behind the relay's): it is accepted and its time is clamped to now below, so it can
      // never stretch a window. Refusing it would lose a genuine opt-out.
      && (source === 'relay' || Date.parse(e.received_at) <= this.now().getTime() + FUTURE_SKEW_MS);
    if (!shapeOk) return { accepted: false, state: 'invalid', code: 'EVENT_INVALID' };

    const receivedAt = new Date(Math.min(Date.parse(e.received_at), this.now().getTime())).toISOString();
    const reject = async (code) => {
      // Recorded for the audit trail, outside the idempotency index, with no effect.
      await this.store.trustEvents.append({
        row_id: newId('tev'), event_id: e.event_id, kind: e.kind, channel: e.channel,
        recipient_ref: typeof e.recipient_ref === 'string' && RECIPIENT_REF_RE.test(e.recipient_ref) ? e.recipient_ref : null,
        normalized_address: null, source, state: 'rejected', reject_code: code, received_at: receivedAt, recorded_at: nowIso,
      });
      return { accepted: false, state: 'rejected', code };
    };

    let address = null;
    let ref = null;
    if (source === 'relay') {
      if (!this.relayKeys) return reject('RELAY_NOT_CONFIGURED');
      if (!verifyEvent(this.relayKeys.signKey, e)) return reject('BAD_SIGNATURE');
      ref = typeof e.recipient_ref === 'string' ? e.recipient_ref : null;
      const mapped = ref ? await this.store.recipientRefs.resolve(ref) : null;
      address = mapped && mapped.channel === e.channel ? mapped.normalized_address : null;
      // A ref this desktop never stored (an inbound from a number never written to, or a link
      // minted under an earlier relay key) is resolved by recomputing refs for known leads.
      if (!address && ref) address = await this._resolveRefByLeads(ref, e.channel);
    } else if (source === 'mailbox') {
      // F26.6: only a verified reply or an unsubscribe reply, on email. Never a bounce (deferred),
      // a complaint or a WhatsApp event. Reachable only from main-process mailbox sync.
      if (e.channel !== 'email' || !MAILBOX_EVENT_KINDS.includes(e.kind)) return reject('KIND_NOT_MAILBOX_RECORDABLE');
      address = normalizeAddress(e.channel, e.address);
      if (!address) return { accepted: false, state: 'invalid', code: 'EVENT_INVALID' };
      // A REPLY counts only when its In-Reply-To / References cite the PROVIDER-STORED Message-ID
      // of one of this mailbox's own sends (never a ZTech-supplied id, never "same sender").
      // An unsubscribe needs no match: a suppression can only ever restrict, and an RFC 2369
      // mailto unsubscribe is a new message that cites nothing.
      if (e.kind === 'reply') {
        const refs = Array.isArray(e.reference_ids) ? e.reference_ids.filter((x) => typeof x === 'string' && x.length <= 300) : [];
        const matched = typeof e.mailbox_id === 'string' && refs.length && this.store.mailboxSent
          ? await this.store.mailboxSent.findByStoredIds(e.mailbox_id, refs) : null;
        if (!matched) return reject('REPLY_NOT_MATCHED');
      }
    } else {
      if (!USER_EVENT_KINDS.includes(e.kind)) return reject('KIND_NOT_USER_RECORDABLE');
      address = normalizeAddress(e.channel, e.address);
      if (!address) return { accepted: false, state: 'invalid', code: 'EVENT_INVALID' };
    }

    // Idempotent by event_id: a known event changes nothing again.
    const known = await this.store.trustEvents.get(e.event_id);
    if (known) return { accepted: true, duplicate: true, state: known.state };

    let state = 'stored';
    if (!address) {
      state = 'unresolved';
    } else if (SUPPRESSING_KINDS.includes(e.kind)) {
      await this.store.suppressions.add({
        suppression_id: newId('sup'), scope: 'global', workspace_id: null, channel: e.channel, normalized_address: address,
        reason: e.kind, source, created_at: nowIso,
      });
      state = 'applied';
    } else if (e.kind === 'whatsapp_inbound') {
      const leads = await this._leadsWithAddress(e.channel, address);
      for (const leadId of leads) {
        try {
          await this.store.consents.record({
            consent_id: stableId('con', e.event_id, leadId), lead_id: leadId, channel: 'whatsapp', normalized_address: address,
            method: 'inbound_message', evidence_note: `The contact messaged your WhatsApp number (relay event ${e.event_id}).`,
            recorded_by: 'relay', consented_at: receivedAt, recorded_at: nowIso, source: 'relay', event_id: e.event_id,
          });
        } catch (err) {
          if (!/UNIQUE/.test(String(err && err.message))) throw err; // re-delivery after a crash: already recorded
        }
      }
      state = 'applied';
    }
    const { row, created } = await this.store.trustEvents.append({
      row_id: newId('tev'), event_id: e.event_id, kind: e.kind, channel: e.channel, recipient_ref: ref,
      normalized_address: address, source, state, reject_code: null, received_at: receivedAt, recorded_at: nowIso,
    });
    return created ? { accepted: true, state } : { accepted: true, duplicate: true, state: row.state };
  }

  /* ------------------------------ provenance ------------------------------ */

  /**
   * Capture provenance for one collection or import SAVE (called by the main process right
   * after accountStore.addNumbers succeeded). For every saved row, the lead is found by its
   * phone, and a contact field is attributed to this save ONLY when:
   *   - the saved row carried that field, AND
   *   - the stored lead now holds exactly that value, AND
   *   - the field has no provenance row yet.
   * So a merge that kept an older value never re-attributes it, and nothing is guessed.
   *
   * @param {{rows: object[], providerId?: string|null, runSlug?: string|null}} save
   */
  async captureSave({ rows, providerId = null, runSlug = null } = {}) {
    const saved = Array.isArray(rows) ? rows : [];
    if (!saved.length) return { recorded: 0 };
    const at = this.now().toISOString();
    const isRun = typeof runSlug === 'string' && runSlug.length > 0;
    const sourceKind = isRun ? 'collection_run' : 'import';
    const sourceRef = isRun ? cleanText(`${providerId || 'provider'}/${runSlug}`, TRUST_LIMITS.SOURCE_REF_MAX) : null;
    const byPhone = new Map();
    for (const v of await this._allLeadViews()) {
      const p = normalizeAddress('whatsapp', v.phone) || (v.phone ? String(v.phone).replace(/[\s\-.()]/g, '') : null);
      if (p) byPhone.set(p, v);
    }
    const recs = [];
    for (const r of saved) {
      if (!r || typeof r !== 'object') continue;
      const key = normalizeAddress('whatsapp', r.phone) || (r.phone ? String(r.phone).replace(/[\s\-.()]/g, '') : null);
      const view = key ? byPhone.get(key) : null;
      if (!view) continue;
      const same = {
        phone: Boolean(r.phone),
        email: typeof r.email === 'string' && view.email && r.email.trim().toLowerCase() === view.email,
        website: typeof r.website === 'string' && view.website && r.website.trim() === view.website,
      };
      for (const field of ['phone', 'email', 'website']) {
        if (!same[field]) continue;
        recs.push({ lead_id: view.id, field, source_kind: sourceKind, source_ref: sourceRef, collected_at: at, backfilled: false, recorded_at: at });
      }
    }
    const results = await this.store.provenance.putMany(recs, { ifAbsent: true });
    return { recorded: results.filter((x) => x.written).length };
  }

  /**
   * One-time backfill: every contact field of a lead that has NO provenance yet is marked
   * 'unknown' (backfilled). Nothing is inferred from the lead record - which run first saw a
   * field cannot be told after merges - so no source or date is invented. A later capture can
   * never be overwritten by this, and this never overwrites a capture.
   */
  async backfillProvenance() {
    const views = await this._allLeadViews();
    const at = this.now().toISOString();
    const recs = [];
    for (const v of views) {
      const present = { phone: Boolean(v.phone), email: Boolean(v.email), website: Boolean(v.website) };
      for (const field of ['phone', 'email', 'website']) {
        if (present[field]) recs.push({ lead_id: v.id, field, source_kind: 'unknown', source_ref: null, collected_at: null, backfilled: true, recorded_at: at });
      }
    }
    const results = await this.store.provenance.putMany(recs);
    return { leads: views.length, recorded: results.filter((x) => x.written).length };
  }

  async _allLeadViews() {
    if (!this.leadSource || typeof this.leadSource.listLeads !== 'function') return [];
    const raw = await this.leadSource.listLeads();
    const out = [];
    for (const r of (Array.isArray(raw) ? raw : []).slice(0, LEAD_SCAN_MAX)) {
      try { out.push(toLeadView(r, this.fieldMap)); } catch { /* a lead without an id is skipped */ }
    }
    return out;
  }

  async _leadsWithAddress(channel, address) {
    const views = await this._allLeadViews();
    return views.filter((v) => this._addressOf(v, channel) === address).map((v) => v.id);
  }

  /** An inbound from a number ZTech never wrote to: find the lead whose number has this ref. */
  async _resolveRefByLeads(ref, channel) {
    const { recipientRefFor } = require('./relaySignature');
    for (const v of await this._allLeadViews()) {
      const a = this._addressOf(v, channel);
      if (a && recipientRefFor(this.relayKeys.refKey, channel, a) === ref) {
        await this.store.recipientRefs.ensure({ recipient_ref: ref, channel, normalized_address: a, created_at: this.now().toISOString() });
        return a;
      }
    }
    return null;
  }
}

module.exports = { TrustService, USER_EVENT_KINDS, TRUST_SERVICE_MESSAGES };
