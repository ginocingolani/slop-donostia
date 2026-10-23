import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, ivec2, color, floor, fract, abs, min, max, clamp, mix, step, smoothstep, dot, sin,
  cos, pow, length, normalize, fwidth, textureLoad, positionWorld, positionView, normalView, normalWorldGeometry,
  cameraPosition, PI
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { decodePNG } from './png.js';

// js/donostia/ground.js
// Ground surfaces over the LiDAR terrain, one material for every terrain chunk. In the core the baked maps of
// tools/donostia/bake-ground.mjs give each metre its surface (asphalt, Donostia's grey pavement tiles, the Parte
// Vieja's setts, bidegorris, lawns, sand…) plus the distance to that surface's edge and to the nearest kerb, so edges
// are rebuilt to a few centimetres from four texels instead of the stair steps of a class map; zebra crossings come
// from OpenStreetMap as exact rectangles. Patterns line up with the nearest street edge and settle to their mean
// colour once smaller than a pixel. Outside the core (and wherever the maps are missing) the ground is natural:
// meadow parcels, scrub and woods on the slopes, rock on the cliffs and wet rock and weed at the waterline.
//
// The shader branches on nothing: every surface is evaluated and the right one mixed in by a 0/1 weight. TSL's select()
// would emit if/else blocks, where WGSL forbids the derivatives behind the pattern anti-aliasing and the bump, and
// whose isolated caches would re-evaluate the shared noise in every branch.

// Surface ids of the baked map (SURFACE in tools/donostia/bake-ground.mjs; 0-11 match GEO.terrain.classes)
export const SURFACE = {
  natural: 0, road: 1, sidewalk: 2, pedestrian: 3, garden: 4, woodland: 5, beach: 6, seabed: 7, building: 8, bike: 9,
  stairs: 10, rail: 11, setts: 12, path: 13, treePit: 14, flowers: 15, hedge: 16, yard: 17, rock: 18, quay: 19
};
const S = SURFACE;

const FILES = {
  core: 'data/donostia/ground-core.png',
  orient: 'data/donostia/ground-orient.png',
  crossings: 'data/donostia/ground-crossings.png'
};
const CROSSING_TILE = 256; // m (bake-ground.mjs TILE)

// --- baked maps ------------------------------------------------------------------------------------------------------

async function fetchPNG(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return decodePNG(await res.arrayBuffer());
}

function dataTexture(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter; // read with textureLoad, exact bytes
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

async function loadMaps(core) {
  const w = Math.round(core.width), h = Math.round(core.depth);
  const [planes, orient, crossings] = await Promise.all([fetchPNG(FILES.core), fetchPNG(FILES.orient), fetchPNG(FILES.crossings)]);
  if (planes.channels !== 1 || planes.width !== w || planes.height !== 4 * h) throw new Error(`${FILES.core} does not match the terrain core`);
  // four grey planes (surface, edge distance, kerb distance, crossing slot) -> one RGBA texel per metre
  const n = w * h, src = planes.data, rgba = new Uint8Array(4 * n);
  for (let k = 0; k < n; k++) {
    rgba[4 * k] = src[k];
    rgba[4 * k + 1] = src[n + k];
    rgba[4 * k + 2] = src[2 * n + k];
    rgba[4 * k + 3] = src[3 * n + k];
  }
  return {
    ground: dataTexture(rgba, w, h, THREE.RGBAFormat), w, h, res: 1,
    orient: dataTexture(orient.data, orient.width, orient.height, THREE.RedFormat), ow: orient.width, oh: orient.height,
    orientRes: core.width / orient.width,
    crossings: dataTexture(crossings.data, crossings.width, crossings.height, THREE.RGBAFormat),
    cw: crossings.width, ch: crossings.height, tilesX: Math.ceil(w / CROSSING_TILE)
  };
}

// Without the baked maps: the terrain's own 2 m classes, hard-edged, no kerbs, crossings or street directions
function fallbackMaps(core) {
  const n = core.w * core.h, rgba = new Uint8Array(4 * n);
  for (let k = 0; k < n; k++) {
    rgba[4 * k] = core.classes[k];
    rgba[4 * k + 1] = 160;
    rgba[4 * k + 2] = 2;
  }
  return {
    ground: dataTexture(rgba, core.w, core.h, THREE.RGBAFormat), w: core.w, h: core.h, res: core.res,
    orient: dataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat), ow: 1, oh: 1, orientRes: core.width,
    crossings: dataTexture(new Uint8Array(12), 3, 1, THREE.RGBAFormat), cw: 3, ch: 1,
    tilesX: Math.ceil(core.width / CROSSING_TILE)
  };
}

