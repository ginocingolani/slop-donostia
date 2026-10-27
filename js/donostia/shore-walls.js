// js/donostia/shore-walls.js
// The shore walls of tools/donostia/build.mjs (GEO.terrain.walls): La Concha's and Ondarreta's promenade walls, the Paseo
// Nuevo's sea wall round Urgull, the Urumea's quay walls and the port's. Plain JavaScript shared by the bake (Node) and
// the browser: build.mjs drops the cells in front of each wall to its foot with wallSnaps(), js/donostia/terrain.js
// moves the same samples onto the wall line so the 2 m terrain steps vertically at the wall, and js/donostia/shore.js
// faces it with masonry.
//
// A wall is { t: type, b: batter (m back per m up), p: [x, z, deck, foot, ...] }: its crest line (the top edge of the
// face) with, at each vertex, the level of the promenade behind (deck) and of the ground at its foot measured by the
// LiDAR (foot). The low side lies on the (-dz, dx) side of the direction of travel (dx, dz), as for the railing.

// A wall may carry h: [first, last + 1, ...], runs of its segments that are hidden: the terrain steps there as at any wall,
// but the masonry is a beach access's own (js/donostia/beach-access.js) and the railing never stands on it; see
// visibleWalls().
//
// Wall types (masonry): La Concha & Ondarreta's sandstone ashlar, the Paseo Nuevo's rubble with a parapet, the Urumea's
// dark quay walls, the port's dressed stone, Zurriola's concrete-and-stone promenade wall
export const WALL = { concha: 0, paseo: 1, river: 2, quay: 3, zurriola: 4 };
// How far the coping (js/donostia/shore.js) stands above the promenade on each type of wall (m): La Concha's railing
// stands on it; the Paseo Nuevo's is the parapet's
export const COPING = { [WALL.concha]: 0.14, [WALL.paseo]: 0.95, [WALL.river]: 0.16, [WALL.quay]: 0.05, [WALL.zurriola]: 0.08 };

// The walls with masonry: every wall split where it runs hidden (h), as { t, b, p } (shore.js draws these, the railing
// stands on them)
export function visibleWalls(walls) {
  const out = [];
  for (const w of walls) {
    if (!w.h || !w.h.length) { out.push(w); continue; }
    const n = w.p.length / 4;
    let k = 0;
    for (let r = 0; r <= w.h.length; r += 2) {
      const end = r < w.h.length ? w.h[r] : n - 1; // visible segments k .. end - 1
      if (end > k) out.push({ t: w.t, b: w.b, p: w.p.slice(4 * k, 4 * (end + 1)) });
      if (r < w.h.length) k = w.h[r + 1];
    }
  }
  return out;
}

// Samples of a terrain grid this far from a wall line (m) are looked at: every sample within reach of a triangle that
// crosses the wall (a quad's diagonal) is moved onto it
const REACH = 3.2;
// The terrain's face sits this far behind the line (m), so the masonry of shore.js covers it without z-fighting
export const RECESS = 0.06;

// Segment list of every wall: [ax, az, bx, bz, wall index, vertex index, along (m from the wall's start), length]
function segments(walls) {
  const segs = [];
  walls.forEach((wall, wi) => {
    const p = wall.p;
    let along = 0;
    for (let k = 0; k + 4 < p.length; k += 4) {
      const len = Math.hypot(p[k + 4] - p[k], p[k + 5] - p[k + 1]);
      if (len > 1e-6) segs.push([p[k], p[k + 1], p[k + 4], p[k + 5], wi, k / 4, along, len]);
      along += len;
    }
  });
  return segs;
}

