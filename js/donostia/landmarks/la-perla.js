import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, abs, max, min, mix, floor, fract, sin, dot, clamp, length, smoothstep, step, select,
  fwidth, normalize, positionWorld, normalWorld, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { PartBin, Frame, westMaterials as M, rgb } from './igeldo.js';
import {
  cleanRing, simplify, wound, ringArea, insetRing, pointInRing, distToRing, clipRing, hipRoof, centroid
} from './geom.js';

// js/donostia/landmarks/la-perla.js
// La Perla (La Perla del Océano), the bathing establishment on the sand of La Concha at the foot of the promenade, now
// a thalassotherapy centre with its gym, restaurants and cafés (Kontxa pasealekua 8-16). Ramón Cortázar built it in
// 1909-1911 on piles over the sand (Donostia's heritage plan, PEPPUC 2021, card "La Perla eraikina", level A); it was
// demolished and rebuilt in 1993 with its rendered fronts reconstructed. One building 125 m long:
//  - a storey at beach level the whole length of it (the thalassotherapy, the gym, the Café de la Concha's restaurant
//    and night club), its front to the sand an arcade of arched windows behind columns and white cast-iron
//    balustrades on a plinth with round vents; its roof is the terraces, level with the promenade;
//  - three pavilions at promenade level: the Café de la Concha at the north-east end, La Perla's restaurant in the
//    middle and Eguzki at the south-west end, cream-rendered with big windows between pilasters under low hipped roofs
//    of cobalt-and-white glazed tiles, small pedestals on their cornices and corner piers crowned with sculpted ships'
//    hulls, ropes and garlands. The end pavilions come down to the sand in two storeys with canted ends, a one-storey
//    bow beside each carrying a terrace;
//  - in the middle, a seven-sided apse to the sea under a glazed roof (the pools), the restaurant behind it facing the
//    promenade under its dark "La Perla" sign, a canted bay to each terrace;
//  - two small pavilions on the terraces by the promenade (the Bataplan's entrance and its twin, Kontxa 14).
// From the photographs (Wikimedia Commons, "La Perla (Donostia-San Sebastián)" & "Eguzki Etxea": the beach front from
// the bay and the sand, 1990s-2023; the pavilions and terraces from the promenade): pale cream render, white glazing
// bars, blue-grey limestone cornices, copings and railing posts, white cast-iron railings of rings.
// The Real Caseta de Baños (1911), the royal bathing pavilion, is a separate building some 40 m further south-west,
// modelled here too (see caseta() below): white marble over a rusticated base, its own stairs to the sand.
//
// Plan: the beach edge of the municipal 1:500 map (embedded below) for the storeys on the sand; the 1:500 outlines of
// the pavilions, found by position in GEO.buildings (and hidden as plain extrusions through userData.hide). Heights:
// the terraces follow the LiDAR promenade, the eaves b5m's measured heights. No GEO.landmarks site claims them.
//
// Interface with the promenade wall and its railing: the storey on the sand stands from 1.6 m under the beach level
// (the sand 6 m out to sea) up to the terraces, so it stands right whether the sand before it is the LiDAR's smoothed
// bank or a beach lowered to a vertical wall. The baked barandilla (js/donostia/data-streetscape.js) runs along the
// galleries' and the bows' fronts already; this model adds only the railings it lacks (round the apse's ledge, between
// the Café's terrace and the promenade).
//
// build(sites, ctx) receives no sites (index.js registers it with none) and ctx = { GEO, terrain, kit }.

// ---------------------------------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------------------------------

// The complex's beach edge, where its walls stand on the sand, north-east to south-west: the landward edge of the beach
// (HONDARTZA) of the municipal 1:500 map along La Perla, its small stair notches cut out and the jogs of its
// pilasters simplified away. Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA
// 3.0); local frame metres (x east, z south).
const SEA_EDGE = [
  24.24, 626.59, 21.01, 623.13, 18.05, 622.45, 14.60, 623.17, 12.57, 624.76, 9.78, 620.53, 9.37, 620.84, 7.47, 618.47,
  3.88, 618.15, 1.00, 620.46, 0.48, 624.08, 1.90, 625.70, 2.25, 627.24, -29.08, 651.98, -29.62, 652.27, -29.92, 651.68,
  -31.06, 652.25, -33.27, 648.40, -37.22, 646.03, -41.85, 646.04, -45.84, 648.39, -48.18, 652.44, -47.97, 656.99,
  -45.69, 660.82, -46.75, 661.48, -46.34, 662.15, -83.52, 676.94, -84.81, 676.64, -85.86, 673.81, -89.27, 672.50,
  -92.73, 673.82, -94.26, 677.19, -93.18, 679.91, -93.64, 680.10, -93.18, 681.40, -93.71, 685.73, -95.98, 687.59,
  -97.15, 690.80, -96.54, 694.18, -95.19, 697.22, -94.17, 699.95
];
// The rest of the outline, south-west round to north-east: OpenStreetMap's outline of La Perla along the promenade (way
// 177719427, © OpenStreetMap contributors, ODbL 1.0), then the railing between the Café de la Concha's terrace and the
// promenade by the top of the north-east beach stairs (1:500 pedestrian zone, CC BY-SA 3.0). The terraces meet the
// promenade level along all of it: no wall there.
const LAND_EDGE = [
  -92.89, 701.43, -42.75, 682.76, -35.48, 678.58, -13.50, 665.95, 20.65, 640.01, 22.66, 638.43, 24.01, 635.34,
  25.07, 632.52, 26.31, 629.23
];
const CAFE_RAIL = 5; // LAND_EDGE's last points: the railing round the Café's terrace
// Short railings on the same line from the corners of the two small pavilions (copings in the 1:500 pedestrian zone,
// CC BY-SA 3.0)
const TERRACE_RAILS = [
  [-9.4, 663.4, -13.0, 666.3], [5.0, 652.4, 9.2, 649.1], // by the Bataplan's entrance
  [-65.0, 692.4, -68.6, 693.8], [-47.5, 685.5, -42.4, 683.6] // by Kontxa 14
];

// Where the 1:500 buildings this model replaces stand (found in GEO.buildings by position)
const PAVILIONS = {
  cafe: [9.4, 628.1], // Café de la Concha, Kontxa 8
  perla: [-35.6, 661.3], // La Perla, Kontxa 12
  eguzki: [-86.8, 683.6], // Eguzki, Kontxa 16
  bataplan: [-3.4, 656.0], // the Bataplan's entrance, Kontxa 10
  kontxa14: [-56.4, 686.8], // its twin, Kontxa 14
  caseta: [-132.8, 710.5] // the Caseta Real's pavilion on the promenade, Kontxa 18
};

// The Caseta Real (Bainuetako Errege Etxola, 1911), from the municipal 1:500 map (CC BY-SA 3.0): its storey on the sand
// along the beach's edge, west to east (the sea on the right): the west wing with its bowed end, the landing at the
// foot of the pavilion and the east wing with its bowed end; the landing (the bastion's half round and the strip
// before the pavilion's lower storey, where the stairs arrive); the two curved flights of stairs (foot to top, the
// bastion's side and the outer side); their parapets (the beach's edge round them, from the wings down to the sand).
const CASETA = {
  west: [
    -145.48, 713.45, -145.65, 712.80, -144.99, 712.70, -141.84, 711.77, -141.87, 710.93, -141.85, 710.23, -141.67, 709.59,
    -141.37, 709.06, -140.93, 708.59, -140.42, 708.26, -139.74, 707.94, -138.75, 707.68
  ],
  front: [-138.75, 707.68, -138.56, 706.83, -130.19, 704.62, -128.68, 705.04], // the pavilion's lower storey between
  east: [
    -128.68, 705.04, -127.59, 704.75, -126.33, 704.82, -125.52, 705.03, -125.11, 705.27, -124.75, 705.63, -124.43, 706.15,
    -124.02, 707.09, -123.91, 707.14, -120.76, 706.21, -120.11, 706.05, -120.02, 706.71, -119.23, 709.58, -119.01, 710.05
  ],
  back: [-118.94, 710.56, -144.40, 717.29], // along the promenade (b5m's outline of the whole, CC BY 4.0)
  landing: [
    -130.19, 704.62, -130.00, 703.06, -131.44, 703.44, -131.73, 702.55, -132.19, 701.69, -132.76, 701.07, -133.26, 700.76,
    -134.12, 700.59, -135.35, 700.64, -136.20, 701.03, -136.83, 701.62, -137.20, 702.26, -137.37, 702.91, -137.36, 703.69,
    -137.15, 704.92, -138.60, 705.30, -138.56, 706.83
  ],
  stairs: [
    { inner: [-133.26, 700.76, -132.76, 701.07, -132.19, 701.69, -131.73, 702.55, -131.44, 703.44],
      outer: [-132.25, 698.90, -130.79, 699.97, -130.15, 700.83, -129.95, 701.80, -130.00, 703.06] },
    { inner: [-136.83, 701.62, -137.20, 702.26, -137.37, 702.91, -137.36, 703.69, -137.15, 704.92],
      outer: [-138.50, 700.60, -138.93, 702.15, -139.09, 703.15, -138.88, 704.73, -138.60, 705.30] }
  ],
  parapets: [
    [-128.68, 705.04, -129.68, 701.79, -130.15, 700.83, -130.79, 699.97, -132.05, 699.01, -132.38, 698.82],
    [-138.75, 707.68, -139.51, 704.77, -139.66, 703.32, -139.53, 702.33, -139.30, 701.71, -138.81, 700.83, -138.58, 700.49]
  ]
};
const MARBLE = rgb(0xb4b7b5); // the Caseta's grey-veined white marble (posts, copings)
const RUSTIC = rgb(0x45494c); // its rusticated dark limestone base
const SLATE = rgb(0x2b3036);

const CREAM = 0xeee2c2; // the render (sRGB)
const GREY_STONE = rgb(0x8b9194); // the blue-grey limestone of cornices, copings and posts
const PAVING = rgb(0xa29f97); // the terraces' light grey stone
const CREAM_PAINT = rgb(CREAM);
const WHITE_IRON = rgb(0xf1f0ea);
const DARK_IRON = rgb(0x26292b);
const BLOOMS = { perla: rgb(0xd0237f), cafe: rgb(0xd8242d) }; // the petunias at La Perla, the geraniums at the Café

const BAY = 4.0; // m, the arcade's rhythm on the sand (the 1:500 pilasters along the galleries)

