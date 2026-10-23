#!/usr/bin/env node
'use strict';

/**
 * Build the ZuniTech brand assets.
 *
 * The product icon is generated rather than hand-drawn so it is reproducible,
 * reviewable and identical at every size. The mark is:
 *
 *   - a rounded square in the ZuniTech primary colour;
 *   - a white "Z" built from two bars and a diagonal.
 *
 * The geometry below and the committed SVG (src/renderer/brand/zunitech-mark.svg)
 * describe the same mark. `npm run build:brand` regenerates the PNGs.
 *
 * Usage: node scripts/build-brand-assets.js
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'src', 'renderer', 'brand');

/* ------------------------------------------------------------- the mark --- */

const BRAND = {
  primary: [0x1f, 0x4f, 0xd8],
  primaryDeep: [0x16, 0x39, 0xa6],
  ink: [0xff, 0xff, 0xff],
};

/** Distance from a point to a segment, in normalised coordinates. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Is the normalised point inside the rounded square? */
function insideRoundedSquare(x, y, radius) {
  if (x < 0 || x > 1 || y < 0 || y > 1) return false;
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return Math.hypot(x - cx, y - cy) <= radius + 1e-9;
}

/** Is the normalised point on the white "Z"? */
function onTheZ(x, y) {
  const stroke = 0.042;
  // top bar
  if (x >= 0.28 && x <= 0.72 && y >= 0.31 && y <= 0.385) return true;
  // bottom bar
  if (x >= 0.28 && x <= 0.72 && y >= 0.615 && y <= 0.69) return true;
  // diagonal, from the end of the top bar to the start of the bottom bar
  if (distanceToSegment(x, y, 0.695, 0.3475, 0.305, 0.6525) <= stroke) return true;
  return false;
}

/** The colour of one sample point. */
function sample(x, y) {
  if (!insideRoundedSquare(x, y, 0.22)) return null; // transparent
  if (onTheZ(x, y)) return BRAND.ink;
  // A vertical gradient from the primary to the deeper primary.
  const t = y;
  return [
    Math.round(BRAND.primary[0] + (BRAND.primaryDeep[0] - BRAND.primary[0]) * t),
    Math.round(BRAND.primary[1] + (BRAND.primaryDeep[1] - BRAND.primary[1]) * t),
    Math.round(BRAND.primary[2] + (BRAND.primaryDeep[2] - BRAND.primary[2]) * t),
  ];
}

/** Render the mark into an RGBA pixel buffer. */
function renderMark(size, samples = 4) {
  const pixels = Buffer.alloc(size * size * 4);
  const step = 1 / samples;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = (px + (sx + 0.5) * step) / size;
          const y = (py + (sy + 0.5) * step) / size;
          const c = sample(x, y);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const total = samples * samples;
      const i = (py * size + px) * 4;
      if (a === 0) {
        pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
      } else {
        const covered = a / 255;
        pixels[i] = Math.round(r / covered);
        pixels[i + 1] = Math.round(g / covered);
        pixels[i + 2] = Math.round(b / covered);
        pixels[i + 3] = Math.round(a / total);
      }
    }
  }
  return pixels;
}

/* ------------------------------------------------------------- PNG writer -- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  // Each scanline is prefixed with a filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A Windows .ico that embeds PNG payloads (the Vista+ format). electron-builder
 * accepts it and requires at least one 256x256 entry.
 */
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const dir = Buffer.alloc(16 * entries.length);
  let offset = 6 + dir.length;
  entries.forEach((entry, i) => {
    const at = i * 16;
    dir[at] = entry.size >= 256 ? 0 : entry.size; // 0 means 256
    dir[at + 1] = entry.size >= 256 ? 0 : entry.size;
    dir[at + 2] = 0;  // palette
    dir[at + 3] = 0;  // reserved
    dir.writeUInt16LE(1, at + 4);  // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32BE(0, at + 8);
    dir.writeUInt32LE(entry.png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ------------------------------------------------------------------- main -- */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const made = [];
  const sizes = [64, 128, 256, 512];
  const rendered = new Map();
  for (const size of sizes) {
    const file = path.join(OUT_DIR, `icon-${size}.png`);
    const png = encodePng(size, renderMark(size));
    fs.writeFileSync(file, png);
    rendered.set(size, png);
    made.push(`${path.relative(ROOT, file)} (${size}x${size}, ${png.length} bytes)`);
  }

  // The Windows icon, in the build folder electron-builder looks in.
  const buildDir = path.join(ROOT, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const icoPath = path.join(buildDir, 'icon.ico');
  const ico = encodeIco([...rendered.entries()].map(([size, png]) => ({ size, png })));
  fs.writeFileSync(icoPath, ico);
  made.push(`${path.relative(ROOT, icoPath)} (${ico.length} bytes, ${sizes.join('/')})`);

  console.log('ZuniTech brand assets');
  for (const m of made) console.log('  ' + m);
  console.log('  src/renderer/brand/zunitech-mark.svg (committed by hand; the same geometry)');
}

main();
