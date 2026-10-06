'use strict';

// Frontend 2.0 F10 — Targets workspace.
//
// F10 is renderer-only presentation over the EXISTING Target contract:
// targets:list, targets:save and targets:set-status. It adds no channel, no
// delete / get / duplicate, no match count and no score. The criteria copy
// states what the ICP contract can actually evaluate with today's lead data,
// and requiring address (which the ICP contract refuses in this build) is not
// offered as a new required field. The pure helpers are lifted from renderer.js
// and executed here; the ICP facts they describe are checked against the
// shipped contract. No jsdom, no network.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const { targetToIcp } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'icp', 'icpFit.js'));
const { toLeadView } = require(path.join(root, 'src', 'main', 'lead-intelligence', 'contracts', 'leadView.js'));

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

function constSource(source, name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\n`).exec(source);
  assert.ok(m, 'constant found: ' + name);
  return m[0];
}

const codeOnly = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const TARGET_JS = between(rendererSource, '// === P1-F Target Builder (user-owned definitions) ===', '// === B5 Lead Library Dashboard ===');
const TARGET_CODE = codeOnly(TARGET_JS);
const VIEW = between(htmlSource, '<section class="view" id="view-targets">', '</section>');
const F10_CSS = between(cssSource, 'ZTech Frontend 2.0 - F10: Targets workspace.', 'ZTech Frontend 2.0 - F3: Leads workspace.');
const F8_JS = between(rendererSource, '// === F8 Intelligence workspace ===', '// === F7 Research workspace ===');
const CSP_LINE = '  <meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\'; object-src \'none\'; base-uri \'none\'; frame-src \'none\'">';

// Lift the pure helpers together with the constants they read.
const helpers = new Function([
  functionSource(rendererSource, 'function escapeHtml('),
  constSource(TARGET_JS, 'TARGET_STATUS_CHOICES'),
  constSource(TARGET_JS, 'TARGET_FIELD_LABELS'),
  constSource(TARGET_JS, 'TARGET_LIMITS'),
  constSource(TARGET_JS, 'TARGET_LIST_LABELS'),
  constSource(TARGET_JS, 'TARGET_REQUIRED_UNAVAILABLE'),
  'let targetEditingId = null;',
  functionSource(TARGET_JS, 'function targetParseTerms('),
  functionSource(TARGET_JS, 'function targetClip('),
  functionSource(TARGET_JS, 'function targetValidateDraft('),
  functionSource(TARGET_JS, 'function targetErrorMessage('),
  functionSource(TARGET_JS, 'function targetCriteriaSummary('),
  functionSource(TARGET_JS, 'function targetMatchesSearch('),
  functionSource(TARGET_JS, 'function targetUpdatedText('),
  functionSource(TARGET_JS, 'function targetRowHtml('),
  'return { targetParseTerms, targetValidateDraft, targetErrorMessage, targetCriteriaSummary, targetMatchesSearch, targetUpdatedText, targetRowHtml, TARGET_LIMITS };'
].join('\n'))();

const BAKU = {
  id: 't-1', name: 'Baku Dental', industry: 'Dental', status: 'active', updatedAt: '2026-09-28T10:00:00.000Z',
  businessTypes: ['Dentist', 'Dental Clinic', 'Orthodontist', 'Dental Lab'], locations: ['Baku', 'Absheron'],
  requiredFields: ['phone', 'website'], optionalFields: ['email'], exclusions: ['Casino']
};

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. every existing Target id and action stays compatible', () => {
  for (const id of ['target-name', 'target-industry', 'target-business-types', 'target-locations',
    'target-required-fields', 'target-optional-fields', 'target-exclusions', 'target-status',
    'btn-target-new', 'btn-target-save', 'btn-target-cancel', 'target-list', 'target-editor', 'target-status-bar']) {
    assert.strictEqual((htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, 'exactly one #' + id);
    assert.ok(VIEW.includes(`id="${id}"`), id + ' is in the Targets view');
  }
  for (const action of ['edit', 'toggle-status', 'use']) {
    assert.ok(TARGET_JS.includes(`data-action="${action}"`), 'action kept: ' + action);
  }
  assert.ok(rendererSource.includes("if (viewId === 'targets') loadTargets();"), 'lazy load unchanged');
  assert.ok(/<h2 class="lists-title">Targets<\/h2>\s*<p class="lists-subtitle">Reusable ICP definitions<\/p>/.test(VIEW), 'workspace header');
  assert.ok(VIEW.includes('id="target-search"') && VIEW.includes('>New Target</button>'), 'search and New Target');
  const heads = [...VIEW.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  assert.deepStrictEqual(heads, ['Name', 'Criteria', 'Status', 'Updated', 'Actions'], 'the five columns');
});

test('2-4. the three existing channels do all the work, each in its own place', () => {
  const calls = [...new Set([...TARGET_CODE.matchAll(/window\.appAPI\.(\w+\.\w+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(calls, ['targets.list', 'targets.save', 'targets.setStatus'], 'only the Target contract');
  assert.ok(functionSource(TARGET_JS, 'async function loadTargets(').includes('window.appAPI.targets.list()'), 'load uses targets:list');
  assert.ok(functionSource(TARGET_JS, 'async function saveTargetFromEditor(').includes('window.appAPI.targets.save(payload)'), 'create/edit uses targets:save');
  assert.ok(functionSource(TARGET_JS, 'async function setTargetArchived(').includes('window.appAPI.targets.setStatus({ id, status })'), 'archive/activate uses targets:set-status');
  for (const channel of ['targets:list', 'targets:save', 'targets:set-status']) {
    assert.ok(preloadSource.includes(`ipcRenderer.invoke('${channel}'`), 'preload still exposes ' + channel);
  }
});

test('5. no new IPC channel, preload method or delete/get/duplicate path', () => {
  const handlers = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(handlers.length, 34, 'main registers the same 34 channels');
  assert.strictEqual(handlers.filter((c) => c.startsWith('targets:')).length, 3, 'still three target channels');
  // A10 declared lock update: 41 -> 46 preload invocations (the five approved
  // Lead Intelligence methods). F10 still adds no preload method and main.js
  // still registers exactly 34 literal channels.
  // F18 declared lock update: 49 -> 50, the single read-only prepare method.
  // F19 declared lock update: 50 -> 51, the single send boundary.
  // F21 declared lock update: 51 -> 52, the single read-only send-ledger read.
  // Phase I2: +7 Opportunity Intelligence channels = 59 total.
  // I3/I4 declared lock update: +4 write-only OI settings methods, +6 OI service methods = 69 total.
  assert.strictEqual((preloadSource.match(/ipcRenderer\.invoke\(/g) || []).length, 69, 'preload includes A10..F21 + Phase I2 Opportunity Intelligence');
  assert.ok(!/targets:(delete|get|duplicate)|deleteTarget|duplicateTarget/.test(mainSource + preloadSource + rendererSource), 'no delete/get/duplicate');
  assert.ok(!/data-action="(delete|duplicate)"/.test(TARGET_JS) && !/>\s*(Delete|Duplicate)\s*</.test(VIEW), 'no Delete or Duplicate control');
});

test('6. every stored value is escaped in a row', () => {
  const hostile = {
    id: '"><img src=x onerror=alert(1)>', name: '<script>x</script>', industry: '<b>i</b>', status: 'archived" onclick="x',
    updatedAt: '<i>t</i>', businessTypes: ['<svg/onload=1>'], locations: ['"quoted"'], requiredFields: [], optionalFields: [], exclusions: ['<u>']
  };
  const html = helpers.targetRowHtml(hostile);
  assert.ok(!/<script|<img|<svg|<b>|<u>|<i>|onclick="x/.test(html), 'no markup survives: ' + html);
  assert.ok(html.includes('&lt;script&gt;x&lt;/script&gt;'), 'text is kept, escaped');
  assert.ok(html.includes('data-status="active"'), 'an unknown status falls back to a fixed word');
  const render = functionSource(TARGET_JS, 'function renderTargets(');
  assert.ok(render.includes('visible.map(targetRowHtml)'), 'rows come only from the escaping builder');
  for (const fn of ['function targetStateRow(', 'function setTargetErrors(', 'function setTargetFeedback(']) {
    const src = functionSource(TARGET_JS, fn);
    assert.ok(!src.includes('innerHTML') && src.includes('textContent'), fn + ' writes text only');
  }
  assert.ok(!/onclick=|onchange=|oninput=|eval\(|new Function/.test(TARGET_JS), 'no inline handler, no eval');
});

test('7. search covers name, industry, business types and locations on loaded data', () => {
  const m = (q) => helpers.targetMatchesSearch(BAKU, q);
  for (const q of ['baku dental', 'DENTAL', 'orthodont', 'absheron', '', '   ']) assert.strictEqual(m(q), true, 'matches: ' + q);
  for (const q of ['casino', 'phone', 'email', 'Ganja']) assert.strictEqual(m(q), false, 'does not match: ' + q);
  const render = functionSource(TARGET_JS, 'function renderTargets(');
  assert.ok(render.includes('targetRows.filter((row) => targetMatchesSearch(row, query))'), 'filters the loaded rows');
  assert.ok(TARGET_JS.includes("getElementById('target-search').addEventListener('input', () => renderTargets())"), 're-renders locally');
});

test('8. honest loading, empty, no-match and error states', () => {
  const render = functionSource(TARGET_JS, 'function renderTargets(');
  for (const text of ["'Loading targets\\u2026'", "'No Targets yet'", "'Create your first Target'", "'No Targets match your search.'", "'Targets unavailable.'", "label: 'Retry'"]) {
    assert.ok(render.includes(text), 'state: ' + text);
  }
  assert.ok(render.indexOf('targetLoadError') < render.indexOf('targetRows === null'), 'an error is never shown as empty');
  assert.ok(TARGET_JS.includes('let targetRows = null;'), 'an unloaded list is not an empty one');
  assert.ok(render.includes('onClick: safeAsync(() => loadTargets())'), 'retry re-reads through targets:list');
});

test('9. the save and status confirmations stay visible', () => {
  const save = functionSource(TARGET_JS, 'async function saveTargetFromEditor(');
  assert.ok(save.indexOf('closeTargetEditor();') < save.indexOf('setTargetFeedback('), 'confirmation is set after the editor closes');
  assert.ok(!functionSource(TARGET_JS, 'function closeTargetEditor(').includes('setTargetFeedback'), 'closing the editor never hides it');
  assert.ok(/setTargetFeedback\(`\$\{status === 'archived' \? 'Archived' : 'Activated'\}/.test(functionSource(TARGET_JS, 'async function setTargetArchived(')), 'archive/activate confirmed');
  assert.ok(!/setTimeout|setInterval/.test(TARGET_CODE), 'no timer hides it');
  assert.ok(VIEW.includes('id="target-feedback"') && VIEW.includes('role="status"'), 'announced to screen readers');
});

