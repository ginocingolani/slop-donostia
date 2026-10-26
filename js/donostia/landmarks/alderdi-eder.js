import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, uv, abs, fract, floor, min, max, mix, length, fwidth, smoothstep, select, sin, dot,
  positionWorld, normalWorld, mx_noise_float
} from 'three/tsl';
import { ALDERDI } from '../data-alderdi.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Parts, ringArea, reverseRing, insetRing, beam, clipRing, pointInRing as pointIn } from './geom.js';
import { PaintBuilder, paintMaterial, at, box, cyl, lathe, M4 } from './paint.js';

// js/donostia/landmarks/alderdi-eder.js
// Alderdi Eder ("beautiful place"), the gardens laid out in the 1880s between the old casino (the City Hall since the
// 1940s, udaletxea.js) and La Concha, from tools/donostia/bake-alderdi.mjs (js/donostia/data-alderdi.js): the municipal
// 1:500 map's parterres in a grid on the City Hall's axis round a round bed (the palm's), each a lawn ringed by a low
// cast-iron fence, a strip of red gravel and a raised bed of seasonal flowers at its heart; clipped hedges, some of
// golden euonymus; the garden by Hernani street with gravel walks and a hoop fence; white benches backing onto the
// lawns; white garden lamps with opal globes; the white cast-iron planters (cherubs under a bowl of petunias) round the
// round bed. Before the City Hall its front terrace, paved and edged with low sandstone walls, and the Belle Époque
// carousel ("Zaldiko Maldikoa"): a two-storey merry-go-round under a painted crown, turning slowly, its bulbs lit at
// dusk; its ticket booth; the playground beside it. On the harbour side, La Terraza del Náutico's timber deck and the
// ikurriña's flagpole.
//
// From the photographs (Wikimedia Commons: the gardens by Josi, Daniel Díez Sanquirce, Javier Pérez Montes and others;
// the planters; the carousel by day and by night): the fences are dark green, ~0.5 m, rails and posts with scroll
// rings between them (black hoops in the garden by Hernani street); the beds are dense petunias, marigolds, salvias,
// pansies and begonias; the carousel's crown alternates eight painted landscapes in gilt rococo frames with the city's
// arms on blue shields, over a cream canopy with a blue valance and a burgundy fringe, on twisted brass poles; white
// and black horses with red saddles; a cream lower drum with green oval panels; an upper gallery with a gilt
// balustrade between blue caryatids. No pixels of the photographs are used: every colour is a hand-picked constant.
//
// A site-less landmark (index.js passes no GEO.landmarks sites): build([], ctx) returns the Object3D; the plain
// extrusion of the carousel's ticket booth is hidden through userData.hide.

// --- materials -------------------------------------------------------------------------------------------------------

// The planting, one material for the hedges (uv.x = 1) and the flower beds (uv.x = 0), so both share a pipeline (a
// mix by the flag: a select() between the two graphs came out black for the flowers).
//
// Clipped hedge: dark glossy leaves in clumps, lighter on the sunlit top; some runs (by place, ~20 m patches) are the
// golden variegated euonymus of the photographs, yellow-green speckled gold
function hedgeColour() {
  const p = positionWorld;
  const clump = mx_noise_float(p.mul(3.1)).mul(0.5).add(0.5);
  const leaf = mx_noise_float(p.mul(17.0)).mul(0.5).add(0.5);
  const tone = mx_noise_float(p.mul(0.35)).mul(0.5).add(0.5);
  const golden = smoothstep(0.15, 0.35, mx_noise_float(p.xz.mul(0.05).add(vec2(3.1, 7.7))));
  const dark = mix(vec3(0.025, 0.06, 0.018), vec3(0.06, 0.11, 0.03), tone);
  const gold = mix(vec3(0.09, 0.14, 0.025), vec3(0.32, 0.3, 0.03), smoothstep(0.55, 0.8, leaf));
  const base = mix(dark, gold, golden);
  const top = smoothstep(0.3, 0.9, normalWorld.y);
  return base.mul(mix(float(0.62), float(1.25), clump.mul(0.6).add(leaf.mul(0.4)))).mul(top.mul(0.35).add(1.0));
}

// Seasonal bedding: a carpet of leaves crowded with flowers, ~7 cm cells, each bed area (7 m patches) with its own pair
// of colours; the dots settle to their mean once smaller than a pixel
function flowerColour() {
  const xz = positionWorld.xz;
  const cell = 0.07;
  const g = xz.div(cell);
  const id = floor(g);
  const hash = (v, s) => fract(sin(dot(v, vec2(12.9898 + s, 78.233 - s))).mul(43758.5453));
  const f = fract(g).sub(0.5);
  const jitter = vec2(hash(id, 1.3), hash(id, 7.1)).sub(0.5).mul(0.5);
  const r = length(f.sub(jitter));
  const isFlower = hash(id, 3.7).lessThan(0.82);
  // patches in the garden's grid (the City Hall's axis), so a bed's colours come in blocks square to its edges
  const ax = vec2(-0.885, 0.465);
  const patch = floor(vec2(dot(xz, ax), dot(xz, vec2(-0.465, -0.885))).div(6.0));
  const pick = hash(patch, 11.0);
  // petunia magenta, marigold orange, salvia red, begonia pink, pansy purple, yellow, white
  const P = [[0.62, 0.02, 0.25], [0.85, 0.28, 0.01], [0.6, 0.02, 0.02], [0.75, 0.18, 0.3], [0.22, 0.06, 0.45],
    [0.85, 0.62, 0.03], [0.8, 0.8, 0.75]].map((c) => vec3(...c));
  const choose = (t) => {
    let c = P[0];
    for (let k = 1; k < P.length; k++) c = select(t.greaterThan(k / P.length), P[k], c);
    return c;
  };
  const colA = choose(pick), colB = choose(fract(pick.mul(7.31).add(0.37)));
  const bloom = mix(colA, colB, step2(hash(id, 5.3), 0.68));
  const leafC = mix(vec3(0.03, 0.09, 0.02), vec3(0.06, 0.15, 0.03), hash(id, 9.1));
  const dotMask = select(isFlower, float(1).sub(smoothstep(0.33, 0.45, r)), float(0));
  const near = float(1).sub(smoothstep(0.02, 0.08, max(fwidth(xz.x), fwidth(xz.y))));
  const mean = mix(leafC, mix(colA, colB, 0.32), 0.66);
  const detail = mix(leafC, bloom, dotMask);
  return mix(mean, detail, near).mul(smoothstep(-0.2, 0.8, normalWorld.y).mul(0.4).add(0.6));
}

function plantMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  mat.colorNode = mix(flowerColour(), hedgeColour(), smoothstep(0.4, 0.6, uv().x));
  mat.name = 'AlderdiPlants';
  return mat;
}
function step2(v, edge) { return select(v.greaterThan(edge), float(1), float(0)); }

// The low cast-iron garden fences, drawn on an alpha-to-coverage strip: uv.x metres along, uv.y metres up. Round the
// parterres (uv.y < 5) green panels ~0.5 m high: posts every 0.75 m, a top & bottom rail, a pair of scroll rings in each
// bay; in the garden by Hernani street (uv.y - 10) black overlapping half hoops ~0.3 m high
const FENCE_H = 0.5, HOOP_H = 0.3, HOOP = 10;
function fenceMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0.0, roughness: 0.45 });
  const coverage = Fn(() => {
    const p = uv();
    const hoopy = p.y.greaterThan(5.0);
    const y = select(hoopy, p.y.sub(HOOP), p.y);
    // parterre fence
    const pe = 0.75, lx = fract(p.x.div(pe)).sub(0.5).mul(pe);
    const post = abs(abs(lx).sub(pe / 2)).sub(0.016);
    const rails = min(abs(y.sub(FENCE_H - 0.03)).sub(0.014), abs(y.sub(0.08)).sub(0.011));
    const m = pe / 2, mx = fract(p.x.div(m)).sub(0.5).mul(m);
    const ring = abs(length(vec2(mx, y.sub(0.28).mul(0.9))).sub(0.12)).sub(0.008);
    const panel = min(min(post, rails), ring);
    const inPanel = y.greaterThan(0.0).and(y.lessThan(FENCE_H));
    // hoops: arcs of radius 0.2 m every 0.24 m, overlapping
    const hp = 0.24, hx = fract(p.x.div(hp)).sub(0.5).mul(hp);
    const hx2 = fract(p.x.div(hp).add(0.5)).sub(0.5).mul(hp);
    const arc = (xx) => abs(length(vec2(xx, y.sub(HOOP_H - 0.2))).sub(0.18)).sub(0.008).max(y.sub(HOOP_H - 0.2).negate().mul(10).max(-1));
    const hoopD = min(arc(hx), arc(hx2));
    const inHoop = y.greaterThan(0.0).and(y.lessThan(HOOP_H));
    const d = select(hoopy, select(inHoop, hoopD, float(1)), select(inPanel, panel, float(1)));
    const w = max(fwidth(p.x), fwidth(y)).mul(0.75).add(0.0006);
    return float(1.0).sub(smoothstep(w.negate(), w, d));
  })();
  mat.colorNode = vec4(select(uv().y.greaterThan(5.0), vec3(0.012, 0.014, 0.013), vec3(0.025, 0.085, 0.05)), coverage);
  mat.maskShadowNode = coverage.greaterThan(0.4);
  mat.name = 'AlderdiFence';
  return mat;
}

