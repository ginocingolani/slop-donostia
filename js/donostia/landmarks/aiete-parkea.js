import * as THREE from 'three/webgpu';
import { rect, ngon } from './udaletxea.js';
import { pointInRing, cleanRing } from './geom.js';
import { FINISH } from './paint.js';
import { rgb } from './igeldo.js';

// js/donostia/landmarks/aiete-parkea.js
// Aiete parkea round the palace (aiete.js builds the palace and calls buildPark() with its kit and its PaintBuilder):
// the palace's outbuildings, the Kulturetxea's sunken glass pavilion and a few features of the park near them.
//
//  - The "chapel" (b5m: Aiete jauregiaren kapera) east of the palace: a white two-storey block under an open loggia and
//    a low hipped roof, a round stair turret with a slate cone on its north-west corner (the 1:500 outline draws the
//    turret; the photograph of the north lawn shows the loggia and the cone), steps to its north door.
//  - The guard's house (b5m: Aiete jauregiko guardaetxea) by the park's gate on Aiete pasealekua: red render with
//    sandstone quoins and string course, green shutters, a stone balcony, low gabled roofs with green fretwork
//    bargeboards and a brick chimney (photograph of its gable end); a T of two gables after the 1:500 outline and the
//    orthophoto's roof.
//  - The old stables (b5m: Zalditegi zaharrak), a U open to the south-east: red render and sandstone, hipped slate
//    roofs on the two wings, a lower centre with a balustraded terrace over its great arch and a clock gable with a
//    small bell-cote (photograph of the front on its gravel forecourt); big segmental arches with green board doors.
//  - The dovecote (b5m: Aiete jauregiko usategia): a long timber shed of pink boarding in a green frame with fretwork
//    bargeboards, a veranda on posts, and its three-tiered octagonal tower of pigeon holes under green skirts and a
//    ribbed zinc dome (photograph). b5m's 7.3 m maximum misses the tower, which the photograph shows twice the shed's
//    height: the model gives it 9.8 m.
//  - The Kulturetxea (OSM: a library underground under a green roof): its glass front faces north over the lower
//    lawn, a long sweep of glass panels: big lime and yellow triangles standing on the ground, clear glass between
//    them under a turquoise band, white mullions and struts (photographs from the lawn); the LiDAR keeps the 4 m step behind it. Its roof is lawn, with a skylight.
//  - The pond (OSM outline, embedded below; © OpenStreetMap contributors, ODbL 1.0) gets a stone kerb and, on the rock
//    of its little peninsula, a white marble statue (photograph from across the pond); the artificial grotto (OSM node
//    "Gruta artificial") a mound of tufa rocks round a dark cave mouth facing down the slope; a few white cast-iron
//    park lamps (photographs; no lamp data: placed by the forecourt and round the pond's walk).
// The 1:500 buildings these replace are found by position in GEO.buildings and returned for userData.hide; the
// Kulturetxea's comes from its landmark site. Colours are hand-picked constants: no pixels of the photographs are used.

// The pond's outline (OSM way 197860284, simplified to 25 cm; local frame metres)
const POND = [-272.01, 1819.2, -269.06, 1811.58, -266.91, 1808.3, -263.9, 1805.87, -259.05, 1804.71, -246.93, 1806.1,
  -243.47, 1807.79, -241.23, 1810.37, -240.95, 1813.73, -242.72, 1817.07, -245.34, 1818.38, -248.17, 1818.02, -253.14,
  1814.21, -254.57, 1821.59, -255.84, 1824.64, -257.56, 1826.83, -259.93, 1828.6, -265.36, 1829.74, -269.28, 1828.71,
  -271.7, 1826.35, -272.85, 1823.01];
const GROTTO = [-200.6, 1836.8]; // OSM node 8569721320
// Places read off the 2025 orthophoto («Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi»): the statue on the pond's
// peninsula, and park lamps along the forecourt north of the palace and round the pond's walk (where the paths run;
// the photographs show the lamps, no data places them)
const STATUE = [-251.6, 1817.2];
const LAMPS = [[-271, 1745.2], [-256, 1746.4], [-241, 1747.6], [-226, 1749.0], [-288.6, 1793.6], [-291.6, 1814.5],
  [-276, 1831.5], [-238.2, 1811.5], [-233.5, 1791.5], [-252.5, 1786.6]];

const WHITE = rgb(0xeeeee9), MARBLE = rgb(0xe8e6df), ROCK_A = rgb(0x6c675b), ROCK_B = rgb(0x837d6f), DARK = rgb(0x0d0d0c);
const GREEN = rgb(0x2f4b3b), LAMPGLASS = rgb(0xfff2d2), IRON = rgb(0x1e2125), KERB = rgb(0xaeaca3);
const LAWN_A = rgb(0x55822c), LAWN_B = rgb(0x6c9636);
// the Kulturetxea's tinted glass
// (lime and yellow triangles, the clear glass between them showing the reading room, a turquoise band along the top)
const GLASS_LIME = rgb(0x8cc020), GLASS_YELLOW = rgb(0xc9c41e), GLASS_AQUA = rgb(0x7b9f9b), GLASS_BAND = rgb(0x62c3b8);

// A building's frame: origin (x, z), +u at `deg` degrees from east towards south, heights from `ground`
function frameOf(x, z, deg, ground) {
  const angle = THREE.MathUtils.degToRad(deg), c = Math.cos(angle), s = Math.sin(angle);
  return {
    x, z, angle, ground,
    world: (u, v) => [x + u * c - v * s, z + u * s + v * c],
    matrix: new THREE.Matrix4().makeRotationY(-angle).setPosition(x, ground, z)
  };
}

// Deterministic hash in [0, 1)
const hash = (a, b = 0) => {
  const h = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return h - Math.floor(h);
};

// The GEO.buildings outline under a point
function buildingAt(GEO, x, z) {
  return GEO.buildings.findIndex((b) => b.g?.[0] && pointInRing(x, z, b.g[0]));
}

