# Donostia geodata pipeline

Builds the data behind `index.html` (Slop Donostia) from public sources. Three steps:

```sh
tools/donostia/fetch.sh                                         # raw sources -> tools/donostia/raw (gitignored, ~0.6 GB)
python3 -I tools/donostia/extract.py                            # raw -> tools/donostia/data/*.json (local frame, committed)
node --max-old-space-size=8192 tools/donostia/build.mjs         # -> data/donostia/*.png + js/donostia/geodata.js
```

`build.mjs --preview <dir>` also writes hillshade and building-height images for checking a rebuild.

## Frame

`frame.json`: x = UTM 30N easting − 582 000 (metres east), z = 4 797 000 − northing (metres south), y = orthometric
height. The origin sits on Alderdi Eder by the old casino (Donostiako Udaletxea). The core extent runs from the top of
Igeldo to Ulía past the end of Sagüés (x −2200..2000, z −1600..1800).

## Sources

| Data | Source | Licence |
|---|---|---|
| 1 m terrain (MDT LiDAR 2017, tiles 064_4_1, 064_5_1, 064_6_1, 064_5_2, 064_6_2, 040_6_8) | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | CC BY 4.0 |
| 1 m isobaths | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | CC BY 4.0 |
| Building footprints with measured mean / max heights (`GFA_DSET_BU`) | b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa | CC BY 4.0 |
| Municipal 1:500 map: buildings, roads, sidewalks, pedestrian zones, stairs, gardens, woodland, beaches, tree pits, bike lanes, railway; neighbourhoods | Donostiako Udala / Ayuntamiento de San Sebastián | CC BY-SA 3.0 |
| Names, landmark footprints, street furniture | © OpenStreetMap contributors (`queries/*.overpassql`, via `tools/overpass.sh`) | ODbL |

Because the municipal map is CC BY-SA and OpenStreetMap is ODbL, the derived data (`tools/donostia/data`,
`data/donostia`, `js/donostia/geodata.js`) is share-alike. The code is MIT, like slop-newyork.

## Notes

- The LiDAR terrain stores the sea surface as exactly 0 m; `build.mjs` floods it from the open sea and lays the
  isobath sea floor (harmonic fill between contours) under it.
- Building heights: each 1:500 outline takes the area-weighted b5m `AVERAGE_HEIGHT` of the b5m footprints under it.
  Roofs come from `MAX_HEIGHT − AVERAGE_HEIGHT` (a hip roof of rise r averages a third of it); gaps over 12 m are
  neighbouring towers or trees caught in the footprint, not roofs. b5m construction dates are cadastral and often
  record refurbishments.
- The national Catastro does not cover Gipuzkoa (foral cadastre), hence b5m.
- jsDelivr cannot serve arbitrary three.js commits (the repository exceeds its 50 MB package limit), so `index.html`
  pins the npm release instead of a dev-branch SHA.
