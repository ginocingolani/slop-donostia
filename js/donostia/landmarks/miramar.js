import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, abs, max, min, mix, floor, fract, sin, dot, clamp, smoothstep, step, select, fwidth,
  positionWorld, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { PartBin, Frame, westMaterials as M, rgb, strut } from './igeldo.js';
import { ringArea, clipRing, newell } from './geom.js';

// js/donostia/landmarks/miramar.js
// Miramar jauregia / Palacio de Miramar (1889-93): the royal summer palace on the hill between La Concha and Ondarreta,
// designed by Ralph Selden Wornum and built by José Goicoa in an English "Old English" / Queen Anne manner with
// neo-Gothic touches (es.wikipedia "Palacio de Miramar (San Sebastián)"; the Basque Government's heritage entry). The
// road and the old tramway pass under its gardens in a cut-and-cover tunnel.
//
// From the photographs (Wikimedia Commons, Category:Miramar jauregia: the garden front from the lawn, the bay and the
// beach, the tower, the gate arch and the north-west end, 2005-2025), all references only:
//  - the garden front, facing the bay over the lawn, is two big cross-gables with a loggia of five pointed arches
//    between them, three gabled dormers on the roof over it; under each gable a canted stone bay with a balustraded
//    balcony on top, a jettied half-timbered gable above (a band of windows over the sill, a wheel either side of the
//    king post, dark barge boards and a finial) on a tiled hood;
//  - the ground floor is buff sandstone ashlar, the floor above orange-red brick with stone quoins, string courses and
//    window surrounds; windows behind brown louvred shutters or stone mullions and transoms;
//  - the roofs are steep brown-red plain tiles (not slate), with tall stone chimney stacks;
//  - the octagonal tower (restored 2007) rises at the north-west end, to the right of the garden front seen from the
//    bay, out of the corner of a lower wing set back from the gables: a square base of stone and brick to the eaves,
//    then an octagon of brick two storeys up, a belvedere of white-framed windows between dark posts, an octagonal tiled
//    roof with little dormers and a tall finial; a tall chimney beside it;
//  - past the tower, a one-storey wing with a pointed gate arch (brick, a stone surround, chequered quoins and a shield
//    on the parapet) through to the forecourt; at the far, south-east end of the garden front's lower wing a stone
//    octagonal turret with a steep pyramid roof and a weathervane; the service wing round two light-courts beyond.
//
// The plan is the municipal 1:500 map's outline (Donostiako Udala, CC BY-SA 3.0; GEO.buildings, the site's building),
// read in the palace's own frame against the 2025 orthophoto (Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi) for the
// roofs' ridges, hips, dormers, chimneys and the light-courts. The turret is the outline's octagon (2.57 m sides); the
// tower, which the outline leaves inside its north-west wing, stands where the orthophoto shows its octagonal roof and
// long shadow, as wide as the turret; the gate arch's wing, which the 1:500 building lacks, is OpenStreetMap's outline
// (© OpenStreetMap contributors, ODbL) moved onto the 1:500 frame. Heights: b5m (CC BY 4.0) gives the principal floor
// and ~12.5 m mean, ~18 m at the ridges; the storeys, gables and the tower's ~27 m to the finial were read off the
// photographs.
//
// Walls carry a `facade` attribute (u along the wall, height over the principal floor, the wall's length, finish kind
// + seed) read by one brick-and-stone shader; roofs are built per rectangle of the plan (ROOFS) with their gables,
// hips and dormers; everything else is merged per material (igeldo.js's PartBin): one draw call per material.
//
// build(sites, ctx) receives the GEO.landmarks entries ['miramar'] and ctx = { GEO, terrain, kit }.

const deg = THREE.MathUtils.degToRad;

// The palace's frame, read off the 1:500 outline: +u along the garden front from the tower towards the turret (28.6° from
// east towards south), +v across it towards the forecourt; the garden and the bay lie at -v.
const FRAME = { x: -780, z: 740, angle: deg(28.6) };
// Heights over the principal floor (the garden's level): the stone ground floor's top, the storeys over it, the eaves
// of the palace, of the service wing and of the gate arch's wing
const GF = 4.6, STOREY = 3.9, EAVE = 9.0, WING = 8.5, ARCH = 6.4;
// The octagons (corners at 22.5° + k·45° in the frame): the tower, its walls' top; the stone turret (the outline's own)
const TOWER = { u: -27.6, v: -3.6, apothem: 3.095, top: 16.5 };
const TURRET = { u: 34.86, v: -0.09, apothem: 3.095, top: 12.0 };
// The gate arch's wing (OpenStreetMap's outline, moved 3.1 m along u onto the 1:500 frame) and its arch, on the garden
// side
const GATE = { u0: -37.8, u1: -30.6, v0: -1.3, v1: 10.2, u: -34.6, span: 3.6, spring: 2.6 };
// Finishes the wall shader tells apart (the integer part of facade.w)
const KIND = { brick: 0, loggia: 1, ashlar: 2, blank: 3, tower: 4 };

const BRICK = new THREE.Color(0xb35a3d), DRESSING = new THREE.Color(0xc8b28a);
const STONE = rgb(0xc8b28a), OAK = rgb(0x3b2519), RENDER = rgb(0xebe5d7), WHITE = rgb(0xf0ede4), LEAD = rgb(0x8f8d88);
const DARK = rgb(0x1a1612), IRON = rgb(0x2a2a2a), SHUTTER = rgb(0x553624), PANE = rgb(0x2c2f33);
const NO_WINDOWS = { facade: [0, 99, 0, KIND.blank] };

// Wall tops and finishes by where an edge of the outline lies in the frame: [u0, u1, v0, v1, top, kind]; the first box
// holding a point just inside the edge wins, the main eaves and brick over stone elsewhere
const WALLS = [
  // the canted bays under the four big gables: one stone storey, a balcony on top
  [-21.7, -14.1, -13, -10.3, GF, KIND.brick], [3.4, 11.0, -13, -10.3, GF, KIND.brick],
  [-21.0, -14.5, 16.1, 19, GF, KIND.brick], [4.1, 10.5, 16.1, 19, GF, KIND.brick],
  // the loggia between the garden front's gables
  [-13.4, 2.7, -10.4, -9.7, EAVE, KIND.loggia],
  // the one-storey gallery from the turret to the service wing
  [35.6, 54.5, 2.9, 9.4, ARCH, KIND.brick],
  // the stone north-west end
  [-31.6, -30.2, -7.0, 14.5, EAVE, KIND.ashlar],
  // the pavilion behind the gate arch and the service wing
  [35.6, 85, -15, 45, WING, KIND.brick]
];

