// tools/donostia/bake-bridges.mjs
// usage: node tools/donostia/bake-bridges.mjs   (after build.mjs: it reads data/donostia/terrain-core.png)
// Bakes the bridges of the core into js/donostia/data-bridges.js for js/donostia/bridges.js. Each OpenStreetMap bridge
// way (carriageways, cycleways, footways and tracks drawn side by side) is grouped with its neighbours into one
// structure: a centre line, a deck width split into surface bands, the road level at both ends from the terrain, the
// stretch over the water and where the piers stand. Bridges over land are kept only where the terrain dips well below
// the deck (the LiDAR ground model drops the decks of viaducts but keeps embankments and short culverts as ground).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { HERE, FRAME, HEIGHT_OFFSET, loadLayer, lonLatToLocal, log } from './lib.mjs';

const ROOT = path.join(HERE, '..', '..');
const OUT = path.join(ROOT, 'js', 'donostia', 'data-bridges.js');
const CORE = FRAME.core;
const WATER = 7; // GEO.terrain.classes.water
const POND_MIN = 0.6; // m: water cells above this are ponds (js/donostia/water.js)

// --- terrain (the core PNG written by build.mjs: R/G = 16-bit cm above -HEIGHT_OFFSET m, B = ground class) ------------

function readPNG(file) {
  const data = fs.readFileSync(file);
  let pos = 8, width = 0, height = 0, channels = 0;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos), type = data.toString('latin1', pos + 4, pos + 8);
    const body = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = { 0: 1, 2: 3, 6: 4 }[body[9]];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels, out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? out[dst + i - channels] : 0, b = y > 0 ? out[prev + i] : 0;
      const c = y > 0 && i >= channels ? out[prev + i - channels] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
        p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[dst + i] = (raw[src + i] + p) & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

const img = readPNG(path.join(ROOT, 'data', 'donostia', 'terrain-core.png'));
const RES = (CORE.maxX - CORE.minX) / img.width;
const W = img.width, H = img.height;
const heights = new Float32Array(W * H), classes = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) {
  heights[k] = ((img.data[3 * k] << 8) | img.data[3 * k + 1]) / 100 - HEIGHT_OFFSET;
  classes[k] = img.data[3 * k + 2];
}
const inCore = (x, z) => x > CORE.minX + RES && x < CORE.maxX - RES && z > CORE.minZ + RES && z < CORE.maxZ - RES;
function heightAt(x, z) {
  const fx = (x - CORE.minX) / RES - 0.5, fz = (z - CORE.minZ) / RES - 0.5;
  const i = Math.max(0, Math.min(W - 2, Math.floor(fx))), j = Math.max(0, Math.min(H - 2, Math.floor(fz)));
  const tx = Math.min(1, Math.max(0, fx - i)), tz = Math.min(1, Math.max(0, fz - j)), k = j * W + i;
  return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + W] * (1 - tx) + heights[k + W + 1] * tx) * tz;
}
function isWet(x, z) {
  const i = Math.floor((x - CORE.minX) / RES), j = Math.floor((z - CORE.minZ) / RES);
  if (i < 0 || j < 0 || i >= W || j >= H) return false;
  const k = j * W + i;
  return classes[k] === WATER && heights[k] < POND_MIN;
}

// --- polylines ---------------------------------------------------------------------------------------------------------

const r2 = (v) => Math.round(v * 100) / 100;

function lengthOf(pts) {
  let L = 0;
  for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
  return L;
}

// Point at arc length s along a polyline (extrapolated past both ends) with its unit tangent
function pointAt(pts, s) {
  let k = 1, acc = 0;
  for (; k < pts.length - 1; k++) {
    const seg = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    if (acc + seg >= s) break;
    acc += seg;
  }
  const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
  const seg = Math.hypot(bx - ax, bz - az) || 1e-9;
  const t = (s - acc) / seg, tx = (bx - ax) / seg, tz = (bz - az) / seg;
  return [ax + tx * t * seg, az + tz * t * seg, tx, tz];
}

