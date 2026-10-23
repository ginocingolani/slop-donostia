// tools/donostia/bake-streetscape.mjs
// Trees and street furniture for js/donostia/vegetation.js & js/donostia/streetscape.js:
//   node tools/donostia/bake-streetscape.mjs        -> js/donostia/data-streetscape.js
// Inputs are all committed: the municipal 1:500 map (tree pits, woodland, gardens, beaches, roads; Donostiako Udala,
// CC BY-SA 3.0), OpenStreetMap trees, street lamps & benches (ODbL), the baked terrain (data/donostia/terrain-core.png)
// and the buildings of js/donostia/geodata.js. Run it after tools/donostia/build.mjs.
//
// - Trees: the centroid of every tree pit (ZUHAITZ_TXORKOA), OSM natural=tree nodes (merged into the pit they mark, or
//   added), blue-noise scatter over the woodland masses (ZuhaiztiGuneak) and a sparse one over the gardens
//   (LORATEGI_EREMUA); nothing inside a building, on a carriageway, rail or water. Each tree gets a species by place
//   (tamarisks along La Concha, Ondarreta & Alderdi Eder, London planes in the ensanche, pines & evergreens in the hill
//   woods...) and a scale that keeps its crown off the nearest wall.
// - La Concha's railing: the landward edge of the Kontxa & Ondarreta beach polygons where the promenade (sidewalk or
//   pedestrian paving) meets them, pulled onto the top of the wall in the LiDAR terrain; its lamp posts every ~17 m.
// - Street lamps & benches from OSM, with a heading (benches face the bay, or away from the wall behind them), and
//   wall lanterns along the facades of the Parte Vieja, where OSM maps no street lamps.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import {
  HERE, FRAME, loadLayer, lonLatToLocal, scanRings, ringArea, ringBounds, encodePNG, previewDir, licenceComment, log
} from './lib.mjs';

const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'js/donostia/data-streetscape.js');
const CORE = FRAME.core;
const PREVIEW = previewDir();
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);
const G = GEO.terrain.classes;

// Species ids shared with js/donostia/trees-species.js (SPECIES order)
const SP = { plane: 0, tamarisk: 1, broadleaf: 2, evergreen: 3, pine: 4, palm: 5 };
const SPECIES_NAMES = Object.keys(SP);
// Crown radius (m) of each species at scale 1, for keeping crowns off the walls (roughly what trees-species.js grows)
const CROWN_R = [5.2, 5.2, 4.4, 4.4, 4.6, 4.0];

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

function hash2(x, z, s = 0) {
  let h = Math.imul(Math.floor(x) | 0, 0x27d4eb2d) ^ Math.imul(Math.floor(z) | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Smooth value noise in [0, 1] with features ~cell metres across: patches of one kind of tree in the woods
function valueNoise(x, z, cell, seed) {
  const fx = x / cell, fz = z / cell, i = Math.floor(fx), j = Math.floor(fz);
  const tx = fx - i, tz = fz - j, sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return (a * (1 - sx) + b * sx) * (1 - sz) + (c * (1 - sx) + d * sx) * sz;
}

// --- terrain (the 2 m core grid baked by build.mjs) --------------------------------------------------------------------

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

const terrain = (() => {
  const meta = GEO.terrain.core;
  const img = decodePNG(fs.readFileSync(path.join(ROOT, meta.url)));
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
  const classAt = (x, z) => {
    const i = Math.floor((x - x0) / res), j = Math.floor((z - z0) / res);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : classes[j * w + i];
  };
  return { heightAt, classAt };
})();

// --- 1 m rasters over the core: ground class, buildings, distance to the nearest wall ----------------------------------

const R = { x0: CORE.minX, z0: CORE.minZ, w: CORE.maxX - CORE.minX, h: CORE.maxZ - CORE.minZ };
const cellOf = (x, z) => {
  const i = Math.floor(x - R.x0), j = Math.floor(z - R.z0);
  return i < 0 || j < 0 || i >= R.w || j >= R.h ? -1 : j * R.w + i;
};

// The ground classes of build.mjs (GROUND_LAYERS, later layers win) at 1 m instead of 2 m
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
// the sea and the river below the waterline, from the terrain's flood fill
for (let j = 0; j < R.h; j++) {
  for (let i = 0; i < R.w; i++) {
    if (terrain.classAt(R.x0 + i + 0.5, R.z0 + j + 0.5) === G.water) surf[j * R.w + i] = G.water;
  }
}
const surfAt = (x, z) => { const k = cellOf(x, z); return k < 0 ? -1 : surf[k]; };

// The extruded buildings themselves (geodata.js), so nothing grows through a wall that is drawn
const bld = new Uint8Array(R.w * R.h);
for (const b of GEO.buildings) scanRings(b.g, R.x0, R.z0, 1, R.w, R.h, (i, j) => { bld[j * R.w + i] = 1; });

// Chamfer distance (m) to the nearest building cell
const wallDist = (() => {
  const { w, h } = R, d = new Float32Array(w * h), D = Math.SQRT2;
  for (let k = 0; k < d.length; k++) d[k] = bld[k] ? 0 : 1e6;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      let v = d[k];
      if (i > 0) v = Math.min(v, d[k - 1] + 1);
      if (j > 0) {
        v = Math.min(v, d[k - w] + 1);
        if (i > 0) v = Math.min(v, d[k - w - 1] + D);
        if (i < w - 1) v = Math.min(v, d[k - w + 1] + D);
      }
      d[k] = v;
    }
  }
  for (let j = h - 1; j >= 0; j--) {
    for (let i = w - 1; i >= 0; i--) {
      const k = j * w + i;
      let v = d[k];
      if (i < w - 1) v = Math.min(v, d[k + 1] + 1);
      if (j < h - 1) {
        v = Math.min(v, d[k + w] + 1);
        if (i < w - 1) v = Math.min(v, d[k + w + 1] + D);
        if (i > 0) v = Math.min(v, d[k + w - 1] + D);
      }
      d[k] = v;
    }
  }
  return d;
})();
const clearanceAt = (x, z) => { const k = cellOf(x, z); return k < 0 ? 0 : wallDist[k]; };
log('rasters: ground classes, buildings & wall distance at 1 m');

