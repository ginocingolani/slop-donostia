// tools/donostia/tunnels.mjs
// The tunnels' portals and the retaining walls round them, for tools/donostia/build.mjs, which steps the terrain at
// them (GEO.terrain.walls) and writes the portals to js/donostia/data-tunnels.js (built by js/donostia/tunnels.js).
//
// The bare-earth LiDAR keeps the hill over a tunnel and nothing of its bore. Where a road runs into the hill it has the
// portal's face, often ten metres of masonry, as a step a metre or two wide, which the 2 m terrain grid smears into a
// slope over the end of the road; so it does the retaining walls of the cutting in front, and the ground paints its
// paving down those slopes in long streaks. Here every OpenStreetMap way in a tunnel through the ground (tunnel=yes;
// not a passage under a building, which the bare-earth LiDAR leaves level) is followed out of each end until the LiDAR
// over it rises from the road's level to the hill's and stays up: the portal's face is where that rise is half done,
// traced across the bore's width and on either side while the step holds, and fitted with a straight line. The face
// stands as a hidden wall (js/donostia/shore-walls.js: the terrain steps vertically there, the masonry is the portal's
// own). Ways that share a bore (a road and its bike lane) share an opening; twin bores whose faces meet share one face.
// Round each portal the municipal map's walls (HORMA) stand as retaining walls wherever the LiDAR steps across their
// outline (WALL.garden: masonry under a coping, js/donostia/shore.js), and the one that reaches a portal's end runs on
// to meet its face.

import { WALL, nearestWall } from '../../js/donostia/shore-walls.js';
import { smooth, simplify } from './walls.mjs';
import { pointInRing as pointIn } from './lib.mjs';

// The ways in a tunnel through the ground: roads, paths & railways (not the ones under construction or proposed, nor a
// passage under a building, a covered way, a culvert)
const ROAD = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary',
  'secondary_link', 'tertiary', 'tertiary_link', 'unclassified', 'residential', 'living_street', 'service', 'busway']);
const PATH = new Set(['cycleway', 'footway', 'pedestrian', 'path', 'bridleway', 'steps']);
const RAIL = new Set(['rail', 'narrow_gauge', 'light_rail', 'subway']);
// The portals built in stone, by the ways' OSM ids (the others, the bypass's, Lugaritz's, the railways', are concrete):
// the Miramar tunnel (1890, under the palace's gardens; the road and its bike lane) in the cream limestone ashlar of the
// 1890 engraving and the photographs, a voussoir ring round its arch; the Pico del Loro's footway (Loretopeko tunela)
// in the red sandstone of Miramar's garden walls, a concrete ring round its arch
export const STONE = { limestone: 0, sandstone: 1, concrete: 2 };
const STONE_WAYS = new Map([[23920623, STONE.limestone], [35804363, STONE.limestone], [177708251, STONE.sandstone]]);

const PORTAL_MIN = 3; // m: the least rise from the road to the ground over the bore
const RISE = 4; // m along the way over which that rise must happen (the face, smeared over the LiDAR's 1 m cells)
const COVER = 6; // m: the ground stays up over the bore this far in
const S_OUT = 12, S_IN = 30; // m out of and into the way's end, searched for the face
const FLANK = 8; // m: how far beyond the opening's sides the face is traced
const FLANK_STEP = 1.4; // m: the least step that carries the face on beside the opening
const FLANK_FOOT = 1.5; // m: the most the ground in front of the face beside the opening may stand off the road's level
const ABUT = 2; // m: the least face either side of an opening
const ABUT_MIN = 1.2; // m: the least left where a retaining wall meets the face
const SHIFT_MAX = 1; // m an opening may move along its face to leave that
const FACE_FIT = 0.8; // m: a traced point this far off the fitted line ends the face
const MERGE_GAP = 2.5; // m: the most between the openings of a road and a path beside it in one bore

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((p, q) => p - q);
  return s.length ? s[s.length >> 1] : NaN;
};
const r2 = (v) => Math.round(v * 100) / 100;

// The width of a bore (m) for a way: its width tag, else its lanes', a path's, a railway's tracks'
function boreWidth(t) {
  const w = Number.parseFloat(t.width);
  if (w > 1) return w;
  if (RAIL.has(t.railway)) return Number.parseInt(t.tracks, 10) >= 2 ? 8.5 : 5; // (a way a track: two in a bore merge)
  if (t.highway === 'cycleway') return 2.6;
  if (PATH.has(t.highway)) return 3.6;
  const lanes = Number.parseInt(t.lanes, 10) || (t.oneway === 'yes' ? (t.highway?.startsWith('motorway') ? 2 : 1) : 2);
  return lanes * 3.3 + 1;
}

