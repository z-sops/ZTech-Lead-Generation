'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (err) {
    failures.push({ name, err });
    console.log('FAIL - ' + name + ': ' + err.message);
  }
}

function extractFunction(src, name) {
  const signature = 'function ' + name + '(';
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'function not found in renderer.js: ' + name);
  assert.strictEqual(src.indexOf(signature, start + 1), -1, 'function defined more than once: ' + name);
  let depth = 0;
  let opened = false;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; opened = true; continue; }
    if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for function: ' + name);
}

const evaluateSource = extractFunction(source, 'evaluatePollOutcome');
const evaluatePollOutcome = new Function(
  evaluateSource + '\nreturn evaluatePollOutcome;'
)();

test('1. transport failure classified as transport-error with message', () => {
  const r = evaluatePollOutcome({ success: false, error: '网络错误' });
  assert.strictEqual(r.outcome, 'transport-error');
  assert.strictEqual(r.error, '网络错误');
});

test('2. empty/undefined status classified as transport-error', () => {
  assert.strictEqual(evaluatePollOutcome(undefined).outcome, 'transport-error');
  assert.strictEqual(evaluatePollOutcome(null).outcome, 'transport-error');
  assert.strictEqual(evaluatePollOutcome({}).outcome, 'transport-error');
  assert.strictEqual(evaluatePollOutcome({ success: false }).error, 'Unknown error');
});

test('3. known terminal success states preserved (all aliases)', () => {
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 'succeeded' } }).outcome, 'terminal-success');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 'completed' } }).outcome, 'terminal-success');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 'success' } }).outcome, 'terminal-success');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { state: 'succeeded' } }).outcome, 'terminal-success');
});

test('4. known terminal failure states preserved with provider error passthrough', () => {
  const r = evaluatePollOutcome({ success: true, data: { status: 'failed', error: '任务失败原因' } });
  assert.strictEqual(r.outcome, 'terminal-failure');
  assert.strictEqual(r.error, '任务失败原因');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { state: 'error' } }).outcome, 'terminal-failure');
});

test('5. unknown-but-present states stay pending (not treated as success/failure)', () => {
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 'running' } }).outcome, 'pending');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 'queued' } }).outcome, 'pending');
  const weird = evaluatePollOutcome({ success: true, data: { status: 'weird_provider_state' } });
  assert.strictEqual(weird.outcome, 'pending');
  assert.strictEqual(weird.state, 'weird_provider_state');
});

test('6. missing/malformed state classified as missing-state', () => {
  assert.strictEqual(evaluatePollOutcome({ success: true }).outcome, 'missing-state');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: {} }).outcome, 'missing-state');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: 5 } }).outcome, 'missing-state');
  assert.strictEqual(evaluatePollOutcome({ success: true, data: { status: '' } }).outcome, 'missing-state');
});

test('7. bounded retry wiring: cap, delay, counter, resets', () => {
  assert.ok(source.includes('const MAX_CONSECUTIVE_POLL_FAILURES = 3;'), 'cap constant = 3');
  assert.ok(source.includes('const POLL_RETRY_DELAY_MS = 5000;'), 'delay constant = 5000');
  assert.ok(source.includes('let pollFailureCount = 0;'), 'failure counter declared');
  const scheduleCount = source.split('scheduleNextPoll(gen, slug)').length - 1;
  assert.strictEqual(scheduleCount, 4, 'helper definition + 3 continuation call sites');
  const resetCount = source.split('pollFailureCount = 0;').length - 1;
  assert.strictEqual(resetCount, 4, 'declaration + resets on submit, check-status and healthy pending');
  assert.ok(source.includes('pollFailureCount >= MAX_CONSECUTIVE_POLL_FAILURES'), 'stop condition present');
});

test('8. generation/stale guards intact in pollRunStatus', () => {
  assert.ok(source.includes('if (!isCurrentRun(gen, slug)) return;'), 'isCurrentRun guard preserved');
  assert.ok(source.includes('cancelPollTimer();'), 'cancelPollTimer preserved');
  assert.ok(source.includes("if (pollTimerId !== null || pollInFlight) return;"), 'Check Status overlap guard preserved');
  assert.ok(source.includes("if (gen === runGeneration) pollInFlight = false;"), 'finally reset preserved');
});

test('9. terminal behavior preserved in pollRunStatus wiring', () => {
  const pollStart = source.indexOf('async function pollRunStatus(');
  const pollEnd = source.indexOf('const RESULTS_PAGE_SIZE', pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart, 'pollRunStatus region located');
  const region = source.slice(pollStart, pollEnd);
  assert.ok(region.includes('loadRunResult(slug, gen);'), 'success still loads results');
  assert.ok(region.includes("showStatus(`Collection failed: ${res.error || 'Unknown error'}`, true);"), 'failure message preserved');
  assert.ok(region.includes("showStatus(`Job status: ${res.state}. Refreshing automatically...`);"), 'pending message preserved');
  assert.ok(region.includes("showStatus(`Checking job status... (${slug})`);"), 'poll status message preserved');
});

test('10. no new provider status invented', () => {
  const known = ["'succeeded'", "'completed'", "'success'", "'failed'", "'error'", "'running'"];
  for (const k of known) {
    assert.ok(source.includes(k), 'expected existing status token ' + k);
  }
  assert.ok(!source.includes("'timeout'"), 'no invented terminal timeout status');
  assert.ok(!source.includes("'cancelled'"), 'no invented terminal cancelled status');
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
