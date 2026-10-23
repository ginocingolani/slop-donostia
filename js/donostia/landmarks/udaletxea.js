import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot, clamp, length, atan,
  select, fwidth, pow, normalize, positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { ringArea, reverseRing, insetRing, newell } from './geom.js';

// js/donostia/landmarks/udaletxea.js
// Donostiako Udaletxea — the City Hall, built 1882-87 as the Gran Casino (Luis Aladrén & Adolfo Morales de los Ríos,
// after the Monte Carlo casino; a casino until gambling was banned in 1924, the City Hall since the 1940s): an eclectic
// Belle Époque palace of golden sandstone. A central body with two slender towers flanking the entrance faces the
// Alderdi Eder gardens (their footprints are the two small projections either side of the entrance in the OSM outline);
// wings run out through galleries to end pavilions, and the old ballroom (now the Salón de Plenos) projects behind
// towards the harbour. The municipal heritage catalogue (PEPPUC, grado A) describes "un cuerpo central y dos laterales
// unidos por galerías"; b5m measures the body at 13.4-15.6 m.
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

// Stone of each landmark: the cream ashlar of the City Hall, a white stone, a pale ochre, the Igeldo sandstone of the
// Buen Pastor, and the golden sandstone that the photographs show on the Victoria Eugenia (golden) and the María
// Cristina (honey, a shade paler), cut from the same quarries
export const TONE = { cream: 0, white: 1, ochre: 2, sandstone: 3, golden: 4, honey: 5 };
const TONES = [[0.85, 0.79, 0.67], [0.9, 0.88, 0.83], [0.84, 0.75, 0.6], [0.47, 0.39, 0.29], [0.69, 0.49, 0.23],
  [0.72, 0.53, 0.27]];

