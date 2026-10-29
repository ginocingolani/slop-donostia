import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, attribute, positionWorld, positionView, normalView, mix, smoothstep, step, floor, fract, min,
  sin, dot, fwidth, uniform, color, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { MARINA } from './data-marina.js';
import { seaUniforms } from './sea-uniforms.js';
import { LOW_WATER, pontoonLevel, gangwayPitch } from './sea-state.js';

// js/donostia/marina.js
// The port's moorings, from tools/donostia/bake-marina.mjs (js/donostia/data-marina.js):
// - Pontoons: timber decks (planks across the walkway) or concrete ones on black floats, with a timber waling round
//   their edges, riding the tide (the water's userData.getSeaLevel()) down to the bed, where they settle on their floats.
//   On them: aluminium cleats along the berths, service pedestals (water & power) with a light on top, a few lamp
//   posts, and the steel hoops round the guide piles.
// - Fixed: the guide piles (white steel tubes under conical caps), the aluminium gangways hinged on the quay
//   (their pitch follows the pontoons), an access gate at the head of each, the quays' cast-iron bollards, mooring
//   rings, galvanised ladders down the walls and the fishing quay's timber strakes, the old port's concrete slipway.
// The tidal band (wet stone, then weed under half tide) darkens the piles, ladders, floats and the slipway: on what
// floats after the sea's level (seaLevel: the water's userData.seaLevel uniform), on what stands fixed after the tidal
// bands' mark (js/donostia/sea-uniforms.js uTideMark: the same level with the real-time switch off, the last high
// water's with it on). The ladders and the fishing quay's strakes reach below the lowest tides (sea-state.js
// LOW_WATER), whatever the bake gave them. Lamps & pedestal lights glow at dusk & night (cityUniforms.uInteriorGlow), as
// js/donostia/streetscape.js's.
// Draws: the decks and the slipway (one material), one per instanced fitting kind and one for the gangways, gates &
// ladders; three materials. Small fittings are culled by distance.
// buildMarina(GEO, terrain, water) -> Promise<Object3D | null>; its userData.update(dt, elapsed, camera) floats the
// pontoons and culls the fittings.

const { freeboard: FREEBOARD, draft: DRAFT } = MARINA.level;
const WALING = 0.16; // m: the timber round a deck's edge
const FINGER_DROP = 0.015; // m: a finger's deck under its walkway's

// Paints: linear rgb + roughness
const PILE_WHITE = [0.62, 0.63, 0.61, 0.5];
const CAP_GREY = [0.2, 0.21, 0.21, 0.5];
const SIGN_BLUE = [0.015, 0.09, 0.32, 0.45];
const ALU = [0.5, 0.51, 0.51, 0.38];
const STEEL = [0.3, 0.31, 0.3, 0.5];
const CAST_IRON = [0.03, 0.032, 0.03, 0.55];
const RUST = [0.13, 0.055, 0.025, 0.75];
const PEDESTAL_WHITE = [0.76, 0.76, 0.74, 0.45];
const SOCKET = [0.05, 0.05, 0.055, 0.6];
const GATE_GREY = [0.06, 0.075, 0.075, 0.55];
const GALVANISED = [0.38, 0.39, 0.38, 0.45];
const MESH = [0.2, 0.21, 0.2, 0.6]; // a wire mesh panel, seen as its mean tone
const STRAKE_TIMBER = [0.09, 0.06, 0.04, 0.85];
// deck surfaces (linear rgb)
const TIMBER = [0.23, 0.15, 0.085];
const CONCRETE = [0.36, 0.35, 0.33];
const WALING_TIMBER = [0.12, 0.07, 0.04];
const FLOAT_BLACK = [0.035, 0.035, 0.035];
const SLIPWAY = [0.33, 0.32, 0.3];
// aSurf.z: the surface's pattern
const PLAIN = 0, PLANKS = 1, SLABS = 2, GROOVES = 3;

const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
// The level a surface's tidal band is drawn from: the water's on what floats (userData.rides), the bands' mark on the rest
const bandLevel = (seaLevel) => mix(seaUniforms.uTideMark, seaLevel, uniform(0).onObjectUpdate(({ object }) => (object.userData.rides ? 1 : 0)));
// 1 below a, 0 above b (a < b): a falling smoothstep written with its edges in order (WGSL's smoothstep, as Metal's,
// leaves reversed edges undefined)
const fall = (a, b, x) => float(1).sub(smoothstep(a, b, x));
const hash = Fn(([q]) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453)));

