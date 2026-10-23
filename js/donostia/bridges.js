import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, attribute, positionWorld, mix, smoothstep, floor, fract, min, max, sin, dot, fwidth,
  mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { BRIDGES } from './data-bridges.js';

// js/donostia/bridges.js
// The bridges of the core (tools/donostia/bake-bridges.mjs -> data-bridges.js), built over the OpenStreetMap bridge
// ways at the road level of their ends: decks with their carriageways, pavements & bidegorris, parapets and piers down
// to the river bed or the ground. The Urumea's main bridges get their character, simplified:
//   Zurriola (Kursaal)  modern concrete deck with the four tall lamp sculptures at its ends
//   Santa Katalina      sandstone arches on piers with cutwaters, solid parapets and lamp posts
//   María Kristina      1905: white stone arches, balustrades, four obelisks topped by bronze sculptures, lanterns
//   Puente de Hierro    the railway's iron truss
//   footbridges         slim timber or paved decks on steel railings (Mikel Laboa, Gladys del Estal, …)
// One merged mesh per material (7 draw calls). userData.deckAt(x, z) gives the deck height under a point (or null) for
// the travel modes to come.

// --- styles -----------------------------------------------------------------------------------------------------------

const MSL = 0;
// slab: deck structure depth (0 = masonry arches), camber: rise at mid-span, pier: thickness along the deck (m)
const STYLES = {
  stone: { arches: true, spring: 2.3, crown: 1.1, pier: 3.4, camber: 0.45, mat: 'stone', parapet: 'solid', lamps: 'posts' },
  mariakristina: { arches: true, spring: 2.0, crown: 0.9, pier: 3.8, camber: 0.5, mat: 'white', parapet: 'balustrade', lamps: 'obelisks' },
  zurriola: { slab: 1.6, pier: 2.2, camber: 0.15, mat: 'concrete', parapet: 'railing', lamps: 'sculptures' },
  modern: { slab: 1.4, pier: 1.8, camber: 0.1, mat: 'concrete', parapet: 'railing' },
  viaduct: { slab: 1.9, pier: 2.2, camber: 0, mat: 'concrete', parapet: 'barrier' },
  truss: { slab: 1.1, pier: 2.6, camber: 0, mat: 'concrete', parapet: 'truss' },
  footbridge: { slab: 0.6, pier: 1.0, camber: 0.5, mat: 'concrete', parapet: 'railing' }
};

// Deck surface colours (linear RGB) by band surface: asphalt, paving, bidegorri, timber, ballast
const SURFACE_COLOURS = [[0.05, 0.05, 0.055], [0.33, 0.31, 0.28], [0.3, 0.06, 0.05], [0.2, 0.13, 0.075], [0.13, 0.115, 0.1]];
const RAILING = [0.035, 0.06, 0.045]; // dark green ironwork
const TRUSS = [0.12, 0.15, 0.14];
const RAIL = [0.25, 0.24, 0.23];
const CURB = 0.15; // m: pavements stand this far above the carriageway
const LIFT = 0.06; // m: decks ride this far above their road level so they don't z-fight the street where they land

// --- geometry buckets (plain arrays: this part runs in Node for tests) -------------------------------------------------

function bucket(coloured) {
  return { pos: [], nrm: [], u: [], col: coloured ? [] : null, idx: [] };
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(a) {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 1, 0];
}

// Flat-shaded polygon (3 or 4 corners). `hint` is roughly the outward direction: the corners are flipped to face it,
// so the normals are right whatever order the callers list the corners in.
function face(b, pts, hint, us = null, colour = null) {
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
    if (b.col) b.col.push(...(colour || [0.5, 0.5, 0.5]));
  }
  b.idx.push(base, base + 1, base + 2);
  if (pts.length === 4) b.idx.push(base, base + 2, base + 3);
}

