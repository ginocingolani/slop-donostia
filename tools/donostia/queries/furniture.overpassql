[out:json][timeout:180];
(
  node["highway"~"^(street_lamp|traffic_signals|crossing|bus_stop|elevator)$"]({{bbox}});
  node["amenity"~"^(bench|fountain|drinking_water|bicycle_rental|waste_basket|clock|telephone|bar|restaurant|cafe|pub|ice_cream)$"]({{bbox}});
  node["natural"="tree"]({{bbox}});
  node["man_made"~"^(lamp|flagpole|street_cabinet)$"]({{bbox}});
  nwr["barrier"~"^(fence|railing|wall|retaining_wall|guard_rail|kerb)$"]({{bbox}});
  nwr["tourism"="artwork"]({{bbox}});
);
out geom tags;
