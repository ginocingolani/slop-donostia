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

// Local frame -> geographic, by Newton's method on lonLatToUTM (exactly its inverse; three steps reach the micrometre)
export function localToLonLat(x, z) {
  const e = E0 + x, n = N0 - z, d = 1e-6;
  let lon = -2, lat = 43.3;
  for (let it = 0; it < 5; it++) {
    const [e0, n0] = lonLatToUTM(lon, lat), [e1, n1] = lonLatToUTM(lon + d, lat), [e2, n2] = lonLatToUTM(lon, lat + d);
    const a = (e1 - e0) / d, b = (e2 - e0) / d, c = (n1 - n0) / d, f = (n2 - n0) / d, det = a * f - b * c;
    lon += (f * (e - e0) - b * (n - n0)) / det;
    lat += (a * (n - n0) - c * (e - e0)) / det;
  }
  return [lon, lat];
}

// OpenStreetMap is fetched (queries/*.overpassql) and its street names & places kept (bake-streets.mjs) this far around
// the core, so the radar has streets to show over the core's edges
export const OSM_MARGIN = 900;
export const OSM_EXTENT = {
  minX: FRAME.core.minX - OSM_MARGIN, maxX: FRAME.core.maxX + OSM_MARGIN,
  minZ: FRAME.core.minZ - OSM_MARGIN, maxZ: FRAME.core.maxZ + OSM_MARGIN
};
// OSM_EXTENT as an Overpass bbox "south,west,north,east", rounded outwards to 1e-4° (the UTM rectangle is a slightly
// rotated quadrilateral in lon/lat, so its corners give the extremes). fetch.sh fills the queries' {{bbox}} with it.
export function osmBBox() {
  const { minX, maxX, minZ, maxZ } = OSM_EXTENT;
  const corners = [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]].map(([x, z]) => localToLonLat(x, z));
  const lons = corners.map((c) => c[0]), lats = corners.map((c) => c[1]);
  const down = (v) => (Math.floor(v * 1e4) / 1e4).toFixed(4), up = (v) => (Math.ceil(v * 1e4) / 1e4).toFixed(4);
  return [down(Math.min(...lats)), down(Math.min(...lons)), up(Math.max(...lats)), up(Math.max(...lons))].join(',');
}

export const log = (...args) => console.log('[donostia]', ...args);