// The City Hall terrace's stone paving: pale grey-beige slabs 60 x 40 cm in running bond on the facade's axis, each a
// shade of its own, the joints fading out once finer than a pixel
function pavingMaterial(axis) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.86, metalness: 0 });
  const xz = positionWorld.xz;
  const u = dot(xz, vec2(axis[0], axis[1])), v = dot(xz, vec2(-axis[1], axis[0]));
  const row = floor(v.div(0.4));
  const uu = u.div(0.6).add(fract(row.mul(0.5)));
  const id = vec2(floor(uu), row);
  const shade = fract(sin(dot(id, vec2(12.9898, 78.233))).mul(43758.5453));
  const base = mix(vec3(0.42, 0.4, 0.36), vec3(0.52, 0.5, 0.46), shade).mul(mx_noise_float(positionWorld.mul(1.7)).mul(0.06).add(1));
  const pix = max(fwidth(u), fwidth(v));
  const ju = abs(fract(uu).sub(0.5)).mul(0.6), jv = abs(fract(v.div(0.4)).sub(0.5)).mul(0.4);
  const joint = float(1).sub(smoothstep(0.288, 0.296, max(ju, jv))).oneMinus().mul(float(1).sub(smoothstep(0.01, 0.04, pix)));
  mat.colorNode = mix(base, base.mul(0.62), joint);
  mat.name = 'AlderdiPaving';
  return mat;
}

// --- shared geometry -------------------------------------------------------------------------------------------------

const toV2 = (r) => {
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
  return pts;
};

// A ring with extra vertices so no edge is longer than `step` (walls and caps then follow the ground)
function densify(r, step = 2.5) {
  const out = [];
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n, x0 = r[2 * i], z0 = r[2 * i + 1], x1 = r[2 * j], z1 = r[2 * j + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(x1 - x0, z1 - z0) / step));
    for (let s = 0; s < k; s++) out.push(x0 + ((x1 - x0) * s) / k, z0 + ((z1 - z0) * s) / k);
  }
  return out;
}