export function buildPark(sites, ctx, parts, K, paint) {
  const { GEO, terrain } = ctx;
  const hide = [];
  const builders = [
    ['chapel', [-187.0, 1759.0], chapel], ['guard', [-244.5, 1894.0], guardHouse], ['stables', [-210.0, 1966.0], stables],
    ['dovecote', [-167.25, 1940.76], dovecote]
  ];
  for (const [name, [x, z], fn] of builders) {
    const i = buildingAt(GEO, x, z);
    try {
      const m = fn(ctx, K, paint);
      parts.push(...m.bake());
      if (i >= 0) hide.push(i);
    } catch (e) {
      console.warn(`[landmark aiete ${name}]`, e);
    }
  }
  const kult = sites.find((s) => s.id === 'aiete-kulturetxea');
  if (kult?.footprint) kulturetxea(kult, ctx, paint);
  pond(ctx, paint);
  grotto(ctx, paint);
  for (const [x, z] of LAMPS) lamp(paint, x, terrain.heightAt(x, z), z);
  return hide;
}

// --- shared pieces ------------------------------------------------------------------------------------------------

// Green fretwork along an eave or a verge from a to b ([u, y, v] in the frame): a board with a row of teeth under it
function fretwork(paint, M, a, b, out) {
  const l = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const n = Math.max(1, Math.round(l / 0.24));
  const P = (t, dy, d = 0.04) => new THREE.Vector3(a[0] + (b[0] - a[0]) * t + out[0] * d, a[1] + (b[1] - a[1]) * t + dy,
    a[2] + (b[2] - a[2]) * t + out[1] * d).applyMatrix4(M).toArray();
  const nrm = new THREE.Vector3(out[0], 0, out[1]).transformDirection(M).toArray();
  const col = [...GREEN, 0.55];
  paint.quad(P(0, 0.05), P(1, 0.05), P(1, -0.22), P(0, -0.22), col, nrm);
  paint.quad(P(0, 0.05), P(1, 0.05), P(1, -0.22), P(0, -0.22), col, nrm.map((v) => -v));
  for (let k = 0; k < n; k++) {
    const t0 = k / n, t1 = (k + 1) / n, tm = (t0 + t1) / 2;
    paint.tri(P(t0, -0.22), P(t1, -0.22), P(tm, -0.36), col, nrm);
    paint.tri(P(t0, -0.22), P(t1, -0.22), P(tm, -0.36), col, nrm.map((v) => -v));
  }
}

// A gabled roof over rect u0..u1 x v0..v1 (ridge along `axis`), eaves at y with overhang `over`, rising `rise`; gable
// triangles in the wall's style; fretwork bargeboards and eave boards when `fret`
function gableRoof(m, K, paint, roofMat, wallSt, [u0, u1, v0, v1], y, rise, axis, { over = 0.6, fret = true, ends = [true, true] } = {}) {
  const alongU = axis === 'u';
  const span = alongU ? v1 - v0 : u1 - u0;
  const half = span / 2 + over, drop = over * (rise / (span / 2));
  // two slopes (thin slabs) and the gable walls
  const c = alongU ? (v0 + v1) / 2 : (u0 + u1) / 2;
  const L0 = (alongU ? u0 : v0) - over, L1 = (alongU ? u1 : v1) + over;
  const P = (along, across, yy) => (alongU ? [along, yy, across] : [across, yy, along]);
  for (const side of [-1, 1]) {
    const e0 = P(L0, c + side * half, y - drop), e1 = P(L1, c + side * half, y - drop);
    const r0 = P(L0, c, y + rise), r1 = P(L1, c, y + rise);
    const upN = alongU ? [0, 1, side * 0.6] : [side * 0.6, 1, 0];
    m.faceDir(roofMat, [e0, e1, r1, r0], upN);
    m.faceDir(roofMat, [e0, e1, r1, r0], [-upN[0], -1, -upN[2]]);
    if (fret) fretwork(paint, m.matrix, [e0[0], e0[1] - 0.02, e0[2]], [e1[0], e1[1] - 0.02, e1[2]], alongU ? [0, side] : [side, 0]);
  }
  for (const [k, end] of [[0, alongU ? u0 : v0], [1, alongU ? u1 : v1]]) {
    if (!ends[k]) continue;
    const outDir = k ? 1 : -1;
    const tri = [P(end, c - span / 2, y), P(end, c + span / 2, y), P(end, c, y + rise - 0.05)];
    m.faceDir(m.facade, tri, alongU ? [outDir, 0, 0] : [0, 0, outDir], wallSt);
    if (fret) {
      for (const side of [-1, 1]) {
        const a = P(end + outDir * over, c + side * half, y - drop), b = P(end + outDir * over, c, y + rise);
        fretwork(paint, m.matrix, a, b, alongU ? [outDir, 0] : [0, outDir]);
      }
    }
  }
}

// A hipped roof over a rectangle (CivicModel.pitched with an overhang) and its eave fascia
function hipRoof(m, roofMat, [u0, u1, v0, v1], y, rise, over = 0.45, axis = null) {
  const ax = axis || (u1 - u0 >= v1 - v0 ? 'u' : 'v');
  m.pitched(roofMat, u0 - over, u1 + over, v0 - over, v1 + over, y, rise, { axis: ax, hip: true });
  m.prism(roofMat, rect(u0 - over, u1 + over, v0 - over, v1 + over), y - 0.18, y, null, { top: false, bottom: true });
}

// Walls of a rectangle in four styles [-v, +u, +v, -u] from y0 to y1
function walls(m, K, [u0, u1, v0, v1], y0, y1, styles) {
  const W = (a, b, out, st) => K.wallQuad(m, m.facade, a, b, out, y0, y1, st);
  W([u0, v0], [u1, v0], [0, -1], styles[0]);
  W([u1, v0], [u1, v1], [1, 0], styles[1]);
  W([u1, v1], [u0, v1], [0, 1], styles[2]);
  W([u0, v1], [u0, v0], [-1, 0], styles[3]);
}

// A band (string course, cornice, plinth) round a rectangle, proud by d
function bandRect(m, K, [u0, u1, v0, v1], y0, y1, d, st) {
  m.prism(m.facade, rect(u0 - d, u1 + d, v0 - d, v1 + d), y0, y1, st, { bottom: true });
}

// --- the chapel -----------------------------------------------------------------------------------------------------