// Arc length & signed lateral offset (+ = right of the direction of travel, x east / z south) of a point
function project(pts, x, z) {
  let best = Infinity, bs = 0, bd = 0, acc = 0;
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1e-9;
    let t = ((x - ax) * dx + (z - az) * dz) / (len * len);
    if (k > 1) t = Math.max(0, t);
    if (k < pts.length - 1) t = Math.min(1, t);
    const px = ax + dx * t, pz = az + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best) {
      best = d;
      bs = acc + t * len;
      bd = ((x - ax) * -dz + (z - az) * dx) / len; // right normal of (dx, dz) is (-dz, dx)
    }
    acc += len;
  }
  return [bs, bd];
}

// --- ways ----------------------------------------------------------------------------------------------------------------

// Deck width (m) of an OSM bridge way (deckWidth in tools/donostia/build.mjs)
function deckWidth(t) {
  const width = Number.parseFloat(t.width);
  if (Number.isFinite(width) && width > 0.5) return width;
  if (t.railway) return 4.6;
  const lanes = Number.parseInt(t.lanes, 10);
  const lane = /^motorway/.test(t.highway) ? 3.6 : 3.2;
  if (Number.isFinite(lanes) && lanes > 0) return lanes * lane + 0.6;
  return {
    motorway: 11, motorway_link: 7, trunk: 10, primary: 9, secondary: 8, tertiary: 7, residential: 6.5, unclassified: 6,
    service: 4.5, cycleway: 2.5, footway: 3, pedestrian: 6, path: 2.5, steps: 2.5
  }[t.highway] || 4;
}

// Deck surface bands: 0 asphalt, 1 paving, 2 bidegorri (red cycle lane), 3 timber, 4 ballast & track
const SURFACE = { asphalt: 0, paving: 1, bike: 2, wood: 3, track: 4 };
function surfaceOf(t) {
  if (t.railway) return SURFACE.track;
  if (t.surface === 'wood') return SURFACE.wood;
  if (t.highway === 'cycleway') return SURFACE.bike;
  if (['footway', 'pedestrian', 'path', 'steps'].includes(t.highway)) return SURFACE.paving;
  return SURFACE.asphalt;
}

const ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'residential', 'unclassified', 'service', 'living_street', 'cycleway',
  'footway', 'pedestrian', 'path']);
const TRACKS = new Set(['rail', 'narrow_gauge', 'light_rail', 'tram', 'subway']);

