'use strict';

// Frontend 2.0 F8 — Intelligence workspace (ICP, Signals, Opportunities).
//
// F8 exposes only what the Lead Intelligence contracts can supply in this build.
// ICP is exercised for real: the intelligence:icp handler code is lifted from
// main.js and run against a real AccountStore (sql.js) and the shipped Lead
// Intelligence ICP contract (targetToIcp + evaluateIcpFit + toLeadView), so every
// fit / not_fit / unknown asserted here is the contract's own verdict. Signals
// and Opportunities are pinned to what the contracts actually allow: the signal
// catalogue must equal the module's SIGNAL_TYPES / UNSUPPORTED_SIGNALS, and no
// opportunity, score or estimate may appear. No jsdom, no network.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const liDir = path.join(root, 'src', 'main', 'lead-intelligence');
const { SIGNAL_TYPES, UNSUPPORTED_SIGNALS } = require(path.join(liDir, 'research', 'signals.js'));
const icpContract = require(path.join(liDir, 'icp', 'icpFit.js'));
const leadView = require(path.join(liDir, 'contracts', 'leadView.js'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

function functionSource(source, marker) {
  const from = source.indexOf(marker);
  assert.ok(from !== -1, 'function found: ' + marker);
  const close = source.indexOf('\n}', from);
  return source.slice(from, close + 2);
}

const codeOnly = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const F8 = between(rendererSource, '// === F8 Intelligence workspace ===', '// === F7 Research workspace ===');
const F8_CODE = codeOnly(F8);
const MAIN_F8 = between(mainSource, '// === F8 Intelligence: ICP fit ===', '// === B4 local collection-job ledger hooks ===');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-f8-'));
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: { app: { getPath: () => testRoot } } };
  const loggerPath = require.resolve(path.join(root, 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } } };
  const { AccountStore } = require(path.join(root, 'src', 'main', 'accountStore.js'));
  fs.mkdirSync(path.join(testRoot, 'data'), { recursive: true });
  const store = new AccountStore();
  await store.ready;
  await store.addNumbers([
    { id: 'full', phone: '+66 2 555 0101', title: 'Cool Air Bangkok', website: 'https://coolair.test/', email: 'hi@coolair.test', address: '1 Sukhumvit Rd, Bangkok' },
    { id: 'noemail', phone: '+66 2 555 0102', title: 'Fan Shop', website: 'https://fan.test/', email: '', address: '2 Silom Rd, Bangkok' },
    { id: 'nosite', phone: '+66 2 555 0103', title: 'Offline Repairs', website: '', email: 'x@offline.test', address: '' }
  ]);
  const contactOnly = await store.saveTarget({ name: 'Reachable leads', requiredFields: ['phone', 'website', 'email'], exclusions: '' });
  const market = await store.saveTarget({ name: 'Bangkok HVAC', industry: 'HVAC', businessTypes: 'HVAC Contractor',
    locations: 'Bangkok', requiredFields: ['phone'], exclusions: 'Casino, closed' });

  // The main-process handler code, executed with the real store and contract.
  const helpers = ['invalidParams', 'assertPlainObject', 'assertOptionalString', 'validateListId']
    .map((n) => functionSource(mainSource, `function ${n}(`)).join('\n');
  const main = new Function('accountStore', 'targetToIcp', 'evaluateIcpFit', 'toLeadView',
    helpers + '\n' + MAIN_F8 + '\nreturn { validateIcpPayload, evaluateIcpForTarget };'
  )(store, icpContract.targetToIcp, icpContract.evaluateIcpFit, leadView.toLeadView);
  const evaluate = async (payload) => main.evaluateIcpForTarget(main.validateIcpPayload(payload));
  const byLead = (result) => Object.fromEntries(result.rows.map((r) => [r.leadId, r]));
  const contactResult = await evaluate({ targetId: contactOnly.id });
  const marketResult = await evaluate({ targetId: market.id });

  // --- ICP -------------------------------------------------------------------------

  test('1. fit: every required criterion is met by the stored lead', () => {
    const row = byLead(contactResult).full;
    assert.strictEqual(row.fitStatus, 'fit');
    assert.strictEqual(row.reason, 'All required criteria are met and no exclusion matched.');
    assert.deepStrictEqual(row.matched.map((c) => c.id).sort(), ['required_email', 'required_phone', 'required_website']);
  });

  test('2. not_fit: a required criterion is not met', () => {
    const rows = byLead(contactResult);
    assert.strictEqual(rows.noemail.fitStatus, 'not_fit');
    assert.deepStrictEqual(rows.noemail.unmet.map((c) => c.id), ['required_email']);
    assert.strictEqual(rows.nosite.fitStatus, 'not_fit');
    assert.deepStrictEqual(rows.nosite.unmet.map((c) => c.id), ['required_website']);
  });

  test('3. unknown: missing geography / industry / business type is never inferred', () => {
    const row = byLead(marketResult).full;
    assert.strictEqual(row.fitStatus, 'unknown', 'the address says Bangkok, but location is not inferred from it');
    assert.deepStrictEqual(row.unknown.map((c) => c.id).sort(), ['business_type', 'industry', 'location']);
    for (const c of row.unknown) assert.strictEqual(c.actual, null, 'no invented value for ' + c.id);
    assert.ok(/industry is unknown; cannot evaluate/.test(row.unknown.find((c) => c.id === 'industry').explanation));
    assert.ok(row.matched.some((c) => c.id === 'required_phone'), 'what is known is still reported');
  });

  test('4. explainable reasons and provenance travel for every criterion', () => {
    const row = byLead(contactResult).noemail;
    for (const c of [...row.matched, ...row.unmet]) {
      assert.strictEqual(c.source, 'lead', 'the value came from the lead record');
      assert.ok(typeof c.explanation === 'string' && c.explanation.length > 0);
      assert.ok(Array.isArray(c.factIds) && Array.isArray(c.findingIds), 'evidence id lists are carried');
    }
    assert.deepStrictEqual(marketResult.icp.unmapped, ['exclusions'], 'unconvertible target settings are reported');
    // Evidence ids from the contract are passed through unchanged.
    const view = new Function(functionSource(MAIN_F8, 'function icpCriterionView(entry)') + '\nreturn icpCriterionView;')();
    assert.deepStrictEqual(view({ criterion_id: 'x', label: 'L', field: 'fact:tech.platform', required: true, actual: 'Shopify',
      expected: 'Shopify', source: 'evidence', fact_ids: ['f003'], finding_ids: ['g1'], explanation: 'e' }).factIds, ['f003']);
  });

  test('5. no score, probability or rank anywhere in the result', () => {
    const json = JSON.stringify([contactResult, marketResult]);
    assert.ok(!/score|probab|rank|percent|confidence/i.test(json), 'contract output has no numeric rating');
    for (const row of contactResult.rows) assert.ok(['fit', 'not_fit', 'unknown'].includes(row.fitStatus));
    assert.ok(!/score|probab|rank|percent|%/i.test(F8_CODE), 'the renderer shows none either');
  });

  test('6. input is validated; a missing target is reported; leadId scopes to one lead', async () => {
    assert.throws(() => main.validateIcpPayload(null), /object required/);
    assert.throws(() => main.validateIcpPayload({}), /targetId/);
    assert.throws(() => main.validateIcpPayload({ targetId: 'x'.repeat(101) }), /targetId/);
    assert.throws(() => main.validateIcpPayload({ targetId: 't', leadId: 5 }), /leadId/);
    assert.deepStrictEqual(await evaluate({ targetId: 'no-such-target' }), { success: false, error: 'Target not found' });
    const one = await evaluate({ targetId: contactOnly.id, leadId: 'noemail' });
    assert.deepStrictEqual(one.rows.map((r) => r.leadId), ['noemail']);
    assert.strictEqual(one.total, 1);
  });

  test('7. the existing contracts are reused, not re-implemented; no LI runtime is started', () => {
    assert.ok(mainSource.includes("const { targetToIcp, evaluateIcpFit } = require('./src/main/lead-intelligence/icp/icpFit');"));
    assert.ok(mainSource.includes("const { toLeadView } = require('./src/main/lead-intelligence/contracts/leadView');"));
    assert.ok(MAIN_F8.includes('evaluateIcpFit({ view: toLeadView(lead), icp, now })'));
    assert.ok(!/fitStatus\s*=|FIT\.|not_fit'/.test(codeOnly(MAIN_F8)), 'main decides no fit itself');
    assert.ok(!/setupLeadIntelligence|createLeadIntelligence|registerLeadIntelligenceIpc|SqlJsStore|migrate\(/.test(mainSource),
      'the Lead Intelligence runtime, its IPC and its schema are not wired');
    assert.ok(!/saveDB|saveTarget|addNumbers|updateLead|INSERT|UPDATE/.test(codeOnly(MAIN_F8)), 'read-only');
  });

  test('8. the ICP channel is sender-checked and exposed read-only', () => {
    assert.ok(mainSource.includes("ipcMain.handle('intelligence:icp', listsHandler('intelligence:icp',"), 'behind the trusted-sender guard');
    assert.strictEqual((mainSource.match(/ipcMain\.handle\('intelligence:/g) || []).length, 1, 'exactly one intelligence channel');
    assert.ok(preloadSource.includes("icpFit: (payload) => ipcRenderer.invoke('intelligence:icp', payload)"));
    assert.ok(!/intelligence:(signals|opportunit)/.test(mainSource + preloadSource), 'no channel for unsupported surfaces');
  });

  // --- Signals / Opportunities ---------------------------------------------------------

  test('9. only the signals the contract supports are named, exactly as the contract names them', () => {
    const renderer = new Function(between(F8, 'const INTEL_SIGNAL_TYPES', 'let icpTargets')
      + '\nreturn { INTEL_SIGNAL_TYPES, INTEL_UNSUPPORTED_SIGNALS };')();
    assert.deepStrictEqual(renderer.INTEL_SIGNAL_TYPES.map((s) => s[0]), Object.values(SIGNAL_TYPES), 'supported list = SIGNAL_TYPES');
    assert.deepStrictEqual(renderer.INTEL_UNSUPPORTED_SIGNALS, UNSUPPORTED_SIGNALS.map((u) => [u.type, u.reason]), 'unsupported list = UNSUPPORTED_SIGNALS');
    assert.ok(!/funding|intent|buying/i.test(F8_CODE), 'no invented signal family');
    const panel = functionSource(rendererSource, 'function renderSignalsPanel()');
    assert.ok(panel.includes("'Unavailable in this build'") && panel.includes("'No signals can be shown yet'"), 'honest empty state');
    assert.ok(panel.includes('Nothing is estimated in its place.'));
  });

  test('10. opportunities: honest unavailable state, pointing to real evidence-backed findings', () => {
    const panel = functionSource(rendererSource, 'function renderOpportunitiesPanel()');
    assert.ok(panel.includes("'No opportunities are listed'"));
    assert.ok(panel.includes('Lead Intelligence has no opportunity contract that this build can run'));
    assert.ok(panel.includes("intelSwitchTab('completed')"), 'points to Research, Completed');
    assert.ok(!/estimated opportunit|opportunity score|pipeline value|revenue|deal size/i.test(F8_CODE), 'no estimate');
  });

  // --- Evidence / honest states -----------------------------------------------------------

  test('11. every criterion shows its outcome, value and source; unconverted settings are named', () => {
    const item = functionSource(rendererSource, 'function intelCriterionItem(entry, outcome)');
    for (const s of ["matched: 'Met'", "unmet: 'Not met'", "unknown: 'Unknown'", "excluded: 'Excluded'", "'lead record'", "' · Evidence: '"]) {
      assert.ok(item.includes(s), 'criterion item: ' + s);
    }
    const notes = new Function(functionSource(rendererSource, 'function intelUnmappedNotes(unmapped)') + '\nreturn intelUnmappedNotes;')();
    assert.deepStrictEqual(notes(['exclusions', 'requiredFields:fax']), [
      'Exclusions are not evaluated by the ICP contract: their meaning cannot be converted without guessing.',
      'Required field "fax" has no ICP criterion.'
    ]);
    const value = new Function(functionSource(rendererSource, 'function intelValueText(value)') + '\nreturn intelValueText;')();
    assert.strictEqual(value(null), 'not recorded', 'missing is never shown as false');
  });

  test('12. loading, empty, no-target, no-lead, filtered and unavailable states exist', () => {
    const render = functionSource(rendererSource, 'function renderIcp()');
    for (const s of ["'Evaluating ICP fit...'", "'No Targets yet'", "'No leads to evaluate'", "'No leads match these filters'", "'ICP fit could not be evaluated'"]) {
      assert.ok(render.includes(s), 'state: ' + s);
    }
    assert.ok(render.includes('the contract reports every lead as fit'), 'a criterion-less Target is explained, not hidden');
    assert.ok(functionSource(rendererSource, 'function intelErrorText(err)').includes('ICP evaluation is not available in this session.'));
    assert.ok(render.includes('`${rows.length} of ${all.length} leads · ${tally.fit} fit'), 'counts are the returned rows only');
  });

  // --- navigation / drawer ----------------------------------------------------------------

  test('13. the three Intelligence items are live routes; nothing else was enabled', () => {
    const group = between(htmlSource, '<div class="nav-group-label">Intelligence</div>', '</div>');
    for (const v of ['opportunities', 'icp', 'signals']) {
      assert.ok(new RegExp(`<button class="nav-item" data-view="${v}" type="button">`).test(group), 'live: ' + v);
      assert.ok(htmlSource.includes(`<section class="view" id="view-${v}">`));
    }
    assert.ok(!/Soon|nav-item-soon|disabled/.test(group));
    assert.strictEqual((htmlSource.match(/class="nav-item nav-item-soon"/g) || []).length, 5, 'Campaigns, Activity, Analytics and the rest stay disabled');
    // Every other Soon item keeps its disabled, route-free markup. F12 declared lock
    // update: Ready became the live Outreach workspace, so it left this list.
    const nav = between(htmlSource, '<nav class="sidebar-nav"', '</nav>');
    const soonLabels = [...nav.matchAll(/<button class="nav-item nav-item-soon" type="button" disabled aria-disabled="true"[^>]*>[\s\S]*?<span class="nav-label">([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.deepStrictEqual(soonLabels, ['New', 'Recently Viewed', 'Campaigns', 'Activity', 'Analytics']);
    const routes = [...nav.matchAll(/data-view="([a-z]+)"[^>]*>[\s\S]*?<span class="nav-label">([^<]+)<\/span>/g)].map((m) => [m[1], m[2]]);
    for (const [view, label] of [['opportunities', 'Opportunities'], ['icp', 'ICP'], ['signals', 'Signals']]) {
      assert.deepStrictEqual(routes.filter((r) => r[0] === view), [[view, label]], 'the route is on its own item: ' + label);
    }
    assert.ok(rendererSource.includes("if (viewId === 'icp') loadIcp();"));
    assert.ok(rendererSource.includes("if (viewId === 'signals') renderSignalsPanel();"));
    assert.ok(rendererSource.includes("if (viewId === 'opportunities') renderOpportunitiesPanel();"));
  });

  test('14. the F5 drawer ICP tab shows the same contract result for the open lead', () => {
    const tab = functionSource(rendererSource, 'function renderLeadDrawerIcp(lead)');
    assert.ok(tab.includes("if (typeof loadLeadDrawerIcp === 'function') loadLeadDrawerIcp(lead);"));
    const load = functionSource(rendererSource, 'async function loadLeadDrawerIcp(lead)');
    assert.ok(load.includes("filter((t) => t.status === 'active')"), 'every active Target');
    assert.ok(load.includes('window.appAPI.intelligence.icpFit({ targetId: target.id, leadId })'), 'the same channel, one lead');
    assert.ok(load.includes('const stillOpen = () => leadDrawerLeadId === leadId;') && load.includes('if (stillOpen()) box.replaceChildren(...blocks);'),
      'a late answer never lands on another lead');
    assert.ok(load.includes("'No active Target. ICP fit is evaluated against a Target, so no fit decision exists for this lead.'"));
    const open = functionSource(rendererSource, 'async function openIntelLead(leadId)');
    assert.ok(open.includes('await openLeadDetail(leadId);') && open.includes("selectLeadDrawerTab('icp', false);"), 'rows open the one drawer on ICP');
    assert.strictEqual((htmlSource.match(/id="lead-detail-overlay"/g) || []).length, 1, 'no second drawer');
  });

  // --- security ---------------------------------------------------------------------------

  test('15. security: CSP unchanged, no network, no credentials, text-only rendering', () => {
    const match = htmlSource.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
    assert.strictEqual(match[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|https?:\/\//.test(F8_CODE), 'no renderer network');
    assert.ok(!/apiKey|secret|token|credential/i.test(F8_CODE), 'no credentials');
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function/.test(F8_CODE), 'text only');
    assert.ok(!/setInterval|setTimeout/.test(F8_CODE), 'no polling');
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  });

  test('16. the F8 stylesheet follows the F1 rules and has only the three fit states', () => {
    const css = between(cssSource, 'ZTech Frontend 2.0 - F8: Intelligence workspace', 'ZTech Frontend 2.0 - F3: Leads workspace.');
    assert.ok(!/gradient|@import|url\(|outline:\s*none|box-shadow/i.test(css));
    for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) assert.ok(/^var\(--radius-(sm|md|lg)\)$/.test(m[1].trim()));
    const fits = [...css.matchAll(/\.intel-fit\[data-fit="([a-z_]+)"\]/g)].map((m) => m[1]).sort();
    assert.deepStrictEqual(fits, ['fit', 'not_fit', 'unknown']);
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(err && err.stack ? err.stack : err);
    }
  }
  fs.rmSync(testRoot, { recursive: true, force: true });
  console.log('');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