function chapel(ctx, K, paint) {
  const { terrain, kit } = ctx;
  const f0 = frameOf(-187.88, 1757.53, 6.33, 0);
  const G = terrain.heightAt(...f0.world(0.7, -3.6));
  const fr = frameOf(-187.88, 1757.53, 6.33, G);
  const m = new K.AieteModel(fr);
  const { slate, iron } = kit.materials;
  const W = K.PAL.white;
  const body = [-3.47, 4.95, -2.31, 4.14];
  const low = Math.min(...[[-3.47, -2.31], [4.95, -2.31], [4.95, 4.14], [-3.47, 4.14]].map(([u, v]) => terrain.heightAt(...fr.world(u, v)))) - G;
  const P = Math.min(low, 0) - 0.3;
  const FLR = 0.6, F1 = 4.0, LOG = 7.2, EAVE = 9.7;
  const grey = K.style({ palette: K.PAL.grey, flags: K.FLAG.ashlar });
  const gf = K.style({ bay: 3.0, sill: 1.1, head: 3.55, half: 0.55, arch: 1, shutter: K.SH.glass, palette: W });
  const f1 = K.style({ bay: 3.0, sill: 4.7, head: 6.6, half: 0.5, palette: W });
  walls(m, K, body, P, FLR, [grey, grey, grey, grey]);
  walls(m, K, body, FLR, F1, [gf, gf, gf, gf]);
  walls(m, K, body, F1, LOG, [f1, f1, f1, f1]);
  bandRect(m, K, body, F1 - 0.15, F1 + 0.05, 0.1, K.style({ palette: W }));
  bandRect(m, K, body, LOG - 0.1, LOG + 0.12, 0.35, K.style({ palette: W }));
  // the loggia: the inner wall set back with glazed doors, piers at the corners and posts between, a balustrade
  const inner = [body[0] + 0.9, body[1] - 0.9, body[2] + 0.9, body[3] - 0.9];
  const doors = K.style({ bay: 1.8, sill: LOG + 0.2, head: EAVE - 0.4, half: 0.45, shutter: K.SH.glass, palette: W });
  walls(m, K, inner, LOG, EAVE, [doors, doors, doors, doors]);
  const bal = K.style({ bay: 0.28, head: LOG + 1.07, base: LOG + 0.12, palette: W, flags: K.FLAG.balustrade });
  const [u0, u1, v0, v1] = body;
  for (const [a, b] of [[[u0, v0], [u1, v0]], [[u1, v0], [u1, v1]], [[u1, v1], [u0, v1]], [[u0, v1], [u0, v0]]]) {
    m.wall(m.facade, [a[0] + Math.sign(b[0] - a[0]) * 0.1, a[1] + Math.sign(b[1] - a[1]) * 0.1], b, 0.2, LOG + 0.12, LOG + 1.07, bal);
    m.wall(m.facade, a, b, 0.3, LOG + 1.07, LOG + 1.17, K.style({ palette: W }));
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.round(l / 2.2));
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = a[0] + (b[0] - a[0]) * t, v = a[1] + (b[1] - a[1]) * t;
      const w = k === 0 || k === n ? 0.32 : 0.16;
      m.box(m.facade, u - w, u + w, LOG + 0.12, EAVE, v - w, v + w, K.style({ palette: W }));
    }
  }
  hipRoof(m, slate, body, EAVE, 1.25, 0.5);
  // the turret on the north-west corner, its belvedere windows above the loggia, its slate cone and finial
  const tu = -3.6, tv = -2.95, tr = 1.3;
  const ring = ngon(tu, tv, tr, 12);
  m.prism(m.facade, ring, P, FLR, grey, { top: false, smooth: true, continuous: true });
  m.prism(m.facade, ring, FLR, 10.4, K.style({ bay: 2.2, sill: 2.0, head: 2.9, half: 0.18, shutter: K.SH.glass, palette: W }),
    { top: false, smooth: true, continuous: true });
  m.prism(m.facade, ring, 7.4, 10.4, K.style({ bay: 1.4, sill: 8.2, head: 9.8, half: 0.28, shutter: K.SH.glass, palette: W }),
    { top: false, smooth: true, continuous: true });
  m.prism(m.facade, ngon(tu, tv, tr + 0.18, 12), 10.4, 10.75, K.style({ palette: W }), { smooth: true });
  m.dome(slate, tu, tv, 10.75, [[tr + 0.12, 0], [tr, 0.2], [0.07, 3.0]], 12);
  m.beam(iron, [tu, 13.6, tv], [tu, 14.3, tv], 0.04, 0.04);
  // steps to the north door
  K.steps(m, m.facade, grey, 'v', -2.6, 3.4, -4.3, -2.31, terrain.heightAt(...fr.world(0.4, -4.4)) - G, FLR, 4, P);
  return m;
}

// --- the guard's house ----------------------------------------------------------------------------------------------

function guardHouse(ctx, K, paint) {
  const { terrain, kit } = ctx;
  const f0 = frameOf(-244.53, 1896.17, -3.61, 0);
  const G = terrain.heightAt(...f0.world(0, 5.5));
  const fr = frameOf(-244.53, 1896.17, -3.61, G);
  const m = new K.AieteModel(fr);
  const { slate } = kit.materials;
  const R = K.PAL.red;
  const main = [-3.57, 3.58, -4.95, 0.78], wing = [-2.95, 2.09, 0.71, 4.95];
  const P = -0.6, EAVE = 8.0, F1 = 4.0;
  const sand = K.style({ palette: K.PAL.sand, flags: K.FLAG.ashlar });
  const red = (o) => K.style({ palette: R, flags: K.FLAG.quoins, ...o });
  const gfW = red({ bay: 2.6, sill: 1.1, head: 3.2, half: 0.5 }), f1W = red({ bay: 2.6, sill: 4.8, head: 6.8, half: 0.48 });
  const door = red({ bay: 4.2, sill: 0.45, head: 2.9, half: 0.48, shutter: K.SH.boards });
  for (const r of [main, wing]) {
    walls(m, K, r, P, 0.45, [sand, sand, sand, sand]);
    bandRect(m, K, r, F1 - 0.12, F1 + 0.12, 0.08, K.style({ palette: K.PAL.sand }));
  }
  // the main block's north and end walls, the wing's three walls (the door on its east side)
  walls(m, K, main, 0.45, F1, [gfW, gfW, red(), gfW]);
  walls(m, K, main, F1, EAVE, [f1W, f1W, red(), f1W]);
  walls(m, K, wing, 0.45, F1, [red(), door, gfW, gfW]);
  walls(m, K, wing, F1, EAVE, [red(), f1W, f1W, red()]);
  // the stone balcony under the gable's east window, on two consoles
  const bu = 0.82;
  m.box(m.facade, bu - 0.75, bu + 0.75, F1 - 0.05, F1 + 0.18, 4.95, 5.6, K.style({ palette: K.PAL.sand }));
  m.box(m.facade, bu - 0.75, bu + 0.75, F1 + 0.18, F1 + 0.85, 5.48, 5.6, K.style({ palette: K.PAL.sand }));
  for (const du of [-0.55, 0.55]) m.box(m.facade, bu + du - 0.1, bu + du + 0.1, F1 - 0.6, F1 - 0.05, 4.95, 5.4, K.style({ palette: K.PAL.sand }));
  // roofs: the main block's gable east-west, the wing's north-south with its gable to the park
  const rise = 1.6;
  gableRoof(m, K, paint, slate, red(), main, EAVE, rise, 'u', { over: 0.65 });
  gableRoof(m, K, paint, slate, red(), wing, EAVE, rise - 0.15, 'v', { over: 0.65, ends: [false, true] });
  // a brick chimney
  m.box(m.facade, 1.8, 2.4, EAVE, EAVE + rise + 0.9, -2.6, -1.9, K.style({ palette: K.PAL.brick, flags: K.FLAG.brick }));
  m.box(m.facade, 1.7, 2.5, EAVE + rise + 0.9, EAVE + rise + 1.0, -2.7, -1.8, K.style({ palette: K.PAL.grey }));
  return m;
}

