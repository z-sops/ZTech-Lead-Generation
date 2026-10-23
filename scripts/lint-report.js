#!/usr/bin/env node
'use strict';

/**
 * The lint gate.
 *
 * It runs ESLint through its API and prints a summary, and it fails ONLY when
 * there is an ERROR. The warning tier is the visible debt: it is counted and
 * printed, and it must only ever go down.
 *
 * It is a script rather than a shell pipeline on purpose: a shell redirection
 * into a JSON file is not portable (PowerShell writes UTF-16, which JSON.parse
 * rejects) and the failure then looks like a lint error instead of a
 * reporting problem.
 *
 * Usage: node scripts/lint-report.js [--strict]
 *   --strict  also fail when there is any warning
 */

const { ESLint } = require('eslint');

async function main() {
  const strict = process.argv.includes('--strict');
  const eslint = new ESLint();
  const results = await eslint.lintFiles(['.']);

  let errors = 0;
  let warnings = 0;
  let fixableErrors = 0;
  let fixableWarnings = 0;
  for (const result of results) {
    errors += result.errorCount;
    warnings += result.warningCount;
    fixableErrors += result.fixableErrorCount;
    fixableWarnings += result.fixableWarningCount;
  }

  console.log(`lint: ${errors} error(s), ${warnings} warning(s) across ${results.length} file(s)`);
  console.log(`      ${fixableErrors} fixable error(s), ${fixableWarnings} fixable warning(s)`);

  if (errors > 0) {
    const formatter = await eslint.loadFormatter('stylish');
    console.log(formatter.format(results));
    console.error('lint errors must be zero');
    process.exit(1);
  }
  if (strict && warnings > 0) {
    console.error('lint warnings must be zero in strict mode');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('the lint gate could not run:', (err && err.message) || err);
  process.exit(2);
});
