/**
 * Generates `build/icon.ico` (and a 256px PNG) with no image library.
 *
 * electron-builder needs a multi-size `.ico` or it substitutes the Electron logo,
 * and pulling in a raster toolchain to draw one flat glyph is not a trade worth
 * making — so this rasterizes the mark itself: PNG is deflate plus four chunks,
 * and a Vista-era `.ico` is a small header around PNGs.
 *
 * Everything is drawn at 4× and box-downsampled, which is where the antialiasing
 * comes from; there is no per-shape edge maths.
 *
 * Run with `npm run icon`. Committing the output is optional — `dist` and `pack`
 * both regenerate it.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT_DIR = path.join(import.meta.dirname, '..', 'build');
/** What Windows actually picks from: taskbar, alt-tab, Explorer, the installer. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A PNG chunk: length, type, data, CRC over type+data. */
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** RGBA8 straight into a PNG. Filter 0 on every scanline; zlib does the work. */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** All geometry in 0..1 so one description serves every size. */
const inRoundedRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
};

/** Point-in-polygon, even-odd. Only used for the lens. */
function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const LENS = [
  [0.655, 0.425],
  [0.815, 0.335],
  [0.815, 0.665],
  [0.655, 0.575],
];

/**
 * The mark: a rounded indigo→violet tile with a white camcorder on it. Reads at
 * 16px, which is the only size that is hard.
 */
function sample(x, y) {
  // Tile radius is generous because Windows 11 puts these on rounded surfaces.
  if (!inRoundedRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return [0, 0, 0, 0];

  const t = (x + y) / 2;
  const bg = [
    Math.round(99 + (139 - 99) * t),
    Math.round(102 + (92 - 102) * t),
    Math.round(241 + (246 - 241) * t),
    255,
  ];

  const body = inRoundedRect(x, y, 0.185, 0.335, 0.625, 0.665, 0.07);
  if (body || inPolygon(x, y, LENS)) return [255, 255, 255, 255];
  return bg;
}

/** Supersample, then average — premultiplying so edge pixels do not darken. */
function raster(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const step = 1 / (size * SS);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sample(
            (px * SS + sx + 0.5) * step,
            (py * SS + sy + 0.5) * step
          );
          const w = sa / 255;
          r += sr * w;
          g += sg * w;
          b += sb * w;
          a += sa;
        }
      }
      const n = SS * SS;
      const alpha = a / n;
      const weight = a / 255 || 1;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r / weight);
      rgba[at + 1] = Math.round(g / weight);
      rgba[at + 2] = Math.round(b / weight);
      rgba[at + 3] = Math.round(alpha);
    }
  }
  return rgba;
}

/**
 * ICO: a 6-byte directory, then one 16-byte entry per image, then the images.
 * PNG payloads are what Vista and later prefer, and 0 in the size byte means 256.
 */
function encodeIco(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2); // type: icon
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([dir, ...entries, ...images.map((i) => i.png)]);
}

const images = SIZES.map((size) => ({ size, png: encodePng(raster(size), size) }));
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), encodeIco(images));
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), images.at(-1).png);
console.log(`[icon] build/icon.ico — ${SIZES.join(', ')}px`);
