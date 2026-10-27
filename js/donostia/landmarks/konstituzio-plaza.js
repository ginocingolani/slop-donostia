import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, attribute, uv, texture, float, vec2, vec3, vec4, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot,
  clamp, length, select, fwidth, pow, mod, normalize, positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { CivicModel } from './udaletxea.js';
import { newell, hipRoof, pointInRing } from './geom.js';
import { PaintBuilder, FINISH } from './paint.js';
import { rgb } from './igeldo.js';
import { drapedCap } from './alderdi-eder.js';

// js/donostia/landmarks/konstituzio-plaza.js
// Konstituzio plaza / Plaza de la Constitución (Plaza Berria), the Parte Vieja's square: laid out in 1817 after the
// fire of 1813 (Pedro Manuel de Ugartemendía), closed on all four sides, a bullring until the 1870s, hence the numbered
// balconies, from which the boxes were let. On the west side the old City Hall (1828-32, Silvestre Pérez; the
// municipal library since 1950): an arcade of five arches, a giant order of six half columns over two storeys, a
// modillioned cornice, an attic with the clock and the city's arms between two lions. The other three sides are
// uniform blocks: an arcade of round sandstone arches, three storeys of white render with every window framed in
// yellow, a continuous iron balcony on each floor, a grey modillioned cornice and a tiled roof with dormers.
//
// The data: the municipal 1:500 map's arcade (EraikinEgitura ARKUPEA: the covered walks, their back walls, the
// passages and the piers, drawn as notches in the square's edge; embedded below in the square's frame, © Donostiako
// Udala, CC BY-SA 3.0), its building outlines (GEO.buildings), b5m's heights, OpenStreetMap's square (way 23846347),
// its streets meeting it (Portu, Konstituzio, Iñigo and Arrandegi kaleak) and its clock (node 10572296509), and the
// LiDAR ground. The arcades: 20 arches on the north and south sides (pitch 2.90 m, piers ~0.8 m), 9 on the east one
// between the two great arches of the passages to Iñigo and Arrandegi, and the library's five (2.4 m, on piers 1.9 m
// wide and 3.1 m deep, a portico 9 m deep behind them); the passages to Portu and Konstituzio kaleak open from the
// recesses either side of the library.
//
// From the photographs (Wikimedia Commons, Konstituzio plaza's category: the views across the square from its
// balconies, the north and east fronts straight on, the balconies in detail, the library's front, the arcades by day
// and at night): the storeys, scaled from the east front (b5m: ~18.5 m to the eaves): the arcade to 6.6 m (springing
// 3.6 m, crown 4.7 m, a band and a row of grey consoles under the first floor's balcony), floors of 3.9, 3.6 and 3.6 m,
// the frieze and cornice to 18.4 m. Each bay: a French window in a yellow frame, lilac-grey louvred shutters folded
// against the wall or shut, the box's number in black serif figures on a yellow plaque over the window: 1-20 on the
// top floor of the north side from the west, 21-29 on the east side from the north, 30-49 on the south side from the
// east; 50-98 on the floor below and 99-147 on the first floor, in the same order. The bays over the passages are
// unnumbered, rendered ochre. The arcade's back walls: salmon render over a stone dado, shops in arches; the ceiling
// white; a lantern hangs in every arch. The paving: pale granite, square to the sides round the edge, diagonal inside
// a frame of dark bands with a double cross of dark bands through the middle; dark slate under the arcades. No pixels
// of the photographs are used: every colour is a hand-picked constant, the figures are drawn in the browser's serif.
//
// The blocks stay the city's (js/donostia/buildings.js), their eaves levelled at the cornice and their fronts on the
// square, the passages' mouths and the arcade left to this model (userData.replace, with `skip` stretches); the
// library is modelled whole (its building hidden, a phantom in its place so its neighbours keep their party walls).

// ---------------------------------------------------------------------------------------------------------------------
// The square's frame and plan
// ---------------------------------------------------------------------------------------------------------------------

// Origin on the north-west corner of the OSM square, +u along its north side (east-north-east), +v square to it into
// the square (south-south-east); plan coordinates below are metres in this frame
const FRAME = { x: 273.6, z: -259.6, angle: Math.atan2(-20.2, 50.8) };
const CENTRE = [25, 18];

// The open square: the fronts' feet (the piers' faces), round from the north-east corner: the north side, the recess
// before the passage to Portu kalea, the library's front with its returns, the recess before Konstituzio kalea's
// passage, the south side and the east side
const PLAZA = [54.23, 0.0, -3.38, -1.34, -3.49, 5.55, -0.10, 5.66, -0.94, 28.83, -4.28, 28.74, -4.47, 35.21, 52.66, 37.26];

// The covered walks (1:500 ARKUPEA's outer ring): back walls, the walks' ends, the passages' mouths on the streets
// and the piers between them. Each vertex starts an edge of the kind given.
const WALK = [
  [58.39, 32.35, 'mouth'], [58.21, 37.44, 'wall'], [56.68, 37.38, 'wall'], [56.61, 38.12, 'wall'], [57.38, 38.25, 'wall'],
  [56.74, 42.19, 'backS'], [20.80, 40.81, 'backS'], [-9.58, 39.79, 'wall'], [-9.46, 35.88, 'wall'], [-8.76, 35.91, 'wall'],
  [-8.73, 34.24, 'wall'], [-10.10, 34.19, 'mouth'], [-9.90, 29.22, 'wall'], [-8.48, 29.27, 'wall'], [-8.41, 27.54, 'wall'],
  [-10.16, 27.48, 'backL'], [-9.40, 6.42, 'wall'], [-7.68, 6.43, 'wall'], [-7.63, 4.70, 'wall'], [-9.04, 4.67, 'mouth'],
  [-8.84, -0.17, 'wall'], [-7.44, -0.19, 'wall'], [-7.39, -2.18, 'wall'], [-8.23, -2.22, 'wall'], [-8.11, -6.11, 'backN'],
  [59.11, -4.55, 'wall'], [58.70, -0.52, 'wall'], [58.09, -0.58, 'wall'], [58.05, 0.18, 'wall'], [59.56, 0.25, 'mouth'],
  [59.39, 5.25, 'wall'], [58.75, 5.26, 'wall'], [57.86, 5.30, 'wall'], [57.79, 6.05, 'wall'], [58.51, 6.09, 'backE'],
  [57.51, 31.56, 'wall'], [56.85, 31.54, 'wall'], [56.82, 32.28, 'wall']
];
// Piers standing free in the walks (notches of the map's square edge): the corners' and either side of the library
const PIERS = [[-4.68, -3.30, -1.81, -0.44], [-4.92, -3.23, 4.83, 6.53], [-5.72, -3.97, 27.62, 29.36],
  [-5.93, -4.45, 34.32, 35.9], [54.22, 56.62, -1.72, 0.15], [52.61, 55.08, 37.29, 39.16], [-9.40, -7.63, 4.70, 6.43],
  [-10.16, -8.41, 27.48, 29.27]];

// The arcades' pier centres (fitted to the map's piers) along each side: c0 + pitch k, its corner pier first. Each front
// runs from a to b left to right as seen from the square, so the figures read the right way round; `num`: the numbers
// of its first bay on the top, middle and first floors
const NORTH = { a: [-3.38, -1.34], b: [54.23, 0.0], axis: 0, c0: -3.494, pitch: 2.8961, n: 20, num: [1, 50, 99] };
const EAST = { a: [54.23, 0.0], b: [52.66, 37.26], axis: 1, c0: 5.565, pitch: 2.9033, n: 9, num: [21, 70, 119] };
const SOUTH = { a: [52.66, 37.26], b: [-4.47, 35.21], axis: 0, c0: 53.021, pitch: -2.8875, n: 20, num: [30, 79, 128] };
// The library's front and its arches (centres 4.306 m apart, 2.39 m wide)
const LIBRARY = { a: [-0.10, 5.66], b: [-0.94, 28.83], axis: 1, c0: 8.635, pitch: 4.306, n: 5 };
// The recesses' fronts either side of the library, over the passages' plaza mouths
const RECESS_N = { a: [-3.38, -1.34], b: [-3.49, 5.55], axis: 1, arch: [-0.35, 4.75] };
const RECESS_S = { a: [-4.28, 28.74], b: [-4.47, 35.21], axis: 1, arch: [29.4, 34.3] };
// The passages' mouths on the streets (Iñigo, Arrandegi, Portu, Konstituzio): [a, b] on the buildings' outlines
const MOUTHS = [[[59.56, 0.25], [59.39, 5.25]], [[58.39, 32.35], [58.21, 37.44]], [[-8.84, -0.17], [-9.04, 4.67]],
  [[-10.10, 34.19], [-9.90, 29.22]]];

// The library's main block (its 1:500 outline less the strips over the two passages) and those strips
const LIB_RING = [-0.10, 5.66, -0.94, 28.83, -4.28, 28.74, -9.89, 29.09, -23.47, 29.00, -23.14, 22.90, -22.10, 11.54,
  -21.88, 5.49, -21.66, 4.51, -9.04, 4.83, -3.49, 5.52];
const LIB_STRIPS = [[-8.95, 2.25, -3.38, 2.42, -3.49, 5.52, -9.04, 4.83], [-4.28, 28.74, -4.41, 31.89, -9.99, 31.66, -9.89, 29.09]];

// Heights above the square's ground (the LiDAR at its middle)
const H = {
  plinth: 0.55, spring: 3.62, big: 3.25, ceiling: 5.9, arcadeTop: 6.35,
  F1: 6.6, F2: 10.5, F3: 14.1, frieze: 17.45, cornice: 17.65, eave: 18.4
};
// The three floors' windows: [sill, head, half width] and the slab under each floor
const ROWS = [[H.F1, 9.65, 0.6], [H.F2, 13.35, 0.58], [H.F3, 16.85, 0.56]];
const SLABS = [[H.arcadeTop, H.F1, 0.6], [10.32, H.F2, 0.5], [13.92, H.F3, 0.5]];

// ---------------------------------------------------------------------------------------------------------------------
// The facade material
// ---------------------------------------------------------------------------------------------------------------------

// Palettes [wall, dressing (frames, quoins, plaques), fill (shutters, doors, frames)], sRGB picked by eye
export const PAL = { white: 0, sand: 1, ochre: 2, library: 3, grey: 4, plaster: 5, salmon: 6, dark: 7, tile: 8 };
const PALETTES = [
  [0xeeebe2, 0xdc9c24, 0x9a94a8], // the blocks' white render, yellow frames & plaques, lilac-grey shutters
  [0xc8a465, 0xd6b47a, 0x4a3b2e], // golden sandstone of the arcades, dark timber
  [0xd99a35, 0xc8a465, 0x9a94a8], // ochre render of the bays over the passages, sandstone dressings
  [0xc2ab84, 0xd1bd99, 0x5e6b76], // the library's pale sandstone, blue-grey window frames
  [0x8d8e8b, 0x777874, 0x4f5052], // grey paint: the cornices and consoles
  [0xe9e3d6, 0xddd5c4, 0x8c8478], // the arcades' white ceilings
  [0xd49b7c, 0xc8a465, 0x2a2622], // the arcades' salmon back walls over a sandstone dado, dark shop frames
  [0x5d625e, 0x707570, 0x2d2f30], // the library's dark inscription stone
  [0x96553f, 0x7e4636, 0x5a3328] // Roman tile (the library's and the passages' roofs)
];
// What fills an opening: glass, a French window with louvred shutters, a shop front, a door, an iron grille
export const FILL = { glass: 0, shutters: 1, shop: 2, door: 3, grille: 4 };
// Flags: ashlar coursing, a frame round each opening, a plinth (dark below 0.55 m; the dressing's colour below 1.1 m on
// rendered walls), floodlit at night, a horizontal cap (set by the builder), lit by the arcades' lanterns at night,
// voussoirs round the arches, courses of tiles
export const FLAG = { ashlar: 1, frame: 2, plinth: 4, flood: 8, cap: 16, glow: 32, voussoir: 64, tiles: 128 };

