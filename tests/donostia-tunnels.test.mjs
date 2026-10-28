import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The tunnels' portals (tools/donostia/tunnels.mjs -> js/donostia/data-tunnels.js) and the walls the terrain steps at
// round them (GEO.terrain.walls): the Miramar tunnel (OSM ways 23920623, the road, and 35804363, its bike lane) and
// the Pico del Loro's footway (177708251), each with a portal at both ends, walls there, the terrain stepping at the
// faces, and no road, pavement or bike lane painted over the bores

const root = fileURLToPath(new URL('../', import.meta.url));
const load = async (rel) => import(pathToFileURL(`${root}${rel}`).href);
const { TUNNELS } = await load('js/donostia/data-tunnels.js');
const { GEO } = await load('js/donostia/geodata.js');
const { WALL } = await load('js/donostia/shore-walls.js');
const { decodePNG } = await load('js/donostia/png.js');
const { STREETSCAPE } = await load('js/donostia/data-streetscape.js');

const MIRAMAR = 23920623, BIKE = 35804363, LORETOPEA = 177708251;
const portalsOf = (id) => TUNNELS.portals.filter((p) => p.ids.includes(id));
const centre = (P) => {
  const n = P.p.length / 4;
  return [(P.p[0] + P.p[4 * n - 4]) / 2, (P.p[1] + P.p[4 * n - 3]) / 2];
};
const faceLength = (p) => {
  let l = 0;
  for (let k = 4; k < p.length; k += 4) l += Math.hypot(p[k] - p[k - 4], p[k + 1] - p[k - 3]);
  return l;
};
// the portals' ends of each tunnel, as read off the 1 m LiDAR and the 2025 orthophoto: [x, z, floor] (m)
const ENDS = {
  [MIRAMAR]: [[-725.5, 727.5, 11.2], [-812.5, 677.5, 9.9]],
  [LORETOPEA]: [[-763, 669.5, 10.7], [-793, 664, 10.2]]
};

test('every portal has a face and openings that fit it', () => {
  assert.ok(TUNNELS.portals.length >= 4);
  for (const P of TUNNELS.portals) {
    assert.ok(P.p.length >= 8 && P.p.length % 4 === 0 && P.p.every(Number.isFinite), 'a face line');
    const L = faceLength(P.p);
    assert.ok(P.o.length >= 1, 'an opening');
    for (const [u0, u1, floor, spring, rise, ring, ax, az, len] of P.o) {
      assert.ok(u0 >= 0 && u1 > u0 + 1.5 && u1 <= L + 1e-6, `opening ${u0}..${u1} on a face of ${L.toFixed(2)} m`);
      assert.ok(spring > 0 && rise > 0 && ring > 0 && len > 0 && Math.abs(Math.hypot(ax, az) - 1) < 0.01);
      // (the arch and its ring under the head over the opening)
      let u = 0;
      for (let k = 0; k < P.p.length; k += 4) {
        if (k) u += Math.hypot(P.p[k] - P.p[k - 4], P.p[k + 1] - P.p[k - 3]);
        if (u > u0 && u < u1) assert.ok(P.p[k + 2] - floor >= spring + rise + ring, 'the arch under the head');
      }
    }
  }
});

test('both tunnels have a portal at each end, where the LiDAR has them', () => {
  for (const [id, ends] of Object.entries(ENDS)) {
    const ps = portalsOf(Number(id));
    assert.equal(ps.length, 2, `way ${id}: two portals`);
    for (const [x, z, floor] of ends) {
      const P = ps.find((q) => Math.hypot(centre(q)[0] - x, centre(q)[1] - z) < 8);
      assert.ok(P, `way ${id}: a portal by (${x}, ${z})`);
      // (the face passes within 1.5 m of the end read off the LiDAR)
      let d = Infinity;
      for (let k = 0; k + 4 < P.p.length; k += 4) {
        const [ax, az, bx, bz] = [P.p[k], P.p[k + 1], P.p[k + 4], P.p[k + 5]];
        const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / ((bx - ax) ** 2 + (bz - az) ** 2)));
        d = Math.min(d, Math.hypot(x - ax - t * (bx - ax), z - az - t * (bz - az)));
      }
      assert.ok(d < 1.5, `way ${id}: the face ${d.toFixed(2)} m from (${x}, ${z})`);
      assert.ok(Math.abs(P.o[0][2] - floor) < 0.6, `way ${id}: the floor at ${P.o[0][2]}`);
    }
  }
  // the road and its bike lane share the Miramar tunnel's one arch, wide enough for both
  for (const P of portalsOf(MIRAMAR)) {
    assert.ok(P.ids.includes(BIKE) && P.o.length === 1, 'one opening for the road & the bike lane');
    assert.ok(P.o[0][1] - P.o[0][0] > 12, 'its span');
    assert.equal(P.k, 0, 'limestone');
  }
  for (const P of portalsOf(LORETOPEA)) {
    assert.ok(P.o[0][1] - P.o[0][0] < 5, "the footway's narrow arch");
    assert.equal(P.k, 1, 'sandstone');
  }
});

