// js/donostia/live-state.js
// The city as it is now, for the HUD's real-time switch: the sun and the moon where they stand over Donostia at this
// moment, the weather and the sea from Open-Meteo, refreshed every quarter of an hour, and the tide read off its hourly
// curve at any instant. What the lighting, the weather effects and the sea do with it is theirs; this module only keeps
// the state, in one shape whatever the source, and lets a debug override replace any part of it (a time, a rate, a
// weather, a sea state) so every case can be rendered on demand. No three.js here: the tests run it in Node.
//
// Sources:
//   - Weather: Open-Meteo's forecast API, `current` (the 15-minute model state over the city; WMO weather codes):
//     https://open-meteo.com/en/docs. Data by Open-Meteo.com, CC BY 4.0 (free API for non-commercial use).
//   - Sea: Open-Meteo's marine API: waves and swell (`current`) and `sea_level_height_msl` (`hourly`; tides, inverted
//     barometer and ocean-model sea surface height, metres above mean sea level; not for navigation):
//     https://open-meteo.com/en/docs/marine-weather-api. Data by Open-Meteo.com, CC BY 4.0.
//   - The sun's and the moon's places: the low-precision formulas of the Astronomical Almanac (sun, ~0.01°) and of
//     Meeus' "Astronomical Algorithms" ch. 47 truncated to its main terms (moon, ~1°), as in SunCalc; refraction by
//     Bennett's formula.
//
// liveSnapshot() returns { date, sun, moon, weather, sea, status } (see the end of this file for the shapes). The
// weather and the sea come from the last good fetch, or CALM_WEATHER / CALM_SEA until one arrives (status says which),
// with the override's fields on top. The tide is interpolated for the snapshot's own moment, so it may be called every
// frame. Effects should ease towards a new snapshot's values rather than jump: the weather changes in 15-minute steps.

// The city: Alderdi Eder, the local frame's origin (tools/donostia/frame.json: UTM 30N 582000 E, 4797000 N)
export const LAT = 43.3189;
export const LON = -1.9826;
export const TIME_ZONE = 'Europe/Madrid';
export const REFRESH_MS = 15 * 60 * 1000;
export const LIVE_CREDIT = { text: 'Weather & sea data by Open-Meteo.com (CC BY 4.0)', url: 'https://open-meteo.com/' };

const WEATHER_URL = 'https://api.open-meteo.com/v1/forecast?latitude=43.3183&longitude=-1.9812' +
  '&current=temperature_2m,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,cloud_cover_low,' +
  'visibility,wind_speed_10m,wind_direction_10m,wind_gusts_10m&timezone=Europe%2FMadrid';
// the marine model's nearest sea cell to the bay (43.375 N, 1.958 W, 6 km offshore); the tide's curve covers yesterday
// to tomorrow so any moment of today interpolates inside it
const SEA_URL = 'https://marine-api.open-meteo.com/v1/marine?latitude=43.33&longitude=-1.99' +
  '&current=wave_height,wave_direction,wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,' +
  'wind_wave_height,sea_level_height_msl,sea_surface_temperature&hourly=sea_level_height_msl' +
  '&past_days=1&forecast_days=2&timezone=Europe%2FMadrid';

const RAD = Math.PI / 180;
const wrap360 = (a) => ((a % 360) + 360) % 360;

// --- the sun & the moon ------------------------------------------------------------------------------------------------

