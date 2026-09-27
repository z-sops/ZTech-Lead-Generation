'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Freshness rules. A packet older than its max age is stale:
 * it stays visible (with its age) but is not used by the Outreach Gate,
 * and a new research request is allowed.
 */
class FreshnessPolicy {
  constructor({ completeMaxAgeDays = 30, partialMaxAgeDays = 7, failedMaxAgeDays = 1 } = {}) {
    for (const [k, v] of Object.entries({ completeMaxAgeDays, partialMaxAgeDays, failedMaxAgeDays })) {
      if (!Number.isInteger(v) || v < 0 || v > 3650) throw new RangeError(`${k} must be an integer 0..3650`);
    }
    this.completeMaxAgeDays = completeMaxAgeDays;
    this.partialMaxAgeDays = partialMaxAgeDays;
    this.failedMaxAgeDays = failedMaxAgeDays;
  }

  maxAgeDaysFor(status) {
    if (status === 'complete') return this.completeMaxAgeDays;
    if (status === 'partial') return this.partialMaxAgeDays;
    return this.failedMaxAgeDays;
  }

  describe(capturedAtIso, status) {
    const max = this.maxAgeDaysFor(status);
    const expires = new Date(Date.parse(capturedAtIso) + max * DAY_MS).toISOString();
    return { captured_at: capturedAtIso, expires_at: expires, max_age_days: max };
  }

  /** Failed packets are never "fresh evidence". */
  isFresh(packet, now = new Date()) {
    if (!packet || !packet.freshness) return false;
    if (packet.research_status === 'failed') return false;
    return Date.parse(packet.freshness.expires_at) > now.getTime();
  }

  isExpiredAt(expiresAtIso, now = new Date()) {
    return Date.parse(expiresAtIso) <= now.getTime();
  }

  ageDays(packet, now = new Date()) {
    return Math.floor((now.getTime() - Date.parse(packet.captured_at)) / DAY_MS);
  }
}

module.exports = { FreshnessPolicy, DAY_MS };