// The nearest point of any wall to (x, z) within maxDist: { wall, x, z, d (signed: + on the low side), nx, nz (towards
// the low side), deck, foot, t (0..1 along the segment), end (the projection falls on a wall's end vertex) } or null.
// index: an optional bucket index from wallIndex().
export function nearestWall(walls, x, z, maxDist, index = null) {
  const segs = index ? index.near(x, z) : segments(walls);
  let best = null, bestD = maxDist;
  for (const s of segs) {
    const [ax, az, bx, bz, wi, vi, , len] = s;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const t = ((x - ax) * dx + (z - az) * dz) / len;
    const tc = Math.max(0, Math.min(1, t));
    const px = ax + (bx - ax) * tc, pz = az + (bz - az) * tc;
    const d = Math.hypot(x - px, z - pz);
    if (d >= bestD) continue;
    const p = walls[wi].p, k = 4 * vi;
    const n = p.length / 4;
    bestD = d;
    best = {
      wall: wi, x: px, z: pz, nx: -dz, nz: dx, d: (x - px) * -dz + (z - pz) * dx,
      deck: p[k + 2] + (p[k + 6] - p[k + 2]) * tc, foot: p[k + 3] + (p[k + 7] - p[k + 3]) * tc, t: tc,
      end: (t <= 0 && vi === 0) || (t >= 1 && vi === n - 2)
    };
  }
  return best;
}

// Bucket index of the wall segments (cell metres) for nearestWall within `pad` metres
export function wallIndex(walls, cell = 16, pad = REACH) {
  const buckets = new Map();
  for (const s of segments(walls)) {
    const [ax, az, bx, bz] = s;
    const i0 = Math.floor((Math.min(ax, bx) - pad) / cell), i1 = Math.floor((Math.max(ax, bx) + pad) / cell);
    const j0 = Math.floor((Math.min(az, bz) - pad) / cell), j1 = Math.floor((Math.max(az, bz) + pad) / cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const key = j * 65536 + i;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(s);
    }
  }
  const none = [];
  return { near: (x, z) => buckets.get(Math.floor(z / cell) * 65536 + Math.floor(x / cell)) || none };
}

// The samples of a terrain grid { x0, z0, w, h, res } (samples at cell centres) that the walls move. Every sample that
// shares a triangle (the terrain's quads split along the (i+1, j)-(i, j+1) diagonal, js/donostia/terrain.js) with a sample
// on the other side of a wall line goes onto the line: the low side's onto the foot of the face (behind the crest line
// by the batter), the high side's onto the crest. Returns Map(sample index -> { side: +1 low / -1 high, x, z (where
// it goes), wall, deck, foot }); `sides` (Int8Array, optional) receives the side of every sample within reach of a wall.
export function wallSnaps(walls, grid, sides = null) {
  const { x0, z0, w, h, res } = grid;
  const index = wallIndex(walls);
  const near = new Map(); // sample -> nearest wall point
  for (const s of segments(walls)) {
    const [ax, az, bx, bz] = s;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH - x0) / res - 0.5));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + REACH - x0) / res - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - REACH - z0) / res - 0.5));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + REACH - z0) / res - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * w + i;
      if (near.has(k)) continue;
      const q = nearestWall(walls, x0 + (i + 0.5) * res, z0 + (j + 0.5) * res, REACH, index);
      near.set(k, q);
    }
  }
  const sideOf = (k) => {
    const q = near.get(k);
    return q && !q.end ? (q.d > 0 ? 1 : -1) : 0;
  };
  if (sides) for (const k of near.keys()) sides[k] = sideOf(k);
  const snaps = new Map();
  for (const [k, q] of near) {
    const side = sideOf(k);
    if (!side) continue;
    const i = k % w, j = (k - i) / w;
    // the six neighbours a triangle shares with this sample
    const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
    let crosses = false;
    for (const [a, b] of nb) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const kk = jj * w + ii;
      const o = sideOf(kk);
      if (o === -side && near.get(kk).wall === q.wall) { crosses = true; break; }
    }
    if (!crosses) continue;
    snaps.set(k, { side, wall: q.wall, x: q.x, z: q.z, nx: q.nx, nz: q.nz, deck: q.deck, foot: q.foot });
  }
  return snaps;
}

// Where a snapped sample of height y goes: onto the crest line (high side) or down the battered face, which leans back
// `batter` m per m, to its own level (low side); RECESS behind the masonry either way
export function snapPosition(s, y, batter) {
  const out = (s.side > 0 ? batter * Math.max(0, s.deck - y) : 0) - RECESS;
  return [s.x + s.nx * out, s.z + s.nz * out];
}
