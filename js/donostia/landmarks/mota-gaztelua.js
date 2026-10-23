import * as THREE from 'three/webgpu';
import { float, vec3, smoothstep, positionWorld, mx_noise_float } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';
import { URGULL_PARTS } from '../data-urgull-parts.js';

// js/donostia/landmarks/mota-gaztelua.js
// Mota gaztelua / Castillo de la Mota on top of Urgull (12th-18th c.), stone fortress walls, and on its keep the chapel tower carrying the 12.5 m Sagrado Corazón (Sacred Heart) statue facing the city, arms open, visible from the whole bay.
//
// build(sites, ctx) receives the GEO.landmarks entries ['mota-gaztelua'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// The castle is "un torreón llamado Macho y una espaciosa plataforma" (Donostia's heritage catalogue): the layout and
// heights come from OpenStreetMap's building parts (js/donostia/data-urgull-parts.js, laid onto the 1:500 outline):
// the low tiled wings to the west (8 and 9.2 m), the tall south wing (14.5 m), the round battery on the east (a 9 m
// terrace behind a parapet), the central block (11.5 m) and the Macho (14 m), which carries the monument. The monument
// (1950, architect Pedro Muguruza, sculptor Federico Coullaut-Valera) is a ~16 m stone base holding a chapel, with the
// 12.5 m statue on it, 29 m above the ground in all (OSM; "more than 24 m" says the tourist board). The photographs
// (Wikimedia Commons, from the city and from the terrace) show the chapel as a battered block rising over the terrace
// about two-thirds as high as the statue, then a stepped pedestal; OSM's 14 m Macho would bury it behind the battery's
// parapet, so the chapel is raised to 17 m and the figure's feet stand at 19.3 m, its head at ~32 m. The statue faces
// the city across the Parte Vieja, as does one side of OSM's square pedestal part. OSM heights are taken above each
// part's lowest ground.

const PARTS = URGULL_PARTS['mota-gaztelua'];
const STATUE_H = 12.5;
const CHAPEL_H = 17.0; // the chapel block's top above the Macho's ground
const PLINTH_H = 19.3; // the statue's feet above the Macho's ground
const ROOF_RISE = { 1493466698: 2.8, 1493466704: 2.6, 1493466705: 1.7 }; // tiled roofs (OSM roof:levels 1, 1, 0.6)
const MACHO = 1493466701, PEDESTAL = 1493466700, STATUE = 1493466699, BATTERY = 1493466703, CENTRE = 1493466702;

// --- small geometry kit (kept local so each landmark module stands alone) ------------------------------------------------

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _v = new THREE.Vector3(), _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// Pieces collected per material and merged into one mesh each: one draw call per material
class Parts {
  constructor() { this.byMaterial = new Map(); }

  add(material, geometry, matrix = null) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (matrix) g.applyMatrix4(matrix);
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

// Box of size (w, h, d) whose base centre stands at (x, y, z), turned by yaw (rotation.y)
function box(w, h, d, x, y, z, yaw = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g.applyMatrix4(_m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, yaw, 0)), _s.set(1, 1, 1)));
}

// Moves a geometry built around the origin (y up) so its +y runs along `dir` from point `p`
function along(g, p, dir) {
  _q.setFromUnitVectors(UP, _v.copy(dir).normalize());
  return g.applyMatrix4(_m.compose(new THREE.Vector3(...p), _q, _s.set(1, 1, 1)));
}

function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

// Ring with the requested winding (area > 0: edge normals (dz, -dx) point out of the solid). From js/donostia/buildings.js.
function wound(r, positive = true) {
  if ((signedArea(r) > 0) === positive) return r;
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
}

// Miter offset of a ring by d towards its inside (negative d grows it); null when an edge flips or the ring collapses.
// From insetRing() in js/donostia/buildings.js.
function insetRing(r, d) {
  const n = r.length / 2;
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let ax = r[2 * i] - r[2 * p], az = r[2 * i + 1] - r[2 * p + 1];
    let bx = r[2 * q] - r[2 * i], bz = r[2 * q + 1] - r[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx;
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
  const a0 = signedArea(r), a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.02 * Math.abs(a0)) return null;
  return out;
}

