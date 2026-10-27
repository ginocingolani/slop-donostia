import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  attribute, float, vec2, vec3, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot, clamp, length, select,
  fwidth, pow, normalize, positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { CivicModel, offsetRing } from './udaletxea.js';
import { newell } from './geom.js';
import { PaintBuilder, FINISH } from './paint.js';
import { rgb } from './igeldo.js';
import { buildPark } from './aiete-parkea.js';

// js/donostia/landmarks/aiete.js
// Aieteko jauregia / Palacio de Aiete (1878, for the Dukes of Bailén; a summer residence of the royal family and,
// until 1975, of the head of state; today Bake Bidea, the Casa de la Paz y los Derechos Humanos) and its park. This
// file models the palace and holds the small kit its outbuildings share (aiete-parkea.js builds those, the
// Kulturetxea's sunken glass pavilion and the park's features): one facade material whose palettes cover the palace's
// white render, its cream sandstone, the grey limestone plinths and the red & pink outbuildings, and a geometry builder
// on udaletxea.js's CivicModel that writes that material's attributes.
//
// The data: the municipal 1:500 outline (a 35.1 x 16.4 m block turned 5.3° from east, end pavilions a little proud on
// both fronts, a canted bow 6.8 m wide and 1.9 m deep in the middle of the north front; a porch 13.2 m wide with a
// curved stair on the south front, a terrace on the west end and a flight of steps on the east), b5m's 15.3 m mean and
// 17.0 m maximum height, and the 2025 orthophoto («Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi»): two hipped
// mansards with flat tops either side of a taller roof that runs north-south over the bow, three dormers to each wing.
//
// From the photographs (Wikimedia Commons: the garden stair under its marquee, the south front across the pond, the
// north front behind the Kulturetxea, the bow straight on): a raised basement of grey limestone with barred windows,
// two tall storeys and a slate mansard. The north front is all white render: banded rustication on the pavilions'
// corners, a string course at the first floor, a deep modillioned cornice; tall windows with white louvred shutters
// (most closed), scrolled crests over the ground-floor ones, cornices over the first floor's and pediments with iron
// balconies on the pavilions. The bow opens three round-arched French windows on the ground floor behind four
// free-standing columns that carry a canted iron balcony; a short stair between two iron railings drops from it to
// the forecourt. Its roof rises above the mansard with a large arched dormer, flanked by two brick chimneys. The south
// front keeps its end pavilions white but its long centre is cream ashlar sandstone: three round-arched French windows
// on a stone terrace, under an iron-and-glass marquee on slender columns with two lanterns, reached by a curved stair
// between two seated mastiffs on pedestals (the "lions"); iron balconies on the first floor, a continuous one over the
// terrace. Where the photographs disagree on the colour (cream or white), they show different fronts: the north front
// and every pavilion are white, the south front's centre is cream. Heights are scaled from the frontal photograph of
// the bow onto b5m's maximum. No pixels of the photographs are used: every colour is a hand-picked constant.
//
// build(sites, ctx) receives the GEO.landmarks entries ['aiete-jauregia', 'aiete-kulturetxea'] and ctx = { GEO,
// terrain, kit }; the outbuildings it replaces (no OSM outline claims them) are listed in userData.hide.

// ---------------------------------------------------------------------------------------------------------------------
// The facade material
// ---------------------------------------------------------------------------------------------------------------------

// Palettes: [wall, dressing (surrounds, quoins, timber), shutters]; sRGB, picked by eye against the photographs
export const PAL = { white: 0, cream: 1, grey: 2, red: 3, pink: 4, sand: 5, brick: 6 };
const PALETTES = [
  [0xe7e3d8, 0xefece4, 0xecebe5], // the palace's white render, white shutters
  [0xbfa26c, 0xcbb084, 0xecebe5], // the south front's cream sandstone
  [0xa9a79e, 0xb7b5ac, 0x1b1c1e], // grey limestone plinths, stairs and pedestals; iron grilles
  [0xac4436, 0xc8ab7a, 0x2c4838], // the outbuildings' red render, sandstone dressings, green shutters & doors
  [0xc0726c, 0x4c694c, 0x4c694c], // the dovecote's pink boarding and green timbers
  [0xc8ab7a, 0xcfb487, 0x2c4838], // sandstone (string courses, quoins and cornices of the red buildings)
  [0x8e4634, 0xb9b3a6, 0x1b1c1e] // brick chimneys
];

// What the shader opens in a wall (fkind.y): glass only, louvred shutters (a share closed, the rest folded back beside
// the window), an iron grille (basement windows), board doors with a glazed head
export const SH = { glass: 0, louvre: 1, grille: 2, boards: 3 };
// fkind.w flags: ashlar coursing, banded rustication, quoins at the wall's ends, a timber frame (the dovecote), a
// balustrade, brick coursing, floodlit at night; CAP marks horizontal faces (set by the builder)
export const FLAG = { ashlar: 1, rusticated: 2, quoins: 4, timber: 8, balustrade: 16, brick: 32, floodlit: 64, cap: 128 };

let facadeMaterial = null;

