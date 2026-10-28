import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, color, attribute, uv, abs, fract, min, max, mix, length, fwidth, smoothstep, mrt,
  pow, clamp, atan, cos
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { STREETSCAPE } from './data-streetscape.js';
import { BEACH_ACCESS } from './data-beach-access.js';

// js/donostia/streetscape.js
// Street furniture, from tools/donostia/bake-streetscape.mjs (js/donostia/data-streetscape.js):
// - La Concha's barandilla (Juan Rafael Alday, 1910-16) along the top of the promenade wall above Kontxa & Ondarreta:
//   white cast iron in 0.8 m modules (a big ring with a smaller one inside and sprays of leaves, between pairs of
//   balusters) on a stone plinth, five modules between grey stone pillars. Plinth, tube handrail & pillars are
//   geometry; the ironwork is drawn on one alpha-to-coverage strip, anti-aliased by its screen footprint
// - its white lamp posts, each on a pedestal in place of every fourth pillar; the two monumental candelabra by the
//   steps in front of the Hotel de Londres; the rotunda's obelisks, clock & barometer, with their arms of globes
// - OSM's street lamps (a dark cast-iron post under a four-sided lantern) and benches (wooden slats on iron frames)
// - lanterns on iron brackets along the lanes of the Parte Vieja, where OSM maps no street lamps
// - the handrails of the beaches' stairs & ramps (js/donostia/data-beach-access.js) on the kerbs of their open sides: a
//   tube on posts with a middle rail, painted white at La Concha & Ondarreta, stainless at Zurriola
// Lamps glow at dusk & night with cityUniforms.uInteriorGlow (emissive + bloom), each over a soft pool of light on the
// ground; no real lights. Everything is instanced or merged: 9 draws.
// buildStreetscape(GEO, terrain) -> Promise<Object3D | null>; its userData.update(dt, elapsed, camera) culls the small
// props by distance.

// The barandilla, measured on photographs against its 0.8 m module (m)
const MODULE = 0.8; // one ring and a pair of balusters
const PLINTH_H = 0.22; // the stone plinth's top above the promenade
const RAIL_H = 1.0; // the ironwork, plinth to the top of the handrail
const HANDRAIL_R = 0.028;
const POST_W = [0.46, 0.62, 0]; // along the railing: a stone pillar, a lamp pedestal, a monument's face (as baked)
const LAMP_PEDESTAL_H = 1.4; // its cap, above the promenade
const LAMP_GLOBE = [3.78, 0.24]; // the lamp post's globe: centre above its pedestal, radius

// Paints (linear rgb + roughness), per vertex of the merged furniture
const WHITE_IRON = [0.82, 0.82, 0.79, 0.42];
const DARK_IRON = [0.025, 0.03, 0.028, 0.5];
const WOOD = [0.24, 0.13, 0.065, 0.75];
const STONE = [0.43, 0.42, 0.39, 0.85]; // the grey plinth, pillars and the candelabra's pedestals
const PAINTED_STONE = [0.74, 0.74, 0.71, 0.7]; // the lamp pedestals, whitewashed
const LIMESTONE = [0.6, 0.58, 0.53, 0.8]; // the obelisks
const DIAL = [0.86, 0.86, 0.84, 0.35];
const STAINLESS = [0.5, 0.52, 0.53, 0.3];
const RAIL = { white: WHITE_IRON, steel: STAINLESS };
const HANDRAIL = { r: 0.024, mid: 0.45, midR: 0.014, post: 0.045, drop: 0.85, every: 1.4 }; // m

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

  // a triangle with a normal per corner (counter-clockwise seen from its front)
  tri(a, b, c, na, nb, nc, paint) {
    for (const [p, n] of [[a, na], [b, nb], [c, nc]]) {
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

// A turned profile [[r, y], ...] round the y axis; facetted: flat-shaded, for masonry & square shafts
const lathe = (profile, segments, phi = 0) => new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments, phi);
const facetted = (geo) => {
  const g = geo.index ? geo.toNonIndexed() : geo;
  g.computeVertexNormals();
  return g;
};
// A square shaft of half-widths [[h, y], ...]: a four-sided lathe turned to face the axes
const squareShaft = (rows) => facetted(lathe(rows.map(([h, y]) => [h * Math.SQRT2, y]), 4, Math.PI / 4));

// A bar of square section w from p to q
function beam(b, p, q, w, paint, m) {
  const d = new THREE.Vector3().subVectors(q, p), len = d.length();
  const at = M4().compose(new THREE.Vector3().addVectors(p, q).multiplyScalar(0.5),
    new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()), new THREE.Vector3(1, 1, 1));
  b.add(new THREE.BoxGeometry(w, len, w), paint, m.clone().multiply(at));
}

