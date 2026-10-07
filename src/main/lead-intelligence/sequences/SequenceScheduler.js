'use strict';

/**
 * F28 - the follow-up scheduler. MAIN PROCESS ONLY; it runs only while ZTech is open.
 *
 * D1 (Zee, 7 Oct 2026) lets ZTech send an APPROVED step of an ACTIVATED sequence by itself. This
 * class is the only thing that does that, and all it can do is ask SequenceService.sendDueStep for
 * a step that is already due. It never writes content, never picks a recipient, never sends a
 * first email, never uses Resend, the mail-app handoff or Microsoft, and has no IPC surface.
 *
 * Each tick (one at a time, never overlapping):
 *   1. "Pause all follow-ups" on -> nothing happens.
 *   2. sweep: stop rules for every open sequence; clear AUTO holds whose condition passed.
 *   3. due steps of active sequences, oldest first, AT MOST ONE PER MAILBOX per tick.
 */

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_DUE_PER_TICK = 50;

class SequenceScheduler {
  /** @param {{sequences: import('./SequenceService').SequenceService, store: object, clock?: () => Date, logger?: object|null}} deps */
  constructor({ sequences, store, clock = () => new Date(), logger = null } = {}) {
    if (!sequences || !store) throw new TypeError('SequenceScheduler needs the sequence service and the store');
    this.sequences = sequences;
    this.store = store;
    this.clock = clock;
    this.logger = logger;
    this._timer = null;
    this._running = null;
    this._recovered = false;
  }

  _warn(msg) { if (this.logger && this.logger.warn) this.logger.warn(`[lead-intelligence] follow-ups: ${msg}`); }

  /** One tick. Returns a summary (codes and counts only). Concurrent calls share the running tick. */
  tick() {
    if (this._stopped) return Promise.resolve({ pausedAll: false, outcomes: [], stopped: true });
    if (this._running) return this._running;
    this._running = this._tick().finally(() => { this._running = null; });
    return this._running;
  }

  async _tick() {
    const summary = { pausedAll: false, outcomes: [] };
    if (!this._recovered) {
      await this.sequences.recover();
      this._recovered = true;
    }
    if ((await this.store.sequences.control()).paused) { summary.pausedAll = true; return summary; }
    await this.sequences.sweep();
    const due = await this.store.sequences.dueSteps(this.clock().toISOString(), MAX_DUE_PER_TICK);
    const usedMailboxes = new Set();
    for (const step of due) {
      // Re-read the switch before every send: a human may have flipped it mid-tick.
      if ((await this.store.sequences.control()).paused) { summary.pausedAll = true; break; }
      const seq = await this.store.sequences.get(step.sequence_id);
      if (!seq || usedMailboxes.has(seq.mailbox_id)) continue;
      usedMailboxes.add(seq.mailbox_id);
      let outcome;
      try {
        outcome = await this.sequences.sendDueStep(step);
      } catch (err) {
        // An internal failure must never become a retry loop: the step stays where it was and the
        // problem is logged by code. (sendDueStep itself never throws on a send refusal.)
        outcome = 'error';
        this._warn(`tick failed: ${(err && err.code) || 'ERROR'}`);
      }
      summary.outcomes.push(outcome);
    }
    return summary;
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    if (this._timer) return;
    const every = Number.isInteger(intervalMs) && intervalMs >= 30 * 1000 ? intervalMs : DEFAULT_INTERVAL_MS;
    this._timer = setInterval(() => { this.tick().catch((err) => this._warn(`tick failed: ${(err && err.code) || 'ERROR'}`)); }, every);
    if (this._timer.unref) this._timer.unref();
  }

  /** No new tick starts after this; resolves once a tick that is mid-send has finished recording. */
  async stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._running) { try { await this._running; } catch { /* already logged */ } }
  }
}

module.exports = { SequenceScheduler, DEFAULT_INTERVAL_MS };