let facadeMaterial = null;
let digits = null;

// The box numbers' figures: 0-9 in white on black, 64 px apart, in the browser's serif (Times-like lining figures)
function digitAtlas() {
  if (digits) return digits;
  const w = 1024, h = 128;
  let tex;
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#fff';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 104px "Times New Roman", Times, "Liberation Serif", serif';
    for (let k = 0; k < 10; k++) g.fillText(String(k), k * 64 + 32, 70);
    tex = new THREE.CanvasTexture(c);
  } else {
    tex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  }
  tex.colorSpace = THREE.NoColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  digits = tex;
  return tex;
}

// Attributes: pa = (s: metres along the wall, h: metres above the square, wall length, plaque number of the wall's
// first bay: positive counting up along s, negative counting down, 0 none), pb = (bay target, sill, head, half width:
// 0 for a blank wall), pc = (palette, fill, arch: 0 square / 1 round, flags + 256 seed)
export function plazaFacadeMaterial() {
  if (facadeMaterial) return facadeMaterial;
  const mat = new THREE.MeshStandardNodeMaterial();
  const pa = attribute('pa', 'vec4'), pb = attribute('pb', 'vec4'), pc = attribute('pc', 'vec4');
  const s = pa.x, h = pa.y, wallLen = max(pa.z, 0.01), numBase = pa.w;
  const bayT = pb.x, sill = pb.y, head = pb.z, halfW = max(pb.w, 0.001);
  const palette = pc.x, fill = pc.y, arch = pc.z;
  const seed = floor(pc.w.div(256).add(0.001));
  const flags = pc.w.sub(seed.mul(256));
  const bit = (k) => step(0.5, fract(flags.add(0.5).div(2 * k)));
  const isFill = (k) => step(k - 0.5, fill).mul(step(fill, k + 0.5));
  const fCap = bit(FLAG.cap), notCap = float(1).sub(fCap);

  const pix = max(max(fwidth(s), fwidth(h)), 0.0005);
  const lineAA = (dist, w) => float(1).sub(smoothstep(w, pix.add(w), dist));
  const fine = (w) => float(1).sub(smoothstep(w, w * 4, pix));

  const pick = (k) => {
    const cols = PALETTES.map((p) => { const c = new THREE.Color(p[k]); return vec3(c.r, c.g, c.b); });
    let c = cols[0];
    for (let i = 1; i < cols.length; i++) c = select(palette.greaterThan(i - 0.5), cols[i], c);
    return c;
  };
  const wallCol = pick(0), dressCol = pick(1), fillCol = pick(2);

  // Bays: whole bays per wall, px = metres from the bay's centre line
  const hasWin = step(0.05, bayT).mul(step(0.01, pb.w)).mul(notCap);
  const bays = max(floor(wallLen.div(max(bayT, 0.05)).add(0.5)), 1.0);
  const bayW = wallLen.div(bays);
  const bayIdx = floor(s.div(bayW));
  const px = fract(s.div(bayW)).sub(0.5).mul(bayW);
  const dx = abs(px);
  const winOn = hasWin.mul(step(halfW.mul(2.0).add(0.1), bayW));

  // The opening: square-headed or round-arched; d is the signed distance inside it (metres)
  const isArch = step(0.5, arch);
  const cy = head.sub(halfW);
  const dArc = halfW.sub(length(vec2(dx, max(h.sub(cy), 0.0))));
  const dTop = mix(head.sub(h), dArc, isArch);
  const d = min(min(halfW.sub(dx), h.sub(sill)), dTop);
  const aa = max(fwidth(d), 0.004);
  const opening = smoothstep(aa.negate(), aa, d).mul(winOn);
  const springY = head.sub(halfW.mul(isArch));
  // a 17 cm frame (the yellow bands round the blocks' windows; dressed stone on the library and the ochre bays)
  const frame = bit(FLAG.frame).mul(smoothstep(-0.18, -0.165, d)).mul(float(1).sub(opening)).mul(winOn)
    .mul(step(sill.sub(0.01), h));
  const frameEdge = bit(FLAG.frame).mul(lineAA(abs(d.add(0.172)), 0.01)).mul(winOn).mul(fine(0.01)).mul(step(sill, h));

  // A room's draw: its shutters (shut, one leaf shut, or both folded back), its curtains, whether it is lit
  const storeyKey = floor(sill.mul(0.35));
  const hw = fract(sin(dot(vec2(bayIdx.add(seed.mul(0.137)), storeyKey.add(seed.mul(0.71))), vec2(12.9898, 78.233))).mul(43758.5453));
  const hw2 = fract(hw.mul(17.13)), hw3 = fract(hw.mul(31.7).add(0.3));
  const shutters = isFill(FILL.shutters);
  const leftShut = select(hw.lessThan(0.16), float(1), select(hw.lessThan(0.23), float(1), float(0)));
  const rightShut = select(hw.lessThan(0.16), float(1), select(hw.lessThan(0.23), float(0), select(hw.lessThan(0.3), float(1), float(0))));
  const shutHere = select(px.lessThan(0.0), leftShut, rightShut).mul(shutters);
  // two shutter colours on the blocks: lilac-grey and, on a third of the windows, a pale blue-grey
  const shutCol = mix(fillCol, vec3(0.42, 0.5, 0.58), step(0.68, hw3).mul(step(palette, 2.5)));
  const slat = fract(h.div(0.065));
  const slats = mix(float(0.88), smoothstep(0.05, 0.6, slat).mul(0.3).add(0.72), fine(0.02));
  const leafX = fract(dx.div(max(halfW, 0.05)));
  const leafFrame = max(lineAA(min(leafX, float(1).sub(leafX)).mul(halfW), 0.035), lineAA(abs(h.sub(mix(sill, springY, 0.5))), 0.035))
    .mul(fine(0.02));
  const shutterFace = shutCol.mul(slats.mul(float(1).sub(leafFrame)).add(leafFrame.mul(1.05)));
  // leaves folded back flat against the wall beside the frame (square-headed windows with the room for them)
  const leafW = halfW.mul(0.97);
  const foldX = dx.sub(halfW.add(0.19));
  const folded = shutters.mul(winOn).mul(float(1).sub(isArch))
    .mul(step(0.0, foldX)).mul(step(foldX, leafW)).mul(step(sill, h)).mul(step(h, head))
    .mul(select(px.lessThan(0.0), float(1).sub(leftShut), float(1).sub(rightShut)));
  const foldSlats = mix(float(0.88), smoothstep(0.05, 0.6, slat).mul(0.3).add(0.72), fine(0.02));
  const foldFrame = lineAA(min(foldX, leafW.sub(foldX)), 0.035).mul(fine(0.02));
  const foldFace = shutCol.mul(foldSlats.mul(float(1).sub(foldFrame)).add(foldFrame.mul(1.05))).mul(0.92);

  // Glass: dark panes with a sky sheen, curtains in some rooms; glazing bars: a mullion, bars every ~0.7 m, the frame
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const curtain = step(0.55, hw2).mul(isFill(FILL.shutters).add(isFill(FILL.glass)));
  const glassBase = mix(vec3(0.04, 0.05, 0.06), vec3(0.42, 0.41, 0.38), curtain.mul(0.55));
  const glass = mix(glassBase, cityUniforms.uSkyHorizonColor.mul(0.55), fres.mul(0.8).add(0.05));
  const paneH = max(springY.sub(sill), 0.4).div(max(floor(springY.sub(sill).div(0.72)), 1.0));
  const barCol = mix(vec3(0.62, 0.6, 0.64), fillCol, isFill(FILL.glass).add(isFill(FILL.shop)));
  const bars = clamp(lineAA(dx, 0.03).add(lineAA(abs(fract(h.sub(sill).div(paneH).add(0.5)).sub(0.5)).mul(paneH), 0.025))
    .add(lineAA(abs(h.sub(springY)), 0.035).mul(isArch)).add(smoothstep(0.075, 0.055, d)), 0.0, 1.0).mul(fine(0.02));
  // shop fronts: a glazed arch over a dado, a door in the middle bay of some; doors: boarded leaves under a fanlight;
  // grilles: bars every 12 cm over a dark opening
  const shop = isFill(FILL.shop), door = isFill(FILL.door), grille = isFill(FILL.grille);
  const shopDado = shop.mul(step(h, sill.add(0.7))).mul(step(0.35, hw2));
  const fanlight = step(springY.sub(0.05), h).mul(isArch).add(step(mix(sill, head, 0.78), h).mul(float(1).sub(isArch)));
  const plank = lineAA(abs(fract(px.div(0.2)).sub(0.5)).mul(0.2), 0.01).mul(fine(0.01));
  const doorFace = fillCol.mul(float(1).sub(plank.mul(0.3))).mul(float(1).sub(lineAA(dx, 0.02).mul(0.5)));
  const grilleFace = mix(vec3(0.02, 0.022, 0.025), vec3(0.16, 0.17, 0.18), lineAA(abs(fract(px.div(0.12)).sub(0.5)).mul(0.12), 0.012).mul(fine(0.012)));

  // Wall finish: grain, ashlar (courses 0.45 m, blocks 0.9 m, each a shade of its own), voussoirs, the plinth
  const grain = mx_noise_float(positionWorld.mul(0.8)).mul(0.035).add(mx_noise_float(positionWorld.mul(6.0)).mul(0.02)).add(1.0);
  const course = 0.45, block = 0.9;
  const row = floor(h.div(course));
  const odd = fract(row.mul(0.5)).mul(2.0);
  const blockId = floor(s.div(block).add(odd.mul(0.5)));
  const bed = abs(fract(h.div(course).add(0.5)).sub(0.5)).mul(course);
  const headJ = abs(fract(s.div(block).add(odd.mul(0.5)).add(0.5)).sub(0.5)).mul(block);
  const ashlar = bit(FLAG.ashlar).mul(notCap);
  const tone = fract(sin(dot(vec2(blockId, row), vec2(27.13, 61.7))).mul(4375.85)).sub(0.5).mul(0.12).mul(ashlar);
  const joints = ashlar.mul(max(lineAA(bed, 0.008), lineAA(headJ, 0.008))).mul(fine(0.008));
  // voussoirs: radial joints in a 0.5 m ring over an arch (from its springing up)
  const ringD = d.negate();
  const inRing = bit(FLAG.voussoir).mul(winOn).mul(isArch).mul(step(springY, h)).mul(step(0.0, ringD)).mul(step(ringD, 0.5));
  const ang = clamp(dx.div(max(length(vec2(dx, h.sub(cy))), 0.001)), 0.0, 1.0);
  const vous = inRing.mul(lineAA(abs(fract(ang.mul(5.5).add(0.5)).sub(0.5)).mul(0.6), 0.012)).mul(fine(0.01));
  const ringEdge = bit(FLAG.voussoir).mul(winOn).mul(isArch).mul(step(springY, h)).mul(lineAA(abs(ringD.sub(0.5)), 0.012)).mul(fine(0.01));
  const plinthStone = bit(FLAG.plinth).mul(notCap).mul(step(h, H.plinth)).mul(step(palette, 1.5));
  const dado = bit(FLAG.plinth).mul(notCap).mul(step(h, 1.1)).mul(step(1.5, palette));

  // The box numbers: a yellow plaque over each window, the number in black
  const hasNum = step(0.5, abs(numBase)).mul(winOn);
  const nRaw = select(numBase.greaterThan(0.0), numBase.add(bayIdx), numBase.negate().sub(bayIdx));
  const n = max(nRaw, 0.0);
  const count = float(1).add(step(9.5, n)).add(step(99.5, n));
  const plY0 = head.add(0.2), plH = 0.3, plHalf = 0.55;
  const inPlaque = hasNum.mul(step(dx, plHalf)).mul(step(plY0, h)).mul(step(h, plY0.add(plH)));
  const pitch = 0.118;
  const tx = px.add(count.mul(pitch * 0.5));
  const di = floor(tx.div(pitch));
  const fx = fract(tx.div(pitch));
  const inText = step(0.0, tx).mul(step(tx, count.mul(pitch)));
  const place = count.sub(1.0).sub(di);
  const p10 = select(place.greaterThan(1.5), float(100), select(place.greaterThan(0.5), float(10), float(1)));
  const dv = mod(floor(n.div(p10).add(0.0001)), 10.0);
  const ty = h.sub(plY0).div(plH);
  const atlasUV = vec2(dv.mul(64).add(6.0).add(fx.mul(52.0)).div(1024.0), ty);
  const ink = texture(digitAtlas(), atlasUV).r.mul(inText).mul(inPlaque);

  const dressing = clamp(frame.add(inPlaque), 0.0, 1.0);
  let wall = mix(wallCol, dressCol, dressing).mul(grain).mul(float(1).add(tone));
  wall = mix(wall, vec3(0.3, 0.27, 0.22), plinthStone);
  wall = mix(wall, dressCol.mul(grain), dado);
  wall = wall.mul(float(1).sub(joints.mul(0.3)).sub(vous.mul(0.3)).sub(ringEdge.mul(0.25)).sub(frameEdge.mul(0.2)));
  // tiles: courses every 17 cm of height, each tile its own shade
  const tiles = bit(FLAG.tiles);
  const tileC = lineAA(abs(fract(h.div(0.17)).sub(0.5)).mul(0.17), 0.012).mul(fine(0.01)).mul(tiles);
  wall = wall.mul(float(1).sub(tileC.mul(0.4))).mul(float(1).add(mx_noise_float(positionWorld.mul(2.3)).mul(0.12).mul(tiles)));
  wall = mix(wall, foldFace, folded);
  wall = mix(wall, vec3(0.03, 0.03, 0.03), ink.mul(0.92));
  // what fills the opening
  const glassOrBars = mix(glass, barCol, bars);
  let fillC = mix(glassOrBars, shutterFace, shutHere);
  fillC = mix(fillC, mix(doorFace, glassOrBars, fanlight), door);
  fillC = mix(fillC, grilleFace, grille);
  fillC = mix(fillC, wallCol.mul(0.5), shopDado);
  const pane = opening.mul(float(1).sub(shutHere)).mul(float(1).sub(grille)).mul(float(1).sub(door.mul(float(1).sub(fanlight))))
    .mul(float(1).sub(shopDado)).mul(float(1).sub(bars));
  mat.colorNode = mix(wall, fillC, opening);
  mat.roughnessNode = mix(float(0.86), float(0.12), pane);
  mat.metalnessNode = mix(float(0.0), float(0.3), pane);

  // Night: a share of the rooms lit (a glimmer through shut louvres), the shops bright, the arcades washed warm by
  // their lanterns, the library floodlit
  const glowNight = smoothstep(0.3, 0.9, cityUniforms.uInteriorGlow);
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.24), 0.0, 0.38);
  const litRoom = select(shop.greaterThan(0.5), step(0.3, hw3), step(fract(hw.mul(7.31)), litShare));
  const warm = mix(vec3(1.0, 0.7, 0.4), vec3(1.0, 0.84, 0.62), fract(hw.mul(7.7))).mul(select(shop.greaterThan(0.5), vec3(1.0, 0.85, 0.65), vec3(1.0, 1.0, 1.0)));
  const lightThrough = pane.add(shutHere.mul(opening).mul(0.05)).add(door.mul(fanlight).mul(opening));
  const roomGlow = warm.mul(litRoom).mul(lightThrough).mul(glowNight).mul(cityUniforms.uInteriorGlow).mul(select(shop.greaterThan(0.5), float(0.38), float(1.1)));
  const lantern = vec3(1.0, 0.8, 0.55).mul(bit(FLAG.glow)).mul(night).mul(0.16).mul(float(1).sub(opening));
  const flood = mix(wallCol, vec3(1.0, 0.7, 0.36), 0.55).mul(night).mul(0.13).mul(bit(FLAG.flood)).mul(float(1).sub(opening));
  mat.emissiveNode = roomGlow.add(wallCol.mul(lantern)).add(flood);
  mat.name = 'KonstituzioFacade';
  facadeMaterial = mat;
  return mat;
}

