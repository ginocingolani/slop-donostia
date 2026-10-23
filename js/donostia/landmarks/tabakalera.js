// js/donostia/landmarks/tabakalera.js
// Tabakalera (the 1913 tobacco factory, now the International Centre for Contemporary Culture, renovated 2015): a huge four-storey block around courtyards next to the Estación del Norte, cream render and brick, regular rows of windows, and the glazed "Prisma" lookout on the roof.
//
// build(sites, ctx) receives the GEO.landmarks entries ['tabakalera'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