// Horizontal cap of a polygon [outer, ...holes] draped on the ground at yAt(x, z), facing up: earcut, then each
// triangle split in four until its edges are under `step`, so a broad bed or floor follows the ground inside too
function capGeometry(rings, yAt, step = 2.5) {
  rings = rings.map((r) => densify(r, step));
  const contour = toV2(rings[0]), holes = rings.slice(1).map(toV2);
  const pts = [...contour, ...holes.flat()];
  const pos = [];
  const emit = (A, B, C, depth) => {
    const ab = Math.hypot(B[0] - A[0], B[1] - A[1]), bc = Math.hypot(C[0] - B[0], C[1] - B[1]), ca = Math.hypot(A[0] - C[0], A[1] - C[1]);
    if (depth < 6 && Math.max(ab, bc, ca) > step) {
      const m = (P, Q) => [(P[0] + Q[0]) / 2, (P[1] + Q[1]) / 2];
      const AB = m(A, B), BC = m(B, C), CA = m(C, A);
      emit(A, AB, CA, depth + 1); emit(AB, B, BC, depth + 1); emit(CA, BC, C, depth + 1); emit(AB, BC, CA, depth + 1);
      return;
    }
    for (const q of [A, B, C]) pos.push(q[0], yAt(q[0], q[1]), q[1]);
  };
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    let A = [pts[a].x, pts[a].y], B = [pts[b].x, pts[b].y], C = [pts[c].x, pts[c].y];
    if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) > 0) [B, C] = [C, B]; // up-facing in (x, -z)
    emit(A, B, C, 0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// Walls round every ring of a polygon from bottom(x, z) to top(x, z), facing out of the solid
function wallGeometry(rings, bottom, top) {
  const pos = [], nrm = [];
  rings.map((r) => densify(r)).forEach((r, k) => {
    // the outline wound positive (edge normal (dz, -dx) outward), holes negative
    const ring = (ringArea(r) > 0) === (k === 0) ? r : reverseRing(r);
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ring[2 * i], z0 = ring[2 * i + 1], x1 = ring[2 * j], z1 = ring[2 * j + 1];
      const l = Math.hypot(x1 - x0, z1 - z0);
      if (l < 1e-4) continue;
      const nx = (z1 - z0) / l, nz = -(x1 - x0) / l;
      const a = [x0, bottom(x0, z0), z0], b = [x1, bottom(x1, z1), z1], c = [x1, top(x1, z1), z1], d = [x0, top(x0, z0), z0];
      for (const q of [a, c, b, a, d, c]) { pos.push(...q); nrm.push(nx, 0, nz); }
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

// A raised planting: walls from below the ground to h - chamfer, a chamfer to the top inset by `inset`, a draped top.
// rings: [outer, ...holes]; when the inset folds, a straight-sided block
function raised(parts, mat, rings, ground, h, inset) {
  const shoulder = Math.max(h - inset, h * 0.5);
  parts.add(mat, wallGeometry(rings, (x, z) => ground(x, z) - 0.08, (x, z) => ground(x, z) + shoulder));
  const outer0 = (ringArea(rings[0]) > 0 ? rings[0] : reverseRing(rings[0]));
  const ins0 = rings.length === 1 && inset > 0 ? insetRing(outer0, inset) : null;
  // the chamfer's two rings densified alike (same splits per edge), so their vertices stay paired
  const pair = (a, b) => {
    const A = [], B = [];
    for (let i = 0, n = a.length / 2; i < n; i++) {
      const j = (i + 1) % n, k = Math.max(1, Math.ceil(Math.hypot(a[2 * j] - a[2 * i], a[2 * j + 1] - a[2 * i + 1]) / 2.5));
      for (let s = 0; s < k; s++) {
        A.push(a[2 * i] + ((a[2 * j] - a[2 * i]) * s) / k, a[2 * i + 1] + ((a[2 * j + 1] - a[2 * i + 1]) * s) / k);
        B.push(b[2 * i] + ((b[2 * j] - b[2 * i]) * s) / k, b[2 * i + 1] + ((b[2 * j + 1] - b[2 * i + 1]) * s) / k);
      }
    }
    return [A, B];
  };
  const [outer, ins] = ins0 ? pair(outer0, ins0) : [outer0, null];
  if (ins) {
    // chamfer between the shoulder and the inset top
    const n = outer.length / 2, pos = [];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const o0 = [outer[2 * i], 0, outer[2 * i + 1]], o1 = [outer[2 * j], 0, outer[2 * j + 1]];
      const i0 = [ins[2 * i], 0, ins[2 * i + 1]], i1 = [ins[2 * j], 0, ins[2 * j + 1]];
      o0[1] = ground(o0[0], o0[2]) + shoulder; o1[1] = ground(o1[0], o1[2]) + shoulder;
      i0[1] = ground(i0[0], i0[2]) + h; i1[1] = ground(i1[0], i1[2]) + h;
      for (const q of [o0, i1, o1, o0, i0, i1]) pos.push(...q);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    parts.add(mat, g);
    parts.add(mat, capGeometry([ins], (x, z) => ground(x, z) + h));
  } else {
    parts.add(mat, capGeometry(rings, (x, z) => ground(x, z) + shoulder));
  }
}

// Thickness of a polygon (area over half its perimeter): the width of a strip
function thickness(rings) {
  let a = Math.abs(ringArea(rings[0])), per = 0;
  for (const [k, r] of rings.entries()) {
    if (k) a -= Math.abs(ringArea(r));
    for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) per += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]);
  }
  return a / Math.max(per / 2, 1e-6);
}

// --- furniture (paint) -----------------------------------------------------------------------------------------------

const WHITE = [0.8, 0.8, 0.76, 0.42];
const GLOBE = [0.92, 0.88, 0.78, 2.7];

// The garden bench: five white slats on two white cast-iron ends, facing +z (the way a seated person looks)
function addBench(b, m) {
  const L = 1.8;
  for (const [z, y, d] of [[0.2, 0.45, 0.09], [0.07, 0.45, 0.09], [-0.06, 0.45, 0.09]]) b.add(box(L, 0.035, d, 0, y, z), WHITE, m);
  for (const y of [0.62, 0.78]) b.add(box(L, 0.08, 0.03, 0, y, -0.2).applyMatrix4(M4().makeRotationX(-0.18)), WHITE, m);
  for (const x of [-0.75, 0.75]) {
    b.add(box(0.05, 0.45, 0.05, x, 0, 0.2), WHITE, m); // front leg
    b.add(box(0.05, 0.86, 0.05, x, 0, -0.2), WHITE, m); // back leg & back support
    b.add(box(0.05, 0.05, 0.5, x, 0.4, 0), WHITE, m); // seat bearer
    b.add(box(0.05, 0.04, 0.42, x, 0.06, 0), WHITE, m); // stretcher
  }
}

// The garden lamp: a fluted white post on a moulded base, a collar and an opal globe, ~3.9 m
function addLamp(b, m) {
  b.add(lathe([[0.17, 0], [0.17, 0.18], [0.12, 0.26], [0.1, 0.55], [0.075, 0.68], [0.06, 0.75]], 10), WHITE, m);
  b.add(cyl(0.045, 0.06, 2.6, 8, 0.75), WHITE, m);
  b.add(lathe([[0.05, 3.35], [0.09, 3.42], [0.11, 3.5], [0.06, 3.56]], 10), WHITE, m);
  b.add(new THREE.SphereGeometry(0.24, 14, 10).translate(0, 3.78, 0), GLOBE, m);
}

// The ornamental planters (maceteros): white-painted cast iron, ~2.6 m. A moulded round base in steps, a column ringed
// by three cherubs (round lumps at ~1:1), a flaring stem and a wide gadrooned bowl heaped with petunias
function planterGeometry() {
  const iron = [lathe([[0.55, 0], [0.56, 0.08], [0.52, 0.14], [0.5, 0.3], [0.44, 0.36], [0.4, 0.44], [0.36, 0.48],
    [0.34, 0.56], [0.27, 0.6], [0.18, 0.62], [0.18, 1.62], [0.24, 1.66], [0.22, 1.72], [0.18, 1.78], [0.24, 1.9],
    [0.36, 2.0], [0.44, 2.04], [0.62, 2.1], [0.72, 2.2], [0.74, 2.3], [0.7, 2.38], [0.64, 2.4]], 20)];
  for (let k = 0; k < 3; k++) {
    // a cherub against the column: legs, torso, head, an arm raised to the stem
    const a = (2 * Math.PI * k) / 3 + 0.3, c = Math.cos(a), s = Math.sin(a), r = 0.24;
    const P = (rr, y) => [rr * c, y, rr * s];
    for (const off of [-0.05, 0.05]) {
      iron.push(new THREE.CylinderGeometry(0.045, 0.04, 0.42, 6).translate(r * c - s * off, 0.83, r * s + c * off));
    }
    iron.push(new THREE.CapsuleGeometry(0.085, 0.24, 3, 8).translate(...P(r, 1.2)));
    iron.push(new THREE.SphereGeometry(0.075, 10, 8).translate(...P(r + 0.01, 1.47)));
    iron.push(new THREE.CylinderGeometry(0.028, 0.03, 0.34, 6).rotateZ(0.25).translate(...P(r - 0.04, 1.58)));
  }
  return iron;
}

// --- the carousel ----------------------------------------------------------------------------------------------------

const C = {
  cream: [0.78, 0.68, 0.48, 0.55], ivory: [0.86, 0.8, 0.66, 0.5], gilt: [0.78, 0.55, 0.2, 1.32], brass: [0.82, 0.62, 0.3, 1.28],
  rim: [0.3, 0.07, 0.04, 0.45], maroon: [0.3, 0.035, 0.04, 0.55], blue: [0.03, 0.1, 0.42, 0.5], green: [0.03, 0.2, 0.16, 0.5],
  deck: [0.2, 0.1, 0.045, 0.7], fringe: [0.32, 0.05, 0.08, 0.7], sky: [0.35, 0.55, 0.75, 0.6], white: [0.85, 0.84, 0.8, 0.4],
  red: [0.55, 0.03, 0.03, 0.45], dark: [0.03, 0.03, 0.03, 0.6], bulb: [1.0, 0.82, 0.5, 2.55], caryatid: [0.12, 0.3, 0.55, 0.5],
  // the surfaces the bulbs light at night (paint.js FINISH.litPaint): the drum's panels, the inner drum, the canopy's
  // underside
  litCream: [0.78, 0.68, 0.48, 4.5], litGreen: [0.03, 0.2, 0.16, 4.3], litMaroon: [0.3, 0.035, 0.04, 4.35], litSky: [0.35, 0.55, 0.75, 4.4]
};
const CAR = { platform: 0.38, deck2: 2.45, eave: 4.9, poles: 24, poleR: 4.6 };

// Revolve a profile [[r, y], ...] into rings of n segments, each band painted by paintOf(band)
function revolve(b, profile, n, paintOf, phase = 0) {
  for (let k = 0; k + 1 < profile.length; k++) {
    const [r0, y0] = profile[k], [r1, y1] = profile[k + 1];
    for (let i = 0; i < n; i++) {
      const a0 = phase + (2 * Math.PI * i) / n, a1 = phase + (2 * Math.PI * (i + 1)) / n;
      const p = (r, y, a) => [r * Math.cos(a), y, r * Math.sin(a)];
      const am = (a0 + a1) / 2;
      // outward from the axis, tilted by the band's slope
      const dr = r1 - r0, dy = y1 - y0, l = Math.hypot(dr, dy) || 1;
      const out = [Math.cos(am) * (dy / l), -dr / l, Math.sin(am) * (dy / l)];
      b.quad(p(r0, y0, a0), p(r1, y1, a0), p(r1, y1, a1), p(r0, y0, a1), paintOf(k, i), out);
    }
  }
}

function buildCarousel(rot, r) {
  const s = r / 5.4; // the platform's radius sets the scale (1:500 map: 5.4 m)
  const N = 32;
  // platform: the red-brown rim with gilt scrolls (a gilt band), the boarded floor
  revolve(rot, [[5.35 * s, 0.02], [5.35 * s, 0.14], [5.4 * s, 0.17], [5.4 * s, 0.3], [5.32 * s, CAR.platform]], N,
    (k) => (k === 2 ? C.gilt : C.rim));
  rot.add(cyl(5.32 * s, 5.32 * s, 0.01, N, CAR.platform - 0.01), C.deck);
  // the lower drum: cream with green ovals (panels as a darker band) between gilt pilasters, gilt cornice
  revolve(rot, [[2.5, CAR.platform], [2.5, 0.75], [2.5, 2.25], [2.5, CAR.deck2 - 0.2], [2.62, CAR.deck2 - 0.1]], 16,
    (k, i) => (k === 1 ? (i % 2 ? C.litGreen : C.litCream) : k === 3 ? C.gilt : C.litCream));
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / 16;
    rot.add(box(0.12, CAR.deck2 - 0.4 - CAR.platform, 0.06, 0, CAR.platform, 0), C.gilt, at(2.53 * Math.cos(a), 0, 2.53 * Math.sin(a), -a + Math.PI / 2));
  }
  // upper deck: the floor overhanging the drum, its gilt balustrade, blue caryatid columns, the maroon inner drum
  rot.add(cyl(3.35, 3.35, 0.18, N, CAR.deck2), C.cream);
  rot.add(cyl(3.4, 3.4, 0.06, N, CAR.deck2 - 0.06), C.gilt);
  const balR = 3.25;
  for (let i = 0; i < 64; i++) {
    const a = (2 * Math.PI * i) / 64;
    rot.add(box(0.035, 0.85, 0.035, 0, CAR.deck2 + 0.18, 0), C.gilt, at(balR * Math.cos(a), 0, balR * Math.sin(a)));
  }
  revolve(rot, [[balR + 0.04, CAR.deck2 + 1.0], [balR + 0.04, CAR.deck2 + 1.08], [balR - 0.04, CAR.deck2 + 1.08]], N, () => C.gilt);
  revolve(rot, [[balR + 0.04, CAR.deck2 + 0.2], [balR + 0.04, CAR.deck2 + 0.3]], N, () => C.cream);
  for (let i = 0; i < 12; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / 12, m = at(3.05 * Math.cos(a), 0, 3.05 * Math.sin(a), -a);
    rot.add(cyl(0.09, 0.1, 0.45, 8, CAR.deck2 + 0.2), C.gilt, m);
    rot.add(cyl(0.12, 0.07, 0.85, 8, CAR.deck2 + 0.65), C.caryatid, m); // the figure
    rot.add(new THREE.SphereGeometry(0.1, 8, 6).translate(0, CAR.deck2 + 1.6, 0), C.ivory, m);
    rot.add(cyl(0.17, 0.08, 0.27, 8, CAR.deck2 + 1.68), C.caryatid, m);
    rot.add(cyl(0.07, 0.07, CAR.eave + 0.4 - (CAR.deck2 + 1.95), 8, CAR.deck2 + 1.95), C.gilt, m);
  }
  revolve(rot, [[1.8, CAR.deck2 + 0.18], [1.8, CAR.eave + 0.65]], 16, (k, i) => (i % 4 === 0 ? C.litCream : C.litMaroon));
  // the stair from the platform up to the gallery: a straight flight along a chord, with gilt handrails
  {
    const a0 = 0.3, a1 = 0.95, r0 = 4.15, r1 = 3.25;
    const P0 = [r0 * Math.cos(a0), r0 * Math.sin(a0)], P1 = [r1 * Math.cos(a1), r1 * Math.sin(a1)];
    const dx = P1[0] - P0[0], dz = P1[1] - P0[1], run = Math.hypot(dx, dz), ux = dx / run, uz = dz / run;
    const steps = 10, rise = CAR.deck2 - CAR.platform, ry = Math.atan2(ux, uz);
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      rot.add(box(0.9, 0.06, run / steps + 0.04, 0, CAR.platform + (rise * (k + 1)) / steps - 0.06, 0), C.deck,
        at(P0[0] + dx * t, 0, P0[1] + dz * t, ry));
    }
    for (const side of [-0.47, 0.47]) {
      const ox = uz * side, oz = -ux * side;
      const a = [P0[0] + ox, CAR.platform + 0.95, P0[1] + oz], b = [P1[0] + ox, CAR.deck2 + 0.95, P1[1] + oz];
      rot.add(beam(a, b, 0.05, 0.05), C.gilt);
      for (let k = 0; k <= 6; k++) {
        const t = k / 6, x = a[0] + (b[0] - a[0]) * t, z = a[2] + (b[2] - a[2]) * t, y = a[1] + (b[1] - a[1]) * t;
        rot.add(box(0.03, 0.95, 0.03, x, y - 0.95, z), C.gilt);
      }
    }
  }
  // the outer poles (twisted brass: a fine helix of gilt bands), from the platform to the canopy
  const poles = [];
  for (let i = 0; i < CAR.poles; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / CAR.poles, x = CAR.poleR * s * Math.cos(a), z = CAR.poleR * s * Math.sin(a);
    poles.push([x, z, a]);
    rot.add(cyl(0.045, 0.045, CAR.eave - CAR.platform, 8, CAR.platform), C.brass, at(x, 0, z));
    for (let k = 0; k < 9; k++) rot.add(cyl(0.055, 0.055, 0.05, 8, CAR.platform + 0.35 + k * 0.48), C.gilt, at(x, 0, z));
    rot.add(cyl(0.09, 0.07, 0.2, 8, CAR.platform), C.gilt, at(x, 0, z));
  }
  // two carriages and a gondola between the horses, on the inner half of the platform
  for (const [i, kind] of [[2, 0], [8, 1], [14, 0]]) {
    const a = (2 * Math.PI * i) / CAR.poles, rr = 3.45 * s, m = at(rr * Math.cos(a), CAR.platform, rr * Math.sin(a), -a);
    if (kind === 0) {
      rot.add(box(0.9, 0.55, 1.5, 0, 0.1, 0), C.red, m);
      rot.add(box(0.95, 0.6, 0.12, 0, 0.6, -0.65), C.gilt, m);
      rot.add(box(0.95, 0.35, 0.12, 0, 0.6, 0.68), C.gilt, m);
      for (const [x, z] of [[-0.48, -0.5], [0.48, -0.5], [-0.48, 0.5], [0.48, 0.5]]) {
        rot.add(new THREE.CylinderGeometry(0.22, 0.22, 0.05, 12).rotateZ(Math.PI / 2).translate(x, 0.22, z), C.gilt, m);
      }
    } else {
      rot.add(lathe([[0.15, 0], [0.6, 0.15], [0.75, 0.45], [0.72, 0.6]], 12).scale(0.8, 1, 1.6), C.gilt, m);
      rot.add(box(0.2, 1.4, 0.2, 0, 0.5, -1.0), C.gilt, m);
    }
  }
  // the canopy: a shallow cream cone over gilt radial ribs, the blue valance and the burgundy fringe
  const R = 5.62 * s;
  revolve(rot, [[R, CAR.eave], [R * 0.75, CAR.eave + 0.45], [R * 0.45, CAR.eave + 0.8], [0.6, CAR.eave + 1.1]], N, () => C.ivory);
  // underside (seen from the platform): painted panels between the ribs
  const under = (rr) => CAR.eave - 0.05 + 0.4 * Math.max(0, (R - 0.05 - rr) / (R - 3.1)) ** 0.8;
  revolve(rot, [[0.6, CAR.eave + 0.75], [1.85, CAR.eave + 0.6], [3.1, under(3.1)], [R * 0.78, under(R * 0.78)], [R - 0.05, under(R - 0.05)]], N,
    (k, i) => (k === 3 ? (i % 2 ? C.litSky : C.litCream) : C.litCream));
  for (let i = 0; i < 16; i++) {
    // the gilt ribs under the canopy, following its rise towards the centre
    const a = (2 * Math.PI * i) / 16, c = Math.cos(a), sn = Math.sin(a);
    rot.add(beam([3.1 * c, under(3.1) - 0.06, 3.1 * sn], [(R - 0.1) * c, under(R - 0.1) - 0.06, (R - 0.1) * sn], 0.1, 0.08), C.gilt);
  }
  revolve(rot, [[R + 0.02, CAR.eave - 0.45], [R + 0.02, CAR.eave - 0.12]], N * 2, () => C.fringe);
  revolve(rot, [[R + 0.03, CAR.eave - 0.12], [R + 0.03, CAR.eave + 0.15]], N, () => C.blue);
  // fringe scallops: small downward points round the rim
  for (let i = 0; i < 64; i++) {
    const a0 = (2 * Math.PI * i) / 64, a1 = (2 * Math.PI * (i + 1)) / 64, am = (a0 + a1) / 2;
    const P = (rr, y, a) => [rr * Math.cos(a), y, rr * Math.sin(a)];
    rot.tri(P(R + 0.02, CAR.eave - 0.45, a0), P(R + 0.02, CAR.eave - 0.45, a1), P(R + 0.02, CAR.eave - 0.62, am), C.fringe, [Math.cos(am), 0, Math.sin(am)]);
  }
  // the crown: eight painted landscapes in gilt rococo frames, eight cartouches with the city's arms between them
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * i) / 16, big = i % 2 === 0;
    const w = big ? 2.05 * s : 0.95 * s, h = big ? 1.35 : 1.55, y0 = CAR.eave + 0.15;
    const m = at(R * Math.cos(a), 0, R * Math.sin(a), -a + Math.PI / 2);
    // frame: a gilt board with a curved top (an arc of quads), the painting inset in front of it
    const frame = new THREE.Shape();
    frame.moveTo(-w / 2, 0);
    frame.lineTo(w / 2, 0);
    frame.lineTo(w / 2, h * 0.72);
    frame.quadraticCurveTo(w * 0.3, h * 0.8, w * 0.12, h * 0.92);
    frame.quadraticCurveTo(0, h * 1.12, -w * 0.12, h * 0.92);
    frame.quadraticCurveTo(-w * 0.3, h * 0.8, -w / 2, h * 0.72);
    frame.closePath();
    const fg = new THREE.ExtrudeGeometry(frame, { depth: 0.1, bevelEnabled: false, curveSegments: 4 }).translate(0, y0, -0.05);
    rot.add(fg, C.gilt, m);
    if (big) {
      // the painting: sky over hills and sea in three bands, a little proud of the frame's front, green rococo scrolls
      // along the frame's sides
      const bands = [[0.12, 0.38, C.green], [0.38, 0.55, [0.12, 0.3, 0.42, 0.6]], [0.55, 0.78, C.sky]];
      for (const [b0, b1, p] of bands) rot.add(new THREE.PlaneGeometry(w * 0.78, h * (b1 - b0)).translate(0, y0 + h * (b0 + b1) / 2, 0.06), p, m);
      for (const sx of [-1, 1]) rot.add(new THREE.PlaneGeometry(0.1, h * 0.6).translate(sx * w * 0.44, y0 + h * 0.45, 0.06), C.green, m);
    } else {
      // the city's arms: a blue shield under a gilt crown, and a round medallion in a green wreath on top
      rot.add(new THREE.PlaneGeometry(w * 0.55, h * 0.42).translate(0, y0 + h * 0.4, 0.06), C.blue, m);
      rot.add(new THREE.PlaneGeometry(w * 0.3, h * 0.12).translate(0, y0 + h * 0.68, 0.065), C.gilt, m);
      rot.add(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 14).rotateX(Math.PI / 2).translate(0, y0 + h * 1.12 + 0.12, 0), C.green, m);
      rot.add(new THREE.CircleGeometry(0.14, 14).translate(0, y0 + h * 1.12 + 0.12, 0.045), C.ivory, m);
    }
  }
  // the top: a gilt drum and finial over the cone
  rot.add(lathe([[0.62, 0], [0.62, 0.25], [0.45, 0.4], [0.3, 0.8], [0.12, 1.0], [0.05, 1.3]], 12).translate(0, CAR.eave + 1.1, 0), C.gilt);
  // bulbs: round the crown frames, along the ribs under the canopy, round the gallery and down the drum's pilasters
  const bulb = new THREE.OctahedronGeometry(0.045, 0);
  const B = (x, y, z) => rot.add(bulb, C.bulb, M4().makeTranslation(x, y, z));
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * i) / 16, big = i % 2 === 0, w = big ? 2.05 * s : 0.95 * s, h = big ? 1.35 : 1.55;
    const c = Math.cos(a), sn = Math.sin(a), tx = -sn, tz = c, rr = R + 0.08;
    const n = big ? 9 : 4;
    for (let k = 0; k <= n; k++) {
      const u = -w / 2 + (w * k) / n;
      B(rr * c + tx * u, CAR.eave + 0.2, rr * sn + tz * u);
      B(rr * c + tx * u, CAR.eave + 0.15 + h * (0.72 + 0.3 * (1 - Math.abs(2 * u / w)) ** 2), rr * sn + tz * u);
    }
    for (let k = 1; k < 10; k++) {
      const rr2 = 3.1 + ((R - 3.3) * k) / 10;
      B(rr2 * c, under(rr2) - 0.16, rr2 * sn);
    }
  }
  for (let i = 0; i < 72; i++) {
    const a = (2 * Math.PI * i) / 72;
    B((R + 0.05) * Math.cos(a), CAR.eave - 0.08, (R + 0.05) * Math.sin(a));
    B(3.42 * Math.cos(a), CAR.deck2 - 0.1, 3.42 * Math.sin(a));
  }
  for (let i = 0; i < 16; i++) {
    const a = (2 * Math.PI * (i + 0.5)) / 16;
    for (let k = 0; k < 7; k++) B(2.6 * Math.cos(a), CAR.platform + 0.35 + k * 0.32, 2.6 * Math.sin(a));
  }
  return poles;
}

