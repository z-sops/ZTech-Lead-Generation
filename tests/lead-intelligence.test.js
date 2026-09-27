'use strict';

// ZTech-authored bridge. Batch 1 only.
//
// Why this exists: the module's tests use node:test, which prints "ℹ pass N".
// ZTech's tests/run-all.js:37-45 counts a file only when its output contains a
// line matching /^\d+ passed, \d+ failed$/; otherwise, with exit code 0, it adds
// nothing at all. A passing node:test file would therefore be silently uncounted
// and the suite would look green while running nothing.
//
// This bridge spawns each copied module test, converts the node:test counters into
// ZTech's summary line, and prints it as the last line so run-all.js can parse it.
// The module tests themselves are NOT modified beyond their require paths.
//
// FAIL LOUD: if a child produces no readable pass/fail count, this file throws
// instead of reporting zero. A silent zero would hide a whole batch of tests.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// A2: the vendored module's test files are discovered from disk rather than listed
// by hand, so a newly vendored batch cannot be silently left out of the count.
const TEST_DIR = path.join(__dirname, 'lead-intelligence');

function discoverModuleTests() {
  if (!fs.existsSync(TEST_DIR)) {
    throw new Error(`lead-intelligence: test directory is missing: ${TEST_DIR}`);
  }
  const files = fs.readdirSync(TEST_DIR)
    .filter((n) => n.endsWith('.test.js'))
    .sort();
  if (files.length === 0) {
    throw new Error(`lead-intelligence: no *.test.js files found in ${TEST_DIR}`);
  }
  return files;
}

const MODULE_TESTS = discoverModuleTests();

/**
 * Parse node:test's summary counters. Returns null when they cannot be found.
 * Accepts the default spec reporter ("ℹ pass 7"), the tap reporter ("# pass 7")
 * and a bare "pass 7", so a reporter change cannot silently zero the batch.
 */
function parseNodeTestSummary(stdout) {
  const line = /^[^\S\r\n]*(?:#|ℹ|info)?[^\S\r\n]*(pass|fail)[^\S\r\n]+(\d+)[^\S\r\n]*$/gim;
  let passed = null;
  let failed = null;
  let m;
  while ((m = line.exec(stdout)) !== null) {
    if (m[1].toLowerCase() === 'pass') passed = Number(m[2]);
    else failed = Number(m[2]);
  }
  if (passed === null || failed === null) return null;
  return { passed, failed };
}

let totalPassed = 0;
let totalFailed = 0;
const problems = [];

for (const file of MODULE_TESTS) {
  const full = path.join(TEST_DIR, file);
  if (!fs.existsSync(full)) {
    problems.push(`missing module test file: ${full}`);
    continue;
  }
  const result = spawnSync(process.execPath, [full], { encoding: 'utf8' });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');

  if (result.error) {
    problems.push(`could not run ${file}: ${result.error.message}`);
    continue;
  }

  const summary = parseNodeTestSummary(stdout);
  if (!summary) {
    // Never fall through to a zero here.
    problems.push(
      `no node:test pass/fail counters in ${file} (exit ${result.status}).\n` +
      `--- stdout ---\n${stdout.trim()}\n--- stderr ---\n${stderr.trim()}`
    );
    continue;
  }

  totalPassed += summary.passed;
  totalFailed += summary.failed;
  if (result.status !== 0 || summary.failed > 0) {
    problems.push(
      `${file} failed (${summary.failed} failed, exit ${result.status}).\n` +
      stdout.split('\n').filter((l) => /^(not ok|✖|✗)/.test(l.trim())).join('\n')
    );
  }
}

if (problems.length > 0) {
  // Loud, and never counted as a pass.
  console.log('lead-intelligence bridge ERRORS:');
  for (const p of problems) console.log(p);
  console.log(`${totalPassed} passed, ${totalFailed + problems.length} failed`);
  process.exit(1);
}

console.log(`${totalPassed} passed, ${totalFailed} failed`);
process.exit(totalFailed > 0 ? 1 : 0);
