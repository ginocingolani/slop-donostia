import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, float, vec3, vec4, uniform, uv, mix, max, abs, dot, pow, clamp, floor, fract, length, normalize, smoothstep, mrt,
  positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { IGELDO } from '../data-funicular.js';

// js/donostia/landmarks/igeldo.js
// Monte Igeldo: the 1855 lighthouse on the cliff, El Torreón above the amusement park, the Montaña Suiza scenic railway
// round the summit and the 1912 funicular climbing from Ondarreta, with its two cars running. The first half of the
// file is a small kit shared with the other western landmarks (santa-klara.js, miramar.js, haizearen-orrazia.js,
// ulia-dorrea.js): vertex-coloured materials, parts merged per material, a sweep along a path and a lighthouse light.
//
// build(sites, ctx) receives the GEO.landmarks entries ['igeldo-itsasargia', 'igeldo-torreoia'] and
// ctx = { GEO, terrain, kit }; the funicular, turrets and coaster come from js/donostia/data-funicular.js
// (tools/donostia/bake-funicular.mjs).

// ---------------------------------------------------------------------------------------------------------------------
// Shared kit
// ---------------------------------------------------------------------------------------------------------------------

// sRGB hex -> linear [r, g, b] for vertex colours
export function rgb(hex) {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

function createAshlarMaterial() {
  // Dressed stone whose hue comes from each part's vertex colour (Torreón sandstone, Ulía rubble, plaza granite...);
  // the shader adds grain and the joints of ~0.5 m courses on vertical faces (after kit.js's stoneMaterial)
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const grain = float(0.88).add(mx_noise_float(p.mul(0.9)).mul(0.08)).add(mx_noise_float(p.mul(6.0)).mul(0.04));
    const yy = p.y.div(0.52);
    const fy = fract(yy);
    // horizontal coordinate along a vertical face, so the head joints of alternate courses stagger
    const along = p.x.mul(normalWorld.z).sub(p.z.mul(normalWorld.x));
    const fx = fract(along.div(1.05).add(floor(yy).mul(0.5)));
    const jy = max(smoothstep(0.07, 0.0, fy), smoothstep(0.93, 1.0, fy));
    const jx = max(smoothstep(0.035, 0.0, fx), smoothstep(0.965, 1.0, fx));
    const vertical = smoothstep(0.6, 0.3, abs(normalWorld.y));
    return vec3(grain).mul(mix(float(1.0), float(0.62), max(jy, jx).mul(vertical)));
  })();
  mat.roughnessNode = float(0.86);
  return mat;
}

// Shared by every western landmark: one pipeline each, whatever the colours
export const westMaterials = {
  stone: createAshlarMaterial(),
  paint: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.0 }),
  metal: new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.48, metalness: 0.65 })
};

// Collects parts per material and merges each material's parts into one mesh. Parts lose their uvs; a vertex-coloured
// material gets the part's colour; `extra` attributes ({ name: itemSize }) declared on material.userData.attributes
// are filled from the part's own attribute or a constant.
export class PartBin {
  constructor() {
    this.bins = new Map();
  }

  add(material, geometry, color = null, extra = null) {
    let parts = this.bins.get(material);
    if (!parts) this.bins.set(material, (parts = []));
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (g !== geometry) geometry.dispose();
    const keep = material.userData.attributes || {};
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && !(name in keep)) g.deleteAttribute(name);
    }
    const n = g.attributes.position.count;
    const fill = (name, size, value) => {
      const a = new Float32Array(n * size);
      for (let i = 0; i < n; i++) for (let c = 0; c < size; c++) a[i * size + c] = value ? value[c] : 0;
      g.setAttribute(name, new THREE.BufferAttribute(a, size));
    };
    if (material.vertexColors) fill('color', 3, color || [1, 1, 1]);
    for (const [name, size] of Object.entries(keep)) if (!g.attributes[name]) fill(name, size, extra?.[name]);
    parts.push(g);
    return g;
  }

  merged(material) {
    const parts = this.bins.get(material);
    if (!parts?.length) return null;
    const geo = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    this.bins.delete(material);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    return geo;
  }

  // one static mesh per material into `group`
  build(group, { castShadow = true } = {}) {
    for (const material of [...this.bins.keys()]) {
      const geo = this.merged(material);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }
}

// A horizontal frame at (x, z) turned by `angle` (kit.orientedBox's convention: u along the long axis, v across)
export class Frame {
  constructor(x, z, angle = 0) {
    Object.assign(this, { x, z, angle, c: Math.cos(angle), s: Math.sin(angle) });
    this.matrix = new THREE.Matrix4().makeRotationY(-angle).setPosition(x, 0, z);
  }

  world(u, v) {
    return [this.x + u * this.c - v * this.s, this.z + u * this.s + v * this.c];
  }

  local(x, z) {
    const dx = x - this.x, dz = z - this.z;
    return [dx * this.c + dz * this.s, -dx * this.s + dz * this.c];
  }

  // box spanning y0..y1, centred on (u, v), sizes along u and v, optionally turned by `yaw` within the frame
  box(u, v, su, sv, y0, y1, yaw = 0) {
    const g = new THREE.BoxGeometry(su, y1 - y0, sv);
    if (yaw) g.rotateY(-yaw);
    g.translate(u, (y0 + y1) / 2, v);
    return g.applyMatrix4(this.matrix);
  }

  cylinder(u, v, rTop, rBottom, y0, y1, segments = 16) {
    const g = new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, segments);
    g.translate(u, (y0 + y1) / 2, v);
    return g.applyMatrix4(this.matrix);
  }
}

export const WORLD = new Frame(0, 0, 0);

