import * as THREE from 'three/webgpu';
import * as live from './live-state.js';
import { timeOfDay, skyWeather, mixLooks, presetLook, smoothstep, cityHour, direction } from './time-of-day.js';
import { cityUniforms } from '../city-uniforms.js';

// js/donostia/live-sky.js
// The sky of the HUD's real-time switch: while it is on, every frame takes the live state (js/donostia/live-state.js)
// through js/donostia/time-of-day.js's blend of the presets and hands the look to the lighting (js/lighting.js's
// applyLook) and the colour grade; off, it does nothing and the presets stand as they always have (the HUD applies
// them). The weather eases over a few seconds (it arrives in 15-minute steps), the switch fades in over two, and the
// sun and the moon move with the clock (or a debug override's, a timelapse included) every frame.
//
// The environment map (the sky baked into a PMREM cube for the image-based light, the aerial haze's colour and the
// sea's reflections) is baked again only when the sky has changed enough to show: the sun or the moon 0.75° on, the
// sky's brightness 4%, its night mix, clouds, haze or grey a step; at most every BAKE_GAP s. On the real clock that is
// every 3 minutes or so by day and by moonlight, every 20 s at dusk and dawn (650 to 770 a day); a timelapse caps at
// BAKE_GAP. A bake takes ~0.4 ms of CPU and a few ms of GPU (slopDebug.timeOfDay.benchBake()).
//
// createLiveSky({ lighting, presets }) -> { update(dt), hour(), state, debug(), benchBake(n) }, main.js's
// world.liveSky; main.js gives it the colour grade (attachGrade), and the HUD says when the city first shows (ready =
// true: until then the shaders compile with the scene pass's target bound, and a bake would land in it).
//
// For the other lanes (rain, wetness, lightning, the sea), whether the switch is on or off:
//   cityUniforms.uDaylight   0 (night) .. 1 (a clear day), the weather's gloom included (TSL uniform)
//   cityUniforms.uSkySunDir  the direction towards the shadow-casting light: the sun by day, the moon (or the night
//                            sky's glow) by night, never under the horizon (TSL uniform)
//   world.liveSky.state      the same as numbers, with the real sun's and moon's directions (below the horizon too),
//                            the moonlight and the eased sky weather: see `state` below
// The tide, the waves and the precipitation themselves are the sea's and the weather's: this module reads only what
// the sky shows of the weather (cloud, overcast, rain's gloom, visibility).

const FADE = 2.0; // s: the switch fading in from the preset
const EASE = 1.5; // s: the weather's time constant (98% of a change in 6 s)
const BAKE_GAP = 0.15; // s: the least time between two bakes of the environment map
const BAKE_ANGLE = Math.cos(0.75 * Math.PI / 180);

// the sky weather's fields that ease (the visibility in log space, so fog thickens & thins evenly)
const EASED = ['cover', 'coverLow', 'overcast', 'precip', 'fog'];

export function createLiveSky({ lighting, presets }) {
  let grade = null, on = false, fade = 1, fadeFrom = null, current = null;
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

  const self = {
    ready: false,
    attachGrade(g) { grade = g; },

    // Every frame (main.js's view.simulate)
    update(dt) {
      clock += dt;
      const enabled = self.ready && grade !== null && live.liveEnabled();
      if (!enabled) {
        on = false;
        return;
      }
      snap = live.liveSnapshot();
      const target = skyWeather(snap.weather);
      if (!on) {
        // switched on: the weather as it is, the look fading in from the preset on show (or the last live look)
        on = true;
        sky = { ...target };
        logVis = Math.log(target.visibility);
        fadeFrom = presets[lighting.activePresetId] ? presetLook(presets, grade.looks, lighting.activePresetId) : current;
        fade = fadeFrom ? 0 : 1;
        baked = null;
      } else {
        const k = 1 - Math.exp(-Math.max(0, dt) / EASE);
        for (const f of EASED) sky[f] += (target[f] - sky[f]) * k;
        logVis += (Math.log(target.visibility) - logVis) * k;
      }
      sky.visibility = Math.exp(logVis);

      let look = timeOfDay({ sun: snap.sun, moon: snap.moon, sky }, presets, grade.looks);
      if (fade < 1) {
        fade = Math.min(1, fade + dt / FADE);
        const weights = look.weights, night = look.night, moonlight = look.moonlight;
        look = Object.assign(mixLooks(fadeFrom, look, smoothstep(0, 1, fade)), { weights, night, moonlight, sky });
      }
      current = look;
      lighting.applyLook(look);
      grade.applyLook(look.grade);
      const key = skyKey(look);
      if (clock - bakedAt >= BAKE_GAP && due(key)) {
        bake();
        baked = key;
      }
    },

    // The hour of the day the city shows (h): its own with the switch on, else the preset's (the ferries' service)
    hour() {
      if (on) return cityHour(snap ? snap.date : live.liveNow());
      return presets[lighting.activePresetId]?.clock ?? 12;
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
        live: on, daylight: cityUniforms.uDaylight.value, night: on ? current.night : lighting.activePresetId === 'midnight' ? 1 : 0,
        lightDir, sunDir, moonDir, moonlight: on ? current.moonlight : 0,
        sky: on ? { ...sky } : skyWeather(live.CALM_WEATHER)
      };
    },

    // slopDebug.timeOfDay(): the blend as it stands
    debug() {
      if (!on || !current) return { live: false, preset: lighting.activePresetId, daylight: cityUniforms.uDaylight.value };
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
