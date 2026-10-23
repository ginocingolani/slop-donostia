[out:json][timeout:180];
(
  nwr["name"]["tourism"](43.302,-2.018,43.339,-1.962);
  nwr["name"]["historic"](43.302,-2.018,43.339,-1.962);
  nwr["name"]["amenity"~"^(place_of_worship|townhall|theatre|arts_centre|library|marketplace|casino|ferry_terminal)$"](43.302,-2.018,43.339,-1.962);
  nwr["name"]["building"~"^(cathedral|church|chapel|basilica|civic|government|public|hotel|train_station|transportation|museum)$"](43.302,-2.018,43.339,-1.962);
  nwr["man_made"~"^(lighthouse|pier|breakwater|groyne|tower|crane|lamp)$"](43.302,-2.018,43.339,-1.962);
  nwr["leisure"~"^(park|garden|amusement_arcade|water_park|marina|beach_resort|playground|sports_centre|stadium)$"](43.302,-2.018,43.339,-1.962);
  nwr["natural"~"^(beach|peak|cliff|bare_rock|coastline|water)$"](43.302,-2.018,43.339,-1.962);
  nwr["place"~"^(island|islet|neighbourhood|quarter|suburb|square)$"](43.302,-2.018,43.339,-1.962);
  way["building:part"](43.302,-2.018,43.339,-1.962);
);
out geom tags;