// Attributes: facade = (s: metres along the wall, h: metres above the style's base, wall length, seed), fwin = (bay
// target, sill, head, half width: 0 for a blank wall), fkind = (palette, shutters, arch: 0 square / 1 round / 2
// segmental, flags). Openings are signed distances in metres from the bay's centre line, like udaletxea.js's civic
// material; fine lines fade before they shrink to a pixel.
export function aieteFacadeMaterial() {
  if (facadeMaterial) return facadeMaterial;
  const mat = new THREE.MeshStandardNodeMaterial();
  const fa = attribute('facade', 'vec4'), fw = attribute('fwin', 'vec4'), fk = attribute('fkind', 'vec4');
  const s = fa.x, h = fa.y, wallLen = max(fa.z, 0.01), seed = fa.w;
  const bayT = fw.x, sill = fw.y, head = fw.z, halfW = max(fw.w, 0.001);
  const palette = fk.x, shutter = fk.y, arch = fk.z, flags = fk.w;
  const bit = (k) => step(0.5, fract(flags.add(0.5).div(2 * k)));
  const isShut = (k) => step(k - 0.5, shutter).mul(step(shutter, k + 0.5));
  const fCap = bit(FLAG.cap), notCap = float(1).sub(fCap);

  const pix = max(max(fwidth(s), fwidth(h)), 0.0005);
  const lineAA = (dist, w) => float(1).sub(smoothstep(w, pix.add(w), dist));
  const fine = (w) => float(1).sub(smoothstep(w, w * 4, pix)); // fades detail of width w with distance

  // Palette colours
  const pick = (k) => {
    const cols = PALETTES.map((p) => { const c = new THREE.Color(p[k]); return vec3(c.r, c.g, c.b); });
    let c = cols[0];
    for (let i = 1; i < cols.length; i++) c = select(palette.greaterThan(i - 0.5), cols[i], c);
    return c;
  };
  const wallCol = pick(0), dressCol = pick(1), shutCol = pick(2);

  // Bays: whole bays per wall, px = metres from the bay's centre line
  const hasWin = step(0.05, bayT).mul(step(0.01, fw.w)).mul(notCap);
  const bays = max(floor(wallLen.div(max(bayT, 0.05)).add(0.5)), 1.0);
  const bayW = wallLen.div(bays);
  const bayIdx = floor(s.div(bayW));
  const px = fract(s.div(bayW)).sub(0.5).mul(bayW);
  const dx = abs(px);
  const room = step(halfW.mul(2.0).add(0.2), bayW); // a window needs its bay
  const winOn = hasWin.mul(room);

  // The opening: square-headed, round-arched or segmental (rise 0.45 of the half width)
  const isArch = step(0.5, arch), isSeg = step(1.5, arch);
  const rise = mix(halfW, halfW.mul(0.45), isSeg);
  const R = halfW.mul(halfW).add(rise.mul(rise)).div(rise.mul(2.0));
  const cy = head.sub(R);
  const dArc = R.sub(length(vec2(dx, max(h.sub(cy), 0.0))));
  const dTop = mix(head.sub(h), dArc, isArch);
  const d = min(min(halfW.sub(dx), h.sub(sill)), dTop);
  const aa = max(fwidth(d), 0.004);
  const opening = smoothstep(aa.negate(), aa, d).mul(winOn);
  // moulded surround, 15 cm, with a thin shadow line round its outer edge
  const surround = smoothstep(-0.17, -0.15, d).mul(float(1).sub(opening)).mul(winOn);
  const surroundEdge = lineAA(abs(d.add(0.16)), 0.012).mul(winOn).mul(fine(0.012));
  const springY = head.sub(rise.mul(isArch));

  // Shutters: a room's (bay, storey, wall) draw decides closed or open; open ones fold back flat beside the window
  const storeyKey = floor(sill.mul(0.7));
  const hw = fract(sin(dot(vec2(bayIdx.add(seed.mul(0.137)), storeyKey.add(seed.mul(0.71))), vec2(12.9898, 78.233))).mul(43758.5453));
  const louvre = isShut(SH.louvre);
  const closed = louvre.mul(step(hw, 0.62));
  // louvres every 7 cm, a central meeting stile, a frame and a middle rail
  const slat = fract(h.div(0.07));
  const slats = mix(float(0.9), smoothstep(0.05, 0.55, slat).mul(0.3).add(0.72), fine(0.02));
  const stile = lineAA(dx, 0.025).mul(fine(0.02));
  const leafFrame = max(smoothstep(0.075, 0.06, d), lineAA(abs(h.sub(mix(sill, springY, 0.5))), 0.04).mul(fine(0.02)));
  const shutterFace = shutCol.mul(slats.mul(float(1).sub(leafFrame)).add(leafFrame.mul(1.02))).mul(float(1).sub(stile.mul(0.45)));
  // the folded leaves beside an open window (square-headed windows with room for them only)
  const leafSide = louvre.mul(float(1).sub(closed)).mul(float(1).sub(isArch)).mul(winOn)
    .mul(step(halfW.mul(4.0).add(0.3), bayW))
    .mul(step(halfW.add(0.04), dx)).mul(step(dx, halfW.mul(2.0).add(0.02)))
    .mul(step(sill, h)).mul(step(h, head));
  // glass: dark panes with a sky-tinted sheen; white glazing bars (a mullion, a bar every ~0.75 m up the window and
  // one at an arch's springing)
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const glass = mix(vec3(0.045, 0.055, 0.065), cityUniforms.uSkyHorizonColor.mul(0.55), fres.mul(0.8).add(0.05));
  const paneH = max(springY.sub(sill), 0.4).div(max(floor(springY.sub(sill).div(0.75)), 1.0));
  const bars = clamp(lineAA(dx, 0.035).add(lineAA(abs(fract(h.sub(sill).div(paneH).add(0.5)).sub(0.5)).mul(paneH), 0.03))
    .add(lineAA(abs(h.sub(springY)), 0.04).mul(isArch)).add(smoothstep(0.07, 0.05, d)), 0.0, 1.0).mul(fine(0.025));
  // iron grille: bars every 12 cm on a dark opening; boards: vertical planks with a glazed head (the top 30 %)
  const grille = isShut(SH.grille);
  const grilleFace = mix(vec3(0.02, 0.022, 0.025), shutCol.mul(1.6), lineAA(abs(fract(px.div(0.12)).sub(0.5)).mul(0.12), 0.012).mul(fine(0.012)));
  const boards = isShut(SH.boards);
  const boardHead = step(mix(sill, head, 0.7), h);
  const plank = lineAA(abs(fract(px.div(0.16)).sub(0.5)).mul(0.16), 0.008).mul(fine(0.01));
  const boardFace = shutCol.mul(float(1).sub(plank.mul(0.35)));

  // Wall finish: grain, ashlar coursing, banded rustication, quoins, timber frame, brick courses, balustrade gaps
  const grain = mx_noise_float(positionWorld.mul(0.7)).mul(0.04).add(mx_noise_float(positionWorld.mul(5.0)).mul(0.02)).add(1.0);
  const course = 0.45, block = 1.1;
  const row = floor(h.div(course));
  const odd = fract(row.mul(0.5)).mul(2.0);
  const bed = abs(fract(h.div(course).add(0.5)).sub(0.5)).mul(course);
  const headJ = abs(fract(s.div(block).add(odd.mul(0.5)).add(0.5)).sub(0.5)).mul(block);
  const ashlar = bit(FLAG.ashlar).mul(notCap).mul(max(lineAA(bed, 0.01), lineAA(headJ, 0.01))).mul(fine(0.01));
  const rust = bit(FLAG.rusticated).mul(notCap).mul(lineAA(abs(fract(h.div(0.5).add(0.5)).sub(0.5)).mul(0.5), 0.03)).mul(fine(0.03));
  const quoinW = mix(float(0.42), float(0.75), odd);
  const quoin = bit(FLAG.quoins).mul(notCap).mul(clamp(step(s, quoinW).add(step(wallLen.sub(quoinW), s)), 0.0, 1.0));
  const quoinJoint = quoin.mul(max(lineAA(bed, 0.012), lineAA(min(abs(s.sub(quoinW)), abs(wallLen.sub(quoinW).sub(s))), 0.012))).mul(fine(0.012));
  const timber = bit(FLAG.timber).mul(notCap).mul(clamp(
    lineAA(abs(fract(s.div(1.25).add(0.5)).sub(0.5)).mul(1.25), 0.05)
      .add(lineAA(abs(h.sub(0.3)), 0.06)).add(lineAA(abs(h.sub(1.45)), 0.05)).add(lineAA(abs(h.sub(2.55)), 0.05)), 0.0, 1.0));
  const brickRow = floor(h.div(0.075));
  const brick = bit(FLAG.brick).mul(notCap).mul(max(lineAA(abs(fract(h.div(0.075).add(0.5)).sub(0.5)).mul(0.075), 0.006),
    lineAA(abs(fract(s.div(0.23).add(fract(brickRow.mul(0.5))).add(0.5)).sub(0.5)).mul(0.23), 0.006))).mul(fine(0.006));
  // balustrade: plinth & rail bands, turned balusters every `bay` m (bulging low), dark gaps between them (head: its
  // height)
  const bal = bit(FLAG.balustrade).mul(notCap);
  const inBody = step(0.16, h).mul(step(h, head.sub(0.16)));
  const bm = clamp(h.sub(0.16).div(max(head.sub(0.32), 0.05)), 0.0, 1.0);
  const balR = float(0.035).add(sin(min(bm.mul(1.6), 1.0).mul(Math.PI)).mul(0.04));
  const bdx = abs(fract(s.div(max(bayT, 0.05))).sub(0.5)).mul(max(bayT, 0.05));
  const gap = smoothstep(balR, balR.add(pix), bdx).mul(inBody).mul(bal);

  const dressing = clamp(quoin.add(surround), 0.0, 1.0);
  let wall = mix(wallCol, dressCol, dressing).mul(grain);
  wall = wall.mul(float(1).sub(ashlar.mul(0.22)).sub(rust.mul(0.24)).sub(quoinJoint.mul(0.25)).sub(brick.mul(0.3)).sub(surroundEdge.mul(0.25)));
  wall = mix(wall, dressCol, timber);
  wall = mix(wall, shutCol.mul(slats), leafSide);
  wall = mix(wall, wallCol.mul(0.12), gap);
  // what fills the opening
  const glassOrBars = mix(glass, vec3(0.88, 0.87, 0.84), bars);
  let fill = mix(glassOrBars, shutterFace, closed);
  fill = mix(fill, grilleFace, grille);
  fill = mix(fill, mix(boardFace, glassOrBars, boardHead), boards);
  const pane = opening.mul(float(1).sub(closed)).mul(float(1).sub(grille)).mul(float(1).sub(boards.mul(float(1).sub(boardHead))))
    .mul(float(1).sub(bars));
  mat.colorNode = mix(wall, fill, opening);
  mat.roughnessNode = mix(float(0.86), float(0.12), pane);
  mat.metalnessNode = mix(float(0.0), float(0.3), pane);

  // Night: a share of the rooms lit behind open windows, a glimmer through the louvres of some closed ones; the palace
  // washed pale and warm by its floodlights
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  const hw2 = fract(hw.mul(17.13));
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.32), 0.0, 0.55);
  const lit = step(hw2, litShare).mul(opening).mul(float(1).sub(grille)).mul(smoothstep(0.3, 0.9, cityUniforms.uInteriorGlow));
  const warm = mix(vec3(1.0, 0.7, 0.4), vec3(1.0, 0.84, 0.62), fract(hw.mul(7.7)));
  const glow = pane.add(closed.mul(opening).mul(0.045)).add(boards.mul(boardHead).mul(opening).mul(float(1).sub(bars)));
  const flood = mix(wallCol, vec3(0.9, 0.84, 0.72), 0.4).mul(night).mul(0.07).mul(bit(FLAG.floodlit)).mul(float(1).sub(opening));
  mat.emissiveNode = warm.mul(lit).mul(glow).mul(cityUniforms.uInteriorGlow).mul(1.15).add(flood);
  mat.name = 'AieteFacade';
  facadeMaterial = mat;
  return mat;
}

