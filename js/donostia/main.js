import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from '../post-processing.js';
import { LightingSystem } from '../lighting.js';
import { GEO } from './geodata.js';
import { Terrain } from './terrain.js';
import { createGroundMaterial, prefetchGroundMaps } from './ground.js';
import { createWater } from './water.js';
import { buildDonostiaBuildings } from './buildings.js';
import { buildLandmarks } from './landmarks/index.js';
import { buildVegetation, SHADOW_ONLY_LAYER } from './vegetation.js';
import { buildStreetscape } from './streetscape.js';
import { buildBridges } from './bridges.js';
import { GodCamera } from './god-camera.js';
import { initHud } from './hud.js';
import { DONOSTIA_PRESETS } from './presets.js';

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

const STORAGE_KEY = 'donostia-god-camera';

// --- the world -----------------------------------------------------------------------------------------------------------

/**
 * Loads and builds the city: lighting, terrain & ground, water, landmarks, buildings, trees, street furniture, bridges.
 * Returns { scene, lighting, terrain, modules: { name: Object3D }, updaters }.
 * status(text, progress?) reports progress; mark(label) is called after each step (init timings).
 */
export async function buildWorld(renderer, { status = () => {}, mark = () => {} } = {}) {
  const scene = new THREE.Scene();
  const lighting = new LightingSystem(scene, renderer, DONOSTIA_PRESETS);
  mark('lighting');

  const modules = {}, updaters = [];
  const add = (name, object) => {
    if (!object) return;
    modules[name] = object;
    scene.add(object);
    if (typeof object.userData.update === 'function') updaters.push(object.userData.update);
  };

  status('Loading LiDAR terrain & sea floor…');
  // the ground maps download & decode while the terrain does
  const groundMaps = prefetchGroundMaps();
  const terrain = await Terrain.load(GEO.terrain);
  mark('terrain data');
  status('Building the bay, the hills & the streets…');
  add('terrain', terrain.build(await createGroundMaterial(terrain, groundMaps)));
  add('water', await createWater(terrain));
  mark('terrain mesh');

  status('Raising the landmarks…');
  const landmarks = buildLandmarks(GEO, terrain);
  add('landmarks', landmarks.group);
  mark('landmarks');
  status(`Raising ${GEO.buildings.length.toLocaleString('en-US')} buildings…`);
  add('buildings', buildDonostiaBuildings(GEO, { hidden: landmarks.hidden }));
  mark('buildings');
  status('Planting trees & dressing the streets…');
  const [vegetation, streetscape, bridges] = await Promise.all([
    buildVegetation(GEO, terrain), buildStreetscape(GEO, terrain), buildBridges(GEO, terrain)
  ]);
  add('vegetation', vegetation);
  add('streetscape', streetscape);
  add('bridges', bridges);
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

  return { scene, lighting, terrain, modules, updaters };
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
 * render(), compile(onProgress), warmUp() }.
 */
