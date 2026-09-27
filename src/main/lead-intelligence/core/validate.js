'use strict';

const { ValidationError } = require('./errors');

/**
 * Minimal JSON-schema-like validator with no dependencies.
 * Supported: type (string, integer, number, boolean, array, object, null, any),
 * enum, minLength, maxLength, pattern, minimum, maximum, items, minItems, maxItems,
 * uniqueItems, properties, required, additionalProperties (false or schema),
 * maxProperties, nullable, anyOf.
 *
 * Every object is checked for prototype-pollution keys.
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && Number.isInteger(v)) return 'integer';
  return typeof v;
}

function validate(schema, value, path = '$', errors = []) {
  if (!schema) {
    errors.push({ path, message: 'schema missing' });
    return errors;
  }
  if (schema.anyOf) {
    for (const s of schema.anyOf) {
      if (validate(s, value, path, []).length === 0) return errors;
    }
    errors.push({ path, message: 'does not match any allowed shape' });
    return errors;
  }
  if (value === null && schema.nullable) return errors;
  if (value === undefined) {
    errors.push({ path, message: 'is required' });
    return errors;
  }
  const t = typeOf(value);
  switch (schema.type) {
    case 'any':
      break;
    case 'null':
      if (t !== 'null') errors.push({ path, message: 'must be null' });
      break;
    case 'string':
      if (t !== 'string') {
        errors.push({ path, message: 'must be a string' });
        break;
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push({ path, message: `must have at least ${schema.minLength} characters` });
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push({ path, message: `must have at most ${schema.maxLength} characters` });
      }
      if (schema.pattern && !schema.pattern.test(value)) {
        errors.push({ path, message: 'has an invalid format' });
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push({ path, message: 'is not an allowed value' });
      }
      break;
    case 'integer':
    case 'number':
      if (schema.type === 'integer' ? t !== 'integer' : typeof value !== 'number' || !Number.isFinite(value)) {
        errors.push({ path, message: `must be ${schema.type === 'integer' ? 'an integer' : 'a number'}` });
        break;
      }
      if (schema.minimum !== undefined && value < schema.minimum) errors.push({ path, message: `must be >= ${schema.minimum}` });
      if (schema.maximum !== undefined && value > schema.maximum) errors.push({ path, message: `must be <= ${schema.maximum}` });
      if (schema.enum && !schema.enum.includes(value)) errors.push({ path, message: 'is not an allowed value' });
      break;
    case 'boolean':
      if (t !== 'boolean') errors.push({ path, message: 'must be a boolean' });
      break;
    case 'array':
      if (t !== 'array') {
        errors.push({ path, message: 'must be an array' });
        break;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push({ path, message: `must have at least ${schema.minItems} items` });
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push({ path, message: `must have at most ${schema.maxItems} items` });
        break;
      }
      if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`, errors));
      if (schema.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
        errors.push({ path, message: 'must not contain duplicates' });
      }
      break;
    case 'object': {
      if (t !== 'object') {
        errors.push({ path, message: 'must be an object' });
        break;
      }
      const keys = Object.keys(value);
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k)) errors.push({ path: `${path}.${k}`, message: 'forbidden key' });
      }
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
        errors.push({ path, message: `must have at most ${schema.maxProperties} properties` });
        break;
      }
      const props = schema.properties || {};
      for (const r of schema.required || []) {
        if (value[r] === undefined) errors.push({ path: `${path}.${r}`, message: 'is required' });
      }
      for (const [k, s] of Object.entries(props)) {
        if (value[k] !== undefined) validate(s, value[k], `${path}.${k}`, errors);
      }
      for (const k of keys) {
        if (FORBIDDEN_KEYS.has(k) || Object.prototype.hasOwnProperty.call(props, k)) continue;
        if (schema.additionalProperties === false) {
          errors.push({ path: `${path}.${k}`, message: 'is not allowed' });
        } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
          validate(schema.additionalProperties, value[k], `${path}.${k}`, errors);
        }
      }
      break;
    }
    default:
      errors.push({ path, message: 'schema error: unknown type' });
  }
  return errors;
}

function assertValid(schema, value, label = 'input') {
  const errors = validate(schema, value);
  if (errors.length) throw new ValidationError(`${label} is invalid`, errors.slice(0, 50));
  return value;
}

/* Common reusable schema fragments */
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const S = {
  id: { type: 'string', pattern: ID_PATTERN },
  leadId: { anyOf: [{ type: 'string', pattern: ID_PATTERN }, { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }] },
  isoDate: { type: 'string', maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/ },
  shortText: { type: 'string', maxLength: 200 },
  text: (max) => ({ type: 'string', maxLength: max }),
  nullableText: (max) => ({ type: 'string', maxLength: max, nullable: true }),
  stringList: (maxItems, maxLength) => ({ type: 'array', maxItems, items: { type: 'string', maxLength } }),
};

module.exports = { validate, assertValid, typeOf, FORBIDDEN_KEYS, ID_PATTERN, S };
