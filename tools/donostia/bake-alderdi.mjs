// tools/donostia/bake-alderdi.mjs
// usage: node tools/donostia/bake-alderdi.mjs [--preview <dir>]
// The gardens of Alderdi Eder for js/donostia/landmarks/alderdi-eder.js, baked into js/donostia/data-alderdi.js so the
// browser never reads the municipal layers:
//   - from the municipal 1:500 map (Donostiako Udala, CC BY-SA 3.0): the garden zones (LORATEGI_EREMUA) and parterres
//     (PARTERREA), sorted into lawns (the outer garden zones), flower beds (zones nested inside another: the seasonal
//     planting at the heart of each parterre, the round bed under the palm), the red gravel edging strips between
//     them (the parterres' 0.5 m rings) and the seasonal flower clumps (SASOIKO_LORATEGIA); the clipped hedges
//     (LANDARE_HESIA); the low cast-iron fence along every lawn edge that meets a path (scrolled panels round the
//     parterres, hoops in the garden by Hernani street); the carousel's disc and the playground's patch, both left as
//     holes in the pedestrian zone;
//   - placed from that layout (OpenStreetMap maps none in the gardens): white benches backing onto the lawns along
//     the paths, white garden lamps at the parterres' corners, the cast-iron planters round the central round bed.
//     OSM's own benches and street lamps (js/donostia/streetscape.js draws them) are kept clear of;
//   - OpenStreetMap (ODbL): the playground's swings; the City Hall's front terrace (its paving where the 1:500 map
//     has none) and the low sandstone walls along its edge; the timber deck of La Terraza del Náutico on the harbour
//     side and the ikurriña's flagpole there.
// Inputs are all committed (tools/donostia/data); the output is share-alike like the rest of the derived data.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, loadLayer, lonLatToLocal, ringArea, pointInRing, encodePNG, previewDir, licenceComment, log } from './lib.mjs';

const ROOT = path.join(HERE, '..', '..');
const OUT = path.join(ROOT, 'js', 'donostia', 'data-alderdi.js');
const PREVIEW = previewDir();
const r2 = (v) => Math.round(v * 100) / 100;

// Alderdi Eder between the City Hall's front terrace, the bike lane along Hernani & Andia streets and La Concha's
// promenade railing (local metres, traced on the 1:500 map)
const AREA = [198, 28, 292, -22, 302, -14, 334, 50, 376, 134, 380, 141, 322, 177, 303, 178, 296, 130, 276, 88, 204, 46];
// centre of the round bed (the palm's) at the heart of the parterres, and the axis of the garden grid (the City Hall's
// front, js/donostia/landmarks/udaletxea.js FRONT_DIR)
const CENTRE = [299.4, 81.9];
const AXIS = [-0.885, 0.465];

// --- geometry ----------------------------------------------------------------------------------------------------------

const perimeter = (r) => {
  let p = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) p += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]);
  return p;
};
const centroid = (r) => {
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
};
const bounds = (r) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (let k = 0; k < r.length; k += 2) {
    b[0] = Math.min(b[0], r[k]); b[1] = Math.min(b[1], r[k + 1]); b[2] = Math.max(b[2], r[k]); b[3] = Math.max(b[3], r[k + 1]);
  }
  return b;
};
function distToSegments(x, z, r, closed = true) {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}
// Drops a closing vertex repeating the first and near-duplicate neighbours
function clean(r) {
  const out = [];
  for (let k = 0; k < r.length; k += 2) {
    const n = out.length;
    if (n && Math.hypot(r[k] - out[n - 2], r[k + 1] - out[n - 1]) < 0.03) continue;
    out.push(r[k], r[k + 1]);
  }
  while (out.length > 6 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 0.03) out.length -= 2;
  return out;
}

