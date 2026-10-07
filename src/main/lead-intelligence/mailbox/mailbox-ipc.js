'use strict';

/**
 * F26.6 - the mailbox IPC surface. Trusted sender only, closed schemas, {ok,data}/{ok:false,error}.
 *
 *   lead-intel:mailbox-capabilities     {}                                   read
 *   lead-intel:mailbox-list          {}                                   read
 *   lead-intel:mailbox-connect       { provider }                         opens the system browser
 *   lead-intel:mailbox-disconnect    { mailboxId }                        write
 *   lead-intel:mailbox-default       { mailboxId }                        write
 *   lead-intel:mailbox-limits        { mailboxId, limits }                write
 *   lead-intel:mailbox-google-client { clientId, clientSecret } | { clear: true }   write-only
 *   lead-intel:market-rules          {}                                   read
 *   lead-intel:market-rule-set       { countryCode, rule, note }          write
 *   lead-intel:market-rule-remove    { countryCode }                      write
 *
 * WHAT CROSSES TO THE RENDERER: sanitized mailbox records (mailbox_id, provider, address,
 * display name, connection status, pacing status), provider capability states, and the Google
 * client ID (not a secret). NEVER a token, an auth code, a PKCE verifier or the client secret:
 * the secret is accepted one way, here, and never echoed. There is no send channel here.
 */

const { assertValid } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { assertNoDestination } = require('../opportunity/opportunity-ipc');
const { MAILBOX_PROVIDERS, MAILBOX_LIMITS, MARKET_RULES } = require('./mailboxContract');

const MAILBOX_CHANNELS_IPC = Object.freeze({
  CAPABILITIES: 'lead-intel:mailbox-capabilities',
  LIST: 'lead-intel:mailbox-list',
  CONNECT: 'lead-intel:mailbox-connect',
  DISCONNECT: 'lead-intel:mailbox-disconnect',
  DEFAULT: 'lead-intel:mailbox-default',
  LIMITS: 'lead-intel:mailbox-limits',
  GOOGLE_CLIENT: 'lead-intel:mailbox-google-client',
  MARKET_LIST: 'lead-intel:market-rules',
  MARKET_SET: 'lead-intel:market-rule-set',
  MARKET_REMOVE: 'lead-intel:market-rule-remove',
});

const obj = (properties, required = []) => Object.freeze({ type: 'object', additionalProperties: false, required, properties });
const MAILBOX_ID = { type: 'string', minLength: 12, maxLength: 68, pattern: /^mbx_[A-Za-z0-9-]{8,64}$/ };
const HHMM = { type: 'string', minLength: 5, maxLength: 5, pattern: /^([01]\d|2[0-3]):[0-5]\d$/ };
const COUNTRY = { type: 'string', minLength: 2, maxLength: 2, pattern: /^[A-Za-z]{2}$/ };

