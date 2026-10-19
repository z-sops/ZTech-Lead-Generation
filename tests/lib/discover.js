'use strict';

/**
 * Shared test-file discovery.
 *
 * Why this module exists: the original runner (tests/run-all.js) used a flat
 * `readdirSync`, so the 27 suites under tests/lead-intelligence/ only ran
 * because a hand-written bridge re-executed them and scraped their output.
 * Any *new* nested directory would have been silently ignored while the suite
 * still reported green.
 *
 * Discovery is recursive and is the single source of truth for:
 *   - tests/run-all.js          (the runner)
 *   - tests/lead-intelligence.test.js (the coverage guard)
 *   - scripts/check-repo.js     (the repo hygiene check)
 *
 * A test file is any file whose name ends with `.test.js`.
 */

const fs = require('node:fs');
const path = require('node:path');

const TEST_SUFFIX = '.test.js';

/** Directories that never contain runnable tests. */
const IGNORED_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'dist-renderer', 'coverage']);

/**
 * @param {string} name
 * @returns {boolean}
 */
function isTestFileName(name) {
  return typeof name === 'string' && name.endsWith(TEST_SUFFIX);
}

/**
 * Recursively collect every `*.test.js` file under `rootDir`.
 *
 * @param {string} rootDir absolute path to the directory to scan
 * @param {{ exclude?: string[] }} [options] absolute paths to exclude
 * @returns {string[]} absolute file paths, sorted for deterministic order
 */
function discoverTestFiles(rootDir, options = {}) {
  const exclude = new Set(options.exclude || []);
  const found = [];

  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (exclude.has(full)) continue;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && isTestFileName(entry.name)) {
        found.push(full);
      }
    }
  };

  walk(rootDir);
  return found.sort();
}

/**
 * Count the test files per directory, relative to `rootDir`.
 * Used by the coverage guard to prove nested suites are actually included.
 *
 * @param {string} rootDir
 * @returns {Record<string, number>} e.g. { '.': 88, 'lead-intelligence': 27 }
 */
function countTestFilesByDirectory(rootDir) {
  const counts = {};
  for (const file of discoverTestFiles(rootDir)) {
    const rel = path.relative(rootDir, path.dirname(file)) || '.';
    counts[rel] = (counts[rel] || 0) + 1;
  }
  return counts;
}

module.exports = { TEST_SUFFIX, isTestFileName, discoverTestFiles, countTestFilesByDirectory };