// The canted bays: the box their edges lie in, and the wall behind them that goes on up to the eaves (run so its
// outward side is the bay's)
const BAYS = [
  { box: [-21.7, -14.1, -13, -10.3], wall: [[-21.58, -10.26], [-14.2, -10.06]] },
  { box: [3.4, 11.0, -13, -10.3], wall: [[3.5, -10.07], [10.91, -10.22]] },
  { box: [-21.0, -14.5, 16.1, 19], wall: [[-14.65, 15.91], [-20.88, 15.92]] },
  { box: [4.1, 10.5, 16.1, 19], wall: [[10.39, 16.05], [4.21, 15.97]] }
];

// Roofs over rectangles of the plan (frame metres; heights over the principal floor): the ridge runs along `axis`;
// `ends` gives the start and end of the ridge each a jettied half-timbered gable (G), a plain gable (g), a hip (h) or
// nothing where the roof runs into another one (-); `apex` or `pitch` sets the slope, `maxRise` a flat top on wide
// ones; dormers sit at the given positions along the ridge, on the side given (-1: towards -v, or +u for a roof along
// v; +1 the other side)
const ROOFS = [
  // the garden front's cross-gables, gabled to the garden and to the forecourt
  { u: [-22.8, -14.2], v: [-10.26, 15.95], axis: 'v', eave: EAVE, apex: 16.0, ends: 'GG' },
  { u: [2.6, 12.13], v: [-10.22, 16.0], axis: 'v', eave: EAVE, apex: 16.2, ends: 'GG' },
  // the ranges between them over the garden and the forecourt, a glazed roof-light between
  { u: [-14.2, 2.6], v: [-10.06, 0], axis: 'u', eave: EAVE, pitch: 48, ends: '--', dormers: [-1, -10.05, -5.35, -0.65] },
  { u: [-14.2, 2.6], v: [5.0, 12.96], axis: 'u', eave: EAVE, pitch: 48, ends: '--', dormers: [1, -10.05, -5.35, -0.65] },
  // the north-west wing, the tower rising from its corner
  { u: [-30.6, -22.8], v: [-6.7, 14.0], axis: 'v', eave: EAVE, pitch: 50, ends: 'hh', dormers: [1, 3.0, 9.0] },
  // the lower wing from the garden front to the turret
  { u: [12.13, 31.76], v: [-0.86, 10.73], axis: 'u', eave: EAVE, pitch: 48, ends: '-h', dormers: [-1, 18.2, 24.6] },
  // the pavilion behind the gallery, the link to the service wing
  { u: [35.7, 51.5], v: [9.4, 30.1], axis: 'v', eave: WING, pitch: 50, ends: 'hh', maxRise: 5.0, dormers: [1, 17, 24] },
  { u: [51.5, 59.6], v: [18.4, 33.1], axis: 'u', eave: WING, pitch: 48, ends: '--', maxRise: 4.0 },
  // the service wing round its two light-courts
  { u: [54.65, 72.9], v: [-13.5, -7.2], axis: 'u', eave: WING, pitch: 50, ends: 'hh', dormers: [-1, 58.5, 63.8, 69.1] },
  { u: [54.65, 60.25], v: [-7.2, 12.67], axis: 'v', eave: WING, pitch: 50, ends: '--', dormers: [1, -2.5, 6.0] },
  { u: [67.2, 72.9], v: [-7.2, 12.67], axis: 'v', eave: WING, pitch: 50, ends: '--', dormers: [-1, -2.5, 3.5, 9.5] },
  { u: [60.25, 67.2], v: [2.98, 8.56], axis: 'u', eave: WING, pitch: 50, ends: '--' },
  { u: [54.65, 73.5], v: [12.67, 19.0], axis: 'u', eave: WING, pitch: 50, ends: '-h' },
  { u: [59.5, 69.6], v: [19.0, 33.1], axis: 'v', eave: WING, pitch: 50, ends: '--' },
  { u: [59.5, 81.3], v: [33.1, 42.75], axis: 'u', eave: WING, pitch: 50, ends: 'hh', dormers: [1, 64, 69.5, 75] }
];

// Stone chimney stacks: [u, v, top, long along u] (the photographs; their shadows on the orthophoto)
const CHIMNEYS = [
  [-15.3, -5.0, 17.4, false], [1.3, -5.0, 17.4, false], [-15.3, 9.2, 16.6, false], [1.3, 9.2, 16.6, false],
  [-26.7, 4.5, 15.6, true], [-26.7, 10.4, 15.6, true], [22.5, 4.9, 16.2, true], [28.0, 1.5, 15.6, false],
  [-23.6, -2.2, 20.2, false], // the tall stack at the tower's side
  [58.5, -10.3, 14.9, true], [68.5, -10.3, 14.9, true], [57.45, 1.5, 14.6, false], [70.05, 9.5, 14.6, false],
  [64.55, 26.0, 14.6, false], [66.0, 37.9, 14.8, true], [76.5, 37.9, 14.8, true], [43.6, 22.5, 15.3, false]
];

// The loggia's span along the garden front (u) and its face (v)
const LOGGIA = { u0: -13.21, u1: 2.55, v: -10.06, arches: 5 };

