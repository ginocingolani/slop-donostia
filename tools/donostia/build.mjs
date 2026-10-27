// tools/donostia/build.mjs
// usage: node --max-old-space-size=8192 tools/donostia/build.mjs [--preview <dir>]
// Bakes the Donostia runtime data from tools/donostia/raw (fetch.sh) and tools/donostia/data (extract.py):
//   data/donostia/terrain-core.png     2 m heights over the core extent (R/G = 16-bit cm above -100 m, B = water 0..255)
//   data/donostia/terrain-context.png  8 m heights over the whole terrain-tile union (horizon hills & sea floor)
//   data/donostia/water.png            swell exposure, river & seaward flow on the context grid (js/donostia/water.js)
//   js/donostia/geodata.js             frame, terrain metadata (with the shore walls), buildings, landmark sites &
//                                      teleports
//   js/donostia/data-beach-access.js  the stairs & ramps down to the beaches (tools/donostia/beach-access.mjs)
// --preview writes debug images (hillshade, building heights) into the given folder.
// Needs the raw cache: raw/dtm/*.asc and raw/bathy/isobaths.json, which extract.py writes (build-all.sh --fetch).

import fs from 'node:fs';
import path from 'node:path';
import {
  HERE, RAW, FRAME, Grid, readAscGrid, encodePNG, HEIGHT_OFFSET, scanRings, ringArea, ringBounds, pointInRing,
  lonLatToLocal, loadLayer, osmPolygons, previewDir, licenceComment, pngText, log
} from './lib.mjs';
import { detectWalls, detectStairs, quayEdges, shoreGuides, wallExclusions } from './walls.mjs';
import { beachAccesses, carveTerrain } from './beach-access.mjs';
import { WALL, wallSnaps, wallIndex, nearestWall } from '../../js/donostia/shore-walls.js';

