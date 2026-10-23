'use strict';

// Frontend 2.0 F2.1 — regression: opening a historical run must update BOTH
// the page title and the page context in the top bar.
//
// Before this fix, window.viewRunResult poked the DOM directly and set only
// #page-title, so the breadcrumb context kept whatever the previous view had
// (e.g. "Setup" while viewing a Collection run).
//
// These tests execute the REAL routing functions extracted from renderer.js
// against a minimal DOM double. No new dependency, no jsdom, no innerHTML.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');

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

// --- extraction helpers -----------------------------------------------------

function extractFunction(src, name) {
  const signature = 'function ' + name + '(';
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'function not found in renderer.js: ' + name);
  assert.strictEqual(src.indexOf(signature, start + 1), -1, 'defined more than once: ' + name);
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

function extractConstObject(src, name) {
  const signature = 'const ' + name + ' = {';
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'const object not found in renderer.js: ' + name);
  const end = src.indexOf('\n};', start);
  assert.ok(end > start, 'const object not terminated: ' + name);
  return src.slice(start, end + 3);
}

// The historical-run entry point. It is assigned to window.viewRunResult, so it
// is sliced by brace balance from its assignment rather than by a signature.
function historyRunRegion() {
  const start = source.indexOf('window.viewRunResult =');
  assert.ok(start >= 0, 'window.viewRunResult assignment not found');
  let depth = 0;
  let opened = false;
  let quote = null;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; opened = true; continue; }
    if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return source.slice(start, i + 2);
    }
  }
  throw new Error('unbalanced braces in the window.viewRunResult region');
}

// --- minimal DOM double -----------------------------------------------------

// A DOM node stand-in covering exactly what activateView() touches.
function el(viewId) {
  const node = {
    viewId,
    textContent: '',
    dataset: { view: viewId },
    classes: new Set(),
    attrs: {},
    setAttribute(k, v) { node.attrs[k] = v; },
    removeAttribute(k) { delete node.attrs[k]; }
  };
  node.classList = {
    toggle: (name, on) => { if (on) node.classes.add(name); else node.classes.delete(name); },
    add: (name) => node.classes.add(name),
    remove: (name) => node.classes.delete(name),
    contains: (name) => node.classes.has(name)
  };
  return node;
}

const VIEW_IDS = ['collector', 'history', 'numbers', 'targets', 'dashboard', 'settings'];

function makeDom() {
  const nodes = {};
  VIEW_IDS.forEach((id) => { nodes[id] = el(id); });
  const navItems = VIEW_IDS.map((id) => nodes[id]);
  const views = VIEW_IDS.map((id) => nodes[id]);
  const pageTitle = el('page-title');
  const pageContext = el('page-context');
  return {
    navItems,
    views,
    pageTitle,
    pageContext,
    document: {
      getElementById(id) {
        if (id.startsWith('view-')) return nodes[id.slice(5)] || null;
        if (id === 'page-title') return pageTitle;
        if (id === 'page-context') return pageContext;
        return null;
      }
    }
  };
}

// Build the real routing functions, bound to a fresh DOM double.
function loadRouter(dom) {
  const factory = new Function(
    'navItems', 'views', 'pageTitle', 'pageContext', 'document',
    extractConstObject(source, 'viewTitles') + '\n' +
    extractConstObject(source, 'viewContexts') + '\n' +
    extractFunction(source, 'isKnownView') + '\n' +
    extractFunction(source, 'activateView') + '\n' +
    'return { activateView: activateView, isKnownView: isKnownView,' +
    ' viewTitles: viewTitles, viewContexts: viewContexts };'
  );
  return factory(dom.navItems, dom.views, dom.pageTitle, dom.pageContext, dom.document);
}

// Simulate a prior navigation, e.g. the user was on Setup / Settings.
function seedView(dom, viewId) {
  const node = dom.navItems.find((n) => n.dataset.view === viewId);
  dom.views.forEach((v) => v.classes.delete('active'));
  dom.navItems.forEach((n) => n.classes.delete('active'));
  node.classes.add('active');
  node.setAttribute('aria-current', 'page');
  dom.views.find((v) => v.viewId === viewId).classes.add('active');
  const router = loadRouter(dom);
  dom.pageTitle.textContent = router.viewTitles[viewId];
  dom.pageContext.textContent = router.viewContexts[viewId];
  return router;
}

// --- 1. the routing architecture --------------------------------------------

