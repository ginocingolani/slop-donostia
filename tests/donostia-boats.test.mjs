import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const { loadModule } = createRequire(import.meta.url)('./helpers/module.cjs');

// The port's boats: the digitised data (tools/donostia/data/port_boats.json) and its bake (js/donostia/data-boats.js), the
// island ferries' berths & lanes, and their rounds (js/donostia/ferry-timeline.js)

const root = fileURLToPath(new URL('../', import.meta.url));
const STRIDE = 10;

test('the digitised boats and their bake agree and stay in the port', async () => {
  const src = JSON.parse(fs.readFileSync(`${root}tools/donostia/data/port_boats.json`, 'utf8'));
  const { BOATS, FERRY } = await import(pathToFileURL(`${root}js/donostia/data-boats.js`).href);
  assert.match(src.source, /geoEuskadi/);
  assert.deepEqual(BOATS.classes, ['sail', 'motor', 'open', 'txipironera', 'rib', 'passenger', 'fishing', 'catamaran', 'launch']);
  const N = BOATS.boats.length / STRIDE;
  assert.ok(Number.isInteger(N) && N > 300, `${N} boats`);
  // every digitised boat is drawn once: by boats.js, or as one of the ferries
  assert.equal(N + FERRY.ferries.length, src.boats.length);
  const count = BOATS.classes.map(() => 0);
  for (let i = 0; i < N; i++) {
    const [x, z, heading, length, beam, cls, options, ...paints] = BOATS.boats.slice(STRIDE * i, STRIDE * (i + 1));
    assert.ok(x > -18000 && x < 13000 && z > -25000 && z < -6000, `boat ${i} at ${x / 100}, ${z / 100} lies in the port`);
    assert.ok(heading >= 0 && heading < 3600, `boat ${i}: heading ${heading}`);
    assert.ok(length >= 150 && length <= 2500 && beam >= 80 && beam <= length, `boat ${i}: ${length} x ${beam} cm`);
    assert.ok(cls >= 0 && cls < BOATS.classes.length, `boat ${i}: class ${cls}`);
    assert.ok(options >= 0 && options <= 3, `boat ${i}: options ${options}`);
    for (const c of paints) assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `boat ${i}: colour ${c}`);
    count[cls]++;
  }
  // the two parts of the port: the small boats' rows are the txipironeras', the marina's yachts stay
  const of = (name) => count[BOATS.classes.indexOf(name)];
  assert.ok(of('txipironera') > 150 && of('motor') > 50 && of('sail') >= 8 && of('fishing') >= 1, JSON.stringify(count));
  // the txipironeras are painted, not all gelcoat white
  const hulls = new Set();
  for (let i = 0; i < N; i++) if (BOATS.boats[STRIDE * i + 5] === BOATS.classes.indexOf('txipironera')) hulls.add(BOATS.boats[STRIDE * i + 7]);
  assert.ok(hulls.size >= 8, `${hulls.size} txipironera hull paints`);
  // the passenger boats that are no ferries: the catamaran at Kaiko pasealekua, the open launch at the Lasta landing,
  // white; no other boat of 10 m or more has a hull in the ferries' blue
  assert.equal(of('catamaran'), 1);
  assert.ok(of('launch') >= 1);
  const ferryBlue = FERRY.paint[0], blueish = (c) => (c & 0xff) > ((c >> 16) & 0xff) + 60;
  for (let i = 0; i < N; i++) {
    const [x, z, , length, , cls, , hull] = BOATS.boats.slice(STRIDE * i, STRIDE * (i + 1));
    const name = BOATS.classes[cls];
    if (name === 'catamaran') assert.ok(Math.hypot(x / 100 + 66.8, z / 100 + 182.5) < 3, `the catamaran at ${x / 100}, ${z / 100}`);
    if (name === 'catamaran' || name === 'launch' || name === 'passenger') assert.equal(hull, 0xe2e3df, `the ${name}'s hull is white`);
    if (length >= 1000) assert.ok(hull !== ferryBlue && !blueish(hull), `a ${length / 100} m ${name} painted like a ferry`);
  }
});

