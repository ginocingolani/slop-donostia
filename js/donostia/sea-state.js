// js/donostia/sea-state.js
// The sea of the real-time mode as the water's parameters: what js/donostia/water.js (and through its uniforms the
// shore, the marina, the boats, the buoys and the ground) does with the tide, the waves, the swell and the wind that
// js/donostia/live-state.js reports. With the switch off the water keeps FIXED_SEA, the sea the shaders were drawn for;
// with it on, seaParams(snapshot) gives the targets the water eases towards. Also the HUD's words for the sea (the
// Douglas scale, the surf on the three beaches) and the levels of the port's floating pontoons. No three.js here: the
// tests run it in Node.
//
// Sources: the Douglas sea scale (WMO Manual on Codes, code table 3700); whitecaps after the Beaufort scale's
// descriptions (WMO-No. 8, Annex 4.B); deep-water dispersion (L = g T² / 2π). The tide's range at Donostia (~4.5 m at
// springs, ~1.5 m at neaps around mean sea level) after Puertos del Estado's tide gauge at Pasaia; the beaches' exposure
// to the swell is data/donostia/water.png's (tools/donostia/build.mjs), read off at their surf zones.

import { MARINA } from './data-marina.js';

const G = 9.81;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Metres above mean sea level: about the lowest astronomical tide on this coast, what the quays' ladders reach under. */
export const LOW_WATER = -2.6;

// The swell the water's surf was drawn for (js/donostia/water.js: ~1 m breakers on Zurriola, a hand's breadth inside La
// Concha): about 1.2 m from the north-west
const NOMINAL_SWELL = 1.2; // m
// The sector the coast is open to (the exposure field's, tools/donostia/build.mjs SWELL: W to NNE, through north)
const OPEN_FROM = 285, OPEN_TO = 25;
// The high water the tidal bands (wet sand, the dark band and the weed on walls & rocks) were drawn for: a spring tide's
const BAND_HIGH_WATER = 1.5; // m
// The beaches' exposure to the swell at their surf zones (data/donostia/water.png's R)
const BEACH_EXPOSURE = { zurriola: 0.6, ondarreta: 0.2, concha: 0.12 };

/**
 * The sea the water shows with the real-time switch off: mean sea level, the bands where they were drawn, the
 * north-west swell of the surf as drawn, a moderate breeze's chop from the texture's own directions (chopFrom null).
 */
export const FIXED_SEA = Object.freeze({
  level: 0, mark: 0,
  surf: 1, surfPeriodA: 7, surfPeriodB: 11, // breaker scale; the breakers' period (s) from the sheltered to the open beaches
  swell: 0, swellPeriod: 10, swellFrom: 315, // the open sea's long swell (m) on top of the wind sea: none
  chop: 1, chopFrom: null, calm: 0, whitecaps: 0, spray: 0
});

/** How far the coast is open to a swell from azimuth `from` (deg): 1 inside the W-NNE sector, fading off 90° outside it. */
export function openTo(from) {
  if (!Number.isFinite(from)) return 1;
  const half = ((((OPEN_TO - OPEN_FROM) % 360) + 360) % 360) / 2, mid = (OPEN_FROM + half) % 360;
  const outside = Math.max(0, Math.abs(wrap180(from - mid)) - half);
  return 1 - 0.85 * smooth(0, 90, outside);
}

/** The swell that reaches the coast: { height (m, its open share), period (s), from (deg) } from the live sea. */
export function effectiveSwell(sea) {
  const height = Number.isFinite(sea.waveHeight) ? sea.waveHeight : sea.swellHeight ?? 0;
  const from = Number.isFinite(sea.swellFrom) && (sea.swellHeight ?? 0) >= 0.5 * height ? sea.swellFrom : sea.waveFrom;
  const period = clamp(Math.max(sea.wavePeriod || 0, sea.swellPeriod || 0) || 9, 4, 20);
  return { height: Math.max(0, height) * openTo(from), period, from: Number.isFinite(from) ? from : 315 };
}

/** The deep-water wavelength (m) of waves of period T (s). */
export const wavelength = (T) => (G * T * T) / (2 * Math.PI);

/**
 * The level the tidal bands are drawn from (m): the last high water less the spring high water they were drawn for,
 * so the wet sand reaches as far up the beach as the sea came, and a neap tide's bands sit lower. tide: the
 * snapshot's { level, next: [{ kind, level }] }; without the curve (an override's fixed level) a spring tide's.
 */
export function bandMark(tide) {
  const high = tide?.next?.find((t) => t.kind === 'high')?.level;
  const recent = Number.isFinite(high) ? Math.max(high, tide.level) : Math.max(BAND_HIGH_WATER, tide?.level ?? 0);
  return recent - BAND_HIGH_WATER;
}

/** The wind sea's energy relative to the fixed sea's (a moderate breeze): glassy in a calm, rough in a gale. */
export function chopEnergy(windSpeed, windWaveHeight = 0) {
  const fromWind = 0.3 + 0.7 * Math.pow(Math.max(0, windSpeed) / 5, 0.9);
  const fromSea = 0.6 + 1.5 * Math.max(0, windWaveHeight);
  return clamp(Math.max(fromWind, windWaveHeight > 0.05 ? fromSea : 0), 0.3, 2.6);
}

/** The share of the open sea whitecaps break on (0..1): from a gentle breeze (scattered) to a near gale (everywhere). */
export function whitecapCover(windSpeed) {
  return Math.pow(clamp((windSpeed - 4.5) / 10, 0, 1), 1.2);
}

