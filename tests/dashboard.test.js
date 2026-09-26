'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');

function between(src, start, end) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return src.slice(from, to);
}

function fromMark(src, start) {
  const from = src.indexOf(start);
  assert.ok(from !== -1, 'slice start found: ' + start);
  return src.slice(from);
}

const dashSection = between(htmlSource, '<!-- Dashboard view', '<!-- Settings');
const dashMarker = '// === B5 Lead Library Dashboard ===';
const navMarker = '// === 视图切换时加载数据 ===';
const dashJs = between(rendererSource, dashMarker, navMarker);
const loadFn = between(dashJs, 'async function loadDashboard', '// Dashboard quick links');
const dashStyles = fromMark(cssSource, '/* Dashboard (B5)');
const navBlock = fromMark(rendererSource, navMarker);
const cspLine = '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-src \'none\'">';
const expectedChannels = [
  'provider:set-credentials', 'provider:test-connection',
  'collection:submit', 'collection:job-status', 'collection:job-result', 'collection:job-history',
  'settings:save', 'settings:load',
  'collector:get-numbers', 'collector:add-numbers', 'collector:export-numbers',
  'collector:delete-numbers', 'collector:storage-status',
  'collector:get-jobs',
  'collector:update-lead',
  'logs:export', 'logs:dir', 'logs:report',
  'proxy:detect'
];

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. dashboard nav item and view section exist exactly once', () => {
  assert.strictEqual((htmlSource.match(/data-view="dashboard"/g) || []).length, 1,
    'exactly one dashboard nav button');
  assert.strictEqual((htmlSource.match(/id="view-dashboard"/g) || []).length, 1,
    'exactly one dashboard section');
  assert.ok(dashSection.includes('view-top'), 'section has view-top');
  assert.ok(dashSection.includes('view-bottom'), 'section has view-bottom');
  assert.ok(!/<script/i.test(dashSection), 'no script tags inside the dashboard section');
});

test('2. dashboard title registered and lazy-loaded with the other views', () => {
  assert.ok(/dashboard:\s*'仪表盘'/.test(rendererSource), 'viewTitles.dashboard present');
  assert.ok(navBlock.includes("if (viewId === 'dashboard') loadDashboard();"),
    'nav click lazily calls loadDashboard');
  assert.ok(rendererSource.indexOf(dashMarker) !== -1, 'dashboard code block present');
});

test('3. no timers in dashboard code (loads on demand only)', () => {
  for (const fn of ['setInterval', 'setTimeout', 'requestAnimationFrame']) {
    assert.ok(!dashJs.includes(fn), 'no ' + fn + ' in the dashboard block');
    assert.ok(!loadFn.includes(fn), 'no ' + fn + ' inside loadDashboard');
  }
});

