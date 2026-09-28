'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

// P1-A: deterministic, read-only data-quality signals.
//
// The functions under test are the real ones from the renderer: the block is
// extracted from source and executed, so these tests cannot drift from the
// shipped implementation the way a copy would.
const root = path.join(__dirname, '..');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const cssSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'styles.css'), 'utf8');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');

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
  assert.ok(close > from, 'function end found: ' + marker);
  return source.slice(from, close + 2);
}

// Comment-stripped view, so prose in a comment is never mistaken for logic.
function codeOnly(source) {
  return source.replace(/\/\/[^\n]*/g, '');
}

const P1A_START = '// === P1-A deterministic data-quality signals (read-only) ===';
// The whole P1-A section, ending before the next top-level statement so no
// document access is evaluated in this harness.
const p1aBlock = between(rendererSource, P1A_START, "document.getElementById('btn-delete-selected')");

// The block references isMobileNumber, escapeHtml and document. The pure signal
// functions need only isMobileNumber, which is lifted from its own source so
// the line-type rules under test are the shipped ones.
const mobileBlock = between(rendererSource, 'function isMobileNumber(phone) {', '\nfunction ');
const quality = new Function(
  'isMobileNumber',
  p1aBlock + '\nreturn { qualityPhoneKey, qualityPhoneSyntax, qualityPhoneCountry, qualityPhoneSignal,'
  + ' qualityEmailSignal, qualityWebsiteSignal, qualityCompleteness, leadQualitySignals,'
  + ' QUALITY_LINE_TYPE_COUNTRIES, QUALITY_COMPLETENESS_FIELDS,'
  + ' renderLeadQuality, populateLeadQuality, qualityText };'
)(new Function(mobileBlock + '\nreturn isMobileNumber;')());

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// --- 1/2. phone syntax and the canonical key -------------------------------

test('1. phone syntax mirrors the import validator rules', () => {
  for (const valid of ['+6681111111', '0812345678', '+66 81-111-1111', '+1 (555) 123-4567', '66811111111']) {
    assert.strictEqual(quality.qualityPhoneSyntax(valid), 'valid', 'accepts: ' + valid);
  }
  for (const invalid of ['abc', '+', '12', '1234', '++66811', 'tel:+66811', '+66 81a1111111', 'x'.repeat(51)]) {
    assert.strictEqual(quality.qualityPhoneSyntax(invalid), 'invalid', 'rejects: ' + invalid);
  }
  assert.strictEqual(quality.qualityPhoneSyntax('   '), 'unknown', 'whitespace-only is unknown');
  assert.strictEqual(quality.qualityPhoneSyntax(''), 'unknown', 'empty is unknown');
  assert.strictEqual(quality.qualityPhoneSyntax(null), 'unknown', 'null is unknown');
  assert.strictEqual(quality.qualityPhoneSyntax(undefined), 'unknown', 'undefined is unknown');
  assert.strictEqual(quality.qualityPhoneSyntax(66811111111), 'unknown', 'non-string is unknown');
});

test('2. canonical phone key matches the store key semantics', () => {
  assert.strictEqual(quality.qualityPhoneKey('+66 86-111.1111'), '+66861111111');
  assert.strictEqual(quality.qualityPhoneKey('  +1 (555) 123-4567 '), '+15551234567');
  assert.strictEqual(quality.qualityPhoneKey('0812345678'), '0812345678', 'letters would be kept verbatim');
  // The store key is the reference: identical output for the same inputs.
  const storeKey = new Function(
    functionSource(storeSource, 'function canonicalPhone(phone) {') + '\nreturn canonicalPhone;'
  )();
  for (const sample of ['+66 86-111.1111', '+1 (555) 123-4567', '0812 345 678', '+86.138.0013.8000']) {
    assert.strictEqual(quality.qualityPhoneKey(sample), storeKey(sample),
      'profile key matches the store key for: ' + sample);
  }
});

// --- 3/4/5. country and line type -------------------------------------------

test('3. supported country prefixes are detected', () => {
  assert.strictEqual(quality.qualityPhoneCountry('+66811111111'), '+66');
  assert.strictEqual(quality.qualityPhoneCountry('+8613800138000'), '+86');
  assert.strictEqual(quality.qualityPhoneCountry('+15551234567'), '+1');
  assert.strictEqual(quality.qualityPhoneCountry('+919876543210'), '+91');
  assert.strictEqual(quality.qualityPhoneCountry('+628123456789'), '+62');
  assert.strictEqual(quality.qualityPhoneCountry('+84987654321'), '+84');
  assert.strictEqual(quality.qualityPhoneCountry('+60123456789'), '+60');
  assert.strictEqual(quality.qualityPhoneCountry('+639171234567'), '+63');
  for (const prefix of quality.QUALITY_LINE_TYPE_COUNTRIES) {
    assert.ok(prefix.startsWith('+'), 'country table holds prefixed codes only');
  }
});

test('4. an unsupported country is unknown, never assumed landline', () => {
  assert.strictEqual(quality.qualityPhoneCountry('+33123456789'), null, 'France has no local rule');
  assert.strictEqual(quality.qualityPhoneCountry('+971501234567'), null, 'UAE has no local rule');
  assert.strictEqual(quality.qualityPhoneCountry('0812345678'), null, 'no country code at all');
  const signal = quality.qualityPhoneSignal('+33123456789');
  assert.strictEqual(signal.lineType, 'unknown', 'unsupported country stays unknown');
  assert.strictEqual(signal.country, 'unknown');
  assert.strictEqual(signal.syntax, 'valid', 'the number itself is still syntactically valid');
  assert.strictEqual(quality.qualityPhoneSignal('+971501234567').lineType, 'unknown');
});

test('5. line type follows the existing country rules for supported countries', () => {
  assert.strictEqual(quality.qualityPhoneSignal('+66811111111').lineType, 'mobile', 'TH mobile');
  assert.strictEqual(quality.qualityPhoneSignal('+6622222222').lineType, 'landline', 'TH landline');
  assert.strictEqual(quality.qualityPhoneSignal('+8613800138000').lineType, 'mobile', 'CN mobile');
  assert.strictEqual(quality.qualityPhoneSignal('+862112345678').lineType, 'landline', 'CN landline');
  assert.strictEqual(quality.qualityPhoneSignal('+15551234567').lineType, 'mobile', 'US mobile');
  // A syntactically broken number never gets a line type.
  assert.strictEqual(quality.qualityPhoneSignal('+66abc').lineType, 'unknown');
  assert.strictEqual(quality.qualityPhoneSignal('').lineType, 'unknown');
});

// --- 6/7. email ------------------------------------------------------------

test('6. email syntax is deterministic and never claims deliverability', () => {
  for (const valid of ['a@b.com', 'first.last@sub.example.co.uk', 'x+tag@example.org']) {
    assert.strictEqual(quality.qualityEmailSignal(valid).syntax, 'valid', 'accepts: ' + valid);
  }
  for (const invalid of ['plain', 'a@b', 'a@@b.com', '@b.com', 'a b@c.com', 'a@b.', 'a@.com', 'a@b..com']) {
    assert.strictEqual(quality.qualityEmailSignal(invalid).syntax, 'invalid', 'rejects: ' + invalid);
  }
  assert.strictEqual(quality.qualityEmailSignal('').syntax, 'unknown');
  assert.strictEqual(quality.qualityEmailSignal(null).syntax, 'unknown');
  assert.strictEqual(quality.qualityEmailSignal('x'.repeat(501) + '@b.com').syntax, 'invalid',
    'longer than the stored 500-char bound is invalid');
});

