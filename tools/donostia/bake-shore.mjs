// tools/donostia/bake-shore.mjs
// usage: node tools/donostia/bake-shore.mjs [--preview <dir>]   (after build.mjs: it reads js/donostia/geodata.js and
// data/donostia/terrain-core.png)
// The rocks of the shore for js/donostia/shore.js -> js/donostia/data-shore.js, placed over the 2 m LiDAR terrain:
// - Urgull's foot: in front of the Paseo Nuevo's sea wall, the sandstone of the Igeldo & Urgull flysch as the LiDAR
//   has it, a rocky apron from the wall down into the sea: big fallen blocks against the wall, the bedded platforms of the
//   low ground as stacked slabs further out.
// - The Zurriola dike (OSM man_made=breakwater) and the Kursaal's bank of the river mouth below the Zurriola bridge:
//   tumbled concrete cubes.
// - The Urumea's quay walls: a riprap toe where the LiDAR, flown at low tide, found the bed above mean sea level at the
//   foot of the wall (GEO.terrain.walls' foot).
// - The port's two moles (tools/donostia/port.mjs): the concrete cubes on their seaward flanks.
// - The rest of the rocky coast (OSM natural=bare_rock: Santa Klara, Igeldo, Urgull's west point, Ulia): scattered
//   boulders along the waterline.
// Never on paving, a building, a bridge, a beach, the Kursaal's podium or the port's quays and slipway. Deterministic: seeded generators and a fixed
// visiting order.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, FRAME, loadLayer, lonLatToLocal, osmPolygons, scanRings, encodePNG, previewDir, licenceComment, log } from './lib.mjs';
import { decodePNG } from '../../js/donostia/png.js';
import { WALL, nearestWall, wallIndex } from '../../js/donostia/shore-walls.js';
import { MOLES, slipwayRing } from './port.mjs';

const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'js/donostia/data-shore.js');
const CORE = FRAME.core;
const PREVIEW = previewDir();
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);
const G = GEO.terrain.classes;
const walls = GEO.terrain.walls || [];
const wallsIndex = wallIndex(walls);

// Rock kinds: the geometries js/donostia/shore.js builds (KINDS there, in this order)
const KIND = { boulder: 0, boulder2: 1, boulder3: 2, slab: 3, slab2: 4, cube: 5, pebble: 6 };
const KIND_NAMES = Object.keys(KIND);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- terrain (the 2 m core grid of build.mjs) ---------------------------------------------------------------------------

const terrain = await (async () => {
  const meta = GEO.terrain.core;
  const file = fs.readFileSync(path.join(ROOT, meta.url));
  const img = await decodePNG(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const { x0, z0, w, h, res } = meta;
  const heights = new Float32Array(w * h), classes = new Uint8Array(w * h);
  for (let k = 0; k < heights.length; k++) {
    heights[k] = ((img.data[3 * k] << 8) | img.data[3 * k + 1]) / 100 - GEO.terrain.heightOffset;
    classes[k] = img.data[3 * k + 2];
  }
  // as HeightField.sample in js/donostia/terrain.js (samples at cell centres, clamped)
  const heightAt = (x, z) => {
    const fx = (x - x0) / res - 0.5, fz = (z - z0) / res - 0.5;
    let i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    i = Math.max(0, Math.min(w - 2, i));
    j = Math.max(0, Math.min(h - 2, j));
    const k = j * w + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + w] * (1 - tx) + heights[k + w + 1] * tx) * tz;
  };
  return { x0, z0, w, h, res, heights, classes, heightAt };
})();

// --- masks on the terrain's 2 m cells ----------------------------------------------------------------------------------

const { x0, z0, w: TW, h: TH, res } = terrain;
const cellX = (i) => x0 + (i + 0.5) * res, cellZ = (j) => z0 + (j + 0.5) * res;
const mask = () => new Uint8Array(TW * TH);
const paint = (m, rings, v = 1) => scanRings(rings, x0, z0, res, TW, TH, (i, j) => { m[j * TW + i] = v; });
const dilate = (m, r) => {
  const out = new Uint8Array(m);
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    if (!m[j * TW + i]) continue;
    for (let b = -r; b <= r; b++) for (let a = -r; a <= r; a++) {
      const ii = i + a, jj = j + b;
      if (ii >= 0 && jj >= 0 && ii < TW && jj < TH) out[jj * TW + ii] = 1;
    }
  }
  return out;
};

