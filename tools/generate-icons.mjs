/**
 * Generates the PWA icon set as real PNG files, with no image dependencies.
 * Run with: npm run icons
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const TEAL_TOP = [20, 184, 166];
const TEAL_BOTTOM = [12, 106, 99];
const LINE_COLOR = [13, 106, 99];
const WHITE = [255, 255, 255];

/* ---------- Shape tests (normalized 0..1 coordinates) ---------- */

function insideRoundedRect(x, y, x0, y0, x1, y1, radius) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + radius), x1 - radius);
  const cy = Math.min(Math.max(y, y0 + radius), y1 - radius);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius + 1e-12;
}

const HANDLE = { cx: 0.5, cy: 0.415, inner: 0.085, outer: 0.145 };

function insideHandle(x, y) {
  if (y > HANDLE.cy) return false;
  const dx = x - HANDLE.cx;
  const dy = y - HANDLE.cy;
  const distanceSquared = dx * dx + dy * dy;
  return (
    distanceSquared >= HANDLE.inner * HANDLE.inner &&
    distanceSquared <= HANDLE.outer * HANDLE.outer
  );
}

function lerpChannel(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function colorAt(x, y, { rounded, glyphScale }) {
  if (rounded && !insideRoundedRect(x, y, 0, 0, 1, 1, 0.22)) return null;

  const gx = (x - 0.5) / glyphScale + 0.5;
  const gy = (y - 0.5) / glyphScale + 0.5;

  const inBag = insideRoundedRect(gx, gy, 0.285, 0.415, 0.715, 0.795, 0.06);
  const inHandle = insideHandle(gx, gy);
  const inLineOne = insideRoundedRect(gx, gy, 0.375, 0.545, 0.625, 0.575, 0.015);
  const inLineTwo = insideRoundedRect(gx, gy, 0.375, 0.635, 0.625, 0.665, 0.015);

  if (inLineOne || inLineTwo) return LINE_COLOR;
  if (inBag || inHandle) return WHITE;

  return [
    lerpChannel(TEAL_TOP[0], TEAL_BOTTOM[0], y),
    lerpChannel(TEAL_TOP[1], TEAL_BOTTOM[1], y),
    lerpChannel(TEAL_TOP[2], TEAL_BOTTOM[2], y),
  ];
}

/* ---------- PNG encoding ---------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------- Renderer ---------- */

function renderIcon(size, options) {
  const samples = 4;
  const data = Buffer.alloc(size * size * 4);
  const divisor = samples * samples;

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;

      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const color = colorAt(x, y, options);
          if (!color) continue;
          r += color[0];
          g += color[1];
          b += color[2];
          alpha += 1;
        }
      }

      const offset = (py * size + px) * 4;
      if (alpha > 0) {
        data[offset] = Math.round(r / alpha);
        data[offset + 1] = Math.round(g / alpha);
        data[offset + 2] = Math.round(b / alpha);
      }
      data[offset + 3] = Math.round((alpha / divisor) * 255);
    }
  }

  return encodePng(size, size, data);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const outputs = [
    ['icon-32.png', renderIcon(32, { rounded: true, glyphScale: 1 })],
    ['icon-192.png', renderIcon(192, { rounded: true, glyphScale: 1 })],
    ['icon-512.png', renderIcon(512, { rounded: true, glyphScale: 1 })],
    ['icon-maskable-512.png', renderIcon(512, { rounded: false, glyphScale: 0.84 })],
    ['apple-touch-icon.png', renderIcon(180, { rounded: false, glyphScale: 0.9 })],
  ];

  for (const [name, buffer] of outputs) {
    await writeFile(path.join(OUT_DIR, name), buffer);
    console.log(`wrote icons/${name} (${buffer.length} bytes)`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
