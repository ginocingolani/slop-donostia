import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, attribute, positionWorld, mix, smoothstep, step, floor, fract, min, max, sin, cos, dot, fwidth,
  mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { BRIDGES } from './data-bridges.js';

// js/donostia/bridges.js
// The bridges of the core (tools/donostia/bake-bridges.mjs -> data-bridges.js), built over the OpenStreetMap bridge
// ways at the road level of their ends: decks with their carriageways, pavements & bidegorris, parapets, piers down to
// the river bed or the ground. The Urumea's bridges as built (sources in the bake's table), from the sea upstream:
//   Zurriola (1921)          four straight concrete spans on three piers whose round cutwaters rise past the deck as
//                            pedestals for Víctor Arana's six lamp columns: white shafts on green cast iron, faceted
//                            glass globes; green Secession railings, three-globe green lamp posts at mid-span
//   Santa Katalina (1872)    four elliptical vaults, pink Ereño limestone spandrels, grey Mutriku ashlar rings, cornice
//                            and piers, low round cutwaters, the piers carried up the faces as pilasters with the
//                            city's arms; solid parapets; Juan Alday's 1926 globe candelabra over the piers and ends
//   María Kristina (1905)    three 24 m segmental arches, cream, under a cornice on scrolled modillions; pink granite
//                            balustrades with black iron grilles and dragon-crowned lanterns, a five-lantern group on a
//                            tiled pedestal over each pier, sculpted prows with a bronze sea creature on the cutwaters;
//                            four 18 m obelisk pavilions straddling the pavements at the ends: grey bases, pink granite
//                            columns, a cream canopy of arches, pediments & oculi with corner lanterns, the arms, a
//                            square tower and a gilded rider on a rearing horse
//   Mundaiz, Lehendakari Agirre   single-span girders over the whole river (Agirre paved in coloured tiles)
//   Mikel Laboa footbridge   haunched steel box over 9 + 74 + 9 m, timber deck, 6.4 m wide at the park end to 3 m
//   Real Sociedad & the railway bridge beside it: three spans on two piers parallel to the banks
//   Astiñene (steel girders, 40 m central span), Urdintzu (1926, three stone arches)
// and the bypass viaducts, footbridges (with the lifts at their ends) and road bridges over the valleys.
// One merged mesh per material (6 draw calls). userData.deckAt(x, z) gives the deck height under a point (or null) for
// the travel modes to come.

// --- palette (linear RGB) -------------------------------------------------------------------------------------------

const C = {
  asphalt: [0.05, 0.05, 0.055], paving: [0.33, 0.31, 0.28], bike: [0.3, 0.06, 0.05], timber: [0.2, 0.13, 0.075],
  ballast: [0.13, 0.115, 0.1], tiles: [-1, -1, -1], // (the deck shader lays the coloured tiles where red is negative)
  concrete: [0.43, 0.42, 0.39], lightSteel: [0.5, 0.51, 0.5], steel: [0.26, 0.28, 0.28], plate: [0.12, 0.14, 0.13],
  railing: [0.035, 0.06, 0.045], // dark green park ironwork
  modern: [0.42, 0.43, 0.44], // galvanised & stainless railings, lamp posts
  green: [0.012, 0.16, 0.095], // Zurriola's cast iron
  white: [0.72, 0.73, 0.7], // its painted shafts
  granite: [0.3, 0.3, 0.28], fascia: [0.46, 0.46, 0.43],
  black: [0.018, 0.018, 0.02], // María Kristina's lamp posts & grilles
  cream: [0.6, 0.55, 0.42], creamDark: [0.47, 0.43, 0.33], pink: [0.5, 0.27, 0.21], baseGrey: [0.46, 0.46, 0.44],
  skPink: [0.56, 0.36, 0.28], skGrey: [0.54, 0.52, 0.47], skPier: [0.42, 0.41, 0.38], maroon: [0.1, 0.035, 0.03], // Santa Katalina
  sandstone: [0.42, 0.36, 0.27],
  gold: [0.85, 0.6, 0.22], patina: [0.2, 0.36, 0.28], bronze: [0.26, 0.19, 0.1], shield: [0.16, 0.2, 0.42],
  glass: [0.04, 0.06, 0.07]
};
const SURFACE_COLOURS = [C.asphalt, C.paving, C.bike, C.timber, C.ballast, C.tiles];
const CURB = 0.15; // m: pavements stand this far above the carriageway
const LIFT = 0.06; // m: decks ride this far above their road level so they don't z-fight the street where they land
const TAU = Math.PI * 2;

// --- geometry buckets (plain arrays: this part runs in Node for tests) -------------------------------------------------

// pos, normal, u (metres along a face, for the masonry joints), colour; the masonry also stores its block length
function bucket(joints = false) {
  return { pos: [], nrm: [], u: [], col: [], jnt: joints ? [] : null, idx: [] };
}
// A paint: a bucket, a colour and (masonry) a block length in metres, 0 for smooth render
const paint = (b, c, j = 0) => ({ b, c, j });

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

