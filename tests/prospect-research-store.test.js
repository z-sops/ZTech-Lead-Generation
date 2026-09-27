'use strict';

// A1 - ResearchStateStore mapped onto ZTech's existing AccountStore / sql.js database.
// No second database. CAS is UPDATE ... WHERE id=? AND version=? plus
// getRowsModified() === 1, and the stale case must throw the module's OWN
// StaleRecordError class so research-coordinator.ts:220's instanceof re-read works.

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

const PHASES = {
  nonTerminal: ['requested', 'preflight', 'started', 'polling', 'pending'],
  terminal: ['complete', 'partial', 'failed']
};

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-a1-store-'));
  let currentRoot = testRoot;

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => currentRoot } }
  };
  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const { AccountStore } = require(path.join(__dirname, '..', 'src', 'main', 'accountStore.js'));
  const bundle = require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'prospect-research.cjs'));
  const { SqlResearchStateStore, TABLE, TERMINAL_PHASES } =
    require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'sql-research-store.js'));

  const { StaleRecordError } = bundle;
  const initSqlJs = require('sql.js');
  let sqlJs = null;

  // AccountStore resolves DATA_DIR once at require time, so tests cannot be
  // isolated by userData. Instead the research table itself is emptied before
  // each case, which is the isolation these tests actually need.
  async function isolatedStore(name) {
    void name;
    const dataDir = path.join(currentRoot, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const accountStore = new AccountStore();
    await accountStore.ready;
    const store = new SqlResearchStateStore(accountStore);
    await store.ready();
    accountStore.db.run(`DELETE FROM ${TABLE}`);
    accountStore.saveDB();
    return { accountStore, store, dataDir };
  }

  async function openFromDisk(dataDir) {
    if (!sqlJs) {
      sqlJs = await initSqlJs({
        locateFile: (f) => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', f)
      });
    }
    return new sqlJs.Database(fs.readFileSync(path.join(dataDir, 'whatsapp.db')));
  }

  function makeRecord(overrides) {
    return Object.assign({
      id: 'rec-1',
      leadRef: 'lead-1',
      providerId: 'zuni-seo',
      phase: 'requested',
      nextAttemptAt: null,
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
      version: 1,
      evidence: { packetVersion: 1 }
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

  test('1. the research table is created in the existing whatsapp.db, not a new database', async () => {
    const { accountStore, dataDir } = await isolatedStore('t1');
    assert.strictEqual(accountStore.dbPath, path.join(dataDir, 'whatsapp.db'), 'same db file as the rest of the app');
    const names = accountStore.db.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='${TABLE}'`);
    assert.strictEqual(names.length, 1, 'prospect_research table exists in the existing database');
    const dbs = fs.readdirSync(dataDir).filter((f) => f.endsWith('.db'));
    assert.deepStrictEqual(dbs, ['whatsapp.db'], 'no second database file was created');
  });

  test('2. required indexes exist for lead lookup and due scheduling', async () => {
    const { accountStore } = await isolatedStore('t2');
    const res = accountStore.db.exec(
      `SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='${TABLE}' ORDER BY name`
    );
    const names = res.length ? res[0].values.map((r) => r[0]) : [];
    assert.ok(names.includes(`${TABLE}_lead`), 'lead index created');
    assert.ok(names.includes(`${TABLE}_due`), 'due index created');
  });

  test('3. insert() is on disk before the returned promise resolves', async () => {
    const { store, dataDir } = await isolatedStore('t3');
    await store.insert(makeRecord({ id: 'durable-1' }));
    // No extra flush and no waiting: read the file straight off disk.
    const disk = await openFromDisk(dataDir);
    const res = disk.exec(`SELECT lead_ref, version FROM ${TABLE} WHERE id='durable-1'`);
    assert.strictEqual(res.length, 1, 'row present in a freshly opened copy of the file on disk');
    assert.strictEqual(res[0].values[0][0], 'lead-1', 'lead_ref persisted');
    assert.strictEqual(res[0].values[0][1], 1, 'version persisted');
    disk.close();
  });

  test('4. get() roundtrips the whole record including nested evidence', async () => {
    const { store } = await isolatedStore('t4');
    const record = makeRecord({
      id: 'rt-1',
      evidence: { packetVersion: 1, sections: [{ name: 'technical', untrusted: true }] }
    });
    await store.insert(record);
    assert.deepStrictEqual(await store.get('rt-1'), record, 'record roundtrips unchanged');
    assert.strictEqual(await store.get('does-not-exist'), null, 'unknown id yields null');
  });

  test('5. update() with the correct version succeeds and bumps the stored version', async () => {
    const { store } = await isolatedStore('t5');
    await store.insert(makeRecord({ id: 'cas-1', version: 1 }));
    await store.update(makeRecord({ id: 'cas-1', version: 2, phase: 'started', updatedAt: '2026-03-02T00:00:00.000Z' }));
    const loaded = await store.get('cas-1');
    assert.strictEqual(loaded.version, 2, 'version advanced');
    assert.strictEqual(loaded.phase, 'started', 'phase advanced');
  });

  test('6. a stale update throws the module StaleRecordError class itself', async () => {
    const { store } = await isolatedStore('t6');
    await store.insert(makeRecord({ id: 'cas-2', version: 1 }));
    await store.update(makeRecord({ id: 'cas-2', version: 2, phase: 'started' }));
    // Replaying version 2 must be rejected: the stored version is 2, not 1.
    const err = await expectThrow(() => store.update(makeRecord({ id: 'cas-2', version: 2, phase: 'polling' })));
    assert.ok(err instanceof StaleRecordError, 'thrown object is an instance of the module-exported class');
    assert.strictEqual(err.name, 'StaleRecordError', 'name preserved for logs');
    assert.ok(err.message.includes('cas-2'), 'message names the record');
    const loaded = await store.get('cas-2');
    assert.strictEqual(loaded.version, 2, 'rejected transition did not change the stored version');
    assert.strictEqual(loaded.phase, 'started', 'rejected transition did not change the stored phase');
  });

  test('7. a version gap is rejected, not silently applied', async () => {
    const { store } = await isolatedStore('t7');
    await store.insert(makeRecord({ id: 'gap-1', version: 1 }));
    const err = await expectThrow(() => store.update(makeRecord({ id: 'gap-1', version: 3, phase: 'complete' })));
    assert.ok(err instanceof StaleRecordError, 'gap rejected as stale');
    assert.strictEqual((await store.get('gap-1')).version, 1, 'stored version unchanged');
  });

  test('8. the coordinator can recover from a stale error via instanceof', async () => {
    const { store } = await isolatedStore('t8');
    await store.insert(makeRecord({ id: 'coord-1', version: 1 }));
    await store.update(makeRecord({ id: 'coord-1', version: 2, phase: 'started' }));
    let reRead = null;
    try {
      await store.update(makeRecord({ id: 'coord-1', version: 2 }));
    } catch (e) {
      // Mirrors research-coordinator.ts:220 exactly.
      if (e instanceof StaleRecordError) reRead = await store.get('coord-1');
      else throw e;
    }
    assert.ok(reRead, 'coordinator recovery branch was taken');
    assert.strictEqual(reRead.version, 2, 're-read returns the current record');
    assert.strictEqual(reRead.phase, 'started', 're-read returns the current phase');
  });

  test('9. latestForLead returns the newest record by createdAt', async () => {
    const { store } = await isolatedStore('t9');
    await store.insert(makeRecord({ id: 'l-1', leadRef: 'lead-x', createdAt: '2026-03-01T00:00:00.000Z', updatedAt: '2026-03-01T00:00:00.000Z' }));
    await store.insert(makeRecord({ id: 'l-2', leadRef: 'lead-x', createdAt: '2026-03-05T00:00:00.000Z', updatedAt: '2026-03-02T00:00:00.000Z' }));
    await store.insert(makeRecord({ id: 'l-3', leadRef: 'lead-x', createdAt: '2026-03-03T00:00:00.000Z', updatedAt: '2026-03-09T00:00:00.000Z' }));
    assert.strictEqual((await store.latestForLead('lead-x')).id, 'l-2', 'newest createdAt wins, not the newest updatedAt');
    assert.strictEqual(await store.latestForLead('lead-nope'), null, 'unknown lead yields null');
  });

  test('10. listActive returns only non-terminal phases', async () => {
    const { store } = await isolatedStore('t10');
    for (const phase of PHASES.nonTerminal) {
      await store.insert(makeRecord({ id: `a-${phase}`, leadRef: 'lead-act', phase }));
    }
    for (const phase of PHASES.terminal) {
      await store.insert(makeRecord({ id: `t-${phase}`, leadRef: 'lead-act', phase }));
    }
    const phases = (await store.listActive()).map((r) => r.phase).sort();
    assert.deepStrictEqual(phases, [...PHASES.nonTerminal].sort(), 'exactly the non-terminal phases are resumable');
    assert.deepStrictEqual([...TERMINAL_PHASES].sort(), [...PHASES.terminal].sort(), 'terminal list matches the module reference');
  });

  test('11. duplicate insert is rejected and leaves the stored record intact', async () => {
    const { store } = await isolatedStore('t11');
    await store.insert(makeRecord({ id: 'dup-1', version: 1 }));
    await expectThrow(() => store.insert(makeRecord({ id: 'dup-1', version: 9, phase: 'complete' })));
    const loaded = await store.get('dup-1');
    assert.strictEqual(loaded.version, 1, 'original record untouched');
  });

  test('12. a failed flush is not reported as a successful transition', async () => {
    const { accountStore, store, dataDir } = await isolatedStore('t12');
    const original = accountStore.saveDB;
    accountStore.saveDB = () => { throw new Error('injected persist failure'); };
    const insertErr = await expectThrow(() => store.insert(makeRecord({ id: 'flush-1' })));
    assert.strictEqual(insertErr.message, 'injected persist failure', 'insert propagates the flush failure');
    accountStore.saveDB = original;
    // The in-memory image may still hold the row; what must not happen is the
    // transition being durable, or the caller being told it succeeded.
    const disk = await openFromDisk(dataDir);
    const res = disk.exec(`SELECT id FROM ${TABLE} WHERE id='flush-1'`);
    assert.strictEqual(res.length, 0, 'nothing durable was written when the flush failed');
    disk.close();
  });

  test('13. a store whose database never opened fails with a clear error', async () => {
    const store = new SqlResearchStateStore({ ready: Promise.resolve(), saveDB() {} });
    const err = await expectThrow(() => store.get('anything'));
    assert.ok(err.message.includes('not open'), 'names the unopened database');
  });

  test('14. a store whose database failed to open surfaces the startup failure', async () => {
    const store = new SqlResearchStateStore({
      ready: Promise.reject(new Error('injected init failure')),
      saveDB() {}
    });
    const err = await expectThrow(() => store.get('anything'));
    assert.strictEqual(err.message, 'injected init failure', 'readiness failure is not swallowed');
  });

  test('15. a store without saveDB is rejected at construction', async () => {
    const err = await expectThrow(async () => { new SqlResearchStateStore({ ready: Promise.resolve() }); });
    assert.ok(err.message.includes('saveDB'), 'names the missing contract');
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
