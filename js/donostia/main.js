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
import { GodCamera } from './god-camera.js';
import { DONOSTIA_PRESETS } from './presets.js';

// js/donostia/main.js
// Slop Donostia: San Sebastián from the top of Igeldo to the end of Sagüés, built on the Basque LiDAR terrain, the
// municipal 1:500 map and b5m building heights. Map, topography & models first, explored with a free god-mode camera;
// the travel modes of slop-newyork (js/main.js) come back once the city stands.

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
  const renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: true });
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

  status('Loading LiDAR terrain & sea floor…');
  const terrain = await Terrain.load(GEO.terrain);
  markInit('terrain data');
  status('Building the bay, the hills & the streets…');
  scene.add(terrain.build(createGroundMaterial(terrain)));
  scene.add(createWater(terrain));
  markInit('terrain mesh');
  status(`Raising ${GEO.buildings.length.toLocaleString('en-US')} buildings…`);
  scene.add(buildDonostiaBuildings(GEO));
  markInit('buildings');

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

  // HUD
  const timeButtons = document.querySelectorAll('[data-time]');
  const selectTime = (id) => {
    lighting.applyPreset(id);
    grade.applyPreset(lighting.activePresetId);
    timeButtons.forEach((b) => b.classList.toggle('active', b.dataset.time === id));
  };
  timeButtons.forEach((b) => b.addEventListener('click', () => selectTime(b.dataset.time)));
  selectTime('golden');

  const teleportList = document.getElementById('teleport-list');
  for (const t of GEO.teleports) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-item tp-btn';
    const name = document.createElement('span');
    name.className = 'pop-name';
    name.textContent = t.name;
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    sub.textContent = t.name_es;
    btn.append(name, sub);
    btn.addEventListener('click', () => {
      god.flyTo(t);
      document.getElementById('teleport-popover')?.hidePopover?.();
    });
    teleportList?.appendChild(btn);
  }
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });
  const hudToggle = document.getElementById('btn-toggle-hud');
  hudToggle?.addEventListener('click', () => {
    const min = document.body.classList.toggle('hud-minimized');
    hudToggle.setAttribute('aria-pressed', String(min));
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'KeyH') hudToggle?.click();
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (digit) selectTime(['golden', 'midday', 'twilight', 'midnight'][digit[1] - 1]);
  });
  window.addEventListener('resize', () => {
    god.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Compile the pipelines behind the loading screen (a frame with frustum culling off reaches every material, the
  // shadow passes included)
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

  const elFps = document.getElementById('hud-fps');
  const elAlt = document.getElementById('hud-altitude');
  const elSpeed = document.getElementById('hud-speed');
  let last = performance.now(), frames = 0, fpsTime = 0, saveAt = 0, first = true;
  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(Math.max(raw, 0.001), 0.05);
    god.update(dt);
    terrain.update(camera.position);
    lighting.update(camera.position);
    if (first) {
      // every terrain level of detail too, so later switches never build a draw mid-flight
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
      const fps = Math.round(frames / fpsTime);
      frames = 0;
      fpsTime = 0;
      if (elFps) {
        elFps.textContent = String(fps);
        elFps.className = fps >= 50 ? 'fps-ok' : fps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elAlt) elAlt.textContent = Math.round(camera.position.y).toLocaleString('en-US');
      if (elSpeed) elSpeed.textContent = String(Math.round(god.velocity.length() * 3.6));
    }
    if (now > saveAt) { save(); saveAt = now + 4000; }
  });
}

initApp().catch((e) => {
  console.error(e);
  const s = document.getElementById('loading-status');
  if (s) s.textContent = `Could not start: ${e.message}`;
});
