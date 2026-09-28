'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

(async () => {
  const root = path.join(__dirname, '..');
  const detectorPath = path.join(root, 'src', 'main', 'proxyDetector.js');
  const detectorSrc = fs.readFileSync(detectorPath, 'utf8');
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(root, 'src', 'renderer', 'renderer.js'), 'utf8');
  const clientSrc = fs.readFileSync(path.join(root, 'src', 'main', 'coreClawClient.js'), 'utf8');
  const detector = require(detectorPath);

  const count = (src, n) => src.split(n).length - 1;
  function region(src, start, end) {
    const s = src.indexOf(start);
    assert.ok(s !== -1, `missing marker: ${start}`);
    const e = src.indexOf(end, s + start.length);
    return src.slice(s, e === -1 ? undefined : e);
  }

  test('1. web.whatsapp.com remains as the explicit WhatsApp connectivity target', () => {
    assert.ok(detectorSrc.includes("const WHATSAPP_CONNECT_HOST = 'web.whatsapp.com';"), 'target constant retained');
    assert.ok(detectorSrc.includes('const WHATSAPP_CONNECT_PORT = 443;'), 'target port retained');
    assert.strictEqual(count(detectorSrc, 'web.whatsapp.com'), 3, 'only constant definition + 2 explanatory comments');
    assert.ok(count(detectorSrc, 'WHATSAPP_CONNECT_HOST') >= 2, 'host constant referenced');
    assert.ok(count(detectorSrc, 'WHATSAPP_CONNECT_PORT') >= 2, 'port constant referenced');
    assert.ok(detectorSrc.includes('WhatsApp connectivity target'), 'target explicitly named in code');
  });

  test('2. HTTP CONNECT uses web.whatsapp.com:443 built from the validated target', () => {
    const expected = 'CONNECT web.whatsapp.com:443 HTTP/1.1\r\nHost: web.whatsapp.com:443\r\n\r\n';
    assert.strictEqual(detector.buildWhatsAppConnectRequest(), expected, 'builder must emit exact WhatsApp CONNECT');
    assert.strictEqual(count(detectorSrc, 'CONNECT ${host}:${port} HTTP/1.1'), 1, 'single CONNECT template');
    assert.strictEqual(count(detectorSrc, 'Host: ${host}:${port}'), 1, 'single Host template');
    assert.ok(detectorSrc.includes('function testWhatsAppConnect('), 'WhatsApp-specific test function exists');
  });

  test('3. WhatsApp target validated before CONNECT: no CRLF, scheme, credentials, bad port', () => {
    assert.strictEqual(detector.buildWhatsAppConnectRequest('web.whatsapp.com\r\nX-Injected: 1', 443), null, 'CRLF rejected');
    assert.strictEqual(detector.buildWhatsAppConnectRequest('http://evil.example', 443), null, 'scheme rejected');
    assert.strictEqual(detector.buildWhatsAppConnectRequest('user:pass@host.example', 443), null, 'credentials rejected');
    assert.strictEqual(detector.buildWhatsAppConnectRequest('web.whatsapp.com', 0), null, 'port 0 rejected');
    assert.strictEqual(detector.buildWhatsAppConnectRequest('web.whatsapp.com', 70000), null, 'port >65535 rejected');
    assert.strictEqual(detector.buildWhatsAppConnectRequest('web.whatsapp.com', '443'), null, 'non-integer port rejected');
    assert.notStrictEqual(detector.buildWhatsAppConnectRequest('ok.example.com', 443), null, 'valid hostname accepted');
    assert.ok(!detector.buildWhatsAppConnectRequest().includes('@'), 'default CONNECT carries no credentials');
  });

  test('4. Result semantics distinguish WhatsApp reachability from proxy syntax and generic health', async () => {
    assert.ok(detectorSrc.includes('This is NOT a generic proxy health endpoint'), 'generic-health conflation documented as removed');
    assert.ok(!/proxyHealth|isHealthy|healthCheck|internetReachable/i.test(detectorSrc), 'no generic proxy-health label');
    const res = await detector.validateProxy('');
    assert.deepStrictEqual(res, { proxyConfigured: false, whatsappReachable: false }, 'validateProxy returns explicit object semantics');
    assert.strictEqual(count(detectorSrc, 'whatsappReachable'), 22, 'whatsappReachable field used throughout detection');
    assert.strictEqual(count(detectorSrc, 'source: null, proxyUrl: null, proxyConfigured: false, whatsappReachable: false'), 1, 'explicit no-proxy fallback shape');
    const syntaxRegion = region(mainSrc, 'function validateProxyUrl', 'async function applyProxyConfiguration');
    assert.ok(!syntaxRegion.includes('proxyDetector') && !syntaxRegion.includes('validateProxy('), 'concept A (validateProxyUrl) remains syntax-only');
    assert.ok(detectorSrc.includes('whatsappReachable: null'), 'SOCKS5 reports WhatsApp as not-tested (null)');
  });

  test('5. Detector never calls session.setProxy()', () => {
    assert.strictEqual(count(detectorSrc, 'setProxy'), 0, 'no proxy application in detector');
    assert.strictEqual(count(mainSrc, 'autoDetectProxy()'), 1, 'single caller: proxy:detect handler');
    assert.strictEqual(count(mainSrc, "require('./src/main/proxyDetector')"), 1, 'detector required only by proxy:detect');
    assert.strictEqual(count(mainSrc, "ipcMain.handle('proxy:detect'"), 1, 'proxy:detect handler unchanged');
    assert.ok(rendererSrc.includes('window.appAPI.proxy.detect()'), 'renderer entry unchanged');
  });

  test('6. Settings save and startup proxy behavior unchanged', () => {
    const saveRegion = region(mainSrc, "ipcMain.handle('settings:save'", 'ipcMain.handle(');
    assert.ok(!saveRegion.includes('proxyDetector') && !saveRegion.includes('autoDetectProxy'), 'settings:save does not use detector');
    assert.ok(mainSrc.includes('applyProxyConfiguration(storedProxyUrl)'), 'startup applies stored proxy directly');
    assert.ok(mainSrc.includes("session.defaultSession.setProxy(proxyRules ? { proxyRules } : { mode: 'direct' })"), 'setProxy/direct mode unchanged');
    assert.ok(mainSrc.includes('return result || { source: null, proxyUrl: null };'), 'proxy:detect fallback unchanged');
    assert.ok(preloadSrc.includes("detect: () => ipcRenderer.invoke('proxy:detect')"), 'preload passthrough unchanged');
  });

  test('7. proxyApplied behavior unchanged (P10-L2 compatible)', () => {
    assert.ok(mainSrc.includes('return { success: true, proxyApplied: proxyResult.applied };'), 'proxyApplied response byte-identical');
    assert.ok(mainSrc.includes("const proxyRules = proxyUrl ? validateProxyUrl(proxyUrl) : '';"), 'apply path still syntax-only');
    assert.ok(clientSrc.includes("electron.net && typeof electron.net.fetch === 'function'"), 'CoreClaw still uses session-level net.fetch');
  });

  test('8. SOCKS5 existing behavior unchanged', () => {
    assert.ok(detectorSrc.includes('Buffer.from([0x05, 0x01, 0x00])'), 'greeting bytes unchanged');
    assert.ok(detectorSrc.includes('data.length >= 2 && data[0] === 0x05'), 'greeting pass criterion unchanged');
    assert.strictEqual(count(detectorSrc, 'whatsappReachable: null'), 2, 'socks paths report whatsapp as not-tested');
    const socksRegion = region(detectorSrc, 'function validateSocks5', 'async function scanCommonPorts');
    assert.ok(socksRegion.includes('socket.connect(port, host'), 'socks5 connect unchanged');
    assert.ok(socksRegion.includes('VALIDATE_TIMEOUT_MS'), 'socks5 timeout unchanged');
    assert.ok(!detectorSrc.includes('retry'), 'no retry behavior introduced');
    assert.ok(detectorSrc.includes('const TCP_TIMEOUT_MS = 1000;'), 'port-scan timeout unchanged');
    assert.ok(detectorSrc.includes('const VALIDATE_TIMEOUT_MS = 3000;'), 'validation timeout unchanged');
    assert.ok(detectorSrc.includes('const COMMON_PROXY_PORTS = [7890, 7891, 7897, 1080, 10809, 8080, 10808, 2080];'), 'port list unchanged');
  });

  test('9. No arbitrary replacement domain exists', () => {
    assert.ok(!/\b(google|baidu|github|cloudflare|example|yahoo|bing|qq)\./i.test(detectorSrc), 'no replacement probe domains');
    const urls = detectorSrc.match(/https?:\/\/[^\s'"`)]+/g) || [];
    const external = urls.filter(u => !u.includes('${') && !u.startsWith('http://127.0.0.1'));
    assert.deepStrictEqual(external, [], 'literal URLs must be loopback-only or template-built');
    assert.ok(urls.some(u => u.startsWith('http://127.0.0.1')), 'port-scan loopback target retained');
    assert.ok(!detectorSrc.includes('fetch('), 'no HTTP-fetch probe introduced');
  });

  test('10. No China-specific branching exists', () => {
    assert.ok(!/china|geolocation|geoip|gfw|tencent|baidu|whitelist|latitude/i.test(detectorSrc), 'no China/geo branching');
    assert.ok(!detectorSrc.includes('86'), 'no +86 country-code logic');
    assert.ok(!detectorSrc.includes('locale') && !detectorSrc.includes('region'), 'no locale/region branching');
  });

  test('11. No secrets exposed', () => {
    assert.ok(!detectorSrc.includes('logger'), 'detector logs nothing');
    assert.ok(!/\b(apiKey|taskKey|password|secret|token)\b/i.test(detectorSrc), 'no credential material in detector');
    const detectRegion = region(rendererSrc, "getElementById('btn-detect-proxy')", "getElementById('btn-export-logs')");
    assert.ok(!detectRegion.includes('apiKey') && !detectRegion.includes('taskKey'), 'detect handler touches no credentials');
  });

  test('12. Renderer reports the three distinct detection states', () => {
    const detectRegion = region(rendererSrc, "getElementById('btn-detect-proxy')", "getElementById('btn-export-logs')");
    assert.ok(detectRegion.includes('result.whatsappReachable === false'), 'state: proxy found, WhatsApp failed');
    assert.ok(detectRegion.includes('Proxy detected, but the WhatsApp connectivity check failed: '), 'distinct WhatsApp-failed toast');
    assert.ok(detectRegion.includes('result.whatsappReachable === true'), 'state: proxy found, WhatsApp passed');
    assert.ok(detectRegion.includes('Proxy detected, WhatsApp connectivity check passed: '), 'distinct WhatsApp-passed toast');
    assert.ok(detectRegion.includes('No usable proxy detected'), 'state: no system proxy detected (unchanged)');
    assert.ok(detectRegion.includes('Proxy detected: '), 'original detected-text retained for WhatsApp-not-tested (SOCKS5)');
    assert.ok(detectRegion.includes("getElementById('settings-proxy-url').value = result.proxyUrl"), 'detected proxy still fills the settings field');
  });

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log('ok - ' + name);
    } catch (err) {
      failed++;
      console.log('FAIL - ' + name);
      console.log(String((err && err.stack) || err));
    }
  }

  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log(String((err && err.stack) || err));
  process.exit(1);
});