// Brick with stone dressings, read from the `facade` attribute (u along the wall, v over the principal floor, the wall's
// length, finish kind + seed) like js/donostia/buildings.js: the ground floor buff ashlar, orange-red brick above with
// quoins, string courses at every floor and stone window surrounds; windows in bays of about 2.6 m, behind brown louvred
// shutters or with stone mullions and transoms, lit at dusk and night. Kinds: a loggia's shadowed back with its doors,
// all-ashlar walls, blank walls (chimneys, parapets, the gables' backs: v = 99), the tower's narrow windows.
function createBrickMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.userData.attributes = { facade: 4 };
  const f = attribute('facade', 'vec4');
  const u = f.x, v = f.y, len = f.z;
  const kind = floor(f.w), seed = fract(f.w);
  const is = (k) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const loggia = is(KIND.loggia), ashlar = is(KIND.ashlar), blank = is(KIND.blank), tower = is(KIND.tower);
  const ground = step(v, GF);

  // storeys of STOREY over the ground floor; tt = height within the storey (the ground floor's from the floor)
  const above = v.sub(GF).max(0.0);
  const storey = floor(above.div(STOREY));
  const tt = mix(above.sub(storey.mul(STOREY)), v, ground);
  // bays of about 2.6 m with a window on each axis (the tower's faces one narrow window); the loggia's doors
  const bays = max(floor(len.div(2.6).add(0.5)), 1.0);
  const bw = len.div(bays);
  const bayU = u.div(bw);
  const d = abs(fract(bayU).sub(0.5)).mul(bw);
  const lg = loggia.mul(ground);
  const W = mix(mix(float(0.6), float(0.38), tower), float(0.72), lg);
  const sill = mix(mix(float(0.75), float(0.95), ground), float(0.0), lg);
  const head = mix(mix(float(3.1), float(3.7), ground), float(3.4), lg);
  const valid = step(1.6, len).mul(blank.oneMinus()).mul(step(v, 60.0));
  const edge = (a, b, x) => smoothstep(a, b, x);
  const win = edge(W.add(0.02), W.sub(0.02), d).mul(edge(sill.sub(0.02), sill.add(0.02), tt))
    .mul(edge(head.add(0.02), head.sub(0.02), tt)).mul(valid);
  const surround = edge(W.add(0.2), W.add(0.17), d).mul(edge(sill.sub(0.2), sill.sub(0.17), tt))
    .mul(edge(head.add(0.26), head.add(0.23), tt)).mul(valid).mul(ground.oneMinus()).sub(win).max(0.0);

  // in a window: a dark oak frame, then glass with a stone mullion & transom (upper floors) or brown louvres
  const wy = tt.sub(sill).div(head.sub(sill)), wx = d.div(W);
  const cell = vec2(floor(bayU), storey.add(ground.mul(7.0))).add(seed.mul(57.3));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const shut = step(h, 0.4).mul(lg.oneMinus());
  const frame = max(step(0.9, wx), max(step(wy, 0.035), step(0.965, wy)));
  const bars = max(step(wx, 0.07), smoothstep(0.03, 0.015, abs(wy.sub(0.7)))).mul(ground.oneMinus());
  const louvreY = tt.div(0.09);
  const louvre = mix(float(0.72), float(1.0), smoothstep(0.35, 0.65, fract(louvreY))).mul(smoothstep(0.6, 0.2, fwidth(louvreY)))
    .add(smoothstep(0.2, 0.6, fwidth(louvreY)).mul(0.86));
  const oak = vec3(...OAK);
  const stone = vec3(DRESSING.r, DRESSING.g, DRESSING.b).mul(float(0.95).add(mx_noise_float(positionWorld.mul(1.3)).mul(0.05)));
  const glass = vec3(0.05, 0.065, 0.08);
  const pane = mix(mix(glass, stone, bars), vec3(...SHUTTER).mul(louvre), shut);
  const windowCol = mix(pane, oak, frame);

  // stone: the ground floor (a darker plinth), all of an ashlar wall, quoins, string courses at each floor & sills
  const quoinW = mix(float(0.32), float(0.6), step(0.5, fract(v.div(0.6))));
  const quoin = clamp(step(u, quoinW).add(step(len.sub(quoinW), u)), 0.0, 1.0).mul(step(2.0, len));
  const course = step(tt, 0.16).add(step(0.62, tt).mul(step(tt, 0.75))).mul(ground.oneMinus())
    .add(smoothstep(GF - 0.32, GF - 0.28, v).mul(ground));
  const dressing = clamp(ground.add(ashlar).add(quoin).add(course).add(surround), 0.0, 1.0).mul(step(v, 60.0));
  // ashlar courses of 0.48 m, head joints staggered, settling to the stone's tone before they shrink to a pixel
  const gy = v.div(0.48), gx = u.div(0.95).add(floor(gy).mul(0.5));
  const fwj = max(fwidth(gy), fwidth(gx)).max(0.0005);
  const jw = min(fwj, 0.04);
  const joint = max(smoothstep(jw.add(0.44), 0.5, abs(fract(gy).sub(0.5))), smoothstep(jw.add(0.46), 0.5, abs(fract(gx).sub(0.5))))
    .mul(smoothstep(0.12, 0.04, fwj));
  const plinth = mix(float(0.8), float(1.0), step(0.4, v));
  const ashlarCol = stone.mul(float(1.0).sub(joint.mul(0.28))).mul(plinth);
  // brick: a tone varying course by course and across the wall (no mortar lines: they would only shimmer)
  const tone = float(0.92).add(mx_noise_float(positionWorld.mul(vec3(1.7, 12.0, 1.7))).mul(0.07))
    .add(mx_noise_float(positionWorld.mul(0.15)).mul(0.05));
  const brick = vec3(BRICK.r, BRICK.g, BRICK.b).mul(tone);
  // the loggia's back in shadow
  const wall = mix(mix(brick, ashlarCol, dressing), ashlarCol.mul(0.32), lg);
  mat.colorNode = Fn(() => mix(wall, windowCol, win))();
  const glassy = win.mul(shut.oneMinus()).mul(frame.oneMinus()).mul(bars.oneMinus());
  mat.roughnessNode = mix(float(0.86), float(0.15), glassy);
  mat.metalnessNode = mix(float(0.0), float(0.3), glassy);

  // lit rooms at dusk & night: a per-window draw against the preset's interior glow (none by day)
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const lit = step(fract(h.mul(7.31)), night.mul(0.55)).mul(glassy);
  const warm = select(h.lessThan(0.55), vec3(1.0, 0.82, 0.6), vec3(1.0, 0.7, 0.4));
  mat.emissiveNode = warm.mul(lit).mul(night).mul(1.9);
  return mat;
}

// Brown-red plain clay tiles: courses every 0.3 m up the slope (horizontal in the world), each tile a little different
function createTileMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const yc = positionWorld.y.div(0.3);
  const fw = fwidth(yc).max(0.001);
  const course = smoothstep(fw, float(0).sub(fw), fract(yc).sub(0.12)).mul(smoothstep(0.5, 0.2, fw));
  const tone = mx_noise_float(positionWorld.mul(vec3(2.2, 3.3, 2.2))).mul(0.07).add(mx_noise_float(positionWorld.mul(0.2)).mul(0.06)).add(1.0);
  mat.colorNode = vec3(0.15, 0.075, 0.056).mul(tone).mul(float(1).sub(course.mul(0.3)));
  return mat;
}

// Drops the outline's centimetre jogs and collinear points; returns the ring wound so edge normals (dz, -dx) point out
// (or in, for a light-court)
function cleanRing(ring, out = true) {
  let pts = [];
  for (let k = 0; k < ring.length; k += 2) {
    const p = [ring[k], ring[k + 1]];
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.35) pts.push(p);
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.35) pts.pop();
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const lab = Math.hypot(b[0] - a[0], b[1] - a[1]), lbc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (Math.abs(cross) < 0.06 * lab * lbc) { pts.splice(i, 1); changed = true; break; }
    }
  }
  const flat = pts.flat();
  if (ringArea(flat) > 0 === out) return flat;
  const rev = [];
  for (let k = flat.length - 2; k >= 0; k -= 2) rev.push(flat[k], flat[k + 1]);
  return rev;
}