// A wall style: bay target and opening (sill, head, half width; bay 0 = blank), palette, shutters, arch, flags, and the
// height `base` the shader's heights start from; sill & head are frame heights (a balustrade's head: its top)
export function style(o = {}) {
  return { bay: 0, sill: 0, head: 0, half: 0, palette: PAL.white, shutter: SH.louvre, arch: 0, flags: 0, base: 0, ...o };
}
const PLAIN = style();

// ---------------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------------

// udaletxea.js's CivicModel with the Aiete facade's attributes: the same geometry helpers (prism, box, loft, mansard,
// beam, railing, dome...) in a frame (u, y above the frame's ground, v), faces in the facade material carry a style().
// finish() bakes world-space geometry per material for build() to merge across buildings.
export class AieteModel extends CivicModel {
  constructor(frame) {
    super(frame);
    this.facade = aieteFacadeMaterial();
    this.buckets = new Map();
  }

  bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) {
      const f = mat === this.facade;
      b = { pos: [], nrm: [], fac: f ? [] : null, win: f ? [] : null, kind: f ? [] : null };
      this.buckets.set(mat, b);
    }
    return b;
  }

  face(mat, pts, st = null, vn = null, sAlong = null) {
    const fn = newell(pts);
    if (!fn) return;
    const b = this.bucket(mat);
    let fac = null, win = null, kind = null;
    if (b.fac) {
      const sty = st && st.palette !== undefined ? st : PLAIN;
      let maxY = -Infinity, cx = 0, cz = 0;
      for (const p of pts) { maxY = Math.max(maxY, p[1]); cx += p[0]; cz += p[2]; }
      const seed = Math.abs(Math.round((cx * 3.1 + cz * 7.7 + maxY * 1.3) / pts.length)) % 997;
      if (Math.abs(fn[1]) > 0.85) {
        fac = pts.map((p) => [0, p[1] - sty.base, 1, seed]);
        win = [0, 0, 0, 0];
        kind = [sty.palette, 0, 0, FLAG.cap | (sty.flags & FLAG.floodlit)];
      } else {
        let along = sAlong;
        if (!along) {
          const tl = Math.hypot(fn[0], fn[2]);
          const tu = -fn[2] / tl, tv = fn[0] / tl;
          const ss = pts.map((p) => p[0] * tu + p[2] * tv);
          const s0 = Math.min(...ss);
          along = { s: ss.map((x) => x - s0), len: Math.max(...ss) - s0 };
        }
        fac = pts.map((p, k) => [along.s[k], p[1] - sty.base, along.len, seed]);
        win = [sty.bay, sty.sill - sty.base, sty.head - sty.base, sty.half];
        kind = [sty.palette, sty.shutter, sty.arch, sty.flags];
      }
    }
    const p0 = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1];
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) continue;
      for (const k of [0, i, i + 1]) {
        const p = pts[k], n = vn ? vn[k] : fn;
        b.pos.push(p[0], p[1], p[2]);
        b.nrm.push(n[0], n[1], n[2]);
        if (b.fac) {
          b.fac.push(...fac[k]);
          b.win.push(...win);
          b.kind.push(...kind);
        }
      }
    }
  }

  // A three.js geometry in the frame (u, y, v), in a material; facade faces get `st` with no windows
  geom(mat, geometry, st = PLAIN) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position.array;
    for (let k = 0; k < p.length; k += 9) {
      this.face(mat, [[p[k], p[k + 1], p[k + 2]], [p[k + 3], p[k + 4], p[k + 5]], [p[k + 6], p[k + 7], p[k + 8]]],
        { ...st, bay: 0, half: 0 });
    }
  }

  // Cornice-like band along a straight wall a -> b ([u, v]) whose outside is `out` ([u, v]), proud by `depth`, from y0
  // to y1; `ends` lengthens it past both ends (to close a corner)
  band(mat, a, b, out, y0, y1, depth, st = PLAIN, ends = 0) {
    const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    const tu = du / l, tv = dv / l;
    const A = [a[0] - tu * ends, a[1] - tv * ends], B = [b[0] + tu * ends, b[1] + tv * ends];
    const o = (q, d) => [q[0] + out[0] * d, q[1] + out[1] * d];
    const ring = [...o(A, -0.05), ...o(B, -0.05), ...o(B, depth), ...o(A, depth)];
    this.prism(mat, ring, y0, y1, st, { bottom: true });
  }

  // Bake the buckets into world-space geometries: [{ material, geometry }]
  bake() {
    const { x, z, angle, ground } = this.frame;
    const c = Math.cos(angle), s = Math.sin(angle);
    const out = [];
    for (const [mat, b] of this.buckets) {
      const n = b.pos.length / 3;
      if (!n) continue;
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const u = b.pos[3 * i], v = b.pos[3 * i + 2];
        pos[3 * i] = x + u * c - v * s;
        pos[3 * i + 1] = ground + b.pos[3 * i + 1];
        pos[3 * i + 2] = z + u * s + v * c;
        const nu = b.nrm[3 * i], nv = b.nrm[3 * i + 2];
        nrm[3 * i] = nu * c - nv * s;
        nrm[3 * i + 1] = b.nrm[3 * i + 1];
        nrm[3 * i + 2] = nu * s + nv * c;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      if (b.fac) {
        geo.setAttribute('facade', new THREE.BufferAttribute(new Float32Array(b.fac), 4));
        geo.setAttribute('fwin', new THREE.BufferAttribute(new Float32Array(b.win), 4));
        geo.setAttribute('fkind', new THREE.BufferAttribute(new Float32Array(b.kind), 4));
      }
      out.push({ material: mat, geometry: geo });
    }
    return out;
  }

  // The frame's matrix (frame -> world), for PaintBuilder parts modelled in the frame
  get matrix() {
    const { x, z, angle, ground } = this.frame;
    return new THREE.Matrix4().makeRotationY(-angle).setPosition(x, ground, z);
  }
}

// Outward unit normal of wall a -> b ([u, v]), the side away from `centre`
export function outward(a, b, centre = [0, 0]) {
  const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
  let n = [dv / l, -du / l];
  const mu = (a[0] + b[0]) / 2 - centre[0], mv = (a[1] + b[1]) / 2 - centre[1];
  if (n[0] * mu + n[1] * mv < 0) n = [-n[0], -n[1]];
  return n;
}

// A vertical wall quad a -> b ([u, v]) from y0 to y1 facing `out`, in a style
export function wallQuad(m, mat, a, b, out, y0, y1, st) {
  m.faceDir(mat, [[a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]]], [out[0], 0, out[1]], st);
}

