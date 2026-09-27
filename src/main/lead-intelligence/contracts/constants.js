'use strict';

/** Canonical ZTech contract version for EvidencePacket. Bump on breaking change. */
const PACKET_CONTRACT_VERSION = 'ztech.evidence-packet/1';

const RESEARCH_STATES = Object.freeze([
  'requested', // job row created
  'preflight', // identity/domain/provider checks
  'started', // provider accepted; provider_job_id stored
  'polling', // waiting for provider result
  'complete', // packet stored, all requested areas returned
  'partial', // packet stored, some areas missing
  'failed', // no usable result (or provider reported failure)
  'pending', // temporary failure; will retry at next_attempt_at
  'stale', // result exists but is older than freshness policy
  'blocked', // cannot run: missing identity/domain, config or credentials
]);

const ACTIVE_STATES = Object.freeze(['requested', 'preflight', 'started', 'polling', 'pending']);
const RESULT_STATES = Object.freeze(['complete', 'partial']);

const AREAS = Object.freeze(['identity', 'technical', 'content', 'visibility', 'crawl', 'other']);
const AREA_STATUS = Object.freeze(['measured', 'not_measured', 'failed']);
const PACKET_OUTCOMES = Object.freeze(['complete', 'partial', 'failed']);
const COMPLETENESS_LEVELS = Object.freeze(['complete', 'partial', 'none']);

const SEVERITIES = Object.freeze(['critical', 'high', 'medium', 'low', 'info']);
/** Zuni-SEO finding basis: standard / research / heuristic. `unknown` when not provided. */
const BASES = Object.freeze(['standard', 'research', 'heuristic', 'unknown']);

const FOOTPRINT = Object.freeze({
  NOT_CHECKED: 'NOT_CHECKED',
  NO_WEBSITE: 'NO_WEBSITE',
  SITE_UNREACHABLE: 'SITE_UNREACHABLE',
  NO_CRAWLABLE_CONTENT: 'NO_CRAWLABLE_CONTENT',
  LIMITED_DIGITAL_FOOTPRINT: 'LIMITED_DIGITAL_FOOTPRINT',
  DIGITAL_FOOTPRINT_FOUND: 'DIGITAL_FOOTPRINT_FOUND',
  RESEARCH_PARTIAL: 'RESEARCH_PARTIAL',
  RESEARCH_FAILED: 'RESEARCH_FAILED',
});
const FOOTPRINT_STATES = Object.freeze(Object.values(FOOTPRINT));

const FIT = Object.freeze({ FIT: 'fit', NOT_FIT: 'not_fit', UNKNOWN: 'unknown' });
const FIT_STATUSES = Object.freeze(Object.values(FIT));

/**
 * Canonical ZTech fact keys produced by the envelope mapper.
 * Other provider facts are kept under their own key with a "zseo." prefix.
 */
const FACT_KEYS = Object.freeze({
  HTTP_REACHABLE: 'http.reachable',
  HTTP_FINAL_STATUS: 'http.final_status',
  CRAWL_HTML_PAGES: 'crawl.html_pages',
  TLS_VALID: 'tls.valid',
  TECH_PLATFORM: 'tech.platform',
  SITE_TITLE: 'site.title',
  SITE_LANGUAGE: 'site.language',
});

module.exports = {
  PACKET_CONTRACT_VERSION,
  RESEARCH_STATES,
  ACTIVE_STATES,
  RESULT_STATES,
  AREAS,
  AREA_STATUS,
  PACKET_OUTCOMES,
  COMPLETENESS_LEVELS,
  SEVERITIES,
  BASES,
  FOOTPRINT,
  FOOTPRINT_STATES,
  FIT,
  FIT_STATUSES,
  FACT_KEYS,
};
