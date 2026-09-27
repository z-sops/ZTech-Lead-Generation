'use strict';

const { assertValid } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { scrubSecrets } = require('../core/objects');
const { sanitizeUntrusted, WITHHELD } = require('../agent/sanitize');
const { CHANNELS: C } = require('./channels');
const { INPUT_SCHEMAS } = require('./schemas');

/**
 * Register all lead-intelligence IPC handlers in the MAIN process.
 *
 * Flow for every channel:
 *   renderer invoke -> sender check -> schema validation -> id normalisation
 *   -> domain service -> persistence/provider -> scrubbed, JSON-safe response
 *
 * @param {object} opts
 * @param {object} opts.ipcMain            electron ipcMain
 * @param {object} opts.li                 result of createLeadIntelligence()
 * @param {Function} opts.isTrustedSender  (event) => boolean. INTEGRATION POINT: reuse the
 *                                         sender check added in round 1 if it exists;
 *                                         otherwise use makeIsTrustedSender() below.
 * @param {object} opts.dialogs            main-process dialogs (INTEGRATION POINT):
 *                                           chooseEnvelopeFile(event) -> Promise<string|null>
 *                                           saveExport({filename, mimeType, content}, event) -> Promise<{saved, filename}>
 * @param {object} [opts.logger]
 */