// Triangle soup with flat normals; up-facing triangles are wound so they face the sky
class Tris {
  constructor() { this.pos = []; this.nrm = []; }

  tri(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    for (const p of [a, b, c]) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(nx / l, ny / l, nz / l); }
  }

  cap(ring, y) {
    const pts = [];
    for (let k = 0; k < ring.length; k += 2) pts.push(new THREE.Vector2(ring[k], ring[k + 1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      this.tri([pts[a].x, y, pts[a].y], [pts[b].x, y, pts[b].y], [pts[c].x, y, pts[c].y]);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    return g;
  }
}

// Drops vertices closer than tol to the line through their neighbours (near-collinear runs and tiny jogs), which
// would otherwise flip under the large insets of a hip roof
function simplify(r, tol = 0.35) {
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push([r[k], r[k + 1]]);
  for (let changed = true; changed && pts.length > 4;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 4; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      if (Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / (Math.hypot(dx, dz) || 1e-9) < tol) {
        pts.splice(i--, 1);
        changed = true;
      }
    }
  }
  return pts.flat();
}

// Hip roof over a ring: slopes rising `rise` from the eaves to a ridge (an inset of about half the ring's width)
function hipRoof(ring, eave, rise, inset) {
  const r = wound(simplify(ring));
  const t = new Tris();
  let inner = null;
  for (let d = inset, k = 0; k < 8 && !inner; k++, d *= 0.8) inner = insetRing(r, d);
  if (!inner) {
    t.cap(r, eave + 0.08); // flat, just over the walls' top
    return t.geometry();
  }
  const top = eave + rise;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const o0 = [r[2 * i], eave, r[2 * i + 1]], o1 = [r[2 * q], eave, r[2 * q + 1]];
    const i0 = [inner[2 * i], top, inner[2 * i + 1]], i1 = [inner[2 * q], top, inner[2 * q + 1]];
    t.tri(o0, o1, i1);
    t.tri(o0, i1, i0);
  }
  t.cap(inner, top);
  return t.geometry();
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function centroid(r) {
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
}

function distToRing(x, z, r) {
  let best = Infinity;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

// --- materials --------------------------------------------------------------------------------------------------------

// The statue's pale concrete & stone, floodlit from the castle at dusk and night (brightest at the feet)
function statueMaterial(baseY) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.74, metalness: 0 });
  const n = mx_noise_float(positionWorld.mul(1.6));
  mat.colorNode = vec3(0.8, 0.79, 0.75).mul(n.mul(0.05).add(0.97));
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const flood = smoothstep(float(baseY + STATUE_H + 1), float(baseY - 4), positionWorld.y).mul(0.35).add(0.65);
  mat.emissiveNode = vec3(1.0, 0.93, 0.8).mul(night.mul(flood).mul(0.62));
  return mat;
}

const darkMaterial = () => new THREE.MeshStandardNodeMaterial({ color: 0x14120f, roughness: 0.92, metalness: 0 });

// --- the Sagrado Corazón -------------------------------------------------------------------------------------------------

