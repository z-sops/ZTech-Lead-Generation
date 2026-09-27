'use strict';

const { assertEnrichmentProvider, PROVIDER_STATES } = require('./EnrichmentProvider');

/**
 * EnrichmentProviderRegistry — the configured providers, in waterfall order.
 *
 * Order comes from config.enrichment.providerOrder (ids). Registered providers missing
 * from that list are appended in registration order. Ids in the list that are not
 * registered are reported as NOT_CONFIGURED (so the UI shows them honestly) but never
 * called.
 */
class EnrichmentProviderRegistry {
  constructor({ providers = [], order = [], statusTimeoutMs = 5000 } = {}) {
    this.providers = new Map();
    for (const p of providers) this.register(p);
    this.order = [...order];
    this.statusTimeoutMs = statusTimeoutMs;
  }

  register(p) {
    assertEnrichmentProvider(p);
    if (this.providers.has(p.id)) throw new Error(`enrichment provider ${p.id} registered twice`);
    this.providers.set(p.id, p);
    return this;
  }

  get(id) {
    return this.providers.get(id) || null;
  }

  /** Waterfall order: configured ids first (registered or not), then the rest. */
  orderedIds() {
    const out = [];
    for (const id of this.order) if (!out.includes(id)) out.push(id);
    for (const id of this.providers.keys()) if (!out.includes(id)) out.push(id);
    return out;
  }

  /** Provider status for the UI. Never includes credentials or raw error text. */
  async statuses() {
    const out = [];
    for (const id of this.orderedIds()) {
      const p = this.providers.get(id);
      if (!p) {
        out.push({ id, name: id, state: 'NOT_CONFIGURED', reason: 'Not registered in this build.', fields: [], tier: null });
        continue;
      }
      out.push({ id, name: p.name, ...(await this.statusOf(p)), fields: p.capabilities().fields, tier: p.capabilities().tier });
    }
    return out;
  }

  async statusOf(p) {
    let timer;
    try {
      const s = await Promise.race([
        Promise.resolve().then(() => p.status()),
        new Promise((resolve) => { timer = setTimeout(() => resolve({ state: 'UNAVAILABLE', reason: 'Status check timed out.' }), this.statusTimeoutMs); if (timer.unref) timer.unref(); }),
      ]);
      if (!s || !PROVIDER_STATES.includes(s.state)) return { state: 'UNAVAILABLE', reason: 'Provider returned an invalid status.' };
      return { state: s.state, reason: typeof s.reason === 'string' ? s.reason.slice(0, 200) : null };
    } catch {
      return { state: 'UNAVAILABLE', reason: 'Status check failed.' };
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = { EnrichmentProviderRegistry };
