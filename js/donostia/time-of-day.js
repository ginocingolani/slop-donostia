// js/donostia/time-of-day.js
// The real-time switch's continuous time of day: the four looks of js/lighting.js (presets.js's Gaua, Ordu urdina,
// Ilunabarra, Eguerdia) become keyframes on the real sun's elevation, and every parameter the presets set is blended
// between them, so the city's light follows its clock without a step; the moon lights the night after its place and
// phase, and the weather (cloud, overcast, rain, visibility) acts on the blend. No three.js here: the tests run it in
// Node, js/donostia/live-sky.js applies what it returns.
//
// The anchors are the presets themselves, each reproduced exactly where the real sun stands at its keyframe:
//   Gaua (midnight)        sun at -12° or lower (nautical dusk): the preset's moonlit night, darker with less moon
//   Ordu urdina (twilight) sun at -3° (the blue hour's start: the lamps are on, the glow of the sun just set)
//   Ilunabarra (golden)    sun at 11° (the preset's own sun: 20:30 in mid-June)
//   Eguerdia (midday)      sun at 25° or higher (winter's noon at 43.3° N reaches 23°)
// and blended with a smoothstep between neighbours. The light and the sky's sun come from the real sun, kept above the
// horizon as the presets keep it (the twilight look is a sun hanging 5° up: the real one sets and the sky keeps its
// glow), and hand over to the moon (or, without one, the preset's night sky) as the sun goes from -4° to -11°: the
// direct light and the sky's sunlit part fade out and come back from the night's side, never sweeping across the sky.
//
// Directions: azimuth clockwise from north, elevation above the horizon, in degrees; vectors in the local frame
// (x east, y up, z south). Colours: the presets' sRGB hex, blended linear ([r, g, b], as three's working space).

const RAD = Math.PI / 180;

/** The keyframes: [preset id, the real sun's elevation (deg) where that preset shows exactly]. */
export const ANCHORS = [['midnight', -12], ['twilight', -3], ['golden', 11], ['midday', 25]];

const NUMBERS = ['sunIntensity', 'hemiIntensity', 'fogDensity', 'interiorGlow', 'roadWetness', 'envIntensity',
  'canyonBounce', 'turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG', 'cloudCoverage', 'cloudDensity',
  'skyExposure', 'nightFactor', 'daylight', 'nightSky'];
const COLORS = ['sunColor', 'hemiSky', 'hemiGround', 'skyTop', 'skyHorizon', 'fogColor'];
const GRADE = ['exposure', 'contrast', 'saturation', 'bloom', 'threshold'];
// How much daylight each look stands for (0 night .. 1 day; cityUniforms.uDaylight): presets.js's `daylight`, these
// for presets without one
export const DAYLIGHT = { midday: 1, golden: 0.72, twilight: 0.3, midnight: 0.05 };

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** An sRGB hex colour as linear [r, g, b] (three's SRGBToLinear). */
export function srgbToLinear(hex) {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((c) => {
    c /= 255;
    return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
  });
}

/** The keyframes' weights { midnight, twilight, golden, midday } (sum 1) for the real sun at `elevation` (deg). */
export function anchorWeights(elevation) {
  const w = { midnight: 0, twilight: 0, golden: 0, midday: 0 };
  if (elevation <= ANCHORS[0][1]) { w[ANCHORS[0][0]] = 1; return w; }
  for (let i = 1; i < ANCHORS.length; i++) {
    const [id, h] = ANCHORS[i], [prev, h0] = ANCHORS[i - 1];
    if (elevation <= h) {
      const t = smoothstep(h0, h, elevation);
      w[prev] = 1 - t;
      w[id] = t;
      return w;
    }
  }
  w[ANCHORS[ANCHORS.length - 1][0]] = 1;
  return w;
}

// --- directions ----------------------------------------------------------------------------------------------------------

/** A direction (azimuth, elevation in deg) as a unit vector [x, y, z] in the local frame (presets.js's sun()). */
export function direction(azimuth, elevation) {
  const a = azimuth * RAD, e = elevation * RAD;
  return [Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)];
}

/** A vector {x, y, z} (or [x, y, z]) as { azimuth, elevation } (deg). */
export function azEl(v) {
  const [x, y, z] = Array.isArray(v) ? v : [v.x, v.y, v.z];
  const l = Math.hypot(x, y, z) || 1;
  return { azimuth: ((Math.atan2(x, -z) / RAD) % 360 + 360) % 360, elevation: Math.asin(y / l) / RAD };
}

// between two directions by azimuth (the shorter way round) and elevation: never through the zenith or a zero vector
function mixAzEl(a, b, t) {
  const d = ((b.azimuth - a.azimuth + 540) % 360) - 180;
  return { azimuth: (a.azimuth + d * t + 360) % 360, elevation: lerp(a.elevation, b.elevation, t) };
}

