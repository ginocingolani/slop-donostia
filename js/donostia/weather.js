import * as THREE from 'three/webgpu';
import {
  Fn, float, ivec2, vec2, vec3, vec4, uniform, attribute, varying, varyingProperty, instanceIndex, positionGeometry,
  cameraPosition, cameraWorldMatrix, time, sin, fract, floor, mod, dot, cross, normalize, length, abs, max, min, mix,
  smoothstep, step, pow, select, clamp, mrt, textureLoad
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { weatherUniforms } from './weather-uniforms.js';
import { liveEnabled, liveSnapshot } from './live-state.js';
import { precipitation, windVector, gustFactor, wetnessTarget, stepWetness, strikeRate, Lightning } from './weather-model.js';
import { pointInRing } from './landmarks/geom.js';

// js/donostia/weather.js
// The real-time weather's effects (the HUD's real-time switch; live-state.js's weather, its numbers worked out by
// weather-model.js):
// - Precipitation: drizzle, rain, showers, a storm's slanting downpour and snow, drawn as one instanced draw of
//   camera-facing streaks (flakes in snow) in a box that follows the camera. The drops keep their places in the city
//   as it moves (the box wraps them round), fall at their kind's speed and drift and slant with the wind; one too thin
//   for a pixel is drawn a pixel wide and as much fainter. They take the sky's light (the hemisphere light the time of
//   day sets), the street lamps' warm glints at night and the lightning's flash. A shelter map round the camera (1 m:
//   the ground, the sea's surface, the buildings' eaves, holes and all; the ground over a tunnel) keeps them out from
//   under roofs, arcades and tunnels, and the rain's splashes, some of the same draw's instances, land on its surface.
// - Lightning in a storm: flashes at random intervals that light the sky, the scene and the rain for a moment (over
//   whatever the time of day has set: the hemisphere light, the environment's intensity, the sky's exposure), now and
//   then with a bolt (a second draw, only while it shows); thunder after its distance's delay is an event
//   (userData.onThunder) for whatever plays sounds.
// - Wetness: cityUniforms.uRainWetness wets the streets (ground.js), the facades' feet & the roofs (facade-material.js)
//   and darkens the dry sand, on top of the time of day's own uRoadWetness; it rises within minutes under the rain and
//   dries over an hour or so after it, on the city's clock (live-state.js's time, which a debug rate can speed up).
// - Wind: weatherUniforms turn the trees' sway (trees-material.js) and the flags (the tifo's, Alderdi Eder's
//   ikurriña) to the real wind, its speed and its gusts.
// With the switch off nothing draws (the meshes are hidden) and every uniform holds its default: today's picture.
// buildWeather({ GEO, terrain, lighting, renderer, seaLevel }) -> Object3D (seaLevel: a function giving the water's level);
// its userData.update(dt, elapsed, camera) runs every frame.

// The box of drops round the camera (m). The drops' fall is the integral of the wind & fall speed on the CPU, wrapped
// at WRAP; the drops fall at 0.8 .. 1.2 times it in steps of 0.1, so a wrap moves each by a multiple of 0.1 * WRAP = 120
// m, which every side of the box divides: the wrap never shows
const BOX = new THREE.Vector3(30, 24, 30);
const WRAP = 1200;
const MAX_DROPS = 60000;
// the camera's place in the box, up from its floor; the floor no lower than a metre under the ground beneath
const BELOW = 0.42;
// the share of the drops that are splashes on the ground instead (rain only), within SPLASH_REACH m of the camera, each
// a crown of SPLASH_SIZE m living SPLASH_LIFE s
const SPLASH_SHARE = 0.12, SPLASH_REACH = 12, SPLASH_SIZE = 0.1, SPLASH_LIFE = 0.4;
// the shelter map: SHELTER x SHELTER cells of 1 m round the camera (the box and a margin), refilled once the camera is
// SHELTER_SLACK m off its centre
const SHELTER = 64, SHELTER_SLACK = 12;
const EASE = 3; // s: the effects' time constant towards a new weather (it changes in 15-minute steps)
const WIND_EASE = 6; // s

// Effects that leave the normal & metalness buffers the SSR pass reads as they are (landmarks/igeldo.js's effectMRT)
const effectMRT = mrt({ normal: vec4(0.0), metalRough: vec4(0.0) });

// Dave Hoskins' hashes without sine (as ground.js's hash12) of a drop's index
const hash11 = Fn(([p]) => {
  const q = fract(float(p).mul(0.1031)).toVar();
  q.mulAssign(q.add(33.33));
  q.mulAssign(q.add(q));
  return fract(q);
});
const hash31 = Fn(([p]) => {
  const p3 = fract(vec3(p).mul(vec3(0.1031, 0.103, 0.0973))).toVar();
  p3.addAssign(dot(p3, p3.yzx.add(33.33)));
  return fract(p3.xxy.add(p3.yzz).mul(p3.zyx));
});

// --- precipitation -------------------------------------------------------------------------------------------------------

function precipitationMesh(shelter) {
  const u = {
    origin: uniform(new THREE.Vector3()), // the box's lowest corner
    offset: uniform(new THREE.Vector3()), // the fall so far (m, wrapped)
    velocity: uniform(new THREE.Vector3(0, -6, 0)), // m/s of a drop at the mean speed
    length: uniform(0.25), // m
    width: uniform(0.0015), // m
    alpha: uniform(0), // 0 until the weather sets it (the compile frame draws one invisible drop)
    snow: uniform(0), // 0 rain streaks .. 1 flakes
    pixel: uniform(0.001), // m a pixel spans per metre of distance
    colour: uniform(new THREE.Color(0.5, 0.5, 0.5)), // the light a drop sends back (sky, sun, flash)
    glint: uniform(new THREE.Color(0, 0, 0)), // the street lamps' warm light at night
    ground: uniform(0), // the ground's height under the camera
    shelterOrigin: uniform(new THREE.Vector2()), // the shelter map's corner (x, z)
    splashes: uniform(0), // the instances below this index are splashes
    splashAlpha: uniform(0)
  };

  // one quad per drop: x across (-1..1), y along (0..1)
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0], 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.instanceCount = 1;

  // (double-sided in one pass: three draws a transparent double-sided material twice otherwise, back faces first)
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  mat.name = 'WeatherPrecipitation';
  mat.mrtNode = effectMRT;

  const i = float(instanceIndex);
  const r = hash31(i.add(0.37));
  const speed = floor(hash11(i.add(71.7)).mul(5)).mul(0.1).add(0.8); // 0.8 .. 1.2
  const sparkle = hash11(i.add(913.1));
  const g = positionGeometry;
  const vAcross = varying(g.x, 'vDropAcross'), vAlong = varying(g.y, 'vDropAlong');
  const vAlpha = varyingProperty('float', 'vDropAlpha'), vGlint = varyingProperty('float', 'vDropGlint');
  const vSplash = varyingProperty('float', 'vDropSplash');
  // the cover over a place (m): a drop under it is out of the rain (outside the map: none)
  const coverAt = (xz) => {
    const c = floor(xz.sub(u.shelterOrigin));
    const inMap = step(0, c.x).mul(step(0, c.y)).mul(step(c.x, SHELTER - 1)).mul(step(c.y, SHELTER - 1));
    const h = textureLoad(shelter, ivec2(clamp(c, 0, SHELTER - 1))).x;
    return mix(float(-1e4), h, inMap);
  };

  mat.positionNode = Fn(() => {
    const box = vec3(BOX.x, BOX.y, BOX.z);
    const p = r.mul(box).add(u.offset.mul(speed));
    const q = u.origin.add(mod(p.sub(u.origin), box)).toVar();
    // snowflakes wander as they fall
    const wander = vec3(sin(time.mul(0.7).add(r.x.mul(37.0))), 0.0, sin(time.mul(0.55).add(r.z.mul(29.0)))).mul(0.45);
    q.addAssign(wander.mul(u.snow));
    // a splash: each lands again every SPLASH_LIFE s, somewhere new round the camera, on the surface there
    const splash = step(i, u.splashes.sub(0.5));
    const cycle = time.div(SPLASH_LIFE).add(r.y);
    const life = fract(cycle);
    const at = hash31(i.add(floor(cycle).mul(7.31)));
    const sr = at.x.sqrt().mul(SPLASH_REACH), sa = at.y.mul(Math.PI * 2);
    const sxz = cameraPosition.xz.add(vec2(sr.mul(sin(sa)), sr.mul(sin(sa.add(Math.PI / 2)))));
    const sy = coverAt(sxz);
    q.assign(mix(q, vec3(sxz.x, sy.add(SPLASH_SIZE * 0.3), sxz.y), splash));
    vSplash.assign(splash.mul(life.mul(0.98).add(0.02)));
    const sheltered = step(q.y, coverAt(q.xz)).mul(float(1).sub(splash));
    const toCam = cameraPosition.sub(q).toVar();
    const dist = length(toCam).toVar();
    const view = toCam.div(max(dist, 0.001));
    const right = normalize(cameraWorldMatrix.mul(vec4(1, 0, 0, 0)).xyz);
    const up = normalize(cameraWorldMatrix.mul(vec4(0, 1, 0, 0)).xyz);
    // a streak lies along its fall, turned to face the camera; seen end-on (from right above or below) it shrinks to
    // a dot. A flake faces the camera.
    const dir = normalize(u.velocity);
    const across = cross(dir, view);
    const side = normalize(mix(right, across.div(max(length(across), 0.0001)), smoothstep(0.02, 0.08, length(across))));
    const axis = normalize(mix(dir, up, u.snow));
    const sideV = normalize(mix(side, right, u.snow));
    // a pixel wide at the least, and as much fainter
    const pix = dist.mul(u.pixel);
    const w = mix(max(u.width, pix.mul(1.3)), float(SPLASH_SIZE), splash);
    const len = mix(mix(max(u.length.mul(speed), pix.mul(2.0)), w, u.snow), w.mul(0.7), splash);
    // fade near the camera (no streak across the face), and towards the box's sides so its edges never show
    const centre = u.origin.add(box.mul(vec3(0.5, BELOW, 0.5)));
    const edge = abs(q.sub(centre)).div(box.mul(0.5));
    const fade = smoothstep(0.35, 1.4, dist).mul(smoothstep(1.0, 0.7, max(edge.x, edge.z)))
      .mul(smoothstep(1.55, 1.2, abs(q.y.sub(centre.y)).div(BOX.y * 0.5)));
    vAlpha.assign(mix(pow(u.width.div(w), 0.6).mul(fade).mul(u.alpha), u.splashAlpha.mul(smoothstep(SPLASH_REACH, SPLASH_REACH * 0.6, dist)), splash)
      .mul(sparkle.mul(0.5).add(0.75)).mul(float(1).sub(sheltered)));
    // the street lamps' light on the drops low over the streets round the camera, a glint on one in a few
    vGlint.assign(smoothstep(12.0, 3.0, q.y.sub(u.ground)).mul(smoothstep(22.0, 5.0, dist)).mul(step(0.86, sparkle).mul(0.85).add(0.15)));
    // a splash's quad stands upright, facing the camera; a drop under cover folds away
    const axisS = mix(axis, vec3(0, 1, 0), splash);
    const sideS = normalize(mix(sideV, normalize(vec3(view.z, 0.0, view.x.negate()).add(vec3(0.0001, 0, 0))), splash));
    return mix(q.add(sideS.mul(g.x.mul(w).mul(0.5))).add(axisS.mul(g.y.sub(0.5).mul(len))), q, sheltered);
  })();

  mat.colorNode = Fn(() => {
    // a streak: brightest along its middle line, tapering to its ends; a flake: a soft disc
    const streak = float(1).sub(vAcross.mul(vAcross)).mul(sin(vAlong.mul(Math.PI)).max(0).sqrt());
    const disc = smoothstep(1.0, 0.35, length(vec2(vAcross, vAlong.sub(0.5).mul(2.0))));
    // a splash: a crown of droplets thrown up and out, widening and fading through its life
    const sp = vec2(vAcross, vAlong.sub(0.15).mul(1.6));
    const crownR = vSplash.mul(0.85).add(0.1);
    const crown = smoothstep(0.16, 0.0, abs(length(sp).sub(crownR))).mul(step(0.0, sp.y)).mul(float(1).sub(vSplash));
    const shape = mix(mix(streak, disc, u.snow), crown, step(0.001, vSplash));
    const rgb = vec3(u.colour).add(vec3(u.glint).mul(vGlint));
    return vec4(rgb, clamp(shape.mul(vAlpha), 0, 1));
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'WeatherPrecipitation';
  mesh.frustumCulled = false; // the drops surround the camera
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3; // over the sea & the sky (drawn after them among the transparent objects)
  mesh.userData.uniforms = u;
  return mesh;
}

// --- the shelter map -------------------------------------------------------------------------------------------------------

// The height under which a drop is out of the rain, per metre round the camera: the ground (the terrain over a tunnel
// included), the water's surface, a building's eaves (inside its outer ring and out of its courtyards). A float
// texture the drop shader reads with textureLoad; refilled on the CPU when the camera has moved SHELTER_SLACK m off its
// centre or the water has risen or fallen 5 cm.
class ShelterMap {
  constructor(GEO, terrain, seaLevel) {
    this.terrain = terrain;
    this.seaLevel = seaLevel;
    this.buildings = GEO?.buildings || [];
    this.data = new Float32Array(SHELTER * SHELTER).fill(-1e4);
    this.texture = new THREE.DataTexture(this.data, SHELTER, SHELTER, THREE.RedFormat, THREE.FloatType);
    this.texture.magFilter = this.texture.minFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
    this.texture.needsUpdate = true;
    this.origin = new THREE.Vector2(1e9, 1e9);
    this.level = NaN;
    this.cells = null;
  }

  // buildings by 64 m cell (their rings' bounds), built the first time it rains
  index() {
    const cells = new Map();
    this.boxes = [];
    this.buildings.forEach((b, k) => {
      const ring = b.g?.[0];
      if (!ring || !(b.eave > -1e3)) return;
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < ring.length; i += 2) {
        x0 = Math.min(x0, ring[i]); x1 = Math.max(x1, ring[i]);
        z0 = Math.min(z0, ring[i + 1]); z1 = Math.max(z1, ring[i + 1]);
      }
      this.boxes[k] = [x0, z0, x1, z1];
      for (let j = Math.floor(z0 / 64); j <= Math.floor(z1 / 64); j++) {
        for (let i = Math.floor(x0 / 64); i <= Math.floor(x1 / 64); i++) {
          const key = i * 65536 + j;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(k);
        }
      }
    });
    return cells;
  }

  update(camera) {
    const cam = camera.position;
    const level = this.seaLevel();
    const half = SHELTER / 2;
    if (Math.abs(cam.x - (this.origin.x + half)) < SHELTER_SLACK && Math.abs(cam.z - (this.origin.y + half)) < SHELTER_SLACK &&
      Math.abs(level - this.level) < 0.05) return;
    this.level = level;
    const ox = Math.round(cam.x) - half, oz = Math.round(cam.z) - half;
    this.origin.set(ox, oz);
    const d = this.data;
    for (let j = 0; j < SHELTER; j++) {
      for (let i = 0; i < SHELTER; i++) d[j * SHELTER + i] = Math.max(this.terrain ? this.terrain.heightAt(ox + i + 0.5, oz + j + 0.5) : 0, level);
    }
    if (!this.cells) this.cells = this.index();
    const seen = new Set();
    for (let cj = Math.floor(oz / 64); cj <= Math.floor((oz + SHELTER) / 64); cj++) {
      for (let ci = Math.floor(ox / 64); ci <= Math.floor((ox + SHELTER) / 64); ci++) {
        for (const k of this.cells.get(ci * 65536 + cj) || []) {
          if (seen.has(k)) continue;
          seen.add(k);
          const b = this.buildings[k], [x0, z0, x1, z1] = this.boxes[k];
          const i0 = Math.max(0, Math.floor(x0 - ox)), i1 = Math.min(SHELTER - 1, Math.floor(x1 - ox));
          const j0 = Math.max(0, Math.floor(z0 - oz)), j1 = Math.min(SHELTER - 1, Math.floor(z1 - oz));
          for (let j = j0; j <= j1; j++) {
            for (let i = i0; i <= i1; i++) {
              const x = ox + i + 0.5, z = oz + j + 0.5;
              if (!pointInRing(x, z, b.g[0])) continue;
              let hole = false;
              for (let h = 1; h < b.g.length && !hole; h++) hole = pointInRing(x, z, b.g[h]);
              if (!hole) d[j * SHELTER + i] = Math.max(d[j * SHELTER + i], b.eave);
            }
          }
        }
      }
    }
    this.texture.needsUpdate = true;
  }
}

// --- lightning ------------------------------------------------------------------------------------------------------------

// A bolt: a jagged channel from the cloud base to the ground with a branch or two, as a ribbon turned to the camera
// (aTangent: the channel's direction at the vertex; x of the position: which side). Rebuilt for every strike.
const BOLT_SEGMENTS = 48, BOLT_BRANCHES = 3, BOLT_BRANCH_SEGMENTS = 14;
function boltMesh() {
  const u = { light: uniform(0), width: uniform(4) };
  const verts = (BOLT_SEGMENTS + 1 + BOLT_BRANCHES * (BOLT_BRANCH_SEGMENTS + 1)) * 2;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(verts * 3), 3));
  geo.setAttribute('aTangent', new THREE.Float32BufferAttribute(new Float32Array(verts * 4), 4));
  const index = [];
  const strip = (first, n) => {
    for (let k = 0; k < n; k++) {
      const a = first + 2 * k;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  };
  strip(0, BOLT_SEGMENTS);
  for (let b = 0; b < BOLT_BRANCHES; b++) strip((BOLT_SEGMENTS + 1 + b * (BOLT_BRANCH_SEGMENTS + 1)) * 2, BOLT_BRANCH_SEGMENTS);
  geo.setIndex(index);

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, forceSinglePass: true
  });
  mat.name = 'WeatherBolt';
  mat.fog = false; // dimmed by the rain's visibility on the CPU instead
  mat.mrtNode = effectMRT;
  const T = attribute('aTangent', 'vec4'); // xyz direction, w: width share (thinner down the branches) x side
  const vSide = varying(T.w.sign(), 'vBoltSide');
  mat.positionNode = Fn(() => {
    const p = positionGeometry;
    const view = normalize(cameraPosition.sub(p));
    const side = normalize(cross(T.xyz, view));
    return p.add(side.mul(T.w.mul(u.width).mul(0.5)));
  })();
  mat.colorNode = vec4(vec3(0.85, 0.88, 1.0).mul(u.light), smoothstep(1.0, 0.0, abs(vSide)).max(0.35));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'WeatherBolt';
  mesh.frustumCulled = false;
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3;
  mesh.userData.uniforms = u;
  return mesh;
}

