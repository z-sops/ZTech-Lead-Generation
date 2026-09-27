'use strict';

const { S, validate } = require('../core/validate');
const { AREAS, AREA_STATUS, PACKET_OUTCOMES, SEVERITIES, BASES } = require('../contracts/constants');

/**
 * ProspectResearchProvider — the only contract the research coordinator knows.
 * The gateway/coordinator never see MCP, REST or file details.
 *
 * interface ProspectResearchProvider {
 *   id: string                         // e.g. "zuni-seo", "zuni-seo-artifact", "fake"
 *   name: string                       // display name
 *   preflight({ domain }): Promise<{ ok: boolean, retryable?: boolean, blocking?: boolean, code?: string }>
 *   startResearch({ domain, idempotencyKey, options }): Promise<{ providerJobId: string, status: 'running'|'complete'|'partial'|'failed' }>
 *   pollResearch(providerJobId): Promise<{ status: 'running'|'complete'|'partial'|'failed' }>
 *   fetchResult(providerJobId, { requestedDomain }): Promise<ProviderResult>
 * }
 *
 * Errors: throw ProviderError (core/errors) with retryable/blocking flags.
 */

const PROVIDER_METHODS = ['preflight', 'startResearch', 'pollResearch', 'fetchResult'];
const PROVIDER_JOB_STATUSES = ['running', 'complete', 'partial', 'failed'];

function assertProvider(p) {
  if (!p || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string') {
    throw new TypeError('provider must have string id and name');
  }
  for (const m of PROVIDER_METHODS) {
    if (typeof p[m] !== 'function') throw new TypeError(`provider ${p.id} is missing ${m}()`);
  }
  return p;
}

const scalar = {
  anyOf: [{ type: 'string', maxLength: 5000 }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }],
};

/** Normalized provider output. Built by a provider's mapper; validated before use. */
const PROVIDER_RESULT_SCHEMA = {
  type: 'object',
  required: [
    'requestedDomain', 'auditedDomain', 'redirectChain', 'outcome', 'capturedAt', 'engineVersion',
    'contractVersion', 'providerJobId', 'areas', 'facts', 'findings', 'strengths', 'notMeasured',
    'limitations', 'sourceReferences',
  ],
  properties: {
    requestedDomain: S.text(253),
    auditedDomain: S.nullableText(253),
    redirectChain: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        required: ['url', 'status'],
        properties: { url: S.text(2048), status: { type: 'integer', minimum: 0, maximum: 999, nullable: true } },
        additionalProperties: false,
      },
    },
    outcome: { type: 'string', enum: PACKET_OUTCOMES },
    capturedAt: S.isoDate,
    engineVersion: { type: 'string', minLength: 1, maxLength: 100 },
    contractVersion: { type: 'string', minLength: 1, maxLength: 100 },
    providerJobId: { type: 'string', minLength: 1, maxLength: 200 },
    areas: {
      type: 'object',
      maxProperties: AREAS.length,
      properties: Object.fromEntries(AREAS.map((a) => [a, { type: 'string', enum: AREA_STATUS }])),
      additionalProperties: false,
    },
    facts: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        required: ['key', 'area', 'value'],
        properties: {
          key: { type: 'string', minLength: 1, maxLength: 200, pattern: /^[A-Za-z0-9_.:-]+$/ },
          area: { type: 'string', enum: AREAS },
          label: S.text(300),
          value: scalar,
          sourceUrl: S.nullableText(2048),
          untrusted: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    findings: {
      type: 'array',
      maxItems: 1000,
      items: {
        type: 'object',
        required: ['ruleId', 'area', 'title', 'severity', 'basis', 'observed'],
        properties: {
          ruleId: { type: 'string', minLength: 1, maxLength: 200, pattern: /^[A-Za-z0-9_.:-]+$/ },
          area: { type: 'string', enum: AREAS },
          title: { type: 'string', minLength: 1, maxLength: 300 },
          severity: { type: 'string', enum: SEVERITIES },
          basis: { type: 'string', enum: BASES },
          observed: S.text(4000),
          recommendation: S.text(4000),
          urls: S.stringList(50, 2048),
          factKeys: S.stringList(50, 200),
        },
        additionalProperties: false,
      },
    },
    strengths: {
      type: 'array',
      maxItems: 200,
      items: {
        type: 'object',
        required: ['statement', 'area'],
        properties: {
          statement: { type: 'string', minLength: 1, maxLength: 1000 },
          area: { type: 'string', enum: AREAS },
          factKeys: S.stringList(50, 200),
          ruleIds: S.stringList(50, 200),
        },
        additionalProperties: false,
      },
    },
    notMeasured: {
      type: 'array',
      maxItems: 50,
      items: {
        type: 'object',
        required: ['area', 'reason'],
        properties: { area: { type: 'string', enum: AREAS }, reason: S.text(1000) },
        additionalProperties: false,
      },
    },
    limitations: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        required: ['code', 'message'],
        properties: { code: S.text(100), message: S.text(1000) },
        additionalProperties: false,
      },
    },
    sourceReferences: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        required: ['url', 'kind'],
        properties: { url: S.text(2048), kind: S.text(50) },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
};

function validateProviderResult(result) {
  const errors = validate(PROVIDER_RESULT_SCHEMA, result);
  return { valid: errors.length === 0, errors };
}

module.exports = {
  PROVIDER_METHODS,
  PROVIDER_JOB_STATUSES,
  PROVIDER_RESULT_SCHEMA,
  assertProvider,
  validateProviderResult,
};
