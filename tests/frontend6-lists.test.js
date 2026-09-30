'use strict';

// Frontend 2.0 F6 — Lists: Saved Searches and Segments.
//
// A Saved Search stores a supported Leads query definition and no leads. A
// Segment is STATIC (explicit lead ids) or DYNAMIC (rules). Both are user-owned
// definitions: nothing here may create, change or remove a lead, and every
// member count must come from stored lead data through the existing query
// layer. The store is exercised for real on BOTH storage branches (sql.js and
// the JSON fallback); main's validators and the sender guard are lifted from
// main.js and executed; the renderer is pinned structurally and its pure
// helpers are executed. No jsdom, no new dependency.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

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

const F6_RENDERER = between(rendererSource, '// === F6 Lists: saved searches and segments ===', '// 初始化补充');
const F6_STORE_CLASS = between(storeSource, '  // === F6 Lists: saved searches and segments ===', '  // === P1-G Collection Quality Report ===');
const LISTS_CHANNELS = ['saved-searches:list', 'saved-searches:save', 'saved-searches:delete',
  'segments:list', 'segments:save', 'segments:members', 'segments:delete'];

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-f6-lists-'));
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };
  const loggerPath = require.resolve(path.join(root, 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };
  const { AccountStore, normalizeListQuery } = require(path.join(root, 'src', 'main', 'accountStore.js'));
  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');

  const LEADS = [
    { id: 'a', phone: '+66 2 555 0101', title: 'Alpha Cafe', website: 'https://alpha.test', email: 'hi@alpha.test',
      address: '1 Road', source: 'Maps', keyword: 'cafe', collectedAt: '2026-09-01T00:00:00.000Z' },
    { id: 'b', phone: '+66 2 555 0102', title: 'Bravo Dental', website: '', email: '',
      address: '2 Road', source: 'Maps', keyword: 'dental', collectedAt: '2026-09-02T00:00:00.000Z' },
    { id: 'c', phone: '+66 2 555 0103', title: 'Charlie Cafe', website: 'https://charlie.test', email: '',
      address: '', source: 'Import', keyword: 'cafe', collectedAt: '2026-09-03T00:00:00.000Z' },
    { id: 'd', phone: '+66 2 555 0104', title: 'Delta Spa', website: 'https://delta.test', email: 'x@delta.test',
      address: '4 Road', source: 'Maps', keyword: 'spa', collectedAt: '2026-09-04T00:00:00.000Z' }
  ];

  function reset() {
    for (const f of ['whatsapp.db', 'savedSearches.json', 'segments.json', 'numbers.json']) {
      fs.rmSync(path.join(dataDir, f), { force: true });
    }
  }

  async function sqlStore() {
    reset();
    const store = new AccountStore();
    await store.ready;
    assert.ok(store.db, 'sql branch');
    await store.addNumbers(LEADS.map((l) => ({ ...l })));
    return store;
  }

  // The JSON fallback branch, fed the same lead rows.
  async function jsonStore() {
    reset();
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    store._numbers = [];
    store._savedSearches = [];
    store._segments = [];
    await store.addNumbers(LEADS.map((l) => ({ ...l })));
    return store;
  }

  async function both(fn) {
    for (const [label, open] of [['sql', sqlStore], ['json', jsonStore]]) {
      try {
        await fn(await open(), label);
      } catch (err) {
        err.message = `[${label}] ${err.message}`;
        throw err;
      }
    }
  }

  async function leadSnapshot(store) {
    const res = await store.queryNumbers({ limit: 100 });
    return JSON.stringify(res.rows.map((r) => [r.id, r.phone, r.title, r.qualification, r.status]).sort());
  }

  const ids = (res) => res.rows.map((r) => r.id).sort();

  // --- Saved Searches (1-10) ---------------------------------------------------

  test('1. a saved search is created from a supported query definition', async () => {
    await both(async (store) => {
      const before = await leadSnapshot(store);
      const res = await store.saveSavedSearch({
        name: '  Cafes with a website ', description: 'Bangkok cafes',
        query: { search: 'cafe', filters: { websiteQuality: 'valid' }, sort: 'title', order: 'desc' }
      });
      assert.strictEqual(res.success, true);
      assert.strictEqual(res.created, true);
      assert.ok(typeof res.id === 'string' && res.id);
      const list = await store.listSavedSearches();
      assert.strictEqual(list.total, 1);
      assert.strictEqual(list.rows[0].name, 'Cafes with a website', 'name trimmed');
      assert.ok(list.rows[0].createdAt && list.rows[0].updatedAt);
      assert.strictEqual(await leadSnapshot(store), before, 'no lead changed');
    });
  });

  test('2. saved searches persist across a store reopen (sql and json)', async () => {
    const store = await sqlStore();
    await store.saveSavedSearch({ name: 'Persisted', query: { filters: { status: 'pending' } } });
    const reopened = new AccountStore();
    await reopened.ready;
    const list = await reopened.listSavedSearches();
    assert.deepStrictEqual(list.rows.map((r) => r.name), ['Persisted'], 'sql row survives');
    const json = await jsonStore();
    await json.saveSavedSearch({ name: 'Json persisted', query: {} });
    const file = JSON.parse(fs.readFileSync(path.join(dataDir, 'savedSearches.json'), 'utf8'));
    assert.strictEqual(file[0].name, 'Json persisted', 'json file written');
    const reloaded = new AccountStore();
    await reloaded.ready;
    reloaded.db = null;
    reloaded.fallbackToJson();
    assert.strictEqual((await reloaded.listSavedSearches()).rows[0].name, 'Json persisted', 'json reload');
  });

  test('3. list returns every saved search in creation order', async () => {
    await both(async (store) => {
      for (const name of ['One', 'Two', 'Three']) await store.saveSavedSearch({ name, query: {} });
      assert.deepStrictEqual((await store.listSavedSearches()).rows.map((r) => r.name), ['One', 'Two', 'Three']);
    });
  });

  test('4. rename changes the name only; the definition is untouched', async () => {
    await both(async (store) => {
      const { id } = await store.saveSavedSearch({ name: 'Old', query: { search: 'spa', sort: 'phone', order: 'asc' } });
      const before = (await store.listSavedSearches()).rows[0];
      const res = await store.saveSavedSearch({ id, name: 'New name' });
      assert.strictEqual(res.updated, true);
      const after = (await store.listSavedSearches()).rows[0];
      assert.strictEqual(after.name, 'New name');
      assert.deepStrictEqual(after.query, before.query, 'definition preserved');
      assert.strictEqual(after.createdAt, before.createdAt, 'createdAt preserved');
      assert.strictEqual((await store.listSavedSearches()).total, 1, 'no second record');
    });
  });

  test('5. update replaces the definition', async () => {
    await both(async (store) => {
      const { id } = await store.saveSavedSearch({ name: 'S', query: { search: 'spa' } });
      await store.saveSavedSearch({ id, query: { filters: { qualification: 'qualified', completeness: '5' } } });
      const row = (await store.listSavedSearches()).rows[0];
      assert.deepStrictEqual(row.query, { search: '', filters: { qualification: 'qualified', completeness: '5' }, sort: '', order: 'asc' });
      const missing = await store.saveSavedSearch({ id: 'no-such-id', name: 'x' });
      assert.deepStrictEqual(missing, { success: false, error: 'Saved search not found' }, 'an unknown id never creates');
    });
  });

  test('6. duplicate stores an independent copy of the definition', async () => {
    await both(async (store) => {
      const { id } = await store.saveSavedSearch({ name: 'Base', query: { search: 'cafe', sort: 'title', order: 'desc' } });
      const base = (await store.listSavedSearches()).rows[0];
      const copy = await store.saveSavedSearch({ name: 'Base (copy)', description: base.description, query: base.query });
      assert.notStrictEqual(copy.id, id);
      await store.saveSavedSearch({ id, query: { search: 'spa' } });
      const rows = (await store.listSavedSearches()).rows;
      assert.deepStrictEqual(rows[1].query, { search: 'cafe', filters: {}, sort: 'title', order: 'desc' }, 'copy unaffected');
    });
    const dup = functionSource(rendererSource, 'async function duplicateSavedSearch(row)');
    assert.ok(dup.includes('name: copyName(row.name), description: row.description, query: row.query'), 'renderer copies the stored definition');
    assert.ok(!/\bid:/.test(dup), 'and creates a new record (no id)');
  });

  test('7. delete removes the record, reports a missing one, and leaves leads alone', async () => {
    await both(async (store) => {
      const before = await leadSnapshot(store);
      const { id } = await store.saveSavedSearch({ name: 'Doomed', query: {} });
      assert.deepStrictEqual(await store.deleteSavedSearch({ id }), { success: true, deleted: true, id });
      assert.strictEqual((await store.listSavedSearches()).total, 0);
      assert.deepStrictEqual(await store.deleteSavedSearch({ id }), { success: true, deleted: false, reason: 'not-found' });
      assert.strictEqual((await store.deleteSavedSearch({ id: '' })).success, false);
      assert.strictEqual(await leadSnapshot(store), before);
    });
  });

  test('8. running a saved search evaluates it against the current library', async () => {
    await both(async (store) => {
      await store.saveSavedSearch({ name: 'Cafes', query: { search: 'cafe', sort: 'title', order: 'desc' } });
      const saved = (await store.listSavedSearches()).rows[0];
      const run = async () => store.queryNumbers({ limit: 50, search: saved.query.search, sort: saved.query.sort, order: saved.query.order });
      assert.deepStrictEqual((await run()).rows.map((r) => r.id), ['c', 'a'], 'current rows, saved sort');
      await store.addNumbers([{ id: 'e', phone: '+66 2 555 0105', title: 'Echo Cafe', keyword: 'cafe' }]);
      assert.deepStrictEqual((await run()).rows.map((r) => r.id), ['e', 'c', 'a'], 're-evaluated, no snapshot');
    });
    const runFn = functionSource(rendererSource, 'function runSavedSearch(row)');
    assert.ok(runFn.includes('applyDefinitionToLeads(row.query)'), 'the saved definition drives the real controls');
    assert.ok(runFn.includes("openLeadsWithContext({ kind: 'search'"), 'and opens the existing Leads view');
  });

  test('9. the query, filters, sort and order round-trip exactly', async () => {
    await both(async (store) => {
      const query = {
        search: 'road',
        filters: { status: 'pending', qualification: 'unqualified', phoneQuality: 'valid', emailQuality: 'unknown',
          websiteQuality: 'invalid', businessQuality: 'unknown', completeness: '3' },
        sort: 'collectedAt', order: 'desc'
      };
      await store.saveSavedSearch({ name: 'All filters', query });
      assert.deepStrictEqual((await store.listSavedSearches()).rows[0].query, query);
    });
  });

  test('10. unsupported filters, values, sorts and keys are refused, not dropped', async () => {
    await both(async (store) => {
      const bad = [
        { filters: { researchStatus: 'complete' } },
        { filters: { icpFit: 'fit' } },
        { filters: { source: 'Maps' } },
        { filters: { status: 'archived' } },
        { filters: { completeness: '6' } },
        { sort: 'score' },
        { sort: 'constructor' },
        { order: 'sideways', sort: 'title' },
        { limit: 5 }
      ];
      for (const query of bad) {
        const res = await store.saveSavedSearch({ name: 'x', query });
        assert.strictEqual(res.success, false, 'refused: ' + JSON.stringify(query));
        assert.ok(/Invalid saved search: query/.test(res.error), res.error);
      }
      assert.strictEqual((await store.saveSavedSearch({ name: '   ', query: {} })).success, false, 'blank name refused');
      assert.strictEqual((await store.listSavedSearches()).total, 0, 'nothing stored');
    });
    // main refuses the same payloads before the store (single validator).
    assert.ok(mainSource.includes("const { AccountStore, normalizeListQuery } = require('./src/main/accountStore');"));
    assert.strictEqual(normalizeListQuery({ filters: { researchStatus: 'x' } }, { allowSort: true }).ok, false);
  });

  // --- Segments (11-20) --------------------------------------------------------

  test('11. a static segment is created empty or from existing leads only', async () => {
    await both(async (store) => {
      const empty = await store.saveSegment({ name: 'Empty', type: 'static' });
      assert.strictEqual(empty.success, true);
      const seeded = await store.saveSegment({ name: 'Seeded', type: 'static', memberIds: ['a', 'b', 'a'] });
      assert.strictEqual(seeded.success, true);
      const unknown = await store.saveSegment({ name: 'Ghost', type: 'static', memberIds: ['a', 'zzz'] });
      assert.strictEqual(unknown.success, false, 'a non-lead id is refused');
      const rows = (await store.listSegments()).rows;
      assert.deepStrictEqual(rows.map((r) => [r.name, r.type, r.memberIds, r.memberCount]),
        [['Empty', 'static', [], 0], ['Seeded', 'static', ['a', 'b'], 2]], 'duplicates collapsed');
      assert.strictEqual((await store.saveSegment({ name: 'x', type: 'static', rules: {} })).success, false, 'no rules on static');
    });
  });

  test('12. members are added to a static segment (existing leads only, no duplicates)', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a'] });
      const res = await store.updateSegmentMembers({ id, add: ['a', 'c', 'd'] });
      assert.deepStrictEqual([res.success, res.added, res.removed, res.memberCount], [true, 2, 0, 3]);
      assert.strictEqual((await store.updateSegmentMembers({ id, add: ['nope'] })).success, false);
      const again = await store.updateSegmentMembers({ id, add: ['a'] });
      assert.strictEqual(again.reason, 'unchanged');
      assert.deepStrictEqual((await store.listSegments()).rows[0].memberIds, ['a', 'c', 'd']);
    });
  });

  test('13. members are removed from a static segment; the leads themselves remain', async () => {
    await both(async (store) => {
      const before = await leadSnapshot(store);
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a', 'b', 'c'] });
      const res = await store.updateSegmentMembers({ id, remove: ['b'] });
      assert.deepStrictEqual([res.added, res.removed, res.memberCount], [0, 1, 2]);
      assert.deepStrictEqual((await store.listSegments()).rows[0].memberIds, ['a', 'c']);
      assert.strictEqual(await leadSnapshot(store), before, 'removing a member never deletes a lead');
    });
  });

  test('14. a deleted lead stays in a static segment as an unavailable member', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a', 'b', 'c'] });
      await store.deleteNumbers(['b']);
      const seg = (await store.listSegments()).rows[0];
      assert.deepStrictEqual(seg.memberIds, ['a', 'b', 'c'], 'the id is not silently dropped');
      assert.deepStrictEqual([seg.memberCount, seg.availableCount, seg.unavailableIds], [3, 2, ['b']]);
      const inLeads = await store.queryNumbers({ limit: 50, segmentId: id });
      assert.deepStrictEqual(ids(inLeads), ['a', 'c'], 'Leads shows only stored members');
      assert.strictEqual(inLeads.total, 2);
      await store.updateSegmentMembers({ id, remove: ['b'] });
      assert.deepStrictEqual((await store.listSegments()).rows[0].unavailableIds, [], 'removed only by an explicit action');
    });
    const cell = functionSource(rendererSource, 'function segmentMembersCell(row)');
    assert.ok(cell.includes('unavailable (lead deleted)'), 'the UI names unavailable members');
    assert.ok(cell.includes("listsButton('Remove unavailable'"), 'and offers an explicit removal');
  });

  test('15. a dynamic segment stores only supported rules', async () => {
    await both(async (store) => {
      const res = await store.saveSegment({
        name: 'Maps cafes', type: 'dynamic',
        rules: { search: 'cafe', filters: { source: ' Maps ', websiteQuality: 'valid' } }
      });
      assert.strictEqual(res.success, true);
      const seg = (await store.listSegments()).rows[0];
      assert.deepStrictEqual(seg.rules, { search: 'cafe', filters: { source: 'Maps', websiteQuality: 'valid' } });
      assert.deepStrictEqual(seg.memberIds, []);
      for (const rules of [{ filters: { icp: 'fit' } }, { sort: 'title' }, { filters: { status: 'nope' } }]) {
        assert.strictEqual((await store.saveSegment({ name: 'x', type: 'dynamic', rules })).success, false, JSON.stringify(rules));
      }
      assert.strictEqual((await store.saveSegment({ name: 'x', type: 'dynamic', memberIds: ['a'] })).success, false, 'no members on dynamic');
      assert.strictEqual((await store.saveSegment({ name: 'x', type: 'smart' })).success, false, 'unknown type');
    });
  });

  test('16. dynamic membership is evaluated from current lead data', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'Qualified', type: 'dynamic', rules: { filters: { qualification: 'qualified' } } });
      assert.deepStrictEqual(ids(await store.queryNumbers({ limit: 50, segmentId: id })), []);
      await store.setLeadUserFields({ id: 'c', qualification: 'qualified', tags: [], notes: '' });
      await store.setLeadUserFields({ id: 'a', qualification: 'qualified', tags: [], notes: '' });
      assert.deepStrictEqual(ids(await store.queryNumbers({ limit: 50, segmentId: id })), ['a', 'c'], 'lead edits change membership');
      const quality = await store.saveSegment({ name: 'No email', type: 'dynamic', rules: { filters: { emailQuality: 'unknown', keyword: 'cafe' } } });
      assert.deepStrictEqual(ids(await store.queryNumbers({ limit: 50, segmentId: quality.id })), ['c'], 'derived + exact rules');
    });
  });

  test('17. member counts come from stored data', async () => {
    await both(async (store) => {
      await store.saveSegment({ name: 'Static', type: 'static', memberIds: ['a', 'd'] });
      await store.saveSegment({ name: 'Maps', type: 'dynamic', rules: { filters: { source: 'Maps' } } });
      const counts = (await store.listSegments()).rows.map((r) => [r.name, r.memberCount, r.availableCount]);
      assert.deepStrictEqual(counts, [['Static', 2, 2], ['Maps', 3, 3]]);
      const maps = await store.queryNumbers({ limit: 1, filters: { source: 'Maps' } });
      assert.strictEqual(maps.total, 3, 'the dynamic count equals the Leads query total');
    });
  });

  test('18. rules and names update; the type is fixed after creation', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'D', type: 'dynamic', rules: { filters: { keyword: 'cafe' } } });
      await store.saveSegment({ id, rules: { filters: { keyword: 'spa' } } });
      assert.deepStrictEqual(ids(await store.queryNumbers({ limit: 50, segmentId: id })), ['d']);
      await store.saveSegment({ id, name: 'Renamed' });
      const seg = (await store.listSegments()).rows[0];
      assert.deepStrictEqual([seg.name, seg.rules.filters.keyword], ['Renamed', 'spa'], 'rename keeps rules');
      assert.strictEqual((await store.saveSegment({ id, type: 'static' })).success, false, 'type cannot change');
      const st = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a'] });
      assert.strictEqual((await store.saveSegment({ id: st.id, memberIds: ['b'] })).success, false, 'members only via the members update');
      assert.strictEqual((await store.updateSegmentMembers({ id, add: ['a'] })).success, false, 'a dynamic segment has no explicit members');
    });
  });

  test('19. deleting a segment removes the definition only', async () => {
    await both(async (store) => {
      const before = await leadSnapshot(store);
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a', 'b'] });
      assert.deepStrictEqual(await store.deleteSegment({ id }), { success: true, deleted: true, id });
      assert.strictEqual((await store.listSegments()).total, 0);
      assert.deepStrictEqual(await store.queryNumbers({ limit: 5, segmentId: id }), { rows: [], total: 0, limit: 5, offset: 0 },
        'a deleted segment scopes to nothing');
      assert.strictEqual(await leadSnapshot(store), before);
    });
  });

  test('20. a segment opens in Leads through the existing query with segmentId', async () => {
    const payload = functionSource(rendererSource, 'function numbersQueryPayload() {');
    assert.ok(payload.includes("document.getElementById('leads-scope').dataset.segmentId"), 'the scope id is read at query time');
    assert.ok(payload.includes('if (scopeSegmentId) query.segmentId = scopeSegmentId;'), 'and added to the existing payload');
    const open = functionSource(rendererSource, 'function openSegmentInLeads(row)');
    assert.ok(open.includes("openLeadsWithContext({ kind: 'segment', id: row.id"), 'opens the existing Leads view');
    const ctx = functionSource(rendererSource, 'function openLeadsWithContext(context)');
    assert.ok(ctx.includes("dataset.segmentId = context && context.kind === 'segment' ? context.id : ''"));
    assert.ok(ctx.includes("activateView('numbers')") && ctx.includes('loadNumbers()'), 'same view, same loader');
    // main accepts the additive field and refuses a malformed one.
    const validator = functionSource(mainSource, 'function validateNumbersQuery(payload) {');
    assert.ok(validator.includes("assertOptionalString(p.segmentId, 'segmentId', 100);"));
    assert.ok(validator.includes('out.segmentId = p.segmentId;'));
    await both(async (store) => {
      assert.deepStrictEqual(await store.queryNumbers({ limit: 5, segmentId: 12 }), { rows: [], total: 0, limit: 5, offset: 0 });
      assert.deepStrictEqual(await store.queryNumbers({ limit: 5, segmentId: 'x'.repeat(101) }), { rows: [], total: 0, limit: 5, offset: 0 });
    });
  });

  // --- Integration (21-26) -----------------------------------------------------

  test('21. saved search -> Leads sets the existing controls and sort', () => {
    const apply = functionSource(rendererSource, 'function applyDefinitionToLeads(definition)');
    // Execute it against minimal doubles of the real controls.
    const controls = {};
    const opts = (vals) => vals.map((value) => ({ value }));
    const optionSets = {
      'number-filter-status': ['all', 'pending', 'sent', 'success', 'failed'],
      'number-filter-qualification': ['all', 'unqualified', 'qualified'],
      'number-filter-phone-quality': ['all', 'valid', 'invalid', 'unknown'],
      'number-filter-email-quality': ['all', 'valid', 'invalid', 'unknown'],
      'number-filter-website-quality': ['all', 'valid', 'invalid', 'unknown'],
      'number-filter-business-quality': ['all', 'active', 'closed', 'unknown'],
      'number-filter-completeness': ['all', '0', '1', '2', '3', '4', '5']
    };
    for (const [id, vals] of Object.entries(optionSets)) controls[id] = { value: 'all', options: opts(vals) };
    controls['number-search'] = { value: 'old' };
    const defs = between(rendererSource, 'const LEADS_FILTER_DEFS = [', '];') + '];';
    const run = new Function('document', 'NUMBERS_SORTABLE_KEYS',
      'let numbersSort = ""; let numbersOrder = "asc";\n' + defs.replace('const LEADS_FILTER_DEFS = [', 'const LEADS_FILTER_DEFS = [') + '\n' + apply +
      '\nreturn (d) => ({ unsupported: applyDefinitionToLeads(d), sort: numbersSort, order: numbersOrder });');
    const applyFn = run({ getElementById: (id) => controls[id] }, ['title', 'phone', 'source', 'keyword', 'collectedAt']);
    const result = applyFn({ search: 'cafe', filters: { status: 'sent', completeness: '4', websiteQuality: 'valid' }, sort: 'title', order: 'desc' });
    assert.strictEqual(controls['number-search'].value, 'cafe');
    assert.strictEqual(controls['number-filter-status'].value, 'sent');
    assert.strictEqual(controls['number-filter-completeness'].value, '4');
    assert.strictEqual(controls['number-filter-qualification'].value, 'all', 'unset filters return to All');
    assert.deepStrictEqual([result.sort, result.order, result.unsupported], ['title', 'desc', []]);
    const odd = applyFn({ filters: { status: 'archived' }, sort: 'score' });
    assert.deepStrictEqual(odd.unsupported, ['Status'], 'a value the control lacks is reported');
    assert.deepStrictEqual([odd.sort, odd.order], ['', 'asc'], 'an unknown sort is never applied');
  });

  test('22. segment -> Leads keeps search, filters, sort and paging working inside the segment', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a', 'b', 'c', 'd'] });
      const cafes = await store.queryNumbers({ limit: 50, segmentId: id, search: 'cafe' });
      assert.deepStrictEqual(ids(cafes), ['a', 'c'], 'search narrows inside the segment');
      const maps = await store.queryNumbers({ limit: 50, segmentId: id, filters: { source: 'Maps', websiteQuality: 'valid' } });
      assert.deepStrictEqual(ids(maps), ['a', 'd'], 'stored and derived filters narrow inside the segment');
      const sorted = await store.queryNumbers({ limit: 50, segmentId: id, sort: 'title', order: 'desc' });
      assert.deepStrictEqual(sorted.rows.map((r) => r.id), ['d', 'c', 'b', 'a'], 'sort preserved');
    });
  });

  test('23. the F5 drawer still opens from a list-scoped Leads view', () => {
    const handler = between(rendererSource, "document.getElementById('numbers-table-body').addEventListener('click'",
      "document.getElementById('btn-close-lead-detail').addEventListener");
    assert.ok(handler.includes('await openLeadDetail(leadId)'), 'row click still opens the drawer');
    const open = between(rendererSource, 'async function openLeadDetail', '// --- Zuni-SEO website research (A7)');
    assert.ok(open.includes('getNumbers({ limit: 1, offset: 0, id })'), 'the single-lead read is not segment-scoped');
    assert.ok(!/segmentId/.test(open), 'the drawer never depends on the list scope');
    assert.ok(!/openLeadDetail|lead-detail-overlay|showLeadDrawer/.test(codeOnly(F6_RENDERER)), 'F6 does not touch the drawer');
  });

  test('24. pagination totals and offsets stay correct inside a segment', async () => {
    await both(async (store) => {
      const { id } = await store.saveSegment({ name: 'S', type: 'static', memberIds: ['a', 'b', 'c', 'd'] });
      const page1 = await store.queryNumbers({ limit: 3, offset: 0, segmentId: id, sort: 'phone' });
      const page2 = await store.queryNumbers({ limit: 3, offset: 3, segmentId: id, sort: 'phone' });
      assert.deepStrictEqual([page1.total, page1.rows.length, page2.total, page2.rows.length], [4, 3, 4, 1]);
      assert.deepStrictEqual(page1.rows.concat(page2.rows).map((r) => r.id), ['a', 'b', 'c', 'd']);
      const plain = await store.queryNumbers({ limit: 2, offset: 0 });
      assert.deepStrictEqual([plain.total, plain.rows.length], [4, 2], 'the unscoped query is unchanged');
    });
    const render = functionSource(rendererSource, 'async function renderNumbers() {');
    assert.ok(render.includes('window.appAPI.collector.getNumbers(numbersQueryPayload())'), 'the one Leads fetch path');
    assert.strictEqual((rendererSource.match(/<table class="data-table leads-table"/g) || []).length, 0, 'no second Leads table built in JS');
    assert.strictEqual((htmlSource.match(/class="data-table leads-table"/g) || []).length, 1, 'one Leads table');
  });

  test('25. no fake data: counts are the stored values, no sample records', () => {
    const code = codeOnly(F6_RENDERER);
    assert.ok(!/Math\.random|lorem|Acme|John Doe|sample|mock|demo/i.test(code), 'no invented values');
    assert.ok(!/\bscore\b|percentile|probability|rating/i.test(code), 'no scoring vocabulary');
    const members = functionSource(rendererSource, 'function segmentMembersCell(row)');
    assert.ok(members.includes('row.memberCount') && members.includes('row.availableCount'), 'counts read from the store result');
    const preview = functionSource(rendererSource, 'function scheduleSegmentPreview()');
    assert.ok(preview.includes('window.appAPI.collector.getNumbers(query)'), 'the rule preview is a real query');
    assert.ok(preview.includes('result.total'), 'and shows its real total');
    // No counts on the sidebar at all.
    const nav = between(htmlSource, '<div class="nav-group-label">Lists</div>', '</div>');
    assert.ok(!/\d/.test(nav.replace(/<svg[\s\S]*?<\/svg>/g, '')), 'no count in the Lists nav');
  });

  test('26. security: CSP, sender check on every Lists channel, preload boundary, no markup injection', async () => {
    const match = htmlSource.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
    assert.strictEqual(match[1], "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    for (const ch of LISTS_CHANNELS) {
      assert.strictEqual((mainSource.match(new RegExp(`ipcMain\\.handle\\('${ch}', listsHandler\\('${ch}'`, 'g')) || []).length, 1,
        'registered once, behind the sender guard: ' + ch);
      assert.strictEqual((preloadSource.match(new RegExp(`ipcRenderer\\.invoke\\('${ch}'`, 'g')) || []).length, 1, 'preload: ' + ch);
    }
    // Execute the guard: an untrusted sender never reaches the store.
    const guardSrc = between(mainSource, '  function isListsSender(event) {', "  ipcMain.handle('saved-searches:list'");
    let trusted = false;
    const calls = [];
    const make = new Function('createTrustedSender', 'mainWindow', 'isDev', 'path', 'logger', 'rejectLog', '__dirname',
      'let listsTrustedSender = null;\n' + guardSrc + '\nreturn listsHandler;');
    const listsHandler = make(() => () => trusted, null, false, path, { warn() {} }, (c, m) => calls.push([c, m]), root);
    const handler = listsHandler('segments:list', async () => 'store-called');
    await assert.rejects(handler({ senderFrame: {} }), /Untrusted sender/);
    assert.deepStrictEqual(calls, [['segments:list', 'untrusted sender']]);
    trusted = true;
    assert.strictEqual(await handler({ senderFrame: {} }), 'store-called');
    // Execute main's validators.
    const validators = between(mainSource, '// === F6 Lists: saved searches and segments ===', '// === B4 local collection-job ledger hooks ===');
    const helpers = ['invalidParams', 'assertPlainObject', 'assertOptionalString'].map((n) => functionSource(mainSource, `function ${n}(`)).join('\n');
    const v = new Function('normalizeListQuery', helpers + '\n' + validators +
      '\nreturn { validateSavedSearchPayload, validateSegmentPayload, validateSegmentMembersPayload, validateListDeletePayload };')(normalizeListQuery);
    assert.throws(() => v.validateSavedSearchPayload({ name: 'x', query: { filters: { icpFit: 'fit' } } }), /unsupported filter/);
    assert.throws(() => v.validateSavedSearchPayload({ query: {} }), /name/);
    assert.throws(() => v.validateSegmentPayload({ name: 'x' }), /type/);
    assert.throws(() => v.validateSegmentMembersPayload({ id: 'x', add: [''] }), /add\[0\]/);
    assert.throws(() => v.validateSegmentMembersPayload({ id: 'x', add: ['y'.repeat(101)] }), /add\[0\]/);
    assert.throws(() => v.validateSegmentMembersPayload({ id: 'x' }), /add or remove/);
    assert.throws(() => v.validateListDeletePayload(['x'], 'segment'), /object required/);
    assert.deepStrictEqual(v.validateSegmentMembersPayload({ id: 's', remove: ['a'] }), { id: 's', remove: ['a'] });
    // Renderer: text only, no forms, no network.
    const code = codeOnly(F6_RENDERER);
    assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(code), 'no markup insertion in F6');
    assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|https?:\/\//.test(code), 'no network');
    assert.ok(!/<form/i.test(htmlSource), 'still no form element');
    assert.ok(!/eval\(|new Function/.test(code));
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'], 'no dependency added');
  });

  // --- Extra coverage -----------------------------------------------------------

  test('27. the migration is additive and idempotent on an existing database', async () => {
    reset();
    const SQL = await require('sql.js')();
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE numbers (id TEXT PRIMARY KEY, phone TEXT, source TEXT, keyword TEXT, status TEXT DEFAULT 'pending', collectedAt TEXT)`);
    legacy.run("INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES ('old', '+66 2 555 0999', 'Maps', 'x', 'pending', '2025-01-01')");
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    const first = new AccountStore();
    await first.ready;
    const tables = first.db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")[0].values.map((r) => r[0]).sort();
    assert.ok(tables.includes('saved_searches') && tables.includes('segments'), 'tables added');
    assert.strictEqual((await first.queryNumbers({ limit: 5 })).rows[0].id, 'old', 'existing lead preserved');
    await first.saveSegment({ name: 'Keep', type: 'static', memberIds: ['old'] });
    const second = new AccountStore();
    await second.ready;
    assert.strictEqual((await second.listSegments()).rows[0].name, 'Keep', 'a second open changes nothing');
    const cols = second.db.exec('PRAGMA table_info(segments)')[0].values.map((r) => r[1]);
    assert.deepStrictEqual(cols, ['id', 'name', 'description', 'type', 'memberIds', 'rules', 'createdAt', 'updatedAt']);
    assert.ok(!/REFERENCES|FOREIGN KEY/i.test(between(storeSource, 'CREATE TABLE IF NOT EXISTS segments (', ')`);')), 'no foreign key');
  });

  test('28. a stored definition that no longer validates is reported, not run as "all leads"', async () => {
    const store = await sqlStore();
    store.db.run("INSERT INTO saved_searches (id, name, description, query, createdAt, updatedAt) VALUES ('bad', 'Old', '', '{\"filters\":{\"icp\":\"fit\"}}', '', '')");
    const row = (await store.listSavedSearches()).rows[0];
    assert.ok(/unsupported filter/.test(row.definitionError), row.definitionError);
    const render = functionSource(rendererSource, 'function renderSavedSearches()');
    assert.ok(render.includes('run.disabled = Boolean(row.definitionError)'), 'Run is disabled for it');
  });

  test('29. the sidebar Lists items are live routes; every other Soon item is unchanged', () => {
    const lists = between(htmlSource, '<div class="nav-group-label">Lists</div>', '</div>');
    assert.ok(/<button class="nav-item" data-view="searches" type="button">/.test(lists));
    assert.ok(/<button class="nav-item" data-view="segments" type="button">/.test(lists));
    assert.ok(!/Soon|nav-item-soon|disabled/.test(lists), 'no Soon treatment on the two Lists items');
    // F7 declared lock update: the two Research items went live in F7.
    // F8 declared lock update: the three Intelligence items went live in F8.
    assert.strictEqual((htmlSource.match(/class="nav-item nav-item-soon"/g) || []).length, 5, 'the other five Soon items remain (F12 enabled the Outreach workspace)');
    for (const id of ['view-searches', 'view-segments']) assert.ok(htmlSource.includes(`<section class="view" id="${id}">`));
    assert.ok(rendererSource.includes("if (viewId === 'searches') loadSavedSearches();"));
    assert.ok(rendererSource.includes("if (viewId === 'segments') loadSegments();"));
    assert.ok(/searches: 'Saved Searches'/.test(rendererSource) && /segments: 'Lists'/.test(rendererSource), 'known views');
  });

  test('30. Leads selection creates or extends a static segment through the real channels', () => {
    const submit = functionSource(rendererSource, 'async function submitAddToSegmentDialog()');
    assert.ok(submit.includes("saveSegment({ name, type: 'static', memberIds: state.ids })"), 'new static segment from the selection');
    assert.ok(submit.includes('updateSegmentMembers({ id: select.value, add: state.ids })'), 'or added to an existing one');
    const open = functionSource(rendererSource, 'async function openAddToSegmentDialog()');
    assert.ok(open.includes('selectedLeadIds()'), 'acts on the real selection');
    assert.ok(open.includes("row.type === 'static'"), 'only static segments take explicit members');
    const remove = functionSource(rendererSource, 'async function removeSelectionFromSegment()');
    assert.ok(remove.includes("context.type !== 'static'") && remove.includes('remove: ids'), 'remove only inside a static segment');
  });

  test('31. the renderer helpers compare and summarise definitions exactly', () => {
    const eq = functionSource(rendererSource, 'function definitionsEqual(a, b, withSort)');
    const copy = functionSource(rendererSource, 'function copyName(name)');
    const sort = functionSource(rendererSource, 'function sortSummary(definition)');
    const api = new Function('LIST_NAME_MAX', 'LIST_SORT_LABELS', eq + copy + sort +
      '\nreturn { definitionsEqual, copyName, sortSummary };')(120, { title: 'Lead', collectedAt: 'Collected' });
    assert.ok(api.definitionsEqual({ search: 'a', filters: { status: 'sent' }, sort: '' }, { search: 'a', filters: { status: 'sent' }, sort: '', order: 'desc' }, true));
    assert.ok(!api.definitionsEqual({ search: 'a', filters: {} }, { search: 'a', filters: { status: 'sent' } }, false));
    assert.ok(!api.definitionsEqual({ sort: 'title', order: 'asc' }, { sort: 'title', order: 'desc' }, true));
    assert.strictEqual(api.copyName('x'.repeat(120)).length, 120, 'a copy name stays within the limit');
    assert.strictEqual(api.sortSummary({ sort: 'title', order: 'desc' }), 'Lead descending');
    assert.strictEqual(api.sortSummary({}), 'Default (newest first)');
  });

  test('32. the Lists stylesheet follows the F1 rules and the store logs no list content', () => {
    const f6css = between(cssSource, 'ZTech Frontend 2.0 - F6: Lists', 'ZTech Frontend 2.0 - F3: Leads workspace.');
    assert.ok(!/gradient|@import|url\(/i.test(f6css));
    assert.ok(!/outline:\s*none/.test(f6css));
    for (const m of f6css.matchAll(/border-radius:\s*([^;]+);/g)) {
      assert.ok(/^var\(--radius-(sm|md|lg)\)$/.test(m[1].trim()), 'radius token: ' + m[1]);
    }
    const logs = [...F6_STORE_CLASS.matchAll(/logger\.info\([^;]*;/g)].map((m) => m[0]);
    assert.ok(logs.length >= 2);
    for (const line of logs) assert.ok(!/name|description|search|memberIds|rules/.test(line), 'identifiers only: ' + line);
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
