'use strict';

const { FOOTPRINT, FACT_KEYS } = require('../contracts/constants');

/**
 * Factual digital-footprint classification.
 *
 * Scope is ALWAYS stated: Zuni-SEO audits one website. Social profiles, marketplaces,
 * directories and maps listings are not checked, so no state here means
 * "the company has no online presence".
 */

const DEFAULT_LIMITED_PAGE_THRESHOLD = 3;

function scopeText(domain) {
  if (!domain) {
    return 'No website was researched. Social profiles, marketplaces, directories and maps listings were not checked.';
  }
  return `Covers the website ${domain} only. Social profiles, marketplaces, directories and maps listings were not checked.`;
}

function factByKey(packet, key) {
  return (packet.facts || []).find((f) => f.key === key) || null;
}

/**
 * @param {{packet?: object|null, leadView?: object|null, limitedPageThreshold?: number}} input
 * @returns {{state: string, scope: string, reasons: string[], fact_ids: string[]}}
 */
function computeDigitalFootprint({ packet = null, leadView = null, limitedPageThreshold = DEFAULT_LIMITED_PAGE_THRESHOLD } = {}) {
  if (!packet) {
    if (leadView && !leadView.has_website) {
      return {
        state: FOOTPRINT.NO_WEBSITE,
        scope: scopeText(null),
        reasons: ['No website URL is recorded for this lead. This does not mean the company has no online presence.'],
        fact_ids: [],
      };
    }
    return {
      state: FOOTPRINT.NOT_CHECKED,
      scope: scopeText(null),
      reasons: ['Website research has not been run for this lead.'],
      fact_ids: [],
    };
  }

  const domain = packet.audited_domain || packet.requested_domain;
  const scope = scopeText(domain);
  const reach = factByKey(packet, FACT_KEYS.HTTP_REACHABLE);
  const status = factByKey(packet, FACT_KEYS.HTTP_FINAL_STATUS);
  const pages = factByKey(packet, FACT_KEYS.CRAWL_HTML_PAGES);

  if (reach && reach.value === false) {
    const ids = [reach.fact_id];
    if (status) ids.push(status.fact_id);
    const detail = status && status.value !== null ? ` (last HTTP status ${status.value})` : '';
    return {
      state: FOOTPRINT.SITE_UNREACHABLE,
      scope,
      reasons: [`The website ${domain} could not be reached during research${detail}.`],
      fact_ids: ids,
    };
  }

  if (packet.research_status === 'failed') {
    const unreachable = (packet.limitations || []).some((l) => l.code === 'SITE_UNREACHABLE');
    if (unreachable) {
      return {
        state: FOOTPRINT.SITE_UNREACHABLE,
        scope,
        reasons: [`The research provider reported that ${domain} could not be reached.`],
        fact_ids: [],
      };
    }
    return {
      state: FOOTPRINT.RESEARCH_FAILED,
      scope,
      reasons: ['Research did not return a usable result. Nothing is concluded about the website.'],
      fact_ids: [],
    };
  }

  const pageCount = pages && typeof pages.value === 'number' ? pages.value : null;

  if (packet.research_status === 'partial') {
    const reasons = ['Research returned only part of the requested evidence.'];
    if (pageCount !== null) reasons.push(`${pageCount} crawlable HTML page(s) were collected.`);
    return { state: FOOTPRINT.RESEARCH_PARTIAL, scope, reasons, fact_ids: pages ? [pages.fact_id] : [] };
  }

  if (pageCount === null) {
    return {
      state: FOOTPRINT.RESEARCH_PARTIAL,
      scope,
      reasons: ['The research provider did not report a crawlable page count.'],
      fact_ids: [],
    };
  }

  const ids = [pages.fact_id];
  if (reach) ids.push(reach.fact_id);
  if (pageCount === 0) {
    return {
      state: FOOTPRINT.NO_CRAWLABLE_CONTENT,
      scope,
      reasons: [`The website ${domain} responded but 0 crawlable HTML pages were collected.`],
      fact_ids: ids,
    };
  }
  if (pageCount < limitedPageThreshold) {
    return {
      state: FOOTPRINT.LIMITED_DIGITAL_FOOTPRINT,
      scope,
      reasons: [
        `The website ${domain} responded and ${pageCount} crawlable HTML page(s) were collected (fewer than ${limitedPageThreshold}).`,
      ],
      fact_ids: ids,
    };
  }
  return {
    state: FOOTPRINT.DIGITAL_FOOTPRINT_FOUND,
    scope,
    reasons: [`The website ${domain} responded and ${pageCount} crawlable HTML pages were collected.`],
    fact_ids: ids,
  };
}

module.exports = { computeDigitalFootprint, DEFAULT_LIMITED_PAGE_THRESHOLD };
