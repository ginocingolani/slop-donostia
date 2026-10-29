import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The sea of the real-time mode (js/donostia/sea-state.js): the live state's tide, waves, swell and wind as the
// water's parameters, the HUD's words for them, and the port's floating pontoons at the tide's extremes. The fixtures
// are real Open-Meteo responses for Donostia (29 October 2026; data by Open-Meteo.com, CC BY 4.0).

const root = fileURLToPath(new URL('../', import.meta.url));
const sea = await import(pathToFileURL(`${root}js/donostia/sea-state.js`).href);
const live = await import(pathToFileURL(`${root}js/donostia/live-state.js`).href);
const { MARINA } = await import(pathToFileURL(`${root}js/donostia/data-marina.js`).href);
const { FERRY } = await import(pathToFileURL(`${root}js/donostia/data-boats.js`).href);
const { GEO } = await import(pathToFileURL(`${root}js/donostia/geodata.js`).href);
const { decodePNG } = await import(pathToFileURL(`${root}js/donostia/png.js`).href);
const fixture = (name) => JSON.parse(fs.readFileSync(`${root}tests/fixtures/open-meteo-${name}.json`, 'utf8'));
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('the fixed sea is the one the water was drawn for', () => {
  const f = sea.FIXED_SEA;
  assert.equal(f.level, 0);
  assert.equal(f.mark, 0);
  assert.equal(f.surf, 1);
  assert.equal(f.chop, 1);
  assert.deepEqual([f.surfPeriodA, f.surfPeriodB], [7, 11]);
  for (const k of ['swell', 'calm', 'whitecaps', 'spray']) assert.equal(f[k], 0, k);
  assert.equal(f.chopFrom, null);
  assert.ok(Object.isFrozen(f));
});

test('the real sea of 29 October 2026 at 14:00 as the water\'s parameters', () => {
  const weather = live.weatherFromOpenMeteo(fixture('weather'));
  const s = live.seaFromOpenMeteo(fixture('marine'));
  const date = new Date(s.time);
  const snapshot = { weather, sea: { ...s, tide: live.tideAt(s.tide, date) } };
  const p = sea.seaParams(snapshot);
  // the tide: -1.11 m at 14:00, falling to the afternoon's low water
  assert.ok(Math.abs(p.level + 1.11) < 0.05, `level ${p.level}`);
  // a 1.14 m north-west swell of 10.85 s: a little under the swell the surf was drawn for, the coast open to it
  assert.ok(p.surf > 0.85 && p.surf < 1.0, `surf ${p.surf}`);
  assert.equal(p.swellPeriod, 10.85);
  assert.deepEqual([p.surfPeriodA, p.surfPeriodB], [0.8 * 10.85, 10.85]);
  assert.equal(p.swellFrom, 319);
  // light airs from the north-north-west (5.5 km/h): a smaller chop than the fixed sea's breeze, no whitecaps, no spray;
  // the swell keeps the bay from going glassy
  assert.ok(near(p.windSpeed, 5.5 / 3.6));
  assert.ok(p.chop > 0.45 && p.chop < 0.65, `chop ${p.chop}`);
  assert.equal(p.chopFrom, 328);
  assert.equal(p.whitecaps, 0);
  assert.equal(p.spray, 0);
  assert.equal(p.calm, 0);
  // the bands drawn from the day's high water
  const high = snapshot.sea.tide.next.find((t) => t.kind === 'high').level;
  assert.ok(near(p.mark, high - 1.5), `mark ${p.mark} for a high water of ${high}`);
});

test('swell: the open coast takes the north-westerlies, an offshore swell hardly reaches it', () => {
  assert.equal(sea.openTo(315), 1);
  assert.equal(sea.openTo(285), 1);
  assert.equal(sea.openTo(25), 1);
  assert.ok(sea.openTo(250) < 1 && sea.openTo(250) > 0.5);
  assert.ok(near(sea.openTo(155), 0.15, 1e-6)); // dead offshore, 130° outside the sector
  assert.ok(sea.openTo(180) <= 0.16);
  const nw = sea.effectiveSwell({ waveHeight: 2, wavePeriod: 12, waveFrom: 315, swellHeight: 1.8, swellPeriod: 13, swellFrom: 310 });
  assert.equal(nw.height, 2);
  assert.equal(nw.period, 13);
  assert.equal(nw.from, 310);
  const south = sea.effectiveSwell({ waveHeight: 2, wavePeriod: 6, waveFrom: 170, swellHeight: 0.2, swellPeriod: 7, swellFrom: 300 });
  assert.ok(south.height < 0.4, `${south.height}`);
  assert.equal(south.from, 170); // a wind sea: its own direction, not the small swell's
  assert.ok(near(sea.wavelength(10), 156.13, 0.01));
});