// Façade codes (fstyle.x), drawn by perlaFacadeMaterial(); fstyle.w picks the finish (0 La Perla's cream render, 1 the
// Caseta Real's white marble)
const F = { plain: 0, arcade: 1, upper: 2, glassRoof: 3, shop: 4, sign: 5, door: 6, colonnade: 7, arch: 8 };

// ---------------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------------

// Cream render (or the Caseta's marble) with its openings, from two attributes: facade = (u along the bay, v up from the
// storey's floor, bay width, seed) and fstyle = (code, storey height, flags, finish). Arcade bays on the sand: a plinth
// with a round vent, a tall arched window with white glazing bars behind a cast-iron balustrade of rings; upper bays: a
// big window, a balcony balustrade before it (flags 1), a frieze set with small cobalt tiles; shop and door bays; the
// pools' glazed roof; the restaurant's sign; the Caseta's colonnade bays over their rusticated base and its great
// arched window. Windows light up at dusk, the pools glow aqua.
function perlaFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.userData.attributes = { facade: 4, fstyle: 4 };
  const fa = attribute('facade', 'vec4'), fs = attribute('fstyle', 'vec4');
  const u = fa.x, v = fa.y, len = fa.z, seed = fa.w;
  const code = fs.x, h = fs.y, flags = fs.z;
  const is = (c) => step(c - 0.5, code).mul(step(code, c + 0.5));
  const px = max(max(fwidth(u), fwidth(v)), 0.0008);
  const inside = (d) => smoothstep(px, px.negate(), d); // 1 where the signed distance d < 0
  const line = (d, w) => smoothstep(px.add(w), float(w), d); // a band of half-width w round d = 0
  const fine = float(1).sub(smoothstep(0.012, 0.05, px)); // detail that fades out before it aliases

  const tone = float(0.96).add(mx_noise_float(positionWorld.mul(0.35)).mul(0.035))
    .add(mx_noise_float(positionWorld.mul(3.1)).mul(0.015));
  // the finish: cream render, or white marble with soft grey veins
  const vein = abs(mx_noise_float(positionWorld.mul(vec3(0.55, 0.3, 0.55)).add(mx_noise_float(positionWorld.mul(1.7)).mul(0.7))));
  const cloud = mx_noise_float(positionWorld.mul(0.8)).mul(0.5).add(0.5);
  const marble = mix(vec3(0.7, 0.71, 0.7), vec3(0.5, 0.52, 0.53), smoothstep(0.16, 0.0, vein).mul(0.35).add(cloud.mul(0.25))).mul(tone);
  const isMarble = step(0.5, fs.w);
  const cream = mix(vec3(...rgb(CREAM)).mul(tone), marble, isMarble);
  const white = vec3(0.86, 0.86, 0.83);
  const cu = u.sub(len.mul(0.5)); // from the bay's centre
  const wA = is(F.arcade), wU = is(F.upper), wG = is(F.glassRoof), wS = is(F.shop), wSg = is(F.sign), wD = is(F.door);
  const wC = is(F.colonnade), wR = is(F.arch);

  // --- arcade bay on the sand
  const aHalf = max(len.mul(0.5).sub(0.55), 0.35);
  const crown = h.sub(0.95);
  const spring = crown.sub(aHalf);
  const aSill = float(1.25);
  const dRect = max(abs(cu).sub(aHalf), max(aSill.sub(v), v.sub(spring)));
  const dArch = max(length(vec2(cu, v.sub(spring))).sub(aHalf), spring.sub(v));
  const dA = min(dRect, dArch);
  const aWin = inside(dA);
  const aFrame = aWin.mul(float(1).sub(inside(dA.add(0.09))));
  const aBars = max(line(abs(abs(cu).sub(aHalf.div(3))), 0.03), line(abs(v.sub(spring)), 0.035)).mul(aWin).mul(fine);
  const archivolt = inside(dArch.sub(0.24)).mul(float(1).sub(aWin)).mul(step(spring, v));
  const key = inside(max(abs(cu).sub(0.17), abs(v.sub(crown.add(0.12))).sub(0.22)));
  // the balustrade before the window's foot: a rail top and bottom and a ring every 0.45 m
  const balTop = aSill.add(0.95);
  const bx = fract(cu.div(0.45)).sub(0.5).mul(0.45);
  const ringA = line(abs(length(vec2(bx, v.sub(aSill.add(0.47)))).sub(0.16)), 0.018);
  const balInside = step(v, balTop.add(0.04)).mul(step(aSill, v)).mul(aWin);
  const balNear = max(max(line(abs(v.sub(balTop)), 0.03), line(abs(v.sub(aSill.add(0.06))), 0.025)),
    max(ringA, line(abs(bx), 0.012).mul(0.6)));
  const balust = mix(float(0.35), balNear, fine).mul(balInside);
  // plinth: rusticated courses and a round vent per bay
  const plinth = step(v, 1.0).mul(wA);
  const groove = line(float(0.17).sub(abs(fract(v.div(0.34)).sub(0.5)).mul(0.34)), 0.012).mul(plinth).mul(fine);
  const ventD = length(vec2(cu, v.sub(0.5)));
  const vent = inside(ventD.sub(0.2)).mul(plinth);
  const ventRim = line(abs(ventD.sub(0.25)), 0.04).mul(plinth);

  // --- upper bay (promenade level)
  const uHalf = max(len.mul(0.5).sub(0.4), 0.3);
  const uSill = float(0.85), uHead = h.sub(1.0);
  const dU = max(abs(cu).sub(uHalf), max(uSill.sub(v), v.sub(uHead)));
  const uWin = inside(dU);
  const uFrame = uWin.mul(float(1).sub(inside(dU.add(0.08))));
  const uBars = line(abs(v.sub(uHead.sub(0.55))), 0.03).mul(uWin).mul(fine); // plate glass under a transom light
  const bal2Inside = step(v, 0.97).mul(step(abs(cu), uHalf.add(0.05))).mul(step(0.5, flags));
  const ring2 = line(abs(length(vec2(bx, v.sub(0.5))).sub(0.17)), 0.018);
  const bal2Near = max(max(line(abs(v.sub(0.93)), 0.03), line(abs(v.sub(0.08)), 0.025)),
    max(ring2, line(abs(bx), 0.012).mul(0.6)));
  const balust2 = mix(float(0.35), bal2Near, fine).mul(bal2Inside);
  // the frieze's tiles: a small cobalt square over each pilaster
  const tile = inside(max(abs(min(u, len.sub(u)).sub(0.32)).sub(0.09), abs(v.sub(h.sub(0.62))).sub(0.09)));

  // --- shop windows and doors (promenade fronts, the small pavilions)
  const sHalf = max(len.mul(0.5).sub(0.35), 0.3);
  const dS = max(abs(cu).sub(sHalf), max(float(0.55).sub(v), v.sub(h.sub(0.75))));
  const sWin = inside(dS);
  const sFrame = sWin.mul(float(1).sub(inside(dS.add(0.07)))).add(line(abs(v.sub(h.sub(1.35))), 0.03).mul(sWin));
  const dD = max(abs(cu).sub(min(sHalf, 0.95)), max(v.negate(), v.sub(min(h.sub(0.75), 2.75))));
  const dWin = inside(dD);
  const dFrame = dWin.mul(float(1).sub(inside(dD.add(0.07)))).add(line(abs(cu), 0.03).mul(dWin));

  // --- the pools' glazed roof: panes between white glazing bars
  const gBars = max(line(float(0.575).sub(abs(fract(u.div(1.15)).sub(0.5)).mul(1.15)), 0.035),
    line(float(0.7).sub(abs(fract(v.div(1.4)).sub(0.5)).mul(1.4)), 0.03)).mul(mix(float(0.45), float(1), fine));

  // --- the sign: dark panel, gilt rules and "La Perla" in gilt strokes
  const sign = signFace(u, v, len, h);

  // --- the Caseta's colonnade bays on the sand: rusticated dark limestone to 2.4 m (bossed blocks 0.6 m high, 1.2 m
  // long, courses staggered), a marble apron, then a tall window with a transom between the columns
  const rustic = step(v, 2.4).mul(wC);
  const course = floor(v.div(0.6));
  const dBedJ = float(0.3).sub(abs(fract(v.div(0.6)).sub(0.5)).mul(0.6));
  const dHeadJ = float(0.6).sub(abs(fract(u.div(1.2).add(course.mul(0.5))).sub(0.5)).mul(1.2));
  const rJoint = max(line(dBedJ, 0.025), line(dHeadJ, 0.025)).mul(fine);
  const block = fract(sin(dot(vec2(floor(u.div(1.2).add(course.mul(0.5))), course), vec2(41.3, 17.9))).mul(9631.7));
  const rusticCol = vec3(0.2, 0.215, 0.225).mul(float(0.86).add(block.mul(0.16))).mul(float(1).sub(rJoint.mul(0.45)));
  const cHalf = max(len.mul(0.5).sub(0.42), 0.3);
  const dC = max(abs(cu).sub(cHalf), max(float(2.95).sub(v), v.sub(h.sub(1.15))));
  const cWin = inside(dC).mul(wC);
  const cFrame = cWin.mul(float(1).sub(inside(dC.add(0.07))));
  const cBars = max(line(abs(cu), 0.025), line(abs(v.sub(h.sub(1.75))), 0.025)).mul(cWin).mul(fine);
  const apron = line(abs(max(abs(cu).sub(cHalf.sub(0.1)), abs(v.sub(2.67)).sub(0.16))), 0.02).mul(wC).mul(fine);

  // --- the Caseta's great arched window: three lights (mullions, a transom at the springing) under a round head
  const rHalf = max(len.mul(0.5).sub(0.3), 0.4);
  const rCrown = h.sub(0.3), rSpring = rCrown.sub(rHalf);
  const dRr = max(abs(cu).sub(rHalf), max(float(0.95).sub(v), v.sub(rSpring)));
  const dRa = max(length(vec2(cu, v.sub(rSpring))).sub(rHalf), rSpring.sub(v));
  const dR = min(dRr, dRa);
  const rWin = inside(dR).mul(wR);
  const rFrame = rWin.mul(float(1).sub(inside(dR.add(0.1))));
  const rBars = max(max(line(abs(abs(cu).sub(rHalf.div(3))), 0.035), line(abs(v.sub(rSpring)), 0.035)),
    line(abs(length(vec2(cu, v.sub(rSpring))).sub(rHalf.mul(0.62))), 0.03).mul(step(rSpring, v))).mul(rWin).mul(fine);

  const glassA = aWin.mul(float(1).sub(aFrame)).mul(float(1).sub(aBars)).mul(float(1).sub(balust)).mul(wA);
  const glassU = uWin.mul(float(1).sub(uFrame)).mul(float(1).sub(uBars)).mul(float(1).sub(balust2)).mul(wU);
  const glassS = sWin.mul(float(1).sub(sFrame)).mul(wS).add(dWin.mul(float(1).sub(dFrame)).mul(wD));
  const glassC = cWin.mul(float(1).sub(cFrame)).mul(float(1).sub(cBars)).add(rWin.mul(float(1).sub(rFrame)).mul(float(1).sub(rBars)));
  const glassR = float(1).sub(gBars).mul(wG);
  const glass = clamp(glassA.add(glassU).add(glassS).add(glassC), 0.0, 1.0);
  const whiteMask = clamp(aFrame.add(aBars).add(balust).mul(wA)
    .add(uFrame.add(uBars).add(balust2).mul(wU))
    .add(sFrame.mul(wS)).add(dFrame.mul(wD)).add(gBars.mul(wG))
    .add(cFrame).add(cBars).add(rFrame).add(rBars), 0.0, 1.0);

  const glassCol = mix(vec3(0.05, 0.075, 0.085), vec3(0.11, 0.14, 0.16), smoothstep(-0.3, 0.6, normalWorld.y));
  const roofGlass = vec3(0.36, 0.52, 0.6);
  let col = cream.mul(mix(float(1), float(0.86), groove)).mul(mix(float(1), float(0.94), plinth));
  col = col.mul(float(1).sub(archivolt.mul(wA).mul(0.05))).add(key.mul(wA).mul(0.03));
  col = mix(col, vec3(0.05, 0.05, 0.05), vent);
  col = mix(col, cream.mul(0.84), ventRim.mul(float(1).sub(vent)));
  col = mix(col, vec3(0.04, 0.12, 0.42), tile.mul(wU).mul(float(1).sub(isMarble)));
  col = mix(col, cream.mul(0.8), apron);
  col = mix(col, rusticCol, rustic);
  col = mix(col, white, whiteMask);
  col = mix(col, glassCol, glass);
  col = mix(col, roofGlass, glassR);
  col = mix(col, sign.color, wSg);
  mat.colorNode = col;
  const shiny = clamp(glass.add(glassR), 0.0, 1.0);
  mat.roughnessNode = mix(mix(float(0.88), float(0.12), shiny), sign.roughness, wSg);
  mat.metalnessNode = mix(mix(float(0.0), float(0.35), shiny), sign.metalness, wSg);

  // dusk & night: most rooms lit (the restaurants, the spa), the pools' glazed roof aqua, the sign's gilt shining
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const cell = vec2(floor(seed.mul(997.0)), floor(v.div(3.0)));
  const hsh = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const lit = step(hsh, clamp(cityUniforms.uInteriorGlow.mul(0.45), 0.0, 0.7));
  const warm = select(hsh.lessThan(0.25), vec3(1.0, 0.84, 0.62), vec3(1.0, 0.7, 0.4));
  // (by day the rooms behind the glass stay dark: lit windows show from the golden hour on)
  const dusk = smoothstep(0.3, 0.9, cityUniforms.uInteriorGlow);
  const winGlow = warm.mul(glass).mul(lit).mul(cityUniforms.uInteriorGlow).mul(dusk).mul(0.6);
  const poolGlow = vec3(0.45, 0.8, 1.0).mul(glassR).mul(night).mul(0.4);
  const signGlow = vec3(1.0, 0.72, 0.32).mul(sign.gilt).mul(wSg).mul(night).mul(0.8);
  mat.emissiveNode = winGlow.add(poolGlow).add(signGlow);
  return mat;
}

