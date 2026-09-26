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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b3-detail-'));

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
  const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const stylesSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');

  const { AccountStore } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  // B3 fixture: d1 = complete record (title carries HTML metacharacters that
  // must round-trip byte-exact), d2 = every optional field empty (empty
  // runSlug), d3 = NULL source + runSlug (NULL parity across storages).
  const D1 = {
    id: 'd1', phone: '+66911111111', source: 'B3 Source', keyword: 'b3',
    status: 'pending', collectedAt: '2026-02-01T00:00:00.000Z',
    title: 'Cafe <b>&"Aroma"</b>', website: 'https://b3.example',
    email: 'b3@example.com', address: '3 B3 Rd', runSlug: 'run-b3'
  };
  const D2 = {
    id: 'd2', phone: '+66922222222', source: '', keyword: '',
    status: 'pending', collectedAt: '2026-02-02T00:00:00.000Z',
    title: '', website: '', email: '', address: '', runSlug: ''
  };
  const D3 = {
    id: 'd3', phone: '+66933333333', source: null, keyword: 'cafe',
    status: 'pending', collectedAt: '2026-02-03T00:00:00.000Z',
    title: 'noodle', website: '', email: '', address: '', runSlug: 'run-9'
  };
  const FIXTURE = [D1, D2, D3];

  const INSERT_SQL =
    'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt, title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
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

  for (const row of FIXTURE) {
    sqlStore.db.run(INSERT_SQL, [
      row.id, row.phone, row.source, row.keyword, row.status, row.collectedAt,
      row.title, row.website, row.email, row.address, row.runSlug
    ]);
  }
  jsonStore.db = null;
  jsonStore._numbers = JSON.parse(JSON.stringify(FIXTURE));

  test('1. SQL single-lead retrieval returns the complete 11-field record', async () => {
    const result = await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd1' });
    assertEnvelope(result, 1, 0);
    assert.strictEqual(result.total, 1, 'exactly one row for a primary-key hit');
    assert.deepStrictEqual(result.rows, [D1], 'all 11 fields returned byte-exact (HTML metacharacters intact)');
    const row = result.rows[0];
    for (const field of ['id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, field), 'field present: ' + field);
    }
  });

  test('2. JSON single-lead retrieval returns the complete 11-field record', async () => {
    const result = await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'd2' });
    assertEnvelope(result, 1, 0);
    assert.strictEqual(result.total, 1);
    assert.deepStrictEqual(result.rows, [D2], 'all 11 fields returned byte-exact from JSON storage');
    const row = result.rows[0];
    for (const field of ['id', 'phone', 'source', 'keyword', 'status', 'collectedAt',
      'title', 'website', 'email', 'address', 'runSlug']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, field), 'field present: ' + field);
    }
  });

  test('3. SQL/JSON parity: id lookup alone and combined with search/filters', async () => {
    const queries = [
      { limit: 1, offset: 0, id: 'd1' },
      { limit: 1, offset: 0, id: 'd3' },
      { limit: 1, offset: 0, id: 'd1', search: 'nomatch', filters: { status: 'pending' } },
      { limit: 1, offset: 0, id: 'd1', search: 'aroma', filters: { status: 'pending' } },
      { limit: 1, offset: 0, id: 'd2', sort: 'collectedAt', order: 'desc' }
    ];
    for (const q of queries) {
      const s = await sqlStore.queryNumbers({ ...q });
      const j = await jsonStore.queryNumbers({ ...q });
      assertEnvelope(s, 1, 0);
      assertEnvelope(j, 1, 0);
      assert.deepStrictEqual(s, j, 'SQL and JSON must return identical id-lookup results: ' + JSON.stringify(q));
    }
    const combined = await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd1', search: 'aroma' });
    assert.strictEqual(combined.total, 1, 'id combines with search by AND');
    const contradicted = await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd1', search: 'nomatch' });
    assert.strictEqual(contradicted.total, 0, 'id plus failing search yields no rows');
    assert.deepStrictEqual(contradicted.rows, []);
  });

  test('4. missing lead: empty envelope on both storages, no throw', async () => {
    const s = await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'does-not-exist' });
    const j = await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'does-not-exist' });
    assert.deepStrictEqual(s, { rows: [], total: 0, limit: 1, offset: 0 });
    assert.deepStrictEqual(j, { rows: [], total: 0, limit: 1, offset: 0 });
    assert.deepStrictEqual(s, j, 'missing-lead behavior identical across storages');
  });

  test('5. malformed id: empty envelope on both storages; null id means absent', async () => {
    const malformed = [123, '', {}, [], true, false, 0, 'x'.repeat(101)];
    for (const bad of malformed) {
      const s = await sqlStore.queryNumbers({ limit: 1, offset: 0, id: bad });
      const j = await jsonStore.queryNumbers({ limit: 1, offset: 0, id: bad });
      const expected = { rows: [], total: 0, limit: 1, offset: 0 };
      assert.deepStrictEqual(s, expected, 'SQL must short-circuit malformed id: ' + JSON.stringify(bad));
      assert.deepStrictEqual(j, expected, 'JSON must short-circuit malformed id: ' + JSON.stringify(bad));
    }
    const nullSql = await sqlStore.queryNumbers({ limit: 10, offset: 0, id: null });
    const nullJson = await jsonStore.queryNumbers({ limit: 10, offset: 0, id: null });
    assert.strictEqual(nullSql.total, 3, 'null id follows the existing absent-optional convention (list query)');
    assert.deepStrictEqual(nullSql, nullJson, 'null id identical across storages');
    const listSql = await sqlStore.queryNumbers({ limit: 10, offset: 0 });
    assert.strictEqual(listSql.total, 3, 'list queries unaffected by the id predicate');
  });

  test('6. main: id validated with existing conventions; 18 channels unchanged', () => {
    assert.ok(mainSource.includes('if (p.id !== undefined && p.id !== null)'), 'optional id extracted');
    assert.ok(mainSource.includes("assertOptionalString(p.id, 'id', 100)"), 'string + max-100 via existing guard');
    assert.ok(mainSource.includes("Invalid params: id (non-empty required)"), 'empty id rejected');
    assert.ok(mainSource.includes('out.id = p.id;'), 'validated id forwarded to the store');
    assert.ok(
      mainSource.includes("for (const key of ['source', 'keyword', 'collectedAt', 'title', 'website', 'email', 'address', 'runSlug'])"),
      'validateNumbersPayload key list untouched'
    );
    assert.ok(mainSource.includes('accountStore.queryNumbers(validateNumbersQuery(query))'), 'handler path unchanged');
    const channels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
    assert.strictEqual(channels.length, 18, 'exactly 18 IPC channels remain (no detail channel added)');
    assert.ok(!channels.includes('collector:get-number'), 'no single-lead channel introduced');
  });

  test('7. provenance: runSlug preserved through lookup; empty runSlug stays a strict empty string', async () => {
    const full = (await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd1' })).rows[0];
    assert.strictEqual(full.runSlug, 'run-b3', 'runSlug returned unchanged by id lookup');
    const other = (await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'd3' })).rows[0];
    assert.strictEqual(other.runSlug, 'run-9', 'runSlug preserved on JSON storage');
    const emptySql = (await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd2' })).rows[0];
    const emptyJson = (await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'd2' })).rows[0];
    assert.strictEqual(emptySql.runSlug, '', 'empty runSlug is a strict empty string, never null/undefined');
    assert.strictEqual(emptyJson.runSlug, '', 'empty runSlug identical on JSON storage');
    assert.strictEqual(emptySql.source, '', 'empty source still a string');
    assert.strictEqual((await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd3' })).rows[0].source, null,
      'NULL source round-trips as null');
  });

  test('8. storage byte identity: id lookups perform zero writes', async () => {
    const sqlBefore = Buffer.from(sqlStore.db.export());
    await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'd1' });
    await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'does-not-exist' });
    await sqlStore.queryNumbers({ limit: 1, offset: 0, id: 'x'.repeat(101) });
    const sqlAfter = Buffer.from(sqlStore.db.export());
    assert.ok(sqlBefore.equals(sqlAfter), 'SQL database bytes unchanged by id lookups');

    const jsonBefore = JSON.stringify(jsonStore._numbers);
    await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'd1' });
    await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 'does-not-exist' });
    await jsonStore.queryNumbers({ limit: 1, offset: 0, id: 123 });
    const jsonAfter = JSON.stringify(jsonStore._numbers);
    assert.strictEqual(jsonBefore, jsonAfter, 'JSON rows unchanged by id lookups');
  });

  test('9. store: id predicate literals present; query path stays write-free, no new writes/indexes', () => {
    assert.ok(storeSource.includes('async queryNumbers(query)'), 'query entry point unchanged');
    assert.ok(storeSource.includes("where.push('id = ?')"), 'SQL id predicate is parameterised');
    assert.ok(storeSource.includes('row.id !== query.id'), 'JSON id predicate is a strict comparison');
    assert.ok(storeSource.includes('normalized.id = q.id'), 'validated id reaches both branches');
    const qStart = storeSource.indexOf('// B2 query layer: server-side search');
    const qEnd = storeSource.indexOf('async addNumbers(');
    assert.ok(qStart > -1 && qEnd > qStart, 'query block located');
    const qBlock = storeSource.slice(qStart, qEnd);
    assert.ok(!qBlock.includes('saveDB('), 'query path never persists');
    assert.ok(!qBlock.includes('logger.'), 'query path performs no logging');
    assert.ok(!qBlock.includes('INSERT INTO'), 'query path inserts nothing');
    assert.ok(!qBlock.includes('UPDATE numbers'), 'query path updates nothing');
    assert.ok(!qBlock.includes('DELETE FROM'), 'query path deletes nothing');
    assert.strictEqual(
      storeSource.split("writeJsonAtomic(path.join(DATA_DIR, 'numbers.json')").length - 1, 2,
      'JSON write call sites unchanged'
    );
    assert.strictEqual(storeSource.split('new Set(ids)').length - 1, 2, 'delete Set usage unchanged');
    // B4 justification: the local job ledger intentionally introduces the
    // jobs CREATE TABLE plus its two CREATE INDEX statements
    // (idx_jobs_startedAt and idx_jobs_provider_run backing the
    // UNIQUE(providerId, runSlug) upsert key), so the exact counts rise
    // 2 -> 4 (CREATE INDEX) and 1 -> 2 (CREATE TABLE). Kept as exact
    // equality (never >=) so any further DDL must still be declared here.
    assert.strictEqual(storeSource.split('CREATE INDEX').length - 1, 4, 'B4 adds exactly two job indexes');
    assert.strictEqual(storeSource.split('CREATE TABLE').length - 1, 2, 'B4 adds exactly one job table');
  });

  const detailStart = rendererSource.indexOf('// === Lead Detail overlay (B3) ===');
  const detailEnd = rendererSource.indexOf("document.getElementById('btn-delete-selected')");
  assert.ok(detailStart > -1 && detailEnd > detailStart, 'detail region located');
  const detailRegion = rendererSource.slice(detailStart, detailEnd);
  const templateStart = rendererSource.indexOf('function leadDetailTemplate');
  const templateEnd = rendererSource.indexOf('async function openLeadDetail');
  assert.ok(templateStart > -1 && templateEnd > templateStart, 'template located');
  const templateRegion = rendererSource.slice(templateStart, templateEnd);

  test('10. renderer output encoding: all 11 fields escaped; 11 detail slots rendered', () => {
    for (const field of ['id', 'phone', 'source', 'keyword', 'status', 'title', 'email', 'address', 'runSlug']) {
      assert.ok(templateRegion.includes(`escapeHtml(lead.${field}`), 'escaped: ' + field);
    }
    assert.ok(templateRegion.includes('new Date(lead.collectedAt)'), 'collectedAt read from the lead');
    assert.ok(templateRegion.includes("escapeHtml(collected.toLocaleString('zh-CN'))"), 'collectedAt escaped after formatting');
    assert.ok(templateRegion.includes('renderWebsite(websiteRaw)'), 'website routed through the secure helper');
    assert.ok(!templateRegion.includes('<a href='), 'template builds no raw hrefs itself');
    for (const label of ['ID', 'Phone', 'Source', 'Keywords', 'Status', '采集Time', 'Title', 'Website', 'Email', 'Address', 'Run Slug']) {
      assert.ok(templateRegion.includes(`row('${label}'`), 'detail slot present: ' + label);
    }
    assert.ok(detailRegion.includes("body.innerHTML = leadDetailTemplate(lead)"), 'rendered via the escaped template');
  });

  test('11. secure website rendering: protocol allowlist and safe link markup intact', () => {
    assert.ok(rendererSource.includes('function renderWebsite(value)'), 'renderWebsite helper retained');
    assert.ok(
      rendererSource.includes("if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return escapeHtml(website);"),
      'protocol allowlist intact'
    );
    assert.ok(rendererSource.includes('target="_blank" rel="noopener"'), 'safe link attributes intact');
    assert.ok(templateRegion.includes('renderWebsite(websiteRaw)'), 'detail website uses renderWebsite');
    assert.ok(templateRegion.includes("websiteRaw ? renderWebsite(websiteRaw) : '—'"), 'empty website falls back to a placeholder, not a link');
  });

  test('12. no inline event handlers, eval, or iframes anywhere in the UI layer', () => {
    assert.ok(!rendererSource.includes('eval('), 'no eval in renderer');
    assert.ok(!rendererSource.includes('new Function'), 'no new Function in renderer');
    assert.ok(!/on(?:click|error|load|change|mouseover)\s*=\s*["']/.test(rendererSource), 'no inline on* handlers in renderer source');
    assert.ok(!rendererSource.includes('<iframe'), 'no iframe built by renderer');
    assert.ok(!/\son\w+="/.test(htmlSource), 'no inline on* attributes in HTML');
    assert.ok(!htmlSource.includes('<iframe'), 'no iframe element in HTML');
    assert.ok(!htmlSource.includes('eval('), 'no eval in HTML');
    assert.ok(htmlSource.includes('type="module" src="./src/renderer/renderer.js"'), 'script loading strategy unchanged');
  });

  test('13. renderer row click opens detail with checkbox guard and exact query payload', () => {
    assert.ok(
      rendererSource.includes("getElementById('numbers-table-body').addEventListener('click'"),
      'delegated row click on the numbers tbody'
    );
    assert.ok(detailRegion.includes("e.target.closest('input, a, button')"), 'checkbox/input clicks ignored');
    assert.ok(detailRegion.includes("tr.querySelector('.number-check')"), 'id read from the existing checkbox');
    assert.ok(detailRegion.includes('cb.dataset.id'), 'existing data-id reused');
    assert.ok(detailRegion.includes('getNumbers({ limit: 1, offset: 0, id })'), 'exact single-lead query payload');
    assert.ok(detailRegion.includes("getElementById('btn-close-lead-detail')"), 'close control wired via addEventListener');
    assert.ok(!detailRegion.includes('onclick'), 'no inline onclick');
  });

  test('14. detail uses its own detailLoadSeq and never touches numbersLoadSeq', () => {
    assert.ok(rendererSource.includes('let detailLoadSeq = 0;'), 'independent sequence declared');
    const openStart = rendererSource.indexOf('async function openLeadDetail');
    const openEnd = rendererSource.indexOf('function closeLeadDetail');
    assert.ok(openStart > -1 && openEnd > openStart, 'openLeadDetail located');
    const openRegion = rendererSource.slice(openStart, openEnd);
    assert.ok(openRegion.includes('++detailLoadSeq'), 'detail sequence incremented on open');
    assert.ok(openRegion.includes('seq !== detailLoadSeq'), 'stale detail responses discarded');
    assert.ok(!openRegion.includes('numbersLoadSeq'), 'page sequence never referenced by the detail fetch');
    assert.ok(!detailRegion.includes('numbersLoadSeq'), 'detail region isolated from page-query state');
    assert.ok(rendererSource.includes('if (seq !== numbersLoadSeq) return;'), 'B2 page guard untouched');
  });

  test('15. opening/closing the detail never calls renderNumbers and never alters page state', () => {
    assert.ok(!detailRegion.includes('renderNumbers('), 'detail region performs no page re-render');
    assert.ok(!detailRegion.includes('numbersQueryPayload'), 'detail does not reuse the page payload');
    const closeStart = rendererSource.indexOf('function closeLeadDetail');
    const closeEnd = rendererSource.indexOf("getElementById('numbers-table-body').addEventListener('click'");
    assert.ok(closeStart > -1 && closeEnd > closeStart, 'closeLeadDetail located');
    const closeRegion = rendererSource.slice(closeStart, closeEnd);
    assert.ok(!closeRegion.includes('renderNumbers('), 'close performs no page re-render');
    assert.ok(closeRegion.includes('detailLoadSeq += 1'), 'close invalidates any in-flight detail fetch');
    assert.ok(rendererSource.includes('offset: (numbersPage - 1) * NUMBERS_PER_PAGE'), 'B2 pagination math unchanged');
    assert.ok(rendererSource.includes("sort: 'collectedAt', label: '采集Time'"), 'B2 sort map unchanged');
  });

  test('16. detail view is read-only: no mutation APIs reachable from the detail flow', () => {
    for (const banned of ['addNumbers(', 'deleteNumbers(', 'exportNumbers(', 'saveDB(', 'storageStatus(']) {
      assert.ok(!detailRegion.includes(banned), 'detail region must not call: ' + banned);
    }
    assert.ok(!detailRegion.includes('appAPI.settings'), 'detail touches no settings');
    assert.ok(!detailRegion.includes('collection.submit'), 'detail triggers no collection');
    assert.ok(detailRegion.includes('leadDetailTemplate(lead)'), 'display-only rendering path');
  });

  test('17. overlay markup and styles present; CSP/frame surface untouched', () => {
    assert.ok(htmlSource.includes('id="lead-detail-overlay"'), 'overlay container exists');
    assert.ok(/id="lead-detail-overlay" hidden/.test(htmlSource), 'overlay starts hidden');
    assert.ok(htmlSource.includes('id="lead-detail-body"'), 'detail body slot exists');
    assert.ok(htmlSource.includes('id="btn-close-lead-detail"'), 'close control exists');
    assert.ok(htmlSource.includes('role="dialog"'), 'dialog semantics present');
    assert.ok(htmlSource.includes("frame-src 'none'"), 'CSP frame-src canary intact');
    assert.ok(!htmlSource.includes('<iframe'), 'no iframe introduced');
    assert.ok(stylesSource.includes('.lead-detail-overlay'), 'overlay styles exist');
    assert.ok(stylesSource.includes('.lead-detail-overlay[hidden]'), 'hidden state styled');
    assert.ok(stylesSource.includes('.lead-detail-value'), 'value rows styled');
  });

  test('18. B2 contract spot-check: query payload, cell templates, allowlist intact', () => {
    assert.ok(rendererSource.includes('window.appAPI.collector.getNumbers(numbersQueryPayload())'), 'page query flow intact');
    assert.ok(rendererSource.includes('if (seq !== numbersLoadSeq) return;'), 'page stale-guard intact');
    assert.ok(rendererSource.includes('${escapeHtml(n.title || \'-\')}'), 'title cell template unchanged');
    assert.ok(rendererSource.includes('${escapeHtml(n.website || \'-\')}'), 'website cell template unchanged');
    assert.ok(rendererSource.includes('let currentResultsRunSlug = null'), 'runSlug save-path state untouched');
    assert.ok(rendererSource.split('currentResultsRunSlug = null').length - 1 === 2, 'runSlug clear sites unchanged');
    assert.ok(mainSource.includes("const NUMBERS_QUERY_SORT_FIELDS = ['collectedAt', 'title', 'phone', 'source', 'keyword'];"), 'sort allowlist unchanged');
    assert.ok(htmlSource.includes('<th>Title</th>') && htmlSource.includes('<th>Website</th>'), 'table headers unchanged');
    assert.ok(htmlSource.includes('搜索Phone/Title/Website/Email/Address/Source/Keyword'), 'search placeholder unchanged');
    assert.ok(!storeSource.toLowerCase().includes('country') && !storeSource.toLowerCase().includes('city'), 'no country/city fields');
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