// Districts (auzoak) at 4 m
const districts = (() => {
  const res = 4, w = R.w / res, h = R.h / res, ids = new Uint8Array(w * h).fill(255);
  const names = [];
  for (const f of loadLayer('auzoak.json').features) {
    let id = names.indexOf(f.p.IzenAuzo);
    if (id < 0) id = names.push(f.p.IzenAuzo) - 1;
    scanRings(f.g, R.x0, R.z0, res, w, h, (i, j) => { ids[j * w + i] = id; });
  }
  return (x, z) => {
    const i = Math.floor((x - R.x0) / res), j = Math.floor((z - R.z0) / res);
    return i < 0 || j < 0 || i >= w || j >= h || ids[j * w + i] === 255 ? '' : names[ids[j * w + i]];
  };
})();

// Nearest cell within maxR (m) whose 1 m surface satisfies pred: [dx, dz, distance] or null
function nearestCell(x, z, maxR, pred) {
  const ci = Math.floor(x - R.x0), cj = Math.floor(z - R.z0), r = Math.ceil(maxR);
  let best = null, bestD = maxR * maxR;
  for (let dj = -r; dj <= r; dj++) {
    const j = cj + dj;
    if (j < 0 || j >= R.h) continue;
    for (let di = -r; di <= r; di++) {
      const i = ci + di;
      if (i < 0 || i >= R.w) continue;
      const dx = R.x0 + i + 0.5 - x, dz = R.z0 + j + 0.5 - z, d2 = dx * dx + dz * dz;
      if (d2 >= bestD || !pred(j * R.w + i)) continue;
      bestD = d2;
      best = [dx, dz, Math.sqrt(d2)];
    }
  }
  return best;
}

// --- polylines: named streets and beach edges, with a bucket index for distance queries -------------------------------

class SegmentIndex {
  constructor(cell = 32) {
    this.cell = cell;
    this.buckets = new Map();
  }
  addLine(pts, closed = false) {
    const n = pts.length / 2;
    for (let a = 0; a < n - (closed ? 0 : 1); a++) {
      const b = (a + 1) % n;
      const seg = [pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]];
      const c = this.cell;
      const i0 = Math.floor(Math.min(seg[0], seg[2]) / c), i1 = Math.floor(Math.max(seg[0], seg[2]) / c);
      const j0 = Math.floor(Math.min(seg[1], seg[3]) / c), j1 = Math.floor(Math.max(seg[1], seg[3]) / c);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const key = i * 65536 + j;
          if (!this.buckets.has(key)) this.buckets.set(key, []);
          this.buckets.get(key).push(seg);
        }
      }
    }
  }
  // distance (m) to the nearest segment, searched up to maxD
  distance(x, z, maxD) {
    const c = this.cell, r = Math.ceil(maxD / c);
    const ci = Math.floor(x / c), cj = Math.floor(z / c);
    let best = Infinity;
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const segs = this.buckets.get(i * 65536 + j);
        if (!segs) continue;
        for (const [ax, az, bx, bz] of segs) {
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
          const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
          best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
        }
      }
    }
    return best;
  }
}

const osmStreets = JSON.parse(fs.readFileSync(path.join(HERE, 'data/osm_streets.json'), 'utf8')).elements;
const osmFurniture = JSON.parse(fs.readFileSync(path.join(HERE, 'data/osm_furniture.json'), 'utf8')).elements;
const wayPoints = (e) => e.geometry.flatMap((p) => lonLatToLocal(p.lon, p.lat));

