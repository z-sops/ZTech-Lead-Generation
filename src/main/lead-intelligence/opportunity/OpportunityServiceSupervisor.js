'use strict';

/**
 * I4 - Opportunity Intelligence service supervisor (main process only).
 *
 * Owns ONE child process, its port, its per-launch token and instance id, and its
 * state. Nothing else in ZTech spawns OI.
 *
 * MODES (electron-store settings.oi.mode)
 *   managed   ZTech launches OI from the chosen folder, injects the stored provider
 *             keys into THAT child only, generates ZTECH_OI_AUTH_TOKEN, and the
 *             gateway sends the token from memory.
 *   external  ZTech never launches anything, never injects stored keys, never sends
 *             its token. It talks to whatever the developer started on the configured
 *             loopback address (usually 127.0.0.1:8099, no token).
 *   off       No OI. Every OI call answers "unavailable" with the reason.
 *
 * GUARANTEES
 *   - Never throws into Electron and never blocks startup: start() is fire-and-forget.
 *   - spawn() gets an args array, shell:false, a validated cwd and an ALLOWLISTED env.
 *     ZTech's own process.env (Resend, WhatsApp, Zuni-SEO secrets) never reaches OI.
 *   - A health answer whose instance_id is not the one ZTech generated is a stranger:
 *     ZTech kills its own child and never talks to that process (port_conflict).
 *   - healthView() carries no port, path, URL, token or instance id.
 *   - Child output is redacted (stored keys, token, instance id) before it is logged or
 *     kept in the 300-line buffer.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const childProcess = require('child_process');

const MODES = Object.freeze(['managed', 'external', 'off']);
const STATES = Object.freeze(['off', 'not_set_up', 'misconfigured', 'starting', 'running', 'restarting',
  'crashed', 'stopped', 'port_conflict', 'external']);
const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]);
const DEFAULTS = Object.freeze({
  preferredPort: 8099,
  readyPollMs: 500,
  readyTimeoutMs: 20000,
  healthIntervalMs: 15000,
  healthFailuresBeforeRestart: 3,
  healthRequestTimeoutMs: 3000,
  circuitWindowMs: 10 * 60 * 1000,
  circuitMaxRestarts: 5,
  configDebounceMs: 1500,
  inflightWaitMs: 90000,
  gracefulStopMs: 3000,
  logLines: 300,
});
const STORE_MODE = 'settings.oi.mode';
const STORE_FOLDER = 'settings.oi.folder';
const ENV_ALLOWLIST = Object.freeze(['SystemRoot', 'SYSTEMROOT', 'windir', 'PATH', 'Path', 'TEMP', 'TMP', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'HOME', 'LANG']);
const PACKAGE_NAME = 'ztech-opportunity-intelligence';

const MESSAGES = Object.freeze({
  off: 'Opportunity Intelligence is turned off in Settings.',
  not_set_up: 'Opportunity Intelligence is not set up. Choose the OI folder in Settings.',
  misconfigured: 'The OI folder is not usable. Choose it again in Settings.',
  starting: 'Opportunity Intelligence is starting.',
  running: 'Opportunity Intelligence is running.',
  restarting: 'Opportunity Intelligence stopped unexpectedly and is restarting.',
  crashed: 'Opportunity Intelligence stopped repeatedly. Press Restart in Settings to try again.',
  stopped: 'Opportunity Intelligence was stopped. Press Start in Settings.',
  port_conflict: 'Another program answered on the OI port. ZTech did not connect to it.',
  external: 'Using an Opportunity Intelligence service started outside ZTech (developer mode).',
});

/** Resolve the python interpreter of the folder's own venv. */
function venvPython(folder, platform) {
  return platform === 'win32'
    ? path.join(folder, '.venv', 'Scripts', 'python.exe')
    : path.join(folder, '.venv', 'bin', 'python');
}

/**
 * Validate a chosen OI folder. Returns { ok, reason } - the reason is plain text for
 * Settings and never contains the path.
 */
