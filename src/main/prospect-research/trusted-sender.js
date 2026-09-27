'use strict';

// K.2 - trusted-sender check for the prospect-research IPC channels ONLY.
//
// The rule, as approved:
//   1. event.senderFrame must exist;
//   2. it must be the top frame of ZTech's own main window
//      (identity: event.senderFrame === mainWindow.webContents.mainFrame);
//   3. its URL must be a URL/file the app itself loads.
//
// Check 2 alone already excludes iframes, <webview>, child windows and devtools.
// Check 3 is defence in depth against a top frame that has navigated away.
//
// This file deliberately does NOT require('electron') and does NOT log: it is a
// pure predicate so it can be unit tested with a fake window. main.js injects the
// window getter and an onReject callback (wired to the existing logger).

const { pathToFileURL } = require('url');

const DEV_PORT_FALLBACK = 5173;

function normalizeUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol === 'file:') {
    let pathname = parsed.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {}
    return 'file:' + pathname.replace(/\\/g, '/');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/**
 * Build the trusted URL set from the two things the app actually loads.
 * Mirrors main.js createMainWindow(): dev -> the Vite server, prod -> index.html.
 */
function expectedWindowUrls(options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const urls = [];
  if (opts.isDev === true) {
    const port = (typeof opts.port === 'number' && Number.isInteger(opts.port) && opts.port > 0)
      ? opts.port
      : DEV_PORT_FALLBACK;
    urls.push('http://localhost:' + port);
  } else if (typeof opts.indexPath === 'string' && opts.indexPath !== '') {
    urls.push(pathToFileURL(opts.indexPath).href);
  }
  return urls.map(normalizeUrl).filter((u) => typeof u === 'string' && u !== '');
}

function isLiveWindow(win) {
  if (!win || typeof win !== 'object') return null;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return null;
  } catch {
    return null;
  }
  let wc = null;
  try {
    wc = win.webContents;
  } catch {
    return null;
  }
  if (!wc || typeof wc !== 'object') return null;
  try {
    if (typeof wc.isDestroyed === 'function' && wc.isDestroyed()) return null;
  } catch {
    return null;
  }
  if (!wc.mainFrame || typeof wc.mainFrame !== 'object') return null;
  return wc;
}

/**
 * The trusted set is fixed at construction: the dev server URL (localhost plus
 * VITE_PORT) in development, and the file URL of index.html in production. There is
 * deliberately no way to add to it later - in particular the live URL reported by
 * did-finish-load is NOT trusted, because a navigated frame must stay untrusted.
 * If a legitimate frame is rejected, fix the URL computation, not this allow-list.
 *
 * @param {() => (import('electron').BrowserWindow | null)} getWindow
 * @param {{ isDev?: boolean, port?: number, indexPath?: string,
 *           onReject?: (reason: string, detail: object) => void }} [options]
 * @returns {(event: any) => boolean}
 */
function createTrustedSender(getWindow, options) {
  const opts = (options && typeof options === 'object') ? options : {};
  const trusted = new Set(expectedWindowUrls(opts));
  const onReject = typeof opts.onReject === 'function' ? opts.onReject : null;

  function reject(reason, detail) {
    if (onReject) {
      try {
        onReject(reason, detail);
      } catch {}
    }
    return false;
  }

  return (event) => {
    if (!event || typeof event !== 'object') return reject('no-event', {});
    const frame = event.senderFrame;
    if (!frame || typeof frame !== 'object') return reject('no-sender-frame', {});

    let win = null;
    try {
      win = typeof getWindow === 'function' ? getWindow() : null;
    } catch {
      win = null;
    }
    const wc = isLiveWindow(win);
    if (!wc) return reject('no-main-window', {});

    if (frame !== wc.mainFrame) return reject('not-top-frame', {});

    const normalized = normalizeUrl(frame.url);
    if (!normalized) return reject('unparsable-url', {});
    if (!trusted.has(normalized)) return reject('untrusted-url', { url: normalized });

    return true;
  };
}

module.exports = {
  DEV_PORT_FALLBACK,
  createTrustedSender,
  expectedWindowUrls,
  normalizeUrl
};