// A carousel horse, ~1.6 m nose to tail, galloping along +x (in the instance's frame), its pole through the saddle; the
// photographs show white, black and dapple horses with red saddles
function horseGeometry(coat, mane) {
  const b = new PaintBuilder();
  const body = new THREE.SphereGeometry(0.22, 12, 8).scale(1.75, 1, 0.82);
  b.add(body, coat, at(0, 1.05, 0));
  b.add(new THREE.CylinderGeometry(0.1, 0.14, 0.5, 8).rotateZ(-0.75).translate(0.43, 1.32, 0), coat); // neck
  b.add(new THREE.BoxGeometry(0.34, 0.15, 0.15).rotateZ(-0.35).translate(0.66, 1.52, 0), coat); // head
  b.add(new THREE.BoxGeometry(0.42, 0.05, 0.05).rotateZ(-0.75).translate(0.38, 1.42, 0), mane); // mane
  b.add(new THREE.BoxGeometry(0.36, 0.05, 0.42).translate(-0.02, 1.27, 0), C.red); // saddle
  b.add(new THREE.BoxGeometry(0.06, 0.22, 0.44).translate(0.0, 1.12, 0), C.gilt); // girth & cloth edge
  b.add(new THREE.CylinderGeometry(0.03, 0.06, 0.45, 6).rotateZ(1.0).translate(-0.48, 1.0, 0), mane); // tail
  // legs: galloping, the front pair raised forward, the hind pair back
  const leg = (x, z, rz) => b.add(new THREE.CylinderGeometry(0.035, 0.045, 0.6, 6).translate(0, -0.3, 0).rotateZ(rz).translate(x, 0.98, z), coat);
  leg(0.27, 0.09, 1.0); leg(0.27, -0.09, 0.75); leg(-0.27, 0.09, -0.55); leg(-0.27, -0.09, -0.35);
  return b.geometry();
}

