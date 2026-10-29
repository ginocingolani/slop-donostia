import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, texture, positionWorld, cameraPosition, cameraViewMatrix, time, mix, smoothstep,
  clamp, pow, dot, normalize, min, max, abs, fract, floor, sin, cos, sqrt, exp, fwidth, select, mx_noise_float, uniform
} from 'three/tsl';
import { decodePNGOffThread } from './png.js';
import { MARINA } from './data-marina.js';
import { liveEnabled, liveSnapshot } from './live-state.js';
import { FIXED_SEA, seaParams, wavelength } from './sea-state.js';
import { seaUniforms } from './sea-uniforms.js';

// js/donostia/water.js
// The Bay of Biscay, La Concha, the Urumea and the ponds, on one sea plane at the tide's level plus pond surfaces.
// - Waves: slop-newyork's estuary shading (createWaterMaterial in js/tsl-materials.js) without its New York bounds: an
//   FFT wind-sea texture sampled in four rotated, drifting layers whose unresolved slope variance becomes GGX roughness
//   (LEAN mapping), so the sun's glitter path and the sky reflection come from the lighting, not from paint.
// - Colour from the depth of the LiDAR & isobath sea floor: sand-coloured at the waterline, turquoise over La Concha's
//   sand, deep blue past Santa Klara; darker and greener over rock; the river and the ponds green and murky.
// - Surf from tools/donostia/build.mjs's water fields (data/donostia/water.png): breaker lines that follow the depth
//   contours shoreward, with foam trailing behind them, sized by the exposure to the north-west swell (a metre and more
//   on Zurriola, a hand's breadth inside La Concha, nothing in the port); a swash line at the water's edge; the Urumea's
//   ripples carried seaward by the ebb.
// - Tide: userData.tide = { enabled, level, amplitude, period }: a fixed level (mean sea level 0 by default) or, when
//   enabled, a sine around it (a 12.4 h tide squeezed into `period` seconds). The LiDAR flew at low tide, so the
//   intertidal sand already shows at mean sea level. userData.seaLevel is a TSL uniform with the current level for
//   other shaders (wet sand, hulls), userData.getSeaLevel() the same in JS.
// - Harbour: inside the port's moles (js/donostia/data-marina.js: its water and its mouth) the water is calm, sheltered
//   more the further from the mouth: smaller ripples (the reflections sharpen), no surf or swash, and the harbour's
//   green water, never the turquoise of a sandy shallow (the LiDAR bed in the basins lies at -0.3 m). Off when the
//   marina's data has no harbour.
// - Real time (js/donostia/live-state.js, switched on): the tide's level, and the sea js/donostia/sea-state.js makes of
//   the waves, the swell and the wind, eased in every frame through uniforms: the breakers' size & period follow the
//   swell (Zurriola's the most, the bay's refracted round Santa Klara & Igeldo, none in the port); the wind sea's
//   energy and direction follow the wind (glassy in a calm, whitecaps from a fresh breeze); the open sea's long swell
//   runs in from its direction as three long-crested trains. Each uniform holds the fixed sea's value with the switch
//   off (FIXED_SEA), so the water is today's to the bit, and the live sea's extras sit behind uniform branches that
//   skip them.

const SIZE = 60000;
const POND_SINK = 0.4; // m: build.mjs sinks pond cells this far below their surveyed surface
const POND_MIN = 0.6; // m: class-water cells this high are ponds (the sea, the river & the surveyed bed lie below 0)
const FIELDS_URL = 'data/donostia/water.png';
const WATER_CLASS = 7;

// --- Wave texture (from js/tsl-materials.js: fft2DInverse & getWaterWaveTexture, unchanged) ---------------------------

/**
 * Tileable wind-wave texture synthesised once on the CPU: a random-phase directional wind-sea spectrum (k^-4 saturation
 * range above a spectral peak, cos² spreading) inverse-FFT'd to height & slopes. RGBA half-float: R,G = slope (dh/du,
 * dh/dv in tile units, unit RMS), B = squared slope, A = height (unit RMS). The box-filtered mip chain is averaged in
 * float, so trilinear / anisotropic sampling returns the mean slope AND the mean squared slope over each pixel
 * footprint: their difference is the slope variance of waves too small to resolve (LEAN mapping).
 */
let _waveTexture = null;

// In-place 2D inverse FFT (unnormalised, n = power of two) on separate real / imaginary arrays
function fft2DInverse(re, im, n) {
  const ar = new Float64Array(n);
  const ai = new Float64Array(n);
  const fft1D = () => {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = ar[i]; ar[i] = ar[j]; ar[j] = t;
        t = ai[i]; ai[i] = ai[j]; ai[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const wr = Math.cos((2 * Math.PI) / len);
      const wi = Math.sin((2 * Math.PI) / len);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k;
          const b = a + half;
          const tr = ar[b] * cr - ai[b] * ci;
          const ti = ar[b] * ci + ai[b] * cr;
          ar[b] = ar[a] - tr; ai[b] = ai[a] - ti;
          ar[a] += tr; ai[a] += ti;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  };
  for (let pass = 0; pass < 2; pass++) { // rows, then columns
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; ar[c] = re[idx]; ai[c] = im[idx]; }
      fft1D();
      for (let c = 0; c < n; c++) { const idx = pass === 0 ? r * n + c : c * n + r; re[idx] = ar[c]; im[idx] = ai[c]; }
    }
  }
}

