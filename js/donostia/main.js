import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, vec4, smoothstep } from 'three/tsl';
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
import { quality, readEnvironment, detectTier, detail, TIERS, needsRebuild } from './quality.js';
import { createCrashGuard } from './crash-guard.js';
import { initAnalytics, deviceInfo, interfaceReader, MOVE_SPEED } from './analytics.js';
import { initConsent } from './consent.js';
import { getLang, t } from './i18n.js';

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
// Quality (js/donostia/quality.js): the tier's settings reach the scene in two steps. The structural ones are options
// of buildWorld() and createView() (shadows at all, the ground maps, the terrain's mesh, MSAA, the MRT targets SSR
// reads); the live ones are applyWorldQuality() and view.setPost(), which initApp() calls whenever the controller's
// state changes (a pick in the HUD, a step of the frame-rate governor). A tier picked in the running city changes the
// structural ones too, without a reload: applyWorldStructure() and view.rebuild(), then the shaders again as at
// start-up (initApp()'s restructure()). Without options both build the desktop picture (TIERS.ultra), as they always
// have.
//
// Shaders: nothing is drawn before its pipelines are compiled (createCompiler()). The loading screen lifts once the
// first view's are; on the phone tiers, and on a phone or tablet at any tier, that is what the camera sees and what
// is everywhere, and the rest follow in the background, nearest first.
//
// A page that dies: a phone's browser kills a tab that takes too much memory and loads it again, with no word to the
// page. js/donostia/crash-guard.js keeps a note in localStorage while the page lives; initApp() reads the last one
// before it builds anything, starts a tier lower when that visit died in view (js/donostia/quality.js's recovery),
// says so on the loading screen, and after repeated deaths at the lowest tier stops with a message and a button
// instead of loading itself to death again.

const STORAGE_KEY = 'donostia-god-camera';
const COMPILE_SHADOW_MS = 500; // after a shader compile, the frames the frame-rate governor is not fed

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

  const world = { scene, lighting, liveSky, terrain, modules, updaters, groundMaterial };
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

/**
 * A quality tier's structural settings on a built world, going from `from` to `to` (js/donostia/quality.js's
 * structural()): shadows at all, whether the effects' materials name the targets SSR reads, the ground's maps (baked,
 * or the terrain's classes: the baked ones download now if the city started without them) and the terrain's mesh
 * (coarse or full: built again from the height field). Every material's pipelines are different after it, so the
 * caller rebuilds its view and compiles again (initApp()'s restructure()); applyWorldQuality() follows it.
 */
export async function applyWorldStructure(world, renderer, to, from) {
  const { scene, lighting, terrain, modules } = world;
  renderer.shadowMap.enabled = to.shadows;
  lighting.sunLight.castShadow = to.shadows;
  detail.mrt = Boolean(to.ssr);
  const seen = new Set();
  scene.traverse((o) => {
    for (const material of o.material ? [].concat(o.material) : []) {
      if (seen.has(material)) continue;
      seen.add(material);
      const node = material.userData.effectTargets;
      const wanted = node && detail.mrt ? node : null;
      if (node && material.mrtNode !== wanted) {
        material.mrtNode = wanted;
        material.needsUpdate = true;
      }
    }
  });
  if (to.groundMaps !== from.groundMaps) {
    const old = world.groundMaterial;
    world.groundMaterial = await createGroundMaterial(terrain, to.groundMaps === 'classes' ? CLASSES_ONLY : null);
    terrain.setMaterial(world.groundMaterial);
    old?.userData.release?.();
  }
  if (to.terrainMesh !== from.terrainMesh) {
    terrain.rebuild(world.groundMaterial, { coarse: to.terrainMesh === 'coarse' });
    // (the new chunks cast as built: applyWorldQuality() sets them to the tier's again)
    delete modules.terrain.userData.casting;
  }
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

// three r186.1 hands an InstancedMesh of up to 1024 instances its matrices in a uniform buffer, declared in the vertex
// shader as an array of the mesh's own count under a name numbered afresh in every build: no two instanced meshes
// shared a vertex shader or a pipeline, not even the same mesh's draws into the scene and into each shadow cascade
// (the port's fittings alone took 8 pipelines for one material; the shadow maps 42). Above that count it binds the
// matrices as instanced vertex attributes instead, a shader that says nothing of the mesh: with the limit it compares
// with at zero every instanced mesh goes that way, and those of one material and vertex layout share one program and
// one pipeline. (three r186.1 internals: the backend's capabilities; the skinning and range nodes that also ask are
// not used here.)
function shareInstancedPrograms(renderer) {
  const capabilities = renderer.backend.capabilities;
  if (capabilities?.getUniformBufferLimit) capabilities.getUniformBufferLimit = () => 0;
}

// compileAsync() builds the node graphs in slices and has the GPU process compile the pipelines in parallel, but it
// takes one object at a time and yields between them; several calls side by side keep both busy (as js/main.js)
const COMPILE_POOL = 16;
const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
// (between two background compiles: a frame drawn in between, or a moment where there are none, in a hidden tab)
const nextFrame = () => new Promise((resolve) => {
  if (typeof requestAnimationFrame !== 'function' || globalThis.document?.visibilityState === 'hidden') { setTimeout(resolve, 30); return; }
  const timer = setTimeout(resolve, 250);
  requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
});

// What the first view takes whatever the camera looks at: the ground, the sea, the sky, the houses and the trees are
// everywhere (and a handful of programs between them)
const EVERYWHERE = ['terrain', 'water', 'sky', 'buildings', 'vegetation'];
// Of the rest, the first view takes what the camera sees within NEAR metres, or from further when it is large enough
// on screen (radius over distance: 0.25 is a quarter of a phone's height or so): a landmark across the bay waits a
// moment. What is merged across the city (the railings, the lamps, the shore's walls: bounds wider than SPREAD
// metres, which say nothing of where it shows) waits too, at the front of the background's queue. And of what
// qualifies only the FIRST_FEW nearest materials are taken, so a start in the thick of the landmarks is no slower
// than one on the hill: each is some 45 kB of WGSL, half a second or so of a phone's compiler.
const NEAR = 160, LARGE = 0.25, SPREAD = 500, FIRST_FEW = 6;
// The background's pacing where a compile stalls the frames (createCompiler()'s header). STALL_COSTLY: the running
// mean of the stalls (ms) from which the device is taken for one that stalls; STILL_MS: how long the camera has to
// have been still for the queue to run freely; REST_SHARE: the rest after a compile, times its stall, while the
// camera moves (between REST_MIN and REST_MAX ms); NEEDED_NEAR / NEEDED_AHEAD: what is compiled even then (m from
// the camera, in view; m from where a flight ends); WAIT_MS: how often the queue looks again while it holds back
const STALL_COSTLY = 12, STILL_MS = 600, REST_SHARE = 6, REST_MIN = 100, REST_MAX = 1500, NEEDED_NEAR = 400, NEEDED_AHEAD = 400, WAIT_MS = 150;
const LATER = Symbol('later');
// three's shadow pass draws a front-sided caster's back faces (r186.1's _shadowSide)
const SHADOW_SIDE = { [THREE.FrontSide]: THREE.BackSide, [THREE.BackSide]: THREE.FrontSide, [THREE.DoubleSide]: THREE.DoubleSide };

/**
 * The shader compiler of a view: which pipelines exist, which objects wait for theirs, and the order they get them in.
 *
 * WebGPU compiles a pipeline the first time an object is drawn with it, on the spot: a stalled frame. So nothing is
 * drawn before its pipelines exist. Every drawable of the scene belongs to a job (the objects of one material: they
 * share its programs); the objects of a job that is not compiled yet are held back, on no layer at all, so neither the
 * camera nor the sun's cascades draw them, whatever their module does with .visible meanwhile. A job compiles through
 * renderer.compileAsync(), which builds the node graph in slices and has the pipeline made off the main thread: once
 * for the scene pass and, for what casts shadows, once for the shadow map (see precompile()). Then its objects appear.
 *
 * first(onProgress) compiles the first view's jobs, a pool of them at a time, behind the loading screen: with
 * `progressive` (the phone tiers) what the camera sees from where it starts and what is everywhere, without it every
 * visible object (the desktop, as it always was). start() then compiles the rest in the background, one object at a
 * time with a frame drawn in between, nearest the camera first: what is in view, then what is around, then what is
 * hidden (the rain before it rains, the levels of detail not shown yet), which used to compile in the frame that first
 * showed it. The order is worked out again for every job, so flying or teleporting brings what is there to the front.
 * adopt() takes in what a module adds to the scene later (the sea's spray).
 *
 * The background paces itself by what a compile costs here. Chrome on a desktop makes a pipeline off the main thread
 * and a frame is hardly late for it; WebKit on a phone stalls a frame or more for each (an iPhone 15 Pro: 7 to 20 fps
 * at the worst through 27 s of background compile). So every background compile is timed by the frames around it
 * (the longest gap between two animation frames while it ran, over the usual one: its stall), and where the stalls
 * are long (a running mean over STALL_COSTLY ms) the visitor's hands come first: while the camera moves or turns,
 * only what is in view and near, or where a flight is heading, is compiled, with a rest after each compile of
 * REST_SHARE times its stall, so the stalls take a seventh of the time at most; once the camera has been still for
 * STILL_MS, or the view is covered (the full map, a sheet: `covered`), the queue runs at a compile a frame again.
 * Where a compile costs nothing the pace is a compile a frame throughout, as it always was. The stalls are counted
 * (stats: compiles, blockedMs, maxStallMs) for the analytics, and lastWork (the time of the last compile's end)
 * tells main.js which frames not to judge the device by.
 *
 * (three r186.1 internals, here and in precompile(): the renderer's render contexts, _getShadowNodes, the shape of
 * the shadow pass's material, and compileAsync() projecting its object before its first await.)
 */
function createCompiler(renderer, world, camera, passes) {
  const { scene, lighting } = world;
  const held = new Map(); // object -> its layers' mask, while it waits
  const known = new WeakSet();
  const twins = new WeakMap(); // material -> its shadow pass material
  const everywhere = new WeakSet();
  const frustum = new THREE.Frustum(), matrix = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const listeners = new Set();
  let jobs = [], byMaterial = new Map(), run = 0, working = false;
  // the pacing (see the header)
  const stats = { compiles: 0, blockedMs: 0, maxStallMs: 0 };
  const lastPosition = new THREE.Vector3(Infinity, 0, 0), lastTurn = new THREE.Quaternion();
  let usual = 1000 / 60, meanStall = 0, lastMotion = -Infinity, lastWork = -Infinity, coveredNow = () => false;
  const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // (every frame, from adopt(): the camera moved or turned since the last one)
  const watchCamera = () => {
    if (camera.position.distanceToSquared(lastPosition) < 1e-4 && 1 - Math.abs(camera.quaternion.dot(lastTurn)) < 1e-7) return;
    lastPosition.copy(camera.position);
    lastTurn.copy(camera.quaternion);
    lastMotion = clock();
  };
  const costly = () => meanStall > STALL_COSTLY;
  const covered = () => { try { return Boolean(coveredNow()) || globalThis.document?.visibilityState === 'hidden'; } catch { return false; } };
  const flying = () => clock() - lastMotion < STILL_MS;
  // The frames around one background compile: returns a function that stops the watch and answers the compile's
  // stall (ms): the longest gap between two animation frames while it ran, over the usual gap (itself learnt from
  // the gaps that were not stalls). No frames (a hidden tab), no stall
  const watchFrames = () => {
    if (typeof requestAnimationFrame !== 'function') return () => 0;
    let last = clock(), worst = 0, on = true, whole = false;
    const tick = () => {
      if (!on) return;
      const now = clock(), gap = now - last;
      last = now;
      if (gap > worst) worst = gap;
      // (the first gap began mid-frame: it may hold the stall, but it is no measure of a usual frame)
      if (whole && gap > 4 && gap < usual * 1.5) usual += (gap - usual) * 0.05;
      whole = true;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return () => {
      on = false;
      return Math.max(0, worst - usual);
    };
  };
  const timed = (stall) => {
    stats.compiles++;
    stats.blockedMs += stall;
    if (stall > stats.maxStallMs) stats.maxStallMs = stall;
    meanStall += (stall - meanStall) * 0.3;
    lastWork = clock();
  };

  const drawable = (o) => (o.isMesh || o.isLine || o.isPoints || o.isSprite) && o.material && o.geometry;
  const hold = (o) => { if (!held.has(o)) { held.set(o, o.layers.mask); o.layers.mask = 0; } };
  const release = (o) => { if (held.has(o)) { o.layers.mask = held.get(o); held.delete(o); } };
  const layersOf = (o) => held.get(o) ?? o.layers.mask;
  const shown = (o) => { for (let n = o; n; n = n.parent) if (!n.visible) return false; return true; };

  const enlist = (o) => {
    known.add(o);
    const key = Array.isArray(o.material) ? o : o.material;
    let job = byMaterial.get(key);
    // (a material whose job is done already: this object may still be another vertex layout, a job of its own)
    if (!job || job.done) {
      job = { objects: [], done: false, busy: false, everywhere: false };
      byMaterial.set(key, job);
      jobs.push(job);
    }
    job.objects.push(o);
    if (everywhere.has(o)) job.everywhere = true;
    hold(o);
  };

  // Every drawable of the scene into its job, all of them waiting (again: after a rebuild every pipeline is another)
  const collect = () => {
    run++;
    for (const o of [...held.keys()]) release(o);
    jobs = [];
    byMaterial = new Map();
    for (const name of EVERYWHERE) world.modules[name]?.traverse((o) => everywhere.add(o));
    scene.traverse((o) => { if (drawable(o)) enlist(o); });
  };

  // What a module added since: it waits like the rest (called every frame; a few thousand nodes to walk)
  const adopt = () => {
    watchCamera();
    if (!started) return;
    let added = false;
    scene.traverse((o) => {
      if (known.has(o) || !drawable(o)) return;
      enlist(o);
      added = true;
    });
    if (added) start();
  };

  // Where an object is for the camera: { seen (in the frustum, or never culled), distance, size (radius / distance) }
  const place = (o, from) => {
    const bounds = o.isInstancedMesh ? (o.boundingSphere || (o.computeBoundingSphere(), o.boundingSphere)) : (o.geometry.boundingSphere || (o.geometry.computeBoundingSphere(), o.geometry.boundingSphere));
    if (!bounds || !Number.isFinite(bounds.radius)) return { seen: true, spread: true, distance: 0, size: 1 };
    sphere.copy(bounds).applyMatrix4(o.matrixWorld);
    const centre = sphere.center.distanceTo(from);
    return {
      seen: !o.frustumCulled || frustum.intersectsSphere(sphere), spread: sphere.radius > SPREAD,
      distance: Math.max(0, centre - sphere.radius), size: sphere.radius / Math.max(centre, 1)
    };
  };
  const look = () => {
    camera.updateMatrixWorld();
    matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(matrix, camera.coordinateSystem, camera.reversedDepth);
  };

  // The objects of a job that compileAsync() has to see: one of each kind for plain meshes (three keys a shader by
  // the material, the vertex layout, the winding and whether the object receives shadows, and the others' draws find
  // it in its cache), every instanced mesh (keyed by the mesh), every multi-material one
  const kindOf = (o) => {
    if (o.isInstancedMesh || o.count > 1 || Array.isArray(o.material)) return null;
    const g = o.geometry;
    let kind = `${o.type},${o.receiveShadow},${o.castShadow},${g.index ? 'i' : ''},${o.matrixWorld.determinant() < 0}`;
    for (const name of Object.keys(g.attributes).sort()) {
      const a = g.attributes[name];
      kind += `,${name}:${a.itemSize}:${a.normalized ? 'n' : ''}:${a.data ? a.data.stride : ''}:${a.offset || ''}`;
    }
    return kind;
  };
  const units = (job) => {
    const kinds = new Set();
    return job.objects.filter((o) => {
      const kind = kindOf(o);
      if (kind === null) return true;
      if (kinds.has(kind)) return false;
      kinds.add(kind);
      return true;
    });
  };

  // The material the shadow pass draws `material`'s casters with. three r186.1 has one override material per light
  // and rewrites its nodes, side and alpha test for every caster as it draws; compileAsync() cannot follow that (it
  // builds after the override has been put back), so the same material is made here for it to compile: same class,
  // same nodes, same state, hence the same WGSL and the same pipeline key as the shadow pass will ask for.
  const shadowTwin = (material) => {
    let entry = twins.get(material);
    if (!entry || entry.version !== material.version) {
      const { colorNode, depthNode, positionNode } = renderer._getShadowNodes(material);
      const twin = new THREE.NodeMaterial();
      twin.isShadowPassMaterial = true;
      twin.name = 'ShadowMaterial';
      twin.blending = THREE.NoBlending;
      twin.fog = false;
      twin.colorNode = colorNode || vec4(0, 0, 0, 1);
      if (depthNode) twin.depthNode = depthNode;
      if (positionNode) twin.positionNode = positionNode;
      twin.side = material.shadowSide !== null ? material.shadowSide : SHADOW_SIDE[material.side];
      twin.alphaTest = material.alphaTest;
      twin.alphaMap = material.alphaMap;
      twin.displacementMap = material.displacementMap;
      twin.displacementScale = material.displacementScale;
      twin.displacementBias = material.displacementBias;
      // (to the letter, null included: the value is part of the pipeline's key)
      twin.transparent = material.transparent || material.transmission > 0 ||
        (material.transmissionNode && material.transmissionNode.isNode) || (material.backdropNode && material.backdropNode.isNode);
      entry = { version: material.version, twin };
      twins.set(material, entry);
    }
    return entry.twin;
  };

  const castsShadows = (o) => renderer.shadowMap.enabled && lighting.sunLight.castShadow && lighting.sunLight.shadow.map &&
    o.castShadow && !Array.isArray(o.material) && layersOf(o) & lighting.sunLight.shadow.getCamera(0).layers.mask;

  // One object's pipeline for the scene pass (shadows: false) or the sun's shadow map. compileAsync() projects the
  // object and notes its render context before its first await, then builds: so the object is made drawable (shown,
  // on its layers, never culled, alone, for the shadow map with its twin material) and the renderer pointed at the
  // pass's target only for that call, and everything is put back before a frame can be drawn in between.
  // The scene pass renders nested in the post-processing chain (call depth 1) while compileAsync() files its work
  // under a top-level render's context: without the patch of the contexts' get() the first frame would build every
  // render object again.
  const contexts = renderer._renderContexts, getContext = contexts.get;
  const precompile = (o, shadows) => {
    const { scenePass, sceneMRT } = passes();
    const sun = lighting.sunLight.shadow;
    const eye = shadows ? sun.getCamera(0) : camera;
    if (!(layersOf(o) & eye.layers.mask)) return Promise.resolve();
    const before = { visible: o.visible, culled: o.frustumCulled, mask: o.layers.mask, material: o.material, children: o.children, target: renderer.getRenderTarget(), mrt: renderer.getMRT() };
    let promise;
    try {
      o.visible = true;
      o.frustumCulled = false;
      o.layers.mask = layersOf(o);
      o.children = [];
      if (shadows) o.material = shadowTwin(o.material);
      renderer.setRenderTarget(shadows ? sun.map : scenePass.renderTarget);
      renderer.setMRT(shadows ? null : sceneMRT);
      contexts.get = (target = null, m = null, depth = 0) => getContext.call(contexts, target, m, target === scenePass.renderTarget ? 1 : depth);
      promise = renderer.compileAsync(o, eye, scene);
    } catch (e) {
      promise = Promise.reject(e);
    } finally {
      contexts.get = getContext;
      renderer.setMRT(before.mrt);
      renderer.setRenderTarget(before.target);
      o.material = before.material;
      o.children = before.children;
      o.layers.mask = before.mask;
      o.frustumCulled = before.culled;
      o.visible = before.visible;
    }
    // (what fails here the frame that first draws it compiles instead, as it always could)
    return promise.catch((e) => console.warn('[compile]', o.name || o.type, e));
  };

  const finish = (job) => {
    job.done = true;
    job.busy = false;
    for (const o of job.objects) release(o);
  };
  const progress = () => {
    const total = jobs.length, done = jobs.reduce((n, job) => n + (job.done ? 1 : 0), 0);
    for (const fn of listeners) { try { fn({ done, total, pending: total - done }); } catch (e) { console.warn('[compile]', e); } }
  };

  // The first view (see the header): each compile starts in a task of its own, since compileAsync() keeps one
  // precompilation state on the renderer, which must not be mid-step for two of them in the same microtask checkpoint
  async function first(progressive, onProgress = () => {}) {
    collect();
    const mine = run;
    look();
    const near = [];
    let wanted = jobs.filter((job) => {
      let nearest = Infinity;
      for (const o of job.objects) {
        if (!shown(o)) continue;
        if (!progressive || job.everywhere) return true;
        const p = place(o, camera.position);
        if (p.seen && !p.spread && (p.distance < NEAR || p.size > LARGE)) nearest = Math.min(nearest, p.distance - p.size);
      }
      if (nearest < Infinity) near.push([nearest, job]);
      return false;
    });
    // (nearest first, the larger on screen of two as near)
    wanted = wanted.concat(near.sort((a, b) => a[0] - b[0]).slice(0, FIRST_FEW).map(([, job]) => job));
    // What a first-view job holds that is not shown now stays with it where a shown object of its kind compiles (the
    // terrain's other levels of detail: they must be there the moment the camera moves) and is otherwise another job,
    // for the background (the props beyond their draw distance, each an instanced mesh with a shader build of its
    // own: on a desktop a sixth of the compile's time)
    for (const job of wanted) {
      job.busy = job.first = true;
      const now = job.objects.filter(shown), kinds = new Set(now.map(kindOf));
      const later = job.objects.filter((o) => !now.includes(o) && !(kindOf(o) !== null && kinds.has(kindOf(o))));
      if (!later.length) continue;
      const waiting = new Set(later);
      // (the shown ones first: they are the ones compiled)
      job.objects = [...now, ...job.objects.filter((o) => !now.includes(o) && !waiting.has(o))];
      jobs.push({ objects: later, done: false, busy: false, everywhere: job.everywhere });
    }
    // (a job's objects in turn, as its first build serves the rest; the jobs side by side)
    const groups = wanted.map(units);
    let done = 0, total = groups.reduce((n, group) => n + group.length, 0);
    const pool = async (lists, shadows) => {
      let next = 0;
      const worker = async () => {
        while (next < lists.length && mine === run) {
          for (const o of lists[next++]) {
            await nextTask();
            await precompile(o, shadows);
            onProgress(++done / total);
          }
        }
      };
      await Promise.all(Array.from({ length: COMPILE_POOL }, worker));
    };
    await pool(groups, false);
    // (then the shadow map's, which exists once a lit material has been built)
    const casters = groups.map((group) => group.filter(castsShadows)).filter((group) => group.length);
    total += casters.reduce((n, group) => n + group.length, 0);
    await pool(casters, true);
    lastWork = clock();
    if (mine !== run) return;
    for (const job of wanted) finish(job);
    progress();
  }

  // The next job for the background: what is shown and in view first, then by distance (to the camera, or to where a
  // flight is heading: `ahead`), and what is hidden last. With `onlyNeeded` (the camera is being flown on a device
  // where a compile stalls) only what cannot wait: shown, and in view within NEEDED_NEAR metres or large on screen,
  // or within NEEDED_AHEAD of where the flight ends; LATER when something waits but nothing of that kind
  const nextJob = (ahead, onlyNeeded = false) => {
    look();
    let best = null, bestScore = Infinity, waiting = false;
    for (const job of jobs) {
      if (job.done || job.busy) continue;
      waiting = true;
      let score = Infinity, needed = false;
      for (const o of job.objects) {
        const p = place(o, camera.position), visible = shown(o);
        let d = p.seen ? p.distance : p.distance + 4000;
        if (visible && p.seen && (p.distance < NEEDED_NEAR || p.size > LARGE)) needed = true;
        if (ahead) {
          const there = place(o, ahead).distance;
          d = Math.min(d, there);
          if (visible && there < NEEDED_AHEAD) needed = true;
        }
        if (!visible) d += 1e6;
        if (d < score) score = d;
      }
      if (onlyNeeded && !needed) continue;
      if (score < bestScore) { bestScore = score; best = job; }
    }
    return best || (onlyNeeded && waiting ? LATER : null);
  };

  let aheadOf = () => null;
  const idle = []; // stop()'s promises, for the loop to resolve as it ends
  async function background() {
    if (working) return;
    working = true;
    const mine = run;
    try {
      for (;;) {
        // (see the header: where compiles stall, the camera in motion gets only what it is about to see)
        const hurried = costly() && flying() && !covered();
        const job = mine === run ? nextJob(aheadOf(), hurried) : null;
        if (job === LATER) {
          await pause(WAIT_MS);
          continue;
        }
        if (!job) break;
        job.busy = true;
        for (const o of units(job)) {
          await nextTask();
          if (mine !== run) return;
          const stalled = watchFrames();
          await precompile(o, false);
          if (mine === run && castsShadows(o)) await precompile(o, true);
          await nextFrame();
          const stall = stalled();
          timed(stall);
          // the rest after a compile that stalled, while the camera is in motion
          if (mine === run && costly() && flying() && !covered()) await pause(Math.min(REST_MAX, Math.max(REST_MIN, stall * REST_SHARE)));
        }
        if (mine !== run) return;
        finish(job);
        progress();
      }
    } finally {
      working = false;
      for (const resolve of idle.splice(0)) resolve();
      // (a rebuild meanwhile: its own start() found this loop still winding down)
      if (mine !== run && started) start();
    }
  }
  let started = false;
  function start() {
    started = true;
    background();
  }

  return {
    first, start, adopt,
    /** Stops the background (a rebuild follows: first() collects the scene again); resolves once it has wound down. */
    stop() {
      started = false;
      run++;
      return working ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve();
    },
    /** fn({ done, total, pending }) whenever a job is compiled; returns the unsubscriber. */
    onProgress(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** fn() -> Vector3 | null: where the camera is flying to, if it is (its objects come first). */
    set ahead(fn) { aheadOf = fn; },
    /** fn() -> boolean: something covers the view (the full map, a sheet): the background need not spare the frames. */
    set covered(fn) { coveredNow = fn; },
    /** The background compiles so far: { compiles, blockedMs (the sum of their stalls), maxStallMs } (see the header). */
    get stats() { return { compiles: stats.compiles, blockedMs: Math.round(stats.blockedMs), maxStallMs: Math.round(stats.maxStallMs) }; },
    /** When the last compile ended (performance.now()'s clock; -Infinity before any): the frames around it stall. */
    get lastWork() { return lastWork; },
    /** For ?debug: the pacing as it stands. */
    get pace() { return { meanStallMs: +meanStall.toFixed(1), usualFrameMs: +usual.toFixed(1), costly: costly(), flying: flying(), covered: covered() }; },
    get pending() { return jobs.reduce((n, job) => n + (job.done ? 0 : 1), 0); },
    get total() { return jobs.length; },
    /** For ?debug: the jobs as they stand. */
    debug: () => {
      look();
      return jobs.map((job) => {
        const o = job.objects[0], material = [].concat(o.material)[0];
        const places = job.objects.filter(shown).map((x) => place(x, camera.position));
        return {
          name: o.name || o.parent?.name || o.type, material: `${material.name || material.type}#${material.id}`, objects: job.objects.length,
          done: job.done, first: Boolean(job.first), everywhere: job.everywhere, shown: places.length, seen: places.some((p) => p.seen),
          distance: Math.round(Math.min(...places.map((p) => p.distance))), size: +Math.max(...places.map((p) => (p.seen ? p.size : 0))).toFixed(3)
        };
      });
    }
  };
}

/**
 * The render pipeline of `world` seen through `camera`, as in js/main.js: an MRT scene pass, half-resolution SSR on
 * glossy surfaces, bloom & colour grading. Returns { pipeline, grade, scenePass, sceneMRT, ssrPass, simulate(dt),
 * render(), compile(onProgress), warmUp(), setPost({ ssr, bloom }), rebuild(settings), compiler }; pipeline is the
 * one in use.
 * settings: a quality tier's (js/donostia/quality.js). msaa: the scene pass's samples. ssr: false builds the scene
 * pass without the normal & metalness targets SSR reads (two fewer attachments to fill, two thirds of the pass's
 * colour memory). With them, setPost() turns SSR and bloom off and on in a running view: each combination is a render
 * pipeline of its own over the same scene pass, built the first time it is asked for, so nothing in the scene
 * recompiles. await rebuild(settings) makes the passes again for other structural settings (MSAA, the SSR targets; shadows
 * at all are the world's, applyWorldStructure()): every pipeline of the scene is another after it, so compile() and
 * warmUp() follow, as at start-up.
 * compile() is the first view's shaders and warmUp() a first frame; the rest compile in the background after it
 * (createCompiler() above; settings.progressive says how much the first view is).
 */
export function createView(renderer, world, camera, { settings = TIERS.ultra } = {}) {
  const { scene, lighting, liveSky, terrain, updaters } = world;
  shareOpaqueShadowPrograms(renderer);
  shareInstancedPrograms(renderer);

  const maxSSRRoughness = 0.75;
  let scenePass = null, sceneMRT = null, ssrPass = null, reflections = null, color = null;
  let progressive = Boolean(settings.progressive);
  // The post-processing variants (SSR or not, bloom or not), each with its colour grade; `grade` speaks to all of
  // them, and to the ones built later through the preset or look applied last
  const variants = new Map();
  let post = null, lastLook = null, lastPreset = null, wantedPost = settings;

  const buildPasses = (s) => {
    for (const v of variants.values()) {
      v.pipeline.dispose();
      v.grade.dispose();
    }
    variants.clear();
    ssrPass?.dispose();
    scenePass?.dispose();
    sceneMRT = ssrPass = reflections = null;
    // (the samples are the pass's own: the renderer's `antialias` only ever was their default, and a tier picked in a
    // running city changes them)
    scenePass = pass(scene, camera, { samples: s.msaa ? 4 : 0 });
    scenePass.renderTarget.storeMultisampledColorBuffer = false;
    if (s.ssr) {
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
    color = scenePass.getTextureNode('output');
    if (s.ssr) {
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
  };

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
    wantedPost = { ssr: withSsr, bloom: withBloom };
    post = variant(Boolean(withSsr && reflections), Boolean(withBloom));
  };
  buildPasses(settings);
  setPost(settings);
  // (one object for as long as the view lives: the HUD and the real-time sky keep it across a rebuild)
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

  const compiler = createCompiler(renderer, world, camera, () => ({ scenePass, sceneMRT }));

  let elapsed = 0;
  const simulate = (dt) => {
    elapsed += dt;
    terrain.update(camera.position);
    // the real-time switch's sun, moon & weather first: what follows reads the lights it sets
    liveSky?.update(dt);
    lighting.update(camera.position);
    for (const update of updaters) update(dt, elapsed, camera);
    // (what the updaters added to the scene waits for its pipelines like the rest)
    compiler.adopt();
  };

  // The first view's pipelines, behind the loading screen (or the note of a quality change)
  async function compile(onProgress = () => {}) {
    // An empty frame first: it sets up the post-processing chain, which configures the scene pass's render target
    // (MSAA samples, depth format), so the pipelines compiled below are the very ones the scene pass asks for
    scene.visible = false;
    post.pipeline.render();
    scene.visible = true;
    simulate(0); // pick the terrain's levels of detail & the trees in reach for this camera
    await compiler.first(progressive, onProgress);
  }

  // A frame with frustum culling off, so the render objects of everything the first view holds (and whatever
  // compile() could not reach) exist before the loading screen lifts; the background takes over from here.
  // Terrain chunks of every level share one pipeline: the current levels do.
  function warmUp() {
    const culled = [];
    scene.traverse((o) => {
      if (o.frustumCulled && !o.userData.sharesPipelineWith) { culled.push(o); o.frustumCulled = false; }
    });
    post.pipeline.render();
    for (const o of culled) o.frustumCulled = true;
    compiler.start();
  }

  // The passes again, for other structural settings (see the header). Every render object goes first (three r186.1
  // internals: the renderer's render objects): three keeps their shaders by what the materials and the lights look
  // like, not by when they were built, and one from before the change would come back with it. With the sun's shadows
  // turned off and on again that is a shader holding the shadow node three disposed in between.
  async function rebuild(s) {
    await compiler.stop();
    renderer._objects.dispose();
    progressive = Boolean(s.progressive);
    buildPasses(s);
    setPost(wantedPost);
  }

  return {
    get pipeline() { return post.pipeline; },
    get scenePass() { return scenePass; },
    get sceneMRT() { return sceneMRT; },
    get ssrPass() { return ssrPass; },
    grade, simulate, render: () => post.pipeline.render(), compile, warmUp, setPost, rebuild, compiler
  };
}

// --- the page --------------------------------------------------------------------------------------------------------------

let deviceLost = false; // (its message outranks the "Could not start" of a load it breaks)
let unsupported = false; // (so does "no WebGPU")
let analytics = null; // the usage analytics (js/donostia/analytics.js), from initApp() on

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
  // The usage analytics: a few events to PostHog, with the visitor's cookie or cookieless (js/donostia/consent.js asks
  // once the city shows); nothing on localhost, with ?debug, under a harness or for a browser that asks not to be
  // tracked. The load funnel starts here, with the page view and whether WebGPU is there at all; every event says
  // the interface it happened in (the language, touch or mouse, the orientation, the display mode).
  analytics = initAnalytics({ readInterface: interfaceReader({ win: window, doc: document, getLang }) });
  // The visit's summary goes whenever the page is hidden, not only as it unloads: a phone kills a tab in the
  // background without telling it. Back in view (or out of the back/forward cache), the visit carries on.
  window.addEventListener('pagehide', () => analytics.hide('pagehide'));
  window.addEventListener('pageshow', (e) => { if (e.persisted) analytics.show(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') analytics.hide('hidden');
    else analytics.show();
  });
  analytics.track('$pageview');
  analytics.track('app_start', { webgpu: Boolean(navigator.gpu) });
  const consent = initConsent(analytics);

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
  // (.is-halted and data-error are there for the stylesheet: the message is the whole page now; 'webgpu' also shows
  // index.html's note on what the city needs)
  const halt = (text, kind = 'load') => {
    if (loadingOverlay) loadingOverlay.dataset.error = kind;
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
    analytics.track('app_unsupported', { reason: navigator.gpu ? 'no_adapter' : 'no_api' });
    if (loadingFill?.parentElement) loadingFill.parentElement.style.visibility = 'hidden';
    halt(reason, 'webgpu');
    return;
  }

  // What the last visit left behind (js/donostia/crash-guard.js): whether it died in view, loading or running, and
  // how many boots in a row have
  const env = readEnvironment(adapter);
  const storageOf = (name) => { try { return window[name] || null; } catch { return null; } };
  const guard = createCrashGuard({ storage: storageOf('localStorage'), session: storageOf('sessionStorage'), mobile: detectTier(env).mobile });
  const lastVisit = guard.previous;
  // (sent at once, not with the next batch a few seconds on: this load may die where the last one did)
  const URGENT = { send_instantly: true };
  const recoveryProps = (toTier) => ({
    from_tier: lastVisit.failedTier, to_tier: toTier, last_stage: lastVisit.lastStage, fails: lastVisit.fails, shown: lastVisit.shown,
    real_time: lastVisit.lastLive, ran_s: Math.round(lastVisit.ranMs / 1000), after_s: Math.round(lastVisit.agoMs / 1000), same_tab: lastVisit.sameTab
  });
  if (lastVisit.halt) {
    // The lowest tier died too, more than once in a row: no further attempt on its own. The message, and a button
    // for one more (the note is left as it is: a reload shows this again)
    analytics.track('app_recovered', { ...recoveryProps(null), lowered: false, halted: true }, URGENT);
    if (loadingFill?.parentElement) loadingFill.parentElement.style.visibility = 'hidden';
    halt('This device ran out of memory for the city, even at the lowest quality. Close other tabs and apps, then try again.', 'memory');
    const retry = document.createElement('button');
    retry.id = 'loading-retry';
    retry.type = 'button';
    retry.className = 'panel tool-btn';
    retry.style.marginTop = '14px';
    retry.textContent = t('loading.retry');
    retry.addEventListener('click', () => {
      guard.retry();
      location.reload();
    });
    (loadingStatus || loadingOverlay)?.after(retry);
    return;
  }

  // The quality tier the city boots with: ?quality=, the choice remembered, or what the device looks like; lighter
  // than the tier that died if the last visit did
  const booted = quality.init({
    env, search: location.search,
    recovery: lastVisit.fails > 0 ? { failedTier: lastVisit.failedTier, fails: lastVisit.fails, dropPick: lastVisit.dropPick } : null
  });
  // From here on this load keeps its own note: every step of the load, a heartbeat once the city shows, and the
  // clean ways out (a reload, a closed tab, the back/forward cache), which are not deaths
  guard.begin({ tier: booted.tier, mode: booted.mode, pick: booted.source === 'stored' ? booted.mode : null, hidden: document.visibilityState === 'hidden' });
  window.addEventListener('pagehide', () => guard.leave());
  window.addEventListener('pageshow', (e) => { if (e.persisted) guard.resume(); });
  document.addEventListener('visibilitychange', () => guard.hidden(document.visibilityState === 'hidden'));
  if (booted.recovered) {
    // said under the loading screen's line, in the HUD's language, for as long as the load takes
    const line = document.getElementById('loading-recovery');
    if (line) {
      const tier = t(`quality.${booted.tier}`);
      line.textContent = t(booted.recovered.to !== booted.recovered.from ? 'recovery.lowered' : 'recovery.again', { tier });
      line.hidden = false;
    }
  }
  const settings = booted.settings;
  const pixelRatioNow = () => quality.viewport(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
  console.log(`[quality] ${booted.tier} (${booted.source}${booted.mode === 'auto' ? `: ${quality.debug().detected.reasons.join('; ')}` : ''}), pixel ratio ${pixelRatioNow()}`);
  // the quality on every event from here on, and its changes (a pick in the settings sheet, a step of the governor)
  analytics.setQuality(quality.get());
  quality.onChange((state) => analytics.setQuality(state));
  // (a death found now: one event, with the tier this load starts at in its place)
  if (lastVisit.failed) analytics.track('app_recovered', { ...recoveryProps(booted.tier), lowered: booted.tier !== lastVisit.failedTier, halted: false }, URGENT);

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
    analytics.track('app_unsupported', { reason: 'no_device' });
    renderer.domElement.remove();
    halt('WebGPU could not start on this device (the browser gave no GPU device). Close other tabs and reload, or try another browser.', 'webgpu');
    return;
  }
  // the coarse device on every event: the GPU's vendor & architecture as WebGPU reports them, cores, memory, pixel ratio
  analytics.setDevice(deviceInfo({ navigator, devicePixelRatio: window.devicePixelRatio, adapterInfo: adapter.info || renderer.backend.device?.adapterInfo }));
  // A lost GPU device (a driver reset, the GPU process crashing...) leaves three drawing nothing: the view would freeze
  // on its last frame under a HUD that still moves. Stop, and say so over the loading screen.
  const threeDeviceLost = renderer.onDeviceLost;
  // On a phone the usual cause is the system taking the GPU's memory back, most often while the page is in the
  // background: the page then reloads itself when it is looked at again (once: a second loss within a minute stays on
  // the message), and on auto the next start is a quality tier lower (quality.deviceLost()).
  renderer.onDeviceLost = (info) => {
    threeDeviceLost.call(renderer, info); // (logs it, stops rendering)
    deviceLost = true;
    analytics.track('gpu_lost', { after: analytics.after, reason: String(info.reason || info.message || 'device lost').slice(0, 100), hidden: document.visibilityState === 'hidden' });
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
  const markInit = (label) => {
    const now = performance.now();
    timings.push(`${label} ${Math.round(now - mark)}ms`);
    analytics.mark(label, now - mark);
    mark = now;
    guard.stage(label);
  };

  const world = await buildWorld(renderer, { status, mark: markInit, settings });
  const { scene, lighting, terrain, updaters } = world;
  analytics.track('world_built');

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

  // A small note over the view while something is still coming: the shaders of what lies beyond the first view (the
  // background of createCompiler()), or a quality tier being applied. The page makes it itself (the HUD's files need
  // not know): #compile-note for a stylesheet that wants it elsewhere, and a 'slop-compile' event on window with
  // { stage: 'applying' | 'details' | 'done', done, total } for a HUD that would rather say it its own way (it can
  // then hide the note).
  const note = document.createElement('div');
  note.id = 'compile-note';
  note.setAttribute('role', 'status');
  // (its looks in a style element ahead of the page's stylesheets, so a rule of theirs for #compile-note wins)
  const noteStyle = document.createElement('style');
  noteStyle.textContent = '#compile-note{position:fixed;left:50%;bottom:calc(8px + env(safe-area-inset-bottom, 0px));transform:translateX(-50%);' +
    'z-index:20;padding:3px 11px;border-radius:999px;background:rgba(10,16,22,0.62);color:#fff;font:500 11px/1.4 system-ui,sans-serif;' +
    'letter-spacing:0.02em;white-space:nowrap;pointer-events:none;opacity:0;transition:opacity 0.35s}#compile-note.is-on{opacity:1}';
  document.head.prepend(noteStyle);
  document.body.appendChild(note);
  const say = (stage, done = 0, total = 0) => {
    const share = total ? ` ${Math.round(100 * done / total)}%` : '';
    note.textContent = stage === 'applying' ? `Applying quality…${share}` : stage === 'details' ? `Loading details…${share}` : note.textContent;
    note.classList.toggle('is-on', stage !== 'done');
    try { window.dispatchEvent(new CustomEvent('slop-compile', { detail: { stage, done, total } })); } catch { /* no events here */ }
    // (the analytics' details_ready: the first time nothing is left to compile behind the city)
    if (stage === 'done') analytics.details({ shaders_total: view.compiler.total, ...compileStats() });
    // the crash guard's stage once the city shows: 'details' while shaders compile behind it, 'applying', 'running'
    if (shown) guard.stage(stage === 'done' ? 'running' : stage);
  };

  // Quality changes in the running city (a pick in the HUD, a step of the governor): the tier's live settings, the
  // drawing buffer's size when the pixel ratio moved, and for a tier picked by hand its structural settings
  const setPixelRatio = (ratio) => {
    if (ratio === pixelRatio) return;
    pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
  };
  // The structural settings the world and the view are built for, and their change in the running city: the world's
  // part (applyWorldStructure()), the passes again, then the shaders as at start-up: the first view's under the note,
  // the rest in the background. The camera, the time of day and the HUD are not touched. One at a time: a pick made
  // meanwhile is applied when this one is through.
  // The view does not go black meanwhile (the new passes' first frame is an empty one): a copy of the last frame, on a
  // 2D canvas over the WebGPU one, stands in until the rebuilt city has drawn its first.
  let built = settings, restructuring = false, paused = false, shown = false, warmed = null, framed = null;
  const still = document.createElement('canvas');
  still.setAttribute('aria-hidden', 'true');
  still.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:none';
  container.appendChild(still);
  const holdFrame = () => new Promise((resolve) => {
    // (the loop copies the frame in the task that drew it; none comes in a hidden tab)
    const timer = setTimeout(() => { framed = null; resolve(); }, 400);
    framed = () => {
      clearTimeout(timer);
      try {
        still.width = renderer.domElement.width;
        still.height = renderer.domElement.height;
        still.getContext('2d').drawImage(renderer.domElement, 0, 0);
        still.style.display = 'block';
      } catch { /* no copy: the view shows the empty frame for a moment */ }
      resolve();
    };
  });
  const releaseGeometry = (tries) => {
    if (deviceLost || !built.releaseGeometry) return;
    if (releaseUploadedGeometry(renderer, [world.modules.terrain, world.modules.buildings]) > 0 && tries > 0) setTimeout(releaseGeometry, 4000, tries - 1);
  };
  const restructure = async () => {
    if (restructuring) return;
    restructuring = true;
    quality.busy(true);
    try {
      for (let state = quality.get(); needsRebuild(built, state.boot) && !deviceLost; state = quality.get()) {
        say('applying');
        if (!paused) await holdFrame();
        paused = true;
        // (a moment for the note to show before the main thread gets busy)
        await new Promise((resolve) => setTimeout(resolve, 50));
        const next = state.boot;
        await applyWorldStructure(world, renderer, next, built);
        await view.rebuild(next);
        built = next;
        applyWorldQuality(world, state.settings);
        view.setPost(state.settings);
        await view.compile((p) => say('applying', p, 1));
        if (deviceLost) return;
        // (the warm-up frame is the animation loop's: the passes render once per frame of its)
        await new Promise((resolve) => { warmed = resolve; });
        await renderer.backend.device.queue.onSubmittedWorkDone();
        releaseGeometry(30);
      }
    } catch (e) {
      console.error('[quality]', e);
    } finally {
      restructuring = paused = false;
      still.style.display = 'none';
      still.width = still.height = 1;
      quality.busy(false);
      if (!view.compiler.pending) say('done');
    }
  };
  quality.attach((state) => {
    applyWorldQuality(world, state.settings);
    view.setPost(state.settings);
    setPixelRatio(state.pixelRatio);
    // (before the city shows there is nothing to rebuild: it starts with the settings it was built for)
    if (shown && needsRebuild(built, state.boot)) restructure();
    else if (!restructuring) built = { ...built, releaseGeometry: state.boot.releaseGeometry, progressive: state.boot.progressive };
  });
  view.compiler.ahead = () => god.flight?.p1 || null;
  // (the full map, or a sheet or popover open over the view: nobody watches the frames behind it)
  view.compiler.covered = () => hud.mapOpen || Boolean(document.querySelector('[popover]:popover-open'));
  // the background compile's cost, for the analytics' details_ready
  const compileStats = () => {
    const { compiles, blockedMs, maxStallMs } = view.compiler.stats;
    return { bg_compiles: compiles, bg_blocked_ms: blockedMs, bg_stall_max_ms: maxStallMs };
  };
  view.compiler.onProgress(({ done, total, pending }) => {
    if (restructuring || !shown) return;
    say(pending ? 'details' : 'done', done, total);
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
      // the shader compiler (createCompiler()): compiler.pending, compiler.total, compiler.debug() (the jobs)
      get compiler() { return view.compiler; },
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
    guard.beat();
  });
  markInit('compile');
  if (deviceLost) return;
  analytics.track('shaders_compiled');

  renderer.setAnimationLoop((now) => {
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(Math.max(raw, 0.001), 0.05);
    if ((hud.mapOpen || paused) && !first && !warmed) {
      // The full map covers the whole view: no world to simulate or draw (the canvas keeps its last frame). The
      // camera still finishes a flight. Nor while a quality tier is being applied: the scene is between two states.
      god.update(dt);
    } else {
      simulate(dt);
      if (first) {
        view.warmUp();
        markInit('warm-up');
      } else if (warmed) {
        view.warmUp();
        warmed();
        warmed = null;
      }
      view.render();
      if (framed) {
        framed();
        framed = null;
      }
      // the governor: the frame rate of the frames that drew the world (a hidden tab's or a hitch's interval is not
      // one, and it sorts those out itself). Not the frames around a shader compile: a phone's browser stalls for
      // every pipeline, which says nothing of what the device holds once they are made (js/donostia/quality.js)
      if (governing && performance.now() - view.compiler.lastWork > COMPILE_SHADOW_MS) quality.frame(now - lastFrame);
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
        // the city shows: the funnel's app_ready, with what is left to compile behind it, and the cookie card
        analytics.ready({ shaders_pending: view.compiler.pending, shaders_total: view.compiler.total });
        consent.setReady();
        governing = true;
        shown = true;
        // (the boot succeeded: the count of failed boots starts again)
        guard.shown();
        if (view.compiler.pending) say('details', view.compiler.total - view.compiler.pending, view.compiler.total);
        else analytics.details({ shaders_total: view.compiler.total, ...compileStats() }); // (nothing was left for the background)
        if (!view.compiler.pending) guard.stage('running');
        // the CPU copies of the terrain's & the buildings' vertex buffers, now on the GPU; the stragglers (what the
        // warm-up frame did not draw) every few seconds until none is left
        releaseGeometry(30);
        // (a tier picked while the city was loading)
        if (needsRebuild(built, quality.get().boot)) restructure();
      });
    }
    frames++;
    fpsTime += raw;
    if (fpsTime >= 0.25) {
      const fps = Math.round(frames / fpsTime);
      hud.update(fps);
      // (under the full map, or while a tier is applied, nothing renders: that rate is not the city's)
      analytics.tick({
        compiling: view.compiler.pending > 0,
        fps: hud.mapOpen || paused ? NaN : fps, x: god.position.x, z: god.position.z, altitude: god.position.y,
        moving: !god.flight && god.velocity.length() > MOVE_SPEED, yaw: god.yaw, pitch: god.pitch, flight: Boolean(god.flight)
      });
      frames = 0;
      fpsTime = 0;
    }
    if (now > saveAt) {
      save();
      saveAt = now + 4000;
      // the crash guard's heartbeat: alive, at this tier, in real time or not
      guard.beat({ tier: quality.get().tier, realTime: live.liveEnabled() });
    }
  });
}

// (imported headless by the benchmark: no page to run)
if (typeof window !== 'undefined') {
  initApp().catch((e) => {
    console.error(e);
    if (deviceLost || unsupported) return; // (already explained)
    analytics?.error(e);
    document.getElementById('loading-overlay')?.removeAttribute('aria-busy');
    const s = document.getElementById('loading-status');
    if (s) s.textContent = `Could not start: ${e.message}`;
  });
}