// The ensanche avenues lined with London planes (Boulevard, Avenida de la Libertad, Easo, Prim, Urbieta...)
const PLANE_STREETS = /^(Boulevard( zumardia)?|Alameda del Boulevard|Askatasunaren hiribidea|Easo (kalea|plaza)|Prim kalea|Urbieta kalea|Hondarribia kalea|Getaria kalea|Okendo kalea|Frantzia pasealekua|Gipuzkoa plaza|Antso Jakitunaren hiribidea|Zurriola hiribidea|Isabel II\.aren hiribidea|Madril hiribidea|Argentinako Errepublika pasealekua|Peñaflorida kalea|Sanserreka pasealekua|Tolosa hiribidea|Zubieta kalea|San Martin kalea|Loiola kalea|Bengoetxea kalea|Arrasate kalea|Hernani kalea|Garibai kalea)$/;
// The seafront walks of the tamarisks (Paseo de La Concha, Ondarreta, the walk out to the Peine del Viento)
const TAMARISK_STREETS = /^(Kontxa pasealekua|Ondarreta pasealekua|Eduardo Chillida pasealekua)$/;
const planeStreets = new SegmentIndex(), tamariskStreets = new SegmentIndex();
for (const e of osmStreets) {
  const name = e.tags?.name;
  if (e.type !== 'way' || !e.geometry || !name) continue;
  if (PLANE_STREETS.test(name)) planeStreets.addLine(wayPoints(e));
  if (TAMARISK_STREETS.test(name)) tamariskStreets.addLine(wayPoints(e));
}

// Beaches: Kontxa & Ondarreta (west of the harbour) carry the railing; Zurriola only matters to the benches
const beachFeatures = loadLayer('c500_HONDARTZA.json').features.map((f) => f.g[0]);
const bayBeaches = beachFeatures.filter((r) => ringBounds(r).minX < 400);
const bayBeachEdges = new SegmentIndex();
for (const r of bayBeaches) bayBeachEdges.addLine(r, true);

// Alderdi Eder: the gardens between the City Hall and the bay, under their tamarisks
const ALDERDI_EDER = { minX: 120, maxX: 335, minZ: -75, maxZ: 125 };
const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;

// Hill woods and parks whose mix differs from the default (bounds from OSM)
const WOODS = [
  { name: 'Urgull', box: { minX: -394, maxX: 313, minZ: -632, maxZ: -183 }, pine: 0.14, evergreen: 0.4 },
  { name: 'Igeldo', box: { minX: -2200, maxX: -1250, minZ: -1600, maxZ: 1800 }, pine: 0.42, evergreen: 0.16 },
  { name: 'Ulia', box: { minX: 1150, maxX: 2000, minZ: -1600, maxZ: -420 }, pine: 0.4, evergreen: 0.14 },
  { name: 'Miramar', box: { minX: -935, maxX: -707, minZ: 631, maxZ: 902 }, pine: 0.12, evergreen: 0.4, palm: 0.04 },
  { name: 'Kristina-Enea', box: { minX: 927, maxX: 1264, minZ: 518, maxZ: 1083 }, pine: 0.16, evergreen: 0.32, palm: 0.02 },
  { name: 'Aiete', box: { minX: -324, maxX: 51, minZ: 1664, maxZ: 2057 }, pine: 0.16, evergreen: 0.34 }
];
const woodMix = (x, z) => WOODS.find((w) => inBox(w.box, x, z)) || { pine: 0.22, evergreen: 0.2 };

// --- trees -------------------------------------------------------------------------------------------------------------

const trees = []; // { x, z, sp, s, src }
const inCore = (x, z) => x > CORE.minX + 1 && x < CORE.maxX - 1 && z > CORE.minZ + 1 && z < CORE.maxZ - 1;
const BLOCKED = new Set([G.building, G.water, G.rail]);

// Spatial hash of planted trees for spacing tests
const hashCell = 4;
const hashW = Math.ceil(R.w / hashCell), hashH = Math.ceil(R.h / hashCell);
const treeHash = new Map();
function addToHash(t) {
  const k = Math.floor((t.z - R.z0) / hashCell) * hashW + Math.floor((t.x - R.x0) / hashCell);
  if (!treeHash.has(k)) treeHash.set(k, []);
  treeHash.get(k).push(t);
}
function nearestTree(x, z, maxD) {
  const r = Math.ceil(maxD / hashCell), ci = Math.floor((x - R.x0) / hashCell), cj = Math.floor((z - R.z0) / hashCell);
  let best = null, bestD = maxD;
  for (let j = cj - r; j <= cj + r; j++) {
    if (j < 0 || j >= hashH) continue;
    for (let i = ci - r; i <= ci + r; i++) {
      if (i < 0 || i >= hashW) continue;
      const list = treeHash.get(j * hashW + i);
      if (!list) continue;
      for (const t of list) {
        const d = Math.hypot(t.x - x, t.z - z);
        if (d < bestD) { bestD = d; best = t; }
      }
    }
  }
  return best ? { tree: best, d: bestD } : null;
}

