// tools/donostia/walls.mjs
// The shore walls, found in the 1 m LiDAR terrain for tools/donostia/build.mjs (GEO.terrain.walls, see
// js/donostia/shore-walls.js). The LiDAR keeps a sea wall as a 2-3 m wide ramp and the 2 m terrain grid smears it
// over a cell or two; here every shoreline the maps know of (the beaches' edges, the river and the docks, the OSM
// coastline and breakwaters) is walked metre by metre and a profile taken square to it. Where the profile drops
// steeply by more than WALL_MIN from flat paving to the beach, the rocks or the water, a wall stands: its crest at the
// top of the drop, its face where the drop is half done, the promenade level behind it (deck) and the ground at its foot
// (foot). The detections are smoothed along each shoreline into runs; a shoreline found by an earlier source is not
// found again by a later one.

import { WALL } from '../../js/donostia/shore-walls.js';

const STEP = 0.5; // m between profile samples
const HALF = 9; // m each side of the shoreline
const SEARCH = 7; // m: the drop must lie this close to the shoreline
const WALL_MIN = 1.4; // m: lower steps are kerbs, low terraces & rocks
const STEEP = 0.25; // m of fall per STEP that still belongs to the face (a 1 in 2 slope)
const DECK = [0.5, 4.5]; // m behind the crest over which the promenade level is taken
const SPREAD0 = 1.8; // m: how far the 1 m LiDAR spreads a plumb wall's fall (10 to 90 %)
// Ground classes (GEO.terrain.classes) a wall may hold up: paving & roads, the beach-front gardens; flat unmapped ground
// (natural) only where very flat (the port's & the river's quays, which the municipal map leaves blank)
const PAVED = new Set([1, 2, 3, 4, 9, 10, 11]);

// node: a resampled shoreline point { x, z, tx, tz }
function resample(pts, closed) {
  const out = [];
  const n = pts.length / 2;
  const last = closed ? n : n - 1;
  for (let a = 0; a < last; a++) {
    const b = (a + 1) % n;
    const ax = pts[2 * a], az = pts[2 * a + 1], bx = pts[2 * b], bz = pts[2 * b + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-6) continue;
    const steps = Math.max(1, Math.round(len));
    for (let s = 0; s < steps; s++) out.push([ax + ((bx - ax) * s) / steps, az + ((bz - az) * s) / steps]);
  }
  if (!closed && n) out.push([pts[2 * n - 2], pts[2 * n - 1]]);
  const m = out.length;
  return out.map(([x, z], k) => {
    const p = closed ? out[(k + m - 2) % m] : out[Math.max(0, k - 2)];
    const q = closed ? out[(k + 2) % m] : out[Math.min(m - 1, k + 2)];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return { x, z, tx: (q[0] - p[0]) / l, tz: (q[1] - p[1]) / l };
  });
}

