import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real-time switch's continuous time of day (js/donostia/time-of-day.js): the four presets as keyframes on the
// real sun's elevation, the moon at night, the weather on top. The presets here are js/lighting.js's TIME_PRESETS as
// js/donostia/presets.js re-aims them (their numbers copied: lighting.js needs three.js), the looks post-processing.js's.

const root = fileURLToPath(new URL('../', import.meta.url));
const tod = await import(pathToFileURL(`${root}js/donostia/time-of-day.js`).href);
const live = await import(pathToFileURL(`${root}js/donostia/live-state.js`).href);

const vec = (azimuth, elevation) => {
  const [x, y, z] = tod.direction(azimuth, elevation);
  return { x, y, z };
};
const PRESETS = {
  golden: { sunColor: 0xffca92, sunIntensity: 5.8, hemiSky: 0x9abbe6, hemiGround: 0xc88a62, hemiIntensity: 1.48, skyTop: 0x2c568c,
    skyHorizon: 0xebd1b5, fogColor: 0xdcc5ae, fogDensity: 0.00020, interiorGlow: 0.48, roadWetness: 0.28, envIntensity: 0.54,
    canyonBounce: 0.52, turbidity: 8.0, rayleigh: 2.8, mieCoefficient: 0.008, mieDirectionalG: 0.88, cloudCoverage: 0.36,
    cloudDensity: 0.38, skyExposure: 0.148, nightFactor: 0.0, daylight: tod.DAYLIGHT.golden, sunDir: vec(290, 11) },
  midday: { sunColor: 0xfff5e8, sunIntensity: 6.6, hemiSky: 0xaad2ff, hemiGround: 0xb89678, hemiIntensity: 1.58, skyTop: 0x225ea8,
    skyHorizon: 0xc8dff5, fogColor: 0xc6dcf2, fogDensity: 0.00015, interiorGlow: 0.24, roadWetness: 0.08, envIntensity: 0.58,
    canyonBounce: 0.58, turbidity: 6.5, rayleigh: 2.4, mieCoefficient: 0.006, mieDirectionalG: 0.86, cloudCoverage: 0.32,
    cloudDensity: 0.35, skyExposure: 0.142, nightFactor: 0.0, daylight: tod.DAYLIGHT.midday, sunDir: vec(195, 63) },
  twilight: { sunColor: 0xff9466, sunIntensity: 3.1, hemiSky: 0x4c6ca8, hemiGround: 0x6e5048, hemiIntensity: 0.85, skyTop: 0x102248,
    skyHorizon: 0xb86b6c, fogColor: 0x353c58, fogDensity: 0.00032, interiorGlow: 1.25, roadWetness: 0.55, envIntensity: 0.36,
    canyonBounce: 0.32, turbidity: 9.5, rayleigh: 3.4, mieCoefficient: 0.010, mieDirectionalG: 0.90, cloudCoverage: 0.40,
    cloudDensity: 0.42, skyExposure: 0.115, nightFactor: 0.28, daylight: tod.DAYLIGHT.twilight, sunDir: vec(302, 5) },
  midnight: { sunColor: 0x8cb0e8, sunIntensity: 1.45, hemiSky: 0x263a62, hemiGround: 0x382e36, hemiIntensity: 0.72, skyTop: 0x060c1a,
    skyHorizon: 0x182640, fogColor: 0x0c1424, fogDensity: 0.00036, interiorGlow: 1.55, roadWetness: 0.62, envIntensity: 0.30,
    canyonBounce: 0.18, turbidity: 4.0, rayleigh: 1.5, mieCoefficient: 0.004, mieDirectionalG: 0.80, cloudCoverage: 0.22,
    cloudDensity: 0.25, skyExposure: 0.022, nightFactor: 0.86, daylight: tod.DAYLIGHT.midnight, sunDir: vec(150, 38) }
};
const LOOKS = {
  golden: { exposure: 1.04, contrast: 1.12, saturation: 1.08, balance: [1.045, 1.00, 0.955], bloom: 0.24, threshold: 1.20 },
  midday: { exposure: 1.00, contrast: 1.10, saturation: 1.06, balance: [1.015, 1.00, 0.985], bloom: 0.18, threshold: 1.35 },
  twilight: { exposure: 1.06, contrast: 1.10, saturation: 1.08, balance: [1.025, 0.995, 1.015], bloom: 0.28, threshold: 1.05 },
  midnight: { exposure: 1.04, contrast: 1.08, saturation: 1.06, balance: [0.985, 1.00, 1.035], bloom: 0.30, threshold: 1.00 }
};
const FULL_MOON_HIGH = { azimuth: 150, elevation: 38, illumination: 1 };
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
const at = (elevation, { moon = FULL_MOON_HIGH, weather = live.CALM_WEATHER, azimuth = 290 } = {}) =>
  tod.timeOfDay({ sun: { azimuth, elevation }, moon, weather }, PRESETS, LOOKS);

