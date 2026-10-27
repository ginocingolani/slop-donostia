// tools/donostia/beach-access.mjs
// The accesses from the promenades down to the beaches of La Concha (Alderdi Eder -> La Perla -> Miramar & the Pico del
// Loro), Ondarreta (to the Peine del Viento) and Zurriola (the Kursaal -> Sagüés), for tools/donostia/build.mjs, which
// writes them to js/donostia/data-beach-access.js (built by js/donostia/beach-access.js).
//
// The inventory below names, access by access, the pieces of the municipal 1:500 map's stairs (ESKAILERA) and ramps
// (ARRAPALA) it is made of, in order from the top to the sand, read against the 2025 orthophoto (geoEuskadi: the steps,
// landings, parapets and railings' shadows) and OpenStreetMap's steps (direction & step counts where mapped). Its
// levels are the 1:500 spot heights (KotaPuntuak) where there are some: the promenade at the top, the landings, the
// sand at the foot; elsewhere the 1 m LiDAR (2017) and the shore walls. From that the bake works out each piece's
// way down (from the piece before to the piece after), its fall (the drop between the levels shared out over the
// flights' runs), its steps (rises of about RISE), which of its sides stand open (parapet & handrail) and, for the
// flights and ramps built in front of a sea wall, the wall line behind them (the wall the LiDAR could not find there,
// as the stairs were cut out of the search), so the sand in front comes down to the beach.

import { WALL, nearestWall, wallIndex, visibleWalls } from '../../js/donostia/shore-walls.js';
import { pointInRing, ringArea, simplifyRing } from './lib.mjs';

const RISE = 0.165; // m: the rise the steps are cut to (each flight's own, between ~0.15 and ~0.18)
const BURY = 0.12; // m: the last step goes this far into the sand
const BASE = 0.7; // m the masonry goes on under the sand (or the ground under a piece)
const UPSTAND = 0.14; // m: the stone kerb along an open side, above the nosings, the landing or the ramp
const RAIL_H = 0.85; // m: a handrail's top over the kerb (about 1 m over the nosings or the floor)

// --- the inventory ------------------------------------------------------------------------------------------------------
// A piece: [layer ('E' stairs, 'A' ramp), x, z (the mean of its 1:500 outline's vertices, within 0.6 m), options]
// options: t 'L' a landing, 'F' a flight (stairs), 'R' a ramp (ramps); y: the level at its top (m, a spot height); prom:
// a landing that is a corner of the promenade itself (its sides to the sand are the sea wall);
// dir: [ux, uz] its way down when the chain cannot tell it (a piece on its own); clip: [ax, az, bx, bz] keeps the part
// of the outline left of the line a -> b (x east, z south: left is (bz - az, -(bx - ax)))
// An access: id, beach, type (as in the README's inventory), top (m: the promenade where it starts; deck: the promenade
// behind the wall where the access starts lower), bot (m: the sand
// where it ends; else from the spot heights & LiDAR there), wall (built in front of a sea wall: the wall runs on behind
// it; land: [x, z] towards the promenade where its own outline cannot tell; cheeks: the sides cut into the promenade
// are walls too (from the promenade down to the steps), not the parts' own cheek walls; trim: [[x0, z0, x1, z1], ...] boxes where the
// LiDAR's wall search strayed along the stairs' side, dropped; beachEdge: [[x0, z0, x1, z1], ...] stretches of the
// municipal beach's edge, from its vertex nearest (x0, z0) to the one nearest (x1, z1), that are the wall on from the
// access where the LiDAR found none), rail ('white': a white painted handrail, 'steel': stainless tube, 'barandilla': La Concha's cast-iron railing,
// '' none), chains: [[piece, ...], ...] each from the top down; skip: pieces that belong to it but are not built (the
// 1:500 draws some parapets & handrails as stairs); note: its evidence.
const P = (layer, x, z, o = {}) => ({ layer, x, z, ...o });
const L = (x, z, o = {}) => P('E', x, z, { t: 'L', ...o });