const ROOT = path.join(HERE, '..', '..');
const OUT_DATA = path.join(ROOT, 'data', 'donostia');
const OUT_JS = path.join(ROOT, 'js', 'donostia', 'geodata.js');
const OUT_ACCESS = path.join(ROOT, 'js', 'donostia', 'data-beach-access.js');
const PREVIEW = previewDir();
const t0 = performance.now();
const lap = (label) => log(`${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const CORE = FRAME.core;
// The context grid spans the terrain-tile union on an 8 m lattice that the core rectangle snaps to
const CONTEXT = { minX: -6056, maxX: 4216, minZ: -3744, maxZ: 5696 };
const CORE_RES = 2, CONTEXT_RES = 8, BATHY_RES = 4;
const r2 = (v) => Math.round(v * 100) / 100;

// --- 1. 1 m DTM mosaic -------------------------------------------------------------------------------------------------

function mosaicDTM() {
  const dir = path.join(RAW, 'dtm');
  const tiles = fs.readdirSync(dir).filter((f) => f.endsWith('.asc')).sort().map((f) => readAscGrid(path.join(dir, f)));
  if (!tiles.length) throw new Error(`no DTM tiles in ${dir} (run tools/donostia/build-all.sh --fetch)`);
  const grid = Grid.over(CONTEXT, 1);
  for (const t of tiles) {
    // the mosaic copies cells one to one: every tile must sit on the context grid's 1 m lattice
    if (t.cell !== 1 || !Number.isInteger(t.x0 - grid.x0) || !Number.isInteger(t.z0 - grid.z0)) {
      throw new Error(`DTM tile at (${t.x0}, ${t.z0}) with ${t.cell} m cells is not on the 1 m lattice`);
    }
    const di = t.x0 - grid.x0, dj = t.z0 - grid.z0;
    for (let r = 0; r < t.nrows; r++) {
      const j = dj + r;
      if (j < 0 || j >= grid.h) continue;
      for (let c = 0; c < t.ncols; c++) {
        const i = di + c, v = t.data[r * t.ncols + c];
        if (i < 0 || i >= grid.w || Number.isNaN(v)) continue;
        const k = j * grid.w + i;
        // overlapping tile borders agree to the centimetre; keep the first value
        if (Number.isNaN(grid.data[k])) grid.data[k] = v;
      }
    }
  }
  return grid;
}

// --- 2. Water: the LiDAR terrain writes the sea surface as exactly 0 m; flood it from the open (northern) edge -----------

// Water mask values (1 m cells). The survey flew at low tide: the river mouth below the Zurriola bridge and the lower
// intertidal sand came out as measured bed below 0 m rather than as a 0 m water surface, so they keep their measured
// heights (BED). Ponds & fountains above sea level keep their own surface: their cells sink POND_SINK below it and
// js/donostia/water.js lays the surface back on top.
const WATER = { land: 0, sea: 1, river: 2, bed: 3, pond: 4 };
const POND_SINK = 0.4; // m, mirrored in js/donostia/water.js
const POND_LEVEL = 1.0; // m: OSM water whose median surveyed height is above this is a pond, not the tidal river

function waterMask(dtm) {
  const { w, h, data } = dtm;
  const water = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const flood = (open, value) => {
    while (top) {
      const k = stack[--top], i = k % w;
      const next = [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w];
      for (const n of next) {
        if (n >= 0 && n < w * h && open(n)) { water[n] = value; stack[top++] = n; }
      }
    }
  };
  const offshore = unsurveyedSea(dtm);
  const openSea = (k) => water[k] === WATER.land && (data[k] === 0 || (Number.isNaN(data[k]) && offshore(k)));
  for (let i = 0; i < w; i++) if (openSea(i)) { water[i] = WATER.sea; stack[top++] = i; }
  flood(openSea, WATER.sea);

  // Rivers, ponds & docks mapped in OSM (the Urumea surface is not always exactly 0 in the terrain)
  const osm = loadLayer('osm_places.json').elements;
  let ponds = 0;
  for (const e of osm) {
    const t = e.tags || {};
    const isWater = t.natural === 'water' || t.waterway === 'riverbank' || t.water;
    if (!isWater || t.leisure === 'swimming_pool') continue;
    for (const rings of osmPolygons(e)) {
      const cells = [], heights = [];
      scanRings(rings, dtm.x0, dtm.z0, 1, w, h, (i, j) => {
        const k = j * w + i;
        cells.push(k);
        if (!Number.isNaN(data[k])) heights.push(data[k]);
      });
      heights.sort((a, b) => a - b);
      const median = heights.length ? heights[heights.length >> 1] : 0;
      // (a stream up a valley counts as a pond too: its surface follows the survey down the slope)
      const pond = median > POND_LEVEL;
      if (pond) ponds++;
      else if (heights.length > 2000) log(`water: ${t.name || `${e.type}/${e.id}`} at sea level (median ${median.toFixed(2)} m)`);
      for (const k of cells) if (water[k] !== WATER.sea) water[k] = pond ? WATER.pond : WATER.river;
    }
  }

  // Bed surveyed below sea level next to the sea & the river is under water at mean sea level
  const below = (k) => water[k] === WATER.land && data[k] < -0.02;
  for (let k = 0; k < w * h; k++) {
    if (!below(k)) continue;
    const i = k % w;
    const wet = (n) => water[n] === WATER.sea || water[n] === WATER.river;
    if ((i > 0 && wet(k - 1)) || (i < w - 1 && wet(k + 1)) || (k >= w && wet(k - w)) || (k + w < w * h && wet(k + w))) {
      water[k] = WATER.bed;
      stack[top++] = k;
    }
  }
  flood(below, WATER.bed);
  let bed = 0;
  for (let k = 0; k < w * h; k++) if (water[k] === WATER.bed) bed++;
  log(`water: ${ponds} ponds above sea level, ${(bed / 1e6).toFixed(2)} km² of bed surveyed below sea level`);
  carveBridges(dtm, water);
  return water;
}

// Cells outside the surveyed tiles are open sea only when they lie nearer the isobaths than the surveyed land: the
// missing land tile south-west of Igeldo touches the coast at one corner and would otherwise flood into an inland sea.
// Returns a test on 1 m DTM cell indices, decided on an 8 m lattice.
function unsurveyedSea(dtm) {
  const s = 8, w = Math.round(dtm.w / s), h = Math.round(dtm.h / s);
  const land = new Uint8Array(w * h), iso = new Uint8Array(w * h);
  for (let j = 0; j < dtm.h; j += 2) {
    for (let i = 0; i < dtm.w; i += 2) {
      if (dtm.data[j * dtm.w + i] > 0.5) land[Math.min(h - 1, (j / s) | 0) * w + Math.min(w - 1, (i / s) | 0)] = 1;
    }
  }
  for (const f of loadLayer(path.join(RAW, 'bathy', 'isobaths.json')).features) {
    for (const line of f.g) {
      for (let k = 0; k < line.length; k += 2) {
        const i = Math.floor((line[k] - dtm.x0) / s), j = Math.floor((line[k + 1] - dtm.z0) / s);
        if (i >= 0 && j >= 0 && i < w && j < h) iso[j * w + i] = 1;
      }
    }
  }
  const dIso = chamfer(w, h, s, (k) => iso[k] === 1), dLand = chamfer(w, h, s, (k) => land[k] === 1);
  return (k) => {
    const i = Math.min(w - 1, ((k % dtm.w) / s) | 0), j = Math.min(h - 1, ((k / dtm.w / s) | 0));
    return dIso[j * w + i] < dLand[j * w + i];
  };
}

// Deck width (m) of an OSM bridge way: width tag, else lanes, else a typical width for its kind. Mirrored in
// tools/donostia/bake-bridges.mjs.
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

// Bridge decks the terrain kept as ground across the water: carve the cells under each OSM bridge way's span over the
// water down to the river bed. The first & last 2 m of the span stay, so the quay walls under the abutments survive.
function carveBridges(dtm, water) {
  const { w, h } = dtm;
  const ways = loadLayer('osm_streets.json').elements.filter((e) => {
    const t = e.tags || {};
    return e.type === 'way' && e.geometry && e.geometry.length >= 2 && t.bridge && t.bridge !== 'no' &&
      (t.highway || t.railway) && t.area !== 'yes';
  });
  const cell = (x, z) => {
    const i = Math.floor(x - dtm.x0), j = Math.floor(z - dtm.z0);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  const isWet = (k) => k >= 0 && water[k] >= WATER.sea && water[k] <= WATER.bed;
  let carved = 0, spans = 0;
  for (const e of ways) {
    const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
    const samples = [];
    for (let s = 1; s < pts.length; s++) {
      const [ax, az] = pts[s - 1], [bx, bz] = pts[s];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const tx = (bx - ax) / len, tz = (bz - az) / len;
      for (let d = 0; d < len; d += 1) samples.push([ax + tx * d, az + tz * d, -tz, tx]);
    }
    let a = -1, b = -1;
    samples.forEach(([x, z], q) => { if (isWet(cell(x, z))) { if (a < 0) a = q; b = q; } });
    if (a < 0) continue;
    spans++;
    const half = deckWidth(e.tags) / 2;
    for (let q = a + 2; q <= b - 2; q++) {
      const [x, z, nx, nz] = samples[q];
      for (let o = -half; o <= half; o += 0.5) {
        const k = cell(x + nx * o, z + nz * o);
        if (k >= 0 && (water[k] === WATER.land || water[k] === WATER.pond)) { water[k] = WATER.river; carved++; }
      }
    }
  }
  log(`bridges: ${spans} OSM bridge ways cross the water, ${carved} m² of deck kept as ground carved to the river bed`);
}

// --- 3. Sea floor: isobaths + shoreline as fixed values, harmonic fill in between (coarse-to-fine Gauss-Seidel) ---------

function bathymetry(dtm, water) {
  const grid = Grid.over(CONTEXT, BATHY_RES);
  const fixed = new Uint8Array(grid.w * grid.h);
  const s = BATHY_RES;
  // shoreline & land: the mean of the land samples in each cell, capped at 0 so the floor rises to meet the beach
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      let sum = 0, n = 0, sea = 0;
      for (let b = 0; b < s; b++) {
        for (let a = 0; a < s; a++) {
          const k = (j * s + b) * dtm.w + i * s + a;
          // the surveyed bed below sea level & the ponds' own levels count as known heights
          if (water[k] === WATER.sea || water[k] === WATER.river) sea++;
          else if (!Number.isNaN(dtm.data[k])) { sum += dtm.data[k]; n++; }
        }
      }
      if (n > sea) {
        grid.data[j * grid.w + i] = Math.min(0, sum / n);
        fixed[j * grid.w + i] = 1;
      }
    }
  }
  const iso = loadLayer(path.join(RAW, 'bathy', 'isobaths.json')).features;
  for (const f of iso) {
    const depth = f.p.CONTOUR;
    for (const line of f.g) {
      for (let k = 0; k + 3 < line.length; k += 2) {
        const x0 = line[k], z0 = line[k + 1], x1 = line[k + 2], z1 = line[k + 3];
        const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / (s / 2)));
        for (let q = 0; q <= steps; q++) {
          const x = x0 + ((x1 - x0) * q) / steps, z = z0 + ((z1 - z0) * q) / steps;
          const i = Math.floor((x - grid.x0) / s), j = Math.floor((z - grid.z0) / s);
          if (i < 0 || j < 0 || i >= grid.w || j >= grid.h) continue;
          const idx = j * grid.w + i;
          if (fixed[idx] === 1) continue; // land wins over a contour drawn across the beach
          grid.data[idx] = depth;
          fixed[idx] = 2;
        }
      }
    }
  }
  harmonicFill(grid, fixed);
  return grid;
}

function harmonicFill(grid, fixed) {
  // Pyramid of known values; solve the coarsest level, then refine each finer level from the upsampled guess
  const levels = [{ w: grid.w, h: grid.h, v: grid.data, f: fixed }];
  while (levels[levels.length - 1].w > 96) {
    const p = levels[levels.length - 1];
    const w = Math.ceil(p.w / 2), h = Math.ceil(p.h / 2);
    const v = new Float32Array(w * h), f = new Uint8Array(w * h);
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        let sum = 0, n = 0;
        for (let b = 0; b < 2; b++) for (let a = 0; a < 2; a++) {
          const pi = 2 * i + a, pj = 2 * j + b;
          if (pi < p.w && pj < p.h && p.f[pj * p.w + pi]) { sum += p.v[pj * p.w + pi]; n++; }
        }
        if (n) { v[j * w + i] = sum / n; f[j * w + i] = 1; }
      }
    }
    levels.push({ w, h, v, f });
  }
  for (let L = levels.length - 1; L >= 0; L--) {
    const { w, h, v, f } = levels[L];
    if (L === levels.length - 1) {
      let mean = 0, n = 0;
      for (let k = 0; k < v.length; k++) if (f[k]) { mean += v[k]; n++; }
      for (let k = 0; k < v.length; k++) if (!f[k]) v[k] = n ? mean / n : -10;
    } else {
      const c = levels[L + 1];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (!f[k]) v[k] = c.v[Math.min(c.h - 1, j >> 1) * c.w + Math.min(c.w - 1, i >> 1)];
      }
    }
    const sweeps = L === levels.length - 1 ? 2000 : 60;
    for (let it = 0; it < sweeps; it++) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const k = j * w + i;
        if (f[k]) continue;
        let sum = 0, n = 0;
        if (i > 0) { sum += v[k - 1]; n++; }
        if (i < w - 1) { sum += v[k + 1]; n++; }
        if (j > 0) { sum += v[k - w]; n++; }
        if (j < h - 1) { sum += v[k + w]; n++; }
        v[k] += 1.6 * (sum / n - v[k]); // over-relaxed
      }
    }
  }
}

// --- 4. Terrain grids --------------------------------------------------------------------------------------------------

// Down-samples the 1 m terrain into res-metre cells over ext: land cells average their land samples, water cells take
// the sea floor (never above -0.3 m), river cells a bed 1.2 m deep at the banks and up to 3.5 m mid-stream, surveyed bed
// & ponds keep their heights (ponds sunk by POND_SINK), cells without any data are filled from their neighbours.
// kind: the cell's dominant WATER value (0 on land).
function terrainGrid(dtm, water, floor, ext, res) {
  const grid = Grid.over(ext, res);
  const wet = new Uint8Array(grid.w * grid.h);
  const kind = new Uint8Array(grid.w * grid.h);
  const oi = Math.round(ext.minX - dtm.x0), oj = Math.round(ext.minZ - dtm.z0);
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      let sum = 0, n = 0, sea = 0, river = 0, bed = 0, pond = 0;
      for (let b = 0; b < res; b++) {
        for (let a = 0; a < res; a++) {
          const k = (oj + j * res + b) * dtm.w + oi + i * res + a;
          const wk = water[k];
          if (wk === WATER.sea) sea++;
          else if (wk === WATER.river) river++;
          else if (!Number.isNaN(dtm.data[k])) {
            sum += wk === WATER.pond ? dtm.data[k] - POND_SINK : dtm.data[k];
            n++;
            if (wk === WATER.bed) bed++;
            else if (wk === WATER.pond) pond++;
          }
        }
      }
      const cell = res * res, k = j * grid.w + i;
      wet[k] = Math.round((255 * (sea + river + bed + pond)) / cell);
      if (wet[k] > 127) {
        const top = Math.max(sea, river, bed, pond);
        kind[k] = top === river ? WATER.river : top === sea ? WATER.sea : top === bed ? WATER.bed : WATER.pond;
      }
      if (sea + river > n) {
        const x = ext.minX + (i + 0.5) * res, z = ext.minZ + (j + 0.5) * res;
        const f = floor.sample(x, z);
        grid.data[k] = river > sea ? Math.min(-1.2, Number.isFinite(f) ? f : -1.2) : Math.min(-0.3, Number.isFinite(f) ? f : -5);
      } else if (n) grid.data[k] = sum / n;
    }
  }
  // River beds deepen away from the banks (the harmonic sea floor has no isobaths up the Urumea)
  const toBank = chamfer(grid.w, grid.h, res, (k) => kind[k] !== WATER.river);
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] === WATER.river) grid.data[k] = Math.min(grid.data[k], -1.2 - Math.min(2.3, 0.06 * toBank[k]));
  }
  // Holes (outside the downloaded tiles but not sea): a smooth membrane between the known heights, roughened with
  // rolling hills that fade in away from its edges (growing the edges inwards left long straight streaks)
  const known = new Uint8Array(grid.data.length);
  let holes = 0;
  for (let k = 0; k < known.length; k++) if (Number.isNaN(grid.data[k])) holes++; else known[k] = 1;
  if (holes) {
    harmonicFill(grid, known);
    const edge = chamfer(grid.w, grid.h, res, (k) => known[k] === 1);
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
      const k = j * grid.w + i;
      if (known[k]) continue;
      const x = ext.minX + (i + 0.5) * res, z = ext.minZ + (j + 0.5) * res;
      const fade = Math.min(1, edge[k] / 400);
      grid.data[k] = Math.max(grid.data[k] + fade * fade * (3 - 2 * fade) * 110 * (hills(x, z) - 0.5), 1);
    }
  }
  return { grid, wet, kind };
}

// Deterministic fractal value noise (about 0..1, mean 0.5) for the unsurveyed hills: quintic fades and a rotation per
// octave so the lattice does not show in the hillshade
function hills(x, z) {
  const hash = (i, j) => {
    let t = Math.imul(i, 374761393) ^ Math.imul(j, 668265263);
    t = Math.imul(t ^ (t >>> 13), 1274126177);
    return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
  };
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const value = (u, v) => {
    const i = Math.floor(u), j = Math.floor(v), su = fade(u - i), sv = fade(v - j);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return (a + (b - a) * su) * (1 - sv) + (c + (d - c) * su) * sv;
  };
  let sum = 0, amp = 0.5, f = 1 / 1300, u = x, v = z;
  for (let o = 0; o < 5; o++) {
    sum += amp * value(u * f + 17.3 * o, v * f - 9.1 * o);
    [u, v] = [0.8 * u - 0.6 * v, 0.6 * u + 0.8 * v];
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / 0.97;
}

// Two-pass chamfer distance (m) on a w x h grid of res-metre cells to the nearest cell where isTarget(k)
function chamfer(w, h, res, isTarget) {
  const d = new Float32Array(w * h);
  for (let k = 0; k < d.length; k++) d[k] = isTarget(k) ? 0 : 1e9;
  const a = res, b = res * Math.SQRT2;
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0) {
      v = Math.min(v, d[k - w] + a);
      if (i > 0) v = Math.min(v, d[k - w - 1] + b);
      if (i < w - 1) v = Math.min(v, d[k - w + 1] + b);
    }
    d[k] = v;
  }
  for (let j = h - 1; j >= 0; j--) for (let i = w - 1; i >= 0; i--) {
    const k = j * w + i;
    let v = d[k];
    if (i < w - 1) v = Math.min(v, d[k + 1] + a);
    if (j < h - 1) {
      v = Math.min(v, d[k + w] + a);
      if (i < w - 1) v = Math.min(v, d[k + w + 1] + b);
      if (i > 0) v = Math.min(v, d[k + w - 1] + b);
    }
    d[k] = v;
  }
  return d;
}

// --- 4b. Water fields for js/donostia/water.js ------------------------------------------------------------------------

// data/donostia/water.png on the context grid (same x0, z0, w, h, res as terrain-context.png), RGBA:
//   R  exposure to the Biscay swell (0 sheltered harbour .. 255 open sea): the share of the W-NW-N-NE sector that is
//      open water for 4 km through gaps wider than SWELL.gap, blurred so a little swell bends round the headlands
//   G  river (0 sea .. 255 river or pond): grows with the distance from the open sea through the water
//   B,A flow towards the sea (x, z), 128 = still, 127 = 1 m/s
// Land texels take their neighbours' water values so bilinear sampling along the shore stays clean.
// azimuths (° clockwise from north) the swell arrives from, how far a ray looks for land, the open water a ray keeps
// clear of after its first `skip` metres before it counts in full (m)
const SWELL = { from: 285, to: 25, reach: 4000, gap: 150, skip: 200 };

function waterFields(ctx, file) {
  const { grid, wet, kind } = ctx;
  const { w, h, res } = grid;
  const isWater = (k) => wet[k] > 127;
  const land = chamfer(w, h, res, (k) => !isWater(k));

  // Exposure: rays towards the swell sector, sphere-traced through the distance-to-land field. A ray that reaches the
  // open sea only counts in full if it never squeezes between land closer than SWELL.gap: La Concha's swell has to
  // come in past Santa Klara through gaps a few hundred metres wide and arrives much weakened.
  const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const exposure = new Float32Array(w * h);
  const ray = (i, j, dx, dz) => {
    let t = res, narrowest = Infinity;
    while (t < SWELL.reach) {
      const ii = Math.floor(i + 0.5 + (dx * t) / res), jj = Math.floor(j + 0.5 + (dz * t) / res);
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) break; // beyond the grid: open sea
      const d = land[jj * w + ii];
      if (d === 0) return 0;
      if (t > SWELL.skip) narrowest = Math.min(narrowest, d);
      t += Math.max(res, Math.min(d - res, 200));
    }
    return smooth(0, SWELL.gap, narrowest);
  };
  const mid = (((SWELL.from + SWELL.to + 360) / 2) % 360) * Math.PI / 180;
  const sector = [];
  for (let az = SWELL.from; az <= SWELL.to + 360; az += 5) {
    const a = ((az % 360) * Math.PI) / 180;
    sector.push([Math.sin(a), -Math.cos(a), 0.35 + Math.cos(a - mid) ** 2]);
  }
  const wsum = sector.reduce((s, d) => s + d[2], 0);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    if (!isWater(k)) continue;
    let open = 0;
    for (const [dx, dz, wt] of sector) open += wt * ray(i, j, dx, dz);
    exposure[k] = open / wsum;
  }
  blurWater(exposure, w, h, isWater, 6);

  // River: geodesic distance from the open sea through the water, by chamfer sweeps restricted to the water and repeated
  // until nothing changes (each meander of the Urumea costs a pair of sweeps)
  const fromSea = new Float32Array(w * h).fill(1e9);
  for (let k = 0; k < fromSea.length; k++) if (kind[k] === WATER.sea && land[k] > 3 * res) fromSea[k] = 0;
  const a = res, b = res * Math.SQRT2;
  for (let pass = 0, changed = true; changed && pass < 64; pass++) {
    changed = false;
    const relax = (k, v) => { if (v < fromSea[k] - 1e-3) { fromSea[k] = v; changed = true; } };
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      if (isWater(k)) relax(k, Math.min(fromSea[k - 1] + a, fromSea[k - w] + a, fromSea[k - w - 1] + b, fromSea[k - w + 1] + b));
    }
    for (let j = h - 2; j > 0; j--) for (let i = w - 2; i > 0; i--) {
      const k = j * w + i;
      if (isWater(k)) relax(k, Math.min(fromSea[k + 1] + a, fromSea[k + w] + a, fromSea[k + w + 1] + b, fromSea[k + w - 1] + b));
    }
  }
  const river = new Float32Array(w * h), fx = new Float32Array(w * h), fz = new Float32Array(w * h);
  for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
    const k = j * w + i;
    if (!isWater(k)) continue;
    const d = fromSea[k];
    if (d >= 1e8) { river[k] = 1; continue; } // ponds: still water
    river[k] = smooth(60, 320, d);
    // downhill in distance-from-sea is seaward; one-sided where a neighbour is land
    const at = (n) => (isWater(n) && fromSea[n] < 1e8 ? fromSea[n] : d);
    let gx = (at(k + 1) - at(k - 1)) / (2 * res), gz = (at(k + w) - at(k - w)) / (2 * res);
    const len = Math.hypot(gx, gz);
    if (len > 1e-6) { gx /= len; gz /= len; }
    const speed = 0.55 * smooth(20, 200, d); // tidal Urumea: ~0.5 m/s ebb through the city, slack in the bay
    fx[k] = -gx * speed;
    fz[k] = -gz * speed;
  }
  blurWater(river, w, h, isWater, 2);
  blurWater(fx, w, h, isWater, 3);
  blurWater(fz, w, h, isWater, 3);

  // Shore texels borrow their water neighbours' values (a few rings deep) so bilinear sampling never pulls land zeros in
  const fields = [exposure, river, fx, fz];
  const known = new Uint8Array(w * h);
  for (let k = 0; k < known.length; k++) known[k] = isWater(k) ? 1 : 0;
  for (let ring = 0; ring < 4; ring++) {
    const add = [];
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      if (known[k]) continue;
      const nb = [k - 1, k + 1, k - w, k + w].filter((n) => known[n]);
      if (nb.length) add.push([k, nb]);
    }
    for (const [k, nb] of add) {
      for (const f of fields) f[k] = nb.reduce((s, n) => s + f[n], 0) / nb.length;
      known[k] = 1;
    }
  }

  const px = new Uint8Array(w * h * 4);
  const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)));
  for (let k = 0; k < w * h; k++) {
    px[4 * k] = u8(255 * exposure[k]);
    px[4 * k + 1] = u8(255 * river[k]);
    px[4 * k + 2] = u8(128 + 127 * fx[k]);
    px[4 * k + 3] = u8(128 + 127 * fz[k]);
  }
  const out = encodePNG(px, w, h, 4, pngText('geoeuskadi', 'osm'));
  fs.writeFileSync(file, out);
  log(`${path.relative(ROOT, file)}: ${w}x${h} @ ${res} m, ${(out.length / 1e6).toFixed(2)} MB`);
  return { exposure, river };
}

// Box blur (3x3, repeated) of a field over the water cells only
function blurWater(f, w, h, isWater, passes) {
  const tmp = new Float32Array(f.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(f);
    for (let j = 1; j < h - 1; j++) for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      if (!isWater(k)) continue;
      let s = 0, n = 0;
      for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++) {
        const q = k + b * w + a;
        if (isWater(q)) { s += tmp[q]; n++; }
      }
      f[k] = s / n;
    }
  }
}

// Ground classes (B channel of the terrain images), painted in this order so later layers win
export const GROUND = { natural: 0, road: 1, sidewalk: 2, pedestrian: 3, garden: 4, woodland: 5, beach: 6, water: 7, building: 8, bike: 9, stairs: 10, rail: 11 };
const GROUND_LAYERS = [
  ['c500_ZuhaiztiGuneak.json', GROUND.woodland],
  ['c500_LORATEGI_EREMUA.json', GROUND.garden], ['c500_PARTERREA.json', GROUND.garden],
  ['c500_SASOIKO_LORATEGIA.json', GROUND.garden], ['c500_LANDARE_HESIA.json', GROUND.garden],
  ['c500_HONDARTZA.json', GROUND.beach],
  ['c500_BIDEA.json', GROUND.pedestrian], ['c500_OINEZKOEN_ZONA.json', GROUND.pedestrian],
  ['c500_ESPALOIA.json', GROUND.sidewalk],
  ['c500_ERREPIDEA.json', GROUND.road], ['c500_IBILGAILUEN_ZONA.json', GROUND.road], ['c500_AUTOBIDEA.json', GROUND.road],
  ['c500_TRENBIDEA.json', GROUND.rail], ['c500_BIDEGORRIA.json', GROUND.bike], ['c500_ESKAILERA.json', GROUND.stairs],
  ['c500_ERAIKINA.json', GROUND.building], ['c500_EraikinArinak.json', GROUND.building]
];

function groundClasses(grid, wet) {
  const cls = new Uint8Array(grid.w * grid.h);
  for (const [file, id] of GROUND_LAYERS) {
    for (const f of loadLayer(file).features) {
      scanRings(f.g, grid.x0, grid.z0, grid.res, grid.w, grid.h, (i, j) => { cls[j * grid.w + i] = id; });
    }
  }
  // the beach polygons stop at the dry sand; water wins below the waterline everywhere
  for (let k = 0; k < cls.length; k++) if (wet[k] > 127) cls[k] = GROUND.water;
  return cls;
}

// --- 4c. Shore walls: La Concha's promenade wall, the Paseo Nuevo, the Urumea's & the port's quays ---------------------

// The 2 m grid smears every sea wall into a ramp a cell or two wide. tools/donostia/walls.mjs finds the walls in the 1 m
// LiDAR (and along a few of the port's quays, the municipal map's edges); tools/donostia/beach-access.mjs adds the lines
// behind the stairs & ramps built in front of a wall (which the search leaves out). The samples on either side of each wall line that share a triangle across it (wallSnaps, which
// js/donostia/terrain.js runs again to move them onto the line) lose the smear: those in front drop to the foot of the
// wall (never rising: the river bed stays) and take the ground class of the cell beyond, those behind come back up to
// the promenade's level. Nothing further from a wall changes. Returns { walls (GEO.terrain.walls), access (the beach
// accesses, beachAccesses()) }.
function shoreWalls(dtm, grid, classes) {
  const t = performance.now();
  // OSM water at sea level, as the water mask has it (ponds sit above POND_LEVEL)
  const seaLevel = (rings) => {
    const heights = [];
    scanRings(rings, dtm.x0, dtm.z0, 1, dtm.w, dtm.h, (i, j) => {
      const v = dtm.data[j * dtm.w + i];
      if (!Number.isNaN(v)) heights.push(v);
    });
    heights.sort((a, b) => a - b);
    return heights.length > 0 && heights[heights.length >> 1] <= POND_LEVEL;
  };
  const classAt = (x, z) => {
    const i = Math.floor((x - grid.x0) / grid.res), j = Math.floor((z - grid.z0) / grid.res);
    return i < 0 || j < 0 || i >= grid.w || j >= grid.h ? -1 : classes[j * grid.w + i];
  };
  const margin = 12;
  const searched = detectWalls({
    dtm, classAt, log,
    guides: shoreGuides({ loadLayer, osmPolygons, lonLatToLocal, seaLevel }),
    exclude: wallExclusions({ loadLayer, scanRings, lonLatToLocal, ext: CORE }),
    bounds: { minX: CORE.minX + margin, maxX: CORE.maxX - margin, minZ: CORE.minZ + margin, maxZ: CORE.maxZ - margin }
  });
  // (and the port's quays where the search finds only scraps: the north basin's north quay, the old slipway's sides)
  const found = quayEdges({ dtm, walls: searched, loadLayer, log });
  const buildingRings = ['c500_ERAIKINA.json', 'c500_EraikinArinak.json'].flatMap((f) => loadLayer(f).features.map((b) => b.g[0]));
  const access = beachAccesses({ dtm, walls: found, buildings: buildingRings, loadLayer, log });
  // (the hidden runs, where an access standing on the sand meets higher ground, step the terrain like any wall: the
  // runtime moves the same samples, js/donostia/terrain.js)
  const walls = access.walls;
  const snaps = wallSnaps(walls, grid);
  const at = (k) => [grid.x0 + ((k % grid.w) + 0.5) * grid.res, grid.z0 + (Math.floor(k / grid.w) + 0.5) * grid.res];
  // In front: out to where the (battered) face meets the ground and a cell beyond, nothing stands above the foot; what
  // drops takes the class of the ground beyond (the beach, the rocks, the water)
  const BAND = 2.9, PAD = 9;
  const index = wallIndex(walls, 16, PAD);
  const seen = new Uint8Array(grid.w * grid.h);
  let lowered = 0, raised = 0;
  for (const wall of walls) {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < wall.p.length; k += 4) {
      minX = Math.min(minX, wall.p[k]); maxX = Math.max(maxX, wall.p[k]);
      minZ = Math.min(minZ, wall.p[k + 1]); maxZ = Math.max(maxZ, wall.p[k + 1]);
    }
    const i0 = Math.max(0, Math.floor((minX - PAD - grid.x0) / grid.res)), i1 = Math.min(grid.w - 1, Math.ceil((maxX + PAD - grid.x0) / grid.res));
    const j0 = Math.max(0, Math.floor((minZ - PAD - grid.z0) / grid.res)), j1 = Math.min(grid.h - 1, Math.ceil((maxZ + PAD - grid.z0) / grid.res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * grid.w + i;
      if (seen[k]) continue;
      seen[k] = 1;
      const [x, z] = at(k);
      const q = nearestWall(walls, x, z, PAD, index);
      if (!q || q.end || q.d <= 0) continue;
      const w = walls[q.wall];
      // (the band measured from the wall itself: beyond a bend's vertex the distance off the segment's line says little)
      if (Math.hypot(x - q.x, z - q.z) > BAND + w.b * Math.max(0, q.deck - q.foot)) continue;
      const snapped = snaps.get(k);
      if (grid.data[k] > q.foot + 0.1 || snapped) {
        if (grid.data[k] > q.foot + 0.1) { grid.data[k] = q.foot; lowered++; }
        const out = BAND + 2 + w.b * Math.max(0, q.deck - q.foot) - q.d;
        const beyond = classAt(x + q.nx * out, z + q.nz * out);
        if (beyond >= 0 && beyond !== GROUND.building) classes[k] = beyond;
      }
    }
  }
  // Behind: the smear back up to the promenade's level, and nothing over the coping (the Paseo Nuevo's parapet, which
  // the LiDAR keeps as a hump, is modelled: level with the walk)
  for (const [k, s] of snaps) {
    if (s.side > 0) continue;
    const v = grid.data[k];
    const level = walls[s.wall].t === WALL.paseo ? s.deck : Math.min(Math.max(v, s.deck), s.deck + 0.04);
    if (v < s.deck - 0.15 || v > s.deck + 0.04 || walls[s.wall].t === WALL.paseo) {
      if (Math.abs(level - v) > 0.005) raised++;
      grid.data[k] = level;
    }
  }
  log(`shore walls: ${access.walls.length} runs, ${access.walls.reduce((n, w) => n + w.p.length / 4, 0)} vertices; ${snaps.size} terrain ` +
    `samples onto the walls, ${lowered} in front dropped to the foot, ${raised} behind levelled with the promenade ` +
    `(${((performance.now() - t) / 1000).toFixed(1)} s)`);
  return { walls: access.walls, access };
}

// --- 4d. The flights of steps down from the shore walls ------------------------------------------------------------------

// tools/donostia/walls.mjs finds the municipal map's stairs by the walls (but those of the beaches, which
// tools/donostia/beach-access.mjs builds) and fits their slope to the 1 m LiDAR; js/donostia/shore.js builds them as
// stone steps. The terrain samples inside a flight are kept a little under its slope, so the ramp the grid made of it
// stays hidden under the steps; under the beaches' stairs & ramps likewise, and the sand round those in front of a wall
// comes down to the beach. Returns GEO.terrain.stairs.
function shoreStairs(dtm, walls, grid, classes, access) {
  const stairs = detectStairs({ dtm, walls, loadLayer, scanRings, skip: access.claimed, log });
  let lowered = 0;
  for (const s of stairs) {
    const [a, b, c, cx, cz] = s.plane;
    scanRings([s.p], grid.x0, grid.z0, grid.res, grid.w, grid.h, (i, j) => {
      const x = grid.x0 + (i + 0.5) * grid.res, z = grid.z0 + (j + 0.5) * grid.res;
      const under = Math.min(s.top, Math.max(s.bot, c + a * (x - cx) + b * (z - cz))) - 0.12;
      const k = j * grid.w + i;
      if (grid.data[k] > under) { grid.data[k] = under; lowered++; }
    });
  }
  const carved = carveTerrain(grid, access, classes, GROUND.beach, GROUND.stairs);
  log(`shore stairs: ${lowered} terrain samples kept under the steps; ${carved} under & round the beaches' stairs & ramps`);
  return stairs.map(({ plane, ...s }) => s);
}

