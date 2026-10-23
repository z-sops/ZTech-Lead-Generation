#!/usr/bin/env node
'use strict';

/**
 * Repository hygiene check (F0).
 *
 * Deliberately dependency-free: the whole ZTech test suite is dependency-free
 * by design, and the dependency-free guard in tests/runtime-containment.test.js
 * pins the exact dependency set. Adding a linter would have broken that
 * guard and pulled a large toolchain into a security-sensitive product, so
 * this script covers the classes of problem that actually bite this codebase.
 *
 * Checks:
 *   1. package.json and package-lock.json agree (this exact drift broke
 *      `npm ci` before it was found - see audit gap G-08).
 *   2. no obvious secrets are committed in source.
 *   3. no stray NUL bytes in source (they make files register as binary).
 *   4. no hardcoded absolute machine paths.
 *   5. every local asset referenced by index.html exists AND is covered by the
 *      electron-builder `files` list (audit gap G-14: a packaged build can
 *      silently lose its renderer).
 *   6. build output directories are git-ignored.
 *   7. every test file under tests/ is reachable by the shared discovery.
 *
 * Usage: node scripts/check-repo.js
 * Exit code 0 = clean, 1 = problems found.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const problems = [];
const notes = [];

function fail(check, message) {
  problems.push(`${check}: ${message}`);
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function walk(dir, filter) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-renderer') continue;
      out.push(...walk(full, filter));
    } else if (entry.isFile() && filter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/* -------------------------------------------------- 1. lockfile agreement -- */

function checkLockfileSync() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const root = lock.packages && lock.packages[''];
  if (!root) {
    fail('lockfile', 'package-lock.json has no root package entry');
    return;
  }
  for (const field of ['dependencies', 'devDependencies']) {
    const declared = Object.keys(pkg[field] || {}).sort();
    const locked = Object.keys(root[field] || {}).sort();
    const missing = declared.filter((d) => !locked.includes(d));
    const extra = locked.filter((d) => !declared.includes(d));
    if (missing.length) {
      fail('lockfile', `${field} declared in package.json but missing from package-lock.json: ${missing.join(', ')}`);
    }
    if (extra.length) {
      fail('lockfile', `${field} present in package-lock.json but not in package.json: ${extra.join(', ')}`);
    }
  }
  if (lock.lockfileVersion < 3) {
    fail('lockfile', `lockfileVersion ${lock.lockfileVersion} is older than the npm 7+ format (3)`);
  }
  if (problems.length === 0) notes.push('lockfile: package.json and package-lock.json agree');
}

/* ------------------------------------------------------------ 2. secrets -- */

const SECRET_PATTERNS = [
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'live stripe key', re: /\bsk_live_[0-9A-Za-z]{16,}/ },
  { name: 'openai key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { name: 'google api key', re: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
];

function checkSecrets() {
  const files = [
    ...walk(path.join(ROOT, 'src'), (n) => /\.(js|mjs|cjs|json|css|html)$/.test(n)),
    ...walk(path.join(ROOT, 'main.js') && path.join(ROOT, 'main.js'), () => false),
  ];
  files.push(path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.js'), path.join(ROOT, 'index.html'));

  let hits = 0;
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const { name, re } of SECRET_PATTERNS) {
      const match = text.match(re);
      if (match) {
        fail('secrets', `${path.relative(ROOT, file)} looks like it contains a ${name}`);
        hits++;
      }
    }
  }
  if (hits === 0) notes.push('secrets: no obvious credentials in source');
}

/* ---------------------------------------------------- 3. stray NUL bytes -- */

function checkNulBytes() {
  const files = [
    ...walk(path.join(ROOT, 'src'), (n) => /\.(js|mjs|cjs|json|css|html|sql)$/.test(n)),
    ...walk(path.join(ROOT, 'tests'), (n) => /\.(js|mjs|cjs|json|sql)$/.test(n)),
  ];
  files.push(path.join(ROOT, 'main.js'), path.join(ROOT, 'preload.js'), path.join(ROOT, 'index.html'));

  let hits = 0;
  for (const file of files) {
    const buf = fs.readFileSync(file);
    if (buf.includes(0)) {
      fail('encoding', `${path.relative(ROOT, file)} contains a NUL byte (write it as \\u0000)`);
      hits++;
    }
  }
  if (hits === 0) notes.push('encoding: no NUL bytes in source');
}

