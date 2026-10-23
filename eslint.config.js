'use strict';

/**
 * ESLint configuration for ZTech Lead Generation.
 *
 * INCREMENTAL BY DESIGN.
 *
 * This configuration was added in F0 (audit gap G-07) after the existing
 * 2.2 MB of JavaScript was already written. The rule set is therefore built
 * in two tiers:
 *
 *   ERROR  - correctness rules that the current codebase already satisfies.
 *            These are enforced from day one, and a new violation fails CI.
 *   WARN   - rules that the current codebase does NOT yet satisfy. These are
 *            reported and counted, but they do not fail the build. Each one is
 *            a piece of debt that has been made visible, and it can be
 *            promoted to an error once it has been paid off.
 *
 * There is deliberately NO auto-formatting rule and NO stylistic rule. The
 * codebase has a consistent existing style (2-space indent, single quotes,
 * semicolons, 'use strict' at the top of every CommonJS module) that was
 * never machine-enforced, and reformatting 2.2 MB of source would produce a
 * diff that hides the real changes. Style stays a human convention until the
 * team decides otherwise.
 *
 * To promote a warning to an error, move it from the `warn` tier to the
 * `error` tier below. To silence a warning in one place, add an
 * eslint-disable-next-line comment with a reason.
 */

const globals = require('globals');

/** The main process, the preload bridge, tests, tooling: Node only. */
const nodeScope = {
  files: [
    'eslint.config.js',
    'vite.config.js',
    'main.js',
    'preload.js',
    'src/main/**/*.js',
    'src/main/**/*.cjs',
    'packages/**/src/**/*.js',
    'packages/**/src/**/*.cjs',
    'tests/**/*.js',
    'scripts/**/*.js',
    'tools/**/*.js',
  ],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'commonjs',
    globals: { ...globals.node },
  },
};

/**
 * The renderer: a browser context.
 *
 * The `src/renderer/lead-intelligence/*.js` modules are CommonJS modules that
 * the renderer loads directly (they are CommonJS because the Electron main
 * process requires them), so this scope carries the Node globals as well.
 */
const browserScope = {
  files: ['src/renderer/**/*.js', 'src/renderer/**/*.mjs'],
  languageOptions: {
    ecmaVersion: 2023,
    sourceType: 'script',
    globals: { ...globals.browser, ...globals.node },
  },
};

/** ES modules (the renderer entry point is bundled by Vite). */
const moduleScope = {
  files: ['src/renderer/**/*.mjs', 'vite.config.js'],
  languageOptions: { sourceType: 'module' },
};

/**
 * CORRECTNESS RULES - enforced as errors.
 *
 * Every rule here has zero violations in the current codebase. They are the
 * rules that catch real bugs: unreachable code, duplicate keys, accidental
 * globals, unsafe comparisons, and the eval-shaped constructs.
 */
const CORRECTNESS_RULES = {
  'no-undef': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-duplicate-case': 'error',
  'no-const-assign': 'error',
  'no-class-assign': 'error',
  'no-func-assign': 'error',
  'no-cond-assign': 'error',
  'no-obj-calls': 'error',
  'no-self-compare': 'error',
  'no-self-assign': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-compare-neg-zero': 'error',
  'no-sparse-arrays': 'error',
  'no-unreachable-loop': 'error',
  'no-duplicate-imports': 'error',
  'no-import-assign': 'error',
  'no-setter-return': 'error',
  'no-async-promise-executor': 'error',
  'no-throw-literal': 'error',
  'no-with': 'error',
  'no-label-var': 'error',
  'no-shadow-restricted-names': 'error',
  'no-eval': 'error',
  'no-implied-eval': 'error',
  'no-script-url': 'error',
  'no-new-native-nonconstructor': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-misleading-character-class': 'error',
  'no-loss-of-precision': 'error',
  'no-fallthrough': 'error',
};

/**
 * REPORTED RULES - visible debt, not enforced.
 *
 * Each of these has real violations in the codebase today. They are reported
 * so the count can only go down, and they are not enforced so that F1 and F2
 * are not blocked behind a large cleanup that would obscure the real changes.
 *
 * `eqeqeq` is the largest one (100). The codebase uses `==` and `!=` in
 * places that compare against `null` and in places that do not; changing them
 * is a behaviour-affecting edit, so it is reported rather than forced.
 */
const REPORTED_RULES = {
  'eqeqeq': 'warn',
  'no-var': 'warn',
  'prefer-const': 'warn',
  'no-new-func': 'warn',
  'no-promise-executor-return': 'warn',
  'no-useless-escape': 'warn',
  'no-constant-binary-expression': 'warn',
  'no-return-assign': 'warn',
  'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-empty': ['warn', { allowEmptyCatch: true }],
  'no-prototype-builtins': 'warn',
  'no-unused-private-class-members': 'warn',
  // These two are reported rather than enforced on purpose. Every violation
  // in this codebase is a regex that DELIBERATELY matches control characters
  // - stripping NUL bytes and other control codes from untrusted input is a
  // security control here, not an accident (see agent/sanitize.js,
  // trust/trustContract.js, mailbox/mailboxContract.js,
  // providers/envelopeMapper.js). The rule assumes a control character in a
  // regex is a mistake; in this codebase it is the opposite.
  'no-control-regex': 'warn',
  'no-irregular-whitespace': 'warn',
};

module.exports = [
  {
    // The vendored round-1 bundle is generated code from an external module.
    // It is shipped as-is and is not ours to restyle, so it is not linted.
    // (It is also the largest audit blind spot in the repository - see audit
    // gap G-63 - which is a separate problem from linting.)
    ignores: [
      'node_modules/**',
      'dist/**',
      'dist-renderer/**',
      'coverage/**',
      'src/main/prospect-research/prospect-research.cjs',
    ],
  },
  nodeScope,
  browserScope,
  moduleScope,
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    rules: { ...CORRECTNESS_RULES, ...REPORTED_RULES },
  },
  {
    // The test files deliberately use two techniques that the correctness
    // rules flag by design:
    //   - they build a function from a source string with `new Function`, to
    //     unit-test a pure helper that lives inside a 542 KB renderer file;
    //   - they assert that a `javascript:` URL is rejected, so the string
    //     "javascript:" has to appear in the test.
    files: ['tests/**/*.js'],
    rules: {
      'no-new-func': 'off',
      'no-script-url': 'off',
    },
  },
];