function validateOiFolder(folder, { platform = process.platform, fsImpl = fs } = {}) {
  if (typeof folder !== 'string' || !folder || !path.isAbsolute(folder)) return { ok: false, reason: 'No folder was chosen.' };
  const script = path.join(folder, 'scripts', 'run_local_service.py');
  const pyproject = path.join(folder, 'pyproject.toml');
  try {
    if (!fsImpl.existsSync(script)) return { ok: false, reason: 'This is not the Opportunity Intelligence folder (scripts/run_local_service.py is missing).' };
    if (!fsImpl.existsSync(pyproject)) return { ok: false, reason: 'This is not the Opportunity Intelligence folder (pyproject.toml is missing).' };
    const text = fsImpl.readFileSync(pyproject, 'utf8');
    if (!new RegExp(`^\\s*name\\s*=\\s*"${PACKAGE_NAME}"`, 'm').test(text)) {
      return { ok: false, reason: 'This folder holds a different project, not Opportunity Intelligence.' };
    }
    if (!fsImpl.existsSync(venvPython(folder, platform))) {
      return { ok: false, reason: 'Python environment not found in this folder. Run the one-time setup (python -m venv .venv, then pip install -e ".[rest]").' };
    }
  } catch {
    return { ok: false, reason: 'The folder could not be read.' };
  }
  return { ok: true, reason: null };
}

/** The production launch command. One seam, so a bundled OI executable can replace it later. */
function resolveLaunchCommand(folder, port, { platform = process.platform } = {}) {
  return {
    command: venvPython(folder, platform),
    args: [path.join('scripts', 'run_local_service.py'), '--port', String(port)],
    cwd: folder,
  };
}

/** First free loopback port, preferring `preferred`. */
function findFreePort(preferred) {
  const tryListen = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(null));
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  return tryListen(preferred).then((p) => (p !== null ? p : tryListen(0)));
}