const daysSinceJ2000 = (date) => date.getTime() / 86400000 + 2440587.5 - 2451545.0;
// right ascension & declination (rad) from ecliptic longitude & latitude (rad) at day n
function equatorial(lambda, beta, n) {
  const e = (23.439 - 0.0000004 * n) * RAD;
  return {
    ra: Math.atan2(Math.sin(lambda) * Math.cos(e) - Math.tan(beta) * Math.sin(e), Math.cos(lambda)),
    dec: Math.asin(Math.sin(beta) * Math.cos(e) + Math.cos(beta) * Math.sin(e) * Math.sin(lambda))
  };
}
// azimuth (deg, clockwise from north) & elevation (deg, refracted) of a body at ra & dec for the city at day n
function horizontal({ ra, dec }, n, lat, lon) {
  const gmst = wrap360(280.46061837 + 360.98564736629 * n);
  const h = (gmst + lon) * RAD - ra, phi = lat * RAD;
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(h)) / RAD;
  const az = Math.atan2(-Math.cos(dec) * Math.sin(h), Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.sin(phi) * Math.cos(h)) / RAD;
  // Bennett: refraction lifts a body near the horizon by up to ~0.6°
  const refr = alt > -1.5 ? 1.02 / Math.tan((alt + 10.3 / (alt + 5.11)) * RAD) / 60 : 0;
  return { azimuth: wrap360(az), elevation: alt + refr };
}
function sunEquatorial(n) {
  const g = wrap360(357.529 + 0.98560028 * n) * RAD;
  const lambda = wrap360(280.459 + 0.98564736 * n + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  return { ...equatorial(lambda, 0, n), distance: 149598000 * (1.00014 - 0.01671 * Math.cos(g)) };
}
function moonEquatorial(n) {
  const L = wrap360(218.316 + 13.176396 * n) * RAD, M = wrap360(134.963 + 13.064993 * n) * RAD;
  const F = wrap360(93.272 + 13.229350 * n) * RAD;
  return { ...equatorial(L + 6.289 * RAD * Math.sin(M), 5.128 * RAD * Math.sin(F), n), distance: 385001 - 20905 * Math.cos(M) };
}

/** The sun over the city at `date`: azimuth (deg, clockwise from north) and elevation (deg above the horizon). */
export function sunPosition(date, lat = LAT, lon = LON) {
  const n = daysSinceJ2000(date);
  return horizontal(sunEquatorial(n), n, lat, lon);
}

/** The moon over the city at `date`, with the lit fraction of its disc (0 new .. 1 full) and whether it waxes. */
export function moonPosition(date, lat = LAT, lon = LON) {
  const n = daysSinceJ2000(date);
  const s = sunEquatorial(n), m = moonEquatorial(n);
  const phi = Math.acos(Math.sin(s.dec) * Math.sin(m.dec) + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra));
  const inc = Math.atan2(s.distance * Math.sin(phi), m.distance - s.distance * Math.cos(phi));
  const waxing = Math.sin(s.ra - m.ra) < 0;
  return { ...horizontal(m, n, lat, lon), illumination: (1 + Math.cos(inc)) / 2, waxing };
}

// --- the weather ---------------------------------------------------------------------------------------------------------

// WMO code -> kind and intensity (0..1); `frozen` for freezing drizzle and rain, `hail` for storms with hail
const WMO = {
  0: ['clear', 0], 1: ['clear', 0], 2: ['cloudy', 0.4], 3: ['overcast', 0.8], 45: ['fog', 0.7], 48: ['fog', 0.9],
  51: ['drizzle', 0.3], 53: ['drizzle', 0.55], 55: ['drizzle', 0.8], 56: ['drizzle', 0.4, 'frozen'], 57: ['drizzle', 0.8, 'frozen'],
  61: ['rain', 0.35], 63: ['rain', 0.65], 65: ['rain', 1], 66: ['rain', 0.4, 'frozen'], 67: ['rain', 0.9, 'frozen'],
  71: ['snow', 0.3], 73: ['snow', 0.6], 75: ['snow', 1], 77: ['snow', 0.25],
  80: ['showers', 0.45], 81: ['showers', 0.75], 82: ['showers', 1], 85: ['snow', 0.5], 86: ['snow', 0.9],
  95: ['storm', 0.8], 96: ['storm', 0.9, 'hail'], 99: ['storm', 1, 'hail']
};

/** A WMO weather code (Open-Meteo's weather_code) as { kind, intensity, frozen, hail }. */
export function weatherKind(code) {
  const [kind, intensity, extra] = WMO[code] ?? ['cloudy', 0.3];
  return { kind, intensity, frozen: extra === 'frozen', hail: extra === 'hail' };
}

