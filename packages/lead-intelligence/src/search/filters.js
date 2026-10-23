'use strict';

const { S, assertValid } = require('../core/validate');
const { FIT_STATUSES, FOOTPRINT_STATES, RESEARCH_STATES } = require('../contracts/constants');

/**
 * Filter definition shared by Saved Searches and Dynamic Segments.
 * All dimensions are optional; an empty filter matches every lead.
 * Matching is case-insensitive for text values.
 */
const PRESENCE = ['any', 'present', 'absent'];
const textList = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 120 } };

const FILTER_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string', maxLength: 200 },
    target_id: S.leadId,
    location: {
      type: 'object',
      properties: { cities: textList, countries: textList },
      additionalProperties: false,
    },
    industries: textList,
    business_types: textList,
    website: { type: 'string', enum: PRESENCE },
    phone: { type: 'string', enum: PRESENCE },
    email: { type: 'string', enum: PRESENCE },
    data_quality: textList,
    qualification: textList,
    icp_fit: { type: 'array', maxItems: 3, uniqueItems: true, items: { type: 'string', enum: FIT_STATUSES } },
    research_status: { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', enum: [...RESEARCH_STATES, 'not_researched', 'unknown'] } },
    digital_footprint: { type: 'array', maxItems: 8, uniqueItems: true, items: { type: 'string', enum: FOOTPRINT_STATES } },
  },
  additionalProperties: false,
};

function assertFilter(filter) {
  assertValid(FILTER_SCHEMA, filter, 'filter');
  if (filter.icp_fit && filter.icp_fit.length && (filter.target_id === undefined || filter.target_id === null)) {
    throw new TypeError('filter.icp_fit requires filter.target_id');
  }
  return filter;
}

const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
const inList = (value, list) => list.map(lc).includes(lc(value));

function presence(mode, has) {
  if (!mode || mode === 'any') return true;
  return mode === 'present' ? has : !has;
}

/**
 * @param {object} filter validated filter
 * @param {{view: object, research_state: string, footprint_state: string, icp_fit: object|null}} ctx
 * @returns {{matched: boolean, failed: string[]}}
 */
function matchLead(filter, ctx) {
  const v = ctx.view;
  const failed = [];
  const check = (name, ok) => { if (!ok) failed.push(name); };

  if (filter.text && filter.text.trim()) {
    const q = filter.text.trim().toLowerCase();
    const hay = [v.name, v.city, v.country, v.industry, v.business_type, v.website, v.email, v.phone].filter(Boolean).join(' ').toLowerCase();
    check('text', hay.includes(q));
  }
  if (filter.location) {
    if (filter.location.cities && filter.location.cities.length) check('location.cities', inList(v.city, filter.location.cities));
    if (filter.location.countries && filter.location.countries.length) check('location.countries', inList(v.country, filter.location.countries));
  }
  if (filter.industries && filter.industries.length) check('industries', inList(v.industry, filter.industries));
  if (filter.business_types && filter.business_types.length) check('business_types', inList(v.business_type, filter.business_types));
  check('website', presence(filter.website, v.has_website));
  check('phone', presence(filter.phone, v.has_phone));
  check('email', presence(filter.email, v.has_email));
  if (filter.data_quality && filter.data_quality.length) check('data_quality', inList(v.data_quality, filter.data_quality));
  if (filter.qualification && filter.qualification.length) check('qualification', inList(v.qualification_status, filter.qualification));
  if (filter.icp_fit && filter.icp_fit.length) check('icp_fit', Boolean(ctx.icp_fit) && filter.icp_fit.includes(ctx.icp_fit.fitStatus));
  if (filter.research_status && filter.research_status.length) check('research_status', filter.research_status.includes(ctx.research_state));
  if (filter.digital_footprint && filter.digital_footprint.length) check('digital_footprint', filter.digital_footprint.includes(ctx.footprint_state));

  return { matched: failed.length === 0, failed };
}

/** Row returned to the renderer for search/segment results (no lead copies stored). */
function resultRow(ctx) {
  return {
    lead_id: ctx.view.id,
    name: ctx.view.name,
    city: ctx.view.city,
    industry: ctx.view.industry,
    website: ctx.view.website,
    research_state: ctx.research_state,
    digital_footprint: ctx.footprint_state,
    icp_fit_status: ctx.icp_fit ? ctx.icp_fit.fitStatus : null,
    packet_id: ctx.packet_meta ? ctx.packet_meta.packet_id : null,
  };
}

module.exports = { FILTER_SCHEMA, assertFilter, matchLead, resultRow };
