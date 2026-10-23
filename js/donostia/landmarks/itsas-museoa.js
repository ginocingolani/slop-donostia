// js/donostia/landmarks/itsas-museoa.js
// Euskal Itsas Museoa (Naval Museum, the 18th-c. Consulado building on the old port) and the Aquarium (1928 pavilion at the end of the port by the Paseo Nuevo): stone & white render, pitched roofs.
//
// build(sites, ctx) receives the GEO.landmarks entries ['itsas-museoa', 'aquariuma'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
