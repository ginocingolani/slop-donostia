// tools/donostia/bake-streetlight.mjs
// The city's public lighting, for js/donostia/street-light.js (the light the ground, the facades, the trees and the
// street furniture pick up at night) and js/donostia/streetscape.js (the lamps that are modelled):
//   node tools/donostia/bake-streetlight.mjs [--preview <dir>]
//     -> data/donostia/street-light.png      how much lamplight falls on every 2 m of the core (one grey byte)
//     -> data/donostia/street-light-low.png  the same every 4 m (its 2 x 2 means), for the lowest quality tier
//     -> js/donostia/data-streetlight.js     the lamps this bake places where none is mapped, for streetscape.js
// Inputs are all committed: OpenStreetMap's streets with their class, `lit`, tunnels and bridges
// (tools/donostia/data/osm_streets.json, ODbL), the municipal 1:500 map's ground (roads, pavements, pedestrian zones,
// gardens, woods, beaches, rail; Donostiako Udala, CC BY-SA 3.0), the baked terrain's water (geoEuskadi's LiDAR,
// CC BY 4.0), the buildings of js/donostia/geodata.js (b5m, CC BY 4.0) and the lamps js/donostia/data-streetscape.js
// already carries (OSM's street lamps, the Parte Vieja's wall lanterns, La Concha's lamp posts, candelabra and
// obelisks). Run it after bake-streetscape.mjs.
//
// What is modelled. OSM maps about a thousand street lamps in the core, nearly all of them along the bay, the river
// and a few squares; the municipal inventory of luminaires is not published as open data. So the lamps a street must
// have are placed along the street network, by the rules a lighting engineer would start from (EN 13201's classes
// and the usual mounting heights and spacings of Spanish municipal practice; the figures are typical ones, not a
// survey of Donostia's installation):
//   - avenues (OSM primary, secondary, tertiary and their links, bus lanes): 9 m columns every 26 m, staggered across
//     the carriageway, standing on the pavement 0.7 m behind the kerb;
//   - the urban motorway and its slip roads: 12 m columns every 42 m;
//   - residential and local streets (residential, unclassified, living_street): 7 m columns every 28 m, staggered;
//   - service roads, alleys and car parks' aisles: 7 m columns every 36 m, dimmer; no driveways;
//   - pedestrian streets and squares: 4 m lanterns every 16 m; squares wider than their outline's lamps reach are
//     filled in on a 17 m triangular grid;
//   - footpaths, cycle paths and steps: 4 m lanterns every 24 m; through gardens, woods and open ground only half as
//     bright and every 30 m; OSM paths and tracks (the hills' trails) only where they are tagged lit;
//   - where a street is too narrow for a post (a facade within 2.6 m of its axis), a lantern on a bracket on the
//     facade, as in the Parte Vieja;
//   - pavements more than 30 m from any lamp (streets OSM lacks) get a 7 m column;
//   - none on Santa Klara (the island has no public lighting);
//   - nothing where OSM says lit=no, in tunnels, covered passages or anything below ground (layer < 0), on water,
//     sand or rail; a bridge gets its light along its axis without posts (js/donostia/bridges.js has their lamps).
// A lamp is dropped when another (mapped or placed) already stands within about half its spacing, so streets drawn
// as several ways, their pavements' own footways and the mapped lamps never double up. Everything is deterministic:
// the ways in OSM's order by class, phases from the way's id.
//
// The light of a lamp of luminous strength I at height h on the ground d metres from its foot follows the point
// source's cosine-cubed law softened as real street optics throw wider than a bare point:
//   E(d) = I / (1 + (d / r0)^2)^1.5, r0 = 1.05 h, windowed to nothing at 3.2 r0
// Buildings shadow it (a ray over the 1 m footprint raster, so a street's lamps do not light the courtyard behind
// the block, yet reach 1.5 m into the wall they meet: the facades read the light at their foot), and a fifth of a
// wide blur of the result comes back as the streets' own bounce. Water gets none (the seabed shows through it),
// but for the bridges' own light, which their decks read; the light map is the sum, stored as sqrt(E / 2) in a byte
// (twice the light under an avenue's lamp is the brightest it holds), its rim black so that nothing shows past it.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { HERE, FRAME, loadLayer, lonLatToLocal, scanRings, encodePNG, previewDir, licenceComment, pngText, log } from './lib.mjs';