// --- 4e. The port's dredged bed ------------------------------------------------------------------------------------------

// The LiDAR has the harbour's water at 0 m and no isobath reaches inside the moles, so the sea floor's fill leaves both
// basins and the outer harbour at the water's -0.3 m floor (they would dry out below half tide). Inside the marinas (OSM
// ways 157022675, Kirol portua, and 565482772, Donostia) and HARBOUR (the outer harbour, inside the moles) the water's
// floor goes down to HARBOUR_BED, below the lowest spring tides (-2.2 m): at once against a quay wall, over
// HARBOUR_SLOPE from any other shore (the old port's slipway); never above the fill (by the mouth, between the moles'
// heads, it is already deeper), so the bed meets the bay's floor there.
const HARBOUR = [-300, -160, -262, -141, -200, -129, -150, -117, -124, -110, -101, -124, -62, -115, -30, -104, 40, -82, 110, -60,
  140, -52, 165, -40, 165, -285, -300, -285];
const HARBOUR_WAYS = [157022675, 565482772];
const HARBOUR_BED = -3; // m
const HARBOUR_SLOPE = 6; // m from a shore without a wall to the full depth
function harbourBed(grid, kind, walls) {
  const rings = [HARBOUR];
  for (const e of loadLayer('osm_places.json').elements) {
    if (HARBOUR_WAYS.includes(e.id) && e.geometry) rings.push(e.geometry.flatMap((p) => lonLatToLocal(p.lon, p.lat)));
  }
  const index = wallIndex(walls, 16, 4);
  const at = (k) => [grid.x0 + ((k % grid.w) + 0.5) * grid.res, grid.z0 + (Math.floor(k / grid.w) + 0.5) * grid.res];
  // the water, and the cells below sea level in front of a quay wall (mostly land in the 1 m mask: the wall's smear)
  const wet = (k) => kind[k] === WATER.sea || kind[k] === WATER.bed;
  const inside = new Uint8Array(grid.w * grid.h);
  for (const r of rings) {
    scanRings([r], grid.x0, grid.z0, grid.res, grid.w, grid.h, (i, j) => {
      const k = j * grid.w + i;
      if (wet(k)) { inside[k] = 1; return; }
      if (grid.data[k] > -0.05) return;
      const q = nearestWall(walls, ...at(k), 3, index);
      if (q && !q.end && q.d > 0) inside[k] = 1;
    });
  }
  // metres to the nearest cell that is not water (the shore)
  const toShore = chamfer(grid.w, grid.h, grid.res, (k) => !inside[k] && !wet(k) && kind[k] !== WATER.river);
  let n = 0;
  for (let k = 0; k < inside.length; k++) {
    if (!inside[k]) continue;
    // (in front of a wall within reach of the shore: the full depth up to its foot)
    const q = nearestWall(walls, ...at(k), toShore[k] + 2, index);
    const walled = q && !q.end && q.d > 0;
    const f = walled ? 1 : Math.min(1, toShore[k] / HARBOUR_SLOPE);
    const bed = grid.data[k] + (HARBOUR_BED - grid.data[k]) * f;
    if (bed < grid.data[k] - 0.005) { grid.data[k] = bed; n++; }
  }
  log(`harbour: ${n} samples of the basins & the outer harbour (${((n * grid.res * grid.res) / 1e4).toFixed(2)} ha) laid at ` +
    `${HARBOUR_BED} m or deeper`);
}

