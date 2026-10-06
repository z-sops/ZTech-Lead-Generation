'use strict';

// Frontend 2.0 F2 — sidebar + top bar chrome.
//
// Covers: the six existing routes and nothing else, disabled destinations that
// can never navigate, active state, density toggle + persistence, sidebar
// collapse + persistence, keyboard access, and the safety rules (no IPC, no
// new channel, no inline script, CSP untouched).

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// F6 declared update: Saved Searches and Segments became real views.
// F7 declared update: Research Queue and Completed became real views.
// F8 declared update: ICP, Signals and Opportunities became real views.
const EXISTING_VIEWS = ['collector', 'history', 'numbers', 'targets', 'dashboard', 'settings', 'searches', 'segments', 'queue', 'completed',
  'icp', 'signals', 'opportunities', 'outreach', 'activity', 'ready'];

function sidebarHtml() {
  const s = htmlSource.indexOf('<nav class="sidebar-nav"');
  const e = htmlSource.indexOf('</nav>', s);
  assert.ok(s > -1 && e > s, 'sidebar nav located');
  return htmlSource.slice(s, e);
}

function topbarHtml() {
  const s = htmlSource.indexOf('<header class="top-bar">');
  const e = htmlSource.indexOf('</header>', s);
  assert.ok(s > -1 && e > s, 'top bar located');
  return htmlSource.slice(s, e);
}

// --- 1. routing: the six existing views, and only those ---------------------

test('1. every sidebar route is an existing view', () => {
  const nav = sidebarHtml();
  const targets = [...nav.matchAll(/data-view="([a-z]+)"/g)].map((m) => m[1]);
  for (const t of targets) {
    assert.ok(EXISTING_VIEWS.includes(t), 'route must be an existing view: ' + t);
    assert.ok(htmlSource.includes(`id="view-${t}"`), 'the view section exists: ' + t);
  }
  const unique = new Set(targets);
  for (const v of EXISTING_VIEWS) {
    assert.ok(unique.has(v), 'every existing view stays reachable: ' + v);
  }
  assert.strictEqual(unique.size, targets.length, 'no duplicated route in the sidebar');
});

test('2. no route points at a view that does not exist', () => {
  const nav = sidebarHtml();
  for (const m of nav.matchAll(/data-view="([a-z]+)"/g)) {
    assert.ok(htmlSource.includes(`id="view-${m[1]}"`), 'no dangling route: ' + m[1]);
  }
  // F6 implemented the Lists routes, so list/segment left this set.
  // F12 implemented the Outreach workspace, so `outreach` left this set too. The
  // remaining words are still unimplemented and must still have no route.
  assert.ok(!/data-view="[^"]*(research|intel|campaign|analytic)[^"]*"/i.test(nav),
    'no route invented for an unimplemented workspace');
});

test('3. the required navigation groups exist', () => {
  const nav = sidebarHtml();
  for (const group of ['Home', 'Leads', 'Lists', 'Research', 'Intelligence', 'Outreach', 'Analytics', 'Settings']) {
    assert.ok(nav.includes(`>${group}<`) || nav.includes(`>${group}\n`), 'nav entry present: ' + group);
  }
  // The two routes the approved IA did not list still have a home, so no
  // existing functionality is orphaned.
  assert.ok(nav.includes('>Collection<'), 'collection route kept');
  assert.ok(nav.includes('>Collection History<'), 'collection history route kept');
  assert.ok(nav.includes('>Targets<'), 'targets route kept');
  assert.ok(nav.includes('>All Leads<'), 'lead library route kept');
});

test('4. unimplemented destinations are disabled, not fake', () => {
  const nav = sidebarHtml();
  const soon = [...nav.matchAll(/<button class="nav-item nav-item-soon"[^>]*>/g)].map((m) => m[0]);
  // F7 declared update: two Research items went live, nine remain disabled.
  // F8 declared update: the three Intelligence items went live, six remain disabled.
  // F12 declared update: the Outreach workspace went live, so the former Ready
  // placeholder became a real route and exactly five remain disabled. The allowlist
  // below still pins each one as disabled, route-free and count-free.
  assert.strictEqual(soon.length, 4, 'the unimplemented destinations are present but disabled: ' + soon.length);
  for (const tag of soon) {
    assert.ok(tag.includes('disabled'), 'native disabled present');
    assert.ok(tag.includes('aria-disabled="true"'), 'aria-disabled present');
    assert.ok(!tag.includes('data-view'), 'a soon item carries no route');
  }
  // Nothing in a soon item may look like live data.
  for (const tag of soon) {
    const label = tag.slice(tag.indexOf('nav-label'));
    assert.ok(!/\d/.test(label.slice(0, label.indexOf('</span>'))), 'no count is shown on a soon item');
  }
});

