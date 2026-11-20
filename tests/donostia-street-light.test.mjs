import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The public lighting (js/donostia/street-light.js): when the lamps are on (js/donostia/time-of-day.js's streetLight,
// the presets' in js/donostia/presets.js), and what tools/donostia/bake-streetlight.mjs baked (the light maps and the
// lamps placed along the streets, js/donostia/data-streetlight.js).

const root = fileURLToPath(new URL('../', import.meta.url));
const tod = await import(pathToFileURL(`${root}js/donostia/time-of-day.js`).href);
const { STREETLIGHT } = await import(pathToFileURL(`${root}js/donostia/data-streetlight.js`).href);
const { STREETSCAPE } = await import(pathToFileURL(`${root}js/donostia/data-streetscape.js`).href);
const { decodePNG } = await import(pathToFileURL(`${root}js/donostia/png.js`).href);
const FRAME = JSON.parse(fs.readFileSync(`${root}tools/donostia/frame.json`, 'utf8'));

const vec = (azimuth, elevation) => {
  const [x, y, z] = tod.direction(azimuth, elevation);
  return { x, y, z };
};
// the presets' shape with the lamps as js/donostia/presets.js sets them (the other numbers do not matter here)
const preset = (streetLight, sunDir, daylight) => ({
  sunColor: 0xffffff, hemiSky: 0xffffff, hemiGround: 0xffffff, skyTop: 0xffffff, skyHorizon: 0xffffff, fogColor: 0xffffff,
  sunIntensity: 1, hemiIntensity: 1, fogDensity: 0.0002, interiorGlow: 1, roadWetness: 0.1, envIntensity: 0.5, canyonBounce: 0.5,
  turbidity: 5, rayleigh: 2, mieCoefficient: 0.005, mieDirectionalG: 0.8, cloudCoverage: 0.3, cloudDensity: 0.3, skyExposure: 0.1,
  nightFactor: 0, daylight, sunDir, ...(streetLight == null ? {} : { streetLight })
});
const PRESETS = {
  golden: preset(0, vec(290, 11), 0.72), midday: preset(0, vec(195, 63), 1),
  twilight: preset(1, vec(302, 5), 0.3), midnight: preset(1, vec(150, 38), 0.05)
};
const look = { exposure: 1, contrast: 1, saturation: 1, balance: [1, 1, 1], bloom: 0.2, threshold: 1.2 };
const LOOKS = { golden: look, midday: look, twilight: look, midnight: look };
const CLEAR = { kind: 'clear', intensity: 0, cloudCover: 0.05, cloudCoverLow: 0, visibility: 40000 };
const RAIN = { kind: 'rain', intensity: 0.8, cloudCover: 1, cloudCoverLow: 0.9, visibility: 5000 };
const NO_MOON = { azimuth: 0, elevation: -40, illumination: 0 };
const at = (elevation, weather = CLEAR, presets = PRESETS) =>
  tod.timeOfDay({ sun: { azimuth: 250, elevation }, moon: NO_MOON, weather }, presets, LOOKS).streetLight;

test('the lamps are off by day and on from the blue hour through the night', () => {
  for (const e of [63, 40, 25, 11, 8]) assert.equal(at(e), 0, `sun at ${e}°`);
  for (const e of [-1, -3, -8, -12, -50]) assert.equal(at(e), 1, `sun at ${e}°`);
});

test('they come on about sunset, never dimming as the sun goes down', () => {
  let last = 0;
  for (let e = 12; e >= -6; e -= 0.25) {
    const s = at(e);
    assert.ok(s >= last - 1e-9 && s >= 0 && s <= 1, `monotonic at ${e}°: ${s} after ${last}`);
    last = s;
  }
  assert.ok(at(5) < 0.05, 'still off with the sun 5° up');
  assert.ok(at(2) > 0.2 && at(2) < 0.9, 'coming on with the sun 2° up');
  assert.ok(at(0) > 0.9, 'on at sunset');
});

test('a dark sky brings them on a little earlier, and never by day', () => {
  assert.ok(at(3, RAIN) > at(3, CLEAR));
  for (const e of [63, 30, 25]) assert.equal(at(e, RAIN), 0, `raining with the sun at ${e}°`);
});

test('presets without the field (another city) have no public lighting', () => {
  const bare = Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => {
    const { streetLight, ...rest } = p;
    return [id, rest];
  }));
  for (const e of [63, 5, -3, -30]) assert.equal(at(e, CLEAR, bare), 0);
  assert.equal(tod.presetLook(bare, LOOKS, 'midnight').streetLight, 0);
  assert.equal(tod.presetLook(PRESETS, LOOKS, 'midnight').streetLight, 1);
  assert.equal(tod.presetLook(PRESETS, LOOKS, 'midday').streetLight, 0);
});

