'use strict';

// Windows acceptance (8 Oct 2026): an opt-in read "recorded by local-user" because no code set
// config.operatorName. The records (approved_by / recorded_by / reviewed_by) now name the
// Business Profile representative; "local-user" remains only when no name is configured.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

/** The real operatorNameFromSettings, with a stubbed business profile. */
function operatorNameWith(profile) {
  const start = mainSource.indexOf('function operatorNameFromSettings()');
  const end = mainSource.indexOf('\n}\n', start) + 3;
  assert.ok(start > 0 && end > start, 'operatorNameFromSettings is in main.js');
  const sandbox = { businessProfileFromSettings: () => profile, String };
  vm.runInNewContext(`${mainSource.slice(start, end)}\nthis.result = operatorNameFromSettings();`, sandbox);
  return sandbox.result;
}

test('O1. the representative name from the Business Profile is the operator', () => {
  assert.strictEqual(operatorNameWith({ sender_name: 'Zeeshan Shams Baig' }), 'Zeeshan Shams Baig');
});

test('O2. no name configured means "local-user", never an invented identity', () => {
  assert.strictEqual(operatorNameWith({ sender_name: '' }), 'local-user');
  assert.strictEqual(operatorNameWith({ sender_name: '   ' }), 'local-user');
  assert.strictEqual(operatorNameWith({}), 'local-user');
});

test('O3. the name is one plain line of at most 80 characters', () => {
  assert.strictEqual(operatorNameWith({ sender_name: 'Zee\nInjected\u0007line' }), 'Zee Injected line');
  assert.strictEqual(operatorNameWith({ sender_name: 'x'.repeat(200) }).length, 80);
});

test('O4. main.js hands it to the runtime at start and to the services when settings change', () => {
  assert.ok(/offer: businessProfileFromSettings\(\),\s*operatorName: operatorNameFromSettings\(\),/.test(mainSource), 'set at start');
  const apply = mainSource.slice(mainSource.indexOf('function applyOutreachSettings()'));
  assert.ok(/outreach\.operator = operator;/.test(apply.slice(0, 1200)), 'outreach updated on change');
  assert.ok(/li\.trust\.operator = operator;/.test(apply.slice(0, 1200)), 'trust updated on change');
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
