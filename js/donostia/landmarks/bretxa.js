import * as THREE from 'three/webgpu';
import {
  attribute, float, vec2, vec3, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot, clamp, length, select,
  fwidth, pow, normalize, positionWorld, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { CivicModel, facadeStyle, rect, ccwRing, offsetRing } from './udaletxea.js';
import { newell } from './geom.js';

// js/donostia/landmarks/bretxa.js
// La Bretxa market, on the corner of the Alameda del Boulevard and Bretxa plaza at the eastern edge of the Parte Vieja.
// Three buildings, one model (the three OSM outlines):
//  - the 1870 market hall rebuilt in 1899 (way 23905055, b5m 11.4 m to the eaves, 17 m at the ridges), the "Edificio
//    Arkoak" of the shopping centre since 2000: a sandstone arcade of large round arches between fluted pilasters under
//    an entablature inscribed "1870 MERCADO 1899", and glazed iron gables behind a palmette acroterion each;
//  - the Pescadería (the fish market, way 23905020; the Parte Vieja health centre upstairs): sandstone, a rusticated
//    ground floor, tall windows set in white render panels on the main floor (shuttered in older photos, glazed
//    now), a central pavilion with a stained-glass window and PESCADERIA carved over it under the crowned city arms,
//    two balustraded flights rising along its front from the corners to doors in the pavilion's flanks, and a glazed
//    rooftop storey set back behind the parapet (b5m 16 m mean, 22 m at the arms);
//  - the glass pavilion of the underground market (way 119089295, 1999) on the plaza between them, MERKATUA.
// The photos (Wikimedia Commons: Luistxo, pere prlpz, Joxemai, Zarateman) tell the outlines apart: the glass
// pavilion (MERKATUA and MERCADO in big letters on its roof edge) stands before the Pescadería's stair front, and the
// 1870 / 1899 inscriptions, fluted pilasters and palmettes are on the Boulevard hall.
//
// The first half of this file is the kit shared by the round-2 central landmarks (boulevard-kioskoa.js, tabakalera.js
// and atotxa-dorrea.js import it): a geometry model built on udaletxea.js's CivicModel that places each part in its own
// frame, and one facade material (after udaletxea.js's civicFacadeMaterial) whose windows, arcades, ribbon windows,
// curtain walls, panels and mesh cladding come from per-vertex attributes, so all four share a single facade pipeline.
//
// build(sites, ctx) receives the GEO.landmarks entries ['bretxa', 'bretxa-merkatua', 'bretxa-plaza'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D
// in world (local-frame) coordinates.

// ---------------------------------------------------------------------------------------------------------------------
// Facade styles
// ---------------------------------------------------------------------------------------------------------------------

// What the shader draws on a wall: plain masonry; square-headed windows; round-headed windows; a big round-arched
// arcade with fluted pilasters; a balustrade (as udaletxea.js's WIN.balustrade, so CivicModel.balustrade works);
// rustication; continuous ribbon windows; inset panels; a glass curtain wall; metal mesh cladding. CAP marks
// horizontal faces.
export const FK = { plain: 0, rect: 1, arched: 2, arcade: 3, balustrade: 4, rustic: 5, ribbon: 6, panel: 7, glazed: 8, mesh: 9, cap: 15 };

// Wall finishes: golden sandstone ashlar (La Bretxa, Tabakalera's plinth and dressings); white render with white
// mouldings (Tabakalera's wings); sandstone with the windows set in white render panels (the Pescadería, and with
// narrower panels Tabakalera's pavilions); board-marked grey concrete with cream window
// frames (Torre de Atotxa); light grey stone with pink marble slabs (the kiosko's plinth); bronze mesh (Tabakalera's
// Prisma); pale grey cladding; the red soffit of the Atotxa crown; the shadowed sandstone of carved lettering; the
// grey frames of glazed roofs.
export const FT = {
  sand: 0, white: 1, sandPanel: 2, concrete: 3, stone: 4, bronze: 5, grey: 6, red: 7, sandPanelGlass: 8, carved: 9,
  roofGlass: 10
};
// Each finish: wall, frame (the 0.3 m moulded surround of an opening) and panel (a wider band round it, or the inset
// slab of the panel kind) colours in linear RGB; pw: panel band width (0: none); pm: inset panel margin; ashlar
// coursing; board-marked ribs; warm floodlights at night; dim: glazing that stays nearly dark at night (roofs and
// lanterns over closed halls).
const finish = (wall, frame = wall, panel = frame, o = {}) => ({
  wall, frame, panel, pw: 0, pm: 0.16, ashlar: 0, ribs: 0, flood: 0, dim: 0, ...o
});
const SAND = [0.6, 0.42, 0.2], SAND_LIGHT = [0.68, 0.5, 0.27], RENDER = [0.84, 0.83, 0.79]; // sandstone ~sRGB #cdaa73
const PALETTE = [
  finish(SAND, SAND_LIGHT, SAND_LIGHT, { ashlar: 1, flood: 1 }), // sand
  finish(RENDER, [0.8, 0.79, 0.75], RENDER, { flood: 1 }), // white
  finish(SAND, SAND_LIGHT, RENDER, { pw: 1.0, ashlar: 1, flood: 1 }), // sandPanel
  finish([0.165, 0.165, 0.16], [0.15, 0.15, 0.145], [0.165, 0.165, 0.16], { ribs: 1 }), // concrete
  finish([0.6, 0.58, 0.54], [0.6, 0.58, 0.54], [0.42, 0.22, 0.22], { pm: 0.015 }), // stone
  finish([0.15, 0.1, 0.065], [0.09, 0.07, 0.05], [0.15, 0.1, 0.065]), // bronze
  finish([0.8, 0.81, 0.8], [0.6, 0.6, 0.6], [0.8, 0.81, 0.8]), // grey
  finish([0.5, 0.13, 0.1]), // red
  finish(SAND, SAND_LIGHT, RENDER, { pw: 0.9, ashlar: 1, flood: 1 }), // sandPanelGlass
  finish([0.25, 0.16, 0.07]), // carved
  finish([0.8, 0.81, 0.8], [0.6, 0.6, 0.6], [0.8, 0.81, 0.8], { dim: 1 }) // roofGlass
];

// bay: target window spacing (m; the wall is split into whole bays); floor / ground: storey heights above the part's
// base (the storey grid starts at `base`, metres above the frame's ground). Same layout as udaletxea.js's styles.
export function style(kind, tone, { bay = 3.6, floor = 4, ground = 0, base = 0, seed = 0 } = {}) {
  return facadeStyle(kind, tone, { bay, floor, ground, base, seed });
}

// ---------------------------------------------------------------------------------------------------------------------
// The shared facade material
// ---------------------------------------------------------------------------------------------------------------------

let facadeMaterial = null;

// Attributes as udaletxea.js's civicFacadeMaterial: facade = (s: metres along the wall, h: metres above the part's
// base, wall length, wall top above the base), fstyle = (bay, floor, ground, kind + 16 tone + 256 seed): sixteen
// finishes instead of eight (CentreModel.face writes them).
export function centreFacadeMaterial() {
  if (facadeMaterial) return facadeMaterial;
  const mat = new THREE.MeshStandardNodeMaterial();
  const fa = attribute('facade', 'vec4');
  const fs = attribute('fstyle', 'vec4');
  const s = fa.x, h = fa.y, wallLen = max(fa.z, 0.01), wallTop = fa.w;
  const bayTarget = max(fs.x, 0.05), floorH = max(fs.y, 0.05), groundH = fs.z, code = fs.w;
  // the code is an exact small integer per face; the +0.01 keeps floor() stable on interpolated values
  const seed = floor(code.div(256).add(0.01));
  const rem = code.sub(seed.mul(256));
  const tone = floor(rem.div(16).add(0.01));
  const kind = rem.sub(tone.mul(16));
  const isKind = (k) => step(k - 0.5, kind).mul(step(kind, k + 0.5));
  const kRect = isKind(FK.rect), kArched = isKind(FK.arched), kArcade = isKind(FK.arcade), kBal = isKind(FK.balustrade);
  const kRustic = isKind(FK.rustic), kRibbon = isKind(FK.ribbon), kPanel = isKind(FK.panel), kGlazed = isKind(FK.glazed);
  const kMesh = isKind(FK.mesh), kCap = isKind(FK.cap);
  const pickF = (key) => {
    let v = float(PALETTE[0][key]);
    for (let k = 1; k < PALETTE.length; k++) v = select(tone.greaterThan(k - 0.5), float(PALETTE[k][key]), v);
    return v;
  };
  const pickV = (key) => {
    let v = vec3(...PALETTE[0][key]);
    for (let k = 1; k < PALETTE.length; k++) v = select(tone.greaterThan(k - 0.5), vec3(...PALETTE[k][key]), v);
    return v;
  };

  // metres per pixel on the wall, for anti-aliasing and fading fine detail with distance
  const pix = max(max(fwidth(s), fwidth(h)), 0.0005);
  const lineAA = (dist, w) => float(1).sub(smoothstep(w, pix.add(w), dist));
  const fadeBelow = (size) => float(1).sub(smoothstep(size * 0.3, size, pix));

  // Whole bays per wall; px0 = metres from the bay's centre line
  const bays = max(floor(wallLen.div(bayTarget).add(0.5)), 1.0);
  const bayW = wallLen.div(bays);
  const bayIdx = floor(s.div(bayW));
  const px0 = fract(s.div(bayW)).sub(0.5).mul(bayW);
  const bayEdge = bayW.mul(0.5).sub(abs(px0)); // metres to the bay's edge
  const dx = abs(px0);
  const narrow = step(wallLen, bayTarget.mul(0.7));

  // Storeys: an optional taller ground storey, then floors of floorH; windows only in storeys under the wall's top
  const inGround = h.lessThan(groundH);
  const g = select(inGround, float(1), float(0));
  const level = max(h.sub(groundH), 0.0).div(floorH);
  const storey = select(inGround, float(-1), floor(level));
  const storeyBase = select(inGround, float(0), groundH.add(floor(level).mul(floorH)));
  const storeyH = select(inGround, max(groundH, 0.05), floorH);
  const py = h.sub(storeyBase);
  const fits = step(storeyBase.add(storeyH), wallTop.add(0.05));
  const above = step(0.0, h);

  // Punched openings: half-width (share of the bay), sill & head (m above the storey's floor); arched kinds are round
  // headed. Kinds are exclusive, so masked sums pick one set.
  const halfFrac = kRect.mul(mix(float(0.2), float(0.24), g)).add(kArched.mul(0.19)).add(kArcade.mul(0.36));
  const halfW = halfFrac.mul(bayW);
  const sill = kRect.mul(mix(storeyH.mul(0.24), float(0.9), g))
    .add(kArched.mul(mix(storeyH.mul(0.2), float(0.8), g)))
    .add(kArcade.mul(mix(storeyH.mul(0.1), float(0.0), g)));
  const head = kRect.mul(mix(storeyH.mul(0.84), storeyH.sub(0.8), g))
    .add(kArched.mul(mix(storeyH.mul(0.86), storeyH.sub(0.7), g)))
    .add(kArcade.mul(mix(storeyH.mul(0.9), storeyH.sub(0.55), g)));
  const isRound = kArched.add(kArcade);
  const spring = head.sub(halfW.mul(isRound));
  const dyA = max(py.sub(spring), 0.0);
  const dRound = halfW.sub(length(vec2(dx, dyA)));
  const dTop = select(isRound.greaterThan(0.5), dRound, head.sub(py));
  const d = min(min(halfW.sub(dx), py.sub(sill)), dTop);
  const hasWin = kRect.add(kArched).add(kArcade);
  const winOn = hasWin.mul(fits).mul(float(1).sub(narrow)).mul(above);
  const edgeAA = (dist) => smoothstep(pix.mul(-0.6), pix.mul(0.6), dist);
  const punched = edgeAA(d).mul(winOn);

  // Ribbon windows (the tower): one continuous band per floor, stopping 0.45 m short of the wall's ends
  const rSill = floorH.mul(0.42), rHead = floorH.mul(0.94);
  const dRib = min(min(py.sub(rSill), rHead.sub(py)), min(s.sub(0.45), wallLen.sub(0.45).sub(s)));
  const ribbon = edgeAA(dRib).mul(kRibbon).mul(fits).mul(above);
  // Curtain wall: glass throughout
  const glazed = kGlazed.mul(above);
  const opening = max(max(punched, ribbon), glazed);

  // Glazing bars: a mullion and a transom (at the springing, or ~3/4 up a square head); the arcade's fanlights get two
  // mullions; ribbons a mullion per bay and a transom; curtain walls a frame per bay and storey
  const barFade = float(1).sub(smoothstep(0.03, 0.09, pix));
  const mullion = lineAA(dx, 0.045).mul(kRect.add(kArched))
    .add(lineAA(abs(dx.sub(halfW.mul(0.34))), 0.05).mul(kArcade));
  const transomY = select(isRound.greaterThan(0.5), spring, mix(sill, head, 0.72));
  const transom = lineAA(abs(py.sub(transomY)), 0.045).mul(hasWin);
  // ribbons: a frame on every bay edge and a lighter one mid-bay (the sliding sashes), a transom near the top
  const ribBars = max(max(lineAA(bayEdge, 0.045), lineAA(abs(px0), 0.025)), lineAA(abs(py.sub(mix(rSill, rHead, 0.72))), 0.03))
    .mul(kRibbon);
  const glzBars = max(lineAA(bayEdge, 0.05), max(lineAA(py, 0.07), lineAA(storeyH.sub(py), 0.07))).mul(kGlazed);
  const bars = clamp(mullion.add(transom).add(ribBars).add(glzBars), 0.0, 1.0).mul(barFade).mul(opening);
  const paneMask = opening.mul(float(1).sub(bars));
  const frameMask = opening.mul(bars);

  // Surrounds: a moulded 0.3 m frame round punched openings, and on panel finishes a wider render panel beyond it
  const pw = pickF('pw');
  const around = float(1).sub(punched).mul(winOn);
  const frameBand = smoothstep(-0.3, -0.25, d).mul(around);
  const panelBand = smoothstep(pw.negate(), pw.negate().add(0.04), d).mul(around).mul(step(0.01, pw));

  // Balustrade (after civicFacadeMaterial): plinth, rail and turned balusters with dark gaps between them
  const inBody = step(0.14, h).mul(step(h, floorH.sub(0.17)));
  const bm = clamp(h.sub(0.14).div(max(floorH.sub(0.31), 0.05)), 0.0, 1.0);
  const balR = float(0.04).add(sin(min(bm.mul(1.6), 1.0).mul(Math.PI)).mul(0.045));
  const gap = smoothstep(balR, balR.add(pix), abs(px0)).mul(inBody).mul(kBal).mul(float(1).sub(narrow));

  // Masonry: tone, grain, ashlar coursing, rustication (the rustic kind and ashlar ground storeys with openings)
  const wallC = pickV('wall'), frameC = pickV('frame'), panelC = pickV('panel');
  const ashlar = pickF('ashlar'), ribs = pickF('ribs'), flood = pickF('flood');
  const grain = mx_noise_float(positionWorld.mul(0.6)).mul(0.05).add(1.0);
  const course = 0.5, block = 1.1;
  const row = floor(h.div(course));
  const odd = fract(row.mul(0.5)).mul(2.0); // row parity that stays right below the base (WGSL % keeps the sign)
  const bed = abs(fract(h.div(course).add(0.5)).sub(0.5)).mul(course);
  const headJ = abs(fract(s.div(block).add(odd.mul(0.5)).add(0.5)).sub(0.5)).mul(block);
  const notCap = float(1).sub(kCap);
  const joint = max(lineAA(bed, 0.012), lineAA(headJ, 0.012)).mul(fadeBelow(0.04)).mul(ashlar).mul(notCap)
    .mul(float(1).sub(kBal)).mul(float(1).sub(kPanel));
  const groove = lineAA(abs(fract(h.div(0.55).add(0.5)).sub(0.5)).mul(0.55), 0.04).mul(fadeBelow(0.1));
  const rustZone = max(kRustic, g.mul(hasWin).mul(ashlar)).mul(notCap);
  // board-marked concrete: vertical ribs every 0.11 m and dark rain streaks down the spandrels
  const rib = smoothstep(0.12, 0.5, abs(fract(s.div(0.11)).sub(0.5))).mul(fadeBelow(0.05));
  const streak = mx_noise_float(vec3(s.mul(0.45), h.mul(0.05), seed)).mul(0.5).add(0.5);
  const concrete = float(1).sub(rib.mul(0.12)).mul(mix(float(0.78), float(1.12), streak));
  let wall = wallC.mul(grain).mul(float(1).sub(joint.mul(0.22))).mul(float(1).sub(groove.mul(rustZone).mul(0.4)))
    .mul(mix(float(1), concrete, ribs.mul(notCap)));
  wall = mix(wall, panelC.mul(grain), panelBand);
  wall = mix(wall, frameC.mul(grain), frameBand);
  // the arcade's fluted pilasters on the bay edges, with a lighter capital under the entablature
  const pil = step(bayEdge, 0.45).mul(kArcade).mul(above).mul(step(py, storeyH));
  const flute = lineAA(abs(fract(bayEdge.div(0.15)).sub(0.5)).mul(0.15), 0.02).mul(fadeBelow(0.06))
    .mul(step(0.5, py)).mul(step(py, storeyH.sub(0.75)));
  const capital = step(storeyH.sub(0.75), py).mul(step(py, storeyH.sub(0.3)));
  wall = wall.mul(float(1).add(pil.mul(0.06))).mul(float(1).sub(pil.mul(flute).mul(0.25)))
    .mul(float(1).add(pil.mul(capital).mul(0.12)));
  // inset panels (the kiosko's marble): a panel per bay with a stone margin (or just a joint) and a dark line round it
  const pm = pickF('pm');
  const pd = min(bayEdge.sub(pm), min(h.sub(0.06), wallTop.sub(0.06).sub(h)));
  const inPanel = edgeAA(pd).mul(kPanel);
  const vein = mx_noise_float(positionWorld.mul(vec3(1.4, 3.5, 1.4))).mul(0.5).add(0.5);
  const marble = panelC.mul(mix(float(0.78), float(1.15), smoothstep(0.35, 0.75, vein)));
  wall = mix(wall, marble, inPanel).mul(float(1).sub(lineAA(abs(pd), 0.015).mul(kPanel).mul(0.35)));
  // mesh cladding: slender vertical slats over a dark backing, seams every 1.2 m
  const slat = smoothstep(0.2, 0.5, abs(fract(s.div(0.18)).sub(0.5))).mul(fadeBelow(0.08));
  const seam = lineAA(abs(fract(h.div(1.2).add(0.5)).sub(0.5)).mul(1.2), 0.02);
  const meshCol = wallC.mul(mix(float(1.15), float(0.55), slat)).mul(float(1).sub(seam.mul(0.3)));
  wall = mix(wall, meshCol, kMesh.mul(notCap));
  const wallWithGaps = mix(wall, wallC.mul(0.14), gap);

  // Glass: dark panes with a sky-tinted Fresnel sheen
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const darkGlass = mix(vec3(0.045, 0.06, 0.075), cityUniforms.uSkyHorizonColor.mul(0.55), fres.mul(0.75).add(0.05));
  // behind the tower's ribbons, curtains and blinds drawn to random heights in about half the panes
  const pane = vec2(floor(s.div(bayW.mul(0.5))).add(seed.mul(3.1)), storey.add(wallLen.mul(0.37)));
  const hp = fract(sin(dot(pane, vec2(39.3468, 11.135))).mul(24634.6345));
  const drawn = step(0.72, hp).mul(step(rHead.sub(py), mix(rHead.sub(rSill), float(0.25), fract(hp.mul(7.7))))).mul(kRibbon);
  const curtain = mix(vec3(0.36, 0.33, 0.28), vec3(0.22, 0.2, 0.18), fract(hp.mul(3.3)));
  const glassCol = mix(darkGlass, curtain.mul(0.8), drawn);
  // joinery: white in the old buildings, cream on the tower, dark iron in the arcade and the curtain walls
  const joinery = select(kRibbon.greaterThan(0.5), vec3(0.8, 0.76, 0.6),
    select(max(kArcade, kGlazed).greaterThan(0.5), vec3(0.12, 0.13, 0.14), vec3(0.86, 0.85, 0.82)));

  mat.colorNode = mix(mix(wallWithGaps, joinery, frameMask), glassCol, paneMask);
  mat.roughnessNode = mix(mix(float(0.86), float(0.5), kMesh), float(0.12), paneMask);
  mat.metalnessNode = max(paneMask.mul(0.3), kMesh.mul(0.55));

  // Night: a random share of rooms lit behind the glass (whole flats on the tower, every shop pane in a curtain wall),
  // the heritage stone washed by warm floodlights and a glow behind the mesh
  const cellS = select(kRibbon.greaterThan(0.5), floor(s.div(3.9)), bayIdx);
  const key = vec2(cellS.add(seed.mul(7.13)), storey.add(wallLen.mul(0.731)).add(wallTop.mul(0.317)));
  const hw = fract(sin(dot(key, vec2(12.9898, 78.233))).mul(43758.5453));
  const night = smoothstep(0.55, 1.3, cityUniforms.uInteriorGlow);
  // shares of lit rooms as js/donostia/facade-material.js (about half at night), fewer on the tower
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(mix(float(0.3), float(0.22), kRibbon)).add(0.05), 0.0, 0.6);
  // by day a lit room barely shows through the glass (the big arcade fanlights would read as filled in); curtain
  // walls and glazed roofs light up as a whole at night, dimmer; the tower's long ribbons and drawn curtains too
  const dim = pickF('dim');
  const lit = select(kGlazed.greaterThan(0.5), night.mul(mix(float(0.4), float(0.04), dim)),
    step(hw, litShare).mul(mix(float(0.15), float(1), night)).mul(float(1).sub(kArcade.mul(0.65)))
    .mul(mix(float(1), float(0.55), kRibbon)).mul(mix(float(1), float(0.6), drawn))).mul(paneMask);
  // lamp-lit rooms in the city's warm range (js/donostia/facade-material.js), a few cooler
  const warm = mix(vec3(1.0, 0.55, 0.2), vec3(0.95, 0.78, 0.5), fract(hw.mul(13.1)));
  const floodlit = wallC.mul(vec3(1.0, 0.8, 0.55)).mul(night).mul(0.09).mul(float(1).sub(paneMask)).mul(flood);
  const meshGlow = vec3(1.0, 0.68, 0.38).mul(night).mul(kMesh).mul(float(1).sub(slat)).mul(0.22);
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(0.75).add(floodlit).add(meshGlow);

  facadeMaterial = mat;
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// The model: CivicModel in world coordinates, each part laid out in its own frame
// ---------------------------------------------------------------------------------------------------------------------

// The model's own frame is the world's; use(frame) places what follows in a part frame {x, z, angle, ground}: plan
// positions (u, v) in metres from its centre with +u along `angle` (from +x towards +z), heights above its ground.
// Materials listed in `attributed` get the facade attributes too (the kiosko's stained glass reads them).
export class CentreModel extends CivicModel {
  constructor(attributed = []) {
    super({ x: 0, z: 0, angle: 0, ground: 0 });
    this.facade = centreFacadeMaterial();
    this.attributed = new Set(attributed);
    this.part = null;
  }

  use(frame) {
    this.part = frame;
    return this;
  }

  bucket(mat) {
    let b = this.buckets.get(mat);
    if (!b) {
      const attr = mat === this.facade || this.attributed.has(mat);
      b = { pos: [], nrm: [], fac: attr ? [] : null, sty: attr ? [] : null };
      this.buckets.set(mat, b);
    }
    return b;
  }

  // As CivicModel.face (udaletxea.js), in the current part frame, and with room for 16 finishes in the style code
  face(mat, pts, st = null, vn = null, sAlong = null) {
    const f = this.part;
    if (f) {
      const c = Math.cos(f.angle), s = Math.sin(f.angle);
      pts = pts.map(([u, y, v]) => [f.x + u * c - v * s, y + f.ground, f.z + u * s + v * c]);
      if (vn) vn = vn.map(([nu, ny, nv]) => [nu * c - nv * s, ny, nu * s + nv * c]);
    }
    const fn = newell(pts);
    if (!fn) return;
    const b = this.bucket(mat);
    let fac = null, sty = null;
    if (b.fac) {
      let st2 = st ? { ...st, base: st.base + (f ? f.ground : 0) } : style(FK.plain, FT.sand, { base: f ? f.ground : 0 });
      let maxY = -Infinity, cx = 0, cz = 0;
      for (const p of pts) {
        maxY = Math.max(maxY, p[1]);
        cx += p[0];
        cz += p[2];
      }
      // a seed per wall, so walls of the same length don't light the same rooms at night
      if (!st2.seed) st2 = { ...st2, seed: Math.abs(Math.round((cx * 3.1 + cz * 7.7 + maxY * 1.3) / pts.length)) % 997 };
      const code = (kind) => [st2.bay, st2.floor, st2.ground, kind + 16 * st2.tone + 256 * st2.seed];
      if (Math.abs(fn[1]) > 0.85) {
        fac = pts.map((p) => [0, p[1] - st2.base, 1, 1e4]);
        sty = code(FK.cap);
      } else {
        let along = sAlong;
        if (!along) {
          const tl = Math.hypot(fn[0], fn[2]);
          const tu = -fn[2] / tl, tv = fn[0] / tl;
          const ss = pts.map((p) => p[0] * tu + p[2] * tv);
          const s0 = Math.min(...ss);
          along = { s: ss.map((x) => x - s0), len: Math.max(...ss) - s0 };
        }
        fac = pts.map((p, k) => [along.s[k], p[1] - st2.base, along.len, maxY - st2.base]);
        sty = code(st2.kind);
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
          b.sty.push(...sty);
        }
      }
    }
  }

  // Walls of a courtyard (ring in the part frame) facing into it
  innerWalls(mat, ring, y0, y1, st) {
    const r = ccwRing(ring), n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = [r[2 * i], r[2 * i + 1]], b = [r[2 * j], r[2 * j + 1]];
      this.face(mat, [[b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], [a[0], y0, a[1]]], st);
    }
  }

  // Horizontal cap of a ring with holes (courtyards), facing up or down
  capHoles(mat, ring, holes, y, up = true, st = null) {
    const outer = ccwRing(ring);
    const toV = (r) => {
      const pts = [];
      for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
      return pts;
    };
    // Earcut (inside ShapeUtils) orients the contour and the holes itself
    const contour = toV(outer);
    const hs = holes.map(toV);
    const all = contour.concat(...hs);
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, hs)) {
      let A = [all[a].x, y, all[a].y], B = [all[b].x, y, all[b].y], C = [all[c].x, y, all[c].y];
      const ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
      if ((ny > 0) !== up) [B, C] = [C, B];
      this.face(mat, [A, B, C], st);
    }
  }

  // Cornice whose top is a band along the wall line rather than a lid (for blocks round courtyards)
  corniceBand(mat, ring, y, depth = 0.55, height = 0.6, st = null) {
    const fascia = offsetRing(ring, -depth * 0.4), corona = offsetRing(ring, -depth);
    if (fascia) this.prism(mat, fascia, y, y + height * 0.45, st, { top: false, bottom: true });
    if (corona) {
      this.prism(mat, corona, y + height * 0.45, y + height, st, { top: false, bottom: true });
      this.capHoles(mat, corona, [ring], y + height, true, st);
    }
  }

  // Sloping slab between two plan points (a stair string or a sloped parapet): t thick, from ya at a to yb at b, h high
  slope(mat, a, b, ya, yb, h, t) {
    const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    const nu = (-dv / l) * (t / 2), nv = (du / l) * (t / 2);
    const P = (q, y, sgn) => [q[0] + sgn * nu, y, q[1] + sgn * nv];
    this.hexa(mat, [P(a, ya, -1), P(b, yb, -1), P(b, yb, 1), P(a, ya, 1), P(a, ya + h, -1), P(b, yb + h, -1), P(b, yb + h, 1), P(a, ya + h, 1)]);
  }

  // CivicModel.hexa / beam, with a facade style on the faces (lettering, clock hands)
  hexa(mat, c, st = null) {
    const centre = [0, 0, 0];
    for (const p of c) for (let k = 0; k < 3; k++) centre[k] += p[k] / 8;
    for (const q of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      const pts = q.map((k) => c[k]);
      const fc = [0, 0, 0];
      for (const p of pts) for (let k = 0; k < 3; k++) fc[k] += p[k] / 4;
      this.faceDir(mat, pts, [fc[0] - centre[0], fc[1] - centre[1], fc[2] - centre[2]], st);
    }
  }

  beam(mat, p0, p1, w, t, st = null) {
    const a = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const la = Math.hypot(...a) || 1;
    a[0] /= la; a[1] /= la; a[2] /= la;
    let side = [a[2], 0, -a[0]]; // a × up
    let ls = Math.hypot(side[0], side[2]);
    if (ls < 1e-6) { side = [1, 0, 0]; ls = 1; }
    side = [side[0] / ls, 0, side[2] / ls];
    const up = [side[1] * a[2] - side[2] * a[1], side[2] * a[0] - side[0] * a[2], side[0] * a[1] - side[1] * a[0]];
    const corner = (p, sa, sb) => [0, 1, 2].map((k) => p[k] + (side[k] * sa * w) / 2 + (up[k] * sb * t) / 2);
    this.hexa(mat, [corner(p0, -1, -1), corner(p0, 1, -1), corner(p0, 1, 1), corner(p0, -1, 1),
      corner(p1, -1, -1), corner(p1, 1, -1), corner(p1, 1, 1), corner(p1, -1, 1)], st);
  }

  // Gabled roof over a rectangle whose faces carry a facade style (glazed roofs: iron bars from the attributes);
  // ridge along 'u' or 'v'
  gable(mat, u0, u1, v0, v1, y0, rise, st, axis = 'v') {
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    const top = axis === 'u' ? [u0, vc, u1, vc, u1, vc, u0, vc] : [uc, v0, uc, v0, uc, v1, uc, v1];
    this.loft(mat, [rect(u0, u1, v0, v1), top], [y0, y0 + rise], { top: false, st: { ...st, base: y0 } });
  }

  // Vertical half-disc (a palmette, a fanlight's stone) standing on (u, y, v) in the plane of `axis` ('u': the disc
  // spans u, t thick along v), radius r, n segments
  fan(mat, u, y, v, r, t, axis = 'u', n = 10) {
    const P = (a, b, off) => (axis === 'u' ? [u + a, y + b, v + off] : [u + off, y + b, v + a]);
    const arcPts = [];
    for (let k = 0; k <= n; k++) {
      const a = Math.PI - (Math.PI * k) / n;
      arcPts.push([r * Math.cos(a), r * Math.sin(a)]);
    }
    const fwd = axis === 'u' ? [0, 0, -1] : [-1, 0, 0];
    this.faceDir(mat, arcPts.map(([a, b]) => P(a, b, -t / 2)), fwd);
    this.faceDir(mat, arcPts.map(([a, b]) => P(a, b, t / 2)), fwd.map((x) => -x));
    for (let k = 0; k < n; k++) {
      const [a0, b0] = arcPts[k], [a1, b1] = arcPts[k + 1];
      const mid = [(a0 + a1) / 2, (b0 + b1) / 2];
      const out = axis === 'u' ? [mid[0], mid[1], 0] : [0, mid[1], mid[0]];
      this.faceDir(mat, [P(a0, b0, -t / 2), P(a1, b1, -t / 2), P(a1, b1, t / 2), P(a0, b0, t / 2)], out);
    }
  }

  // Block letters made of square strokes (GLYPHS), cap height `size`, centred on (u, y) at depth v and readable from
  // the -v side (side = -1: they run towards -u) or the +v side (side = 1); st: their finish (carved by default)
  text(mat, str, u, y, v, size, side = -1, stroke = 0.12, st = style(FK.plain, FT.carved)) {
    const adv = size * 0.86, w = size * 0.66;
    let x = -(adv * (str.length - 1)) / 2 - w / 2;
    for (const ch of str) {
      for (const [[a0, b0], [a1, b1]] of GLYPHS[ch] || []) {
        const p0 = [u + side * (x + a0 * w), y + b0 * size, v], p1 = [u + side * (x + a1 * w), y + b1 * size, v];
        this.beam(mat, p0, p1, stroke, stroke, st);
      }
      x += adv;
    }
  }

  // Straight flight of n steps along a -> b (plan), w wide, rising from y0 at a to y1 at b; solid down to `bottom`
  stairs(mat, a, b, w, y0, y1, n, bottom, st = null) {
    const du = b[0] - a[0], dv = b[1] - a[1], l = Math.hypot(du, dv) || 1;
    const ou = (-dv / l) * (w / 2), ov = (du / l) * (w / 2);
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const p0 = [a[0] + du * t0, a[1] + dv * t0], p1 = [a[0] + du * t1, a[1] + dv * t1];
      const y = y0 + ((y1 - y0) * (k + 1)) / n;
      this.prism(mat, [p0[0] - ou, p0[1] - ov, p1[0] - ou, p1[1] - ov, p1[0] + ou, p1[1] + ov, p0[0] + ou, p0[1] + ov], bottom, y, st);
    }
  }
}

