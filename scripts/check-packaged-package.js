'use strict';

/**
 * Verify that the PACKAGED desktop application can still load the shared
 * Lead Intelligence package.
 *
 * The package is reached two ways in the packaged application: by its
 * published name (when the workspace is packed as a link) and by the
 * in-repo source path (the fallback the resolver uses). Which one applies
 * depends on how electron-builder packs a workspace, so this check does not
 * assume either: it requires the resolver, loads the package through it, and
 * asserts that a compatibility shim and the package are the SAME module
 * instance.
 *
 * It is run by the packaged Electron itself, with ELECTRON_RUN_AS_NODE, so
 * the asar is mounted exactly as it is at runtime.
 *
 * Usage: ELECTRON_RUN_AS_NODE=1 "<electron>" scripts/check-packaged-package.js
 */

const path = require('node:path');

function main() {
  const appRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar');
  const resolver = require(path.join(appRoot, 'src', 'main', 'leadIntPackage.js'));

  const ids = resolver.load('core/ids');
  if (typeof ids.stableId !== 'function') throw new Error('core/ids did not load from the shared package');

  const gate = resolver.load('outreach/OutreachGate');
  if (typeof gate.evaluateOutreachGate !== 'function') throw new Error('the outreach gate did not load');

  const shim = require(path.join(appRoot, 'src', 'main', 'lead-intelligence', 'core', 'ids.js'));
  if (shim !== ids) throw new Error('the compatibility shim and the package are different module instances');

  const pkg = resolver.loadPackage();
  if (typeof pkg.buildEvidencePacket !== 'function') throw new Error('the package entry point did not load');

  console.log('packaged application: the shared package loads, and the shim is the same instance');
  console.log(`  package root : ${resolver.root}`);

  // The packaged executable is a GUI-subsystem application, so a shell that
  // invokes it directly may never see its exit code. The result is therefore
  // also written to a file, which the CI step reads.
  if (process.env.PACKAGED_PACKAGE_CHECK_OUT) {
    require('node:fs').writeFileSync(
      process.env.PACKAGED_PACKAGE_CHECK_OUT,
      JSON.stringify({ ok: true, packageRoot: resolver.root }, null, 2) + '\n',
    );
  }
}

try {
  main();
} catch (err) {
  console.error('packaged application check FAILED:', (err && err.message) || err);
  process.exit(1);
}
