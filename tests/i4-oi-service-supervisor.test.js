'use strict';

// I4 - Opportunity Intelligence service supervisor.
//
// Executes the real OpportunityServiceSupervisor, the real OI gateway, the real
// oiProviderConfig (sealed keys) and the real oi-service IPC handlers. Only the OS
// edges are doubles: spawn (a fake child), fetch (a fake OI on loopback), the clock
// (virtual, so the 1-30 s backoff and the 10-minute circuit run in milliseconds),
// the folder check's file system, and the clipboard / folder dialog.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert');
const { EventEmitter } = require('events');

const root = path.join(__dirname, '..');
const OP = path.join(root, 'src', 'main', 'lead-intelligence', 'opportunity');
const vault = require(path.join(root, 'src', 'main', 'credentialVault.js'));
const sup = require(path.join(OP, 'OpportunityServiceSupervisor'));
const { OpportunityServiceSupervisor, validateOiFolder, findFreePort, BACKOFF_MS } = sup;
const { OpportunityIntelligenceGateway } = require(path.join(OP, 'OpportunityIntelligenceGateway'));
const { createOiProviderConfig } = require(path.join(OP, 'oiProviderConfig'));
const { OI_SERVICE_CHANNELS, registerOiServiceIpc } = require(path.join(OP, 'oi-service-ipc'));
const mainSource = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

let passed = 0;
const failures = [];
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

// --- virtual clock ------------------------------------------------------------
function virtualClock() {
  let now = 1_800_000_000_000;
  let seq = 0;
  const due = new Map();
  const flush = async () => { for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r)); };
  return {
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => { const id = ++seq; due.set(id, { at: now + Math.max(0, ms || 0), fn }); return id; },
      clearTimeout: (id) => { due.delete(id); },
    },
    flush,
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (;;) {
        let next = null;
        for (const [id, t] of due) if (t.at <= target && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        due.delete(next[0]);
        now = next[1].at;
        next[1].fn();
        await flush();
      }
      now = target;
      await flush();
    },
  };
}

// --- fake child + fake OI ------------------------------------------------------
function makeSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4000 + calls.length;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.ignoreKill = false;
    child.kill = () => {
      child.killed = true;
      if (!child.ignoreKill) setImmediate(() => child.emit('exit', null));
      return true;
    };
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawnImpl, calls, last: () => calls.at(-1) };
}

function resp(status, body) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

/** A fake OI that answers health with the instance id from the LAST spawned child's env. */
function makeOi(spawn, opts = {}) {
  const log = [];
  const state = { up: true, stranger: false, engineConfig: { search: 'brave', llm: { configured: false }, meta_ad_library: { configured: false }, x_api: false, google_ads_transparency_via_serpapi: false } };
  const fetchImpl = async (url, init = {}) => {
    log.push({ url, method: init.method || 'GET', headers: { ...(init.headers || {}) } });
    const c = spawn.last();
    const alive = c && !c.child.killed && state.up;
    if (url.endsWith('/v1/health')) {
      if (state.stranger) return resp(200, { status: 'ok', schema_version: '1.0', instance_id: 'someone-else' });
      if (!alive) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return resp(200, { status: 'ok', schema_version: '1.0', instance_id: c.options.env.ZTECH_OI_INSTANCE_ID });
    }
    if (!alive) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const auth = (init.headers || {}).authorization;
    if (opts.requireToken && auth !== `Bearer ${c.options.env.ZTECH_OI_AUTH_TOKEN}`) return resp(401, { error: 'UNAUTHORIZED' });
    if (url.endsWith('/v1/engine')) return resp(200, { engine: 'ztech-opportunity-intelligence', schema_version: '1.0', providers: ['website'], configuration: state.engineConfig });
    return resp(404, { error: 'NOT_FOUND' });
  };
  return { fetchImpl, log, state };
}

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  const walk = (p, create) => {
    const parts = p.split('.');
    let o = data;
    for (const k of parts.slice(0, -1)) {
      if (o[k] === undefined || typeof o[k] !== 'object') { if (!create) return [null, null]; o[k] = {}; }
      o = o[k];
    }
    return [o, parts.at(-1)];
  };
  return {
    data,
    get(p) { const [o, k] = walk(p, false); return o ? o[k] : undefined; },
    set(p, v) { const [o, k] = walk(p, true); o[k] = JSON.parse(JSON.stringify(v)); },
    delete(p) { const [o, k] = walk(p, false); if (o) delete o[k]; },
  };
}