// Box of section w (across) x h (up) stretched between two points
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _m4 = new THREE.Matrix4();
export function strut(a, b, w, h = w) {
  _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = _a.length();
  _a.divideScalar(len || 1);
  _c.set(-_a.z, 0, _a.x);
  if (_c.lengthSq() < 1e-8) _c.set(0, 0, 1);
  _c.normalize();
  _b.crossVectors(_c, _a);
  _m4.makeBasis(_a, _b, _c).setPosition((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return new THREE.BoxGeometry(len, h, w).applyMatrix4(_m4);
}

// Sweeps a cross-section along a polyline `path` (flat [x, y, z, ...]): section(i) gives the outline at point i as
// flat [lateral, up, ...] (lateral to the right of travel), the same vertex count at every point. Flat-shaded walls,
// faces turned outwards whatever the outline's winding; `caps` closes the two ends of an open path.
export function sweep(path, section, { closed = false, caps = false } = {}) {
  const n = path.length / 3;
  const pos = [];
  const ring = [];
  let plx = 0, ply = 0, plz = 0;
  for (let i = 0; i < n; i++) {
    const i0 = closed ? (i - 1 + n) % n : Math.max(0, i - 1), i1 = closed ? (i + 1) % n : Math.min(n - 1, i + 1);
    let tx = path[3 * i1] - path[3 * i0], ty = path[3 * i1 + 1] - path[3 * i0 + 1], tz = path[3 * i1 + 2] - path[3 * i0 + 2];
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl; ty /= tl; tz /= tl;
    // lateral (right of travel), level wherever the path isn't near vertical; it never flips between neighbours (a
    // path curling over the vertical, like the sculptures' bars, would otherwise twist its section inside out)
    const h = Math.hypot(tx, tz);
    let lx, ly = 0, lz;
    if (h < 0.05 && i > 0) { lx = plx; ly = ply; lz = plz; }
    else if (h < 1e-6) { lx = 1; lz = 0; }
    else { lx = -tz / h; lz = tx / h; }
    if (i > 0 && lx * plx + ly * ply + lz * plz < 0) { lx = -lx; ly = -ly; lz = -lz; }
    const d = lx * tx + ly * ty + lz * tz;
    lx -= d * tx; ly -= d * ty; lz -= d * tz;
    const ll = Math.hypot(lx, ly, lz) || 1;
    lx /= ll; ly /= ll; lz /= ll;
    plx = lx; ply = ly; plz = lz;
    // up, square to the path: lateral x tangent
    const ux = ly * tz - lz * ty, uy = lz * tx - lx * tz, uz = lx * ty - ly * tx;
    const sec = section(i);
    const pts = [];
    let cl = 0, ch = 0;
    for (let k = 0; k < sec.length; k += 2) { cl += sec[k]; ch += sec[k + 1]; }
    cl /= sec.length / 2; ch /= sec.length / 2;
    const P = (l, u) => [path[3 * i] + lx * l + ux * u, path[3 * i + 1] + ly * l + uy * u, path[3 * i + 2] + lz * l + uz * u];
    for (let k = 0; k < sec.length; k += 2) pts.push(P(sec[k], sec[k + 1]));
    ring.push({ pts, centre: P(cl, ch) });
  }
  const tri = (a, b, c, ref) => {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
    const mx = (a[0] + b[0] + c[0]) / 3 - ref[0], my = (a[1] + b[1] + c[1]) / 3 - ref[1], mz = (a[2] + b[2] + c[2]) / 3 - ref[2];
    if (nx * mx + ny * my + nz * mz < 0) pos.push(...a, ...c, ...b);
    else pos.push(...a, ...b, ...c);
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const A = ring[i], B = ring[(i + 1) % n];
    const ref = [(A.centre[0] + B.centre[0]) / 2, (A.centre[1] + B.centre[1]) / 2, (A.centre[2] + B.centre[2]) / 2];
    const m = A.pts.length;
    for (let k = 0; k < m; k++) {
      const k1 = (k + 1) % m;
      tri(A.pts[k], A.pts[k1], B.pts[k1], ref);
      tri(A.pts[k], B.pts[k1], B.pts[k], ref);
    }
  }
  if (caps && !closed && n > 1) {
    // fans facing away from the neighbouring section, which lies inside the solid
    for (const [end, inner] of [[ring[0], ring[1]], [ring[n - 1], ring[n - 2]]]) {
      for (let k = 0; k < end.pts.length; k++) tri(end.centre, end.pts[k], end.pts[(k + 1) % end.pts.length], inner.centre);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

// Polyline helpers on flat [x, z, ...] arrays
export function resample(pts, step, flags = null) {
  const out = { x: [], z: [], s: [], flag: [] };
  let s = 0;
  for (let k = 0; k + 2 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
    const len = Math.hypot(bx - ax, bz - az);
    const count = Math.max(1, Math.round(len / step));
    for (let j = 0; j < count; j++) {
      const f = j / count;
      out.x.push(ax + (bx - ax) * f);
      out.z.push(az + (bz - az) * f);
      out.s.push(s + len * f);
      out.flag.push(flags ? flags[k / 2] : 0);
    }
    s += len;
  }
  const n = pts.length;
  out.x.push(pts[n - 2]);
  out.z.push(pts[n - 1]);
  out.s.push(s);
  out.flag.push(flags ? flags[flags.length - 1] : 0);
  return out;
}

// A 3D path with cumulative arc length, sampled without allocating (for things that move along it)
export class Path3 {
  constructor(x, y, z, closed = false) {
    const n = x.length;
    this.n = n;
    this.closed = closed;
    this.x = Float64Array.from(x);
    this.y = Float64Array.from(y);
    this.z = Float64Array.from(z);
    this.s = new Float64Array(n + 1);
    for (let i = 1; i <= n; i++) {
      const a = i - 1, b = i % n;
      if (i === n && !closed) { this.s[i] = this.s[i - 1]; break; }
      this.s[i] = this.s[i - 1] + Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a], this.z[b] - this.z[a]);
    }
    this.length = closed ? this.s[n] : this.s[n - 1];
  }

  // writes the point at arc length s into `out` (a Vector3)
  at(s, out) {
    const L = this.length;
    if (this.closed) s = ((s % L) + L) % L;
    else s = s < 0 ? 0 : s > L ? L : s;
    const last = this.closed ? this.n : this.n - 1;
    let lo = 0, hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.s[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = lo, b = hi % this.n;
    const span = this.s[hi] - this.s[lo];
    const f = span > 0 ? (s - this.s[lo]) / span : 0;
    out.set(this.x[a] + (this.x[b] - this.x[a]) * f, this.y[a] + (this.y[b] - this.y[a]) * f, this.z[a] + (this.z[b] - this.z[a]) * f);
    return out;
  }
}

// Places a vehicle whose local +x runs along the track and whose body is built for a track grade `designAngle`, from
// two points of the track under its axles
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3();
export function placeOnTrack(object, path, s, halfBase, designAngle = 0) {
  path.at(s - halfBase, _p1);
  path.at(s + halfBase, _p2);
  const dx = _p2.x - _p1.x, dy = _p2.y - _p1.y, dz = _p2.z - _p1.z;
  object.position.set((_p1.x + _p2.x) / 2, (_p1.y + _p2.y) / 2, (_p1.z + _p2.z) / 2);
  object.rotation.set(0, Math.atan2(-dz, dx), Math.atan2(dy, Math.sqrt(dx * dx + dz * dz)) - designAngle);
}

// main.js calls update() only on the objects it adds itself, and the registry (index.js) hands it one group holding
// every landmark: chain the model's update onto whatever group it is added to. The frame guard turns a second call in
// the same frame (should the registry forward updates itself one day) into a no-op.
export function relayUpdate(model, update) {
  let last = -1;
  model.userData.update = (dt, elapsed, camera) => {
    if (elapsed === last) return;
    last = elapsed;
    update(dt, elapsed, camera);
  };
  model.addEventListener('added', () => {
    const parent = model.parent;
    const before = parent?.userData.update;
    if (!parent || before?.relays?.has(model)) return;
    const chained = (dt, elapsed, camera) => {
      if (before) before(dt, elapsed, camera);
      model.userData.update(dt, elapsed, camera);
    };
    chained.relays = new Set([...(before?.relays || []), model]);
    parent.userData.update = chained;
  });
}

// --- Lighthouse lights ------------------------------------------------------------------------------------------------

// Effects that must not touch the normal / metalness buffers the SSR pass reads (as tsl-materials.js's
// _transparentEffectMRT): with additive blending, writing zero leaves what is underneath
const effectMRT = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });
const nightOf = () => smoothstep(0.9, 1.35, cityUniforms.uInteriorGlow);

let beamMaterial = null;
function getBeamMaterial() {
  if (beamMaterial) return beamMaterial;
  // A sweeping beam in the night air: an open cone (uv.y = 0 at the lantern, 1 at the far end), brightest along its
  // axis as seen from the camera, fading with distance (after tsl-materials.js's createGodRayMaterial)
  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending
  });
  mat.mrtNode = effectMRT;
  mat.colorNode = vec3(1.0, 0.95, 0.82);
  mat.opacityNode = Fn(() => {
    const along = uv().y;
    const viewDir = normalize(cameraPosition.sub(positionWorld));
    const edge = smoothstep(0.05, 0.7, abs(dot(viewDir, normalWorld)));
    const fade = pow(float(1.0).sub(along), 1.7).mul(smoothstep(0.0, 0.02, along));
    return fade.mul(edge).mul(nightOf()).mul(0.14);
  })();
  beamMaterial = mat;
  return mat;
}