// A polygon: { outer, holes, area, kind } with point-in tests honouring the holes
function polygon(outer, holes = []) {
  const area = Math.abs(ringArea(outer)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0);
  const per = perimeter(outer) + holes.reduce((s, h) => s + perimeter(h), 0);
  const b = bounds(outer);
  return {
    outer, holes, area, per, b, gross: Math.abs(ringArea(outer)),
    thick: area / Math.max(per / 2, 1e-6), // the width of a strip
    has(x, z) {
      if (x < b[0] || x > b[2] || z < b[1] || z > b[3] || !pointInRing(x, z, outer)) return false;
      return !holes.some((h) => pointInRing(x, z, h));
    },
    // a point well inside: the centroid when it is, else the best of a grid over the bounds
    inner() {
      const c = centroid(outer);
      if (this.has(c[0], c[1]) && distToSegments(c[0], c[1], outer) > 0.1) return c;
      let best = null, bd = -1;
      for (let i = 1; i < 24; i++) for (let j = 1; j < 24; j++) {
        const x = b[0] + ((b[2] - b[0]) * i) / 24, z = b[1] + ((b[3] - b[1]) * j) / 24;
        if (!this.has(x, z)) continue;
        const d = Math.min(distToSegments(x, z, outer), ...holes.map((h) => distToSegments(x, z, h)));
        if (d > bd) { bd = d; best = [x, z]; }
      }
      return best || c;
    }
  };
}

// The polygons of a municipal feature: rings nested in an odd number of the feature's other rings are holes, each
// going to the smallest outer ring around it
function featurePolygons(g) {
  const rings = g.map(clean).filter((r) => r.length >= 6);
  const inside = (r, o) => {
    const [x, z] = centroid(r);
    if (pointInRing(x, z, o)) return true;
    let hits = 0;
    for (let k = 0; k < r.length; k += 2) if (pointInRing(r[k], r[k + 1], o)) hits++;
    return hits > r.length / 4;
  };
  const depth = rings.map((r, i) => rings.filter((o, j) => j !== i && Math.abs(ringArea(o)) > Math.abs(ringArea(r)) && inside(r, o)).length);
  const outers = rings.filter((r, i) => depth[i] % 2 === 0);
  const polys = outers.map((o) => ({ o, holes: [] }));
  rings.forEach((r, i) => {
    if (depth[i] % 2 === 0) return;
    let host = null;
    for (const p of polys) if (inside(r, p.o) && (!host || Math.abs(ringArea(p.o)) < Math.abs(ringArea(host.o)))) host = p;
    if (host) host.holes.push(r);
  });
  return polys.map((p) => polygon(p.o, p.holes));
}

const inArea = (p) => { const c = p.inner(); return pointInRing(c[0], c[1], AREA); };
const layerPolys = (file) => loadLayer(file).features.flatMap((f) => featurePolygons(f.g)).filter(inArea);
const near = (file, pad = 40) => {
  const b = bounds(AREA);
  return loadLayer(file).features.flatMap((f) => featurePolygons(f.g))
    .filter((p) => p.b[2] > b[0] - pad && p.b[0] < b[2] + pad && p.b[3] > b[1] - pad && p.b[1] < b[3] + pad);
};

// --- sources -----------------------------------------------------------------------------------------------------------

const zones = layerPolys('c500_LORATEGI_EREMUA.json').map((p) => Object.assign(p, { src: 'zone' }));
const parterres = layerPolys('c500_PARTERREA.json').map((p) => Object.assign(p, { src: 'parterre' }));
const seasonal = layerPolys('c500_SASOIKO_LORATEGIA.json');
const hedges = layerPolys('c500_LANDARE_HESIA.json');
const pits = near('c500_ZUHAITZ_TXORKOA.json');
const stairs = near('c500_ESKAILERA.json');
const blocks = [...near('c500_ERAIKINA.json'), ...near('c500_EraikinArinak.json'), ...near('c500_KIOSKOA.json')];
const roads = [...near('c500_ERREPIDEA.json'), ...near('c500_BIDEGORRIA.json')];
const pedestrian = near('c500_OINEZKOEN_ZONA.json', 80);
const furniture = loadLayer('osm_furniture.json').elements;
const places = loadLayer('osm_places.json').elements;
const osmPoints = (test) => furniture.filter((e) => e.type === 'node' && test(e.tags || {})).map((e) => lonLatToLocal(e.lon, e.lat));
const osmBenches = osmPoints((t) => t.amenity === 'bench');
const osmLamps = osmPoints((t) => t.highway === 'street_lamp');
const pitCentres = pits.map((p) => p.inner());

