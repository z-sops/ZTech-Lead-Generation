'use strict';

// F26.5 declared test fixture (not a test file: run-all only runs *.test.js).
//
// Since F26.5 every send passes the trust checks: sender identity (business name + postal
// address), a recorded consent or verified reply for email on a transport that requires one,
// and for WhatsApp a recorded opt-in plus an open 24-hour session. Tests written before F26.5
// that exercise a SUCCESSFUL send use this fixture to put those facts in place, through the
// real store repositories - nothing in the send boundary is stubbed or bypassed.

const path = require('path');
const LI = path.join(__dirname, '..', 'src', 'main', 'lead-intelligence');
const { normalizeEmail, normalizePhone } = require(path.join(LI, 'trust', 'trustContract'));

/** The one field F26.5 adds to the Business Profile, merged into a test's offer. */
const TRUST_OFFER = Object.freeze({ postal_address: 'Suite 4, 12 Test Street, Karachi 75500, Pakistan' });

function withTrustOffer(offer) {
  return Object.assign({}, offer || {}, TRUST_OFFER);
}

let seq = 0;

/**
 * Record the trust facts a successful send needs for one contact.
 * @param {object} store  a MemoryStore or SqlJsStore
 * @param {{email?: string, phone?: string, leadId?: string, now?: Date|string}} who
 */
async function grantTrust(store, { email = null, phone = null, leadId = 'L1', now = new Date() } = {}) {
  const at = typeof now === 'string' ? now : now.toISOString();
  seq += 1;
  if (email && normalizeEmail(email)) {
    await store.consents.record({
      consent_id: `con_fixture_e${seq}`, lead_id: String(leadId), channel: 'email', normalized_address: email,
      method: 'website_form', evidence_note: 'Test fixture: contact form submission', recorded_by: 'test',
      consented_at: at, recorded_at: at, source: 'user', event_id: null,
    });
  }
  if (phone && normalizePhone(phone)) {
    await store.consents.record({
      consent_id: `con_fixture_w${seq}`, lead_id: String(leadId), channel: 'whatsapp', normalized_address: phone,
      method: 'in_person', evidence_note: 'Test fixture: opted in at a meeting', recorded_by: 'test',
      consented_at: at, recorded_at: at, source: 'user', event_id: null,
    });
    // The contact's own WhatsApp message, as the relay would report it: opens the 24h window.
    await store.trustEvents.append({
      row_id: `tev_fixture_${seq}`, event_id: `evt_fixture_${seq}`, kind: 'whatsapp_inbound', channel: 'whatsapp',
      recipient_ref: null, normalized_address: phone, source: 'relay', state: 'applied', reject_code: null,
      received_at: at, recorded_at: at,
    });
  }
}

/** grantTrust for every lead in a { id: lead } map, reading the lead's own email / phone. */
async function grantTrustForLeads(store, leads, now) {
  for (const l of Object.values(leads || {})) {
    await grantTrust(store, { email: l.email || null, phone: l.phone || null, leadId: l.id, now });
  }
}

/**
 * Synchronous form for harnesses that build their runtime synchronously. Both stores perform
 * the write before their first await, so the facts are in place when this returns; a refused
 * write still surfaces as a failing promise rather than being swallowed.
 */
function grantTrustForLeadsSync(store, leads, now) {
  const at = typeof now === 'string' ? now : (now || new Date()).toISOString();
  for (const l of Object.values(leads || {})) {
    seq += 1;
    const n = seq;
    const loud = (p) => p.catch((e) => { process.nextTick(() => { throw e; }); });
    if (l.email && normalizeEmail(l.email)) {
      loud(store.consents.record({
        consent_id: `con_fixture_e${n}`, lead_id: String(l.id), channel: 'email', normalized_address: l.email,
        method: 'website_form', evidence_note: 'Test fixture: contact form submission', recorded_by: 'test',
        consented_at: at, recorded_at: at, source: 'user', event_id: null,
      }));
    }
    if (l.phone && normalizePhone(l.phone)) {
      loud(store.consents.record({
        consent_id: `con_fixture_w${n}`, lead_id: String(l.id), channel: 'whatsapp', normalized_address: l.phone,
        method: 'in_person', evidence_note: 'Test fixture: opted in at a meeting', recorded_by: 'test',
        consented_at: at, recorded_at: at, source: 'user', event_id: null,
      }));
      loud(store.trustEvents.append({
        row_id: `tev_fixture_${n}`, event_id: `evt_fixture_${n}`, kind: 'whatsapp_inbound', channel: 'whatsapp',
        recipient_ref: null, normalized_address: l.phone, source: 'relay', state: 'applied', reject_code: null,
        received_at: at, recorded_at: at,
      }));
    }
  }
}

module.exports = { TRUST_OFFER, withTrustOffer, grantTrust, grantTrustForLeads, grantTrustForLeadsSync };