function writeTerrainPNG(grid, blue, file, text) {
  const px = new Uint8Array(grid.w * grid.h * 3);
  for (let k = 0; k < grid.data.length; k++) {
    const u = Math.max(0, Math.min(65535, Math.round((grid.data[k] + HEIGHT_OFFSET) * 100)));
    px[3 * k] = u >> 8;
    px[3 * k + 1] = u & 255;
    px[3 * k + 2] = blue[k];
  }
  const out = encodePNG(px, grid.w, grid.h, 3, text);
  fs.writeFileSync(file, out);
  log(`${path.relative(ROOT, file)}: ${grid.w}x${grid.h} @ ${grid.res} m, ${(out.length / 1e6).toFixed(2)} MB`);
}

// --- 5. Buildings: municipal 1:500 outlines + b5m measured heights + terrain ------------------------------------------

function bakeBuildings(dtm, districts) {
  const W = CORE.maxX - CORE.minX, H = CORE.maxZ - CORE.minZ;
  const b5m = loadLayer('b5m_buildings.json').features;
  // Rasterise b5m at 1 m: covered structures first so proper buildings win where they overlap
  const ids = new Int32Array(W * H).fill(-1);
  const order = b5m.map((f, idx) => idx).sort((a, b) => (b5m[a].p.type === 'Edificio') - (b5m[b].p.type === 'Edificio'));
  for (const idx of order) scanRings(b5m[idx].g, CORE.minX, CORE.minZ, 1, W, H, (i, j) => { ids[j * W + i] = idx; });

  const oi = CORE.minX - dtm.x0, oj = CORE.minZ - dtm.z0;
  const out = [];
  const sources = [
    ['c500_ERAIKINA.json', 0],
    ['c500_EraikinArinak.json', 1], ['c500_ESTALPEA.json', 1], ['c500_KIOSKOA.json', 1], ['c500_BEROTEGIA.json', 1]
  ];
  // The light-building layers overlap: EraikinArinak repeats almost every ESTALPEA shed, BEROTEGIA greenhouse and
  // KIOSKOA kiosk, and some ERAIKINA outlines, exactly or within a few centimetres. A 1 m raster of the outlines already
  // emitted keeps each structure to one extrusion (two would z-fight).
  const taken = new Uint8Array(W * H);
  const repeats = new Map();
  let estimated = 0;
  for (const [file, kind] of sources) {
    for (const f of loadLayer(file).features) {
      const rings = f.g.filter((r) => r.length >= 6);
      if (!rings.length) continue;
      const b = ringBounds(rings[0]);
      if (b.maxX < CORE.minX || b.minX > CORE.maxX || b.maxZ < CORE.minZ || b.minZ > CORE.maxZ) continue;
      const hist = new Map();
      const ground = [];
      let cells = 0, overlap = 0;
      scanRings(rings, CORE.minX, CORE.minZ, 1, W, H, (i, j) => {
        cells++;
        if (taken[j * W + i]) overlap++;
        const id = ids[j * W + i];
        if (id >= 0) hist.set(id, (hist.get(id) || 0) + 1);
        const v = dtm.data[(oj + j) * dtm.w + oi + i];
        if (!Number.isNaN(v)) ground.push(v);
      });
      // a light building lying (almost) wholly on one already emitted is the same structure drawn again, or a roof
      // structure whose volume the extrusion under it already fills
      if (kind === 1 && cells && overlap >= 0.9 * cells) {
        repeats.set(file, (repeats.get(file) || 0) + 1);
        continue;
      }
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      if (!ground.length) {
        const v = dtm.sample(cx, cz);
        if (!Number.isFinite(v)) continue;
        ground.push(v);
      }
      ground.sort((p, q) => p - q);
      const gMin = ground[0], gMed = ground[ground.length >> 1];

      let covered = 0, sumAvg = 0, dom = -1, domCount = 0;
      for (const [id, count] of hist) {
        const p = b5m[id].p;
        if (count > domCount) { dom = id; domCount = count; }
        if (p.avg == null) continue;
        covered += count;
        sumAvg += count * p.avg;
      }
      const area = Math.abs(ringArea(rings[0])) - rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
      let perimeter = 0;
      for (let k = 0, r = rings[0], n = r.length / 2; k < n; k++) {
        const q = (k + 1) % n;
        perimeter += Math.hypot(r[2 * q] - r[2 * k], r[2 * q + 1] - r[2 * k + 1]);
      }
      const thickness = (2 * area) / Math.max(perimeter, 1e-6);

      let avg, max, est = false;
      if (covered >= 0.3 * Math.max(cells, 1)) {
        avg = sumAvg / covered;
        const dp = b5m[dom].p;
        max = dp.max != null && dp.avg != null ? avg + (dp.max - dp.avg) : avg;
      } else {
        est = true;
        estimated++;
        avg = kind === 1 ? 3 : area < 40 ? 3.5 : 9;
        max = avg;
      }
      // Pitched roofs: a hip roof of rise r over eaves e averages e + r / 3 and peaks at e + r, so r = 1.5 (max - avg).
      // A max far above the average is a neighbouring tower or a tree caught in the footprint, not a roof.
      const lift = max - avg;
      let rise = lift > 12 ? 2.5 : 1.5 * lift;
      rise = Math.min(rise, 0.42 * thickness, 9);
      if (rise < 1.2 || kind === 1) rise = 0;
      const roof = rise === 0 ? 0 : thickness < 10 ? 1 : 2; // 0 flat, 1 pitched, 2 mansard (deep blocks)
      const eave = Math.max(gMed + 2.4, gMed + avg - rise / 3);

      const dist = districts.findIndex((d) => d.rings.some((r) => pointInRing(cx, cz, r)));
      const rec = {
        g: rings.map((r) => r.map(r2)),
        base: r2(gMin - 0.4), ground: r2(gMed), eave: r2(eave), top: r2(eave + rise), roof, kind, district: dist
      };
      if (est) rec.est = 1;
      const dp = dom >= 0 ? b5m[dom].p : null;
      if (dp && dp.name_eu && kind === 0) rec.name = dp.name_eu.replace(/, (etxea|eraikina|taldea)$/, '');
      if (dp && dp.street_eu && dp.number) rec.addr = `${dp.street_eu.replace(/ kalea$/, ' k.')} ${dp.number}${dp.bis || ''}`;
      if (dp && dp.built) rec.built = Number(dp.built.slice(0, 4));
      out.push(rec);
      scanRings(rings, CORE.minX, CORE.minZ, 1, W, H, (i, j) => { taken[j * W + i] = 1; });
    }
  }
  const skipped = [...repeats].map(([file, n]) => `${n} ${file.replace(/^c500_|\.json$/g, '')}`).join(', ');
  log(`buildings: ${out.length} (${estimated} without a b5m height); light buildings already drawn by an earlier ` +
    `layer skipped: ${skipped || 'none'}`);
  return out;
}

