'use strict';

// G-39 / G-40 - ZuniSEO evidence mapping, proven against the REAL contract.
//
// The mapper used to understand only a flat/legacy alias dialect. A genuine
// ZuniSEO Evidence Envelope v1 therefore either threw MALFORMED_ENVELOPE, or -
// worse - produced a result with EVERY FACT AND EVERY FINDING DROPPED, because
// the real ids are `fact_id` / `finding_id` and the flat mapper looked for
// `key` / `id` / `rule_id`.
//
// These tests use ZuniSEO's OWN golden fixtures, vendored at
// tests/fixtures/zuni-seo/v1/ (copied read-only from the zuni-seo repository;
// the zuni-seo repository itself is never modified). They prove that genuine
// facts, findings, strengths, limitations, provenance and timestamps survive
// the mapping, that the contract's integrity rules are enforced, and that the
// Round-1 path and the native v1 path agree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const {
  mapZuniSeoEnvelope,
  mapZuniV1Envelope,
  isZuniSeoV1Envelope,
  assertZuniV1Integrity,
} = require('../../src/main/lead-intelligence/providers/envelopeMapper');
const { validateProviderResult } = require('../../src/main/lead-intelligence/providers/ProspectResearchProvider');
const { round1PacketMapper, detectDialect } = require('../../src/main/lead-intelligence/round1PacketMapper');
const { buildEvidencePacket, validateEvidencePacket } = require('../../src/main/lead-intelligence/contracts/evidencePacket');
const { RestTransport, IDEMPOTENCY_KEY_PATTERN } = require('../../src/main/lead-intelligence/providers/transports/RestTransport');

const FIXTURE_DIR = path.join(__dirname, '..', 'fixtures', 'zuni-seo', 'v1');
const CONTRACT_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'lead-intelligence', 'contracts', 'zuni-seo', 'v1');

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8'));
}

const CTX = { requestedDomain: 'harborlanebakery.test', providerJobId: 'job_test_1' };

/* --------------------------------------------------------------- dialect -- */

test('the vendored contract is the real research contract v1', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, 'contract.schema.json'), 'utf8'));
  assert.equal(schema.$id, 'https://zunitech.com/contracts/zuni-research/v1/contract.schema.json');
  assert.ok(schema.$defs.Envelope, 'the contract defines the Envelope');
  assert.ok(schema.$defs.Fact, 'the contract defines the Fact');
  assert.ok(schema.$defs.Finding, 'the contract defines the Finding');
});

test('the vendored contract and fixtures match their recorded hashes (G-41)', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(CONTRACT_DIR, 'contract.manifest.json'), 'utf8'));
  assert.ok(manifest && manifest.files && Object.keys(manifest.files).length >= 6, 'the manifest is present');
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const file = path.join(__dirname, '..', '..', rel);
    assert.ok(fs.existsSync(file), 'the vendored file exists: ' + rel);
    // The hash is of the COMMITTED bytes: the repository normalises text files
    // to LF, so the hash must be computed the same way the sync script
    // computes it, or the check fails on a fresh checkout and passes in the
    // working tree.
    const actual = crypto.createHash('sha256')
      .update(Buffer.from(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), 'utf8'))
      .digest('hex');
    assert.equal(actual, expected, 'the vendored file is unmodified: ' + rel);
  }
});

test('every vendored golden fixture is a v1 envelope and is detected as one', () => {
  for (const name of ['research_result.bakery.json', 'research_result.pypi.json', 'research_result.bakery.local.json']) {
    const env = fixture(name);
    assert.equal(isZuniSeoV1Envelope(env), true, name + ' is a v1 envelope');
    assert.equal(detectDialect(env), 'zuni-v1', name + ' is the v1 dialect');
    assert.equal(env.contract_version, '1.0');
  }
});

test('the flat/legacy dialect is NOT treated as v1', () => {
  assert.equal(isZuniSeoV1Envelope({ contract_version: 'zseo.evidence-envelope/1', engine: { version: '1' }, status: 'complete' }), false);
  assert.equal(isZuniSeoV1Envelope({ target: {}, coverage: {} }), false);
  assert.equal(isZuniSeoV1Envelope(null), false);
});

/* ----------------------------------------------------------------- facts -- */