test('the island ferries: two, at the north basin\'s ferry pier, with lanes to the island\'s landing', async () => {
  const { BOATS, FERRY } = await import(pathToFileURL(`${root}js/donostia/data-boats.js`).href);
  assert.equal(FERRY.ferries.length, 2);
  assert.equal(FERRY.paint.length, 3);
  for (const f of FERRY.ferries) {
    const [x, z, heading, length, beam] = f.berth;
    // at the ferry station (OSM 14089595908, 21.1, -226)
    assert.ok(Math.hypot(x / 100 - 21.1, z / 100 + 226) < 20, `berth at ${x / 100}, ${z / 100}`);
    assert.ok(length > 1000 && length < 2000 && beam > 350 && beam < 700 && heading >= 0 && heading < 3600);
    // no boat moored where a ferry is (it is drawn once, by ferries.js)
    for (let i = 0; i < BOATS.boats.length; i += STRIDE) {
      assert.ok(Math.hypot(BOATS.boats[i] - x, BOATS.boats[i + 1] - z) > 400, 'a boat on a ferry\'s berth');
    }
    // the landing by Santa Klara's jetty (OSM 3246198650, -911.3, 105.8)
    assert.ok(Math.hypot(f.island[0] / 100 + 911.3, f.island[1] / 100 - 105.8) < 15, `landing at ${f.island}`);
    for (const [lane, end] of [[f.out, f.island], [f.back, f.berth]]) {
      assert.equal(lane.length % 3, 0);
      assert.ok(lane.length / 3 > 150, 'a kilometre or so of lane');
      assert.deepEqual(lane.slice(-3, -1), end.slice(0, 2), 'a lane ends at its berth or landing');
      for (let k = 0; k + 3 < lane.length; k += 3) {
        const step = Math.hypot(lane[k + 3] - lane[k], lane[k + 4] - lane[k + 1]) / 100;
        assert.ok(step > 0.5 && step < 6, `lane step ${step} m`);
        assert.ok(lane[k + 2] > 0 && lane[k + 2] <= 600, `speed limit ${lane[k + 2]} cm/s`);
      }
    }
    assert.ok(f.turns.every((t) => Math.abs(t) <= 3600));
  }
});

test('the ferries\' rounds run smooth and never meet', async () => {
  const { ferryRounds, SERVICE } = await import(pathToFileURL(`${root}js/donostia/ferry-timeline.js`).href);
  // the presets, with three.js & the lighting stubbed
  const { DONOSTIA_PRESETS } = loadModule(fs.readFileSync(`${root}js/donostia/presets.js`, 'utf8'), {
    imports: {
      'three/webgpu': { MathUtils: { degToRad: (d) => (d * Math.PI) / 180 }, Vector3: class { normalize() { return this; } } },
      '../lighting.js': { TIME_PRESETS: { golden: {}, midday: {}, twilight: {}, midnight: {} } }
    },
    globals: { Math }
  });
  assert.ok(SERVICE.from <= 10 && SERVICE.to >= 19 && SERVICE.to <= 21);
  const rounds = ferryRounds();
  assert.equal(rounds.length, 2);
  const T = rounds[0].duration;
  assert.ok(T > 300 && T < 3600 && rounds.every((r) => r.duration === T), `a round of ${T} s`);
  const dt = 0.25;
  let prev = rounds.map((r) => r.pose(0)), closest = Infinity;
  for (let t = dt; t <= T; t += dt) {
    const p = rounds.map((r) => r.pose(t));
    closest = Math.min(closest, Math.hypot(p[0].x - p[1].x, p[0].z - p[1].z));
    p.forEach((q, k) => {
      assert.ok(Number.isFinite(q.x) && Number.isFinite(q.z) && q.heading >= 0 && q.heading < 360, `pose at ${t}`);
      const v = Math.hypot(q.x - prev[k].x, q.z - prev[k].z) / dt;
      const turn = Math.abs(((q.heading - prev[k].heading + 540) % 360) - 180) / dt;
      assert.ok(v < 5.5, `ferry ${k} jumps at ${t} s (${v.toFixed(1)} m/s)`);
      assert.ok(turn < 15, `ferry ${k} spins at ${t} s (${turn.toFixed(1)} degrees/s)`);
    });
    prev = p;
  }
  assert.ok(closest > 10, `the ferries come within ${closest.toFixed(1)} m of each other`);
  // a round comes back to where it began
  rounds.forEach((r) => assert.ok(Math.hypot(r.pose(0).x - r.pose(T).x, r.pose(0).z - r.pose(T).z) < 0.01));
  // the presets keep the hours: under way at midday, moored in the evening & at night
  const sailing = (id) => DONOSTIA_PRESETS[id].clock >= SERVICE.from && DONOSTIA_PRESETS[id].clock < SERVICE.to;
  assert.deepEqual(['golden', 'midday', 'twilight', 'midnight'].map(sailing), [false, true, false, false]);
});
