import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, vec4, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot, clamp,
  positionWorld, normalWorld, select, uniform
} from 'three/tsl';
import { cityUniforms } from '../tsl-materials.js';

// js/donostia/buildings.js
// Every building of the municipal 1:500 map (Donostiako Udala, CC BY-SA 3.0) extruded from its LiDAR ground to the
// eaves measured by b5m (Gipuzkoa, CC BY 4.0), with a roof inferred from the gap between b5m's mean and maximum height:
// flat, pitched (a hip roof inset from the walls) or mansard (steep, with a flat top) — see tools/donostia/build.mjs.
// Geometry is merged per 512 m cell: few draw calls, while the camera frustum still culls whole cells.

const CELL = 512;
const FLOOR_H = 3.05, GROUND_FLOOR_H = 4.1;

// Façade palette of the city: sandstone & cream ashlar of the Área Romántica, white & pastel render of the Parte Vieja,
// ochres and brick of Gros & Amara, white villas on the hills.
const PALETTE = [
  [0.80, 0.73, 0.60], [0.86, 0.81, 0.71], [0.74, 0.66, 0.53], [0.90, 0.88, 0.83], [0.83, 0.70, 0.52],
  [0.68, 0.53, 0.42], [0.92, 0.91, 0.88], [0.78, 0.76, 0.72], [0.62, 0.42, 0.34], [0.86, 0.78, 0.62]
];
const DISTRICT_BIAS = { ERDIALDEA: [0, 1, 2, 3, 9], GROS: [1, 4, 5, 8, 3], ANTIGUA: [3, 6, 7, 1], IGELDO: [6, 3, 7], AIETE: [6, 3, 7, 1], EGIA: [5, 8, 4, 7], 'ATEGORRIETA - ULIA': [6, 3, 7] };

function hash(i) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

// Ring with the requested winding (area > 0 for outer rings, < 0 for holes): edge normals (dz, -dx) then point out
// of the solid for both
function wound(r, positive) {
  if ((signedArea(r) > 0) === positive) return r;
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
}

// Miter offset of a ring by d towards the inside of the solid (works for outer rings and holes alike given the winding
// above). Returns null when the offset flips an edge or collapses the ring.
function insetRing(r, d) {
  const n = r.length / 2;
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let ax = r[2 * i] - r[2 * p], az = r[2 * i + 1] - r[2 * p + 1];
    let bx = r[2 * q] - r[2 * i], bz = r[2 * q + 1] - r[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // inward normals = -(dz, -dx) = (-dz, dx)
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx;
    let mx = n1x + n2x, mz = n1z + n2z;
    const denom = 1 + (n1x * n2x + n1z * n2z);
    if (denom < 0.25) return null; // spike: the offset would shoot far out
    mx /= denom; mz /= denom;
    out[2 * i] = r[2 * i] + d * mx;
    out[2 * i + 1] = r[2 * i + 1] + d * mz;
  }
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ox = r[2 * q] - r[2 * i], oz = r[2 * q + 1] - r[2 * i + 1];
    const nx = out[2 * q] - out[2 * i], nz = out[2 * q + 1] - out[2 * i + 1];
    if (ox * nx + oz * nz <= 0) return null;
  }
  const a0 = signedArea(r), a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.08 * Math.abs(a0)) return null;
  return out;
}

class CellBuilder {
  constructor() {
    this.walls = { pos: [], nrm: [], facade: [], info: [] };
    this.roofs = { pos: [], nrm: [], info: [] };
  }

  wallQuad(ax, az, bx, bz, y0, y1, ground, u0, len, seed, info) {
    const nx = bz - az, nz = -(bx - ax);
    const l = Math.hypot(nx, nz) || 1;
    const w = this.walls;
    const verts = [[ax, y0, az, u0], [bx, y0, bz, u0 + len], [bx, y1, bz, u0 + len], [ax, y1, az, u0]];
    // counter-clockwise seen from outside (along the outward normal)
    for (const k of [0, 2, 1, 0, 3, 2]) {
      const [x, y, z, u] = verts[k];
      w.pos.push(x, y, z);
      w.nrm.push(nx / l, 0, nz / l);
      w.facade.push(u, y - ground, len, seed);
      w.info.push(...info);
    }
  }