function createLanternMaterial(flash) {
  // Lens and lamp: glassy by day, a steady glow at night that blazes when a flash points at the camera
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0xdfe6e8, roughness: 0.1, metalness: 0.3 });
  mat.emissiveNode = vec3(1.0, 0.9, 0.72).mul(nightOf().mul(flash.mul(7.0).add(0.7)));
  return mat;
}

function createFlareMaterial(flash) {
  const mat = new THREE.SpriteNodeMaterial({ transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  mat.mrtNode = effectMRT;
  mat.colorNode = vec3(1.0, 0.92, 0.76).mul(3.0);
  mat.opacityNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    const glow = pow(clamp(float(1.0).sub(r), 0.0, 1.0), 2.6);
    return glow.mul(flash).mul(nightOf());
  })();
  return mat;
}

// A lighthouse's light at (x, y, z) (the focal plane), with a lantern of `radius`. The character repeats every
// `period` s with flashes starting at `flashes` (s into the period) and lasting `flashLength` s. With `beams`, the
// flashes come from a rotating optic: one beam per flash, sweeping clockwise from above, so a viewer anywhere sees
// the published sequence; without, the lamp just flashes. Returns the lantern material, an Object3D with the beams &
// flare, and update(elapsed, camera).
export function createLighthouseLight({ x, y, z, radius, period, flashes, flashLength, beams = false, beamLength = 280 }) {
  const group = new THREE.Group();
  group.name = 'LighthouseLight';
  const flash = uniform(0);
  const lantern = createLanternMaterial(flash);
  const omega = (2 * Math.PI) / period;
  const halfWidth = Math.max(0.03, (omega * flashLength) / 2);
  const offsets = flashes.map((t) => -omega * t);
  let beamMesh = null;
  if (beams) {
    const cones = offsets.map((off) => {
      const g = new THREE.CylinderGeometry(beamLength * Math.tan(halfWidth), radius * 0.7, beamLength, 24, 1, true);
      g.rotateZ(-Math.PI / 2);
      g.translate(beamLength / 2, 0, 0);
      g.rotateY(-off);
      return g;
    });
    beamMesh = new THREE.Mesh(mergeGeometries(cones, false), getBeamMaterial());
    beamMesh.position.set(x, y, z);
    beamMesh.castShadow = beamMesh.receiveShadow = false;
    beamMesh.renderOrder = 2;
    group.add(beamMesh);
  }
  const sprite = new THREE.Sprite(createFlareMaterial(flash));
  sprite.position.set(x, y, z);
  sprite.renderOrder = 3;
  group.add(sprite);

  const TAU = 2 * Math.PI;
  let frames = 0;
  const update = (elapsed, camera) => {
    const cam = camera.position;
    const dx = cam.x - x, dy = cam.y - y, dz = cam.z - z;
    const flat = Math.sqrt(dx * dx + dz * dz), dist = Math.sqrt(flat * flat + dy * dy);
    let f = 0;
    if (beams) {
      const theta = (omega * elapsed) % TAU;
      beamMesh.rotation.y = -theta;
      const psi = Math.atan2(dz, dx);
      for (let k = 0; k < offsets.length; k++) {
        let d = theta + offsets[k] - psi;
        d -= TAU * Math.round(d / TAU);
        f += Math.exp(-(d / halfWidth) * (d / halfWidth));
      }
      // the beams are flat cones: a viewer far above or below their plane catches little of them
      const elev = Math.atan2(dy, flat) / (2 * halfWidth + 0.05);
      f *= Math.exp(-elev * elev);
    } else {
      const p = elapsed % period;
      for (let k = 0; k < flashes.length; k++) {
        const t = p - flashes[k];
        if (t > 0 && t < flashLength) f += Math.min(1, t / 0.08) * Math.min(1, (flashLength - t) / 0.15);
      }
    }
    flash.value = Math.min(1, f);
    // the flare sits just in front of the lantern (so the glass doesn't hide it) at a steady size on screen
    const push = (radius + 0.8) / Math.max(dist, 1e-3);
    sprite.position.set(x + dx * push, y + dy * push, z + dz * push);
    const size = Math.min(70, Math.max(3, dist * 0.028));
    sprite.scale.set(size, size, 1);
    // everything stays visible for the first frames so the pipeline warm-up compiles it
    const night = cityUniforms.uInteriorGlow.value > 0.85;
    const warm = frames < 4;
    frames++;
    if (beamMesh) beamMesh.visible = warm || night;
    sprite.visible = warm || (night && f > 0.01);
  };
  return { lantern, object: group, update };
}

