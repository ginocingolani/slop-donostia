import * as THREE from 'three/webgpu';
import * as live from './live-state.js';
import { timeOfDay, skyWeather, mixLooks, presetLook, smoothstep, cityHour, direction } from './time-of-day.js';
import { cityUniforms } from '../city-uniforms.js';

// js/donostia/live-sky.js
// The time of day on show, and every change of it. While the HUD's real-time switch is on, every frame takes the live
// state (js/donostia/live-state.js) through js/donostia/time-of-day.js's blend of the presets and hands the look to
// the lighting (js/lighting.js's applyLook) and the colour grade; off, a preset stands (js/lighting.js's applyPreset,
// through setPreset() here). The weather eases over a few seconds (it arrives in 15-minute steps), and the sun and the
// moon move with the clock (or a debug override's, a timelapse included) every frame.
//
// No change of the time of day is a cut: preset to preset, real time to a preset and a preset to real time all fade
// over FADE seconds, the whole look at once (the light and where it comes from, the sky, the fog, the colour grade,
// the windows' glow, the streets' wetness: time-of-day.js's mixLooks(), which carries every number and colour a look
// has, so a field added to the looks fades with the rest). A fade starts from what is on show, a fade under way
// included: picking another time mid-fade bends towards it without a jump. A fade to a preset ends on the preset
// itself (applyPreset: its exact values, its own bake). With prefers-reduced-motion there is no fade: the change is
// at once, as it used to be between presets. Nothing new is compiled for it: a fade is uniforms and the lights, and
// the environment map baked again where the sky has changed enough, as in real time.
//
// The environment map (the sky baked into a PMREM cube for the image-based light, the aerial haze's colour and the
// sea's reflections) is baked again only when the sky has changed enough to show: the sun or the moon 0.75° on, the
// sky's brightness 4%, its night mix, clouds, haze or grey a step; at most every BAKE_GAP s. On the real clock that is
// every 3 minutes or so by day and by moonlight, every 20 s at dusk and dawn (650 to 770 a day); a timelapse caps at
// BAKE_GAP. A bake takes ~0.4 ms of CPU and a few ms of GPU (slopDebug.timeOfDay.benchBake()).
//
// createLiveSky({ lighting, presets }) -> { update(dt), setPreset(id), hour(), state, debug(), benchBake(n) },
// main.js's world.liveSky; main.js gives it the colour grade (attachGrade), the HUD picks the presets through
// setPreset() and says when the city first shows (ready = true: until then the shaders compile with the scene pass's
// target bound, and a bake would land in it, so a preset picked before that is applied without a fade or a frame).
//
// For the other lanes (rain, wetness, lightning, the sea), whether the switch is on or off:
//   cityUniforms.uDaylight   0 (night) .. 1 (a clear day), the weather's gloom included (TSL uniform)
//   cityUniforms.uSkySunDir  the direction towards the shadow-casting light: the sun by day, the moon (or the night
//                            sky's glow) by night, never under the horizon (TSL uniform)
//   world.liveSky.state      the same as numbers, with the real sun's and moon's directions (below the horizon too),
//                            the moonlight and the eased sky weather: see `state` below
// The tide, the waves and the precipitation themselves are the sea's and the weather's: this module reads only what
// the sky shows of the weather (cloud, overcast, rain's gloom, visibility).
//
// The streets stay dry: the presets' wet look at dusk and by night (roadWetness 0.55 & 0.62: puddles & damp stains,
// js/donostia/ground.js) is a mood, not the weather, and on a dry evening it laid blotches over the big flat squares.
// Here the time of day's share is held at the dry midday's, so only real rain wets them (js/donostia/weather.js's
// cityUniforms.uRainWetness, on top of it).

const FADE = 2.0; // s: a change of the time of day, from the look on show to the one picked
const EASE = 1.5; // s: the weather's time constant (98% of a change in 6 s)
const BAKE_GAP = 0.15; // s: the least time between two bakes of the environment map
const BAKE_ANGLE = Math.cos(0.75 * Math.PI / 180);