function waveTexture() {
  if (_waveTexture) return _waveTexture;
  const N = 256;
  const size = N * N;
  let seed = 0x2f6b9d1;
  const rand = () => { // mulberry32
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gRe = new Float64Array(size);
  const gIm = new Float64Array(size);
  for (let i = 0; i < size; i++) { // complex Gaussian white noise (Box-Muller)
    const r = Math.sqrt(-2 * Math.log(Math.max(rand(), 1e-9)));
    const a = 2 * Math.PI * rand();
    gRe[i] = r * Math.cos(a);
    gIm[i] = r * Math.sin(a);
  }

  const sRe = new Float64Array(size); // slope field packed as dh/du + i dh/dv
  const sIm = new Float64Array(size);
  const hRe = new Float64Array(size); // height field
  const hIm = new Float64Array(size);
  const kPeak = 5.0; // spectral peak (cycles per tile)
  const kCut = 56.0; // soft high cut, well inside Nyquist so slopes stay resolved at mip 0
  const windU = Math.cos(0.3);
  const windV = Math.sin(0.3);
  for (let y = 0; y < N; y++) {
    const ky = y < N / 2 ? y : y - N;
    for (let x = 0; x < N; x++) {
      const kx = x < N / 2 ? x : x - N;
      const k = Math.hypot(kx, ky);
      if (k < 1 || k > N / 2 - 2) continue;
      const c = (kx * windU + ky * windV) / k;
      const spread = 0.22 + c * c; // mostly along the wind axis, with some cross-sea
      const amp = Math.sqrt(spread * Math.exp(-1.25 * (kPeak / k) ** 2 - (k / kCut) ** 2)) / (k * k);
      const i = y * N + x;
      const m = ((N - y) % N) * N + ((N - x) % N); // index of -k: H(-k) = conj(H(k)) keeps both fields real
      const aRe = (gRe[i] + gRe[m]) * amp;
      const aIm = (gIm[i] - gIm[m]) * amp;
      hRe[i] = aRe;
      hIm[i] = aIm;
      sRe[i] = -kx * aIm - ky * aRe; // FFT⁻¹(i·kx·H − ky·H) = dh/du + i·dh/dv (up to 2π, normalised below)
      sIm[i] = kx * aRe - ky * aIm;
    }
  }
  fft2DInverse(sRe, sIm, N);
  fft2DInverse(hRe, hIm, N);

  let s2 = 0;
  let h2 = 0;
  for (let i = 0; i < size; i++) {
    s2 += sRe[i] * sRe[i] + sIm[i] * sIm[i];
    h2 += hRe[i] * hRe[i];
  }
  const sNorm = 1 / Math.sqrt(s2 / size);
  const hNorm = 1 / Math.sqrt(h2 / size);

  let w = N;
  let level = new Float32Array(size * 4);
  for (let i = 0; i < size; i++) {
    const sx = sRe[i] * sNorm;
    const sy = sIm[i] * sNorm;
    level[i * 4] = sx;
    level[i * 4 + 1] = sy;
    level[i * 4 + 2] = sx * sx + sy * sy;
    level[i * 4 + 3] = hRe[i] * hNorm;
  }
  const toHalf = THREE.DataUtils.toHalfFloat;
  const mipmaps = [];
  for (;;) {
    const data = new Uint16Array(level.length);
    for (let i = 0; i < level.length; i++) data[i] = toHalf(level[i]);
    mipmaps.push({ data, width: w, height: w });
    if (w === 1) break;
    const h = w >> 1;
    const next = new Float32Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        for (let c = 0; c < 4; c++) {
          const a = (2 * y * w + 2 * x) * 4 + c;
          next[(y * h + x) * 4 + c] = 0.25 * (level[a] + level[a + 4] + level[a + w * 4] + level[a + w * 4 + 4]);
        }
      }
    }
    level = next;
    w = h;
  }

  const tex = new THREE.DataTexture(mipmaps[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mipmaps;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  _waveTexture = tex;
  return tex;
}

// Fast deterministic 2D hash & smooth value noise (hash2D & noise2D in js/tsl-materials.js)
const hash2D = Fn(([q]) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453)));
const noise2D = Fn(([q]) => {
  const pv = vec2(q).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// --- Water fields (exposure, river, flow) -----------------------------------------------------------------------------

async function loadFields() {
  try {
    const res = await fetch(FIELDS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const img = await decodePNGOffThread(await res.arrayBuffer());
    if (img.channels !== 4) throw new Error(`${img.channels} channels`);
    const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  } catch (e) {
    // open sea everywhere: the water still renders, only without sheltered bays & river current
    console.warn(`[water] ${FIELDS_URL}: ${e.message}`);
    const tex = new THREE.DataTexture(new Uint8Array([255, 0, 128, 128]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.needsUpdate = true;
    return tex;
  }
}

// --- Harbour --------------------------------------------------------------------------------------------------------

// The harbour on a 2 m grid over its water, two fields 0..1: inside (0 outside the moles, 1 once SHELTER_IN m past the
// mouth's edge: the harbour's own water, its colour and no surf) and shelter (rising on to 1 SHELTER_RUN m past it: how
// far the swell has died down), both blurred so no outline shows on the water. Plain arrays so it can run in Node.
// harbour: { ring: [x, z, ...] (the water inside the moles, over their crests), mouth: [x, z, width] }.
const HARBOUR_RES = 2; // m
const SHELTER_IN = 20, SHELTER_RUN = 70; // m
export function harbourShelter(harbour) {
  const { ring, mouth: [mx, mz, mw] } = harbour;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  const x0 = minX - 8, z0 = minZ - 8, w = Math.ceil((maxX - minX + 16) / HARBOUR_RES), h = Math.ceil((maxZ - minZ + 16) / HARBOUR_RES);
  const inside = (x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      if ((ring[i + 1] > z) !== (ring[j + 1] > z) && x < ((ring[j] - ring[i]) * (z - ring[i + 1])) / (ring[j + 1] - ring[i + 1]) + ring[i]) c = !c;
    }
    return c;
  };
  const smooth = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
  let fields = [new Float32Array(w * h), new Float32Array(w * h)];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const x = x0 + (i + 0.5) * HARBOUR_RES, z = z0 + (j + 0.5) * HARBOUR_RES;
    if (!inside(x, z)) continue;
    const d = Math.hypot(x - mx, z - mz) - mw / 2;
    fields[0][j * w + i] = smooth(d / SHELTER_IN);
    fields[1][j * w + i] = smooth(d / SHELTER_RUN);
  }
  // two 5 x 5 box passes
  fields = fields.map((a) => {
    for (let pass = 0; pass < 2; pass++) {
      const b = new Float32Array(w * h);
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        let sum = 0, n = 0;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ii = i + di, jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= w || jj >= h) continue;
          sum += a[jj * w + ii];
          n++;
        }
        b[j * w + i] = sum / n;
      }
      a = b;
    }
    return a;
  });
  const data = new Uint8Array(w * h * 2);
  for (let k = 0; k < w * h; k++) {
    data[2 * k] = Math.round(fields[0][k] * 255);
    data[2 * k + 1] = Math.round(fields[1][k] * 255);
  }
  return { x0, z0, w, h, res: HARBOUR_RES, data };
}

