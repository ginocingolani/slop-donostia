// tools/donostia/harresia.mjs
// The old city wall along the port (harresia), for tools/donostia/build.mjs: the stretch of the Parte Vieja's sea wall
// that still stands between the foot of Mari kalea's steps and Lasta plaza, with the Portaletas gate in it.
//
// The municipal map draws the wall walk along its top as a sidewalk (ESPALOIA) 2-3 m wide, which OpenStreetMap follows
// with a footway on layer 1 (ways 23843734 & 230520365) and a bridge round the gate (230520369). Its spot heights
// (KotaPuntuak) put the walk at 10.2 m from the steps to the gate, 9.3 m by Migel Muñoa plaza and 6.2 m at its far end,
// over Kaimingaintxo and Lasta plazas 4.1-5 m below and, on the city side, over Mari kalea where it goes down to Portu
// kalea (up to 4 m below the walk). The bare-earth LiDAR keeps nothing of the walk (under it lies the street's level)
// and has the port face as a step a metre or two wide, which the 2 m terrain grid smeared into a slope 3-6 m high over
// the plazas, the paving stretched down it: the curtain at the foot of the Parte Vieja seen from the port. The walls
// search of tools/donostia/walls.mjs never looks there (no shoreline, quay, building or municipal wall runs along it).
//
// Here the walk's outline is walked every STEP with a LiDAR profile square to it. On the port's side of the walk's line,
// where the ground outside lies PORT_MIN or more below the street on the far side of the walk, the edge is the wall's
// port face: a hidden wall of GEO.terrain.walls, so the terrain steps there from the plaza to the street's level (the
// walk stands on it), and masonry from the plaza up to the walk. On the town's side, where the street outside lies
// INNER_MIN or more below the walk, the edge is the inner face, masonry only (the terrain there is the street's
// already). Along the inner face the walk's top is laid between the two faces (sections from the inner edge to the port
// face). The flight of Mari kalea's steps climbs on along the wall towards Gaztelubide: the port face runs on along its
// parapet wall (HORMA).
// Round the Portaletas the walk is the terrace on the gatehouse in front of the gate's block: the gate's block is the
// pedestrian piece of the map (OINEZKOEN ZONA) under the inner arch, the gatehouse the walk's outline in front of it,
// its outer facets and the half-round court between it and the block. The terrain there keeps its LiDAR level (the
// passages run through at the plazas' level; the terrain's wall runs on round the gatehouse's front without a step) and
// js/donostia/landmarks/harresia.js builds them.
// Returns { walls (hidden, for GEO.terrain.walls), data (js/donostia/data-harresia.js), inner (its inner faces) }.

import { WALL } from '../../js/donostia/shore-walls.js';
import { smooth, simplify } from './walls.mjs';
import { pointInRing } from './lib.mjs';

// A spot height on the walk (10.18 m): the municipal sidewalk piece round it is the walk
const WALK_SPOT = [100.7, -219.4];
// A vertex of the parapet wall (HORMA) on the plaza's side of Mari kalea's steps
const STAIRS_WALL = [80.7, -244.4];
// Inside the pedestrian piece (OINEZKOEN ZONA) under the Portaletas' inner arch
const GATE = [115.3, -191.3];
// OSM: the walk (layer 1), its bridge round the gate and Mari kalea, which runs on along the wall past Migel Muñoa
// plaza: the line the walk's level is interpolated along between the spot heights
const WALK_WAYS = [23843734, 230520369, 230520365, 977959530];
const STEP = 0.5; // m between profile samples
// m outside the edge: the plaza, or the street on the city side, past the LiDAR's smear of the face (1-2 m wide, and
// the walk's edge stands up to 1.5 m back from the face's foot by the steps); its lower quartile
const OUT = [2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];
const BACK = [3, 3.5, 4, 4.5]; // m inside: across the walk, the street (or the plaza, from the inner edge)
const STAIRS_BACK = [1, 1.5, 2, 2.5]; // m behind the steps' parapet: the steps
const PORT_MIN = 1; // m
const INNER_MIN = 0.4; // m
const RUN_MIN = 3; // m: shorter runs of a face are left out
const GAP = 1.5; // m: a shorter gap between two runs of one face is bridged
const HOUSE_R = 11; // m round the gate's block: the gatehouse in front of it
const SECTION = 1; // m between the walk's sections
const r2 = (v) => Math.round(v * 100) / 100;