test('calm against a big swell: the breakers, the spray and the bay\'s glassy water', () => {
  const at = (h, wind, T = 10) => sea.seaParams({
    sea: { waveHeight: h, wavePeriod: T, waveFrom: 320, swellHeight: h, swellPeriod: T, swellFrom: 320, windWaveHeight: 0, tide: { level: 0, next: [] } },
    weather: { windSpeed: wind, windFrom: 320 }
  });
  const calm = at(0.3, 1.5), usual = at(1.2, 5), big = at(4.5, 9, 14);
  assert.ok(calm.surf < 0.3 && near(usual.surf, 1) && big.surf > 3.5);
  assert.ok(calm.calm > 0.9 && usual.calm === 0 && big.calm === 0);
  assert.ok(calm.spray === 0 && usual.spray === 0 && big.spray === 1);
  assert.ok(sea.seaParams({ sea: { waveHeight: 2.75, swellHeight: 2.75, swellFrom: 320, waveFrom: 320, tide: null }, weather: null }).spray > 0.4);
  assert.ok(calm.chop < usual.chop && usual.chop < big.chop);
  assert.ok(calm.whitecaps === 0 && big.whitecaps > 0.3);
  assert.equal(big.surfPeriodB, 14);
});

test('wind: glassy in a calm, rough in a gale, whitecaps from a fresh breeze', () => {
  assert.ok(near(sea.chopEnergy(5), 1));
  assert.equal(sea.chopEnergy(0), 0.3);
  assert.ok(sea.chopEnergy(10) > 1.5 && sea.chopEnergy(10) < sea.chopEnergy(15));
  assert.equal(sea.chopEnergy(40), 2.6);
  assert.ok(sea.chopEnergy(3, 1.2) > sea.chopEnergy(3)); // a wind sea from further out
  assert.equal(sea.whitecapCover(4), 0);
  assert.ok(sea.whitecapCover(7) > 0.05 && sea.whitecapCover(7) < 0.3);
  assert.equal(sea.whitecapCover(20), 1);
});

test('the tidal bands follow the last high water: a spring tide\'s where they were drawn, a neap\'s lower', () => {
  assert.equal(sea.bandMark({ level: -2, next: [] }), 0); // no curve: a spring tide's
  assert.ok(near(sea.bandMark({ level: 1.6, next: [] }), 0.1));
  assert.ok(near(sea.bandMark({ level: -1, next: [{ kind: 'low', level: -1.4 }, { kind: 'high', level: 0.9 }] }), -0.6));
  assert.ok(near(sea.bandMark({ level: 1.2, next: [{ kind: 'high', level: 1.3 }, { kind: 'low', level: -1.2 }] }), -0.2));
  assert.equal(sea.bandMark(null), 0);
});

test('the Douglas sea scale and the surf on the beaches', () => {
  assert.deepEqual(sea.douglas(0), { degree: 0, name: 'calm (glassy)' });
  assert.equal(sea.douglas(0.05).name, 'calm (rippled)');
  assert.equal(sea.douglas(0.3).name, 'smooth');
  assert.equal(sea.douglas(1.14).name, 'slight');
  assert.equal(sea.douglas(2).name, 'moderate');
  assert.equal(sea.douglas(3).name, 'rough');
  assert.equal(sea.douglas(5).degree, 6);
  assert.equal(sea.douglas(20).name, 'phenomenal');
  const usual = sea.surfReport({ waveHeight: 1.2, swellHeight: 1.2, swellFrom: 315, waveFrom: 315, wavePeriod: 10 });
  assert.ok(usual.zurriola > usual.ondarreta && usual.ondarreta > usual.concha);
  assert.equal(usual.zurriola, 1);
  assert.equal(usual.concha, 0.3);
  assert.equal(usual.sea.name, 'slight');
  const big = sea.surfReport({ waveHeight: 4.5, swellHeight: 4.2, swellFrom: 320, waveFrom: 320, wavePeriod: 13 });
  assert.ok(big.zurriola > 3.5 && big.concha < 1.5);
});

test('the pontoons float from the lowest to the highest tide and their gangways reach them', () => {
  const { ground, freeboard } = MARINA.level;
  assert.equal(sea.pontoonLevel(0), 0);
  assert.equal(sea.pontoonLevel(1.6), 1.6);
  assert.equal(sea.pontoonLevel(-2.4), -2.4); // the lowest spring tides: still afloat over the basins' -3 m bed
  assert.equal(sea.pontoonLevel(-2.7), ground); // below that they would sit on the bed
  assert.ok(ground < -2.4 && sea.LOW_WATER < ground);
  const G = MARINA.gangways;
  for (const level of [-2.4, 0, 1.6]) {
    for (let k = 0; k < G.length; k += 7) {
      const [, , hy, , , L] = G.slice(k, k + 7);
      const pitch = sea.gangwayPitch(hy, L, level);
      // the foot rests on the deck: the drop along the gangway is the hinge's height over it
      assert.ok(near(Math.sin(pitch) * L, hy - (level + freeboard), 1e-6), `gangway ${k / 7} at ${level}`);
      assert.ok(Math.abs(pitch) < (75 * Math.PI) / 180);
    }
  }
  // at mean sea level, as the bake hung them
  assert.ok(near(sea.gangwayPitch(G[2], G[5], 0), Math.asin((G[2] - freeboard) / G[5])));
});

