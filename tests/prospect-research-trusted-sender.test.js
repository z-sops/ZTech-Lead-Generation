'use strict';

// K.2 - trusted-sender check for the prospect-research IPC channels.
// The rule: event.senderFrame must be the top frame of ZTech's own main window,
// and that frame's URL must be a URL/file the app itself loads.

const path = require('path');
const assert = require('assert');

const { createTrustedSender, expectedWindowUrls, normalizeUrl, DEV_PORT_FALLBACK } =
  require(path.join(__dirname, '..', 'src', 'main', 'prospect-research', 'trusted-sender.js'));

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

const INDEX_PATH = path.join(__dirname, '..', 'index.html');
const INDEX_URL = 'file:///' + INDEX_PATH.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:');

function fakeWindow(topUrl, overrides) {
  const o = overrides || {};
  const mainFrame = { url: topUrl, name: 'main' };
  const wc = {
    mainFrame,
    isDestroyed: () => o.wcDestroyed === true
  };
  if (o.otherFrame) wc.otherFrame = { url: topUrl, name: 'other' };
  return {
    mainFrame,
    webContents: wc,
    isDestroyed: () => o.destroyed === true
  };
}

function collectRejections() {
  const seen = [];
  return { seen, onReject: (reason, detail) => seen.push({ reason, detail }) };
}

test('1. production: the top frame of the main window loading index.html is trusted', () => {
  const win = fakeWindow(INDEX_URL);
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), true, 'top frame accepted');
});

test('2. development: the top frame of the main window on the Vite port is trusted', () => {
  const win = fakeWindow('http://localhost:5173/');
  const isTrusted = createTrustedSender(() => win, { isDev: true, port: 5173 });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), true, 'dev top frame accepted');
});

test('3. an iframe is rejected even when it loads the app URL', () => {
  const win = fakeWindow(INDEX_URL, { otherFrame: true });
  const iframe = { url: INDEX_URL, name: 'research-frame' };
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH, onReject });
  assert.strictEqual(isTrusted({ senderFrame: iframe }), false, 'non-top frame rejected');
  assert.strictEqual(seen.length, 1, 'rejection was reported');
  assert.strictEqual(seen[0].reason, 'not-top-frame', 'rejection names the reason');
});

test('4. a null senderFrame is rejected', () => {
  const win = fakeWindow(INDEX_URL);
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH, onReject });
  assert.strictEqual(isTrusted({ senderFrame: null }), false, 'null frame rejected');
  assert.strictEqual(isTrusted({}), false, 'absent frame rejected');
  assert.strictEqual(isTrusted(null), false, 'absent event rejected');
  assert.deepStrictEqual(seen.map((r) => r.reason), ['no-sender-frame', 'no-sender-frame', 'no-event'], 'each rejection is logged');
});

test('5. the top frame on a different dev port is rejected', () => {
  const win = fakeWindow('http://localhost:3000/');
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: true, port: 5173, onReject });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'wrong port rejected');
  assert.strictEqual(seen[0].reason, 'untrusted-url', 'rejection names the reason');
});

test('6. a top frame on a non-http scheme (about:blank) is rejected', () => {
  const win = fakeWindow('about:blank');
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH, onReject });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'about:blank rejected');
  assert.strictEqual(seen[0].reason, 'unparsable-url', 'rejection names the reason');
});

test('7. a top frame that navigated to a remote origin is rejected', () => {
  const win = fakeWindow('https://evil.example.com/steal');
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'remote origin rejected');
});