// --- helpers ---------------------------------------------------------------------------------------------------------

// Dave Hoskins' hash without sine: stays well distributed for the large cell ids of a 4 km frame, where the classic
// fract(sin(dot)) hash (hash2D in js/tsl-materials.js) loses its precision
const hash12 = Fn(([p]) => {
  const p3 = fract(vec3(p.x, p.y, p.x).mul(0.1031)).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.x.add(p3.y).mul(p3.z));
});

// Smooth 2D value noise (noise2D in js/tsl-materials.js, on hash12)
const valueNoise = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash12(i), b = hash12(i.add(vec2(1, 0))), c = hash12(i.add(vec2(0, 1))), d = hash12(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// Box-filtered periodic pulse (filteredPulse in js/tsl-materials.js): the share of a footprint `w` wide around `x`
// where fract() lies in [a, b], so joints & stripes fade to their mean coverage instead of shimmering. The pulse is
// periodic, so x is reduced to its cell first: thousands of 13 cm setts from the frame origin would otherwise eat the
// float precision of the difference below.
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = fract(float(x)).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});

// Mikkelsen's surface-gradient bump (bumpNormal in js/tsl-materials.js), as a view-space normal
const bumpNormal = Fn(([height]) => {
  const hgt = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(hgt.dFdx().mul(r1).add(hgt.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// Share of a footprint `w` wide around x that lies in the band lo < x < hi (an exact box filter: a 20 cm kerb seen
// across a 1 m pixel covers a fifth of it, not a smeared half)
const band = (x, lo, hi, w) => max(min(x.add(w.mul(0.5)), hi).sub(max(x.sub(w.mul(0.5)), lo)), 0).div(w);
// 1 where a surface id equals k, else 0
const eq = (id, k) => step(abs(id.sub(k)), 0.5);
// Branch-free lookup over surface ids, table = [[id, node], ...]; `is` returns the 0/1 weight of an id (pass a memoised
// one so every lookup on the same id shares its comparisons)
const pick = (is, table, fallback) => table.reduce((out, [k, v]) => mix(out, v, is(k)), fallback);
const isAny = (is, ids) => ids.reduce((out, k) => out.add(is(k)), float(0)).min(1);
function weights(id) {
  const cache = new Map();
  return (k) => {
    if (!cache.has(k)) cache.set(k, eq(id, k));
    return cache.get(k);
  };
}

// --- palette (sRGB, converted to linear by color()) ------------------------------------------------------------------

const C = {
  asphaltDark: color(0x2f3134), asphaltLight: color(0x4b4d50), patchNew: color(0x232527), patchOld: color(0x5a5a59),
  manhole: color(0x3b3632), kerb: color(0xb4b1a8), paint: color(0xe2e1da), bike: color(0x8a3a31),
  meadowA: color(0x5f7f2f), meadowB: color(0x7a943c), hay: color(0x9a9450), scrub: color(0x6a6533), bracken: color(0x7b6233),
  forest: color(0x2b3d1f), rockA: color(0x8b857a), rockB: color(0xa29b8b), rockWet: color(0x3d3a33), weed: color(0x3c4626),
  lawnA: color(0x55822c), lawnB: color(0x6c9636), hedge: color(0x2f5022), litter: color(0x3e3221), moss: color(0x3f5426),
  flowerBed: color(0x3c5f25), soil: color(0x3a2c21), gravel: color(0xa99d84), earth: color(0x8a7a60),
  sandDry: color(0xdcc69a), sandDry2: color(0xcfb68a), sandWet: color(0x9b845e), sandSwash: color(0x7a6749),
  seabed: color(0x8a7a5c), ballast: color(0x6f675e), stairs: color(0xb4ad9f)
};

// Unit paving: [surface, unit length along the street, across, running-bond shift, joint width (m), dark, light,
// share of odd darker units, dome height of each unit (m)]
const PAVING = [
  [S.sidewalk, 0.4, 0.4, 0, 0.007, 0x9e9a91, 0xbab5aa, 0.0, 0.0], // Donostia's light grey square tiles
  [S.pedestrian, 0.8, 0.4, 0.5, 0.008, 0xb2a48b, 0xcbbea4, 0.05, 0.0], // sandstone slabs of the squares & promenades
  [S.setts, 0.24, 0.13, 0.5, 0.014, 0x84817b, 0xa8a49b, 0.12, 0.006], // granite setts of the Parte Vieja
  [S.stairs, 0.6, 0.35, 0.5, 0.01, 0xa59f92, 0xbcb5a7, 0.0, 0.0],
  [S.quay, 1.25, 0.62, 0.5, 0.016, 0x8b8981, 0xaba89f, 0.08, 0.0], // dressed stone of the quays & sea walls
  [S.yard, 2.0, 2.0, 0, 0.012, 0x9a9891, 0xb3b1aa, 0.0, 0.0], // concrete courtyards
  [S.building, 0.6, 0.6, 0, 0.008, 0x6e6b66, 0x87847e, 0.0, 0.0]
];
const PAVED = PAVING.map((row) => row[0]);

// Base albedo per surface: the far-field average and the colour across an edge
const BASE = [
  [S.road, color(0x3c3e41)], [S.sidewalk, color(0xaca89e)], [S.pedestrian, color(0xbeb097)], [S.garden, C.lawnA],
  [S.woodland, color(0x3a3a24)], [S.beach, C.sandDry], [S.seabed, C.seabed], [S.building, color(0x7a7772)],
  [S.bike, C.bike], [S.stairs, C.stairs], [S.rail, C.ballast], [S.setts, color(0x96938b)], [S.path, C.gravel],
  [S.treePit, C.soil], [S.flowers, color(0x5a6a33)], [S.hedge, C.hedge], [S.yard, color(0xa6a49d)],
  [S.rock, C.rockA], [S.quay, color(0x9b9990)]
];
const ROUGH = [
  [S.road, 0.86], [S.sidewalk, 0.8], [S.pedestrian, 0.78], [S.setts, 0.7], [S.stairs, 0.8], [S.quay, 0.85], [S.yard, 0.85],
  [S.building, 0.85], [S.bike, 0.84], [S.rail, 0.95], [S.beach, 0.96], [S.seabed, 0.9], [S.path, 0.95], [S.treePit, 1.0]
];
const HARD = [S.road, S.sidewalk, S.pedestrian, S.setts, S.stairs, S.quay, S.yard, S.building, S.bike];
const POOLING = [S.road, S.bike, S.setts, S.pedestrian, S.yard, S.quay]; // impervious enough to hold puddles

// --- material ----------------------------------------------------------------------------------------------------------

export async function createGroundMaterial(terrain) {
  const { core } = terrain;
  let maps;
  try {
    maps = await loadMaps(core);
  } catch (e) {
    console.warn('[ground] baked ground maps unavailable, using the terrain classes', e);
    maps = fallbackMaps(core);
  }
  const { w, h, res } = maps;
  const x0 = core.x0, z0 = core.z0, x1 = core.x0 + core.width, z1 = core.z0 + core.depth;

  // (no .assign() out here: outside Fn() there is no stack to hold it, so every step is a new node)
  const p = positionWorld;
  const xz = p.xz;
  const y = p.y;
  // World size of a pixel: every pattern below fades to its mean before it can alias
  const fw = max(fwidth(xz).x, fwidth(xz).y).max(0.0005).toVar();
  const fwY = fwidth(y).max(0.0005).toVar();
  const fade = (from, to) => smoothstep(from, to, fw); // 1 near (fw < to) .. 0 far (fw > from)
  const slope = float(1).sub(normalWorldGeometry.y).toVar(); // 0 flat, 0.13 at 30°, 0.29 at 45°, 0.5 at 60°

  const inCore = step(x0 + 1, xz.x).mul(step(xz.x, x1 - 1)).mul(step(z0 + 1, xz.y)).mul(step(xz.y, z1 - 1)).toVar();
  const outside = max(max(float(x0).sub(xz.x), xz.x.sub(x1)), max(float(z0).sub(xz.y), xz.y.sub(z1))); // m beyond the core

  // Shared noise (each node is generated once per fragment however many surfaces read it)
  const nF = mix(float(0.5), valueNoise(xz.mul(3.1)), fade(0.12, 0.03)).toVar(); // grain, ~0.3 m
  const nM = valueNoise(xz.mul(0.45).add(17.3)).toVar(); // ~2 m
  const nL = valueNoise(xz.mul(0.06).add(41.7)).toVar(); // ~16 m
  const nXL = valueNoise(xz.mul(0.0075).add(3.9)).toVar(); // ~130 m

  // --- the four texels around the fragment ---
  const f = xz.sub(vec2(x0, z0)).div(res).sub(0.5); // texel centres on integers
  const ci = clamp(floor(f.x), 0, w - 2).toVar(), cj = clamp(floor(f.y), 0, h - 2).toVar();
  const t = clamp(f.sub(vec2(ci, cj)), 0, 1).toVar();
  const texels = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => {
    const T = textureLoad(maps.ground, ivec2(ci.add(a), cj.add(b))).mul(255).toVar();
    return {
      id: floor(T.x.add(0.5)), d: T.y.div(100), kerb: T.z.sub(128).div(63), slot: floor(T.w.add(0.5)),
      w: (a ? t.x : float(1).sub(t.x)).mul(b ? t.y : float(1).sub(t.y))
    };
  });
  // Every surface around scores +distance where it is and -distance where it isn't, bilinear in between: a straight
  // edge comes back exactly where the bake drew it, the winner is the surface here and its margin over the runner-up
  // the distance to the edge between them
  const D = texels.reduce((s, k) => s.add(k.w.mul(k.d)), float(0));
  const scores = texels.map((m) => texels.reduce((s, k) => s.add(eq(k.id, m.id).mul(k.w).mul(k.d)), float(0)).mul(2).sub(D).toVar());
  let wid = texels[0].id, best = scores[0];
  for (let m = 1; m < 4; m++) {
    wid = mix(wid, texels[m].id, step(best, scores[m]));
    best = max(best, scores[m]);
  }
  wid = wid.mul(inCore).toVar(); // S.natural (0) outside the core
  best = best.toVar();
  let sid = wid, second = float(-9);
  for (let m = 0; m < 4; m++) {
    const ok = float(1).sub(eq(texels[m].id, wid)).mul(step(second, scores[m]));
    sid = mix(sid, texels[m].id, ok);
    second = mix(second, scores[m], ok);
  }
  sid = sid.toVar();
  const margin = mix(float(9), best.sub(second).mul(0.5), step(-8, second));
  const edgeMix = clamp(float(0.5).sub(margin.div(fw)), 0, 0.5).mul(inCore).toVar(); // share of the runner-up
  const isW = weights(wid), isS = weights(sid);

  // Signed distance to the nearest kerb (+ on the carriageway), meaningful where `kerbed` > 0
  const rK = texels.reduce((s, k) => s.add(k.w.mul(k.kerb)), float(0)).toVar();
  const kerbed = texels.reduce((s, k) => s.add(k.w.mul(step(abs(k.kerb), 1.95))), float(0)).mul(inCore).toVar();
  const roadShare = isW(S.road).mul(float(1).sub(edgeMix)).add(isS(S.road).mul(edgeMix)).toVar();

  // Street frame: direction of the nearest kerb or the prevailing one (2 m map), so tiles, setts, kerbstones & patches
  // follow the street
  const oi = clamp(floor(xz.x.sub(x0).div(maps.orientRes)), 0, maps.ow - 1);
  const oj = clamp(floor(xz.y.sub(z0).div(maps.orientRes)), 0, maps.oh - 1);
  const ang = textureLoad(maps.orient, ivec2(oi, oj)).x.mul(255 / 256).mul(PI).toVar();
  const along = vec2(cos(ang), sin(ang));
  const q = vec2(dot(xz, along), dot(xz, vec2(along.y.negate(), along.x))).toVar();

  // --- natural ground (also the whole context grid) ---
  const natural = Fn(() => {
    // meadow parcels of slightly different greens (hay, fresh grass), like the farmland on the hills
    const parcel = hash12(floor(xz.add(vec2(nL, nM).mul(40)).div(70)));
    const meadow = mix(C.meadowA, C.meadowB, nL.mul(0.7).add(nM.mul(0.3))).mul(parcel.mul(0.22).add(0.88)).toVar();
    meadow.assign(mix(meadow, C.hay, step(0.84, parcel).mul(0.55)));
    // gorse & bracken on the steeper and the exposed slopes
    const scrubAmt = smoothstep(0.1, 0.26, slope.add(nXL.sub(0.5).mul(0.3)).add(nM.sub(0.5).mul(0.06)));
    const scrub = mix(C.scrub, C.bracken, nL);
    // woods outside the core (inside it the municipal woodland is mapped): on slopes & in hollows, fading in past the
    // core's edge so the seam doesn't show
    const forestAmt = smoothstep(0.5, 0.58, nXL.add(slope.mul(0.6)).add(nL.sub(0.5).mul(0.12))).mul(smoothstep(40, 220, outside));
    const forest = C.forest.mul(nM.mul(0.3).add(0.85));
    // rock on the steep faces and the sea cliffs, bedded like the Igeldo & Ulia flysch
    const strata = smoothstep(0.25, 0.75, fract(y.div(0.55).add(nL.mul(0.6)))).mul(0.18).add(0.86);
    const rock = mix(C.rockA, C.rockB, nM).mul(strata).mul(nF.mul(0.16).add(0.92));
    const cliff = smoothstep(0.2, 0.32, slope).mul(smoothstep(80, 30, y));
    const rockAmt = max(smoothstep(0.33, 0.5, slope.add(nM.sub(0.5).mul(0.12))), cliff);
    // the tidal band (up to ~2 m on this coast): wet dark rock, weed below half tide; a little higher on rocky slopes,
    // so flat land just above the sea stays dry
    const tide = y.add(nM.sub(0.5).mul(0.6));
    const shore = max(smoothstep(2.1, 1.1, tide), smoothstep(3.2, 1.8, tide).mul(smoothstep(0.06, 0.15, slope)));
    const wet = mix(C.rockWet, C.weed, smoothstep(1.0, 0.2, y).mul(0.7)).mul(nF.mul(0.3).add(0.85));
    const c = mix(meadow, scrub, scrubAmt.mul(0.85)).toVar();
    c.assign(mix(c, forest, forestAmt));
    c.assign(mix(c, rock, rockAmt));
    c.assign(mix(c, wet, shore));
    return c.mul(nF.mul(0.1).add(0.95));
  })().toVar();

  // --- asphalt: road & bidegorri ---
  const grain = nF.mul(0.25).add(nM.mul(0.45)).add(nL.mul(0.3));
  const asphaltBase = mix(C.asphaltDark, C.asphaltLight, grain);
  // trench & pothole repairs, squared to the street
  const patchSize = vec2(6.2, 3.4);
  const patchCell = floor(q.div(patchSize));
  const patchHash = hash12(patchCell.add(71.3));
  const patchUV = fract(q.div(patchSize));
  const patchIn = band(patchUV.x, 0.08, 0.92, fw.div(patchSize.x)).mul(band(patchUV.y, 0.1, 0.9, fw.div(patchSize.y)));
  const patch = step(0.86, patchHash).mul(patchIn);
  const patched = mix(asphaltBase, mix(C.patchNew, C.patchOld, step(0.94, patchHash)).mul(nF.mul(0.2).add(0.9)), patch);
  // tar-sealed cracks along a noise contour, on the older stretches only
  const crack = float(1).sub(smoothstep(0.0, fwidth(nM).add(0.012), abs(nM.sub(0.53))))
    .mul(smoothstep(0.5, 0.65, nL)).mul(fade(0.1, 0.02)).mul(0.5);
  // cast-iron manholes, one 12 m cell in four, kept off the kerbs
  const mhCell = floor(q.div(12));
  const mhCentre = mhCell.add(vec2(hash12(mhCell.add(13.7)), hash12(mhCell.add(29.1))).mul(0.6).add(0.2)).mul(12);
  const mhDist = length(q.sub(mhCentre));
  const manhole = band(mhDist, -1, 0.34, fw).mul(step(0.75, hash12(mhCell))).mul(mix(float(1), smoothstep(1.2, 1.6, rK), step(0.5, kerbed)));
  const mhRings = sin(mhDist.mul(40)).mul(0.12).mul(fade(0.03, 0.008)).add(0.9);
  const asphalt = mix(patched.mul(float(1).sub(crack)), C.manhole.mul(mhRings), manhole);
  const bikeLane = C.bike.mul(grain.mul(0.3).add(0.8)).mul(float(1).sub(crack.mul(0.6)));

  // --- unit paving (sidewalk tiles, slabs, setts, quay stones, concrete) with parameters picked by surface ---
  const par = (k, fallback) => pick(isW, PAVING.map((row) => [row[0], float(row[k])]), float(fallback));
  const parC = (k) => pick(isW, PAVING.map((row) => [row[0], color(row[k])]), color(PAVING[0][k]));
  const unit = vec2(par(1, 0.4), par(2, 0.4)).toVar();
  const row = floor(q.y.div(unit.y));
  const pq = vec2(q.x.div(unit.x).add(row.mul(par(3, 0))), q.y.div(unit.y)).toVar();
  const jw = par(4, 0.007);
  const jointX = filteredPulse(pq.x.add(jw.div(unit.x).mul(0.5)), 0, jw.div(unit.x), fw.div(unit.x));
  const jointY = filteredPulse(pq.y.add(jw.div(unit.y).mul(0.5)), 0, jw.div(unit.y), fw.div(unit.y));
  const joint = float(1).sub(float(1).sub(jointX).mul(float(1).sub(jointY))).toVar();
  const unitCell = floor(pq);
  const unitDetail = smoothstep(min(unit.x, unit.y).mul(0.6), min(unit.x, unit.y).mul(0.15), fw); // units resolved
  const tone = mix(float(0.5), hash12(unitCell.add(wid.mul(19.1))), unitDetail);
  const odd = step(float(1).sub(par(7, 0)), hash12(unitCell.add(5.3))).mul(unitDetail);
  const paving = mix(parC(5), parC(6), tone).mul(float(1).sub(odd.mul(0.3)))
    .mul(nF.mul(0.1).add(0.95)).mul(nL.mul(0.12).add(0.92))
    .mul(float(1).sub(joint.mul(0.38))).toVar();
  // stairs: a nosing line on every 16 cm of rise, risers in shade
  const stepPhase = y.div(0.16);
  const nosing = filteredPulse(stepPhase, 0, 0.12, fwY.div(0.16));
  const riser = filteredPulse(stepPhase, 0.12, 0.45, fwY.div(0.16));
  const stairs = paving.mul(float(1).sub(nosing.mul(0.35))).mul(float(1).sub(riser.mul(0.2)));
  const pavedUV = fract(pq);
  const dome = pavedUV.x.mul(float(1).sub(pavedUV.x)).mul(pavedUV.y.mul(float(1).sub(pavedUV.y))).mul(16).mul(par(8, 0));

  // --- soft & loose surfaces ---
  const lawn = mix(C.lawnA, C.lawnB, nM.mul(0.6).add(nL.mul(0.4))).mul(nF.mul(0.16).add(0.92));
  const flowerCell = floor(xz.div(0.18));
  const fh = hash12(flowerCell.add(3.1)), fh2 = hash12(flowerCell.add(8.7));
  // red begonias, yellow marigolds, white alyssum, purple & pink petunias
  const blossom = [[0.85, 0x7a3aa0], [0.68, 0xe9e4da], [0.5, 0xe8bf2e], [0.3, 0xc8282c]]
    .reduce((c, [below, hex]) => mix(c, color(hex), step(fh, below)), color(0xe06c9c));
  const flowers = mix(mix(C.flowerBed, color(0xb85a5a), 0.35), mix(C.flowerBed, blossom, step(0.42, fh2)), fade(0.12, 0.04));
  const hedge = C.hedge.mul(nF.mul(0.35).add(0.8));
  const woodland = mix(C.litter, C.moss, smoothstep(0.4, 0.7, nM)).mul(nF.mul(0.3).add(0.85));
  const path = mix(C.gravel, C.earth, nL.mul(0.7)).mul(nF.mul(0.25).add(0.88));
  const treePit = C.soil.mul(nF.mul(0.35).add(0.8));
  const rail = C.ballast.mul(nF.mul(0.35).add(0.8)).mul(nM.mul(0.15).add(0.92));
  const seabed = C.seabed.mul(mix(float(1), float(0.35), smoothstep(0, 12, y.negate()))).mul(nM.mul(0.2).add(0.9));
  // La Concha, Ondarreta & Zurriola: golden dry sand, darker wet sand in the tidal band, glossy where the waves wash
  const tideLine = y.add(nM.sub(0.5).mul(0.5)).add(nL.sub(0.5).mul(0.6));
  const sandWet = smoothstep(2.3, 1.2, tideLine).toVar();
  const swash = smoothstep(0.55, 0.1, tideLine).toVar();
  const sand = mix(mix(C.sandDry, C.sandDry2, nM.mul(0.6).add(nF.mul(0.4))), C.sandWet, sandWet).mul(nF.mul(0.08).add(0.96));
  const beach = mix(sand, C.sandSwash, swash);
  const bareRock = mix(C.rockA, C.rockB, nM).mul(nF.mul(0.2).add(0.9));

  const surface = pick(isW, [
    ...PAVED.filter((k) => k !== S.stairs).map((k) => [k, paving]),
    [S.road, asphalt], [S.bike, bikeLane], [S.stairs, stairs], [S.garden, lawn], [S.flowers, flowers], [S.hedge, hedge],
    [S.woodland, woodland], [S.path, path], [S.treePit, treePit], [S.rail, rail], [S.seabed, seabed], [S.beach, beach],
    [S.rock, bareRock]
  ], natural);

  // Edges: the runner-up's base colour over the last pixel; once a texel shrinks towards a pixel, the four texels' base
  // colours, which is what a mip-map of the surface map would show
  const base = (is) => pick(is, BASE, natural);
  const nearColour = mix(surface, base(isS), edgeMix);
  const farColour = texels.reduce((s, k) => s.add(base(weights(k.id)).mul(k.w)), vec3(0));
  const blended = mix(nearColour, farColour, smoothstep(0.8, 2.5, fw).mul(inCore));

  // --- kerbs, gutters & zebra crossings ---
  // granite kerbstones on the pavement side (1 m stones), a grimy gutter on the road side
  const kerbStone = band(rK, -0.2, 0, fw).mul(kerbed).toVar();
  const kerbJoint = filteredPulse(q.x.add(0.005), 0, 0.01, fw).mul(0.4);
  const gutter = float(1).sub(smoothstep(0.08, 0.45, rK)).mul(step(0, rK)).mul(kerbed).mul(roadShare);
  // zebra crossings: 0.5 m bars across the road from kerb to kerb, 4 m wide; the nearest texel names the crossing
  const sx = step(0.5, t.x), sz = step(0.5, t.y);
  const slotAt = (a, b) => texels[a + 2 * b].slot;
  const slot = mix(mix(slotAt(0, 0), slotAt(1, 0), sx), mix(slotAt(0, 1), slotAt(1, 1), sx), sz).toVar();
  const ni = ci.add(sx), nj = cj.add(sz);
  const tileRow = clamp(floor(nj.div(CROSSING_TILE)).mul(maps.tilesX).add(floor(ni.div(CROSSING_TILE))), 0, maps.ch - 1);
  const col = max(slot.sub(1), 0).mul(3);
  const P0 = textureLoad(maps.crossings, ivec2(clamp(col, 0, maps.cw - 1), tileRow)).mul(255).toVar();
  const P1 = textureLoad(maps.crossings, ivec2(clamp(col.add(1), 0, maps.cw - 1), tileRow)).mul(255).toVar();
  const P2 = textureLoad(maps.crossings, ivec2(clamp(col.add(2), 0, maps.cw - 1), tileRow)).mul(255).toVar();
  const byte = (v) => floor(v.add(0.5));
  const cx = byte(P0.x).mul(65536).add(byte(P0.y).mul(256)).add(byte(P0.z)).div(100).add(x0);
  const cz = byte(P0.w).mul(65536).add(byte(P1.x).mul(256)).add(byte(P1.y)).div(100).add(z0);
  const cAng = byte(P1.z).mul(256).add(byte(P1.w)).div(65536).mul(PI);
  const cu = vec2(cos(cAng), sin(cAng)); // walking direction
  const rel = xz.sub(vec2(cx, cz));
  const u = dot(rel, cu), v = dot(rel, vec2(cu.y.negate(), cu.x));
  const halfLen = byte(P2.x).div(10), halfWid = byte(P2.y).div(10);
  const bars = filteredPulse(u.add(0.25), 0, 0.5, fw);
  const inCrossing = band(u, halfLen.negate(), halfLen, fw).mul(band(v, halfWid.negate(), halfWid, fw));
  const clearOfKerb = mix(float(1), smoothstep(0.3, 0.45, rK), step(0.5, kerbed));
  const paintWear = smoothstep(0.15, 0.55, nM.mul(0.6).add(nF.mul(0.4))).mul(0.3).add(0.7);
  const zebra = bars.mul(inCrossing).mul(clearOfKerb).mul(roadShare).mul(step(0.5, slot)).mul(paintWear).toVar();

  const kerbColour = C.kerb.mul(nF.mul(0.12).add(0.94)).mul(float(1).sub(kerbJoint));
  const marked = mix(mix(blended.mul(float(1).sub(gutter.mul(0.32))), kerbColour, kerbStone), C.paint, zebra);

  // --- rain: damp stains, puddles & a wet film on the hard surfaces (roadWetMasks in js/tsl-materials.js) ---
  const hard = isAny(isW, HARD).toVar();
  const wetness = cityUniforms.uRoadWetness;
  const field = nL.mul(0.55).add(nM.mul(0.33)).add(nF.mul(0.12));
  const level = mix(float(0.86), float(0.56), clamp(wetness.sub(0.1).div(0.55), 0, 1));
  const damp = smoothstep(level.sub(0.09), level.sub(0.015), field).mul(hard).toVar();
  const puddle = smoothstep(level, level.add(0.022), field).mul(smoothstep(0.1, 0.22, wetness))
    .mul(isAny(isW, POOLING)).mul(smoothstep(0.985, 0.996, normalWorldGeometry.y)).mul(float(1).sub(kerbStone)).toVar();
  const film = smoothstep(0.2, 0.8, wetness).toVar();
  const isBeach = isW(S.beach);
  const shoreWet = max(isW(S.natural), isW(S.rock)).mul(smoothstep(2.4, 1.2, y));

  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = marked.mul(mix(float(1), float(0.72), damp)).mul(mix(float(1), float(0.62), puddle))
    .mul(mix(float(1), mix(float(0.88), float(0.8), hard), film));

  const roughBase = pick(isW, ROUGH.map(([k, r]) => [k, float(r)]), float(0.93));
  mat.roughnessNode = Fn(() => {
    const r = roughBase.toVar();
    r.assign(mix(r, float(0.42), max(film.mul(0.85), damp.mul(0.8)).mul(hard)));
    r.assign(mix(r, float(0.07), puddle));
    r.assign(mix(r, mix(float(0.55), float(0.18), swash), sandWet.mul(isBeach)));
    r.assign(mix(r, float(0.5), shoreWet));
    return r;
  })();

  // Water's Fresnel (F0 = 0.02) rides on metalness, as for the roads of js/tsl-materials.js, so puddles and the swash
  // mirror the city through SSR at grazing angles yet only darken seen from above
  const viewUp = normalize(cameraPosition.sub(p)).y;
  const fresnel = pow(float(1).sub(clamp(viewUp, 0, 1)), 5).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0, 0.85).mul(max(max(puddle, film.mul(0.5).mul(hard)), swash.mul(isBeach).mul(0.6)));

  // Relief: paving joints & domed setts, the kerb's 12 cm step, asphalt grain, ripples in the wet sand
  mat.normalNode = Fn(() => {
    const pavedRelief = dome.sub(joint.mul(0.006)).mul(isAny(isW, PAVED)).mul(fade(0.06, 0.015));
    const kerbStep = float(1).sub(smoothstep(-0.03, 0.03, rK)).mul(0.12).mul(kerbed).mul(fade(0.08, 0.02));
    const asphaltGrain = nF.sub(0.5).mul(0.003).mul(roadShare).mul(float(1).sub(puddle)).mul(fade(0.05, 0.012));
    const ripples = sin(dot(xz, vec2(0.62, 0.78)).mul(52).add(nM.mul(9))).mul(0.0025)
      .mul(sandWet.mul(float(1).sub(swash)).mul(isBeach)).mul(fade(0.03, 0.008));
    return bumpNormal(pavedRelief.add(kerbStep).add(asphaltGrain).add(ripples).add(zebra.mul(0.0015)));
  })();

  return mat;
}