/**
 * The sun's elevation as the light & the sky show it: the real one from 11° up (the golden keyframe); below, it eases
 * down to hang at 5° from the twilight keyframe on (as the twilight preset's), so the sky keeps the glow of the sun
 * just set. A cubic with the real sun's slope at 11° and level at the twilight keyframe.
 */
const TWILIGHT = ANCHORS[1][1], SPAN = 11 - TWILIGHT;
export function liftedSun(elevation) {
  if (elevation >= 11) return elevation;
  const t = clamp01((elevation - TWILIGHT) / SPAN), m = SPAN / 6;
  return 5 + 6 * ((3 - m) * t * t + (m - 2) * t * t * t);
}

// the moon's light comes from at least ~10° up (a grazing light would stretch the shadows over the whole city)
const liftedMoon = (elevation) => 10 + 3 * Math.log1p(Math.exp((elevation - 10) / 3));

// --- the moon ------------------------------------------------------------------------------------------------------------

/**
 * How much the moon lights the night, 0 (new, or under the horizon) .. 1 (full and high: the midnight preset's
 * moonlit night). A half moon gives a third of a full one's light, and the moon brightens as it climbs out of the
 * horizon's haze.
 */
export function moonlight(moon) {
  return Math.pow(clamp01(moon.illumination), 1.6) * smoothstep(-1, 20, moon.elevation);
}

// The night anchor for the moon: the midnight preset at full moonlight; with none, a darker night lit by the city's
// own glow and the stars (a third of the light, the sky's radiance and colour down by a third, its fill a little)
function nightLook(p, ml) {
  const dark = 1 - ml;
  return {
    ...p,
    sunIntensity: p.sunIntensity * (1 - 0.65 * dark),
    hemiIntensity: p.hemiIntensity * (1 - 0.15 * dark),
    skyExposure: p.skyExposure * (1 - 0.4 * dark),
    envIntensity: p.envIntensity * (1 - 0.15 * dark),
    nightSky: p.nightSky * (1 - 0.3 * dark),
    daylight: p.daylight * (1 - 0.5 * dark)
  };
}

// --- the weather ---------------------------------------------------------------------------------------------------------

// how much each weather darkens the sky (by its intensity)
const PRECIP = { drizzle: 0.35, rain: 0.6, showers: 0.5, snow: 0.4, storm: 0.9 };

/**
 * The weather as the sky sees it: { cover, coverLow (0..1), overcast (0..1: how grey and diffuse the daylight is),
 * precip (0..1: rain, snow or storm darkening the sky), fog (0..1: visibility under ~3 km), visibility (m) }.
 */
export function skyWeather(w) {
  const cover = clamp01(w.cloudCover ?? 0.2), coverLow = clamp01(w.cloudCoverLow ?? 0.1);
  const visibility = Math.max(50, w.visibility ?? 30000);
  const precip = (PRECIP[w.kind] ?? 0) * (0.5 + 0.5 * clamp01(w.intensity ?? 0));
  return {
    cover, coverLow, visibility, precip,
    overcast: smoothstep(0.55, 0.95, cover) * (0.55 + 0.45 * coverLow),
    fog: smoothstep(3000, 600, visibility)
  };
}

// a grey of the colour's own luminance, a touch cool (the light under a cloud deck)
function grey(c, k) {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [lerp(c[0], y * 0.96, k), lerp(c[1], y * 1.0, k), lerp(c[2], y * 1.07, k)];
}

/**
 * The weather on a look (in place): the sky's clouds follow the cloud cover (the calm defaults, 20% with 10% low,
 * keep the look's own), an overcast dims and cools the direct light and lifts the sky's fill, rain and storms darken
 * and grey the sky, and the visibility sets the haze (30 km keeps the look's own, 40 km is clearer, 400 m is fog).
 */
