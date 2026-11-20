import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from '../post-processing.js';
import { LightingSystem } from '../lighting.js';
import { GEO } from './geodata.js';
import { Terrain } from './terrain.js';
import { createGroundMaterial, prefetchGroundMaps, CLASSES_ONLY } from './ground.js';
import { createWater } from './water.js';
import { buildDonostiaBuildings } from './buildings.js';
import { buildLandmarks } from './landmarks/index.js';
import { buildVegetation, SHADOW_ONLY_LAYER } from './vegetation.js';
import { buildStreetscape } from './streetscape.js';
import { buildBridges } from './bridges.js';
import { buildShore } from './shore.js';
import { buildTunnels } from './tunnels.js';
import { buildMarina } from './marina.js';
import { buildBoats } from './boats.js';
import { buildSeamarks } from './seamarks.js';
import { buildFerries } from './ferries.js';
import { buildWeather } from './weather.js';
import { GodCamera } from './god-camera.js';
import { createColliders } from './colliders.js';
import { initHud } from './hud.js';
import { DONOSTIA_PRESETS, DONOSTIA_CAMERA } from './presets.js';
import * as live from './live-state.js';
import { createLiveSky } from './live-sky.js';
import { quality, readEnvironment, detail, TIERS } from './quality.js';

// js/donostia/main.js
// Slop Donostia: San Sebastián from the top of Igeldo to the end of Sagüés, built on the Basque LiDAR terrain, the
// municipal 1:500 map and b5m building heights. Map, topography & models first, explored with a free god-mode camera;
// the travel modes of slop-newyork (js/main.js) come back once the city stands.
//
// Every builder returns an Object3D (or null); one whose userData.update is a function gets
// update(dt, elapsed, camera) every frame.
//
// buildWorld() and createView() hold everything but the page (DOM, HUD, god camera), so a headless benchmark can run
// the very same scene and render pipeline; initApp() wires them to index.html.
//
// Quality (js/donostia/quality.js): the tier's settings reach the scene in two steps. The boot ones are options of
// buildWorld() and createView() (shadows at all, the ground maps, the MRT targets SSR reads) and of the renderer (MSAA);
// the live ones are applyWorldQuality() and view.setPost(), which initApp() calls whenever the controller's state
// changes (a pick in the HUD, a step of the frame-rate governor). Without options both build the desktop picture
// (TIERS.ultra), as they always have.

const STORAGE_KEY = 'donostia-god-camera';

// --- the world -----------------------------------------------------------------------------------------------------------

/**
 * Loads and builds the city: lighting, terrain & ground, water, landmarks, buildings, trees, street furniture, bridges,
 * the shore's walls & rocks, the tunnels' portals, the port's moorings, its boats, the island ferries and the aids to
 * navigation.
 * Returns { scene, lighting, liveSky, terrain, modules: { name: Object3D }, updaters }: liveSky is the real-time
 * switch's time of day (js/donostia/live-sky.js), idle while the switch is off.
 * status(text, progress?) reports progress; mark(label) is called after each step (init timings).
 * settings: a quality tier's (js/donostia/quality.js); of those, shadows, shadowMapSize, shadowFar, groundMaps,
 * terrainMesh and releaseGeometry shape the build, and applyWorldQuality() sets the rest.
 */