/** Clear and still: the weather before the first fetch, or when it fails. */
export const CALM_WEATHER = Object.freeze({
  time: null, code: 1, kind: 'clear', intensity: 0, frozen: false, hail: false, temperature: 17, isDay: null,
  cloudCover: 0.2, cloudCoverLow: 0.1, precipitation: 0, rain: 0, showers: 0, snowfall: 0, visibility: 30000,
  windSpeed: 3, windGust: 5, windFrom: 300
});

/** Open-Meteo's forecast `current` as the weather shape (SI units: m/s, m, mm/h, cm/h; cover 0..1; directions FROM). */
export function weatherFromOpenMeteo(json) {
  const c = json.current;
  // the 15-minute sums, as hourly rates
  const perHour = 3600 / (c.interval || 900);
  return {
    time: localToDate(c.time, json.utc_offset_seconds).toISOString(), code: c.weather_code, ...weatherKind(c.weather_code),
    temperature: c.temperature_2m, isDay: c.is_day == null ? null : !!c.is_day,
    cloudCover: (c.cloud_cover ?? 20) / 100, cloudCoverLow: (c.cloud_cover_low ?? 10) / 100,
    precipitation: (c.precipitation ?? 0) * perHour, rain: (c.rain ?? 0) * perHour, showers: (c.showers ?? 0) * perHour,
    snowfall: (c.snowfall ?? 0) * perHour, visibility: c.visibility ?? 30000,
    windSpeed: (c.wind_speed_10m ?? 0) / 3.6, windGust: (c.wind_gusts_10m ?? 0) / 3.6, windFrom: c.wind_direction_10m ?? 0
  };
}

// --- the sea -------------------------------------------------------------------------------------------------------------

/** Mean sea level and a moderate north-west swell: the sea before the first fetch, or when it fails. */
export const CALM_SEA = Object.freeze({
  time: null, waveHeight: 0.8, wavePeriod: 9, waveFrom: 315, swellHeight: 0.7, swellPeriod: 10, swellFrom: 315,
  windWaveHeight: 0.1, temperature: 17, tide: null
});

/** Open-Meteo's marine response as the sea shape: waves now, and the tide's hourly curve ({ t: ms[], level: m[] }). */
export function seaFromOpenMeteo(json) {
  const c = json.current, h = json.hourly;
  const t = h.time.map((s) => localToDate(s, json.utc_offset_seconds).getTime());
  return {
    time: localToDate(c.time, json.utc_offset_seconds).toISOString(),
    waveHeight: c.wave_height, wavePeriod: c.wave_period, waveFrom: c.wave_direction,
    swellHeight: c.swell_wave_height, swellPeriod: c.swell_wave_period, swellFrom: c.swell_wave_direction,
    windWaveHeight: c.wind_wave_height ?? 0, temperature: c.sea_surface_temperature,
    tide: { t, level: h.sea_level_height_msl.map((v) => (v == null ? NaN : v)) }
  };
}

/**
 * The tide at `date` from an hourly curve: { level (m above mean sea level), rate (m/h, + rising), next: [{ kind:
 * 'high' | 'low', date, level }] (the next two turns) } or null outside the curve. Catmull-Rom between the hours; the
 * turns are refined by a parabola through the three hours around each.
 */
