'use strict';

/**
 * F26.6 Native Mailbox Transport - the ONE definition of the mailbox vocabulary.
 *
 * Pure: no I/O. The same lists appear as CHECK constraints in migration 010.
 *
 * WHAT A MAILBOX RECORD MAY HOLD: sanitized identity (provider, email address, display name),
 * status, pacing limits and a sync cursor. NEVER a token, an auth code, a PKCE verifier or a
 * client secret - those exist only in the main process (credential vault / memory).
 */

const { EMAIL } = require('../contracts/leadView');

const MAILBOX_PROVIDERS = Object.freeze(['gmail', 'microsoft365']);
const MAILBOX_STATUSES = Object.freeze(['needs_check', 'ready', 'paused', 'reconnect_needed']);
const MARKET_RULES = Object.freeze(['consent_required', 'opt_out_allowed']);

/**
 * Provider capability, decided by verification - never by configuration or assumption.
 * unsubscribeHeaderSupport: 'unknown' until a real-mailbox test shows the stored copy keeps
 * List-Unsubscribe; 'verified' only after it does.
 */
const PROVIDER_CAPABILITY = Object.freeze({
  // Step 1A (a real Gmail mailbox) must pass before Gmail can send or sync; each mailbox also
  // passes its own "Check mailbox" before it is Ready. Connecting (OAuth + profile) is allowed.
  gmail: Object.freeze({ code: 'MAILBOX_PROVIDER_STEP1_PENDING', canConnect: true, canSend: false, canSyncReplies: false, unsubscribeHeaderSupport: 'unknown' }),
  // Step 1B is deferred: identity and interface only. Nothing is claimed for Microsoft.
  microsoft365: Object.freeze({ code: 'MAILBOX_PROVIDER_UNVERIFIED', canConnect: false, canSend: false, canSyncReplies: false, unsubscribeHeaderSupport: 'unknown' }),
});

const PROVIDER_LABEL = Object.freeze({
  gmail: 'Google Workspace / Gmail',
  microsoft365: 'Microsoft 365',
});

const PROVIDER_NOTICE = Object.freeze({
  gmail: 'Gmail sending is waiting for its real-mailbox verification (Step 1A).',
  microsoft365: 'Microsoft 365 — verification required before activation',
});

/** ZTech defaults (not provider figures) and the ZTech maximums, far below the provider caps. */
const MAILBOX_DEFAULTS = Object.freeze({
  daily_cap: 30, hourly_cap: 8, min_gap_seconds: 180,
  window_start: '09:00', window_end: '17:00', window_days: '1,2,3,4,5',
});
const MAILBOX_LIMITS = Object.freeze({ DAILY_MAX: 200, HOURLY_MAX: 30, MIN_GAP_MIN: 60, MIN_GAP_MAX: 3600 });

const MAILBOX_ID_RE = /^mbx_[A-Za-z0-9-]{8,64}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(error) { return { ok: false, error }; }

