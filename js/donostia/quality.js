// js/donostia/quality.js
// Slop Donostia's quality settings: named tiers, the tier a device starts at, and a governor that holds the frame rate.
// No three.js in here: the tiers and the decisions are plain data and arithmetic (tests/donostia-quality.test.mjs runs
// them in node); js/donostia/main.js turns the settings into renderer state.
//
// - TIERS: low / medium / high / ultra. `ultra` is the desktop picture as it has always been (pixel ratio 1, 4x MSAA,
//   3072 px shadow cascades, SSR, bloom, every level of detail at its full reach) and never adapts; the other three are
//   for phones and tablets, where the frame is bound first by the pixels shaded (the drawing buffer of a 3x phone
//   screen is 2.5 times a desktop window's), then by the triangles (4 million a frame on ultra, 1.4 of them in the
//   shadow maps) and by memory (the GPU process and the page share the device's RAM, and iOS kills the tab that takes
//   too much: ultra holds 590 MB on the GPU, 250 MB of JS heap, 200 of it three's shader graphs with shadows on, and
//   380 MB of typed arrays; low 340, 40 and 215).
// - A tier's settings are of two kinds. The live ones change in a running city for the cost of a frame or two: the
//   render resolution, the shadow map's size & reach and what casts into it, SSR and bloom (another render pipeline of the same scene pass),
//   the trees' and the terrain's levels of detail, the props' draw distance, the rain's drops, the sea's spray, how often
//   the environment map is baked. The structural ones are built into the pipelines, the meshes and the textures (MSAA,
//   shadows at all, the MRT targets SSR reads, the baked ground maps, the terrain's mesh, the CPU copies of the
//   geometry). Those change in a running city too, but not for free: main.js rebuilds the render passes, the ground
//   and the terrain as needed and compiles the shaders again, the first view behind an "applying" note and the rest
//   in the background (a second or two on a desktop, longer on a phone). So a tier picked by hand applies whole
//   (state.boot is the structural part in effect), while the governor, which may step several times a minute, only
//   ever moves the live ones. Nothing takes a reload: state.needsReload is always false, kept for the HUD that read it.
// - detectTier(env): the tier a device starts at, from what the browser tells (the WebGPU adapter's vendor and
//   architecture, navigator.deviceMemory, hardwareConcurrency, a coarse pointer, the screen). A desktop gets ultra, as
//   before; a phone or tablet starts at medium unless it is known strong (high) or looks weak (low): unknown devices
//   start low rather than high, and the governor lifts what the frame rate allows.
// - Governor: watches the frame time in one-second windows. Under the target for two of them, it lowers the render
//   scale a step, and at the tier's floor the tier itself (its live settings); with the target held for a while it
//   tries a step up, and backs off twice as long after every try that failed, so it settles instead of pumping. With
//   vsync the frame time says nothing about headroom, hence the tries. A frame rate that does not move while the
//   resolution goes all the way down to the tier's floor is not the GPU's doing (iOS's Low Power Mode holds pages at
//   30 fps; the CPU may be the limit): the governor gives the resolution back and takes that rate for its target.
// - quality: the page's controller (a singleton), for main.js and for the HUD. See createQuality() for its API.
//   ?quality=<tier|auto> in the URL picks for this visit; quality.set() remembers the user's choice (localStorage);
//   on auto, the tier the governor settled at is remembered too, so the next visit boots with that tier's boot settings.
// - Auto's memory (localStorage AUTO_KEY) holds what auto itself found out, and nothing else: the tier its governor
//   settled at (written once it has held a tier for SETTLED windows, so a visit that ends early leaves nothing), a
//   tier it could not hold from a cold start (not booted again for a week: `why: 'governor'`), and the caps of real
//   failures (a lost GPU device, a visit that died: `why: 'gpu_lost' | 'crash'`). A pick by hand, ?quality= and a
//   tier applied in the running city write nothing into it, and picking Auto in the settings starts auto afresh from
//   the detected tier: only a failure's cap outlives that. main.js does not feed the governor while shaders compile
//   behind the city or a tier is being applied: a phone's browser stalls a frame or more for every pipeline, and
//   that says nothing of what the device can hold (an iPhone 15 Pro, detected medium, had been banned to low for a
//   week by its own start-up). The memory of the versions before that rule is not trusted and is dropped (MEMO_V).
//   state.bootReason says which rule decided the tier this visit booted with ('url', 'stored', 'detected',
//   'remembered', 'crash_recovery'), and quality.debug().decision how, step by step.
// - A phone or tablet never runs ultra unless the URL says so (?quality=ultra, for testing): ultra is the desktop's
//   tier, some 1.2 GB with every shader compiled before the city shows, and an iPhone 15 Pro that had it stored from
//   a test took 32 s to start and then died in the compile step on every load. There the tiers offered
//   (quality.tiers) end at high, a stored pick of ultra is dropped for auto, and every tier starts progressively,
//   ultra by the URL included: the first view's shaders, then the rest behind the city.
// - Recovery: when the last visit died (js/donostia/crash-guard.js tells: the page was killed while it loaded or
//   ran), init({ recovery }) starts this one lighter, on any device: a tier under the one that failed, the lowest
//   after two failures in a row. A stored pick does not override that (the visit runs on auto under that cap), and
//   one that has failed twice is dropped; on a phone the cap is remembered for a week, like a tier the governor
//   found too much. The URL's tier is still obeyed.

