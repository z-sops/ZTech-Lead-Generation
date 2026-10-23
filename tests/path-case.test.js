'use strict';

// Every path the test suite names must match the real file EXACTLY, in case.
//
// The first Linux CI run failed with ENOENT on src/main/coreclawClient.js:
// the real file is src/main/coreClawClient.js, and the test named it with a
// lower-case "c". Windows hides this - its file system is case-insensitive -
// so the mismatch survived every local run.
//
// This test makes the mistake impossible to keep: it reads every path literal
// in the test suite and compares it with the real tree, case-sensitively.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

/** Every file in the repository, keyed by its lower-case name. */
function indexFiles(dir, out = new Map()) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-renderer') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) indexFiles(full, out);
    else if (entry.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!out.has(rel.toLowerCase())) out.set(rel.toLowerCase(), rel);
      if (!out.has(entry.name.toLowerCase())) out.set(entry.name.toLowerCase(), entry.name);
    }
  }
  return out;
}

test('every path the test suite names matches the real file, in case', () => {
  const index = indexFiles(root);
  const literal = /['"]([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*)['"]/g;
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.js')) continue;
      const text = fs.readFileSync(full, 'utf8');
      let m;
      literal.lastIndex = 0;
      while ((m = literal.exec(text)) !== null) {
        const lit = m[1];
        if (!lit.includes('/') && !lit.endsWith('.js')) continue;
        const known = index.get(lit.toLowerCase());
        if (known && known !== lit) {
          problems.push(`${path.relative(root, full).split(path.sep).join('/')}: '${lit}' should be '${known}'`);
        }
      }
    }
  };
  walk(path.join(root, 'tests'));

  assert.deepEqual(problems, [], 'every path literal matches the real file name, in case');
});

test('the paths that the Linux CI run found are fixed', () => {
  assert.ok(fs.existsSync(path.join(root, 'src', 'main', 'coreClawClient.js')), 'the real file is coreClawClient.js');
  const companyFoundation = fs.readFileSync(path.join(root, 'tests', 'company-foundation.test.js'), 'utf8');
  // The wrong spelling is assembled here so that this file does not itself
  // contain a path literal in the wrong case.
  const wrong = 'coreclaw' + 'Client.js';
  assert.ok(!companyFoundation.includes("'" + wrong + "'"), 'the test names the file with the right case');
});