// A face's style: bay target, opening (sill, head, half width; bay 0 = blank), palette, fill, arch, flags, number
export function style(o = {}) {
  return { bay: 0, sill: 0, head: 0, half: 0, palette: PAL.white, fill: FILL.shutters, arch: 0, flags: 0, num: 0, ...o };
}
const PLAIN = style();

// ---------------------------------------------------------------------------------------------------------------------
// The ironwork: balcony railings and the library's balustrades on alpha-to-coverage strips
// ---------------------------------------------------------------------------------------------------------------------

// uv = (metres along, metres up from the slab); rk = (kind: 0 iron railing / 1 stone balustrade, the decorated posts'
// spacing, their offset). The iron railings (photographed in detail): a bottom rail, bars every 11 cm, a frieze of
// rings under the handrail and, between the windows, a post of stacked rings; the balustrades: turned balusters
// between a plinth and a rail
let railMaterial = null;
function railingMaterial() {
  if (railMaterial) return railMaterial;
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, roughness: 0.75, metalness: 0.0 });
  const rk = attribute('rk', 'vec4');
  const kind = rk.x;
  const coverage = Fn(() => {
    const p = uv();
    const x = p.x, y = p.y;
    const pix = max(fwidth(x), fwidth(y)).add(0.0004);
    const w = pix.mul(0.75);
    const cover = (dd) => float(1).sub(smoothstep(w.negate(), w, dd));
    // iron
    const bx = abs(fract(x.div(0.11)).sub(0.5)).mul(0.11);
    const barsD = max(bx.sub(0.011), max(float(0.09).sub(y), y.sub(0.8)));
    const railsD = min(min(abs(y.sub(0.065)).sub(0.022), abs(y.sub(0.815)).sub(0.014)), abs(y.sub(0.975)).sub(0.026));
    const rx = fract(x.div(0.12)).sub(0.5).mul(0.12);
    const ringD = max(abs(length(vec2(rx, y.sub(0.893))).sub(0.046)).sub(0.007), abs(y.sub(0.893)).sub(0.06));
    const postPitch = max(rk.y, 0.5);
    const qx = fract(x.sub(rk.z).div(postPitch).add(0.5)).sub(0.5).mul(postPitch);
    const inPost = step(abs(qx), 0.085).mul(step(0.09, y)).mul(step(y, 0.8));
    const sy = fract(y.sub(0.09).div(0.142)).sub(0.5).mul(0.142);
    const postRing = abs(length(vec2(qx, sy)).sub(0.058)).sub(0.008);
    const postSide = abs(abs(qx).sub(0.072)).sub(0.008);
    const postD = select(inPost.greaterThan(0.5), min(postRing, postSide), float(1));
    const ironD = min(min(select(inPost.greaterThan(0.5), float(1), barsD), railsD), min(ringD, postD));
    const iron = cover(ironD);
    // stone balusters every 0.22 m, bulging low
    const bm = clamp(y.sub(0.15).div(0.68), 0.0, 1.0);
    const r = float(0.03).add(sin(min(bm.mul(1.7), 1.0).mul(Math.PI)).mul(0.042)).add(step(bm, 0.06).mul(0.03));
    const qb = abs(fract(x.div(0.22)).sub(0.5)).mul(0.22);
    const balD = min(max(qb.sub(r), max(float(0.15).sub(y), y.sub(0.84))), min(abs(y.sub(0.075)).sub(0.075), abs(y.sub(0.92)).sub(0.08)));
    const stone = cover(balD);
    const c = select(kind.greaterThan(0.5), stone, iron);
    // far off, the bars' mean
    const far = smoothstep(0.003, 0.012, pix);
    const mean = select(kind.greaterThan(0.5), float(1.0), select(y.greaterThan(0.8), float(0.85), float(0.55)));
    return mix(c, mean, far).mul(step(0.0, y)).mul(step(y, 1.0));
  })();
  const ironCol = vec3(0.035, 0.038, 0.044), stoneCol = vec3(0.33, 0.37, 0.41);
  mat.colorNode = vec4(select(kind.greaterThan(0.5), stoneCol, ironCol), coverage);
  mat.maskShadowNode = coverage.greaterThan(0.4);
  mat.name = 'KonstituzioRailings';
  railMaterial = mat;
  return mat;
}

// A railing strip from a to b (frame [u, v]) standing on y, `h` metres tall: positions in the frame, uv and rk
class Rails {
  constructor() { this.pos = []; this.uvs = []; this.rk = []; }
  add(a, b, y, { h = 1.0, kind = 0, post = 2.9, offset = 0, s0 = 0 } = {}) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 0.05) return;
    const P = [[a[0], y, a[1]], [b[0], y, b[1]], [b[0], y + h, b[1]], [a[0], y + h, a[1]]];
    const T = [[s0, 0], [s0 + L, 0], [s0 + L, h], [s0, h]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      this.pos.push(...P[k]);
      this.uvs.push(T[k][0], T[k][1] / h);
      this.rk.push(kind, post, offset, 0);
    }
  }
  build(matrix) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    g.setAttribute('rk', new THREE.Float32BufferAttribute(this.rk, 4));
    g.computeVertexNormals();
    g.applyMatrix4(matrix);
    return g;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The paving