const places = loadLayer('osm_places.json').elements;
const osmAreas = (test) => places.filter((e) => test(e)).flatMap(osmPolygons);
// the Zurriola dike: the long breakwater east of the river mouth
const DIKE = 400267149;
const dike = mask();
for (const rings of osmAreas((e) => e.id === DIKE && e.tags?.man_made === 'breakwater')) paint(dike, rings);
// rocky ground: OSM breakwaters (the Paseo Nuevo's apron) & bare rock; the port's moles have cubes of their own (below)
const rocky = mask();
for (const rings of osmAreas((e) => (e.tags?.man_made === 'breakwater' && !MOLES.includes(e.id)) || e.tags?.natural === 'bare_rock')) paint(rocky, rings);
// The port (tools/donostia/port.mjs): its moles' seaward flanks, what their OSM outlines hold beyond the paved quays
// (the municipal map's KAIA), are banks of concrete cubes; no loose rock on the quays or down the old port's slipway
const portQuays = mask();
for (const f of loadLayer('c500_KAIA.json').features) paint(portQuays, f.g.filter((r) => r.length >= 6));
const slipway = slipwayRing(loadLayer);
if (slipway) paint(portQuays, [slipway]);
const moles = mask();
for (const rings of osmAreas((e) => MOLES.includes(e.id) && e.tags?.man_made === 'breakwater')) paint(moles, rings);
const portQuaysNear = dilate(portQuays, 1);
// no rocks: buildings, the beaches, the Kursaal (its podium & terraces) and the bridges
const blocked = mask();
for (const file of ['c500_ERAIKINA.json', 'c500_EraikinArinak.json', 'c500_HONDARTZA.json']) {
  for (const f of loadLayer(file).features) paint(blocked, f.g.filter((r) => r.length >= 6));
}
for (const rings of osmAreas((e) => e.tags?.natural === 'beach' && !e.tags?.tidal)) paint(blocked, rings);
for (const site of GEO.landmarks) if (/^kursaal/.test(site.id) && site.footprint) paint(blocked, [site.footprint]);
for (const e of loadLayer('osm_streets.json').elements) {
  const t = e.tags || {};
  if (e.type !== 'way' || !e.geometry || !t.bridge || t.bridge === 'no' || !(t.highway || t.railway)) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], len = Math.hypot(bx - ax, bz - az) || 1;
    for (let d = 0; d <= len; d += 1) {
      const i = Math.floor((ax + ((bx - ax) * d) / len - x0) / res), j = Math.floor((az + ((bz - az) * d) / len - z0) / res);
      if (i >= 0 && j >= 0 && i < TW && j < TH) blocked[j * TW + i] = 1;
    }
  }
}
const blockedNear = dilate(blocked, 3);
// the Kursaal's podium gets a wider berth
const kursaal = mask();
for (const site of GEO.landmarks) if (/^kursaal/.test(site.id) && site.footprint) paint(kursaal, [site.footprint]);
const kursaalNear = dilate(kursaal, 6);
const PAVED = new Set([G.road, G.sidewalk, G.pedestrian, G.bike, G.stairs, G.rail, G.building, G.beach, G.garden]);
const free = (k) => !blockedNear[k] && !kursaalNear[k] && !portQuaysNear[k] && !PAVED.has(terrain.classes[k]);

// the coastline, for the natural rocky shore
const coastNear = mask();
for (const e of places) {
  if (e.tags?.natural !== 'coastline' || !e.geometry) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  for (let k = 1; k < pts.length; k++) {
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k], len = Math.hypot(bx - ax, bz - az) || 1;
    for (let d = 0; d <= len; d += 1) {
      const i = Math.floor((ax + ((bx - ax) * d) / len - x0) / res), j = Math.floor((az + ((bz - az) * d) / len - z0) / res);
      if (i >= 0 && j >= 0 && i < TW && j < TH) coastNear[j * TW + i] = 1;
    }
  }
}
const coast = dilate(coastNear, 4);