// Steps: n boxes climbing from yBot to yTop between across-positions w0..w1, from the foot line `vBot` up to `vTop`
// along the stair's axis ('u' or 'v'); each step reaches down to `floorY`
export function steps(m, mat, st, axis, w0, w1, vBot, vTop, yBot, yTop, n, floorY) {
  for (let k = 1; k <= n; k++) {
    const y = yBot + ((yTop - yBot) * k) / n;
    const a = vBot + ((vTop - vBot) * (k - 1)) / n;
    const lo = Math.min(a, vTop), hi = Math.max(a, vTop);
    if (axis === 'v') m.box(mat, w0, w1, floorY, y, lo, hi, st, { faces: [st, st, st, st] });
    else m.box(mat, lo, hi, floorY, y, w0, w1, st, { faces: [st, st, st, st] });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The palace
// ---------------------------------------------------------------------------------------------------------------------

// The frame (from the municipal 1:500 outline's oriented box): +u runs east along the fronts, +v south to the garden
const FRAME = { x: -248.65, z: 1762.23, angle: THREE.MathUtils.degToRad(5.32) };

// Plan (frame metres): the block, its pavilions' fronts and the bow
const U = 17.53; // half length
const VN = -7.03, VNP = -7.38; // the north front of the wings, of the pavilions
const VS = 8.51, VSP = 9.02; // the south front of the centre, of the pavilions
const PAV = 10.3; // the pavilions' inner edges (|u|)
const BOW0 = 3.4, BOW1 = 1.39, BOWV = -8.98; // the canted bow: foot at ±3.4 on the wings' front, face ±1.39 at v

// Heights above the palace's ground (the terrain by the south terrace), scaled from the frontal photograph of the bow
// onto b5m's 17.0 m maximum: a 1.25 m limestone plinth, a 5.25 m ground floor, the first floor to the frieze, the
// modillioned cornice, the mansard's flat top and the crest of the taller roof over the bow
const FL = 1.25, F1 = 6.5, FRIEZE = 10.6, CORNICE = 11.4, EAVE = 12.25, DECK = 15.75, CREST = 17.0;

// Openings: [sill, head, half width] above the palace's ground
const GF_WIN = [2.05, 5.05, 0.66]; // ground floor, sill at 0.8 m
const GF_DOOR = [FL + 0.05, 5.0, 0.68]; // French windows to the floor
const GF_ARCH = [FL + 0.05, 5.15, 0.68]; // round-arched French windows (the bow, the south terrace)
const GF_ARCH_WIN = [1.9, 5.15, 0.72]; // the wings' round-arched windows
const F1_WIN = [7.05, 9.95, 0.64]; // first floor, sill at 0.55 m
const F1_DOOR = [F1 + 0.08, 9.95, 0.66]; // first-floor French windows onto balconies
const BASEMENT = [0.3, 0.85, 0.5]; // the plinth's barred windows

const MASTIFF = rgb(0x9fa194), LANTERN = rgb(0xfff0c8), IRON = rgb(0x1e2125), GLASS = rgb(0x46585a);

// The bow's outline pushed out by d, its canted faces kept parallel: [where the west face meets the wings' front line,
// the front's two corners, where the east face meets it]
function lineMeet(p, dp, q, dq) {
  const den = dp[0] * dq[1] - dp[1] * dq[0];
  const t = ((q[0] - p[0]) * dq[1] - (q[1] - p[1]) * dq[0]) / den;
  return [p[0] + dp[0] * t, p[1] + dp[1] * t];
}
function bowRing(d) {
  const faces = [[[-BOW0 - 5, VN], [-BOW0, VN]], [[-BOW0, VN], [-BOW1, BOWV]], [[-BOW1, BOWV], [BOW1, BOWV]],
    [[BOW1, BOWV], [BOW0, VN]], [[BOW0, VN], [BOW0 + 5, VN]]];
  const lines = faces.map(([a, b]) => {
    const n = outward(a, b, [0, 0.8]);
    return { p: [a[0] + n[0] * d, a[1] + n[1] * d], dir: [b[0] - a[0], b[1] - a[1]] };
  });
  const out = [];
  for (let k = 0; k < 4; k++) out.push(lineMeet(lines[k].p, lines[k].dir, lines[k + 1].p, lines[k + 1].dir));
  return out;
}

function buildPalace(ctx, out) {
  const { kit, terrain } = ctx;
  const { slate, zinc, iron } = kit.materials;
  const c = Math.cos(FRAME.angle), s = Math.sin(FRAME.angle);
  const toWorld = (u, v) => [FRAME.x + u * c - v * s, FRAME.z + u * s + v * c];
  // ground: the terrain at the foot of the south stair; the plinth reaches the lowest ground under the block
  const G = terrain.heightAt(...toWorld(0, 14.5));
  let low = Infinity;
  for (const [u, v] of [[-U, VNP], [U, VNP], [U, VSP], [-U, VSP], [0, -12.7], [0, VS], [-U, 0], [U, 0]]) {
    low = Math.min(low, terrain.heightAt(...toWorld(u, v)));
  }
  const P = Math.min(low - G, 0) - 0.3;
  const frame = { ...FRAME, ground: G };
  const m = new AieteModel(frame);
  const F = m.facade;
  const paint = new PaintBuilder();
  const M = m.matrix;
  const C0 = [0, 0.8]; // the plan's centre, for outward normals

  const W = PAL.white, CR = PAL.cream;
  const plain = (palette = W, flags = 0) => style({ palette, flags });
  const win = ([sill, head, half], bay, palette, extra = {}) => style({ bay, sill, head, half, palette, ...extra });
  const greyStone = style({ palette: PAL.grey, flags: FLAG.ashlar });

  // One stretch of wall from the plinth to the frieze: basement, ground floor, string course, first floor and frieze
  // (`gf`, `f1`: opening specs or null for blank); `pal`: the stretch's palette; the cream sandstone is coursed ashlar
  function stretch(a, b, { gf = GF_WIN, f1 = F1_WIN, bay = 3.4, pal = W, gfArch = 0 } = {}) {
    const o = outward(a, b, C0);
    const flags = FLAG.floodlit;
    wallQuad(m, F, a, b, o, P, FL, gf ? win(BASEMENT, bay, PAL.grey, { shutter: SH.grille, flags: FLAG.ashlar }) : greyStone);
    wallQuad(m, F, a, b, o, FL, F1, gf ? win(gf, bay, pal, { arch: gfArch, flags: flags | (pal === CR ? FLAG.ashlar : 0) })
      : plain(pal, flags));
    wallQuad(m, F, a, b, o, F1, FRIEZE, f1 ? win(f1, bay, pal, { flags: flags | (pal === CR ? FLAG.ashlar : 0) }) : plain(pal, flags));
    wallQuad(m, F, a, b, o, FRIEZE, CORNICE, plain(pal, FLAG.floodlit));
    return o;
  }
  // trims along a straight wall: plinth cap, string course, architrave, the cornice's mouldings and modillions
  function trims(a, b, o, pal = W, ends = 0) {
    const st = plain(pal, FLAG.floodlit);
    m.band(F, a, b, o, FL - 0.14, FL, 0.12, style({ palette: PAL.grey }), ends);
    m.band(F, a, b, o, F1 - 0.22, F1 + 0.06, 0.1, st, ends);
    m.band(F, a, b, o, FRIEZE - 0.05, FRIEZE + 0.22, 0.06, st, ends);
    m.band(F, a, b, o, CORNICE, CORNICE + 0.22, 0.24, st, ends);
    m.band(F, a, b, o, CORNICE + 0.22, EAVE - 0.18, 0.62, st, ends + 0.4);
    m.band(F, a, b, o, EAVE - 0.18, EAVE, 0.5, st, ends + 0.3);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.round(l / 0.7));
    const tu = (b[0] - a[0]) / l, tv = (b[1] - a[1]) / l;
    for (let k = 0; k < n; k++) {
      const t = ((k + 0.5) * l) / n;
      const pu = a[0] + tu * t, pv = a[1] + tv * t;
      m.band(F, [pu - tu * 0.09, pv - tv * 0.09], [pu + tu * 0.09, pv + tv * 0.09], o, CORNICE + 0.12, CORNICE + 0.34, 0.5, st);
    }
  }
  // window dressings on a wall a -> b with `bays` bays: hood over a ground-floor window, cornice or pediment over a
  // first-floor one, sills, balconies
  const along = (a, b, t, off, o) => [a[0] + (b[0] - a[0]) * t + o[0] * off, a[1] + (b[1] - a[1]) * t + o[1] * off];
  function dressings(a, b, bays, { gf = 'crest', f1 = 'cornice', balcony = false, pal = W, gfSpec = GF_WIN, f1Spec = F1_WIN } = {}) {
    const o = outward(a, b, C0);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const st = plain(pal, FLAG.floodlit);
    for (let k = 0; k < bays; k++) {
      const t = (k + 0.5) / bays, hw = gfSpec[2];
      const ta = t - (hw + 0.2) / l, tb = t + (hw + 0.2) / l;
      if (gf === 'crest') {
        m.band(F, along(a, b, ta, 0, o), along(a, b, tb, 0, o), o, gfSpec[1] + 0.12, gfSpec[1] + 0.26, 0.16, st);
        const ca = t - 0.32 / l, cb = t + 0.32 / l;
        m.band(F, along(a, b, ca, 0, o), along(a, b, cb, 0, o), o, gfSpec[1] + 0.26, gfSpec[1] + 0.72, 0.1, st);
        m.band(F, along(a, b, ta + 0.05 / l, 0, o), along(a, b, tb - 0.05 / l, 0, o), o, gfSpec[0] - 0.12, gfSpec[0], 0.12, st);
      } else if (gf === 'keystone' || gf === 'shell') {
        const ca = t - 0.26 / l, cb = t + 0.26 / l;
        m.band(F, along(a, b, ca, 0, o), along(a, b, cb, 0, o), o, gfSpec[1] - 0.05, gfSpec[1] + 0.55, 0.12, st);
        // the carved crest over an arched window: scrolls either side of the keystone
        if (gf === 'shell') {
          const sa = t - 0.5 / l, sb = t + 0.5 / l;
          m.band(F, along(a, b, sa, 0, o), along(a, b, sb, 0, o), o, gfSpec[1] + 0.22, gfSpec[1] + 0.42, 0.09, st);
        }
      }
      const fw = f1Spec[2];
      const fa = t - (fw + 0.25) / l, fb = t + (fw + 0.25) / l;
      if (f1 === 'cornice' || f1 === 'pediment') {
        m.band(F, along(a, b, fa, 0, o), along(a, b, fb, 0, o), o, f1Spec[1] + 0.18, f1Spec[1] + 0.34, 0.2, st);
        for (const e of [fa + 0.06 / l, fb - 0.06 / l]) {
          m.band(F, along(a, b, e - 0.06 / l, 0, o), along(a, b, e + 0.06 / l, 0, o), o, f1Spec[1] - 0.2, f1Spec[1] + 0.18, 0.14, st);
        }
      }
      if (f1 === 'pediment') {
        const L = along(a, b, fa, 0, o), Rr = along(a, b, fb, 0, o), Mm = along(a, b, t, 0, o);
        const y0 = f1Spec[1] + 0.34, y1 = y0 + 0.55;
        const tri = (off) => [[L[0] + o[0] * off, y0, L[1] + o[1] * off], [Rr[0] + o[0] * off, y0, Rr[1] + o[1] * off],
          [Mm[0] + o[0] * off, y1, Mm[1] + o[1] * off]];
        const f0 = tri(-0.02), f2 = tri(0.2);
        m.faceDir(F, f2, [o[0], 0, o[1]], st);
        const du = (b[0] - a[0]) / l, dv = (b[1] - a[1]) / l;
        m.faceDir(F, [f0[0], f2[0], f2[2], f0[2]], [-du * 0.7, 0.7, -dv * 0.7], st);
        m.faceDir(F, [f0[1], f0[2], f2[2], f2[1]], [du * 0.7, 0.7, dv * 0.7], st);
      }
      if (f1 === 'cornice' && !balcony) {
        m.band(F, along(a, b, t - (fw + 0.1) / l, 0, o), along(a, b, t + (fw + 0.1) / l, 0, o), o, f1Spec[0] - 0.12, f1Spec[0], 0.12, st);
      }
      if (balcony) ironBalcony(a, b, t - (fw + 0.35) / l, t + (fw + 0.35) / l, st);
    }
  }
  // an iron balcony on a stone slab and two consoles along wall a -> b, from t = ta to tb
  function ironBalcony(a, b, ta, tb, st) {
    const o = outward(a, b, C0);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    m.band(F, along(a, b, ta, 0, o), along(a, b, tb, 0, o), o, F1 - 0.12, F1 + 0.08, 0.62, st);
    for (const e of [ta + 0.12 / l, tb - 0.12 / l]) {
      m.band(F, along(a, b, e - 0.07 / l, 0, o), along(a, b, e + 0.07 / l, 0, o), o, F1 - 0.55, F1 - 0.12, 0.45, st);
    }
    railings(along(a, b, ta, 0.56, o), along(a, b, tb, 0.56, o), F1 + 0.08, 0.95);
    for (const e of [ta, tb]) m.beam(iron, xy(along(a, b, e, 0.56, o), F1 + 1.03), xy(along(a, b, e, 0.02, o), F1 + 1.03), 0.05, 0.05);
  }
  const xy = (q, y) => [q[0], y, q[1]];
  // an iron railing: top & bottom rails and bars every 12 cm, with a stouter post every ~1.5 m
  function railings(a, b, y, h = 0.95) {
    const P3 = (q, yy) => [q[0], yy, q[1]];
    m.beam(iron, P3(a, y + h), P3(b, y + h), 0.06, 0.05);
    m.beam(iron, P3(a, y + 0.1), P3(b, y + 0.1), 0.04, 0.04);
    m.beam(iron, P3(a, y + h - 0.16), P3(b, y + h - 0.16), 0.025, 0.025);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(l / 0.12));
    for (let k = 0; k <= n; k++) {
      const t = k / n, q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const post = k % 12 === 0 || k === n;
      m.beam(iron, P3(q, y), P3(q, y + h), post ? 0.05 : 0.018, post ? 0.05 : 0.018);
    }
  }

  // --- the walls -------------------------------------------------------------------------------------------------
  // north front, west to east: pavilion, wing, the bow's three faces, wing, pavilion
  const NWP = [[-U, VNP], [-PAV, VNP]], NW = [[-PAV, VN], [-BOW0, VN]];
  const BW = [[-BOW0, VN], [-BOW1, BOWV]], BF = [[-BOW1, BOWV], [BOW1, BOWV]], BE = [[BOW1, BOWV], [BOW0, VN]];
  const NE = [[BOW0, VN], [PAV, VN]], NEP = [[PAV, VNP], [U, VNP]];
  // south front, east to west: pavilion, the centre's three stretches, pavilion; the ends
  const SEP = [[U, VSP], [PAV, VSP]], SE = [[PAV, VS], [4.5, VS]], SC = [[4.5, VS], [-4.5, VS]], SW = [[-4.5, VS], [-PAV, VS]];
  const SWP = [[-PAV, VSP], [-U, VSP]];
  const END_E = [[[U, VNP], [U, -3.28]], [[U, -3.28], [U, 4.92]], [[U, 4.92], [U, VSP]]];
  const END_W = [[[-U, VSP], [-U, 4.92]], [[-U, 4.92], [-U, -3.28]], [[-U, -3.28], [-U, VNP]]];
  // the pavilions' fronts: paired ground-floor windows in a 3 m stretch, plain wall either side
  for (const [a, b] of [NWP, NEP, SEP, SWP]) {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const t0 = (l / 2 - 1.5) / l, t1 = (l / 2 + 1.5) / l;
    const o = outward(a, b, C0);
    const p0 = along(a, b, t0, 0, o), p1 = along(a, b, t1, 0, o);
    // basement & ground floor in three pieces (the pair in the middle), the first floor whole
    for (const [qa, qb, mid] of [[a, p0, false], [p0, p1, true], [p1, b, false]]) {
      wallQuad(m, F, qa, qb, o, P, FL, mid ? win(BASEMENT, 1.5, PAL.grey, { shutter: SH.grille, flags: FLAG.ashlar }) : greyStone);
      wallQuad(m, F, qa, qb, o, FL, F1, mid ? win([GF_WIN[0], GF_WIN[1], 0.52], 1.5, W, { flags: FLAG.floodlit }) : plain(W, FLAG.floodlit));
    }
    wallQuad(m, F, a, b, o, F1, FRIEZE, win(F1_DOOR, l, W, { flags: FLAG.floodlit }));
    wallQuad(m, F, a, b, o, FRIEZE, CORNICE, plain(W, FLAG.floodlit));
    trims(a, b, o, W, 0.25);
    dressings(a, b, 1, { gf: 'crest', f1: 'pediment', balcony: true, gfSpec: [GF_WIN[0], GF_WIN[1], 1.3], f1Spec: F1_DOOR });
    // banded rustication up the pavilion's corners
    for (const t of [0.04, 0.96]) {
      const q0 = along(a, b, t - 0.045, 0, o), q1 = along(a, b, t + 0.045, 0, o);
      m.band(F, q0, q1, o, FL, CORNICE, 0.07, style({ palette: W, flags: FLAG.rusticated | FLAG.floodlit }));
    }
  }
  // the wings: two bays a side on the north front, round-arched windows under carved crests on the ground floor
  for (const [a, b] of [NW, NE]) {
    const o = stretch(a, b, { gf: GF_ARCH_WIN, gfArch: 1, bay: 3.4 });
    trims(a, b, o, W, 0.1);
    dressings(a, b, 2, { gf: 'shell', gfSpec: GF_ARCH_WIN });
  }
  // the bow: round-arched French windows behind the columns, windows above
  for (const [a, b] of [BW, BF, BE]) {
    const o = stretch(a, b, { gf: GF_ARCH, gfArch: 1, bay: 2.7 });
    trims(a, b, o, W, 0.25);
    dressings(a, b, 1, { gf: 'keystone', gfSpec: GF_ARCH });
  }
  // the south front: white pavilions, the cream centre (two bays, the terrace's three arches, two bays)
  for (const [a, b] of [SE, SW]) {
    const o = stretch(a, b, { bay: 2.9, pal: CR, f1: F1_DOOR });
    trims(a, b, o, CR, 0.1);
    dressings(a, b, 2, { pal: CR, balcony: true, f1Spec: F1_DOOR });
  }
  {
    const [a, b] = SC;
    const o = stretch(a, b, { gf: GF_ARCH, gfArch: 1, bay: 3.0, pal: CR, f1: F1_DOOR });
    trims(a, b, o, CR, 0.1);
    dressings(a, b, 3, { gf: 'shell', f1: 'cornice', pal: CR, gfSpec: GF_ARCH, f1Spec: F1_DOOR });
    // one iron balcony along the three French windows over the terrace
    ironBalcony(a, b, 0.03, 0.97, plain(CR, FLAG.floodlit));
    // paired pilasters between the first floor's French windows
    for (const t of [0, 1 / 3, 2 / 3, 1]) {
      for (const dt of [-0.19, 0.19]) {
        const q = along(a, b, t + dt / 9, 0, o);
        const tu = (b[0] - a[0]) / 9, tv = (b[1] - a[1]) / 9;
        m.band(F, [q[0] - tu * 0.13, q[1] - tv * 0.13], [q[0] + tu * 0.13, q[1] + tv * 0.13], o, F1 + 0.08, FRIEZE, 0.12,
          plain(CR, FLAG.ashlar | FLAG.floodlit));
      }
    }
  }
  // the ends: four bays, French windows onto the west terrace and the east steps in the middle two
  for (const list of [END_E, END_W]) {
    list.forEach(([a, b], k) => {
      const mid = k === 1;
      const o = stretch(a, b, { gf: mid ? GF_DOOR : GF_WIN, bay: 4.1 });
      trims(a, b, o, W, 0.25);
      dressings(a, b, mid ? 2 : 1, { gfSpec: mid ? GF_DOOR : GF_WIN });
    });
  }
  // the step between each pavilion and the wing beside it: the pavilion's side, facing along the front to the middle
  for (const [a, b] of [[[-PAV, VNP], [-PAV, VN]], [[PAV, VN], [PAV, VNP]], [[PAV, VSP], [PAV, VS]], [[-PAV, VS], [-PAV, VSP]]]) {
    const o = [-Math.sign(a[0]), 0];
    wallQuad(m, F, a, b, o, P, FL, greyStone);
    wallQuad(m, F, a, b, o, FL, CORNICE, plain(W, FLAG.floodlit));
  }

  // --- the roofs -------------------------------------------------------------------------------------------------
  // a slate mansard round the whole block from the cornice's edge, its flat top in zinc
  const outline = [-U, VNP, -PAV, VNP, -PAV, VN, PAV, VN, PAV, VNP, U, VNP, U, VSP, PAV, VSP, PAV, VS, -PAV, VS, -PAV, VSP, -U, VSP];
  m.mansard(slate, outline, EAVE, DECK - EAVE, 1.05, { over: 0.5 });
  const deck = offsetRing(outline, 1.05);
  if (deck) m.cap(zinc, deck, DECK + 0.03);
  // the taller roof running north-south over the bow, its top crested with iron
  const rb = bowRing(0.5);
  const ridge = [rb[0][0], VSP + 0.5, ...rb[0], ...rb[1], ...rb[2], ...rb[3], rb[3][0], VSP + 0.5];
  const r1 = offsetRing(ridge, 1.35), r2 = offsetRing(ridge, 1.95);
  if (r1 && r2) {
    m.loft(slate, [ridge, r1, r2], [EAVE, CREST - 0.65, CREST]);
    for (let k = 0; k < r2.length; k += 2) {
      const j = (k + 2) % r2.length;
      railingCrest(r2[k], r2[k + 1], r2[j], r2[j + 1]);
    }
  }
  function railingCrest(u0, v0, u1, v1) {
    m.beam(iron, [u0, CREST + 0.45, v0], [u1, CREST + 0.45, v1], 0.04, 0.04);
    const l = Math.hypot(u1 - u0, v1 - v0), n = Math.max(1, Math.round(l / 0.25));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      m.beam(iron, [u0 + (u1 - u0) * t, CREST, v0 + (v1 - v0) * t], [u0 + (u1 - u0) * t, CREST + (k % 4 === 0 ? 0.7 : 0.45), v0 + (v1 - v0) * t], 0.02, 0.02);
    }
  }
  // dormers on the window axes: arched windows in white stone, slate cheeks under a rounded slate hood
  function dormer(u, v, dir, { w = 1.3, h = 2.35, depth = 1.9, y0 = EAVE + 0.1 } = {}) {
    // dir: outward unit vector ([u, v]); t: along the front
    const t = [-dir[1], dir[0]];
    const P2 = (a, b, y, back = 0) => [u + t[0] * a - dir[0] * back, y, v + t[1] * a - dir[1] * back];
    const spring = y0 + h - w / 2;
    const front = [P2(-w / 2, 0, y0), P2(w / 2, 0, y0)];
    for (let k = 0; k <= 8; k++) {
      const ang = (k * Math.PI) / 8;
      front.push(P2((w / 2) * Math.cos(ang), 0, spring + (w / 2) * Math.sin(ang)));
    }
    m.faceDir(F, front, [dir[0], 0, dir[1]], style({ bay: w, sill: y0 + 0.28, head: y0 + h - 0.2, half: w / 2 - 0.24, arch: 1,
      shutter: SH.glass, palette: W }));
    for (const side of [-1, 1]) {
      m.faceDir(slate, [P2(side * w / 2, 0, y0), P2(side * w / 2, 0, y0, depth), P2(side * w / 2, 0, spring, depth), P2(side * w / 2, 0, spring)],
        [t[0] * side, 0, t[1] * side]);
    }
    const hood = new THREE.CylinderGeometry(w / 2 + 0.1, w / 2 + 0.1, depth + 0.12, 9, 1, true, 0, Math.PI);
    // the half-cylinder's axis (after rotateZ: along x, its arc up) turned along the dormer's depth
    hood.rotateZ(Math.PI / 2);
    hood.rotateY(Math.atan2(-dir[1], dir[0]));
    const g = hood.toNonIndexed();
    g.translate(u - dir[0] * (depth / 2 - 0.06), spring, v - dir[1] * (depth / 2 - 0.06));
    m.geom(slate, g);
  }
  // north & south fronts: over every window axis but the centre's (the bow roof's own dormer stands there)
  for (const [[a, b], n, dir] of [[NWP, 1, [0, -1]], [NW, 2, [0, -1]], [NE, 2, [0, -1]], [NEP, 1, [0, -1]],
    [SEP, 1, [0, 1]], [SE, 2, [0, 1]], [SW, 2, [0, 1]], [SWP, 1, [0, 1]]]) {
    for (let k = 0; k < n; k++) {
      const q = along(a, b, (k + 0.5) / n, 0, [0, 0]);
      dormer(q[0], q[1] + dir[1] * 0.45, dir);
    }
  }
  for (const sgn of [-1, 1]) for (const v of [-1.23, 2.87]) dormer(sgn * (U + 0.45), v, [sgn, 0]);
  // the bow roof's great dormer, its arch framed by a moulded stone hood with a finial on its crown
  {
    const v = BOWV - 0.45, y0 = EAVE + 0.05, w = 1.9, h = 3.1;
    dormer(0, v, [0, -1], { w, h, depth: 2.6, y0 });
    const spring = y0 + h - w / 2, r = w / 2 + 0.12;
    const hood = [];
    for (let k = 0; k <= 8; k++) {
      const a = (k * Math.PI) / 8;
      hood.push([r * Math.cos(a), spring + r * Math.sin(a), v - 0.08]);
    }
    for (let k = 0; k < 8; k++) m.beam(F, hood[k], hood[k + 1], 0.22, 0.24);
    m.dome(F, 0, v - 0.05, spring + r + 0.08, [[0.15, 0], [0.17, 0.18], [0.03, 0.5]], 8);
  }
  // chimneys: brick stacks flanking the bow roof, rendered ones over the wings
  for (const [u, v, h, pal] of [[-4.3, 1.5, 2.0, PAL.brick], [4.3, 1.5, 2.0, PAL.brick], [-12.5, 0.8, 1.4, W], [12.5, 0.8, 1.4, W]]) {
    m.box(F, u - 0.45, u + 0.45, DECK - 0.4, DECK + h, v - 0.75, v + 0.75, style({ palette: pal, flags: pal === PAL.brick ? FLAG.brick : 0 }));
    m.box(F, u - 0.55, u + 0.55, DECK + h, DECK + h + 0.14, v - 0.85, v + 0.85, style({ palette: PAL.grey }));
    for (const dv of [-0.38, 0.38]) m.dome(F, u, v + dv, DECK + h + 0.14, [[0.13, 0], [0.12, 0.35], [0.15, 0.4]], 6, { st: style({ palette: PAL.brick }) });
  }

  // --- the bow's columns, podium, balcony and stair ----------------------------------------------------------------
  {
    const pod = bowRing(1.55);
    // the podium's stone walls (to the floor), the stair through its middle
    const podRing = [pod[0][0] - 0.6, VN, pod[0][0] - 0.6, pod[0][1], ...pod[0], ...pod[1], ...pod[2], ...pod[3],
      pod[3][0] + 0.6, pod[3][1], pod[3][0] + 0.6, VN];
    m.prism(F, podRing, P, FL - 0.02, greyStone, { top: true });
    const sv = pod[1][1];
    const footN = terrain.heightAt(...toWorld(0, -12.69)) - G;
    steps(m, F, greyStone, 'v', -0.95, 0.95, -12.69, sv, footN, FL - 0.02, 9, P);
    // iron railings on the podium's edges either side of the stair
    railings([pod[0][0] - 0.55, VN - 0.05], pod[0], FL);
    railings(pod[0], pod[1], FL);
    railings(pod[1], [-1.0, pod[1][1]], FL);
    railings([1.0, pod[2][1]], pod[2], FL);
    railings(pod[2], pod[3], FL);
    railings(pod[3], [pod[3][0] + 0.55, VN - 0.05], FL);
    // four columns on pedestals at the bow's corners, carrying the balcony
    for (const [cu, cv] of bowRing(0.55)) {
      m.box(F, cu - 0.32, cu + 0.32, FL, FL + 0.55, cv - 0.32, cv + 0.32, plain(W));
      m.dome(F, cu, cv, FL + 0.55, [[0.25, 0], [0.22, 0.15], [0.2, 0.25], [0.18, F1 - FL - 1.25], [0.21, F1 - FL - 1.05], [0.3, F1 - FL - 0.85]], 12,
        { st: plain(W) });
      m.box(F, cu - 0.34, cu + 0.34, F1 - 0.3, F1 - 0.12, cv - 0.34, cv + 0.34, plain(W));
    }
    // the canted balcony on the columns, its iron railing
    const bal = bowRing(0.95);
    const balRing = [bal[0][0] - 0.3, VN, ...bal[0], ...bal[1], ...bal[2], ...bal[3], bal[3][0] + 0.3, VN];
    m.prism(F, balRing, F1 - 0.12, F1 + 0.1, plain(W), { bottom: true });
    const rail = bowRing(0.88);
    railings([rail[0][0] - 0.25, VN - 0.02], rail[0], F1 + 0.1);
    railings(rail[0], rail[1], F1 + 0.1);
    railings(rail[1], rail[2], F1 + 0.1);
    railings(rail[2], rail[3], F1 + 0.1);
    railings(rail[3], [rail[3][0] + 0.25, VN - 0.02], F1 + 0.1);
  }

  // --- the south terrace, its curved stair, the mastiffs and the marquee -------------------------------------------
  {
    const T0 = VS, T1 = 11.15, TW = 6.5; // terrace: v from the wall to its front, half width
    m.box(F, -TW, TW, P, FL - 0.02, T0, T1, greyStone, { faces: [greyStone, greyStone, greyStone, greyStone] });
    // the stair bulging from the terrace's front: seven steps, each a segmental slab wider and further out than the one
    // above it
    const n = 7;
    const footY = terrain.heightAt(...toWorld(0, 14.0)) - G;
    for (let i = 1; i <= n; i++) {
      const top = footY + ((FL - 0.02 - footY) * (n - i + 1)) / (n + 1);
      const reach = T1 + (2.65 * i) / n, half = 2.9 + (0.6 * i) / n;
      const ring = [-half, T1 - 0.3, half, T1 - 0.3];
      for (let k = 0; k <= 10; k++) {
        const a = (k / 10) * Math.PI;
        ring.push(half * Math.cos(a), T1 + (reach - T1) * Math.sin(a));
      }
      m.prism(F, ring, P, top, style({ palette: PAL.grey }), { top: true });
    }
    // the curved parapets either side, ending in the mastiffs' pedestals
    for (const sg of [-1, 1]) {
      const pts = [];
      for (let k = 0; k <= 6; k++) {
        const a = (k / 6) * (Math.PI / 2);
        pts.push([sg * (3.55 + 0.5 * (1 - Math.cos(a))), T1 - 0.1 + 2.1 * Math.sin(a)]);
      }
      for (let k = 0; k < 6; k++) {
        const y1 = FL + 0.1 - (k / 6) * (FL - footY - 0.5), y2 = FL + 0.1 - ((k + 1) / 6) * (FL - footY - 0.5);
        m.wall(F, pts[k], pts[k + 1], 0.38, P, Math.max(y1, y2), greyStone);
        railings(pts[k], pts[k + 1], Math.max(y1, y2), 0.8);
      }
      const [pu, pv] = [sg * 4.05, T1 + 2.3];
      m.box(F, pu - 0.45, pu + 0.45, P, footY + 1.1, pv - 0.55, pv + 0.55, greyStone);
      m.box(F, pu - 0.52, pu + 0.52, footY + 1.1, footY + 1.22, pv - 0.62, pv + 0.62, style({ palette: PAL.grey }));
      mastiff(pu, footY + 1.22, pv, sg);
    }
    railings([-TW + 0.1, T1 - 0.1], [-3.55, T1 - 0.1], FL);
    railings([3.55, T1 - 0.1], [TW - 0.1, T1 - 0.1], FL);
    railings([-TW + 0.1, T0 + 0.1], [-TW + 0.1, T1 - 0.1], FL);
    railings([TW - 0.1, T0 + 0.1], [TW - 0.1, T1 - 0.1], FL);
    // the marquee: an iron-and-glass canopy from under the balcony down to its front, bulging over the stair, on four
    // slender columns; lanterns on the two by the stair
    const back = 5.95, front = 4.85, edge = T1 + 0.05;
    const outline = [[-TW - 0.15, edge], [-3.7, edge]];
    for (let k = 1; k < 12; k++) {
      const a = Math.PI - (k / 12) * Math.PI;
      outline.push([3.7 * Math.cos(a), edge + 1.9 * Math.sin(a)]);
    }
    outline.push([3.7, edge], [TW + 0.15, edge]);
    const fy = (q) => front - 0.25 * Math.max(0, q[1] - edge) / 1.9;
    for (let k = 0; k + 1 < outline.length; k++) {
      const A = outline[k], B = outline[k + 1];
      const a0 = [A[0], back, VS + 0.05], b0 = [B[0], back, VS + 0.05], a1 = [A[0], fy(A), A[1]], b1 = [B[0], fy(B), B[1]];
      const nrm = newell([a0, b0, b1, a1]) || [0, 1, 0];
      const up = nrm[1] < 0 ? -1 : 1;
      // the glass seen from above and from under the marquee
      paintQuadFrame([a0, b0, b1, a1], [nrm[0] * up, nrm[1] * up, nrm[2] * up], [...GLASS, FINISH.litGlass + 0.35]);
      paintQuadFrame([a0, b0, b1, a1], [-nrm[0] * up, -nrm[1] * up, -nrm[2] * up], [...GLASS, FINISH.litGlass + 0.35]);
      m.beam(iron, a1, b1, 0.08, 0.1);
      m.beam(iron, a0, a1, 0.05, 0.07);
      // the lace valance under the front edge
      m.beam(iron, [A[0], fy(A) - 0.16, A[1]], [B[0], fy(B) - 0.16, B[1]], 0.02, 0.26);
    }
    m.beam(iron, [-TW - 0.15, back, VS + 0.05], [TW + 0.15, back, VS + 0.05], 0.08, 0.1);
    for (const cu of [-TW, -3.7, 3.7, TW]) {
      m.dome(iron, cu, edge, FL, [[0.09, 0], [0.065, 0.25], [0.055, front - FL - 0.3], [0.09, front - FL]], 8);
      if (Math.abs(cu) < 5) lantern(cu, edge + 0.05, front - 1.0);
    }
  }

  // --- the west terrace and the east steps ------------------------------------------------------------------------
  {
    m.box(F, -U - 1.67, -U, P, FL - 0.02, -2.95, 3.95, greyStone, { faces: [greyStone, greyStone, greyStone, greyStone] });
    railings([-U - 1.6, -2.85], [-U - 1.6, 3.85], FL);
    const wy = terrain.heightAt(...toWorld(-U - 1, -3.7)) - G, sy = terrain.heightAt(...toWorld(-U - 1, 4.7)) - G;
    steps(m, F, greyStone, 'v', -U - 1.55, -U - 0.05, -4.2, -2.95, wy, FL - 0.02, 5, P);
    steps(m, F, greyStone, 'v', -U - 1.55, -U - 0.05, 5.2, 3.95, sy, FL - 0.02, 5, P);
    const ey = terrain.heightAt(...toWorld(U + 1.6, 0.75)) - G;
    steps(m, F, greyStone, 'u', -3.07, 4.56, U + 1.55, U, ey, FL - 0.02, 5, P);
  }

  // --- PaintBuilder parts: the marquee's glass, its lanterns, the mastiffs -------------------------------------------
  function paintQuadFrame(q, n, col) {
    const w = q.map((p) => new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(M).toArray());
    const nn = new THREE.Vector3(...n).transformDirection(M).toArray();
    paint.quad(w[0], w[1], w[2], w[3], col, nn);
  }
  function lantern(u, v, y) {
    const g = new THREE.CylinderGeometry(0.17, 0.12, 0.42, 6).translate(u, y, v);
    paint.add(g, [...LANTERN, FINISH.lamp + 0.9], M);
    paint.add(new THREE.CylinderGeometry(0.02, 0.22, 0.16, 6).translate(u, y + 0.29, v), [...IRON, FINISH.metal + 0.45], M);
    paint.add(new THREE.CylinderGeometry(0.1, 0.06, 0.12, 6).translate(u, y - 0.27, v), [...IRON, FINISH.metal + 0.45], M);
  }
  // a seated mastiff on its pedestal, looking out along the stair (sg: which side): haunches, a deep chest, the head
  // raised, forelegs straight; weathered pale stone
  function mastiff(u, y, v, sg) {
    const mm = new THREE.Matrix4().makeRotationY(sg * 0.35).setPosition(u, y, v);
    const put = (g) => paint.add(g, [...MASTIFF, 0.85], new THREE.Matrix4().multiplyMatrices(M, mm));
    put(new THREE.BoxGeometry(0.66, 0.06, 0.92).translate(0, 0.03, 0)); // plinth
    put(new THREE.SphereGeometry(1, 10, 7).scale(0.3, 0.26, 0.4).translate(0, 0.3, -0.12)); // haunches
    put(new THREE.CylinderGeometry(0.2, 0.26, 0.8, 10).rotateX(-0.42).translate(0, 0.7, 0.08)); // chest
    put(new THREE.SphereGeometry(1, 10, 7).scale(0.19, 0.18, 0.22).translate(0, 1.13, 0.24)); // head
    put(new THREE.CylinderGeometry(0.085, 0.11, 0.24, 8).rotateX(Math.PI / 2).translate(0, 1.08, 0.48)); // muzzle
    for (const x of [-0.13, 0.13]) put(new THREE.CylinderGeometry(0.055, 0.065, 0.66, 7).translate(x, 0.36, 0.3)); // forelegs
    for (const x of [-0.12, 0.12]) put(new THREE.ConeGeometry(0.06, 0.14, 5).rotateZ(-x * 2).translate(x, 1.32, 0.18)); // ears
  }

  out.push(...m.bake());
  return paint;
}