// Wall quads with the `facade` attribute (u along the wall, height over `base`, the wall's length, kind + seed)
class Walls {
  constructor() { this.pos = []; this.nrm = []; this.fac = []; }

  // from (ax, az) to (bx, bz), outward to the right of travel (normal (dz, -dx)), between y0 and y1
  quad(ax, az, bx, bz, y0, y1, base, kind, seed) {
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05 || y1 <= y0) return;
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const w = kind + (((seed % 1) + 1) % 1) * 0.98;
    const v = [[ax, y0, az, 0], [bx, y0, bz, len], [bx, y1, bz, len], [ax, y1, az, 0]];
    for (const k of [0, 2, 1, 0, 3, 2]) {
      const [x, y, z, s] = v[k];
      this.pos.push(x, y, z);
      this.nrm.push(nx, 0, nz);
      this.fac.push(s, y - base, len, w);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('facade', new THREE.Float32BufferAttribute(this.fac, 4));
    return g;
  }
}

// Flat polygons [[x, y, z], ...] fanned into triangles, each turned to face `out` (a direction)
class Polys {
  constructor() { this.pos = []; this.nrm = []; }

  add(pts, out) {
    let n = newell(pts);
    if (!n) return;
    if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] < 0) {
      pts = [...pts].reverse();
      n = n.map((c) => -c);
    }
    for (let k = 1; k + 1 < pts.length; k++) {
      for (const p of [pts[0], pts[k], pts[k + 1]]) { this.pos.push(p[0], p[1], p[2]); this.nrm.push(n[0], n[1], n[2]); }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    return g;
  }
}

// The outline of a pointed arch of span w springing at height ys from x = xl: two arcs of radius k·w, as [x, y] points
// from the left springing over the apex to the right one
function pointedArch(xl, w, ys, k = 0.8, n = 7) {
  const rho = k * w, xr = xl + w, th = Math.acos((rho - w / 2) / rho);
  const pts = [[xl, ys]];
  for (let i = 1; i <= n; i++) { const a = Math.PI - (th * i) / n; pts.push([xl + rho + rho * Math.cos(a), ys + rho * Math.sin(a)]); }
  for (let i = n - 1; i >= 0; i--) { const a = (th * i) / n; pts.push([xr - rho + rho * Math.cos(a), ys + rho * Math.sin(a)]); }
  return pts;
}

// A shape in a wall's plane, [s along the wall, y] points (holes likewise), extruded `depth` out of the wall: a wall
// running along +u facing -v gets s = u; the geometry comes back in the frame with its back on v = v0
function wallShape(outer, holes, depth, v0) {
  const shape = new THREE.Shape(outer.map(([s, y]) => new THREE.Vector2(-s, y)));
  for (const h of holes) shape.holes.push(new THREE.Path(h.map(([s, y]) => new THREE.Vector2(-s, y))));
  const g = depth > 0 ? new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 }) : new THREE.ShapeGeometry(shape);
  // the shape was drawn mirrored (x = -u) so a half turn brings it round to face -v
  return g.rotateY(Math.PI).translate(0, 0, v0);
}

