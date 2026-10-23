// js/donostia/landmarks/anoeta.js
// Anoeta stadium / Reale Arena (1993, rebuilt 2017-2019 when the athletics track was removed and the stands brought to the pitch): an oval bowl wrapped in a translucent blue membrane (ETFE / PTFE panels) with REALE ARENA lettering, a roof ring over the stands, ~40,000 seats.
//
// build(sites, ctx) receives the GEO.landmarks entries ['anoeta'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