function harbourTexture() {
  if (!MARINA?.harbour) return null;
  const m = harbourShelter(MARINA.harbour);
  const tex = new THREE.DataTexture(m.data, m.w, m.h, THREE.RGFormat, THREE.UnsignedByteType);
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return { tex, x0: m.x0, z0: m.z0, width: m.w * m.res, depth: m.h * m.res };
}

// --- Material ---------------------------------------------------------------------------------------------------------

// vec3(the floor's bilinear height, the lowest and the highest of the four samples around): at a quay or sea wall the
// terrain steps from the promenade to the bed between two samples, where the bilinear floor would rise to the surface
// and draw a beach's shallows and swash against the wall (js/donostia/shore-walls.js)
function floorHeights(field) {
  const size = vec2(field.w, field.h);
  const uv = positionWorld.xz.sub(vec2(field.x0, field.z0)).div(vec2(field.width, field.depth));
  const base = floor(uv.mul(size).sub(0.5)).add(0.5);
  const at = (a, b) => texture(field.heightTexture, base.add(vec2(a, b)).div(size)).r;
  const s00 = at(0, 0), s10 = at(1, 0), s01 = at(0, 1), s11 = at(1, 1);
  return vec3(texture(field.heightTexture, uv).r, min(min(s00, s10), min(s01, s11)), max(max(s00, s10), max(s01, s11)));
}

// [tile size (m), rotation (rad), RMS slope]: incommensurate scales & angles so no pattern repeats (as upstream)
const LAYERS = [
  [61.0, 0.0, 0.052],
  [23.3, 1.93, 0.06],
  [8.7, 4.07, 0.064],
  [3.3, 2.71, 0.064]
];
const FLOW_PERIOD = 3.0; // s between flow-map resets (two phases cross-fade so the jump never shows)
// Live: each layer turned round the wind's direction by this much (rad), the shorter waves spread wider
const LAYER_SPREAD = [0.0, 0.3, -0.42, 0.75];
// Live: the open sea's swell as three long-crested trains, [turn (rad) from the swell's direction, period (times the
// swell's), height (times half the swell's), phase (rad)]: their beat gathers the crests into sets
const SWELL_TRAINS = [
  [0.0, 1.0, 0.62, 0.0],
  [0.13, 0.91, 0.36, 2.1],
  [-0.09, 1.1, 0.3, 4.4]
];
// The texture's waves run along +(cos, sin)(0.3) in its own coordinates: a layer turned by rot moves them along
// world angle 0.3 - rot + π (x towards z)
const TEXTURE_AXIS = 0.3;