test('4. mandated read shapes: bounded lead total, storage status, jobs page', () => {
  assert.ok(loadFn.includes('const DASHBOARD_JOBS_PAGE_SIZE = 50') ||
    dashJs.includes('const DASHBOARD_JOBS_PAGE_SIZE = 50'),
    'jobs page size constant is 50');
  assert.ok(/getNumbers\(\{\s*limit:\s*1,\s*offset:\s*0\s*\}\)/.test(loadFn),
    'lead total fetched with {limit:1, offset:0}');
  assert.ok(loadFn.includes('storageStatus()'), 'storage status fetched');
  assert.ok(/getJobs\(\{\s*limit:\s*DASHBOARD_JOBS_PAGE_SIZE,\s*offset\s*\}\)/.test(loadFn),
    'jobs fetched with bounded {limit:50, offset}');
  assert.ok(!/getNumbers\((?!{)/.test(loadFn), 'lead fetch always passes an explicit query');
});

test('5. every ledger field rendered through escapeHtml', () => {
  assert.ok(loadFn.includes('escapeHtml(ledgerRow.runSlug'), 'runSlug escaped');
  assert.ok(loadFn.includes('escapeHtml(ledgerRow.providerId'), 'providerId escaped');
  assert.ok(loadFn.includes('escapeHtml(statusText)'), 'status text escaped');
  assert.ok(loadFn.includes('escapeHtml(formatJobTime(ledgerRow.startedAt))'), 'startedAt escaped');
  assert.ok(loadFn.includes('escapeHtml(formatJobTime(ledgerRow.completedAt))'), 'completedAt escaped');
  assert.ok(loadFn.includes('escapeHtml(ledgerRow.resultCount'), 'resultCount escaped');
  assert.ok(loadFn.includes('escapeHtml(ledgerRow.error'), 'error escaped');
});

test('6. job status vocabulary limited to running/succeeded/failed', () => {
  const statusChecks = (loadFn.match(/job\.status === '([a-z]+)'/g) || [])
    .map(s => s.match(/'([a-z]+)'/)[1]);
  assert.deepStrictEqual(statusChecks.slice().sort(), ['failed', 'running', 'succeeded'],
    'exactly the three approved job statuses');
  for (const banned of ['queued', 'partial', 'cancelled', 'created', 'retrying']) {
    assert.ok(!dashJs.includes("'" + banned + "'"), 'no ' + banned + ' status literal');
  }
});

test('7. no lead-status breakdown or per-status number counts', () => {
  const combined = dashSection + dashJs;
  assert.ok(!/filters:\s*\{\s*status/.test(combined), 'no status filter object');
  assert.ok(!combined.includes('number-filter-status'), 'no status-filter DOM usage');
  assert.ok(!/GROUP BY/i.test(combined), 'no GROUP BY');
  assert.ok(!/numberStatus|leadStatus/i.test(combined), 'no lead-status aggregation');
});

test('8. pagination wired to the bounded jobs page', () => {
  assert.ok(loadFn.includes("renderPagination('dashboard-jobs-pagination'"),
    'renderPagination used for jobs');
  assert.ok(dashSection.includes('id="dashboard-jobs-pagination"'), 'pagination container present');
  assert.ok(dashSection.includes('id="dashboard-jobs-body"'), 'jobs table body present');
  const th = (dashSection.match(/<th>/g) || []).length;
  assert.strictEqual(th, 7, 'exactly 7 job-table columns');
});

test('9. single IPC read channel with validated passthrough', () => {
  const handlers = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
  // B6.2 declared lock update: the declared set grows by exactly one audited
  // channel, collector:update-lead (the B6 user-owned lead write). The B5
  // dashboard read contract asserted below is unchanged.
  assert.deepStrictEqual(handlers.slice().sort(), expectedChannels.slice().sort(),
    'channel set is the declared 19-channel contract');
  assert.strictEqual(handlers.length, 19, 'exactly 19 channels');
  const handler = between(mainSource, "ipcMain.handle('collector:get-jobs'", '});');
  assert.ok(handler.includes('validateHistoryPaging(query)'), 'paging validated');
  assert.ok(handler.includes('accountStore.queryJobs'), 'queryJobs passthrough');
  assert.ok(handler.includes('rejectLog'), 'invalid params logged');
  assert.ok(handler.includes('invalidParams'), 'invalid-params branch');
  assert.ok((mainSource.match(/ipcMain\.handle\('collector:get-jobs'/g) || []).length === 1,
    'registered exactly once');
  assert.ok(preloadSource.includes("ipcRenderer.invoke('collector:get-jobs', query)"),
    'preload exposes getJobs');
  assert.ok(rendererSource.includes('appAPI.collector.getJobs'), 'renderer uses getJobs');
  assert.ok(!rendererSource.includes("'collector:get-jobs'"),
    'renderer never touches the raw channel name');
  assert.ok(!preloadSource.includes('queryJobs'), 'preload stays store-agnostic');
  assert.ok(!rendererSource.includes('queryJobs'), 'renderer never sees store internals');
});

test('10. no credentials or secrets referenced by the dashboard', () => {
  const combined = dashSection + dashJs;
  for (const term of ['apiKey', 'taskKey', 'credentials', 'Bearer', 'authorization']) {
    assert.ok(!combined.includes(term), 'no ' + term + ' in dashboard code');
  }
});

test('11. no ranking/priority/fallback semantics', () => {
  const combined = dashSection + dashJs + dashStyles;
  const match = combined.match(/priority|rank|failover|preferred|fallback|scoring/i);
  assert.ok(!match, 'banned term absent, found: ' + (match && match[0]));
  assert.ok(!combined.includes('btn-primary'), 'no primary CTA class');
});

test('12. no charts, canvas, eval or new dependencies', () => {
  const combined = dashSection + dashJs + dashStyles;
  for (const term of ['canvas', 'chart', '<script', 'eval(', 'new Function', 'd3', 'plotly']) {
    assert.ok(!combined.includes(term), 'no ' + term + ' in dashboard code');
  }
});

test('13. CSP meta line byte-identical', () => {
  assert.strictEqual((htmlSource.split(cspLine).length - 1), 1, 'expected CSP line present once');
  assert.strictEqual((htmlSource.match(/Content-Security-Policy/g) || []).length, 1,
    'exactly one CSP meta tag');
});

test('14. accountStore untouched by the dashboard feature', () => {
  assert.ok(!storeSource.includes('dashboard'), 'store has no dashboard code');
  assert.ok(!/GROUP BY/i.test(storeSource), 'store still has no GROUP BY');
  assert.ok(storeSource.includes('queryJobs'), 'queryJobs still present for the read path');
  assert.ok(storeSource.includes("DEFAULT 'pending'"),
    'lead status remains single-valued pending');
});

test('15. dashboard CSS is additive only', () => {
  assert.ok(dashStyles.length > 0, 'dashboard styles block present');
  for (const selector of ['#view-dashboard', '.dashboard-stats', '.dashboard-stat-value']) {
    assert.ok(dashStyles.includes(selector), 'expected selector: ' + selector);
  }
  assert.ok(!dashStyles.includes('@import'), 'no new imports');
  assert.ok(!/url\(/i.test(dashStyles), 'no external resources');
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
