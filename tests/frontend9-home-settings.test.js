'use strict';

// Frontend 2.0 F9 — Home + Settings workspaces.
//
// F9 is presentation over EXISTING contracts only. Home reads the same B5 data
// (lead total, storage status, the bounded job ledger page) plus three existing
// list reads (saved searches, segments, targets), and routes to live views. It
// shows no conversion, growth, revenue, forecast, trend or score figure. Settings
// keeps every existing control id, handler and the settings:load / settings:save
// envelope byte for byte; it only groups the controls and shows, from the
// booleans main already returns, whether each key is stored. The renderer never
// receives key material. The pure Home and Settings helpers are lifted from
// renderer.js and executed here. No jsdom, no network.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const vaultSource = fs.readFileSync(path.join(root, 'src', 'main', 'credentialVault.js'), 'utf8');

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

function functionSource(source, marker) {
  const from = source.indexOf(marker);
  assert.ok(from !== -1, 'function found: ' + marker);
  assert.strictEqual(source.indexOf(marker, from + 1), -1, 'defined once: ' + marker);
  const close = source.indexOf('\n}', from);
  return source.slice(from, close + 2);
}

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const HOME_HTML = between(htmlSource, '<!-- Dashboard view', '<!-- Settings');
const SETTINGS_HTML = between(htmlSource, '<!-- Settings', '</main>');
const HOME_JS = between(rendererSource, '// === B5 Lead Library Dashboard ===', '// === F4: Collection workflow');
const HOME_CODE = codeOnly(HOME_JS);
const LOAD_FN = between(HOME_JS, 'async function loadDashboard', '// Dashboard quick links');
const SETTINGS_JS = between(rendererSource, '// === F9 Settings workspace ===', '// === 保存采集结果到号码库 ===');
const SETTINGS_CODE = codeOnly(SETTINGS_JS);
const F9_CSS = between(cssSource, 'ZTech Frontend 2.0 - F9: Home and Settings', 'ZTech Frontend 2.0 - F3: Leads workspace.');
const NAV_BLOCK = between(rendererSource, '// === 视图切换时加载数据 ===', '// === F8 Intelligence workspace ===');
const CSP_LINE = '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-src \'none\'">';

// Lift the pure helpers. formatJobTime is the existing B5 formatter.
const helpers = new Function([
  functionSource(rendererSource, 'function formatJobTime('),
  functionSource(rendererSource, 'function homeStorageFacts('),
  functionSource(rendererSource, 'function homeLeadsMeta('),
  functionSource(rendererSource, 'function homeLastRunText('),
  functionSource(rendererSource, 'function homeCountText('),
  functionSource(rendererSource, 'function settingsKeyStateText('),
  'return { formatJobTime, homeStorageFacts, homeLeadsMeta, homeLastRunText, homeCountText, settingsKeyStateText };'
].join('\n'))();

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// --- Home ------------------------------------------------------------------

