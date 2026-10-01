'use strict';

// Frontend 2.0 F5 — Lead Detail Drawer.
//
// The drawer is a presentation layer over the EXISTING B3 lead detail: the same
// #lead-detail-overlay, the same single-lead read, the same detailLoadSeq race
// guard, the same B6 / P1-C save paths and the same round-1 research IPC. These
// tests pin that claim, and pin that every value the drawer shows comes from the
// stored lead row or the existing research view - never from an invented
// research result, ICP score, evidence item or pitch.
//
// Where behaviour can be executed, it is executed: the real F5 block is lifted
// from renderer.js and run against a minimal DOM double. No jsdom, no new
// dependency.

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

// Slices a whole top-level function, closing brace included.
function functionSource(source, marker) {
  const from = source.indexOf(marker);
  assert.ok(from !== -1, 'function found: ' + marker);
  const close = source.indexOf('\n}', from);
  return source.slice(from, close + 2);
}

const F5_START = '// === F5 Lead Detail Drawer ===';
const f5 = between(rendererSource, F5_START, 'function splitImportLines(');
const f5Code = f5.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const overlayHtml = between(htmlSource, 'id="lead-detail-overlay"', '<!-- P1-F Target Builder');
const f5css = between(cssSource, 'ZTech Frontend 2.0 - F5: Lead Detail Drawer.', 'ZTech Frontend 2.0 - F3: Leads workspace.');
const openFn = between(rendererSource, 'async function openLeadDetail', '// --- Zuni-SEO website research (A7)');
const closeFn = between(rendererSource, 'function closeLeadDetail', "getElementById('numbers-table-body')");
// F11 declared lock update: the two slices test 17 checks. The F11 block is the
// last block in renderer.js, after every other test's slice boundary, so the F5
// I/O boundary above stays meaningful and no other block's slice captures it.
const renderLeadDrawerPitch = functionSource(rendererSource, 'function renderLeadDrawerPitch(lead)');
const renderLeadDrawerSource = functionSource(rendererSource, 'function renderLeadDrawer(');
const F11_MARKER = '// === F11 Outreach: Lead Drawer Pitch tab ===';
const f11Source = rendererSource.slice(rendererSource.indexOf(F11_MARKER));

// --- minimal DOM double ------------------------------------------------------

class FakeEl {
  constructor(doc, tag, id) {
    this.ownerDocument = doc;
    this.tagName = String(tag).toUpperCase();
    this.id = id || '';
    this.children = [];
    this.parentNode = null;
    this.attributes = {};
    this.dataset = {};
    this.hidden = false;
    this.disabled = false;
    this.tabIndex = 0;
    this.className = '';
    this.listeners = {};
    this._text = '';
    this._html = '';
    this.scrollTop = 0;
    const self = this;
    this.classList = {
      add(c) { const s = new Set(self.className.split(/\s+/).filter(Boolean)); s.add(c); self.className = [...s].join(' '); },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' '); },
      contains(c) { return self.className.split(/\s+/).includes(c); }
    };
  }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { this._html = String(v); this.children = []; this._text = ''; }
  get innerHTML() { return this._html; }
  get childElementCount() { return this.children.length; }
  get lastChild() { return this.children[this.children.length - 1] || null; }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c; }
  append(...cs) { cs.forEach((c) => this.appendChild(c)); }
  replaceChildren(...cs) { this.children = []; this._text = ''; cs.forEach((c) => this.appendChild(c)); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  fire(type, event) { for (const fn of this.listeners[type] || []) fn(event); }
  focus() { this.ownerDocument.activeElement = this; }
  contains(el) {
    for (let n = el; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  descendants() { return this.children.flatMap((c) => [c, ...c.descendants()]); }
  // Only what the F5 code asks of it: the renderWebsite anchor.
  querySelector(sel) {
    if (sel !== 'a') return null;
    const m = this._html.match(/^<a href="([^"]*)" target="_blank" rel="noopener">/);
    if (!m) return null;
    const a = new FakeEl(this.ownerDocument, 'a');
    a.setAttribute('href', m[1]);
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener');
    return a;
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) {
      if (sel === '[role="tab"]' && n.getAttribute('role') === 'tab') return n;
    }
    return null;
  }
}

