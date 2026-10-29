// js/donostia/weather-model.js
// The weather's effects as numbers, for js/donostia/weather.js: what falls and how (drizzle, rain, showers, a storm's
// downpour, snow) from live-state.js's weather, the wind as a vector in the local frame with its gusts, how wet the
// streets are (wetting under the rain and drying after it over the minutes of the city's own clock) and when lightning
// strikes, with its thunder's delay. No three.js: the tests run it in Node (tests/donostia-weather.test.mjs).
//
// Sources for the constants: raindrops' terminal speeds (Gunn & Kinzer 1949: 0.2 mm drizzle ~0.7 m/s, 0.5 mm ~2 m/s,
// 1 mm ~4 m/s, 2 mm ~6.5 m/s, 3 mm and more ~8-9 m/s; snowflakes ~1 m/s); the speed of sound in air at 15 °C, 340 m/s
// (thunder's delay, ~3 s per km); a thunderstorm's flash rate seen from the ground, a few a minute, each flash one to
// four return strokes some 40-100 ms apart (Rakov & Uman, "Lightning: Physics and Effects", 2003, ch. 1 & 4).

export const SOUND_SPEED = 340; // m/s

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const RAD = Math.PI / 180;

// --- the wind ------------------------------------------------------------------------------------------------------------

/**
 * The wind of a live-state weather in the local frame (x east, z south): { x, z } the unit vector it blows TOWARDS (the
 * weather gives where it comes FROM, clockwise from north), its mean speed and its gusts (m/s, 10 m above the ground).
 */
export function windVector(weather) {
  const from = (weather?.windFrom ?? 0) * RAD;
  const speed = Math.max(0, weather?.windSpeed ?? 0);
  return { x: -Math.sin(from), z: Math.cos(from), speed, gust: Math.max(speed, weather?.windGust ?? speed) };
}

