// js/donostia/landmarks/santa-klara.js
// Santa Klara island: its small white lighthouse house on the summit, the jetty on the bay side; the island itself is in the LiDAR terrain.
//
// build(sites, ctx) receives the GEO.landmarks entries ['santa-klara-itsasargia'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