const ROOT = path.resolve(HERE, '../..');
const OUT_MAP = path.join(ROOT, 'data/donostia/street-light.png');
const OUT_MAP_LOW = path.join(ROOT, 'data/donostia/street-light-low.png');
const OUT_JS = path.join(ROOT, 'js/donostia/data-streetlight.js');
const CORE = FRAME.core;
const PREVIEW = previewDir();
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);
const { STREETSCAPE } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/data-streetscape.js')).href);
const G = GEO.terrain.classes;

const MAP_RES = 2; // m per texel
const E_MAX = 2; // the light a full byte stands for
// the byte is sqrt(E / E_MAX) in 51 steps of 5: the steps are finer than the eye in the dim light between the lamps,
// and the PNG is 40% smaller than with all 255
const LEVELS = 51;

function hash2(x, z, s = 0) {
  let h = Math.imul(Math.floor(x) | 0, 0x27d4eb2d) ^ Math.imul(Math.floor(z) | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// --- rasters over the core (1 m): the ground's class, the buildings ---------------------------------------------------

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

// the terrain's own 2 m classes: the water (its flood fill) comes from here
const terrainClass = (() => {
  const meta = GEO.terrain.core;
  const img = decodePNG(fs.readFileSync(path.join(ROOT, meta.url)));
  const { x0, z0, w, h, res } = meta;
  return (x, z) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((z - z0) / res);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : img.data[3 * (j * w + i) + 2];
  };
})();

const R = { x0: CORE.minX, z0: CORE.minZ, w: CORE.maxX - CORE.minX, h: CORE.maxZ - CORE.minZ };
const cellOf = (x, z) => {
  const i = Math.floor(x - R.x0), j = Math.floor(z - R.z0);
  return i < 0 || j < 0 || i >= R.w || j >= R.h ? -1 : j * R.w + i;
};
const inCore = (x, z, m = 2) => x > CORE.minX + m && x < CORE.maxX - m && z > CORE.minZ + m && z < CORE.maxZ - m;

// The ground classes at 1 m, as bake-streetscape.mjs lays them (build.mjs's GROUND_LAYERS, later layers win)
const SURFACE_LAYERS = [
  ['c500_ZuhaiztiGuneak.json', G.woodland],
  ['c500_LORATEGI_EREMUA.json', G.garden], ['c500_PARTERREA.json', G.garden],
  ['c500_SASOIKO_LORATEGIA.json', G.garden], ['c500_LANDARE_HESIA.json', G.garden],
  ['c500_HONDARTZA.json', G.beach],
  ['c500_BIDEA.json', G.pedestrian], ['c500_OINEZKOEN_ZONA.json', G.pedestrian],
  ['c500_ESPALOIA.json', G.sidewalk],
  ['c500_ERREPIDEA.json', G.road], ['c500_IBILGAILUEN_ZONA.json', G.road], ['c500_AUTOBIDEA.json', G.road],
  ['c500_TRENBIDEA.json', G.rail], ['c500_BIDEGORRIA.json', G.bike], ['c500_ESKAILERA.json', G.stairs],
  ['c500_ERAIKINA.json', G.building], ['c500_EraikinArinak.json', G.building]
];
const surf = new Uint8Array(R.w * R.h);
for (const [file, id] of SURFACE_LAYERS) {
  for (const f of loadLayer(file).features) scanRings(f.g, R.x0, R.z0, 1, R.w, R.h, (i, j) => { surf[j * R.w + i] = id; });
}
for (let j = 0; j < R.h; j++) {
  for (let i = 0; i < R.w; i++) {
    if (terrainClass(R.x0 + i + 0.5, R.z0 + j + 0.5) === G.water) surf[j * R.w + i] = G.water;
  }
}
const surfAt = (x, z) => { const k = cellOf(x, z); return k < 0 ? -1 : surf[k]; };
// the extruded buildings themselves (geodata.js): what shadows a lamp and what a bracket hangs from
const bld = new Uint8Array(R.w * R.h);
for (const b of GEO.buildings) scanRings(b.g, R.x0, R.z0, 1, R.w, R.h, (i, j) => { bld[j * R.w + i] = 1; });
const bldAt = (x, z) => { const k = cellOf(x, z); return k < 0 ? 0 : bld[k]; };

// Santa Klara: the island has no public lighting (OSM maps its footpaths like any others): its land, flooded from the
// lighthouse over everything that is not water
const island = new Uint8Array(R.w * R.h);
{
  const [lx, lz] = GEO.landmarks.find((l) => l.id === 'santa-klara-itsasargia').at;
  const stack = [cellOf(lx, lz)];
  island[stack[0]] = 1;
  while (stack.length) {
    const k = stack.pop(), i = k % R.w;
    for (const n of [i > 0 ? k - 1 : -1, i < R.w - 1 ? k + 1 : -1, k - R.w, k + R.w]) {
      if (n < 0 || n >= island.length || island[n] || surf[n] === G.water) continue;
      island[n] = 1;
      stack.push(n);
    }
  }
}
const onIsland = (x, z) => { const k = cellOf(x, z); return k >= 0 && island[k] === 1; };

// --- the lamps ---------------------------------------------------------------------------------------------------------

// Kinds of lamp: h (m, the light's height), I (its strength: 1 is an avenue's column), model (what streetscape.js
// stands there: 'column' scaled to h, 'lantern' the cast-iron post, 'wall' the bracket lantern, null nothing)
const KIND = {
  avenue: { h: 9, I: 1.0, model: 'column' },
  motorway: { h: 12, I: 1.05, model: 'column' },
  street: { h: 7, I: 0.72, model: 'column' },
  service: { h: 7, I: 0.5, model: 'column' },
  square: { h: 4.2, I: 0.8, model: 'lantern' },
  path: { h: 4, I: 0.5, model: 'lantern' },
  park: { h: 4, I: 0.22, model: 'lantern' },
  wall: { h: 4.3, I: 0.6, model: 'wall' },
  bridge: { h: 6, I: 0.8, model: null },
  // the modelled ones (data-streetscape.js)
  mapped: { h: 4.4, I: 0.8, model: null },
  lane: { h: 4.3, I: 0.62, model: null },
  promenade: { h: 5, I: 0.9, model: null },
  candelabrum: { h: 6.5, I: 1.25, model: null },
  obelisk: { h: 5.5, I: 1.0, model: null }
};
const R0 = (kind) => 1.05 * KIND[kind].h;
const REACH = 3.2; // times r0

const lamps = []; // { x, z, kind, heading (deg, the way it faces) }
const CELL = 16, cells = new Map();
const cellKey = (x, z) => Math.floor(x / CELL) * 65536 + Math.floor(z / CELL);
function nearLamp(x, z, d) {
  const r = Math.ceil(d / CELL), ci = Math.floor(x / CELL), cj = Math.floor(z / CELL);
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      const list = cells.get((ci + di) * 65536 + cj + dj);
      if (!list) continue;
      for (const l of list) if ((l.x - x) ** 2 + (l.z - z) ** 2 < d * d) return true;
    }
  }
  return false;
}
function addLamp(x, z, kind, heading = 0) {
  const l = { x, z, kind, heading };
  lamps.push(l);
  const key = cellKey(x, z);
  if (!cells.has(key)) cells.set(key, []);
  cells.get(key).push(l);
  return l;
}
const headingOf = (dx, dz) => Math.round(((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360);

// 1. The lamps already modelled (js/donostia/streetscape.js builds them from the same arrays)
{
  const S = STREETSCAPE;
  for (let k = 0; k < S.lamps.length; k += 3) addLamp(S.lamps[k] / 100, S.lamps[k + 1] / 100, 'mapped');
  for (let k = 0; k < (S.wallLamps || []).length; k += 3) {
    const yaw = (S.wallLamps[k + 2] * Math.PI) / 180;
    addLamp(S.wallLamps[k] / 100 + Math.sin(yaw) * 0.9, S.wallLamps[k + 1] / 100 + Math.cos(yaw) * 0.9, 'lane');
  }
  // La Concha's lamp posts on the railing's line: every post of type 1 along its run (the sea towards (-dz, dx))
  S.railings.forEach((flat, ri) => {
    const pts = [];
    for (let k = 0; k < flat.length; k += 3) pts.push([flat[k] / 100, flat[k + 2] / 100]);
    const cum = [0];
    for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
    const posts = (S.railingPosts || [])[ri] || [];
    for (let k = 0; k < posts.length; k += 2) {
      if (posts[k + 1] !== 1) continue;
      const s = posts[k] / 100;
      let a = 0;
      while (a < pts.length - 2 && cum[a + 1] < s) a++;
      const len = cum[a + 1] - cum[a] || 1, t = (s - cum[a]) / len;
      const dx = (pts[a + 1][0] - pts[a][0]) / len, dz = (pts[a + 1][1] - pts[a][1]) / len;
      addLamp(pts[a][0] + (pts[a + 1][0] - pts[a][0]) * t, pts[a][1] + (pts[a + 1][1] - pts[a][1]) * t, 'promenade', headingOf(dz, -dx));
    }
  });
  const M = S.monuments || [];
  for (let k = 0; k < M.length; k += 5) addLamp(M[k + 1] / 100, M[k + 3] / 100, M[k] === 0 ? 'candelabrum' : 'obelisk');
}
const modelled = lamps.length;

// 2. Along OSM's streets
// class -> [priority, kind, spacing (m), staggered across the carriageway]
const ROADS = {
  motorway: [0, 'motorway', 42, true], motorway_link: [0, 'motorway', 42, false], trunk: [0, 'motorway', 42, true], trunk_link: [0, 'motorway', 42, false],
  primary: [1, 'avenue', 26, true], primary_link: [1, 'avenue', 26, true], secondary: [1, 'avenue', 26, true], secondary_link: [1, 'avenue', 26, true],
  tertiary: [1, 'avenue', 26, true], tertiary_link: [1, 'avenue', 26, true], busway: [1, 'avenue', 26, true],
  residential: [2, 'street', 28, true], unclassified: [2, 'street', 28, true], living_street: [2, 'street', 28, true],
  pedestrian: [3, 'square', 16, true],
  service: [4, 'service', 36, true],
  footway: [5, 'path', 24, false], cycleway: [5, 'path', 24, false], steps: [5, 'path', 24, false],
  path: [6, 'path', 30, false], track: [6, 'path', 30, false]
};
const WALKED = new Set([G.sidewalk, G.pedestrian, G.stairs]);
const CARRIAGEWAY = new Set([G.road, G.bike]);
const GREEN = new Set([G.natural, G.garden, G.woodland]);
const NO_POST = new Set([G.water, G.beach, G.rail, G.building]);
const stats = { ways: 0, unlit: 0, underground: 0, candidates: 0, placed: 0, wall: 0, doubled: 0, nowhere: 0, bridge: 0 };

const ways = [];
for (const e of loadLayer('osm_streets.json').elements) {
  const t = e.tags || {};
  const road = ROADS[t.highway];
  if (e.type !== 'way' || !road || !e.geometry || e.geometry.length < 2) continue;
  if (t.lit === 'no') { stats.unlit++; continue; }
  // the hills' trails are dark unless OSM says otherwise
  if (road[0] === 6 && !(t.lit === 'yes' || t.lit === '24/7')) { stats.unlit++; continue; }
  if (t.tunnel || (t.covered && t.covered !== 'no') || Number(t.layer) < 0 || t.indoor === 'yes') { stats.underground++; continue; }
  if (t.highway === 'service' && (t.service === 'driveway' || t.service === 'drive-through' || t.access === 'private')) continue;
  // a pavement's own footway and a crossing are lit by their street
  if (t.highway === 'footway' && (t.footway === 'sidewalk' || t.footway === 'crossing' || t.footway === 'access_aisle')) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  if (!pts.some(([x, z]) => inCore(x, z))) continue;
  ways.push({ id: e.id, pts, road, bridge: !!t.bridge && t.bridge !== 'no' });
}
ways.sort((a, b) => a.road[0] - b.road[0] || a.id - b.id);

// Where a lamp of a way stands, from the point (x, z) on its axis towards (nx, nz): { x, z, kind, heading } or null
function stand(x, z, nx, nz, kind, isRoad) {
  if (isRoad) {
    // out over the carriageway to the kerb, then 0.7 m onto the pavement; a facade first: a bracket on it
    let onRoad = CARRIAGEWAY.has(surfAt(x, z));
    for (let t = 0; t <= 14; t += 0.5) {
      const px = x + nx * t, pz = z + nz * t, s = surfAt(px, pz);
      if (s < 0) return null;
      if (bldAt(px, pz)) return t >= 1.5 ? { x: px - nx * 0.45, z: pz - nz * 0.45, kind: 'wall', heading: headingOf(-nx, -nz) } : null;
      if (s === G.water || s === G.beach) return null;
      if (CARRIAGEWAY.has(s) || s === G.rail) { onRoad = true; continue; }
      if (!onRoad && t < 3) continue; // the axis runs beside the mapped carriageway: go on a little
      const qx = px + nx * 0.7, qz = pz + nz * 0.7;
      if (bldAt(qx, qz) || NO_POST.has(surfAt(qx, qz))) return { x: px + nx * 0.2, z: pz + nz * 0.2, kind, heading: headingOf(-nx, -nz) };
      return { x: qx, z: qz, kind, heading: headingOf(-nx, -nz) };
    }
    return null;
  }
  // a walk: beside it, 1.6 m from its axis; a facade within 2.6 m takes a bracket instead
  for (let t = 0.5; t <= 2.6; t += 0.5) {
    if (bldAt(x + nx * t, z + nz * t)) {
      return t >= 1 ? { x: x + nx * (t - 0.45), z: z + nz * (t - 0.45), kind: 'wall', heading: headingOf(-nx, -nz) } : null;
    }
  }
  const px = x + nx * 1.6, pz = z + nz * 1.6, s = surfAt(px, pz);
  if (s < 0 || NO_POST.has(s) || CARRIAGEWAY.has(s)) return null;
  return { x: px, z: pz, kind, heading: headingOf(-nx, -nz) };
}

for (const w of ways) {
  stats.ways++;
  const [prio, kind0, spacing0, staggered] = w.road;
  const { pts } = w;
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const len = cum[cum.length - 1];
  if (len < 6) continue;
  const isRoad = prio <= 2 || prio === 4;
  const n = Math.max(1, Math.round(len / spacing0));
  const flip = hash2(w.id % 100003, 7, 3) < 0.5 ? 0 : 1;
  let a = 0;
  for (let k = 0; k < n; k++) {
    const s = ((k + 0.5) * len) / n;
    while (a < pts.length - 2 && cum[a + 1] < s) a++;
    const seg = cum[a + 1] - cum[a] || 1, t = (s - cum[a]) / seg;
    const x = pts[a][0] + (pts[a + 1][0] - pts[a][0]) * t, z = pts[a][1] + (pts[a + 1][1] - pts[a][1]) * t;
    if (!inCore(x, z) || onIsland(x, z)) continue;
    stats.candidates++;
    const dx = (pts[a + 1][0] - pts[a][0]) / seg, dz = (pts[a + 1][1] - pts[a][1]) / seg;
    if (w.bridge) {
      if (!nearLamp(x, z, 12)) { addLamp(x, z, 'bridge'); stats.bridge++; }
      continue;
    }
    // footpaths through the green are a park's: dimmer and further apart
    let kind = kind0, spacing = spacing0;
    if (kind0 === 'path' && GREEN.has(surfAt(x, z)) && GREEN.has(surfAt(x - dz * 3, z + dx * 3)) && GREEN.has(surfAt(x + dz * 3, z - dx * 3))) {
      kind = 'park';
      spacing = 30;
    }
    const side = (staggered ? (k + flip) % 2 : flip) ? 1 : -1;
    let at = null;
    for (const sgn of [side, -side]) {
      at = stand(x, z, -dz * sgn, dx * sgn, kind, isRoad);
      if (at) break;
    }
    if (!at && !isRoad && !bldAt(x, z) && !NO_POST.has(surfAt(x, z)) && !CARRIAGEWAY.has(surfAt(x, z))) at = { x, z, kind, heading: headingOf(dx, dz) };
    if (!at) { stats.nowhere++; continue; }
    // a bracket lights a lane as the Parte Vieja's do, whatever the way's class
    const minGap = at.kind === 'wall' ? Math.min(spacing, 20) * 0.6 : spacing * 0.58;
    if (nearLamp(at.x, at.z, minGap)) { stats.doubled++; continue; }
    addLamp(at.x, at.z, at.kind, at.heading);
    stats.placed++;
    if (at.kind === 'wall') stats.wall++;
  }
}

// 3. The squares' insides and the pavements of streets OSM lacks, on a triangular grid (jittered a little)
let filledSquares = 0, filledPavements = 0;
for (const [pitch, classes, gap, kind] of [[17, [G.pedestrian], 13.5, 'square'], [15, [G.sidewalk], 30, 'street']]) {
  const rowH = pitch * Math.sqrt(3) / 2;
  for (let row = 0, z = CORE.minZ + 6; z < CORE.maxZ - 6; z += rowH, row++) {
    for (let col = 0, x = CORE.minX + 6 + (row % 2) * pitch / 2; x < CORE.maxX - 6; x += pitch, col++) {
      const px = x + (hash2(col, row, 11) - 0.5) * 3, pz = z + (hash2(col, row, 12) - 0.5) * 3;
      if (!classes.includes(surfAt(px, pz)) || bldAt(px, pz) || onIsland(px, pz) || nearLamp(px, pz, gap)) continue;
      // (clear of the walls: a lantern in a square's middle, a column on the pavement's width)
      if ([[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]].some(([ox, oz]) => bldAt(px + ox, pz + oz) || surfAt(px + ox, pz + oz) === G.water)) continue;
      addLamp(px, pz, kind, Math.floor(hash2(col, row, 13) * 360));
      if (kind === 'square') filledSquares++; else filledPavements++;
    }
  }
}
const byKind = {};
for (const l of lamps) byKind[l.kind] = (byKind[l.kind] || 0) + 1;
log(`street lamps: ${modelled} modelled already; ${stats.ways} lit ways (${stats.unlit} unlit or dark trails, ${stats.underground} underground left out), ` +
  `${stats.candidates} places tried: ${stats.placed} placed (${stats.wall} on brackets), ${stats.bridge} on bridges, ${stats.doubled} doubled, ` +
  `${stats.nowhere} with nowhere to stand; ${filledSquares} more in the squares, ${filledPavements} on unmapped streets' pavements; ` +
  `${lamps.length} in all: ${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(', ')}`);

// --- the light map ------------------------------------------------------------------------------------------------------

const W = R.w / MAP_RES, H = R.h / MAP_RES;
const E = new Float32Array(W * H), EB = new Float32Array(W * H); // the streets' light, the bridges' own
// whether the 1 m raster is clear of buildings from (ax, az) to 1.5 m short of (bx, bz) (the first 2 m are the lamp's own)
function clear(ax, az, bx, bz, d) {
  const steps = Math.floor(d - 1.5);
  const sx = (bx - ax) / d, sz = (bz - az) / d;
  for (let s = 2; s <= steps; s++) if (bld[cellOf(ax + sx * s, az + sz * s)] === 1) return false;
  return true;
}
for (const l of lamps) {
  const r0 = R0(l.kind), reach = r0 * REACH, I = KIND[l.kind].I;
  const i0 = Math.max(0, Math.floor((l.x - reach - R.x0) / MAP_RES)), i1 = Math.min(W - 1, Math.ceil((l.x + reach - R.x0) / MAP_RES));
  const j0 = Math.max(0, Math.floor((l.z - reach - R.z0) / MAP_RES)), j1 = Math.min(H - 1, Math.ceil((l.z + reach - R.z0) / MAP_RES));
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const tx = R.x0 + (i + 0.5) * MAP_RES, tz = R.z0 + (j + 0.5) * MAP_RES;
      const d = Math.hypot(tx - l.x, tz - l.z);
      if (d >= reach) continue;
      if (d > 3.5 && !clear(l.x, l.z, tx, tz, d)) continue;
      const win = 1 - (d / reach) ** 2;
      (l.kind === 'bridge' ? EB : E)[j * W + i] += (I / (1 + (d / r0) ** 2) ** 1.5) * win * win;
    }
  }
}
// the streets' own bounce: a fifth of the light blurred ~7 m wide (three box passes each way)
{
  const B = Float32Array.from(E), T = new Float32Array(W * H), rad = 2;
  for (let pass = 0; pass < 3; pass++) {
    for (let j = 0; j < H; j++) {
      let sum = 0;
      for (let i = -rad; i <= rad; i++) sum += B[j * W + Math.min(W - 1, Math.max(0, i))];
      for (let i = 0; i < W; i++) {
        T[j * W + i] = sum / (2 * rad + 1);
        sum += B[j * W + Math.min(W - 1, i + rad + 1)] - B[j * W + Math.max(0, i - rad)];
      }
    }
    for (let i = 0; i < W; i++) {
      let sum = 0;
      for (let j = -rad; j <= rad; j++) sum += T[Math.min(H - 1, Math.max(0, j)) * W + i];
      for (let j = 0; j < H; j++) {
        B[j * W + i] = sum / (2 * rad + 1);
        sum += T[Math.min(H - 1, j + rad + 1) * W + i] - T[Math.max(0, j - rad) * W + i];
      }
    }
  }
  for (let k = 0; k < E.length; k++) E[k] += 0.2 * B[k];
}
// none on the water but the bridges' own; the rim black
const bytes = new Uint8Array(W * H), light = new Float32Array(W * H);
let lit = 0, sum = 0;
for (let j = 0; j < H; j++) {
  for (let i = 0; i < W; i++) {
    const k = j * W + i;
    let water = 0;
    for (const [ox, oz] of [[0.5, 0.5], [1.5, 0.5], [0.5, 1.5], [1.5, 1.5]]) if (surf[(j * MAP_RES + Math.floor(oz)) * R.w + i * MAP_RES + Math.floor(ox)] === G.water) water++;
    const rim = i === 0 || j === 0 || i === W - 1 || j === H - 1;
    const e = rim ? 0 : Math.min(E[k] * (1 - water / 4) + EB[k], E_MAX);
    light[k] = e;
    bytes[k] = Math.round(LEVELS * Math.sqrt(e / E_MAX)) * (255 / LEVELS);
    if (bytes[k] > 12) lit++;
    sum += e;
  }
}
const png = encodePNG(bytes, W, H, 1, pngText('osm', 'c500', 'b5m', 'geoeuskadi'));
fs.writeFileSync(OUT_MAP, png);
log(`${path.relative(ROOT, OUT_MAP)}: ${W} x ${H} at ${MAP_RES} m, ${(png.length / 1024).toFixed(0)} kB; ` +
  `${((100 * lit) / (W * H)).toFixed(1)}% of the core lit, mean light ${(sum / (W * H)).toFixed(3)}`);