test('10. criteria copy is honest and matches the shipped ICP contract', () => {
  const notes = {
    industry: 'Recorded; ICP reports this as Unknown because leads currently do not carry industry data.',
    businessTypes: 'Recorded; ICP reports this as Unknown because leads currently do not carry business-type data.',
    locations: 'Recorded; ICP reports this as Unknown because leads currently do not carry city/country data.',
    exclusions: 'Recorded; not evaluated in this build.',
    optionalFields: 'Not used by ICP.'
  };
  for (const [field, text] of Object.entries(notes)) {
    assert.ok(VIEW.includes(`data-note="${field}">${text}</p>`), 'note for ' + field);
  }
  // The facts behind the copy, from the contract itself.
  const icp = targetToIcp({ ...BAKU, requiredFields: ['phone'] });
  const view = toLeadView({ id: 'l1', title: 'Clinic', phone: '+994 12 000 0000', address: 'Baku' });
  for (const f of ['industry', 'business_type', 'city', 'country']) assert.ok(!view[f], 'a ZTech lead carries no ' + f);
  assert.ok(icp.unmapped.includes('exclusions') && icp.exclusions.length === 0, 'exclusions are not evaluated');
  assert.ok(!targetToIcp({ id: 't', name: 'T', optionalFields: ['email'] }).criteria.length, 'optional fields are not used');
  // The summary is only what is stored.
  assert.deepStrictEqual(helpers.targetCriteriaSummary(BAKU), [
    'Industry: Dental', 'Business types: Dentist, Dental Clinic, Orthodontist +1 more', 'Locations: Baku, Absheron',
    'Requires: Phone, Website', 'Optional: Email', 'Exclusions (not evaluated): Casino'
  ]);
  // Review fix: the table can never present exclusions as an enforced rule.
  const rowHtml = helpers.targetRowHtml(BAKU);
  assert.ok(rowHtml.includes('Exclusions (not evaluated): Casino'), 'the row states exclusions are not evaluated');
  assert.ok(!/Excludes|Excluded/.test(rowHtml), 'no wording that implies exclusions are applied');
  assert.deepStrictEqual(helpers.targetCriteriaSummary({ name: 'Empty' }), []);
  assert.ok(helpers.targetRowHtml({ id: 'x', name: 'Empty' }).includes('No criteria recorded'));
});

