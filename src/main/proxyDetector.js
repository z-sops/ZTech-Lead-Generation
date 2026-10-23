'use strict';

const { execFile } = require('child_process');
const net = require('net');

const COMMON_PROXY_PORTS = [7890, 7891, 7897, 1080, 10809, 8080, 10808, 2080];
const TCP_TIMEOUT_MS = 1000;
const VALIDATE_TIMEOUT_MS = 3000;

// WhatsApp connectivity target (product-specific).
// This is NOT a generic proxy health endpoint: a pass here means only that
// the proxy can CONNECT to web.whatsapp.com:443. It does not prove that
// every destination, CoreClaw, or any particular network path is reachable.
const WHATSAPP_CONNECT_HOST = 'web.whatsapp.com';
const WHATSAPP_CONNECT_PORT = 443;

async function detectSystemProxy() {
  try {
    const regPath = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
    const enableValue = await regQuery(regPath, 'ProxyEnable');
    if (enableValue !== '0x1' && enableValue !== '1') return null;
    const proxyServer = await regQuery(regPath, 'ProxyServer');
    if (!proxyServer) return null;
    return parseRegistryProxyServer(proxyServer);
  } catch {
    return null;
  }
}

function regQuery(regPath, valueName) {
  return new Promise((resolve) => {
    execFile('reg', ['query', regPath, '/v', valueName], { timeout: 3000 }, (err, stdout) => {
      if (err || !stdout) { resolve(null); return; }
      const match = stdout.match(new RegExp(`${valueName}\\s+REG_(?:SZ|DWORD)\\s+(.+)`, 'i'));
      resolve(match ? match[1].trim() : null);
    });
  });
}

function parseRegistryProxyServer(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('=')) {
    return trimmed.includes('://') ? trimmed : `http://${trimmed}`;
  }
  const parts = trimmed.split(';').map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const [protocol, addr] = part.split('=');
    if (!addr) continue;
    const p = protocol.toLowerCase();
    if (p === 'http' || p === 'https') return `http://${addr}`;
    if (p === 'socks') return `socks5://${addr}`;
  }
  const first = parts[0];
  if (first && first.includes('=')) {
    const addr = first.split('=')[1];
    if (addr) return `http://${addr}`;
  }
  return null;
}

function tcpConnect(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, TCP_TIMEOUT_MS);
    socket.connect(port, host, () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  });
}

// Validates the WhatsApp target before it is placed into the CONNECT request.
// Rejects CRLF injection, non-hostname schemes, credentials, and bad ports.
function buildWhatsAppConnectRequest(host = WHATSAPP_CONNECT_HOST, port = WHATSAPP_CONNECT_PORT) {
  if (typeof host !== 'string' || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`;
}

// Concept B: WhatsApp connectivity through the proxy.
// Pass = the proxy answered CONNECT web.whatsapp.com:443 with a reply containing 200.
// This is NOT a generic proxy-health label and NOT CoreClaw reachability.
function testWhatsAppConnect(proxyHost, proxyPort) {
  return new Promise((resolve) => {
    const request = buildWhatsAppConnectRequest();
    if (!request) {
      resolve({ proxyConfigured: false, whatsappReachable: false });
      return;
    }
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ proxyConfigured: false, whatsappReachable: false });
    }, VALIDATE_TIMEOUT_MS);
    socket.connect(proxyPort, proxyHost, () => {
      socket.write(request);
    });
    socket.once('data', (data) => {
      clearTimeout(timer);
      socket.destroy();
      const text = data.toString();
      const whatsappReachable = text.includes('200');
      const httpShaped = /^HTTP\/1\.[01] \d{3}/.test(text.trimStart());
      resolve({ proxyConfigured: whatsappReachable || httpShaped, whatsappReachable });
    });
    socket.on('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ proxyConfigured: false, whatsappReachable: false });
    });
  });
}

async function validateProxy(proxyUrl) {
  try {
    const url = new URL(proxyUrl.includes('://') ? proxyUrl : `http://${proxyUrl}`);
    const host = url.hostname || '127.0.0.1';
    const port = Number(url.port) || (url.protocol === 'socks5:' ? 1080 : 8080);
    if (url.protocol === 'socks5:') {
      const greetingOk = await validateSocks5(host, port);
      return { proxyConfigured: greetingOk, whatsappReachable: null };
    }
    return await testWhatsAppConnect(host, port);
  } catch {
    return { proxyConfigured: false, whatsappReachable: false };
  }
}

function validateSocks5(host, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, VALIDATE_TIMEOUT_MS);
    socket.connect(port, host, () => { socket.write(Buffer.from([0x05, 0x01, 0x00])); });
    socket.once('data', (data) => {
      clearTimeout(timer); socket.destroy();
      resolve(data.length >= 2 && data[0] === 0x05);
    });
    socket.on('error', () => { clearTimeout(timer); socket.destroy(); resolve(false); });
  });
}

async function scanCommonPorts() {
  const results = await Promise.all(
    COMMON_PROXY_PORTS.map(async (port) => (await tcpConnect(port)) ? port : null)
  );
  const openPorts = results.filter(p => p !== null);
  let whatsappFailedCandidate = null;
  for (const port of openPorts) {
    const httpCheck = await validateProxy(`http://127.0.0.1:${port}`);
    if (httpCheck.proxyConfigured && httpCheck.whatsappReachable === true) {
      return { proxyUrl: `http://127.0.0.1:${port}`, whatsappReachable: true };
    }
    if (httpCheck.proxyConfigured && httpCheck.whatsappReachable === false && !whatsappFailedCandidate) {
      whatsappFailedCandidate = `http://127.0.0.1:${port}`;
    }
    const socksCheck = await validateProxy(`socks5://127.0.0.1:${port}`);
    if (socksCheck.proxyConfigured) {
      return { proxyUrl: `socks5://127.0.0.1:${port}`, whatsappReachable: null };
    }
  }
  if (whatsappFailedCandidate) {
    return { proxyUrl: whatsappFailedCandidate, whatsappReachable: false };
  }
  return null;
}

async function autoDetectProxy() {
  const systemProxy = await detectSystemProxy();
  if (systemProxy) {
    const check = await validateProxy(systemProxy);
    if (check.proxyConfigured && check.whatsappReachable !== false) {
      return { source: 'registry', proxyUrl: systemProxy, proxyConfigured: true, whatsappReachable: check.whatsappReachable };
    }
    const scanned = await scanCommonPorts();
    if (scanned) {
      return { source: 'portscan', proxyUrl: scanned.proxyUrl, proxyConfigured: true, whatsappReachable: scanned.whatsappReachable };
    }
    return { source: 'registry', proxyUrl: systemProxy, proxyConfigured: true, whatsappReachable: false };
  }
  const scanned = await scanCommonPorts();
  if (scanned) {
    return { source: 'portscan', proxyUrl: scanned.proxyUrl, proxyConfigured: true, whatsappReachable: scanned.whatsappReachable };
  }
  return { source: null, proxyUrl: null, proxyConfigured: false, whatsappReachable: false };
}

module.exports = {
  detectSystemProxy,
  scanCommonPorts,
  validateProxy,
  autoDetectProxy,
  buildWhatsAppConnectRequest
};