export const TIER_NAMES = ['low', 'medium', 'high', 'ultra'];

// treeNear / treeMid: where the trees' full detail and their branch cards end (m; js/donostia/vegetation.js);
// treeBillboards: where the far crowns turn into billboards; treeFar: where the trees end. terrainLod: the reach of
// every level of the terrain's detail (js/donostia/terrain.js lodScale). detailDistance: the draw distance of the
// instanced props (street furniture, the port's fittings, the shore's rocks), times their own. shadowFar: the sun's
// shadow range, times lighting.js's own. terrainShadows / propShadows: whether the ground and the street furniture &
// the bridges' ironwork cast shadows (the buildings, the trees, the landmarks and the shore walls always do): drawn
// into both cascades, they are 0.8 of the 1.4 million triangles the shadow maps take, for the hills' own shade and
// the railings' lace. rain: the share of the drops drawn. envBakeGap: the least time between two
// bakes of the environment map in real time (s). groundMaps: 'full' (the baked 1 m maps: 86 MB on the GPU) or
// 'classes' (the terrain's own 2 m classes: no kerbs, crossings or paving directions, 9.8 MB less to download).
// terrainMesh: 'full' (every 2 m sample of the core) or 'coarse' (every second one in the chunks no shore wall
// crosses, 37 of them: 29 MB less on the GPU; js/donostia/terrain.js).
// releaseGeometry: drop the CPU copies of the terrain's & the buildings' vertex buffers once they are on the GPU.
// maxPixels: the drawing buffer's budget (a tablet's screen has four times a phone's pixels at the same ratio).
// progressive: the city shows once the shaders of the first view are compiled, and the rest compile in the background
// (main.js's createView(): a phone's browser takes most of a minute for all of them); false waits for every visible
// object behind the loading screen, as the desktop always has. On a phone or tablet it is true whatever the tier says
// (the controller's boot settings: see mobileBoot()).
export const TIERS = Object.freeze({
  low: Object.freeze({
    label: 'Low', maxPixelRatio: 1.25, fixedPixelRatio: false, maxPixels: 0.9e6, minScale: 0.68, adaptive: true,
    msaa: false, shadows: false, shadowMapSize: 1024, shadowFar: 0.6, terrainShadows: false, propShadows: false,
    ssr: false, bloom: false, terrainLod: 0.45, treeNear: 40, treeMid: 130, treeBillboards: 350, treeFar: 2200, detailDistance: 0.5,
    rain: 0.35, spray: false, envBakeGap: 2, groundMaps: 'classes', terrainMesh: 'coarse', releaseGeometry: true, progressive: true
  }),
  medium: Object.freeze({
    label: 'Medium', maxPixelRatio: 1.5, fixedPixelRatio: false, maxPixels: 1.3e6, minScale: 0.68, adaptive: true,
    msaa: false, shadows: true, shadowMapSize: 1024, shadowFar: 0.7, terrainShadows: false, propShadows: false,
    ssr: false, bloom: true, terrainLod: 0.6, treeNear: 55, treeMid: 190, treeBillboards: 500, treeFar: 2800, detailDistance: 0.7,
    rain: 0.6, spray: true, envBakeGap: 1, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: true, progressive: true
  }),
  high: Object.freeze({
    label: 'High', maxPixelRatio: 2, fixedPixelRatio: false, maxPixels: 2.2e6, minScale: 0.6, adaptive: true,
    msaa: true, shadows: true, shadowMapSize: 2048, shadowFar: 1, terrainShadows: true, propShadows: true,
    ssr: true, bloom: true, terrainLod: 0.8, treeNear: 70, treeMid: 250, treeBillboards: 700, treeFar: 3400, detailDistance: 0.85,
    rain: 1, spray: true, envBakeGap: 0.4, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: true, progressive: true
  }),
  ultra: Object.freeze({
    label: 'Ultra', maxPixelRatio: 1, fixedPixelRatio: true, maxPixels: Infinity, minScale: 1, adaptive: false,
    msaa: true, shadows: true, shadowMapSize: 3072, shadowFar: 1, terrainShadows: true, propShadows: true,
    ssr: true, bloom: true, terrainLod: 1, treeNear: 85, treeMid: 300, treeBillboards: 900, treeFar: 3400, detailDistance: 1,
    rain: 1, spray: true, envBakeGap: 0.15, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: false, progressive: false
  })
});

export const isTier = (name) => TIER_NAMES.includes(name);
const tierIndex = (name) => TIER_NAMES.indexOf(name);

// What the world's modules read (they must not depend on the controller); main.js sets it from the tier.
// distance: the props' draw distance, times their own (read every frame). mrt: whether the scene pass has the normal &
// metalness targets SSR reads (read as the materials are made: an effect's material may only name them, with its
// mrtNode, where they exist; a quality tier without SSR builds the pass without them).
export const detail = { distance: 1, mrt: true };

// An effect's material (a glow, the rain, a wake) writes nothing into the targets SSR reads, which `node` (an mrt() of
// zeros) says. It may be the material's mrtNode only while the scene pass has those targets, and a quality tier picked
// in a running city adds or drops them: the node stays on the material for main.js to switch (applyWorldStructure()).
export function effectTargets(material, node) {
  material.userData.effectTargets = node;
  material.mrtNode = detail.mrt ? node : null;
  return material;
}