function makeEnv(opts) {
  const o = opts || {};
  const doc = {
    registry: new Map(),
    listeners: {},
    activeElement: null,
    rows: [],
    getElementById(id) {
      if (!this.registry.has(id)) this.registry.set(id, new FakeEl(this, 'div', id));
      return this.registry.get(id);
    },
    createElement(tag) { return new FakeEl(this, tag); },
    contains() { return true; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    querySelectorAll(sel) {
      if (sel === '#numbers-table-body .number-check') {
        return this.rows.map((id) => { const cb = new FakeEl(this, 'input'); cb.dataset.id = id; return cb; });
      }
      if (sel === '#numbers-table-body tr[data-lead-id]') return this.rowEls;
      if (sel === '#numbers-table-body tr.lead-row-open') return this.rowEls.filter((r) => r.classList.contains('lead-row-open'));
      return [];
    }
  };
  doc.rowEls = [];
  // Tabs and panels exist in the real markup; mirror their attributes.
  for (const key of ['overview', 'research', 'evidence', 'icp', 'pitch']) {
    const tab = doc.getElementById('lead-tab-' + key);
    tab.setAttribute('role', 'tab');
    tab.dataset.tab = key;
    doc.getElementById('lead-panel-' + key).hidden = key !== 'overview';
  }
  doc.getElementById('lead-detail-overlay').hidden = true;
  const toasts = [];
  const calls = { open: [], close: 0 };
  const storage = o.storage || {};
  const deps = {
    document: doc,
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null) },
    navigator: { clipboard: { writeText: async () => {} } },
    MutationObserver: class { observe() {} },
    toast: (msg, type) => toasts.push({ msg, type }),
    safeAsync: (fn) => fn,
    openLeadDetail: async (id) => { calls.open.push(id); },
    closeLeadDetail: () => { calls.close += 1; }
  };
  const escapeHtmlSrc = functionSource(rendererSource, 'function escapeHtml(');
  const renderWebsiteSrc = functionSource(rendererSource, 'function renderWebsite(value)');
  const researchConsts = between(rendererSource, 'const RESEARCH_AVAILABILITY = [', 'function researchPacketSections(');
  const p1a = between(rendererSource, '// === P1-A deterministic data-quality signals (read-only) ===',
    "document.getElementById('btn-delete-selected')");
  const mobile = between(rendererSource, 'function isMobileNumber(phone) {', '\nfunction ');
  const names = Object.keys(deps);
  const api = new Function(...names,
    escapeHtmlSrc + '\n' + renderWebsiteSrc + '\n' + mobile + '\n' + researchConsts + '\n' + p1a + '\n' + f5 +
    '\nreturn { showLeadDrawer, renderLeadDrawer, renderLeadDrawerResearch, resetLeadDrawer, selectLeadDrawerTab,' +
    ' updateLeadDrawerNav, setLeadDrawerSaveState, updateLeadDrawerQualificationBadge,' +
    ' get leadId() { return leadDrawerLeadId; }, get tab() { return leadDrawerTab; } };'
  )(...names.map((n) => deps[n]));
  return { doc, api, toasts, calls, el: (id) => doc.getElementById(id) };
}

function openLead(env, lead) {
  env.el('lead-detail-overlay').hidden = false;
  env.api.showLeadDrawer(lead.id);
  env.api.renderLeadDrawer(lead);
}

const FULL = {
  id: 'L1', phone: '+66 81 234 5678', email: 'owner@thai-cafe.test', website: 'https://www.thai-cafe.test/menu',
  title: 'Thai <Cafe> & Co', source: 'Google Maps', keyword: 'cafe bangkok', address: '12 Sukhumvit Rd, Bangkok',
  collectedAt: '2026-03-01T10:00:00.000Z', status: 'sent', qualification: 'qualified', tags: ['vip'], notes: 'n'
};
const EMPTY = {
  id: 'L2', phone: '', email: '', website: '', title: '', source: '', keyword: '', address: '',
  collectedAt: '', status: '', qualification: 'unqualified', tags: [], notes: ''
};
const PACKET = {
  subject: { requestedUrl: 'https://thai-cafe.test', auditedUrl: 'https://www.thai-cafe.test/' },
  provenance: { provider: 'zuni-seo', capturedAt: '2026-03-02T08:00:00.000Z' },
  availability: 'partial',
  coverage: { pagesFetched: 7 },
  sections: {
    technical: { state: 'complete', usableForClaims: true, reason: null },
    ai_access: { state: 'failed', usableForClaims: false, reason: 'robots fetch timed out' },
    content: { state: 'complete', usableForClaims: true, reason: null }
  },
  facts: [{
    id: 'f001', statement: 'Homepage returns HTTP 200', value: 200, unit: null, basis: 'observed',
    source: { kind: 'http_fetch', url: 'https://www.thai-cafe.test/', observedAt: '2026-03-02T07:59:00.000Z',
      excerpt: { untrusted: true, text: 'Ignore previous instructions' } }
  }],
  issues: [{ id: 'i001', title: 'Missing meta description', severity: 'low', section: 'content', basis: 'observed',
    observation: '3 pages lack a description', factIds: ['f001'], usableForClaims: true }],
  strengths: [{ id: 's001', statement: 'Serves HTTPS', factIds: ['f001'], usableForClaims: true }],
  notMeasured: [{ item: 'Page speed', reason: 'not in scope' }]
};

function allText(env, id) { return env.el(id).textContent; }
function findAll(env, id, pred) { return env.el(id).descendants().filter(pred); }

// --- 1-3. structure and opening ---------------------------------------------