// --- the stables ----------------------------------------------------------------------------------------------------

function stables(ctx, K, paint) {
  const { terrain, kit } = ctx;
  const f0 = frameOf(-201.72, 1964.35, -27.55, 0);
  const G = terrain.heightAt(...f0.world(0, -13.5));
  const fr = frameOf(-201.72, 1964.35, -27.55, G);
  const m = new K.AieteModel(fr);
  const { slate } = kit.materials;
  const R = K.PAL.red;
  const west = [-12.6, -5.85, -11.75, 11.77], east = [5.68, 12.6, -11.71, 11.78], centre = [-5.85, 5.68, -8.4, 3.92];
  const porch = [-5.85, 5.68, -11.36, -8.4];
  const low = Math.min(...[[-12.6, -11.75], [12.6, -11.71], [12.6, 11.78], [-12.6, 11.77]].map(([u, v]) => terrain.heightAt(...fr.world(u, v)))) - G;
  const P = Math.min(low, 0) - 0.3;
  const F1 = 4.6, EAVE = 8.2, CEAVE = 7.4;
  const sand = K.style({ palette: K.PAL.sand, flags: K.FLAG.ashlar });
  const red = (o) => K.style({ palette: R, flags: K.FLAG.quoins, ...o });
  const arch = red({ bay: 6.7, sill: 0.25, head: 3.9, half: 2.2, arch: 2, shutter: K.SH.boards });
  const gfW = red({ bay: 3.3, sill: 1.1, head: 3.4, half: 0.5 });
  const f1W = red({ bay: 3.3, sill: 5.3, head: 7.0, half: 0.48 });
  const f1Front = red({ bay: 3.3, sill: 5.3, head: 7.0, half: 0.55 });
  // the wings: their fronts a great arch under two windows, their long sides windows on both floors
  for (const r of [west, east]) {
    walls(m, K, r, P, 0.25, [sand, sand, sand, sand]);
    walls(m, K, r, 0.25, F1, [arch, gfW, gfW, gfW]);
    walls(m, K, r, F1, EAVE, [f1Front, f1W, f1W, f1W]);
    bandRect(m, K, r, F1 - 0.15, F1 + 0.1, 0.08, K.style({ palette: K.PAL.sand }));
    bandRect(m, K, r, EAVE - 0.3, EAVE, 0.18, K.style({ palette: K.PAL.sand }));
    hipRoof(m, slate, r, EAVE, 2.2, 0.45, 'v');
  }
  // the centre: the porch's great arch, the terrace over it with its balustrade, the first floor set back
  const porchArch = red({ bay: 11.5, sill: 0.25, head: 4.1, half: 4.3, arch: 2, shutter: K.SH.boards });
  K.wallQuad(m, m.facade, [porch[0], porch[2]], [porch[1], porch[2]], [0, -1], 0.25, F1, porchArch);
  K.wallQuad(m, m.facade, [porch[0], porch[2]], [porch[1], porch[2]], [0, -1], P, 0.25, sand);
  m.box(m.facade, porch[0], porch[1], F1 - 0.2, F1 + 0.05, porch[2] - 0.15, porch[3], K.style({ palette: K.PAL.sand }));
  const bal = K.style({ bay: 0.3, head: F1 + 0.95, base: F1 + 0.05, palette: K.PAL.sand, flags: K.FLAG.balustrade });
  m.wall(m.facade, [porch[0], porch[2] + 0.05], [porch[1], porch[2] + 0.05], 0.22, F1 + 0.05, F1 + 0.95, bal);
  m.wall(m.facade, [porch[0], porch[2] + 0.05], [porch[1], porch[2] + 0.05], 0.36, F1 + 0.95, F1 + 1.07, K.style({ palette: K.PAL.sand }));
  walls(m, K, centre, P, 0.25, [sand, sand, sand, sand]);
  walls(m, K, centre, 0.25, F1, [red(), red(), gfW, red()]);
  walls(m, K, centre, F1, CEAVE, [f1Front, red(), f1W, red()]);
  bandRect(m, K, centre, CEAVE - 0.25, CEAVE, 0.15, K.style({ palette: K.PAL.sand }));
  hipRoof(m, slate, [centre[0], centre[1], porch[2], centre[3]], CEAVE, 1.9, 0.3, 'u');
  // the clock gable on the centre roof's front and its little bell-cote
  {
    const v = porch[2] + 0.1, y0 = CEAVE - 0.1;
    const st = K.style({ palette: K.PAL.sand });
    m.box(m.facade, -1.15, 1.15, y0, y0 + 1.35, v, v + 1.6, st);
    m.pitched(slate, -1.3, 1.3, v - 0.1, v + 1.7, y0 + 1.35, 0.75, { axis: 'v', endMat: m.facade, endStyle: st });
    for (const [du, dv] of [[-0.42, 0.45], [0.42, 0.45], [-0.42, 1.15], [0.42, 1.15]]) {
      m.box(m.facade, du - 0.06, du + 0.06, y0 + 1.9, y0 + 2.55, v + dv - 0.06, v + dv + 0.06, st);
    }
    m.pitched(slate, -0.6, 0.6, v + 0.2, v + 1.4, y0 + 2.55, 0.55, { hip: true });
    const M = m.matrix;
    paint.add(new THREE.CircleGeometry(0.45, 20).rotateY(Math.PI).translate(0, y0 + 0.75, v - 0.02), [...WHITE, 0.4], M);
    paint.add(new THREE.BoxGeometry(0.05, 0.36, 0.02).translate(0, y0 + 0.88, v - 0.04), [...DARK, 0.5], M);
    paint.add(new THREE.BoxGeometry(0.26, 0.05, 0.02).translate(0.1, y0 + 0.75, v - 0.045), [...DARK, 0.5], M);
  }
  return m;
}