// Stroke glyphs in a unit box (x right, y up) for CentreModel.text: the market's signage and inscriptions
const GLYPHS = {
  A: [[[0, 0], [0.5, 1]], [[0.5, 1], [1, 0]], [[0.25, 0.42], [0.75, 0.42]]],
  C: [[[1, 1], [0.2, 1]], [[0.2, 1], [0, 0.8]], [[0, 0.8], [0, 0.2]], [[0, 0.2], [0.2, 0]], [[0.2, 0], [1, 0]]],
  D: [[[0, 0], [0, 1]], [[0, 1], [0.7, 1]], [[0.7, 1], [1, 0.7]], [[1, 0.7], [1, 0.3]], [[1, 0.3], [0.7, 0]], [[0.7, 0], [0, 0]]],
  E: [[[0, 0], [0, 1]], [[0, 1], [1, 1]], [[0, 0.5], [0.8, 0.5]], [[0, 0], [1, 0]]],
  I: [[[0.5, 0], [0.5, 1]]],
  K: [[[0, 0], [0, 1]], [[0, 0.4], [1, 1]], [[0.33, 0.6], [1, 0]]],
  M: [[[0, 0], [0, 1]], [[0, 1], [0.5, 0.45]], [[0.5, 0.45], [1, 1]], [[1, 1], [1, 0]]],
  O: [[[0.2, 0], [0.8, 0]], [[0.8, 0], [1, 0.2]], [[1, 0.2], [1, 0.8]], [[1, 0.8], [0.8, 1]], [[0.8, 1], [0.2, 1]], [[0.2, 1], [0, 0.8]], [[0, 0.8], [0, 0.2]], [[0, 0.2], [0.2, 0]]],
  P: [[[0, 0], [0, 1]], [[0, 1], [0.8, 1]], [[0.8, 1], [1, 0.8]], [[1, 0.8], [1, 0.65]], [[1, 0.65], [0.8, 0.45]], [[0.8, 0.45], [0, 0.45]]],
  R: [[[0, 0], [0, 1]], [[0, 1], [0.8, 1]], [[0.8, 1], [1, 0.8]], [[1, 0.8], [1, 0.65]], [[1, 0.65], [0.8, 0.45]], [[0.8, 0.45], [0, 0.45]], [[0.45, 0.45], [1, 0]]],
  S: [[[1, 1], [0.2, 1]], [[0.2, 1], [0, 0.8]], [[0, 0.8], [0, 0.65]], [[0, 0.65], [0.2, 0.5]], [[0.2, 0.5], [0.8, 0.5]], [[0.8, 0.5], [1, 0.35]], [[1, 0.35], [1, 0.2]], [[1, 0.2], [0.8, 0]], [[0.8, 0], [0, 0]]],
  T: [[[0.5, 0], [0.5, 1]], [[0, 1], [1, 1]]],
  U: [[[0, 1], [0, 0.2]], [[0, 0.2], [0.2, 0]], [[0.2, 0], [0.8, 0]], [[0.8, 0], [1, 0.2]], [[1, 0.2], [1, 1]]],
  0: [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]]],
  1: [[[0.5, 0], [0.5, 1]], [[0.5, 1], [0.25, 0.8]]],
  7: [[[0, 1], [1, 1]], [[1, 1], [0.35, 0]]],
  8: [[[0, 0], [1, 0]], [[1, 0], [1, 1]], [[1, 1], [0, 1]], [[0, 1], [0, 0]], [[0, 0.5], [1, 0.5]]],
  9: [[[1, 0.5], [0, 0.5]], [[0, 0.5], [0, 1]], [[0, 1], [1, 1]], [[1, 1], [1, 0]], [[1, 0], [0, 0]]]
};

