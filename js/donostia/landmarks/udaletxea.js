import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot, clamp, length, atan,
  select, fwidth, pow, normalize, positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/udaletxea.js
// Donostiako Udaletxea — the City Hall, built 1882-87 as the Gran Casino (Luis Aladrén & Adolfo Morales de los Ríos,
// after the Monte Carlo casino; a casino until gambling was banned in 1924, the City Hall since the 1940s): an eclectic
// Belle Époque palace in cream stone. A central body with two slender towers flanking the entrance faces the Alderdi
// Eder gardens (their footprints are the two small projections either side of the entrance in the OSM outline); long
// wings with arched windows run out to end pavilions under tall slate roofs, and the old ballroom (now the Salón de
// Plenos) projects behind towards the harbour. The municipal heritage catalogue (PEPPUC, grado A) describes "un cuerpo
// central y dos laterales unidos por galerías"; b5m measures 15.6 m on average and 25.3 m at the tower tops.
//
// This file also holds the small kit shared by the four civic landmarks (victoria-eugenia.js, hotel-maria-cristina.js
// and artzain-ona.js import it from here): a geometry builder that works in the landmark's own frame (u along its long
// axis, v across, y up from its ground) and merges everything per material, and one facade material whose windows,
// arches, lancets, rose windows and balustrades come from per-vertex attributes, so all four landmarks share a single
// facade pipeline.
//
// build(sites, ctx) receives the GEO.landmarks entries ['udaletxea'] (footprint ring, at [x, z], buildings, height — see
// tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame) coordinates.

// ---------------------------------------------------------------------------------------------------------------------
// Facade styles
// ---------------------------------------------------------------------------------------------------------------------

// Stone of each landmark: the cream ashlar of the City Hall, the white stone of the María Cristina, the warmer stone of
// the Victoria Eugenia and the Igeldo sandstone of the Buen Pastor
export const TONE = { cream: 0, white: 1, ochre: 2, sandstone: 3 };
const TONES = [[0.85, 0.79, 0.67], [0.9, 0.88, 0.83], [0.84, 0.75, 0.6], [0.66, 0.55, 0.41]];

// What the shader draws on a wall: plain ashlar; Belle Époque windows (arched on the ground & main floors, square-headed
// above); round-arched openings throughout; pointed lancets with tracery & stained glass; a balustrade; rusticated
// masonry; a rose window; tall French windows (hotel & flats). CAP marks horizontal faces (no coursing).
export const WIN = { plain: 0, civic: 1, arcade: 2, lancet: 3, balustrade: 4, rusticated: 5, rose: 6, residential: 7, cap: 15 };

// bay: target window spacing (m; the wall is split into whole bays); floor / ground: storey heights above the part's
// base (the storey grid starts at `base`, metres above the landmark's ground); for a balustrade `floor` is its height,
// for a rose window `bay` is the radius and `floor` the height of its centre above `base`
export function facadeStyle(kind, tone, { bay = 3.6, floor = 4, ground = 5, base = 0, seed = 0 } = {}) {
  return { kind, tone, bay, floor, ground, base, seed };
}

// ---------------------------------------------------------------------------------------------------------------------
// The shared facade material
// ---------------------------------------------------------------------------------------------------------------------

let facadeMaterial = null;

