import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, abs, fract, sin, max, min, mix, step, smoothstep, fwidth, length, uv, vertexColor,
  positionWorld, normalWorld, mx_noise_float
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/anoeta.js
// Anoeta stadium / Reale Arena (1993, rebuilt 2017-2019 when the athletics track was removed and the stands brought to the pitch): an oval bowl wrapped in a translucent blue membrane (ETFE / PTFE panels) with REALE ARENA lettering, a roof ring over the stands, ~40,000 seats.
//
// build(sites, ctx) receives the GEO.landmarks entries ['anoeta'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// The 2017-2019 rebuild (Izaskun Larzabal, architect; FHECOR, roof & facade engineering; stadiumdb.com, "Reale Arena"):
// the pitch was lowered 1.5 m and new stands brought to 8.5 m behind the goal lines and 10.5 m from the touchlines;
// only the old upper side tiers were kept. Capacity went from 32,076 to ~39,500 seats. The whole bowl is wrapped in
// ~18,500 m² of sky-blue ETFE (25 % translucent: it lights the concourses by day and glows at night) and roofed by the
// old 3D steel space truss extended over the ends, carried by four primary trusses ~10 m deep laid on top of it in a
// "#" — two spanning ~190 m along the stadium, two ~150 m across — resting on concrete columns outside the bowl; a
// ~5,800 m² ring of translucent white ETFE lines the roof's inner edge, with the floodlights under it.
//
// Plan and heights come from the b5m building outline of the stadium (E_A431, tools/donostia/data/b5m_buildings.json):
// its inner ring, the roof opening, is a 115.1 x 82.7 m rounded rectangle whose long axis — the pitch's —
// points 143° (SSE); its outer ring, the membrane's widest girth, is an ellipse of 224.2 x 213.6 m centred 1.3 m north
// of the pitch's centre (measured every 10° within ±0.8 m). b5m gives the roof a mean height of 28.7 m and a maximum
// of 44.1 m above the ground: the membrane meets the roof at 29.5 m, the roof rises to 32.5 m at its inner edge and the
// arched primary trusses top out ~41 m up, mostly hidden behind the membrane's crown from the plaza, as in the photos.
// The OSM outline adds the stairs and ramps up to the concourse doors, widest at the north end (gates 5-6, under the
// REALE ARENA sign, facing the city).

const D2R = Math.PI / 180;
const FRAME = { x: 1253.55, z: 2206.98, angle: 52.92 }; // pitch centre; long axis in degrees from +x (east) to +z (south)
const OPENING = { a: 57.55, b: 41.35, n: 10 }; // roof opening, superellipse half-axes along / across the pitch
const FACADE = { a: 112.1, b: 106.8, u0: -1.3 }; // membrane's widest girth: ellipse half-axes and centre offset
const FRONT = { a: 52.5 + 8.5, b: 34 + 10.5, n: 6 }; // the stands' front: 8.5 m behind the goals, 10.5 m from the touchlines
const N = 192; // samples round the bowl

// heights above the plaza (P) or the pitch (yp), metres
const PODIUM = 2.2; // the concourse deck the stairs climb to
const FOOT = 6.5, CROWN = 29.5; // membrane foot and top, where the roof's outer edge sits (b5m's mean roof height: 28.7 m)
const ROOF_IN = 32.5, ROOF_DEPTH = 2.0; // the roof rises towards its inner edge; sheeting to space-truss soffit
const TRUSS_BOTTOM = 32.3, TRUSS_DEPTH = [4, 8.5]; // primary trusses over the roof, arched: 4 m deep at the ends, 8.5 m mid-span
const LOWER_TOP = 9.5, UPPER_FOOT = 12.0, UPPER_TOP = 26.0, ROW_RISE = 0.4;
// membrane: 64 vertical inflated panels (~10.7 m wide); a lens in section, its widest girth 42 % of the way up
const PANELS = 64, SUB = 6, NV = 20, S0 = 0.42, INSET_FOOT = 4.5, INSET_TOP = 6.0, CUSHION = 0.9;
const CONCOURSE = 9; // the glazed concourse wall and the back of the upper tier stand this far inside the membrane
const STEPS = 12;

// --- small geometry kit (kept local so each landmark module stands alone) ------------------------------------------------

// Pieces collected per material and merged into one mesh each: one draw call per material. From kursaal.js; a
// vertex-coloured material keeps the pieces' own `color` attribute or gets the colour given here.
class Parts {
  constructor() { this.byMaterial = new Map(); }

  add(material, geometry, color = [1, 1, 1]) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const keep = material.vertexColors ? ['position', 'normal', 'uv', 'color'] : ['position', 'normal', 'uv'];
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
    const count = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (material.vertexColors && !g.attributes.color) {
      const c = new Float32Array(count * 3);
      for (let k = 0; k < count; k++) c.set(color, 3 * k);
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    }
    g.clearGroups();
    if (!this.byMaterial.has(material)) this.byMaterial.set(material, []);
    this.byMaterial.get(material).push(g);
  }

  build(name) {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, list] of this.byMaterial) {
      const geometry = mergeGeometries(list);
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }
}