// ---------------------------------------------------------------------------------------------------------------------

// uv.x: 0 the square, 1 the arcades. The square: pale granite slabs, square to the sides (1 x 0.5 m) round the edge
// and set diagonally inside a frame of dark bands; a double cross of dark bands through the middle. The arcades: dark
// slate slabs.
const FRAME_BANDS = { u0: 5.0, u1: 48.5, v0: 6.0, v1: 29.5, uc: 26.75, vc: 17.75 };
function pavingMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0 });
  const c = Math.cos(FRAME.angle), sn = Math.sin(FRAME.angle);
  const dxz = positionWorld.xz.sub(vec2(FRAME.x, FRAME.z));
  const u = dot(dxz, vec2(c, sn)), v = dot(dxz, vec2(-sn, c));
  const arcade = step(0.5, uv().x);
  const pix = max(fwidth(u), fwidth(v)).add(0.0005);
  const fadeJ = float(1).sub(smoothstep(0.012, 0.05, pix));
  const hash = (p, k) => fract(sin(dot(p, vec2(12.9898 + k, 78.233 - k))).mul(43758.5453));
  const F = FRAME_BANDS;
  const band = (dd, w) => float(1).sub(smoothstep(w, pix.add(w), dd));
  const inFrame = step(F.u0, u).mul(step(u, F.u1)).mul(step(F.v0, v)).mul(step(v, F.v1));
  // the frame: a band on the outline of the rectangle (a box's signed distance)
  const q = vec2(abs(u.sub((F.u0 + F.u1) / 2)).sub((F.u1 - F.u0) / 2), abs(v.sub((F.v0 + F.v1) / 2)).sub((F.v1 - F.v0) / 2));
  const boxD = length(max(q, vec2(0.0, 0.0))).add(min(max(q.x, q.y), 0.0));
  const frameBand = band(abs(boxD), 0.38);
  const crossD = min(abs(abs(u.sub(F.uc)).sub(0.85)), abs(abs(v.sub(F.vc)).sub(0.85)));
  const crossBand = band(crossD, 0.3).mul(inFrame);
  const dark = max(frameBand, crossBand);
  // slabs: square to the sides outside the frame, diagonal inside
  const diag = inFrame.greaterThan(0.5);
  const du = select(diag, u.add(v).mul(0.7071), u), dv = select(diag, v.sub(u).mul(0.7071), v);
  const sw = select(diag, float(0.75), float(1.0)), sh = select(diag, float(0.75), float(0.5));
  const prow = floor(dv.div(sh));
  const pu = du.div(sw).add(fract(prow.mul(0.5)));
  const slabId = vec2(floor(pu), prow);
  const jx = float(0.5).sub(abs(fract(pu).sub(0.5))).mul(sw), jy = float(0.5).sub(abs(fract(dv.div(sh)).sub(0.5))).mul(sh);
  const joint = float(1).sub(smoothstep(0.004, 0.012, min(jx, jy)));
  const granite = mix(vec3(0.285, 0.276, 0.258), vec3(0.325, 0.316, 0.296), hash(slabId, 0.0));
  const darkStone = mix(vec3(0.085, 0.088, 0.09), vec3(0.115, 0.118, 0.12), hash(slabId, 3.0));
  let plaza = mix(granite, darkStone, dark);
  plaza = plaza.mul(float(1).sub(joint.mul(0.28).mul(fadeJ)));
  // the arcades' slate: slabs 0.8 x 0.6 m in running bond, each its own shade
  const arow = floor(v.div(0.6));
  const au = u.div(0.8).add(fract(arow.mul(0.37)));
  const aId = vec2(floor(au), arow);
  const ajx = float(0.5).sub(abs(fract(au).sub(0.5))).mul(0.8), ajy = float(0.5).sub(abs(fract(v.div(0.6)).sub(0.5))).mul(0.6);
  const ajoint = float(1).sub(smoothstep(0.004, 0.012, min(ajx, ajy)));
  const slate = mix(vec3(0.08, 0.072, 0.064), vec3(0.12, 0.11, 0.098), hash(aId, 7.0)).mul(float(1).sub(ajoint.mul(0.35).mul(fadeJ)));
  const grain = mx_noise_float(positionWorld.mul(3.1)).mul(0.05).add(1.0);
  mat.colorNode = mix(plaza, slate, arcade).mul(grain);
  mat.roughnessNode = mix(float(0.82), float(0.66), arcade);
  // the arcades' lanterns on the slate at night
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  // (on the square: within a few metres of the arcades' fronts, a box round the square's middle)
  const edge = max(max(float(-1.0).sub(v), v.sub(36.4)), max(u.sub(53.4), float(-0.6).sub(u))).negate();
  const spill = mix(float(1).sub(smoothstep(0.0, 5.0, edge)).mul(0.022), float(0.035), arcade);
  mat.emissiveNode = vec3(1.0, 0.78, 0.5).mul(spill).mul(night);
  mat.name = 'KonstituzioPaving';
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------------------------------------------------

// udaletxea.js's CivicModel (prism, box, loft, dome, beam, band...) in the square's frame (u, y above the square, v),
// writing the plaza facade material's attributes. Faces in that material carry a style(); sAlong (per-vertex metres
// along the wall, and the wall's length) keeps a wall's bays on the arcade's piers however it is cut up.
class PlazaModel extends CivicModel {
  constructor(frame) {
    super(frame);
    this.facade = plazaFacadeMaterial();
    this.buckets = new Map();
  }

  bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) {
      const f = mat === this.facade;
      b = { pos: [], nrm: [], pa: f ? [] : null, pb: f ? [] : null, pc: f ? [] : null };
      this.buckets.set(mat, b);
    }
    return b;
  }

  face(mat, pts, st = null, vn = null, sAlong = null) {
    const fn = newell(pts);
    if (!fn) return;
    const b = this.bucket(mat);
    let pa = null, pb = null, pc = null;
    if (b.pa) {
      const sty = st && st.palette !== undefined ? st : PLAIN;
      let cx = 0, cz = 0;
      for (const p of pts) { cx += p[0]; cz += p[2]; }
      const seed = Math.abs(Math.round((cx * 3.1 + cz * 7.7) / pts.length)) % 251;
      if (Math.abs(fn[1]) > 0.85) {
        pa = pts.map((p) => [0, p[1], 1, 0]);
        pb = [0, 0, 0, 0];
        pc = [sty.palette, 0, 0, (FLAG.cap | (sty.flags & (FLAG.flood | FLAG.glow | FLAG.ashlar | FLAG.tiles))) + 256 * seed];
      } else {
        let along = sAlong;
        if (!along) {
          const tl = Math.hypot(fn[0], fn[2]);
          const tu = -fn[2] / tl, tv = fn[0] / tl;
          const ss = pts.map((p) => p[0] * tu + p[2] * tv);
          const s0 = Math.min(...ss);
          along = { s: ss.map((x) => x - s0), len: Math.max(...ss) - s0 };
        }
        pa = pts.map((p, k) => [along.s[k], p[1], along.len, sty.num]);
        pb = [sty.bay, sty.sill, sty.head, sty.half];
        pc = [sty.palette, sty.fill, sty.arch, sty.flags + 256 * seed];
      }
    }
    const p0 = pts[0];
    for (let i = 1; i < pts.length - 1; i++) {
      const p1 = pts[i], p2 = pts[i + 1];
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      if (Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx) < 1e-9) continue;
      for (const k of [0, i, i + 1]) {
        const p = pts[k], nn = vn ? vn[k] : fn;
        b.pos.push(p[0], p[1], p[2]);
        b.nrm.push(nn[0], nn[1], nn[2]);
        if (b.pa) {
          b.pa.push(...pa[k]);
          b.pb.push(...pb);
          b.pc.push(...pc);
        }
      }
    }
  }

  // A quad facing `dir`, with explicit metres along (s per vertex, and the wall's length) for the bays
  quadAlong(mat, pts, dir, st, s, len) {
    const n = newell(pts);
    if (!n) return;
    if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] < 0) {
      pts = [pts[0], ...pts.slice(1).reverse()];
      s = [s[0], ...s.slice(1).reverse()];
    }
    this.face(mat, pts, st, null, { s, len });
  }

  // A three.js geometry in the frame (u, y, v), in a material; facade faces take `st` with no openings
  geom(mat, geometry, st = PLAIN) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const p = g.attributes.position.array;
    for (let k = 0; k < p.length; k += 9) {
      this.face(mat, [[p[k], p[k + 1], p[k + 2]], [p[k + 3], p[k + 4], p[k + 5]], [p[k + 6], p[k + 7], p[k + 8]]],
        { ...st, bay: 0, half: 0 });
    }
  }

  // World-space geometries per material: [{ material, geometry }]
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
      if (b.pa) {
        geo.setAttribute('pa', new THREE.BufferAttribute(new Float32Array(b.pa), 4));
        geo.setAttribute('pb', new THREE.BufferAttribute(new Float32Array(b.pb), 4));
        geo.setAttribute('pc', new THREE.BufferAttribute(new Float32Array(b.pc), 4));
      }
      out.push({ material: mat, geometry: geo });
    }
    return out;
  }

  get matrix() {
    const { x, z, angle, ground } = this.frame;
    return new THREE.Matrix4().makeRotationY(-angle).setPosition(x, ground, z);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Plan helpers
// ---------------------------------------------------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const len2 = (a) => Math.hypot(a[0], a[1]);
const toWorld = (u, v) => {
  const c = Math.cos(FRAME.angle), s = Math.sin(FRAME.angle);
  return [FRAME.x + u * c - v * s, FRAME.z + u * s + v * c];
};

// A front's line: point at s metres from a, the unit direction, the normal towards the square
function lineOf(side) {
  const d = sub(side.b, side.a), L = len2(d);
  const t = [d[0] / L, d[1] / L];
  let n = [-t[1], t[0]];
  const m = lerp2(side.a, side.b, 0.5);
  if ((CENTRE[0] - m[0]) * n[0] + (CENTRE[1] - m[1]) * n[1] < 0) n = [-n[0], -n[1]];
  const at = (s, off = 0) => [side.a[0] + t[0] * s + n[0] * off, side.a[1] + t[1] * s + n[1] * off];
  // s of the point on the line whose coordinate along the side's axis (u or v) is c
  const sOf = (c) => (c - side.a[side.axis]) / t[side.axis];
  return { L, t, n, at, sOf };
}

// ---------------------------------------------------------------------------------------------------------------------
// Walls with arches
// ---------------------------------------------------------------------------------------------------------------------

// A wall `depth` thick behind a front line (its face on the line, its back `depth` behind it, away from the square),
// from yBot to yTop between s = s0 and s1, cut by round arches [a, b, spring] (metres along): faces, backs, jambs and
// soffits. The front's style carries the bays (sFront: { origin, len } for the attributes' metres along).
function archedWall(m, line, s0, s1, arches, yBot, yTop, depth, st, { back = st, origin = 0, len = null, segments = 8 } = {}) {
  const F = m.facade;
  const L = len ?? s1 - s0;
  const P = (s, y, off) => { const q = line.at(s, off); return [q[0], y, q[1]]; };
  const out = [line.n[0], 0, line.n[1]], inw = [-line.n[0], 0, -line.n[1]];
  const tdir = [line.t[0], 0, line.t[1]];
  const sorted = arches.filter(([a, b]) => b > s0 && a < s1).sort((p, q) => p[0] - q[0]);
  for (const [off, dir, sty] of [[0, out, st], [-depth, inw, back]]) {
    const quad = (a, b, y0, y1) => m.quadAlong(F, [P(a, y0, off), P(b, y0, off), P(b, y1, off), P(a, y1, off)], dir, sty,
      [a - origin, b - origin, b - origin, a - origin], L);
    let cur = s0;
    for (const [a, b, spring] of sorted) {
      if (a > cur + 1e-3) quad(cur, a, yBot, yTop);
      // spandrels over the arch: two fans from the top corners
      const r = (b - a) / 2, c = a + r;
      for (const side of [-1, 1]) {
        const edge = side < 0 ? a : b;
        const pts = [P(edge, yTop, off), P(edge, spring, off)];
        const ss = [edge - origin, edge - origin];
        for (let k = 1; k <= segments; k++) {
          const ang = side < 0 ? Math.PI - (k * Math.PI) / (2 * segments) : (k * Math.PI) / (2 * segments);
          const sx = c + r * Math.cos(ang);
          pts.push(P(sx, spring + r * Math.sin(ang), off));
          ss.push(sx - origin);
        }
        pts.push(P(c, yTop, off));
        ss.push(c - origin);
        m.quadAlong(F, pts, dir, sty, ss, L);
      }
      cur = b;
    }
    if (s1 > cur + 1e-3) quad(cur, s1, yBot, yTop);
  }
  // jambs and soffits through the wall
  for (const [a, b, spring] of sorted) {
    const r = (b - a) / 2, c = a + r;
    m.faceDir(F, [P(a, yBot, 0), P(a, yBot, -depth), P(a, spring, -depth), P(a, spring, 0)], tdir, back);
    m.faceDir(F, [P(b, yBot, 0), P(b, yBot, -depth), P(b, spring, -depth), P(b, spring, 0)], [-tdir[0], 0, -tdir[2]], back);
    for (let k = 0; k < 2 * segments; k++) {
      const a0 = Math.PI - (k * Math.PI) / (2 * segments), a1 = Math.PI - ((k + 1) * Math.PI) / (2 * segments);
      const am = (a0 + a1) / 2;
      const Q = (ang, off) => P(c + r * Math.cos(ang), spring + r * Math.sin(ang), off);
      m.faceDir(F, [Q(a0, 0), Q(a1, 0), Q(a1, -depth), Q(a0, -depth)],
        [-Math.cos(am) * tdir[0], -Math.sin(am), -Math.cos(am) * tdir[2]], back);
    }
  }
  // the top
  m.faceDir(F, [P(s0, yTop, 0), P(s1, yTop, 0), P(s1, yTop, -depth), P(s0, yTop, -depth)], [0, 1, 0], back);
}

// The stretches of [s0, s1] outside the spans [a, b, ...] (a band broken over the great arches)
function gaps(s0, s1, spans) {
  const out = [];
  let cur = s0;
  for (const [a, b] of [...spans].sort((p, q) => p[0] - q[0])) {
    if (a > cur + 0.01) out.push([cur, a]);
    cur = Math.max(cur, b);
  }
  if (s1 > cur + 0.01) out.push([cur, s1]);
  return out;
}

// A plain wall quad along a line from s0 to s1 (offset `off` from it), facing the square, with the bays' metres along
function wallAlong(m, line, s0, s1, y0, y1, st, { off = 0, origin = 0, len = null, dir = 1 } = {}) {
  const P = (s, y) => { const q = line.at(s, off); return [q[0], y, q[1]]; };
  const L = len ?? s1 - s0;
  m.quadAlong(m.facade, [P(s0, y0), P(s1, y0), P(s1, y1), P(s0, y1)], [line.n[0] * dir, 0, line.n[1] * dir], st,
    [s0 - origin, s1 - origin, s1 - origin, s0 - origin], L);
}

// A band (slab, string course, cornice member) along a line from s0 to s1, from `inset` behind it to `proj` in front
function bandAlong(m, mat, line, s0, s1, y0, y1, proj, st = PLAIN, inset = 0.05) {
  const ring = [...line.at(s0, -inset), ...line.at(s1, -inset), ...line.at(s1, proj), ...line.at(s0, proj)];
  m.prism(mat, ring, y0, y1, st, { bottom: true });
}

// ---------------------------------------------------------------------------------------------------------------------
// The blocks' fronts
// ---------------------------------------------------------------------------------------------------------------------

const SAND = (flags = 0) => style({ palette: PAL.sand, flags: FLAG.ashlar | flags });
const OCHRE = style({ palette: PAL.ochre });
const GREY = style({ palette: PAL.grey });

// The arcade's arches along a side: [s0, s1, spring], from the pier centres
function sideArches(side, line) {
  const out = [];
  const w = 0.8;
  for (let k = 0; k < side.n; k++) {
    out.push([line.sOf(side.c0 + side.pitch * k) + w / 2, line.sOf(side.c0 + side.pitch * (k + 1)) - w / 2, H.spring]);
  }
  return out;
}

// One side of the square (north, east or south): the arcade's front wall, the three floors of numbered bays (and on
// the east side the ochre bays over the passages), balconies, consoles, the frieze and cornice; returns the arches
// (for the lanterns) and the bays (for the dormers)
function buildSide(m, rails, side, { yBot, depth = 0.86, ends = [] } = {}) {
  const line = lineOf(side);
  const F = m.facade;
  const arches = sideArches(side, line);
  const big = [];
  // the east side's great arches into the passages, under bays of their own
  const pieces = [];
  if (side === EAST) {
    const ne = [line.sOf(0.3), line.sOf(side.c0 - 0.4), H.big];
    const se = [line.sOf(side.c0 + side.pitch * side.n + 0.4), line.sOf(37.0), H.big];
    big.push(ne, se);
    pieces.push([0, line.sOf(side.c0)], [line.sOf(side.c0 + side.pitch * side.n), line.L]);
  }
  const all = [...arches, ...big].sort((p, q) => p[0] - q[0]);
  // the front's bays on the piers, so the shader rings the regular arches with voussoirs
  const P = Math.abs(side.pitch), r = (P - 0.8) / 2;
  const n0 = line.sOf(side.c0), n1 = line.sOf(side.c0 + side.pitch * side.n), numLen = n1 - n0;
  const front = style({ bay: P, sill: -1, head: H.spring + r - 0.02, half: r - 0.02, arch: 1, palette: PAL.sand,
    fill: FILL.glass, flags: FLAG.ashlar | FLAG.plinth | FLAG.voussoir | FLAG.glow });
  archedWall(m, line, 0, line.L, all, yBot, H.arcadeTop, depth, front, { back: SAND(FLAG.glow), origin: n0, len: numLen });
  // impost bands on the piers' faces and the band under the consoles
  for (let k = 0; k <= all.length; k++) {
    const left = k === 0 ? 0 : all[k - 1][1], right = k === all.length ? line.L : all[k][0];
    if (right - left < 0.1) continue;
    const spring = Math.min(k > 0 ? all[k - 1][2] : 9, k < all.length ? all[k][2] : 9);
    if (spring < 9) bandAlong(m, F, line, left, right, spring - 0.2, spring, 0.05, SAND());
  }
  for (const [a, b] of gaps(0, line.L, big)) bandAlong(m, F, line, a, b, 5.45, 5.62, 0.06, SAND());

  // the upper fronts: three floors of bays, numbered or ochre
  const spans = side === EAST ? [[n0, n1, true], ...pieces.map(([a, b]) => [a, b, false])] : [[0, line.L, true]];
  for (const [a, b, numbered] of spans) {
    ROWS.forEach(([sill, head, half], f) => {
      const y0 = f === 0 ? H.arcadeTop : SLABS[f][0], y1 = f === 2 ? H.frieze : SLABS[f + 1][0];
      const st = numbered
        ? style({ bay: P, sill, head, half, palette: PAL.white, flags: FLAG.frame, num: side.num[2 - f] })
        : style({ bay: b - a, sill, head, half: half * 0.95, palette: PAL.ochre, flags: FLAG.frame });
      wallAlong(m, line, a, b, y0, y1, st, numbered ? { origin: n0, len: numLen } : { origin: a, len: b - a });
    });
  }
  if (side === EAST) {
    // sandstone pilasters between the numbered block and the bays over the passages
    for (const sp of [n0, n1]) bandAlong(m, F, line, sp - 0.22, sp + 0.22, H.arcadeTop, H.cornice, 0.06, SAND());
  }

  // balconies: slabs (yellow edges), the first floor's on a row of consoles, the upper ones on two per bay
  const trimEnd = (s, proj) => {
    const lo = ends.includes('a') ? proj : 0, hi = ends.includes('b') ? line.L - proj : line.L;
    return Math.min(Math.max(s, lo), hi);
  };
  SLABS.forEach(([y0, y1, proj]) => {
    bandAlong(m, F, line, 0, line.L, y0, y1, proj, OCHRE);
    const s0 = trimEnd(0, proj), s1 = trimEnd(line.L, proj);
    // the railings' ring posts stand between the windows, over the piers
    rails.add(line.at(s0, proj - 0.05), line.at(s1, proj - 0.05), y1, { post: P, offset: n0, s0 });
  });
  for (let s = 0.36; s < line.L - 0.2; s += P / 4) {
    bandAlong(m, F, line, s - 0.065, s + 0.065, 5.92, H.arcadeTop, 0.42, GREY);
  }
  const bayCentres = [];
  for (let k = 0; k < side.n; k++) bayCentres.push(n0 + (k + 0.5) * (numLen / side.n));
  for (const [a, b] of pieces) bayCentres.push((a + b) / 2);
  for (const sc of bayCentres) {
    for (const f of [1, 2]) {
      for (const dxs of [-0.95, 0.95]) bandAlong(m, F, line, sc + dxs - 0.06, sc + dxs + 0.06, SLABS[f][0] - 0.3, SLABS[f][0], 0.36, GREY);
    }
  }
  // the yellow frieze, the grey cornice: fascia, modillions, corona
  bandAlong(m, F, line, 0, line.L, H.frieze, H.cornice, 0.03, OCHRE);
  bandAlong(m, F, line, 0, line.L, H.cornice, 17.95, 0.16, GREY);
  for (let s = 0.25; s < line.L - 0.1; s += 0.48) bandAlong(m, F, line, s - 0.065, s + 0.065, 17.95, 18.22, 0.52, GREY);
  bandAlong(m, F, line, 0, line.L, 18.22, 18.38, 0.84, GREY);
  // downpipes from the gutter, down the piers every few bays
  for (let k = 2; k < side.n; k += 4) {
    const [pu, pv] = line.at(line.sOf(side.c0 + side.pitch * k), 0.14);
    m.dome(F, pu, pv, yBot, [[0.055, 0], [0.055, 18.3 - yBot]], 6, { st: GREY });
  }
  return { line, arches: all, bayCentres };
}

// A recess's front either side of the library: the great arch into the passage, two ochre bays over it, balconies
// and cornice (it meets the north and south sides' fronts at its ends)
function buildRecess(m, rails, rec, yBot) {
  const line = lineOf(rec);
  const F = m.facade;
  const arch = [line.sOf(rec.arch[0]), line.sOf(rec.arch[1]), H.big];
  archedWall(m, line, 0, line.L, [arch], yBot, H.arcadeTop, 0.9, SAND(FLAG.plinth | FLAG.glow), { back: SAND(FLAG.glow) });
  for (const [a, b] of gaps(0, line.L, [arch])) bandAlong(m, F, line, a, b, 5.45, 5.62, 0.06, SAND());
  ROWS.forEach(([sill, head, half], f) => {
    const y0 = f === 0 ? H.arcadeTop : SLABS[f][0], y1 = f === 2 ? H.frieze : SLABS[f + 1][0];
    wallAlong(m, line, 0, line.L, y0, y1, style({ bay: line.L / 2, sill, head, half: half * 0.95, palette: PAL.ochre, flags: FLAG.frame }));
  });
  SLABS.forEach(([y0, y1, proj]) => {
    bandAlong(m, F, line, 0, line.L, y0, y1, proj, OCHRE);
    rails.add(line.at(proj, proj - 0.05), line.at(line.L - proj, proj - 0.05), y1, { post: line.L / 2, offset: 0, s0: proj });
  });
  for (let s = 0.36; s < line.L - 0.2; s += 0.72) bandAlong(m, F, line, s - 0.065, s + 0.065, 5.92, H.arcadeTop, 0.42, GREY);
  bandAlong(m, F, line, 0, line.L, H.frieze, H.cornice, 0.03, OCHRE);
  bandAlong(m, F, line, 0, line.L, H.cornice, 17.95, 0.16, GREY);
  for (let s = 0.25; s < line.L - 0.1; s += 0.48) bandAlong(m, F, line, s - 0.065, s + 0.065, 17.95, 18.22, 0.52, GREY);
  bandAlong(m, F, line, 0, line.L, 18.22, 18.38, 0.84, GREY);
  return { line, arches: [arch] };
}

// The arcades' and passages' ceilings, back walls and loose piers (the covered walks of the map)
function buildWalks(m) {
  const F = m.facade;
  // the ceiling: the walks' outline less the square, facing down
  const outer = WALK.map(([u, v]) => new THREE.Vector2(u, v));
  const hole = [];
  for (let k = 0; k < PLAZA.length; k += 2) hole.push(new THREE.Vector2(PLAZA[k], PLAZA[k + 1]));
  const pts = [...outer, ...hole];
  const ceil = style({ palette: PAL.plaster, flags: FLAG.glow });
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, [hole])) {
    m.faceDir(F, [[pts[a].x, H.ceiling, pts[a].y], [pts[b].x, H.ceiling, pts[b].y], [pts[c].x, H.ceiling, pts[c].y]], [0, -1, 0], ceil);
  }
  // back walls (shops in arches on the bays of the side they face), the walks' ends and the piers between them
  const sideOf = { backN: NORTH, backS: SOUTH, backE: EAST, backL: LIBRARY };
  for (let i = 0; i < WALK.length; i++) {
    const [u0, v0, kind] = WALK[i], [u1, v1] = WALK[(i + 1) % WALK.length];
    if (kind === 'mouth') continue;
    const a = [u0, v0], b = [u1, v1];
    const d = sub(b, a), L = len2(d);
    if (L < 0.05) continue;
    // facing into the walk (the ring's area is positive: (dv, -du) points out of it)
    const inn = [-d[1] / L, d[0] / L];
    const dir = [inn[0], 0, inn[1]];
    const side = sideOf[kind];
    const pts4 = [[a[0], -0.6, a[1]], [b[0], -0.6, b[1]], [b[0], H.ceiling, b[1]], [a[0], H.ceiling, a[1]]];
    if (side) {
      const ax = side.axis, origin = side === LIBRARY ? side.c0 - side.pitch / 2 : side.c0, sg = Math.sign(side.pitch);
      const P = Math.abs(side.pitch);
      const s = [(a[ax] - origin) * sg, (b[ax] - origin) * sg, (b[ax] - origin) * sg, (a[ax] - origin) * sg];
      const st = side === LIBRARY
        ? style({ bay: P, sill: 0, head: 3.9, half: 0.85, arch: 1, palette: PAL.library, fill: FILL.door, flags: FLAG.ashlar | FLAG.frame | FLAG.glow })
        : style({ bay: P, sill: 0.05, head: 3.3, half: 0.78, arch: 1, palette: PAL.salmon, fill: FILL.shop, flags: FLAG.plinth | FLAG.glow });
      m.quadAlong(F, pts4, dir, st, s, P * side.n);
    } else {
      m.faceDir(F, pts4, dir, SAND(FLAG.plinth | FLAG.glow));
    }
  }
  for (const [u0, u1, v0, v1] of PIERS) m.box(F, u0, u1, -0.6, H.ceiling, v0, v1, SAND(FLAG.plinth | FLAG.glow), { top: false });
}