// Flat-shaded polygon (3 or 4 corners). `hint` is roughly the outward direction: the corners are flipped to face it,
// so the normals are right whatever order the callers list the corners in.
function face(m, pts, hint, us = null) {
  const b = m.b;
  let n = unit(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
  if (pts.length === 4 && Math.hypot(...cross(sub(pts[1], pts[0]), sub(pts[2], pts[0]))) < 1e-9) {
    n = unit(cross(sub(pts[2], pts[0]), sub(pts[3], pts[0])));
  }
  let order = pts.map((_, k) => k);
  if (hint && n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) {
    n = [-n[0], -n[1], -n[2]];
    order = order.reverse();
  }
  const base = b.pos.length / 3;
  for (const k of order) {
    b.pos.push(pts[k][0], pts[k][1], pts[k][2]);
    b.nrm.push(n[0], n[1], n[2]);
    b.u.push(us ? us[k] : 0);
    b.col.push(m.c[0], m.c[1], m.c[2]);
    if (b.jnt) b.jnt.push(m.j);
  }
  b.idx.push(base, base + 1, base + 2);
  if (pts.length === 4) b.idx.push(base, base + 2, base + 3);
}

// Box aligned with the deck: centre (x, y, z), half sizes along (ha), across (hc), up (hu); tangent (tx, tz)
function box(m, x, y, z, ha, hc, hu, tx, tz, bottom = false) {
  const nx = -tz, nz = tx;
  const P = (a, c, v) => [x + tx * a + nx * c, y + v, z + tz * a + nz * c];
  const faces = [
    [[P(ha, -hc, -hu), P(ha, hc, -hu), P(ha, hc, hu), P(ha, -hc, hu)], [tx, 0, tz], hc],
    [[P(-ha, -hc, -hu), P(-ha, hc, -hu), P(-ha, hc, hu), P(-ha, -hc, hu)], [-tx, 0, -tz], hc],
    [[P(-ha, hc, -hu), P(ha, hc, -hu), P(ha, hc, hu), P(-ha, hc, hu)], [nx, 0, nz], ha],
    [[P(-ha, -hc, -hu), P(ha, -hc, -hu), P(ha, -hc, hu), P(-ha, -hc, hu)], [-nx, 0, -nz], ha],
    [[P(-ha, -hc, hu), P(ha, -hc, hu), P(ha, hc, hu), P(-ha, hc, hu)], [0, 1, 0], ha]
  ];
  if (bottom) faces.push([[P(-ha, -hc, -hu), P(ha, -hc, -hu), P(ha, hc, -hu), P(-ha, hc, -hu)], [0, -1, 0], ha]);
  for (const [pts, hint, h] of faces) face(m, pts, hint, [-h, h, h, -h]);
}

// Upright square bar (posts, balusters' iron, railing bars): its four sides only
function bar(m, x, y0, y1, z, h, tx, tz) {
  const nx = -tz, nz = tx;
  const P = (a, c, y) => [x + tx * a + nx * c, y, z + tz * a + nz * c];
  for (const [a, c, n] of [[h, 0, [tx, 0, tz]], [-h, 0, [-tx, 0, -tz]], [0, h, [nx, 0, nz]], [0, -h, [-nx, 0, -nz]]]) {
    const da = c ? h : 0, dc = a ? h : 0;
    face(m, [P(a - da, c - dc, y0), P(a + da, c + dc, y0), P(a + da, c + dc, y1), P(a - da, c - dc, y1)], n);
  }
}

// Vertical prism of `sides` sides from y0 (radius r0) to y1 (radius r1), optionally capped on top; rot turns it
function prism(m, x, z, y0, y1, r0, r1, sides, cap = true, rot = Math.PI / sides) {
  const ring = (r, y) => Array.from({ length: sides }, (_, k) => {
    const a = rot + (TAU * k) / sides;
    return [x + r * Math.cos(a), y, z + r * Math.sin(a)];
  });
  const lo = ring(r0, y0), hi = ring(r1, y1);
  const arc = (TAU * Math.max(r0, r1)) / sides;
  for (let k = 0; k < sides; k++) {
    const q = (k + 1) % sides, a = rot + (TAU * (k + 0.5)) / sides;
    if (r0 < 1e-3 && r1 < 1e-3) break;
    face(m, r0 < 1e-3 ? [lo[k], hi[q], hi[k]] : r1 < 1e-3 ? [lo[k], lo[q], hi[k]] : [lo[k], lo[q], hi[q], hi[k]],
      [Math.cos(a), (r0 - r1) / Math.max(0.05, y1 - y0), Math.sin(a)], [k * arc, (k + 1) * arc, (k + 1) * arc, k * arc]);
  }
  if (cap && r1 > 1e-3) for (let k = 0; k < sides; k++) face(m, [hi[k], hi[(k + 1) % sides], [x, y1, z]], [0, 1, 0]);
}

// A faceted ball (the lantern globes): stacked prisms between latitudes
function ball(m, x, y, z, r, sides = 8) {
  const lat = [-1, -0.62, -0.2, 0.2, 0.62, 1].map((s) => Math.asin(s));
  for (let k = 1; k < lat.length; k++) {
    prism(m, x, z, y + r * Math.sin(lat[k - 1]), y + r * Math.sin(lat[k]), r * Math.cos(lat[k - 1]), r * Math.cos(lat[k]), sides, false);
  }
}

// Beam between two points with a square-ish section (w across, h up), for members, brackets & limbs
function beam(m, p, q, w, h) {
  const d = unit(sub(q, p));
  let side = cross(d, [0, 1, 0]);
  if (Math.hypot(...side) < 1e-6) side = [1, 0, 0];
  side = unit(side);
  const up = unit(cross(side, d));
  const off = (pt, s, v) => [pt[0] + side[0] * s + up[0] * v, pt[1] + side[1] * s + up[1] * v, pt[2] + side[2] * s + up[2] * v];
  const len = Math.hypot(...sub(q, p));
  const sides = [[w / 2, 0, side], [-w / 2, 0, side.map((c) => -c)], [0, h / 2, up], [0, -h / 2, up.map((c) => -c)]];
  for (const [s, v, n] of sides) {
    const a = s ? [s, -h / 2] : [-w / 2, v], c = s ? [s, h / 2] : [w / 2, v];
    face(m, [off(p, a[0], a[1]), off(q, a[0], a[1]), off(q, c[0], c[1]), off(p, c[0], c[1])], n, [0, len, len, 0]);
  }
}

// --- one bridge: its frame ----------------------------------------------------------------------------------------------

function frameOf(br) {
  const pts = [];
  for (let k = 0; k < br.axis.length; k += 2) pts.push([br.axis[k], br.axis[k + 1]]);
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const L = cum[cum.length - 1];
  // position & a mitred unit tangent at arc length s (straight on past both ends)
  const at = (s) => {
    let k = 1;
    while (k < pts.length - 1 && cum[k] < s) k++;
    const seg = cum[k] - cum[k - 1] || 1e-9;
    const t = (s - cum[k - 1]) / seg;
    const [ax, az] = pts[k - 1], [bx, bz] = pts[k];
    let tx = (bx - ax) / seg, tz = (bz - az) / seg;
    const blend = (j) => {
      if (j <= 0 || j >= pts.length - 1) return;
      const s2 = cum[j + 1] - cum[j] || 1e-9, ux = (pts[j + 1][0] - pts[j][0]) / s2, uz = (pts[j + 1][1] - pts[j][1]) / s2;
      const s1 = cum[j] - cum[j - 1] || 1e-9, vx = (pts[j][0] - pts[j - 1][0]) / s1, vz = (pts[j][1] - pts[j - 1][1]) / s1;
      const l = Math.hypot(ux + vx, uz + vz) || 1;
      tx = (ux + vx) / l;
      tz = (uz + vz) / l;
    };
    if (t > 1e-4 && t < 1 - 1e-4) { /* inside a segment */ } else if (t <= 1e-4) blend(k - 1);
    else blend(k);
    return [ax + (bx - ax) * t, az + (bz - az) * t, tx, tz];
  };
  return { pts, cum, L, at };
}

// Arc lengths for the cross-sections: every axis vertex, every `step` metres and every extra break, within [a, b]
function sections(fr, step, extra = [], a = 0, b = fr.L) {
  const s = new Set([a, b, ...fr.cum.filter((v) => v > a && v < b), ...extra.filter((v) => v > a && v < b)]);
  for (let v = a + step; v < b; v += step) s.add(v);
  return [...s].map((v) => Math.round(v * 1000) / 1000).sort((p, q) => p - q).filter((v, k, arr) => k === 0 || v - arr[k - 1] > 0.01);
}

// Lerp through [[s, v], ...] with cosine easing between samples (girder haunches)
function eased(samples, s) {
  if (s <= samples[0][0]) return samples[0][1];
  for (let k = 1; k < samples.length; k++) {
    const [s0, v0] = samples[k - 1], [s1, v1] = samples[k];
    if (s <= s1) {
      const t = (s - s0) / (s1 - s0 || 1);
      return v0 + (v1 - v0) * (0.5 - 0.5 * Math.cos(Math.PI * t));
    }
  }
  return samples[samples.length - 1][1];
}

// The bridge's construction kit: frame, deck level & edges, strips along it
function kit(br, heightAt, B, index) {
  const fr = frameOf(br);
  const L = fr.L;
  const [wa, wb] = Array.isArray(br.width) ? br.width : [br.width, br.width];
  const half = (s) => (wa + ((wb - wa) * Math.min(L, Math.max(0, s))) / L) / 2;
  const [y0, y1] = br.y;
  const camber = { mariakristina: 0.6, katalina: 0.35, stone: 0.3, modern: 0.12, girder: 0.25, footbridge: L > 40 ? 0.4 : 0 }[br.style] || 0;
  const top = (s) => LIFT + y0 + ((y1 - y0) * s) / L + camber * Math.sin((Math.PI * Math.min(L, Math.max(0, s))) / L);
  const P = (s, o, y) => {
    const [x, z, tx, tz] = fr.at(s);
    return [x - tz * o, y, z + tx * o];
  };
  const skew = br.skew || 0;
  // a point on the line parallel to the banks through s (piers stand along the current)
  const PK = (s, o, y) => P(s - skew * o, o, y);
  const uOff = (index * 37.3) % 50; // so neighbouring bridges don't share their stone joints
  const right = (sign) => (tx, tz) => [-tz * sign, 0, tx * sign];
  // Strip along the deck between two edge functions of s, flat-shaded per segment
  const strip = (m, S, edgeA, edgeB, hint) => {
    for (let k = 1; k < S.length; k++) {
      const a0 = edgeA(S[k - 1]), a1 = edgeA(S[k]), b0 = edgeB(S[k - 1]), b1 = edgeB(S[k]);
      const [, , tx, tz] = fr.at((S[k - 1] + S[k]) / 2);
      face(m, [a0, a1, b1, b0], typeof hint === 'function' ? hint(tx, tz) : hint,
        [S[k - 1] + uOff, S[k] + uOff, S[k] + uOff, S[k - 1] + uOff]);
    }
  };
  // A box at (s, o) whose base sits at height y
  const boxAt = (m, s, o, y, ha, hc, h, bottom = false) => {
    const [x, , z] = P(s, o, 0), [, , tx, tz] = fr.at(s);
    box(m, x, y + h / 2, z, ha, hc, h / 2, tx, tz, bottom);
  };
  const bedAt = (s, o) => {
    const [x, , z] = P(s, o, 0);
    return heightAt(x, z);
  };
  const supports = br.supports || [0, ...br.piers, L];
  const S = sections(fr, 3, [...supports, ...br.piers]);
  return { br, fr, L, half, top, P, PK, skew, strip, right, boxAt, bedAt, S, B, heightAt, supports, uOff };
}

// --- decks ---------------------------------------------------------------------------------------------------------------

// Surface bands (fractions of the width), pavements raised behind a kerb, rails on the track beds
function deckTop(k) {
  const { br, half, top, P, strip, right, S, B } = k;
  const hasRoad = br.bands.some((band) => band[2] === 0);
  const raise = (surface) => (hasRoad && surface !== 0 && surface !== 4 ? CURB : 0);
  const o = (f) => (s) => f * 2 * half(s);
  br.bands.forEach(([a, b, surface], q) => {
    const lift = raise(surface) + (surface === 4 ? 0.12 : 0);
    const m = paint(B.deck, SURFACE_COLOURS[surface]);
    strip(m, S, (s) => P(s, o(a)(s), top(s) + lift), (s) => P(s, o(b)(s), top(s) + lift), [0, 1, 0]);
    const next = br.bands[q + 1];
    if (next && raise(next[2]) !== raise(surface)) {
      const lo = Math.min(raise(next[2]), raise(surface)), hi = Math.max(raise(next[2]), raise(surface));
      const sign = raise(surface) > raise(next[2]) ? 1 : -1; // the kerb faces the lower side
      strip(paint(B.deck, C.paving), S, (s) => P(s, o(b)(s), top(s) + lo), (s) => P(s, o(b)(s), top(s) + hi), right(sign));
    }
    if (surface === 4) { // rails: Iberian gauge, one pair per ~4.4 m of track bed
      const tracks = Math.max(1, Math.round(((b - a) * 2 * half(k.L / 2)) / 4.4));
      const rail = paint(B.metal, [0.25, 0.24, 0.23]);
      for (let t = 0; t < tracks; t++) {
        for (const g of [-0.834, 0.834]) {
          const c = (s) => (a + ((b - a) * (t + 0.5)) / tracks) * 2 * half(s) + g;
          strip(rail, S, (s) => P(s, c(s) - 0.035, top(s) + lift + 0.17), (s) => P(s, c(s) + 0.035, top(s) + lift + 0.17), [0, 1, 0]);
          strip(rail, S, (s) => P(s, c(s) - 0.035, top(s) + lift), (s) => P(s, c(s) - 0.035, top(s) + lift + 0.17), right(-1));
          strip(rail, S, (s) => P(s, c(s) + 0.035, top(s) + lift), (s) => P(s, c(s) + 0.035, top(s) + lift + 0.17), right(1));
        }
      }
    }
  });
  return raise;
}

// Slab under the deck: both faces from depth(s) below the deck up to an upstand, the soffit and the end caps
function slab(k, m, depth, { up = 0.3, inset = 0.4, soffit = m } = {}) {
  const { L, half, top, P, strip, right, S, fr } = k;
  for (const sign of [-1, 1]) {
    strip(m, S, (s) => P(s, sign * half(s), top(s) - depth(s)), (s) => P(s, sign * half(s), top(s) + up), right(sign));
    if (up > 0.05) {
      const inner = (s) => sign * (half(s) - inset);
      strip(m, S, (s) => P(s, inner(s), top(s) + up), (s) => P(s, sign * half(s), top(s) + up), [0, 1, 0]);
      strip(m, S, (s) => P(s, inner(s), top(s)), (s) => P(s, inner(s), top(s) + up), right(-sign));
    }
  }
  strip(soffit, S, (s) => P(s, -half(s), top(s) - depth(s)), (s) => P(s, half(s), top(s) - depth(s)), [0, -1, 0]);
  for (const [s, e] of [[0, -1], [L, 1]]) {
    const [, , tx, tz] = fr.at(s);
    face(m, [P(s, -half(s), top(s) - depth(s)), P(s, half(s), top(s) - depth(s)), P(s, half(s), top(s)), P(s, -half(s), top(s))], [tx * e, 0, tz * e]);
  }
}

// Rounded pier wall under the deck along the banks (skew), from the bed (or the ground) to yTop(s)
function roundPier(k, m, s, halfLen, thick, yTop, bedDrop = 0.6) {
  const { PK, bedAt, skew } = k;
  const bed = Math.min(bedAt(s - skew * halfLen, -halfLen), bedAt(s, 0), bedAt(s + skew * halfLen, halfLen)) - bedDrop;
  const yt = yTop;
  if (yt - bed < 0.5) return;
  const r = Math.min(thick / 2, halfLen), n = 6;
  const outline = [];
  for (let q = 0; q <= n; q++) { const a = -Math.PI / 2 + (Math.PI * q) / n; outline.push([r * Math.sin(a), halfLen - r + r * Math.cos(a)]); }
  for (let q = 0; q <= n; q++) { const a = Math.PI / 2 + (Math.PI * q) / n; outline.push([r * Math.sin(a), -(halfLen - r) + r * Math.cos(a)]); }
  const c = PK(s, 0, 0);
  for (let q = 0; q < outline.length; q++) {
    const [a0, c0] = outline[q], [a1, c1] = outline[(q + 1) % outline.length];
    const pa = PK(s + a0, c0, 0), pb = PK(s + a1, c1, 0), pm = PK(s + (a0 + a1) / 2, (c0 + c1) / 2, 0);
    face(m, [[pa[0], bed, pa[2]], [pb[0], bed, pb[2]], [pb[0], yt, pb[2]], [pa[0], yt, pa[2]]],
      [pm[0] - c[0], 0, pm[2] - c[2]], [q, q + 1, q + 1, q]);
  }
}

// Bank seats under the end supports of a bridge over the water: walls from the bed (or the quay) up to the structure,
// set back into the bank, so its ends don't hang in the air over the riverside walks
function bankSeats(k, m, yTop) {
  const { br, supports, half, PK, fr, bedAt } = k;
  if (!br.supports) return;
  for (const q of [0, supports.length - 1]) {
    const s = supports[q], e = q === 0 ? -1 : 1, hw = half(s) + 0.3;
    if (s < br.water[0] - 2 || s > br.water[1] + 2) continue; // up the bank: the girder runs into the slope
    const bed = Math.min(bedAt(s, 0), bedAt(s, -hw), bedAt(s, hw)) - 0.5, yt = yTop(s);
    if (yt - bed < 0.3) continue;
    const [, , tx, tz] = fr.at(s);
    const a = s - e * 0.3, b = s + e * 1.8;
    for (const [sv, f] of [[a, -e], [b, e]]) {
      face(m, [PK(sv, -hw, bed), PK(sv, hw, bed), PK(sv, hw, yt), PK(sv, -hw, yt)], [tx * f, 0, tz * f], [-hw, hw, hw, -hw]);
    }
    for (const sign of [-1, 1]) {
      face(m, [PK(a, sign * hw, bed), PK(b, sign * hw, bed), PK(b, sign * hw, yt), PK(a, sign * hw, yt)], [-tz * sign, 0, tx * sign], [a, b, b, a]);
    }
  }
}

// Railing on both edges: posts, rails and (optionally) close vertical bars
function railing(k, colour, { inset = 0.2, base = 0.3, height = 1.05, post = 2, bars = 0, from = 0, to = k.L } = {}) {
  const { half, top, P, strip, right, B, fr } = k;
  const m = paint(B.metal, colour);
  const S = sections(fr, 3, [], from, to);
  for (const sign of [-1, 1]) {
    const o = (s) => sign * (half(s) - inset);
    for (let s = from + 0.5; s < to - 0.3; s += post) {
      const [x, , z] = P(s, o(s), 0), [, , tx, tz] = fr.at(s);
      bar(m, x, top(s) + base, top(s) + base + height, z, 0.045, tx, tz);
    }
    if (bars) {
      for (let s = from + 0.6; s < to - 0.4; s += bars) {
        const [x, , z] = P(s, o(s), 0), [, , tx, tz] = fr.at(s);
        bar(m, x, top(s) + base + 0.07, top(s) + base + height * 0.93, z, 0.012, tx, tz);
      }
    }
    for (const [h, t] of [[height, 0.045], [0.12, 0.03], [height * 0.55, bars ? 0 : 0.022]]) {
      if (!t) continue;
      const yb = (s) => top(s) + base + h;
      strip(m, S, (s) => P(s, o(s) - 0.045, yb(s) + t), (s) => P(s, o(s) + 0.045, yb(s) + t), [0, 1, 0]);
      strip(m, S, (s) => P(s, o(s) - 0.045, yb(s) - t), (s) => P(s, o(s) - 0.045, yb(s) + t), right(-sign));
      strip(m, S, (s) => P(s, o(s) + 0.045, yb(s) - t), (s) => P(s, o(s) + 0.045, yb(s) + t), right(sign));
    }
  }
}

// --- lamps ---------------------------------------------------------------------------------------------------------------

// A plain modern street light: a tapered pole with an arm over the deck
function modernLamp(k, s, sign, y) {
  const { P, half, B } = k;
  const m = paint(B.metal, C.modern);
  const [x, , z] = P(s, sign * (half(s) - 0.35), 0), [hx, , hz] = P(s, sign * (half(s) - 1.6), 0);
  prism(m, x, z, y, y + 8, 0.1, 0.06, 8, true);
  beam(m, [x, y + 7.9, z], [hx, y + 8.1, hz], 0.08, 0.08);
  prism(paint(B.lamp, C.white), hx, hz, y + 7.9, y + 8.1, 0.28, 0.2, 8, true);
}

// Zurriola's three-globe cast-iron posts
function greenPost(k, x, y, z, tx, tz) {
  const { B } = k;
  const m = paint(B.metal, C.green), glow = paint(B.lamp, C.white);
  prism(m, x, z, y, y + 0.9, 0.24, 0.17, 8);
  prism(m, x, z, y + 0.9, y + 5.0, 0.08, 0.06, 8, false);
  for (const h of [1.6, 3.4]) prism(m, x, z, y + h, y + h + 0.12, 0.12, 0.12, 8);
  for (const w of [-1, 1]) {
    const gx = x - tz * w * 0.55, gz = z + tx * w * 0.55;
    beam(m, [x, y + 4.0, z], [gx, y + 4.15, gz], 0.05, 0.05);
    ball(glow, gx, y + 4.4, gz, 0.22);
  }
  ball(glow, x, y + 5.3, z, 0.26);
}

// Santa Katalina's candelabra (Juan Alday, 1926): fluted column, scrolled capital, four arms & a top globe
function candelabrum(k, x, y, z, tx, tz) {
  const { B } = k;
  const m = paint(B.metal, C.maroon), glow = paint(B.lamp, C.white);
  prism(m, x, z, y, y + 0.35, 0.38, 0.34, 8);
  prism(m, x, z, y + 0.35, y + 1.25, 0.3, 0.2, 8, false);
  prism(m, x, z, y + 1.25, y + 4.1, 0.13, 0.1, 8, false);
  prism(m, x, z, y + 4.1, y + 4.7, 0.12, 0.26, 8);
  for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const gx = x + (tx * a - tz * c) * 0.95, gz = z + (tz * a + tx * c) * 0.95;
    beam(m, [x, y + 4.6, z], [gx, y + 4.75, gz], 0.06, 0.08);
    ball(glow, gx, y + 5.05, gz, 0.26);
  }
  prism(m, x, z, y + 4.7, y + 5.45, 0.07, 0.07, 6, false);
  ball(glow, x, y + 5.75, z, 0.28);
  ball(glow, x, y + 6.55, z, 0.3);
}