function loadDistricts() {
  // Erdialdea comes in two pieces; both keep the same name, so styles can key on it
  return loadLayer('auzoak.json').features.map((f) => ({ name: f.p.IzenAuzo, rings: f.g }));
}

// --- 6. Landmarks & teleports ------------------------------------------------------------------------------------------

// OSM objects that procedural models will replace (the plain extrusions of the buildings under them are hidden then)
const LANDMARKS = [
  ['udaletxea', 'way', 28211466], ['kursaal-auditorium', 'way', 182552763], ['kursaal-kamara', 'way', 27264477],
  ['kursaal', 'way', 182552760], ['artzain-ona', 'way', 28211382], ['santa-maria', 'way', 27263141],
  ['miramar', 'way', 184853018], ['victoria-eugenia', 'way', 28196019], ['hotel-maria-cristina', 'way', 28196020],
  ['mota-gaztelua', 'way', 28156564], ['santa-klara-itsasargia', 'way', 28161366], ['igeldo-itsasargia', 'way', 152623295],
  ['igeldo-torreoia', 'way', 168045920], ['itsas-museoa', 'way', 27263481], ['haizearen-orrazia', 'node', 361066700],
  ['aquariuma', 'node', 259491671], ['ulia-dorrea', 'way', 417178149],
  // round 2 (queries/landmarks.overpassql)
  ['bretxa', 'way', 23905020], ['bretxa-merkatua', 'way', 23905055], ['bretxa-plaza', 'way', 119089295],
  ['boulevard-kioskoa', 'way', 184003729], ['tenis-kluba', 'way', 182691330], ['tenis-pistak', 'way', 39244628],
  ['tabakalera', 'relation', 3266749], ['atotxa-dorrea', 'way', 172593495],
  ['anoeta', 'way', 1426500083], ['illunbe', 'way', 26973607],
  // round 4 (queries/places.overpassql): Aiete's palace and the Kulturetxea's sunken pavilion in its park
  ['aiete-jauregia', 'way', 56132590], ['aiete-kulturetxea', 'way', 224241887]
];