export async function buildWorld(renderer, { status = () => {}, mark = () => {}, settings = TIERS.ultra } = {}) {
  const scene = new THREE.Scene();
  // (before any material is made: the effects' materials name the SSR targets only where the scene pass has them)
  detail.mrt = Boolean(settings.ssr);
  const lighting = new LightingSystem(scene, renderer, DONOSTIA_PRESETS, {
    shadows: settings.shadows, shadowMapSize: settings.shadowMapSize, shadowFar: settings.shadowFar
  });
  const liveSky = createLiveSky({ lighting, presets: DONOSTIA_PRESETS });
  mark('lighting');

  const modules = {}, updaters = [];
  const add = (name, object) => {
    if (!object) return;
    modules[name] = object;
    scene.add(object);
    if (typeof object.userData.update === 'function') updaters.push(object.userData.update);
  };

  status('Loading LiDAR terrain & sea floor…');
  // The ground maps download & decode while the terrain does. On the tiers that watch their memory (phones) they
  // wait for the terrain instead: the core map alone is 86 MB decoded, on top of the terrain's own decode and the
  // 130 MB of chunks, and it is the peak, not the total, that gets a tab killed on iOS. The lowest tier leaves the
  // baked maps out altogether
  const frugal = settings.releaseGeometry;
  let groundMaps = settings.groundMaps === 'classes' ? CLASSES_ONLY : frugal ? null : prefetchGroundMaps();
  const terrain = await Terrain.load(GEO.terrain);
  mark('terrain data');
  status('Building the bay, the hills & the streets…');
  // the chunks first, while the ground maps finish decoding off the main thread
  const terrainGroup = terrain.build(null, { coarse: settings.terrainMesh === 'coarse' });
  if (!groundMaps) groundMaps = prefetchGroundMaps();
  const [groundMaterial, water] = await Promise.all([createGroundMaterial(terrain, groundMaps), createWater(terrain)]);
  terrain.setMaterial(groundMaterial);
  add('terrain', terrainGroup);
  add('water', water);
  mark('terrain mesh');

  status('Raising the landmarks…');
  const landmarks = buildLandmarks(GEO, terrain);
  add('landmarks', landmarks.group);
  mark('landmarks');
  status(`Raising ${GEO.buildings.length.toLocaleString('en-US')} buildings…`);
  const { hidden, replace, phantoms } = landmarks;
  add('buildings', buildDonostiaBuildings(GEO, { hidden, replace, phantoms }));
  mark('buildings');
  status('Planting trees & dressing the streets…');
  const [vegetation, streetscape, bridges, shore, marina] = await Promise.all([
    buildVegetation(GEO, terrain), buildStreetscape(GEO, terrain), buildBridges(GEO, terrain),
    buildShore(GEO, terrain, water.userData.seaLevel), buildMarina(GEO, terrain, water)
  ]);
  add('vegetation', vegetation);
  add('streetscape', streetscape);
  add('bridges', bridges);
  add('shore', shore);
  // the tunnels' portals, at the faces where the terrain steps (GEO.terrain.walls)
  add('tunnels', buildTunnels());
  add('marina', marina);
  // the boats in the port ride the sea's level (the tide)
  add('boats', buildBoats(water.userData.seaLevel));
  // the island ferries, under way in the service's hours of the time of day the lighting shows (the preset's, or the
  // city's own with the real-time switch on)
  add('ferries', buildFerries(water.userData.seaLevel, () => liveSky.hour()));
  // the aids to navigation: the lights (the lighthouses' at their models' lanterns), the posts, columns & buoys
  add('seamarks', buildSeamarks(terrain, { seaLevel: water.userData.seaLevel, landmarks: landmarks.group }));
  // the real-time weather's rain, snow & lightning, and its wind & wetness on the city's shaders (nothing with the
  // real-time switch off)
  add('weather', buildWeather({ GEO, terrain, lighting, renderer, seaLevel: () => water.userData.getSeaLevel?.() ?? 0 }));
  modules.sky = lighting.sky;
  mark('details');

  // Shadow-only stand-ins (the far trees' casters, vegetation.js) live on a layer only the sun's cascade cameras see.
  // The far trees cast within reach of the cascades: lighting.update() sets their view depth (shadow.camera.far), the
  // frustum's corners lie up to ~1.5 times that away, and a tree further out still throws its shadow in, as far as a
  // 25 m crown's shadow runs at the sun's elevation
  for (let i = 0; i < 2; i++) lighting.sunLight.shadow.getCamera(i).layers.enable(SHADOW_ONLY_LAYER);
  if (vegetation) {
    vegetation.userData.shadowReach = () => {
      const sun = lighting.sunLight.position;
      const elevation = Math.asin(THREE.MathUtils.clamp(sun.y / Math.max(sun.length(), 1e-6), -1, 1));
      return lighting.sunLight.shadow.camera.far * 1.6 + Math.min(300, 25 / Math.tan(Math.max(elevation, 0.05)));
    };
  }

  // Draw order. Opaque objects already go front to back (three sorts them by depth); the sea plane and the sky dome,
  // which lie behind nearly everything they overlap, go last so the fragments the land or the city cover are
  // rejected by the depth test before their shaders run
  modules.water?.traverse((o) => { o.renderOrder = 1; });
  lighting.sky.renderOrder = 2;

  const world = { scene, lighting, liveSky, terrain, modules, updaters };
  applyWorldQuality(world, settings);
  return world;
}

