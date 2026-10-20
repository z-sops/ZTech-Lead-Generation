'use strict';

const { S, validate } = require('../core/validate');
const { FIELD_NAMES } = require('./catalog');

/**
 * EnrichmentProvider — provider-neutral contract. Adapters for real vendors are added
 * only after their API, terms and credentials are verified (see docs/IMPLEMENTATION_MAP.md §9).
 *
 * interface EnrichmentProvider {
 *   id: string
 *   name: string
 *   capabilities(): {
 *     fields: string[]                 // subset of catalog FIELD_NAMES
 *     tier: 'first_party'|'third_party'|'derived'
 *                                      // first_party: observed on the company's own property
 *                                      // third_party: a vendor/database record
 *                                      // derived: computed from other ZTech evidence
 *     requires: ('domain'|'name'|'phone'|'lead_id')[]   // inputs the provider needs
 *   }
 *   status(): Promise<{ state: 'READY'|'NOT_CONFIGURED'|'UNAVAILABLE', reason?: string }>
 *   enrich({ lead, fields, signal }): Promise<EnrichmentProviderResult>
 * }
 *
 * lead passed to providers is minimal: { lead_id, name, domain, phone, city, country }.
 * No email, notes or other personal data is sent to providers.
 *
 * Errors: throw ProviderError. retryable -> retried with backoff; blocking (auth/quota/
 * config) -> this provider is skipped for the job; anything else -> step failed. In all
 * cases the waterfall continues with the next provider (failure isolation).
 */

const TIERS = Object.freeze(['first_party', 'third_party', 'derived']);
const TIER_RANK = Object.freeze({ first_party: 0, third_party: 1, derived: 2 });
const INPUTS = Object.freeze(['domain', 'name', 'phone', 'lead_id']);
const PROVIDER_STATES = Object.freeze(['READY', 'NOT_CONFIGURED', 'UNAVAILABLE']);

const CAPABILITIES_SCHEMA = {
  type: 'object',
  required: ['fields', 'tier', 'requires'],
  properties: {
    fields: { type: 'array', minItems: 1, maxItems: FIELD_NAMES.length, uniqueItems: true, items: { type: 'string', enum: FIELD_NAMES } },
    tier: { type: 'string', enum: TIERS },
    requires: { type: 'array', maxItems: INPUTS.length, uniqueItems: true, items: { type: 'string', enum: INPUTS } },
  },
  additionalProperties: false,
};

const RESULT_SCHEMA = {
  type: 'object',
  required: ['fields'],
  properties: {
    provider_ref: S.nullableText(200),
    fields: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['field', 'status'],
        properties: {
          field: { type: 'string', maxLength: 100 },
          status: { type: 'string', enum: ['FOUND', 'NOT_FOUND'] },
          value: { anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'number' }, { type: 'null' }] },
          source_ref: S.nullableText(2048),
          provider_confidence: {
            type: 'object',
            nullable: true,
            required: ['value', 'scale'],
            properties: { value: { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 50 }] }, scale: { type: 'string', minLength: 1, maxLength: 100 } },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function assertEnrichmentProvider(p) {
  if (!p || typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_.-]{0,62}$/.test(p.id) || typeof p.name !== 'string') {
    throw new TypeError('enrichment provider needs a lowercase id and a name');
  }
  for (const m of ['capabilities', 'status', 'enrich']) {
    if (typeof p[m] !== 'function') throw new TypeError(`enrichment provider ${p.id} is missing ${m}()`);
  }
  const errors = validate(CAPABILITIES_SCHEMA, p.capabilities());
  if (errors.length) throw new TypeError(`enrichment provider ${p.id} has invalid capabilities: ${errors[0].path} ${errors[0].message}`);
  return p;
}

function validateEnrichmentResult(r) {
  const errors = validate(RESULT_SCHEMA, r);
  return { valid: errors.length === 0, errors };
}

module.exports = { TIERS, TIER_RANK, INPUTS, PROVIDER_STATES, CAPABILITIES_SCHEMA, RESULT_SCHEMA, assertEnrichmentProvider, validateEnrichmentResult };