// Each landmark's OSM object, looked up before anything is baked: one missing from the snapshot (a query edited without
// re-fetching, or the object deleted or split upstream) fails the bake instead of silently dropping its model and
// bringing the plain extrusion back
function landmarkObjects() {
  const osm = [...loadLayer('osm_places.json').elements, ...loadLayer('osm_landmarks.json').elements];
  const byKey = new Map(osm.map((e) => [`${e.type}/${e.id}`, e]));
  const found = [], missing = [];
  for (const [id, type, osmId] of LANDMARKS) {
    const e = byKey.get(`${type}/${osmId}`);
    const ring = e && type !== 'node' ? osmPolygons(e)[0]?.[0] : null;
    if (!e) missing.push(`${id}: OSM ${type}/${osmId} is missing`);
    else if (type !== 'node' && !ring) missing.push(`${id}: OSM ${type}/${osmId} has no closed outline`);
    else found.push({ id, type, osmId, e, ring });
  }
  if (missing.length) {
    throw new Error(`landmarks not in tools/donostia/data/osm_*.json (re-fetch with fetch.sh --refresh-osm, or update ` +
      `LANDMARKS):\n  ${missing.join('\n  ')}`);
  }
  return found;
}

function bakeLandmarks(objects, buildings) {
  const sites = [];
  // 1 m mask of each landmark footprint; a 1:500 building belongs to the landmark when half its area lies inside, or
  // when it covers half the footprint (the municipal map draws the whole Kursaal as one outline, OSM as three)
  const W = CORE.maxX - CORE.minX, H = CORE.maxZ - CORE.minZ;
  const mask = new Int16Array(W * H).fill(-1);
  const inside = (ring, siteIdx) => {
    const members = [];
    let m = 0;
    scanRings([ring], CORE.minX, CORE.minZ, 1, W, H, (i, j) => { mask[j * W + i] = siteIdx; m++; });
    buildings.forEach((bd, idx) => {
      let n = 0, hit = 0;
      scanRings(bd.g, CORE.minX, CORE.minZ, 1, W, H, (i, j) => { n++; if (mask[j * W + i] === siteIdx) hit++; });
      // (m is 0 for a footprint outside the core: no building can belong to it then)
      if (n && m && (hit >= 0.5 * n || hit >= 0.5 * m)) members.push(idx);
    });
    return members;
  };
  for (const { id, type, osmId, e, ring } of objects) {
    const t = e.tags || {};
    const site = { id, name: t.name, name_es: t['name:es'] || null, osm: `${type}/${osmId}` };
    if (type === 'node') {
      site.at = lonLatToLocal(e.lon, e.lat);
    } else {
      site.footprint = ring.map(r2);
      const b = ringBounds(ring);
      site.at = [r2((b.minX + b.maxX) / 2), r2((b.minZ + b.maxZ) / 2)];
      site.buildings = inside(ring, sites.length);
      if (t.height) site.height = Number.parseFloat(t.height);
    }
    sites.push(site);
  }
  return sites;
}

