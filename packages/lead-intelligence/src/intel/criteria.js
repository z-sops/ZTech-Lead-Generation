'use strict';

/**
 * Phase 2 research criteria: what a customer asks the research to find.
 *
 * A research job names an INDUSTRY from a fixed list (each one maps to the
 * exact OpenStreetMap tags that identify such a business, so discovery never
 * guesses from a free-text category), a LOCATION (a place name the geocoder
 * resolves), the services the customer SELLS (offer categories), and a few
 * hard requirements. Everything is validated here, once, and the same
 * validator is used by the API (to refuse a bad request with a 400) and by
 * the worker (which never trusts a payload it did not validate itself).
 */

/** Industries the discovery can identify reliably, with their OSM tags. */
const INDUSTRIES = Object.freeze({
  dentist: { label: 'Dentists', osm: [['amenity', 'dentist']], booking: true },
  clinic: { label: 'Clinics and doctors', osm: [['amenity', 'clinic'], ['amenity', 'doctors']], booking: true },
  physiotherapist: { label: 'Physiotherapists', osm: [['healthcare', 'physiotherapist']], booking: true },
  veterinary: { label: 'Veterinary clinics', osm: [['amenity', 'veterinary']], booking: true },
  pharmacy: { label: 'Pharmacies', osm: [['amenity', 'pharmacy']], booking: false },
  restaurant: { label: 'Restaurants', osm: [['amenity', 'restaurant']], booking: true },
  cafe: { label: 'Cafes', osm: [['amenity', 'cafe']], booking: false },
  hotel: { label: 'Hotels', osm: [['tourism', 'hotel']], booking: true },
  hair_salon: { label: 'Hair salons', osm: [['shop', 'hairdresser']], booking: true },
  beauty_salon: { label: 'Beauty salons', osm: [['shop', 'beauty']], booking: true },
  gym: { label: 'Gyms and fitness centres', osm: [['leisure', 'fitness_centre']], booking: true },
  plumber: { label: 'Plumbers', osm: [['craft', 'plumber']], booking: false },
  electrician: { label: 'Electricians', osm: [['craft', 'electrician']], booking: false },
  car_repair: { label: 'Car repair garages', osm: [['shop', 'car_repair']], booking: true },
  lawyer: { label: 'Law firms', osm: [['office', 'lawyer']], booking: false },
  accountant: { label: 'Accountants', osm: [['office', 'accountant']], booking: false },
  estate_agent: { label: 'Estate agents', osm: [['office', 'estate_agent']], booking: false },
});

/** What the customer sells. Every detected need belongs to exactly one. */
const OFFER_CATEGORIES = Object.freeze({
  web_design: 'Website design and rebuilds',
  seo: 'Search engine optimisation (on-page)',
  local_seo: 'Local SEO and business listings',
  performance: 'Website speed and hosting',
  security: 'HTTPS and website security',
  booking: 'Online booking and contact flows',
  accessibility: 'Accessibility',
});

const WEBSITE_FILTERS = Object.freeze(['any', 'with_website', 'without_website']);

const LIMITS = Object.freeze({ minResults: 1, maxResults: 25, defaultResults: 10, locationMax: 120, notesMax: 500 });

class CriteriaError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'CriteriaError';
    this.code = 'invalid_criteria';
    this.field = field;
  }
}

function cleanText(value, max) {
  // One line, no control characters, bounded.
  return String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate and normalise research criteria.
 * @param {object} input
 * @returns {{industry: string, location: string, offer_categories: string[], website_filter: string, max_results: number, notes: string}}
 * @throws {CriteriaError}
 */
function validateCriteria(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CriteriaError('criteria', 'the research criteria must be an object');
  }
  const industry = typeof input.industry === 'string' ? input.industry.trim().toLowerCase() : '';
  if (!Object.prototype.hasOwnProperty.call(INDUSTRIES, industry)) {
    throw new CriteriaError('industry', `the industry must be one of: ${Object.keys(INDUSTRIES).join(', ')}`);
  }
  const location = typeof input.location === 'string' ? cleanText(input.location, LIMITS.locationMax) : '';
  if (location.length < 2) {
    throw new CriteriaError('location', 'the location must name a place, for example "Manchester, UK"');
  }
  let offers = input.offer_categories;
  if (!Array.isArray(offers) || offers.length === 0) {
    throw new CriteriaError('offer_categories', 'choose at least one service you offer');
  }
  offers = [...new Set(offers.map((o) => String(o).trim().toLowerCase()))];
  const unknown = offers.filter((o) => !Object.prototype.hasOwnProperty.call(OFFER_CATEGORIES, o));
  if (unknown.length) {
    throw new CriteriaError('offer_categories', `unknown service(s): ${unknown.join(', ')}`);
  }
  offers.sort();
  const websiteFilter = input.website_filter === undefined ? 'any' : String(input.website_filter);
  if (!WEBSITE_FILTERS.includes(websiteFilter)) {
    throw new CriteriaError('website_filter', `the website filter must be one of: ${WEBSITE_FILTERS.join(', ')}`);
  }
  let maxResults = input.max_results === undefined ? LIMITS.defaultResults : Number(input.max_results);
  if (!Number.isInteger(maxResults) || maxResults < LIMITS.minResults || maxResults > LIMITS.maxResults) {
    throw new CriteriaError('max_results', `the number of businesses must be a whole number from ${LIMITS.minResults} to ${LIMITS.maxResults}`);
  }
  const notes = input.notes === undefined || input.notes === null ? '' : cleanText(input.notes, LIMITS.notesMax);
  return {
    industry,
    location,
    offer_categories: offers,
    website_filter: websiteFilter,
    max_results: maxResults,
    notes,
  };
}

/** The choices a browser form needs, in display order. */
function criteriaOptions() {
  return {
    industries: Object.entries(INDUSTRIES).map(([id, v]) => ({ id, label: v.label })),
    offer_categories: Object.entries(OFFER_CATEGORIES).map(([id, label]) => ({ id, label })),
    website_filters: [...WEBSITE_FILTERS],
    limits: { ...LIMITS },
  };
}

module.exports = {
  INDUSTRIES, OFFER_CATEGORIES, WEBSITE_FILTERS, LIMITS, CriteriaError, validateCriteria, criteriaOptions,
};