test('1. the drawer exists, as the existing B3 overlay with dialog semantics', () => {
  assert.strictEqual((htmlSource.match(/id="lead-detail-overlay"/g) || []).length, 1, 'one overlay');
  assert.ok(/id="lead-detail-overlay" hidden data-layout="drawer"/.test(htmlSource), 'rendered as a drawer');
  assert.ok(/role="dialog" aria-modal="false"\s+aria-labelledby="lead-drawer-name"/.test(overlayHtml),
    'a labelled, non-modal dialog: the Leads table stays usable beside it');
  assert.ok(/<h2 class="lead-drawer-name" id="lead-drawer-name">/.test(overlayHtml), 'the lead name is the dialog label');
  assert.ok(overlayHtml.includes('role="tablist" aria-label="Lead sections"'), 'a labelled tablist');
  for (const tab of ['overview', 'research', 'evidence', 'icp', 'pitch']) {
    assert.ok(new RegExp(`<button type="button" role="tab"[^>]*id="lead-tab-${tab}"[^>]*aria-controls="lead-panel-${tab}"`).test(overlayHtml),
      'the tab is a real button controlling its panel: ' + tab);
    assert.ok(new RegExp(`role="tabpanel" id="lead-panel-${tab}" aria-labelledby="lead-tab-${tab}"`).test(overlayHtml),
      'the panel is labelled by its tab: ' + tab);
  }
  // The header sits outside the scroll region, so it is always visible.
  const header = overlayHtml.indexOf('class="lead-detail-header lead-drawer-header"');
  const scroll = overlayHtml.indexOf('class="lead-drawer-scroll"');
  assert.ok(header !== -1 && scroll > overlayHtml.indexOf('id="lead-drawer-tabs"'), 'header and tabs precede the scroll region');
  assert.ok(/\.lead-drawer-scroll \{[\s\S]*?overflow-y: auto/.test(f5css), 'only the body scrolls');
});

test('2. the drawer is initially closed', () => {
  assert.ok(/id="lead-detail-overlay" hidden/.test(htmlSource), 'hidden at load');
  for (const tab of ['research', 'evidence', 'icp', 'pitch']) {
    assert.ok(new RegExp(`id="lead-panel-${tab}"[^>]*hidden`).test(overlayHtml), 'non-default panel hidden: ' + tab);
  }
  assert.ok(/aria-selected="true" tabindex="0">Overview</.test(overlayHtml), 'Overview is the default tab');
});

test('3. clicking a lead opens the drawer through the existing detail path', () => {
  const handler = between(rendererSource, "document.getElementById('numbers-table-body').addEventListener('click'",
    "document.getElementById('btn-close-lead-detail').addEventListener");
  assert.ok(handler.includes('await openLeadDetail(leadId)'), 'the row still calls openLeadDetail');
  assert.ok(openFn.indexOf('overlay.hidden = false;') < openFn.indexOf('showLeadDrawer(id)'), 'the drawer opens with the overlay');
  assert.ok(openFn.indexOf('populateLeadCompany(lead)') < openFn.indexOf('renderLeadDrawer(lead)'),
    'the drawer renders after the existing regions, inside the same seq guard');
  const env = makeEnv();
  env.doc.rows = ['L0', 'L1', 'L2'];
  env.doc.rowEls = ['L0', 'L1', 'L2'].map((id) => { const tr = new FakeEl(env.doc, 'tr'); tr.dataset.leadId = id; return tr; });
  openLead(env, FULL);
  assert.strictEqual(env.api.leadId, 'L1');
  assert.strictEqual(env.el('lead-detail-overlay').dataset.layout, 'drawer');
  assert.strictEqual(env.el('lead-drawer').getAttribute('aria-modal'), 'false');
  assert.strictEqual(env.doc.activeElement, env.el('lead-drawer'), 'focus moves into the drawer');
  assert.ok(env.doc.rowEls[1].classList.contains('lead-row-open'), 'the open lead is marked in the table');
  assert.strictEqual(env.doc.rowEls[1].getAttribute('aria-current'), 'true');
  assert.strictEqual(allText(env, 'lead-drawer-position'), '2 of 3 on this page');
});

// --- 4, 8, 9. data ------------------------------------------------------------

test('4. the header shows the stored lead, escaped as text', () => {
  const env = makeEnv();
  openLead(env, FULL);
  assert.strictEqual(allText(env, 'lead-drawer-name'), 'Thai <Cafe> & Co', 'set as text, never parsed as markup');
  assert.strictEqual(allText(env, 'lead-drawer-subtitle'), '12 Sukhumvit Rd, Bangkok');
  const contact = allText(env, 'lead-drawer-contact');
  for (const value of ['thai-cafe.test', '+66 81 234 5678', 'owner@thai-cafe.test']) {
    assert.ok(contact.includes(value), 'contact shows ' + value);
  }
  const badges = env.el('lead-drawer-badges').children;
  assert.strictEqual(badges[0].textContent, 'sent', 'the stored lead status');
  assert.strictEqual(badges[1].textContent, 'qualified', 'the stored qualification');
  assert.ok(!f5Code.includes('.innerHTML = ') || f5Code.split('.innerHTML = ').length === 2,
    'the only markup insertion is the renderWebsite link');
});

test('8. Overview shows the real contact and business fields', () => {
  const env = makeEnv();
  openLead(env, FULL);
  const contact = allText(env, 'lead-drawer-contact-fields');
  assert.ok(contact.includes('Phone+66 81 234 5678Copy'), 'phone with a copy action');
  assert.ok(contact.includes('Emailowner@thai-cafe.testCopy'), 'email with a copy action');
  assert.ok(contact.includes('Websitethai-cafe.testOpen site'), 'website host from the existing quality signal, with an open action');
  const business = allText(env, 'lead-drawer-business-fields');
  for (const value of ['NameThai <Cafe> & Co', 'SourceGoogle Maps', 'Keywordcafe bangkok', 'Address12 Sukhumvit Rd, Bangkok']) {
    assert.ok(business.includes(value), 'business field: ' + value);
  }
  assert.ok(business.includes('Collected' + new Date(FULL.collectedAt).toLocaleString('en-GB')), 'collectedAt, en-GB');
  // Data quality is the existing P1-A section, not a second system.
  assert.ok(f5.includes('leadQualitySignals(lead)'), 'the drawer reuses the existing derived signals');
  assert.ok(!/function\s+\w*[Cc]ompleteness/.test(f5), 'no second completeness calculation');
  const overview = between(overlayHtml, 'id="lead-panel-overview"', 'id="lead-panel-research"');
  for (const id of ['lead-detail-quality', 'lead-detail-quality-body', 'lead-user-status', 'lead-detail-company', 'lead-detail-body']) {
    assert.ok(overview.includes(`id="${id}"`), 'existing region on the Overview tab: ' + id);
  }
});

test('9. missing fields show honest states, never a fabricated value or action', () => {
  const env = makeEnv();
  openLead(env, EMPTY);
  assert.strictEqual(allText(env, 'lead-drawer-name'), 'Untitled lead');
  assert.strictEqual(allText(env, 'lead-drawer-subtitle'), 'No business name stored');
  assert.strictEqual(allText(env, 'lead-drawer-contact'), 'No website, phone or email stored');
  const contact = allText(env, 'lead-drawer-contact-fields');
  assert.strictEqual(contact, 'PhoneNot availableEmailNot availableWebsiteNot available');
  assert.strictEqual(findAll(env, 'lead-drawer-contact-fields', (n) => n.tagName === 'BUTTON' || n.tagName === 'A').length, 0,
    'no copy or open action for a missing value');
  assert.ok(allText(env, 'lead-drawer-business-fields').includes('CollectedNot available'), 'missing collectedAt is not invented');
  assert.strictEqual(env.el('lead-drawer-badges').children[0].textContent, 'pending', 'the table\'s own status default');
  // A lead with only a phone is named by that phone, as the table does.
  const env2 = makeEnv();
  openLead(env2, { ...EMPTY, id: 'L3', phone: '+1 555 0100' });
  assert.strictEqual(allText(env2, 'lead-drawer-name'), '+1 555 0100');
});

// --- 10-13. editing preserved -------------------------------------------------

test('10. qualification editing is preserved on the existing save path', () => {
  assert.ok(/<select id="lead-detail-qualification">/.test(overlayHtml), 'the control is in the drawer');
  const save = between(rendererSource, 'async function saveLeadDetail()', "getElementById('btn-save-lead-detail').addEventListener");
  assert.ok(save.includes('window.appAPI.collector.updateLead({'), 'the existing IPC method');
  assert.ok(save.includes("qualification: select && select.value === 'qualified' ? 'qualified' : 'unqualified'"), 'unchanged value mapping');
  assert.ok(save.includes('if (seq !== detailLoadSeq) return;'), 'the stale-save guard is intact');
  assert.ok(save.includes("setLeadDrawerSaveState('lead-drawer-save-state', 'ok', 'Saved')"), 'success is shown inline');
  assert.ok(save.includes("setLeadDrawerSaveState('lead-drawer-save-state', 'error', 'Not saved: ' + msg)"), 'failure is shown inline');
  assert.ok(save.includes('updateLeadDrawerQualificationBadge('), 'the header badge follows a successful save');
  const env = makeEnv();
  openLead(env, EMPTY);
  env.api.updateLeadDrawerQualificationBadge('qualified');
  assert.strictEqual(env.el('lead-drawer-qualification-badge').textContent, 'qualified');
  env.api.setLeadDrawerSaveState('lead-drawer-save-state', 'error', 'Not saved: refused');
  assert.strictEqual(env.el('lead-drawer-save-state').dataset.state, 'error');
});

test('11. tag editing is preserved', () => {
  for (const id of ['lead-detail-tag-list', 'lead-detail-tag-input', 'btn-lead-detail-add-tag']) {
    assert.ok(overlayHtml.includes(`id="${id}"`), 'tag control in the drawer: ' + id);
  }
  assert.ok(rendererSource.includes("document.getElementById('btn-lead-detail-add-tag').addEventListener('click', safeAsync(() => addLeadDetailTag()))"),
    'the add handler is unchanged');
  const save = between(rendererSource, 'async function saveLeadDetail()', "getElementById('btn-save-lead-detail').addEventListener");
  assert.ok(save.includes('tags: leadDetailContext.tags.slice()'), 'tags still saved through updateLead');
});

test('12. notes editing is preserved', () => {
  assert.ok(/<textarea id="lead-detail-notes" rows="4" maxlength="5000"/.test(overlayHtml), 'the notes control in the drawer');
  const save = between(rendererSource, 'async function saveLeadDetail()', "getElementById('btn-save-lead-detail').addEventListener");
  assert.ok(save.includes('notes: noteValue'), 'notes still saved through updateLead');
  assert.ok(save.includes('noteValue.length > LEAD_NOTES_MAX'), 'the notes bound is unchanged');
});

test('13. the four user-owned status fields are preserved', () => {
  for (const [id, field] of [['lead-status-phone', 'phoneStatus'], ['lead-status-email', 'emailStatus'],
    ['lead-status-website', 'websiteStatus'], ['lead-status-business', 'businessStatus']]) {
    assert.ok(overlayHtml.includes(`<select id="${id}" data-status-field="${field}">`), 'status control in the drawer: ' + id);
  }
  const save = between(rendererSource, 'async function saveLeadUserStatus()', "getElementById('btn-save-lead-status')");
  assert.ok(save.includes('window.appAPI.collector.updateLeadQuality(payload)'), 'the existing IPC method');
  assert.ok(save.includes("'lead-drawer-status-save-state', 'ok', 'Status saved'"), 'success shown inline');
  assert.ok(save.includes("'lead-drawer-status-save-state', 'error', 'Not saved: ' + msg"), 'failure shown inline');
  // The re-read after a status save keeps the drawer on the same lead.
  const env = makeEnv();
  openLead(env, FULL);
  env.api.setLeadDrawerSaveState('lead-drawer-status-save-state', 'ok', 'Status saved');
  env.api.showLeadDrawer('L1');
  assert.strictEqual(allText(env, 'lead-drawer-status-save-state'), 'Status saved', 'a same-lead reload keeps the result');
  env.api.showLeadDrawer('L2');
  assert.strictEqual(allText(env, 'lead-drawer-status-save-state'), '', 'another lead starts clean');
});

// --- 5-7. close, Escape, tabs -------------------------------------------------

test('5. the close button closes through closeLeadDetail, which resets the drawer', () => {
  assert.ok(/<button type="button" class="lead-drawer-icon-btn lead-drawer-close" id="btn-close-lead-detail" aria-label="Close lead detail"/.test(overlayHtml),
    'a real, labelled button');
  assert.ok(rendererSource.includes("document.getElementById('btn-close-lead-detail').addEventListener('click', () => closeLeadDetail());"),
    'wired to the existing close');
  assert.ok(closeFn.includes('detailLoadSeq += 1') && closeFn.includes('resetLeadDrawer();'), 'close invalidates and resets');
  const env = makeEnv();
  const trigger = new FakeEl(env.doc, 'button');
  env.doc.activeElement = trigger;
  env.doc.rowEls = [new FakeEl(env.doc, 'tr')];
  env.doc.rowEls[0].dataset.leadId = 'L1';
  openLead(env, FULL);
  env.api.selectLeadDrawerTab('evidence', false);
  env.api.resetLeadDrawer();
  assert.strictEqual(env.api.leadId, null);
  assert.strictEqual(env.api.tab, 'overview', 'the next open starts on Overview');
  assert.ok(!env.doc.rowEls[0].classList.contains('lead-row-open'), 'the row marker is cleared');
  assert.strictEqual(env.doc.activeElement, trigger, 'focus returns to where it was');
});

test('6. Escape closes the drawer, and only when it is open and the key is unclaimed', () => {
  const env = makeEnv();
  const [onKey] = env.doc.listeners.keydown;
  let prevented = false;
  const esc = (extra) => ({ key: 'Escape', defaultPrevented: false, preventDefault() { prevented = true; }, ...extra });
  onKey(esc());
  assert.strictEqual(env.calls.close, 0, 'nothing happens while closed');
  openLead(env, FULL);
  onKey(esc({ defaultPrevented: true }));
  assert.strictEqual(env.calls.close, 0, 'an Escape the filter popover consumed is left alone');
  onKey({ key: 'Enter', defaultPrevented: false, preventDefault() {} });
  assert.strictEqual(env.calls.close, 0);
  onKey(esc());
  assert.strictEqual(env.calls.close, 1, 'Escape closes');
  assert.ok(prevented, 'and is consumed');
});

test('7. tabs switch by click and by keyboard, with correct ARIA state', () => {
  const env = makeEnv();
  openLead(env, FULL);
  const tabs = env.el('lead-drawer-tabs');
  tabs.fire('click', { target: env.el('lead-tab-research') });
  assert.strictEqual(env.el('lead-tab-research').getAttribute('aria-selected'), 'true');
  assert.strictEqual(env.el('lead-tab-overview').getAttribute('aria-selected'), 'false');
  assert.strictEqual(env.el('lead-panel-research').hidden, false);
  assert.strictEqual(env.el('lead-panel-overview').hidden, true);
  assert.strictEqual(env.el('lead-tab-research').tabIndex, 0, 'roving tabindex');
  assert.strictEqual(env.el('lead-tab-overview').tabIndex, -1);
  const key = (k) => tabs.fire('keydown', { key: k, preventDefault() {} });
  key('ArrowRight');
  assert.strictEqual(env.api.tab, 'evidence');
  assert.strictEqual(env.doc.activeElement, env.el('lead-tab-evidence'), 'focus follows the selected tab');
  key('End');
  assert.strictEqual(env.api.tab, 'pitch');
  key('ArrowRight');
  assert.strictEqual(env.api.tab, 'overview', 'wraps around');
  key('ArrowLeft');
  assert.strictEqual(env.api.tab, 'pitch');
  key('Home');
  assert.strictEqual(env.api.tab, 'overview');
  env.api.selectLeadDrawerTab('bogus', false);
  assert.strictEqual(env.api.tab, 'overview', 'an unknown tab is refused');
});

// --- 14-17. intelligence tabs -------------------------------------------------

test('14. every existing research state is handled with its existing semantics', () => {
  assert.ok(openFn.includes('loadLeadResearch(id, seq)'), 'research still loads through the existing path');
  assert.ok(rendererSource.includes('renderLeadDrawerResearch(view, null);'), 'the drawer is fed by renderLeadResearch');
  assert.ok(!/appAPI\.research\.(request|get|importArtifact)/.test(f5Code), 'the drawer starts no research of its own');
  const env = makeEnv();
  openLead(env, FULL);
  assert.ok(allText(env, 'lead-drawer-research-summary').includes('Loading research status'), 'loading state');
  env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: 'not_checked', packet: null, website: null });
  assert.ok(allText(env, 'lead-drawer-research-summary').startsWith('Research has not been completed for this lead.'));
  const expected = {
    no_website: 'No website on record', site_unreachable: 'Unreachable (reported by research)',
    no_crawlable_content: 'Responded, but no readable content', pending: 'Not checked', failed: 'Not checked'
  };
  for (const state of ['no_website', 'not_checked', 'pending', 'site_unreachable', 'no_crawlable_content',
    'partial', 'complete', 'failed', 'stale']) {
    env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: state, packet: null, website: 'https://thai-cafe.test' });
    const text = allText(env, 'lead-drawer-research-summary');
    assert.ok(text.includes('Research status'), 'status row for ' + state);
    if (expected[state]) assert.ok(text.includes('Website status' + expected[state]), 'website status for ' + state);
  }
  env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: 'partial', packet: PACKET, website: 'https://thai-cafe.test',
    updatedAt: '2026-03-02T08:00:00.000Z', stale: false });
  const full = allText(env, 'lead-drawer-research-summary');
  assert.ok(full.includes('Research statusPartial'));
  assert.ok(full.includes('Website statusReached by research'));
  assert.ok(full.includes('Pages fetched7'), 'a real coverage count from the packet');
  assert.ok(full.includes('AI access sectionfailed - robots fetch timed out'), 'section states from the packet object');
  assert.ok(full.includes('Last updated' + new Date('2026-03-02T08:00:00.000Z').toLocaleString('en-GB')));
  env.api.renderLeadDrawerResearch(null, 'Untrusted sender.');
  assert.ok(allText(env, 'lead-drawer-research-summary').includes('Research status could not be loaded: Untrusted sender.'));
  // A late response for another lead never lands on this one.
  env.api.renderLeadDrawerResearch({ leadRef: 'OTHER', availability: 'complete', packet: PACKET });
  assert.ok(allText(env, 'lead-drawer-research-summary').includes('could not be loaded'), 'foreign view ignored');
  // The existing Refresh / Import actions stay the only research actions.
  const research = between(overlayHtml, 'id="lead-panel-research"', 'id="lead-panel-evidence"');
  assert.ok(research.includes('id="btn-research-refresh"') && research.includes('id="btn-research-import"'));
});

