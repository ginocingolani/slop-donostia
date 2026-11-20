// js/donostia/quality.js
// Slop Donostia's quality settings: named tiers, the tier a device starts at, and a governor that holds the frame rate.
// No three.js in here: the tiers and the decisions are plain data and arithmetic (tests/donostia-quality.test.mjs runs
// them in node); js/donostia/main.js turns the settings into renderer state.
//
// - TIERS: low / medium / high / ultra. `ultra` is the desktop picture as it has always been (pixel ratio 1, 4x MSAA,
//   3072 px shadow cascades, SSR, bloom, every level of detail at its full reach) and never adapts; the other three are
//   for phones and tablets, where the frame is bound first by the pixels shaded (the drawing buffer of a 3x phone
//   screen is 2.5 times a desktop window's) and then by memory (the GPU process and the page share the device's RAM,
//   and iOS kills the tab that takes too much).
// - A tier's settings are of two kinds. The live ones change in a running city for the cost of a frame or two: the
//   render resolution, the shadow map's size & reach, SSR and bloom (another render pipeline of the same scene pass),
//   the trees' and the terrain's levels of detail, the props' draw distance, the rain's drops, the sea's spray, how often
//   the environment map is baked. The boot ones are built into the pipelines and the textures at start-up (MSAA, shadows
//   at all, the MRT targets SSR reads, the baked ground maps, the terrain's mesh, the CPU copies of the geometry): changing those takes a
//   reload (state.needsReload; quality.reload()).
// - detectTier(env): the tier a device starts at, from what the browser tells (the WebGPU adapter's vendor and
//   architecture, navigator.deviceMemory, hardwareConcurrency, a coarse pointer, the screen). A desktop gets ultra, as
//   before; a phone or tablet starts at medium unless it is known strong (high) or looks weak (low): unknown devices
//   start low rather than high, and the governor lifts what the frame rate allows.
// - Governor: watches the frame time in one-second windows. Under the target for two of them, it lowers the render
//   scale a step, and at the tier's floor the tier itself (its live settings); with the target held for a while it
//   tries a step up, and backs off twice as long after every try that failed, so it settles instead of pumping. With
//   vsync the frame time says nothing about headroom, hence the tries.
// - quality: the page's controller (a singleton), for main.js and for the HUD. See createQuality() for its API.
//   ?quality=<tier|auto> in the URL picks for this visit; quality.set() remembers the user's choice (localStorage);
//   on auto, the tier the governor settled at is remembered too, so the next visit boots with that tier's boot settings.

export const TIER_NAMES = ['low', 'medium', 'high', 'ultra'];