test('7. email domain extraction is a pure lowercase substring', () => {
  assert.strictEqual(quality.qualityEmailSignal('Owner@Example.COM').domain, 'example.com');
  assert.strictEqual(quality.qualityEmailSignal('a@b.co.uk').domain, 'b.co.uk');
  assert.strictEqual(quality.qualityEmailSignal('bad').domain, '');
  // No free-mail or reputation list exists in the repository, so none is implied.
  assert.ok(!p1aBlock.includes('gmail'), 'no hard-coded free-mail provider list');
  assert.ok(!/deliverab|\bmx\b|reputation/i.test(codeOnly(p1aBlock)), 'no deliverability logic');
});

// --- 8/9. website ----------------------------------------------------------

test('8. website normalisation extracts a lowercased host without www', () => {
  const signal = quality.qualityWebsiteSignal('https://WWW.Example.com/pricing?a=1');
  assert.strictEqual(signal.syntax, 'valid');
  assert.strictEqual(signal.host, 'example.com');
  assert.strictEqual(signal.normalized, 'https://WWW.Example.com/pricing?a=1', 'value kept verbatim');
  assert.strictEqual(quality.qualityWebsiteSignal('http://example.com').host, 'example.com');
  assert.strictEqual(quality.qualityWebsiteSignal('https://sub.example.co.uk/x').host, 'sub.example.co.uk');
});

test('9. an unparseable or non-http website is invalid, empty is unknown', () => {
  for (const invalid of ['not a url', 'example.com', 'javascript:alert(1)', 'ftp://example.com', 'mailto:a@b.com']) {
    assert.strictEqual(quality.qualityWebsiteSignal(invalid).syntax, 'invalid', 'rejects: ' + invalid);
  }
  assert.strictEqual(quality.qualityWebsiteSignal('').syntax, 'unknown');
  assert.strictEqual(quality.qualityWebsiteSignal('   ').syntax, 'unknown');
  assert.strictEqual(quality.qualityWebsiteSignal(null).syntax, 'unknown');
  assert.strictEqual(quality.qualityWebsiteSignal(undefined).host, '');
});

// --- 10/11. completeness and malformed input --------------------------------

test('10. completeness counts the five lead fields deterministically', () => {
  const full = { phone: '+66811111111', title: 'T', website: 'https://e.com', email: 'a@b.com', address: 'A' };
  assert.strictEqual(quality.qualityCompleteness(full).presentCount, 5);
  assert.deepStrictEqual(quality.qualityCompleteness(full).missing, []);
  const partial = { phone: '+66811111111', title: 'T', website: '', email: '  ', address: 'A' };
  const signals = quality.qualityCompleteness(partial);
  assert.strictEqual(signals.presentCount, 3);
  assert.deepStrictEqual(signals.missing, ['website', 'email']);
  assert.strictEqual(signals.total, 5);
  assert.deepStrictEqual(quality.QUALITY_COMPLETENESS_FIELDS,
    ['phone', 'title', 'website', 'email', 'address'], 'the completeness set is fixed');
  const empty = quality.qualityCompleteness({});
  assert.strictEqual(empty.presentCount, 0);
  assert.strictEqual(empty.missing.length, 5);
});

test('11. empty, null and malformed lead input never throws', () => {
  for (const input of [null, undefined, {}, 'garbage', 42, []]) {
    const signals = quality.leadQualitySignals(input);
    assert.strictEqual(signals.phone.syntax, 'unknown');
    assert.strictEqual(signals.email.syntax, 'unknown');
    assert.strictEqual(signals.website.syntax, 'unknown');
    assert.strictEqual(signals.business.syntax, 'unknown');
    assert.ok(signals.completeness.presentCount >= 0 && signals.completeness.presentCount <= 5);
  }
  const business = quality.leadQualitySignals({}).business;
  assert.strictEqual(business.syntax, 'unknown', 'business status has no local evidence');
  assert.ok(/user-provided/.test(business.source), 'business status is attributed to the user, not derived');
});

// --- 12. output safety -----------------------------------------------------

test('12. rendered quality rows escape every interpolated value', () => {
  const escapeHtml = new Function(
    functionSource(rendererSource, 'function escapeHtml(value) {') + '\nreturn escapeHtml;'
  )();
  const rowBlock = between(rendererSource, 'function qualityRow(', 'function renderLeadQuality(');
  assert.ok(rowBlock.includes('escapeHtml(label)'), 'label escaped');
  assert.ok(rowBlock.includes('escapeHtml(value)'), 'value escaped');
  assert.ok(rowBlock.includes('escapeHtml(source)'), 'source escaped');
  // A hostile stored value must come out inert when escaped.
  const hostile = escapeHtml('<img src=x onerror=alert(1)>');
  assert.ok(!hostile.includes('<img'), 'markup is neutralised');
  assert.ok(hostile.includes('&lt;img'), 'angle brackets are encoded');
  const signals = quality.leadQualitySignals({ website: 'https://evil.example/"><script>' });
  assert.strictEqual(signals.website.host, 'evil.example', 'host extraction ignores injected markup');});

// --- 13/14/15. scope guarantees -------------------------------------------

