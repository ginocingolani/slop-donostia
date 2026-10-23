// js/donostia/landmarks/igeldo.js
// Monte Igeldo summit: El Torreón (the 16th-c. crenellated stone lighthouse tower above the amusement park), the 1855 Igeldo lighthouse further west on the cliff, the amusement park terraces (Montaña Suiza roller coaster), and the 1912 funicular track climbing from Ondarreta (OSM railway=funicular).
//
// build(sites, ctx) receives the GEO.landmarks entries ['igeldo-itsasargia', 'igeldo-torreoia'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
