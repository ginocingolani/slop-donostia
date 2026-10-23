// js/donostia/landmarks/santa-maria.js
// Basílica de Santa María del Coro (1743-74, baroque): sandstone church at the end of Kale Nagusia at the foot of Urgull, a huge niche portal with a sculpted St Sebastian, one bell tower, the nave aligned towards the Buen Pastor cathedral.
//
// build(sites, ctx) receives the GEO.landmarks entries ['santa-maria'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