// Attributes: facade = (s: metres along the wall, h: metres above the part's base, wall length, wall top above the base)
// and fstyle = (bay, floor, ground, kind + 16 tone + 128 seed). Openings are signed distances in metres from the bay's
// centre line, so arches stay round however long the wall; joints and glazing bars fade before they shrink to a pixel.
export function civicFacadeMaterial() {
  if (facadeMaterial) return facadeMaterial;
  const mat = new THREE.MeshStandardNodeMaterial();
  const fa = attribute('facade', 'vec4');
  const fs = attribute('fstyle', 'vec4');
  const s = fa.x, h = fa.y, wallLen = max(fa.z, 0.01), wallTop = fa.w;
  const bayTarget = max(fs.x, 0.05), floorH = max(fs.y, 0.05), groundH = fs.z, code = fs.w;
  // the code is an exact small integer per face; the +0.01 keeps floor() stable on interpolated values
  const seed = floor(code.div(128).add(0.01));
  const rem = code.sub(seed.mul(128));
  const tone = floor(rem.div(16).add(0.01));
  const kind = rem.sub(tone.mul(16));
  const isKind = (k) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const kCivic = isKind(WIN.civic), kArcade = isKind(WIN.arcade), kLancet = isKind(WIN.lancet);
  const kBal = isKind(WIN.balustrade), kRust = isKind(WIN.rusticated), kRose = isKind(WIN.rose);
  const kRes = isKind(WIN.residential), kCap = isKind(WIN.cap);
  const hasWin = kCivic.add(kArcade).add(kLancet).add(kRes);
  const isStained = max(kLancet, kRose);

  // metres per pixel on the wall, for anti-aliasing and fading fine detail with distance
  const pix = max(max(fwidth(s), fwidth(h)), 0.0005);
  const lineAA = (dist, w) => float(1).sub(smoothstep(w, pix.add(w), dist));

  // Whole bays per wall; px = metres from the bay's centre line
  const bays = max(floor(wallLen.div(bayTarget).add(0.5)), 1.0);
  const bayW = wallLen.div(bays);
  const bayIdx = floor(s.div(bayW));
  const px = fract(s.div(bayW)).sub(0.5).mul(bayW);
  const dx = abs(px);
  const narrow = step(wallLen, bayTarget.mul(0.7));

  // Storeys: a taller ground floor, then floors of floorH; windows only in storeys that fit under the wall's top
  const inGround = h.lessThan(groundH);
  const g = select(inGround, float(1), float(0));
  const level = max(h.sub(groundH), 0.0).div(floorH);
  const storey = select(inGround, float(-1), floor(level));
  const storeyBase = select(inGround, float(0), groundH.add(floor(level).mul(floorH)));
  const storeyH = select(inGround, max(groundH, 0.05), floorH);
  const py = h.sub(storeyBase);
  const noble = step(-0.5, storey).mul(step(storey, 0.5)); // the main floor (storey 0 above the ground floor)
  const fits = step(storeyBase.add(storeyH), wallTop.add(0.05));

  // Opening of each kind: half-width (share of the bay), sill & head (m above the storey's floor), arch (0 square, 1 round,
  // 2 pointed). Kinds are exclusive, so masked sums pick one set.
  const halfFrac = kCivic.mul(mix(mix(float(0.22), float(0.25), noble), float(0.28), g))
    .add(kArcade.mul(mix(float(0.33), float(0.36), g)))
    .add(kLancet.mul(0.22))
    .add(kRes.mul(mix(float(0.2), float(0.3), g)));
  const halfW = halfFrac.mul(bayW);
  const sill = kCivic.mul(mix(mix(float(0.28), float(0.2), noble).mul(storeyH), float(0.45), g))
    .add(kArcade.mul(mix(storeyH.mul(0.16), float(0.0), g)))
    .add(kLancet.mul(mix(storeyH.mul(0.22), float(0.0), g)))
    .add(kRes.mul(mix(storeyH.mul(0.05), float(0.0), g)));
  const head = kCivic.mul(mix(mix(float(0.8), float(0.88), noble).mul(storeyH), storeyH.sub(0.5), g))
    .add(kArcade.mul(mix(storeyH.mul(0.9), storeyH.sub(0.35), g)))
    .add(kLancet.mul(storeyH.mul(mix(float(0.92), float(0.85), g))))
    .add(kRes.mul(mix(storeyH.mul(0.8), storeyH.sub(0.6), g)));
  const arch = kCivic.mul(max(noble, g)).add(kArcade).add(kLancet.mul(2.0));
  const pointed = arch.greaterThan(1.5), round = arch.greaterThan(0.5);
  const spring = head.sub(select(pointed, halfW.mul(1.732), select(round, halfW, float(0))));
  const dyA = max(py.sub(spring), 0.0);
  // signed distance to the opening's outline, positive inside: below the springing line the arches reduce to the jambs
  const dRound = halfW.sub(length(vec2(dx, dyA)));
  const dPoint = halfW.mul(2.0).sub(length(vec2(dx.add(halfW), dyA))); // equilateral arch: arcs centred on the far jamb
  const dTop = select(pointed, dPoint, select(round, dRound, head.sub(py)));
  const d = min(min(halfW.sub(dx), py.sub(sill)), dTop);
  const winOn = hasWin.mul(fits).mul(float(1).sub(narrow));
  const aa = max(fwidth(d), 0.004);
  const opening = smoothstep(aa.negate(), aa, d).mul(winOn);
  // moulded stone surround about every opening
  const surround = smoothstep(-0.3, -0.22, d).mul(float(1).sub(opening)).mul(winOn);

  // Glazing bars: a mullion, a transom at the springing (or ~3/4 up a square-headed window), and in lancets a traceried
  // ring in the head
  const barFade = float(1).sub(smoothstep(0.03, 0.09, pix));
  const mullion = lineAA(dx, 0.05);
  const transomY = select(round, spring, mix(sill, head, 0.72));
  const transom = lineAA(abs(py.sub(transomY)), 0.045).mul(float(1).sub(kLancet.mul(0.6)));
  const ring = lineAA(abs(length(vec2(px, py.sub(spring.add(halfW.mul(0.55))))).sub(halfW.mul(0.42))), 0.05).mul(kLancet);
  const bars = clamp(mullion.add(transom).add(ring), 0.0, 1.0).mul(barFade).mul(opening);

  // Rose window centred on the wall: twelve spokes, two rings and a stone frame
  const rp = vec2(s.sub(wallLen.mul(0.5)), h.sub(floorH));
  const rr = length(rp);
  const radius = bayTarget;
  const inRose = float(1).sub(smoothstep(radius.sub(pix), radius, rr)).mul(kRose);
  const sector = atan(rp.y, rp.x).mul(12 / (2 * Math.PI));
  const spokeDist = abs(fract(sector.add(0.5)).sub(0.5)).mul((2 * Math.PI) / 12).mul(rr);
  const tracery = max(
    max(lineAA(spokeDist, 0.06).mul(step(radius.mul(0.3), rr)), lineAA(abs(rr.sub(radius.mul(0.3))), 0.07)),
    max(lineAA(abs(rr.sub(radius.mul(0.68))), 0.06), step(radius.sub(0.3), rr))
  );
  const roseGlass = inRose.mul(float(1).sub(tracery));

  // Balustrade: plinth, rail and turned balusters (bulging low) with dark gaps between them
  const balH = floorH;
  const inBody = step(0.14, h).mul(step(h, balH.sub(0.17)));
  const bm = clamp(h.sub(0.14).div(max(balH.sub(0.31), 0.05)), 0.0, 1.0);
  const balR = float(0.04).add(sin(min(bm.mul(1.6), 1.0).mul(Math.PI)).mul(0.045));
  const gap = smoothstep(balR, balR.add(pix), dx).mul(inBody).mul(kBal).mul(float(1).sub(narrow));

  // Stone: tone, grain, ashlar coursing, rustication on plinths and ground floors, a string course over each floor line
  const tones = TONES.map((c) => vec3(...c));
  let stone = tones[0];
  for (let k = 1; k < tones.length; k++) stone = select(tone.greaterThan(k - 0.5), tones[k], stone);
  const grain = mx_noise_float(positionWorld.mul(0.6)).mul(0.05).add(1.0);
  const course = 0.52, block = 1.15;
  const row = floor(h.div(course));
  const odd = fract(row.mul(0.5)).mul(2.0); // row parity that stays right below the base (WGSL % keeps the sign)
  const bed = abs(fract(h.div(course).add(0.5)).sub(0.5)).mul(course);
  const head2 = abs(fract(s.div(block).add(odd.mul(0.5)).add(0.5)).sub(0.5)).mul(block);
  const plainWall = float(1).sub(kCap).mul(float(1).sub(kBal));
  const joint = max(lineAA(bed, 0.012), lineAA(head2, 0.012)).mul(float(1).sub(smoothstep(0.012, 0.04, pix))).mul(plainWall);
  const rustZone = max(kRust, g.mul(kCivic.add(kArcade).add(kRes))).mul(float(1).sub(kCap));
  const groove = lineAA(abs(fract(h.div(0.6).add(0.5)).sub(0.5)).mul(0.6), 0.045)
    .mul(float(1).sub(smoothstep(0.03, 0.1, pix)));
  const band = float(1).sub(smoothstep(0.3, pix.add(0.3), py)).mul(float(1).sub(g))
    .mul(kCivic.add(kArcade).add(kRes)).mul(step(0.0, h));
  const wall = stone.mul(grain)
    .mul(float(1).sub(joint.mul(0.2)))
    .mul(float(1).sub(groove.mul(rustZone).mul(0.42)))
    .mul(float(1).add(band.mul(0.07)))
    .mul(float(1).add(surround.mul(0.1)));
  const wallWithGaps = mix(wall, stone.mul(0.14), gap);

  // Glass: dark panes with a sky-tinted Fresnel sheen; stained glass in lancets & roses (dark by day, glowing at night)
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const plainGlass = mix(vec3(0.045, 0.06, 0.075), cityUniforms.uSkyHorizonColor.mul(0.55), fres.mul(0.75).add(0.05));
  const cellRect = floor(vec2(px.div(0.32), py.div(0.42)));
  const cellRose = floor(vec2(sector, rr.div(0.6)));
  const cell = select(kRose.greaterThan(0.5), cellRose, cellRect);
  const hs = fract(sin(dot(cell.add(seed.mul(3.7)), vec2(12.9898, 78.233))).mul(43758.5453));
  const stained = select(hs.lessThan(0.42), vec3(0.12, 0.2, 0.62), select(hs.lessThan(0.66), vec3(0.62, 0.1, 0.1),
    select(hs.lessThan(0.86), vec3(0.7, 0.5, 0.12), vec3(0.14, 0.42, 0.2))));
  const glassCol = mix(plainGlass, stained.mul(0.3).add(plainGlass.mul(0.6)), isStained);
  const paneMask = max(opening.mul(float(1).sub(bars)), roseGlass);
  const frameMask = max(opening.mul(bars), inRose.mul(tracery));
  const frameCol = mix(vec3(0.86, 0.85, 0.82), stone.mul(0.85), isStained); // white joinery; stone tracery in churches

  mat.colorNode = mix(mix(wallWithGaps, frameCol, frameMask), glassCol, paneMask);
  mat.roughnessNode = mix(float(0.86), float(0.12), paneMask);
  mat.metalnessNode = mix(float(0.0), float(0.3), paneMask.mul(float(1).sub(isStained)));

  // Night: a random share of rooms lit behind plain glass (as in js/donostia/buildings.js), stained glass glowing and
  // the stone washed by warm floodlights, as these four are lit after dark
  const key = vec2(bayIdx.add(seed.mul(7.13)), storey.add(wallLen.mul(0.731)).add(wallTop.mul(0.317)));
  const hw = fract(sin(dot(key, vec2(12.9898, 78.233))).mul(43758.5453));
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.42), 0.0, 0.85);
  const lit = step(hw, litShare).mul(paneMask).mul(float(1).sub(isStained));
  const warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.85, 0.7), fract(hw.mul(13.1)));
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  const stainedGlow = stained.mul(paneMask).mul(isStained).mul(night).mul(0.9);
  const flood = stone.mul(vec3(1.0, 0.8, 0.55)).mul(night).mul(0.13).mul(float(1).sub(paneMask));
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(1.5).add(stainedGlow).add(flood);

  facadeMaterial = mat;
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rings (flat [u0, v0, u1, v1, ...] in the landmark frame)
// ---------------------------------------------------------------------------------------------------------------------