// Frame of a footprint whose main front faces `front` (a world [x, z] direction): the footprint's oriented box, turned
// so that +u runs along that front and -v points out of it. half = [half length along u, half depth along v].
export function frontFrame(ctx, ring, front, { groundAt = null } = {}) {
  const ob = ctx.kit.orientedBox(ring);
  // -v is (sin a, -cos a): the angle whose -v is closest to `front`, snapped to the box's axes
  const want = Math.atan2(front[0], -front[1]);
  let angle = ob.angle, best = -Infinity;
  for (let k = 0; k < 4; k++) {
    const a = ob.angle + (k * Math.PI) / 2;
    const dotp = Math.sin(a) * Math.sin(want) + Math.cos(a) * Math.cos(want);
    if (dotp > best) { best = dotp; angle = a; }
  }
  const alongLong = Math.abs(Math.cos(angle - ob.angle)) > 0.5;
  const half = alongLong ? [ob.length / 2, ob.width / 2] : [ob.width / 2, ob.length / 2];
  const frame = { x: ob.x, z: ob.z, angle, half };
  const c = Math.cos(angle), s = Math.sin(angle);
  frame.toWorld = (u, v) => [frame.x + u * c - v * s, frame.z + u * s + v * c];
  frame.toLocal = (x, z) => [(x - frame.x) * c + (z - frame.z) * s, -(x - frame.x) * s + (z - frame.z) * c];
  // storeys start at the ground before the front (or a given point); plinths reach the lowest ground under the ring
  const [gx, gz] = groundAt || frame.toWorld(0, -half[1] - 3);
  frame.ground = Math.max(0, ctx.terrain.heightAt(gx, gz));
  frame.plinth = Math.min(ctx.kit.lowestGround(ctx, ring), frame.ground) - 0.3 - frame.ground;
  return frame;
}