// --- lawns, beds & edging ----------------------------------------------------------------------------------------------

// A garden polygon nested in another (its inner point inside the other's outline, the other larger) is planted
// inside a lawn: a flower bed, or the thin parterre ring of red gravel between them
const gardens = [...zones, ...parterres];
for (const p of gardens) {
  const [x, z] = p.inner();
  p.nested = gardens.some((q) => q !== p && q.gross > p.gross * 1.02 && pointInRing(x, z, q.outer));
  p.kind = p.thick < 0.8 ? 'edging' : p.nested ? 'bed' : 'lawn';
}
// coincident duplicates (a zone redrawn as a parterre): the first wins
const kept = [];
for (const p of gardens) {
  const c = p.inner();
  if (kept.some((q) => q.kind === p.kind && Math.abs(q.area - p.area) < 0.05 * p.area && q.has(c[0], c[1]))) continue;
  kept.push(p);
}
const lawns = kept.filter((p) => p.kind === 'lawn');
const beds = kept.filter((p) => p.kind === 'bed');
const edging = kept.filter((p) => p.kind === 'edging');

// --- fences ------------------------------------------------------------------------------------------------------------

// Along each lawn ring (outline and the holes no other garden fills), the stretches whose outer side is a path: no
// building, stairs, hedge or other planting there. The fence stands FENCE_IN inside the lawn.
const FENCE_IN = 0.18;
const planted = [...kept, ...seasonal, ...hedges];
const notPath = (x, z) => blocks.some((p) => p.has(x, z)) || stairs.some((p) => p.has(x, z)) || planted.some((p) => p.has(x, z)) ||
  !pointInRing(x, z, AREA);
const fences = [], hoops = [];
// the garden by Hernani street, south-east of the parterres' grid, has the low hoop fence of the photographs
const hoopGarden = (x, z) => z > 98 && x > 300 && x + 0.6 * z > 375;
for (const lawn of lawns) {
  const out = hoopGarden(...lawn.inner()) ? hoops : fences;
  const rings = [lawn.outer, ...lawn.holes.filter((h) => {
    const c = polygon(h).inner();
    return !planted.some((q) => q !== lawn && q.has(c[0], c[1]));
  })];
  for (const ring of rings) {
    const n = ring.length / 2;
    let run = [];
    const flush = () => {
      if (run.length >= 4) {
        let len = 0;
        for (let k = 2; k < run.length; k += 2) len += Math.hypot(run[k] - run[k - 2], run[k + 1] - run[k - 1]);
        if (len > 1.2) out.push(run.map(r2));
      }
      run = [];
    };
    // walk the ring in 0.4 m steps, testing each step's midpoint
    const pts = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      const nx = -(bz - az) / len, nz = (bx - ax) / len;
      const steps = Math.max(1, Math.round(len / 0.4));
      for (let s = 0; s < steps; s++) {
        const t0 = s / steps, t1 = (s + 1) / steps, tm = (t0 + t1) / 2;
        const mx = ax + (bx - ax) * tm, mz = az + (bz - az) * tm;
        // the lawn's side
        const side = lawn.has(mx + nx * 0.3, mz + nz * 0.3) ? 1 : lawn.has(mx - nx * 0.3, mz - nz * 0.3) ? -1 : 0;
        const ok = side !== 0 && !notPath(mx - side * nx * 0.7, mz - side * nz * 0.7);
        pts.push({ ok, x0: ax + (bx - ax) * t0 + side * nx * FENCE_IN, z0: az + (bz - az) * t0 + side * nz * FENCE_IN,
          x1: ax + (bx - ax) * t1 + side * nx * FENCE_IN, z1: az + (bz - az) * t1 + side * nz * FENCE_IN, corner: s === steps - 1 });
      }
    }
    // start the walk at a gap, so a fence running round the whole ring comes out as one closed polyline
    let start = pts.findIndex((p) => !p.ok);
    const closedLoop = start < 0;
    if (closedLoop) start = 0;
    for (let k = 0; k < pts.length; k++) {
      const p = pts[(start + k) % pts.length];
      if (!p.ok) { flush(); continue; }
      if (!run.length) run.push(p.x0, p.z0);
      // keep the step's end at corners (a vertex of the ring) and drop it on straight runs
      if (p.corner || k === pts.length - 1) run.push(p.x1, p.z1);
    }
    if (closedLoop && run.length >= 4) run.push(run[0], run[1]);
    flush();
  }
}