function polygonCentroid(r) {
  let a = 0, cx = 0, cz = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    a += f;
    cx += (r[2 * j] + r[2 * i]) * f;
    cz += (r[2 * j + 1] + r[2 * i + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) return [r[0], r[1]];
  return [cx / (3 * a), cz / (3 * a)];
}

// A pit or a mapped tree can stand at a curb or in a parking strip, but not out in the carriageway
function streetTreeOK(x, z) {
  const s = surfAt(x, z);
  if (s < 0 || BLOCKED.has(s) || bld[cellOf(x, z)]) return false;
  if (s === G.road) return !!nearestCell(x, z, 1.6, (k) => surf[k] !== G.road && surf[k] !== G.water);
  return true;
}

const stats = { pits: 0, pitsDropped: 0, osm: 0, osmMerged: 0, osmAdded: 0, osmDropped: 0, woodland: 0, garden: 0 };

// 1. Tree pits
for (const f of loadLayer('c500_ZUHAITZ_TXORKOA.json').features) {
  const [x, z] = polygonCentroid(f.g[0]);
  stats.pits++;
  if (!inCore(x, z) || !streetTreeOK(x, z)) { stats.pitsDropped++; continue; }
  const t = { x, z, src: 'pit', sp: -1, s: 0 };
  trees.push(t);
  addToHash(t);
}

// 2. OSM trees: tags onto the pit they mark, or a tree of their own
for (const e of osmFurniture) {
  if (e.type !== 'node' || e.tags?.natural !== 'tree') continue;
  const [x, z] = lonLatToLocal(e.lon, e.lat);
  if (!inCore(x, z)) continue;
  stats.osm++;
  const tags = e.tags;
  let sp = -1;
  const taxon = `${tags.species || ''} ${tags.genus || ''} ${tags.taxon || ''}`.toLowerCase();
  if (tags.leaf_type === 'palm' || /arecaceae|phoenix|washingtonia|trachycarpus|palm/.test(taxon)) sp = SP.palm;
  else if (tags.leaf_type === 'needleleaved' || /pinus|pinaceae|cedrus|cupressus/.test(taxon)) sp = SP.pine;
  else if (/tamarix/.test(taxon)) sp = SP.tamarisk;
  else if (/platanus/.test(taxon)) sp = SP.plane;
  else if (/quercus ilex|magnolia|laurus|ilex/.test(taxon) || tags.leaf_cycle === 'evergreen') sp = SP.evergreen;
  else if (/quercus|tilia|acer|fraxinus|castanea|ulmus|betula/.test(taxon)) sp = SP.broadleaf;
  const height = parseFloat(tags.height);
  const near = nearestTree(x, z, 2.5);
  if (near && near.tree.src === 'pit') {
    stats.osmMerged++;
    if (sp >= 0) near.tree.sp = sp;
    if (height > 0) near.tree.height = height;
    continue;
  }
  if (!streetTreeOK(x, z) || (near && near.d < 1.5)) { stats.osmDropped++; continue; }
  const t = { x, z, src: 'osm', sp, s: 0 };
  if (height > 0) t.height = height;
  trees.push(t);
  addToHash(t);
  stats.osmAdded++;
}

// Blue-noise scatter over the cells that pass `ok`: candidates on a jittered lattice of radius / 2, taken in random
// order and kept when nothing planted lies within `radius` (`keep` thins the result)
function scatter(ok, radius, keep, seed, src) {
  const rng = mulberry32(seed);
  const step = radius / 2;
  const nx = Math.floor(R.w / step), nz = Math.floor(R.h / step);
  const cand = [];
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const x = R.x0 + (i + rng()) * step, z = R.z0 + (j + rng()) * step;
      const k = cellOf(x, z);
      if (k >= 0 && ok(k, x, z)) cand.push(x, z);
    }
  }
  // Fisher-Yates over candidate pairs
  const n = cand.length / 2;
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  let added = 0;
  for (const o of order) {
    const x = cand[2 * o], z = cand[2 * o + 1];
    if (nearestTree(x, z, radius)) continue;
    const t = { x, z, src, sp: -1, s: 0 };
    addToHash(t); // even when thinned away, so the gaps stay
    if (rng() > keep) continue;
    trees.push(t);
    added++;
  }
  return added;
}

const slopeAt = (x, z) => {
  const gx = (terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z)) / 2;
  const gz = (terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;
  return Math.hypot(gx, gz);
};

// 3. Woodland masses: a closed canopy, crowns ~7 m apart, off paths, walls and cliffs. Woods mapped under a garden
//    (Cristina Enea, Miramar...) stay woods.
const woods = new Uint8Array(R.w * R.h);
for (const f of loadLayer('c500_ZuhaiztiGuneak.json').features) scanRings(f.g, R.x0, R.z0, 1, R.w, R.h, (i, j) => { woods[j * R.w + i] = 1; });
stats.woodland = scatter((k, x, z) => woods[k] && (surf[k] === G.woodland || surf[k] === G.garden) && wallDist[k] > 2 &&
  slopeAt(x, z) < 1.7, 7.2, 1, 7001, 'wood');

// 4. Gardens: a tree here and there, where the lawn has room round it
const roomy = (x, z, r) => {
  for (let a = 0; a < 8; a++) {
    const s = surfAt(x + Math.cos(a * Math.PI / 4) * r, z + Math.sin(a * Math.PI / 4) * r);
    if (s !== G.garden && s !== G.woodland) return false;
  }
  return true;
};
// The seafront gardens (Ondarreta, Alderdi Eder) are planted closer, under tamarisks
const seafrontGarden = (x, z) => (inBox(ALDERDI_EDER, x, z) || bayBeachEdges.distance(x, z, 70) < 70) && terrain.heightAt(x, z) < 16;
stats.garden = scatter((k, x, z) => surf[k] === G.garden && wallDist[k] > 2.5 && roomy(x, z, 1.5) && seafrontGarden(x, z), 7.5, 0.8, 7003, 'garden');
stats.garden += scatter((k, x, z) => surf[k] === G.garden && wallDist[k] > 3 && roomy(x, z, 2.2), 13, 0.55, 7002, 'garden');