// a small integer hash -> [0, 1) (Thomas Wang's mix)
function hash01(n) {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * How far into a gust the wind is at `t` seconds, 0 (the mean wind) .. 1 (the reported gust): a smooth random series,
 * a new value every 3.5 s on average, squared so the gusts come in pulses over a steadier wind.
 */
export function gustFactor(t, seed = 0) {
  const s = t / 3.5, i = Math.floor(s), f = s - i, u = f * f * (3 - 2 * f);
  const a = hash01(i * 7919 + seed), b = hash01((i + 1) * 7919 + seed);
  const v = a + (b - a) * u;
  return v * v;
}

// --- what falls ------------------------------------------------------------------------------------------------------------

// Per kind: the drops' fall speed (m/s), the streak's length (m, the eye's ~1/30 s at that speed, a little shorter),
// the drop's width (m), how opaque one reads, and the kind of particle (rain: streaks; snow: flakes)
const FALL = {
  drizzle: { fall: 2.2, length: 0.1, width: 0.0008, alpha: 0.8, particle: 'rain' },
  rain: { fall: 6.5, length: 0.24, width: 0.0014, alpha: 0.5, particle: 'rain' },
  showers: { fall: 7.6, length: 0.3, width: 0.0018, alpha: 0.55, particle: 'rain' },
  storm: { fall: 8.6, length: 0.36, width: 0.002, alpha: 0.6, particle: 'rain' },
  snow: { fall: 1.05, length: 0.022, width: 0.022, alpha: 0.9, particle: 'snow' }
};
const NONE = Object.freeze({ kind: 'none', particle: 'none', density: 0, fall: 0, length: 0, width: 0, alpha: 0, rate: 0 });

/**
 * What falls from a live-state weather: { kind (drizzle | rain | showers | storm | snow | none), particle (rain | snow |
 * none), density 0..1 (the share of the particles drawn), fall (m/s), length & width (m), alpha, rate (mm/h of water;
 * snow: its melt water) }. The rate drives the density where Open-Meteo gives one; the WMO code's intensity stands in
 * where it says rain but its 15-minute sum is still empty. A cloudy or overcast sky with a measured rate rains lightly.
 */
export function precipitation(weather) {
  if (!weather) return NONE;
  let kind = weather.kind;
  const intensity = clamp01(weather.intensity ?? 0);
  const snowfall = Math.max(0, weather.snowfall ?? 0); // cm/h
  let rate = Math.max(0, weather.precipitation ?? 0); // mm/h
  if (!FALL[kind]) {
    if (rate < 0.1) return NONE;
    kind = snowfall > rate * 0.5 ? 'snow' : rate < 0.5 ? 'drizzle' : 'rain';
  }
  const f = FALL[kind];
  let density;
  if (kind === 'snow') {
    rate = Math.max(rate, snowfall * 1.0); // ~1 mm of water per cm of fresh snow
    density = Math.max(1 - Math.exp(-snowfall / 1.2), intensity * 0.85);
  } else if (kind === 'drizzle') {
    density = Math.max(1 - Math.exp(-rate / 0.4), intensity);
  } else {
    density = Math.max(1 - Math.exp(-rate / 4), intensity * 0.85);
  }
  return { kind, particle: f.particle, density: clamp01(density), fall: f.fall, length: f.length, width: f.width, alpha: f.alpha, rate };
}

// --- wetness ---------------------------------------------------------------------------------------------------------------

/**
 * How wet the streets get under a weather, 0 (dry) .. 1 (standing water everywhere it pools): drizzle wets them to a
 * film, steady rain to puddles, a downpour floods them; falling snow melts on the warm paving; fog only dampens.
 */
export function wetnessTarget(weather) {
  const p = precipitation(weather);
  if (p.kind === 'none') return weather?.kind === 'fog' ? 0.14 : 0;
  if (p.kind === 'snow') return 0.3 + 0.35 * (1 - Math.exp(-p.rate / 1.5));
  // (a rain code whose 15-minute sum is still empty wets by its density; drizzle's fine drops by their rate)
  return 0.3 + 0.6 * (1 - Math.exp(-Math.max(p.rate, p.density * (p.kind === 'drizzle' ? 1 : 4)) / 3));
}

/**
 * The wetness after `minutes` of the city's time under `weather`: towards wetnessTarget, wetting in a few minutes
 * under rain (faster the harder it falls) and drying over an hour or so after it (faster in sunshine and wind).
 * daylight: 0 (night) .. 1 (the sun well up).
 */
export function stepWetness(w, weather, minutes, daylight = 0) {
  if (!(minutes > 0)) return w;
  const target = wetnessTarget(weather);
  let tau;
  if (target > w) {
    const rate = Math.max(precipitation(weather).rate, 0.05);
    tau = Math.min(20, Math.max(2, 12 / (0.5 + rate)));
  } else {
    const sun = clamp01(daylight) * (1 - 0.8 * clamp01(weather?.cloudCover ?? 0));
    tau = 70 / (1 + 0.06 * Math.max(0, weather?.windSpeed ?? 0) + 1.2 * sun);
  }
  return target + (w - target) * Math.exp(-minutes / tau);
}

// --- lightning -------------------------------------------------------------------------------------------------------------

/** Flashes a minute a weather brings (a thunderstorm only: 2 to 6). */
export function strikeRate(weather) {
  return weather?.kind === 'storm' ? 2 + 4 * clamp01(weather.intensity ?? 0.8) : 0;
}

// mulberry32: a small seeded generator, so a seed gives the same storm
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A storm's lightning: update(now, rate) (seconds; flashes a minute) starts strikes at random (Poisson) intervals and
 * returns the one it started, if any: { at, distance (m), bearing (deg clockwise from north), strokes: [s after at],
 * brightness 0..1, bolt (a visible channel to the ground), thunder (s after at, distance / SOUND_SPEED) }.
 * flash(now) is the light of the strokes at that moment, 0 .. ~1: each stroke a sharp rise and a ~70 ms decay over a
 * dimmer glow of the cloud lit from within. strike(now, options) starts one at once (a debug hook).
 */
export class Lightning {
  constructor(seed = 1) {
    this.random = rng(seed);
    this.next = null;
    this.current = null;
  }

  strike(now, { distance, bearing, bolt } = {}) {
    const r = this.random;
    const d = distance ?? 1500 * Math.exp(r() * Math.log(12)); // 1.5 .. 18 km, log-uniform
    const strokes = [0];
    const n = 1 + Math.floor(r() * r() * 4);
    for (let k = 1; k < n; k++) strokes.push(strokes[k - 1] + 0.04 + r() * 0.08);
    this.current = {
      at: now, distance: d, bearing: bearing ?? r() * 360, strokes,
      brightness: Math.min(1, 1.6 / (1 + d / 2500)),
      bolt: bolt ?? (d < 9000 && r() < 0.7), thunder: d / SOUND_SPEED
    };
    return this.current;
  }

  update(now, rate) {
    if (!(rate > 0)) {
      this.next = null;
      return null;
    }
    const mean = 60 / rate;
    if (this.next === null || this.next > now + mean * 4) this.next = now + mean * (0.3 + this.random());
    if (now < this.next) return null;
    this.next = now + Math.max(2.5, -Math.log(1 - this.random()) * mean);
    return this.strike(now);
  }

  flash(now) {
    const s = this.current;
    if (!s) return 0;
    const t = now - s.at;
    const last = s.strokes[s.strokes.length - 1];
    if (t < 0 || t > last + 1.2) return 0;
    let v = 0;
    for (const t0 of s.strokes) {
      const u = t - t0;
      if (u >= 0) v = Math.max(v, Math.min(1, u / 0.008) * Math.exp(-u / 0.07));
    }
    // the cloud keeps glowing a little between and after the strokes
    const glow = 0.18 * Math.exp(-Math.max(0, t - last) / 0.25) * Math.min(1, t / 0.02);
    return s.brightness * Math.min(1, v + glow);
  }
}