function registerLeadIntelligenceIpc({ ipcMain, li, isTrustedSender, dialogs = {}, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  const registered = [];

  const handle = (channel, fn) => {
    const schema = INPUT_SCHEMAS[channel];
    if (!schema) throw new Error(`No input schema for ${channel}`);
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertValid(schema, args, channel);
        const data = await fn(normalizeIds(args), event);
        return { ok: true, data: toSafe(data) };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[lead-intelligence] ${channel} failed: ${e && e.code ? e.code : 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };

  // Research control channels exist only in module mode. In round1 mode (Option A) the
  // round-1 engine and its own `prospect-research:*` channels run research.
  if (li.gateway) {
    handle(C.RESEARCH_REQUEST, (a) => li.gateway.requestResearch({ leadId: a.leadId, force: Boolean(a.force) }).then(publicRequestResult));
    handle(C.RESEARCH_IMPORT_ARTIFACT, async (a, event) => {
      if (typeof dialogs.chooseEnvelopeFile !== 'function') throw new ForbiddenError('File import is not available');
      const filePath = await dialogs.chooseEnvelopeFile(event);
      if (!filePath) return { cancelled: true };
      return publicRequestResult(await li.gateway.importArtifact({ leadId: a.leadId, artifactPath: filePath }));
    });
    handle(C.RESEARCH_STATUS, (a) => li.gateway.getStatus(a.leadId));
    handle(C.RESEARCH_HISTORY, (a) => li.gateway.getHistory(a.leadId));
  }
  handle(C.PROFILE_GET, (a) => li.profile.build({ leadId: a.leadId, targetId: a.targetId }));
  handle(C.EVIDENCE_GET, async (a) => sanitizePacketForRenderer(await li.research.evidence({ leadId: a.leadId, packetId: a.packetId })));
  handle(C.CHANGES_LIST, (a) => li.research.changes({ leadId: a.leadId }));
  handle(C.ICP_EVALUATE, (a) => li.icp.evaluate({ leadId: a.leadId, targetId: a.targetId }));

  handle(C.SEARCHES_LIST, () => li.savedSearches.list());
  handle(C.SEARCHES_SAVE, (a) => li.savedSearches.save({ searchId: a.searchId, name: a.name, filter: a.filter }));
  handle(C.SEARCHES_DELETE, (a) => li.savedSearches.delete(a.searchId));
  handle(C.SEARCHES_RUN, (a) => li.savedSearches.run({ searchId: a.searchId, filter: a.filter }));

  handle(C.SEGMENTS_LIST, () => li.segments.list());
  handle(C.SEGMENTS_SAVE, (a) => li.segments.save({ segmentId: a.segmentId, name: a.name, kind: a.kind, filter: a.filter }));
  handle(C.SEGMENTS_DELETE, (a) => li.segments.delete(a.segmentId));
  handle(C.SEGMENTS_MEMBERS, (a) => li.segments.members(a.segmentId));
  handle(C.SEGMENTS_ADD_LEADS, (a) => li.segments.addLeads(a.segmentId, a.leadIds));
  handle(C.SEGMENTS_REMOVE_LEADS, (a) => li.segments.removeLeads(a.segmentId, a.leadIds));

  handle(C.AGENT_ANALYZE, (a) => li.agent.analyze({ leadId: a.leadId, targetId: a.targetId, useLlm: Boolean(a.useLlm) }));
  handle(C.PITCH_GENERATE, (a) => li.outreach.generate({ leadId: a.leadId, targetId: a.targetId }));
  handle(C.PITCH_GET, async (a) => {
    if (a.pitchId) {
      const p = await li.outreach.get(a.pitchId);
      return p.lead_id === a.leadId ? p : null;
    }
    return li.outreach.latestForLead(a.leadId);
  });
  handle(C.PITCH_UPDATE, (a) => li.outreach.update({
    pitchId: a.pitchId,
    edits: { subject: a.subject, opening: a.opening, valueProposition: a.valueProposition, callToAction: a.callToAction, removeObservations: a.removeObservations },
  }));
  handle(C.OUTREACH_APPROVE, (a) => li.outreach.approve({ pitchId: a.pitchId }));
  handle(C.OUTREACH_GATE, (a) => li.outreach.gate({ pitchId: a.pitchId, channel: a.channel || 'email' }));

  // Two export modes (config.export.mode):
  //   "renderer-download" (ZTech default, verified Step 0 #13): the renderer receives the
  //       already-scrubbed file content and saves it with a Blob download, like ZTech's
  //       existing collector:export-numbers. No path ever crosses IPC.
  //   "save-dialog": main shows a save dialog (needs dialogs.saveExport).
  const exportMode = (li.config && li.config.export && li.config.export.mode) || (typeof dialogs.saveExport === 'function' ? 'save-dialog' : 'renderer-download');
  handle(C.EXPORT_RESEARCH, async (a, event) => {
    const file = await li.exporter.export({ scope: a.scope, format: a.format, targetId: a.targetId });
    if (exportMode === 'renderer-download') {
      return { mode: 'renderer-download', filename: file.filename, mimeType: file.mimeType, content: file.content, count: file.count };
    }
    if (typeof dialogs.saveExport !== 'function') throw new ForbiddenError('Export is not available');
    const r = await dialogs.saveExport(file, event);
    return { saved: Boolean(r && r.saved), count: file.count, filename: r && r.filename ? String(r.filename) : file.filename };
  });

  handle(C.ENRICHMENT_REQUEST, (a) => li.enrichment.request({ leadId: a.leadId, fields: a.fields, force: Boolean(a.force) }));
  handle(C.ENRICHMENT_STATUS, (a) => li.enrichment.status({ leadId: a.leadId }));
  handle(C.ENRICHMENT_PROFILE, async (a) => sanitizeEnrichmentProfile(await li.enrichment.profile({ leadId: a.leadId })));
  handle(C.ENRICHMENT_PROVIDERS, () => li.enrichment.providers());

  const emailCfg = (li.config && li.config.email) || {};
  if (emailCfg.enabled === true && li.outreach.emailProvider) {
    handle(C.EMAIL_SEND, (a) => li.outreach.send({ pitchId: a.pitchId }));
  }

  return {
    channels: [...registered],
    dispose() {
      for (const c of registered) ipcMain.removeHandler(c);
    },
  };
}

function normalizeIds(a) {
  const out = { ...a };
  if (out.leadId !== undefined) out.leadId = String(out.leadId);
  if (out.targetId !== undefined) out.targetId = String(out.targetId);
  if (Array.isArray(out.leadIds)) out.leadIds = out.leadIds.map(String);
  if (out.scope && Array.isArray(out.scope.leadIds)) out.scope = { ...out.scope, leadIds: out.scope.leadIds.map(String) };
  if (out.filter && out.filter.target_id !== undefined) out.filter = { ...out.filter, target_id: String(out.filter.target_id) };
  return out;
}

/**
 * JSON-fallback mode (Step 0 #4): when ZTech's AccountStore falls back to JSON files its
 * sql.js db is null, so lead intelligence cannot persist. Register every channel so the
 * renderer gets an explicit NOT_AVAILABLE answer instead of a missing handler, and create
 * no second storage.
 */
function registerUnavailableLeadIntelligenceIpc({ ipcMain, isTrustedSender, reason = 'Lead intelligence needs the database; the app is running in JSON fallback mode.' }) {
  const { CHANNELS } = require('./channels');
  const channels = Object.values(CHANNELS);
  for (const ch of channels) {
    ipcMain.handle(ch, async (event) => {
      if (!isTrustedSender(event)) return { ok: false, error: publicError(new ForbiddenError('Untrusted IPC sender')) };
      return { ok: false, error: { code: 'NOT_AVAILABLE', message: String(reason).slice(0, 200) } };
    });
  }
  return { channels, dispose() { for (const c of channels) ipcMain.removeHandler(c); } };
}

/** Remove internal job fields (options may contain a local file path). */
function publicRequestResult(r) {
  if (!r || !r.job) return r;
  const j = r.job;
  return {
    ...r,
    job: {
      job_id: j.job_id, lead_id: j.lead_id, provider_id: j.provider_id, requested_domain: j.requested_domain, state: j.state,
      last_error_code: j.last_error_code, last_error_message: j.last_error_message, created_at: j.created_at, updated_at: j.updated_at,
    },
  };
}

function sanitizePacketForRenderer(packet) {
  if (!packet) return null;
  const s = (v, max) => {
    if (typeof v !== 'string') return v;
    const r = sanitizeUntrusted(v, max);
    return r.flagged ? WITHHELD : r.text;
  };
  return {
    ...packet,
    facts: packet.facts.map((f) => ({ ...f, label: s(f.label, 300), value: s(f.value, 5000) })),
    findings: packet.findings.map((g) => ({ ...g, title: s(g.title, 300), observed: s(g.observed, 4000), recommendation: s(g.recommendation, 4000) })),
    strengths: packet.strengths.map((x) => ({ ...x, statement: s(x.statement, 1000) })),
  };
}

/** Enriched text values may come from third parties: withhold instruction-like text. */
function sanitizeEnrichmentProfile(profile) {
  const s = (v) => {
    if (typeof v !== 'string') return v;
    const r = sanitizeUntrusted(v, 1000);
    return r.flagged ? WITHHELD : r.text;
  };
  const fields = {};
  for (const [k, f] of Object.entries(profile.fields)) {
    fields[k] = {
      ...f,
      selected: f.selected ? { ...f.selected, value: s(f.selected.value) } : null,
      alternatives: f.alternatives.map((a) => ({ ...a, value: s(a.value) })),
    };
  }
  return { ...profile, fields };
}

/** JSON-safe copy with secret-like keys removed. */
function toSafe(data) {
  if (data === undefined) return null;
  return scrubSecrets(JSON.parse(JSON.stringify(data)));
}

/**
 * Default sender check: only the app's own top-level frame, loaded from an allowed
 * origin prefix (e.g. "file://" or "app://ztech"), may call these channels.
 */
function makeIsTrustedSender({ allowedUrlPrefixes }) {
  if (!Array.isArray(allowedUrlPrefixes) || !allowedUrlPrefixes.length) throw new TypeError('allowedUrlPrefixes is required');
  return (event) => {
    const frame = event && event.senderFrame;
    if (!frame || typeof frame.url !== 'string') return false;
    if (event.sender && event.sender.mainFrame && frame !== event.sender.mainFrame) return false;
    return allowedUrlPrefixes.some((p) => frame.url.startsWith(p));
  };
}

module.exports = { registerLeadIntelligenceIpc, registerUnavailableLeadIntelligenceIpc, makeIsTrustedSender, sanitizePacketForRenderer, normalizeIds };
