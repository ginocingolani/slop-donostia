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
import { HERE, FRAME, HEIGHT_OFFSET, loadLayer, lonLatToLocal, licenceComment, log } from './lib.mjs';

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

// Deck surface bands: 0 asphalt, 1 paving, 2 bidegorri (red cycle lane), 3 timber, 4 ballast & track, 5 coloured tiles
const SURFACE = { asphalt: 0, paving: 1, bike: 2, wood: 3, track: 4, tiles: 5 };
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

// --- what the map can't tell ---------------------------------------------------------------------------------------------

// The Urumea's bridges as built: style, spans (n equal spans over the water, or their lengths in metres centred on it,
// null = what's left of the water; between pier faces when `clear`), pier thickness, true deck width, girder depths,
// deck levels. `from` names the end that per-end values
// (width, depth, y) start at, whichever way the OSM ways run. Sources: Donostiako Udala, PEPPUC 2021 (heritage
// catalogue sheets A-30 Zurriola, F-10 Santa Katalina); Wikipedia; Structurae; Metalocus (Mikel Laboa); ondavasca.com
// (Astiñene); Gipuzkoa's tourism board (María Kristina obelisks, Lehendakari Agirre tiles).
const KNOWN = [
  // Zurriola (J. Eugenio Ribera's 1915 project for three 30 m arches gave way in 1917 to straight reinforced-concrete
  // spans on three central piers; opened 1921): four spans; Víctor Arana's lamp columns crown the cutwaters
  // (its banks are too ragged at the river mouth to measure a skew; the photos show its piers square to the deck)
  { name: /^Zurriolako zubia$/, style: 'zurriola', spans: 4, pier: 3, skew: 0 },
  // Santa Katalina (Antonio Cortázar, 1869-72; widened to 25 m by Juan Machimbarrena in 1924): five elliptical vaults,
  // one blinded when the Paseo de Francia quay was built, so four
  { name: /^Santa Katalina Zubia$/, style: 'katalina', spans: 4, pier: 4.6 },
  // María Kristina (José Eugenio Ribera & Julio Martínez-Zapata, 1905): three 24 m arches, 88 m x 20 m, four 18 m obelisks
  { name: /^Maria Kristina zubia$/, style: 'mariakristina', spans: [24, 24, 24], clear: true, pier: 5, width: 20 },
  // Mundaiz (Julio Martínez Calzón & José Antonio Fernández Ordóñez, 2000): composite girder, one 79.84 m span, the
  // first Urumea bridge without supports in the river
  { name: /^(Mundaiz zubia|Puente de Mundaiz)$/, style: 'girder', spans: [79.84], depth: [3.2, 1.8, 3.2], colour: 'light' },
  // Lehendakari Agirre (2010): no supports in the river bed either; paved with 45,000 tiles in eight colours
  { name: /^(Jose Antonio Agirre zubia|Puente del Lehendakari Aguirre)$/, style: 'girder', spans: 1, depth: [3.0, 1.6, 3.0], tiles: true, colour: 'light' },
  // Real Sociedad (2010, on the site of the 1864 Puente de Hierro): two piers, in line with the railway bridge's
  { name: /^Puente de la Real Sociedad$/, style: 'modern', spans: 3, pier: 2.4 },
  // the Adif railway bridge beside it (OSM keeps the old iron bridge's name on it): two piers
  { name: /^Puente de Hierro$/, style: 'railgirder', spans: 3, pier: 2.4 },
  // Mikel Laboa footbridge (Anta IC & Agence TER, 2009): a continuous steel box girder of 9.24 + 73.92 + 9.24 m, nil
  // deep at its ends, 2.9 m over the park pier, 1.2 m at mid-span, 2.2 m over the Riberas pier; 6.4 m wide on the
  // Cristina Enea side narrowing to 3 m; timber deck
  {
    name: /^Mikel Laboa$/, style: 'girder', spans: [9.24, 73.92, 9.24], from: [1120.5, 1057.6], width: [6.4, 3],
    depth: [0, 2.9, 1.2, 2.2, 0], colour: 'steel'
  },
  // Astiñene (2022): steel girders, a 40 m central span lifted in one piece; deck levels from the LiDAR road at its
  // abutments (Egia's approach climbs steeply away from the north end)
  {
    name: /^Astiñene zubia$/, style: 'girder', spans: [null, 40, null], pier: 2, depth: [1.4, 2.2, 1.5, 2.2, 1.4],
    colour: 'steel', from: [1631.6, 718.6], y: [6.7, 4.6]
  },
  // Urdintzu, the barracks' bridge (1926): three stone arches of 16, 18 & 16 m, 56 m x 10 m
  { name: /^Urdintzuko zubia$/, style: 'stone', spans: [16, 18, 16], clear: true, pier: 3, width: 10 },
  // Gladys del Estal footbridge (2009) from Cristina Enea park over the railway to the riverside walk, where a lift
  // (1:500 map) takes it down: the deck clears the catenary (rails ~4.6 m + 6.5 m + structure) and the LiDAR keeps a
  // patch of it at 13 m two thirds of the way across; it lands on the park's hillside a few steps below the path
  { name: /^Gladys del Estal$/, style: 'footbridge', from: [973.1, 1004.2], y: [13.6, 12.0] }
];
const knownOf = (members) => KNOWN.find((k) => members.some((m) => k.name.test(m.t.name || '')));

