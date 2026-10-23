'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ProviderError } = require('../../core/errors');
const { stableHash } = require('../../core/ids');
const { parseJsonLimited, assertJobId } = require('./common');

/**
 * ArtifactImporter — "transport" that reads an Evidence Envelope JSON file the user
 * exported from Zuni-SEO (e.g. `zseo envelope ... > envelope.json`).
 *
 * Security:
 * - The file path is chosen by the user in a main-process open dialog. The renderer
 *   never sends a path (see ipc handler research:import-artifact).
 * - Only absolute paths to .json files, max 25 MB.
 *
 * Restart note: imported envelopes are held in memory until the coordinator stores the
 * packet, which happens in the same advance() call. If the app stops in between, the
 * job fails with PROVIDER_JOB_NOT_FOUND and the user simply imports again.
 */
class ArtifactImporter {
  constructor({ readFile = fs.promises.readFile, stat = fs.promises.stat, maxBytes = 25 * 1024 * 1024 } = {}) {
    this.readFile = readFile;
    this.stat = stat;
    this.maxBytes = maxBytes;
    this.envelopes = new Map();
  }

  async health() {
    return { ok: true };
  }

  async start({ artifactPath }) {
    if (typeof artifactPath !== 'string' || !path.isAbsolute(artifactPath) || path.extname(artifactPath).toLowerCase() !== '.json') {
      throw new ProviderError('ARTIFACT_PATH_INVALID', 'Select a Zuni-SEO envelope .json file', { retryable: false });
    }
    let info;
    try {
      info = await this.stat(artifactPath);
    } catch {
      throw new ProviderError('ARTIFACT_NOT_READABLE', 'The selected file could not be read', { retryable: false });
    }
    if (!info.isFile()) throw new ProviderError('ARTIFACT_NOT_READABLE', 'The selected path is not a file', { retryable: false });
    if (info.size > this.maxBytes) throw new ProviderError('ARTIFACT_TOO_LARGE', 'The selected file is too large', { retryable: false });
    let raw;
    try {
      raw = await this.readFile(artifactPath, 'utf8');
    } catch {
      throw new ProviderError('ARTIFACT_NOT_READABLE', 'The selected file could not be read', { retryable: false });
    }
    const envelope = parseJsonLimited(raw, this.maxBytes, 'artifact');
    const jobId = `artifact-${stableHash(raw).slice(0, 32)}`;
    this.envelopes.set(jobId, envelope);
    return { jobId, status: 'complete' };
  }

  async status(jobId) {
    assertJobId(jobId);
    if (!this.envelopes.has(jobId)) throw new ProviderError('PROVIDER_JOB_NOT_FOUND', 'Imported file is no longer loaded; import it again', { retryable: false });
    return { status: 'complete' };
  }

  async envelope(jobId) {
    assertJobId(jobId);
    const env = this.envelopes.get(jobId);
    if (!env) throw new ProviderError('PROVIDER_JOB_NOT_FOUND', 'Imported file is no longer loaded; import it again', { retryable: false });
    this.envelopes.delete(jobId);
    return env;
  }
}

module.exports = { ArtifactImporter };