// María Kristina's lamp posts: ornate black column, lantern & a little dragon on top
function dragonLamp(k, x, y, z, tx, tz) {
  const { B } = k;
  const m = paint(B.metal, C.black);
  prism(m, x, z, y, y + 0.8, 0.24, 0.17, 8);
  prism(m, x, z, y + 0.8, y + 4.1, 0.085, 0.07, 8, false);
  for (const h of [1.4, 2.9, 3.9]) prism(m, x, z, h + y, h + y + 0.14, 0.13, 0.13, 8);
  prism(m, x, z, y + 4.1, y + 4.3, 0.1, 0.2, 8);
  prism(paint(B.lamp, C.white), x, z, y + 4.3, y + 4.95, 0.17, 0.23, 6, false);
  prism(m, x, z, y + 4.95, y + 5.2, 0.27, 0.06, 6);
  beam(m, [x - tx * 0.25, y + 5.2, z - tz * 0.25], [x + tx * 0.3, y + 5.55, z + tz * 0.3], 0.07, 0.12);
  beam(m, [x + tx * 0.3, y + 5.55, z + tz * 0.3], [x + tx * 0.18, y + 5.75, z + tz * 0.18], 0.06, 0.06);
}

// --- masonry arches ------------------------------------------------------------------------------------------------------