// --- the ticket booth & the playground -------------------------------------------------------------------------------

// The carousel's booth: dark varnished panels with a gilt frieze ("Carrousel Belle Époque"), a little zinc roof
function addBooth(b, x, y, z, angle, w, d) {
  const m = at(x, y, z, -angle);
  b.add(box(w, 2.7, d, 0, 0, 0), [0.07, 0.035, 0.02, 0.4], m);
  b.add(box(w + 0.04, 0.32, d + 0.04, 0, 2.0, 0), C.gilt, m);
  b.add(box(w + 0.25, 0.1, d + 0.25, 0, 2.7, 0), [0.25, 0.25, 0.24, 1.4], m);
  b.add(box(w * 0.5, 0.75, 0.02, 0, 0.95, d / 2 + 0.01), [0.3, 0.27, 0.2, 3.15], m); // the ticket window
}

// Playground: a dark green rubber floor, two yellow play towers with grey hip roofs and a slide, a yellow swing frame
function addPlayground(b, ring, swings, ground, terrain) {
  b.add(drapedCap([ring], terrain, 0.03), [0.05, 0.1, 0.07, 0.95]);
  const Y = [0.75, 0.5, 0.02, 0.6], ROOF = [0.32, 0.34, 0.36, 0.5], BLUE = [0.05, 0.25, 0.6, 0.5], STEEL = [0.7, 0.72, 0.74, 1.3];
  // the patch's axis: its longest edge
  let best = null;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const j = (i + 1) % n, dx = ring[2 * j] - ring[2 * i], dz = ring[2 * j + 1] - ring[2 * i + 1], l = Math.hypot(dx, dz);
    if (!best || l > best.l) best = { l, dx: dx / l, dz: dz / l };
  }
  let cx = 0, cz = 0;
  for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
  cx /= ring.length / 2; cz /= ring.length / 2;
  const ang = Math.atan2(best.dz, best.dx);
  // the towers along the axis from the centre, away from the swings
  let sx = cx, sz = cz;
  if (swings.length >= 2) { sx = (swings[0] + swings[2]) / 2; sz = (swings[1] + swings[3]) / 2; }
  const away = ((cx - sx) * best.dx + (cz - sz) * best.dz) >= 0 ? 1 : -1;
  const towers = [[3.0, 1.5], [7.6, 1.2]];
  for (const [u, h] of towers) {
    const x = cx + best.dx * u * away, z = cz + best.dz * u * away, m = at(x, ground(x, z), z, -ang);
    for (const [px, pz] of [[-1.05, -1.05], [1.05, -1.05], [-1.05, 1.05], [1.05, 1.05]]) b.add(box(0.14, h + 1.9, 0.14, px, 0, pz), Y, m);
    b.add(box(2.2, 0.1, 2.2, 0, h, 0), Y, m);
    b.add(box(2.1, 0.7, 0.05, 0, h + 0.1, 1.07), BLUE, m);
    b.add(box(2.1, 0.7, 0.05, 0, h + 0.1, -1.07), [0.1, 0.45, 0.15, 0.5], m);
    b.add(new THREE.ConeGeometry(1.75, 0.95, 4, 1).rotateY(Math.PI / 4).translate(0, h + 1.9 + 0.47, 0), ROOF, m);
    b.add(new THREE.BoxGeometry(0.6, 0.05, h * 2.1).rotateX(Math.atan2(h, h * 1.8)).translate(1.6, h * 0.5, 0)
      .applyMatrix4(M4().makeRotationY(Math.PI / 2)), STEEL, m);
  }
  {
    // the rope bridge between the towers
    const [ua, ha] = towers[0], [ub, hb] = towers[1];
    const xa = cx + best.dx * (ua + 1.1) * away, za = cz + best.dz * (ua + 1.1) * away;
    const xb = cx + best.dx * (ub - 1.1) * away, zb = cz + best.dz * (ub - 1.1) * away;
    const ya = ground(xa, za) + ha, yb = ground(xb, zb) + hb;
    b.add(beam([xa, ya, za], [xb, yb, zb], 0.9, 0.06), [0.35, 0.2, 0.08, 0.7]);
    for (const s of [-0.45, 0.45]) {
      const ox = -best.dz * s, oz = best.dx * s;
      b.add(beam([xa + ox, ya + 0.8, za + oz], [xb + ox, yb + 0.8, zb + oz], 0.05, 0.05), Y);
    }
  }
  // the swing frame over OSM's two swings
  if (swings.length >= 2) {
    const x0 = swings[0], z0 = swings[1], x1 = swings[swings.length - 2], z1 = swings[swings.length - 1];
    const dx = x1 - x0, dz = z1 - z0, l = Math.max(Math.hypot(dx, dz), 0.5), ux = dx / l, uz = dz / l;
    const ends = [[x0 - ux * 1.2, z0 - uz * 1.2], [x1 + ux * 1.2, z1 + uz * 1.2]];
    const top = 2.3, a = Math.atan2(uz, ux);
    for (const [ex, ez] of ends) {
      const g = ground(ex, ez), m = at(ex, g, ez, -a);
      for (const s of [-1, 1]) b.add(new THREE.BoxGeometry(0.1, 2.5, 0.1).translate(0, 1.2, 0).rotateX(s * 0.32), Y, m);
    }
    const g0 = ground((x0 + x1) / 2, (z0 + z1) / 2);
    b.add(new THREE.BoxGeometry(l + 2.4, 0.1, 0.1), Y, at((x0 + x1) / 2, g0 + top, (z0 + z1) / 2, -a));
    for (let k = 0; k < swings.length; k += 2) {
      const m = at(swings[k], ground(swings[k], swings[k + 1]), swings[k + 1], -a);
      for (const s of [-0.22, 0.22]) b.add(box(0.015, top - 0.5, 0.015, s, 0.5, 0), STEEL, m);
      b.add(box(0.5, 0.05, 0.2, 0, 0.48, 0), [0.1, 0.1, 0.1, 0.8], m);
    }
  }
}

