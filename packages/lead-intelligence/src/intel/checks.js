'use strict';

/**
 * The website checks: what is inspected, how sure each one can be, and which
 * service it points to.
 *
 * Rules every check follows (they are what keeps false positives out):
 *   1. A check reports a problem only from something it OBSERVED on the page
 *      or in an HTTP response, and it quotes that observation as evidence.
 *   2. When the page could not be read (not HTML, an error page, too short),
 *      the content checks do not run at all: "could not tell" is never
 *      reported as "missing".
 *   3. Every check carries a fixed confidence and, where one measurement can
 *      mislead, a caveat that travels with the finding into the proposal.
 *
 * The confidences are deliberately conservative and documented in
 * docs/PHASE-2-INTELLIGENCE.md; the evaluation pages under
 * tests/fixtures/phase2-sites hold them to account.
 */

const { metaContent } = require('./html');

const SEVERITY_WEIGHT = Object.freeze({ high: 1, medium: 0.6, low: 0.3 });

/**
 * id -> definition. `category` is the offer category the finding points to.
 */
const CHECKS = Object.freeze({
  NO_WEBSITE: {
    area: 'presence', severity: 'high', confidence: 0.6, category: 'web_design',
    title: 'No website listed',
    problem: 'Customers searching online find no website for the business.',
    caveat: 'The public listing may simply be incomplete; confirm before relying on it.',
  },
  SITE_UNREACHABLE: {
    area: 'technical', severity: 'high', confidence: 0.6, category: 'performance',
    title: 'Website did not respond',
    problem: 'Visitors may not be able to open the website at all.',
    caveat: 'Observed once from our server; the outage may be temporary.',
  },
  SITE_ERROR: {
    area: 'technical', severity: 'high', confidence: 0.7, category: 'web_design',
    title: 'Website home page returns an error',
    problem: 'The address customers are given shows an error instead of the business.',
    caveat: 'Observed once from our server.',
  },
  NO_HTTPS: {
    area: 'security', severity: 'high', confidence: 0.85, category: 'security',
    title: 'No working HTTPS',
    problem: 'Browsers mark the website "Not secure", which puts visitors off.',
    caveat: null,
  },
  HTTP_NOT_REDIRECTED: {
    area: 'security', severity: 'low', confidence: 0.8, category: 'security',
    title: 'HTTP address does not redirect to HTTPS',
    problem: 'Visitors who type the plain address land on the insecure version.',
    caveat: null,
  },
  MIXED_CONTENT: {
    area: 'security', severity: 'medium', confidence: 0.85, category: 'security',
    title: 'Secure page loads insecure files',
    problem: 'Browsers block or warn about insecure files on a secure page.',
    caveat: null,
  },
  SLOW_RESPONSE: {
    area: 'performance', severity: 'medium', confidence: 0.5, category: 'performance',
    title: 'Slow home page response',
    problem: 'A slow first response loses visitors, especially on mobile.',
    caveat: 'One measurement from our server; real visitors may see different times.',
  },
  NOINDEX: {
    area: 'seo', severity: 'high', confidence: 0.95, category: 'seo',
    title: 'Home page tells search engines not to index it',
    problem: 'The home page asks search engines to leave it out of results.',
    caveat: null,
  },
  MISSING_TITLE: {
    area: 'seo', severity: 'medium', confidence: 0.9, category: 'seo',
    title: 'Missing page title',
    problem: 'Search results show no meaningful title for the business.',
    caveat: null,
  },
  MISSING_META_DESCRIPTION: {
    area: 'seo', severity: 'low', confidence: 0.85, category: 'seo',
    title: 'Missing meta description',
    problem: 'Search engines pick their own snippet, often a poor one.',
    caveat: null,
  },
  MISSING_H1: {
    area: 'seo', severity: 'low', confidence: 0.7, category: 'seo',
    title: 'No main heading (H1)',
    problem: 'The page does not state clearly, in a heading, what the business does.',
    caveat: 'Some page builders render headings with scripts after load.',
  },
  MISSING_VIEWPORT: {
    area: 'usability', severity: 'high', confidence: 0.85, category: 'web_design',
    title: 'Not set up for mobile screens',
    problem: 'On phones the page shows as a shrunken desktop page.',
    caveat: null,
  },
  NO_STRUCTURED_DATA: {
    area: 'seo', severity: 'low', confidence: 0.7, category: 'local_seo',
    title: 'No business details for search engines (structured data)',
    problem: 'Search engines cannot read the address, hours and contact details reliably.',
    caveat: 'Structured data added by scripts after load is not seen.',
  },
  NO_CONTACT_PATH: {
    area: 'conversion', severity: 'medium', confidence: 0.6, category: 'booking',
    title: 'No visible way to contact the business',
    problem: 'Visitors find no phone link, email link, contact form or contact page on the home page.',
    caveat: 'The contact details may be on another page that was not inspected.',
  },
  NO_ONLINE_BOOKING: {
    area: 'conversion', severity: 'medium', confidence: 0.5, category: 'booking',
    title: 'No online booking on the home page',
    problem: 'Customers who want to book have to call during opening hours.',
    caveat: 'Booking may be offered on another page or through a third party not linked from the home page.',
  },
  IMAGES_MISSING_ALT: {
    area: 'accessibility', severity: 'low', confidence: 0.8, category: 'accessibility',
    title: 'Most images have no text alternative',
    problem: 'Screen-reader users and search engines cannot tell what the images show.',
    caveat: null,
  },
  STALE_COPYRIGHT: {
    area: 'content', severity: 'low', confidence: 0.55, category: 'web_design',
    title: 'Copyright year is several years old',
    problem: 'An old year suggests the website has not been looked after.',
    caveat: 'An old year alone does not prove the content is out of date.',
  },
  NO_SITEMAP: {
    area: 'seo', severity: 'low', confidence: 0.7, category: 'seo',
    title: 'No sitemap',
    problem: 'Search engines get no list of the pages to index.',
    caveat: null,
  },
});