// The promenade's lamp post on its pedestal, after photographs: a bell base, a slender shaft, a collared capital
// holding the globe (y up from the pedestal's cap; the globe apart)
const LAMP_COLUMN = [[0, 0], [0.2, 0], [0.2, 0.06], [0.17, 0.1], [0.16, 0.3], [0.12, 0.42], [0.13, 0.5], [0.1, 0.56],
  [0.085, 0.75], [0.075, 0.85], [0.08, 0.9], [0.062, 0.95], [0.055, 3.0], [0.075, 3.05], [0.075, 3.1], [0.052, 3.15],
  [0.048, 3.3], [0.09, 3.42], [0.12, 3.48], [0.06, 3.52], [0.04, 3.55], [0, 3.55]];

// The monumental candelabra (1911) by the ramp in front of the Hotel de Londres, after photographs (~8.5 m): a square
// grey stone pedestal set in the railing's line, a cast-iron base with four scrolled griffins, a column with collars,
// a ring of eight globes on scrolled arms and a ninth on top. m: the local frame (y up from the promenade, +z to the
// sea); globes collect [x, y, z, r].
const CANDELABRUM_HALF = 0.8; // the stone pedestal's half-width
function candelabrum(b, m, globes) {
  const add = (g, paint, local = null) => b.add(g, paint, local ? m.clone().multiply(local) : m);
  const globe = (x, y, z, r) => { const p = new THREE.Vector3(x, y, z).applyMatrix4(m); globes.push([p.x, p.y, p.z, r]); };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const H = CANDELABRUM_HALF;
  add(squareShaft([[0, -0.4], [H + 0.08, -0.4], [H + 0.08, 0.18], [H, 0.24], [H, 1.12], [H + 0.08, 1.2], [H + 0.08, 1.35], [0, 1.35]]), STONE);
  add(lathe([[0, 1.35], [0.62, 1.35], [0.62, 1.45], [0.5, 1.58], [0.44, 2.05], [0.32, 2.45], [0.26, 2.62], [0.3, 2.7], [0.3, 2.8],
    [0.18, 2.88], [0.15, 3.3], [0.19, 3.36], [0.13, 3.42], [0.12, 4.15], [0.17, 4.22], [0.17, 4.3], [0.12, 4.36], [0.11, 4.9],
    [0.17, 4.98], [0.24, 5.12], [0.24, 5.22], [0.11, 5.3], [0.09, 6.4], [0.12, 6.46], [0.08, 6.52], [0.075, 7.5], [0.13, 7.62],
    [0.13, 7.7], [0.06, 7.76], [0, 7.76]], 10), WHITE_IRON);
  // the base's four scrolled griffins, on the diagonals
  for (let k = 0; k < 4; k++) {
    const a = ((k + 0.5) * Math.PI) / 2, sx = Math.sin(a), sz = Math.cos(a);
    add(new THREE.TorusGeometry(0.17, 0.06, 5, 10), WHITE_IRON, M4().makeTranslation(sx * 0.5, 1.95, sz * 0.5).multiply(M4().makeRotationY(a + Math.PI / 2)));
    beam(b, V(sx * 0.34, 2.4, sz * 0.34), V(sx * 0.62, 1.62, sz * 0.62), 0.1, WHITE_IRON, m);
  }
  // eight arms out of the capital, alternately long & high and short & low, each a scroll with a cup and a globe
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + Math.PI / 8, long = k % 2 === 0, r = long ? 0.95 : 0.7, h = long ? 5.75 : 5.5;
    const sx = Math.sin(a), sz = Math.cos(a);
    beam(b, V(sx * 0.18, 5.15, sz * 0.18), V(sx * r, 5.15, sz * r), 0.06, WHITE_IRON, m);
    beam(b, V(sx * r, 5.12, sz * r), V(sx * r, h - 0.2, sz * r), 0.05, WHITE_IRON, m);
    add(new THREE.TorusGeometry(0.12, 0.035, 4, 8), WHITE_IRON, M4().makeTranslation(sx * r * 0.62, 5.0, sz * r * 0.62).multiply(M4().makeRotationY(a + Math.PI / 2)));
    add(new THREE.CylinderGeometry(0.09, 0.045, 0.1, 8), WHITE_IRON, M4().makeTranslation(sx * r, h - 0.18, sz * r));
    globe(sx * r, h + 0.04, sz * r, 0.22);
  }
  globe(0, 8.02, 0, 0.27);
}