test('13. the P1-A block performs no network call and no I/O', () => {
  for (const forbidden of ['fetch(', 'XMLHttpRequest', 'electron', 'net.fetch', 'appAPI', 'http://', 'https://']) {
    assert.ok(!p1aBlock.includes(forbidden), 'the signal block must not reference: ' + forbidden);
  }
  assert.ok(!/require\(|\bimport\b/.test(codeOnly(p1aBlock)), 'no module import in the signal block');
});

test('14. nothing is persisted: no store access, no writes, no new column', () => {
  assert.ok(!p1aBlock.includes('appAPI.collector'), 'no store write path is reachable');
  assert.ok(!p1aBlock.includes('addNumbers'), 'never inserts');
  assert.ok(!p1aBlock.includes('updateLead'), 'never updates a lead');
  assert.ok(!p1aBlock.includes('deleteNumbers'), 'never deletes');
  // The store is untouched by P1-A: no new column, no new field list entry.
  assert.ok(!storeSource.includes('qualityStatus'), 'no quality column in the store');
  assert.ok(!storeSource.includes('dataQuality'), 'no data-quality field in the store');
  // The lock targets the SCHEMA, not the file: a derived helper may legitimately
  // be called "completeness", but no DERIVED quality value may become a column.
  // The four P1-C status columns are stored on purpose, so they are excepted by
  // name and asserted separately.
  const schemaSurface = [
    between(storeSource, 'CREATE TABLE IF NOT EXISTS numbers (', ')'),
    between(storeSource, 'const LEAD_NEW_FIELDS =', '];'),
    between(storeSource, 'const LEAD_B6_FIELDS =', '];'),
    between(storeSource, 'const LEAD_B6_DEFAULTS =', '};')
  ].join('\n');
  for (const banned of ['phoneQuality', 'emailQuality', 'websiteQuality', 'businessQuality', 'verified']) {
    assert.ok(!new RegExp(banned, 'i').test(schemaSurface),
      'no derived quality value may become a stored column: ' + banned);
  }
  // The P1-C columns are the only status columns allowed, and only these four.
  // The pre-existing bare `status` lifecycle column is excluded by name.
  const statusColumns = [...schemaSurface.matchAll(/(\w*[Ss]tatus)\s+TEXT/g)]
    .map(m => m[1])
    .filter(name => name !== 'status');
  assert.deepStrictEqual(statusColumns,
    ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus'],
    'exactly the four user-provided status columns are stored');
  // P1-C supersedes the P1-A rule that main.js held no status validation: the
  // P1-C write path is now allowed, but it must stay exactly one validator and
  // one handler, with no other status surface in main or preload.
  assert.strictEqual(mainSource.split('function validateLeadQualityPayload(').length - 1, 1,
    'exactly one main-process status validator');
  assert.strictEqual(mainSource.split("ipcMain.handle('collector:update-lead-quality'").length - 1, 1,
    'exactly one status channel handler');
  assert.ok(!/validateNumbersPayload[\s\S]{0,400}(phoneStatus|emailStatus|websiteStatus|businessStatus)/.test(mainSource),
    'the collection/import payload validator still refuses status fields');
  assert.strictEqual(preloadSource.split('updateLeadQuality:').length - 1, 1,
    'preload exposes exactly the one status method');
  // The renderer may name the four fields, but only in the single controls map
  // that builds the payload, and only through the one preload method.
  for (const field of ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus']) {
    assert.strictEqual(rendererSource.split(field).length - 1, 1,
      'the renderer names ' + field + ' exactly once, in the controls map');
  }
  assert.strictEqual(rendererSource.split('appAPI.collector.updateLeadQuality').length - 1, 1,
    'the renderer writes statuses through exactly one preload call');
  const channels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
  // F6 declared lock update: 26 -> 33, the seven sender-checked Lists channels.
  assert.strictEqual(channels.length, 33, 'exactly 33 IPC channels (P1-E, P1-F, P1-G and F6)');
});

test('15. B6 fields, Lead Library columns and the pipeline stages are untouched', () => {
  const openRegion = between(rendererSource, 'async function openLeadDetail', 'function closeLeadDetail');
  // B6 controls are still wired exactly as before, alongside the new read-only call.
  assert.ok(openRegion.includes('populateLeadDetailB6(lead)'), 'B6 form population preserved');
  assert.ok(openRegion.includes('populateLeadQuality(lead)'), 'P1-A populates on load');
  assert.ok(openRegion.includes('getNumbers({ limit: 1, offset: 0, id })'), 'B3 single-lead read unchanged');
  const closeRegion = between(rendererSource, 'function closeLeadDetail', "getElementById('numbers-table-body')");
  assert.ok(closeRegion.includes('lead-detail-quality'), 'the quality section is hidden on close');
  for (const fn of ['qualityPhoneSignal', 'qualityEmailSignal', 'qualityWebsiteSignal',
    'qualityCompleteness', 'leadQualitySignals', 'renderLeadQuality']) {
    assert.ok(!closeRegion.includes(fn), 'closing never recomputes a derived value: ' + fn);
  }
  // No Lead Library table column, and no qualification/tags/notes behaviour change.
  const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
  for (const column of ['<th>Quality</th>', '<th>Data Quality</th>', '<th>Line Type</th>', '<th>Country</th>']) {
    assert.ok(!table.includes(column), 'no quality column in the Lead Library table: ' + column);
  }
  assert.ok(htmlSource.includes('id="lead-detail-b6"'), 'the B6 form region still exists');
  assert.ok(htmlSource.includes('id="btn-save-lead-detail"'), 'the B6 save control still exists');
  assert.ok(htmlSource.includes('id="lead-detail-quality"'), 'the quality section is present');
  assert.ok(/id="lead-detail-quality" hidden/.test(htmlSource), 'the quality section starts hidden');
  assert.ok(htmlSource.includes('not third-party verification'),
    'the UI states that these are not third-party verifications');
  const save = between(rendererSource, 'async function saveLeadDetail()', "getElementById('btn-save-lead-detail').addEventListener");
  assert.ok(!/quality/i.test(save), 'the B6 save path is not extended by P1-A');
  // No pipeline/score vocabulary in executable code (comments are excluded: a
  // comment may legitimately explain that a score is NOT produced).
  for (const term of ['score', 'rank', 'probabilit', 'grade', 'pipeline', 'enrich']) {
    assert.ok(!new RegExp(term, 'i').test(codeOnly(p1aBlock)), 'no scoring vocabulary: ' + term);
  }
  assert.ok(cssSource.includes('.lead-detail-quality'), 'styles added');
  assert.ok(cssSource.includes('.lead-detail-source'), 'source-label style added');
  assert.ok(cssSource.includes('.lead-detail-quality[hidden]'), 'hidden state styled');
});

// === P1-B derived data-quality filters ===
// The store owns the authoritative predicate (both storage branches share it);
// the renderer only sends allowlisted values. These tests exercise the real
// store against real sql.js and JSON-fallback stores.

const os = require('os');
const storeTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p1b-'));
const logRecords = [];
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => storeTestRoot } }
};
const storeLoggerPath = require.resolve(path.join(root, 'src', 'main', 'logger.js'));
require.cache[storeLoggerPath] = {
  id: storeLoggerPath, filename: storeLoggerPath, loaded: true,
  exports: { logger: {
    info(category, message, data) { logRecords.push({ level: 'info', category, message, data }); },
    warn(category, message, data) { logRecords.push({ level: 'warn', category, message, data }); },
    error(category, message, data) { logRecords.push({ level: 'error', category, message, data }); },
    ok(category, message, data) { logRecords.push({ level: 'ok', category, message, data }); }
  } }
};
const { AccountStore } = require(path.join(root, 'src', 'main', 'accountStore.js'));

async function openStore() {
  const store = new AccountStore();
  await store.ready;
  return store;
}
async function openJsonStore() {
  const store = new AccountStore();
  await store.ready;
  store.db = null;
  store._numbers = [];
  return store;
}
// Fixtures give every field explicitly, including empty strings. That matters:
// B1 deliberately backfills a missing title from `source`, so a row without an
// explicit title would silently count as two present fields. Completeness must
// be asserted against intentional values, not against that legacy fallback.
async function seedQualityLibrary(store) {
  await store.addNumbers([
    { id: 'q-full', phone: '+66811111111', source: 'src', keyword: 'kw', status: 'pending', collectedAt: '2026-08-01T00:00:00.000Z', title: 'Full', website: 'https://full.example', email: 'a@b.com', address: 'A' },
    { id: 'q-phone', phone: '+66822222222', source: 'src', keyword: 'kw', status: 'pending', collectedAt: '2026-08-02T00:00:00.000Z', title: '', website: '', email: '', address: '' },
    { id: 'q-bad-email', phone: '+66833333333', source: 'src', keyword: 'kw', status: 'pending', collectedAt: '2026-08-03T00:00:00.000Z', title: 'Bad Email', website: '', email: 'nope', address: '' },
    { id: 'q-bad-site', phone: '+66844444444', source: 'other', keyword: 'kw2', status: 'pending', collectedAt: '2026-08-04T00:00:00.000Z', title: 'Bad Site', website: 'not-a-url', email: '', address: '' }
  ]);
  await store.setLeadUserFields({ id: 'q-phone', qualification: 'qualified', tags: ['vip'], notes: 'n' });
}
// A dedicated row for tests that must not inherit another test's statuses.
async function addPlainLead(store, id, phone) {
  await store.addNumbers([{
    id, phone, source: 'src', keyword: 'kw', status: 'pending',
    collectedAt: '2026-08-01T00:00:00.000Z', title: '', website: '', email: '', address: ''
  }]);
}
const ids = (result) => result.rows.map(r => r.id).sort();
const dbPath = path.join(storeTestRoot, 'data', 'whatsapp.db');