// Christ in a long robe and a mantle, built around the origin facing +z, 12.5 m tall. The photographs (Wikimedia
// Commons: "Monumento al Sagrado Corazón de Jesús, Monte Urgull", "2016 jesusen bihotza") show him blessing the city: the
// right arm raised with the hand beside the head, a wide sleeve hanging from it, the left hand laid on the heart; the
// mantle falls over both shoulders in deep folds to the feet.
function sacredHeartGeometries() {
  const out = [];
  // robe: a lathe, oval in section (wider than deep), barely flaring to the hem
  const profile = [
    [0, 0], [1.45, 0], [1.5, 0.2], [1.46, 0.6], [1.4, 1.8], [1.3, 3.4], [1.2, 5.0], [1.12, 6.3], [1.12, 7.0],
    [1.3, 8.0], [1.55, 9.0], [1.72, 9.65], [1.62, 10.05], [1.15, 10.4], [0.55, 10.62], [0, 10.66]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  out.push(new THREE.LatheGeometry(profile, 22).scale(1, 1, 0.64));
  // the mantle: open at the front, falling from the shoulders to the feet, a little wider than the robe
  const mantle = new THREE.CylinderGeometry(1.75, 1.85, 9.6, 18, 1, true, Math.PI * 0.42, Math.PI * 1.16);
  out.push(mantle.scale(1, 1, 0.72).translate(0, 5.0, -0.04));
  // its edges hanging in front either side, the deep folds of the photographs
  for (const side of [-1, 1]) {
    out.push(new THREE.BoxGeometry(0.5, 7.6, 0.55).rotateZ(side * 0.05).translate(side * 1.25, 5.5, 0.66));
  }
  // neck, head (and the hair falling to the shoulders, the beard)
  out.push(new THREE.CylinderGeometry(0.34, 0.42, 0.55, 12).translate(0, 10.85, 0.02));
  out.push(new THREE.SphereGeometry(1, 16, 12).scale(0.58, 0.78, 0.66).translate(0, 11.72, 0.06));
  out.push(new THREE.SphereGeometry(1, 14, 10).scale(0.66, 0.86, 0.6).translate(0, 11.5, -0.16));
  out.push(new THREE.SphereGeometry(1, 10, 8).scale(0.34, 0.4, 0.22).translate(0, 11.2, 0.42));
  // the heart on the chest, under the left hand
  out.push(new THREE.SphereGeometry(0.34, 10, 8).scale(1, 1, 0.45).translate(0.32, 9.0, 0.66));
  const limb = (r0, r1, a, b) => {
    const d = new THREE.Vector3().subVectors(b, a);
    return along(new THREE.CylinderGeometry(r1, r0, d.length(), 12).translate(0, d.length() / 2, 0), a.toArray(), d);
  };
  // the right arm (at -x: the figure faces +z): upper arm down and out, the forearm raised to the hand beside the head
  const rs = new THREE.Vector3(-1.5, 9.75, 0.05), re = new THREE.Vector3(-2.05, 8.75, 0.5);
  const rw = new THREE.Vector3(-1.85, 10.95, 0.6);
  out.push(limb(0.46, 0.42, rs, re));
  out.push(limb(0.36, 0.3, re, rw));
  // the sleeve gathered round the raised forearm, wide at the elbow, falling back to the wrist
  out.push(limb(0.72, 0.42, re.clone().add(new THREE.Vector3(0, -0.3, 0)), re.clone().lerp(rw, 0.72)));
  out.push(new THREE.SphereGeometry(1, 10, 8).scale(0.24, 0.36, 0.22).translate(rw.x + 0.02, rw.y + 0.35, rw.z));
  // the wide sleeve hanging from the raised forearm down past the elbow
  out.push(new THREE.CylinderGeometry(0.45, 0.75, 2.6, 12, 1, true).translate(-2.0, 8.55, 0.52));
  out.push(new THREE.BoxGeometry(0.25, 2.6, 1.2).rotateZ(-0.12).translate(-2.2, 7.4, 0.45));
  // the left arm: down to the elbow, the forearm across the chest, the hand on the heart
  const ls = new THREE.Vector3(1.5, 9.75, 0.05), le = new THREE.Vector3(1.75, 8.3, 0.5);
  const lw = new THREE.Vector3(0.62, 9.05, 0.85);
  out.push(limb(0.46, 0.42, ls, le));
  out.push(limb(0.4, 0.3, le, lw));
  out.push(new THREE.SphereGeometry(1, 10, 8).scale(0.42, 0.24, 0.16).translate(0.38, 9.2, 0.92));
  return out;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, kit } = ctx;
  const site = sites[0];
  const outline = site.buildings && site.buildings.length ? GEO.buildings[site.buildings[0]].g[0] : site.footprint;
  if (!outline || !PARTS) return null;
  const byId = new Map(PARTS.parts.map((p) => [p.osm, p]));
  if (!byId.has(MACHO) || !byId.has(PEDESTAL)) return null;

  const stone = kit.materials.sandstone;
  const tiles = kit.materials.terracotta;
  const dark = darkMaterial();
  const parts = new Parts();
  const ground = (ring) => kit.lowestGround(ctx, ring);

  // battered stone socle over the whole 1:500 outline, so nothing of the hidden extrusion's footprint is left open
  const outlineBase = ground(outline) - 0.6;
  const median = GEO.buildings[site.buildings?.[0]]?.ground ?? outlineBase + 2;
  parts.add(stone, kit.prism(outline, outlineBase, median + 2.2));

  for (const p of PARTS.parts) {
    if (p.osm === STATUE || p.osm === PEDESTAL || p.osm === MACHO || !p.height) continue;
    const g0 = ground(p.ring);
    const rise = ROOF_RISE[p.osm] || 0;
    const eave = g0 + p.height - rise;
    parts.add(stone, kit.prism(p.ring, g0 - 0.5, eave));
    if (rise) {
      // overhanging tiled hip roof
      const eaves = insetRing(wound(p.ring), -0.45) || p.ring;
      parts.add(tiles, hipRoof(eaves, eave, rise, kit.orientedBox(p.ring).width * 0.48));
      continue;
    }
    // flat roofs: a stone coping, then a parapet of merlons along the edges that face out over the hill
    const coping = insetRing(wound(p.ring), -0.25);
    if (coping) parts.add(stone, kit.prism(coping, eave - 0.45, eave + 0.05));
    const r = wound(p.ring);
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 1.2 || distToRing((ax + bx) / 2, (az + bz) / 2, outline) > 1.6) continue;
      const ux = (bx - ax) / len, uz = (bz - az) / len;
      const ix = -uz, iz = ux; // inward
      const yaw = -Math.atan2(uz, ux);
      // a low parapet wall with merlons standing on it, embrasures between (the battery's cannon ports)
      parts.add(stone, box(len, 0.55, 0.8, (ax + bx) / 2 + ix * 0.4, eave, (az + bz) / 2 + iz * 0.4, yaw));
      const count = Math.max(1, Math.floor(len / 3.1));
      const step = len / count;
      for (let k = 0; k < count; k++) {
        const t = (k + 0.5) * step;
        parts.add(stone, box(Math.min(2.2, step - 0.8), 1.25, 0.8, ax + ux * t + ix * 0.4, eave, az + uz * t + iz * 0.4, yaw));
        // gun loops lower down the battery's face
        if (p.osm === BATTERY && k % 2 === 0) {
          parts.add(dark, box(0.7, 0.9, 0.3, ax + ux * t - ix * 0.08, eave - 3.6, az + uz * t - iz * 0.08, yaw));
        }
      }
    }
    if (p.osm === CENTRE) {
      // the castle's windows onto the platform, small and deep in the thick walls
      const [cx, cz] = centroid(p.ring);
      for (let i = 0, n = r.length / 2; i < n; i++) {
        const q = (i + 1) % n;
        const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 6) continue;
        const ux = (bx - ax) / len, uz = (bz - az) / len;
        const ox = uz, oz = -ux; // outward
        if ((ax - cx) * ox + (az - cz) * oz < 0) continue;
        for (const t of [0.3, 0.7]) {
          parts.add(dark, box(1.0, 1.6, 0.3, ax + ux * len * t + ox * 0.05, eave - 3.4, az + uz * len * t + oz * 0.05, -Math.atan2(uz, ux)));
        }
      }
    }
  }

  // The monument on the Macho: the chapel, a battered block whose walls lean in as they rise (the photographs), with
  // an arched door and a carved panel over it on the side facing the city; a stepped pedestal; the statue
  const macho = byId.get(MACHO);
  const gm = ground(macho.ring);
  const machoTop = gm + CHAPEL_H;
  const ped = kit.orientedBox(byId.get(PEDESTAL).ring);
  const statueAt = PARTS.points[0]?.at || [ped.x, ped.z];
  // face the city: of the pedestal's four sides, the one looking most towards Alderdi Eder (the frame origin)
  let facing = 0, best = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = ped.angle + (k * Math.PI) / 2;
    const d = (-statueAt[0] * Math.cos(a) - statueAt[1] * Math.sin(a)) / Math.hypot(statueAt[0], statueAt[1]);
    if (d > best) { best = d; facing = a; }
  }
  const yaw = Math.atan2(Math.cos(facing), Math.sin(facing)); // rotation.y that turns local +z to the facing direction
  const fx = Math.cos(facing), fz = Math.sin(facing);
  const baseY = gm + PLINTH_H;
  const statue = statueMaterial(baseY);
  {
    const r = wound(simplify(macho.ring));
    const y0 = gm - 0.5, batter = 1.3; // the walls lean in 1.3 m over the block's height
    const top = insetRing(r, batter) || r;
    const t = new Tris();
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const a0 = [r[2 * i], y0, r[2 * i + 1]], a1 = [r[2 * q], y0, r[2 * q + 1]];
      const b0 = [top[2 * i], machoTop, top[2 * i + 1]], b1 = [top[2 * q], machoTop, top[2 * q + 1]];
      t.tri(a0, a1, b1);
      t.tri(a0, b1, b0);
    }
    t.cap(top, machoTop);
    parts.add(stone, t.geometry());
    const cornice = insetRing(top, -0.35);
    if (cornice) parts.add(stone, kit.prism(cornice, machoTop - 0.5, machoTop + 0.05));
    // the door at the terrace's level (the central block's roof) and the carved panel high over it, on the city side
    const terrace = gm + (byId.get(CENTRE)?.height ?? 11.5);
    let reach = 0;
    while (reach < 20 && pointInRing(ped.x + fx * reach, ped.z + fz * reach, r)) reach += 0.1;
    const lean = (y) => (batter * (y - y0)) / (machoTop - y0); // inset of the wall at height y
    const at = (y, out) => [ped.x + fx * (reach - lean(y) + out), ped.z + fz * (reach - lean(y) + out)];
    const [dx, dz] = at(terrace + 1.4, 0.05);
    parts.add(dark, box(1.9, 2.6, 0.3, dx, terrace, dz, yaw));
    parts.add(dark, new THREE.CylinderGeometry(0.95, 0.95, 0.3, 12, 1, false, -Math.PI / 2, Math.PI)
      .rotateX(-Math.PI / 2).rotateY(yaw).translate(dx, terrace + 2.6, dz));
    const [px, pz] = at(machoTop - 1.4, 0.08);
    parts.add(statue, box(1.6, 1.4, 0.25, px, machoTop - 2.2, pz, yaw));
  }
  const side = Math.max(ped.length, ped.width);
  // the stepped pedestal: a broad low step, a tall block, a narrower cap under the statue's feet
  parts.add(stone, box(side + 1.6, 0.5, side + 1.6, ped.x, machoTop, ped.z, yaw));
  parts.add(stone, box(side + 0.8, baseY - machoTop - 1.3, side + 0.8, ped.x, machoTop + 0.5, ped.z, yaw));
  parts.add(stone, box(side + 1.1, 0.25, side + 1.1, ped.x, baseY - 0.8, ped.z, yaw));
  parts.add(stone, box(side + 0.1, 0.55, side + 0.1, ped.x, baseY - 0.55, ped.z, yaw));

  const place = new THREE.Matrix4().compose(new THREE.Vector3(ped.x, baseY, ped.z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0)), new THREE.Vector3(1, 1, 1));
  for (const g of sacredHeartGeometries()) parts.add(statue, g, place);

  const group = parts.build('mota-gaztelua');
  group.userData.statue = { x: ped.x, z: ped.z, y: baseY, height: STATUE_H, yaw };
  return group;
}
