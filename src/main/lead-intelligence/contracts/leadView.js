'use strict';

const { pick } = require('../core/objects');

/**
 * Lead view adapter — the anti-corruption layer between ZTech's existing lead
 * objects and the lead-intelligence module.
 *
 * INTEGRATION POINT (QwenCoder): the real field names of a ZTech lead are NOT known
 * to this module. DEFAULT_LEAD_FIELD_MAP lists likely candidates. Inspect the real
 * lead row/object (Lead Library + Lead Profile code) and pass the real map in
 * config.leadFieldMap. Do not change lead storage to fit this map.
 */
const DEFAULT_LEAD_FIELD_MAP = Object.freeze({
  id: ['id', 'lead_id', 'leadId', '_id'],
  name: ['name', 'business_name', 'businessName', 'company', 'company_name', 'title'],
  phone: ['phone', 'phone_number', 'phoneNumber', 'formatted_phone_number', 'international_phone_number'],
  email: ['email', 'emails.0', 'contact_email'],
  website: ['website', 'website_url', 'websiteUrl', 'url', 'site'],
  address: ['address', 'formatted_address', 'full_address'],
  city: ['city', 'location.city'],
  country: ['country', 'location.country', 'country_code'],
  industry: ['industry', 'category', 'main_category'],
  business_type: ['business_type', 'businessType', 'type', 'types.0'],
  qualification_status: ['qualification.status', 'qualification_status', 'qualificationStatus'],
  data_quality: ['quality.level', 'data_quality', 'dataQuality', 'quality'],
});

const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

function str(v, max = 500) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!s) return null;
  return s.slice(0, max);
}

/**
 * @param {object} raw ZTech lead object
 * @param {object} [fieldMap]
 * @returns {Readonly<LeadView>}
 */
function toLeadView(raw, fieldMap = DEFAULT_LEAD_FIELD_MAP) {
  const map = { ...DEFAULT_LEAD_FIELD_MAP, ...(fieldMap || {}) };
  const get = (k) => pick(raw, map[k] || []);
  const id = get('id');
  if (id === undefined || id === null || id === '') throw new TypeError('lead has no id');
  const email = str(get('email'), 254);
  const view = {
    id: String(id),
    name: str(get('name'), 300),
    phone: str(get('phone'), 50),
    email: email && EMAIL.test(email) ? email.toLowerCase() : null,
    email_raw_present: Boolean(email),
    website: str(get('website'), 2048),
    address: str(get('address'), 500),
    city: str(get('city'), 120),
    country: str(get('country'), 120),
    industry: str(get('industry'), 200),
    business_type: str(get('business_type'), 200),
    qualification_status: (str(get('qualification_status'), 60) || '').toLowerCase() || null,
    data_quality: (str(get('data_quality'), 60) || '').toLowerCase() || null,
  };
  view.has_website = Boolean(view.website);
  view.has_phone = Boolean(view.phone);
  view.has_email = Boolean(view.email);
  return Object.freeze(view);
}

/** Identity used inside an EvidencePacket (subset; lead-sourced, not research-sourced). */
function identityFromView(view) {
  return {
    company_name: view.name,
    lead_domain: view.website,
    phone: view.phone,
    city: view.city,
    country: view.country,
  };
}

module.exports = { DEFAULT_LEAD_FIELD_MAP, toLeadView, identityFromView, EMAIL };
