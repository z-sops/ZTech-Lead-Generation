'use strict';

/**
 * F26.5 TrustPolicy - the trust checks of the ONE send boundary, in the frozen channel-aware order.
 *
 *   COMMON    1 suppression                     CONTACT_SUPPRESSED
 *             2 sender identity                 SENDER_IDENTITY_INCOMPLETE
 *   EMAIL     3 transport eligibility           EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD
 *             3b market (jurisdiction) rule     MARKET_CONSENT_REQUIRED      (F26.6)
             4 subject / policy lint           SUBJECT_MISLEADING
 *   WHATSAPP  3 consent                         WHATSAPP_CONSENT_REQUIRED
 *             4 session policy                  WHATSAPP_SESSION_CLOSED
 *   (5 provider capability is the existing F19-F24 configuration check, which needs no
 *    recipient and stays where it was, ahead of the gate. Like every check here it never
 *    contacts a provider.)
 *
 * WHAT DECIDES EMAIL ELIGIBILITY IS THE TRANSPORT, NOT THE PRODUCT. A transport declares
 * `transportPolicy.requiresPriorRelationship`. Resend's Acceptable Use Policy forbids cold
 * outreach, so Resend declares true. A transport that declares nothing is treated as true
 * (fail closed). A later own-mailbox transport declares its own policy after its terms are
 * verified, and does not inherit Resend's rule.
 *
 * A PRIOR RELATIONSHIP IS EVIDENCE, NEVER A TICK-BOX:
 *   - a recorded consent (method, timestamp, evidence note, recorder), or
 *   - a reply that arrived as a RELAY event (signature-verified). There is no user-entered
 *     "they replied" fact anywhere in ZTech, and a user-recorded email consent may not use the
 *     method 'inbound_message' (see TrustService.recordConsent).
 *
 * WHATSAPP free-form text is allowed by Meta only inside the 24-hour window opened by the
 * person's own message. That window is proven only by a relay `whatsapp_inbound` event.
 * Outside it Meta requires an approved template, which is F27.
 *
 * F26.6 MARKET GATE (email, every path - provider send, mailbox send and the mail-app handoff):
 * whatever the transport allows, an email to a contact with no recorded consent and no verified
 * reply passes only when Zee has recorded, after review, that the contact's country permits an
 * opt-out first contact ('opt_out_allowed'). No rule, an unknown country or an unreadable country
 * = consent required. A verified reply is a relay event OR a reply read from a connected mailbox
 * (source 'mailbox'); a user can still never type one in.
 *
 * Read-only: evaluate() writes nothing and never touches a provider. Messages name no address.
 */

const { DEFAULT_WORKSPACE_ID, TRUST_LIMITS, normalizeAddress } = require('./trustContract');
const { normalizeCountry } = require('../mailbox/mailboxContract');

/** Trust-event sources that prove a reply really arrived (never a user entry). */
const VERIFIED_REPLY_SOURCES = Object.freeze(['relay', 'mailbox']);

const TRUST_CODES = Object.freeze({
  SUPPRESSED: 'CONTACT_SUPPRESSED',
  IDENTITY: 'SENDER_IDENTITY_INCOMPLETE',
  EMAIL_COLD: 'EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD',
  SUBJECT: 'SUBJECT_MISLEADING',
  MARKET: 'MARKET_CONSENT_REQUIRED',
  WA_CONSENT: 'WHATSAPP_CONSENT_REQUIRED',
  WA_SESSION: 'WHATSAPP_SESSION_CLOSED',
  ADDRESS: 'CONTACT_ADDRESS_INVALID',
});

