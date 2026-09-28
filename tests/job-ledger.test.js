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
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-b4-jobs-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };

  // Counting logger stub: captures every logged payload so the security
  // tests can prove the ledger path never logs query or credential material.
  const logRecords = [];
  const loggerPath = require.resolve(path.join(__dirname, '..', 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: {
      info(category, message, data) { logRecords.push({ level: 'info', category, message, data }); },
      warn(category, message, data) { logRecords.push({ level: 'warn', category, message, data }); },
      error(category, message, data) { logRecords.push({ level: 'error', category, message, data }); },
      ok(category, message, data) { logRecords.push({ level: 'ok', category, message, data }); }
    } }
  };

  const root = path.join(__dirname, '..');
  const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
  const storeSource = fs.readFileSync(accountStorePath, 'utf8');
  const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');

  const { AccountStore } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const jobsFile = path.join(dataDir, 'jobs.json');
  const dbFile = path.join(dataDir, 'whatsapp.db');

  function resetData() {
    for (const name of fs.readdirSync(dataDir)) {
      try { fs.rmSync(path.join(dataDir, name), { force: true, recursive: true }); } catch {}
    }
  }

  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  async function openJsonStore() {
    const store = await openStore();
    store.db = null;
    store._numbers = [];
    store._jobs = [];
    return store;
  }

  const T_START = '2026-04-01T00:00:00.000Z';
  function jobFixture(overrides) {
    return Object.assign({
      runSlug: 'run-b4-1',
      providerId: 'coreclaw',
      query: 'coffee, bangkok',
      startedAt: T_START,
      completedAt: '',
      status: 'running',
      resultCount: null,
      error: ''
    }, overrides || {});
  }

  const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function extractBlock(source, anchor) {
    const anchorIdx = source.indexOf(anchor);
    assert.ok(anchorIdx > -1, 'anchor present: ' + anchor);
    const openIdx = source.indexOf('{', anchorIdx);
    let depth = 0;
    let closeIdx = -1;
    for (let i = openIdx; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) { closeIdx = i; break; }
      }
    }
    assert.ok(closeIdx > openIdx, 'block structurally closed: ' + anchor);
    return source.slice(anchorIdx, closeIdx + 1);
  }

  function assertJobsEnvelope(result, limit, offset) {
    assert.deepStrictEqual(
      Object.keys(result).sort(),
      ['limit', 'offset', 'rows', 'total'],
      'job envelope must be exactly {rows,total,limit,offset}'
    );
    assert.ok(Array.isArray(result.rows));
    assert.ok(Number.isInteger(result.total) && result.total >= 0);
    assert.strictEqual(result.limit, limit);
    assert.strictEqual(result.offset, offset);
    assert.ok(result.rows.length <= limit, 'rows must never exceed limit');
  }

  async function expectThrow(fn, message) {
    let thrown = null;
    try {
      await fn();
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown, 'expected a thrown persistence error');
    if (message) assert.strictEqual(thrown.message, message);
    return thrown;
  }

  async function withWriteCounter(fn) {
    const original = fs.writeFileSync;
    let count = 0;
    fs.writeFileSync = function (...args) {
      count += 1;
      return original.apply(fs, args);
    };
    try {
      const result = await fn();
      return { result, count };
    } finally {
      fs.writeFileSync = original;
    }
  }

  test('1. jobs schema creation: exact columns, startedAt index, unique (providerId, runSlug), no FK', async () => {
    resetData();
    const store = await openStore();
    assert.ok(store.db, 'SQL mode required for schema assertions');

    const info = store.db.exec('PRAGMA table_info(jobs)');
    // P1-G declared lock update: 9 -> 13 columns. The B4 contract keeps its nine
    // in order; P1-G appends the three save counters and the nullable target
    // pointer.
    assert.ok(info.length === 1 && info[0].values.length === 13, 'jobs table has exactly 13 columns');
    const cols = info[0].values.map(r => r[1]);
    assert.deepStrictEqual(cols, ['id', 'runSlug', 'providerId', 'query', 'startedAt',
      'completedAt', 'status', 'resultCount', 'error',
      'submittedCount', 'addedCount', 'duplicateCount', 'targetId'],
      'the nine B4 columns in order, then the four P1-G columns');

    const idx = store.db.exec('PRAGMA index_list(jobs)');
    assert.ok(idx.length === 1 && idx[0].values.length >= 1, 'index metadata present');
    const idxRows = idx[0].values.map(r => ({ name: r[1], unique: r[2] }));
    assert.ok(idxRows.some(r => r.name === 'idx_jobs_startedAt'), 'idx_jobs_startedAt exists');
    assert.ok(idxRows.some(r => r.name === 'idx_jobs_provider_run'), 'idx_jobs_provider_run exists');
    const unique = idxRows.find(r => r.unique === 1);
    assert.ok(unique, 'a UNIQUE key exists on the jobs table');
    const uniqueInfo = store.db.exec(`PRAGMA index_info(${unique.name})`);
    assert.deepStrictEqual(uniqueInfo[0].values.map(r => r[2]), ['providerId', 'runSlug'],
      'UNIQUE covers exactly (providerId, runSlug)');

    const fks = store.db.exec('PRAGMA foreign_key_list(jobs)');
    assert.ok(!fks.length || !fks[0].values.length, 'no foreign key between jobs and numbers');

    const numInfo = store.db.exec('PRAGMA table_info(numbers)');
    assert.strictEqual(numInfo[0].values.length, 19, 'numbers schema carries the 11 B1 columns, the 3 B6, the 4 P1-C and the 1 P1-D column');
  });

  test('2. idempotent initialization: reopen keeps jobs; a legacy numbers-only database gains them', async () => {
    resetData();
    const first = await openStore();
    const ins = await first.insertJob(jobFixture());
    assert.strictEqual(ins.success, true);

    const second = await openStore();
    const page = await second.queryJobs({ limit: 20, offset: 0 });
    assert.strictEqual(page.total, 1, 'job survives reopening; repeated DDL is a no-op');

    // Pre-B4 database: only the original numbers table exists.
    resetData();
    const SQL = await require('sql.js')();
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE IF NOT EXISTS numbers (
      id TEXT PRIMARY KEY,
      phone TEXT,
      source TEXT,
      keyword TEXT,
      status TEXT DEFAULT 'pending',
      collectedAt TEXT,
      title TEXT,
      website TEXT,
      email TEXT,
      address TEXT,
      runSlug TEXT
    )`);
    legacy.run(`CREATE INDEX IF NOT EXISTS idx_numbers_phone ON numbers(phone)`);
    legacy.run(`CREATE INDEX IF NOT EXISTS idx_numbers_status ON numbers(status)`);
    legacy.run("INSERT INTO numbers (id, phone) VALUES ('legacy-1', '+66800000001')");
    fs.writeFileSync(dbFile, Buffer.from(legacy.export()));

    const migrated = await openStore();
    assert.ok(migrated.db, 'SQL mode on the legacy database');
    const jobInfo = migrated.db.exec('PRAGMA table_info(jobs)');
    assert.ok(jobInfo.length === 1 && jobInfo[0].values.length === 13,
      'jobs table added to a pre-B4 database, with the P1-G columns');
    const legacyRows = await migrated.getCollectedNumbers();
    assert.strictEqual(legacyRows.length, 1, 'legacy lead untouched by the jobs migration');
    assert.strictEqual(legacyRows[0].id, 'legacy-1');
    assert.strictEqual((await migrated.insertJob(jobFixture({ runSlug: 'run-legacy' }))).success, true,
      'jobs usable on the migrated database');
  });

  test('3. SQL/JSON parity: identical inserts, envelopes and terminal fields on both storages', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();

    const inserts = [
      jobFixture({ runSlug: 'run-par-a' }),
      jobFixture({ runSlug: 'run-par-b', query: 'sushi, osaka', startedAt: '2026-04-01T01:00:00.000Z' }),
      jobFixture({ runSlug: 'run-par-c', startedAt: '2026-04-01T02:00:00.000Z' })
    ];
    for (const job of inserts) {
      const s = await sqlStore.insertJob({ ...job });
      const j = await jsonStore.insertJob({ ...job });
      assert.strictEqual(s.success, true);
      assert.strictEqual(j.success, true);
      assert.ok(UUID_PATTERN.test(s.id), 'SQL id is a UUID');
      assert.ok(UUID_PATTERN.test(j.id), 'JSON id is a UUID');
      assert.notStrictEqual(s.id, j.id, 'each storage generates its own local id');
    }

    const strip = rows => rows.map(({ id, ...rest }) => rest);
    const sPage = await sqlStore.queryJobs({ limit: 20, offset: 0 });
    const jPage = await jsonStore.queryJobs({ limit: 20, offset: 0 });
    assertJobsEnvelope(sPage, 20, 0);
    assertJobsEnvelope(jPage, 20, 0);
    assert.strictEqual(sPage.total, 3);
    assert.strictEqual(jPage.total, 3);
    assert.deepStrictEqual(strip(sPage.rows), strip(jPage.rows),
      'running rows are field-identical across storages');

    for (const store of [sqlStore, jsonStore]) {
      const state = await store.updateJobState('coreclaw', 'run-par-a', 'succeeded', '');
      assert.strictEqual(state.updated, true);
      const count = await store.setJobResultCount('coreclaw', 'run-par-a', 7);
      assert.strictEqual(count.updated, true);
    }
    const sDone = (await sqlStore.queryJobs({ limit: 20, offset: 0 })).rows.find(r => r.runSlug === 'run-par-a');
    const jDone = (await jsonStore.queryJobs({ limit: 20, offset: 0 })).rows.find(r => r.runSlug === 'run-par-a');
    assert.strictEqual(sDone.status, 'succeeded');
    assert.strictEqual(jDone.status, 'succeeded');
    assert.strictEqual(sDone.resultCount, 7);
    assert.strictEqual(jDone.resultCount, 7);
    assert.strictEqual(sDone.error, '');
    assert.strictEqual(jDone.error, '');
    assert.ok(!Number.isNaN(Date.parse(sDone.completedAt)), 'SQL completedAt is ISO-8601');
    assert.ok(!Number.isNaN(Date.parse(jDone.completedAt)), 'JSON completedAt is ISO-8601');
    const norm = ({ id, completedAt, ...rest }) =>
      ({ ...rest, completedAtIso: completedAt !== '' && !Number.isNaN(Date.parse(completedAt)) });
    assert.deepStrictEqual(norm(sDone), norm(jDone),
      'terminal rows identical apart from wall-clock id/completedAt');
  });

  test('4. create job: insertJob records the full running contract', async () => {
    resetData();
    const store = await openStore();
    const res = await store.insertJob(jobFixture());
    assert.strictEqual(res.success, true);
    assert.ok(UUID_PATTERN.test(res.id), 'id generated by randomUUID');

    const page = await store.queryJobs({ limit: 20, offset: 0 });
    assertJobsEnvelope(page, 20, 0);
    assert.strictEqual(page.total, 1);
    assert.deepStrictEqual(page.rows[0], {
      id: res.id,
      runSlug: 'run-b4-1',
      providerId: 'coreclaw',
      query: 'coffee, bangkok',
      startedAt: T_START,
      completedAt: '',
      status: 'running',
      resultCount: null,
      error: '',
      // P1-G: a job that recorded no save reads as zero counters and no target.
      submittedCount: 0,
      addedCount: 0,
      duplicateCount: 0,
      targetId: null
    }, 'inserted job matches the approved B4 record plus the safe P1-G defaults');
  });

  test('5. invalid runSlug rejection: nothing reaches either storage', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const bad = ['', 'has space', 'bad/slash', '<script>', 'x'.repeat(201), 'run%20x', 123, null, undefined];
    for (const slug of bad) {
      const s = await sqlStore.insertJob(jobFixture({ runSlug: slug }));
      const j = await jsonStore.insertJob(jobFixture({ runSlug: slug }));
      assert.strictEqual(s.success, false, 'SQL refuses slug: ' + JSON.stringify(slug));
      assert.strictEqual(j.success, false, 'JSON refuses slug: ' + JSON.stringify(slug));
    }
    assert.strictEqual((await sqlStore.queryJobs({ limit: 20, offset: 0 })).total, 0, 'SQL store empty');
    assert.strictEqual((await jsonStore.queryJobs({ limit: 20, offset: 0 })).total, 0, 'JSON store empty');

    // Control: a pattern-clean slug is accepted on both storages.
    assert.strictEqual((await sqlStore.insertJob(jobFixture({ runSlug: 'ok.1_~-z' }))).success, true);
    assert.strictEqual((await jsonStore.insertJob(jobFixture({ runSlug: 'ok.1_~-z' }))).success, true);
    assert.strictEqual((await sqlStore.queryJobs({ limit: 20, offset: 0 })).total, 1);
    assert.strictEqual((await jsonStore.queryJobs({ limit: 20, offset: 0 })).total, 1);
  });

  test('6. providerId validation: bounds enforced on both storages', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const bad = ['', 'x'.repeat(101), 42, null, undefined];
    for (const providerId of bad) {
      const s = await sqlStore.insertJob(jobFixture({ providerId }));
      const j = await jsonStore.insertJob(jobFixture({ providerId }));
      assert.strictEqual(s.success, false, 'SQL refuses providerId: ' + JSON.stringify(providerId));
      assert.strictEqual(j.success, false, 'JSON refuses providerId: ' + JSON.stringify(providerId));
    }
    assert.strictEqual((await sqlStore.queryJobs({ limit: 20, offset: 0 })).total, 0);
    assert.strictEqual((await jsonStore.queryJobs({ limit: 20, offset: 0 })).total, 0);

    const pid100 = 'p'.repeat(100);
    assert.strictEqual((await sqlStore.insertJob(jobFixture({ providerId: pid100, runSlug: 'run-100' }))).success, true,
      'boundary: a 100-char provider id is accepted');
    assert.strictEqual((await jsonStore.insertJob(jobFixture({ providerId: pid100, runSlug: 'run-100' }))).success, true);
  });

  test('7. running -> succeeded: status, stamped completedAt, resultCount untouched', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture());
      const res = await store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');
      assert.deepStrictEqual(res, { success: true, updated: true });
      const row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
      assert.strictEqual(row.status, 'succeeded');
      assert.ok(row.completedAt && !Number.isNaN(Date.parse(row.completedAt)),
        'completedAt stamped on the terminal transition');
      assert.strictEqual(row.resultCount, null, 'unknown resultCount stays NULL');
      assert.strictEqual(row.error, '');
    }
  });

  test('8. running -> failed: status, error persisted only for terminal failures', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const withError = await sqlStore.insertJob(jobFixture());
    assert.strictEqual(withError.success, true);
    const res = await sqlStore.updateJobState('coreclaw', 'run-b4-1', 'failed', 'provider exploded');
    assert.deepStrictEqual(res, { success: true, updated: true });
    let row = (await sqlStore.queryJobs({ limit: 20, offset: 0 })).rows[0];
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, 'provider exploded');
    assert.ok(!Number.isNaN(Date.parse(row.completedAt)), 'completedAt stamped on failure too');

    await jsonStore.insertJob(jobFixture());
    await jsonStore.updateJobState('coreclaw', 'run-b4-1', 'failed', undefined);
    row = (await jsonStore.queryJobs({ limit: 20, offset: 0 })).rows[0];
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.error, '', 'missing provider error becomes an empty string, never undefined');
  });

  test('9. terminal transition set-once: completedAt is never restamped', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture());
      await store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');
      const first = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0].completedAt;
      assert.ok(first !== '', 'first terminal transition stamps completedAt');

      await new Promise(resolve => setTimeout(resolve, 5));
      const changed = await store.updateJobState('coreclaw', 'run-b4-1', 'failed', 'late correction');
      assert.deepStrictEqual(changed, { success: true, updated: true },
        'a canonical change is still recorded');
      const row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
      assert.strictEqual(row.completedAt, first, 'completedAt belongs to the FIRST terminal transition');
      assert.strictEqual(row.status, 'failed');
      assert.strictEqual(row.error, 'late correction');
    }
  });

  test('10. unchanged canonical state performs no write (JSON storage)', async () => {
    resetData();
    const store = await openJsonStore();
    await store.insertJob(jobFixture());

    const nonTerminal = await store.updateJobState('coreclaw', 'run-b4-1', 'running', '');
    assert.strictEqual(nonTerminal.success, false, 'running is not an update target');

    const first = await store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');
    assert.deepStrictEqual(first, { success: true, updated: true });

    const before = fs.readFileSync(jobsFile, 'utf-8');
    const { result, count } = await withWriteCounter(async () =>
      store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', ''));
    assert.deepStrictEqual(result, { success: true, updated: false, reason: 'unchanged' });
    assert.strictEqual(count, 0, 'unchanged canonical state performs zero writes');
    assert.strictEqual(fs.readFileSync(jobsFile, 'utf-8'), before, 'jobs.json bytes unchanged');
  });

  test('11. resultCount set-once: a finalised count is never overwritten', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture());
      const first = await store.setJobResultCount('coreclaw', 'run-b4-1', 42);
      assert.deepStrictEqual(first, { success: true, updated: true });
      assert.strictEqual((await store.queryJobs({ limit: 20, offset: 0 })).rows[0].resultCount, 42);

      const second = await store.setJobResultCount('coreclaw', 'run-b4-1', 99);
      assert.deepStrictEqual(second, { success: true, updated: false, reason: 'already-set' });
      assert.strictEqual((await store.queryJobs({ limit: 20, offset: 0 })).rows[0].resultCount, 42,
        'second finalisation is ignored');
    }
  });

  test('12. unknown resultCount remains NULL; null can never be coerced to 0', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture());
      for (const bogus of [null, undefined, -1, 0.5, '5', NaN]) {
        const res = await store.setJobResultCount('coreclaw', 'run-b4-1', bogus);
        assert.strictEqual(res.success, false,
          'refused resultCount: ' + JSON.stringify(bogus));
      }
      assert.strictEqual((await store.queryJobs({ limit: 20, offset: 0 })).rows[0].resultCount, null,
        'unknown stays NULL, never 0');

      // A genuinely reliable zero (empty result set) is a valid count.
      const zero = await store.setJobResultCount('coreclaw', 'run-b4-1', 0);
      assert.deepStrictEqual(zero, { success: true, updated: true });
      assert.strictEqual((await store.queryJobs({ limit: 20, offset: 0 })).rows[0].resultCount, 0,
        'explicit reliable zero is stored as 0');
    }
  });

  test('13. duplicate (providerId, runSlug) upserts into a single row with a stable id', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      const first = await store.insertJob(jobFixture({ query: 'first query' }));
      assert.strictEqual(first.success, true);
      const again = await store.insertJob(jobFixture({ query: 'second query', startedAt: '2026-04-02T00:00:00.000Z' }));
      assert.strictEqual(again.success, true);
      assert.strictEqual(again.id, first.id, 'upsert keeps the original local id');
      const page = await store.queryJobs({ limit: 20, offset: 0 });
      assert.strictEqual(page.total, 1, 'exactly one row per (providerId, runSlug)');
      assert.strictEqual(page.rows[0].query, 'second query', 'latest observation wins on upsert');
      assert.strictEqual(page.rows[0].startedAt, '2026-04-02T00:00:00.000Z');
    }
  });

  test('14. two runSlugs create two jobs even with an identical query', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      const a = await store.insertJob(jobFixture({ runSlug: 'run-t1' }));
      const b = await store.insertJob(jobFixture({ runSlug: 'run-t2' }));
      assert.strictEqual(a.success, true);
      assert.strictEqual(b.success, true);
      assert.notStrictEqual(a.id, b.id, 'distinct executions get distinct rows');
      const page = await store.queryJobs({ limit: 20, offset: 0 });
      assert.strictEqual(page.total, 2);
      const slugs = page.rows.map(r => r.runSlug).sort();
      assert.deepStrictEqual(slugs, ['run-t1', 'run-t2']);
    }
  });

  test('15. foreign/history slug: updates never create a phantom job', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture({ runSlug: 'run-real' }));
      const state = await store.updateJobState('coreclaw', 'run-ghost', 'succeeded', '');
      assert.deepStrictEqual(state, { success: true, updated: false, reason: 'not-found' });
      const count = await store.setJobResultCount('coreclaw', 'run-ghost', 5);
      assert.deepStrictEqual(count, { success: true, updated: false, reason: 'not-found' });
      const badSlug = await store.updateJobState('coreclaw', 'not a slug', 'succeeded', '');
      assert.strictEqual(badSlug.success, false, 'malformed slug refused before any lookup');

      const page = await store.queryJobs({ limit: 20, offset: 0 });
      assert.strictEqual(page.total, 1, 'no phantom rows inserted');
      assert.strictEqual(page.rows[0].runSlug, 'run-real');
      assert.strictEqual(page.rows[0].status, 'running', 'existing job untouched by ghost updates');
      assert.strictEqual(page.rows[0].resultCount, null);
    }
  });

  test('16. runSlug provenance round-trips byte-exact, including a maximal slug', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const odd = 'run-Abc.123_x~-Z';
    const maximal = 'run-' + 'a'.repeat(196);
    for (const slug of [odd, maximal]) {
      assert.strictEqual(slug.length <= 200, true);
      const s = await sqlStore.insertJob(jobFixture({ runSlug: slug }));
      const j = await jsonStore.insertJob(jobFixture({ runSlug: slug }));
      assert.strictEqual(s.success, true);
      assert.strictEqual(j.success, true);
    }
    const sRows = (await sqlStore.queryJobs({ limit: 20, offset: 0 })).rows;
    const jRows = (await jsonStore.queryJobs({ limit: 20, offset: 0 })).rows;
    const sSlugs = sRows.map(r => r.runSlug).sort();
    const jSlugs = jRows.map(r => r.runSlug).sort();
    assert.deepStrictEqual(sSlugs, [maximal, odd].sort(), 'SQL returns the slug unchanged');
    assert.deepStrictEqual(jSlugs, [maximal, odd].sort(), 'JSON returns the slug unchanged');
  });

  test('17. lead table byte identity: job operations never touch stored leads', async () => {
    resetData();
    const sqlStore = await openStore();
    await sqlStore.addNumbers([{
      id: 'lead-1', phone: '+66811111111', source: 'src', keyword: 'kw',
      status: 'pending', collectedAt: '2026-03-01T00:00:00.000Z',
      title: 'Lead', website: '', email: '', address: '', runSlug: 'run-pre'
    }]);
    const sqlSnapshot = () => JSON.stringify(sqlStore.db.exec('SELECT * FROM numbers ORDER BY rowid'));
    const sqlBefore = sqlSnapshot();
    await sqlStore.insertJob(jobFixture());
    await sqlStore.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');
    await sqlStore.setJobResultCount('coreclaw', 'run-b4-1', 3);
    assert.strictEqual(sqlSnapshot(), sqlBefore, 'numbers relation is byte-identical after job writes');
    assert.strictEqual((await sqlStore.queryJobs({ limit: 20, offset: 0 })).total, 1,
      'the job operations did run');

    const jsonStore = await openJsonStore();
    jsonStore._numbers = [{
      id: 'lead-2', phone: '+66822222222', source: '', keyword: '',
      status: 'pending', collectedAt: '2026-03-02T00:00:00.000Z',
      title: '', website: '', email: '', address: '', runSlug: ''
    }];
    const jsonBefore = JSON.stringify(jsonStore._numbers);
    await jsonStore.insertJob(jobFixture());
    await jsonStore.updateJobState('coreclaw', 'run-b4-1', 'failed', 'x');
    await jsonStore.setJobResultCount('coreclaw', 'run-b4-1', 1);
    assert.strictEqual(JSON.stringify(jsonStore._numbers), jsonBefore,
      'JSON lead array is byte-identical after job writes');
    assert.strictEqual((await jsonStore.queryJobs({ limit: 20, offset: 0 })).total, 1);
  });

  test('18. rollback on SQL persistence failure: insert, state and count all revert', async () => {
    resetData();
    const store = await openStore();
    const failPersist = () => {
      store.saveDB = () => { throw new Error('injected persist failure'); };
    };

    failPersist();
    await expectThrow(() => store.insertJob(jobFixture()), 'injected persist failure');
    assert.strictEqual((await store.queryJobs({ limit: 20, offset: 0 })).total, 0,
      'failed insert rolled back in memory');

    delete store.saveDB;
    await store.insertJob(jobFixture());
    failPersist();
    await expectThrow(() => store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', ''),
      'injected persist failure');
    let row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
    assert.strictEqual(row.status, 'running', 'state change rolled back');
    assert.strictEqual(row.completedAt, '', 'completedAt never stamped when persistence failed');

    await expectThrow(() => store.setJobResultCount('coreclaw', 'run-b4-1', 5),
      'injected persist failure');
    row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
    assert.strictEqual(row.resultCount, null, 'resultCount change rolled back');

    delete store.saveDB;
    const recovered = await store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');
    assert.strictEqual(recovered.updated, true, 'ledger writable again after the failure clears');
    const onDisk = await openStore();
    const diskPage = await onDisk.queryJobs({ limit: 20, offset: 0 });
    assert.strictEqual(diskPage.total, 1, 'only the recovered write reached the file');
    assert.strictEqual(diskPage.rows[0].status, 'succeeded');
  });

  test('19. rollback on JSON persistence failure: array and file revert', async () => {
    resetData();
    const store = await openJsonStore();
    const originalWrite = fs.writeFileSync;
    const failJobsWrite = () => {
      fs.writeFileSync = function (file, ...rest) {
        if (typeof file === 'string' && file.endsWith('jobs.json.tmp')) {
          throw new Error('injected json persist failure');
        }
        return originalWrite.call(fs, file, ...rest);
      };
    };

    try {
      failJobsWrite();
      await expectThrow(() => store.insertJob(jobFixture()), 'injected json persist failure');
      assert.strictEqual(store._jobs.length, 0, 'in-memory array restored after failed insert');
      assert.strictEqual(fs.existsSync(jobsFile), false, 'no partial jobs.json left behind');

      fs.writeFileSync = originalWrite;
      await store.insertJob(jobFixture());
      failJobsWrite();

      await expectThrow(() => store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', ''),
        'injected json persist failure');
      assert.strictEqual(store._jobs[0].status, 'running', 'state restored after failed write');
      assert.strictEqual(store._jobs[0].completedAt, '', 'completedAt restored');

      await expectThrow(() => store.setJobResultCount('coreclaw', 'run-b4-1', 5),
        'injected json persist failure');
      assert.strictEqual(store._jobs[0].resultCount, null, 'count restored after failed write');

      fs.writeFileSync = originalWrite;
      const onDisk = JSON.parse(fs.readFileSync(jobsFile, 'utf-8'));
      assert.strictEqual(onDisk.length, 1, 'only the successful insert is on disk');
      assert.strictEqual(onDisk[0].status, 'running');
      assert.strictEqual(onDisk[0].resultCount, null);
    } finally {
      fs.writeFileSync = originalWrite;
    }
  });

  test('20. corrupted jobs.json: empty ledger plus logged error, storageStatus preserved', async () => {
    resetData();
    fs.writeFileSync(dbFile, Buffer.from('definitely not a sqlite database at all!!'));
    fs.writeFileSync(jobsFile, '{not-json!!');
    const errorsBefore = logRecords.filter(r => r.level === 'error').length;
    const store = await openStore();
    assert.strictEqual(store.db, null, 'corrupt database falls back to JSON storage');
    const page = await store.queryJobs({ limit: 20, offset: 0 });
    assertJobsEnvelope(page, 20, 0);
    assert.strictEqual(page.total, 0, 'unreadable ledger loads as empty');
    assert.ok(logRecords.filter(r => r.level === 'error').length > errorsBefore,
      'the load failure is logged');
    const status = await store.getStorageStatus();
    assert.strictEqual(status.mode, 'json-fallback', 'storageStatus semantics preserved');

    resetData();
    fs.writeFileSync(dbFile, Buffer.from('definitely not a sqlite database at all!!'));
    fs.writeFileSync(jobsFile, JSON.stringify({ not: 'array' }));
    const warnsBefore = logRecords.filter(r => r.level === 'warn').length;
    const store2 = await openStore();
    assert.strictEqual(store2.db, null);
    assert.strictEqual((await store2.queryJobs({ limit: 20, offset: 0 })).total, 0,
      'non-array content loads as empty');
    assert.ok(logRecords.filter(r => r.level === 'warn').length > warnsBefore,
      'non-array content is warned about');
  });

  test('21. corrupted DB: quarantine path intact and the ledger survives via jobs.json', async () => {
    resetData();
    const jsonStore = await openJsonStore();
    await jsonStore.insertJob(jobFixture());
    assert.ok(fs.existsSync(jobsFile), 'ledger persisted as JSON first');

    fs.writeFileSync(dbFile, Buffer.from('garbage bytes, not a sqlite database....'));
    const store = await openStore();
    assert.strictEqual(store.db, null, 'corrupt database quarantined, JSON fallback active');
    const page = await store.queryJobs({ limit: 20, offset: 0 });
    assert.strictEqual(page.total, 1, 'ledger row survives via jobs.json');
    assert.strictEqual(page.rows[0].runSlug, 'run-b4-1');
    assert.strictEqual(page.rows[0].status, 'running');
    const status = await store.getStorageStatus();
    assert.strictEqual(status.mode, 'json-fallback');

    const update = await store.updateJobState('coreclaw', 'run-b4-1', 'failed', 'still writable');
    assert.strictEqual(update.updated, true, 'ledger remains writable in fallback mode');
  });

  test('22. queryJobs pagination: bounded envelopes with page parity across storages', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (let i = 1; i <= 5; i++) {
      const job = jobFixture({ runSlug: 'run-p' + i, startedAt: `2026-04-01T0${i}:00:00.000Z` });
      await sqlStore.insertJob({ ...job });
      await jsonStore.insertJob({ ...job });
    }
    const pages = [[2, 0], [2, 2], [5, 0], [3, 4], [20, 0], [1, 4]];
    for (const [limit, offset] of pages) {
      const s = await sqlStore.queryJobs({ limit, offset });
      const j = await jsonStore.queryJobs({ limit, offset });
      assertJobsEnvelope(s, limit, offset);
      assertJobsEnvelope(j, limit, offset);
      assert.strictEqual(s.total, 5);
      assert.strictEqual(j.total, 5);
      assert.deepStrictEqual(s.rows.map(r => r.runSlug), j.rows.map(r => r.runSlug),
        `page parity at limit=${limit} offset=${offset}`);
    }
  });

  test('23. startedAt DESC ordering with rowid DESC tie-break on both storages', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    const shuffled = [
      { runSlug: 'run-oC', startedAt: '2026-04-01T02:00:00.000Z' },
      { runSlug: 'run-oA', startedAt: '2026-04-01T00:00:00.000Z' },
      { runSlug: 'run-oB', startedAt: '2026-04-01T01:00:00.000Z' },
      { runSlug: 'run-tie-x', startedAt: '2026-04-01T09:00:00.000Z' },
      { runSlug: 'run-tie-y', startedAt: '2026-04-01T09:00:00.000Z' }
    ];
    const expected = ['run-tie-y', 'run-tie-x', 'run-oC', 'run-oB', 'run-oA'];
    for (const job of shuffled) {
      await sqlStore.insertJob(jobFixture(job));
      await jsonStore.insertJob(jobFixture(job));
    }
    const sOrder = (await sqlStore.queryJobs({ limit: 20, offset: 0 })).rows.map(r => r.runSlug);
    const jOrder = (await jsonStore.queryJobs({ limit: 20, offset: 0 })).rows.map(r => r.runSlug);
    assert.deepStrictEqual(sOrder, expected, 'SQL orders startedAt DESC, later insert first on ties');
    assert.deepStrictEqual(jOrder, expected, 'JSON mirrors the SQL ordering exactly');
  });

  test('24. malformed paging collapses to defaults; bounds edge is accepted verbatim', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    await sqlStore.insertJob(jobFixture());
    await jsonStore.insertJob(jobFixture());

    const malformed = [undefined, null, 'junk', [], {}, { limit: 0 }, { limit: -5 }, { limit: 101 },
      { limit: 2.5 }, { limit: '5' }, { limit: null }, { offset: -1 }, { offset: 100001 },
      { offset: '2' }, { offset: 1.5 }];
    for (const query of malformed) {
      const s = await sqlStore.queryJobs(query);
      const j = await jsonStore.queryJobs(query);
      assertJobsEnvelope(s, 20, 0);
      assertJobsEnvelope(j, 20, 0);
      assert.strictEqual(s.total, 1, 'default envelope preserves the total: ' + JSON.stringify(query));
      assert.strictEqual(j.total, 1);
    }

    const edge = await sqlStore.queryJobs({ limit: 100, offset: 100000 });
    assertJobsEnvelope(edge, 100, 100000);
    assert.strictEqual(edge.total, 1);
    assert.deepStrictEqual(edge.rows, [], 'upper-bound paging is legal and empty');
    const edgeJson = await jsonStore.queryJobs({ limit: 100, offset: 100000 });
    assertJobsEnvelope(edgeJson, 100, 100000);
    assert.deepStrictEqual(edgeJson.rows, []);
  });

  test('25. error capped at 500 characters on insert and on failure updates', async () => {
    resetData();
    const sqlStore = await openStore();
    const jsonStore = await openJsonStore();
    for (const store of [sqlStore, jsonStore]) {
      await store.insertJob(jobFixture({ error: 'E'.repeat(600) }));
      let row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
      assert.strictEqual(row.error.length, 500, 'insert-time error truncated to 500');

      await store.updateJobState('coreclaw', 'run-b4-1', 'failed', 'F'.repeat(600));
      row = (await store.queryJobs({ limit: 20, offset: 0 })).rows[0];
      assert.strictEqual(row.error.length, 500, 'update-time error truncated to 500');
      assert.strictEqual(row.error, 'F'.repeat(500));
    }
  });

  test('26. credential-token exclusion across the store and every ledger hook', () => {
    assert.ok(!/apiKey|taskKey|credentials|Bearer/i.test(storeSource),
      'accountStore carries no credential tokens');
    for (const fn of ['recordJobSubmitted', 'recordJobState', 'recordJobResultCount', 'normalizeJobStatus']) {
      const block = extractBlock(mainSource, 'function ' + fn);
      assert.ok(!/apiKey|taskKey|credentials|Bearer/i.test(block),
        fn + ' must not reference credentials');
    }
  });

  test('27. no unsafe logging: query text and credentials never reach the log stream', () => {
    const bannedKeys = ['query', 'keywords', 'apiKey', 'taskKey', 'credentials'];
    for (const rec of logRecords) {
      if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
        for (const key of Object.keys(rec.data)) {
          assert.ok(!bannedKeys.includes(key),
            `logged key '${key}' is not allowed in: ${rec.message}`);
        }
      }
      const dump = JSON.stringify(rec.data === undefined ? null : rec.data);
      assert.ok(!dump.includes('coffee, bangkok'), 'query text must never be logged');
      assert.ok(!dump.includes('Bearer'), 'authorization material must never be logged');
    }
    const ledgerLogLines = storeSource.split('\n')
      .filter(l => l.includes('logger.') && l.includes("'job'"));
    assert.strictEqual(ledgerLogLines.length, 7,
      'seven ledger event sites: insert upsert/new (sql), insert (json), state (sql/json), count (sql/json)');
    for (const line of ledgerLogLines) {
      assert.ok(!line.includes('query'), 'ledger log line must not carry the query: ' + line.trim());
    }
  });

  test('28. no eval or dynamic Function construction in the changed sources', () => {
    for (const [name, src] of [['accountStore.js', storeSource], ['main.js', mainSource]]) {
      assert.ok(!/[^a-zA-Z.]eval\s*\(/.test(src), name + ' must not call eval');
      assert.ok(!/new Function/.test(src), name + ' must not build a Function dynamically');
    }
  });

  test('29. collection submit hook: job recorded only after provider success, with approved fields', () => {
    const submitBlock = extractBlock(mainSource, 'async function handleCollectionSubmit');
    const submitIdx = submitBlock.indexOf('await adapter.submitCollection(');
    const callIdx = submitBlock.indexOf('recordJobSubmitted(');
    assert.ok(submitIdx > -1, 'provider submit present');
    assert.ok(callIdx > submitIdx, 'ledger hook runs only after the provider call resolves');
    assert.ok(submitBlock.includes('recordJobSubmitted(adapter.providerId'),
      'recorded providerId comes from the resolved adapter');

    const recBlock = extractBlock(mainSource, 'async function recordJobSubmitted');
    assert.ok(recBlock.includes('submitResult.success !== true'), 'failed submissions never create a job');
    assert.ok(recBlock.includes('submitResult.data && submitResult.data.run_slug'),
      'runSlug read from the provider response');
    assert.ok(recBlock.includes("query: Array.isArray(shaped.keywords) ? shaped.keywords.join(', ') : ''"),
      'query preserved in the approved join format');
    assert.ok(recBlock.includes("status: 'running'"), 'jobs start as running');
    assert.ok(recBlock.includes('startedAt: new Date().toISOString()'), 'ISO-8601 start time');
    assert.ok(recBlock.includes("completedAt: ''"), 'completedAt empty until terminal');
    assert.ok(recBlock.includes('accountStore.insertJob('), 'persisted through the store');
    assert.ok(recBlock.includes('catch (err)') && recBlock.includes("logger.error('job'"),
      'best-effort: ledger failures are logged, never thrown at the IPC caller');
  });

  test('30. job-status hook: only evidenced terminal states update the ledger', () => {
    const statusBlock = extractBlock(mainSource, 'async function handleGetJobState');
    assert.ok(statusBlock.includes('recordJobState(adapter.providerId'),
      'status hook records via the resolved adapter id');

    const recBlock = extractBlock(mainSource, 'async function recordJobState');
    assert.ok(recBlock.includes('stateResult.success !== true'),
      'transport failures never reach the ledger');
    assert.ok(recBlock.includes('normalizeJobStatus('), 'state normalised before recording');
    assert.ok(recBlock.includes('if (!canonical) return;'),
      'non-terminal states leave the ledger untouched');
    assert.ok(recBlock.includes('accountStore.updateJobState('), 'persisted through the store');
    assert.ok(recBlock.includes("canonical === 'failed' && typeof data.error === 'string'"),
      'error captured only on a terminal failure, never from transient poll errors');

    const normBlock = extractBlock(mainSource, 'function normalizeJobStatus');
    for (const literal of ["'succeeded'", "'completed'", "'success'", "'failed'", "'error'"]) {
      assert.ok(normBlock.includes(literal), 'evidenced state literal present: ' + literal);
    }
    assert.ok(normBlock.includes('return null;'), 'unknown states are non-terminal (no invented states)');
    assert.ok(!/cancel|partial|queued|retrying/i.test(normBlock),
      'no invented lifecycle states in the normaliser');
  });

  test('31. job-result hook: final-page rule only, set-once through the store', () => {
    const resultBlock = extractBlock(mainSource, 'async function handleGetJobResults');
    assert.ok(resultBlock.includes('recordJobResultCount(adapter.providerId'),
      'result hook records via the resolved adapter id');

    const recBlock = extractBlock(mainSource, 'async function recordJobResultCount');
    assert.ok(recBlock.includes('result.success !== true'), 'failed fetches record nothing');
    assert.ok(recBlock.includes('Array.isArray(result.data.list)'), 'page list inspected defensively');
    assert.ok(recBlock.includes('Number.isInteger(options.limit) ? options.limit : 100'),
      'requested limit defaults exactly like the adapter');
    assert.ok(recBlock.includes('if (list.length >= limit) return;'),
      'final-page rule: only a short page proves the count');
    assert.ok(recBlock.includes('offset + list.length'), 'count = offset + page length');
    assert.ok(recBlock.includes('accountStore.setJobResultCount('), 'persisted through the store');
    assert.ok(!recBlock.includes('total'), 'no undocumented provider total field is assumed');
    assert.ok(recBlock.includes('catch (err)') && recBlock.includes("logger.error('job'"),
      'best-effort: count failures are logged, never thrown');
  });

  test('32. adapter.providerId is the only providerId recorded; no preference logic anywhere', () => {
    const submitBlock = extractBlock(mainSource, 'async function handleCollectionSubmit');
    const stateBlock = extractBlock(mainSource, 'async function handleGetJobState');
    const resultBlock = extractBlock(mainSource, 'async function handleGetJobResults');
    assert.ok(submitBlock.includes('recordJobSubmitted(adapter.providerId'), 'submit uses resolved id');
    assert.ok(stateBlock.includes('recordJobState(adapter.providerId'), 'status uses resolved id');
    assert.ok(resultBlock.includes('recordJobResultCount(adapter.providerId'), 'results use resolved id');
    assert.ok(!submitBlock.includes('recordJobSubmitted(providerId'), 'payload providerId never recorded');
    assert.ok(!stateBlock.includes('recordJobState(providerId'), 'payload providerId never recorded');
    assert.ok(!resultBlock.includes('recordJobResultCount(providerId'), 'payload providerId never recorded');
    for (const fn of ['recordJobSubmitted', 'recordJobState', 'recordJobResultCount', 'normalizeJobStatus']) {
      const block = extractBlock(mainSource, 'function ' + fn);
      assert.ok(!/priority|rank|failover|preferred|fallback|score/i.test(block),
        fn + ' stays provider-neutral');
    }
  });

  test('33. ledger internals stay unexposed; reads use only the declared B5 channel', () => {
    // P1-E declared lock update: channel count 20 -> 21. The addition is
    // collector:duplicate-review, a read-only lead review; it is unrelated to
    // the B4 ledger, whose internals (queryJobs symbol, write APIs) must still
    // not reach preload/renderer, and no jobs namespace may appear.
    const handles = mainSource.match(/ipcMain\.handle\(/g) || [];
    // F6 declared lock update: 26 -> 33, the seven sender-checked Lists channels.
    // F8 declared lock update: 33 -> 34, intelligence:icp.
    assert.strictEqual(handles.length, 34, 'exactly 34 IPC channels (P1-G report, F6 Lists and F8 ICP channels)');
    assert.ok(mainSource.includes("ipcMain.handle('collector:get-jobs'"), 'B5 jobs read channel registered');
    const ledgerApis = ['queryJobs', 'insertJob', 'updateJobState', 'setJobResultCount'];
    for (const api of ledgerApis) {
      assert.ok(!preloadSource.includes(api), 'preload must not expose: ' + api);
      assert.ok(!rendererSource.includes(api), 'renderer must not reference: ' + api);
    }
    assert.ok(!rendererSource.includes('appAPI.jobs'), 'no ledger namespace in the renderer');
  });

  test('34. no-write state-change guard: gate precedes the UPDATE and writes nothing', async () => {
    const stateIdx = storeSource.indexOf('_updateJobStateSql(providerId, runSlug, status, errorText) {');
    assert.ok(stateIdx > -1, 'SQL state updater located');
    const gateIdx = storeSource.indexOf('if (existing.status === status)', stateIdx);
    const updateIdx = storeSource.indexOf('UPDATE jobs SET status', stateIdx);
    assert.ok(gateIdx > -1 && gateIdx < updateIdx,
      'unchanged-status gate returns before the UPDATE statement');

    resetData();
    const store = await openStore();
    await store.insertJob(jobFixture());
    await store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', '');

    const repeat = await withWriteCounter(async () =>
      store.updateJobState('coreclaw', 'run-b4-1', 'succeeded', ''));
    assert.deepStrictEqual(repeat.result, { success: true, updated: false, reason: 'unchanged' });
    assert.strictEqual(repeat.count, 0, 'unchanged canonical state performs zero disk writes');

    const nonTerminal = await withWriteCounter(async () =>
      store.updateJobState('coreclaw', 'run-b4-1', 'running', ''));
    assert.strictEqual(nonTerminal.result.success, false);
    assert.strictEqual(nonTerminal.count, 0, 'non-terminal target refused without a write');
  });

  test('35. declared 26-channel contract intact, byte for byte', () => {
    // P1-C declared lock update: the set grows by exactly one audited channel,
    // collector:update-lead-quality (P1-C user-owned lead status write);
    // everything else is byte identical to the B6.4.2 contract.
    const channels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map(m => m[1]);
    const expected = [
      'provider:set-credentials', 'provider:test-connection',
      'collection:submit', 'collection:job-status', 'collection:job-result', 'collection:job-history',
      'settings:save', 'settings:load',
      'collector:get-numbers', 'collector:add-numbers', 'collector:export-numbers',
      'collector:delete-numbers', 'collector:storage-status',
      'collector:get-jobs',
      'collector:update-lead',
      'collector:update-lead-quality',
      'collector:duplicate-review',
      'targets:list', 'targets:save', 'targets:set-status',
      'collector:quality-report', 'collector:quality-target-report',
      'logs:export', 'logs:dir', 'logs:report',
      'proxy:detect',
      // F6 declared lock update: +7 sender-checked Lists channels.
      'saved-searches:list', 'saved-searches:save', 'saved-searches:delete',
      'segments:list', 'segments:save', 'segments:members', 'segments:delete',
      // F8 declared lock update: +1 read-only ICP channel.
      'intelligence:icp'
    ];
    assert.strictEqual(channels.length, 34, 'exactly 34 channels');
    assert.deepStrictEqual(channels.slice().sort(), expected.slice().sort(),
      'the channel set is the P1-E set plus the three P1-F target channels only');
    for (const ch of expected) {
      const occurrences = mainSource.split(`ipcMain.handle('${ch}'`).length - 1;
      assert.strictEqual(occurrences, 1, 'channel registered exactly once: ' + ch);
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