// The restaurant's sign (u along it, v up it, in metres, panel len x h): "La Perla" in gilt on a dark panel between gilt
// rules, the letters drawn as strokes of a little sans-serif (distance fields in letter units, x-height 0.55)
function signFace(u, v, len, h) {
  const px = max(max(fwidth(u), fwidth(v)), 0.0008);
  const scale = h.mul(0.62); // letter height (m)
  const x = u.sub(len.mul(0.5)).div(scale).add(2.17), y = v.sub(h.mul(0.5)).div(scale).add(0.5);
  const seg = (ax, ay, bx, by) => {
    const pa = vec2(x.sub(ax), y.sub(ay)), ba = vec2(bx - ax, by - ay);
    const t = clamp(dot(pa, ba).div((bx - ax) ** 2 + (by - ay) ** 2), 0.0, 1.0);
    return length(pa.sub(ba.mul(t)));
  };
  const ring = (cx, cy, r) => abs(length(vec2(x.sub(cx), y.sub(cy))).sub(r));
  let d = min(seg(0.0, 0.0, 0.0, 1.0), seg(0.0, 0.0, 0.42, 0.0)); // L
  d = min(d, min(ring(0.82, 0.26, 0.26), seg(1.08, 0.0, 1.08, 0.55))); // a
  // "Perla", a word space (0.34) to the right
  d = min(d, seg(1.79, 0.0, 1.79, 1.0)); // P
  d = min(d, max(ring(2.0, 0.76, 0.24), float(2.0).sub(x)));
  d = min(d, min(seg(1.79, 1.0, 2.0, 1.0), seg(1.79, 0.52, 2.0, 0.52)));
  const eGap = x.greaterThan(2.64).and(y.lessThan(0.25)).and(y.greaterThan(0.07));
  d = min(d, min(select(eGap, float(1.0), ring(2.54, 0.27, 0.27)), seg(2.27, 0.27, 2.81, 0.27))); // e
  d = min(d, seg(3.04, 0.0, 3.04, 0.55)); // r
  d = min(d, max(ring(3.29, 0.3, 0.25), max(float(0.3).sub(y), x.sub(3.46))));
  d = min(d, seg(3.66, 0.0, 3.66, 1.0)); // l
  d = min(d, min(ring(4.08, 0.26, 0.26), seg(4.34, 0.0, 4.34, 0.55))); // a
  const w = float(0.06);
  const stroke = smoothstep(w.add(px.div(scale)), w, d);
  const ruleAt = (at) => smoothstep(px.add(0.02), float(0.02), abs(v.sub(at)));
  const rule = max(ruleAt(0.07), ruleAt(h.sub(0.07)));
  const gilt = clamp(stroke.add(rule), 0.0, 1.0);
  return {
    color: mix(vec3(0.04, 0.043, 0.047), vec3(0.78, 0.56, 0.22), gilt),
    roughness: mix(float(0.5), float(0.3), gilt),
    metalness: mix(float(0.1), float(0.85), gilt),
    gilt
  };
}

// Cobalt-and-white glazed tiles: courses every 0.24 m up the slope, a cobalt band along the eaves and the ridge, cobalt
// diamonds in a lattice over the white field; rinfo = (eave height, rise, -, -)
function tileRoofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.userData.attributes = { rinfo: 4 };
  const ri = attribute('rinfo', 'vec4');
  const up = positionWorld.y.sub(ri.x);
  const n = normalWorld;
  const flatTop = step(0.97, abs(n.y));
  const t = normalize(vec2(n.z.negate(), n.x).add(vec2(0.0001, 0.0)));
  const along = select(flatTop.greaterThan(0.5), positionWorld.x, dot(positionWorld.xz, t));
  const px = max(max(fwidth(along), fwidth(up)), 0.0008);
  const fade = float(1).sub(smoothstep(0.01, 0.04, px));
  const line = (d, w) => smoothstep(px.add(w), float(w), d);
  const course = floor(up.div(0.24));
  const tileU = along.div(0.21).add(course.mul(0.5));
  const dCourse = float(0.5).sub(abs(fract(up.div(0.24)).sub(0.5))).mul(0.24);
  const dTile = float(0.5).sub(abs(fract(tileU).sub(0.5))).mul(0.21);
  const joints = max(line(dCourse, 0.01), line(dTile, 0.007).mul(0.6)).mul(fade);
  const tileTone = fract(sin(dot(vec2(floor(tileU), course), vec2(17.13, 91.7))).mul(43758.5)).mul(0.08).add(0.92);
  // a lattice of diamonds: rows 0.72 m apart, every 1.2 m along, alternate rows shifted half a step
  const row = floor(up.sub(0.6).div(0.72));
  const dx = abs(fract(along.div(1.2).add(row.mul(0.5))).sub(0.5)).mul(1.2);
  const dy = abs(fract(up.sub(0.6).div(0.72)).sub(0.5)).mul(0.72);
  const diamond = smoothstep(px.add(0.17), float(0.17), dx.add(dy)).mul(step(0.6, up)).mul(step(up, ri.y.sub(0.35)));
  const bandM = max(step(up, 0.48), step(ri.y.sub(0.24), up));
  const blue = max(diamond, bandM).mul(float(1).sub(flatTop));
  const cobalt = vec3(0.018, 0.045, 0.27), white = vec3(0.84, 0.85, 0.84);
  mat.colorNode = mix(white, cobalt, blue).mul(tileTone).mul(float(1).sub(joints.mul(0.35)));
  mat.roughnessNode = mix(float(0.22), float(0.6), joints);
  mat.metalnessNode = float(0.05);
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------------

const pairs = (flat) => {
  const out = [];
  for (let k = 0; k < flat.length; k += 2) out.push([flat[k], flat[k + 1]]);
  return out;
};

// Outward normal of the plan edge a -> b (right of travel, (dz, -dx)): outwards for positively wound rings
function normalOf(a, b) {
  const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz) || 1;
  return [dz / l, -dx / l];
}

// Quads into a non-indexed geometry with per-vertex vec4 attributes; each triangle is wound to face `n`
class Quads {
  constructor(names) {
    this.pos = [];
    this.nrm = [];
    this.attr = Object.fromEntries(names.map((k) => [k, []]));
  }

