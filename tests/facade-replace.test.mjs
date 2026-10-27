import assert from 'node:assert/strict';
import test from 'node:test';
import { GEO } from '../js/donostia/geodata.js';
import { buildFacadeCells } from '../js/donostia/facade-mesh.js';

// A landmark that keeps the city's buildings but changes them (js/donostia/landmarks/konstituzio-plaza.js): replaced
// records with `skip` stretches leave those walls to the landmark, and a phantom keeps its neighbours' party walls
// hidden although the building it stands for is hidden from the extrusions

const KP2 = 4978, LIBRARY = 541, NEIGHBOUR = 1745; // Konstituzio plaza 2, the old City Hall, Joan de Bilbao k. 17
const triangulate = (c) => { const out = []; for (let i = 1; i + 1 < c.length; i++) out.push([0, i, i + 1]); return out; };

// Only the square's corner: the three buildings, so the builds stay quick
function corner() {
  const sparse = new Array(GEO.buildings.length);
  for (const j of [KP2, LIBRARY, NEIGHBOUR]) sparse[j] = GEO.buildings[j];
  return { ...GEO, buildings: sparse };
}

// Wall triangles of building j whose centre lies within `d` metres of the segment a -> b ([x, z]), off its ends
function wallsNear(cells, j, a, b, d = 0.4) {
  let n = 0;
  const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez;
  for (const cell of cells.values()) {
    const p = cell.walls;
    for (let k = 0; k < p.ni; k += 3) {
      const v = [p.index[k], p.index[k + 1], p.index[k + 2]];
      if (v.some((i) => p.owner[i] !== j)) continue;
      const x = v.reduce((s, i) => s + p.pos[3 * i], 0) / 3, z = v.reduce((s, i) => s + p.pos[3 * i + 2], 0) / 3;
      const t = ((x - a[0]) * ex + (z - a[1]) * ez) / l2;
      if (t > 0.02 && t < 0.98 && Math.hypot(x - a[0] - t * ex, z - a[1] - t * ez) < d) n++;
    }
  }
  return n;
}
const ownWalls = (cells, j) => wallsNear(cells, j, [-1e4, -1e4], [1e4, 1e4], 1e6);

test('a replaced building leaves its skipped front to the landmark and keeps the rest', () => {
  const G = corner();
  // KP2's front on the square: its outline's edges along the arcade (local metres)
  const a = [277.62, -262.37], b = [283.89, -264.72];
  const base = buildFacadeCells(G, { triangulate, debug: true }).cells;
  assert.ok(wallsNear(base, KP2, a, b) > 0, 'the city draws the front');
  const record = { ...GEO.buildings[KP2], skip: [[275.53, -261.62, 285.9, -265.49, Infinity]] };
  const cells = buildFacadeCells(G, { triangulate, debug: true, replace: new Map([[KP2, record]]) }).cells;
  assert.equal(wallsNear(cells, KP2, a, b), 0, 'the front is skipped');
  assert.ok(ownWalls(cells, KP2) > 0, 'its other walls stay');
});

test('a phantom keeps the neighbours of a hidden building walled', () => {
  const G = corner();
  // the party wall between the library and Joan de Bilbao k. 17
  const lb = GEO.buildings[LIBRARY];
  const shared = [[271.35, -256.1], [266.11, -254.2]];
  const hidden = new Set([LIBRARY]);
  const open = buildFacadeCells(G, { triangulate, debug: true, hidden }).cells;
  const closed = buildFacadeCells(G, { triangulate, debug: true, hidden, phantoms: [lb] }).cells;
  assert.equal(ownWalls(closed, LIBRARY), 0, 'the hidden building is not drawn');
  assert.ok(wallsNear(open, NEIGHBOUR, ...shared) > 0, 'without the phantom the party wall shows');
  assert.equal(wallsNear(closed, NEIGHBOUR, ...shared), 0, 'with it the party wall is hidden');
});