test('a genuine v1 envelope keeps EVERY fact, with its statement, value and source', () => {
  const env = fixture('research_result.bakery.json');
  const r = mapZuniSeoEnvelope(env, CTX);

  assert.equal(r.facts.length, env.facts.length, 'no fact is dropped');
  const byId = new Map(r.facts.map((f) => [f.key, f]));
  for (const raw of env.facts) {
    const f = byId.get(raw.fact_id);
    assert.ok(f, 'fact survives: ' + raw.fact_id);
    // The ZTech EvidencePacket contract bounds a fact label at 300 characters,
    // so a longer statement is truncated - explicitly, and only there. The
    // provider's own excerpt is kept in full under `source.excerpt`.
    assert.equal(f.label, raw.statement.slice(0, 300), 'the statement is preserved (bounded by the packet contract)');
    assert.equal(f.value, raw.value, 'the value is preserved');
    assert.equal(f.sourceUrl, raw.source.url, 'the source url is preserved');
    assert.equal(f.source.type, raw.source.type, 'the source type is preserved');
    assert.equal(f.source.fetch_time, raw.source.fetch_time, 'the source fetch time is preserved');
    assert.equal(f.source.response_hash, raw.source.response_hash, 'the source response hash is preserved');
    assert.equal(f.source.excerpt, raw.source.excerpt, 'the source excerpt is preserved');
    assert.equal(f.untrusted, true, 'site text is marked untrusted');
  }
});

test('a genuine v1 envelope keeps EVERY finding, with its severity, basis and references', () => {
  const env = fixture('research_result.bakery.json');
  const r = mapZuniSeoEnvelope(env, CTX);

  assert.equal(r.findings.length, env.findings.length, 'no finding is dropped');
  const factIds = new Set(r.facts.map((f) => f.key));
  const byRule = new Map(r.findings.map((g) => [g.ruleId, g]));
  for (const raw of env.findings) {
    const g = byRule.get(raw.finding_id);
    assert.ok(g, 'finding survives: ' + raw.finding_id);
    assert.equal(g.title, raw.title);
    assert.equal(g.severity, raw.severity);
    assert.equal(g.basis, raw.basis, 'the genuine basis is preserved, not flattened');
    assert.equal(g.observed, raw.observation);
    assert.equal(g.recommendation, raw.recommendation);
    assert.deepEqual(g.urls, raw.affected_urls);
    assert.deepEqual(g.factKeys, raw.fact_ids.filter((id) => factIds.has(id)), 'the fact references resolve');
    for (const id of g.factKeys) assert.ok(factIds.has(id), 'referenced fact exists: ' + id);
  }
});

test('a genuine v1 envelope keeps strengths, not-measured items, limits and timestamps', () => {
  const env = fixture('research_result.bakery.json');
  const r = mapZuniSeoEnvelope(env, CTX);

  assert.equal(r.strengths.length, env.strengths.length, 'no strength is dropped');
  assert.equal(r.strengths[0].statement, env.strengths[0].statement);
  assert.equal(r.notMeasured.length, env.not_measured.length, 'no not-measured item is dropped');
  assert.ok(r.notMeasured[0].reason.includes(env.not_measured[0].item), 'the item is reported verbatim');
  assert.ok(r.notMeasured[0].reason.includes(env.not_measured[0].reason), 'the reason is reported verbatim');

  const limitMessages = r.limitations.map((l) => l.message);
  for (const limit of env.limits) {
    assert.ok(limitMessages.includes(limit), 'the limit survives: ' + limit.slice(0, 40));
  }

  assert.equal(r.capturedAt, new Date(env.run.captured_at).toISOString(), 'the capture time is preserved');
  assert.equal(r.engineVersion, env.run.engine_version, 'the engine version is preserved');
  assert.equal(r.contractVersion, env.contract_version, 'the contract version is preserved');
  assert.equal(r.outcome, 'complete', 'the run status is translated');
  assert.equal(r.requestedDomain, 'harborlanebakery.test');
  // The golden fixtures audit a loopback address, which the SSRF-safe domain
  // normaliser refuses, so no audited domain is claimed. Nothing is invented.
  assert.equal(r.auditedDomain, null, 'a loopback audited url yields no audited domain');
});

test('the completeness sections become areas, and an area ZTech has no home for becomes a limitation', () => {
  const env = fixture('research_result.bakery.json');
  const r = mapZuniSeoEnvelope(env, CTX);
  assert.equal(r.areas.technical, 'measured');
  assert.equal(r.areas.content, 'measured');

  const partial = JSON.parse(JSON.stringify(env));
  partial.completeness.ai_access = { status: 'partial', reason: 'robots.txt blocked' };
  const r2 = mapZuniSeoEnvelope(partial, CTX);
  assert.ok(
    r2.limitations.some((l) => l.code === 'PROVIDER_SECTION_INCOMPLETE' && l.message.includes('ai_access')),
    'an incomplete section ZTech has no area for is reported as a limitation',
  );
});