const SLOW_MS = 3000;
const MIN_TEXT_FOR_CONTENT_CHECKS = 80;

function excerpt(s, max = 240) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * The content checks over one readable home page.
 * @param {object} doc readHtml() result
 * @param {{url: string, elapsedMs: number, industryBooking: boolean, nowYear: number}} ctx
 * @returns {Array<{check_id: string, method: string, excerpt: string}>}
 */
function contentChecks(doc, ctx) {
  const out = [];
  const add = (check_id, method, text) => out.push({ check_id, method, excerpt: excerpt(text) });

  const robotsMeta = metaContent(doc, 'robots');
  if (robotsMeta && /\bnoindex\b/i.test(robotsMeta)) {
    add('NOINDEX', 'meta[name=robots]', `<meta name="robots" content="${robotsMeta}">`);
  }
  if (!doc.title) add('MISSING_TITLE', 'html <title>', 'The page has no <title> element, or it is empty.');
  const description = metaContent(doc, 'description');
  if (description === null || description === '') {
    add('MISSING_META_DESCRIPTION', 'meta[name=description]', 'No <meta name="description"> with content was found in the page.');
  }
  if (doc.h1.length === 0) add('MISSING_H1', 'html <h1>', 'The page contains no <h1> element.');
  if (metaContent(doc, 'viewport') === null) {
    add('MISSING_VIEWPORT', 'meta[name=viewport]', 'No <meta name="viewport"> was found; mobile browsers render the desktop layout.');
  }

  const hasLdJson = doc.scripts.some((s) => /ld\+json/i.test(s.attrs.type || ''));
  const hasMicrodata = doc.tags.some((t) => Object.prototype.hasOwnProperty.call(t.attrs, 'itemscope'));
  if (!hasLdJson && !hasMicrodata) {
    add('NO_STRUCTURED_DATA', 'script[type=application/ld+json], [itemscope]', 'Neither JSON-LD nor microdata was found in the page.');
  }

  const hrefs = doc.links.map((l) => l.href.toLowerCase());
  const hasTel = hrefs.some((h) => h.startsWith('tel:'));
  const hasMail = hrefs.some((h) => h.startsWith('mailto:'));
  const hasForm = doc.tags.some((t) => t.name === 'form');
  const hasContactLink = doc.links.some((l) => /contact|get in touch|enquir/i.test(`${l.href} ${l.text}`));
  if (!hasTel && !hasMail && !hasForm && !hasContactLink) {
    add('NO_CONTACT_PATH', 'links and forms on the home page', 'No tel: link, mailto: link, form or link to a contact page was found.');
  }

  if (ctx.industryBooking) {
    const bookingRe = /\b(book|booking|appointment|reserv|schedule a|order online)/i;
    const hasBooking = doc.links.some((l) => bookingRe.test(`${l.href} ${l.text}`))
      || doc.tags.some((t) => (t.name === 'iframe' || t.name === 'script') && /calendly|opentable|resdiary|fresha|booksy|setmore|acuityscheduling|simplybook|zocdoc|dentally|treatwell|mindbodyonline|square\.site|bookings/i.test(t.attrs.src || ''));
    if (!hasBooking) {
      add('NO_ONLINE_BOOKING', 'links and embedded booking tools on the home page', 'No link or embedded tool for booking, appointments or reservations was found.');
    }
  }

  const images = doc.tags.filter((t) => t.name === 'img');
  if (images.length >= 5) {
    const missing = images.filter((t) => !Object.prototype.hasOwnProperty.call(t.attrs, 'alt')).length;
    if (missing / images.length > 0.5) {
      add('IMAGES_MISSING_ALT', 'img[alt]', `${missing} of ${images.length} images have no alt attribute.`);
    }
  }

  if (ctx.url.startsWith('https://')) {
    const insecure = [];
    for (const t of doc.tags) {
      const ref = ['img', 'script', 'iframe', 'audio', 'video', 'source'].includes(t.name) ? t.attrs.src
        : t.name === 'link' && /stylesheet/i.test(t.attrs.rel || '') ? t.attrs.href : null;
      if (typeof ref === 'string' && /^http:\/\//i.test(ref.trim())) insecure.push(`<${t.name}> ${ref.trim()}`);
    }
    if (insecure.length) {
      add('MIXED_CONTENT', 'resource URLs on a secure page', `${insecure.length} insecure file(s), e.g. ${insecure[0]}`);
    }
  }

  const years = [...doc.text.matchAll(/(?:©|\(c\)|copyright)\s*(?:\d{4}\s*[-–]\s*)?(\d{4})/gi)].map((m) => Number(m[1]));
  if (years.length) {
    const latest = Math.max(...years);
    if (latest >= 1995 && latest <= ctx.nowYear - 3) {
      add('STALE_COPYRIGHT', 'copyright notice in the page text', `Copyright year on the page: ${latest}.`);
    }
  }
  return out;
}

module.exports = {
  CHECKS, SEVERITY_WEIGHT, SLOW_MS, MIN_TEXT_FOR_CONTENT_CHECKS, contentChecks, excerpt,
};
