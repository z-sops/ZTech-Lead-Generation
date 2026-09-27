'use strict';

const { normalizeDomain } = require('../core/urls');
const { EMAIL } = require('../contracts/leadView');

/**
 * Canonical enrichable fields. Providers declare which of these they can supply;
 * nothing outside this catalog is accepted.
 *
 * Each field has a normaliser that returns { ok: true, value } or { ok: false, reason }.
 * Values that fail normalisation are rejected and reported per step — never stored.
 *
 * `leadField` links an enriched field to the lead-view field it can fill for ICP
 * (the Lead Library value always wins; enrichment never writes the lead row).
 */

const CONTROL = /[\u0000-\u001f\u007f​-‏‪-‮⁠-⁤﻿]/g;

function text(max) {
  return (v) => {
    if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, reason: 'NOT_TEXT' };
    const s = String(v).replace(CONTROL, ' ').replace(/\s{2,}/g, ' ').trim();
    if (!s) return { ok: false, reason: 'EMPTY' };
    if (s.length > max) return { ok: false, reason: 'TOO_LONG' };
    return { ok: true, value: s };
  };
}

function email(v) {
  if (typeof v !== 'string') return { ok: false, reason: 'NOT_TEXT' };
  const s = v.trim().toLowerCase();
  return EMAIL.test(s) ? { ok: true, value: s } : { ok: false, reason: 'INVALID_EMAIL' };
}

function phone(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return { ok: false, reason: 'NOT_TEXT' };
  const s = String(v).replace(CONTROL, '').trim();
  if (!/^\+?[\d\s().-]{6,30}$/.test(s)) return { ok: false, reason: 'INVALID_PHONE' };
  const digits = s.replace(/\D/g, '');
  if (digits.length < 6 || digits.length > 16) return { ok: false, reason: 'INVALID_PHONE' };
  return { ok: true, value: s.replace(/\s{2,}/g, ' ') };
}

function domain(v) {
  const d = normalizeDomain(typeof v === 'string' ? v : '');
  return d.ok ? { ok: true, value: d.host } : { ok: false, reason: `INVALID_DOMAIN_${d.reason}` };
}

/** https URL on one of the allowed hosts (or their subdomains). No credentials, no odd ports. */
function profileUrl(hosts) {
  return (v) => {
    if (typeof v !== 'string') return { ok: false, reason: 'NOT_TEXT' };
    let u;
    try {
      u = new URL(v.trim());
    } catch {
      return { ok: false, reason: 'INVALID_URL' };
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'INVALID_URL' };
    if (u.username || u.password || (u.port && u.port !== '443' && u.port !== '80')) return { ok: false, reason: 'INVALID_URL' };
    const h = u.hostname.toLowerCase();
    if (!hosts.some((x) => h === x || h.endsWith(`.${x}`))) return { ok: false, reason: 'HOST_NOT_ALLOWED' };
    u.protocol = 'https:';
    u.hash = '';
    const out = u.toString();
    return out.length > 500 ? { ok: false, reason: 'TOO_LONG' } : { ok: true, value: out };
  };
}

const FIELDS = Object.freeze({
  'company.name': { normalize: text(300), leadField: 'name', untrusted: true },
  'company.website': { normalize: domain, leadField: 'website' },
  'company.phone': { normalize: phone, leadField: 'phone' },
  'company.email': { normalize: email, leadField: 'email' },
  'company.address': { normalize: text(500), leadField: 'address', untrusted: true },
  'company.city': { normalize: text(120), leadField: 'city', untrusted: true },
  'company.country': { normalize: text(120), leadField: 'country', untrusted: true },
  'company.industry': { normalize: text(200), leadField: 'industry', untrusted: true },
  'company.business_type': { normalize: text(200), leadField: 'business_type', untrusted: true },
  'company.description': { normalize: text(1000), untrusted: true },
  'social.facebook_url': { normalize: profileUrl(['facebook.com', 'fb.com']) },
  'social.instagram_url': { normalize: profileUrl(['instagram.com']) },
  'social.linkedin_url': { normalize: profileUrl(['linkedin.com']) },
  'website.platform': { normalize: text(120), untrusted: true },
  'website.language': { normalize: text(40), untrusted: true },
  'website.audited_domain': { normalize: domain },
});

const FIELD_NAMES = Object.freeze(Object.keys(FIELDS));
const FIELD_PATTERN = new RegExp(`^(?:${FIELD_NAMES.map((f) => f.replace(/\./g, '\\.')).join('|')})$`);

function normalizeFieldValue(field, value) {
  const def = FIELDS[field];
  if (!def) return { ok: false, reason: 'UNKNOWN_FIELD' };
  return def.normalize(value);
}

/** enriched field -> lead-view field (for ICP gap filling) */
const LEAD_FIELD_FOR = Object.freeze(Object.fromEntries(Object.entries(FIELDS).filter(([, d]) => d.leadField).map(([f, d]) => [f, d.leadField])));

module.exports = { FIELDS, FIELD_NAMES, FIELD_PATTERN, normalizeFieldValue, LEAD_FIELD_FOR };
