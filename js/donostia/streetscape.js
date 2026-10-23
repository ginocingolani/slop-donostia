import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, color, attribute, uv, abs, fract, min, max, mix, length, fwidth, smoothstep, select, mrt,
  pow, clamp
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { STREETSCAPE } from './data-streetscape.js';

// js/donostia/streetscape.js
// Street furniture, from tools/donostia/bake-streetscape.mjs (js/donostia/data-streetscape.js):
// - La Concha's white cast-iron railing (the barandilla of 1910) on its sandstone coping along the top of the
//   promenade wall above Kontxa & Ondarreta: posts, handrail & coping as geometry, the ironwork between them (bars,
//   rails and rings) drawn on one alpha-to-coverage strip, anti-aliased by its screen-space footprint
// - the promenade's white lamp posts with their opal globes, every ~17 m behind the railing
// - OSM's street lamps (a dark cast-iron post under a four-sided lantern) and benches (wooden slats on iron frames)
// - lanterns on iron brackets along the lanes of the Parte Vieja, where OSM maps no street lamps
// Lamps glow at dusk & night with cityUniforms.uInteriorGlow (emissive + bloom), each over a soft pool of light on the
// ground; no real lights. Everything is instanced or merged: 10 draws.
// buildStreetscape(GEO, terrain) -> Promise<Object3D | null>; its userData.update(dt, elapsed, camera) culls the small
// props by distance.

const RAIL_H = 1.0; // ironwork height above the coping (m)
const COPING_H = 0.1; // coping top above the promenade
const POST_EVERY = 2.4; // m between railing posts (16 ironwork modules)
const MODULE = 0.15; // m, one bar & ring module of the ironwork

// Paints (linear rgb + roughness), per vertex of the merged furniture
const WHITE_IRON = [0.82, 0.82, 0.79, 0.42];
const DARK_IRON = [0.025, 0.03, 0.028, 0.5];
const SANDSTONE = [0.5, 0.43, 0.33, 0.88];
const WOOD = [0.24, 0.13, 0.065, 0.75];

// --- geometry helpers ---------------------------------------------------------------------------------------------------