// treeNear / treeMid: where the trees' full detail and their branch cards end (m; js/donostia/vegetation.js);
// treeBillboards: where the far crowns turn into billboards; treeFar: where the trees end. terrainLod: the reach of
// every level of the terrain's detail (js/donostia/terrain.js lodScale). detailDistance: the draw distance of the
// instanced props (street furniture, the port's fittings, the shore's rocks), times their own. shadowFar: the sun's
// shadow range, times lighting.js's own. rain: the share of the drops drawn. envBakeGap: the least time between two
// bakes of the environment map in real time (s). groundMaps: 'full' (the baked 1 m maps: 86 MB on the GPU) or
// 'classes' (the terrain's own 2 m classes: no kerbs, crossings or paving directions, 9.8 MB less to download).
// terrainMesh: 'full' (every 2 m sample of the core) or 'coarse' (every second one away from the shore walls: 75 MB
// less on the GPU; js/donostia/terrain.js).
// releaseGeometry: drop the CPU copies of the terrain's & the buildings' vertex buffers once they are on the GPU.
// maxPixels: the drawing buffer's budget (a tablet's screen has four times a phone's pixels at the same ratio).
export const TIERS = Object.freeze({
  low: Object.freeze({
    label: 'Low', maxPixelRatio: 1.25, fixedPixelRatio: false, maxPixels: 0.9e6, minScale: 0.68, adaptive: true,
    msaa: false, shadows: false, shadowMapSize: 1024, shadowFar: 0.6, ssr: false, bloom: false,
    terrainLod: 0.45, treeNear: 40, treeMid: 130, treeBillboards: 350, treeFar: 2200, detailDistance: 0.5,
    rain: 0.35, spray: false, envBakeGap: 2, groundMaps: 'classes', terrainMesh: 'coarse', releaseGeometry: true
  }),
  medium: Object.freeze({
    label: 'Medium', maxPixelRatio: 1.5, fixedPixelRatio: false, maxPixels: 1.3e6, minScale: 0.68, adaptive: true,
    msaa: false, shadows: true, shadowMapSize: 1024, shadowFar: 0.7, ssr: false, bloom: true,
    terrainLod: 0.6, treeNear: 55, treeMid: 190, treeBillboards: 500, treeFar: 2800, detailDistance: 0.7,
    rain: 0.6, spray: true, envBakeGap: 1, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: true
  }),
  high: Object.freeze({
    label: 'High', maxPixelRatio: 2, fixedPixelRatio: false, maxPixels: 2.2e6, minScale: 0.6, adaptive: true,
    msaa: true, shadows: true, shadowMapSize: 2048, shadowFar: 1, ssr: true, bloom: true,
    terrainLod: 0.8, treeNear: 70, treeMid: 250, treeBillboards: 700, treeFar: 3400, detailDistance: 0.85,
    rain: 1, spray: true, envBakeGap: 0.4, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: true
  }),
  ultra: Object.freeze({
    label: 'Ultra', maxPixelRatio: 1, fixedPixelRatio: true, maxPixels: Infinity, minScale: 1, adaptive: false,
    msaa: true, shadows: true, shadowMapSize: 3072, shadowFar: 1, ssr: true, bloom: true,
    terrainLod: 1, treeNear: 85, treeMid: 300, treeBillboards: 900, treeFar: 3400, detailDistance: 1,
    rain: 1, spray: true, envBakeGap: 0.15, groundMaps: 'full', terrainMesh: 'full', releaseGeometry: false
  })
});

export const isTier = (name) => TIER_NAMES.includes(name);
const tierIndex = (name) => TIER_NAMES.indexOf(name);

// What the world's modules read (they must not depend on the controller); main.js sets it from the tier.
// distance: the props' draw distance, times their own (read every frame). mrt: whether the scene pass has the normal &
// metalness targets SSR reads (read as the materials are made: an effect's material may only name them, with its
// mrtNode, where they exist; a quality tier without SSR builds the pass without them).
export const detail = { distance: 1, mrt: true };

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

