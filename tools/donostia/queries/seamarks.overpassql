/* The aids to navigation: lights, lit beacons & buoys, lighthouses (bake-seamarks.mjs). Over the terrain's whole context
   grid (GEO.frame.context: x -6056..4216, z -3744..5696, rounded outwards), wider than the other queries' core plus
   OSM_MARGIN: a light out at sea beyond it is still seen from the core. */
[out:json][timeout:120];
(
  nwr["seamark:type"~"^(light_major|light_minor|light_vessel|light_float|landmark|beacon_|buoy_)"](43.2696,-2.0643,43.3558,-1.9361);
  nwr[~"^seamark:light"~"."](43.2696,-2.0643,43.3558,-1.9361);
  nwr["man_made"="lighthouse"](43.2696,-2.0643,43.3558,-1.9361);
);
out center tags;