// Flat-shaded faces; each face is turned so its normal agrees with the `out` hint. From kursaal.js, with colours.
class Soup {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }

  face(points, out, color = [1, 1, 1]) {
    const [a, b, c] = points;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    let order = points.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      order = order.slice().reverse();
    }
    for (const k of order) {
      this.pos.push(...points[k]);
      this.nrm.push(nx, ny, nz);
      this.col.push(...color);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

// A smooth quad grid: point(i, j) -> [x, y, z] for i in 0..nu, j in 0..nv, texcoord(i, j) -> [u, v]. Normals are
// turned to agree with out(i, j) (a direction hint); a closed loop (column nu repeating column 0) gets one normal there.
function grid(nu, nv, point, texcoord, out, closed = true) {
  const n = (nu + 1) * (nv + 1);
  const pos = new Float32Array(n * 3), tex = new Float32Array(n * 2);
  for (let j = 0, k = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++, k++) {
      pos.set(point(i, j), 3 * k);
      tex.set(texcoord(i, j), 2 * k);
    }
  }
  const index = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(tex, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  const nrm = g.attributes.normal.array;
  const im = nu >> 1, jm = nv >> 1, km = jm * (nu + 1) + im, hint = out(im, jm);
  if (nrm[3 * km] * hint[0] + nrm[3 * km + 1] * hint[1] + nrm[3 * km + 2] * hint[2] < 0) {
    for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
    g.setIndex(index);
    for (let k = 0; k < nrm.length; k++) nrm[k] = -nrm[k];
  }
  if (closed) {
    for (let j = 0; j <= nv; j++) {
      const a = 3 * j * (nu + 1), b = 3 * (j * (nu + 1) + nu);
      for (let c = 0; c < 3; c++) nrm[a + c] = nrm[b + c] = (nrm[a + c] + nrm[b + c]) / 2;
    }
  }
  return g;
}

// A box beam of section w x h from p0 to p1 (h measured towards `up`)
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
function beam(p0, p1, w, h = w) {
  _y.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const len = _y.length();
  _y.normalize();
  _x.set(0, 1, 0).cross(_y);
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0).cross(_y);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z).setPosition((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  return new THREE.BoxGeometry(w, len, h).applyMatrix4(_m);
}

// Sets a geometry's uv to (0, code) everywhere: the part code the coded materials read from uv.y
function coded(g, code) {
  const n = g.attributes.position.count, a = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) a[2 * k + 1] = code;
  g.setAttribute('uv', new THREE.BufferAttribute(a, 2));
  return g;
}

function superR(t, a, b, n) {
  return Math.pow(Math.pow(Math.abs(Math.cos(t)) / a, n) + Math.pow(Math.abs(Math.sin(t)) / b, n), -1 / n);
}

// Distance from the pitch centre to the membrane's girth along direction t (a ray against the off-centre ellipse)
function facadeR(t) {
  const c = Math.cos(t), s = Math.sin(t), { a, b, u0 } = FACADE;
  const qa = (c * c) / (a * a) + (s * s) / (b * b), qb = (-2 * c * u0) / (a * a), qc = (u0 * u0) / (a * a) - 1;
  return (-qb + Math.sqrt(qb * qb - 4 * qa * qc)) / (2 * qa);
}

// Farthest crossing of a ray from (cx, cz) along (dx, dz) with a ring [x0, z0, ...], or -1
function rayHit(ring, cx, cz, dx, dz) {
  let best = -1;
  for (let i = 0, m = ring.length / 2; i < m; i++) {
    const j = (i + 1) % m;
    const ax = ring[2 * i] - cx, az = ring[2 * i + 1] - cz, ex = ring[2 * j] - cx - ax, ez = ring[2 * j + 1] - cz - az;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-9) continue;
    const t = (ax * ez - az * ex) / den, s = (ax * dz - az * dx) / den;
    if (t > 0 && s >= 0 && s <= 1) best = Math.max(best, t);
  }
  return best;
}

// --- lettering --------------------------------------------------------------------------------------------------------

