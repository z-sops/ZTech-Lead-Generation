'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');

const handlerStart = mainSource.indexOf('setWindowOpenHandler');
const handlerEnd = mainSource.indexOf('will-navigate');
const handlerRegion = handlerStart > -1 && handlerEnd > handlerStart
  ? mainSource.slice(handlerStart, handlerEnd)
  : '';

function extractCallbackBody(source, anchor) {
  const anchorIdx = source.indexOf(anchor);
  assert.ok(anchorIdx > -1, 'anchor present: ' + anchor);
  const arrowIdx = source.indexOf('=> {', anchorIdx);
  assert.ok(arrowIdx > -1, 'callback arrow function found after anchor');
  const openIdx = source.indexOf('{', arrowIdx);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  assert.ok(closeIdx > openIdx, 'callback body structurally closed');
  return { region: source.slice(openIdx, closeIdx + 1), openIdx, closeIdx };
}

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. main.js imports shell from electron', () => {
  const electronRequire = mainSource.match(/const \{[^}]+\} = require\('electron'\);/);
  assert.ok(electronRequire, 'electron destructured require present');
  assert.ok(electronRequire[0].includes('shell'), 'shell included in electron import');
});

test('2. setWindowOpenHandler no longer allows remote child windows', () => {
  assert.ok(handlerRegion.length > 0, 'handler region located');
  const allowCount = mainSource.split(/action:\s*['"]allow['"]/).length - 1;
  assert.strictEqual(allowCount, 0, "no action:'allow' anywhere in main.js");
  assert.ok(!/return\s*\{\s*action:\s*['"]allow['"]\s*\}/.test(handlerRegion), 'handler never returns allow');
});

test('3. http protocol reaches shell.openExternal', () => {
  const gate = /if\s*\(\s*protocol === 'http:'\s*\|\|\s*protocol === 'https:'\s*\)\s*\{[^}]*shell\.openExternal/;
  assert.ok(gate.test(handlerRegion), 'http(s) gate wraps the openExternal call');
});

test('4. https protocol reaches shell.openExternal', () => {
  assert.ok(handlerRegion.includes("protocol === 'https:'"), 'https protocol checked');
  const gate = /if\s*\(\s*protocol === 'http:'\s*\|\|\s*protocol === 'https:'\s*\)\s*\{[^}]*shell\.openExternal/;
  assert.ok(gate.test(handlerRegion), 'https is covered by the same openExternal gate');
});

test('5. non-http(s) protocols do NOT reach shell.openExternal', () => {
  const openExternalCount = mainSource.split('shell.openExternal').length - 1;
  assert.strictEqual(openExternalCount, 1, 'exactly one shell.openExternal call site');
  assert.ok(handlerRegion.includes('shell.openExternal'), 'call site lives inside the window-open handler');
  assert.ok(!handlerRegion.includes("protocol === 'file:'") || !/file:[^}]*openExternal/.test(handlerRegion), 'file: never forwarded');
  const gateIdx = handlerRegion.indexOf("if (protocol === 'http:' || protocol === 'https:')");
  const callIdx = handlerRegion.indexOf('shell.openExternal');
  const closeIdx = handlerRegion.indexOf('}\n', gateIdx);
  assert.ok(gateIdx > -1 && callIdx > gateIdx, 'call occurs after the protocol gate opens');
  assert.ok(closeIdx > callIdx, 'call occurs before the protocol gate closes (inside the if-block)');
});

test('6. all handler paths return action:deny', () => {
  const { region } = extractCallbackBody(mainSource, 'setWindowOpenHandler');
  const returns = region.match(/return\s*\{[^}]*\}/g) || [];
  assert.strictEqual(returns.length, 1, 'exactly one return statement in the callback body');
  assert.ok(/return\s*\{\s*action:\s*['"]deny['"]\s*\}/.test(returns[0]), 'that return is deny');

  const gateStart = region.indexOf("if (protocol === 'http:' || protocol === 'https:') {");
  assert.ok(gateStart > -1, 'http(s) protocol gate present');
  const gateOpen = region.indexOf('{', gateStart);
  let depth = 0;
  let gateClose = -1;
  for (let i = gateOpen; i < region.length; i++) {
    if (region[i] === '{') depth++;
    else if (region[i] === '}') {
      depth--;
      if (depth === 0) { gateClose = i; break; }
    }
  }
  assert.ok(gateClose > gateOpen, 'protocol gate structurally closed');

  const callIdx = region.indexOf('shell.openExternal');
  assert.ok(callIdx > gateOpen && callIdx < gateClose, 'openExternal is strictly inside the http(s) gate (non-http(s) cannot reach it)');
  const returnIdx = region.indexOf('return');
  assert.ok(gateClose < returnIdx, 'gate closes before the single deny return (all paths fall through to deny)');
  assert.ok(!/action:\s*['"]allow['"]/.test(region), 'no allow action in callback body');
});

test('7. shell.openExternal rejection is caught and logged', () => {
  assert.ok(handlerRegion.includes('.catch('), 'promise rejection handled');
  assert.ok(handlerRegion.includes('logger.warn('), 'rejection logged via existing logger');
  assert.ok(/\.catch\(\s*\(err\)\s*=>\s*logger\.warn\(/.test(handlerRegion), 'catch feeds logger.warn');
});

test('8. existing will-navigate guard remains intact', () => {
  const { region } = extractCallbackBody(mainSource, "mainWindow.webContents.on('will-navigate'");
  // The only other preventDefault in main.js belongs to the A5 before-quit hook,
  // which defers the first quit while the research transport closes. Count them
  // separately so a second navigation guard could not slip in unnoticed.
  const quitHookStart = mainSource.indexOf("app.on('before-quit'");
  const quitHookEnd = mainSource.indexOf("app.on('window-all-closed'", quitHookStart);
  // I4 declared lock update: the will-quit hook defers the final quit once while the
  // managed OI child is stopped. It is excluded here and counted on its own below.
  const willQuitStart = mainSource.indexOf("app.on('will-quit'");
  const willQuitEnd = mainSource.indexOf("process.on('exit'", willQuitStart);
  assert.ok(willQuitStart > 0 && willQuitEnd > willQuitStart && willQuitEnd < quitHookStart, 'will-quit hook sits before before-quit');
  const willQuit = mainSource.slice(willQuitStart, willQuitEnd);
  assert.strictEqual(willQuit.split('event.preventDefault()').length - 1, 1, 'the will-quit hook has its own single preventDefault');
  const navCode = mainSource.slice(0, willQuitStart) + mainSource.slice(willQuitEnd, quitHookStart) + mainSource.slice(quitHookEnd);
  const pdCount = navCode.split('event.preventDefault()').length - 1;
  assert.strictEqual(pdCount, 1, 'exactly one navigation preventDefault in main.js');
  const quitHook = mainSource.slice(quitHookStart, quitHookEnd);
  assert.strictEqual(quitHook.split('event.preventDefault()').length - 1, 1, 'the before-quit hook has its own single preventDefault');
  const pdIdx = region.indexOf('event.preventDefault()');
  assert.ok(pdIdx > -1, 'preventDefault inside the will-navigate callback body');
  const devRetIdx = region.indexOf('new URL(url).origin === devOrigin) return;');
  assert.ok(devRetIdx > -1, 'dev origin allowance inside the same callback');
  assert.ok(devRetIdx < pdIdx, 'dev allowance returns before preventDefault (same coordinate region)');
  assert.ok(region.includes('if (isDev) {'), 'dev branch preserved inside handler');
});

test('9. existing localhost dev navigation allowance remains intact', () => {
  const idx = mainSource.indexOf("mainWindow.webContents.on('will-navigate'");
  const navBlock = mainSource.slice(idx, idx + 600);
  assert.ok(navBlock.includes('if (isDev) {'), 'dev branch preserved');
  assert.ok(navBlock.includes('VITE_PORT || 5173'), 'dev port behavior preserved');
  assert.ok(navBlock.includes('new URL(url).origin === devOrigin) return;'), 'dev origin allowance preserved');
  const originIdx = navBlock.indexOf('new URL(url).origin === devOrigin) return;');
  const preventIdx = navBlock.indexOf('event.preventDefault()');
  assert.ok(originIdx > -1 && preventIdx > originIdx, 'allowance returns before preventDefault');
});

test('10. renderer target="_blank" markup remains unchanged', () => {
  assert.ok(rendererSource.includes('target="_blank" rel="noopener"'), 'renderWebsite link markup intact');
  const count = rendererSource.split('target="_blank"').length - 1;
  assert.strictEqual(count, 1, 'exactly one target="_blank" link (no new/removed links)');
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - clicking an external link opens the system browser, not an Electron child window');
console.log('  - shell.openExternal actually succeeds on the host OS');
console.log('  - non-http(s) URLs produce no window and no OS navigation');
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