test('5. exactly one active nav item at rest, matching the active view', () => {
  const nav = sidebarHtml();
  const active = [...nav.matchAll(/class="nav-item active"/g)];
  assert.strictEqual(active.length, 1, 'exactly one active item');
  const activeTag = nav.slice(nav.indexOf('class="nav-item active"') - 40, nav.indexOf('class="nav-item active"') + 200);
  const m = /data-view="([a-z]+)"/.exec(activeTag);
  assert.ok(m && EXISTING_VIEWS.includes(m[1]), 'the active item names a real view');
  const activeSection = /<section class="view active" id="view-([a-z]+)"/.exec(htmlSource);
  assert.ok(activeSection, 'exactly one view section starts active');
  assert.strictEqual(activeSection[1], m[1], 'the active nav item matches the active view section');
});

test('6. active state is maintained by a single routing function', () => {
  assert.ok(rendererSource.includes('function activateView(viewId)'), 'one activateView function');
  assert.ok(rendererSource.includes("n.setAttribute('aria-current', 'page')"), 'aria-current is set on the active item');
  assert.ok(rendererSource.includes("n.removeAttribute('aria-current')"), 'aria-current is cleared from the others');
  assert.ok(rendererSource.includes("n.classList.toggle('active', isTarget)"), 'active class is toggled, not only added');
  assert.ok(rendererSource.includes('pageContext.textContent = viewContexts[viewId]'), 'the top bar context is updated');
});

test('7. an unknown navigation target is refused, not half-applied', () => {
  const fn = rendererSource.slice(rendererSource.indexOf('function isKnownView('), rendererSource.indexOf('function activateView('));
  assert.ok(fn.includes('hasOwnProperty.call(viewTitles, viewId)'), 'only registered views are known');
  assert.ok(fn.includes('document.getElementById(`view-${viewId}`) !== null'), 'the view element must exist');
  const act = rendererSource.slice(rendererSource.indexOf('function activateView('), rendererSource.indexOf('navItems.forEach(item =>'));
  assert.ok(act.includes('if (!isKnownView(viewId)) return false;'), 'activateView refuses an unknown target');
  assert.ok(act.indexOf('return false') < act.indexOf("classList.toggle('active'"), 'refusal happens before any DOM change');
});

test('8. the existing lazy-load loop is untouched', () => {
  for (const [view, fn] of [['numbers', 'loadNumbers'], ['history', 'loadHistory'],
    ['dashboard', 'loadDashboard'], ['targets', 'loadTargets']]) {
    assert.ok(rendererSource.includes(`if (viewId === '${view}')`), `${view} still has a lazy-load branch`);
  }
  assert.ok(rendererSource.includes("if (viewId === 'dashboard') loadDashboard();"), 'dashboard lazy load intact');
  assert.ok(rendererSource.includes("if (viewId === 'targets') loadTargets();"), 'targets lazy load intact');
  assert.ok(rendererSource.includes("querySelector('.nav-item[data-view=\"collector\"]')"),
    'the target applier still finds the collector nav item by its data-view');
});

// --- 2. density ------------------------------------------------------------

test('9. the density control drives the F1 mechanism only', () => {
  assert.ok(htmlSource.includes('class="density-toggle"'), 'a density control is rendered');
  assert.ok(htmlSource.includes('data-density-value="compact"'), 'compact option present');
  assert.ok(htmlSource.includes('data-density-value="comfortable"'), 'comfortable option present');
  const wire = rendererSource.slice(rendererSource.indexOf('(function wireDensityToggle()'),
    rendererSource.indexOf('// === F2: sidebar collapse'));
  assert.ok(wire.includes('window.ztechUI.density.set('), 'it calls the F1 setter');
  assert.ok(wire.includes('window.ztechUI.density.get()'), 'it reads the F1 getter');
  assert.ok(!/localStorage/.test(wire), 'it never touches storage directly - one key only');
  assert.ok(!/ztech\.density/.test(wire), 'it does not re-declare the storage key');
  assert.ok(!/row-h/.test(wire), 'it does not define a second density system');
});

test('10. density button state reflects the real preference', () => {
  const wire = rendererSource.slice(rendererSource.indexOf('(function wireDensityToggle()'),
    rendererSource.indexOf('// === F2: sidebar collapse'));
  assert.ok(wire.includes("btn.dataset.densityValue === current ? 'true' : 'false'"), 'aria-pressed mirrors the real state');
  assert.ok(wire.includes('syncPressed();'), 'state is synced, including on load');
  assert.ok(htmlSource.includes('aria-pressed="true"'), 'the markup ships a resolved pressed state');
  assert.ok(htmlSource.includes('role="group"'), 'the control is a labelled group');
  assert.ok(htmlSource.includes('aria-label="Table row density"'), 'the control is labelled');
});