// Species by place, then a scale whose crown keeps off the nearest wall
for (const t of trees) {
  const { x, z } = t;
  const r = hash2(x * 100, z * 100, 11);
  const y = terrain.heightAt(x, z);
  const reach = t.src === 'garden' ? 70 : 36;
  const seafront = y < 16 && (bayBeachEdges.distance(x, z, reach) < reach || tamariskStreets.distance(x, z, 22) < 22 || inBox(ALDERDI_EDER, x, z));
  if (t.sp < 0) {
    if (t.src === 'wood') {
      const mix = woodMix(x, z);
      const n1 = valueNoise(x, z, 46, 1), n2 = valueNoise(x, z, 38, 2);
      // stretched so patches of pines and evergreens read as stands, not a salt-and-pepper mix
      const p = Math.min(1, Math.max(0, (n1 - 0.5) * 1.8 + 0.5)), q = Math.min(1, Math.max(0, (n2 - 0.5) * 1.8 + 0.5));
      if (mix.palm && r < mix.palm) t.sp = SP.palm;
      else if (p < mix.pine) t.sp = SP.pine;
      else if (q < mix.evergreen / (1 - mix.pine)) t.sp = SP.evergreen;
      else t.sp = SP.broadleaf;
    } else if (seafront) {
      t.sp = r < 0.9 ? SP.tamarisk : r < 0.95 ? SP.palm : SP.evergreen;
    } else if (t.src === 'garden') {
      const district = districts(x, z);
      const central = district === 'ERDIALDEA' || district === 'GROS' || district === 'ANTIGUA';
      t.sp = r < 0.42 ? SP.broadleaf : r < 0.68 ? SP.evergreen : r < 0.8 ? SP.plane : r < (central ? 0.88 : 0.82) ? SP.palm : r < 0.92 ? SP.pine : SP.broadleaf;
    } else {
      const district = districts(x, z);
      const avenue = planeStreets.distance(x, z, 16) < 16;
      const ensanche = district === 'ERDIALDEA' || district === 'GROS' || district === 'AMARABERRI' || district === 'EGIA';
      const planeShare = avenue ? 0.94 : ensanche ? 0.55 : 0.2;
      t.sp = r < planeShare ? SP.plane : r < planeShare + (1 - planeShare) * 0.75 ? SP.broadleaf : SP.evergreen;
    }
  }
  // Scale 1 is a mature park tree: street trees are planted smaller, the woods vary most
  const v = hash2(x * 100, z * 100, 23);
  let s;
  if (t.src === 'wood') s = t.sp === SP.pine ? 0.8 + v * 0.45 : 0.72 + v * 0.45;
  else if (t.src === 'garden') s = 0.7 + v * 0.4;
  else if (t.sp === SP.tamarisk) s = 0.82 + v * 0.26;
  else if (t.sp === SP.palm) s = 0.75 + v * 0.3;
  else s = 0.6 + v * 0.26;
  if (t.height) s = t.height / [12.3, 7, 10.4, 7.7, 17.3, 10.4][t.sp];
  const clear = clearanceAt(x, z);
  s = Math.min(s, Math.max(0.42, (clear + 0.9) / CROWN_R[t.sp]));
  t.s = Math.max(0.35, Math.min(1.4, s));
}
const bySpecies = SPECIES_NAMES.map((name, k) => `${name} ${trees.filter((t) => t.sp === k).length}`).join(', ');
log(`trees: ${trees.length} (pits ${stats.pits - stats.pitsDropped}/${stats.pits}, OSM ${stats.osm}: ${stats.osmMerged} on pits, ${stats.osmAdded} added, ${stats.osmDropped} dropped; woodland ${stats.woodland}, gardens ${stats.garden}) — ${bySpecies}`);

// Packed: Int32 x, z (cm) | Uint8 species | Uint8 scale (x100), sorted west to east in 64 m strips for locality
trees.sort((a, b) => Math.floor(a.z / 64) - Math.floor(b.z / 64) || a.x - b.x);
const N = trees.length;
const packed = Buffer.alloc(N * 10);
trees.forEach((t, i) => {
  packed.writeInt32LE(Math.round(t.x * 100), 8 * i);
  packed.writeInt32LE(Math.round(t.z * 100), 8 * i + 4);
  packed[8 * N + i] = t.sp;
  packed[9 * N + i] = Math.round(t.s * 100);
});

// --- La Concha's railing (barandilla) and its lamp posts --------------------------------------------------------------