// The wall in the profile square to the shoreline at node P, or null. u runs along the normal (-tz, tx).
function profileWall(dtm, P, classAt) {
  const nx = -P.tz, nz = P.tx;
  const N = Math.round((2 * HALF) / STEP) + 1;
  let h = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const u = -HALF + i * STEP;
    h[i] = dtm.sample(P.x + nx * u, P.z + nz * u);
    if (!Number.isFinite(h[i])) return null;
  }
  // the steepest 3 m fall near the shoreline, in either direction
  const span = Math.round(1.5 / STEP), reach = Math.round(SEARCH / STEP), mid = (N - 1) / 2;
  let best = 0, at = -1;
  for (let i = Math.max(span, mid - reach); i <= Math.min(N - 1 - span, mid + reach); i++) {
    const d = h[i - span] - h[i + span];
    if (Math.abs(d) > Math.abs(best)) { best = d; at = i; }
  }
  if (Math.abs(best) < WALL_MIN) return null;
  // turn the profile so the low side lies at +u
  const s = Math.sign(best);
  if (s < 0) { h = h.reverse(); at = N - 1 - at; }
  let top = at, toe = at;
  while (top > 0 && h[top - 1] - h[top] > STEEP) top--;
  while (toe < N - 1 && h[toe] - h[toe + 1] > STEEP) toe++;
  const crest = h[top], foot = h[toe];
  // the promenade behind: flat
  const deckSamples = [];
  for (let i = top - Math.round(DECK[1] / STEP); i <= top - Math.round(DECK[0] / STEP); i++) if (i >= 0) deckSamples.push(h[i]);
  if (deckSamples.length < 4) return null;
  deckSamples.sort((a, b) => a - b);
  const deck = deckSamples[deckSamples.length >> 1];
  const rough = deckSamples[deckSamples.length - 1] - deckSamples[0];
  const height = Math.min(crest, deck + 0.3) - foot;
  const extent = (toe - top) * STEP;
  if (height < WALL_MIN || deck - foot < WALL_MIN || crest - deck > 1.3 || rough > 1.2) return null;
  if (extent > 3.5 + 0.6 * height) return null; // a bank or a slope, not a wall
  // the low side stays low (not a kerb in front of a sunken lane)
  for (let i = toe + 1; i < Math.min(N, toe + Math.round(5 / STEP)); i++) if (h[i] > deck - 1) return null;
  // face: where the fall is half done; its spread from a tenth to nine tenths of the way down (a plumb wall spreads
  // over the LiDAR's 1 m cells, a battered one further)
  const cross = (level) => {
    for (let i = top; i < toe; i++) if (h[i] >= level && h[i + 1] < level) return i + (h[i] - level) / (h[i] - h[i + 1]);
    return toe;
  };
  const face = cross((crest + foot) / 2);
  const spread = (cross(foot + 0.1 * (crest - foot)) - cross(crest - 0.1 * (crest - foot))) * STEP;
  // (u counts along the turned profile, towards the low side)
  const uFace = -HALF + face * STEP, uTop = -HALF + top * STEP;
  const sx = s * nx, sz = s * nz;
  const fx = P.x + sx * uFace, fz = P.z + sz * uFace;
  // what the wall holds up
  const bx = fx - sx * 4, bz = fz - sz * 4;
  const cls = classAt(bx, bz), cls2 = classAt(fx - sx * 6, fz - sz * 6);
  const paved = PAVED.has(cls) || PAVED.has(cls2) || (cls === 0 && rough < 0.3);
  if (!paved) return null;
  return { x: fx, z: fz, nx: sx, nz: sz, s, deck, crest, foot, extent, spread, top: uTop };
}

function median(a) {
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1];
}

// Running median then two box passes of a field along a run
function smooth(v, rMed = 2, rBox = 2) {
  const n = v.length;
  let out = v.map((_, k) => median(v.slice(Math.max(0, k - rMed), Math.min(n, k + rMed + 1))));
  for (let pass = 0; pass < 2; pass++) {
    out = out.map((_, k) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, k - rBox); j <= Math.min(n - 1, k + rBox); j++) { s += out[j]; c++; }
      return s / c;
    });
  }
  return out;
}

