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
 *   - its input is EXACTLY { pitchId, channel } (F25). No recipient, from, subject, body or
 *     provider can be supplied by the renderer - those are all re-derived in the main
 *     process - and `channel` is a required closed enum ('email' | 'whatsapp'): the explicit
 *     channel a human reviewed, dispatched to that channel's boundary ONLY, with no fallback.
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
  // F25: the payload now carries ONE additional property - the EXPLICIT channel enum,
  // email or whatsapp: the reviewed tab a human just confirmed, dispatched to the
  // selected boundary only. No quote or apostrophe may be added to this comment - the F18
  // suite parses this block with a naive single-quote regex, and one stray quote silently
  // swallows the declarations that follow it. There is deliberately still NO batch,
  // queue, schedule, retry-loop, campaign or unsubscribe channel, and no second send
  // channel for another provider: the dispatcher never falls back to the other channel.
  OUTREACH_SEND: 'lead-intel:outreach-send',
  // F21: read-only send history. F19/F20 already wrote a durable row per send attempt but
  // nothing could read one back, so a provider call that happened was unauditable. This
  // channel is the read. It is NOT a second send path: the payload is paging plus at most
  // one id filter, so it can neither name a recipient, a provider, a channel nor a payload,
  // and there is deliberately still no channel here that can retry, queue or reschedule
  // anything - a further attempt must go back through OUTREACH_SEND above.
  OUTREACH_SENDS: 'lead-intel:outreach-sends',
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
  // F19/F25: the send boundary. This is the ONLY channel in the entire product that can
  // cause an outbound message, and its input is deliberately the smallest possible:
  //
  //   - exactly TWO properties: pitchId and channel. The renderer cannot pass a recipient,
  //     a from address, a subject, a body, a provider or a template, because
  //     additionalProperties:false refuses all of them and no other property is defined.
  //   - the channel is a CLOSED enum ('email' | 'whatsapp'), required, never defaulted. It
  //     is the one choice F25 deliberately moves to the renderer: the Prepare tab a human
  //     reviewed IS the channel sent, and the service dispatches to that channel's existing
  //     boundary ONLY - with no fallback to the other channel in either direction.
  //
  // So the renderer can ask "send the approved pitch for this id, on the channel I name, to
  // whoever the stored contact facts say" and can express nothing else. Everything that
  // determines WHO is contacted and WHAT is said is re-derived in the main process at send
  // time; the channel is the only intent that crosses this line.
  [CHANNELS.OUTREACH_SEND]: obj({
    pitchId,
    channel: { type: 'string', enum: ['email', 'whatsapp'] },
  }, ['pitchId', 'channel']),
  // F21: read-only send history. Deliberately the same narrow shape as the F15 activity
  // channel - paging integers plus an optional id filter, additionalProperties:false - so the
  // renderer cannot smuggle a sort field, an ORDER BY, a SQL fragment, a column list, a
  // provider name or a state filter. The store's own fixed `created_at DESC, send_id DESC`
  // ordering is therefore the only order obtainable, and the bounds come from the same
  // contract module so they cannot drift from the store's clamp.
  //
  // Note the contrast with the Ready queue's schema just above, which must stay free of any
  // row count because its queue is DERIVED and a derived count would be an approximation. A
  // send ledger is a real table, so its count is an exact COUNT(*) and the handler returns
  // it. The word is kept out of this comment so the Ready schema's own check cannot be
  // confused by prose sitting next to it.
  [CHANNELS.OUTREACH_SENDS]: {
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
  // F19/F20: the send channel is registered unconditionally, so it gets the same treatment.
  // Without this, a build whose service predates F19/F20 would start cleanly and then throw an
  // opaque TypeError the first time a human tried to send.
  if (typeof outreach.send !== 'function') throw new TypeError('outreach service must implement send');
  // The channel-specific boundaries are what `send` delegates to, so a service that
  // implements send() without them would fail on the first human send instead of at
  // registration, where the error is still actionable.
  if (typeof outreach.sendEmail !== 'function') throw new TypeError('outreach service must implement sendEmail');
  if (typeof outreach.sendWhatsApp !== 'function') throw new TypeError('outreach service must implement sendWhatsApp');
  // F21: same reasoning for the read-only send history - a build whose service predates F21
  // would otherwise start cleanly and throw an opaque TypeError the first time someone opened
  // a pitch's history.
  if (typeof outreach.sendList !== 'function') throw new TypeError('outreach service must implement sendList');

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

  // F19/F20/F25: the send boundary. One pitch, ONE EXPLICIT CHANNEL, one human action, no
  // caller-supplied content. Everything else - gate re-check, idempotency, recipient, body -
  // is re-derived in the main process. The result reports provider ACKNOWLEDGEMENT only;
  // delivery, open and click are reported as 'unknown' because nothing here observes an
  // inbox.
  //
  // F25: the channel comes from the payload but only after the schema has already refused
  // anything outside the closed enum, and the service dispatches to that channel's existing
  // boundary and nowhere else. There is NO automatic fallback in either direction: if the
  // selected channel's capability is unavailable the call fails closed with that channel's
  // own factual refusal rather than contacting the lead somewhere else. An unknown channel
  // never reaches a provider - the service throws before any boundary runs.
  handle(CHANNELS.OUTREACH_SEND, (a) => outreach.send({ pitchId: a.pitchId, channel: a.channel }));

  // F21: read-only send history. The renderer can ask "what send attempts are recorded for
  // this pitch" and nothing else. It cannot write a row, mark one accepted, delete one, or
  // trigger another attempt from here - the send boundary above is the only way out of this.
  handle(CHANNELS.OUTREACH_SENDS, (a) => outreach.sendList({
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