// ---------------------------------------------------------------------------------------------------------------------
// The landmark
// ---------------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const palace = sites.find((s) => s.id === 'aiete-jauregia');
  if (!palace) return null;
  const parts = [];
  // the small painted things (the marquee's glass and lanterns, the mastiffs, the park's lamps, statue, rocks, glass
  // front...) of the palace and the park go into one PaintBuilder: one draw
  const paint = buildPalace(ctx, parts);
  // (the kit is handed over rather than imported back: this module imports aiete-parkea.js)
  const hide = buildPark(sites, ctx, parts, { AieteModel, style, PAL, SH, FLAG, wallQuad, outward, steps }, paint);
  const mesh = paint.build('Aiete:paint');
  if (mesh) parts.push({ mesh });
  // one mesh per material across the palace and the outbuildings
  const byMat = new Map();
  const group = new THREE.Group();
  group.name = 'Aiete';
  for (const p of parts) {
    if (p.mesh) { group.add(p.mesh); continue; }
    if (!byMat.has(p.material)) byMat.set(p.material, []);
    byMat.get(p.material).push(p.geometry);
  }
  for (const [mat, list] of byMat) {
    const geo = list.length > 1 ? mergeGeometries(list) : list[0];
    if (!geo) continue;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = `Aiete:${mat.name || 'part'}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  group.userData.hide = hide;
  return group;
}

