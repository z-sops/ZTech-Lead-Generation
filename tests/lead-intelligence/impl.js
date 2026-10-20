'use strict';

/**
 * Where a Lead Intelligence module's IMPLEMENTATION lives.
 *
 * In M0 the portable domain and application modules moved to the shared
 * package `packages/lead-intelligence` (the package
 * `@zunitech/lead-intelligence`), and a compatibility shim was left at every
 * original path.
 *
 * Most of the suite exercises behaviour through `require(...)`, which is
 * unaffected. A number of tests, however, assert on the SOURCE TEXT of a
 * module - "the outreach gate must mention the approval check", "the sequence
 * service must still store ISO timestamps". Those assertions are about the
 * implementation, so they must follow it.
 *
 * `implSource()` resolves the implementation for a legacy module path, and
 * falls back to the original location for the modules that stayed behind.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const packageSrc = path.join(root, 'packages', 'lead-intelligence', 'src');
const legacyRoot = path.join(root, 'src', 'main', 'lead-intelligence');

/**
 * The implementation file for a legacy Lead Intelligence module path.
 * @param {string} legacyRel e.g. 'outreach/OutreachGate.js'
 * @returns {string} an absolute path
 */
function implPath(legacyRel) {
  const inPackage = path.join(packageSrc, legacyRel);
  if (fs.existsSync(inPackage)) return inPackage;
  return path.join(legacyRoot, legacyRel);
}

/**
 * The implementation source for a legacy Lead Intelligence module path.
 * @param {string} legacyRel e.g. 'outreach/OutreachGate.js'
 * @returns {string} the file's text
 */
function implSource(legacyRel) {
  return fs.readFileSync(implPath(legacyRel), 'utf8');
}

module.exports = { implPath, implSource, root, packageSrc, legacyRoot };