// The garden by Hernani street walks on red gravel between its lawns (the photographs): the convex hull of its lawns
// and hedges grown by 0.4 m, the lawns cut out of it
function convexHull(points) {
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of pts) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (const p of pts.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const gravel = (() => {
  const inside = [...lawns, ...hedges].filter((p) => hoopGarden(...p.inner()));
  if (!inside.length) return null;
  const pts = [];
  for (const p of inside) for (let k = 0; k < p.outer.length; k += 2) {
    for (const [dx, dz] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]]) pts.push([p.outer[k] + dx, p.outer[k + 1] + dz]);
  }
  const hull = convexHull(pts).flat();
  const holes = lawns.filter((p) => hoopGarden(...p.inner())).map((p) => p.outer);
  return { rings: [hull, ...holes], area: Math.abs(ringArea(hull)) - holes.reduce((s, h) => s + Math.abs(ringArea(h)), 0) };
})();

// --- benches, lamps & planters -----------------------------------------------------------------------------------------

// The main garden: the lawns south of the City Hall's front terrace strip
const mainLawns = lawns.filter((p) => p.area > 40 && pointInRing(...p.inner(), AREA) && p.inner()[1] > 30);
const clearOf = (x, z, list, d) => list.every(([px, pz]) => Math.hypot(px - x, pz - z) > d);
const onPath = (x, z) => !notPath(x, z) && !pitCentres.some(([px, pz]) => Math.hypot(px - x, pz - z) < 1.3) &&
  !roads.some((p) => p.has(x, z));

// Benches back onto the lawns' straight edges facing the path, one per ~8 m of edge, where the path is 2.5 m wide
const benches = [];
for (const lawn of mainLawns) {
  const r = lawn.outer, n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 6) continue;
    let nx = -(bz - az) / len, nz = (bx - ax) / len;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if (lawn.has(mx + nx * 0.4, mz + nz * 0.4)) { nx = -nx; nz = -nz; } // outward
    const count = Math.max(1, Math.floor(len / 8));
    for (let c = 0; c < count; c++) {
      const t = (c + 0.5) / count;
      const x = ax + (bx - ax) * t + nx * 0.75, z = az + (bz - az) * t + nz * 0.75;
      const along = [(bx - ax) / len, (bz - az) / len];
      const clear = [-0.9, 0, 0.9].every((s) => onPath(x + along[0] * s, z + along[1] * s)) && onPath(x + nx * 2.5, z + nz * 2.5);
      if (!clear || !clearOf(x, z, osmBenches, 3) || !clearOf(x, z, benches, 3)) continue;
      // heading: atan2 of the way a seated person looks (away from the lawn), in degrees as data-streetscape.js
      benches.push([r2(x), r2(z), Math.round((Math.atan2(nx, nz) * 180) / Math.PI)]);
    }
  }
}

// Lamps: one at each main lawn's corner nearest the round bed, just out on the path
const lamps = [];
for (const lawn of mainLawns) {
  const r = lawn.outer, n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    const x = r[2 * i], z = r[2 * i + 1];
    const ux = x - r[2 * p], uz = z - r[2 * p + 1], vx = r[2 * q] - x, vz = r[2 * q + 1] - z;
    const lu = Math.hypot(ux, uz), lv = Math.hypot(vx, vz);
    if (lu < 2 || lv < 2) continue;
    // the outward bisector of a convex corner
    let bx = ux / lu - vx / lv, bz = uz / lu - vz / lv;
    const lb = Math.hypot(bx, bz);
    if (lb < 0.5) continue;
    bx /= lb; bz /= lb;
    if (lawn.has(x + bx * 0.3, z + bz * 0.3)) continue;
    const d = Math.hypot(x - CENTRE[0], z - CENTRE[1]);
    if (!best || d < best.d) best = { d, x: x + bx * 1.0, z: z + bz * 1.0 };
  }
  if (best && onPath(best.x, best.z) && clearOf(best.x, best.z, osmLamps, 8) && clearOf(best.x, best.z, lamps, 7) &&
    clearOf(best.x, best.z, benches, 1.5)) lamps.push([r2(best.x), r2(best.z)]);
}

