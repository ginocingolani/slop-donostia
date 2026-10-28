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

// A tunnel portal's face carries f: 1 (wallSnaps puts the samples it shares with another wall onto it, and those by its
// corners with the walls that run on from it onto the corner).
//
// A wall may carry h: [first, last + 1, ...], runs of its segments that are hidden: the terrain steps there as at any wall,
// but the masonry is a beach access's own (js/donostia/beach-access.js) or a tunnel portal's (js/donostia/tunnels.js) and
// the railing never stands on it; see visibleWalls().
//
// Wall types (masonry): La Concha & Ondarreta's sandstone ashlar, the Paseo Nuevo's rubble with a parapet, the Urumea's
// dark quay walls, the port's dressed stone, Zurriola's concrete-and-stone promenade wall, the gardens' retaining walls
// round the tunnels' portals (tools/donostia/tunnels.mjs)
export const WALL = { concha: 0, paseo: 1, river: 2, quay: 3, zurriola: 4, garden: 5 };
// How far the coping (js/donostia/shore.js) stands above the promenade on each type of wall (m): La Concha's railing
// stands on it; the Paseo Nuevo's is the parapet's
export const COPING = {
  [WALL.concha]: 0.14, [WALL.paseo]: 0.95, [WALL.river]: 0.16, [WALL.quay]: 0.05, [WALL.zurriola]: 0.08, [WALL.garden]: 0.3
};

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
      wall: wi, seg: vi, x: px, z: pz, nx: -dz, nz: dx, d: (x - px) * -dz + (z - pz) * dx,
      deck: p[k + 2] + (p[k + 6] - p[k + 2]) * tc, foot: p[k + 3] + (p[k + 7] - p[k + 3]) * tc, t: tc,
      end: (t <= 0 && vi === 0) || (t >= 1 && vi === n - 2)
    };
  }
  return best;
}

