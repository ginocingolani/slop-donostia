import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The weather's effects as numbers (js/donostia/weather-model.js): the wind in the local frame, what falls and how
// densely, the streets' wetness wetting and drying on the city's clock, the lightning's strokes and thunder.

const root = fileURLToPath(new URL('../', import.meta.url));
const W = await import(pathToFileURL(`${root}js/donostia/weather-model.js`).href);
const live = await import(pathToFileURL(`${root}js/donostia/live-state.js`).href);
const preset = (kind) => {
  live.setLiveOverride({ weather: kind });
  const w = live.liveSnapshot().weather;
  live.clearLiveOverride();
  return w;
};

test('the wind blows from where the weather says, in the local frame (x east, z south)', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  const north = W.windVector({ windFrom: 0, windSpeed: 5, windGust: 9 });
  assert.ok(near(north.x, 0) && near(north.z, 1), 'a northerly blows south (+z)');
  assert.equal(north.speed, 5);
  assert.equal(north.gust, 9);
  const west = W.windVector({ windFrom: 270, windSpeed: 5 });
  assert.ok(near(west.x, 1) && near(west.z, 0), 'a westerly blows east (+x)');
  // the trees' old fixed breeze, (0.6, 0.8), is a north-westerly from ~323°
  const nw = W.windVector({ windFrom: 323.13, windSpeed: 4 });
  assert.ok(Math.abs(nw.x - 0.6) < 1e-3 && Math.abs(nw.z - 0.8) < 1e-3, JSON.stringify(nw));
  // gusts never under the mean
  assert.equal(W.windVector({ windFrom: 0, windSpeed: 8, windGust: 3 }).gust, 8);
});

test('gusts come and go smoothly between the mean wind and the gust', () => {
  let lo = 1, hi = 0, jump = 0, prev = W.gustFactor(0);
  for (let t = 0; t < 600; t += 0.05) {
    const g = W.gustFactor(t, 3);
    lo = Math.min(lo, g);
    hi = Math.max(hi, g);
    if (t > 0) jump = Math.max(jump, Math.abs(g - prev));
    prev = g;
  }
  assert.ok(lo >= 0 && hi <= 1 && hi - lo > 0.6, `${lo}..${hi}`);
  assert.ok(jump < 0.05, `a step of ${jump}`);
});

test('what falls: nothing in fair weather, more and faster from drizzle to a storm, slow flakes in snow', () => {
  for (const kind of ['clear', 'cloudy', 'overcast', 'fog']) assert.equal(W.precipitation(preset(kind)).kind, 'none', kind);
  const drizzle = W.precipitation(preset('drizzle')), rain = W.precipitation(preset('rain'));
  const showers = W.precipitation(preset('showers')), storm = W.precipitation(preset('storm'));
  const snow = W.precipitation(preset('snow'));
  assert.equal(drizzle.particle, 'rain');
  assert.ok(drizzle.fall < rain.fall && rain.fall < showers.fall && showers.fall < storm.fall);
  assert.ok(drizzle.length < rain.length && rain.length < storm.length);
  assert.ok(rain.density < storm.density && storm.density > 0.9, `${rain.density} ${storm.density}`);
  assert.ok(drizzle.density > 0.3, `drizzle ${drizzle.density}`);
  assert.equal(snow.particle, 'snow');
  assert.ok(snow.fall < 1.5 && snow.density > 0.5);
  // an overcast sky with a measured rate rains lightly; a rain code with no rate yet still rains by its intensity
  assert.equal(W.precipitation({ kind: 'overcast', precipitation: 1.2 }).kind, 'rain');
  assert.equal(W.precipitation({ kind: 'overcast', precipitation: 0.3 }).kind, 'drizzle');
  assert.ok(W.precipitation({ kind: 'rain', intensity: 0.65, precipitation: 0 }).density > 0.5);
});

test('the streets wet within minutes under rain and dry over an hour after it', () => {
  const rain = preset('rain'), drizzle = preset('drizzle'), storm = preset('storm');
  const cloudy = preset('cloudy'), clear = preset('clear');
  assert.ok(W.wetnessTarget(drizzle) < W.wetnessTarget(rain) && W.wetnessTarget(rain) < W.wetnessTarget(storm));
  assert.equal(W.wetnessTarget(clear), 0);
  assert.ok(W.wetnessTarget(preset('fog')) > 0 && W.wetnessTarget(preset('fog')) < 0.2);
  // ten minutes of rain from dry: most of the way
  let w = 0;
  for (let m = 0; m < 10; m++) w = W.stepWetness(w, rain, 1);
  assert.ok(w > 0.7 * W.wetnessTarget(rain), `after 10 min ${w}`);
  // steps of any size agree (exact exponential)
  assert.ok(Math.abs(W.stepWetness(0, rain, 10) - w) < 1e-9);
  // an hour of cloud after it: still damp, drying; two more hours: nearly dry
  const after1 = W.stepWetness(w, cloudy, 60, 0.5);
  assert.ok(after1 < w && after1 > 0.15, `after an hour ${after1}`);
  assert.ok(W.stepWetness(after1, cloudy, 120, 0.5) < 0.1);
  // sunshine and wind dry it sooner than a still night
  const sunny = W.stepWetness(0.8, { ...clear, windSpeed: 8 }, 30, 1), night = W.stepWetness(0.8, { ...cloudy, windSpeed: 1 }, 30, 0);
  assert.ok(sunny < night, `${sunny} vs ${night}`);
  // no time, no change
  assert.equal(W.stepWetness(0.4, rain, 0), 0.4);
});

test('lightning strikes only in a storm, at random intervals, with thunder after its distance', () => {
  assert.equal(W.strikeRate(preset('rain')), 0);
  const rate = W.strikeRate(preset('storm'));
  assert.ok(rate >= 2 && rate <= 6);
  const l = new W.Lightning(7);
  const strikes = [];
  for (let t = 0; t < 600; t += 1 / 30) {
    const s = l.update(t, rate);
    if (s) strikes.push(s);
  }
  // ten minutes at `rate` a minute, give or take
  assert.ok(strikes.length > rate * 10 * 0.5 && strikes.length < rate * 10 * 1.6, `${strikes.length} strikes`);
  for (const s of strikes) {
    assert.ok(s.distance >= 1500 && s.distance <= 18000);
    assert.ok(Math.abs(s.thunder - s.distance / W.SOUND_SPEED) < 1e-9);
    assert.ok(s.strokes.length >= 1 && s.strokes.length <= 4);
  }
  for (let k = 1; k < strikes.length; k++) assert.ok(strikes[k].at - strikes[k - 1].at >= 2.5 - 1e-9);
  // the flash: bright at a stroke, dark a second and a half later; no storm, no strikes
  const s = l.strike(1000, { distance: 2000 });
  assert.ok(l.flash(1000.01) > 0.5 * s.brightness);
  assert.equal(l.flash(1000 + s.strokes[s.strokes.length - 1] + 1.5), 0);
  assert.equal(new W.Lightning(1).update(5, 0), null);
  // the same seed, the same storm
  const a = new W.Lightning(3), b = new W.Lightning(3);
  for (let t = 0; t < 120; t += 0.1) assert.deepEqual(a.update(t, 4), b.update(t, 4));
});
