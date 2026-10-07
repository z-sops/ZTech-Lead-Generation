'use strict';

/**
 * F28 - the follow-up sequence IPC surface. Trusted sender only, closed schemas, {ok,data}.
 *
 *   lead-intel:sequence-create     { leadId, delays? }               a DRAFT from the lead's newest mailbox first email
 *   lead-intel:sequence-for-lead   { leadId }                        read
 *   lead-intel:sequence-list       {}                                read: open sequences + the Pause all switch
 *   lead-intel:sequence-activate   { sequenceId }                    every step approved -> the scheduler may send due steps
 *   lead-intel:sequence-pause      { sequenceId }                    write
 *   lead-intel:sequence-resume     { sequenceId, confirmNotSent? }   write (confirmNotSent after an unknown outcome)
 *   lead-intel:sequence-stop       { sequenceId }                    write, final
 *   lead-intel:sequence-pause-all  { paused }                        the global switch
 *
 * NO channel here sends anything or can make the scheduler send: a renderer cannot name a step to
 * send, a time, a recipient, a mailbox or any content. Step text is edited and approved through
 * the existing pitch-update / outreach-approve channels. No address crosses to the renderer.
 */

const { assertValid, S } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { assertNoDestination } = require('../opportunity/opportunity-ipc');
const { LIMITS } = require('./sequenceContract');

const SEQUENCE_CHANNELS_IPC = Object.freeze({
  CREATE: 'lead-intel:sequence-create',
  FOR_LEAD: 'lead-intel:sequence-for-lead',
  LIST: 'lead-intel:sequence-list',
  ACTIVATE: 'lead-intel:sequence-activate',
  PAUSE: 'lead-intel:sequence-pause',
  RESUME: 'lead-intel:sequence-resume',
  STOP: 'lead-intel:sequence-stop',
  PAUSE_ALL: 'lead-intel:sequence-pause-all',
});

const obj = (properties, required = []) => Object.freeze({ type: 'object', additionalProperties: false, required, properties });
const LEAD_ID = S.leadId;
const SEQUENCE_ID = { type: 'string', minLength: 12, maxLength: 68, pattern: /^seq_[A-Za-z0-9-]{8,64}$/ };

const SEQUENCE_SCHEMAS = Object.freeze({
  [SEQUENCE_CHANNELS_IPC.CREATE]: obj({
    leadId: LEAD_ID,
    delays: { type: 'array', minItems: 1, maxItems: LIMITS.MAX_STEPS, items: { type: 'integer', minimum: LIMITS.MIN_DELAY_DAYS, maximum: LIMITS.MAX_DELAY_DAYS } },
  }, ['leadId']),
  [SEQUENCE_CHANNELS_IPC.FOR_LEAD]: obj({ leadId: LEAD_ID }, ['leadId']),
  [SEQUENCE_CHANNELS_IPC.LIST]: obj({}),
  [SEQUENCE_CHANNELS_IPC.ACTIVATE]: obj({ sequenceId: SEQUENCE_ID }, ['sequenceId']),
  [SEQUENCE_CHANNELS_IPC.PAUSE]: obj({ sequenceId: SEQUENCE_ID }, ['sequenceId']),
  [SEQUENCE_CHANNELS_IPC.RESUME]: obj({ sequenceId: SEQUENCE_ID, confirmNotSent: { type: 'boolean' } }, ['sequenceId']),
  [SEQUENCE_CHANNELS_IPC.STOP]: obj({ sequenceId: SEQUENCE_ID }, ['sequenceId']),
  [SEQUENCE_CHANNELS_IPC.PAUSE_ALL]: obj({ paused: { type: 'boolean' } }, ['paused']),
});

function registerSequenceIpc({ ipcMain, sequences, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!sequences || typeof sequences.list !== 'function') throw new TypeError('sequence service is required');
  const handlers = {
    [SEQUENCE_CHANNELS_IPC.CREATE]: (a) => sequences.create({ leadId: a.leadId, delays: a.delays }),
    [SEQUENCE_CHANNELS_IPC.FOR_LEAD]: (a) => sequences.forLead({ leadId: a.leadId }),
    [SEQUENCE_CHANNELS_IPC.LIST]: () => sequences.list(),
    [SEQUENCE_CHANNELS_IPC.ACTIVATE]: (a) => sequences.activate({ sequenceId: a.sequenceId }),
    [SEQUENCE_CHANNELS_IPC.PAUSE]: (a) => sequences.pause({ sequenceId: a.sequenceId }),
    [SEQUENCE_CHANNELS_IPC.RESUME]: (a) => sequences.resume({ sequenceId: a.sequenceId, confirmNotSent: a.confirmNotSent === true }),
    [SEQUENCE_CHANNELS_IPC.STOP]: (a) => sequences.stop({ sequenceId: a.sequenceId }),
    [SEQUENCE_CHANNELS_IPC.PAUSE_ALL]: (a) => sequences.setPauseAll({ paused: a.paused }),
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertNoDestination(args, channel);
        assertValid(SEQUENCE_SCHEMAS[channel], args, channel);
        return { ok: true, data: await run(args) };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[sequences] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
  }
  return Object.keys(handlers);
}

module.exports = { registerSequenceIpc, SEQUENCE_CHANNELS_IPC, SEQUENCE_SCHEMAS };
