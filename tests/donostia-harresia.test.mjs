import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The old city wall along the port (tools/donostia/harresia.mjs -> js/donostia/data-harresia.js, GEO.terrain.walls):
// the terrain steps at its port face from Kaimingaintxo & Lasta plazas up to the street's level behind the wall walk,
// instead of the slope 3-6 m high the 2 m grid drew there; the masonry stands up to the walk's spot heights; the
// Portaletas keep their passages open at the plazas' level

const root = fileURLToPath(new URL('../', import.meta.url));
const load = async (rel) => import(pathToFileURL(`${root}${rel}`).href);
const { HARRESIA } = await load('js/donostia/data-harresia.js');
const { GEO } = await load('js/donostia/geodata.js');
const { WALL, nearestWall } = await load('js/donostia/shore-walls.js');
const { decodePNG } = await load('js/donostia/png.js');

const meta = GEO.terrain.core;
const img = await decodePNG(fs.readFileSync(`${root}${meta.url}`).buffer);
const height = (i, j) => ((img.data[(j * meta.w + i) * 3] << 8) | img.data[(j * meta.w + i) * 3 + 1]) / 100 - GEO.terrain.heightOffset;
const walls = GEO.terrain.walls.filter((w) => w.t === WALL.harresia);
const length = (p) => { let l = 0; for (let k = 4; k < p.length; k += 4) l += Math.hypot(p[k] - p[k - 4], p[k + 1] - p[k - 3]); return l; };

test('the port face is a hidden wall the terrain steps at, the length of the plazas', () => {
  assert.equal(walls.length, 1);
  const [w] = walls;
  assert.deepEqual(w.h, [0, w.p.length / 4 - 1], 'hidden: its masonry is data-harresia.js\'s');
  assert.ok(length(w.p) > 200, `${length(w.p).toFixed(0)} m`);
  // from Mari kalea's steps (by Gaztelubide) to Lasta plaza
  const ends = [[w.p[0], w.p[1]], [w.p[w.p.length - 4], w.p[w.p.length - 3]]];
  assert.ok(ends.some(([x, z]) => z < -255 && x < 75), 'up the steps');
  assert.ok(ends.some(([, z]) => z > -100), 'along Lasta plaza');
});

test('in front of the port face the plaza is level up to the wall, behind it the street', () => {
  // every core sample within 4 m of the face's line: in front no higher than the plaza by more than 0.35 m (the curtain
  // stood up to 6 m there), behind the walk (not up the steps, which climb along it) no lower than a metre under the
  // street's level (but in the Portaletas, at the plazas' level)
  let front = 0, back = 0;
  for (let j = 0; j < meta.h; j++) {
    const z = meta.z0 + (j + 0.5) * meta.res;
    if (z < -270 || z > -60) continue;
    for (let i = 0; i < meta.w; i++) {
      const x = meta.x0 + (i + 0.5) * meta.res;
      if (x < 55 || x > 165) continue;
      const q = nearestWall(walls, x, z, 4);
      if (!q || q.end || q.deck - q.foot < 1) continue;
      const y = height(i, j);
      if (q.d > 0.3) {
        assert.ok(y <= q.foot + 0.35, `(${x}, ${z}) ${y.toFixed(2)} m in front of a face whose foot is ${q.foot.toFixed(2)} m`);
        front++;
      } else if (q.d < -0.3 && z > -238) {
        assert.ok(y >= q.deck - 1 || Math.hypot(x - 115.3, z + 191.3) < 10,
          `(${x}, ${z}) ${y.toFixed(2)} m behind a face whose deck is ${q.deck.toFixed(2)} m`);
        back++;
      }
    }
  }
  assert.ok(front > 80 && back > 80, `${front} samples in front, ${back} behind`);
});

test('the masonry stands up to the walk: 10.2 m by Mari kalea, over the plaza and over the street', () => {
  const port = HARRESIA.faces.filter((f) => f.p.some((v, k) => k % 4 === 3 && v < 6));
  assert.ok(port.length >= 2, 'the port face, either side of the Portaletas');
  for (const f of HARRESIA.faces) {
    for (let k = 0; k < f.p.length; k += 4) {
      const [x, z, deck, foot] = f.p.slice(k, k + 4);
      assert.ok(deck - foot >= 0.3, `(${x}, ${z}): a face ${(deck - foot).toFixed(2)} m tall`);
      if (z > -236 && z < -200) assert.ok(Math.abs(deck - 10.17) < 0.15, `(${x}, ${z}): the walk at ${deck} m`);
    }
  }
  // the inner face over Mari kalea, down to Portu kalea by the gate
  const inner = HARRESIA.faces.filter((f) => !port.includes(f));
  assert.ok(inner.length >= 2 && inner.some((f) => f.p.some((v, k) => k % 4 === 3 && v < 7)), 'the inner face over the street');
  assert.ok(HARRESIA.walk.length >= 2 && HARRESIA.walk.every((s) => s.length % 5 === 0 && s.length >= 50), 'the walk\'s top');
});

test('the Portaletas: the gate\'s block, the gatehouse in front of it, passages at the plazas\' level', () => {
  const G = HARRESIA.gate;
  const b = G.block, side = (k) => Math.hypot(b[(2 * k + 2) % 8] - b[2 * k], b[(2 * k + 3) % 8] - b[2 * k + 1]);
  const sides = [0, 1, 2, 3].map(side).sort((p, q) => p - q);
  assert.ok(Math.abs(sides[3] - 10.4) < 0.5 && Math.abs(sides[0] - 2.3) < 0.3, `the block ${sides[3].toFixed(1)} x ${sides[0].toFixed(1)} m`);
  assert.equal(G.house.length / 2, 6, 'half an octagon: two returns, two obliques and the front');
  assert.ok(G.court.length / 2 >= 8, 'the court\'s curve');
  assert.equal(G.terrace, 10.15);
  assert.ok(G.floor > 5.4 && G.floor < 6.3, `the court at ${G.floor} m`);
  // no step across the gate: the terrain in the court and under the gatehouse within a metre of Portu kalea's
  for (const [x, z] of [[112.5, -190.8], [108.5, -188.5], [110.5, -193.5]]) {
    const i = Math.floor((x - meta.x0) / meta.res), j = Math.floor((z - meta.z0) / meta.res);
    assert.ok(Math.abs(height(i, j) - G.floor) < 1, `(${x}, ${z}) at ${height(i, j).toFixed(2)} m`);
  }
});