// Non-indexed triangles with position, normal and a vec4 paint (rgb + roughness)
class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.paint = [];
  }

  // a three.js geometry (indexed or not), transformed by matrix
  add(geo, paint, matrix = null) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (matrix) g.applyMatrix4(matrix);
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) {
      this.pos.push(p[i]);
      this.nrm.push(n[i]);
    }
    for (let i = 0; i < p.length / 3; i++) this.paint.push(...paint);
  }

  // a, b, c, d round a quad that faces towards (d - a) x (b - a), i.e. they run clockwise seen from its front
  quad(a, b, c, d, paint) {
    const n = new THREE.Vector3().subVectors(d, a).cross(new THREE.Vector3().subVectors(b, a)).normalize();
    for (const p of [a, c, b, a, d, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.paint.push(...paint);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

const M4 = () => new THREE.Matrix4();
const box = (w, h, d, x = 0, y = 0, z = 0) => [new THREE.BoxGeometry(w, h, d), M4().makeTranslation(x, y + h / 2, z)];

// Promenade lamp post: a turned white cast-iron column on an octagonal plinth (y up from the ground, globe apart)
function promenadePostGeometry() {
  const b = new Builder();
  const profile = [[0, 0], [0.19, 0], [0.19, 0.09], [0.15, 0.13], [0.15, 0.42], [0.11, 0.5], [0.085, 0.58], [0.075, 0.7],
    [0.066, 2.75], [0.085, 2.85], [0.06, 2.92], [0.12, 3.05], [0.12, 3.12], [0.07, 3.18], [0.05, 3.3], [0, 3.3]];
  b.add(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 10), WHITE_IRON);
  return b.build();
}
const PROMENADE_GLOBE_Y = 3.52;

// A four-sided lantern's iron (floor, roof, finial, corner bars) with its floor at y0, scaled by k
function addLanternFrame(b, y0, k = 1, x = 0, z = 0) {
  const at = (dy) => M4().makeTranslation(x, y0 + dy * k, z).multiply(M4().makeScale(k, k, k));
  b.add(new THREE.CylinderGeometry(0.13, 0.1, 0.06, 4, 1).rotateY(Math.PI / 4), DARK_IRON, at(0));
  b.add(new THREE.ConeGeometry(0.27, 0.2, 4, 1).rotateY(Math.PI / 4), DARK_IRON, at(0.47));
  b.add(new THREE.SphereGeometry(0.035, 6, 4), DARK_IRON, at(0.6));
  for (let c = 0; c < 4; c++) {
    const a = (c / 4) * Math.PI * 2 + Math.PI / 4;
    const [g, m] = box(0.02, 0.36, 0.02);
    b.add(g, DARK_IRON, M4().makeTranslation(x + Math.cos(a) * 0.15 * k, y0 + 0.02 * k, z + Math.sin(a) * 0.15 * k).multiply(M4().makeScale(k, k, k)).multiply(m));
  }
}
const lanternGlass = (y0, k = 1, x = 0, z = 0) => new THREE.CylinderGeometry(0.19 * k, 0.12 * k, 0.36 * k, 4, 1).rotateY(Math.PI / 4).translate(x, y0 + 0.21 * k, z);

// Street lamp: a dark cast-iron post with a four-sided lantern (the glass apart)
function streetPostGeometry() {
  const b = new Builder();
  const profile = [[0, 0], [0.13, 0], [0.13, 0.1], [0.1, 0.16], [0.1, 0.5], [0.07, 0.6], [0.055, 0.75], [0.048, 3.2],
    [0.07, 3.28], [0.07, 3.34], [0.11, 3.38], [0, 3.38]];
  b.add(new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), 8), DARK_IRON);
  addLanternFrame(b, 3.41);
  return b.build();
}
const streetGlassGeometry = () => lanternGlass(3.41);

// Wall lantern of the Parte Vieja: a scrolled iron bracket out of the facade (+z) with a lantern hanging from it
// (y = height above the street)
const WALL_LANTERN_Y = 4.1, WALL_LANTERN_OUT = 0.62;
function wallLanternGeometry() {
  const b = new Builder();
  const arm = box(0.035, 0.035, WALL_LANTERN_OUT + 0.05, 0, 0, 0);
  b.add(arm[0], DARK_IRON, M4().makeTranslation(0, WALL_LANTERN_Y + 0.62, (WALL_LANTERN_OUT + 0.05) / 2).multiply(arm[1]));
  // the brace under the arm, from the wall up to its middle
  const brace = box(0.025, 0.55, 0.025, 0, 0, 0);
  b.add(brace[0], DARK_IRON, M4().makeTranslation(0, WALL_LANTERN_Y + 0.2, 0.02).multiply(M4().makeRotationX(0.62)).multiply(brace[1]));
  b.add(new THREE.BoxGeometry(0.12, 0.2, 0.03), DARK_IRON, M4().makeTranslation(0, WALL_LANTERN_Y + 0.55, 0.015));
  // the hanger from the arm's end down to the lantern's finial
  const hanger = box(0.02, 0.15, 0.02, 0, 0, 0);
  b.add(hanger[0], DARK_IRON, M4().makeTranslation(0, WALL_LANTERN_Y + 0.47, WALL_LANTERN_OUT).multiply(hanger[1]));
  addLanternFrame(b, WALL_LANTERN_Y, 0.8, 0, WALL_LANTERN_OUT);
  return b.build();
}
const wallGlassGeometry = () => lanternGlass(WALL_LANTERN_Y, 0.8, 0, WALL_LANTERN_OUT);

