'use strict';

/**
 * The timestamp and JSON conversions (M1, acceptance criterion 4).
 *
 * "Every timestamp and JSON conversion is covered by a test, including the
 * malformed cases."
 *
 * The desktop keeps a timestamp as the ISO text the caller gave it, and a JSON
 * document as TEXT. PostgreSQL keeps an instant and a document. The two
 * engines therefore do not store the same thing, and the conversion between
 * them has to be exact - and it has to be defined for the values that are
 * NOT well formed.
 *
 * The rules:
 *
 *   a timestamp   a well-formed ISO instant survives unchanged; a value that
 *                 is not an instant becomes NULL and is reported, never
 *                 guessed at;
 *   a JSON value  a document survives unchanged; a document that is not JSON
 *                 becomes NULL and is reported; a plain string is a value,
 *                 not a document, and is kept as a string.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { canonicalIso, toInstant, encodeValue, decodeValue, rewritePlaceholders } = require('../../packages/lead-intelligence-postgres/src/dialect');

test('a well-formed timestamp survives the conversion unchanged', () => {
  const iso = '2026-09-01T00:00:00.000Z';
  const encoded = encodeValue('li_research_jobs', 'created_at', iso);
  assert.equal(encoded.corrupt, false);
  assert.ok(encoded.value instanceof Date);
  assert.equal(encoded.value.toISOString(), iso);
  const decoded = decodeValue('li_research_jobs', 'created_at', encoded.value);
  assert.equal(decoded.value, iso, 'the same string comes back');
  assert.equal(decoded.corrupt, false);
});

test('a timestamp without milliseconds is normalised to the canonical form', () => {
  const decoded = decodeValue('li_research_jobs', 'created_at', new Date('2026-09-01T00:00:00Z'));
  assert.equal(decoded.value, '2026-09-01T00:00:00.000Z');
});

test('a malformed timestamp is refused, not guessed at', () => {
  for (const bad of ['not a date', '2026-13-45', '', '   ', 'tomorrow']) {
    const encoded = encodeValue('li_research_jobs', 'created_at', bad);
    if (bad === '') {
      assert.equal(encoded.value, null);
      assert.equal(encoded.corrupt, false, 'an empty timestamp is an absent one, not a corrupt one');
      continue;
    }
    assert.equal(encoded.value, null, `"${bad}" is not stored as an instant`);
    assert.equal(encoded.corrupt, true, `"${bad}" is reported`);
  }
  assert.equal(toInstant('not a date'), null);
  assert.equal(canonicalIso('not a date'), null);
});

test('an absent timestamp is absent, not corrupt', () => {
  for (const empty of [null, undefined, '']) {
    const encoded = encodeValue('li_research_jobs', 'updated_at', empty);
    assert.equal(encoded.value, null);
    assert.equal(encoded.corrupt, false);
  }
});

test('a JSON document survives the conversion unchanged', () => {
  const doc = { a: 1, b: ['x', 'y'], c: { d: true } };
  const encoded = encodeValue('li_evidence_packets', 'packet_json', doc);
  assert.equal(encoded.corrupt, false);
  assert.equal(encoded.value, JSON.stringify(doc));
  const decoded = decodeValue('li_evidence_packets', 'packet_json', JSON.parse(encoded.value));
  assert.deepEqual(decoded.value, doc);
  assert.equal(decoded.corrupt, false);
});

test('a JSON array is a document too', () => {
  const encoded = encodeValue('li_enrichment_jobs', 'fields_json', ['email', 'phone']);
  assert.equal(encoded.corrupt, false);
  assert.equal(encoded.value, '["email","phone"]');
  const decoded = decodeValue('li_enrichment_jobs', 'fields_json', ['email', 'phone']);
  assert.deepEqual(decoded.value, ['email', 'phone']);
});

test('a plain string is a value, not a document', () => {
  const encoded = encodeValue('li_enrichment_observations', 'value_json', 'a@b.test');
  assert.equal(encoded.corrupt, false);
  assert.equal(encoded.value, '"a@b.test"');
  const decoded = decodeValue('li_enrichment_observations', 'value_json', 'a@b.test');
  assert.equal(decoded.value, 'a@b.test', 'the value comes back as the string it was');
});

test('a value that is not JSON is never stored as a document', () => {
  const circular = {};
  circular.self = circular;
  const encoded = encodeValue('li_evidence_packets', 'packet_json', circular);
  assert.equal(encoded.value, null);
  assert.equal(encoded.corrupt, true, 'it is reported');
});

test('the store reports a document that is not an object', { skip: !process.env.ZTECH_PG_URL && 'set ZTECH_PG_URL to test the store against a real PostgreSQL' }, async () => {
  const { Pool } = require('pg');
  const { PostgresStore } = require('../../packages/lead-intelligence-postgres/src/PostgresStore');
  const URL = process.env.ZTECH_PG_URL;
  const pool = new Pool({ connectionString: URL, options: '-c search_path=li_conv' });
  const admin = new Pool({ connectionString: URL });
  await admin.query('DROP SCHEMA IF EXISTS li_conv CASCADE');
  await admin.query('CREATE SCHEMA li_conv');
  const store = new PostgresStore({ pool, workspaceId: '11111111-1111-4111-8111-111111111111', logger: { warn() {} } });
  await store.migrate();
  await store.packets.insert({
    packet_id: 'pkt_1', lead_id: 'L1', job_id: 'rjob_1', research_status: 'complete',
    digital_footprint: { state: 'clean' }, requested_domain: 'acme.test',
    captured_at: '2026-09-01T00:00:00.000Z', freshness: { expires_at: '2026-09-02T00:00:00.000Z' }, created_at: '2026-09-01T00:00:00.000Z',
    facts: [], findings: [], strengths: [], not_measured: [], limitations: [], source_references: [],
  });
  // A document that is valid JSON but not a packet.
  await store.run("UPDATE li_evidence_packets SET packet_json = '\"not a packet\"'::jsonb WHERE packet_id = 'pkt_1'");
  const read = await store.packets.get('pkt_1');
  assert.equal(read, null, 'the row is not trusted');
  assert.ok(store.corruptRows.length > 0, 'the corrupt row is reported');
  await admin.query('DROP SCHEMA IF EXISTS li_conv CASCADE');
  await pool.end();
  await admin.end();
});

test('the placeholders are rewritten, and a question mark in a literal is left alone', () => {
  assert.equal(rewritePlaceholders('SELECT * FROM t WHERE a = ? AND b = ?'), 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.equal(rewritePlaceholders("SELECT '?' FROM t WHERE a = ?"), "SELECT '?' FROM t WHERE a = $1");
  assert.equal(rewritePlaceholders('SELECT 1'), 'SELECT 1');
});

test('the 0/1 flags keep their shape', () => {
  const encoded = encodeValue('li_contact_provenance', 'backfilled', 1);
  assert.equal(encoded.value, true);
  const decoded = decodeValue('li_contact_provenance', 'backfilled', true);
  assert.equal(decoded.value, 1, 'the application sees the same 0/1 it always did');
});