export function createView(renderer, world, camera) {
  const { scene, lighting, terrain, updaters } = world;
  shareOpaqueShadowPrograms(renderer);

  const scenePass = pass(scene, camera);
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
  const maxSSRRoughness = 0.75;
  const sceneMRT = mrt({
    output,
    normal: normalView,
    metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
  });
  sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
  sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
  scenePass.setMRT(sceneMRT);
  const color = scenePass.getTextureNode('output');
  const metalRough = scenePass.getTextureNode('metalRough');
  const ssrPass = ssr(color, scenePass.getTextureNode('depth'), scenePass.getTextureNode('normal'), {
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
  const grade = createPostProcessing(renderer, color, ssrPass.mul(reflectionMask));
  const pipeline = new THREE.RenderPipeline(renderer, grade.outputNode);

  let elapsed = 0;
  const simulate = (dt) => {
    elapsed += dt;
    terrain.update(camera.position);
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
    pipeline.render();
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
    pipeline.render();
    for (const o of culled) o.frustumCulled = true;
  }

  return { pipeline, grade, scenePass, sceneMRT, ssrPass, simulate, render: () => pipeline.render(), compile, warmUp };
}

// --- the page --------------------------------------------------------------------------------------------------------------

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

  status(`Initializing three.js r${THREE.REVISION} WebGPURenderer…`);
  const DEBUG = new URLSearchParams(location.search).has('debug');
  const renderer = new THREE.WebGPURenderer({
    antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true,
    trackTimestamp: DEBUG // GPU pass timings for slopDebug.bench
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);
  await renderer.init();

  const timings = [];
  let mark = performance.now();
  const markInit = (label) => { const now = performance.now(); timings.push(`${label} ${Math.round(now - mark)}ms`); mark = now; };

  const world = await buildWorld(renderer, { status, mark: markInit });
  const { scene, lighting, terrain, updaters } = world;

  const god = new GodCamera(renderer.domElement, terrain);
  const camera = god.camera;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) god.state = saved;
    else god.flyTo(GEO.teleports.find((t) => t.id === 'urgull'), 0.001);
  } catch { god.flyTo(GEO.teleports[0], 0.001); }
  god.update(0.001);
  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(god.state)); } catch { /* storage unavailable */ } };
  window.addEventListener('pagehide', save);

  const view = createView(renderer, world, camera);
  const { pipeline, grade } = view;

  const hud = initHud({ GEO, god, terrain, lighting, grade, renderer });
  window.addEventListener('resize', () => {
    god.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let last = performance.now(), frames = 0, fpsTime = 0, saveAt = 0, first = true;
  const simulate = (dt) => {
    god.update(dt);
    view.simulate(dt);
  };

  // ?debug: frame-by-frame access for profiling, set up before the shader compile below (which waits on animation
  // frames, and requestAnimationFrame stops in hidden tabs; these calls don't). await slopDebug.bench(60) renders 60
  // frames and reports the CPU time to submit them, the GPU time of their passes (timestamp queries) and the draws.
  if (DEBUG) {
    const device = renderer.backend.device;
    window.slopDebug = {
      THREE, renderer, scene, camera, god, terrain, lighting, pipeline, updaters, GEO, world, view,
      async bench(n = 60, dt = 1 / 60) {
        let cpu = 0, gpu = 0, draws = 0, triangles = 0;
        const t0 = performance.now();
        for (let i = 0; i < n; i++) {
          const c0 = performance.now();
          simulate(dt);
          // the compile below may be mid-await with the scene pass's MRT target bound: render to the canvas meanwhile
          const target = renderer.getRenderTarget(), targetMRT = renderer.getMRT();
          renderer.setRenderTarget(null);
          renderer.setMRT(null);
          pipeline.render();
          renderer.setRenderTarget(target);
          renderer.setMRT(targetMRT);
          cpu += performance.now() - c0;
          draws += renderer.info.render.drawCalls;
          triangles += renderer.info.render.triangles;
          await device.queue.onSubmittedWorkDone();
          gpu += (await renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)) || 0;
        }
        const f = (v) => +(v / n).toFixed(2);
        return { frames: n, wallMs: f(performance.now() - t0), cpuMs: f(cpu), gpuMs: f(gpu), draws: Math.round(draws / n), triangles: Math.round(triangles / n) };
      }
    };
  }

  // Compile the pipelines behind the loading screen
  status('Compiling shaders…', 0.6);
  await view.compile((p) => status(`Compiling shaders… ${Math.round(p * 100)}%`, 0.6 + 0.35 * p));
  markInit('compile');

  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    last = now;
    simulate(Math.min(Math.max(raw, 0.001), 0.05));
    if (first) {
      view.warmUp();
      markInit('warm-up');
    }
    pipeline.render();
    if (first) {
      first = false;
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${timings.join(', ')}`);
        status('', 1);
        loadingOverlay?.classList.add('hidden');
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
    const s = document.getElementById('loading-status');
    if (s) s.textContent = `Could not start: ${e.message}`;
  });
}
