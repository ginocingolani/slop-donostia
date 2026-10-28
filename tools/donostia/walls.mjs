// tools/donostia/walls.mjs
// The shore walls, found in the 1 m LiDAR terrain for tools/donostia/build.mjs (GEO.terrain.walls, see
// js/donostia/shore-walls.js). The LiDAR keeps a sea wall as a 2-3 m wide ramp and the 2 m terrain grid smears it
// over a cell or two; here every shoreline the maps know of (the beaches' edges, the river and the docks, the OSM
// coastline and breakwaters) is walked metre by metre and a profile taken square to it. Where the profile drops
// steeply by more than WALL_MIN from flat paving to the beach, the rocks or the water, a wall stands: its crest at the
// top of the drop, its face where the drop is half done, the promenade level behind it (deck) and the ground at its foot
// (foot). The detections are smoothed along each shoreline into runs; a shoreline found by an earlier source is not
// found again by a later one.

import { WALL, nearestWall } from '../../js/donostia/shore-walls.js';
import { pointInRing } from './lib.mjs';

const STEP = 0.5; // m between profile samples
const HALF = 9; // m each side of the shoreline
const SEARCH = 7; // m: the drop must lie this close to the shoreline
const WALL_MIN = 1.4; // m: lower steps are kerbs, low terraces & rocks
const STEEP = 0.25; // m of fall per STEP that still belongs to the face (a 1 in 2 slope)
const DECK = [0.5, 4.5]; // m behind the crest over which the promenade level is taken
const WALK = 2, WALK_RISE = 0.6; // m: the narrowest walk along a wall that a bank may rise behind; the most it rises across
const FALLS = 3; // the falls tried in each profile
const JOIN_MISSES = 5; // by a beach, the profiles between two runs of one wall that may miss it
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

// The wall in the profile square to the shoreline at node P, or null. u runs along the normal (-tz, tx). beach: P lies on
// a beach's edge (the falls after the steepest are tried, and a walk with a bank behind it holds a wall up).
function profileWall(dtm, P, classAt, beach) {
  const nx = -P.tz, nz = P.tx;
  const N = Math.round((2 * HALF) / STEP) + 1;
  const h = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const u = -HALF + i * STEP;
    h[i] = dtm.sample(P.x + nx * u, P.z + nz * u);
    if (!Number.isFinite(h[i])) return null;
  }
  // the steepest 3 m fall near the shoreline, in either direction; by a beach, the next steepest too while none makes a
  // wall (behind the walk round the Pico del Loro, Miramar's garden bank falls faster than the sea wall in front of it)
  const span = Math.round(1.5 / STEP), reach = Math.round(SEARCH / STEP), mid = (N - 1) / 2;
  const falls = [];
  for (let i = Math.max(span, mid - reach); i <= Math.min(N - 1 - span, mid + reach); i++) {
    const d = h[i - span] - h[i + span];
    if (Math.abs(d) >= WALL_MIN) falls.push([i, d]);
  }
  falls.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0] - b[0]);
  const tried = [];
  for (const [i, d] of falls) {
    if (tried.some((t) => Math.abs(t - i) <= 2 * span)) continue; // (one try per fall)
    if (tried.push(i) > (beach ? FALLS : 1)) break;
    // turn the profile so the low side lies at +u
    const w = d > 0 ? profileFall(h, i, 1, P, classAt, beach) : profileFall(h.slice().reverse(), N - 1 - i, -1, P, classAt, beach);
    if (w) return w;
  }
  return null;
}

