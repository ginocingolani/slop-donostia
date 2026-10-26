import * as THREE from 'three/webgpu';
import {
  Fn, If, float, int, vec2, vec3, vec4, ivec2, color, floor, fract, abs, min, max, clamp, mix, step, smoothstep, dot,
  sin, cos, pow, length, normalize, fwidth, textureLoad, positionWorld, positionView, normalView,
  normalWorldGeometry, cameraPosition, PI
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { decodePNGOffThread } from './png.js';
import { releaseImageData } from './terrain.js';

// js/donostia/ground.js
// Ground surfaces over the LiDAR terrain, one material for every terrain chunk. In the core the baked maps of
// tools/donostia/bake-ground.mjs give each metre its surface (asphalt, Donostia's grey pavement tiles, the Parte
// Vieja's setts, bidegorris, lawns, sand…) plus the distance to that surface's edge and to the nearest kerb, so edges
// are rebuilt to a few centimetres from four texels instead of the stair steps of a class map; zebra crossings come
// from OpenStreetMap as exact rectangles. Patterns line up with the nearest street edge and settle to their mean
// colour once smaller than a pixel. Outside the core (and wherever the maps are missing) the ground is natural:
// meadow parcels, scrub and woods on the slopes, rock on the cliffs and wet rock and weed at the waterline.
//
// Cost: the ground covers most of the screen, so the shader works out only the surface under the pixel. What every
// pixel needs (the pixel footprints, the shared noise, the four texels and the street frame) is built up front in the
// main flow, where WGSL allows the derivatives behind the anti-aliasing and the bump; the surfaces' own patterns then
// run in branches by surface group (natural, asphalt, unit paving, sand, flower beds, the plain rest), which hold no
// derivatives or filtered texture reads. Per-surface constants (base colours, roughness, paving units) come from
// small uniform arrays indexed by the surface id, the fine grain noise only runs where it is resolved, and the zebra
// crossings' three texel reads only where a crossing is mapped.

// Surface ids of the baked map (SURFACE in tools/donostia/bake-ground.mjs; 0-11 match GEO.terrain.classes)
export const SURFACE = {
  natural: 0, road: 1, sidewalk: 2, pedestrian: 3, garden: 4, woodland: 5, beach: 6, seabed: 7, building: 8, bike: 9,
  stairs: 10, rail: 11, setts: 12, path: 13, treePit: 14, flowers: 15, hedge: 16, yard: 17, rock: 18, quay: 19
};
const S = SURFACE;
const SURFACES = 20;

const FILES = {
  core: 'data/donostia/ground-core.png',
  orient: 'data/donostia/ground-orient.png',
  crossings: 'data/donostia/ground-crossings.png'
};
const CROSSING_TILE = 256; // m (bake-ground.mjs TILE)

// --- baked maps ------------------------------------------------------------------------------------------------------

async function fetchPNG(url, transform = null, arg = null) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return decodePNGOffThread(await res.arrayBuffer(), transform, arg);
}

function dataTexture(data, w, h, format) {
  const t = new THREE.DataTexture(data, w, h, format, THREE.UnsignedByteType);
  t.magFilter = t.minFilter = THREE.NearestFilter; // read with textureLoad, exact bytes
  t.generateMipmaps = false;
  t.needsUpdate = true;
  // only the shader reads the maps: the decoded bytes (86 MB for the core map) go once they are on the GPU
  t.onUpdate = releaseImageData;
  return t;
}

// Starts downloading & decoding the baked maps (main.js calls it before the terrain loads, so both come in together);
// resolves to the decoded images or { error }
export function prefetchGroundMaps() {
  // the core map's four grey planes (surface, edge distance, kerb distance, crossing slot) come back as one RGBA texel
  // per metre, interleaved in the decoding worker
  return Promise.all([fetchPNG(FILES.core, 'planesToRGBA', 4), fetchPNG(FILES.orient), fetchPNG(FILES.crossings)]).catch((error) => ({ error }));
}