test('8. a missing or destroyed main window rejects instead of throwing', () => {
  const isTrusted = createTrustedSender(() => null, { isDev: false, indexPath: INDEX_PATH });
  const win = fakeWindow(INDEX_URL);
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'null window rejected');
  const destroyed = createTrustedSender(() => fakeWindow(INDEX_URL, { destroyed: true }), { isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(destroyed({ senderFrame: fakeWindow(INDEX_URL).webContents.mainFrame }), false, 'destroyed window rejected');
  const deadWc = createTrustedSender(() => fakeWindow(INDEX_URL, { wcDestroyed: true }), { isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(deadWc({ senderFrame: fakeWindow(INDEX_URL).webContents.mainFrame }), false, 'destroyed webContents rejected');
  const throwing = createTrustedSender(() => { throw new Error('window gone'); }, { isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(throwing({ senderFrame: win.webContents.mainFrame }), false, 'a throwing getter rejects');
});

test('9. the trusted set is fixed: there is no way to widen it later', () => {
  // main.js loads exactly http://localhost:<VITE_PORT> in dev, so that is the
  // only dev URL that is trusted. A different path on the right port is still
  // refused rather than the allow-list being quietly widened.
  const win = fakeWindow('http://localhost:5173/');
  const isTrusted = createTrustedSender(() => win, { isDev: true, port: 9999 });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'a port not configured at construction is untrusted');
  // Per the approved rule, the did-finish-load URL is NOT trusted. Fixing a
  // legitimate rejection means fixing the URL computation, not the allow-list.
  assert.strictEqual(isTrusted.trust, undefined, 'no trust() escape hatch is exposed');
  assert.strictEqual(isTrusted.expected, undefined, 'the trusted set is not readable or mutable from outside');
  const onTheRightPort = createTrustedSender(() => win, { isDev: true, port: 5173 });
  assert.strictEqual(onTheRightPort({ senderFrame: win.webContents.mainFrame }), true, 'the URL the app actually loads is trusted');
  const otherPath = fakeWindow('http://localhost:5173/some/other/page');
  const strict = createTrustedSender(() => otherPath, { isDev: true, port: 5173 });
  assert.strictEqual(strict({ senderFrame: otherPath.webContents.mainFrame }), false, 'an unlisted path on the trusted port is refused');
});

test('10. query strings and hashes do not defeat the comparison', () => {
  const win = fakeWindow('http://localhost:5173/#/settings?tab=1');
  const isTrusted = createTrustedSender(() => win, { isDev: true, port: 5173 });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), true, 'hash/query ignored');
  assert.strictEqual(normalizeUrl('http://localhost:5173/'), 'http://localhost:5173', 'trailing slash normalized away');
});

test('11. expectedWindowUrls mirrors how main.js loads the window', () => {
  assert.deepStrictEqual(
    expectedWindowUrls({ isDev: true, port: 5173 }),
    ['http://localhost:5173'],
    'dev uses the Vite origin'
  );
  assert.deepStrictEqual(
    expectedWindowUrls({ isDev: true, port: undefined }),
    ['http://localhost:' + DEV_PORT_FALLBACK],
    'dev falls back to the default port'
  );
  const prod = expectedWindowUrls({ isDev: false, indexPath: INDEX_PATH });
  assert.strictEqual(prod.length, 1, 'prod yields exactly one URL');
  assert.ok(prod[0].startsWith('file:'), 'prod uses a file URL');
  assert.ok(prod[0].endsWith('/index.html'), 'prod points at index.html');
});

test('12. a rejected sender never echoes unparsable input back into the log detail', () => {
  const win = fakeWindow('not a url at all');
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH, onReject });
  assert.strictEqual(isTrusted({ senderFrame: win.webContents.mainFrame }), false, 'unparsable top-frame URL rejected');
  assert.strictEqual(seen.length, 1, 'rejection reported');
  assert.strictEqual(seen[0].reason, 'unparsable-url', 'reason is a fixed token');
  assert.strictEqual(seen[0].detail.url, undefined, 'unparsable input is not echoed');
});

test('13. the top-frame identity check runs before any URL parsing', () => {
  // A subframe must be refused even when it claims the app URL, so a crafted
  // URL can never be used to probe the trusted set.
  const win = fakeWindow(INDEX_URL);
  const impostor = { url: INDEX_URL };
  const { seen, onReject } = collectRejections();
  const isTrusted = createTrustedSender(() => win, { isDev: false, indexPath: INDEX_PATH, onReject });
  assert.strictEqual(isTrusted({ senderFrame: impostor }), false, 'impostor subframe rejected');
  assert.strictEqual(seen[0].reason, 'not-top-frame', 'identity is checked first');
});

for (const [name, fn] of tests) {
  try {
    fn();
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
