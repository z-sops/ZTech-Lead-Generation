'use strict';

// M0 - the extraction regression suite.
//
// The extraction moved the portable Lead Intelligence domain and application
// modules into the shared package `@zunitech/lead-intelligence`
// (packages/lead-intelligence) and left a compatibility shim at every original
// path. These tests prove that:
//
//   1. the shared core has NO forbidden dependency (Electron, the file system,
//      a child process, the OS credential store) and never reaches outside
//      itself;
//   2. every compatibility shim re-exports the SAME module instance as the
//      package, so there is exactly ONE implementation of the intelligence
//      engine and object identity is preserved;
//   3. the package's public export surface is the expected one;
//   4. the behaviour of the extracted rules is unchanged;
//   5. the database schema is untouched.
//
// A source-text assertion is the only way to check (1) and (2) across 96
// files, so this file reads the package's source deliberately.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const packageRoot = path.join(root, 'packages', 'lead-intelligence');
const packageSrc = path.join(packageRoot, 'src');
const legacyRoot = path.join(root, 'src', 'main', 'lead-intelligence');

const FORBIDDEN = new Set(['electron', 'electron-store', 'fs', 'node:fs', 'child_process', 'node:child_process']);
/** Node built-ins a server may legitimately use. */
const ALLOWED_BUILTINS = new Set([
  'path', 'node:path', 'crypto', 'node:crypto', 'url', 'node:url', 'util', 'node:util',
  'os', 'node:os', 'http', 'node:http', 'https', 'node:https', 'net', 'node:net',
  'buffer', 'node:buffer', 'events', 'node:events', 'stream', 'node:stream', 'zlib', 'node:zlib',
]);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rel(p) {
  return path.relative(root, p).split(path.sep).join('/');
}

/**
 * Is `child` inside `boundary`? Both are absolute paths.
 *
 * The comparison is on the resolved path, with a trailing separator added to
 * the boundary, so a sibling directory that merely shares a prefix
 * (`packages/lead-intelligence-evil`) is NOT inside
 * `packages/lead-intelligence`.
 */
function isInside(boundary, child) {
  const b = boundary.endsWith(path.sep) ? boundary : boundary + path.sep;
  return child === boundary || child.startsWith(b);
}

/**
 * The boundary guard itself, as a function, so that it can be exercised
 * against a deliberately escaping import (the regression test below) and not
 * only against the package as it is today.
 *
 * @param {string[]} files the files to check
 * @param {string} boundary the absolute directory the files may not leave
 * @param {string} label how the violations are described
 * @returns {string[]} the violations, empty when the files are clean
 */
function findBoundaryViolations(files, boundary, label) {
  const violations = [];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
      const target = m[2];
      if (target.startsWith('.')) {
        // A relative require must stay inside the boundary. The resolution is
        // done against the ABSOLUTE path of the requiring file, so an import
        // that leaves the package but stays inside the repository is a
        // violation too - which a check against the repository root alone
        // would not catch.
        const resolved = path.resolve(path.dirname(file), target);
        const asFile = fs.existsSync(resolved) && fs.statSync(resolved).isFile()
          ? resolved
          : (fs.existsSync(`${resolved}.js`) ? `${resolved}.js` : resolved);
        if (!isInside(boundary, asFile)) {
          violations.push(`${rel(file)} reaches outside ${label}: ${target}`);
        }
        continue;
      }
      if (FORBIDDEN.has(target)) {
        violations.push(`${rel(file)} requires the forbidden module '${target}'`);
        continue;
      }
      if (!target.startsWith('node:') && !ALLOWED_BUILTINS.has(target) && !target.includes('/')) {
        // A bare specifier that is not a Node built-in would be an external
        // dependency, which the shared core may not have.
        violations.push(`${rel(file)} requires the external module '${target}'`);
      }
    }
  }
  return violations;
}

test('the shared package exists, is named correctly, and declares no dependencies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@zunitech/lead-intelligence');
  assert.equal(pkg.main, 'src/index.js');
  assert.deepEqual(pkg.dependencies || {}, {}, 'the shared core has no runtime dependencies');
  assert.ok(fs.existsSync(path.join(packageSrc, 'index.js')), 'the public entry point exists');
});

test('the shared core has NO forbidden dependency and never reaches outside itself', () => {
  const violations = findBoundaryViolations(walk(packageSrc), packageSrc, 'the shared package');
  assert.deepEqual(violations, [], 'the shared core is free of Electron, file-system, process and external dependencies');
});