// Planters: on the four lawns round the round bed, at the point of each nearest the bed, a metre into the lawn
const planters = [];
for (const lawn of mainLawns) {
  const r = lawn.outer, n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * j] - ax, dz = r[2 * j + 1] - az;
    const t = Math.max(0, Math.min(1, ((CENTRE[0] - ax) * dx + (CENTRE[1] - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    const x = ax + dx * t, z = az + dz * t, d = Math.hypot(x - CENTRE[0], z - CENTRE[1]);
    if (!best || d < best.d) best = { d, x, z };
  }
  if (!best || best.d < 11 || best.d > 16) continue;
  const ux = (best.x - CENTRE[0]) / best.d, uz = (best.z - CENTRE[1]) / best.d;
  const x = best.x + ux * 1.1, z = best.z + uz * 1.1;
  if (lawn.has(x, z)) planters.push([r2(x), r2(z), Math.round((Math.atan2(-ux, -uz) * 180) / Math.PI)]);
}

// --- carousel & playground ---------------------------------------------------------------------------------------------

// Holes left in the pedestrian zone where OSM maps them: the carousel's round platform and the playground's patch
function holeNear(osmTest, minA, maxA) {
  const e = places.find((p) => p.geometry && osmTest(p.tags || {}) && pointInRing(...lonLatToLocal(p.geometry[0].lon, p.geometry[0].lat), AREA));
  if (!e) return null;
  const osm = clean(e.geometry.flatMap((g) => lonLatToLocal(g.lon, g.lat)));
  const [cx, cz] = centroid(osm);
  let best = null;
  for (const p of pedestrian) for (const h of p.holes) {
    const a = Math.abs(ringArea(h)), c = centroid(h), d = Math.hypot(c[0] - cx, c[1] - cz);
    if (a > minA && a < maxA && d < 6 && (!best || d < best.d)) best = { d, ring: h };
  }
  return { osm, ring: best ? best.ring : osm };
}
const carouselHole = holeNear((t) => t.attraction === 'carousel', 50, 250);
const carousel = (() => {
  const r = carouselHole.ring, [x, z] = centroid(r);
  return { x: r2(x), z: r2(z), r: r2(Math.sqrt(Math.abs(ringArea(r)) / Math.PI)) };
})();
const play = holeNear((t) => t.leisure === 'playground', 200, 1200);
const swings = osmPoints((t) => t.playground === 'swing');

// --- the City Hall's front terrace -------------------------------------------------------------------------------------

// OSM maps the terrace before the City Hall (a private pedestrian area paved in stone, between the facade and the strip
// of lawns, hedges and steps along its edge); the 1:500 map leaves its paving blank, which the ground would draw as
// meadow. Its paving: the cells of the OSM area no municipal surface covers, rastered at 0.2 m on the City Hall's axis
// and kept as runs along it.
const TERRACE_CELL = 0.2;
const terrace = (() => {
  const way = loadLayer('osm_streets.json').elements.find((e) => e.type === 'way' && e.tags?.highway === 'pedestrian' &&
    e.tags?.area === 'yes' && e.geometry?.length > 8 &&
    e.geometry.some((g) => { const [x, z] = lonLatToLocal(g.lon, g.lat); return Math.hypot(x - 238, z + 2) < 30; }));
  if (!way) return null;
  const ring = clean(way.geometry.flatMap((g) => lonLatToLocal(g.lon, g.lat)));
  const covered = [...zones, ...parterres, ...seasonal, ...hedges, ...stairs, ...blocks, ...near('c500_ESPALOIA.json'),
    ...near('c500_BIDEA.json'), ...near('c500_ARKUPEA.json'), ...roads];
  const ax = AXIS[0], az = AXIS[1]; // u along the facade, v = (-az, ax)... across it
  const toUV = (x, z) => [x * ax + z * az, -x * az + z * ax];
  const toXZ = (u, v) => [u * ax - v * az, u * az + v * ax];
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    const [u, v] = toUV(ring[k], ring[k + 1]);
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
  }
  const runs = [];
  let cells = 0;
  for (let v = Math.floor(v0 / TERRACE_CELL) * TERRACE_CELL; v < v1; v += TERRACE_CELL) {
    let start = null;
    for (let u = Math.floor(u0 / TERRACE_CELL) * TERRACE_CELL; u <= u1 + TERRACE_CELL; u += TERRACE_CELL) {
      const [x, z] = toXZ(u + TERRACE_CELL / 2, v + TERRACE_CELL / 2);
      const on = u <= u1 && pointInRing(x, z, ring) && !covered.some((p) => p.has(x, z));
      if (on) { cells++; if (start === null) start = u; } else if (start !== null) {
        if (u - start > 0.3) runs.push(r2(v), r2(start), r2(u));
        start = null;
      }
    }
  }
  return { axis: AXIS, cell: TERRACE_CELL, runs, area: cells * TERRACE_CELL * TERRACE_CELL };
})();

// --- the harbour side: the terrace walls, La Terraza del Náutico, the flagpole -----------------------------------------

const furnitureWays = furniture.filter((e) => e.type === 'way' && e.geometry);
const local = (e) => e.geometry.flatMap((g) => lonLatToLocal(g.lon, g.lat));
// the City Hall terrace's low walls: OSM barrier=wall ways in the City Hall's sandstone colour
const walls = furnitureWays.filter((e) => e.tags?.barrier === 'wall' && e.tags?.colour === '#d3c9ba').map((e) => local(e).map(r2));
const deckWay = loadLayer('osm_streets.json').elements.find((e) => e.type === 'way' && e.geometry && e.tags?.surface === 'wood' &&
  e.tags?.area === 'yes' && /Náutico/.test(e.tags?.name || ''));
const deck = deckWay ? clean(local(deckWay)).map(r2) : null;
const flagpoles = furniture.filter((e) => e.type === 'node' && e.tags?.man_made === 'flagpole').map((e) => lonLatToLocal(e.lon, e.lat))
  .filter(([x, z]) => Math.hypot(x - 150, z + 40) < 80).flat().map(r2);

// --- output ------------------------------------------------------------------------------------------------------------

const poly = (p) => (p.holes.length ? [p.outer.map(r2), ...p.holes.map((h) => h.map(r2))] : [p.outer.map(r2)]);
const DATA = {
  // polygons [outer, ...holes] of flat [x, z, ...] rings, local metres
  beds: beds.map(poly),
  seasonal: seasonal.map(poly),
  edging: edging.map(poly),
  hedges: hedges.map(poly),
  // open polylines [x, z, ...] (a closed one repeats its first point)
  fences,
  hoops,
  // [x, z, heading°] (the way a seated person looks / the planter's face), [x, z]
  benches: benches.flat(),
  lamps: lamps.flat(),
  planters: planters.flat(),
  carousel,
  playground: { ring: play.ring.map(r2), swings: swings.flat().map(r2) },
  // the terrace's paving: runs [v, u0, u1, ...] of TERRACE_CELL-wide rows in the frame u = (x, z)·axis,
  // v = (x, z)·(-axis.z, axis.x)
  terrace: terrace && { axis: terrace.axis, cell: terrace.cell, runs: terrace.runs },
  // polylines [x, z, ...]; a ring; [x, z, ...]
  walls,
  deck,
  flagpoles,
  // the gravel walks of the garden by Hernani street: [outer, ...holes]
  gravel: gravel && gravel.rings.map((r) => r.map(r2))
};
const json = JSON.stringify(DATA);
const js = '// js/donostia/data-alderdi.js — generated by tools/donostia/bake-alderdi.mjs; do not edit.\n' +
  '// Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0) · ' +
  '© OpenStreetMap contributors (ODbL)\n' + licenceComment('c500', 'osm') + `export const ALDERDI = ${json};\n`;
fs.writeFileSync(OUT, js);
const runLength = (runs) => runs.reduce((sum, f) => {
  for (let k = 2; k < f.length; k += 2) sum += Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
  return sum;
}, 0);
log(`Alderdi Eder: ${lawns.length} lawns, ${beds.length} beds, ${seasonal.length} seasonal clumps, ${edging.length} edging strips, ` +
  `${hedges.length} hedges; fences: ${fences.length} runs of panels (${runLength(fences).toFixed(0)} m), ${hoops.length} of hoops ` +
  `(${runLength(hoops).toFixed(0)} m); ${benches.length} benches, ${lamps.length} lamps, ${planters.length} planters; carousel r ${carousel.r} m ` +
  `at ${carousel.x}, ${carousel.z}${carouselHole.ring === carouselHole.osm ? ' (OSM outline)' : ''}; playground ` +
  `${Math.abs(ringArea(play.ring)).toFixed(0)} m²${play.ring === play.osm ? ' (OSM outline)' : ''}; terrace ` +
  `${terrace ? `${terrace.area.toFixed(0)} m² in ${terrace.runs.length / 3} runs` : 'not found'}, ${walls.length} walls; ` +
  `deck ${deck ? 'found' : 'not found'}; ${flagpoles.length / 2} flagpole(s); gravel ${gravel ? gravel.area.toFixed(0) + ' m²' : 'none'}`);
log(`${path.relative(ROOT, OUT)}: ${(js.length / 1024).toFixed(1)} kB`);

// --- preview -----------------------------------------------------------------------------------------------------------

if (PREVIEW) {
  const [x0, z0, x1, z1] = bounds(AREA).map((v, i) => (i < 2 ? v - 5 : v + 5));
  const S = 6, w = Math.round((x1 - x0) * S), h = Math.round((z1 - z0) * S);
  const px = new Uint8Array(w * h * 3).fill(235);
  const fill = (p, c) => {
    for (let j = Math.max(0, Math.floor((p.b[1] - z0) * S)); j < Math.min(h, (p.b[3] - z0) * S); j++) {
      for (let i = Math.max(0, Math.floor((p.b[0] - x0) * S)); i < Math.min(w, (p.b[2] - x0) * S); i++) {
        if (p.has(x0 + (i + 0.5) / S, z0 + (j + 0.5) / S)) px.set(c, 3 * (j * w + i));
      }
    }
  };
  const dot = (x, z, rad, c) => {
    for (let j = Math.floor((z - z0 - rad) * S); j <= (z - z0 + rad) * S; j++) for (let i = Math.floor((x - x0 - rad) * S); i <= (x - x0 + rad) * S; i++) {
      if (i >= 0 && j >= 0 && i < w && j < h && Math.hypot(x0 + i / S - x, z0 + j / S - z) <= rad) px.set(c, 3 * (j * w + i));
    }
  };
  for (const p of lawns) fill(p, [120, 190, 100]);
  for (const p of beds) fill(p, [220, 120, 160]);
  for (const p of edging) fill(p, [170, 80, 50]);
  for (const p of seasonal) fill(p, [250, 60, 200]);
  for (const p of hedges) fill(p, [20, 90, 40]);
  for (const f of [...fences, ...hoops]) for (let k = 2; k < f.length; k += 2) {
    const l = Math.hypot(f[k] - f[k - 2], f[k + 1] - f[k - 1]);
    for (let t = 0; t <= l; t += 0.1) dot(f[k - 2] + ((f[k] - f[k - 2]) * t) / l, f[k - 1] + ((f[k + 1] - f[k - 1]) * t) / l, 0.12, [0, 60, 30]);
  }
  for (let k = 0; k < benches.length; k++) dot(benches[k][0], benches[k][1], 0.5, [40, 40, 255]);
  for (const [x, z] of lamps) dot(x, z, 0.5, [255, 200, 0]);
  for (const [x, z] of planters) dot(x, z, 0.6, [120, 120, 120]);
  dot(carousel.x, carousel.z, carousel.r, [200, 40, 40]);
  fs.writeFileSync(path.join(PREVIEW, 'alderdi.png'), encodePNG(px, w, h, 3));
  log(`preview: ${path.join(PREVIEW, 'alderdi.png')}`);
}