test('each preset shows exactly where the real sun stands at its keyframe, in calm weather', () => {
  for (const [id, elevation] of tod.ANCHORS) {
    const look = at(elevation);
    assert.equal(look.weights[id], 1, `${id} at ${elevation}°`);
    const p = PRESETS[id];
    for (const k of ['sunIntensity', 'hemiIntensity', 'interiorGlow', 'roadWetness', 'envIntensity', 'canyonBounce', 'turbidity',
      'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity', 'skyExposure', 'nightFactor', 'fogDensity']) {
      assert.ok(close(look[k], p[k]), `${id}.${k}: ${look[k]} vs ${p[k]}`);
    }
    for (const k of ['sunColor', 'hemiSky', 'skyTop', 'skyHorizon', 'fogColor']) {
      tod.srgbToLinear(p[k]).forEach((c, i) => assert.ok(close(look[k][i], c), `${id}.${k}`));
    }
    for (const k of ['exposure', 'contrast', 'saturation', 'bloom', 'threshold']) assert.ok(close(look.grade[k], LOOKS[id][k]), `${id} grade ${k}`);
    assert.equal(look.skyGrey, 0);
    assert.equal(look.fogGrey, 0);
  }
});

test('the blend is continuous: no parameter jumps as the sun goes down', () => {
  let prev = at(70);
  for (let e = 70; e >= -30; e -= 0.05) {
    const look = at(e);
    const sum = Object.values(look.weights).reduce((a, b) => a + b, 0);
    assert.ok(close(sum, 1), `weights sum ${sum} at ${e}`);
    // (each step under 2% of the parameter's range over the four presets)
    for (const k of ['sunIntensity', 'skyExposure', 'nightFactor', 'interiorGlow', 'hemiIntensity', 'envIntensity', 'fogDensity']) {
      const range = Math.max(...Object.values(PRESETS).map((p) => p[k]));
      assert.ok(Math.abs(look[k] - prev[k]) < 0.02 * range, `${k} jumps at ${e.toFixed(2)}°: ${prev[k]} -> ${look[k]}`);
    }
    // the light (its direction times its strength) moves smoothly: it hands over from the sun to the moon through
    // nothing, never more than 3% of the twilight's light for a twentieth of a degree (12 s in June)
    const d = look.lightDir.map((c, i) => c * look.sunIntensity - prev.lightDir[i] * prev.sunIntensity);
    assert.ok(Math.hypot(...d) < 0.03 * PRESETS.twilight.sunIntensity, `the light jumps at ${e.toFixed(2)}°: ${Math.hypot(...d)}`);
    // so does the sky's sunlit part where it changes sides
    if (look.skyAzEl.azimuth !== prev.skyAzEl.azimuth) assert.ok(look.skyExposure < 1e-3, `the sky's sun jumps at ${e.toFixed(2)}°`);
    prev = look;
  }
});

test('the light never comes from under the horizon', () => {
  for (let e = -40; e <= 70; e += 1) {
    for (const moonEl of [-50, -5, 0, 3, 30]) {
      const look = at(e, { moon: { azimuth: 80, elevation: moonEl, illumination: 0.6 } });
      assert.ok(look.lightAzEl.elevation >= 4.99, `light at ${look.lightAzEl.elevation}° for sun ${e}°, moon ${moonEl}°`);
      assert.ok(look.skyAzEl.elevation > 0, `sky sun at ${look.skyAzEl.elevation}°`);
    }
  }
  // by day, the real sun
  const noon = at(60, { azimuth: 180 });
  assert.ok(close(noon.lightAzEl.elevation, 60) && close(noon.lightAzEl.azimuth, 180));
  assert.equal(tod.liftedSun(11), 11);
  assert.equal(tod.liftedSun(-3), 5);
  assert.equal(tod.liftedSun(-20), 5);
});

