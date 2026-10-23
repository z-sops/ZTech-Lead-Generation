#!/usr/bin/env node
'use strict';

/**
 * ZTech test runner.
 *
 * Design rules (each one closes a gap recorded in docs/AUDIT-BASELINE-2026-10-20.md):
 *
 *  1. RECURSIVE DISCOVERY (gap G-01).
 *     Every `*.test.js` under tests/ is executed, at any depth, via
 *     tests/lib/discover.js. A new nested directory can no longer be silently
 *     skipped.
 *
 *  2. EXIT CODE IS AUTHORITATIVE (gap G-03).
 *     A file that prints a green summary and then exits non-zero is a FAILURE.
 *     The previous runner let the summary line win, which produced false greens
 *     whenever an unhandled rejection happened after the summary was printed.
 *
 *  3. FAILURE OUTPUT IS SHOWN (gap G-02).
 *     The captured stdout/stderr of every failing file is printed. The previous
 *     runner threw it away, so a red suite reported only counts.
 *
 *  4. PER-FILE TIMEOUT (gap G-04).
 *     A hung promise can no longer block the run forever.
 *
 *  5. HARD REQUIREMENT ON sql.js (gap G-05).
 *     The SQL persistence layer is guarded by `{ skip }` when sql.js is absent.
 *     That silently un-tested 37 assertions. The runner now refuses to start
 *     without sql.js, so the persistence layer can never be skipped unnoticed.
 *
 * Usage:
 *   node tests/run-all.js                 run everything
 *   node tests/run-all.js --filter icp    run files whose path contains "icp"
 *   node tests/run-all.js --list          list the discovered files and exit
 *   node tests/run-all.js --timeout 60000 override the per-file timeout (ms)
 */

const { spawn } = require('node:child_process');
const path = require('node:path');

const { discoverTestFiles } = require('./lib/discover.js');

const TEST_DIR = __dirname;
const DEFAULT_TIMEOUT_MS = 120000;

/* ------------------------------------------------------------------ args -- */

