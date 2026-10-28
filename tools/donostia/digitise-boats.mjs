// tools/donostia/digitise-boats.mjs
// usage: node tools/donostia/digitise-boats.mjs [--preview <dir>]   (needs raw/ortho; after build.mjs)
// The boats moored in the port, digitised from geoEuskadi's 2025 orthophoto (raw/ortho/ortho2025-port_*.jpg, 12.5 cm/px,
// decoded by jpeg.mjs) -> tools/donostia/data/port_boats.json (committed; bake-boats.mjs turns it into js/donostia's data):
// 1. Where: the water of the inner basin & the north basin (OSM's two marinas, a metre beyond their outlines) and of the
//    old port (drawn here), as far as the baked terrain has water; never on what is built (the municipal map's quays,
//    docks, moles & pontoons, OSM's floating pontoon, ferry landing & breakwaters).
// 2. Boat pixels: bright and neutral (white hulls & decks) or painted (red, blue), against the harbour's dark teal; an
//    opening drops anything under half a metre across. 4-connected blobs of a square metre or more.
// 3. Rows: boats moored side by side merge into one blob. Each blob is read along a few candidate axes (the axis along
//    which its seams line up sharpest, its principal axis, its tightest box, square to and along the edge it is moored to,
//    and a second pass with its neighbours' axis) and cut across the axis by dynamic programming into hull-wide pieces at
//    its seams; the reading whose pieces make the best hulls wins. A piece far longer than a hull of its width is cut
//    lengthwise at its narrowest (boats moored end to end).
// 4. Each piece: its tightest box (centre, length, beam, heading), the bow at its narrower end (the row's majority where a
//    hull's ends barely differ), how far aft it reaches its full beam (a sailboat is a long teardrop) and its colours;
//    from those a family. Slivers & scraps are dropped.
// 5. Hand corrections (DROP, FIX, ADD below) where the automatic pass goes wrong: the passenger boats, the catamaran & the
//    fishing boat, the old port's few boats, and a handful of others; checked tile by tile against the orthophoto.
// --preview <dir> writes the masks, the pieces and the raw boats (boats-*.png, boats-raw.json). BOATS_DEBUG=x,z logs how
// the blob at (x, z) was read and cut. Deterministic: no randomness, a fixed visiting order.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { decodeJPEG } from './jpeg.mjs';
import { HERE, RAW, DATA, loadLayer, lonLatToLocal, osmPolygons, scanRings, encodePNG, previewDir, log } from './lib.mjs';

const ROOT = path.resolve(HERE, '../..');
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);

const PREVIEW = previewDir();
const ORTHO = { file: path.join(RAW, 'ortho/ortho2025-port_x-350_z-300.jpg'), x0: -350, z0: -300, px: 8 }; // px per m
const RES = 1 / ORTHO.px;
// the region analysed: the harbour inside its moles
const ROI = { minX: -175, maxX: 125, minZ: -245, maxZ: -60 };
const W = (ROI.maxX - ROI.minX) * ORTHO.px, H = (ROI.maxZ - ROI.minZ) * ORTHO.px;

// --- the image ---------------------------------------------------------------------------------------------------------

const img = decodeJPEG(fs.readFileSync(ORTHO.file));
const R = new Uint8Array(W * H), G = new Uint8Array(W * H), B = new Uint8Array(W * H);
{
  const ox = (ROI.minX - ORTHO.x0) * ORTHO.px, oy = (ROI.minZ - ORTHO.z0) * ORTHO.px;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const s = ((oy + j) * img.width + ox + i) * 3, k = j * W + i;
      R[k] = img.data[s]; G[k] = img.data[s + 1]; B[k] = img.data[s + 2];
    }
  }
}
const lum = (k) => 0.299 * R[k] + 0.587 * G[k] + 0.114 * B[k];
// pixel (i, j) <-> local (x, z) of its centre
const X = (i) => ROI.minX + (i + 0.5) * RES, Z = (j) => ROI.minZ + (j + 0.5) * RES;

// --- masks: the water zones, and everything built (quays, moles, pontoons) ------------------------------------------------

const fill = (mask, rings, value = 1) => scanRings(rings, ROI.minX, ROI.minZ, RES, W, H, (i, j) => { mask[j * W + i] = value; });
// a polyline as a band of half-width hw
function band(mask, pts, hw, value = 1) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], l = Math.hypot(bx - ax, bz - az) || 1;
    const nx = (-(bz - az) / l) * hw, nz = ((bx - ax) / l) * hw, ex = ((bx - ax) / l) * hw * 0.5, ez = ((bz - az) / l) * hw * 0.5;
    fill(mask, [[ax - ex + nx, az - ez + nz, bx + ex + nx, bz + ez + nz, bx + ex - nx, bz + ez - nz, ax - ex - nx, az - ez - nz]], value);
  }
}
function dilate(mask, r) {
  let a = mask;
  for (let it = 0; it < r; it++) {
    const b = a.slice();
    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i;
        if (!a[k] && (a[k - 1] || a[k + 1] || a[k - W] || a[k + W])) b[k] = 1;
      }
    }
    a = b;
  }
  return a;
}

// The baked terrain's ground classes (2 m cells, tools/donostia/build.mjs): only water cells and the ones next to them
// (a quay's wall runs through a cell) can hold a boat
function decodePNG(buf) {
  let pos = 8, w = 0, h = 0, ch = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8);
    if (type === 'IHDR') {
      w = buf.readUInt32BE(pos + 8);
      h = buf.readUInt32BE(pos + 12);
      ch = { 0: 1, 2: 3, 6: 4 }[buf[pos + 17]];
    } else if (type === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? out[dst + i - ch] : 0, b = y > 0 ? out[prev + i] : 0, c = y > 0 && i >= ch ? out[prev + i - ch] : 0;
      let p = 0;
      if (f === 1) p = a;
      else if (f === 2) p = b;
      else if (f === 3) p = (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + i] = (raw[src + i] + p) & 255;
    }
  }
  return { w, h, ch, data: out };
}
const nearWater = (() => {
  const meta = GEO.terrain.core, img = decodePNG(fs.readFileSync(path.join(ROOT, meta.url)));
  const water = GEO.terrain.classes.water;
  const isWater = (i, j) => i >= 0 && j >= 0 && i < meta.w && j < meta.h && img.data[3 * (j * meta.w + i) + 2] === water;
  return (x, z) => {
    const i = Math.floor((x - meta.x0) / meta.res), j = Math.floor((z - meta.z0) / meta.res);
    return isWater(i, j) || isWater(i - 1, j) || isWater(i + 1, j) || isWater(i, j - 1) || isWater(i, j + 1);
  };
})();

