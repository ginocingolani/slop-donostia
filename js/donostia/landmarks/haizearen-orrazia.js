// js/donostia/landmarks/haizearen-orrazia.js
// Haizearen orrazia / Peine del Viento (Eduardo Chillida & Luis Peña Ganchegui, 1977) at the western end of Ondarreta: a granite plaza with sea blowholes and three rusted steel sculptures gripping the rocks. Chillida's work is still in copyright: keep it abstract and simplified (rusted claw-like forms), not a replica.
//
// build(sites, ctx) receives the GEO.landmarks entries ['haizearen-orrazia'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
