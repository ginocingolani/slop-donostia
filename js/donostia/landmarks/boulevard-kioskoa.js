import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, floor, fract, abs, max, mix, smoothstep, step, sin, dot, clamp, length, select,
  fwidth, positionWorld, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { CentreModel, style, FK, FT } from './bretxa.js';

// js/donostia/landmarks/boulevard-kioskoa.js
// The Boulevard kiosko (Boulevardeko Kioskoa), the music bandstand in the middle of the Alameda del Boulevard. Not the
// octagon of the usual bandstand: the municipal 1:500 map draws its plinth as an ellipse about 12 x 7 m, the long axis
// across the promenade, with a narrow flight of steps at its northern tip. From the photos (Wikimedia Commons: Kent
// Wang, Unuaiga, Zarateman, Luistxo):
//  - a plinth ~1.3 m high: a pale grey stone base course and coping round a band of pink-mauve marble slabs, with a
//    cast-iron railing round the platform between the columns;
//  - twelve slender cast-iron columns painted sage green, with bell bases, foliage capitals and leafy brackets, carrying
//    a wide roof: a varnished honey timber soffit, a green iron fascia and a low pale zinc cone;
//  - two tiers of Modernista stained glass: a deep band hung from the roof between the columns, and a shallower one
//    round the lower timber ceiling on an inner ring of columns; each has a row of teal medallions holding a knotted
//    heart, a red-and-white checker, then opalescent glass with blue roundel strips and green iron tracery, a rosette
//    border, and ends in a swag between the columns;
//  - a wide flight of stone steps with iron handrails at the northern tip.
// The kiosk rises ~8.2 m (b5m); its stained glass glows at night.
//
// build(sites, ctx) receives the GEO.landmarks entries ['boulevard-kioskoa'] (footprint ring, at [x, z], buildings,
// height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates.

const COLUMNS = 12;
const H = {
  plinth: 1.3, // platform level
  ceiling: 4.85, // the inner ceiling, top of the lower glass band
  roof: 7.1, // the roof soffit at the column ring, top of the upper band
  fascia: 7.35,
  top: 8.2
};
// Glass bands: depth below their top at the columns and the extra sag of the swag between them (from the photos: the
// upper band ends ~4.8 m above the paving, the lower one ~3.8 m)
const UPPER = { top: H.roof, atColumn: 2.0, sag: 0.32 };
const LOWER = { top: H.ceiling, atColumn: 0.72, sag: 0.3 };

// Ellipse fitted to a polygon by its area moments: centre, major-axis angle and semi-axes (a filled ellipse of
// semi-axes a, b has ∫u² dA = A a² / 4)
function fitEllipse(ring) {
  let A = 0, cx = 0, cz = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[2 * i], z0 = ring[2 * i + 1], x1 = ring[2 * j], z1 = ring[2 * j + 1];
    const c = x0 * z1 - x1 * z0;
    A += c / 2;
    cx += ((x0 + x1) * c) / 6;
    cz += ((z0 + z1) * c) / 6;
  }
  cx /= A;
  cz /= A;
  let sxx = 0, szz = 0, sxz = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[2 * i] - cx, z0 = ring[2 * i + 1] - cz, x1 = ring[2 * j] - cx, z1 = ring[2 * j + 1] - cz;
    const c = x0 * z1 - x1 * z0;
    sxx += ((x0 * x0 + x0 * x1 + x1 * x1) * c) / 12;
    szz += ((z0 * z0 + z0 * z1 + z1 * z1) * c) / 12;
    sxz += ((x0 * z1 + 2 * x0 * z0 + 2 * x1 * z1 + x1 * z0) * c) / 24;
  }
  const angle = 0.5 * Math.atan2(2 * sxz, sxx - szz);
  const c = Math.cos(angle), s = Math.sin(angle);
  const iu = c * c * sxx + 2 * c * s * sxz + s * s * szz; // ∫u² dA along the major axis
  const iv = s * s * sxx - 2 * c * s * sxz + c * c * szz;
  return { x: cx, z: cz, angle, a: 2 * Math.sqrt(Math.abs(iu / A)), b: 2 * Math.sqrt(Math.abs(iv / A)) };
}

