'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const viteConfig = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');

const EXPECTED_PRODUCTION_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'";

function listFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

let passed = 0;
let failed = 0;
const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

test('1. index.html contains a Content-Security-Policy definition', () => {
  const match = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.ok(match, 'CSP meta tag present');
  assert.ok(match[1].includes("default-src 'self'"), 'default-src present');
});

test('2. production CSP contains no Vite websocket allowance', () => {
  assert.ok(!indexHtml.includes('ws://'), 'no ws:// in index.html');
  assert.ok(!indexHtml.includes('localhost:5173'), 'no localhost:5173 in index.html');
  const match = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.ok(match, 'CSP meta tag present');
  assert.ok(!match[1].includes('ws:'), 'connect-src has no websocket scheme');
});

test('3. all other CSP directives remain byte-identical', () => {
  const match = indexHtml.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)">/);
  assert.ok(match, 'CSP meta tag present');
  assert.strictEqual(match[1], EXPECTED_PRODUCTION_CSP, 'production CSP exactly as expected');
});

test('4. vite.config.js contains a serve-only transformIndexHtml plugin', () => {
  const applyIdx = viteConfig.indexOf("apply: 'serve'");
  const transformIdx = viteConfig.indexOf('transformIndexHtml');
  assert.ok(applyIdx > -1, "apply: 'serve' present");
  assert.ok(transformIdx > -1, 'transformIndexHtml present');
  assert.ok(applyIdx < transformIdx, "apply: 'serve' declared in the same plugin before transform");
  assert.strictEqual(viteConfig.split('transformIndexHtml').length - 1, 1, 'exactly one transformIndexHtml');
  assert.ok(!viteConfig.includes("apply: 'build'"), 'no build-time application');
});

test('5. development injection targets connect-src \'self\'', () => {
  assert.ok(viteConfig.includes("\"connect-src 'self'\""), 'replace targets the connect-src token');
  assert.ok(viteConfig.includes('connect-src \'self\' ${devWsOrigin}'), 'injection appends dev ws origin to connect-src');
  assert.ok(viteConfig.includes('process.env.VITE_PORT || 5173'), 'port follows existing VITE_PORT behavior (default 5173)');
});

test('6. websocket allowance exists only under apply:serve in vite.config.js', () => {
  const wsCount = viteConfig.split('ws://').length - 1;
  assert.strictEqual(wsCount, 1, 'exactly one ws:// origin declaration in vite.config.js');
  assert.ok(viteConfig.includes('ws://localhost:${process.env.VITE_PORT || 5173}'), 'origin uses existing VITE_PORT behavior (default 5173)');

  const pluginsKeyIdx = viteConfig.indexOf('plugins: [');
  assert.ok(pluginsKeyIdx > -1, 'plugins array present');
  const openBracket = viteConfig.indexOf('[', pluginsKeyIdx);
  let arrDepth = 0;
  let arrEnd = -1;
  for (let i = openBracket; i < viteConfig.length; i++) {
    if (viteConfig[i] === '[') arrDepth++;
    else if (viteConfig[i] === ']') {
      arrDepth--;
      if (arrDepth === 0) { arrEnd = i; break; }
    }
  }
  assert.ok(arrEnd > openBracket, 'plugins array structurally closed');
  const pluginsText = viteConfig.slice(openBracket, arrEnd + 1);
  assert.ok(!pluginsText.includes('const devWsOrigin'), 'origin is declared at module scope, not inside plugin logic');

  const applyIdx = pluginsText.indexOf("apply: 'serve'");
  assert.ok(applyIdx > -1, "a plugin declares apply: 'serve'");
  const objStart = pluginsText.lastIndexOf('{', applyIdx);
  let objDepth = 0;
  let objEnd = -1;
  for (let i = objStart; i < pluginsText.length; i++) {
    if (pluginsText[i] === '{') objDepth++;
    else if (pluginsText[i] === '}') {
      objDepth--;
      if (objDepth === 0) { objEnd = i; break; }
    }
  }
  assert.ok(objEnd > applyIdx, 'serve-only plugin object located by brace matching');
  const pluginBlock = pluginsText.slice(objStart, objEnd + 1);

  assert.ok(pluginBlock.includes("apply: 'serve'"), 'located object is the serve-only plugin');
  assert.ok(pluginBlock.includes('transformIndexHtml'), 'transformIndexHtml lives in that same serve-only plugin');
  assert.ok(pluginBlock.includes('devWsOrigin'), 'serve-only plugin consumes the websocket origin');
  assert.ok(!pluginBlock.includes('const devWsOrigin'), 'plugin only consumes, never declares');

  const totalRefs = viteConfig.split('devWsOrigin').length - 1;
  const inPluginRefs = pluginBlock.split('devWsOrigin').length - 1;
  assert.strictEqual(totalRefs, 2, 'devWsOrigin appears exactly as declaration + one usage');
  assert.strictEqual(inPluginRefs, 1, 'the single usage is inside the serve-only plugin');

  assert.ok(!viteConfig.includes("apply: 'build'"), 'never applied to production build');
  assert.ok(!indexHtml.includes('ws://'), 'production index.html contains no websocket origin');
});

test('7. no unrelated production file introduces the Vite websocket allowance', () => {
  const files = [
    path.join(root, 'main.js'),
    path.join(root, 'preload.js'),
    ...listFiles(path.join(root, 'src'))
  ];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file);
    assert.ok(!source.includes('ws://'), rel + ' must not contain ws://');
    assert.ok(!source.includes('localhost:5173'), rel + ' must not contain localhost:5173');
  }
});

console.log('RUNTIME-REQUIRED (not unit-testable without launching Electron):');
console.log('  - Vite dev HMR WebSocket actually connects under the injected CSP');
console.log('  - production file:// page applies the hardened CSP with no console errors');
console.log('');

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
