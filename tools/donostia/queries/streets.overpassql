[out:json][timeout:180];
(
  way["highway"]({{bbox}});
  way["railway"]({{bbox}});
  way["bridge"]({{bbox}});
);
out geom tags;