/** Force-kill a process tree. Windows needs taskkill /T: uvicorn may hold a child. */
function killTree(pid, { platform = process.platform, spawnSync = childProcess.spawnSync } = {}) {
  if (!pid) return;
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

class OpportunityServiceSupervisor {
  /**
   * @param {object} p
   * @param {object|null} p.gateway         the OI gateway (reconfigure / setGate / describeEngine)
   * @param {object} p.providerConfig       createOiProviderConfig(...) result
   * @param {object} p.store                electron-store (settings.oi.mode / settings.oi.folder)
   * Injectables for tests: spawnImpl, fetchImpl, findPort, killTreeImpl, timers, now,
   * randomBytes, platform, baseEnv, fsImpl, options.
   */
  constructor({
    gateway = null, providerConfig, store, logger = console,
    spawnImpl = childProcess.spawn, fetchImpl = globalThis.fetch, findPort = findFreePort,
    killTreeImpl = killTree, timers = { setTimeout, clearTimeout }, now = () => Date.now(),
    randomBytes = crypto.randomBytes, platform = process.platform, baseEnv = process.env, fsImpl = fs,
    options = {},
  } = {}) {
    if (!providerConfig || typeof providerConfig.childEnv !== 'function') throw new TypeError('providerConfig is required');
    if (!store || typeof store.get !== 'function') throw new TypeError('store is required');
    this.gateway = gateway;
    this.providerConfig = providerConfig;
    this.store = store;
    this.logger = logger;
    this.spawnImpl = spawnImpl;
    this.fetchImpl = fetchImpl;
    this.findPort = findPort;
    this.killTreeImpl = killTreeImpl;
    this.timers = timers;
    this.now = now;
    this.randomBytes = randomBytes;
    this.platform = platform;
    this.baseEnv = baseEnv || {};
    this.fsImpl = fsImpl;
    this.opts = { ...DEFAULTS, ...options };

    // Until start() runs, report what the settings say, never a misleading "off".
    const initial = !this.folder ? 'not_set_up' : (this.mode === 'off' ? 'off' : (this.mode === 'external' ? 'external' : 'starting'));
    this.state = initial;
    this.message = MESSAGES[initial];
    this.since = new Date(this.now()).toISOString();
    this.child = null;
    this.port = null;
    this.token = null;
    this.instanceId = null;
    this.restartTimes = [];
    this.healthFailures = 0;
    this.reported = null;
    this.logBuffer = [];
    this.generation = 0;
    this.healthTimer = null;
    this.retryTimer = null;
    this.debounceTimer = null;
    this.exitWaiters = [];
    this.disposed = false;

    if (this.gateway && typeof this.gateway.setGate === 'function') {
      this.gateway.setGate(() => (this.state === 'running' || this.state === 'external' ? null : this.message));
    }
    if (typeof providerConfig.onChange === 'function') providerConfig.onChange(() => this.onConfigChange());
  }

  // --- settings -------------------------------------------------------------

  get folder() {
    const f = this.store.get(STORE_FOLDER);
    return typeof f === 'string' && f ? f : null;
  }

  get mode() {
    const m = this.store.get(STORE_MODE);
    if (MODES.includes(m)) return m;
    return this.folder ? 'managed' : 'off';
  }

  // --- public surface -------------------------------------------------------

  /** Renderer-safe state. No port, path, URL, token or instance id. */
  healthView() {
    return {
      mode: this.mode,
      state: this.state,
      message: this.message,
      since: this.since,
      restarts: this.restartTimes.length,
      folder_name: this.folder ? path.basename(this.folder) : null,
      keys_apply: this.mode === 'managed',
      providers_reported: this.reported,
    };
  }

  /** OI's own `configuration` booleans from GET /v1/engine, or null. */
  reportedConfiguration() { return this.reported; }

  /** Fire-and-forget entry point. Never rejects. */
  start() {
    return this.apply().catch((e) => this.warn(`start failed: ${e && e.message}`));
  }

  async apply() {
    if (this.disposed) return;
    this.clearTimers();
    const mode = this.mode;
    if (mode === 'off') {
      await this.stopChild();
      this.useConfiguredDestination();
      return this.setState(this.folder ? 'off' : 'not_set_up', this.folder ? MESSAGES.off : MESSAGES.not_set_up);
    }
    if (mode === 'external') {
      await this.stopChild();
      // External: no token, no stored keys, the configured loopback destination.
      this.useConfiguredDestination();
      this.reported = null;
      this.setState('external', MESSAGES.external);
      this.refreshReported();
      return undefined;
    }
    const check = validateOiFolder(this.folder, { platform: this.platform, fsImpl: this.fsImpl });
    if (!check.ok) {
      await this.stopChild();
      return this.setState(this.folder ? 'misconfigured' : 'not_set_up', this.folder ? check.reason : MESSAGES.not_set_up);
    }
    return this.launch();
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw new TypeError('unknown mode');
    this.store.set(STORE_MODE, mode);
    this.restartTimes = [];
    await this.apply();
    return this.healthView();
  }

  /** Store a folder chosen in a native dialog by main. Returns { ok, folderName, reason }. */
  async setFolder(folder) {
    const check = validateOiFolder(folder, { platform: this.platform, fsImpl: this.fsImpl });
    if (!check.ok) return { ok: false, folderName: null, reason: check.reason };
    this.store.set(STORE_FOLDER, folder);
    if (this.store.get(STORE_MODE) !== 'external') this.store.set(STORE_MODE, 'managed');
    this.restartTimes = [];
    await this.apply();
    return { ok: true, folderName: path.basename(folder), reason: null };
  }

  /** User pressed Start: closes the circuit and launches (managed) or re-checks (external). */
  async userStart() {
    this.restartTimes = [];
    await this.apply();
    return this.healthView();
  }

  /** User pressed Restart: same as Start, after stopping the current child. */
  async userRestart() {
    this.restartTimes = [];
    await this.stopChild();
    await this.apply();
    return this.healthView();
  }

  /** User pressed Stop. The service stays down until Start or Restart. */
  async userStop() {
    this.clearTimers();
    await this.stopChild();
    if (this.mode === 'managed') this.setState('stopped', MESSAGES.stopped);
    return this.healthView();
  }

  /** Redacted log text for the clipboard. Never sent to the renderer as data. */
  logText() { return this.logBuffer.join('\n'); }

  /** A key or setting changed: in managed mode restart (debounced, never under research). */
  onConfigChange() {
    if (this.disposed || this.mode !== 'managed') return;
    if (this.debounceTimer) this.timers.clearTimeout(this.debounceTimer);
    this.debounceTimer = this.timers.setTimeout(() => {
      this.debounceTimer = null;
      this.restartAfterInflight().catch((e) => this.warn(`config restart failed: ${e && e.message}`));
    }, this.opts.configDebounceMs);
  }

  async restartAfterInflight() {
    const started = this.now();
    while (this.gateway && this.gateway.inflightResearch > 0 && this.now() - started < this.opts.inflightWaitMs) {
      await this.sleep(500);
    }
    if (this.disposed || this.mode !== 'managed') return;
    this.restartTimes = [];
    await this.stopChild();
    await this.apply();
  }

  /** Graceful stop, then force the tree. Used on app quit. */
  async shutdown() {
    this.disposed = true;
    this.clearTimers();
    await this.stopChild();
  }

  /** Last-resort synchronous kill (process 'exit'). */
  killSync() {
    const c = this.child;
    if (c && c.pid) this.killTreeImpl(c.pid, { platform: this.platform });
  }

  // --- launch / ready / supervise -------------------------------------------

  async launch() {
    const gen = ++this.generation;
    this.setState(this.state === 'restarting' ? 'restarting' : 'starting', this.state === 'restarting' ? MESSAGES.restarting : MESSAGES.starting);
    let port;
    try {
      port = await this.findPort(this.opts.preferredPort);
    } catch {
      port = null;
    }
    if (gen !== this.generation || this.disposed) return;
    if (!port) return this.onFailure('No free local port was available.');
    this.port = port;
    this.token = this.randomBytes(32).toString('hex');
    this.instanceId = this.randomBytes(16).toString('hex');
    const { command, args, cwd } = resolveLaunchCommand(this.folder, port, { platform: this.platform });
    let child;
    try {
      child = this.spawnImpl(command, args, {
        cwd,
        env: this.childEnv(),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return this.onFailure('Python could not be started from the OI folder.');
    }
    this.child = child;
    this.attachOutput(child);
    child.once('exit', (code) => this.onChildExit(child, code));
    child.once('error', () => this.onChildExit(child, null));
    const ok = await this.waitReady(gen, child);
    if (!ok || gen !== this.generation || this.disposed) return;
    this.healthFailures = 0;
    if (this.gateway) this.gateway.reconfigure({ port: this.port, authToken: this.token });
    this.setState('running', MESSAGES.running);
    this.refreshReported();
    this.scheduleHealth(gen);
  }

  /** Minimal, explicit child environment. Never the whole process.env. */
  childEnv() {
    const env = {};
    const keys = Object.keys(this.baseEnv);
    for (const name of ENV_ALLOWLIST) {
      const hit = keys.find((k) => k === name) || (this.platform === 'win32' ? keys.find((k) => k.toLowerCase() === name.toLowerCase()) : null);
      if (hit && typeof this.baseEnv[hit] === 'string' && !(hit in env)) env[hit] = this.baseEnv[hit];
    }
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUNBUFFERED = '1';
    Object.assign(env, this.providerConfig.childEnv());
    env.ZTECH_OI_AUTH_TOKEN = this.token;
    env.ZTECH_OI_INSTANCE_ID = this.instanceId;
    return env;
  }

  async probe(timeoutMs) {
    const controller = new AbortController();
    const t = this.timers.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(`http://127.0.0.1:${this.port}/v1/health`, {
        method: 'GET', redirect: 'error', headers: { accept: 'application/json' }, signal: controller.signal,
      });
      if (!res || !res.ok) return { up: false };
      let body = null;
      try { body = JSON.parse(await res.text()); } catch { return { up: false }; }
      if (!body || body.status !== 'ok' || body.schema_version !== '1.0') return { up: false };
      return { up: true, mine: body.instance_id === this.instanceId };
    } catch {
      return { up: false };
    } finally {
      this.timers.clearTimeout(t);
    }
  }

  async waitReady(gen, child) {
    const deadline = this.now() + this.opts.readyTimeoutMs;
    while (this.now() < deadline) {
      if (gen !== this.generation || this.disposed || this.child !== child) return false;
      const r = await this.probe(this.opts.healthRequestTimeoutMs);
      if (gen !== this.generation || this.child !== child) return false;
      if (r.up && r.mine) return true;
      if (r.up && !r.mine) {
        // A healthy stranger owns the port. Never talk to it; drop our own child.
        this.generation += 1;
        await this.stopChild();
        this.setState('port_conflict', MESSAGES.port_conflict);
        return false;
      }
      await this.sleep(this.opts.readyPollMs);
    }
    if (gen !== this.generation) return false;
    // Stopped as an expected exit, so the failure below is counted exactly once.
    await this.stopChild();
    this.onFailure('Opportunity Intelligence did not become ready in time.');
    return false;
  }

  scheduleHealth(gen) {
    this.healthTimer = this.timers.setTimeout(async () => {
      this.healthTimer = null;
      if (gen !== this.generation || this.state !== 'running') return;
      const r = await this.probe(this.opts.healthRequestTimeoutMs);
      if (gen !== this.generation || this.state !== 'running') return;
      if (r.up && r.mine) {
        this.healthFailures = 0;
      } else if (r.up && !r.mine) {
        this.generation += 1;
        await this.stopChild();
        this.setState('port_conflict', MESSAGES.port_conflict);
        return;
      } else {
        this.healthFailures += 1;
        if (this.healthFailures >= this.opts.healthFailuresBeforeRestart) {
          this.healthFailures = 0;
          await this.stopChild();
          this.onFailure('Opportunity Intelligence stopped answering.');
          return;
        }
      }
      this.scheduleHealth(gen);
    }, this.opts.healthIntervalMs);
  }

  onChildExit(child, code) {
    if (child !== this.child) return; // an old child we already replaced
    this.child = null;
    for (const w of this.exitWaiters.splice(0)) w();
    if (this.expectedExit || this.disposed) {
      this.expectedExit = false;
      return;
    }
    this.generation += 1;
    this.onFailure(`Opportunity Intelligence exited${code === null || code === undefined ? '' : ` (code ${code})`}.`);
  }

  /** Restart with backoff, or open the circuit after too many restarts in the window. */
  onFailure(reason) {
    if (this.disposed || this.mode !== 'managed') return;
    const t = this.now();
    this.restartTimes = this.restartTimes.filter((x) => t - x < this.opts.circuitWindowMs);
    if (this.restartTimes.length >= this.opts.circuitMaxRestarts) {
      this.setState('crashed', MESSAGES.crashed);
      this.warn(`circuit open after ${this.restartTimes.length} restarts: ${reason}`);
      return;
    }
    this.restartTimes.push(t);
    const delay = BACKOFF_MS[Math.min(this.restartTimes.length - 1, BACKOFF_MS.length - 1)];
    this.setState('restarting', `${MESSAGES.restarting} ${reason}`);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.apply().catch((e) => this.warn(`restart failed: ${e && e.message}`));
    }, delay);
  }

  async stopChild() {
    const c = this.child;
    if (!c) return;
    this.expectedExit = true;
    const exited = new Promise((r) => this.exitWaiters.push(r));
    try { c.kill(); } catch { /* already gone */ }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise((r) => { this.timers.setTimeout(() => r(true), this.opts.gracefulStopMs); }),
    ]);
    if (timedOut && c.pid) this.killTreeImpl(c.pid, { platform: this.platform });
    if (this.child === c) {
      this.child = null;
      for (const w of this.exitWaiters.splice(0)) w();
    }
    this.expectedExit = false;
    this.useConfiguredDestination();
  }

  useConfiguredDestination() {
    if (this.gateway && typeof this.gateway.reconfigure === 'function') this.gateway.reconfigure({ port: null, authToken: null });
  }

  refreshReported() {
    if (!this.gateway || typeof this.gateway.describeEngine !== 'function') return;
    const gen = this.generation;
    Promise.resolve(this.gateway.describeEngine()).then((r) => {
      if (gen === this.generation && r && r.ok) this.reported = r.configuration || null;
    }).catch(() => {});
  }

  // --- output / helpers -----------------------------------------------------

  attachOutput(child) {
    let pending = { out: '', err: '' };
    const feed = (which) => (chunk) => {
      pending[which] += String(chunk);
      const lines = pending[which].split(/\r?\n/);
      pending[which] = lines.pop();
      for (const line of lines) this.logLine(line);
    };
    if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', feed('out'));
    if (child.stderr && typeof child.stderr.on === 'function') child.stderr.on('data', feed('err'));
  }

  redact(text) {
    let out = String(text);
    const secrets = [...this.providerConfig.secretValues(), this.token, this.instanceId].filter((s) => typeof s === 'string' && s.length >= 6);
    for (const s of secrets) out = out.split(s).join('[redacted]');
    return out;
  }

  logLine(line) {
    const clean = this.redact(line).slice(0, 2000);
    this.logBuffer.push(clean);
    if (this.logBuffer.length > this.opts.logLines) this.logBuffer.splice(0, this.logBuffer.length - this.opts.logLines);
    if (this.logger && typeof this.logger.info === 'function') this.logger.info(`[oi] ${clean}`);
  }

  setState(state, message) {
    if (this.state !== state) this.since = new Date(this.now()).toISOString();
    this.state = state;
    this.message = message || MESSAGES[state] || '';
  }

  clearTimers() {
    for (const k of ['healthTimer', 'retryTimer']) {
      if (this[k]) { this.timers.clearTimeout(this[k]); this[k] = null; }
    }
  }

  sleep(ms) { return new Promise((r) => this.timers.setTimeout(r, ms)); }

  warn(m) { if (this.logger && typeof this.logger.warn === 'function') this.logger.warn(`[opportunity-intelligence] ${this.redact(m)}`); }
}

module.exports = {
  OpportunityServiceSupervisor,
  validateOiFolder,
  resolveLaunchCommand,
  findFreePort,
  killTree,
  MODES,
  STATES,
  BACKOFF_MS,
  DEFAULTS,
  ENV_ALLOWLIST,
  MESSAGES,
};