// Bridge ways split at every junction: chain them end to end (same level, same kind, carrying straight on) so each run
// ends on the ground at its abutments rather than in mid-air where the next way of the same viaduct begins
const raw = [];
for (const e of loadLayer('osm_streets.json').elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || e.geometry.length < 2 || !t.bridge || t.bridge === 'no' || t.area === 'yes') continue;
  if (!ROADS.has(t.highway) && !TRACKS.has(t.railway)) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  if (!pts.some(([x, z]) => inCore(x, z))) continue;
  raw.push({ id: e.id, t, pts, kind: t.railway ? 'rail' : 'road', layer: t.layer || '1' });
}
const keyOf = ([x, z]) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
// unit direction leaving the way at one of its ends, pointing out of the way
const outward = (w, end) => {
  const n = w.pts.length, [ax, az] = end ? w.pts[n - 2] : w.pts[1], [bx, bz] = end ? w.pts[n - 1] : w.pts[0];
  const len = Math.hypot(bx - ax, bz - az) || 1;
  return [(bx - ax) / len, (bz - az) / len];
};
const ends = new Map();
raw.forEach((w, i) => {
  for (const end of [0, 1]) {
    const key = keyOf(end ? w.pts[w.pts.length - 1] : w.pts[0]);
    if (!ends.has(key)) ends.set(key, []);
    ends.get(key).push([i, end]);
  }
});
const link = raw.map(() => [null, null]); // [way, end] joined at each end
for (const list of ends.values()) {
  const pairs = [];
  for (let p = 0; p < list.length; p++) {
    for (let q = p + 1; q < list.length; q++) {
      const [i, ei] = list[p], [j, ej] = list[q];
      if (i === j || raw[i].kind !== raw[j].kind || raw[i].layer !== raw[j].layer) continue;
      const a = outward(raw[i], ei), b = outward(raw[j], ej);
      const straight = -(a[0] * b[0] + a[1] * b[1]); // 1 when one carries straight on into the other
      if (straight > Math.cos((35 * Math.PI) / 180)) pairs.push([straight, p, q]);
    }
  }
  pairs.sort((x, y) => y[0] - x[0]);
  const used = new Set();
  for (const [, p, q] of pairs) {
    if (used.has(p) || used.has(q)) continue;
    used.add(p);
    used.add(q);
    const [i, ei] = list[p], [j, ej] = list[q];
    link[i][ei] = [j, ej];
    link[j][ej] = [i, ei];
  }
}
const ways = [];
const visited = new Set();
for (let i0 = 0; i0 < raw.length; i0++) {
  if (visited.has(i0)) continue;
  // walk back to the start of the chain (or round a loop), then forwards collecting the ways in order
  let i = i0, from = 0, guard = 0;
  while (link[i][from] && guard++ < raw.length) {
    const [j, ej] = link[i][from];
    if (j === i0) break;
    i = j;
    from = 1 - ej;
  }
  const pts = [], members = [];
  for (let step = 0; i !== null && !visited.has(i) && step <= raw.length; step++) {
    visited.add(i);
    members.push(raw[i]);
    const seq = from === 0 ? raw[i].pts : raw[i].pts.slice().reverse();
    pts.push(...(pts.length ? seq.slice(1) : seq));
    const next = link[i][1 - from];
    if (!next) break;
    [i, from] = next;
  }
  const L = lengthOf(pts);
  if (L < 8) continue; // crossings & stubs at the ends of the decks
  const main = members.reduce((m, w) => (lengthOf(w.pts) > lengthOf(m.pts) ? w : m));
  let wet = 0;
  for (let s = 0; s <= L; s += 1) { const [x, z] = pointAt(pts, s); if (isWet(x, z)) wet++; }
  const [x0, z0] = pts[0], [x1, z1] = pts[pts.length - 1];
  const len = Math.hypot(x1 - x0, z1 - z0) || 1;
  ways.push({
    id: members.map((m) => m.id), t: main.t, pts, L, wet, dir: [(x1 - x0) / len, (z1 - z0) / len],
    width: Math.max(...members.map((m) => deckWidth(m.t))), layer: main.layer, kind: main.kind
  });
}

// --- grouping: parallel ways side by side on the same level are one structure ------------------------------------------

const parent = ways.map((_, i) => i);
const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
for (let a = 0; a < ways.length; a++) {
  for (let b = a + 1; b < ways.length; b++) {
    const A = ways[a], B = ways[b];
    if (A.layer !== B.layer || A.kind !== B.kind) continue; // a railway beside a road is a bridge of its own
    if (Math.abs(A.dir[0] * B.dir[0] + A.dir[1] * B.dir[1]) < Math.cos((25 * Math.PI) / 180)) continue;
    const [sm, dm] = project(A.pts, ...pointAt(B.pts, B.L / 2).slice(0, 2));
    if (Math.abs(dm) > (A.width + B.width) / 2 + 6) continue;
    const s0 = project(A.pts, ...B.pts[0])[0], s1 = project(A.pts, ...B.pts[B.pts.length - 1])[0];
    const overlap = Math.min(A.L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1));
    if (overlap < 0.3 * Math.min(A.L, B.L) || sm < -10 || sm > A.L + 10) continue;
    parent[find(a)] = find(b);
  }
}
const groups = new Map();
ways.forEach((w, i) => {
  const g = find(i);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(w);
});

// --- structures ----------------------------------------------------------------------------------------------------------

function styleOf(members, overWater) {
  const names = members.map((m) => m.t.name || '').join('|');
  if (/Zurriola/.test(names)) return 'zurriola';
  if (/Santa Katalina/.test(names)) return 'stone';
  if (/Maria Kristina/.test(names)) return 'mariakristina';
  if (members.some((m) => m.t.railway)) return overWater ? 'truss' : 'viaduct';
  if (members.some((m) => /^(motorway|trunk)/.test(m.t.highway))) return 'viaduct'; // the GI-20 bypass, over the river too
  if (members.every((m) => ['footway', 'cycleway', 'path', 'pedestrian'].includes(m.t.highway))) return 'footbridge';
  return overWater ? 'modern' : 'viaduct';
}

