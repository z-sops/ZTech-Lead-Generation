'use strict';

/**
 * Competitor ads: which advertisers a workspace watches, the weekly checks,
 * and the week-against-week report.
 *
 * A check is a research-queue job of kind `competitor_ads` that the worker
 * runs through the Meta Ads connector; its result is the job result. So the
 * history of a watch is the history of its succeeded jobs, isolated per
 * workspace by the same database functions as research.
 *
 * Weekly checks: there is no clock inside the API that could act for a
 * workspace (a workspace context needs a signed-in session). So a check is
 * queued (1) when a watch is created, (2) on "Check now", and (3) whenever
 * someone in the workspace opens the list and a watch's last check is 7 or
 * more days old. The idempotency key carries the ISO week, so that path can
 * never queue more than one check per watch per week.
 */

const crypto = require('node:crypto');
const { intel } = require('@zunitech/lead-intelligence');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WEEK_MS = 7 * 86400000;
const HISTORY_MAX = 12;
const ACTIVE_STATES = new Set(['queued', 'leased', 'running']);

class CompetitorError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'CompetitorError';
    this.status = status;
    this.code = code;
    if (field) this.field = field;
  }
}

const bad = (field, message) => new CompetitorError(400, 'invalid_watch', message, field);

function clean(v, max) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function validateWatch(input) {
  const i = input && typeof input === 'object' ? input : {};
  const query = clean(i.query, 120);
  const pageId = i.page_id === undefined || i.page_id === null || i.page_id === '' ? null : String(i.page_id).trim();
  if (pageId && !/^\d{3,25}$/.test(pageId)) throw bad('page_id', 'the page id is the number in the Facebook page\'s Ad Library link');
  if (!query && !pageId) throw bad('query', 'give the competitor\'s Facebook page name');
  const country = String(i.country || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) throw bad('country', 'choose the country the ads run in');
  const label = clean(i.label, 120) || query || pageId;
  let accountId = null;
  if (i.account_id) {
    if (!UUID_RE.test(String(i.account_id))) throw bad('account_id', 'that is not a CRM account');
    accountId = String(i.account_id).toLowerCase();
  }
  return { label, query: query || pageId, page_id: pageId, country, account_id: accountId };
}

class CompetitorService {
  constructor(deps = {}) {
    this.now = deps.now || (() => new Date());
  }

  /** This workspace's competitor-ads jobs, newest first, grouped by watch. */
  async jobsByWatch(store) {
    const jobs = await store.tx(async () => store.researchJobs.list({ limit: 1000 }));
    const by = new Map();
    for (const j of jobs) {
      const p = j.payload || {};
      if (p.kind !== 'competitor_ads' || !p.watch_id) continue;
      if (!by.has(p.watch_id)) by.set(p.watch_id, []);
      by.get(p.watch_id).push(j);
    }
    for (const list of by.values()) list.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    return by;
  }

  async enqueue(store, watch, key) {
    return store.tx(async () => store.researchJobs.enqueue({
      jobId: crypto.randomUUID(),
      jobType: 'research',
      idempotencyKey: key,
      payload: {
        kind: 'competitor_ads',
        watch_id: watch.watch_id,
        watch: { query: watch.query, page_id: watch.page_id || null, country: watch.country },
      },
    }));
  }

  weeklyKey(watch, now) {
    return `ads:${watch.watch_id}:${intel.adsDiff.isoWeek(now)}`;
  }

  async create(store, actor, input) {
    const fields = validateWatch(input);
    const at = this.now();
    const watch = {
      watch_id: crypto.randomUUID(), ...fields, created_by: actor.userId, created_at: at.toISOString(), archived_at: null,
    };
    let row;
    try {
      row = await store.tx(async () => {
        if (fields.account_id && !await store.crm.getAccount(fields.account_id)) throw bad('account_id', 'no such CRM account');
        return store.competitors.create(watch);
      });
    } catch (err) {
      if (err && err.code === '23505') throw new CompetitorError(409, 'already_watched', 'this competitor is already watched in that country');
      throw err;
    }
    await this.enqueue(store, row, this.weeklyKey(row, at));
    return row;
  }