// the lowest tier's: the means of 2 x 2 texels
{
  const w2 = W / 2, h2 = H / 2, low = new Uint8Array(w2 * h2);
  for (let j = 0; j < h2; j++) {
    for (let i = 0; i < w2; i++) {
      const k = 2 * j * W + 2 * i;
      const rim = i === 0 || j === 0 || i === w2 - 1 || j === h2 - 1;
      const e = rim ? 0 : (light[k] + light[k + 1] + light[k + W] + light[k + W + 1]) / 4;
      low[j * w2 + i] = Math.round(LEVELS * Math.sqrt(e / E_MAX)) * (255 / LEVELS);
    }
  }
  const pngLow = encodePNG(low, w2, h2, 1, pngText('osm', 'c500', 'b5m', 'geoeuskadi'));
  fs.writeFileSync(OUT_MAP_LOW, pngLow);
  log(`${path.relative(ROOT, OUT_MAP_LOW)}: ${w2} x ${h2} at ${2 * MAP_RES} m, ${(pngLow.length / 1024).toFixed(0)} kB`);
}

// --- the lamps to model ---------------------------------------------------------------------------------------------------

// Per model, five bytes a lamp: Uint16 x, z (dm from the core's north-west corner) and Uint8 heading (1/256 of a turn),
// base64; the columns in one list per height.
const pack = (list) => {
  const buf = Buffer.alloc(list.length * 5);
  list.forEach((l, k) => {
    buf.writeUInt16LE(Math.round((l.x - CORE.minX) * 10), 5 * k);
    buf.writeUInt16LE(Math.round((l.z - CORE.minZ) * 10), 5 * k + 2);
    buf.writeUInt8(Math.round((l.heading / 360) * 256) & 255, 5 * k + 4);
  });
  return buf.toString('base64');
};
const placed = lamps.slice(modelled);
const columns = {};
for (const l of placed) {
  if (KIND[l.kind].model !== 'column') continue;
  const h = KIND[l.kind].h;
  (columns[h] ||= []).push(l);
}
const DATA_OUT = {
  // where the positions count from (m) and their unit (m)
  origin: [CORE.minX, CORE.minZ], unit: 0.1,
  // [x, z (Uint16, units from the origin), heading (Uint8, 1/256 of a turn: atan2(dx, dz) of the way it faces)] per lamp
  columns: Object.entries(columns).map(([h, list]) => ({ height: Number(h), count: list.length, data: pack(list) })),
  lanterns: { count: 0, data: '' },
  wall: { count: 0, data: '' }
};
for (const [key, model] of [['lanterns', 'lantern'], ['wall', 'wall']]) {
  const list = placed.filter((l) => KIND[l.kind].model === model);
  DATA_OUT[key] = { count: list.length, data: pack(list) };
}
const js = '// js/donostia/data-streetlight.js — generated by tools/donostia/bake-streetlight.mjs; do not edit.\n' +
  '// The street lamps placed along the street network where none is mapped (the rules are in the tool\'s header), for\n' +
  '// js/donostia/streetscape.js; the light they and the mapped ones give is data/donostia/street-light.png.\n' +
  '// © OpenStreetMap contributors (ODbL) · Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 ' +
  '(CC BY-SA 3.0) · b5m, Gipuzkoako Foru Aldundia (CC BY 4.0) · Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0)\n' +
  licenceComment('osm', 'c500', 'b5m', 'geoeuskadi') +
  `export const STREETLIGHT = ${JSON.stringify({ map: { url: 'data/donostia/street-light.png', urlLow: 'data/donostia/street-light-low.png', res: MAP_RES, max: E_MAX }, ...DATA_OUT })};\n`;
