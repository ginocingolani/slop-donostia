import { Fn, If, float, vec2, uniform, min, mix, smoothstep, clamp, dot, length } from 'three/tsl';
import { LOW_WATER_CHANNELS } from './sea-state.js';

// js/donostia/sea-uniforms.js
// The sea's uniforms that the materials round the water read, set every frame by js/donostia/water.js (its
// userData.update): the water's level (the tide), the level the tidal bands are drawn from, and how far the live sea's
// own effects (wet seabed, the low-water channels) are in. Their own module so the ground, the shore and the marina can
// read them without loading the water (as js/city-uniforms.js for the lighting).
// - uSeaLevel: m above mean sea level, the water plane's (the same node as the water group's userData.seaLevel).
// - uTideMark: m, the reference of the tidal bands (the wet sand's reach, the walls' dark band and weed): the water's
//   level with the real-time switch off (as the bands were drawn, riding the demo tide), the last high water less a
//   spring tide's (js/donostia/sea-state.js bandMark) with it on.
// - uTideLive: 0 with the switch off .. 1 on: the live sea's additions fade in with it, and are skipped at 0.
// Also the low-water channels (sea-state.js LOW_WATER_CHANNELS) as a shader function, shared by the terrain's vertices
// (js/donostia/ground.js) and the water's sea floor (js/donostia/water.js) so the two agree.

export const seaUniforms = {
  uSeaLevel: uniform(0),
  uTideMark: uniform(0),
  uTideLive: uniform(0)
};

// each channel's bounds (its path's, grown by its outer reach)
const BOUNDS = LOW_WATER_CHANNELS.map(({ path, outer }) => {
  const xs = path.filter((_, i) => i % 2 === 0), zs = path.filter((_, i) => i % 2 === 1);
  return [Math.min(...xs) - outer, Math.min(...zs) - outer, Math.max(...xs) + outer, Math.max(...zs) + outer];
});

/**
 * The sea floor at xz (vec2, local frame) once the low-water channels are dredged, from the terrain's `bed` there
 * (sea-state.js channelFloor, as nodes), blended in with uTideLive. Callers run it in a branch on uTideLive > 0.
 */
export const channelFloor = Fn(([xz, bed]) => {
  const floor = float(bed).toVar();
  LOW_WATER_CHANNELS.forEach(({ floor: target, inner, outer, path }, c) => {
    const [x0, z0, x1, z1] = BOUNDS[c];
    // (only near the channel: no derivatives or texture reads in here)
    If(xz.x.greaterThan(x0).and(xz.x.lessThan(x1)).and(xz.y.greaterThan(z0)).and(xz.y.lessThan(z1)), () => {
      let d = float(1e6);
      for (let k = 0; k + 3 < path.length; k += 2) {
        const dx = path[k + 2] - path[k], dz = path[k + 3] - path[k + 1];
        const a = vec2(path[k], path[k + 1]), ab = vec2(dx, dz);
        const t = clamp(dot(xz.sub(a), ab).div(dx * dx + dz * dz), 0, 1);
        d = min(d, length(xz.sub(a).sub(ab.mul(t))));
      }
      const mask = smoothstep(outer, inner, d).mul(smoothstep(0.1, -0.4, bed));
      floor.assign(min(floor, mix(bed, float(target), mask)));
    });
  });
  return mix(bed, floor, seaUniforms.uTideLive);
});
