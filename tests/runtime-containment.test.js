'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function extractBlock(source, anchor) {
  const anchorIdx = source.indexOf(anchor);
  assert.ok(anchorIdx > -1, 'anchor present: ' + anchor);
  const openIdx = source.indexOf('{', anchorIdx);
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) { closeIdx = i; break; }
    }
  }
  assert.ok(closeIdx > openIdx, 'block structurally closed');
  return source.slice(anchorIdx, closeIdx + 1);
}

test('1. uncaughtException handler exists and logs via existing logger', () => {
  const block = extractBlock(mainSource, "process.on('uncaughtException'");
  assert.ok(block.includes('logger.error('), 'uses existing logger');
  assert.ok(!block.includes('app.quit()'), 'must not terminate the app');
  assert.ok(!block.includes('process.exit'), 'must not force process exit');
  assert.ok(block.includes('err.message'), 'logs diagnostic message');
  assert.ok(block.includes('err.stack'), 'logs stack diagnostic');
});

test('2. unhandledRejection handler exists and logs via existing logger', () => {
  const block = extractBlock(mainSource, "process.on('unhandledRejection'");
  assert.ok(block.includes('logger.error('), 'uses existing logger');
  assert.ok(!block.includes('app.quit()'), 'must not terminate the app');
  assert.ok(!block.includes('process.exit'), 'must not force process exit');
  assert.ok(block.includes('String(reason)'), 'logs reason diagnostic');
});

test('3. both process handlers guard against recursive logging', () => {
  const excBlock = extractBlock(mainSource, "process.on('uncaughtException'");
  const rejBlock = extractBlock(mainSource, "process.on('unhandledRejection'");
  assert.ok(excBlock.includes('try {') && excBlock.includes('catch'), 'uncaughtException body wraps logger in try/catch');
  assert.ok(rejBlock.includes('try {') && rejBlock.includes('catch'), 'unhandledRejection body wraps logger in try/catch');
});

test('4. app.whenReady chain has error containment', () => {
  const readyIdx = mainSource.indexOf('app.whenReady()');
  assert.ok(readyIdx > -1, 'whenReady present');
  const tail = mainSource.slice(readyIdx, mainSource.indexOf("app.on('window-all-closed'"));
  assert.ok(tail.includes('.catch('), 'startup rejection caught');
  assert.ok(tail.includes('logger.error('), 'startup failure logged, not silently swallowed');
  assert.ok(mainSource.indexOf('createMainWindow();') > -1, 'startup logic not duplicated');
});

test('5. render-process-gone diagnostics present without reload', () => {
  const block = extractBlock(mainSource, "webContents.on('render-process-gone'");
  assert.ok(block.includes('logger.error('), 'logs failure');
  assert.ok(block.includes('details.reason'), 'logs reason');
  assert.ok(block.includes('details.exitCode'), 'logs exit code');
  assert.ok(!block.includes('loadURL') && !block.includes('reload') && !block.includes('loadFile'),
    'no auto-reload / recovery');
  assert.ok(!block.includes('app.quit') && !block.includes('app.exit'), 'must not terminate application');
});

test('6. minimal renderer error-reporting IPC exists in main', () => {
  const block = extractBlock(mainSource, "ipcMain.handle('logs:report'");
  assert.ok(block.includes('typeof payload'), 'validates input payload');
  assert.ok(block.includes('.slice(0, 500)'), 'truncates message');
  assert.ok(block.includes('logger.error('), 'uses existing logger');
  assert.ok(!block.includes('logger.info(') && !block.includes('logger.warn(') && !block.includes('logger.ok('),
    'renderer cannot choose arbitrary log levels/records');
  assert.ok(!block.includes('exportLogs') && !block.includes('writeLine'), 'no raw log-file access for renderer');
  assert.ok(block.includes('return { success'), 'returns controlled result');
});

test('7. preload exposes only a minimal logs.report API', () => {
  const logsBlock = extractBlock(preloadSource, 'logs:');
  assert.ok(logsBlock.includes('report: (payload) => ipcRenderer.invoke(\'logs:report\', payload)'),
    'exposes exactly one new invoke');
  const reportCount = preloadSource.split("invoke('logs:report'").length - 1;
  assert.strictEqual(reportCount, 1, 'logs:report invoked exactly once');
  assert.ok(!preloadSource.includes('logger'), 'no main logger object exposed to renderer');
});