// Whether a module's shadow casters cast (those that do by design: remembered on the first call)
function setCasting(root, on) {
  if (!root || (root.userData.casting ?? true) === on) return;
  root.userData.casting = on;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.userData.casts ??= o.castShadow;
    o.castShadow = on && o.userData.casts;
  });
}

/**
 * A quality tier's live settings on a built world: the shadow map's size & reach and its casters, the terrain's and
 * the trees' levels of detail, the props' draw distance, the rain's drops, the sea's spray and the environment map's bake rate. Cheap, and
 * safe every time the quality changes: what has not changed is left alone.
 */
export function applyWorldQuality(world, settings) {
  const { lighting, liveSky, terrain, modules } = world;
  lighting.setShadowQuality({ mapSize: settings.shadowMapSize, far: settings.shadowFar });
  setCasting(modules.terrain, settings.terrainShadows);
  setCasting(modules.streetscape, settings.propShadows);
  setCasting(modules.bridges, settings.propShadows);
  terrain.lodScale = settings.terrainLod;
  modules.vegetation?.userData.setDetail({
    near: settings.treeNear, mid: settings.treeMid, billboards: settings.treeBillboards, far: settings.treeFar
  });
  detail.distance = settings.detailDistance;
  modules.weather?.userData.setDropShare(settings.rain);
  if (modules.water) modules.water.userData.spray = settings.spray;
  liveSky.bakeGap = settings.envBakeGap;
}

// The terrain's and the buildings' vertex buffers are 170 to 190 MB that only the GPU reads once they are uploaded (the
// camera's ground and the colliders work from the height field and the map, not the meshes). Called after the warm-up
// frame and now and then after it, this swaps the CPU copy of each uploaded attribute for an empty array of its type
// (three still asks the array for its type when it builds a pipeline). Index buffers stay: the terrain's levels share
// them and most are not uploaded until their level shows. Returns how many attributes still wait for their upload.
export function releaseUploadedGeometry(renderer, roots) {
  const backend = renderer.backend;
  let waiting = 0;
  for (const root of roots) {
    root?.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      for (const attribute of Object.values(o.geometry.attributes)) {
        if (!attribute.isBufferAttribute || attribute.isInstancedBufferAttribute || attribute.isStorageBufferAttribute || !attribute.array.length) continue;
        if (backend.has(attribute) && backend.get(attribute).buffer) attribute.array = new attribute.array.constructor(0);
        else waiting++;
      }
    });
  }
  return waiting;
}

// --- the view: render pipeline, shader compilation, frame ------------------------------------------------------------------

// The shadow maps draw every caster with one override material, into which three r186.1 copies each caster's colour
// graph (for its alpha) unless it has none: so every material in the city got a shadow pipeline of its own, each
// compiling a whole facade or ground shader (synchronously, in the first frame) to write depth alone. Without an alpha
// test, mask or custom shadow node that alpha changes nothing in the shadow map (no blending, no discard), so opaque
// casters get the plain shadow program instead and share one pipeline; the vertex displacement, if any, is kept.
function shareOpaqueShadowPrograms(renderer) {
  if (renderer._donostiaShadowPrograms) return;
  renderer._donostiaShadowPrograms = true;
  const shadowNodes = renderer._getShadowNodes;
  const plain = new WeakMap();
  renderer._getShadowNodes = function (material) {
    if (material.transparent || material.alphaTest > 0 || material.alphaTestNode || material.maskNode || material.maskShadowNode ||
      material.castShadowNode || material.depthNode || material.map || material.alphaMap || material.alphaToCoverage) {
      return shadowNodes.call(this, material);
    }
    let nodes = plain.get(material);
    if (!nodes || nodes.version !== material.version) {
      const positionNode = material.castShadowPositionNode?.isNode ? material.castShadowPositionNode : material.positionNode?.isNode ? material.positionNode : null;
      nodes = { version: material.version, colorNode: null, depthNode: null, positionNode };
      plain.set(material, nodes);
    }
    return nodes;
  };
}