function styleOf(members, overWater, known) {
  if (known?.style) return known.style;
  if (members.some((m) => m.t.railway)) return overWater ? 'railgirder' : 'viaduct';
  if (members.some((m) => /^(motorway|trunk)/.test(m.t.highway))) return 'viaduct'; // the GI-20 bypass, over the river too
  if (members.every((m) => ['footway', 'cycleway', 'path', 'pedestrian'].includes(m.t.highway))) return 'footbridge';
  return overWater ? 'modern' : 'viaduct';
}

// Spans of the bridges the table doesn't know: modern girders ~32 m
const SPAN = { modern: 32, railgirder: 32, footbridge: 30, viaduct: 32, girder: 32 };
// A land bridge's deck runs on past an end of its OSM way, in LAND_STEP m steps up to LAND_REACH m, while the ground
// beyond still climbs faster than LAND_GRADE (a steep street's grade) and comes out of a cutting at least LAND_CUT m
// deep; a run under LAND_MIN m is the terrain's noise
const LAND_STEP = 2, LAND_REACH = 24, LAND_GRADE = 0.15, LAND_MIN = 4, LAND_CUT = 2.5;

// Exterior lifts of the 1:500 map: a footbridge ending at one doesn't come down to the ground there
const LIFTS = loadLayer('c500_KANPO-IGOGAILUA.json').features.map((f) => {
  const r = f.g[0];
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  return [(2 * x) / r.length, (2 * z) / r.length];
});
const liftNear = (x, z) => LIFTS.find(([lx, lz]) => Math.hypot(lx - x, lz - z) < 5);