// A legacy 6-column database, migrated on first open, whose rows therefore
// carry NULL in every user-owned column until the startup repair runs.
async function seedLegacyNumbers() {
  const initSQL = require('sql.js');
  const SQL = await initSQL();
  const db = new SQL.Database();
  db.run(`CREATE TABLE numbers (
    id TEXT PRIMARY KEY, phone TEXT, source TEXT, keyword TEXT,
    status TEXT DEFAULT 'pending', collectedAt TEXT
  )`);
  db.run(
    'INSERT INTO numbers (id, phone, source, keyword, status, collectedAt) VALUES (?, ?, ?, ?, ?, ?)',
    ['null-b6', '+66990000000', 'Legacy', 'kw', 'pending', '2026-10-01T00:00:00.000Z']
  );
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
  db.close();
}

test('16. phone quality filters select exactly the matching leads', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const valid = await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: 'valid' } });
  assert.deepStrictEqual(ids(valid), ['q-bad-email', 'q-bad-site', 'q-full', 'q-phone'],
    'all four phones are syntactically valid');
  const unknown = await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: 'unknown' } });
  assert.deepStrictEqual(ids(unknown), [], 'no stored lead has an absent phone');
  const invalid = await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: 'invalid' } });
  assert.deepStrictEqual(ids(invalid), [], 'the import validator already refuses invalid phones');
});

test('17. email and website quality filters work from stored values', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const emailValid = await store.queryNumbers({ limit: 20, offset: 0, filters: { emailQuality: 'valid' } });
  assert.deepStrictEqual(ids(emailValid), ['q-full']);
  const emailUnknown = await store.queryNumbers({ limit: 20, offset: 0, filters: { emailQuality: 'unknown' } });
  assert.deepStrictEqual(ids(emailUnknown), ['q-bad-site', 'q-phone']);
  const emailInvalid = await store.queryNumbers({ limit: 20, offset: 0, filters: { emailQuality: 'invalid' } });
  assert.deepStrictEqual(ids(emailInvalid), ['q-bad-email'], 'the malformed email is invalid');
  const siteValid = await store.queryNumbers({ limit: 20, offset: 0, filters: { websiteQuality: 'valid' } });
  assert.deepStrictEqual(ids(siteValid), ['q-full']);
  const siteInvalid = await store.queryNumbers({ limit: 20, offset: 0, filters: { websiteQuality: 'invalid' } });
  assert.deepStrictEqual(ids(siteInvalid), ['q-bad-site'], 'a non-URL website is invalid');
  const siteUnknown = await store.queryNumbers({ limit: 20, offset: 0, filters: { websiteQuality: 'unknown' } });
  assert.deepStrictEqual(ids(siteUnknown), ['q-bad-email', 'q-phone']);
});

test('18. business quality never claims a local inference', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const unknown = await store.queryNumbers({ limit: 20, offset: 0, filters: { businessQuality: 'unknown' } });
  assert.strictEqual(unknown.total, 4, 'every lead is business-unknown today');
  for (const value of ['active', 'closed']) {
    const result = await store.queryNumbers({ limit: 20, offset: 0, filters: { businessQuality: value } });
    assert.strictEqual(result.total, 0, 'no lead is claimed ' + value + ' without evidence');
  }
});

test('19. the completeness filter matches the deterministic count', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const five = await store.queryNumbers({ limit: 20, offset: 0, filters: { completeness: '5' } });
  assert.deepStrictEqual(ids(five), ['q-full']);
  const three = await store.queryNumbers({ limit: 20, offset: 0, filters: { completeness: '3' } });
  assert.deepStrictEqual(ids(three), ['q-bad-email', 'q-bad-site'], 'phone + title + one contact field');
  const one = await store.queryNumbers({ limit: 20, offset: 0, filters: { completeness: '1' } });
  assert.deepStrictEqual(ids(one), ['q-phone']);
  const zero = await store.queryNumbers({ limit: 20, offset: 0, filters: { completeness: '0' } });
  assert.deepStrictEqual(ids(zero), [], 'every stored lead has a phone');
});

test('20. SQL and JSON filtering agree on every quality filter', async () => {
  const sqlStore = await openStore();
  const jsonStore = await openJsonStore();
  await seedQualityLibrary(sqlStore);
  await seedQualityLibrary(jsonStore);
  for (const filter of [
    { phoneQuality: 'valid' }, { phoneQuality: 'unknown' },
    { emailQuality: 'valid' }, { emailQuality: 'invalid' }, { emailQuality: 'unknown' },
    { websiteQuality: 'valid' }, { websiteQuality: 'invalid' }, { websiteQuality: 'unknown' },
    { businessQuality: 'unknown' }, { businessQuality: 'active' },
    { completeness: '5' }, { completeness: '3' }, { completeness: '1' }
  ]) {
    const q = { limit: 20, offset: 0, filters: filter };
    const sql = await sqlStore.queryNumbers(q);
    const json = await jsonStore.queryNumbers(q);
    assert.strictEqual(json.total, sql.total, 'parity total for ' + JSON.stringify(filter));
    assert.deepStrictEqual(ids(json), ids(sql), 'parity ids for ' + JSON.stringify(filter));
  }
});

test('21. quality filters combine with the existing filters, search, sort and paging', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const withQualification = await store.queryNumbers({
    limit: 20, offset: 0, filters: { qualification: 'qualified', completeness: '1' }
  });
  assert.deepStrictEqual(ids(withQualification), ['q-phone'], 'quality + qualification');
  const withStatus = await store.queryNumbers({
    limit: 20, offset: 0, filters: { status: 'pending', emailQuality: 'valid' }
  });
  assert.deepStrictEqual(ids(withStatus), ['q-full'], 'quality + status');
  const withSource = await store.queryNumbers({
    limit: 20, offset: 0, filters: { source: 'other', websiteQuality: 'invalid' }
  });
  assert.deepStrictEqual(ids(withSource), ['q-bad-site'], 'quality + source');
  const withSearch = await store.queryNumbers({
    limit: 20, offset: 0, search: 'Full', completeness: '5'
  });
  assert.deepStrictEqual(ids(withSearch), ['q-full'], 'search + quality');
  const searchExcluded = await store.queryNumbers({
    limit: 20, offset: 0, search: 'Full', filters: { emailQuality: 'invalid' }
  });
  assert.strictEqual(searchExcluded.total, 0, 'contradicting search and quality return nothing');
  const sorted = await store.queryNumbers({
    limit: 20, offset: 0, filters: { phoneQuality: 'valid' }, sort: 'title', order: 'asc'
  });
  assert.strictEqual(sorted.total, 4, 'sort applies inside the quality-filtered set');
  const paged = await store.queryNumbers({
    limit: 1, offset: 1, filters: { phoneQuality: 'valid' }
  });
  assert.strictEqual(paged.total, 4, 'total is the filtered size, not the page size');
  assert.strictEqual(paged.rows.length, 1, 'the page slice comes from the filtered set');
  const pagedLast = await store.queryNumbers({
    limit: 1, offset: 3, filters: { phoneQuality: 'valid' }
  });
  assert.strictEqual(pagedLast.rows.length, 1, 'the last page of the filtered set is reachable');
  const beyond = await store.queryNumbers({
    limit: 1, offset: 9, filters: { phoneQuality: 'valid' }
  });
  assert.deepStrictEqual(beyond.rows, [], 'an offset past the filtered set is empty');
});