// ---------------------------------------------------------------------------------------------------------------------
// Igeldo
// ---------------------------------------------------------------------------------------------------------------------

const M = westMaterials;
const WHITE = rgb(0xeeece6), GREY_STONE = rgb(0xb9b4aa), DARK_GREEN = rgb(0x26332d), IRON = rgb(0x2a2d30);
const STEEL = rgb(0x6b6f72);

// Faro de Igueldo (Manuel Peironcely, 1854-55): a white two-storey keeper's house with a cylindrical tower on its
// seaward end; light 13 m above the ground, focal plane 130 m above the sea (es.wikipedia "Faro del monte Igueldo";
// OSM node 361064995 gives 134 m). Character Fl(2+1) W 15 s: flashes 0.4 s long, eclipses of 1.8, 6 and 6 s, 26 nm.
function buildLighthouse(site, ctx, bin, glass) {
  const { kit, GEO } = ctx;
  const ring = site.footprint;
  const g = kit.lowestGround(ctx, ring);
  const [tx, tz, tr] = IGELDO.lighthouseTower;
  // the house is the outline without the half-round bulge of the tower
  const rect = [];
  for (let k = 0; k < ring.length; k += 2) if (Math.hypot(ring[k] - tx, ring[k + 1] - tz) > tr + 0.3) rect.push(ring[k], ring[k + 1]);
  const ob = kit.orientedBox(rect.length >= 6 ? rect : ring);
  const fr = new Frame(ob.x, ob.z, ob.angle);
  const L = ob.length, W = ob.width;
  const b5m = GEO.buildings[site.buildings?.[0]];
  const eave = b5m && b5m.eave > g + 4 && b5m.eave < g + 9 ? b5m.eave : g + 6;
  const [tu, tv] = fr.local(tx, tz);
  const seaEnd = Math.sign(tu) || 1; // the tower's end of the house

  bin.add(kit.materials.whiteRender, kit.prism(ring, g - 0.8, eave));
  bin.add(M.stone, fr.box(0, 0, L + 0.12, W + 0.12, g - 0.8, g + 0.55), GREY_STONE); // plinth
  bin.add(M.stone, fr.box(0, 0, L + 0.5, W + 0.5, eave - 0.12, eave + 0.22), GREY_STONE); // cornice
  for (const [u, v, su, sv] of [[0, W / 2, L + 0.3, 0.3], [0, -W / 2, L + 0.3, 0.3], [L / 2, 0, 0.3, W], [-L / 2, 0, 0.3, W]]) {
    bin.add(kit.materials.whiteRender, fr.box(u, v, su, sv, eave + 0.22, eave + 0.95)); // parapet
  }
  bin.add(M.paint, fr.box(0, 0, L - 0.2, W - 0.2, eave, eave + 0.3), rgb(0xccc7c1)); // flat roof

  // tall windows in grey stone surrounds, two storeys; a door on the landward end
  const windowAt = (u, v, along, y0, h, w = 1.05) => {
    const su = along === 'u' ? w : 0.2, sv = along === 'u' ? 0.2 : w;
    bin.add(M.stone, fr.box(u, v, su + (along === 'u' ? 0.32 : 0.02), sv + (along === 'u' ? 0.02 : 0.32), y0 - 0.16, y0 + h + 0.16), GREY_STONE);
    bin.add(glass, fr.box(u, v, su + (along === 'u' ? 0 : 0.06), sv + (along === 'u' ? 0.06 : 0), y0, y0 + h));
  };
  for (const v of [-W / 2, W / 2]) {
    for (let i = 0; i < 4; i++) {
      const u = -L / 2 + (L * (i + 0.5)) / 4;
      windowAt(u, v, 'u', g + 1.1, 1.7);
      windowAt(u, v, 'u', g + 3.9, 1.5);
    }
  }
  for (const v of [-W / 4 - 0.6, W / 4 + 0.6]) {
    windowAt(seaEnd * L / 2, v, 'v', g + 1.1, 1.7);
    windowAt(seaEnd * L / 2, v, 'v', g + 3.9, 1.5);
    windowAt(-seaEnd * L / 2, v, 'v', g + 3.9, 1.5);
  }
  windowAt(-seaEnd * L / 2, 0, 'v', g, 2.4, 1.3);

  // the tower: white drum, stone gallery on a corbel ring, iron railing, lantern & dome
  const top = g + 11.0;
  bin.add(kit.materials.whiteRender, WORLD.cylinder(tx, tz, tr + 0.05, tr + 0.12, g - 0.6, top, 28));
  bin.add(M.stone, WORLD.cylinder(tx, tz, tr + 0.2, tr + 0.2, eave - 0.12, eave + 0.22, 28), GREY_STONE);
  bin.add(M.stone, WORLD.cylinder(tx, tz, tr + 0.65, tr + 0.08, top - 0.55, top, 28), GREY_STONE);
  bin.add(M.stone, WORLD.cylinder(tx, tz, tr + 0.65, tr + 0.65, top, top + 0.25, 28), GREY_STONE);
  for (let k = 0; k < 16; k++) {
    const a = (k / 16) * Math.PI * 2;
    bin.add(M.metal, WORLD.box(tx + Math.cos(a) * (tr + 0.55), tz + Math.sin(a) * (tr + 0.55), 0.05, 0.05, top + 0.25, top + 1.2), IRON);
  }
  const rail = new THREE.TorusGeometry(tr + 0.55, 0.035, 6, 40);
  rail.rotateX(Math.PI / 2);
  rail.translate(tx, top + 1.2, tz);
  bin.add(M.metal, rail, IRON);
  // the tower's own windows above the house roof, looking out to sea and back over the land
  const seaAngle = Math.atan2(tz - ob.z, tx - ob.x);
  for (const a of [seaAngle, seaAngle + Math.PI * 0.6, seaAngle - Math.PI * 0.6]) {
    const r = tr + 0.1;
    bin.add(M.stone, WORLD.box(tx + Math.cos(a) * r, tz + Math.sin(a) * r, 0.9, 0.14, top - 3.25, top - 1.45, a + Math.PI / 2), GREY_STONE);
    bin.add(glass, WORLD.box(tx + Math.cos(a) * (r + 0.03), tz + Math.sin(a) * (r + 0.03), 0.62, 0.14, top - 3.1, top - 1.6, a + Math.PI / 2));
  }
  bin.add(M.paint, WORLD.cylinder(tx, tz, 1.3, 1.35, top + 0.25, top + 0.95, 20), WHITE);
  const focal = top + 1.95;
  const lanternTop = top + 2.9;
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    bin.add(M.metal, WORLD.box(tx + Math.cos(a) * 1.18, tz + Math.sin(a) * 1.18, 0.07, 0.07, top + 0.95, lanternTop), DARK_GREEN);
  }
  bin.add(M.paint, WORLD.cylinder(tx, tz, 0.15, 1.45, lanternTop, lanternTop + 1.0, 20), DARK_GREEN);
  bin.add(M.paint, WORLD.cylinder(tx, tz, 1.48, 1.48, lanternTop - 0.05, lanternTop + 0.08, 20), DARK_GREEN);
  const ball = new THREE.SphereGeometry(0.17, 10, 8);
  ball.translate(tx, lanternTop + 1.15, tz);
  bin.add(M.metal, ball, DARK_GREEN);
  bin.add(M.metal, WORLD.box(tx, tz, 0.04, 0.04, lanternTop + 1.0, lanternTop + 1.8), DARK_GREEN);

  const light = createLighthouseLight({
    x: tx, y: focal, z: tz, radius: 1.12, period: 15, flashes: [0, 2.2, 8.6], flashLength: 0.4, beams: true, beamLength: 300
  });
  const lens = new THREE.CylinderGeometry(1.12, 1.12, lanternTop - top - 0.95, 20);
  lens.translate(tx, (top + 0.95 + lanternTop) / 2, tz);
  bin.add(light.lantern, lens);
  return light;
}

