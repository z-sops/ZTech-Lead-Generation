#!/usr/bin/env node
'use strict';

/**
 * Sync the Zuni-SEO research contract into ZTech.
 *
 * ZuniSEO's own handoff document says it: *"Keep the contract files identical
 * on both sides"*. This script performs that sync and records the SHA-256 of
 * every vendored file, so a change in ZuniSEO that ZTech has not taken is
 * DETECTED rather than discovered later as a silent contract mismatch.
 *
 * The zuni-seo repository is NEVER modified by this script. It is only read.
 *
 * Usage:
 *   node scripts/sync-zuniseo-contract.js --from <path-to-zuni-seo-checkout> [--check]
 *
 *   --from <path>   a local checkout of the zuni-seo repository (required)
 *   --check         do not write anything; exit 1 if the vendored copy is out
 *                   of date. This is what CI runs.
 *
 * The vendored files live in:
 *   src/main/lead-intelligence/contracts/zuni-seo/v1/contract.schema.json
 *   tests/fixtures/zuni-seo/v1/*.json
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const CONTRACT_DIR = path.join(ROOT, 'src', 'main', 'lead-intelligence', 'contracts', 'zuni-seo', 'v1');
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'zuni-seo', 'v1');
const MANIFEST = path.join(CONTRACT_DIR, 'contract.manifest.json');

/** The contract file and the golden fixtures, relative to the zuni-seo repo. */
const SOURCE_FILES = [
  { from: 'src/zunitech_seo/contracts/v1/contract.schema.json', to: path.join(CONTRACT_DIR, 'contract.schema.json') },
  { from: 'src/zunitech_seo/contracts/v1/fixtures/capabilities.json', to: path.join(FIXTURE_DIR, 'capabilities.json') },
  { from: 'src/zunitech_seo/contracts/v1/fixtures/research_result.bakery.json', to: path.join(FIXTURE_DIR, 'research_result.bakery.json') },
  { from: 'src/zunitech_seo/contracts/v1/fixtures/research_result.bakery.local.json', to: path.join(FIXTURE_DIR, 'research_result.bakery.local.json') },
  { from: 'src/zunitech_seo/contracts/v1/fixtures/research_result.pypi.json', to: path.join(FIXTURE_DIR, 'research_result.pypi.json') },
  { from: 'src/zunitech_seo/contracts/v1/fixtures/research_start.queued.json', to: path.join(FIXTURE_DIR, 'research_start.queued.json') },
];

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * The bytes that will be COMMITTED.
 *
 * The repository normalises text files to LF (`.gitattributes`: `* text=auto
 * eol=lf`), so a file copied from a CRLF source is committed with different
 * bytes than it had on disk. The hash that is recorded must be the hash of
 * the COMMITTED bytes, or the drift check fails on a fresh checkout while
 * passing in the working tree. The first CI run found exactly that.
 */
function normalizeEol(buffer) {
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

function parseArgs(argv) {
  const opts = { from: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--from') opts.from = argv[++i] || null;
    else if (argv[i].startsWith('--from=')) opts.from = argv[i].slice('--from='.length);
    else if (argv[i] === '--check') opts.check = true;
    else {
      console.error(`unknown argument: ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  } catch {
    return { source: null, files: {} };
  }
}

const opts = parseArgs(process.argv.slice(2));
if (!opts.from) {
  console.error('usage: node scripts/sync-zuniseo-contract.js --from <path-to-zuni-seo-checkout> [--check]');
  process.exit(2);
}

const sourceRoot = path.resolve(opts.from);
const manifest = readManifest();
const problems = [];
const next = { source: path.basename(sourceRoot), files: {} };

for (const file of SOURCE_FILES) {
  const sourcePath = path.join(sourceRoot, file.from);
  if (!fs.existsSync(sourcePath)) {
    problems.push(`missing in the zuni-seo checkout: ${file.from}`);
    continue;
  }
  const buffer = fs.readFileSync(sourcePath);
  const normalized = normalizeEol(buffer);
  const hash = sha256(normalized);
  next.files[path.relative(ROOT, file.to).split(path.sep).join('/')] = hash;

  const vendoredExists = fs.existsSync(file.to);
  const vendoredHash = vendoredExists ? sha256(normalizeEol(fs.readFileSync(file.to))) : null;
  const recorded = manifest.files[path.relative(ROOT, file.to).split(path.sep).join('/')];

  if (opts.check) {
    if (!vendoredExists) problems.push(`not vendored: ${path.relative(ROOT, file.to)}`);
    else if (vendoredHash !== hash) problems.push(`out of date: ${path.relative(ROOT, file.to)} (zuni-seo ${hash.slice(0, 12)}..., ZTech ${vendoredHash.slice(0, 12)}...)`);
    else if (recorded && recorded !== hash) problems.push(`the recorded hash is stale: ${path.relative(ROOT, file.to)}`);
  } else {
    fs.mkdirSync(path.dirname(file.to), { recursive: true });
    fs.writeFileSync(file.to, normalized);
    console.log(`synced ${path.relative(ROOT, file.to)}  ${hash.slice(0, 16)}...`);
  }
}

if (opts.check) {
  if (problems.length) {
    console.error('The vendored Zuni-SEO contract is out of date:');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('');
    console.error('Run: node scripts/sync-zuniseo-contract.js --from <path-to-zuni-seo-checkout>');
    process.exit(1);
  }
  console.log('The vendored Zuni-SEO contract is identical to the source checkout.');
  process.exit(0);
}

fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 2) + '\n', 'utf8');
console.log(`\nmanifest written: ${path.relative(ROOT, MANIFEST)}`);
if (problems.length) {
  console.error('Problems:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
