'use strict';

// M0 - extract the shared Lead Intelligence core.
//
// Moves the genuinely portable domain and application modules into
// packages/lead-intelligence (the package @zunitech/lead-intelligence) and
// leaves a compatibility shim at every original path, so the desktop app,
// the tests and every existing require path keep working unchanged.
//
// The move list is computed, not hand-written: it is closed over the relative
// requires, and anything that transitively depends on electron, the file
// system, a child process or the app's credential vault is excluded.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'main', 'lead-intelligence');
const PKG = path.join(ROOT, 'packages', 'lead-intelligence');
const PKG_SRC = path.join(PKG, 'src');

const ENV_BOUND = new Set(['electron', 'electron-store', 'fs', 'node:fs', 'child_process', 'node:child_process']);
// These bind a local port or the OS key store: they are desktop adapters.
const LOCAL_PROCESS = new Set(['http', 'https', 'net', 'node:net', 'node:http', 'node:https', 'dgram']);

/**
 * Files that stay in the desktop application by POLICY, not by dependency:
 * the composition roots, the Electron IPC registrars that talk to a
 * desktop-bound module, and the SQLite persistence adapter that M1 replaces
 * with PostgreSQL.
 */
const KEEP_BY_POLICY = new Set([
  // the composition roots
  'index.js',
  'lead-intelligence-runtime.js',
  'config.js',
  'integration/mainProcess.js',
  'integration/zuniSeoFactory.js',
  // the SQLite persistence ADAPTER stays in the desktop application: it reads
  // the local migration files, and M1 introduces the PostgreSQL adapter
  // alongside the shared contract. The in-memory store and the repositories
  // move, because they implement that contract and are portable.
  'persistence/SqlJsStore.js',
  'persistence/atomicFile.js',
  'persistence/migrations.js',
  // a persistence adapter
  'mailbox/mailboxPersistence.js',
]);

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function listFiles() {
  const out = new Map();
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      const r = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, r);
      else if (entry.name.endsWith('.js')) out.set(r, fs.readFileSync(full, 'utf8'));
    }
  };
  walk(SRC, '');
  return out;
}

function depsOf(rel, files) {
  const out = [];
  const text = files.get(rel);
  for (const m of text.matchAll(/require\((['"])([^'"]+)\1\)/g)) {
    const s = m[2];
    if (!s.startsWith('.')) { out.push({ kind: 'EXT', target: s }); continue; }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), s));
    if (target.startsWith('..')) { out.push({ kind: 'ESCAPE', target: s }); continue; }
    if (target.endsWith('.js')) out.push({ kind: 'REL', target });
    else if (files.has(`${target}.js`)) out.push({ kind: 'REL', target: `${target}.js` });
    else out.push({ kind: 'MISSING', target: s });
  }
  return out;
}

const files = listFiles();

// 1. Everything that is environment-bound, transitively.
const envBound = new Set();
for (;;) {
  let changed = false;
  for (const rel of files.keys()) {
    if (envBound.has(rel)) continue;
    for (const d of depsOf(rel, files)) {
      if (d.kind === 'EXT' && (ENV_BOUND.has(d.target) || LOCAL_PROCESS.has(d.target))) { envBound.add(rel); changed = true; break; }
      if (d.kind === 'ESCAPE') { envBound.add(rel); changed = true; break; }
      if (d.kind === 'REL' && envBound.has(d.target)) { envBound.add(rel); changed = true; break; }
    }
  }
  if (!changed) break;
}

const movable = [...files.keys()]
  .filter((rel) => !envBound.has(rel) && !KEEP_BY_POLICY.has(rel))
  .sort();

// 2. The move set must be closed: a moved file may not require a file that stays.
for (const rel of movable) {
  for (const d of depsOf(rel, files)) {
    if (d.kind === 'REL' && !movable.includes(d.target)) {
      throw new Error(`the move set is not closed: ${rel} requires ${d.target}, which stays behind`);
    }
  }
}

console.log(`total ${files.size} | env-bound ${envBound.size} | kept by policy ${KEEP_BY_POLICY.size} | MOVING ${movable.length}`);
console.log('staying behind:');
for (const rel of [...envBound].sort()) console.log(`    ${rel}`);
console.log('');

// 3. Move the files, preserving git history.
fs.mkdirSync(PKG_SRC, { recursive: true });
for (const rel of movable) {
  const from = path.join(SRC, rel);
  const to = path.join(PKG_SRC, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  git(['mv', path.relative(ROOT, from), path.relative(ROOT, to)]);
}
console.log(`moved ${movable.length} files`);

// 4. Leave a compatibility shim at every original path.
let shimCount = 0;
for (const rel of movable) {
  const shimPath = path.join(SRC, rel);
  const dirs = path.posix.dirname(rel) === '.' ? [] : path.posix.dirname(rel).split('/');
  const up = '../'.repeat(dirs.length + 1) + 'leadIntPackage';
  const body = `'use strict';

// M0 compatibility shim.
//
// The implementation moved to the shared package @zunitech/lead-intelligence
// (packages/lead-intelligence/src/${rel}). This file re-exports it, so every
// existing require path - the desktop application, the tests, and the modules
// that stay behind - keeps working unchanged, and there is still exactly ONE
// implementation of the intelligence engine.
//
// Do not add logic here. Change the implementation in the package.

module.exports = require('${up}').load('${rel}');
`;
  fs.mkdirSync(path.dirname(shimPath), { recursive: true });
  fs.writeFileSync(shimPath, body, 'utf8');
  shimCount += 1;
}
console.log(`wrote ${shimCount} compatibility shims`);

// 5. The manifest of what moved, for the commit message and the report.
fs.writeFileSync(
  path.join(PKG, 'MOVED.md'),
  `# Moved modules (M0)\n\n` +
    `These modules moved from \`src/main/lead-intelligence/\` to\n` +
    `\`packages/lead-intelligence/src/\` (the package\n` +
    `\`@zunitech/lead-intelligence\`). Every original path keeps a\n` +
    `compatibility shim that re-exports the package, so nothing that requires\n` +
    `them changed.\n\n` +
    movable.map((r) => `- \`${r}\``).join('\n') +
    '\n',
  'utf8',
);
console.log('wrote packages/lead-intelligence/MOVED.md');