function parseArgs(argv) {
  const opts = { filter: null, list: false, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--list') opts.list = true;
    else if (arg === '--filter') opts.filter = argv[++i] || null;
    else if (arg.startsWith('--filter=')) opts.filter = arg.slice('--filter='.length);
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]) || DEFAULT_TIMEOUT_MS;
    else if (arg.startsWith('--timeout=')) opts.timeoutMs = Number(arg.slice('--timeout='.length)) || DEFAULT_TIMEOUT_MS;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else {
      console.error(`unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

/* --------------------------------------------------------------- parsing -- */

/** Legacy harness: prints a final `N passed, M failed` line. */
const LEGACY_SUMMARY = /^\s*(\d+)\s+passed,\s*(\d+)\s+failed\s*$/m;

/** node:test default reporter: `ℹ pass 7`, `# pass 7`, `pass 7`. */
const NODE_TEST_COUNTER = /^[^\S\r\n]*(?:#|ℹ|info)?[^\S\r\n]*(pass|fail|skipped|cancelled|todo)[^\S\r\n]+(\d+)[^\S\r\n]*$/gim;

function parseCounts(stdout) {
  const counts = { passed: null, failed: null, skipped: null, other: 0 };

  const legacy = LEGACY_SUMMARY.exec(stdout);
  if (legacy) {
    counts.passed = Number(legacy[1]);
    counts.failed = Number(legacy[2]);
    counts.skipped = 0;
    return counts;
  }

  NODE_TEST_COUNTER.lastIndex = 0;
  let match;
  while ((match = NODE_TEST_COUNTER.exec(stdout)) !== null) {
    const kind = match[1].toLowerCase();
    const value = Number(match[2]);
    if (kind === 'pass') counts.passed = value;
    else if (kind === 'fail') counts.failed = value;
    else if (kind === 'skipped') counts.skipped = value;
    else counts.other += value;
  }
  return counts;
}

/* -------------------------------------------------------------- execution -- */

function runFile(file, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    };

    child.on('error', (err) => {
      stderr += `\nspawn error: ${err && err.message}\n`;
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/* ------------------------------------------------------------------ main -- */

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log('Usage: node tests/run-all.js [--filter <substring>] [--list] [--timeout <ms>]');
    return 0;
  }

  // (5) sql.js is a hard requirement: without it the SQL persistence layer is
  // skipped rather than tested, and the suite would look green while testing
  // nothing in that area.
  try {
    require.resolve('sql.js');
  } catch {
    console.error('');
    console.error('FATAL: sql.js is not installed.');
    console.error('The Lead Intelligence persistence layer (17+ assertions) is skipped');
    console.error('when sql.js is missing, which makes a green run meaningless.');
    console.error('Fix: run `npm ci` (or `npm install`) before `npm test`.');
    console.error('');
    return 2;
  }

  const allFiles = discoverTestFiles(TEST_DIR);
  const files = opts.filter
    ? allFiles.filter((f) => path.relative(TEST_DIR, f).toLowerCase().includes(opts.filter.toLowerCase()))
    : allFiles;

  if (opts.list) {
    for (const file of files) console.log(path.relative(TEST_DIR, file));
    console.log(`${files.length} test file(s)`);
    return 0;
  }

  if (files.length === 0) {
    console.error('No test files found.');
    return 2;
  }

  console.log(`Running ${files.length} test file(s) from ${path.basename(TEST_DIR)}/ ...`);
  console.log('');

  const failures = [];
  let totalPassed = 0;
  let totalFailed = 0;
  let totalSkipped = 0;
  let filesPassed = 0;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const rel = path.relative(TEST_DIR, file);
    const result = await runFile(file, opts.timeoutMs);

    const counts = parseCounts(result.stdout);
    const passed = counts.passed === null ? 0 : counts.passed;
    const failed = counts.failed === null ? 0 : counts.failed;
    const skipped = counts.skipped === null ? 0 : counts.skipped;

    // (2) The exit code is authoritative. A summary line never overrides it.
    const crashed = result.code !== 0;
    const timedOut = result.timedOut;
    const ok = !crashed && !timedOut && failed === 0;

    totalPassed += passed;
    totalFailed += failed;
    totalSkipped += skipped;

    if (ok) {
      filesPassed++;
      const detail = counts.passed === null ? '' : ` (${passed} passed)`;
      console.log(`  ok   ${rel}${detail}`);
    } else {
      const reason = timedOut
        ? `TIMED OUT after ${opts.timeoutMs}ms`
        : `exit ${result.code}${result.signal ? ` (${result.signal})` : ''}${failed ? `, ${failed} failed` : ''}`;
      console.log(`  FAIL ${rel} - ${reason}`);
      failures.push({ rel, reason, result, counts });
    }
  }

  if (failures.length > 0) {
    console.log('');
    console.log('=== FAILURE DETAIL ===');
    for (const failure of failures) {
      console.log('');
      console.log(`--- ${failure.rel} (${failure.reason}) ---`);
      const out = String(failure.result.stdout || '').trim();
      const err = String(failure.result.stderr || '').trim();
      if (out) console.log(out);
      if (err) console.log(err);
    }
  }

  console.log('');
  console.log('=== SUMMARY ===');
  console.log(`Test files: ${files.length} (${filesPassed} passed, ${failures.length} failed)`);
  console.log(`Assertions: ${totalPassed + totalFailed + totalSkipped} (${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped)`);
  if (totalSkipped > 0) {
    console.log('NOTE: skipped assertions are reported above and must not be ignored.');
  }
  if (failures.length > 0) {
    console.log('Failed files:');
    for (const failure of failures) console.log(`  - ${failure.rel} (${failure.reason})`);
  }

  return failures.length > 0 ? 1 : 0;
}

main().then(
  (code) => { process.exit(code); },
  (err) => {
    console.error('runner crashed:', (err && err.stack) || err);
    process.exit(2);
  }
);
