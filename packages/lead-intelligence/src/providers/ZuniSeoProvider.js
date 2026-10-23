'use strict';

const { ProviderError } = require('../core/errors');
const { mapZuniSeoEnvelope } = require('./envelopeMapper');

/**
 * ZuniSeoProvider — ProspectResearchProvider backed by a Zuni-SEO transport.
 * The provider does not know whether the transport is MCP, REST or a local file.
 *
 * Transport contract (implemented by McpTransport, RestTransport, ArtifactImporter):
 *   health(): Promise<{ ok: boolean }>
 *   start({ url, idempotencyKey, artifactPath? }): Promise<{ jobId: string, status: string }>
 *   status(jobId): Promise<{ status: string }>
 *   envelope(jobId): Promise<object>   // Evidence Envelope v1
 */

const STATUS_MAP = Object.freeze({
  queued: 'running', pending: 'running', running: 'running', started: 'running', in_progress: 'running', accepted: 'running',
  complete: 'complete', completed: 'complete', done: 'complete', succeeded: 'complete', success: 'complete', finished: 'complete',
  partial: 'partial',
  failed: 'failed', error: 'failed', cancelled: 'failed', canceled: 'failed', expired: 'failed',
});

function normalizeJobStatus(s) {
  const v = STATUS_MAP[String(s || '').toLowerCase()];
  if (!v) throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Research service returned an unknown job status', { retryable: false });
  return v;
}

class ZuniSeoProvider {
  /**
   * @param {{transport: object, id?: string, name?: string, mapEnvelope?: Function}} opts
   */
  constructor({ transport, id = 'zuni-seo', name = 'Zuni-SEO', mapEnvelope = mapZuniSeoEnvelope }) {
    if (!transport) throw new TypeError('transport is required');
    for (const m of ['health', 'start', 'status', 'envelope']) {
      if (typeof transport[m] !== 'function') throw new TypeError(`transport is missing ${m}()`);
    }
    this.id = id;
    this.name = name;
    this.transport = transport;
    this.mapEnvelope = mapEnvelope;
  }

  async preflight() {
    try {
      const h = await this.transport.health();
      if (h && h.ok) return { ok: true };
      return { ok: false, retryable: true, code: 'PROVIDER_UNHEALTHY' };
    } catch (e) {
      if (e instanceof ProviderError) return { ok: false, retryable: e.retryable, blocking: e.blocking, code: e.code };
      throw e;
    }
  }

  async startResearch({ domain, idempotencyKey, options = {} }) {
    const r = await this.transport.start({
      url: `https://${domain}`,
      idempotencyKey,
      artifactPath: options.artifactPath,
    });
    if (!r || typeof r.jobId !== 'string' || !r.jobId || r.jobId.length > 200) {
      throw new ProviderError('PROVIDER_BAD_RESPONSE', 'Research service did not return a job id', { retryable: false });
    }
    return { providerJobId: r.jobId, status: normalizeJobStatus(r.status || 'running') };
  }

  async pollResearch(providerJobId) {
    const r = await this.transport.status(providerJobId);
    return { status: normalizeJobStatus(r && r.status) };
  }

  async fetchResult(providerJobId, { requestedDomain }) {
    const env = await this.transport.envelope(providerJobId);
    return this.mapEnvelope(env, { requestedDomain, providerJobId });
  }
}

module.exports = { ZuniSeoProvider, normalizeJobStatus };
