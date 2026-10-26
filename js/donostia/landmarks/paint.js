import * as THREE from 'three/webgpu';
import { attribute, float, floor, step, smoothstep, select, mix, vec3 } from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/paint.js
// One vertex-painted material for the small painted things of the waterfront landmarks (alderdi-eder.js,
// klub-nautikoa.js): every vertex carries aPaint = linear rgb + a finish code w, so a whole carousel, a playground or a
// club house is one draw and one pipeline:
//   w in [0, 1)   paint, roughness w;
//   w in [1, 2)   metal (brass, gilt, steel), roughness w - 1;
//   w in [2, 3)   a lamp: by day an opal or clear bulb, at dusk & night it glows (bloom) with cityUniforms.uInteriorGlow,
//                 w - 2 its strength;
//   w in [3, 4)   lit glass: glossy and dark by day, a warm interior glow of strength w - 3 at night;
//   w in [4, 5)   lit paint: a painted surface under lamps (a carousel's canopy), glowing warm at strength w - 4 at night.
// PaintBuilder collects three.js geometries (or raw quads) with their paint and bakes them into one mesh.

export const FINISH = { paint: 0, metal: 1, lamp: 2, litGlass: 3, litPaint: 4 };

let material = null;
export function paintMaterial() {
  if (material) return material;
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = attribute('aPaint', 'vec4');
  const kind = floor(p.w);
  const fin = p.w.sub(kind);
  const is = (k) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const metal = is(1), lamp = is(2), glass = is(3), lit = is(4);
  mat.colorNode = p.xyz;
  mat.roughnessNode = select(lamp.add(glass).greaterThan(0.5), mix(float(0.35), float(0.1), glass), fin.max(0.04).mul(lit.oneMinus()).add(lit.mul(0.6)));
  mat.metalnessNode = metal.mul(0.85).add(glass.mul(0.3));
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const warm = vec3(1.0, 0.76, 0.48);
  mat.emissiveNode = p.xyz.mul(lamp).mul(night.mul(3.2).add(0.04)).mul(fin.add(0.5))
    .add(warm.mul(glass.add(lit)).mul(fin).mul(night).mul(1.6));
  mat.name = 'LandmarkPaint';
  material = mat;
  return mat;
}

const _n = new THREE.Vector3(), _a = new THREE.Vector3(), _b = new THREE.Vector3();

export class PaintBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.paint = [];
  }

  get count() { return this.pos.length / 3; }

  // a three.js geometry (indexed or not) with one paint, moved by matrix
  add(geo, paint, matrix = null) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    for (let i = 0; i < p.length; i++) {
      this.pos.push(p[i]);
      this.nrm.push(n[i]);
    }
    for (let i = 0; i < p.length / 3; i++) this.paint.push(paint[0], paint[1], paint[2], paint[3]);
    return this;
  }

  // a flat triangle a, b, c ([x, y, z]); turned to face `towards` when given
  tri(a, b, c, paint, towards = null) {
    _a.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    _b.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    _n.crossVectors(_a, _b);
    if (_n.lengthSq() < 1e-14) return;
    _n.normalize();
    if (towards && _n.x * towards[0] + _n.y * towards[1] + _n.z * towards[2] < 0) {
      [b, c] = [c, b];
      _n.negate();
    }
    for (const q of [a, b, c]) {
      this.pos.push(q[0], q[1], q[2]);
      this.nrm.push(_n.x, _n.y, _n.z);
      this.paint.push(paint[0], paint[1], paint[2], paint[3]);
    }
  }

  // a flat quad a, b, c, d (in order round it)
  quad(a, b, c, d, paint, towards = null) {
    this.tri(a, b, c, paint, towards);
    this.tri(a, c, d, paint, towards);
  }

  build(name, { shadows = true } = {}) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, paintMaterial());
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

// Small geometry makers in a local frame (y up), for PaintBuilder.add with a matrix
export const M4 = () => new THREE.Matrix4();
export const at = (x, y, z, ry = 0) => M4().makeRotationY(ry).setPosition(x, y, z);
export function box(w, h, d, x = 0, y = 0, z = 0) {
  return new THREE.BoxGeometry(w, h, d).translate(x, y + h / 2, z);
}
export function cyl(rTop, rBottom, h, seg = 12, y = 0, open = false) {
  return new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, open).translate(0, y + h / 2, 0);
}
// Solid of revolution: profile [[r, y], ...] bottom to top
export function lathe(profile, seg = 16) {
  return new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(r, 0.0005), y)), seg);
}