// El Torreón: the old wood-fire beacon tower on the summit (16th c.), restored by Luis Elizalde in 1912 with an upper
// floor of large windows and a crenellated terrace reached through two of its four corbelled corner turrets. OSM:
// 22 m high, sandstone #ecd7b8, turrets from 17 m to 22 m (east pair) and 26 m (west pair).
function buildTorreon(site, ctx, bin, glass) {
  const { kit } = ctx;
  const ring = site.footprint;
  const g = kit.lowestGround(ctx, ring);
  const ob = kit.orientedBox(ring);
  const fr = new Frame(ob.x, ob.z, ob.angle);
  const L = ob.length, W = ob.width;
  const SAND = rgb(0xe3cba6), SAND_DARK = rgb(0xc4ab84);
  const terrace = g + 16.6;

  bin.add(M.stone, fr.box(0, 0, L, W, g - 1.2, terrace), SAND);
  bin.add(M.stone, fr.box(0, 0, L + 0.5, W + 0.5, g - 1.2, g + 0.7), SAND_DARK); // battered plinth
  bin.add(M.stone, fr.box(0, 0, L + 0.18, W + 0.18, g + 12.4, g + 12.7), SAND_DARK); // string course of the 1912 floor
  // machicolation: a projecting band on corbels, the parapet and its merlons
  bin.add(M.stone, fr.box(0, 0, L + 0.8, W + 0.8, terrace, terrace + 0.7), SAND_DARK);
  const faces = [[1, 0, W], [-1, 0, W], [0, 1, L], [0, -1, L]]; // outward (u, v) and face length
  for (const [nu, nv, len] of faces) {
    const off = (nu ? L : W) / 2;
    for (let i = 0; i < 6; i++) {
      const t = -len / 2 + 1.2 + ((len - 2.4) * i) / 5;
      const u = nu ? nu * (off + 0.17) : t, v = nv ? nv * (off + 0.17) : t;
      bin.add(M.stone, fr.box(u, v, nu ? 0.36 : 0.3, nv ? 0.36 : 0.3, terrace - 0.6, terrace), SAND_DARK);
    }
    const pu = nu * ((L + 0.8) / 2 - 0.22), pv = nv * ((W + 0.8) / 2 - 0.22);
    bin.add(M.stone, fr.box(pu, pv, nu ? 0.44 : L + 0.8, nv ? 0.44 : W + 0.8, terrace + 0.7, terrace + 1.75), SAND);
    for (let i = 0; i < 5; i++) {
      const t = -len / 2 + 1.7 + ((len - 3.4) * i) / 4;
      bin.add(M.stone, fr.box(nu ? pu : t, nv ? pv : t, nu ? 0.44 : 0.7, nv ? 0.44 : 0.7, terrace + 1.75, terrace + 2.5), SAND);
    }
    // narrow lights below, the large windows of the 1912 floor above
    const face = (t, y0, h, w) => {
      const u = nu ? nu * off : t, v = nv ? nv * off : t;
      bin.add(glass, fr.box(u, v, nu ? 0.16 : w, nv ? 0.16 : w, y0, y0 + h));
      bin.add(M.stone, fr.box(u + nu * 0.02, v + nv * 0.02, nu ? 0.12 : w + 0.35, nv ? 0.12 : w + 0.35, y0 + h, y0 + h + 0.3), SAND_DARK);
    };
    face(0, g + 4.2, 1.5, 0.55);
    face(0, g + 8.2, 1.5, 0.55);
    face(-len / 4.2, g + 13.1, 2.3, 1.25);
    face(len / 4.2, g + 13.1, 2.3, 1.25);
  }
  // the door faces the park (its middle lies to the south-west of the tower)
  let best = null;
  const toPark = fr.local(-1715, 54);
  for (const [nu, nv] of faces) {
    const d = nu * toPark[0] + nv * toPark[1];
    if (!best || d > best.d) best = { d, nu, nv };
  }
  bin.add(glass, fr.box(best.nu * (L / 2), best.nv * (W / 2), best.nu ? 0.2 : 1.4, best.nv ? 0.2 : 1.4, g, g + 2.6));

  // corbelled corner turrets
  for (const [x, z, r, h0, h1] of IGELDO.turrets) {
    const y0 = g + h0, y1 = g + h1;
    bin.add(M.stone, WORLD.cylinder(x, z, r, 0.3, y0 - 1.8, y0, 16), SAND_DARK);
    bin.add(M.stone, WORLD.cylinder(x, z, r, r, y0, y1, 16), SAND);
    bin.add(M.stone, WORLD.cylinder(x, z, r + 0.12, r + 0.12, y1 - 0.45, y1, 16), SAND_DARK);
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      bin.add(M.stone, WORLD.box(x + Math.cos(a) * (r - 0.05), z + Math.sin(a) * (r - 0.05), 0.55, 0.3, y1, y1 + 0.6, a + Math.PI / 2), SAND);
    }
    for (const a of [0.6, 3.7]) {
      bin.add(glass, WORLD.box(x + Math.cos(a) * r, z + Math.sin(a) * r, 0.25, 0.14, y0 + 1.2, y0 + 2.4, a + Math.PI / 2));
    }
  }
}