test('22. an unknown or malformed quality filter value is ignored by the store', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  // An unknown string matches nothing: the predicate compares literally.
  for (const value of ['scored', '', 'VALID', 'valid-ish']) {
    const result = await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: value } });
    assert.strictEqual(result.total, 0, 'a non-matching value matches nothing: ' + JSON.stringify(value));
  }
  // Non-string and absent values are IGNORED, exactly as the B2 layer has
  // always treated stored-column filters; the main process refuses them first.
  for (const value of [42, true, null, undefined, {}, ['valid']]) {
    const result = await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: value } });
    assert.strictEqual(result.total, 4, 'a non-string filter is not applied: ' + JSON.stringify(value));
  }
  const notObject = await store.queryNumbers({ limit: 20, offset: 0, filters: 'nope' });
  assert.strictEqual(notObject.total, 4, 'non-object filters are ignored as before');
});

test('23. the main process refuses any quality value outside the vocabulary', () => {
  const validator = new Function(
    'logger',
    between(mainSource, 'const MAX_KEY_LENGTH = 500;', 'function validateNumbersPayload(')
    + '\n' + between(mainSource, 'function validateHistoryPaging(', '// === B4 local collection-job ledger hooks ===')
    + '\nreturn validateNumbersQuery;'
  )({ warn() {}, info() {}, error() {}, ok() {} });
  const accepted = validator({ limit: 20, offset: 0, filters: {
    phoneQuality: 'valid', emailQuality: 'unknown', websiteQuality: 'invalid',
    businessQuality: 'active', completeness: '4', status: 'pending', qualification: 'qualified'
  } });
  assert.deepStrictEqual(accepted.filters, {
    phoneQuality: 'valid', emailQuality: 'unknown', websiteQuality: 'invalid',
    businessQuality: 'active', completeness: '4', status: 'pending', qualification: 'qualified'
  }, 'every allowlisted value passes through');
  for (const [key, bad] of [
    ['phoneQuality', 'scored'], ['phoneQuality', 'VALID'], ['emailQuality', 'risky'],
    ['websiteQuality', 'live'], ['businessQuality', 'pending'], ['completeness', '6'],
    ['completeness', 5], ['phoneQuality', 42]
  ]) {
    let err = null;
    try {
      validator({ limit: 20, offset: 0, filters: { [key]: bad } });
    } catch (e) {
      err = e;
    }
    assert.ok(err && err.invalidParams, 'refused ' + key + '=' + JSON.stringify(bad));
    assert.ok(err.message.includes('filters.' + key), 'the error names the filter');
  }
  // The generic stored-column filters keep their previous string handling.
  assert.deepStrictEqual(validator({ limit: 20, offset: 0, filters: {} }).filters, {});
  assert.deepStrictEqual(
    validator({ limit: 20, offset: 0, filters: { unknownKey: 'x' } }).filters, {},
    'unknown keys are still ignored'
  );
});

test('24. the quality query path stays read-only and logs nothing', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const before = Buffer.from(store.db.export());
  const beforeLogs = logRecords.length;
  await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: 'valid', completeness: '5' } });
  assert.ok(before.equals(Buffer.from(store.db.export())), 'a quality query performs zero writes');
  assert.strictEqual(logRecords.length, beforeLogs, 'a quality query logs nothing');
  const block = between(storeSource, 'async _queryNumbersWithQuality(', '\n  _queryNumbersSql(');
  for (const forbidden of ['saveDB(', 'logger.', 'INSERT INTO', 'UPDATE numbers', 'DELETE FROM',
    'GROUP BY', 'fetch(', 'http']) {
    assert.ok(!block.includes(forbidden), 'the derived query path must not contain: ' + forbidden);
  }
  const reusesBranches = block.includes('this._queryNumbersSql(scan)') && block.includes('this._queryNumbersJson(scan)');
  assert.ok(reusesBranches, 'both existing branch queries are reused unchanged');
});

test('25. the Lead Library UI merges quality filters and resets the page', () => {
  const controls = [
    ['number-filter-phone-quality', 'phoneQuality'],
    ['number-filter-email-quality', 'emailQuality'],
    ['number-filter-website-quality', 'websiteQuality'],
    ['number-filter-business-quality', 'businessQuality'],
    ['number-filter-completeness', 'completeness']
  ];
  const controlList = between(rendererSource, 'const LEAD_QUALITY_FILTER_CONTROLS = [', '];');
  for (const [id, key] of controls) {
    assert.ok(controlList.includes(`'${id}', '${key}'`), 'control mapped: ' + id);
    assert.ok(htmlSource.includes(`id="${id}"`), 'markup present: ' + id);
  }
  const selectOptions = (id) => [...between(htmlSource, `id="${id}"`, '</select>')
    .matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
  assert.deepStrictEqual(selectOptions('number-filter-phone-quality'), ['all', 'valid', 'invalid', 'unknown']);
  assert.deepStrictEqual(selectOptions('number-filter-email-quality'), ['all', 'valid', 'invalid', 'unknown']);
  assert.deepStrictEqual(selectOptions('number-filter-website-quality'), ['all', 'valid', 'invalid', 'unknown']);
  assert.deepStrictEqual(selectOptions('number-filter-business-quality'), ['all', 'active', 'closed', 'unknown']);
  assert.deepStrictEqual(selectOptions('number-filter-completeness'),
    ['all', '5', '4', '3', '2', '1', '0'], 'completeness is an exact count, no invented bucket');
  const payload = between(rendererSource, 'function numbersQueryPayload()', 'function updateNumbersSortHeaders()');
  assert.ok(payload.includes('for (const [id, key] of LEAD_QUALITY_FILTER_CONTROLS)'), 'payload loops the controls');
  assert.ok(payload.includes("if (value !== 'all') filters[key] = value;"), "'all' omits the filter");
  assert.strictEqual(payload.split('query.filters =').length - 1, 1,
    'quality filters merge into the single filters object');
  assert.ok(payload.includes('filters.status = filterStatus'), 'status filter preserved');
  assert.ok(payload.includes('filters.qualification = filterQualification'), 'qualification filter preserved');
  const listeners = between(rendererSource,
    "for (const [id] of LEAD_QUALITY_FILTER_CONTROLS) {",
    "document.querySelector('#view-numbers .data-table thead')");
  assert.ok(listeners.includes('numbersPage = 1;'), 'a quality change resets the page');
  assert.ok(listeners.includes('renderNumbers();'), 'and re-renders through the existing flow');
  assert.ok(listeners.includes('safeAsync('), 'listeners are guarded');
  // No new table column, no export change, no new channel.
  const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
  for (const column of ['<th>Phone Quality</th>', '<th>Completeness</th>', '<th>Email Quality</th>']) {
    assert.ok(!table.includes(column), 'no quality column in the table: ' + column);
  }
  const exportFn = between(storeSource, 'async exportNumbers(', '// === B4 local collection-job ledger ===');
  assert.ok(!/phoneQuality|emailQuality|websiteQuality|businessQuality|completeness/.test(exportFn),
    'export is unchanged by P1-B');
  const channels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
  // F6 declared lock update: 26 -> 33, the seven sender-checked Lists channels.
  assert.strictEqual(channels.length, 33, '33 IPC channels (P1-C, P1-E, P1-F, P1-G and F6)');
  assert.strictEqual(preloadSource.split('getNumbers:').length - 1, 1, 'preload query exposure unchanged');
});

test('26. B6 user-owned fields are untouched by quality filtering', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const before = JSON.parse(JSON.stringify(
    (await store.queryNumbers({ limit: 1, offset: 0, id: 'q-phone' })).rows[0]
  ));
  await store.queryNumbers({ limit: 20, offset: 0, filters: { phoneQuality: 'valid', completeness: '1' } });
  const after = JSON.parse(JSON.stringify(
    (await store.queryNumbers({ limit: 1, offset: 0, id: 'q-phone' })).rows[0]
  ));
  assert.deepStrictEqual(after, before, 'a quality query changes nothing on the row');
  assert.strictEqual(after.qualification, 'qualified');
  assert.deepStrictEqual(after.tags, ['vip']);
  assert.strictEqual(after.notes, 'n');
});