// --- build -----------------------------------------------------------------------------------------------------------

// The ground as the terrain's chunk meshes draw it in the core: the 2 m height samples split along each quad's
// diagonal (js/donostia/terrain.js chunkIndex), rather than heightAt's bilinear surface, which a few centimetres of
// paving or gravel laid over a step would dip under
function meshGround(terrain) {
  const f = terrain.core;
  return (x, z) => {
    if (!f || !f.contains?.(x, z)) return Math.max(0, terrain.heightAt(x, z));
    const fx = (x - f.x0) / f.res - 0.5, fz = (z - f.z0) / f.res - 0.5;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    const p = f.at(i, j), q = f.at(i + 1, j), r = f.at(i, j + 1), s = f.at(i + 1, j + 1);
    return Math.max(0, tx + tz <= 1 ? p + (q - p) * tx + (r - p) * tz : s + (r - s) * (1 - tx) + (q - s) * (1 - tz));
  };
}

// A thin overlay (paving, gravel, rubber) laid exactly on the terrain's mesh, `lift` metres over it: the polygon's
// triangles are cut by the mesh's own triangles in the core (each piece takes that triangle's plane), so a layer of a
// few centimetres never dips under a crease of the ground. Outside the core (no such mesh) it drapes by subdivision.
function drapedCap(rings, terrain, lift) {
  const f = terrain.core;
  const contour = toV2(rings[0]), holes = rings.slice(1).map(toV2);
  const pts = [...contour, ...holes.flat()];
  const pos = [];
  const sx = (i) => f.x0 + (i + 0.5) * f.res, sz = (j) => f.z0 + (j + 0.5) * f.res;
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
    const T = [pts[a].x, pts[a].y, pts[b].x, pts[b].y, pts[c].x, pts[c].y];
    const minX = Math.min(T[0], T[2], T[4]), maxX = Math.max(T[0], T[2], T[4]);
    const minZ = Math.min(T[1], T[3], T[5]), maxZ = Math.max(T[1], T[3], T[5]);
    if (!f?.contains?.(minX, minZ) || !f.contains(maxX, maxZ)) {
      const g = capGeometry([T], (x, z) => Math.max(0, terrain.heightAt(x, z)) + lift + 0.05, 1.0);
      pos.push(...g.attributes.position.array);
      continue;
    }
    const i0 = Math.floor((minX - f.x0) / f.res - 0.5), i1 = Math.floor((maxX - f.x0) / f.res - 0.5);
    const j0 = Math.floor((minZ - f.z0) / f.res - 0.5), j1 = Math.floor((maxZ - f.z0) / f.res - 0.5);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const P = [sx(i), sz(j), f.at(i, j)], Q = [sx(i + 1), sz(j), f.at(i + 1, j)];
      const R = [sx(i), sz(j + 1), f.at(i, j + 1)], S = [sx(i + 1), sz(j + 1), f.at(i + 1, j + 1)];
      // the chunk meshes' two triangles of the quad (split along Q-R, js/donostia/terrain.js chunkIndex)
      for (const [A, B, C] of [[P, Q, R], [Q, S, R]]) {
        let poly = T;
        for (const [U, V, W] of [[A, B, C], [B, C, A], [C, A, B]]) {
          if (!poly) break;
          const ex = V[0] - U[0], ez = V[1] - U[1];
          const sgn = Math.sign(ex * (W[1] - U[1]) - ez * (W[0] - U[0]));
          poly = clipRing(poly, -sgn * ez, sgn * ex, sgn * (ez * U[0] - ex * U[1]));
        }
        if (!poly) continue;
        // the triangle's plane y = A.y + gx (x - A.x) + gz (z - A.z)
        const d = (B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1]);
        const gx = ((B[2] - A[2]) * (C[1] - A[1]) - (C[2] - A[2]) * (B[1] - A[1])) / d;
        const gz = ((C[2] - A[2]) * (B[0] - A[0]) - (B[2] - A[2]) * (C[0] - A[0])) / d;
        const y = (x, z) => A[2] + gx * (x - A[0]) + gz * (z - A[1]) + lift;
        for (let k = 2; k < poly.length / 2; k++) {
          let p0 = [poly[0], poly[1]], p1 = [poly[2 * k - 2], poly[2 * k - 1]], p2 = [poly[2 * k], poly[2 * k + 1]];
          if ((p1[0] - p0[0]) * (p2[1] - p0[1]) - (p1[1] - p0[1]) * (p2[0] - p0[0]) > 0) [p1, p2] = [p2, p1];
          for (const q of [p0, p1, p2]) pos.push(q[0], y(q[0], q[1]), q[1]);
        }
      }
    }
  }
  // smooth normals from the ground's slope (as the terrain's own, central differences), not the facets'
  const nrm = new Float32Array(pos.length);
  for (let k = 0; k < pos.length; k += 3) {
    const x = pos[k], z = pos[k + 2];
    const gx = (terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z)) / 2, gz = (terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;
    const l = Math.hypot(gx, 1, gz);
    nrm[k] = -gx / l; nrm[k + 1] = 1 / l; nrm[k + 2] = -gz / l;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  return g;
}