const { core } = FRAME;
const W = core.maxX - core.minX, D = core.maxZ - core.minZ;

test('the light maps cover the core, black at the rim, lit along the streets', async () => {
  for (const [url, res] of [[STREETLIGHT.map.url, STREETLIGHT.map.res], [STREETLIGHT.map.urlLow, 2 * STREETLIGHT.map.res]]) {
    const buf = fs.readFileSync(`${root}${url}`);
    const img = await decodePNG(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    assert.equal(img.channels, 1);
    assert.equal(img.width, W / res);
    assert.equal(img.height, D / res);
    const px = (x, z) => img.data[Math.floor((z - core.minZ) / res) * img.width + Math.floor((x - core.minX) / res)];
    for (let i = 0; i < img.width; i++) assert.equal(img.data[i] + img.data[(img.height - 1) * img.width + i], 0, 'rim');
    for (let j = 0; j < img.height; j++) assert.equal(img.data[j * img.width] + img.data[j * img.width + img.width - 1], 0, 'rim');
    // the bay and the open sea are dark; the Boulevard, Loiola kalea and the promenade by La Perla are lit
    assert.equal(px(-400, 300), 0, 'the bay');
    assert.equal(px(-1500, -1200), 0, 'the open sea');
    const lit = (x, z, r = 12) => {
      let best = 0;
      for (let dz = -r; dz <= r; dz += res) for (let dx = -r; dx <= r; dx += res) best = Math.max(best, px(x + dx, z + dz));
      return best;
    };
    for (const [name, x, z] of [['Boulevard', 400, -100], ['Loiola kalea', 490, 335], ['Kontxa pasealekua', -90, 700], ['Zabaleta kalea', 1000, -196]]) {
      assert.ok(lit(x, z) > 100, `${name} is lit in ${url} (${lit(x, z)})`);
    }
    assert.ok(buf.length < 1.1e6, `${url} stays a small download (${buf.length} bytes)`);
  }
});

test('the placed lamps stand in the core, clear of the modelled ones', () => {
  const lists = [...STREETLIGHT.columns, STREETLIGHT.lanterns, STREETLIGHT.wall];
  const placed = [];
  for (const { count, data } of lists) {
    const bytes = Buffer.from(data, 'base64');
    assert.equal(bytes.length, count * 5);
    for (let k = 0; k < count; k++) {
      placed.push([STREETLIGHT.origin[0] + bytes.readUInt16LE(5 * k) * STREETLIGHT.unit, STREETLIGHT.origin[1] + bytes.readUInt16LE(5 * k + 2) * STREETLIGHT.unit]);
    }
  }
  assert.ok(placed.length > 5000, `lamps along the streets: ${placed.length}`);
  for (const [x, z] of placed) assert.ok(x > core.minX && x < core.maxX && z > core.minZ && z < core.maxZ);
  assert.deepEqual(STREETLIGHT.columns.map((c) => c.height).sort((a, b) => a - b), [7, 9, 12]);
  // none within 8 m of a street lamp OSM maps (the bake drops a lamp another stands close to)
  const cell = new Map();
  for (const [x, z] of placed) {
    const key = `${Math.floor(x / 8)},${Math.floor(z / 8)}`;
    if (!cell.has(key)) cell.set(key, []);
    cell.get(key).push([x, z]);
  }
  let close = 0;
  for (let k = 0; k < STREETSCAPE.lamps.length; k += 3) {
    const x = STREETSCAPE.lamps[k] / 100, z = STREETSCAPE.lamps[k + 1] / 100;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        for (const [px, pz] of cell.get(`${Math.floor(x / 8) + di},${Math.floor(z / 8) + dj}`) || []) if (Math.hypot(px - x, pz - z) < 8) close++;
      }
    }
  }
  assert.equal(close, 0);
});
