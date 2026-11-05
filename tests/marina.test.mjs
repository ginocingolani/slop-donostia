import assert from 'node:assert/strict';
import test from 'node:test';
import { MARINA } from '../js/donostia/data-marina.js';

// The port's moorings (tools/donostia/bake-marina.mjs -> js/donostia/data-marina.js) keep their shape and stay in the
// harbour

const inside = (x, z, ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c;
  }
  return c;
};

test('the marina data keeps its shape', () => {
  const strides = { decks: 10, piles: 5, gangways: 9, cleats: 3, pedestals: 3, lamps: 2, bollards: 4, rings: 4, ladders: 5, strakes: 5 };
  for (const [key, stride] of Object.entries(strides)) {
    assert.ok(Array.isArray(MARINA[key]), key);
    assert.equal(MARINA[key].length % stride, 0, `${key} in records of ${stride}`);
    assert.ok(MARINA[key].every(Number.isFinite), `${key} all finite`);
  }
  assert.ok(MARINA.decks.length / 10 > 80, 'the basins have their pontoons');
  assert.ok(MARINA.gangways.length / 7 >= 8, 'and their gangways');
  const { freeboard, draft, ground } = MARINA.level;
  assert.ok(freeboard > 0.3 && freeboard < 0.7 && draft > 0 && ground <= 0);
  assert.ok(MARINA.slipway.ring.length >= 8 && MARINA.slipway.surface.length === 6);
  assert.equal(MARINA.harbour.mouth.length, 3);
});

test('the pontoons float inside the harbour and the gangways reach them', () => {
  const ring = MARINA.harbour.ring;
  const D = MARINA.decks;
  for (let k = 0; k < D.length; k += 10) {
    for (let c = 0; c < 8; c += 2) assert.ok(inside(D[k + c], D[k + c + 1], ring), `deck ${k / 10} corner in the harbour`);
  }
  const G = MARINA.gangways;
  for (let k = 0; k < G.length; k += 9) {
    const [hx, hz, hy, fx, fz, L, W, ex, ez] = G.slice(k, k + 9);
    const run = Math.hypot(fx - hx, fz - hz), drop = hy - MARINA.level.freeboard;
    // its hinge on a landing out from the wall's face, no further than the gangway's width (and its quay end on the
    // quay); at mean sea level its rollers a little short of its length out, no steeper than 1 in 2
    const out = Math.hypot(hx - ex, hz - ez);
    assert.ok(out > 0.05 && out < W, `gangway ${k / 9}'s hinge ${out.toFixed(2)} m out from the quay`);
    assert.ok(inside(ex, ez, ring) || inside(ex + (hx - ex) / out, ez + (hz - ez) / out, ring), `gangway ${k / 9} hangs over the harbour`);
    assert.ok(run < L && run > L * 0.85, `gangway ${k / 9} reaches its pontoon`);
    assert.ok(drop / run < 0.5, `gangway ${k / 9} not too steep`);
  }
});