test('27. store and renderer signal rules cannot drift apart', () => {
  // The renderer (P1-A display) and the store (P1-B filter) implement the same
  // rules in separate processes, so this equivalence check is what guarantees
  // a displayed signal and a filtered signal always agree.
  const storeRules = new Function(
    'URL',
    between(storeSource, 'const LEAD_QUALITY_UNKNOWN =', '// Exact provenance literal written by the manual-import save path')
    + '\nreturn { leadPhoneQuality, leadEmailQuality, leadWebsiteQuality, leadBusinessQuality, leadCompletenessCount, leadMatchesQualityFilters };'
  )(URL);
  const fixtures = [
    { phone: '+66811111111', email: 'a@b.com', website: 'https://x.example', title: 'T', address: 'A' },
    { phone: '+66 81-111-1111', email: 'Owner@Example.COM', website: 'http://www.y.example/p', title: '', address: '' },
    { phone: 'not-a-phone', email: 'bad', website: 'nope', title: 'T', address: 'B' },
    { phone: '', email: '', website: '', title: '', address: '' },
    { phone: '+33123456789', email: 'x@y..com', website: 'ftp://z.example', title: 'T', address: 'A' }
  ];
  for (const lead of fixtures) {
    assert.strictEqual(storeRules.leadPhoneQuality(lead.phone), quality.qualityPhoneSyntax(lead.phone),
      'phone rule agrees for ' + JSON.stringify(lead.phone));
    assert.strictEqual(storeRules.leadEmailQuality(lead.email), quality.qualityEmailSignal(lead.email).syntax,
      'email rule agrees for ' + JSON.stringify(lead.email));
    assert.strictEqual(storeRules.leadWebsiteQuality(lead.website), quality.qualityWebsiteSignal(lead.website).syntax,
      'website rule agrees for ' + JSON.stringify(lead.website));
    assert.strictEqual(storeRules.leadBusinessQuality(lead), 'unknown', 'business is always unknown');
    assert.strictEqual(storeRules.leadCompletenessCount(lead), quality.qualityCompleteness(lead).presentCount,
      'completeness agrees for ' + JSON.stringify(lead.phone));
  }
  assert.strictEqual(quality.qualityPhoneKey('+66 86-111.1111'),
    new Function(functionSource(storeSource, 'function canonicalPhone(phone) {') + '\nreturn canonicalPhone;')()('+66 86-111.1111'),
    'the phone key still mirrors the store key');
});

