import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The buildings as solids for the god camera (js/donostia/colliders.js), on the real GEO.buildings: walls stop it,
// roofs carry it, courtyards stay open, and a view saved inside a building comes out on its roof.

const root = fileURLToPath(new URL('../', import.meta.url));
const { GEO } = await import(pathToFileURL(`${root}js/donostia/geodata.js`).href);
const { createColliders } = await import(pathToFileURL(`${root}js/donostia/colliders.js`).href);

const R = 0.8, EYE = 1.7;
const t0 = performance.now();
const col = createColliders(GEO.buildings);
const buildMs = performance.now() - t0;

// god-camera.js's _move: the step cut into pieces shorter than 3/4 of the radius, each resolved
function move(p, v, d, steps = Math.max(1, Math.ceil(Math.hypot(d.x, d.y, d.z) / (R * 0.75)))) {
  for (let i = 0; i < steps; i++) {
    const prev = { ...p };
    p.x += d.x / steps; p.y += d.y / steps; p.z += d.z / steps;
    col.resolve(p, v, prev, R, EYE);
  }
}
const centre = (b) => {
  const r = b.g[0];
  let x = 0, z = 0;
  for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
};
function inside(b, x, z) {
  let hit = false;
  for (const ring of b.g) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = ring[2 * i], zi = ring[2 * i + 1], xj = ring[2 * j], zj = ring[2 * j + 1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
    }
  }
  return hit;
}

test('built quickly from every building', () => {
  assert.equal(col.stats.buildings, GEO.buildings.length);
  assert.ok(col.stats.walls > 50000, `${col.stats.walls} walls`);
  assert.ok(buildMs < 1500, `${buildMs.toFixed(0)} ms`);
});

test('a camera flying at the City Hall at eye height stops at its wall', () => {
  const b = GEO.buildings[43];
  assert.equal(b.name, 'Udaletxea');
  const [cx, cz] = centre(b);
  assert.ok(inside(b, cx, cz));
  // from 60 m north of the centre, straight at it, at 60 m/s for two seconds (frames of 1/60 s)
  const p = { x: cx, y: b.base + EYE + 2, z: cz - 60 }, v = { x: 0, y: 0, z: 60 };
  for (let f = 0; f < 120; f++) move(p, v, { x: v.x / 60, y: 0, z: v.z / 60 });
  assert.ok(!inside(b, p.x, p.z), `ended inside at ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`);
  assert.ok(p.z < cz, 'never got past it');
  assert.ok(Math.abs(v.z) < 1e-6 || v.z <= 0, 'its speed into the wall is gone');
});

test('the same flight at speed (240 m/s, boosted) does not go through either', () => {
  const b = GEO.buildings[43];
  const [cx, cz] = centre(b);
  const p = { x: cx, y: b.base + EYE + 2, z: cz - 80 }, v = { x: 0, y: 0, z: 240 };
  for (let f = 0; f < 60; f++) move(p, v, { x: 0, y: 0, z: 4 });
  assert.ok(p.z < cz && !inside(b, p.x, p.z));
});

test('coming down from above lands on the roof; above every roof nothing happens', () => {
  const b = GEO.buildings[43];
  const [cx, cz] = centre(b);
  const p = { x: cx, y: b.top + 30, z: cz }, v = { x: 0, y: -20, z: 0 };
  for (let f = 0; f < 120; f++) move(p, v, { x: 0, y: v.y / 60, z: 0 });
  assert.ok(Math.abs(p.y - (b.top + EYE)) < 1e-6, `y ${p.y} over a top of ${b.top}`);
  const high = { x: cx, y: 400, z: cz }, hv = { x: 30, y: 0, z: 0 };
  assert.equal(col.resolve(high, hv, { ...high }, R, EYE), false);
});

test('a view saved inside a building comes out on its roof', () => {
  const b = GEO.buildings[43];
  const [cx, cz] = centre(b);
  const p = { x: cx, y: b.base + 3, z: cz }, v = { x: 0, y: 0, z: 0 };
  assert.equal(col.resolve(p, v, null, R, EYE), true);
  assert.ok(Math.abs(p.y - (b.top + EYE)) < 1e-6);
});

test('a courtyard is open to the sky: a camera in it is left alone', () => {
  const k = GEO.buildings.findIndex((b) => b.g.length > 1 && b.g[1].length >= 8 && Math.abs(ringArea(b.g[1])) > 200);
  assert.ok(k >= 0, 'a building with a courtyard');
  const b = GEO.buildings[k];
  // a point well inside the courtyard: the centroid of its ring, if it is inside it and clear of its walls
  const [hx, hz] = centre({ g: [b.g[1]] });
  if (!inside({ g: [b.g[1]] }, hx, hz)) return; // an odd-shaped courtyard: nothing to test
  const p = { x: hx, y: b.base + EYE, z: hz }, v = { x: 0, y: 0, z: 0 };
  const before = { ...p };
  col.resolve(p, v, { ...p }, R, EYE);
  const d = Math.hypot(p.x - before.x, p.z - before.z);
  assert.ok(d < R + 1e-6 && Math.abs(p.y - before.y) < 1e-6, `moved ${d} m`);
});

test('no fly-to station starts inside a building', () => {
  for (const t of GEO.teleports) {
    const [x, y, z] = t.from;
    const p = { x, y, z }, v = { x: 0, y: 0, z: 0 };
    col.resolve(p, v, null, R, EYE);
    assert.ok(Math.abs(p.y - y) < 1e-6, `${t.id} lifted from ${y} to ${p.y}`);
  }
});

function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}