// Douglas-Peucker over the crest points, keeping each kept point's attributes
function simplify(pts, tol) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const A = pts[a], B = pts[b];
    const dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz || 1e-9;
    let idx = -1, max = tol;
    for (let i = a + 1; i < b; i++) {
      const P = pts[i];
      const t = Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.z - A.z) * dz) / l2));
      const e = Math.hypot(P.x - A.x - t * dx, P.z - A.z - t * dz) + 0.1 * Math.abs(P.deck - (A.deck + t * (B.deck - A.deck)));
      if (e > max) { max = e; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/**
 * dtm: the 1 m Grid (lib.mjs) with sample(x, z); classAt(x, z): ground class of the 2 m core; guides: shorelines in
 * priority order, { pts (flat x, z), closed, type(x, z) -> WALL id }; exclude(x, z): no wall here (stairs down to the
 * beach, buildings that stand in the wall's line, bridges). Returns [{ t, b, p: [x, z, deck, foot, ...] }].
 */
export function detectWalls({ dtm, classAt, guides, exclude, bounds, log = () => {} }) {
  const claimed = new Map(); // 2 m cells near the walls found so far
  const ck = (x, z) => Math.floor(z / 2) * 100000 + Math.floor(x / 2);
  const claim = (x, z) => {
    for (let b = -2; b <= 2; b++) for (let a = -2; a <= 2; a++) claimed.set(ck(x + 2 * a, z + 2 * b), 1);
  };
  const walls = [];
  const stats = new Map();
  for (const guide of guides) {
    const nodes = resample(guide.pts, guide.closed);
    const hits = nodes.map((P) => {
      if (P.x < bounds.minX || P.x > bounds.maxX || P.z < bounds.minZ || P.z > bounds.maxZ) return null;
      const w = profileWall(dtm, P, classAt);
      if (!w || exclude(w.x, w.z) || claimed.has(ck(w.x, w.z))) return null;
      return w;
    });
    // runs of hits facing the same way, bridging one or two misses
    const runs = [];
    let cur = [];
    let miss = 0;
    const flush = () => { if (cur.length) runs.push(cur); cur = []; miss = 0; };
    hits.forEach((w, k) => {
      if (!w) { if (cur.length && ++miss > 2) flush(); return; }
      if (cur.length && cur[cur.length - 1].hit.s !== w.s) flush();
      miss = 0;
      cur.push({ k, hit: w, node: nodes[k] });
    });
    flush();
    // a closed shoreline's run that wraps round its start
    if (guide.closed && runs.length > 1) {
      const first = runs[0], last = runs[runs.length - 1];
      if (first[0].k <= 1 && last[last.length - 1].k >= nodes.length - 2 && first[0].hit.s === last[0].hit.s) {
        runs[0] = last.concat(first);
        runs.pop();
      }
    }
    for (const run of runs) {
      if (run.length < 8) continue;
      const s = run[0].hit.s;
      // the face's offset along the shoreline's normal, smoothed (the misses in between interpolated by the median)
      const off = smooth(run.map((r) => (r.hit.x - r.node.x) * -r.node.tz * s + (r.hit.z - r.node.z) * r.node.tx * s));
      const deck = smooth(run.map((r) => r.hit.deck), 4, 3);
      const foot = smooth(run.map((r) => r.hit.foot), 4, 3);
      const crest = smooth(run.map((r) => r.hit.crest), 4, 3);
      const spread = median(run.map((r) => r.hit.spread));
      const height = median(run.map((_, k) => Math.min(crest[k], deck[k] + 0.3) - foot[k]));
      const mid = run[run.length >> 1];
      const lowX = -mid.node.tz * s, lowZ = mid.node.tx * s;
      const type = guide.type(mid.node.x + lowX * off[run.length >> 1], mid.node.z + lowZ * off[run.length >> 1], lowX, lowZ);
      // the LiDAR spreads even a plumb wall over ~1.8 m; what is left is the batter of the Paseo Nuevo's curved sea wall
      // and of the river's older quays (La Concha's, the port's & Zurriola's walls stand plumb: what the profile adds
      // there is the sand banked against the foot)
      const lean = (spread - SPREAD0) / (0.8 * Math.max(height, 1));
      const batter = (type === WALL.paseo || type === WALL.river) && lean > 0.12 ? Math.min(0.6, lean) : 0;
      if (process.env.WALL_DEBUG) log(`  run ${run.length} m at (${run[0].node.x.toFixed(0)}, ${run[0].node.z.toFixed(0)}) spread ${spread.toFixed(2)} height ${height.toFixed(1)} lean ${lean.toFixed(2)}`);
      const pts = run.map((r, k) => {
        const nx = -r.node.tz * s, nz = r.node.tx * s;
        // the crest line: up the batter from where the fall is half done
        const back = batter * (crest[k] - foot[k]) / 2;
        return { x: r.node.x + nx * (off[k] - back), z: r.node.z + nz * (off[k] - back), deck: deck[k], foot: foot[k] };
      });
      // the shoreline's own notches (a beach edge drawn round every buttress) out of the line
      for (let pass = 0; pass < 2; pass++) {
        const sx = pts.map((q) => q.x), sz = pts.map((q) => q.z);
        for (let k = 1; k < pts.length - 1; k++) {
          let ax = 0, az = 0, c = 0;
          for (let j = Math.max(0, k - 2); j <= Math.min(pts.length - 1, k + 2); j++) { ax += sx[j]; az += sz[j]; c++; }
          pts[k].x = ax / c;
          pts[k].z = az / c;
        }
      }
      // the last profiles before a pavilion, a flight of stairs or the end of a quay miss the wall's last metres: carry
      // each end on along its line, up to 2 m, while nothing stops it
      const carry = (a, b) => {
        const l = Math.hypot(a.x - b.x, a.z - b.z) || 1, ux = (a.x - b.x) / l, uz = (a.z - b.z) / l;
        let end = null;
        for (let e = 0.5; e <= 2; e += 0.5) {
          const x = a.x + ux * e, z = a.z + uz * e;
          if (exclude(x, z) || claimed.has(ck(x, z))) break;
          end = { x, z, deck: a.deck, foot: a.foot };
        }
        return end;
      };
      const head = carry(pts[0], pts[Math.min(3, pts.length - 1)]), tail = carry(pts[pts.length - 1], pts[Math.max(0, pts.length - 4)]);
      if (head) pts.unshift(head);
      if (tail) pts.push(tail);
      // travelling so the low side lies on (-dz, dx) (the local direction of travel at the middle, not the chord of a
      // curved run)
      const m = pts.length >> 1, p0 = pts[Math.max(0, m - 3)], p1 = pts[Math.min(pts.length - 1, m + 3)];
      if ((-(p1.z - p0.z)) * lowX + (p1.x - p0.x) * lowZ < 0) pts.reverse();
      const kept = simplify(pts, 0.08);
      const p = [];
      for (const q of kept) p.push(r2(q.x), r2(q.z), r2(q.deck), r2(q.foot));
      walls.push({ t: type, b: Math.round(batter * 100) / 100, p });
      for (const q of pts) claim(q.x, q.z);
      const name = Object.keys(WALL).find((key) => WALL[key] === type);
      const st = stats.get(name) || { runs: 0, length: 0 };
      st.runs++;
      st.length += pts.length;
      stats.set(name, st);
    }
  }
  log(`shore walls: ${[...stats].map(([k, v]) => `${k} ${v.runs} runs ${(v.length / 1000).toFixed(2)} km`).join(', ')}`);
  return walls;
}

const r2 = (v) => Math.round(v * 100) / 100;

// --- the shorelines & the places without a wall ----------------------------------------------------------------------

const inBox = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
// The port (its quays and moles), Urgull's Paseo Nuevo with the river mouth's west bank, Zurriola and Sagüés
const PORT = { minX: -330, maxX: 170, minZ: -270, maxZ: -20 };
const URGULL = { minX: -470, maxX: 760, minZ: -720, maxZ: -150 };
// The river mouth's axis, from below the Zurriola bridge out between the dike and the Paseo Nuevo: east of it lie the
// Kursaal's river wall and the Zurriola promenade
const MOUTH = [690, -260, 600, -480];
const eastOfMouth = (x, z) => (MOUTH[2] - MOUTH[0]) * (z - MOUTH[1]) - (MOUTH[3] - MOUTH[1]) * (x - MOUTH[0]) > 0;
// (x, z) on the wall, (nx, nz) towards its low side
function coastType(x, z, nx, nz) {
  if (inBox(PORT, x, z)) return WALL.quay;
  if (inBox(URGULL, x, z) && !eastOfMouth(x, z)) return WALL.paseo;
  if (x > 560 && z < -150) return nx < -0.5 ? WALL.river : WALL.zurriola; // facing the river mouth, or the beach
  return WALL.quay;
}

/**
 * The shorelines to look along, in priority order: the edges of the municipal map's beaches; the OSM river & docks at
 * sea level (seaLevel(rings) decides, as build.mjs's water mask); the OSM coastline; the OSM breakwaters.
 */
export function shoreGuides({ loadLayer, osmPolygons, lonLatToLocal, seaLevel }) {
  const guides = [];
  for (const f of loadLayer('c500_HONDARTZA.json').features) {
    for (const r of f.g) if (r.length >= 6) guides.push({ pts: r, closed: true, type: (x) => (x > 400 ? WALL.zurriola : WALL.concha) });
  }
  const osm = loadLayer('osm_places.json').elements;
  for (const e of osm) {
    const t = e.tags || {};
    if (!(t.natural === 'water' || t.waterway === 'riverbank' || t.water) || t.leisure === 'swimming_pool' || t.amenity === 'fountain') continue;
    for (const rings of osmPolygons(e)) {
      if (!seaLevel(rings)) continue;
      const river = t.water === 'river' || t.waterway === 'riverbank';
      for (const r of rings) guides.push({ pts: r, closed: true, type: river ? () => WALL.river : () => WALL.quay });
    }
  }
  for (const e of osm) {
    if (e.tags?.natural !== 'coastline' || e.type !== 'way' || !e.geometry) continue;
    guides.push({ pts: e.geometry.flatMap((p) => lonLatToLocal(p.lon, p.lat)), closed: false, type: coastType });
  }
  for (const e of osm) {
    if (e.tags?.man_made !== 'breakwater') continue;
    for (const rings of osmPolygons(e)) for (const r of rings) guides.push({ pts: r, closed: true, type: coastType });
  }
  return guides;
}

/**
 * exclude(x, z) for detectWalls on a 1 m raster over `ext`: the municipal map's stairs (the flights down to the beach
 * cut the wall), its buildings (La Perla and the other bathing pavilions stand in the line of La Concha's wall and face
 * the beach themselves; the Aquarium & the Naval Museum on the port), and the OSM bridges over the water (their
 * abutments).
 */
export function wallExclusions({ loadLayer, scanRings, lonLatToLocal, ext }) {
  const w = ext.maxX - ext.minX, h = ext.maxZ - ext.minZ;
  // 1: stairs, kept a metre clear; 2: buildings & bridges, where no wall may stand
  const mask = new Uint8Array(w * h);
  const paint = (rings, v) => scanRings(rings, ext.minX, ext.minZ, 1, w, h, (i, j) => { mask[j * w + i] = v; });
  for (const f of loadLayer('c500_ESKAILERA.json').features) paint(f.g.filter((r) => r.length >= 6), 1);
  for (const file of ['c500_ERAIKINA.json', 'c500_EraikinArinak.json']) {
    for (const f of loadLayer(file).features) paint(f.g.filter((r) => r.length >= 6), 2);
  }
  for (const e of loadLayer('osm_streets.json').elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !e.geometry || !t.bridge || t.bridge === 'no' || !(t.highway || t.railway)) continue;
    const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
    const half = (Number.parseFloat(t.width) > 0.5 ? Number.parseFloat(t.width) : 12) / 2 + 2;
    for (let k = 1; k < pts.length; k++) {
      const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
      const len = Math.hypot(bx - ax, bz - az);
      for (let d = 0; d <= len; d += 0.5) {
        const x = ax + ((bx - ax) * d) / (len || 1), z = az + ((bz - az) * d) / (len || 1);
        for (let b = -half; b <= half; b += 1) for (let a = -half; a <= half; a += 1) {
          const i = Math.floor(x + a - ext.minX), j = Math.floor(z + b - ext.minZ);
          if (i >= 0 && j >= 0 && i < w && j < h) mask[j * w + i] = 2;
        }
      }
    }
  }
  // a metre round the stairs, half a metre round the buildings (a wall may run up to a pavilion's side, not across its
  // front)
  const near = (x, z, r, step, v) => {
    for (let b = -r; b <= r; b += step) for (let a = -r; a <= r; a += step) {
      const i = Math.floor(x + a - ext.minX), j = Math.floor(z + b - ext.minZ);
      if (i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === v) return true;
    }
    return false;
  };
  return (x, z) => near(x, z, 1, 1, 1) || near(x, z, 0.5, 0.5, 2);
}