// --- the dovecote ---------------------------------------------------------------------------------------------------

function dovecote(ctx, K, paint) {
  const { terrain, kit } = ctx;
  const f0 = frameOf(-167.25, 1940.76, -19.61, 0);
  const G = terrain.heightAt(...f0.world(0, -4.5));
  const fr = frameOf(-167.25, 1940.76, -19.61, G);
  const m = new K.AieteModel(fr);
  const { zinc } = kit.materials;
  const PK = K.PAL.pink;
  // the 1:500 outline under one gabled roof; the boarded walls stand back from its north edge behind the veranda
  const body = [-7.64, 7.64, -3.01, 3.01], shed = [-7.64, 7.64, -1.75, 3.01];
  const EAVE = 3.2, rise = 1.85;
  const grey = K.style({ palette: K.PAL.grey, flags: K.FLAG.ashlar });
  const boards = (o) => K.style({ palette: PK, flags: K.FLAG.timber, ...o });
  const doors = boards({ bay: 2.2, sill: 0.3, head: 2.35, half: 0.42, shutter: K.SH.boards });
  const hi = boards({ bay: 2.5, sill: 1.75, head: 2.6, half: 0.38, shutter: K.SH.glass });
  walls(m, K, body, -0.6, 0, [grey, grey, grey, grey]);
  m.cap(m.facade, rect(...body), 0, true, grey);
  walls(m, K, shed, 0, EAVE, [doors, hi, boards(), hi]);
  gableRoof(m, K, paint, zinc, boards(), body, EAVE, rise, 'u', { over: 0.5 });
  // the veranda along the north side: green posts and a beam under the eave
  const M = m.matrix;
  for (let k = 0; k <= 7; k++) {
    const u = -7.45 + (14.9 * k) / 7;
    paint.add(new THREE.BoxGeometry(0.13, EAVE, 0.13).translate(u, EAVE / 2, -2.88), [...GREEN, 0.55], M);
  }
  paint.add(new THREE.BoxGeometry(15.1, 0.2, 0.14).translate(0, EAVE - 0.1, -2.88), [...GREEN, 0.55], M);
  // the tower, where the orthophoto shows it on the ridge: three octagonal tiers of pigeon holes under green skirts,
  // the ribbed zinc dome and a finial
  const tu = -0.56, tv = -0.37;
  const tiers = [[1.3, 3.2, 5.5], [1.12, 5.5, 7.0], [0.96, 7.0, 8.25]];
  tiers.forEach(([r, y0, y1], k) => {
    const st = boards({ bay: 0.95, sill: y0 + 0.45 + (k ? 0 : 1.5), head: y0 + 0.85 + (k ? 0 : 1.5), half: 0.13, shutter: K.SH.glass, flags: 0 });
    m.prism(m.facade, ngon(tu, tv, r, 8, Math.PI / 8), y0, y1, st, { top: false, continuous: true });
    // the skirt: a green flared roof round the tier's top, seen from above and below
    const lo = ngon(tu, tv, r + 0.5, 8, Math.PI / 8), up = ngon(tu, tv, r + 0.02, 8, Math.PI / 8);
    for (let i = 0; i < 8; i++) {
      const j = (i + 1) % 8;
      const q = [[lo[2 * i], y1 - 0.42, lo[2 * i + 1]], [lo[2 * j], y1 - 0.42, lo[2 * j + 1]], [up[2 * j], y1, up[2 * j + 1]], [up[2 * i], y1, up[2 * i + 1]]]
        .map((p) => new THREE.Vector3(...p).applyMatrix4(M).toArray());
      const mid = [(lo[2 * i] + lo[2 * j]) / 2 - tu, (lo[2 * i + 1] + lo[2 * j + 1]) / 2 - tv];
      const outW = new THREE.Vector3(mid[0], 0.9, mid[1]).transformDirection(M).toArray();
      paint.quad(q[0], q[1], q[2], q[3], [...GREEN, 0.55], outW);
      paint.quad(q[0], q[1], q[2], q[3], [...GREEN, 0.55], outW.map((x) => -x));
    }
  });
  m.dome(zinc, tu, tv, 8.25, [[0.98, 0], [1.05, 0.3], [0.9, 0.7], [0.55, 1.05], [0.15, 1.3], [0.04, 1.4]], 8, { phase: Math.PI / 8 });
  paint.add(new THREE.SphereGeometry(0.09, 8, 6).translate(tu, 9.75, tv), [...rgb(0x8a8f92), FINISH.metal + 0.4], M);
  paint.add(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 5).translate(tu, 9.55, tv), [...rgb(0x8a8f92), FINISH.metal + 0.4], M);
  return m;
}

// --- the Kulturetxea -------------------------------------------------------------------------------------------------