const TRUST_MESSAGES = Object.freeze({
  CONTACT_SUPPRESSED: 'This contact is on the do-not-contact list for this channel.',
  SENDER_IDENTITY_INCOMPLETE: 'Add your business name and postal address in Settings > Business Profile before sending.',
  SENDER_NAME_MISSING: 'Add a sender name (Business Profile representative or email From name) before sending email.',
  EMAIL_TRANSPORT_NOT_ALLOWED_FOR_COLD: 'This email provider does not allow cold outreach. Use "Open in my mail app" for a first contact, or record the lead\'s consent first.',
  MARKET_CONSENT_REQUIRED: 'This contact\'s country has no reviewed opt-out rule, so email needs a recorded consent or a verified reply first. Market rules are in Settings > Mailboxes.',
  SUBJECT_MISLEADING: 'The subject looks like a reply, a forward or a billing notice. Change it so it matches the pitch.',
  WHATSAPP_CONSENT_REQUIRED: 'WhatsApp needs a recorded opt-in from this contact first.',
  WHATSAPP_SESSION_CLOSED: 'Free-form WhatsApp messages are allowed only within 24 hours of the contact\'s last message. Approved templates arrive in a later update.',
  CONTACT_ADDRESS_INVALID: 'The stored contact address could not be normalized.',
});

