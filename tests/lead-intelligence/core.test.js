'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validate, assertValid } = require('../../src/main/lead-intelligence/core/validate');
const { normalizeDomain, validateServiceBaseUrl } = require('../../src/main/lead-intelligence/core/urls');
const { scrubSecrets } = require('../../src/main/lead-intelligence/core/objects');
const { publicError, ProviderError, LiError } = require('../../src/main/lead-intelligence/core/errors');

test('validate: rejects unknown keys and prototype-pollution keys', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
  assert.equal(validate(schema, { a: 'x' }).length, 0);
  assert.ok(validate(schema, { a: 'x', b: 1 }).some((e) => e.message === 'is not allowed'));
  const polluted = JSON.parse('{"a":"x","__proto__":{"admin":true}}');
  assert.ok(validate(schema, polluted).some((e) => e.message === 'forbidden key'));
});

test('validate: types, enum, length, anyOf, nullable', () => {
  assert.equal(validate({ type: 'integer', minimum: 1 }, 0).length, 1);
  assert.equal(validate({ type: 'string', enum: ['a'] }, 'b').length, 1);
  assert.equal(validate({ type: 'string', maxLength: 2 }, 'abc').length, 1);
  assert.equal(validate({ anyOf: [{ type: 'string' }, { type: 'integer' }] }, 5).length, 0);
  assert.equal(validate({ type: 'string', nullable: true }, null).length, 0);
  assert.throws(() => assertValid({ type: 'object', required: ['x'], properties: {} }, {}), /invalid/);
});

test('normalizeDomain: accepts public domains and strips www for the key', () => {
  assert.deepEqual(normalizeDomain('https://www.Example.com/about?x=1'), { ok: true, host: 'www.example.com', key: 'example.com' });
  assert.equal(normalizeDomain('gamma-clinic.pk').key, 'gamma-clinic.pk');
  assert.equal(normalizeDomain('münchen.de').ok, true);
});

test('normalizeDomain: rejects unsafe or non-public targets', () => {
  for (const [input, reason] of [
    ['http://127.0.0.1', 'IP_ADDRESS'],
    ['http://2130706433', 'IP_ADDRESS'],
    ['http://[::1]/', 'IP_ADDRESS'],
    ['localhost', 'NOT_A_PUBLIC_DOMAIN'],
    ['intranet.corp', 'PRIVATE_OR_RESERVED_DOMAIN'],
    ['http://user:pass@example.com', 'CREDENTIALS_IN_URL'],
    ['javascript:alert(1)', 'UNSUPPORTED_SCHEME'],
    ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'],
    ['https://example.com:8443', 'NON_STANDARD_PORT'],
    ['', 'EMPTY'],
  ]) {
    const r = normalizeDomain(input);
    assert.equal(r.ok, false, input);
    assert.equal(r.reason, reason, input);
  }
});

test('validateServiceBaseUrl: https only; localhost only when allowed', () => {
  assert.equal(validateServiceBaseUrl('https://api.zunitech.example/').base, 'https://api.zunitech.example');
  assert.equal(validateServiceBaseUrl('http://api.zunitech.example').reason, 'HTTPS_REQUIRED');
  assert.equal(validateServiceBaseUrl('http://127.0.0.1:8765').reason, 'LOCALHOST_NOT_ALLOWED');
  assert.equal(validateServiceBaseUrl('http://127.0.0.1:8765', { allowLocalhost: true }).ok, true);
  assert.equal(validateServiceBaseUrl('https://a.example/?token=x').ok, false);
  assert.equal(validateServiceBaseUrl('https://user:pw@a.example').reason, 'CREDENTIALS_IN_URL');
});

test('scrubSecrets removes secret-like keys at any depth', () => {
  const out = scrubSecrets({ a: 1, apiKey: 'k', nested: { password: 'p', ok: [{ token: 't', v: 2 }] }, Authorization: 'Bearer x' });
  assert.deepEqual(out, { a: 1, nested: { ok: [{ v: 2 }] } });
});

test('publicError never exposes unknown error text', () => {
  assert.deepEqual(publicError(new Error('SELECT * FROM secrets')), { code: 'INTERNAL_ERROR', message: 'Internal error' });
  assert.equal(publicError(new ProviderError('PROVIDER_AUTH', 'rejected')).code, 'PROVIDER_AUTH');
  assert.equal(publicError(new LiError('X', 'y')).message, 'y');
});
