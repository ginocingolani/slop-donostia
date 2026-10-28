// tools/donostia/port.mjs
// The port's outlines shared by tools/donostia/bake-marina.mjs (its moorings, the harbour's water),
// tools/donostia/bake-shore.mjs (no loose rocks on its quays and slipway, concrete cubes on its moles' armour),
// tools/donostia/bake-ground.mjs (its quays' ground, the woods over it) and tools/donostia/bake-streetscape.mjs (their
// trees).

// walls.mjs's PORT box: the quays and moles become walls there
export const PORT = { minX: -330, maxX: 170, minZ: -270, maxZ: -20 };
export const inPort = (x, z) => x >= PORT.minX && x <= PORT.maxX && z >= PORT.minZ && z <= PORT.maxZ;

// Urgull's slopes over the port, from behind the Aquarium to the north basin, between the houses of Kaiko pasealekua and
// the paths above: the municipal map leaves most of them blank (its woodland stops short of them) and the 2 m terrain
// draws them steep enough for the ground's crag rock, where the 2025 orthophoto shows a closed canopy.
// tools/donostia/bake-ground.mjs paints the blank ground there as woodland and tools/donostia/bake-streetscape.mjs
// plants it: (x, z), the terrain's height h and its gradient (rise per metre).
const URGULL_SLOPES = { minX: -305, maxX: 60, minZ: -270, maxZ: -180 };
export const urgullWoods = (x, z, h, grad) => x >= URGULL_SLOPES.minX && x <= URGULL_SLOPES.maxX &&
  z >= URGULL_SLOPES.minZ && z <= URGULL_SLOPES.maxZ && h > 8 && grad > 0.45;

// The two moles round the harbour (OSM man_made=breakwater): the marina's, from the harbour mouth to the Real Club
// Náutico, and the old port's west mole below the Aquarium. Their seaward flanks are banks of concrete cubes (the 2025
// orthophoto), the rest of each outline the paved promenade on top (the municipal quays, KAIA).
export const MOLES = [859798080, 859798081];

// The harbour's water inside the moles (the ring runs over their crests, so the open sea stays outside) and its mouth
// between the two pierheads: x, z, width (m). Drawn on the 2025 orthophoto (Eusko Jaurlaritza / Gobierno Vasco.
// geoEuskadi).
export const HARBOUR = [
  -300, -160, -262, -141, -200, -129, -150, -117, -124, -110, // the west mole, to its head
  -101, -124, -62, -115, -30, -104, 40, -82, 110, -60, 140, -52, // the marina's mole
  165, -40, 165, -285, -300, -285
];
export const MOUTH = [-112.5, -117, 22];

// The old port's slipway below Kaiarriba: the notch the municipal quays (KAIA's port ring) leave there, open to the water,
// cut off at its toe. Flat [x, z, ...] or null.
const SLIPWAY_BOX = { minX: -246, maxX: -168, minZ: -166, maxZ: -125 }, SLIPWAY_TOE = -184;
export function slipwayRing(loadLayer) {
  const quays = loadLayer('c500_KAIA.json').features.flatMap((f) => f.g);
  // the port's ring: the one with most vertices in the box
  const inside = (r, i) => r[2 * i] >= SLIPWAY_BOX.minX && r[2 * i] <= SLIPWAY_BOX.maxX && r[2 * i + 1] >= SLIPWAY_BOX.minZ && r[2 * i + 1] <= SLIPWAY_BOX.maxZ;
  let ring = null, most = 0;
  for (const r of quays) {
    let c = 0;
    for (let i = 0; i < r.length / 2; i++) if (inside(r, i)) c++;
    if (c > most) { most = c; ring = r; }
  }
  if (!ring) return null;
  // the longest run of consecutive vertices in the box
  const n = ring.length / 2;
  let best = [], run = [];
  for (let i = 0; i < 2 * n; i++) {
    if (inside(ring, i % n)) run.push(i % n); else run = [];
    if (run.length > best.length && run.length <= n) best = run.slice();
  }
  const pts = best.map((i) => [ring[2 * i], ring[2 * i + 1]]);
  // clip at the toe (Sutherland-Hodgman against x <= SLIPWAY_TOE)
  const out = [];
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k], b = pts[(k + 1) % pts.length];
    const ia = a[0] <= SLIPWAY_TOE, ib = b[0] <= SLIPWAY_TOE;
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (SLIPWAY_TOE - a[0]) / (b[0] - a[0]);
      out.push([SLIPWAY_TOE, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out.length >= 3 ? out.flat().map((v) => Math.round(v * 100) / 100) : null;
}