export function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[2 * i] * r[2 * j + 1] - r[2 * j] * r[2 * i + 1];
  }
  return a / 2;
}

function reverseRing(r) {
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
}

// Positive area: edge (du, dv) then has its outward normal at (dv, -du)
export function ccwRing(r) {
  return ringArea(r) >= 0 ? r : reverseRing(r);
}

export function rect(u0, u1, v0, v1) {
  return [u0, v0, u1, v0, u1, v1, u0, v1];
}

// Regular polygon (phase 0: a vertex on +u; π/4 with n = 4: a square with sides along u & v)
export function ngon(cu, cv, r, n, phase = 0) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = phase + (2 * Math.PI * k) / n;
    out.push(cu + r * Math.cos(a), cv + r * Math.sin(a));
  }
  return out;
}

// Points along an arc from angle a0 to a1 (n segments, n + 1 points)
export function arc(cu, cv, r, a0, a1, n) {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push(cu + r * Math.cos(a), cv + r * Math.sin(a));
  }
  return out;
}

// Miter offset of a ring by d towards its inside (d < 0: outwards), adapted from insetRing in js/donostia/buildings.js.
// Returns null when the offset folds an edge over or collapses the ring.
export function offsetRing(ring, d) {
  const r = ccwRing(ring);
  const n = r.length / 2;
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let ax = r[2 * i] - r[2 * p], az = r[2 * i + 1] - r[2 * p + 1];
    let bx = r[2 * q] - r[2 * i], bz = r[2 * q + 1] - r[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx; // inward normals
    const denom = 1 + (n1x * n2x + n1z * n2z);
    if (denom < 0.25) return null;
    out[2 * i] = r[2 * i] + (d * (n1x + n2x)) / denom;
    out[2 * i + 1] = r[2 * i + 1] + (d * (n1z + n2z)) / denom;
  }
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ox = r[2 * q] - r[2 * i], oz = r[2 * q + 1] - r[2 * i + 1];
    const nx = out[2 * q] - out[2 * i], nz = out[2 * q + 1] - out[2 * i + 1];
    if (ox * nx + oz * nz <= 0) return null;
  }
  const a0 = ringArea(r), a1 = ringArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.05 * Math.abs(a0)) return null;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The geometry builder
// ---------------------------------------------------------------------------------------------------------------------

function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l < 1e-12 ? null : [nx / l, ny / l, nz / l];
}

function styleCode(st) {
  return [st.bay, st.floor, st.ground, st.kind + 16 * st.tone + 128 * (st.seed % 1000)];
}

