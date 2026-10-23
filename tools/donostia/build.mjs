// tools/donostia/build.mjs
// usage: node --max-old-space-size=8192 tools/donostia/build.mjs [--preview <dir>]
// Bakes the Donostia runtime data from tools/donostia/raw (fetch.sh) and tools/donostia/data (extract.py):
//   data/donostia/terrain-core.png     2 m heights over the core extent (R/G = 16-bit cm above -100 m, B = water 0..255)
//   data/donostia/terrain-context.png  8 m heights over the whole terrain-tile union (horizon hills & sea floor)
//   js/donostia/geodata.js             frame, terrain metadata, buildings, landmark sites & teleports
// --preview writes debug images (hillshade, building heights) into the given folder.

import fs from 'node:fs';
import path from 'node:path';
import {
  HERE, RAW, FRAME, Grid, readAscGrid, encodePNG, encodeHeightPNG, HEIGHT_OFFSET, scanRings, ringArea, ringBounds,
  pointInRing, lonLatToLocal, loadLayer, log
} from './lib.mjs';

const ROOT = path.join(HERE, '..', '..');
const OUT_DATA = path.join(ROOT, 'data', 'donostia');
const OUT_JS = path.join(ROOT, 'js', 'donostia', 'geodata.js');
const previewIdx = process.argv.indexOf('--preview');
const PREVIEW = previewIdx > 0 ? process.argv[previewIdx + 1] : null;
const t0 = performance.now();
const lap = (label) => log(`${label} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);

const CORE = FRAME.core;
// The context grid spans the terrain-tile union on an 8 m lattice that the core rectangle snaps to
const CONTEXT = { minX: -6056, maxX: 4216, minZ: -3744, maxZ: 3376 };
const CORE_RES = 2, CONTEXT_RES = 8, BATHY_RES = 4;
const r2 = (v) => Math.round(v * 100) / 100;

// --- 1. 1 m DTM mosaic -------------------------------------------------------------------------------------------------

function mosaicDTM() {
  const dir = path.join(RAW, 'dtm');
  const tiles = fs.readdirSync(dir).filter((f) => f.endsWith('.asc')).sort().map((f) => readAscGrid(path.join(dir, f)));
  const grid = Grid.over(CONTEXT, 1);
  for (const t of tiles) {
    const di = Math.round(t.x0 - grid.x0), dj = Math.round(t.z0 - grid.z0);
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

function waterMask(dtm) {
  const { w, h, data } = dtm;
  const water = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const open = (k) => water[k] === 0 && (data[k] === 0 || Number.isNaN(data[k]));
  for (let i = 0; i < w; i++) if (open(i)) { water[i] = 1; stack[top++] = i; }
  while (top) {
    const k = stack[--top], i = k % w;
    const next = [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w];
    for (const n of next) {
      if (n >= 0 && n < w * h && open(n)) { water[n] = 1; stack[top++] = n; }
    }
  }
  // Rivers, ponds & docks mapped in OSM (the Urumea surface is not always exactly 0 in the terrain)
  const osm = loadLayer('osm_places.json').elements;
  for (const e of osm) {
    const t = e.tags || {};
    const isWater = t.natural === 'water' || t.waterway === 'riverbank' || t.water;
    if (!isWater || t.leisure === 'swimming_pool') continue;
    for (const rings of osmPolygons(e)) scanRings(rings, dtm.x0, dtm.z0, 1, w, h, (i, j) => { water[j * w + i] = 2; });
  }
  return water;
}

// OSM way / multipolygon relation -> [[outer, ...holes], ...] local flat rings (good enough for rasterising)
function osmPolygons(e) {
  const ring = (geom) => geom.flatMap((p) => lonLatToLocal(p.lon, p.lat));
  if (e.type === 'way' && e.geometry && e.geometry.length >= 4) return [[ring(e.geometry)]];
  if (e.type === 'relation' && e.members) {
    const rings = e.members.filter((m) => m.geometry && m.geometry.length >= 4).map((m) => ring(m.geometry));
    return rings.length ? [rings] : [];
  }
  return [];
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
          if (water[k]) sea++;
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
// the sea floor (never above -0.3 m, rivers -1.5 m), cells without any data are filled from their neighbours.
function terrainGrid(dtm, water, floor, ext, res) {
  const grid = Grid.over(ext, res);
  const wet = new Uint8Array(grid.w * grid.h);
  const oi = Math.round(ext.minX - dtm.x0), oj = Math.round(ext.minZ - dtm.z0);
  for (let j = 0; j < grid.h; j++) {
    for (let i = 0; i < grid.w; i++) {
      let sum = 0, n = 0, sea = 0, river = 0;
      for (let b = 0; b < res; b++) {
        for (let a = 0; a < res; a++) {
          const k = (oj + j * res + b) * dtm.w + oi + i * res + a;
          if (water[k] === 1) sea++;
          else if (water[k] === 2) river++;
          else if (!Number.isNaN(dtm.data[k])) { sum += dtm.data[k]; n++; }
        }
      }
      const cell = res * res, k = j * grid.w + i;
      wet[k] = Math.round((255 * (sea + river)) / cell);
      if (sea + river > n) {
        const x = ext.minX + (i + 0.5) * res, z = ext.minZ + (j + 0.5) * res;
        const f = floor.sample(x, z);
        grid.data[k] = river > sea ? Math.min(-1.5, Number.isFinite(f) ? f : -1.5) : Math.min(-0.3, Number.isFinite(f) ? f : -5);
      } else if (n) grid.data[k] = sum / n;
    }
  }
  // Holes (outside the downloaded tiles but not sea): grow the known heights inwards
  for (let pass = 0; pass < 4096; pass++) {
    let holes = 0;
    const next = grid.data.slice();
    for (let j = 0; j < grid.h; j++) for (let i = 0; i < grid.w; i++) {
      const k = j * grid.w + i;
      if (!Number.isNaN(grid.data[k])) continue;
      let sum = 0, n = 0;
      for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= grid.w || jj >= grid.h) continue;
        const v = grid.data[jj * grid.w + ii];
        if (!Number.isNaN(v)) { sum += v; n++; }
      }
      if (n) next[k] = sum / n;
      else holes++;
    }
    grid.data = next;
    if (!holes) break;
  }
  return { grid, wet };
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

function writeTerrainPNG(grid, blue, file) {
  const px = new Uint8Array(grid.w * grid.h * 3);
  for (let k = 0; k < grid.data.length; k++) {
    const u = Math.max(0, Math.min(65535, Math.round((grid.data[k] + HEIGHT_OFFSET) * 100)));
    px[3 * k] = u >> 8;
    px[3 * k + 1] = u & 255;
    px[3 * k + 2] = blue[k];
  }
  const out = encodePNG(px, grid.w, grid.h, 3);
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
  let estimated = 0;
  for (const [file, kind] of sources) {
    for (const f of loadLayer(file).features) {
      const rings = f.g.filter((r) => r.length >= 6);
      if (!rings.length) continue;
      const b = ringBounds(rings[0]);
      if (b.maxX < CORE.minX || b.minX > CORE.maxX || b.maxZ < CORE.minZ || b.minZ > CORE.maxZ) continue;
      const hist = new Map();
      const ground = [];
      let cells = 0;
      scanRings(rings, CORE.minX, CORE.minZ, 1, W, H, (i, j) => {
        cells++;
        const id = ids[j * W + i];
        if (id >= 0) hist.set(id, (hist.get(id) || 0) + 1);
        const v = dtm.data[(oj + j) * dtm.w + oi + i];
        if (!Number.isNaN(v)) ground.push(v);
      });
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
    }
  }
  log(`buildings: ${out.length} (${estimated} without a b5m height)`);
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
  ['aquariuma', 'node', 259491671], ['ulia-dorrea', 'way', 417178149]
];

function bakeLandmarks(buildings) {
  const osm = loadLayer('osm_places.json').elements;
  const byKey = new Map(osm.map((e) => [`${e.type}/${e.id}`, e]));
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
      if (n && (hit >= 0.5 * n || hit >= 0.5 * m)) members.push(idx);
    });
    return members;
  };
  for (const [id, type, osmId] of LANDMARKS) {
    const e = byKey.get(`${type}/${osmId}`);
    if (!e) { log(`landmark ${id}: OSM ${type}/${osmId} missing`); continue; }
    const t = e.tags || {};
    const site = { id, name: t.name, name_es: t['name:es'] || null, osm: `${type}/${osmId}` };
    if (type === 'node') {
      site.at = lonLatToLocal(e.lon, e.lat);
    } else {
      const ring = osmPolygons(e)[0][0];
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
  ['alde-zaharra', 'Konstituzio plaza', 'Plaza de la Constitución', [-1.98540, 43.32340], 1.7, [-1.98470, 43.32380], 6],
  ['kursaal', 'Kursaal eta Zurriola', 'Kursaal y Zurriola', [-1.9792, 43.3225], 8, [-1.97836, 43.32448], 10],
  ['artzain-ona', 'Artzain Onaren katedrala', 'Catedral del Buen Pastor', [-1.98169, 43.31790], 2, [-1.98169, 43.31689], 30],
  ['orrazia', 'Haizearen orrazia', 'Peine del Viento', [-2.00470, 43.32110], 5, [-2.00555, 43.32169], 3],
  ['miramar', 'Miramar jauregia', 'Palacio de Miramar', [-1.9958, 43.3152], 6, [-1.99831, 43.31464], 10],
  ['santa-klara', 'Santa Klara', 'Isla de Santa Clara', [-1.9925, 43.3192], 40, [-1.99948, 43.32139], 10],
  ['sagues', 'Sagues', 'Sagüés', [-1.9708, 43.3270], 6, [-1.9770, 43.3258], 2]
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
writeTerrainPNG(core.grid, coreClasses, path.join(OUT_DATA, 'terrain-core.png'));
writeTerrainPNG(context.grid, context.wet.map((w) => (w > 127 ? GROUND.water : GROUND.natural)), path.join(OUT_DATA, 'terrain-context.png'));

const heightAt = (x, z) => {
  const inside = x > CORE.minX && x < CORE.maxX && z > CORE.minZ && z < CORE.maxZ;
  const v = (inside ? core.grid : context.grid).sample(x, z);
  return Number.isFinite(v) ? v : 0;
};
const districts = loadDistricts();
const buildings = bakeBuildings(dtm, districts);
lap('buildings');
const landmarks = bakeLandmarks(buildings);
const teleports = bakeTeleports(heightAt);

const terrainMeta = (g, file) => ({ url: `data/donostia/${file}`, x0: g.x0, z0: g.z0, w: g.w, h: g.h, res: g.res });
const GEO = {
  frame: { crs: FRAME.crs, origin: FRAME.origin, core: CORE, context: CONTEXT },
  terrain: {
    heightOffset: HEIGHT_OFFSET, classes: GROUND,
    core: terrainMeta(core.grid, 'terrain-core.png'), context: terrainMeta(context.grid, 'terrain-context.png')
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
  `export const GEO = ${JSON.stringify(GEO)};\n`;
fs.writeFileSync(OUT_JS, js);
log(`${path.relative(ROOT, OUT_JS)}: ${(js.length / 1e6).toFixed(2)} MB, ${buildings.length} buildings, ${landmarks.length} landmarks, ${teleports.length} teleports`);

if (PREVIEW) {
  hillshade(core.grid, core.wet, path.join(PREVIEW, 'core-hillshade.png'));
  hillshade(context.grid, context.wet, path.join(PREVIEW, 'context-hillshade.png'));
  buildingPreview(buildings, path.join(PREVIEW, 'buildings.png'));
  log(`previews in ${PREVIEW}`);
}
lap('done');