// Axis-aligned-to-the-deck box: centre (x, y, z), half sizes along the deck (ha), across (hc), up (hu); tangent (tx, tz)
function box(b, x, y, z, ha, hc, hu, tx, tz, colour = null, bottom = false) {
  const nx = -tz, nz = tx;
  const P = (a, c, v) => [x + tx * a + nx * c, y + v, z + tz * a + nz * c];
  const faces = [
    [[P(ha, -hc, -hu), P(ha, hc, -hu), P(ha, hc, hu), P(ha, -hc, hu)], [tx, 0, tz]],
    [[P(-ha, -hc, -hu), P(-ha, hc, -hu), P(-ha, hc, hu), P(-ha, -hc, hu)], [-tx, 0, -tz]],
    [[P(-ha, hc, -hu), P(ha, hc, -hu), P(ha, hc, hu), P(-ha, hc, hu)], [nx, 0, nz]],
    [[P(-ha, -hc, -hu), P(ha, -hc, -hu), P(ha, -hc, hu), P(-ha, -hc, hu)], [-nx, 0, -nz]],
    [[P(-ha, -hc, hu), P(ha, -hc, hu), P(ha, hc, hu), P(-ha, hc, hu)], [0, 1, 0]]
  ];
  if (bottom) faces.push([[P(-ha, -hc, -hu), P(ha, -hc, -hu), P(ha, hc, -hu), P(-ha, hc, -hu)], [0, -1, 0]]);
  for (const [pts, hint] of faces) face(b, pts, hint, [0, 2 * ha, 2 * ha, 0], colour);
}

// Vertical prism of `sides` sides from y0 (radius r0) to y1 (radius r1), optionally capped on top; rot turns it
function prism(b, x, z, y0, y1, r0, r1, sides, colour = null, cap = true, rot = Math.PI / sides) {
  const ring = (r, y) => Array.from({ length: sides }, (_, k) => {
    const a = rot + (2 * Math.PI * k) / sides;
    return [x + r * Math.cos(a), y, z + r * Math.sin(a)];
  });
  const lo = ring(r0, y0), hi = ring(r1, y1);
  for (let k = 0; k < sides; k++) {
    const q = (k + 1) % sides, a = rot + (2 * Math.PI * (k + 0.5)) / sides;
    const arc = (2 * Math.PI * Math.max(r0, r1)) / sides;
    face(b, [lo[k], lo[q], hi[q], hi[k]], [Math.cos(a), 0, Math.sin(a)], [k * arc, (k + 1) * arc, (k + 1) * arc, k * arc], colour);
  }
  if (cap && r1 > 1e-3) {
    for (let k = 0; k < sides; k++) face(b, [hi[k], hi[(k + 1) % sides], [x, y1, z]], [0, 1, 0], null, colour);
  }
}

// Beam between two points with a square-ish section (w across, h up), for truss members & brackets
function beam(b, p, q, w, h, colour) {
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
    face(b, [off(p, a[0], a[1]), off(q, a[0], a[1]), off(q, c[0], c[1]), off(p, c[0], c[1])], n, [0, len, len, 0], colour);
  }
}

// --- one bridge ---------------------------------------------------------------------------------------------------------

function frameOf(br) {
  const pts = [];
  for (let k = 0; k < br.axis.length; k += 2) pts.push([br.axis[k], br.axis[k + 1]]);
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const L = cum[cum.length - 1];
  // position & a mitred unit tangent at arc length s
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
    if (t < 1e-4) blend(k - 1);
    else if (t > 1 - 1e-4) blend(k);
    return [ax + (bx - ax) * t, az + (bz - az) * t, tx, tz];
  };
  return { pts, cum, L, at };
}

// Arc lengths for the cross-sections: every axis vertex, every `step` metres and every extra break
function sections(fr, step, extra = []) {
  const s = new Set([0, fr.L, ...fr.cum, ...extra.filter((v) => v > 0 && v < fr.L)]);
  for (let v = step; v < fr.L; v += step) s.add(v);
  return [...s].map((v) => Math.round(v * 1000) / 1000).sort((a, b) => a - b).filter((v, k, arr) => k === 0 || v - arr[k - 1] > 0.01);
}