// Arches between the supports: spandrel walls on both faces, the soffits and proud rings, piers with cutwaters
//   cfg: spandrel, ring, pier, soffit (paints), spring (m above mean sea level), crown (intrados below the deck),
//        shape 'ellipse' | 'segment', ringDepth, ringProud, pw (pier thickness), cutwater 'round' | 'point', cutTop, capRise,
//        wallTop (spandrel walls end this far above the deck)
function arches(k, cfg) {
  const { fr, L, half, top, P, strip, right, bedAt, supports, uOff } = k;
  const pw = cfg.pw;
  const n = supports.length - 1;
  const spans = [];
  for (let q = 0; q < n; q++) {
    const sa = supports[q] + (q > 0 ? pw / 2 : 0), sb = supports[q + 1] - (q < n - 1 ? pw / 2 : 0);
    if (sb - sa < 2) continue;
    const mid = (sa + sb) / 2, c = (sb - sa) / 2;
    const ys = cfg.spring, yc = Math.max(ys + 1, top(mid) - cfg.crown), r = yc - ys;
    let arch;
    if (cfg.shape === 'ellipse') arch = (s) => ys + r * Math.sqrt(Math.max(0, 1 - ((s - mid) / c) ** 2));
    else {
      const R = (c * c + r * r) / (2 * r), cy = yc - R;
      arch = (s) => cy + Math.sqrt(Math.max(0, R * R - (s - mid) ** 2));
    }
    spans.push({ sa, sb, arch });
  }
  // beyond the end supports the abutments: walls down to the bed
  const bedLine = (s) => Math.min(cfg.spring, Math.min(bedAt(s, -half(s)), bedAt(s, half(s))) - 0.5);
  const intrados = (s) => {
    for (const sp of spans) if (s >= sp.sa - 1e-6 && s <= sp.sb + 1e-6) return sp.arch(s);
    return s < supports[0] || s > supports[n] ? bedLine(s) : cfg.spring;
  };
  const SA = sections(fr, 0.75, spans.flatMap((sp) => [sp.sa, sp.sb]).concat(supports));
  for (const sign of [-1, 1]) {
    strip(cfg.spandrel, SA, (s) => P(s, sign * half(s), intrados(s)), (s) => P(s, sign * half(s), top(s) + cfg.wallTop), right(sign));
  }
  for (const [s, e] of [[0, -1], [L, 1]]) { // end faces (hidden in the quays, closed for the low views)
    const [, , tx, tz] = fr.at(s);
    face(cfg.spandrel, [P(s, -half(s), intrados(s)), P(s, half(s), intrados(s)), P(s, half(s), top(s)), P(s, -half(s), top(s))], [tx * e, 0, tz * e]);
  }
  for (const sp of spans) {
    const SS = sections(fr, 0.6, [], sp.sa, sp.sb);
    const ring = (s) => half(s) + cfg.ringProud;
    strip(cfg.soffit, SS, (s) => P(s, -half(s), sp.arch(s)), (s) => P(s, half(s), sp.arch(s)), [0, -1, 0]);
    for (const sign of [-1, 1]) {
      strip(cfg.ring, SS, (s) => P(s, sign * ring(s), sp.arch(s)), (s) => P(s, sign * ring(s), sp.arch(s) + cfg.ringDepth), right(sign));
      strip(cfg.ring, SS, (s) => P(s, sign * half(s), sp.arch(s)), (s) => P(s, sign * ring(s), sp.arch(s)), [0, -1, 0]);
      strip(cfg.ring, SS, (s) => P(s, sign * half(s), sp.arch(s) + cfg.ringDepth), (s) => P(s, sign * ring(s), sp.arch(s) + cfg.ringDepth), [0, 1, 0]);
    }
  }
  // piers: their faces under the arches, then a cutwater against the current on each side
  for (const p of supports.slice(1, -1)) {
    const hw = half(p);
    const bed = Math.min(bedAt(p, -hw), bedAt(p, 0), bedAt(p, hw)) - 0.6;
    for (const e of [-1, 1]) {
      const s = p + (e * pw) / 2, [, , tx, tz] = fr.at(s);
      face(cfg.pier, [P(s, -hw, bed), P(s, hw, bed), P(s, hw, cfg.spring), P(s, -hw, cfg.spring)], [tx * e, 0, tz * e], [-hw, hw, hw, -hw]);
    }
    const [, , tx, tz] = fr.at(p);
    for (const sign of [-1, 1]) {
      const out = [-tz * sign, 0, tx * sign];
      const at = (pt, y) => [pt[0], y, pt[2]];
      if (cfg.cutwater === 'round') {
        const r = pw / 2, segs = 8;
        const rim = Array.from({ length: segs + 1 }, (_, q) => {
          const a = (Math.PI * q) / segs;
          return P(p - r * Math.cos(a), sign * (hw + r * Math.sin(a) * 0.9), 0);
        });
        const capTop = cfg.cutTop + r * (cfg.capRise ?? 0.7), apex = P(p, sign * hw, capTop);
        for (let q = 0; q < segs; q++) {
          const a = (Math.PI * (q + 0.5)) / segs, nrm = [tx * -Math.cos(a) + out[0] * Math.sin(a), 0, tz * -Math.cos(a) + out[2] * Math.sin(a)];
          face(cfg.pier, [at(rim[q], bed), at(rim[q + 1], bed), at(rim[q + 1], cfg.cutTop), at(rim[q], cfg.cutTop)], nrm, [q, q + 1, q + 1, q].map((v) => v * 0.6 + uOff));
          face(cfg.cutCap || cfg.pier, [at(rim[q], cfg.cutTop), at(rim[q + 1], cfg.cutTop), apex], [nrm[0], 0.8, nrm[2]]);
        }
      } else {
        const a = P(p - pw / 2, sign * hw, 0), c = P(p + pw / 2, sign * hw, 0), tip = P(p, sign * (hw + pw * 0.7), 0);
        face(cfg.pier, [at(a, bed), at(tip, bed), at(tip, cfg.cutTop), at(a, cfg.cutTop)], [out[0] - tx, 0, out[2] - tz], [0, 2, 2, 0]);
        face(cfg.pier, [at(tip, bed), at(c, bed), at(c, cfg.cutTop), at(tip, cfg.cutTop)], [out[0] + tx, 0, out[2] + tz], [0, 2, 2, 0]);
        const apex = P(p, sign * hw, cfg.cutTop + pw * 0.45);
        face(cfg.cutCap || cfg.pier, [at(a, cfg.cutTop), at(tip, cfg.cutTop), apex], [out[0] - tx, 1, out[2] - tz]);
        face(cfg.cutCap || cfg.pier, [at(tip, cfg.cutTop), at(c, cfg.cutTop), apex], [out[0] + tx, 1, out[2] + tz]);
      }
    }
  }
  return spans;
}

// A cornice band along both faces: projecting `proud` from the deck edges between two heights below the deck
function cornice(k, m, y0, y1, proud, S = k.S) {
  const { half, top, P, strip, right } = k;
  for (const sign of [-1, 1]) {
    const o = (s) => sign * (half(s) + proud);
    strip(m, S, (s) => P(s, o(s), top(s) + y0), (s) => P(s, o(s), top(s) + y1), right(sign));
    strip(m, S, (s) => P(s, sign * half(s), top(s) + y0), (s) => P(s, o(s), top(s) + y0), [0, -1, 0]);
    strip(m, S, (s) => P(s, sign * half(s), top(s) + y1), (s) => P(s, o(s), top(s) + y1), [0, 1, 0]);
  }
}

// Solid parapets: inner face, coping (the outer face is the spandrel wall carried up)
function solidParapet(k, wall, coping, h) {
  const { half, top, P, strip, right, S } = k;
  for (const sign of [-1, 1]) {
    const inner = (s) => sign * (half(s) - 0.45);
    strip(wall, S, (s) => P(s, inner(s), top(s)), (s) => P(s, inner(s), top(s) + h), right(-sign));
    strip(coping, S, (s) => P(s, inner(s) - sign * 0.06, top(s) + h + 0.16), (s) => P(s, sign * (half(s) + 0.1), top(s) + h + 0.16), [0, 1, 0]);
    strip(coping, S, (s) => P(s, inner(s) - sign * 0.06, top(s) + h), (s) => P(s, inner(s) - sign * 0.06, top(s) + h + 0.16), right(-sign));
    strip(coping, S, (s) => P(s, sign * (half(s) + 0.1), top(s) + h), (s) => P(s, sign * (half(s) + 0.1), top(s) + h + 0.16), right(sign));
  }
}