// compileAsync() builds the node graphs in slices and has the GPU process compile the pipelines in parallel, but it
// takes one object at a time and yields between them; several calls side by side keep both busy (as js/main.js)
const COMPILE_POOL = 16;
const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));

/**
 * The render pipeline of `world` seen through `camera`, as in js/main.js: an MRT scene pass, half-resolution SSR on
 * glossy surfaces, bloom & colour grading. Returns { pipeline, grade, scenePass, sceneMRT, ssrPass, simulate(dt),
 * render(), compile(onProgress), warmUp(), setPost({ ssr, bloom }) }; pipeline is the one in use.
 * settings: a quality tier's (js/donostia/quality.js). ssr: false builds the scene pass without the normal &
 * metalness targets SSR reads (two fewer attachments to fill, two thirds of the pass's colour memory): it cannot be
 * turned on later. With them, setPost() turns SSR and bloom off and on in a running view: each combination is a render
 * pipeline of its own over the same scene pass, built the first time it is asked for, so nothing in the scene
 * recompiles.
 */
export function createView(renderer, world, camera, { settings = TIERS.ultra } = {}) {
  const { scene, lighting, liveSky, terrain, updaters } = world;
  shareOpaqueShadowPrograms(renderer);

  const scenePass = pass(scene, camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const maxSSRRoughness = 0.75;
  let sceneMRT = null, ssrPass = null, reflections = null;
  if (settings.ssr) {
    const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
    sceneMRT = mrt({
      output,
      normal: normalView,
      metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
    });
    sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
    sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(sceneMRT);
  }
  const color = scenePass.getTextureNode('output');
  if (settings.ssr) {
    const metalRough = scenePass.getTextureNode('metalRough');
    ssrPass = ssr(color, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
      metalnessNode: metalRough.r, roughnessNode: metalRough.g, camera
    });
    ssrPass.resolutionScale = 0.5;
    ssrPass.blurQuality = 1;
    ssrPass.maxDistance.value = 60;
    ssrPass.thickness.value = 0.85;
    ssrPass.quality.value = 0.25;
    ssrPass.binaryRefine = true;
    ssrPass.intensity.value = 0.5;
    ssrPass.screenEdgeFadeBlack = true;
    const reflectionMask = metalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, metalRough.g), 0);
    reflections = ssrPass.mul(reflectionMask);
  }

  // The post-processing variants (SSR or not, bloom or not), each with its colour grade; `grade` speaks to all of
  // them, and to the ones built later through the preset or look applied last
  const variants = new Map();
  let post = null, lastLook = null, lastPreset = null;
  const variant = (withSsr, withBloom) => {
    const key = `${withSsr ? 's' : '-'}${withBloom ? 'b' : '-'}`;
    let v = variants.get(key);
    if (!v) {
      const g = createPostProcessing(renderer, color, withSsr ? reflections : null, { ...DONOSTIA_CAMERA, bloom: withBloom });
      if (lastPreset) g.applyPreset(lastPreset);
      if (lastLook) g.applyLook(lastLook);
      v = { grade: g, pipeline: new THREE.RenderPipeline(renderer, g.outputNode) };
      variants.set(key, v);
    }
    return v;
  };
  const setPost = ({ ssr: withSsr = true, bloom: withBloom = true } = {}) => {
    post = variant(Boolean(withSsr && reflections), Boolean(withBloom));
  };
  setPost(settings);
  const grade = {
    looks: post.grade.looks,
    applyPreset(id) {
      lastPreset = id;
      lastLook = null;
      for (const v of variants.values()) v.grade.applyPreset(id);
    },
    applyLook(look) {
      lastLook = look;
      for (const v of variants.values()) v.grade.applyLook(look);
    }
  };
  liveSky?.attachGrade(grade);

  let elapsed = 0;
  const simulate = (dt) => {
    elapsed += dt;
    terrain.update(camera.position);
    // the real-time switch's sun, moon & weather first: what follows reads the lights it sets
    liveSky?.update(dt);
    lighting.update(camera.position);
    for (const update of updaters) update(dt, elapsed, camera);
  };

  // Every visible object with frustum culling off, one compileAsync per object, COMPILE_POOL at a time. Plain meshes
  // that share a material share its shader, so one job compiles them in turn (the first build serves the rest); each
  // instanced mesh gets a job of its own. The shadow-map variants are left to the warm-up frame.
  async function compile(onProgress = () => {}) {
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    post.pipeline.render();
    scene.visible = true;
    simulate(0); // pick the terrain's levels of detail & the trees in reach for this camera
    const culled = [], jobs = [], jobByMaterial = new Map();
    scene.traverseVisible((o) => {
      if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; }
      if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
      if (!o.layers.test(camera.layers)) return; // shadow-only stand-ins
      if (o.isInstancedMesh || o.geometry.isInstancedBufferGeometry || Array.isArray(o.material)) { jobs.push([o]); return; }
      let job = jobByMaterial.get(o.material);
      if (!job) { job = []; jobByMaterial.set(o.material, job); jobs.push(job); }
      job.push(o);
    });
    renderer.setRenderTarget(scenePass.renderTarget);
    renderer.setMRT(sceneMRT);
    // compileAsync() files its work under the render context of a top-level render, but the scene pass renders nested
    // in the post-processing chain (call depth 1): everything compiled here would be built again by the first frame,
    // and the instanced meshes, whose instance buffers get fresh names in every build, compiled again. Point it at
    // the scene pass's own context meanwhile (three r186.1 internals).
    const contexts = renderer._renderContexts, getContext = contexts.get;
    contexts.get = (target = null, m = null, depth = 0) => getContext.call(contexts, target, m, target === scenePass.renderTarget ? 1 : depth);
    const compileOne = async (object) => {
      // each compile starts in a task of its own: compileAsync() keeps one precompilation state on the renderer, which
      // must not be mid-step for two of them in the same microtask checkpoint
      await nextTask();
      try {
        await renderer.compileAsync(object, camera, scene);
      } catch (e) {
        console.warn('[compile]', e); // the warm-up frame compiles it instead
      }
    };
    let next = 0, done = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        for (const object of job) await compileOne(object);
        onProgress(++done / jobs.length);
      }
    };
    await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    contexts.get = getContext;
    renderer.setMRT(null);
    renderer.setRenderTarget(null);
    for (const o of culled) o.frustumCulled = true;
  }

  // A frame with frustum culling off, so the pipelines compile() can't reach (the shadow maps, objects out of view)
  // exist before the loading screen lifts. Terrain chunks of every level share one pipeline: the current levels do.
  function warmUp() {
    const culled = [];
    scene.traverse((o) => {
      if (o.frustumCulled && !o.userData.sharesPipelineWith) { culled.push(o); o.frustumCulled = false; }
    });
    post.pipeline.render();
    for (const o of culled) o.frustumCulled = true;
  }

  return {
    get pipeline() { return post.pipeline; },
    grade, scenePass, sceneMRT, ssrPass, simulate, render: () => post.pipeline.render(), compile, warmUp, setPost
  };
}

