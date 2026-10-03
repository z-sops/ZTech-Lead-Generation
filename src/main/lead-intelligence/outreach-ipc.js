'use strict';

const { assertValid, S } = require('./core/validate');
const { publicError, ForbiddenError } = require('./core/errors');
const { scrubSecrets } = require('./core/objects');
const { PITCH_LIST_MAX_LIMIT, PITCH_LIST_MAX_OFFSET, ACTIVITY_MAX_LIMIT, ACTIVITY_MAX_OFFSET, READY_PAGE_MAX_LIMIT, READY_SCAN_MAX } = require('./persistence/contract');

/**
 * The Lead Intelligence channels reachable by the renderer. Every one of them is a read,
 * or an explicit human-triggered transition, EXCEPT the single F19 send boundary - which is
 * the only channel here that can put an outbound message on the wire.
 *
 * F19 history, kept because the reasoning matters more than the outcome: `lead-intel:email-send`
 * was deliberately absent for many phases while the provider stayed abstract. F19 registers a
 * send channel, but under three constraints that keep the earlier safety property intact:
 *   - its input is EXACTLY { pitchId }. No recipient, from, subject, body, provider or channel
 *     can be supplied by the renderer, so every one of those is re-derived in the main process.
 *   - it is refused unless a LIVE provider and a valid from-address are configured, so the
 *     default build still cannot send anything at all.
 *   - the OutreachGate is re-run immediately before the provider is contacted.
 * There is still no batch, queue, schedule, retry-loop, campaign, unsubscribe or
 * provider-configuration channel, and no second send channel.
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
  // F16: the derived Ready queue. Read-only like every other channel here: there is no
  // ready write, no send channel and no provider channel.
  OUTREACH_READY: 'lead-intel:outreach-ready',
  // F18: the ONE read-only preparation channel. It derives a channel-neutral preview for
  // ONE pitch from data that already exists (the gate verdict, the F17 contact facts and
  // the canonical pitch text). It writes nothing, sends nothing and records no activity:
  // there is deliberately no prepare-write channel and no channel choice beyond the two
  // factual ones, so the renderer can never ask for a channel the contact facts do not
  // support.
  OUTREACH_PREPARE: 'lead-intel:outreach-prepare',
  // F19: the single send boundary - the ONLY channel in the product that can put an
  // outbound message on the wire. It is human-triggered, one message at a time, and it
  // re-runs the OutreachGate, the idempotency check and the recipient lookup inside the
  // main process immediately before contacting a provider.
  //
  // There is deliberately still NO batch, queue, schedule, retry-loop, campaign or
  // unsubscribe channel, and no second send channel for another provider.
  OUTREACH_SEND: 'lead-intel:outreach-send',
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
  // F16: the derived Ready queue. Three bounded integers and nothing else.
  // additionalProperties:false stops a sort field, an ORDER BY, a SQL fragment or a
  // channel name. There is no `total` to ask for and no way to request the whole table:
  // `scanLimit` caps how many gates ONE call may evaluate, so the main process can never
  // be talked into an unbounded scan.
  [CHANNELS.OUTREACH_READY]: {
    type: 'object',
    additionalProperties: false,
    properties: {
      cursor: { type: 'integer', minimum: 0, maximum: PITCH_LIST_MAX_OFFSET },
      limit: { type: 'integer', minimum: 1, maximum: READY_PAGE_MAX_LIMIT },
      scanLimit: { type: 'integer', minimum: 1, maximum: READY_SCAN_MAX },
    },
  },
  // F18: preparation for ONE pitch, on ONE factual channel. The channel is a closed
  // enum (the renderer cannot invent a third channel or pass a provider name) and
  // additionalProperties:false means a payload can carry nothing else - no recipient
  // override, no body override, no path, no credential. The recipient always comes from
  // the stored contact facts in the main process, never from the caller.
  [CHANNELS.OUTREACH_PREPARE]: obj({
    pitchId,
    channel: { type: 'string', enum: ['email', 'whatsapp'] },
  }, ['pitchId', 'channel']),
  // F19: the send boundary. This is the ONLY channel in the entire product that can cause
  // an outbound message, and its input is deliberately the smallest possible:
  //
  //   - exactly ONE property: pitchId. The renderer cannot pass a recipient, a from
  //     address, a subject, a body, a provider, a channel or a template, because
  //     additionalProperties:false refuses all of them and no other property is defined.
  //   - NO channel parameter. F19 ships email only, so the channel is not a choice the
  //     renderer can make; the service decides. F20 adds WhatsApp at the service layer,
  //     behind the same closed payload, rather than by widening what the renderer may say.
  //
  // So the renderer can ask "send the approved pitch for this id, to whoever the stored
  // contact facts say" and can express nothing else. Everything that determines WHO is
  // contacted and WHAT is said is re-derived in the main process at send time.
  [CHANNELS.OUTREACH_SEND]: obj({ pitchId }, ['pitchId']),
});

function registerOutreachIpc({ ipcMain, outreach, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!outreach || typeof outreach.generate !== 'function') throw new TypeError('outreach service is required');
  // F12 Batch 2: outreach:list is registered unconditionally, so refuse to start unless
  // the service can actually serve it. Failing here is far better than a channel that
  // throws only on its first invoke.
  if (typeof outreach.list !== 'function') throw new TypeError('outreach service must implement list');
  // F19: the send channel is registered unconditionally too, so it gets the same treatment.
  // Without this, a build whose service predates F19 would start cleanly and then throw an
  // opaque TypeError the first time a human tried to send an email.
  if (typeof outreach.sendEmail !== 'function') throw new TypeError('outreach service must implement sendEmail');

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
  // F16: read-only. The renderer can ask "what is ready right now?" and nothing else: it
  // cannot write readiness, cannot trigger a send, and cannot reach a provider.
  handle(CHANNELS.OUTREACH_READY, (a) => outreach.ready({ cursor: a.cursor, limit: a.limit, scanLimit: a.scanLimit }));
  // F18: read-only preparation of ONE ready pitch on ONE factual channel. The response is
  // a preview derived from stored data; nothing is sent, queued or recorded.
  handle(CHANNELS.OUTREACH_PREPARE, (a) => outreach.prepare({ pitchId: a.pitchId, channel: a.channel }));

  // F19: the send boundary. One pitch, one human action, no caller-supplied content.
  // Everything else - gate re-check, idempotency, recipient, body - is re-derived in the
  // main process. The result reports provider ACKNOWLEDGEMENT only; delivery, open and
  // click are reported as 'unknown' because nothing here observes an inbox.
  handle(CHANNELS.OUTREACH_SEND, (a) => outreach.sendEmail({ pitchId: a.pitchId }));

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
