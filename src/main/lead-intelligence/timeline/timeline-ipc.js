'use strict';

const { assertValid, S } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { assertNoDestination } = require('../opportunity/opportunity-ipc');
const { SOURCES, TIMELINE_LIMITS } = require('./LeadTimeline');

/**
 * I6 - one READ channel for the unified lead timeline. Trusted sender only; a closed
 * payload of { leadId, limit?, before?, sources? }. There is no write, no URL, no
 * credential and no provider anywhere on this channel.
 */
const TIMELINE_CHANNEL = 'lead-intel:timeline';

const ISO = { type: 'string', minLength: 10, maxLength: 40, pattern: /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/ };

const TIMELINE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['leadId'],
  properties: {
    leadId: S.leadId,
    limit: { type: 'integer', minimum: 1, maximum: TIMELINE_LIMITS.PAGE_MAX },
    before: {
      type: 'object',
      additionalProperties: false,
      required: ['at', 'event_id'],
      properties: {
        at: ISO,
        event_id: { type: 'string', minLength: 3, maxLength: 200, pattern: /^[a-z]+:[A-Za-z0-9_.:-]+$/ },
        source: { type: 'string', enum: [...SOURCES] },
      },
    },
    sources: { type: 'array', maxItems: SOURCES.length, items: { type: 'string', enum: [...SOURCES] } },
  },
});

function registerTimelineIpc({ ipcMain, timeline, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!timeline || typeof timeline.forLead !== 'function') throw new TypeError('timeline is required');
  ipcMain.handle(TIMELINE_CHANNEL, async (event, input) => {
    try {
      if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
      const args = input === undefined ? {} : input;
      assertNoDestination(args, TIMELINE_CHANNEL);
      assertValid(TIMELINE_SCHEMA, args, TIMELINE_CHANNEL);
      const data = await timeline.forLead(args.leadId, { limit: args.limit, before: args.before || null, sources: args.sources || null });
      return { ok: true, data };
    } catch (e) {
      if (logger && logger.warn) logger.warn(`[lead-timeline] ${TIMELINE_CHANNEL} refused: ${(e && e.code) || 'ERROR'}`);
      return { ok: false, error: publicError(e) };
    }
  });
  return [TIMELINE_CHANNEL];
}

module.exports = { TIMELINE_CHANNEL, TIMELINE_SCHEMA, registerTimelineIpc };