test('11. no invented metric, count or score', () => {
  const text = VIEW + TARGET_CODE;
  const hit = text.match(/\bscore|\brank|leads? matched|match count|matching leads|conversion|probability|analytics|performance|\d+\s*%|\bAI\b/i);
  assert.ok(!hit, 'no metric vocabulary: ' + (hit && hit[0]));
  const render = functionSource(TARGET_JS, 'function renderTargets(');
  assert.ok(/`\$\{visible\.length\} of \$\{targetRows\.length\} Targets`/.test(render), 'the only count is of loaded Target definitions');
});

test('12. address is not offered as a new ICP-required field', () => {
  // The limitation is real: the contract refuses a Target that requires address.
  assert.throws(() => targetToIcp({ id: 't', name: 'T', requiredFields: ['address'] }), /invalid/i);
  assert.ok(/<input type="checkbox" value="address" id="target-required-address" disabled/.test(VIEW), 'the required checkbox starts disabled');
  assert.ok(VIEW.includes('Address is unavailable as a required ICP field in this build: ICP evaluation cannot use it.'), 'and says why');
  const blocked = helpers.targetValidateDraft({ name: 'x', requiredFields: ['address'] });
  assert.ok(!blocked.ok && /Address is unavailable as a required ICP field/.test(blocked.errors[0].message), 'a new address requirement is refused');
  assert.ok(helpers.targetValidateDraft({ name: 'x', requiredFields: ['address'], previousRequiredFields: ['address'] }).ok,
    'a stored Target that already requires it is not blocked (it can be cleared)');
  const sync = functionSource(TARGET_JS, 'function syncTargetFieldChoices(');
  assert.ok(sync.includes('TARGET_REQUIRED_UNAVAILABLE.includes(box.value) && !box.checked'), 'a checked legacy requirement stays clearable');
  assert.ok(helpers.targetValidateDraft({ name: 'x', optionalFields: ['address'] }).ok, 'address stays available as optional');
  // Review fix: a stored (pre-F10) address requirement is shown as it is stored,
  // and flagged as not usable by ICP. The data itself is not touched.
  const legacy = { id: 'l', name: 'Legacy', requiredFields: ['phone', 'address'], optionalFields: [] };
  const snapshot = JSON.stringify(legacy);
  assert.deepStrictEqual(helpers.targetCriteriaSummary(legacy), ['Requires: Phone, Address (not usable by ICP)']);
  assert.ok(helpers.targetRowHtml(legacy).includes('Requires: Phone, Address (not usable by ICP)'), 'the table row says so');
  assert.strictEqual(JSON.stringify(legacy), snapshot, 'the stored Target is not modified');
  assert.deepStrictEqual(helpers.targetCriteriaSummary({ id: 'o', name: 'O', optionalFields: ['address'] }), ['Optional: Address'],
    'optional address is not flagged (optional fields are not used by ICP at all)');
});