export function applyWeather(look, sw) {
  const { cover, coverLow, overcast: o, precip: r, fog: f, visibility: V } = sw;
  // a diffuse sky (cloud deck or fog) and a dark one (and the night's share of the look, for the city's skyglow)
  const dull = Math.max(o, f), gloom = Math.max(o, r, f), night = clamp01(look.nightFactor / 0.86);
  look.cloudCoverage = cover <= 0.2 ? look.cloudCoverage * (cover / 0.2) : lerp(look.cloudCoverage, 0.95, (cover - 0.2) / 0.8);
  look.cloudDensity = lerp(look.cloudDensity, 0.9, smoothstep(0.1, 1, coverLow));
  look.sunIntensity *= (1 - 0.82 * o) * (1 - 0.6 * r) * (1 - 0.7 * f);
  look.sunColor = grey(look.sunColor, 0.6 * dull);
  // by day the cloud deck fills the shadows; at night it hides the moon and the stars but gives back the city's glow
  look.hemiIntensity *= (1 + 0.4 * o * (1 - night)) * (1 - 0.45 * r * (1 - 0.5 * night));
  look.envIntensity *= 1 - 0.35 * r;
  look.hemiSky = grey(look.hemiSky, 0.55 * gloom);
  look.hemiGround = grey(look.hemiGround, 0.35 * gloom);
  look.skyExposure *= (1 - 0.4 * o) * (1 - 0.5 * r);
  look.nightSky *= 1 + 0.7 * o * night;
  // the sun's glow spreads and fades behind a deck or in fog: less Mie scattering, less forward
  look.mieCoefficient *= 1 - 0.75 * dull;
  look.mieDirectionalG = lerp(look.mieDirectionalG, 0.6, dull);
  look.canyonBounce *= 1 - 0.5 * dull;
  look.skyGrey = Math.max(0.75 * o, 0.9 * r, 0.9 * f);
  look.fogGrey = Math.max(0.5 * o, 0.8 * r, 0.95 * f);
  // FogExp2-like haze, squared optical depth (lighting.js): 98% gone at the visibility takes a density of ~2/V
  look.fogDensity = Math.max(look.fogDensity * Math.pow(30000 / V, 0.6), 2.3 / V);
  look.fogHeight = lerp(900, 320, f);
  look.skyTop = grey(look.skyTop, look.skyGrey);
  look.skyHorizon = grey(look.skyHorizon, look.skyGrey);
  look.fogColor = grey(look.fogColor, look.fogGrey);
  // the city's lights come on a little earlier under a dark sky
  look.interiorGlow = Math.min(1.55, look.interiorGlow + 0.25 * Math.max(0.6 * o, r) * look.daylight);
  look.daylight *= (1 - 0.45 * o) * (1 - 0.35 * r) * (1 - 0.3 * f);
  look.grade.saturation *= 1 - 0.1 * o - 0.12 * r - 0.1 * f;
  look.grade.exposure *= 1 - 0.1 * r;
  look.grade.contrast = lerp(look.grade.contrast, 1.02, 0.5 * Math.max(o, f));
  return look;
}

// --- the blend -----------------------------------------------------------------------------------------------------------

/**
 * Blends the presets' fields (and the colour grade's looks: Donostia's are js/donostia/presets.js's DONOSTIA_CAMERA) by `weights`. Returns the
 * look: the presets' numbers, colours as linear [r, g, b], grade { exposure, contrast, saturation, balance, bloom,
 * threshold }, and the live-only knobs at their neutral values (skyGrey, fogGrey 0, fogHeight 900, nightSky 1).
 */
export function blendLooks(presets, looks, weights) {
  const look = { skyGrey: 0, fogGrey: 0, fogHeight: 900 };
  for (const k of NUMBERS) look[k] = 0;
  for (const k of COLORS) look[k] = [0, 0, 0];
  const grade = { balance: [0, 0, 0] };
  for (const k of GRADE) grade[k] = 0;
  for (const [id, w] of Object.entries(weights)) {
    if (!w) continue;
    const p = presets[id], g = looks[id];
    for (const k of NUMBERS) look[k] += w * (p[k] ?? (k === 'daylight' ? DAYLIGHT[id] : 1));
    for (const k of COLORS) {
      const c = Array.isArray(p[k]) ? p[k] : srgbToLinear(p[k]);
      for (let i = 0; i < 3; i++) look[k][i] += w * c[i];
    }
    for (const k of GRADE) grade[k] += w * g[k];
    for (let i = 0; i < 3; i++) grade.balance[i] += w * g.balance[i];
  }
  look.grade = grade;
  return look;
}

/** Linear interpolation between two looks (blendLooks' shape), for the switch's fade-in. */
export function mixLooks(a, b, t) {
  const out = { grade: { balance: [] } };
  for (const k of Object.keys(b)) {
    if (k === 'grade') continue;
    if (Array.isArray(b[k])) out[k] = b[k].map((v, i) => lerp(a[k][i], v, t));
    else if (typeof b[k] === 'number') out[k] = lerp(a[k] ?? b[k], b[k], t);
    else out[k] = b[k];
  }
  for (const k of Object.keys(b.grade)) {
    out.grade[k] = k === 'balance' ? b.grade.balance.map((v, i) => lerp(a.grade.balance[i], v, t)) : lerp(a.grade[k], b.grade[k], t);
  }
  out.lightAzEl = mixAzEl(a.lightAzEl, b.lightAzEl, t);
  out.skyAzEl = mixAzEl(a.skyAzEl, b.skyAzEl, t);
  out.lightDir = direction(out.lightAzEl.azimuth, out.lightAzEl.elevation);
  out.skySunDir = direction(out.skyAzEl.azimuth, out.skyAzEl.elevation);
  return out;
}