export function build(sites, ctx) {
  const site = sites[0];
  const { kit, GEO } = ctx;
  const rec = GEO.buildings[site?.buildings?.[0]];
  if (!rec?.g?.[0]) return null;
  const outer = cleanRing(rec.g[0]);
  const courts = rec.g.slice(1).map((r) => cleanRing(r, false));
  const g0 = kit.lowestGround(ctx, outer);
  const base = rec.ground > g0 - 1 && rec.ground < g0 + 6 ? rec.ground : g0 + 1;
  const fr = new Frame(FRAME.x, FRAME.z, FRAME.angle);
  const M0 = fr.matrix.clone().multiply(new THREE.Matrix4().makeTranslation(0, base, 0));
  const below = g0 - 0.8 - base; // the walls' foot under the principal floor

  const brick = createBrickMaterial();
  const tile = createTileMaterial();
  const glass = kit.materials.glass;
  const bin = new PartBin();
  // a piece modelled in the frame (u, y over the principal floor, v)
  const put = (mat, geo, color = null, extra = null) => bin.add(mat, geo.applyMatrix4(M0), color, extra);
  const world = (u, v) => fr.world(u, v);

  // --- walls: the outline, each edge to its part's top; the bays' first floor; the tower and the stone tower --------
  const walls = new Walls();
  const wallTop = (u, v) => {
    for (const [u0, u1, v0, v1, top, kind] of WALLS) if (u >= u0 && u <= u1 && v >= v0 && v <= v1) return [top, kind];
    return [EAVE, KIND.brick];
  };
  const bayEdges = BAYS.map(() => []);
  const ringWalls = (ring, seed) => {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
      const len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const nx = (bz - az) / len, nz = -(bx - ax) / len;
      const [mu, mv] = fr.local((ax + bx) / 2 - nx * 0.3, (az + bz) / 2 - nz * 0.3);
      if (Math.hypot(mu - TURRET.u, mv - TURRET.v) < TURRET.apothem + 0.6) continue; // the turret's own walls stand there
      const [top, kind] = wallTop(mu, mv);
      walls.quad(ax, az, bx, bz, g0 - 0.8, base + top, base, kind, seed + i * 0.137);
      const bay = BAYS.findIndex(({ box: [u0, u1, v0, v1] }) => mu >= u0 && mu <= u1 && mv >= v0 && mv <= v1);
      if (bay >= 0) bayEdges[bay].push([fr.local(ax, az), fr.local(bx, bz)]);
    }
  };
  ringWalls(outer, 0.31);
  courts.forEach((r, k) => ringWalls(r, 0.53 + k * 0.21));
  for (const { wall: [a, b] } of BAYS) walls.quad(...world(...a), ...world(...b), base + GF, base + EAVE, base, KIND.brick, 0.71);
  // the tower (brick) and the turret (stone), all eight faces: the turret's from the foot, the tower's from its base,
  // the north-west wing's square corner, up
  const R = TOWER.apothem / Math.cos(Math.PI / 8);
  for (const [o, kind, seed, y0] of [[TOWER, KIND.tower, 0.77, base + EAVE - 0.5], [TURRET, KIND.ashlar, 0.17, g0 - 0.8]]) {
    const octagon = [];
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      octagon.push(...world(o.u + R * Math.cos(a), o.v + R * Math.sin(a)));
    }
    const ring = cleanRing(octagon);
    for (let i = 0, n = ring.length / 2; i < n; i++) {
      const j = (i + 1) % n;
      walls.quad(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], y0, base + o.top, base, kind, seed + i * 0.11);
    }
  }
  // the gate arch's wing at the north-west end (OSM's outline; the 1:500 building stops short of it): its garden,
  // north-west and forecourt faces (the fourth backs onto the north-west wing)
  {
    const { u0, u1, v0, v1 } = GATE;
    const foot = kit.lowestGround(ctx, [...world(u0, v0), ...world(u1, v0), ...world(u1, v1), ...world(u0, v1)]) - 0.6;
    for (const [a, b] of [[[u0, v0], [u1, v0]], [[u0, v1], [u0, v0]], [[u1, v1], [u0, v1]]]) {
      walls.quad(...world(...a), ...world(...b), foot, base + ARCH, base, KIND.blank, 0.41);
    }
  }
  // the gable walls over the pavilion's front, above the gate arch's wing
  walls.quad(...world(35.7, 9.4), ...world(51.5, 9.4), base + ARCH - 0.2, base + WING, base, KIND.blank, 0.2);
  bin.add(brick, walls.geometry());

  // --- flat roofs at each part's eaves under the pitched ones: lead where they show (the roof-light, the arch wing) -
  {
    const uv = [];
    for (let k = 0; k < outer.length; k += 2) uv.push(...fr.local(outer[k], outer[k + 1]));
    const courtsUV = courts.map((r) => {
      const o = [];
      for (let k = 0; k < r.length; k += 2) o.push(...fr.local(r[k], r[k + 1]));
      return o;
    });
    const decks = [[-45, 35.7, -30, 60, EAVE], [35.7, 54.6, -30, 9.4, ARCH], [35.7, 54.6, 9.4, 60, WING], [54.6, 90, -30, 60, WING]];
    for (const [u0, u1, v0, v1, y] of decks) {
      let r = uv;
      for (const [a, b, c] of [[1, 0, -u0], [-1, 0, u1], [0, 1, -v0], [0, -1, v1]]) r = r && clipRing(r, a, b, c);
      if (!r) continue;
      const shape = new THREE.Shape();
      for (let k = 0; k < r.length; k += 2) (k ? shape.lineTo : shape.moveTo).call(shape, r[k], -r[k + 1]);
      for (const c of courtsUV) {
        if (c[0] < u0 || c[0] > u1) continue;
        const p = new THREE.Path();
        for (let k = 0; k < c.length; k += 2) (k ? p.lineTo : p.moveTo).call(p, c[k], -c[k + 1]);
        shape.holes.push(p);
      }
      put(M.paint, new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2).translate(0, y + 0.04, 0), LEAD);
    }
  }

  // --- roofs ----------------------------------------------------------------------------------------------------------
  const tiles = new Polys(), oakFaces = new Polys(), render = new Polys(), caps = new Polys();
  for (const spec of ROOFS) {
    const r = roofOver(spec, { tiles, oak: oakFaces, caps });
    for (const [k, e] of [...spec.ends].entries()) if (e === 'G') timberGable(r, k ? 1 : -1, { put, render, tiles, tile });
    if (spec.dormers) {
      const [side, ...at] = spec.dormers;
      for (const x of at) dormer(r, x, side, { put, render, tiles, oak: oakFaces, glass });
    }
  }
  put(tile, tiles.geometry());
  put(M.paint, oakFaces.geometry(), OAK);
  put(M.paint, render.geometry(), RENDER);
  put(brick, caps.geometry(), null, NO_WINDOWS);

  // the roof-light between the garden front's ranges
  put(glass, new THREE.BoxGeometry(13.6, 0.9, 3.4).translate(-5.8, EAVE + 0.45, 2.5));
  put(M.paint, new THREE.BoxGeometry(13.8, 0.12, 3.6).translate(-5.8, EAVE + 0.95, 2.5), WHITE);

  // --- chimneys: buff stone stacks with a moulded cap -----------------------------------------------------------------
  for (const [u, v, top, alongU] of CHIMNEYS) {
    const [a, b] = alongU ? [1.75, 0.95] : [0.95, 1.75];
    const y0 = (u > 35 ? WING : EAVE) - 0.5;
    put(M.stone, new THREE.BoxGeometry(a, top - y0, b).translate(u, (y0 + top) / 2, v), STONE);
    put(M.stone, new THREE.BoxGeometry(a + 0.22, 0.18, b + 0.22).translate(u, top - 0.75, v), STONE);
    put(M.stone, new THREE.BoxGeometry(a + 0.3, 0.3, b + 0.3).translate(u, top + 0.1, v), STONE);
    for (const s of [-0.3, 0.3]) {
      put(M.paint, new THREE.CylinderGeometry(0.13, 0.15, 0.55, 8).translate(u + (alongU ? s * 1.6 : 0), top + 0.5, v + (alongU ? 0 : s * 1.6)), rgb(0x8c5a40));
    }
  }

  // --- the loggia: five pointed arches in a stone screen before the garden front's ground floor -------------------------
  {
    const { u0, u1, v, arches } = LOGGIA;
    const bayW = (u1 - u0) / arches, pier = 0.36;
    const holes = [];
    for (let k = 0; k < arches; k++) {
      const xl = u0 + k * bayW + pier, w = bayW - 2 * pier;
      holes.push([[xl, 0], ...pointedArch(xl, w, 2.25, 0.8), [xl + w, 0]]);
    }
    const outerS = [[u0 - 0.2, below], [u1 + 0.2, below], [u1 + 0.2, GF - 0.3], [u0 - 0.2, GF - 0.3]];
    put(M.stone, wallShape(outerS, holes, 0.45, v - 0.02), STONE);
    // the piers' bases and the steps up into the loggia
    put(M.stone, new THREE.BoxGeometry(u1 - u0 + 0.4, 0.3, 1.0).translate((u0 + u1) / 2, -0.15, v - 0.9), STONE);
  }

  // --- the canted bays' balconies: a stone slab over the bay, a balustrade along its edges ------------------------------
  bayEdges.forEach((edges, k) => {
    if (!edges.length) return;
    const [a, b] = BAYS[k].wall;
    // the slab: the bay's outline closed along the wall behind it
    const shape = new THREE.Shape([new THREE.Vector2(a[0], -a[1]), new THREE.Vector2(b[0], -b[1])]);
    const chain = edges.map(([p]) => p).concat([edges[edges.length - 1][1]]);
    chain.sort((p, q) => Math.hypot(p[0] - b[0], p[1] - b[1]) - Math.hypot(q[0] - b[0], q[1] - b[1]));
    for (const p of chain) shape.lineTo(p[0], -p[1]);
    put(M.stone, new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, GF - 0.06, 0), STONE);
    for (const [p, q] of edges) {
      const du = q[0] - p[0], dv = q[1] - p[1], len = Math.hypot(du, dv);
      if (len < 0.3) continue;
      const nu = dv / len, nv = -du / len; // outward
      const P = (t, y) => [p[0] + du * t - nu * 0.14, y, p[1] + dv * t - nv * 0.14];
      put(M.stone, strut(P(0, GF + 0.3), P(1, GF + 0.3), 0.26, 0.12), STONE);
      put(M.stone, strut(P(0, GF + 1.0), P(1, GF + 1.0), 0.3, 0.12), STONE);
      const n = Math.max(1, Math.round(len / 0.3));
      for (let i = 0; i < n; i++) {
        const [x, , z] = P((i + 0.5) / n, 0);
        put(M.stone, new THREE.CylinderGeometry(0.06, 0.08, 0.6, 6).translate(x, GF + 0.65, z), STONE);
      }
    }
  });

  // --- the tower's top: a stone cornice, the belvedere, the octagonal tiled roof, its dormers and finial ---------------
  // (an 8-sided cylinder turned onto the octagons' corners, its radius theirs)
  const octAt = (o) => (rTop, rBottom, y0, y1) => new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, 8).rotateY(-Math.PI / 8).translate(o.u, (y0 + y1) / 2, o.v);
  {
    const T = TOWER, top = T.top, oct = octAt(T);
    put(M.stone, oct(R + 0.3, R + 0.18, EAVE - 0.3, EAVE + 0.12), STONE); // where the octagon leaves the square base
    put(M.stone, oct(R + 0.28, R + 0.06, top - 0.12, top + 0.3), STONE);
    put(M.paint, oct(R * 0.97, R * 0.97, top + 0.3, top + 2.55), WHITE);
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4; // a face's normal (the corners sit at odd multiples of pi / 8)
      const dist = T.apothem * 0.97 + 0.02;
      const cu = T.u + Math.cos(a) * dist, cv = T.v + Math.sin(a) * dist;
      for (const off of [-0.58, 0.58]) {
        const g = new THREE.BoxGeometry(0.06, 1.45, 0.92).rotateY(-a);
        put(glass, g.translate(cu - Math.sin(a) * off, top + 1.55, cv + Math.cos(a) * off));
      }
      // the dark posts at the corners
      const ca = a + Math.PI / 8;
      put(M.paint, new THREE.BoxGeometry(0.2, 2.25, 0.2).rotateY(-ca).translate(T.u + Math.cos(ca) * R * 0.97, top + 1.43, T.v + Math.sin(ca) * R * 0.97), OAK);
    }
    put(M.paint, oct(R + 0.16, R + 0.04, top + 2.55, top + 2.85), OAK);
    put(tile, oct(R + 0.28, R + 0.78, top + 2.85, top + 3.3));
    put(tile, oct(0.12, R + 0.28, top + 3.3, top + 7.2));
    // four little dormers on the roof's axis faces
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2, rr = 2.55;
      const cu = T.u + Math.cos(a) * rr, cv = T.v + Math.sin(a) * rr;
      put(M.paint, new THREE.BoxGeometry(0.8, 1.0, 0.8).rotateY(-a).translate(cu, top + 4.3, cv), WHITE);
      put(tile, new THREE.ConeGeometry(0.62, 0.65, 4).rotateY(Math.PI / 4 - a).translate(cu, top + 5.1, cv));
    }
    put(M.metal, new THREE.CylinderGeometry(0.05, 0.08, 3.4, 6).translate(T.u, top + 8.8, T.v), IRON);
    put(M.metal, new THREE.SphereGeometry(0.22, 8, 6).translate(T.u, top + 7.75, T.v), IRON);
  }

  // --- the turret's top: a stone cornice, a steep octagonal pyramid of tiles, a weathervane ----------------------------
  {
    const T = TURRET, top = T.top, oct = octAt(T);
    put(M.stone, oct(R + 0.3, R + 0.06, top - 0.15, top + 0.35), STONE);
    put(tile, oct(R + 0.4, R + 0.62, top + 0.35, top + 0.6));
    put(tile, oct(0.1, R + 0.4, top + 0.6, top + 5.8));
    put(M.metal, new THREE.CylinderGeometry(0.05, 0.05, 2.6, 6).translate(T.u, top + 6.9, T.v), IRON);
    put(M.metal, new THREE.BoxGeometry(1.3, 0.05, 0.05).translate(T.u, top + 7.4, T.v), IRON);
    put(M.metal, new THREE.BoxGeometry(0.05, 0.05, 1.3).translate(T.u, top + 7.4, T.v), IRON);
    put(M.metal, new THREE.BoxGeometry(1.0, 0.35, 0.03).translate(T.u + 0.2, top + 7.9, T.v), IRON);
  }

  // --- the gate arch's wing: a pointed arch through it in a stone surround, a parapet with a shield, chequered quoins -
  {
    const { u0, u1, v0, v1, u, span, spring } = GATE;
    const xl = u - span / 2;
    const open = [[xl, 0], ...pointedArch(xl, span, spring, 0.7), [xl + span, 0]];
    const ring = [[xl - 0.45, 0], ...pointedArch(xl - 0.45, span + 0.9, spring, 0.7 * span / (span + 0.9) + 0.06), [xl + span + 0.45, 0]];
    // the arch on the garden face, and the same on the forecourt face (a half turn about the wing's middle)
    const turn = new THREE.Matrix4().makeTranslation(2 * u, 0, v0 + v1).multiply(new THREE.Matrix4().makeRotationY(Math.PI));
    for (const m of [null, turn]) {
      const g1 = wallShape(open, [], 0, v0 - 0.03), g2 = wallShape(ring, [open], 0.2, v0 - 0.03);
      if (m) { g1.applyMatrix4(m); g2.applyMatrix4(m); }
      put(M.paint, g1, DARK);
      put(M.stone, g2, STONE);
    }
    // the passage's vault, dark
    put(M.paint, new THREE.BoxGeometry(span, 0.1, v1 - v0).translate(u, spring + 1.9, (v0 + v1) / 2), DARK);
    // the flat roof, the parapet round the outer faces, its coping, the shield over the arch
    put(M.paint, new THREE.BoxGeometry(u1 - u0, 0.1, v1 - v0).translate((u0 + u1) / 2, ARCH, (v0 + v1) / 2), LEAD);
    const para = (a, b) => {
      put(brick, strut([a[0], ARCH + 0.42, a[1]], [b[0], ARCH + 0.42, b[1]], 0.35, 0.85), null, NO_WINDOWS);
      put(M.stone, strut([a[0], ARCH + 0.92, a[1]], [b[0], ARCH + 0.92, b[1]], 0.5, 0.16), STONE);
      put(M.stone, strut([a[0], ARCH - 0.05, a[1]], [b[0], ARCH - 0.05, b[1]], 0.48, 0.2), STONE);
    };
    para([u0 + 0.1, v0 + 0.15], [u1, v0 + 0.15]);
    para([u0 + 0.15, v1], [u0 + 0.15, v0]);
    para([u1, v1 - 0.15], [u0 + 0.1, v1 - 0.15]);
    put(M.stone, new THREE.BoxGeometry(1.2, 1.5, 0.22).translate(u, ARCH + 0.05, v0 - 0.08), STONE);
    // chequered stone quoins up the wing's outer corners
    for (const [qu, qv] of [[u0, v0], [u0, v1]]) {
      for (let k = 0, y = 0; y < ARCH - 0.3; k++, y += 0.42) {
        const big = k % 2 === 0;
        put(M.stone, new THREE.BoxGeometry(big ? 0.75 : 0.45, 0.4, big ? 0.45 : 0.75).translate(qu + (big ? 0.3 : 0.15), y + 0.2, qv + (qv === v0 ? 1 : -1) * (big ? 0.15 : 0.3)), STONE);
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'Miramar';
  bin.build(group);
  return group;
}

// A roof over a rectangle of ROOFS, built in its own frame (x along the ridge, y over the principal floor, z across),
// emitted into the palace's frame: the tiled slab (slopes, hips and any flat top, with their undersides), the dark fascia
// and verges, and brick end walls under plain gables and open ends. Returns the roof's frame for gables and dormers.
function roofOver(spec, out) {
  const { axis = 'u', eave, ends = 'hh', over = 0.55 } = spec;
  const along = axis === 'u';
  const [a0, a1] = along ? spec.u : spec.v;
  const [b0, b1] = along ? spec.v : [-spec.u[1], -spec.u[0]];
  // roof frame -> palace frame: (x, y, z) -> (u, y, v); along v the ridge's x is v and z is -u (a quarter turn)
  const map = along ? (p) => p : ([x, y, z]) => [-z, y, x];
  const matrix = along ? new THREE.Matrix4() : new THREE.Matrix4().makeRotationY(-Math.PI / 2);
  const hw = (b1 - b0) / 2, zc = (b0 + b1) / 2;
  const tanp = spec.apex ? (spec.apex - eave) / hw : Math.tan(deg(spec.pitch));
  const rise = Math.min(hw * tanp, spec.maxRise ?? Infinity);
  const top = eave + rise, run = rise / tanp, zt = Math.max(0, hw - run);
  const endOver = { G: 1.0, g: 0.45, h: over, '-': 0 };
  const xE0 = a0 - endOver[ends[0]], xE1 = a1 + endOver[ends[1]];
  const yE = eave - over * tanp, zE = hw + over, runE = run + over;
  let xt0 = ends[0] === 'h' ? xE0 + runE : xE0, xt1 = ends[1] === 'h' ? xE1 - runE : xE1;
  if (xt0 > xt1) xt0 = xt1 = (xt0 + xt1) / 2;
  const TH = 0.2;
  const face = (coll, pts, dir) => coll.add(pts.map(map), map(dir));
  const slab = (pts, dir) => {
    face(out.tiles, pts, dir);
    face(out.tiles, pts.map(([x, y, z]) => [x, y - TH, z]), dir.map((c) => -c));
  };
  slab([[xE0, yE, zc + zE], [xE1, yE, zc + zE], [xt1, top, zc + zt], [xt0, top, zc + zt]], [0, 1, 1]);
  slab([[xE0, yE, zc - zE], [xE1, yE, zc - zE], [xt1, top, zc - zt], [xt0, top, zc - zt]], [0, 1, -1]);
  if (zt > 0.05) slab([[xt0, top, zc - zt], [xt1, top, zc - zt], [xt1, top, zc + zt], [xt0, top, zc + zt]], [0, 1, 0]);
  const drop = (p) => [p[0], p[1] - TH, p[2]];
  const fascia = (p, q, dir) => face(out.oak, [p, q, drop(q), drop(p)], dir);
  for (const s of [-1, 1]) fascia([xE0, yE, zc + s * zE], [xE1, yE, zc + s * zE], [0, 0, s]);
  for (const [k, e] of [...ends].entries()) {
    const s = k ? 1 : -1, xE = k ? xE1 : xE0, xt = k ? xt1 : xt0, a = k ? a1 : a0;
    if (e === 'h') {
      slab([[xE, yE, zc - zE], [xE, yE, zc + zE], [xt, top, zc + zt], [xt, top, zc - zt]], [s, 1, 0]);
      fascia([xE, yE, zc - zE], [xE, yE, zc + zE], [s, 0, 0]);
      continue;
    }
    // verges: the slab's sloping edges (and a flat top's) at a gable or open end
    for (const z of [-1, 1]) fascia([xE, yE, zc + z * zE], [xE, top, zc + z * zt], [s, 0, 0]);
    if (zt > 0.05) fascia([xE, top, zc - zt], [xE, top, zc + zt], [s, 0, 0]);
    // the end wall under a plain gable or an open end (a jettied gable stands proud of the wall instead)
    if (e !== 'G') {
      const pts = [[a, eave, zc - hw], [a, eave, zc + hw], [a, top, zc + zt], [a, top, zc - zt]];
      face(out.caps, zt > 0.05 ? pts : [pts[0], pts[1], pts[2]], [s, 0, 0]);
    }
  }
  return { map, matrix, a0, a1, xE0, xE1, zc, hw, zE, eave, top, yE, tanp, zt };
}

// A jettied, half-timbered gable on a roof's end (s: -1 at the ridge's start, +1 at its end), its face half a metre out
// over the wall below, dark oak on white render as the photographs show it: over the sill beam a band of brown louvred
// windows between posts; over the next beam a two-light window between two wheels (a cross in a ring); over the collar
// close studding up to the verges; broad barge boards and a finial at the roof's verge; a tiled hood over the jetty
function timberGable(r, s, out) {
  const { map, matrix, zc, hw, eave, top, tanp } = r;
  const a = s > 0 ? r.a1 : r.a0, xE = s > 0 ? r.xE1 : r.xE0;
  const x = a + s * 0.5, y0 = eave + 0.18;
  const half = (y) => Math.max(0, hw - (y - eave) / tanp - 0.04); // the gable's half-width at height y, under the roof
  const apex = top - 0.08;
  out.render.add([[x, y0, zc - half(y0)], [x, y0, zc + half(y0)], [x, apex, zc]].map(map), map([s, 0, 0]));
  const paint = (geo, col) => out.put(M.paint, geo.applyMatrix4(matrix), col);
  const oak = (geo) => paint(geo, OAK);
  const xf = x + s * 0.045; // the timbers' face, proud of the render
  const beam = (y, h) => oak(new THREE.BoxGeometry(0.09, h, 2 * half(y + h)).translate(xf, y + h / 2, zc));
  const post = (z, ya, yb, w = 0.16) => oak(new THREE.BoxGeometry(0.09, yb - ya, w).translate(xf, (ya + yb) / 2, z));
  const panel = (z, ya, yb, w, col) => paint(new THREE.BoxGeometry(0.05, yb - ya, w).translate(x + s * 0.025, (ya + yb) / 2, z), col);
  beam(y0, 0.24);
  // the band of louvred windows over the sill, posts between them and at its ends
  const w0 = y0 + 0.24, w1 = y0 + 1.6;
  const n = Math.max(1, Math.floor((2 * half(w1) - 0.3) / 1.25));
  const step = (2 * half(w1) - 0.3) / n;
  for (let k = 0; k <= n; k++) post(zc - half(w1) + 0.15 + k * step, w0, w1, 0.18);
  for (let k = 0; k < n; k++) panel(zc - half(w1) + 0.15 + (k + 0.5) * step, w0 + 0.12, w1 - 0.1, step - 0.3, SHUTTER);
  beam(w1, 0.2);
  // a two-light window on the axis between two wheels
  const rw = 0.7, b0 = w1 + 0.2, yc = b0 + rw + 0.08, b1 = yc + rw + 0.08;
  const zw = Math.min(half(yc) * 0.56, half(yc + rw * 0.5) - rw - 0.1);
  if (zw - rw > 0.35) {
    panel(zc, b0 + 0.25, b1 - 0.2, 2 * Math.min(0.55, zw - rw - 0.2), PANE);
    for (const t of [-1, 0, 1]) post(zc + t * Math.min(0.62, zw - rw - 0.12), b0, b1, 0.14);
    for (const t of [-1, 1]) {
      const zz = zc + t * zw;
      oak(new THREE.RingGeometry(rw * 0.76, rw, 20).rotateY(s * Math.PI / 2).translate(xf + s * 0.04, yc, zz));
      for (const q of [0, Math.PI / 2]) oak(new THREE.BoxGeometry(0.09, 2 * rw * 0.92, 0.1).rotateX(q).translate(xf, yc, zz));
      post(zz + t * (rw + 0.12), b0, b1, 0.14);
    }
  }
  if (half(b1 + 0.18) > 0.35) beam(b1, 0.18);
  // close studding up to the verges
  const c0 = b1 + 0.18;
  for (let z = -half(c0) + 0.2; z < half(c0) - 0.1; z += 0.42) {
    const yTop = eave + (hw - Math.abs(z) - 0.04) * tanp - 0.06;
    if (yTop - c0 > 0.25) post(zc + z, c0, Math.min(yTop, apex - 0.05), 0.12);
  }
  // broad barge boards along the verges, a finial at the apex
  const zEave = r.zE, yEave = r.yE;
  for (const t of [-1, 1]) {
    oak(strut([xE - s * 0.05, yEave - 0.18, zc + t * zEave], [xE - s * 0.05, top + 0.05, zc], 0.1, 0.55));
  }
  oak(new THREE.BoxGeometry(0.18, 1.6, 0.18).translate(xE - s * 0.07, top + 0.6, zc));
  paint(new THREE.ConeGeometry(0.17, 0.5, 4).translate(xE - s * 0.07, top + 1.6, zc), OAK);
  // the hood over the jetty, on brackets, from the wall out past the gable's foot
  const len = Math.hypot(0.95, 0.45);
  const hood = new THREE.BoxGeometry(len, 0.12, 2 * hw + 0.5).rotateZ(-s * Math.atan2(0.45, 0.95)).translate(a + s * 0.47, eave - 0.06, zc);
  out.put(out.tile, hood.applyMatrix4(matrix));
  for (const dz of [-hw + 0.3, -hw / 3, hw / 3, hw - 0.3]) oak(new THREE.BoxGeometry(0.75, 0.18, 0.16).translate(a + s * 0.38, eave - 0.45, zc + dz));
}

// A gabled dormer on a roof's slope (side -1 at -z, +1 at +z), its front on the wall's line: render & oak with a
// two-light window, tiled cheeks and roof, barge boards; smaller on narrow roofs
function dormer(r, x, side, out) {
  const { map, matrix, zc, hw, eave, tanp } = r;
  const k = Math.min(1, (r.top - eave) / 4.6);
  const w = 2.0 * k + 0.2, h = 2.1 * k, gr = 0.95 * k;
  const zf = zc + side * (hw - 0.15);
  const yb = eave - 0.1, yt = eave + h, ya = yt + gr;
  const zb = zc + side * Math.max(0.2, hw - (ya + 0.3 - eave) / tanp - 0.3); // back where its ridge meets the slope
  const dir = [0, 0, side];
  const fr = [[x - w / 2, yb, zf], [x + w / 2, yb, zf], [x + w / 2, yt, zf], [x, ya, zf], [x - w / 2, yt, zf]];
  out.render.add(fr.map(map), map(dir));
  out.put(out.glass, new THREE.BoxGeometry(w * 0.6, h * 0.62, 0.06).translate(x, yb + 0.25 + h * 0.31, zf + side * 0.02).applyMatrix4(matrix));
  const oak = (geo) => out.put(M.paint, geo.applyMatrix4(matrix), OAK);
  const zo = zf + side * 0.04;
  for (const e of [-1, 1]) oak(new THREE.BoxGeometry(0.13, h + 0.1, 0.08).translate(x + e * (w / 2 - 0.06), (yb + yt) / 2, zo));
  oak(new THREE.BoxGeometry(w, 0.13, 0.08).translate(x, yt - 0.04, zo));
  oak(new THREE.BoxGeometry(w, 0.13, 0.08).translate(x, yb + 0.2, zo));
  oak(new THREE.BoxGeometry(0.1, gr, 0.08).translate(x, yt + gr / 2, zo));
  // cheeks
  for (const e of [-1, 1]) {
    const xc = x + e * w / 2;
    out.tiles.add([[xc, yb, zf], [xc, yt, zf], [xc, yt, zb], [xc, yb, zb]].map(map), map([e, 0, 0]));
  }
  // its roof: two slopes from the ridge out past the cheeks, a little over the front
  const zr = zf + side * 0.3;
  for (const e of [-1, 1]) {
    const pts = [[x, ya + 0.1, zr], [x + e * (w / 2 + 0.22), yt - 0.12, zr], [x + e * (w / 2 + 0.22), yt - 0.12, zb], [x, ya + 0.1, zb]];
    out.tiles.add(pts.map(map), map([e, 1, 0]));
    out.tiles.add(pts.map(([px, py, pz]) => [px, py - 0.12, pz]).map(map), map([-e, -1, 0]));
    oak(strut([x, ya + 0.1, zr + side * 0.03], [x + e * (w / 2 + 0.22), yt - 0.14, zr + side * 0.03], 0.06, 0.22));
  }
}
