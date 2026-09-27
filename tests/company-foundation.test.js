'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// P1-D: the minimal deterministic company foundation.
//
// companyKey is a derived grouping helper, companyId a nullable system
// pointer, and there is no company entity, no contact entity and no merge.
// The derivation functions under test are lifted from the store source, so
// these tests exercise the shipped implementation rather than a copy.
const root = path.join(__dirname, '..');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

const P1D_BLOCK = between(
  storeSource,
  '// === P1-D company foundation (derived, read-only) ===',
  '// Exact provenance literal written by the manual-import save path'
);
const p1d = new Function(
  P1D_BLOCK + '\nreturn { deriveCompanyKey, companyKeyWebsiteHost, companyKeyText,'
  + ' COMPANY_KEY_SEPARATOR, LEAD_COMPANY_FIELDS, LEAD_COMPANY_NULLABLE_FIELDS,'
  + ' normalizeLeadCompanyFields };'
)();

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p1d-company-'));

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

  const SQL = await require('sql.js')();
  const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
  const { AccountStore, migrateSchema, normalizeLeadRow } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');

  function schemaColumns(db) {
    const info = db.exec('PRAGMA table_info(numbers)');
    return info.length ? info[0].values.map(r => r[1]) : [];
  }

  function tableNames(db) {
    return db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap(result => result.values.map(row => row[0]));
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  // A JSON-fallback store over the same rows: no sql.js handle, rows in memory.
  async function openJsonStore(rows) {
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    store._numbers = rows.map(r => JSON.parse(JSON.stringify(r)));
    for (const row of store._numbers) normalizeLeadRow(row);
    return store;
  }

  async function rowById(store, id) {
    const result = await store.queryNumbers({ limit: 1, offset: 0, id });
    return result.rows[0] || null;
  }

  const lead = (over = {}) => ({
    id: 'p1d-1', phone: '+66900000001', source: 'src', keyword: 'kw',
    status: 'pending', collectedAt: '2026-05-01T00:00:00.000Z',
    title: '', website: '', email: '', address: '', runSlug: '',
    ...over
  });

  // The same lead, added to both storages, must report the same logical row.
  const PARITY_LEADS = [
    lead({ id: 'p-host', phone: '+66900000001', website: 'https://www.Acme.Example/menu?x=1#top', title: 'Other', address: '9 Other Rd' }),
    lead({ id: 'p-fallback', phone: '+66900000002', title: 'Acme Co., Ltd.', address: '3 B3 Rd' }),
    lead({ id: 'p-empty', phone: '+66900000003' }),
    lead({ id: 'p-titleonly', phone: '+66900000004', title: 'Acme Co., Ltd.' })
  ];

  // --- 1/2/3/4. website host: deterministic, www- and component-insensitive ---

  test('1. companyKey derivation is deterministic and total', () => {
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://acme.example' })), 'acme.example');
    // Same input, same output, every time and regardless of other fields.
    for (let i = 0; i < 5; i++) {
      assert.strictEqual(
        p1d.deriveCompanyKey(lead({ website: 'https://acme.example', email: 'x@y' + i + '.example' })),
        'acme.example'
      );
    }
    // Non-object and hostile inputs never throw and never invent a key.
    for (const bad of [null, undefined, 0, '', [], 'acme.example', { website: 42 }, { website: {} }]) {
      assert.strictEqual(typeof p1d.deriveCompanyKey(bad), 'string', 'always a string for: ' + JSON.stringify(bad));
    }
    assert.strictEqual(p1d.deriveCompanyKey({ website: 42, title: 'T', address: 'A' }), 't | a',
      'a non-string website is unusable, so the fallback applies');
  });

  test('2. leads with the same website host share one companyKey', () => {
    const a = p1d.deriveCompanyKey(lead({ website: 'https://acme.example', phone: '+66900000001' }));
    const b = p1d.deriveCompanyKey(lead({ website: 'http://acme.example/other', phone: '+66900000009', title: 'Zzz' }));
    assert.strictEqual(a, b, 'identical hosts group together regardless of title/address/phone');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://other.example' })), 'other.example');
    assert.notStrictEqual(a, p1d.deriveCompanyKey(lead({ website: 'https://sub.acme.example' })),
      'a subdomain is a different host: no fuzzy or parent-domain matching');
  });

  test('3. www. is stripped from the companyKey host', () => {
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://www.acme.example' })), 'acme.example');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://WWW.Acme.Example/' })), 'acme.example');
    assert.strictEqual(p1d.companyKeyWebsiteHost('http://www.www.acme.example'), 'www.acme.example',
      'only a leading www. is stripped');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://acme.www.example' })), 'acme.www.example');
  });

  test('4. scheme, port, path, query and hash never change the host key', () => {
    const variants = [
      'https://acme.example',
      'http://acme.example',
      'https://acme.example/',
      'https://acme.example/deep/path',
      'https://acme.example:8443',
      'http://acme.example:80/x?y=1',
      'https://acme.example?ref=twitter',
      'https://acme.example#contact',
      'https://ACME.EXAMPLE/Path?Q=1#F'
    ];
    const keys = new Set(variants.map(v => p1d.deriveCompanyKey(lead({ website: v }))));
    assert.deepStrictEqual([...keys], ['acme.example'], 'one key for every URL shape of the same host');
    // Unusable websites produce no host key at all (they fall through to the
    // title+address fallback, or to '' when that is missing too).
    for (const bad of ['', '   ', 'not a url', 'acme.example', 'javascript:alert(1)', 'mailto:a@b.example', null]) {
      assert.strictEqual(p1d.companyKeyWebsiteHost(bad), '', 'no host key for: ' + JSON.stringify(bad));
    }
  });

  // --- 5/6/7/8. the title+address fallback and the empty key ---

  test('5. a valid website host wins over title and address', () => {
    const withHost = p1d.deriveCompanyKey(lead({
      website: 'https://acme.example', title: 'Beta Ltd', address: '1 Beta Rd'
    }));
    assert.strictEqual(withHost, 'acme.example', 'the host is the key; title/address are not consulted');
    // Two leads with the same host but different title/address still group,
    // and a title/address-only lead never joins that group.
    const other = p1d.deriveCompanyKey(lead({
      website: 'https://www.acme.example/contact', title: 'Gamma Ltd', address: '2 Gamma Rd'
    }));
    assert.strictEqual(other, withHost);
    const fallback = p1d.deriveCompanyKey(lead({ title: 'Beta Ltd', address: '1 Beta Rd' }));
    assert.notStrictEqual(fallback, withHost, 'the fallback is not used while a host exists');
  });

  test('6. title + address is the fallback when the website is missing or unusable', () => {
    const expected = 'acme co ltd | 3 b3 rd';
    assert.strictEqual(p1d.deriveCompanyKey(lead({ title: 'Acme Co., Ltd.', address: '3 B3 Rd' })), expected);
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: '', title: 'Acme Co., Ltd.', address: '3 B3 Rd' })), expected);
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: '   ', title: 'Acme Co., Ltd.', address: '3 B3 Rd' })), expected);
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'nope', title: 'Acme Co., Ltd.', address: '3 B3 Rd' })), expected);
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: null, title: 'Acme Co., Ltd.', address: '3 B3 Rd' })), expected);
    // Normalisation is applied to both parts: case, trimmed edges, collapsed
    // whitespace and punctuation all fold to the same key.
    assert.strictEqual(
      p1d.deriveCompanyKey(lead({ title: '  ACME co.,  LTD.  ', address: '3   b3\tRd ' })),
      expected
    );
    assert.strictEqual(p1d.deriveCompanyKey(lead({ title: 'Acme Co Ltd', address: '3-B3-Rd' })), expected);
    // The two parts cannot be confused with each other: the separator is
    // unreachable from normalised text.
    assert.strictEqual(p1d.deriveCompanyKey(lead({ title: 'A B', address: 'C' })), 'a b | c');
    assert.notStrictEqual(p1d.deriveCompanyKey(lead({ title: 'A', address: 'B C' })),
      p1d.deriveCompanyKey(lead({ title: 'A B', address: 'C' })));
  });

  test('7. no website host and no title+address yields an empty companyKey', () => {
    assert.strictEqual(p1d.deriveCompanyKey(lead()), '');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: '', title: '', address: '' })), '');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'not a url' })), '');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'nope', title: 'Only Title' })), '');
    assert.strictEqual(p1d.deriveCompanyKey(lead({ email: 'a@acme.example', phone: '+66900000001' })), '',
      'email and phone never produce a key');
    // Whitespace-only text is not data.
    assert.strictEqual(p1d.deriveCompanyKey(lead({ title: '   ', address: '\t\n ' })), '');
  });

  test('8. a missing title OR a missing address never produces a fallback key', () => {
    const withBoth = p1d.deriveCompanyKey(lead({ title: 'Acme Co., Ltd.', address: '3 B3 Rd' }));
    assert.notStrictEqual(withBoth, '');
    const drops = [
      { title: '', address: '3 B3 Rd' },
      { title: '   ', address: '3 B3 Rd' },
      { title: 'Acme Co., Ltd.', address: '' },
      { title: 'Acme Co., Ltd.', address: '  ' },
      { title: null, address: '3 B3 Rd' },
      { title: 'Acme Co., Ltd.', address: null },
      { title: '!!!', address: '3 B3 Rd' },
      { title: 'Acme Co., Ltd.', address: '###' }
    ];
    for (const over of drops) {
      assert.strictEqual(p1d.deriveCompanyKey(lead(over)), '',
        'one-sided or punctuation-only data must not create a key: ' + JSON.stringify(over));
    }
  });

  test('9. normalisation is deterministic and free of a free-mail or email rule', () => {
    assert.strictEqual(p1d.companyKeyText('  Foo  Bar  '), 'foo bar');
    assert.strictEqual(p1d.companyKeyText('Foo\t\nBar'), 'foo bar');
    assert.strictEqual(p1d.companyKeyText('A.B,C;D'), 'a b c d');
    assert.strictEqual(p1d.companyKeyText('  ---  '), '');
    assert.strictEqual(p1d.companyKeyText('Café Süd'), 'café süd', 'non-ASCII letters are preserved');
    // No free-mail denylist: a mail host stored as a website is a normal host.
    assert.strictEqual(p1d.deriveCompanyKey(lead({ website: 'https://gmail.example' })), 'gmail.example');
    // The email column is never an input: two leads differing only in email
    // group identically, and an email-only lead has no key.
    const a = p1d.deriveCompanyKey(lead({ title: 'Acme Co., Ltd.', address: '3 B3 Rd', email: 'a@one.example' }));
    const b = p1d.deriveCompanyKey(lead({ title: 'Acme Co., Ltd.', address: '3 B3 Rd', email: 'b@two.example' }));
    assert.strictEqual(a, b);
    assert.strictEqual(p1d.deriveCompanyKey(lead({ email: 'only@email.example' })), '');
  });

  // --- 10/11/12. storage: SQL/JSON parity, migration, readability ---

  test('10. SQL and JSON storage expose identical companyKey and companyId values', async () => {
    const sqlStore = await openStore();
    fs.rmSync(dbPath, { force: true });
    const fresh = await openStore();
    await fresh.addNumbers(PARITY_LEADS.map(r => ({ ...r })));
    const jsonStore = await openJsonStore(PARITY_LEADS);

    const sqlRows = (await fresh.queryNumbers({ limit: 100, offset: 0 })).rows;
    const jsonRows = (await jsonStore.queryNumbers({ limit: 100, offset: 0 })).rows;
    assert.strictEqual(sqlRows.length, jsonRows.length);
    const byId = new Map(jsonRows.map(r => [r.id, r]));
    for (const sqlRow of sqlRows) {
      const jsonRow = byId.get(sqlRow.id);
      assert.ok(jsonRow, 'same lead on both storages: ' + sqlRow.id);
      assert.strictEqual(sqlRow.companyKey, jsonRow.companyKey, 'companyKey parity for ' + sqlRow.id);
      assert.strictEqual(sqlRow.companyId, jsonRow.companyId, 'companyId parity for ' + sqlRow.id);
    }
    assert.strictEqual(byId.get('p-host').companyKey, 'acme.example');
    assert.strictEqual(byId.get('p-fallback').companyKey, 'acme co ltd | 3 b3 rd');
    assert.strictEqual(byId.get('p-empty').companyKey, '');
    assert.strictEqual(byId.get('p-titleonly').companyKey, '');
    // The same values through the other read entry point.
    const all = await fresh.getCollectedNumbers();
    assert.strictEqual(all.find(r => r.id === 'p-host').companyKey, 'acme.example');
    sqlStore.db && sqlStore.db.close();
  });

  test('11. a legacy 6-column database migrates additively and stays readable', async () => {
    fs.rmSync(dbPath, { force: true });
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE numbers (
      id TEXT PRIMARY KEY,
      phone TEXT,
      source TEXT,
      keyword TEXT,
      status TEXT DEFAULT 'pending',
      collectedAt TEXT
    )`);
    legacy.run('INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy-1', '+66811111111', 'Bangkok Cafe', 'cafe', 'pending', '2026-01-01T00:00:00.000Z']);
    legacy.run('INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
      ['legacy-2', '+66822222222', '手动导入', '', 'pending', '2026-01-02T00:00:00.000Z']);
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();

    const store = await openStore();
    const columns = schemaColumns(store.db);
    assert.ok(columns.includes('companyId'), 'the nullable companyId column is added');
    assert.ok(!columns.includes('companyKey'), 'companyKey is derived, never a column');
    assert.strictEqual(columns[columns.length - 1], 'companyId', 'appended last, nothing rewritten');
    assert.strictEqual(migrateSchema(store.db), 0, 'migration is idempotent');

    const rows = await store.getCollectedNumbers();
    assert.strictEqual(rows.length, 2, 'no legacy row is added or lost');
    const first = rows.find(r => r.id === 'legacy-1');
    assert.strictEqual(first.phone, '+66811111111');
    assert.strictEqual(first.source, 'Bangkok Cafe', 'legacy source preserved byte-for-byte');
    assert.strictEqual(first.title, 'Bangkok Cafe');
    assert.strictEqual(first.companyKey, '', 'a legacy row with no website has no key');
    assert.strictEqual(first.companyId, null, 'the migrated pointer is NULL, not an empty string');
    assert.strictEqual(rows.find(r => r.id === 'legacy-2').title, '', 'import provenance is not a title');
  });

  test('12. companyId stays NULL through migration, repair and restart', async () => {
    // The startup repair is scoped to the user-owned columns, so it must not
    // fill a companyId, and a second startup must rewrite nothing.
    const store = await openStore();
    const before = Buffer.from(store.db.export());
    const again = await openStore();
    assert.ok(before.equals(Buffer.from(again.db.export())), 'a second startup rewrites nothing');
    for (const row of await again.getCollectedNumbers()) {
      assert.strictEqual(row.companyId, null, 'companyId is still NULL: ' + row.id);
    }
    const repair = between(storeSource, 'function repairLeadUserFields(db) {', '// Map a positional SELECT row');
    assert.ok(!repair.includes('companyId'), 'the repair never touches companyId');
    assert.ok(!p1d.LEAD_COMPANY_NULLABLE_FIELDS.includes('companyKey'),
      'only companyId is a nullable column');
  });

  // --- 13/14. companyId behaviour and the absence of a DB-level FK ---

  test('13. companyId is nullable, exposed as stored, and has no write path', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers([lead({ id: 'c-null' })]);
    const row = await rowById(store, 'c-null');
    assert.strictEqual(row.companyId, null, 'a fresh lead has a NULL pointer');
    assert.ok(Object.prototype.hasOwnProperty.call(row, 'companyId'), 'companyId is always present in the API shape');

    // A value written by a later phase is exposed verbatim and survives a
    // delete-rollback restore; NULL stays NULL.
    store.db.run("UPDATE numbers SET companyId = 'ref-1' WHERE id = ?", ['c-null']);
    assert.strictEqual((await rowById(store, 'c-null')).companyId, 'ref-1');
    const saved = store.saveDB;
    store.saveDB = () => { throw new Error('forced persistence failure'); };
    await assert.rejects(() => store.deleteNumbers(['c-null']), /forced persistence failure/);
    store.saveDB = saved;
    const restored = await rowById(store, 'c-null');
    assert.ok(restored, 'the row is restored after a failed delete');
    assert.strictEqual(restored.companyId, 'ref-1', 'the rollback insert keeps companyId');
    assert.strictEqual(restored.qualification, 'unqualified', 'and the B6 values');

    // P1-D exposes no companyId write path at all: no channel, no preload
    // method, no store setter.
    assert.ok(!storeSource.includes('setLeadCompany'), 'no company setter in the store');
    assert.ok(!mainSource.includes('companyId'), 'main.js does not touch companyId');
    assert.ok(!preloadSource.includes('companyId'), 'preload does not expose companyId');
    assert.ok(!mainSource.includes('companyKey'), 'main.js does not touch the derived key');
  });

  test('14. companyId is not a foreign key and no companies table exists', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    const fks = store.db.exec('PRAGMA foreign_key_list(numbers)');
    assert.ok(!fks.length || !fks[0].values.length, 'no DB-level foreign key on numbers');
    const tables = tableNames(store.db).sort();
    // P1-F declared lock update: the P1-F `targets` table joins the two
    // pre-existing ones. No company table and no contact table exist.
    assert.deepStrictEqual(tables, ['jobs', 'numbers', 'targets'],
      'exactly the two pre-existing tables plus the unrelated targets table');
    assert.ok(!/\bcompanies\b/i.test(storeSource), 'the store never mentions a companies table');
    assert.ok(!/\bcontacts?\b/i.test(storeSource), 'the store never mentions a contact entity');
    const createBlock = between(storeSource, 'CREATE TABLE IF NOT EXISTS numbers (', ')');
    assert.ok(/companyId TEXT/.test(createBlock), 'companyId is plain nullable TEXT');
    assert.ok(!/REFERENCES/i.test(createBlock), 'no REFERENCES clause in the numbers table');
  });

  // --- 15/16/17/18. nothing else moved ---

  test('15. B6 qualification, tags and notes are untouched by P1-D', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers([lead({ id: 'b6-1' })]);
    const before = await rowById(store, 'b6-1');
    assert.strictEqual(before.qualification, 'unqualified');
    assert.deepStrictEqual(before.tags, []);
    assert.strictEqual(before.notes, '');
    const saved = await store.setLeadUserFields({ id: 'b6-1', qualification: 'qualified', tags: ['vip'], notes: 'keep' });
    assert.deepStrictEqual(saved, { success: true, updated: true });
    const after = await rowById(store, 'b6-1');
    assert.strictEqual(after.qualification, 'qualified');
    assert.deepStrictEqual(after.tags, ['vip']);
    assert.strictEqual(after.notes, 'keep');
    assert.strictEqual(after.companyKey, '', 'the company key is unaffected by a B6 write');
  });

  test('16. the P1-C quality statuses are untouched by P1-D', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers([lead({ id: 'p1c-1', website: 'https://acme.example' })]);
    for (const field of ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus']) {
      assert.strictEqual((await rowById(store, 'p1c-1'))[field], 'unknown', 'default unchanged: ' + field);
    }
    const saved = await store.setLeadUserStatuses({ id: 'p1c-1', websiteStatus: 'live' });
    assert.deepStrictEqual(saved, { success: true, updated: true });
    const row = await rowById(store, 'p1c-1');
    assert.strictEqual(row.websiteStatus, 'live');
    assert.strictEqual(row.companyKey, 'acme.example', 'a status write never changes the derived key');
    for (const field of ['phoneStatus', 'emailStatus', 'businessStatus']) {
      assert.strictEqual(row[field], 'unknown', 'partial update unchanged: ' + field);
    }
  });

  test('17. canonicalPhone remains the lead identity and nothing is merged', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    // Three different leads that share a companyKey.
    await store.addNumbers([
      lead({ id: 'same-1', phone: '+66 80-000-0001', website: 'https://acme.example', title: 'One' }),
      lead({ id: 'same-2', phone: '+6680000002', website: 'https://www.acme.example/x', title: 'Two' }),
      lead({ id: 'same-3', phone: '+6680000003', website: 'http://acme.example:8443', title: 'Three' })
    ]);
    const rows = await store.getCollectedNumbers();
    assert.strictEqual(rows.length, 3, 'no automatic merge: three leads stay three leads');
    assert.strictEqual(new Set(rows.map(r => r.companyKey)).size, 1, 'all three share one grouping key');
    assert.deepStrictEqual(new Set(rows.map(r => r.phone)).size, 3, 'each phone is still its own lead');

    // The same phone in another format is still the same lead: dedup identity
    // is unchanged and the merge only fills empty metadata.
    const res = await store.addNumbers([
      lead({ id: 'same-4', phone: '+66 80-000-0001', website: 'https://other.example', address: '5 Other Rd' })
    ]);
    assert.deepStrictEqual(res, { added: 0, duplicates: 1 }, 'phone identity is still canonicalPhone');
    const after = await store.getCollectedNumbers();
    assert.strictEqual(after.length, 3, 'the duplicate changed no row count');
    const first = after.find(r => r.id === 'same-1');
    assert.strictEqual(first.website, 'https://acme.example', 'an existing non-empty value wins');
    assert.strictEqual(first.address, '5 Other Rd', 'an empty field is filled from the incoming row');
    assert.strictEqual(first.companyKey, 'acme.example', 'the key follows the stored website');
    // The canonicalPhone function itself is byte-identical to the B1 version.
    const canonical = between(storeSource, 'function canonicalPhone(phone) {', '\n}');
    assert.strictEqual(canonical, 'function canonicalPhone(phone) {\n'
      + "  if (typeof phone !== 'string') return phone;\n"
      + "  return phone.replace(/[\\s\\-.()]/g, '');");
  });

  test('18. a provider or import payload can never supply the company fields', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    const injected = lead({ id: 'inject-1', website: 'https://acme.example', title: 'Acme Co., Ltd.' });
    injected.companyKey = 'attacker-chosen';
    injected.companyId = 'attacker-ref';
    await store.addNumbers([injected]);
    const row = await rowById(store, 'inject-1');
    assert.strictEqual(row.companyKey, 'acme.example', 'the derived key wins over a smuggled value');
    assert.strictEqual(row.companyId, null, 'companyId cannot be set from a collection/import payload');
    assert.ok(!schemaColumns(store.db).includes('companyKey'), 'the smuggled key is never stored');
    // ...and the stored bytes carry no key at all: it is recomputed per read.
    const stored = store.db.exec("SELECT * FROM numbers WHERE id = 'inject-1'");
    assert.ok(!stored[0].columns.includes('companyKey'));
    const jsonStore = await openJsonStore([injected]);
    const jsonRow = await rowById(jsonStore, 'inject-1');
    assert.strictEqual(jsonRow.companyKey, 'acme.example', 'the JSON path derives it too');
    assert.strictEqual(jsonRow.companyId, null);
  });

  // --- 19/20. surface boundaries ---

  test('19. P1-D adds no provider, network or dependency surface', () => {
    for (const term of ['fetch(', 'https.request', 'XMLHttpRequest', 'axios', 'net.request']) {
      assert.ok(!P1D_BLOCK.includes(term), 'no network call in the P1-D block: ' + term);
    }
    assert.ok(!/logger\.[a-z]+\([^)]*(companyKey|companyId|website|title|address)/.test(P1D_BLOCK),
      'no company-derived lead content is logged');
    for (const banned of ['companies', 'contact', 'merge', 'fuzzy', 'similarity', 'denylist', 'free-mail', 'gmail.com']) {
      assert.ok(!new RegExp(banned, 'i').test(P1D_BLOCK), 'no P1-D feature surface: ' + banned);
    }
    // The provider stack is untouched.
    for (const file of ['coreclawClient.js', 'providers/coreclawAdapter.js', 'providers/providerManager.js',
      'credentialVault.js', 'proxyDetector.js']) {
      const source = fs.readFileSync(path.join(root, 'src', 'main', file), 'utf8');
      assert.ok(!/companyKey|companyId/.test(source), 'provider stack untouched: ' + file);
    }
    // The only production dependency change in the project's history is the
    // deliberate prospect-research trio; no dev dependency was introduced.
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
      'production dependencies are exactly the two originals plus the three prospect-research ones');
    assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
      ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
      'no dev dependency added');
  });

  test('20. the Lead Library table, filters and the Lead Profile surface are unchanged', () => {
    // No company column in the main Lead Library table and no new filter.
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
    for (const column of ['<th>Company</th>', '<th>Company Key</th>', '<th>Company ID</th>']) {
      assert.ok(!table.includes(column), 'no company column in the Lead Library table: ' + column);
    }
    const searchFields = between(storeSource, 'const QUERY_SEARCH_FIELDS =', '];');
    const filterFields = between(storeSource, 'const QUERY_FILTER_FIELDS =', '];');
    const sortColumns = between(storeSource, 'const QUERY_SORT_COLUMNS =', '};');
    for (const surface of [searchFields, filterFields, sortColumns]) {
      assert.ok(!/company/i.test(surface), 'the company fields are not searchable, filterable or sortable');
    }
    for (const field of ['companyKey', 'companyId']) {
      assert.ok(!mainSource.includes(field), 'main.js exposes no company filter/validator: ' + field);
      assert.ok(!preloadSource.includes(field), 'preload exposes no company method: ' + field);
    }
    // The company foundation appears only in the Lead Profile, read-only.
    assert.ok(htmlSource.includes('id="lead-detail-company"'), 'the Lead Profile company region exists');
    assert.ok(/id="lead-detail-company" hidden/.test(htmlSource), 'it starts hidden');
    assert.ok(htmlSource.includes('id="lead-detail-company-body"'), 'with a body to render into');
    const companyStart = htmlSource.indexOf('id="lead-detail-company"');
    const companyHtml = htmlSource.slice(companyStart, htmlSource.indexOf('Leads sharing a company key') + 200);
    assert.ok(!/<input|<select|<button/.test(companyHtml), 'the company region has no editable control');
    const region = between(rendererSource, '// === P1-D company foundation', '// === P1-A deterministic data-quality');
    assert.ok(region.includes('populateLeadCompany'), 'the renderer populates the region');
    assert.ok(!/appAPI\.|ipcRenderer/.test(region), 'the company region performs no IPC');
    assert.ok(region.includes('companyKey') && region.includes('companyId'), 'both values are shown');
    const open = between(rendererSource, 'async function openLeadDetail', 'function closeLeadDetail');
    assert.ok(open.includes('populateLeadCompany(lead)'), 'the profile populates it on open');
    const close = between(rendererSource, 'function closeLeadDetail', "getElementById('numbers-table-body')");
    assert.ok(close.includes('lead-detail-company'), 'and hides it on close');
    assert.ok(!close.includes('deriveCompanyKey'), 'closing never recomputes a derived value');
  });

  test('21. an existing companyId survives recollection, import and provider refresh', async () => {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(path.join(dataDir, 'numbers.json'), { force: true });
    const POINTER = 'company-123';

    // The association is established out of band (there is no P1-D write
    // path), exactly as a later phase would leave it.
    const associated = lead({ id: 'own-1', phone: '+66900000001', website: 'https://acme.example', address: '3 B3 Rd' });
    const establish = (store) => {
      if (store.db) store.db.run('UPDATE numbers SET companyId = ? WHERE id = ?', [POINTER, 'own-1']);
      else store._numbers.find(r => r.id === 'own-1').companyId = POINTER;
    };

    const sqlStore = await openStore();
    await sqlStore.addNumbers([{ ...associated }]);
    for (const store of [sqlStore, await openJsonStore([associated])]) {
      const storage = store.db ? 'sql' : 'json';
      establish(store);
      assert.strictEqual((await rowById(store, 'own-1')).companyId, POINTER, storage + ': precondition');

      // 1. recollection of the same lead (same canonical phone, new metadata),
      //    carrying a hostile companyId AND a hostile companyKey.
      await store.addNumbers([lead({
        id: 'own-1', phone: '+66 90-000-0001', source: 'src', keyword: 'kw2',
        status: 'pending', collectedAt: '2026-05-02T00:00:00.000Z',
        title: 'Other Name', website: 'https://other.example', address: '9 Other Rd',
        companyId: 'attacker-ref', companyKey: 'attacker-key'
      })]);
      let row = await rowById(store, 'own-1');
      assert.strictEqual(row.companyId, POINTER, storage + ': a recollection cannot clear companyId');
      assert.strictEqual(row.companyId !== 'attacker-ref', true, storage + ': a payload cannot overwrite companyId');
      assert.strictEqual(row.companyKey, 'acme.example',
        storage + ': the stored website still wins, the payload key is ignored');
      assert.strictEqual(row.website, 'https://acme.example', storage + ': first non-empty value still wins');

      // 2. a second import of the same lead, with no company field at all.
      await store.addNumbers([lead({ id: 'own-1', phone: '+66900000001', source: 'src3', keyword: 'kw3',
        status: 'pending', collectedAt: '2026-05-03T00:00:00.000Z' })]);
      row = await rowById(store, 'own-1');
      assert.strictEqual(row.companyId, POINTER, storage + ': a payload without companyId cannot clear it');

      // 3. an explicitly null/empty companyId in the payload is not a clear.
      for (const value of [null, '', undefined]) {
        const payload = lead({ id: 'own-1', phone: '+66900000001', source: 'src', keyword: 'kw',
          status: 'pending', collectedAt: '2026-05-01T00:00:00.000Z' });
        if (value !== undefined) payload.companyId = value;
        await store.addNumbers([payload]);
        assert.strictEqual((await rowById(store, 'own-1')).companyId, POINTER,
          storage + ': an explicit ' + JSON.stringify(value) + ' cannot clear the pointer');
      }

      // 4. a payload still cannot establish a pointer on an unassociated lead.
      await store.addNumbers([lead({ id: 'own-2', phone: '+66900000009', companyId: 'attacker-ref' })]);
      assert.strictEqual((await rowById(store, 'own-2')).companyId, null,
        storage + ': a payload cannot create a company association');

      // 5. a B6 or P1-C write is not a company write either.
      await store.setLeadUserFields({ id: 'own-1', qualification: 'qualified', tags: ['vip'], notes: 'n' });
      await store.setLeadUserStatuses({ id: 'own-1', websiteStatus: 'live' });
      row = await rowById(store, 'own-1');
      assert.strictEqual(row.companyId, POINTER, storage + ': user-field writes keep the pointer');
      assert.strictEqual(row.qualification, 'qualified');
      assert.strictEqual(row.websiteStatus, 'live');

      // 6. delete + failed-persist rollback keeps the pointer (the SQL branch
      //    is the only one with a rollback path; the JSON branch never calls
      //    saveDB, so a forced failure cannot be simulated there).
      if (store.db) {
        const realSave = store.saveDB;
        store.saveDB = () => { throw new Error('forced persistence failure'); };
        await assert.rejects(() => store.deleteNumbers(['own-1']), /forced persistence failure/);
        store.saveDB = realSave;
        const restored = await rowById(store, 'own-1');
        assert.ok(restored, storage + ': the row is restored');
        assert.strictEqual(restored.companyId, POINTER, storage + ': rollback keeps the pointer');
        assert.strictEqual(restored.qualification, 'qualified', storage + ': and the B6 values');
      } else {
        let saveCalls = 0;
        const realSave = store.saveDB;
        store.saveDB = () => { saveCalls++; return realSave.call(store); };
        await store.deleteNumbers(['own-2']);
        store.saveDB = realSave;
        assert.strictEqual(saveCalls, 0, storage + ': the JSON delete path has no SQL rollback to lose the column');
      }
    }
  });

  test('22. the legacy numbers.json -> SQL migration carries an existing companyId', async () => {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(path.join(dataDir, 'numbers.json'), { force: true });
    const jsonPath = path.join(dataDir, 'numbers.json');
    // The app's own storage file, as a JSON-fallback session would have left
    // it: a derived (and therefore stale) key plus a real pointer.
    const stored = lead({ id: 'mig-1', phone: '+66900000001', website: 'https://acme.example' });
    stored.companyId = 'company-123';
    stored.companyKey = 'stale-derived-key';
    fs.writeFileSync(jsonPath, JSON.stringify([stored], null, 2));

    const store = await openStore();
    const row = await rowById(store, 'mig-1');
    assert.ok(row, 'the legacy row is migrated');
    assert.strictEqual(row.companyId, 'company-123', 'the existing pointer survives the storage transition');
    assert.strictEqual(row.companyKey, 'acme.example', 'companyKey stays derived: the stored one is discarded');
    assert.ok(!schemaColumns(store.db).includes('companyKey'), 'the key is never a column');

    // It is a fill, never an overwrite: a row that already has a pointer keeps
    // its own, and a row with no pointer in the file stays NULL.
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(path.join(dataDir, 'numbers.json'), { force: true });
    const seeded = await openStore();
    await seeded.addNumbers([
      lead({ id: 'mig-2', phone: '+66900000002', website: 'https://two.example' }),
      lead({ id: 'mig-3', phone: '+66900000003', website: 'https://three.example' }),
      lead({ id: 'mig-4', phone: '+66900000004', website: 'https://four.example' })
    ]);
    seeded.db.run("UPDATE numbers SET companyId = 'existing-pointer' WHERE id = 'mig-2'");
    seeded.saveDB();
    fs.writeFileSync(jsonPath, JSON.stringify([
      { ...lead({ id: 'mig-2', phone: '+66900000002', website: 'https://two.example' }), companyId: 'file-pointer' },
      { ...lead({ id: 'mig-3', phone: '+66900000003', website: 'https://three.example' }), companyId: 'file-pointer-3' },
      { ...lead({ id: 'mig-4', phone: '+66900000004', website: 'https://four.example' }), companyId: '' }
    ], null, 2));

    const again = await openStore();
    assert.strictEqual((await rowById(again, 'mig-2')).companyId, 'existing-pointer',
      'a pointer already in the database is never overwritten by the file');
    assert.strictEqual((await rowById(again, 'mig-3')).companyId, 'file-pointer-3',
      'an unassociated row gains the pointer stored by this app');
    assert.strictEqual((await rowById(again, 'mig-4')).companyId, null,
      'an empty file value is not an association');
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