// --- Funicular ------------------------------------------------------------------------------------------------------

// Funicular de Igueldo (25 August 1912): 312 m long, 151 m of rise, 48.4 % mean and 57.9 % maximum grade, metre gauge,
// 1.5 m/s and about 3 minutes a trip; two cars of about 10 m in five stepped compartments for 50 passengers, red with
// black trim, on Von Roll chassis, passing halfway up (es.wikipedia "Funicular de Igueldo").
const CAR = { length: 9.0, width: 2.3, design: Math.atan(0.484), axle: 3.2 };
const TRIP = 180, DWELL = 30;

// Track level along a route: hugs the ground where it is convex and bridges its dips (a smoothed upper envelope of the
// LiDAR profile), never below the ground, never going down on the way up
function funicularProfile(xs, zs, terrain) {
  const n = xs.length;
  const g = xs.map((x, i) => terrain.heightAt(x, zs[i]));
  let y = g.map((h) => h + 0.45);
  const w = 5;
  for (let iter = 0; iter < 120; iter++) {
    const next = y.slice();
    for (let i = 1; i < n - 1; i++) {
      let sum = 0, count = 0;
      for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { sum += y[j]; count++; }
      next[i] = Math.max(sum / count, g[i] + 0.45);
    }
    y = next;
  }
  for (let i = 1; i < n; i++) y[i] = Math.max(y[i], y[i - 1]);
  return { g, y };
}

function buildFunicular(ctx, bin) {
  const { terrain } = ctx;
  const [A, B] = IGELDO.funicular.map((r) => resample(r.pts, 1.0, r.bridges));
  const pa = funicularProfile(A.x, A.z, terrain);
  // the second route follows the first's profile, by distance from the bottom, and stays above its own ground
  const lenA = A.s[A.s.length - 1], lenB = B.s[B.s.length - 1];
  const levelA = (s) => {
    const f = Math.min(A.s.length - 1, Math.max(0, (s / lenB) * lenA));
    let i = 0;
    while (i + 1 < A.s.length && A.s[i + 1] < f) i++;
    const t = A.s[i + 1] > A.s[i] ? (f - A.s[i]) / (A.s[i + 1] - A.s[i]) : 0;
    return pa.y[i] + (pa.y[Math.min(i + 1, A.s.length - 1)] - pa.y[i]) * Math.min(1, Math.max(0, t));
  };
  const gB = B.x.map((x, i) => terrain.heightAt(x, B.z[i]));
  const yB = B.s.map((s, i) => Math.max(levelA(s), gB[i] + 0.45));
  // where the second route leaves the first (the passing loop)
  const offA = B.x.map((x, i) => {
    let best = Infinity;
    for (let j = 0; j + 1 < A.x.length; j++) {
      const ax = A.x[j], az = A.z[j], bx = A.x[j + 1], bz = A.z[j + 1];
      const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (B.z[i] - az) * dz) / l2));
      best = Math.min(best, Math.hypot(x - ax - t * dx, B.z[i] - az - t * dz));
    }
    return best;
  });

  const BED = rgb(0x9b968c), SLEEPER = rgb(0x3d3833);
  // `sink` drops the second track a touch, where it lies over the first at the ends of the loop (no z-fighting)
  const addTrack = (R, ys, gs, from, to, sink = 0) => {
    // every second metre is plenty for the geometry
    const idx = [];
    for (let i = from; i <= to; i += 2) idx.push(i);
    if (idx[idx.length - 1] !== to) idx.push(to);
    if (idx.length < 2) return;
    const path = [];
    for (const i of idx) path.push(R.x[i], ys[i], R.z[i]);
    // masonry bed down to the ground (a retaining wall on the slope), a shallow deck on the bridge spans
    bin.add(M.stone, sweep(path, (k) => {
      const i = idx[k];
      const lowGround = Math.min(gs[i], terrain.heightAt(R.x[i] + 1.4, R.z[i]), terrain.heightAt(R.x[i] - 1.4, R.z[i]));
      const bottom = R.flag[i] ? -1.3 : Math.min(-0.6, lowGround - ys[i] - 0.6);
      return [-1.35, -0.26 - sink, 1.35, -0.26 - sink, 1.35, bottom, -1.35, bottom];
    }, { caps: true }), BED);
    for (const l of [-0.53, 0.53]) {
      bin.add(M.metal, sweep(path, () => [l - 0.04, -0.13, l + 0.04, -0.13, l + 0.04, -sink, l - 0.04, -sink], { caps: true }), STEEL);
    }
    // sleepers, and stone piers under the bridge spans
    const p = new Path3(idx.map((i) => R.x[i]), idx.map((i) => ys[i]), idx.map((i) => R.z[i]));
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let s = 0.8; s < p.length - 0.5; s += 1.6) {
      p.at(s - 0.05, v);
      p.at(s + 0.05, w);
      const dx = w.x - v.x, dz = w.z - v.z, h = Math.hypot(dx, dz) || 1;
      const lx = (-dz / h) * 0.8, lz = (dx / h) * 0.8;
      bin.add(M.paint, strut([v.x - lx, v.y - 0.19, v.z - lz], [v.x + lx, v.y - 0.19, v.z + lz], 0.24, 0.12), SLEEPER);
    }
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      if (!R.flag[i] || k % 4) continue;
      if (ys[i] - gs[i] < 2.5) continue;
      bin.add(M.stone, WORLD.box(R.x[i], R.z[i], 1.4, 1.4, gs[i] - 0.5, ys[i] - 1.3), BED);
    }
  };
  addTrack(A, pa.y, pa.g, 0, A.x.length - 1);
  // the passing loop's second track (plus a metre either side so it meets the shared line)
  let i0 = offA.findIndex((d) => d > 0.3), i1 = offA.length - 1 - [...offA].reverse().findIndex((d) => d > 0.3);
  if (i0 > 0 && i1 > i0) addTrack(B, yB, gB, Math.max(0, i0 - 2), Math.min(B.x.length - 1, i1 + 2), 0.02);

  // the two cars
  const carBin = new PartBin();
  const RED = rgb(0x9a1c17), BLACK = rgb(0x111213), GLASS = rgb(0x1a2329), ROOF = rgb(0x2c2c2e);
  const t = Math.tan(CAR.design);
  const half = CAR.length / 2;
  const slab = (x0, x1, b0, b1, width, color, mat = M.paint) => {
    // a side-profile parallelogram (vertical ends, edges along the design grade) extruded across the car
    const shape = new THREE.Shape();
    shape.moveTo(x0, b0 + x0 * t);
    shape.lineTo(x1, b0 + x1 * t);
    shape.lineTo(x1, b1 + x1 * t);
    shape.lineTo(x0, b1 + x0 * t);
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: width, bevelEnabled: false });
    g.translate(0, 0, -width / 2);
    carBin.add(mat, g, color);
  };
  slab(-half, half, 0.62, 3.35, CAR.width, RED);
  slab(-half - 0.02, half + 0.02, 0.58, 0.98, CAR.width + 0.04, BLACK);
  slab(-half - 0.02, half + 0.02, 3.05, 3.35, CAR.width + 0.04, BLACK);
  slab(-half - 0.25, half + 0.25, 3.35, 3.5, CAR.width + 0.24, ROOF);
  for (let k = 0; k < 5; k++) {
    // one window per compartment, each a step higher than the last
    const xc = -half + (CAR.length * (k + 0.5)) / 5;
    const g = new THREE.BoxGeometry(1.25, 1.0, CAR.width + 0.06);
    g.translate(xc, xc * t + 1.85, 0);
    carBin.add(M.paint, g, GLASS);
  }
  for (const xe of [-half, half]) {
    const g = new THREE.BoxGeometry(0.06, 1.0, 1.6);
    g.translate(xe, xe * t + 1.85, 0);
    carBin.add(M.paint, g, GLASS);
  }
  carBin.add(M.paint, strut([-half + 0.4, (-half + 0.4) * t + 0.32, 0], [half - 0.4, (half - 0.4) * t + 0.32, 0], 1.5, 0.42), BLACK);
  for (const xa of [-CAR.axle, CAR.axle]) {
    for (const z of [-0.53, 0.53]) {
      const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.12, 12);
      wheel.rotateX(Math.PI / 2);
      wheel.translate(xa, xa * t + 0.34, z);
      carBin.add(M.paint, wheel, BLACK);
    }
  }
  const carGeo = carBin.merged(M.paint);
  const pathA = new Path3(A.x, pa.y, A.z), pathB = new Path3(B.x, yB, B.z);
  const cars = [pathA, pathB].map((path) => {
    const car = new THREE.Mesh(carGeo, M.paint);
    car.rotation.order = 'YZX';
    car.castShadow = car.receiveShadow = true;
    car.userData.path = path;
    return car;
  });
  const group = new THREE.Group();
  group.name = 'Funicular';
  for (const car of cars) group.add(car);
  const centre = new THREE.Vector3((A.x[0] + A.x[A.x.length - 1]) / 2, (pa.y[0] + pa.y[pa.y.length - 1]) / 2, (A.z[0] + A.z[A.z.length - 1]) / 2);

  // Car A climbs while car B comes down; both dwell at the stations. Travel with short speed ramps.
  const RAMP = 0.08, VMAX = 1 / (1 - RAMP);
  const ease = (u) => (u < RAMP ? (u * u * VMAX) / (2 * RAMP) : u < 1 - RAMP ? (RAMP / 2 + u - RAMP) * VMAX : 1 - ((1 - u) * (1 - u) * VMAX) / (2 * RAMP));
  const update = (elapsed, camera) => {
    const far = camera.position.distanceTo(centre) > 2200;
    const p = elapsed % (2 * (TRIP + DWELL));
    const f = p < DWELL ? 0 : p < DWELL + TRIP ? ease((p - DWELL) / TRIP) : p < 2 * DWELL + TRIP ? 1 : 1 - ease((p - 2 * DWELL - TRIP) / TRIP);
    for (let k = 0; k < 2; k++) {
      const car = cars[k];
      car.visible = !far;
      if (far) continue;
      const path = car.userData.path;
      const run = path.length - CAR.length - 1;
      const s = half + 0.5 + (k === 0 ? f : 1 - f) * run;
      placeOnTrack(car, path, s, CAR.axle, CAR.design);
    }
  };
  return { object: group, update };
}