const osm = loadLayer('osm_places.json').elements;
const osmLine = (id) => osm.find((e) => e.id === id).geometry.map((p) => lonLatToLocal(p.lon, p.lat));

// Zones: 1 the inner basin (OSM marina "Kirol portua"), 2 the north basin (OSM marina "Donostia"), 3 the old port between
// the fishermen's quay and the moles (drawn here); each a metre beyond its outline, so the boats along the quays count
const ZONE_NAMES = ['', 'inner', 'north', 'old'];
const OLD_PORT = [-170, -176, -120, -191, -76, -201, -76, -150, -30, -150, -30, -110, -104, -124, -122, -113, -170, -120];
const zone = new Uint8Array(W * H);
fill(zone, [OLD_PORT], 3);
for (const [id, value] of [[565482772, 2], [157022675, 1]]) {
  const ring = osmLine(id).flat();
  const m = new Uint8Array(W * H);
  fill(m, [ring]);
  const d = dilate(m, 8);
  for (let k = 0; k < W * H; k++) if (d[k]) zone[k] = value;
}
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) if (zone[j * W + i] && !nearWater(X(i), Z(j))) zone[j * W + i] = 0;

// Built: the municipal map's quays, docks & moles and pontoons, a few centimetres beyond their outlines; OSM's floating
// piers and the ferry's landing, which only OSM maps (the north basin's pontoon: its walkway as a 1.8 m band, its
// fingers as 0.7 m ones, measured on the orthophoto). OSM's other piers are the inner basin's, whose municipal outlines
// are exact where OSM's centre lines are not.
const built = new Uint8Array(W * H);
for (const name of ['c500_KAIA.json', 'c500_NASA.json', 'c500_DIKEA.json', 'c500_PANTALANA.json']) {
  for (const f of loadLayer(name).features) fill(built, f.g);
}
// within 60 cm of the municipal outlines (OSM's centre lines stray that far from them)
const builtNear = dilate(built, 5);
// the moles' armour of concrete cubes, bright as hulls (OSM breakwaters)
for (const e of osm) if (e.tags?.man_made === 'breakwater') for (const poly of osmPolygons(e)) fill(built, poly);
const builtPontoon = (i, j) => builtNear[j * W + i] === 1;
for (const e of osm) {
  const t = e.tags || {};
  if (t.man_made !== 'pier' || !e.geometry) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  if (t.floating === 'yes' || t.ferry === 'yes') {
    band(built, pts, t.ferry === 'yes' ? 1.5 : pts.length > 2 ? 0.9 : 0.35);
    continue;
  }
  // an inner-basin walkway the municipal map left out: a 1.4 m band along OSM's centre line wherever it runs off the
  // municipal outlines
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    let run = null;
    for (let q = 0; q <= n; q++) {
      const x = ax + ((bx - ax) * q) / n, z = az + ((bz - az) * q) / n;
      const i = Math.round((x - ROI.minX) / RES), j = Math.round((z - ROI.minZ) / RES);
      const inside = i >= 0 && j >= 0 && i < W && j < H && builtPontoon(i, j);
      if (!inside && !run) run = [[x, z]];
      if (!inside && run) run[1] = [x, z];
      if ((inside || q === n) && run) {
        if (run[1]) band(built, [run[0], run[1]], 0.7);
        run = null;
      }
    }
  }
}
const builtD = dilate(built, 2);

// --- boat pixels ----------------------------------------------------------------------------------------------------------

// The harbour's water is a dark teal (R 30-80, G & B 65-110): green and blue well over red. Hulls & decks are white or
// light grey (neutral, bright), or painted (red, orange, blue: far from the water's hue); their shadows on the water are
// a darker teal. A boat's dark parts (navy covers, an open boat's inside) are left to the measuring below, which spans
// them.
const teal = (k) => (G[k] + B[k]) / 2 - R[k];
const BOAT = 1;
const cls = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) {
  if (!zone[k] || builtD[k]) continue;
  const l = lum(k), t = teal(k);
  const red = R[k] - G[k] > 35 && R[k] > 110, blue = B[k] - G[k] > 30 && B[k] > 95;
  if ((l > 112 && t < 22) || l > 150 || red || blue) cls[k] = BOAT;
}
// An opening (erode twice, dilate twice, 4-neighbourhood) drops whatever is under half a metre across: the pale edges of
// the pontoons beyond their mapped outlines, which would chain every boat along a walkway into one blob, fenders,
// mooring lines, ripples. A hull loses only its bow's very tip.
{
  const core = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) core[k] = cls[k] === BOAT ? 1 : 0;
  const step = (src, erode) => {
    const out = src.slice();
    for (let j = 1; j < H - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i, n = src[k - 1] + src[k + 1] + src[k - W] + src[k + W];
        if (erode && src[k] && n < 4) out[k] = 0;
        if (!erode && !src[k] && n > 0) out[k] = 1;
      }
    }
    return out;
  };
  let m = step(step(core, true), true);
  m = step(step(m, false), false);
  for (let k = 0; k < W * H; k++) if (cls[k] === BOAT && !m[k]) cls[k] = 0;
}

// --- blobs ----------------------------------------------------------------------------------------------------------------

// 4-connected components of the boat pixels
const label = new Int32Array(W * H).fill(-1);
const blobs = [];
{
  const stack = [];
  for (let k0 = 0; k0 < W * H; k0++) {
    if (cls[k0] !== BOAT || label[k0] >= 0) continue;
    const id = blobs.length, px = [];
    label[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop();
      px.push(k);
      const i = k % W;
      for (const n of [i > 0 ? k - 1 : -1, i < W - 1 ? k + 1 : -1, k - W, k + W]) {
        if (n >= 0 && n < W * H && cls[n] === BOAT && label[n] < 0) { label[n] = id; stack.push(n); }
      }
    }
    blobs.push({ id, px, zone: zone[k0] });
  }
}
const MIN_AREA = 1.0; // m²: buoys, swimmers, flotsam below
const big = blobs.filter((b) => b.px.length * RES * RES >= MIN_AREA);
log(`${blobs.length} blobs, ${big.length} of ${MIN_AREA} m² or more`);