// OSM tunnel ways in the core, joined into chains at shared ends: [{ ids, pts: [[x, z], ...], tags, kind, stone }]
function tunnelChains(loadLayer, lonLatToLocal, core) {
  const ways = [];
  for (const e of loadLayer('osm_streets.json').elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !e.geometry || e.geometry.length < 2) continue;
    if (!t.tunnel || ['no', 'building_passage', 'covered', 'culvert'].includes(t.tunnel)) continue;
    const kind = ROAD.has(t.highway) ? 'road' : PATH.has(t.highway) ? 'path' : RAIL.has(t.railway) ? 'rail' : null;
    if (!kind) continue;
    const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
    if (!pts.some(([x, z]) => x > core.minX && x < core.maxX && z > core.minZ && z < core.maxZ)) continue;
    ways.push({ ids: [e.id], pts, tags: t, kind, stone: STONE_WAYS.get(e.id) ?? STONE.concrete });
  }
  // (a tunnel mapped in pieces: a way that ends where another of the same kind starts or ends goes on as one chain)
  const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.5;
  for (let joined = true; joined;) {
    joined = false;
    for (const a of ways) {
      const b = ways.find((o) => o !== a && o.kind === a.kind && boreWidth(o.tags) === boreWidth(a.tags) &&
        (same(o.pts[0], a.pts[a.pts.length - 1]) || same(o.pts[o.pts.length - 1], a.pts[a.pts.length - 1])));
      if (!b) continue;
      const tail = same(b.pts[0], a.pts[a.pts.length - 1]) ? b.pts : [...b.pts].reverse();
      a.pts = [...a.pts, ...tail.slice(1)];
      a.ids.push(...b.ids);
      ways.splice(ways.indexOf(b), 1);
      joined = true;
      break;
    }
  }
  return ways;
}

