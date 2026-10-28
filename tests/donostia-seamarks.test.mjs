import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The aids to navigation: the baked lights (js/donostia/data-seamarks.js) and their characters in time
// (js/donostia/seamark-timing.js, which the glows' shader mirrors)

const root = fileURLToPath(new URL('../', import.meta.url));
const { SEAMARKS } = await import(pathToFileURL(`${root}js/donostia/data-seamarks.js`).href);
const { lightLevel } = await import(pathToFileURL(`${root}js/donostia/seamark-timing.js`).href);
const byRef = (ref) => SEAMARKS.find((l) => l.ref === ref);

test('every light has a character the glows can draw', () => {
  assert.ok(SEAMARKS.length >= 8, `${SEAMARKS.length} lights`);
  for (const l of SEAMARKS) {
    assert.ok(['white', 'red', 'green', 'yellow'].includes(l.colour), `${l.ref}: ${l.colour}`);
    assert.ok(l.period > 0 && l.range > 0 && l.height > 0, l.ref);
    assert.ok(l.on.length >= 2 && l.on.length <= 8 && l.on.length % 2 === 0, `${l.ref}: at most 4 spans`);
    for (let k = 0; k < l.on.length; k += 2) {
      assert.ok(l.on[k] >= 0 && l.on[k] < l.on[k + 1] && l.on[k + 1] <= l.period, `${l.ref}: span ${k / 2}`);
      if (k) assert.ok(l.on[k] > l.on[k - 1], `${l.ref}: spans in order`);
    }
    assert.ok(l.phase >= 0 && l.phase < l.period, l.ref);
    assert.ok(Number.isFinite(l.x) && Number.isFinite(l.z), l.ref);
  }
});

test('the San Sebastián lights follow NGA Pub. 113', () => {
  assert.deepEqual([byRef('D 1483').period, byRef('D 1483').on], [15, [0, 0.4, 2.2, 2.6, 8.6, 9]]); // Fl(2+1) W 15s
  assert.ok(byRef('D 1483').rotating);
  assert.deepEqual([byRef('D 1482').period, byRef('D 1482').on], [5, [0, 1]]); // Fl W 5s, fl. 1s
  assert.deepEqual([byRef('D 1484.1').period, byRef('D 1484.1').on], [4, [0, 3]]); // Oc R 4s, lt. 3s
  assert.equal(byRef('D 1484').period, 1); // Q R
  for (const ref of ['D 1484', 'D 1484.1', 'D 1486']) assert.equal(byRef(ref).colour, 'red', ref);
  assert.equal(byRef('D 1485').colour, 'green');
});

test("La Concha's leading lights line up at 158°, the rear one higher", () => {
  const front = byRef('D 1484'), rear = byRef('D 1484.1');
  const bearing = (Math.atan2(rear.x - front.x, -(rear.z - front.z)) * 180) / Math.PI;
  assert.ok(Math.abs(bearing - 158) < 1, `the leading line runs ${bearing.toFixed(1)}°`);
  assert.ok(Math.abs(Math.hypot(rear.x - front.x, rear.z - front.z) - 25) < 2, 'about 25 m apart');
  assert.ok(rear.height > front.height && rear.mount.height > front.mount.height);
  assert.equal(front.sector, null, 'shown all round: OSM sector tags of a leading light are its line');
});

test('a fixed lantern flashes on its published spans, the same for every viewer', () => {
  const l = byRef('D 1482');
  const at = (p) => p - l.phase + 10 * l.period; // clock time when the light is p s into its period
  assert.equal(lightLevel(l, at(0.5)), 1);
  assert.equal(lightLevel(l, at(3)), 0);
  assert.equal(lightLevel(l, at(0.5), 2), 1);
});

test("Igeldo's revolving optic shows Fl(2+1) 15 s from any bearing, sooner or later", () => {
  const l = byRef('D 1483');
  for (const psi of [-2.5, 0, 1.3]) {
    const peaks = [];
    for (let t = 0; t < 30; t += 0.01) {
      const a = lightLevel(l, t - 0.01, psi), b = lightLevel(l, t, psi), c = lightLevel(l, t + 0.01, psi);
      if (b > 0.9 && b >= a && b > c) peaks.push(t);
    }
    const gaps = peaks.slice(1).map((t, k) => +(t - peaks[k]).toFixed(1));
    assert.ok(gaps.length >= 4, `psi ${psi}: ${peaks.length} flashes in 30 s`);
    // 2.2 s between the pair's flashes, 6.4 s to the single one and on to the next pair
    for (const g of gaps) assert.ok([2.2, 6.4].includes(g), `psi ${psi}: gaps ${gaps}`);
  }
});