test('the faces are walls the terrain steps at, retaining walls with copings round them', () => {
  const faces = GEO.terrain.walls.filter((w) => w.f);
  for (const P of [...portalsOf(MIRAMAR), ...portalsOf(LORETOPEA)]) {
    const w = faces.find((q) => JSON.stringify(q.p) === JSON.stringify(P.p));
    assert.ok(w, 'a hidden wall along the face');
    assert.deepEqual(w.h, [0, P.p.length / 4 - 1], 'hidden all along: the portal is the masonry');
  }
  // the walk round the Pico del Loro, between the two tunnels, under Miramar's garden wall
  const garden = GEO.terrain.walls.filter((w) => w.t === WALL.garden && !w.h);
  const near = (x, z, r) => garden.find((w) => {
    for (let k = 0; k < w.p.length; k += 4) if (Math.hypot(w.p[k] - x, w.p[k + 1] - z) < r) return true;
    return false;
  });
  for (const [x, z] of [[-729, 701], [-741, 689], [-754, 676.5], [-722.5, 710]]) {
    const w = near(x, z, 6);
    assert.ok(w, `a garden wall by the walk at (${x}, ${z})`);
  }
  for (const w of garden) for (let k = 0; k < w.p.length; k += 4) assert.ok(w.p[k + 2] - w.p[k + 3] >= 1.3, 'a step');
  // the footway's courtyards: walls run on from both ends of each portal's face, square to it (the terrain's samples
  // by the corners go onto them, js/donostia/shore-walls.js)
  for (const P of portalsOf(LORETOPEA)) {
    const n = P.p.length / 4;
    for (const v of [0, n - 1]) {
      const shared = garden.some((w) => [0, w.p.length / 4 - 1].some((e) => Math.hypot(w.p[4 * e] - P.p[4 * v], w.p[4 * e + 1] - P.p[4 * v + 1]) < 0.05));
      assert.ok(shared, `a courtyard wall at the face's end (${P.p[4 * v]}, ${P.p[4 * v + 1]})`);
    }
  }
});

// The baked 2 m terrain (terrain-core.png: R/G heights, B ground classes) and the 1 m ground surfaces (ground-core.png,
// its first plane), sampled at points
const png = async (rel) => {
  const b = fs.readFileSync(`${root}${rel}`);
  return decodePNG(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const terrain = await png(GEO.terrain.core.url);
const T = GEO.terrain.core;
const heightAt = (x, z) => {
  const i = Math.floor((x - T.x0) / T.res), j = Math.floor((z - T.z0) / T.res), k = 3 * (j * T.w + i);
  return ((terrain.data[k] << 8) | terrain.data[k + 1]) / 100 - GEO.terrain.heightOffset;
};
const classAt = (x, z) => terrain.data[3 * (Math.floor((z - T.z0) / T.res) * T.w + Math.floor((x - T.x0) / T.res)) + 2];

test('the terrain steps at the portals: the road in front, the ground over the bore behind', () => {
  for (const P of [...portalsOf(MIRAMAR), ...portalsOf(LORETOPEA)]) {
    const [cx, cz] = centre(P);
    const [, , floor] = P.o[0];
    const deck = P.p[2];
    // (out along the low side, on the left of the face's travel)
    const n = P.p.length / 4, dx = P.p[4 * n - 4] - P.p[0], dz = P.p[4 * n - 3] - P.p[1], l = Math.hypot(dx, dz);
    const ox = -dz / l, oz = dx / l;
    assert.ok(Math.abs(heightAt(cx + ox * 3.5, cz + oz * 3.5) - floor) < 0.8, 'the road in front');
    assert.ok(Math.abs(heightAt(cx - ox * 3.5, cz - oz * 3.5) - deck) < 1.5, 'the ground behind');
  }
});

test('no road, pavement or bike lane over the bores, and no street lamp', async () => {
  const ground = await png('data/donostia/ground-core.png');
  const core = GEO.frame.core, W = core.maxX - core.minX;
  const surfaceAt = (x, z) => ground.data[(Math.floor(z - core.minZ)) * W + Math.floor(x - core.minX)];
  const ROADS = new Set([1, 2, 9]); // SURFACE road, sidewalk, bike (tools/donostia/bake-ground.mjs)
  const G = GEO.terrain.classes;
  for (const id of [MIRAMAR, LORETOPEA]) {
    const [A, B] = portalsOf(id).map(centre);
    const l = Math.hypot(B[0] - A[0], B[1] - A[1]), ux = (B[0] - A[0]) / l, uz = (B[1] - A[1]) / l;
    for (let s = 4; s <= l - 4; s += 1) {
      for (const o of id === MIRAMAR ? [-5, 0, 5] : [0]) {
        const x = A[0] + ux * s - uz * o, z = A[1] + uz * s + ux * o;
        assert.ok(!ROADS.has(surfaceAt(x, z)), `way ${id}: no road surface at (${x.toFixed(1)}, ${z.toFixed(1)})`);
        assert.ok(![G.road, G.sidewalk, G.bike].includes(classAt(x, z)), `way ${id}: no road class at (${x.toFixed(1)}, ${z.toFixed(1)})`);
      }
    }
    const L = STREETSCAPE.lamps;
    for (let k = 0; k < L.length; k += 3) {
      const x = L[k] / 100, z = L[k + 1] / 100;
      const s = (x - A[0]) * ux + (z - A[1]) * uz, off = Math.abs(-(x - A[0]) * uz + (z - A[1]) * ux);
      assert.ok(!(s > 3 && s < l - 3 && off < 6), `way ${id}: a street lamp over the bore at (${x}, ${z})`);
    }
  }
});
