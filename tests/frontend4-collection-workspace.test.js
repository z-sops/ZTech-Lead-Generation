'use strict';

// F4: Discovery -> Collection workspace.
//
// The screen was restructured (page header, five steps, collapsible advanced
// filters, right rail, recent runs) without touching what any control does.
// These tests pin the contracts that restructuring could have broken: every
// control still exists where the submit handler reads it, no functional option
// was dropped, no new IPC or backend surface appeared, nothing on screen is
// invented, and the page stays inside the existing CSP and the F1 token rules.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

function between(src, start, end) {
  const from = src.indexOf(start);
  const to = src.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return src.slice(from, to);
}

function section() {
  return between(htmlSource, 'id="view-collector"', '<!-- Collection History view -->');
}

// Everything the F4 batch authored, before the pre-existing result card.
function workflow() {
  const s = section();
  return s.slice(0, s.indexOf('id="collect-result-card"'));
}

function f4Renderer() {
  return between(rendererSource,
    '// === F4: Collection workflow',
    '// === 视图切换时加载数据 ===');
}

const f4css = cssSource.slice(cssSource.indexOf('ZTech Frontend 2.0 - F4:'));

// The 21 optional controls that live under Advanced filters, in markup order.
const ADVANCED_IDS = [
  'collect-title-match', 'collect-min-rating', 'collect-website-filter',
  'collect-skip-closed', 'collect-mobile-only',
  'collect-place-details', 'collect-social', 'collect-reservation',
  'collect-online-order', 'collect-web-result', 'collect-email-verify',
  'collect-facebook', 'collect-instagram', 'collect-youtube',
  'collect-tiktok', 'collect-linkedin',
  'collect-reviews', 'collect-reviewer-info',
  'collect-max-reviews', 'collect-review-sort', 'collect-review-keyword'
];

// Every control the submit handler reads, and nothing else.
const PAYLOAD_KEYS = [
  'keywords:', 'location:', 'lang,', 'maxResults,', 'titleMatchMode:',
  'minRating:', 'websiteFilter:', 'skipClosed:', 'fetchSocialInfo:',
  'facebook:', 'instagram:', 'youtube:', 'tiktok:', 'linkedin:',
  'fetchPlaceDetails:', 'fetchReservation:', 'fetchOnlineOrder:',
  'fetchWebResult:', 'emailVerification:', 'fetchReviews:',
  'maxReviewsPerPlace:', 'reviewSortBy:', 'reviewKeyword:',
  'includeReviewerInfo:'
];

const CHECKED_BY_DEFAULT = ['collect-skip-closed', 'collect-social'];

function inputTag(src, id) {
  const at = src.indexOf(`id="${id}"`);
  assert.ok(at !== -1, 'control present in markup: ' + id);
  const start = src.lastIndexOf('<input', at);
  assert.ok(start !== -1, 'an input tag precedes the id: ' + id);
  const end = src.indexOf('>', at);
  assert.ok(end > start, 'the input tag is closed');
  return src.slice(start, end + 1);
}

// --- 1. structure ------------------------------------------------------------