// Bench: three slats to sit on, two to lean on, on cast-iron frames; facing +z (the way a seated person looks)
function benchGeometry() {
  const b = new Builder();
  const L = 1.8;
  for (const x of [-0.78, 0.78]) {
    for (const [g, m] of [box(0.05, 0.42, 0.06, x, 0, 0.18), box(0.05, 0.42, 0.06, x, 0, -0.2), box(0.05, 0.05, 0.46, x, 0.38, -0.01)]) b.add(g, DARK_IRON, m);
    // the back support, leaning back
    const [g, m] = box(0.05, 0.5, 0.05, 0, 0, 0);
    b.add(g, DARK_IRON, M4().makeTranslation(x, 0.42, -0.21).multiply(M4().makeRotationX(-0.26)).multiply(m));
  }
  for (const z of [-0.14, 0.0, 0.14]) {
    const [g, m] = box(L, 0.035, 0.11, 0, 0.43, z);
    b.add(g, WOOD, m);
  }
  for (const y of [0.18, 0.36]) {
    const [g, m] = box(L, 0.1, 0.03, 0, 0, 0);
    b.add(g, WOOD, M4().makeTranslation(0, 0.42, -0.21).multiply(M4().makeRotationX(-0.26)).multiply(M4().makeTranslation(0, y, -0.02)).multiply(m));
  }
  return b.build();
}

