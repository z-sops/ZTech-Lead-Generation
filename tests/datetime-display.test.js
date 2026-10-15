'use strict';

// Date/time display consistency (Windows acceptance, 15 Oct 2026).
//
// Observed: Outreach "Recorded sends" showed 08/10/2026 14:50 for a send accepted at 7:50 PM in
// Karachi (the F15/F21 formatter used getUTCHours), the Outreach table showed 08/10/2026 while the
// lead drawer and the Follow-ups strip showed 10/8/2026, 7:50:47 PM (default locale), and a pitch
// draft showed 2026-10-08 (UTC ISO slice).
//
// Rule now: every date the renderer shows is the computer's LOCAL time (Asia/Karachi on the
// operator's machine) in one format: DD/MM/YYYY for a date, DD/MM/YYYY, HH:mm for a date-time.
// Display only: stored values stay UTC ISO strings, untouched.

process.env.TZ = 'Asia/Karachi';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function fnSource(name) {
  const at = src.indexOf('function ' + name + '(');
  assert.ok(at > -1, 'renderer defines ' + name);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end + 3);
}
function load(names) {
  const ctx = {};
  vm.runInNewContext(names.map(fnSource).join('\n') + '\nthis.api = {' + names.join(',') + '};', ctx);
  return ctx.api;
}

const SENT = '2026-10-08T14:50:47.000Z'; // 7:50:47 PM in Karachi (UTC+5)

test('1. Recorded sends / activity time is local Karachi time, never UTC', () => {
  const { f15ActivityWhen } = load(['f15ActivityWhen']);
  assert.strictEqual(f15ActivityWhen(SENT), '08/10/2026, 19:50');
  // the day rolls over in local time, not in UTC
  assert.strictEqual(f15ActivityWhen('2026-10-15T20:30:00.000Z'), '16/10/2026, 01:30');
  assert.strictEqual(f15ActivityWhen(''), '');
  assert.strictEqual(f15ActivityWhen('not a date'), '');
});

test('2. follow-ups, replies and the outreach/ready tables share one format', () => {
  const api = load(['f28When', 'f29When', 'f12OutreachDate', 'f16ReadyDate', 'f11Date']);
  assert.strictEqual(api.f28When(SENT), '08/10/2026, 19:50', 'Follow-ups strip and lead drawer');
  assert.strictEqual(api.f29When(SENT), '08/10/2026, 19:50', 'Replies');
  assert.strictEqual(api.f12OutreachDate(SENT), '08/10/2026', 'Outreach table');
  assert.strictEqual(api.f16ReadyDate(SENT), '08/10/2026', 'Ready page');
  assert.strictEqual(api.f11Date(SENT), '08/10/2026', 'pitch draft date (was a UTC ISO slice)');
  // a local date just after midnight is that local day, not the previous UTC day
  assert.strictEqual(api.f12OutreachDate('2026-12-31T19:30:00.000Z'), '01/01/2027');
  assert.strictEqual(api.f28When('nope'), '—');
});

test('3. no renderer date is formatted with the default locale, UTC getters or an ISO slice', () => {
  const code = src.replace(/\/\/[^\n]*/g, '');
  assert.ok(!/\.toLocaleString\(\s*\)/.test(code), 'toLocaleString() without en-GB');
  assert.ok(!/\.toLocaleDateString\(\s*\)/.test(code), 'toLocaleDateString() without en-GB');
  assert.ok(!/getUTC(Hours|Minutes|Date|Month|FullYear)\(/.test(code), 'UTC getters in a displayed value');
  assert.ok(!/toISOString\(\)\.slice\(0,\s*10\)/.test(code), 'UTC ISO date slice shown as a date');
  // every date-time uses the same short/short en-GB style (no seconds, no "medium" variant)
  const styles = code.match(/toLocaleString\('en-GB'[^)]*\)/g) || [];
  assert.ok(styles.length >= 10, 'date-time call sites found: ' + styles.length);
  for (const s of styles) assert.strictEqual(s, "toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })", s);
});

test('4. display only: no main-process or stored timestamp format changed', () => {
  // The fix lives in the renderer. Stored values are still produced as ISO strings by main.
  const seq = fs.readFileSync(path.join(root, 'src', 'main', 'lead-intelligence', 'sequences', 'SequenceService.js'), 'utf8');
  assert.ok(/toISOString\(\)/.test(seq), 'sequences still store ISO timestamps');
  const mainFiles = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) mainFiles.push(p); } })(path.join(root, 'src', 'main'));
  for (const f of mainFiles) assert.ok(!/toLocale(Date|Time)?String\(/.test(fs.readFileSync(f, 'utf8')), 'no locale formatting in main: ' + path.relative(root, f));
});

(async () => {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try { await fn(); passed += 1; console.log('ok - ' + name); } catch (err) { failed += 1; console.log('FAIL - ' + name); console.log(String(err && err.stack ? err.stack : err)); }
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