  // corners a, b, c, d in order round the quad, attrs = { name: [va, vb, vc, vd] }
  quad(a, b, c, d, n, attrs) {
    const P = [a, b, c, d];
    for (const [i, j, k] of [[0, 1, 2], [0, 2, 3]]) {
      const e1 = [P[j][0] - P[i][0], P[j][1] - P[i][1], P[j][2] - P[i][2]];
      const e2 = [P[k][0] - P[i][0], P[k][1] - P[i][1], P[k][2] - P[i][2]];
      const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
      const order = cx * n[0] + cy * n[1] + cz * n[2] >= 0 ? [i, j, k] : [i, k, j];
      for (const o of order) {
        this.pos.push(...P[o]);
        this.nrm.push(...n);
        for (const [name, vals] of Object.entries(attrs)) this.attr[name].push(...vals[o]);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    for (const [name, vals] of Object.entries(this.attr)) g.setAttribute(name, new THREE.Float32BufferAttribute(vals, 4));
    return g;
  }
}

// A wall along a polyline (outwards = right of travel), cut into bays: each bay a quad from yBot(x, z) to yTop(x, z)
// with facade = (u in its bay, y - floor, bay width, seed) and fstyle = (code, storey height, flags, finish); bays(len)
// counts an edge's equal bays (or cuts(len) gives their boundaries as fractions of it), style(edge, bay, bays, len)
// gives the bay's { code, flags }
function wallRun(q, pts, { yBot, yTop, floor, height, bays, cuts = null, style, seed = 0, finish = 0 }) {
  for (let e = 0; e + 1 < pts.length; e++) {
    const [ax, az] = pts[e], [bx, bz] = pts[e + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 0.05) continue;
    const [nx, nz] = normalOf(pts[e], pts[e + 1]);
    const nb = cuts ? 0 : Math.max(1, bays(L));
    const ts = cuts ? cuts(L) : Array.from({ length: nb + 1 }, (_, k) => k / nb);
    const n = ts.length - 1;
    for (let k = 0; k < n; k++) {
      const t0 = ts[k], t1 = ts[k + 1], bw = L * (t1 - t0);
      const p0 = [ax + (bx - ax) * t0, az + (bz - az) * t0], p1 = [ax + (bx - ax) * t1, az + (bz - az) * t1];
      const { code, flags = 0 } = style(e, k, n, L);
      const s = seed + e * 0.0173 + k * 0.0031;
      const y00 = yBot(...p0), y01 = yBot(...p1), y10 = yTop(...p0), y11 = yTop(...p1);
      const fac = (uu, y) => [uu, y - floor, bw, s];
      const sty = [code, height, flags, finish];
      q.quad([p0[0], y00, p0[1]], [p1[0], y01, p1[1]], [p1[0], y11, p1[1]], [p0[0], y10, p0[1]], [nx, 0, nz], {
        facade: [fac(0, y00), fac(bw, y01), fac(bw, y11), fac(0, y10)],
        fstyle: [sty, sty, sty, sty]
      });
    }
  }
}

// A horizontal band (cornice, string course, upstand) along a polyline: from `inn` inside the wall line to `out`
// outside it, from y0 to y1 over y(x, z); mitred at the corners. Front, top and soffit.
function band(pts, y, { out, inn = 0, y0, y1, closed = false }) {
  const n = pts.length;
  const off = (i, d) => {
    const prev = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)], next = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const a = closed || i > 0 ? normalOf(prev, pts[i]) : normalOf(pts[i], next);
    const b = closed || i < n - 1 ? normalOf(pts[i], next) : normalOf(prev, pts[i]);
    let mx = a[0] + b[0], mz = a[1] + b[1];
    const ml = Math.hypot(mx, mz) || 1;
    mx /= ml; mz /= ml;
    const cos = Math.max(0.4, mx * a[0] + mz * a[1]);
    return [pts[i][0] + (mx * d) / cos, pts[i][1] + (mz * d) / cos];
  };
  const q = new Quads([]);
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const ao = off(i, out), bo = off(j, out), ai = off(i, -inn), bi = off(j, -inn);
    const ya = y(...pts[i]), yb = y(...pts[j]);
    const [nx, nz] = normalOf(pts[i], pts[j]);
    const P = (p, yy, dy) => [p[0], yy + dy, p[1]];
    q.quad(P(ao, ya, y0), P(bo, yb, y0), P(bo, yb, y1), P(ao, ya, y1), [nx, 0, nz], {});
    q.quad(P(ao, ya, y1), P(bo, yb, y1), P(bi, yb, y1), P(ai, ya, y1), [0, 1, 0], {});
    q.quad(P(ao, ya, y0), P(bo, yb, y0), P(bi, yb, y0), P(ai, ya, y0), [0, -1, 0], {});
  }
  return q.geometry();
}

// A box turned by yaw (radians, from +x towards +z) standing at (x, z) between y0 and y1
function post(sx, sz, x, z, y0, y1, yaw = 0) {
  const g = new THREE.BoxGeometry(sx, y1 - y0, sz);
  g.rotateY(-yaw);
  g.translate(x, (y0 + y1) / 2, z);
  return g;
}

// The walls of a positively wound ring between y0 and y1
function prismWalls(ring, y0, y1) {
  const q = new Quads([]);
  const pts = pairs(ring);
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const [nx, nz] = normalOf(a, b);
    q.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [nx, 0, nz], {});
  }
  return q.geometry();
}

// A flat cap over a ring at height y, facing up
function cap(ring, y) {
  const pts = pairs(ring).map(([x, z]) => new THREE.Vector2(x, z));
  const pos = [];
  for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, [])) {
    const [a, b, c] = [pts[i], pts[j], pts[k]];
    const up = (b.y - a.y) * (c.x - a.x) - (b.x - a.x) * (c.y - a.y) >= 0;
    for (const p of up ? [a, b, c] : [a, c, b]) pos.push(p.x, y, p.y);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, k) => (k % 3 === 1 ? 1 : 0)), 3));
  return g;
}

// A wall `thick` thick along a polyline, its outer face on it (outwards = side x right of travel), standing from y0 to
// tops[i] at each point: outer and inner faces, the top and both ends
function slab(pts, y0, tops, thick, side = 1) {
  const q = new Quads([]);
  const n = pts.length;
  const nrm = (i) => {
    const a = normalOf(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]), b = normalOf(pts[Math.min(n - 2, i)], pts[Math.min(n - 1, i + 1)]);
    const l = Math.hypot(a[0] + b[0], a[1] + b[1]) || 1;
    return [(side * (a[0] + b[0])) / l, (side * (a[1] + b[1])) / l];
  };
  const inner = pts.map((p, i) => { const [nx, nz] = nrm(i); return [p[0] - nx * thick, p[1] - nz * thick]; });
  for (let i = 0; i + 1 < n; i++) {
    const [nx, nz] = normalOf(pts[i], pts[i + 1]).map((c) => c * side);
    const a = pts[i], b = pts[i + 1], c = inner[i + 1], d = inner[i];
    q.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], tops[i + 1], b[1]], [a[0], tops[i], a[1]], [nx, 0, nz], {});
    q.quad([d[0], y0, d[1]], [c[0], y0, c[1]], [c[0], tops[i + 1], c[1]], [d[0], tops[i], d[1]], [-nx, 0, -nz], {});
    q.quad([a[0], tops[i], a[1]], [b[0], tops[i + 1], b[1]], [c[0], tops[i + 1], c[1]], [d[0], tops[i], d[1]], [0, 1, 0], {});
  }
  for (const [i, j] of [[0, 1], [n - 1, n - 2]]) {
    const tx = pts[i][0] - pts[j][0], tz = pts[i][1] - pts[j][1], tl = Math.hypot(tx, tz) || 1;
    const a = pts[i], d = inner[i];
    q.quad([a[0], y0, a[1]], [d[0], y0, d[1]], [d[0], tops[i], d[1]], [a[0], tops[i], a[1]], [tx / tl, 0, tz / tl], {});
  }
  return q.geometry();
}

// n + 1 points at equal arc length along a polyline
function resampleBy(pts, n) {
  const cum = [0];
  for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  const L = cum[cum.length - 1];
  return Array.from({ length: n + 1 }, (_, i) => {
    const s = (L * i) / n;
    let k = 1;
    while (k < cum.length - 1 && cum[k] < s) k++;
    const f = (s - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f];
  });
}

// The longest run of consecutive ring points (cyclically) that pass `keep`
function longestRun(points, keep) {
  const n = points.length;
  const ok = points.map(keep);
  if (ok.every(Boolean)) return points;
  let best = [], cur = [];
  const start = ok.indexOf(false);
  for (let k = 1; k <= n; k++) {
    const i = (start + k) % n;
    if (ok[i]) cur.push(points[i]);
    if (!ok[i] || k === n) {
      if (cur.length > best.length) best = cur;
      cur = [];
    }
  }
  return best;
}

// Parts of the cream walls without openings (piers, cornices, columns, upstands)
const PLAIN = { facade: [0, 99, 1, 0], fstyle: [F.plain, 99, 0, 0] };

