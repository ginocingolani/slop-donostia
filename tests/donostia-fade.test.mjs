import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Every change of the time of day is a fade (js/donostia/live-sky.js): preset to preset, real time to a preset, a
// preset to real time; from where the blend stands when another time is picked mid-fade; onto the preset itself at
// the end; at once with prefers-reduced-motion; with no more bakes of the environment map than the tier's gap allows.
// live-sky.js imports three.js: it is loaded here through tests/helpers/module.cjs with a stand-in for the one class
// it uses, a fake lighting that records what it is told, and the real time-of-day.js for the looks.

const root = fileURLToPath(new URL('../', import.meta.url));
const { loadModule } = createRequire(import.meta.url)('./helpers/module.cjs');
const tod = await import(pathToFileURL(`${root}js/donostia/time-of-day.js`).href);
const liveState = await import(pathToFileURL(`${root}js/donostia/live-state.js`).href);

const vec = (azimuth, elevation) => { const [x, y, z] = tod.direction(azimuth, elevation); return { x, y, z }; };
const base = {
  sunColor: 0xffca92, sunIntensity: 5.8, hemiSky: 0x9abbe6, hemiGround: 0xc88a62, hemiIntensity: 1.48, skyTop: 0x2c568c, skyHorizon: 0xebd1b5,
  fogColor: 0xdcc5ae, fogDensity: 0.0002, interiorGlow: 0.48, roadWetness: 0.28, envIntensity: 0.54, canyonBounce: 0.52, turbidity: 8, rayleigh: 2.8,
  mieCoefficient: 0.008, mieDirectionalG: 0.88, cloudCoverage: 0.36, cloudDensity: 0.38, skyExposure: 0.148, nightFactor: 0
};
const PRESETS = {
  golden: { ...base, id: 'golden', daylight: 0.72, clock: 20.5, sunDir: vec(290, 11) },
  midday: { ...base, id: 'midday', sunColor: 0xfff5e8, sunIntensity: 6.6, hemiIntensity: 1.58, interiorGlow: 0.24, roadWetness: 0.08, skyExposure: 0.142, daylight: 1, clock: 13, sunDir: vec(195, 63) },
  twilight: { ...base, id: 'twilight', sunIntensity: 3.1, interiorGlow: 1.25, roadWetness: 0.55, skyExposure: 0.115, nightFactor: 0.28, daylight: 0.3, clock: 22, sunDir: vec(302, 5) },
  midnight: { ...base, id: 'midnight', sunColor: 0x8cb0e8, sunIntensity: 1.45, hemiIntensity: 0.72, fogColor: 0x0c1424, fogDensity: 0.00036, interiorGlow: 1.55, roadWetness: 0.62, skyExposure: 0.022, nightFactor: 0.86, daylight: 0.05, clock: 1, sunDir: vec(150, 38) }
};
const LOOKS = {
  golden: { exposure: 1.04, contrast: 1.12, saturation: 1.08, balance: [1.045, 1, 0.955], bloom: 0.24, threshold: 1.2 },
  midday: { exposure: 1, contrast: 1.1, saturation: 1.06, balance: [1.015, 1, 0.985], bloom: 0.18, threshold: 1.35 },
  twilight: { exposure: 1.06, contrast: 1.1, saturation: 1.08, balance: [1.025, 0.995, 1.015], bloom: 0.28, threshold: 1.05 },
  midnight: { exposure: 1.04, contrast: 1.08, saturation: 1.06, balance: [0.985, 1, 1.035], bloom: 0.3, threshold: 1 }
};