// The length of a polyline, and the point `d` m back from its end (towards its start)
function backFromEnd(pts, d) {
  let left = d;
  for (let k = pts.length - 1; k > 0; k--) {
    const [ax, az] = pts[k], [bx, bz] = pts[k - 1], l = Math.hypot(bx - ax, bz - az);
    if (l >= left) return [ax + ((bx - ax) * left) / l, az + ((bz - az) * left) / l];
    left -= l;
  }
  return pts[0];
}
const lengthOf = (pts) => pts.reduce((s, p, k) => (k ? s + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);

/**
 * The face of the portal at one end of a chain, or null where the ground does not rise over it (an end under a building,
 * on a bridge, at the core's edge). pts: the chain's points, ending at the portal's end; w: the bore's width. Returns
 * { ex, ez (the way's end), ux, uz (out of the bore), w, floor, deck, s (the face's place along the axis, m out of the
 * end), trace: [{ t (across, m along (-uz, ux)), s, deck (the ground behind), foot (in front) }] }.
 */
function portalFace(dtm, pts, w) {
  const [ex, ez] = pts[pts.length - 1];
  const len = lengthOf(pts);
  const [bx, bz] = backFromEnd(pts, Math.min(6, len / 2));
  const l = Math.hypot(ex - bx, ez - bz);
  if (l < 1) return null;
  const ux = (ex - bx) / l, uz = (ez - bz) / l, nx = -uz, nz = ux;
  const h = (s, t) => dtm.sample(ex + ux * s + nx * t, ez + uz * s + nz * t);
  // the LiDAR over the axis, the median across the bore's width
  const across = [];
  for (let t = -w / 2 + 0.5; t <= w / 2 - 0.5 + 1e-9; t += 1) across.push(t);
  if (!across.length) across.push(0);
  const H = (s) => median(across.map((t) => h(s, t)));
  // going in from outside: the first place where the ground rises PORTAL_MIN within RISE and stays up over COVER (and
  // the face on this end's half of a short tunnel)
  for (let s = S_OUT; s >= Math.max(-S_IN + RISE + COVER, RISE - len / 2); s -= 0.5) {
    const foot = H(s), top = H(s - RISE);
    if (!(top - foot >= PORTAL_MIN)) continue;
    let held = true;
    for (let c = s - RISE; c >= s - RISE - COVER && held; c -= 1) held = H(c) >= foot + PORTAL_MIN - 1;
    if (!held) continue;
    // (the road outside is level with the foot for a few metres: not a slope down from a hillside)
    const out = [1, 2, 3].map((d) => H(s + d));
    if (out.some((v) => !(Math.abs(v - foot) < 1))) continue;
    const floor = median([foot, ...out]);
    // the top of the rise: where it eases to under 1 in 4 (the ground over the bore), PORTAL_MIN or more up
    let top0 = s - RISE;
    for (let c = s - 0.5; c >= s - RISE - COVER; c -= 0.25) {
      if (H(c) - floor >= PORTAL_MIN && H(c - 1) - H(c) < 0.25) { top0 = c; break; }
    }
    const deck = median([0, 0.5, 1, 1.5].map((d) => H(top0 - d)));
    // where the rise is half done
    const mid = (floor + deck) / 2;
    let face = (s + top0) / 2;
    for (let c = s; c >= top0; c -= 0.1) if (H(c) >= mid) { face = c; break; }
    // the face across the bore and beside it: at each offset the rise's half way within 4 m of the axis's
    const trace = [];
    const at = (t) => {
      const lo = h(face + 3, t), hi = median([3, 3.5, 4].map((d) => h(face - d, t)));
      if (!(hi - lo >= (Math.abs(t) <= w / 2 ? PORTAL_MIN / 2 : FLANK_STEP))) return null;
      const m = (lo + hi) / 2;
      for (let c = face + 4; c >= face - 4; c -= 0.1) {
        if (h(c, t) >= m) return { t, s: c, deck: hi, foot: lo };
      }
      return null;
    };
    for (let t = -w / 2 - FLANK; t <= w / 2 + FLANK + 1e-9; t += 0.5) {
      const q = at(t);
      if (q) trace.push(q);
    }
    return { ex, ez, ux, uz, w, floor, deck, s: face, trace };
  }
  return null;
}

// Least-squares line s = a + b t through the trace's points within |t| <= half
function fitFace(trace, half) {
  const P = trace.filter((q) => Math.abs(q.t) <= half);
  if (P.length < 3) return null;
  let st = 0, ss = 0, stt = 0, sts = 0;
  for (const q of P) { st += q.t; ss += q.s; stt += q.t * q.t; sts += q.t * q.s; }
  const n = P.length, det = n * stt - st * st;
  const b = det > 1e-9 ? (n * sts - st * ss) / det : 0, a = (ss - b * st) / n;
  return { a, b };
}

const SPRING = { road: 1.6, path: 2.2, rail: 2.2 }; // m: an arch's springing over the floor, a road's, a path's, a railway's
const RING_MIN = 0.45, RING_MAX = 0.9; // m: the arch ring's depth (voussoirs, or the concrete surround)
const HEAD = 0.4; // m of face over the ring, under the coping

/**
 * dtm: the 1 m Grid; loadLayer, lonLatToLocal (lib.mjs); core: the core extent; walls: the shore walls so far (no portal
 * stands within reach of one: the port's and the Paseo Nuevo's are theirs). Returns { walls (the portals' faces, hidden,
 * and the retaining walls round them, for GEO.terrain.walls), portals (js/donostia/data-tunnels.js) }.
 */
export function tunnelPortals({ dtm, loadLayer, lonLatToLocal, core, walls: shore = [], log = () => {} }) {
  const chains = tunnelChains(loadLayer, lonLatToLocal, core);
  // every end of every chain: its face, if the ground rises over it
  const ends = [];
  for (const ch of chains) {
    const w = boreWidth(ch.tags);
    const len = lengthOf(ch.pts);
    for (const pts of [ch.pts, [...ch.pts].reverse()]) {
      const [ex, ez] = pts[pts.length - 1];
      if (!(ex > core.minX + 20 && ex < core.maxX - 20 && ez > core.minZ + 20 && ez < core.maxZ - 20)) continue;
      const f = portalFace(dtm, pts, w);
      if (!f) continue;
      const fit = fitFace(f.trace, w / 2 + 1);
      if (!fit) continue;
      ends.push({ ...f, fit, chain: ch, len });
    }
  }
  // the face of each end: a straight line, from the fit at the opening's sides out to where the trace leaves it
  for (const e of ends) {
    const { a, b } = e.fit;
    const on = (q) => Math.abs(q.s - (a + b * q.t)) <= FACE_FIT;
    let t0 = -e.w / 2, t1 = e.w / 2;
    const byT = new Map(e.trace.map((q) => [Math.round(q.t * 2), q]));
    // (beside the opening, while the ground in front is the cutting's floor: not on along the top of a bank)
    const holds = (q) => q && on(q) && Math.abs(q.foot - e.floor) <= FLANK_FOOT;
    for (let t = -e.w / 2 - 0.5; t >= -e.w / 2 - FLANK; t -= 0.5) { if (!holds(byT.get(Math.round(t * 2)))) break; t0 = t; }
    for (let t = e.w / 2 + 0.5; t <= e.w / 2 + FLANK; t += 0.5) { if (!holds(byT.get(Math.round(t * 2)))) break; t1 = t; }
    // (an abutment either side of the opening however short the trace)
    t0 = Math.min(t0, -e.w / 2 - ABUT);
    t1 = Math.max(t1, e.w / 2 + ABUT);
    // the face's points in the plan: (t, s) -> (x, z)
    const point = (t) => {
      const s = a + b * t;
      return [e.ex + e.ux * s - e.uz * t, e.ez + e.uz * s + e.ux * t];
    };
    Object.assign(e, { t0, t1, A: point(t0), B: point(t1), C: point(0) });
  }
  // ends whose faces lie on one line, overlapping, are one portal (a road and its bike lane in one bore; bores side by
  // side): its face runs along the widest one's line over all of theirs
  const portals = [];
  const used = new Set();
  const byWidth = [...ends].sort((p, q) => q.w - p.w);
  for (const e of byWidth) {
    if (used.has(e)) continue;
    used.add(e);
    const [ax, az] = e.A, [bx, bz] = e.B, L = Math.hypot(bx - ax, bz - az);
    if (L < 1) continue;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const along = (x, z) => (x - ax) * dx + (z - az) * dz, off = (x, z) => -(x - ax) * dz + (z - az) * dx;
    const members = [e];
    for (const o of byWidth) {
      if (used.has(o)) continue;
      const odx = o.B[0] - o.A[0], odz = o.B[1] - o.A[1], ol = Math.hypot(odx, odz) || 1;
      const parallel = Math.abs((odx * dx + odz * dz) / ol) > 0.96;
      const onLine = Math.abs(off(...o.C)) < 2 && Math.abs(off(...o.A)) < 3 && Math.abs(off(...o.B)) < 3;
      const [p0, p1] = [along(...o.A), along(...o.B)].sort((p, q) => p - q);
      // (or two bores side by side whose faces the LiDAR traced at different skews, crossing: twin tracks)
      const side = Math.hypot(o.C[0] - e.C[0], o.C[1] - e.C[1]) < (o.w + e.w) / 2 + MERGE_GAP && o.ux * e.ux + o.uz * e.uz > 0.8 &&
        Math.abs(off(...o.C)) < 3;
      if (((parallel && onLine) || side) && p1 > -MERGE_GAP && p0 < L + MERGE_GAP) { members.push(o); used.add(o); }
    }
    // (no portal where a shore wall already stands: the port's quays, the Aquarium's and the Paseo Nuevo's portals)
    let u0 = 0, u1 = L;
    for (const m of members) for (const p of [m.A, m.B]) { u0 = Math.min(u0, along(...p)); u1 = Math.max(u1, along(...p)); }
    let clash = false;
    for (let u = u0; u <= u1 && !clash; u += 1) clash = nearestWall(shore, ax + dx * u, az + dz * u, 2) !== null;
    if (clash) continue;
    portals.push({ members, ax, az, dx, dz, u0, u1 });
  }
  // each portal's openings (those of its ways, merged where they meet), levels and the face's line
  const out = [], walls = [];
  for (const P of portals) {
    const { ax, az, dx, dz } = P;
    const along = (x, z) => (x - ax) * dx + (z - az) * dz;
    let openings = P.members.map((m) => {
      const c = along(...m.C);
      return { u0: c - m.w / 2, u1: c + m.w / 2, floor: m.floor, deck: m.deck, ux: -m.ux, uz: -m.uz, len: m.len, kind: m.chain.kind };
    }).sort((p, q) => p.u0 - q.u0);
    for (let k = openings.length - 1; k > 0; k--) {
      const a = openings[k - 1], b = openings[k];
      // (a road and the path beside it share one arch, twin carriageways or tracks have one each)
      if (b.u0 - a.u1 > (a.kind === 'path' || b.kind === 'path' ? MERGE_GAP : 0.5)) continue;
      openings.splice(k - 1, 2, {
        ...(a.u1 - a.u0 >= b.u1 - b.u0 ? a : b), u0: Math.min(a.u0, b.u0), u1: Math.max(a.u1, b.u1),
        floor: Math.min(a.floor, b.floor), deck: Math.min(a.deck, b.deck), len: Math.max(a.len, b.len)
      });
    }
    // the face's levels along it: the traced ground behind it (deck) and in front (foot), over the openings their own
    const trace = P.members.flatMap((m) => m.trace.map((q) => {
      const s = m.fit.a + m.fit.b * q.t;
      return { u: along(m.ex + m.ux * s - m.uz * q.t, m.ez + m.uz * s + m.ux * q.t), deck: q.deck, foot: q.foot };
    }));
    const local = (u, key) => median(trace.filter((q) => Math.abs(q.u - u) <= 1.5).map((q) => q[key]));
    const us = new Set([P.u0, P.u1]);
    for (const o of openings) { us.add(Math.max(P.u0, o.u0 - 0.6)); us.add(Math.min(P.u1, o.u1 + 0.6)); }
    for (let u = P.u0 + 2; u < P.u1 - 1; u += 2) if (!openings.some((o) => u > o.u0 - 1 && u < o.u1 + 1)) us.add(u);
    const verts = [...us].sort((p, q) => p - q).map((u) => {
      const o = openings.find((q) => u >= q.u0 - ABUT - 0.2 && u <= q.u1 + ABUT + 0.2);
      const deck = o ? o.deck : local(u, 'deck'), foot = o ? o.floor : local(u, 'foot');
      return { u, deck: Number.isFinite(deck) ? deck : openings[0].deck, foot: Number.isFinite(foot) ? foot : openings[0].floor };
    });
    // the arches: a springing over the floor, a semicircle where the face is tall enough, else a segment under the head
    const arch = openings.map((o) => {
      const span = o.u1 - o.u0, ring = Math.min(RING_MAX, Math.max(RING_MIN, 0.06 * span));
      const spring = SPRING[o.kind];
      const crownMax = o.deck - o.floor - ring - HEAD;
      const rise = Math.max(0.6, Math.min(span / 2, crownMax - spring));
      return [o.u0, o.u1, o.floor, spring, rise, ring, o.ux, o.uz, o.len].map(r2);
    });
    // walked with the low side (the road) on the left of travel, as every wall
    const low = P.members[0];
    const leftX = -dz, leftZ = dx;
    const flip = leftX * low.ux + leftZ * low.uz < 0;
    const seq = flip ? [...verts].reverse() : verts;
    const p = seq.flatMap((v) => [ax + dx * v.u, az + dz * v.u, v.deck, v.foot].map(r2));
    out.push({
      p, k: Math.min(...P.members.map((m) => m.chain.stone)),
      // (the openings measured along the face as walked)
      o: arch.map(([u0, u1, ...rest]) => (flip ? [r2(P.u1 - u1), r2(P.u1 - u0)] : [r2(u0 - P.u0), r2(u1 - P.u0)]).concat(rest)),
      ids: [...new Set(P.members.flatMap((m) => m.chain.ids))]
    });
    walls.push({ t: WALL.garden, b: 0, p, h: [0, seq.length - 1], f: 1 });
  }
  log(`tunnels: ${chains.length} ways in tunnels in the core, ${ends.length} ends where the ground rises over them, ` +
    `${out.length} portals (${out.reduce((s, q) => s + q.o.length, 0)} openings)`);
  const retaining = retainingWalls({ dtm, loadLayer, faces: walls, portals: out, shore, log });
  // each face's ends that a retaining wall runs on from (js/donostia/tunnels.js stands a pier in the corner): the wall's
  // way from there, or 0
  out.forEach((P, i) => {
    const f = walls[i].p, n = f.length / 4;
    P.e = [0, n - 1].map((v) => {
      for (const w of retaining) {
        const m = w.p.length / 4;
        for (const [a, b] of [[0, 1], [m - 1, m - 2]]) {
          if (Math.hypot(w.p[4 * a] - f[4 * v], w.p[4 * a + 1] - f[4 * v + 1]) > 0.05) continue;
          const dx = w.p[4 * b] - w.p[4 * a], dz = w.p[4 * b + 1] - w.p[4 * a + 1], l = Math.hypot(dx, dz) || 1;
          return [r2(dx / l), r2(dz / l)];
        }
      }
      return 0;
    });
  });
  return { portals: out, walls: [...walls, ...retaining] };
}

// --- the retaining walls round the portals --------------------------------------------------------------------------

// The municipal map's walls (HORMA) near a portal: the cutting's sides, the walk's under the gardens, the courtyards in
// front of the Pico del Loro's footway. Each outline is walked every half metre, the LiDAR 1.5-3.5 m either side
// telling which side is low: where the ground outside the outline lies STEP_MIN or more below the ground beyond its other
// side and is level (a walk, a road, a courtyard) or falls away from it (the wooded bank under the garden's wall over
// the Miramar tunnel's east approach: the face then goes on down to the bank's foot, a road's level within 5 m), the
// outline's edge is the wall's face, provided its foot lies about the level of the nearest portal's road (FOOT: not the
// sea walls and the beaches' stairs down from the same walks). Runs of RUN_MIN or more become walls (WALL.garden), each
// walked with the low side on its left; of two runs along one wall (a thick wall's outline, a coping drawn beside it,
// overlapping features) the one with more level ground in front stands, and one over a bank gives way to a wall that
// holds the bank's foot in front of it. Walls that meet are joined, and one that ends within JOIN of a portal's face's
// end runs on to it, so the terrain steps all along.
const NEAR = 45; // m from a portal's face
const STEP_MIN = 1.4; // m
const LEVEL = 0.8; // m: the most the ground in front may vary
const FOOT = [-1.5, 6]; // m about the nearest portal's floor
const RUN_MIN = 2; // m
const TWIN = 2.2; // m: two runs this close are one wall
const BANK = 5.5; // m: the reach of a bank's foot in front of a wall
const JOIN = 4.5; // m

function retainingWalls({ dtm, loadLayer, faces, portals, shore, log }) {
  const at = (x, z) => { const v = dtm.sample(x, z); return Number.isFinite(v) ? v : NaN; };
  const segs = [];
  for (const f of faces) for (let k = 0; k + 4 < f.p.length; k += 4) segs.push([f.p[k], f.p[k + 1], f.p[k + 4], f.p[k + 5], f.p[k + 3]]);
  // the distance to the nearest portal's face, and that portal's road level
  const toFace = (x, z) => {
    let d = Infinity, floor = NaN;
    for (const [ax, az, bx, bz, f] of segs) {
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
      const e = Math.hypot(x - ax - t * dx, z - az - t * dz);
      if (e < d) { d = e; floor = f; }
    }
    return [d, floor];
  };
  const candidates = [];
  for (const f of loadLayer('c500_HORMA.json').features) {
    for (const r of f.g) {
      const n = r.length / 2;
      if (n < 3) continue;
      let close = false;
      for (let k = 0; k < r.length && !close; k += 2) close = toFace(r[k], r[k + 1])[0] < NEAR;
      if (!close) continue;
      // samples every half metre round the outline: { x, z, wall, deck, foot, level, ox, oz (outwards) }
      const pts = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1], len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-6) continue;
        let ox = (bz - az) / len, oz = -(bx - ax) / len;
        if (pointIn((ax + bx) / 2 + ox * 0.05, (az + bz) / 2 + oz * 0.05, r)) { ox = -ox; oz = -oz; }
        const m = Math.max(1, Math.round(len / 0.5));
        for (let q = 0; q < m; q++) {
          const x = ax + ((bx - ax) * q) / m, z = az + ((bz - az) * q) / m;
          const p = { x, z, wall: false, ox, oz };
          pts.push(p);
          // (not on a portal's own face, nor along a shore wall)
          const [d, floor] = toFace(x, z);
          if (d < 1.2 || nearestWall(shore, x, z, 1.5)) continue;
          const side = (sg, ts) => ts.map((t) => at(x + sg * ox * t, z + sg * oz * t)).filter(Number.isFinite);
          const low = side(1, [1.5, 2, 2.5, 3]), back = side(-1, [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
          if (low.length < 4 || back.length < 8) continue;
          // behind: the crest, where the rise eases off (under 1 in 2) a metre or more back (the LiDAR's smear of the
          // face), its level the wall's top (or 1.5 m back, under a bank that goes on rising); the bank stays the
          // terrain's
          let deck = back[2];
          for (let k = 1; k + 1 < back.length; k++) if (back[k + 1] - back[k] < 0.25) { deck = back[k]; break; }
          // in front: level (a walk, a road, a courtyard), or a bank falling away from the wall's foot: the face then
          // goes on down to the road's level at the bank's foot, the bank before it levelled (the 2 m grid makes a
          // sawtooth of a bank a cell or two wide between a wall and a road)
          const level = Math.max(...low) - Math.min(...low) <= LEVEL;
          const falling = low.every((v, k) => k === 0 || v <= low[k - 1] + 0.05);
          let foot = median(low);
          if (!level) {
            // (down the bank while it falls, short of a drop off another wall: a walk's sea wall)
            const down = side(1, [1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
            foot = down[0];
            for (let k = 1; k < down.length && down[k] <= down[k - 1] + 0.05 && down[k - 1] - down[k] < 1.5; k++) foot = down[k];
          }
          if (deck - foot >= STEP_MIN && (level || falling) && foot >= floor + FOOT[0] && foot <= floor + FOOT[1]) {
            Object.assign(p, { wall: true, deck, foot, level });
          }
        }
      }
      // runs round the outline (starting after a gap), walked with the low side on the left of travel (-dz, dx)
      const N = pts.length, start = pts.findIndex((p) => !p.wall);
      let cur = null;
      for (let q = 1; q <= N; q++) {
        const p = pts[(start + q + N) % N];
        if (cur && !p.wall) { candidates.push(cur); cur = null; }
        if (p.wall) (cur ||= []).push(p);
      }
      if (cur) candidates.push(cur);
    }
  }
  // the runs with level ground in front first, then the longer
  const runs = candidates.map((run) => ({ run, level: run.filter((p) => p.level).length / run.length }))
    .filter(({ run }) => (run.length - 1) * 0.5 >= RUN_MIN)
    .sort((a, b) => b.level - a.level || b.run.length - a.run.length);
  // (each run without its samples along a wall kept already, in the pieces left)
  const out = [], kept = [];
  let twins = 0;
  const pieces = [];
  for (const { run } of runs) {
    let cur = [];
    const flush = () => { if ((cur.length - 1) * 0.5 >= RUN_MIN) { pieces.push(cur); kept.push(...cur); } cur = []; };
    for (const p of run) {
      // (a wall over a bank stands only where no wall found already holds the bank's foot in front of it)
      const twin = kept.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < TWIN ||
        (!p.level && (q.x - p.x) * p.ox + (q.z - p.z) * p.oz > 0 && Math.hypot(p.x - q.x, p.z - q.z) < BANK));
      if (twin) { twins++; flush(); } else cur.push(p);
    }
    flush();
  }
  for (const run of pieces) {
    const a = run[0], b = run[run.length - 1];
    const seq = -(b.z - a.z) * a.ox + (b.x - a.x) * a.oz > 0 ? run : [...run].reverse();
    const deck = smooth(seq.map((p) => p.deck)), foot = smooth(seq.map((p) => p.foot));
    const line = simplify(seq.map((p, k) => ({ x: p.x, z: p.z, deck: deck[k], foot: Math.min(foot[k], deck[k] - STEP_MIN) })), 0.1);
    out.push({ t: WALL.garden, b: 0, p: line.flatMap((p) => [p.x, p.z, p.deck, p.foot].map(r2)) });
  }
  // two that meet, one ending within JOIN of where the other starts, going on the same way, are one wall
  const dir = (p, k0, k1) => { const dx = p[k1] - p[k0], dz = p[k1 + 1] - p[k0 + 1], l = Math.hypot(dx, dz) || 1; return [dx / l, dz / l]; };
  for (let again = true; again;) {
    again = false;
    for (const a of out) {
      const k = a.p.length;
      const b = out.find((o) => {
        if (o === a) return false;
        const gx = o.p[0] - a.p[k - 4], gz = o.p[1] - a.p[k - 3], gap = Math.hypot(gx, gz);
        if (gap > JOIN) return false;
        const u = dir(a.p, k - 8, k - 4), v = dir(o.p, 0, 4);
        return u[0] * v[0] + u[1] * v[1] > 0.3;
      });
      if (!b) continue;
      a.p = [...a.p, ...b.p];
      out.splice(out.indexOf(b), 1);
      again = true;
      break;
    }
  }
  // a retaining wall that ends by a portal's face's end runs on to it, the two meeting where their lines cross (the
  // face's end moved there, along its line: a square corner, not a wall slanting back to the face's end in the hill),
  // the face's levels there. First each wall's end finds its face's end (ahead of it, the way it goes at that end; each
  // face's end once), then each face takes its new ends, its openings moved along where they would come within ABUT_MIN
  // of one (the courtyard's walls framing the opening); where they cannot be, that end stays and the wall runs on to it
  // as it is
  const asks = [];
  const taken = new Set();
  for (const w of out) {
    for (const head of [true, false]) {
      const k = head ? 0 : w.p.length - 4;
      const [ux, uz] = head ? dir(w.p, 4, 0) : dir(w.p, k - 4, k);
      const W = [w.p[k], w.p[k + 1]];
      let best = null;
      faces.forEach((f, fi) => {
        const n = f.p.length / 4;
        for (const fv of [0, n - 1]) {
          if (taken.has(`${fi},${fv}`)) continue;
          const F = [f.p[4 * fv], f.p[4 * fv + 1]], nb = fv ? n - 2 : 1;
          const vl = Math.hypot(F[0] - f.p[4 * nb], F[1] - f.p[4 * nb + 1]) || 1;
          const vx = (F[0] - f.p[4 * nb]) / vl, vz = (F[1] - f.p[4 * nb + 1]) / vl; // out along the face at that end
          // where the lines cross (the face's end itself where they run nearly parallel); grow: m the face grows there
          const cr = ux * vz - uz * vx;
          let X = F, grow = 0;
          if (Math.abs(cr) > 0.3) {
            const a = ((F[0] - W[0]) * vz - (F[1] - W[1]) * vx) / cr;
            if (a < -0.5) continue;
            grow = ((F[0] - W[0]) * uz - (F[1] - W[1]) * ux) / cr;
            X = [W[0] + ux * a, W[1] + uz * a];
          }
          const dW = Math.hypot(X[0] - W[0], X[1] - W[1]), dF = Math.abs(grow);
          if (dW > JOIN || dF > JOIN || (dW > 0.05 && ((X[0] - W[0]) * ux + (X[1] - W[1]) * uz) / dW < 0.2)) continue;
          if (!best || dW + dF < best.score) best = { fi, fv, grow, score: dW + dF };
        }
      });
      if (!best) continue;
      taken.add(`${best.fi},${best.fv}`);
      asks.push({ ...best, w, head });
    }
  }
  faces.forEach((f, fi) => {
    const mine = asks.filter((a) => a.fi === fi);
    if (!mine.length) return;
    const P = portals[fi], n = f.p.length / 4;
    // the face's vertices by metres along it
    const V = [];
    let len = 0;
    for (let k = 0; k < n; k++) {
      if (k) len += Math.hypot(f.p[4 * k] - f.p[4 * k - 4], f.p[4 * k + 1] - f.p[4 * k - 3]);
      V.push({ u: len, x: f.p[4 * k], z: f.p[4 * k + 1], deck: f.p[4 * k + 2], foot: f.p[4 * k + 3] });
    }
    const dx = (V[n - 1].x - V[0].x) / (len || 1), dz = (V[n - 1].z - V[0].z) / (len || 1);
    let g0 = mine.find((a) => a.fv === 0)?.grow ?? 0, g1 = mine.find((a) => a.fv === n - 1)?.grow ?? 0;
    const u0 = Math.min(...P.o.map((o) => o[0])), u1 = Math.max(...P.o.map((o) => o[1]));
    // (room before the first opening and after the last: the openings move along, up to SHIFT_MAX, where one is short;
    // where they cannot, that end of the face stays)
    const fit = () => {
      const room0 = u0 + g0, room1 = len + g1 - u1;
      if (room0 >= ABUT_MIN && room1 >= ABUT_MIN) return 0;
      const sh = room0 < ABUT_MIN ? ABUT_MIN - room0 : room1 - ABUT_MIN;
      return Math.abs(sh) <= SHIFT_MAX && room0 + sh >= ABUT_MIN && room1 - sh >= ABUT_MIN ? sh : null;
    };
    let shift = fit();
    if (shift === null) { if (u0 + g0 < ABUT_MIN) g0 = 0; else g1 = 0; shift = fit(); }
    if (shift === null) { g0 = g1 = 0; shift = 0; }
    const a = -g0, b = len + g1;
    const at = (u) => ({ x: V[0].x + dx * u, z: V[0].z + dz * u });
    const kept = V.filter((v) => v.u > a + 0.05 && v.u < b - 0.05);
    const ends = [{ ...V[0], ...at(a), u: a }, { ...V[n - 1], ...at(b), u: b }];
    const nv = [ends[0], ...kept, ends[1]];
    f.p.length = 0;
    for (const v of nv) f.p.push(r2(v.x), r2(v.z), v.deck, v.foot);
    f.h[1] = nv.length - 1;
    for (const o of P.o) { o[0] = r2(o[0] + g0 + shift); o[1] = r2(o[1] + g0 + shift); }
  });
  let joined = 0;
  for (const { fi, fv, w, head } of asks) {
    const f = faces[fi], q = fv ? f.p.length - 4 : 0, k = head ? 0 : w.p.length - 4;
    const end = f.p.slice(q, q + 4);
    if (Math.hypot(end[0] - w.p[k], end[1] - w.p[k + 1]) > 0.05) w.p = head ? [...end, ...w.p] : [...w.p, ...end];
    joined++;
  }
  log(`tunnels: ${out.length} retaining walls round the portals (${out.reduce((s, w) => s + w.p.length / 4, 0)} vertices; ` +
    `${twins} samples along a wall another one found dropped), ${joined} ends run on to a portal's face`);
  return out;
}