/**
 * The water's parameters for a live snapshot ({ sea, weather }): the tide's level and the bands' mark (m); the
 * breakers' scale (relative to the fixed sea's) and period (s); the open sea's swell (m), its period (s) and where it
 * comes from (deg); the wind sea's energy (relative), where it comes from (deg) and the wind's speed (m/s), the bay's
 * calm (0..1: glassy), the whitecaps' cover (0..1) and the spray against the walls (0..1: a big swell's).
 */
export function seaParams({ sea, weather }) {
  const swell = effectiveSwell(sea);
  const windSpeed = weather?.windSpeed ?? 3;
  const T = swell.period;
  return {
    level: sea.tide?.level ?? 0,
    mark: bandMark(sea.tide),
    surf: clamp(swell.height / NOMINAL_SWELL, 0.04, 5),
    surfPeriodA: 0.8 * T, surfPeriodB: T,
    swell: swell.height, swellPeriod: T, swellFrom: swell.from,
    chop: chopEnergy(windSpeed, sea.windWaveHeight ?? 0),
    chopFrom: Number.isFinite(weather?.windFrom) ? weather.windFrom : 300, windSpeed,
    // flat & glassy inside the bay under a small swell and light airs
    calm: smooth(0.7, 0.25, swell.height) * smooth(6, 3, windSpeed),
    whitecaps: whitecapCover(windSpeed),
    spray: smooth(1.8, 3.4, swell.height)
  };
}

// --- the HUD's words ----------------------------------------------------------------------------------------------------

const DOUGLAS = [
  [0, 'calm (glassy)'], [0.1, 'calm (rippled)'], [0.5, 'smooth'], [1.25, 'slight'], [2.5, 'moderate'], [4, 'rough'],
  [6, 'very rough'], [9, 'high'], [14, 'very high'], [Infinity, 'phenomenal']
];
/** The Douglas sea scale for a significant wave height (m): { degree 0..9, name }. */
export function douglas(height) {
  const h = Math.max(0, height || 0);
  const degree = h === 0 ? 0 : DOUGLAS.findIndex(([top]) => h <= top);
  return { degree, name: DOUGLAS[degree][1] };
}

/**
 * The surf on the beaches (the breakers' height, m, as the water draws them): { zurriola, ondarreta, concha }, and the
 * Douglas scale of the open sea. Zurriola, open to the swell, gets the most; Santa Klara and Igeldo shelter the bay's.
 */
export function surfReport(sea) {
  const { surf } = seaParams({ sea, weather: null });
  const at = (e) => Math.round((e * 1.5 + 0.12) * surf * 10) / 10;
  return {
    zurriola: at(BEACH_EXPOSURE.zurriola), ondarreta: at(BEACH_EXPOSURE.ondarreta), concha: at(BEACH_EXPOSURE.concha),
    sea: douglas(sea.waveHeight)
  };
}

// --- the low-water channels ---------------------------------------------------------------------------------------------

/**
 * Where the water keeps running at low tide though the terrain's sea floor would dry: the isobaths reach neither the
 * Urumea's mouth nor Santa Klara's jetty, and the harmonic fill between them and the LiDAR's shore leaves a bar across
 * the river (-0.4 m) and the ferries' landing in half a metre of water. With the real-time switch on these channels are
 * dredged to `floor` (m) along `path` ([x, z, ...], local frame), fully within `inner` m of it and blending back into
 * the fill by `outer`, wherever the fill lies under mean sea level (sea-uniforms.js lowers the terrain and the water's
 * sea floor alike; with the switch off nothing changes). Traced on the terrain along the river's thalweg (from the bar
 * out to the -3 m contour and up to the channel's -3.5 m bed) and along the ferries' lanes (js/donostia/data-boats.js
 * FERRY) to the jetty's head.
 */
export const LOW_WATER_CHANNELS = [
  { name: 'Urumea mouth', floor: -3.3, inner: 12, outer: 30,
    path: [505, -541, 530, -500, 580, -460, 622, -420, 648, -380, 668, -330, 690, -290, 715, -250, 730, -220] },
  { name: 'Santa Klara landing', floor: -3.6, inner: 13, outer: 24,
    path: [-850, 140, -905, 140, -925, 131, -922, 117, -916, 110] }
];

/** The sea floor at (x, z) once the low-water channels are dredged, from the terrain's `bed` there (m). */
export function channelFloor(x, z, bed) {
  let floor = bed;
  for (const { floor: target, inner, outer, path } of LOW_WATER_CHANNELS) {
    let d = Infinity;
    for (let k = 0; k + 3 < path.length; k += 2) {
      const ax = path[k], az = path[k + 1], dx = path[k + 2] - ax, dz = path[k + 3] - az;
      const t = clamp(((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz), 0, 1);
      d = Math.min(d, Math.hypot(x - ax - t * dx, z - az - t * dz));
    }
    const mask = smooth(outer, inner, d) * smooth(0.1, -0.4, bed);
    floor = Math.min(floor, bed + (target - bed) * mask);
  }
  return floor;
}

// --- the port's floating pontoons ----------------------------------------------------------------------------------------

/** The pontoons' level (m, the floats' waterline): the water's, down to where they settle on the basins' bed. */
export function pontoonLevel(level) {
  return Math.max(level, MARINA.level.ground);
}

/** A gangway's pitch (rad, + down to the pontoon) hinged at hingeY on the quay, its foot on the deck at `level`. */
export function gangwayPitch(hingeY, length, level) {
  const drop = hingeY - (pontoonLevel(level) + MARINA.level.freeboard);
  return Math.asin(clamp(drop / length, -0.95, 0.95));
}