// The axis of a row of boats side by side: seen along it, the seams between the hulls line up into sharp dips of the
// mean luminance across the row; at any other angle they smear out. Scores each heading (2° steps, then 0.5°) by the
// sharpness of the dips in the profile across it (the positive second difference over ±25 cm, weighted by how full each
// bin is) and returns the best as a unit vector.
function rowAxis(pixels) {
  const xs = new Float32Array(pixels.length), zs = new Float32Array(pixels.length), ls = new Float32Array(pixels.length);
  pixels.forEach((k, n) => { xs[n] = k % W; zs[n] = (k / W) | 0; ls[n] = lum(k); });
  const score = (deg) => {
    const a = (deg * Math.PI) / 180, nx = -Math.sin(a), nz = Math.cos(a);
    let cmin = Infinity, cmax = -Infinity;
    for (let n = 0; n < xs.length; n++) { const c = xs[n] * nx + zs[n] * nz; if (c < cmin) cmin = c; if (c > cmax) cmax = c; }
    const nb = Math.floor(cmax - cmin) + 1, count = new Float64Array(nb), sum = new Float64Array(nb);
    for (let n = 0; n < xs.length; n++) { const b = Math.floor(xs[n] * nx + zs[n] * nz - cmin); count[b]++; sum[b] += ls[n]; }
    let peak = 0;
    for (let b = 0; b < nb; b++) peak = Math.max(peak, count[b]);
    let e = 0;
    for (let b = 2; b < nb - 2; b++) {
      if (!count[b - 2] || !count[b] || !count[b + 2]) continue;
      const m = (i) => sum[i] / count[i];
      const d = m(b - 2) + m(b + 2) - 2 * m(b);
      if (d > 0) e += d * Math.min(count[b - 2], count[b], count[b + 2]) / peak;
    }
    return e;
  };
  let best = 0, bestE = -1;
  for (let d = 0; d < 180; d += 2) { const e = score(d); if (e > bestE) { bestE = e; best = d; } }
  const coarse = best;
  for (let d = coarse - 1.5; d <= coarse + 1.5; d += 0.5) { const e = score(d); if (e > bestE) { bestE = e; best = d; } }
  const a = (best * Math.PI) / 180;
  return { ax: Math.cos(a), az: Math.sin(a), energy: bestE };
}

// Principal axes of a set of pixels: centre, major axis (unit) and the two variances
function principal(pixels) {
  let sx = 0, sz = 0;
  for (const k of pixels) { sx += k % W; sz += (k / W) | 0; }
  const mx = sx / pixels.length, mz = sz / pixels.length;
  let cxx = 0, cxz = 0, czz = 0;
  for (const k of pixels) {
    const dx = (k % W) - mx, dz = ((k / W) | 0) - mz;
    cxx += dx * dx; cxz += dx * dz; czz += dz * dz;
  }
  const a = Math.atan2(2 * cxz, cxx - czz) / 2;
  return { mx, mz, ax: Math.cos(a), az: Math.sin(a) };
}

// --- splitting rows of boats -----------------------------------------------------------------------------------------------

// Boats moored side by side merge into one blob. Across their common axis the blob's mean luminance dips at each seam
// (the dark gap or shade between two hulls) and the blob thins there (the V between two bows), but at 12.5 cm a seam is
// often no deeper than a dark cockpit down a hull's middle. So the cuts are chosen together, by dynamic programming over
// the profile across the axis: each cut earns its seam's strength less a toll, and each piece between two cuts costs by
// how far its width strays from the beam a hull of its length has (a third of it and a bit, as measured on the clear
// boats); a piece that is no hull seen along the axis (under a metre wide, or not clearly longer than wide) costs more
// than anything. A row thus splits into hull-wide pieces at its seams, a lone boat stays whole even across a dark
// cockpit, and one whose axis came out wrong (an open boat's thwarts are seams across it) stays whole for measure() to
// straighten.
const SEAM_TOLL = 8, BEAM_WEIGHT = 120, PIECE_COST = 8;
const beamOf = (l) => Math.min(5.2, Math.max(1.1, 0.34 * l + 0.2)); // m, the typical beam of a hull l m long
function splitAcross(pixels, ax, az) {
  // s along the axis, c across it, in pixels
  const nx = -az, nz = ax;
  let cmin = Infinity, cmax = -Infinity;
  const cs = new Float32Array(pixels.length), ss = new Float32Array(pixels.length);
  pixels.forEach((k, n) => {
    const i = k % W, j = (k / W) | 0;
    cs[n] = i * nx + j * nz; ss[n] = i * ax + j * az;
    if (cs[n] < cmin) cmin = cs[n];
    if (cs[n] > cmax) cmax = cs[n];
  });
  const nb = Math.floor(cmax - cmin) + 1;
  if (nb * RES <= 1.6) return { parts: [pixels], score: 0 };
  const count = new Float64Array(nb), sum = new Float64Array(nb);
  const s0 = new Float64Array(nb).fill(Infinity), s1 = new Float64Array(nb).fill(-Infinity);
  const bin = (n) => Math.min(nb - 1, Math.floor(cs[n] - cmin));
  pixels.forEach((k, n) => {
    const b = bin(n);
    count[b]++; sum[b] += lum(k);
    if (ss[n] < s0[b]) s0[b] = ss[n];
    if (ss[n] > s1[b]) s1[b] = ss[n];
  });
  // seam strength per bin: how much darker (mean luminance, smoothed over 3 bins) and thinner (pixel count) it is than
  // the brightest & fullest bins within 1.2 m either side
  const mean = (b) => (count[b] ? sum[b] / count[b] : 0);
  const sm = new Float64Array(nb), sc = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let s = 0, c = 0, n = 0;
    for (let d = -1; d <= 1; d++) if (b + d >= 0 && b + d < nb) { s += mean(b + d); c += count[b + d]; n++; }
    sm[b] = s / n; sc[b] = c / n;
  }
  const reach = Math.round(1.2 / RES), edge = Math.round(0.8 / RES);
  const seam = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let lm = 0, rm = 0, lc = 0, rc = 0;
    for (let d = 1; d <= reach; d++) {
      if (b - d >= 0) { lm = Math.max(lm, sm[b - d]); lc = Math.max(lc, sc[b - d]); }
      if (b + d < nb) { rm = Math.max(rm, sm[b + d]); rc = Math.max(rc, sc[b + d]); }
    }
    seam[b] = Math.min(lm, rm) - sm[b] + 60 * (1 - sc[b] / Math.max(1, Math.min(lc, rc)));
  }
  // best[b]: the best score of the bins before cut b; a piece over bins [a, b) costs by its width against its length
  const best = new Float64Array(nb + 1).fill(-Infinity), from = new Int32Array(nb + 1).fill(-1);
  best[0] = 0;
  for (let a = 0; a < nb; a++) {
    if (best[a] === -Infinity || (a > 0 && a < edge)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let b = a + 1; b <= nb; b++) {
      const q = b - 1;
      if (count[q] >= 3) { if (s0[q] < lo) lo = s0[q]; if (s1[q] > hi) hi = s1[q]; }
      if (b < nb && (b < edge || b > nb - edge)) continue;
      const w = (b - a) * RES, l = hi >= lo ? (hi - lo + 1) * RES : 0;
      // (a hull narrower than its length suggests is rarer than a wider one)
      const dev = (w - beamOf(l)) / beamOf(l);
      // (and few boats here are over 11 m: a row of ten small ones is not one yacht)
      const cost = PIECE_COST + 3 * Math.max(0, l - 11) ** 2 +
        (w < 0.9 || l < 1.4 * w || l < 2.5 ? 300 + 150 * w : (dev < 0 ? 2.2 : 1) * BEAM_WEIGHT * dev * dev);
      const v = best[a] - cost + (b < nb ? seam[b] - SEAM_TOLL : 0);
      if (v > best[b]) { best[b] = v; from[b] = a; }
    }
  }
  const chosen = [];
  for (let b = from[nb]; b > 0; b = from[b]) chosen.unshift(b);
  if (globalThis.SPLIT_DEBUG) log('chosen', chosen.join(','), 'score', best[nb].toFixed(1));
  if (!chosen.length) return { parts: [pixels], score: best[nb] };
  const parts = Array.from({ length: chosen.length + 1 }, () => []);
  pixels.forEach((k, n) => {
    const b = bin(n);
    let p = 0;
    while (p < chosen.length && b >= chosen[p]) p++;
    parts[p].push(k);
  });
  return { parts: parts.filter((p) => p.length), score: best[nb] };
}