test('the boundary guard REJECTS a relative import that leaves the package', () => {
  // A regression test for the guard itself. A file inside the package that
  // requires something outside it must be reported - including when the
  // target is still inside the repository, which a check against the
  // repository root alone would not catch.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'm0-boundary-'));
  const inside = path.join(scratch, 'src', 'core');
  fs.mkdirSync(inside, { recursive: true });
  fs.mkdirSync(path.join(scratch, 'src', 'secret'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'src', 'secret', 'credentials.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(scratch, 'outside.js'), 'module.exports = {};\n');

  const escaping = path.join(inside, 'leaker.js');
  fs.writeFileSync(escaping, "module.exports = require('../../secret/credentials');\n");
  const outOfRepo = path.join(inside, 'outOfRepo.js');
  fs.writeFileSync(outOfRepo, "module.exports = require('../../../outside');\n");
  const clean = path.join(inside, 'clean.js');
  fs.writeFileSync(clean, "const { x } = require('../shared/ids');\nmodule.exports = x;\n");

  const boundary = path.join(scratch, 'src');
  const violations = findBoundaryViolations([escaping, outOfRepo, clean], boundary, 'the package');

  assert.ok(violations.some((v) => v.includes('leaker.js') && v.includes('../../secret/credentials')),
    'an import that leaves the package is reported');
  assert.ok(violations.some((v) => v.includes('outOfRepo.js')),
    'an import that leaves the package and the repository is reported');
  assert.ok(!violations.some((v) => v.includes('clean.js')),
    'an import that stays inside the package is not reported');

  fs.rmSync(scratch, { recursive: true, force: true });
});

test('every moved module has a compatibility shim, and the shim re-exports the SAME instance', () => {
  const moved = fs.readFileSync(path.join(packageRoot, 'MOVED.md'), 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('- `'))
    .map((l) => l.replace(/^- `/, '').replace(/`$/, ''));

  assert.ok(moved.length >= 90, `the inventory is recorded (${moved.length} modules)`);

  const problems = [];
  for (const m of moved) {
    const shim = path.join(legacyRoot, m);
    const impl = path.join(packageSrc, m);
    if (!fs.existsSync(shim)) { problems.push(`${m}: no compatibility shim`); continue; }
    if (!fs.existsSync(impl)) { problems.push(`${m}: no implementation in the package`); continue; }
    const shimSource = fs.readFileSync(shim, 'utf8');
    if (!shimSource.includes('M0 compatibility shim')) {
      problems.push(`${m}: the shim is not marked as a compatibility shim`);
    }
    if (/function |class |=>/.test(shimSource.replace(/\/\/.*$/gm, ''))) {
      problems.push(`${m}: the shim appears to contain logic of its own`);
    }
    // The same instance: identity is what proves there is one implementation.
     
    if (require(shim) !== require(impl)) {
      problems.push(`${m}: the shim and the package resolve to different instances`);
    }
  }
  assert.deepEqual(problems, [], 'every moved module is reachable at its original path, by identity');
});

test('the compatibility shim is a re-export and nothing more', () => {
  const shim = path.join(legacyRoot, 'core', 'ids.js');
  const source = fs.readFileSync(shim, 'utf8');
  assert.match(source, /M0 compatibility shim/);
  assert.match(source, /module\.exports = require\('\.\.\/\.\.\/leadIntPackage'\)\.load\('core\/ids(\.js)?'\);/);
  assert.equal(source.split('\n').filter((l) => l.trim() && !l.trim().startsWith('//') && l.trim() !== "'use strict';").length, 1,
    'a shim is exactly one statement');
});

test('the package public surface is the expected one', () => {
   
  const pkg = require(path.join(packageSrc, 'index.js'));
  const expected = [
    'core', 'contracts', 'icp', 'agent', 'outreach', 'research', 'trust', 'mailbox', 'sequences',
    'replies', 'enrichment', 'search', 'profile', 'exportService', 'timeline', 'providers',
    'persistence', 'opportunity',
  ];
  for (const key of expected) assert.ok(pkg[key], `the public surface exposes '${key}'`);
  assert.equal(typeof pkg.buildEvidencePacket, 'function');
  assert.equal(typeof pkg.validateEvidencePacket, 'function');
  assert.equal(typeof pkg.evaluateOutreachGate, 'function');
  assert.equal(typeof pkg.mapZuniSeoEnvelope, 'function');
  assert.equal(typeof pkg.sendIdempotencyKey, 'function');
  assert.equal(typeof pkg.evaluateIcpFit, 'function');
});

test('the package loads through its PUBLIC NAME and its declared exports', () => {
  // The package is consumed by the cloud service through its published name,
  // so the name and the exports map are part of its contract - not just its
  // layout on disk.
  const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@zunitech/lead-intelligence');
  assert.equal(pkg.exports['.'], './src/index.js');

  // The root export.
   
  const byName = require('@zunitech/lead-intelligence');
  assert.equal(typeof byName.buildEvidencePacket, 'function', 'the root export is the public surface');
  assert.equal(byName, require(path.join(packageSrc, 'index.js')), 'the name and the path give the same module');

  // A subpath export, with and without the file extension: both must work,
  // because the resolver and the cloud service may use either spelling.
   
  const withoutExtension = require('@zunitech/lead-intelligence/core/ids');
   
  const withExtension = require('@zunitech/lead-intelligence/core/ids.js');
  assert.equal(withoutExtension, withExtension, 'both spellings resolve to the same module');
  assert.equal(withoutExtension, require(path.join(packageSrc, 'core', 'ids.js')));
  assert.equal(typeof withoutExtension.stableId, 'function');

  // A path that the exports map does not publish is NOT reachable.
  assert.throws(
    () => require('@zunitech/lead-intelligence/../../src/main/leadIntPackage'),
    /ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_INVALID_MODULE_SPECIFIER|not exported|MODULE_NOT_FOUND/,
    'the exports map is a boundary, not a suggestion',
  );
});

test('the desktop application still resolves the package through one resolver', () => {
   
  const resolver = require(path.join(root, 'src', 'main', 'leadIntPackage.js'));
  assert.equal(resolver.PACKAGE_NAME, '@zunitech/lead-intelligence');
  assert.ok(fs.existsSync(resolver.root), 'the package root resolves');
  assert.equal(resolver.load('core/ids'), require(path.join(packageSrc, 'core', 'ids.js')));
});

test('the extracted rules behave exactly as before', () => {
   
  const li = require(path.join(packageSrc, 'index.js'));

  // The outreach gate: a pitch with no approval is blocked, and the reason is
  // the approval check - not something softer.
  const now = new Date();
  const blocked = li.evaluateOutreachGate({
    view: { qualification: 'qualified', contact: { email: 'a@example.com' } },
    pitch: { pitch_id: 'p1', content_hash: 'h1', subject: 's', opening: 'o', valueProposition: 'v', callToAction: 'c' },
    packet: {
      packet_id: 'pkt1',
      research_status: 'complete',
      captured_at: now.toISOString(),
      facts: [],
      findings: [],
      strengths: [],
      not_measured: [],
      limitations: [],
      source_references: [],
      provenance: { provider: 'zuni-seo', provider_job_id: 'job1', captured_at: now.toISOString(), engine_version: '1', contract_version: '1', packet_contract_version: '1', lead_id: 'L1', job_id: 'rj1' },
    },
    latestPacketId: 'pkt1',
    icpFit: { fitStatus: 'fit' },
    approval: null,
    channel: 'email',
    freshness: { isFresh: () => true },
    now,
  });
  assert.equal(blocked.decision, 'blocked');
  assert.ok(blocked.reasons.some((r) => r.code === 'HUMAN_APPROVAL'));

  // The evidence packet: a built packet validates, and it keeps its provenance.
  const capturedAt = new Date().toISOString();
  const packet = li.buildEvidencePacket({
    leadId: 'L1',
    jobId: 'rj1',
    identity: { company_name: 'Acme', lead_domain: 'acme.test', phone: null, city: null, country: null },
    provider: { id: 'zuni-seo', name: 'ZuniSEO' },
    result: {
      requestedDomain: 'acme.test',
      auditedDomain: 'acme.test',
      redirectChain: [],
      outcome: 'complete',
      capturedAt,
      engineVersion: '0.13.0',
      contractVersion: '1.0',
      providerJobId: 'job1',
      areas: { technical: 'measured' },
      facts: [{ key: 'f001', area: 'other', label: 'a fact', value: 1, sourceUrl: null, untrusted: true }],
      findings: [{ ruleId: 'tls_problem', area: 'technical', title: 'TLS', severity: 'high', basis: 'observed', observed: 'x', recommendation: 'y', urls: [], factKeys: ['f001'] }],
      strengths: [],
      notMeasured: [],
      limitations: [],
      sourceReferences: [],
    },
    freshness: { describe: () => ({ captured_at: capturedAt, expires_at: capturedAt, max_age_days: 30 }) },
    now: new Date(),
  });
  const check = li.validateEvidencePacket(packet);
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(packet.facts.length, 1);
  assert.equal(packet.findings.length, 1);
  assert.ok(packet.facts[0].provenance, 'the fact keeps its provenance');
  assert.equal(packet.findings[0].basis, 'observed', 'the genuine basis survives the move');

  // The send idempotency key: deterministic, channel-scoped, content-scoped.
  const k1 = li.sendIdempotencyKey({ channel: 'email', pitchId: 'p1', contentHash: 'h1' });
  const k2 = li.sendIdempotencyKey({ channel: 'email', pitchId: 'p1', contentHash: 'h1' });
  const k3 = li.sendIdempotencyKey({ channel: 'whatsapp', pitchId: 'p1', contentHash: 'h1' });
  assert.equal(k1, k2, 'the same intent produces the same key');
  assert.notEqual(k1, k3, 'the channel is part of the key');
  assert.match(k1, /^[0-9a-f]{64}$/);

  // The ICP evaluation: a fit and a miss. The lead view is the input, exactly
  // as the production path uses it.
  const icp = {
    icp_id: 'icp_karachi_food',
    name: 'Karachi food businesses with a website',
    criteria: [{ id: 'c_city', label: 'Based in Karachi', field: 'city', op: 'eq', value: 'Karachi' }],
  };
  const fit = li.evaluateIcpFit({ view: { id: 'X', city: 'Karachi' }, icp, now: new Date() });
  assert.equal(fit.fitStatus, 'fit');
  const miss = li.evaluateIcpFit({ view: { id: 'X', city: 'Lahore' }, icp, now: new Date() });
  assert.equal(miss.fitStatus, 'not_fit');
});

test('the ZuniSEO envelope mapper still maps a real contract envelope', () => {
   
  const { mapZuniSeoEnvelope } = require(path.join(packageSrc, 'providers', 'envelopeMapper.js'));
  const fixture = JSON.parse(fs.readFileSync(
    path.join(root, 'tests', 'fixtures', 'zuni-seo', 'v1', 'research_result.bakery.json'), 'utf8'));
  const result = mapZuniSeoEnvelope(fixture, { requestedDomain: 'harborlanebakery.test', providerJobId: 'job1' });
  assert.equal(result.facts.length, fixture.facts.length, 'every fact survives');
  assert.equal(result.findings.length, fixture.findings.length, 'every finding survives');
  assert.equal(result.outcome, 'complete');
  assert.equal(result.contractVersion, fixture.contract_version);
});

test('M0 introduced NO database schema change', () => {
  const crypto = require('node:crypto');
  const migrations = path.join(root, 'src', 'main', 'lead-intelligence', 'migrations');
  const files = fs.readdirSync(migrations).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 13, `the migrations are still there (${files.length})`);

  // The recorded manifest is the primary check: it works in a shallow CI
  // checkout, where the base ref is not available.
  const manifest = JSON.parse(fs.readFileSync(
    path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'migrations.manifest.json'), 'utf8'));
  for (const f of files) {
    const actual = crypto.createHash('sha256').update(fs.readFileSync(path.join(migrations, f))).digest('hex');
    assert.equal(actual, manifest.files[f], `${f} is byte-identical to the F0/F1 baseline`);
  }
  assert.deepEqual(Object.keys(manifest.files).sort(), files, 'no migration was added or removed');

  // And the embedded copies in the migrations module are untouched too. The
  // base ref is only available when the checkout is not shallow, so this
  // second check is best-effort and says so.
  const baseRef = 'origin/feat/cloud-saas-f0-foundation';
  let baseAvailable = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', baseRef], { cwd: root, stdio: 'ignore' });
    baseAvailable = true;
  } catch {
    baseAvailable = false;
  }
  const migrationsJs = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'persistence', 'migrations.js'));
  if (baseAvailable) {
    const beforeJs = execFileSync('git', ['show', `${baseRef}:src/main/lead-intelligence/persistence/migrations.js`], { cwd: root });
    assert.ok(migrationsJs.equals(beforeJs), 'the embedded migrations are byte-identical to the F0/F1 baseline');
  }
});

test('the desktop package includes the shared package', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.workspaces && pkg.workspaces.includes('packages/*'), 'the repository is a workspace root');
  assert.ok(
    pkg.build.files.some((f) => f === 'packages/**' || f === 'packages/lead-intelligence/**/*' || f === 'packages/lead-intelligence/**'),
    'the shared package is in the electron-builder file list',
  );
});
