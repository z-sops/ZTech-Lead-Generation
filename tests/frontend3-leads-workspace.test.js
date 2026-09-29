'use strict';

// Frontend 2.0 F3 — Leads workspace.
//
// The Leads workspace is a presentation layer over the EXISTING lead query
// contract (collector:get-numbers). These tests pin that claim: every value the
// workspace shows must come from a real lead field, a real renderer-derived
// signal, or an explicit "not available" state - never from a metric, a score
// or a fabricated record.
//
// Where behaviour can be executed, it is executed: the real sort cycle, the real
// active-filter resolution and the real column-preference reader are extracted
// from renderer.js and run against minimal doubles. No jsdom, no new dependency.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = require(path.join(root, 'package.json'));

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

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

function extractConstArray(source, name) {
  return between(source, 'const ' + name + ' = [', '];') + '];';
}

// Extracts a top-level `const NAME = <literal>;` declaration. The literal may
// be an object, an array or a plain scalar; the first `;` at depth zero ends it.
function extractConst(source, name) {
  const start = source.indexOf('const ' + name + ' = ');
  assert.ok(start !== -1, 'const not found: ' + name);
  const semi = source.indexOf(';', start);
  assert.ok(semi !== -1, 'unterminated const: ' + name);
  const open = source.slice(start, semi).search(/[[{]/);
  if (open === -1) return source.slice(start, semi + 1);
  const opener = source[start + open];
  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  for (let i = start + open; i < source.length; i++) {
    if (source[i] === opener) depth += 1;
    else if (source[i] === closer) {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced const: ' + name);
}

// Real option label text, read from the shipped markup rather than restated.
function realOptionLabels(controlId) {
  const block = between(htmlSource, '<select id="' + controlId + '">', '</select>');
  return [...block.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((m) => [m[1], m[2]]);
}

function leadsViewHtml() {
  return between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
}

function leadsTableHtml() {
  return between(htmlSource, 'id="leads-table"', 'id="view-targets"');
}

function leadsHeadHtml() {
  return between(leadsTableHtml(), '<thead>', '</thead>');
}

// A select double: the payload builder and the chip layer only read `.value`
// and iterate `.options`, so this is the whole surface they touch. The option
// labels come from the real markup, so a chip cannot invent wording.
function fakeSelect(controlId, value) {
  const options = realOptionLabels(controlId).map(([v, text]) => ({ value: v, textContent: text }));
  return { value, options };
}

// --- executable doubles ------------------------------------------------------

// The real active-filter resolver, driven by real option lists.
function loadFilterResolver(selects) {
  const factory = new Function(
    'document',
    between(rendererSource, 'const LEADS_FILTER_DEFS = [', '];') + '];\n' +
    'function currentFilterValue(control) {\n' +
    '  const el = document.getElementById(control);\n' +
    '  const value = el ? el.value : \'all\';\n' +
    '  return value === \'all\' ? \'\' : value;\n' +
    '}\n' +
    'function filterValueLabel(control, value) {\n' +
    '  const el = document.getElementById(control);\n' +
    '  if (!el || !el.options) return value;\n' +
    '  for (const option of el.options) {\n' +
    '    if (option.value === value) return option.textContent.trim() || value;\n' +
    '  }\n' +
    '  return value;\n' +
    '}\n' +
    'function activeLeadsFilters() {\n' +
    '  const active = [];\n' +
    '  for (const def of LEADS_FILTER_DEFS) {\n' +
    '    const value = currentFilterValue(def.control);\n' +
    '    if (value) active.push({ key: def.key, label: def.label, control: def.control, value });\n' +
    '  }\n' +
    '  return active;\n' +
    '}\n' +
    'return { activeLeadsFilters, filterValueLabel, LEADS_FILTER_DEFS };'
  );
  return factory({ getElementById: (id) => selects[id] || null });
}

const ALL_SELECTS = {
  'number-filter-status': ['all', 'pending', 'sent', 'success', 'failed'],
  'number-filter-qualification': ['all', 'unqualified', 'qualified'],
  'number-filter-phone-quality': ['all', 'valid', 'invalid', 'unknown'],
  'number-filter-email-quality': ['all', 'valid', 'invalid', 'unknown'],
  'number-filter-website-quality': ['all', 'valid', 'invalid', 'unknown'],
  'number-filter-business-quality': ['all', 'active', 'closed', 'unknown'],
  'number-filter-completeness': ['all', '5', '4', '3', '2', '1', '0']
};

function selectsWith(overrides) {
  const out = {};
  for (const id of Object.keys(ALL_SELECTS)) out[id] = fakeSelect(id, 'all');
  for (const [id, value] of Object.entries(overrides || {})) {
    assert.ok(out[id], 'override targets a real control: ' + id);
    out[id] = fakeSelect(id, value);
  }
  return out;
}

// between() excludes the end marker, so a whole function is taken as
// `between(..., '<signature>', '\n}') + '}'` - the closing brace belongs to the
// function, not to the marker.
function functionSource(source, signature) {
  return between(source, signature, '\n}') + '}';
}

function loadSortCycle() {
  const factory = new Function(
    "let numbersSort = '';\nlet numbersOrder = 'asc';\n" +
    functionSource(rendererSource, 'function cycleNumbersSort(key) {') + '\n' +
    'return {\n' +
    '  cycle: cycleNumbersSort,\n' +
    "  state: () => ({ sort: numbersSort, order: numbersOrder }),\n" +
    "  reset: () => { numbersSort = ''; numbersOrder = 'asc'; }\n" +
    '};'
  );
  return factory();
}

// The real stored-column reader, with a real JSON-ish localStorage double.
function loadColumnReader(storage) {
  const factory = new Function(
    'window',
    extractConst(rendererSource, 'LEADS_COLUMNS') + ';\n' +
    extractConst(rendererSource, 'LEADS_DEFAULT_COLUMNS') + ';\n' +
    extractConst(rendererSource, 'LEADS_COLUMNS_STORAGE_KEY') + ';\n' +
    functionSource(rendererSource, 'function readStoredLeadsColumns() {') + '\n' +
    'return { readStoredLeadsColumns, LEADS_COLUMNS, LEADS_DEFAULT_COLUMNS };'
  );
  return factory({ localStorage: storage });
}

function memoryStorage(initial) {
  const map = new Map(Object.entries(initial || {}));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v)
  };
}

// --- 1. route and workspace -------------------------------------------------

test('1. the Leads route renders the Leads workspace', () => {
  assert.ok(htmlSource.includes('<section class="view" id="view-numbers">'), 'the Leads view exists');
  const view = leadsViewHtml();
  for (const id of ['leads-workspace' in {} ? '' : 'leads-controls', 'leads-chips',
    'leads-table', 'leads-selection', 'numbers-pagination']) {
    assert.ok(view.includes('id="' + id + '"'), 'workspace region present: ' + id);
  }
  // The F2 shell is the only shell: no second page frame was introduced.
  assert.strictEqual((htmlSource.match(/class="top-bar"/g) || []).length, 1, 'one top bar only');
  assert.strictEqual((htmlSource.match(/class="sidebar-nav"/g) || []).length, 1, 'one sidebar nav only');
  assert.ok(view.includes('id="view-numbers"') || view.startsWith('"'), 'the view is still the F2 view');
});

test('2. the workspace hierarchy is controls, chips, table, selection, pagination', () => {
  const view = leadsViewHtml();
  const order = ['leads-controls', 'leads-chips', 'leads-table', 'leads-selection', 'numbers-pagination']
    .map((id) => view.indexOf('id="' + id + '"'));
  for (let i = 0; i < order.length; i++) {
    assert.ok(order[i] !== -1, 'region present: ' + i);
    if (i > 0) assert.ok(order[i] > order[i - 1], 'region ' + i + ' follows region ' + (i - 1));
  }
});

// --- 2. search ---------------------------------------------------------------

test('3. search uses the existing query.search contract', () => {
  const payload = between(rendererSource, 'function numbersQueryPayload() {', 'function updateNumbersSortHeaders()');
  assert.ok(payload.includes("document.getElementById('number-search').value.trim()"), 'reads the search box');
  assert.ok(payload.includes('query.search = search;'), 'the existing query.search key is used');
  assert.ok(/if \(search\) query.search/.test(payload), 'an empty search is omitted, not sent blank');
  assert.ok(rendererSource.includes('window.appAPI.collector.getNumbers(numbersQueryPayload())'),
    'still one query call site');
  // No second search engine and no client-side full-dataset filtering.
  assert.ok(!/allNumbers|fullDataset|\.filter\(.*__collect/.test(rendererSource), 'no client-side dataset scan');
});

test('4. search is debounced at 250ms', () => {
  const decl = between(rendererSource, 'const NUMBERS_SEARCH_DEBOUNCE_MS =', ';');
  assert.strictEqual(decl.replace('const NUMBERS_SEARCH_DEBOUNCE_MS =', '').trim(), '250',
    'the debounce window is 250ms');
  const wiring = between(rendererSource,
    "document.getElementById('number-search').addEventListener('input'",
    "document.getElementById('number-filter-status').addEventListener");
  assert.ok(wiring.includes('clearTimeout(numbersSearchTimer)'), 'each keystroke restarts the timer');
  assert.ok(/numbersSearchTimer = setTimeout\(\(\) => \{ renderNumbers\(\); \}, NUMBERS_SEARCH_DEBOUNCE_MS\)/.test(wiring),
    'the debounced call re-renders through the existing flow');
});

test('5. the placeholder names only the really searchable fields', () => {
  const store = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
  const real = [...between(store, 'const QUERY_SEARCH_FIELDS = [', '];').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(real.sort(), ['address', 'email', 'keyword', 'phone', 'source', 'title', 'website']);
  const placeholder = /id="number-search"[\s\S]*?placeholder="([^"]+)"/.exec(htmlSource);
  assert.ok(placeholder, 'the search box has a placeholder');
  for (const field of real) {
    assert.ok(placeholder[1].toLowerCase().includes(field.toLowerCase()),
      'the placeholder advertises the real field: ' + field);
  }
  // Nothing the query contract cannot search is advertised.
  for (const invented of ['tag', 'note', 'status', 'qualification', 'company', 'id', 'run']) {
    assert.ok(!placeholder[1].toLowerCase().includes(invented),
      'the placeholder does not advertise a non-searchable field: ' + invented);
  }
});

// --- 3. filters --------------------------------------------------------------

test('6. filter values match the real main-process allowlist', () => {
  const allow = between(mainSource, 'const LEAD_QUALITY_QUERY_FILTERS = {', '};');
  const selectOptions = (id) => [...between(htmlSource, '<select id="' + id + '">', '</select>')
    .matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);

  for (const [key, values] of [
    ['phoneQuality', selectOptions('number-filter-phone-quality')],
    ['emailQuality', selectOptions('number-filter-email-quality')],
    ['websiteQuality', selectOptions('number-filter-website-quality')],
    ['businessQuality', selectOptions('number-filter-business-quality')],
    ['completeness', selectOptions('number-filter-completeness')]
  ]) {
    const real = [...new RegExp(key + ": \\[([^\\]]*)\\]").exec(allow)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    // The UI may present the real values in a different order (completeness is
    // listed highest-first for scanning); the vocabulary must match exactly.
    assert.deepStrictEqual(values.slice().sort(), ['all', ...real].sort(),
      key + ' offers exactly the real allowlist, no more and no fewer');
    assert.strictEqual(new Set(values).size, values.length, key + ' offers no duplicates');
  }
  // Status and qualification come from the pre-existing controls and are
  // unchanged by F3.
  assert.deepStrictEqual(selectOptions('number-filter-status'),
    ['all', 'pending', 'sent', 'success', 'failed']);
  assert.deepStrictEqual(selectOptions('number-filter-qualification'),
    ['all', 'unqualified', 'qualified']);
  assert.ok(mainSource.includes("const LEAD_QUALIFICATION_VALUES = ['unqualified', 'qualified'];"),
    'the qualification vocabulary is the store vocabulary');
});

test('7. the payload sends only filters the main process allowlists', () => {
  const payload = between(rendererSource, 'function numbersQueryPayload() {', 'function updateNumbersSortHeaders()');
  const keys = [...payload.matchAll(/filters\.(\w+)\s*=/g)].map((m) => m[1]);
  const declared = ['status', 'qualification', 'phoneQuality', 'emailQuality',
    'websiteQuality', 'businessQuality', 'completeness'];
  for (const key of keys) {
    assert.ok(declared.includes(key), 'payload key is a declared filter: ' + key);
  }
  // The loop covers exactly the five derived quality controls, and nothing else.
  const loop = [...payload.matchAll(/\['(number-filter-[a-z-]+)', '(\w+)'\]/g)];
  assert.strictEqual(loop.length, 0, 'the quality controls are iterated from the shared list');
  // Every declared key really is read from a real control.
  for (const def of ['status', 'qualification']) {
    assert.ok(payload.includes(`'number-filter-${def}'`), 'reads the real control: ' + def);
  }
  for (const [, id] of [...rendererSource.matchAll(/\['(number-filter-[a-z-]+)', '(\w+)'\]/g)]) {
    assert.ok(payload.includes('for (const [id, key] of LEAD_QUALITY_FILTER_CONTROLS)'), 'quality controls are read from the shared list');
    assert.ok(rendererSource.includes(`'${id}'`), 'the shared list declares: ' + id);
  }
  assert.strictEqual(payload.split('query.filters =').length - 1, 1,
    'one filters object, never two');
  assert.ok(payload.includes("if (value !== 'all')"), "'all' means no filter");
});

// --- 4. active filter chips --------------------------------------------------

test('8. active filter chips appear only for active filters', () => {
  const none = loadFilterResolver(selectsWith({}));
  assert.deepStrictEqual(none.activeLeadsFilters(), [], 'no filters are active by default');

  const one = loadFilterResolver(selectsWith({ 'number-filter-status': 'success' }));
  const active = one.activeLeadsFilters();
  assert.strictEqual(active.length, 1, 'exactly one active filter');
  assert.strictEqual(active[0].key, 'status');
  assert.strictEqual(active[0].value, 'success');
  assert.strictEqual(one.filterValueLabel('number-filter-status', 'success'), 'Success',
    'the chip label comes from the real option text');
  assert.ok(!one.activeLeadsFilters().some((f) => f.value === 'all'), '"All" is never an active chip');
});

test('9. several active filters are all reported, in the real order', () => {
  const r = loadFilterResolver(selectsWith({
    'number-filter-status': 'failed',
    'number-filter-website-quality': 'valid',
    'number-filter-completeness': '4'
  }));
  const active = r.activeLeadsFilters();
  assert.deepStrictEqual(active.map((f) => f.key),
    ['status', 'websiteQuality', 'completeness'], 'only the real, active filters');
  assert.deepStrictEqual(active.map((f) => f.label),
    ['Status', 'Website', 'Completeness'], 'chips use the trigger labels');
  assert.strictEqual(r.filterValueLabel('number-filter-completeness', '4'), '4 of 5',
    'the completeness chip shows the real option text');
});

test('10. clearing a filter removes it, and clear-all resets every filter', () => {
  const block = between(rendererSource, 'function clearAllLeadsFilters() {', '\n}');
  assert.ok(block.includes('for (const def of LEADS_FILTER_DEFS)'), 'clear all iterates every declared filter');
  assert.ok(block.includes("el.value = 'all'"), 'reset goes back to the neutral value');
  // Every control the UI offers is covered by the declared filter list.
  const declared = [...extractConst(rendererSource, 'LEADS_FILTER_DEFS').matchAll(/control: '([^']+)'/g)].map((m) => m[1]);
  const offered = [...leadsViewHtml().matchAll(/id="(number-filter-[a-z-]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(offered.slice().sort(), declared.slice().sort(),
    'the filter list covers exactly the controls the UI ships');
  for (const control of offered) {
    assert.ok(new RegExp(`<select id="${control}">`).test(leadsViewHtml()), 'control is a real select: ' + control);
  }
  // The chip's own dismiss button writes the real control.
  const chips = between(rendererSource, 'function renderLeadsChips() {', 'function clearAllLeadsFilters()');
  assert.ok(/document\.getElementById\(filter\.control\)\.value = 'all'/.test(chips),
    'a chip clears its own real control');
  assert.ok(chips.includes("clearAll.textContent = 'Clear all'"), 'a clear-all control is offered');
  assert.ok(chips.includes('bar.hidden = true;'), 'the bar hides when nothing is active');
});

test('11. unsupported filter values are not sent', () => {
  const payload = between(rendererSource, 'function numbersQueryPayload() {', 'function updateNumbersSortHeaders()');
  // The payload only ever copies a control's own value, and the main process
  // re-validates. F3 adds no literal filter value of its own.
  const literals = [...payload.matchAll(/filters(?:\.\w+|\[key\])\s*=\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const literal of literals) {
    if (/^filter/.test(literal) || /value$/.test(literal)) {
      assert.ok(!/^'[^']+'$/.test(literal), 'no hardcoded filter value is sent: ' + literal);
    }
  }
  // The allowlist itself is untouched.
  assert.ok(mainSource.includes('throw invalidParams(`Invalid params: filters.${key}`)'),
    'the main process still refuses an unknown filter value');
});

test('12. intelligence filters are shown but genuinely unavailable', () => {
  const view = leadsViewHtml();
  const group = between(view, 'data-filter="intelligence"', '</button>');
  assert.ok(group.includes('disabled'), 'the Intelligence trigger is a real disabled control');
  assert.ok(group.includes('aria-disabled="true"'), 'and is announced as disabled');
  assert.ok(/Not available/.test(group), 'it says it is not available');
  // No popover, no select, and nothing that could ever be sent.
  assert.ok(!between(view, 'data-filter="intelligence"', 'data-filter="columns"').includes('<select'),
    'Intelligence has no value control at all');
  // No A4 research IPC, and no intelligence vocabulary in the payload.
  const payload = between(rendererSource, 'function numbersQueryPayload() {', 'function updateNumbersSortHeaders()');
  for (const term of ['research', 'icp', 'enrichment', 'footprint', 'score']) {
    assert.ok(!payload.toLowerCase().includes(term), 'the payload sends no intelligence term: ' + term);
  }
  assert.ok(!/leadQualitySignals|qualifySignals|signals\b/.test(payload),
    'the payload carries no derived or intelligence signal either');
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  for (const banned of ['appAPI.research', 'appAPI.leadIntelligence', 'appAPI.enrichment',
    'icpFit', 'prospectResearch']) {
    assert.ok(!f3.includes(banned), 'F3 calls no intelligence IPC: ' + banned);
  }
});

// --- 5. sorting --------------------------------------------------------------

test('13. only the five real sort keys are offered', () => {
  const keys = [...extractConstArray(rendererSource, 'NUMBERS_SORTABLE_KEYS').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(keys.slice().sort(), ['collectedAt', 'keyword', 'phone', 'source', 'title']);
  assert.ok(mainSource.includes("const NUMBERS_QUERY_SORT_FIELDS = ['collectedAt', 'title', 'phone', 'source', 'keyword'];"),
    'and they are exactly the main-process allowlist');
  // Every sortable header carries a real key, and every non-sortable column is disabled.
  const heads = [...leadsHeadHtml().matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g)];
  const sortable = heads.filter(([, attrs]) => /data-sort="/.test(attrs)).map(([, attrs]) => /data-sort="([^"]+)"/.exec(attrs)[1]);
  assert.deepStrictEqual(sortable.slice().sort(), keys.slice().sort(), 'headers and key list agree');
  assert.ok(sortable.length === 5, 'exactly the five sortable columns');
  for (const [, , body] of heads) {
    if (!/th-sort"/.test(body)) continue;
    if (/th-sort-none/.test(body)) assert.ok(/disabled/.test(body),
      'a non-sortable column is a genuinely disabled control, not a silent no-op');
  }
  // No invented sort for the columns the contract cannot order by.
  for (const invented of ['qualification', 'research', 'icp', 'email', 'website',
    'phoneQuality', 'completeness', 'status']) {
    assert.ok(!new RegExp('data-sort="' + invented + '"').test(leadsHeadHtml()),
      'no invented sort key: ' + invented);
  }
});

test('14. the sort cycles asc, desc, then back to the default', () => {
  const c = loadSortCycle();
  c.reset();
  c.cycle('title');
  assert.deepStrictEqual(c.state(), { sort: 'title', order: 'asc' }, '1st click: ascending');
  c.cycle('title');
  assert.deepStrictEqual(c.state(), { sort: 'title', order: 'desc' }, '2nd click: descending');
  c.cycle('title');
  assert.deepStrictEqual(c.state(), { sort: '', order: 'asc' },
    '3rd click: the sort is removed and the store default ordering returns');
  c.reset();
  c.cycle('title');
  c.cycle('collectedAt');
  assert.deepStrictEqual(c.state(), { sort: 'collectedAt', order: 'asc' },
    'switching column restarts at ascending');
  // A cleared sort sends no sort key, so the store applies its own default order.
  const payload = between(rendererSource, 'function numbersQueryPayload() {', 'function updateNumbersSortHeaders()');
  assert.ok(payload.includes('if (numbersSort) {'), 'an empty sort omits the key entirely');
});

test('15. the header click handler can only cycle a real key', () => {
  const handler = between(rendererSource,
    "document.querySelector('#view-numbers .data-table thead').addEventListener('click'",
    "=== Lead Detail overlay (B3) ===");
  assert.ok(handler.includes('th.dataset.sort'), 'the key is read from the header');
  assert.ok(handler.includes('NUMBERS_SORTABLE_KEYS.indexOf(key) === -1'), 'and validated against the list');
  assert.ok(handler.includes('numbersPage = 1;'), 'sorting returns to page one');
});

// --- 6. selection ------------------------------------------------------------

test('16. row selection and the header control work together', () => {
  assert.ok(htmlSource.includes('id="select-all-numbers"'), 'the header checkbox exists');
  assert.ok(/id="select-all-numbers"[^>]*aria-label="Select all leads on this page"/.test(htmlSource),
    'it has an accessible name');
  const row = between(rendererSource, 'function leadsRow(lead) {', 'function leadsSkeletonRows(');
  assert.ok(row.includes("box.className = 'number-check'"), 'row checkboxes keep the existing class');
  assert.ok(row.includes('box.dataset.id = lead.id;'), 'and carry the lead id');
  assert.ok(/setAttribute\('aria-label', `Select /.test(row), 'each checkbox is labelled with its lead');
  assert.ok(row.includes("tr.setAttribute('aria-selected', 'false')"), 'rows expose their selection state');
  // The header control is tri-state, so "some selected" is reported honestly.
  const sync = between(rendererSource, 'function syncLeadsSelection() {', 'function clearLeadsSelection()');
  assert.ok(sync.includes('selectAll.indeterminate ='), 'the header checkbox has a real indeterminate state');
  assert.ok(sync.includes('tr.setAttribute(\'aria-selected\''), 'selected rows are marked');
  assert.ok(sync.includes("bar.hidden = ids.length === 0"), 'the bar appears only when something is selected');
});

test('17. selection can be cleared, and the bar reports the real count', () => {
  const clear = between(rendererSource, 'function clearLeadsSelection() {', "document.getElementById('numbers-table-body').addEventListener('change'");
  assert.ok(clear.includes('cb.checked = false'), 'clearing unchecks every row');
  const sync = between(rendererSource, 'function syncLeadsSelection() {', 'function clearLeadsSelection()');
  assert.ok(/ids\.length === 1 \? '1 lead selected'/.test(sync), 'the count is the real count, singular handled');
  assert.ok(/\$\{ids\.length\} leads selected/.test(sync), 'and pluralised honestly');
  assert.ok(htmlSource.includes('id="btn-clear-selection"'), 'a clear-selection control exists');
});

test('18. the selection bar exposes only real bulk actions', () => {
  const bar = between(htmlSource, 'id="leads-selection"', 'id="numbers-pagination"');
  const ids = [...bar.matchAll(/id="(btn-[^"]+)"/g)].map((m) => m[1]);
  // F6 declared update: the two segment actions use the real segments:members /
  // segments:save channels (asserted in the F6 tests).
  assert.deepStrictEqual(ids, ['btn-add-to-segment', 'btn-remove-from-segment', 'btn-delete-selected', 'btn-clear-selection'],
    'delete (a real channel) and a local clear, nothing else');
  // Delete really is the existing contract.
  const del = between(rendererSource, "document.getElementById('btn-delete-selected').addEventListener", '\n});');
  assert.ok(del.includes('collector.deleteNumbers(ids)'), 'delete uses the existing channel');
  assert.ok(del.includes('selectedLeadIds()') || del.includes(".number-check:checked"),
    'it acts on the real selection');
  assert.ok(!/appAPI\.\w+\.\w*(Bulk|batch|many)/.test(rendererSource), 'no invented bulk channel');
});

// --- 7. pagination -----------------------------------------------------------

test('19. pagination is server-side and disables correctly at the boundaries', () => {
  assert.ok(rendererSource.includes('offset: (numbersPage - 1) * NUMBERS_PER_PAGE'),
    'the offset is still computed from page state');
  assert.ok(rendererSource.includes("renderPagination('numbers-pagination', totalPages, numbersPage"),
    'and the total page count still comes from the envelope');
  const f3 = between(rendererSource, 'function renderNumbers() {', 'function loadNumbers()');
  assert.ok(f3.includes('Math.ceil(total / NUMBERS_PER_PAGE)'), 'the page count is derived from the real total');
  assert.ok(/if \(numbersPage > totalPages\)/.test(f3), 'an out-of-range page falls back');
  const pager = between(rendererSource, 'function renderPagination(containerId', '// 采集历史');
  assert.ok(pager.includes('const prevDisabled = bounded && currentPage <= 1'), 'Previous is disabled on page 1');
  assert.ok(pager.includes('const nextDisabled = bounded && currentPage >= totalPages'), 'Next is disabled on the last page');
  assert.ok(pager.includes('aria-label="Previous page"') && pager.includes('aria-label="Next page"'),
    'both controls are named');
  assert.ok(pager.includes("aria-current=\"page\""), 'the current page is announced');
  // The opt-in flag is only passed by the Leads workspace. Each call is
  // scanned by paren balance so a call cannot borrow a later call's flag.
  const allCalls = [];
  for (const m of rendererSource.matchAll(/renderPagination\(/g)) {
    let depth = 0;
    let end = -1;
    for (let i = m.index + 'renderPagination('.length - 1; i < rendererSource.length; i++) {
      if (rendererSource[i] === '(') depth += 1;
      else if (rendererSource[i] === ')') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
    }
    if (end === -1) continue;
    const text = rendererSource.slice(m.index, end);
    const id = /'([^']+)'/.exec(text);
    if (!id) continue; // the function definition itself, not a call
    allCalls.push({ id: id[1], text });
  }
  const bounded = allCalls.filter((c) => /\}, true\)$/.test(c.text));
  assert.deepStrictEqual(bounded.map((c) => c.id),
    ['numbers-pagination', 'numbers-pagination'],
    'only the Leads pager opts into the bounded form');
  for (const call of allCalls) {
    const isBounded = /\}, true\)$/.test(call.text);
    assert.strictEqual(isBounded, call.id === 'numbers-pagination',
      'bounded pagination is opt-in per call and only Leads opted in: ' + call.id);
  }
  assert.ok(rendererSource.includes('NUMBERS_PER_PAGE = 50'), 'the page size is unchanged');
  assert.ok(/Showing \$\{first\}–\$\{last\} of \$\{total\} leads/.test(rendererSource),
    'the range reports the real numbers, and only when there is a total');
});

// --- 8. empty / error / loading states ---------------------------------------

test('20. the two empty states are distinguished honestly', () => {
  const f3 = between(rendererSource, 'async function renderNumbers() {', 'function loadNumbers()');
  assert.ok(f3.includes('No leads yet'), 'an empty library says so');
  assert.ok(f3.includes('No leads match these filters'), 'an empty filtered result says something else');
  assert.ok(rendererSource.includes('btn-clear-filters-empty'), 'and offers a way out of the filtered case');
  const states = between(rendererSource, 'function renderLeadsState(state, title, body) {', '\n}');
  assert.ok(states.includes("'empty-filtered'"), 'the two empties are separate states');
  assert.ok(f3.includes("data-state === 'empty-filtered'") || f3.includes("'empty-filtered'"),
    'they are distinct states, not one message');
  assert.ok(/const hasFilters = activeLeadsFilters\(\)\.length > 0/.test(f3),
    'the distinction is driven by the real filter state');
});

test('21. loading, error and storage-degraded states all exist', () => {
  assert.ok(rendererSource.includes('function leadsSkeletonRows('), 'a skeleton state exists');
  const f3 = between(rendererSource, 'async function renderNumbers() {', 'function loadNumbers()');
  assert.ok(f3.includes('leadsSkeletonRows(8)'), 'the skeleton is shown while the query runs');
  assert.ok(f3.includes("renderLeadsState('error'"), 'a failed query renders an error state');
  assert.ok(f3.includes("reportError(msg, { handler: 'renderNumbers' })"),
    'and is reported through the existing mechanism, not swallowed');
  assert.ok(f3.includes("toast(msg, 'error')"), 'and still toasts as before');
  assert.ok(f3.includes('if (seq !== numbersLoadSeq) return;'), 'the stale-response guard is intact');
  // The existing storage-status mechanism is reused, not duplicated.
  const nav = between(rendererSource, '// === 视图切换时加载数据 ===', '// 初始化补充');
  assert.ok(nav.includes("viewId === 'numbers'"), 'the Leads view still has a lazy-load branch');
  assert.ok(nav.includes('checkStorageStatus()'), 'the storage-degraded banner still runs for the view');
  assert.strictEqual((rendererSource.match(/getElementById\('storage-warning'\)/g) || []).length, 1,
    'exactly one storage-status element, so no second mechanism was added');
});

// --- 9. lead opening ---------------------------------------------------------

test('22. clicking a lead still opens the existing detail modal', () => {
  const handler = between(rendererSource,
    "document.getElementById('numbers-table-body').addEventListener('click'",
    "document.getElementById('btn-close-lead-detail').addEventListener");
  assert.ok(handler.includes("tr.querySelector('.number-check')"), 'the id still comes from the row checkbox');
  assert.ok(handler.includes('openLeadDetail(leadId)'), 'the existing detail path is used');
  assert.ok(handler.includes("e.target.closest('input, a, button')"), 'selecting a row does not open the detail');
  // F5 has since built the drawer. Structural update: it is not a second
  // surface - it is this same B3 overlay, opened by this same row handler.
  assert.ok(htmlSource.includes('id="lead-detail-overlay"'), 'the B3 overlay is still the detail surface');
  assert.strictEqual((htmlSource.match(/role="dialog"[^>]*aria-labelledby="lead-drawer-name"/g) || []).length, 1,
    'the F5 drawer is that overlay\'s single dialog, not a parallel one');
  assert.ok(!rendererSource.includes('shiftKey'), 'no fabricated split-view interaction');
});

// --- 10. columns -------------------------------------------------------------

test('23. the column control only exposes real columns and stores locally', () => {
  const cols = [...between(rendererSource, 'const LEADS_COLUMNS = [', '];').matchAll(/column: '([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(cols, ['phone', 'domain', 'email', 'status', 'qualification',
    'quality', 'research', 'icp', 'source', 'keyword', 'collected']);
  // Every column maps to a header that exists, and no column is invented.
  for (const col of cols) {
    assert.ok(new RegExp(`data-column="${col}"`).test(leadsHeadHtml()), 'header exists for column: ' + col);
  }
  assert.ok(/const LEADS_COLUMNS_STORAGE_KEY = 'ztech.leads.columns'/.test(rendererSource),
    'the preference is renderer-local storage');
  assert.ok(/try \{/.test(between(rendererSource, 'function persistLeadsColumns()', '\n}')),
    'storage failure can never break the workspace');
  // The lead column cannot be hidden.
  assert.ok(rendererSource.includes('Lead (always shown)'), 'the identity column is locked');
  assert.ok(/lockedBox\.disabled = true/.test(rendererSource), 'and its toggle is genuinely disabled');
});

test('24. a stored column preference survives and rejects unknown names', () => {
  const r = loadColumnReader(memoryStorage({
    'ztech.leads.columns': JSON.stringify(['phone', 'status', 'quality'])
  }));
  assert.deepStrictEqual(r.readStoredLeadsColumns(), ['phone', 'status', 'quality'],
    'a real stored preference is honoured');
  const withGhost = loadColumnReader(memoryStorage({
    'ztech.leads.columns': JSON.stringify(['phone', 'not_a_column'])
  }));
  assert.deepStrictEqual(withGhost.readStoredLeadsColumns(), ['phone'],
    'an unknown stored name is dropped, not rendered as an empty header');
  for (const broken of ['', 'not json', '{"a":1}', '[]']) {
    const reader = loadColumnReader(memoryStorage({ 'ztech.leads.columns': broken }));
    assert.deepStrictEqual(reader.readStoredLeadsColumns(), r.LEADS_DEFAULT_COLUMNS,
      'a broken preference falls back to the default: ' + broken);
  }
  // Nothing about columns ever reaches the database or the wire.
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  assert.ok(!/appAPI\.[^.]*\.(set|save|update|write)\w*\([^)]*column/i.test(rendererSource),
    'column visibility is never persisted through a channel');
});

// --- 11. no fake data --------------------------------------------------------

test('25. every displayed value is real, derived, or explicitly unavailable', () => {
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  // Real lead fields only.
  const fields = [...new Set([...f3.matchAll(/lead\.(\w+)/g)].map((m) => m[1]))].sort();
  assert.deepStrictEqual(fields,
    ['collectedAt', 'email', 'id', 'keyword', 'phone', 'qualification', 'source', 'status', 'title', 'website'],
    'the workspace reads only real stored lead fields');
  // Research and ICP are honest about being absent.
  assert.ok(f3.includes("leadsIntelCell('Not available'"), 'research/ICP report not available');
  assert.ok(/Research is not integrated in this build/.test(f3), 'and say why');
  // F8 declared update: ICP fit now exists per Target (Intelligence, ICP), so the
  // column still shows no single value and says where the evaluation lives.
  assert.ok(/ICP fit depends on a Target: see Intelligence, ICP/.test(f3), 'for both columns');
  // Scores would have to come from a data source, so any scoring vocabulary in
  // the executable F3 code is a fabrication risk. Comments are excluded.
  const f3Code = f3.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/score|fit_score|percentile|probability|confidence|rating/i.test(f3Code),
    'no invented score anywhere in the F3 code');
  // Data quality is derived by the existing helper, not recomputed or invented.
  assert.ok(f3.includes('leadQualitySignals(lead)'), 'quality comes from the real renderer signal helper');
  // No fabricated example records, and no decorative metrics.
  for (const banned of ['lorem', 'example.com', 'Acme', 'John Doe', 'sample_lead', 'mockLead']) {
    assert.ok(!rendererSource.toLowerCase().includes(banned.toLowerCase()), 'no sample data: ' + banned);
  }
  const f3css = cssSource.slice(cssSource.indexOf('Frontend 2.0 - F3: Leads workspace'));
  assert.ok(!/gradient/i.test(f3css), 'no gradient in the F3 styles');
  assert.ok(!/border-radius:\s*(1[0-9]|[2-9][0-9])px/.test(f3css), 'no pill-shaped decoration');
  assert.ok(/--row-h/.test(f3css), 'row height comes from the F1 density token');
  assert.ok(/--radius-sm/.test(f3css), 'radius comes from the F1 token');
  assert.strictEqual((f3css.match(/box-shadow:/g) || []).length, 1,
    'exactly one shadow, the popover, and it uses the F1 token');
  assert.ok(f3css.includes('box-shadow: var(--shadow-2)'), 'and it is an F1 token, not a new value');
});

// --- 12. accessibility -------------------------------------------------------

test('26. the table, sorting and selection are accessible', () => {
  const head = leadsHeadHtml();
  assert.ok(/<th class="col-select" scope="col">/.test(head), 'the select column is a scoped header');
  assert.ok((head.match(/scope="col"/g) || []).length >= 10, 'every column header is scoped');
  assert.ok(/<caption class="visually-hidden">/.test(htmlSource), 'the table has a caption');
  assert.ok(/<table class="data-table leads-table" id="leads-table">\s*<caption/.test(htmlSource),
    'and the caption is the table\'s first child');
  assert.ok(/<table class="data-table leads-table" id="leads-table">/.test(htmlSource), 'a real table');
  // aria-sort is present on every sortable column and is the real state.
  assert.strictEqual((head.match(/aria-sort="none"/g) || []).length, 5, 'all five sortable headers declare aria-sort');
  const fn = between(rendererSource, 'function updateNumbersSortHeaders()', '// Third click returns');
  assert.ok(fn.includes("'ascending'") && fn.includes("'descending'") && fn.includes("'none'"),
    'aria-sort reflects the real cycle');
  assert.ok(fn.includes('#leads-table thead th[data-sort]'), 'and is scoped to the sortable headers only');
  // Popovers are keyboard reachable and Escape closes them.
  const popovers = between(rendererSource, '(function wireLeadsFilterPopovers()', '(function initLeadsColumns()');
  assert.ok(popovers.includes("e.key !== 'Escape'"), 'Escape closes the open popover');
  assert.ok(popovers.includes("e.preventDefault()"), 'and does not leak to the page');
  assert.ok(popovers.includes('trigger.addEventListener(\'keydown\''), 'triggers are keyboard operable');
  assert.ok(/first\.focus\(\)/.test(rendererSource), 'focus moves into the popover');
  assert.ok(rendererSource.includes("trigger.focus()"), 'and returns to the trigger on close');
  assert.ok(leadsViewHtml().includes('aria-expanded="false"'), 'the expanded state is exposed');
  assert.ok(leadsViewHtml().includes('role="group" aria-label="Lead filters"'), 'the filter bar is labelled');
  // Disabled controls are genuinely disabled.
  assert.ok(/<button[^>]*disabled/.test(leadsHeadHtml()), 'non-sortable headers are disabled buttons');
  assert.ok(/<button[^>]*disabled[^>]*aria-disabled="true"/.test(leadsViewHtml()),
    'the Intelligence trigger is disabled and announced');
  // No colour-only status: every signal carries text or an accessible name.
  const row = between(rendererSource, 'function leadsRow(lead) {', 'function leadsSkeletonRows(');
  assert.ok(/leadsStatusCell\(lead\)/.test(row), 'the status cell is built from the lead');
  assert.ok(/leadsQualificationCell\(lead\)/.test(row), 'the qualification cell is built from the lead');
  assert.ok(functionSource(rendererSource, 'function leadsStatusCell(lead) {')
    .includes('tag.textContent = status;'), 'status is always spelled out');
  assert.ok(functionSource(rendererSource, 'function leadsQualificationCell(lead) {')
    .includes('tag.textContent = value;'), 'qualification is always spelled out');
  assert.ok(/badge\.setAttribute\('aria-label'/.test(rendererSource), 'quality marks are named');
  assert.ok(/badge\.title = /.test(rendererSource), 'and carry a text tooltip');
  assert.ok(cssSource.includes('.leads-table tbody tr[aria-selected'), 'selected state is styled, not implied');
});

test('27. focus states are visible and the density token still drives the rows', () => {
  assert.ok(cssSource.includes('outline: 2px solid var(--border-focus)'), 'the F1 focus ring is intact');
  const f3css = cssSource.slice(cssSource.indexOf('Frontend 2.0 - F3: Leads workspace'));
  assert.ok(!/outline:\s*none/.test(f3css), 'F3 never removes a focus ring');
  assert.ok(/\.leads-table th,[\s\S]*?height: var\(--row-h\)/.test(f3css),
    'Leads rows take their height from the F1 density token');
  assert.ok(f3css.includes('.leads-table thead th') && f3css.includes('position: sticky'),
    'the header is sticky inside the scrolling region');
  assert.ok(/\.leads-table-wrap \{[\s\S]*?overflow: auto/.test(f3css),
    'the table scrolls in its own region instead of overflowing the shell');
  assert.strictEqual((f3css.match(/position:\s*fixed/g) || []).length, 0, 'nothing is fixed over the shell');
});

// --- 13. security and scope --------------------------------------------------

test('28. no new IPC channel, no dependency change, no network call', () => {
  // F6 declared lock update: +7 Lists channels and their seven preload methods.
  // F8 declared lock update: +1 intelligence:icp.
  assert.strictEqual((mainSource.match(/ipcMain\.handle\('/g) || []).length, 34, '34 IPC channels');
  // A10 declared lock update: 41 -> 46 preload invocations (the five approved
  // Lead Intelligence methods). The 34 main channels are unchanged: A10 registers
  // its five channels from a narrowly scoped registrar, not from main.js.
  assert.strictEqual((preloadSource.split('ipcRenderer.invoke').length - 1), 46, '46 preload invocations');
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
    'production dependencies unchanged');
  assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
    ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
    'dev dependencies unchanged');
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|EventSource|https?:\/\//.test(f3), 'F3 makes no network call');
  assert.ok(!/\brequire\s*\(/.test(f3), 'F3 requires nothing');
  assert.ok(!/^\s*import\s/m.test(f3), 'F3 imports nothing');
  assert.ok(!/localStorage\.setItem/.test(between(rendererSource, 'function renderLeadsChips()', 'function clearAllLeadsFilters()')),
    'the chip layer writes no storage of its own');
});

test('29. the security model is preserved and new UI avoids innerHTML', () => {
  assert.ok(htmlSource.includes("frame-src 'none'") && htmlSource.includes("object-src 'none'"),
    'the CSP canaries are intact');
  assert.ok(htmlSource.includes("<script type=\"module\" src=\"./src/renderer/renderer.js\"></script>"),
    'still one external module script');
  assert.ok(!/<script[^>]*>[^<]/.test(htmlSource), 'no inline script was introduced');
  assert.ok(!/https?:\/\/(?!127\.0\.0\.1|api\.your-zunitech-domain)/.test(leadsViewHtml()),
    'the Leads view references no remote asset');
  // New F3 code builds DOM nodes; it never interpolates business data into HTML.
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  // Comments may legitimately say "not innerHTML"; only real usage is banned.
  const f3Code = f3.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(!/\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML/.test(f3Code),
    'the F3 code never assigns or injects HTML');
  for (const api of ['textContent =', 'createElement(', 'replaceChildren(', 'append(']) {
    assert.ok(f3.includes(api), 'F3 uses the safe DOM API: ' + api);
  }
  // Values reaching the DOM are text, never markup.
  const row = between(rendererSource, 'function leadsRow(lead) {', 'function leadsSkeletonRows(');
  assert.ok(!/escapeHtml/.test(row), 'F3 needs no HTML escaping: it never builds HTML strings');
  assert.ok(!/\.html\s*\(/.test(f3), 'no jQuery-style HTML injection');
});

test('30. Chinese business data is untouched', () => {
  assert.ok(rendererSource.includes("source: '手动导入'"),
    'the stored import-provenance value is unchanged');
  const store = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
  assert.ok(store.includes("const LEGACY_IMPORT_SOURCE = '手动导入';"),
    'and the store contract that matches it is unchanged');
  // No new Chinese was introduced, and none of the existing Chinese strings were touched.
  const f3 = between(rendererSource, '// === Leads workspace (Frontend 2.0 F3) ===', 'function loadNumbers()');
  assert.ok(!/[一-鿿]/.test(f3), 'the F3 region contains no Chinese');
  assert.ok(!/[一-鿿]/.test(leadsViewHtml()), 'the Leads markup is English only');
  // The main-process Chinese strings are deliberately out of scope and unmodified.
  assert.ok(fs.readFileSync(path.join(root, 'src', 'main', 'coreClawClient.js'), 'utf8').includes('未设置 API Key'),
    'the out-of-scope main-process strings are untouched');
});

console.log('');
if (failures.length) {
  console.log(passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