// Bold sans capitals, cap height 1: ['rect', x0, y0, x1, y1], ['poly', [[x, y], ...]] (convex), and
// ['ring', cx, cy, outer rx, outer ry, inner rx, inner ry, from°, to°] (an elliptic annulus sector, counter-clockwise)
const GLYPHS = {
  A: { w: 0.78, parts: [['poly', [[0, 0], [0.19, 0], [0.48, 1], [0.3, 1]]], ['poly', [[0.59, 0], [0.78, 0], [0.48, 1], [0.3, 1]]], ['rect', 0.18, 0.2, 0.6, 0.35]] },
  C: { w: 0.76, parts: [['ring', 0.4, 0.5, 0.4, 0.5, 0.22, 0.33, 42, 318]] },
  D: { w: 0.74, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0, 0.3, 0.17], ['rect', 0, 0.83, 0.3, 1], ['ring', 0.3, 0.5, 0.44, 0.5, 0.26, 0.33, -90, 90]] },
  E: { w: 0.6, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0.84, 0.6, 1], ['rect', 0, 0.42, 0.54, 0.58], ['rect', 0, 0, 0.6, 0.16]] },
  I: { w: 0.18, parts: [['rect', 0, 0, 0.18, 1]] },
  L: { w: 0.56, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0, 0.56, 0.16]] },
  N: { w: 0.72, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0.54, 0, 0.72, 1], ['poly', [[0, 1], [0.2, 1], [0.72, 0], [0.52, 0]]]] },
  O: { w: 0.8, parts: [['ring', 0.4, 0.5, 0.4, 0.5, 0.22, 0.33, 0, 360]] },
  R: { w: 0.7, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0.84, 0.4, 1], ['rect', 0, 0.4, 0.4, 0.56], ['ring', 0.4, 0.7, 0.3, 0.3, 0.14, 0.14, -90, 90], ['poly', [[0.3, 0.42], [0.5, 0.42], [0.72, 0], [0.5, 0]]]] },
  S: { w: 0.66, parts: [['ring', 0.33, 0.745, 0.33, 0.255, 0.16, 0.085, 25, 270], ['ring', 0.33, 0.255, 0.33, 0.255, 0.16, 0.085, -155, 90]] }
};
const TRACKING = 0.12, SPACE = 0.35;

// Triangles of a primitive, in its own 2D units
function primitiveTriangles(p, emit) {
  if (p[0] === 'rect') {
    const [, x0, y0, x1, y1] = p;
    emit([x0, y0], [x1, y0], [x1, y1]);
    emit([x0, y0], [x1, y1], [x0, y1]);
  } else if (p[0] === 'poly') {
    const v = p[1];
    for (let k = 1; k + 1 < v.length; k++) emit(v[0], v[k], v[k + 1]);
  } else {
    const [, cx, cy, rxo, ryo, rxi, ryi, a0, a1] = p;
    const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 8));
    for (let k = 0; k < n; k++) {
      const t0 = (a0 + ((a1 - a0) * k) / n) * D2R, t1 = (a0 + ((a1 - a0) * (k + 1)) / n) * D2R;
      const o0 = [cx + rxo * Math.cos(t0), cy + ryo * Math.sin(t0)], o1 = [cx + rxo * Math.cos(t1), cy + ryo * Math.sin(t1)];
      const i0 = [cx + rxi * Math.cos(t0), cy + ryi * Math.sin(t0)], i1 = [cx + rxi * Math.cos(t1), cy + ryi * Math.sin(t1)];
      emit(i0, o0, o1);
      emit(i0, o1, i1);
    }
  }
}

function textWidth(text) {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? SPACE : GLYPHS[ch].w + TRACKING;
  return w - TRACKING;
}

// Lays a string out from x = 0 and hands each triangle (cap height 1) to emit
function textTriangles(text, emit) {
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') { x += SPACE; continue; }
    const g = GLYPHS[ch];
    for (const p of g.parts) primitiveTriangles(p, (a, b, c) => emit([a[0] + x, a[1]], [b[0] + x, b[1]], [c[0] + x, c[1]]));
    x += g.w + TRACKING;
  }
}

// --- TSL helpers (from js/tsl-materials.js) --------------------------------------------------------------------------

// Filter-width anti-aliased repeating grid line: gridLine() in js/tsl-materials.js
const gridLine = Fn(([coord, period, halfWidth]) => {
  const p = float(period).toVar();
  const g = float(coord).div(p).toVar();
  const d = float(0.5).sub(abs(fract(g).sub(0.5))).toVar();
  const aa = fwidth(g).max(0.0001).toVar();
  const hw = float(halfWidth).div(p).toVar();
  const effHw = max(hw, aa.mul(0.5)).toVar();
  const cov = smoothstep(effHw.add(aa), effHw.sub(aa), d);
  return cov.mul(min(float(1.0), hw.div(effHw)));
});

// An anti-aliased line at signed distance d from its axis; thinner than a pixel it fades instead of widening (as gridLine)
const stroke = (d, halfWidth) => {
  const aa = fwidth(d).max(0.002);
  const eff = max(aa.mul(0.5), halfWidth);
  return smoothstep(eff.add(aa), eff.sub(aa), abs(d)).mul(min(float(1), float(halfWidth).div(eff)));
};
const inRange = (x, lo, hi) => step(lo, x).mul(step(x, hi));
const codeIs = (code, c) => inRange(code, c - 0.5, c + 0.5);
const nightOf = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);

// --- materials --------------------------------------------------------------------------------------------------------