// Boats moored end to end (along a quay, or round a pontoon's end) merge lengthwise: a piece far longer than a hull of
// its width is cut where it narrows most (between one's bow and the next one's stern), again by dynamic programming,
// each piece costing by how far its length strays from 2.8 beams
const ASPECT = 2.8;
function splitAlong(pixels, ax, az) {
  const e = extents(pixels, ax, az, 0.02, 0.98);
  const w = (e.c1 - e.c0 + 1) * RES, l = (e.s1 - e.s0 + 1) * RES;
  if (l < 3.4 * w) return [pixels];
  let smin = Infinity, smax = -Infinity;
  const ss = pixels.map((k) => (k % W) * ax + ((k / W) | 0) * az);
  for (const s of ss) { if (s < smin) smin = s; if (s > smax) smax = s; }
  const nb = Math.floor(smax - smin) + 1, count = new Float64Array(nb);
  for (const s of ss) count[Math.min(nb - 1, Math.floor(s - smin))]++;
  // the waist: how much narrower a bin is than the widest within 2 m either side
  const reach = Math.round(2 / RES), waist = new Float64Array(nb);
  for (let b = 0; b < nb; b++) {
    let lc = 0, rc = 0;
    for (let d = 1; d <= reach; d++) {
      if (b - d >= 0) lc = Math.max(lc, count[b - d]);
      if (b + d < nb) rc = Math.max(rc, count[b + d]);
    }
    waist[b] = 80 * (1 - count[b] / Math.max(1, Math.min(lc, rc)));
  }
  const best = new Float64Array(nb + 1).fill(-Infinity), from = new Int32Array(nb + 1).fill(-1);
  best[0] = 0;
  const minLen = Math.round(1.5 / RES);
  for (let a = 0; a < nb; a++) {
    if (best[a] === -Infinity) continue;
    for (let b = a + minLen; b <= nb; b++) {
      if (b < nb && b > nb - minLen) continue;
      const pl = (b - a) * RES, cost = 40 * Math.log(pl / (ASPECT * w)) ** 2;
      const v = best[a] - cost + (b < nb ? waist[b] - 20 : 0);
      if (v > best[b]) { best[b] = v; from[b] = a; }
    }
  }
  const chosen = [];
  for (let b = from[nb]; b > 0; b = from[b]) chosen.unshift(b);
  if (!chosen.length) return [pixels];
  const parts = Array.from({ length: chosen.length + 1 }, () => []);
  pixels.forEach((k, n) => {
    const b = Math.min(nb - 1, Math.floor(ss[n] - smin));
    let p = 0;
    while (p < chosen.length && b >= chosen[p]) p++;
    parts[p].push(k);
  });
  return parts.filter((p) => p.length);
}

// The edge a blob is moored to (a pontoon's side, a quay): the most common direction of the built mask's edge normals
// within 30 cm of the blob, in 3° bins (a row along a finger also touches the walkway at its end, which counts less).
// Returns that normal as a unit vector (the axis of boats moored stern-to the edge), or null when the blob touches
// nothing built.
const BERTH_BONUS = 12;
function contactAxis(pixels) {
  const seen = new Set(), hist = new Float64Array(60);
  let total = 0;
  for (const k of pixels) {
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        const n = k + dj * W + di;
        if (n < W + 1 || n >= W * H - W - 1 || !builtD[n] || seen.has(n)) continue;
        seen.add(n);
        const m = (q) => builtD[q];
        const gx = m(n - W + 1) + 2 * m(n + 1) + m(n + W + 1) - m(n - W - 1) - 2 * m(n - 1) - m(n + W - 1);
        const gz = m(n + W - 1) + 2 * m(n + W) + m(n + W + 1) - m(n - W - 1) - 2 * m(n - W) - m(n - W + 1);
        const g = Math.hypot(gx, gz);
        if (!g) continue;
        const a = ((Math.atan2(gz, gx) % Math.PI) + Math.PI) % Math.PI; // the normal's direction, either way
        hist[Math.floor((a / Math.PI) * 60) % 60] += g;
        total += g;
      }
    }
  }
  if (total < 40) return null;
  let best = 0;
  for (let b = 0; b < 60; b++) {
    const s = (q) => hist[(q + 60) % 60];
    if (s(b - 1) + s(b) + s(b + 1) > s(best - 1) + s(best) + s(best + 1)) best = b;
  }
  const a = ((best + 0.5) / 60) * Math.PI;
  return { ax: Math.cos(a), az: Math.sin(a) };
}