// Spans over the water: masonry arches ~18 m, the 1905 María Kristina three arches, modern girders ~32 m
const SPAN = { stone: 18, mariakristina: 27, zurriola: 30, modern: 32, truss: 36, footbridge: 30, viaduct: 32 };

const bridges = [];
let skippedLand = 0;
for (const members of groups.values()) {
  members.sort((a, b) => b.L - a.L);
  const ref = members[0];
  // lateral layout across the reference way, longitudinal extent along it
  const lanes = members.map((m) => {
    let sum = 0, n = 0;
    for (let s = 0; s <= m.L; s += 2) { sum += project(ref.pts, ...pointAt(m.pts, s).slice(0, 2))[1]; n++; }
    return { off: sum / n, w: m.width, surface: surfaceOf(m.t) };
  });
  let sMin = Infinity, sMax = -Infinity;
  for (const m of members) {
    for (const p of [m.pts[0], m.pts[m.pts.length - 1]]) {
      const [s] = project(ref.pts, ...p);
      sMin = Math.min(sMin, s);
      sMax = Math.max(sMax, s);
    }
  }
  const lo = Math.min(...lanes.map((l) => l.off - l.w / 2)), hi = Math.max(...lanes.map((l) => l.off + l.w / 2));
  const centre = (lo + hi) / 2, width = hi - lo;
  // the centre line: the reference way resampled between sMin & sMax and shifted to the middle of the deck
  const length = sMax - sMin;
  const steps = Math.max(1, Math.ceil(length / 6));
  const axis = [];
  for (let q = 0; q <= steps; q++) {
    const [x, z, tx, tz] = pointAt(ref.pts, sMin + (length * q) / steps);
    axis.push([x - tz * centre, z + tx * centre]);
  }
  // simplify straight runs (most bridges are straight)
  const simple = [axis[0]];
  for (let q = 1; q < axis.length - 1; q++) {
    const [ax, az] = simple[simple.length - 1], [bx, bz] = axis[q + 1], [px, pz] = axis[q];
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
    if (Math.abs(((px - ax) * -dz + (pz - az) * dx) / len) > 0.15) simple.push(axis[q]);
  }
  simple.push(axis[axis.length - 1]);

  // surface bands across the deck (left edge -width / 2 .. right edge +width / 2), overlaps split, gaps shared
  const bands = lanes.map((l) => ({ a: l.off - l.w / 2 - centre, b: l.off + l.w / 2 - centre, surface: l.surface }))
    .sort((p, q) => p.a + p.b - q.a - q.b);
  for (let k = 1; k < bands.length; k++) {
    const mid = (bands[k - 1].b + bands[k].a) / 2;
    bands[k - 1].b = mid;
    bands[k].a = mid;
  }
  bands[0].a = -width / 2;
  bands[bands.length - 1].b = width / 2;
  const merged = [];
  for (const band of bands) {
    const last = merged[merged.length - 1];
    if (last && last.surface === band.surface) last.b = band.b;
    else if (band.b - band.a > 0.05) merged.push({ ...band });
  }

  // water under the deck (sampled across its width)
  let w0 = Infinity, w1 = -Infinity;
  for (let s = 0; s <= length; s += 1) {
    const [x, z, tx, tz] = pointAt(simple, s);
    for (const o of [-0.35, 0, 0.35]) {
      if (isWet(x - tz * o * width, z + tx * o * width)) { w0 = Math.min(w0, s); w1 = Math.max(w1, s); }
    }
  }
  const overWater = w1 > w0;

  // road level at both ends: the terrain just beyond each end, across the deck, upper-middle value (the lower ones are
  // riverside walks & ramps under the abutments)
  const level = (s, out) => {
    const ys = [];
    const [x, z, tx, tz] = pointAt(simple, s);
    for (const o of [-0.4, -0.2, 0, 0.2, 0.4]) {
      for (const d of [1.5, 3, 4.5, 6]) ys.push(heightAt(x + tx * d * out - tz * o * width, z + tz * d * out + tx * o * width));
    }
    ys.sort((p, q) => p - q);
    return ys[Math.floor(ys.length * 0.7)];
  };
  const y0 = level(0, -1), y1 = level(length, 1);
  const deckAt = (s) => y0 + ((y1 - y0) * s) / length;

  // clearance under the deck along the centre line: the ground model has no decks, so what stands above it is the
  // bridge; a deck that would run through the ground means the terrain kept it (or the end levels are wrong)
  let clear = 0, buried = 0;
  const ground = [];
  for (let s = 0; s <= length; s += 2) {
    const [x, z] = pointAt(simple, s);
    const g = heightAt(x, z);
    ground.push(g);
    const c = deckAt(s) - g;
    clear = Math.max(clear, c);
    if (c < -0.5) buried++;
  }
  const groundAt = (s) => ground[Math.max(0, Math.min(ground.length - 1, Math.round(s / 2)))];
  if (buried > 0.1 * ground.length || (!overWater && clear < 3)) { skippedLand++; continue; }
  if (overWater && Math.min(y0, y1) < 1) { skippedLand++; continue; } // a slipway or a ford, not a deck

  const style = styleOf(members, overWater);
  // piers: evenly over the water at the style's span, and every viaduct span over the land where the deck stands well
  // clear of the ground
  const piers = [];
  const landPiers = (a, b) => {
    const n = Math.round((b - a) / SPAN.viaduct);
    for (let k = 1; k < n; k++) {
      const s = a + ((b - a) * k) / n;
      if (deckAt(s) - groundAt(s) > 3) piers.push(s);
    }
  };
  if (overWater) {
    landPiers(0, w0);
    const n = Math.max(1, Math.round((w1 - w0) / SPAN[style]));
    for (let k = 1; k < n; k++) piers.push(w0 + ((w1 - w0) * k) / n);
    landPiers(w1, length);
  } else landPiers(0, length);
  piers.sort((p, q) => p - q);
  const name = members.map((m) => m.t.name).find((n) => n && /zubia|Puente|pasabidea/i.test(n)) ||
    members.map((m) => m.t.name).find(Boolean) || null;
  bridges.push({
    name, style, osm: members.flatMap((m) => m.id),
    axis: simple.flat().map(r2), width: r2(width),
    bands: merged.map((b) => [r2(b.a), r2(b.b), b.surface]),
    y: [r2(y0), r2(y1)],
    water: overWater ? [r2(w0), r2(w1)] : null,
    piers: piers.map(r2)
  });
}
bridges.sort((a, b) => (b.water ? 1 : 0) - (a.water ? 1 : 0) || b.width * lengthOfFlat(b.axis) - a.width * lengthOfFlat(a.axis));
function lengthOfFlat(f) {
  let L = 0;
  for (let k = 2; k < f.length; k += 2) L += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
  return L;
}