  /** Results of a watch's succeeded checks, newest first (at most HISTORY_MAX). */
  async results(store, jobs) {
    const out = [];
    for (const j of jobs) {
      if (j.state !== 'succeeded') continue;
      const r = await store.tx(async () => store.researchJobs.result({ jobId: j.job_id }));
      if (r && r.result && r.result.schema === intel.adsDiff.RESULT_SCHEMA) out.push(r.result);
      if (out.length >= HISTORY_MAX) break;
    }
    return out;
  }

  status(jobs) {
    const latest = jobs[0] || null;
    const pending = jobs.find((j) => ACTIVE_STATES.has(j.state)) || null;
    const lastFailed = latest && latest.state === 'failed' ? latest.last_error : null;
    return {
      last_check_requested_at: latest ? latest.created_at : null,
      checking: Boolean(pending),
      last_error: lastFailed ? String(lastFailed).slice(0, 300) : null,
    };
  }

  /**
   * Every watch with its latest comparison; due weekly checks are queued.
   */
  async list(store, { autoSchedule = true } = {}) {
    const watches = await store.tx(async () => store.competitors.list());
    const byWatch = await this.jobsByWatch(store);
    const now = this.now();
    const out = [];
    for (const w of watches) {
      let jobs = byWatch.get(w.watch_id) || [];
      const latest = jobs[0];
      const due = autoSchedule && (!latest || (!ACTIVE_STATES.has(latest.state) && now - Date.parse(latest.created_at) >= WEEK_MS));
      if (due) {
        await this.enqueue(store, w, this.weeklyKey(w, now));
        jobs = (await this.jobsByWatch(store)).get(w.watch_id) || [];
      }
      const results = await this.results(store, jobs.slice(0, 3));
      const compared = results.length ? intel.adsDiff.compareChecks(results[1] || null, results[0], now) : null;
      out.push({
        watch: w,
        ...this.status(jobs),
        summary: compared ? {
          checked_at: compared.checked_at,
          counts: compared.counts,
          longest_running: compared.longest_running,
          source: results[0].source,
        } : null,
      });
    }
    return out;
  }

  async detail(store, watchId) {
    if (!UUID_RE.test(String(watchId))) return null;
    const watch = await store.tx(async () => store.competitors.get(watchId));
    if (!watch) return null;
    const jobs = (await this.jobsByWatch(store)).get(watchId) || [];
    const results = await this.results(store, jobs);
    const now = this.now();
    return {
      watch,
      ...this.status(jobs),
      report: results.length ? intel.adsDiff.compareChecks(results[1] || null, results[0], now) : null,
      history: intel.adsDiff.history(results),
      notes: results.length ? results[0].notes : [],
      source: results.length ? results[0].source : null,
    };
  }

  /** "Check now": at most one manual check per watch per hour. */
  async checkNow(store, watchId) {
    if (!UUID_RE.test(String(watchId))) throw new CompetitorError(404, 'not_found', 'no such watch');
    const watch = await store.tx(async () => store.competitors.get(watchId));
    if (!watch || watch.archived_at) throw new CompetitorError(404, 'not_found', 'no such watch');
    const now = this.now();
    const hour = now.toISOString().slice(0, 13);
    const job = await this.enqueue(store, watch, `ads:${watch.watch_id}:manual:${hour}`);
    return { job_id: job.job_id, state: job.state, deduplicated: Boolean(job.deduplicated) };
  }

  async archive(store, watchId) {
    if (!UUID_RE.test(String(watchId))) throw new CompetitorError(404, 'not_found', 'no such watch');
    const row = await store.tx(async () => store.competitors.archive(watchId, this.now().toISOString()));
    if (!row) throw new CompetitorError(404, 'not_found', 'no such watch');
    return row;
  }
}

module.exports = { CompetitorService, CompetitorError, validateWatch };