function buildBridge(br, heightAt, B, index) {
  const style = STYLES[br.style] || STYLES.modern;
  const fr = frameOf(br);
  const L = fr.L, W = br.width, half = W / 2;
  if (L < 2 || W < 0.5) return null;
  const [y0, y1] = br.y;
  const camber = br.style === 'footbridge' && L < 40 ? 0 : style.camber || 0;
  const top = (s) => LIFT + y0 + ((y1 - y0) * s) / L + camber * Math.sin((Math.PI * s) / L);
  const P = (s, o, y) => {
    const [x, z, tx, tz] = fr.at(s);
    return [x - tz * o, y, z + tx * o];
  };
  const uOff = (index * 37.3) % 50; // so neighbouring bridges don't share their stone joints
  const mat = B[style.mat];
  const piers = br.piers;
  const pw = style.pier;

  // Strip along the deck between two edge functions of s, flat-shaded per segment
  const strip = (b, S, edgeA, edgeB, hint, colour = null) => {
    for (let k = 1; k < S.length; k++) {
      const a0 = edgeA(S[k - 1]), a1 = edgeA(S[k]), b0 = edgeB(S[k - 1]), b1 = edgeB(S[k]);
      const [, , tx, tz] = fr.at((S[k - 1] + S[k]) / 2);
      face(b, [a0, a1, b1, b0], typeof hint === 'function' ? hint(tx, tz) : hint,
        [S[k - 1] + uOff, S[k] + uOff, S[k] + uOff, S[k - 1] + uOff], colour);
    }
  };
  const right = (sign) => (tx, tz) => [-tz * sign, 0, tx * sign];
  const S = sections(fr, style.arches ? 1.5 : 4, piers.flatMap((p) => [p - pw / 2, p + pw / 2]));

  // --- deck top: surface bands, pavements raised behind a kerb
  const hasRoad = br.bands.some((band) => band[2] === 0);
  const raise = (surface) => (hasRoad && surface !== 0 && surface !== 4 ? CURB : 0);
  br.bands.forEach(([a, b, surface], k) => {
    const lift = raise(surface) + (surface === 4 ? 0.12 : 0);
    strip(B.deck, S, (s) => P(s, a, top(s) + lift), (s) => P(s, b, top(s) + lift), [0, 1, 0], SURFACE_COLOURS[surface]);
    const next = br.bands[k + 1];
    if (next && raise(next[2]) !== raise(surface)) {
      const lo = Math.min(raise(next[2]), raise(surface)), hi = Math.max(raise(next[2]), raise(surface));
      const sign = raise(surface) > raise(next[2]) ? 1 : -1; // the kerb faces the lower side
      strip(B.deck, S, (s) => P(s, b, top(s) + lo), (s) => P(s, b, top(s) + hi), right(sign), SURFACE_COLOURS[1]);
    }
    if (surface === 4) { // rails: Iberian gauge, one pair per ~4.4 m of track bed
      const tracks = Math.max(1, Math.round((b - a) / 4.4));
      for (let t = 0; t < tracks; t++) {
        const c = a + ((b - a) * (t + 0.5)) / tracks;
        for (const g of [-0.834, 0.834]) {
          const o = c + g;
          strip(B.steel, S, (s) => P(s, o - 0.035, top(s) + lift + 0.17), (s) => P(s, o + 0.035, top(s) + lift + 0.17), [0, 1, 0], RAIL);
          strip(B.steel, S, (s) => P(s, o - 0.035, top(s) + lift), (s) => P(s, o - 0.035, top(s) + lift + 0.17), right(-1), RAIL);
          strip(B.steel, S, (s) => P(s, o + 0.035, top(s) + lift), (s) => P(s, o + 0.035, top(s) + lift + 0.17), right(1), RAIL);
        }
      }
    }
  });

  // --- structure under the deck
  const bedAt = (s, o) => {
    const [x, , z] = P(s, o, 0);
    return heightAt(x, z);
  };
  if (style.arches) {
    // masonry: spandrel walls on both faces down to the arches, arch rings & soffits, piers with cutwaters
    const supports = [0, ...piers, L];
    const spans = [];
    for (let k = 1; k < supports.length; k++) {
      const sa = k === 1 ? supports[0] : supports[k - 1] + pw / 2, sb = k === supports.length - 1 ? supports[k] : supports[k] - pw / 2;
      if (sb - sa < 2) continue;
      const mid = (sa + sb) / 2, c = (sb - sa) / 2;
      const ys = MSL + style.spring, yc = Math.max(ys + 1, top(mid) - style.crown), r = yc - ys;
      const R = (c * c + r * r) / (2 * r), cy = yc - R;
      spans.push({ sa, sb, arch: (s) => cy + Math.sqrt(Math.max(0, R * R - (s - mid) ** 2)), ys });
    }
    const spring = MSL + style.spring;
    const intrados = (s) => {
      for (const sp of spans) if (s >= sp.sa - 1e-6 && s <= sp.sb + 1e-6) return sp.arch(s);
      return spring;
    };
    const SA = sections(fr, 1, spans.flatMap((sp) => [sp.sa, sp.sb]));
    const wallTop = style.parapet === 'solid' ? 1.05 : 0.3;
    for (const sign of [-1, 1]) {
      strip(mat, SA, (s) => P(s, sign * half, intrados(s)), (s) => P(s, sign * half, top(s) + wallTop), right(sign));
      // string course just under the deck
      const ro = sign * (half + 0.16);
      strip(mat, S, (s) => P(s, ro, top(s) - 0.42), (s) => P(s, ro, top(s) - 0.12), right(sign));
      strip(mat, S, (s) => P(s, sign * half, top(s) - 0.42), (s) => P(s, ro, top(s) - 0.42), [0, -1, 0]);
      strip(mat, S, (s) => P(s, sign * half, top(s) - 0.12), (s) => P(s, ro, top(s) - 0.12), [0, 1, 0]);
    }
    for (const sp of spans) {
      const SS = sections(fr, 1, [sp.sa, sp.sb]).filter((s) => s >= sp.sa - 1e-6 && s <= sp.sb + 1e-6);
      const ring = half + 0.12;
      // soffit (facing down into the arch), then the voussoir rings standing proud of both faces
      strip(mat, SS, (s) => P(s, -ring, sp.arch(s)), (s) => P(s, ring, sp.arch(s)), [0, -1, 0]);
      for (const sign of [-1, 1]) {
        strip(mat, SS, (s) => P(s, sign * ring, sp.arch(s)), (s) => P(s, sign * ring, sp.arch(s) + 0.85), right(sign));
        strip(mat, SS, (s) => P(s, sign * half, sp.arch(s) + 0.85), (s) => P(s, sign * ring, sp.arch(s) + 0.85), [0, 1, 0]);
      }
    }
    for (const p of piers) {
      const bed = Math.min(bedAt(p, -half), bedAt(p, 0), bedAt(p, half)) - 0.6;
      // the pier's faces under the arches, then a pointed cutwater against the current on each side
      for (const e of [-1, 1]) {
        const s = p + (e * pw) / 2;
        const [, , tx, tz] = fr.at(s);
        face(mat, [P(s, -half, bed), P(s, half, bed), P(s, half, spring), P(s, -half, spring)], [tx * e, 0, tz * e], [-half, half, half, -half]);
      }
      for (const sign of [-1, 1]) {
        const a = P(p - pw / 2, sign * half, 0), c = P(p + pw / 2, sign * half, 0), tip = P(p, sign * (half + pw * 0.75), 0);
        const at = (pt, y) => [pt[0], y, pt[2]];
        const capY = spring + 0.6;
        const [, , tx, tz] = fr.at(p);
        const out = [-tz * sign, 0, tx * sign];
        face(mat, [at(a, bed), at(tip, bed), at(tip, capY), at(a, capY)], [out[0] - tx, 0, out[2] - tz], [0, 2, 2, 0]);
        face(mat, [at(tip, bed), at(c, bed), at(c, capY), at(tip, capY)], [out[0] + tx, 0, out[2] + tz], [0, 2, 2, 0]);
        const apex = P(p, sign * half, capY + 1.6);
        face(mat, [at(a, capY), at(tip, capY), apex], [out[0] - tx, 1, out[2] - tz]);
        face(mat, [at(tip, capY), at(c, capY), apex], [out[0] + tx, 1, out[2] + tz]);
      }
    }
  } else {
    // slab: two faces, the soffit, kerb-height upstands for the railings, end caps
    const depth = style.slab;
    const up = style.parapet === 'barrier' ? 0.95 : style.parapet === 'railing' ? 0.3 : 0.25;
    for (const sign of [-1, 1]) {
      strip(B.concrete, S, (s) => P(s, sign * half, top(s) - depth), (s) => P(s, sign * half, top(s) + up), right(sign));
      const inner = sign * (half - (style.parapet === 'barrier' ? 0.5 : 0.4));
      strip(B.concrete, S, (s) => P(s, inner, top(s) + up), (s) => P(s, sign * half, top(s) + up), [0, 1, 0]);
      strip(B.concrete, S, (s) => P(s, inner, top(s)), (s) => P(s, inner, top(s) + up), right(-sign));
    }
    strip(B.concrete, S, (s) => P(s, -half, top(s) - depth), (s) => P(s, half, top(s) - depth), [0, -1, 0]);
    for (const [s, e] of [[0, -1], [L, 1]]) {
      const [, , tx, tz] = fr.at(s);
      face(B.concrete, [P(s, -half, top(s) - depth), P(s, half, top(s) - depth), P(s, half, top(s)), P(s, -half, top(s))], [tx * e, 0, tz * e]);
    }
    // piers: rounded walls under the deck, narrower than it, from the bed (or the ground) up
    for (const p of piers) {
      const hl = Math.max(0.6, Math.min(half - 1.2, br.style === 'viaduct' ? 3 : half));
      const bed = Math.min(bedAt(p, -hl), bedAt(p, 0), bedAt(p, hl)) - 0.6;
      const yTop = top(p) - depth;
      if (yTop - bed < 0.5) continue;
      const r = pw / 2, n = 6;
      const outline = [];
      for (let k = 0; k <= n; k++) { const a = -Math.PI / 2 + (Math.PI * k) / n; outline.push([r * Math.sin(a), hl - r + r * Math.cos(a)]); }
      for (let k = 0; k <= n; k++) { const a = Math.PI / 2 + (Math.PI * k) / n; outline.push([r * Math.sin(a), -(hl - r) + r * Math.cos(a)]); }
      for (let k = 0; k < outline.length; k++) {
        const [a0, c0] = outline[k], [a1, c1] = outline[(k + 1) % outline.length];
        const am = (a0 + a1) / 2, cm = (c0 + c1) / 2;
        const pa = P(p + a0, c0, 0), pb = P(p + a1, c1, 0), pm = P(p + am, cm, 0), pc = P(p, 0, 0);
        face(B.concrete, [[pa[0], bed, pa[2]], [pb[0], bed, pb[2]], [pb[0], yTop, pb[2]], [pa[0], yTop, pa[2]]],
          [pm[0] - pc[0], 0, pm[2] - pc[2]], [k, k + 1, k + 1, k]);
      }
    }
  }

  // --- parapets, railings & trusses
  const along = (s) => fr.at(s);
  if (style.parapet === 'solid') {
    for (const sign of [-1, 1]) {
      const inner = sign * (half - 0.45);
      strip(mat, S, (s) => P(s, inner, top(s)), (s) => P(s, inner, top(s) + 1.05), right(-sign));
      strip(mat, S, (s) => P(s, inner - sign * 0.05, top(s) + 1.05), (s) => P(s, sign * (half + 0.05), top(s) + 1.05), [0, 1, 0]);
    }
  } else if (style.parapet === 'balustrade') {
    for (const sign of [-1, 1]) {
      const inner = sign * (half - 0.5), mid = sign * (half - 0.25);
      strip(mat, S, (s) => P(s, inner, top(s)), (s) => P(s, inner, top(s) + 0.3), right(-sign));
      strip(mat, S, (s) => P(s, inner, top(s) + 0.3), (s) => P(s, sign * half, top(s) + 0.3), [0, 1, 0]);
      // hand rail
      const rail = [top, 0.92, 1.08];
      strip(mat, S, (s) => P(s, inner, rail[0](s) + rail[2]), (s) => P(s, sign * (half + 0.03), rail[0](s) + rail[2]), [0, 1, 0]);
      strip(mat, S, (s) => P(s, inner, rail[0](s) + rail[1]), (s) => P(s, sign * (half + 0.03), rail[0](s) + rail[1]), [0, -1, 0]);
      strip(mat, S, (s) => P(s, inner, rail[0](s) + rail[1]), (s) => P(s, inner, rail[0](s) + rail[2]), right(-sign));
      strip(mat, S, (s) => P(s, sign * (half + 0.03), rail[0](s) + rail[1]), (s) => P(s, sign * (half + 0.03), rail[0](s) + rail[2]), right(sign));
      // balusters between pedestals every 3.2 m
      for (let s = 0.4; s < L - 0.3; s += 0.31) {
        const [x, z, tx, tz] = along(s);
        const pedestal = (s % 3.2) < 0.45;
        const [cx, , cz] = [x - tz * mid, 0, z + tx * mid];
        if (pedestal) box(mat, cx, top(s) + 0.62, cz, 0.24, 0.26, 0.32, tx, tz);
        else box(mat, cx, top(s) + 0.61, cz, 0.065, 0.075, 0.31, tx, tz);
      }
    }
  } else if (style.parapet === 'railing') {
    for (const sign of [-1, 1]) {
      const o = sign * (half - 0.2), base = br.style === 'footbridge' ? 0.25 : 0.3;
      for (let s = 1; s < L - 0.5; s += 2) {
        const [x, z, tx, tz] = along(s);
        box(B.steel, x - tz * o, top(s) + base + 0.5, z + tx * o, 0.04, 0.04, 0.5, tx, tz, RAILING);
      }
      for (const [h, t] of [[1.04, 0.05], [0.55, 0.025]]) {
        const yb = (s) => top(s) + base + h;
        strip(B.steel, S, (s) => P(s, o - 0.05, yb(s) + t), (s) => P(s, o + 0.05, yb(s) + t), [0, 1, 0], RAILING);
        strip(B.steel, S, (s) => P(s, o - 0.05, yb(s) - t), (s) => P(s, o - 0.05, yb(s) + t), right(-sign), RAILING);
        strip(B.steel, S, (s) => P(s, o + 0.05, yb(s) - t), (s) => P(s, o + 0.05, yb(s) + t), right(sign), RAILING);
      }
    }
  } else if (style.parapet === 'truss') {
    // a through truss per span: chords along both edges, verticals & alternating diagonals every ~5 m, top bracing
    const supports = [0, ...piers, L];
    const hT = 5.2;
    for (let k = 1; k < supports.length; k++) {
      const sa = supports[k - 1] + 0.4, sb = supports[k] - 0.4, n = Math.max(2, Math.round((sb - sa) / 5));
      const node = (q, sign, h) => P(sa + ((sb - sa) * q) / n, sign * (half - 0.35), top(sa + ((sb - sa) * q) / n) + 0.4 + h);
      for (const sign of [-1, 1]) {
        for (let q = 0; q < n; q++) {
          beam(B.steel, node(q, sign, 0), node(q + 1, sign, 0), 0.45, 0.6, TRUSS);
          if (q > 0 && q < n - 1) beam(B.steel, node(q, sign, hT), node(q + 1, sign, hT), 0.45, 0.5, TRUSS);
          if (q > 0) beam(B.steel, node(q, sign, 0), node(q, sign, hT), 0.3, 0.3, TRUSS);
          // end posts slope down to the bearings; inner panels get diagonals leaning towards mid-span
          if (q === 0) beam(B.steel, node(0, sign, 0), node(1, sign, hT), 0.45, 0.45, TRUSS);
          else if (q === n - 1) beam(B.steel, node(n, sign, 0), node(n - 1, sign, hT), 0.45, 0.45, TRUSS);
          else if (q < n / 2) beam(B.steel, node(q, sign, hT), node(q + 1, sign, 0), 0.25, 0.25, TRUSS);
          else beam(B.steel, node(q, sign, 0), node(q + 1, sign, hT), 0.25, 0.25, TRUSS);
        }
      }
      for (let q = 1; q < n; q++) beam(B.steel, node(q, -1, hT), node(q, 1, hT), 0.25, 0.3, TRUSS);
    }
  }

  // --- lamps & monuments
  const lampPost = (s, o, h = 4.2) => {
    const [x, z, tx, tz] = along(s);
    const cx = x - tz * o, cz = z + tx * o, y = top(s) + raise(1);
    prism(B.steel, cx, cz, y, y + 0.5, 0.17, 0.12, 8, RAILING, false);
    prism(B.steel, cx, cz, y + 0.5, y + h, 0.07, 0.05, 6, RAILING, false);
    prism(B.lamp, cx, cz, y + h, y + h + 0.5, 0.17, 0.23, 6, null, false);
    prism(B.steel, cx, cz, y + h + 0.5, y + h + 0.75, 0.26, 0.02, 6, RAILING);
  };
  if (style.lamps === 'posts') {
    for (const p of [0, ...piers, L].map((s) => Math.min(L - 1.5, Math.max(1.5, s)))) {
      for (const sign of [-1, 1]) lampPost(p, sign * (half - 0.75));
    }
  } else if (style.lamps === 'obelisks') {
    for (const s of [2.6, L - 2.6]) {
      for (const sign of [-1, 1]) {
        const [x, z, tx, tz] = along(s), o = sign * (half - 0.6);
        const cx = x - tz * o, cz = z + tx * o, y = top(s);
        const turn = Math.atan2(tz, tx) + Math.PI / 4;
        box(mat, cx, y + 1.5, cz, 1.25, 1.25, 1.5, tx, tz, null, false); // pedestal
        box(mat, cx, y + 3.15, cz, 1.45, 1.45, 0.15, tx, tz); // cornice
        prism(mat, cx, cz, y + 3.3, y + 14.2, 0.85, 0.5, 4, null, false, turn);
        prism(mat, cx, cz, y + 14.2, y + 15.1, 0.5, 0.0, 4, null, false, turn);
        // the bronze group on top: a globe carrying a winged figure
        prism(B.bronze, cx, cz, y + 15.0, y + 15.6, 0.15, 0.55, 10, null, false);
        prism(B.bronze, cx, cz, y + 15.6, y + 16.2, 0.55, 0.15, 10, null, false);
        prism(B.bronze, cx, cz, y + 16.1, y + 17.9, 0.32, 0.12, 8);
        prism(B.bronze, cx, cz, y + 17.8, y + 18.25, 0.14, 0.0, 8);
        for (const w of [-1, 1]) {
          beam(B.bronze, [cx, y + 17.2, cz], [cx + -tz * w * 1.1 + tx * 0.25, y + 18.3, cz + tx * w * 1.1 + tz * 0.25], 0.08, 0.5);
        }
        // four lanterns on brackets round the pedestal
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const lx = cx + tx * a * 1.55 - tz * c * 1.55, lz = cz + tz * a * 1.55 + tx * c * 1.55;
          beam(B.steel, [cx + tx * a * 1.2 - tz * c * 1.2, y + 2.6, cz + tz * a * 1.2 + tx * c * 1.2], [lx, y + 3.0, lz], 0.08, 0.08, RAILING);
          prism(B.lamp, lx, lz, y + 3.0, y + 3.55, 0.16, 0.2, 6, null, false);
          prism(B.steel, lx, lz, y + 3.55, y + 3.8, 0.24, 0.02, 6, RAILING);
        }
      }
    }
    // cast-iron lamp posts along the balustrades
    for (let s = 12; s < L - 10; s += 15) for (const sign of [-1, 1]) lampPost(s, sign * (half - 0.8), 4.6);
  } else if (style.lamps === 'sculptures') {
    // the four tall lamp sculptures at the ends: a stepped plinth, a tapering octagonal shaft, three rings and a
    // lantern under a spire
    for (const s of [3, L - 3]) {
      for (const sign of [-1, 1]) {
        const [x, z, tx, tz] = along(s), o = sign * (half - 1.3);
        const cx = x - tz * o, cz = z + tx * o, y = top(s) + raise(1);
        box(B.concrete, cx, y + 0.45, cz, 1.0, 1.0, 0.45, tx, tz);
        box(B.concrete, cx, y + 1.15, cz, 0.75, 0.75, 0.25, tx, tz);
        prism(B.bronze, cx, cz, y + 1.4, y + 12.6, 0.5, 0.26, 8, null, false);
        for (const h of [10.0, 10.8, 11.6]) prism(B.bronze, cx, cz, h + y, h + y + 0.16, 0.78, 0.78, 8);
        prism(B.lamp, cx, cz, y + 12.6, y + 14.0, 0.42, 0.42, 8, null, false);
        prism(B.bronze, cx, cz, y + 14.0, y + 16.4, 0.5, 0.0, 8);
      }
    }
  }

  return { name: br.name, style: br.style, fr, top, half, L };
}