// What the shader draws on a wall: plain ashlar; Belle Époque windows (arched on the ground & main floors, square-headed
// above); round-arched openings throughout; pointed lancets with tracery & stained glass; a balustrade; rusticated
// masonry; a rose window; tall French windows (flats); a grand hotel's (round-arched on a rusticated ground floor, tall
// French windows with net curtains above); square-headed windows throughout; a palace's (square-headed on the ground
// floor and above, round-arched on the main floor). CAP marks horizontal faces (no coursing).
export const WIN = {
  plain: 0, civic: 1, arcade: 2, lancet: 3, balustrade: 4, rusticated: 5, rose: 6, residential: 7, hotel: 8, square: 9,
  palace: 10, cap: 15
};

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
  const kHotel = isKind(WIN.hotel), kSquare = isKind(WIN.square), kPalace = isKind(WIN.palace);
  const kRect = kCivic.add(kSquare).add(kPalace); // the kinds sharing the civic window's proportions
  const hasWin = kCivic.add(kArcade).add(kLancet).add(kRes).add(kHotel).add(kSquare).add(kPalace);
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
  const halfFrac = kRect.mul(mix(mix(float(0.22), float(0.25), noble), float(0.28), g))
    .add(kHotel.mul(mix(float(0.19), float(0.27), g)))
    .add(kArcade.mul(mix(float(0.33), float(0.36), g)))
    .add(kLancet.mul(0.22))
    .add(kRes.mul(mix(float(0.2), float(0.3), g)));
  const halfW = halfFrac.mul(bayW);
  const sill = kRect.mul(mix(mix(float(0.28), float(0.2), noble).mul(storeyH), float(0.45), g))
    .add(kHotel.mul(mix(storeyH.mul(0.08), float(0.5), g)))
    .add(kArcade.mul(mix(storeyH.mul(0.16), float(0.0), g)))
    .add(kLancet.mul(mix(storeyH.mul(0.22), float(0.0), g)))
    .add(kRes.mul(mix(storeyH.mul(0.05), float(0.0), g)));
  const head = kRect.mul(mix(mix(float(0.8), float(0.88), noble).mul(storeyH), storeyH.sub(0.5), g))
    .add(kHotel.mul(mix(storeyH.mul(0.84), storeyH.sub(0.45), g)))
    .add(kArcade.mul(mix(storeyH.mul(0.9), storeyH.sub(0.35), g)))
    .add(kLancet.mul(storeyH.mul(mix(float(0.92), float(0.85), g))))
    .add(kRes.mul(mix(storeyH.mul(0.8), storeyH.sub(0.6), g)));
  const arch = kCivic.mul(max(noble, g)).add(kPalace.mul(noble)).add(kArcade).add(kLancet.mul(2.0)).add(kHotel.mul(g));
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
  const rustZone = max(kRust, g.mul(kRect.add(kArcade).add(kRes).add(kHotel))).mul(float(1).sub(kCap));
  const groove = lineAA(abs(fract(h.div(0.6).add(0.5)).sub(0.5)).mul(0.6), 0.045)
    .mul(float(1).sub(smoothstep(0.03, 0.1, pix)));
  const band = float(1).sub(smoothstep(0.3, pix.add(0.3), py)).mul(float(1).sub(g))
    .mul(kRect.add(kArcade).add(kRes).add(kHotel)).mul(step(0.0, h));
  const wall = stone.mul(grain)
    .mul(float(1).sub(joint.mul(0.2)))
    .mul(float(1).sub(groove.mul(rustZone).mul(0.42)))
    .mul(float(1).add(band.mul(0.07)))
    .mul(float(1).add(surround.mul(0.1)));
  const wallWithGaps = mix(wall, stone.mul(0.14), gap);

  // Glass: dark panes with a sky-tinted Fresnel sheen; stained glass in lancets & roses (dark by day, glowing at night)
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const plainGlass = mix(vec3(0.05, 0.065, 0.08), cityUniforms.uSkyHorizonColor.mul(0.6), fres.mul(0.8).add(0.06));
  const cellRect = floor(vec2(px.div(0.32), py.div(0.42)));
  const cellRose = floor(vec2(sector, rr.div(0.6)));
  const cell = select(kRose.greaterThan(0.5), cellRose, cellRect);
  const hs = fract(sin(dot(cell.add(seed.mul(3.7)), vec2(12.9898, 78.233))).mul(43758.5453));
  const stained = select(hs.lessThan(0.42), vec3(0.12, 0.2, 0.62), select(hs.lessThan(0.66), vec3(0.62, 0.1, 0.1),
    select(hs.lessThan(0.86), vec3(0.7, 0.5, 0.12), vec3(0.14, 0.42, 0.2))));
  // the hotel's net curtains, drawn behind its upper windows' glass
  const curtain = kHotel.mul(float(1).sub(g)).mul(0.72);
  // stained glass reads dark from outside by day, its colours only faintly through the reflections
  const glassCol = mix(mix(plainGlass, vec3(0.62, 0.61, 0.57), curtain), stained.mul(0.05).add(plainGlass.mul(0.8)), isStained);
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
  // (offices, foyers and hotel rooms: the night photographs show most windows dark or dimly lit behind curtains)
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.26), 0.0, 0.5);
  const lit = step(hw, litShare).mul(paneMask).mul(float(1).sub(isStained));
  const warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.85, 0.7), fract(hw.mul(13.1)));
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  const stainedGlow = stained.mul(paneMask).mul(isStained).mul(night).mul(0.9);
  // floodlights wash the stone a pale warm cream (night photographs), not the stone's own deep gold
  const flood = mix(stone, vec3(0.85, 0.8, 0.7), 0.35).mul(vec3(1.0, 0.88, 0.7)).mul(night).mul(0.15).mul(float(1).sub(paneMask));
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(1.1).add(stainedGlow).add(flood);

  facadeMaterial = mat;
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rings (flat [u0, v0, u1, v1, ...] in the landmark frame)
// ---------------------------------------------------------------------------------------------------------------------

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