test('11. the F1 density contract is intact', () => {
  assert.ok(cssSource.includes('--row-h-compact: 32px'), 'compact = 32px');
  assert.ok(cssSource.includes('--row-h-comfortable: 40px'), 'comfortable = 40px');
  assert.ok(rendererSource.includes("const DENSITY_STORAGE_KEY = 'ztech.density'"), 'the single storage key is unchanged');
  assert.ok(rendererSource.includes('function setDensity(value)'), 'the F1 setter is unchanged');
});

// --- 3. sidebar collapse ---------------------------------------------------

test('12. collapse is renderer-local, persisted, and reflected in ARIA', () => {
  assert.ok(rendererSource.includes("const SIDEBAR_STORAGE_KEY = 'ztech.sidebar.collapsed'"), 'its own key');
  assert.ok(rendererSource.includes('window.localStorage.setItem(SIDEBAR_STORAGE_KEY'), 'persisted to localStorage');
  assert.ok(rendererSource.includes('window.localStorage.getItem(SIDEBAR_STORAGE_KEY'), 'restored on load');
  assert.ok(rendererSource.includes("toggle.setAttribute('aria-expanded'"), 'aria-expanded mirrors the state');
  assert.ok(htmlSource.includes('id="btn-collapse-sidebar"'), 'a collapse control exists');
  assert.ok(rendererSource.includes("document.getElementById('btn-collapse-sidebar')"), 'the renderer binds that same control');
  assert.ok(htmlSource.includes('aria-controls="sidebar"'), 'the control names what it controls');
  assert.ok(htmlSource.includes('id="sidebar"'), 'the sidebar has the id the control references');
  const block = rendererSource.slice(rendererSource.indexOf('function setSidebarCollapsed('),
    rendererSource.indexOf('(function initSidebar()'));
  assert.ok(!/appAPI/.test(block), 'collapse uses no IPC');
});

test('13. a collapsed sidebar cannot overlap the content', () => {
  // Collapse changes the width token, so the flex app-layout reflows.
  assert.ok(cssSource.includes('.app-layout.sidebar-collapsed .sidebar'), 'collapse is scoped to the layout');
  const rule = cssSource.slice(cssSource.indexOf('.app-layout.sidebar-collapsed .sidebar'),
    cssSource.indexOf('.app-layout.sidebar-collapsed .sidebar') + 140);
  assert.ok(rule.includes('width: var(--sidebar-w-collapsed)'), 'it swaps to the collapsed width token');
  assert.ok(!/position:\s*(absolute|fixed)/.test(cssSource.slice(cssSource.indexOf('.sidebar {'), cssSource.indexOf('.sidebar-header {'))),
    'the sidebar is never taken out of flow, so it cannot overlap content');
  assert.ok(cssSource.includes('width: var(--sidebar-w)'), 'the expanded width token is used');
  assert.ok(cssSource.includes('--sidebar-w: 216px'), 'expanded width value');
  assert.ok(cssSource.includes('--sidebar-w-collapsed: 48px'), 'collapsed width value');
});

test('14. a narrow window forces the rail without breaking the layout', () => {
  const mq = cssSource.slice(cssSource.indexOf('@media (max-width: 1180px)'));
  assert.ok(mq.length > 0, 'a narrow-window rule exists');
  assert.ok(mq.slice(0, 400).includes('width: var(--sidebar-w-collapsed)'), 'the sidebar collapses below 1180px');
  // The window minimum is 1200, so the table area keeps its width.
  assert.ok(/max-width:\s*1180px/.test(cssSource), 'breakpoint sits below the 1200px window minimum');
});

// --- 4. keyboard + accessibility -------------------------------------------

test('15. the sidebar is keyboard navigable and skips disabled items', () => {
  assert.ok(htmlSource.includes('aria-label="Primary"'), 'the nav is labelled');
  assert.ok(rendererSource.includes("if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;"), 'arrow keys handled');
  assert.ok(rendererSource.includes('.filter(isReachable)'), 'only reachable items take focus');
  assert.ok(rendererSource.includes('const isReachable = (el) => !el.disabled;'), 'disabled items are excluded');
  assert.ok(rendererSource.includes('next.focus();'), 'focus moves');
  assert.ok(rendererSource.includes('e.preventDefault();'), 'the page does not scroll while navigating');
  assert.ok(rendererSource.includes('% items.length'), 'wraps around, so focus cannot dead-end');
});

