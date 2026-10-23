[out:json][timeout:180];
(
  node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop|elevator)$"](43.284,-2.018,43.339,-1.962);
  node["amenity"~"^(bench|fountain|drinking_water|bicycle_rental|waste_basket|clock|telephone|bar|restaurant|cafe|pub|ice_cream)$"](43.284,-2.018,43.339,-1.962);
  node["natural"="tree"](43.284,-2.018,43.339,-1.962);
  node["man_made"~"^(lamp|flagpole|street_cabinet)$"](43.284,-2.018,43.339,-1.962);
  nwr["barrier"~"^(fence|railing|wall|retaining_wall|guard_rail|kerb)$"](43.284,-2.018,43.339,-1.962);
  nwr["tourism"="artwork"](43.284,-2.018,43.339,-1.962);
);
out geom tags;