// A channel's points from `top` down to `bottom` (midpoint displacement: a long zigzag with fine kinks on it)
function channel(top, bottom, n, jag, random) {
  const pts = [top.clone(), bottom.clone()];
  let rough = top.distanceTo(bottom) * jag;
  while (pts.length < n + 1) {
    const next = [pts[0]];
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      const m = a.clone().add(b).multiplyScalar(0.5);
      m.x += (random() - 0.5) * rough;
      m.z += (random() - 0.5) * rough;
      m.y += (random() - 0.5) * rough * 0.3;
      next.push(m, b);
    }
    pts.length = 0;
    pts.push(...next);
    rough *= 0.55;
  }
  // resample to n + 1 points by index
  const out = [];
  for (let k = 0; k <= n; k++) out.push(pts[Math.round((k / n) * (pts.length - 1))]);
  return out;
}

// --- values the time of day sets and the lightning brightens -------------------------------------------------------------

// The flash goes over whatever the time of day (lighting.js) last set and comes off again: a value that differs from the
// one written last frame is a new base
class Boost {
  constructor(get, set, colour = false) {
    this.get = get;
    this.set = set;
    this.colour = colour;
    this.base = colour ? new THREE.Color() : 0;
    this.written = null;
  }

  apply(f, fn) {
    const cur = this.get();
    if (cur === undefined || cur === null) return;
    if (f <= 0) {
      if (this.written !== null && this.same(cur, this.written)) this.set(this.colour ? this.base.clone() : this.base);
      this.written = null;
      return;
    }
    if (this.written === null || !this.same(cur, this.written)) this.base = this.colour ? cur.clone() : cur;
    const v = fn(this.colour ? this.base.clone() : this.base, f);
    this.set(v);
    this.written = this.colour ? v.clone() : v;
  }

