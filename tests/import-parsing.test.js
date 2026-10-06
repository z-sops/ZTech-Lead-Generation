'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const rendererPath = path.join(__dirname, '..', 'src', 'renderer', 'renderer.js');
const source = fs.readFileSync(rendererPath, 'utf8');

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

function extractFunction(src, name) {
  const signature = 'function ' + name + '(';
  const start = src.indexOf(signature);
  assert.ok(start >= 0, 'function not found in renderer.js: ' + name);
  assert.strictEqual(src.indexOf(signature, start + 1), -1, 'function defined more than once: ' + name);
  let depth = 0;
  let opened = false;
  let quote = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') { depth += 1; opened = true; continue; }
    if (ch === '}') {
      depth -= 1;
      if (opened && depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces for function: ' + name);
}

const IMPORT_FUNCTIONS = ['splitImportLines', 'isValidImportPhoneLine', 'splitImportCsvRow', 'importHeaderMap', 'buildImportBatch'];
const importConsts = source.slice(source.indexOf('const IMPORT_HEADER_ALIASES'), source.indexOf('function splitImportCsvRow('));
const importSource = importConsts + '\n' + IMPORT_FUNCTIONS.map(name => extractFunction(source, name)).join('\n');
const importLogic = new Function(
  importSource +
    '\nreturn { splitImportLines: splitImportLines, isValidImportPhoneLine: isValidImportPhoneLine, buildImportBatch: buildImportBatch };'
)();

test('1. LF file splits into lines', () => {
  assert.deepStrictEqual(importLogic.splitImportLines('a\nb\nc'), ['a', 'b', 'c']);
});

test('2. CRLF file splits into lines', () => {
  assert.deepStrictEqual(importLogic.splitImportLines('a\r\nb\r\nc'), ['a', 'b', 'c']);
});

test('3. lone CR file splits into lines', () => {
  assert.deepStrictEqual(importLogic.splitImportLines('a\rb\rc'), ['a', 'b', 'c']);
  const batch = importLogic.buildImportBatch('+66812345678\r0812345678\rcall me');
  assert.strictEqual(batch.valid.length, 2);
  assert.strictEqual(batch.invalid, 1);
});

test('4. blank lines are skipped without counting as invalid', () => {
  const batch = importLogic.buildImportBatch('\n\r\n   \r\n+66812345678\n');
  assert.deepStrictEqual(batch.valid, ['+66812345678']);
  assert.strictEqual(batch.invalid, 0);
});

test('5. valid phones are accepted', () => {
  assert.strictEqual(importLogic.isValidImportPhoneLine('+66812345678'), true);
  assert.strictEqual(importLogic.isValidImportPhoneLine('0812345678'), true);
  assert.strictEqual(importLogic.isValidImportPhoneLine('13800138000'), true);
});

test('6. valid phones with existing separators are accepted', () => {
  assert.strictEqual(importLogic.isValidImportPhoneLine('+1 (555) 123-4567'), true);
  assert.strictEqual(importLogic.isValidImportPhoneLine('081-234-5678'), true);
  assert.strictEqual(importLogic.isValidImportPhoneLine('020.123.4567'), true);
  assert.strictEqual(importLogic.isValidImportPhoneLine('081 234 5678'), true);
});

test('7. obvious alphabetic junk is rejected', () => {
  assert.strictEqual(importLogic.isValidImportPhoneLine('call me tomorrow'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('<script>alert(1)</script>'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('hello world this is prose'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('---'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('12 34'), false);
});

test('8. URL junk is rejected', () => {
  assert.strictEqual(importLogic.isValidImportPhoneLine('https://example.com/x'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('example.com'), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('www.example.com/page'), false);
});

test('9. lines over 50 characters are skipped as invalid', () => {
  assert.strictEqual(importLogic.isValidImportPhoneLine('1'.repeat(51)), false);
  assert.strictEqual(importLogic.isValidImportPhoneLine('1'.repeat(50)), true);
  const batch = importLogic.buildImportBatch('1'.repeat(60) + '\n+66812345678');
  assert.strictEqual(batch.invalid, 1);
  assert.deepStrictEqual(batch.valid, ['+66812345678']);
});

test('10. mixed valid + invalid lines process valid ones and count skips', () => {
  const batch = importLogic.buildImportBatch(
    '+66812345678\r\nnot a phone\r\n0812345678\r\nhttps://bad.example/x\r\n081-234-5678'
  );
  assert.deepStrictEqual(batch.valid, ['+66812345678', '0812345678', '081-234-5678']);
  assert.strictEqual(batch.invalid, 2);
});

test('11. duplicate valid lines both pass validation (dedup stays downstream)', () => {
  const batch = importLogic.buildImportBatch('+66812345678\n+66812345678\n0812345678\n0812345678');
  assert.strictEqual(batch.valid.length, 4);
  assert.strictEqual(batch.invalid, 0);
  assert.strictEqual(source.includes('canonicalPhone'), false, 'renderer must not change canonicalPhone dedup policy');
});

test('12. no country-code normalization is applied', () => {
  const batch = importLogic.buildImportBatch('+8613800138000\r\n008613800138000\n+86 138 0013 8000');
  assert.deepStrictEqual(batch.valid, ['+8613800138000', '008613800138000', '+86 138 0013 8000']);
  assert.strictEqual(batch.valid[0].startsWith('+86'), true);
  assert.strictEqual(batch.valid[1].startsWith('0086'), true);
});

test('import handler uses batch builder and reports skipped count', () => {
  assert.ok(source.includes('buildImportBatch(text)'), 'import must use buildImportBatch');
  assert.ok(source.includes('split(/\\r\\n|\\r|\\n/)'), 'line split must cover LF, CRLF and lone CR');
  assert.ok(!source.includes('split(/\\r?\\n/)'), 'legacy LF/CRLF-only split must be gone');
  assert.ok(source.includes('Skipped'), 'zero-valid path must report skipped invalid lines');
  assert.ok(source.includes('ignored'), 'partial import must report skipped invalid lines');
});


test('CSV with a header carries name, website, email and address next to the phone', () => {
  const batch = importLogic.buildImportBatch(
    'Name,Phone,Website,Email,Address\r\n' +
    'Acme Bakery,+923001234567,https://www.acmebakery.pk,info@acmebakery.pk,Karachi\r\n' +
    '"Khan, Sons & Co",0300 7654321,khansons.com,,\r\n' +
    'No Phone Ltd,,nophone.com,,\r\n'
  );
  assert.deepStrictEqual(batch.valid, ['+923001234567', '0300 7654321']);
  assert.strictEqual(batch.invalid, 1);
  assert.deepStrictEqual(batch.rows[0], { phone: '+923001234567', title: 'Acme Bakery', website: 'https://www.acmebakery.pk', email: 'info@acmebakery.pk', address: 'Karachi' });
  assert.deepStrictEqual(batch.rows[1], { phone: '0300 7654321', title: 'Khan, Sons & Co', website: 'khansons.com' });
});

test('CSV header aliases and a BOM are recognised; columns may be in any order', () => {
  const batch = importLogic.buildImportBatch('﻿website;company;mobile\nacme.pk;Acme;+923001112223\n');
  assert.deepStrictEqual(batch.rows, [{ phone: '+923001112223', title: 'Acme', website: 'acme.pk' }]);
});

test('a phone-only file is unchanged and every row carries only the phone', () => {
  const batch = importLogic.buildImportBatch('+66812345678\n0812345678\ncall me');
  assert.deepStrictEqual(batch.valid, ['+66812345678', '0812345678']);
  assert.deepStrictEqual(batch.rows, [{ phone: '+66812345678' }, { phone: '0812345678' }]);
  assert.strictEqual(batch.invalid, 1);
});

test('a CSV without a phone column is not treated as a header', () => {
  const batch = importLogic.buildImportBatch('name,website\nAcme,acme.pk\n');
  assert.strictEqual(batch.valid.length, 0);
  assert.strictEqual(batch.invalid, 2);
});

test('imported fields are bounded to what the main-process validator accepts', () => {
  const long = 'x'.repeat(900);
  const batch = importLogic.buildImportBatch('phone,name\n+923001234567,' + long + '\n');
  assert.strictEqual(batch.rows[0].title.length, 500);
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
