'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const root = path.join(__dirname, '..');
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p10-l5-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  const loggerPath = path.join(root, 'src', 'main', 'logger.js');
  const loggerSource = fs.readFileSync(loggerPath, 'utf8');
  const { logger } = require(loggerPath);

  const LOG_DIR = logger.getLogDir();
  const todayName = `app-${new Date().toISOString().slice(0, 10)}.log`;

  function cleanLogDir() {
    for (const f of fs.readdirSync(LOG_DIR)) {
      fs.rmSync(path.join(LOG_DIR, f), { force: true });
    }
  }

  test('1. export returns exact combined content with headers in name-desc order', () => {
    cleanLogDir();
    fs.writeFileSync(path.join(LOG_DIR, 'app-2026-01-01.log'), 'AAA\n', 'utf-8');
    fs.writeFileSync(path.join(LOG_DIR, 'app-2026-01-02.log'), 'BBB\n', 'utf-8');
    const out = logger.exportLogs();
    const expected =
      '\n=== app-2026-01-02.log ===\nBBB\n' +
      '\n=== app-2026-01-01.log ===\nAAA\n';
    assert.strictEqual(out, expected, 'export content and file order must be byte-identical');
  });

  test('2. empty log behavior: export returns empty string and renderer skips download', () => {
    cleanLogDir();
    const out = logger.exportLogs();
    assert.strictEqual(out, '');
    const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
    assert.ok(rendererSource.includes('if (logs)'), 'renderer must gate the download on truthy logs');
    assert.ok(rendererSource.includes('There are no logs to export'), 'renderer must keep the no-logs toast');
    assert.ok(rendererSource.includes('new Blob([logs]'), 'renderer must pass the returned string straight to Blob');
    assert.ok(!rendererSource.includes('+ logs]'), 'renderer must not concatenate the log payload');
    assert.ok(rendererSource.includes('app-logs-'), 'download filename format must be unchanged');
  });

  test('3. large log (2 MB) exports complete content without truncation', () => {
    cleanLogDir();
    const big = 'L'.repeat(2 * 1024 * 1024);
    fs.writeFileSync(path.join(LOG_DIR, todayName), big, 'utf-8');
    const out = logger.exportLogs();
    const header = `\n=== ${todayName} ===\n`;
    assert.strictEqual(out.length, header.length + big.length, 'no bytes may be dropped or added');
    assert.ok(out.endsWith(big), 'content tail must survive intact');
  });

  test('4. rotation at 5 MB: old content moved to timestamped file, fresh file gets only new line', () => {
    cleanLogDir();
    const bigPath = path.join(LOG_DIR, todayName);
    fs.writeFileSync(bigPath, 'BIGDATA' + 'B'.repeat(5 * 1024 * 1024), 'utf-8');
    logger.info('rot', 'after-rotation');
    const files = fs.readdirSync(LOG_DIR);
    const rotated = files.filter(f => /^app-\d{4}-\d{2}-\d{2}\.log\.\d{13}$/.test(f));
    assert.strictEqual(rotated.length, 1, 'exactly one rotated file with Date.now() suffix');
    const rotatedContent = fs.readFileSync(path.join(LOG_DIR, rotated[0]), 'utf-8');
    assert.ok(rotatedContent.startsWith('BIGDATA'), 'rotated file must keep the old content');
    const fresh = fs.readFileSync(bigPath, 'utf-8');
    assert.ok(!fresh.includes('BIGDATA'), 'fresh file must not contain old content');
    assert.ok(fresh.includes('[INFO] [rot] after-rotation'), 'new line must land in the fresh daily file');
    assert.strictEqual(fresh.trim().split('\n').length, 1, 'fresh file must contain only the new line');
  });

  test('5. retention: newest 10 app-* files kept by cleanup, non-app files untouched, fresh file adds one', () => {
    cleanLogDir();
    const now = Date.now();
    fs.writeFileSync(path.join(LOG_DIR, todayName), 'BIGDATA' + 'B'.repeat(5 * 1024 * 1024), 'utf-8');
    for (let i = 1; i <= 11; i++) {
      const p = path.join(LOG_DIR, `app-2025-01-${String(i).padStart(2, '0')}.log`);
      fs.writeFileSync(p, `old-${i}\n`, 'utf-8');
      const t = new Date(now - (20 - i) * 60000);
      fs.utimesSync(p, t, t);
    }
    fs.writeFileSync(path.join(LOG_DIR, 'other.log'), 'keep\n', 'utf-8');

    logger.info('ret', 'x');

    const files = fs.readdirSync(LOG_DIR);
    assert.ok(!files.includes('app-2025-01-01.log'), 'oldest file must be deleted by cleanup');
    assert.ok(!files.includes('app-2025-01-02.log'), 'second oldest must be deleted (12 -> 10 kept)');
    assert.ok(files.includes('app-2025-01-03.log'), 'third oldest must survive');
    assert.ok(files.includes('other.log'), 'files not matching app- prefix must be untouched');
    const appFiles = files.filter(f => f.startsWith('app-'));
    assert.strictEqual(appFiles.length, 11, 'current behavior: 10 retained by cleanup + fresh current file');
    const fresh = fs.readFileSync(path.join(LOG_DIR, todayName), 'utf-8');
    assert.ok(fresh.includes('[INFO] [ret] x'), 'fresh daily file receives the new line');
  });

  test('6. line format unchanged: timestamp, level, category, JSON data, 500-char truncation', () => {
    cleanLogDir();
    logger.info('cat', 'msg', { a: 1 });
    logger.warn('cat', 'long', 'x'.repeat(600));
    const content = fs.readFileSync(path.join(LOG_DIR, todayName), 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[INFO\] \[cat\] msg \{"a":1\}$/);
    assert.ok(lines[1].includes('[WARN] [cat] long ' + 'x'.repeat(500) + '...'), 'data must be truncated at 500 chars');
    assert.ok(!lines[1].includes('x'.repeat(501)), 'data beyond 500 chars must not be written');
  });

  test('7. logger write errors remain controlled (swallowed, no exception escapes)', () => {
    cleanLogDir();
    const realAppend = fs.appendFileSync;
    fs.appendFileSync = function () { throw new Error('injected write failure'); };
    try {
      logger.info('t', 'x');
      logger.warn('t', 'x');
      logger.error('t', 'x');
      logger.ok('t', 'x');
    } finally {
      fs.appendFileSync = realAppend;
    }
    assert.ok(true, 'reaching this line proves no logger call threw');
  });

  test('8. getLogFiles/exportLogs stay controlled on directory error', () => {
    const realReaddir = fs.readdirSync;
    fs.readdirSync = function (p) {
      if (String(p) === LOG_DIR) throw new Error('injected readdir failure');
      return realReaddir.apply(fs, arguments);
    };
    try {
      assert.deepStrictEqual(logger.getLogFiles(), []);
      assert.strictEqual(logger.exportLogs(), '');
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  test('9. static: sync append, rotation constants, IPC chain and payload shape unchanged', () => {
    assert.strictEqual(loggerSource.split('fs.appendFileSync(').length - 1, 1, 'single sync append site');
    assert.ok(loggerSource.includes('const MAX_FILE_SIZE = 5 * 1024 * 1024'), '5 MB rotation size unchanged');
    assert.ok(loggerSource.includes('const MAX_FILES = 10'), '10-file retention unchanged');
    assert.ok(loggerSource.includes('`app-${date}.log`'), 'daily filename format unchanged');
    assert.ok(!loggerSource.includes('zlib') && !loggerSource.includes('gzip'), 'no compression added');

    const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
    assert.ok(mainSrc.includes("ipcMain.handle('logs:export'"), 'logs:export channel unchanged');
    assert.ok(mainSrc.includes('return logger.exportLogs();'), 'handler must return the single string directly');

    const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
    assert.ok(preloadSrc.includes("exportLogs: () => ipcRenderer.invoke('logs:export')"), 'preload passthrough unchanged');
  });

  test('10. static: no secrets/PII values at any logger call site', () => {
    const files = [
      'main.js',
      'src/main/accountStore.js',
      'src/main/coreClawClient.js',
      'src/main/providers/coreclawAdapter.js'
    ];
    const banned = /\b(apiKey|taskKey|proxyUrl|password|secret|token|phone|keyword)\s*[:=]/;
    for (const rel of files) {
      const src = fs.readFileSync(path.join(root, rel), 'utf8');
      for (const line of src.split('\n')) {
        if (!line.includes('logger.')) continue;
        const stripped = line.replace(/!!\s*[\w.]*?(apiKey|taskKey|proxyUrl)/g, 'BOOL');
        assert.ok(!banned.test(stripped), `sensitive-looking logger line in ${rel}: ${line.trim()}`);
      }
    }
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }

  try {
    fs.rmSync(testRoot, { recursive: true, force: true });
  } catch (cleanupErr) {}

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
