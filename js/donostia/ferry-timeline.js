import { FERRY } from './data-boats.js';

// js/donostia/ferry-timeline.js
// The island ferries' round (js/donostia/ferries.js draws them; no three.js here, so the tests can run it): the two
// Motoras de la Isla shuttle between their berths at the north basin's ferry pier and Santa Klara's jetty, on the lanes
// tools/donostia/bake-boats.mjs baked (js/donostia/data-boats.js FERRY). A round, for each:
// 1. moored at its berth (DWELL.port)
// 2. astern off the berth to where it turns (the lane's first point), easing in & out
// 3. the turn there, to its lane's first heading (the way the bake found clear)
// 4. out along its lane: up to each point's speed limit (the harbour's, the bay's) and slow enough through the bends to turn
//    no faster than TURN_RATE, speeding up & slowing down at ACCEL,
//    at rest at the island's landing
// 5. moored bow-on at the landing (DWELL.island); 6. astern & 7. the turn there; 8. back along its other lane to its
//    berth, along the quay
// Both rounds last as long (the shorter one waits longer at its berth) and the second runs half a round behind the
// first, so one is at the island while the other is in port; in the bay they pass port to port on their lanes.
// The service runs from SERVICE.from to SERVICE.to (h): the first departure at 10:00, the last boat back from the island by
// 20:00 (motorasdelaisla.com, the summer timetable); otherwise both lie at their berths.
// ferryRounds() -> [{ length, beam, berth: pose, duration, pose(t) }], pose: { x, z, heading (degrees from +z towards
// +x, of the bow), speed (m/s, astern negative) }.

export const SERVICE = { from: 10, to: 20 };
const DWELL = { port: 150, island: 90 }; // s
const ASTERN = 0.7; // m/s at most, going astern
const TURN_RATE = 7; // degrees a second at most, turning on the spot
const ACCEL = 0.12; // m/s²
const CREEP = 0.25; // m/s: the least speed a lane's time is reckoned at (the ends of a lane are at rest)

const headingOf = (dx, dz) => ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
const turnTo = (a, b) => ((b - a + 540) % 360) - 180;
const ease = (f) => f * f * (3 - 2 * f);

// A lane's points (m), cumulative times (s) under its speed limits and ACCEL, from rest to rest, and headings
function timedLane(flat) {
  const pts = [];
  for (let k = 0; k < flat.length; k += 3) pts.push({ x: flat[k] / 100, z: flat[k + 1] / 100, limit: flat[k + 2] / 100 });
  const n = pts.length, v = new Float64Array(n);
  const ds = (k) => Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
  const heading = pts.map((_, k) => {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    return headingOf(b.x - a.x, b.z - a.z);
  });
  // each point's speed limit, and no faster through a bend than turns the bow TURN_RATE a second
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 1), b = Math.min(n - 1, k + 1);
    const bend = Math.abs(turnTo(heading[a], heading[b])) / Math.max(1e-6, Math.hypot(pts[b].x - pts[a].x, pts[b].z - pts[a].z));
    v[k] = Math.min(pts[k].limit, TURN_RATE / Math.max(1e-6, bend));
  }
  v[0] = 0;
  v[n - 1] = 0;
  for (let k = 1; k < n; k++) v[k] = Math.min(v[k], Math.sqrt(v[k - 1] ** 2 + 2 * ACCEL * ds(k - 1)));
  for (let k = n - 2; k >= 0; k--) v[k] = Math.min(v[k], Math.sqrt(v[k + 1] ** 2 + 2 * ACCEL * ds(k)));
  const t = new Float64Array(n);
  for (let k = 1; k < n; k++) t[k] = t[k - 1] + ds(k - 1) / Math.max(CREEP, (v[k - 1] + v[k]) / 2);
  return { pts, v, t, heading, duration: t[n - 1] };
}

// the pose at time s into a timed lane
function onLane(lane, s) {
  const { pts, t, v, heading } = lane;
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t[mid] <= s) lo = mid;
    else hi = mid;
  }
  const f = Math.min(1, Math.max(0, (s - t[lo]) / Math.max(1e-6, t[hi] - t[lo])));
  const a = pts[lo], b = pts[hi];
  return {
    x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
    heading: (heading[lo] + turnTo(heading[lo], heading[hi]) * f + 360) % 360, speed: v[lo] + (v[hi] - v[lo]) * f
  };
}

// The steps of a round: [duration, (f in 0..1) -> pose]
function steps(ferry) {
  const [bx, bz, bh] = ferry.berth, [ix, iz, ih] = ferry.island;
  const berth = { x: bx / 100, z: bz / 100, heading: bh / 10, speed: 0 };
  const island = { x: ix / 100, z: iz / 100, heading: ih / 10, speed: 0 };
  const out = timedLane(ferry.out), back = timedLane(ferry.back);
  const still = (p) => () => p;
  const astern = (from, to) => {
    const d = Math.hypot(to.x - from.x, to.z - from.z), duration = (1.5 * d) / ASTERN; // (eased: the mean is 2/3 the most)
    return [duration, (f) => {
      const e = ease(f);
      return { x: from.x + (to.x - from.x) * e, z: from.z + (to.z - from.z) * e, heading: from.heading, speed: -6 * f * (1 - f) * d / duration };
    }];
  };
  // the turn on the spot to the lane's first heading, the way the bake found clear (its sign)
  const turn = (at, lane, sign) => {
    let delta = turnTo(at.heading, lane.heading[0]);
    if (sign && Math.sign(delta) !== Math.sign(sign)) delta -= Math.sign(delta) * 360;
    return [(1.5 * Math.abs(delta)) / TURN_RATE, (f) => ({ x: at.x, z: at.z, heading: (at.heading + delta * ease(f) + 360) % 360, speed: 0 })];
  };
  const portTurn = { ...out.pts[0], heading: berth.heading }, islandTurn = { ...back.pts[0], heading: island.heading };
  return {
    berth,
    list: [
      [DWELL.port, still(berth)],
      astern(berth, portTurn),
      turn(portTurn, out, ferry.turns[0]),
      [out.duration, (f) => onLane(out, f * out.duration)],
      [DWELL.island, still(island)],
      astern(island, islandTurn),
      turn(islandTurn, back, ferry.turns[1]),
      [back.duration, (f) => onLane(back, f * back.duration)]
    ]
  };
}

/**
 * The ferries' rounds: per ferry its size (m), its berth's pose, the round's duration (s, the same for both) and
 * pose(t), t in seconds (any; the rounds repeat).
 */
export function ferryRounds() {
  const all = FERRY.ferries.map(steps);
  const own = all.map(({ list }) => list.reduce((s, [d]) => s + d, 0));
  const duration = Math.max(...own);
  return all.map(({ berth, list }, k) => {
    list[0][0] += duration - own[k]; // the shorter round waits longer at its berth
    const offset = (k * duration) / all.length;
    return {
      length: FERRY.ferries[k].berth[3] / 100, beam: FERRY.ferries[k].berth[4] / 100, berth, duration,
      pose(t) {
        let s = (((t - offset) % duration) + duration) % duration;
        for (const [d, at] of list) {
          if (s < d) return at(d > 0 ? s / d : 1);
          s -= d;
        }
        return berth;
      }
    };
  });
}