const js = '// js/donostia/data-bridges.js — generated by tools/donostia/bake-bridges.mjs; do not edit.\n' +
  '// © OpenStreetMap contributors (ODbL); heights from Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0).\n' +
  '// Each bridge: centre line axis [x, z, ...] (local metres), deck width, surface bands [from, to, surface] across it\n' +
  '// (0 asphalt, 1 paving, 2 bidegorri, 3 timber, 4 track), road level y at both ends, the stretch over the water\n' +
  '// [from, to] and the piers (arc lengths along the axis).\n' +
  `export const BRIDGES = ${JSON.stringify(bridges)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${bridges.length} bridges (${bridges.filter((b) => b.water).length} over the water), ` +
  `${skippedLand} decks the terrain keeps as ground skipped, ${(js.length / 1e3).toFixed(1)} kB`);
for (const b of bridges) {
  log(`  ${(b.name || '-').padEnd(32)} ${b.style.padEnd(13)} ${lengthOfFlat(b.axis).toFixed(0).padStart(4)} m x ${b.width.toFixed(1).padStart(5)} m, ` +
    `y ${b.y.join('..')}, water ${b.water ? b.water.join('..') : '-'}, piers ${b.piers.length}, bands ${b.bands.map((x) => x[2]).join('')}`);
}