// The rotunda's obelisks (1911), the clock and the barometer, after photographs (~17 m): a pedestal with corner
// blocks set in the railing's line, a moulded step, a band carrying two iron arms of four globes, a tapering shaft, a
// capital stage under a projecting slab, the head with a dial under a hood on each face, a finial and a weathervane.
// m: the local frame as the candelabra's; +x along the railing.
const OBELISK_HALF = 1.45;
function obelisk(b, m, globes, barometer) {
  const add = (g, paint, local = null) => b.add(g, paint, local ? m.clone().multiply(local) : m);
  const globe = (x, y, z, r) => { const p = new THREE.Vector3(x, y, z).applyMatrix4(m); globes.push([p.x, p.y, p.z, r]); };
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const H = OBELISK_HALF;
  add(squareShaft([[0, -0.6], [H, -0.6], [H, 1.75], [H + 0.08, 1.85], [H + 0.08, 2.0], [1.3, 2.05], [1.22, 2.35], [1.22, 2.9],
    [1.08, 3.2], [1.0, 3.3], [1.0, 5.3], [1.12, 5.4], [1.12, 5.85], [0.96, 5.95], [0.76, 12.1], [0.9, 12.2], [0.9, 13.75],
    [1.3, 13.85], [1.3, 14.55], [1.08, 14.62], [1.08, 17.0], [1.24, 17.3], [1.24, 17.4], [0.5, 17.45], [0.5, 17.8],
    [0.32, 17.85], [0, 18.0]]), LIMESTONE);
  // the dials, and the hands (the barometer's single needle)
  for (let f = 0; f < 4; f++) {
    const face = M4().makeRotationY((f * Math.PI) / 2).multiply(M4().makeTranslation(0, 15.95, 1.085));
    add(new THREE.CircleGeometry(0.58, 20), DIAL, face);
    // its hood: a moulded arch over the dial, flaring to the head's corners
    add(new THREE.TorusGeometry(0.72, 0.1, 4, 12, Math.PI), LIMESTONE, face.clone().multiply(M4().makeTranslation(0, 0, 0.04)));
    const hands = barometer ? [[0.035, 0.52, 0.2]] : [[0.06, 0.36, 2.1], [0.04, 0.52, -0.5]];
    for (const [w, l, a] of hands) {
      add(new THREE.BoxGeometry(w, l, 0.02), DARK_IRON, face.clone().multiply(M4().makeRotationZ(a)).multiply(M4().makeTranslation(0, l / 2 - 0.06, 0.012)));
    }
  }
  // the weathervane
  beam(b, V(0, 17.9, 0), V(0, 19.4, 0), 0.04, DARK_IRON, m);
  add(new THREE.BoxGeometry(0.7, 0.025, 0.025), DARK_IRON, M4().makeTranslation(0, 18.65, 0));
  add(new THREE.BoxGeometry(0.025, 0.025, 0.7), DARK_IRON, M4().makeTranslation(0, 18.65, 0));
  add(new THREE.BoxGeometry(1.3, 0.06, 0.015), DARK_IRON, M4().makeTranslation(0, 19.1, 0).multiply(M4().makeRotationY(0.6)));
  // the two arms along the railing: a scrolled bracket out of the band, a crosspiece with four globes on cups
  for (const side of [-1, 1]) {
    const x1 = side * 2.3;
    beam(b, V(side * 1.1, 5.55, 0), V(x1, 6.0, 0), 0.08, WHITE_IRON, m);
    add(new THREE.TorusGeometry(0.2, 0.05, 5, 10), WHITE_IRON, M4().makeTranslation(side * 1.45, 5.45, 0));
    for (const [dx, dz, h] of [[0.42, 0, 6.65], [-0.42, 0, 6.65], [0, 0.42, 7.0], [0, -0.42, 7.0]]) {
      beam(b, V(x1, 6.0, 0), V(x1 + dx, 6.0, dz), 0.05, WHITE_IRON, m);
      beam(b, V(x1 + dx, 5.95, dz), V(x1 + dx, h - 0.2, dz), 0.045, WHITE_IRON, m);
      add(new THREE.CylinderGeometry(0.08, 0.04, 0.1, 8), WHITE_IRON, M4().makeTranslation(x1 + dx, h - 0.18, dz));
      globe(x1 + dx, h, dz, 0.22);
    }
  }
}

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

