// js/donostia/seamark-timing.js
// The clock the aids to navigation keep time by, and a light's character as the share of its full intensity it shows
// at a moment: shared by the glows of js/donostia/seamarks.js (which do the same sums in their shader) and the
// lighthouses' lanterns & beams (js/donostia/landmarks/igeldo.js, santa-klara.js), so all of them flash together.
// No three.js here: the tests run it in Node.
//
// A light (js/donostia/data-seamarks.js) shows during its `on` spans, s into its `period`, shifted by its own `phase`.
// A revolving optic (`rotating`) sends one beam per flash round clockwise seen from above: a viewer at azimuth psi sees
// each flash when its beam points at them, psi / 2pi of a period later than a viewer due east, and the flash swells and
// fades as the beam sweeps across (a Gaussian over its length); a lantern that flashes in place switches on and off in
// a few hundredths of a second, the same for every viewer.

const T0 = typeof performance !== 'undefined' ? performance.now() : 0;
let frozen = null;

/** Seconds on the lights' clock: real time since the page loaded, whatever the frame rate; or the time set by freeze(). */
export function seamarkClock() {
  return frozen ?? (performance.now() - T0) / 1000;
}

/** Stops the lights' clock at t seconds (null runs it again): renders of a flash at a known moment. */
export function freezeSeamarkClock(t) {
  frozen = t == null ? null : Number(t);
}

export const RISE = 0.02; // s: half a fixed lantern's switch-on, either side of the published start
export const FALL = 0.04; // s: half its switch-off

const ramp = (q, a, b) => Math.min(1, Math.max(0, (q - a + RISE) / (2 * RISE))) * Math.min(1, Math.max(0, (b - q + FALL) / (2 * FALL)));

/**
 * The share of `light`'s full intensity it shows at clock time t (s), 0..1, to a viewer at azimuth psi (radians,
 * atan2(dz, dx) of the viewer from the light; x east, z south). psi only matters for a revolving optic.
 */
export function lightLevel(light, t, psi = 0) {
  const { period, on, phase, rotating } = light;
  let tau = t + phase;
  if (rotating) tau -= (psi / (2 * Math.PI)) * period;
  const p = tau - period * Math.floor(tau / period);
  let f = 0;
  for (let k = 0; k < on.length; k += 2) {
    const a = on[k], b = on[k + 1], m = (a + b) / 2, w = (b - a) / 2;
    // the spans either side of this period too: a flash's ramps reach across its ends
    for (const q of [p - period, p, p + period]) f += rotating ? Math.exp(-(((q - m) / w) ** 2)) : ramp(q, a, b);
  }
  return Math.min(1, f);
}

/** Where a revolving optic's beams point at clock time t: the azimuth (atan2(z, x), radians) of the optic's zero. */
export function beamAzimuth(light, t) {
  return ((2 * Math.PI) / light.period) * (t + light.phase);
}