// The wall of the fall at `at` in the profile h (turned so the low side lies at +u; s: +1 as sampled, -1 turned), or null
function profileFall(h, at, s, P, classAt, beach) {
  const N = h.length, nx = -P.tz, nz = P.tx;
  let top = at, toe = at;
  while (top > 0 && h[top - 1] - h[top] > STEEP) top--;
  while (toe < N - 1 && h[toe] - h[toe + 1] > STEEP) toe++;
  const crest = h[top], foot = h[toe];
  // the promenade behind: flat; or, by a beach, a walk WALK wide or more along the wall with the ground behind it only
  // rising (the walk round the Pico del Loro under Miramar's gardens, Ondarreta's end climbing to it): the walk's level
  const deckSamples = [], walk = [];
  let rising = true;
  for (let i = top - Math.round(DECK[1] / STEP); i <= top - Math.round(DECK[0] / STEP); i++) {
    if (i < 0) continue;
    deckSamples.push(h[i]);
    if (i >= top - Math.round(WALK / STEP)) walk.push(h[i]);
    if (i > 0 && h[i - 1] < h[i] - 0.1) rising = false;
  }
  if (deckSamples.length < 4) return null;
  deckSamples.sort((a, b) => a - b);
  let deck = deckSamples[deckSamples.length >> 1];
  let rough = deckSamples[deckSamples.length - 1] - deckSamples[0];
  if (beach && rough > 1.2 && rising && walk.length >= 3) {
    const walkRough = Math.max(...walk) - Math.min(...walk);
    if (walkRough <= WALK_RISE) {
      deck = median(walk);
      rough = walkRough;
    }
  }
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
 * priority order, { pts (flat x, z), closed, type(x, z) -> WALL id, beach (a beach's edge) }; exclude(x, z): no wall here (stairs down to the
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
  let dupes = 0;
  for (const guide of guides) {
    const nodes = resample(guide.pts, guide.closed);
    const hits = nodes.map((P) => {
      if (P.x < bounds.minX || P.x > bounds.maxX || P.z < bounds.minZ || P.z > bounds.maxZ) return null;
      const w = profileWall(dtm, P, classAt, guide.beach);
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
    // by a beach, two runs a few metres apart, facing the same way at the same level with nothing between them that cuts
    // a wall (stairs, a building), are one wall the profiles lost for a moment (where the walk round the Pico del Loro
    // leaves La Concha's promenade, its LiDAR dips)
    if (guide.beach) {
      for (let r = runs.length - 1; r > 0; r--) {
        const a = runs[r - 1], b = runs[r], e = a[a.length - 1].hit, f = b[0].hit;
        if (b[0].k - a[a.length - 1].k - 1 > JOIN_MISSES || e.s !== f.s || Math.abs(e.deck - f.deck) > 1) continue;
        const l = Math.hypot(f.x - e.x, f.z - e.z);
        let clear = true;
        for (let t = 0; t <= l && clear; t += 0.5) clear = !exclude(e.x + ((f.x - e.x) * t) / (l || 1), e.z + ((f.z - e.z) * t) / (l || 1));
        if (clear) runs.splice(r - 1, 2, a.concat(b));
      }
    }
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
      // (a run over a wall another run of the same shoreline found already, where the shoreline doubles back round a
      // buttress or the head of a flight: two lines on one wall would each take some of its samples)
      if (pts.filter((q) => claimed.has(ck(q.x, q.z)) && nearestWall(walls, q.x, q.z, 1)).length > 0.6 * pts.length) { dupes++; continue; }
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
  log(`shore walls: ${[...stats].map(([k, v]) => `${k} ${v.runs} runs ${(v.length / 1000).toFixed(2)} km`).join(', ')}; ${dupes} ` +
    `runs over walls found already dropped`);
  return walls;
}

const r2 = (v) => Math.round(v * 100) / 100;

// --- the flights of steps down from the walls --------------------------------------------------------------------------

// m: a piece of a flight this close to a shore wall goes down from it; one further off (the broad flights between the
// bastions by Miramar), up to STAIR_FAR, only if it falls a metre or more below the promenade
const STAIR_REACH = 3, STAIR_FAR = 8;
const LANDING = 0.12; // fall per metre under which a piece of a flight is a landing
const STAIR_STEEP = 1.2; // the steepest a flight is taken to fall (beyond: the wall's own drop in the fit)

/**
 * The flights of steps down from the shore walls to the sand, the rocks or the water: the municipal map's stairs
 * (ESKAILERA) by a wall (STAIR_REACH; STAIR_FAR for a piece that falls well below the promenade), which the 2 m terrain
 * keeps as the ramp the wall was. Each piece's slope is
 * a plane fitted to the 1 m LiDAR inside it, its top & bottom where that plane meets its outline, kept between the
 * wall's promenade (deck) and its foot; a piece that hardly falls is a landing at its own level.
 * The flights down to the beaches are tools/donostia/beach-access.mjs's: skip(x, z) tells the pieces it took (by the
 * mean of their outline's vertices).
 * Returns [{ p: [x, z, ...], top, bot, ux, uz (downhill, horizontal), plane: [a, b, c, cx, cz] (y = c + a (x - cx) +
 * b (z - cz)) }].
 */
export function detectStairs({ dtm, walls, loadLayer, scanRings, skip = () => false, log = () => {} }) {
  const out = [];
  for (const f of loadLayer('c500_ESKAILERA.json').features) {
    for (const r of f.g) {
      const n = r.length / 2;
      if (n < 3) continue;
      let area = 0, cx = 0, cz = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) area += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
      if (Math.abs(area / 2) < 0.5) continue;
      for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1]; }
      cx /= n; cz /= n;
      if (skip(cx, cz)) continue;
      // the wall it comes down from: the nearest to its outline (sampled every metre)
      let wall = null, dist = Infinity;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], len = Math.hypot(r[2 * j] - ax, r[2 * j + 1] - az);
        for (let s = 0; s < len || s === 0; s += 1) {
          const f = len > 0 ? s / len : 0, x = ax + (r[2 * j] - ax) * f, z = az + (r[2 * j + 1] - az) * f;
          const q = nearestWall(walls, x, z, STAIR_FAR);
          const d = q ? Math.hypot(x - q.x, z - q.z) : Infinity;
          if (d < dist) { dist = d; wall = q; }
        }
      }
      if (!wall) continue;
      // least squares plane through the LiDAR inside (the corners too, for the narrow pieces)
      const S = [];
      scanRings([r], dtm.x0, dtm.z0, dtm.res, dtm.w, dtm.h, (i, j) => {
        const v = dtm.data[j * dtm.w + i];
        if (!Number.isNaN(v)) S.push(dtm.x0 + (i + 0.5) * dtm.res - cx, dtm.z0 + (j + 0.5) * dtm.res - cz, v);
      });
      for (let k = 0; k < r.length; k += 2) {
        const v = dtm.sample(r[k], r[k + 1]);
        if (!Number.isNaN(v)) S.push(r[k] - cx, r[k + 1] - cz, v);
      }
      if (S.length < 9) continue;
      let sxx = 0, sxz = 0, szz = 0, sxh = 0, szh = 0, sh = 0, sx = 0, sz = 0;
      const m = S.length / 3;
      for (let k = 0; k < S.length; k += 3) {
        const [x, z, h] = [S[k], S[k + 1], S[k + 2]];
        sx += x; sz += z; sh += h; sxx += x * x; sxz += x * z; szz += z * z; sxh += x * h; szh += z * h;
      }
      // centred on the samples' mean
      const mx = sx / m, mz = sz / m, mh = sh / m;
      const Cxx = sxx / m - mx * mx, Cxz = sxz / m - mx * mz, Czz = szz / m - mz * mz;
      const Cxh = sxh / m - mx * mh, Czh = szh / m - mz * mh;
      const det = Cxx * Czz - Cxz * Cxz;
      let a = 0, b = 0;
      if (det > 1e-6) { a = (Cxh * Czz - Czh * Cxz) / det; b = (Czh * Cxx - Cxh * Cxz) / det; }
      let slope = Math.hypot(a, b);
      if (slope > STAIR_STEEP) { a *= STAIR_STEEP / slope; b *= STAIR_STEEP / slope; slope = STAIR_STEEP; }
      const c = mh - a * mx - b * mz;
      const at = (x, z) => c + a * (x - cx) + b * (z - cz);
      let top = -Infinity, bot = Infinity;
      for (let k = 0; k < r.length; k += 2) { const h = at(r[k], r[k + 1]); top = Math.max(top, h); bot = Math.min(bot, h); }
      if (dist > STAIR_REACH && bot > wall.deck - 1) continue;
      top = Math.min(top, wall.deck + 0.02);
      bot = Math.max(bot, wall.foot - 0.1);
      let ux = slope > 1e-3 ? -a / slope : wall.nx, uz = slope > 1e-3 ? -b / slope : wall.nz;
      if (slope < LANDING || top - bot < 0.12) {
        // a landing: flat at its own level
        top = bot = Math.min(wall.deck + 0.02, Math.max(wall.foot, at(cx, cz)));
        ux = wall.nx; uz = wall.nz;
      }
      out.push({
        p: r.map(r2), top: r2(top), bot: r2(bot), ux: Math.round(ux * 1000) / 1000, uz: Math.round(uz * 1000) / 1000,
        plane: [a, b, c, cx, cz]
      });
    }
  }
  log(`shore stairs: ${out.length} flights & landings by the walls (${out.filter((s) => s.top === s.bot).length} landings)`);
  return out;
}