const pieces = [];
const DEBUG = process.env.BOATS_DEBUG ? process.env.BOATS_DEBUG.split(',').map(Number) : null;
// Several readings of a blob: a row of boats along the seams' axis, boats along its own long axis or its tightest box's
// (a lone hull, or boats moored end to end), square to or along the edge it is moored to; the one whose pieces make the
// better hulls wins. Then a second pass: boats moor parallel to their neighbours, so a blob of two or three whose axis
// came out across that of the boats around it (within 12 m, from other blobs: the median, mod 180°) gets their axis as
// a reading too, with a bonus.
const NEIGHBOUR_BONUS = 40;
const picks = new Map();
function readBlob(b, extra = null) {
  if (DEBUG) {
    const k = Math.round((DEBUG[1] - ROI.minZ) / RES) * W + Math.round((DEBUG[0] - ROI.minX) / RES);
    globalThis.SPLIT_DEBUG = label[k] === b.id;
  }
  const row = rowAxis(b.px), pc = principal(b.px), berth = contactAxis(b.px);
  const box = tightest(b.px, pc.ax, pc.az, 30);
  const candidates = [[row.ax, row.az, 0], [pc.ax, pc.az, 0], [box.ax, box.az, 0]];
  if (berth) candidates.push([berth.ax, berth.az, BERTH_BONUS], [-berth.az, berth.ax, 0]);
  if (extra) candidates.push(extra);
  let pick = null;
  for (const [ax, az, bonus] of candidates) {
    const r = splitAcross(b.px, ax, az);
    const score = r.score + bonus;
    if (globalThis.SPLIT_DEBUG) log('debug blob', b.id, b.px.length, 'axis', (Math.atan2(az, ax) * 180 / Math.PI).toFixed(1), 'score', score.toFixed(1), 'parts', r.parts.length);
    if (!pick || score > pick.score) pick = { ...r, score, ax, az };
  }
  return { ...pick, mx: pc.mx, mz: pc.mz };
}
for (const b of big) picks.set(b.id, readBlob(b));
const axisDeg = (ax, az) => ((Math.atan2(az, ax) * 180) / Math.PI + 180) % 180;
for (const b of big) {
  const own = picks.get(b.id);
  if (own.parts.length > 3) continue;
  const near = [];
  for (const o of big) {
    const p = picks.get(o.id);
    if (o.id === b.id || Math.hypot(p.mx - own.mx, p.mz - own.mz) * RES > 12) continue;
    for (let n = 0; n < p.parts.length; n++) near.push(axisDeg(p.ax, p.az));
  }
  if (near.length < 3) continue;
  // the median direction, mod 180: the one with the least total angular distance to the others
  const dist = (a, c) => { const d = Math.abs(a - c) % 180; return Math.min(d, 180 - d); };
  let med = near[0], best = Infinity;
  for (const a of near) {
    const s = near.reduce((t, c) => t + dist(a, c), 0);
    if (s < best) { best = s; med = a; }
  }
  if (dist(med, axisDeg(own.ax, own.az)) < 30) continue;
  const r = (med * Math.PI) / 180;
  picks.set(b.id, readBlob(b, [Math.cos(r), Math.sin(r), NEIGHBOUR_BONUS]));
}
for (const b of big) {
  const pick = picks.get(b.id);
  for (const part of pick.parts) {
    for (const p of splitAlong(part, pick.ax, pick.az)) {
      if (p.length * RES * RES < MIN_AREA) continue;
      pieces.push({ px: p, zone: b.zone, blob: b.id, ax: pick.ax, az: pick.az });
    }
  }
}
log(`${pieces.length} pieces`);

// --- measuring each boat -----------------------------------------------------------------------------------------------

// Extents of pixels along (ax, az) and across, as robust percentiles (px)
function extents(pixels, ax, az, lo = 0.01, hi = 0.99) {
  const s = pixels.map((k) => (k % W) * ax + ((k / W) | 0) * az).sort((a, b) => a - b);
  const c = pixels.map((k) => -(k % W) * az + ((k / W) | 0) * ax).sort((a, b) => a - b);
  const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
  return { s0: q(s, lo), s1: q(s, hi), c0: q(c, lo), c1: q(c, hi) };
}

// The tightest box round a piece (2-98% extents) among headings within `spread` degrees of (ax, az), in 2° steps: boats
// in a row are parallel within a few degrees, and the box follows the hull rather than whatever clings to it
function tightest(pixels, ax, az, spread) {
  const a0 = Math.atan2(az, ax);
  let best = null;
  for (let d = -spread; d <= spread; d += 2) {
    const a = a0 + (d * Math.PI) / 180, bx = Math.cos(a), bz = Math.sin(a);
    const e = extents(pixels, bx, bz, 0.02, 0.98);
    const area = (e.s1 - e.s0 + 1) * (e.c1 - e.c0 + 1) * (1 + Math.abs(d) * 0.002); // ties go to the row's axis
    if (!best || area < best.area) best = { area, ax: bx, az: bz };
  }
  return best;
}

