'use strict';

/**
 * FakeEnrichmentProvider — scripted, deterministic. Tests and offline demos only;
 * registered only when config.enrichment.enableFakeProviders is true.
 *
 * script:
 *   fields: { 'company.city': 'Karachi', 'company.industry': null }   (null = NOT_FOUND)
 *   status: 'READY' | 'NOT_CONFIGURED' | 'UNAVAILABLE'
 *   errors: [ProviderError, ...]      thrown by enrich() in order
 *   delayMs: number                   simulate slow provider (for timeout tests)
 *   confidence: { 'company.city': { value: 0.9, scale: 'vendor score 0..1' } }
 *   duplicate: true                   return each field twice (dedupe test)
 *   raw: object                       return this raw object instead (contract tests)
 */
class FakeEnrichmentProvider {
  constructor({ id = 'fake-enrich', name = 'Fake enrichment', tier = 'third_party', fields, requires = ['name'], script = {} } = {}) {
    this.id = id;
    this.name = name;
    this._caps = { fields: fields || Object.keys(script.fields || {}), tier, requires };
    this.script = script;
    this.calls = [];
  }

  capabilities() {
    return { ...this._caps, fields: [...this._caps.fields], requires: [...this._caps.requires] };
  }

  async status() {
    return { state: this.script.status || 'READY' };
  }

  async enrich({ lead, fields, signal }) {
    this.calls.push({ lead_id: lead.lead_id, fields: [...fields] });
    if (this.script.errors && this.script.errors.length) throw this.script.errors.shift();
    if (this.script.delayMs) {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, this.script.delayMs);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
      });
    }
    if (this.script.raw) return this.script.raw;
    const out = [];
    for (const f of fields) {
      if (!Object.prototype.hasOwnProperty.call(this.script.fields || {}, f)) continue;
      const v = this.script.fields[f];
      const item = v === null
        ? { field: f, status: 'NOT_FOUND', value: null, source_ref: `fake://${this.id}/${lead.lead_id}` }
        : { field: f, status: 'FOUND', value: v, source_ref: `fake://${this.id}/${lead.lead_id}/${f}` };
      if (this.script.confidence && this.script.confidence[f]) item.provider_confidence = this.script.confidence[f];
      out.push(item);
      if (this.script.duplicate) out.push({ ...item });
    }
    return { provider_ref: `fake-${lead.lead_id}`, fields: out };
  }
}

module.exports = { FakeEnrichmentProvider };