// The sky-blue ETFE skin: 64 inflated panels between light grey clamping ribs, a faint horizontal cable every ~3 m;
// the stands' and concourses' lights glow through it at night. uv = (panel number, height fraction).
function membraneMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  const panel = uv().x, s = uv().y;
  const rib = gridLine(panel, 1.0, 0.011);
  const cable = gridLine(s, 1 / 8, 0.0035);
  const crown = sin(fract(panel).mul(Math.PI));
  const mottle = mx_noise_float(vec3(panel.mul(0.8), s.mul(4.0), 0.5)).mul(0.05);
  const blue = vec3(0.065, 0.29, 0.72).mul(float(0.9).add(crown.mul(0.1)).add(mottle));
  mat.colorNode = mix(blue.mul(cable.mul(0.2).oneMinus()), vec3(0.42, 0.46, 0.52), rib.mul(0.85));
  mat.roughnessNode = mix(float(0.26), float(0.5), rib);
  const night = nightOf();
  const glow = float(0.55).add(crown.mul(0.45)).mul(smoothstep(0.0, 0.3, s).mul(0.6).add(0.4)).mul(smoothstep(1.0, 0.82, s).mul(0.5).add(0.5));
  mat.emissiveNode = vec3(0.1, 0.4, 1.0).mul(night.mul(glow).mul(1.25)).mul(rib.mul(0.9).oneMinus());
  return mat;
}

// The stands. uv = (metres along the front of the stands, part code): 0 LED boards along the pitch, 1 lower tier,
// 2 glazed boxes under the upper tier, 3 walkway, 4 upper tier, 5 back wall. Rows of blue seats every 0.4 m of rise,
// grey stepped aisles; at night the floodlights light the bowl.
function bowlMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.65, metalness: 0 });
  const along = uv().x, code = uv().y, y = positionWorld.y;
  const seats = codeIs(code, 1).add(codeIs(code, 4));
  const rows = gridLine(y, ROW_RISE, 0.07);
  const aisle = mix(gridLine(along, 15.0, 0.5), gridLine(along, 12.0, 0.45), codeIs(code, 1));
  const blue = vec3(0.012, 0.11, 0.42).mul(rows.mul(0.55).oneMinus());
  const steps = vec3(0.36, 0.36, 0.35).mul(rows.mul(0.35).oneMinus());
  const seatCol = mix(blue, steps, aisle);
  const led = mix(vec3(0.02, 0.06, 0.16), vec3(0.75, 0.8, 0.85), gridLine(along, 9.0, 1.4));
  const boxes = mix(vec3(0.03, 0.04, 0.05), vec3(0.55, 0.56, 0.56), gridLine(along, 4.0, 0.12).max(gridLine(y, 2.5, 0.1)));
  let col = mix(vec3(0.3, 0.3, 0.31), seatCol, seats);
  col = mix(col, led, codeIs(code, 0));
  col = mix(col, boxes, codeIs(code, 2));
  col = mix(col, vec3(0.42, 0.42, 0.41), codeIs(code, 3));
  mat.colorNode = col;
  const night = nightOf();
  mat.emissiveNode = col.mul(night.mul(0.32)).add(led.mul(codeIs(code, 0).mul(night).mul(1.2)))
    .add(vec3(1.0, 0.82, 0.6).mul(codeIs(code, 2).mul(night).mul(0.22)));
  return mat;
}

// Concrete, paving and the concourse's glazed ground floor. uv = (metres along, code): 0 concrete, 1 paving (the
// concourse deck and the stairs), 2 glazed concourse wall (gates, kiosks), 3 soffit under the membrane.
function baseMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const along = uv().x, code = uv().y, y = positionWorld.y;
  const grain = mx_noise_float(positionWorld.mul(0.7)).mul(0.06).add(0.97);
  const concrete = vec3(0.5, 0.5, 0.48).mul(grain).mul(gridLine(y, 1.25, 0.02).mul(0.18).oneMinus());
  const paving = vec3(0.42, 0.4, 0.38).mul(grain);
  const mullions = gridLine(along, 3.0, 0.09).max(gridLine(y, 2.4, 0.06));
  const glazing = mix(vec3(0.03, 0.035, 0.04), vec3(0.36, 0.37, 0.38), mullions);
  let col = mix(concrete, paving, codeIs(code, 1));
  col = mix(col, glazing, codeIs(code, 2));
  col = mix(col, vec3(0.14, 0.14, 0.15), codeIs(code, 3));
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.85), float(0.15), codeIs(code, 2).mul(mullions.oneMinus()));
  const lit = mx_noise_float(vec3(along.mul(0.08), 1.7, 0.0)).mul(0.3).add(0.6);
  // the concourse lit behind the glass; the deck and stairs catch the plaza lamps
  const night = nightOf();
  mat.emissiveNode = vec3(1.0, 0.78, 0.52).mul(codeIs(code, 2).mul(mullions.oneMinus()).mul(lit).mul(0.55).add(codeIs(code, 1).mul(0.035)).mul(night));
  return mat;
}

