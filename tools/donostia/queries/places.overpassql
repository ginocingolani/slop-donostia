[out:json][timeout:180];
(
  nwr["name"]["tourism"]({{bbox}});
  nwr["name"]["historic"]({{bbox}});
  nwr["name"]["amenity"~"^(place_of_worship|townhall|theatre|arts_centre|library|marketplace|casino|ferry_terminal)$"]({{bbox}});
  nwr["name"]["building"~"^(cathedral|church|chapel|basilica|civic|government|public|hotel|train_station|transportation|museum)$"]({{bbox}});
  nwr["man_made"~"^(lighthouse|pier|breakwater|groyne|tower|crane|lamp)$"]({{bbox}});
  nwr["leisure"~"^(park|garden|amusement_arcade|water_park|marina|beach_resort|playground|sports_centre|stadium)$"]({{bbox}});
  nwr["natural"~"^(beach|peak|cliff|bare_rock|coastline|water)$"]({{bbox}});
  nwr["place"~"^(island|islet|neighbourhood|quarter|suburb|square)$"]({{bbox}});
  way["building:part"]({{bbox}});
);
out geom;