function kulturetxea(site, ctx, paint) {
  const { terrain } = ctx;
  const ring = cleanRing(site.footprint);
  // the glass front: the outline's chain between its westernmost and easternmost corners on the north side
  const n = ring.length / 2;
  let iw = 0, ie = 0;
  for (let k = 0; k < n; k++) {
    if (ring[2 * k] < ring[2 * iw]) iw = k;
    if (ring[2 * k] > ring[2 * ie]) ie = k;
  }
  const chain = (from, to, step) => {
    const out = [];
    for (let k = from; ; k = (k + step + n) % n) {
      out.push([ring[2 * k], ring[2 * k + 1]]);
      if (k === to) break;
    }
    return out;
  };
  const a = chain(iw, ie, 1), b = chain(iw, ie, -1);
  const meanZ = (c) => c.reduce((s, p) => s + p[1], 0) / c.length;
  const front = meanZ(a) < meanZ(b) ? a : b;
  // resample every 1.25 m, the normal pointing north (away from the roof)
  const pts = [];
  for (let k = 0; k + 1 < front.length; k++) {
    const [x0, z0] = front[k], [x1, z1] = front[k + 1];
    const l = Math.hypot(x1 - x0, z1 - z0), m = Math.max(1, Math.round(l / 1.25));
    for (let j = 0; j < m; j++) {
      const t = j / m;
      let nx = (z1 - z0) / l, nz = -(x1 - x0) / l;
      if (nz > 0) { nx = -nx; nz = -nz; }
      pts.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, nx, nz });
    }
  }
  const last = front[front.length - 1];
  pts.push({ ...pts[pts.length - 1], x: last[0], z: last[1] });
  // the LiDAR's 2 m grid smears the 4 m step into a bank: stand the glass where the lower lawn still runs flat
  let push = 0;
  for (const p of pts) {
    const lawn = terrain.heightAt(p.x + p.nx * 6, p.z + p.nz * 6);
    let d = 0;
    while (d < 3.5 && terrain.heightAt(p.x + p.nx * d, p.z + p.nz * d) > lawn + 0.3) d += 0.25;
    push = Math.max(push, d);
  }
  push = Math.min(push, 3.0);
  let s = 0;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    if (k) s += Math.hypot(p.x - pts[k - 1].x, p.z - pts[k - 1].z);
    p.s = s;
    p.fx = p.x + p.nx * push;
    p.fz = p.z + p.nz * push;
    p.bot = terrain.heightAt(p.x + p.nx * (push + 2.5), p.z + p.nz * (push + 2.5)) - 0.1;
    p.top = terrain.heightAt(p.x - p.nx * 4.5, p.z - p.nz * 4.5) + 0.1;
  }
  const total = s;
  const nrm = (p) => [p.nx, 0, p.nz];
  const at = (p, y, d = 0) => [p.fx + p.nx * d, y, p.fz + p.nz * d];
  // the zig-zag of big triangles (9.6 m bases) over the glass under a pale band; white struts along their sides
  const TRI = 9.6, BAND = 0.75;
  const HALF = TRI / 2;
  const diag = (t) => {
    // the zig-zag's height at t as a share of the glass under the band: apexes at even multiples of HALF
    const k = Math.floor(t / HALF), f = t / HALF - k;
    return k % 2 === 0 ? 1 - f : f;
  };
  const triCol = (t) => (Math.floor(t / TRI) % 2 ? GLASS_YELLOW : GLASS_LIME);
  const GL = FINISH.litGlass + 0.06; // (a faint glow at night, the library closed, that leaves the tints)
  for (let k = 0; k + 1 < pts.length; k++) {
    const p = pts[k], q = pts[k + 1];
    const h0 = p.top - p.bot, h1 = q.top - q.bot;
    if (Math.min(h0, h1) < 0.9) continue;
    const yt0 = p.top - BAND, yt1 = q.top - BAND;
    // the panel cut where the zig-zag turns, each piece split along the diagonal: the triangle standing on the ground
    // below it in lime or yellow, aqua above
    const cuts = [p.s];
    for (let c = (Math.floor(p.s / HALF) + 1) * HALF; c < q.s; c += HALF) cuts.push(c);
    cuts.push(q.s);
    for (let c = 0; c + 1 < cuts.length; c++) {
      const ta = cuts[c], tb = cuts[c + 1];
      const A = sample(pts, Math.min(ta, total)) || p, B = sample(pts, Math.min(tb, total)) || q;
      const ya0 = A.bot, yb0 = B.bot, ya1 = A.top - BAND, yb1 = B.top - BAND;
      const eps = 1e-4;
      const da = diag(ta + eps), db = diag(tb - eps);
      const ma = ya0 + (ya1 - ya0) * da, mb = yb0 + (yb1 - yb0) * db;
      paint.quad(at(A, ya0), at(B, yb0), at(B, mb), at(A, ma), [...triCol((ta + tb) / 2), GL], nrm(p));
      paint.quad(at(A, ma), at(B, mb), at(B, yb1), at(A, ya1), [...GLASS_AQUA, GL], nrm(p));
    }
    paint.quad(at(p, yt0), at(q, yt1), at(q, q.top), at(p, p.top), [...GLASS_BAND, GL], nrm(p));
    // the white mullion at the panel's start, the transom under the band
    const mull = (pp, yb, yt) => paint.quad(at(pp, yb, 0.04), at(pp, yt, 0.04), [at(pp, yt, 0.04)[0] + pp.nz * 0.06, yt, at(pp, yt, 0.04)[2] - pp.nx * 0.06],
      [at(pp, yb, 0.04)[0] + pp.nz * 0.06, yb, at(pp, yb, 0.04)[2] - pp.nx * 0.06], [...WHITE, 0.4], nrm(pp));
    mull(p, p.bot, p.top);
    paint.quad(at(p, yt0 - 0.04, 0.04), at(q, yt1 - 0.04, 0.04), at(q, yt1 + 0.04, 0.04), at(p, yt0 + 0.04, 0.04), [...WHITE, 0.4], nrm(p));
    // the coping along the top, the dark plinth at the foot
    paint.quad(at(p, p.top + 0.32, 0.12), at(q, q.top + 0.32, 0.12), at(q, q.top - 0.05, 0.12), at(p, p.top - 0.05, 0.12), [...WHITE, 0.45], nrm(p));
    paint.quad(at(p, p.top + 0.32, 0.12), at(q, q.top + 0.32, 0.12), at(q, q.top + 0.32, -0.6), at(p, p.top + 0.32, -0.6), [...WHITE, 0.45], [0, 1, 0]);
    paint.quad(at(p, p.bot + 0.18, 0.03), at(q, q.bot + 0.18, 0.03), at(q, q.bot - 0.3, 0.03), at(p, p.bot - 0.3, 0.03), [...rgb(0x3a3d3f), 0.6], nrm(p));
    // the railing on the coping
    const ry = (pp) => pp.top + 0.32;
    paint.quad(at(p, ry(p) + 1.0, -0.2), at(q, ry(q) + 1.0, -0.2), at(q, ry(q) + 0.95, -0.2), at(p, ry(p) + 0.95, -0.2), [...IRON, FINISH.metal + 0.5], nrm(p));
    if (k % 2 === 0) paint.add(new THREE.BoxGeometry(0.04, 1.0, 0.04).translate(...at(p, ry(p) + 0.5, -0.2)), [...IRON, FINISH.metal + 0.5]);
  }
  // the struts: white diagonals along the triangles' sides (the steel frame behind the glass)
  for (let t = 0; t + TRI / 2 <= total; t += TRI / 2) {
    const up = Math.round(t / (TRI / 2)) % 2 === 0;
    const pa = sample(pts, t), pb = sample(pts, t + TRI / 2);
    if (!pa || !pb || pa.top - pa.bot < 0.9 || pb.top - pb.bot < 0.9) continue;
    const ya = up ? pa.bot : pa.top - BAND, yb = up ? pb.top - BAND : pb.bot;
    const A = at(pa, ya, 0.05), B = at(pb, yb, 0.05);
    const dir = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    // across the strut, in the glass's plane: normal x strut
    const nn = [pa.nx, 0, pa.nz];
    const across = [nn[1] * dir[2] - nn[2] * dir[1], nn[2] * dir[0] - nn[0] * dir[2], nn[0] * dir[1] - nn[1] * dir[0]];
    const w = 0.06 / (Math.hypot(...across) || 1);
    paint.quad([A[0] - across[0] * w, A[1] - across[1] * w, A[2] - across[2] * w], [B[0] - across[0] * w, B[1] - across[1] * w, B[2] - across[2] * w],
      [B[0] + across[0] * w, B[1] + across[1] * w, B[2] + across[2] * w], [A[0] + across[0] * w, A[1] + across[1] * w, A[2] + across[2] * w],
      [...WHITE, 0.4], nrm(pa));
  }
  // two doors in the glass
  for (const f of [0.36, 0.66]) {
    const p = sample(pts, total * f), q = sample(pts, total * f + 2.2);
    if (!p || !q) continue;
    paint.quad(at(p, p.bot + 0.1, 0.07), at(q, q.bot + 0.1, 0.07), at(q, q.bot + 2.6, 0.07), at(p, p.bot + 2.6, 0.07), [...rgb(0x4a5254), FINISH.litGlass + 0.06], nrm(p));
  }
  // the lawn on its roof: a 2 m grid over the outline (its front pushed out to the glass), on the terrain or the
  // glass's top, whichever is higher, in the lawn's two greens
  const roofRing = [];
  for (const p of [...pts].reverse()) roofRing.push(p.fx, p.fz);
  const back = (meanZ(a) < meanZ(b) ? b : a).slice(1, -1);
  // (the back chain runs from the west corner to the east one, closing the ring)
  for (const [x, z] of back) roofRing.push(x, z);
  const nearTop = (x, z) => {
    let best = Infinity, top = -Infinity;
    for (const p of pts) {
      const d = Math.hypot(p.fx - x, p.fz - z);
      if (d < best) { best = d; top = p.top; }
    }
    return best < 5 ? top + 0.33 : -Infinity;
  };
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < roofRing.length; k += 2) {
    minX = Math.min(minX, roofRing[k]); maxX = Math.max(maxX, roofRing[k]);
    minZ = Math.min(minZ, roofRing[k + 1]); maxZ = Math.max(maxZ, roofRing[k + 1]);
  }
  const S = 2;
  const Y = (x, z) => Math.max(terrain.heightAt(x, z) + 0.06, nearTop(x, z));
  const C = (x, z) => {
    const h = hash(Math.round(x * 0.37), Math.round(z * 0.41)) * 0.6 + hash(Math.round(x * 0.11), Math.round(z * 0.13)) * 0.4;
    return [0, 1, 2].map((c) => LAWN_A[c] + (LAWN_B[c] - LAWN_A[c]) * h);
  };
  const pos = [], col = [];
  for (let x = Math.floor(minX / S) * S; x < maxX; x += S) {
    for (let z = Math.floor(minZ / S) * S; z < maxZ; z += S) {
      if (!pointInRing(x + S / 2, z + S / 2, roofRing)) continue;
      const q = [[x, z], [x + S, z], [x + S, z + S], [x, z + S]];
      for (const tri of [[0, 2, 1], [0, 3, 2]]) {
        for (const i of tri) {
          pos.push(q[i][0], Y(q[i][0], q[i][1]), q[i][1]);
          col.push(...C(q[i][0], q[i][1]), 0.95);
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  // per-vertex paint: add() takes one paint per geometry, so push the triangles' paints directly
  const before = paint.count;
  paint.add(g, [0, 0, 0, 0.95]);
  for (let i = 0; i < col.length / 4; i++) paint.paint.splice((before + i) * 4, 4, col[4 * i], col[4 * i + 1], col[4 * i + 2], col[4 * i + 3]);
  // the skylight strip near its east end (orthophoto)
  const sk = [[-207.4, 1728.4], [-204.4, 1728.4], [-204.4, 1742.4], [-207.4, 1742.4]];
  const yk = (p) => Y(p[0], p[1]) + 0.05;
  paint.quad([sk[0][0], yk(sk[0]), sk[0][1]], [sk[3][0], yk(sk[3]), sk[3][1]], [sk[2][0], yk(sk[2]), sk[2][1]], [sk[1][0], yk(sk[1]), sk[1][1]],
    [...rgb(0x2a3336), FINISH.litGlass + 0.4], [0, 1, 0]);
}

// The point at distance t along the resampled front (interpolated)
function sample(pts, t) {
  for (let k = 0; k + 1 < pts.length; k++) {
    const p = pts[k], q = pts[k + 1];
    if (t >= p.s && t <= q.s) {
      const f = (t - p.s) / (q.s - p.s || 1);
      const L = (key) => p[key] + (q[key] - p[key]) * f;
      return { ...p, fx: L('fx'), fz: L('fz'), bot: L('bot'), top: L('top'), s: t };
    }
  }
  return null;
}

// --- the pond, its statue, the grotto, the lamps --------------------------------------------------------------------

function pond(ctx, paint) {
  const { terrain } = ctx;
  const n = POND.length / 2;
  // the kerb: a 0.55 m stone coping round the water, its top 18 cm over the bank
  let sumY = 0;
  for (let k = 0; k < n; k++) sumY += terrain.heightAt(POND[2 * k], POND[2 * k + 1]);
  const yTop = sumY / n + 0.18;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += POND[2 * j] * POND[2 * i + 1] - POND[2 * i] * POND[2 * j + 1];
  const sg = area > 0 ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const x0 = POND[2 * k], z0 = POND[2 * k + 1], x1 = POND[2 * j], z1 = POND[2 * j + 1];
    const l = Math.hypot(x1 - x0, z1 - z0);
    // outward normal (away from the water)
    const nx = (sg * (z1 - z0)) / l, nz = (-sg * (x1 - x0)) / l;
    const g = new THREE.BoxGeometry(l + 0.5, 0.75, 0.55);
    g.rotateY(-Math.atan2(z1 - z0, x1 - x0));
    g.translate((x0 + x1) / 2 + nx * 0.2, yTop - 0.375, (z0 + z1) / 2 + nz * 0.2);
    paint.add(g, [...KERB, 0.85]);
  }
  // the statue on its rock: a draped figure of white marble, one arm raised
  const [sx, sz] = STATUE;
  const sy = terrain.heightAt(sx, sz);
  rock(paint, sx, sy - 0.3, sz, 1.4, 0.9, 1.2, 3);
  const top = sy + 0.75;
  const M = new THREE.Matrix4().makeRotationY(-0.6).setPosition(sx, top, sz);
  const fig = (g) => paint.add(g, [...MARBLE, 0.5], M);
  fig(new THREE.CylinderGeometry(0.2, 0.36, 0.9, 10).translate(0, 0.45, 0)); // drapery
  fig(new THREE.CylinderGeometry(0.15, 0.2, 0.55, 10).translate(0, 1.15, 0)); // torso
  fig(new THREE.SphereGeometry(0.12, 10, 8).translate(0, 1.55, 0)); // head
  fig(new THREE.CylinderGeometry(0.045, 0.05, 0.62, 6).rotateZ(-0.5).translate(0.2, 1.55, 0)); // raised arm
  fig(new THREE.CylinderGeometry(0.045, 0.05, 0.5, 6).rotateZ(0.25).translate(-0.2, 1.1, 0.05)); // the other
}

// A lump of rock (an icosahedron jittered by a seed, scaled), tufa grey
function rock(paint, x, y, z, sx, sy, sz, seed) {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const p = g.attributes.position.array;
  for (let i = 0; i < p.length; i += 3) {
    const key = Math.round(p[i] * 50) * 7 + Math.round(p[i + 1] * 50) * 13 + Math.round(p[i + 2] * 50) * 19;
    const f = 0.82 + hash(key, seed) * 0.36;
    p[i] *= sx * f; p[i + 1] *= sy * f; p[i + 2] *= sz * f;
  }
  g.translate(x, y, z);
  g.computeVertexNormals();
  paint.add(g, [...(seed % 2 ? ROCK_A : ROCK_B), 0.95]);
}

function grotto(ctx, paint) {
  const { terrain } = ctx;
  const [gx, gz] = GROTTO;
  // the cave mouth faces down the slope (the terrain falls to the east-south-east)
  const dx = terrain.heightAt(gx - 3, gz) - terrain.heightAt(gx + 3, gz), dz = terrain.heightAt(gx, gz - 3) - terrain.heightAt(gx, gz + 3);
  const l = Math.hypot(dx, dz) || 1;
  const fx = dx / l, fz = dz / l, sx = -fz, sz = fx;
  const y0 = terrain.heightAt(gx, gz);
  // a ring of rocks round the mouth, piled higher behind it
  const pile = [[-2.3, 0, 1.3, 1.5, 1.4], [2.3, 0.1, 1.4, 1.4, 1.3], [-1.6, -1.4, 1.6, 1.9, 1.5], [1.7, -1.3, 1.5, 1.8, 1.6],
    [0, -1.9, 2.2, 1.6, 1.6], [0, -0.6, 1.9, 0.9, 1.2], [-3.2, -1.2, 1.2, 1.1, 1.2], [3.2, -1.0, 1.1, 1.0, 1.2]];
  pile.forEach(([a, b, rx, ry, rz], k) => {
    const x = gx + sx * a + fx * b, z = gz + sz * a + fz * b;
    rock(paint, x, terrain.heightAt(x, z) + ry * 0.45, z, rx, ry, rz, k + 11);
  });
  // the dark mouth: a half-disc standing at the front of the pile
  const mouth = new THREE.CircleGeometry(1.0, 14, 0, Math.PI).scale(1.0, 1.35, 1);
  const yaw = Math.atan2(fx, fz);
  mouth.rotateY(yaw);
  mouth.translate(gx + fx * 0.55, y0 - 0.05, gz + fz * 0.55);
  paint.add(mouth, [...DARK, 0.95]);
}

// A white cast-iron park lamp: a stepped base, a fluted post, a collar, a hexagonal lantern under a cap
function lamp(paint, x, y, z) {
  const W = [...WHITE, 0.45];
  paint.add(new THREE.CylinderGeometry(0.17, 0.21, 0.55, 8).translate(x, y + 0.27, z), W);
  paint.add(new THREE.CylinderGeometry(0.06, 0.09, 2.45, 8).translate(x, y + 1.75, z), W);
  paint.add(new THREE.CylinderGeometry(0.1, 0.07, 0.16, 8).translate(x, y + 3.03, z), W);
  paint.add(new THREE.CylinderGeometry(0.2, 0.13, 0.5, 6).translate(x, y + 3.36, z), [...LAMPGLASS, FINISH.lamp + 0.95]);
  paint.add(new THREE.CylinderGeometry(0.03, 0.25, 0.2, 6).translate(x, y + 3.71, z), W);
  paint.add(new THREE.SphereGeometry(0.05, 6, 4).translate(x, y + 3.85, z), W);
}