export const ACCESS = [
  // --- La Concha, west to east --------------------------------------------------------------------------------------------
  {
    id: 'kontxa-pico-del-loro', beach: 'kontxa', type: 'switchback & flight square to the wall', top: 11.67, wall: true, rail: 'white',
    land: [-0.235, 0.972], trim: [[-660.8, 735, -657, 738.95], [-653, 737.5, -646, 739.6]],
    beachEdge: [[-654.49, 741.4, -643.77, 737.91]],
    note: 'by the Pico del Loro bastions: down along the wall in the promenade, back, and out across the sand (spot heights 11.67, 1.61-1.83)',
    chains: [[L(-655.08, 741.14), P('E', -656.78, 741.51), L(-659.03, 740.75), P('E', -656.78, 740.41), P('E', -654.43, 739.90),
      L(-653.02, 737.49), P('E', -652.01, 735.71), P('E', -650.79, 733.71), P('E', -650.51, 733.19)]]
  },
  {
    id: 'kontxa-miramar-terrace', beach: 'kontxa', type: 'broad flight to the bastion terrace', top: 11.73, bot: 9.99, rail: '',
    note: 'the steps the width of the Pico del Loro bastions, from the promenade (11.73) to their terrace (9.99)',
    chains: [[P('E', -625.77, 748.23, { dir: [0.218, -0.976] })]]
  },
  {
    id: 'kontxa-west', beach: 'kontxa', type: 'flight along the wall', top: 11.55, wall: true, rail: 'white',
    note: 'down the 10 m wall from the west end (LiDAR) to the sand (spot heights 0.93, 1.32)',
    chains: [[L(-491.31, 755.10), P('E', -488.49, 756.07), P('E', -480.67, 756.82), L(-475.12, 757.07), P('E', -470.93, 757.38)]]
  },
  {
    id: 'kontxa-caseta-real', beach: 'kontxa', type: 'curved twin flights (landmark)', landmark: true,
    note: "the Caseta Real's twin flights, built by js/donostia/landmarks/la-perla.js",
    chains: [[P('E', -138.23, 702.59)], [P('E', -131.60, 700.85)]]
  },
  {
    id: 'kontxa-perla-sw', beach: 'kontxa', type: 'flight along the wall', top: 8.52, bot: 3.88, wall: true, rail: 'white',
    note: "from the promenade by Eguzki (La Perla's south-west pavilion) to the sand (spot heights 8.52, 3.88)",
    chains: [[L(-94.32, 701.60), P('E', -96.87, 702.69), L(-99.80, 703.73), P('E', -102.93, 704.17)]],
    beachEdge: [[-96.54, 694.18, -94.17, 699.95]]
  },
  {
    id: 'kontxa-perla-eguzki-side', beach: 'kontxa', type: 'service steps', top: 5.04, bot: 3.12, rail: '',
    note: "up the side of La Perla's Eguzki pavilion from the sand (3.12) to the yard behind (5.04)",
    chains: [[P('E', -93.98, 683.25, { dir: [-0.53, -0.85] })]]
  },
  {
    id: 'kontxa-perla-corners', beach: 'kontxa', type: 'unresolved (not built)', unbuilt: true,
    note: "two 2 m pieces in the corners between La Perla's octagons and the wall: no spot height at their tops, nothing " +
      'readable in the orthophoto (in shadow); left to the sand until photographs show them',
    chains: [[P('E', -82.59, 675.15)], [P('E', 0.14, 627.80)]]
  },
  {
    id: 'kontxa-perla-ne', beach: 'kontxa', type: 'flight along the wall', top: 8.3, wall: true, rail: 'white',
    note: "from the corner of the Café de la Concha's terrace (OSM steps, down north-east) to the sand (3.93, 4.23)",
    chains: [[L(25.43, 624.68), P('E', 26.54, 623.56), P('E', 31.30, 621.69), L(32.97, 620.31), P('E', 34.40, 618.83)]]
  },
  {
    id: 'kontxa-double-85', beach: 'kontxa', type: 'double flight along the wall', top: 7.92, wall: true, rail: 'white',
    note: 'two flights down either way from one opening (7.92), each to a landing and on to the sand (3.66, 3.45)',
    chains: [
      [P('E', 80.17, 575.38), L(78.23, 577.69), P('E', 76.90, 578.26)],
      [P('E', 88.76, 566.82), L(90.81, 564.64), P('E', 92.34, 563.14)]
    ]
  },
  {
    id: 'kontxa-rotunda-w', beach: 'kontxa', type: 'ramp along the wall, landing, ramp & flight', top: 7.65, wall: true, rail: 'barandilla',
    note: "the clock rotunda's south-west ramp (OSM footway, wheelchair) to a landing (4.78) and on; steps from the landing to the sand",
    chains: [
      [P('A', 148.92, 502.91), L(138.89, 511.80, { y: 4.80 }), P('A', 132.60, 518.32)],
      [L(138.89, 511.80, { y: 4.80 }), P('E', 135.72, 509.10)]
    ],
    bots: [3.7, 2.8]
  },
  {
    id: 'kontxa-rotunda-mid', beach: 'kontxa', type: "flight up to the doors under the rotunda", top: 5.3, deck: 7.71, wall: true,
    rail: 'white',
    note: "below the clock: steps from the sand up to a landing against the rotunda's wall, by the doors of the beach's " +
      'facilities under it (LiDAR 5.3-6 at the landing; the rotunda 7.71); its side walls flare (1:500 walls)',
    chains: [[L(161.24, 479.84), P('E', 159.57, 478.07)]]
  },
  {
    id: 'kontxa-rotunda-e', beach: 'kontxa', type: 'ramp along the wall, landing, ramp & flight', top: 7.65, wall: true, rail: 'barandilla',
    note: "the clock rotunda's north-east ramp to a landing (4.66) and on (3.70); steps from the landing to the sand",
    chains: [
      [P('A', 182.58, 463.88), L(190.27, 452.37, { y: 4.66 }), P('A', 196.03, 445.61)],
      [L(190.27, 452.37, { y: 4.66 }), P('E', 187.95, 449.26)]
    ],
    bots: [3.6, 2.8]
  },
  {
    id: 'kontxa-double-255', beach: 'kontxa', type: 'double flight along the wall', top: 7.14, wall: true, rail: 'white',
    note: 'two flights down either way from one opening (OSM, handrails both sides) to landings at 4.32 and on to the sand',
    chains: [
      [P('E', 252.98, 362.44), P('E', 250.60, 366.40, { y: 4.32 })],
      [P('E', 258.86, 351.11), L(260.19, 348.89, { y: 4.32 }), P('E', 261.13, 346.51)]
    ]
  },
  {
    id: 'kontxa-alderdi-eder', beach: 'kontxa', type: 'twin ramps along the wall, walkway & flights', top: 7.07, wall: true, rail: 'barandilla',
    note: "Alderdi Eder's end: a ramp along the wall (7.07 -> 4.52) and, beside it, a steeper one to the sand (4.33, 2.96, 1.63); " +
      'the walkway at its foot (~4.1), steps from it to the sand and up to the promenade',
    chains: [
      [P('A', 298.82, 266.50, { clip: [302.46, 241.29, 295.26, 266.65], dir: [-0.27, 0.963] }), P('A', 290.76, 281.17, { t: 'L', y: 4.1 })],
      [P('A', 298.82, 266.50, { clip: [295.26, 266.65, 302.46, 241.29], dir: [-0.27, 0.963] })],
      [P('A', 290.76, 281.17, { t: 'L', y: 4.1 }), P('E', 290.77, 275.37), P('E', 289.97, 277.79), P('E', 289.03, 278.70)],
      [P('E', 289.78, 292.04, { dir: [0.46, -0.89] })]
    ],
    tops: [7.07, 7.0, 4.1, 7.1],
    bots: [4.0, 1.4, null, 4.1]
  },
  // --- Ondarreta, west to east ---------------------------------------------------------------------------------------------
  {
    id: 'ondarreta-west-ramp', beach: 'ondarreta', type: 'ramp along the wall', top: 4.92, wall: true, rail: 'barandilla',
    note: 'by the Peine del Viento end: a landing and a 40 m ramp down to the sand (spot heights 4.92, 4.46, 3.75, 3.10, 2.40)',
    chains: [[L(-1328.24, 416.19, { layer: 'A' }), P('A', -1314.68, 429.68)]], bot: 2.2
  },
  {
    id: 'ondarreta-broad-1243', beach: 'ondarreta', type: 'broad flight', top: 5.36, bot: 3.0, rail: '',
    note: 'twelve metres wide, cut into the promenade (5.36) down to the sand (3.00)',
    chains: [[P('E', -1242.60, 495.67, { dir: [0.59, -0.81] })]]
  },
  {
    id: 'ondarreta-broad-1112', beach: 'ondarreta', type: 'broad flight & ramp', top: 5.09, rail: 'white',
    note: 'ten metres of steps (5.09 -> 4.33) and, beside them, a ramp along the edge (4.98 -> 3.93)',
    chains: [[P('E', -1112.60, 571.96, { dir: [0.41, -0.91] })], [P('A', -1099.01, 578.04, { dir: [-0.91, -0.41] })]],
    tops: [5.09, 4.98], bots: [4.1, 3.93]
  },
  {
    id: 'ondarreta-broad-1051', beach: 'ondarreta', type: 'broad flight', top: 5.03, bot: 3.9, rail: '',
    note: 'nine metres of steps in four pieces (5.03 on the promenade, 3.72 on the steps)',
    chains: [[P('E', -1053.99, 596.36, { dir: [0.34, -0.94] })], [P('E', -1051.92, 597.11, { dir: [0.34, -0.94] })],
      [P('E', -1049.89, 597.31, { dir: [0.34, -0.94] })], [P('E', -1048.04, 598.76, { dir: [0.34, -0.94] })]]
  },
  {
    id: 'ondarreta-east-ramp', beach: 'ondarreta', type: 'ramp along the edge', top: 5.23, bot: 4.3, rail: 'white',
    note: 'along the promenade edge down to the sand (5.23 -> 4.30)',
    chains: [[P('A', -984.79, 620.83, { dir: [0.957, 0.29] })]]
  },
  {
    id: 'ondarreta-pico-del-loro', beach: 'ondarreta', type: 'curved flight, terrace & flights to the rocks', top: 8.01, rail: 'white',
    note: "the promenade's end (8.01): a curved flight to a terrace on the Pico del Loro (4.96, 4.22) and steps down its side " +
      'to the rocks and the sand (OSM steps; 1.46, 2.07)',
    chains: [
      [P('E', -759.26, 646.43), P('E', -754.78, 643.53), P('E', -751.79, 644.33, { y: 4.96 }), P('E', -749.41, 642.17)],
      [L(-743.05, 640.92, { y: 4.22 }), L(-742.27, 639.73), L(-740.38, 637.70), P('E', -739.87, 634.01),
        L(-741.80, 629.75, { y: 2.0 }), P('E', -745.07, 627.59), P('E', -746.30, 628.03), P('E', -749.28, 628.00)]
    ],
    bots: [4.22, 0.4],
    skip: [P('E', -738.82, 632.37)]
  },
  // --- Zurriola, west to east -------------------------------------------------------------------------------------------
  {
    id: 'zurriola-dike', beach: 'zurriola', type: 'flight down the dike', top: 6.75, wall: true, rail: 'steel',
    note: "from the river mouth's dike to the sand (OSM steps with handrail; the dike's walk 6.75)",
    chains: [[P('E', 640.66, -510.87), L(639.74, -513.18), P('E', 638.51, -514.95)]], bot: 2.7,
    skip: [P('E', 637.25, -514.36), P('E', 638.29, -512.41), P('E', 639.42, -510.26), P('A', 640.84, -513.56)]
  },
  {
    id: 'zurriola-kursaal-steps', beach: 'zurriola', type: 'flight', top: 6.2, bot: 4.5, rail: 'steel',
    note: "the Kursaal's north-west corner: 10 steps down (OSM)",
    chains: [[P('E', 687.73, -416.89, { dir: [-0.47, -0.88] })]],
    skip: [P('E', 686.52, -416.25), P('A', 689.02, -417.52)]
  },
  {
    id: 'zurriola-kursaal-ramp', beach: 'zurriola', type: 'ramp', top: 6.36, bot: 4.6, rail: 'steel',
    note: "along the Kursaal's beach front, down west to the sand (6.36, 5.28)",
    chains: [[P('A', 706.60, -413.74, { dir: [-0.998, -0.06] })]]
  },
  {
    id: 'zurriola-steps-874', beach: 'zurriola', type: 'flight along the wall', top: 7.58, bot: 5.3, rail: 'steel',
    note: '14 steps down west along the wall (OSM)',
    chains: [[L(876.25, -424.39), P('E', 875.18, -424.50), P('E', 873.68, -424.18), P('E', 871.96, -423.72)]]
  },
  {
    id: 'zurriola-ramp-1023', beach: 'zurriola', type: 'ramp along the wall', top: 7.7, bot: 5.0, rail: 'steel',
    note: 'forty metres down north-east along the wall (LiDAR 7.7 -> 5.0; the sand 5.00)',
    chains: [[P('A', 1022.71, -453.74, { dir: [0.88, -0.47] })]]
  },
  {
    id: 'zurriola-steps-1111', beach: 'zurriola', type: 'flight square to the wall', top: 7.63, bot: 5.76, rail: 'steel',
    note: 'out from the promenade to a half-round landing on the sand (OSM: 11 steps; 7.63, 5.76)',
    chains: [[P('E', 1112.50, -502.17, { dir: [-0.46, -0.89] }), L(1110.10, -504.05)],
      [L(1111.51, -498.64), P('E', 1109.81, -501.40), L(1110.10, -504.05)]]
  },
  {
    id: 'zurriola-platform-1195', beach: 'zurriola', type: 'ramp & steps from a beach terrace', top: 7.6, rail: 'steel',
    note: 'a terrace a little above the sand (LiDAR ~5.95), a ramp up to the promenade and steps down to the sand (5.67, 5.23)',
    chains: [[P('A', 1183.33, -530.38, { dir: [0.88, -0.47] })], [P('E', 1197.01, -537.63, { dir: [-0.47, -0.88] })],
      [P('E', 1194.97, -537.00, { dir: [-0.47, -0.88] })]],
    tops: [7.6, 5.95, 5.95], bots: [5.95, 5.2, 5.2],
    skip: [P('A', 1194.31, -532.37)]
  },
  {
    id: 'zurriola-steps-1335', beach: 'zurriola', type: 'flight along the wall with landings', top: 8.9, wall: true, rail: 'steel',
    note: "the gap in Zurriola's wall: 20 steps in three flights (OSM, handrail) to the sand (4.98, 5.07)",
    chains: [[L(1340.48, -617.72, { prom: true }), P('E', 1336.91, -614.62), L(1335.22, -613.71), P('E', 1333.63, -611.90),
      L(1331.76, -610.86), P('E', 1329.73, -609.72)]]
  },
  {
    id: 'zurriola-sagues-ramp', beach: 'zurriola', type: 'ramp along the wall', top: 9.02, bot: 5.6, wall: true, rail: 'steel',
    note: "Sagüés: down south-west along the wall (spot heights 9.02, 7.93, 5.90)",
    chains: [[P('A', 1382.83, -664.46, { dir: [-0.69, 0.72] })]]
  },
  {
    id: 'zurriola-sagues-flights', beach: 'zurriola', type: 'flights along the wall', top: 8.85, wall: true, rail: 'steel',
    note: "Sagüés' end: one flight down to the surf club's terrace (5.55), another with landings down to the sand",
    chains: [
      [P('E', 1401.82, -707.56), P('E', 1400.87, -709.70), P('E', 1400.10, -711.58), L(1398.15, -714.78, { dir: [-0.9, -0.42] })],
      [P('E', 1398.71, -718.53), L(1397.68, -720.36), P('E', 1396.56, -722.37), L(1395.66, -723.93), P('E', 1394.58, -726.03),
        P('E', 1388.64, -735.47)]
    ],
    bots: [5.55, null]
  }
];