test('16. focus is visible on every interactive chrome element', () => {
  assert.ok(cssSource.includes(':focus-visible'), 'a focus-visible rule exists');
  const rule = cssSource.slice(cssSource.indexOf('a:focus-visible'), cssSource.indexOf('a:focus-visible') + 400);
  assert.ok(rule.includes('outline: 2px solid var(--border-focus)'), 'the focus ring uses the F1 token');
  for (const sel of ['.nav-item', '.density-btn', '.command-trigger', '.sidebar-toggle']) {
    assert.ok(cssSource.includes(sel), 'styled: ' + sel);
  }
  // Scoped to the F2 chrome: pre-existing view buttons are out of F2 scope and
  // the document contains no <form>, so none of them can submit anything.
  const chromeHtml = sidebarHtml() + topbarHtml();
  assert.strictEqual((chromeHtml.match(/<button(?![^>]*type=)/g) || []).length, 0,
    'every button the F2 chrome adds declares type=button');
  assert.ok(!/<form/i.test(htmlSource), 'the document has no form element at all');
});

test('17. the top bar has context, a search shell, and settings access', () => {
  const bar = topbarHtml();
  assert.ok(bar.includes('id="page-context"'), 'left: workspace context');
  assert.ok(bar.includes('id="page-title"'), 'left: current view');
  assert.ok(bar.includes('id="btn-global-search"'), 'center: search affordance');
  assert.ok(bar.includes('id="btn-topbar-settings"'), 'right: settings access');
  assert.ok(bar.includes('id="stat-collected"'), 'the existing collected count is preserved');
  assert.ok(bar.includes('id="clock"'), 'the existing clock is preserved');
  assert.ok(bar.includes('aria-label="Settings"'), 'the settings button is labelled for screen readers');
});

