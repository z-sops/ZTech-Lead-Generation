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

const PURE_FUNCTIONS = ['buildResultRowKeyMap', 'resolveSelectedRows', 'computeSelectAllState'];
const pureSource = PURE_FUNCTIONS.map(name => extractFunction(source, name)).join('\n');
const selection = new Function(
  pureSource +
    '\nreturn { buildResultRowKeyMap: buildResultRowKeyMap, resolveSelectedRows: resolveSelectedRows, computeSelectAllState: computeSelectAllState };'
)();

const ROW_A1 = { title: 'Cafe One', phone: '+66812345678', address: 'Bangkok', website: 'https://one.example', email_1: 'one@example.com' };
const ROW_B = { title: 'Cafe Two', phone: '+66899999999', address: 'Chiang Mai', website: '', all_emails: 'two@example.com' };
const ROW_C = { title: 'Shop One', phone: '+8613800138000', address: 'Shanghai', website: 'https://shop.example', email_1: 'shop@example.com' };
const ROW_A2 = { title: 'Cafe One', phone: '+66812345678', address: 'Bangkok', website: 'https://one.example', email_1: 'one@example.com' };
const ALL_ROWS = [ROW_A1, ROW_B, ROW_C, ROW_A2];

const mobileOnly = rows => rows.filter(row => String(row.phone || '').startsWith('+66'));

test('keys are unique even for byte-identical duplicate rows', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  assert.strictEqual(identity.keys.length, 4);
  assert.strictEqual(new Set(identity.keys).size, 4);
  assert.strictEqual(identity.rowMap.size, 4);
  assert.strictEqual(identity.rowMap.get(identity.keys[0]), ROW_A1);
  assert.strictEqual(identity.rowMap.get(identity.keys[3]), ROW_A2);
});

test('A. no filter + select one row', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  const picked = selection.resolveSelectedRows([identity.keys[1]], identity.rowMap);
  assert.deepStrictEqual(picked, [ROW_B]);
});

test('B. no filter + select several rows (display order preserved)', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  const picked = selection.resolveSelectedRows([identity.keys[0], identity.keys[2]], identity.rowMap);
  assert.deepStrictEqual(picked, [ROW_A1, ROW_C]);
});

test('C. no filter + Select All', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  const picked = selection.resolveSelectedRows(identity.keys, identity.rowMap);
  assert.strictEqual(picked.length, 4);
  assert.deepStrictEqual(picked, ALL_ROWS);
  assert.deepStrictEqual(selection.computeSelectAllState(4, 4), { checked: true, indeterminate: false });
});

test('D. no filter + Select All then deselect one', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  const afterDeselect = identity.keys.filter((key, index) => index !== 2);
  const picked = selection.resolveSelectedRows(afterDeselect, identity.rowMap);
  assert.strictEqual(picked.length, 3);
  assert.ok(!picked.includes(ROW_C));
  assert.deepStrictEqual(selection.computeSelectAllState(3, 4), { checked: false, indeterminate: true });
});

test('E. mobile filter + select one visible row', () => {
  const visible = mobileOnly(ALL_ROWS);
  const identity = selection.buildResultRowKeyMap(visible);
  const picked = selection.resolveSelectedRows([identity.keys[1]], identity.rowMap);
  assert.deepStrictEqual(picked, [ROW_B]);
});

test('F. mobile filter + Select All never selects hidden rows', () => {
  const visible = mobileOnly(ALL_ROWS);
  const identity = selection.buildResultRowKeyMap(visible);
  assert.strictEqual(visible.length, 3);
  const picked = selection.resolveSelectedRows(identity.keys, identity.rowMap);
  assert.strictEqual(picked.length, 3);
  assert.ok(!picked.includes(ROW_C), 'hidden +86 row must not be selected');
});

test('G. filter change: keys are content-based, not index-based', () => {
  const unfiltered = selection.buildResultRowKeyMap(ALL_ROWS);
  const visible = mobileOnly(ALL_ROWS);
  const filtered = selection.buildResultRowKeyMap(visible);
  const reversed = selection.buildResultRowKeyMap(ALL_ROWS.slice().reverse());

  assert.strictEqual(unfiltered.keys[1], filtered.keys[1], 'same row keeps same key when its neighbours are filtered out');
  assert.strictEqual(unfiltered.keys[2], reversed.keys[1], 'same row keeps same key when row order changes');

  const staleKeyForHiddenRow = unfiltered.keys[2];
  const picked = selection.resolveSelectedRows([staleKeyForHiddenRow], filtered.rowMap);
  assert.deepStrictEqual(picked, [], 'a key for a row hidden by the filter must not resolve');
});