async function loadMaps(core, prefetched) {
  const w = Math.round(core.width), h = Math.round(core.depth);
  const images = await (prefetched || prefetchGroundMaps());
  if (images.error) throw images.error;
  const [planes, orient, crossings] = images;
  if (planes.channels !== 4 || planes.width !== w || planes.height !== h) throw new Error(`${FILES.core} does not match the terrain core`);
  return {
    ground: dataTexture(planes.data, w, h, THREE.RGBAFormat), w, h, res: 1,
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
// Branch-free lookup over surface ids, table = [[id, node], ...]
const pick = (id, table, fallback) => table.reduce((out, [k, v]) => mix(out, v, eq(id, k)), fallback);

// --- palette (sRGB hex; color() and THREE.Color both convert to linear) ------------------------------------------------

const HEX = {
  asphaltDark: 0x2f3134, asphaltLight: 0x4b4d50, patchNew: 0x232527, patchOld: 0x5a5a59,
  manhole: 0x3b3632, kerb: 0xb4b1a8, paint: 0xe2e1da, bike: 0x8a3a31,
  meadowA: 0x5f7f2f, meadowB: 0x7a943c, hay: 0x9a9450, scrub: 0x6a6533, bracken: 0x7b6233,
  forest: 0x2b3d1f, rockA: 0x8b857a, rockB: 0xa29b8b, rockWet: 0x3d3a33, weed: 0x3c4626,
  lawnA: 0x55822c, lawnB: 0x6c9636, hedge: 0x2f5022, litter: 0x3e3221, moss: 0x3f5426,
  flowerBed: 0x3c5f25, soil: 0x3a2c21, gravel: 0xa99d84, earth: 0x8a7a60,
  sandDry: 0xdcc69a, sandDry2: 0xcfb68a, sandWet: 0x9b845e, sandSwash: 0x7a6749,
  seabed: 0x8a7a5c, ballast: 0x6f675e, stairs: 0xb4ad9f
};
const C = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, color(v)]));

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

// Base albedo per surface: the far-field average and the colour across an edge (natural, id 0, is worked out)
const BASE = {
  [S.road]: 0x3c3e41, [S.sidewalk]: 0xaca89e, [S.pedestrian]: 0xbeb097, [S.garden]: HEX.lawnA, [S.woodland]: 0x3a3a24,
  [S.beach]: HEX.sandDry, [S.seabed]: HEX.seabed, [S.building]: 0x7a7772, [S.bike]: HEX.bike, [S.stairs]: HEX.stairs,
  [S.rail]: HEX.ballast, [S.setts]: 0x96938b, [S.path]: HEX.gravel, [S.treePit]: HEX.soil, [S.flowers]: 0x5a6a33,
  [S.hedge]: HEX.hedge, [S.yard]: 0xa6a49d, [S.rock]: 0x6a6356, [S.quay]: 0x9b9990
};
const ROUGH = {
  [S.road]: 0.86, [S.sidewalk]: 0.8, [S.pedestrian]: 0.78, [S.setts]: 0.7, [S.stairs]: 0.8, [S.quay]: 0.85, [S.yard]: 0.85,
  [S.building]: 0.85, [S.bike]: 0.84, [S.rail]: 0.95, [S.beach]: 0.96, [S.seabed]: 0.9, [S.path]: 0.95, [S.treePit]: 1.0
};
const HARD = [S.road, S.sidewalk, S.pedestrian, S.setts, S.stairs, S.quay, S.yard, S.building, S.bike];
const POOLING = [S.road, S.bike, S.setts, S.pedestrian, S.yard, S.quay]; // impervious enough to hold puddles
const PAVED = PAVING.map((row) => row[0]);
// Surface groups, each one branch of the shader
const GROUP = { natural: 0, asphalt: 1, paved: 2, beach: 3, flowers: 4, plain: 5 };
const groupOf = (k) => k === S.natural ? GROUP.natural : k === S.road || k === S.bike ? GROUP.asphalt :
  PAVED.includes(k) ? GROUP.paved : k === S.beach ? GROUP.beach : k === S.flowers ? GROUP.flowers : GROUP.plain;