// ---------------------------------------------------------------------------------------------------------------------
// The building
// ---------------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, terrain, kit } = ctx;
  const heightAt = (x, z) => terrain.heightAt(x, z);

  // the 1:500 buildings this model replaces
  const found = {};
  for (const [key, [x, z]] of Object.entries(PAVILIONS)) {
    const i = GEO.buildings.findIndex((b) => b.g?.[0] && pointInRing(x, z, b.g[0]));
    if (i >= 0) found[key] = i;
  }
  if (found.perla === undefined) return null;
  const ringOf = (key, tol = 0.3) =>
    (found[key] === undefined ? null : wound(simplify(cleanRing(GEO.buildings[found[key]].g[0]), tol), true));
  const perlaRing = ringOf('perla');
  const cafeRing = ringOf('cafe');
  const eguzkiRing = ringOf('eguzki');

  // The walls on the sand, south-west to north-east so that the sea lies on the right (outwards), ending at the top of
  // the north-east beach stairs
  const sea = pairs(SEA_EDGE).reverse();
  const land = pairs(LAND_EDGE);
  const cafeRail = land.slice(land.length - CAFE_RAIL).reverse();
  const front = [...sea, cafeRail[0]];
  const outline = wound([...SEA_EDGE, ...LAND_EDGE], true);

  // nearest point of the front
  const frontDist = (x, z) => {
    let best = Infinity, bx = 0, bz = 0;
    for (let e = 0; e + 1 < front.length; e++) {
      const [ax, az] = front[e], [cx, cz] = front[e + 1];
      const dx = cx - ax, dz = cz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-9)));
      const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
      if (d < best) { best = d; bx = ax + t * dx; bz = az + t * dz; }
    }
    return { d: best, bx, bz };
  };

  // --- levels: the beach (the sand 6 m out from the walls), the terraces (the promenade's LiDAR surface)
  const beachSamples = [];
  for (let e = 0; e + 1 < sea.length; e++) {
    const [nx, nz] = normalOf(sea[e], sea[e + 1]);
    beachSamples.push(heightAt((sea[e][0] + sea[e + 1][0]) / 2 + nx * 6, (sea[e][1] + sea[e + 1][1]) / 2 + nz * 6));
  }
  beachSamples.sort((a, b) => a - b);
  const BEACH = THREE.MathUtils.clamp(beachSamples[beachSamples.length >> 1] + 0.25, 1.8, 3.2);
  const FOOT = BEACH - 1.6;
  const deckSamples = [];
  for (let k = 0; k < 600; k++) {
    const x = -95 + ((k * 37) % 121), z = 618 + ((k * 53) % 85);
    if (!pointInRing(x, z, outline) || pointInRing(x, z, perlaRing)) continue;
    if (distToRing(x, z, outline) > 3.5) deckSamples.push(heightAt(x, z));
  }
  deckSamples.sort((a, b) => a - b);
  const DECK = THREE.MathUtils.clamp(deckSamples.length ? deckSamples[deckSamples.length >> 1] : 8.5, 7.5, 9.5);
  // the terrace at (x, z): the LiDAR read 4 m in from the front (the 2 m grid smooths the drop at the wall into a bank),
  // within a few centimetres of the deck's general level where the LiDAR sees the sand (under the buildings)
  const terraceAt = (x, z) => {
    const { d, bx, bz } = frontDist(x, z);
    let sx = x, sz = z;
    if (d < 4) {
      let ix = x - bx, iz = z - bz;
      if (Math.hypot(ix, iz) < 1e-3) {
        // on the front: step inwards
        ix = 0; iz = 0;
        for (const [ox, oz] of [[0.3, 0], [-0.3, 0], [0, 0.3], [0, -0.3]]) {
          if (pointInRing(x + ox, z + oz, outline)) { ix += ox; iz += oz; }
        }
      }
      const il = Math.hypot(ix, iz) || 1;
      sx = x + (ix / il) * (4 - d);
      sz = z + (iz / il) * (4 - d);
    }
    const t = heightAt(sx, sz);
    return THREE.MathUtils.clamp(Number.isFinite(t) ? t : DECK, DECK - 0.12, DECK + 0.45) + 0.06;
  };

  const facade = perlaFacadeMaterial();
  const tiles = tileRoofMaterial();
  const bin = new PartBin();
  const walls = new Quads(['facade', 'fstyle']);
  const cream = (geo) => bin.add(facade, geo, null, PLAIN);
  const paint = (geo, color) => bin.add(M.paint, geo, color);
  const stone = (geo, color = GREY_STONE) => bin.add(M.stone, geo, color);

  // --- the storey on the sand -----------------------------------------------------------------------------------------
  const kindOf = (a, b, stairs) => {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const [nx, nz] = normalOf(a, b);
    const mx = (a[0] + b[0]) / 2 - nx * 0.6, mz = (a[1] + b[1]) / 2 - nz * 0.6; // just inside
    if (stairs || L < 1.2) return 'jog'; // (plain: the landing at the stairs' top, the pilasters' jogs)
    if (pointInRing(mx, mz, perlaRing)) return 'apse';
    if ((cafeRing && pointInRing(mx, mz, cafeRing)) || (eguzkiRing && pointInRing(mx, mz, eguzkiRing))) return 'pavilion';
    if (L > 20) return 'gallery';
    return 'bow';
  };
  const runs = [];
  for (let e = 0; e + 1 < front.length; e++) {
    const a = front[e], b = front[e + 1];
    runs.push({ a, b, kind: kindOf(a, b, e >= sea.length - 1), L: Math.hypot(b[0] - a[0], b[1] - a[1]) });
  }
  const baysOf = (r) => (r.kind === 'jog' ? 1 : r.kind === 'gallery' ? Math.round(r.L / BAY) : Math.max(1, Math.round(r.L / 4.6)));
  for (const r of runs) {
    wallRun(walls, [r.a, r.b], {
      yBot: () => FOOT, yTop: terraceAt, floor: BEACH, height: DECK - BEACH,
      bays: () => baysOf(r), style: () => ({ code: r.kind === 'jog' ? F.plain : F.arcade }),
      seed: Math.abs(r.a[0] * 0.013 + r.a[1] * 0.007) % 1
    });
  }
  // free-standing Tuscan columns before the arcades of the galleries and bows, pilasters on the pavilions' and the
  // apse's facets
  const colTop = DECK - 0.78, colBot = BEACH + 1.0;
  const placed = new Set();
  for (const r of runs) {
    if (r.kind === 'jog') continue;
    const n = baysOf(r);
    const [nx, nz] = normalOf(r.a, r.b);
    const yaw = Math.atan2(r.b[1] - r.a[1], r.b[0] - r.a[0]);
    for (let k = 0; k <= n; k++) {
      const x = r.a[0] + ((r.b[0] - r.a[0]) * k) / n, z = r.a[1] + ((r.b[1] - r.a[1]) * k) / n;
      const id = `${x.toFixed(1)},${z.toFixed(1)}`;
      if (placed.has(id)) continue;
      placed.add(id);
      if (r.kind === 'gallery' || r.kind === 'bow') {
        const cx = x + nx * 0.4, cz = z + nz * 0.4;
        const shaft = new THREE.CylinderGeometry(0.21, 0.24, colTop - colBot - 0.5, 10);
        shaft.translate(cx, (colTop + colBot) / 2, cz);
        cream(shaft);
        cream(post(0.6, 0.6, cx, cz, colBot - 0.02, colBot + 0.25, yaw));
        cream(post(0.64, 0.64, cx, cz, colTop - 0.25, colTop, yaw));
      } else {
        cream(post(0.6, 0.3, x + nx * 0.08, z + nz * 0.08, colBot, DECK - 0.4, yaw));
      }
    }
  }
  // plinth course, the entablature over the columns, the terraces' blue-grey limestone cornice
  cream(band(front, () => BEACH + 1.0, { out: 0.16, y0: -0.12, y1: 0.06 }));
  cream(band(front, terraceAt, { out: 0.66, y0: -0.8, y1: -0.36 }));
  stone(band(front, terraceAt, { out: 0.84, y0: -0.36, y1: -0.04 }));

  // --- the terraces: paving over the storey on the sand, draped on the promenade's surface
  // (under the pavilions; under the apse, inside the pools' upstand)
  const skip = [[perlaRing, 0.7], [cafeRing, 0.4], [eguzkiRing, 0.4]].map(([r, d]) => r && insetRing(r, d)).filter(Boolean);
  stone(deck(outline, terraceAt, skip), PAVING);

  // --- the pavilions ----------------------------------------------------------------------------------------------------
  const onFront = (a, b) => frontDist((a[0] + b[0]) / 2, (a[1] + b[1]) / 2).d < 0.6;
  const pinnacles = [];

  // walls from the deck to the eaves (a door in the middle of the landward end), pilasters with pedestals over them,
  // flower boxes under the windows to the terraces, a moulded cornice and the tiled hipped roof
  function pavilion(ring, { eave, rise, blooms, frontAt = onFront, floor = DECK, shopAll = false }) {
    const pts = pairs(ring);
    pts.push(pts[0]);
    const h = eave - floor;
    let far = -1, farD = -1;
    for (let e = 0; e + 1 < pts.length; e++) {
      const d = frontDist((pts[e][0] + pts[e + 1][0]) / 2, (pts[e][1] + pts[e + 1][1]) / 2).d;
      if (d > farD && Math.hypot(pts[e + 1][0] - pts[e][0], pts[e + 1][1] - pts[e][1]) > 3) { farD = d; far = e; }
    }
    const baysAt = (L) => (L < 1.6 ? 1 : Math.max(1, Math.round(L / 3.6)));
    const isDoor = (e, k, n) => e === far && n >= 3 && k === n >> 1;
    wallRun(walls, pts, {
      yBot: () => floor - 0.25, yTop: () => eave, floor, height: h, bays: baysAt,
      style: (e, k, n, L) => {
        if (L < 1.6) return { code: F.plain };
        if (isDoor(e, k, n)) return { code: F.door };
        if (frontAt(pts[e], pts[e + 1])) return { code: F.upper, flags: 1 };
        return { code: shopAll ? F.shop : F.upper };
      },
      seed: Math.abs(pts[0][0] * 0.031) % 1
    });
    for (let e = 0; e + 1 < pts.length; e++) {
      const a = pts[e], b = pts[e + 1];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const [nx, nz] = normalOf(a, b);
      const yaw = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const n = L < 1.6 ? 0 : baysAt(L);
      for (let k = 0; k <= n; k++) {
        const x = a[0] + (n ? ((b[0] - a[0]) * k) / n : 0) + nx * 0.07, z = a[1] + (n ? ((b[1] - a[1]) * k) / n : 0) + nz * 0.07;
        cream(post(0.5, 0.22, x, z, floor - 0.2, eave - 0.3, yaw));
        if (k > 0 && k < n) finial(x + nx * 0.22, z + nz * 0.22, eave + 0.1, yaw);
      }
      if (n && blooms && !frontAt(a, b)) {
        for (let k = 0; k < n; k++) {
          if (isDoor(e, k, n)) continue;
          const t = (k + 0.5) / n, bw = L / n - 1.15;
          if (bw < 0.6) continue;
          const x = a[0] + (b[0] - a[0]) * t + nx * 0.3, z = a[1] + (b[1] - a[1]) * t + nz * 0.3;
          paint(post(bw, 0.38, x, z, floor + 0.6, floor + 0.92, yaw), CREAM_PAINT);
          paint(post(bw - 0.08, 0.34, x, z, floor + 0.92, floor + 1.2, yaw), blooms);
        }
      }
    }
    const closed = pts.slice(0, -1);
    cream(band(closed, () => eave - 0.3, { out: 0.3, y0: 0, y1: 0.3, closed: true }));
    cream(band(closed, () => eave, { out: 0.42, y0: 0, y1: 0.1, closed: true }));
    const roofRing = insetRing(ring, -0.38) || ring;
    bin.add(tiles, hipRoof(roofRing, eave + 0.1, rise, Math.min(3.4, rise * 1.6)), null, { rinfo: [eave + 0.1, rise, 0, 0] });
  }

  // a small stepped pedestal on a cornice
  function finial(x, z, y, yaw) {
    paint(post(0.44, 0.44, x, z, y, y + 0.34, yaw), CREAM_PAINT);
    paint(post(0.54, 0.54, x, z, y + 0.34, y + 0.42, yaw), CREAM_PAINT);
    const cap = new THREE.CylinderGeometry(0.05, 0.25, 0.32, 4);
    cap.rotateY(Math.PI / 4 - yaw);
    cap.translate(x, y + 0.58, z);
    paint(cap, CREAM_PAINT);
  }

  // the end pavilions: Café de la Concha and Eguzki, two storeys over the sand at their canted seaward ends
  for (const [key, ring] of [['cafe', cafeRing], ['eguzki', eguzkiRing]]) {
    if (!ring) continue;
    const b = GEO.buildings[found[key]];
    const eave = THREE.MathUtils.clamp(b.eave, DECK + 3.4, DECK + 4.6);
    const rise = THREE.MathUtils.clamp(b.top - b.eave - 0.2, 1.4, 2.6);
    pavilion(ring, { eave, rise, blooms: key === 'cafe' ? BLOOMS.cafe : null }); // (Eguzki's offices have none)
    // pinnacle piers at the seaward corners: the ends of the run of the outline's points along the front
    const pts = pairs(ring);
    const run = longestRun(pts.map((p, i) => ({ p, i })), ({ p }) => frontDist(...p).d < 1.2);
    if (run.length >= 2) for (const { p } of [run[0], run[run.length - 1]]) pinnacles.push({ x: p[0], z: p[1], top: eave, ring });
  }

  // La Perla in the middle: the apse with the pools under glass, the restaurant behind it
  {
    const ob = kit.orientedBox(perlaRing);
    let ax = Math.cos(ob.angle), az = Math.sin(ob.angle);
    if (ax * 0.506 + az * 0.863 < 0) { ax = -ax; az = -az; } // v runs from the apse to the promenade
    const fr = new Frame(ob.x, ob.z, Math.atan2(az, ax) - Math.PI / 2);
    const local = [];
    for (const [x, z] of pairs(perlaRing)) local.push(...fr.local(x, z));
    const lp = pairs(local);
    // the restaurant starts a little seaward of its canted side bays
    const bayV = Math.min(...lp.filter(([uu]) => Math.abs(uu) > 10.4).map(([, vv]) => vv));
    const split = Number.isFinite(bayV) ? bayV - 0.9 : 1.5;
    const toWorld = (r) => {
      const out = [];
      for (let k = 0; k < r.length; k += 2) out.push(...fr.world(r[k], r[k + 1]));
      return out;
    };
    const b = GEO.buildings[found.perla];
    const eave = THREE.MathUtils.clamp(b.eave, DECK + 3.6, DECK + 4.8);
    const rise = THREE.MathUtils.clamp(b.top - b.eave - 0.3, 1.6, 2.8);
    const rest = clipRing(local, 0, 1, -split); // v >= split
    const hall = clipRing(local, 0, -1, split); // v <= split
    if (rest) {
      const rw = wound(toWorld(rest), true);
      pavilion(rw, { eave, rise, blooms: BLOOMS.perla, frontAt: () => false });
      sign(rw, eave);
    }
    if (hall) glassHall(wound(hall, true), fr, split);
    // the pinnacle piers where the apse meets the galleries
    for (const r of runs) {
      if (r.kind !== 'gallery') continue;
      for (const [x, z] of [r.a, r.b]) {
        if (distToRing(x, z, perlaRing) < 1.5) pinnacles.push({ x, z, top: DECK + 2.0, ring: perlaRing });
      }
    }
  }

  // "La Perla" over the restaurant's door on the promenade front (the edge farthest from the sea): a dark panel standing
  // on the cornice before the roof, and a narrow dark band ("Restaurante · Café · Jatetxea") in the frieze below it
  function sign(ring, eave) {
    const fp = pairs(ring);
    let best = null;
    for (let e = 0; e < fp.length; e++) {
      const a = fp[e], c = fp[(e + 1) % fp.length];
      const d = frontDist((a[0] + c[0]) / 2, (a[1] + c[1]) / 2).d;
      if (!best || d > best.d) best = { a, c, d };
    }
    const { a, c } = best;
    const [nx, nz] = normalOf(a, c);
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const ux = (c[0] - a[0]) / l, uz = (c[1] - a[1]) / l;
    const cx = (a[0] + c[0]) / 2, cz = (a[1] + c[1]) / 2;
    const mx = cx + nx * 0.3, mz = cz + nz * 0.3;
    const L = 4.4, H = 0.86, y0 = eave + 0.14;
    const p0 = [mx - (ux * L) / 2, mz - (uz * L) / 2], p1 = [mx + (ux * L) / 2, mz + (uz * L) / 2];
    const q = new Quads(['facade', 'fstyle']);
    const sty = [F.sign, H, 0, 0];
    // u runs right to left along the edge seen from outside: the letters read from p1 to p0
    q.quad([p0[0], y0, p0[1]], [p1[0], y0, p1[1]], [p1[0], y0 + H, p1[1]], [p0[0], y0 + H, p0[1]], [nx, 0, nz], {
      facade: [[L, 0, L, 0], [0, 0, L, 0], [0, H, L, 0], [L, H, L, 0]], fstyle: [sty, sty, sty, sty]
    });
    bin.add(facade, q.geometry());
    const yaw = Math.atan2(uz, ux);
    paint(post(L + 0.14, 0.14, mx - nx * 0.08, mz - nz * 0.08, y0 - 0.06, y0 + H + 0.07, yaw), DARK_IRON);
    paint(post(3.3, 0.06, cx + nx * 0.03, cz + nz * 0.03, eave - 0.86, eave - 0.56, yaw), DARK_IRON);
  }

  // The pools' hall in the apse (local frame of the restaurant, positively wound): a low cream upstand inside the
  // apse's edge, the glazed roof rising from it in two tiers towards the restaurant's wall, a glazed lantern on top; a
  // ledge with its railing between the upstand and the edge
  function glassHall(hallLocal, fr, split) {
    const inner = insetRing(hallLocal, 0.9);
    if (!inner) return;
    const ring = pairs(inner);
    const n = ring.length;
    const focus = [0, split];
    const ys = [DECK + 0.45, DECK + 1.85, DECK + 2.6];
    const lerp = (p, t) => [p[0] + (focus[0] - p[0]) * t, p[1] + (focus[1] - p[1]) * t];
    const tiers = [ring, ring.map((p) => lerp(p, 0.42)), ring.map((p) => lerp(p, 0.78))];
    const W = (p) => fr.world(p[0], p[1]);
    const q = new Quads(['facade', 'fstyle']);
    const sty = [F.glassRoof, 0, 0, 0];
    let s = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (ring[i][1] > split - 1.2 && ring[j][1] > split - 1.2) continue; // against the restaurant's wall
      const len = Math.hypot(ring[j][0] - ring[i][0], ring[j][1] - ring[i][1]);
      let v = 0;
      for (let t = 0; t < 2; t++) {
        const [a, b, c, d] = [W(tiers[t][i]), W(tiers[t][j]), W(tiers[t + 1][j]), W(tiers[t + 1][i])];
        const A = [a[0], ys[t], a[1]], B = [b[0], ys[t], b[1]], C = [c[0], ys[t + 1], c[1]], D = [d[0], ys[t + 1], d[1]];
        const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [D[0] - A[0], D[1] - A[1], D[2] - A[2]];
        let nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
        if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const nl = Math.hypot(nx, ny, nz) || 1;
        const slope = Math.hypot(D[0] - A[0], D[1] - A[1], D[2] - A[2]);
        q.quad(A, B, C, D, [nx / nl, ny / nl, nz / nl], {
          facade: [[s, v, len, 0], [s + len, v, len, 0], [s + len, v + slope, len, 0], [s, v + slope, len, 0]],
          fstyle: [sty, sty, sty, sty]
        });
        v += slope;
      }
      s += len;
    }
    bin.add(facade, q.geometry());
    // the lantern's flat top
    const top = tiers[2].map(W);
    const cap = new THREE.ShapeGeometry(new THREE.Shape(top.map(([x, z]) => new THREE.Vector2(x, -z))));
    cap.rotateX(-Math.PI / 2);
    cap.translate(0, ys[2], 0);
    const cn = cap.attributes.position.count, capFac = [], capSty = [];
    for (let k = 0; k < cn; k++) {
      capFac.push(cap.attributes.position.getX(k), cap.attributes.position.getZ(k), 1, 0);
      capSty.push(F.glassRoof, 0, 0, 0);
    }
    cap.setAttribute('facade', new THREE.Float32BufferAttribute(capFac, 4));
    cap.setAttribute('fstyle', new THREE.Float32BufferAttribute(capSty, 4));
    bin.add(facade, cap);
    // the upstand round the glazing
    cream(band(ring.map(W), () => DECK, { out: 0.25, y0: -0.1, y1: 0.45, closed: true }));
    // the ledge's railing along the apse's edge
    railing(longestRun(pairs(hallLocal).map(W), ([x, z]) => frontDist(x, z).d < 0.8));
  }

  // --- the small pavilions on the terraces --------------------------------------------------------------------------
  for (const key of ['bataplan', 'kontxa14']) {
    const ring = ringOf(key, 0.25);
    if (!ring) continue;
    const b = GEO.buildings[found[key]];
    const eave = THREE.MathUtils.clamp(b.eave, DECK + 2.3, DECK + 3.2);
    const rise = THREE.MathUtils.clamp(b.top - b.eave, 0.8, 1.4);
    pavilion(ring, { eave, rise, blooms: null, frontAt: () => false, shopAll: true });
  }

  // --- the corner piers' pinnacles: a shaft from the sand to a metre above the eaves, its cap louvred, and the crown: a
  // ship's hull on each face, keel down and its ends curling up in scrolls, round a stepped spire with volutes at its
  // corners
  for (const { x, z, top, ring } of pinnacles) {
    const pts = pairs(ring);
    let yaw = 0, bd = Infinity;
    for (let e = 0; e < pts.length; e++) {
      const a = pts[e], c = pts[(e + 1) % pts.length];
      const d = distToRing(x, z, [...a, ...c, ...a]);
      if (d < bd) { bd = d; yaw = Math.atan2(c[1] - a[1], c[0] - a[0]); }
    }
    const y1 = top + 1.05;
    // a part built round the origin along x, laid along the crown's face that looks towards a (radians from +x towards
    // +z), u out from the pier's axis
    const at = (geo, u, y, a) => {
      geo.rotateY(-a + Math.PI / 2);
      geo.translate(x + Math.cos(a) * u, y, z + Math.sin(a) * u);
      return geo;
    };
    cream(post(1.35, 1.35, x, z, FOOT, y1, yaw));
    cream(post(1.6, 1.6, x, z, y1, y1 + 0.3, yaw));
    paint(post(1.2, 1.2, x, z, y1 + 0.3, y1 + 0.85, yaw), CREAM_PAINT);
    for (let k = 0; k < 4; k++) {
      const a = yaw + (k * Math.PI) / 2;
      const hull = new THREE.CylinderGeometry(0.34, 0.34, 1.2, 8, 1, false, Math.PI / 2, Math.PI);
      hull.rotateZ(Math.PI / 2); // lying along x, open side up
      paint(at(hull, 0.55, y1 + 1.12, a), CREAM_PAINT);
      for (const s of [-1, 1]) {
        const scroll = new THREE.TorusGeometry(0.15, 0.06, 4, 8);
        scroll.translate(s * 0.62, 0, 0);
        paint(at(scroll, 0.6, y1 + 1.32, a), CREAM_PAINT);
      }
    }
    const spire = new THREE.CylinderGeometry(0.26, 0.6, 0.95, 4);
    spire.rotateY(Math.PI / 4 - yaw);
    spire.translate(x, y1 + 1.32, z);
    paint(spire, CREAM_PAINT);
    paint(post(0.72, 0.72, x, z, y1 + 1.78, y1 + 2.0, yaw), CREAM_PAINT);
    for (let k = 0; k < 4; k++) {
      const a = yaw + Math.PI / 4 + (k * Math.PI) / 2;
      const vol = new THREE.SphereGeometry(0.13, 6, 4);
      vol.translate(x + Math.cos(a) * 0.46, y1 + 1.9, z + Math.sin(a) * 0.46);
      paint(vol, CREAM_PAINT);
    }
    paint(post(0.42, 0.42, x, z, y1 + 2.0, y1 + 2.32, yaw), CREAM_PAINT);
    paint(post(0.24, 0.24, x, z, y1 + 2.32, y1 + 2.5, yaw), CREAM_PAINT);
  }

  // --- railings: white cast iron between limestone posts (blue-grey at La Perla, marble at the Caseta), two rails and
  // a ring every 0.45 m, standing on yAt(x, z)
  function railing(pts, yAt = terraceAt, postColour = GREY_STONE) {
    for (let e = 0; e + 1 < pts.length; e++) {
      const a = pts[e], c = pts[e + 1];
      const L = Math.hypot(c[0] - a[0], c[1] - a[1]);
      if (L < 0.4) continue;
      const yaw = Math.atan2(c[1] - a[1], c[0] - a[0]);
      const ya = yAt(...a), yc = yAt(...c);
      const posts = Math.max(1, Math.round(L / 2.4));
      for (let k = 0; k <= posts; k++) {
        const t = k / posts;
        const x = a[0] + (c[0] - a[0]) * t, z = a[1] + (c[1] - a[1]) * t, y = ya + (yc - ya) * t;
        stone(post(0.34, 0.34, x, z, y - 0.05, y + 1.05, yaw), postColour);
        stone(post(0.42, 0.42, x, z, y + 1.05, y + 1.16, yaw), postColour);
      }
      const mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2, my = (ya + yc) / 2;
      for (const [y0, y1] of [[0.06, 0.12], [0.97, 1.04]]) paint(post(L, 0.06, mx, mz, my + y0, my + y1, yaw), WHITE_IRON);
      const rings = Math.floor(L / 0.45);
      for (let k = 0; k < rings; k++) {
        const t = (k + 0.5) / rings;
        const tor = new THREE.TorusGeometry(0.16, 0.022, 3, 8);
        tor.rotateY(-yaw);
        tor.translate(a[0] + (c[0] - a[0]) * t, ya + (yc - ya) * t + 0.54, a[1] + (c[1] - a[1]) * t);
        paint(tor, WHITE_IRON);
      }
    }
  }
  // between the Café's terrace and the promenade, from the top of the beach stairs; beside the small pavilions
  railing(cafeRail);
  for (const r of TERRACE_RAILS) railing(pairs(r));

  if (found.caseta !== undefined) caseta(GEO.buildings[found.caseta], ringOf('caseta', 0.25));

  // The Caseta Real de Baños, 40 m south-west: Queen Maria Cristina's bathing pavilion, rebuilt in stone by Ramón
  // Cortázar in 1911 (b5m). White marble with grey veins over a rusticated dark limestone base (Wikimedia Commons:
  // "Kontxa-Kaseta" and "Eguzki-etxea" photographs, 2023; postcards of 1911-1920): two wings on the sand with bowed
  // ends, columns between tall windows and terraces at promenade level; in the middle, a half-round bastion between
  // two curved flights of stairs, its top the landing before the pavilion's lower storey; above it, on the promenade,
  // the pavilion: a great round-headed window over a balcony, between piers carrying obelisks, under a curved pediment
  // with the royal arms, a crown and two lions, and a dark slate dome with a lantern.
  function caseta(b, upper) {
    const west = pairs(CASETA.west), east = pairs(CASETA.east), front = pairs(CASETA.front);
    const chain = [...west, ...front.slice(1, -1), ...east];
    // the beach 6 m out; the promenade 2.5 m in from the back line; the landing three metres over the sand
    const sand = [];
    for (let e = 0; e + 1 < chain.length; e++) {
      const [nx, nz] = normalOf(chain[e], chain[e + 1]);
      sand.push(heightAt((chain[e][0] + chain[e + 1][0]) / 2 + nx * 6, (chain[e][1] + chain[e + 1][1]) / 2 + nz * 6));
    }
    sand.sort((p, q) => p - q);
    const beach = THREE.MathUtils.clamp(sand[sand.length >> 1] + 0.25, 1.8, 3.2), foot = beach - 1.6;
    const [b0, b1] = pairs(CASETA.back);
    const [inX, inZ] = normalOf(b0, b1); // into the promenade
    const prom = [0.15, 0.4, 0.65, 0.9].map((t) => heightAt(b0[0] + (b1[0] - b0[0]) * t + inX * 2.5, b0[1] + (b1[1] - b0[1]) * t + inZ * 2.5));
    prom.sort((p, q) => p - q);
    const PROM = THREE.MathUtils.clamp((prom[1] + prom[2]) / 2, 8, 10.5) + 0.05;
    const LAND = beach + 3.0;
    const EAVE = THREE.MathUtils.clamp(b.eave, PROM + 3.6, PROM + 4.6);
    const marble = (geo) => bin.add(facade, geo, null, { facade: [0, 99, 1, 0], fstyle: [F.plain, 99, 0, 1] });
    const rustic = (geo) => stone(geo, RUSTIC);

    // the wings on the sand: bays about 2.3 m measured round their bows, a column before each pier
    const wingPath = (pts) => {
      let L = 0;
      for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
      return resampleBy(pts, Math.max(1, Math.round(L / 2.3)));
    };
    for (const pts of [wingPath(west.slice(1)), wingPath(east.slice(0, -3))]) {
      wallRun(walls, pts, {
        yBot: () => foot, yTop: () => PROM, floor: beach, height: PROM - beach, bays: () => 1,
        style: () => ({ code: F.colonnade }), seed: 0.61, finish: 1
      });
      for (let k = 1; k + 1 < pts.length; k++) {
        const [ax, az] = normalOf(pts[k - 1], pts[k]), [bx, bz] = normalOf(pts[k], pts[k + 1]);
        const nl = Math.hypot(ax + bx, az + bz) || 1;
        const cx = pts[k][0] + ((ax + bx) / nl) * 0.22, cz = pts[k][1] + ((az + bz) / nl) * 0.22;
        const shaft = new THREE.CylinderGeometry(0.15, 0.17, PROM - 1.05 - (beach + 2.55), 10);
        shaft.translate(cx, (PROM - 1.05 + beach + 2.55) / 2, cz);
        marble(shaft);
        marble(post(0.42, 0.42, cx, cz, beach + 2.4, beach + 2.58, 0));
        marble(post(0.46, 0.46, cx, cz, PROM - 1.1, PROM - 0.95, 0));
      }
    }
    // the wings' plain ends, and the lower storey's sides beside the landing
    wallRun(walls, west.slice(0, 2), { yBot: () => foot, yTop: () => PROM, floor: beach, height: PROM - beach, bays: () => 1,
      style: () => ({ code: F.plain }), finish: 1 });
    wallRun(walls, east.slice(-4), { yBot: () => foot, yTop: () => PROM, floor: beach, height: PROM - beach, bays: () => 1,
      style: () => ({ code: F.colonnade }), seed: 0.37, finish: 1 });
    wallRun(walls, [front[0], front[1]], { yBot: () => foot, yTop: () => PROM, floor: beach, height: PROM - beach,
      bays: () => 1, style: () => ({ code: F.plain }), finish: 1 });
    wallRun(walls, [front[2], front[3]], { yBot: () => foot, yTop: () => PROM, floor: beach, height: PROM - beach,
      bays: () => 1, style: () => ({ code: F.plain }), finish: 1 });
    // the lower storey behind the landing: doors at the ends, windows between
    wallRun(walls, [front[1], front[2]], {
      yBot: () => LAND, yTop: () => PROM, floor: LAND, height: PROM - LAND, bays: () => 4,
      style: (e, k, n) => ({ code: k === 0 || k === n - 1 ? F.door : F.shop }), seed: 0.83, finish: 1
    });
    // the frieze and cornice round the wings and over the lower storey, at the terraces' level
    marble(band(chain, () => PROM, { out: 0.2, y0: -0.95, y1: -0.45 }));
    marble(band(chain, () => PROM, { out: 0.42, y0: -0.45, y1: -0.05 }));
    marble(band(chain, () => beach + 2.4, { out: 0.12, y0: 0, y1: 0.18 }));

    // the terraces over the wings, level with the promenade (not where the pavilion stands)
    const terraceRing = wound([...west, ...front.slice(1, -1), ...east, ...pairs(CASETA.back)].flat(), true);
    const under = upper && insetRing(upper, 0.3);
    stone(deck(terraceRing, () => PROM, under ? [under] : []), PAVING);

    // the landing: the bastion and the strip before the lower storey, rusticated from the sand, a marble coping
    const landing = wound(CASETA.landing, true);
    rustic(prismWalls(landing, foot, LAND - 0.25));
    marble(prismWalls(landing, LAND - 0.25, LAND));
    stone(cap(landing, LAND), MARBLE);
    // (the railing round the bastion's half round, between the stairs' tops)
    railing(pairs(landing).filter(([x, z]) => x < -131.0 && z < 704.5), () => LAND, MARBLE);

    // the stairs: steps 17 cm high between the bastion and the parapets
    for (const s of CASETA.stairs) {
      const n = Math.max(8, Math.round((LAND - beach) / 0.17));
      const rise = (LAND - beach) / n;
      const inner = resampleBy(pairs(s.inner), n), outer = resampleBy(pairs(s.outer), n);
      const q = new Quads([]);
      for (let k = 0; k < n; k++) {
        const y = beach + (k + 1) * rise, y0 = k ? y - rise : foot;
        const A = inner[k], B = outer[k], C = outer[k + 1], D = inner[k + 1];
        q.quad([A[0], y, A[1]], [B[0], y, B[1]], [C[0], y, C[1]], [D[0], y, D[1]], [0, 1, 0], {});
        const dx = (A[0] + B[0] - C[0] - D[0]) / 2, dz = (A[1] + B[1] - C[1] - D[1]) / 2, dl = Math.hypot(dx, dz) || 1;
        q.quad([A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], y, B[1]], [A[0], y, A[1]], [dx / dl, 0, dz / dl], {});
      }
      stone(q.geometry(), MARBLE);
    }
    // the parapets: rusticated, from the wings' cornice down with the stairs to the sand
    const [lcx, lcz] = centroid(landing);
    for (const p of CASETA.parapets) {
      const pts = pairs(p);
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const L = cum[cum.length - 1];
      const tops = cum.map((s) => (s < 2.4 ? LAND + 0.95 : LAND + 0.95 - ((LAND - beach) * (s - 2.4)) / (L - 2.4)));
      // outwards: away from the landing
      const [nx, nz] = normalOf(pts[1], pts[2]);
      const side = nx * (pts[1][0] - lcx) + nz * (pts[1][1] - lcz) > 0 ? 1 : -1;
      rustic(slab(pts, foot, tops, 0.5, side));
    }

    // the pavilion on the promenade: walls to the eaves, the front a pier, the great window and a pier
    if (!upper) return;
    const up = pairs(upper);
    up.push(up[0]);
    let frontEdge = 0, frontD = Infinity;
    for (let e = 0; e + 1 < up.length; e++) {
      const mx = (up[e][0] + up[e + 1][0]) / 2, mz = (up[e][1] + up[e + 1][1]) / 2;
      const d = Math.hypot(mx - (front[1][0] + front[2][0]) / 2, mz - (front[1][1] + front[2][1]) / 2);
      if (d < frontD) { frontD = d; frontEdge = e; }
    }
    const h = EAVE - PROM;
    for (let e = 0; e + 1 < up.length; e++) {
      const L = Math.hypot(up[e + 1][0] - up[e][0], up[e + 1][1] - up[e][1]);
      const isFront = e === frontEdge;
      wallRun(walls, [up[e], up[e + 1]], {
        yBot: () => PROM - 0.2, yTop: () => EAVE, floor: PROM, height: h, finish: 1, seed: 0.29 + e * 0.07,
        cuts: isFront ? () => [0, 0.22, 0.78, 1] : null, bays: (len) => (len < 1.8 ? 1 : Math.max(1, Math.round(len / 2.6))),
        style: (_, k, n) => (isFront ? { code: k === 1 ? F.arch : F.plain } : L < 1.8 ? { code: F.plain } : { code: F.upper })
      });
    }
    const closed = up.slice(0, -1);
    marble(band(closed, () => EAVE - 0.35, { out: 0.25, y0: 0, y1: 0.35, closed: true }));
    marble(band(closed, () => EAVE, { out: 0.45, y0: 0, y1: 0.14, closed: true }));
    bin.add(M.paint, hipRoof(insetRing(upper, -0.3) || upper, EAVE + 0.14, 0.9, 1.5), SLATE);

    // the front's frame: u along it (west to east), v into the pavilion
    const fa = up[frontEdge], fb = up[frontEdge + 1];
    const FL = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]);
    const ux = (fb[0] - fa[0]) / FL, uz = (fb[1] - fa[1]) / FL, vx = uz, vz = -ux; // (normalOf points out: v = -normal)
    const at = (u, v) => [fa[0] + ux * u - vx * v, fa[1] + uz * u - vz * v];
    const yaw = Math.atan2(uz, ux);
    // the balcony before the window, over the landing
    {
      const [cx, cz] = at(FL / 2, -0.45);
      marble(post(FL * 0.56 + 0.3, 0.9, cx, cz, PROM - 0.3, PROM, yaw));
      const c0 = at(FL * 0.22 - 0.15, -0.9), c1 = at(FL * 0.78 + 0.15, -0.9);
      railing([at(FL * 0.22 - 0.15, 0), c0, c1, at(FL * 0.78 + 0.15, 0)], () => PROM, MARBLE);
    }
    // piers at the front corners carrying obelisks
    for (const u of [0.35, FL - 0.35]) {
      const [x, z] = at(u, 0.3);
      marble(post(0.8, 0.8, x, z, PROM - 0.2, EAVE + 0.6, yaw));
      marble(post(0.95, 0.95, x, z, EAVE + 0.6, EAVE + 0.8, yaw));
      const ob = new THREE.CylinderGeometry(0.1, 0.27, 1.9, 4);
      ob.rotateY(Math.PI / 4 - yaw);
      ob.translate(x, EAVE + 1.75, z);
      marble(ob);
      const ball = new THREE.SphereGeometry(0.13, 8, 6);
      ball.translate(x, EAVE + 2.8, z);
      marble(ball);
    }
    // the curved pediment over the window, with the royal arms, the crown and two lions
    {
      const w = FL * 0.62, rise = 1.25;
      const shape = new THREE.Shape();
      shape.moveTo(-w / 2, 0);
      shape.lineTo(w / 2, 0);
      shape.lineTo(w / 2, 0.35);
      shape.quadraticCurveTo(0, rise * 2 - 0.35, -w / 2, 0.35);
      shape.closePath();
      const ped = new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false, curveSegments: 10 });
      ped.translate(0, 0, -0.2);
      ped.rotateY(-yaw);
      const [px, pz] = at(FL / 2, 0);
      ped.translate(px, EAVE - 0.05, pz);
      marble(ped);
      const [ax, az] = at(FL / 2, -0.15);
      marble(post(1.1, 0.4, ax, az, EAVE + rise - 0.5, EAVE + rise + 0.45, yaw));
      const crown = new THREE.CylinderGeometry(0.34, 0.26, 0.4, 8);
      crown.translate(ax, EAVE + rise + 0.65, az);
      marble(crown);
      // the lions couchant on the pediment's shoulders, facing the arms
      for (const s of [-1, 1]) {
        const [lx, lz] = at(FL / 2 + s * 1.0, 0.05);
        marble(post(0.9, 0.45, lx, lz, EAVE + 0.9, EAVE + 1.25, yaw));
        marble(post(0.34, 0.42, lx - s * ux * 0.35, lz - s * uz * 0.35, EAVE + 1.25, EAVE + 1.6, yaw));
      }
    }
    // the dome over the front room: a bell of dark slate rising from the cornice, a glazed lantern with a finial
    {
      const depth = Math.min(6.2, FL + 0.4);
      const rect = (d) => [at(-0.25 + d, -0.25 + d), at(FL + 0.25 - d, -0.25 + d), at(FL + 0.25 - d, depth - d), at(-0.25 + d, depth - d)];
      const levels = [[0, 0.14], [0.7, 1.05], [1.4, 1.75], [2.05, 2.1]];
      const q = new Quads([]);
      for (let l = 0; l + 1 < levels.length; l++) {
        const r0 = rect(levels[l][0]), r1 = rect(levels[l + 1][0]);
        const y0 = EAVE + levels[l][1], y1 = EAVE + levels[l + 1][1];
        for (let k = 0; k < 4; k++) {
          const j = (k + 1) % 4;
          const [nx, nz] = normalOf(r0[k], r0[j]);
          const run = levels[l + 1][0] - levels[l][0], climb = y1 - y0, nl = Math.hypot(run, climb);
          q.quad([r0[k][0], y0, r0[k][1]], [r0[j][0], y0, r0[j][1]], [r1[j][0], y1, r1[j][1]], [r1[k][0], y1, r1[k][1]],
            [(nx * climb) / nl, run / nl, (nz * climb) / nl], {});
        }
      }
      bin.add(M.paint, q.geometry(), SLATE);
      const top = rect(levels[levels.length - 1][0]);
      bin.add(M.paint, cap(top.flat(), EAVE + 2.1), SLATE);
      const [lx, lz] = at(FL / 2, depth / 2 - 0.25);
      marble(post(1.3, 1.3, lx, lz, EAVE + 2.1, EAVE + 2.75, yaw));
      const roof = new THREE.CylinderGeometry(0.12, 0.95, 0.5, 4);
      roof.rotateY(Math.PI / 4 - yaw);
      roof.translate(lx, EAVE + 3.0, lz);
      bin.add(M.paint, roof, SLATE);
      const fin = new THREE.SphereGeometry(0.14, 8, 6);
      fin.translate(lx, EAVE + 3.35, lz);
      bin.add(M.paint, fin, rgb(0x6f6a55));
    }
  }

  bin.add(facade, walls.geometry());
  const group = new THREE.Group();
  group.name = 'La Perla';
  bin.build(group);
  group.userData.hide = Object.values(found);
  return group;
}

