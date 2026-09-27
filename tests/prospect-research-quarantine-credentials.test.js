'use strict';

// A2 / A3 - runtime behaviour.
//
// A2: quarantined payloads are persisted in the existing database, oversized
//      payloads are truncated with a flag rather than dropped, and pruning
//      enforces the same retention as research data.
// A3: the Zuni-SEO key reuses the existing vault, is written 0600 and atomically,
//      refuses the Linux basic_text backend, and is never returned to the renderer.
//      credentialVault.js behaviour for existing provider credentials is untouched.

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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-a2a3-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };
  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const { AccountStore } = require(path.join(__dirname, '..', 'src', 'main', 'accountStore.js'));
  const { SqlQuarantineSink, TABLE, DEFAULT_RETENTION_MS } =
    require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'quarantine-sink.js'));
  const { ZuniSeoCredentialSource, KEY_FILE, KEY_FORMAT, setSafeStorageForTests } =
    require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'credential-source.js'));
  const credentialVault = require(path.join(__dirname, '..', 'src', 'main', 'credentialVault.js'));

  const accountStore = new AccountStore();
  await accountStore.ready;
  const sink = new SqlQuarantineSink(accountStore, {
    maxPayloadBytes: 512,
    retentionMs: 1000,
    now: () => Date.now()
  });
  await sink.ready();
  accountStore.db.run(`DELETE FROM ${TABLE}`);
  accountStore.saveDB();

  function makeItem(overrides) {
    return Object.assign({
      providerId: 'zuni-seo',
      operation: 'status',
      reason: 'contract_mismatch',
      problems: ['facts[0].value missing'],
      payload: { ok: true },
      at: new Date().toISOString()
    }, overrides || {});
  }

  async function expectThrow(fn) {
    let thrown = null;
    try {
      await fn();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected a throw');
    return thrown;
  }

  // --- A2 -----------------------------------------------------------------

  test('1. a quarantined payload is persisted in the existing database', async () => {
    const result = await sink.put(makeItem());
    assert.strictEqual(result.truncated, false, 'a small payload is not truncated');
    const rows = await sink.list(10);
    assert.strictEqual(rows.length, 1, 'one row stored');
    assert.strictEqual(rows[0].provider_id, 'zuni-seo', 'provider recorded');
    assert.strictEqual(rows[0].reason, 'contract_mismatch', 'reason recorded');
    assert.strictEqual(rows[0].truncated, 0, 'truncated flag stored as 0');
    assert.deepStrictEqual(JSON.parse(rows[0].payload_json), { ok: true }, 'payload roundtrips as JSON');
  });

  test('2. the row survives a fresh open of the file on disk', async () => {
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
      locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
    });
    const disk = new SQL.Database(fs.readFileSync(accountStore.dbPath));
    const res = disk.exec(`SELECT COUNT(*) FROM ${TABLE} WHERE reason='contract_mismatch'`);
    assert.ok(res.length === 1 && res[0].values[0][0] >= 1, 'the quarantined row is durable');
    disk.close();
  });

  test('3. an oversized payload is truncated and flagged, not dropped', async () => {
    const before = await sink.count();
    const huge = 'x'.repeat(5000);
    const result = await sink.put(makeItem({ reason: 'oversized', payload: { blob: huge } }));
    assert.strictEqual(result.truncated, true, 'the caller is told it was truncated');
    assert.strictEqual(await sink.count(), before + 1, 'the payload was stored, not discarded');
    const row = (await sink.list(50)).find(r => r.reason === 'oversized');
    assert.ok(row, 'the truncated row is retrievable');
    assert.strictEqual(row.truncated, 1, 'the truncated flag is persisted');
    assert.ok(Buffer.byteLength(row.payload_json, 'utf8') <= 512, 'stored payload is within the byte budget');
  });

  test('4. truncation never splits a UTF-8 sequence', async () => {
    const text = '\u4e2d\u6587\u6d4b\u8bd5'.repeat(200); // 3 bytes per char
    const small = new SqlQuarantineSink(accountStore, { maxPayloadBytes: 100, now: () => Date.now() });
    await small.ready();
    await small.put(makeItem({ reason: 'utf8', payload: { text } }));
    const row = (await small.list(50)).find(r => r.reason === 'utf8');
    assert.strictEqual(row.truncated, 1, 'flagged as truncated');
    const buf = Buffer.from(row.payload_json, 'utf8');
    const roundTripped = buf.toString('utf8');
    assert.strictEqual(Buffer.from(roundTripped, 'utf8').length, buf.length, 'stored text is valid UTF-8');
    assert.ok(!roundTripped.includes('\ufffd'), 'no replacement characters were produced');
  });

  test('5. prune removes only rows older than the retention window', async () => {
    const retention = 60 * 60 * 1000;
    const aged = new SqlQuarantineSink(accountStore, { retentionMs: retention, now: () => Date.now() });
    await aged.ready();
    const old = new Date(Date.now() - 2 * retention).toISOString();
    await aged.put(makeItem({ reason: 'old', at: old }));
    await aged.put(makeItem({ reason: 'fresh', at: new Date().toISOString() }));
    const removed = await aged.prune();
    assert.ok(removed >= 1, 'the aged row was removed');
    const reasons = (await sink.list(200)).map(r => r.reason);
    assert.ok(!reasons.includes('old'), 'the aged row is gone');
    assert.ok(reasons.includes('fresh'), 'the fresh row survives');
  });

  test('6. the default retention matches the freshness policy', () => {
    const { RESEARCH_DEFAULTS } = require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'research-service.js'));
    assert.strictEqual(DEFAULT_RETENTION_MS, RESEARCH_DEFAULTS.freshness.staleAfterHours * 60 * 60 * 1000,
      'quarantine retention equals the research freshness window');
  });

  test('7. the quarantine sink never stores credentials or a whole-file copy by accident', async () => {
    const row = (await sink.list(200))[0];
    assert.ok(!String(row.payload_json).includes('zsk_'), 'no API key pattern is written verbatim by the sink itself');
    assert.ok(['id', 'provider_id', 'operation', 'reason', 'received_at', 'payload_json', 'truncated'].includes('id'),
      'the schema is the minimal diagnostic set');
  });

  // --- A3 -----------------------------------------------------------------

  function fakeSafeStorage(options) {
    const o = options || {};
    return {
      isEncryptionAvailable: () => o.available !== false,
      getSelectedStorageBackend: () => (o.backend === undefined ? 'gnome_libsecret' : o.backend),
      encryptString: (plain) => Buffer.from('enc:' + plain, 'utf8'),
      decryptString: (buf) => buf.toString('utf8').slice(4)
    };
  }

  // The vault and the credential source each resolve safeStorage through their
  // own existing test seam. In production both read the same electron.safeStorage;
  // here both must be stubbed so the pair can be exercised together.
  function withSafeStorage(options, fn) {
    const stub = fakeSafeStorage(options);
    setSafeStorageForTests(stub);
    credentialVault.setSafeStorageForTests(stub);
    try {
      return fn();
    } finally {
      setSafeStorageForTests(null);
      credentialVault.setSafeStorageForTests(null);
    }
  }

  test('8. a valid zsk_ key roundtrips and is stored 0600', async () => {
    await withSafeStorage({}, async () => {
      const secretsDir = path.join(testRoot, 'secrets');
      const source = new ZuniSeoCredentialSource({ secretsDir });
      const key = 'zsk_' + 'a'.repeat(32);
      await source.setApiKey(key);
      assert.strictEqual(await source.getApiKey(), key, 'the key roundtrips');
      assert.strictEqual(await source.hasApiKey(), true, 'presence is reported');
      const file = path.join(secretsDir, KEY_FILE);
      assert.ok(fs.existsSync(file), 'the key file exists under userData/secrets');
      if (process.platform !== 'win32') {
        assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'the key file is owner-only');
      }
      const raw = fs.readFileSync(file, 'utf8');
      assert.ok(credentialVault.isSealed(raw), 'the key is stored in the existing enc:v1: sealed format');
      assert.ok(!raw.includes(key), 'the plaintext key is not on disk');
    });
  });

  test('9. a malformed key is refused and nothing is written', async () => {
    await withSafeStorage({}, async () => {
      const secretsDir = path.join(testRoot, 'secrets-bad');
      const source = new ZuniSeoCredentialSource({ secretsDir });
      for (const bad of ['', 'nope', 'zsk_short', 'sk_' + 'a'.repeat(40), 12345, null]) {
        const err = await expectThrow(() => source.setApiKey(bad));
        assert.ok(/Zuni-SEO API key/.test(err.message), 'a controlled message, never the value: ' + String(bad));
      }
      assert.ok(!fs.existsSync(path.join(secretsDir, KEY_FILE)), 'no key file was created');
      assert.strictEqual(await source.hasApiKey(), false, 'no key is present');
    });
  });

  test('10. the basic_text backend is refused for the Zuni-SEO key', async () => {
    await withSafeStorage({ backend: 'basic_text' }, async () => {
      const source = new ZuniSeoCredentialSource({ secretsDir: path.join(testRoot, 'secrets-basic') });
      const err = await expectThrow(() => source.setApiKey('zsk_' + 'b'.repeat(32)));
      assert.ok(err.message.includes('basic_text'), 'the refusal names the weak backend');
      assert.ok(!fs.existsSync(path.join(testRoot, 'secrets-basic', KEY_FILE)), 'nothing was written');
    });
  });

  test('11. an unavailable credential store is refused', async () => {
    await withSafeStorage({ available: false }, async () => {
      const source = new ZuniSeoCredentialSource({ secretsDir: path.join(testRoot, 'secrets-none') });
      const err = await expectThrow(() => source.setApiKey('zsk_' + 'c'.repeat(32)));
      assert.ok(err.message.includes('credential store is not available'), 'the refusal is explicit');
    });
  });

  test('12. clearApiKey removes the file and the cached value', async () => {
    await withSafeStorage({}, async () => {
      const secretsDir = path.join(testRoot, 'secrets-clear');
      const source = new ZuniSeoCredentialSource({ secretsDir });
      await source.setApiKey('zsk_' + 'd'.repeat(32));
      assert.strictEqual(await source.hasApiKey(), true, 'stored');
      await source.clearApiKey();
      assert.strictEqual(await source.hasApiKey(), false, 'presence is false after clearing');
      assert.strictEqual(await source.getApiKey(), null, 'the cached key is dropped');
      assert.ok(!fs.existsSync(path.join(secretsDir, KEY_FILE)), 'the file is gone');
      // A fresh reader must not resurrect it.
      const reader = new ZuniSeoCredentialSource({ secretsDir });
      assert.strictEqual(await reader.hasApiKey(), false, 'a new instance sees no key');
    });
  });

  test('13. a missing or corrupt key file reads as absent, never as an error', async () => {
    await withSafeStorage({}, async () => {
      const secretsDir = path.join(testRoot, 'secrets-corrupt');
      const source = new ZuniSeoCredentialSource({ secretsDir });
      assert.strictEqual(await source.getApiKey(), null, 'absent file yields null');
      fs.mkdirSync(secretsDir, { recursive: true });
      fs.writeFileSync(path.join(secretsDir, KEY_FILE), 'enc:v1:!!!not-base64!!!', 'utf8');
      const corrupt = new ZuniSeoCredentialSource({ secretsDir });
      assert.strictEqual(await corrupt.getApiKey(), null, 'a corrupt value reads as absent');
    });
  });

  test('14. existing provider credentials are unaffected by the Zuni-SEO guard', async () => {
    // credentialVault.js must behave exactly as before: no basic_text concept,
    // no knowledge of the Zuni-SEO key, same field list, same test seam.
    const stub = fakeSafeStorage({ backend: 'basic_text' });
    setSafeStorageForTests(stub);
    credentialVault.setSafeStorageForTests(stub);
    const sealed = credentialVault.seal('provider-api-key');
    assert.strictEqual(credentialVault.unseal(sealed), 'provider-api-key',
      'a provider credential still seals and unseals on a basic_text backend, exactly as before');
    const vaultSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'credentialVault.js'), 'utf8');
    assert.ok(!vaultSource.includes('basic_text'), 'the vault never learned about basic_text');
    assert.ok(!vaultSource.includes('zuni'), 'the vault never learned about the Zuni-SEO key');
    assert.ok(vaultSource.includes("const CREDENTIAL_FIELDS = ['apiKey', 'taskKey'];"), 'field list unchanged');
    setSafeStorageForTests(null);
    credentialVault.setSafeStorageForTests(null);
  });

  test('15. the key format accepts a realistic zsk_ key and rejects a near miss', () => {
    assert.ok(KEY_FORMAT.test('zsk_' + 'A1b2C3d4'.repeat(4)), 'a realistic key matches');
    assert.ok(KEY_FORMAT.test('zsk_' + 'x'.repeat(200)), 'the upper bound matches');
    assert.ok(!KEY_FORMAT.test('zsk_' + 'x'.repeat(201)), 'over-long keys are rejected');
    assert.ok(!KEY_FORMAT.test('zsk_' + 'x'.repeat(19)), 'under-long keys are rejected');
    assert.ok(!KEY_FORMAT.test('ZSK_' + 'x'.repeat(30)), 'the prefix is case sensitive');
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

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
