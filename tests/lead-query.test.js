'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b2-query-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const root = path.join(__dirname, '..');
  const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
  const storeSource = fs.readFileSync(accountStorePath, 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  const { AccountStore } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // Insertion order defines rowid order (q1 = oldest = rowid 1).
  // Includes: NULL source, empty source, mixed ASCII case, Thai text,
  // LIKE wildcards (% _), an ampersand, and duplicate sort keys for
  // tie-break verification. runSlug carries 'run-' strings that free-text
  // search must never match (runSlug is excluded from the search fields).
  const FIXTURE = [
    {
      id: 'q1', phone: '+66811111111', source: 'Bangkok Cafe', keyword: 'cafe',
      status: 'pending', collectedAt: '2026-01-01T00:00:00.000Z',
      title: 'Cafe Aroma', website: 'https://aroma.example', email: 'aroma@example.com',
      address: '1 Sukhumvit', runSlug: 'run-1'
    },
    {
      id: 'q2', phone: '+66822222222', source: '手动导入', keyword: '100%_pure',
      status: 'pending', collectedAt: '2026-01-02T00:00:00.000Z',
      title: 'PURE BAR', website: '', email: '', address: '', runSlug: ''
    },
    {
      id: 'q3', phone: '+66833333333', source: null, keyword: 'cafe',
      status: 'pending', collectedAt: '2026-01-03T00:00:00.000Z',
      title: 'cafe nite', website: 'https://nite.example', email: 'nite@example.com',
      address: '2 Asoke', runSlug: 'run-3'
    },
    {
      id: 'q4', phone: '+66844444444', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-01-04T00:00:00.000Z',
      title: 'ร้านอาหารไทย', website: '', email: '', address: '', runSlug: ''
    },
    {
      id: 'q5', phone: '+66855555555', source: 'Bangkok Cafe', keyword: 'cafe',
      status: 'pending', collectedAt: '2026-01-05T00:00:00.000Z',
      title: 'Cafe Aroma', website: '', email: '', address: '', runSlug: 'run-5'
    },
    {
      id: 'q6', phone: '+66866666666', source: 'Night Market', keyword: 'market',
      status: 'pending', collectedAt: '2026-01-06T00:00:00.000Z',
      title: 'night market stall', website: 'https://market.example', email: 'm@example.com',
      address: '9 Chatuchak', runSlug: ''
    },
    {
      id: 'q7', phone: '+66877777777', source: '', keyword: 'keyword with space',
      status: 'pending', collectedAt: '2026-01-07T00:00:00.000Z',
      title: 'SPA & Massage', website: '', email: '', address: '', runSlug: ''
    },
    {
      id: 'q8', phone: '+66888888888', source: '手动导入', keyword: 'cafe',
      status: 'pending', collectedAt: '2026-01-08T00:00:00.000Z',
      title: '', website: '', email: '', address: '', runSlug: ''
    }
  ];

  const INSERT_SQL =
    'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  function idsOf(result) {
    return result.rows.map((r) => r.id);
  }

  function assertEnvelope(result, limit, offset) {
    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['limit', 'offset', 'rows', 'total'],
      'response envelope must be exactly {rows,total,limit,offset}'
    );
    assert.ok(Array.isArray(result.rows));
    assert.ok(Number.isInteger(result.total) && result.total >= 0);
    assert.strictEqual(result.limit, limit);
    assert.strictEqual(result.offset, offset);
    assert.ok(result.rows.length <= limit, 'rows must never exceed limit');
  }

  const sqlStore = await openStore();
  const jsonStore = await openStore();

  test('1. empty library: both storages return an empty envelope', async () => {
    // Fresh stores: the shared ones are seeded below (SQL inserts stay
    // in-memory; no saveDB runs), so the database file is still empty.
    const emptySql = await openStore();
    const emptyJson = await openStore();
    emptyJson.db = null;
    emptyJson._numbers = [];
    const s = await emptySql.queryNumbers({ limit: 50, offset: 0 });
    const j = await emptyJson.queryNumbers({ limit: 50, offset: 0 });
    assert.deepStrictEqual(s, { rows: [], total: 0, limit: 50, offset: 0 });
    assert.deepStrictEqual(j, { rows: [], total: 0, limit: 50, offset: 0 });
    assertEnvelope(s, 50, 0);
    assertEnvelope(j, 50, 0);
  });

  for (const row of FIXTURE) {
    sqlStore.db.run(INSERT_SQL, [
      row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt,
      row.title, row.website, row.email, row.address, row.runSlug
    ]);
  }
  jsonStore.db = null;
  jsonStore._numbers = JSON.parse(JSON.stringify(FIXTURE));

  const CASES = [
    { name: 'default order is newest-first on both storages', q: { limit: 20, offset: 0 },
      ids: ['q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'] },
    { name: 'search is ASCII-case-insensitive across 7 fields', q: { limit: 20, offset: 0, search: 'cafe' },
      ids: ['q8', 'q5', 'q3', 'q1'] },
    { name: 'search uppercase needle folds identically', q: { limit: 20, offset: 0, search: 'PURE' },
      ids: ['q2'] },
    { name: 'search Thai text', q: { limit: 20, offset: 0, search: 'ร้าน' }, ids: ['q4'] },
    { name: 'search treats % as a literal character', q: { limit: 20, offset: 0, search: '%' }, ids: ['q2'] },
    { name: 'search treats _ as a literal character', q: { limit: 20, offset: 0, search: '_' }, ids: ['q2'] },
    { name: 'search matches wildcard sequence literally', q: { limit: 20, offset: 0, search: '100%_pure' }, ids: ['q2'] },
    { name: 'search matches the ampersand', q: { limit: 20, offset: 0, search: '&' }, ids: ['q7'] },
    { name: 'search never matches runSlug (excluded field)', q: { limit: 20, offset: 0, search: 'run' },
      ids: [] },
    { name: 'filter status pending matches every row', q: { limit: 20, offset: 0, filters: { status: 'pending' } },
      ids: ['q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'] },
    { name: 'filter status sent matches no rows (dead UI value)', q: { limit: 20, offset: 0, filters: { status: 'sent' } },
      ids: [] },
    { name: 'filter source exact match', q: { limit: 20, offset: 0, filters: { source: '手动导入' } },
      ids: ['q8', 'q2'] },
    { name: "filter source '' matches empty but never NULL", q: { limit: 20, offset: 0, filters: { source: '' } },
      ids: ['q7', 'q4'] },
    { name: 'filter keyword exact match', q: { limit: 20, offset: 0, filters: { keyword: 'cafe' } },
      ids: ['q8', 'q5', 'q3', 'q1'] },
    { name: 'sort title asc with NULL/empty/tie-break semantics',
      q: { limit: 20, offset: 0, sort: 'title', order: 'asc' },
      ids: ['q8', 'q5', 'q1', 'q2', 'q7', 'q3', 'q6', 'q4'] },
    { name: 'sort title desc keeps rowid DESC tie-break',
      q: { limit: 20, offset: 0, sort: 'title', order: 'desc' },
      ids: ['q4', 'q6', 'q3', 'q7', 'q2', 'q5', 'q1', 'q8'] },
    { name: 'sort source asc puts NULL first and ties newest-first',
      q: { limit: 20, offset: 0, sort: 'source', order: 'asc' },
      ids: ['q3', 'q7', 'q4', 'q5', 'q1', 'q6', 'q8', 'q2'] },
    { name: 'sort collectedAt desc', q: { limit: 20, offset: 0, sort: 'collectedAt', order: 'desc' },
      ids: ['q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'] },
    { name: 'sort phone asc', q: { limit: 20, offset: 0, sort: 'phone', order: 'asc' },
      ids: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8'] },
    { name: 'sort keyword desc with four-way tie',
      q: { limit: 20, offset: 0, sort: 'keyword', order: 'desc' },
      ids: ['q6', 'q7', 'q8', 'q5', 'q3', 'q1', 'q2', 'q4'] },
    { name: 'pagination first page', q: { limit: 3, offset: 0 }, ids: ['q8', 'q7', 'q6'], total: 8 },
    { name: 'pagination middle page', q: { limit: 3, offset: 2 }, ids: ['q6', 'q5', 'q4'], total: 8 },
    { name: 'pagination last page', q: { limit: 3, offset: 7 }, ids: ['q1'], total: 8 },
    { name: 'offset at total returns empty rows with correct total', q: { limit: 3, offset: 8 }, ids: [], total: 8 },
    { name: 'offset past end returns empty rows with correct total', q: { limit: 3, offset: 50 }, ids: [], total: 8 },
    { name: 'combined search + filter + sort + page',
      q: { limit: 2, offset: 1, search: 'cafe', filters: { keyword: 'cafe' }, sort: 'phone', order: 'asc' },
      ids: ['q3', 'q5'], total: 4 }
  ];

  for (const c of CASES) {
    test(`2.${CASES.indexOf(c)}. parity: ${c.name}`, async () => {
      const s = await sqlStore.queryNumbers({ ...c.q });
      const j = await jsonStore.queryNumbers({ ...c.q });
      assertEnvelope(s, c.q.limit, c.q.offset);
      assertEnvelope(j, c.q.limit, c.q.offset);
      assert.deepStrictEqual(s, j, 'SQL and JSON storages must return identical results');
      assert.deepStrictEqual(idsOf(s), c.ids, 'expected result order');
      const expectedTotal = c.total === undefined ? c.ids.length : c.total;
      assert.strictEqual(s.total, expectedTotal, 'total must count the whole match set, not the page');
    });
  }

  test('3. whitespace-only search behaves like no search; surrounding space is trimmed', async () => {
    const blank = await sqlStore.queryNumbers({ limit: 20, offset: 0, search: '   ' });
    assert.strictEqual(blank.total, 8, 'whitespace-only search must not filter');
    const trimmed = await sqlStore.queryNumbers({ limit: 20, offset: 0, search: '  cafe  ' });
    assert.strictEqual(trimmed.total, 4, 'search term must be trimmed before matching');
    const jsonBlank = await jsonStore.queryNumbers({ limit: 20, offset: 0, search: '   ' });
    const jsonTrimmed = await jsonStore.queryNumbers({ limit: 20, offset: 0, search: '  cafe  ' });
    assert.deepStrictEqual(jsonBlank, blank, 'trim semantics identical on JSON storage');
    assert.deepStrictEqual(jsonTrimmed, trimmed, 'trim semantics identical on JSON storage');
  });

  test('4. query path performs zero writes (database bytes unchanged)', async () => {
    const before = Buffer.from(sqlStore.db.export());
    await sqlStore.queryNumbers({ limit: 20, offset: 0 });
    await sqlStore.queryNumbers({ limit: 20, offset: 0, search: 'cafe' });
    await sqlStore.queryNumbers({ limit: 5, offset: 3, sort: 'title', order: 'desc', filters: { status: 'pending' } });
    const after = Buffer.from(sqlStore.db.export());
    assert.ok(before.equals(after), 'read-only queries must not rewrite the database');
  });

  test('5. every prepared statement is freed (no statement leaks)', async () => {
    const originalPrepare = sqlStore.db.prepare.bind(sqlStore.db);
    let live = 0;
    sqlStore.db.prepare = (sql) => {
      const stmt = originalPrepare(sql);
      live += 1;
      const originalFree = stmt.free.bind(stmt);
      stmt.free = () => {
        live -= 1;
        return originalFree();
      };
      return stmt;
    };
    try {
      await sqlStore.queryNumbers({ limit: 20, offset: 0 });
      await sqlStore.queryNumbers({ limit: 20, offset: 0, search: 'cafe', filters: { status: 'pending' } });
      await sqlStore.queryNumbers({ limit: 20, offset: 0, sort: 'title', order: 'asc' });
      assert.strictEqual(live, 0, 'all prepared statements must be freed');
    } finally {
      sqlStore.db.prepare = originalPrepare;
    }
  });

  test('6. injection-shaped input stays literal and never disturbs the table', async () => {
    const evilSearch = await sqlStore.queryNumbers({
      limit: 20, offset: 0, search: "%' OR '1'='1",
      sort: 'title; DROP TABLE numbers', order: 'asc; --',
      filters: { source: "' OR 1=1 --" }
    });
    assertEnvelope(evilSearch, 20, 0);
    assert.deepStrictEqual(evilSearch.rows, [], 'malicious literals match no rows');
    assert.strictEqual(evilSearch.total, 0);
    const table = await sqlStore.queryNumbers({ limit: 100, offset: 0 });
    assert.strictEqual(table.total, 8, 'numbers table must be intact');
    assert.deepStrictEqual(idsOf(table), ['q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1']);
  });

  test('7. defensive defaults: bad payloads collapse to safe defaults', async () => {
    const nonObject = await sqlStore.queryNumbers('garbage');
    assert.strictEqual(nonObject.limit, 20, 'non-object payload uses paging default limit');
    assert.strictEqual(nonObject.offset, 0, 'non-object payload uses paging default offset');
    assert.strictEqual(nonObject.total, 8);

    const badLimit = await sqlStore.queryNumbers({ limit: 9999, offset: -5 });
    assert.strictEqual(badLimit.limit, 20, 'out-of-range limit falls back to the default');
    assert.strictEqual(badLimit.offset, 0, 'negative offset falls back to the default');

    const badSort = await sqlStore.queryNumbers({ limit: 20, offset: 0, sort: 'evilColumn' });
    assert.deepStrictEqual(idsOf(badSort), ['q8', 'q7', 'q6', 'q5', 'q4', 'q3', 'q2', 'q1'],
      'unknown sort key falls back to default order');

    const badFilters = await sqlStore.queryNumbers({ limit: 20, offset: 0, filters: 'not-an-object' });
    assert.strictEqual(badFilters.total, 8, 'non-object filters are ignored');
    const badFilterValue = await sqlStore.queryNumbers({ limit: 20, offset: 0, filters: { source: 123 } });
    assert.strictEqual(badFilterValue.total, 8, 'non-string filter values are ignored');
  });

  // --- 8-10. source contracts -------------------------------------------
  test('8. main: validator, allowlist and handler wiring are in place', () => {
    assert.ok(mainSource.includes('function validateNumbersQuery('), 'validator exists');
    assert.ok(
      mainSource.includes("const NUMBERS_QUERY_SORT_FIELDS = ['collectedAt', 'title', 'phone', 'source', 'keyword'];"),
      'sort allowlist is an explicit literal list'
    );
    assert.ok(
      mainSource.includes('const { limit, offset } = validateHistoryPaging(p);'),
      'paging bounds reused from validateHistoryPaging (no new limits)'
    );
    assert.ok(
      mainSource.includes('accountStore.queryNumbers(validateNumbersQuery(query))'),
      'handler validates before querying'
    );
    assert.ok(
      mainSource.includes("rejectLog('collector:get-numbers', err.message)"),
      'validation failures are logged via the existing pattern'
    );
    assert.ok(mainSource.includes("ipcMain.handle('collector:get-numbers'"), 'channel name unchanged');
  });

  test('9. preload passes the query; renderer consumes the envelope', () => {
    assert.ok(
      preloadSource.includes("getNumbers: (query) => ipcRenderer.invoke('collector:get-numbers', query)"),
      'preload forwards the optional query payload'
    );
    assert.ok(
      rendererSource.includes('window.appAPI.collector.getNumbers(numbersQueryPayload())'),
      'renderer queries through the existing flow'
    );
    assert.ok(rendererSource.includes('Array.isArray(result.rows)'), 'renderer reads envelope rows');
    assert.ok(rendererSource.includes('Number.isInteger(result.total)'), 'renderer reads envelope total');
    assert.ok(rendererSource.includes('if (seq !== numbersLoadSeq) return;'), 'stale-response guard present');
    assert.ok(
      rendererSource.includes("renderPagination('numbers-pagination', totalPages, numbersPage"),
      'pagination still derives from total pages'
    );
    assert.ok(
      rendererSource.includes('offset: (numbersPage - 1) * NUMBERS_PER_PAGE'),
      'offset computed from page state'
    );
    assert.ok(rendererSource.includes('numbersSearchTimer = setTimeout'), 'search input is debounced');
    assert.ok(!rendererSource.includes('allNumbers'), 'full-array client cache removed');
    assert.ok(rendererSource.includes("sort: 'collectedAt', label: '采集Time'"), 'sort map covers collectedAt');
    assert.ok(rendererSource.includes("sort: 'title', label: 'Title'"), 'sort map covers title');
    assert.ok(rendererSource.includes("sort: 'phone', label: 'Phone'"), 'sort map covers phone');
    assert.ok(rendererSource.includes("sort: 'source', label: 'Source'"), 'sort map covers source');
    assert.ok(rendererSource.includes("sort: 'keyword', label: 'Keywords'"), 'sort map covers keyword');
    assert.ok(rendererSource.includes('${escapeHtml(n.title || \'-\')}'), 'title cell template unchanged');
    assert.ok(rendererSource.includes('${escapeHtml(n.website || \'-\')}'), 'website cell template unchanged');
    assert.ok(htmlSource.includes('<th>Title</th>'), 'title header literal unchanged');
    assert.ok(htmlSource.includes('<th>Website</th>'), 'website header literal unchanged');
    assert.ok(htmlSource.includes('搜索Phone/Title/Website/Email/Address/Source/Keyword'), 'placeholder reflects the 7-field search');
  });

  test('10. accountStore: read-only query path, no logging, locked literals intact', () => {
    assert.ok(storeSource.includes('async queryNumbers(query)'), 'query entry point exists');
    assert.ok(storeSource.includes('LIKE ? ESCAPE'), 'parameterised LIKE with ESCAPE used');
    assert.ok(storeSource.includes('SELECT COUNT(*) AS c FROM numbers'), 'total computed in storage');
    const qStart = storeSource.indexOf('// B2 query layer: server-side search');
    const qEnd = storeSource.indexOf('async addNumbers(');
    assert.ok(qStart > -1 && qEnd > qStart, 'query block located');
    const qBlock = storeSource.slice(qStart, qEnd);
    assert.ok(!qBlock.includes('logger.'), 'query path performs no logging (banned-token safety)');
    assert.ok(!qBlock.includes('saveDB('), 'query path never persists');
    assert.ok(storeSource.split("writeJsonAtomic(path.join(DATA_DIR, 'numbers.json')").length - 1 === 2,
      'JSON write call sites unchanged');
    assert.ok(storeSource.split('new Set(ids)').length - 1 === 2, 'delete Set usage unchanged');
    assert.ok(!storeSource.includes('ids.includes'));
    assert.ok(!storeSource.toLowerCase().includes('country'), 'country not implemented');
    assert.ok(!storeSource.toLowerCase().includes('city'), 'city not implemented');
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }

  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch (cleanupErr) {}

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
