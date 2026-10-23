import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from '../post-processing.js';
import { LightingSystem } from '../lighting.js';
import { GEO } from './geodata.js';
import { Terrain } from './terrain.js';
import { createGroundMaterial } from './ground.js';
import { createWater } from './water.js';
import { buildDonostiaBuildings } from './buildings.js';
import { buildLandmarks } from './landmarks/index.js';
import { buildVegetation } from './vegetation.js';
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

const STORAGE_KEY = 'donostia-god-camera';

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

  const scene = new THREE.Scene();
  const lighting = new LightingSystem(scene, renderer, DONOSTIA_PRESETS);
  markInit('lighting');

  const updaters = [];
  const add = (object) => {
    if (!object) return;
    scene.add(object);
    if (typeof object.userData.update === 'function') updaters.push(object.userData.update);
  };

  status('Loading LiDAR terrain & sea floor…');
  const terrain = await Terrain.load(GEO.terrain);
  markInit('terrain data');
  status('Building the bay, the hills & the streets…');
  add(terrain.build(await createGroundMaterial(terrain)));
  add(await createWater(terrain));
  markInit('terrain mesh');

  status('Raising the landmarks…');
  const landmarks = buildLandmarks(GEO, terrain);
  add(landmarks.group);
  markInit('landmarks');
  status(`Raising ${GEO.buildings.length.toLocaleString('en-US')} buildings…`);
  add(buildDonostiaBuildings(GEO, { hidden: landmarks.hidden }));
  markInit('buildings');
  status('Planting trees & dressing the streets…');
  const [vegetation, streetscape, bridges] = await Promise.all([
    buildVegetation(GEO, terrain), buildStreetscape(GEO, terrain), buildBridges(GEO, terrain)
  ]);
  add(vegetation);
  add(streetscape);
  add(bridges);
  markInit('details');

  const god = new GodCamera(renderer.domElement, terrain);
  const camera = god.camera;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved) god.state = saved;
    else god.flyTo(GEO.teleports.find((t) => t.id === 'urgull'), 0.001);
  } catch { god.flyTo(GEO.teleports[0], 0.001); }
  const save = () => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(god.state)); } catch { /* storage unavailable */ } };
  window.addEventListener('pagehide', save);

  // Render pipeline (as in js/main.js): MRT scene pass, half-resolution SSR on glossy metals, bloom & colour grading
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

  const hud = initHud({ GEO, god, terrain, lighting, grade, renderer });
  window.addEventListener('resize', () => {
    god.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  let last = performance.now(), elapsed = 0, frames = 0, fpsTime = 0, saveAt = 0, first = true;
  const simulate = (dt) => {
    elapsed += dt;
    god.update(dt);
    terrain.update(camera.position);
    lighting.update(camera.position);
    for (const update of updaters) update(dt, elapsed, camera);
  };

  // ?debug: frame-by-frame access for profiling, set up before the shader compile below (which waits on animation
  // frames, and requestAnimationFrame stops in hidden tabs; these calls don't). await slopDebug.bench(60) renders 60
  // frames and reports the CPU time to submit them, the GPU time of their passes (timestamp queries) and the draws.
  if (DEBUG) {
    const device = renderer.backend.device;
    window.slopDebug = {
      THREE, renderer, scene, camera, god, terrain, lighting, pipeline, updaters, GEO,
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
  scene.visible = false;
  pipeline.render();
  scene.visible = true;
  renderer.setRenderTarget(scenePass.renderTarget);
  renderer.setMRT(sceneMRT);
  try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn('[compile]', e); }
  renderer.setMRT(null);
  renderer.setRenderTarget(null);
  markInit('compile');

  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    last = now;
    simulate(Math.min(Math.max(raw, 0.001), 0.05));
    if (first) {
      // a warm-up frame with frustum culling off and every terrain level of detail shown, so pipelines and draws all
      // exist before the loading screen lifts
      const culled = [];
      scene.traverse((o) => { if (o.frustumCulled) { culled.push(o); o.frustumCulled = false; } });
      terrain.setAllVisible(true);
      pipeline.render();
      terrain.setAllVisible(false);
      culled.forEach((o) => { o.frustumCulled = true; });
      markInit('warm-up');
    }
    pipeline.render();
    if (first) {
      first = false;
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${timings.join(', ')}`);
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

initApp().catch((e) => {
  console.error(e);
  const s = document.getElementById('loading-status');
  if (s) s.textContent = `Could not start: ${e.message}`;
});