function measure(p) {
  // the row's axis, refined on the piece; a piece that lies square to its row (a boat moored across the end of a row)
  // keeps its own principal axis
  let { ax, az } = tightest(p.px, p.ax, p.az, 20);
  const e1 = extents(p.px, ax, az);
  const elong = (e) => (e.s1 - e.s0) / Math.max(1, e.c1 - e.c0);
  if (elong(e1) < 1.25) {
    const pc = principal(p.px), t = tightest(p.px, pc.ax, pc.az, 10);
    if (elong(extents(p.px, t.ax, t.az)) > 1.6) { ax = t.ax; az = t.az; }
  }
  const e = extents(p.px, ax, az);
  const length = (e.s1 - e.s0 + 1) * RES, beam = (e.c1 - e.c0 + 1) * RES;
  const sm = (e.s0 + e.s1) / 2, cm = (e.c0 + e.c1) / 2;
  const ci = sm * ax - cm * az, cj = sm * az + cm * ax; // back to pixels
  // the bow: the narrower end (a transom is square, a bow pointed). The hull's width at each station spans its runs of
  // pixels (an open cockpit or a dark cover leaves a gap down the middle), less the slivers of the neighbours' bows that a
  // piece cut from a row keeps along its sides: short runs against the piece's edge, apart from the rest
  const ns = Math.round(e.s1 - e.s0) + 1, nc = Math.round(e.c1 - e.c0) + 1;
  const occ = new Uint8Array(ns * nc);
  for (const k of p.px) {
    const si = Math.round((k % W) * ax + ((k / W) | 0) * az - e.s0), ci = Math.round(-(k % W) * az + ((k / W) | 0) * ax - e.c0);
    if (si >= 0 && si < ns && ci >= 0 && ci < nc) occ[si * nc + ci] = 1;
  }
  const station = (si) => {
    const runs = [];
    for (let c = 0; c < nc;) {
      if (!occ[si * nc + c]) { c++; continue; }
      let end = c;
      while (end + 1 < nc && occ[si * nc + end + 1]) end++;
      runs.push([c, end]);
      c = end + 1;
    }
    const sliver = (r, q) => (r[0] <= 1 || r[1] >= nc - 2) && r[1] - r[0] + 1 <= 0.25 * nc &&
      runs.every((o, n) => n === q || (o[0] - r[1] >= 3 || r[0] - o[1] >= 3));
    // (only beside a run down the middle: an open cockpit leaves the two gunwales, which are no slivers)
    const centre = runs.some((r) => r[0] <= nc * 0.4 && r[1] >= nc * 0.6);
    const kept = runs.length > 1 && centre ? runs.filter((r, q) => !sliver(r, q)) : runs;
    return kept.length ? kept[kept.length - 1][1] - kept[0][0] + 1 : 0;
  };
  // the median over the end's stations (a dark coaming or traveller can blank one across)
  const endWidth = (f0, f1) => {
    const w = [];
    for (let si = Math.floor(f0 * (ns - 1)); si <= Math.ceil(f1 * (ns - 1)); si++) w.push(station(si));
    w.sort((a, b) => a - b);
    return w[w.length >> 1] || 0;
  };
  const wA = endWidth(0.02, 0.2), wB = endWidth(0.8, 0.98);
  if (DEBUG && Math.hypot(X(ci) - DEBUG[0], Z(cj) - DEBUG[1]) < 1.5) {
    log('debug boat', X(ci).toFixed(1), Z(cj).toFixed(1), 'axis', (Math.atan2(az, ax) * 180 / Math.PI).toFixed(1), 'ns', ns, 'nc', nc, 'wA', wA.toFixed(1), 'wB', wB.toFixed(1));
    log('  stations', Array.from({ length: 20 }, (_, q) => station(Math.round(((q + 0.5) / 20) * (ns - 1)))).join(' '));
  }
  const dir = wB < wA ? 1 : -1; // +axis is the bow when its end is the narrower
  const hx = ax * dir, hz = az * dir;
  // How far aft of the bow the hull reaches 90% of its beam (stations smoothed over 5): a sailboat's deck is a long
  // teardrop, widest well aft; a motor boat's or an open boat's sides run parallel from near the bow
  const widths = Array.from({ length: ns }, (_, q) => station(q));
  const smooth = widths.map((_, q) => {
    const win = widths.slice(Math.max(0, q - 2), q + 3).sort((a, b) => a - b);
    return win[win.length >> 1];
  });
  const fromBow = dir > 0 ? smooth.slice().reverse() : smooth, widest = Math.max(...fromBow);
  const fullAt = fromBow.findIndex((v) => v >= 0.9 * widest) / Math.max(1, ns - 1);
  // Colours inside the hull's box (80% of its beam, 90% of its length, so no neighbour's): the deck's and hull's white
  // or paint (the median of the bright pixels), the whole boat's tone (of all but the darkest: an open boat's inside, a
  // cover) and the strongest colour (the median of the saturated pixels: a painted hull, a coloured cover)
  const bright = [], vivid = [], seen = [];
  let all = 0;
  const hl = (e.s1 - e.s0) * 0.45, hb = (e.c1 - e.c0) * 0.4;
  const r = Math.ceil(Math.hypot(hl, hb));
  for (let j = Math.floor(cj - r); j <= cj + r; j++) {
    for (let i = Math.floor(ci - r); i <= ci + r; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const ds = (i - ci) * ax + (j - cj) * az, dc = -(i - ci) * az + (j - cj) * ax;
      if (Math.abs(ds) > hl || Math.abs(dc) > hb) continue;
      const k = j * W + i, l = lum(k), chroma = Math.max(R[k], G[k], B[k]) - Math.min(R[k], G[k], B[k]);
      all++;
      if (l > 60) seen.push(k);
      if (l > 120 && chroma < 45) bright.push(k);
      if (chroma > 45 && l > 50 && teal(k) < 15) vivid.push(k);
    }
  }
  const median = (list) => {
    if (!list.length) return null;
    const ch = [R, G, B].map((C) => list.map((k) => C[k]).sort((a, b) => a - b)[list.length >> 1]);
    return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
  };
  return {
    x: X(ci), z: Z(cj), heading: ((Math.atan2(hx, hz) * 180) / Math.PI + 360) % 360, length, beam,
    taper: wA && wB ? Math.min(wA, wB) / Math.max(wA, wB) : 1, fill: (p.px.length * RES * RES) / (length * beam),
    colour: median(bright.length >= 8 ? bright : p.px), tone: median(seen.length >= 8 ? seen : p.px),
    accent: vivid.length >= 0.1 * all ? median(vivid) : null, zone: ZONE_NAMES[p.zone],
    // for the row's vote below: the axis, which way the bow lies along it and how sure that is
    blob: p.blob, ax, az, dir, sure: Math.abs(wA - wB) / Math.max(wA, wB, 1), fullAt
  };
}
// slivers along the pontoons' & quays' edges, and scraps
const boats = pieces.map(measure).filter((b) => b.beam >= 0.9 && b.length >= 1.6 && b.length / b.beam < 6 && b.fill > 0.45);
// Boats in a row moor the same way round. Where a row of three or more votes clearly (weighted by each hull's taper), a
// boat whose own ends barely differ takes the row's side.
{
  const rows = new Map();
  for (const b of boats) {
    if (!rows.has(b.blob)) rows.set(b.blob, []);
    rows.get(b.blob).push(b);
  }
  for (const row of rows.values()) {
    if (row.length < 3) continue;
    const ref = row[0];
    let vote = 0, weight = 0;
    for (const b of row) {
      const same = b.ax * ref.ax + b.az * ref.az > 0 ? 1 : -1; // its axis against the first's
      vote += b.dir * same * b.sure;
      weight += b.sure;
    }
    if (Math.abs(vote) < 0.35 * weight) continue;
    for (const b of row) {
      const same = b.ax * ref.ax + b.az * ref.az > 0 ? 1 : -1, want = Math.sign(vote) * same;
      if (b.dir === want || b.sure > 0.3) continue;
      b.dir = want;
      b.heading = (b.heading + 180) % 360;
    }
  }
}
// --- families --------------------------------------------------------------------------------------------------------------

// From above: a RIB's tubes are orange (the rescue & club boats: salmon to orange under the photo's haze); a sailboat is a
// long teardrop (widest well aft of a pointed bow) of 6 m or more; a txalupa is a small boat painted green or blue all
// over, or a deep red; a small boat with none of these is an open boat (under 5 m) or a motor boat. The passenger boats
// and whatever the shapes get wrong are set by hand below.
const hue = (hex) => {
  const [r, g, b] = [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d) return { h: 0, s: 0 };
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: d / mx };
};
function family(b) {
  const a = b.accent ? hue(b.accent) : null;
  if (a && a.s >= 0.25 && a.s < 0.55 && (a.h < 40 || a.h >= 345) && b.length < 12) return 'rib';
  if (b.length >= 6 && b.fullAt >= 0.33 && b.taper <= 0.75 && b.length / b.beam >= 2.5) return 'sail';
  if (a && a.s > 0.35 && (a.h < 12 || a.h >= 345 || (a.h >= 90 && a.h < 260)) && b.length <= 8) return 'txalupa';
  if (b.length < 5) return 'open';
  return 'motor';
}
for (const b of boats) b.family = family(b);
if (PREVIEW) fs.writeFileSync(path.join(PREVIEW, 'boats-raw.json'), JSON.stringify({ boats }));