// The terraces' paving over `ring`, draped on height(x, z) on a 2 m grid; cells wholly inside one of `skip` (where the
// pavilions stand) are left out
function deck(ring, height, skip) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  const S = 2;
  const pos = [];
  for (let x0 = Math.floor(minX / S) * S; x0 < maxX; x0 += S) {
    for (let z0 = Math.floor(minZ / S) * S; z0 < maxZ; z0 += S) {
      const corners = [[x0, z0], [x0 + S, z0], [x0, z0 + S], [x0 + S, z0 + S]];
      if (skip.some((r) => corners.every(([x, z]) => pointInRing(x, z, r)))) continue;
      let piece = ring;
      for (const [a, b, c] of [[1, 0, -x0], [-1, 0, x0 + S], [0, 1, -z0], [0, -1, z0 + S]]) piece = piece && clipRing(piece, a, b, c);
      if (!piece || Math.abs(ringArea(piece)) < 1e-3) continue;
      const pts = [];
      for (let k = 0; k < piece.length; k += 2) pts.push(new THREE.Vector2(piece[k], piece[k + 1]));
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(pts, [])) {
        const P = [pts[i], pts[j], pts[k]].map((p) => [p.x, height(p.x, p.y), p.y]);
        // wound to face up
        const up = (P[1][2] - P[0][2]) * (P[2][0] - P[0][0]) - (P[1][0] - P[0][0]) * (P[2][2] - P[0][2]);
        if (up >= 0) pos.push(...P[0], ...P[1], ...P[2]);
        else pos.push(...P[0], ...P[2], ...P[1]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