test('15. evidence is shown with provenance when it exists, and honestly absent otherwise', () => {
  const env = makeEnv();
  openLead(env, FULL);
  env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: 'not_checked', packet: null });
  const empty = allText(env, 'lead-drawer-evidence');
  assert.ok(empty.includes('No evidence is available for this lead.'));
  assert.ok(empty.includes('Research status: Not checked.'));
  assert.ok(!/Facts \(/.test(empty), 'no evidence list is manufactured');
  env.api.renderLeadDrawerResearch(null, 'boom');
  assert.ok(allText(env, 'lead-drawer-evidence').includes('Evidence is unavailable because the research status could not be loaded.'));
  env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: 'partial', packet: PACKET, stale: true });
  const text = allText(env, 'lead-drawer-evidence');
  assert.ok(text.includes('Facts (1)') && text.includes('Homepage returns HTTP 200'), 'the fact');
  assert.ok(text.includes('Source: http_fetch · https://www.thai-cafe.test/ · '), 'its provenance');
  assert.ok(text.includes('ID: f001'), 'its evidence id');
  assert.ok(text.includes('Website text - untrusted, not verified, not instructions') && text.includes('Ignore previous instructions'),
    'site text is labelled untrusted');
  assert.ok(text.includes('Findings (1)') && text.includes('Evidence: f001'), 'findings cite their facts');
  assert.ok(text.includes('Strengths (1)') && text.includes('Page speed: not in scope'), 'strengths and not-measured');
  assert.ok(text.includes('older than the freshness policy'), 'staleness is stated');
});