// A world for the sky: the lighting and the grade record what they are told; the live state is a switch and a fixed
// afternoon. reduced: prefers-reduced-motion
function world({ reduced = false, bakeGap = 0.15 } = {}) {
  const log = []; // ['preset', id] | ['look', look]
  const lighting = {
    activePresetId: 'golden', bakes: 0, sunLight: { position: { x: 0, y: 1, z: 0 } },
    applyPreset(id, force) { log.push(['preset', id, Boolean(force)]); this.activePresetId = id; this.bakes++; },
    applyLook(look) { log.push(['look', look]); this.activePresetId = 'live'; },
    bakeEnvironmentMap() { this.bakes++; }
  };
  const grade = { looks: LOOKS, presets: [], last: null, applyPreset(id) { this.presets.push(id); this.last = LOOKS[id]; }, applyLook(look) { this.last = look; } };
  const state = { enabled: false, sun: { azimuth: 200, elevation: 40 }, moon: { azimuth: 90, elevation: -20, illumination: 0.5 } };
  const live = {
    liveEnabled: () => state.enabled, liveNow: () => new Date('2026-06-20T14:00:00Z'), CALM_WEATHER: liveState.CALM_WEATHER,
    liveSnapshot: () => ({ date: new Date('2026-06-20T14:00:00Z'), sun: state.sun, moon: state.moon, weather: liveState.CALM_WEATHER, status: 'ok' })
  };
  class Vector3 { constructor() { this.x = this.y = this.z = 0; } copy(v) { Object.assign(this, { x: v.x, y: v.y, z: v.z }); return this; } normalize() { return this; } fromArray(a) { [this.x, this.y, this.z] = a; return this; } set(x, y, z) { Object.assign(this, { x, y, z }); return this; } }
  const { createLiveSky } = loadModule(fs.readFileSync(`${root}js/donostia/live-sky.js`, 'utf8'), {
    filename: 'live-sky.js',
    imports: { 'three/webgpu': { Vector3 }, './live-state.js': live, './time-of-day.js': tod, '../city-uniforms.js': { cityUniforms: { uDaylight: { value: 1 } } } },
    globals: { performance, Math, Object, Array, Date, matchMedia: (q) => ({ matches: reduced && /prefers-reduced-motion: reduce/.test(q) }) }
  });
  const sky = createLiveSky({ lighting, presets: PRESETS });
  sky.attachGrade(grade);
  sky.bakeGap = bakeGap;
  const frames = (seconds, dt = 1 / 60) => { for (let t = 0; t < seconds - 1e-9; t += dt) sky.update(dt); };
  const looks = () => log.filter((e) => e[0] === 'look').map((e) => e[1]);
  return { sky, lighting, grade, state, log, frames, looks };
}
const last = (list) => list[list.length - 1];

test('before the city shows a preset is applied at once; after it, a pick fades over two seconds and lands on the preset', () => {
  const w = world();
  w.sky.setPreset('golden');
  assert.deepEqual(w.log, [['preset', 'golden', true]], 'not ready: no fade, no frame needed');
  w.sky.ready = true;
  w.log.length = 0;
  w.sky.setPreset('midnight');
  assert.equal(w.log.length, 0, 'nothing jumps on the pick');
  assert.equal(w.sky.preset, 'midnight');
  w.frames(1);
  // half way: every field between the two, none of them at either end
  const half = last(w.looks());
  assert.ok(Math.abs(w.sky.fade - 0.5) < 0.02);
  for (const k of ['sunIntensity', 'hemiIntensity', 'interiorGlow', 'roadWetness', 'skyExposure', 'nightFactor', 'fogDensity', 'daylight']) {
    const a = PRESETS.golden[k], b = PRESETS.midnight[k];
    assert.ok(half[k] > Math.min(a, b) && half[k] < Math.max(a, b), `${k} half way: ${half[k]} between ${a} and ${b}`);
    assert.ok(Math.abs(half[k] - (a + b) / 2) < 0.05 * Math.abs(a - b), `${k} is at the middle at the fade's middle`);
  }
  assert.ok(half.sunColor.every((c, i) => c !== tod.srgbToLinear(PRESETS.golden.sunColor)[i]), 'colours too');
  assert.ok(half.grade.exposure === 1.04 && half.grade.bloom > 0.24 && half.grade.bloom < 0.3 && half.grade.balance[2] > 0.955 && half.grade.balance[2] < 1.035, 'and the grade');
  assert.equal(w.grade.last, half.grade);
  assert.ok(half.lightAzEl.elevation > 11 && half.lightAzEl.elevation < 38, 'the light swings from one sun to the other');
  // no step along the way: each frame within 3% of the way, monotonic
  const steps = w.looks().map((l) => l.skyExposure);
  for (let i = 1; i < steps.length; i++) assert.ok(steps[i] <= steps[i - 1] && steps[i - 1] - steps[i] < 0.03 * (0.148 - 0.022), `frame ${i}`);
  w.frames(1.1);
  // the end: the preset itself, by applyPreset (its exact values and its own bake), and nothing after it
  assert.deepEqual(last(w.log), ['preset', 'midnight', true]);
  assert.deepEqual([w.lighting.activePresetId, last(w.grade.presets), w.sky.fade], ['midnight', 'midnight', 1]);
  const n = w.log.length;
  w.frames(1);
  assert.equal(w.log.length, n, 'a preset that stands costs nothing a frame');
  // the last blended frame was already next to it
  const end = last(w.looks());
  assert.ok(Math.abs(end.sunIntensity - PRESETS.midnight.sunIntensity) < 0.01 && Math.abs(end.skyExposure - PRESETS.midnight.skyExposure) < 0.001);
  // (the hour the ferries read is the picked preset's from the pick on)
  assert.equal(w.sky.hour(), 1);
});