// --- the styles ----------------------------------------------------------------------------------------------------------

// Santa Katalina: four elliptical vaults on low round cutwaters, the piers carried up the faces as grey ashlar
// pilasters with the city's arms under the cornice (photos 1930s-2020s), solid parapets, candelabra over the piers
function katalina(k) {
  const { B, supports, half, top, P, fr, boxAt } = k;
  const pink = paint(B.masonry, C.skPink, 1.7), grey = paint(B.masonry, C.skGrey, 1.1);
  const pw = k.br.pier || 4.6;
  arches(k, {
    spandrel: pink, ring: grey, pier: paint(B.masonry, C.skPier, 1.1), soffit: paint(B.masonry, C.skGrey, 0.9), spring: 0.2, crown: 1.3,
    shape: 'ellipse', ringDepth: 0.85, ringProud: 0.1, pw, cutwater: 'round', cutTop: 0.7, capRise: 0.3, wallTop: 1.05
  });
  cornice(k, grey, -1.0, -0.62, 0.22);
  solidParapet(k, pink, grey, 1.05);
  // pilasters on the piers and half pilasters at the abutments, from the cutwaters to the cornice
  const shield = paint(B.metal, C.shield);
  for (const p of supports) {
    const end = p === supports[0] ? 1 : p === supports[supports.length - 1] ? -1 : 0;
    const ha = end ? 0.8 : 1.5, s = p + end * ha;
    for (const sign of [-1, 1]) {
      const o = sign * (half(s) + 0.22);
      boxAt(grey, s, o, end ? -1 : 0.7 + pw * 0.35, ha, 0.22, top(s) - 1.0 - (end ? -1 : 0.7 + pw * 0.35));
      if (end) continue;
      boxAt(grey, s, sign * (half(s) + 0.5), top(s) - 2.6, 0.5, 0.06, 1.05); // cartouche
      boxAt(shield, s, sign * (half(s) + 0.57), top(s) - 2.45, 0.32, 0.02, 0.75); // the arms
    }
  }
  for (const s of supports.map((v) => Math.min(k.L - 1.2, Math.max(1.2, v)))) {
    for (const sign of [-1, 1]) {
      const o = sign * (half(s) - 0.28), [x, , z] = P(s, o, 0), [, , tx, tz] = fr.at(s);
      boxAt(grey, s, o, top(s), 0.62, 0.62, 1.3);
      candelabrum(k, x, top(s) + 1.3, z, tx, tz);
    }
  }
}

// María Kristina: three segmental arches, the cornice, balustrades, prows on the piers, lamp posts and the four pylons
function mariaKristina(k) {
  const { B, supports, half, top, P, fr, boxAt, L, strip, right } = k;
  const cream = paint(B.masonry, C.cream), ringC = paint(B.masonry, C.cream, 0.7);
  const pw = k.br.pier || 5;
  arches(k, {
    spandrel: cream, ring: ringC, pier: paint(B.masonry, C.cream, 1.2), soffit: paint(B.masonry, C.creamDark), spring: 0.9,
    crown: 1.1, shape: 'segment', ringDepth: 0.7, ringProud: 0.12, pw, cutwater: 'point', cutTop: 1.9, wallTop: -0.62,
    cutCap: cream
  });
  // cornice on modillions
  cornice(k, cream, -0.62, 0, 0.38);
  for (let s = 1; s < L - 1; s += 0.9) {
    for (const sign of [-1, 1]) boxAt(cream, s, sign * (half(s) + 0.17), top(s) - 0.95, 0.09, 0.17, 0.33);
  }
  // sculpted prows: the cutwaters carried up to the cornice, a bronze sea creature on each
  for (const p of supports.slice(1, -1)) {
    const [, , tx, tz] = fr.at(p);
    for (const sign of [-1, 1]) {
      const hw = half(p), at = (pt, y) => [pt[0], y, pt[2]];
      const a = P(p - 1.0, sign * hw, 0), c = P(p + 1.0, sign * hw, 0), tip = P(p, sign * (hw + 1.4), 0);
      const y0 = 2.5, y1 = top(p) - 0.62, out = [-tz * sign, 0, tx * sign];
      face(cream, [at(a, y0), at(tip, y0), at(tip, y1), at(a, y1)], [out[0] - tx, 0, out[2] - tz], [0, 2, 2, 0]);
      face(cream, [at(tip, y0), at(c, y0), at(c, y1), at(tip, y1)], [out[0] + tx, 0, out[2] + tz], [0, 2, 2, 0]);
      const [fx, , fz] = P(p, sign * (hw + 1.45), 0);
      beam(paint(B.bronze, C.patina), [fx, y0 + 0.3, fz], [fx + out[0] * 0.35, y0 + 1.3, fz + out[2] * 0.35], 0.22, 0.3);
    }
  }
  // balustrades: pink granite pedestals, balusters & handrail, black iron grilles between
  const pink = paint(B.masonry, C.pink), black = paint(B.metal, C.black);
  const S = k.S;
  const ped = 2.5;
  for (const sign of [-1, 1]) {
    const o = (s) => sign * (half(s) - 0.25);
    strip(pink, S, (s) => P(s, o(s) - 0.24, top(s) + 0.2), (s) => P(s, o(s) + 0.24, top(s) + 0.2), [0, 1, 0]);
    for (const e of [-1, 1]) strip(pink, S, (s) => P(s, o(s) + e * 0.24, top(s)), (s) => P(s, o(s) + e * 0.24, top(s) + 0.2), right(sign * e));
    strip(pink, S, (s) => P(s, o(s) - 0.21, top(s) + 1.0), (s) => P(s, o(s) + 0.21, top(s) + 1.0), [0, 1, 0]);
    strip(pink, S, (s) => P(s, o(s) - 0.21, top(s) + 0.88), (s) => P(s, o(s) + 0.21, top(s) + 0.88), [0, -1, 0]);
    for (const e of [-1, 1]) strip(pink, S, (s) => P(s, o(s) + e * 0.21, top(s) + 0.88), (s) => P(s, o(s) + e * 0.21, top(s) + 1.0), right(sign * e));
    let q = 0;
    const nearPier = (s) => supports.slice(1, -1).some((p) => Math.abs(s - p) < 2.6);
    for (let s = 4.6; s < L - 4.6; s += ped, q++) {
      boxAt(pink, s, o(s), top(s), 0.26, 0.28, 1.02);
      boxAt(pink, s, o(s), top(s) + 1.02, 0.31, 0.32, 0.12);
      if (q % 4 === 2 && !nearPier(s)) {
        const [x, , z] = P(s, o(s), 0), [, , tx, tz] = fr.at(s);
        dragonLamp(k, x, top(s) + 1.14, z, tx, tz);
      }
      if (s + ped >= L - 4.6) break;
      for (const d of [0.55, 0.8, ped - 0.8, ped - 0.55]) {
        const [x, , z] = P(s + d, o(s + d), 0), y = top(s + d);
        prism(pink, x, z, y + 0.2, y + 0.5, 0.075, 0.115, 6, false);
        prism(pink, x, z, y + 0.5, y + 0.88, 0.115, 0.07, 6, false);
      }
      boxAt(black, s + ped / 2, o(s + ped / 2), top(s + ped / 2) + 0.24, ped / 2 - 0.98, 0.025, 0.6);
    }
  }
  // over each pier a big pedestal in the balustrade, the arms in coloured tiles on its face, carrying a black cast-iron
  // group of five lanterns over cherubs
  for (const p of supports.slice(1, -1)) {
    for (const sign of [-1, 1]) {
      const o = sign * (half(p) - 0.3), [x, , z] = P(p, o, 0), [, , tx, tz] = fr.at(p), y = top(p);
      boxAt(pink, p, o, y, 0.75, 0.45, 1.25);
      boxAt(pink, p, o, y + 1.25, 0.85, 0.52, 0.14);
      boxAt(paint(B.metal, C.shield), p, sign * (half(p) + 0.17), y + 0.25, 0.42, 0.02, 0.7);
      prism(black, x, z, y + 1.39, y + 2.6, 0.42, 0.22, 8);
      prism(black, x, z, y + 2.6, y + 4.9, 0.11, 0.09, 8, false);
      for (const [a, c] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const lx = x + (tx * a - tz * c) * 0.55, lz = z + (tz * a + tx * c) * 0.55;
        beam(black, [x, y + 3.9, z], [lx, y + 4.05, lz], 0.06, 0.08);
        prism(paint(B.lamp, C.white), lx, lz, y + 4.05, y + 4.6, 0.14, 0.19, 6, false);
        prism(black, lx, lz, y + 4.6, y + 4.8, 0.23, 0.04, 6);
      }
      prism(paint(B.lamp, C.white), x, z, y + 4.9, y + 5.55, 0.17, 0.23, 6, false);
      prism(black, x, z, y + 5.55, y + 5.8, 0.28, 0.06, 6);
    }
  }
  // the four obelisks
  for (const s of [0.6, L - 0.6]) for (const sign of [-1, 1]) pylon(k, s, sign, s < L / 2 ? -1 : 1);
}

