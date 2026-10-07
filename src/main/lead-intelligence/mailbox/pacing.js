'use strict';

/**
 * F26.6 per-mailbox pacing - pure, no I/O, no timers.
 *
 * Pacing never queues, schedules or retries anything. It answers one question for one human
 * click: may THIS mailbox send one message NOW? If not, the send is refused with
 * MAILBOX_PACING and the earliest time a new click would pass (`nextAllowedAt`).
 *
 * Inputs are the mailbox's own limits and the created_at of its own recent sends (from the
 * ledger, keyed by mailbox_id), so two mailboxes never share a count and a restart resets nothing.
 *
 *   daily_cap        rolling 24 hours
 *   hourly_cap       rolling 60 minutes
 *   min_gap_seconds  since this mailbox's last send
 *   window           window_start..window_end (end exclusive) on window_days, in time_zone
 */

const PACING_CODE = 'MAILBOX_PACING';
const DAY_MS = 24 * 3600 * 1000;
const HOUR_MS = 3600 * 1000;
const MIN_MS = 60 * 1000;
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const fmtCache = new Map();
function formatter(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', weekday: 'short', hour: '2-digit', minute: '2-digit' }));
  }
  return fmtCache.get(tz);
}

/** Local weekday (0 = Sunday) and minute-of-day of an instant in a time zone. */
function localParts(ms, tz) {
  const parts = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { day: WEEKDAY[parts.weekday], minute: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
}

const hhmm = (s) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

/**
 * The first instant >= ms that lies inside the sending window, or null if none within 8 days
 * (an impossible window; normalizeLimits already refuses one). DST-safe: every jump is re-checked.
 */
function nextWindowOpen(ms, { window_start, window_end, window_days, time_zone }) {
  const days = new Set(String(window_days).split(',').map(Number));
  const start = hhmm(window_start);
  const end = hhmm(window_end);
  let t = ms;
  for (let i = 0; i < 64 && t - ms <= 8 * DAY_MS; i += 1) {
    const { day, minute } = localParts(t, time_zone);
    if (days.has(day) && minute >= start && minute < end) return t;
    const floor = t - (t % MIN_MS);
    if (days.has(day) && minute < start) t = floor + (start - minute) * MIN_MS;
    else t = floor + (1440 - minute) * MIN_MS; // to the next local midnight
  }
  return null;
}

/**
 * @param {{mailbox: object, sendTimes: string[], now: Date|number}} input
 *   sendTimes: created_at of this mailbox's non-blocked sends from at least the last 24h.
 * @returns {{allowed: boolean, code: string|null, reason: string|null, nextAllowedAt: string|null,
 *            counts: {day: number, hour: number}}}
 */
function evaluatePacing({ mailbox, sendTimes = [], now }) {
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const times = sendTimes.map((s) => Date.parse(s)).filter(Number.isFinite).filter((t) => t <= nowMs).sort((a, b) => a - b);
  const inDay = times.filter((t) => t > nowMs - DAY_MS);
  const inHour = inDay.filter((t) => t > nowMs - HOUR_MS);
  const counts = { day: inDay.length, hour: inHour.length };

  // Each limit yields the instant it stops binding; the latest one wins.
  const blocks = [];
  if (inDay.length >= mailbox.daily_cap) blocks.push(['daily_cap', inDay[inDay.length - mailbox.daily_cap] + DAY_MS]);
  if (inHour.length >= mailbox.hourly_cap) blocks.push(['hourly_cap', inHour[inHour.length - mailbox.hourly_cap] + HOUR_MS]);
  const last = times.length ? times[times.length - 1] : null;
  if (last !== null && nowMs < last + mailbox.min_gap_seconds * 1000) blocks.push(['min_gap', last + mailbox.min_gap_seconds * 1000]);

  let reason = null;
  let earliest = nowMs;
  for (const [why, at] of blocks) if (at > earliest) { earliest = at; reason = why; }
  const open = nextWindowOpen(earliest, mailbox);
  if (open === null) return { allowed: false, code: PACING_CODE, reason: 'outside_window', nextAllowedAt: null, counts };
  if (open > earliest && reason === null) reason = 'outside_window';
  if (reason === null) return { allowed: true, code: null, reason: null, nextAllowedAt: null, counts };
  return { allowed: false, code: PACING_CODE, reason, nextAllowedAt: new Date(open).toISOString(), counts };
}

const PACING_MESSAGES = Object.freeze({
  daily_cap: 'This mailbox has reached its daily limit.',
  hourly_cap: 'This mailbox has reached its hourly limit.',
  min_gap: 'This mailbox sent a message moments ago; ZTech spaces messages out.',
  outside_window: 'This is outside this mailbox\'s sending window.',
});

/** The refusal text for a blocked verdict; nothing is queued, the user clicks again later. */
function pacingMessage(verdict) {
  const head = PACING_MESSAGES[verdict.reason] || 'This mailbox cannot send right now.';
  return verdict.nextAllowedAt ? `${head} Nothing was queued. You can send again from ${verdict.nextAllowedAt}.` : `${head} Nothing was queued.`;
}

module.exports = { PACING_CODE, evaluatePacing, nextWindowOpen, localParts, pacingMessage };