// Mikkelsen's surface-gradient bump (as js/donostia/shore.js), as a view-space normal
const bumpNormal = Fn(([height]) => {
  const hgt = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(hgt.dFdx().mul(r1).add(hgt.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// The tidal band (as js/donostia/shore.js's, its weed reaching higher on the piles and the slipway): dark & wet up to
// ~1.7 m over the sea, green weed below ~0.8 m (h: metres above the sea; n: noise)
const tidal = (c, h, n) => {
  const wet = fall(0.5, 1.9, h.add(n.mul(0.5)));
  const weed = fall(0.1, 0.9, h.add(n.mul(0.3)));
  return mix(mix(c, c.mul(vec3(0.42, 0.42, 0.38)), wet), vec3(0.035, 0.05, 0.022), weed.mul(0.9));
};

// --- materials -----------------------------------------------------------------------------------------------------------

// Decks & the slipway: color (linear rgb), aSurf = (u, v: metres along & across, pattern, wet: how far the tidal band
// reaches it)
function surfaceMaterial(seaLevel) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const base = attribute('color', 'vec3');
  const surf = attribute('aSurf', 'vec4');
  const u = surf.x, v = surf.y, pattern = surf.z, wet = surf.w;
  const p = positionWorld;
  const n1 = mx_noise_float(p.mul(1.9)).toVar(), n2 = mx_noise_float(p.mul(0.31)).toVar();
  const isPlanks = step(0.5, pattern).mul(step(pattern, 1.5));
  const isSlabs = step(1.5, pattern).mul(step(pattern, 2.5));
  const isGrooves = step(2.5, pattern);
  // planks 14.5 cm wide across the walkway with a dark gap between, each its own weathered tone, grain along it
  const pu = u.div(0.145).toVar();
  const plank = floor(pu);
  const aaP = fwidth(pu).max(0.0001);
  const dP = min(fract(pu), float(1).sub(fract(pu)));
  const gap = float(1).sub(smoothstep(0.045, aaP.add(0.045), dP)).mul(fall(0.15, 0.5, aaP)).mul(isPlanks).toVar();
  const tone = hash(vec2(plank, floor(v.div(2.9)))).toVar();
  const grain = mx_noise_float(vec3(plank.mul(3.7), v.mul(2.2), 0.5)).mul(0.5).add(mx_noise_float(vec3(pu.mul(6.0), v.mul(0.4), 1.5)).mul(0.2));
  // concrete slabs 2.4 m long; the slipway's grooves across its fall every 25 cm, joints every 4 m
  const su = u.div(mix(float(2.4), float(4.0), isGrooves)).toVar();
  const aaS = fwidth(su).max(0.0001);
  const joint = float(1).sub(smoothstep(0.004, aaS.add(0.004), min(fract(su), float(1).sub(fract(su))))).mul(isSlabs.add(isGrooves)).toVar();
  const gu = u.div(0.25).toVar();
  const aaG = fwidth(gu).max(0.0001);
  const groove = smoothstep(0.42, 0.5, min(fract(gu), float(1).sub(fract(gu))).add(aaG.mul(0.5))).mul(fall(0.06, 0.2, aaG)).mul(isGrooves).toVar();
  const h = p.y.sub(bandLevel(seaLevel));
  mat.colorNode = Fn(() => {
    const c = base.toVar();
    c.mulAssign(mix(float(1), tone.mul(0.32).add(0.84).add(grain.mul(0.12)), isPlanks));
    c.mulAssign(float(1).sub(gap.mul(0.75)));
    c.mulAssign(n2.mul(0.12).add(n1.mul(0.05)).add(1));
    c.mulAssign(float(1).sub(joint.mul(0.35)).sub(groove.mul(0.18)));
    return mix(c, tidal(c, h, n2.mul(2)), wet);
  })();
  mat.roughnessNode = mix(mix(float(0.8), float(0.88), isSlabs.add(isGrooves)), float(0.35), fall(0.2, 1.2, h).mul(wet));
  mat.normalNode = bumpNormal(gap.mul(-0.006).sub(joint.mul(0.006)).sub(groove.mul(0.004)).add(n1.mul(0.0015)));
  return mat;
}

// Painted & bare metal, timber (aPaint: linear rgb + roughness; aWet: how far the tidal band reaches it)
function paintMaterial(seaLevel) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const paint = attribute('aPaint', 'vec4'), wet = attribute('aWet', 'float');
  const n = mx_noise_float(positionWorld.mul(1.7));
  mat.colorNode = mix(paint.xyz, tidal(paint.xyz, positionWorld.y.sub(bandLevel(seaLevel)), n.mul(2)), wet);
  mat.roughnessNode = paint.w;
  return mat;
}

// Lamp globes & the pedestals' lights: milky by day, glowing (bloom) at dusk & night
function glowMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  mat.colorNode = color(0xe8e6de);
  mat.emissiveNode = color(0xffe2b8).mul(night().mul(3.0).add(0.03));
  return mat;
}

// --- geometry --------------------------------------------------------------------------------------------------------------

const M4 = () => new THREE.Matrix4();
const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// Non-indexed triangles with position, normal, aPaint (rgb + roughness) and aWet
class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.paint = [];
    this.wet = [];
  }

  // a three.js geometry, transformed by matrix
  add(geo, paint, wet = 0, matrix = null) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) {
      this.pos.push(p[i]);
      this.nrm.push(n[i]);
    }
    for (let i = 0; i < p.length / 3; i++) {
      this.paint.push(...paint);
      this.wet.push(wet);
    }
    return this;
  }

  // a box of size (w, h, d) whose bottom centre is at (x, y, z), then matrix
  box(w, h, d, x, y, z, paint, wet = 0, matrix = null) {
    const m = M4().makeTranslation(x, y + h / 2, z);
    return this.add(new THREE.BoxGeometry(w, h, d), paint, wet, matrix ? matrix.clone().multiply(m) : m);
  }

  // a bar of square section w from p to q (Vector3), then matrix
  bar(p, q, w, paint, wet = 0, matrix = null) {
    const d = V3().subVectors(q, p), len = d.length();
    const at = M4().compose(V3().addVectors(p, q).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(V3(0, 1, 0), d.normalize()), V3(1, 1, 1));
    return this.add(new THREE.BoxGeometry(w, len, w), paint, wet, matrix ? matrix.clone().multiply(at) : at);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.setAttribute('aWet', new THREE.Float32BufferAttribute(this.wet, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const lathe = (profile, segments) => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);

// The pontoons: each deck piece a slab from its deck down to the floats' bottom, the waling round its top edge
// -> { pos, nrm, col, surf }
export function deckGeometry(decks) {
  const out = { pos: [], nrm: [], col: [], surf: [] };
  const quad = (a, b, c, d, n, col, surfOf) => {
    // a b c d counter-clockwise seen from the front (n)
    for (const v of [a, b, c, a, c, d]) {
      out.pos.push(v[0], v[1], v[2]);
      out.nrm.push(n[0], n[1], n[2]);
      out.col.push(...col);
      out.surf.push(...surfOf(v));
    }
  };
  for (let k = 0; k < decks.length; k += 10) {
    const q = decks.slice(k, k + 8), kind = decks[k + 8], concrete = decks[k + 9] === 1;
    const top = FREEBOARD - (kind ? FINGER_DROP : 0), bottom = -DRAFT;
    const C = [0, 1, 2, 3].map((i) => [q[2 * i], q[2 * i + 1]]);
    // the walkway's direction (first corner to second) and across
    let ax = C[1][0] - C[0][0], az = C[1][1] - C[0][1];
    const l = Math.hypot(ax, az) || 1;
    ax /= l; az /= l;
    const along = (v) => v[0] * ax + v[2] * az, across = (v) => -v[0] * az + v[2] * ax;
    // the top, wound to face up whichever way the corners run
    const T = C.map(([x, z]) => [x, top, z]);
    const up = (T[1][0] - T[0][0]) * (T[2][2] - T[0][2]) - (T[1][2] - T[0][2]) * (T[2][0] - T[0][0]) < 0;
    const [t0, t1, t2, t3] = up ? T : [T[0], T[3], T[2], T[1]];
    quad(t0, t1, t2, t3, [0, 1, 0], concrete ? CONCRETE : TIMBER, (v) => [along(v), across(v), concrete ? SLABS : PLANKS, 0]);
    // the sides, each facing away from the piece's middle: the waling, then the float
    const mx = (C[0][0] + C[1][0] + C[2][0] + C[3][0]) / 4, mz = (C[0][1] + C[1][1] + C[2][1] + C[3][1]) / 4;
    for (let i = 0; i < 4; i++) {
      const [x0, z0] = C[i], [x1, z1] = C[(i + 1) % 4];
      const el = Math.hypot(x1 - x0, z1 - z0);
      if (el < 1e-3) continue;
      let nx = (z1 - z0) / el, nz = -(x1 - x0) / el;
      if (nx * ((x0 + x1) / 2 - mx) + nz * ((z0 + z1) / 2 - mz) < 0) { nx = -nx; nz = -nz; }
      // counter-clockwise seen from outside: (bottom a, bottom b, top b, top a) faces (-(bz - az), bx - ax)
      const outward = (x1 - x0) * nz - (z1 - z0) * nx > 0;
      const [pa, pb] = outward ? [[x0, z0], [x1, z1]] : [[x1, z1], [x0, z0]];
      const band = (y0, y1, col, wet) => quad([pa[0], y0, pa[1]], [pb[0], y0, pb[1]], [pb[0], y1, pb[1]], [pa[0], y1, pa[1]], [nx, 0, nz], col,
        (v) => [v[0] * -nz + v[2] * nx, v[1], PLAIN, wet]);
      band(top - WALING, top, WALING_TIMBER, 0);
      band(bottom, top - WALING, concrete ? CONCRETE : FLOAT_BLACK, 1);
    }
  }
  return out.pos.length ? out : null;
}

// The slipway: a concrete slab on its fitted surface, a little proud of the terrain, cut into 2 m cells (it curves), its
// edges skirted down into the ground -> { pos, nrm, col, surf }
const SLIP_SKIRT = 0.8, SLIP_CELL = 2;
export function slipwayGeometry(slipway) {
  if (!slipway || slipway.ring.length < 6) return null;
  const { ring, origin: [ox, oz], surface: c } = slipway;
  const at = (x, z) => { const u = x - ox, v = z - oz; return c[0] + c[1] * u + c[2] * v + c[3] * u * u + c[4] * u * v + c[5] * v * v; };
  const normal = (x, z) => {
    const u = x - ox, v = z - oz;
    const n = [-(c[1] + 2 * c[3] * u + c[4] * v), 1, -(c[2] + c[4] * u + 2 * c[5] * v)], l = Math.hypot(...n);
    return n.map((k) => k / l);
  };
  // down the fall line at the middle
  const fl = Math.hypot(c[1], c[2]) || 1, fx = -c[1] / fl, fz = -c[2] / fl;
  const out = { pos: [], nrm: [], col: [], surf: [] };
  const push = (v, n) => {
    out.pos.push(...v);
    out.nrm.push(...n);
    out.col.push(...SLIPWAY);
    out.surf.push(v[0] * fx + v[2] * fz, -v[0] * fz + v[2] * fx, GROOVES, 1);
  };
  // clips a polygon [[x, z], ...] to the half plane a x + b z <= d
  const clip = (poly, a, b, d) => {
    const res = [];
    for (let i = 0; i < poly.length; i++) {
      const P = poly[i], Q = poly[(i + 1) % poly.length];
      const dp = a * P[0] + b * P[1] - d, dq = a * Q[0] + b * Q[1] - d;
      if (dp <= 0) res.push(P);
      if ((dp <= 0) !== (dq <= 0)) {
        const t = dp / (dp - dq);
        res.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
      }
    }
    return res;
  };
  const poly = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    poly.push([ring[k], ring[k + 1]]);
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  for (let z = Math.floor(minZ / SLIP_CELL) * SLIP_CELL; z < maxZ; z += SLIP_CELL) {
    for (let x = Math.floor(minX / SLIP_CELL) * SLIP_CELL; x < maxX; x += SLIP_CELL) {
      let piece = clip(poly, 1, 0, x + SLIP_CELL);
      piece = clip(piece, -1, 0, -x);
      piece = clip(piece, 0, 1, z + SLIP_CELL);
      piece = clip(piece, 0, -1, -z);
      if (piece.length < 3) continue;
      const contour = piece.map(([px, pz]) => new THREE.Vector2(px, pz));
      for (const tri of THREE.ShapeUtils.triangulateShape(contour, [])) {
        const V = tri.map((i) => [contour[i].x, at(contour[i].x, contour[i].y), contour[i].y]);
        // wound to face up
        const cross = (V[1][0] - V[0][0]) * (V[2][2] - V[0][2]) - (V[1][2] - V[0][2]) * (V[2][0] - V[0][0]);
        for (const v of cross < 0 ? V : [V[0], V[2], V[1]]) push(v, normal(v[0], v[2]));
      }
    }
  }
  // the skirt, facing out of the slab
  const area = THREE.ShapeUtils.area(poly.map(([x, z]) => new THREE.Vector2(x, z)));
  for (let i = 0; i < poly.length; i++) {
    const [px, pz] = poly[i], [qx, qz] = poly[(i + 1) % poly.length];
    const l = Math.hypot(qx - px, qz - pz);
    if (l < 1e-3) continue;
    const s = area > 0 ? 1 : -1;
    const nx = (s * (qz - pz)) / l, nz = (-s * (qx - px)) / l;
    const A = [px, at(px, pz), pz], B = [qx, at(qx, qz), qz];
    const A2 = [A[0], A[1] - SLIP_SKIRT, A[2]], B2 = [B[0], B[1] - SLIP_SKIRT, B[2]];
    // counter-clockwise seen from outside
    const quad = (B[0] - A[0]) * nz - (B[2] - A[2]) * nx > 0 ? [A, A2, B2, A, B2, B] : [A, B2, A2, A, B, B2];
    for (const v of quad) push(v, [nx, 0, nz]);
  }
  return out.pos.length ? out : null;
}

function surfaceMesh(g, material, name) {
  if (!g) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
  geo.setAttribute('aSurf', new THREE.Float32BufferAttribute(g.surf, 4));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// A guide pile: a white steel tube from well under the bed to its conical cap (y up from the mean sea level)
const PILE_R = 0.25, PILE_TOP = 3.8, PILE_FOOT = -4;
function pileGeometry() {
  const b = new Builder();
  b.add(new THREE.CylinderGeometry(PILE_R, PILE_R, PILE_TOP - PILE_FOOT, 12, 1, true), PILE_WHITE, 1, M4().makeTranslation(0, (PILE_TOP + PILE_FOOT) / 2, 0));
  b.add(lathe([[0, 0], [PILE_R + 0.03, 0], [PILE_R + 0.03, 0.08], [0.12, 0.4], [0.04, 0.46], [0, 0.46]], 12), CAP_GREY, 0, M4().makeTranslation(0, PILE_TOP, 0));
  return b.build();
}

// The steel hoop round a pile, bolted under the pontoon's waling (+z: towards the deck, whose edge is 0.37 m from the
// pile's axis)
function hoopGeometry() {
  const b = new Builder();
  const y = FREEBOARD - 0.2, r = PILE_R + 0.05, t = 0.06;
  for (const [x, z, w, d] of [[0, r, 2 * r + t, t], [0, -r, 2 * r + t, t], [r, 0, t, 2 * r], [-r, 0, t, 2 * r]]) b.box(w, 0.14, d, x, y, z, STEEL, 1);
  for (const x of [-0.2, 0.2]) b.box(0.06, 0.12, 0.2, x, y + 0.02, r + 0.1, STEEL, 1);
  return b.build();
}

// An aluminium horn cleat on the deck, along the walkway (+z)
function cleatGeometry() {
  const b = new Builder();
  b.box(0.08, 0.025, 0.2, 0, FREEBOARD, 0, ALU);
  for (const z of [-0.05, 0.05]) b.box(0.045, 0.06, 0.04, 0, FREEBOARD + 0.02, z, ALU);
  b.box(0.05, 0.035, 0.3, 0, FREEBOARD + 0.075, 0, ALU);
  return b.build();
}

// A service pedestal: white column, grey head, sockets & taps on its sides (the light apart), facing +z
const PEDESTAL_H = 1.05;
function pedestalGeometry() {
  const b = new Builder();
  b.box(0.28, PEDESTAL_H - 0.14, 0.24, 0, FREEBOARD, 0, PEDESTAL_WHITE);
  b.box(0.31, 0.14, 0.27, 0, FREEBOARD + PEDESTAL_H - 0.14, 0, CAP_GREY);
  for (const s of [-1, 1]) b.box(0.03, 0.18, 0.12, s * 0.15, FREEBOARD + 0.55, 0, SOCKET);
  b.box(0.12, 0.12, 0.03, 0, FREEBOARD + 0.6, 0.125, SOCKET);
  return b.build();
}
const pedestalLight = () => new THREE.SphereGeometry(0.075, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, FREEBOARD + PEDESTAL_H, 0);

// A lamp post on the pontoon: a slim aluminium mast with a cylindrical head (the globe apart)
const LAMP_H = 2.8;
function lampPostGeometry() {
  const b = new Builder();
  b.add(lathe([[0, 0], [0.09, 0], [0.09, 0.04], [0.05, 0.08], [0.04, LAMP_H], [0.12, LAMP_H + 0.02], [0.12, LAMP_H + 0.08], [0, LAMP_H + 0.1]], 8),
    ALU, 0, M4().makeTranslation(0, FREEBOARD, 0));
  return b.build();
}
const lampGlobe = () => new THREE.CylinderGeometry(0.1, 0.1, 0.26, 10).translate(0, FREEBOARD + LAMP_H - 0.13, 0);

// A cast-iron mooring bollard (noray), mushroom-headed
function bollardGeometry() {
  const b = new Builder();
  b.add(lathe([[0, -0.1], [0.3, -0.1], [0.3, 0.04], [0.2, 0.09], [0.15, 0.17], [0.13, 0.34], [0.16, 0.41], [0.25, 0.47], [0.25, 0.55], [0.19, 0.6], [0, 0.61]], 12), CAST_IRON);
  return b.build();
}

// An iron mooring ring hanging flat against the wall's face (+z: out of the wall) from its eye plate
function ringGeometry() {
  const b = new Builder();
  b.box(0.13, 0.13, 0.03, 0, -0.065, 0.015, RUST, 1);
  b.add(new THREE.TorusGeometry(0.11, 0.022, 5, 14), RUST, 1, M4().makeTranslation(0, -0.15, 0.05));
  return b.build();
}

// --- gangways, gates & ladders: merged, the gangways re-laid when the pontoons move ----------------------------------------------

// A gangway in its own frame: x across, y up, z along from the hinge (0) to the foot (L); the deck's top at y = 0
function gangwayLocal(b, L, W) {
  const h = W / 2;
  b.box(W, 0.06, L, 0, -0.06, L / 2, ALU);
  for (const s of [-1, 1]) {
    b.box(0.06, 0.28, L, s * (h + 0.03), -0.2, L / 2, ALU); // the stringers
    b.box(0.05, 0.05, L, s * (h + 0.03), 1.0, L / 2, ALU); // the handrail
    b.box(0.035, 0.035, L, s * (h + 0.03), 0.5, L / 2, ALU); // the knee rail
    const posts = Math.max(2, Math.round(L / 1.5));
    for (let i = 0; i <= posts; i++) b.box(0.045, 1.0, 0.045, s * (h + 0.03), 0, (L * i) / posts, ALU);
  }
  // the foot's rollers and the hinge plate
  b.add(new THREE.CylinderGeometry(0.08, 0.08, W + 0.1, 8).rotateZ(Math.PI / 2), STEEL, 0, M4().makeTranslation(0, -0.16, L - 0.12));
  b.box(W + 0.2, 0.03, 0.5, 0, -0.03, -0.25, STEEL);
}

// The gate at a gangway's head: two posts, a lintel with a sign and a mesh door, across the way (+z
// down the gangway); m: its frame
function gate(b, W, m) {
  const h = W / 2 + 0.12;
  for (const s of [-1, 1]) b.box(0.1, 2.3, 0.1, s * h, 0, -0.3, GATE_GREY, 0, m);
  b.box(2 * h + 0.1, 0.1, 0.1, 0, 2.2, -0.3, GATE_GREY, 0, m);
  b.box(2 * h - 0.3, 0.3, 0.04, 0, 2.3, -0.3, SIGN_BLUE, 0, m);
  // the door: a galvanised frame round a mesh panel
  for (const y of [0.1, 1.95]) b.box(2 * h - 0.14, 0.05, 0.04, 0, y, -0.3, GALVANISED, 0, m);
  for (const s of [-1, 1]) b.box(0.05, 1.9, 0.04, s * (h - 0.1), 0.1, -0.3, GALVANISED, 0, m);
  b.box(2 * h - 0.24, 1.8, 0.012, 0, 0.15, -0.3, MESH, 0, m);
}

// A galvanised ladder down a quay wall (+z: out of the wall), from the coping to below low water, its grab bars arched
// over the coping; m: its frame (y from the quay's deck: 0)
function ladder(b, drop, m) {
  const out = 0.16, h = 0.22;
  for (const s of [-1, 1]) {
    b.box(0.06, drop + 0.9, 0.025, s * h, -drop, out, STEEL, 1, m);
    b.box(0.05, 0.025, out + 0.4, s * h, 0.875, out / 2 - 0.2, STEEL, 0, m);
    b.box(0.05, 0.9, 0.025, s * h, 0, -0.4, STEEL, 0, m);
    for (let y = -0.4; y > -drop; y -= 1.6) b.box(0.05, 0.05, out, s * h, y, out / 2, STEEL, 1, m);
  }
  for (let y = -0.3; y > -drop + 0.1; y -= 0.3) b.box(2 * h, 0.03, 0.03, 0, y, out, STEEL, 1, m);
}

// The gates, ladders & strakes in one geometry
function fittingsGeometry(data) {
  const b = new Builder();
  const yaw = (deg) => (deg * Math.PI) / 180;
  const G = data.gangways;
  for (let k = 0; k < G.length; k += 7) {
    const [hx, hz, hy, fx, fz, , W] = G.slice(k, k + 7);
    gate(b, W, M4().makeTranslation(hx, hy, hz).multiply(M4().makeRotationY(Math.atan2(fx - hx, fz - hz))));
  }
  // (down past the lowest tides: the ebb must not leave them hanging over the water)
  const foot = (bottom) => Math.min(bottom, LOW_WATER - 0.2);
  const L = data.ladders;
  for (let k = 0; k < L.length; k += 5) {
    const [x, z, a, top, bottom] = L.slice(k, k + 5);
    ladder(b, top - foot(bottom), M4().makeTranslation(x, top, z).multiply(M4().makeRotationY(yaw(a))));
  }
  const S = data.strakes;
  for (let k = 0; k < S.length; k += 5) {
    const [x, z, a, top, bottom] = S.slice(k, k + 5);
    b.box(0.24, top - foot(bottom), 0.2, 0, foot(bottom), 0.1, STRAKE_TIMBER, 1, M4().makeTranslation(x, 0, z).multiply(M4().makeRotationY(yaw(a))));
  }
  return b;
}

// The gangways: local geometry per gangway with its hinge & heading; lay(level) pitches each so its foot rests on the
// pontoon at level + FREEBOARD
function gangwayMesh(data, material) {
  const G = data.gangways;
  if (!G.length) return null;
  const parts = [];
  const local = new Builder();
  for (let k = 0; k < G.length; k += 7) {
    const [hx, hz, hy, fx, fz, L, W] = G.slice(k, k + 7);
    const start = local.pos.length / 3;
    gangwayLocal(local, L, W);
    parts.push({ hx, hz, hy, L, heading: Math.atan2(fx - hx, fz - hz), start, end: local.pos.length / 3 });
  }
  const geo = local.build();
  const lp = Float32Array.from(local.pos), ln = Float32Array.from(local.nrm);
  const pos = geo.getAttribute('position'), nrm = geo.getAttribute('normal');
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'Marina_gangways';
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  const m = M4(), nm = new THREE.Matrix3(), v = V3();
  mesh.userData.lay = (level) => {
    for (const g of parts) {
      const pitch = gangwayPitch(g.hy, g.L, level);
      m.makeTranslation(g.hx, g.hy, g.hz).multiply(M4().makeRotationY(g.heading)).multiply(M4().makeRotationX(pitch));
      nm.getNormalMatrix(m);
      for (let i = g.start; i < g.end; i++) {
        v.set(lp[3 * i], lp[3 * i + 1], lp[3 * i + 2]).applyMatrix4(m);
        pos.setXYZ(i, v.x, v.y, v.z);
        v.set(ln[3 * i], ln[3 * i + 1], ln[3 * i + 2]).applyMatrix3(nm).normalize();
        nrm.setXYZ(i, v.x, v.y, v.z);
      }
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
    geo.computeBoundingSphere();
  };
  return mesh;
}

// --- instancing & culling -----------------------------------------------------------------------------------------------------

function instanced(geo, mat, matrices, name, shadows = true) {
  const n = matrices.length / 16;
  if (!n) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.array.set(matrices);
  // a storage buffer (as js/donostia/streetscape.js): small instanced meshes otherwise keep their matrices in a uniform
  // buffer re-uploaded every draw
  mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(mesh.instanceMatrix.array, 16);
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// The instances within maxDist of the camera at the front of the instance buffer (js/donostia/streetscape.js's
// DistanceCulled)
class DistanceCulled {
  constructor(mesh, maxDist) {
    this.mesh = mesh;
    this.src = mesh.instanceMatrix.array.slice();
    this.n = this.src.length / 16;
    this.max2 = maxDist * maxDist;
    this.inside = new Uint8Array(this.n).fill(1);
  }

  update(cam) {
    const src = this.src;
    let changed = false;
    for (let i = 0; i < this.n; i++) {
      const dx = src[16 * i + 12] - cam.x, dy = src[16 * i + 13] - cam.y, dz = src[16 * i + 14] - cam.z;
      const inside = dx * dx + dy * dy + dz * dz < this.max2 ? 1 : 0;
      if (inside !== this.inside[i]) { this.inside[i] = inside; changed = true; }
    }
    if (!changed) return;
    const mesh = this.mesh, dst = mesh.instanceMatrix.array;
    let c = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.inside[i]) continue;
      for (let k = 0; k < 16; k++) dst[16 * c + k] = src[16 * i + k];
      c++;
    }
    mesh.count = c;
    mesh.visible = c > 0;
    if (c > 0) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, c * 16);
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}
// Cull distances (m), about where each fitting shrinks to a few pixels; the lamps' globes are never culled
const CULL = { cleats: 110, hoops: 220, pedestals: 260, pedestalLights: 400, lampPosts: 600, piles: 900, bollards: 320, rings: 140 };
const RECULL = 6; // m the camera moves before the fittings are culled again

/**
 * The marina. water: js/donostia/water.js's group (userData.seaLevel, the level uniform for the tidal band;
 * userData.getSeaLevel(), which the pontoons follow).
 */
export async function buildMarina(GEO, terrain, water = null) {
  try {
    const data = MARINA;
    const seaLevel = water?.userData.seaLevel || uniform(0);
    const getSeaLevel = water?.userData.getSeaLevel || (() => 0);
    const group = new THREE.Group();
    group.name = 'DonostiaMarina';
    // everything that rides the tide; its y is the water's level (the baked geometry floats at mean sea level, 0)
    const floating = new THREE.Group();
    floating.name = 'Marina_floating';
    group.add(floating);

    const surface = surfaceMaterial(seaLevel), paint = paintMaterial(seaLevel), glow = glowMaterial();
    const decks = surfaceMesh(deckGeometry(data.decks), surface, 'Marina_pontoons');
    if (decks) floating.add(decks);
    const slipway = surfaceMesh(slipwayGeometry(data.slipway), surface, 'Marina_slipway');
    if (slipway) {
      slipway.castShadow = false;
      group.add(slipway);
    }

    const m = M4(), q = new THREE.Quaternion(), p = V3(), s = V3(1, 1, 1), up = V3(0, 1, 0);
    const place = (out, x, y, z, yawDeg) => {
      q.setFromAxisAngle(up, (yawDeg * Math.PI) / 180);
      m.compose(p.set(x, y, z), q, s);
      out.push(...m.elements);
    };
    const list = (flat, stride, fn) => { const out = []; for (let k = 0; k < flat.length; k += stride) fn(out, ...flat.slice(k, k + stride)); return out; };
    const piles = list(data.piles, 5, (o, x, z, top, bottom, yaw) => place(o, x, 0, z, yaw));
    const cleats = list(data.cleats, 3, (o, x, z, yaw) => place(o, x, 0, z, yaw));
    const pedestals = list(data.pedestals, 3, (o, x, z, yaw) => place(o, x, 0, z, yaw));
    const lamps = list(data.lamps, 2, (o, x, z) => place(o, x, 0, z, 0));
    const bollards = list(data.bollards, 4, (o, x, y, z, yaw) => place(o, x, y, z, yaw));
    const rings = list(data.rings, 4, (o, x, y, z, yaw) => place(o, x, y, z, yaw));

    const meshes = {
      piles: instanced(pileGeometry(), paint, piles, 'Marina_piles'),
      hoops: instanced(hoopGeometry(), paint, piles, 'Marina_pile_hoops', false),
      cleats: instanced(cleatGeometry(), paint, cleats, 'Marina_cleats', false),
      pedestals: instanced(pedestalGeometry(), paint, pedestals, 'Marina_pedestals'),
      pedestalLights: instanced(pedestalLight(), glow, pedestals, 'Marina_pedestal_lights', false),
      lampPosts: instanced(lampPostGeometry(), paint, lamps, 'Marina_lamp_posts'),
      lampGlobes: instanced(lampGlobe(), glow, lamps, 'Marina_lamp_globes', false),
      bollards: instanced(bollardGeometry(), paint, bollards, 'Marina_bollards'),
      rings: instanced(ringGeometry(), paint, rings, 'Marina_rings', false)
    };
    for (const k of ['hoops', 'cleats', 'pedestals', 'pedestalLights', 'lampPosts', 'lampGlobes']) if (meshes[k]) floating.add(meshes[k]);
    for (const o of floating.children) o.userData.rides = true;
    for (const k of ['piles', 'bollards', 'rings']) if (meshes[k]) group.add(meshes[k]);

    const gangways = gangwayMesh(data, paint);
    if (gangways) group.add(gangways);
    const fixed = fittingsGeometry(data);
    if (fixed.pos.length) {
      const mesh = new THREE.Mesh(fixed.build(), paint);
      mesh.name = 'Marina_gates_ladders';
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }

    const culled = Object.entries(CULL).filter(([k]) => meshes[k]).map(([k, d]) => new DistanceCulled(meshes[k], d));
    const last = V3(Infinity, Infinity, Infinity);
    let level = NaN;
    group.userData.update = (dt, elapsed, camera) => {
      // the pontoons follow the water down to where they settle on the bed
      const y = pontoonLevel(getSeaLevel());
      if (y !== level) {
        level = y;
        floating.position.y = y;
        gangways?.userData.lay(y);
      }
      // (everything stays drawn for the shader compile behind the loading screen, elapsed 0)
      if (!elapsed || camera.position.distanceToSquared(last) < RECULL * RECULL) return;
      last.copy(camera.position);
      for (const c of culled) c.update(camera.position);
    };
    group.userData.update(0, 0, null);
    return group;
  } catch (e) {
    // the city stands without its moorings rather than not at all (main.js skips a null module)
    console.warn('[marina]', e);
    return null;
  }
}