test('8. renderer has error-reporting helpers', () => {
  assert.ok(rendererSource.includes('function reportError('), 'reportError helper exists');
  assert.ok(rendererSource.includes('function safeAsync('), 'safeAsync wrapper exists');
  assert.ok(rendererSource.includes('window.appAPI.logs.report'), 'reports via minimal IPC');
  assert.ok(rendererSource.includes('reportError(msg'), 'errors actually reported');
});

test('9. top-level async event flows are guarded', () => {
  const guardedHandlers = [
    'btn-start-collect',
    'btn-check-status',
    'btn-refresh-history',
    'btn-save-settings',
    'btn-detect-proxy',
    'btn-export-logs',
    'btn-test-apikey',
    'btn-test-taskkey',
    'btn-save-numbers',
    'btn-export-results',
    'btn-delete-selected',
    'btn-export-csv'
  ];
  for (const id of guardedHandlers) {
    const idx = rendererSource.indexOf(`getElementById('${id}')`);
    assert.ok(idx > -1, 'handler exists: ' + id);
    const window = rendererSource.slice(idx, idx + 400);
    assert.ok(window.includes('safeAsync('), 'handler wrapped with safeAsync: ' + id);
  }
});

test('10. polling lifecycle rejects cannot escape as unhandled rejections', () => {
  const block = extractBlock(rendererSource, 'function scheduleNextPoll');
  assert.ok(block.includes('.catch('), 'scheduled poll catches rejection');
  assert.ok(block.includes('reportError'), 'poll rejection reported');
  assert.ok(block.includes('pollRunStatus(gen, slug)'), 'poll still invoked with generation guards');
  assert.ok(block.includes('POLL_RETRY_DELAY_MS'), 'retry delay preserved');
  const pollBlock = extractBlock(rendererSource, 'async function pollRunStatus');
  assert.ok(pollBlock.includes('isCurrentRun(gen, slug)'), 'stale-job guard preserved');
  assert.ok(pollBlock.includes('MAX_CONSECUTIVE_POLL_FAILURES'), 'failure cap preserved');
  assert.ok(pollBlock.includes('pollInFlight'), 'in-flight guard preserved');
  assert.ok(pollBlock.includes('finally'), 'in-flight flag reset preserved');
});

test('11. no secrets introduced at new logging sites', () => {
  const newSites = [
    "process.on('uncaughtException'",
    "process.on('unhandledRejection'",
    "webContents.on('render-process-gone'",
    "ipcMain.handle('logs:report'"
  ];
  for (const site of newSites) {
    const block = extractBlock(mainSource, site);
    assert.ok(!/apiKey|taskKey|credentials/i.test(block), 'no credential keys logged: ' + site);
  }
  const rendererReport = extractBlock(rendererSource, 'function reportError');
  assert.ok(!/apiKey|taskKey|credentials/i.test(rendererReport), 'no credential keys in renderer reporting');
});

test('12. package.json wires a dependency-free npm test script', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts.test, 'test script exists');
  assert.ok(pkg.scripts.test.includes('run-all.js'), 'uses the Node runner');
  assert.ok(!pkg.scripts.test.includes('for f in'), 'no Unix-only shell loop');
  const devDeps = Object.keys(pkg.devDependencies || {});
  const deps = Object.keys(pkg.dependencies || {});
  const before = ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'];
  // The one deliberate production addition: the Zuni-SEO MCP client plus the
  // ajv pair used to validate its contract. No dev dependency was introduced.
  const prodBefore = ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'];
  assert.deepStrictEqual(devDeps.slice().sort(), before.slice().sort(), 'no dev dependencies added');
  assert.deepStrictEqual(deps.slice().sort(), prodBefore.slice().sort(), 'dependencies are the two originals plus the prospect-research trio');
});

test('13. test runner covers every *.test.js and fails non-zero', () => {
  const runner = fs.readFileSync(path.join(root, 'tests', 'run-all.js'), 'utf8');
  assert.ok(runner.includes(".endsWith('.test.js')"), 'discovers test files dynamically');
  assert.ok(runner.includes('run-all.js') && runner.includes("f !== 'run-all.js'"), 'excludes itself');
  assert.ok(runner.includes('process.exit(totalFailed > 0 ? 1 : 0)'), 'non-zero exit on failure');
  const files = fs.readdirSync(path.join(root, 'tests')).filter(f => f.endsWith('.test.js') && f !== 'run-all.js');
  assert.ok(files.length >= 13, 'runner will execute the full suite (' + files.length + ' files)');
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - real uncaughtException invocation under Electron');
console.log('  - real unhandledRejection invocation under Electron');
console.log('  - actual render-process-gone event firing');
console.log('  - live renderer -> main error reporting through appAPI.logs.report');
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