// The nearest point of each wall within maxDist of (x, z), as nearestWall's, nearest first
export function nearestWalls(walls, x, z, maxDist, index = null) {
  const segs = index ? index.near(x, z) : segments(walls);
  const best = new Map();
  for (const s of segs) {
    const [ax, az, bx, bz, wi, vi, , len] = s;
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    const t = ((x - ax) * dx + (z - az) * dz) / len;
    const tc = Math.max(0, Math.min(1, t));
    const px = ax + (bx - ax) * tc, pz = az + (bz - az) * tc;
    const dist = Math.hypot(x - px, z - pz);
    if (dist >= maxDist || dist >= (best.get(wi)?.dist ?? Infinity)) continue;
    const p = walls[wi].p, k = 4 * vi;
    const n = p.length / 4;
    best.set(wi, {
      wall: wi, seg: vi, x: px, z: pz, nx: -dz, nz: dx, d: (x - px) * -dz + (z - pz) * dx, dist,
      deck: p[k + 2] + (p[k + 6] - p[k + 2]) * tc, foot: p[k + 3] + (p[k + 7] - p[k + 3]) * tc, t: tc,
      end: (t <= 0 && vi === 0) || (t >= 1 && vi === n - 2)
    });
  }
  return [...best.values()].sort((a, b) => a.dist - b.dist);
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
// by the batter), the high side's onto the crest. A sample between two walls closer than a couple of cells (a quay
// below a raised walk, a flight's cheek and the quay's face) may share triangles across both, and goes onto the one
// with the taller step (the nearer one unless the other is STEP_PREFER taller): left off it, the triangle across that
// wall would stand as a fin square to it. Returns Map(sample index -> { side: +1 low / -1 high, x, z (where it goes),
// wall, deck, foot }); `sides` (Int8Array, optional) receives the side of every sample within reach of a wall (of the
// nearest).
export function wallSnaps(walls, grid, sides = null) {
  const { x0, z0, w, h, res } = grid;
  const index = wallIndex(walls);
  const near = new Map(); // sample -> the nearest point of each wall within reach, nearest first
  for (const s of segments(walls)) {
    const [ax, az, bx, bz] = s;
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - REACH - x0) / res - 0.5));
    const i1 = Math.min(w - 1, Math.ceil((Math.max(ax, bx) + REACH - x0) / res - 0.5));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - REACH - z0) / res - 0.5));
    const j1 = Math.min(h - 1, Math.ceil((Math.max(az, bz) + REACH - z0) / res - 0.5));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const k = j * w + i;
      if (near.has(k)) continue;
      near.set(k, nearestWalls(walls, x0 + (i + 0.5) * res, z0 + (j + 0.5) * res, REACH, index));
    }
  }
  // the side of a sample (+1 low, -1 high) of one wall's line, 0 beyond its ends or out of reach
  const sideOn = (k, wall) => {
    const q = near.get(k)?.find((o) => o.wall === wall);
    return q && !q.end ? (q.d > 0 ? 1 : -1) : 0;
  };
  if (sides) for (const [k, qs] of near) sides[k] = qs.length ? sideOn(k, qs[0].wall) : 0;
  // the six neighbours a triangle shares with a sample
  const nb = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
  const snaps = new Map();
  for (const [k, qs] of near) {
    const i = k % w, j = (k - i) / w;
    let pick = null, pickSide = 0;
    for (const q of qs) {
      const side = sideOn(k, q.wall);
      if (!side) continue;
      let crosses = false;
      for (const [a, b] of nb) {
        const ii = i + a, jj = j + b;
        if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
        if (sideOn(jj * w + ii, q.wall) === -side) { crosses = true; break; }
      }
      if (!crosses) continue;
      // (by a tunnel portal's face, f, where a courtyard's walls meet it square: a sample in front of both goes onto the
      // face, else, left off it, it draws a ramp from the face's top down across the opening's flank; a sample behind
      // the other wall stays behind it, up)
      const face = pick && (walls[q.wall].f || walls[pick.wall].f);
      const better = !pick || (face ? (side !== pickSide ? side < pickSide : !!walls[q.wall].f) :
        q.deck - q.foot > pick.deck - pick.foot + STEP_PREFER);
      if (better) { pick = q; pickSide = side; }
    }
    if (!pick) continue;
    const q = pick;
    snaps.set(k, { side: pickSide, wall: q.wall, seg: q.seg, x: q.x, z: q.z, nx: q.nx, nz: q.nz, deck: q.deck, foot: q.foot, back: 0 });
  }
  // Where a tunnel portal's face and a wall that runs on from it share an end, no terrain edge may join a sample on one
  // to a sample on the other: it cut across the corner, and the triangle under it stood in front of the masonry as a
  // blade. The samples on either within a cell of the corner go onto the corner itself (on their own side: the top or
  // the foot, behind both faces), and then, while two neighbours on the two walls remain, the nearer the corner of them
  for (const c of faceCorners(walls)) {
    const toCorner = (s) => Object.assign(s, { x: c.x, z: c.z, nx: c.nx, nz: c.nz, deck: c.deck, foot: c.foot, back: RECESS, corner: true });
    const mine = [...snaps].filter(([, s]) => (s.wall === c.a || s.wall === c.b) && Math.hypot(s.x - c.x, s.z - c.z) < 3 * res);
    for (const [, s] of mine) if (Math.hypot(s.x - c.x, s.z - c.z) < res) toCorner(s);
    for (let moved = true, pass = 0; moved && pass < 8; pass++) {
      moved = false;
      for (const [k, s] of mine) {
        if (s.corner) continue;
        const i = k % w, j = (k - i) / w;
        for (const [a, b] of nb) {
          const o = snaps.get((j + b) * w + i + a);
          if (!o || o.corner || o.wall === s.wall || (o.wall !== c.a && o.wall !== c.b)) continue;
          toCorner(Math.hypot(s.x - c.x, s.z - c.z) <= Math.hypot(o.x - c.x, o.z - c.z) ? s : o);
          moved = true;
          break;
        }
      }
    }
    // (and the samples that project beyond both walls' ends, which no wall moved: in front of a corner the hill's nose
    // stands out from, or behind one the courtyard turns in, the triangles from the corner's top or foot to them stood
    // out of the masonry: those next to the corner on its other side go onto it too). high: the side of the walls the
    // ground stands high on, the wedge between them where wall b runs off to wall a's high side
    const cr = (p, q) => p[0] * q[1] - p[1] * q[0];
    const wedge = cr(c.ua, c.ub);
    const inWedge = (dx, dz) => cr(c.ua, [dx, dz]) * wedge >= 0 && cr([dx, dz], c.ub) * wedge >= 0;
    const convex = c.ub[0] * c.na[0] + c.ub[1] * c.na[1] < 0;
    const ci = Math.round((c.x - x0) / res - 0.5), cj = Math.round((c.z - z0) / res - 0.5);
    for (let j = cj - 2; j <= cj + 2; j++) for (let i = ci - 2; i <= ci + 2; i++) {
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const k = j * w + i;
      if (snaps.has(k)) continue;
      const dx = x0 + (i + 0.5) * res - c.x, dz = z0 + (j + 0.5) * res - c.z;
      if (Math.hypot(dx, dz) > 1.5 * res) continue;
      const side = inWedge(dx, dz) === convex ? -1 : 1;
      let by = false;
      for (const [a, b] of nb) {
        const o = snaps.get((j + b) * w + i + a);
        if (o && o.corner && o.side === -side && Math.hypot(o.x - c.x, o.z - c.z) < 1e-6) by = true;
      }
      if (by) snaps.set(k, toCorner({ side, wall: c.a, seg: 0 }));
    }
  }
  // Where the line bends, the terrain's face between two samples on it (an edge of a triangle) is a chord of the bend,
  // which stands in front of the masonry where the line turns away from its low side: both samples go back by as much
  // (with a margin: they go back square to their own segments, the chord a little less at the bend), at most as far as
  // the coping covers
  for (const [k, s] of snaps) {
    const i = k % w, j = (k - i) / w;
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]]) {
      const ii = i + a, jj = j + b;
      if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
      const o = snaps.get(jj * w + ii);
      if (!o || s.corner || o.corner || o.wall !== s.wall || o.seg === s.seg) continue;
      const sag = chordSag(walls[s.wall].p, s, o);
      if (sag > 0) s.back = Math.max(s.back, Math.min(SAG_MAX, 1.5 * sag + RECESS));
    }
  }
  return snaps;
}