// Camera stations for the god-mode camera: [id, Basque name, Spanish name, camera lon/lat, metres above ground,
// look-at lon/lat, look-at metres above ground]
const TELEPORTS = [
  ['igeldo', 'Igeldo mendia', 'Monte Igueldo', [-2.0079, 43.3207], 30, [-1.9845, 43.3175], 0],
  ['urgull', 'Urgull', 'Monte Urgull', [-1.98942, 43.32485], 25, [-1.9830, 43.3140], 0],
  ['kontxa', 'Kontxa pasealekua', 'Paseo de La Concha', [-1.9905, 43.3152], 6, [-1.99948, 43.32139], 12],
  ['udaletxea', 'Alderdi Eder', 'Alderdi Eder', [-1.9876, 43.3207], 10, [-1.98578, 43.32160], 12],
  ['alde-zaharra', 'Konstituzio plaza', 'Plaza de la Constitución', [-1.985080, 43.323413], 1.7, [-1.98470, 43.32380], 6],
  ['kursaal', 'Kursaal eta Zurriola', 'Kursaal y Zurriola', [-1.9792, 43.3225], 8, [-1.97836, 43.32448], 10],
  ['artzain-ona', 'Artzain Onaren katedrala', 'Catedral del Buen Pastor', [-1.98169, 43.31790], 2, [-1.98169, 43.31689], 30],
  ['orrazia', 'Haizearen orrazia', 'Peine del Viento', [-2.00470, 43.32110], 5, [-2.00555, 43.32169], 3],
  ['miramar', 'Miramar jauregia', 'Palacio de Miramar', [-1.9958, 43.3152], 6, [-1.99831, 43.31464], 10],
  ['santa-klara', 'Santa Klara', 'Isla de Santa Clara', [-1.9925, 43.3192], 40, [-1.99948, 43.32139], 10],
  ['sagues', 'Sagues', 'Sagüés', [-1.9708, 43.3270], 6, [-1.9770, 43.3258], 2],
  ['dabadaba', 'Dabadaba', 'Sala Dabadaba', [-1.975780, 43.315545], 1.7, [-1.976278, 43.315608], 3],
  ['aiete', 'Aieteko jauregia', 'Palacio de Aiete', [-1.991674, 43.306152], 6, [-1.992012, 43.305579], 9],
  ['anoeta', 'Anoeta', 'Estadio de Anoeta', [-1.9762, 43.3036], 40, [-1.97357, 43.30139], 12]
];