// Points of an ellipse at equal arc length, starting half a step past the -u tip (so the tip, where the steps arrive,
// falls between two columns); also its perimeter
function ellipsePoints(a, b, count, offset = 0.5) {
  const N = 1440;
  const pts = [], cum = [0];
  for (let k = 0; k <= N; k++) {
    const t = Math.PI + (2 * Math.PI * k) / N;
    pts.push([a * Math.cos(t), b * Math.sin(t)]);
    if (k) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  }
  const per = cum[N];
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const target = ((k + offset) * per) / count;
    while (j < N - 1 && cum[j + 1] < target) j++;
    const f = (target - cum[j]) / Math.max(cum[j + 1] - cum[j], 1e-9);
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * f, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * f, target]);
  }
  return { points: out, perimeter: per };
}

function ellipseRing(a, b, n) {
  const r = [];
  for (let k = 0; k < n; k++) {
    const t = Math.PI + (2 * Math.PI * k) / n;
    r.push(a * Math.cos(t), b * Math.sin(t));
  }
  return r;
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------------

// The stained glass, from the facade attributes: s = metres along the ring from a column, h = metres from the band's
// top (negative down), fstyle = (bay between columns, depth at the columns, sag of the swag, code). Both bands share one
// layout scaled to their depth k (the upper band ~2 m, the lower ~0.7 m): a row of medallions, a red-and-white
// checker, then opalescent glass with blue roundel strips and green iron tracery, a rosette border and the swag.
function stainedGlassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const fa = attribute('facade', 'vec4');
  const fs = attribute('fstyle', 'vec4');
  const s = fa.x, depth = fa.y.negate();
  const bay = max(fs.x, 0.1), k = max(fs.y, 0.1), sag = fs.z;
  const pix = max(max(fwidth(s), fwidth(depth)), 0.0005);
  const line = (dist, w) => float(1).sub(smoothstep(w, pix.add(w), dist));
  const fine = float(1).sub(smoothstep(0.01, 0.04, pix));
  const t = fract(s.div(bay)).sub(0.5); // -0.5..0.5 across the bay, 0 midway between columns
  const px = t.mul(bay);
  const bottom = k.add(sag.mul(float(1).sub(t.mul(t).mul(4.0))));
  const between = (a, b) => step(k.mul(a), depth).mul(step(depth, k.mul(b)));

  // Medallions: a teal oval in a dark lead ring holding a pale green heart, drawn from the implicit heart curve
  // (x² + y² - 1)³ = x² y³
  const r = k.mul(0.15);
  const count = max(floor(bay.div(r.mul(2.7))), 1.0);
  const cell = bay.div(count);
  const mx = fract(s.div(cell)).sub(0.5).mul(cell);
  const my = k.mul(0.2).sub(depth); // up from the medallion's centre
  const od = length(vec2(mx, my.mul(1.12))).sub(r);
  const inMed = float(1).sub(smoothstep(0.0, pix, od));
  const mottle = mx_noise_float(vec3(s.mul(9.0), depth.mul(9.0), 0.3)).mul(0.5).add(0.5);
  const teal = mix(vec3(0.08, 0.42, 0.5), vec3(0.1, 0.27, 0.58), mottle);
  const hx = mx.div(r.mul(0.62)), hy = my.div(r.mul(0.62)).add(0.12);
  const hq = hx.mul(hx).add(hy.mul(hy)).sub(1.0);
  const hf = hq.mul(hq).mul(hq).sub(hx.mul(hx).mul(hy).mul(hy).mul(hy));
  const heartIn = float(1).sub(smoothstep(-0.02, 0.02, hf));
  const heartEdge = float(1).sub(smoothstep(0.0, 0.06, abs(hf))).mul(fine);
  const medal = mix(mix(teal, vec3(0.5, 0.74, 0.46), heartIn), vec3(0.12, 0.3, 0.14), heartEdge);
  const ring = line(abs(od), r.mul(0.08)).mul(between(0.02, 0.4));
  const medRow = between(0.03, 0.38);

  // The checker stripe, then opalescent glass
  const stripe = between(0.38, 0.45);
  const checker = step(0.5, fract(s.div(k.mul(0.05)))).mul(step(depth, k.mul(0.415)));
  const red = mix(vec3(0.72, 0.24, 0.16), vec3(0.93, 0.9, 0.84), checker.mul(fine));
  const opal = mix(vec3(0.84, 0.86, 0.8), vec3(0.92, 0.91, 0.85), mx_noise_float(vec3(s.mul(3.0), depth.mul(3.0), 1.7)).mul(0.5).add(0.5));
  const below = step(k.mul(0.45), depth);
  const sx = abs(abs(px).sub(bay.mul(0.24)));
  const strip = step(sx, k.mul(0.035)).mul(below).mul(step(depth, k.mul(0.8)));
  const roundel = line(length(vec2(sx, fract(depth.div(k.mul(0.07))).sub(0.5).mul(k.mul(0.07)))), k.mul(0.02)).mul(strip);
  const blue = mix(vec3(0.5, 0.64, 0.82), vec3(0.12, 0.26, 0.72), roundel.mul(fine));
  const rosetteBand = between(0.8, 0.88);
  const rosette = line(length(vec2(fract(s.div(k.mul(0.07))).sub(0.5).mul(k.mul(0.07)), depth.sub(k.mul(0.84)))), k.mul(0.022))
    .mul(rosetteBand);
  const rose = mix(vec3(0.9, 0.86, 0.8), vec3(0.74, 0.32, 0.36), rosette.mul(fine));
  const border = line(abs(depth.sub(k.mul(0.8))), 0.01).add(line(abs(depth.sub(k.mul(0.88))), 0.01)).mul(fine);
  // the cast-iron tracery over the glass: from each column, branches curling up and out with leaves along them
  const cx = abs(px).sub(bay.mul(0.5)); // metres from the nearest column (negative inside the bay)
  const branch = (cy, rr) => line(abs(length(vec2(cx.add(rr), depth.sub(cy))).sub(rr)), k.mul(0.012)).mul(step(depth, cy));
  const leafCell = vec2(fract(s.div(k.mul(0.08))).sub(0.5), fract(depth.div(k.mul(0.08))).sub(0.5)).mul(k.mul(0.08));
  const leafy = step(length(leafCell), k.mul(0.022)).mul(step(abs(cx), k.mul(0.28))).mul(between(0.47, 0.75));
  const trees = clamp(branch(k.mul(0.78), k.mul(0.22)).add(branch(k.mul(0.66), k.mul(0.11))).add(leafy.mul(0.7)), 0.0, 1.0)
    .mul(below).mul(step(depth, bottom.sub(k.mul(0.09)))).mul(fine);
  let glass = select(stripe.greaterThan(0.5), red, select(below.greaterThan(0.5), opal, vec3(0.86, 0.85, 0.78)));
  glass = mix(glass, blue, strip);
  glass = mix(glass, rose, rosetteBand);
  glass = mix(glass, vec3(0.2, 0.42, 0.24), border.mul(below));
  glass = mix(glass, medal, inMed.mul(medRow));
  // lead cames on a grid, and the iron: the top frame, the swag's edge and a bead above it
  const came = k.mul(0.11);
  const cames = max(line(abs(fract(s.div(came)).sub(0.5)).mul(came), 0.005), line(abs(fract(depth.div(came.mul(1.5))).sub(0.5)).mul(came.mul(1.5)), 0.005))
    .mul(below).mul(fine);
  const ironMask = clamp(step(depth, k.mul(0.03)).add(step(bottom.sub(k.mul(0.03)), depth))
    .add(line(abs(depth.sub(bottom.sub(k.mul(0.07)))), 0.012)).add(ring).add(cames.mul(0.5)).add(trees), 0.0, 1.0);
  const iron = vec3(0.3, 0.4, 0.35);
  mat.colorNode = mix(glass, iron, ironMask);
  mat.roughnessNode = mix(float(0.22), float(0.5), ironMask);
  mat.metalnessNode = float(0.0);
  // the opalescent glass carries daylight through; at night the kiosk's lamps light it from inside
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  mat.emissiveNode = glass.mul(float(1).sub(ironMask)).mul(mix(float(0.1), float(0.32), night)).mul(mix(vec3(1), vec3(1.0, 0.88, 0.7), night));
  return mat;
}

