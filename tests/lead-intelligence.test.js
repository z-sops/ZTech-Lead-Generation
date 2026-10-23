'use strict';

// Coverage guard for the Lead Intelligence test suite.
//
// HISTORY: this file used to be a *bridge* that re-executed every test under
// tests/lead-intelligence/ with spawnSync and scraped the node:test counters,
// because the original runner (tests/run-all.js) used a flat readdirSync and
// could not see nested files. The runner is now recursive (gap G-01 in
// docs/AUDIT-BASELINE-2026-10-20.md) and runs these suites directly, so the
// bridge is no longer needed - and keeping it would have double-executed and
// double-counted every nested suite.
//
// This file therefore became what it should always have been: a GUARD proving
// that the nested suites exist, are discoverable, and cannot be silently
// dropped again.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { discoverTestFiles, countTestFilesByDirectory } = require('./lib/discover.js');

const TESTS_DIR = __dirname;
const NESTED_DIR = path.join(TESTS_DIR, 'lead-intelligence');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. the nested Lead Intelligence test directory exists and is not empty', () => {
  assert.ok(fs.existsSync(NESTED_DIR), 'tests/lead-intelligence/ exists');
  const files = fs.readdirSync(NESTED_DIR).filter((f) => f.endsWith('.test.js'));
  assert.ok(files.length >= 27, 'nested suite still holds at least 27 files (found ' + files.length + ')');
});

test('2. the shared discovery finds every nested Lead Intelligence test file', () => {
  const onDisk = fs.readdirSync(NESTED_DIR)
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => path.join(NESTED_DIR, f));
  const discovered = new Set(discoverTestFiles(TESTS_DIR));
  for (const file of onDisk) {
    assert.ok(discovered.has(file), 'discovered by the shared discovery: ' + path.basename(file));
  }
});

test('3. discovery is recursive, not flat', () => {
  const counts = countTestFilesByDirectory(TESTS_DIR);
  assert.ok(Object.keys(counts).length > 1, 'more than one test directory is scanned (found: ' + Object.keys(counts).join(', ') + ')');
  assert.ok((counts['lead-intelligence'] || 0) >= 27, 'nested directory contributes its own count');
});

test('4. the runner uses the shared recursive discovery', () => {
  const runner = fs.readFileSync(path.join(TESTS_DIR, 'run-all.js'), 'utf8');
  assert.ok(runner.includes("require('./lib/discover.js')"), 'runner uses the shared discovery module');
  assert.ok(runner.includes('discoverTestFiles('), 'runner calls discoverTestFiles');
  assert.ok(!runner.includes('readdirSync'), 'runner no longer relies on a flat readdirSync');
});

test('5. the runner no longer re-executes nested suites from a bridge', () => {
  const runner = fs.readFileSync(path.join(TESTS_DIR, 'run-all.js'), 'utf8');
  assert.ok(runner.includes("require('node:child_process')"), 'the runner spawns each test file itself');
  assert.ok(runner.includes('spawn(process.execPath'), 'the runner spawns node with the test file');
  assert.ok(!runner.includes('spawnSync'), 'the runner does not scrape a synchronously spawned child summary');
  // The needle is assembled at runtime so this guard file does not contain it
  // literally - otherwise the guard would match its own source.
  const needle = 'require(' + "'child_process')";
  const bridge = fs.readFileSync(__filename, 'utf8');
  assert.ok(!bridge.includes(needle), 'this guard does not re-execute the nested suites');
});

test('6. the runner keeps the safety properties the suite depends on', () => {
  const runner = fs.readFileSync(path.join(TESTS_DIR, 'run-all.js'), 'utf8');
  assert.ok(runner.includes('process.exit'), 'runner exits explicitly');
  assert.ok(runner.includes('failures.length > 0 ? 1 : 0'), 'non-zero exit on failure');
  assert.ok(runner.includes('DEFAULT_TIMEOUT_MS'), 'per-file timeout exists');
  assert.ok(runner.includes("require.resolve('sql.js')"), 'sql.js is a hard requirement');
});

for (const [name, fn] of tests) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (err) {
    failed++;
    console.log('FAIL - ' + name);
    console.log(String((err && err.stack) || err));
  }
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