// The baked ground map is 4200 x 5120 texels: a device that cannot hold it (WebGPU's compatibility mode guarantees
// 4096) gets the terrain's classes whatever the tier says
const GROUND_MAP_SIDE = 5120;

/**
 * The boot settings a tier ends up with on this device: its own, less what the device's limits rule out.
 * limits: { maxTextureDimension2D } (the adapter's).
 */
export function bootSettings(tier, limits = null, overrides = null) {
  const s = { ...TIERS[tier], ...overrides };
  const side = limits?.maxTextureDimension2D;
  if (side && side < GROUND_MAP_SIDE) s.groundMaps = 'classes';
  if (side && side < s.shadowMapSize * 2) s.shadowMapSize = Math.max(512, Math.floor(side / 2));
  return s;
}

// The structural settings (see the header): what main.js rebuilds for when a tier is picked in a running city
export const STRUCTURAL = Object.freeze(['msaa', 'shadows', 'ssr', 'groundMaps', 'terrainMesh', 'releaseGeometry', 'progressive']);
export const structural = (settings) => Object.fromEntries(STRUCTURAL.map((key) => [key, settings[key]]));

/**
 * Whether going from the structural settings in effect to `wanted` takes main.js a rebuild (the passes, the ground or
 * the terrain, and the shaders compiled again). SSR alone turns off without one: its targets stay, unread.
 */
export function needsRebuild(current, wanted) {
  return current.msaa !== wanted.msaa || current.shadows !== wanted.shadows || (wanted.ssr && !current.ssr) ||
    current.groundMaps !== wanted.groundMaps || current.terrainMesh !== wanted.terrainMesh;
}

/** Nothing takes a reload any more (every setting applies in the running city): always false, for callers of old. */
export function needsReload() {
  return false;
}

/**
 * The renderer's pixel ratio for a tier: the screen's, up to the tier's cap and its pixel budget, times the governor's
 * scale. ultra's is fixed (1, as the desktop app has always rendered).
 */
export function pixelRatio(settings, { dpr = 1, width = 1, height = 1 } = {}, scale = 1) {
  if (settings.fixedPixelRatio) return settings.maxPixelRatio;
  let r = Math.min(Math.max(dpr, 1), settings.maxPixelRatio);
  const pixels = width * height * r * r;
  if (pixels > settings.maxPixels) r *= Math.sqrt(settings.maxPixels / pixels);
  // (hundredths: the drawing buffer is resized only when the ratio really changes)
  return Math.max(0.5, Math.round(r * scale * 100) / 100);
}

// --- autodetect ------------------------------------------------------------------------------------------------------

/**
 * What the browser tells about the device. adapter: the GPUAdapter (or null). Every field may be missing: Safari and
 * Firefox give no deviceMemory, and a browser may blank the adapter's info.
 */
export function readEnvironment(adapter = null, win = globalThis) {
  const nav = win.navigator || {};
  const media = (q) => { try { return Boolean(win.matchMedia?.(q).matches); } catch { return false; } };
  const info = adapter?.info || {};
  const ua = String(nav.userAgent || '');
  return {
    coarse: media('(pointer: coarse)'),
    touchPoints: nav.maxTouchPoints || 0,
    uaMobile: nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad|iPod/.test(ua),
    deviceMemory: nav.deviceMemory ?? null,
    cores: nav.hardwareConcurrency ?? null,
    dpr: win.devicePixelRatio || 1,
    screenShort: Math.min(win.screen?.width || 0, win.screen?.height || 0),
    gpu: {
      vendor: String(info.vendor || '').toLowerCase(),
      architecture: String(info.architecture || '').toLowerCase(),
      device: String(info.device || '').toLowerCase(),
      description: String(info.description || '').toLowerCase(),
      fallback: Boolean(info.isFallbackAdapter ?? adapter?.isFallbackAdapter)
    },
    limits: adapter?.limits ? { maxTextureDimension2D: adapter.limits.maxTextureDimension2D, maxBufferSize: adapter.limits.maxBufferSize } : null
  };
}

// How strong a phone's GPU is, as far as its adapter's strings tell: 'strong', 'mid', 'weak', 'apple' (one string for
// every iPhone and iPad) or 'unknown'
export function gpuClass(gpu = {}) {
  const text = `${gpu.vendor || ''} ${gpu.architecture || ''} ${gpu.device || ''} ${gpu.description || ''}`;
  if (/apple/.test(text)) return 'apple';
  const adreno = /adreno[^0-9]{0,8}(\d)/.exec(text) || (/qualcomm/.test(text) ? /(\d)[0-9x]{2}/.exec(gpu.architecture || '') : null);
  if (adreno) return +adreno[1] >= 7 ? 'strong' : +adreno[1] === 6 ? 'mid' : 'weak';
  if (/xclipse|samsung/.test(text)) return 'strong';
  if (/immortalis|mali-g(7[1-9]|9)\d|gen-?5|5th/.test(text)) return 'strong';
  if (/valhall|mali-g[5-7]\d/.test(text)) return 'mid';
  if (/bifrost|midgard|mali|powervr|img-?tec|imagination/.test(text)) return 'weak';
  if (/nvidia|amd|intel/.test(text)) return 'mid'; // a tablet PC, a handheld
  return 'unknown';
}

/**
 * The tier a device starts at: { tier, mobile, gpu (gpuClass), reasons }. Desktops get ultra, the picture they have
 * always had; phones and tablets medium, high only when the GPU is known strong and the memory is there, low when
 * either looks short or nothing is known.
 */