const quantile = (a, q) => {
  const s = a.filter(Number.isFinite).sort((p, r) => p - r);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
const median = (a) => quantile(a, 0.5);

// A flat ring [x, z, ...] as points, without the closing repeat or near-duplicates, turned so that the outside lies on
// the (-dz, dx) side of travel (js/donostia/shore-walls.js's low side)
function orientedRing(flat) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 2) {
    const p = { x: flat[k], z: flat[k + 1] };
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.z - q.z) > 0.01) pts.push(p);
  }
  if (pts.length > 2 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 0.01) pts.pop();
  // (the longest edge's normal tells)
  let best = 0, len = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b.x - a.x, b.z - a.z);
    if (l > len) { len = l; best = i; }
  }
  const a = pts[best], b = pts[(best + 1) % pts.length];
  const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
  if (pointInRing((a.x + b.x) / 2 + nx * 0.1, (a.z + b.z) / 2 + nz * 0.1, flat)) pts.reverse();
  return pts;
}

// Minimum-area box over a ring's edge directions: centre, long axis (ux, uz), length & depth
function box(pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], l = Math.hypot(b.x - a.x, b.z - a.z);
    if (l < 1e-6) continue;
    const ux = (b.x - a.x) / l, uz = (b.z - a.z) / l;
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of pts) {
      const u = p.x * ux + p.z * uz, v = -p.x * uz + p.z * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (!best || area < best.area) {
      const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
      best = { area, ux, uz, L: u1 - u0, D: v1 - v0, cx: cu * ux - cv * uz, cz: cu * uz + cv * ux };
    }
  }
  if (best.D > best.L) Object.assign(best, { ux: -best.uz, uz: best.ux, L: best.D, D: best.L });
  return best;
}

// Nearest point of a polyline [{ x, z }] to (x, z): { x, z, s (arc length), d }
function nearestOn(line, x, z) {
  let best = null, s = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz);
    if (l > 1e-9) {
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (l * l)));
      const px = a.x + dx * t, pz = a.z + dz * t, d = Math.hypot(x - px, z - pz);
      if (!best || d < best.d) best = { x: px, z: pz, s: s + t * l, d };
    }
    s += l;
  }
  return best;
}

// Runs of samples [{ kind, brk, ... }] of one kind, the gaps of GAP or less between two runs of it bridged; a break
// (brk: an edge left out comes before the sample) ends a run. cyclic: the samples go round a ring.
function runsOf(samples, kind, cyclic) {
  const n = samples.length;
  if (!n) return [];
  let start = 0;
  if (cyclic) {
    start = samples.findIndex((s, i) => s.brk || (s.kind !== kind && samples[(i + n - 1) % n].kind === kind));
    if (start < 0) start = samples.every((s) => s.kind === kind) ? 0 : samples.findIndex((s) => s.kind !== kind);
    if (start < 0) start = 0;
  }
  const seq = [...samples.slice(start), ...samples.slice(0, start)];
  // bridge short gaps
  const on = seq.map((s) => s.kind === kind);
  for (let i = 0; i < n; i++) {
    if (on[i] || !i || !on[i - 1]) continue;
    let j = i;
    while (j < n && !on[j] && !seq[j].brk) j++;
    if (j < n && on[j] && !seq[j].brk && (j - i) * STEP <= GAP) for (let k = i; k < j; k++) on[k] = true;
  }
  const runs = [];
  let cur = [];
  for (let i = 0; i < n; i++) {
    if (seq[i].brk && cur.length) { runs.push(cur); cur = []; }
    if (on[i]) cur.push(seq[i]);
    else if (cur.length) { runs.push(cur); cur = []; }
  }
  if (cur.length) runs.push(cur);
  return runs.filter((r) => (r.length - 1) * STEP >= RUN_MIN);
}

// A run of samples as a wall line [x, z, deck, foot, ...]: the levels smoothed along it, the foot no higher than the
// ground FOOT_RUN m either way (the LiDAR outside a corner of the gatehouse keeps some of its masonry), the line
// simplified
const FOOT_RUN = 3; // m
function wallLine(run, deckOf, footOf) {
  const raw = run.map(footOf), r = Math.round(FOOT_RUN / STEP);
  const deck = smooth(run.map(deckOf)), foot = smooth(raw.map((_, i) => Math.min(...raw.slice(Math.max(0, i - r), i + r + 1))));
  const pts = run.map((s, i) => ({ x: s.x, z: s.z, deck: deck[i], foot: foot[i] }));
  return simplify(pts, 0.08).flatMap((p) => [p.x, p.z, p.deck, p.foot].map(r2));
}