// Miter offset of a ring of either winding by d towards its inside (d < 0: outwards): geom.js's insetRing on the
// counter-wound ring, null when the offset folds an edge over or collapses the ring
export function offsetRing(ring, d) {
  return insetRing(ccwRing(ring), d);
}

// ---------------------------------------------------------------------------------------------------------------------
// The geometry builder
// ---------------------------------------------------------------------------------------------------------------------

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
  // tone: the stone of the parts built in the facade material without a style of their own (cornices, copings...)
  constructor(frame, { tone = 0 } = {}) {
    this.frame = frame;
    this.tone = tone;
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
      let style = st || facadeStyle(WIN.plain, this.tone);
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

  // A face turned to look along dir (any winding in). The first point stays first: face() fans from it, so a polygon
  // that is only star-shaped from its first point (an arch's spandrel) still triangulates right.
  faceDir(mat, pts, dir, st = null) {
    const n = newell(pts);
    if (!n) return;
    if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) pts = [pts[0], ...pts.slice(1).reverse()];
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

  // Open arcade along a segment [u, v] -> [u, v]: n round arches (springing at `spring`) between n + 1 piers `pier` wide,
  // in a wall `depth` thick from y0 to yTop, open right through (a belvedere's loggia shows the sky). Each face is cut
  // into piers and spandrels, the spandrel over each half arch a fan from its top corner; soffits and jambs line the
  // openings.
  openArcade(mat, a, b, y0, spring, yTop, n, { depth = 0.6, pier = 0.5, st = null, segments = 6 } = {}) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const du = (b[0] - a[0]) / L, dv = (b[1] - a[1]) / L;
    const nu = dv, nv = -du; // one side's normal
    const span = (L - (n + 1) * pier) / n, r = span / 2;
    if (span <= 0.2 || yTop < spring + r + 0.05) return;
    const P = (s, y, side) => [a[0] + du * s + nu * side * depth / 2, y, a[1] + dv * s + nv * side * depth / 2];
    const arcPt = (xc, t, side) => P(xc + r * Math.cos(t), spring + r * Math.sin(t), side);
    for (const side of [-1, 1]) {
      const out = [nu * side, 0, nv * side];
      for (let k = 0; k <= n; k++) {
        const s0 = k * (pier + span);
        this.faceDir(mat, [P(s0, y0, side), P(s0 + pier, y0, side), P(s0 + pier, yTop, side), P(s0, yTop, side)], out, st);
      }
      for (let j = 0; j < n; j++) {
        const x0 = pier + j * (pier + span), xc = x0 + r, x1 = x0 + span;
        const left = [P(x0, yTop, side), P(x0, spring, side)];
        const right = [P(x1, yTop, side), P(x1, spring, side)];
        for (let q = 1; q <= segments; q++) {
          left.push(arcPt(xc, Math.PI - (q * Math.PI) / (2 * segments), side));
          right.push(arcPt(xc, (q * Math.PI) / (2 * segments), side));
        }
        left.push(P(xc, yTop, side));
        right.push(P(xc, yTop, side));
        this.faceDir(mat, left, out, st);
        this.faceDir(mat, right, out, st);
      }
    }
    for (let j = 0; j < n; j++) {
      const x0 = pier + j * (pier + span), xc = x0 + r, x1 = x0 + span;
      // jambs, facing into the opening, and the soffit under the arch, facing its centre
      this.faceDir(mat, [P(x0, y0, -1), P(x0, y0, 1), P(x0, spring, 1), P(x0, spring, -1)], [du, 0, dv], st);
      this.faceDir(mat, [P(x1, y0, -1), P(x1, y0, 1), P(x1, spring, 1), P(x1, spring, -1)], [-du, 0, -dv], st);
      for (let q = 0; q < 2 * segments; q++) {
        const t0 = Math.PI - (q * Math.PI) / (2 * segments), t1 = Math.PI - ((q + 1) * Math.PI) / (2 * segments);
        const tm = (t0 + t1) / 2;
        this.faceDir(mat, [arcPt(xc, t0, -1), arcPt(xc, t1, -1), arcPt(xc, t1, 1), arcPt(xc, t0, 1)],
          [-Math.cos(tm) * du, -Math.sin(tm), -Math.cos(tm) * dv], st);
      }
    }
    // ends and top
    this.faceDir(mat, [P(0, y0, -1), P(0, y0, 1), P(0, yTop, 1), P(0, yTop, -1)], [-du, 0, -dv], st);
    this.faceDir(mat, [P(L, y0, -1), P(L, y0, 1), P(L, yTop, 1), P(L, yTop, -1)], [du, 0, dv], st);
    this.faceDir(mat, [P(0, yTop, -1), P(L, yTop, -1), P(L, yTop, 1), P(0, yTop, 1)], [0, 1, 0], st);
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
//
// What the photographs show (Wikimedia Commons: the 2019 panorama from Alderdi Eder, the frontal view of the entrance,
// the night views): every part shares one cornice line at about 14.6 m over a tall ground floor of square-headed
// windows and a 6 m main floor of round-arched windows on balconies (pedimented ones on the wings beside the towers, an
// open arcade on the galleries). Over the entrance, three arched doors under three arched windows, a lettered frieze, an
// attic with a clock in an aedicule and, behind it, a slate dome over the staircase. The towers rise to twice the cornice
// (scaled from the panorama: their top cornice at ~28.8 m, the slate domes to ~31 m, ball and weathervane to ~34 m)
// through a storey of paired arched windows, a balcony, an open arched belfry and a deep bracketed cornice. The end
// pavilions are crowned by segmental gables over great arched windows, with small slate domes and lanterns beside them
// over the galleries' ends; the roofs behind the cornices are low.
const FRONT_DIR = [-0.885, 0.465];
const GF = 5.0, MAIN = 6.0, EAVE = 14.6; // ground floor, main floor, the common cornice

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, FRONT_DIR, { front: [1.0, -29.5] });
  const T = TONE.golden;
  const m = new CivicModel(frame, { tone: T });
  const F = m.facade, slate = materials.slate, zinc = materials.zinc, iron = materials.iron;
  const P = frame.plinth;

  const plain = facadeStyle(WIN.plain, T);
  const palace = facadeStyle(WIN.palace, T, { bay: 4.3, ground: GF, floor: MAIN });
  const galleryLow = facadeStyle(WIN.square, T, { bay: 3.2, ground: GF, floor: MAIN });
  const gallery = facadeStyle(WIN.arcade, T, { bay: 3.2, ground: 0, floor: MAIN, base: GF });

  // a balcony under a main-floor window: slab and balustrade standing out of a wall facing -v
  const balcony = (u, v, w = 2.4) => {
    m.box(F, u - w / 2, u + w / 2, GF - 0.05, GF + 0.2, v - 0.6, v, null, { bottom: true });
    m.balustrade(F, T, [u - w / 2, v - 0.5], [u + w / 2, v - 0.5], GF + 0.2, 0.9);
  };
  // a segmental gable (a slab whose top is an arc) standing on y along a wall facing -v, from u0 to u1
  const segmentalGable = (u0, u1, v, y, rise, depth = 0.6) => {
    const half = (u1 - u0) / 2, uc = (u0 + u1) / 2;
    const R = (half * half + rise * rise) / (2 * rise), a = Math.asin(half / R);
    const arcPts = (vv) => {
      const pts = [];
      for (let k = 0; k <= 10; k++) {
        const t = -a + (2 * a * k) / 10;
        pts.push([uc + R * Math.sin(t), y + rise - R + R * Math.cos(t), vv]);
      }
      return pts;
    };
    const front = arcPts(v), back = arcPts(v + depth);
    m.faceDir(F, [[uc, y, v], ...front], [0, 0, -1], plain);
    m.faceDir(F, [[uc, y, v + depth], ...back], [0, 0, 1], plain);
    for (let k = 0; k < 10; k++) {
      const t = -a + (2 * a * (k + 0.5)) / 10;
      m.faceDir(F, [front[k], front[k + 1], back[k + 1], back[k]], [Math.sin(t), Math.cos(t), 0], plain);
    }
    // a moulded edge along the arc
    for (let k = 0; k < 10; k++) {
      const p0 = [front[k][0], front[k][1] + 0.15, v - 0.15], p1 = [front[k + 1][0], front[k + 1][1] + 0.15, v - 0.15];
      m.beam(F, p0, p1, 0.35, 0.3);
    }
  };

  // --- the wings beside the towers (pedimented windows on balconies) and the galleries beyond --------------------------
  const inner = [[-21.4, -8.6, -24.0, 2.9], [10.7, 22.7, -23.8, 3.1]];
  const galleries = [[-37.5, -21.4, -20.5, 0.3], [22.7, 38.3, -20.4, 0.6]];
  for (const [u0, u1, v0, v1] of inner) {
    m.box(F, u0, u1, P, EAVE, v0, v1, palace, { top: false });
    m.cornice(F, rect(u0, u1, v0, v1), EAVE, 0.6, 0.65);
    m.prism(F, offsetRing(rect(u0, u1, v0, v1), -0.12), GF - 0.15, GF + 0.15, null, { bottom: true, top: false });
    m.pitched(slate, u0 + 0.3, u1 - 0.3, v0 + 0.3, v1 - 0.3, EAVE + 0.6, 2.6, { axis: 'u', hip: true });
    m.balustrade(F, T, [u0, v0 - 0.35], [u1, v0 - 0.35], EAVE + 0.65, 0.9);
    const n = Math.max(1, Math.round((u1 - u0) / 4.3)), bw = (u1 - u0) / n;
    for (let k = 0; k < n; k++) {
      const u = u0 + (k + 0.5) * bw;
      balcony(u, v0);
      m.pitched(F, u - 1.35, u + 1.35, v0 - 0.45, v0 + 0.02, GF + MAIN * 0.88 + 0.35, 0.75, { axis: 'v', endStyle: plain });
    }
  }
  for (const [u0, u1, v0, v1] of galleries) {
    m.box(F, u0, u1, P, GF, v0, v1, galleryLow, { faces: [galleryLow, palace, palace, palace], top: false });
    m.box(F, u0, u1, GF, EAVE - 0.4, v0, v1, palace, { faces: [gallery, plain, plain, plain], top: false });
    m.prism(F, offsetRing(rect(u0, u1, v0, v1), -0.12), GF - 0.15, GF + 0.15, null, { bottom: true, top: false });
    m.cornice(F, rect(u0, u1, v0, v1), EAVE - 0.4, 0.6, 0.65);
    m.pitched(slate, u0 + 0.3, u1 - 0.3, v0 + 0.3, v1 - 0.3, EAVE + 0.2, 2.4, { axis: 'u', hip: true });
    m.balustrade(F, T, [u0, v0 - 0.35], [u1, v0 - 0.35], EAVE + 0.25, 0.9);
    // the small slate dome and lantern over the gallery's outer end
    const cu = u0 < 0 ? u0 + 4.6 : u1 - 4.6, cv = (v0 + v1) / 2 - 2.0, a = 3.0;
    m.box(F, cu - a, cu + a, EAVE + 0.2, EAVE + 2.0, cv - a, cv + a, plain, { top: false });
    m.cornice(F, rect(cu - a, cu + a, cv - a, cv + a), EAVE + 2.0, 0.3, 0.35);
    m.squareDome(slate, cu, cv, EAVE + 2.35, [[a + 0.2, 0], [a, 0.7], [a * 0.8, 1.7], [a * 0.5, 2.5], [0.75, 3.0]]);
    m.box(F, cu - 0.7, cu + 0.7, EAVE + 5.35, EAVE + 6.4, cv - 0.7, cv + 0.7, plain, { top: false });
    m.squareDome(zinc, cu, cv, EAVE + 6.4, [[0.9, 0], [0.9, 0.12], [0.05, 0.9]]);
  }

  // --- the central body: three arched doors under three arched windows, the frieze, the attic and the clock; the slate
  // dome over the staircase behind -------------------------------------------------------------------------------------
  {
    const u0 = -8.6, u1 = 10.7, v0 = -23.9, v1 = 3.0, cu = 1.05;
    m.box(F, u0, u1, P, EAVE, v0, v1, palace, { faces: [plain, palace, palace, palace], top: false });
    const front = facadeStyle(WIN.civic, T, { bay: 3.1, ground: GF, floor: MAIN });
    m.box(F, -3.6, 5.7, P, EAVE, v0 - 0.3, v0 + 0.2, plain, { faces: [front, plain, plain, plain], top: false });
    m.cornice(F, rect(u0, u1, v0 - 0.3, v1), EAVE, 0.6, 0.65);
    m.prism(F, offsetRing(rect(-3.6, 5.7, v0 - 0.3, v1), -0.12), GF - 0.15, GF + 0.15, null, { bottom: true, top: false });
    for (const u of [-2.05, 1.05, 4.15]) balcony(u, v0 - 0.3, 2.2);
    m.pitched(slate, u0 + 0.3, u1 - 0.3, v0 + 2.0, v1 - 0.3, EAVE + 0.6, 2.4, { axis: 'u', hip: true });
    // attic over the entrance and the clock's aedicule with its pinnacles
    const a0 = EAVE + 0.65, a1 = EAVE + 1.9;
    m.box(F, -3.6, 5.7, a0, a1, v0 - 0.3, v0 + 1.0, plain);
    m.cornice(F, rect(-3.6, 5.7, v0 - 0.3, v0 + 1.0), a1, 0.25, 0.3);
    const c0 = a1 + 0.3, c1 = c0 + 2.7;
    m.box(F, cu - 1.9, cu + 1.9, c0, c1, v0 - 0.35, v0 + 1.2, plain, { top: false });
    m.cornice(F, rect(cu - 1.9, cu + 1.9, v0 - 0.35, v0 + 1.2), c1, 0.3, 0.4);
    segmentalGable(cu - 2.1, cu + 2.1, v0 - 0.55, c1 + 0.4, 0.7, 1.7);
    for (const du of [-1.9, 1.9]) m.pinnacle(F, cu + du, v0 - 0.2, c1 + 0.4, c1 + 0.8, 0.2, 1.1);
    const clock = [];
    for (let k = 0; k < 20; k++) clock.push([cu + 0.95 * Math.cos((k * Math.PI) / 10), c0 + 1.35 + 0.95 * Math.sin((k * Math.PI) / 10), v0 - 0.38]);
    m.faceDir(materials.whiteIron, clock, [0, 0, -1]);
    // the staircase dome: a short drum, the slate dome and its glazed lantern
    const dv = -13.5, r = 4.8, d0 = EAVE + 1.6;
    m.prism(F, ngon(cu, dv, r, 8, Math.PI / 8), EAVE + 0.6, d0, plain, { top: false });
    m.dome(slate, cu, dv, d0, [[r + 0.15, 0], [r, 0.5], [r * 0.86, 1.6], [r * 0.6, 2.6], [r * 0.3, 3.15], [1.0, 3.3]], 8,
      { phase: Math.PI / 8, smooth: false });
    m.prism(materials.glass, ngon(cu, dv, 0.95, 8, Math.PI / 8), d0 + 3.3, d0 + 4.2, null, { top: false });
    m.dome(zinc, cu, dv, d0 + 4.2, [[1.15, 0], [1.1, 0.15], [0.05, 0.9]], 8, { phase: Math.PI / 8 });
    // entrance steps
    m.box(F, -3.4, 5.5, P, 0.25, v0 - 3.3, v0 - 0.3, null);
    m.box(F, -3.4, 5.5, P, 0.5, v0 - 2.3, v0 - 0.3, null);
    m.box(F, -3.4, 5.5, P, 0.75, v0 - 1.3, v0 - 0.3, null);
  }

  // --- the towers ---------------------------------------------------------------------------------------------------
  const lower = facadeStyle(WIN.palace, T, { bay: 2.6, ground: GF, floor: MAIN });
  for (const [u0, u1] of [[-8.8, -3.6], [5.7, 10.9]]) {
    const v0 = -26.5, v1 = -21.4, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const ring = (d) => rect(u0 + d, u1 - d, v0 + d, v1 - d);
    m.box(F, u0, u1, P, EAVE, v0, v1, lower, { top: false });
    m.prism(F, offsetRing(ring(0), -0.12), GF - 0.15, GF + 0.15, null, { bottom: true, top: false });
    m.cornice(F, ring(0), EAVE, 0.6, 0.65);
    // a storey of paired arched windows
    const y1 = EAVE + 0.65, y2 = y1 + 4.0;
    m.prism(F, ring(0.15), y1, y2, facadeStyle(WIN.arcade, T, { bay: 2.4, ground: 0, floor: 3.9, base: y1 }), { top: false });
    m.cornice(F, ring(0.15), y2, 0.35, 0.45);
    // the band and the balcony all round
    const y3 = y2 + 0.45, y4 = y3 + 1.4;
    m.prism(F, ring(0.3), y3, y4, plain, { top: false });
    m.prism(F, offsetRing(ring(0), -0.25), y4, y4 + 0.3, null, { bottom: true });
    const g = offsetRing(ring(0), -0.15);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      m.balustrade(F, T, [g[2 * k], g[2 * k + 1]], [g[2 * j], g[2 * j + 1]], y4 + 0.3, 0.95);
    }
    // the open belfry: one round arch through each face
    const b0 = y4 + 0.3, bTop = b0 + 4.4, d = 0.6, bu0 = u0 + 0.35, bu1 = u1 - 0.35, bv0 = v0 + 0.35, bv1 = v1 - 0.35;
    const span = 2.3, pierU = (bu1 - bu0 - span) / 2, pierV = (bv1 - bv0 - 2 * d - span) / 2;
    const spring = bTop - 0.6 - span / 2;
    m.openArcade(F, [bu0, bv0 + d / 2], [bu1, bv0 + d / 2], b0, spring, bTop, 1, { depth: d, pier: pierU });
    m.openArcade(F, [bu0, bv1 - d / 2], [bu1, bv1 - d / 2], b0, spring, bTop, 1, { depth: d, pier: pierU });
    m.openArcade(F, [bu0 + d / 2, bv0 + d], [bu0 + d / 2, bv1 - d], b0, spring, bTop, 1, { depth: d, pier: pierV });
    m.openArcade(F, [bu1 - d / 2, bv0 + d], [bu1 - d / 2, bv1 - d], b0, spring, bTop, 1, { depth: d, pier: pierV });
    m.box(F, bu0 + d, bu1 - d, b0, b0 + 0.1, bv0 + d, bv1 - d, null);
    // the deep bracketed cornice and frieze, the slate dome, ball and weathervane
    const c0 = bTop;
    m.cornice(F, ring(0.35), c0, 0.45, 0.5);
    m.prism(F, ring(0.1), c0 + 0.5, c0 + 1.6, plain, { top: false });
    m.cornice(F, ring(0.1), c0 + 1.6, 0.75, 0.85);
    const top = c0 + 2.45, a = (u1 - u0) / 2;
    m.dome(slate, cu, cv, top, [[a * 0.95, 0], [a * 0.93, 0.5], [a * 0.82, 1.3], [a * 0.6, 2.0], [a * 0.3, 2.45], [0.2, 2.55]], 12);
    m.dome(zinc, cu, cv, top + 2.5, [[0.1, 0], [0.12, 0.45], [0.32, 0.6], [0.38, 0.85], [0.3, 1.08], [0.04, 1.2]], 8);
    m.beam(iron, [cu, top + 3.6, cv], [cu, top + 5.0, cv], 0.05, 0.05);
    m.beam(iron, [cu - 0.7, top + 4.6, cv], [cu + 0.7, top + 4.6, cv], 0.05, 0.05);
  }

  // --- the end pavilions: a great arched window under a segmental gable, a low roof, a bay window on each end with a
  // balustraded terrace ---------------------------------------------------------------------------------------------
  const pavilions = [[-45.6, -37.4, -24.0, 3.0], [38.2, 47.0, -24.2, 3.3]];
  const bays = [[-48.4, -45.5, -14.0, -6.9], [46.9, 48.4, -15.0, -6.0]];
  const great = facadeStyle(WIN.palace, T, { bay: 8.8, ground: GF, floor: MAIN + 1.0 });
  for (const [u0, u1, v0, v1] of pavilions) {
    m.box(F, u0, u1, P, EAVE + 0.4, v0, v1, palace, { faces: [great, palace, palace, palace], top: false });
    m.prism(F, offsetRing(rect(u0, u1, v0, v1), -0.12), GF - 0.15, GF + 0.15, null, { bottom: true, top: false });
    m.cornice(F, rect(u0, u1, v0, v1), EAVE + 0.4, 0.6, 0.65);
    m.pitched(slate, u0 + 0.3, u1 - 0.3, v0 + 0.3, v1 - 0.3, EAVE + 1.0, 2.8, { axis: 'v', hip: true });
    segmentalGable(u0 + 0.6, u1 - 0.6, v0 - 0.3, EAVE + 1.05, 2.2, 0.8);
    balcony((u0 + u1) / 2, v0, 4.6);
  }
  for (const [u0, u1, v0, v1] of bays) {
    m.box(F, u0, u1, P, 9.2, v0, v1, palace);
    m.cornice(F, rect(u0, u1, v0, v1), 9.2, 0.35, 0.4);
    const out = u0 < 0 ? u0 - 0.2 : u1 + 0.2;
    const back = u0 < 0 ? u1 : u0;
    m.balustrade(F, T, [back, v0 - 0.2], [out, v0 - 0.2], 9.6);
    m.balustrade(F, T, [out, v0 - 0.2], [out, v1 + 0.2], 9.6);
    m.balustrade(F, T, [out, v1 + 0.2], [back, v1 + 0.2], 9.6);
  }

  // --- the old ballroom (Salón de Plenos) behind: tall arched windows round its apsidal sides, a hipped slate roof and a
  // glazed ridge lantern -----------------------------------------------------------------------------------------------
  {
    const hall = facadeStyle(WIN.arcade, T, { bay: 3.6, ground: 4.0, floor: 7.6 });
    const ring = [-8.5, 2.5, -8.6, 8.7, -10.5, 8.8, -12.7, 11.4, -12.6, 18.1, -10.3, 20.5, -8.6, 20.5, -8.6, 26.4,
      10.2, 26.5, 10.2, 20.3, 11.7, 20.4, 14.3, 17.6, 14.2, 11.5, 11.8, 8.6, 10.2, 8.6, 10.3, 2.5];
    m.prism(F, ring, P, 13.0, hall);
    m.cornice(F, ring, 13.0, 0.5, 0.55);
    m.pitched(slate, -8.9, 10.5, 2.5, 26.8, 13.55, 4.0, { axis: 'v', hip: true });
    m.loft(materials.glass, [rect(-0.9, 2.5, 11.0, 18.0), rect(0.6, 1.0, 11.4, 17.6)], [16.9, 18.3]);
  }

  return m.finish('Udaletxea');
}