export function detectTier(env = {}) {
  const gpu = env.gpu || {};
  const reasons = [];
  const mobile = Boolean(env.uaMobile || (env.coarse && env.touchPoints > 0));
  if (gpu.fallback) return { tier: 'low', mobile, gpu: 'software', reasons: ['a software (fallback) adapter'] };
  if (!mobile) return { tier: 'ultra', mobile, gpu: gpuClass(gpu), reasons: ['a desktop: no coarse pointer, no mobile user agent'] };
  const cls = gpuClass(gpu);
  // (browsers that do not say are taken for 4 GB: Chrome caps the figure at 8)
  const memory = env.deviceMemory ?? 4;
  let tier;
  if (cls === 'apple') {
    // every iPhone and iPad says "apple": an iPhone 11 and an iPad Pro alike. Medium, and the governor finds the rest
    tier = 'medium';
    reasons.push('an Apple GPU (the model is not exposed): medium, the governor lifts it');
  } else if (cls === 'strong') {
    tier = memory >= 8 ? 'high' : memory >= 4 ? 'medium' : 'low';
    reasons.push(`a strong GPU, ${memory} GB`);
  } else if (cls === 'mid') {
    tier = memory >= 4 ? 'medium' : 'low';
    reasons.push(`a mid-range GPU, ${memory} GB`);
  } else if (cls === 'weak') {
    tier = 'low';
    reasons.push('an old or entry-level GPU');
  } else {
    tier = memory >= 6 ? 'medium' : 'low';
    reasons.push(`an unknown GPU, ${memory} GB: conservative`);
  }
  if (cls !== 'apple' && env.cores != null && env.cores < 6 && tier !== 'low') {
    tier = TIER_NAMES[tierIndex(tier) - 1];
    reasons.push(`${env.cores} cores: a tier lower`);
  }
  return { tier, mobile, gpu: cls, reasons };
}

// --- the governor ----------------------------------------------------------------------------------------------------

// the render scale's steps (of the pixel ratio: 12% each, a quarter of the pixels less)
export const SCALES = [1, 0.88, 0.77, 0.68, 0.6];

/**
 * The frame-time governor. levels: [{ minScale, ratio }] from the lowest tier it may use to the highest (ratio: the
 * tier's pixel ratio at scale 1, so a change of tier keeps the resolution about where it was); start: the level and
 * scale it starts at. frame(ms) takes each frame's interval and returns true when it changed .level or .scale.
 */
export class Governor {
  constructor({ levels, level = levels.length - 1, scale = 1, targetFps = 60, windowMs = 1000, upAfter = 6, maxUpAfter = 240 } = {}) {
    this.levels = levels;
    this.level = Math.min(Math.max(level, 0), levels.length - 1);
    this.scale = this._snap(scale, this.level);
    this.baseFps = targetFps;
    this.targetFps = targetFps; // (lower while the rate is held from outside: see capped)
    this.capped = false; // the frame rate did not answer to the resolution: it is capped, or bound by the CPU
    this._trail = null; // where a run of steps down began: { mean, level, scale }
    this.windowMs = windowMs;
    this.baseUpAfter = upAfter; // good windows before a step up is tried
    this.upAfter = upAfter;
    this.maxUpAfter = maxUpAfter;
    this.floored = false; // at the lowest level's floor and still under the target
    this.demoted = false; // it has lowered the level (the tier) since it started
    this._time = 0;
    this._frames = 0;
    this._bad = 0;
    this._good = 0;
    this._settle = 2; // windows skipped after a change (and at the start: the first frames compile and upload)
    this._sinceUp = Infinity; // windows since the last step up: a step down within TRIAL of it is a failed try
    this.stable = 0; // windows since the last change
    this.windows = 0; // windows since it started
  }

  _snap(scale, level) {
    const floor = this.levels[level].minScale;
    let best = 1;
    for (const s of SCALES) if (s >= floor - 1e-6 && Math.abs(s - scale) < Math.abs(best - scale)) best = s;
    return best;
  }

  _changed() {
    this._settle = 1;
    this._bad = this._good = 0;
    this.stable = 0;
    return true;
  }

  _down(steps, mean) {
    // a step up that did not hold: wait twice as long before the next
    if (this._sinceUp <= Governor.TRIAL) this.upAfter = Math.min(this.upAfter * 2, this.maxUpAfter);
    this._sinceUp = Infinity;
    const floor = this.levels[this.level].minScale;
    const i = SCALES.indexOf(this.scale);
    let j = i;
    while (j < SCALES.length - 1 && j - i < steps && SCALES[j + 1] >= floor - 1e-6) j++;
    this._trail ||= { mean, level: this.level, scale: this.scale };
    if (j !== i) { this.scale = SCALES[j]; return this._changed(); }
    // At the tier's floor, at least two steps and a third of the pixels down, and the frame time is where it was:
    // the resolution is not what holds the rate. Back to where the run began, with that rate for the target
    const t = this._trail;
    if (t.level === this.level && t.scale / this.scale >= 1.25 && Math.abs(mean - t.mean) < 0.05 * t.mean) {
      this.targetFps = Math.max(20, 1000 / Math.max(mean, t.mean));
      this.capped = true;
      this.scale = t.scale;
      this._trail = null;
      return this._changed();
    }
    if (this.level > 0) {
      const ratio = this.levels[this.level].ratio * this.scale;
      this.level--;
      this.demoted = true;
      this._trail = null;
      this.scale = this._snap(Math.min(1, ratio / this.levels[this.level].ratio), this.level);
      return this._changed();
    }
    this.floored = true;
    this._bad = 0;
    return false;
  }