(async () => {
  // === P1-C user-owned status overrides ===
const STATUS_FIELDS = ['phoneStatus', 'emailStatus', 'websiteStatus', 'businessStatus'];
const STATUS_VOCAB = {
  phoneStatus: ['unknown', 'verified', 'unverified', 'invalid'],
  emailStatus: ['unknown', 'verified', 'unverified', 'risky'],
  websiteStatus: ['unknown', 'live', 'dead', 'redirect'],
  businessStatus: ['unknown', 'active', 'closed']
};
const statusRow = async (store, id) => (await store.queryNumbers({ limit: 1, offset: 0, id })).rows[0];

test('28. the four status columns exist with the contract defaults', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const info = store.db.exec('PRAGMA table_info(numbers)');
  const columns = info[0].values.map(r => r[1]);
  assert.strictEqual(columns.length, 19, 'eleven B1, three B6, four P1-C and one P1-D column');
  for (const field of STATUS_FIELDS) {
    assert.ok(columns.includes(field), 'column present: ' + field);
  }
  for (const field of STATUS_FIELDS) {
    const row = await statusRow(store, 'q-full');
    assert.strictEqual(row[field], 'unknown', 'default is unknown: ' + field);
  }
});

test('29. every allowlisted value is accepted and persisted on both storages', async () => {
  for (const store of [await openStore(), await openJsonStore()]) {
    await addPlainLead(store, 'q-matrix', '+66810000000');
    for (const [field, values] of Object.entries(STATUS_VOCAB)) {
      for (const value of values) {
        const res = await store.setLeadUserStatuses({ id: 'q-matrix', [field]: value });
        assert.strictEqual(res.success, true, 'accepted ' + field + '=' + value);
        // The first value equals the current default, so an unchanged result
        // is correct there; every later value must actually persist.
        assert.ok(res.updated === true || res.reason === 'unchanged',
          'a recognised value never fails: ' + field + '=' + value);
        assert.strictEqual((await statusRow(store, 'q-matrix'))[field], value,
          'persisted ' + field + '=' + value);
      }
    }
  }
});

test('30. invalid values, unknown fields and empty payloads are refused', async () => {
  const store = await openStore();
  await addPlainLead(store, 'q-refuse', '+66810000001');
  const refusals = [
    { id: 'q-refuse', phoneStatus: 'VERIFIED' },
    { id: 'q-refuse', phoneStatus: 'active' },
    { id: 'q-refuse', emailStatus: 'dead' },
    { id: 'q-refuse', websiteStatus: 'risky' },
    { id: 'q-refuse', businessStatus: 'verified' },
    { id: 'q-refuse', phoneStatus: 42 },
    { id: 'q-refuse', unknownStatus: 'verified' },
    { id: 'q-refuse', qualification: 'qualified' },
    { id: '', phoneStatus: 'verified' },
    { id: 'q-refuse' }
  ];
  for (const payload of refusals) {
    const res = await store.setLeadUserStatuses(payload);
    assert.strictEqual(res.success, false, 'refused: ' + JSON.stringify(payload));
    assert.ok(res.error, 'a reason is returned for ' + JSON.stringify(payload));
  }
  const row = await statusRow(store, 'q-refuse');
  for (const field of STATUS_FIELDS) {
    assert.strictEqual(row[field], 'unknown', 'no refused payload changed storage: ' + field);
  }
  // A missing lead is not a refusal: it is the documented not-found result.
  assert.deepStrictEqual(
    await store.setLeadUserStatuses({ id: 'no-such-lead', phoneStatus: 'verified' }),
    { success: true, updated: false, reason: 'not-found' }
  );
});

test('31. a partial update writes only the supplied fields', async () => {
  const store = await openStore();
  await addPlainLead(store, 'q-partial', '+66810000002');
  await store.setLeadUserStatuses({ id: 'q-partial', emailStatus: 'risky' });
  const after = await statusRow(store, 'q-partial');
  assert.strictEqual(after.emailStatus, 'risky', 'the supplied field changed');
  assert.strictEqual(after.phoneStatus, 'unknown', 'an unsupplied field is untouched');
  assert.strictEqual(after.websiteStatus, 'unknown');
  assert.strictEqual(after.businessStatus, 'unknown');
  const noop = await store.setLeadUserStatuses({ id: 'q-partial' });
  assert.strictEqual(noop.success, false, 'an empty update is refused');
  const unchanged = await store.setLeadUserStatuses({ id: 'q-partial', emailStatus: 'risky' });
  assert.deepStrictEqual(unchanged, { success: true, updated: false, reason: 'unchanged' },
    'an identical status never persists');
  // A single non-first field must compare against itself, not against the
  // first field of the vocabulary (the partial-update index trap).
  await store.setLeadUserStatuses({ id: 'q-partial', businessStatus: 'active' });
  const second = await store.setLeadUserStatuses({ id: 'q-partial', businessStatus: 'active' });
  assert.deepStrictEqual(second, { success: true, updated: false, reason: 'unchanged' },
    'the fourth field alone is detected as unchanged');
  const row = await statusRow(store, 'q-partial');
  assert.strictEqual(row.emailStatus, 'risky', 'the earlier partial write still holds');
  assert.strictEqual(row.businessStatus, 'active');
  assert.strictEqual(row.phoneStatus, 'unknown', 'no field drifted while comparing');
});

test('32. statuses survive a reload, and SQL and JSON stay identical', async () => {
  const sqlStore = await openStore();
  const jsonStore = await openJsonStore();
  for (const store of [sqlStore, jsonStore]) {
    await seedQualityLibrary(store);
    await store.setLeadUserStatuses({
      id: 'q-phone', phoneStatus: 'verified', emailStatus: 'unverified',
      websiteStatus: 'redirect', businessStatus: 'active'
    });
  }
  const reopened = await openStore();
  const fromDisk = await statusRow(reopened, 'q-phone');
  assert.strictEqual(fromDisk.phoneStatus, 'verified', 'persisted across a reopen');
  assert.strictEqual(fromDisk.websiteStatus, 'redirect');
  for (const field of STATUS_FIELDS) {
    const sqlRow = await statusRow(sqlStore, 'q-phone');
    const jsonRow = await statusRow(jsonStore, 'q-phone');
    assert.deepStrictEqual(jsonRow[field], sqlRow[field], 'parity after update: ' + field);
  }
});

test('33. RE-COLLECTION and IMPORT cannot overwrite a user status', async () => {
  // The critical ownership proof: a full re-collection and a manual import of
  // the same phone, both carrying smuggled status values, must leave every
  // user-owned field untouched while provider fields keep merging normally.
  for (const store of [await openStore(), await openJsonStore()]) {
    await seedQualityLibrary(store);
    await store.setLeadUserStatuses({
      id: 'q-phone', phoneStatus: 'verified', emailStatus: 'risky',
      websiteStatus: 'live', businessStatus: 'closed'
    });
    await store.setLeadUserFields({
      id: 'q-phone', qualification: 'qualified', tags: ['keep'], notes: 'keep me'
    });
    const before = JSON.parse(JSON.stringify(await statusRow(store, 'q-phone')));

    const recollected = await store.addNumbers([{
      id: 'q-phone-again', phone: '+66 8-2222-2222', source: 'second', keyword: 'kw2',
      status: 'pending', collectedAt: '2026-09-01T00:00:00.000Z',
      title: '', website: 'https://filled.example', email: '', address: '', runSlug: '',
      qualification: 'unqualified', tags: ['injected'], notes: 'injected',
      phoneStatus: 'invalid', emailStatus: 'verified', websiteStatus: 'dead', businessStatus: 'active'
    }]);
    assert.deepStrictEqual(recollected, { added: 0, duplicates: 1 }, 'same canonical phone dedups');
    // Only the user-owned fields are compared: the provider fields are still
    // free to merge, which the two assertions after this one prove.
    const afterRecollect = await statusRow(store, 'q-phone');
    const ownedOf = (row) => Object.fromEntries(
      [...STATUS_FIELDS, 'qualification', 'tags', 'notes'].map(f => [f, row[f]]));
    assert.deepStrictEqual(ownedOf(afterRecollect), ownedOf(before),
      're-collection changed nothing on the user-owned fields');
    assert.strictEqual(afterRecollect.website, 'https://filled.example',
      'provider merge rules still apply to provider fields');
    assert.strictEqual(afterRecollect.source, 'src', 'first-writer-wins still applies');

    const imported = await store.addNumbers([{
      id: 'q-phone-import', phone: '+66(8)2222 2222', source: '手动导入', keyword: '',
      status: 'pending', collectedAt: '2026-09-02T00:00:00.000Z', title: '', website: '',
      email: '', address: '', runSlug: '',
      phoneStatus: 'unverified', emailStatus: 'unverified', websiteStatus: 'redirect', businessStatus: 'active'
    }]);
    assert.deepStrictEqual(imported, { added: 0, duplicates: 1 }, 'import dedups on the same phone');
    const afterImport = await statusRow(store, 'q-phone');
    for (const field of STATUS_FIELDS) {
      assert.strictEqual(afterImport[field], before[field], 'import preserved ' + field);
    }
    assert.strictEqual(afterImport.qualification, 'qualified', 'B6 qualification preserved');
    assert.deepStrictEqual(afterImport.tags, ['keep'], 'B6 tags preserved');
    assert.strictEqual(afterImport.notes, 'keep me', 'B6 notes preserved');
  }
});

test('34. the derived P1-A signals stay independent of the user status', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  const before = quality.leadQualitySignals(await statusRow(store, 'q-full'));
  await store.setLeadUserStatuses({
    id: 'q-full', phoneStatus: 'verified', emailStatus: 'verified',
    websiteStatus: 'live', businessStatus: 'active'
  });
  const after = quality.leadQualitySignals(await statusRow(store, 'q-full'));
  assert.deepStrictEqual(after, before,
    'claiming a status does not change any computed signal');
  assert.strictEqual(after.business.syntax, 'unknown',
    'a user business status is never surfaced as a derived inference');
  // And the derived filters still see the stored data, not the assertion.
  const validSite = await store.queryNumbers({ limit: 20, offset: 0, filters: { websiteQuality: 'valid' } });
  assert.ok(validSite.rows.some(r => r.id === 'q-full'), 'derived filter unaffected by the status');
});

test('35. delete rollback and a failed persist both preserve the statuses', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  await store.setLeadUserStatuses({
    id: 'q-full', phoneStatus: 'verified', emailStatus: 'risky',
    websiteStatus: 'dead', businessStatus: 'closed'
  });
  const before = JSON.parse(JSON.stringify(await statusRow(store, 'q-full')));
  const realSave = store.saveDB;
  store.saveDB = () => { throw new Error('injected persist failure'); };
  let thrown = null;
  try {
    await store.deleteNumbers(['q-full']);
  } catch (err) {
    thrown = err;
  }
  store.saveDB = realSave;
  assert.ok(thrown, 'the persist failure is rethrown');
  assert.deepStrictEqual(await statusRow(store, 'q-full'), before,
    'the 18-column rollback restored every user-owned field');

  await store.setLeadUserStatuses({ id: 'q-full', phoneStatus: 'invalid' });
  const midSave = JSON.parse(JSON.stringify(await statusRow(store, 'q-full')));
  store.saveDB = () => { throw new Error('injected persist failure'); };
  thrown = null;
  try {
    await store.setLeadUserStatuses({ id: 'q-full', phoneStatus: 'unverified' });
  } catch (err) {
    thrown = err;
  }
  store.saveDB = realSave;
  assert.ok(thrown, 'a failed status write is rethrown');
  assert.deepStrictEqual(await statusRow(store, 'q-full'), midSave,
    'a failed status write leaves the previous values in place');
});

test('36. the startup repair covers the status columns too', async () => {
  fs.rmSync(dbPath, { force: true });
  await seedLegacyNumbers();
  const store = await openStore();
  const info = store.db.exec('PRAGMA table_info(numbers)');
  const columns = info[0].values.map(r => r[1]);
  assert.strictEqual(columns.length, 19, 'a migrated database gains every user-owned column plus companyId');
  for (const field of STATUS_FIELDS) {
    assert.ok(columns.includes(field), 'migrated column present: ' + field);
    assert.strictEqual((await statusRow(store, 'null-b6'))[field], 'unknown',
      'repaired default for ' + field);
  }
  const bytes = Buffer.from(store.db.export());
  const again = await openStore();
  assert.ok(bytes.equals(Buffer.from(again.db.export())), 'a second startup repairs nothing');
});

