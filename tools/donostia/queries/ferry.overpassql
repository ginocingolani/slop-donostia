[out:json][timeout:60];
(
  way["route"="ferry"]({{bbox}});
  relation["route"="ferry"]({{bbox}});
);
out geom;