const bridges = [];
let skippedLand = 0;
// the reference way of a structure: a carriageway or track over the paths beside it (a footway may hook off down a
// ramp at one end), then the longest end to end
const chord = (w) => Math.hypot(w.pts[w.pts.length - 1][0] - w.pts[0][0], w.pts[w.pts.length - 1][1] - w.pts[0][1]);
const carries = (w) => (w.kind === 'rail' || !['footway', 'cycleway', 'path', 'pedestrian', 'steps'].includes(w.t.highway) ? 1 : 0);
for (const members of groups.values()) {
  members.sort((a, b) => carries(b) - carries(a) || chord(b) - chord(a));
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
  const known = knownOf(members);
  // the centre line: the reference way resampled between sMin & sMax and shifted to the middle of the deck
  let length = sMax - sMin;
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


  // surface bands across the deck as fractions of its width (-0.5 left edge .. 0.5 right edge), overlaps split, gaps
  // shared
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
  if (known?.tiles) for (const band of merged) if (band.surface === SURFACE.paving) band.surface = SURFACE.tiles;

  // water under the deck (sampled across its width)
  let w0 = Infinity, w1 = -Infinity;
  for (let s = 0; s <= length; s += 1) {
    const [x, z, tx, tz] = pointAt(simple, s);
    for (const o of [-0.35, 0, 0.35]) {
      if (isWet(x - tz * o * width, z + tx * o * width)) { w0 = Math.min(w0, s); w1 = Math.max(w1, s); }
    }
  }
  const overWater = w1 > w0;

  // A road or railway bridge whose OSM way stops short of where it lands: beyond that end the terrain (bare earth, no
  // decks) is still climbing out of the cutting under the deck. The deck runs on along its end's heading to where the
  // ground levels off to a road's grade, so it neither ends in mid-air nor takes its level from the cutting's slope.
  // Ground that keeps climbing past LAND_REACH is a hillside, not a cutting; footbridges land on steps & ramps
  if (!overWater && !known && carries(ref)) {
    for (const end of [0, 1]) {
      const [x, z, tx, tz] = pointAt(simple, end ? length : 0);
      if (liftNear(x, z)) continue;
      const out = end ? 1 : -1;
      const ground = (d) => {
        const ys = [-0.3, 0, 0.3].map((o) => heightAt(x + tx * out * d - tz * o * width, z + tz * out * d + tx * o * width));
        return ys.sort((p, q) => p - q)[1];
      };
      let d = 0, levels = false;
      while (d < LAND_REACH) {
        if (ground(d + LAND_STEP) - ground(d) <= LAND_GRADE * LAND_STEP) { levels = true; break; }
        d += LAND_STEP;
      }
      if (!levels || d < LAND_MIN || ground(d) - ground(0) < LAND_CUT) continue;
      const k = end ? simple.length - 1 : 0;
      simple[k] = [simple[k][0] + tx * out * d, simple[k][1] + tz * out * d];
      length += d;
      log(`${members.map((m) => m.t.name).find(Boolean) || `way ${ref.id}`}: deck runs on ${d} m past its ${end ? 'end' : 'start'} to where the ground levels off`);
    }
  }

  // the banks a few metres outside both edges (build.mjs squares the water off under the deck): a bridge askew to the
  // current stands its piers parallel to the banks, not square to its deck. skew = metres along the deck per metre to
  // its right; measured on straight decks only (along a curve the offset lines meet the banks wherever they please)
  const bankAt = (o) => {
    let a = null, b = null;
    for (let s = -12; s <= length + 12; s += 0.5) {
      const [x, z, tx, tz] = pointAt(simple, s);
      if (isWet(x - tz * o, z + tx * o)) { if (a === null) a = s; b = s; }
    }
    return [a, b];
  };
  let skew = 0;
  if (overWater && simple.length === 2) {
    const o = width / 2 + 5, [la, lb] = bankAt(-o), [ra, rb] = bankAt(o);
    if (la !== null && ra !== null) skew = (la - ra + lb - rb) / (4 * o);
    skew = Math.abs(skew) < 0.08 ? 0 : Math.max(-0.45, Math.min(0.45, skew));
  }
  if (known && 'skew' in known) skew = known.skew;

  // road level at both ends: the terrain just beyond each end, across the deck, upper-middle value (the lower ones are
  // riverside walks & ramps under the abutments)
  const level = (s, out, ds = [1.5, 3, 4.5, 6]) => {
    const ys = [];
    const [x, z, tx, tz] = pointAt(simple, s);
    for (const o of [-0.4, -0.2, 0, 0.2, 0.4]) {
      for (const d of ds) ys.push(heightAt(x + tx * d * out - tz * o * width, z + tz * d * out + tx * o * width));
    }
    ys.sort((p, q) => p - q);
    return ys[Math.floor(ys.length * 0.7)];
  };
  let y0 = level(0, -1), y1 = level(length, 1);
  // a footbridge that ends at a lift stays up there, level with the ground where its other end lands (on a hillside
  // that keeps climbing: the ground at the end itself, not beyond it)
  const [ax, az] = simple[0], [bx, bz] = simple[simple.length - 1];
  const lifts = [liftNear(ax, az), liftNear(bx, bz)];
  if (lifts[0] && !lifts[1]) y0 = y1 = level(length, 1, [0, 0.75, 1.5]);
  if (lifts[1] && !lifts[0]) y1 = y0 = level(0, -1, [0, 0.75, 1.5]);
  // per-end facts in the table run from its `from` end
  const flip = !!known?.from && Math.hypot(bx - known.from[0], bz - known.from[1]) < Math.hypot(ax - known.from[0], az - known.from[1]);
  const ends = (v) => (flip ? v.slice().reverse() : v);
  if (known?.y) [y0, y1] = ends(known.y);
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
  if (!known && (buried > 0.1 * ground.length || (!overWater && clear < 3))) { skippedLand++; continue; }
  if (overWater && Math.min(y0, y1) < 1) { skippedLand++; continue; } // a slipway or a ford, not a deck

  const style = styleOf(members, overWater, known);
  // supports over the water: abutments & river piers, from the table's spans or evenly at the style's span
  let supports = null;
  if (overWater) {
    const spans = known?.spans ?? Math.max(1, Math.round((w1 - w0) / SPAN[style]));
    if (typeof spans === 'number') supports = Array.from({ length: spans + 1 }, (_, k) => w0 + ((w1 - w0) * k) / spans);
    else {
      // clear spans between the pier faces: support to support takes half a pier more at each pier
      const pw = known.clear ? known.pier : 0;
      const sized = spans.map((v, k) => (v === null ? null : v + (pw * ((k > 0) + (k < spans.length - 1))) / 2));
      const fixed = sized.reduce((a, v) => a + (v ?? 0), 0), free = sized.filter((v) => v === null).length;
      const lens = ends(sized.map((v) => v ?? Math.max(4, (w1 - w0 - fixed) / free)));
      let s = (w0 + w1) / 2 - lens.reduce((a, v) => a + v, 0) / 2;
      supports = [s];
      for (const l of lens) supports.push((s += l));
    }
  }
  // piers: the supports between the abutments, and every viaduct span over the land where the deck stands well clear
  // of the ground
  const piers = supports ? supports.slice(1, -1) : [];
  const landPiers = (a, b) => {
    const n = Math.round((b - a) / SPAN.viaduct);
    for (let k = 1; k < n; k++) {
      const s = a + ((b - a) * k) / n;
      if (deckAt(s) - groundAt(s) > 3) piers.push(s);
    }
  };
  if (supports) {
    landPiers(0, supports[0]);
    landPiers(supports[supports.length - 1], length);
  } else landPiers(0, length);
  piers.sort((p, q) => p - q);
  // girder depth at the supports & mid-span of the main (longest) span
  let depth = null;
  if (known?.depth && supports) {
    const at = supports.slice();
    let main = 1;
    for (let k = 2; k < supports.length; k++) if (supports[k] - supports[k - 1] > supports[main] - supports[main - 1]) main = k;
    at.splice(main, 0, (supports[main - 1] + supports[main]) / 2);
    depth = ends(known.depth).map((d, k) => [r2(at[k]), d]);
  }
  const name = members.map((m) => m.t.name).find((n) => n && /zubia|Puente|pasabidea/i.test(n)) ||
    members.map((m) => m.t.name).find(Boolean) || null;
  const deckWidthOut = Array.isArray(known?.width) ? ends(known.width) : known?.width ?? r2(width);
  bridges.push({
    name, style, osm: members.flatMap((m) => m.id),
    axis: simple.flat().map(r2), width: deckWidthOut,
    bands: merged.map((b) => [+(b.a / width).toFixed(4), +(b.b / width).toFixed(4), b.surface]),
    y: [r2(y0), r2(y1)],
    water: overWater ? [r2(w0), r2(w1)] : null,
    supports: supports ? supports.map(r2) : null,
    piers: piers.map(r2),
    ...(known?.pier ? { pier: known.pier } : {}),
    ...(skew ? { skew: +skew.toFixed(3) } : {}),
    ...(depth ? { depth } : {}),
    ...(known?.colour ? { tone: known.colour } : {}),
    ...(lifts.some(Boolean) ? {
      lift: lifts.map((l, end) => (l ? [r2(l[0]), r2(l[1]), r2(heightAt(l[0], l[1])), end] : null)).filter(Boolean)
    } : {})
  });
}
const widthOf = (b) => (Array.isArray(b.width) ? (b.width[0] + b.width[1]) / 2 : b.width);
bridges.sort((a, b) => (b.water ? 1 : 0) - (a.water ? 1 : 0) || widthOf(b) * lengthOfFlat(b.axis) - widthOf(a) * lengthOfFlat(a.axis));
function lengthOfFlat(f) {
  let L = 0;
  for (let k = 2; k < f.length; k += 2) L += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
  return L;
}

