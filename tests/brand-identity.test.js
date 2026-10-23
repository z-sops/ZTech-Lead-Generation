'use strict';

// F1 - the ZuniTech visual identity.
//
// The identity hierarchy is:
//     Zuni Enterprise        the parent company
//     ZuniTech               the technology brand
//     ZTech Lead Generation  the product
//
// These tests guard the identity so it cannot drift back: the brand assets
// must exist and be real files, the token layer must be the source of the
// palette, the chrome must carry the brand, and the old product name must not
// come back into anything the customer sees.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(root, rel));

const BRAND_DIR = 'src/renderer/brand';

test('the brand assets exist and are real files', () => {
  for (const file of [
    `${BRAND_DIR}/zunitech-mark.svg`,
    `${BRAND_DIR}/icon-64.png`,
    `${BRAND_DIR}/icon-128.png`,
    `${BRAND_DIR}/icon-256.png`,
    `${BRAND_DIR}/icon-512.png`,
    'build/icon.ico',
  ]) {
    assert.ok(exists(file), 'the asset exists: ' + file);
    assert.ok(fs.statSync(path.join(root, file)).size > 0, 'the asset is not empty: ' + file);
  }
});

test('the generated icons are real PNG and ICO files', () => {
  const png = fs.readFileSync(path.join(root, BRAND_DIR, 'icon-256.png'));
  assert.deepEqual(
    [...png.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'the PNG signature is correct',
  );
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR', 'the first chunk is the header');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(width, 256);
  assert.equal(height, 256);

  const ico = fs.readFileSync(path.join(root, 'build/icon.ico'));
  assert.equal(ico.readUInt16LE(0), 0, 'the ICO reserved field');
  assert.equal(ico.readUInt16LE(2), 1, 'the ICO type is an icon');
  assert.ok(ico.readUInt16LE(4) >= 1, 'the ICO has at least one entry');
});

test('the mark is the ZuniTech mark', () => {
  const svg = read(`${BRAND_DIR}/zunitech-mark.svg`);
  assert.ok(svg.includes('<svg'), 'it is an SVG');
  assert.ok(svg.includes('ZuniTech'), 'it carries the brand name');
  assert.ok(svg.includes('#1F4FD8'), 'it uses the brand primary');
  assert.ok(svg.includes('#FFFFFF'), 'the Z is knocked out in white');
});

test('the token layer is the single source of the palette', () => {
  const tokens = read(`${BRAND_DIR}/tokens.css`);
  for (const token of [
    '--zuni-primary',
    '--zuni-ink',
    '--zuni-surface',
    '--zuni-canvas',
    '--zuni-line',
    '--zuni-success',
    '--zuni-warning',
    '--zuni-danger',
    '--zuni-focus-ring',
  ]) {
    assert.ok(tokens.includes(token + ':'), 'the brand token is defined: ' + token);
  }
  // The twelve legacy tokens are preserved and now derive from the brand.
  for (const legacy of ['--bg-primary', '--bg-card', '--border', '--text-primary', '--accent', '--danger', '--warning', '--success']) {
    assert.ok(tokens.includes(legacy + ': var('), 'the legacy token is derived from the brand: ' + legacy);
  }
});

test('the application loads the brand layer before its own stylesheet', () => {
  const html = read('index.html');
  const brandAt = html.indexOf('./src/renderer/brand/tokens.css');
  const stylesAt = html.indexOf('./src/renderer/styles.css');
  assert.ok(brandAt > -1, 'the brand layer is linked');
  assert.ok(stylesAt > -1, 'the application stylesheet is linked');
  assert.ok(brandAt < stylesAt, 'the brand layer comes first, so the application can still override it');
  assert.ok(html.includes('./src/renderer/brand/zunitech-mark.svg'), 'the mark is shown');
  assert.ok(html.includes('./src/renderer/brand/icon-64.png'), 'the app icon is set');
});

test('the chrome carries the brand and the product name', () => {
  const html = read('index.html');
  assert.ok(html.includes('>ZuniTech<'), 'the brand is shown');
  assert.ok(html.includes('>ZTech Lead Generation<'), 'the product name is shown');
  assert.ok(html.includes('<title>ZTech Lead Generation</title>'), 'the document title is the product');
});

test('the old product name does not come back into anything the customer sees', () => {
  // The application itself must not carry the old name at all.
  for (const file of ['index.html', 'package.json', 'main.js']) {
    const text = read(file);
    assert.ok(!text.includes('phone全球获客'), file + ' carries no legacy product name');
    assert.ok(!text.includes('phone-global-leads'), file + ' carries no legacy package name');
  }

  // The READMEs may NAME the old identifiers, but only inside the
  // compatibility note, where telling the user where their data is matters.
  for (const file of ['README.md', 'README_EN.md']) {
    const text = read(file);
    const note = text.slice(text.indexOf('### Where the data lives'));
    const outside = text.replace(note, '');
    assert.ok(!outside.includes('phone全球获客'), file + ' names the old product only in the compatibility note');
    assert.ok(!outside.includes('phone-global-leads'), file + ' names the old package only in the compatibility note');
    assert.ok(note.includes('phone全球获客'), file + ' explains where the previous installation kept its data');
  }

  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.name, 'ztech-lead-generation');
  assert.equal(pkg.build.productName, 'ZTech Lead Generation');
  assert.equal(pkg.build.appId, 'com.zunitech.ztech-lead-generation');
  assert.ok(pkg.description.includes('ZuniTech'), 'the description names the brand');
});

test('the window title is the product name', () => {
  const main = read('main.js');
  assert.ok(main.includes("title: 'ZTech Lead Generation'"), 'the window title is the product');
  assert.ok(!main.includes('phone全球获客'), 'the legacy title is gone');
});

test('the brand is a ZuniTech brand, and the parent company is named in the legal documents', () => {
  // The parent company belongs to the legal repository. Here we only check
  // that the product repository does not invent a registration detail.
  const readme = read('README.md');
  assert.ok(readme.includes('Zuni Enterprise'), 'the parent company is named');
  assert.ok(readme.includes('ZuniTech'), 'the brand is named');
  assert.ok(readme.includes('ZTech Lead Generation'), 'the product is named');
  assert.ok(
    /not confirmed|TO BE CONFIRMED/i.test(readme),
    'the unconfirmed registration details are flagged, not invented',
  );
});
