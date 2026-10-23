// tools/donostia/lib.mjs
// Shared helpers for the Donostia bake (build.mjs): frame, ESRI ASCII grids, rasters & PNG encoding.
// Pure Node (no dependencies), in the spirit of tools/geo-base.mjs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RAW = path.join(HERE, 'raw');
export const DATA = path.join(HERE, 'data');
export const FRAME = JSON.parse(fs.readFileSync(path.join(HERE, 'frame.json'), 'utf8'));
export const [E0, N0] = FRAME.origin;

export const loadLayer = (name) => JSON.parse(fs.readFileSync(path.isAbsolute(name) ? name : path.join(DATA, name), 'utf8'));

// Geographic (ETRS89 ~ WGS84) -> UTM zone 30N with Krüger's series (sub-millimetre at this distance from the meridian),
// then into the local frame. Used for OSM coordinates; every official source is already EPSG:25830.
const UTM = (() => {
  const a = 6378137, f = 1 / 298.257222101, n = f / (2 - f);
  const A = (a / (1 + n)) * (1 + (n * n) / 4 + (n ** 4) / 64);
  const alpha = [n / 2 - (2 * n * n) / 3 + (5 * n ** 3) / 16, (13 * n * n) / 48 - (3 * n ** 3) / 5, (61 * n ** 3) / 240];
  const c = (2 * Math.sqrt(n)) / (1 + n);
  return { A, alpha, c, k0: 0.9996, lon0: (-3 * Math.PI) / 180 };
})();

export function lonLatToUTM(lon, lat) {
  const phi = (lat * Math.PI) / 180, dl = (lon * Math.PI) / 180 - UTM.lon0;
  const s = Math.sin(phi);
  const t = Math.sinh(Math.atanh(s) - UTM.c * Math.atanh(UTM.c * s));
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let e = eta, nn = xi;
  for (let j = 1; j <= 3; j++) {
    e += UTM.alpha[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    nn += UTM.alpha[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
  }
  return [500000 + UTM.k0 * UTM.A * e, UTM.k0 * UTM.A * nn];
}

export function lonLatToLocal(lon, lat) {
  const [e, n] = lonLatToUTM(lon, lat);
  return [Math.round((e - E0) * 100) / 100, Math.round((N0 - n) * 100) / 100];
}
export const log = (...args) => console.log('[donostia]', ...args);

// ESRI ASCII grid (geoEuskadi writes decimal commas). Returns { ncols, nrows, x0, z0, cell, data } in the local frame,
// with row 0 at the northern edge (smallest z) and NaN for NODATA.
export function readAscGrid(file) {
  const buf = fs.readFileSync(file);
  let pos = 0;
  const header = {};
  for (let line = 0; line < 6; line++) {
    let end = buf.indexOf(10, pos);
    const text = buf.toString('latin1', pos, end).trim();
    pos = end + 1;
    const [key, value] = text.split(/\s+/);
    header[key.toLowerCase()] = Number(value.replace(',', '.'));
  }
  const { ncols, nrows, xllcorner, yllcorner, cellsize } = header;
  const nodata = header.nodata_value;
  const data = new Float32Array(ncols * nrows);
  let k = 0;
  const n = buf.length;
  while (pos < n && k < data.length) {
    let c = buf[pos];
    if (c === 32 || c === 10 || c === 13 || c === 9) { pos++; continue; }
    let neg = false;
    if (c === 45) { neg = true; pos++; c = buf[pos]; }
    let int = 0;
    while (c >= 48 && c <= 57) { int = int * 10 + (c - 48); c = buf[++pos]; }
    let frac = 0, scale = 1;
    if (c === 44 || c === 46) {
      c = buf[++pos];
      while (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); scale *= 10; c = buf[++pos]; }
    }
    const v = (neg ? -1 : 1) * (int + frac / scale);
    data[k++] = v === nodata ? NaN : v;
  }
  if (k !== data.length) throw new Error(`${file}: read ${k} of ${data.length} values`);
  return { ncols, nrows, x0: xllcorner - E0, z0: N0 - (yllcorner + nrows * cellsize), cell: cellsize, data };
}

// A float grid in the local frame: sample (i, j) is the cell whose centre is (x0 + (i + .5) res, z0 + (j + .5) res).
export class Grid {
  constructor(x0, z0, w, h, res, fill = NaN) {
    Object.assign(this, { x0, z0, w, h, res });
    this.data = new Float32Array(w * h).fill(fill);
  }
  static over(ext, res, fill = NaN) {
    return new Grid(ext.minX, ext.minZ, Math.round((ext.maxX - ext.minX) / res), Math.round((ext.maxZ - ext.minZ) / res), res, fill);
  }
  get(i, j) { return this.data[j * this.w + i]; }
  // Bilinear sample at a local (x, z), NaN outside or next to holes
  sample(x, z) {
    const fx = (x - this.x0) / this.res - 0.5, fz = (z - this.z0) / this.res - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i + 1 >= this.w || j + 1 >= this.h) return NaN;
    const tx = fx - i, tz = fz - j, d = this.data, w = this.w;
    const a = d[j * w + i], b = d[j * w + i + 1], c = d[(j + 1) * w + i], e = d[(j + 1) * w + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + e * tx) * tz;
  }
}

