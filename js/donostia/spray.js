import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, vec4, attribute, uniform, uv, time, positionGeometry, cameraPosition, normalize, cross, length, fract,
  floor, sin, mix, max, smoothstep, clamp, select, abs, mrt
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { sprayPlaces } from './sea-state.js';

// js/donostia/spray.js
// Spray in a big swell (js/donostia/sea-state.js: from ~2 m, the real-time switch on): where the open swell runs into
// steep shore (the Paseo Nuevo's wall, the Peine del Viento's rocks, the Zurriola dike, the port's moles, the cliffs of
// Igeldo, Ulia and Santa Klara), each wave that breaks there throws up a burst of white water, timed to the swell's
// period, as high as the swell is big. The places come from the water's own fields (data/donostia/water.png's exposure,
// tools/donostia/build.mjs) and the terrain: water exposed to the swell, a few metres deep, beside land that is not a
// beach. Every burst is a handful of soft sprites facing the camera, thrown up and falling back under gravity as they
// spread and fade, one instanced draw for all of them; built the first time a big swell needs it, hidden otherwise.
// createSpray({ fields, context, terrain, seaLevel }) -> { mesh, update(spray, swellHeight, period) }.

const PER_BURST = 7; // sprites a burst
const G = 9.81;
const hash = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };

function sprayMaterial(seaLevel, U) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  // (as the ferries' wakes: the water's normal & glossiness under the spray go, so it reflects nothing)
  mat.mrtNode = mrt({ normal: vec4(0.0), metalRough: vec4(0.0) });
  const place = attribute('aSprayPlace', 'vec4'); // x, z, phase, strength
  const drop = attribute('aSprayDrop', 'vec4'); // spread direction x, z (unit), launch (0..1), size (0..1)
  const T = U.period;
  // this wave's burst here: seconds since the crest hit, and whether it throws spray (most do in a big swell)
  const cycle = time.div(T).add(place.z).toVar();
  const wave = floor(cycle);
  const t = fract(cycle).mul(T).toVar();
  const lucky = fract(sin(wave.mul(12.9898).add(place.x.mul(0.0781)).add(place.y.mul(0.0613))).mul(43758.5453));
  const fires = smoothstep(U.chance.sub(0.08), U.chance, lucky).oneMinus().mul(place.w);
  // the plume: up to the swell's height and more, at a launch speed that reaches it, spreading out and falling back
  const top = U.height.mul(mix(float(1.0), float(3.2), drop.z)).mul(place.w.mul(0.6).add(0.4));
  const v0 = top.mul(2 * G).sqrt();
  const flight = v0.mul(2 / G).add(0.8).toVar();
  const rise = max(v0.mul(t).sub(t.mul(t).mul(G * 0.5)), float(0.0));
  const spread = vec3(drop.x, 0.0, drop.y).mul(t.mul(top.sqrt().mul(0.9).add(1.0)));
  const centre = vec3(place.x, seaLevel.add(0.3), place.y).add(spread).add(vec3(0.0, rise, 0.0)).toVar();
  const life = t.div(flight).toVar();
  const size = U.height.mul(0.7).add(1.5).mul(drop.w.mul(0.8).add(0.6)).mul(life.mul(1.4).add(0.5));
  const alpha = fires.mul(smoothstep(0.0, 0.06, life)).mul(float(1.0).sub(smoothstep(0.45, 1.0, life))).mul(U.amount);

  mat.positionNode = Fn(() => {
    const toCam = cameraPosition.sub(centre);
    const dir = normalize(toCam).toVar();
    const pole = select(abs(dir.y).greaterThan(0.99), vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0));
    const right = normalize(cross(pole, dir)).toVar(), up = cross(dir, right);
    // folded away between bursts
    const s = select(alpha.greaterThan(0.004).and(life.lessThan(1.0)), size, float(0.0));
    return centre.add(right.mul(positionGeometry.x.mul(s))).add(up.mul(positionGeometry.y.mul(s)));
  })();

  const shade = attribute('aSprayDrop', 'vec4').w;
  mat.colorNode = Fn(() => {
    // white water in the light of the sky and the sun, dimmed at dusk & night (as the wakes)
    const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
    const lit = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSunColor, 0.55).mul(0.92).add(0.08);
    return lit.mul(float(1.0).sub(night.mul(0.85))).mul(shade.mul(0.15).add(0.85));
  })();
  mat.opacityNode = Fn(() => {
    // a soft, lumpy puff
    const q = uv().sub(0.5).mul(2.0);
    const r = length(q);
    const lumps = sin(q.x.mul(7.0).add(drop.x.mul(11.0))).mul(sin(q.y.mul(6.0).add(drop.y.mul(9.0)))).mul(0.12);
    return clamp(float(1.0).sub(r.add(lumps)), 0.0, 1.0).pow(1.3).mul(alpha);
  })();
  return mat;
}

/**
 * The spray's mesh, hidden until update(spray > 0): spray (0..1, sea-state.js), the swell's height (m) and period (s).
 */
export function createSpray({ fields, context, terrain, seaLevel }) {
  const places = sprayPlaces(fields, context, (x, z) => terrain.heightAt(x, z));
  if (!places.length) return null;
  const quad = new THREE.PlaneGeometry(2, 2);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.setIndex(quad.index);
  const n = places.length * PER_BURST;
  const placeA = new Float32Array(n * 4), dropA = new Float32Array(n * 4);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  places.forEach((p, k) => {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
    for (let s = 0; s < PER_BURST; s++) {
      const i = k * PER_BURST + s, a = hash(i * 3 + 1) * Math.PI * 2, r = 0.3 + 0.7 * hash(i * 3 + 2);
      placeA.set(p, i * 4);
      dropA.set([Math.cos(a) * r, Math.sin(a) * r, hash(i * 7 + 5), hash(i * 5 + 3)], i * 4);
    }
  });
  geo.setAttribute('aSprayPlace', new THREE.InstancedBufferAttribute(placeA, 4));
  geo.setAttribute('aSprayDrop', new THREE.InstancedBufferAttribute(dropA, 4));
  geo.instanceCount = n;
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, 10, (minZ + maxZ) / 2), Math.hypot(maxX - minX, maxZ - minZ) / 2 + 40);
  const U = { period: uniform(12), height: uniform(3), chance: uniform(0.7), amount: uniform(0) };
  const mesh = new THREE.Mesh(geo, sprayMaterial(seaLevel, U));
  mesh.name = 'SeaSpray';
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3; // after the sea & sky (main.js), with the other glows & wakes
  mesh.visible = false;
  mesh.userData.places = places;
  const update = (spray, swellHeight, period) => {
    mesh.visible = spray > 0.01;
    if (!mesh.visible) return;
    U.amount.value = Math.min(1, spray * 1.5);
    U.height.value = swellHeight;
    U.period.value = Math.max(4, period);
    // most waves of a big swell throw spray somewhere along a wall; a smaller one only now and then
    U.chance.value = 0.25 + 0.6 * spray;
  };
  return { mesh, update };
}