// The railing's solid parts (coping, posts, handrail) and its ironwork strip, along every baked run. A run's points are
// [x, y, z] (y = the promenade); travelling along it, the sea lies towards (-dz, dx).
function railingGeometries(runs) {
  const solid = new Builder();
  const strip = { pos: [], nrm: [], uv: [] };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  for (const flat of runs) {
    const pts = [];
    for (let k = 0; k < flat.length; k += 3) pts.push(V(flat[k] / 100, flat[k + 1] / 100, flat[k + 2] / 100));
    const n = pts.length;
    if (n < 2) continue;
    // seaward normal per vertex: the mean of its segments'
    const seg = (k) => {
      const dx = pts[k + 1].x - pts[k].x, dz = pts[k + 1].z - pts[k].z, l = Math.hypot(dx, dz) || 1;
      return V(-dz / l, 0, dx / l);
    };
    const sea = pts.map((_, k) => {
      const a = seg(Math.max(0, k - 1)), b = seg(Math.min(n - 2, k));
      return a.add(b).normalize();
    });
    // Coping: top, sea face down the wall, land face into the paving
    for (let k = 0; k < n - 1; k++) {
      const p0 = pts[k], p1 = pts[k + 1], s0 = sea[k], s1 = sea[k + 1];
      const top = (p, s, off) => V(p.x + s.x * off, p.y + COPING_H, p.z + s.z * off);
      const low = (p, s, off, dy) => V(p.x + s.x * off, p.y + dy, p.z + s.z * off);
      solid.quad(top(p0, s0, -0.2), top(p1, s1, -0.2), top(p1, s1, 0.3), top(p0, s0, 0.3), SANDSTONE);
      solid.quad(top(p0, s0, 0.3), top(p1, s1, 0.3), low(p1, s1, 0.3, -1.6), low(p0, s0, 0.3, -1.6), SANDSTONE);
      solid.quad(low(p0, s0, -0.2, -0.3), low(p1, s1, -0.2, -0.3), top(p1, s1, -0.2), top(p0, s0, -0.2), SANDSTONE);
    }
    // Handrail: a flat bar on top of the ironwork
    const hy0 = COPING_H + RAIL_H - 0.02, hy1 = hy0 + 0.06;
    for (let k = 0; k < n - 1; k++) {
      const p0 = pts[k], p1 = pts[k + 1], s0 = sea[k], s1 = sea[k + 1];
      const at = (p, s, off, dy) => V(p.x + s.x * off, p.y + dy, p.z + s.z * off);
      solid.quad(at(p0, s0, -0.04, hy1), at(p1, s1, -0.04, hy1), at(p1, s1, 0.04, hy1), at(p0, s0, 0.04, hy1), WHITE_IRON);
      solid.quad(at(p0, s0, 0.04, hy1), at(p1, s1, 0.04, hy1), at(p1, s1, 0.04, hy0), at(p0, s0, 0.04, hy0), WHITE_IRON);
      solid.quad(at(p0, s0, -0.04, hy0), at(p1, s1, -0.04, hy0), at(p1, s1, -0.04, hy1), at(p0, s0, -0.04, hy1), WHITE_IRON);
    }
    // Ironwork strip & posts by arc length
    let u = 0, nextPost = 0;
    for (let k = 0; k < n; k++) {
      const p = pts[k], s = sea[k];
      if (k > 0) {
        const len = Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
        // posts along this segment
        while (nextPost <= u + len) {
          const f = (nextPost - u) / len;
          const x = pts[k - 1].x + (p.x - pts[k - 1].x) * f, y = pts[k - 1].y + (p.y - pts[k - 1].y) * f, z = pts[k - 1].z + (p.z - pts[k - 1].z) * f;
          const yaw = Math.atan2(s.x, s.z);
          for (const [g, m] of [box(0.07, RAIL_H + 0.08, 0.07, 0, COPING_H, 0), box(0.11, 0.05, 0.11, 0, COPING_H + RAIL_H + 0.06, 0)]) {
            solid.add(g, WHITE_IRON, M4().makeTranslation(x, y, z).multiply(M4().makeRotationY(yaw)).multiply(m));
          }
          nextPost += POST_EVERY;
        }
        u += len;
        // a strip quad from the previous point
        const q = pts[k - 1];
        const base = strip.pos.length / 3;
        const nrm = V(sea[k - 1].x + s.x, 0, sea[k - 1].z + s.z).normalize();
        for (const [pp, uu] of [[q, u - len], [p, u]]) {
          for (const v of [0, RAIL_H]) {
            strip.pos.push(pp.x, pp.y + COPING_H + v, pp.z);
            strip.nrm.push(nrm.x, nrm.y, nrm.z);
            strip.uv.push(uu, v);
          }
        }
        strip.idx ??= [];
        strip.idx.push(base, base + 2, base + 3, base, base + 3, base + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(strip.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(strip.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(strip.uv, 2));
  g.setIndex(strip.idx || []);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return { solid: solid.build(), ironwork: g };
}

// --- materials ----------------------------------------------------------------------------------------------------------

const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);

// Painted iron, stone & wood of the merged furniture (aPaint: linear rgb + roughness)
function createPaintMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0 });
  const paint = attribute('aPaint', 'vec4');
  mat.colorNode = paint.xyz;
  mat.roughnessNode = paint.w;
  return mat;
}

// The barandilla's ironwork between the posts: per 15 cm module a bar and three stacked rings on a stem, between a top
// and a bottom rail; coverage anti-aliased by the strip's screen footprint, so far away it fades to a fine lace
function createIronworkMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0.0, roughness: 0.42 });
  const coverage = Fn(() => {
    const p = uv();
    const lx = fract(p.x.div(MODULE)).sub(0.5).mul(MODULE);
    const bar = float(MODULE / 2).sub(abs(lx)).sub(0.007);
    const rails = min(abs(p.y.sub(RAIL_H - 0.05)).sub(0.03), abs(p.y.sub(0.08)).sub(0.025));
    // a big ring held between the bars, a small one above and below, threaded on a stem from rail to rail
    const ringR = (cy) => length(vec2(lx, p.y.sub(cy)));
    const ring = (cy, r, t) => abs(ringR(cy).sub(r)).sub(t);
    const rings = min(ring(0.5, 0.066, 0.008), min(ring(0.78, 0.034, 0.007), ring(0.22, 0.034, 0.007)));
    const hollow = ringR(0.5).lessThan(0.058).or(ringR(0.78).lessThan(0.027)).or(ringR(0.22).lessThan(0.027));
    const stem = select(hollow, float(1.0), abs(lx).sub(0.005));
    const d = min(min(bar, rails), min(rings, stem));
    const w = max(fwidth(p.x), fwidth(p.y)).mul(0.75).add(0.0005);
    const inside = p.y.greaterThan(0.05).and(p.y.lessThan(RAIL_H - 0.015));
    return select(inside, float(1.0).sub(smoothstep(w.negate(), w, d)), float(0.0));
  })();
  mat.colorNode = vec4(vec3(...WHITE_IRON.slice(0, 3)), coverage);
  mat.maskShadowNode = coverage.greaterThan(0.4);
  return mat;
}

