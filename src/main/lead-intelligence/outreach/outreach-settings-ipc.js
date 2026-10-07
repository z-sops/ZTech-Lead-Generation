'use strict';

const { assertValid } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { PROVIDERS } = require('./outreachSettings');

/**
 * F26 - Outreach Settings channels. Trusted sender only; every payload is a closed
 * object. Keys go in (set-key) and never come out. verify is a user-triggered,
 * read-only provider check that returns only { status, checkedAt, message }.
 *
 * The renderer names a CHANNEL ('email' | 'whatsapp'), never a provider id: which
 * provider serves a channel is main-process configuration (F24 rule O).
 */
const OUTREACH_SETTINGS_CHANNELS = Object.freeze({
  STATUS: 'outreach-settings:status',
  SAVE_BUSINESS: 'outreach-settings:save-business',
  SAVE_EMAIL: 'outreach-settings:save-email',
  SAVE_WHATSAPP: 'outreach-settings:save-whatsapp',
  SET_KEY: 'outreach-settings:set-key',
  CLEAR_KEY: 'outreach-settings:clear-key',
  VERIFY: 'outreach-settings:verify',
});

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = (max) => ({ type: 'string', maxLength: max });
const channel = { type: 'string', enum: ['email', 'whatsapp'] };
const CHANNEL_PROVIDER = Object.freeze({ email: PROVIDERS.resend, whatsapp: PROVIDERS.meta });

const OUTREACH_SETTINGS_SCHEMAS = Object.freeze({
  [OUTREACH_SETTINGS_CHANNELS.STATUS]: obj({}),
  [OUTREACH_SETTINGS_CHANNELS.SAVE_BUSINESS]: obj({
    representativeName: text(200), companyName: text(300), valueProposition: text(3000), callToAction: text(1000), postalAddress: text(800),
  }),
  [OUTREACH_SETTINGS_CHANNELS.SAVE_EMAIL]: obj({
    enabled: { type: 'boolean' }, fromName: text(300), fromAddress: text(320), replyTo: text(320), domain: text(253), signature: text(1000),
  }),
  [OUTREACH_SETTINGS_CHANNELS.SAVE_WHATSAPP]: obj({
    enabled: { type: 'boolean' }, fromNumber: text(40), phoneNumberId: text(120), businessAccountId: text(120),
  }),
  [OUTREACH_SETTINGS_CHANNELS.SET_KEY]: obj({ channel, key: { type: 'string', minLength: 1, maxLength: 2048 } }, ['channel', 'key']),
  [OUTREACH_SETTINGS_CHANNELS.CLEAR_KEY]: obj({ channel }, ['channel']),
  [OUTREACH_SETTINGS_CHANNELS.VERIFY]: obj({ channel }, ['channel']),
});

function registerOutreachSettingsIpc({ ipcMain, settings, isTrustedSender, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!settings || typeof settings.status !== 'function') throw new TypeError('outreach settings are required');
  const registered = [];
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertValid(OUTREACH_SETTINGS_SCHEMAS[channel], args, channel);
        const data = await fn(args);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        // The payload is never logged: it may carry a key.
        if (logger && logger.warn) logger.warn(`[outreach-settings] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };
  handle(OUTREACH_SETTINGS_CHANNELS.STATUS, () => settings.status());
  handle(OUTREACH_SETTINGS_CHANNELS.SAVE_BUSINESS, (a) => settings.saveBusiness(a));
  handle(OUTREACH_SETTINGS_CHANNELS.SAVE_EMAIL, (a) => settings.saveEmail(a));
  handle(OUTREACH_SETTINGS_CHANNELS.SAVE_WHATSAPP, (a) => settings.saveWhatsApp(a));
  handle(OUTREACH_SETTINGS_CHANNELS.SET_KEY, (a) => settings.setKey(CHANNEL_PROVIDER[a.channel], a.key));
  handle(OUTREACH_SETTINGS_CHANNELS.CLEAR_KEY, (a) => settings.clearKey(CHANNEL_PROVIDER[a.channel]));
  handle(OUTREACH_SETTINGS_CHANNELS.VERIFY, (a) => settings.verify(CHANNEL_PROVIDER[a.channel]));
  return registered;
}

module.exports = { OUTREACH_SETTINGS_CHANNELS, OUTREACH_SETTINGS_SCHEMAS, registerOutreachSettingsIpc };