const MAILBOX_SCHEMAS = Object.freeze({
  [MAILBOX_CHANNELS_IPC.CAPABILITIES]: obj({}),
  [MAILBOX_CHANNELS_IPC.LIST]: obj({}),
  [MAILBOX_CHANNELS_IPC.CONNECT]: obj({ provider: { type: 'string', enum: [...MAILBOX_PROVIDERS] } }, ['provider']),
  [MAILBOX_CHANNELS_IPC.DISCONNECT]: obj({ mailboxId: MAILBOX_ID }, ['mailboxId']),
  [MAILBOX_CHANNELS_IPC.DEFAULT]: obj({ mailboxId: MAILBOX_ID }, ['mailboxId']),
  [MAILBOX_CHANNELS_IPC.LIMITS]: obj({
    mailboxId: MAILBOX_ID,
    limits: obj({
      dailyCap: { type: 'integer', minimum: 1, maximum: MAILBOX_LIMITS.DAILY_MAX },
      hourlyCap: { type: 'integer', minimum: 1, maximum: MAILBOX_LIMITS.HOURLY_MAX },
      minGapSeconds: { type: 'integer', minimum: MAILBOX_LIMITS.MIN_GAP_MIN, maximum: MAILBOX_LIMITS.MIN_GAP_MAX },
      windowStart: HHMM,
      windowEnd: HHMM,
      windowDays: { type: 'string', minLength: 1, maxLength: 13, pattern: /^[0-6](,[0-6]){0,6}$/ },
      timeZone: { type: 'string', minLength: 1, maxLength: 64, pattern: /^[A-Za-z][A-Za-z0-9_+\-/]{0,63}$/ },
    }),
  }, ['mailboxId', 'limits']),
  [MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT]: obj({
    clientId: { type: 'string', minLength: 30, maxLength: 240, pattern: /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/ },
    clientSecret: { type: 'string', minLength: 8, maxLength: 200, pattern: /^\S+$/ },
    clear: { type: 'boolean', enum: [true] },
  }),
  [MAILBOX_CHANNELS_IPC.MARKET_LIST]: obj({}),
  [MAILBOX_CHANNELS_IPC.MARKET_SET]: obj({
    countryCode: COUNTRY,
    rule: { type: 'string', enum: [...MARKET_RULES] },
    note: { type: 'string', minLength: 3, maxLength: 500 },
  }, ['countryCode', 'rule', 'note']),
  [MAILBOX_CHANNELS_IPC.MARKET_REMOVE]: obj({ countryCode: COUNTRY }, ['countryCode']),
});

function registerMailboxIpc({ ipcMain, mailboxes, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!mailboxes || typeof mailboxes.list !== 'function') throw new TypeError('mailbox service is required');
  const handlers = {
    [MAILBOX_CHANNELS_IPC.CAPABILITIES]: () => mailboxes.providers(),
    [MAILBOX_CHANNELS_IPC.LIST]: () => mailboxes.list(),
    [MAILBOX_CHANNELS_IPC.CONNECT]: (a) => mailboxes.connect({ provider: a.provider }),
    [MAILBOX_CHANNELS_IPC.DISCONNECT]: (a) => mailboxes.disconnect({ mailboxId: a.mailboxId }),
    [MAILBOX_CHANNELS_IPC.DEFAULT]: (a) => mailboxes.setDefault({ mailboxId: a.mailboxId }),
    [MAILBOX_CHANNELS_IPC.LIMITS]: (a) => mailboxes.setLimits({ mailboxId: a.mailboxId, limits: a.limits }),
    [MAILBOX_CHANNELS_IPC.GOOGLE_CLIENT]: (a) => {
      if (a.clear === true) {
        if (a.clientId !== undefined || a.clientSecret !== undefined) throw new ForbiddenError('Either clear or set the Google client, not both');
        return mailboxes.clearGoogleClient();
      }
      return mailboxes.setGoogleClient({ clientId: a.clientId, clientSecret: a.clientSecret });
    },
    [MAILBOX_CHANNELS_IPC.MARKET_LIST]: () => mailboxes.marketRules(),
    [MAILBOX_CHANNELS_IPC.MARKET_SET]: (a) => mailboxes.setMarketRule({ countryCode: a.countryCode, rule: a.rule, note: a.note }),
    [MAILBOX_CHANNELS_IPC.MARKET_REMOVE]: (a) => mailboxes.removeMarketRule({ countryCode: a.countryCode }),
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertNoDestination(args, channel);
        assertValid(MAILBOX_SCHEMAS[channel], args, channel);
        return { ok: true, data: await run(args) };
      } catch (e) {
        // The code only: never the input (it may hold the client secret) and never remote text.
        if (logger && logger.warn) logger.warn(`[mailbox] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
  }
  return Object.values(MAILBOX_CHANNELS_IPC);
}

module.exports = { MAILBOX_CHANNELS_IPC, MAILBOX_SCHEMAS, registerMailboxIpc };