/**
 * dtm: the 1 m LiDAR Grid (lib.mjs, sample(x, z)); loadLayer, lonLatToLocal: lib.mjs's.
 */
export function cityWall({ dtm, loadLayer, lonLatToLocal, log = () => {} }) {
  const probe = (x, z, nx, nz, ds, q = 0.5) => quantile(ds.map((d) => dtm.sample(x + nx * d, z + nz * d)), q);
  const walkFlat = loadLayer('c500_ESPALOIA.json').features.map((f) => f.g[0]).find((r) => pointInRing(...WALK_SPOT, r));
  const gateFlat = loadLayer('c500_OINEZKOEN_ZONA.json').features.map((f) => f.g[0]).find((r) => pointInRing(...GATE, r));
  const stairsFeature = loadLayer('c500_HORMA.json').features.find((f) => {
    const r = f.g[0];
    for (let k = 0; k < r.length; k += 2) if (Math.hypot(r[k] - STAIRS_WALL[0], r[k + 1] - STAIRS_WALL[1]) < 0.05) return true;
    return false;
  });
  if (!walkFlat || !gateFlat || !stairsFeature) throw new Error('harresia: the wall walk, the gate or the steps\' parapet is not on the municipal map');
  const ring = orientedRing(walkFlat);
  const n = ring.length;

  // the walk's line (OSM) and its level: the spot heights on the walk, interpolated along it
  const ways = new Map(loadLayer('osm_streets.json').elements.filter((e) => WALK_WAYS.includes(e.id)).map((e) => [e.id, e]));
  const axis = [];
  for (const id of WALK_WAYS) {
    const e = ways.get(id);
    if (!e) throw new Error(`harresia: OSM way ${id} is missing`);
    for (const g of e.geometry) {
      const [x, z] = lonLatToLocal(g.lon, g.lat);
      const q = axis[axis.length - 1];
      if (!q || Math.hypot(x - q.x, z - q.z) > 0.05) axis.push({ x, z });
    }
  }
  const sOf = (x, z) => nearestOn(axis, x, z).s;
  // (which side of the walk's line a point lies on: +1 or -1)
  const sideOf = (x, z) => {
    let best = null, bd = Infinity;
    for (let i = 0; i + 1 < axis.length; i++) {
      const a = axis[i], b = axis[i + 1], dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2));
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t);
      if (d < bd) { bd = d; best = Math.sign(dx * (z - a.z) - dz * (x - a.x)); }
    }
    return best;
  };
  const spots = loadLayer('c500_KotaPuntuak.json').features.filter((f) => pointInRing(f.g[0], f.g[1], walkFlat))
    .map((f) => ({ s: sOf(f.g[0], f.g[1]), y: f.p.Kota })).sort((a, b) => a.s - b.s);
  if (spots.length < 2) throw new Error('harresia: no spot heights on the walk');
  const levelAt = (x, z) => {
    const s = sOf(x, z);
    if (s <= spots[0].s) return spots[0].y;
    for (let i = 1; i < spots.length; i++) {
      if (s <= spots[i].s) return spots[i - 1].y + ((s - spots[i - 1].s) / (spots[i].s - spots[i - 1].s)) * (spots[i].y - spots[i - 1].y);
    }
    return spots[spots.length - 1].y;
  };

  // the gate's block and, in front of it, the gatehouse: the walk's vertices on the block's far side from the town
  // (its west face, towards the port) and within HOUSE_R of it, in two runs: the outer facets and the court's curve
  const gateRing = orientedRing(gateFlat);
  const G = box(gateRing);
  let vx = -G.uz, vz = G.ux; // across the block, turned towards the gatehouse (the walk's vertex farthest out)
  let far = null;
  for (const p of ring) {
    const d = Math.hypot(p.x - G.cx, p.z - G.cz);
    if (d <= HOUSE_R && (!far || d > far.d)) far = { d, p };
  }
  if ((far.p.x - G.cx) * vx + (far.p.z - G.cz) * vz < 0) { vx = -vx; vz = -vz; }
  const inHouse = ring.map((p) => Math.hypot(p.x - G.cx, p.z - G.cz) <= HOUSE_R &&
    (p.x - G.cx) * vx + (p.z - G.cz) * vz >= G.D / 2 - 0.5);
  const houseEdge = (i) => inHouse[i] && inHouse[(i + 1) % n];
  // (the runs of house edges round the ring: the farther one from the block is the gatehouse's front)
  const houseRuns = [];
  const portSide = sideOf(far.p.x, far.p.z); // (the gatehouse stands out on the port's side)
  for (let i = 0; i < n; i++) {
    if (!houseEdge(i) || houseEdge((i + n - 1) % n)) continue;
    const run = [i];
    for (let j = (i + 1) % n; houseEdge(j) && j !== i; j = (j + 1) % n) run.push(j);
    houseRuns.push([...run, (run[run.length - 1] + 1) % n].map((k) => ring[k]));
  }
  const meanDist = (pts) => pts.reduce((s, p) => s + Math.hypot(p.x - G.cx, p.z - G.cz), 0) / pts.length;
  houseRuns.sort((a, b) => meanDist(b) - meanDist(a));
  if (houseRuns.length !== 2) throw new Error(`harresia: ${houseRuns.length} runs of the gatehouse's outline (2 expected)`);
  const [front, court] = houseRuns;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
    [G.cx + G.ux * a * G.L / 2 + vx * b * G.D / 2, G.cz + G.uz * a * G.L / 2 + vz * b * G.D / 2]);
  const blockLine = [...corners, corners[0]].map(([x, z]) => ({ x, z }));
  // (the walk's edges along the block's ends: against it, no face)
  const byBlock = (i) => {
    const a = ring[i], b = ring[(i + 1) % n];
    return nearestOn(blockLine, a.x, a.z).d < 0.6 && nearestOn(blockLine, b.x, b.z).d < 0.6;
  };

  // the faces: every STEP round the walk's outline
  const samples = [];
  let skipped = false;
  const left = (i) => houseEdge(i) || byBlock(i);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (left(i) || len < 1e-6) { skipped = true; continue; }
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    for (let t = 0; t < len - 1e-6; t += STEP) {
      const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
      const out = probe(x, z, nx, nz, OUT, 0.25), back = probe(x, z, -nx, -nz, BACK), walk = levelAt(x, z);
      let kind = 0;
      if (sideOf(x, z) === portSide) kind = back - out >= PORT_MIN ? 1 : 0;
      else kind = walk - out >= INNER_MIN ? 2 : 0;
      samples.push({ x, z, out, back, walk, kind, edge: i, brk: skipped });
      skipped = false;
    }
    // (a face runs on to the corner where the gatehouse or the gate's block begins)
    if (left((i + 1) % n) && samples.length) samples.push({ ...samples[samples.length - 1], x: b.x, z: b.z, brk: false });
  }
  if (skipped && samples.length) samples[0].brk = true;
  const port = runsOf(samples, 1, true), inner = runsOf(samples, 2, true);

  // the steps' parapet: the port face runs on along it, from the walk's end up the flight
  const stairs = orientedRing(stairsFeature.g[0]);
  const stairSamples = [];
  skipped = false;
  for (let i = 0; i < stairs.length; i++) {
    const a = stairs[i], b = stairs[(i + 1) % stairs.length];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1e-6) { skipped = true; continue; }
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    for (let t = 0; t < len - 1e-6; t += STEP) {
      const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
      const out = probe(x, z, nx, nz, OUT, 0.25), back = probe(x, z, -nx, -nz, STAIRS_BACK);
      stairSamples.push({ x, z, out, back, walk: back, kind: back - out >= PORT_MIN ? 1 : 0, brk: skipped });
      skipped = false;
    }
  }
  const stairRuns = runsOf(stairSamples, 1, true);
  // (joined to the walk's port face where one ends by the other's start)
  for (const sr of stairRuns) {
    const head = sr[0], tail = sr[sr.length - 1];
    const before = port.find((r) => Math.hypot(r[0].x - tail.x, r[0].z - tail.z) < 1.2);
    const after = port.find((r) => Math.hypot(r[r.length - 1].x - head.x, r[r.length - 1].z - head.z) < 1.2);
    if (before) before.unshift(...sr);
    else if (after) after.push(...sr);
    else port.push(sr);
  }

  // the terrain's wall runs on round the gatehouse's front from one run of the port face to the other, at the plaza's
  // level on both sides (no step: the passages through it start at the plaza's level, and a step at the facade's line
  // showed in their openings), so no triangle reaches from the face's high side out past the gatehouse's corners
  const houseSamples = [];
  for (let i = 0; i + 1 < front.length; i++) {
    const a = front[i], b = front[i + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
    const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
    for (let t = 0; t < len - 1e-6; t += STEP) {
      const x = a.x + ((b.x - a.x) * t) / len, z = a.z + ((b.z - a.z) * t) / len;
      const out = probe(x, z, nx, nz, OUT, 0.25);
      houseSamples.push({ x, z, out, back: out, walk: out, kind: 1 });
    }
  }
  houseSamples.push({ ...houseSamples[houseSamples.length - 1], x: front[front.length - 1].x, z: front[front.length - 1].z });
  const near = (p, q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.6;
  const before = port.find((r) => near(r[r.length - 1], front[0])), after = port.find((r) => near(r[0], front[front.length - 1]));
  const terrainRuns = port.filter((r) => r !== before && r !== after);
  terrainRuns.push([...(before || []), ...houseSamples, ...(after || [])]);

  const walls = [], faces = [];
  for (const run of terrainRuns) {
    const p = wallLine(run, (s) => s.back, (s) => s.out);
    walls.push({ t: WALL.harresia, b: 0, p, h: [0, p.length / 4 - 1] });
  }
  for (const run of port) faces.push({ t: WALL.harresia, b: 0, p: wallLine(run, (s) => Math.max(s.walk, s.back), (s) => s.out) });
  const innerFaces = inner.map((run) => ({ t: WALL.harresia, b: 0, p: wallLine(run, (s) => s.walk, (s) => s.out) }));
  faces.push(...innerFaces);

  // the walk's top along the inner face: sections from the inner edge across to the port face (or the gatehouse's front)
  const outerEdges = [];
  for (const run of port) outerEdges.push(run.map((s) => ({ x: s.x, z: s.z })));
  outerEdges.push(front);
  const walk = [];
  for (const run of inner) {
    const strip = [];
    const L = (run.length - 1) * STEP, count = Math.max(1, Math.round(L / SECTION));
    for (let k = 0; k <= count; k++) {
      const s = run[Math.round((k / count) * (run.length - 1))];
      let O = null;
      for (const e of outerEdges) {
        const q = nearestOn(e, s.x, s.z);
        if (q && (!O || q.d < O.d)) O = q;
      }
      if (!O || O.d > 4.5 || O.d < 1) continue;
      strip.push(r2(O.x), r2(O.z), r2(s.x), r2(s.z), r2(s.walk));
    }
    if (strip.length >= 10) walk.push(strip);
  }

  // (the terrace's level: its spot heights')
  const houseFlat = [...front, ...court].flatMap((p) => [p.x, p.z]);
  const onTerrace = loadLayer('c500_KotaPuntuak.json').features.filter((f) => pointInRing(f.g[0], f.g[1], houseFlat)).map((f) => f.p.Kota);
  const terrace = onTerrace.length ? median(onTerrace) : levelAt(far.p.x, far.p.z);
  const courtFloor = median(court.map((p) => dtm.sample(p.x + vx * -1.5, p.z + vz * -1.5)));
  const data = {
    faces,
    walk,
    gate: {
      block: corners.flat().map(r2),
      house: front.flatMap((p) => [r2(p.x), r2(p.z)]),
      court: court.flatMap((p) => [r2(p.x), r2(p.z)]),
      terrace: r2(terrace),
      floor: r2(courtFloor)
    }
  };
  const metres = (runs) => runs.reduce((m, r) => m + (r.length - 1) * STEP, 0).toFixed(0);
  log(`harresia: the walk ${spots.map((s) => s.y).join(', ')} m; port face ${port.length} runs, ${metres(port)} m; ` +
    `inner face ${inner.length} runs, ${metres(inner)} m; walk top ${walk.length} strips; the Portaletas' gatehouse ` +
    `${front.length} vertices, court ${court.length}, gate ${G.L.toFixed(1)} x ${G.D.toFixed(1)} m, terrace ${data.gate.terrace} m`);
  return { walls, data, inner: innerFaces };
}