/** A preset as a look (blendLooks' shape, its own sun for the light & the sky), the fade-in's start. */
export function presetLook(presets, looks, id) {
  const look = blendLooks(presets, looks, { [id]: 1 });
  const d = presets[id].sunDir;
  look.lightAzEl = look.skyAzEl = azEl(d);
  look.lightDir = look.skySunDir = [d.x, d.y, d.z];
  look.sunDisc = 1;
  return look;
}

/**
 * The time of day for a live snapshot's { sun, moon, weather } (or, for weather, its skyWeather() as `sky`, e.g.
 * eased): the presets (js/lighting.js's shape, with sunDir) and the grade's looks by id. Returns the look (blendLooks'
 * fields after the moon and the weather) with:
 *   lightDir, skySunDir: [x, y, z] (the shadow-casting light's direction, the sky's sun; lightAzEl, skyAzEl as az/el)
 *   sunDisc: 0..1 (the sky's sun disc: the sun's while it is up, then the moon's, by its phase)
 *   weights: the keyframes' { midnight, twilight, golden, midday }; moonlight: 0..1; night: 0..1 (how far the light
 *   and the sky have turned from the sun to the night's); sky: skyWeather()
 */
export function timeOfDay({ sun, moon, weather, sky = skyWeather(weather) }, presets, looks) {
  const weights = anchorWeights(sun.elevation);
  const ml = moonlight(moon);
  const anchors = { ...presets, midnight: nightLook({ nightSky: 1, daylight: DAYLIGHT.midnight, ...presets.midnight }, ml) };
  const look = blendLooks(anchors, looks, weights);
  applyWeather(look, sky);

  // by day the sun (lifted); by night the moon where it stands, or the preset's night sky while it is down
  const daySun = { azimuth: sun.azimuth, elevation: liftedSun(sun.elevation) };
  const presetNight = azEl(presets.midnight.sunDir);
  // (a moon up, from a thin crescent on: a new moon gives no light to come from)
  const moonUp = smoothstep(-6, 0.3, moon.elevation) * smoothstep(0.005, 0.03, moon.illumination);
  const nightSky = mixAzEl(presetNight, { azimuth: moon.azimuth, elevation: Math.max(moon.elevation, 0.3) }, moonUp);
  const nightLight = mixAzEl(presetNight, { azimuth: moon.azimuth, elevation: liftedMoon(moon.elevation) }, moonUp);
  // The hand-over (35 minutes in June): one sun for the sky and one light, so rather than sweep them across the sky
  // (a glow climbing after sunset, shadows wheeling round) the direct light and the sky's sunlit part fade to nothing
  // halfway, where they change sides unseen, and come back from the night's (between the keyframes: they stand)
  const night = smoothstep(-4, -11, sun.elevation);
  const turned = night >= 0.5, handover = (2 * night - 1) ** 2;
  look.skyAzEl = turned ? nightSky : daySun;
  look.lightAzEl = turned ? nightLight : daySun;
  look.sunIntensity *= handover;
  look.skyExposure *= handover;
  look.skySunDir = direction(look.skyAzEl.azimuth, look.skyAzEl.elevation);
  look.lightDir = direction(look.lightAzEl.azimuth, look.lightAzEl.elevation);
  // the sun's disc sets with the real sun; the moon's shows once the light has turned to it, as bright as its phase
  const moonDisc = smoothstep(0, 2.5, moon.elevation) * smoothstep(0.03, 0.3, moon.illumination) * (0.3 + 0.7 * moon.illumination);
  const clouds = 1 - 0.9 * Math.max(sky.overcast, sky.fog);
  look.sunDisc = ((1 - night) * smoothstep(-0.8, 1.2, sun.elevation) + smoothstep(0.9, 1, night) * moonDisc) * clouds;
  return Object.assign(look, { weights, moonlight: ml, night, sky });
}

// --- the city's clock ----------------------------------------------------------------------------------------------------

// Europe/Madrid's offset from UTC (ms) at a moment, read once per UTC hour through Intl (CET/CEST)
let tzFormat = null, tzHour = NaN, tzOffset = 0;
function madridOffset(date) {
  const hour = Math.floor(date.getTime() / 3600000);
  if (hour !== tzHour) {
    tzFormat ??= new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Madrid', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric'
    });
    const p = Object.fromEntries(tzFormat.formatToParts(date).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute);
    tzOffset = Math.round((asUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000) * 60000;
    tzHour = hour;
  }
  return tzOffset;
}

/** The hour of the day in Donostia (Europe/Madrid) at `date`, as a fraction (20.5 = 20:30). */
export function cityHour(date) {
  const local = date.getTime() + madridOffset(date);
  return (((local / 3600000) % 24) + 24) % 24;
}