test('37. the status channel is narrow: no B6 field, no secret, no provider call', () => {
  const handler = between(mainSource, "ipcMain.handle('collector:update-lead-quality'", '  });\n');
  assert.ok(handler.includes('validateLeadQualityPayload(payload)'), 'the payload is validated first');
  assert.ok(handler.includes('accountStore.setLeadUserStatuses('), 'the store method is the only writer');
  assert.ok(handler.includes("rejectLog('collector:update-lead-quality', err.message)"), 'refusals are logged');
  assert.ok(handler.includes('throw err'), 'refusals propagate');
  for (const forbidden of ['qualification', 'tags', 'notes', 'setLeadUserFields', 'apiKey', 'taskKey',
    'providerId', 'providerManager', 'coreclaw', 'collection:']) {
    assert.ok(!handler.includes(forbidden), 'the status handler must not touch: ' + forbidden);
  }
  const validator = between(mainSource, 'function validateLeadQualityPayload(', 'function validateHistoryPaging(');
  assert.ok(validator.includes('LEAD_USER_STATUS_VALUES'), 'the validator reads one vocabulary table');
  assert.ok(validator.includes('new Set(Object.keys(LEAD_USER_STATUS_VALUES))'),
    'the validator builds one exact allowlist, not a prefix or substring test');
  assert.ok(validator.includes('if (!supported.has(key))'), 'unknown keys are refused by exact match');
  // The vocabulary table itself is the contract: exact keys, exact values.
  const vocab = between(mainSource, 'const LEAD_USER_STATUS_VALUES = {', '\n};');
  for (const field of STATUS_FIELDS) {
    assert.ok(vocab.includes(field + ':'), 'the contract names ' + field);
    assert.deepStrictEqual([...between(vocab, field + ': [', ']')
      .matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), STATUS_VOCAB[field].slice().sort(),
      'exact vocabulary for ' + field);
  }
  assert.ok(validator.includes('unsupported field'), 'unknown payload keys are refused');
  const storeBlock = between(storeSource, 'async setLeadUserStatuses(payload)', 'async exportNumbers(');
  assert.ok(!/apiKey|taskKey|credentials|Bearer/.test(storeBlock), 'no credential surface in the store path');
  assert.ok(!/logger\.[a-z]+\([^)]*(phoneStatus|emailStatus|websiteStatus|businessStatus)/.test(storeBlock),
    'status values are never logged');
  assert.ok(storeBlock.includes('leadId: value.id, fields: provided.length'),
    'the write log carries a field count, not values');
  // Comments are stripped: what matters is the executable B6 code, not the
  // P1-C section banner that happens to sit above the next method.
  const b6Block = between(storeSource, 'async setLeadUserFields(payload)', 'async setLeadUserStatuses(')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const field of STATUS_FIELDS) {
    assert.ok(!b6Block.includes(field), 'the B6 writer cannot touch a status: ' + field);
  }
});

test('38. the Lead Profile shows derived and user status separately', () => {
  for (const [id, field] of [['lead-status-phone', 'phoneStatus'], ['lead-status-email', 'emailStatus'],
    ['lead-status-website', 'websiteStatus'], ['lead-status-business', 'businessStatus']]) {
    assert.ok(htmlSource.includes('id="' + id + '"'), 'control present: ' + id);
    assert.ok(htmlSource.includes('data-status-field="' + field + '"'), 'field mapping present: ' + field);
    const options = [...between(htmlSource, `id="${id}"`, '</select>')
      .matchAll(/<option value="([^"]*)"/g)].map(m => m[1]);
    assert.deepStrictEqual(options, STATUS_VOCAB[field],
      'the control offers exactly the contract vocabulary: ' + field);
  }
  assert.ok(htmlSource.includes('id="btn-save-lead-status"'), 'an explicit save control exists');
  assert.ok(/id="lead-user-status" hidden/.test(htmlSource), 'the block starts hidden');
  assert.ok(htmlSource.includes('User-provided'), 'the block is labelled as user-provided');
  assert.ok(htmlSource.includes('not checked against any external service'),
    'the UI states the status is not externally verified');
  const save = between(rendererSource, 'async function saveLeadUserStatus()', "getElementById('btn-save-lead-status')");
  assert.ok(save.includes('window.appAPI.collector.updateLeadQuality(payload)'), 'saves through the preload API');
  assert.ok(save.includes('if (leadUserStatusInFlight) return;'), 'duplicate submits are refused');
  assert.ok(save.includes('if (seq !== detailLoadSeq) return;'), 'a stale save cannot touch another lead');
  assert.ok(save.includes("toast(msg, 'error')"), 'failures are surfaced');
  assert.ok(save.includes("reportError(msg, { handler: 'saveLeadUserStatus' })"), 'failures are reported');
  const catchBlock = save.slice(save.indexOf('} catch (err) {'));
  assert.ok(!catchBlock.includes('openLeadDetail('), 'a failure does not reload or clear the selection');
  assert.ok(!catchBlock.includes('= \'unknown\''), 'a failure never rewrites a status');
  const populate = between(rendererSource, 'function populateLeadUserStatus(lead)',
    'async function saveLeadUserStatus()');
  assert.ok(populate.includes('options.includes(row[field]) ? row[field] : \'unknown\''),
    'an unrecognised stored value falls back to unknown rather than a claim');
  const table = between(htmlSource, 'id="view-numbers"', 'id="view-dashboard"');
  for (const column of ['<th>Phone Status</th>', '<th>Business</th>']) {
    assert.ok(!table.includes(column), 'no status column in the Lead Library table: ' + column);
  }
  // P1-C adds no new filter: the payload must not name a user status as a
  // filter key. P1-B owns derived filtering, and 'status' stays the B1 column.
  const payload = between(rendererSource, 'function numbersQueryPayload()', 'function updateNumbersSortHeaders()');
  for (const field of STATUS_FIELDS) {
    assert.ok(!payload.includes(field), 'P1-C adds no filter: ' + field);
  }
  assert.ok(!payload.includes('lead-status-'), 'the profile controls are not Lead Library filters');
});

test('39. the status columns appear in the export like every other stored field', async () => {
  const store = await openStore();
  await seedQualityLibrary(store);
  // A row untouched by the other tests, so "unset" really means unset.
  await addPlainLead(store, 'q-export', '+66888888888');
  await store.setLeadUserStatuses({ id: 'q-export', phoneStatus: 'verified', businessStatus: 'closed' });
  const csv = (await store.exportNumbers('csv')).split('\n');
  assert.ok(csv[0].endsWith('phone_status,email_status,website_status,business_status'),
    'the four status columns are exported');
  // The export carries lead data, not internal ids, so the row is found by phone.
  const csvRow = csv.find(line => line.includes('+66888888888'));
  assert.ok(csvRow, 'the exported row is present');
  assert.ok(csvRow.includes('"verified"') && csvRow.includes('"closed"'), 'status values are exported');
  const jsonRow = JSON.parse(await store.exportNumbers('json')).find(r => r.id === 'q-export');
  assert.strictEqual(jsonRow.phoneStatus, 'verified');
  assert.strictEqual(jsonRow.businessStatus, 'closed');
  assert.strictEqual(jsonRow.emailStatus, 'unknown', 'unset statuses export as unknown');
  assert.strictEqual(jsonRow.websiteStatus, 'unknown', 'unset statuses export as unknown');
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
    fs.rmSync(storeTestRoot, { recursive: true, force: true });
  } catch (cleanupErr) {}

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