test('the provenance of the evidence becomes the source references', () => {
  const env = fixture('research_result.bakery.json');
  const r = mapZuniSeoEnvelope(env, CTX);
  const expected = new Set(env.facts.filter((f) => f.source.url).map((f) => `${f.source.type}|${f.source.url}`));
  assert.ok(expected.size > 0, 'the fixture has sourced facts');
  assert.equal(r.sourceReferences.length, expected.size, 'every distinct source becomes a reference');
  for (const ref of r.sourceReferences) {
    assert.ok(ref.url, 'a reference has a url');
    assert.ok(ref.kind, 'a reference has a kind');
  }
});

/* ----------------------------------------------------- the old behaviour -- */

test('REGRESSION PROOF: the flat mapper alone drops every fact and every finding of a v1 envelope', () => {
  const env = fixture('research_result.bakery.json');
  // The flat dialect is what the mapper used to understand. Fed a genuine v1
  // envelope it cannot read the ids, so the evidence disappears.
  const flat = {
    contract_version: env.contract_version,
    engine: { version: env.run.engine_version },
    status: env.run.status,
    captured_at: env.run.captured_at,
    target: { requested_url: env.subject.requested_url, final_url: env.subject.audited_url },
    coverage: {},
    facts: env.facts,
    findings: env.findings,
    strengths: env.strengths,
    not_measured: env.not_measured,
    limitations: [],
    sources: [],
  };
  const r = mapZuniSeoEnvelope(flat, CTX);
  assert.equal(r.facts.length, 0, 'the flat dialect still drops the facts - which is why v1 is mapped natively');
  assert.equal(r.findings.length, 0, 'the flat dialect still drops the findings');

  // And the native v1 mapping is the one that keeps them.
  const v1 = mapZuniV1Envelope(env, CTX);
  assert.equal(v1.facts.length, env.facts.length);
  assert.equal(v1.findings.length, env.findings.length);
});

/* --------------------------------------------------------- equivalence -- */

test('the native v1 mapping and the Round-1 path agree on the same real envelope', () => {
  const env = fixture('research_result.bakery.json');
  const native = mapZuniV1Envelope(env, CTX);
  // A Round-1 record carries the phase the bridge reported; the envelope's own
  // run status is the fallback.
  const round1 = round1PacketMapper(
    { result: env, phase: 'complete', domain: CTX.requestedDomain, providerJobId: CTX.providerJobId },
    CTX,
  );

  assert.deepEqual(
    round1.facts.map((f) => f.key).sort(),
    native.facts.map((f) => f.key).sort(),
    'the same fact identities',
  );
  assert.deepEqual(
    round1.findings.map((g) => g.ruleId).sort(),
    native.findings.map((g) => g.ruleId).sort(),
    'the same findings',
  );
  assert.deepEqual(
    round1.findings.map((g) => g.observed),
    native.findings.map((g) => g.observed),
    'the same observations',
  );
  assert.equal(round1.capturedAt, native.capturedAt, 'the same capture time');
  assert.equal(round1.engineVersion, native.engineVersion, 'the same engine version');
  assert.equal(round1.contractVersion, native.contractVersion, 'the same contract version');
  assert.equal(round1.outcome, native.outcome, 'the same outcome');
  assert.deepEqual(
    round1.sourceReferences.map((s) => `${s.kind}|${s.url}`).sort(),
    native.sourceReferences.map((s) => `${s.kind}|${s.url}`).sort(),
    'the same source references',
  );
  // `other` is a catch-all area: the Round-1 path fills it with a default, the
  // native path leaves it empty because no evidence belongs to it.
  const round1Areas = { ...round1.areas };
  delete round1Areas.other;
  assert.deepEqual(round1Areas, native.areas, 'the same measured areas');
});

/* ------------------------------------------------------------ integrity -- */