// --- the port's flights cut into its quays ----------------------------------------------------------------------------

// js/donostia/shore.js builds each flight as solid steps of about this rise (its RISE)
const STEP_RISE = 0.17;
// A flight this many times longer than wide runs down along a quay's face
const NARROW = 3;

// The plane detectStairs fits to the LiDAR inside a narrow flight down a quay's face falls across it, to the water (the
// 1 m LiDAR smears the face over its width): it falls along its length instead, to the lowest LiDAR across it (the
// municipal outline and the LiDAR can disagree by a metre) from the farther end (no higher than the quay beside it; the
// quay round its ends bleeds into the samples there, which a straight fit would follow). Changes the piece; true if it
// did.
function alongFace(st, at) {
  const { p } = st;
  const n = p.length / 2;
  let cx = 0, cz = 0;
  for (let k = 0; k < p.length; k += 2) { cx += p[k]; cz += p[k + 1]; }
  cx /= n; cz /= n;
  // its length along its longest side
  let lx = 1, lz = 0, longest = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n, dx = p[2 * j] - p[2 * i], dz = p[2 * j + 1] - p[2 * i + 1], l = Math.hypot(dx, dz);
    if (l > longest) { longest = l; lx = dx / l; lz = dz / l; }
  }
  const wx = -lz, wz = lx;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (let k = 0; k < p.length; k += 2) {
    const a = (p[k] - cx) * lx + (p[k + 1] - cz) * lz, b = (p[k] - cx) * wx + (p[k + 1] - cz) * wz;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
  }
  const len = a1 - a0;
  if (len < 3 || len < NARROW * (b1 - b0)) return false;
  // across it every half metre along it: the lowest & the middle LiDAR
  const S = [];
  for (let a = a0 + 0.3; a <= a1 - 0.3; a += 0.5) {
    const v = [0.15, 0.3, 0.5, 0.7, 0.85].map((f) => at(cx + lx * a + wx * (b0 + f * (b1 - b0)), cz + lz * a + wz * (b0 + f * (b1 - b0))))
      .filter(Number.isFinite);
    if (v.length >= 3) S.push([a, Math.min(...v), median(v)]);
  }
  if (S.length < 4) return false;
  const low = S.reduce((m, q) => (q[1] < m[1] ? q : m));
  const aTop = low[0] - a0 < a1 - low[0] ? a1 : a0;
  // the quay beside it: the higher of its long sides, 2 m out
  const beside = (b) => median([0.25, 0.5, 0.75].map((f) => at(cx + lx * (a0 + f * len) + wx * b, cz + lz * (a0 + f * len) + wz * b))
    .filter(Number.isFinite));
  const quay = Math.max(beside(b1 + 2), beside(b0 - 2));
  const top = Math.min(quay + 0.02, Math.max(...S.filter((q) => Math.abs(q[0] - aTop) < 1.5).map((q) => q[2])));
  const bot = Math.max(0.3, low[1]);
  if (!(top - bot >= 0.6)) return false;
  // y = top at aTop, bot at the lowest point (shoreStairs and shore.js keep to [bot, top] beyond)
  const g = (bot - top) / (low[0] - aTop), dir = g < 0 ? 1 : -1;
  Object.assign(st, {
    top: r2(top), bot: r2(bot), ux: Math.round(lx * dir * 1000) / 1000, uz: Math.round(lz * dir * 1000) / 1000,
    plane: [g * lx, g * lz, top - g * aTop, cx, cz]
  });
  return true;
}

