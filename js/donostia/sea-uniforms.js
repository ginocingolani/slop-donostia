import { uniform } from 'three/tsl';

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

export const seaUniforms = {
  uSeaLevel: uniform(0),
  uTideMark: uniform(0),
  uTideLive: uniform(0)
};