// the sky weather's fields that ease (the visibility in log space, so fog thickens & thins evenly)
const EASED = ['cover', 'coverLow', 'overcast', 'precip', 'fog'];

export function createLiveSky({ lighting, presets }) {
  const dryRoad = presets.midday?.roadWetness ?? 0.08; // the streets' wetness on a dry day (js/lighting.js)
  let grade = null, on = false, fade = 1, fadeFrom = null, current = null;
  // the preset picked last (the one that stands, or stands again when real time goes off), and its look while the
  // fade to it is under way (null: no such fade)
  let presetId = presets[lighting.activePresetId] ? lighting.activePresetId : 'golden', target = null;
  let sky = null, logVis = 0;
  let baked = null, bakedAt = -Infinity, clock = 0;
  const stats = { bakes: 0, bakeMs: 0, lastBakeMs: 0 };
  const sunDir = new THREE.Vector3(), moonDir = new THREE.Vector3(), lightDir = new THREE.Vector3();
  let snap = null;

  // the look's sky against the last baked one: is the environment map due again?
  const skyKey = (l) => ({
    dir: l.skySunDir, exposure: l.skyExposure, night: l.nightFactor, nightSky: l.nightSky, cov: l.cloudCoverage,
    dens: l.cloudDensity, grey: l.skyGrey, turbidity: l.turbidity, rayleigh: l.rayleigh, mie: l.mieCoefficient
  });
  // the relative change, against `floor` at least (the sky's sunlit part fades to nothing at the night's hand-over)
  const rel = (a, b, floor = 1e-6) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor);
  const due = (k) => {
    if (!baked) return true;
    const [x, y, z] = k.dir, [u, v, w] = baked.dir;
    return x * u + y * v + z * w < BAKE_ANGLE || rel(k.exposure, baked.exposure, 0.004) > 0.04 || Math.abs(k.night - baked.night) > 0.015 ||
      Math.abs(k.nightSky - baked.nightSky) > 0.03 || Math.abs(k.cov - baked.cov) > 0.02 || Math.abs(k.dens - baked.dens) > 0.03 ||
      Math.abs(k.grey - baked.grey) > 0.02 || rel(k.turbidity, baked.turbidity) > 0.04 || rel(k.rayleigh, baked.rayleigh) > 0.04 ||
      rel(k.mie, baked.mie) > 0.04;
  };
  const bake = () => {
    const t0 = performance.now();
    lighting.bakeEnvironmentMap();
    stats.lastBakeMs = performance.now() - t0;
    stats.bakeMs += stats.lastBakeMs;
    stats.bakes++;
    bakedAt = clock;
  };
  // A look on show: the lights, the sky and the grade, and the environment map when its sky is due (at most every
  // bakeGap: the quality tier's, so a fade costs a phone no more bakes than real time does)
  const show = (look) => {
    current = look;
    lighting.applyLook(look);
    grade.applyLook(look.grade);
    const key = skyKey(look);
    if (clock - bakedAt >= self.bakeGap && due(key)) {
      bake();
      baked = key;
    }
  };
  // What is on show now, as a look to fade from: the last one shown while real time or a fade runs, else the preset
  // that stands
  const standing = () => current || (presets[presetId] && grade ? presetLook(presets, grade.looks, presetId) : null);
  const reducedMotion = () => { try { return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; } };
  // The preset itself, exactly (its own values and its bake): the end of a fade to it, or the whole change without one
  const land = () => {
    target = fadeFrom = current = null;
    fade = 1;
    lighting.applyPreset(presetId, true);
    grade?.applyPreset(lighting.activePresetId);
    baked = null;
  };

  const self = {
    ready: false,
    // true: the next switch-on shows the live look at once, without the fade from the preset (the HUD sets it when
    // real time is on as the city first shows)
    skipFade: false,
    // the least time between two bakes of the environment map (s): a quality knob (js/donostia/quality.js)
    bakeGap: BAKE_GAP,
    attachGrade(g) { grade = g; },

    // The HUD's pick of a preset (and the preset real time hands back to when it goes off): faded to from what is on
    // show, or at once before the city shows, with { instant: true } and for prefers-reduced-motion. While real time
    // is on the pick only waits: it shows when the switch goes off (update() below)
    setPreset(id, { instant = false } = {}) {
      if (!presets[id]) return;
      const from = standing();
      presetId = id;
      if (on && live.liveEnabled()) return;
      if (instant || !self.ready || !grade || !from || reducedMotion()) { land(); return; }
      // (the environment map on show is the one of the look the fade starts from)
      if (!current) baked = skyKey(from);
      fadeFrom = from;
      target = presetLook(presets, grade.looks, id);
      fade = 0;
    },
    get preset() { return presetId; },
    // 0..1 while a fade runs (to a preset, or into real time), 1 otherwise
    get fade() { return fade; },

    // Every frame (main.js's view.simulate)
    update(dt) {
      clock += dt;
      const enabled = self.ready && grade !== null && live.liveEnabled();
      if (!enabled) {
        // real time went off: back to the preset picked last, faded to from the live look
        if (on) {
          on = false;
          self.setPreset(presetId);
        }
        if (!target) return;
        // a fade to a preset: the blend, then the preset itself
        fade = Math.min(1, fade + dt / FADE);
        if (fade >= 1) land();
        else show(mixLooks(fadeFrom, target, smoothstep(0, 1, fade)));
        return;
      }
      snap = live.liveSnapshot();
      const weather = skyWeather(snap.weather);
      if (!on) {
        // switched on: the weather as it is, the look fading in from what is on show (a preset, or a fade to one
        // caught where it stands)
        on = true;
        sky = { ...weather };
        logVis = Math.log(weather.visibility);
        fadeFrom = standing();
        fade = fadeFrom && !self.skipFade && !reducedMotion() ? 0 : 1;
        self.skipFade = false;
        target = null;
        baked = null;
      } else {
        const k = 1 - Math.exp(-Math.max(0, dt) / EASE);
        for (const f of EASED) sky[f] += (weather[f] - sky[f]) * k;
        logVis += (Math.log(weather.visibility) - logVis) * k;
      }
      sky.visibility = Math.exp(logVis);

      let look = timeOfDay({ sun: snap.sun, moon: snap.moon, sky }, presets, grade.looks);
      if (fade < 1) {
        fade = Math.min(1, fade + dt / FADE);
        const weights = look.weights, night = look.night, moonlight = look.moonlight;
        look = Object.assign(mixLooks(fadeFrom, look, smoothstep(0, 1, fade)), { weights, night, moonlight, sky });
      }
      // (the dry streets are real time's own: a fade from a preset's wet dusk dries them with the rest)
      if (fade >= 1) look.roadWetness = Math.min(look.roadWetness, dryRoad);
      else look.roadWetness = Math.min(look.roadWetness, Math.max(dryRoad, fadeFrom.roadWetness * (1 - smoothstep(0, 1, fade))));
      show(look);
    },

    // The hour of the day the city shows (h): its own with the switch on, else the preset's (the ferries' service)
    hour() {
      if (on) return cityHour(snap ? snap.date : live.liveNow());
      return presets[presetId]?.clock ?? 12;
    },

    // The time of day as numbers, for the other lanes (whether the switch is on or off):
    //   live: the switch is on; daylight: 0..1 (cityUniforms.uDaylight); night: 0..1 (how far the light has turned
    //   from the sun to the night's: 0 by day, 1 after nautical dusk; with the switch off, the midnight preset's 1)
    //   lightDir: THREE.Vector3 towards the shadow-casting light (cityUniforms.uSkySunDir)
    //   sunDir, moonDir: THREE.Vector3 towards the real sun & moon (below the horizon too; the presets' sun, and
    //   straight down, with the switch off); moonlight: 0..1 (the moon's share of a full moon high up)
    //   sky: the eased sky weather { cover, coverLow, overcast, precip, fog, visibility } (calm with the switch off)
    get state() {
      lightDir.copy(lighting.sunLight.position).normalize();
      if (on && snap) {
        sunDir.fromArray(direction(snap.sun.azimuth, snap.sun.elevation));
        moonDir.fromArray(direction(snap.moon.azimuth, snap.moon.elevation));
      } else {
        sunDir.copy(lightDir);
        moonDir.set(0, -1, 0);
      }
      return {
        live: on, daylight: cityUniforms.uDaylight.value, night: on ? current.night : presetId === 'midnight' ? 1 : 0,
        lightDir, sunDir, moonDir, moonlight: on ? current.moonlight : 0,
        sky: on ? { ...sky } : skyWeather(live.CALM_WEATHER)
      };
    },

    // slopDebug.timeOfDay(): the blend as it stands
    debug() {
      if (!on || !current) return { live: false, preset: presetId, fade: +fade.toFixed(3), daylight: cityUniforms.uDaylight.value, bakes: { count: stats.bakes } };
      const r = (v, n = 3) => +v.toFixed(n);
      const w = Object.fromEntries(Object.entries(current.weights).map(([k, v]) => [k, r(v)]));
      return {
        live: true, date: snap.date.toISOString(), hour: r(cityHour(snap.date), 2), status: snap.status,
        sun: { azimuth: r(snap.sun.azimuth, 1), elevation: r(snap.sun.elevation, 2) },
        moon: { azimuth: r(snap.moon.azimuth, 1), elevation: r(snap.moon.elevation, 2), illumination: r(snap.moon.illumination) },
        weights: w, night: r(current.night), moonlight: r(current.moonlight), daylight: r(current.daylight), fade: r(fade),
        light: { azimuth: r(current.lightAzEl.azimuth, 1), elevation: r(current.lightAzEl.elevation, 2), intensity: r(current.sunIntensity) },
        skySun: { azimuth: r(current.skyAzEl.azimuth, 1), elevation: r(current.skyAzEl.elevation, 2), disc: r(current.sunDisc) },
        sky: Object.fromEntries(Object.entries(sky).map(([k, v]) => [k, r(v)])),
        look: {
          skyExposure: r(current.skyExposure, 4), nightFactor: r(current.nightFactor), interiorGlow: r(current.interiorGlow),
          hemiIntensity: r(current.hemiIntensity), envIntensity: r(current.envIntensity), fogDensity: r(current.fogDensity, 6),
          cloudCoverage: r(current.cloudCoverage), skyGrey: r(current.skyGrey), fogGrey: r(current.fogGrey)
        },
        bakes: { count: stats.bakes, lastMs: r(stats.lastBakeMs, 2), meanMs: r(stats.bakes ? stats.bakeMs / stats.bakes : 0, 2) }
      };
    },

    // slopDebug.timeOfDay.benchBake(n): the environment map baked n times, ms per bake: cpuMs (to record and submit),
    // queuedMs (n back to back, then waited for: the GPU's share without the round trip) and waitedMs (each waited for)
    async benchBake(n = 20) {
      const device = lighting.renderer?.backend?.device;
      const ms = (t) => +(t / n).toFixed(2);
      await device?.queue.onSubmittedWorkDone();
      let cpu = 0, t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const c0 = performance.now();
        lighting.bakeEnvironmentMap();
        cpu += performance.now() - c0;
      }
      await device?.queue.onSubmittedWorkDone();
      const queued = performance.now() - t0;
      t0 = performance.now();
      for (let i = 0; i < n; i++) {
        lighting.bakeEnvironmentMap();
        await device?.queue.onSubmittedWorkDone();
      }
      return { bakes: n, cpuMs: ms(cpu), queuedMs: ms(queued), waitedMs: ms(performance.now() - t0) };
    }
  };
  return self;
}