// The per-surface constants, one texel per surface id and row (a small float texture read with textureLoad: shared by
// every chunk and never re-uploaded, where uniform arrays would be copied into each mesh's bindings every frame):
// - surface: base albedo (linear rgb), roughness
// - flags: hard, holds puddles, branch group
// - paveA: unit along, across, running-bond shift, joint width; paveB: dark rgb, odd share; paveC: light rgb, dome
const TABLE_ROWS = { surface: 0, flags: 1, paveA: 2, paveB: 3, paveC: 4 };
function surfaceTables() {
  const lin = (hex) => new THREE.Color(hex);
  const data = new Float32Array(SURFACES * 5 * 4);
  const put = (row, k, v) => data.set(v, (row * SURFACES + k) * 4);
  for (let k = 0; k < SURFACES; k++) {
    const c = lin(BASE[k] ?? 0x000000);
    put(TABLE_ROWS.surface, k, [c.r, c.g, c.b, ROUGH[k] ?? 0.93]);
    put(TABLE_ROWS.flags, k, [HARD.includes(k) ? 1 : 0, POOLING.includes(k) ? 1 : 0, groupOf(k), 0]);
    const row = PAVING.find((r) => r[0] === k) || PAVING[0];
    const dark = lin(row[5]), light = lin(row[6]);
    put(TABLE_ROWS.paveA, k, [row[1], row[2], row[3], row[4]]);
    put(TABLE_ROWS.paveB, k, [dark.r, dark.g, dark.b, row[7]]);
    put(TABLE_ROWS.paveC, k, [light.r, light.g, light.b, row[8]]);
  }
  const tex = new THREE.DataTexture(data, SURFACES, 5, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  const read = (row) => (id) => textureLoad(tex, ivec2(int(id), row));
  return Object.fromEntries(Object.entries(TABLE_ROWS).map(([name, row]) => [name, read(row)]));
}

// --- material ----------------------------------------------------------------------------------------------------------

export async function createGroundMaterial(terrain, prefetched = null) {
  const { core } = terrain;
  let maps;
  try {
    maps = await loadMaps(core, prefetched);
  } catch (e) {
    console.warn('[ground] baked ground maps unavailable, using the terrain classes', e);
    maps = fallbackMaps(core);
  }
  const { w, h, res } = maps;
  const x0 = core.x0, z0 = core.z0, x1 = core.x0 + core.width, z1 = core.z0 + core.depth;
  const T = surfaceTables();
  const surfaceOf = T.surface;

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

  // Shared noise (each node is generated once per fragment however many surfaces read it); the ~0.3 m grain nF is
  // worked out in the colour pass below, only where it is resolved
  const nM = valueNoise(xz.mul(0.45).add(17.3)).toVar(); // ~2 m
  const nL = valueNoise(xz.mul(0.06).add(41.7)).toVar(); // ~16 m
  const nXL = valueNoise(xz.mul(0.0075).add(3.9)).toVar(); // ~130 m
  const fwM = fwidth(nM).toVar(); // (for the cracks' anti-aliasing: derivatives belong in the main flow)
  const nF = float(0.5).toVar('groundGrain');

  // --- the four texels around the fragment ---
  const f = xz.sub(vec2(x0, z0)).div(res).sub(0.5); // texel centres on integers
  const ci = clamp(floor(f.x), 0, w - 2).toVar(), cj = clamp(floor(f.y), 0, h - 2).toVar();
  const t = clamp(f.sub(vec2(ci, cj)), 0, 1).toVar();
  const texels = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([a, b]) => {
    const T4 = textureLoad(maps.ground, ivec2(ci.add(a), cj.add(b))).mul(255).toVar();
    return {
      id: floor(T4.x.add(0.5)), d: T4.y.div(100), kerb: T4.z.sub(128).div(63), slot: floor(T4.w.add(0.5)),
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
  const surfW = surfaceOf(wid).toVar(), flagsW = T.flags(wid).toVar();
  const group = flagsW.z.toVar();

  // Signed distance to the nearest kerb (+ on the carriageway), meaningful where `kerbed` > 0
  const rK = texels.reduce((s, k) => s.add(k.w.mul(k.kerb)), float(0)).toVar();
  const kerbed = texels.reduce((s, k) => s.add(k.w.mul(step(abs(k.kerb), 1.95))), float(0)).mul(inCore).toVar();
  const roadShare = eq(wid, S.road).mul(float(1).sub(edgeMix)).add(eq(sid, S.road).mul(edgeMix)).toVar();
  // the natural ground is needed where it is the surface, the runner-up across an edge, or one of the four texels
  const needsNatural = texels.reduce((s, k) => s.add(eq(k.id, S.natural)), eq(wid, S.natural)).add(eq(sid, S.natural)).toVar();

  // Street frame: direction of the nearest kerb or the prevailing one (2 m map), so tiles, setts, kerbstones & patches
  // follow the street
  const oi = clamp(floor(xz.x.sub(x0).div(maps.orientRes)), 0, maps.ow - 1);
  const oj = clamp(floor(xz.y.sub(z0).div(maps.orientRes)), 0, maps.oh - 1);
  const ang = textureLoad(maps.orient, ivec2(oi, oj)).x.mul(255 / 256).mul(PI).toVar();
  const along = vec2(cos(ang), sin(ang));
  const q = vec2(dot(xz, along), dot(xz, vec2(along.y.negate(), along.x))).toVar();

  // The nearest texel names the crossing (its slot), read before the branches
  const sx = step(0.5, t.x), sz = step(0.5, t.y);
  const slotAt = (a, b) => texels[a + 2 * b].slot;
  const slot = mix(mix(slotAt(0, 0), slotAt(1, 0), sx), mix(slotAt(0, 1), slotAt(1, 1), sx), sz).toVar();

  // What the colour pass leaves for the other slots
  const surfColour = vec3(0).toVar('groundSurface');
  const naturalColour = vec3(0).toVar('groundNatural');
  const relief = float(0).toVar('groundRelief'); // the surface's own height field (m) for the bump
  const sandWet = float(0).toVar('groundSandWet'); // wet sand & the swash: on beaches only
  const swash = float(0).toVar('groundSwash');
  const zebra = float(0).toVar('groundZebra');
  const kerbStone = float(0).toVar('groundKerbStone');
  const damp = float(0).toVar('groundDamp');
  const puddle = float(0).toVar('groundPuddle');
  const hard = flagsW.x;
  const film = smoothstep(0.2, 0.8, cityUniforms.uRoadWetness).toVar();

  // TSL keeps a shared node in the variable it was first assigned to: one first built inside a branch would be stale
  // wherever that branch didn't run (see facade-material.js). Everything the branches share is built up front here.
  const shared = [fw, fwY, slope, inCore, nM, nL, nXL, fwM, ci, cj, t.x, best, sid, edgeMix, surfW.x, flagsW.x, group,
    rK, kerbed, roadShare, needsNatural, ang, q.x, slot, film, y, ...texels.map((k) => k.id), ...scores];

  const mat = new THREE.MeshStandardNodeMaterial();

  mat.colorNode = Fn(() => {
    // the slots' variables are declared here, in the main flow, before any branch assigns them
    surfColour.assign(vec3(shared.reduce((s, n) => s.add(n), float(0)).mul(0)));
    for (const v of [naturalColour]) v.assign(vec3(0));
    for (const v of [relief, sandWet, swash, zebra, kerbStone, damp, puddle]) v.assign(float(0));
    nF.assign(float(0.5));

    // grain, ~0.3 m: only resolved below a 12 cm pixel (it is its mean, 0.5, beyond)
    If(fw.lessThan(0.12), () => {
      nF.assign(mix(float(0.5), valueNoise(xz.mul(3.1)), fade(0.12, 0.03)));
    });

    // --- natural ground (also the whole context grid) ---
    If(needsNatural.greaterThan(0.5), () => {
      // meadow parcels of slightly different greens (hay, fresh grass), like the farmland on the hills
      const parcel = hash12(floor(xz.add(vec2(nL, nM).mul(40)).div(70)));
      const meadow = mix(C.meadowA, C.meadowB, nL.mul(0.7).add(nM.mul(0.3))).mul(parcel.mul(0.22).add(0.88)).toVar();
      meadow.assign(mix(meadow, C.hay, step(0.84, parcel).mul(0.55)));
      // gorse & bracken on the steeper and the exposed slopes
      const scrubAmt = smoothstep(0.1, 0.26, slope.add(nXL.sub(0.5).mul(0.3)).add(nM.sub(0.5).mul(0.06)));
      const scrub = mix(C.scrub, C.bracken, nL);
      // woods outside the core (inside it the municipal woodland is mapped): on slopes & in hollows, fading in past
      // the core's edge so the seam doesn't show
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
      naturalColour.assign(c.mul(nF.mul(0.1).add(0.95)));
    });

    // --- the surface here, by group ---
    If(group.lessThan(0.5), () => {
      surfColour.assign(naturalColour);
    }).ElseIf(group.lessThan(1.5), () => {
      // asphalt: road & bidegorri
      const grain = nF.mul(0.25).add(nM.mul(0.45)).add(nL.mul(0.3));
      const asphaltBase = mix(C.asphaltDark, C.asphaltLight, grain);
      // tar-sealed cracks along a noise contour, on the older stretches only
      const crack = float(1).sub(smoothstep(0.0, fwM.add(0.012), abs(nM.sub(0.53))))
        .mul(smoothstep(0.5, 0.65, nL)).mul(fade(0.1, 0.02)).mul(0.5).toVar();
      If(wid.lessThan(1.5), () => {
        // trench & pothole repairs, squared to the street
        const patchSize = vec2(6.2, 3.4);
        const patchCell = floor(q.div(patchSize));
        const patchHash = hash12(patchCell.add(71.3));
        const patchUV = fract(q.div(patchSize));
        const patchIn = band(patchUV.x, 0.08, 0.92, fw.div(patchSize.x)).mul(band(patchUV.y, 0.1, 0.9, fw.div(patchSize.y)));
        const patch = step(0.86, patchHash).mul(patchIn);
        const patched = mix(asphaltBase, mix(C.patchNew, C.patchOld, step(0.94, patchHash)).mul(nF.mul(0.2).add(0.9)), patch);
        // cast-iron manholes, one 12 m cell in four, kept off the kerbs
        const mhCell = floor(q.div(12));
        const mhCentre = mhCell.add(vec2(hash12(mhCell.add(13.7)), hash12(mhCell.add(29.1))).mul(0.6).add(0.2)).mul(12);
        const mhDist = length(q.sub(mhCentre));
        const manhole = band(mhDist, -1, 0.34, fw).mul(step(0.75, hash12(mhCell))).mul(mix(float(1), smoothstep(1.2, 1.6, rK), step(0.5, kerbed)));
        const mhRings = sin(mhDist.mul(40)).mul(0.12).mul(fade(0.03, 0.008)).add(0.9);
        surfColour.assign(mix(patched.mul(float(1).sub(crack)), C.manhole.mul(mhRings), manhole));
      }).Else(() => {
        surfColour.assign(C.bike.mul(grain.mul(0.3).add(0.8)).mul(float(1).sub(crack.mul(0.6))));
      });
    }).ElseIf(group.lessThan(2.5), () => {
      // unit paving (sidewalk tiles, slabs, setts, quay stones, concrete, stairs) with the surface's parameters
      const A = T.paveA(wid), B = T.paveB(wid), Cc = T.paveC(wid);
      const unit = A.xy.toVar();
      const row = floor(q.y.div(unit.y));
      const pq = vec2(q.x.div(unit.x).add(row.mul(A.z)), q.y.div(unit.y)).toVar();
      const jw = A.w;
      const jointX = filteredPulse(pq.x.add(jw.div(unit.x).mul(0.5)), 0, jw.div(unit.x), fw.div(unit.x));
      const jointY = filteredPulse(pq.y.add(jw.div(unit.y).mul(0.5)), 0, jw.div(unit.y), fw.div(unit.y));
      const joint = float(1).sub(float(1).sub(jointX).mul(float(1).sub(jointY))).toVar();
      const unitCell = floor(pq);
      const unitDetail = smoothstep(min(unit.x, unit.y).mul(0.6), min(unit.x, unit.y).mul(0.15), fw); // units resolved
      const tone = mix(float(0.5), hash12(unitCell.add(wid.mul(19.1))), unitDetail);
      const odd = step(float(1).sub(B.w), hash12(unitCell.add(5.3))).mul(unitDetail);
      const paving = mix(B.xyz, Cc.xyz, tone).mul(float(1).sub(odd.mul(0.3)))
        .mul(nF.mul(0.1).add(0.95)).mul(nL.mul(0.12).add(0.92))
        .mul(float(1).sub(joint.mul(0.38))).toVar();
      // stairs: a nosing line on every 16 cm of rise, risers in shade
      const stepPhase = y.div(0.16);
      const nosing = filteredPulse(stepPhase, 0, 0.12, fwY.div(0.16));
      const riser = filteredPulse(stepPhase, 0.12, 0.45, fwY.div(0.16));
      const stairs = paving.mul(float(1).sub(nosing.mul(0.35))).mul(float(1).sub(riser.mul(0.2)));
      surfColour.assign(mix(paving, stairs, eq(wid, S.stairs)));
      const pavedUV = fract(pq);
      const dome = pavedUV.x.mul(float(1).sub(pavedUV.x)).mul(pavedUV.y.mul(float(1).sub(pavedUV.y))).mul(16).mul(Cc.w);
      relief.assign(dome.sub(joint.mul(0.006)).mul(fade(0.06, 0.015)));
    }).ElseIf(group.lessThan(3.5), () => {
      // La Concha, Ondarreta & Zurriola: golden dry sand, darker wet sand in the tidal band, glossy where the waves wash
      const tideLine = y.add(nM.sub(0.5).mul(0.5)).add(nL.sub(0.5).mul(0.6));
      sandWet.assign(smoothstep(2.3, 1.2, tideLine));
      swash.assign(smoothstep(0.55, 0.1, tideLine));
      const sand = mix(mix(C.sandDry, C.sandDry2, nM.mul(0.6).add(nF.mul(0.4))), C.sandWet, sandWet).mul(nF.mul(0.08).add(0.96));
      surfColour.assign(mix(sand, C.sandSwash, swash));
      // ripples in the wet sand
      relief.assign(sin(dot(xz, vec2(0.62, 0.78)).mul(52).add(nM.mul(9))).mul(0.0025)
        .mul(sandWet.mul(float(1).sub(swash))).mul(fade(0.03, 0.008)));
    }).ElseIf(group.lessThan(4.5), () => {
      const flowerCell = floor(xz.div(0.18));
      const fh = hash12(flowerCell.add(3.1)), fh2 = hash12(flowerCell.add(8.7));
      // red begonias, yellow marigolds, white alyssum, purple & pink petunias
      const blossom = [[0.85, 0x7a3aa0], [0.68, 0xe9e4da], [0.5, 0xe8bf2e], [0.3, 0xc8282c]]
        .reduce((c, [below, hex]) => mix(c, color(hex), step(fh, below)), color(0xe06c9c));
      surfColour.assign(mix(mix(C.flowerBed, color(0xb85a5a), 0.35), mix(C.flowerBed, blossom, step(0.42, fh2)), fade(0.12, 0.04)));
    }).Else(() => {
      // the soft & loose rest
      const lawn = mix(C.lawnA, C.lawnB, nM.mul(0.6).add(nL.mul(0.4))).mul(nF.mul(0.16).add(0.92));
      const hedge = C.hedge.mul(nF.mul(0.35).add(0.8));
      const woodland = mix(C.litter, C.moss, smoothstep(0.4, 0.7, nM)).mul(nF.mul(0.3).add(0.85));
      const path = mix(C.gravel, C.earth, nL.mul(0.7)).mul(nF.mul(0.25).add(0.88));
      const treePit = C.soil.mul(nF.mul(0.35).add(0.8));
      const rail = C.ballast.mul(nF.mul(0.35).add(0.8)).mul(nM.mul(0.15).add(0.92));
      const seabed = C.seabed.mul(mix(float(1), float(0.35), smoothstep(0, 12, y.negate()))).mul(nM.mul(0.2).add(0.9));
      // the coast's bare rock & rubble mounds: weathered sandstone, darker in the hollows and down to the tide
      const bareRock = mix(C.rockWet, mix(C.rockA, C.rockB, nM), smoothstep(0.25, 0.75, nL.mul(0.5).add(nF.mul(0.5))).mul(0.6).add(0.2))
        .mul(nF.mul(0.2).add(0.9)).mul(smoothstep(-0.5, 3.0, y).mul(0.35).add(0.65));
      surfColour.assign(pick(wid, [[S.garden, lawn], [S.hedge, hedge], [S.woodland, woodland], [S.path, path],
        [S.treePit, treePit], [S.rail, rail], [S.seabed, seabed], [S.rock, bareRock]], lawn));
    });

    // Edges: the runner-up's base colour over the last pixel; once a texel shrinks towards a pixel, the four texels'
    // base colours, which is what a mip-map of the surface map would show
    const base = (id) => mix(surfaceOf(id).xyz, naturalColour, eq(id, S.natural));
    const nearColour = mix(surfColour, base(sid), edgeMix);
    const farColour = texels.reduce((s, k) => s.add(base(k.id).mul(k.w)), vec3(0));
    const blended = mix(nearColour, farColour, smoothstep(0.8, 2.5, fw).mul(inCore));

    // --- kerbs, gutters & zebra crossings ---
    // granite kerbstones on the pavement side (1 m stones), a grimy gutter on the road side
    kerbStone.assign(band(rK, -0.2, 0, fw).mul(kerbed));
    const kerbJoint = filteredPulse(q.x.add(0.005), 0, 0.01, fw).mul(0.4);
    const gutter = float(1).sub(smoothstep(0.08, 0.45, rK)).mul(step(0, rK)).mul(kerbed).mul(roadShare);
    // zebra crossings: 0.5 m bars across the road from kerb to kerb, 4 m wide (crossing data only where one is mapped)
    If(slot.greaterThan(0.5).and(roadShare.greaterThan(0)), () => {
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
      zebra.assign(bars.mul(inCrossing).mul(clearOfKerb).mul(roadShare).mul(paintWear));
    });

    const kerbColour = C.kerb.mul(nF.mul(0.12).add(0.94)).mul(float(1).sub(kerbJoint));
    const marked = mix(mix(blended.mul(float(1).sub(gutter.mul(0.32))), kerbColour, kerbStone), C.paint, zebra);

    // --- rain: damp stains, puddles & a wet film on the hard surfaces (roadWetMasks in js/tsl-materials.js) ---
    const wetness = cityUniforms.uRoadWetness;
    const field = nL.mul(0.55).add(nM.mul(0.33)).add(nF.mul(0.12));
    const level = mix(float(0.86), float(0.56), clamp(wetness.sub(0.1).div(0.55), 0, 1));
    damp.assign(smoothstep(level.sub(0.09), level.sub(0.015), field).mul(hard));
    puddle.assign(smoothstep(level, level.add(0.022), field).mul(smoothstep(0.1, 0.22, wetness))
      .mul(flagsW.y).mul(smoothstep(0.985, 0.996, normalWorldGeometry.y)).mul(float(1).sub(kerbStone)));

    return marked.mul(mix(float(1), float(0.72), damp)).mul(mix(float(1), float(0.62), puddle))
      .mul(mix(float(1), mix(float(0.88), float(0.8), hard), film));
  })();

  const shoreWet = max(eq(wid, S.natural), eq(wid, S.rock)).mul(smoothstep(2.4, 1.2, y));
  mat.roughnessNode = Fn(() => {
    const r = surfW.w.toVar();
    r.assign(mix(r, float(0.42), max(film.mul(0.85), damp.mul(0.8)).mul(hard)));
    r.assign(mix(r, float(0.07), puddle));
    r.assign(mix(r, mix(float(0.55), float(0.18), swash), sandWet));
    r.assign(mix(r, float(0.5), shoreWet));
    return r;
  })();

  // Water's Fresnel (F0 = 0.02) rides on metalness, as for the roads of js/tsl-materials.js, so puddles and the swash
  // mirror the city through SSR at grazing angles yet only darken seen from above
  const viewUp = normalize(cameraPosition.sub(p)).y;
  const fresnel = pow(float(1).sub(clamp(viewUp, 0, 1)), 5).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0, 0.85).mul(max(max(puddle, film.mul(0.5).mul(hard)), swash.mul(0.6)));

  // Relief: paving joints & domed setts, the kerb's 12 cm step, asphalt grain, ripples in the wet sand
  mat.normalNode = Fn(() => {
    const kerbStep = float(1).sub(smoothstep(-0.03, 0.03, rK)).mul(0.12).mul(kerbed).mul(fade(0.08, 0.02));
    const asphaltGrain = nF.sub(0.5).mul(0.003).mul(roadShare).mul(float(1).sub(puddle)).mul(fade(0.05, 0.012));
    return bumpNormal(relief.add(kerbStep).add(asphaltGrain).add(zebra.mul(0.0015)));
  })();

  return mat;
}