// Frame of a landmark: its footprint's oriented box (kit.orientedBox), turned so that +u points along `expect` (a world
// [x, z] direction) whatever edge the box search started from. ground (where the storeys start) is the LiDAR ground at
// `front`, a frame point before the main entrance, or else the 1:500 buildings' median ground; the plinth reaches down
// to the lowest ground under the footprint, so a falling site shows a raised basement rather than buried windows.
export function civicFrame(ctx, site, expect, { front = null } = {}) {
  const { kit, GEO } = ctx;
  const ob = kit.orientedBox(site.footprint);
  let angle = ob.angle;
  if (Math.cos(angle) * expect[0] + Math.sin(angle) * expect[1] < 0) angle += Math.PI;
  const c = Math.cos(angle), s = Math.sin(angle);
  const grounds = (site.buildings || []).map((i) => GEO.buildings[i]?.ground).filter(Number.isFinite).sort((a, b) => a - b);
  const low = kit.lowestGround(ctx, site.footprint);
  let ground = grounds.length ? grounds[grounds.length >> 1] : ctx.terrain.heightAt(ob.x, ob.z);
  if (front) {
    const g = ctx.terrain.heightAt(ob.x + front[0] * c - front[1] * s, ob.z + front[0] * s + front[1] * c);
    if (Number.isFinite(g)) ground = Math.max(g, 0);
  }
  return { x: ob.x, z: ob.z, angle, length: ob.length, width: ob.width, ground, plinth: Math.min(low, ground) - 0.3 - ground };
}

// Accumulates triangles per material in the landmark frame (u, y, v), then bakes them into world-space meshes, one per
// material. Faces are planar polygons wound counter-clockwise seen from outside; facade faces carry the window
// attributes of civicFacadeMaterial.
export class CivicModel {
  constructor(frame) {
    this.frame = frame;
    this.facade = civicFacadeMaterial();
    this.buckets = new Map();
  }

  bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) {
      const isFacade = mat === this.facade;
      b = { pos: [], nrm: [], fac: isFacade ? [] : null, sty: isFacade ? [] : null };
      this.buckets.set(mat, b);
    }
    return b;
  }

  // A planar convex polygon [[u, y, v], ...]. st: facade style (facade material only); vn: per-vertex normals;
  // sAlong: per-vertex metres along the wall plus the wall's length, for walls that wrap round a rotunda.
  face(mat, pts, st = null, vn = null, sAlong = null) {
    const fn = newell(pts);
    if (!fn) return;
    const b = this.bucket(mat);
    let fac = null, sty = null;
    if (b.fac) {
      let style = st || facadeStyle(WIN.plain, 0);
      const base = style.base;
      let maxY = -Infinity, cx = 0, cz = 0;
      for (const p of pts) {
        maxY = Math.max(maxY, p[1]);
        cx += p[0];
        cz += p[2];
      }
      // a seed per wall, so walls of the same length don't light the same rooms at night
      if (!style.seed) style = { ...style, seed: Math.abs(Math.round((cx * 3.1 + cz * 7.7 + maxY * 1.3) / pts.length)) % 997 };
      if (Math.abs(fn[1]) > 0.85) {
        fac = pts.map((p) => [0, p[1] - base, 1, 1e4]);
        sty = styleCode({ ...style, kind: WIN.cap });
      } else {
        let along;
        if (sAlong) along = sAlong;
        else {
          const tl = Math.hypot(fn[0], fn[2]);
          const tu = -fn[2] / tl, tv = fn[0] / tl;
          const ss = pts.map((p) => p[0] * tu + p[2] * tv);
          const s0 = Math.min(...ss);
          along = { s: ss.map((x) => x - s0), len: Math.max(...ss) - s0 };
        }
        fac = pts.map((p, k) => [along.s[k], p[1] - base, along.len, maxY - base]);
        sty = styleCode(style);
      }
    }
    const p0 = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1];
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) continue;
      for (const k of [0, i, i + 1]) {
        const p = pts[k], n = vn ? vn[k] : fn;
        b.pos.push(p[0], p[1], p[2]);
        b.nrm.push(n[0], n[1], n[2]);
        if (b.fac) {
          b.fac.push(...fac[k]);
          b.sty.push(...sty);
        }
      }
    }
  }

  // A face turned to look along dir (any winding in)
  faceDir(mat, pts, dir, st = null) {
    const n = newell(pts);
    if (!n) return;
    if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) pts = pts.slice().reverse();
    this.face(mat, pts, st);
  }

  // Horizontal cap of a (possibly concave) ring
  cap(mat, ring, y, up = true, st = null) {
    const r = ccwRing(ring);
    const pts = [];
    for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      let A = [pts[a].x, y, pts[a].y], B = [pts[b].x, y, pts[b].y], C = [pts[c].x, y, pts[c].y];
      const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
      if ((ny > 0) !== up) [B, C] = [C, B];
      this.face(mat, [A, B, C], st);
    }
  }

  // Vertical prism of a ring. styleOf(i) picks the style of edge i (of the counter-wound ring); smooth: radial normals;
  // continuous: windows laid out along the whole perimeter (rotundas).
  prism(mat, ring, y0, y1, st = null, { top = true, bottom = false, styleOf = null, smooth = false, continuous = false } = {}) {
    const r = ccwRing(ring), n = r.length / 2;
    const lens = [], edgeN = [];
    let per = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const du = r[2 * j] - r[2 * i], dv = r[2 * j + 1] - r[2 * i + 1];
      const l = Math.hypot(du, dv);
      lens.push(l);
      edgeN.push(l > 1e-9 ? [dv / l, 0, -du / l] : [0, 0, 0]);
      per += l;
    }
    const vertN = (i) => {
      const a = edgeN[(i + n - 1) % n], c = edgeN[i];
      const x = a[0] + c[0], z = a[2] + c[2], l = Math.hypot(x, z) || 1;
      return [x / l, 0, z / l];
    };
    let s0 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (lens[i] < 1e-6) continue;
      const a = [r[2 * i], r[2 * i + 1]], b = [r[2 * j], r[2 * j + 1]];
      const quad = [[a[0], y0, a[1]], [a[0], y1, a[1]], [b[0], y1, b[1]], [b[0], y0, b[1]]];
      const vn = smooth ? [vertN(i), vertN(i), vertN(j), vertN(j)] : null;
      const along = continuous ? { s: [s0, s0, s0 + lens[i], s0 + lens[i]], len: per } : null;
      this.face(mat, quad, styleOf ? styleOf(i) : st, vn, along);
      s0 += lens[i];
    }
    if (top) this.cap(mat, r, y1, true, st);
    if (bottom) this.cap(mat, r, y0, false, st);
  }

  // Box in the frame; faces = styles of its [-v, +u, +v, -u] walls (default: st on all four)
  box(mat, u0, u1, y0, y1, v0, v1, st = null, { faces = null, top = true, bottom = false } = {}) {
    this.prism(mat, rect(u0, u1, v0, v1), y0, y1, st, { top, bottom, styleOf: faces ? (i) => faces[i] : null });
  }

  // Surface lofted through rings with matching vertices (same generator, same order) at heights ys. A ring may collapse
  // to a point or a line (pyramids, ridges). matOf(i) / styleOf(i) override the material & style of the faces above edge
  // i (gable ends).
  loft(mat, rings, ys, { st = null, smooth = false, top = true, matOf = null, styleOf = null } = {}) {
    const flip = ringArea(rings[0]) < 0;
    const R = flip ? rings.map(reverseRing) : rings;
    const n = R[0].length / 2, K = R.length;
    const P = (k, i) => [R[k][2 * (i % n)], ys[k], R[k][2 * (i % n) + 1]];
    const quadN = [];
    for (let k = 0; k < K - 1; k++) {
      quadN.push([]);
      for (let i = 0; i < n; i++) quadN[k].push(newell([P(k, i), P(k + 1, i), P(k + 1, i + 1), P(k, i + 1)]) || [0, 1, 0]);
    }
    const vertN = (k, i) => {
      let x = 0, y = 0, z = 0;
      for (const kk of [k - 1, k]) {
        if (kk < 0 || kk >= K - 1) continue;
        for (const ii of [(i + n - 1) % n, i % n]) {
          const q = quadN[kk][ii];
          x += q[0]; y += q[1]; z += q[2];
        }
      }
      const l = Math.hypot(x, y, z) || 1;
      return [x / l, y / l, z / l];
    };
    for (let k = 0; k < K - 1; k++) {
      for (let i = 0; i < n; i++) {
        const quad = [P(k, i), P(k + 1, i), P(k + 1, i + 1), P(k, i + 1)];
        const vn = smooth ? [vertN(k, i), vertN(k + 1, i), vertN(k + 1, i + 1), vertN(k, i + 1)] : null;
        this.face(matOf ? matOf(i) : mat, quad, styleOf ? styleOf(i) : st, vn);
      }
    }
    if (top && Math.abs(ringArea(R[K - 1])) > 1e-4) this.cap(mat, R[K - 1], ys[K - 1], true, st);
  }

  // Dome / spire / finial of revolution: profile [[radius, height], ...] from y0, as n-sided rings (phase as in ngon)
  dome(mat, cu, cv, y0, profile, n = 16, { phase = 0, smooth = true, st = null } = {}) {
    const rings = profile.map(([r]) => ngon(cu, cv, Math.max(r, 1e-4), n, phase));
    this.loft(mat, rings, profile.map(([, dy]) => y0 + dy), { smooth, st, top: profile[profile.length - 1][0] > 0.01 });
  }

  // Square-plan "imperial" dome over a tower of half-side a: profile of half-sides [[a, dy], ...]
  squareDome(mat, cu, cv, y0, profile) {
    this.dome(mat, cu, cv, y0, profile.map(([a, dy]) => [a * Math.SQRT2, dy]), 4, { phase: Math.PI / 4, smooth: false });
  }

  // Pitched roof over a rectangle; ridge along 'u' or 'v' (gable: ridge the full length; hip: inset by half the span)
  pitched(mat, u0, u1, v0, v1, y0, rise, { axis = 'u', hip = false, endMat = null, endStyle = null } = {}) {
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    let top;
    if (axis === 'u') {
      const e = hip ? Math.min((v1 - v0) / 2, (u1 - u0) / 2) : 0;
      top = [u0 + e, vc, u1 - e, vc, u1 - e, vc, u0 + e, vc];
    } else {
      const e = hip ? Math.min((u1 - u0) / 2, (v1 - v0) / 2) : 0;
      top = [uc, v0 + e, uc, v0 + e, uc, v1 - e, uc, v1 - e];
    }
    const ends = axis === 'u' ? [1, 3] : [0, 2];
    this.loft(mat, [rect(u0, u1, v0, v1), top], [y0, y0 + rise], {
      top: false,
      matOf: endMat && !hip ? (i) => (ends.includes(i) ? endMat : mat) : null,
      styleOf: endStyle && !hip ? (i) => (ends.includes(i) ? endStyle : null) : null
    });
  }

  // Mansard: steep lower slope from the ring (pushed out by `over`) to the ring inset by `inset`, `rise` metres up, then a
  // flat top (or a second, shallower stage up to the same ring inset by inset2 at rise2)
  mansard(mat, ring, y0, rise, inset, { over = 0.15, rise2 = 0, inset2 = 0 } = {}) {
    const outer = offsetRing(ring, -over) || ring;
    const inner = offsetRing(ring, inset);
    if (!inner) return false;
    if (rise2 > 0) {
      const crown = offsetRing(ring, inset + inset2);
      if (crown) {
        this.loft(mat, [outer, inner, crown], [y0, y0 + rise, y0 + rise + rise2]);
        return true;
      }
    }
    this.loft(mat, [outer, inner], [y0, y0 + rise]);
    return true;
  }

  // Lean-to roof over an aisle: low eave along v = vLow, high edge against the wall at v = vHigh
  shed(mat, u0, u1, vLow, vHigh, yLow, yHigh) {
    this.faceDir(mat, [[u0, yLow, vLow], [u1, yLow, vLow], [u1, yHigh, vHigh], [u0, yHigh, vHigh]], [0, 1, 0]);
    this.faceDir(mat, [[u0, yLow, vLow], [u0, yHigh, vHigh], [u0, yLow, vHigh]], [-1, 0, 0]);
    this.faceDir(mat, [[u1, yLow, vLow], [u1, yHigh, vHigh], [u1, yLow, vHigh]], [1, 0, 0]);
  }

  // Box from 8 corners (bottom four, then the top four above them), faces turned outwards
  hexa(mat, c) {
    const centre = [0, 0, 0];
    for (const p of c) for (let k = 0; k < 3; k++) centre[k] += p[k] / 8;
    const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    for (const q of quads) {
      const pts = q.map((k) => c[k]);
      const fc = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) fc[k] += p[k] / 4;
      this.faceDir(mat, pts, [fc[0] - centre[0], fc[1] - centre[1], fc[2] - centre[2]]);
    }
  }

  // Square beam between two points: w wide (horizontally), t thick (across, in the vertical plane through the axis)
  beam(mat, p0, p1, w, t) {
    const a = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const la = Math.hypot(...a) || 1;
    a[0] /= la; a[1] /= la; a[2] /= la;
    let side = [a[2], 0, -a[0]]; // a × up
    let ls = Math.hypot(side[0], side[2]);
    if (ls < 1e-6) { side = [1, 0, 0]; ls = 1; }
    side = [side[0] / ls, 0, side[2] / ls];
    const up = [side[1] * a[2] - side[2] * a[1], side[2] * a[0] - side[0] * a[2], side[0] * a[1] - side[1] * a[0]];
    const corner = (p, sa, sb) => [0, 1, 2].map((k) => p[k] + (side[k] * sa * w) / 2 + (up[k] * sb * t) / 2);
    this.hexa(mat, [corner(p0, -1, -1), corner(p0, 1, -1), corner(p0, 1, 1), corner(p0, -1, 1),
      corner(p1, -1, -1), corner(p1, 1, -1), corner(p1, 1, 1), corner(p1, -1, 1)]);
  }

  // Wall slab along a segment [u, v] -> [u, v], t thick, between y0 and y1
  wall(mat, a, b, t, y0, y1, st = null) {
    const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    const nu = (-dv / l) * (t / 2), nv = (du / l) * (t / 2);
    this.prism(mat, [a[0] - nu, a[1] - nv, b[0] - nu, b[1] - nv, b[0] + nu, b[1] + nv, a[0] + nu, a[1] + nv], y0, y1, st);
  }

  // Stone balustrade with a coping along a segment, standing on y
  balustrade(trim, tone, a, b, y, h = 1.0) {
    this.wall(this.facade, a, b, 0.26, y, y + h - 0.1, facadeStyle(WIN.balustrade, tone, { bay: 0.3, floor: h - 0.1, base: y }));
    this.wall(trim, a, b, 0.4, y + h - 0.12, y + h);
  }

  // Iron railing (top & bottom rails, bars every `step` m) along a segment
  railing(iron, a, b, y, h = 1.0, stepLen = 0.45) {
    const p = (q, yy) => [q[0], yy, q[1]];
    this.beam(iron, p(a, y + h), p(b, y + h), 0.06, 0.05);
    this.beam(iron, p(a, y + 0.12), p(b, y + 0.12), 0.04, 0.04);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(l / stepLen));
    for (let k = 0; k <= n; k++) {
      const t = k / n, q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      this.beam(iron, p(q, y), p(q, y + h), 0.025, 0.025);
    }
  }

  // Cornice: a fascia and an overhanging corona (soffit visible from below) round a ring at height y
  cornice(mat, ring, y, depth = 0.55, height = 0.6) {
    const fascia = offsetRing(ring, -depth * 0.4), corona = offsetRing(ring, -depth);
    if (fascia) this.prism(mat, fascia, y, y + height * 0.45, null, { top: false, bottom: true });
    if (corona) this.prism(mat, corona, y + height * 0.45, y + height, null, { bottom: true });
  }

  // Chimney stacks along the edges of a roof's flat crown (every ~spacing m, `inset` m in from its edge), where keep(u, v)
  // allows
  chimneys(mat, ring, y, { spacing = 9, inset = 0.9, h = 1.8, w = 0.7, d = 1.5, keep = null } = {}) {
    const r = ccwRing(ring), n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [r[2 * i], r[2 * i + 1]], b = [r[2 * j], r[2 * j + 1]];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const count = Math.floor(l / spacing);
      if (count < 1) continue;
      const du = (b[0] - a[0]) / l, dv = (b[1] - a[1]) / l;
      for (let q = 1; q <= count; q++) {
        const t = (q * l) / (count + 1);
        const cu = a[0] + du * t - dv * inset, cv = a[1] + dv * t + du * inset;
        if (keep && !keep(cu, cv)) continue;
        const e = (s) => [[cu - (du * s) / 2, cv - (dv * s) / 2], [cu + (du * s) / 2, cv + (dv * s) / 2]];
        this.wall(mat, ...e(d), w, y - 0.6, y + h);
        this.wall(mat, ...e(d + 0.2), w + 0.2, y + h, y + h + 0.15);
      }
    }
  }

  // Pinnacle: square shaft of half-side a from y0 to y1, then a slender pyramid of height `spire` with a knob
  pinnacle(mat, cu, cv, y0, y1, a, spire) {
    this.prism(mat, rect(cu - a, cu + a, cv - a, cv + a), y0, y1, null, { top: false });
    this.squareDome(mat, cu, cv, y1, [[a * 1.2, 0], [a * 1.2, 0.18], [0.03, spire]]);
  }

  // Dormer facing dir ('+u', '-u', '+v', '-v') whose front stands at (u, v): a stone front with one window, slate cheeks
  // and roof
  dormer(slate, tone, u, v, dir, y, { w = 1.5, h = 2.4, depth = 1.8, rise = 0.75 } = {}) {
    const front = facadeStyle(WIN.civic, tone, { bay: w, floor: h, ground: 0, base: y });
    const plain = facadeStyle(WIN.plain, tone, { base: y });
    const axis = dir[1];
    const sgn = dir[0] === '+' ? 1 : -1;
    let u0, u1, v0, v1, faces;
    if (axis === 'v') {
      u0 = u - w / 2; u1 = u + w / 2;
      v0 = sgn > 0 ? v - depth : v; v1 = sgn > 0 ? v : v + depth;
      faces = sgn > 0 ? [plain, plain, front, plain] : [front, plain, plain, plain];
    } else {
      v0 = v - w / 2; v1 = v + w / 2;
      u0 = sgn > 0 ? u - depth : u; u1 = sgn > 0 ? u : u + depth;
      faces = sgn > 0 ? [plain, front, plain, plain] : [plain, plain, plain, front];
    }
    this.box(this.facade, u0, u1, y, y + h, v0, v1, plain, { faces, top: false });
    const o = 0.12;
    const ou = axis === 'v' ? o : 0, ov = axis === 'u' ? o : 0;
    this.pitched(slate, u0 - ou, u1 + ou, v0 - ov, v1 + ov, y + h, rise, { axis, endMat: this.facade, endStyle: plain });
  }

  // Bake into world-space meshes (one per material)
  finish(name) {
    const { x, z, angle, ground } = this.frame;
    const c = Math.cos(angle), s = Math.sin(angle);
    const group = new THREE.Group();
    group.name = name;
    for (const [mat, b] of this.buckets) {
      const n = b.pos.length / 3;
      if (!n) continue;
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u = b.pos[3 * i], v = b.pos[3 * i + 2];
        pos[3 * i] = x + u * c - v * s;
        pos[3 * i + 1] = ground + b.pos[3 * i + 1];
        pos[3 * i + 2] = z + u * s + v * c;
        const nu = b.nrm[3 * i], nv = b.nrm[3 * i + 2];
        nrm[3 * i] = nu * c - nv * s;
        nrm[3 * i + 1] = b.nrm[3 * i + 1];
        nrm[3 * i + 2] = nu * s + nv * c;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      if (b.fac) {
        geo.setAttribute('facade', new THREE.BufferAttribute(new Float32Array(b.fac), 4));
        geo.setAttribute('fstyle', new THREE.BufferAttribute(new Float32Array(b.sty), 4));
      }
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `${name}:${mat === this.facade ? 'facade' : mat.name || 'part'}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    group.matrixAutoUpdate = false;
    return group;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Donostiako Udaletxea
// ---------------------------------------------------------------------------------------------------------------------

// Frame (from the OSM outline): +u runs west-south-west along the main body towards the bay, +v north-north-west towards
// the harbour, so the gardens front faces -v. Plan positions below are metres in that frame from the outline's centre.
const FRONT_DIR = [-0.885, 0.465];

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, FRONT_DIR, { front: [1.0, -29.5] });
  const m = new CivicModel(frame);
  const F = m.facade, trim = materials.limestone, slate = materials.slate, zinc = materials.zinc;
  const P = frame.plinth;
  const T = TONE.cream;

  // Ground floor 5 m, main floor and upper floor 4.2 m: eaves at 13.4 m as b5m measures
  const civic = facadeStyle(WIN.civic, T, { bay: 4.3, ground: 5.0, floor: 4.2 });
  const arcade = facadeStyle(WIN.arcade, T, { bay: 3.2, ground: 5.0, floor: 4.6 });
  const hall = facadeStyle(WIN.arcade, T, { bay: 3.6, ground: 4.0, floor: 7.6 });
  const towerStyle = facadeStyle(WIN.civic, T, { bay: 2.6, ground: 5.0, floor: 4.2 });

  // [u0, u1, v0, v1, eave]: wings, inner wings, central body, end pavilions
  const wings = [[-37.5, -21.4, -20.5, 0.3, 13.4], [22.7, 38.3, -20.4, 0.6, 13.4]];
  const inner = [[-21.4, -8.6, -24.0, 2.9, 14.2], [10.7, 22.7, -23.8, 3.1, 14.2]];
  const centre = [-8.6, 10.7, -23.9, 3.0, 14.6];
  const pavilions = [[-45.6, -37.4, -24.0, 3.0, 15.4], [38.2, 47.0, -24.2, 3.3, 15.4]];
  const bays = [[-48.4, -45.5, -14.0, -6.9], [46.9, 48.4, -15.0, -6.0]];

  for (const [u0, u1, v0, v1, eave] of [...wings, ...inner, ...pavilions]) {
    m.box(F, u0, u1, P, eave, v0, v1, civic);
    m.cornice(trim, rect(u0, u1, v0, v1), eave, 0.55, 0.6);
    m.prism(trim, offsetRing(rect(u0, u1, v0, v1), -0.12), 4.85, 5.15, null, { bottom: true, top: false });
  }
  // Wing roofs: low slate mansards behind a balustrade on the gardens front, with a dormer over every other bay
  for (const [u0, u1, v0, v1, eave] of [...wings, ...inner]) {
    const y = eave + 0.6;
    m.mansard(slate, rect(u0, u1, v0, v1), y, 3.2, 1.25);
    m.chimneys(trim, offsetRing(rect(u0, u1, v0, v1), 1.25), y + 3.2, { spacing: 7, inset: 0.9, h: 1.5 });
    m.balustrade(trim, T, [u0, v0 - 0.3], [u1, v0 - 0.3], y);
    const n = Math.max(1, Math.round((u1 - u0) / 4.3));
    for (let k = 0; k < n; k++) {
      if (k % 2) continue;
      const u = u0 + ((k + 0.5) * (u1 - u0)) / n;
      m.dormer(slate, T, u, v0 - 0.05, '-v', y + 0.3, { w: 1.4, h: 2.0, depth: 1.6 });
    }
  }

  // Central body: the entrance between the towers, round-arched; a pediment over it and a glazed lantern lighting the
  // staircase hall
  {
    const [u0, u1, v0, v1, eave] = centre;
    m.box(F, u0, u1, P, eave, v0, v1, civic, { faces: [arcade, civic, civic, civic] });
    m.cornice(trim, rect(u0, u1, v0, v1), eave, 0.55, 0.6);
    m.mansard(slate, rect(u0, u1, v0 + 2.5, v1), eave + 0.6, 3.0, 1.2);
    m.box(F, -3.6, 5.7, eave, eave + 2.2, v0 - 0.3, v0 + 1.2, facadeStyle(WIN.plain, T));
    m.cornice(trim, rect(-3.6, 5.7, v0 - 0.3, v0 + 1.2), eave + 2.2, 0.4, 0.45);
    m.pitched(trim, -3.9, 6.0, v0 - 0.7, v0 + 1.2, eave + 2.65, 1.7, { axis: 'v' });
    m.dome(zinc, 1.05, v0 - 0.1, eave + 4.35, [[0.35, 0], [0.5, 0.5], [0.12, 1.4], [0.02, 1.9]], 8);
    m.loft(materials.glass, [rect(-2.4, 4.4, -17.0, -4.0), rect(0.7, 1.3, -11.0, -10.0)], [eave + 3.6, eave + 5.6]);
    m.prism(zinc, rect(-2.6, 4.6, -17.2, -3.8), eave + 3.3, eave + 3.6);
    // entrance steps
    m.box(trim, -3.4, 5.5, P, 0.25, v0 - 3.0, v0, null);
    m.box(trim, -3.4, 5.5, P, 0.5, v0 - 2.0, v0, null);
    m.box(trim, -3.4, 5.5, P, 0.75, v0 - 1.0, v0, null);
  }

  // The two towers flanking the entrance: three storeys and an arcaded belvedere to 20.6 m, then a slate imperial dome
  // and a lantern; b5m's 25.3 m maximum is the dome tops
  const belvedere = facadeStyle(WIN.arcade, T, { bay: 2.6, ground: 0, floor: 3.0, base: 17.6 });
  for (const [u0, u1] of [[-8.8, -3.6], [5.7, 10.9]]) {
    const v0 = -26.5, v1 = -21.4, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, a = (u1 - u0) / 2;
    m.box(F, u0, u1, P, 17.6, v0, v1, towerStyle, { top: false });
    m.box(F, u0 + 0.2, u1 - 0.2, 17.6, 20.6, v0 + 0.2, v1 - 0.2, belvedere);
    m.cornice(trim, rect(u0, u1, v0, v1), 14.6, 0.35, 0.45);
    m.cornice(trim, rect(u0, u1, v0, v1), 17.3, 0.3, 0.3);
    m.cornice(trim, rect(u0, u1, v0, v1), 20.6, 0.45, 0.55);
    m.prism(trim, offsetRing(rect(u0, u1, v0, v1), -0.12), 4.9, 5.2, null, { bottom: true, top: false });
    m.squareDome(slate, cu, cv, 21.15,
      [[a + 0.15, 0], [a + 0.15, 0.4], [a, 1.2], [a * 0.82, 2.1], [a * 0.58, 2.9], [a * 0.3, 3.4], [0.5, 3.5]]);
    m.prism(zinc, rect(cu - 0.5, cu + 0.5, cv - 0.5, cv + 0.5), 24.65, 25.4, null, { top: false });
    m.squareDome(zinc, cu, cv, 25.4, [[0.7, 0], [0.7, 0.15], [0.05, 0.8]]);
    m.beam(materials.iron, [cu, 26.1, cv], [cu, 27.2, cv], 0.08, 0.08);
  }

  // End pavilions: a storey taller, under steep slate pavilion roofs with an iron cresting; a bay window on each end with a
  // balustraded terrace
  for (const [u0, u1, v0, v1, eave] of pavilions) {
    const y = eave + 0.6;
    const r = rect(u0, u1, v0, v1), top = offsetRing(r, 2.3);
    m.loft(slate, [offsetRing(r, -0.15), offsetRing(r, 1.1), top], [y, y + 3.8, y + 4.6]);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      m.railing(materials.iron, [top[2 * k], top[2 * k + 1]], [top[2 * j], top[2 * j + 1]], y + 4.6, 0.6, 0.6);
    }
    const n = Math.max(1, Math.round((u1 - u0) / 4.3));
    for (let k = 0; k < n; k++) {
      const u = u0 + ((k + 0.5) * (u1 - u0)) / n;
      m.dormer(slate, T, u, v0 - 0.05, '-v', y + 0.3, { w: 1.5, h: 2.2, depth: 1.7 });
      m.dormer(slate, T, u, v1 + 0.05, '+v', y + 0.3, { w: 1.5, h: 2.2, depth: 1.7 });
    }
    // the long end facade over the bay window
    const outer = u0 < 0 ? u0 - 0.05 : u1 + 0.05;
    const ne = Math.max(1, Math.round((v1 - v0) / 4.3));
    for (let k = 0; k < ne; k++) {
      const v = v0 + ((k + 0.5) * (v1 - v0)) / ne;
      m.dormer(slate, T, outer, v, u0 < 0 ? '-u' : '+u', y + 0.3, { w: 1.5, h: 2.2, depth: 1.7 });
    }
  }
  for (const [u0, u1, v0, v1] of bays) {
    m.box(F, u0, u1, P, 9.2, v0, v1, civic);
    m.cornice(trim, rect(u0, u1, v0, v1), 9.2, 0.35, 0.4);
    const out = u0 < 0 ? u0 - 0.2 : u1 + 0.2;
    const back = u0 < 0 ? u1 : u0;
    m.balustrade(trim, T, [back, v0 - 0.2], [out, v0 - 0.2], 9.6);
    m.balustrade(trim, T, [out, v0 - 0.2], [out, v1 + 0.2], 9.6);
    m.balustrade(trim, T, [out, v1 + 0.2], [back, v1 + 0.2], 9.6);
  }

  // The old ballroom (Salón de Plenos) behind: tall arched windows round its apsidal sides, a hipped slate roof and a
  // glazed ridge lantern
  {
    const ring = [-8.5, 2.5, -8.6, 8.7, -10.5, 8.8, -12.7, 11.4, -12.6, 18.1, -10.3, 20.5, -8.6, 20.5, -8.6, 26.4,
      10.2, 26.5, 10.2, 20.3, 11.7, 20.4, 14.3, 17.6, 14.2, 11.5, 11.8, 8.6, 10.2, 8.6, 10.3, 2.5];
    m.prism(F, ring, P, 13.0, hall);
    m.cornice(trim, ring, 13.0, 0.5, 0.55);
    m.pitched(slate, -8.9, 10.5, 2.5, 26.8, 13.55, 4.0, { axis: 'v', hip: true });
    m.loft(materials.glass, [rect(-0.9, 2.5, 11.0, 18.0), rect(0.6, 1.0, 11.4, 17.6)], [16.9, 18.3]);
  }

  return m.finish('Udaletxea');
}
