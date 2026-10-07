'use strict';

/**
 * F26.5 - the trust IPC surface. Five channels, trusted sender only, closed schemas.
 *
 *   lead-intel:trust-lead      { leadId }                                          read
 *   lead-intel:trust-suppress  { leadId, channel, reason, scope? }                 write
 *   lead-intel:trust-lift      { leadId, channel, suppressionId }                  write
 *   lead-intel:trust-consent   { leadId, channel, method, consentedAt, evidenceNote } write
 *   lead-intel:trust-handoff   { pitchId, kind }                                   mail app / copy
 *
 * WHAT THE RENDERER CAN NEVER SAY: an address, a recipient_ref, a recorder, a source, an
 * event, a relay URL or secret, or "they replied". Addresses come from the stored lead in the
 * main process; the recorder is the operator; relay events arrive only from the relay client.
 * The handoff is NOT a send channel: it opens the person's own mail app (mailto only) or
 * copies the text, and records OUTREACH_HANDOFF_CREATED - never a send.
 */

const { assertValid, S } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { assertNoDestination } = require('../opportunity/opportunity-ipc');
const { CONSENT_METHODS, TRUST_LIMITS } = require('./trustContract');

const TRUST_CHANNELS_IPC = Object.freeze({
  LEAD: 'lead-intel:trust-lead',
  SUPPRESS: 'lead-intel:trust-suppress',
  LIFT: 'lead-intel:trust-lift',
  CONSENT: 'lead-intel:trust-consent',
  HANDOFF: 'lead-intel:trust-handoff',
});

const CHANNEL = { type: 'string', enum: ['email', 'whatsapp'] };
const obj = (properties, required) => Object.freeze({ type: 'object', additionalProperties: false, required, properties });

const TRUST_SCHEMAS = Object.freeze({
  [TRUST_CHANNELS_IPC.LEAD]: obj({ leadId: S.leadId }, ['leadId']),
  [TRUST_CHANNELS_IPC.SUPPRESS]: obj({
    leadId: S.leadId, channel: CHANNEL,
    reason: { type: 'string', enum: ['unsubscribe', 'manual'] },
    scope: { type: 'string', enum: ['global', 'workspace'] },
  }, ['leadId', 'channel', 'reason']),
  [TRUST_CHANNELS_IPC.LIFT]: obj({
    leadId: S.leadId, channel: CHANNEL,
    suppressionId: { type: 'string', minLength: 5, maxLength: 80, pattern: /^sup_[A-Za-z0-9-]{1,76}$/ },
  }, ['leadId', 'channel', 'suppressionId']),
  [TRUST_CHANNELS_IPC.CONSENT]: obj({
    leadId: S.leadId, channel: CHANNEL,
    method: { type: 'string', enum: [...CONSENT_METHODS] },
    consentedAt: { type: 'string', minLength: 10, maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/ },
    evidenceNote: { type: 'string', minLength: 3, maxLength: TRUST_LIMITS.EVIDENCE_NOTE_MAX },
  }, ['leadId', 'channel', 'method', 'consentedAt', 'evidenceNote']),
  [TRUST_CHANNELS_IPC.HANDOFF]: obj({
    pitchId: { type: 'string', minLength: 3, maxLength: 120, pattern: /^[A-Za-z0-9_.:-]+$/ },
    kind: { type: 'string', enum: ['mailto', 'copy'] },
  }, ['pitchId', 'kind']),
});

function registerTrustIpc({ ipcMain, trust, outreach, isTrustedSender, copyText = null, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!trust || typeof trust.leadTrust !== 'function') throw new TypeError('trust service is required');
  const handlers = {
    [TRUST_CHANNELS_IPC.LEAD]: (a) => trust.leadTrust({ leadId: String(a.leadId) }),
    [TRUST_CHANNELS_IPC.SUPPRESS]: (a) => trust.suppressLead({ leadId: String(a.leadId), channel: a.channel, reason: a.reason, scope: a.scope || 'global' }),
    [TRUST_CHANNELS_IPC.LIFT]: (a) => trust.liftSuppression({ leadId: String(a.leadId), channel: a.channel, suppressionId: a.suppressionId }),
    [TRUST_CHANNELS_IPC.CONSENT]: (a) => trust.recordConsent({ leadId: String(a.leadId), channel: a.channel, method: a.method, consentedAt: a.consentedAt, evidenceNote: a.evidenceNote }),
    [TRUST_CHANNELS_IPC.HANDOFF]: async (a) => {
      if (!outreach || typeof outreach.handoff !== 'function') throw new ForbiddenError('Handoff is unavailable');
      const r = await outreach.handoff({ pitchId: a.pitchId, kind: a.kind });
      let copied = false;
      if (a.kind === 'copy' && typeof copyText === 'function') {
        await copyText(r.body);
        copied = true;
      }
      // The body never crosses to the renderer: main opened it (mailto) or copied it. It can carry
      // the personal unsubscribe link, whose recipient_ref the renderer must never receive.
      return { kind: r.kind, to: r.to, subject: r.subject, copied, mailtoTooLong: r.mailtoTooLong, sent: false, headersGuaranteed: false, headerNote: r.headerNote };
    },
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertNoDestination(args, channel);
        assertValid(TRUST_SCHEMAS[channel], args, channel);
        return { ok: true, data: await run(args) };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[trust] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
  }
  return Object.values(TRUST_CHANNELS_IPC);
}

module.exports = { TRUST_CHANNELS_IPC, TRUST_SCHEMAS, registerTrustIpc };