const slopeAt = (x, z) => Math.hypot(terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;

// --- zones --------------------------------------------------------------------------------------------------------------

// Each zone: the cells it may use (with the nearest wall), a rock maker and a coverage. A rock: { kind, x, z, sx, sy, sz
// (full size, m), yaw, tiltX, tiltZ (rad), y (centre), tint (0..1) }.
const wallAt = (x, z, reach = 40) => nearestWall(walls, x, z, reach, wallsIndex);

const zones = [];
// in front of the Paseo Nuevo's wall (and the river mouth's west bank): the apron of fallen blocks & bedded slabs
zones.push({
  name: 'Urgull apron', seed: 11, coverage: 0.8,
  cell: (k, x, z, y) => {
    if (!free(k) || y < -1.4) return null;
    const q = wallAt(x, z, 60);
    if (!q || walls[q.wall].t !== WALL.paseo || q.d < 0.7 || y > q.foot + 0.8) return null;
    // the rubble the maps know of, and the low flat platforms of the bedded rock out to the sea
    if (!rocky[k] && !coast[k] && q.d > 12 && !(y < 4 && slopeAt(x, z) < 0.25)) return null;
    if (q.d > 38 && !(y < 4 && slopeAt(x, z) < 0.25)) return null;
    return q;
  },
  make: (rnd, q, x, z, y, slope) => {
    // big blocks against the wall, slabs on the low platforms further out (Urgull's north & west side)
    const flat = slope < 0.22 && y < 3.2 && q.d > 6;
    if (flat && rnd() < 0.85) {
      // the bedded platforms: wide, mostly buried, their layers stepping up out of the rock
      const l = 6 + rnd() * 6, b = 4 + rnd() * 4, t = 0.9 + rnd() * 0.9;
      return { kind: rnd() < 0.5 ? KIND.slab : KIND.slab2, sx: l, sy: t, sz: b, embed: 0.55, tilt: 0.06 };
    }
    const near = Math.max(0, 1 - q.d / 16);
    const s = 1.5 + rnd() * 1.8 + near * 1.6;
    return { kind: [KIND.boulder, KIND.boulder2, KIND.boulder3][Math.floor(rnd() * 3)], sx: s * (0.9 + rnd() * 0.5), sy: s * (0.6 + rnd() * 0.35), sz: s * (0.8 + rnd() * 0.4), embed: 0.38, tilt: 0.35 };
  }
});
// and the smaller stones between the blocks
zones.push({
  name: 'Urgull apron stones', seed: 13, coverage: 0.3,
  cell: (k, x, z, y) => zones[0].cell(k, x, z, y),
  make: (rnd) => {
    const s = 0.7 + rnd() * 0.9;
    return { kind: KIND.pebble, sx: s * (1 + rnd() * 0.5), sy: s * (0.55 + rnd() * 0.3), sz: s, embed: 0.3, tilt: 0.4 };
  }
});
// the Zurriola dike & the Kursaal's bank below the bridge: concrete cubes
const KURSAAL_BANK = { minX: 600, maxX: 760, minZ: -560, maxZ: -268 };
zones.push({
  name: 'Zurriola dike', seed: 23, coverage: 0.72,
  cell: (k, x, z, y) => {
    if (kursaalNear[k] || y < -1.6) return null;
    if (blockedNear[k] || PAVED.has(terrain.classes[k])) return null;
    if (dike[k]) {
      // (the OSM dike runs on along the bank: not up on the promenade behind its wall)
      const q = wallAt(x, z, 6);
      return q && q.d < 0.4 ? null : { d: 99 };
    }
    if (x < KURSAAL_BANK.minX || x > KURSAAL_BANK.maxX || z < KURSAAL_BANK.minZ || z > KURSAAL_BANK.maxZ) return null;
    const q = wallAt(x, z, 9);
    if (!q || walls[q.wall].t !== WALL.river || q.d < 0.5 || q.d > 7.5) return null;
    return q;
  },
  make: (rnd) => {
    const s = 1.9 + rnd() * 0.35;
    return { kind: KIND.cube, sx: s, sy: s * (0.95 + rnd() * 0.1), sz: s, embed: 0.2 + rnd() * 0.25, tilt: 0.55 };
  }
});
// the port's moles: their banks of concrete cubes, as on the Zurriola dike, up the flank to below the west mole's upper
// walkway (~9.7 m)
zones.push({
  name: 'port moles', seed: 29, coverage: 0.78,
  cell: (k, x, z, y) => {
    if (!moles[k] || portQuaysNear[k] || blockedNear[k] || y < -1.6 || y > 8.5 || PAVED.has(terrain.classes[k])) return null;
    return { d: 99 };
  },
  make: (rnd) => {
    const s = 1.9 + rnd() * 0.45;
    return { kind: KIND.cube, sx: s, sy: s * (0.95 + rnd() * 0.1), sz: s, embed: 0.2 + rnd() * 0.25, tilt: 0.55 };
  }
});
// the Urumea's quay walls: a riprap toe where the bed at the wall's foot dries at low tide
zones.push({
  name: 'Urumea toe', seed: 37, coverage: 0.16,
  cell: (k, x, z) => {
    if (!free(k)) return null;
    const q = wallAt(x, z, 5);
    if (!q || walls[q.wall].t !== WALL.river || q.d < 0.3 || q.d > 4 || q.foot < 0.25) return null;
    return q;
  },
  make: (rnd, q, x, z, y) => {
    // boulders sunk into the bed with their tops round the level the LiDAR found
    // (wide enough that what shows above the water reads as a stone, not a post)
    const top = q.foot - 0.1 + rnd() * 0.45 - Math.max(0, q.d - 1.5) * 0.15;
    const sy = Math.max(0.8, top - y + 0.4);
    const s = Math.max(1.1 + rnd() * 1.2, 0.75 * sy);
    const kind = [KIND.boulder, KIND.boulder2, KIND.boulder3][Math.floor(rnd() * 3)];
    return { kind, sx: s * (1 + rnd() * 0.4), sy, sz: s, top, tilt: 0.25 };
  }
});
// the rest of the rocky coast: boulders along the waterline
zones.push({
  name: 'rocky coast', seed: 53, coverage: 0.18,
  cell: (k, x, z, y) => {
    // mapped rock, or the coastline over unmapped ground (not across the river mouth's water)
    if (!free(k) || y < -1.0 || y > 2.6 || !(rocky[k] || (coast[k] && terrain.classes[k] === G.natural))) return null;
    if (slopeAt(x, z) < 0.06) return null; // the flat sand & mud of the coves
    const q = wallAt(x, z, 14);
    if (q) return null; // the walls' own zones
    return { d: 99 };
  },
  make: (rnd) => {
    const s = 1.4 + rnd() * 2.0;
    return { kind: [KIND.boulder, KIND.boulder2, KIND.boulder3][Math.floor(rnd() * 3)], sx: s * (0.9 + rnd() * 0.5), sy: s * (0.55 + rnd() * 0.35), sz: s * (0.8 + rnd() * 0.4), embed: 0.35, tilt: 0.3 };
  }
});

// --- placement: dart throwing over each zone's cells, in a fixed order -----------------------------------------------------

const rocks = [];
const HASH = 4; // m
const hash = new Map();
const hkey = (x, z) => Math.floor(z / HASH) * 100000 + Math.floor(x / HASH);
const crowded = (x, z, r) => {
  const ci = Math.floor(x / HASH), cj = Math.floor(z / HASH), reach = Math.ceil((r + 4) / HASH);
  for (let b = -reach; b <= reach; b++) for (let a = -reach; a <= reach; a++) {
    for (const o of hash.get((cj + b) * 100000 + ci + a) || []) if (Math.hypot(o.x - x, o.z - z) < 0.8 * (r + o.r)) return true;
  }
  return false;
};
const stats = [];
for (const zone of zones) {
  const rnd = mulberry32(zone.seed * 7919);
  const cells = [];
  let area = 0;
  for (let j = 0; j < TH; j++) for (let i = 0; i < TW; i++) {
    const k = j * TW + i, x = cellX(i), z = cellZ(j);
    if (x < CORE.minX + 4 || x > CORE.maxX - 4 || z < CORE.minZ + 4 || z > CORE.maxZ - 4) continue;
    const q = zone.cell(k, x, z, terrain.heights[k]);
    if (q) { cells.push([k, x, z, q]); area += res * res; }
  }
  // darts: enough tries for the coverage, each at a random point of a random cell
  let placed = 0, covered = 0;
  const tries = Math.round((area / 2.5) * 6);
  for (let t = 0; t < tries && covered < zone.coverage * area; t++) {
    const [, cx, cz] = cells[Math.floor(rnd() * cells.length)];
    const x = cx + (rnd() - 0.5) * res, z = cz + (rnd() - 0.5) * res;
    const k = Math.floor((z - z0) / res) * TW + Math.floor((x - x0) / res);
    const q = zone.cell(k, x, z, terrain.heights[k]);
    if (!q) continue;
    const y0 = terrain.heightAt(x, z);
    const spec = zone.make(rnd, q, x, z, y0, slopeAt(x, z));
    const r = 0.5 * Math.max(spec.sx, spec.sz);
    if (crowded(x, z, r)) continue;
    // resting on the lowest ground under it, sunk by `embed` of its height (or with its top at `top`)
    let base = Infinity;
    for (const [a, b] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) base = Math.min(base, terrain.heightAt(x + a * r * 0.7, z + b * r * 0.7));
    const y = spec.top != null ? spec.top - spec.sy / 2 : base + spec.sy * (0.5 - spec.embed);
    const rock = {
      kind: spec.kind, x, z, y, sx: spec.sx, sy: spec.sy, sz: spec.sz, r,
      yaw: rnd() * Math.PI * 2, tiltX: (rnd() - 0.5) * 2 * spec.tilt, tiltZ: (rnd() - 0.5) * 2 * spec.tilt, tint: rnd()
    };
    rocks.push(rock);
    const key = hkey(x, z);
    if (!hash.has(key)) hash.set(key, []);
    hash.get(key).push(rock);
    placed++;
    covered += Math.PI * r * r * 0.8;
  }
  stats.push(`${zone.name} ${placed} (${(area / 1e4).toFixed(2)} ha)`);
}
log(`shore rocks: ${rocks.length} — ${stats.join(', ')}`);

// --- output: Int32 x, z (cm) | Int16 y (cm) | Uint8 yaw, tiltX, tiltZ, sx, sy, sz, kind, tint ------------------------------

const N = rocks.length;
const buf = Buffer.alloc(N * 18);
const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
rocks.forEach((r, i) => {
  buf.writeInt32LE(Math.round(r.x * 100), 8 * i);
  buf.writeInt32LE(Math.round(r.z * 100), 8 * i + 4);
  buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r.y * 100))), 8 * N + 2 * i);
  const o = 10 * N + 8 * i;
  buf[o] = u8((r.yaw / (Math.PI * 2)) * 256) & 255;
  buf[o + 1] = u8(128 + (r.tiltX * 180) / Math.PI);
  buf[o + 2] = u8(128 + (r.tiltZ * 180) / Math.PI);
  buf[o + 3] = u8(r.sx * 20);
  buf[o + 4] = u8(r.sy * 20);
  buf[o + 5] = u8(r.sz * 20);
  buf[o + 6] = r.kind;
  buf[o + 7] = u8(r.tint * 255);
});
const DATA_OUT = {
  // Int32 x[N], z[N] interleaved (cm) | Int16 y[N] (cm, the centre) | Uint8 per rock: yaw (256ths of a turn), tilt about
  // x & z (degrees + 128), size x, y, z (5 cm steps), kind (KINDS), tint (0..255); base64
  rocks: { count: N, kinds: KIND_NAMES, data: buf.toString('base64') }
};
const js = '// js/donostia/data-shore.js — generated by tools/donostia/bake-shore.mjs; do not edit.\n' +
  '// © OpenStreetMap contributors (ODbL) · Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal ' +
  '1:500 (CC BY-SA 3.0) · Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0)\n' +
  licenceComment('osm', 'c500', 'geoeuskadi') +
  `export const SHORE = ${JSON.stringify(DATA_OUT)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${(js.length / 1e3).toFixed(1)} kB`);