  _up() {
    const i = SCALES.indexOf(this.scale);
    if (i > 0) {
      this.scale = SCALES[i - 1];
    } else if (this.level < this.levels.length - 1) {
      // (a change of tier refills the trees and resizes the shadow map: it waits twice as long as a scale step)
      if (this._good < this.upAfter * 2) return false;
      const ratio = this.levels[this.level].ratio;
      this.level++;
      this.scale = this._snap(Math.min(1, ratio / this.levels[this.level].ratio), this.level);
    } else {
      this._good = 0;
      return false;
    }
    this.floored = false;
    this._sinceUp = 0;
    this._trail = null;
    return this._changed();
  }

  frame(ms) {
    // a hitch, a hidden tab, a debugger: not the frame rate. The window starts again
    if (!(ms > 0) || ms > 250) { this._time = this._frames = 0; return false; }
    this._time += ms;
    this._frames++;
    if (this._time < this.windowMs) return false;
    const mean = this._time / this._frames;
    this._time = this._frames = 0;
    this.stable++;
    this.windows++;
    if (this._sinceUp <= Governor.TRIAL) this._sinceUp++;
    if (this._settle > 0) { this._settle--; return false; }
    // (the cap is gone: the full target again)
    if (this.capped && mean < 1000 / this.baseFps * 1.07) { this.capped = false; this.targetFps = this.baseFps; }
    const budget = 1000 / this.targetFps;
    if (mean > budget * 1.18) { this._bad++; this._good = 0; }
    else if (mean < budget * 1.07) { this._good++; this._bad = 0; if (this._good >= 2) this._trail = null; }
    else this._bad = this._good = 0; // between the two: neither a reason to go down nor proof of headroom
    // far under the target: at once, and two steps
    if (mean > budget * 1.6) return this._down(2, mean);
    if (this._bad >= 2) return this._down(1, mean);
    // (under a cap the frame time cannot show whether a step up holds: none is tried)
    if (this._good >= this.upAfter && !this.capped) return this._up();
    return false;
  }
}
Governor.TRIAL = 4; // windows a step up has to hold

// --- the controller --------------------------------------------------------------------------------------------------

const CHOICE_KEY = 'donostia-quality'; // localStorage: the tier the user picked (absent: auto)
const AUTO_KEY = 'donostia-quality-auto'; // localStorage: { v, detected, tier, ceiling, until, why }: what auto learnt here
const MEMO_V = 2; // the memory's version: one written before the governor sat out the compiles is dropped
const FAILURES = ['crash', 'gpu_lost']; // the caps (`why`) that outlive a pick of Auto: something really went wrong
const CEILING_DAYS = 7; // a tier that proved too much is not tried again for this long
const SETTLED = 20; // windows without a change before the governor's tier is remembered
const EARLY = 90; // windows from the start within which a tier that did not hold is taken for too much
export const CHANGE_EVENT = 'slop-quality';

/**
 * The quality controller.
 *   quality.tiers                 the tiers offered here: ['low', 'medium', 'high', 'ultra'], without 'ultra' on a
 *                                 phone or tablet (unless the URL forced it for this visit)
 *   quality.describe(tier)        that tier's settings (TIERS[tier]: label, maxPixelRatio, shadows, ssr...)
 *   quality.get()                 the state: { mode: 'auto' | tier (what was asked for), tier (in effect now),
 *                                 bootTier, detected (the tier auto starts at here), mobile, source: 'url' |
 *                                 'stored' | 'auto' | 'recovery' (auto under a cap, after a visit that died: then
 *                                 recovered is { from, to, fails }, else null), bootReason: 'url' | 'stored' |
 *                                 'detected' | 'remembered' | 'crash_recovery' (what decided the tier this visit
 *                                 booted with; it does not change with later picks), scale (the governor's, 0.6 .. 1), pixelRatio, needsReload
 *                                 (always false), applying (main.js is rebuilding for the tier picked last),
 *                                 adaptive, floored (at the lowest setting and still under the target), capped
 *                                 (the frame rate is held from outside, e.g. Low Power Mode), targetFps, settings,
 *                                 boot (the structural settings in effect) }
 *   quality.set(tier | 'auto', { persist = true })   picks a tier (or hands back to auto), applies all of its
 *                                 settings to the running city (the live ones at once, the structural ones as
 *                                 main.js rebuilds: state.applying meanwhile) and remembers the choice (never
 *                                 ultra on a phone or tablet: that holds for the visit only); returns the new
 *                                 state.
 *   quality.reload()              reloads the page (nothing needs it any more; a way out if the city misbehaves)
 *   quality.onChange(fn)          fn(state) on every change (a pick, a governor step); returns the unsubscriber.
 *                                 window also gets a 'slop-quality' CustomEvent with the state as its detail.
 * and for main.js: init(), attach(), viewport(), frame(), deviceLost(), busy().
 */