function bakeTeleports(heightAt) {
  return TELEPORTS.map(([id, name, name_es, from, eye, to, look]) => {
    const [fx, fz] = lonLatToLocal(...from), [tx, tz] = lonLatToLocal(...to);
    return {
      id, name, name_es,
      from: [r2(fx), r2(Math.max(0, heightAt(fx, fz)) + eye), r2(fz)],
      to: [r2(tx), r2(Math.max(0, heightAt(tx, tz)) + look), r2(tz)]
    };
  });
}

// --- 7. Previews -------------------------------------------------------------------------------------------------------

function hillshade(grid, wet, file) {
  const { w, h } = grid;
  const px = new Uint8Array(w * h * 3);
  const g = (i, j) => grid.get(Math.min(w - 1, i), Math.min(h - 1, j));
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const v = g(i, j), k = 3 * (j * w + i);
    const dx = (g(i + 1, j) - v) / grid.res, dz = (g(i, j + 1) - v) / grid.res;
    const shade = Math.max(0, Math.min(1, 0.6 - 0.9 * dx - 0.9 * dz));
    const water = wet[j * w + i] / 255;
    const depth = Math.max(0, Math.min(1, -v / 30));
    px[k] = 255 * (shade * (1 - water) * 0.9 + water * (0.15 - 0.1 * depth));
    px[k + 1] = 255 * (shade * (1 - water) * 0.88 + water * (0.45 - 0.25 * depth));
    px[k + 2] = 255 * (shade * (1 - water) * 0.75 + water * (0.6 - 0.2 * depth));
  }
  fs.writeFileSync(file, encodePNG(px, w, h, 3));
}

// Swell exposure in red, river in green over the water (land grey)
function waterPreview(ctx, fields, file) {
  const { w, h } = ctx.grid;
  const px = new Uint8Array(w * h * 3);
  for (let k = 0; k < w * h; k++) {
    if (ctx.wet[k] > 127) {
      px[3 * k] = 255 * fields.exposure[k];
      px[3 * k + 1] = 255 * fields.river[k];
      px[3 * k + 2] = 90;
    } else px.fill(60, 3 * k, 3 * k + 3);
  }
  fs.writeFileSync(file, encodePNG(px, w, h, 3));
}

function buildingPreview(buildings, file) {
  const res = 1, w = (CORE.maxX - CORE.minX) / res, h = (CORE.maxZ - CORE.minZ) / res;
  const px = new Uint8Array(w * h * 3).fill(24);
  for (const b of buildings) {
    const hgt = b.top - b.ground;
    const t = Math.max(0, Math.min(1, hgt / 60));
    const col = b.est ? [200, 60, 60] : [60 + 195 * t, 90 + 140 * t, 140 - 60 * t];
    if (b.roof === 2) col[2] = 255;
    scanRings(b.g, CORE.minX, CORE.minZ, res, w, h, (i, j) => { px.set(col, 3 * (j * w + i)); });
  }
  fs.writeFileSync(file, encodePNG(px, w, h, 3));
}

// --- main --------------------------------------------------------------------------------------------------------------

const landmarkObjs = landmarkObjects();
const dtm = mosaicDTM();
lap('DTM mosaic 1 m');
const water = waterMask(dtm);
lap('water mask');
const floor = bathymetry(dtm, water);
lap('sea floor');
const core = terrainGrid(dtm, water, floor, CORE, CORE_RES);
const context = terrainGrid(dtm, water, floor, CONTEXT, CONTEXT_RES);
lap('terrain grids');
fs.mkdirSync(OUT_DATA, { recursive: true });
const coreClasses = groundClasses(core.grid, core.wet);
lap('ground classes');
const { walls, access } = shoreWalls(dtm, core.grid, coreClasses);
const stairs = shoreStairs(dtm, walls, core.grid, coreClasses, access);
harbourBed(core.grid, core.kind, walls);
// heights: LiDAR & isobaths, water from OSM; the core's classes from the municipal map
writeTerrainPNG(core.grid, coreClasses, path.join(OUT_DATA, 'terrain-core.png'), pngText('geoeuskadi', 'c500', 'osm'));
writeTerrainPNG(context.grid, context.wet.map((w) => (w > 127 ? GROUND.water : GROUND.natural)),
  path.join(OUT_DATA, 'terrain-context.png'), pngText('geoeuskadi', 'osm'));
const fields = waterFields(context, path.join(OUT_DATA, 'water.png'));
lap('water fields');

const heightAt = (x, z) => {
  const inside = x > CORE.minX && x < CORE.maxX && z > CORE.minZ && z < CORE.maxZ;
  const v = (inside ? core.grid : context.grid).sample(x, z);
  return Number.isFinite(v) ? v : 0;
};
const districts = loadDistricts();
const buildings = bakeBuildings(dtm, districts);
lap('buildings');
const landmarks = bakeLandmarks(landmarkObjs, buildings);
const teleports = bakeTeleports(heightAt);

const terrainMeta = (g, file) => ({ url: `data/donostia/${file}`, x0: g.x0, z0: g.z0, w: g.w, h: g.h, res: g.res });
const GEO = {
  frame: { crs: FRAME.crs, origin: FRAME.origin, core: CORE, context: CONTEXT },
  terrain: {
    heightOffset: HEIGHT_OFFSET, classes: GROUND,
    core: terrainMeta(core.grid, 'terrain-core.png'), context: terrainMeta(context.grid, 'terrain-context.png'),
    walls, stairs
  },
  districts: districts.map((d) => d.name),
  buildings, landmarks, teleports,
  attribution: [
    'b5m — Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa (CC BY 4.0)',
    'Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi (CC BY 4.0)',
    'Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0)',
    '© OpenStreetMap contributors (ODbL)'
  ]
};
fs.mkdirSync(path.dirname(OUT_JS), { recursive: true });
const js = `// js/donostia/geodata.js — generated by tools/donostia/build.mjs; do not edit.\n` +
  `// ${GEO.attribution.join(' · ')}\n` +
  licenceComment('c500', 'osm', 'b5m', 'geoeuskadi') +
  `export const GEO = ${JSON.stringify(GEO)};\n`;
fs.writeFileSync(OUT_JS, js);
log(`${path.relative(ROOT, OUT_JS)}: ${(js.length / 1e6).toFixed(2)} MB, ${buildings.length} buildings, ${landmarks.length} landmarks, ${teleports.length} teleports`);
const accessJs = `// js/donostia/data-beach-access.js — generated by tools/donostia/build.mjs (tools/donostia/beach-access.mjs); do not edit.\n` +
  `// Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0) · Eusko Jaurlaritza / ` +
  `Gobierno Vasco. geoEuskadi (LiDAR, CC BY 4.0; orthophoto 2025) · © OpenStreetMap contributors (ODbL)\n` +
  licenceComment('c500', 'geoeuskadi', 'osm') +
  `export const BEACH_ACCESS = ${JSON.stringify(access.data)};\n`;
fs.writeFileSync(OUT_ACCESS, accessJs);
log(`${path.relative(ROOT, OUT_ACCESS)}: ${(accessJs.length / 1e3).toFixed(1)} kB`);

if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  hillshade(core.grid, core.wet, path.join(PREVIEW, 'core-hillshade.png'));
  hillshade(context.grid, context.wet, path.join(PREVIEW, 'context-hillshade.png'));
  buildingPreview(buildings, path.join(PREVIEW, 'buildings.png'));
  waterPreview(context, fields, path.join(PREVIEW, 'water-fields.png'));
  log(`previews in ${PREVIEW}`);
}
lap('done');