const js = '// js/donostia/data-bridges.js — generated by tools/donostia/bake-bridges.mjs; do not edit.\n' +
  '// © OpenStreetMap contributors (ODbL); heights from Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0); lifts\n' +
  '// from Donostiako Udala\'s 1:500 map (CC BY-SA 3.0).\n' +
  licenceComment('osm', 'c500', 'geoeuskadi') +
  '// Each bridge: centre line axis [x, z, ...] (local metres), deck width (or [at start, at end]), surface bands\n' +
  '// [from, to, surface] across it as fractions of the width (0 asphalt, 1 paving, 2 bidegorri, 3 timber, 4 track,\n' +
  '// 5 coloured tiles), road level y at both ends, the stretch over the water [from, to], its supports (abutments &\n' +
  '// river piers) and every pier (arc lengths along the axis); optionally the pier thickness, their skew (metres along per metre\n' +
  '// across), girder depths [[s, depth], ...], a tone for the steelwork and the lifts at its ends [x, z, ground, end].\n' +
  `export const BRIDGES = ${JSON.stringify(bridges)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${bridges.length} bridges (${bridges.filter((b) => b.water).length} over the water), ` +
  `${skippedLand} decks the terrain keeps as ground skipped, ${(js.length / 1e3).toFixed(1)} kB`);
for (const b of bridges) {
  const w = Array.isArray(b.width) ? b.width.join('-') : b.width.toFixed(1);
  log(`  ${(b.name || '-').padEnd(32)} ${b.style.padEnd(13)} ${lengthOfFlat(b.axis).toFixed(0).padStart(4)} m x ${w.padStart(5)} m, ` +
    `y ${b.y.join('..')}, water ${b.water ? b.water.join('..') : '-'}, supports ${b.supports ? b.supports.join(',') : '-'}, ` +
    `piers ${b.piers.length}${b.skew ? `, skew ${b.skew}` : ''}${b.lift ? ', lift' : ''}, bands ${b.bands.map((x) => x[2]).join('')}`);
}