// Builds every bridge into per-material buckets. heightAt(x, z): terrain height. Plain arrays, no three.js.
export function buildBridgeGeometry(bridges, heightAt) {
  const B = {
    deck: bucket(true), concrete: bucket(false), stone: bucket(false), white: bucket(false), steel: bucket(true),
    bronze: bucket(false), lamp: bucket(false)
  };
  const decks = [];
  bridges.forEach((br, k) => {
    const d = buildBridge(br, heightAt, B, k);
    if (d) decks.push(d);
  });
  return { buckets: B, decks };
}

// Deck height under (x, z) or null: the travel modes can stand on the bridges with this
export function deckHeight(decks, x, z) {
  let best = null;
  for (const d of decks) {
    const { pts, cum, L } = d.fr;
    for (let k = 1; k < pts.length; k++) {
      const ax = pts[k - 1][0], az = pts[k - 1][1], dx = pts[k][0] - ax, dz = pts[k][1] - az;
      const len2 = dx * dx + dz * dz;
      if (len2 < 1e-9) continue;
      const t = ((x - ax) * dx + (z - az) * dz) / len2;
      if (t < 0 || t > 1) continue;
      const len = Math.sqrt(len2), off = ((x - ax) * -dz + (z - az) * dx) / len;
      if (Math.abs(off) > d.half) continue;
      const s = Math.min(L, cum[k - 1] + t * len), y = d.top(s);
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
  if (b.col) geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(b.col), 3));
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
  // Ashlar: courses `course` m high, blocks `block` m long staggered by half a block, anti-aliased mortar joints that
  // fade to their mean at distance (u = metres along the face, y = height)
  const ashlar = (base, block, course, joint, spread, mortar) => Fn(() => {
    const u = attribute('aU', 'float');
    const y = positionWorld.y;
    const row = floor(y.div(course));
    const shift = fract(row.mul(0.5)).mul(block);
    const cu = u.add(shift).div(block), cy = y.div(course);
    const col = floor(cu);
    const tone = hash(vec2(col, row)).sub(0.5).mul(spread).add(1.0);
    const grain = mx_noise_float(positionWorld.mul(0.9)).mul(0.06).add(1.0);
    const lineU = min(fract(cu), float(1.0).sub(fract(cu))), lineY = min(fract(cy), float(1.0).sub(fract(cy)));
    const aaU = fwidth(cu).max(0.0001), aaY = fwidth(cy).max(0.0001);
    const jU = smoothstep(joint.mul(2.0).add(aaU), joint.mul(2.0), lineU).mul(smoothstep(0.6, 0.2, aaU));
    const jY = smoothstep(joint.add(aaY), joint, lineY).mul(smoothstep(0.6, 0.2, aaY));
    const c = vec3(...base).mul(tone).mul(grain);
    return tideStain(mix(c, vec3(...mortar), max(jU, jY)));
  })();

  const std = (opts) => new THREE.MeshStandardNodeMaterial({ metalness: 0, side: THREE.DoubleSide, ...opts });
  const concrete = std({ roughness: 0.86 });
  concrete.colorNode = Fn(() => {
    const p = positionWorld;
    const n = mx_noise_float(p.mul(0.12)).mul(0.08).add(mx_noise_float(p.mul(1.4)).mul(0.04)).add(1.0);
    return tideStain(vec3(0.43, 0.42, 0.39).mul(n));
  })();
  const stone = std({ roughness: 0.88 });
  stone.colorNode = ashlar([0.42, 0.34, 0.24], 0.95, 0.48, float(0.035), 0.22, [0.3, 0.28, 0.25]);
  const white = std({ roughness: 0.8 });
  white.colorNode = ashlar([0.68, 0.66, 0.6], 1.3, 0.62, float(0.02), 0.08, [0.55, 0.54, 0.5]);
  // (colours come from the 'color' attribute directly: vertexColors would multiply them in a second time)
  const deck = std({ roughness: 0.84 });
  deck.colorNode = attribute('color', 'vec3').mul(mx_noise_float(positionWorld.mul(0.7)).mul(0.07).add(1.0));
  const steel = std({ roughness: 0.5, metalness: 0.25 });
  steel.colorNode = attribute('color', 'vec3');
  const bronze = std({ roughness: 0.42, metalness: 0.85 });
  bronze.colorNode = Fn(() => mix(vec3(0.26, 0.19, 0.1), vec3(0.17, 0.24, 0.19), mx_noise_float(positionWorld.mul(2.1)).mul(0.5).add(0.5)))();
  const lamp = std({ roughness: 0.3 });
  lamp.colorNode = vec3(0.85, 0.8, 0.68);
  // lanterns light up as the city's windows do (uInteriorGlow: 0.24 midday .. 1.55 night)
  lamp.emissiveNode = vec3(1.0, 0.74, 0.42).mul(smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow).mul(9.0));
  return { deck, concrete, stone, white, steel, bronze, lamp };
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