// One of María Kristina's 18 m pylons, straddling the pavement at an end of the bridge (outward: -1 at s = 0)
function pylon(k, s, sign, outward) {
  const { B, P, fr, top, half } = k;
  const [, , tx, tz] = fr.at(s);
  const nx = -tz, nz = tx;
  const c = P(s, sign * (half(s) - 2.4), 0), y = top(s);
  const at = (a, b) => [c[0] + tx * a + nx * b, c[2] + tz * a + nz * b]; // local: a along the deck, b across it
  const cream = paint(B.masonry, C.cream), grey = paint(B.masonry, C.baseGrey, 0.9), pink = paint(B.masonry, C.pink);
  const H = 3.1; // half the footprint
  for (const [ca, cb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [bx, bz] = at(ca * 2.35, cb * 2.35);
    box(grey, bx, y + 0.95, bz, 0.78, 0.78, 0.95, tx, tz);
    box(grey, bx, y + 0.1, bz, 0.86, 0.86, 0.1, tx, tz);
    for (const [da, db] of [[2.78, 2.78], [2.78, 1.95], [1.95, 2.78]]) {
      const [x, z] = at(ca * da, cb * db);
      prism(pink, x, z, y + 1.9, y + 2.12, 0.36, 0.33, 10);
      prism(pink, x, z, y + 2.12, y + 4.0, 0.27, 0.245, 10, false);
      prism(paint(B.bronze, C.bronze), x, z, y + 4.0, y + 4.55, 0.25, 0.42, 8);
    }
    box(cream, bx, y + 4.72, bz, 0.82, 0.82, 0.17, tx, tz);
    box(cream, bx, y + 6.75, bz, 0.78, 0.78, 1.85, tx, tz);
    box(cream, bx, y + 8.72, bz, 0.9, 0.9, 0.12, tx, tz);
    // a scrolled console leaning out of each corner, a lantern on a post above it
    const [sx, sz] = at(ca * 2.65, cb * 2.65), [ex, ez] = at(ca * 3.3, cb * 3.3), [lx, lz] = at(ca * 2.75, cb * 2.75);
    beam(cream, [sx, y + 6.2, sz], [ex, y + 8.5, ez], 0.42, 0.5);
    const iron = paint(B.metal, C.black);
    prism(iron, lx, lz, y + 8.84, y + 9.75, 0.07, 0.05, 6, false);
    prism(paint(B.lamp, C.white), lx, lz, y + 9.75, y + 10.2, 0.13, 0.17, 6, false);
    prism(iron, lx, lz, y + 10.2, y + 10.4, 0.2, 0.02, 6);
  }
  // the four faces between the corners: walls over an elliptical opening, crowned by a curved pediment, an oculus
  // between the two
  const ARCH = 10, w = 1.57, spring = y + 4.9, rise = 1.5;
  const ped = (u) => y + 8.6 + 1.25 * Math.sqrt(Math.max(0, 1 - (u / w) ** 2));
  const dark = paint(B.masonry, C.creamDark);
  for (let side = 0; side < 4; side++) {
    // side 0/2: faces across the deck (normal along it), 1/3: along it
    const along = side % 2 === 0, e = side < 2 ? 1 : -1;
    const pt = (u, v, yy) => {
      const [x, z] = along ? at(e * v, u) : at(u, e * v);
      return [x, yy, z];
    };
    const nrm = along ? [tx * e, 0, tz * e] : [nx * e, 0, nz * e];
    const arch = (u) => spring + rise * Math.sqrt(Math.max(0, 1 - (u / w) ** 2));
    for (let q = 0; q < ARCH; q++) {
      const u0 = -w + (2 * w * q) / ARCH, u1 = -w + (2 * w * (q + 1)) / ARCH;
      face(cream, [pt(u0, H, arch(u0)), pt(u1, H, arch(u1)), pt(u1, H, ped(u1)), pt(u0, H, ped(u0))], nrm);
      face(cream, [pt(u0, H - 0.55, arch(u0)), pt(u1, H - 0.55, arch(u1)), pt(u1, H - 0.55, ped(u1)), pt(u0, H - 0.55, ped(u0))], nrm.map((v) => -v));
      face(dark, [pt(u0, H, arch(u0)), pt(u1, H, arch(u1)), pt(u1, H - 0.55, arch(u1)), pt(u0, H - 0.55, arch(u0))], [0, -1, 0]);
      // the pediment's moulded coping, a little proud of the face
      face(cream, [pt(u0, H + 0.12, ped(u0)), pt(u1, H + 0.12, ped(u1)), pt(u1, H - 0.6, ped(u1)), pt(u0, H - 0.6, ped(u0))], [0, 1, 0]);
      face(cream, [pt(u0, H + 0.12, ped(u0) - 0.22), pt(u1, H + 0.12, ped(u1) - 0.22), pt(u1, H + 0.12, ped(u1)), pt(u0, H + 0.12, ped(u0))], nrm);
    }
    const oy = y + 7.45, [ox, , oz] = pt(0, H + 0.05, 0);
    for (let q = 0; q < 12; q++) {
      const rim = (a) => {
        const u = Math.cos(a) * 0.6;
        const [x, z] = along ? at(e * (H + 0.05), u) : at(u, e * (H + 0.05));
        return [x, oy + Math.sin(a) * 0.6, z];
      };
      face(dark, [rim((TAU * q) / 12), rim((TAU * (q + 1)) / 12), [ox, oy, oz]], nrm);
    }
  }
  // ceiling over the passage; the attic rising from behind the pediments, the arms & crown on its road faces
  box(dark, c[0], spring + rise + 0.05, c[2], 1.6, 1.6, 0.05, tx, tz, true);
  box(cream, c[0], y + 9.7, c[2], 1.55, 1.55, 1.1, tx, tz);
  box(cream, c[0], y + 10.92, c[2], 1.75, 1.75, 0.12, tx, tz);
  for (const e of [-1, 1]) {
    const [ax, az] = at(e * 1.6, 0);
    box(paint(B.metal, C.shield), ax, y + 10.05, az, 0.06, 0.38, 0.46, tx, tz);
    box(paint(B.bronze, C.gold), ax + tx * e * 0.05, y + 10.62, az + tz * e * 0.05, 0.1, 0.34, 0.16, tx, tz);
  }
  // the tower and the gilded group: a rider on a rearing horse, facing out of the bridge
  const turn = Math.atan2(tz, tx) + Math.PI / 4;
  prism(cream, c[0], c[2], y + 11.04, y + 14.75, 1.7, 1.38, 4, false, turn);
  box(cream, c[0], y + 14.92, c[2], 1.18, 1.18, 0.17, tx, tz);
  const gold = paint(B.bronze, C.gold);
  box(gold, c[0], y + 15.27, c[2], 0.75, 0.55, 0.18, tx, tz);
  const g = (a, b, h) => [c[0] + tx * a * outward + nx * b, y + 15.45 + h, c[2] + tz * a * outward + nz * b];
  beam(gold, g(-0.6, 0, 0.75), g(0.35, 0, 1.5), 0.55, 0.62); // body, rearing
  beam(gold, g(0.3, 0, 1.45), g(0.55, 0, 2.25), 0.3, 0.42); // neck & head
  for (const b of [-0.16, 0.16]) {
    beam(gold, g(-0.55, b, 0.6), g(-0.35, b, 0), 0.13, 0.13); // hind legs
    beam(gold, g(0.35, b, 1.3), g(0.75, b, 1.05), 0.11, 0.11); // forelegs, raised
  }
  beam(gold, g(-0.75, 0, 0.75), g(-0.95, 0, 0.1), 0.1, 0.18); // tail
  beam(gold, g(-0.1, 0, 1.25), g(-0.05, 0, 2.15), 0.34, 0.3); // rider
  beam(gold, g(-0.05, 0.12, 1.95), g(0.3, 0.25, 2.65), 0.09, 0.09); // raised arm
}

// Zurriola: straight spans, round pier heads carrying the lamp columns, green railings & posts
function zurriola(k) {
  const { B, supports, half, top, PK, P, fr, boxAt } = k;
  const fascia = paint(B.masonry, C.fascia), granite = paint(B.masonry, C.granite, 1.1);
  const D = 1.8; // deck depth: a third of the columns' height above it in the photos
  const depth = () => D;
  slab(k, fascia, depth, { up: 0.32, inset: 0.45, soffit: paint(B.concrete, C.concrete) });
  cornice(k, fascia, -0.42, -0.1, 0.22);
  bankSeats(k, granite, (s) => top(s) - D);
  const pw = k.br.pier || 3;
  const r = pw / 2 + 0.05;
  for (const p of supports.slice(1, -1)) {
    const yTop = top(p) - D;
    roundPier(k, granite, p, half(p), pw, yTop);
    // the heads: cylinders bulging out of the deck's faces, a plinth at the waterline and a moulded ring under the
    // cornice; a square pedestal on top, its inner face in line with the railing, and the lamp column
    for (const sign of [-1, 1]) {
      const o = sign * (half(p) + 0.68);
      const [x, , z] = PK(p, o, 0), [, , tx, tz] = fr.at(p);
      const bed = k.bedAt(p - k.skew * o, o) - 0.6;
      prism(granite, x, z, bed, 1.4, r + 0.28, r + 0.28, 16, true);
      prism(granite, x, z, 1.4, top(p) - 0.5, r, r, 16, false);
      prism(paint(B.masonry, C.fascia), x, z, top(p) - 0.5, top(p) - 0.1, r + 0.16, r + 0.16, 16, true);
      box(paint(B.masonry, C.fascia, 0.9), x, top(p) + 0.525, z, 0.9, 0.9, 0.625, tx, tz);
      lampColumn(k, x, top(p) + 1.15, z, tx, tz);
    }
  }
  railing(k, C.green, { inset: 0.22, base: 0.32, height: 1.0, post: 2.4, bars: 0.22 });
  for (let q = 0; q < supports.length - 1; q++) {
    const s = (supports[q] + supports[q + 1]) / 2;
    for (const sign of [-1, 1]) {
      const [x, , z] = P(s, sign * (half(s) - 0.22), 0), [, , tx, tz] = fr.at(s);
      boxAt(paint(B.masonry, C.fascia), s, sign * (half(s) - 0.22), top(s), 0.35, 0.35, 0.55);
      greenPost(k, x, top(s) + 0.55, z, tx, tz);
    }
  }
}

// Víctor Arana's lamp column (photos): a moulded green cast-iron base with four scrolled buttresses up a quarter of
// the height, a tapering white shaft, a deep ribbed green capital band, a short white neck strapped in green, a leafy
// green crown and a big faceted glass globe; ~7.8 m in all
function lampColumn(k, x, y, z, tx, tz) {
  const { B } = k;
  const g = paint(B.metal, C.green), white = paint(B.masonry, C.white);
  prism(g, x, z, y, y + 0.25, 0.86, 0.82, 12);
  prism(g, x, z, y + 0.25, y + 1.2, 0.7, 0.62, 12);
  for (let q = 0; q < 4; q++) {
    const a = Math.atan2(tz, tx) + Math.PI / 4 + (q * Math.PI) / 2, ca = Math.cos(a), sa = Math.sin(a);
    beam(g, [x + ca * 0.72, y + 1.1, z + sa * 0.72], [x + ca * 0.52, y + 2.1, z + sa * 0.52], 0.16, 0.22);
  }
  prism(white, x, z, y + 1.2, y + 4.7, 0.52, 0.42, 16, false);
  prism(g, x, z, y + 4.7, y + 4.85, 0.5, 0.5, 16, false);
  prism(g, x, z, y + 4.85, y + 5.45, 0.52, 0.52, 16, false);
  prism(g, x, z, y + 5.45, y + 5.6, 0.5, 0.42, 16, false);
  prism(white, x, z, y + 5.6, y + 6.1, 0.38, 0.38, 16, false);
  prism(g, x, z, y + 6.1, y + 6.55, 0.42, 0.6, 16);
  ball(paint(B.lamp, C.white), x, y + 7.15, z, 0.66, 12);
}

// Girders: a deck slab cantilevered off a box of varying depth, bank seats and piers at the supports
function girder(k) {
  const { B, br, supports, half, top, P, S, strip, right, L } = k;
  const tone = br.tone === 'light' ? C.lightSteel : br.tone === 'steel' ? C.steel : C.concrete;
  const steel = paint(B.concrete, tone), deckSlab = paint(B.concrete, C.concrete);
  const samples = br.depth || [[supports[0], 1.6], [supports[supports.length - 1], 1.6]];
  const depth = (s) => Math.max(0.45, eased(samples, s));
  slab(k, deckSlab, () => 0.4, { up: 0.25, inset: 0.35 });
  // the box: its webs well inside the edges of a road deck, nearly under the edges of a footbridge's; its bottom flange
  const narrow = half(L / 2) < 4;
  const bw = (s) => Math.max(0.5, narrow ? half(s) - 0.45 : Math.min(half(s) * 0.62, half(s) - 1.0));
  for (const sign of [-1, 1]) {
    strip(steel, S, (s) => P(s, sign * bw(s), top(s) - depth(s)), (s) => P(s, sign * bw(s), top(s) - 0.4), right(sign));
  }
  strip(steel, S, (s) => P(s, -bw(s), top(s) - depth(s)), (s) => P(s, bw(s), top(s) - depth(s)), [0, -1, 0]);
  // bank seats under the end supports, piers under the others
  const conc = paint(B.concrete, C.concrete);
  bankSeats(k, conc, (s) => top(s) - depth(s));
  for (const s of supports.slice(1, -1)) {
    const dry = !br.water || s < br.water[0] || s > br.water[1]; // on a sloping bank: well into the ground
    roundPier(k, conc, s, Math.max(1.2, bw(s) + 0.3), br.pier || 2.2, top(s) - depth(s), dry ? 1.8 : 0.6);
  }
  const foot = br.bands.every((band) => band[2] === 1 || band[2] === 3 || band[2] === 5);
  railing(k, foot ? C.steel : C.modern, { inset: 0.12, base: 0.25, height: 1.1, post: 1.6 });
  if (!foot) for (let s = 6; s < L - 3; s += 24) for (const sign of [-1, 1]) modernLamp(k, s, sign, top(s) + 0.25);
}

// Modern concrete girders on piers (Real Sociedad) and the viaducts: slab, rounded piers, railing or barrier
function concreteSlab(k, { depth = 1.5, barrier = false } = {}) {
  const { B, br, half, top, L } = k;
  const conc = paint(B.concrete, C.concrete);
  slab(k, conc, () => depth, { up: barrier ? 0.95 : 0.3, inset: barrier ? 0.5 : 0.4 });
  bankSeats(k, conc, (s) => top(s) - depth);
  for (const p of br.piers) {
    const hl = Math.max(0.6, Math.min(half(p) - 1.2, br.style === 'viaduct' ? 3 : half(p)));
    roundPier(k, conc, p, hl, br.pier || 2.2, top(p) - depth);
  }
  if (!barrier) {
    railing(k, C.modern, { inset: 0.18, base: 0.3, height: 1.05, post: 1.8 });
    for (let s = 8; s < L - 3; s += 26) for (const sign of [-1, 1]) modernLamp(k, s, sign, top(s) + 0.3);
  }
}

// The railway bridge: a slab on steel plate girders with stiffeners, masts for the catenary
function railGirder(k) {
  const { B, br, half, top, P, S, strip, right, L, fr } = k;
  const plate = paint(B.concrete, C.plate), conc = paint(B.concrete, C.concrete);
  slab(k, conc, () => 0.45, { up: 0.15, inset: 0.3 });
  const gd = 2.3;
  for (const sign of [-1, 1]) {
    const o = (s) => sign * (half(s) - 0.7);
    for (const e of [-1, 1]) strip(plate, S, (s) => P(s, o(s) + e * 0.25, top(s) - gd), (s) => P(s, o(s) + e * 0.25, top(s) - 0.45), right(e));
    strip(plate, S, (s) => P(s, o(s) - 0.25, top(s) - gd), (s) => P(s, o(s) + 0.25, top(s) - gd), [0, -1, 0]);
    for (let s = 1; s < L - 0.5; s += 1.8) {
      const [x, , z] = P(s, o(s) + sign * 0.3, 0), [, , tx, tz] = fr.at(s);
      box(plate, x, top(s) - (gd + 0.45) / 2, z, 0.03, 0.06, (gd - 0.45) / 2, tx, tz);
    }
  }
  const stone = paint(B.masonry, C.sandstone, 1.0);
  bankSeats(k, stone, (s) => top(s) - gd);
  for (const p of br.piers) roundPier(k, stone, p, half(p) + 0.4, br.pier || 2.4, top(p) - gd);
  railing(k, C.steel, { inset: 0.1, base: 0.15, height: 1.0, post: 1.5 });
  const steel = paint(B.metal, C.steel);
  let side = 1;
  for (let s = 4; s < L - 2; s += 26, side = -side) {
    const [x, , z] = P(s, side * (half(s) + 0.35), 0), [hx, , hz] = P(s, -side * 1.6, 0), y = top(s);
    box(steel, x, y + 3.6, z, 0.16, 0.16, 3.6, fr.at(s)[2], fr.at(s)[3]);
    beam(steel, [x, y + 6.4, z], [hx, y + 6.2, hz], 0.1, 0.12);
  }
}

// A lift tower where a footbridge ends at one: glazed shaft on a steel frame, roof slab. Two footbridges may share a
// lift (one landing each): the towers are collected first and built once, as tall as the highest landing.
function liftTower(k, [x, z, ground, end]) {
  const { top, fr, L, B } = k;
  const s = end ? L : 0;
  const [, , tx, tz] = fr.at(s);
  const key = `${Math.round(x)},${Math.round(z)}`, yt = top(s) + 2.8;
  const t = B.lifts.get(key);
  if (!t || t.yt < yt) B.lifts.set(key, { x, z, ground, yt, tx, tz });
}
function buildLifts(B) {
  for (const { x, z, ground, yt, tx, tz } of B.lifts.values()) {
    box(paint(B.metal, C.glass), x, (ground + yt) / 2, z, 1.25, 1.25, (yt - ground) / 2, tx, tz);
    for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      box(paint(B.metal, C.steel), x + tx * a * 1.3 - tz * c * 1.3, (ground + yt) / 2, z + tz * a * 1.3 + tx * c * 1.3, 0.08, 0.08, (yt - ground) / 2, tx, tz);
    }
    box(paint(B.concrete, C.concrete), x, yt + 0.15, z, 1.55, 1.55, 0.15, tx, tz, true);
  }
}