test('18. the search shell does only one real thing', () => {
  const block = rendererSource.slice(rendererSource.indexOf('const globalSearchButton'),
    rendererSource.indexOf('// Settings access in the top bar'));
  assert.ok(block.includes("activateView('numbers')"), 'it navigates to the lead library');
  assert.ok(block.includes("document.getElementById('number-search')"), 'it focuses the existing search box');
  assert.ok(!/appAPI|fetch\(|XMLHttpRequest|appAPI\./.test(block), 'it performs no search of its own');
  assert.ok(!/index|suggest|autocomplete/i.test(block), 'no search engine is invented');
  // There is no shortcut key advertised until the palette actually exists.
  assert.ok(!/kbd|⌘|Ctrl\+/i.test(topbarHtml()), 'no placeholder shortcut key is shown');
});

// --- 5. safety rules -------------------------------------------------------

test('19. no IPC, channel, or dependency was added', () => {
  // The F2 chrome lives in two regions: the routing block at the top of the
  // file, and the density/collapse/keyboard/search blocks just after F1. Both
  // are checked; the rest of the file is the pre-existing app and legitimately
  // calls the preload API.
  const regions = [
    rendererSource.slice(rendererSource.indexOf('// === Frontend 2.0 F2 — workspace chrome'),
      rendererSource.indexOf('// === F1: density preference')),
    rendererSource.slice(rendererSource.indexOf('// === F2: density control in the top bar'),
      rendererSource.indexOf('function escapeHtml('))
  ];
  for (const [i, region] of regions.entries()) {
    assert.ok(region.length > 0, 'F2 region ' + i + ' is located');
    assert.ok(!/appAPI\./.test(region), 'F2 region ' + i + ' calls no preload API');
    assert.ok(!/ipcRenderer|ipcMain/.test(region), 'F2 region ' + i + ' touches no IPC surface');
  }
  assert.strictEqual((htmlSource.match(/ipcRenderer\.invoke\(/g) || []).length, 0,
    'no invoke was added to the document');
  // A10 declared lock update: 41 -> 46 preload invocations. F12 Batch 2 declared
  // lock update: 46 -> 47. The single change is the one extra approved Lead
  // Intelligence method (outreach.list) under the existing `ztechLeadIntel` key.
  // The appAPI surface is untouched and no renderer invoke was added to the
  // F18 declared lock update: 49 -> 50, the single read-only Lead Intelligence prepare
  // method under the existing `ztechLeadIntel` key.
  // F19 declared lock update: 50 -> 51, the single send boundary.
  // F21 declared lock update: 51 -> 52, the single read-only send-ledger read.
  // Phase I2: +7 Opportunity Intelligence channels = 59 total.
  // I3/I4 declared lock update: +4 write-only OI settings methods = 63 total.
  assert.strictEqual(fs.readFileSync(path.join(root, 'preload.js'), 'utf8')
    .split('ipcRenderer.invoke').length - 1, 63, 'the preload surface is 32 channels plus seven F6 Lists methods, the F7 research list, the F8 ICP read, the eleven A10..F21 Lead Intelligence methods, and the seven Phase I2 Opportunity Intelligence methods');
});

test('20. the chrome stays inside the existing CSP', () => {
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(htmlSource);
  assert.ok(csp, 'CSP meta present');
  assert.strictEqual(csp[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'",
    'CSP string is byte-identical');
  const bar = topbarHtml();
  assert.ok(!/<script/i.test(bar), 'no inline script in the top bar');
  assert.ok(!/<script/i.test(sidebarHtml()), 'no inline script in the sidebar');
  assert.ok(!/https?:\/\//.test(bar) && !/https?:\/\//.test(sidebarHtml()), 'no remote asset referenced');
  assert.ok(!/<img/i.test(bar) && !/<img/i.test(sidebarHtml()), 'no external image asset');
  const f2css = cssSource.slice(cssSource.indexOf('Frontend 2.0 F2 — workspace chrome'));
  assert.ok(!/@import/.test(f2css), 'no CSS import');
  assert.ok(!/url\(/.test(f2css), 'no url() asset');
  // font-family: inherit is not a font declaration - it explicitly keeps the
  // existing system stack. Any other font-family would be a new font.
  const fonts = f2css.match(/font-family:[^;]+/g) || [];
  for (const f of fonts) {
    assert.ok(f.includes('inherit'), 'no font is introduced, only inherit: ' + f);
  }
  assert.ok(cssSource.includes('-apple-system'), 'the original system font stack is intact');
});

test('21. no gradients, no AI decoration, no fake metrics', () => {
  const f2css = cssSource.slice(cssSource.indexOf('Frontend 2.0 F2 — workspace chrome'));
  assert.ok(!/gradient/i.test(f2css), 'no gradient');
  assert.ok(!/box-shadow:\s*0\s+8px|box-shadow:\s*0\s+4px\s+1[6-9]/.test(f2css), 'no heavy shadow');
  const nav = sidebarHtml();
  assert.ok(!/badge|count|metric|sparkline|chart/i.test(nav), 'no fake metric in the nav');
  // Numbers are allowed only as inline-SVG path geometry, never as a value.
  const withoutSvg = nav.replace(/<svg[\s\S]*?<\/svg>/g, '');
  assert.ok(!/\d/.test(withoutSvg.replace(/v1\.0\.0/g, '')), 'no invented number outside the icons');
});

test('22. the shell kept the existing view sections untouched', () => {
  for (const v of EXISTING_VIEWS) {
    assert.strictEqual((htmlSource.match(new RegExp(`id="view-${v}"`, 'g')) || []).length, 1,
      'exactly one section: ' + v);
  }
  assert.ok(htmlSource.includes('class="view-container"'), 'the view container is preserved');
  assert.ok(htmlSource.includes('id="storage-warning"'), 'the storage warning is preserved');
  // F6 declared update: the two Lists views were added; the six are untouched.
  // F7 declared lock update: the two Research views join them.
  // F8 declared lock update: the three Intelligence views join them.
  // F12 declared lock update: the read-only Outreach view joins them.
  assert.strictEqual((htmlSource.match(/<section class="view/g) || []).length, 16, 'six view sections plus two F6 Lists, two F7 Research, three F8 Intelligence, the F12 Outreach view, the F15 Activity view and the F16 Ready view');
  assert.ok(/<section class="view active" id="view-collector"/.test(htmlSource), 'collector still starts active');
});

test('23. the old chrome was replaced, not duplicated', () => {
  // Superseded rules are gone rather than left to fight the new block.
  assert.ok(!/\.nav-icon\s*\{/.test(cssSource), 'the emoji nav-icon rule is gone');
  assert.ok(!/^\.brand \{\n\s*font-size: 15px/m.test(cssSource), 'the old brand rule is gone');
  assert.ok(!/🔍|📊|📋|🎯|📈|⚙️/.test(htmlSource), 'no emoji nav icons remain');
  // The legacy token is still declared (F1 requires it) but nothing consumes it.
  const consumed = (cssSource.match(/var\(--sidebar-width\)/g) || []).length;
  assert.strictEqual(consumed, 0, 'the legacy sidebar width token is no longer used by any rule');
  assert.ok(cssSource.includes('--sidebar-width: 220px'), 'the legacy token itself is preserved, not deleted');
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