const PROMENADE = new Set([G.sidewalk, G.pedestrian, G.bike]);
function bakeRailings() {
  const runs = [];
  for (const ring of bayBeaches) {
    // resample the closed ring every metre
    const pts = [];
    const n = ring.length / 2;
    for (let a = 0; a < n; a++) {
      const b = (a + 1) % n;
      const ax = ring[2 * a], az = ring[2 * a + 1], bx = ring[2 * b], bz = ring[2 * b + 1];
      const len = Math.hypot(bx - ax, bz - az), steps = Math.max(1, Math.round(len));
      for (let s = 0; s < steps; s++) pts.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
    }
    // outward (landward) normal: right of the direction of travel for a ring of positive area (x right, z down)
    const sign = Math.sign(ringArea(ring));
    const m = pts.length;
    const samples = pts.map(([x, z], k) => {
      const [px, pz] = pts[(k + m - 2) % m], [qx, qz] = pts[(k + 2) % m];
      const l = Math.hypot(qx - px, qz - pz) || 1;
      const nx = (sign * (qz - pz)) / l, nz = (-sign * (qx - px)) / l;
      // the promenade lies behind the edge (2 of 3 probes on its paving), above the sea and the sand in front
      let paved = 0, natural = 0;
      for (const d of [1.5, 2.5, 3.5]) {
        const s = surfAt(x + nx * d, z + nz * d);
        if (PROMENADE.has(s)) paved++;
        else if (s === G.natural) natural++;
      }
      let land = -Infinity;
      for (let d = 1; d <= 4; d += 0.5) land = Math.max(land, terrain.heightAt(x + nx * d, z + nz * d));
      const sand = terrain.heightAt(x - nx * 3, z - nz * 3);
      const drop = land - sand;
      const ok = land > 2.5 && ((paved >= 2 && drop > 0.6) || (paved + natural >= 2 && drop > 2.5));
      if (!ok) return null;
      // walk inland until the terrain reaches the top of the wall (the 2 m grid smears the drop over a few metres)
      let d = 0;
      while (d < 3 && terrain.heightAt(x + nx * d, z + nz * d) < land - 0.3) d += 0.25;
      const rx = x + nx * (d + 0.2), rz = z + nz * (d + 0.2);
      return { x: rx, z: rz, y: terrain.heightAt(rx + nx * 0.8, rz + nz * 0.8), sand };
    });
    // runs of consecutive valid samples (the ring is closed: start after a gap)
    let start = samples.findIndex((s) => !s);
    if (start < 0) start = 0;
    let cur = [];
    for (let k = 1; k <= m; k++) {
      const s = samples[(start + k) % m];
      if (s) cur.push(s);
      if (!s || k === m) {
        // walked so the sea lies on the (-dz, dx) side of the direction of travel (dx, dz), whatever the ring's winding
        if (cur.length >= 10) runs.push(sign > 0 ? cur : cur.reverse());
        cur = [];
      }
    }
  }
  // smooth out the snapping jitter, then thin
  const out = [];
  for (const run of runs) {
    let pts = run.map((s) => [s.x, s.y, s.z]);
    for (let pass = 0; pass < 3; pass++) {
      pts = pts.map((p, k) => {
        if (k === 0 || k === pts.length - 1) return p;
        const a = pts[Math.max(0, k - 2)], b = pts[k - 1], c = pts[k + 1], e = pts[Math.min(pts.length - 1, k + 2)];
        return [0, 1, 2].map((i) => (a[i] + 2 * b[i] + 3 * p[i] + 2 * c[i] + e[i]) / 9);
      });
    }
    out.push(simplify3(pts, 0.06));
  }
  return out;
}