// A passage's mouth on its street: a sandstone wall 0.5 m thick on the building's outline with a great arch, up to
// where the city's facade above it starts
function buildMouth(m, [a, b], terrain, toW) {
  const side = { a, b, axis: Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) ? 0 : 1 };
  const line = lineOf(side);
  // facing the street: away from the square
  line.n = [-line.n[0], -line.n[1]];
  const at = line.at;
  line.at = (s, off = 0) => at(s, -off);
  const mid = line.at(line.L / 2, 1.0);
  const yBot = Math.min(terrain(...toW(...mid)), terrain(...toW(...line.at(0, 1))), terrain(...toW(...line.at(line.L, 1)))) - 0.4;
  const inset = 0.35;
  archedWall(m, line, 0, line.L, [[inset, line.L - inset, H.big]], yBot, MOUTH_TOP, 0.5, SAND(FLAG.plinth | FLAG.voussoir), { back: SAND(FLAG.glow) });
}
const MOUTH_TOP = 6.45;

// Dormers on the roofs over the fronts: a white front with a shuttered window, cheeks, a rounded zinc hood. `x` metres
// behind the front, standing on the roof (eave at H.eave, rising `rise` over `run`)
function dormer(m, zinc, line, sc, rise, run) {
  const F = m.facade;
  const w = 1.3, x = 1.15, hgt = 1.55, depth = 2.2;
  const roofAt = (xx) => H.eave + (rise * (xx + 0.8)) / (run + 0.8);
  const y0 = roofAt(x) - 0.25, spring = y0 + hgt;
  const P = (s, off, y) => { const q = line.at(s, -off); return [q[0], y, q[1]]; };
  const n = [line.n[0], 0, line.n[1]];
  const st = style({ bay: w, sill: y0 + 0.4, head: spring - 0.12, half: 0.36, palette: PAL.white, flags: FLAG.frame });
  m.quadAlong(F, [P(sc - w / 2, x, y0), P(sc + w / 2, x, y0), P(sc + w / 2, x, spring), P(sc - w / 2, x, spring)], n, st,
    [0, w, w, 0], w);
  for (const sg of [-1, 1]) {
    const e = sc + (sg * w) / 2;
    m.faceDir(F, [P(e, x, y0), P(e, x + depth, y0), P(e, x + depth, spring), P(e, x, spring)],
      [line.t[0] * sg, 0, line.t[1] * sg], style({ palette: PAL.white }));
  }
  // the hood: a half cylinder along the dormer's depth
  const r = w / 2 + 0.08, seg = 7;
  for (let k = 0; k < seg; k++) {
    const a0 = (k * Math.PI) / seg, a1 = ((k + 1) * Math.PI) / seg;
    const Q = (ang, off) => P(sc + r * Math.cos(ang), off, spring + r * Math.sin(ang) * 0.75);
    m.faceDir(zinc, [Q(a0, x - 0.1), Q(a1, x - 0.1), Q(a1, x + depth), Q(a0, x + depth)],
      [Math.cos((a0 + a1) / 2) * line.t[0], Math.sin((a0 + a1) / 2), Math.cos((a0 + a1) / 2) * line.t[1]]);
  }
  // the hood's front rim
  const rim = [];
  for (let k = 0; k <= seg; k++) {
    const ang = (k * Math.PI) / seg;
    rim.push(P(sc + r * Math.cos(ang), x - 0.1, spring + r * Math.sin(ang) * 0.75));
  }
  m.faceDir(zinc, [P(sc, x - 0.1, spring), ...rim], n);
}

// ---------------------------------------------------------------------------------------------------------------------
// The library (the old City Hall)
// ---------------------------------------------------------------------------------------------------------------------

const LIB = { corbels: 5.62, slab: 6.35, floor: 6.6, bal1: 7.55, win1: [6.6, 10.0, 0.62], bal2: 11.1, floor2: 11.5,
  win2: [11.5, 14.0, 0.6], capital: 14.85, architrave: 15.3, frieze: 15.75, bed: 16.5, cornice: 17.5, attic: 18.15,
  attic2: 18.75, clockBlock: 19.3 };
const COLUMN_D = 1.05;