// The baked 2 m terrain (terrain-core.png: R/G heights), sampled at points
const terrainPNG = fs.readFileSync(`${root}${GEO.terrain.core.url}`);
const terrain = await decodePNG(terrainPNG.buffer.slice(terrainPNG.byteOffset, terrainPNG.byteOffset + terrainPNG.byteLength));
const T = GEO.terrain.core;
const bedAt = (x, z) => {
  const i = Math.floor((x - T.x0) / T.res), j = Math.floor((z - T.z0) / T.res), k = 3 * (j * T.w + i);
  return ((terrain.data[k] << 8) | terrain.data[k + 1]) / 100 - GEO.terrain.heightOffset;
};
const dredged = (x, z) => sea.channelFloor(x, z, bedAt(x, z));

test('low-water channels: the ferries float to Santa Klara\'s jetty and the Urumea reaches the sea at the lowest tide', () => {
  const lowest = -2.4, draft = 0.85;
  // the lanes' last 150 m to the island's landing, under the hull (within 4 m of its track)
  for (const f of FERRY.ferries) {
    const [lx, lz] = [f.island[0] / 100, f.island[1] / 100];
    for (const lane of [f.out, f.back]) {
      for (let k = 0; k < lane.length; k += 3) {
        const x = lane[k] / 100, z = lane[k + 1] / 100;
        if (Math.hypot(x - lx, z - lz) > 150) continue;
        for (const [dx, dz] of [[0, 0], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
          const floor = dredged(x + dx, z + dz);
          assert.ok(floor < lowest - draft + 0.6, `(${x + dx}, ${z + dz}): floor ${floor.toFixed(2)}`);
        }
        // (and the undredged fill would have stranded it: the reason for the channel)
      }
    }
    assert.ok(bedAt(lx, lz) > lowest);
  }
  // the river's channel holds water all the way from its -3.5 m bed to the sea's -3 m contour
  const path = sea.LOW_WATER_CHANNELS.find((c) => c.name === 'Urumea mouth').path;
  let dry = 0;
  for (let k = 0; k + 3 < path.length; k += 2) {
    for (let s = 0; s <= 1; s += 0.1) {
      const x = path[k] + (path[k + 2] - path[k]) * s, z = path[k + 1] + (path[k + 3] - path[k + 1]) * s;
      assert.ok(dredged(x, z) < lowest - 0.5, `(${x}, ${z}): floor ${dredged(x, z).toFixed(2)}`);
      if (bedAt(x, z) > lowest) dry++;
    }
  }
  assert.ok(dry > 20, 'without the channel the bar dries');
  // nothing changes away from the channels, nor above mean sea level
  for (const [x, z] of [[-300, 600], [900, -600], [0, -150], [545, -430]]) assert.equal(dredged(x, z), bedAt(x, z));
  assert.equal(sea.channelFloor(-918, 112, 2.5), 2.5);
});

test('spray in a big swell: on the Paseo Nuevo, the Peine del Viento and the Zurriola dike, never on the beaches', async () => {
  const load = (rel) => {
    const b = fs.readFileSync(`${root}${rel}`);
    return decodePNG(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  const [context, water] = await Promise.all([load(GEO.terrain.context.url), load('data/donostia/water.png')]);
  const X = GEO.terrain.context;
  const contextAt = (x, z) => {
    const i = Math.floor((x - X.x0) / X.res), j = Math.floor((z - X.z0) / X.res), k = 3 * (j * X.w + i);
    return ((context.data[k] << 8) | context.data[k + 1]) / 100 - GEO.terrain.heightOffset;
  };
  const inCore = (x, z) => x > T.x0 && x < T.x0 + T.w * T.res && z > T.z0 && z < T.z0 + T.h * T.res;
  const places = sea.sprayPlaces(water, X, (x, z) => (inCore(x, z) ? bedAt(x, z) : contextAt(x, z)));
  assert.ok(places.length > 80 && places.length <= 260, `${places.length} places`);
  const near = (x, z, r) => places.filter(([px, pz]) => Math.hypot(px - x, pz - z) < r).length;
  assert.ok(near(100, -600, 150) >= 5, 'the Paseo Nuevo');
  assert.ok(near(-1370, -20, 120) >= 3, 'the Peine del Viento');
  assert.ok(near(600, -520, 100) >= 2, 'the Zurriola dike');
  for (const [x, z, r, name] of [[-300, 650, 250, 'La Concha'], [-1000, 520, 150, 'Ondarreta'], [950, -560, 150, 'Zurriola']]) {
    assert.equal(near(x, z, r), 0, name);
  }
  for (const [, , phase, strength] of places) assert.ok(phase >= 0 && phase < 1 && strength > 0 && strength <= 1);
});