test('the moon lights the night: from where it stands, by its phase; a new moon is darker', () => {
  const full = at(-30, { moon: { azimuth: 120, elevation: 40, illumination: 1 } });
  const half = at(-30, { moon: { azimuth: 120, elevation: 40, illumination: 0.5 } });
  const none = at(-30, { moon: { azimuth: 120, elevation: 40, illumination: 0.0 } });
  const down = at(-30, { moon: { azimuth: 300, elevation: -30, illumination: 1 } });
  assert.ok(close(full.lightAzEl.azimuth, 120) && close(full.lightAzEl.elevation, 40, 1e-3), JSON.stringify(full.lightAzEl));
  assert.ok(full.sunIntensity > half.sunIntensity && half.sunIntensity > none.sunIntensity);
  assert.ok(full.skyExposure > none.skyExposure && full.hemiIntensity > none.hemiIntensity && full.nightSky > none.nightSky);
  assert.ok(close(none.sunIntensity, down.sunIntensity));
  assert.ok(full.sunDisc > 0.9 && none.sunDisc === 0 && down.sunDisc === 0);
  // a moon under the horizon, or a new one, leaves the light to the preset's night sky
  assert.ok(close(down.lightAzEl.azimuth, 150, 1e-6) && close(down.lightAzEl.elevation, 38, 1e-6));
  assert.ok(close(none.lightAzEl.azimuth, 150, 1e-6) && close(none.lightAzEl.elevation, 38, 1e-6));
  assert.equal(tod.moonlight({ elevation: 40, illumination: 1 }), 1);
  assert.equal(tod.moonlight({ elevation: -5, illumination: 1 }), 0);
});

test('the weather: overcast dims the sun and lifts the fill, rain darkens and greys, the visibility sets the haze', () => {
  const clear = at(40, { weather: { ...live.CALM_WEATHER, cloudCover: 0, cloudCoverLow: 0, visibility: 40000 } });
  const calm = at(40);
  const overcast = at(40, { weather: { ...live.CALM_WEATHER, kind: 'overcast', cloudCover: 1, cloudCoverLow: 0.8, visibility: 12000 } });
  const rain = at(40, { weather: { ...live.CALM_WEATHER, kind: 'rain', intensity: 0.65, cloudCover: 1, cloudCoverLow: 1, visibility: 4000 } });
  const fog = at(40, { weather: { ...live.CALM_WEATHER, kind: 'fog', intensity: 0.7, cloudCover: 1, cloudCoverLow: 1, visibility: 400 } });
  assert.ok(clear.cloudCoverage < calm.cloudCoverage && calm.cloudCoverage < overcast.cloudCoverage);
  assert.ok(overcast.sunIntensity < 0.35 * calm.sunIntensity && overcast.hemiIntensity > calm.hemiIntensity);
  assert.ok(rain.skyExposure < overcast.skyExposure && rain.skyGrey > overcast.skyGrey);
  assert.ok(clear.fogDensity < calm.fogDensity && calm.fogDensity < rain.fogDensity && rain.fogDensity < fog.fogDensity);
  // fog: 400 m away, 98% gone; clear: 40 km of visibility leaves a hill 5 km off barely veiled
  const veil = (look, d) => 1 - Math.exp(-((look.fogDensity * d) ** 2));
  assert.ok(veil(fog, 400) > 0.98, `fog at 400 m: ${veil(fog, 400)}`);
  assert.ok(veil(clear, 5000) < 0.5, `clear at 5 km: ${veil(clear, 5000)}`);
  assert.ok(overcast.daylight < calm.daylight && rain.daylight < overcast.daylight);
});

test('the keyframes over a day in mid-June and mid-December', () => {
  const day = (iso) => {
    const date = new Date(iso);
    return at(live.sunPosition(date).elevation);
  };
  assert.equal(day('2026-06-15T12:00:00Z').weights.midday, 1); // 14:00
  assert.ok(day('2026-06-15T18:30:00Z').weights.golden > 0.95); // 20:30, the golden preset's own hour
  assert.equal(day('2026-06-15T23:00:00Z').weights.midnight, 1); // 01:00
  assert.ok(day('2026-12-15T11:00:00Z').weights.midday > 0.85); // 12:00, the winter sun 22° up
  assert.equal(day('2026-12-15T19:00:00Z').weights.midnight, 1); // 20:00
});

test('the city keeps its own hours, summer time and winter time', () => {
  assert.ok(close(tod.cityHour(new Date('2026-06-15T18:30:00Z')), 20.5));
  assert.ok(close(tod.cityHour(new Date('2026-12-15T22:45:00Z')), 23.75));
  // the night the clocks go back (25 October 2026, 03:00 CEST -> 02:00 CET)
  assert.ok(close(tod.cityHour(new Date('2026-10-25T00:30:00Z')), 2.5));
  assert.ok(close(tod.cityHour(new Date('2026-10-25T01:30:00Z')), 2.5));
});
