'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. single-instance lock acquisition exists exactly once', () => {
  const count = mainSource.split('app.requestSingleInstanceLock()').length - 1;
  assert.strictEqual(count, 1, 'requestSingleInstanceLock must appear exactly once');
  assert.ok(mainSource.includes('const gotTheLock = app.requestSingleInstanceLock();'), 'lock result stored');
});

test('2. failed lock quits before startup/services initialization', () => {
  const lockIdx = mainSource.indexOf('app.requestSingleInstanceLock()');
  const quitIdx = mainSource.indexOf('app.quit()', lockIdx);
  const readyIdx = mainSource.indexOf('app.whenReady()');
  assert.ok(lockIdx > -1, 'lock present');
  assert.ok(quitIdx > lockIdx, 'app.quit() exists after lock');
  assert.ok(readyIdx > quitIdx, 'quit happens before whenReady registration');
  const failBlock = mainSource.slice(lockIdx, readyIdx);
  assert.ok(failBlock.includes('if (!gotTheLock) {'), 'failure branch gates quit');
});

test('3. second-instance event handler exists for the primary instance', () => {
  const idx = mainSource.indexOf("app.on('second-instance'");
  assert.ok(idx > -1, 'second-instance handler registered');
  const restoreIdx = mainSource.indexOf('mainWindow.restore()', idx);
  const focusIdx = mainSource.indexOf('mainWindow.focus()', idx);
  assert.ok(restoreIdx > idx, 'restore reachable from handler');
  assert.ok(focusIdx > restoreIdx, 'focus called after restore');
});

test('4. focus/restore behavior is guarded by a null window check', () => {
  const idx = mainSource.indexOf("app.on('second-instance'");
  const guardIdx = mainSource.indexOf('if (mainWindow === null) return;', idx);
  const restoreIdx = mainSource.indexOf('mainWindow.restore()', idx);
  assert.ok(guardIdx > idx, 'null guard inside handler');
  assert.ok(guardIdx < restoreIdx, 'guard executes before restore/focus');
  const minimizedIdx = mainSource.indexOf('mainWindow.isMinimized()', idx);
  assert.ok(minimizedIdx > guardIdx && minimizedIdx < restoreIdx, 'minimized check wraps restore');
});

test('5. failed-lock instance never creates window or initializes services', () => {
  const readyIdx = mainSource.indexOf('app.whenReady()');
  assert.ok(readyIdx > -1, 'whenReady present');
  const guardIdx = mainSource.indexOf('if (!gotTheLock) return;', readyIdx);
  const windowIdx = mainSource.indexOf('createMainWindow()', readyIdx);
  const servicesIdx = mainSource.indexOf('initServices()', readyIdx);
  const ipcIdx = mainSource.indexOf('registerIpcHandlers()', readyIdx);
  assert.ok(guardIdx > readyIdx, 'lock guard inside whenReady body');
  assert.ok(guardIdx > 0 && windowIdx > guardIdx, 'guard before createMainWindow');
  assert.ok(servicesIdx > guardIdx, 'guard before initServices');
  assert.ok(ipcIdx > guardIdx, 'guard before registerIpcHandlers');
});

test('6. primary startup order preserved after the guard', () => {
  const readyIdx = mainSource.indexOf('app.whenReady()');
  const body = mainSource.slice(readyIdx);
  // A5: the database must be open and the research objects constructed before
  // the window exists. initServices() is awaited, gateway.start() is not.
  const marks = [
    "logger.info('app', 'application started'",
    'await initServices();',
    'initResearch();',
    'createMainWindow();',
    'registerIpcHandlers();',
    'applyProxyConfiguration(storedProxyUrl);'
  ];
  let last = -1;
  for (const mark of marks) {
    const idx = body.indexOf(mark);
    assert.ok(idx > -1, 'missing startup step: ' + mark);
    assert.ok(idx > last, 'startup step out of order: ' + mark);
    last = idx;
  }
});

test('7. no deep-link/protocol behavior introduced', () => {
  assert.ok(!mainSource.includes('setAsDefaultProtocolClient'), 'no protocol registration');
  assert.ok(!mainSource.includes("app.on('open-url'"), 'no open-url handler');
  assert.ok(!mainSource.includes('process.argv'), 'no argv deep-link parsing');
});

test('8. no new application-level locking system introduced', () => {
  assert.ok(!mainSource.includes('proper-lockfile'), 'no lockfile dependency');
  assert.ok(!mainSource.includes('lockfile'), 'no lockfile module');
  assert.ok(!mainSource.includes('.pid'), 'no pid-file locking');
});

test('9. existing quit behavior on window close preserved', () => {
  assert.ok(mainSource.includes("mainWindow.on('closed'"), 'window closed handler preserved');
  assert.ok(mainSource.includes("app.on('window-all-closed'"), 'window-all-closed handler preserved');
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - actual second-process launch exits without services/window');
console.log('  - primary receives second-instance event and restores/focuses');
console.log('');

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