function buildLibrary(m, rails, paint, ctx, yBot) {
  const F = m.facade;
  const line = lineOf(LIBRARY);
  const stone = style({ palette: PAL.library, flags: FLAG.ashlar | FLAG.flood });
  const plain = style({ palette: PAL.library, flags: FLAG.flood });
  const centres = [];
  for (let k = 0; k < LIBRARY.n; k++) centres.push(line.sOf(LIBRARY.c0 + LIBRARY.pitch * k));
  const pitchS = centres[1] - centres[0];
  const origin = centres[0] - pitchS / 2, flen = pitchS * LIBRARY.n;
  // the portico's front: five arches through piers 3.1 m deep
  const arches = centres.map((c) => [c - 1.195, c + 1.195, 3.65]);
  archedWall(m, line, 0, line.L, arches, yBot, LIB.slab, 3.1, style({ bay: pitchS, sill: -1, head: 3.65 + 1.175, half: 1.175,
    arch: 1, palette: PAL.library, fill: FILL.glass, flags: FLAG.ashlar | FLAG.voussoir | FLAG.flood | FLAG.glow }),
  { back: style({ palette: PAL.library, flags: FLAG.ashlar | FLAG.glow }), origin, len: flen });
  bandAlong(m, F, line, 0, line.L, 4.95, 5.62, 0.04, stone);
  // the corbels under the first floor's balcony, the dark inscription panel in the middle
  for (let s = 0.45; s < line.L - 0.3; s += 0.95) bandAlong(m, F, line, s - 0.11, s + 0.11, LIB.corbels - 0.25, LIB.slab, 0.42, plain);
  const mid = (centres[2]);
  bandAlong(m, F, line, mid - 2.1, mid + 2.1, LIB.corbels - 0.25, LIB.slab, 0.43, style({ palette: PAL.dark }));
  bandAlong(m, F, line, -0.3, line.L + 0.3, LIB.slab, LIB.floor, 0.72, plain);
  // the two floors' walls and windows in dressed surrounds
  wallAlong(m, line, 0, line.L, LIB.slab, LIB.bal2, style({ bay: pitchS, sill: LIB.win1[0], head: LIB.win1[1], half: LIB.win1[2], palette: PAL.library, fill: FILL.glass, flags: FLAG.ashlar | FLAG.frame | FLAG.flood }), { origin, len: flen });
  wallAlong(m, line, 0, line.L, LIB.bal2, LIB.architrave, style({ bay: pitchS, sill: LIB.win2[0], head: LIB.win2[1], half: LIB.win2[2], palette: PAL.library, fill: FILL.glass, flags: FLAG.ashlar | FLAG.frame | FLAG.flood }), { origin, len: flen });
  // the giant order: six half columns on pedestals between the bays
  const cols = [];
  for (let k = 0; k <= LIBRARY.n; k++) cols.push(origin + k * pitchS);
  for (const cs of cols) {
    const [cu, cv] = line.at(cs, 0.28);
    const ped = 0.68;
    m.box(F, cu - ped, cu + ped, LIB.floor, LIB.bal1 + 0.1, cv - ped, cv + ped, stone);
    const r0 = COLUMN_D / 2;
    m.dome(F, cu, cv, LIB.bal1 + 0.1, [[r0 + 0.12, 0], [r0 + 0.12, 0.12], [r0 + 0.04, 0.2], [r0, 0.3], [r0 * 0.97, 2.6],
      [r0 * 0.86, LIB.capital - LIB.bal1 - 0.1], [r0 * 0.9, LIB.capital - LIB.bal1 + 0.02], [r0 * 1.12, LIB.capital - LIB.bal1 + 0.22]], 14,
    { st: plain });
    m.box(F, cu - 0.68, cu + 0.68, LIB.capital + 0.22, LIB.architrave, cv - 0.68, cv + 0.68, plain);
  }
  // balustrades between the pedestals (none in the middle bay, where the inscription plaque hangs), the upper floor's
  // balconies on consoles
  centres.forEach((c, k) => {
    if (k !== 2) rails.add(line.at(c - 1.48, 0.62), line.at(c + 1.48, 0.62), LIB.floor, { kind: 1, h: 0.95 });
    else bandAlong(m, F, line, c - 0.42, c + 0.42, 7.05, 7.6, 0.03, style({ palette: PAL.dark }));
    bandAlong(m, F, line, c - 1.25, c + 1.25, LIB.bal2, LIB.floor2, 0.78, plain);
    for (const o of [-1.05, -0.35, 0.35, 1.05]) bandAlong(m, F, line, c + o - 0.09, c + o + 0.09, LIB.bal2 - 0.42, LIB.bal2, 0.6, plain);
    rails.add(line.at(c - 1.2, 0.72), line.at(c + 1.2, 0.72), LIB.floor2, { kind: 1, h: 0.9 });
    // the window heads' cornices
    bandAlong(m, F, line, c - 0.85, c + 0.85, LIB.win1[1] + 0.2, LIB.win1[1] + 0.36, 0.14, plain);
    bandAlong(m, F, line, c - 0.85, c + 0.85, LIB.win2[1] + 0.2, LIB.win2[1] + 0.34, 0.12, plain);
  });

  // the walls round the rest of the block: the returns on the square, the street sides (windows on three floors)
  const ring = [];
  for (let k = 0; k < LIB_RING.length; k += 2) ring.push([LIB_RING[k], LIB_RING[k + 1]]);
  const inside = (q) => pointInRing(q[0], q[1], LIB_RING);
  const groundAt = (q) => ctx.terrain.heightAt(...toWorld(...q)) - ctx.G;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (i === 0 || i === 2 || i === 9) continue; // the front; the passages' sides (inside the strips and walks)
    const d = sub(b, a), L = len2(d);
    let nrm = [d[1] / L, -d[0] / L];
    const midp = lerp2(a, b, 0.5);
    if (inside([midp[0] + nrm[0] * 0.3, midp[1] + nrm[1] * 0.3])) nrm = [-nrm[0], -nrm[1]];
    const ln = { L, t: [d[0] / L, d[1] / L], n: nrm, at: (s, off = 0) => [a[0] + d[0] / L * s + nrm[0] * off, a[1] + d[1] / L * s + nrm[1] * off] };
    const street = i >= 3 && i <= 8;
    const yb = Math.min(groundAt(a), groundAt(b), yBot + 0.3) - 0.4;
    if (street && L > 3) {
      const bay = 3.4;
      wallAlong(m, ln, 0, L, yb, 4.6, style({ bay, sill: 1.3, head: 3.3, half: 0.55, palette: PAL.library, fill: FILL.grille, flags: FLAG.ashlar | FLAG.frame | FLAG.plinth }));
      wallAlong(m, ln, 0, L, 4.6, LIB.bal2, style({ bay, sill: 7.0, head: 9.6, half: 0.58, palette: PAL.library, fill: FILL.glass, flags: FLAG.ashlar | FLAG.frame }));
      wallAlong(m, ln, 0, L, LIB.bal2, LIB.architrave, style({ bay, sill: 11.6, head: 13.9, half: 0.55, palette: PAL.library, fill: FILL.glass, flags: FLAG.ashlar | FLAG.frame }));
    } else {
      wallAlong(m, ln, 0, L, yb, LIB.architrave, stone);
    }
    // the entablature and cornice round the whole block
    const e = street ? 0.6 : 1.05;
    bandAlong(m, F, ln, -e, L + e, LIB.architrave, LIB.frieze, 0.1, plain);
    bandAlong(m, F, ln, -e, L + e, LIB.frieze, LIB.bed, 0.0, plain);
    bandAlong(m, F, ln, -e, L + e, LIB.bed, LIB.bed + 0.3, 0.3, plain);
    bandAlong(m, F, ln, -e, L + e, LIB.bed + 0.62, LIB.cornice, 1.0, plain);
  }
  // the front's entablature, cornice (with modillions) and attic
  bandAlong(m, F, line, -1.05, line.L + 1.05, LIB.architrave, LIB.frieze, 0.12, plain);
  bandAlong(m, F, line, -1.05, line.L + 1.05, LIB.frieze, LIB.bed, 0.0, plain);
  bandAlong(m, F, line, -1.05, line.L + 1.05, LIB.bed, LIB.bed + 0.3, 0.32, plain);
  for (let s = -0.6; s < line.L + 0.6; s += 0.62) bandAlong(m, F, line, s - 0.1, s + 0.1, LIB.bed + 0.3, LIB.bed + 0.62, 0.85, plain);
  bandAlong(m, F, line, -1.05, line.L + 1.05, LIB.bed + 0.62, LIB.cornice, 1.05, plain);
  bandAlong(m, F, line, -0.1, line.L + 0.1, LIB.cornice, LIB.attic, -0.2, plain, 0.9);
  const sc = centres[2];
  bandAlong(m, F, line, sc - 6.95, sc + 6.95, LIB.cornice, LIB.attic2, -0.25, plain, 1.6);
  bandAlong(m, F, line, sc - 2.6, sc + 2.6, LIB.cornice, LIB.clockBlock, -0.15, stone, 1.8);
  // the roof behind: low hips of tile over the block
  const roof = hipRoof([-0.6, 5.9, -1.3, 28.5, -23.1, 28.65, -21.6, 5.15], LIB.cornice + 0.05, 3.0, 5.0);
  m.geom(F, roof, style({ palette: PAL.tile, flags: FLAG.tiles }));

  // the clock, the arms, the cannon spouts (painted parts), modelled in the front's own axes (x along it, y up, z out
  // of it towards the square) about a point on its line
  const M = m.matrix;
  const put = (g, col, fin) => paint.add(g, [...col, fin], M);
  const basis = (s, off, y) => {
    const q = line.at(s, off);
    return new THREE.Matrix4().makeBasis(new THREE.Vector3(line.t[0], 0, line.t[1]), new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(line.n[0], 0, line.n[1])).setPosition(q[0], y, q[1]);
  };
  const at = (g, s, off, y) => g.applyMatrix4(basis(s, off, y));
  const clockY = 18.62;
  put(at(new THREE.CylinderGeometry(0.98, 0.98, 0.14, 28).rotateX(Math.PI / 2), sc, -0.08, clockY), rgb(0x3b2a20), FINISH.paint + 0.6);
  put(at(new THREE.CylinderGeometry(0.86, 0.86, 0.04, 28).rotateX(Math.PI / 2), sc, 0.0, clockY), rgb(0xf4f1e6), FINISH.lamp + 0.35);
  for (let k = 0; k < 12; k++) {
    const g = new THREE.BoxGeometry(0.035, k % 3 ? 0.12 : 0.2, 0.03).translate(0, 0.7, 0).rotateZ((k * Math.PI) / 6);
    put(at(g, sc, 0.03, clockY), rgb(0x161616), FINISH.paint + 0.5);
  }
  put(at(new THREE.BoxGeometry(0.04, 0.62, 0.03).translate(0, 0.28, 0).rotateZ(-0.6), sc, 0.05, clockY), rgb(0x111111), FINISH.metal + 0.5);
  put(at(new THREE.BoxGeometry(0.05, 0.42, 0.03).translate(0, 0.19, 0).rotateZ(1.85), sc, 0.06, clockY), rgb(0x111111), FINISH.metal + 0.5);
  // the arms over the clock: the crowned shield (a ship on blue) between two rampant lions, spears behind
  const SH = rgb(0xb7ab95), BLUE = rgb(0x2b5c96), GOLD = rgb(0xb48a3c), SHIP = rgb(0xe6dcc6);
  const y0 = LIB.clockBlock;
  const arm = (g, col, fin, off = -0.5) => put(at(g, sc, off, y0), col, fin);
  arm(new THREE.BoxGeometry(2.9, 0.22, 0.9).translate(0, 0.11, 0), SH, 0.85);
  arm(new THREE.BoxGeometry(1.15, 1.35, 0.3).translate(0, 0.9, 0), SH, 0.8);
  arm(new THREE.BoxGeometry(0.92, 1.1, 0.06).translate(0, 0.92, 0.17), BLUE, 0.6);
  arm(new THREE.BoxGeometry(0.55, 0.22, 0.06).translate(0, 0.75, 0.2), SHIP, 0.6);
  arm(new THREE.BoxGeometry(0.05, 0.45, 0.06).translate(0, 1.05, 0.2), SHIP, 0.6);
  arm(new THREE.BoxGeometry(0.36, 0.2, 0.05).translate(0, 1.0, 0.21), SHIP, 0.6);
  arm(new THREE.CylinderGeometry(0.42, 0.34, 0.32, 10).translate(0, 1.76, 0), GOLD, FINISH.metal + 0.45);
  for (const sg of [-1, 1]) {
    arm(new THREE.SphereGeometry(1, 9, 7).scale(0.34, 0.4, 0.34).translate(sg * 0.98, 0.55, 0), SH, 0.85);
    arm(new THREE.CylinderGeometry(0.2, 0.28, 0.9, 9).rotateZ(sg * 0.35).translate(sg * 0.9, 1.08, 0), SH, 0.85);
    arm(new THREE.SphereGeometry(1, 9, 7).scale(0.24, 0.27, 0.26).translate(sg * 0.8, 1.6, 0.05), SH, 0.85);
    arm(new THREE.CylinderGeometry(0.025, 0.025, 2.1, 5).rotateZ(sg * 0.55).translate(sg * 1.2, 1.25, -0.25), rgb(0x2a2c2e), FINISH.metal + 0.5);
  }
  // cannons for spouts along the attic's foot, pointing out over the cornice
  for (let s = 0.6; s < line.L; s += 3.3) {
    put(at(new THREE.CylinderGeometry(0.08, 0.11, 0.8, 8).rotateX(Math.PI / 2), s, 0.25, LIB.cornice + 0.2), rgb(0x2e3134), FINISH.metal + 0.55);
  }
  return { line, arches };
}

