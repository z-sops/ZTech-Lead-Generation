'use strict';

const { assertValid } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { SECRET_IDS, SETTING_IDS } = require('./oiProviderConfig');

/**
 * I3 - write-only Opportunity Intelligence configuration channels.
 *
 *   oi-config:status       -> { providers:{<id>:{stored, readable, reported}}, settings, linkedin, service }
 *   oi-config:set-key      { provider, key } -> { ok, stored:true }   (the key is never echoed)
 *   oi-config:clear-key    { provider }      -> { ok, stored:false }
 *   oi-config:set-setting  { name, value }   -> { ok, value }          (non-secret settings only)
 *
 * No channel returns a key, a token, a port, a path or a URL. Every payload is a closed
 * object (additionalProperties:false) and the provider/setting ids are closed enums.
 */
const OI_CONFIG_CHANNELS = Object.freeze({
  STATUS: 'oi-config:status',
  SET_KEY: 'oi-config:set-key',
  CLEAR_KEY: 'oi-config:clear-key',
  SET_SETTING: 'oi-config:set-setting',
});

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const OI_CONFIG_SCHEMAS = Object.freeze({
  [OI_CONFIG_CHANNELS.STATUS]: obj({}),
  [OI_CONFIG_CHANNELS.SET_KEY]: obj({
    provider: { type: 'string', enum: [...SECRET_IDS] },
    key: { type: 'string', minLength: 1, maxLength: 512 },
  }, ['provider', 'key']),
  [OI_CONFIG_CHANNELS.CLEAR_KEY]: obj({ provider: { type: 'string', enum: [...SECRET_IDS] } }, ['provider']),
  [OI_CONFIG_CHANNELS.SET_SETTING]: obj({
    name: { type: 'string', enum: [...SETTING_IDS] },
    value: { type: 'string', maxLength: 500 },
  }, ['name', 'value']),
});

/**
 * @param {object} p
 * @param {object} p.ipcMain
 * @param {object} p.config            createOiProviderConfig(...) result
 * @param {Function} p.isTrustedSender
 * @param {Function} [p.serviceView]   () => renderer-safe service state (supervisor.healthView())
 * @param {Function} [p.reported]      () => OI `/v1/engine` configuration (booleans) or null
 */
function registerOiConfigIpc({ ipcMain, config, isTrustedSender, serviceView = () => null, reported = () => null, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!config || typeof config.status !== 'function') throw new TypeError('OI provider config is required');
  const registered = [];
  const handle = (channel, fn) => {
    const schema = OI_CONFIG_SCHEMAS[channel];
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertValid(schema, args, channel);
        const data = await fn(args);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        // Never log the payload: it may carry a key.
        if (logger && logger.warn) logger.warn(`[opportunity-intelligence] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };

  handle(OI_CONFIG_CHANNELS.STATUS, () => {
    let rep = null;
    let svc = null;
    try { rep = reported(); } catch { rep = null; }
    try { svc = serviceView(); } catch { svc = null; }
    return { ...config.status({ reported: rep }), service: svc };
  });
  handle(OI_CONFIG_CHANNELS.SET_KEY, (a) => config.setKey(a.provider, a.key));
  handle(OI_CONFIG_CHANNELS.CLEAR_KEY, (a) => config.clearKey(a.provider));
  handle(OI_CONFIG_CHANNELS.SET_SETTING, (a) => config.setSetting(a.name, a.value));
  return registered;
}

module.exports = { OI_CONFIG_CHANNELS, OI_CONFIG_SCHEMAS, registerOiConfigIpc };