export function createQuality({ storage = null, win = null } = {}) {
  const listeners = new Set();
  let env = {}, detected = { tier: 'ultra', mobile: false, gpu: 'unknown', reasons: [] };
  let mode = 'auto', source = 'auto', tier = 'ultra', bootTier = 'ultra', booted = bootSettings('ultra');
  let limits = null, ceiling = null, governor = null, apply = null, initialised = false;
  let overrides = null; // ?debug's q.<setting>=<value>: one knob at a time, to measure what it costs
  let view = { dpr: 1, width: 1, height: 1 }, lowest = 0, memoTier = null;
  let windows = 0; // governor windows since the city started (a resize starts a new governor)
  let applying = false; // main.js is rebuilding the city for the structural settings picked last
  let recovered = null; // { from, to, fails }: this visit started lighter because the last one died (init's recovery)
  let bootReason = 'detected', decision = []; // what decided the boot tier, in a word and step by step (debug())
  let coldAuto = false; // the city booted on auto and no tier has been picked since: the governor's finds are the device's
  let fellEarly = false; // the governor left the boot tier within EARLY windows of such a start

  const read = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key, value) => {
    try {
      if (value == null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch { /* storage unavailable or full */ }
  };
  // Auto's memory, if it is this version's and the device still looks the same (else null: one from before MEMO_V is
  // removed, see the header)
  const readMemo = () => {
    let m = null;
    try { m = JSON.parse(read(AUTO_KEY)); } catch { /* not JSON */ }
    if (!m || typeof m !== 'object') return null;
    if (m.v !== MEMO_V) { write(AUTO_KEY, null); return null; }
    return m.detected === detected.tier ? m : null;
  };
  const writeMemo = () => {
    if (memoTier === null && !ceiling) { write(AUTO_KEY, null); return; }
    write(AUTO_KEY, JSON.stringify({
      v: MEMO_V, detected: detected.tier, tier: memoTier, ceiling: ceiling?.tier ?? null, until: ceiling?.until ?? null, why: ceiling?.why ?? null
    }));
  };

  // A tier's boot settings on this device. A phone or tablet starts progressively whatever the tier (see the
  // header): the first view's shaders, then the rest behind the city (?debug's q.progressive=false still has its say)
  const mobileBoot = (name) => {
    const s = bootSettings(name, limits, overrides);
    if (detected.mobile && overrides?.progressive === undefined) s.progressive = true;
    return s;
  };
  // The tiers offered: a phone or tablet is not offered ultra, unless the URL forced it for this visit
  const offered = () => (detected.mobile && mode !== 'ultra' ? TIER_NAMES.filter((name) => name !== 'ultra') : TIER_NAMES);

  // What is in effect: the tier's live settings over the structural settings of the tier the city started with or
  // the one picked last (`booted`: the governor's steps leave those alone)
  const settings = () => {
    const t = bootSettings(tier, limits, overrides);
    return {
      ...t, msaa: booted.msaa, shadows: booted.shadows, groundMaps: booted.groundMaps, terrainMesh: booted.terrainMesh,
      releaseGeometry: booted.releaseGeometry, progressive: booted.progressive,
      ssr: booted.ssr && t.ssr
    };
  };
  const scale = () => (governor && TIERS[tier].adaptive ? governor.scale : 1);
  // The tier's resolution rule. ultra's fixed ratio of 1 is the desktop's; picked on a phone (three screen pixels to
  // a CSS one) it would be the heaviest tier and the blurriest, so there it takes high's rule instead
  const ratioRule = (name) => (TIERS[name].fixedPixelRatio && detected.mobile
    ? { ...TIERS[name], fixedPixelRatio: false, maxPixelRatio: TIERS.high.maxPixelRatio, maxPixels: TIERS.high.maxPixels } : TIERS[name]);
  const state = () => ({
    mode, tier, bootTier, detected: detected.tier, mobile: detected.mobile, source, recovered, bootReason, scale: scale(),
    pixelRatio: pixelRatio(ratioRule(tier), view, scale()),
    needsReload: false, applying, boot: structural(booted),
    adaptive: Boolean(governor) && TIERS[tier].adaptive, floored: Boolean(governor?.floored), capped: Boolean(governor?.capped),
    targetFps: governor ? Math.round(governor.targetFps) : null, settings: settings()
  });
  const emit = () => {
    const s = state();
    try { apply?.(s); } catch (e) { console.warn('[quality]', e); }
    for (const fn of listeners) { try { fn(s); } catch (e) { console.warn('[quality]', e); } }
    try { win?.dispatchEvent?.(new win.CustomEvent(CHANGE_EVENT, { detail: s })); } catch { /* no events here */ }
    return s;
  };

  // The governor for the mode: on auto it moves between the lowest tier and one above the detected one (never ultra,
  // and not above a tier that proved too much); with a tier picked by hand it only scales that tier's resolution
  const makeGovernor = (startScale = 1) => {
    if (!TIERS[tier].adaptive) { governor = null; return; }
    let lo = tierIndex(tier), hi = lo;
    if (mode === 'auto') {
      lo = 0;
      hi = Math.max(tierIndex(tier), Math.min(tierIndex(detected.tier) + 1, tierIndex('high')));
      if (ceiling) hi = Math.max(tierIndex(tier), Math.min(hi, tierIndex(ceiling.tier)));
    }
    lowest = lo;
    const levels = [];
    for (let i = lo; i <= hi; i++) {
      const t = TIERS[TIER_NAMES[i]];
      levels.push({ minScale: t.minScale, ratio: pixelRatio(ratioRule(TIER_NAMES[i]), view, 1) });
    }
    governor = new Governor({ levels, level: tierIndex(tier) - lo, scale: startScale });
  };

  const api = {
    get tiers() { return offered(); },
    describe: (name) => TIERS[name] || null,
    get: state,

    /**
     * Start-up, before the renderer exists. env: readEnvironment(adapter); search: location.search. Decides the tier the
     * city boots with: ?quality=, else the stored choice, else auto (the detected tier, or the one auto settled at on
     * an earlier visit). recovery: { failedTier, fails, dropPick } when the last visit died (js/donostia/crash-guard.js's
     * assessment): this one starts under the tier that failed (see the header). Returns the state; state.settings are
     * the boot settings.
     */
    init({ env: e = {}, search = '', now = Date.now(), recovery = null } = {}) {
      env = e;
      const params = new URLSearchParams(search);
      overrides = null;
      if (params.has('debug')) {
        // ?debug&quality=medium&q.shadows=false&q.treeMid=300: a tier with single settings changed (JSON values)
        for (const [key, value] of params) {
          if (!key.startsWith('q.') || !(key.slice(2) in TIERS.ultra)) continue;
          try { (overrides ||= {})[key.slice(2)] = JSON.parse(value); } catch { /* not a value */ }
        }
      }
      limits = env.limits || null;
      detected = detectTier(env);
      const asked = params.get('quality');
      let stored = read(CHOICE_KEY);
      // a phone never runs ultra from a stored pick (a test's, or one made before the sheet stopped offering it)
      if (stored === 'ultra' && detected.mobile) { write(CHOICE_KEY, null); stored = null; }
      // the last visit died: this one is on auto under a cap, whatever was picked (the URL's tier is still obeyed)
      const rec = recovery && isTier(recovery.failedTier) && recovery.fails > 0 && !isTier(asked) ? recovery : null;
      if (rec && isTier(stored)) {
        if (rec.dropPick) write(CHOICE_KEY, null);
        stored = null;
      }
      mode = 'auto';
      source = 'auto';
      if (isTier(asked)) { mode = asked; source = 'url'; }
      else if (asked !== 'auto' && isTier(stored)) { mode = stored; source = 'stored'; }
      // The one place the boot tier is decided, in this order: the URL's, the stored pick, else auto: the detected
      // tier, moved by what auto remembers (the tier it settled at, a cap), and held under the tier that died if the
      // last visit did. `decision` keeps the steps
      ceiling = null;
      memoTier = null;
      tier = mode === 'auto' ? detected.tier : mode;
      bootReason = source === 'url' ? 'url' : source === 'stored' ? 'stored' : 'detected';
      decision = [source === 'url' ? `?quality=${asked}` : source === 'stored' ? `the stored pick: ${stored}` : `auto: detected ${detected.tier} (${detected.reasons.join('; ')})`];
      // (the memory is read whatever the mode: a failure's cap stands when Auto is picked later in the visit)
      const memo = TIERS[detected.tier].adaptive ? readMemo() : null;
      if (memo && isTier(memo.ceiling) && memo.until > now) ceiling = { tier: memo.ceiling, until: memo.until, why: memo.why || 'governor' };
      if (mode === 'auto' && memo) {
        const top = Math.min(tierIndex(detected.tier) + 1, tierIndex('high'), ceiling ? tierIndex(ceiling.tier) : Infinity);
        if (isTier(memo.tier)) {
          memoTier = memo.tier;
          tier = TIER_NAMES[Math.min(tierIndex(memo.tier), top)];
          decision.push(`remembered: auto settled at ${memo.tier} on an earlier visit`);
        }
        if (tierIndex(tier) > top) tier = TIER_NAMES[top];
        if (ceiling) decision.push(`remembered: not above ${ceiling.tier} until ${new Date(ceiling.until).toISOString().slice(0, 10)} (${ceiling.why})`);
        if (tier !== detected.tier) bootReason = 'remembered';
      }
      recovered = null;
      if (rec) {
        const cap = rec.fails >= 2 ? TIER_NAMES[0] : TIER_NAMES[Math.max(0, tierIndex(rec.failedTier) - 1)];
        if (tierIndex(tier) > tierIndex(cap)) tier = cap;
        // (the governor does not climb past it in this visit; a phone remembers it, as after a lost GPU device)
        if (!ceiling || tierIndex(ceiling.tier) >= tierIndex(cap)) ceiling = { tier: cap, until: now + CEILING_DAYS * 86400e3, why: 'crash' };
        if (TIERS[detected.tier].adaptive) {
          memoTier = tier;
          writeMemo();
        }
        source = 'recovery';
        bootReason = 'crash_recovery';
        recovered = { from: rec.failedTier, to: tier, fails: rec.fails };
        decision.push(`crash recovery: the last visit died at ${rec.failedTier} (${rec.fails} in a row): not above ${cap}${rec.dropPick ? ', the stored pick dropped' : ''}`);
      }
      decision.push(`boots at ${tier}`);
      coldAuto = mode === 'auto';
      fellEarly = false;
      bootTier = tier;
      windows = 0;
      booted = mobileBoot(tier);
      initialised = true;
      makeGovernor();
      return state();
    },

    /** main.js's applier: fn(state) on every change, to set the renderer, the lights and the world to state.settings. */
    attach(fn) { apply = fn; },

    /** The drawing surface (CSS px) and the screen's pixel ratio: at start-up and on every resize. */
    viewport(width, height, dpr = 1) {
      const changed = width !== view.width || height !== view.height || dpr !== view.dpr;
      view = { dpr, width, height };
      if (changed && governor) makeGovernor(governor.scale);
      return pixelRatio(ratioRule(tier), view, scale());
    },

    set(choice, { persist = true } = {}) {
      if (choice !== 'auto' && !isTier(choice)) throw new Error(`quality.set: '${choice}' is not one of ${TIER_NAMES.join(', ')} or 'auto'`);
      mode = choice;
      source = choice === 'auto' ? 'auto' : 'stored';
      // (ultra picked on a phone, where only the URL offers it, is for this visit only)
      if (persist && !(choice === 'ultra' && detected.mobile)) write(CHOICE_KEY, choice === 'auto' ? null : choice);
      // (from here on the tier in force is somebody's pick applied in a running city, not a cold start: what the
      // governor does with it is not held against the tier for a week)
      coldAuto = false;
      fellEarly = false;
      if (choice === 'auto') {
        // Auto picked by hand starts afresh: what the governor remembered is forgotten (the tier it settled at, a
        // tier it found too much); the cap of a real failure stands
        if (ceiling && !FAILURES.includes(ceiling.why)) ceiling = null;
        memoTier = null;
        if (TIERS[detected.tier].adaptive) writeMemo();
      }
      // back on auto: the detected tier, under a failure's cap if there is one
      tier = choice === 'auto' ? (TIERS[detected.tier].adaptive ? TIER_NAMES[Math.min(tierIndex(detected.tier), ceiling ? tierIndex(ceiling.tier) : Infinity)] : detected.tier) : choice;
      // (the whole tier, in the running city: main.js rebuilds what its structural settings change)
      bootTier = tier;
      booted = mobileBoot(tier);
      makeGovernor();
      return emit();
    },

    /** main.js, around a rebuild for the structural settings: state.applying, for the HUD (listeners & the event). */
    busy(on) {
      if (applying === Boolean(on)) return;
      applying = Boolean(on);
      const s = state();
      for (const fn of listeners) { try { fn(s); } catch (e) { console.warn('[quality]', e); } }
      try { win?.dispatchEvent?.(new win.CustomEvent(CHANGE_EVENT, { detail: s })); } catch { /* no events here */ }
    },

    reload() { win?.location?.reload(); },

    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /** Every rendered frame's interval (ms): runs the governor. Returns true when the settings changed. */
    frame(ms) {
      if (!governor) return false;
      const stableBefore = governor.stable, before = governor.windows;
      const changed = governor.frame(ms);
      windows += governor.windows - before;
      if (changed) {
        const next = TIER_NAMES[lowest + governor.level];
        if (next !== tier) {
          // Below the tier the city booted with, within the first minutes of a cold start on auto: the device may
          // never have held the tier. Nothing is remembered yet: only if the governor settles there (below)
          if (coldAuto && windows <= EARLY && tierIndex(next) < tierIndex(bootTier)) fellEarly = true;
          tier = next;
        }
        emit();
        return true;
      }
      // Settled (SETTLED windows without a change): the next visit boots with this tier. A visit that ends before
      // that leaves nothing. If it fell from the boot tier early in a cold start and stayed down, the device never
      // held that tier: it is not booted again for a week; later it is more likely the phone running hot
      if (mode === 'auto' && TIERS[detected.tier].adaptive && governor.stable === SETTLED && stableBefore !== SETTLED) {
        // (settled above a tier that had not held earlier: that was a passing load, not the device)
        const lifted = ceiling && tierIndex(tier) > tierIndex(ceiling.tier);
        if (lifted) ceiling = null;
        const banned = fellEarly && tierIndex(tier) < tierIndex(bootTier) && (!ceiling || tierIndex(ceiling.tier) > tierIndex(tier));
        if (banned) ceiling = { tier, until: Date.now() + CEILING_DAYS * 86400e3, why: 'governor' };
        fellEarly = false;
        if (lifted || banned || memoTier !== tier) {
          memoTier = tier;
          writeMemo();
        }
      }
      return false;
    },

    /**
     * The GPU device was lost. On a phone that is most often the system taking the memory back: on auto, the next
     * start is a tier lower (and not above it for a week).
     */
    deviceLost() {
      if (!initialised || mode !== 'auto' || !TIERS[bootTier].adaptive) return;
      const lower = TIER_NAMES[Math.max(0, tierIndex(bootTier) - 1)];
      ceiling = { tier: lower, until: Date.now() + CEILING_DAYS * 86400e3, why: 'gpu_lost' };
      memoTier = lower;
      writeMemo();
    },

    /** For ?debug: how the tier was chosen and where the governor stands. */
    debug: () => ({
      env, detected, mode, source, tier, bootTier, bootReason, decision, booted, ceiling, memoTier, overrides, recovered,
      governor: governor && {
        level: governor.level, scale: governor.scale, targetFps: governor.targetFps, capped: governor.capped, upAfter: governor.upAfter,
        stable: governor.stable, floored: governor.floored, levels: governor.levels
      }
    })
  };
  return api;
}

const storageOrNull = () => { try { return globalThis.localStorage || null; } catch { return null; } };

// The page's controller (in node, for the tests' imports of the modules that read `detail`, an idle one)
export const quality = createQuality({ storage: storageOrNull(), win: typeof window !== 'undefined' ? window : null });
