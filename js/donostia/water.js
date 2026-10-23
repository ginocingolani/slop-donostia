import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, mix, smoothstep, select, texture, positionWorld, time, sin, cos, normalize, max,
  mx_noise_float, cameraViewMatrix
} from 'three/tsl';

// js/donostia/water.js
// The Bay of Biscay at mean sea level (y = 0): one large plane tinted by the depth of the LiDAR & isobath sea floor
// under it — turquoise over La Concha's sand, deep blue past Santa Clara — with foam where it meets the shore and
// small moving ripples. Metallic enough for the SSR pass to mirror the city in it.

const SIZE = 60000;

function floorHeight(field) {
  const uv = positionWorld.xz.sub(vec2(field.x0, field.z0)).div(vec2(field.width, field.depth));
  return texture(field.heightTexture, uv).r;
}

export function createWater(terrain) {
  const { core, context } = terrain;
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const inCore = p.x.greaterThan(core.x0 + core.res).and(p.x.lessThan(core.x0 + core.width - core.res))
    .and(p.z.greaterThan(core.z0 + core.res)).and(p.z.lessThan(core.z0 + core.depth - core.res));
  const inContext = p.x.greaterThan(context.x0).and(p.x.lessThan(context.x0 + context.width))
    .and(p.z.greaterThan(context.z0)).and(p.z.lessThan(context.z0 + context.depth));
  const seaFloor = select(inCore, floorHeight(core), select(inContext, floorHeight(context), float(-60)));
  const depth = max(seaFloor.negate(), 0.0);

  mat.colorNode = Fn(() => {
    const shallow = vec3(0.045, 0.32, 0.30), mid = vec3(0.02, 0.14, 0.17), deep = vec3(0.008, 0.045, 0.075);
    const c = mix(mix(shallow, mid, smoothstep(0.5, 6.0, depth)), deep, smoothstep(6.0, 25.0, depth)).toVar();
    const n = mx_noise_float(vec3(p.x.mul(0.4), time.mul(0.6), p.z.mul(0.4)));
    const foam = smoothstep(0.9, 0.05, depth).mul(smoothstep(-0.3, 0.6, n));
    return mix(c, vec3(0.85, 0.88, 0.86), foam);
  })();

  // Two crossing swell trains plus noise for the small chop, as a tangent-space tilt of the up vector
  mat.normalNode = Fn(() => {
    const t = time;
    const a = p.x.mul(0.11).add(p.z.mul(0.05)).add(t.mul(0.9));
    const b = p.x.mul(-0.04).add(p.z.mul(0.13)).add(t.mul(1.3));
    const n = mx_noise_float(vec3(p.x.mul(0.9), t.mul(0.8), p.z.mul(0.9)));
    const dx = cos(a).mul(0.05).add(sin(b).mul(0.02)).add(n.mul(0.03));
    const dz = cos(b).mul(0.05).add(sin(a).mul(0.02)).sub(n.mul(0.03));
    // normalNode is view space (as in tsl-materials' water)
    return cameraViewMatrix.transformDirection(normalize(vec3(dx.negate(), 1, dz.negate())));
  })();
  mat.roughnessNode = float(0.06);
  mat.metalnessNode = select(depth.lessThan(0.6), float(0.05), float(0.35));

  const geo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
  geo.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'DonostiaWater';
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}