test('1. Home keeps every B5 value slot, once, inside an F9 workspace header', () => {
  for (const id of ['dashboard-total-leads', 'dashboard-storage-state', 'dashboard-total-runs',
    'dashboard-runs-running', 'dashboard-runs-succeeded', 'dashboard-runs-failed',
    'dashboard-counts-window', 'dashboard-jobs-body', 'dashboard-jobs-pagination']) {
    assert.strictEqual((htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, 'exactly one #' + id);
    assert.ok(HOME_HTML.includes(`id="${id}"`), id + ' is on Home');
  }
  assert.ok(/<h2 class="lists-title">Home<\/h2>/.test(HOME_HTML), 'the workspace has a Home title');
  assert.ok(HOME_HTML.includes('id="home-refresh"'), 'a Refresh action re-reads the same data');
  assert.strictEqual((HOME_HTML.match(/<th>/g) || []).length, 7, 'the run ledger keeps its seven columns');
  assert.ok(!HOME_HTML.includes('btn-primary'), 'no primary call to action competes on Home');
});

test('2. Home shows no invented metric of any kind', () => {
  const text = HOME_HTML + HOME_CODE;
  const banned = /conversion|growth|revenue|forecast|pipeline value|trend|\d+\s*%|\bscore|\bAI\b|percent|\brate\b|velocity|estimated/i;
  const hit = text.match(banned);
  assert.ok(!hit, 'no invented metric vocabulary, found: ' + (hit && hit[0]));
  assert.ok(!/Math\.random|Date\.now\(\)/.test(HOME_CODE), 'no generated figure or fabricated timestamp');
});

test('3. Home reads only existing contracts, and only through appAPI', () => {
  const calls = [...new Set([...HOME_CODE.matchAll(/window\.appAPI\.([a-zA-Z]+\.[a-zA-Z]+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(calls, ['collector.getJobs', 'collector.getNumbers', 'collector.storageStatus',
    'lists.listSavedSearches', 'lists.listSegments', 'targets.list'], 'exactly the existing read methods');
  for (const method of ['listSavedSearches: ()', 'listSegments: ()', 'list: ()', 'storageStatus: ()', 'getJobs: (query)', 'getNumbers: (query)']) {
    assert.ok(preloadSource.includes(method), 'preload already exposes ' + method);
  }
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(HOME_CODE), 'no renderer network access');
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame/.test(HOME_CODE), 'Home loads on demand, never polls');
});

test('4. zero-data Home is honest', () => {
  assert.strictEqual(helpers.homeLeadsMeta(0), 'No leads yet. Start a collection to build the library.');
  assert.strictEqual(helpers.homeLeadsMeta(12), 'In the local library');
  assert.strictEqual(helpers.homeLastRunText([]), 'No runs recorded yet');
  assert.strictEqual(helpers.homeLastRunText([{ startedAt: null }]), 'Start time not recorded');
  const last = helpers.homeLastRunText([{ startedAt: '2026-09-01T10:00:00.000Z' }]);
  assert.strictEqual(last, 'Last started ' + helpers.formatJobTime('2026-09-01T10:00:00.000Z'), 'the newest stored start time only');
  // The empty ledger state names what is missing and routes to Collection.
  assert.ok(LOAD_FN.includes('if (rows.length === 0)'), 'the empty ledger has its own branch');
  assert.ok(HOME_JS.includes("'No collection runs yet'"), 'the empty ledger title');
  assert.ok(/homeEmptyRuns[\s\S]*?dataset\.gotoView = 'collector'/.test(HOME_JS), 'the empty state opens Collection');
});

test('5. storage facts come from the storage status fields alone', () => {
  assert.deepStrictEqual(helpers.homeStorageFacts({ mode: 'sql', quarantine: null, dataMayBeIncomplete: false }),
    { engine: 'SQLite database', integrity: 'No problems reported', healthy: true });
  const degraded = helpers.homeStorageFacts({ mode: 'json-x', quarantine: null, dataMayBeIncomplete: true });
  assert.strictEqual(degraded.engine, 'JSON storage (the database could not be opened)');
  assert.strictEqual(degraded.integrity, 'Data may be incomplete');
  assert.strictEqual(degraded.healthy, false);
  assert.strictEqual(helpers.homeStorageFacts(null).engine, 'Unavailable', 'an unreadable status is never shown as healthy');
  assert.strictEqual(helpers.homeStorageFacts(null).healthy, false);
});

test('6. workspace counts are real list lengths, or Unavailable', () => {
  assert.strictEqual(helpers.homeCountText({ status: 'fulfilled', value: { rows: [{}, {}] } }), '2');
  assert.strictEqual(helpers.homeCountText({ status: 'fulfilled', value: { rows: [] } }), '0');
  assert.strictEqual(helpers.homeCountText({ status: 'rejected', reason: new Error('x') }), 'Unavailable');
  assert.strictEqual(helpers.homeCountText({ status: 'fulfilled', value: null }), 'Unavailable');
  const active = (row) => row.status === 'active';
  assert.strictEqual(helpers.homeCountText({ status: 'fulfilled', value: { rows: [{ status: 'active' }, { status: 'archived' }] } }, active), '1');
  for (const id of ['home-saved-searches', 'home-segments', 'home-targets', 'home-storage-engine', 'home-storage-integrity']) {
    assert.ok(HOME_HTML.includes(`id="${id}"`), 'fact slot #' + id);
  }
  assert.ok(HOME_JS.includes('Promise.allSettled'), 'one failing list never blanks the others');
});

test('7. Home actions route to existing live views only', () => {
  const targets = [...HOME_HTML.matchAll(/data-goto-view="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(targets)].sort(),
    ['collector', 'completed', 'history', 'icp', 'numbers', 'queue', 'searches', 'segments'], 'the live destinations');
  const nav = between(htmlSource, '<nav class="sidebar-nav"', '</nav>');
  for (const view of new Set(targets)) {
    const item = nav.match(new RegExp(`<button class="([^"]*)" data-view="${view}"`));
    assert.ok(item, 'a sidebar route exists for ' + view);
    assert.ok(!item[1].includes('nav-item-soon'), view + ' is live, not a Soon item');
    assert.ok(htmlSource.includes(`id="view-${view}"`), 'the view exists: ' + view);
  }
  assert.ok(HOME_JS.includes("e.target.closest('[data-goto-view]')"), 'actions reuse the existing sidebar switch');
});

test('8. every ledger value is escaped and the status is a text label', () => {
  for (const field of ['runSlug', 'providerId', 'error']) {
    assert.ok(LOAD_FN.includes(`escapeHtml(ledgerRow.${field}`), field + ' escaped');
  }
  assert.ok(LOAD_FN.includes('escapeHtml(statusText)'), 'status text escaped');
  assert.ok(!LOAD_FN.includes('style="${statusClass}"'), 'status colour is a class, not an inline style');
  assert.ok(/class="home-run-status" data-status="\$\{statusKey\}"/.test(LOAD_FN), 'status badge keyed by a fixed vocabulary');
  assert.ok(/const statusKey = \['running', 'succeeded', 'failed'\]\.includes\(ledgerRow\.status\) \? ledgerRow\.status : 'other';/.test(LOAD_FN),
    'the badge key can only be one of four fixed words');
});

// --- Settings ----------------------------------------------------------------

test('9. every existing Settings control survives, once, with its type', () => {
  const ids = ['settings-apikey', 'settings-task-key', 'settings-proxy-url', 'settings-research-baseurl',
    'settings-research-transport', 'settings-research-hint', 'settings-research-key', 'settings-research-key-status',
    'settings-research-health', 'btn-test-apikey', 'btn-clear-apikey', 'btn-test-taskkey', 'btn-clear-taskkey',
    'btn-detect-proxy', 'btn-research-clear-key', 'btn-save-settings', 'btn-export-logs'];
  for (const id of ids) {
    assert.strictEqual((htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, 'exactly one #' + id);
    assert.ok(SETTINGS_HTML.includes(`id="${id}"`), id + ' is in Settings');
  }
  for (const id of ['settings-apikey', 'settings-task-key', 'settings-research-key']) {
    assert.ok(new RegExp(`<input type="password" id="${id}"`).test(SETTINGS_HTML), id + ' stays a password field');
  }
  assert.ok(/id="settings-research-key"[^>]*autocomplete="off"/.test(SETTINGS_HTML), 'the research key is never autofilled');
  assert.ok(/<option value="mcp">MCP<\/option>\s*<option value="rest">REST<\/option>/.test(SETTINGS_HTML), 'the two transports');
  assert.ok(!/settings-research-timeout|settings-provider-|settings-collection-provider/.test(SETTINGS_HTML), 'no invented provider setting');
});

test('10. Settings is organised into nine groups, each holding its own controls', () => {
  const groups = [...SETTINGS_HTML.matchAll(/<section class="settings-group" id="settings-group-([a-z]+)"/g)].map((m) => m[1]);
  // I3/I4 declared lock update: + 'intelligence' (Opportunity Intelligence service and keys).
  // F26 declared lock update: + 'business', 'email', 'whatsapp' (Outreach Settings).
  // F26.6 declared lock update: + 'mailboxes' (connected mailboxes, pacing limits, market rules).
  assert.deepStrictEqual(groups, ['collection', 'research', 'intelligence', 'business', 'email', 'mailboxes', 'whatsapp', 'network', 'security', 'application']);
  const group = (name) => {
    const start = SETTINGS_HTML.indexOf(`id="settings-group-${name}"`);
    const end = SETTINGS_HTML.indexOf('<section class="settings-group"', start + 1);
    return SETTINGS_HTML.slice(start, end === -1 ? undefined : end);
  };
  const has = (name, ids) => ids.forEach((id) => assert.ok(group(name).includes(`id="${id}"`), `${id} in ${name}`));
  has('collection', ['settings-apikey', 'btn-test-apikey', 'btn-clear-apikey', 'settings-task-key', 'btn-test-taskkey', 'btn-clear-taskkey']);
  has('research', ['settings-research-baseurl', 'settings-research-transport', 'settings-research-key', 'btn-research-clear-key', 'settings-research-health', 'btn-research-health']);
  has('intelligence', ['oi-service-state', 'oi-service-mode', 'btn-oi-choose-folder', 'btn-oi-start', 'btn-oi-stop', 'btn-oi-restart', 'btn-oi-copy-log', 'oi-provider-rows', 'btn-oi-save-settings']);
  has('business', ['outreach-business-representativeName', 'outreach-business-companyName', 'btn-outreach-save-business']);
  has('email', ['outreach-email-enabled', 'outreach-email-domain', 'outreach-email-key', 'btn-outreach-email-verify', 'outreach-email-capability']);
  has('mailboxes', ['mailbox-provider-rows', 'mailbox-google-client-id', 'mailbox-google-client-secret', 'btn-mailbox-save-client', 'mailbox-rows', 'market-rule-rows', 'btn-market-rule-save']); // F26.6
  has('whatsapp', ['outreach-whatsapp-enabled', 'outreach-whatsapp-fromNumber', 'outreach-whatsapp-key', 'btn-outreach-whatsapp-verify', 'outreach-whatsapp-templates']);
  has('network', ['settings-proxy-url', 'btn-detect-proxy']);
  has('security', ['settings-security-apikey', 'settings-security-taskkey', 'settings-security-researchkey', 'settings-security-proxy']);
  has('application', ['btn-export-logs', 'settings-storage-engine']);
  const jumps = [...SETTINGS_HTML.matchAll(/data-settings-jump="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(jumps, groups, 'the section index lists the same groups in order');
  assert.ok(/class="settings-footer"[\s\S]*id="btn-save-settings"/.test(SETTINGS_HTML), 'Save sits in the sticky footer');
});

test('11. the settings contract is unchanged', () => {
  const load = between(mainSource, "ipcMain.handle('settings:load'", '// 采集结果管理');
  assert.ok(/return \{\s*hasApiKey,\s*hasTaskKey,\s*proxyUrl,\s*research: \{ \.\.\.researchSettings, hasApiKey: researchHasKey \}\s*\};/.test(load),
    'settings:load returns the same envelope');
  assert.ok(mainSource.includes('return { success: true, proxyApplied: proxyResult.applied };'), 'settings:save envelope');
  assert.ok(mainSource.includes("const out = { apiKey: '', taskKey: '', proxyUrl: '', clearApiKey: false, clearTaskKey: false };"), 'save payload shape');
  assert.ok(preloadSource.includes("save: (settings) => ipcRenderer.invoke('settings:save', settings),"), 'preload save');
  assert.ok(preloadSource.includes("load: () => ipcRenderer.invoke('settings:load')"), 'preload load');
  const handlers = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(handlers.length, 34, 'F9 adds no IPC channel');
  // A10 declared lock update: 41 -> 46 preload invocations. F9 itself still adds
  // no preload method; the increase is the five approved Lead Intelligence
  // methods added by A10.
  // F18 declared lock update: 49 -> 50, the single read-only prepare method.
  // F19 declared lock update: 50 -> 51, the single send boundary.
  // F21 declared lock update: 51 -> 52, the single read-only send-ledger read.
  // Phase I2: +7 Opportunity Intelligence channels = 59 total.
  // I3/I4 declared lock update: +4 OI settings, +6 OI service, +7 F26 outreach settings methods +1 I6 timeline, +1 I7 pitch preview = 78 total. F26.5 declared lock update: +5 trust (forLead, suppress, lift, recordConsent, handoff) = 83 total. F26.6 declared lock update: +10 mailboxes (providers, list, connect, disconnect, setDefault, setLimits, setGoogleClient, marketRules, setMarketRule, removeMarketRule; none sends) = 93 total.
  assert.strictEqual((preloadSource.match(/ipcRenderer\.invoke\(/g) || []).length, 93, 'A10..F21 + Phase I2 add the eighteen Lead Intelligence preload methods');
  assert.ok(vaultSource.includes("const CREDENTIAL_FIELDS = ['apiKey', 'taskKey'];"), 'credentialVault untouched');
  // The existing save / clear / test handlers keep their payloads.
  assert.ok(/apiKey: document\.getElementById\('settings-apikey'\)\.value\.trim\(\),\s*taskKey: document\.getElementById\('settings-task-key'\)\.value\.trim\(\),\s*proxyUrl: document\.getElementById\('settings-proxy-url'\)\.value\.trim\(\),\s*research: collectResearchSettings\(\)/.test(rendererSource),
    'the save payload is unchanged');
  assert.ok(rendererSource.includes('window.appAPI.provider.testConnection(undefined, undefined, undefined, true)'), 'stored-key test path kept');
});

test('12. key state is shown from booleans only; no key value reaches the page', () => {
  assert.strictEqual(helpers.settingsKeyStateText(true), 'Stored');
  assert.strictEqual(helpers.settingsKeyStateText(false), 'Not stored');
  assert.strictEqual(helpers.settingsKeyStateText(undefined), 'Not stored');
  const render = functionSource(rendererSource, 'function renderSettingsKeyStates(');
  assert.ok(render.includes('s.hasApiKey === true') && render.includes('s.hasTaskKey === true'), 'collection booleans');
  assert.ok(render.includes('research.hasApiKey === true'), 'research boolean');
  assert.ok(!/\.value\s*=/.test(render), 'never writes an input value');
  assert.ok(!/innerHTML/.test(SETTINGS_CODE), 'the F9 settings code writes text only');
  assert.ok(!/getApiKey|reveal\(|apiKey:\s*[a-z]/i.test(SETTINGS_CODE.replace(/hasApiKey/g, '')), 'no key read path');
  const loadFn = functionSource(rendererSource, 'async function loadSettings(');
  assert.ok(loadFn.includes("apiInput.value = '';") && loadFn.includes("taskInput.value = '';"), 'key fields always empty on load');
  assert.ok(loadFn.includes('renderSettingsKeyStates(settings);'), 'load renders the stored/not stored state');
  const saveKey = functionSource(rendererSource, 'async function saveResearchKey(');
  assert.ok(saveKey.includes("input.value = '';") && saveKey.includes("setSettingsKeyState('researchkey', true);"), 'research key write-only, state updated');
  const clearKey = functionSource(rendererSource, 'async function clearResearchKey(');
  assert.ok(clearKey.includes("setSettingsKeyState('researchkey', false);"), 'research key clear updates the state');
});

test('13. Settings loads its read-only facts on open, through existing channels', () => {
  assert.ok(NAV_BLOCK.includes("if (viewId === 'settings') loadSettingsWorkspace();"), 'lazy load on open');
  const fn = functionSource(rendererSource, 'async function loadSettingsWorkspace(');
  assert.ok(fn.includes('loadSettings()') && fn.includes('refreshResearchHealth()'), 'reuses the existing loaders');
  assert.ok(fn.includes('window.appAPI.collector.storageStatus()'), 'storage engine from the existing status channel');
  const calls = [...new Set([...SETTINGS_CODE.matchAll(/window\.appAPI\.([a-zA-Z]+\.[a-zA-Z]+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(calls, ['collector.storageStatus'], 'the F9 settings block adds no other call');
  assert.ok(/getElementById\('btn-research-health'\)\.addEventListener\('click', safeAsync\(refreshResearchHealth\)\)/.test(SETTINGS_JS),
    'Check status re-reads the cached provider state');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(rendererSource), 'no network API anywhere in the renderer');
});

test('14. the proxy hint no longer promises an auto-detect that does not happen on save', () => {
  assert.ok(!/leave empty to auto-detect/i.test(SETTINGS_HTML), 'an empty proxy means a direct connection');
  assert.ok(mainSource.includes("setProxy(proxyRules ? { proxyRules } : { mode: 'direct' })"), 'which is what main does');
  assert.ok(/Leave empty to connect directly/.test(SETTINGS_HTML), 'the hint says so');
});

// --- Shared --------------------------------------------------------------------

test('15. security boundaries are unchanged', () => {
  assert.strictEqual(htmlSource.split(CSP_LINE).length - 1, 1, 'CSP byte-identical');
  assert.ok(mainSource.includes('contextIsolation: true,') && mainSource.includes('nodeIntegration: false'), 'isolation unchanged');
  assert.ok(!/<script/i.test(HOME_HTML + SETTINGS_HTML), 'no inline script');
  assert.ok(!/\son[a-z]+="/i.test(HOME_HTML + SETTINGS_HTML), 'no inline handlers');
  assert.ok(!/credentials|Bearer|authorization|apiKey|taskKey/.test(HOME_JS + HOME_HTML), 'Home knows nothing about secrets');
});

test('16. English-only UI and F9 CSS within the design system', () => {
  const cjk = /[㐀-鿿]/;
  assert.ok(!cjk.test(HOME_HTML.replace(/<!--[\s\S]*?-->/g, '')), 'Home markup is English');
  assert.ok(!cjk.test(SETTINGS_HTML.replace(/<!--[\s\S]*?-->/g, '')), 'Settings markup is English');
  assert.ok(!/gradient|@import|url\(|outline:\s*none|box-shadow/i.test(F9_CSS), 'no gradient, shadow, import or removed focus ring');
  for (const m of F9_CSS.matchAll(/border-radius:\s*([^;]+);/g)) {
    assert.ok(/^var\(--radius-(sm|md)\)$/.test(m[1].trim()), 'small token radius only: ' + m[1]);
  }
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(F9_CSS), 'colours are tokens');
  assert.ok(/@media \(max-width: 1100px\)/.test(F9_CSS), 'a narrow-window layout exists');
  assert.ok(!/priority|rank|failover|preferred|fallback|scoring|chart|canvas|btn-primary/i.test(F9_CSS), 'B5 vocabulary rules still hold');
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
