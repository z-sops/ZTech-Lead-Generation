'use strict';

/**
 * F29 - the Reply Router IPC surface. Trusted sender only, closed schemas, {ok,data}.
 *
 *   lead-intel:reply-routes         { category?, show? }        read: the Replies list
 *   lead-intel:reply-route-confirm  { eventId, category }       the human confirms / corrects a category
 *   lead-intel:reply-route-lead     { leadId }                  read: the drawer's suggestion + Away note
 *
 * NO channel here sends, drafts, schedules, suppresses, permits or records a reply review: a
 * category is only a suggestion. No text (subject, snippet, body) and no address crosses to the
 * renderer - ids, closed codes, times and the lead's name only.
 */

const { assertValid, S } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { assertNoDestination } = require('../opportunity/opportunity-ipc');
const { REPLY_CATEGORIES } = require('./replyRouteContract');

const REPLY_ROUTER_CHANNELS_IPC = Object.freeze({
  LIST: 'lead-intel:reply-routes',
  CONFIRM: 'lead-intel:reply-route-confirm',
  FOR_LEAD: 'lead-intel:reply-route-lead',
});

const obj = (properties, required = []) => Object.freeze({ type: 'object', additionalProperties: false, required, properties });
const CATEGORY = { type: 'string', enum: REPLY_CATEGORIES };
const EVENT_ID = { type: 'string', minLength: 43, maxLength: 43, pattern: /^gm_[0-9a-f]{40}$/ };

const REPLY_ROUTER_SCHEMAS = Object.freeze({
  [REPLY_ROUTER_CHANNELS_IPC.LIST]: obj({ category: CATEGORY, show: { type: 'string', enum: ['pending', 'all'] } }),
  [REPLY_ROUTER_CHANNELS_IPC.CONFIRM]: obj({ eventId: EVENT_ID, category: CATEGORY }, ['eventId', 'category']),
  [REPLY_ROUTER_CHANNELS_IPC.FOR_LEAD]: obj({ leadId: S.leadId }, ['leadId']),
});

function registerReplyRouterIpc({ ipcMain, replyRouter, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!replyRouter || typeof replyRouter.list !== 'function') throw new TypeError('reply router is required');
  const handlers = {
    [REPLY_ROUTER_CHANNELS_IPC.LIST]: (a) => replyRouter.list({ category: a.category === undefined ? null : a.category, show: a.show || 'pending' }),
    [REPLY_ROUTER_CHANNELS_IPC.CONFIRM]: (a) => replyRouter.confirm({ eventId: a.eventId, category: a.category }),
    [REPLY_ROUTER_CHANNELS_IPC.FOR_LEAD]: (a) => replyRouter.forLead({ leadId: a.leadId }),
  };
  for (const [channel, run] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertNoDestination(args, channel);
        assertValid(REPLY_ROUTER_SCHEMAS[channel], args, channel);
        return { ok: true, data: await run(args) };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[reply-router] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
  }
  return Object.keys(handlers);
}

module.exports = { registerReplyRouterIpc, REPLY_ROUTER_CHANNELS_IPC, REPLY_ROUTER_SCHEMAS };
