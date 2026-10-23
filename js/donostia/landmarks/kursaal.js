// js/donostia/landmarks/kursaal.js
// Kursaal (1999, Rafael Moneo): two leaning translucent glass prisms — the large auditorium (~27 m) and the chamber hall — on a dark stone podium at the mouth of the Urumea facing Zurriola beach; frosted, faintly green glass that glows from inside at night. The three OSM sites (palace, auditorium, chamber hall) are one model.
//
// build(sites, ctx) receives the GEO.landmarks entries ['kursaal', 'kursaal-auditorium', 'kursaal-kamara'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.

export function build(sites, ctx) {
  return null;
}