// The live sea's uniforms (createWater's update sets them): the fixed sea's values with the switch off
function seaStateUniforms() {
  const v2 = (a) => new THREE.Vector2(Math.cos(a), Math.sin(a));
  return {
    surf: uniform(FIXED_SEA.surf), periodA: uniform(FIXED_SEA.surfPeriodA), periodB: uniform(FIXED_SEA.surfPeriodB),
    chop: uniform(FIXED_SEA.chop), calm: uniform(FIXED_SEA.calm), whitecaps: uniform(FIXED_SEA.whitecaps),
    // per layer, its turn as (cos, sin): its own fixed angle, or round the wind's direction
    turns: LAYERS.map(([, rot]) => uniform(v2(rot))),
    // the swell's height (m) and, per train, (direction of travel x, z; wavenumber, rad/m; angular frequency, rad/s)
    swell: uniform(FIXED_SEA.swell),
    trains: SWELL_TRAINS.map(() => uniform(new THREE.Vector4(1, 0, 0.04, 0.6))),
    // the whitecaps' drift downwind (m/s)
    windDrift: uniform(new THREE.Vector2(0, 0))
  };
}

// Sets the uniforms from a sea state (sea-state.js FIXED_SEA's keys; chopFrom null: the layers' own angles)
function applySeaState(S, s) {
  S.surf.value = s.surf;
  S.periodA.value = s.surfPeriodA;
  S.periodB.value = s.surfPeriodB;
  S.chop.value = s.chop;
  S.calm.value = s.calm;
  S.whitecaps.value = s.whitecaps;
  S.swell.value = s.swell;
  // directions of travel (x east, z south) from where the wind & the swell come from
  const travel = (from) => Math.atan2(Math.cos((from * Math.PI) / 180), -Math.sin((from * Math.PI) / 180));
  const wind = s.chopFrom == null ? null : travel(s.chopFrom);
  LAYERS.forEach(([, rot], i) => {
    const a = wind == null ? rot : TEXTURE_AXIS + Math.PI - wind + LAYER_SPREAD[i];
    S.turns[i].value.set(Math.cos(a), Math.sin(a));
  });
  if (wind != null) S.windDrift.value.set(Math.cos(wind), Math.sin(wind)).multiplyScalar(0.6 + 0.15 * (s.windSpeed ?? 3));
  const swell = travel(s.swellFrom);
  SWELL_TRAINS.forEach(([turn, tf], i) => {
    const T = s.swellPeriod * tf;
    S.trains[i].value.set(Math.cos(swell + turn), Math.sin(swell + turn), (2 * Math.PI) / wavelength(T), (2 * Math.PI) / T);
  });
}

