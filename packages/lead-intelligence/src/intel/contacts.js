'use strict';

/**
 * Contact details a business publishes itself: emails, phone numbers and
 * social profile links, read from its own web pages (and its public map
 * listing). Only what the business put there; nothing guessed, no address
 * built from a name.
 *
 * An email is "generic" when its first part is a role (info@, reception@,
 * hello@ ...) and "named" otherwise, because a named address may belong to a
 * person: in the UK, sending marketing email to a sole trader or a
 * partnership needs consent (PECR), so the screen says which is which.
 */

const GENERIC_LOCAL = /^(info|hello|hi|contact|contactus|enquiries|enquiry|inquiries|reception|admin|office|bookings?|appointments?|support|sales|team|mail|post|practice|clinic|surgery|frontdesk|help|accounts|marketing|care|smile|dental|dentist|service|customerservice|general)$/i;
const JUNK_DOMAIN = /(^|\.)(example\.(com|org|net)|domain\.com|email\.com|sentry\.io|sentry-next\.wixpress\.com|wixpress\.com|godaddy\.com|yourdomain\.com|test\.com)$/i;
const ASSET_SUFFIX = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js)$/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,24}/g;
const MAX_EACH = 10;

const SOCIAL = [
  ['instagram', /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:[?#].*)?$/i, (h) => `https://www.instagram.com/${h}/`, /^(p|reel|reels|explore|accounts|stories|tv|share)$/i],
  ['facebook', /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/((?:profile\.php\?id=\d+)|[A-Za-z0-9.\-]{2,80})\/?(?:[?#].*)?$/i, (h) => `https://www.facebook.com/${h}`, /^(sharer|sharer\.php|share|dialog|plugins|tr|events|groups|watch|login|policies|help)$/i],
  ['linkedin', /^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(company\/[A-Za-z0-9\-_%]{2,100})\/?(?:[?#].*)?$/i, (h) => `https://www.linkedin.com/${h}`, /^$/],
  ['tiktok', /^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]{2,24})\/?(?:[?#].*)?$/i, (h) => `https://www.tiktok.com/@${h}`, /^$/],
  ['x', /^https?:\/\/(?:www\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i, (h) => `https://x.com/${h}`, /^(share|intent|home|search|i)$/i],
  ['youtube', /^https?:\/\/(?:www\.)?youtube\.com\/((?:@|channel\/|c\/|user\/)[A-Za-z0-9._\-]{2,100})\/?(?:[?#].*)?$/i, (h) => `https://www.youtube.com/${h}`, /^$/],
];

function hostKey(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

function classifyEmail(address, siteHost) {
  const [local, domain] = address.split('@');
  return {
    address,
    kind: GENERIC_LOCAL.test(local) ? 'generic' : 'named',
    same_domain: Boolean(siteHost && (domain === siteHost || domain.endsWith(`.${siteHost}`) || siteHost.endsWith(`.${domain}`))),
  };
}

function cleanEmail(raw) {
  const e = String(raw).trim().replace(/^mailto:/i, '').split('?')[0].replace(/[.,;:]+$/, '').toLowerCase();
  if (!/^[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,24}$/.test(e)) return null;
  const domain = e.split('@')[1];
  if (JUNK_DOMAIN.test(domain) || ASSET_SUFFIX.test(e)) return null;
  return e;
}

function cleanPhone(raw) {
  const p = decodeURIComponent(String(raw)).replace(/^tel:/i, '').replace(/[^\d+]/g, '');
  const digits = p.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15 ? p : null;
}

/**
 * Contacts on one page.
 * @param {object} doc readHtml() result
 * @param {string} pageUrl
 * @returns {{emails: object[], phones: object[], socials: object}}
 */
function contactsFromPage(doc, pageUrl) {
  const siteHost = hostKey(pageUrl);
  const emails = new Map();
  const phones = new Map();
  const socials = {};
  const addEmail = (raw) => {
    const e = cleanEmail(raw);
    if (e && !emails.has(e)) emails.set(e, { ...classifyEmail(e, siteHost), source_url: pageUrl });
  };
  for (const l of doc.links) {
    const href = l.href.trim();
    if (/^mailto:/i.test(href)) addEmail(href);
    else if (/^tel:/i.test(href)) {
      const p = cleanPhone(href);
      if (p && !phones.has(p)) phones.set(p, { number: p, source_url: pageUrl });
    } else if (/^https?:\/\//i.test(href)) {
      for (const [network, re, canonical, skip] of SOCIAL) {
        if (socials[network]) continue;
        const m = re.exec(href);
        if (m && !skip.test(m[1].split('/').pop())) {
          const handle = m[1];
          socials[network] = { handle: handle.replace(/^company\//, '').replace(/^@/, ''), url: canonical(handle), source_url: pageUrl };
        }
      }
    }
  }
  // Emails written as text (some sites never link them). Bounded scan.
  for (const m of doc.text.slice(0, 200000).matchAll(EMAIL_RE)) addEmail(m[0]);
  return {
    emails: [...emails.values()].slice(0, MAX_EACH),
    phones: [...phones.values()].slice(0, MAX_EACH),
    socials,
  };
}

/** Merge contact sets; the first source of each item wins. */
function mergeContacts(...sets) {
  const emails = new Map();
  const phones = new Map();
  const socials = {};
  for (const s of sets) {
    if (!s) continue;
    for (const e of s.emails || []) if (!emails.has(e.address)) emails.set(e.address, e);
    for (const p of s.phones || []) if (!phones.has(p.number)) phones.set(p.number, p);
    for (const [k, v] of Object.entries(s.socials || {})) if (!socials[k]) socials[k] = v;
  }
  const order = (e) => (e.kind === 'generic' ? 0 : 1) + (e.same_domain ? 0 : 2);
  return {
    emails: [...emails.values()].sort((a, b) => order(a) - order(b) || a.address.localeCompare(b.address)).slice(0, MAX_EACH),
    phones: [...phones.values()].slice(0, MAX_EACH),
    socials,
  };
}

/** Contacts from a public map listing (OSM tags), attributed to it. */
function contactsFromListing(business) {
  const out = { emails: [], phones: [], socials: {} };
  const host = business.website ? hostKey(business.website.startsWith('http') ? business.website : `https://${business.website}`) : null;
  if (business.email) {
    const e = cleanEmail(business.email);
    if (e) out.emails.push({ ...classifyEmail(e, host), source_url: business.source_url });
  }
  if (business.phone) {
    const p = cleanPhone(business.phone);
    if (p) out.phones.push({ number: p, source_url: business.source_url });
  }
  for (const [network, value] of Object.entries(business.social_tags || {})) {
    if (!value) continue;
    const v = String(value).trim();
    const url = /^https?:\/\//i.test(v) ? v : null;
    if (network === 'instagram') {
      const handle = url ? (SOCIAL[0][1].exec(url) || [])[1] : v.replace(/^@/, '');
      if (handle && /^[A-Za-z0-9._]{1,30}$/.test(handle)) out.socials.instagram = { handle, url: `https://www.instagram.com/${handle}/`, source_url: business.source_url };
    } else if (network === 'facebook' && url) {
      out.socials.facebook = { handle: url.replace(/^https?:\/\/(www\.)?facebook\.com\//i, '').replace(/\/$/, ''), url, source_url: business.source_url };
    }
  }
  return out;
}

/** The link to a contact page on the same site, if the home page has one. */
function contactPageUrl(doc, pageUrl) {
  const base = new URL(pageUrl);
  for (const l of doc.links) {
    if (!/contact|get-in-touch|getintouch|find-us|enquir/i.test(`${l.href} ${l.text}`)) continue;
    let u;
    try {
      u = new URL(l.href, base);
    } catch {
      continue;
    }
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname === base.hostname && u.pathname !== base.pathname) {
      u.hash = '';
      return u.toString();
    }
  }
  return null;
}

module.exports = { contactsFromPage, contactsFromListing, mergeContacts, contactPageUrl, classifyEmail, cleanEmail };