// --- geometry helpers ---------------------------------------------------------------------------------------------------

const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

// The part of a ring left of the line a -> b (a Sutherland-Hodgman pass)
function clipLeft(ring, [ax, az, bx, bz]) {
  const nx = bz - az, nz = -(bx - ax);
  const out = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const px = ring[2 * i], pz = ring[2 * i + 1], qx = ring[2 * j], qz = ring[2 * j + 1];
    const dp = (px - ax) * nx + (pz - az) * nz, dq = (qx - ax) * nx + (qz - az) * nz;
    if (dp >= 0) out.push(px, pz);
    if ((dp >= 0) !== (dq >= 0)) {
      const t = dp / (dp - dq);
      out.push(px + (qx - px) * t, pz + (qz - pz) * t);
    }
  }
  return out;
}

// Ring cleanup: drops repeated points and the 1:500's notches (railing pillars drawn into the ramps' outlines),
// counter-clockwise in (x, z) seen from above (positive ringArea)
function cleanRing(r) {
  const pts = [];
  for (let k = 0; k < r.length; k += 2) {
    const n = pts.length;
    if (n && Math.hypot(r[k] - pts[n - 2], r[k + 1] - pts[n - 1]) < 0.02) continue;
    pts.push(r[k], r[k + 1]);
  }
  if (pts.length > 4 && Math.hypot(pts[0] - pts[pts.length - 2], pts[1] - pts[pts.length - 1]) < 0.02) pts.length -= 2;
  let out = simplifyRing(pts, 0.15);
  if (ringArea(out) < 0) {
    const rev = [];
    for (let k = out.length - 2; k >= 0; k -= 2) rev.push(out[k], out[k + 1]);
    out = rev;
  }
  return out;
}

function centroid(r) {
  let a = 0, cx = 0, cz = 0;
  const n = r.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    a += f; cx += (r[2 * j] + r[2 * i]) * f; cz += (r[2 * j + 1] + r[2 * i + 1]) * f;
  }
  return Math.abs(a) < 1e-9 ? [r[0], r[1]] : [cx / (3 * a), cz / (3 * a)];
}

// The axes of the minimum-area rectangle round a ring: [ux, uz] along its longer side, its length & width
function mainAxis(r) {
  const n = r.length / 2;
  let best = null;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = r[2 * j] - r[2 * i], dz = r[2 * j + 1] - r[2 * i + 1], l = Math.hypot(dx, dz);
    if (l < 0.05) continue;
    const ux = dx / l, uz = dz / l;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (let k = 0; k < n; k++) {
      const a = r[2 * k] * ux + r[2 * k + 1] * uz, b = -r[2 * k] * uz + r[2 * k + 1] * ux;
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const area = (a1 - a0) * (b1 - b0);
    if (!best || area < best.area - 1e-9) best = { area, ux, uz, len: a1 - a0, wid: b1 - b0 };
  }
  if (best.wid > best.len) return { ux: -best.uz, uz: best.ux, len: best.wid, wid: best.len };
  return best;
}

function segDist(x, z, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
}
function ringDist(x, z, r) {
  let d = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    d = Math.min(d, segDist(x, z, r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]));
  }
  return pointInRing(x, z, r) ? -d : d;
}

// Douglas-Peucker on an open polyline [[x, z, ...levels], ...]
function simplifyLine(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let idx = -1, max = tol;
    for (let i = a + 1; i < b; i++) {
      let d = segDist(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      // (and the levels kept within 0.1 m: a flight's foot falls along its cheek)
      for (let c = 2; c < pts[i].length; c++) {
        const L = Math.hypot(pts[b][0] - pts[a][0], pts[b][1] - pts[a][1]) || 1;
        const t = Math.hypot(pts[i][0] - pts[a][0], pts[i][1] - pts[a][1]) / L;
        d = Math.max(d, (4.5 * Math.abs(pts[i][c] - (pts[a][c] + (pts[b][c] - pts[a][c]) * Math.min(1, t)))));
      }
      if (d > max) { max = d; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

// Whether (x, z), outside a part's ring, lies off one of its sides or its foot rather than behind it (off an edge facing
// the promenade, along `back`)
function seawardOf(ring, back, x, z) {
  // the way from the ring's nearest point out to (x, z) does not head for the promenade
  let best = Infinity, px = x, pz = z;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], dx = ring[2 * j] - ax, dz = ring[2 * j + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < best) { best = d; px = ax + t * dx; pz = az + t * dz; }
  }
  const l = Math.hypot(x - px, z - pz) || 1;
  return ((x - px) * back[0] + (z - pz) * back[1]) / l < 0.5;
}

// The index of a ring's edge nearest (x, z)
function nearestEdge(r, x, z) {
  let best = 0, bd = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = segDist(x, z, r[2 * i], r[2 * i + 1], r[2 * j], r[2 * j + 1]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// Points every 0.1 m round a ring
function boundary(r, step = 0.1) {
  const out = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], len = Math.hypot(r[2 * j] - ax, r[2 * j + 1] - az);
    const m = Math.max(1, Math.round(len / step));
    for (let s = 0; s < m; s++) out.push([ax + ((r[2 * j] - ax) * s) / m, az + ((r[2 * j + 1] - az) * s) / m]);
  }
  return out;
}

// Where ring a meets ring b: the mean of a's boundary points within 0.5 m of b; across a gap, the nearest points of
// both. -> { x, z, gap, bx, bz }
function contact(a, b) {
  let sx = 0, sz = 0, n = 0;
  let best = null;
  for (const [x, z] of boundary(a)) {
    const d = ringDist(x, z, b);
    if (d < 0.5) { sx += x; sz += z; n++; }
    if (!best || d < best.d) best = { d, x, z };
  }
  if (n) return { x: sx / n, z: sz / n, gap: false };
  // across the gap: the point of b nearest a's nearest point
  let bb = null;
  for (const [x, z] of boundary(b)) {
    const d = Math.hypot(x - best.x, z - best.z);
    if (!bb || d < bb.d) bb = { d, x, z };
  }
  return { x: best.x, z: best.z, gap: true, bx: bb.x, bz: bb.z };
}

// Where a ray from inside a ring leaves it
function exitPoint(r, x, z, dx, dz) {
  let tBest = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], ex = r[2 * j] - ax, ez = r[2 * j + 1] - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((ax - x) * ez - (az - z) * ex) / den, s = ((ax - x) * dz - (az - z) * dx) / den;
    if (t > 1e-6 && s >= -1e-6 && s <= 1 + 1e-6 && t < tBest) tBest = t;
  }
  return Number.isFinite(tBest) ? [x + dx * tBest, z + dz * tBest] : [x, z];
}

// --- the bake -------------------------------------------------------------------------------------------------------------

// Edge flags of a part's outline (BEACH_ACCESS.parts[].e, one character per edge): '0' closed (shared with the next
// part, against the wall behind, a building or the promenade), '1' open side (a stone kerb & the handrail), '2' open
// but low over the ground beside (the kerb alone), '3' the foot (open to the sand), '4' against higher ground (a cheek
// wall up to the top level: a broad flight cut into the promenade's edge), '5' the sea wall's (a landing that is the
// promenade's corner: the wall's coping, and the handrail on it)
const EDGE = { closed: '0', open: '1', low: '2', foot: '3', cheek: '4', wall: '5' };