// --- hand corrections --------------------------------------------------------------------------------------------------

// Measured by hand on the orthophoto, where the automatic pass goes wrong (coordinates in the local frame, m; heading in
// degrees from +z towards +x, of the bow).
// DROP: [why, flat ring]: the automatic boats whose centres fall inside are removed (ADD puts the real ones back).
// FIX: [x, z, changes]: the boat whose centre is nearest (x, z), within 2.5 m, takes the changes.
// ADD: boats measured by hand.
const DROP = [
  // the passenger boats on the north quay (sliced across by the row splitter) and the pale timber of the quay behind them
  ['north quay', [5, -241, 43, -241, 43, -208, 5, -208]],
  // the tourist catamaran at the north basin's west quay
  ['catamaran', [-86, -196, -50, -196, -50, -169, -86, -169]],
  // the big passenger boat between the north basin's pontoons, sliced across
  ['big boat', [33.6, -202.5, 41.5, -199, 42, -190.5, 37.5, -190.5, 33.6, -197.5]],
  // pale strips along the north basin's quays, and a floating deck (no boats)
  ['north quay edge', [-24, -210.5, -11.5, -210.5, -11.5, -202.5, -24, -202.5]],
  ['west quay edge', [-45, -199, -33, -199, -33, -191.5, -45, -191.5]],
  ['floating deck', [-53, -168.5, -24, -168.5, -24, -160.5, -53, -160.5]],
  // the old port: orange rescue RIBs and salmon-pink txalupas against two small pontoons, a few boats on the slipways and
  // quays; few enough to measure each by hand
  ['old port', [-172, -178, -120, -178, -120, -112, -172, -112]],
  // a RIB moored alone along the inner basin's east quay (cut in two by its dark well)
  ['east RIB', [91.6, -147, 95, -147, 95, -140.6, 91.6, -140.6]],
  // two motor boats at the end of a pontoon, sliced across the wrong way
  ['two boats', [96.6, -106.4, 101.4, -106.4, 101.4, -99.6, 96.6, -99.6]],
  // a light blue boat, cut in two lengthwise
  ['light blue', [75.2, -88.2, 80.8, -88.2, 80.8, -85.9, 75.2, -85.9]],
  // a pink boat at the end of a pontoon and an orange RIB at the T pontoon's foot, each cut in two
  ['pink boat', [28.6, -163.4, 31.6, -163.4, 31.6, -160.2, 28.6, -160.2]],
  ['RIB', [-3, -162.6, 0.5, -162.6, 0.5, -159.4, -3, -159.4]],
  // the inshore fishing boat moored along the fish market's quay in the north basin (its wheelhouse, deck gear & dark
  // hull read as five small boats)
  ['fishing boat', [43.8, -208, 51.8, -208, 51.8, -195.8, 43.8, -195.8]],
  // a motor boat under way down the north basin's fairway, its wake behind it: nothing moored there
  ['under way', [-44, -187, -36, -187, -36, -180, -44, -180]]
];
const FIX = [
  [5.21, -174.12, { family: 'sail' }], // a sailboat on the north basin's T pontoon (its stern is cut square)
  // small boats painted a salmon red, no RIBs
  [-23.95, -114.71, { family: 'open' }],
  [92.26, -77.4, { family: 'open' }],
  [8.0, -159.87, { heading: 266 }], // a RIB: its outboard (white) is at the east end
  // a pontoon's pale head taken in with the boat alongside it
  [-24.03, -122.54, { x: -21.2, z: -121.9, heading: 270, length: 4.4, beam: 1.8, family: 'motor' }]
];
const ADD = [
  // passenger boats at the north quay, bows to the harbour mouth: a covered saloon; open upper decks with benches
  { x: 28.36, z: -223.6, heading: 116, length: 14.0, beam: 6.2, family: 'passenger', colour: '#e8e8e5', zone: 'north' },
  { x: 12.75, z: -215.96, heading: 118, length: 14.1, beam: 5.0, family: 'passenger', colour: '#e2e2df', accent: '#3a4250', zone: 'north' },
  { x: 33.54, z: -215.33, heading: 112, length: 11.9, beam: 5.2, family: 'passenger', colour: '#e6e5e1', accent: '#8a5a48', zone: 'north' },
  // the catamaran
  { x: -66.74, z: -182.37, heading: 102, length: 18.4, beam: 5.9, family: 'passenger', colour: '#e8e8e6', accent: '#5a7fa8', zone: 'north' },
  // between the north basin's pontoons
  { x: 37.1, z: -196.0, heading: 200, length: 11.5, beam: 5.2, family: 'passenger', colour: '#e2e3e1', zone: 'north' },
  // ... the fishing boat at the fish market's quay: a dark hull, the white wheelhouse forward, nets aft
  { x: 47.5, z: -201.8, heading: 211, length: 11.7, beam: 3.8, family: 'fishing', colour: '#d6d7d3', tone: '#5d6460', accent: '#262c30', zone: 'north' },
  // ... and at the T pontoon's foot
  { x: -0.9, z: -160.75, heading: 90, length: 5.2, beam: 2.2, family: 'rib', colour: '#e2c4bb', tone: '#d2a691', accent: '#d1a38e', zone: 'north' },
  // the inner basin
  { x: 29.55, z: -161.45, heading: 203, length: 5.3, beam: 2.2, family: 'open', colour: '#e4cbc9', tone: '#c8a09c', accent: '#b07a74', zone: 'inner' },
  { x: 92.96, z: -143.67, heading: 189, length: 5.3, beam: 2.2, family: 'rib', colour: '#c8ccd0', accent: '#7e868c', zone: 'inner' },
  { x: 97.85, z: -102.45, heading: 196, length: 5.8, beam: 2.2, family: 'motor', colour: '#eeeeec', accent: '#3d4a6e', zone: 'inner' },
  { x: 99.95, z: -103.1, heading: 198, length: 5.9, beam: 2.0, family: 'motor', colour: '#e4e6e4', zone: 'inner' },
  { x: 78.16, z: -86.6, heading: 79, length: 6.5, beam: 2.0, family: 'motor', colour: '#a7c8e0', tone: '#8ab8d8', zone: 'inner' },
  // the old port (colours as photographed: bake-boats.mjs lifts them out of the haze): at Kaiarriba's pontoon, txalupas
  // painted a salmon red
  { x: -146.46, z: -164.8, heading: 166, length: 3.1, beam: 1.5, family: 'txalupa', colour: '#cfb6af', tone: '#bb9f95', accent: '#865c53', zone: 'old' },
  { x: -144.48, z: -165.0, heading: 166, length: 3.8, beam: 2.0, family: 'txalupa', colour: '#ddc4be', tone: '#c39c93', accent: '#ba8d84', zone: 'old' },
  { x: -142.3, z: -164.8, heading: 170, length: 4.7, beam: 2.4, family: 'txalupa', colour: '#c6acaa', tone: '#bc9d99', accent: '#855b52', zone: 'old' },
  { x: -153.2, z: -163.3, heading: 0, length: 2.4, beam: 1.3, family: 'txalupa', colour: '#ad908d', tone: '#a38481', accent: '#ae7c7b', zone: 'old' },
  { x: -154.54, z: -162.7, heading: 0, length: 3.3, beam: 1.4, family: 'txalupa', colour: '#b49797', tone: '#937a78', accent: '#ae7c7b', zone: 'old' },
  { x: -155.9, z: -162.1, heading: 0, length: 2.5, beam: 1.35, family: 'txalupa', colour: '#ba989a', tone: '#a68585', accent: '#ae7c7b', zone: 'old' },
  // ... the open boat off the fishermen's quay
  { x: -130.1, z: -169.8, heading: 180, length: 4.2, beam: 1.9, family: 'open', colour: '#e8e8e6', zone: 'old' },
  // ... and at the Aquarium's pontoon: the rescue RIBs (orange tubes, engines aft), a motor boat, a light blue dinghy
  { x: -157.6, z: -131.9, heading: 262, length: 7.9, beam: 2.6, family: 'rib', colour: '#bca49e', tone: '#b89890', accent: '#d3a698', zone: 'old' },
  { x: -147.35, z: -129.7, heading: 258, length: 10.4, beam: 3.1, family: 'rib', colour: '#c3aaa0', tone: '#a8887d', accent: '#a0766b', zone: 'old' },
  { x: -163.1, z: -130.5, heading: 180, length: 4.9, beam: 2.1, family: 'motor', colour: '#afb3b2', tone: '#7b828b', accent: '#2c3a5a', zone: 'old' },
  { x: -142.46, z: -125.33, heading: 74, length: 4.0, beam: 1.6, family: 'open', colour: '#a7c0ca', tone: '#93b1c0', zone: 'old' }
];
const inside = (x, z, r) => {
  let c = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) c = !c;
  }
  return c;
};
let dropped = 0;
for (const b of boats) {
  if (DROP.some(([, ring]) => inside(b.x, b.z, ring))) { b.drop = true; dropped++; }
}
let fixed = 0;
for (const [x, z, change] of FIX) {
  let best = null, bestD = 2.5;
  for (const b of boats) {
    const d = Math.hypot(b.x - x, b.z - z);
    if (d < bestD && !b.fixed && !b.drop) { bestD = d; best = b; }
  }
  if (!best) { log(`FIX at ${x}, ${z}: no boat there`); continue; }
  Object.assign(best, change, { fixed: true });
  fixed++;
}
const final = [...boats.filter((b) => !b.drop), ...ADD.map((b) => ({ ...b, hand: true }))];