function isTimeZone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function cleanLine(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Validate a set of pacing limits (a partial patch is merged onto `base`). */
function normalizeLimits(input, base = MAILBOX_DEFAULTS) {
  const i = input && typeof input === 'object' ? input : {};
  const v = { ...base };
  const int = (key, lo, hi) => {
    if (i[key] === undefined) return null;
    const n = Number(i[key]);
    if (!Number.isInteger(n) || n < lo || n > hi) return `limits: ${key} must be a whole number from ${lo} to ${hi}`;
    v[key] = n;
    return null;
  };
  const errs = [
    int('daily_cap', 1, MAILBOX_LIMITS.DAILY_MAX),
    int('hourly_cap', 1, MAILBOX_LIMITS.HOURLY_MAX),
    int('min_gap_seconds', MAILBOX_LIMITS.MIN_GAP_MIN, MAILBOX_LIMITS.MIN_GAP_MAX),
  ].filter(Boolean);
  if (errs.length) return fail(errs[0]);
  for (const key of ['window_start', 'window_end']) {
    if (i[key] === undefined) continue;
    if (typeof i[key] !== 'string' || !HHMM_RE.test(i[key])) return fail(`limits: ${key} must be HH:MM`);
    v[key] = i[key];
  }
  if (v.window_start >= v.window_end) return fail('limits: the sending window must end after it starts');
  if (i.window_days !== undefined) {
    const days = String(i.window_days).split(',').map((d) => d.trim()).filter(Boolean);
    if (!days.length || days.some((d) => !/^[0-6]$/.test(d)) || new Set(days).size !== days.length) return fail('limits: window_days must be distinct weekdays 0-6 (0 = Sunday)');
    v.window_days = days.sort().join(',');
  }
  if (v.hourly_cap > v.daily_cap) return fail('limits: the hourly cap cannot exceed the daily cap');
  return { ok: true, value: v };
}

function normalizeMailboxRecord(rec) {
  if (!rec || typeof rec !== 'object') return fail('mailbox: record');
  if (typeof rec.mailbox_id !== 'string' || !MAILBOX_ID_RE.test(rec.mailbox_id)) return fail('mailbox: mailbox_id');
  if (!MAILBOX_PROVIDERS.includes(rec.provider)) return fail('mailbox: provider');
  const email = typeof rec.email_address === 'string' ? rec.email_address.trim().toLowerCase() : '';
  if (!EMAIL.test(email)) return fail('mailbox: email_address');
  if (!MAILBOX_STATUSES.includes(rec.status)) return fail('mailbox: status');
  const limits = normalizeLimits(rec, MAILBOX_DEFAULTS);
  if (!limits.ok) return limits;
  if (!isTimeZone(rec.time_zone)) return fail('mailbox: time_zone');
  for (const k of ['connected_at', 'updated_at']) if (typeof rec[k] !== 'string' || !Number.isFinite(Date.parse(rec[k]))) return fail(`mailbox: ${k}`);
  return {
    ok: true,
    value: {
      mailbox_id: rec.mailbox_id, provider: rec.provider, email_address: email,
      display_name: cleanLine(rec.display_name, 120) || null, status: rec.status,
      status_code: rec.status_code == null ? null : cleanLine(rec.status_code, 64) || null,
      paused_until: rec.paused_until == null ? null : String(rec.paused_until),
      ...limits.value, time_zone: rec.time_zone, is_default: rec.is_default ? 1 : 0,
      sync_cursor: rec.sync_cursor == null ? null : cleanLine(String(rec.sync_cursor), 64) || null,
      connected_at: rec.connected_at, updated_at: rec.updated_at,
    },
  };
}

/**
 * The renderer-safe mailbox view: mailbox_id, provider, email address, display name,
 * connection status and pacing status (limits + pause). Nothing else - and never a secret.
 */
function sanitizeMailbox(row, pacing = null) {
  if (!row) return null;
  return {
    mailboxId: row.mailbox_id,
    provider: row.provider,
    providerLabel: PROVIDER_LABEL[row.provider] || row.provider,
    emailAddress: row.email_address,
    displayName: row.display_name || null,
    status: row.status,
    statusCode: row.status_code || null,
    pausedUntil: row.paused_until || null,
    isDefault: row.is_default === 1,
    limits: {
      dailyCap: row.daily_cap, hourlyCap: row.hourly_cap, minGapSeconds: row.min_gap_seconds,
      windowStart: row.window_start, windowEnd: row.window_end, windowDays: row.window_days, timeZone: row.time_zone,
    },
    pacing: pacing ? { allowed: pacing.allowed === true, nextAllowedAt: pacing.nextAllowedAt || null, reason: pacing.reason || null, sentToday: pacing.counts ? pacing.counts.day : null, sentThisHour: pacing.counts ? pacing.counts.hour : null } : null,
    connectedAt: row.connected_at,
  };
}

/* ------------------------------ market rules ------------------------------ */

// Country names as they appear in collected leads, mapped to ISO 3166-1 alpha-2. Anything not
// recognised is "unknown", and unknown means consent required.
const COUNTRY_NAMES = Object.freeze({
  'united states': 'US', 'united states of america': 'US', usa: 'US', 'u.s.': 'US', 'u.s.a.': 'US', america: 'US',
  pakistan: 'PK', 'united kingdom': 'GB', uk: 'GB', 'great britain': 'GB', england: 'GB', canada: 'CA',
  australia: 'AU', 'new zealand': 'NZ', 'united arab emirates': 'AE', uae: 'AE', 'saudi arabia': 'SA', india: 'IN',
  germany: 'DE', france: 'FR', ireland: 'IE', netherlands: 'NL', singapore: 'SG', 'south africa': 'ZA', qatar: 'QA',
  thailand: 'TH', malaysia: 'MY', turkey: 'TR', 'türkiye': 'TR',
});

function normalizeCountry(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return COUNTRY_NAMES[s.toLowerCase()] || null;
}

function normalizeMarketRule(rec) {
  if (!rec || typeof rec !== 'object') return fail('market rule: record');
  const code = typeof rec.country_code === 'string' && /^[A-Za-z]{2}$/.test(rec.country_code) ? rec.country_code.toUpperCase() : null;
  if (!code) return fail('market rule: country_code');
  if (!MARKET_RULES.includes(rec.rule)) return fail('market rule: rule');
  const note = cleanLine(rec.note, 500);
  if (note.length < 3) return fail('market rule: note (what was reviewed, and by whom)');
  const by = cleanLine(rec.reviewed_by, 80);
  if (!by) return fail('market rule: reviewed_by');
  if (typeof rec.reviewed_at !== 'string' || !Number.isFinite(Date.parse(rec.reviewed_at))) return fail('market rule: reviewed_at');
  return { ok: true, value: { country_code: code, rule: rec.rule, note, reviewed_by: by, reviewed_at: rec.reviewed_at } };
}

function requireValid(result) {
  if (result.ok) return result.value;
  const { ValidationError } = require('../core/errors');
  throw new ValidationError('Invalid mailbox record', [{ path: '$', message: result.error }]);
}

module.exports = {
  MAILBOX_PROVIDERS, MAILBOX_STATUSES, MARKET_RULES, PROVIDER_CAPABILITY, PROVIDER_LABEL, PROVIDER_NOTICE,
  MAILBOX_DEFAULTS, MAILBOX_LIMITS, MAILBOX_ID_RE, isTimeZone, normalizeLimits, normalizeMailboxRecord,
  sanitizeMailbox, normalizeCountry, normalizeMarketRule, requireValid,
};