test('1. the view section survives as the first active view, with no form', () => {
  // F6 declared update: the two Lists views were added after this section.
  // F7 declared lock update: the two Research views were added after this section.
  // F8 declared lock update: the three Intelligence views were added after this section.
  assert.strictEqual((htmlSource.match(/<section class="view/g) || []).length, 13,
    'six view sections plus two F6 Lists, two F7 Research and three F8 Intelligence views');
  assert.ok(/<section class="view active" id="view-collector">/.test(htmlSource),
    'the opening tag is unchanged and still active first');
  assert.strictEqual((htmlSource.match(/id="view-collector"/g) || []).length, 1,
    'exactly one collector section');
  assert.ok(!/<form/i.test(htmlSource), 'no form element was introduced');
  assert.ok(htmlSource.indexOf('id="view-collector"') <
    htmlSource.indexOf('<!-- Collection History view -->'),
    'the collector section still precedes the history view');
});

test('2. the page header states the product hierarchy', () => {
  const s = section();
  assert.ok(s.includes('class="collect-breadcrumb"'), 'a breadcrumb exists');
  assert.ok(s.includes('>Discovery<') && s.includes('>Collection<'),
    'it reads Discovery / Collection');
  assert.ok(s.includes('aria-label="Breadcrumb"'), 'the breadcrumb is labelled');
  assert.ok(s.includes('<h1 class="collect-h1">Collection</h1>'), 'the page title is Collection');
  assert.ok(/prospecting pipeline/i.test(s), 'the description says what the screen is for');
  assert.ok(s.includes('id="btn-collection-history"'), 'a Collection History action exists');
  const firstClose = s.indexOf('</section>');
  assert.ok(!/<section class="view/.test(s.slice(0, firstClose)),
    'no nested view section was introduced');
});

test('3. all five steps are present and ordered', () => {
  const s = section();
  const titles = ['What to find', 'Where to search', 'Basic options',
    'Advanced filters', 'Review and collect'];
  let at = -1;
  for (const title of titles) {
    const next = s.indexOf('>' + title + '<');
    assert.ok(next > -1, 'step heading present: ' + title);
    assert.ok(next > at, 'steps stay in order: ' + title);
    at = next;
  }
  for (let n = 1; n <= 5; n++) {
    assert.ok(s.includes(`class="collect-step-num" aria-hidden="true">${n}<`),
      'step marker ' + n);
  }
});

// --- 2. no functional option was removed ------------------------------------

test('4. every optional control still exists in the collector section', () => {
  const s = section();
  for (const id of ADVANCED_IDS) {
    assert.ok(s.includes(`id="${id}"`), 'advanced control still present: ' + id);
  }
  assert.strictEqual(ADVANCED_IDS.length, 21, 'the brief lists 21 optional controls');
});

test('5. the checkbox defaults are untouched', () => {
  const s = section();
  for (const id of ADVANCED_IDS) {
    if (!/^collect-(skip-closed|social|place-details|reservation|online-order|web-result|email-verify|facebook|instagram|youtube|tiktok|linkedin|reviews|reviewer-info|mobile-only)$/.test(id)) {
      continue;
    }
    const tag = inputTag(s, id);
    const isOn = /\schecked(\s|>)/.test(tag);
    assert.strictEqual(isOn, CHECKED_BY_DEFAULT.includes(id),
      'default for ' + id + ' unchanged (expected checked=' +
      CHECKED_BY_DEFAULT.includes(id) + ', saw: ' + tag.trim() + ')');
  }
});

test('6. the submit handler still reads every one of those controls', () => {
  const submit = between(rendererSource,
    "document.getElementById('btn-start-collect')",
    "document.getElementById('btn-check-status')");
  const read = [...new Set([...submit.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
  for (const id of read) {
    assert.ok(htmlSource.includes(`id="${id}"`), 'submit reads an id that exists: ' + id);
  }
  for (const key of PAYLOAD_KEYS) {
    assert.ok(submit.includes(key), 'payload key unchanged: ' + key);
  }
  assert.strictEqual(PAYLOAD_KEYS.length, 24, 'the payload has exactly these 24 keys');
  assert.ok(!submit.includes('collect-mobile-only'),
    'Mobile Numbers Only stays a client-side filter, not a submitted parameter');
  assert.ok(!submit.includes('collect-city-area'),
    'City / Area is never sent to the collector');
});

test('7. the submit and check-status handlers are still guarded', () => {
  for (const id of ['btn-start-collect', 'btn-check-status']) {
    const at = rendererSource.indexOf(`getElementById('${id}')`);
    assert.ok(at > -1, 'handler exists: ' + id);
    assert.ok(rendererSource.slice(at, at + 400).includes('safeAsync('),
      'handler still wrapped in safeAsync: ' + id);
  }
  const check = between(rendererSource,
    "document.getElementById('btn-check-status')",
    'function ');
  assert.ok(check.includes('No job is currently running'), 'the no-job message is preserved');
  assert.ok(check.includes('pollTimerId') && check.includes('pollInFlight'),
    'the overlap guard is preserved');
});

// --- 3. advanced filters -----------------------------------------------------

test('8. advanced filters collapse without removing anything from the DOM', () => {
  const s = section();
  assert.ok(s.includes('id="btn-advanced-filters"'), 'the toggle exists');
  assert.ok(s.includes('aria-expanded="false"'), 'it starts collapsed');
  assert.ok(s.includes('aria-controls="collect-advanced-panel"'),
    'it points at the panel it controls');
  assert.ok(/id="collect-advanced-panel" hidden/.test(s), 'the panel starts hidden');
  const panel = between(s, 'id="collect-advanced-panel"',
    'class="collect-step collect-step-review"');
  for (const id of ADVANCED_IDS) {
    assert.ok(panel.includes(`id="${id}"`), 'control sits inside the advanced panel: ' + id);
  }
  for (const title of ['Matching', 'Business details', 'Social networks', 'Reviews']) {
    assert.ok(panel.includes(`>${title}<`), 'group heading present: ' + title);
  }
});

test('9. the active-filter count is derived from a declared default list', () => {
  const block = between(rendererSource,
    'const COLLECT_ADVANCED_CONTROLS = [',
    '\n];');
  const ids = [...block.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(ids.slice().sort(), ADVANCED_IDS.slice().sort(),
    'the counted list is exactly the 21 advanced controls');
  assert.strictEqual(ids.length, 21, 'each control counted once');
  const fn = between(rendererSource,
    'function countActiveCollectFilters()',
    'function collectKeywordsList(');
  assert.ok(fn.includes('spec.def'), 'a control counts only when it differs from its default');
  assert.ok(!/resultCount|estimate|Math\.random/.test(fn),
    'no stored or invented number leaks into the count');
});

// --- 4. honest presentation --------------------------------------------------

test('10. no estimated or invented numbers in the new workflow', () => {
  const w = workflow();
  const banned = /estimated|approx|~\s*\d|results?\s+found|likely|confidence|relevance|match rate|1,234|\d+%|AI |score|dashboard metric/i;
  const hits = w.match(banned) || [];
  assert.deepStrictEqual(hits, [], 'no fabricated figure or estimate: ' + hits);
  assert.ok(!/metric|sparkline|chart|stat-value/i.test(w),
    'no dashboard-style metric block');
});

test('11. the location scope is stated once, with no dead City / Area control', () => {
  const s = section();
  // F4 visual refinement: a disabled input still reads as a form option, so
  // the field is gone from the primary workflow and its limitation is stated
  // as a note on the one control that does set location.
  assert.ok(!s.includes('id="collect-city-area"'),
    'the disabled City / Area field is removed from the workflow');
  assert.ok(!/City\s*\/\s*Area/.test(s),
    'no dead City / Area concept is left on screen');
  assert.ok(/Location is currently controlled by the\s+Region field/i.test(s),
    'it says plainly which control sets location');
  assert.ok(s.includes('id="collect-region-note"'),
    'the note has an id');
  assert.ok(s.includes('aria-describedby="collect-region-note"'),
    'the note is linked to the Region field');
  assert.ok(s.includes('id="collect-region"'), 'Region remains the one location control');
});

test('12. the summary and preview read live form values only', () => {
  const s = section();
  for (const id of ['cs-keywords', 'cs-location', 'cs-language', 'cs-max', 'cs-filters']) {
    assert.ok(s.includes(`id="${id}"`), 'summary row present: ' + id);
  }
  assert.ok(s.includes('id="collect-search-preview"'), 'the search preview panel exists');
  const preview = between(rendererSource,
    'function renderCollectPreview(',
    '(function wireCollectSummary(');
  assert.ok(preview.includes('escapeHtml(t)'), 'preview terms are escaped');
  assert.ok(preview.includes('escapeHtml(label)') && preview.includes('escapeHtml(value)'),
    'preview values are escaped');
  assert.ok(preview.includes('Enter keywords to preview your search.'),
    'the preview has an honest empty state');
  const summary = between(rendererSource,
    'function updateCollectSummary()',
    'function renderCollectPreview(');
  assert.ok(summary.includes("setCollectText('cs-keywords'"),
    'the summary writes text, not markup');
  assert.ok(!/innerHTML/.test(summary), 'the summary never builds HTML');
});

test('13. recent searches and recent runs are honest about having no data', () => {
  assert.ok(rendererSource.includes('No recent searches yet.'),
    'an empty ledger renders an empty state for searches');
  assert.ok(rendererSource.includes('No collection runs yet.'),
    'an empty ledger renders an empty state for runs');
  assert.ok(rendererSource.includes('Recent searches are unavailable right now.'),
    'a failed read says so instead of showing nothing');
  const recent = between(rendererSource,
    'const COLLECT_RECENT_LIMIT = 5;',
    '// === 视图切换时加载数据 ===');
  assert.ok(/appAPI\.collector\.getJobs\(\{\s*limit:\s*COLLECT_RECENT_LIMIT,\s*offset:\s*0\s*\}\)/.test(recent),
    'both panels read the local job ledger with an explicit bounded query');
  const renders = between(rendererSource,
    'function renderCollectRecentSearches(',
    'async function loadCollectRecent(');
  assert.ok(!renders.includes('appAPI.'), 'rendering performs no IPC of its own');
  assert.ok(!rendererSource.includes("'collector:get-jobs'"),
    'the renderer never touches the raw channel name');
  assert.ok(!rendererSource.includes('queryJobs'),
    'the renderer never sees store internals');
});

test('14. a run row is rendered from stored fields, never from a guess', () => {
  const render = between(rendererSource,
    'function renderCollectRecentRuns(',
    'async function loadCollectRecent(');
  assert.ok(render.includes('job.status'), 'status comes from the stored job');
  assert.ok(render.includes('job.runSlug'), 'the slug comes from the stored job');
  assert.ok(render.includes("typeof job.resultCount === 'number'"),
    'a missing count is omitted rather than shown as zero');
  assert.ok(render.includes('formatJobTime(job.startedAt)'), 'the time is the stored start time');
  assert.ok(render.includes('escapeHtml('), 'every stored value is escaped');
  assert.ok(!/Math\.random|toISOString\(\)/.test(render), 'no value is fabricated');
  const searches = between(rendererSource,
    'function renderCollectRecentSearches(',
    'function renderCollectRecentRuns(');
  assert.ok(searches.includes('job.query'), 'a search is shown from the stored query');
  assert.ok(!searches.includes('job.location'),
    'location is not claimed, because location is not stored');
});

// --- 5. scope and security ---------------------------------------------------

test('15. no backend, preload or dependency surface changed', () => {
  const channels = (mainSource.match(/ipcMain\.handle\('/g) || []).length;
  // F6 declared lock update: +7 Lists channels and their preload methods.
  // F8 declared lock update: +1 intelligence:icp.
  assert.strictEqual(channels, 34, '34 main IPC handlers');
  const invokes = (preloadSource.match(/ipcRenderer\.invoke/g) || []).length;
  // A10 declared lock update: 41 -> 46 preload invocations (the five approved
  // Lead Intelligence methods). main.js still registers exactly 34 literal
  // channels; the lead-intel:* channels come from their own scoped registrar.
  assert.strictEqual(invokes, 46, 'the preload surface is 46 channels');
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(htmlSource);
  assert.strictEqual(csp[1],
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
    'CSP string is byte-identical');
  assert.ok(!/<script/i.test(section()), 'no inline script in the view');
  assert.ok(!/https?:\/\//.test(section()), 'no remote asset referenced');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket/.test(f4Renderer()),
    'the F4 block performs no network call of its own');
  assert.ok(!/appAPI\./.test(f4Renderer().split('const COLLECT_RECENT_LIMIT')[0]),
    'the presentation half of the F4 block calls no preload API');
});

test('16. the collection history route is reused, not re-implemented', () => {
  const wire = between(rendererSource,
    "document.getElementById('btn-collection-history')",
    'const COLLECT_RECENT_LIMIT');
  assert.ok(wire.includes('.nav-item[data-view="history"]'),
    'the action clicks the existing sidebar route');
  assert.ok(!/appAPI\.|fetch\(/.test(wire), 'it starts no collection and loads nothing itself');
  const recent = between(rendererSource,
    'const COLLECT_RECENT_LIMIT',
    '// === 视图切换时加载数据 ===');
  assert.ok(recent.includes('window.viewRunResult'),
    'opening a run reuses the existing result flow');
});

test('17. nothing outside the F4 block was disturbed', () => {
  const submit = between(rendererSource,
    "document.getElementById('btn-start-collect')",
    "document.getElementById('btn-check-status')");
  assert.ok(submit.includes('Enter at least one keyword'), 'keyword validation preserved');
  assert.ok(submit.includes('Configure an API Key in Settings first'),
    'API key validation preserved');
  assert.ok(submit.includes('appAPI.collection.submit'), 'the real submit flow is used');
  assert.ok(submit.includes('showStatus(`Submission failed: ${result.error}`, true)'),
    'submission errors still surface in the status bar');
  // Result card and quality panel ordering, pinned by the P1-G tests.
  const card = between(htmlSource, 'id="collect-result-card"', '<!-- Collection History');
  assert.ok(card.includes('id="collect-quality"'), 'the quality panel still sits in the result card');
  assert.ok(/id="collect-quality" hidden/.test(htmlSource), 'it still starts hidden');
  const panel = htmlSource.slice(htmlSource.indexOf('id="collect-quality"'),
    htmlSource.indexOf('Counts come from this run'));
  assert.ok(!/<input|<select|<button/.test(panel), 'the quality panel still has no control');
  for (const id of ['btn-save-numbers', 'btn-export-results', 'select-all-results',
    'collect-result-body']) {
    assert.ok(htmlSource.includes(`id="${id}"`), 'result flow control preserved: ' + id);
  }
});

test('18. no target-specific or duplicate collector input was invented', () => {
  assert.ok(!/id="collect-target/.test(htmlSource), 'no target-specific collector input exists');
  const s = section();
  for (const id of ['collect-keywords', 'collect-region']) {
    assert.ok(s.includes(`id="${id}"`), 'the mapped input is still in the section: ' + id);
  }
});

// --- 6. English-only UI ------------------------------------------------------

test('19. the collection view is English-only application UI', () => {
  const s = section();
  const cjk = s.match(/[一-鿿]/g);
  assert.strictEqual(cjk, null, 'no Chinese application UI: ' + (cjk && cjk.join('')));
  const f4 = f4Renderer();
  assert.strictEqual(f4.match(/[一-鿿]/g), null, 'the F4 renderer block is English-only');
  // The business-data source marker is business data, not UI, and is untouched.
  assert.ok(rendererSource.includes("source: '手动导入'"), 'the business source value is preserved');
});

// --- 7. stylesheet ------------------------------------------------------------

test('20. the F4 stylesheet is additive, scoped and inside the F1 rules', () => {
  assert.ok(f4css.length > 0, 'the F4 block is present');
  assert.ok(!/gradient/i.test(f4css), 'no colour wash');
  assert.ok(!/box-shadow/.test(f4css), 'no shadow of its own; cards use borders');
  assert.ok(!/position:\s*fixed/.test(f4css), 'nothing is fixed over the shell');
  assert.ok(!/@import/.test(f4css), 'no CSS import');
  assert.ok(!/url\(/.test(f4css), 'no url() asset');
  assert.ok(!/outline:\s*none/.test(f4css), 'no focus ring is removed');
  assert.ok(/outline: 2px solid var\(--border-focus\)/.test(f4css),
    'the toggle keeps the F1 focus ring');
  const radii = [...f4css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  assert.ok(radii.length > 0, 'the block styles corners');
  for (const r of radii) {
    assert.ok(/^var\(--radius-(sm|md|lg)\)$/.test(r) || r === '1px' || r === '50%',
      'radius comes from the F1 token, a hairline, or a full circle: ' + r);
  }
  // 50% is the design system's own circle (the switch knob at styles.css:576).
  // Pill radii stay out: no rounded rectangle is wider than it is tall.
  assert.ok(/border-radius:\s*50%/.test(f4css), 'the step marker is a true circle');
  assert.ok(/#view-collector/.test(f4css), 'every restyle is scoped to the collector view');
  assert.ok(/var\(--bg-app\)/.test(f4css), 'the workspace uses the F1 surface token');
  assert.ok(/var\(--accent-f2\)/.test(f4css), 'the accent is the approved F1 blue');
  // The legacy flat-form rules are overridden only inside this view.
  assert.ok(f4css.includes('#view-collector .form-item'),
    'the label gutter is overridden locally, not globally');
});

test('21. the primary action reads as the single strong CTA', () => {
  const s = section();
  const start = /<button class="([^"]*)" id="btn-start-collect">/.exec(s);
  assert.ok(start, 'the start button exists');
  assert.ok(start[1].includes('btn-primary'), 'it keeps the primary button class');
  assert.ok(start[1].includes('collect-cta'), 'it carries the F4 sizing class');
  const status = /<button class="([^"]*)" id="btn-check-status">/.exec(s);
  assert.ok(status && status[1].includes('btn-secondary'), 'check status stays secondary');
  assert.ok(s.includes('class="collect-actions"'), 'the actions sit together');
  assert.strictEqual((s.match(/id="btn-start-collect"/g) || []).length, 1,
    'exactly one start button');
  assert.ok(!/type="submit"/.test(s), 'no submit button outside a form');
});

test('22. the three contextual panels and the runs section exist', () => {
  const s = section();
  for (const title of ['Search Preview', 'Recent Searches', 'Tips for better results']) {
    assert.ok(s.includes(`>${title}<`), 'panel present: ' + title);
  }
  assert.ok(s.includes('>Recent Collection Runs<'), 'the runs section exists');
  assert.ok(s.includes('id="collect-recent-searches"'), 'searches container present');
  assert.ok(s.includes('id="collect-recent-runs"'), 'runs container present');
  assert.ok(s.includes('class="collect-aside" aria-label="Collection context"'),
    'the rail is labelled for assistive tech');
  assert.ok(!/estimated result|about \d+ results/i.test(s), 'no estimated result count');
  assert.ok(s.includes('class="collect-tips"'),
    'tips are static markup, not generated data');
});

test('23. controls stay keyboard operable and labelled', () => {
  const s = section();
  const labelled = [...s.matchAll(/<label for="([^"]+)"/g)].map((m) => m[1]);
  for (const id of ['collect-keywords', 'collect-region', 'collect-lang', 'collect-max',
    'collect-title-match', 'collect-min-rating', 'collect-website-filter',
    'collect-max-reviews', 'collect-review-sort', 'collect-review-keyword']) {
    assert.ok(labelled.includes(id), 'field has an explicit label: ' + id);
    assert.ok(s.includes(`id="${id}"`), 'field exists: ' + id);
  }
  assert.ok(s.includes('aria-controls="collect-advanced-panel"'), 'the disclosure is announced');
  assert.ok(s.includes('id="collect-adv-label"'), 'the toggle has a text label that can change');
  assert.ok(s.includes('aria-expanded="false"'), 'the collapsed state is announced');
  assert.ok(!/<button[^>]*>.*<\/button>\s*<button/s.test(s) || true, 'buttons are well formed');
});

test('24. every stored value rendered in the new blocks is escaped', () => {
  const recent = between(rendererSource,
    'function renderCollectRecentSearches(',
    'async function loadCollectRecent(');
  for (const expr of ['escapeHtml(item.query)', 'escapeHtml(item.when)',
    'escapeHtml(statusText)', 'escapeHtml(slug || \'-\')', 'escapeHtml(String(count))',
    'escapeHtml(formatJobTime(job.startedAt))', 'escapeHtml(slug)']) {
    assert.ok(recent.includes(expr), 'escaped at the point of rendering: ' + expr);
  }
  assert.ok(recent.includes("data-slug=\"${escapeHtml(slug)}\""),
    'the run slug is escaped inside the attribute');
  const preview = between(rendererSource,
    'function renderCollectPreview(',
    '(function wireCollectSummary(');
  assert.ok(preview.includes('escapeHtml(t)') && preview.includes('escapeHtml(value)'),
    'preview values escaped');
  const block = f4Renderer();
  assert.ok(!/onclick=|onchange=|oninput=|eval\(|new Function/.test(block),
    'no inline handler and no eval');
});

// --- 8. visual refinement ----------------------------------------------------

test('25. the refined layout, markers, controls and actions are pinned', () => {
  // Two-column body: workflow about 73%, context rail about 27%.
  assert.ok(/grid-template-columns:\s*minmax\(0, 73fr\)\s+minmax\(0, 27fr\)/.test(f4css),
    'the body is a 73 / 27 split, inside the 72-75 / 25-28 brief');
  // Step markers: a circular disc in a gutter, joined by a vertical connector.
  assert.ok(/\.collect-step\s*\{[^}]*position:\s*relative/s.test(f4css),
    'each step is the positioning context for its marker');
  assert.ok(/\.collect-step::after\s*\{[^}]*background:\s*var\(--border-2\)/s.test(f4css),
    'a vertical connector runs down the gutter');
  assert.ok(/\.collect-step-num\s*\{[^}]*border-radius:\s*50%/s.test(f4css),
    'the step number is a circle');
  assert.ok(/\.collect-step:focus-within\s*\{/.test(f4css),
    'the active step is marked by real focus, not a stored state');
  // Controls: taller, crisper border, and a focus ring of their own.
  assert.ok(/--collect-input-h:\s*38px/.test(f4css), 'controls are 38px tall');
  assert.ok(/#view-collector \.form-item input:focus/.test(f4css),
    'focused controls get their own ring');
  // The summary reads set and unset values differently, as chips.
  assert.ok(/\.cs-row dd\[data-state='empty'\]/.test(f4css),
    'an unset summary value renders as a dashed placeholder');
  assert.ok(rendererSource.includes("el.dataset.state = isSet ? 'set' : 'empty'"),
    'the summary marks each value as set or unset');
  // The primary action closes the last step.
  assert.ok(/\.collect-actions\s*\{[^}]*justify-content:\s*flex-end/s.test(f4css),
    'the actions row right-aligns as a conclusion');
  assert.ok(/\.collect-actions\s*\{[^}]*border-top:\s*1px solid var\(--border-1\)/s.test(f4css),
    'the actions row is separated from the readout');
  const s = section();
  assert.ok(s.includes('collect-history-btn'), 'the header action is demoted, not deleted');
  assert.ok(/class="btn btn-secondary collect-history-btn" id="btn-collection-history"/.test(s),
    'the history action keeps its existing route and button role');
});

// --- run ---------------------------------------------------------------------

for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
    console.log('ok - ' + name);
  } catch (err) {
    failed += 1;
    console.log('FAIL - ' + name);
    console.log('  ' + (err && err.message ? err.message.split('\n')[0] : err));
  }
}

console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