// Ring (flat world [x, z, ...]) into a frame's (u, v), dropping a repeated closing point
export function ringToFrame(frame, ring) {
  const out = [];
  const n = ring.length / 2;
  const last = n > 1 && Math.hypot(ring[0] - ring[2 * n - 2], ring[1] - ring[2 * n - 1]) < 1e-6 ? n - 1 : n;
  for (let k = 0; k < last; k++) out.push(...frame.toLocal(ring[2 * k], ring[2 * k + 1]));
  return out;
}

export { rect };

// ---------------------------------------------------------------------------------------------------------------------
// La Bretxa
// ---------------------------------------------------------------------------------------------------------------------

// Glazed iron roofs: glass between iron bars every 0.8 m along the ridge and 0.9 m up the slope
const roofGlass = (base) => style(FK.glazed, FT.roofGlass, { bay: 0.8, floor: 0.9, base });

// The Pescadería: the front with the stairs faces the plaza (south-south-east)
function pescaderia(m, ctx, site, zinc) {
  const fr = frontFrame(ctx, site.footprint, [0.47, 0.88]);
  m.use(fr);
  const F = m.facade, P = fr.plinth;
  const [W2, L2] = fr.half; // ~17.7 m along the front, ~29.9 m deep
  // Rusticated ground storey (5 m) with square-headed openings; main floor (7 m) of tall windows in white panels; the
  // entablature at 12 m, cornice and an attic parapet to 13.7 m
  const ground = style(FK.rect, FT.sand, { bay: 6.4, ground: 5.0, floor: 7.0 });
  const main = style(FK.rect, FT.sandPanel, { bay: 6.4, floor: 7.0, base: 5.0 });
  const plain = style(FK.plain, FT.sand);
  const body = rect(-W2, W2, -L2, L2);
  m.prism(F, body, P, 5.0, ground, { top: false });
  m.prism(F, body, 5.0, 12.0, main, { top: false });
  m.prism(F, body, 12.0, 12.75, plain, { top: false });
  m.cap(zinc, body, 12.75);
  m.cornice(F, body, 12.0, 0.55, 0.75);
  m.prism(F, offsetOut(body, 0.1), 4.75, 5.15, plain, { bottom: true, top: false });
  for (const [a, b] of [[[-W2, -L2], [W2, -L2]], [[W2, -L2], [W2, L2]], [[W2, L2], [-W2, L2]], [[-W2, L2], [-W2, -L2]]]) {
    const inset = (q) => [q[0] - Math.sign(q[0]) * 0.3, q[1] - Math.sign(q[1]) * 0.3];
    m.wall(F, inset(a), inset(b), 0.45, 12.75, 13.7, plain);
  }
  // The rooftop storey: dark glass in grey frames set back behind the parapet, under a flat roof with a plant box
  const lantern = rect(-W2 + 1.6, W2 - 1.6, -L2 + 2.2, L2 - 1.6);
  m.prism(F, lantern, 12.75, 15.6, style(FK.glazed, FT.roofGlass, { bay: 1.4, floor: 2.85, base: 12.75 }), { top: false });
  m.cap(zinc, lantern, 15.6);
  m.box(F, -4, 4, 15.6, 17.2, 2, 12, style(FK.plain, FT.grey));

  // The central pavilion, 9 m wide and 2.4 m proud of the front (the flights stop against its flanks): the market
  // entrance, a tall stained-glass window under a medallion, PESCADERIA carved above, a cornice at 15.8 m and the
  // crowned arms on top
  const pv0 = -L2 - 2.4;
  const pav = rect(-4.6, 4.6, pv0, -L2 + 0.5);
  m.prism(F, pav, P, 5.0, style(FK.rect, FT.sand, { bay: 9.2, ground: 5.0, floor: 7 }), { top: false });
  m.prism(F, pav, 5.0, 15.8, style(FK.rect, FT.sand, { bay: 9.2, floor: 6.4, base: 5.0 }), { top: true });
  m.cornice(F, pav, 15.8, 0.5, 0.65);
  m.prism(F, offsetOut(pav, 0.12), 11.6, 12.0, plain, { bottom: true, top: false });
  m.text(F, 'PESCADERIA', 0, 13.5, pv0 - 0.06, 0.55);
  m.fan(F, 0, 12.25, pv0 - 0.05, 0.55, 0.12, 'u', 12); // the medallion over the window
  m.box(F, -3.6, 3.6, 16.45, 17.2, pv0 + 0.4, pv0 + 2.2, plain);
  // the arms: a cartouche between scrolls under a mural crown
  m.box(F, -1.3, 1.3, 17.2, 19.0, pv0 + 0.75, pv0 + 1.45, plain);
  m.fan(F, -1.25, 17.2, pv0 + 1.1, 0.75, 0.5, 'u', 8);
  m.fan(F, 1.25, 17.2, pv0 + 1.1, 0.75, 0.5, 'u', 8);
  m.dome(F, 0, pv0 + 1.1, 19.0, [[0.7, 0], [0.95, 0.35], [0.95, 0.75], [0.6, 0.85], [0.25, 1.15], [0.05, 1.3]], 8);
  for (const u of [-4.2, 4.2]) m.box(F, u - 0.45, u + 0.45, 16.45, 17.4, pv0 + 0.1, pv0 + 1.0, plain);

  // Stairs: a flight against the front from each corner up to a landing at the pavilion's flank, where a door opens
  // into it; a balustrade on the open side of the flight and round the landing, the solid string below it
  const landingY = 4.6, fv0 = -L2 - 1.8;
  for (const sgn of [-1, 1]) {
    const top = sgn * 6.4;
    m.stairs(F, [sgn * (W2 - 0.3), (fv0 - L2) / 2], [top, (fv0 - L2) / 2], 1.8, 0.0, landingY, 24, P, plain);
    // the balustrade down the flight, stepped with the treads: a sloping coping over short runs of balusters
    const x0 = sgn * (W2 - 0.3), n = 8;
    for (let k = 0; k < n; k++) {
      const a0 = x0 + ((top - x0) * k) / n, a1 = x0 + ((top - x0) * (k + 1)) / n;
      const y = (landingY * (k + 0.5)) / n;
      m.wall(F, [a0, fv0 + 0.15], [a1, fv0 + 0.15], 0.24, P, y, plain);
      m.wall(F, [a0, fv0 + 0.15], [a1, fv0 + 0.15], 0.22, y, y + 0.75, style(FK.balustrade, FT.sand, { bay: 0.3, floor: 0.75, base: y }));
    }
    m.slope(F, [x0, fv0 + 0.15], [top, fv0 + 0.15], 0.75, landingY + 0.75, 0.16, 0.36);
    m.box(F, Math.min(sgn * 4.6, top), Math.max(sgn * 4.6, top), P, landingY, fv0, -L2, plain, { bottom: true });
    m.balustrade(F, FT.sand, [top, fv0 + 0.15], [sgn * 4.6, fv0 + 0.15], landingY, 1.0);
    m.box(F, top - 0.3, top + 0.3, landingY, landingY + 1.25, fv0, fv0 + 0.6, plain); // newel
    const du = sgn * 4.6;
    m.box(F, Math.min(du, du + sgn * 0.06), Math.max(du, du + sgn * 0.06), landingY, landingY + 2.7, fv0 + 0.35, -L2 - 0.3,
      style(FK.plain, FT.bronze)); // the door into the pavilion
  }
}