const FOLDER = process.platform === 'win32' ? 'G:\\ZTech-Services\\opportunity-intelligence' : '/srv/ZTech-Services/opportunity-intelligence';
function fakeFs({ venv = true, name = 'ztech-opportunity-intelligence', script = true } = {}) {
  return {
    existsSync: (p) => {
      if (p.endsWith(path.join('scripts', 'run_local_service.py'))) return script;
      if (p.endsWith('pyproject.toml')) return true;
      if (p.includes('.venv')) return venv;
      return false;
    },
    readFileSync: () => `[project]\nname = "${name}"\nversion = "1.0.0"\n`,
  };
}

const KEY = 'BSA-brave-SECRET-0123456789';
function safeStorage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString: (p) => Buffer.from('enc:' + p, 'utf8'),
    decryptString: (b) => b.toString('utf8').slice(4),
  };
}

const BASE_ENV = {
  PATH: '/usr/bin', SystemRoot: 'C:\\Windows', TEMP: '/tmp', TMP: '/tmp', USERPROFILE: '/home/u', LOCALAPPDATA: '/home/u/l', APPDATA: '/home/u/a', HOME: '/home/u',
  RESEND_API_KEY: 're_live_secret', ZUNI_SEO_API_KEY: 'zsk_secret', WHATSAPP_TOKEN: 'EAAGsecret', AWS_SECRET_ACCESS_KEY: 'aws', ELECTRON_RUN_AS_NODE: '1',
};

function harness({ store = makeStore({ settings: { oi: { folder: FOLDER } } }), fsOpts = {}, ignoreKill = false, options = {}, port = 8099, requireToken = false, withKey = true } = {}) {
  const ss = safeStorage();
  vault.setSafeStorageForTests(ss);
  const providerConfig = createOiProviderConfig({ store, safeStorage: ss, logger: { warn() {} } });
  if (withKey) providerConfig.setKey('brave', KEY);
  const clock = virtualClock();
  const spawn = makeSpawn();
  const origSpawn = spawn.spawnImpl;
  spawn.spawnImpl = (...a) => { const c = origSpawn(...a); c.ignoreKill = ignoreKill; return c; };
  const oi = makeOi(spawn, { requireToken });
  const gateway = new OpportunityIntelligenceGateway({ config: { baseUrl: 'http://127.0.0.1:8099' }, fetchImpl: oi.fetchImpl, logger: { warn() {} } });
  const killed = [];
  const logs = [];
  const supervisor = new OpportunityServiceSupervisor({
    gateway, providerConfig, store,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    spawnImpl: spawn.spawnImpl, fetchImpl: oi.fetchImpl,
    findPort: async () => port,
    killTreeImpl: (pid) => killed.push(pid),
    timers: clock.timers, now: clock.now,
    platform: 'win32', baseEnv: BASE_ENV, fsImpl: fakeFs(fsOpts),
    options,
  });
  return { supervisor, gateway, providerConfig, store, clock, spawn, oi, killed, logs };
}

function scan(value, needles) {
  const text = JSON.stringify(value);
  for (const n of needles) if (n) assert.ok(!text.includes(n), 'leaked: ' + String(n).slice(0, 12));
}

// --- tests --------------------------------------------------------------------

test('1. managed: spawns the venv python with an args array, no shell, hidden, in the validated folder', async () => {
  const h = harness();
  await h.supervisor.apply();
  assert.strictEqual(h.spawn.calls.length, 1);
  const { command, args, options } = h.spawn.last();
  assert.strictEqual(command, path.join(FOLDER, '.venv', 'Scripts', 'python.exe'));
  assert.deepStrictEqual(args, [path.join('scripts', 'run_local_service.py'), '--port', '8099']);
  assert.strictEqual(options.shell, false);
  assert.strictEqual(options.windowsHide, true);
  assert.strictEqual(options.cwd, FOLDER);
  assert.strictEqual(h.supervisor.state, 'running');
});

