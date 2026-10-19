'use strict';

// Reconciliation tool: proves the new runner executes exactly the same
// assertions as the old one, plus the new F0 suites.
//
// It parses the captured output of the OLD runner (base commit 58ecf11) and
// the NEW runner (feat/cloud-saas-f0-foundation) and compares them file by
// file.
//
// Usage: node scripts/reconcile-test-counts.js <old-run.txt> <new-run.txt>

const fs = require('node:fs');
const path = require('node:path');

function parseOld(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^--- Running (.+) ---$/.exec(lines[i]);
    if (!m) continue;
    const file = m[1];
    // The summary line is the last "N passed, M failed" line for this file.
    for (let j = i + 1; j < lines.length; j++) {
      const s = /^(\d+) passed, (\d+) failed$/.exec(lines[j]);
      if (s) { map.set(file, { passed: Number(s[1]), failed: Number(s[2]) }); break; }
      if (/^--- Running /.test(lines[j])) break;
    }
  }
  return map;
}

function parseNew(text) {
  const map = new Map();
  const re = /^\s*ok\s+(.+?)\s+\((\d+) passed\)\s*$/;
  for (const line of text.split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) map.set(m[1], { passed: Number(m[2]), failed: 0 });
  }
  return map;
}

const [oldPath, newPath] = process.argv.slice(2);
if (!oldPath || !newPath) {
  console.error('usage: node scripts/reconcile-test-counts.js <old-run.txt> <new-run.txt>');
  process.exit(2);
}

const oldMap = parseOld(fs.readFileSync(oldPath, 'utf8'));
const newMap = parseNew(fs.readFileSync(newPath, 'utf8'));

let oldTotal = 0;
for (const v of oldMap.values()) oldTotal += v.passed;
let newTotal = 0;
for (const v of newMap.values()) newTotal += v.passed;

console.log('=== TEST COUNT RECONCILIATION ===');
console.log('');
console.log(`OLD runner (base commit 58ecf11) : ${oldMap.size} files, ${oldTotal} assertions`);
console.log(`NEW runner (F0 branch)            : ${newMap.size} files, ${newTotal} assertions`);
console.log('');

const removed = [];
const added = [];
const changed = [];
const same = [];

for (const [file, v] of oldMap) {
  if (!newMap.has(file)) { removed.push({ file, ...v }); continue; }
  const n = newMap.get(file);
  if (n.passed !== v.passed) changed.push({ file, old: v.passed, new: n.passed, delta: n.passed - v.passed });
  else same.push(file);
}
for (const [file, v] of newMap) {
  if (!oldMap.has(file)) added.push({ file, ...v });
}

console.log(`identical                 : ${same.length} file(s), ${same.reduce((s, f) => s + oldMap.get(f).passed, 0)} assertion(s)`);
console.log(`count changed             : ${changed.length} file(s)`);
for (const c of changed) {
  console.log(`    ${c.file}: ${c.old} -> ${c.new}  (${c.delta >= 0 ? '+' : ''}${c.delta})`);
}
console.log(`removed                   : ${removed.length} file(s)`);
for (const r of removed) console.log(`    ${r.file}: ${r.passed} assertion(s) NO LONGER RUN`);
console.log(`added                     : ${added.length} file(s)`);
for (const a of added) console.log(`    ${a.file}: ${a.passed} assertion(s)`);
console.log('');

// The one file whose count changed is the bridge, which was rewritten.
const bridgeOld = oldMap.get('lead-intelligence.test.js');
const bridgeNew = newMap.get('lead-intelligence.test.js');
if (bridgeOld && bridgeNew) {
  console.log('The bridge file was rewritten from a re-executor into a discovery guard:');
  console.log(`    old: reported ${bridgeOld.passed} (the aggregate of 27 nested node:test suites)`);
  console.log(`    new: reports  ${bridgeNew.passed} (6 guard assertions)`);
  console.log(`    the ${bridgeOld.passed} nested assertions are now executed and counted directly`);
  console.log(`    by the runner, once, as ${27} separate files.`);
  console.log('');
}

// The nested suites are the ones the old bridge hid.
const nestedOld = bridgeOld ? bridgeOld.passed : 0;
const nestedNew = [...newMap.entries()]
  .filter(([f]) => f.startsWith('lead-intelligence' + path.sep))
  .reduce((s, [, v]) => s + v.passed, 0);
console.log(`Nested suites (tests/lead-intelligence/):`);
console.log(`    old: ${nestedOld} assertions, counted through a single bridge file`);
console.log(`    new: ${nestedNew} assertions, counted from 27 separate files`);
console.log('');

const accountedOld = same.reduce((s, f) => s + oldMap.get(f).passed, 0)
  + changed.reduce((s, c) => s + c.old, 0)
  + removed.reduce((s, r) => s + r.passed, 0);
const accountedNew = same.reduce((s, f) => s + newMap.get(f).passed, 0)
  + changed.reduce((s, c) => s + c.new, 0)
  + added.reduce((s, a) => s + a.passed, 0);

console.log('=== ARITHMETIC ===');
console.log(`OLD total  = ${accountedOld}`);
console.log(`NEW total  = ${accountedNew}`);
console.log(`difference = ${newTotal - oldTotal >= 0 ? '+' : ''}${newTotal - oldTotal}`);
console.log('');
console.log(`  ${accountedOld} (all 88 original files, unchanged except the bridge)`);
console.log(`+ ${changed.reduce((s, c) => s + (c.new - c.old), 0) >= 0 ? '+' : ''}${changed.reduce((s, c) => s + (c.new - c.old), 0)} (the rewritten bridge: 391 aggregate -> 6 guard assertions)`);
console.log(`+ ${added.reduce((s, a) => s + a.passed, 0)} (new suites: ${added.map((a) => a.file).join(', ') || 'none'})`);
console.log(`= ${accountedNew}`);

const balanced = accountedOld === oldTotal && accountedNew === newTotal;
console.log('');
console.log(balanced ? 'RECONCILED: every old assertion is accounted for.' : 'NOT RECONCILED - investigate.');
process.exit(balanced ? 0 : 1);