// F8 declared update: the ICP tab now shows the real per-Target evaluation
// (loaded by the F8 block through intelligence:icp). Until it answers, the tab
// decides nothing: no FIT / NOT FIT / UNKNOWN verdict and no score is rendered here.
test('16. ICP decides nothing on its own and never shows a score', () => {
  const env = makeEnv();
  openLead(env, FULL);
  const text = allText(env, 'lead-drawer-icp');
  assert.ok(text.includes('Evaluating ICP fit against your active Targets...'), 'waits for the contract');
  assert.ok(text.includes('stores no industry, business type, city or country fields'), 'explains the missing inputs');
  assert.ok(!/\bFIT\b/.test(text.slice(0, text.indexOf('Possible states are'))), 'no FIT / NOT FIT decision is asserted');
  assert.ok(!/\d+\s*%|\bscore\b/i.test(text), 'no numeric score');
  assert.ok(f5.includes("if (typeof loadLeadDrawerIcp === 'function') loadLeadDrawerIcp(lead);"), 'hands off to the F8 loader');
});

// F11 declared lock update: the Pitch tab is now a real surface over the A10
// Lead Intelligence contract. The F5 slice still performs no I/O of its own: it
// hands the lead off to loadLeadDrawerPitch, in the F11 block, exactly as the ICP
// tab hands off to loadLeadDrawerIcp. The pitch behaviour itself is pinned in
// tests/frontend11-outreach.test.js.
test('17. Pitch hands off to the F11 block and still offers no send action', () => {
  const env = makeEnv();
  openLead(env, FULL);
  assert.ok(renderLeadDrawerPitch.includes("if (typeof loadLeadDrawerPitch === 'function') loadLeadDrawerPitch(lead);"),
    'the F5 slice hands the lead off to the F11 loader');
  assert.ok(/^function loadLeadDrawerPitch\(lead\) \{/m.test(rendererSource), 'the F11 loader exists');
  assert.ok(/^async function f11Run\(/m.test(rendererSource), 'and the F11 action runner is the async part');
  assert.ok(!/Pitch generation is not available yet\./.test(rendererSource), 'the placeholder is gone');
  assert.ok(!/renderLeadDrawerPitch\(\);/.test(renderLeadDrawerSource), 'renderLeadDrawer passes the lead row to the Pitch tab');
  assert.ok(!/>\s*Send\b/i.test(overlayHtml) && !/'Send'|"Send"/.test(f5Code), 'no Send button anywhere in the drawer');
  // The F5 boundary is unchanged: no pitch API, no I/O, inside this slice.
  assert.ok(!/pitch\.(generate|get|update)|outreach\./.test(f5Code), 'no pitch API is invented in the F5 slice');
  assert.ok(!/ztechLeadIntel/.test(f5Code), 'the F5 slice does not reach the Lead Intelligence API');
  assert.ok(!/'Send'|"Send"/.test(f11Source), 'no send control in the F11 block either');
});

// --- 18-19. actions and honesty ----------------------------------------------

test('18. the website action uses the existing renderWebsite path; there is no window.open', () => {
  const action = functionSource(rendererSource, 'function leadDrawerWebsiteAction(');
  assert.ok(action.includes('holder.innerHTML = renderWebsite(website);'), 'the existing protocol-checked helper');
  assert.ok(!/window\.open|shell\.|openExternal/.test(rendererSource), 'no new navigation mechanism in the renderer');
  assert.ok(mainSource.includes("if (protocol === 'http:' || protocol === 'https:')"), 'main still allowlists http/https');
  const env = makeEnv();
  openLead(env, FULL);
  const [link] = findAll(env, 'lead-drawer-contact', (n) => n.tagName === 'A');
  assert.strictEqual(link.getAttribute('href'), 'https://www.thai-cafe.test/menu');
  assert.strictEqual(link.getAttribute('target'), '_blank');
  assert.strictEqual(link.getAttribute('rel'), 'noopener');
  assert.strictEqual(link.getAttribute('aria-label'), 'Open website thai-cafe.test in your browser');
  openLead(env, { ...EMPTY, id: 'L9', website: 'javascript:alert(1)' });
  assert.strictEqual(findAll(env, 'lead-drawer-contact', (n) => n.tagName === 'A').length, 0,
    'a non-web value gets no open action');
  const [copy] = findAll(env, 'lead-drawer-contact-fields', (n) => n.tagName === 'BUTTON');
  assert.strictEqual(copy, undefined, 'and no copy action without a phone or email');
});

test('19. no fake metrics, scores or sample data', () => {
  assert.ok(!/score|percentile|probability|confidence|rating|Math\.random/i.test(f5Code), 'no scoring vocabulary in F5 code');
  for (const banned of ['lorem', 'Acme', 'John Doe', 'sample_lead', 'mockLead']) {
    assert.ok(!f5.toLowerCase().includes(banned.toLowerCase()), 'no sample data: ' + banned);
  }
  const env = makeEnv();
  openLead(env, FULL);
  const steps = env.el('lead-drawer-pipeline').children.map((c) => c.textContent);
  assert.deepStrictEqual(steps, ['LeadStored', 'ResearchLoading', 'EvidenceNone yet', 'ICPPer Target',
    'OpportunityNot available yet', 'PitchNot available yet', 'OutreachNot available yet'],
  'the progression states only what is real');
  env.api.renderLeadDrawerResearch({ leadRef: 'L1', availability: 'complete', packet: PACKET });
  assert.strictEqual(env.el('lead-drawer-pipeline').children[2].textContent, 'Evidence1 fact', 'the real fact count');
});

// --- 20-23. security and preserved contracts ---------------------------------

test('20. the CSP is unchanged and no inline script or handler was added', () => {
  const match = htmlSource.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.strictEqual(match[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
  assert.ok(!/<script(?![^>]*src=)/i.test(overlayHtml) && !/\son\w+="/.test(overlayHtml), 'no inline script or handler');
  assert.ok(!/eval\(|new Function|on(?:click|error|load)\s*=/.test(f5Code), 'no dynamic code');
});

test('21. the IPC channel set and dependencies are unchanged', () => {
  // F6 declared lock update: +7 Lists channels (F5 itself added none).
  // F8 declared lock update: +1 intelligence:icp.
  assert.strictEqual((mainSource.match(/ipcMain\.handle\('/g) || []).length, 34, '34 IPC channels');
  // A10 declared lock update: 41 -> 46 preload invocations (the five approved
  // Lead Intelligence methods). The F5 block itself still performs no I/O.
  assert.strictEqual(preloadSource.split('ipcRenderer.invoke').length - 1, 49, '49 preload invocations');
  assert.ok(!/appAPI|ipcRenderer|fetch\(|XMLHttpRequest|WebSocket/.test(f5Code), 'the F5 block performs no I/O');
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
    ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js']);
  assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
    ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on']);
});

test('22. the lead-query contract is untouched: navigation reuses the rendered page', () => {
  assert.ok(!/numbersLoadSeq|renderNumbers\(|numbersQueryPayload|getNumbers/.test(f5Code), 'no page query from the drawer');
  assert.ok(rendererSource.includes('window.appAPI.collector.getNumbers(numbersQueryPayload())'), 'page query unchanged');
  const env = makeEnv();
  env.doc.rows = ['A', 'B', 'C'];
  openLead(env, { ...FULL, id: 'A' });
  assert.strictEqual(env.el('btn-lead-drawer-prev').disabled, true, 'no previous on the first row');
  assert.strictEqual(env.el('btn-lead-drawer-next').disabled, false);
  env.el('btn-lead-drawer-next').fire('click');
  assert.deepStrictEqual(env.calls.open, ['B'], 'next opens the next rendered row through openLeadDetail');
  openLead(env, { ...FULL, id: 'C' });
  assert.strictEqual(env.el('btn-lead-drawer-next').disabled, true, 'no next on the last row');
  env.doc.rows = ['X', 'Y'];
  env.api.updateLeadDrawerNav();
  assert.strictEqual(env.el('btn-lead-drawer-prev').disabled, true, 'a lead no longer on the page cannot step');
  assert.strictEqual(env.el('btn-lead-drawer-next').disabled, true);
  assert.strictEqual(allText(env, 'lead-drawer-position'), '');
});

test('23. the lead-detail contract is untouched: single read, race guard, all regions', () => {
  assert.ok(openFn.includes('getNumbers({ limit: 1, offset: 0, id })'), 'the B3 single-lead read');
  assert.ok(openFn.includes('const seq = ++detailLoadSeq;') && openFn.includes('if (seq !== detailLoadSeq) return;'), 'race guard');
  assert.ok(openFn.includes('body.innerHTML = leadDetailTemplate(lead);'), 'the escaped B3 template still renders');
  for (const id of ['lead-detail-body', 'lead-detail-b6', 'lead-detail-research', 'lead-detail-research-body',
    'lead-detail-quality', 'lead-user-status', 'lead-detail-company', 'btn-save-lead-detail', 'btn-save-lead-status']) {
    assert.strictEqual((htmlSource.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, 'exactly one: ' + id);
  }
});

// --- layout ----------------------------------------------------------------

test('24. the old modal remains as a renderer-local layout flag', () => {
  assert.ok(f5.includes("const LEAD_DRAWER_LAYOUT_KEY = 'ztech.leadDetail.layout';"));
  assert.ok(!/localStorage\.setItem/.test(f5), 'the drawer never writes the flag itself');
  assert.ok(cssSource.includes('.lead-detail-overlay {') && cssSource.includes('.lead-detail-panel {'), 'modal rules kept');
  assert.ok(/\[data-layout="modal"\] \.lead-drawer-panel\[hidden\] \{\s*display: block;/.test(f5css), 'modal stacks every section');
  const env = makeEnv({ storage: { 'ztech.leadDetail.layout': 'modal' } });
  openLead(env, FULL);
  assert.strictEqual(env.el('lead-detail-overlay').dataset.layout, 'modal');
  assert.strictEqual(env.el('lead-drawer').getAttribute('aria-modal'), 'true', 'the modal is announced as modal');
});

test('25. the drawer stylesheet follows the F1 design rules and narrows safely', () => {
  assert.ok(!/gradient|@import|url\(/i.test(f5css), 'no gradient, import or asset');
  assert.ok(!/outline:\s*none/.test(f5css), 'no focus ring is removed');
  const radii = [...f5css.matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1].trim());
  for (const r of radii) assert.ok(/^var\(--radius-(sm|md|lg)\)$/.test(r) || r === '0', 'radius token: ' + r);
  assert.ok(/box-shadow: var\(--shadow-2\)/.test(f5css), 'the drawer uses the F1 shadow token');
  assert.ok(/width: clamp\(420px, 38vw, 520px\)/.test(f5css), '420-520px drawer');
  assert.ok(/pointer-events: none/.test(f5css) && /pointer-events: auto/.test(f5css), 'the table stays usable beside it');
  assert.ok(/@media \(max-width: 960px\) \{[\s\S]*?width: 100vw/.test(f5css), 'full width on a narrow window');
  assert.ok(/\.lead-drawer-scroll \{[\s\S]*?overflow-x: hidden/.test(f5css), 'no horizontal overflow in the body');
  assert.ok(/\.lead-drawer-tab\[aria-selected="true"\]/.test(f5css), 'the active tab is styled from its ARIA state');
});

console.log('');
if (failures.length) {
  console.log(passed + ' passed, ' + failures.length + ' failed');
  process.exit(1);
}
console.log(passed + ' passed, 0 failed');