export function build(sites, ctx) {
  const { terrain, kit, GEO } = ctx;
  const ground = meshGround(terrain);
  const group = new THREE.Group();
  group.name = 'AlderdiEder';
  const parts = new Parts();
  const plants = plantMaterial();
  // the hedges' pieces flagged uv.x = 1 for the plant material, the flowers' left at 0
  const hedgeParts = {
    add(mat, g) {
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(1), 2));
      parts.add(mat, g);
    }
  };

  // Hedges: clipped boxwood & privet, taller as they thicken (the edging rows ~0.7 m, the masses up to 1.5 m)
  for (const rings of ALDERDI.hedges) {
    const t = thickness(rings);
    raised(hedgeParts, plants, rings, ground, Math.min(1.5, 0.55 + 0.45 * t), 0.07);
  }
  // Flower beds: the parterres' hearts raised a hand's breadth; the round bed's clumps higher
  for (const rings of ALDERDI.beds) raised(parts, plants, rings, ground, 0.16, 0.18);
  for (const rings of ALDERDI.seasonal) raised(parts, plants, rings, ground, 0.32, 0.25);
  // Red gravel: the edging strips just proud of the lawn, the walks of the garden by Hernani street
  for (const rings of ALDERDI.edging) parts.add(kit.materials.terracotta, drapedCap(rings, terrain, 0.03));
  if (ALDERDI.gravel) parts.add(kit.materials.terracotta, drapedCap(ALDERDI.gravel, terrain, 0.025));
  // The planters: white iron, their bowls heaped with flowers
  for (let k = 0; k < ALDERDI.planters.length; k += 3) {
    const x = ALDERDI.planters[k], z = ALDERDI.planters[k + 1], m = at(x, ground(x, z) - 0.02, z, (ALDERDI.planters[k + 2] * Math.PI) / 180);
    for (const g of planterGeometry()) parts.addAt(kit.materials.whiteRender, g, m);
    const heap = new THREE.SphereGeometry(0.8, 18, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.3, 1).translate(0, 2.3, 0);
    heap.deleteAttribute('uv'); // (flowers: uv.x = 0)
    parts.addAt(plants, heap, m);
  }
  // The City Hall terrace's low walls of the hall's sandstone: from the garden's ground to a kerb ~0.35 m over the
  // terrace, along OSM's walls (gaps at the steps)
  for (const w of ALDERDI.walls || []) {
    for (let k = 2; k < w.length; k += 2) {
      const ax = w[k - 2], az = w[k - 1], bx = w[k], bz = w[k + 1], len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(len / 2.5));
      for (let q = 0; q < n; q++) {
        const t0 = q / n, t1 = (q + 1) / n;
        const p0 = [ax + (bx - ax) * t0, az + (bz - az) * t0], p1 = [ax + (bx - ax) * t1, az + (bz - az) * t1];
        // the terrace side is the higher ground either side of the wall
        const nx = -(bz - az) / len, nz = (bx - ax) / len, mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
        const top = Math.max(ground(mx + nx * 0.8, mz + nz * 0.8), ground(mx - nx * 0.8, mz - nz * 0.8)) + 0.35;
        const bottom = Math.min(ground(mx + nx * 0.8, mz + nz * 0.8), ground(mx - nx * 0.8, mz - nz * 0.8)) - 0.2;
        const g = new THREE.BoxGeometry(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 0.02, top - bottom, 0.4);
        g.rotateY(-Math.atan2(p1[1] - p0[1], p1[0] - p0[0])).translate(mx, (top + bottom) / 2, mz);
        parts.add(kit.materials.sandstone, g);
        const cap = new THREE.BoxGeometry(Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + 0.04, 0.08, 0.5);
        cap.rotateY(-Math.atan2(p1[1] - p0[1], p1[0] - p0[0])).translate(mx, top + 0.04, mz);
        parts.add(kit.materials.sandstone, cap);
      }
    }
  }
  const statics = parts.build('AlderdiEder:garden');
  statics.children.forEach((m) => { m.receiveShadow = true; });
  group.add(statics);

  // Fences: one alpha-to-coverage strip along every fence run, panels round the parterres, hoops by Hernani street
  {
    const pos = [], nrm = [], tex = [], idx = [];
    const runs = [...ALDERDI.fences.map((f) => [f, false]), ...(ALDERDI.hoops || []).map((f) => [f, true])];
    for (const [f, hoops] of runs) {
      const n = f.length / 2;
      const H = hoops ? HOOP_H : FENCE_H, v0 = hoops ? HOOP : 0;
      let u = 0;
      for (let k = 0; k < n; k++) {
        const x = f[2 * k], z = f[2 * k + 1];
        if (k) u += Math.hypot(x - f[2 * k - 2], z - f[2 * k - 1]);
        const p = Math.max(0, k - 1), q = Math.min(n - 1, k + 1);
        const dx = f[2 * q] - f[2 * p], dz = f[2 * q + 1] - f[2 * p + 1], l = Math.hypot(dx, dz) || 1;
        const y = ground(x, z);
        const base = pos.length / 3;
        pos.push(x, y - 0.02, z, x, y + H, z);
        nrm.push(dz / l, 0, -dx / l, dz / l, 0, -dx / l);
        tex.push(u, v0 - 0.02, u, v0 + H);
        if (k) idx.push(base - 2, base, base + 1, base - 2, base + 1, base - 1);
      }
    }
    if (idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
      g.setIndex(idx);
      g.computeBoundingBox();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, fenceMaterial());
      mesh.name = 'AlderdiEder:fences';
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }

  // The City Hall terrace's paving over the strip of ground the municipal map leaves blank: the baked raster's runs,
  // merged into rectangles, laid 3 cm over the terrain's mesh
  const T = ALDERDI.terrace;
  if (T?.runs?.length) {
    const [ax, az] = T.axis, cell = T.cell;
    const xz = (u, v) => [u * ax - v * az, u * az + v * ax];
    // runs repeated on consecutive rows merge into rectangles
    const rects = [];
    const open = new Map();
    for (let k = 0; k < T.runs.length; k += 3) {
      const v = T.runs[k], u0 = T.runs[k + 1], u1 = T.runs[k + 2], key = `${u0},${u1}`;
      const r = open.get(key);
      if (r && Math.abs(r.v1 - v) < cell * 0.5) r.v1 = v + cell;
      else { const n = { u0, u1, v0: v, v1: v + cell }; rects.push(n); open.set(key, n); }
    }
    const pieces = rects.map((r) => drapedCap([[...xz(r.u0, r.v0), ...xz(r.u1, r.v0), ...xz(r.u1, r.v1), ...xz(r.u0, r.v1)]], terrain, 0.03));
    const g = mergeGeometries(pieces.filter((p) => p.attributes.position.count));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, pavingMaterial(T.axis));
    mesh.name = 'AlderdiEder:terrace';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }

  // Painted things that stand still: benches, lamps, the carousel's booth, the playground
  const paint = new PaintBuilder();
  for (let k = 0; k < ALDERDI.benches.length; k += 3) {
    const x = ALDERDI.benches[k], z = ALDERDI.benches[k + 1];
    addBench(paint, at(x, ground(x, z) - 0.01, z, (ALDERDI.benches[k + 2] * Math.PI) / 180));
  }
  for (let k = 0; k < ALDERDI.lamps.length; k += 2) {
    const x = ALDERDI.lamps[k], z = ALDERDI.lamps[k + 1];
    addLamp(paint, at(x, ground(x, z) - 0.02, z));
  }
  // La Terraza del Náutico: the timber deck out over the rocks between the harbour and the bay, level with the quay it
  // leaves (the median ground under its corners that stand above the beach), on dark posts, its fascia and a white
  // railing along the edges that drop away
  const dk = ALDERDI.deck;
  if (dk?.length >= 6) {
    const hs = [];
    for (let k = 0; k < dk.length; k += 2) { const h = ground(dk[k], dk[k + 1]); if (h > 3) hs.push(h); }
    hs.sort((p, q) => p - q);
    const level = hs.length ? hs[hs.length >> 1] + 0.1 : null;
    if (level !== null) {
      const PLANKS = [0.24, 0.14, 0.075, 0.72], TIMBER = [0.1, 0.06, 0.035, 0.8];
      paint.add(capGeometry([dk], () => level, 50), PLANKS);
      paint.add(wallGeometry([dk], () => level - 0.3, () => level), TIMBER);
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (let k = 0; k < dk.length; k += 2) { x0 = Math.min(x0, dk[k]); x1 = Math.max(x1, dk[k]); z0 = Math.min(z0, dk[k + 1]); z1 = Math.max(z1, dk[k + 1]); }
      for (let x = x0 + 1.5; x < x1; x += 3) for (let z = z0 + 1.5; z < z1; z += 3) {
        const g = ground(x, z);
        if (g < level - 0.6 && pointIn(x, z, dk)) paint.add(box(0.22, level - 0.3 - g + 0.3, 0.22, x, g - 0.3, z), TIMBER);
      }
      for (let k = 0; k < dk.length; k += 2) {
        const j = (k + 2) % dk.length, ax = dk[k], az = dk[k + 1], bx = dk[j], bz = dk[j + 1];
        const len = Math.hypot(bx - ax, bz - az);
        if (ground((ax + bx) / 2, (az + bz) / 2) > level - 0.8) continue; // (the side the quay meets)
        for (const h of [0.5, 1.0]) paint.add(beam([ax, level + h, az], [bx, level + h, bz], h === 1.0 ? 0.06 : 0.04, 0.04), WHITE);
        const n = Math.max(1, Math.round(len / 1.5));
        for (let q = 0; q <= n; q++) paint.add(box(0.05, 1.0, 0.05, ax + ((bx - ax) * q) / n, level, az + ((bz - az) * q) / n), WHITE);
      }
    }
  }
  // The ikurriña's flagpole by the harbour: a white mast with a gilt ball, the flag (red, the green saltire under the
  // white cross) flying from it
  for (let k = 0; k < (ALDERDI.flagpoles || []).length; k += 2) {
    const x = ALDERDI.flagpoles[k], z = ALDERDI.flagpoles[k + 1], m = at(x, ground(x, z), z, 0.6);
    paint.add(cyl(0.11, 0.15, 0.3, 10), WHITE, m);
    paint.add(cyl(0.045, 0.085, 10.5, 10, 0.3), WHITE, m);
    paint.add(new THREE.SphereGeometry(0.09, 10, 8).translate(0, 10.85, 0), C.gilt, m);
    const fw = 2.0, fh = 1.15, fy = 10.0 - fh / 2, fx = 0.08 + fw / 2;
    const flag = (geo, p) => paint.add(geo.translate(fx, fy, 0), p, m);
    flag(new THREE.BoxGeometry(fw, fh, 0.015), [0.62, 0.02, 0.04, 0.7]);
    const diag = Math.atan2(fh, fw), dl = Math.hypot(fw, fh);
    for (const sgn of [1, -1]) flag(new THREE.BoxGeometry(dl, fh * 0.12, 0.025).rotateZ(sgn * diag), [0.0, 0.3, 0.1, 0.7]);
    flag(new THREE.BoxGeometry(fw, fh * 0.12, 0.035), [0.82, 0.82, 0.8, 0.7]);
    flag(new THREE.BoxGeometry(fh * 0.12, fh, 0.035), [0.82, 0.82, 0.8, 0.7]);
  }
  const pg = ALDERDI.playground;
  if (pg?.ring?.length >= 6) addPlayground(paint, pg.ring, pg.swings || [], ground, terrain);

  // The carousel's ticket booth replaces the light building the 1:500 map draws beside the carousel
  const car = ALDERDI.carousel;
  const hide = [];
  GEO.buildings.forEach((bld, i) => {
    const r = bld.g?.[0];
    if (!r || r.length > 24) return;
    let cx = 0, cz = 0;
    for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1]; }
    cx /= r.length / 2; cz /= r.length / 2;
    if (Math.hypot(cx - car.x, cz - car.z) > car.r + 12 || Math.abs(ringArea(r)) > 12) return;
    const ob = kit.orientedBox(r);
    addBooth(paint, ob.x, ground(ob.x, ob.z), ob.z, ob.angle, Math.max(ob.length, 1.2), Math.max(ob.width, 1.2));
    hide.push(i);
  });
  const still = paint.build('AlderdiEder:furniture');
  if (still) group.add(still);

  // The carousel: everything that turns in one mesh, the horses instanced so they can rise and fall on their poles
  const rotor = new THREE.Group();
  rotor.name = 'AlderdiEder:carousel';
  const cy = ground(car.x, car.z);
  rotor.position.set(car.x, cy, car.z);
  const rb = new PaintBuilder();
  const poles = buildCarousel(rb, car.r);
  const turning = rb.build('AlderdiEder:carouselBody');
  turning.matrixAutoUpdate = false;
  rotor.add(turning);
  // the horses on every pole, white and black in turn: two instanced meshes of one pipeline
  const herds = [[C.white, C.gilt], [[0.025, 0.022, 0.02, 0.35], [0.7, 0.66, 0.6, 0.5]]].map(([coat, mane], h) => {
    const mesh = new THREE.InstancedMesh(horseGeometry(coat, mane), paintMaterial(), Math.ceil((poles.length - h) / 2));
    mesh.name = `AlderdiEder:horses${h}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.4, 0), CAR.poleR + 1.2); // (they move about on the poles)
    rotor.add(mesh);
    return mesh;
  });
  const hm = new THREE.Matrix4(), hq = new THREE.Quaternion(), hs = new THREE.Vector3(1, 1, 1), hp = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const placeHorses = (t) => {
    poles.forEach(([x, z, a], i) => {
      // galloping the way the rotor turns (anticlockwise seen from above: a horse at angle a travels along
      // (sin a, -cos a)), rising and falling on its pole out of step with its neighbours
      hq.setFromAxisAngle(up, Math.PI / 2 - a);
      hp.set(x, CAR.platform - 0.15 + 0.15 * Math.sin(t * 1.6 + i * 2.1), z);
      hm.compose(hp, hq, hs);
      herds[i % 2].setMatrixAt(i >> 1, hm);
    });
    for (const mesh of herds) mesh.instanceMatrix.needsUpdate = true;
  };
  placeHorses(0);
  rotor.updateMatrixWorld(true);
  group.add(rotor);

  const SPEED = 0.32; // rad/s, about three turns a minute
  group.userData.update = (dt, elapsed, camera) => {
    if (camera && camera.position.distanceToSquared(rotor.position) > 600 * 600) return;
    rotor.rotation.y = elapsed * SPEED;
    rotor.updateMatrixWorld(true);
    placeHorses(elapsed);
  };
  group.userData.hide = hide;
  return group;
}
