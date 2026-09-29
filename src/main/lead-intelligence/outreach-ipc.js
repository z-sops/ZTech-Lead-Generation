'use strict';

const { assertValid, S } = require('./core/validate');
const { publicError, ForbiddenError } = require('./core/errors');
const { scrubSecrets } = require('./core/objects');

/**
 * The five — and only five — A10 Lead Intelligence channels.
 *
 * `lead-intel:email-send` is deliberately NOT here. The email provider stays
 * abstract in this phase, so no send path exists to register: OutreachService
 * keeps its EMAIL_DISABLED default and no renderer surface can reach one.
 */
const CHANNELS = Object.freeze({
  PITCH_GENERATE: 'lead-intel:pitch-generate',
  PITCH_GET: 'lead-intel:pitch-get',
  PITCH_UPDATE: 'lead-intel:pitch-update',
  OUTREACH_APPROVE: 'lead-intel:outreach-approve',
  OUTREACH_GATE: 'lead-intel:outreach-gate',
});

/**
 * Input schemas. These reuse the module's SHIPPED id bounds (S.id / S.leadId)
 * rather than inventing looser ones, and every object is additionalProperties:false
 * so the renderer cannot smuggle a path, a URL, a provider id or a credential.
 */
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pitchId = S.id;

const INPUT_SCHEMAS = Object.freeze({
  [CHANNELS.PITCH_GENERATE]: obj({ leadId: S.leadId, targetId: S.leadId }, ['leadId']),
  [CHANNELS.PITCH_GET]: obj({ leadId: S.leadId, pitchId }, ['leadId']),
  [CHANNELS.PITCH_UPDATE]: obj({
    pitchId,
    subject: { type: 'string', maxLength: 150 },
    opening: { type: 'string', maxLength: 600 },
    valueProposition: { type: 'string', maxLength: 1200 },
    callToAction: { type: 'string', maxLength: 400 },
    removeObservations: { type: 'array', maxItems: 10, items: { type: 'integer', minimum: 0, maximum: 9 } },
  }, ['pitchId']),
  [CHANNELS.OUTREACH_APPROVE]: obj({ pitchId }, ['pitchId']),
  [CHANNELS.OUTREACH_GATE]: obj({ pitchId, channel: { type: 'string', enum: ['email'] } }, ['pitchId']),
});

function registerOutreachIpc({ ipcMain, outreach, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!outreach || typeof outreach.generate !== 'function') throw new TypeError('outreach service is required');

  const registered = [];

  const handle = (channel, fn) => {
    const schema = INPUT_SCHEMAS[channel];
    if (!schema) throw new Error(`No input schema for ${channel}`);
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertValid(schema, args, channel);
        const data = await fn(normalizeIds(args));
        return { ok: true, data: toSafe(data) };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[lead-intelligence] ${channel} failed: ${e && e.code ? e.code : 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };

  handle(CHANNELS.PITCH_GENERATE, (a) => outreach.generate({ leadId: a.leadId, targetId: a.targetId }));
  handle(CHANNELS.PITCH_GET, async (a) => {
    if (a.pitchId) {
      const p = await outreach.get(a.pitchId);
      return p && p.lead_id === a.leadId ? p : null;
    }
    return outreach.latestForLead(a.leadId);
  });
  handle(CHANNELS.PITCH_UPDATE, (a) => outreach.update({
    pitchId: a.pitchId,
    edits: { subject: a.subject, opening: a.opening, valueProposition: a.valueProposition, callToAction: a.callToAction, removeObservations: a.removeObservations },
  }));
  handle(CHANNELS.OUTREACH_APPROVE, (a) => outreach.approve({ pitchId: a.pitchId }));
  handle(CHANNELS.OUTREACH_GATE, (a) => outreach.gate({ pitchId: a.pitchId, channel: a.channel || 'email' }));

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
  if (out.pitchId !== undefined) out.pitchId = String(out.pitchId);
  if (Array.isArray(out.removeObservations)) out.removeObservations = out.removeObservations.map(Number);
  return out;
}

function toSafe(data) {
  if (data === undefined) return null;
  return scrubSecrets(JSON.parse(JSON.stringify(data)));
}

module.exports = { registerOutreachIpc, CHANNELS, INPUT_SCHEMAS };