test('1. there is still exactly one routing function, and no duplicate was added', () => {
  assert.strictEqual(source.split('function activateView(').length - 1, 1,
    'activateView must be defined exactly once');
  const region = historyRunRegion();
  assert.ok(!/function\s+\w*\s*\(/.test(region.replace(/safeAsync\s*\(/g, '')),
    'viewRunResult must not define another function');
});

test('2. viewRunResult routes through activateView, not through direct DOM pokes', () => {
  const region = historyRunRegion();
  assert.ok(/activateView\('collector'\)/.test(region),
    'the historical run must open the Collection view via activateView()');
  assert.ok(!/page-title/.test(region), 'viewRunResult must not write #page-title directly');
  assert.ok(!/page-context/.test(region), 'viewRunResult must not write #page-context directly');
  assert.ok(!/querySelectorAll\('\.nav-item'\)/.test(region), 'no manual nav active-class pokes');
  assert.ok(!/querySelectorAll\('\.view'\)/.test(region), 'no manual view active-class pokes');
  assert.ok(!/querySelector\('\[data-view=/.test(region), 'no manual route selection');
});

test('3. the history entry point still renders the run results and mobile filter', () => {
  const region = historyRunRegion();
  assert.ok(/fetchAllRunResults\(slug\)/.test(region), 'still fetches the run results');
  assert.ok(/window\.__collectResults = items;/.test(region), 'still publishes the results');
  assert.ok(/currentResultsRunSlug = slug;/.test(region), 'still records the run slug');
  assert.ok(/isMobileNumber\(item\.phone\)/.test(region), 'mobile-only filter preserved');
  assert.ok(/renderCollectResults\(/.test(region), 'results still rendered');
  assert.ok(/collect-mobile-only/.test(region), 'still reads the mobile-only checkbox');
});

// --- 2. the actual regression: title AND context both update ----------------

test('4. viewing a historical run updates the page title', () => {
  const dom = makeDom();
  seedView(dom, 'settings');
  assert.strictEqual(dom.pageTitle.textContent, 'Settings', 'precondition: seeded on Settings');
  loadRouter(dom).activateView('collector');
  assert.strictEqual(dom.pageTitle.textContent, 'Collection',
    'the top bar title must read Collection after opening a run');
});

test('5. viewing a historical run updates the page context (the F2.1 bug)', () => {
  const dom = makeDom();
  seedView(dom, 'settings');
  assert.strictEqual(dom.pageContext.textContent, 'Setup', 'precondition: stale context was Setup');
  loadRouter(dom).activateView('collector');
  assert.strictEqual(dom.pageContext.textContent, 'Discovery',
    'the breadcrumb context must not stay stale at Setup');
});

test('6. no stale context survives navigation from any view', () => {
  const expected = {
    dashboard: ['Home', 'Workspace'],
    numbers: ['All Leads', 'Leads'],
    collector: ['Collection', 'Discovery'],
    history: ['Collection History', 'Discovery'],
    targets: ['Targets', 'Setup'],
    settings: ['Settings', 'Setup']
  };
  for (const from of VIEW_IDS) {
    const dom = makeDom();
    seedView(dom, from);
    loadRouter(dom).activateView('collector');
    const want = expected.collector;
    assert.strictEqual(dom.pageTitle.textContent, want[0], 'title after leaving ' + from);
    assert.strictEqual(dom.pageContext.textContent, want[1], 'context after leaving ' + from);
  }
});

test('7. the collector view and nav state are still activated exactly as before', () => {
  const dom = makeDom();
  seedView(dom, 'settings');
  const router = loadRouter(dom);
  const ok = router.activateView('collector');
  assert.strictEqual(ok, true, 'activateView reports success');
  assert.strictEqual(dom.views.filter((v) => v.classes.has('active')).length, 1,
    'exactly one view is active');
  assert.ok(dom.views.find((v) => v.viewId === 'collector').classes.has('active'),
    'the Collection view is the active one');
  const activeNav = dom.navItems.filter((n) => n.classes.has('active'));
  assert.strictEqual(activeNav.length, 1, 'exactly one nav item is active');
  assert.strictEqual(activeNav[0].dataset.view, 'collector', 'the Collection nav item is active');
  assert.strictEqual(activeNav[0].attrs['aria-current'], 'page', 'aria-current is maintained');
  assert.ok(dom.navItems.filter((n) => n.dataset.view !== 'collector')
    .every((n) => n.attrs['aria-current'] === undefined), 'no stale aria-current on other items');
});

test('8. historical-run behaviour is preserved when the fetch fails', () => {
  // The routing happens only inside the success branch, so a failed lookup must
  // not switch views or touch the breadcrumb.
  const region = historyRunRegion();
  const successAt = region.indexOf('if (result.success)');
  const activateAt = region.indexOf("activateView('collector')");
  assert.ok(successAt > -1 && activateAt > successAt, 'routing stays inside the success branch');
  assert.ok(/toast\(result\.error \|\| 'Could not load results', 'error'\);/.test(region),
    'the failure toast is unchanged');
});

// --- 3. language rule -------------------------------------------------------

test('9. the top bar breadcrumb is written from exactly one place', () => {
  // This is what makes tests 4/5 and test 2 compose into a real guarantee: if
  // activateView() is the only writer of #page-context and the only writer of
  // #page-title, then a navigation through it can never leave either stale.
  const contextWrites = source.match(/pageContext\.textContent\s*=/g) || [];
  assert.strictEqual(contextWrites.length, 1,
    '#page-context must be written in exactly one place (inside activateView)');
  const titleWrites = source.match(/page-title'\)\.textContent\s*=/g) || [];
  assert.strictEqual(titleWrites.length, 0,
    'no code may write #page-title directly; activateView owns it');
  const fn = extractFunction(source, 'activateView');
  assert.ok(/pageContext\.textContent\s*=/.test(fn), 'activateView writes the context');
  assert.ok(/pageTitle\.textContent\s*=/.test(fn), 'activateView writes the title');
});

test('10. no Chinese text is introduced in the renderer UI strings', () => {
  const region = historyRunRegion();
  const cjk = /[\u4E00-\u9FFF\u3000-\u303F]/;
  const stringLiterals = region.match(/'[^']*'|"[^"]*"/g) || [];
  stringLiterals.forEach((lit) => {
    if (cjk.test(lit)) {
      // Only the stored import-source business value is allowed to be Chinese.
      assert.ok(lit.includes('手动导入'),
        'unexpected Chinese string literal in viewRunResult: ' + lit);
    }
  });
  assert.ok(source.includes("source: '手动导入'"),
    'the stored business-data source value is still present and unmodified');
});

console.log('');
if (failures.length) {
  console.log(passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
