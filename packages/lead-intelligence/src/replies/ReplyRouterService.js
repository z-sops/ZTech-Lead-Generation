'use strict';

/**
 * F29 - the Reply Router. MAIN PROCESS ONLY.
 *
 * It gives a verified mailbox reply a SUGGESTED category (interested, not_interested,
 * pricing_request, meeting_request, later, out_of_office, unsubscribe, unknown) so the replies a
 * person must read are sorted. It ONLY suggests:
 *   - it never writes a trust event, a suppression, a consent or a reply review;
 *   - nothing in the trust policy, the gates or F28 reads its table;
 *   - it never sends, drafts, schedules, resumes or stops anything (it has no path to do so);
 *   - the human reply review (F26.6 follow-up) stays the only thing that changes permission.
 *
 * D1 fallback (live Step 1 probe, 8 Oct 2026): the category comes from the SUBJECT and HEADERS the
 * reply sync already reads. The subject is used in memory and dropped: it is never stored, logged,
 * returned or put in an error. ZTech cannot see a stop request written only in the reply body.
 *
 * A route is written only for a message that cites a provider-STORED Message-ID of one of this
 * mailbox's own sends AND comes from the address that send went to:
 *   reply / unsubscribe - after the trust intake accepted it (it already stopped F28 / suppressed)
 *   away                - an automatic reply (D4): the intake still SKIPS it; it is a fact only.
 */

const { LiError, ValidationError, NotFoundError } = require('../core/errors');
const { normalizeAddress } = require('../trust/trustContract');
const { classifyReply } = require('./replyRules');
const { REPLY_CATEGORIES, SUGGESTED_REVIEW } = require('./replyRouteContract');

const LIST_LIMIT = 200;
const PAGE = 200;
const MAX_SCAN = 100 * PAGE; // a hard stop: 20,000 routes
const SHOW = Object.freeze(['pending', 'all']);

class ReplyRouterService {
  /**
   * @param {{store: object, clock?: () => Date, operator?: string, leadName?: (leadId: string) => Promise<string|null>, logger?: object|null}} deps
   */
  constructor({ store, clock = () => new Date(), operator = 'local-user', leadName = null, logger = null } = {}) {
    if (!store || !store.replyRoutes) throw new TypeError('ReplyRouterService needs the store with reply routes');
    this.store = store;
    this.clock = clock;
    this.operator = operator;
    this.leadName = typeof leadName === 'function' ? leadName : null;
    this.logger = logger;
  }