function createWaterMaterial(terrain, fieldsTex) {
  const { core, context } = terrain;
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.25 });
  const S = seaStateUniforms();
  mat.userData.seaState = S;
  const waveTex = waveTexture();
  const p = positionWorld;

  const inCore = p.x.greaterThan(core.x0 + core.res).and(p.x.lessThan(core.x0 + core.width - core.res))
    .and(p.z.greaterThan(core.z0 + core.res)).and(p.z.lessThan(core.z0 + core.depth - core.res));
  const inContext = p.x.greaterThan(context.x0).and(p.x.lessThan(context.x0 + context.width))
    .and(p.z.greaterThan(context.z0)).and(p.z.lessThan(context.z0 + context.depth));
  const floors = select(inCore, floorHeights(core), select(inContext, floorHeights(context), vec3(-60.0))).toVar();
  // against a wall (a step of metres between neighbouring samples) the water keeps the depth of the bed at its foot
  const walled = smoothstep(2.0, 4.0, floors.z.sub(floors.y)).toVar();
  const seaFloor = mix(floors.x, floors.y, walled).toVar();
  // the plane rides the tide and the ponds sit at their own levels: depth is measured from the surface itself
  const depth = max(p.y.sub(seaFloor), 0.0);

  // Water fields: exposure to the swell, river (0 sea .. 1 river / pond), seaward flow (m/s)
  const fieldUV = p.xz.sub(vec2(context.x0, context.z0)).div(vec2(context.width, context.depth));
  const fields = texture(fieldsTex, fieldUV);
  const river = select(inContext, fields.g, float(0.0));
  const surf = select(inContext, fields.r, float(1.0)).mul(float(1.0).sub(river));
  const flow = select(inContext, fields.ba.mul(255.0 / 127.0).sub(128.0 / 127.0), vec2(0.0, 0.0));
  // the harbour: inside its moles (0 open water .. 1 the harbour's own water) and sheltered from the swell (.. 1 deep
  // inside the port)
  const hb = harbourTexture();
  const inHarbour = hb
    ? select(p.x.greaterThan(hb.x0).and(p.x.lessThan(hb.x0 + hb.width)).and(p.z.greaterThan(hb.z0)).and(p.z.lessThan(hb.z0 + hb.depth)),
      texture(hb.tex, p.xz.sub(vec2(hb.x0, hb.z0)).div(vec2(hb.width, hb.depth))).rg, vec2(0.0)).toVar()
    : vec2(0.0);
  const harbour = inHarbour.x, sheltered = inHarbour.y;

  // vec4(mean slope x, mean slope z, unresolved slope variance, crest height)
  const waves = Fn(() => {
    const q = p.xz;
    const t = time;

    // Wind patches drifting with the breeze: large-scale wave energy that reads from the air and hides tiling
    const gustA = noise2D(q.mul(0.0047).add(vec2(t.mul(0.011), t.mul(-0.007))));
    const gustB = noise2D(q.mul(0.0135).add(vec2(t.mul(-0.009), t.mul(0.013))).add(31.7));
    const gust = smoothstep(0.18, 0.82, gustA.mul(0.62).add(gustB.mul(0.38)));
    // the open sea choppiest, La Concha & the port calmer, the river & the ponds calmest; live, as much as the wind
    // raises, and the bay glassy in a calm
    const shelter = mix(mix(float(0.5), float(1.25), surf), float(0.3), river);
    const energy = mix(float(0.55), float(1.25), gust).mul(shelter).mul(mix(float(1.0), float(0.28), sheltered))
      .mul(S.chop).mul(float(1.0).sub(S.calm.mul(float(1.0).sub(surf)).mul(0.75))).toVar();

    // The river carries the two short layers seaward: two flow-map phases half a period apart, each faded out as it
    // resets
    const phase = fract(t.div(FLOW_PERIOD)).toVar();
    const offA = flow.mul(phase.mul(FLOW_PERIOD));
    const offB = flow.mul(fract(phase.add(0.5)).mul(FLOW_PERIOD));
    const weightA = float(1.0).sub(abs(phase.mul(2.0).sub(1.0)));

    const slope = vec2(0.0, 0.0).toVar();
    const variance = energy.mul(energy).mul(0.0022).toVar(); // capillary ripples, always below a pixel
    const crest = float(0.0).toVar();
    LAYERS.forEach(([L, , sigma], i) => {
      // (the layer's turn: its own angle, or live round the wind's direction)
      const c = S.turns[i].x;
      const s = S.turns[i].y;
      const speed = (0.8 * Math.sqrt(L / 9)) / L; // ~phase speed of the tile's dominant waves, in tiles per second
      const drift = vec2(Math.cos(TEXTURE_AXIS) * speed, Math.sin(TEXTURE_AXIS) * speed).mul(t);
      const layerUV = (at) => vec2(at.x.mul(c).sub(at.y.mul(s)), at.x.mul(s).add(at.y.mul(c))).div(L).add(drift);
      const smp = L < 10
        ? mix(texture(waveTex, layerUV(q.sub(offB))), texture(waveTex, layerUV(q.sub(offA))), weightA)
        : texture(waveTex, layerUV(q));
      const amp = energy.mul(sigma);
      slope.addAssign(vec2(smp.x.mul(c).add(smp.y.mul(s)), smp.y.mul(c).sub(smp.x.mul(s))).mul(amp));
      variance.addAssign(max(smp.z.sub(dot(smp.xy, smp.xy)), 0.0).mul(amp.mul(amp)));
      crest.addAssign(smp.w.mul(sigma));
    });

    // Live: the open sea's swell, long crests running in from its direction in sets, fading into the bay (what
    // rounds Santa Klara is the breakers' business) and gone in the port
    If(S.swell.greaterThan(0.0), () => {
      const reach = mix(float(0.12), float(1.0), surf).mul(float(1.0).sub(sheltered.mul(0.95))).mul(float(1.0).sub(river))
        .mul(S.swell).mul(0.5);
      const sets = noise2D(q.mul(0.0021).add(vec2(t.mul(0.004), t.mul(-0.003)))).mul(0.9).add(0.55);
      SWELL_TRAINS.forEach(([, , weight, phase0], i) => {
        const tr = S.trains[i];
        const ph = dot(tr.xy, q).mul(tr.z).sub(tr.w.mul(t)).add(phase0);
        slope.addAssign(tr.xy.mul(tr.z.mul(cos(ph)).mul(reach.mul(sets).mul(weight))));
      });
    });
    return vec4(slope, variance, crest.mul(4.0));
  })();

  // Surf: breaker lines along the depth contours. Shoaling waves keep their period T while slowing to sqrt(g h), so on
  // a beach of slope s the crests sit at equal steps of 2 sqrt(h) / (s T sqrt(g)) (s = 1:40 here); they travel
  // shoreward, break once the depth falls below ~1.3 times the breaker height and leave foam trailing seaward. Live,
  // the breakers scale with the swell (S.surf: 1 the swell they were drawn for) and keep its period; a big swell
  // breaks all along the shore and trails its foam further.
  const foam = Fn(() => {
    // m: ~1 m on Zurriola, ~0.3 m in La Concha, a ripple in the port
    const breaker = surf.mul(1.5).add(0.12).mul(S.surf).toVar();
    const period = mix(S.periodA, S.periodB, surf);
    const big = smoothstep(1.5, 3.0, S.surf).toVar();
    const breakDepth = breaker.mul(1.3);
    const warp = noise2D(p.xz.mul(0.011)).sub(0.5).mul(0.9).add(noise2D(p.xz.mul(0.043).add(5.2)).sub(0.5).mul(0.35));
    const crestPhase = sqrt(depth).mul(25.5).div(period).add(warp).add(time.div(period)).toVar();
    const u = fract(crestPhase);
    const aa = smoothstep(0.25, 0.7, fwidth(crestPhase)).toVar();
    // a white line at each crest, crisp on its shoreward side, and the foam it leaves behind fading seaward; once the
    // lines crowd below a pixel (steep rock, quay walls, distance) only their pulsing average remains
    const line = max(exp(u.mul(-22.0)), smoothstep(0.965, 1.0, u)).add(exp(u.mul(float(-3.2).div(big.add(1.0)))).mul(big.mul(0.3).add(0.45)));
    const pulse = sin(time.mul(6.2832).div(period).add(warp.mul(6.0))).mul(0.25).add(0.4);
    const pattern = mix(line, pulse, aa);
    const breaking = smoothstep(breakDepth, breakDepth.mul(0.45), depth);
    // crests break in sections that come and go along the shore
    const sections = smoothstep(float(0.2).sub(big.mul(0.25)), float(0.65).sub(big.mul(0.35)),
      noise2D(p.xz.mul(0.03).add(vec2(time.mul(0.031), time.mul(-0.017)))));
    const surfFoam = pattern.mul(breaking).mul(sections.mul(0.65).add(0.35));
    // swash: the thin sheet of foam running up & back at the water's edge
    const runup = sin(time.mul(6.2832).div(period).add(warp.mul(5.0))).mul(0.5).add(0.5);
    const swashDepth = breaker.mul(0.07).add(0.03).mul(runup.mul(0.8).add(0.4));
    const swash = exp(depth.div(swashDepth).negate()).mul(float(0.85).mul(float(1.0).sub(river)));
    const density = clamp(max(surfFoam, swash), 0.0, 1.0).mul(float(1.0).sub(harbour)).toVar();

    // Live: whitecaps on the open water from a fresh breeze: patches drawn out downwind that break, drift and fade
    // within seconds, a light sheen of their share once they shrink below a few pixels; fewer where the bay's fetch is
    // short, none in the port or the river (a uniform branch: derivatives are allowed in it)
    If(S.whitecaps.greaterThan(0.0), () => {
      const wind = S.windDrift.div(max(S.windDrift.length(), 0.001));
      const rel = p.xz.sub(S.windDrift.mul(time));
      const w2 = vec2(dot(rel, wind).mul(0.5), dot(rel, vec2(wind.y.negate(), wind.x)));
      const n = mx_noise_float(vec3(w2.mul(0.2), time.mul(0.3))).add(noise2D(w2.mul(1.1)).sub(0.5).mul(0.3));
      const threshold = float(0.6).sub(S.whitecaps.mul(0.28));
      const local = float(1.0).sub(harbour).mul(float(1.0).sub(river)).mul(mix(float(0.35), float(1.0), surf));
      // (a cap is densest at its breaking front, downwind, and thins out behind)
      const near = smoothstep(threshold, threshold.add(0.12), n).mul(smoothstep(threshold.add(0.4), threshold.add(0.1), n).mul(0.35).add(0.35));
      const share = S.whitecaps.mul(0.1);
      const far = smoothstep(0.4, 3.0, fwidth(p.x).add(fwidth(p.z)));
      density.assign(max(density, mix(near, share, far).mul(local)));
    });

    // Lace: foam breaks up into a web of bubbles and holes, densest at the crest. The noise only runs near the shore
    // (no derivatives or texture reads inside the branch, so it stays legal in non-uniform control flow)
    const detail = smoothstep(1.2, 0.35, fwidth(p.x).add(fwidth(p.z))).toVar();
    const result = density.mul(0.75).toVar();
    If(density.greaterThan(0.002), () => {
      const n1 = mx_noise_float(vec3(p.x.mul(0.55), p.z.mul(0.55), time.mul(0.35)));
      const n2 = mx_noise_float(vec3(p.x.mul(1.9), p.z.mul(1.9), time.mul(0.6)));
      const lace = n1.mul(0.3).add(n2.mul(0.2)).add(0.5);
      const laced = smoothstep(float(1.0).sub(density), float(1.25).sub(density), lace);
      result.assign(mix(density.mul(0.75), laced, detail));
    });
    return result;
  })();

  // Waves flatten under the foam
  const slope = waves.xy;
  const variance = waves.z;
  const rippled = normalize(vec3(slope.x.negate(), 1.0, slope.y.negate()));
  const waterNormal = normalize(mix(rippled, vec3(0.0, 1.0, 0.0), foam.mul(0.8)));
  mat.normalNode = cameraViewMatrix.transformDirection(waterNormal);

  // GGX alpha ≈ RMS slope of the unresolved waves (Beckmann m), roughness = sqrt(alpha); foam is matte
  mat.roughnessNode = mix(clamp(pow(variance, 0.25), 0.07, 0.65), float(0.6), foam);

  // Metalness carries the water's Fresnel (F0 = 0.02): it hands the transmitted share to the body colour and weights
  // the pipeline's SSR (as upstream)
  const viewDir = normalize(cameraPosition.sub(p));
  const fresnel = pow(float(1.0).sub(clamp(dot(waterNormal, viewDir), 0.0, 1.0)), 5.0).mul(0.98).add(0.02);
  mat.metalnessNode = clamp(fresnel.mul(1.6), 0.0, 0.9).mul(float(1.0).sub(foam));

  mat.colorNode = Fn(() => {
    // (the harbour's water as deep as its dredged basins, not the LiDAR's shallow bed)
    const d = max(depth, harbour.mul(6.0));
    // sand seen through a few centimetres of water at the edge, turquoise over the sand, blue-green to deep blue
    const c = mix(vec3(0.27, 0.30, 0.22), vec3(0.04, 0.27, 0.25), smoothstep(0.0, 1.2, d)).toVar();
    c.assign(mix(c, vec3(0.018, 0.115, 0.145), smoothstep(1.5, 7.0, d)));
    c.assign(mix(c, vec3(0.008, 0.042, 0.075), smoothstep(7.0, 20.0, d)));
    c.assign(mix(c, vec3(0.005, 0.026, 0.055), smoothstep(20.0, 45.0, d)));
    // over rock (a steep bottom) the shallows stay dark & weedy instead of turquoise; not against a wall (nor a pixel
    // beside it), where the bilinear floor's steepness is the wall's: it drew the 2 m cells along the Pico del Loro's
    // wall as dark squares
    const rocky = smoothstep(0.12, 0.4, fwidth(floors.x).div(max(fwidth(p.x).add(fwidth(p.z)), 0.02)))
      .mul(float(1.0).sub(clamp(walled.add(fwidth(walled)), 0.0, 1.0)));
    c.assign(mix(c, mix(vec3(0.035, 0.07, 0.05), c, smoothstep(1.0, 6.0, d)), rocky.mul(float(1.0).sub(river))));
    // the Urumea & the ponds: green, silty, the bed lost within a metre
    const silt = noise2D(p.xz.mul(0.006).add(7.3));
    const greenWater = mix(vec3(0.05, 0.08, 0.045), vec3(0.03, 0.055, 0.035), smoothstep(0.3, 2.5, d)).mul(silt.mul(0.3).add(0.85));
    c.assign(mix(c, greenWater, river));
    // the harbour: greener and murkier
    c.assign(mix(c, vec3(0.016, 0.05, 0.04), harbour.mul(0.65)));
    // thin sunlit crests transmit a greener tint (upstream)
    const crestTint = smoothstep(0.6, 2.4, waves.w).mul(0.3).add(1.0);
    return mix(c.mul(crestTint), vec3(0.78, 0.81, 0.8), foam);
  })();

  return mat;
}