// The roof: metal sheeting with standing seams on top and a white ETFE ring along the inner edge; underneath, the white
// space truss and a row of floodlights at the inner edge; the inner fascia. uv = (metres along the inner edge,
// metres back from it — negative on the fascia).
function roofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.15 });
  const along = uv().x, d = uv().y;
  const top = smoothstep(-0.25, 0.25, normalWorld.y);
  const fascia = step(d, -0.01);
  const band = smoothstep(16.5, 15.5, d).mul(fascia.oneMinus());
  const sheet = vec3(0.5, 0.52, 0.54).mul(gridLine(along, 1.5, 0.04).mul(0.22).oneMinus()).mul(gridLine(d, 12.0, 0.08).mul(0.3).oneMinus());
  const cushions = gridLine(along, 4.5, 0.1).max(gridLine(d, 4.0, 0.1));
  const etfe = vec3(0.86, 0.88, 0.9).mul(cushions.mul(0.3).oneMinus());
  const p = positionWorld;
  const lattice = gridLine(p.x.add(p.z), 3.6, 0.08).max(gridLine(p.x.sub(p.z), 3.6, 0.08)).max(gridLine(d, 2.5, 0.1));
  const under = mix(mix(vec3(0.24, 0.25, 0.26), vec3(0.6, 0.62, 0.64), band), vec3(0.82, 0.83, 0.84), lattice.mul(0.8));
  const col = mix(mix(under, mix(sheet, etfe, band), top), vec3(0.78, 0.8, 0.82), fascia);
  mat.colorNode = col;
  mat.roughnessNode = mix(float(0.55), float(0.3), band);
  const night = nightOf();
  // floodlights: a continuous row of lamps under the inner edge (and a lit line along the fascia)
  const lamps = smoothstep(0.3, 0.1, abs(fract(along.div(2.4)).sub(0.5))).mul(inRange(d, 0.6, 2.6)).mul(top.oneMinus());
  const fasciaLine = fascia.mul(smoothstep(0.35, 0.0, abs(d.add(1.6))));
  const daylight = band.mul(top.oneMinus()).mul(night.oneMinus()).mul(0.22);
  mat.emissiveNode = vec3(0.92, 0.96, 1.0).mul(lamps.mul(night).mul(14.0).add(fasciaLine.mul(night).mul(2.0)).add(daylight));
  return mat;
}

// The pitch, 105 x 68 m: mown stripes across it and the white markings. uv = metres along / across from the centre.
function pitchMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  const p = uv(), u = p.x, v = p.y, au = abs(u), av = abs(v);
  const hw = 0.06;
  const mow = step(0.5, fract(u.div(105 / 9).add(0.5)));
  const tuft = mx_noise_float(vec3(u.mul(0.35), v.mul(0.35), 2.0)).mul(0.07).add(mx_noise_float(vec3(u.mul(3.1), v.mul(3.1), 0.0)).mul(0.04));
  const grass = mix(vec3(0.028, 0.1, 0.018), vec3(0.04, 0.13, 0.024), mow).mul(tuft.add(1.0));
  const inPitch = inRange(au, 0, 52.5 + hw).mul(inRange(av, 0, 34 + hw));
  const box = (depth, half) => max(stroke(au.sub(52.5 - depth), hw).mul(inRange(av, 0, half + hw)), stroke(av.sub(half), hw).mul(inRange(au, 52.5 - depth, 52.5 + hw)));
  const spot = (x) => smoothstep(0.16, 0.12, length(vec2(au.sub(x), v)));
  const lines = max(
    max(stroke(av.sub(34), hw).mul(inRange(au, 0, 52.5 + hw)), stroke(au.sub(52.5), hw).mul(inRange(av, 0, 34 + hw))),
    max(
      max(stroke(u, hw).mul(inRange(av, 0, 34)), stroke(length(p).sub(9.15), hw)),
      max(max(box(16.5, 20.16), box(5.5, 9.16)), max(
        stroke(length(vec2(au.sub(41.5), v)).sub(9.15), hw).mul(step(au, 36.0)),
        max(stroke(length(vec2(au.sub(52.5), av.sub(34))).sub(1.0), hw).mul(inPitch), max(spot(41.5), smoothstep(0.17, 0.13, length(p))))
      ))
    )
  );
  const col = mix(grass, vec3(0.85, 0.87, 0.85), lines.mul(inPitch));
  mat.colorNode = col;
  mat.emissiveNode = col.mul(nightOf().mul(1.15)); // floodlit
  return mat;
}