  _warn(code) { if (this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] reply router: ${code}`); }

  /**
   * The ONE listener the reply sync calls (MailboxService._intakeOne). Never throws: a failure is
   * logged by code only and the sync goes on exactly as without the router.
   *
   * @param {{kind: 'reply'|'unsubscribe'|'away', mailboxId: string, eventId: string, from: string, refs: string[], subject: string}} m
   * @returns {Promise<string>} a code: 'routed' | 'duplicate' | 'skipped' | 'error'
   */
  async onMailboxMessage(m) {
    try {
      return await this._route(m || {});
    } catch (err) {
      this._warn(`route failed: ${(err && err.code) || 'ERROR'}`);
      return 'error';
    }
  }

  async _route({ kind, mailboxId, eventId, from, refs, subject }) {
    if (!['reply', 'unsubscribe', 'away'].includes(kind) || typeof mailboxId !== 'string' || typeof eventId !== 'string') return 'skipped';
    const address = normalizeAddress('email', from);
    const ids = Array.isArray(refs) ? refs.filter((x) => typeof x === 'string' && x.length <= 300) : [];
    if (!address || !ids.length || !this.store.mailboxSent) return 'skipped';
    // Verified the same way as the trust intake: a stored Message-ID of THIS mailbox, from the
    // address that send went to. A forward answered by someone else gets no category.
    const sent = await this.store.mailboxSent.findByStoredIds(mailboxId, ids);
    if (!sent || !sent.recipient_address || normalizeAddress('email', sent.recipient_address) !== address) return 'skipped';
    const te = this.store.trustEvents ? await this.store.trustEvents.get(eventId) : null;
    if (kind === 'away') {
      if (te) return 'skipped'; // an automatic reply never has a trust event; anything else is not "away"
    } else if (!te || te.kind !== kind || te.source !== 'mailbox' || te.normalized_address !== address) {
      return 'skipped'; // only what the trust intake ACCEPTED is routed
    }
    if (await this.store.replyRoutes.get(eventId)) return 'duplicate';
    const send = await this.store.sends.get(sent.send_id);
    if (!send || !send.lead_id) return 'skipped';
    const pitch = send.pitch_id && this.store.pitches ? await this.store.pitches.get(send.pitch_id) : null;
    const firstSubject = pitch && typeof pitch.subject === 'string' ? pitch.subject : null;
    const c = classifyReply({ kind, subject, firstSubject });
    const { created } = await this.store.replyRoutes.put({
      event_id: eventId, lead_id: send.lead_id, mailbox_id: mailboxId, kind,
      suggested: c.category, rule_id: c.ruleId, input: c.input, confidence: c.confidence,
      confirmed: null, confirmed_by: null, confirmed_at: null, routed_at: this.clock().toISOString(),
    });
    return created ? 'routed' : 'duplicate';
  }

  /** pending | reviewed | suppressed | superseded | unsubscribed | away - from the trust records, never stored. */
  async _state(route) {
    if (route.kind === 'away') return { state: 'away', receivedAt: null };
    const te = this.store.trustEvents ? await this.store.trustEvents.get(route.event_id) : null;
    if (!te) return { state: 'superseded', receivedAt: null };
    if (route.kind === 'unsubscribe') return { state: 'unsubscribed', receivedAt: te.received_at };
    const review = this.store.replyReviews ? await this.store.replyReviews.forEvent(route.event_id) : null;
    if (review) return { state: 'reviewed', receivedAt: te.received_at, reviewOutcome: review.outcome };
    // Already on do-not-contact (a "Do not contact" / "Mark unsubscribed" click, or any other
    // suppression): the review buttons are hidden, so it is not waiting for a review.
    if (this.store.suppressions && await this.store.suppressions.find({ channel: 'email', address: te.normalized_address })) {
      return { state: 'suppressed', receivedAt: te.received_at };
    }
    // The human review applies to the NEWEST mailbox reply from this address (F26.6 follow-up).
    const latest = await this.store.trustEvents.latestFor({ channel: 'email', address: te.normalized_address, kinds: ['reply'], sources: ['mailbox'] });
    if (!latest || latest.event_id !== route.event_id) return { state: 'superseded', receivedAt: te.received_at };
    return { state: 'pending', receivedAt: te.received_at };
  }

  async _leadName(leadId) {
    if (!this.leadName) return null;
    try { const n = await this.leadName(leadId); return typeof n === 'string' ? n : null; } catch { return null; }
  }

  async _view(route, withName) {
    const st = await this._state(route);
    const category = route.confirmed || route.suggested;
    const leadName = withName ? await this._leadName(route.lead_id) : null;
    return {
      eventId: route.event_id, leadId: route.lead_id, leadName, kind: route.kind,
      suggested: route.suggested, ruleId: route.rule_id, input: route.input, confidence: route.confidence,
      confirmed: route.confirmed, confirmedAt: route.confirmed_at, category,
      // D6: the review the category points to, in words only. Nothing is recorded from it.
      suggestedReview: SUGGESTED_REVIEW[category] || null,
      // D5 (fallback): an opt-out phrase in the SUBJECT, not yet reviewed - shown first.
      possibleOptOut: category === 'unsubscribe' && st.state === 'pending',
      state: st.state, reviewOutcome: st.reviewOutcome || null, receivedAt: st.receivedAt, routedAt: route.routed_at,
    };
  }

  /**
   * The Replies list. `show: 'pending'` (default) is every verified reply still waiting for its
   * human review; `all` adds reviewed, superseded and already-unsubscribed ones. Possible opt-outs
   * first, then newest. Ids, codes and times only (and the lead's name): no text, no address.
   */
  async list({ category = null, show = 'pending' } = {}) {
    if (category !== null && !REPLY_CATEGORIES.includes(category)) throw new ValidationError('Invalid category', [{ path: '$.category', message: 'unknown category' }]);
    if (!SHOW.includes(show)) throw new ValidationError('Invalid show', [{ path: '$.show', message: 'must be pending or all' }]);
    // `pending` reads EVERY route, page by page, so an old pending reply - above all a possible
    // opt-out - never falls out of the list behind newer reviewed ones. `all` shows the newest.
    const out = [];
    const seen = new Set(); // a route written mid-read shifts the pages: never list one twice
    const cap = show === 'all' ? LIST_LIMIT : Infinity;
    for (let offset = 0; offset < cap && offset < MAX_SCAN && out.length < LIST_LIMIT; offset += PAGE) {
      const rows = await this.store.replyRoutes.list({ kinds: ['reply', 'unsubscribe'], limit: PAGE, offset });
      for (const r of rows) {
        if (seen.has(r.event_id)) continue;
        seen.add(r.event_id);
        const v = await this._view(r, false);
        if (show === 'pending' && v.state !== 'pending') continue;
        if (category && v.category !== category) continue;
        if (out.length < LIST_LIMIT) out.push(v);
      }
      if (rows.length < PAGE) break;
    }
    for (const v of out) v.leadName = await this._leadName(v.leadId);
    out.sort((a, b) => (a.possibleOptOut === b.possibleOptOut ? 0 : a.possibleOptOut ? -1 : 1));
    return { replies: out, show, category };
  }

  /**
   * The human confirms or corrects the category (D6). It records the CATEGORY only: never a reply
   * review, never a suppression, never anything that changes permission or F28.
   */
  async confirm({ eventId, category } = {}) {
    if (!REPLY_CATEGORIES.includes(category)) throw new ValidationError('Invalid category', [{ path: '$.category', message: 'unknown category' }]);
    const route = await this.store.replyRoutes.get(String(eventId));
    if (!route) throw new NotFoundError('Reply category');
    if (route.kind === 'away') throw new LiError('REPLY_ROUTE_AWAY', 'An out-of-office message is a note only; it has no category to confirm.');
    if (route.kind === 'unsubscribe') throw new LiError('REPLY_ROUTE_UNSUBSCRIBED', 'This reply already unsubscribed them; it has no category to confirm.');
    const next = await this.store.replyRoutes.confirm(route.event_id, { category, by: this.operator, at: this.clock().toISOString() });
    return this._view(next, true);
  }

  /** The drawer: the suggestion for the reply the review buttons apply to, and the latest Away note. */
  async forLead({ leadId } = {}) {
    const rows = await this.store.replyRoutes.forLead(String(leadId), 50);
    let latest = null;
    let away = null;
    for (const r of rows) {
      if (r.kind === 'away') { if (!away) away = { routedAt: r.routed_at }; continue; }
      if (latest) continue;
      const v = await this._view(r, false);
      if (v.state === 'pending' || v.state === 'reviewed' || v.state === 'unsubscribed' || v.state === 'suppressed') latest = v;
    }
    return { leadId: String(leadId), latest, away };
  }
}

module.exports = { ReplyRouterService };
