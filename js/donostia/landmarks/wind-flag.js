import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, uv, time, sin, cos, abs, min, max, mix, step, smoothstep, positionGeometry, normalLocal, normalize
} from 'three/tsl';
import { weatherUniforms } from '../weather-uniforms.js';

// js/donostia/landmarks/wind-flag.js
// A flag that flies with the real-time weather's wind (js/donostia/weather.js through weatherUniforms): its cloth turns
// downwind from the pole, hangs at the pole in a calm and lifts as the wind rises, and its waves run out to the fly
// faster and deeper the harder it blows. The landmark that has a flag keeps its still one for the real-time switch's
// off position (alderdi-eder.js) and shows this one instead while it is on.
// - The ikurriña (the Basque flag): red, the green saltire under the white cross, its arms 1/14 of the height wide
//   (the official proportions, Euskal Herriko ikurriña, Law 1/1981 & Decree 8/1981 of the Basque Government).
// windFlag({ hoist: [x, y, z] (the cloth's top at the pole), width, height, colours }) -> Mesh (hidden).

const NX = 14, NY = 6; // cloth cells, fly x hoist

export function windFlag({
  hoist, width = 2.0, height = 1.15, red = [0.62, 0.02, 0.04], green = [0.0, 0.3, 0.1], white = [0.82, 0.82, 0.8]
}) {
  // the cloth: x out to the fly (0..1), y down from the top (0..1), as a grid
  const pos = [], uvs = [], index = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) { pos.push(i / NX, j / NY, 0); uvs.push(i / NX, 1 - j / NY); }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = j * (NX + 1) + i;
    index.push(a, a + 1, a + NX + 2, a, a + NX + 2, a + NX + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(pos.length).fill(0), 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(...hoist), width + height);

  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.75, metalness: 0 });
  mat.name = 'WindFlag';
  const { uWindDir, uFlagWind, uFlagPhase } = weatherUniforms;
  mat.positionNode = Fn(() => {
    const g = positionGeometry;
    const x = g.x.mul(width), y = g.y.mul(height);
    const v = uFlagWind;
    // the fly's droop: hanging nearly along the pole in a calm, near level in a gale
    const droop = float(Math.PI / 2 * 0.88).mul(float(1).sub(smoothstep(0.5, 7.0, v).mul(0.88)));
    const cd = cos(droop), sd = sin(droop);
    // waves running out to the fly, growing towards it: deeper & quicker in a stronger wind (uFlagPhase runs on with
    // it)
    const k = 2.6, arg = x.mul(k).sub(time.mul(5.2).add(uFlagPhase));
    const amp = mix(float(0.05), float(0.16), smoothstep(1.0, 12.0, v)).mul(g.x).mul(smoothstep(0.2, 2.0, v).mul(0.8).add(0.2));
    const wave = sin(arg).mul(amp);
    const slope = cos(arg).mul(amp).mul(k);
    // frame: d downwind (level), up, n across
    const d = normalize(vec3(uWindDir.x, 0, uWindDir.y));
    const up = vec3(0, 1, 0);
    const n = vec3(d.z.negate(), 0, d.x);
    // the hoist stays on the pole; the cloth sags from it by the droop (sheared down, so a limp flag hangs at the pole)
    const along = d.mul(cd).sub(up.mul(sd));
    normalLocal.assign(normalize(n.sub(along.mul(slope))));
    return vec3(...hoist).add(along.mul(x)).sub(up.mul(y)).add(n.mul(wave));
  })();
  mat.colorNode = Fn(() => {
    const f = uv(), aspect = width / height, px = f.x.mul(aspect), py = f.y;
    const crossW = step(abs(px.sub(aspect / 2)), 1 / 14).max(step(abs(py.sub(0.5)), 1 / 14));
    const nd = Math.hypot(1, aspect);
    const d1 = abs(px.sub(py.mul(aspect))).div(nd), d2 = abs(px.sub(py.oneMinus().mul(aspect))).div(nd);
    const saltire = step(min(d1, d2), 1 / 14);
    return mix(mix(vec3(...red), vec3(...green), saltire), vec3(...white), max(crossW, 0));
  })();

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'WindFlag';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  mesh.visible = false;
  return mesh;
}