/**
 * The port's quay steps (detectStairs' pieces inside PORT) run down along a quay's face or out of a notch cut into it,
 * which the 2 m terrain keeps as a bank round them. The narrow flights down a face are turned to fall along it
 * (alongFace: the pieces change). Every side of a piece is walked every half metre, the 1 m LiDAR
 * 1.5-3 m out telling what lies beyond: the quay QUAY_MIN or more above the steps and level (a cheek: a quay wall from
 * the quay down to the flight), or the water (the quay's face under the flight: a hidden wall, so the terrain steps down
 * there, the flight's own stone going on down to the harbour's bed); or the next piece, the quay at the head, a
 * pontoon at the foot, a wall of `walls` already there (nothing). Runs of 1 m or more of one kind become walls (the low
 * side on the left of travel). Returns { walls, deep: Set of the pieces with a face on the water }.
 */
export function stairWalls({ dtm, stairs, walls: shore = [], log = () => {} }) {
  const at = (x, z) => { const v = dtm.sample(x, z); return Number.isFinite(v) ? v : NaN; };
  const port = stairs.filter((st) => inBox(PORT, st.p[0], st.p[1]));
  const walls = [], deep = new Set();
  let cheeks = 0, faces = 0, turned = 0;
  for (const st of port) {
    if (alongFace(st, at)) turned++;
    const { p, top, bot, ux, uz } = st;
    const n = p.length / 2;
    // the steps' treads, as shore.js cuts them: slices square to the fall from s0 (the head) to s1
    let s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) { const s = p[k] * ux + p[k + 1] * uz; s0 = Math.min(s0, s); s1 = Math.max(s1, s); }
    const steps = top > bot ? Math.max(1, Math.round((top - bot) / STEP_RISE)) : 1;
    const tread = (x, z) => {
      const i = Math.min(steps - 1, Math.max(0, Math.floor((((x * ux + z * uz) - s0) / Math.max(s1 - s0, 1e-6)) * steps)));
      return top - ((top - bot) * i) / steps;
    };
    const inOther = (x, z) => port.some((o) => o !== st && pointInRing(x, z, o.p));
    // samples round the ring: { x, z, kind ('cheek' | 'face' | null), out (the side away from the piece), level }
    const pts = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = p[2 * i], az = p[2 * i + 1], bx = p[2 * j], bz = p[2 * j + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 0.3) continue;
      const tx = (bx - ax) / len, tz = (bz - az) / len;
      // (the side away from the piece: the left normal unless the piece lies there)
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const sg = pointInRing(mx - tz * 0.2, mz + tx * 0.2, p) ? -1 : 1;
      const ox = -tz * sg, oz = tx * sg;
      const m = Math.max(1, Math.round(len / 0.5));
      for (let q = 0; q <= m; q++) {
        const x = ax + ((bx - ax) * q) / m, z = az + ((bz - az) * q) / m;
        const pt = { x, z, kind: null, ox, oz, edge: i };
        pts.push(pt);
        // (not along a wall already there: a sliver of a flight drawn along a quay's face)
        if (q === 0 || q === m || inOther(x + ox * 0.75, z + oz * 0.75) || nearestWall(shore, x, z, 0.8)) continue;
        const beyond = [1.5, 2, 2.5, 3].map((t) => at(x + ox * t, z + oz * t)).filter(Number.isFinite);
        if (beyond.length < 3) continue;
        const level = median(beyond), spread = Math.max(...beyond) - Math.min(...beyond);
        const h = tread(x, z);
        if (spread > QUAY_FLAT) continue;
        if (level <= QUAY_SEA && h > level + 0.3) Object.assign(pt, { kind: 'face', deck: h - STEP_RISE - 0.12, foot: level });
        else if (level >= h + QUAY_MIN) Object.assign(pt, { kind: 'cheek', deck: level, foot: h - STEP_RISE });
      }
    }
    // runs of one kind along one side (a corner ends a run: a wall turns with the quay, not round a piece's corner)
    let run = [];
    const flush = () => {
      let len = 0;
      for (let k = 1; k < run.length; k++) len += Math.hypot(run[k].x - run[k - 1].x, run[k].z - run[k - 1].z);
      if (run.length >= 2 && len >= 1) {
        const kind = run[0].kind;
        // low side on the left of travel (-dz, dx): the water beyond a face, the flight inside a cheek
        const a = run[0], b = run[run.length - 1], dx = b.x - a.x, dz = b.z - a.z;
        const lowOut = kind === 'face';
        const leftIsOut = -dz * a.ox + dx * a.oz > 0;
        const pts2 = leftIsOut === lowOut ? run : [...run].reverse();
        const wall = { t: WALL.quay, b: 0, p: pts2.flatMap((q) => [q.x, q.z, q.deck, q.foot].map(r2)) };
        if (kind === 'face') { wall.h = [0, pts2.length - 1]; deep.add(st); faces++; } else cheeks++;
        walls.push(wall);
      }
      run = [];
    };
    for (const pt of pts) {
      if (run.length && (!pt.kind || pt.kind !== run[0].kind || pt.edge !== run[0].edge)) flush();
      if (pt.kind) run.push(pt);
    }
    flush();
  }
  log(`port stairs: ${port.length} pieces (${turned} narrow flights turned to fall along a quay's face), ${cheeks} ` +
    `cheeks and ${faces} faces on the water (hidden) as walls`);
  return { walls, deep };
}