// The 1870/1899 hall on the Boulevard: the arcade faces south-south-east, glazed gables run back from it
function arkoak(m, ctx, site, iron) {
  const fr = frontFrame(ctx, site.footprint, [0.4, 0.92]);
  m.use(fr);
  const F = m.facade, P = fr.plinth;
  const [W2, D2] = fr.half; // ~25.5 m along the Boulevard, ~22.5 m deep
  // One tall arcade storey (8.6 m: round arches 4 m wide springing at 6 m between fluted pilasters), then the
  // entablature with the inscription frieze to 10.4 m, the cornice and a parapet with dies
  const arcade = style(FK.arcade, FT.sand, { bay: 5.6, ground: 8.6, floor: 8 });
  const plain = style(FK.plain, FT.sand);
  const body = rect(-W2, W2, -D2, D2);
  m.prism(F, body, P, 10.4, arcade, { top: true });
  m.prism(F, offsetOut(body, 0.12), 8.6, 8.95, plain, { bottom: true, top: false });
  m.prism(F, offsetOut(body, 0.06), 9.0, 10.0, plain, { top: false }); // the frieze
  m.cornice(F, body, 10.4, 0.6, 0.6);
  for (const [a, b] of [[[-W2, -D2], [W2, -D2]], [[W2, -D2], [W2, D2]], [[W2, D2], [-W2, D2]], [[-W2, D2], [-W2, -D2]]]) {
    const inset = (q) => [q[0] - Math.sign(q[0]) * 0.25, q[1] - Math.sign(q[1]) * 0.25];
    m.wall(F, inset(a), inset(b), 0.4, 11.0, 11.7, plain);
  }
  // the inscription on the Boulevard frieze
  m.text(F, '1870', W2 * 0.62, 9.15, -D2 - 0.12, 0.6);
  m.text(F, 'MERCADO', 0, 9.15, -D2 - 0.12, 0.6);
  m.text(F, '1899', -W2 * 0.62, 9.15, -D2 - 0.12, 0.6);
  // Three glazed iron gables side by side, ridges running back from the Boulevard (b5m: 17 m at the ridges), each
  // fronted by a palmette between scrolls on the parapet
  const n = 3, gw = (2 * W2 - 1.0) / n;
  for (let k = 0; k < n; k++) {
    const u0 = -W2 + 0.5 + k * gw, u1 = u0 + gw, uc = (u0 + u1) / 2;
    m.gable(F, u0, u1, -D2 + 0.6, D2 - 0.6, 11.0, 5.6, roofGlass(11.0), 'v');
    for (const v of [-D2 + 0.5, D2 - 0.5]) {
      m.beam(iron, [u0, 11.0, v], [uc, 16.6, v], 0.22, 0.25);
      m.beam(iron, [u1, 11.0, v], [uc, 16.6, v], 0.22, 0.25);
    }
    m.beam(iron, [uc, 16.6, -D2 + 0.5], [uc, 16.6, D2 - 0.5], 0.22, 0.22);
    for (const [v, sgn] of [[-D2, -1], [D2, 1]]) {
      const vv = v - sgn * 0.05;
      m.box(F, uc - 1.7, uc + 1.7, 11.0, 11.55, Math.min(vv, vv + sgn * 0.45), Math.max(vv, vv + sgn * 0.45), plain);
      m.fan(F, uc, 11.55, vv + sgn * 0.2, 1.05, 0.3, 'u', 12);
      for (const side of [-1, 1]) m.fan(F, uc + side * 1.35, 11.55, vv + sgn * 0.2, 0.42, 0.34, 'u', 8);
    }
  }
}