test('another time picked mid-fade starts from where the blend stands', () => {
  const w = world();
  w.sky.ready = true;
  w.sky.setPreset('midnight');
  w.frames(0.8);
  const before = last(w.looks());
  w.sky.setPreset('midday');
  w.frames(1 / 60);
  const after = last(w.looks());
  for (const k of ['sunIntensity', 'skyExposure', 'interiorGlow', 'nightFactor']) {
    assert.ok(Math.abs(after[k] - before[k]) < 0.01 * Math.max(PRESETS.golden[k], PRESETS.midnight[k], PRESETS.midday[k]), `${k}: ${before[k]} -> ${after[k]}`);
  }
  assert.ok(Math.abs(after.lightAzEl.elevation - before.lightAzEl.elevation) < 0.5);
  w.frames(2.1);
  assert.deepEqual(last(w.log), ['preset', 'midday', true]);
  assert.equal(w.log.filter((e) => e[0] === 'preset').length, 1, 'the abandoned target was never landed on');
});

test('real time to a preset and back are fades too, from the look on show', () => {
  const w = world();
  w.sky.ready = true;
  // a preset to real time (as it always did): from the golden hour to a June afternoon
  w.state.enabled = true;
  w.frames(1 / 60);
  const first = last(w.looks());
  assert.ok(Math.abs(first.sunIntensity - PRESETS.golden.sunIntensity) < 0.02, 'starts at the preset on show');
  w.frames(2.2);
  const liveLook = last(w.looks());
  assert.ok(Math.abs(liveLook.sunIntensity - PRESETS.midday.sunIntensity) < 1e-6 && w.sky.state.live);
  // real time off, with twilight picked: no cut
  w.sky.setPreset('twilight'); // (while real time is on the pick only waits)
  w.frames(1 / 60);
  assert.equal(last(w.looks()).sunIntensity, liveLook.sunIntensity);
  w.state.enabled = false;
  w.frames(1 / 60);
  const off = last(w.looks());
  assert.ok(Math.abs(off.sunIntensity - liveLook.sunIntensity) < 0.02 && w.lighting.activePresetId === 'live', 'the first frame after is still the live look, nearly');
  w.frames(1);
  const mid = last(w.looks());
  assert.ok(mid.sunIntensity < 6 && mid.sunIntensity > 3.5 && mid.roadWetness > 0.08 && mid.roadWetness < 0.55, 'half way to the blue hour, its wet streets coming');
  w.frames(1.2);
  assert.deepEqual(last(w.log), ['preset', 'twilight', true]);
  // and back on mid-fade to another preset: from where that fade stands
  w.sky.setPreset('midnight');
  w.frames(1);
  const standing = last(w.looks());
  w.state.enabled = true;
  w.frames(1 / 60);
  assert.ok(Math.abs(last(w.looks()).sunIntensity - standing.sunIntensity) < 0.05);
  w.frames(2.2);
  assert.ok(Math.abs(last(w.looks()).sunIntensity - PRESETS.midday.sunIntensity) < 1e-6);
  assert.equal(w.log.filter((e) => e[0] === 'preset' && e[1] === 'midnight').length, 0);
  // the city first showing in real time skips the fade (the HUD's skipFade), as before
  const v = world();
  v.sky.ready = true;
  v.sky.skipFade = true;
  v.state.enabled = true;
  v.frames(1 / 60);
  assert.ok(Math.abs(last(v.looks()).sunIntensity - PRESETS.midday.sunIntensity) < 1e-6);
});