// --- the port's quays where the search finds only scraps ----------------------------------------------------------------

// The search above finds the north basin's north quay only in short runs (boats moored along it, the smear of its edge
// over the 1 m cells) and the sides of the old port's slipway not at all (they drop by less than WALL_MIN near the top of
// the ramp, and the slipway's floor is no paving). In these boxes the edges of the municipal map's quays (KAIA) stand as
// walls wherever the LiDAR falls by QUAY_MIN or more across them: the crest on the map's edge, the quay behind (deck),
// the water or the slipway's floor in front (foot, the lowest of the LiDAR 1-5 m out: a moored boat does not lift it);
// the walls the search found along them give way.
const QUAY_BOXES = [
  { minX: -40, maxX: 40, minZ: -237, maxZ: -196 }, // the north basin's north quay
  { minX: -242, maxX: -184, minZ: -164, maxZ: -130 } // the old port's slipway, its two sides
];
const QUAY_MIN = 0.8; // m
const QUAY_RUN = 3; // m: shorter runs are left out
// Elsewhere in the port (PORT) the search misses the quays' faces by the flights of steps cut into them, round the
// piers' rounded ends, where boats moored along a quay lift the LiDAR and along the west mole's raised walk (over the old
// port's square, by the Aquarium): there a quay's edge stands as a wall only where it plainly is one, the LiDAR level
// (within QUAY_FLAT) on the quay behind and, in front, the water (the LiDAR's sea, 0 m) or a level square QUAY_MIN or
// more below. A flight down the edge, a ramp, a bank or an edge drawn inside the quay is no wall.
const QUAY_FLAT = 0.5; // m: the spread of the LiDAR over a level side, 1.5-4 m from the edge
const QUAY_STRIP = 2; // m
const QUAY_GAP = 3; // m

// Round a closed ring of samples { wall, maybe, s }: the gaps of QUAY_GAP or less between two wall samples with the low
// side on one side, every sample of which might be a wall on that side, become wall
function bridge(pts) {
  const N = pts.length, max = Math.round(QUAY_GAP / 0.5);
  for (let a = 0; a < N; a++) {
    const A = pts[a], B = pts[(a + 1) % N];
    if (!A.wall || B.wall) continue;
    let k = 1;
    while (k <= max + 1 && !pts[(a + k) % N].wall) k++;
    const C = pts[(a + k) % N];
    if (k > max + 1 || !C.wall || C.s !== A.s) continue;
    const gap = [];
    for (let j = 1; j < k; j++) gap.push(pts[(a + j) % N]);
    if (gap.every((p) => p.maybe && p.s === A.s)) for (const p of gap) p.wall = true;
  }
}
const QUAY_SEA = 0.6; // m

/**
 * dtm: the 1 m Grid; walls: detectWalls' runs. Returns the walls with the quays' edges in QUAY_BOXES and the port's plain
 * quay walls added (and the runs the search found along them dropped).
 */