// Varnished timber soffit: boards 9 cm wide along the kiosk's long axis, recessed lamps in the inner ceiling
function woodMaterial(frame) {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide });
  const c = Math.cos(frame.angle), s = Math.sin(frame.angle);
  const rel = positionWorld.xz.sub(vec2(frame.x, frame.z));
  const u = dot(rel, vec2(c, s)), v = dot(rel, vec2(-s, c));
  const board = floor(v.div(0.09));
  const hb = fract(sin(board.mul(91.7)).mul(43758.5453));
  const grain = mx_noise_float(vec3(u.mul(0.8), v.mul(30.0), 0.0)).mul(0.5).add(0.5);
  const pix = max(fwidth(v), 0.0005);
  const gapLine = float(1).sub(smoothstep(0.004, pix.add(0.004), abs(fract(v.div(0.09)).sub(0.5)).mul(0.09).sub(0.04).negate()));
  const base = mix(vec3(0.6, 0.36, 0.15), vec3(0.72, 0.47, 0.23), hb).mul(mix(float(0.88), float(1.08), grain));
  const fineGap = float(1).sub(smoothstep(0.01, 0.03, pix));
  const inner = step(positionWorld.y, frame.ground + H.ceiling + 0.2);
  const lampCell = vec2(fract(u.div(1.6)).sub(0.5), fract(v.div(1.3)).sub(0.5)).mul(vec2(1.6, 1.3));
  const lamp = float(1).sub(smoothstep(0.06, 0.075, length(lampCell))).mul(inner);
  mat.colorNode = mix(base.mul(float(1).sub(gapLine.mul(fineGap).mul(0.35))), vec3(0.85, 0.85, 0.82), lamp);
  mat.roughnessNode = float(0.45);
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  // by day the light bounced off the pale paving warms the boards; at night the lamps and their glow on the wood
  mat.emissiveNode = base.mul(0.22).mul(float(1).sub(night)).add(vec3(1.0, 0.86, 0.62).mul(lamp.mul(4.0).add(inner.mul(0.06))).mul(night));
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// The kiosk
// ---------------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const site = sites[0];
  const ringSrc = (site.buildings || []).map((i) => ctx.GEO.buildings[i]?.g?.[0]).find(Boolean) || site.footprint;
  if (!ringSrc) return null;
  const fit = fitEllipse(ringSrc);
  if (!(fit.a > 2 && fit.a < 15 && fit.b > 1.5)) return null;
  const ground = Math.max(0, ctx.terrain.heightAt(fit.x, fit.z));
  const frame = { x: fit.x, z: fit.z, angle: fit.angle, ground };
  const low = ctx.kit.lowestGround(ctx, ringSrc) - ground - 0.25;

  // painted cast iron: the paint is the surface, so it reads as a dielectric
  const iron = new THREE.MeshStandardNodeMaterial({ color: 0x75907f, roughness: 0.55, metalness: 0.1 });
  const glass = stainedGlassMaterial();
  const wood = woodMaterial(frame);
  // the roof's zinc weathered pale, as in the photos
  const zinc = new THREE.MeshStandardNodeMaterial({ color: 0xa3abad, roughness: 0.55, metalness: 0.3 });
  const m = new CentreModel([glass]);
  m.use(frame);
  const F = m.facade;
  const stone = style(FK.plain, FT.stone);

  const { a, b } = fit;
  const a1 = a - 0.28, b1 = b - 0.28; // the column ring, along the platform's edge
  const a2 = a1 - 0.8, b2 = b1 - 0.8; // the inner ring
  const ar = a1 + 1.35, br = b1 + 1.35; // the roof's edge
  const SEG = 72;

  // Plinth: a base course, the band of marble panels, a moulded coping that is the platform's edge
  m.prism(F, ellipseRing(a + 0.06, b + 0.06, SEG), low, 0.25, stone, { top: true, smooth: true, continuous: true });
  m.prism(F, ellipseRing(a, b, SEG), 0.25, H.plinth - 0.25, style(FK.panel, FT.stone, { bay: 0.75, floor: 1.0, base: 0.25 }),
    { top: false, smooth: true, continuous: true });
  m.prism(F, ellipseRing(a + 0.08, b + 0.08, SEG), H.plinth - 0.25, H.plinth, stone, { top: true, bottom: true, smooth: true, continuous: true });

  // The steps at the northern tip: a narrow flight hugging the plinth (municipal 1:500 stairs), with iron handrails
  const stairsSrc = [[322.3, -90.1], [324.15, -89.3]]; // its outer foot and its top, from c500_ESKAILERA
  const toLocal = (x, z) => {
    const c = Math.cos(frame.angle), s = Math.sin(frame.angle);
    return [(x - frame.x) * c + (z - frame.z) * s, -(x - frame.x) * s + (z - frame.z) * c];
  };
  let foot = toLocal(...stairsSrc[0]), top = toLocal(...stairsSrc[1]);
  // keep the flight beside the tip even if the outline moves: fall back to a tangential flight
  if (Math.hypot(top[0] + a, top[1]) > 2.5) { top = [-a - 0.3, 0.6]; foot = [-a - 0.9, -1.6]; }
  const dir = [foot[0] - top[0], foot[1] - top[1]];
  const dl = Math.hypot(...dir);
  const run = Math.max(dl, 2.2), d = [dir[0] / dl, dir[1] / dl];
  const start = [top[0] - d[0] * 0.4, top[1] - d[1] * 0.4];
  const end = [start[0] + d[0] * run, start[1] + d[1] * run];
  m.stairs(F, end, start, 1.0, 0.0, H.plinth, 8, low, stone);
  for (const side of [-0.5, 0.5]) {
    const o = [-d[1] * side, d[0] * side];
    const p0 = [end[0] + o[0], 0.95, end[1] + o[1]], p1 = [start[0] + o[0], H.plinth + 0.95, start[1] + o[1]];
    m.beam(iron, p0, p1, 0.05, 0.05);
    for (let k = 0; k <= 6; k++) {
      const f = k / 6;
      const q = [p0[0] + (p1[0] - p0[0]) * f, p0[2] + (p1[2] - p0[2]) * f];
      const y = (H.plinth * k) / 6;
      m.beam(iron, [q[0], y, q[1]], [q[0], y + 0.95, q[1]], 0.035, 0.035);
    }
  }

  // Columns at equal spacing round the ring (the tip between two of them); the inner ring offset by half a bay
  const outer = ellipsePoints(a1, b1, COLUMNS, 0.5);
  const innerPts = ellipsePoints(a2, b2, COLUMNS, 0.0);
  const roofPts = ellipsePoints(ar, br, COLUMNS, 0.5);
  const y0 = H.plinth;
  for (const [u, v] of outer.points) {
    // a bell base, a ring at mid height, the foliage capital where the upper band's swags meet the column
    m.dome(iron, u, v, y0, [[0.17, 0], [0.17, 0.12], [0.12, 0.2], [0.13, 0.5], [0.085, 0.75], [0.085, 1.9], [0.11, 1.98],
      [0.085, 2.06], [0.085, 3.2], [0.11, 3.3], [0.09, 3.38], [0.21, 3.7], [0.12, 3.9], [0.07, 3.98], [0.07, H.roof - y0]], 8);
  }
  for (const [u, v] of innerPts.points) {
    m.dome(iron, u, v, y0, [[0.12, 0], [0.12, 0.1], [0.065, 0.3], [0.055, 2.5], [0.13, 2.75], [0.06, 2.9], [0.05, H.ceiling - y0]], 8);
  }
  // Brackets under the roof: a strut and a beam from each column out to the fascia
  outer.points.forEach(([u, v], k) => {
    const [ru, rv] = roofPts.points[k];
    m.beam(iron, [u, y0 + 3.8, v], [ru * 0.97, H.roof - 0.12, rv * 0.97], 0.07, 0.07);
    m.beam(iron, [u, H.roof - 0.08, v], [ru, H.roof - 0.08, rv], 0.06, 0.1);
  });

  // Railing round the platform between the columns, open where the steps arrive
  const rail = ellipseRing(a1 + 0.05, b1 + 0.05, 96);
  for (let k = 0; k < rail.length / 2; k++) {
    const j = (k + 1) % (rail.length / 2);
    const p = [rail[2 * k], rail[2 * k + 1]], q = [rail[2 * j], rail[2 * j + 1]];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (Math.hypot(mid[0] - start[0], mid[1] - start[1]) < 0.75) continue;
    m.railing(iron, p, q, y0, 0.95, 0.13);
  }

  // Glass bands: quads between the band's top and its swag, six per bay; s runs along the ring from a column
  const band = (pts, per, spec) => {
    const n = pts.length, sub = 6;
    for (let k = 0; k < n; k++) {
      const p = pts[k], q = pts[(k + 1) % n];
      for (let i = 0; i < sub; i++) {
        const f0 = i / sub, f1 = (i + 1) / sub;
        const A = [p[0] + (q[0] - p[0]) * f0, p[1] + (q[1] - p[1]) * f0], B = [p[0] + (q[0] - p[0]) * f1, p[1] + (q[1] - p[1]) * f1];
        const sag = (f) => spec.atColumn + spec.sag * (1 - (2 * f - 1) * (2 * f - 1));
        const bay = per / n, s0 = bay * (k + f0), s1 = bay * (k + f1);
        const st = { kind: 0, tone: 0, bay, floor: spec.atColumn, ground: spec.sag, base: spec.top, seed: 1 };
        m.face(glass, [[A[0], spec.top - sag(f0), A[1]], [A[0], spec.top, A[1]], [B[0], spec.top, B[1]], [B[0], spec.top - sag(f1), B[1]]],
          st, null, { s: [s0, s0, s1, s1], len: per });
      }
    }
  };
  // the polygon through the column points is wound like ellipseRing (counter-clockwise in u, v), so faces look out
  band(outer.points, outer.perimeter, UPPER);
  band(innerPts.points, innerPts.perimeter, LOWER);

  // Ceilings: the lower timber ceiling with its lamps inside the inner ring, at the lower band's top; above, the soffit
  // of the roof out to the eaves; iron ring beams carry both bands
  m.cap(wood, ellipseRing(a2, b2, SEG), H.ceiling, false);
  m.cap(wood, ellipseRing(ar, br, SEG), H.roof, false);
  // Iron rings (hollow, so the timber shows inside them): the beams over both bands, the fascia and its lip
  const ironRing = (ra, rb, t, y0, y1) => {
    const o = ellipseRing(ra, rb, SEG), i = ellipseRing(ra - t, rb - t, SEG);
    m.prism(iron, o, y0, y1, null, { top: false, smooth: true });
    m.innerWalls(iron, i, y0, y1, null);
    m.capHoles(iron, o, [i], y0, false);
    m.capHoles(iron, o, [i], y1, true);
  };
  ironRing(a2 + 0.04, b2 + 0.04, 0.12, H.ceiling - 0.1, H.ceiling + 0.25);
  ironRing(a1 + 0.05, b1 + 0.05, 0.14, H.roof - 0.14, H.roof);
  ironRing(ar + 0.04, br + 0.04, 0.08, H.roof - 0.2, H.fascia);
  ironRing(ar + 0.1, br + 0.1, 0.14, H.fascia - 0.06, H.fascia + 0.04);
  m.loft(zinc, [ellipseRing(ar + 0.1, br + 0.1, SEG), ellipseRing(ar * 0.55, br * 0.55, SEG), ellipseRing(ar * 0.14, br * 0.14, SEG)],
    [H.fascia + 0.04, H.fascia + 0.62, H.top - 0.2], { smooth: true });
  m.dome(iron, 0, 0, H.top - 0.22, [[0.16, 0], [0.2, 0.08], [0.06, 0.22], [0.09, 0.32], [0.02, 0.5]], 8);

  return m.finish('Kiosko');
}