test('an envelope that breaks the contract integrity rules is rejected, not silently mapped', () => {
  const env = fixture('research_result.bakery.json');

  const dup = JSON.parse(JSON.stringify(env));
  dup.facts.push(JSON.parse(JSON.stringify(dup.facts[0])));
  assert.throws(() => assertZuniV1Integrity(dup), (e) => e.code === 'MALFORMED_ENVELOPE' && /duplicate fact id/.test(e.message));
  assert.throws(() => mapZuniSeoEnvelope(dup, CTX), (e) => e.code === 'MALFORMED_ENVELOPE');

  const dangling = JSON.parse(JSON.stringify(env));
  dangling.findings[0].fact_ids = ['f999'];
  assert.throws(() => mapZuniSeoEnvelope(dangling, CTX), (e) => e.code === 'MALFORMED_ENVELOPE' && /unknown fact/.test(e.message));

  const badCount = JSON.parse(JSON.stringify(env));
  badCount.findings[0].affected_url_count = 0;
  badCount.findings[0].affected_urls = ['https://x.test/a'];
  assert.throws(() => mapZuniSeoEnvelope(badCount, CTX), (e) => e.code === 'MALFORMED_ENVELOPE' && /fewer affected URLs/.test(e.message));
});

test('an unsupported contract version is refused rather than guessed at', () => {
  const env = fixture('research_result.bakery.json');
  const v2 = { ...env, contract_version: '2.0' };
  assert.throws(() => mapZuniSeoEnvelope(v2, CTX), (e) => e.code === 'MALFORMED_ENVELOPE' && /contract version/.test(e.message));
});

/* ------------------------------------------------------ packet building -- */

test('the mapped result builds a valid EvidencePacket that keeps the provenance', () => {
  const env = fixture('research_result.bakery.json');
  const result = mapZuniSeoEnvelope(env, CTX);
  const v = validateProviderResult(result);
  assert.equal(v.valid, true, JSON.stringify(v.errors));

  const packet = buildEvidencePacket({
    leadId: 'L1',
    jobId: 'rj_00000000-0000-4000-8000-000000000001',
    identity: { company_name: 'Harbor Lane Bakery', lead_domain: 'harborlanebakery.test', phone: null, city: null, country: null },
    provider: { id: 'zuni-seo', name: 'ZuniSEO' },
    result,
    freshness: { describe: () => ({ captured_at: result.capturedAt, expires_at: result.capturedAt, max_age_days: 30 }) },
    now: new Date('2026-01-02T00:00:00Z'),
  });

  const check = validateEvidencePacket(packet);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(packet.facts.length, env.facts.length, 'the packet keeps every fact');
  assert.equal(packet.findings.length, env.findings.length, 'the packet keeps every finding');
  assert.ok(packet.facts[0].source, 'the fact keeps its provider provenance');
  assert.ok(packet.source_references.length > 0, 'the packet keeps its source references');
  assert.ok(packet.findings.some((g) => g.what_it_means), 'the plain-language explanation survives');
  assert.ok(
    packet.findings.every((g) => g.fact_ids.length > 0),
    'every finding still resolves to its facts',
  );
});

/* -------------------------------------------------------------- G-39 -- */

test('G-39: the REST transport sends the idempotency key in the REQUEST BODY', async () => {
  const log = [];
  const base = 'https://seo.zunitech.example';
  const transport = new RestTransport({
    baseUrl: base,
    getToken: async () => 'secret-token',
    fetchImpl: async (url, init) => {
      log.push({ url, init });
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => JSON.stringify({ job_id: 'job_abc', status: 'queued' }) };
    },
  });

  const started = await transport.start({ url: 'https://harborlanebakery.test', idempotencyKey: 'rj_00000000-0000-4000-8000-000000000001' });
  assert.equal(started.jobId, 'job_abc');

  const post = log.find((l) => l.init.method === 'POST');
  const body = JSON.parse(post.init.body);
  assert.equal(body.idempotency_key, 'rj_00000000-0000-4000-8000-000000000001', 'the key is in the body, where the contract requires it');
  assert.equal(body.url, 'https://harborlanebakery.test');
  assert.equal(post.init.headers['Idempotency-Key'], 'rj_00000000-0000-4000-8000-000000000001', 'the header is kept as well');
});

test('G-39: a key that does not satisfy the contract is refused locally, with a clear error', async () => {
  const transport = new RestTransport({
    baseUrl: 'https://seo.zunitech.example',
    getToken: async () => 'secret-token',
    fetchImpl: async () => { throw new Error('the network must not be reached'); },
  });
  for (const bad of ['short', '', 'has spaces', 'x'.repeat(129), null, undefined]) {
    await assert.rejects(
      () => transport.start({ url: 'https://harborlanebakery.test', idempotencyKey: bad }),
      (e) => e.code === 'PROVIDER_CONFIG_INVALID' && e.blocking,
      'refused locally: ' + JSON.stringify(bad),
    );
  }
  assert.ok(IDEMPOTENCY_KEY_PATTERN.test('rj_00000000-0000-4000-8000-000000000001'));
});