test('13. Open in ICP reuses the ICP workspace and preselects the Target', () => {
  assert.ok(TARGET_JS.includes('data-action="icp"') && TARGET_JS.includes('openIcpForTarget(id);'), 'row action');
  assert.ok(!/appAPI\.intelligence/.test(TARGET_CODE), 'the Target block makes no ICP call itself');
  const open = functionSource(F8_JS, 'function openIcpForTarget(');
  assert.ok(open.includes('icpPendingTargetId =') && open.includes(`querySelector('.nav-item[data-view="icp"]')`), 'routes through the existing ICP nav');
  const populate = functionSource(F8_JS, 'function populateIcpTargets(');
  assert.ok(populate.includes('const pending = icpPendingTargetId;') && populate.includes('icpPendingTargetId = null;'), 'used once');
  assert.ok(populate.includes('const previous = pending || select.value;'), 'preselected when still listed');
  assert.ok(functionSource(F8_JS, 'async function loadIcpResult(').includes('window.appAPI.intelligence.icpFit({ targetId })'), 'the existing intelligence:icp call evaluates it');
});

test('14. validation mirrors the real limits and reads as sentences', () => {
  const { targetValidateDraft: v, targetParseTerms: parse, TARGET_LIMITS: L } = helpers;
  assert.deepStrictEqual(L, { name: 120, industry: 120, terms: 20, termLength: 50 });
  assert.deepStrictEqual(parse('Dentist, dental clinic,\nDENTIST,  , Lab'), ['Dentist', 'dental clinic', 'Lab'], 'store order and duplicate rule');
  const terms = (n, len) => Array.from({ length: n }, (_, i) => 'y'.repeat(len - 1) + String.fromCharCode(97 + (i % 26))).join(', ');
  assert.ok(v({ name: 'ok', businessTypes: terms(20, 50), locations: terms(20, 50), exclusions: terms(20, 50) }).ok, '20 x 50 accepted');
  assert.strictEqual(v({ name: 'ok', locations: terms(21, 5) }).errors[0].message, 'Locations: 21 terms entered; the limit is 20.');
  assert.ok(/^Exclusions: ".*" is 51 characters; the limit is 50 per term\.$/.test(v({ name: 'ok', exclusions: 'x'.repeat(51) }).errors[0].message));
  assert.strictEqual(v({ name: '  ' }).errors[0].message, 'Name is required.');
  assert.strictEqual(v({ name: 'n'.repeat(121) }).errors[0].message, 'Name is 121 characters; the limit is 120.');
  assert.strictEqual(v({ name: 'ok', industry: 'i'.repeat(121) }).errors[0].message, 'Industry is 121 characters; the limit is 120.');
  assert.strictEqual(v({ name: 'ok', requiredFields: ['phone'], optionalFields: ['phone'] }).errors[0].message, 'Phone cannot be both required and optional.');
  // Server errors, including the Electron wrapper, become sentences.
  const e = helpers.targetErrorMessage;
  assert.strictEqual(e("Error invoking remote method 'targets:save': Error: Invalid target: businessTypes"),
    'Business types must have at most 20 terms of at most 50 characters each.');
  assert.strictEqual(e({ message: "Error invoking remote method 'targets:save': Error: Invalid target: name" }), 'Name is required and must be at most 120 characters.');
  assert.strictEqual(e('Invalid target: field is both required and optional: phone'), 'A field cannot be both required and optional.');
  assert.strictEqual(e('Invalid target: locations'), 'Locations must have at most 20 terms of at most 50 characters each.');
  for (const raw of ['', undefined, 'something odd', "Error invoking remote method 'targets:save': Error: boom"]) {
    const msg = e(raw);
    assert.ok(!/invoking|remote method|Error:/.test(msg), 'no raw IPC text: ' + msg);
  }
});