test('2. the child env is an allowlist + stored keys + two per-launch secrets, never the rest of process.env', async () => {
  const h = harness();
  h.providerConfig.setSetting('meta_countries', 'PK');
  await h.supervisor.apply();
  const env = h.spawn.last().options.env;
  for (const banned of ['RESEND_API_KEY', 'ZUNI_SEO_API_KEY', 'WHATSAPP_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'ELECTRON_RUN_AS_NODE']) {
    assert.ok(!(banned in env), 'must not pass ' + banned);
  }
  assert.strictEqual(env.BRAVE_API_KEY, KEY);
  assert.strictEqual(env.META_AD_COUNTRIES, 'PK');
  assert.ok(/^[a-f0-9]{64}$/.test(env.ZTECH_OI_AUTH_TOKEN), 'a 32-byte token');
  assert.ok(/^[a-f0-9]{32}$/.test(env.ZTECH_OI_INSTANCE_ID));
  assert.strictEqual(env.PYTHONUNBUFFERED, '1');
  const allowed = new Set([...sup.ENV_ALLOWLIST, 'PYTHONUTF8', 'PYTHONIOENCODING', 'PYTHONUNBUFFERED', 'BRAVE_API_KEY', 'META_AD_COUNTRIES', 'ZTECH_OI_AUTH_TOKEN', 'ZTECH_OI_INSTANCE_ID']);
  for (const k of Object.keys(env)) assert.ok(allowed.has(k), 'unexpected env var ' + k);
});

test('3. a fresh token and instance id per launch', async () => {
  const h = harness();
  await h.supervisor.apply();
  const first = h.spawn.last().options.env;
  await h.supervisor.userRestart();
  const second = h.spawn.last().options.env;
  assert.notStrictEqual(first.ZTECH_OI_AUTH_TOKEN, second.ZTECH_OI_AUTH_TOKEN);
  assert.notStrictEqual(first.ZTECH_OI_INSTANCE_ID, second.ZTECH_OI_INSTANCE_ID);
});

test('4. running: the gateway sends the bearer token on API calls, never on health, and engine config is read', async () => {
  const h = harness({ requireToken: true });
  await h.supervisor.apply();
  await h.clock.flush();
  const env = h.spawn.last().options.env;
  const engineCall = h.oi.log.find((c) => c.url.endsWith('/v1/engine'));
  assert.ok(engineCall, 'engine was asked');
  assert.strictEqual(engineCall.headers.authorization, `Bearer ${env.ZTECH_OI_AUTH_TOKEN}`);
  for (const c of h.oi.log.filter((x) => x.url.endsWith('/v1/health'))) assert.ok(!('authorization' in c.headers));
  assert.deepStrictEqual(h.supervisor.healthView().providers_reported, h.oi.state.engineConfig);
  assert.strictEqual(h.gateway.authenticated, true);
});

test('5. healthView carries no port, path, URL, token or instance id', async () => {
  const h = harness();
  await h.supervisor.apply();
  const env = h.spawn.last().options.env;
  const v = h.supervisor.healthView();
  scan(v, [env.ZTECH_OI_AUTH_TOKEN, env.ZTECH_OI_INSTANCE_ID, FOLDER, '127.0.0.1', '8099', KEY]);
  assert.deepStrictEqual(Object.keys(v).sort(), ['folder_name', 'keys_apply', 'message', 'mode', 'providers_reported', 'restarts', 'since', 'state']);
  assert.strictEqual(v.folder_name, 'opportunity-intelligence');
});

test('6. a healthy stranger on the port (wrong instance id) -> port_conflict, our child killed, never used', async () => {
  const h = harness();
  h.oi.state.stranger = true;
  await h.supervisor.apply();
  await h.clock.flush();
  assert.strictEqual(h.supervisor.state, 'port_conflict');
  assert.strictEqual(h.spawn.last().child.killed, true);
  assert.strictEqual(h.gateway.authenticated, false, 'the token was never attached for the stranger');
  assert.ok(!h.oi.log.some((c) => c.url.endsWith('/v1/engine')), 'no API call reached the stranger');
  const r = await h.gateway.describeEngine();
  assert.strictEqual(r.ok, false, 'the gateway is gated shut');
});

test('7. exits restart with backoff 1/2/4/8/16 s; the 6th failure inside 10 min opens the circuit', async () => {
  const h = harness();
  await h.supervisor.apply();
  assert.strictEqual(h.supervisor.state, 'running');
  const crashOnce = async () => { h.spawn.last().child.emit('exit', 1); await h.clock.flush(); };
  const delays = [];
  for (let i = 0; i < 5; i += 1) {
    await crashOnce();
    assert.strictEqual(h.supervisor.state, 'restarting', 'restart ' + (i + 1));
    const spawnsBefore = h.spawn.calls.length;
    await h.clock.advance(BACKOFF_MS[i] - 1);
    assert.strictEqual(h.spawn.calls.length, spawnsBefore, 'not before the backoff');
    await h.clock.advance(1);
    assert.strictEqual(h.spawn.calls.length, spawnsBefore + 1, 'exactly at the backoff');
    delays.push(BACKOFF_MS[i]);
    assert.strictEqual(h.supervisor.state, 'running');
  }
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  await crashOnce();
  assert.strictEqual(h.supervisor.state, 'crashed');
  const spawns = h.spawn.calls.length;
  await h.clock.advance(60 * 60 * 1000);
  assert.strictEqual(h.spawn.calls.length, spawns, 'no auto-restart once the circuit is open');
  const r = await h.gateway.describeEngine();
  assert.match(r.error, /stopped repeatedly/);
  await h.supervisor.userRestart();
  assert.strictEqual(h.supervisor.state, 'running', 'Restart closes the circuit');
});

test('8. failures older than 10 minutes do not count toward the circuit', async () => {
  const h = harness();
  await h.supervisor.apply();
  for (let i = 0; i < 5; i += 1) {
    h.spawn.last().child.emit('exit', 1);
    await h.clock.flush();
    await h.clock.advance(BACKOFF_MS[i]);
  }
  await h.clock.advance(11 * 60 * 1000);
  h.spawn.last().child.emit('exit', 1);
  await h.clock.flush();
  assert.strictEqual(h.supervisor.state, 'restarting');
});

test('9. three failed health checks in a row (every 15 s) restart the service', async () => {
  const h = harness();
  await h.supervisor.apply();
  const firstChild = h.spawn.last().child;
  h.oi.state.up = false;
  await h.clock.advance(15000);
  await h.clock.advance(15000);
  assert.strictEqual(h.supervisor.state, 'running', 'two misses are tolerated');
  await h.clock.advance(15000);
  assert.strictEqual(firstChild.killed, true);
  assert.strictEqual(h.supervisor.state, 'restarting');
  h.oi.state.up = true;
  await h.clock.advance(BACKOFF_MS[0]);
  assert.strictEqual(h.supervisor.state, 'running');
});

test('10. not ready within 20 s -> the child is stopped and a restart is scheduled', async () => {
  const h = harness();
  h.oi.state.up = false;
  const p = h.supervisor.apply();
  await h.clock.advance(20000);
  await p;
  assert.strictEqual(h.spawn.calls[0].child.killed, true);
  assert.strictEqual(h.supervisor.state, 'restarting');
  assert.match(h.supervisor.message, /did not become ready/);
});

test('11. invalid folders are refused with a plain reason; nothing is spawned', async () => {
  for (const [fsOpts, re] of [[{ venv: false }, /Python environment not found/], [{ name: 'something-else' }, /different project/], [{ script: false }, /not the Opportunity Intelligence folder/]]) {
    const h = harness({ fsOpts });
    await h.supervisor.apply();
    assert.strictEqual(h.spawn.calls.length, 0);
    assert.strictEqual(h.supervisor.state, 'misconfigured');
    assert.match(h.supervisor.message, re);
    scan(h.supervisor.healthView().message, [FOLDER]);
  }
  const none = harness({ store: makeStore() });
  await none.supervisor.apply();
  assert.strictEqual(none.supervisor.state, 'not_set_up');
  assert.strictEqual(none.spawn.calls.length, 0);
  const r = await none.gateway.describeEngine();
  assert.match(r.error, /not set up/);
});

test('12. external mode: never spawns, never injects keys, never sends the managed token', async () => {
  const h = harness({ store: makeStore({ settings: { oi: { folder: FOLDER, mode: 'external' } } }) });
  await h.supervisor.apply();
  await h.clock.flush();
  assert.strictEqual(h.spawn.calls.length, 0);
  assert.strictEqual(h.supervisor.state, 'external');
  assert.strictEqual(h.gateway.authenticated, false);
  assert.strictEqual(h.supervisor.healthView().keys_apply, false);
  // a call from the gateway goes to the configured loopback address with no Authorization
  await h.gateway.describeEngine();
  for (const c of h.oi.log) {
    assert.ok(!('authorization' in c.headers), 'external never gets a token');
    assert.ok(c.url.startsWith('http://127.0.0.1:8099/'));
  }
  // switching from managed to external drops the token and the child
  const m = harness();
  await m.supervisor.apply();
  assert.strictEqual(m.gateway.authenticated, true);
  await m.supervisor.setMode('external');
  assert.strictEqual(m.gateway.authenticated, false);
  assert.strictEqual(m.spawn.last().child.killed, true);
});

test('13. off mode closes the gate with the reason; Stop/Start/Restart behave', async () => {
  const h = harness();
  await h.supervisor.setMode('off');
  assert.strictEqual(h.supervisor.state, 'off');
  assert.match((await h.gateway.describeEngine()).error, /turned off/);
  await h.supervisor.setMode('managed');
  assert.strictEqual(h.supervisor.state, 'running');
  await h.supervisor.userStop();
  assert.strictEqual(h.supervisor.state, 'stopped');
  assert.strictEqual(h.spawn.last().child.killed, true);
  await h.clock.advance(5 * 60 * 1000);
  assert.strictEqual(h.supervisor.state, 'stopped', 'a user stop is not auto-restarted');
  await h.supervisor.userStart();
  assert.strictEqual(h.supervisor.state, 'running');
});

test('14. log output is redacted (stored key, token, instance id) in the buffer and the logger', async () => {
  const h = harness();
  await h.supervisor.apply();
  const env = h.spawn.last().options.env;
  const c = h.spawn.last().child;
  c.stdout.emit('data', `using key ${KEY} token=${env.ZTECH_OI_AUTH_TOKEN}\npartial `);
  c.stderr.emit('data', `instance ${env.ZTECH_OI_INSTANCE_ID}\n`);
  c.stdout.emit('data', 'line\n');
  const text = h.supervisor.logText();
  scan(text, [KEY, env.ZTECH_OI_AUTH_TOKEN, env.ZTECH_OI_INSTANCE_ID]);
  scan(h.logs, [KEY, env.ZTECH_OI_AUTH_TOKEN, env.ZTECH_OI_INSTANCE_ID]);
  assert.ok(text.includes('[redacted]'));
  assert.ok(text.includes('partial line'), 'lines split across chunks are joined');
});

test('15. a key change restarts exactly once after the debounce, and waits for research in flight', async () => {
  const h = harness();
  await h.supervisor.apply();
  const spawns = h.spawn.calls.length;
  h.providerConfig.setKey('serper', KEY + 'S');
  h.providerConfig.setSetting('llm_model', 'gpt-4o-mini');
  h.gateway.inflightResearch = 1;
  await h.clock.advance(1500);
  assert.strictEqual(h.spawn.calls.length, spawns, 'not under research in flight');
  await h.clock.advance(5000);
  assert.strictEqual(h.spawn.calls.length, spawns);
  h.gateway.inflightResearch = 0;
  await h.clock.advance(1000);
  assert.strictEqual(h.spawn.calls.length, spawns + 1, 'one restart for two changes');
  assert.strictEqual(h.spawn.last().options.env.SERPER_API_KEY, KEY + 'S', 'the new key reached the child');
  const ext = harness({ store: makeStore({ settings: { oi: { folder: FOLDER, mode: 'external' } } }) });
  await ext.supervisor.apply();
  ext.providerConfig.setKey('meta', KEY + 'M');
  await ext.clock.advance(10000);
  assert.strictEqual(ext.spawn.calls.length, 0, 'external mode never launches on a key change');
});

test('16. shutdown is graceful, then forces the tree when the child ignores the signal', async () => {
  const h = harness();
  await h.supervisor.apply();
  const pidGood = h.spawn.last().child.pid;
  await h.supervisor.shutdown();
  assert.ok(!h.killed.includes(pidGood), 'a child that exits on kill is not force-killed');
  const s = harness({ ignoreKill: true });
  await s.supervisor.apply();
  const pid = s.spawn.last().child.pid;
  const done = s.supervisor.shutdown();
  await s.clock.advance(3000);
  await done;
  assert.deepStrictEqual(s.killed, [pid], 'taskkill /T /F after 3 s');
  await s.clock.advance(60000);
  assert.strictEqual(s.spawn.calls.length, 1, 'no restart after shutdown');
});

test('17. the service IPC: trusted only, closed payloads, no path/port/token in any answer', async () => {
  const h = harness();
  const handlers = {};
  let copied = null;
  registerOiServiceIpc({
    ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
    supervisor: h.supervisor,
    isTrustedSender: (e) => !(e && e.untrusted),
    pickFolder: async () => FOLDER,
    copyText: (t) => { copied = t; },
    logger: { warn() {} },
  });
  for (const ch of Object.values(OI_SERVICE_CHANNELS)) {
    const r = await handlers[ch]({ untrusted: true }, {});
    assert.strictEqual(r.ok, false, ch);
  }
  const bad = await handlers[OI_SERVICE_CHANNELS.CHOOSE_FOLDER]({}, { path: '/etc' });
  assert.strictEqual(bad.ok, false, 'the renderer cannot send a path');
  assert.strictEqual((await handlers[OI_SERVICE_CHANNELS.SET_MODE]({}, { mode: 'remote' })).ok, false);
  const chosen = await handlers[OI_SERVICE_CHANNELS.CHOOSE_FOLDER]({}, {});
  assert.strictEqual(chosen.ok, true);
  assert.strictEqual(chosen.data.folderName, 'opportunity-intelligence');
  const env = h.spawn.last().options.env;
  h.spawn.last().child.stdout.emit('data', 'hello\n');
  const answers = [chosen];
  for (const ch of [OI_SERVICE_CHANNELS.RESTART, OI_SERVICE_CHANNELS.STOP, OI_SERVICE_CHANNELS.START, OI_SERVICE_CHANNELS.COPY_LOG]) {
    answers.push(await handlers[ch]({}, {}));
  }
  answers.push(await handlers[OI_SERVICE_CHANNELS.SET_MODE]({}, { mode: 'off' }));
  for (const a of answers) {
    assert.strictEqual(a.ok, true);
    scan(a, [FOLDER, '127.0.0.1', '8099', env.ZTECH_OI_AUTH_TOKEN, env.ZTECH_OI_INSTANCE_ID, KEY, '.venv', 'python']);
  }
  assert.ok(typeof copied === 'string' && copied.includes('hello'), 'the log went to the clipboard, not over IPC');
});

test('18. validateOiFolder against a real directory; findFreePort falls back when the port is taken', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oi-folder-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.writeFileSync(path.join(dir, 'scripts', 'run_local_service.py'), '');
  fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[project]\nname = "ztech-opportunity-intelligence"\n');
  assert.strictEqual(validateOiFolder(dir).ok, false, 'no venv yet');
  const py = process.platform === 'win32' ? path.join(dir, '.venv', 'Scripts', 'python.exe') : path.join(dir, '.venv', 'bin', 'python');
  fs.mkdirSync(path.dirname(py), { recursive: true });
  fs.writeFileSync(py, '');
  assert.deepStrictEqual(validateOiFolder(dir), { ok: true, reason: null });
  assert.strictEqual(validateOiFolder('relative/path').ok, false);
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen({ port: 0, host: '127.0.0.1' }, r));
  const taken = blocker.address().port;
  const got = await findFreePort(taken);
  assert.ok(Number.isInteger(got) && got > 0 && got !== taken, 'a different free port');
  blocker.close();
});