/* ----------------------------------------------- 4. hardcoded machine paths -- */

function checkAbsolutePaths() {
  const files = [
    ...walk(path.join(ROOT, 'src'), (n) => /\.(js|mjs|cjs|ps1)$/.test(n)),
    ...walk(path.join(ROOT, 'scripts'), (n) => /\.(js|mjs|cjs|ps1)$/.test(n)),
    ...walk(path.join(ROOT, 'tools'), (n) => /\.(js|mjs|cjs|ps1)$/.test(n)),
  ];
  let hits = 0;
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    const match = text.match(/["']([A-Za-z]:\\\\[^"'\n]{3,})["']/g);
    if (match) {
      for (const m of match) {
        fail('hardcoded path', `${path.relative(ROOT, file)} contains a hardcoded drive path: ${m}`);
        hits++;
      }
    }
  }
  if (hits === 0) notes.push('hardcoded path: no absolute drive paths in source');
}

/* ------------------------------------------- 5. packaged assets completeness -- */

function checkPackagedAssets() {
  const pkg = readJson('package.json');
  const files = pkg.build && pkg.build.files;
  if (!Array.isArray(files)) {
    fail('packaging', 'package.json build.files is missing');
    return;
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const refs = new Set();
  const re = /(?:src|href)\s*=\s*"(\.\/[^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) refs.add(m[1].replace(/^\.\//, ''));

  const covered = (rel) => files.some((pattern) => {
    if (pattern.endsWith('/**/*')) {
      const base = pattern.slice(0, -5);
      return rel === base || rel.startsWith(base);
    }
    return pattern === rel;
  });

  let problemsFound = 0;
  for (const ref of refs) {
    if (!fs.existsSync(path.join(ROOT, ref))) {
      fail('packaging', `index.html references ${ref} but the file does not exist`);
      problemsFound++;
      continue;
    }
    if (!covered(ref)) {
      fail('packaging', `index.html references ${ref} but it is NOT covered by build.files (${files.join(', ')})`);
      problemsFound++;
    }
  }
  if (problemsFound === 0) {
    notes.push(`packaging: all ${refs.size} local asset(s) referenced by index.html exist and are packaged`);
  }
}

/* --------------------------------------------------- 6. gitignore coverage -- */

function checkGitignore() {
  const ignorePath = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fail('gitignore', '.gitignore is missing');
    return;
  }
  const text = fs.readFileSync(ignorePath, 'utf8');
  for (const entry of ['node_modules', 'dist', 'dist-renderer']) {
    if (!text.split(/\r?\n/).some((line) => line.trim() === entry || line.trim() === entry + '/')) {
      fail('gitignore', `build output "${entry}" is not ignored`);
    }
  }
  notes.push('gitignore: build output directories are ignored');
}

/* --------------------------------------------------- 7. test discoverability -- */

function checkTestDiscovery() {
  const { discoverTestFiles } = require(path.join(ROOT, 'tests', 'lib', 'discover.js'));
  const files = discoverTestFiles(path.join(ROOT, 'tests'));
  if (files.length === 0) {
    fail('tests', 'no test files were discovered under tests/');
    return;
  }
  const nested = files.filter((f) => path.dirname(f) !== path.join(ROOT, 'tests'));
  notes.push(`tests: ${files.length} test file(s) discovered (${nested.length} in subdirectories)`);
}

/* ------------------------------------------------------------------ main -- */

checkLockfileSync();
checkSecrets();
checkNulBytes();
checkAbsolutePaths();
checkPackagedAssets();
checkGitignore();
checkTestDiscovery();

for (const note of notes) console.log(`  ok   ${note}`);

if (problems.length > 0) {
  console.log('');
  console.log('=== PROBLEMS ===');
  for (const problem of problems) console.log(`  - ${problem}`);
  console.log('');
  console.log(`${problems.length} problem(s) found.`);
  process.exit(1);
}

console.log('');
console.log('Repository check: clean.');
process.exit(0);