// The sources of the baked data, for the attribution & licence lines every generated file carries (the licences ask for
// the credit, a link to the licence and a note that the data was modified; tools/donostia/README.md has the details)
export const SOURCES = {
  geoeuskadi: ['Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  b5m: ['b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  c500: ['Donostiako Udala / Ayuntamiento de San Sebastián', 'CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/'],
  osm: ['© OpenStreetMap contributors', 'ODbL 1.0', 'https://opendatacommons.org/licenses/odbl/1-0/']
};
const MODIFIED = 'derived data (reprojected, resampled, simplified and combined by tools/donostia; see its README.md)';

// Comment lines for a generated JS file built from the given SOURCES keys
export function licenceComment(...keys) {
  return `// Licence: ${MODIFIED}, under\n` + keys.map((k) => `//   ${SOURCES[k][0]}: ${SOURCES[k][1]} ${SOURCES[k][2]}\n`).join('');
}

// PNG text chunks (tEXt, Latin-1) with the same, for a baked image built from the given SOURCES keys
export function pngText(...keys) {
  return {
    Copyright: keys.map((k) => `${SOURCES[k][0]} (${SOURCES[k][1]}, ${SOURCES[k][2]})`).join(' · '),
    Comment: `Slop Donostia ${MODIFIED}; licences as in Copyright`
  };
}

// `--preview <dir>` on the command line: the folder (resolved), or null without the flag. Fails at startup when the
// folder is missing, rather than skipping the previews after a long bake.
export function previewDir() {
  const at = process.argv.indexOf('--preview');
  if (at < 0) return null;
  const dir = process.argv[at + 1];
  if (!dir || dir.startsWith('--')) throw new Error('--preview needs a folder');
  return path.resolve(dir);
}

// ESRI ASCII grid (geoEuskadi writes decimal commas). Returns { ncols, nrows, x0, z0, cell, data } in the local frame,
// with row 0 at the northern edge (smallest z) and NaN for NODATA. Throws on anything it cannot read as a plain decimal
// (an exponent, 'nan', a truncated file...) rather than filling the rest of the grid with zeros.
export function readAscGrid(file) {
  const buf = fs.readFileSync(file);
  const n = buf.length;
  const space = (c) => c === 32 || c === 10 || c === 13 || c === 9;
  let pos = 0;
  // header lines start with a keyword (NODATA_value is optional; xllcenter / yllcenter replace the corners in some files)
  const header = {};
  while (pos < n && /[A-Za-z]/.test(String.fromCharCode(buf[pos]))) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = n;
    const [key, value = ''] = buf.toString('latin1', pos, end).trim().split(/\s+/);
    header[key.toLowerCase()] = Number(value.replace(',', '.'));
    pos = end + 1;
  }
  const { ncols, nrows, cellsize } = header;
  if (!(ncols > 0 && nrows > 0 && cellsize > 0)) throw new Error(`${file}: bad header ${JSON.stringify(header)}`);
  const xll = header.xllcorner ?? header.xllcenter - cellsize / 2, yll = header.yllcorner ?? header.yllcenter - cellsize / 2;
  if (!Number.isFinite(xll) || !Number.isFinite(yll)) throw new Error(`${file}: no lower-left corner in the header`);
  const nodata = header.nodata_value;
  const data = new Float32Array(ncols * nrows);
  let k = 0;
  while (pos < n && k < data.length) {
    let c = buf[pos];
    if (space(c)) { pos++; continue; }
    const start = pos;
    let neg = false, digits = 0;
    if (c === 45 || c === 43) { neg = c === 45; c = buf[++pos]; }
    let int = 0;
    while (c >= 48 && c <= 57) { int = int * 10 + (c - 48); digits++; c = buf[++pos]; }
    let frac = 0, scale = 1;
    if (c === 44 || c === 46) {
      c = buf[++pos];
      while (c >= 48 && c <= 57) { frac = frac * 10 + (c - 48); scale *= 10; digits++; c = buf[++pos]; }
    }
    if (!digits || (pos < n && !space(c))) {
      throw new Error(`${file}: unreadable value '${buf.toString('latin1', start, Math.min(n, start + 16)).split(/\s/)[0]}' at byte ${start}`);
    }
    const v = (neg ? -1 : 1) * (int + frac / scale);
    data[k++] = v === nodata ? NaN : v;
  }
  if (k !== data.length) throw new Error(`${file}: read ${k} of ${data.length} values`);
  while (pos < n && space(buf[pos])) pos++;
  if (pos < n) throw new Error(`${file}: more values than ncols x nrows (${ncols} x ${nrows})`);
  return { ncols, nrows, x0: xll - E0, z0: N0 - (yll + nrows * cellsize), cell: cellsize, data };
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

// Whether flat ring `inner` lies inside flat ring `outer`: a majority of (up to 15 of) its edge midpoints do, since an
// inner ring may touch its outer ring at a vertex or along an edge, where a single point decides nothing
function ringInside(inner, outer) {
  const n = inner.length / 2, step = Math.max(1, Math.floor(n / 15));
  let hits = 0, tests = 0;
  for (let a = 0; a < n; a += step) {
    const b = (a + 1) % n;
    tests++;
    if (pointInRing((inner[2 * a] + inner[2 * b]) / 2, (inner[2 * a + 1] + inner[2 * b + 1]) / 2, outer)) hits++;
  }
  return 2 * hits > tests;
}

// OpenStreetMap area (Overpass `out geom`) -> polygons [[outer, ...holes], ...] of flat local rings, each closed by
// repeating its first point as OSM does. A closed way is one polygon; an open way is a line, not an area. A
// multipolygon relation's rings are often split over several member ways: they are chained end to end per role (a
// member without a role counts as outer), a chain that never closes is dropped (logged; filling it would close it with
// a straight chord), and each inner ring goes to the smallest outer ring around it.
export function osmPolygons(e) {
  const flat = (geom) => geom.flatMap((p) => lonLatToLocal(p.lon, p.lat));
  const key = (p) => `${p.lat},${p.lon}`;
  const closed = (g) => g.length >= 4 && key(g[0]) === key(g[g.length - 1]);
  if (e.type === 'way') return e.geometry && closed(e.geometry) ? [[flat(e.geometry)]] : [];
  if (e.type !== 'relation' || !e.members) return [];
  let open = 0;
  const join = (roles) => {
    const parts = e.members.filter((m) => m.type === 'way' && roles.includes(m.role) && m.geometry?.length >= 2).map((m) => m.geometry);
    const rings = [];
    while (parts.length) {
      let chain = parts.shift();
      for (let grown = true; grown && !closed(chain);) {
        grown = false;
        const head = key(chain[chain.length - 1]);
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (key(p[0]) === head) chain = chain.concat(p.slice(1));
          else if (key(p[p.length - 1]) === head) chain = chain.concat(p.slice(0, -1).reverse());
          else continue;
          parts.splice(i, 1);
          grown = true;
          break;
        }
      }
      if (closed(chain)) rings.push(flat(chain));
      else open++;
    }
    return rings;
  };
  const outers = join(['outer', '']), inners = join(['inner']);
  if (open) log(`OSM relation ${e.id} (${e.tags?.name || e.tags?.type || '?'}): ${open} ring(s) do not close, left out`);
  const polys = outers.map((o) => [o]);
  const area = outers.map((o) => Math.abs(ringArea(o)));
  for (const r of inners) {
    let host = -1;
    outers.forEach((o, k) => { if ((host < 0 || area[k] < area[host]) && ringInside(r, o)) host = k; });
    if (host >= 0) polys[host].push(r);
  }
  return polys;
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
// with the smallest sum of absolute residuals, which is what keeps smooth height fields small. text: optional
// { keyword: value } written as tEXt chunks (pngText(); decoders, js/donostia/png.js included, skip them).
export function encodePNG(pixels, w, h, channels, text = null) {
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
    ...Object.entries(text || {}).map(([key, value]) => chunk('tEXt', Buffer.from(`${key}\0${value}`, 'latin1'))),
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