// --- Montaña Suiza ------------------------------------------------------------------------------------------------------

// Scenic railway by Erich Heidrich (1928): about 400 m of track, 9.8 m high at most, 50 km/h; wooden two-car trains
// with a brakeman riding between the cars (en.wikipedia "Montaña Suiza"). The centreline is the 1:500 map's
// (data-funicular.js); the lift and the hills here are a plausible profile, not a survey.
function buildCoaster(ctx, bin) {
  const { terrain } = ctx;
  const c = IGELDO.coaster;
  const n = c.length / 2;
  const xs = [], zs = [];
  for (let k = 0; k < c.length; k += 2) { xs.push(c[k]); zs.push(c[k + 1]); }
  // the boating pond under the western leg is baked as sea-level water, a pit in the summit: ignore anything well below
  // the ground around it and bridge across
  const raw = xs.map((x, i) => terrain.heightAt(x, zs[i]));
  const valid = raw.map((h, i) => {
    const near = [];
    for (let j = -12; j <= 12; j++) near.push(raw[(i + j + n) % n]);
    near.sort((p, q) => p - q);
    return h > near[12] - 5;
  });
  const g = raw.slice();
  for (let i = 0; i < n; i++) {
    if (valid[i]) continue;
    let a = i, b = i;
    while (!valid[(a - 1 + n) % n] && a - i > -n) a--;
    while (!valid[(b + 1) % n] && b - i < n) b++;
    const ga = raw[(a - 1 + n) % n], gb = raw[(b + 1) % n];
    g[i] = ga + ((gb - ga) * (i - a + 1)) / (b - a + 2);
  }
  const step = 1.5;
  const L = n * step;
  const nearest = (x, z) => {
    let best = 0, d = Infinity;
    for (let i = 0; i < n; i++) {
      const e = Math.hypot(xs[i] - x, zs[i] - z);
      if (e < d) { d = e; best = i; }
    }
    return best * step;
  };
  const liftStart = nearest(-1737.8, 69.5), liftEnd = nearest(-1674.0, 32.2);
  const liftLen = (liftEnd - liftStart + L) % L;
  const bump = (d, at, h, w) => h * Math.exp(-(((d - at) / w) ** 2));
  const clearance = (s) => {
    const d = (s - liftStart + L) % L;
    let h = 1.0;
    if (d <= liftLen) h += 8.8 * (d / liftLen);
    else if (d <= liftLen + 26) h += 8.8 * (0.5 + 0.5 * Math.cos((Math.PI * (d - liftLen)) / 26));
    h += bump(d, liftLen + 50, 4.5, 9) + bump(d, liftLen + 100, 3.5, 8) + bump(d, liftLen + 150, 3.0, 9) + bump(d, liftLen + 205, 2.2, 10);
    return h;
  };
  const avg = (arr, i, w) => {
    let sum = 0;
    for (let j = -w; j <= w; j++) sum += arr[(i + j + n) % n];
    return sum / (2 * w + 1);
  };
  let y = g.map((_, i) => avg(g, i, 6) + clearance(i * step));
  for (let pass = 0; pass < 3; pass++) y = y.map((_, i) => Math.max(avg(y, i, 2), g[i] + 0.7));

  const path = [];
  for (let i = 0; i < n; i++) path.push(xs[i], y[i], zs[i]);
  const GREEN = rgb(0x2f4a3b), TIE = rgb(0x4a3b2c);
  bin.add(M.metal, sweep(path, () => [-0.32, -0.62, 0.32, -0.62, 0.32, -0.22, -0.32, -0.22], { closed: true }), GREEN);
  for (const l of [-0.45, 0.45]) {
    bin.add(M.metal, sweep(path, () => [l - 0.04, -0.1, l + 0.04, -0.1, l + 0.04, 0, l - 0.04, 0], { closed: true }), STEEL);
  }
  const track = new Path3(xs, y, zs, true);
  const v = new THREE.Vector3(), w = new THREE.Vector3();
  for (let s = 0; s < track.length; s += 1.2) {
    track.at(s - 0.05, v);
    track.at(s + 0.05, w);
    const dx = w.x - v.x, dz = w.z - v.z, h = Math.hypot(dx, dz) || 1;
    const lx = -dz / h, lz = dx / h;
    bin.add(M.paint, strut([v.x - lx * 0.62, v.y - 0.16, v.z - lz * 0.62], [v.x + lx * 0.62, v.y - 0.16, v.z + lz * 0.62], 0.16, 0.1), TIE);
    if (Math.round(s / 1.2) % 4) continue;
    // a trestle bent every 4.8 m: two legs, braced when tall
    const i = Math.round(s / step) % n;
    const ground = g[i] - 0.3;
    const top = v.y - 0.62;
    if (top - ground < 0.4) continue;
    const left = [v.x - lx * 0.7, top, v.z - lz * 0.7], right = [v.x + lx * 0.7, top, v.z + lz * 0.7];
    const leftFoot = [v.x - lx * 1.0, ground, v.z - lz * 1.0], rightFoot = [v.x + lx * 1.0, ground, v.z + lz * 1.0];
    bin.add(M.metal, strut(leftFoot, left, 0.16), GREEN);
    bin.add(M.metal, strut(rightFoot, right, 0.16), GREEN);
    if (top - ground > 2.5) {
      const mid = (top + ground) / 2;
      bin.add(M.metal, strut([v.x - lx * 0.85, mid, v.z - lz * 0.85], [v.x + lx * 0.85, mid, v.z + lz * 0.85], 0.1), GREEN);
      bin.add(M.metal, strut(leftFoot, right, 0.08), GREEN);
    }
  }

  // the train: two open wooden cars
  const trainBin = new PartBin();
  const WOOD = rgb(0x8a5532), SEAT = rgb(0x6d1714);
  trainBin.add(M.paint, new THREE.BoxGeometry(2.2, 0.7, 1.2).translate(0, 0.65, 0), WOOD);
  trainBin.add(M.paint, new THREE.BoxGeometry(1.9, 0.12, 1.0).translate(0, 1.0, 0), SEAT);
  trainBin.add(M.paint, new THREE.BoxGeometry(0.12, 0.5, 1.0).translate(-0.2, 1.25, 0), SEAT);
  trainBin.add(M.paint, new THREE.BoxGeometry(0.12, 0.5, 1.0).translate(0.75, 1.25, 0), SEAT);
  trainBin.add(M.paint, new THREE.BoxGeometry(1.6, 0.25, 0.9).translate(0, 0.18, 0), rgb(0x161616));
  const trainGeo = trainBin.merged(M.paint);
  const cars = [0, 1].map(() => {
    const car = new THREE.Mesh(trainGeo, M.paint);
    car.rotation.order = 'YZX';
    car.castShadow = true;
    return car;
  });
  const group = new THREE.Group();
  group.name = 'MontanaSuiza';
  for (const car of cars) group.add(car);
  // speed from the drop below the top of the lift (with losses), a steady chain speed on the lift
  const top = Math.max(...y);
  const speed = y.map((h, i) => {
    const d = (i * step - liftStart + L) % L;
    if (d <= liftLen) return 2.2;
    return Math.min(13.9, Math.max(2.5, Math.sqrt(2 * 9.81 * 0.75 * Math.max(0, top + 0.4 - h))));
  });
  const centre = new THREE.Vector3(xs[0], y[0], zs[0]);
  let s = liftStart;
  const update = (dt, camera) => {
    const far = camera.position.distanceTo(centre) > 1500;
    s = (s + speed[Math.min(n - 1, Math.floor((s / track.length) * n))] * dt) % track.length;
    for (let k = 0; k < 2; k++) {
      cars[k].visible = !far;
      if (!far) placeOnTrack(cars[k], track, s - k * 2.6, 0.8);
    }
  };
  return { object: group, update };
}

export function build(sites, ctx) {
  const group = new THREE.Group();
  group.name = 'Igeldo';
  const bin = new PartBin();
  const glass = ctx.kit.materials.glass;
  const updaters = [];
  const lighthouse = sites.find((s) => s.id === 'igeldo-itsasargia');
  const torreon = sites.find((s) => s.id === 'igeldo-torreoia');
  if (lighthouse?.footprint) {
    const light = buildLighthouse(lighthouse, ctx, bin, glass);
    group.add(light.object);
    updaters.push((dt, elapsed, camera) => light.update(elapsed, camera));
  }
  if (torreon?.footprint) buildTorreon(torreon, ctx, bin, glass);
  const funicular = buildFunicular(ctx, bin);
  group.add(funicular.object);
  updaters.push((dt, elapsed, camera) => funicular.update(elapsed, camera));
  const coaster = buildCoaster(ctx, bin);
  group.add(coaster.object);
  updaters.push((dt, elapsed, camera) => coaster.update(dt, camera));
  bin.build(group);
  relayUpdate(group, (dt, elapsed, camera) => {
    for (let k = 0; k < updaters.length; k++) updaters[k](dt, elapsed, camera);
  });
  return group;
}