// --- Ponds --------------------------------------------------------------------------------------------------------------

// Surfaces of the ponds, fountains & the upland streams: class-water cells well above sea level that don't touch the
// sea or the river, grouped into 4-connected patches. Each patch is a grid of its cells whose corners sit at the mean
// surveyed surface of the cells around them (flat on a pond, following the slope of a stream). skip(x, z) drops cells
// (the context grid under the core). Returns { positions, indices } or null; plain arrays so it can run in Node.
export function pondSurfaces(field, skip = null) {
  const { w, h, res, x0, z0, heights, classes } = field;
  const isPond = (k) => classes[k] === WATER_CLASS && heights[k] > POND_MIN;
  const label = new Int32Array(w * h).fill(-1);
  const keep = [];
  const stack = [];
  for (let k0 = 0; k0 < w * h; k0++) {
    if (label[k0] >= 0 || !isPond(k0)) continue;
    const id = keep.length;
    let touchesSea = false, cells = 1;
    label[k0] = id;
    stack.push(k0);
    while (stack.length) {
      const k = stack.pop(), i = k % w;
      const next = [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k >= w ? k - w : -1, k + w < w * h ? k + w : -1];
      for (const n of next) {
        if (n < 0) continue;
        if (isPond(n)) {
          if (label[n] < 0) { label[n] = id; stack.push(n); cells++; }
        } else if (classes[n] === WATER_CLASS) touchesSea = true;
      }
    }
    keep.push(!touchesSea && cells >= 4); // single stray cells are shore cells half on a quay
  }
  const corner = new Map(); // corner index -> vertex
  const positions = [];
  const indices = [];
  const vertex = (ci, cj) => {
    const key = cj * (w + 1) + ci;
    let v = corner.get(key);
    if (v !== undefined) return v;
    let sum = 0, n = 0;
    for (const [a, b] of [[-1, -1], [0, -1], [-1, 0], [0, 0]]) {
      const i = ci + a, j = cj + b;
      if (i < 0 || j < 0 || i >= w || j >= h) continue;
      const k = j * w + i;
      if (label[k] >= 0 && keep[label[k]]) { sum += heights[k] + POND_SINK; n++; }
    }
    v = positions.length / 3;
    positions.push(x0 + ci * res, sum / n, z0 + cj * res);
    corner.set(key, v);
    return v;
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (label[k] < 0 || !keep[label[k]]) continue;
      if (skip && skip(x0 + (i + 0.5) * res, z0 + (j + 0.5) * res)) continue;
      const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
      indices.push(a, c, b, b, c, d);
    }
  }
  return indices.length ? { positions, indices } : null;
}