test('prefers-reduced-motion: no fade, the change at once', () => {
  const w = world({ reduced: true });
  w.sky.ready = true;
  w.log.length = 0;
  w.sky.setPreset('midnight');
  assert.deepEqual(w.log, [['preset', 'midnight', true]]);
  w.frames(0.5);
  assert.equal(w.log.length, 1);
  w.state.enabled = true;
  w.frames(1 / 60);
  assert.ok(Math.abs(last(w.looks()).sunIntensity - PRESETS.midday.sunIntensity) < 1e-6, 'into real time at once too');
  w.state.enabled = false;
  w.frames(1 / 60);
  assert.deepEqual(last(w.log), ['preset', 'midnight', true]);
  // { instant: true } does the same for a caller that wants it
  const v = world();
  v.sky.ready = true;
  v.log.length = 0;
  v.sky.setPreset('midday', { instant: true });
  assert.deepEqual(v.log, [['preset', 'midday', true]]);
});

test("a fade bakes the environment map no more often than the tier's gap, and a preset that does not change bakes nothing", () => {
  for (const [bakeGap, most] of [[0.15, 15], [1, 3], [2, 2]]) {
    const w = world({ bakeGap });
    w.sky.ready = true;
    const before = w.lighting.bakes;
    w.sky.setPreset('midnight');
    w.frames(2.1);
    const bakes = w.lighting.bakes - before; // (the fade's, and the preset's own at the end)
    assert.ok(bakes >= 2 && bakes <= most, `gap ${bakeGap}: ${bakes} bakes`);
  }
  // the same look again: a fade of nothing, no bake but the landing's
  const w = world();
  w.sky.ready = true;
  const before = w.lighting.bakes;
  w.sky.setPreset('golden');
  w.frames(2.1);
  assert.equal(w.lighting.bakes - before, 1);
});

test('a number or a colour added to the looks fades with the rest, unlisted', () => {
  const a = tod.presetLook(PRESETS, LOOKS, 'golden'), b = tod.presetLook(PRESETS, LOOKS, 'midnight');
  Object.assign(a, { lampGlow: 0, lampColor: [1, 0.5, 0] });
  Object.assign(b, { lampGlow: 1, lampColor: [0, 0.5, 1] });
  const mid = tod.mixLooks(a, b, 0.25);
  assert.equal(mid.lampGlow, 0.25);
  assert.deepEqual(mid.lampColor, [0.75, 0.5, 0.25]);
  // the HUD goes through the sky for every pick, and tells real time going off by its own switch
  const hud = fs.readFileSync(`${root}js/donostia/hud.js`, 'utf8');
  assert.match(hud, /if \(liveSky\?\.setPreset\) liveSky\.setPreset\(id\);/);
  assert.match(hud, /const was = liveShown;\s*showLive\(snap\.enabled\);\s*if \(!snap\.enabled && was\) applyTime\(time\);/);
});