test('15. narrow layout, design tokens and unchanged security boundaries', () => {
  assert.ok(/@media \(max-width: 1100px\)/.test(F10_CSS), 'a narrow-window layout exists');
  assert.ok(!/gradient|@import|url\(|outline:\s*none|box-shadow|font-family/i.test(F10_CSS), 'no gradient, shadow, font or removed focus ring');
  for (const m of F10_CSS.matchAll(/border-radius:\s*([^;]+);/g)) assert.ok(/^var\(--radius-(sm|md)\)$/.test(m[1].trim()), 'small token radius: ' + m[1]);
  assert.ok(!/#[0-9a-f]{3,6}\b/i.test(F10_CSS), 'colours are tokens');
  assert.strictEqual(htmlSource.split(CSP_LINE).length - 1, 1, 'CSP byte-identical');
  assert.ok(!/<script|\son[a-z]+="/i.test(VIEW), 'no inline script or handler in the view');
  assert.ok(!/\bfetch\(|XMLHttpRequest|WebSocket|EventSource/.test(rendererSource), 'no renderer network API');
  assert.ok(!/apiKey|taskKey|credential|Bearer/.test(TARGET_CODE + VIEW), 'no secret surface');
  const required = between(htmlSource, 'id="target-required-fields"', '</div>');
  const optional = between(htmlSource, 'id="target-optional-fields"', '</div>');
  for (const box of [required, optional]) {
    assert.deepStrictEqual([...box.matchAll(/value="([^"]+)"/g)].map((m) => m[1]).sort(), ['address', 'email', 'phone', 'title', 'website']);
  }
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
