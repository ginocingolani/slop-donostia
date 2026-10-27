// tools/donostia/bake-ground.mjs
// usage: node --max-old-space-size=8192 tools/donostia/bake-ground.mjs [--preview <dir>]
// Bakes the ground surfaces of the core (read by js/donostia/ground.js) from the municipal 1:500 polygons and
// OpenStreetMap, over the terrain of tools/donostia/build.mjs (data/donostia/terrain-core.png must exist):
//   data/donostia/ground-core.png       1 m over the core extent, four grey planes stacked top to bottom:
//                                       surface id (SURFACE below); distance from the texel centre to the edge of its
//                                       own surface (cm, clamped at 1.6 m); signed distance to the nearest kerb (road
//                                       side positive, 128 = on the kerb, 1/63 m steps, clamped at ±2 m); zebra crossing
//                                       slot in the texel's 256 m tile (0 = none)
//   data/donostia/ground-orient.png     2 m grey: direction of the nearest street edge (0..255 = 0..180°), so paving
//                                       and asphalt patches line up with the kerbs
//   data/donostia/ground-crossings.png  RGBA, one row per 256 m tile, three texels per crossing slot: centre x & z
//                                       (24-bit cm from the core corner), heading (16 bit over 180°), half length
//                                       (dm) and half width (dm)
// The surface map comes from a 1/7 m raster of the polygons; the distances let the shader rebuild every edge to a few
// centimetres from four texels, which a 1 m (or even 0.5 m) class map alone would draw as stair steps.
// --preview writes colour-coded checking images into the given folder.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, FRAME, encodePNG, lonLatToLocal, loadLayer, osmPolygons, previewDir, pngText, log } from './lib.mjs';
import { decodePNG } from '../../js/donostia/png.js';
import { BEACH_ACCESS } from '../../js/donostia/data-beach-access.js';