// The plinth's section across the railing [off (m, + to the sea), dy (m, above the promenade)], from deep in the paving
// on the land side, over the chamfered top, out round the little cornice and down behind the wall's face. On a shore wall
// the railing's line keeps 19-25 cm behind the masonry (tools/donostia/bake-streetscape.mjs): the skirt down from the
// cornice stays 15 cm out, behind the face (where it reached past it, it showed as a flat grey board in the masonry)
const PLINTH = [[-0.24, -0.5], [-0.24, 0.17], [-0.19, PLINTH_H], [0.21, PLINTH_H], [0.21, 0.12], [0.27, 0.08], [0.27, -0.02],
  [0.15, -0.06], [0.15, -1.6]];
const MONUMENT_INSET = [0.5, 1.2, 1.2]; // the candelabra's & obelisks' axes stand this far inland of the railing's line

// La Concha's barandilla and everything on its line, from the baked runs ([x, y, z] cm, y the promenade; travelling
// along one, the sea lies towards (-dz, dx)), their posts ([s cm, type: 0 a pillar, 1 a lamp pedestal, 2 a monument's
// face, where the ironwork stops against it]) and the monuments ([kind, x, y, z cm, heading deg]):
// { solid (merged, painted), ironwork (the strip), globes [[x, y, z, r]], pools [[x, z, r]] }
function barandillaGeometries(runs, postLists, monuments, handrails = []) {
  const solid = new Builder(), globes = [], pools = [];
  const strip = { pos: [], nrm: [], uv: [], idx: [] };
  const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
  const UP = V(0, 1, 0);
  const quadToward = (a, b, c, d, toward, paint) => {
    const n = V().subVectors(d, a).cross(V().subVectors(b, a));
    if (n.dot(toward) < 0) solid.quad(a, d, c, b, paint);
    else solid.quad(a, b, c, d, paint);
  };
  runs.forEach((flat, ri) => {
    const pts = [];
    for (let k = 0; k < flat.length; k += 3) pts.push(V(flat[k] / 100, flat[k + 1] / 100, flat[k + 2] / 100));
    const n = pts.length;
    if (n < 2) return;
    const cum = [0];
    for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
    // seaward normal per segment, and per vertex the mean of its segments'
    const seg = (k) => {
      const dx = pts[k + 1].x - pts[k].x, dz = pts[k + 1].z - pts[k].z, l = Math.hypot(dx, dz) || 1;
      return V(-dz / l, 0, dx / l);
    };
    const sea = pts.map((_, k) => seg(Math.max(0, k - 1)).add(seg(Math.min(n - 2, k))).normalize());
    // the point and seaward normal at arc length s
    const at = (s) => {
      let k = 1;
      while (k < n - 1 && cum[k] < s) k++;
      const f = Math.max(0, Math.min(1, (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1e-9)));
      return { p: pts[k - 1].clone().lerp(pts[k], f), s: sea[k - 1].clone().lerp(sea[k], f).normalize() };
    };
    const off = (p, s, o, dy) => V(p.x + s.x * o, p.y + dy, p.z + s.z * o);

    // the plinth, its section swept along the run
    for (let k = 0; k < n - 1; k++) {
      const s01 = V().addVectors(sea[k], sea[k + 1]).normalize();
      for (let i = 0; i < PLINTH.length - 1; i++) {
        const [o0, y0] = PLINTH[i], [o1, y1] = PLINTH[i + 1];
        const toward = s01.clone().multiplyScalar(-(y1 - y0)).addScaledVector(UP, o1 - o0);
        quadToward(off(pts[k], sea[k], o0, y0), off(pts[k + 1], sea[k + 1], o0, y0), off(pts[k + 1], sea[k + 1], o1, y1),
          off(pts[k], sea[k], o1, y1), toward, STONE);
      }
    }
    // the handrail: a round tube on the balusters, smooth-shaded
    const HY = PLINTH_H + RAIL_H - HANDRAIL_R, SIDES = 6;
    const ring = (q, a) => {
      const nrm = sea[q].clone().multiplyScalar(Math.cos(a)).addScaledVector(UP, Math.sin(a));
      return [off(pts[q], sea[q], Math.cos(a) * HANDRAIL_R, HY + Math.sin(a) * HANDRAIL_R), nrm];
    };
    for (let k = 0; k < n - 1; k++) {
      for (let j = 0; j < SIDES; j++) {
        const a0 = (j / SIDES) * Math.PI * 2, a1 = ((j + 1) / SIDES) * Math.PI * 2;
        const [p00, n00] = ring(k, a0), [p01, n01] = ring(k, a1), [p10, n10] = ring(k + 1, a0), [p11, n11] = ring(k + 1, a1);
        // wound so the faces look out of the tube
        if (V().subVectors(p10, p00).cross(V().subVectors(p01, p00)).dot(n00) > 0) {
          solid.tri(p00, p10, p01, n00, n10, n01, WHITE_IRON);
          solid.tri(p01, p10, p11, n01, n10, n11, WHITE_IRON);
        } else {
          solid.tri(p00, p01, p10, n00, n01, n10, WHITE_IRON);
          solid.tri(p01, p11, p10, n01, n11, n10, WHITE_IRON);
        }
      }
    }
    // the posts: stone pillars, and the lamp pedestals with their lamp posts
    const posts = postLists[ri] || [];
    for (let k = 0; k < posts.length; k += 2) {
      if (posts[k + 1] === 2) continue;
      const { p, s } = at(posts[k] / 100), lamp = posts[k + 1] === 1;
      const m = M4().makeTranslation(p.x, p.y, p.z).multiply(M4().makeRotationY(Math.atan2(s.x, s.z)));
      const block = (w, y0, y1, paint) => {
        const [g, mm] = box(w, y1 - y0, w, 0, y0, 0);
        solid.add(g, paint, m.clone().multiply(mm));
      };
      if (!lamp) {
        block(0.54, -0.06, 0.3, STONE);
        block(0.44, 0.28, 1.22, STONE);
        block(0.54, 1.22, 1.29, STONE);
        solid.add(facetted(new THREE.ConeGeometry(0.54 * Math.SQRT1_2, 0.07, 4, 1).rotateY(Math.PI / 4).translate(0, 1.325, 0)), STONE, m);
      } else {
        block(0.7, -0.06, 0.32, PAINTED_STONE);
        block(0.6, 0.3, 1.3, PAINTED_STONE);
        block(0.74, 1.3, 1.36, PAINTED_STONE);
        block(0.66, 1.36, LAMP_PEDESTAL_H, PAINTED_STONE);
        solid.add(lathe(LAMP_COLUMN, 8).translate(0, LAMP_PEDESTAL_H, 0), WHITE_IRON, m);
        globes.push([p.x, p.y + LAMP_PEDESTAL_H + LAMP_GLOBE[0], p.z, LAMP_GLOBE[1]]);
        pools.push([p.x - s.x * 2.8, p.z - s.z * 2.8, 4.2]);
      }
    }
    // the ironwork strip, section by section between the posts: u counts metres of whole 0.8 m modules (stretched to
    // fill the section), v metres above the plinth
    for (let k = 0; k + 2 < posts.length; k += 2) {
      const sA = posts[k] / 100 + POST_W[posts[k + 1]] / 2, sB = posts[k + 2] / 100 - POST_W[posts[k + 3]] / 2;
      if (sB - sA < 0.3) continue;
      const stretch = (sB - sA) / (Math.max(1, Math.round((sB - sA) / MODULE)) * MODULE);
      const ss = [sA, ...cum.filter((c) => c > sA + 0.02 && c < sB - 0.02), sB];
      const base = strip.pos.length / 3;
      for (const sv of ss) {
        const { p, s } = at(sv);
        for (const v of [0, RAIL_H]) {
          strip.pos.push(p.x, p.y + PLINTH_H + v, p.z);
          strip.nrm.push(s.x, 0, s.z);
          strip.uv.push((sv - sA) / stretch, v);
        }
      }
      for (let q = 0; q < ss.length - 1; q++) {
        const i = base + 2 * q;
        strip.idx.push(i, i + 2, i + 3, i, i + 3, i + 1);
      }
    }
  });
  // the monuments, a little inland of the line
  for (let k = 0; k < monuments.length; k += 5) {
    const kind = monuments[k], yaw = (monuments[k + 4] * Math.PI) / 180, sx = Math.sin(yaw), sz = Math.cos(yaw);
    const x = monuments[k + 1] / 100 - sx * MONUMENT_INSET[kind], y = monuments[k + 2] / 100;
    const z = monuments[k + 3] / 100 - sz * MONUMENT_INSET[kind];
    const m = M4().makeTranslation(x, y, z).multiply(M4().makeRotationY(yaw));
    if (kind === 0) {
      candelabrum(solid, m, globes);
      pools.push([x - sx * 1.5, z - sz * 1.5, 8]);
      continue;
    }
    obelisk(solid, m, globes, kind === 2);
    pools.push([x - sx * 2.5, z - sz * 2.5, 7]);
  }
  // the handrails of the beaches' stairs & ramps: posts down to the kerb, a tube on top, a thinner rail between
  for (const { t, p: flat } of handrails) {
    const paint = RAIL[t] || WHITE_IRON;
    const pts = [];
    for (let k = 0; k < flat.length; k += 3) pts.push(V(flat[k], flat[k + 1], flat[k + 2]));
    if (pts.length < 2) continue;
    const tube = (dy, r) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const a = pts[k].clone(), b = pts[k + 1].clone();
        a.y += dy; b.y += dy;
        const d = V().subVectors(b, a), len = d.length();
        if (len < 1e-3) continue;
        const m = M4().compose(V().addVectors(a, b).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, d.normalize()), V(1, 1, 1));
        solid.add(new THREE.CylinderGeometry(r, r, len + 2 * r, 6, 1, true), paint, m);
      }
    };
    tube(0, HANDRAIL.r);
    tube(-HANDRAIL.mid, HANDRAIL.midR);
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1], len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.ceil(len / HANDRAIL.every));
      for (let q = k === 0 ? 0 : 1; q <= n; q++) {
        const p = a.clone().lerp(b, q / n);
        const [g, mm] = box(HANDRAIL.post, HANDRAIL.drop, HANDRAIL.post, 0, -HANDRAIL.drop, 0);
        solid.add(g, paint, M4().makeTranslation(p.x, p.y, p.z).multiply(mm));
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(strip.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(strip.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(strip.uv, 2));
  g.setIndex(strip.idx);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return { solid: solid.build(), ironwork: g, globes, pools };
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

// Signed distances (m, negative inside) for the ironwork's pattern, on TSL nodes
const sdBox = (x, y, hx, hy) => max(abs(x).sub(hx), abs(y).sub(hy));
const sdRing = (x, y, r, t) => abs(length(vec2(x, y)).sub(r)).sub(t);
// a leaf: an ellipse of half-axes a (along `angle`, radians from +x) and b about (cx, cy) (near its edge, as a distance)
const sdLeaf = (x, y, cx, cy, a, b, angle) => {
  const c = Math.cos(angle), s = Math.sin(angle), dx = x.sub(cx), dy = y.sub(cy);
  return length(vec2(dx.mul(c).add(dy.mul(s)).div(a), dy.mul(c).sub(dx.mul(s)).div(b))).sub(1).mul(b);
};

// The barandilla's cast iron between the posts, after photographs, on the strip (u: metres along a section, whole 0.8
// m modules; v: metres above the plinth). Per module, mirrored about its middle: a pair of square balusters (one at
// each end, 0.1 m in) on feet, under capitals, with chamfered bosses where the upper & lower rails cross them and a
// collar halfway; a big ring between the pairs, tied to them, with a smaller ring inside; a stem from the inner ring
// up through the upper rail to a five-petalled flower between two laurel sprays; leaves and a knot inside the ring's
// top, a bud on the inner ring's foot, a leaf boss where the ring meets the lower rail; the handrail's band on top.
// Coverage is anti-aliased by the strip's screen footprint and thinned like a sub-pixel line where the bars are finer
// than a pixel, so far away the lace keeps its mean density instead of sparkling or thickening (alpha to coverage).
// Bars shade a little darker towards their edges, so close up they read as rounded casting.
function ironworkDistance() {
  return Fn(() => {
    const p = uv(), y = p.y;
    const lx = fract(p.x.div(MODULE)).mul(MODULE);
    const ax = abs(lx.sub(MODULE / 2)); // from the ring's axis, mirrored
    const bal = abs(ax.sub(MODULE / 2 - 0.103)); // from the nearer baluster's axis
    let d = abs(y.sub(RAIL_H - HANDRAIL_R)).sub(HANDRAIL_R); // the handrail
    d = min(d, min(abs(y.sub(0.752)).sub(0.016), abs(y.sub(0.158)).sub(0.016))); // the rails
    d = min(d, max(bal.sub(0.016), y.sub(0.95))); // balusters
    d = min(d, min(sdBox(bal, y.sub(0.025), 0.03, 0.025), sdBox(bal, y.sub(0.915), 0.026, 0.03))); // feet, capitals
    const boss = (cy) => {
      const q = abs(y.sub(cy));
      return max(max(bal, q).sub(0.036), bal.add(q).mul(Math.SQRT1_2).sub(0.041));
    };
    d = min(d, min(min(boss(0.752), boss(0.158)), sdBox(bal, y.sub(0.449), 0.027, 0.019)));
    // the rings, tied to the balusters at mid-height, and the stem
    d = min(d, min(sdRing(ax, y.sub(0.449), 0.249, 0.019), sdRing(ax, y.sub(0.44), 0.15, 0.014)));
    d = min(d, min(sdBox(ax.sub(0.279), y.sub(0.449), 0.016, 0.02), sdBox(ax, y.sub(0.73), 0.008, 0.14)));
    // the flower over the upper rail and its two sprays: a drooping twig, leaves alternately above and below
    const fx = lx.sub(MODULE / 2), fy = y.sub(0.865);
    d = min(d, length(vec2(fx, fy)).sub(cos(atan(fy, fx).mul(5)).mul(0.009).add(0.03)));
    const twig = (t) => 0.855 - 0.9 * (t - 0.03) * (t - 0.03);
    d = min(d, max(abs(y.sub(float(0.855).sub(ax.sub(0.03).mul(ax.sub(0.03)).mul(0.9)))).sub(0.005), abs(ax.sub(0.155)).sub(0.12)));
    for (const [t, up] of [[0.075, 1], [0.13, -1], [0.185, 1], [0.24, -1], [0.272, 1]]) {
      d = min(d, sdLeaf(ax, y, t + 0.008, twig(t) + up * 0.021, 0.03, 0.011, up * 0.55));
    }
    // inside the ring's top: leaves either side of a knot on the stem; on the inner ring's foot a bud between leaves
    for (const [cx, cy, a] of [[0.05, 0.64, -0.35], [0.1, 0.625, -0.6], [0.145, 0.6, -0.9]]) d = min(d, sdLeaf(ax, y, cx, cy, 0.035, 0.012, a));
    d = min(d, min(length(vec2(ax, y.sub(0.665))).sub(0.02), length(vec2(ax.mul(0.8), y.sub(0.262))).sub(0.03)));
    d = min(d, min(sdLeaf(ax, y, 0.045, 0.245, 0.04, 0.014, -0.25), sdLeaf(ax, y, 0, 0.178, 0.05, 0.024, 0)));
    return d;
  })();
}

function createIronworkMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0.0, roughness: 0.45 });
  const d = ironworkDistance();
  const p = uv();
  const w = max(fwidth(p.x), fwidth(p.y)).mul(0.7).add(0.0004);
  // a bar ~3.6 cm wide blurred over 2w covers about 3.6 / (1.8 + w) of what the smoothstep gives it
  const coverage = float(1.0).sub(smoothstep(w.negate(), w, d)).mul(min(float(1.0), float(0.036).div(w.add(0.018))));
  const relief = mix(mix(0.78, 1.0, smoothstep(0.0, 0.012, d.negate())), 0.94, smoothstep(0.004, 0.015, w));
  mat.colorNode = vec4(vec3(...WHITE_IRON.slice(0, 3)).mul(relief), coverage);
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
// lamps still glow from afar at night; La Concha's barandilla, its lamp posts & monuments are always drawn.
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

  // La Concha's barandilla with its lamp posts, candelabra & obelisks (one merged mesh), its ironwork strip and all
  // their globes
  const promenade = [];
  if (data.railings.length) {
    const { solid, ironwork, globes, pools: lit } = barandillaGeometries(data.railings, data.railingPosts || [], data.monuments || [],
      BEACH_ACCESS.rails || []);
    const solidMesh = new THREE.Mesh(solid, paint);
    solidMesh.name = 'Barandilla';
    const ironMesh = new THREE.Mesh(ironwork, createIronworkMaterial());
    ironMesh.name = 'Barandilla_ironwork';
    for (const mesh of [solidMesh, ironMesh]) {
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    for (const [x, y, z, r] of globes) place(promenade, x, y, z, 0, r);
    for (const [x, z, r] of lit) pool(x, z, r);
  }
  const promenadeGlobes = instanced(new THREE.SphereGeometry(1, 12, 8), glass, promenade, 'Kontxa_lamp_globes', false);

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

  for (const mesh of [promenadeGlobes, streetPosts, streetGlass, wallFrames, wallGlass, benchMesh, poolMesh]) if (mesh) group.add(mesh);
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
