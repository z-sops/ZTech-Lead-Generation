'use strict';

const { assertValid, S } = require('./core/validate');
const { publicError, ForbiddenError } = require('./core/errors');
const { scrubSecrets } = require('./core/objects');
const { PITCH_LIST_MAX_LIMIT, PITCH_LIST_MAX_OFFSET, ACTIVITY_MAX_LIMIT, ACTIVITY_MAX_OFFSET } = require('./persistence/contract');

/**
 * The six — and only six — A10 Lead Intelligence channels reachable by the renderer.
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
  OUTREACH_LIST: 'lead-intel:outreach-list',
  // F15: the ONE read-only activity channel. There is deliberately no activity WRITE
  // channel: activity rows are produced only by trusted backend transitions, never by
  // the renderer.
  OUTREACH_ACTIVITY: 'lead-intel:outreach-activity',
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
  // F12 Batch 2: pitch enumeration. Structurally validated only - `status` is
  // deliberately typed as a plain string here rather than given a second enum, because
  // the authoritative list of persisted pitch statuses lives in ONE place,
  // PITCH_STATUSES in persistence/contract.js, and OutreachService.list delegates to it.
  // Duplicating the list in this schema would let the two drift apart. Bounds are
  // imported from the same module so they cannot drift either. additionalProperties:false
  // is what stops a client-supplied sort field, ORDER BY or SQL fragment.
  [CHANNELS.OUTREACH_LIST]: obj({
    limit: { type: 'integer', minimum: 1, maximum: PITCH_LIST_MAX_LIMIT },
    offset: { type: 'integer', minimum: 0, maximum: PITCH_LIST_MAX_OFFSET },
    status: { type: 'string', minLength: 1, maxLength: 40 },
  }),
  // F15: activity history. Read-only and bounded, exactly like outreach:list. Both
  // filters are optional but only ONE id may be supplied, so a caller cannot smuggle an
  // unbounded cross-join; the bounds come from the same contract module so they cannot
  // drift from the store's own clamp. additionalProperties:false stops a sort field,
  // ORDER BY or SQL fragment, and there is no field-selection or type filter, so the
  // renderer can only ask "the next page of the ledger".
  [CHANNELS.OUTREACH_ACTIVITY]: {
    type: 'object',
    additionalProperties: false,
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: ACTIVITY_MAX_LIMIT },
      offset: { type: 'integer', minimum: 0, maximum: ACTIVITY_MAX_OFFSET },
      leadId: { type: 'string', minLength: 1, maxLength: 100 },
      pitchId: { type: 'string', minLength: 1, maxLength: 100 },
    },
  },
});

function registerOutreachIpc({ ipcMain, outreach, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!outreach || typeof outreach.generate !== 'function') throw new TypeError('outreach service is required');
  // F12 Batch 2: outreach:list is registered unconditionally, so refuse to start unless
  // the service can actually serve it. Failing here is far better than a channel that
  // throws only on its first invoke.
  if (typeof outreach.list !== 'function') throw new TypeError('outreach service must implement list');

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
  // F12 Batch 2: read-only enumeration of persisted pitch drafts. Only the three
  // reviewed paging/filter fields cross this boundary - no sort, no field selection and
  // no ordering choice is accepted from the renderer, so the store's fixed
  // `updated_at DESC, pitch_id DESC` ordering is the only order that can be requested.
  handle(CHANNELS.OUTREACH_LIST, (a) => outreach.list({ limit: a.limit, offset: a.offset, status: a.status }));
  // F15: read-only activity history. Read-only is the point - the renderer has no way to
  // create, edit or delete an activity row, because no such channel exists.
  handle(CHANNELS.OUTREACH_ACTIVITY, (a) => outreach.activityList({
    limit: a.limit, offset: a.offset, leadId: a.leadId, pitchId: a.pitchId
  }));

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