  same(a, b) {
    return this.colour ? a.equals(b) : a === b;
  }
}

// --- build -----------------------------------------------------------------------------------------------------------------

export function buildWeather({ GEO = null, terrain, lighting, renderer = null, seaLevel = () => 0 }) {
  const group = new THREE.Group();
  group.name = 'Weather';
  const shelter = new ShelterMap(GEO, terrain, seaLevel);
  const rain = precipitationMesh(shelter.texture);
  const bolt = boltMesh();
  group.add(rain, bolt);
  const R = rain.userData.uniforms, B = bolt.userData.uniforms;

  const W = weatherUniforms;
  const defaults = {
    windDir: W.uWindDir.value.clone(), sway: W.uWindSway.value, lean: W.uWindLean.value, gust: W.uGustPhase.value,
    flagStream: W.uFlagStream.value, flagFlap: W.uFlagFlap.value, flagPhase: W.uFlagPhase.value
  };
  // the state the effects ease through
  const s = {
    on: false, wet: 0, lastDate: null, density: 0, fall: 6.5, length: 0.24, width: 0.0015, alpha: 0.5, snow: 0,
    windX: defaults.windDir.x, windZ: defaults.windDir.y, speed: 3, gust: 5, rainfall: 0, flash: 0, hold: null,
    boltLight: 0, boltFade: 1
  };
  const lightning = new Lightning(20261029);
  const thunderListeners = new Set();
  const thunders = []; // { at (s of `elapsed`), strike }
  let clock = 0, compiled = false, wetOverride = null;

  const scene = () => {
    let root = group;
    while (root.parent) root = root.parent;
    return root.isScene ? root : null;
  };
  const hemi = lighting?.hemiLight, sun = lighting?.sunLight;
  const boosts = [
    hemi && new Boost(() => hemi.intensity, (v) => { hemi.intensity = v; }),
    hemi && new Boost(() => hemi.color, (v) => hemi.color.copy(v), true),
    hemi && new Boost(() => hemi.groundColor, (v) => hemi.groundColor.copy(v), true),
    new Boost(() => scene()?.environmentIntensity, (v) => { const sc = scene(); if (sc) sc.environmentIntensity = v; }),
    lighting?.uSkyExposure && new Boost(() => lighting.uSkyExposure.value, (v) => { lighting.uSkyExposure.value = v; }),
    lighting?.uNightSkyColor && new Boost(() => lighting.uNightSkyColor.value, (v) => lighting.uNightSkyColor.value.copy(v), true)
  ];
  // A flash lights the scene from the whole sky, bluish white: as bright as an overcast day's light at night, a fraction
  // of it over a day's own (`dark`: 1 at night .. 0.3 by day, set every frame)
  const FLASH_SKY = new THREE.Color(0.75, 0.8, 1.0), FLASH_GROUND = new THREE.Color(0.42, 0.44, 0.52);
  const FLASH_NIGHT_SKY = new THREE.Color(0.5, 0.54, 0.68);
  let dark = 1;
  const flashFns = [
    (base, f) => base + f * 3.2 * dark,
    (base, f) => base.lerp(FLASH_SKY, Math.min(1, f * 1.5 * dark)),
    (base, f) => base.lerp(FLASH_GROUND, Math.min(1, f * 1.5 * dark)),
    (base, f) => base + f * 0.8 * dark,
    (base, f) => base * (1 + f * 3 * dark),
    (base, f) => base.lerp(FLASH_NIGHT_SKY, Math.min(1, f * 1.2))
  ];
  const applyFlash = (f) => boosts.forEach((b, k) => b && b.apply(f, flashFns[k]));

  function rebuildBolt(strike, camera) {
    const random = Math.random;
    const b = strike.bearing * Math.PI / 180;
    const x = camera.position.x + Math.sin(b) * strike.distance, z = camera.position.z - Math.cos(b) * strike.distance;
    const ground = terrain ? terrain.heightAt(x, z) : 0;
    const top = new THREE.Vector3(x + (random() - 0.5) * 600, 1100 + random() * 500, z + (random() - 0.5) * 600);
    const main = channel(top, new THREE.Vector3(x, Math.max(ground, 0), z), BOLT_SEGMENTS, 0.28, random);
    const pos = bolt.geometry.attributes.position, tan = bolt.geometry.attributes.aTangent;
    let v = 0;
    const put = (pts, width) => {
      for (let k = 0; k < pts.length; k++) {
        const a = pts[Math.max(0, k - 1)], c = pts[Math.min(pts.length - 1, k + 1)];
        const d = c.clone().sub(a).normalize();
        const taper = width < 1 ? width * (1 - 0.6 * (k / (pts.length - 1))) : width; // branches thin out
        for (const sideSign of [-1, 1]) {
          pos.setXYZ(v, pts[k].x, pts[k].y, pts[k].z);
          tan.setXYZW(v, d.x, d.y, d.z, sideSign * taper);
          v++;
        }
      }
    };
    put(main, 1);
    for (let k = 0; k < BOLT_BRANCHES; k++) {
      const from = main[Math.floor(BOLT_SEGMENTS * (0.15 + random() * 0.5))];
      const len = 250 + random() * 450, a = random() * Math.PI * 2;
      const end = from.clone().add(new THREE.Vector3(Math.cos(a) * len * 0.7, -len, Math.sin(a) * len * 0.7));
      put(channel(from, end, BOLT_BRANCH_SEGMENTS, 0.35, random), 0.45);
    }
    pos.needsUpdate = tan.needsUpdate = true;
    // wider the further it is, so it never shrinks under a few pixels; dimmer through the rain's murk
    B.width.value = Math.max(4, strike.distance * 0.0025);
    s.boltFade = Math.exp(-strike.distance / Math.max(liveSnapshot().weather.visibility ?? 10000, 1500) * 0.6);
  }

  function reset() {
    W.uWindDir.value.copy(defaults.windDir);
    W.uWindSway.value = defaults.sway;
    W.uWindLean.value = defaults.lean;
    W.uGustPhase.value = defaults.gust;
    W.uFlagStream.value = defaults.flagStream;
    W.uFlagFlap.value = defaults.flagFlap;
    W.uFlagPhase.value = defaults.flagPhase;
    W.uFlagWind.value = 0;
    W.uRainfall.value = 0;
    cityUniforms.uRainWetness.value = 0;
    applyFlash(0);
    rain.visible = bolt.visible = false;
    s.density = 0;
    s.flash = 0;
    s.lastDate = null;
    thunders.length = 0;
  }

  const ease = (cur, target, dt, tau) => target + (cur - target) * Math.exp(-dt / tau);

  group.userData.update = (dt, elapsed, camera) => {
    // the shader-compile frame (dt 0, main.js's compile()) sees both meshes, one invisible drop and an empty bolt, so
    // their pipelines are built behind the loading screen; after it they hide until the weather needs them
    if (!compiled) {
      if (dt === 0) { rain.visible = bolt.visible = true; return; }
      compiled = true;
      rain.visible = bolt.visible = false;
    }
    const on = liveEnabled();
    if (!on) {
      if (s.on) { s.on = false; reset(); }
      return;
    }
    clock += dt;
    const snap = liveSnapshot();
    const weather = snap.weather;
    const wind = windVector(weather);
    const p = precipitation(weather);
    if (!s.on || s.snap) {
      // switched on: start as the weather stands (the streets as wet as it leaves them), no easing in; a debug snap
      // does the same but keeps the wetness
      if (!s.snap) s.wet = wetnessTarget(weather);
      s.on = true;
      s.snap = false;
      s.density = p.density;
      s.rainfall = p.particle === 'rain' ? p.density : 0;
      s.windX = wind.x; s.windZ = wind.z; s.speed = wind.speed; s.gust = wind.gust;
      if (p.kind !== 'none') Object.assign(s, { fall: p.fall, length: p.length, width: p.width, alpha: p.alpha, snow: p.particle === 'snow' ? 1 : 0 });
    }

    // --- wetness, on the city's clock ---
    const now = snap.date.getTime();
    const minutes = s.lastDate === null ? 0 : (now - s.lastDate) / 60000;
    s.lastDate = now;
    if (minutes < 0 || minutes > 24 * 60) s.wet = wetnessTarget(weather); // the clock was set back or far on: start over
    else s.wet = stepWetness(s.wet, weather, minutes, THREE.MathUtils.clamp(snap.sun.elevation / 20, 0, 1));
    if (wetOverride !== null) { s.wet = wetOverride; wetOverride = null; }
    cityUniforms.uRainWetness.value = s.wet;

    // --- wind ---
    s.windX = ease(s.windX, wind.x, dt, WIND_EASE);
    s.windZ = ease(s.windZ, wind.z, dt, WIND_EASE);
    s.speed = ease(s.speed, wind.speed, dt, WIND_EASE);
    s.gust = ease(s.gust, wind.gust, dt, WIND_EASE);
    const l = Math.hypot(s.windX, s.windZ) || 1;
    W.uWindDir.value.set(s.windX / l, s.windZ / l);
    const v = s.speed + (s.gust - s.speed) * gustFactor(clock, 11); // the wind now, gusts included (m/s)
    // the trees' sway against today's breeze (~4 m/s), and their steady lean (m at 11 m up)
    W.uWindSway.value = THREE.MathUtils.clamp(Math.pow(v / 4, 1.3), 0.2, 4.5);
    W.uWindLean.value = Math.min(1.5, 0.0045 * v * v);
    // the gusts roll across the city at the wind's speed (the shader's own 11 m/s plus this)
    W.uGustPhase.value = (W.uGustPhase.value + dt * (0.045 * v - 0.5)) % (Math.PI * 2);
    // flags stream once the wind is up, flapping faster and harder as it blows
    W.uFlagStream.value = THREE.MathUtils.smoothstep(v, 1.5, 5);
    W.uFlagFlap.value = THREE.MathUtils.clamp(0.6 + v / 8, 0.6, 2.5);
    W.uFlagPhase.value = (W.uFlagPhase.value + dt * 5.2 * (THREE.MathUtils.clamp(v / 5, 0.6, 2.6) - 1)) % (Math.PI * 2);
    W.uFlagWind.value = v;

    // --- precipitation ---
    s.density = ease(s.density, p.density, dt, EASE);
    if (p.kind !== 'none') {
      s.fall = ease(s.fall, p.fall, dt, EASE);
      s.length = ease(s.length, p.length, dt, EASE);
      s.width = ease(s.width, p.width, dt, EASE);
      s.alpha = ease(s.alpha, p.alpha, dt, EASE);
      s.snow = ease(s.snow, p.particle === 'snow' ? 1 : 0, dt, EASE);
    }
    s.rainfall = ease(s.rainfall, p.particle === 'rain' ? p.density : 0, dt, EASE);
    W.uRainfall.value = s.rainfall;
    const count = Math.round(MAX_DROPS * s.density);
    rain.visible = count > 0;
    if (rain.visible) {
      rain.geometry.instanceCount = count;
      // the drops drift with the wind (in the streets a little slower than the wind 10 m up), flakes more so
      const drift = v * (0.55 + 0.3 * s.snow);
      R.velocity.value.set(s.windX / l * drift, -s.fall, s.windZ / l * drift);
      const o = R.offset.value.addScaledVector(R.velocity.value, dt);
      o.set(((o.x % WRAP) + WRAP) % WRAP, ((o.y % WRAP) + WRAP) % WRAP, ((o.z % WRAP) + WRAP) % WRAP);
      const cam = camera.position;
      const ground = terrain ? terrain.heightAt(cam.x, cam.z) : 0;
      R.ground.value = ground;
      R.origin.value.set(cam.x - BOX.x / 2, Math.max(cam.y - BOX.y * BELOW, ground - 1), cam.z - BOX.z / 2);
      shelter.update(camera);
      R.shelterOrigin.value.copy(shelter.origin);
      R.splashes.value = Math.round(count * SPLASH_SHARE * (1 - s.snow));
      R.splashAlpha.value = 0.3 * s.rainfall / Math.max(s.density, 0.01);
      R.length.value = s.length;
      R.width.value = s.width;
      R.alpha.value = s.alpha;
      R.snow.value = s.snow;
      const h = renderer?.domElement?.height || 900;
      R.pixel.value = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov ?? 55) / 2)) / h;
      // the light a drop sends back: the sky's (the hemisphere light), a little of the sun's, the flash's; snow is
      // white and scatters more
      const c = R.colour.value;
      if (hemi) c.copy(hemi.color).multiplyScalar(hemi.intensity * (0.55 + 0.35 * s.snow));
      else c.setRGB(0.5, 0.5, 0.5);
      if (sun) c.r += sun.color.r * sun.intensity * 0.035, c.g += sun.color.g * sun.intensity * 0.035, c.b += sun.color.b * sun.intensity * 0.035;
      const night = THREE.MathUtils.smoothstep(cityUniforms.uInteriorGlow.value, 0.4, 1.1);
      R.glint.value.setRGB(1.0, 0.72, 0.42).multiplyScalar(night * 0.9);
    }

    // --- lightning ---
    const strike = lightning.update(clock, strikeRate(weather));
    if (strike) {
      if (strike.bolt) rebuildBolt(strike, camera);
      thunders.push({ at: clock + strike.thunder, strike });
    }
    for (let k = thunders.length - 1; k >= 0; k--) {
      if (clock < thunders[k].at) continue;
      for (const fn of thunderListeners) {
        try { fn(thunders[k].strike); } catch (e) { console.error('[weather]', e); }
      }
      thunders.splice(k, 1);
    }
    const flash = s.hold ?? lightning.flash(clock);
    s.flash = flash;
    dark = 1 - 0.7 * THREE.MathUtils.clamp(snap.sun.elevation / 12, 0, 1);
    applyFlash(flash);
    const current = lightning.current;
    bolt.visible = flash > 0.02 && !!current?.bolt;
    B.light.value = flash * 40 * s.boltFade;
    if (rain.visible && flash > 0) R.colour.value.addScalar(flash * 0.6 * dark);
  };

  // Thunder: fn(strike) when a strike's thunder reaches the city (strike: Lightning's shape); returns the unsubscribe
  group.userData.onThunder = (fn) => {
    thunderListeners.add(fn);
    return () => thunderListeners.delete(fn);
  };
  // Debug (slopDebug.weather in ?debug): strike({ distance, bearing, bolt }) now (a bolt is put at that bearing from the
  // camera, clockwise from north), hold(f) a flash of f (null lets go), snap() the eased rain & wind to the weather now,
  // setWetness(w) the streets' wetness now, state()
  group.userData.debug = {
    strike(options = {}) {
      const st = lightning.strike(clock, options);
      if (st.bolt && group.userData.camera) rebuildBolt(st, group.userData.camera);
      thunders.push({ at: clock + st.thunder, strike: st });
      return st;
    },
    hold(f = 1) { s.hold = f; return f; },
    snap() { s.snap = true; return true; },
    setWetness(w) { wetOverride = w; s.wet = w; return w; },
    state: () => ({ on: s.on, wet: s.wet, density: s.density, drops: rain.visible ? rain.geometry.instanceCount : 0, snow: s.snow,
      wind: { x: W.uWindDir.value.x, z: W.uWindDir.value.y, sway: W.uWindSway.value, lean: W.uWindLean.value }, flash: s.flash })
  };
  const update = group.userData.update;
  group.userData.update = (dt, elapsed, camera) => {
    group.userData.camera = camera;
    update(dt, elapsed, camera);
  };
  return group;
}