function pondMesh(terrain, material) {
  const { core, context } = terrain;
  const inCore = (x, z) => x > core.x0 && x < core.x0 + core.width && z > core.z0 && z < core.z0 + core.depth;
  const parts = [pondSurfaces(core), pondSurfaces(context, inCore)].filter(Boolean);
  if (!parts.length) return null;
  const positions = [], indices = [];
  for (const part of parts) {
    const base = positions.length / 3;
    positions.push(...part.positions);
    for (const i of part.indices) indices.push(base + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  const normals = new Float32Array(positions.length);
  for (let k = 1; k < normals.length; k += 3) normals[k] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'DonostiaPonds';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// --- Builder ------------------------------------------------------------------------------------------------------------

export async function createWater(terrain) {
  const material = createWaterMaterial(terrain, await loadFields());

  const geo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const sea = new THREE.Mesh(geo, material);
  sea.name = 'DonostiaSea';
  sea.receiveShadow = true;
  sea.matrixAutoUpdate = false;

  const group = new THREE.Group();
  group.name = 'DonostiaWater';
  group.add(sea);
  const ponds = pondMesh(terrain, material);
  if (ponds) group.add(ponds);

  // Tide: Donostia's mean range is ~2.8 m (4.5 m at springs); a 1.6 m amplitude sits between the two
  const tide = { enabled: false, level: 0, amplitude: 1.6, period: 720 };
  let seaLevel = 0, tideTime = 0;
  const { uSeaLevel, uTideMark, uTideLive } = seaUniforms;
  const setSeaLevel = (y) => {
    seaLevel = y;
    uSeaLevel.value = y;
    sea.position.y = y;
    sea.updateMatrix();
  };
  group.userData.tide = tide;
  group.userData.seaLevel = uSeaLevel;
  group.userData.getSeaLevel = () => seaLevel;

  // Real time: the live sea (sea-state.js seaParams of the live snapshot, read four times a second) eased towards
  // over SEA_EASE s, and the whole of it blended in from the fixed sea over BLEND s as the switch goes on (and back out
  // as it goes off, after which nothing runs). The tide's level and the bands' mark follow the snapshot directly.
  const S = material.userData.seaState;
  const live = { ...FIXED_SEA, windSpeed: 3 }, shown = { ...FIXED_SEA };
  let blend = 0, target = null, readAt = 0, clock = 0;
  const SEA_EASE = 4, BLEND = 1.5, READ = 0.25;
  const EASED = ['surf', 'surfPeriodA', 'surfPeriodB', 'swell', 'swellPeriod', 'chop', 'calm', 'whitecaps', 'spray', 'windSpeed'];
  group.userData.seaState = () => ({ ...shown, blend });
  group.userData.update = (dt) => {
    let y = tide.level;
    if (tide.enabled) {
      tideTime += dt;
      y += tide.amplitude * Math.sin((2 * Math.PI * tideTime) / tide.period);
    }
    let mark = y;
    const on = liveEnabled();
    if (on || blend > 0) {
      clock += dt;
      if (on && (!target || clock - readAt >= READ)) {
        const first = !target;
        target = seaParams(liveSnapshot());
        readAt = clock;
        if (first && blend === 0) Object.assign(live, target);
      }
      const k = 1 - Math.exp(-dt / SEA_EASE);
      for (const key of EASED) live[key] += (target[key] - live[key]) * k;
      Object.assign(live, { level: target.level, mark: target.mark, chopFrom: target.chopFrom, swellFrom: target.swellFrom });
      blend = Math.min(1, Math.max(0, blend + (on ? dt : -dt) / BLEND));
      const b = blend * blend * (3 - 2 * blend);
      for (const key of [...EASED, 'level', 'mark']) shown[key] = (FIXED_SEA[key] ?? 0) + ((live[key] ?? 0) - (FIXED_SEA[key] ?? 0)) * b;
      shown.level = y + (live.level - y) * b;
      shown.mark = y + (live.mark - y) * b;
      shown.chopFrom = blend > 0 ? live.chopFrom : null;
      shown.swellFrom = live.swellFrom;
      if (blend === 0) {
        // back to the fixed sea, exactly
        Object.assign(shown, FIXED_SEA);
        target = null;
        shown.level = y;
        shown.mark = y;
      }
      applySeaState(S, shown);
      uTideLive.value = b;
      y = shown.level;
      mark = shown.mark;
    }
    if (y !== seaLevel) setSeaLevel(y);
    if (mark !== uTideMark.value) uTideMark.value = mark;
  };
  return group;
}