test('H. filter produces zero visible results', () => {
  const identity = selection.buildResultRowKeyMap([]);
  assert.strictEqual(identity.keys.length, 0);
  assert.strictEqual(identity.rowMap.size, 0);
  assert.deepStrictEqual(selection.resolveSelectedRows([], identity.rowMap), []);
  assert.deepStrictEqual(selection.resolveSelectedRows(selection.buildResultRowKeyMap(ALL_ROWS).keys, identity.rowMap), []);
  assert.deepStrictEqual(selection.computeSelectAllState(0, 0), { checked: false, indeterminate: false });
});

test('I. zero selected rows resolves to empty action set', () => {
  const identity = selection.buildResultRowKeyMap(ALL_ROWS);
  const picked = selection.resolveSelectedRows([], identity.rowMap);
  assert.deepStrictEqual(picked, []);
  assert.strictEqual(picked.length, 0);
  assert.deepStrictEqual(selection.computeSelectAllState(0, 4), { checked: false, indeterminate: false });
});

test('J+K. Save and Export use the same canonical helper', () => {
  const saveStart = source.indexOf("btn-save-numbers'");
  const saveEnd = source.indexOf('function csvField', saveStart);
  const exportStart = source.indexOf("btn-export-results'");
  const exportEnd = source.indexOf("select-all-results'", exportStart);
  assert.ok(saveStart >= 0 && saveEnd > saveStart, 'save handler not located');
  assert.ok(exportStart >= 0 && exportEnd > exportStart, 'export handler not located');

  const saveBlock = source.slice(saveStart, saveEnd);
  const exportBlock = source.slice(exportStart, exportEnd);

  assert.ok(saveBlock.includes('getSelectedResultRows()'), 'Save must use the canonical selection helper');
  assert.ok(exportBlock.includes('getSelectedResultRows()'), 'Export must use the canonical selection helper');
  assert.strictEqual(
    source.split('getSelectedResultRows()').length - 1,
    3,
    'expected exactly one declaration and two call sites of getSelectedResultRows()'
  );

  assert.ok(!saveBlock.includes('__filteredResults'), 'Save must not fall back to __filteredResults');
  assert.ok(!saveBlock.includes('__collectResults'), 'Save must not fall back to __collectResults');
  assert.ok(!exportBlock.includes('__collectResults'), 'Export must not fall back to __collectResults');
  assert.ok(!source.includes('__filteredResults ||'), 'old fallback pattern must be gone');

  assert.ok(saveBlock.includes("showStatus('请先勾选要保存的结果', true)"), 'Save must show a zero-selection message');
  assert.ok(exportBlock.includes("showStatus('请先勾选要导出的结果', true)"), 'Export must show a zero-selection message');
});

test('selection is read from the currently rendered result set only', () => {
  assert.ok(source.includes("'#collect-result-body .result-check:checked'"), 'checked rows must be scoped to the rendered tbody');
  assert.ok(source.includes("'#collect-result-body .result-check'"), 'Select All must be scoped to the rendered tbody');
  assert.ok(!source.includes('data-index='), 'row identity must not use array indexes');
  assert.ok(source.includes('buildResultRowKeyMap(items)'), 'render must build the row identity map');
  assert.ok(source.includes('data-key="${escapeHtml('), 'rendered checkboxes must carry an escaped content key');
});

test('CSV formatting and security helpers preserved', () => {
  assert.ok(source.includes('\\uFEFF'), 'CSV BOM preserved');
  assert.ok(source.includes('[=+\\-@]'), 'formula injection guard preserved');
  assert.ok(source.includes('item.email_1 || item.all_emails'), 'email/all_emails parity preserved');
  assert.ok(source.includes('function csvField'), 'csvField quoting helper preserved');
});

test('P9-A RES-01 history pagination preserved', () => {
  assert.ok(source.includes('const HISTORY_PAGE_SIZE = 20;'));
  assert.ok(source.includes('let historyLoadSeq = 0;'));
  assert.ok(source.includes('if (seq !== historyLoadSeq) return;'));
  assert.ok(source.includes('return loadHistory(targetPage - 1);'));
  assert.ok(source.includes("btn-refresh-history').addEventListener('click', () => loadHistory())"));
  assert.ok(source.includes("renderPagination('history-pagination'"));
});

console.log('');
console.log(passed + ' passed, ' + failures.length + ' failed');
if (failures.length) process.exit(1);