const partKey = (ref) => `${ref.layer}${ref.x},${ref.z},${(ref.clip || []).join(',')}`;

/**
 * dtm: the 1 m LiDAR (lib.mjs Grid: sample(x, z), data, x0, z0, w, h, res); walls: the shore walls detectWalls found;
 * buildings: [rings] (the 1:500 outlines a part may stand against); loadLayer.
 * Returns { data (js/donostia/data-beach-access.js), walls (the shore walls with the lines behind the accesses built in
 * front of a wall spliced in), claimed(x, z) (inside a piece the inventory took: no stairs of walls.mjs there),
 * carve [{ ring, y0, y1, u, s0, s1 } | { ring, sand }] (what build.mjs keeps the terrain under), flats [{ ring, sand }]
 * (round the accesses built in front of a wall, the sand comes down to the beach) }.
 */
export function beachAccesses({ dtm, walls, buildings = [], loadLayer, log = () => {} }) {
  const pieces = { E: [], A: [] };
  for (const [layer, file] of [['E', 'c500_ESKAILERA.json'], ['A', 'c500_ARRAPALA.json']]) {
    for (const f of loadLayer(file).features) {
      for (const r of f.g) {
        if (r.length < 6) continue;
        let x = 0, z = 0;
        for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
        pieces[layer].push({ r, x: (2 * x) / r.length, z: (2 * z) / r.length });
      }
    }
  }
  const find = (ref) => {
    let best = null;
    for (const p of pieces[ref.layer]) {
      const d = Math.hypot(p.x - ref.x, p.z - ref.z);
      if (d < 0.6 && (!best || d < best.d)) best = { d, p };
    }
    if (!best) throw new Error(`beach accesses: no ${ref.layer === 'E' ? 'ESKAILERA' : 'ARRAPALA'} piece at (${ref.x}, ${ref.z})`);
    return best.p;
  };
  const kota = loadLayer('c500_KotaPuntuak.json').features.map((f) => [f.g[0], f.g[1], f.p.Kota]);
  const beachRings = loadLayer('c500_HONDARTZA.json').features.flatMap((f) => f.g.filter((r) => r.length >= 6));
  const onBeach = (x, z) => beachRings.some((r) => pointInRing(x, z, r));
  const lidar = (x, z) => dtm.sample(x, z);

  // The sand at the foot of a chain leaving (x, z) along (ux, uz) from a level `top`: the nearest spot height within 7 m
  // that lies on the beach (or well below), else the LiDAR's lower third in a half ring 2.5-4 m ahead & to the sides
  const sandAt = (x, z, ux, uz, top) => {
    let best = null;
    for (const [kx, kz, h] of kota) {
      const d = Math.hypot(kx - x, kz - z);
      if (d > 7 || h > top - 0.8 || !(onBeach(kx, kz) || h < top - 2)) continue;
      if (!best || d < best.d) best = { d, h };
    }
    if (best) return best.h;
    const hs = [];
    for (let a = -90; a <= 90; a += 15) {
      const c = Math.cos((a * Math.PI) / 180), s = Math.sin((a * Math.PI) / 180);
      const dx = ux * c - uz * s, dz = uz * c + ux * s;
      for (const t of [2.5, 3.25, 4]) { const v = lidar(x + dx * t, z + dz * t); if (Number.isFinite(v)) hs.push(v); }
    }
    hs.sort((a, b) => a - b);
    return hs.length ? hs[Math.floor(hs.length / 3)] : top - 2;
  };

  // the buildings near the accesses (a part's side against a building is closed)
  const near = [];
  for (const spec of ACCESS) for (const chain of spec.chains) for (const ref of chain) near.push([ref.x, ref.z]);
  buildings = buildings.filter((r) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let k = 0; k < r.length; k += 2) { x0 = Math.min(x0, r[k]); x1 = Math.max(x1, r[k]); z0 = Math.min(z0, r[k + 1]); z1 = Math.max(z1, r[k + 1]); }
    return near.some(([x, z]) => x > x0 - 60 && x < x1 + 60 && z > z0 - 60 && z < z1 + 60);
  });
  const claimedRings = [];
  // claimed: the 1:500 pieces the inventory takes (but the landmark's), by the mean of their outline's vertices: the
  // ground bake leaves them out of its stairs surface
  const out = { accesses: [], parts: [], rails: [], openings: [], barandilla: [], claimed: [] };
  const claim = (spec, ref) => {
    if (spec.landmark) return;
    const p = find(ref);
    out.claimed.push(r2(p.x), r2(p.z));
  };
  const carve = [], flats = [], lines = [];
  let nSteps = 0;
  for (const spec of ACCESS) {
    for (const ref of spec.skip || []) { claimedRings.push(cleanRing(find(ref).r)); claim(spec, ref); }
    // the parts, each built once even where two chains share it (a landing that two flights leave)
    const partOf = new Map();
    const chains = spec.chains.map((chain) => chain.map((ref) => {
      const key = partKey(ref);
      if (!partOf.has(key)) {
        if (![...partOf.values()].some((o) => o.ref.x === ref.x && o.ref.z === ref.z && o.ref.layer === ref.layer)) claim(spec, ref);
        let ring = cleanRing(find(ref).r);
        claimedRings.push(ring);
        if (ref.clip) ring = cleanRing(clipLeft(ring, ref.clip));
        const kind = ref.t || (ref.layer === 'A' ? 'R' : 'F');
        partOf.set(key, { ring, kind, ref, key, c: centroid(ring), axis: mainAxis(ring) });
      }
      return partOf.get(key);
    }));
    if (spec.landmark || spec.unbuilt) {
      for (const p of partOf.values()) {
        const hs = boundary(p.ring, 0.5).map(([x, z]) => lidar(x, z)).filter(Number.isFinite).sort((a, b) => a - b);
        carve.push({ ring: p.ring, sand: hs.length ? hs[0] : 0 });
      }
      out.accesses.push([spec.id, spec.beach, spec.type, 0]);
      continue;
    }
    const material = spec.beach === 'zurriola' ? WALL.zurriola : WALL.concha;
    const built = new Map(); // key -> the part as built (levels fixed by the first chain that reaches it)
    const accParts = [];
    chains.forEach((chain, ci) => {
      const n = chain.length;
      const ends = chain.map(() => ({}));
      for (let i = 0; i + 1 < n; i++) {
        const ab = contact(chain[i].ring, chain[i + 1].ring), ba = contact(chain[i + 1].ring, chain[i].ring);
        ends[i].exit = [ab.x, ab.z];
        ends[i + 1].entry = [ba.x, ba.z];
        if (ab.gap) ends[i].gap = [ab.x, ab.z, ab.bx, ab.bz];
      }
      chain.forEach((p, i) => {
        const e = ends[i];
        let u;
        if (p.ref.dir) u = p.ref.dir;
        else if (e.entry && e.exit) u = [e.exit[0] - e.entry[0], e.exit[1] - e.entry[1]];
        else if (e.exit) u = [e.exit[0] - p.c[0], e.exit[1] - p.c[1]];
        else if (e.entry) u = [p.c[0] - e.entry[0], p.c[1] - e.entry[1]];
        else throw new Error(`beach accesses: ${spec.id}: a piece on its own needs dir`);
        const l = Math.hypot(u[0], u[1]) || 1;
        e.u = [u[0] / l, u[1] / l];
      });
      // square to each piece's sides where nearly so; a squarish piece takes the way of the flight it continues
      chain.forEach((p, i) => {
        if (p.ref.dir) return;
        const e = ends[i];
        const squarish = p.axis.len < 1.35 * p.axis.wid;
        const nb = [ends[i - 1], ends[i + 1]].filter((o, k) => o && !chain[i - 1 + 2 * k].ref.t && chain[i - 1 + 2 * k].axis.len >= 1.35 * chain[i - 1 + 2 * k].axis.wid);
        if (squarish && nb.length && e.u[0] * nb[0].u[0] + e.u[1] * nb[0].u[1] > Math.cos((40 * Math.PI) / 180)) {
          e.u = nb[0].u.slice();
          return;
        }
        const { ux, uz } = p.axis;
        for (const [ax, az] of [[ux, uz], [-ux, -uz], [-uz, ux], [uz, -ux]]) {
          if (e.u[0] * ax + e.u[1] * az > Math.cos((25 * Math.PI) / 180)) { e.u = [ax, az]; break; }
        }
      });
      chain.forEach((p, i) => {
        const e = ends[i];
        let s0 = Infinity, s1 = -Infinity;
        for (let k = 0; k < p.ring.length; k += 2) {
          const s = p.ring[k] * e.u[0] + p.ring[k + 1] * e.u[1];
          s0 = Math.min(s0, s); s1 = Math.max(s1, s);
        }
        e.s0 = s0; e.s1 = s1;
        e.run = p.kind === 'L' || built.has(p.key) ? 0 : s1 - s0;
        if (!e.entry) e.entry = exitPoint(p.ring, p.c[0], p.c[1], -e.u[0], -e.u[1]);
        if (!e.exit) e.exit = exitPoint(p.ring, p.c[0], p.c[1], e.u[0], e.u[1]);
      });
      // levels: the chain's top & foot and the anchors between (spot heights, parts an earlier chain built), shared out over
      // the flights' & ramps' runs
      const top = spec.tops ? spec.tops[ci] : chain[0].ref.y ?? spec.top;
      let bot = spec.bots ? spec.bots[ci] : spec.bot;
      const le = ends[n - 1];
      const anchors = [[0, top]];
      chain.forEach((p, i) => {
        if (i === 0) return;
        if (built.has(p.key)) anchors.push([i, built.get(p.key).y[0]], [i + 1, built.get(p.key).y[1]]);
        else if (p.ref.y != null) anchors.push([i, p.ref.y]);
      });
      if (bot == null) bot = sandAt(le.exit[0], le.exit[1], le.u[0], le.u[1], anchors[anchors.length - 1][1]) - (chain[n - 1].kind === 'F' ? BURY : 0);
      anchors.push([n, bot]);
      const levels = new Array(n + 1).fill(top); // levels[i]: the top of part i; levels[n]: the foot
      for (let a = 0; a + 1 < anchors.length; a++) {
        const [i0, y0] = anchors[a], [i1, y1] = anchors[a + 1];
        if (i1 <= i0) continue;
        let run = 0;
        for (let i = i0; i < i1; i++) run += ends[i].run;
        let acc = 0;
        for (let i = i0; i <= i1; i++) {
          levels[i] = run > 1e-6 ? y0 + ((y1 - y0) * acc) / run : y0 + ((y1 - y0) * (i - i0)) / (i1 - i0);
          if (i < i1) acc += ends[i].run;
        }
      }
      chain.forEach((p, i) => {
        if (built.has(p.key)) return;
        const e = ends[i];
        const y0 = levels[i], y1 = p.kind === 'L' ? levels[i] : levels[i + 1];
        const part = { k: p.kind === 'L' ? 'l' : p.kind === 'R' ? 'r' : 'f', p: p.ring, u: e.u, y: [y0, y1], s: [e.s0, e.s1], m: material };
        if (part.k === 'f') {
          const drop = y0 - y1;
          if (drop < 0.08) { part.k = 'l'; part.y = [y0, y0]; } else {
            part.n = Math.max(1, Math.round(drop / RISE));
            nSteps += part.n;
            const tread = (e.s1 - e.s0) / part.n;
            if (tread < 0.22 || tread > 0.6) log(`  ${spec.id}: flight at (${p.c[0].toFixed(1)}, ${p.c[1].toFixed(1)}): ${part.n} rises of ${(drop / part.n).toFixed(2)} on ${tread.toFixed(2)} m treads`);
          }
        }
        if (p.ref.prom) part.prom = true;
        part.entry = i === 0 ? e.entry : null; // the top of a chain
        part.exit = i === n - 1 ? e.exit : null; // its foot
        built.set(p.key, part);
        accParts.push(part);
      });
      // the gap between two pieces of a chain (a pier of the wall between them): a landing across it
      chain.forEach((p, i) => {
        const g = ends[i].gap;
        if (!g) return;
        const [ax, az, bx, bz] = g, dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        if (l < 0.05 || l > 3) return;
        const w = Math.min(p.axis.wid, chain[i + 1].axis.wid) / 2, nx = -dz / l, nz = dx / l;
        const ring = cleanRing([ax + nx * w, az + nz * w, bx + nx * w, bz + nz * w, bx - nx * w, bz - nz * w, ax - nx * w, az - nz * w]);
        accParts.push({ k: 'l', p: ring, u: [dx / l, dz / l], y: [levels[i + 1], levels[i + 1]], s: [0, l], m: material });
      });
      // the opening in the promenade's railing at the top
      if (top > (spec.top ?? top) - 0.4) {
        const first = chain[0];
        const w = first.kind === 'L' ? first.axis.len : first.axis.wid;
        out.openings.push([r2(ends[0].entry[0]), r2(ends[0].entry[1]), r2(Math.min(2.5, w / 2 + 0.25))]);
      }
    });

    // each part's edges: shared, against the wall behind or a building, open, the foot
    const surfaceAt = (part, x, z) => {
      if (part.k === 'l') return part.y[0];
      const t = Math.max(0, Math.min(1, (x * part.u[0] + z * part.u[1] - part.s[0]) / (part.s[1] - part.s[0] || 1)));
      return part.y[0] + (part.y[1] - part.y[0]) * t;
    };
    // towards the promenade: square to the access's main line (its parts' principal axis), on the higher side
    let landDir = spec.land || null;
    if (!landDir) {
      let mx = 0, mz = 0, np = 0;
      for (const part of accParts) for (let k = 0; k < part.p.length; k += 2) { mx += part.p[k]; mz += part.p[k + 1]; np++; }
      mx /= np; mz /= np;
      let sxx = 0, sxz = 0, szz = 0;
      for (const part of accParts) for (let k = 0; k < part.p.length; k += 2) {
        const dx = part.p[k] - mx, dz = part.p[k + 1] - mz;
        sxx += dx * dx; sxz += dx * dz; szz += dz * dz;
      }
      const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz), ax = Math.cos(ang), az = Math.sin(ang);
      let side = 0;
      for (const part of accParts) {
        for (const [x, z] of boundary(part.p, 0.5)) {
          const a = lidar(x - az * 3, z + ax * 3), b = lidar(x + az * 3, z - ax * 3);
          if (Number.isFinite(a) && Number.isFinite(b)) side += a - b;
        }
      }
      landDir = side >= 0 ? [-az, ax] : [az, -ax];
    }
    const land = new Map();
    let sand = Infinity; // the sand at the feet of its chains
    for (const part of accParts) {
      land.set(part, landDir);
      if (part.exit) sand = Math.min(sand, part.y[1] + (part.k === 'f' ? BURY : 0));
    }
    // the LiDAR's lowest round each part; in front of a wall, the parts but a corner of the promenade stand on the sand
    // (their floor: build.mjs keeps the terrain under them down there)
    for (const part of accParts) {
      let lo = Infinity;
      for (const [x, z] of boundary(part.p, 0.5)) { const v = lidar(x, z); if (Number.isFinite(v)) lo = Math.min(lo, v); }
      part.lo = lo;
      part.floor = spec.wall && Number.isFinite(sand) && !part.prom ? sand : null;
    }
    const wallEdges = [];
    for (const part of accParts) {
      const r = part.p, n = r.length / 2;
      let flags = '';
      const ld = land.get(part);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
        const len = Math.hypot(bx - ax, bz - az) || 1e-9;
        const tx = (bx - ax) / len, tz = (bz - az) / len, nx = tz, nz = -tx; // outward (rings run with positive area)
        const mx = (ax + bx) / 2, mz = (az + bz) / 2;
        const ya = surfaceAt(part, ax, az), yb = surfaceAt(part, bx, bz), y = Math.max(ya, yb);
        // a part on the sand against higher ground (a corner of the promenade, the promenade at its top or beside it, as
        // in a notch of the wall): the terrain steps there as at the wall, the masonry showing where the higher ground
        // stands above the part's surface, else hidden behind the part's own body (a hidden wall line)
        const prom = spec.deck ?? spec.top; // the promenade's level
        const step = (top) => {
          if (part.floor == null || top < part.floor + 0.3) return;
          wallEdges.push({ a: [ax, az], b: [bx, bz], deck: [top, top], foot: [part.floor, part.floor], hidden: top < y + 0.5 });
        };
        // (the promenade beyond the edge, rather than the sand in front of the wall or the heaps the LiDAR has there)
        const promBeyond = () => {
          const out = [0.8, 1.2, 1.6].map((t) => lidar(mx + nx * t, mz + nz * t)).filter(Number.isFinite);
          return out.length > 0 && Math.max(...out) > prom - 0.6;
        };
        const shared = accParts.find((o) => o !== part && (ringDist(mx, mz, o.p) < 0.4 || ringDist(mx + nx * 0.3, mz + nz * 0.3, o.p) < 0.05));
        if (shared) {
          flags += EDGE.closed;
          if (shared.floor == null) step(shared.y[0]);
          continue;
        }
        if (buildings.some((b) => pointInRing(mx + nx * 0.35, mz + nz * 0.35, b))) { flags += EDGE.closed; continue; }
        const along = Math.abs(tx * part.u[0] + tz * part.u[1]); // 1: a side of the flight, 0: across it
        if (part.entry && along < 0.5 && Math.hypot(mx - part.entry[0], mz - part.entry[1]) < len / 2 + 0.3) {
          flags += EDGE.closed;
          if (promBeyond()) step(Math.max(y, prom));
          continue;
        }
        if (part.exit && along < 0.5 && Math.hypot(mx - part.exit[0], mz - part.exit[1]) < len / 2 + 0.3) { flags += EDGE.foot; continue; }
        // a landing that is the promenade's own corner: the promenade behind, its other sides the sea wall (with a
        // handrail on its coping)
        if (part.prom) {
          if (ld && nx * ld[0] + nz * ld[1] > 0.75) { flags += EDGE.closed; continue; }
          flags += EDGE.wall;
          // (walked the other way round: the landing is the high side)
          wallEdges.push({ a: [bx, bz], b: [ax, az], deck: [y, y], foot: [sand, sand] });
          continue;
        }
        // in front of the wall: the edge on the promenade's side is the wall's, from the promenade down to the sand
        if (spec.wall && ld && nx * ld[0] + nz * ld[1] > 0.75) {
          flags += EDGE.closed;
          const deck = spec.deck ?? spec.top;
          wallEdges.push({ a: [ax, az], b: [bx, bz], deck: [deck, deck], foot: [sand, sand] });
          continue;
        }
        // in front of a wall, beside the promenade (a notch in the wall): its face, from the promenade down to the sand
        if (part.floor != null && promBeyond()) {
          flags += EDGE.closed;
          step(prom);
          continue;
        }
        // cut into higher ground (a cheek wall up to the flight's top); in front of a wall the ground beside comes down
        // to the sand (the LiDAR has the heaps the 2 m grid made of the stairs, but they fall away within 3 m)
        let ground = lidar(mx + nx * 1.2, mz + nz * 1.2);
        const out3 = lidar(mx + nx * 3, mz + nz * 3);
        const sandy = part.floor != null || (spec.wall && Number.isFinite(sand) && onBeach(mx + nx * 1.2, mz + nz * 1.2) &&
          ((Number.isFinite(ground) && ground < y - 0.3) || (Number.isFinite(out3) && out3 < y - 1)));
        if (sandy) ground = Math.min(Number.isFinite(ground) ? ground : sand, sand);
        let flag;
        if (Number.isFinite(ground) && ground > y + 0.3) flag = part.k === 'f' ? EDGE.cheek : EDGE.closed;
        else if (!Number.isFinite(ground) || y - ground > 0.6) flag = EDGE.open;
        else flag = EDGE.low;
        flags += flag;
      }
      part.e = flags;
    }

    // the wall behind: the parts' edges facing the promenade (and the cheeks), joined end to end into lines (low side on
    // (-dz, dx), as the shore walls run), the promenade (deck) behind and the sand or the steps (foot) in front
    if (wallEdges.length) {
      const used = new Set();
      const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.9;
      for (const start of wallEdges) {
        if (used.has(start)) continue;
        // walk back to the first edge of this line, then forwards
        let first = start;
        for (let guard = 0; guard < wallEdges.length; guard++) {
          const prev = wallEdges.find((o) => !used.has(o) && o !== first && near(o.b, first.a));
          if (!prev || prev === start) break;
          first = prev;
        }
        // [x, z, deck, foot] per vertex, and whether the segment after it is hidden; where two edges meet, the higher
        // deck and the lower foot
        const line = [[...first.a, first.deck[0], first.foot[0]], [...first.b, first.deck[1], first.foot[1]]];
        const hid = [!!first.hidden];
        used.add(first);
        for (let cur = first; ;) {
          const next = wallEdges.find((o) => !used.has(o) && near(o.a, cur.b));
          if (!next) break;
          used.add(next);
          const last = line[line.length - 1];
          if (Math.hypot(next.a[0] - cur.b[0], next.a[1] - cur.b[1]) > 0.05) {
            line.push([...next.a, next.deck[0], next.foot[0]]);
            hid.push(!!(cur.hidden && next.hidden));
          } else { last[2] = Math.max(last[2], next.deck[0]); last[3] = Math.min(last[3], next.foot[0]); }
          line.push([...next.b, next.deck[1], next.foot[1]]);
          hid.push(!!next.hidden);
          cur = next;
        }
        // simplified run by run (a hidden run and a visible one keep the vertex between them); hs: whether the segment
        // after each vertex is hidden
        const p = [], hs = [];
        for (let i = 0; i < hid.length;) {
          let j = i;
          while (j + 1 < hid.length && hid[j + 1] === hid[i]) j++;
          const run = simplifyLine(line.slice(i, j + 2), hid[i] ? 0.15 : 0.45);
          for (let q = p.length ? 1 : 0; q < run.length; q++) {
            const [x, z, deck, foot] = run[q];
            p.push(x, z, deck, Math.min(foot, deck - (hid[i] ? 0 : 1)));
          }
          for (let q = 0; q < run.length - 1; q++) hs.push(hid[i] ? 1 : 0);
          i = j + 1;
        }
        hs.push(0);
        if (p.length < 8) continue;
        lines.push({ t: material, b: 0, p, hs, access: spec.id });
      }
    }

    // the beach's edge as the wall on from the access (the promenade behind from the LiDAR, the access's sand in front)
    for (const [x0, z0, x1, z1] of spec.beachEdge || []) {
      let best = null;
      for (const r of beachRings) {
        const n = r.length / 2;
        const nearest = (x, z) => { let bi = 0, bd = Infinity; for (let i = 0; i < n; i++) { const d = Math.hypot(r[2 * i] - x, r[2 * i + 1] - z); if (d < bd) { bd = d; bi = i; } } return [bi, bd]; };
        const [i0, d0] = nearest(x0, z0), [i1, d1] = nearest(x1, z1);
        if (!best || d0 + d1 < best.d) best = { r, n, i0, i1, d: d0 + d1 };
      }
      const { r, n, i0, i1 } = best;
      const fwd = (i1 - i0 + n) % n, back = (i0 - i1 + n) % n;
      const pts = [];
      for (let k = 0; k <= Math.min(fwd, back); k++) {
        const i = fwd <= back ? (i0 + k) % n : (i0 - k + n) % n;
        pts.push([r[2 * i], r[2 * i + 1]]);
      }
      // walked so the beach (inside its ring, which runs with positive area: on the (-dz, dx) side) lies on the low side
      if (fwd > back === ringArea(r) > 0) pts.reverse();
      // every 0.5 m, smoothed over 3 m (the map's edge jogs round every buttress and pillar)
      let even = [];
      for (let k = 0; k + 1 < pts.length; k++) {
        const [ax, az] = pts[k], [bx, bz] = pts[k + 1], m = Math.max(1, Math.round(Math.hypot(bx - ax, bz - az) / 0.5));
        for (let q = 0; q < m; q++) even.push([ax + ((bx - ax) * q) / m, az + ((bz - az) * q) / m]);
      }
      even.push(pts[pts.length - 1]);
      for (let pass = 0; pass < 2; pass++) {
        even = even.map((q, k) => {
          if (k === 0 || k === even.length - 1) return q;
          let sx = 0, sz = 0, c = 0;
          for (let j = Math.max(0, k - 3); j <= Math.min(even.length - 1, k + 3); j++) { sx += even[j][0]; sz += even[j][1]; c++; }
          return [sx / c, sz / c];
        });
      }
      const p = [];
      for (const [x, z] of simplifyLine(even, 0.08)) {
        const k = even.findIndex((q) => q[0] === x && q[1] === z);
        const a = even[Math.max(0, k - 1)], b = even[Math.min(even.length - 1, k + 1)];
        const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, nx = (b[1] - a[1]) / l, nz = -(b[0] - a[0]) / l; // towards the land
        const deck = Math.max(...[1.5, 2, 2.5, 3].map((t) => lidar(x + nx * t, z + nz * t)).filter(Number.isFinite), spec.top - 2);
        p.push(x, z, Math.min(deck, spec.top + 0.3), Math.min(sand, deck - 1));
      }
      lines.push({ t: material, b: 0, p, hs: new Array(p.length / 4).fill(0), access: spec.id });
    }

    // handrails (or La Concha's railing) along the open sides, joined across the parts of a flight
    const railSegs = [];
    for (const part of accParts) {
      const r = part.p, n = r.length / 2;
      for (let i = 0; i < n; i++) {
        if (part.e[i] !== EDGE.open && part.e[i] !== EDGE.wall) continue;
        const j = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * j], bz = r[2 * j + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.4) continue;
        const nx = (bz - az) / len, nz = -(bx - ax) / len;
        if (spec.rail === 'barandilla') {
          // its plinth on the edge, the sea outside: travelling b -> a keeps the sea on (-dz, dx)
          railSegs.push({ a: [bx, surfaceAt(part, bx, bz), bz], b: [ax, surfaceAt(part, ax, az), az] });
        } else if (spec.rail) {
          const inset = part.e[i] === EDGE.wall ? 0.25 : 0.12;
          const pa = [ax - nx * inset, az - nz * inset], pb = [bx - nx * inset, bz - nz * inset];
          const lift = (part.e[i] === EDGE.wall ? 0.08 : UPSTAND) + RAIL_H;
          railSegs.push({ a: [pa[0], surfaceAt(part, ...pa) + lift, pa[1]], b: [pb[0], surfaceAt(part, ...pb) + lift, pb[1]] });
        }
      }
    }
    const runs = [];
    const used = new Set();
    for (const s of railSegs) {
      if (used.has(s)) continue;
      used.add(s);
      const run = [s.a, s.b];
      for (let grown = true; grown;) {
        grown = false;
        for (const o of railSegs) {
          if (used.has(o)) continue;
          const tail = run[run.length - 1], head = run[0];
          if (Math.hypot(o.a[0] - tail[0], o.a[2] - tail[2]) < 0.35) { run.push(o.b); used.add(o); grown = true; }
          else if (Math.hypot(o.b[0] - head[0], o.b[2] - head[2]) < 0.35) { run.unshift(o.a); used.add(o); grown = true; }
        }
      }
      if (spec.rail === 'barandilla') out.barandilla.push(run.flat().map(r2));
      else out.rails.push({ a: out.accesses.length, t: spec.rail, p: run.flat().map(r2) });
    }

    // the terrain: kept under every part; round the accesses built in front of a wall, the sand down to the beach
    for (const part of accParts) {
      const lo = part.lo;
      // (in front of a wall the masonry stands on the beach: down under the sand at the foot)
      part.base = Math.min(part.y[1], lo, spec.wall && Number.isFinite(sand) ? sand : Infinity) - BASE;
      // (in front of a wall, nothing behind the part's side against it: the promenade stays)
      const back = spec.wall ? landDir : null;
      // (in front of a wall the access stands on the sand like a block of masonry: the terrain under it goes down to the
      // sand, so the ground steps only at the wall's line behind it; a landing that is the promenade's corner stays)
      const floor = spec.wall && Number.isFinite(sand) && !part.prom ? sand : null;
      carve.push({ ring: part.p, y0: part.y[0], y1: part.y[1], u: part.u, s0: part.s[0], s1: part.s[1], back, built: true, e: part.e, floor });
    }
    if (spec.wall && Number.isFinite(sand)) {
      for (const part of accParts) {
        if (part.prom) continue;
        flats.push({ ring: part.p, sand, top: spec.top, back: landDir });
      }
    }
    for (const part of accParts) {
      out.parts.push({
        a: out.accesses.length, k: part.k, m: part.m, p: part.p.map(r2), u: part.u.map(r3), y: part.y.map(r2), s: part.s.map(r2),
        ...(part.n ? { n: part.n } : {}), b: r2(part.base), e: part.e
      });
    }
    out.accesses.push([spec.id, spec.beach, spec.type, accParts.length, spec.rail || '']);
  }

  // the wall lines behind the accesses, spliced onto the shore walls they continue (and onto each other, across the piers
  // between two flights): the same kind of wall, an end within JOIN, and the join turning less than 50° from either (else
  // the join's low side could face the promenade)
  const JOIN = 6, JOIN_SAME = 7; // (two lines of one access: across the head of a double flight)
  const FILLET = { r: 1.0, min: (30 * Math.PI) / 180, step: (20 * Math.PI) / 180 }; // m, rad
  const EASE = 3.5;
  const ownVertex = new Set(); // the access lines' vertices, never eased away
  // first the shore walls lose what runs over the parts (the LiDAR's wall along a flight's or ramp's outer side, which
  // its own masonry now faces), split where they cross one
  // (and, in front of a wall, what runs round a part's outer side within 2.5 m: the drop from the steps to the sand, which
  // the part's own masonry faces)
  const trims = ACCESS.flatMap((spec) => spec.trim || []);
  const over = (x, z) => carve.some((c) => {
    if (!c.built) return false;
    const d = ringDist(x, z, c.ring);
    if (d < 0.3) return true;
    if (!c.back || d >= 2.5 || !seawardOf(c.ring, c.back, x, z)) return false;
    // (beside the part, not on beyond its ends: the wall the access's own line carries on)
    const ax = -c.back[1], az = c.back[0], t = x * ax + z * az;
    let a0 = Infinity, a1 = -Infinity;
    for (let k = 0; k < c.ring.length; k += 2) { const v = c.ring[k] * ax + c.ring[k + 1] * az; a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
    return t > a0 + 0.3 && t < a1 - 0.3;
  }) || trims.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1);
  const merged = [];
  let cut = 0;
  for (const w of walls) {
    let cur = [];
    const flush = () => { if (cur.length >= 8) merged.push({ t: w.t, b: w.b, p: cur, hs: new Array(cur.length / 4).fill(0) }); cur = []; };
    for (let k = 0; k < w.p.length; k += 4) {
      const x = w.p[k], z = w.p[k + 1];
      // the segment from the previous vertex crosses a part?
      let crosses = false;
      if (cur.length) {
        const px = cur[cur.length - 4], pz = cur[cur.length - 3], l = Math.hypot(x - px, z - pz);
        for (let t = 0.25; t < l; t += 0.25) if (over(px + ((x - px) * t) / l, pz + ((z - pz) * t) / l)) { crosses = true; break; }
      }
      if (over(x, z) || crosses) { cut++; flush(); if (!over(x, z)) cur.push(...w.p.slice(k, k + 4)); continue; }
      cur.push(...w.p.slice(k, k + 4));
    }
    flush();
  }
  let spliced = 0;
  const unit = (x, z) => { const l = Math.hypot(x, z) || 1; return [x / l, z / l]; };
  const smooth = (a, b, c, gap, same) => {
    // a -> b -> c (b may coincide with a or c) turns by less than 50° at each corner (80° across a gap under 6 m: the
    // jog between a wall the LiDAR placed and the access's outline; 125° between two lines of one access within 1.5 m,
    // 100° further, round the corner of a landing): never back on itself, which would turn the low side round
    const d1 = unit(b[0] - a[0], b[1] - a[1]), d2 = unit(c[0] - b[0], c[1] - b[1]), d0 = unit(c[0] - a[0], c[1] - a[1]);
    const limit = same ? (gap < 1.5 ? 125 : 100) : gap < 6 ? 80 : 50;
    const ok = (u, v) => u[0] * v[0] + u[1] * v[1] > Math.cos((limit * Math.PI) / 180);
    return Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05 || Math.hypot(c[0] - b[0], c[1] - b[1]) < 0.05 ? ok(d0, d0) : ok(d1, d2);
  };
  // a shore wall the LiDAR placed off the access's line, where it would join with a sharp jog, comes back to it gently:
  // its vertices within EASE of the join are dropped (never an access line's own)
  const ease = (w, fromEnd, x, z) => {
    const q = w.p, k = q.length / 4;
    let drop = 0;
    for (let i = 0; i < k - 2; i++) {
      const v = fromEnd ? k - 1 - i : i;
      if (ownVertex.has(`${q[4 * v]},${q[4 * v + 1]}`) || Math.hypot(q[4 * v] - x, q[4 * v + 1] - z) >= EASE) break;
      drop = i + 1;
    }
    return fromEnd ? { p: q.slice(0, q.length - 4 * drop), hs: w.hs.slice(0, k - drop) } : { p: q.slice(4 * drop), hs: w.hs.slice(drop) };
  };
  // a join may not cross a part, nor run between two (between two lines of one access: the head of a flight off a landing)
  const crossesPart = (ax, az, bx, bz) => {
    const l = Math.hypot(bx - ax, bz - az);
    for (let t = 0.4; t < l - 0.4; t += 0.2) {
      const x = ax + ((bx - ax) * t) / l, z = az + ((bz - az) * t) / l;
      // (inside a part, or on the edge between two)
      let on = 0;
      for (const c of carve) {
        if (!c.built) continue;
        const d = ringDist(x, z, c.ring);
        if (d < -0.15) return true;
        if (d < 0.05) on++;
      }
      if (on >= 2) return true;
    }
    return false;
  };
  for (const line of lines) {
    const p = line.p, m = p.length / 4;
    const at = (q, i) => [q[4 * i], q[4 * i + 1]];
    let host = null;
    // a shore wall that ends where the line starts, or starts where it ends (as eased)
    for (const w of merged) {
      if (w.t !== line.t || w === line || w.p.length < 8) continue;
      const same = !!w.accs?.has(line.access), reach = same ? JOIN_SAME : JOIN;
      const q = w.p, k = q.length / 4;
      const gt = Math.hypot(q[4 * k - 4] - p[0], q[4 * k - 3] - p[1]), gh = Math.hypot(q[0] - p[4 * m - 4], q[1] - p[4 * m - 3]);
      // (as it is if the join turns gently enough, else eased)
      if (!host?.tail && gt < reach) {
        for (const we of [w, ease(w, true, p[0], p[1])]) {
          const qe = we.p, ke = qe.length / 4, end = at(qe, ke - 1);
          if (smooth(at(qe, ke - 2), end, at(p, 0), gt, same) && smooth(end, at(p, 0), at(p, Math.min(1, m - 1)), gt, same) &&
            !crossesPart(end[0], end[1], p[0], p[1])) { host = { ...host, tail: w, tailW: { p: qe.slice(), hs: we.hs.slice() } }; break; }
        }
      }
      if (!host?.head && gh < reach) {
        for (const we of [w, ease(w, false, p[4 * m - 4], p[4 * m - 3])]) {
          const qe = we.p, start = at(qe, 0);
          if (smooth(at(p, Math.max(0, m - 2)), at(p, m - 1), start, gh, same) && smooth(at(p, m - 1), start, at(qe, 1), gh, same) &&
            !crossesPart(p[4 * m - 4], p[4 * m - 3], start[0], start[1])) { host = { ...host, head: w, headW: { p: qe.slice(), hs: we.hs.slice() } }; break; }
        }
      }
    }
    let joined = line;
    line.accs = new Set([line.access]);
    for (let k = 0; k < p.length; k += 4) ownVertex.add(`${p[k]},${p[k + 1]}`);
    // (the segment that bridges a join is a visible wall)
    if (host?.tail) {
      host.tail.p = [...host.tailW.p, ...p];
      host.tail.hs = [...host.tailW.hs.slice(0, -1), 0, ...line.hs];
      joined = host.tail;
      spliced++;
    } else merged.push(line);
    joined.accs = new Set([...(joined.accs || []), line.access]);
    if (host?.head && host.head !== joined) {
      joined.p = [...joined.p, ...host.headW.p];
      joined.hs = [...joined.hs.slice(0, -1), 0, ...host.headW.hs];
      for (const a of host.head.accs || []) joined.accs.add(a);
      merged.splice(merged.indexOf(host.head), 1);
      spliced++;
    }
  }
  // the access lines' corners rounded (a 2 m terrain sample by a sharp corner may snap to the segment beyond it while its
  // neighbour across the wall snaps to the one before, and the triangle between them would slope across the corner)
  let fillets = 0;
  for (const w of merged) {
    if (!w.accs) continue;
    const { p: q, hs } = w, n = q.length / 4;
    const out = [], ohs = [];
    const push = (x, z, deck, foot, h) => { out.push(x, z, deck, foot); ohs.push(h); };
    for (let k = 0; k < n; k++) {
      const x = q[4 * k], z = q[4 * k + 1], deck = q[4 * k + 2], foot = q[4 * k + 3];
      if (k === 0 || k === n - 1) { push(x, z, deck, foot, hs[k]); continue; }
      const px = q[4 * k - 4], pz = q[4 * k - 3], nx = q[4 * k + 4], nz = q[4 * k + 5];
      const l1 = Math.hypot(x - px, z - pz), l2 = Math.hypot(nx - x, nz - z);
      if (l1 < 1e-3 || l2 < 1e-3) { push(x, z, deck, foot, hs[k]); continue; }
      const d1 = [(x - px) / l1, (z - pz) / l1], d2 = [(nx - x) / l2, (nz - z) / l2];
      const turn = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
      // (not where a hidden run starts or ends: those follow the parts' own outlines, which their masonry faces)
      if (turn < FILLET.min || hs[k - 1] || hs[k]) { push(x, z, deck, foot, hs[k]); continue; }
      const t = Math.min(FILLET.r * Math.tan(turn / 2), 0.45 * l1, 0.45 * l2);
      const at = (u) => {
        // a quadratic Bézier from t before the corner to t after it, the corner its control point
        const ax = x - d1[0] * t, az = z - d1[1] * t, bx = x + d2[0] * t, bz = z + d2[1] * t;
        return [(1 - u) * (1 - u) * ax + 2 * u * (1 - u) * x + u * u * bx, (1 - u) * (1 - u) * az + 2 * u * (1 - u) * z + u * u * bz];
      };
      const lerp = (o, f) => q[4 * k + o] + (q[4 * (k + (f > 0 ? 1 : -1)) + o] - q[4 * k + o]) * Math.abs(f);
      const m = Math.max(2, Math.ceil(turn / FILLET.step));
      for (let i = 0; i <= m; i++) {
        const u = i / m, [fx, fz] = at(u);
        // the levels: along the segment before, at the corner, along the one after
        const f = u < 0.5 ? -(1 - 2 * u) * (t / l1) : (2 * u - 1) * (t / l2);
        push(fx, fz, lerp(2, f), lerp(3, f), u < 0.5 ? hs[k - 1] : hs[k]);
      }
      fillets++;
    }
    w.p = out;
    w.hs = ohs;
  }
  // GEO.terrain.walls: { t, b, p, h (optional: the hidden segments as runs [first, last + 1, ...]) }
  let hidden = 0;
  for (let i = 0; i < merged.length; i++) {
    const w = merged[i], h = [];
    for (let k = 0; k < w.hs.length - 1; k++) {
      if (!w.hs[k]) continue;
      hidden++;
      if (h.length && h[h.length - 1] === k) h[h.length - 1] = k + 1;
      else h.push(k, k + 1);
    }
    merged[i] = { t: w.t, b: w.b, p: w.p.map(r2), ...(h.length ? { h } : {}) };
  }

  const claimed = (x, z) => claimedRings.some((r) => pointInRing(x, z, r));
  log(`beach accesses: ${out.accesses.length} (${out.accesses.filter((a) => a[3]).length} built), ${out.parts.length} parts, ` +
    `${nSteps} steps, ${out.rails.length} handrails, ${out.barandilla.length} runs of railing; ${lines.length} wall lines behind ` +
    `them (${spliced} joined to the shore walls; ${hidden} hidden segments along the parts' open sides; ${fillets} corners ` +
    `rounded), ${cut} shore wall ` +
    `vertices over them dropped`);
  return { data: out, walls: merged, claimed, carve, flats, onBeach };
}