// The strips over the passages either side of the library (its building's): their walls on the streets above the
// mouths, ochre with a window a floor, and low hipped roofs
function buildStrips(m, rails) {
  const F = m.facade;
  for (const r of LIB_STRIPS) {
    // the street side: the outline's edge on the passage's mouth (the one farthest from the square)
    let best = null;
    for (let k = 0; k < 4; k++) {
      const a = [r[2 * k], r[2 * k + 1]], b = [r[(2 * k + 2) % 8], r[(2 * k + 3) % 8]];
      const mu = (a[0] + b[0]) / 2;
      if (!best || mu < best.mu) best = { a, b, mu };
    }
    const d = sub(best.b, best.a), L = len2(d);
    let nrm = [d[1] / L, -d[0] / L];
    if (nrm[0] > 0) nrm = [-nrm[0], -nrm[1]];
    const ln = { L, t: [d[0] / L, d[1] / L], n: nrm, at: (s, off = 0) => [best.a[0] + d[0] / L * s + nrm[0] * off, best.a[1] + d[1] / L * s + nrm[1] * off] };
    ROWS.forEach(([sill, head, half], f) => {
      const y0 = f === 0 ? MOUTH_TOP : SLABS[f][0], y1 = f === 2 ? H.frieze : SLABS[f + 1][0];
      wallAlong(m, ln, 0, L, y0, y1, style({ bay: L, sill: sill + 0.3, head, half: half * 0.9, palette: PAL.ochre, flags: FLAG.frame }));
    });
    bandAlong(m, F, ln, 0, L, H.frieze, H.eave - 0.05, 0.25, GREY);
    // the strip's sides on its neighbours (the city's block, the library's roof), plain to the eaves
    const edges = [0, 1, 2, 3].map((k) => [[r[2 * k], r[2 * k + 1]], [r[(2 * k + 2) % 8], r[(2 * k + 3) % 8]]])
      .sort((p, q) => p[0][0] + p[1][0] - q[0][0] - q[1][0]);
    for (const [a, b] of edges.slice(1, 3)) m.wall(F, a, b, 0.1, MOUTH_TOP, H.eave, OCHRE);
    void rails;
    m.geom(F, hipRoof(r, H.eave, 1.7, 2.6), style({ palette: PAL.tile, flags: FLAG.tiles }));
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The square's blocks in the city: levelled eaves, fronts left to this model
// ---------------------------------------------------------------------------------------------------------------------

// The GEO.buildings with a wall along one of the square's fronts (both ends within 0.6 m of a front's line, at least
// 1.5 m of it), and the library (the building under the middle of its front's portico)
function findBuildings(GEO) {
  const fronts = [];
  for (let k = 0; k < PLAZA.length; k += 2) {
    const a = toWorld(PLAZA[k], PLAZA[k + 1]), b = toWorld(PLAZA[(k + 2) % PLAZA.length], PLAZA[(k + 3) % PLAZA.length]);
    fronts.push([a, b]);
  }
  const offLine = ([a, b], p) => {
    const d = sub(b, a), L = len2(d);
    const t = ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / (L * L);
    return { off: Math.abs((p[0] - a[0]) * d[1] - (p[1] - a[1]) * d[0]) / L, t };
  };
  const c = toWorld(...CENTRE);
  const libPoint = toWorld(-10, 17);
  let library = -1;
  const blocks = [];
  GEO.buildings.forEach((b, j) => {
    const r = b.g?.[0];
    if (!r || b.kind !== 0) return;
    if (Math.hypot(r[0] - c[0], r[1] - c[1]) > 110) return;
    if (pointInRing(libPoint[0], libPoint[1], r)) { library = j; return; }
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const p = [r[2 * i], r[2 * i + 1]], q = [r[(2 * i + 2) % r.length], r[(2 * i + 3) % r.length]];
      if (len2(sub(q, p)) < 1.5) continue;
      if (fronts.some((f) => {
        const A = offLine(f, p), B = offLine(f, q);
        return A.off < 0.6 && B.off < 0.6 && Math.max(A.t, B.t) > 0.02 && Math.min(A.t, B.t) < 0.98;
      })) { blocks.push(j); return; }
    }
  });
  return { library, blocks };
}

// The stretches of the blocks' outlines this model builds: the square's fronts (all their height) and the passages'
// mouths on the streets (up to MOUTH_TOP), in world coordinates
function skipStretches(G) {
  const out = [];
  const ext = (a, b, e) => { const d = sub(b, a), L = len2(d); return [[a[0] - d[0] / L * e, a[1] - d[1] / L * e], [b[0] + d[0] / L * e, b[1] + d[1] / L * e]]; };
  for (let k = 0; k < PLAZA.length; k += 2) {
    const [a, b] = ext([PLAZA[k], PLAZA[k + 1]], [PLAZA[(k + 2) % PLAZA.length], PLAZA[(k + 3) % PLAZA.length]], 0.5);
    out.push([...toWorld(...a), ...toWorld(...b), Infinity]);
  }
  for (const [a0, b0] of MOUTHS) {
    const [a, b] = ext(a0, b0, 0.3);
    out.push([...toWorld(...a), ...toWorld(...b), G + MOUTH_TOP]);
  }
  // the north arcade's closed east end and the passages' party lines with the library stay the city's
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The landmark
// ---------------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, terrain, kit } = ctx;
  const { library, blocks } = findBuildings(GEO);
  if (library < 0 || blocks.length < 10) return null;
  // the square's ground: the LiDAR at its middle
  const G = terrain.heightAt(...toWorld(...CENTRE));
  const groundAt = (x, z) => terrain.heightAt(x, z);
  const yBot = Math.min(...[[0, 0], [54, 0], [52, 37], [-4, 35], [-3, -1]].map(([u, v]) => groundAt(...toWorld(u, v)))) - G - 0.4;
  const m = new PlazaModel({ ...FRAME, ground: G });
  const rails = new Rails();
  const paint = new PaintBuilder();
  const cctx = { ...ctx, G };

  // the fronts
  const north = buildSide(m, rails, NORTH, { yBot, ends: ['a', 'b'] });
  const east = buildSide(m, rails, EAST, { yBot, depth: 1.0, ends: ['a', 'b'] });
  const south = buildSide(m, rails, SOUTH, { yBot, ends: ['a', 'b'] });
  const recN = buildRecess(m, rails, RECESS_N, yBot);
  const recS = buildRecess(m, rails, RECESS_S, yBot);
  const lib = buildLibrary(m, rails, paint, cctx, yBot);
  buildWalks(m);
  for (const mouth of MOUTHS) buildMouth(m, mouth, groundAt, toWorld);
  buildStrips(m, rails);

  // dormers on the three sides' roofs over every other bay or so (the photographs: four to six to a side's stretch)
  const zinc = kit.materials.zinc;
  const RISE = 3.0, RUN = RISE / Math.tan((32 * Math.PI) / 180);
  for (const side of [north, east, south]) {
    side.bayCentres.forEach((sc, k) => {
      const h = Math.sin(k * 12.9898 + sc * 78.233) * 43758.5453;
      if ((k % 2 === 0 && h - Math.floor(h) < 0.8) || h - Math.floor(h) < 0.12) dormer(m, zinc, side.line, sc, RISE, RUN);
    });
  }

  // lanterns hanging in every arch from its crown
  const LAMP = rgb(0xfff1d6), IRON = rgb(0x1d2024);
  const M = m.matrix;
  for (const { line, arches } of [north, east, south, recN, recS, lib]) {
    for (const [a, b, spring] of arches) {
      const sc = (a + b) / 2, crown = spring + (b - a) / 2;
      const [u, v] = line.at(sc, -0.12);
      const y = crown - 0.75;
      paint.add(new THREE.CylinderGeometry(0.16, 0.11, 0.42, 6).translate(u, y, v), [...LAMP, FINISH.lamp + 0.9], M);
      paint.add(new THREE.CylinderGeometry(0.03, 0.2, 0.14, 6).translate(u, y + 0.28, v), [...IRON, FINISH.metal + 0.45], M);
      paint.add(new THREE.CylinderGeometry(0.07, 0.04, 0.1, 6).translate(u, y - 0.26, v), [...IRON, FINISH.metal + 0.45], M);
      paint.add(new THREE.CylinderGeometry(0.012, 0.012, crown - y - 0.32, 4).translate(u, y + 0.32 + (crown - y - 0.32) / 2, v), [...IRON, FINISH.metal + 0.45], M);
    }
  }

  // the paving: the square and the walks, draped on the ground
  const plazaW = [], walkW = [];
  for (let k = 0; k < PLAZA.length; k += 2) plazaW.push(...toWorld(PLAZA[k], PLAZA[k + 1]));
  for (const [u, v] of WALK) walkW.push(...toWorld(u, v));
  const pave = [];
  for (const [rings, kind] of [[[plazaW], 0], [[walkW, plazaW], 1]]) {
    const g = drapedCap(rings, terrain, 0.03);
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2).fill(kind), 2));
    pave.push(g);
  }

  // bake: one mesh per material
  const group = new THREE.Group();
  group.name = 'KonstituzioPlaza';
  const add = (geometry, material, name, shadows = true) => {
    if (!geometry) return;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = shadows;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  };
  for (const { material, geometry } of m.bake()) add(geometry, material, `Konstituzio:${material.name || 'part'}`);
  add(rails.build(M), railingMaterial(), 'Konstituzio:railings');
  add(mergeGeometries(pave), pavingMaterial(), 'Konstituzio:paving', false);
  const pm = paint.build('Konstituzio:paint');
  if (pm) group.add(pm);

  // the city keeps the blocks, eaves levelled at the cornice, fronts and mouths left to this model; the library is
  // this model's, a phantom standing in for it
  const E = G + H.eave;
  const skip = skipStretches(G);
  const replace = new Map();
  for (const j of blocks) {
    const b = GEO.buildings[j];
    replace.set(j, { ...b, eave: E, top: E + Math.max(b.top - b.eave, 3.0), roof: Math.max(b.roof, 1), plaza: false, skip });
  }
  const lb = GEO.buildings[library];
  group.userData.hide = [library];
  group.userData.replace = replace;
  group.userData.phantoms = [{ ...lb, eave: E, top: E + 3, roof: 1 }];
  return group;
}