// Re:, RE:, Fwd:, FW:, AW:, SV:, Antw: - optionally numbered ("Re[2]:") - at the start.
const REPLY_PREFIX = /^\s*(re|fw|fwd|aw|sv|antw)\s*(\[\d+\])?\s*:/i;
// Billing or account claims a cold pitch can never truthfully make.
const BILLING_CLAIM = /\b(invoice|payment|receipt|overdue|past\s+due|refund|final\s+notice|your\s+order|order\s+confirmation|order\s*#|account\s+(suspended|locked|verification))\b/i;

/** Pure subject lint. Returns null when the subject is fine, or a short reason word. */
function lintSubject(subject) {
  const s = typeof subject === 'string' ? subject : '';
  if (REPLY_PREFIX.test(s)) return 'reply_or_forward_prefix';
  if (BILLING_CLAIM.test(s)) return 'billing_or_account_claim';
  return null;
}

/** A transport's declared policy; anything undeclared is the strict default. */
function transportPolicyOf(provider) {
  const declared = provider && provider.transportPolicy && typeof provider.transportPolicy === 'object' ? provider.transportPolicy : {};
  return Object.freeze({
    requiresPriorRelationship: declared.requiresPriorRelationship !== false,
    enforcesUnsubscribeHeaders: declared.enforcesUnsubscribeHeaders !== false,
  });
}

const present = (v) => typeof v === 'string' && v.trim().length > 0;

class TrustPolicy {
  /**
   * @param {{store: object, clock?: () => Date, workspaceId?: string}} opts
   */
  constructor({ store, clock = () => new Date(), workspaceId = DEFAULT_WORKSPACE_ID } = {}) {
    if (!store || !store.suppressions || !store.consents || !store.trustEvents) throw new TypeError('TrustPolicy needs a store with the F26.5 trust repositories');
    this.store = store;
    this.clock = clock;
    this.workspaceId = workspaceId;
  }

  /** The read-only trust facts for one address (used by the checks and by the Prepare preview). */
  async facts({ channel, recipient, country = null }) {
    const address = normalizeAddress(channel, recipient);
    const market = channel === 'email' ? await this.marketFor(country) : null;
    if (!address) return { address: null, suppression: null, consent: null, reply: null, inbound: null, sessionOpenUntil: null, market };
    const [suppression, consent] = await Promise.all([
      this.store.suppressions.find({ channel, address, workspaceId: this.workspaceId }),
      this.store.consents.latestFor({ channel, address }),
    ]);
    const reply = channel === 'email' ? await this.store.trustEvents.latestFor({ channel, address, kinds: ['reply'] }) : null;
    const inbound = channel === 'whatsapp' ? await this.store.trustEvents.latestFor({ channel, address, kinds: ['whatsapp_inbound'] }) : null;
    const verifiedReply = reply && VERIFIED_REPLY_SOURCES.includes(reply.source) ? reply : null;
    const verifiedInbound = inbound && inbound.source === 'relay' ? inbound : null;
    const sessionOpenUntil = verifiedInbound
      ? new Date(Date.parse(verifiedInbound.received_at) + TRUST_LIMITS.WHATSAPP_SESSION_MS).toISOString()
      : null;
    return { address, suppression, consent, reply: verifiedReply, inbound: verifiedInbound, sessionOpenUntil, market };
  }

  /**
   * F26.6: the market rule for a lead's (raw) country. { countryCode, rule } where rule is
   * 'opt_out_allowed' only when a reviewed rule says so; everything else is 'consent_required'.
   */
  async marketFor(country) {
    const countryCode = normalizeCountry(country);
    if (!countryCode || !this.store.marketRules) return { countryCode, rule: 'consent_required', reviewed: false };
    const r = await this.store.marketRules.get(countryCode);
    return r ? { countryCode, rule: r.rule, reviewed: true } : { countryCode, rule: 'consent_required', reviewed: false };
  }

  /**
   * Evaluate every trust check for one send, in the frozen order. The FIRST failing check is
   * the answer. Returns { allowed: true, facts } or { allowed: false, code, message, step, facts }.
   *
   * @param {{channel: 'email'|'whatsapp', recipient: string, offer: object, sender?: object,
   *          subject?: string, provider?: object, country?: string}} input
   */
  async evaluate({ channel, recipient, offer, sender = {}, subject = '', provider = null, country = null }) {
    const facts = await this.facts({ channel, recipient, country });
    const refuse = (step, code, messageKey = code) => ({ allowed: false, step, code, message: TRUST_MESSAGES[messageKey], facts });
    if (!facts.address) return refuse('address', TRUST_CODES.ADDRESS);

    // COMMON 1: suppression - an opt-out beats everything, including a consent.
    if (facts.suppression) return refuse('suppression', TRUST_CODES.SUPPRESSED);

    // COMMON 2: sender identity - who is writing, and where they can be reached by post.
    const o = offer && typeof offer === 'object' ? offer : {};
    if (!present(o.sender_company) || !present(o.postal_address)) return refuse('identity', TRUST_CODES.IDENTITY);
    if (channel === 'email' && !present(o.sender_name) && !present(sender.fromName)) return refuse('identity', TRUST_CODES.IDENTITY, 'SENDER_NAME_MISSING');

    if (channel === 'email') {
      // EMAIL 3: transport eligibility, decided by the transport's own declared policy.
      const policy = transportPolicyOf(provider);
      if (policy.requiresPriorRelationship && !facts.consent && !facts.reply) return refuse('transport', TRUST_CODES.EMAIL_COLD);
      // EMAIL 3b (F26.6): the market rule. A transport's permission is never a permission to
      // contact this person; without consent or a verified reply, only a reviewed opt-out market passes.
      if (!facts.consent && !facts.reply && (!facts.market || facts.market.rule !== 'opt_out_allowed')) return refuse('market', TRUST_CODES.MARKET);
      // EMAIL 4: subject lint.
      if (lintSubject(subject)) return refuse('subject', TRUST_CODES.SUBJECT);
      return { allowed: true, facts };
    }

    if (channel === 'whatsapp') {
      // WHATSAPP 3: a recorded opt-in for THIS number.
      if (!facts.consent) return refuse('consent', TRUST_CODES.WA_CONSENT);
      // WHATSAPP 4: free-form text needs an open 24-hour customer-service window.
      const now = this.clock().getTime();
      if (!facts.sessionOpenUntil || Date.parse(facts.sessionOpenUntil) <= now) return refuse('session', TRUST_CODES.WA_SESSION);
      return { allowed: true, facts };
    }

    return refuse('address', TRUST_CODES.ADDRESS);
  }
}

module.exports = { TrustPolicy, TRUST_CODES, TRUST_MESSAGES, VERIFIED_REPLY_SOURCES, lintSubject, transportPolicyOf };