// --preview <dir>: the rocks over the terrain classes around Urgull and the river mouth
if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const view = (name, vx0, vz0, vx1, vz1, mpp) => {
    const w = Math.round((vx1 - vx0) / mpp), h = Math.round((vz1 - vz0) / mpp), px = new Uint8Array(w * h * 3);
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const x = vx0 + (i + 0.5) * mpp, z = vz0 + (j + 0.5) * mpp;
      const ti = Math.floor((x - x0) / res), tj = Math.floor((z - z0) / res), k = tj * TW + ti;
      const y = terrain.heights[k], c = terrain.classes[k];
      const g = c === G.water ? [40, 70, 110] : [90 + Math.min(120, y * 6), 90 + Math.min(120, y * 6), 80];
      px.set(g, 3 * (j * w + i));
    }
    for (const r of rocks) {
      const col = r.kind === KIND.cube ? [230, 230, 230] : r.kind >= KIND.slab ? [255, 170, 60] : [200, 120, 60];
      const ci = (r.x - vx0) / mpp, cj = (r.z - vz0) / mpp, rr = r.r / mpp;
      for (let b = Math.floor(cj - rr); b <= cj + rr; b++) for (let a = Math.floor(ci - rr); a <= ci + rr; a++) {
        if (a < 0 || b < 0 || a >= w || b >= h || Math.hypot(a - ci, b - cj) > rr) continue;
        px.set(col, 3 * (b * w + a));
      }
    }
    fs.writeFileSync(path.join(PREVIEW, `shore-${name}.png`), encodePNG(px, w, h, 3));
  };
  view('urgull', -480, -720, 760, -150, 0.5);
  view('mouth', 540, -880, 920, -150, 0.5);
  log(`previews in ${PREVIEW}`);
}