/**
 * Keeps the terrain grid { x0, z0, w, h, res, data } under the accesses (beachAccesses' carve & flats): inside each part
 * a little under its surface (its masonry goes on below), within reach of it no higher than its surface; under the
 * pieces left to others (the Caseta Real's flights) and the unbuilt ones, down to the sand; round the accesses built in
 * front of a wall, the sand that the 2 m grid heaped against the steps comes down to the beach, fading out by 6.5 m.
 * classes (optional, the ground class per sample): the samples brought down to the sand become `beach`. Returns the
 * number of samples changed.
 */
export function carveTerrain(grid, { carve, flats, onBeach, walls }, classes = null, beach = -1, stairs = -1) {
  const { x0, z0, w, h, res, data } = grid;
  let changed = 0;
  // in front of the walls (on the low side of the nearest within 4 m; by the part's own outline where there is none)
  const shown = walls, index = wallIndex(shown, 16, 4);
  const inFront = (ring, back, x, z, y, top) => {
    const q = nearestWall(shown, x, z, 4, index);
    if (q && !q.end) return q.d > 0;
    // (beyond the walls' ends, the promenade at the access's top is not)
    return seawardOf(ring, back, x, z) && y < top - 1;
  };
  const cells = (ring, pad, visit) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]); minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
    }
    const i0 = Math.max(0, Math.floor((minX - pad - x0) / res)), i1 = Math.min(w - 1, Math.ceil((maxX + pad - x0) / res));
    const j0 = Math.max(0, Math.floor((minZ - pad - z0) / res)), j1 = Math.min(h - 1, Math.ceil((maxZ + pad - z0) / res));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + (i + 0.5) * res, z = z0 + (j + 0.5) * res;
      const d = ringDist(x, z, ring);
      if (d < pad) visit(j * w + i, x, z, d);
    }
  };
  const set = (k, v) => { if (v < data[k] - 0.005) { data[k] = v; changed++; } };
  for (const c of carve) {
    if (c.sand != null) { cells(c.ring, 0.8, (k) => set(k, c.sand)); continue; }
    const surface = (x, z) => {
      const t = Math.max(0, Math.min(1, (x * c.u[0] + z * c.u[1] - c.s0) / (c.s1 - c.s0 || 1)));
      return c.y0 + (c.y1 - c.y0) * t;
    };
    cells(c.ring, 0.8, (k, x, z, d) => {
      if (d >= 0) {
        // outside: only beside its open sides & its foot (not beyond the top, a wall or a cheek)
        if (c.back && !inFront(c.ring, c.back, x, z, data[k], c.y0)) return;
        const e = nearestEdge(c.ring, x, z);
        if (c.e && !'123'.includes(c.e[e])) return;
      }
      set(k, d < 0 ? Math.min(surface(x, z) - 0.2, c.floor ?? Infinity) : surface(x, z));
    });
  }
  // the heaps round the accesses in front of a wall: on the municipal map's beach (or seaward of the parts) within FLAT
  // of a part, outside the parts
  const FLAT = [4.5, 6.5]; // m: flat out to the first, fading out by the second
  const seen = new Map();
  for (const f of flats) {
    cells(f.ring, FLAT[1], (k, x, z, d) => {
      if (d <= 0.05) return;
      if (!(d < 2.5 && inFront(f.ring, f.back, x, z, data[k], f.top)) && !onBeach(x, z)) return;
      const prev = seen.get(k);
      if (!prev || d < prev.d) seen.set(k, { d, sand: f.sand, top: f.top });
    });
  }
  for (const [k, { d, sand, top }] of seen) {
    const v = data[k];
    if (v <= sand + 0.05 || v > top + 0.5) continue;
    const keep = Math.max(0, Math.min(1, (d - FLAT[0]) / (FLAT[1] - FLAT[0])));
    const target = sand + 0.02 + (v - sand - 0.02) * keep * keep * (3 - 2 * keep);
    if (target < v - 0.005) {
      data[k] = target;
      changed++;
      if (classes && keep < 0.5 && classes[k] === stairs) classes[k] = beach;
    }
  }
  return changed;
}