const ROOT = path.join(HERE, '..', '..');
const OUT = path.join(ROOT, 'data', 'donostia');
const PREVIEW = previewDir();
const t0 = performance.now();
const lap = (label) => log(`${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

// Surface ids (kept in step with js/donostia/ground.js)
export const SURFACE = {
  natural: 0, road: 1, sidewalk: 2, pedestrian: 3, garden: 4, woodland: 5, beach: 6, seabed: 7, building: 8, bike: 9,
  stairs: 10, rail: 11, setts: 12, path: 13, treePit: 14, flowers: 15, hedge: 16, yard: 17, rock: 18, quay: 19
};
const S = SURFACE;
// Surfaces that meet the carriageway at a kerb (a road against woodland, a path or the beach has none)
const KERBED = new Set([S.sidewalk, S.pedestrian, S.setts, S.garden, S.flowers, S.hedge, S.treePit, S.stairs, S.building, S.yard, S.bike]);
// Surfaces whose paving or patching follows the street
const ORIENTED = new Set([S.road, S.sidewalk, S.pedestrian, S.setts, S.bike, S.stairs, S.rail, S.yard, S.building, S.treePit]);
const KERB_PAIR = new Uint8Array(32 * 32);
for (const k of KERBED) KERB_PAIR[S.road * 32 + k] = KERB_PAIR[k * 32 + S.road] = 1;

const CORE = FRAME.core;
const W = CORE.maxX - CORE.minX, H = CORE.maxZ - CORE.minZ; // 1 m texels
const SS = 7; // raster cells per texel (odd, so a texel centre is a raster cell centre)
const MARGIN = 16; // raster cells around each strip (> the 2 m kerb range)
const STRIP = 64; // texel rows per strip
const D_MAX = 1.6, K_MAX = 2.0; // clamps of the edge & kerb distances (m)
const TILE = 256; // crossing lookup tiles (m)
const ORIENT_RES = 2;

// --- sources -----------------------------------------------------------------------------------------------------------

// (osmPolygons joins multipolygon members split over several ways; an open way is a line and yields nothing, which also
// leaves out the piers mapped as a single walkway line)
const places = loadLayer('osm_places.json').elements;
const osmAreas = (test) => places.filter((e) => test(e.tags || {})).flatMap(osmPolygons);
// La Concha, Ondarreta, Zurriola & the Santa Clara cove, with OSM's tidal sections down to the low-water line
const osmBeaches = osmAreas((t) => t.natural === 'beach');
const osmRock = osmAreas((t) => t.natural === 'bare_rock');
// Breakwaters & the closed piers of the port (the open ones are pontoons over the water); the rubble mounds of the
// Paseo Nuevo's apron and the Zurriola dike are rock under js/donostia/shore.js's boulders & cubes
const RUBBLE = new Set([702275854, 400267149]);
const osmQuays = places.filter((e) => !RUBBLE.has(e.id) && (e.tags?.man_made === 'breakwater' || (e.tags?.man_made === 'pier' && e.tags?.floating !== 'yes'))).flatMap(osmPolygons);
const osmRubble = places.filter((e) => RUBBLE.has(e.id) && e.tags?.man_made === 'breakwater').flatMap(osmPolygons);
// Paved squares outside the Parte Vieja
const osmSquares = osmAreas((t) => t.place === 'square' || t.surface === 'sett' || (t.highway === 'pedestrian' && t.area === 'yes'));
// The Parte Vieja between the Boulevard, the port, Urgull and the Urumea (OSM's boundary relation has no geometry)
const PARTE_VIEJA = [
  [-1.98800, 43.32190], [-1.98150, 43.32255], [-1.98140, 43.32420], [-1.98250, 43.32520], [-1.98420, 43.32525],
  [-1.98720, 43.32480], [-1.98880, 43.32420], [-1.98900, 43.32260]
].flatMap(([lon, lat]) => lonLatToLocal(lon, lat));

const c500 = (file) => loadLayer(file).features.map((f) => f.g.filter((r) => r.length >= 6)).filter((g) => g.length);
// The pieces of the stairs that tools/donostia/beach-access.mjs builds as the beaches' stairs & ramps (or leaves to the
// sand: BEACH_ACCESS.claimed, the mean of each outline's vertices) and the accesses' parts take the surfaces round them
// (FILL, resolved by fillAccesses): the promenade's paving on one side, the sand on the other, as far as the texels
// that straddle their outlines show
const claimed = BEACH_ACCESS.claimed || [];
const isClaimed = (g) => {
  const r = g[0];
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  x /= r.length / 2; z /= r.length / 2;
  for (let k = 0; k < claimed.length; k += 2) if (Math.abs(claimed[k] - x) < 0.02 && Math.abs(claimed[k + 1] - z) < 0.02) return true;
  return false;
};
const unclaimed = (g) => !isClaimed(g);
const FILL = 31; // a raster id of its own, gone before the edges are found
const accessPolys = [
  ...c500('c500_ESKAILERA.json').filter(isClaimed),
  ...(BEACH_ACCESS.parts || []).map((part) => [part.p])
];

// Painted in order, later layers win (as GROUND_LAYERS in build.mjs, with more surfaces). `over` limits a layer to
// cells already holding one of the listed surfaces.
const LAYERS = [
  { name: 'woodland', id: S.woodland, polys: c500('c500_ZuhaiztiGuneak.json') },
  { name: 'courtyards', id: S.yard, polys: [...c500('c500_BARRUKO_PATIOA.json'), ...c500('c500_UHARTE_PATIOA.json')] },
  { name: 'gardens', id: S.garden, polys: [...c500('c500_LORATEGI_EREMUA.json'), ...c500('c500_PARTERREA.json')] },
  { name: 'flower beds', id: S.flowers, polys: c500('c500_SASOIKO_LORATEGIA.json') },
  { name: 'hedges', id: S.hedge, polys: c500('c500_LANDARE_HESIA.json') },
  { name: 'bare rock', id: S.rock, polys: osmRock },
  { name: 'beaches', id: S.beach, polys: [...osmBeaches, ...c500('c500_HONDARTZA.json')] },
  { name: 'breakwaters & piers', id: S.quay, polys: osmQuays },
  { name: 'rubble mounds', id: S.rock, polys: osmRubble },
  { name: 'paths', id: S.path, polys: c500('c500_BIDEA.json') },
  { name: 'pedestrian', id: S.pedestrian, polys: c500('c500_OINEZKOEN_ZONA.json') },
  { name: 'sidewalks', id: S.sidewalk, polys: c500('c500_ESPALOIA.json') },
  { name: 'roads', id: S.road, polys: [...c500('c500_ERREPIDEA.json'), ...c500('c500_IBILGAILUEN_ZONA.json'), ...c500('c500_AUTOBIDEA.json')] },
  { name: 'railway', id: S.rail, polys: c500('c500_TRENBIDEA.json') },
  { name: 'bidegorris', id: S.bike, polys: c500('c500_BIDEGORRIA.json') },
  { name: 'tree pits', id: S.treePit, polys: c500('c500_ZUHAITZ_TXORKOA.json') },
  { name: 'stairs', id: S.stairs, polys: c500('c500_ESKAILERA.json').filter(unclaimed) },
  { name: "the beaches' stairs & ramps", id: FILL, polys: accessPolys },
  { name: 'buildings', id: S.building, polys: [...c500('c500_ERAIKINA.json'), ...c500('c500_EraikinArinak.json')] },
  {
    name: 'arcades & passages', id: S.pedestrian,
    polys: [...c500('c500_ARKUPEA.json'), ...c500('c500_ATARIPEA.json'), ...c500('c500_PASABIDEA.json')]
  },
  { name: 'Parte Vieja setts', id: S.setts, polys: [[PARTE_VIEJA]], over: [S.pedestrian, S.sidewalk] },
  { name: 'squares', id: S.setts, polys: osmSquares, over: [S.pedestrian] }
];

// Polygon -> { rings, minX, maxX, minZ, maxZ }, sorted by minZ for the strip sweep
for (const layer of LAYERS) {
  layer.items = layer.polys.map((rings) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const r of rings) for (let k = 0; k < r.length; k += 2) {
      if (r[k] < minX) minX = r[k];
      if (r[k] > maxX) maxX = r[k];
      if (r[k + 1] < minZ) minZ = r[k + 1];
      if (r[k + 1] > maxZ) maxZ = r[k + 1];
    }
    return { rings, minX, maxX, minZ, maxZ };
  }).filter((p) => p.maxX > CORE.minX - 10 && p.minX < CORE.maxX + 10 && p.maxZ > CORE.minZ - 10 && p.minZ < CORE.maxZ + 10)
    .sort((a, b) => a.minZ - b.minZ);
  layer.from = 0;
}

// Under every mapped layer, from the 2 m terrain bake (B channel = GEO.terrain.classes, 7 = water): sea & river beds,
// and the quays: flat unmapped ground a few metres above the water next to it (the port, the river walls, Sagüés),
// which the municipal map leaves blank and would otherwise come out as meadow
const terrainFile = fs.readFileSync(path.join(OUT, 'terrain-core.png'));
const terrainPNG = await decodePNG(terrainFile.buffer.slice(terrainFile.byteOffset, terrainFile.byteOffset + terrainFile.byteLength));
const TW = terrainPNG.width, TH = terrainPNG.height, TRES = 2;
if (TW * TRES !== W || TH * TRES !== H) throw new Error('terrain-core.png does not match the core extent');
const terrainBase = new Uint8Array(TW * TH); // S.natural / S.seabed / S.quay
{
  const px = terrainPNG.data;
  const height = new Float32Array(TW * TH);
  const toWater = new Uint8Array(TW * TH).fill(255); // 2 m steps to the nearest water cell (capped)
  const queue = [];
  for (let k = 0; k < TW * TH; k++) {
    height[k] = ((px[3 * k] << 8) | px[3 * k + 1]) / 100 - 100;
    if (px[3 * k + 2] === 7) { terrainBase[k] = S.seabed; toWater[k] = 0; queue.push(k); }
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q], i = k % TW, d = toWater[k] + 1;
    if (d > 15) continue;
    for (const n of [i > 0 ? k - 1 : -1, i < TW - 1 ? k + 1 : -1, k - TW, k + TW]) {
      if (n >= 0 && n < TW * TH && toWater[n] > d) { toWater[n] = d; queue.push(n); }
    }
  }
  for (let j = 1; j < TH - 1; j++) for (let i = 1; i < TW - 1; i++) {
    const k = j * TW + i, h = height[k];
    if (terrainBase[k] || toWater[k] > 15 || h < 1.2 || h > 9) continue;
    const slope = Math.max(Math.abs(height[k + 1] - height[k - 1]), Math.abs(height[k + TW] - height[k - TW])) / (2 * TRES);
    if (slope < 0.12) terrainBase[k] = S.quay;
  }
}
// Under a land bridge's deck (js/donostia/data-bridges.js, so bake-bridges.mjs runs first): the municipal map draws the
// road on the bridge in plan, so its carriageway and bike lane would be painted down the embankments and across the
// road below. Where the ground lies UNDER_DECK m or more below the deck, the steep cells are the embankment's grass and
// a bike lane on the flat ones is the carriageway below. 0: not under a deck; 1: under it, flat; 2: under it, steep
const UNDER_DECK = 2.5, EMBANKMENT = 0.35;
const underDeck = new Uint8Array(TW * TH);
{
  const { BRIDGES } = await import(pathToFileURL(path.join(HERE, '../../js/donostia/data-bridges.js')).href);
  const px = terrainPNG.data;
  const h = (i, j) => ((px[3 * (j * TW + i)] << 8) | px[3 * (j * TW + i) + 1]) / 100 - 100;
  let cells = 0;
  for (const b of BRIDGES) {
    if (b.water) continue;
    const a = b.axis, half = Math.max(...[b.width].flat()) / 2 + 0.5;
    let L = 0;
    const seg = [];
    for (let k = 2; k < a.length; k += 2) {
      const l = Math.hypot(a[k] - a[k - 2], a[k + 1] - a[k - 1]);
      seg.push([a[k - 2], a[k - 1], a[k], a[k + 1], L, l]);
      L += l;
    }
    const xs = a.filter((_, k) => k % 2 === 0), zs = a.filter((_, k) => k % 2 === 1);
    const i0 = Math.max(1, Math.floor((Math.min(...xs) - half - CORE.minX) / TRES)), i1 = Math.min(TW - 2, Math.ceil((Math.max(...xs) + half - CORE.minX) / TRES));
    const j0 = Math.max(1, Math.floor((Math.min(...zs) - half - CORE.minZ) / TRES)), j1 = Math.min(TH - 2, Math.ceil((Math.max(...zs) + half - CORE.minZ) / TRES));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = CORE.minX + (i + 0.5) * TRES, z = CORE.minZ + (j + 0.5) * TRES;
      let best = Infinity, sAt = 0;
      for (const [ax, az, bx, bz, s0, l] of seg) {
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / (l * l || 1)));
        const d = Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az));
        if (d < best) { best = d; sAt = s0 + t * l; }
      }
      if (best > half || sAt <= 0 || sAt >= L) continue;
      const deck = b.y[0] + ((b.y[1] - b.y[0]) * sAt) / L;
      if (h(i, j) > deck - UNDER_DECK) continue;
      const slope = Math.max(Math.abs(h(i + 1, j) - h(i - 1, j)), Math.abs(h(i, j + 1) - h(i, j - 1))) / (2 * TRES);
      underDeck[j * TW + i] = slope > EMBANKMENT ? 2 : 1;
      cells++;
    }
  }
  log(`ground under land bridges: ${cells * TRES * TRES} m² repainted (embankments grass, no bike lanes from the deck)`);
}
lap('sources');

// --- 1/7 m raster in strips: surfaces, then distances to their edges and to the kerbs ----------------------------------

const FW = W * SS + 2 * MARGIN; // raster columns (x from CORE.minX - MARGIN / SS)
const fx0 = CORE.minX - MARGIN / SS;
const surface = new Uint8Array(W * H);
const edgeDist = new Uint8Array(W * H);
const kerbDist = new Uint8Array(W * H);

// Even-odd scanline fill of a polygon over raster rows [r0, r1) of the strip whose first row is `rowBase` (absolute);
// with `over`, only cells already holding one of those surfaces change
function fillPolygon(cls, poly, rowBase, r0, r1, id, over) {
  const fz0 = CORE.minZ - MARGIN / SS; // absolute raster row 0 sits at this z (top edge)
  const zOf = (row) => fz0 + (row + 0.5) / SS;
  const lo = Math.max(r0, Math.ceil((poly.minZ - fz0) * SS - 0.5) - rowBase);
  const hi = Math.min(r1 - 1, Math.floor((poly.maxZ - fz0) * SS - 0.5) - rowBase);
  if (lo > hi) return;
  // edges overlapping these rows
  const zLo = zOf(rowBase + lo), zHi = zOf(rowBase + hi);
  const ex0 = [], ez0 = [], ex1 = [], ez1 = [];
  for (const r of poly.rings) {
    const n = r.length / 2;
    for (let a = 0, b = n - 1; a < n; b = a++) {
      const za = r[2 * a + 1], zb = r[2 * b + 1];
      if ((za < zLo && zb < zLo) || (za > zHi && zb > zHi) || za === zb) continue;
      ex0.push(r[2 * a]); ez0.push(za); ex1.push(r[2 * b]); ez1.push(zb);
    }
  }
  const xs = [];
  for (let row = lo; row <= hi; row++) {
    const zc = zOf(rowBase + row);
    xs.length = 0;
    for (let e = 0; e < ex0.length; e++) {
      const za = ez0[e], zb = ez1[e];
      if ((za > zc) !== (zb > zc)) xs.push(ex0[e] + ((zc - za) / (zb - za)) * (ex1[e] - ex0[e]));
    }
    if (xs.length < 2) continue;
    xs.sort((p, q) => p - q);
    const base = row * FW;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil((xs[k] - fx0) * SS - 0.5)), c1 = Math.min(FW - 1, Math.floor((xs[k + 1] - fx0) * SS - 0.5));
      if (c0 > c1) continue;
      if (!over) cls.fill(id, base + c0, base + c1 + 1);
      else for (let c = c0; c <= c1; c++) if (over.includes(cls[base + c])) cls[base + c] = id;
    }
  }
}

// The beaches' stairs & ramps (FILL) take the surfaces either side of them, along the rows and then the columns, split
// down the middle; past up to THIN cells of unmapped ground (the gap the municipal map leaves round the stairs)
function fillAccesses(cls, rows) {
  const run = (get, set, n) => {
    let a = 0;
    while (a < n) {
      if (get(a) !== FILL) { a++; continue; }
      let e = a;
      while (e < n && get(e) === FILL) e++;
      const look = (k, step) => {
        let first = -1;
        for (let t = 0; t < THIN && k >= 0 && k < n; t++, k += step) {
          const c = get(k);
          if (c === FILL) return first;
          if (first < 0) first = c;
          if (c !== S.natural) return c;
        }
        return first;
      };
      const before = look(a - 1, -1), after = look(e, 1);
      if (before >= 0 || after >= 0) {
        const mid = (a + e) >> 1;
        for (let k = a; k < e; k++) set(k, (k < mid ? before : after) >= 0 ? (k < mid ? before : after) : Math.max(before, after));
      }
      a = e;
    }
  };
  for (let y = 0; y < rows; y++) {
    const b = y * FW;
    run((k) => cls[b + k], (k, v) => { cls[b + k] = v; }, FW);
  }
  for (let x = 0; x < FW; x++) run((k) => cls[k * FW + x], (k, v) => { cls[k * FW + x] = v; }, rows);
  for (let k = 0; k < FW * rows; k++) if (cls[k] === FILL) cls[k] = S.natural;
}

// Slivers of unmapped ground or hedge narrower than ~1.1 m between mapped surfaces (the gaps the municipal polygons
// leave along kerbs, thin hedges) would come back from 1 m texels as strings of blobs: they go to the surfaces on
// either side, split down the middle
const THIN = 8; // raster cells
const SLIVER = new Uint8Array(32);
SLIVER[S.natural] = SLIVER[S.hedge] = 1;
function clearSlivers(cls, rows) {
  const run = (get, set, n) => {
    let a = 0;
    while (a < n) {
      const c = get(a);
      if (!SLIVER[c]) { a++; continue; }
      let e = a;
      while (e < n && get(e) === c) e++;
      if (e - a < THIN && a > 0 && e < n) {
        const before = get(a - 1), after = get(e);
        if (!SLIVER[before] && !SLIVER[after]) {
          const mid = (a + e) >> 1;
          for (let k = a; k < e; k++) set(k, k < mid ? before : after);
        }
      }
      a = e;
    }
  };
  for (let y = 0; y < rows; y++) {
    const b = y * FW;
    run((k) => cls[b + k], (k, v) => { cls[b + k] = v; }, FW);
  }
  for (let x = 0; x < FW; x++) run((k) => cls[k * FW + x], (k, v) => { cls[k * FW + x] = v; }, rows);
}

// Vertical distance (in raster cells, capped at 255) to the nearest feature cell of each column
function columnDistances(feature, rows, out) {
  for (let x = 0; x < FW; x++) out[x] = feature[x] ? 0 : 255;
  for (let y = 1; y < rows; y++) {
    const b = y * FW, p = b - FW;
    for (let x = 0; x < FW; x++) out[b + x] = feature[b + x] ? 0 : Math.min(255, out[p + x] + 1);
  }
  for (let y = rows - 2; y >= 0; y--) {
    const b = y * FW, n = b + FW;
    for (let x = 0; x < FW; x++) if (out[n + x] + 1 < out[b + x]) out[b + x] = out[n + x] + 1;
  }
}

{
  const stripRows = STRIP * SS + 2 * MARGIN;
  const rowSea = new Float32Array(TW), rowQuay = new Float32Array(TW);
  const cls = new Uint8Array(FW * stripRows);
  const f1 = new Uint8Array(FW * stripRows), f2 = new Uint8Array(FW * stripRows);
  const g1 = new Uint8Array(FW * stripRows), g2 = new Uint8Array(FW * stripRows);
  const R1 = Math.ceil(D_MAX * SS), R2 = Math.ceil(K_MAX * SS);
  for (let j0 = 0; j0 < H; j0 += STRIP) {
    const j1 = Math.min(H, j0 + STRIP);
    const rowBase = j0 * SS; // absolute raster row of the strip's first row (raster rows start MARGIN cells above the core)
    const rows = (j1 - j0) * SS + 2 * MARGIN;
    const zTop = CORE.minZ - MARGIN / SS + rowBase / SS, zBottom = zTop + rows / SS;
    cls.fill(S.natural, 0, FW * rows);
    // sea & river beds and quays from the 2 m terrain, each mask interpolated bilinearly and cut at one half so their
    // outlines run smooth instead of in 2 m steps
    for (let y = 0; y < rows; y++) {
      const tz = (zTop + (y + 0.5) / SS - CORE.minZ) / TRES - 0.5;
      const tj = Math.floor(tz), fz = tz - tj;
      if (tj < -1 || tj >= TH) continue;
      const ja = Math.max(0, tj), jb = Math.min(TH - 1, tj + 1);
      for (let ti = 0; ti < TW; ti++) {
        const a = terrainBase[ja * TW + ti], b = terrainBase[jb * TW + ti];
        rowSea[ti] = (a === S.seabed) * (1 - fz) + (b === S.seabed) * fz;
        rowQuay[ti] = (a === S.quay) * (1 - fz) + (b === S.quay) * fz;
      }
      const base = y * FW;
      for (let ti = -1; ti < TW; ti++) {
        const i0 = Math.max(0, ti), i1 = Math.min(TW - 1, ti + 1);
        const s0 = rowSea[i0], s1 = rowSea[i1], q0 = rowQuay[i0], q1 = rowQuay[i1];
        if (!s0 && !s1 && !q0 && !q1) continue;
        // raster columns between the centres of 2 m cells ti and ti + 1
        const xa = CORE.minX + (ti + 0.5) * TRES, c0 = Math.max(0, Math.ceil((xa - fx0) * SS - 0.5));
        const c1 = Math.min(FW - 1, Math.floor((xa + TRES - fx0) * SS - 0.5));
        for (let c = c0; c <= c1; c++) {
          const fxx = (fx0 + (c + 0.5) / SS - xa) / TRES;
          if (s0 + (s1 - s0) * fxx > 0.5) cls[base + c] = S.seabed;
          else if (q0 + (q1 - q0) * fxx > 0.5) cls[base + c] = S.quay;
        }
      }
    }
    for (const layer of LAYERS) {
      while (layer.from < layer.items.length && layer.items[layer.from].maxZ < zTop - 50) layer.from++;
      for (let k = layer.from; k < layer.items.length; k++) {
        const poly = layer.items[k];
        if (poly.minZ > zBottom) break;
        if (poly.maxZ < zTop) continue;
        fillPolygon(cls, poly, rowBase, 0, rows, layer.id, layer.over);
      }
    }
    // under the land bridges' decks (see underDeck)
    const fz0 = CORE.minZ - MARGIN / SS;
    for (let y = 0; y < rows; y++) {
      const tj = Math.floor((fz0 + (rowBase + y + 0.5) / SS - CORE.minZ) / TRES);
      if (tj < 0 || tj >= TH) continue;
      const b = y * FW;
      for (let x = 0; x < FW; x++) {
        const ti = Math.floor((fx0 + (x + 0.5) / SS - CORE.minX) / TRES);
        const u = ti >= 0 && ti < TW ? underDeck[tj * TW + ti] : 0;
        if (u === 2 && cls[b + x] !== S.building && cls[b + x] !== S.stairs) cls[b + x] = S.natural;
        else if (u === 1 && cls[b + x] === S.bike) cls[b + x] = S.road;
      }
    }
    fillAccesses(cls, rows);
    clearSlivers(cls, rows);
    // edge cells, on both sides of an edge: any change of surface (f1); a carriageway against a kerbed surface (f2)
    f1.fill(0, 0, FW * rows);
    f2.fill(0, 0, FW * rows);
    for (let y = 0; y < rows; y++) {
      const b = y * FW;
      for (let x = 0; x < FW; x++) {
        const c = cls[b + x];
        if (x + 1 < FW && cls[b + x + 1] !== c) {
          f1[b + x] = f1[b + x + 1] = 1;
          if (KERB_PAIR[c * 32 + cls[b + x + 1]]) f2[b + x] = f2[b + x + 1] = 1;
        }
        if (y + 1 < rows && cls[b + FW + x] !== c) {
          f1[b + x] = f1[b + FW + x] = 1;
          if (KERB_PAIR[c * 32 + cls[b + FW + x]]) f2[b + x] = f2[b + FW + x] = 1;
        }
      }
    }
    columnDistances(f1, rows, g1);
    columnDistances(f2, rows, g2);
    for (let j = j0; j < j1; j++) {
      const y = (j - j0) * SS + (SS >> 1) + MARGIN;
      const b = y * FW;
      for (let i = 0; i < W; i++) {
        const x = i * SS + (SS >> 1) + MARGIN;
        const c = cls[b + x];
        let best1 = Infinity, best2 = Infinity;
        for (let dx = -R2; dx <= R2; dx++) {
          const xx = x + dx;
          const v2 = g2[b + xx];
          if (v2 < 255) { const q = dx * dx + v2 * v2; if (q < best2) best2 = q; }
          if (dx >= -R1 && dx <= R1) {
            const v1 = g1[b + xx];
            if (v1 < 255) { const q = dx * dx + v1 * v1; if (q < best1) best1 = q; }
          }
        }
        // distances run between cell centres; the edge itself lies half a cell beyond the nearest edge cell
        const d1 = Math.min(D_MAX, (Math.sqrt(best1) + 0.5) / SS);
        const d2 = Math.min(K_MAX, (Math.sqrt(best2) + 0.5) / SS);
        const k = j * W + i;
        surface[k] = c;
        edgeDist[k] = Math.round(d1 * 100);
        kerbDist[k] = Math.max(0, Math.min(255, Math.round(128 + (c === S.road ? d2 : -d2) * 63)));
      }
    }
  }
}
lap('surface raster & edge distances');

const surfaceAt = (x, z) => {
  const i = Math.floor(x - CORE.minX), j = Math.floor(z - CORE.minZ);
  return i < 0 || j < 0 || i >= W || j >= H ? -1 : surface[j * W + i];
};

// --- street orientation ------------------------------------------------------------------------------------------------
// Next to a kerb, its exact direction (so tiles, kerbstones & asphalt patches run with the street); elsewhere the
// prevailing direction of the kerbs and facades within some 25 m, taken modulo 90° so that the two sides of a block
// agree. Only real edges count: the shared sides of adjoining road polygons or party walls do not.

const OW = W / ORIENT_RES, OH = H / ORIENT_RES;
const orient = new Uint8Array(OW * OH);
{
  // [x0, z0, x1, z1, isKerb] of edges with the surface on one side only
  const edges = [];
  const collect = (polys, id, kerb) => {
    for (const rings of polys) for (const r of rings) {
      const n = r.length / 2;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ax = r[2 * b], az = r[2 * b + 1], bx = r[2 * a], bz = r[2 * a + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.5) continue;
        const mx = (ax + bx) / 2, mz = (az + bz) / 2, nx = -(bz - az) / len, nz = (bx - ax) / len;
        const l = surfaceAt(mx + 0.75 * nx, mz + 0.75 * nz) === id, rr = surfaceAt(mx - 0.75 * nx, mz - 0.75 * nz) === id;
        if (l !== rr) edges.push([ax, az, bx, bz, kerb]);
      }
    }
  };
  for (const layer of LAYERS) {
    if (layer.name === 'roads') collect(layer.polys, S.road, 1);
    if (layer.name === 'buildings') collect(layer.polys, S.building, 0);
  }
  // prevailing direction: length-weighted (cos 4θ, sin 4θ) deposited along each edge, then blurred
  const C4 = new Float32Array(OW * OH), S4 = new Float32Array(OW * OH);
  for (const [ax, az, bx, bz] of edges) {
    const len = Math.hypot(bx - ax, bz - az), th = Math.atan2(bz - az, bx - ax);
    const c = Math.cos(4 * th), sn = Math.sin(4 * th), steps = Math.ceil(len);
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const i = Math.floor((ax + t * (bx - ax) - CORE.minX) / ORIENT_RES), j = Math.floor((az + t * (bz - az) - CORE.minZ) / ORIENT_RES);
      if (i < 0 || j < 0 || i >= OW || j >= OH) continue;
      C4[j * OW + i] += (c * len) / steps;
      S4[j * OW + i] += (sn * len) / steps;
    }
  }
  const boxBlur = (a, r) => {
    const tmp = new Float32Array(a.length);
    for (let j = 0; j < OH; j++) {
      let acc = 0;
      for (let i = -r; i < OW + r; i++) {
        if (i + r < OW) acc += a[j * OW + i + r];
        if (i - r - 1 >= 0) acc -= a[j * OW + i - r - 1];
        if (i >= 0 && i < OW) tmp[j * OW + i] = acc;
      }
    }
    for (let i = 0; i < OW; i++) {
      let acc = 0;
      for (let j = -r; j < OH + r; j++) {
        if (j + r < OH) acc += tmp[(j + r) * OW + i];
        if (j - r - 1 >= 0) acc -= tmp[(j - r - 1) * OW + i];
        if (j >= 0 && j < OH) a[j * OW + i] = acc;
      }
    }
  };
  for (let pass = 0; pass < 3; pass++) { boxBlur(C4, 4); boxBlur(S4, 4); }
  // kerbs, bucketed for the nearest-kerb search
  const B = 8, BW = Math.ceil(W / B) + 1, BH = Math.ceil(H / B) + 1;
  const buckets = Array.from({ length: BW * BH }, () => []);
  edges.forEach((e, idx) => {
    if (!e[4]) return;
    const i0 = Math.max(0, Math.floor((Math.min(e[0], e[2]) - CORE.minX) / B)), i1 = Math.min(BW - 1, Math.floor((Math.max(e[0], e[2]) - CORE.minX) / B));
    const k0 = Math.max(0, Math.floor((Math.min(e[1], e[3]) - CORE.minZ) / B)), k1 = Math.min(BH - 1, Math.floor((Math.max(e[1], e[3]) - CORE.minZ) / B));
    for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) buckets[k * BW + i].push(idx);
  });
  const NEAR_KERB = 7; // m
  let near = 0, prevailing = 0;
  for (let oj = 0; oj < OH; oj++) {
    for (let oi = 0; oi < OW; oi++) {
      let any = false;
      for (let b = 0; b < ORIENT_RES && !any; b++) for (let a = 0; a < ORIENT_RES; a++) {
        if (ORIENTED.has(surface[(oj * ORIENT_RES + b) * W + oi * ORIENT_RES + a])) { any = true; break; }
      }
      if (!any) continue;
      const px = CORE.minX + (oi + 0.5) * ORIENT_RES, pz = CORE.minZ + (oj + 0.5) * ORIENT_RES;
      const bi = Math.floor((px - CORE.minX) / B), bk = Math.floor((pz - CORE.minZ) / B);
      let best = NEAR_KERB * NEAR_KERB, hit = null;
      for (let k = bk - 1; k <= bk + 1; k++) {
        if (k < 0 || k >= BH) continue;
        for (let i = bi - 1; i <= bi + 1; i++) {
          if (i < 0 || i >= BW) continue;
          for (const idx of buckets[k * BW + i]) {
            const [ax, az, bx, bz] = edges[idx], dx = bx - ax, dz = bz - az;
            const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz)));
            const ex = ax + t * dx - px, ez = az + t * dz - pz, d = ex * ex + ez * ez;
            if (d < best) { best = d; hit = edges[idx]; }
          }
        }
      }
      let ang;
      if (hit) {
        ang = Math.atan2(hit[3] - hit[1], hit[2] - hit[0]);
        near++;
      } else {
        const k = oj * OW + oi;
        if (Math.hypot(C4[k], S4[k]) < 1e-3) continue;
        ang = Math.atan2(S4[k], C4[k]) / 4;
        prevailing++;
      }
      ang = ((ang % Math.PI) + Math.PI) % Math.PI;
      // any change of angle is a seam in the paving (the patterns turn about the frame origin), so the slowly turning
      // prevailing direction is snapped to 2.8° steps and only kerbs keep the full 0.7°
      const steps = hit ? 1 : 4;
      orient[oj * OW + oi] = (Math.round((ang / Math.PI) * (256 / steps)) * steps) & 255;
    }
  }
  log(`street orientation: ${edges.length} edges, ${near} cells by a kerb, ${prevailing} by the prevailing direction`);
}
lap('street orientation');

// --- zebra crossings from OpenStreetMap ---------------------------------------------------------------------------------

const streets = loadLayer('osm_streets.json').elements;
const furniture = loadLayer('osm_furniture.json').elements;
const ROADWAYS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link',
  'tertiary', 'tertiary_link', 'residential', 'unclassified', 'living_street', 'service', 'busway']);
const marked = (t) => t.crossing !== 'unmarked' && t.crossing !== 'no' && !['no', 'dots', 'dashes', 'surface'].includes(t['crossing:markings']);

// Road segments of OSM carriageways (direction for the crossing nodes that have no crossing way)
const roadSegs = [];
for (const e of streets) {
  const t = e.tags || {};
  if (!ROADWAYS.has(t.highway) || !e.geometry) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  for (let k = 0; k + 1 < pts.length; k++) roadSegs.push([...pts[k], ...pts[k + 1]]);
}
function nearestSeg(segs, x, z, maxD) {
  let best = maxD * maxD, hit = null;
  for (const s of segs) {
    const dx = s[2] - s[0], dz = s[3] - s[1], l2 = dx * dx + dz * dz;
    if (!l2) continue;
    const t = Math.max(0, Math.min(1, ((x - s[0]) * dx + (z - s[1]) * dz) / l2));
    const ex = s[0] + t * dx - x, ez = s[1] + t * dz - z, d = ex * ex + ez * ez;
    if (d < best) { best = d; hit = s; }
  }
  return hit;
}

// Walks the crossing line both ways over the carriageway (stepping over islands up to 3 m) and returns its extent
function roadExtent(x, z, ux, uz) {
  const span = (sign) => {
    let last = 0, gap = 0;
    for (let s = 0.25; s <= 30; s += 0.25) {
      if (surfaceAt(x + sign * s * ux, z + sign * s * uz) === S.road) { last = s; gap = 0; } else if ((gap += 0.25) > 3) break;
    }
    return last;
  };
  return [span(-1), span(1)];
}

const crossings = [];
function addCrossing(x, z, ux, uz, source) {
  // centre on the carriageway: nudge onto the road when the mapped point sits on a kerb
  if (surfaceAt(x, z) !== S.road) {
    let found = false;
    for (let s = 0.5; s <= 3 && !found; s += 0.5) {
      for (const sign of [1, -1]) {
        if (surfaceAt(x + sign * s * ux, z + sign * s * uz) === S.road) { x += sign * s * ux; z += sign * s * uz; found = true; break; }
      }
    }
    if (!found) return false;
  }
  const [a, b] = roadExtent(x, z, ux, uz);
  const len = a + b;
  if (len < 2.5) return false;
  const cx = x + ((b - a) / 2) * ux, cz = z + ((b - a) / 2) * uz, halfLen = Math.min(25, len / 2 + 0.5);
  // one crossing per place: the same zebra mapped as a way and as a node, or once per carriageway, would overlap and
  // the slot map can only name one of them per metre
  for (const c of crossings) {
    if (Math.abs(c.ux * ux + c.uz * uz) < 0.85) continue;
    const dx = cx - c.x, dz = cz - c.z;
    const along = Math.abs(dx * -c.uz + dz * c.ux), across = Math.abs(dx * c.ux + dz * c.uz);
    if (along < 2 * c.halfWid + 0.5 && across < c.halfLen + halfLen) return false;
  }
  crossings.push({ x: cx, z: cz, ux, uz, halfLen, halfWid: 2, source });
  return true;
}

const crossingWays = streets.filter((e) => e.tags && e.tags.footway === 'crossing' && e.geometry && e.geometry.length >= 2 && marked(e.tags));
const crossingWaySegs = [];
let fromWays = 0, fromNodes = 0;
for (const e of crossingWays) {
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  for (let k = 0; k + 1 < pts.length; k++) crossingWaySegs.push([...pts[k], ...pts[k + 1]]);
  const [ax, az] = pts[0], [bx, bz] = pts[pts.length - 1];
  const len = Math.hypot(bx - ax, bz - az);
  if (len < 1) continue;
  let ux = (bx - ax) / len, uz = (bz - az) / len;
  // anchor at the vertex over the carriageway nearest the middle, else the middle
  let best = null;
  for (const [x, z] of pts) if (surfaceAt(x, z) === S.road && (!best || Math.hypot(x - (ax + bx) / 2, z - (az + bz) / 2) < best.d)) best = { x, z, d: Math.hypot(x - (ax + bx) / 2, z - (az + bz) / 2) };
  const x = best ? best.x : (ax + bx) / 2, z = best ? best.z : (az + bz) / 2;
  // bars square to the carriageway: crossing ways are often drawn kerb to kerb at a slant
  const road = nearestSeg(roadSegs, x, z, 4);
  if (road) {
    const rl = Math.hypot(road[2] - road[0], road[3] - road[1]);
    const px = -(road[3] - road[1]) / rl, pz = (road[2] - road[0]) / rl;
    const sign = px * ux + pz * uz < 0 ? -1 : 1;
    ux = sign * px;
    uz = sign * pz;
  }
  if (addCrossing(x, z, ux, uz, 'way')) fromWays++;
}
for (const e of furniture) {
  const t = e.tags || {};
  if (e.type !== 'node' || t.highway !== 'crossing' || !marked(t)) continue;
  const [x, z] = lonLatToLocal(e.lon, e.lat);
  if (x < CORE.minX || x > CORE.maxX || z < CORE.minZ || z > CORE.maxZ) continue;
  if (nearestSeg(crossingWaySegs, x, z, 2.5)) continue; // drawn from its crossing way already
  const road = nearestSeg(roadSegs, x, z, 3);
  if (!road) continue;
  const len = Math.hypot(road[2] - road[0], road[3] - road[1]);
  if (addCrossing(x, z, -(road[3] - road[1]) / len, (road[2] - road[0]) / len, 'node')) fromNodes++;
}
log(`crossings: ${crossings.length} (${fromWays} from crossing ways, ${fromNodes} from crossing nodes)`);

// Slots per 256 m tile; each crossing marks the texels within 1.5 m of its rectangle so the nearest texel of any
// point on it (and its anti-aliased rim) carries the slot
const TX = Math.ceil(W / TILE), TZ = Math.ceil(H / TILE);
const tileSlots = Array.from({ length: TX * TZ }, () => []);
const crossingSlot = new Uint8Array(W * H);
let dropped = 0;
for (const c of crossings) {
  const tx = -c.uz, tz = c.ux; // along the road
  const ex = c.halfLen + 1.5, ew = c.halfWid + 1.5;
  const rx = Math.abs(c.ux) * ex + Math.abs(tx) * ew, rz = Math.abs(c.uz) * ex + Math.abs(tz) * ew;
  const i0 = Math.max(0, Math.floor(c.x - rx - CORE.minX)), i1 = Math.min(W - 1, Math.ceil(c.x + rx - CORE.minX));
  const j0 = Math.max(0, Math.floor(c.z - rz - CORE.minZ)), j1 = Math.min(H - 1, Math.ceil(c.z + rz - CORE.minZ));
  const slotIn = new Map();
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const px = CORE.minX + i + 0.5 - c.x, pz = CORE.minZ + j + 0.5 - c.z;
      if (Math.abs(px * c.ux + pz * c.uz) > ex || Math.abs(px * tx + pz * tz) > ew) continue;
      const tile = Math.floor(j / TILE) * TX + Math.floor(i / TILE);
      let slot = slotIn.get(tile);
      if (slot === undefined) {
        if (tileSlots[tile].length >= 255) { dropped++; slotIn.set(tile, 0); continue; }
        tileSlots[tile].push(c);
        slot = tileSlots[tile].length;
        slotIn.set(tile, slot);
      }
      if (slot) crossingSlot[j * W + i] = slot;
    }
  }
}
const maxSlots = Math.max(1, ...tileSlots.map((s) => s.length));
log(`crossing slots: up to ${maxSlots} per tile${dropped ? `, ${dropped} dropped` : ''}`);

// --- outputs -------------------------------------------------------------------------------------------------------------

fs.mkdirSync(OUT, { recursive: true });
const write = (file, buf, what) => {
  fs.writeFileSync(path.join(OUT, file), buf);
  log(`data/donostia/${file}: ${what}, ${(buf.length / 1e6).toFixed(2)} MB`);
};
{
  // An edge distance only matters to the 2 x 2 texels around an edge: saturate it wherever the 3 x 3 neighbourhood is
  // all one surface, which halves the file
  const edges = edgeDist.slice();
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, c = surface[k];
    let uniform = true;
    for (let b = -1; b <= 1 && uniform; b++) for (let a = -1; a <= 1; a++) {
      const ii = Math.min(W - 1, Math.max(0, i + a)), jj = Math.min(H - 1, Math.max(0, j + b));
      if (surface[jj * W + ii] !== c) { uniform = false; break; }
    }
    if (uniform) edges[k] = Math.round(D_MAX * 100);
  }
  // The four planes stacked as one grey image (PNG picks its row filters per plane), interleaved again at load time
  const px = new Uint8Array(W * H * 4);
  px.set(surface, 0);
  px.set(edges, W * H);
  px.set(kerbDist, 2 * W * H);
  px.set(crossingSlot, 3 * W * H);
  write('ground-core.png', encodePNG(px, W, 4 * H, 1, pngText('c500', 'osm', 'geoeuskadi')), `${W}x${H} @ 1 m, 4 planes`);
}
write('ground-orient.png', encodePNG(orient, OW, OH, 1, pngText('c500', 'osm')), `${OW}x${OH} @ ${ORIENT_RES} m`);
{
  const cw = 3 * maxSlots, px = new Uint8Array(cw * TX * TZ * 4);
  tileSlots.forEach((slots, tile) => slots.forEach((c, s) => {
    const o = 4 * (tile * cw + 3 * s);
    const xcm = Math.round((c.x - CORE.minX) * 100), zcm = Math.round((c.z - CORE.minZ) * 100);
    let ang = Math.atan2(c.uz, c.ux);
    ang = ((ang % Math.PI) + Math.PI) % Math.PI;
    const a16 = Math.min(65535, Math.round((ang / Math.PI) * 65536));
    px.set([xcm >> 16, (xcm >> 8) & 255, xcm & 255, zcm >> 16, (zcm >> 8) & 255, zcm & 255, a16 >> 8, a16 & 255,
      Math.round(c.halfLen * 10), Math.round(c.halfWid * 10), 0, 255], o);
  }));
  write('ground-crossings.png', encodePNG(px, cw, TX * TZ, 4, pngText('osm', 'c500')), `${crossings.length} crossings in ${TX}x${TZ} tiles`);
}
lap('done');

// --- previews ------------------------------------------------------------------------------------------------------------

if (PREVIEW) {
  const PALETTE = {
    [S.natural]: [96, 120, 60], [S.road]: [50, 52, 56], [S.sidewalk]: [190, 186, 176], [S.pedestrian]: [205, 190, 160],
    [S.garden]: [70, 150, 50], [S.woodland]: [30, 70, 30], [S.beach]: [235, 210, 150], [S.seabed]: [40, 90, 120],
    [S.building]: [120, 60, 60], [S.bike]: [190, 50, 40], [S.stairs]: [230, 230, 120], [S.rail]: [110, 90, 80],
    [S.setts]: [150, 140, 170], [S.path]: [200, 170, 120], [S.treePit]: [80, 50, 20], [S.flowers]: [230, 80, 200],
    [S.hedge]: [20, 100, 40], [S.yard]: [160, 160, 150], [S.rock]: [130, 130, 130], [S.quay]: [200, 120, 220]
  };
  fs.mkdirSync(PREVIEW, { recursive: true });
  const px = new Uint8Array(W * H * 3);
  for (let k = 0; k < W * H; k++) {
    const c = PALETTE[surface[k]] || [255, 0, 255];
    const kerb = Math.abs(kerbDist[k] - 128) < 12 ? 1 : 0;
    px.set(kerb ? [255, 255, 255] : c, 3 * k);
    if (crossingSlot[k]) px.set([255, 240, 0], 3 * k);
  }
  fs.writeFileSync(path.join(PREVIEW, 'ground-surfaces.png'), encodePNG(px, W, H, 3));
  log(`preview in ${PREVIEW}`);
}