// Douglas-Peucker on an open 3D polyline
function simplify3(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const d = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1e-9;
    let idx = -1, max = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const t = Math.max(0, Math.min(1, ((P[0] - A[0]) * d[0] + (P[1] - A[1]) * d[1] + (P[2] - A[2]) * d[2]) / l2));
      const e = Math.hypot(P[0] - A[0] - t * d[0], P[1] - A[1] - t * d[1], P[2] - A[2] - t * d[2]);
      if (e > max) { max = e; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const railings = bakeRailings();
// Lamp posts along each railing every ~17 m, standing just behind it
const promenadeLamps = [];
for (const run of railings) {
  let acc = 8.5;
  for (let k = 1; k < run.length; k++) {
    const [ax, ay, az] = run[k - 1], [bx, by, bz] = run[k];
    const len = Math.hypot(bx - ax, bz - az);
    // (nx, nz) points to the sea (see bakeRailings)
    const nx = -(bz - az) / (len || 1), nz = (bx - ax) / (len || 1);
    let t = 0;
    while (acc <= len - t) {
      t += acc;
      const f = t / len;
      promenadeLamps.push([ax + (bx - ax) * f - nx * 0.3, ay + (by - ay) * f, az + (bz - az) * f - nz * 0.3]);
      acc = 17;
    }
    acc -= len - t;
  }
}
const railLength = railings.reduce((s, r) => s + r.slice(1).reduce((a, p, k) => a + Math.hypot(p[0] - r[k][0], p[2] - r[k][2]), 0), 0);
log(`railing: ${railings.length} runs, ${railLength.toFixed(0)} m, ${railings.reduce((s, r) => s + r.length, 0)} vertices; ${promenadeLamps.length} promenade lamps`);

// --- street lamps & benches (OSM) --------------------------------------------------------------------------------------

const heading = (dx, dz) => Math.round(((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360);
const nearPromenadeLamp = (x, z, d) => promenadeLamps.some((p) => Math.hypot(p[0] - x, p[2] - z) < d);
const lamps = [];
let lampsMoved = 0, lampsDropped = 0;
for (const e of osmFurniture) {
  if (e.type !== 'node' || e.tags?.highway !== 'street_lamp') continue;
  let [x, z] = lonLatToLocal(e.lon, e.lat);
  if (!inCore(x, z)) continue;
  // mapped on a facade: out onto the pavement in front of it
  if (bld[cellOf(x, z)]) {
    const out = nearestCell(x, z, 3, (k) => !bld[k]);
    if (!out) { lampsDropped++; continue; }
    x += out[0] * (1 + 0.4 / out[2]);
    z += out[1] * (1 + 0.4 / out[2]);
    lampsMoved++;
  }
  if (surfAt(x, z) === G.water || nearPromenadeLamp(x, z, 6)) { lampsDropped++; continue; }
  const road = nearestCell(x, z, 15, (k) => surf[k] === G.road);
  const h = road ? heading(road[0], road[1]) : Math.floor(hash2(x * 10, z * 10, 5) * 360);
  lamps.push([Math.round(x * 100), Math.round(z * 100), h]);
}

// Wall lanterns of the Parte Vieja: OSM maps no street lamps there, while its lanes are lit by lanterns on iron
// brackets. One every ~20 m along each facade that fronts a street or plaza, kept 11 m from the next.
const PARTE_VIEJA = { minX: 110, maxX: 480, minZ: -430, maxZ: -105 };
const STREETS = new Set([G.pedestrian, G.sidewalk, G.road, G.stairs]);
const wallLamps = [];
for (const [bi, b] of GEO.buildings.entries()) {
  if (b.kind !== 0) continue;
  const r = b.g[0], bb = ringBounds(r);
  if (bb.maxX < PARTE_VIEJA.minX || bb.minX > PARTE_VIEJA.maxX || bb.maxZ < PARTE_VIEJA.minZ || bb.minZ > PARTE_VIEJA.maxZ) continue;
  const sign = Math.sign(ringArea(r));
  const n = r.length / 2;
  let next = 4 + hash2(bi, 3, 17) * 14; // metres along the outline to the next lantern
  for (let a = 0; a < n; a++) {
    const c = (a + 1) % n;
    const ax = r[2 * a], az = r[2 * a + 1], dx = r[2 * c] - ax, dz = r[2 * c + 1] - az, len = Math.hypot(dx, dz);
    // outward: right of travel for a ring of positive area (as the beach rings above)
    const ox = (sign * dz) / (len || 1), oz = (-sign * dx) / (len || 1);
    for (; next < len; next += 20) {
      if (next < 1.5 || next > len - 1.5) continue; // not on a corner
      const x = ax + (dx * next) / len, z = az + (dz * next) / len;
      if (!inBox(PARTE_VIEJA, x, z) || !STREETS.has(surfAt(x + ox * 1.5, z + oz * 1.5)) || bld[cellOf(x + ox * 1.5, z + oz * 1.5)]) continue;
      if (wallLamps.some(([wx, wz]) => Math.hypot(wx / 100 - x, wz / 100 - z) < 11)) continue;
      wallLamps.push([Math.round((x + ox * 0.05) * 100), Math.round((z + oz * 0.05) * 100), heading(ox, oz)]);
    }
    next -= len;
  }
}
log(`wall lanterns (Parte Vieja): ${wallLamps.length}`);

const benches = [];
let benchesDropped = 0;
const allBeachEdges = new SegmentIndex();
for (const r of beachFeatures) allBeachEdges.addLine(r, true);
for (const e of osmFurniture) {
  if (e.type !== 'node' || e.tags?.amenity !== 'bench') continue;
  const [x, z] = lonLatToLocal(e.lon, e.lat);
  if (!inCore(x, z)) continue;
  const s = surfAt(x, z);
  if (bld[cellOf(x, z)] || s === G.road || s === G.water || s === G.rail) { benchesDropped++; continue; }
  let h;
  const dir = parseFloat(e.tags.direction);
  if (Number.isFinite(dir)) {
    // OSM: the way a seated person looks, clockwise from north (north = -z here)
    h = heading(Math.sin((dir * Math.PI) / 180), -Math.cos((dir * Math.PI) / 180));
  } else {
    const sea = allBeachEdges.distance(x, z, 30) < 30 ? nearestCell(x, z, 30, (k) => surf[k] === G.beach || surf[k] === G.water) : null;
    const wall = sea ? null : nearestCell(x, z, 5, (k) => bld[k] === 1);
    const road = sea || wall ? null : nearestCell(x, z, 12, (k) => surf[k] === G.road);
    if (sea) h = heading(sea[0], sea[1]);
    else if (wall) h = heading(-wall[0], -wall[1]);
    else if (road) h = heading(road[0], road[1]);
    else h = Math.floor(hash2(x * 10, z * 10, 9) * 360);
  }
  benches.push([Math.round(x * 100), Math.round(z * 100), h]);
}
log(`street lamps: ${lamps.length} (${lampsMoved} moved off facades, ${lampsDropped} dropped); benches: ${benches.length} (${benchesDropped} dropped)`);

// --- output ------------------------------------------------------------------------------------------------------------

const cm = (v) => Math.round(v * 100);
const DATA_OUT = {
  // Int32 x[N], z[N] interleaved (cm) | Uint8 species[N] | Uint8 scale[N] (x100), base64
  trees: { count: N, species: SPECIES_NAMES, data: packed.toString('base64') },
  // polylines [x, y, z, ...] in cm along the top of the promenade wall; travelling along one (dx, dz), the sea lies
  // towards (-dz, dx)
  railings: railings.map((r) => r.flatMap((p) => p.map(cm))),
  // [x, y, z] cm, standing just behind the railing
  promenadeLamps: promenadeLamps.flatMap((p) => p.map(cm)),
  // [x, z] cm and the heading in degrees (atan2(dx, dz) of the way it faces: lamps towards the street, benches the
  // way a seated person looks)
  lamps: lamps.flat(),
  // [x, z] cm on the facade and the heading (deg) of the wall's outward normal
  wallLamps: wallLamps.flat(),
  benches: benches.flat()
};
const js = '// js/donostia/data-streetscape.js — generated by tools/donostia/bake-streetscape.mjs; do not edit.\n' +
  '// Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0) · ' +
  '© OpenStreetMap contributors (ODbL) · Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0)\n' +
  licenceComment('c500', 'osm', 'geoeuskadi') +
  `export const STREETSCAPE = ${JSON.stringify(DATA_OUT)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${(js.length / 1e6).toFixed(2)} MB`);

// --preview <dir>: top views of the result over the ground classes (whole core, and the bay up close)
if (PREVIEW) {
  const dir = PREVIEW;
  fs.mkdirSync(dir, { recursive: true });
  const GROUND_RGB = [[70, 90, 50], [40, 40, 44], [120, 116, 108], [150, 136, 112], [60, 110, 40], [30, 60, 25], [220, 200, 150],
    [60, 90, 140], [200, 190, 180], [150, 50, 40], [170, 165, 150], [90, 80, 70]];
  const SPECIES_RGB = [[150, 230, 60], [255, 120, 220], [40, 200, 80], [0, 110, 60], [0, 255, 255], [255, 170, 0]];
  const view = (name, x0, z0, x1, z1, mpp) => {
    const w = Math.round((x1 - x0) / mpp), h = Math.round((z1 - z0) / mpp), px = new Uint8Array(w * h * 3);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const s = surfAt(x0 + (i + 0.5) * mpp, z0 + (j + 0.5) * mpp);
        px.set(GROUND_RGB[s] || [0, 0, 0], 3 * (j * w + i));
      }
    }
    const dot = (x, z, rgb, r = 0) => {
      const ci = Math.floor((x - x0) / mpp), cj = Math.floor((z - z0) / mpp);
      for (let dj = -r; dj <= r; dj++) {
        for (let di = -r; di <= r; di++) {
          const i = ci + di, j = cj + dj;
          if (i >= 0 && j >= 0 && i < w && j < h) px.set(rgb, 3 * (j * w + i));
        }
      }
    };
    const rr = Math.max(0, Math.round(0.6 / mpp));
    for (const t of trees) dot(t.x, t.z, SPECIES_RGB[t.sp], rr);
    for (const run of railings) {
      for (let k = 1; k < run.length; k++) {
        const [ax, , az] = run[k - 1], [bx, , bz] = run[k], n = Math.ceil(Math.hypot(bx - ax, bz - az) / (mpp * 0.5));
        for (let s = 0; s <= n; s++) dot(ax + ((bx - ax) * s) / n, az + ((bz - az) * s) / n, [255, 0, 0]);
      }
    }
    for (const [x, , z] of promenadeLamps) dot(x, z, [255, 255, 0], rr + 1);
    for (const [x, z] of lamps) dot(x / 100, z / 100, [255, 255, 255], rr + 1);
    for (const [x, z] of wallLamps) dot(x / 100, z / 100, [255, 140, 0], rr + 1);
    for (const [x, z] of benches) dot(x / 100, z / 100, [80, 80, 255], rr + 1);
    fs.writeFileSync(path.join(dir, name), encodePNG(px, w, h, 3));
  };
  view('streetscape-core.png', CORE.minX, CORE.minZ, CORE.maxX, CORE.maxZ, 2);
  view('streetscape-bay.png', -1400, -100, 420, 820, 0.5);
  view('streetscape-ondarreta.png', -1360, 380, -880, 700, 0.25);
  view('streetscape-pico-del-loro.png', -900, 560, -420, 800, 0.25);
  view('streetscape-kontxa-east.png', -60, 150, 340, 700, 0.25);
  view('streetscape-alderdi-eder.png', 60, -120, 380, 160, 0.25);
  view('streetscape-parte-vieja.png', 100, -440, 490, -100, 0.25);
  log(`previews in ${dir}`);
}