export function tideAt(curve, date) {
  if (!curve || curve.t.length < 4) return null;
  const { t, level: v } = curve, ms = date.getTime();
  if (ms < t[1] || ms >= t[t.length - 2]) return null;
  let i = 1;
  while (t[i + 1] <= ms) i++;
  const dt = t[i + 1] - t[i], u = (ms - t[i]) / dt;
  const p0 = v[i - 1], p1 = v[i], p2 = v[i + 1], p3 = v[i + 2];
  if (![p0, p1, p2, p3].every(Number.isFinite)) return null;
  const a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3, b = p0 - 2.5 * p1 + 2 * p2 - 0.5 * p3, c = -0.5 * p0 + 0.5 * p2;
  const level = ((a * u + b) * u + c) * u + p1;
  const rate = ((3 * a * u + 2 * b) * u + c) / (dt / 3600000);
  const next = [];
  for (let k = i; k < t.length - 1 && next.length < 2; k++) {
    const y0 = v[k - 1], y1 = v[k], y2 = v[k + 1];
    if (!(y1 >= y0 && y1 > y2) && !(y1 <= y0 && y1 < y2)) continue;
    const den = y0 - 2 * y1 + y2, off = den ? (0.5 * (y0 - y2)) / den : 0;
    const when = t[k] + off * (t[k + 1] - t[k]);
    if (when <= ms) continue;
    next.push({ kind: y1 > y2 ? 'high' : 'low', date: new Date(when), level: y1 - 0.25 * (y0 - y2) * off });
  }
  return { level, rate, next };
}

// Open-Meteo's local "YYYY-MM-DDTHH:MM" plus the response's UTC offset, as a Date
function localToDate(s, offsetSeconds = 0) {
  return new Date(Date.parse(`${s}:00Z`) - offsetSeconds * 1000);
}

// --- the store -----------------------------------------------------------------------------------------------------------

const state = { enabled: false, status: 'off', weather: null, sea: null, fetchedAt: null, error: null };
const override = { time: null, rate: 1, since: 0, weather: null, sea: null };
const listeners = new Set();
let timer = null, inFlight = null;
const clockNow = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function notify() {
  const snap = liveSnapshot();
  for (const fn of listeners) {
    try { fn(snap); } catch (e) { console.error('[live]', e); }
  }
}