// Lettering and logos: vertex colours; the white letters are lit at night. Seat letters (on the tiers, facing up)
// get the rows of the seats.
function signMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 });
  const c = vertexColor();
  const onTier = smoothstep(0.3, 0.6, normalWorld.y);
  const rows = gridLine(positionWorld.y, ROW_RISE, 0.07).mul(onTier);
  mat.colorNode = c.rgb.mul(rows.mul(0.45).oneMinus());
  const white = step(0.8, min(c.r, c.b));
  mat.emissiveNode = c.rgb.mul(white.mul(nightOf()).mul(mix(float(1.6), float(0.3), onTier)));
  return mat;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const site = sites.find((s) => s.id === 'anoeta') || sites[0];
  if (!site) return null;
  const { kit } = ctx;
  const ca = Math.cos(FRAME.angle * D2R), sa = Math.sin(FRAME.angle * D2R);
  // stadium frame: u along the pitch (towards the south end), v across it (towards the west, main stand)
  const world = (u, v) => [FRAME.x + u * ca - v * sa, FRAME.z + u * sa + v * ca];
  const dirOf = (t) => [Math.cos(t) * ca - Math.sin(t) * sa, Math.sin(t) * ca + Math.cos(t) * sa];
  const at = (t, r, y) => { const [dx, dz] = dirOf(t); return [FRAME.x + dx * r, y, FRAME.z + dz * r]; };
  const radial = (t) => { const [dx, dz] = dirOf(t); return [dx, 0, dz]; };
  const ground = (x, z) => kit.groundAt(ctx, x, z);
  const th = (i, n = N) => (i / n) * Math.PI * 2;

  // the plaza: median LiDAR ground along the OSM outline; the pitch just over the highest DTM ground across the grass
  // (the DTM is interpolated over the stadium, at the old pitch's level)
  const outline = site.footprint || [];
  const plaza = [];
  for (let k = 0; k < outline.length; k += 2) plaza.push(ground(outline[k], outline[k + 1]));
  plaza.sort((a, b) => a - b);
  let P = plaza.length ? plaza[plaza.length >> 1] : ground(FRAME.x, FRAME.z);
  let yp = -Infinity;
  for (let u = -FRONT.a; u <= FRONT.a; u += 3) for (let v = -FRONT.b; v <= FRONT.b; v += 3) yp = Math.max(yp, ground(...world(u, v)));
  yp += 0.06;
  P = Math.max(P, yp);

  const rF = (t) => superR(t, FRONT.a, FRONT.b, FRONT.n);
  const rH = (t) => superR(t, OPENING.a, OPENING.b, OPENING.n);
  const rBk = (t) => facadeR(t) - CONCOURSE;
  const rM1 = (t) => rF(t) + (rBk(t) - rF(t)) * 0.4;
  const rM2 = (t) => rM1(t) + 2.2;
  const rTop = (t) => facadeR(t) - INSET_TOP - CUSHION; // the membrane's top edge = the roof's outer edge
  const yRoofTop = (t, r) => P + ROOF_IN + (CROWN - ROOF_IN) * (r - rH(t)) / (rTop(t) - rH(t));
  const yRoofUnder = (t, r) => yRoofTop(t, r) - ROOF_DEPTH;

  // metres along a loop, for the materials' aisles, mullions and seams
  const arc = (rOf) => {
    const s = [0];
    for (let i = 1; i <= N; i++) {
      const a = at(th(i - 1), rOf(th(i - 1)), 0), b = at(th(i), rOf(th(i)), 0);
      s.push(s[i - 1] + Math.hypot(b[0] - a[0], b[2] - a[2]));
    }
    return s;
  };
  const arcF = arc(rF), arcH = arc(rH), arcFacade = arc(facadeR);
  const up = [0, 1, 0], down = [0, -1, 0];
  const inward = (t) => { const r = radial(t); return [-r[0], 0, -r[2]]; };
  // a strip between two rings (t -> [r, y]) round the stadium
  const strip = (inner, outer, code, out, along = arcF) => grid(N, 1,
    (i, j) => { const t = th(i), [r, y] = (j ? outer : inner)(t); return at(t, r, y); },
    (i) => [along[i], code], (i) => out(th(i)));

  const parts = new Parts();
  const membrane = membraneMaterial(), bowl = bowlMaterial(), base = baseMaterial(), roof = roofMaterial();
  const pitch = pitchMaterial(), sign = signMaterial();
  const steel = new THREE.MeshStandardNodeMaterial({ color: 0xe4e7ea, roughness: 0.5, metalness: 0.25 });

  // membrane: lens-shaped in section, 64 cushions bulging out between the ribs
  const yb = P + FOOT, yt = P + CROWN;
  const lensInset = (s) => (s < S0 ? INSET_FOOT * ((S0 - s) / S0) ** 2 : INSET_TOP * ((s - S0) / (1 - S0)) ** 2);
  const NU = PANELS * SUB;
  parts.add(membrane, grid(NU, NV, (i, j) => {
    const t = th(i, NU), s = j / NV, frac = (i % SUB) / SUB;
    const r = facadeR(t) - lensInset(s) - CUSHION * (1 - Math.sin(Math.PI * frac) * Math.sqrt(Math.sin(Math.PI * s)));
    return at(t, r, yb + (yt - yb) * s);
  }, (i, j) => [i / SUB, j / NV], (i) => radial(th(i, NU))));

  // ground floor: the glazed concourse wall under the membrane, its soffit and the columns at the ribs
  const rFoot = (t) => facadeR(t) - INSET_FOOT - CUSHION;
  parts.add(base, strip((t) => [rBk(t), P + PODIUM - 0.1], (t) => [rBk(t), yb], 2, radial, arcFacade));
  parts.add(base, strip((t) => [rBk(t), yb], (t) => [rFoot(t) + 0.05, yb], 3, () => down, arcFacade));
  for (let k = 0; k < PANELS; k++) {
    const t = th(k, PANELS), r = facadeR(t) - INSET_FOOT - CUSHION - 0.8;
    parts.add(base, coded(beam(at(t, r, P + PODIUM - 0.1), at(t, r, yb), 0.7), 0));
  }

  // concourse deck and the stairs down to the plaza, out to the OSM outline (the north end's flight is ~10 m deep)
  const rDeck = (t) => facadeR(t) + 0.3;
  const reach = [], foot = [];
  for (let i = 0; i <= N; i++) {
    const t = th(i), [dx, dz] = dirOf(t);
    const r = outline.length ? rayHit(outline, FRAME.x, FRAME.z, dx, dz) : -1;
    reach.push(Math.max(r - 0.3, rDeck(t) + 0.6));
    const [x, , z] = at(t, reach[i] + 0.8, 0);
    foot.push(Math.min(ground(x, z), P + PODIUM - 0.3));
  }
  parts.add(base, strip((t) => [rBk(t), P + PODIUM], (t) => [rDeck(t), P + PODIUM], 1, () => up, arcFacade));
  for (let k = 0; k < STEPS; k++) {
    const rk = (i, kk) => rDeck(th(i)) + (reach[i] - rDeck(th(i))) * kk / STEPS;
    const yk = (i, kk) => P + PODIUM - (P + PODIUM - foot[i]) * kk / STEPS;
    parts.add(base, grid(N, 1, (i, j) => at(th(i), rk(i, k + j), yk(i, k)), (i) => [arcFacade[i], 1], () => up));
    const yLow = (i) => (k === STEPS - 1 ? yk(i, k + 1) - 0.6 : yk(i, k + 1));
    parts.add(base, grid(N, 1, (i, j) => at(th(i), rk(i, k + 1), j ? yk(i, k) : yLow(i)), (i) => [arcFacade[i], 1], (i) => radial(th(i))));
  }

  // the bowl: LED boards, lower tier, glazed boxes, walkway, upper tier, back wall up to the roof
  const yF = yp + 1.1, yM1 = yp + LOWER_TOP, yM2 = yp + UPPER_FOOT, yBk = P + UPPER_TOP;
  const tierOut = (t) => { const r = inward(t); return [r[0] * 0.5, 1, r[2] * 0.5]; };
  parts.add(bowl, strip((t) => [rF(t), yp - 0.2], (t) => [rF(t), yF], 0, inward));
  parts.add(bowl, strip((t) => [rF(t), yF], (t) => [rM1(t), yM1], 1, tierOut));
  parts.add(bowl, strip((t) => [rM1(t), yM1], (t) => [rM1(t), yM2], 2, inward));
  parts.add(bowl, strip((t) => [rM1(t), yM2], (t) => [rM2(t), yM2], 3, () => up));
  parts.add(bowl, strip((t) => [rM2(t), yM2], (t) => [rBk(t), yBk], 4, tierOut));
  parts.add(bowl, strip((t) => [rBk(t), yBk], (t) => [rBk(t), yRoofUnder(t, rBk(t)) + 0.3], 5, inward));

  // the pitch and its grass margins, out to the front of the stands
  const turf = new THREE.BufferGeometry();
  const tp = [], tuv = [], tidx = [];
  const [cx, cz] = world(0, 0);
  tp.push(cx, yp, cz); tuv.push(0, 0);
  for (let i = 0; i < N; i++) {
    const t = th(i), r = rF(t) + 0.05;
    const p = at(t, r, yp);
    tp.push(...p); tuv.push(r * Math.cos(t), r * Math.sin(t));
    tidx.push(0, 1 + ((i + 1) % N), 1 + i);
  }
  turf.setAttribute('position', new THREE.Float32BufferAttribute(tp, 3));
  turf.setAttribute('normal', new THREE.Float32BufferAttribute(tp.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  turf.setAttribute('uv', new THREE.Float32BufferAttribute(tuv, 2));
  turf.setIndex(tidx);
  parts.add(pitch, turf);
  // goals, 7.32 x 2.44 m
  for (const side of [-1, 1]) {
    const gu = side * 52.6;
    const post = (v) => { const [x, z] = world(gu, v); return [x, z]; };
    const [ax, az] = post(-3.66), [bx, bz] = post(3.66);
    parts.add(steel, beam([ax, yp, az], [ax, yp + 2.44, az], 0.12));
    parts.add(steel, beam([bx, yp, bz], [bx, yp + 2.44, bz], 0.12));
    parts.add(steel, beam([ax, yp + 2.44, az], [bx, yp + 2.44, bz], 0.12));
  }

  // the roof: sheeting & ETFE on top, space truss underneath, the inner fascia with the floodlights
  const NR = 3;
  const roofGrid = (yOf, out) => grid(N, NR, (i, j) => {
    const t = th(i), r = rH(t) + (rTop(t) - rH(t)) * j / NR;
    return at(t, r, yOf(t, r));
  }, (i, j) => [arcH[i], (rTop(th(i)) - rH(th(i))) * j / NR], out);
  parts.add(roof, roofGrid(yRoofTop, () => up));
  parts.add(roof, roofGrid(yRoofUnder, () => down));
  parts.add(roof, grid(N, 1, (i, j) => { const t = th(i), r = rH(t); return at(t, r, j ? yRoofTop(t, r) : yRoofUnder(t, r)); },
    (i, j) => [arcH[i], j ? -0.2 : -2.0], inward));

  // primary trusses, a "#" over the roof: two along the stadium (v = ±55 m), two across it (u = ±75 m), on columns
  // standing inside the membrane's girth (they show only where it curves in under the roof)
  const yBot = P + TRUSS_BOTTOM;
  const endOf = (fixed, alongU) => {
    let s = 100;
    for (let k = 0; k < 4; k++) {
      const u = alongU ? s : fixed, v = alongU ? fixed : s;
      const r = facadeR(Math.atan2(v, u)) - 4.2;
      s = Math.sqrt(Math.max(1, r * r - fixed * fixed));
    }
    return s;
  };
  const truss = (fixed, alongU) => {
    const half = endOf(fixed, alongU);
    const pt = (s, y) => { const [x, z] = alongU ? world(s, fixed) : world(fixed, s); return [x, y, z]; };
    const n = Math.max(8, Math.round((2 * half) / 9.5));
    const node = (k) => { const s = -half + (2 * half * k) / n, f = k / n; return [pt(s, yBot), pt(s, yBot + TRUSS_DEPTH[0] + (TRUSS_DEPTH[1] - TRUSS_DEPTH[0]) * Math.sin(Math.PI * f))]; };
    for (let k = 0; k < n; k++) {
      const [b0, t0] = node(k), [b1, t1] = node(k + 1);
      parts.add(steel, beam(b0, b1, 0.8));
      parts.add(steel, beam(t0, t1, 1.3, 0.9));
      parts.add(steel, beam(b0, t0, 0.45));
      parts.add(steel, k < n / 2 ? beam(b0, t1, 0.4) : beam(t0, b1, 0.4));
    }
    const [bn, tn] = node(n);
    parts.add(steel, beam(bn, tn, 0.45));
    for (const s of [-half, half]) parts.add(base, coded(beam(pt(s, P + PODIUM - 0.1), pt(s, yBot + 0.4), 2.6), 0));
  };
  truss(55, true); truss(-55, true); truss(75, false); truss(-75, false);

  // REALE ARENA on the north end (the stadium's name 2019-2025), white letters 4.2 m tall beside the Reale logo; they
  // stand ~0.3 m proud of the cushions, readable from the plaza (the text runs towards +v as seen from outside)
  const letters = new Soup();
  const WHITE = [0.92, 0.93, 0.95], NAVY = [0.012, 0.03, 0.16], YELLOW = [0.95, 0.62, 0.02];
  const H = 4.2, yText = P + 20.6, logo = 1.08, gap = 0.45;
  const total = logo + gap + textWidth('REALE ARENA');
  const onFacade = (x, y, lift = 0) => {
    const t = Math.PI - ((x - total / 2) * H) / facadeR(Math.PI);
    const s = (yText + y * H - yb) / (yt - yb);
    return at(t, facadeR(t) - lensInset(s) + 0.3 + lift, yText + y * H);
  };
  const facadeOut = radial(Math.PI);
  textTriangles('REALE ARENA', (a, b, c) => letters.face([a, b, c].map(([x, y]) => onFacade(x + logo + gap, y)), facadeOut, WHITE));
  primitiveTriangles(['rect', 0, -0.04, logo, 1.04], (a, b, c) => letters.face([a, b, c].map(([x, y]) => onFacade(x, y)), facadeOut, NAVY));
  primitiveTriangles(['ring', logo, -0.3, 0.98, 0.98, 0.78, 0.78, 104, 162], (a, b, c) => letters.face([a, b, c].map(([x, y]) => onFacade(x, y, 0.04)), facadeOut, YELLOW));
  primitiveTriangles(['ring', logo, -0.3, 0.68, 0.68, 0.52, 0.52, 100, 158], (a, b, c) => letters.face([a, b, c].map(([x, y]) => onFacade(x, y, 0.04)), facadeOut, WHITE));

  // REAL SOCIEDAD in white seats across the east upper tier, read from the main stand
  const seatText = 'REAL SOCIEDAD', tC = -Math.PI / 2, tierSpan = [0.34, 0.62];
  const sw = textWidth(seatText);
  const onTier = (x, y) => {
    const f = tierSpan[0] + (tierSpan[1] - tierSpan[0]) * y;
    const rMid = rM2(tC) + (rBk(tC) - rM2(tC)) * 0.48;
    const slope = Math.hypot(rBk(tC) - rM2(tC), yBk - yM2) * (tierSpan[1] - tierSpan[0]);
    const t = tC + ((x - sw / 2) * slope) / rMid;
    return at(t, rM2(t) + (rBk(t) - rM2(t)) * f, yM2 + (yBk - yM2) * f + 0.06);
  };
  textTriangles(seatText, (a, b, c) => letters.face([a, b, c].map(([x, y]) => onTier(x, y)), up, WHITE));
  parts.add(sign, letters.geometry());

  const group = parts.build('anoeta');
  group.userData.top = P + TRUSS_BOTTOM + TRUSS_DEPTH[1];
  return group;
}
