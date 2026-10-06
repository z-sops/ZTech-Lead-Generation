'use strict';

const { assertValid } = require('../core/validate');
const { publicError, ForbiddenError } = require('../core/errors');
const { MODES } = require('./OpportunityServiceSupervisor');

/**
 * I4 - Opportunity Intelligence service channels.
 *
 *   oi-service:choose-folder  (no payload)  main opens a native folder dialog; returns { ok, folderName, reason }
 *   oi-service:set-mode       { mode }      managed | external | off
 *   oi-service:start / stop / restart       (no payload)
 *   oi-service:copy-log       (no payload)  main writes the REDACTED log to the clipboard; returns { ok, lines }
 *
 * The renderer never supplies a path, port, URL, command or environment value, and
 * never receives one: every answer is the supervisor's healthView() or a basename.
 */
const OI_SERVICE_CHANNELS = Object.freeze({
  CHOOSE_FOLDER: 'oi-service:choose-folder',
  SET_MODE: 'oi-service:set-mode',
  START: 'oi-service:start',
  STOP: 'oi-service:stop',
  RESTART: 'oi-service:restart',
  COPY_LOG: 'oi-service:copy-log',
});

const empty = { type: 'object', properties: {}, required: [], additionalProperties: false };
const OI_SERVICE_SCHEMAS = Object.freeze({
  [OI_SERVICE_CHANNELS.CHOOSE_FOLDER]: empty,
  [OI_SERVICE_CHANNELS.SET_MODE]: { type: 'object', properties: { mode: { type: 'string', enum: [...MODES] } }, required: ['mode'], additionalProperties: false },
  [OI_SERVICE_CHANNELS.START]: empty,
  [OI_SERVICE_CHANNELS.STOP]: empty,
  [OI_SERVICE_CHANNELS.RESTART]: empty,
  [OI_SERVICE_CHANNELS.COPY_LOG]: empty,
});

/**
 * @param {object} p
 * @param {object} p.ipcMain
 * @param {object} p.supervisor         OpportunityServiceSupervisor
 * @param {Function} p.isTrustedSender
 * @param {Function} p.pickFolder       async () => absolute path | null  (native dialog, main only)
 * @param {Function} p.copyText         (text) => void                    (clipboard, main only)
 */
function registerOiServiceIpc({ ipcMain, supervisor, isTrustedSender, pickFolder, copyText, logger = console }) {
  if (typeof isTrustedSender !== 'function') throw new TypeError('isTrustedSender is required');
  if (!supervisor || typeof supervisor.healthView !== 'function') throw new TypeError('supervisor is required');
  const registered = [];
  const handle = (channel, fn) => {
    ipcMain.handle(channel, async (event, input) => {
      try {
        if (!isTrustedSender(event)) throw new ForbiddenError('Untrusted IPC sender');
        const args = input === undefined ? {} : input;
        assertValid(OI_SERVICE_SCHEMAS[channel], args, channel);
        const data = await fn(args);
        return { ok: true, data: data === undefined ? null : data };
      } catch (e) {
        if (logger && logger.warn) logger.warn(`[opportunity-intelligence] ${channel} refused: ${(e && e.code) || 'ERROR'}`);
        return { ok: false, error: publicError(e) };
      }
    });
    registered.push(channel);
  };

  handle(OI_SERVICE_CHANNELS.CHOOSE_FOLDER, async () => {
    const folder = typeof pickFolder === 'function' ? await pickFolder() : null;
    if (!folder) return { ok: false, folderName: null, reason: 'No folder was chosen.', service: supervisor.healthView() };
    const r = await supervisor.setFolder(folder);
    return { ok: r.ok, folderName: r.folderName, reason: r.reason, service: supervisor.healthView() };
  });
  handle(OI_SERVICE_CHANNELS.SET_MODE, (a) => supervisor.setMode(a.mode));
  handle(OI_SERVICE_CHANNELS.START, () => supervisor.userStart());
  handle(OI_SERVICE_CHANNELS.STOP, () => supervisor.userStop());
  handle(OI_SERVICE_CHANNELS.RESTART, () => supervisor.userRestart());
  handle(OI_SERVICE_CHANNELS.COPY_LOG, () => {
    const text = supervisor.logText();
    if (typeof copyText === 'function') copyText(text);
    return { ok: true, lines: text ? text.split('\n').length : 0 };
  });
  return registered;
}

module.exports = { OI_SERVICE_CHANNELS, OI_SERVICE_SCHEMAS, registerOiServiceIpc };