const SAG_MAX = 0.45; // m
const STEP_PREFER = 1; // m

// The corners where a tunnel portal's face (f) and another wall share an end vertex: [{ a, b (the walls), x, z, deck,
// foot (the face's there), nx, nz (towards the low side of both: the mean of their ends' normals), na (a's low side
// there), ua, ub (the ways a and b run off from the corner) }]
function faceCorners(walls) {
  const out = [];
  const endNormal = (p, v) => {
    const k = v === 0 ? 0 : p.length / 4 - 2;
    const dx = p[4 * k + 4] - p[4 * k], dz = p[4 * k + 5] - p[4 * k + 1], l = Math.hypot(dx, dz) || 1;
    return [-dz / l, dx / l];
  };
  // (the way a wall runs off from its end vertex v)
  const away = (p, v) => {
    const o = v === 0 ? 1 : p.length / 4 - 2;
    const dx = p[4 * o] - p[4 * v], dz = p[4 * o + 1] - p[4 * v + 1], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  walls.forEach((a, ai) => {
    if (!a.f) return;
    for (const va of [0, a.p.length / 4 - 1]) {
      const x = a.p[4 * va], z = a.p[4 * va + 1];
      walls.forEach((b, bi) => {
        if (bi === ai) return;
        for (const vb of [0, b.p.length / 4 - 1]) {
          if (Math.hypot(b.p[4 * vb] - x, b.p[4 * vb + 1] - z) > 0.05) continue;
          const na = endNormal(a.p, va), nb = endNormal(b.p, vb);
          const nx = na[0] + nb[0], nz = na[1] + nb[1], l = Math.hypot(nx, nz) || 1;
          out.push({
            a: ai, b: bi, x, z, deck: a.p[4 * va + 2], foot: a.p[4 * va + 3], nx: nx / l, nz: nz / l, na,
            ua: away(a.p, va), ub: away(b.p, vb)
          });
        }
      });
    }
  });
  return out;
}

// How far the chord between two points on a wall line (on segments s.seg & o.seg) stands in front of the vertices
// between them (on the low side)
function chordSag(p, s, o) {
  const [u, v] = s.seg < o.seg ? [s, o] : [o, s];
  const dx = v.x - u.x, dz = v.z - u.z, l = Math.hypot(dx, dz);
  if (l < 1e-6) return 0;
  let sag = 0;
  for (let k = u.seg + 1; k <= v.seg; k++) {
    // (the vertex's side of the chord: negative, the chord passes in front of it)
    const d = ((p[4 * k] - u.x) * -dz + (p[4 * k + 1] - u.z) * dx) / l;
    if (-d > sag) sag = -d;
  }
  return sag;
}

// Where a snapped sample of height y goes: onto the crest line (high side) or down the battered face, which leans back
// `batter` m per m, to its own level (low side); RECESS behind the masonry either way (and further back at a bend)
export function snapPosition(s, y, batter) {
  const out = (s.side > 0 ? batter * Math.max(0, s.deck - y) : 0) - RECESS - (s.back || 0);
  return [s.x + s.nx * out, s.z + s.nz * out];
}