// Lamp glass: milky by day, a warm glow (bloom) at dusk & night
function createGlassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.0 });
  mat.colorNode = color(0xece8dc);
  mat.emissiveNode = color(0xffd6a0).mul(night().mul(3.0).add(0.03));
  return mat;
}

// A warm pool of lamplight on the ground: additive, depth-tested, off by day. Keeps the G-buffer underneath (zero
// normal & metalRough, as _transparentEffectMRT in js/tsl-materials.js) so SSR still sees the paving.
function createPoolMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.fog = false; // fog would add its colour to the far pools
  mat.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    const falloff = pow(clamp(float(1.0).sub(r), 0.0, 1.0), 2.2);
    return color(0xffc890).mul(falloff.mul(night()).mul(0.3));
  })();
  mat.opacityNode = float(1.0);
  mat.mrtNode = mrt({ normal: vec4(0.0), metalRough: vec4(0.0) });
  return mat;
}

// --- build ---------------------------------------------------------------------------------------------------------------

function instanced(geo, mat, matrices, name, shadows = true) {
  const n = matrices.length / 16;
  if (!n) return null;
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  mesh.instanceMatrix.array.set(matrices);
  // a storage buffer: small instanced meshes otherwise keep their matrices in a uniform buffer re-uploaded every draw
  mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(mesh.instanceMatrix.array, 16);
  mesh.computeBoundingSphere();
  mesh.name = name;
  mesh.castShadow = shadows;
  mesh.receiveShadow = shadows;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// The instances of a prop within maxDist of the camera, packed at the front of its instance buffer; refilled (and its
// bounding sphere refitted, so the frustum can cull it) only when one crosses the distance. Starts with all of them,
// so every pipeline compiles behind the loading screen.
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
// Cull distances (m): about where each prop shrinks to a few pixels. The lamp glass is never culled, so the city's
// lamps still glow from afar at night; La Concha's 128 lamp posts are always drawn.
const CULL = { streetPosts: 900, wallLanterns: 450, benches: 350, pools: 2000 };
const RECULL = 8; // m the camera moves before the props are culled again

export async function buildStreetscape(GEO, terrain) {
  const data = STREETSCAPE;
  const group = new THREE.Group();
  group.name = 'DonostiaStreetscape';
  const paint = createPaintMaterial();
  const glass = createGlassMaterial();
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3();
  const place = (out, x, y, z, yaw, scale = 1) => {
    q.setFromAxisAngle(up, yaw);
    m.compose(p.set(x, y, z), q, s.set(scale, scale, scale));
    out.push(...m.elements);
  };
  const pools = [];
  // a pool of light of radius r round (x, z), laid on the ground's slope
  const pool = (x, z, r) => {
    const h = terrain.heightAt(x, z);
    n.set(terrain.heightAt(x - 1, z) - terrain.heightAt(x + 1, z), 2, terrain.heightAt(x, z - 1) - terrain.heightAt(x, z + 1)).normalize();
    q.setFromUnitVectors(up, n);
    m.compose(p.set(x, h + 0.06, z), q, s.set(2 * r, 1, 2 * r));
    pools.push(...m.elements);
  };

  // La Concha's railing & lamp posts
  if (data.railings.length) {
    const { solid, ironwork } = railingGeometries(data.railings);
    const solidMesh = new THREE.Mesh(solid, paint);
    solidMesh.name = 'Barandilla_coping_posts';
    const ironMesh = new THREE.Mesh(ironwork, createIronworkMaterial());
    ironMesh.name = 'Barandilla_ironwork';
    for (const mesh of [solidMesh, ironMesh]) {
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  const promenade = [];
  const L = data.promenadeLamps;
  for (let k = 0; k < L.length; k += 3) {
    const x = L[k] / 100, y = L[k + 1] / 100, z = L[k + 2] / 100;
    place(promenade, x, y, z, 0);
    pool(x, z, 4.5);
  }
  const promenadePosts = instanced(promenadePostGeometry(), paint, promenade, 'Kontxa_lamp_posts');
  const globe = new THREE.SphereGeometry(0.22, 14, 10).translate(0, PROMENADE_GLOBE_Y, 0);
  const promenadeGlobes = instanced(globe, glass, promenade, 'Kontxa_lamp_globes', false);

  // Street lamps & benches
  const lamps = [];
  for (let k = 0; k < data.lamps.length; k += 3) {
    const x = data.lamps[k] / 100, z = data.lamps[k + 1] / 100;
    place(lamps, x, terrain.heightAt(x, z) - 0.05, z, (data.lamps[k + 2] * Math.PI) / 180);
    pool(x, z, 5.5);
  }
  const streetPosts = instanced(streetPostGeometry(), paint, lamps, 'Street_lamp_posts');
  const streetGlass = instanced(streetGlassGeometry(), glass, lamps, 'Street_lamp_glass', false);
  const wall = [];
  const W = data.wallLamps || [];
  for (let k = 0; k < W.length; k += 3) {
    const x = W[k] / 100, z = W[k + 1] / 100, yaw = (W[k + 2] * Math.PI) / 180;
    const ox = Math.sin(yaw), oz = Math.cos(yaw);
    place(wall, x, terrain.heightAt(x + ox * 1.5, z + oz * 1.5), z, yaw);
    pool(x + ox * 1.8, z + oz * 1.8, 4);
  }
  const wallFrames = instanced(wallLanternGeometry(), paint, wall, 'Wall_lanterns', false);
  const wallGlass = instanced(wallGlassGeometry(), glass, wall, 'Wall_lantern_glass', false);
  const benches = [];
  for (let k = 0; k < data.benches.length; k += 3) {
    const x = data.benches[k] / 100, z = data.benches[k + 1] / 100;
    place(benches, x, terrain.heightAt(x, z) - 0.02, z, (data.benches[k + 2] * Math.PI) / 180);
  }
  const benchMesh = instanced(benchGeometry(), paint, benches, 'Benches');
  const poolMesh = instanced(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), createPoolMaterial(), pools, 'Lamp_light_pools', false);
  if (poolMesh) poolMesh.renderOrder = 1;

  for (const mesh of [promenadePosts, promenadeGlobes, streetPosts, streetGlass, wallFrames, wallGlass, benchMesh, poolMesh]) if (mesh) group.add(mesh);
  if (!group.children.length) return null;

  const culled = [[streetPosts, CULL.streetPosts], [wallFrames, CULL.wallLanterns], [benchMesh, CULL.benches], [poolMesh, CULL.pools]]
    .filter(([mesh]) => mesh).map(([mesh, d]) => new DistanceCulled(mesh, d));
  const last = new THREE.Vector3(Infinity, Infinity, Infinity);
  group.userData.update = (dt, elapsed, camera) => {
    if (camera.position.distanceToSquared(last) < RECULL * RECULL) return;
    last.copy(camera.position);
    for (const c of culled) c.update(camera.position);
  };
  return group;
}
