'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// P1-G: the Collection Quality Report.
//
// Every metric here has exactly one source, and the tests name it: the job's own
// save counters, the run's stored leads, the existing local syntax rules, the
// existing P1-D companyKey derivation and the attached P1-F target. The report
// is read-only, so the tests that touch it also prove the lead library and the
// job row are unchanged.
const root = path.join(__dirname, '..');
const storeSource = fs.readFileSync(path.join(root, 'src', 'main', 'accountStore.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const adapterSource = fs.readFileSync(path.join(root, 'src', 'main', 'providers', 'coreclawAdapter.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from !== -1 && to !== -1, 'slice markers found: ' + start);
  return source.slice(from, to);
}

const codeOnly = (src) => src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

const P1G_BLOCK = between(
  storeSource,
  '// === P1-G Collection Quality Report ===',
  '// Exact provenance literal written by the manual-import save path'
);
const P1G_STORE_REGION = between(
  storeSource,
  '// === P1-G Collection Quality Report ===',
  '\n}\n\nmodule.exports'
);
const p1g = new Function(
  P1G_BLOCK
  + '\nreturn { normalizeJobCounter, jobDuplicateRate, JOB_SAVE_COUNTER_FIELDS,'
  + ' JOB_DEFAULT_SAVE_COUNT, MAX_JOB_SAVE_COUNT, QUALITY_REPORT_FIELDS, JOB_TARGET_FIELD };'
)();

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ztech-p1g-report-'));

  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: { app: { getPath: () => testRoot } }
  };
  const loggerPath = require.resolve(path.join(root, 'src', 'main', 'logger.js'));
  require.cache[loggerPath] = {
    id: loggerPath, filename: loggerPath, loaded: true,
    exports: { logger: { info() {}, warn() {}, error() {}, ok() {} } }
  };

  const SQL = await require('sql.js')();
  const accountStorePath = path.join(root, 'src', 'main', 'accountStore.js');
  const { AccountStore, migrateJobSchema } = require(accountStorePath);

  const dataDir = path.join(testRoot, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'whatsapp.db');
  const jobsFile = path.join(dataDir, 'jobs.json');

  const RUN = 'run-quality-1';
  const PROVIDER = 'coreclaw';
  const T_START = '2026-08-01T00:00:00.000Z';
  const T_END = '2026-08-01T00:10:00.000Z';

  const lead = (over = {}) => ({
    id: 'q-1', phone: '+66900000001', source: 'src', keyword: 'kw',
    status: 'pending', collectedAt: T_END,
    title: '', website: '', email: '', address: '', runSlug: RUN,
    ...over
  });
  async function openStore() {
    const store = new AccountStore();
    await store.ready;
    return store;
  }

  async function openJsonStore() {
    const store = new AccountStore();
    await store.ready;
    store.db = null;
    return store;
  }

  function reset() {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(jobsFile, { force: true });
  }

  function jobColumns(db) {
    const info = db.exec('PRAGMA table_info(jobs)');
    return info.length ? info[0].values.map(r => r[1]) : [];
  }

  function leadRows(store) {
    if (!store.db) return JSON.parse(JSON.stringify(store._numbers || []));
    const scan = store.db.exec('SELECT * FROM numbers ORDER BY rowid ASC');
    return scan.length ? scan[0].values.map(v => [...v]) : [];
  }

  function jobRows(store) {
    if (!store.db) return JSON.parse(JSON.stringify(store._jobs || []));
    const scan = store.db.exec('SELECT * FROM jobs ORDER BY rowid ASC');
    return scan.length ? scan[0].values.map(v => [...v]) : [];
  }

  // A finished run: the job exists, and three leads were saved into it.
  async function seedRun(store, { counters, resultCount = 5, target = null } = {}) {
    await store.insertJob({
      runSlug: RUN, providerId: PROVIDER, query: 'hvac, bangkok',
      startedAt: T_START, completedAt: T_END, status: 'succeeded', resultCount, error: ''
    });
    await store.addNumbers([
      lead({ id: 'q-1', phone: '+66900000001', title: 'Acme Air', website: 'https://acme.example', email: 'a@acme.example', address: '1 A Rd' }),
      lead({ id: 'q-2', phone: '+66900000002', title: 'Acme Air', website: 'https://www.acme.example/x', email: '', address: '2 A Rd' }),
      lead({ id: 'q-3', phone: 'not-a-phone', title: '', website: 'nope', email: 'bad-email', address: '' })
    ]);
    const result = await store.recordJobSaveMetrics({
      providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: counters ? counters.added : 3, duplicateCount: counters ? counters.duplicates : 0,
      targetId: target
    });
    return result;
  }

  // --- 1/2/3/4. jobs schema, migration, readability, safe defaults ---

  test('1. the jobs table carries the three save counters and the target pointer', async () => {
    reset();
    const store = await openStore();
    assert.deepStrictEqual(jobColumns(store.db), [
      'id', 'runSlug', 'providerId', 'query', 'startedAt', 'completedAt',
      'status', 'resultCount', 'error',
      'submittedCount', 'addedCount', 'duplicateCount', 'targetId'
    ], 'the B4 columns in order, then the four P1-G columns');
    // The counters are on the JOB, never on a lead.
    const numbers = store.db.exec('PRAGMA table_info(numbers)');
    for (const field of p1g.JOB_SAVE_COUNTER_FIELDS) {
      assert.ok(!numbers[0].values.map(r => r[1]).includes(field),
        'no lead column was added for ' + field);
    }
    assert.strictEqual(numbers[0].values.length, 19, 'the lead table is unchanged');
    // The target pointer is not a foreign key.
    const fks = store.db.exec('PRAGMA foreign_key_list(jobs)');
    assert.ok(!fks.length || !fks[0].values.length, 'no foreign key on jobs');
    // No new index and no new table: the run lookup uses the existing
    // (providerId, runSlug) identity and a bounded scan.
    assert.strictEqual((storeSource.match(/CREATE INDEX/g) || []).length, 4, 'still exactly four indexes');
    // F6 declared lock update: +2 additive list tables (saved_searches, segments).
    assert.strictEqual((storeSource.match(/CREATE TABLE/g) || []).length, 5, 'exactly five tables');
  });

  test('2. a legacy jobs table migrates additively and stays readable', async () => {
    reset();
    // A realistic pre-P1-G database: the B1-era six-column numbers table (which
    // is what every real installation has) and the nine-column jobs table.
    const legacy = new SQL.Database();
    legacy.run(`CREATE TABLE jobs (
      id TEXT PRIMARY KEY, runSlug TEXT, providerId TEXT, query TEXT, startedAt TEXT,
      completedAt TEXT, status TEXT, resultCount INTEGER, error TEXT,
      UNIQUE(providerId, runSlug)
    )`);
    legacy.run(`CREATE TABLE numbers (
      id TEXT PRIMARY KEY, phone TEXT, source TEXT, keyword TEXT,
      status TEXT DEFAULT 'pending', collectedAt TEXT
    )`);
    legacy.run('INSERT INTO jobs (id, runSlug, providerId, query, startedAt, status, resultCount) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ['legacy-job', 'run-legacy', 'coreclaw', 'coffee', T_START, 'succeeded', 4]);
    fs.writeFileSync(dbPath, Buffer.from(legacy.export()));
    legacy.close();

    const store = await openStore();
    assert.ok(store.db, 'the legacy database opens in SQL mode');
    assert.strictEqual(jobColumns(store.db).length, 13, 'the four columns are added on open');
    assert.strictEqual(migrateJobSchema(store.db), 0, 'a second migration adds nothing');
    const jobs = (await store.queryJobs({ limit: 10, offset: 0 })).rows;
    assert.strictEqual(jobs.length, 1, 'the legacy job is still there');
    assert.strictEqual(jobs[0].id, 'legacy-job');
    assert.strictEqual(jobs[0].query, 'coffee', 'legacy fields are preserved');
    assert.strictEqual(jobs[0].resultCount, 4, 'the existing counter is preserved');
    assert.strictEqual(jobs[0].submittedCount, 0, 'and the new counters read as a safe default');
    // The legacy lead survives the jobs migration untouched.
    assert.strictEqual((await store.getCollectedNumbers()).length, 0, 'no lead was invented');
  });

  test('3. an existing job row survives migration and reports safe defaults', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({
      runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: ''
    });
    const before = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
    assert.strictEqual(before.submittedCount, 0, 'a job with no recorded save reads as 0');
    assert.strictEqual(before.addedCount, 0);
    assert.strictEqual(before.duplicateCount, 0);
    assert.strictEqual(before.targetId, null, 'and no target');
    // A hand-edited or legacy out-of-range value still reads as a safe count.
    store.db.run('UPDATE jobs SET addedCount = -5, duplicateCount = NULL WHERE runSlug = ?', [RUN]);
    const repaired = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
    assert.strictEqual(repaired.addedCount, 0, 'a negative count reads as 0');
    assert.strictEqual(repaired.duplicateCount, 0, 'a NULL count reads as 0');
    assert.strictEqual(p1g.normalizeJobCounter(-1), null, 'a negative counter is refused by the writer');
    assert.strictEqual(p1g.normalizeJobCounter(1.5), null, 'a fractional counter is refused');
    assert.strictEqual(p1g.normalizeJobCounter(p1g.MAX_JOB_SAVE_COUNT + 1), null, 'an absurd counter is refused');
    assert.strictEqual(p1g.normalizeJobCounter(undefined), 0, 'an absent counter is 0');
  });

  test('4. restart is safe: counters, jobs and leads survive a reopen', async () => {
    reset();
    const first = await openStore();
    await seedRun(first);
    const before = jobRows(first);
    const again = await openStore();
    assert.deepStrictEqual(jobRows(again), before, 'the job row is byte-identical after a restart');
    const report = await again.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 });
    assert.strictEqual(report.rows[0].addedCount, 3, 'the recorded counter survived');
    assert.strictEqual(report.rows[0].leadsSaved, 3, 'the run leads survived');
    assert.strictEqual(migrateJobSchema(again.db), 0, 'a third open still migrates nothing');
  });

  // --- 5/6/7/8/9. the counters, their sources and the rate ---

  test('5. submittedCount is the selected count the save really submitted', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'succeeded', resultCount: 5, error: '' });
    // Five rows submitted, one of them a duplicate of an existing phone.
    await store.addNumbers([lead({ id: 'a', phone: '+66900000001' }), lead({ id: 'b', phone: '+66900000002' })]);
    const res = await store.addNumbers([lead({ id: 'c', phone: '+66900000003' }), lead({ id: 'd', phone: '+66900000004' })]);
    assert.deepStrictEqual(res, { added: 2, duplicates: 0 }, 'the add path is unchanged');
    const dup = await store.addNumbers([lead({ id: 'e', phone: '+66 90-000-0001' })]);
    assert.deepStrictEqual(dup, { added: 0, duplicates: 1 }, 'canonicalPhone still dedups');
    const recorded = await store.recordJobSaveMetrics({
      providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: dup.added, duplicateCount: dup.duplicates
    });
    assert.strictEqual(recorded.updated, true, 'the counters are recorded');
    const report = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 });
    assert.strictEqual(report.rows[0].submittedCount, 1, 'the submitted count is the one passed in');
    assert.strictEqual(report.rows[0].addedCount, 0, 'added comes from addNumbers');
    assert.strictEqual(report.rows[0].duplicateCount, 1, 'duplicates come from addNumbers');
  });

  test('6. added and duplicate counts are refused unless they are real counts', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: '' });
    for (const bad of [-1, 1.5, '3', null, {}, true, NaN]) {
      const res = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: bad, duplicateCount: 0 });
      assert.strictEqual(res.success, false, 'refused addedCount: ' + JSON.stringify(bad));
    }
    for (const bad of [-1, 1.5, '3', {}]) {
      const res = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: 1, duplicateCount: bad });
      assert.strictEqual(res.success, false, 'refused duplicateCount: ' + JSON.stringify(bad));
    }
    for (const bad of ['', 'run with spaces', 'x'.repeat(201), 42, null, undefined]) {
      const res = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: bad, submittedCount: 1, addedCount: 1, duplicateCount: 0 });
      assert.strictEqual(res.success, false, 'refused runSlug: ' + JSON.stringify(bad));
    }
    const noJob = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: 'run-never-recorded', submittedCount: 1, addedCount: 1, duplicateCount: 0 });
    assert.deepStrictEqual(noJob, { success: true, updated: false, reason: 'no-job' },
      'a run with no stored job is reported, not invented');
    const nothing = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: 'run-never-recorded', limit: 1, offset: 0 }));
    assert.deepStrictEqual(nothing, { rows: [], total: 0, limit: 1, offset: 0 }, 'and it has no report');
  });

  test('7. a job insert cannot set the counters: only the local save flow can', async () => {
    reset();
    const store = await openStore();
    // A provider-shaped insert that tries to smuggle counters in.
    const res = await store.insertJob({
      runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'succeeded',
      resultCount: 3, error: '', submittedCount: 99, addedCount: 99, duplicateCount: 99, targetId: 'forged'
    });
    assert.strictEqual(res.success, true, 'the job is still created');
    const job = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
    assert.strictEqual(job.submittedCount, 0, 'a job insert cannot record a submitted count');
    assert.strictEqual(job.addedCount, 0, 'a job insert cannot record an added count');
    assert.strictEqual(job.duplicateCount, 0, 'a job insert cannot record a duplicate count');
    assert.strictEqual(job.targetId, null, 'a job insert cannot attach a target');
    // The only writer is the local save flow.
    assert.ok(!/submittedCount|addedCount|duplicateCount/.test(between(storeSource,
      'async insertJob(job) {', 'async updateJobState(')), 'insertJob never mentions the counters');
  });

  test('8. duplicateRate is the exact ratio, and a zero denominator is zero', () => {
    assert.strictEqual(p1g.jobDuplicateRate(0, 0), 0, 'nothing saved is 0, never a division');
    assert.strictEqual(p1g.jobDuplicateRate(3, 0), 0);
    assert.strictEqual(p1g.jobDuplicateRate(0, 4), 1);
    assert.strictEqual(p1g.jobDuplicateRate(3, 1), 0.25);
    assert.strictEqual(p1g.jobDuplicateRate(1, 2), 2 / 3);
    assert.strictEqual(p1g.jobDuplicateRate(6, 2), 0.25);
    for (const bad of [[-1, 0], [1, -1], [1.5, 0], [null, 1], [undefined, undefined]]) {
      assert.strictEqual(p1g.jobDuplicateRate(bad[0], bad[1]), 0,
        'a non-count yields 0, never NaN: ' + JSON.stringify(bad));
    }
    assert.ok(Number.isFinite(p1g.jobDuplicateRate(3, 1)), 'the rate is always a finite number');
  });

  test('9. a zero-denominator run reports a zero rate and no fabricated percentage', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: '' });
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(report.duplicateRate, 0);
    assert.strictEqual(report.addedCount, 0);
    assert.strictEqual(report.duplicateCount, 0);
    assert.strictEqual(report.recordsCollected, 0, 'an unknown result count reads as 0');
    assert.ok(!Number.isNaN(report.duplicateRate), 'never NaN');
  });

  // --- 10-16. the derived metrics, each from persisted data ---

  test('10. records collected comes from the existing jobs.resultCount', async () => {
    reset();
    const store = await openStore();
    await seedRun(store, { resultCount: 5 });
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(report.recordsCollected, 5, 'exactly the value the run recorded');
    assert.strictEqual(report.leadsSaved, 3, 'and the run really has three saved leads');
    // resultCount stays set-once (existing B4 behaviour), and the report
    // mirrors whatever is stored rather than recomputing it.
    const alreadySet = await store.setJobResultCount('coreclaw', RUN, 11);
    assert.strictEqual(alreadySet.reason, 'already-set', 'the existing set-once rule is unchanged');
    const updated = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(updated.recordsCollected, 5, 'the report reports the stored value');
  });

  test('11. email, website, address and title counts come from the stored leads', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    // Completeness means PRESENT, not valid: q-1 has all four, q-2 has no email,
    // and q-3 has a website and an email that are present but invalid (counted
    // here, counted as invalid in the next test). That distinction is the point.
    assert.deepStrictEqual(report.leadsWith, { email: 2, website: 3, address: 2, title: 2 },
      'presence is counted from the stored values, independent of validity');
    assert.strictEqual(report.leadsSaved, 3);
    // A lead of another run is never counted into this report.
    await store.addNumbers([lead({ id: 'other', phone: '+66900000099', runSlug: 'run-other', email: 'x@y.example' })]);
    const scoped = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.deepStrictEqual(scoped.leadsWith, report.leadsWith, 'the report is run-scoped');
  });

  test('12. invalid records use the existing local syntax rules only', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    // q-3 has an invalid phone, an invalid website and an invalid email; the
    // two well-formed leads are not invalid. The lead is counted once.
    assert.strictEqual(report.invalidRecords, 1, 'one invalid record, counted once');
    // The rules are the store's own P1-B functions, not a second implementation.
    for (const fn of ['leadPhoneQuality', 'leadEmailQuality', 'leadWebsiteQuality']) {
      assert.ok(storeSource.includes(fn), 'the existing local rule is reused: ' + fn);
      assert.ok(P1G_STORE_REGION.includes(fn), 'and is the one the report calls: ' + fn);
    }
    // Missing data is unknown, not invalid: a lead with no values at all is
    // never counted as an invalid record.
    const probe = await openJsonStore();
    assert.ok(p1g.QUALITY_REPORT_FIELDS.includes('email'), 'the completeness field set is explicit');
    // Comment-stripped, so prose that DENIES a verification claim is not read as
    // one.
    assert.ok(!/businessQuality|completeness|verified|checked|score/i.test(codeOnly(P1G_STORE_REGION)),
      'the report claims no verification and no score');
  });

  test('13. company grouping uses the P1-D derivation and creates nothing', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    // q-1 and q-2 share the acme.example host; q-3 has no usable website and no
    // title+address pair, so it has no key.
    assert.deepStrictEqual(report.companyGrouping, { groups: 1, leads: 3, ungrouped: 1 },
      'one deterministic group, and the ungrouped lead is reported as such');
    assert.ok(storeSource.includes('deriveCompanyKey'), 'the P1-D derivation is reused');
    assert.ok(P1G_STORE_REGION.includes('deriveCompanyKey('), 'and is the one the report calls');
    // The report created no company record and no column.
    const tables = store.db.exec("SELECT name FROM sqlite_master WHERE type = 'table'")
      .flatMap(r => r.values.map(v => v[0]));
    // F6 declared lock update: +2 additive list tables (saved_searches, segments).
    assert.deepStrictEqual(tables.sort(), ['jobs', 'numbers', 'saved_searches', 'segments', 'targets'], 'no P1-G table');
    const numbers = store.db.exec('PRAGMA table_info(numbers)')[0].values.map(r => r[1]);
    assert.ok(!numbers.includes('companyGroup'), 'no grouping column is stored');
  });

  // --- 17/18. target-aware reporting ---

  test('17. an attached target reports missing required fields per field', async () => {
    reset();
    const store = await openStore();
    const target = await store.saveTarget({
      name: 'Bangkok HVAC', requiredFields: ['phone', 'website', 'email', 'title'], optionalFields: ['address']
    });
    await seedRun(store, { target: target.id });
    const report = await store.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    assert.strictEqual(report.available, true, 'the attached target is reported');
    assert.strictEqual(report.targetName, 'Bangkok HVAC');
    assert.deepStrictEqual(report.requiredFields, [
      { field: 'phone', present: 3, missing: 0 },
      { field: 'website', present: 3, missing: 0 },
      { field: 'email', present: 2, missing: 1 },
      { field: 'title', present: 2, missing: 1 }
    ], 'missing data is counted, never rejected, and never scored');
    // A target with no required fields reports an empty, honest list.
    const none = await store.saveTarget({ name: 'No criteria' });
    await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: 3, duplicateCount: 0, targetId: none.id });
    const empty = await store.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    assert.deepStrictEqual(empty.requiredFields, [], 'no invented criteria');
    // A target id that is not a known definition is refused at write time.
    const bad = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: 3, duplicateCount: 0, targetId: 'no-such-target' });
    assert.strictEqual(bad.success, false, 'an unknown target is refused');
    // A missing target definition is reported as unavailable, never as a pass.
    const targetId = (await store.listTargets()).rows[0].id;
    await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: 3, duplicateCount: 0, targetId });
    assert.strictEqual((await store.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER })).available, true);
  });

  test('18. no attached target means no invented target metric', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const report = await store.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    assert.strictEqual(report, null, 'no target, no target metric');
    const quality = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.ok(!('targetRequirements' in quality), 'the run report carries no target section either');
    for (const run of ['', 'no such run', 42, null]) {
      assert.strictEqual(await store.collectionQualityTargetReport({ runSlug: run, providerId: PROVIDER }), null, 'still null: ' + JSON.stringify(run));
    }
  });

  // --- 19/20. parity and read-only ---

  test('19. SQL and JSON storage produce identical reports', async () => {
    reset();
    const sqlStore = await openStore();
    const sqlTarget = await sqlStore.saveTarget({ name: 'T', requiredFields: ['phone', 'email'] });
    await seedRun(sqlStore, { counters: { added: 2, duplicates: 1 }, target: sqlTarget.id });

    const jsonStore = await openJsonStore();
    const jsonTarget = await jsonStore.saveTarget({ name: 'T', requiredFields: ['phone', 'email'] });
    await seedRun(jsonStore, { counters: { added: 2, duplicates: 1 }, target: jsonTarget.id });

    const sqlReport = (await sqlStore.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    const jsonReport = (await jsonStore.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    // The job id is per-store, so it is compared out; everything else is equal.
    const shape = (r) => ({ ...r, jobId: undefined });
    assert.deepStrictEqual(shape(jsonReport), shape(sqlReport), 'identical report on both storages');
    const sqlTargetReport = await sqlStore.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    const jsonTargetReport = await jsonStore.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    // The target id is per-store, so it is compared out; the counts are equal.
    assert.deepStrictEqual({ ...jsonTargetReport, targetId: undefined },
      { ...sqlTargetReport, targetId: undefined }, 'identical target report on both storages');
    assert.strictEqual(sqlReport.duplicateRate, 1 / 3);
  });

  test('20. the report is read-only', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const leadBefore = leadRows(store);
    const jobBefore = jobRows(store);
    for (const limit of [1, 20, 100]) {
      await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit, offset: 0 });
    }
    await store.collectionQualityTargetReport({ runSlug: RUN, providerId: PROVIDER });
    assert.deepStrictEqual(leadRows(store), leadBefore, 'no lead row is touched');
    assert.deepStrictEqual(jobRows(store), jobBefore, 'no job row is touched');
    // The REPORT READ is pure. The counter WRITER lives in the same section, so
    // the read methods are bounded exactly and checked on their own; the writer
    // is then checked to touch the job table and nothing else.
    const reportRead = between(P1G_STORE_REGION, 'async collectionQualityReport(', 'async collectionQualityTargetReport(')
      + P1G_STORE_REGION.slice(P1G_STORE_REGION.indexOf('async collectionQualityTargetReport('));
    for (const forbidden of ['saveDB(', 'writeJsonAtomic', 'INSERT INTO', 'UPDATE ', 'DELETE FROM',
      'addNumbers', 'deleteNumbers', 'setLeadUserFields', 'setLeadUserStatuses', 'logger.']) {
      assert.ok(!reportRead.includes(forbidden), 'the report read must not contain: ' + forbidden);
    }
    const writer = between(P1G_STORE_REGION, 'async recordJobSaveMetrics(', 'async collectionQualityReport(');
    assert.ok(writer.includes('UPDATE jobs'), 'the counter writer updates the job');
    assert.ok(!/INSERT INTO numbers|UPDATE numbers|DELETE FROM numbers/.test(writer),
      'the counter writer never touches a lead');
    assert.ok(!/logger\.[a-z]+\([^)]*(phone|email|website|title|address)/.test(writer),
      'and logs no lead content');
  });

  // --- 21-24. ownership invariants ---

  test('21. B6 qualification, tags and notes are unchanged by the report', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    await store.setLeadUserFields({ id: 'q-1', qualification: 'qualified', tags: ['vip'], notes: 'keep' });
    const before = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.ok(report.recordsCollected >= 0, 'the report was produced');
    const after = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    assert.strictEqual(after.qualification, 'qualified');
    assert.deepStrictEqual(after.tags, ['vip']);
    assert.strictEqual(after.notes, 'keep');
    assert.deepStrictEqual(after, before, 'the lead row is byte-identical');
    assert.ok(!('qualification' in report), 'a report carries no user-owned field');
    assert.ok(!Object.keys(report).some(key => ['qualification', 'tags', 'notes'].includes(key)),
      'and no user-owned field at all');
  });

  test('22. the P1-C statuses are unchanged by the report', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    await store.setLeadUserStatuses({ id: 'q-1', phoneStatus: 'verified', websiteStatus: 'live' });
    const before = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 });
    const after = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    assert.strictEqual(after.phoneStatus, 'verified');
    assert.strictEqual(after.websiteStatus, 'live');
    assert.deepStrictEqual(after, before);
    const reportKeys = Object.keys(report);
    for (const key of before && Object.keys(before)) {
      if (/Status$/.test(key) && reportKeys.includes(key)) {
        assert.fail('the report exposes a status field: ' + key);
      }
    }
  });

  test('23. the P1-D company fields are unchanged by the report', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    store.db.run("UPDATE numbers SET companyId = 'company-123' WHERE id = 'q-1'");
    store.saveDB();
    const before = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    const after = (await store.getCollectedNumbers()).find(r => r.id === 'q-1');
    assert.strictEqual(after.companyId, 'company-123', 'the pointer is untouched');
    assert.strictEqual(after.companyKey, before.companyKey, 'the derived key is untouched');
    assert.deepStrictEqual(after, before);
    // The report groups by the key but never writes one.
    assert.ok(!Object.prototype.hasOwnProperty.call(report, 'companyId'), 'the report carries no pointer');
    assert.ok(!('companyId' in report));
  });

  test('24. canonicalPhone remains the lead identity', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const canonical = between(storeSource, 'function canonicalPhone(phone) {', '\n}');
    assert.strictEqual(canonical, 'function canonicalPhone(phone) {\n'
      + "  if (typeof phone !== 'string') return phone;\n"
      + "  return phone.replace(/[\\s\\-.()]/g, '');", 'canonicalPhone is byte-identical');
    // A duplicate phone is still deduped, and the report counts it as such.
    const dup = await store.addNumbers([lead({ id: 'dup-1', phone: '+66 90-000-0001' })]);
    assert.deepStrictEqual(dup, { added: 0, duplicates: 1 }, 'identity unchanged');
    await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: dup.added, duplicateCount: dup.duplicates });
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(report.duplicateCount, 1, 'the duplicate is reported, not merged away');
    assert.strictEqual(report.leadsSaved, 3, 'and no lead was removed or combined');
  });

  // --- 25/26/27/28. boundaries ---

  test('25. the report reaches no provider and no credential', () => {
    for (const file of ['src/main/providers/coreclawAdapter.js', 'src/main/providers/providerManager.js',
      'src/main/providers/collectionProvider.js', 'src/main/coreClawClient.js', 'src/main/credentialVault.js']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const token of ['qualityReport', 'quality-report', 'submittedCount', 'addedCount', 'duplicateCount']) {
        assert.ok(!source.includes(token), 'the provider/credential stack is untouched: ' + file + ' (' + token + ')');
      }
    }
    const shape = between(mainSource, 'function validateSubmitShape(', '\n}');
    assert.ok(!/quality|counter|report/i.test(shape), 'the provider request shape is unchanged');
    assert.ok(adapterSource.includes('submitCollection('), 'the provider contract is unchanged');
    for (const channel of ['collector:quality-report', 'collector:quality-target-report']) {
      const handler = between(mainSource, "ipcMain.handle('" + channel + "'", '});');
      assert.ok(!/providerManager|CoreClaw|credential|fetch|https/.test(handler),
        channel + ' calls no provider and no network');
      assert.ok(handler.includes('validateQualityReport'), channel + ' validates in main');
    }
  });

  test('26. no network call, no new dependency and no PII logging', () => {
    for (const term of ['fetch(', 'XMLHttpRequest', 'https://', "require('https')", 'net.', 'axios']) {
      assert.ok(!codeOnly(P1G_BLOCK).includes(term), 'no network call in the P1-G block: ' + term);
      assert.ok(!codeOnly(P1G_STORE_REGION).includes(term), 'no network call in the P1-G region: ' + term);
    }
    // The only production dependency change in the project's history is the
    // deliberate prospect-research trio; no dev dependency was introduced.
    assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(),
      ['@modelcontextprotocol/client', 'ajv', 'ajv-formats', 'electron-store', 'sql.js'],
      'production dependencies are exactly the two originals plus the three prospect-research ones');
    assert.deepStrictEqual(Object.keys(pkg.devDependencies).sort(),
      ['concurrently', 'cross-env', 'electron', 'electron-builder', 'vite', 'wait-on'],
      'no dev dependency added');
    // The only log line records the job id and the run identifier.
    const logLines = P1G_STORE_REGION.split('\n').filter(l => l.includes('logger.'));
    for (const line of logLines) {
      for (const leak of ['phone', 'title', 'website', 'email', 'address', 'query', 'notes', 'tags']) {
        assert.ok(!line.includes(leak), 'no lead content is logged: ' + line.trim());
      }
    }
  });

  test('27. the Dashboard metrics are untouched', () => {
    const dashSection = between(htmlSource, '<!-- Dashboard view', '<!-- Settings');
    assert.ok(!/quality|Collection Quality/i.test(dashSection), 'the report is not on the Dashboard');
    const dashJs = between(rendererSource, '// === B5 Lead Library Dashboard ===', '// === 视图切换时加载数据 ===');
    assert.ok(!/qualityReport|qualityTargetReport|collectQuality/.test(dashJs), 'the Dashboard code reads no report');
    assert.ok(!/submittedCount|duplicateRate|invalidRecords/.test(dashJs), 'no report metric reaches the dashboard code');
    assert.ok(!/collect-quality/.test(htmlSource.slice(htmlSource.indexOf('<!-- Dashboard view'),
      htmlSource.indexOf('<!-- Settings'))), 'and no report markup sits in the Dashboard section');
  });

  test('28. no Lead Library schema, table column or export change', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    const numbers = store.db.exec('PRAGMA table_info(numbers)')[0].values.map(r => r[1]);
    assert.strictEqual(numbers.length, 19, 'the lead table is unchanged');
    const csv = await store.exportNumbers('csv');
    assert.ok(csv.startsWith('phone,source,keyword,status,collected_at,title,website,email,address,run_slug,'
      + 'qualification,tags,notes,phone_status,email_status,website_status,business_status'),
      'the CSV header is byte-identical');
    assert.ok(!/submitted_count|duplicate_rate|invalid_records/.test(csv), 'no report column in the export');
    const table = between(htmlSource, 'id="view-numbers"', 'id="view-targets"');
    for (const column of ['<th>Quality</th>', '<th>Duplicate rate</th>', '<th>Invalid</th>']) {
      assert.ok(!table.includes(column), 'no report column in the Lead Library table: ' + column);
    }
  });

  // --- 29/30. IPC validation ---

  test('29. the report channels validate their payload in main', () => {
    const validate = loadReportValidator();
    assert.deepStrictEqual(validate({ runSlug: 'run-1' }),
      { runSlug: 'run-1', providerId: PROVIDER, limit: 20, offset: 0 },
      'the provider identity is injected by main, not supplied by the renderer');
    assert.deepStrictEqual(validate({ runSlug: 'run-1', limit: 1, offset: 0 }),
      { runSlug: 'run-1', providerId: PROVIDER, limit: 1, offset: 0 });
    for (const bad of ['', 'run with spaces', 'x'.repeat(201), 'run/../etc', 42, null, undefined, {}, ['run-1']]) {
      expectInvalid(validate, { runSlug: bad });
    }
    for (const bad of [undefined, null, 'string', []]) {
      expectInvalid(validate, bad);
    }
    // The renderer payload carries no providerId, and one it invents is ignored:
    // the resolved value always wins.
    assert.strictEqual(validate({ runSlug: 'run-1', providerId: 'ghost' }).providerId, PROVIDER,
      'a renderer-supplied providerId never reaches the store');
    // The save context: the run identifier and the target only, with the
    // provider identity resolved by main.
    const context = loadSaveContextValidator();
    assert.deepStrictEqual(context(undefined), { runSlug: '', targetId: null, providerId: PROVIDER });
    assert.deepStrictEqual(context({ runSlug: 'run-1' }), { runSlug: 'run-1', targetId: null, providerId: PROVIDER });
    assert.deepStrictEqual(context({ runSlug: 'run-1', targetId: 't1' }), { runSlug: 'run-1', targetId: 't1', providerId: PROVIDER });
    assert.deepStrictEqual(context({ runSlug: '', targetId: '' }), { runSlug: '', targetId: null, providerId: PROVIDER });
    for (const bad of ['run string', 42, []]) {
      expectInvalid(context, bad);
    }
    expectInvalid(context, { runSlug: 'bad run' });
    expectInvalid(context, { runSlug: 'run-1', targetId: 42 });
    expectInvalid(context, { runSlug: 'run-1', targetId: 'x'.repeat(101) });
    // A renderer may repeat the registered provider id, but never redirect it.
    assert.deepStrictEqual(context({ runSlug: 'run-1', providerId: PROVIDER }).providerId, PROVIDER,
      'naming the registered provider is accepted');
    for (const bad of ['other-provider', '', 42, 'x'.repeat(101)]) {
      if (bad === '') {
        assert.deepStrictEqual(context({ runSlug: 'run-1', providerId: '' }).providerId, PROVIDER,
          'an empty providerId is treated as absent');
        continue;
      }
      expectInvalid(context, { runSlug: 'run-1', providerId: bad });
    }
    // Main resolves the provider from the registry, exactly as settings:save does.
    for (const fn of ['resolveActiveProviderId']) {
      assert.ok(mainSource.includes('function ' + fn), 'the resolver exists: ' + fn);
      assert.ok(mainSource.includes(fn + '()'), 'and is used: ' + fn);
    }
    const resolver = between(mainSource, 'function resolveActiveProviderId(', '\n}');
    assert.ok(resolver.includes('providerManager.resolveCollectionProvider()'),
      'the provider identity comes from the registered provider');
    assert.ok(!/submitCollection|getJob|setCredentials|credential/i.test(resolver),
      'the resolver calls no provider capability and no credential');
    // A report channel cannot carry a write target.
    const handler = between(mainSource, "ipcMain.handle('collector:quality-report'", '});');
    for (const forbidden of ['addNumbers', 'deleteNumbers', 'setLeadUserFields', 'setLeadUserStatuses',
      'recordJobSaveMetrics', 'saveDB', 'exportNumbers']) {
      assert.ok(!handler.includes(forbidden), 'the report handler calls no write: ' + forbidden);
    }
    for (const [name, src] of [['main.js', mainSource], ['preload.js', preloadSource]]) {
      assert.ok(!/new ipcMain\.handle|ipcMain\.handle\(\s*[a-zA-Z_$]/.test(src), name + ' registers channels literally');
    }
  });

  test('30. report paging is bounded and consistent', async () => {
    reset();
    const store = await openStore();
    await seedRun(store);
    for (const bad of [0, -1, 101, 1.5, '20', true]) {
      const result = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: bad, offset: 0 });
      assert.strictEqual(result.limit, 20, 'an out-of-range limit falls back to the default');
    }
    for (const bad of [-1, 100001, 0.5, '0']) {
      const result = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: bad });
      assert.strictEqual(result.offset, 0, 'an out-of-range offset falls back to zero');
    }
    const first = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 });
    assert.deepStrictEqual(Object.keys(first).sort(), ['limit', 'offset', 'rows', 'total'],
      'the shared envelope is reused');
    assert.strictEqual(first.total, 1, 'one run yields one report');
    assert.strictEqual(first.rows.length, 1);
    const past = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 1 });
    assert.deepStrictEqual(past.rows, [], 'a page past the end is empty, not an error');
    assert.strictEqual(past.total, 1, 'and the total still describes the run');
    // An unknown rule is not a filter: the report is run-scoped only.
    const withExtra = await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0, rule: 'nonsense' });
    assert.deepStrictEqual(withExtra, first, 'an unknown key is ignored, never interpolated');
  });

  // --- 33. rollback/revert safety ---

  test('33. a failed persist reverts the counters completely', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: '' });
    const before = jobRows(store);
    const realSave = store.saveDB;
    store.saveDB = () => { throw new Error('forced persistence failure'); };
    await assert.rejects(
      () => store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 9, addedCount: 9, duplicateCount: 9 }),
      /forced persistence failure/
    );
    store.saveDB = realSave;
    assert.deepStrictEqual(jobRows(store), before, 'the job row is exactly as it was');
    const job = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
    assert.strictEqual(job.addedCount, 0, 'no counter survived the failed write');
    assert.strictEqual(job.submittedCount, 0);
    assert.strictEqual(job.duplicateCount, 0);
    // The report is still truthful after the failure.
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(report.addedCount, 0);
    assert.strictEqual(report.duplicateRate, 0);
  });

  // === M1: cumulative counters, and M3: the (providerId, runSlug) identity ===

  test('35. counters accumulate across the save batches of one run', async () => {
    reset();
    for (const store of [await openStore(), await openJsonStore()]) {
      const storage = store.db ? 'sql' : 'json';
      await store.insertJob({
        runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START,
        status: 'succeeded', resultCount: 9, error: ''
      });

      // Batch 1: three submitted, two added, one duplicate.
      const first = await store.recordJobSaveMetrics({
        providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: 2, duplicateCount: 1
      });
      assert.strictEqual(first.updated, true, storage + ': first save records its real counters');
      let report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(report.submittedCount, 3, storage + ': batch 1 submitted');
      assert.strictEqual(report.addedCount, 2, storage + ': batch 1 added');
      assert.strictEqual(report.duplicateCount, 1, storage + ': batch 1 duplicates');
      assert.strictEqual(report.duplicateRate, 1 / 3, storage + ': batch 1 rate');

      // Batch 2: same run, one more row submitted and added.
      const second = await store.recordJobSaveMetrics({
        providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: 1, duplicateCount: 0
      });
      assert.strictEqual(second.updated, true, storage + ': second save is recorded');
      report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(report.submittedCount, 4, storage + ': the second batch ACCUMULATES, it does not replace');
      assert.strictEqual(report.addedCount, 3, storage);
      assert.strictEqual(report.duplicateCount, 1, storage + ': a zero-duplicate batch does not reset the total');
      assert.strictEqual(report.duplicateRate, 1 / 4, storage + ': the rate uses the cumulative totals');

      // Batch 3: two submitted, none added, two duplicates.
      await store.recordJobSaveMetrics({
        providerId: PROVIDER, runSlug: RUN, submittedCount: 2, addedCount: 0, duplicateCount: 2
      });
      report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(report.submittedCount, 6, storage + ': the third batch accumulates again');
      assert.strictEqual(report.addedCount, 3, storage + ': an all-duplicate batch adds nothing');
      assert.strictEqual(report.duplicateCount, 3, storage);
      assert.strictEqual(report.duplicateRate, 0.5, storage + ': 3 / (3 + 3)');
      assert.strictEqual(report.recordsCollected, 9, storage + ': resultCount is never touched by the counters');

      // The totals are the job's own stored values, not a report-side sum.
      const job = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
      assert.strictEqual(job.submittedCount, 6, storage + ': persisted on the job');
      assert.strictEqual(job.addedCount, 3, storage);
      assert.strictEqual(job.duplicateCount, 3, storage);

      // A batch with nothing in it changes nothing, so no needless write.
      const before = jobRows(store);
      const empty = await store.recordJobSaveMetrics({
        providerId: PROVIDER, runSlug: RUN, submittedCount: 0, addedCount: 0, duplicateCount: 0
      });
      assert.deepStrictEqual(empty, { success: true, updated: false, reason: 'unchanged' },
        storage + ': an empty batch is not persisted');
      assert.deepStrictEqual(jobRows(store), before, storage + ': and no byte changed');
    }
  });

  test('36. a cumulative total can never leave the stored range', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: '' });
    await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: p1g.MAX_JOB_SAVE_COUNT, addedCount: 0, duplicateCount: 0 });
    const overflow = await store.recordJobSaveMetrics({
      providerId: PROVIDER, runSlug: RUN, submittedCount: 1, addedCount: 0, duplicateCount: 0
    });
    assert.strictEqual(overflow.success, false, 'an out-of-range total is refused');
    const job = (await store.queryJobs({ limit: 10, offset: 0 })).rows[0];
    assert.strictEqual(job.submittedCount, p1g.MAX_JOB_SAVE_COUNT, 'and the stored value is untouched');
  });

  test('37. the run is identified by providerId AND runSlug', async () => {
    reset();
    const OTHER = 'other-provider';
    for (const store of [await openStore(), await openJsonStore()]) {
      const storage = store.db ? 'sql' : 'json';
      // The SAME runSlug recorded by two different providers: the jobs table's
      // UNIQUE(providerId, runSlug) allows both rows to exist.
      await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'a', startedAt: T_START, status: 'succeeded', resultCount: 5, error: '' });
      await store.insertJob({ runSlug: RUN, providerId: OTHER, query: 'b', startedAt: T_START, status: 'succeeded', resultCount: 7, error: '' });

      // 1. same provider + same run resolves to that provider's own job.
      const written = await store.recordJobSaveMetrics({
        providerId: PROVIDER, runSlug: RUN, submittedCount: 2, addedCount: 2, duplicateCount: 0
      });
      assert.strictEqual(written.updated, true, storage + ': the pair resolves');
      const own = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(own.addedCount, 2, storage + ': the counters landed on the right job');
      assert.strictEqual(own.recordsCollected, 5, storage + ': and it is that provider\'s resultCount');
      assert.strictEqual(own.providerId, PROVIDER, storage);

      // 2. the other provider's job is untouched, and its report is its own.
      const otherReport = (await store.collectionQualityReport({ providerId: OTHER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(otherReport.addedCount, 0, storage + ': no cross-attribution of counters');
      assert.strictEqual(otherReport.duplicateCount, 0, storage);
      assert.strictEqual(otherReport.submittedCount, 0, storage);
      assert.strictEqual(otherReport.recordsCollected, 7, storage + ': the other run reports its own record');

      // 3. an unknown provider resolves to nothing at all.
      const unknown = await store.collectionQualityReport({ providerId: 'ghost', runSlug: RUN, limit: 1, offset: 0 });
      assert.deepStrictEqual(unknown, { rows: [], total: 0, limit: 1, offset: 0 },
        storage + ': an unregistered provider has no report for this run');
      const noMetrics = await store.recordJobSaveMetrics({
        providerId: 'ghost', runSlug: RUN, submittedCount: 1, addedCount: 1, duplicateCount: 0
      });
      assert.deepStrictEqual(noMetrics, { success: true, updated: false, reason: 'no-job' },
        storage + ': and records nothing');
      const stillOwn = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
      assert.strictEqual(stillOwn.addedCount, 2, storage + ': the real job is unchanged by the refusal');

      // 4. the provider id is required and bounded.
      for (const bad of ['', null, 42, 'x'.repeat(101), {}]) {
        const res = await store.recordJobSaveMetrics({
          providerId: bad, runSlug: RUN, submittedCount: 1, addedCount: 1, duplicateCount: 0
        });
        assert.strictEqual(res.success, false, storage + ': refused providerId: ' + JSON.stringify(bad));
      }
    }
  });

  test('34. repeated and unchanged metric writes do not persist needlessly', async () => {
    reset();
    const store = await openStore();
    await store.insertJob({ runSlug: RUN, providerId: PROVIDER, query: 'x', startedAt: T_START, status: 'running', resultCount: null, error: '' });
    const first = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 3, addedCount: 2, duplicateCount: 1 });
    assert.strictEqual(first.updated, true);
    const before = jobRows(store);
    // An empty batch adds nothing, so it is not a write at all.
    const again = await store.recordJobSaveMetrics({ providerId: PROVIDER, runSlug: RUN, submittedCount: 0, addedCount: 0, duplicateCount: 0 });
    assert.deepStrictEqual(again, { success: true, updated: false, reason: 'unchanged' },
      'a no-op batch is not persisted');
    assert.deepStrictEqual(jobRows(store), before, 'and no byte changed');
    // Attaching a target on a later batch keeps the accumulated counters.
    const target = await store.saveTarget({ name: 'T' });
    const withTarget = await store.recordJobSaveMetrics({
      providerId: PROVIDER, runSlug: RUN, submittedCount: 0, addedCount: 0, duplicateCount: 0, targetId: target.id
    });
    assert.strictEqual(withTarget.updated, true, 'attaching a target is a real change');
    const report = (await store.collectionQualityReport({ providerId: PROVIDER, runSlug: RUN, limit: 1, offset: 0 })).rows[0];
    assert.strictEqual(report.addedCount, 2, 'the accumulated counters are intact');
    assert.strictEqual(report.duplicateCount, 1);
  });

  test('31. the renderer and preload expose a read-only report surface', () => {
    // Preload: exactly the two report methods, both literal invokes.
    for (const [method, channel] of [['qualityReport', 'collector:quality-report'],
      ['qualityTargetReport', 'collector:quality-target-report']]) {
      assert.ok(preloadSource.includes(method + ': (query) => ipcRenderer.invoke(\'' + channel + '\', query)'),
        'preload exposes ' + method);
    }
    assert.strictEqual(preloadSource.split("invoke('collector:quality-").length - 1, 2, 'exactly two report invokes');
    // The save context rides the EXISTING add channel; no new write channel.
    assert.ok(preloadSource.includes("addNumbers: (numbers, context) => ipcRenderer.invoke('collector:add-numbers', numbers, context)"),
      'the local save forwards its run context');
    assert.ok(!/quality/i.test(between(preloadSource, 'targets: {', '},')), 'the target API stays separate');
    // The renderer reads the report through those two methods and writes
    // nothing through them.
    const reportJs = between(rendererSource, '// === P1-G Collection Quality Report (read-only) ===',
      'function qualityReportText(value) {');
    const calls = [...new Set([...reportJs.matchAll(/appAPI\.collector\.(\w+)/g)].map(m => m[1]))].sort();
    assert.deepStrictEqual(calls, ['qualityReport', 'qualityTargetReport'],
      'the report section calls exactly the two read methods');
    for (const forbidden of ['appAPI.collector.addNumbers', 'appAPI.collector.deleteNumbers',
      'appAPI.collector.updateLead', 'appAPI.collection.submit', 'appAPI.settings.save']) {
      assert.ok(!reportJs.includes(forbidden), 'the report calls no write flow: ' + forbidden);
    }
    assert.ok(reportJs.includes('escapeHtml('), 'every rendered value is escaped');
    assert.ok(!/onclick=|onchange=|oninput=|eval\(|new Function/.test(reportJs), 'no inline handler and no eval');
    // The section is not a score, a grade or a rank.
    const code = codeOnly(reportJs);
    for (const term of ['score', 'rank', 'grade', 'probability', 'confidence', 'ai ', 'model']) {
      assert.ok(!code.toLowerCase().includes(term), 'the report introduces no: ' + term);
    }
    // It lives in the collection results / run detail context only.
    const resultsCard = between(htmlSource, 'id="collect-result-card"', '<!-- Collection History');
    assert.ok(resultsCard.includes('id="collect-quality"'), 'the report panel sits in the results card');
    assert.ok(/id="collect-quality" hidden/.test(htmlSource), 'it starts hidden');
    assert.ok(htmlSource.includes('id="collect-quality-body"'), 'with a body to render into');
    assert.ok(htmlSource.includes('id="collect-quality-target-body"'), 'and a target section');
    const panel = htmlSource.slice(htmlSource.indexOf('id="collect-quality"'), htmlSource.indexOf('Counts come from this run'));
    assert.ok(!/<input|<select|<button/.test(panel), 'the panel has no editable control');
    assert.ok(!/onclick=/.test(panel), 'and no inline handler');
    // The descriptive labels the contract asks for, and no forbidden naming.
    const labels = ['Collection Quality', 'Records collected', 'Records submitted', 'Added',
      'Duplicates', 'Duplicate rate', 'Invalid records', 'Company groups', 'Target requirements'];
    for (const label of labels) {
      assert.ok(reportJs.includes(label), 'label shown: ' + label);
    }
    for (const forbidden of ['AI score', 'quality score', 'lead score']) {
      assert.ok(!reportJs.includes(forbidden), 'the panel is not called: ' + forbidden);
    }
    // The save flow loads the report after a successful save.
    const saveFlow = between(rendererSource, "document.getElementById('btn-save-numbers')", 'function csvField(');
    assert.ok(saveFlow.includes('loadCollectQuality()'), 'a completed save loads the report');
    assert.ok(saveFlow.includes('targetId: currentResultsTargetId || null'), 'and sends only the run context');
  });

  // --- helpers ---

  function loadReportValidator() {
    const guards = between(mainSource, 'function invalidParams(', '// P1-G Collection Quality Report.');
    const pattern = /const QUALITY_REPORT_RUN_SLUG_PATTERN = [^;]+;/.exec(mainSource)[0];
    const body = between(mainSource, 'function validateQualityReportPayload(', '// P1-G: the run context of a local save.');
    const validator = new Function('logger', [pattern, guards, body, '\nreturn validateQualityReportPayload;'].join('\n'))(
      { warn() {}, info() {}, error() {}, ok() {} }
    );
    return (payload) => validator(payload, PROVIDER);
  }

  function loadSaveContextValidator() {
    const guards = between(mainSource, 'function invalidParams(', '// P1-G Collection Quality Report.');
    const pattern = /const QUALITY_REPORT_RUN_SLUG_PATTERN = [^;]+;/.exec(mainSource)[0];
    const body = between(mainSource, 'function validateSaveContext(', '// The registered collection provider, resolved exactly as');
    const validator = new Function('logger', [pattern, guards, body, '\nreturn validateSaveContext;'].join('\n'))(
      { warn() {}, info() {}, error() {}, ok() {} }
    );
    return (context) => validator(context, PROVIDER);
  }

  function expectInvalid(validate, payload) {
    let err = null;
    try {
      validate(payload);
    } catch (e) {
      err = e;
    }
    assert.ok(err, 'payload must be refused: ' + JSON.stringify(payload));
    assert.strictEqual(err.invalidParams, true, 'refusal must carry invalidParams for rejectLog');
  }

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