// --- the page --------------------------------------------------------------------------------------------------------------

let deviceLost = false; // (its message outranks the "Could not start" of a load it breaks)
let unsupported = false; // (so does "no WebGPU")

// sessionStorage: when the page last reloaded itself after losing the GPU in the background (not twice in a row)
const RELOADED_KEY = 'donostia-gpu-reload';

// Whether this browser can run the city: its WebGPU adapter, or the reason there is none, in words for the loading
// screen. Without this three.js falls back to its WebGL 2 backend, on which the city took a quarter of a minute to
// start and then drew black: the page says what is missing instead.
async function probeWebGPU() {
  const ua = navigator.userAgent || '';
  const hint = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'On iPhone and iPad it comes with iOS 26 (Safari 26).'
    : /Android/.test(ua) ? 'On Android it needs Chrome 121 or later on Android 12 or later.'
      : 'Try a current Chrome or Edge, or Safari 26 or later.';
  if (!navigator.gpu) {
    const insecure = window.isSecureContext === false ? ' WebGPU also needs a secure (https) page.' : '';
    return { adapter: null, reason: `This browser has no WebGPU, which Slop Donostia needs to draw the city. ${hint}${insecure}` };
  }
  let adapter = null;
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch { /* as none */ }
  if (!adapter) return { adapter: null, reason: `WebGPU is there, but this device's graphics are not supported by it (or it is turned off). ${hint}` };
  return { adapter, reason: null };
}

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingFill = document.getElementById('loading-progress');
  const status = (text, progress) => {
    if (loadingStatus) loadingStatus.textContent = text;
    if (loadingFill && progress != null) {
      loadingFill.parentElement?.classList.remove('is-indeterminate');
      loadingFill.style.transform = `scaleX(${progress})`;
    }
  };

  // The loading screen's last word when the city cannot start (or stops): no progress bar, the message, a way on
  // (.is-halted is there for the stylesheet: the message is the whole page now)
  const halt = (text) => {
    loadingOverlay?.removeAttribute('aria-busy');
    loadingOverlay?.classList.remove('hidden');
    loadingOverlay?.classList.add('is-halted');
    loadingFill?.parentElement?.classList.remove('is-indeterminate');
    status(text);
  };

  const DEBUG = new URLSearchParams(location.search).has('debug');
  const { adapter, reason } = await probeWebGPU();
  if (!adapter) {
    unsupported = true;
    if (loadingFill?.parentElement) loadingFill.parentElement.style.visibility = 'hidden';
    halt(reason);
    return;
  }

  // The quality tier the city boots with: ?quality=, the choice remembered, or what the device looks like
  const booted = quality.init({ env: readEnvironment(adapter), search: location.search });
  const settings = booted.settings;
  const pixelRatioNow = () => quality.viewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  console.log(`[quality] ${booted.tier} (${booted.source}${booted.mode === 'auto' ? `: ${quality.debug().detected.reasons.join('; ')}` : ''}), pixel ratio ${pixelRatioNow()}`);

  status(`Initializing three.js r${THREE.REVISION} WebGPURenderer…`);
  const renderer = new THREE.WebGPURenderer({ antialias: settings.msaa, powerPreference: 'high-performance', reversedDepthBuffer: true });
  let pixelRatio = pixelRatioNow();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = settings.shadows;
  container.appendChild(renderer.domElement);
  await renderer.init();
  if (!renderer.backend.isWebGPUBackend) {
    // (the adapter gave no device: three is on its WebGL 2 fallback)
    unsupported = true;
    renderer.domElement.remove();
    halt('WebGPU could not start on this device (the browser gave no GPU device). Close other tabs and reload, or try another browser.');
    return;
  }
  // A lost GPU device (a driver reset, the GPU process crashing...) leaves three drawing nothing: the view would freeze
  // on its last frame under a HUD that still moves. Stop, and say so over the loading screen.
  const threeDeviceLost = renderer.onDeviceLost;
  // On a phone the usual cause is the system taking the GPU's memory back, most often while the page is in the
  // background: the page then reloads itself when it is looked at again (once: a second loss within a minute stays on
  // the message), and on auto the next start is a quality tier lower (quality.deviceLost()).
  renderer.onDeviceLost = (info) => {
    threeDeviceLost.call(renderer, info); // (logs it, stops rendering)
    deviceLost = true;
    renderer.setAnimationLoop(null);
    quality.deviceLost();
    halt(`The GPU was reset (${info.message || info.reason || 'device lost'}). Reload the page to continue.`);
    if (document.visibilityState === 'hidden') {
      let last = 0;
      try { last = Number(sessionStorage.getItem(RELOADED_KEY)) || 0; } catch { /* storage unavailable */ }
      if (Date.now() - last > 60000) {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState !== 'visible') return;
          try { sessionStorage.setItem(RELOADED_KEY, String(Date.now())); } catch { /* storage unavailable */ }
          location.reload();
        });
      }
    }
    if (loadingOverlay && !document.getElementById('loading-reload')) {
      const reload = document.createElement('button');
      reload.id = 'loading-reload';
      reload.type = 'button';
      reload.className = 'panel tool-btn';
      reload.style.marginTop = '14px';
      reload.textContent = 'Reload';
      reload.addEventListener('click', () => location.reload());
      (loadingStatus || loadingOverlay).after(reload);
      // the overlay fades back in: it takes the focus once its visibility is back on, a frame or so later
      const focusReload = (tries) => {
        reload.focus();
        if (document.activeElement !== reload && tries > 0) requestAnimationFrame(() => focusReload(tries - 1));
      };
      focusReload(30);
    }
  };

  const timings = [];
  let mark = performance.now();
  const markInit = (label) => { const now = performance.now(); timings.push(`${label} ${Math.round(now - mark)}ms`); mark = now; };

  const world = await buildWorld(renderer, { status, mark: markInit, settings });
  const { scene, lighting, terrain, updaters } = world;

  const god = new GodCamera(renderer.domElement, terrain);
  // the buildings are solid to the camera: it slides along their walls and lands on their roofs
  god.colliders = createColliders(GEO.buildings);
  markInit('colliders');
  const camera = god.camera;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch { /* storage unavailable, or not JSON */ }
  // the last view, if it is one (a corrupt save or one off the edge of the map starts at Urgull, as a first visit)
  if (!god.restore(saved)) god.flyTo(GEO.teleports.find((t) => t.id === 'urgull') || GEO.teleports[0], 0.001);
  god.update(0.001);
  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(god.state)); } catch { /* storage unavailable */ } };
  window.addEventListener('pagehide', save);

  const view = createView(renderer, world, camera, { settings });
  const { grade } = view;

  // Quality changes in the running city (a pick in the HUD, a step of the governor): the tier's live settings, and
  // the drawing buffer's size when the pixel ratio moved
  const setPixelRatio = (ratio) => {
    if (ratio === pixelRatio) return;
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
  };
  quality.attach((state) => {
    applyWorldQuality(world, state.settings);
    view.setPost(state.settings);
    setPixelRatio(state.pixelRatio);
  });

  const hud = initHud({ GEO, god, terrain, lighting, grade, liveSky: world.liveSky, renderer, quality });
  const onResize = () => {
    god.onResize(window.innerWidth, window.innerHeight);
    setPixelRatio(pixelRatioNow());
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener('resize', onResize);

  let last = performance.now(), frames = 0, fpsTime = 0, saveAt = 0, first = true;
  let governing = false, lastFrame = 0; // (the governor starts once the city shows)
  const simulate = (dt) => {
    god.update(dt);
    view.simulate(dt);
  };

  // ?debug: frame-by-frame access for profiling, set up before the shader compile below (which waits on animation
  // frames, and requestAnimationFrame stops in hidden tabs; these calls don't). await slopDebug.bench(60) renders 60
  // frames back to back (at most two in flight, like the swap chain) and reports the time per frame (the frame rate's
  // bound without vsync), the CPU time to simulate & submit one, the draws and the triangles. Each bench frame advances
  // the renderer's frame (three r186.1 internals: the pass nodes render once per frame id, which the animation loop
  // otherwise advances). Timestamp queries are left out: on Apple GPUs the passes' intervals overlap and their sum
  // means nothing.
  if (DEBUG) {
    const device = renderer.backend.device;
    window.slopDebug = {
      THREE, renderer, scene, camera, god, terrain, lighting, updaters, GEO, world, view,
      // (the render pipeline in use: SSR and bloom are each a variant, js/donostia/quality.js)
      get pipeline() { return view.pipeline; },
      // the quality controller (js/donostia/quality.js): quality.get(), quality.set('low' | 'medium' | 'high' | 'ultra' |
      // 'auto'), quality.tiers, quality.onChange(fn), quality.debug() (how the tier was chosen, where the governor is)
      quality,
      // the real-time state (js/donostia/live-state.js): live.setLiveEnabled(true), live.setLiveOverride({ time, rate,
      // weather, sea }), live.liveSnapshot()
      live,
      // the real-time switch's time of day (js/donostia/live-sky.js): timeOfDay() gives the blend as it stands (the
      // keyframes' weights, the sun, the moon, the light, the eased weather, the environment map's bakes);
      // await timeOfDay.benchBake(20) times a bake of the environment map
      timeOfDay: Object.assign(() => world.liveSky.debug(), { benchBake: (n) => world.liveSky.benchBake(n), state: () => world.liveSky.state }),
      // the weather's effects (js/donostia/weather.js) with the switch on: weather.strike({ distance, bearing }),
      // weather.hold(flash), weather.setWetness(w), weather.state()
      weather: world.modules.weather?.userData.debug,
      // the tifo on Anoeta's south stand: slopDebug.tifo(false) hides it, tifo(true) shows it, tifo() toggles
      tifo(on) {
        const t = scene.getObjectByName('AnoetaTifo');
        if (t) t.visible = on ?? !t.visible;
        return t ? t.visible : null;
      },
      async bench(n = 60, dt = 1 / 60) {
        let cpu = 0, draws = 0, triangles = 0, inFlight = null;
        // (the governor sits the bench out: the animation loop's frames wait behind the bench's, and it would take
        // their intervals for a slow device and lower the resolution being measured)
        const governed = governing;
        governing = false;
        await device.queue.onSubmittedWorkDone();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const c0 = performance.now();
          if (renderer.info.autoReset) renderer.info.reset();
          renderer._nodes.nodeFrame.update();
          simulate(dt);
          // the compile below may be mid-await with the scene pass's MRT target bound: render to the canvas meanwhile
          const target = renderer.getRenderTarget(), targetMRT = renderer.getMRT();
          renderer.setRenderTarget(null);
          renderer.setMRT(null);
          view.render();
          renderer.setRenderTarget(target);
          renderer.setMRT(targetMRT);
          cpu += performance.now() - c0;
          draws += renderer.info.render.drawCalls;
          triangles += renderer.info.render.triangles;
          const done = device.queue.onSubmittedWorkDone();
          if (inFlight) await inFlight;
          inFlight = done;
        }
        await device.queue.onSubmittedWorkDone();
        governing = governed;
        const f = (v) => +(v / n).toFixed(2);
        return { frames: n, frameMs: f(performance.now() - t0), cpuMs: f(cpu), draws: Math.round(draws / n), triangles: Math.round(triangles / n) };
      }
    };
  }

  // Compile the pipelines behind the loading screen. The percentage ticks a few hundred times: the loading screen
  // (a live region) is marked busy meanwhile, so screen readers hear "Compiling shaders" once, not every step.
  status('Compiling shaders…', 0.6);
  await view.compile((p) => {
    loadingOverlay?.setAttribute('aria-busy', 'true');
    status(`Compiling shaders… ${Math.round(p * 100)}%`, 0.6 + 0.35 * p);
  });
  markInit('compile');
  if (deviceLost) return;

  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(Math.max(raw, 0.001), 0.05);
    if (hud.mapOpen && !first) {
      // The full map covers the whole view: no world to simulate or draw (the canvas keeps its last frame). The
      // camera still finishes a flight.
      god.update(dt);
    } else {
      simulate(dt);
      if (first) {
        view.warmUp();
        markInit('warm-up');
      }
      view.render();
      // the governor: the frame rate of the frames that drew the world (a hidden tab's or a hitch's interval is not
      // one, and it sorts those out itself)
      if (governing) quality.frame(now - lastFrame);
      lastFrame = now;
    }
    if (first) {
      first = false;
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        if (deviceLost) return;
        markInit('gpu');
        console.log(`[init] ${timings.join(', ')}`);
        status('', 1);
        loadingOverlay?.removeAttribute('aria-busy');
        loadingOverlay?.classList.add('hidden');
        hud.setReady();
        governing = true;
        // the CPU copies of the terrain's & the buildings' vertex buffers, now on the GPU; the stragglers (what the
        // warm-up frame did not draw) every few seconds until none is left
        if (settings.releaseGeometry) {
          const roots = [world.modules.terrain, world.modules.buildings];
          const release = (tries) => {
            if (deviceLost) return;
            if (releaseUploadedGeometry(renderer, roots) > 0 && tries > 0) setTimeout(release, 4000, tries - 1);
          };
          release(30);
        }
      });
    }
    frames++;
    fpsTime += raw;
    if (fpsTime >= 0.25) {
      hud.update(Math.round(frames / fpsTime));
      frames = 0;
      fpsTime = 0;
    }
    if (now > saveAt) { save(); saveAt = now + 4000; }
  });
}

// (imported headless by the benchmark: no page to run)
if (typeof window !== 'undefined') {
  initApp().catch((e) => {
    console.error(e);
    if (deviceLost || unsupported) return; // (already explained)
    document.getElementById('loading-overlay')?.removeAttribute('aria-busy');
    const s = document.getElementById('loading-status');
    if (s) s.textContent = `Could not start: ${e.message}`;
  });
}