function footbridge(k) {
  const { B, br, top } = k;
  const conc = paint(B.concrete, C.steel);
  slab(k, conc, () => 0.6, { up: 0.12, inset: 0.15 });
  for (const p of br.piers) roundPier(k, paint(B.concrete, C.concrete), p, 0.6, 0.9, top(p) - 0.6);
  railing(k, C.railing, { inset: 0.1, base: 0.12, height: 1.1, post: 1.5 });
  for (const lift of br.lift || []) liftTower(k, lift);
}

// Stone arches with an iron railing on a low parapet (Urdintzu)
function stoneArches(k) {
  const { B } = k;
  const stone = paint(B.masonry, C.sandstone, 0.95);
  arches(k, {
    spandrel: stone, ring: paint(B.masonry, C.sandstone, 0.6), pier: stone, soffit: stone, spring: 0.4, crown: 0.75,
    shape: 'segment', ringDepth: 0.6, ringProud: 0.08, pw: k.br.pier || 3, cutwater: 'point', cutTop: 1.8, wallTop: 0.45
  });
  solidParapet(k, stone, paint(B.masonry, C.skGrey), 0.45);
  railing(k, C.railing, { inset: 0.25, base: 0.61, height: 0.6, post: 2.0 });
}

function buildBridge(br, heightAt, B, index) {
  const k = kit(br, heightAt, B, index);
  if (k.L < 2) return null;
  deckTop(k);
  switch (br.style) {
    case 'katalina': katalina(k); break;
    case 'mariakristina': mariaKristina(k); break;
    case 'zurriola': zurriola(k); break;
    case 'stone': stoneArches(k); break;
    case 'girder': girder(k); break;
    case 'railgirder': railGirder(k); break;
    case 'footbridge': footbridge(k); break;
    case 'viaduct': concreteSlab(k, { depth: 1.9, barrier: true }); break;
    default: concreteSlab(k, { depth: 1.5 });
  }
  return { name: br.name, style: br.style, fr: k.fr, top: k.top, half: k.half, L: k.L };
}

