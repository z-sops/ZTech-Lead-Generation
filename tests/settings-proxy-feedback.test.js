'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const mainPath = path.join(__dirname, '..', 'main.js');
const source = fs.readFileSync(rendererPath, 'utf8');
const mainSource = fs.readFileSync(mainPath, 'utf8');

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
  assert.ok(start >= 0, 'function not found: ' + name);
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

const settingsSaveFeedback = new Function(
  extractFunction(source, 'settingsSaveFeedback') + '\nreturn settingsSaveFeedback;'
)();

test('1. proxyApplied=true → unchanged success toast', () => {
  const fb = settingsSaveFeedback({ success: true, proxyApplied: true });
  assert.strictEqual(fb.message, 'Settings saved');
  assert.strictEqual(fb.type, 'success');
});

test('2. proxyApplied=false → distinguishes saved vs proxy not applied', () => {
  const fb = settingsSaveFeedback({ success: true, proxyApplied: false });
  assert.strictEqual(fb.type, 'info');
  assert.notStrictEqual(fb.message, 'Settings saved');
  assert.ok(fb.message.includes('Settings saved'), 'must still report settings persisted');
  assert.ok(fb.message.includes('the proxy could not be applied'), 'must not claim proxy is active');
  assert.ok(!fb.message.includes('proxy is active'), 'must not claim proxy took effect');
});

test('3. proxy save failure (envelope success:false) → controlled error toast', () => {
  const fb = settingsSaveFeedback({ success: false, error: 'some internal detail' });
  assert.strictEqual(fb.type, 'error');
  assert.strictEqual(fb.message, 'Could not save settings. Check the values and try again');
  assert.ok(!fb.message.includes('some internal detail'), 'internal error must not be surfaced');
});

test('4. invalid proxy (exception path) → controlled error toast, no raw strings', () => {
  const fb = settingsSaveFeedback(null);
  assert.strictEqual(fb.type, 'error');
  assert.strictEqual(fb.message, 'Could not save settings. Check the values and try again');
  assert.ok(!fb.message.includes('Error invoking remote method'), 'raw IPC exception must not be shown');
  assert.ok(!fb.message.includes('Invalid params'), 'raw validation internals must not be shown');
});

test('5. settings-save handler no longer exposes err.message', () => {
  const start = source.indexOf("btn-save-settings').addEventListener('click'");
  const end = source.indexOf("btn-detect-proxy').addEventListener", start);
  assert.ok(start >= 0 && end > start, 'settings save handler located');
  const block = source.slice(start, end);
  assert.ok(!block.includes('err?.message'), 'raw exception must not reach toast');
  assert.ok(block.includes('settingsSaveFeedback('), 'handler uses feedback helper');
});

test('6. main process still returns proxyApplied (regression)', () => {
  assert.ok(mainSource.includes('proxyApplied: proxyResult.applied'), 'settings:save returns proxyApplied');
  assert.ok(mainSource.includes('const proxyResult = await applyProxyConfiguration(nextSettings.proxyUrl);'), 'proxy application still invoked on save');
  assert.ok(mainSource.includes("return { success: true, proxyApplied: proxyResult.applied };"), 'success envelope shape preserved');
});

test('7. proxy clear/direct path preserved', () => {
  assert.ok(mainSource.includes("await session.defaultSession.setProxy(proxyRules ? { proxyRules } : { mode: 'direct' });"), 'direct mode preserved');
  const fb = settingsSaveFeedback({ success: true, proxyApplied: true });
  assert.strictEqual(fb.message, 'Settings saved');
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