/** Calls fn(snapshot) whenever the state changes (a fetch, a switch, an override); returns the unsubscribe function. */
export function onLive(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Whether real time is on. */
export function liveEnabled() {
  return state.enabled;
}

/** Turns real time on (fetching now and every REFRESH_MS) or off. */
export function setLiveEnabled(on, fetchImpl) {
  on = !!on;
  if (on === state.enabled) return;
  state.enabled = on;
  clearInterval(timer);
  timer = null;
  if (on) {
    state.status = state.weather ? 'ok' : 'loading';
    refreshLive(fetchImpl);
    timer = setInterval(() => refreshLive(fetchImpl), REFRESH_MS);
  } else state.status = 'off';
  notify();
}

/** Fetches the weather and the sea now; keeps the last good ones when a request fails. Resolves to the snapshot. */
export function refreshLive(fetchImpl = globalThis.fetch) {
  if (inFlight) return inFlight;
  const get = async (url) => {
    const r = await fetchImpl(url);
    if (!r.ok) throw new Error(`${r.status} ${url.split('?')[0]}`);
    return r.json();
  };
  inFlight = Promise.allSettled([get(WEATHER_URL), get(SEA_URL)]).then(([w, s]) => {
    const errors = [];
    if (w.status === 'fulfilled') state.weather = weatherFromOpenMeteo(w.value);
    else errors.push(`weather: ${w.reason?.message || w.reason}`);
    if (s.status === 'fulfilled') state.sea = seaFromOpenMeteo(s.value);
    else errors.push(`sea: ${s.reason?.message || s.reason}`);
    state.fetchedAt = new Date().toISOString();
    state.error = errors.length ? errors.join('; ') : null;
    if (state.enabled) state.status = errors.length === 2 ? 'error' : errors.length ? 'partial' : 'ok';
    inFlight = null;
    notify();
    return liveSnapshot();
  });
  return inFlight;
}

/**
 * Debug: replaces parts of the live state. { time: Date | ISO string | null, rate: n (seconds of city time per real
 * second, from that time), weather: { ...fields } | string (a kind, e.g. 'rain', with a typical intensity) | null,
 * sea: { ...fields, level?: m (the tide, fixed) } | null }. Fields left out keep their value; null clears that part.
 */
export function setLiveOverride(o = {}) {
  if ('time' in o || 'rate' in o) {
    const base = 'time' in o ? o.time : liveNow();
    override.time = base == null ? null : new Date(base);
    override.rate = o.rate ?? (o.time == null ? 1 : override.rate);
    override.since = clockNow();
  }
  if ('weather' in o) override.weather = typeof o.weather === 'string' ? presetWeather(o.weather) : o.weather;
  if ('sea' in o) override.sea = o.sea;
  notify();
}

/** Debug: drops every override. */
export function clearLiveOverride() {
  Object.assign(override, { time: null, rate: 1, since: 0, weather: null, sea: null });
  notify();
}

/** The city's time now: the clock, or the override's time run on at its rate. */
export function liveNow() {
  if (!override.time) return new Date();
  return new Date(override.time.getTime() + ((clockNow() - override.since) / 1000) * override.rate * 1000);
}

// typical weathers by kind, for the debug override and the tests
const PRESET_WEATHER = {
  clear: { code: 0, cloudCover: 0.05, cloudCoverLow: 0, visibility: 40000, windSpeed: 3 },
  cloudy: { code: 2, cloudCover: 0.5, cloudCoverLow: 0.3, visibility: 25000, windSpeed: 5 },
  overcast: { code: 3, cloudCover: 1, cloudCoverLow: 0.8, visibility: 12000, windSpeed: 5 },
  fog: { code: 45, cloudCover: 1, cloudCoverLow: 1, visibility: 400, windSpeed: 1 },
  drizzle: { code: 53, cloudCover: 1, cloudCoverLow: 0.9, visibility: 6000, precipitation: 0.6, rain: 0.6, windSpeed: 4 },
  rain: { code: 63, cloudCover: 1, cloudCoverLow: 1, visibility: 4000, precipitation: 4, rain: 4, windSpeed: 7, windGust: 12 },
  showers: { code: 81, cloudCover: 0.8, cloudCoverLow: 0.6, visibility: 5000, precipitation: 6, showers: 6, windSpeed: 8, windGust: 15 },
  storm: { code: 95, cloudCover: 1, cloudCoverLow: 1, visibility: 3000, precipitation: 12, rain: 12, windSpeed: 12, windGust: 22 },
  snow: { code: 73, cloudCover: 1, cloudCoverLow: 1, visibility: 2000, precipitation: 1.5, snowfall: 1.5, windSpeed: 4, temperature: 0 }
};
function presetWeather(kind) {
  const p = PRESET_WEATHER[kind];
  if (!p) throw new Error(`no preset weather '${kind}' (${Object.keys(PRESET_WEATHER).join(', ')})`);
  return { ...p, ...weatherKind(p.code) };
}

/**
 * The live state at the city's moment:
 *   date: Date (liveNow())
 *   sun, moon: { azimuth, elevation } (deg; moon also illumination 0..1, waxing)
 *   weather: CALM_WEATHER's fields (kind: clear | cloudy | overcast | fog | drizzle | rain | showers | snow | storm)
 *   sea: CALM_SEA's fields, with tide: { level (m above MSL), rate (m/h), next: [{ kind, date, level }] } or, without a
 *     curve, { level: 0, rate: 0, next: [] }; an override's `level` fixes it
 *   status: off | loading | ok | partial | error, error (string | null), fetchedAt (ISO | null), credit (LIVE_CREDIT)
 */
export function liveSnapshot() {
  const date = liveNow();
  const weather = { ...(state.weather ?? CALM_WEATHER), ...(override.weather ?? {}) };
  const base = state.sea ?? CALM_SEA;
  const tide = tideAt(base.tide, date) ?? { level: 0, rate: 0, next: [] };
  const sea = { ...base, ...(override.sea ?? {}), tide };
  if (override.sea && Number.isFinite(override.sea.level)) sea.tide = { level: override.sea.level, rate: 0, next: [] };
  delete sea.level;
  return {
    date, sun: sunPosition(date), moon: moonPosition(date), weather, sea, enabled: state.enabled,
    status: state.status, error: state.error, fetchedAt: state.fetchedAt, credit: LIVE_CREDIT
  };
}
