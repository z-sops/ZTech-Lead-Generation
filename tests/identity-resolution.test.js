'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// P1-E: deterministic duplicate REVIEW for human inspection.
//
// The classification functions under test are lifted from the store source, and
// the store itself is exercised on both storage branches, so these tests cannot
// drift from the shipped implementation. P1-E is read-only: nothing here
// writes, combines or deletes a lead, and the tests assert that as well.
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

// The P1-E block plus the P1-D helpers it reuses (website host, text
// normalisation, companyKey derivation, canonicalPhone).
const P1E_BLOCK = between(
  storeSource,
  '// === P1-E identity resolution: deterministic duplicate REVIEW (read-only) ===',
  '// Exact provenance literal written by the manual-import save path'
);
const P1D_BLOCK = between(
  storeSource,
  '// === P1-D company foundation (derived, read-only) ===',
  '// === P1-E identity resolution'
);
const CANONICAL_PHONE = between(storeSource, 'function canonicalPhone(phone) {', '\n}') + '\n}';
const p1e = new Function(
  P1D_BLOCK + '\n' + CANONICAL_PHONE + '\n' + P1E_BLOCK
  + '\nreturn { duplicateReviewRuleKey, duplicateReviewEmailKey, duplicateReviewTitleAddressKey,'
  + ' duplicateReviewPhoneKey, DUPLICATE_REVIEW_RULES, DUPLICATE_RULE_PRECEDENCE,'
  + ' DUPLICATE_RULE_CLASS, DUPLICATE_CLASS_UNIQUE, DUPLICATE_REVIEW_LEAD_FIELDS,'
  + ' companyKeyWebsiteHost, companyKeyText, deriveCompanyKey, canonicalPhone };'
)();

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p1e-identity-'));

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
  const { AccountStore, normalizeLeadRow } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');

  const lead = (over = {}) => ({
    id: 'i-1', phone: '+66900000001', source: 'src', keyword: 'kw',
    status: 'pending', collectedAt: '2026-06-01T00:00:00.000Z',
    title: '', website: '', email: '', address: '', runSlug: '',
    ...over
  });

  // canonicalPhone is the lead identity, so the store's add path can never hold
  // two leads with the same phone. A library that does contain one - legacy
  // bytes, a hand-edited file, a future identity change - is exactly what the
  // EXACT rule exists to surface, so it is seeded through the raw insert the
  // tests already use for stored fixtures.
  const EXACT_INSERT = 'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt,'
    + ' title, website, email, address, runSlug) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

  function insertRowsDirectly(store, rows) {
    for (const row of rows) {
      if (store.db) {
        store.db.run(EXACT_INSERT, [row.id, row.phone, row.source, row.keyword, row.status,
          row.collectedAt, row.title, row.website, row.email, row.address, row.runSlug]);
      } else {
        store._numbers.push({ ...row });
      }
    }
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  async function openJsonStore(rows) {
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    store._numbers = rows.map(r => JSON.parse(JSON.stringify(r)));
    for (const row of store._numbers) normalizeLeadRow(row);
    return store;
  }

  function dbBytes(store) {
    return store.db ? Buffer.from(store.db.export()) : fs.readFileSync(path.join(dataDir, 'numbers.json'));
  }

  // The review library: three exact-duplicate pairs plus a unique lead, and a
  // pair that must NEVER match because its shared data is missing.
  const LIBRARY = [
    lead({ id: 'host-1', phone: '+66900000011', website: 'https://acme.example/menu', title: 'Acme One', address: '1 A Rd' }),
    lead({ id: 'host-2', phone: '+66900000012', website: 'http://www.ACME.example:8443/x?y=1#f', title: 'Acme Two', address: '2 B Rd' }),
    lead({ id: 'mail-1', phone: '+66900000021', website: 'https://one.example', email: 'Sales@One.Example', title: 'Mail One', address: '3 C Rd' }),
    lead({ id: 'mail-2', phone: '+66900000022', website: 'https://two.example', email: ' sales@one.example ', title: 'Mail Two', address: '4 D Rd' }),
    lead({ id: 'pair-1', phone: '+66900000031', website: 'https://three.example', title: 'Noodle Bar', address: '5 E Rd' }),
    lead({ id: 'pair-2', phone: '+66900000032', website: 'https://four.example', title: '  NOODLE   bar, ', address: '5-e-rd' }),
    lead({ id: 'blank-1', phone: '+66900000041' }),
    lead({ id: 'blank-2', phone: '+66900000042' }),
    lead({ id: 'solo', phone: '+66900000051', website: 'https://solo.example', email: 'solo@solo.example', title: 'Solo', address: '9 S Rd' })
  ];

  // --- 1/2/3/4. canonicalPhone and the website-host rule ---

  test('1. the canonicalPhone rule classifies an exact phone identity as EXACT', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    // Two leads whose phones differ only in formatting: one identity, so the
    // library dedups them. The EXACT rule is proven on a library that actually
    // holds both, seeded through the raw insert.
    const res = await store.addNumbers([
      lead({ id: 'x-1', phone: '+66 90-000-0011', website: 'https://a.example' }),
      lead({ id: 'x-2', phone: '+66900000011', website: 'https://b.example' })
    ]);
    assert.deepStrictEqual(res, { added: 1, duplicates: 1 }, 'canonicalPhone identity unchanged');
    fs.rmSync(dbPath, { force: true });
    const exact = await openStore();
    insertRowsDirectly(exact, [
      lead({ id: 'x-1', phone: '+66 90-000-0011', website: 'https://a.example', title: 'A', address: '1 A' }),
      lead({ id: 'x-2', phone: '+66900000011', website: 'https://b.example', title: 'B', address: '2 B' })
    ]);
    const result = await exact.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    const row = result.rows.find(r => r.lead.id === 'x-1');
    assert.ok(row, 'the two leads are review candidates');
    assert.strictEqual(row.dupClass, 'EXACT');
    assert.strictEqual(row.dupReason, 'canonicalPhone');
    assert.ok(['x-1', 'x-2'].includes(row.candidate.id), 'the candidate is the other lead');
    assert.notStrictEqual(row.lead.id, row.candidate.id, 'a lead is never its own candidate');
    assert.strictEqual(p1e.DUPLICATE_RULE_CLASS.canonicalPhone, 'EXACT');
    // The same on the JSON branch, and parity holds.
    const jsonStore = await openJsonStore([]);
    insertRowsDirectly(jsonStore, [
      lead({ id: 'x-1', phone: '+66 90-000-0011', website: 'https://a.example', title: 'A', address: '1 A' }),
      lead({ id: 'x-2', phone: '+66900000011', website: 'https://b.example', title: 'B', address: '2 B' })
    ]);
    assert.deepStrictEqual(await jsonStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 }),
      await exact.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 }),
      'the EXACT classification is identical on both storages');
  });

  test('2. the same website host is LIKELY, whatever the title and address', async () => {
    const hostKey = lead({ website: 'https://acme.example' });
    assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', hostKey), 'acme.example');
    assert.strictEqual(p1e.DUPLICATE_RULE_CLASS['website-host'], 'LIKELY');
    // Different leads, same host: LIKELY, and the shared key is the host only.
    const a = p1e.duplicateReviewRuleKey('website-host', lead({ website: 'https://acme.example', title: 'One', address: '1 A' }));
    const b = p1e.duplicateReviewRuleKey('website-host', lead({ website: 'https://other.example', title: 'One', address: '1 A' }));
    assert.notStrictEqual(a, b, 'identical title/address does not override a different host');
  });

  test('3. the website host is www-normalised', () => {
    const expected = p1e.duplicateReviewRuleKey('website-host', lead({ website: 'https://acme.example' }));
    for (const website of ['https://www.acme.example', 'http://WWW.ACME.example/', 'https://www.acme.example/deep/path']) {
      assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', lead({ website })), expected,
        'www must not change the key: ' + website);
    }
    assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', lead({ website: 'https://www.www.acme.example' })),
      'www.acme.example', 'only a leading www. is stripped');
  });

  test('4. scheme, port, path, query and hash never change the host key', () => {
    const expected = p1e.duplicateReviewRuleKey('website-host', lead({ website: 'https://acme.example' }));
    const variants = [
      'http://acme.example', 'https://acme.example/', 'https://acme.example/a/b',
      'https://acme.example:8443', 'http://acme.example:80/x?y=1', 'https://acme.example?ref=x',
      'https://acme.example#frag', 'https://ACME.EXAMPLE/Path?Q=1#F'
    ];
    for (const website of variants) {
      assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', lead({ website })), expected, website);
    }
    // An unusable website is never a key, exactly as in P1-D.
    for (const website of ['', '   ', 'acme.example', 'nope', 'javascript:alert(1)', 'mailto:a@b.example', null]) {
      assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', lead({ website })), '', 'no key for: ' + JSON.stringify(website));
    }
  });

  // --- 5/6/7/8. the email and title+address rules ---

  test('5. the same email is LIKELY', async () => {
    assert.strictEqual(p1e.DUPLICATE_RULE_CLASS.email, 'LIKELY');
    const rows = await classify(lead({ id: 'e1', phone: '+66911111111', website: 'https://e1.example', email: 'a@shop.example', title: 'E1', address: '1 E' }),
      lead({ id: 'e2', phone: '+66911111112', website: 'https://e2.example', email: 'a@shop.example', title: 'E2', address: '2 E' }));
    assert.strictEqual(rows.get('e1').dupClass, 'LIKELY');
    assert.strictEqual(rows.get('e1').dupReason, 'email');
    assert.strictEqual(rows.get('e1').candidate.id, 'e2');
  });

  test('6. the email key is trimmed and lowercased', () => {
    const expected = p1e.duplicateReviewRuleKey('email', lead({ email: 'Sales@Shop.Example' }));
    for (const email of [' sales@shop.example', 'SALES@SHOP.EXAMPLE  ', '\tsales@shop.example\n']) {
      assert.strictEqual(p1e.duplicateReviewRuleKey('email', lead({ email })), expected, email);
    }
    assert.strictEqual(p1e.duplicateReviewRuleKey('email', lead({ email: '   ' })), '', 'a blank email is no key');
    assert.strictEqual(p1e.duplicateReviewEmailKey(42), '', 'a non-string email is no key');
  });

  test('7. the same title+address is POSSIBLE', async () => {
    assert.strictEqual(p1e.DUPLICATE_RULE_CLASS['title+address'], 'POSSIBLE');
    const rows = await classify(lead({ id: 'p1', phone: '+66922222221', website: 'https://p1.example', title: 'Noodle Bar', address: '5 E Rd' }),
      lead({ id: 'p2', phone: '+66922222222', website: 'https://p2.example', title: 'Noodle Bar', address: '5 E Rd' }));
    assert.strictEqual(rows.get('p1').dupClass, 'POSSIBLE');
    assert.strictEqual(rows.get('p1').dupReason, 'title+address');
  });

  test('8. title and address are normalised before comparison', () => {
    const expected = p1e.duplicateReviewRuleKey('title+address', lead({ title: 'Noodle Bar', address: '5 E Rd' }));
    for (const over of [
      { title: '  NOODLE   bar ', address: '5 E Rd' },
      { title: 'Noodle Bar.', address: '5-e-rd' },
      { title: 'Noodle\tBar', address: '5  E   Rd' },
      { title: 'noodle, bar', address: '5 E Rd' }
    ]) {
      assert.strictEqual(p1e.duplicateReviewRuleKey('title+address', lead(over)), expected, JSON.stringify(over));
    }
  });

  // --- 9/10/11. missing data never matches ---

  test('9. a missing website never matches, however many leads lack one', async () => {
    const rows = await classify(
      lead({ id: 'w1', phone: '+66933333331', website: '' }),
      lead({ id: 'w2', phone: '+66933333332', website: '' }),
      lead({ id: 'w3', phone: '+66933333333', website: 'not-a-url' })
    );
    for (const id of ['w1', 'w2', 'w3']) {
      assert.strictEqual(rows.get(id).dupClass, 'UNIQUE',
        'a lead with no usable website must not be grouped: ' + id);
      assert.strictEqual(rows.get(id).dupReason, '', 'no reason without a match: ' + id);
      assert.strictEqual(rows.get(id).candidate, null);
    }
    assert.strictEqual(p1e.duplicateReviewRuleKey('website-host', lead({ website: '' })), '');
    // A blank website is not even a key that could be compared.
    const index = p1e.duplicateReviewRuleKey('website-host', lead({ website: '' }));
    assert.notStrictEqual(index, ' ');
  });

  test('10. a missing email never matches, however many leads lack one', async () => {
    const rows = await classify(
      lead({ id: 'm1', phone: '+66944444441', website: 'https://m1.example', email: '' }),
      lead({ id: 'm2', phone: '+66944444442', website: 'https://m2.example', email: '   ' }),
      lead({ id: 'm3', phone: '+66944444443', website: 'https://m3.example' })
    );
    for (const id of ['m1', 'm2', 'm3']) {
      assert.strictEqual(rows.get(id).dupClass, 'UNIQUE', 'a lead with no email must not be grouped: ' + id);
    }
    assert.strictEqual(p1e.duplicateReviewRuleKey('email', lead({ email: '' })), '');
    assert.strictEqual(p1e.duplicateReviewRuleKey('email', lead({ email: null })), '');
  });

  test('11. an incomplete title+address never matches', async () => {
    const rows = await classify(
      lead({ id: 't1', phone: '+66955555551', website: 'https://t1.example', title: 'Noodle Bar', address: '' }),
      lead({ id: 't2', phone: '+66955555552', website: 'https://t2.example', title: '', address: '5 E Rd' }),
      lead({ id: 't3', phone: '+66955555553', website: 'https://t3.example', title: 'Same Title', address: 'Same Address' }),
      lead({ id: 't4', phone: '+66955555554', website: 'https://t4.example', title: 'Same Title', address: 'Same Address' })
    );
    assert.strictEqual(rows.get('t1').dupClass, 'UNIQUE', 'a title without an address is no match');
    assert.strictEqual(rows.get('t2').dupClass, 'UNIQUE', 'an address without a title is no match');
    // The complete pair still matches, which proves the rule above is about
    // completeness and not about the rule being disabled.
    assert.strictEqual(rows.get('t3').dupClass, 'POSSIBLE');
    assert.strictEqual(rows.get('t4').dupClass, 'POSSIBLE');
    assert.strictEqual(p1e.duplicateReviewRuleKey('title+address', lead({ title: 'Only Title' })), '');
    assert.strictEqual(p1e.duplicateReviewRuleKey('title+address', lead({ title: '!!!', address: '5 E Rd' })), '');
  });

  // --- 12/13/14. classification is a fixed total order, with no fuzzy anything ---

  test('12. precedence is fixed and total, and a rule filter is deterministic', async () => {
    // One pair matching THREE rules at once (host, email, title+address): the
    // classification must always be the strongest one, in any read order.
    const same = [
      lead({ id: 'a1', phone: '+66966666661', website: 'https://all.example', email: 'a@all.example', title: 'All Co', address: '1 All Rd' }),
      lead({ id: 'a2', phone: '+66966666662', website: 'https://www.all.example/x', email: 'A@ALL.EXAMPLE', title: 'all co.', address: '1 all rd' })
    ];
    for (const rows of [await classify(...same), await classify(...same.slice().reverse())]) {
      for (const [id, entry] of rows) {
        assert.strictEqual(entry.dupClass, 'LIKELY', 'the host rule outranks email and title+address: ' + id);
        assert.strictEqual(entry.dupReason, 'website-host', id);
      }
    }
    // Email outranks title+address.
    const mailWins = await classify(
      lead({ id: 'b1', phone: '+66966666671', website: 'https://b1.example', email: 'b@same.example', title: 'Same Co', address: '9 Same Rd' }),
      lead({ id: 'b2', phone: '+66966666672', website: 'https://b2.example', email: 'B@SAME.EXAMPLE', title: 'same co', address: '9 same rd' })
    );
    assert.strictEqual(mailWins.get('b1').dupReason, 'email');
    assert.strictEqual(mailWins.get('b1').dupClass, 'LIKELY');
    // And the exact identity outranks all of them.
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    insertRowsDirectly(store, [
      lead({ id: 'c1', phone: '+66 90-000-0031', website: 'https://c1.example', email: 'c@same.example', title: 'C Co', address: '8 C Rd' }),
      lead({ id: 'c2', phone: '+66900000031', website: 'https://www.c1.example', email: 'C@SAME.EXAMPLE', title: 'c co', address: '8 c rd' })
    ]);
    const exactRows = (await store.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 })).rows;
    for (const row of exactRows) {
      assert.strictEqual(row.dupClass, 'EXACT', 'canonicalPhone outranks every other rule: ' + row.lead.id);
      assert.strictEqual(row.dupReason, 'canonicalPhone', row.lead.id);
    }
    assert.deepStrictEqual(p1e.DUPLICATE_RULE_PRECEDENCE,
      ['canonicalPhone', 'website-host', 'email', 'title+address'], 'precedence order is fixed');
    // Rule filters partition the same classification, deterministically.
    fs.rmSync(dbPath, { force: true });
    const filterStore = await openStore();
    await filterStore.addNumbers(LIBRARY.map(r => ({ ...r })));
    for (const rule of p1e.DUPLICATE_REVIEW_RULES) {
      const first = await filterStore.reviewDuplicates({ rule, limit: 50, offset: 0 });
      const second = await filterStore.reviewDuplicates({ rule, limit: 50, offset: 0 });
      assert.deepStrictEqual(first, second, 'two identical calls agree: ' + rule);
      for (const row of first.rows) {
        assert.ok(['EXACT', 'LIKELY', 'POSSIBLE'].includes(row.dupClass), 'a listed row has a candidate: ' + rule);
        if (rule !== 'all') assert.strictEqual(row.dupReason, rule, 'the filter selects exactly its rule: ' + rule);
      }
      assert.ok(first.rows.length <= first.total, 'paging is consistent');
    }
    const all = await filterStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    for (const rule of ['canonicalPhone', 'website-host', 'email', 'title+address']) {
      const only = await filterStore.reviewDuplicates({ rule, limit: 50, offset: 0 });
      for (const row of only.rows) {
        assert.ok(all.rows.some(a => a.lead.id === row.lead.id && a.dupReason === row.dupReason),
          'a filtered row is a subset of the unfiltered classification');
      }
    }
  });

  test('13. no approximate matching: near-miss values never match', () => {
    const pairs = [
      { rule: 'website-host', a: { website: 'https://acme.example' }, b: { website: 'https://acme.examples' } },
      { rule: 'website-host', a: { website: 'https://acme.example' }, b: { website: 'https://sub.acme.example' } },
      { rule: 'website-host', a: { website: 'https://acme.example' }, b: { website: 'https://acme.co' } },
      { rule: 'email', a: { email: 'a@shop.example' }, b: { email: 'a@shop.examples' } },
      { rule: 'email', a: { email: 'a@shop.example' }, b: { email: 'aa@shop.example' } },
      { rule: 'title+address', a: { title: 'Noodle Bar', address: '5 E Rd' }, b: { title: 'Noodle Barr', address: '5 E Rd' } },
      { rule: 'title+address', a: { title: 'Noodle Bar', address: '5 E Rd' }, b: { title: 'Noodle Bar', address: '5 E Road' } }
    ];
    for (const { rule, a, b } of pairs) {
      assert.notStrictEqual(
        p1e.duplicateReviewRuleKey(rule, lead(a)),
        p1e.duplicateReviewRuleKey(rule, lead(b)),
        'no approximate match for ' + JSON.stringify({ rule, a, b })
      );
    }
  });

  test('14. no score, confidence value, probability or ranking of likelihood', () => {
    // Comment-stripped, so prose that DENIES such a mechanism can never be
    // mistaken for one: only real code is scanned.
    const codeOnly = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const reviewRenderer = between(rendererSource, '// === P1-E duplicate review', '// === B5 Lead Library Dashboard ===');
    for (const term of ['score', 'confidence', 'probab', 'fuzzy', 'levenshtein', 'similarity',
      'distance', 'weight', 'threshold', 'rank', 'percent']) {
      assert.ok(!new RegExp(term, 'i').test(codeOnly(P1E_BLOCK)), 'the P1-E block introduces no: ' + term);
      assert.ok(!new RegExp(term, 'i').test(codeOnly(reviewRenderer)), 'the P1-E renderer section introduces no: ' + term);
    }
    // The only numbers a review row carries are the paging bounds.
    assert.deepStrictEqual(p1e.DUPLICATE_RULE_CLASS, {
      canonicalPhone: 'EXACT',
      'website-host': 'LIKELY',
      email: 'LIKELY',
      'title+address': 'POSSIBLE'
    }, 'the classification is a fixed mapping, not a computed value');
    assert.strictEqual(p1e.DUPLICATE_CLASS_UNIQUE, 'UNIQUE');
  });

  // --- 15/16. storage parity and read-only behaviour ---

  test('15. SQL and JSON storage produce equivalent classifications', async () => {
    fs.rmSync(dbPath, { force: true });
    const sqlStore = await openStore();
    await sqlStore.addNumbers(LIBRARY.map(r => ({ ...r })));
    const jsonStore = await openJsonStore(LIBRARY);
    for (const rule of p1e.DUPLICATE_REVIEW_RULES) {
      const sql = await sqlStore.reviewDuplicates({ rule, limit: 50, offset: 0 });
      const json = await jsonStore.reviewDuplicates({ rule, limit: 50, offset: 0 });
      assert.deepStrictEqual(json, sql, 'identical review envelope on both storages for rule: ' + rule);
    }
    const byLead = new Map(sqlStore && (await sqlStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 }))
      .rows.map(r => [r.lead.id, r]));
    assert.strictEqual(byLead.get('host-1').dupReason, 'website-host');
    assert.strictEqual(byLead.get('mail-1').dupReason, 'email');
    assert.strictEqual(byLead.get('pair-1').dupReason, 'title+address');
    assert.strictEqual(byLead.get('solo'), undefined, 'a lead with no candidate is not listed');
    // The same classification, lead by lead, including the projection shape.
    const jsonByLead = new Map((await jsonStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 }))
      .rows.map(r => [r.lead.id, r]));
    assert.deepStrictEqual(jsonByLead, byLead, 'per-lead parity');
    for (const row of byLead.values()) {
      for (const side of ['lead', 'candidate']) {
        assert.deepStrictEqual(Object.keys(row[side]).sort(), p1e.DUPLICATE_REVIEW_LEAD_FIELDS.slice().sort(),
          'a review row exposes exactly the review fields on the ' + side);
      }
      assert.ok(row.lead.companyKey !== undefined, 'companyKey is exposed');
    }
  });

  test('16. the review path performs no writes of any kind', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers(LIBRARY.map(r => ({ ...r })));
    const before = dbBytes(store);
    for (const rule of p1e.DUPLICATE_REVIEW_RULES) {
      await store.reviewDuplicates({ rule, limit: 50, offset: 0 });
      await store.reviewDuplicates({ rule, limit: 1, offset: 2 });
    }
    await store.reviewLeadDuplicates('host-1');
    assert.ok(before.equals(dbBytes(store)), 'reviewing changes no stored byte');

    // A JSON-fallback store over the same data: the file is untouched too, and
    // no saveDB call exists on the review path.
    const jsonStore = await openJsonStore(LIBRARY);
    const jsonBefore = JSON.stringify(jsonStore._numbers);
    await jsonStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    await jsonStore.reviewLeadDuplicates('host-1');
    assert.strictEqual(JSON.stringify(jsonStore._numbers), jsonBefore,
      'the JSON review path mutates no row');
    const jsonFile = path.join(dataDir, 'numbers.json');
    const fileBefore = fs.existsSync(jsonFile) ? fs.readFileSync(jsonFile, 'utf8') : null;
    if (fileBefore !== null) {
      assert.strictEqual(fs.readFileSync(jsonFile, 'utf8'), fileBefore, 'numbers.json is untouched');
    }
    // Bounded by the P1-F section: the review region is exactly the review
    // methods, not "everything after them".
    const reviewRegion = between(storeSource,
      '// === P1-E identity resolution: duplicate review (read-only) ===',
      '// === P1-F Target builder (user-owned definitions) ===');
    for (const forbidden of ['saveDB(', 'INSERT INTO', 'UPDATE numbers', 'DELETE FROM', 'deleteNumbers',
      'writeJsonAtomic', 'addNumbers', 'setLeadUserFields', 'setLeadUserStatuses', 'logger.', 'GROUP BY']) {
      assert.ok(!reviewRegion.includes(forbidden), 'the review path must not contain: ' + forbidden);
    }
    // No merge, no survivor selection, no data movement: the store exposes no
    // such capability and main.js registers no write channel for it.
    assert.ok(!storeSource.includes('mergeDuplicate'), 'no merge helper exists');
    assert.ok(!storeSource.includes('mergeLead'), 'no merge helper exists');
    // Comment-stripped everywhere: a comment that DENIES merging must not be
    // read as a merging surface.
    const codeOnly = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [name, src] of [['main.js', mainSource], ['preload.js', preloadSource], ['renderer.js', rendererSource]]) {
      assert.ok(!/\bmerge/i.test(codeOnly(src)), 'no merge symbol in ' + name);
    }
  });

  // --- 17/18/19/20. ownership invariants ---

  test('17. B6 qualification, tags and notes are untouched by a review', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers(LIBRARY.map(r => ({ ...r })));
    await store.setLeadUserFields({ id: 'host-1', qualification: 'qualified', tags: ['vip'], notes: 'keep' });
    const before = dbBytes(store);
    const result = await store.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    assert.ok(before.equals(dbBytes(store)), 'no write');
    const row = (await store.queryNumbers({ limit: 1, offset: 0, id: 'host-1' })).rows[0];
    assert.strictEqual(row.qualification, 'qualified');
    assert.deepStrictEqual(row.tags, ['vip']);
    assert.strictEqual(row.notes, 'keep');
    // A review row never even carries those fields, so it cannot be mistaken
    // for something to write back.
    const reviewed = result.rows.find(r => r.lead.id === 'host-1');
    for (const field of ['qualification', 'tags', 'notes']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(reviewed.lead, field),
        'a review row exposes no writable field: ' + field);
    }
  });

  test('18. the P1-C user statuses are untouched by a review', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers(LIBRARY.map(r => ({ ...r })));
    await store.setLeadUserStatuses({ id: 'host-1', websiteStatus: 'live', phoneStatus: 'verified' });
    const before = dbBytes(store);
    const result = await store.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    assert.ok(before.equals(dbBytes(store)), 'no write');
    const row = (await store.queryNumbers({ limit: 1, offset: 0, id: 'host-1' })).rows[0];
    assert.strictEqual(row.websiteStatus, 'live');
    assert.strictEqual(row.phoneStatus, 'verified');
    for (const field of ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus']) {
      assert.ok(!Object.prototype.hasOwnProperty.call(result.rows[0].lead, field),
        'a review row exposes no status field: ' + field);
    }
  });

  test('19. companyId and companyKey are never modified by a review', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers(LIBRARY.map(r => ({ ...r })));
    store.db.run("UPDATE numbers SET companyId = 'company-123' WHERE id = 'host-1'");
    store.saveDB();
    const before = dbBytes(store);
    const result = await store.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    assert.ok(before.equals(dbBytes(store)), 'the review changes no stored byte');
    const row = (await store.queryNumbers({ limit: 1, offset: 0, id: 'host-1' })).rows[0];
    assert.strictEqual(row.companyId, 'company-123', 'the pointer is untouched');
    assert.strictEqual(row.companyKey, 'acme.example', 'the derived key is unchanged');
    const reviewed = result.rows.find(r => r.lead.id === 'host-1');
    assert.strictEqual(reviewed.lead.companyKey, 'acme.example', 'the review reports the derived key as-is');
    // companyId is not even part of a review row: there is nothing to write.
    assert.ok(!Object.prototype.hasOwnProperty.call(reviewed.lead, 'companyId'));
    // Re-applying a review can never clear it either.
    await store.reviewDuplicates({ rule: 'email', limit: 10, offset: 0 });
    assert.strictEqual((await store.queryNumbers({ limit: 1, offset: 0, id: 'host-1' })).rows[0].companyId,
      'company-123', 'still untouched');
  });

  test('20. canonicalPhone remains the lead identity and no review mutates the library', async () => {
    fs.rmSync(dbPath, { force: true });
    const store = await openStore();
    await store.addNumbers(LIBRARY.map(r => ({ ...r })));
    const canonical = between(storeSource, 'function canonicalPhone(phone) {', '\n}');
    assert.strictEqual(canonical, 'function canonicalPhone(phone) {\n'
      + "  if (typeof phone !== 'string') return phone;\n"
      + "  return phone.replace(/[\\s\\-.()]/g, '');", 'canonicalPhone is byte-identical');
    assert.strictEqual(p1e.canonicalPhone('+66 90-000-0011'), '+66900000011');
    assert.strictEqual(p1e.duplicateReviewPhoneKey('+66 90-000-0011'), '+66900000011',
      'the review reuses the identity function, it does not define another');
    // Reviewing never changes the lead count, and the collection/import path is
    // unchanged: a re-collected phone still dedups exactly as before.
    const counts = (await store.getCollectedNumbers()).length;
    await store.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    assert.strictEqual((await store.getCollectedNumbers()).length, counts, 'the review adds and removes nothing');
    const again = await store.addNumbers([lead({ id: 'host-9', phone: '+66 90-000-0011', title: 'Imported' })]);
    assert.deepStrictEqual(again, { added: 0, duplicates: LIBRARY.length - LIBRARY.length + 1 },
      'the import dedup contract is unchanged');
  });

  // --- 21/22. main-process validation ---

  test('21. the rule must come from the explicit allowlist', () => {
    const validate = loadDuplicateReviewValidator();
    assert.deepStrictEqual(validate({ rule: 'all' }), { rule: 'all', limit: 20, offset: 0 });
    for (const rule of ['canonicalPhone', 'website-host', 'email', 'title+address']) {
      assert.deepStrictEqual(validate({ rule, limit: 10, offset: 5 }), { rule, limit: 10, offset: 5 });
    }
    for (const bad of ['', 'ALL', 'CanonicalPhone', 'website host', 'website-host ', 'title+address; DROP TABLE numbers',
      '*', 'sql', 'merge', 1, true, [], {}]) {
      expectInvalid(validate, { rule: bad });
    }
    // An absent rule is the documented default (null/absent collapse to it, the
    // codebase convention for optional fields), not a hole in the allowlist.
    assert.deepStrictEqual(validate({}), { rule: 'all', limit: 20, offset: 0 });
    assert.deepStrictEqual(validate({ rule: null }), { rule: 'all', limit: 20, offset: 0 });
    assert.deepStrictEqual(validate(undefined), { rule: 'all', limit: 20, offset: 0 });
    // The allowlist is a compile-time literal, never assembled from input.
    const allowlist = /const DUPLICATE_REVIEW_RULES = \[[^\]]*\];/.exec(mainSource);
    assert.ok(allowlist, 'the main-process allowlist is a literal array');
    for (const rule of ['all', 'canonicalPhone', 'website-host', 'email', 'title+address']) {
      assert.ok(allowlist[0].includes("'" + rule + "'"), 'the allowlist names: ' + rule);
    }
    assert.strictEqual((allowlist[0].match(/'/g) || []).length / 2, 5, 'exactly the five review rules');
  });

  test('22. limit and offset are validated with the shared paging bounds', () => {
    const validate = loadDuplicateReviewValidator();
    assert.deepStrictEqual(validate({ rule: 'all', limit: 1, offset: 0 }), { rule: 'all', limit: 1, offset: 0 });
    assert.deepStrictEqual(validate({ rule: 'all', limit: 100, offset: 100000 }), { rule: 'all', limit: 100, offset: 100000 });
    for (const limit of [0, -1, 101, 1.5, '20', true, [], {}, null]) {
      expectInvalid(validate, { rule: 'all', limit });
    }
    for (const offset of [-1, 100001, 0.5, '0', true, [], {}, null]) {
      expectInvalid(validate, { rule: 'all', offset });
    }
    // The payload can carry nothing but a rule and paging: no id, no field
    // list, no write target.
    const validated = validate({ rule: 'all', limit: 5, offset: 1, id: 'x', fields: ['notes'], merge: true });
    assert.deepStrictEqual(Object.keys(validated).sort(), ['limit', 'offset', 'rule'],
      'unknown keys never reach the store');
    // The store re-checks the same bounds defensively.
    fs.rmSync(dbPath, { force: true });
    return openStore().then(async (store) => {
      const result = await store.reviewDuplicates({ rule: 'nope', limit: 1e9, offset: -5 });
      assert.strictEqual(result.limit, 20, 'out-of-range limit falls back to the default');
      assert.strictEqual(result.offset, 0, 'out-of-range offset falls back to zero');
      assert.ok(Array.isArray(result.rows) && result.rows.length <= 20, 'a bounded read is returned');
      assert.strictEqual(await store.reviewLeadDuplicates(''), null);
      assert.strictEqual(await store.reviewLeadDuplicates(42), null);
      assert.strictEqual(await store.reviewLeadDuplicates('x'.repeat(101)), null);
    });
  });

  // --- 23/24/25/26/27. surface boundaries ---

  test('23. no provider, network, credential or external call is reachable from the review', () => {
    const reviewMain = between(mainSource, "ipcMain.handle('collector:duplicate-review'", '});');
    assert.ok(!/fetch|https?\.request|XMLHttpRequest|axios|net\.|require\('https'\)|getStore|credentialVault|providerManager|CoreClaw/.test(reviewMain),
      'the review handler performs no provider, network or credential call');
    assert.ok(!/fetch|https?\.request|XMLHttpRequest|net\.|providerManager|CoreClaw|adapter/.test(P1E_BLOCK),
      'the store review block performs no provider or network call');
    const reviewRenderer = between(rendererSource, '// === P1-E duplicate review', '// === B5 Lead Library Dashboard ===');
    assert.ok(!/fetch\(|XMLHttpRequest|https?:\/\//.test(reviewRenderer), 'the review panel performs no network call');
    // The provider architecture is untouched by P1-E.
    for (const file of ['src/main/coreClawClient.js', 'src/main/providers/coreclawAdapter.js',
      'src/main/providers/providerManager.js', 'src/main/providers/collectionProvider.js',
      'src/main/credentialVault.js', 'src/main/proxyDetector.js']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!/duplicate|DUPLICATE/.test(source), 'provider/credential stack untouched: ' + file);
    }
    // No PII logging: the review logs nothing at all.
    assert.ok(!/logger\./.test(P1E_BLOCK), 'the review block logs nothing');
    assert.ok(!/logger\./.test(reviewMain), 'the review handler logs no lead content');
  });

  test('24. the IPC channel is registered once, read-only, and allowlisted', () => {
    const channels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
    const occurrences = mainSource.split("ipcMain.handle('collector:duplicate-review'").length - 1;
    assert.strictEqual(occurrences, 1, 'registered exactly once');
    assert.strictEqual(new Set(channels).size, channels.length, 'no duplicate channel names');
    assert.ok(channels.includes('collector:duplicate-review'), 'the channel exists');
    assert.ok(!channels.some(ch => /duplicate|review|merge/.test(ch) && ch !== 'collector:duplicate-review'),
      'no sibling review or merge channel exists');
    // No dynamic channel construction anywhere in the changed files.
    for (const [name, src] of [['main.js', mainSource], ['preload.js', preloadSource]]) {
      assert.ok(!/new ipcMain\.handle|ipcMain\.handle\(\s*[a-zA-Z_$]/.test(src),
        name + ' must not build a channel name dynamically');
    }
    // The handler forwards a validated payload to a read-only store call.
    const handler = between(mainSource, "ipcMain.handle('collector:duplicate-review'", '});');
    assert.ok(handler.includes('validateDuplicateReviewPayload(query)'), 'the payload is validated');
    assert.ok(handler.includes('accountStore.reviewDuplicates('), 'delegated to the read-only review');
    for (const forbidden of ['accountStore.addNumbers', 'accountStore.deleteNumbers',
      'accountStore.setLeadUserFields', 'accountStore.setLeadUserStatuses', 'exportNumbers', 'saveDB']) {
      assert.ok(!handler.includes(forbidden), 'the handler calls no write path: ' + forbidden);
    }
    assert.ok(!/^\s*ipcMain\.handle\('collector:duplicate-review',\s*async/m.test(handler), 'handler shape unchanged');
  });

  test('25. the renderer and preload expose the minimum read-only review surface', () => {
    // Preload: exactly one method, forwarding the payload unchanged.
    assert.strictEqual(preloadSource.split('duplicateReview:').length - 1, 1, 'exactly one preload method');
    assert.strictEqual(preloadSource.split("invoke('collector:duplicate-review'").length - 1, 1,
      'exactly one invoke of the review channel');
    assert.ok(preloadSource.includes("duplicateReview: (query) => ipcRenderer.invoke('collector:duplicate-review', query)"),
      'the preload method forwards the query unchanged');
    for (const banned of ['mergeDuplicate', 'mergeLeads', 'updateLead', 'deleteNumbers']) {
      assert.ok(!/duplicateReview[\s\S]{0,120}/.test(preloadSource) || !new RegExp(banned).test(
        between(preloadSource, 'duplicateReview:', '}')), 'no write beside the review method: ' + banned);
    }
    // Renderer: the review section is display-only, escaped, handler-free
    // inline, and touches exactly one IPC method.
    const review = between(rendererSource, '// === P1-E duplicate review', '// === B5 Lead Library Dashboard ===');
    const calls = [...new Set([...review.matchAll(/appAPI\.collector\.(\w+)/g)].map(m => m[1]))].sort();
    assert.deepStrictEqual(calls, ['duplicateReview'], 'the review panel calls exactly one method');
    for (const forbidden of ['appAPI.collector.deleteNumbers', 'appAPI.collector.addNumbers',
      'appAPI.collector.updateLead', 'appAPI.collection.submit', 'appAPI.settings.save']) {
      assert.ok(!review.includes(forbidden), 'the review panel calls no write flow: ' + forbidden);
    }
    assert.ok(!/onclick=|onchange=|oninput=/i.test(review), 'no inline handler in the review section');
    assert.ok(review.includes('escapeHtml('), 'every rendered value is escaped');
    for (const field of ['dupClass', 'dupReason', 'lead', 'candidate']) {
      assert.ok(review.includes(field), 'the review renders ' + field);
    }
    // The HTML: a read-only container, one rule select, no editable control and
    // no merge affordance.
    assert.ok(htmlSource.includes('id="dup-review"'), 'the review container exists');
    assert.ok(/id="dup-review" hidden/.test(htmlSource), 'it starts hidden');
    assert.ok(htmlSource.includes('id="dup-review-rule"'), 'the rule select exists');
    for (const option of ['all', 'canonicalPhone', 'website-host', 'email', 'title+address']) {
      assert.ok(htmlSource.includes('<option value="' + option + '"'), 'rule option offered: ' + option);
    }
    const start = htmlSource.indexOf('class="dup-review"');
    const end = htmlSource.indexOf('Candidates share one exact key');
    assert.ok(start > -1 && end > start, 'the review container is locatable');
    const container = htmlSource.slice(start, end + 200);
    // No merge affordance: no control id or name suggests one, the only
    // controls are the rule select and the open/close buttons, and nothing
    // submits anywhere.
    assert.ok(!/id="[^"]*(merge|combine|survivor|delet|writ)/i.test(container), 'no merge/write control id');
    assert.deepStrictEqual(
      [...container.matchAll(/<(button|select|input)\b[^>]*id="([^"]+)"/g)].map(m => m[2]).sort(),
      ['btn-dup-review-close', 'btn-dup-review-open', 'dup-review-rule'],
      'exactly three controls: a rule select and open/close'
    );
    assert.ok(!/type="submit"/.test(container), 'nothing submits');
    assert.ok(!/onclick=|onchange=/i.test(container), 'no inline handler in the markup');
    // The rule vocabulary is owned by main, not duplicated in the renderer.
    assert.ok(!rendererSource.includes('canonicalPhone'), 'the renderer implements no identity rule');
  });

  test('26. no new dependency, provider capability or CSP change', () => {
    // The three Zuni-SEO runtime dependencies were added deliberately for
    // prospect research (MCP client + contract validation). Everything else is
    // still pinned, and no dev dependency was introduced.
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
      'production dependencies are exactly the two originals plus the three prospect-research ones');
    assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
      ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
      'no dev dependency added');
    assert.strictEqual(pkg.scripts.test, 'node tests/run-all.js', 'test wiring unchanged');
    assert.ok(mainSource.includes("contextIsolation: true"), 'contextIsolation unchanged');
    // The CSP meta line is untouched: locked byte-for-byte, including the
    // pre-existing style-src relaxation P1-E did not add.
    const csp = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(htmlSource);
    assert.ok(csp, 'the CSP meta line is present');
    assert.strictEqual(csp[0], '<meta http-equiv="Content-Security-Policy" content="default-src \'self\';'
      + ' script-src \'self\'; style-src \'self\' \'unsafe-inline\'; connect-src \'self\';'
      + ' object-src \'none\'; base-uri \'none\'; frame-src \'none\'">', 'CSP unchanged');
    assert.ok(!/unsafe-eval/.test(csp[0]), 'no script-src relaxation');
    // No new table, column or index: the review reads what already exists.
    // (P1-F adds the unrelated `targets` table, so the count is three.)
    assert.strictEqual((storeSource.match(/CREATE TABLE/g) || []).length, 3, 'three tables: numbers, jobs, targets');
    assert.strictEqual((storeSource.match(/CREATE INDEX/g) || []).length, 4, 'still exactly four indexes');
    assert.ok(!/CREATE INDEX[^;]*targets/.test(storeSource), 'no index is added for the review');
    assert.ok(!/dupClass|dupReason|duplicate/i.test(between(storeSource, 'CREATE TABLE IF NOT EXISTS numbers (', ')')),
      'no duplicate column was added to the numbers table');
  });

  test('27. no unexpected Lead Library schema, filter, export or search change', async () => {
    // The B2 query contract is untouched: the review is a separate read path.
    assert.ok(storeSource.includes("const QUERY_SEARCH_FIELDS = ['phone', 'title', 'website', 'email', 'address', 'source', 'keyword'];"),
      'search fields unchanged');
    assert.ok(storeSource.includes("const QUERY_FILTER_FIELDS = ['status', 'source', 'keyword', 'qualification'];"),
      'stored filter fields unchanged');
    for (const field of ['dupClass', 'dupReason']) {
      const searchFields = between(storeSource, 'const QUERY_SEARCH_FIELDS =', '];');
      const filterFields = between(storeSource, 'const QUERY_FILTER_FIELDS =', '];');
      const sortColumns = between(storeSource, 'const QUERY_SORT_COLUMNS =', '};');
      assert.ok(!searchFields.includes(field) && !filterFields.includes(field) && !sortColumns.includes(field),
        'duplicate review adds no query field: ' + field);
    }
    // The export is byte-identical: no review column, no duplicate column.
    const exportFn = between(storeSource, 'async exportNumbers(', '// === B4 local collection-job ledger ===');
    assert.ok(exportFn.includes('run_slug,qualification,tags,notes,phone_status,email_status,website_status,business_status'),
      'the CSV header is unchanged');
    assert.ok(!/dupClass|dupReason/.test(exportFn), 'the export carries no review field');
    // No new Lead Library table column.
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
    for (const column of ['<th>Duplicate</th>', '<th>Class</th>', '<th>Reason</th>', '<th>Company</th>']) {
      assert.ok(!table.includes(column), 'no review column in the Lead Library table: ' + column);
    }
    // The Lead Profile overlay is untouched by P1-E.
    const overlay = between(htmlSource, 'id="lead-detail-overlay"', 'id="view-dashboard"');
    assert.ok(!overlay.includes('dup-review'), 'the review panel is not inside the Lead Profile');
  });

  // Per-lead classification for a set of leads, exercised on both storages.
  // The list read deliberately omits leads with no candidate, so the UNIQUE
  // class is proven through the single-lead read; the two must agree.
  async function classify(...rows) {
    fs.rmSync(dbPath, { force: true });
    const sqlStore = await openStore();
    await sqlStore.addNumbers(rows.map(r => ({ ...r })));
    const jsonStore = await openJsonStore(rows);
    const sqlList = await sqlStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    const jsonList = await jsonStore.reviewDuplicates({ rule: 'all', limit: 50, offset: 0 });
    assert.deepStrictEqual(jsonList, sqlList, 'list parity for this set');
    const listed = new Map(sqlList.rows.map(row => [row.lead.id, row]));
    const out = new Map();
    for (const row of rows) {
      const sqlOne = await sqlStore.reviewLeadDuplicates(row.id);
      const jsonOne = await jsonStore.reviewLeadDuplicates(row.id);
      assert.deepStrictEqual(jsonOne, sqlOne, 'single-lead parity for ' + row.id);
      assert.ok(sqlOne, 'every stored lead has a classification: ' + row.id);
      // A lead with no candidate is UNIQUE and is NOT listed as a candidate.
      if (sqlOne.dupClass === 'UNIQUE') {
        assert.ok(!listed.has(row.id), 'a UNIQUE lead is not listed: ' + row.id);
        assert.strictEqual(sqlOne.candidate, null, 'a UNIQUE lead has no candidate: ' + row.id);
        assert.strictEqual(sqlOne.dupReason, '', 'a UNIQUE lead has no reason: ' + row.id);
      } else {
        assert.ok(listed.has(row.id), 'a candidate lead is listed: ' + row.id);
        assert.deepStrictEqual(listed.get(row.id), sqlOne, 'list and single-lead reads agree: ' + row.id);
      }
      out.set(row.id, sqlOne);
    }
    return out;
  }

  function loadDuplicateReviewValidator() {
    const allowlist = /const DUPLICATE_REVIEW_RULES = \[[^\]]*\];/.exec(mainSource)[0];
    const guards = between(mainSource, 'function invalidParams(', '// P1-E duplicate review: the rule vocabulary');
    const validator = between(mainSource, 'function validateDuplicateReviewPayload(', '// B2 query layer: the only sort identifiers');
    return new Function('logger', allowlist + '\n' + guards + '\n' + validator
      + '\nreturn validateDuplicateReviewPayload;')({ warn() {}, info() {}, error() {}, ok() {} });
  }

  function expectInvalid(validate, payload) {
    let err = null;
    try {
      validate(payload);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'payload must be refused: ' + JSON.stringify(payload));
    assert.strictEqual(err.invalidParams, true, 'refusal must carry invalidParams for rejectLog');
  }

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
