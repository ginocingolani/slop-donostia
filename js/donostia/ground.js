import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, floor, fract, abs, mix, smoothstep, select, texture, positionWorld, normalWorld,
  mx_noise_float, max
} from 'three/tsl';

// js/donostia/ground.js
// Ground surface over the LiDAR terrain: the municipal 1:500 map classifies every 2 m cell of the core (road,
// sidewalk, garden, beach… see GROUND in tools/donostia/build.mjs); the four nearest classes are blended bilinearly so
// edges stay soft at street level, with noise variation and rock on steep natural slopes.

// Linear albedo per class id (GEO.terrain.classes)
const CLASS_COLOURS = [
  [0.20, 0.25, 0.12], // 0 natural (grass / scrub; rock is added by slope)
  [0.055, 0.055, 0.058], // 1 road asphalt
  [0.33, 0.31, 0.28], // 2 sidewalk paving
  [0.40, 0.36, 0.30], // 3 pedestrian streets & plazas (sandstone setts)
  [0.12, 0.22, 0.06], // 4 gardens, lawns & parterres
  [0.06, 0.11, 0.04], // 5 woodland floor
  [0.62, 0.52, 0.36], // 6 beach sand
  [0.30, 0.26, 0.18], // 7 sea & river floor (seen through the water)
  [0.22, 0.21, 0.20], // 8 under buildings (only visible at the walls' feet)
  [0.30, 0.06, 0.05], // 9 bidegorri (red bike lanes)
  [0.42, 0.40, 0.36], // 10 stairs
  [0.16, 0.14, 0.12] // 11 railway ballast
];

function classColour(id) {
  let c = vec3(...CLASS_COLOURS[0]);
  for (let k = 1; k < CLASS_COLOURS.length; k++) c = select(abs(id.sub(k)).lessThan(0.5), vec3(...CLASS_COLOURS[k]), c);
  return c;
}

// Bilinear blend of the class colours around the fragment
function blendedClasses(field) {
  const tex = field.classTexture;
  const size = vec2(field.w, field.h);
  const f = positionWorld.xz.sub(vec2(field.x0, field.z0)).div(field.res).sub(0.5);
  const i = floor(f), t = fract(f);
  const at = (dx, dz) => classColour(floor(texture(tex, i.add(vec2(dx + 0.5, dz + 0.5)).div(size)).r.mul(255).add(0.5)));
  return mix(mix(at(0, 0), at(1, 0), t.x), mix(at(0, 1), at(1, 1), t.x), t.y);
}

function centreClass(field) {
  const uv = positionWorld.xz.sub(vec2(field.x0, field.z0)).div(vec2(field.width, field.depth));
  return floor(texture(field.classTexture, uv).r.mul(255).add(0.5));
}

export function createGroundMaterial(terrain) {
  const { core, context } = terrain;
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const inCore = p.x.greaterThan(core.x0 + core.res).and(p.x.lessThan(core.x0 + core.width - core.res))
    .and(p.z.greaterThan(core.z0 + core.res)).and(p.z.lessThan(core.z0 + core.depth - core.res));
  const id = select(inCore, centreClass(core), centreClass(context));

  mat.colorNode = Fn(() => {
    const base = select(inCore, blendedClasses(core), blendedClasses(context)).toVar();
    const n1 = mx_noise_float(p.mul(0.35)), n2 = mx_noise_float(p.mul(0.045));
    // natural ground: grass on gentle slopes, rock & bare earth on steep ones, shore rock & wet sand near the sea
    const slope = float(1).sub(normalWorld.y);
    const rock = vec3(0.26, 0.24, 0.21).mul(float(0.85).add(n1.mul(0.25)));
    const isNatural = id.lessThan(0.5);
    const rocky = smoothstep(0.22, 0.42, slope.add(n1.mul(0.08))).max(smoothstep(3.0, 0.5, p.y).mul(0.8));
    base.assign(select(isNatural, mix(base.mul(float(0.85).add(n2.mul(0.3))), rock, rocky), base));
    // the sea floor darkens with depth; dry sand above the tide line is paler
    const depth = max(p.y.negate(), 0.0);
    base.assign(select(id.greaterThan(6.5).and(id.lessThan(7.5)), base.mul(mix(float(1), float(0.25), smoothstep(0.0, 20.0, depth))), base));
    base.assign(select(id.greaterThan(5.5).and(id.lessThan(6.5)), mix(base.mul(0.7), base, smoothstep(0.3, 2.5, p.y)), base));
    return base.mul(float(0.92).add(n1.mul(0.08)));
  })();
  mat.roughnessNode = select(id.greaterThan(0.5).and(id.lessThan(1.5)), float(0.72), float(0.9));
  mat.metalnessNode = float(0);
  return mat;
}

export { CLASS_COLOURS };