// Builds every bridge into per-material buckets. heightAt(x, z): terrain height. Plain arrays, no three.js.
export function buildBridgeGeometry(bridges, heightAt) {
  const B = { deck: bucket(), masonry: bucket(true), concrete: bucket(), metal: bucket(), bronze: bucket(), lamp: bucket() };
  Object.defineProperty(B, 'lifts', { value: new Map() }); // (not a bucket: kept out of Object.entries)
  const decks = [];
  bridges.forEach((br, q) => {
    const d = buildBridge(br, heightAt, B, q);
    if (d) decks.push(d);
  });
  buildLifts(B);
  return { buckets: B, decks };
}

// Deck height under (x, z) or null: the travel modes can stand on the bridges with this
export function deckHeight(decks, x, z) {
  let best = null;
  for (const d of decks) {
    const { pts, cum, L } = d.fr;
    for (let q = 1; q < pts.length; q++) {
      const ax = pts[q - 1][0], az = pts[q - 1][1], dx = pts[q][0] - ax, dz = pts[q][1] - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-9) continue;
      const t = ((x - ax) * dx + (z - az) * dz) / len2;
      if (t < 0 || t > 1) continue;
      const len = Math.sqrt(len2), off = ((x - ax) * -dz + (z - az) * dx) / len;
      const s = Math.min(L, cum[q - 1] + t * len);
      if (Math.abs(off) > d.half(s)) continue;
      const y = d.top(s);
      if (best === null || y > best) best = y;
    }
  }
  return best;
}

// --- three.js -----------------------------------------------------------------------------------------------------------

function toGeometry(b) {
  if (!b.idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(b.pos), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(b.nrm), 3));
  geo.setAttribute('aU', new THREE.BufferAttribute(new Float32Array(b.u), 1));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
  if (b.jnt) geo.setAttribute('aJoint', new THREE.BufferAttribute(new Float32Array(b.jnt), 1));
  const count = b.pos.length / 3;
  geo.setIndex(new THREE.BufferAttribute(count > 65535 ? new Uint32Array(b.idx) : new Uint16Array(b.idx), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

function createMaterials() {
  const hash = Fn(([q]) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453)));
  // tidal & spray staining: dark green-brown up to ~2.5 m above mean sea level
  const tideStain = (c) => {
    const wet = smoothstep(2.8, 0.3, positionWorld.y);
    return mix(c, c.mul(vec3(0.42, 0.47, 0.36)), wet);
  };
  // (colours come from the 'color' attribute directly: vertexColors would multiply them in a second time)
  const colour = attribute('color', 'vec3');
  const std = (opts) => new THREE.MeshStandardNodeMaterial({ metalness: 0, side: THREE.DoubleSide, ...opts });

  // Masonry: ashlar of `aJoint`-metre blocks in courses half as high, staggered by half a block, with anti-aliased
  // mortar joints that fade to their mean at distance (u = metres along the face, y = height); 0 = smooth render
  const masonry = std({ roughness: 0.86 });
  masonry.colorNode = Fn(() => {
    const block = attribute('aJoint', 'float');
    const jointed = step(0.05, block);
    const blk = max(block, 0.3), course = blk.mul(0.5);
    const u = attribute('aU', 'float'), y = positionWorld.y;
    const row = floor(y.div(course));
    const cu = u.add(fract(row.mul(0.5)).mul(blk)).div(blk), cy = y.div(course);
    const tone = hash(vec2(floor(cu), row)).sub(0.5).mul(0.2).mul(jointed).add(1.0);
    const grain = mx_noise_float(positionWorld.mul(0.9)).mul(0.06).add(1.0);
    const lineU = min(fract(cu), float(1.0).sub(fract(cu))), lineY = min(fract(cy), float(1.0).sub(fract(cy)));
    const aaU = fwidth(cu).max(0.0001), aaY = fwidth(cy).max(0.0001);
    const joint = float(0.03);
    const jU = smoothstep(joint.mul(2.0).add(aaU), joint.mul(2.0), lineU).mul(smoothstep(0.6, 0.2, aaU));
    const jY = smoothstep(joint.add(aaY), joint, lineY).mul(smoothstep(0.6, 0.2, aaY));
    const c = colour.mul(tone).mul(grain);
    return tideStain(mix(c, colour.mul(0.74), max(jU, jY).mul(jointed)));
  })();

  const concrete = std({ roughness: 0.84 });
  concrete.colorNode = Fn(() => {
    const p = positionWorld;
    const n = mx_noise_float(p.mul(0.12)).mul(0.08).add(mx_noise_float(p.mul(1.4)).mul(0.04)).add(1.0);
    return tideStain(colour.mul(n));
  })();

  // Deck: the band colours, or (red < 0) the Agirre bridge's tiles: 40 cm squares in eight colours
  const deck = std({ roughness: 0.84 });
  deck.colorNode = Fn(() => {
    const cell = floor(positionWorld.xz.div(0.4));
    const h = floor(hash(cell).mul(8.0)).div(8.0);
    const hue = vec3(0.5).add(cos(vec3(h, h, h).add(vec3(0.0, 0.33, 0.67)).mul(6.2832)).mul(0.3)).mul(0.62);
    const tile = mix(hue.mul(hue), vec3(0.17, 0.16, 0.15), 0.35); // glazed but weathered
    const edge = fract(positionWorld.xz.div(0.4));
    const grout = smoothstep(0.06, 0.03, min(min(edge.x, edge.y), min(float(1).sub(edge.x), float(1).sub(edge.y))));
    const tiles = mix(tile, vec3(0.3, 0.29, 0.27), grout);
    const plain = colour.mul(mx_noise_float(positionWorld.mul(0.7)).mul(0.07).add(1.0));
    return mix(plain, tiles, step(colour.x, -0.5));
  })();

  const metal = std({ roughness: 0.5, metalness: 0.25 });
  metal.colorNode = colour;
  // gilded groups shine, patinated ones stay dark
  const bronze = std({ roughness: 0.38, metalness: 0.7 });
  bronze.colorNode = colour.mul(mx_noise_float(positionWorld.mul(2.1)).mul(0.12).add(0.94));
  const lamp = std({ roughness: 0.3 });
  lamp.colorNode = vec3(0.82, 0.79, 0.7);
  // lanterns light up as the city's windows do (uInteriorGlow: 0.24 midday .. 1.55 night)
  lamp.emissiveNode = vec3(1.0, 0.74, 0.42).mul(smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow).mul(9.0));
  return { deck, masonry, concrete, metal, bronze, lamp };
}

export async function buildBridges(GEO, terrain) {
  if (!BRIDGES.length) return null;
  const { buckets, decks } = buildBridgeGeometry(BRIDGES, (x, z) => terrain.heightAt(x, z));
  const materials = createMaterials();
  const group = new THREE.Group();
  group.name = 'DonostiaBridges';
  for (const [key, b] of Object.entries(buckets)) {
    const geo = toGeometry(b);
    if (!geo) continue;
    const mesh = new THREE.Mesh(geo, materials[key]);
    mesh.name = `DonostiaBridges-${key}`;
    mesh.castShadow = key !== 'lamp';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  group.userData.deckAt = (x, z) => deckHeight(decks, x, z);
  return group;
}