function offsetOut(r, d) {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] - d, r[4] + d, r[5] + d, r[6] - d, r[7] + d];
}

// The glass pavilion over the underground market: a storey of glass between thin frames, a pale fascia, and the
// lettering on the roof edge of both long sides (MERKATUA towards the plaza, MERCADO towards the Pescadería)
function pavilion(m, ctx, site) {
  const fr = frontFrame(ctx, site.footprint, [0.38, 0.92]);
  const ring = ringToFrame(fr, site.footprint);
  m.use(fr);
  const P = fr.plinth;
  const grey = style(FK.plain, FT.grey);
  m.prism(m.facade, ring, P, 3.3, style(FK.glazed, FT.grey, { bay: 1.6, floor: 3.3 }), { top: false });
  m.prism(m.facade, ring, 3.3, 4.1, grey, { top: true });
  const [, D2] = fr.half;
  m.text(m.facade, 'MERKATUA', 0, 4.15, -D2 + 0.8, 1.15, -1, 0.16, grey);
  m.text(m.facade, 'MERCADO', 0, 4.15, D2 - 0.8, 1.15, 1, 0.16, grey);
}

export function build(sites, ctx) {
  const byId = Object.fromEntries(sites.map((s) => [s.id, s]));
  if (!byId.bretxa?.footprint && !byId['bretxa-merkatua']?.footprint) return null;
  const { materials } = ctx.kit;
  const m = new CentreModel();
  if (byId.bretxa?.footprint) pescaderia(m, ctx, byId.bretxa, materials.zinc);
  if (byId['bretxa-merkatua']?.footprint) arkoak(m, ctx, byId['bretxa-merkatua'], materials.iron);
  if (byId['bretxa-plaza']?.footprint) pavilion(m, ctx, byId['bretxa-plaza']);
  return m.finish('Bretxa');
}
