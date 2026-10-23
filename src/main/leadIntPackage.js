'use strict';

/**
 * The resolver for the shared Lead Intelligence package.
 *
 * The package is `@zunitech/lead-intelligence` and lives in
 * `packages/lead-intelligence`. It is resolved by its published name when it is
 * installed (development, and the packaged desktop application when the
 * workspace is packed), and from the in-repo source otherwise.
 *
 * The fallback exists because the desktop application is packaged with
 * electron-builder, and how a workspace symlink is packed is not something the
 * application should depend on. The fallback makes the packaged application
 * work either way, and it resolves the SAME files, so the module cache - and
 * therefore object identity - is identical in both cases.
 */

const fs = require('node:fs');
const path = require('node:path');

/** Where the package can be, most preferred first. */
function candidates() {
  const byName = () => require.resolve('@zunitech/lead-intelligence/package.json');
  const byPath = () => path.join(__dirname, '..', '..', 'packages', 'lead-intelligence', 'package.json');
  return [byName, byPath];
}

let root = null;
for (const candidate of candidates()) {
  try {
    root = path.dirname(candidate());
    break;
  } catch {
    // Try the next one.
  }
}
if (!root) {
  throw new Error('the shared lead-intelligence package could not be located');
}

/**
 * Load a module from the shared package.
 * @param {string} rel path inside the package's src/, e.g. 'core/ids'
 */
function load(rel) {
  const file = path.join(root, 'src', rel);
  if (!fs.existsSync(file) && !fs.existsSync(`${file}.js`)) {
    throw new Error(`the shared lead-intelligence package has no module '${rel}'`);
  }
  return require(fs.existsSync(file) ? file : `${file}.js`);
}

/** The package's public entry point. */
function loadPackage() {
  return require(root);
}

module.exports = { load, loadPackage, root, PACKAGE_NAME: '@zunitech/lead-intelligence' };