fs.writeFileSync(OUT_JS, js);
log(`${path.relative(ROOT, OUT_JS)}: ${(js.length / 1024).toFixed(0)} kB; ${DATA_OUT.columns.map((c) => `${c.count} columns of ${c.height} m`).join(', ')}, ` +
  `${DATA_OUT.lanterns.count} lanterns, ${DATA_OUT.wall.count} wall lanterns`);

// --preview <dir>: the light map over the ground, with the lamps (mapped white, placed by kind)
if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const rgb = new Uint8Array(W * H * 3);
  for (let k = 0; k < W * H; k++) {
    const e = (bytes[k] / 255) ** 2 * E_MAX, v = Math.min(1, e / 1.2) ** 0.6;
    const i = k % W, j = Math.floor(k / W), s = surf[j * MAP_RES * R.w + i * MAP_RES];
    const base = s === G.water ? [8, 14, 30] : s === G.building ? [22, 20, 24] : [10, 12, 14];
    rgb[3 * k] = Math.min(255, base[0] + 255 * v);
    rgb[3 * k + 1] = Math.min(255, base[1] + 190 * v);
    rgb[3 * k + 2] = Math.min(255, base[2] + 110 * v);
  }
  fs.writeFileSync(path.join(PREVIEW, 'street-light.png'), encodePNG(rgb, W, H, 3));
  log(`preview: ${path.join(PREVIEW, 'street-light.png')}`);
}
