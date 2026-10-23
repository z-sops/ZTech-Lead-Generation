'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dom = require('../../src/renderer/lead-intelligence/dom');

/** Minimal DOM stand-in: enough to verify the safe-rendering contract. */
function fakeDoc() {
  const make = (tag) => ({
    tagName: tag, nodeType: 1, attrs: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, f) { this.listeners[t] = f; },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
    get firstChild() { return this.children[0] || null; },
    get textContent() { return this.children.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join(''); },
    set innerHTML(_) { throw new Error('innerHTML must not be used'); },
  });
  return { createElement: make, createTextNode: (data) => ({ nodeType: 3, data }) };
}

test('renderer dom: text is inserted as text nodes, never HTML', () => {
  const doc = fakeDoc();
  const el = dom.h(doc, 'div', { class: 'x' }, '<img src=x onerror=alert(1)>', ['a', null, false, 'b']);
  assert.equal(el.children[0].nodeType, 3);
  assert.equal(el.textContent, '<img src=x onerror=alert(1)>ab');
  assert.equal(el.attrs.class, 'x');
});

test('renderer dom: inline handlers, style and href/src attributes are refused', () => {
  const doc = fakeDoc();
  for (const a of ['onclick', 'onerror', 'style', 'href', 'src', 'srcdoc', 'formaction']) {
    assert.throws(() => dom.h(doc, 'a', { [a]: 'x' }), /attribute not allowed/, a);
  }
  let clicked = false;
  const b = dom.h(doc, 'button', { onClick: () => { clicked = true; } }, 'Go');
  b.listeners.click();
  assert.equal(clicked, true);
});

test('renderer dom: unwrap turns IPC errors into Error objects with codes', () => {
  assert.deepEqual(dom.unwrap({ ok: true, data: { a: 1 } }), { a: 1 });
  assert.throws(() => dom.unwrap({ ok: false, error: { code: 'NOT_FOUND', message: 'Lead not found' } }), (e) => e.code === 'NOT_FOUND' && e.message === 'Lead not found');
});

test('renderer modules load as CommonJS', () => {
  const rs = require('../../src/renderer/lead-intelligence/researchSection');
  const lp = require('../../src/renderer/lead-intelligence/listsPanels');
  const pp = require('../../src/renderer/lead-intelligence/pitchPanel');
  assert.equal(typeof rs.mountResearchSection, 'function');
  assert.equal(typeof lp.mountSavedSearchesPanel, 'function');
  assert.equal(typeof lp.mountSegmentsPanel, 'function');
  assert.equal(typeof pp.mountPitchPanel, 'function');
});

test('renderer research section renders a full profile through the fake DOM', async () => {
  const { build, researchToCompletion } = require('./helpers');
  const { registerLeadIntelligenceIpc } = require('../../src/main/lead-intelligence/ipc/registerLeadIntelligenceIpc');
  const { buildLeadIntelligenceApi } = require('../../src/main/lead-intelligence/ipc/preloadBridge');
  const ctx = build();
  await researchToCompletion(ctx, 'L1');
  const handlers = new Map();
  registerLeadIntelligenceIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler() {} }, li: ctx.li, isTrustedSender: () => true, logger: { warn() {} } });
  const api = buildLeadIntelligenceApi({ invoke: (c, a) => handlers.get(c)({}, a) });
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const { mountResearchSection } = require('../../src/renderer/lead-intelligence/researchSection');
  const view = mountResearchSection({ doc, container, api, leadId: 'L1', targetId: 'T1' });
  await view.refresh();
  const text = container.textContent;
  for (const heading of ['Identity', 'Contact', 'Company', 'Data quality', 'Qualification', 'ICP fit', 'Digital footprint', 'Research status', 'Evidence', 'Findings', 'Strengths', 'Missing information', 'Research freshness & provenance', 'Research history']) {
    assert.ok(text.includes(heading), heading);
  }
  assert.ok(text.includes('Pages without a meta description'));
  view.destroy();
});

test('renderer enrichment section renders providers, field states and steps', async () => {
  const { build } = require('./helpers');
  const { FakeEnrichmentProvider } = require('../../src/main/lead-intelligence/enrichment/FakeEnrichmentProvider');
  const { registerLeadIntelligenceIpc } = require('../../src/main/lead-intelligence/ipc/registerLeadIntelligenceIpc');
  const { buildLeadIntelligenceApi } = require('../../src/main/lead-intelligence/ipc/preloadBridge');
  const ctx = build({
    enrichmentProviders: [new FakeEnrichmentProvider({ id: 'vendor-a', name: 'Vendor A', script: { fields: { 'company.city': 'Karachi', 'company.industry': null } } })],
    config: { enrichment: { enableEvidenceProvider: false, providerOrder: ['vendor-a', 'vendor-z'] } },
  });
  await ctx.li.enrichment.request({ leadId: 'L2', fields: ['company.city', 'company.industry'] });
  await ctx.li.enrichment.idle();
  const handlers = new Map();
  registerLeadIntelligenceIpc({ ipcMain: { handle: (c, f) => handlers.set(c, f), removeHandler() {} }, li: ctx.li, isTrustedSender: () => true, logger: { warn() {} } });
  const api = buildLeadIntelligenceApi({ invoke: (c, a) => handlers.get(c)({}, a) });
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const { mountEnrichmentSection } = require('../../src/renderer/lead-intelligence/enrichmentSection');
  const view = mountEnrichmentSection({ doc, container, api, leadId: 'L2' });
  await view.refresh();
  const text = container.textContent;
  for (const s of ['Enrichment providers', 'Vendor A', 'NOT_CONFIGURED', 'Enriched fields', 'Karachi', 'No value from: vendor-a', 'PARTIAL', 'never overwrite the lead record']) {
    assert.ok(text.includes(s), s);
  }
  view.destroy();
});

test('renderer research section hides research buttons in round1 mode (researchActions: false)', async () => {
  const doc = fakeDoc();
  const container = doc.createElement('div');
  const { mountResearchSection } = require('../../src/renderer/lead-intelligence/researchSection');
  const api = { profile: { get: async () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'Lead not found' } }) } };
  const view = mountResearchSection({ doc, container, api, leadId: 'L1', researchActions: false });
  await view.refresh();
  const text = container.textContent;
  assert.ok(text.includes('Research is run from the Prospect Research panel'));
  assert.ok(!text.includes('Run research'));
  view.destroy();
});