  roofTri(a, b, c, info) {
    const r = this.roofs;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
    const l = Math.hypot(nx, ny, nz) || 1;
    for (const p of [a, b, c]) {
      r.pos.push(...p);
      r.nrm.push(nx / l, ny / l, nz / l);
      r.info.push(...info);
    }
  }

  cap(rings, y, info) {
    const contour = [], holes = [];
    rings.forEach((r, k) => {
      const pts = [];
      for (let i = 0; i < r.length; i += 2) pts.push(new THREE.Vector2(r[i], r[i + 1]));
      if (k === 0) contour.push(...pts);
      else holes.push(pts);
    });
    const all = [...contour, ...holes.flat()];
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
      this.roofTri([all[a].x, y, all[a].y], [all[b].x, y, all[b].y], [all[c].x, y, all[c].y], info);
    }
  }

  geometry(part) {
    const p = this[part];
    if (!p.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(p.nrm, 3));
    if (p.facade) geo.setAttribute('facade', new THREE.Float32BufferAttribute(p.facade, 4));
    geo.setAttribute('binfo', new THREE.Float32BufferAttribute(p.info, 4));
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }
}

function addBuilding(cell, b, index, districts) {
  const rings = b.g.map((r, k) => wound(r, k === 0));
  const seed = hash(index + 17);
  const district = districts[b.district] || '';
  const choices = DISTRICT_BIAS[district] || [0, 1, 3, 4, 6, 7];
  const colour = choices[Math.floor(hash(index * 7 + 3) * choices.length)];
  // binfo: palette index, building kind (0 building, 1 light structure), roof type, seed
  const info = [colour, b.kind, b.roof, seed];
  for (const r of rings) {
    let u = 0;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      cell.wallQuad(ax, az, bx, bz, b.base, b.eave, b.ground, u, len, seed, info);
      u += len;
    }
  }
  const rise = b.top - b.eave;
  if (b.roof === 0 || rise < 0.5) {
    cell.cap(rings, b.eave, info);
    return;
  }
  // Pitched roofs climb at ~35°, mansards at ~70° up to a flat top
  const slope = b.roof === 2 ? Math.tan((70 * Math.PI) / 180) : Math.tan((35 * Math.PI) / 180);
  let d = rise / slope, inner = null;
  for (let attempt = 0; attempt < 4 && !inner; attempt++, d *= 0.6) {
    const rs = rings.map((r) => insetRing(r, d));
    if (rs.every(Boolean)) inner = rs;
  }
  if (!inner) {
    cell.cap(rings, b.eave + rise * 0.35, info);
    return;
  }
  const top = b.eave + Math.min(rise, d * slope);
  rings.forEach((r, k) => {
    const s = inner[k];
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const o0 = [r[2 * i], b.eave, r[2 * i + 1]], o1 = [r[2 * q], b.eave, r[2 * q + 1]];
      const i0 = [s[2 * i], top, s[2 * i + 1]], i1 = [s[2 * q], top, s[2 * q + 1]];
      cell.roofTri(o0, o1, i1, info);
      cell.roofTri(o0, i1, i0, info);
    }
  });
  cell.cap(inner, top, info);
}

function createFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const facade = attribute('facade', 'vec4');
  const info = attribute('binfo', 'vec4');
  const palette = PALETTE.map((c) => vec3(...c));
  const pickColour = Fn(([i]) => {
    const c = vec3(palette[0]).toVar();
    for (let k = 1; k < palette.length; k++) c.assign(select(i.greaterThan(k - 0.5), palette[k], c));
    return c;
  });

  const u = facade.x, v = facade.y, wallLen = facade.z, seed = facade.w;
  const isLight = info.y.greaterThan(0.5);
  // Whole bays per wall, ~3.3 m wide; floors of FLOOR_H above a taller ground floor
  const bays = max(floor(wallLen.div(3.3).add(0.5)), 1.0);
  const bayW = wallLen.div(bays);
  const bu = fract(u.div(bayW));
  const level = max(v.sub(GROUND_FLOOR_H), 0.0).div(FLOOR_H);
  const storey = floor(level);
  const fv = fract(level);
  const groundFloor = v.lessThan(GROUND_FLOOR_H);
  const winX = smoothstep(0.24, 0.27, bu).mul(smoothstep(0.24, 0.27, float(1).sub(bu)));
  const winY = select(groundFloor, smoothstep(0.35, 0.4, v).mul(smoothstep(0.35, 0.4, float(GROUND_FLOOR_H - 0.6).sub(v))),
    smoothstep(0.22, 0.26, fv).mul(smoothstep(0.08, 0.12, float(1).sub(fv))));
  const narrowWall = wallLen.lessThan(2.4);
  const window = select(isLight.or(narrowWall), float(0), winX.mul(winY));

  const base = pickColour(info.x);
  const tint = float(0.92).add(fract(seed.mul(91.7)).mul(0.16));
  const wall = base.mul(tint);
  // string courses every floor & a darker plinth
  const course = smoothstep(0.0, 0.03, fv).mul(smoothstep(0.0, 0.03, float(0.06).sub(fv))).mul(step(GROUND_FLOOR_H, v));
  const plinth = float(1).sub(smoothstep(0.6, 0.9, v).mul(0.12));
  const glass = vec3(0.06, 0.08, 0.1);
  mat.colorNode = Fn(() => mix(wall.mul(plinth).mul(float(1).sub(course.mul(0.18))), glass, window))();
  mat.roughnessNode = mix(float(0.86), float(0.12), window);
  mat.metalnessNode = mix(float(0.0), float(0.35), window);

  // Lit rooms at dusk & night: a per-window random draw against the preset's interior glow
  const cell = vec2(floor(u.div(bayW)), storey.add(select(groundFloor, float(-1), float(0))));
  const h = fract(sin(dot(cell.add(seed.mul(57.3)), vec2(12.9898, 78.233))).mul(43758.5453));
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.42), 0.0, 0.85);
  const lit = step(h, litShare).mul(window);
  const warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.85, 0.7), fract(h.mul(13.1)));
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(1.6);
  return mat;
}

function createRoofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const info = attribute('binfo', 'vec4');
  const roofType = info.z;
  const seed = info.w;
  const tiles = vec3(0.55, 0.27, 0.18).mul(float(0.85).add(fract(seed.mul(37.1)).mul(0.3))); // teja árabe
  const slate = vec3(0.24, 0.25, 0.28).mul(float(0.9).add(fract(seed.mul(17.3)).mul(0.2))); // zinc / slate mansards
  const flat = vec3(0.55, 0.54, 0.52).mul(float(0.85).add(fract(seed.mul(53.9)).mul(0.25)));
  const sloped = normalWorld.y.lessThan(0.97);
  // tile courses on pitched roofs
  const courses = smoothstep(0.35, 0.5, abs(fract(positionWorld.y.mul(3.2)).sub(0.5)));
  const pitched = tiles.mul(float(0.85).add(courses.mul(0.15)));
  mat.colorNode = select(roofType.lessThan(0.5).or(sloped.not()), select(roofType.greaterThan(1.5), slate, flat),
    select(roofType.greaterThan(1.5), slate, pitched));
  mat.roughnessNode = select(roofType.greaterThan(1.5), float(0.55), float(0.8));
  mat.metalnessNode = select(roofType.greaterThan(1.5), float(0.25), float(0.0));
  return mat;
}

export function buildDonostiaBuildings(GEO, { hidden = new Set() } = {}) {
  const group = new THREE.Group();
  group.name = 'DonostiaBuildings';
  const cells = new Map();
  GEO.buildings.forEach((b, index) => {
    if (hidden.has(index)) return;
    const r = b.g[0];
    let x = 0, z = 0;
    for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
    const n = r.length / 2;
    const key = `${Math.floor(x / n / CELL)},${Math.floor(z / n / CELL)}`;
    if (!cells.has(key)) cells.set(key, new CellBuilder());
    addBuilding(cells.get(key), b, index, GEO.districts);
  });
  const facadeMat = createFacadeMaterial();
  const roofMat = createRoofMaterial();
  for (const cell of cells.values()) {
    for (const [part, mat] of [['walls', facadeMat], ['roofs', roofMat]]) {
      const geo = cell.geometry(part);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  return group;
}