test('19. main.js: supervisor started after the config channels, not awaited, stopped on quit', () => {
  const ready = mainSource.slice(mainSource.indexOf('app.whenReady().then('), mainSource.indexOf("app.on('will-quit'"));
  const iCfg = ready.indexOf('registerOiConfigIpcHandlers();');
  const iSup = ready.indexOf('startOiSupervisor();');
  assert.ok(iCfg > 0 && iSup > iCfg, 'started after the config channels');
  assert.ok(ready.indexOf('createMainWindow();') < iSup, 'the window is created first');
  assert.ok(!/await\s+startOiSupervisor\(/.test(mainSource), 'never awaited');
  const fn = mainSource.slice(mainSource.indexOf('function startOiSupervisor('), mainSource.indexOf('function registerOpportunityIntelIpcHandlers('));
  assert.ok(fn.includes('oiSupervisor.start();') && !/await oiSupervisor\.start/.test(fn));
  assert.ok(fn.includes("properties: ['openDirectory']"), 'the folder comes from a native dialog in main');
  assert.ok(fn.includes('gateway: oi ? oi.gateway : null'), 'the existing gateway is reconfigured, not rebuilt');
  const quit = mainSource.slice(mainSource.indexOf("app.on('will-quit'"), mainSource.indexOf("app.on('before-quit'"));
  assert.ok(quit.includes('oiSupervisor.shutdown()') && quit.includes('killSync()') && quit.includes('app.quit()'));
  assert.ok(mainSource.includes("process.on('exit'") && /oiSupervisor\.killSync\(\)/.test(mainSource));
});

(async () => {
  for (const { name, fn } of queue) {
    try {
      await fn();
      passed += 1;
      console.log('ok - ' + name);
    } catch (err) {
      failures.push({ name, err });
      console.log('FAIL - ' + name + ': ' + err.message);
    }
  }
  vault.setSafeStorageForTests(undefined);
  for (const f of failures) console.error(f.err && f.err.stack);
  console.log(`${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