// --- output ------------------------------------------------------------------------------------------------------------

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
final.sort((a, b) => a.z - b.z || a.x - b.x);
const out = {
  source: 'Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi: Ortofoto 2025 (ORTO_2025, WMS), 12.5 cm/px; digitised by tools/donostia/digitise-boats.mjs',
  licence: 'Derived data: free use with the credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi». The basins come from ' +
    'OpenStreetMap (ODbL 1.0) and the pontoons & quays that bound them from the municipal 1:500 map (Donostiako Udala, CC BY-SA 3.0).',
  note: 'x, z: the hull\'s centre (m, local frame: x east, z south); heading: degrees from +z (south) towards +x (east) of the bow; ' +
    'length & beam: m; colour: the deck & hull\'s white or paint (the bright pixels); tone: the whole boat seen from above (an open ' +
    'boat\'s inside, its cover); accent: the strongest other colour (a painted hull, a cover); sRGB; ' +
    'hand: digitised by hand',
  families: ['sail', 'motor', 'open', 'txalupa', 'rib', 'passenger', 'fishing'],
  boats: final.map((b) => ({
    x: round(b.x), z: round(b.z), heading: Math.round(b.heading), length: round(b.length, 1), beam: round(b.beam, 1),
    family: b.family, colour: b.colour, tone: b.tone || b.colour, ...(b.accent ? { accent: b.accent } : {}), zone: b.zone,
    ...(b.hand ? { hand: true } : {})
  }))
};
const OUT = path.join(DATA, 'port_boats.json');
fs.writeFileSync(OUT, JSON.stringify(out, null, 0).replace(/\{"x"/g, '\n{"x"') + '\n');
const count = {};
for (const b of out.boats) count[b.family] = (count[b.family] || 0) + 1;
log(`${path.relative(ROOT, OUT)}: ${out.boats.length} boats (${dropped} dropped, ${fixed} corrected, ${ADD.length} by hand)`, JSON.stringify(count));

if (PREVIEW) {
  const px = new Uint8Array(W * H * 3);
  for (let k = 0; k < W * H; k++) {
    const dim = zone[k] && !builtD[k] ? 0.6 : 0.3;
    px[3 * k] = R[k] * dim; px[3 * k + 1] = G[k] * dim; px[3 * k + 2] = B[k] * dim;
  }
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const p of pieces) {
    const c = [80 + rnd() * 175, 80 + rnd() * 175, 80 + rnd() * 175];
    for (const k of p.px) { px[3 * k] = c[0]; px[3 * k + 1] = c[1]; px[3 * k + 2] = c[2]; }
  }
  fs.writeFileSync(path.join(PREVIEW, 'boats-pieces.png'), encodePNG(px, W, H, 3));
  // the masks: built in red, outside the zones dimmed, boat pixels in yellow
  for (let k = 0; k < W * H; k++) {
    const dim = zone[k] ? 1 : 0.35;
    px[3 * k] = R[k] * dim; px[3 * k + 1] = G[k] * dim; px[3 * k + 2] = B[k] * dim;
    if (builtD[k]) { px[3 * k] = 255; px[3 * k + 1] *= 0.5; px[3 * k + 2] *= 0.5; }
    if (cls[k] === BOAT) { px[3 * k] = 255; px[3 * k + 1] = 230; px[3 * k + 2] = 0; }
  }
  fs.writeFileSync(path.join(PREVIEW, 'boats-masks.png'), encodePNG(px, W, H, 3));
}