export function quayEdges({ dtm, walls, loadLayer, log = () => {} }) {
  const inAny = (x, z, pad = 0) => QUAY_BOXES.some((b) => x >= b.minX - pad && x <= b.maxX + pad && z >= b.minZ - pad && z <= b.maxZ + pad);
  const at = (x, z) => { const v = dtm.sample(x, z); return Number.isFinite(v) ? v : NaN; };
  const runs = [];
  for (const f of loadLayer('c500_KAIA.json').features) {
    for (const r of f.g) {
      if (r.length < 6) continue;
      // samples every half metre round the ring: { x, z, wall, s (+1: the low side on the ring's left (-tz, tx)) }
      const pts = [];
      const n = r.length / 2;
      // (a hole under QUAY_STRIP thick is a strip on the quay, a crane track or a kerb a metre inside its edge: no wall
      // outside the boxes)
      let area = 0, perimeter = 0;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        area += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
        perimeter += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]);
      }
      const strip = r !== f.g[0] && Math.abs(area) / Math.max(perimeter, 1e-6) < QUAY_STRIP / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1], len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        const tx = (bx - ax) / len, tz = (bz - az) / len, nx = -tz, nz = tx;
        const m = Math.max(1, Math.round(len / 0.5));
        for (let q = 0; q < m; q++) {
          const x = ax + ((bx - ax) * q) / m, z = az + ((bz - az) * q) / m;
          const p = { x, z, wall: false };
          pts.push(p);
          // (the boxes with 2 m to spare: their corners; elsewhere in the port, the plain walls only)
          const boxed = inAny(x, z, 2);
          if (!boxed && (strip || !inBox(PORT, x, z))) continue;
          const side = (sg, ts) => ts.map((t) => at(x + sg * nx * t, z + sg * nz * t)).filter(Number.isFinite);
          const plus = side(1, [1.5, 2, 2.5, 3, 3.5, 4]), minus = side(-1, [1.5, 2, 2.5, 3, 3.5, 4]);
          if (plus.length < 3 || minus.length < 3) continue;
          const s = median(plus) < median(minus) ? 1 : -1;
          const deck = median(s > 0 ? minus : plus);
          const foot = Math.min(...side(s, [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]));
          if (deck - foot < QUAY_MIN) continue;
          if (!boxed) {
            // (the quay level, and the water from 2.5 m out (the LiDAR smears a plumb face over the first metres) or a
            // level square: an edge drawn a metre or two inside a quay's coping, a flight or a bank fall across the
            // samples of one side; one that falls short of this between two that pass, a boat moored alongside or a
            // jog in the edge, may bridge them)
            const spread = (v) => Math.max(...v) - Math.min(...v);
            const high = s > 0 ? minus : plus, low = s > 0 ? plus : minus;
            const sea = low.slice(2).every((v) => v <= QUAY_SEA);
            if (high.length < 6 || low.length < 6 || spread(high) > QUAY_FLAT ||
              (!sea && (spread(low) > QUAY_FLAT || median(low) > deck - QUAY_MIN))) {
              Object.assign(p, { maybe: true, s, deck, foot });
              continue;
            }
          }
          Object.assign(p, { wall: true, s, deck, foot });
        }
      }
      // the gaps of QUAY_GAP or less between two wall samples on the same side, all of whose samples might be one
      bridge(pts);
      // runs of wall samples with the low side on one side, round the ring (starting after a gap)
      const N = pts.length, start = pts.findIndex((p) => !p.wall);
      if (start < 0) continue;
      let cur = null;
      for (let q = 1; q <= N; q++) {
        const p = pts[(start + q) % N];
        if (cur && (!p.wall || p.s !== cur[0].s)) { runs.push(cur); cur = null; }
        if (p.wall) (cur ||= []).push(p);
      }
      if (cur) runs.push(cur);
    }
  }
  const added = [];
  for (const run of runs) {
    let len = 0;
    for (let k = 1; k < run.length; k++) len += Math.hypot(run[k].x - run[k - 1].x, run[k].z - run[k - 1].z);
    if (len < QUAY_RUN) continue;
    // walked with the low side on the left of travel (-dz, dx), as every wall
    const pts = run[0].s > 0 ? run : [...run].reverse();
    const deck = smooth(pts.map((p) => p.deck)), foot = smooth(pts.map((p) => p.foot));
    const kept = simplify(pts.map((p, k) => ({ x: p.x, z: p.z, deck: deck[k], foot: Math.min(foot[k], deck[k] - QUAY_MIN) })), 0.2);
    added.push({ t: WALL.quay, b: 0, p: kept.flatMap((p) => [p.x, p.z, p.deck, p.foot].map((v) => Math.round(v * 100) / 100)) });
  }
  // runs that one ends where another starts (across the jogs of the map's edge, where the samples look along the jog)
  // joined into one
  for (let joined = true; joined;) {
    joined = false;
    for (const a of added) {
      const k = a.p.length;
      const b = added.find((o) => o !== a && Math.hypot(o.p[0] - a.p[k - 4], o.p[1] - a.p[k - 3]) < 2.5);
      if (!b) continue;
      a.p = [...a.p, ...b.p];
      added.splice(added.indexOf(b), 1);
      joined = true;
      break;
    }
  }
  // the runs the search found along these edges give way (split where they come within 2.5 m of one)
  const near = (x, z) => (inAny(x, z, 3) || inBox(PORT, x, z)) && added.some((w) => {
    for (let k = 0; k + 4 < w.p.length; k += 4) {
      const ax = w.p[k], az = w.p[k + 1], dx = w.p[k + 4] - ax, dz = w.p[k + 5] - az, l2 = dx * dx + dz * dz || 1e-12;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      if (Math.hypot(x - ax - t * dx, z - az - t * dz) < 2.5) return true;
    }
    return false;
  });
  const out = [];
  let dropped = 0;
  for (const w of walls) {
    let cur = [];
    const flush = () => { if (cur.length >= 8) out.push({ ...w, p: cur }); cur = []; };
    const lerp = (k, t) => [0, 1, 2, 3].map((o) => w.p[k + o] + (w.p[k + 4 + o] - w.p[k + o]) * t);
    for (let k = 0; k < w.p.length; k += 4) {
      if (near(w.p[k], w.p[k + 1])) {
        dropped++;
        flush();
      } else cur.push(...w.p.slice(k, k + 4));
      if (k + 4 >= w.p.length) break;
      // (cut where the segment to the next vertex comes within reach of a new run, or leaves it)
      const len = Math.hypot(w.p[k + 4] - w.p[k], w.p[k + 5] - w.p[k + 1]);
      let was = near(w.p[k], w.p[k + 1]);
      for (let s = 0.25; s < len; s += 0.25) {
        const q = lerp(k, s / len), is = near(q[0], q[1]);
        if (is && !was) { cur.push(...q); flush(); }
        if (!is && was) cur.push(...q);
        was = is;
      }
    }
    flush();
  }
  // and joined to what is left of those where one ends within 3 m of the other's start, going on the same way
  const dir = (p, k0, k1) => { const dx = p[k1] - p[k0], dz = p[k1 + 1] - p[k0 + 1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  const along = (u, v) => u[0] * v[0] + u[1] * v[1] > 0.5;
  let spliced = 0;
  for (const a of added) {
    for (const end of ['head', 'tail']) {
      const k = a.p.length;
      const o = out.find((w) => {
        if (w.t !== a.t) return false;
        const m = w.p.length;
        const [gx, gz] = end === 'head' ? [w.p[m - 4], w.p[m - 3]] : [w.p[0], w.p[1]];
        const [hx, hz] = end === 'head' ? [a.p[0], a.p[1]] : [a.p[k - 4], a.p[k - 3]];
        const gap = Math.hypot(hx - gx, hz - gz);
        if (gap > 3 || gap < 0.05) return gap <= 0.05;
        const j = end === 'head' ? [(hx - gx) / gap, (hz - gz) / gap] : [(gx - hx) / gap, (gz - hz) / gap];
        return along(j, dir(w.p, end === 'head' ? m - 8 : 0, end === 'head' ? m - 4 : 4)) &&
          along(j, dir(a.p, end === 'head' ? 0 : k - 8, end === 'head' ? 4 : k - 4));
      });
      if (!o) continue;
      a.p = end === 'head' ? [...o.p, ...a.p] : [...a.p, ...o.p];
      out.splice(out.indexOf(o), 1);
      spliced++;
    }
  }
  log(`port quays: ${added.length} runs along the quays' edges (${added.reduce((s, w) => s + w.p.length / 4, 0)} vertices), ` +
    `${dropped} vertices of the search's runs along them dropped, ${spliced} joined to what is left of them`);
  return [...out, ...added];
}

// --- the gaps between the port's walls ----------------------------------------------------------------------------------

// The search's runs, the quays' edges and the flights' cheeks stop a metre or two short of each other at the jogs and
// corners of the quays, and the 2 m grid leaves a bank, a fin, in every gap. Where one of the port's walls ends within
// JOIN_GAP of where another starts, going on the same way round the quay (neither turning back) with the water or the
// lower ground on the same side, they become one wall. Hidden walls stay as they are.
const JOIN_GAP = 3; // m

/**
 * dtm: the 1 m Grid; walls: GEO.terrain.walls, joined in place. Returns the Set of the walls that grew.
 */
export function joinPortWalls({ dtm, walls, log = () => {} }) {
  const port = (w) => !w.h && inBox(PORT, w.p[0], w.p[1]);
  const dir = (p, k0, k1) => { const dx = p[k1] - p[k0], dz = p[k1 + 1] - p[k0 + 1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  const grown = new Set();
  let joins = 0;
  for (let joined = true; joined;) {
    joined = false;
    for (const a of walls) {
      if (!port(a)) continue;
      const k = a.p.length, tx = a.p[k - 4], tz = a.p[k - 3];
      let best = null, bestD = JOIN_GAP;
      for (const b of walls) {
        if (b === a || !port(b)) continue;
        const gx = b.p[0] - tx, gz = b.p[1] - tz, gap = Math.hypot(gx, gz);
        if (gap >= bestD) continue;
        if (gap > 0.3) {
          const j = [gx / gap, gz / gap], u = dir(a.p, k - 8, k - 4), v = dir(b.p, 0, 4);
          if (u[0] * j[0] + u[1] * j[1] < 0.3 || v[0] * j[0] + v[1] * j[1] < 0.3) continue;
          // the low side of the gap, on its left
          const mx = (tx + b.p[0]) / 2, mz = (tz + b.p[1]) / 2;
          const low = dtm.sample(mx - j[1] * 2.5, mz + j[0] * 2.5);
          if (!(low <= Math.min(a.p[k - 2], b.p[2]) - QUAY_MIN)) continue;
        }
        best = b;
        bestD = gap;
      }
      if (!best) continue;
      a.p = [...a.p, ...best.p];
      walls.splice(walls.indexOf(best), 1);
      grown.delete(best);
      grown.add(a);
      joins++;
      joined = true;
      break;
    }
  }
  log(`port walls: ${joins} gaps of up to ${JOIN_GAP} m between them closed`);
  return grown;
}

// --- the port's buildings the LiDAR keeps as ground ---------------------------------------------------------------------

// The bare-earth LiDAR keeps as ground the port's buildings built into a slope under a terrace: the Aquarium, under its
// terraces at the Paseo Nuevo's level 12 m over the old port's square, and the stores under the west mole's walk. The 2 m
// grid smears their faces into banks standing 2-3 m in front of the facades. A building (ERAIKINA) in PORT whose edge
// falls EMBED_DROP or more on at least half its length is one of them: along its edges, wherever the LiDAR 1.5-4 m
// inside lies QUAY_MIN or more above the ground 2.5-5 m outside, a hidden wall (the terrain steps at the facade, which is
// the building's own: its extrusion's or its landmark's).
const EMBED_DROP = 3; // m

/**
 * dtm: the 1 m Grid. Returns hidden walls (h: every segment) round the port's embedded buildings.
 */
export function buildingFaces({ dtm, loadLayer, log = () => {} }) {
  const at = (x, z) => { const v = dtm.sample(x, z); return Number.isFinite(v) ? v : NaN; };
  const out = [];
  let buildings = 0;
  for (const f of loadLayer('c500_ERAIKINA.json').features) {
    const r = f.g[0];
    if (!r || r.length < 8) continue;
    let all = true;
    for (let k = 0; k < r.length; k += 2) all &&= inBox(PORT, r[k], r[k + 1]);
    if (!all) continue;
    // samples every half metre round the ring: { x, z, wall, deck, foot, ox, oz (outwards) }
    const pts = [];
    let embedded = 0;
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1], len = Math.hypot(bx - ax, bz - az);
      if (len < 1e-6) continue;
      let ox = (bz - az) / len, oz = -(bx - ax) / len;
      if (pointInRing((ax + bx) / 2 + ox * 0.2, (az + bz) / 2 + oz * 0.2, r)) { ox = -ox; oz = -oz; }
      const m = Math.max(1, Math.round(len / 0.5));
      for (let q = 0; q < m; q++) {
        const x = ax + ((bx - ax) * q) / m, z = az + ((bz - az) * q) / m;
        const side = (sg, ts) => ts.map((t) => at(x + sg * ox * t, z + sg * oz * t)).filter(Number.isFinite);
        const inside = side(-1, [1.5, 2, 2.5, 3, 3.5, 4]), outside = side(1, [2.5, 3, 3.5, 4, 4.5, 5]);
        const p = { x, z, wall: false, ox, oz };
        pts.push(p);
        if (inside.length < 3 || outside.length < 3) continue;
        const deck = median(inside), foot = Math.min(...outside);
        if (deck - median(outside) >= EMBED_DROP) embedded++;
        if (deck - foot >= QUAY_MIN) Object.assign(p, { wall: true, deck, foot });
      }
    }
    if (embedded < pts.length / 2) continue;
    buildings++;
    // runs round the ring (starting after a gap), walked with the outside on the left of travel (-dz, dx)
    const N = pts.length, start = pts.findIndex((p) => !p.wall);
    const runs = [];
    let cur = null;
    for (let q = 1; q <= N; q++) {
      const p = pts[(start + q) % N];
      if (cur && !p.wall) { runs.push(cur); cur = null; }
      if (p.wall) (cur ||= []).push(p);
    }
    if (cur) runs.push(cur);
    for (const run of runs) {
      if (run.length < 2 * QUAY_RUN) continue;
      const a = run[0], b = run[run.length - 1];
      const pts2 = -(b.z - a.z) * a.ox + (b.x - a.x) * a.oz > 0 ? run : [...run].reverse();
      const deck = smooth(pts2.map((p) => p.deck)), foot = smooth(pts2.map((p) => p.foot));
      const kept = simplify(pts2.map((p, k) => ({ x: p.x, z: p.z, deck: deck[k], foot: Math.min(foot[k], deck[k] - QUAY_MIN) })), 0.1);
      out.push({ t: WALL.quay, b: 0, p: kept.flatMap((p) => [p.x, p.z, p.deck, p.foot].map(r2)), h: [0, kept.length - 1] });
    }
  }
  log(`port buildings kept as ground: ${buildings}, ${out.length} hidden walls at their faces`);
  return out;
}

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

// A beach's edge drawn out round a rock and back to within NOTCH[0] of where it left, over NOTCH[1] to NOTCH[2] of edge
// (the rock ribs the map draws into the beach under the Pico del Loro's walk): the mouth instead. The profiles along the
// notch's sides would look along the wall rather than across it, and split its run in two. (Returns the ring itself
// where it has none.)
const NOTCH = [2.5, 8, 40]; // m
function dropNotches(r) {
  const n = r.length / 2;
  const at = (i) => [r[2 * (i % n)], r[2 * (i % n) + 1]];
  let perimeter = 0;
  for (let i = 0; i < n; i++) perimeter += Math.hypot(at(i + 1)[0] - at(i)[0], at(i + 1)[1] - at(i)[1]);
  const keep = new Uint8Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    const [ax, az] = at(i);
    let len = 0, cut = 0;
    for (let s = 1; s < n; s++) {
      const [px, pz] = at(i + s - 1), [qx, qz] = at(i + s);
      len += Math.hypot(qx - px, qz - pz);
      if (len > NOTCH[2] || len > perimeter / 3) break;
      if (len >= NOTCH[1] && Math.hypot(qx - ax, qz - az) < NOTCH[0]) cut = s;
    }
    for (let s = 1; s < cut; s++) keep[(i + s) % n] = 0;
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  return out.length >= 6 ? out : r;
}

/**
 * The shorelines to look along, in priority order: the edges of the municipal map's beaches; the OSM river & docks at
 * sea level (seaLevel(rings) decides, as build.mjs's water mask); the OSM coastline; the OSM breakwaters.
 */
export function shoreGuides({ loadLayer, osmPolygons, lonLatToLocal, seaLevel }) {
  const guides = [];
  // (each beach's edge without its notches, then as drawn, for the walls round them that no run claimed)
  const beaches = loadLayer('c500_HONDARTZA.json').features.flatMap((f) => f.g.filter((r) => r.length >= 6));
  const trimmed = beaches.map(dropNotches);
  for (const r of [...trimmed, ...beaches.filter((r, i) => trimmed[i] !== r)]) {
    guides.push({ pts: r, closed: true, beach: true, type: (x) => (x > 400 ? WALL.zurriola : WALL.concha) });
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
  // 1: stairs, kept half a metre clear; 2: buildings & bridges, where no wall may stand
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
    const half = (Number.parseFloat(t.width) > 0.5 ? Number.parseFloat(t.width) : 9) / 2 + 1;
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
  // half a metre round the stairs (built as steps, see detectStairs, which the wall runs up to) and round the buildings
  // (a wall may run up to a pavilion's side, not across its front)
  const near = (x, z, r, step, v) => {
    for (let b = -r; b <= r; b += step) for (let a = -r; a <= r; a += step) {
      const i = Math.floor(x + a - ext.minX), j = Math.floor(z + b - ext.minZ);
      if (i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] === v) return true;
    }
    return false;
  };
  return (x, z) => near(x, z, 0.5, 0.5, 1) || near(x, z, 0.5, 0.5, 2);
}
