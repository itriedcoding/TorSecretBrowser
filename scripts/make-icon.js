'use strict';

/**
 * make-icon.js - generates build/icon.png (512x512 RGBA) with no dependencies.
 * Renders at 2x and downsamples for anti-aliasing, then writes a valid PNG
 * using zlib. electron-builder converts this single PNG into .ico/.icns.
 *
 * Run: node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'build', 'icon.png');
const SIZE = 512;
const SS = 2; // supersample factor
const N = SIZE * SS;

const px = new Uint8Array(N * N * 4);

function idx(x, y) {
  return (y * N + x) * 4;
}

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= N || y >= N || a <= 0) return;
  const i = idx(x, y);
  const inv = 1 - a;
  px[i] = Math.round(px[i] * inv + r * a);
  px[i + 1] = Math.round(px[i + 1] * inv + g * a);
  px[i + 2] = Math.round(px[i + 2] * inv + b * a);
  px[i + 3] = Math.round(px[i + 3] * inv + 255 * a);
}

function fillCircle(cx, cy, r, color) {
  const [cr, cg, cb] = color;
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= r) blend(x, y, cr, cg, cb, 1);
    }
  }
}

function ring(cx, cy, r, thickness, color) {
  const [cr, cg, cb] = color;
  const outer = r + thickness / 2;
  const inner = r - thickness / 2;
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d <= outer && d >= inner) blend(x, y, cr, cg, cb, 1);
    }
  }
}

function fillTriangle(p1, p2, p3, color) {
  const [cr, cg, cb] = color;
  const minX = Math.floor(Math.min(p1[0], p2[0], p3[0]));
  const maxX = Math.ceil(Math.max(p1[0], p2[0], p3[0]));
  const minY = Math.floor(Math.min(p1[1], p2[1], p3[1]));
  const maxY = Math.ceil(Math.max(p1[1], p2[1], p3[1]));
  const sign = (a, b, c) => (a[0] - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (a[1] - c[1]);
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const p = [x + 0.5, y + 0.5];
      const d1 = sign(p, p1, p2);
      const d2 = sign(p, p2, p3);
      const d3 = sign(p, p3, p1);
      const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
      const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(hasNeg && hasPos)) blend(x, y, cr, cg, cb, 1);
    }
  }
}

// ---- background gradient (rounded square) ----
const radius = 112 * SS;
const top = [42, 26, 74];
const bottom = [124, 58, 237];
for (let y = 0; y < N; y++) {
  const t = y / (N - 1);
  const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
  const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
  const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
  for (let x = 0; x < N; x++) {
    // rounded-rect coverage
    const dx = Math.max(radius - x, x - (N - radius), 0);
    const dy = Math.max(radius - y, y - (N - radius), 0);
    const corner = Math.hypot(dx, dy);
    if (corner <= radius) {
      const i = idx(x, y);
      px[i] = r;
      px[i + 1] = g;
      px[i + 2] = b;
      px[i + 3] = 255;
    }
  }
}

// ---- onion glyph ----
const white = [239, 234, 255];
const ringColor = [76, 29, 149];
const cx = N / 2;
const cy = 320 * SS;

// neck (pointed top) + bulb
fillTriangle([cx - 118 * SS, 232 * SS], [cx + 118 * SS, 232 * SS], [cx, 92 * SS], white);
fillCircle(cx, cy, 132 * SS, white);

// onion layers
ring(cx, cy, 100 * SS, 13 * SS, ringColor);
ring(cx, cy, 72 * SS, 11 * SS, ringColor);
ring(cx, cy, 44 * SS, 9 * SS, ringColor);

// stem
for (let y = 88 * SS; y < 150 * SS; y++) {
  for (let x = Math.floor(cx - 8 * SS); x < Math.ceil(cx + 8 * SS); x++) {
    blend(x, y, white[0], white[1], white[2], 1);
  }
}

// ---- downsample SS x SS -> 1 ----
const out = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = idx(x * SS + sx, y * SS + sy);
        r += px[i];
        g += px[i + 1];
        b += px[i + 2];
        a += px[i + 3];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 4;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
    out[o + 3] = Math.round(a / n);
  }
}

// ---- minimal PNG encoder ----
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// raw scanlines with filter byte 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, png);
console.log(`Wrote ${OUT} (${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KiB)`);