// Even-odd scanline fill of polygon rings (flat [x, z, ...] arrays in local metres) on a w x h cell grid whose cell
// (i, j) has its centre at (x0 + (i + .5) res, z0 + (j + .5) res). Calls visit(i, j) for each covered cell; holes are
// handled by passing all rings of a polygon together.
export function scanRings(rings, x0, z0, res, w, h, visit) {
  let minZ = Infinity, maxZ = -Infinity;
  for (const r of rings) for (let k = 1; k < r.length; k += 2) { if (r[k] < minZ) minZ = r[k]; if (r[k] > maxZ) maxZ = r[k]; }
  const j0 = Math.max(0, Math.ceil((minZ - z0) / res - 0.5)), j1 = Math.min(h - 1, Math.floor((maxZ - z0) / res - 0.5));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * res;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const za = r[2 * a + 1], zb = r[2 * b + 1];
        if ((za > zc) !== (zb > zc)) xs.push(r[2 * a] + ((zc - za) / (zb - za)) * (r[2 * b] - r[2 * a]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / res - 0.5)), i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / res - 0.5));
      for (let i = i0; i <= i1; i++) visit(i, j);
    }
  }
}

export function ringArea(r) {
  let a = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

export function ringBounds(r) {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < r.length; k += 2) {
    if (r[k] < minX) minX = r[k];
    if (r[k] > maxX) maxX = r[k];
    if (r[k + 1] < minZ) minZ = r[k + 1];
    if (r[k + 1] > maxZ) maxZ = r[k + 1];
  }
  return { minX, minZ, maxX, maxZ };
}

export function pointInRing(x, z, r) {
  let inside = false;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Douglas-Peucker on a closed flat ring (keeps at least 3 vertices)
export function simplifyRing(r, tol) {
  const n = r.length / 2;
  if (n <= 4) return r;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  // split at the vertex farthest from vertex 0 so the closed ring has two open chains
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  keep[far] = 1;
  const stack = [[0, far], [far, n]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = r[2 * a], az = r[2 * a + 1], bx = r[2 * (b % n)], bz = r[2 * (b % n) + 1];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-12;
    let idx = -1, max = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = r[2 * i] - ax, pz = r[2 * i + 1] - az;
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / len2));
      const ex = px - t * dx, ez = pz - t * dz, d2 = ex * ex + ez * ez;
      if (d2 > max) { max = d2; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out.length >= 6 ? out : r;
}

// --- PNG (8-bit, non-interlaced) -------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// pixels: Uint8Array of w * h * channels (1 = gray, 3 = RGB, 4 = RGBA). Each row picks the filter (None/Sub/Up/Paeth)
// with the smallest sum of absolute residuals, which is what keeps smooth height fields small.
export function encodePNG(pixels, w, h, channels) {
  const colorType = { 1: 0, 3: 2, 4: 6 }[channels];
  const stride = w * channels;
  const out = Buffer.alloc((stride + 1) * h);
  const cand = [Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride), Buffer.alloc(stride)];
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    let bestF = 0, bestScore = Infinity;
    for (let f = 0; f < 4; f++) {
      const c = cand[f];
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= channels ? row[i - channels] : 0;
        const b = up ? up[i] : 0;
        const cc = up && i >= channels ? up[i - channels] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) {
          const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc;
        }
        const v = (row[i] - pred) & 0xff;
        c[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestF = f; }
    }
    const filterId = [0, 1, 2, 4][bestF];
    out[y * (stride + 1)] = filterId;
    cand[bestF].copy(out, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// Heights as 16-bit centimetres above -100 m, packed big-endian into R & G of an RGB PNG (B = 0). The browser decodes
// it with js/donostia/png.js (exact, no colour management). NaN is written as 0 (= -100 m).
export const HEIGHT_OFFSET = 100;
export function encodeHeightPNG(grid) {
  const px = new Uint8Array(grid.w * grid.h * 3);
  for (let k = 0; k < grid.data.length; k++) {
    const v = grid.data[k];
    const u = Number.isFinite(v) ? Math.max(0, Math.min(65535, Math.round((v + HEIGHT_OFFSET) * 100))) : 0;
    px[3 * k] = u >> 8;
    px[3 * k + 1] = u & 255;
  }
  return encodePNG(px, grid.w, grid.h, 3);
}