/** Whether going from the settings the city booted with to `wanted` takes a reload (SSR alone can be turned off live). */
export function needsReload(booted, wanted) {
  return booted.msaa !== wanted.msaa || booted.shadows !== wanted.shadows || (wanted.ssr && !booted.ssr) ||
    booted.groundMaps !== wanted.groundMaps || booted.terrainMesh !== wanted.terrainMesh;
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
    this.targetFps = targetFps;
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

  _down(steps) {
    // a step up that did not hold: wait twice as long before the next
    if (this._sinceUp <= Governor.TRIAL) this.upAfter = Math.min(this.upAfter * 2, this.maxUpAfter);
    this._sinceUp = Infinity;
    const floor = this.levels[this.level].minScale;
    const i = SCALES.indexOf(this.scale);
    let j = i;
    while (j < SCALES.length - 1 && j - i < steps && SCALES[j + 1] >= floor - 1e-6) j++;
    if (j !== i) { this.scale = SCALES[j]; return this._changed(); }
    if (this.level > 0) {
      const ratio = this.levels[this.level].ratio * this.scale;
      this.level--;
      this.demoted = true;
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
    const budget = 1000 / this.targetFps;
    if (mean > budget * 1.18) { this._bad++; this._good = 0; }
    else if (mean < budget * 1.07) { this._good++; this._bad = 0; }
    else this._bad = this._good = 0; // between the two: neither a reason to go down nor proof of headroom
    // far under the target: at once, and two steps
    if (mean > budget * 1.6) return this._down(2);
    if (this._bad >= 2) return this._down(1);
    if (this._good >= this.upAfter) return this._up();
    return false;
  }
}
Governor.TRIAL = 4; // windows a step up has to hold

// --- the controller --------------------------------------------------------------------------------------------------

const CHOICE_KEY = 'donostia-quality'; // localStorage: the tier the user picked (absent: auto)
const AUTO_KEY = 'donostia-quality-auto'; // localStorage: { detected, tier, ceiling, until }: what auto learnt here
const CEILING_DAYS = 7; // a tier that proved too much is not tried again for this long
const SETTLED = 20; // windows without a change before the governor's tier is remembered
const EARLY = 90; // windows from the start within which a tier that did not hold is taken for too much
export const CHANGE_EVENT = 'slop-quality';

/**
 * The quality controller.
 *   quality.tiers                 ['low', 'medium', 'high', 'ultra']
 *   quality.describe(tier)        that tier's settings (TIERS[tier]: label, maxPixelRatio, shadows, ssr...)
 *   quality.get()                 the state: { mode: 'auto' | tier (what was asked for), tier (in effect now),
 *                                 bootTier, detected, source: 'url' | 'stored' | 'auto', scale, pixelRatio,
 *                                 needsReload, adaptive, settings }
 *   quality.set(tier | 'auto', { persist = true })   picks a tier (or hands back to auto), applies its live settings
 *                                 at once and remembers the choice; returns the new state. state.needsReload says
 *                                 the tier's boot settings (MSAA, shadows, SSR, ground maps) wait for a reload.
 *   quality.reload()              reloads the page (to apply them)
 *   quality.onChange(fn)          fn(state) on every change (a pick, a governor step); returns the unsubscriber.
 *                                 window also gets a 'slop-quality' CustomEvent with the state as its detail.
 * and for main.js: init(), attach(), viewport(), frame(), deviceLost().
 */
export function createQuality({ storage = null, win = null } = {}) {
  const listeners = new Set();
  let env = {}, detected = { tier: 'ultra', mobile: false, gpu: 'unknown', reasons: [] };
  let mode = 'auto', source = 'auto', tier = 'ultra', bootTier = 'ultra', booted = bootSettings('ultra');
  let limits = null, ceiling = null, governor = null, apply = null, initialised = false;
  let overrides = null; // ?debug's q.<setting>=<value>: one knob at a time, to measure what it costs
  let view = { dpr: 1, width: 1, height: 1 }, lowest = 0, memoTier = null;
  let wanted = 'ultra'; // the tier whose boot settings are asked for: the pick, or the one auto starts at
  let windows = 0; // governor windows since the city started (a resize starts a new governor)

  const read = (key) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
  const write = (key, value) => {
    try {
      if (value == null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch { /* storage unavailable or full */ }
  };
  const readMemo = () => {
    try {
      const m = JSON.parse(read(AUTO_KEY));
      return m && typeof m === 'object' ? m : null;
    } catch { return null; }
  };
  const writeMemo = () => write(AUTO_KEY, JSON.stringify({
    detected: detected.tier, tier: memoTier, ceiling: ceiling?.tier ?? null, until: ceiling?.until ?? null
  }));

  // What is in effect: the tier's live settings over the boot settings the city started with
  const settings = () => {
    const t = bootSettings(tier, limits, overrides);
    return {
      ...t, msaa: booted.msaa, shadows: booted.shadows, groundMaps: booted.groundMaps, terrainMesh: booted.terrainMesh,
      releaseGeometry: booted.releaseGeometry,
      ssr: booted.ssr && t.ssr
    };
  };
  const scale = () => (governor && TIERS[tier].adaptive ? governor.scale : 1);
  const state = () => ({
    mode, tier, bootTier, detected: detected.tier, source, scale: scale(),
    pixelRatio: pixelRatio(TIERS[tier], view, scale()),
    needsReload: needsReload(booted, bootSettings(wanted, limits)),
    adaptive: Boolean(governor) && TIERS[tier].adaptive, floored: Boolean(governor?.floored), settings: settings()
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
      levels.push({ minScale: t.minScale, ratio: pixelRatio(t, view, 1) });
    }
    governor = new Governor({ levels, level: tierIndex(tier) - lo, scale: startScale });
  };

  const api = {
    tiers: TIER_NAMES,
    describe: (name) => TIERS[name] || null,
    get: state,

    /**
     * Start-up, before the renderer exists. env: readEnvironment(adapter); search: location.search. Decides the tier the
     * city boots with: ?quality=, else the stored choice, else auto (the detected tier, or the one auto settled at on
     * an earlier visit). Returns the state; state.settings are the boot settings.
     */
    init({ env: e = {}, search = '', now = Date.now() } = {}) {
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
      const stored = read(CHOICE_KEY);
      mode = 'auto';
      source = 'auto';
      if (isTier(asked)) { mode = asked; source = 'url'; }
      else if (asked !== 'auto' && isTier(stored)) { mode = stored; source = 'stored'; }
      ceiling = null;
      memoTier = null;
      tier = mode === 'auto' ? detected.tier : mode;
      if (mode === 'auto' && TIERS[detected.tier].adaptive) {
        const memo = readMemo();
        // (what an earlier visit learnt, if the device still looks the same)
        if (memo && memo.detected === detected.tier) {
          if (isTier(memo.ceiling) && memo.until > now) ceiling = { tier: memo.ceiling, until: memo.until };
          const top = Math.min(tierIndex(detected.tier) + 1, tierIndex('high'), ceiling ? tierIndex(ceiling.tier) : Infinity);
          if (isTier(memo.tier)) { memoTier = memo.tier; tier = TIER_NAMES[Math.min(tierIndex(memo.tier), top)]; }
          else if (tierIndex(tier) > top) tier = TIER_NAMES[top];
        }
      }
      bootTier = wanted = tier;
      windows = 0;
      booted = bootSettings(tier, limits, overrides);
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
      return pixelRatio(TIERS[tier], view, scale());
    },

    set(choice, { persist = true } = {}) {
      if (choice !== 'auto' && !isTier(choice)) throw new Error(`quality.set: '${choice}' is not one of ${TIER_NAMES.join(', ')} or 'auto'`);
      mode = choice;
      source = choice === 'auto' ? 'auto' : 'stored';
      if (persist) write(CHOICE_KEY, choice === 'auto' ? null : choice);
      // back on auto: the tier the city booted with if auto chose it, else the detected one
      tier = choice === 'auto' ? (TIERS[detected.tier].adaptive ? TIER_NAMES[Math.min(tierIndex(detected.tier), ceiling ? tierIndex(ceiling.tier) : Infinity)] : detected.tier) : choice;
      wanted = tier;
      makeGovernor();
      return emit();
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
          // Below the tier the city booted with: the next visit boots lower. If that came within the first minutes
          // (the device never held the tier, even cold), the tier is not booted again for a week; later it is more
          // likely the phone running hot, and the governor may climb back
          if (mode === 'auto' && tierIndex(next) < tierIndex(bootTier) && tierIndex(next) < tierIndex(tier)) {
            if (windows <= EARLY) ceiling = { tier: next, until: Date.now() + CEILING_DAYS * 86400e3 };
            memoTier = next;
            writeMemo();
          }
          tier = next;
        }
        emit();
        return true;
      }
      // settled: the next visit boots with this tier
      if (mode === 'auto' && governor.stable === SETTLED && stableBefore !== SETTLED) {
        // (settled above a tier that had not held earlier in this visit: that was a passing load, not the device)
        const lifted = ceiling && tierIndex(tier) > tierIndex(ceiling.tier);
        if (lifted) ceiling = null;
        if (lifted || memoTier !== tier) {
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
      ceiling = { tier: lower, until: Date.now() + CEILING_DAYS * 86400e3 };
      memoTier = lower;
      writeMemo();
    },

    /** For ?debug: how the tier was chosen and where the governor stands. */
    debug: () => ({
      env, detected, mode, source, tier, bootTier, booted, ceiling, memoTier, overrides,
      governor: governor && { level: governor.level, scale: governor.scale, upAfter: governor.upAfter, stable: governor.stable, floored: governor.floored, levels: governor.levels }
    })
  };
  return api;
}

const storageOrNull = () => { try { return globalThis.localStorage || null; } catch { return null; } };

// The page's controller (in node, for the tests' imports of the modules that read `detail`, an idle one)
export const quality = createQuality({ storage: storageOrNull(), win: typeof window !== 'undefined' ? window : null });
