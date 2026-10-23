# Donostia geodata pipeline

Builds the data behind `index.html` (Slop Donostia) from public sources:

```sh
tools/donostia/build-all.sh --fetch                # everything: download, extract, bake (~0.6 GB of raw sources, a few minutes)
tools/donostia/build-all.sh --fetch --refresh-osm  # the same with a fresh OpenStreetMap snapshot
tools/donostia/build-all.sh                        # bake again from the raw cache an earlier --fetch left (~2 min)
```

The raw cache (`tools/donostia/raw/`: the downloads, the unzipped DTM tiles and the isobaths extracted from them) is
gitignored, and `build.mjs` needs it. On a fresh clone, `build-all.sh` without `--fetch` skips `build.mjs`, keeps its
committed outputs and reruns only the `bake-*.mjs` steps from the committed `tools/donostia/data`; run it once with
`--fetch` to rebuild the terrain and the buildings too.

The steps it runs, in order:

| Step | Reads | Writes |
|---|---|---|
| `fetch.sh` | the web | `tools/donostia/raw/` (gitignored); `tools/donostia/data/osm_*.json` & `osm_queries.sha256` (committed) |
| `extract.py` (Python stdlib) | `raw/` | `tools/donostia/data/*.json` in the local frame (committed); `raw/bathy/isobaths.json` and the unzipped `raw/dtm/*.asc` (bake-only) |
| `build.mjs` | `raw/dtm/*.asc`, `raw/bathy/isobaths.json`, `tools/donostia/data/` | `data/donostia/terrain-*.png`, `water.png`, `js/donostia/geodata.js` |
| `bake-ground.mjs` | `tools/donostia/data/`, the terrain | `data/donostia/ground-*.png` (surfaces, kerbs, crossings) |
| `bake-bridges.mjs` | OSM bridges, the terrain | `js/donostia/data-bridges.js` |
| `bake-streetscape.mjs` | tree pits, woods, OSM furniture, geodata | `js/donostia/data-streetscape.js` |
| `bake-streets.mjs` | OSM street names, auzoak | `js/donostia/data-streets.js` |
| `bake-urgull-parts.mjs`, `bake-funicular.mjs` | OSM landmark parts, funicular & coaster | `js/donostia/data-*.js` |

`build.mjs --preview <dir>`, `bake-ground.mjs --preview <dir>` and `bake-streetscape.mjs --preview <dir>` also write
debug images for checking a rebuild.

The OpenStreetMap snapshot is committed and only fetched again when it is missing, when a query changed since it was
taken (`osm_queries.sha256` records the hash of each query as sent) or with `--refresh-osm`. The queries
(`queries/*.overpassql`) cover the core plus 900 m (`OSM_MARGIN` in `lib.mjs`, filled in for `{{bbox}}`), which is
what the radar shows over the core's edges. The landmarks are fetched by id; a landmark that the snapshot lacks fails
`build.mjs` rather than silently losing its model.

## Frame

`frame.json`: x = UTM 30N easting − 582 000 (metres east), z = 4 797 000 − northing (metres south), y = orthometric
height. The origin sits on Alderdi Eder by the old casino (Donostiako Udaletxea). The core extent runs from the top of
Igeldo to Ulía past the end of Sagüés and south to the Hospital Universitario (x −2200..2000, z −1600..3520).

## Sources

| Data | Source | Licence |
|---|---|---|
| 1 m terrain (MDT LiDAR 2017, tiles 064_4..6_1..3 and 040_6_8) | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| 1 m isobaths | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Building footprints with measured mean / max heights (`GFA_DSET_BU`) | b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| Municipal 1:500 map: buildings, roads, sidewalks, pedestrian zones, stairs, gardens, woodland, beaches, tree pits, bike lanes, railway; neighbourhoods | Donostiako Udala / Ayuntamiento de San Sebastián | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Names, landmark footprints, water, bridges, street furniture | © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (`queries/*.overpassql`, via `tools/overpass.sh`) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |

## Licences

The MIT licence in [`LICENSE`](../../LICENSE) covers the code only. The data files below are not code: they are
derived from the sources above and are offered under those sources' licences. Content derived from OpenStreetMap is
under the [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/) and content derived from the
municipal map under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), both share-alike; the geoEuskadi
and b5m content is [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), which asks for the credit. A file that
mixes them carries each licence for the part that comes from its source.

| Derived file | Built from | Licence |
|---|---|---|
| `tools/donostia/data/c500_*.json`, `auzoak.json` | municipal 1:500 map | CC BY-SA 3.0 |
| `tools/donostia/data/b5m_buildings.json` | b5m | CC BY 4.0 |
| `tools/donostia/data/osm_*.json` | OpenStreetMap | ODbL 1.0 |
| `data/donostia/terrain-core.png` | LiDAR & isobaths, municipal map (ground classes), OSM (water) | CC BY-SA 3.0 + ODbL 1.0, CC BY 4.0 credit |
| `data/donostia/terrain-context.png`, `water.png` | LiDAR & isobaths, OSM (water) | ODbL 1.0, CC BY 4.0 credit |
| `data/donostia/ground-*.png` | municipal map, OSM, the terrain | CC BY-SA 3.0 + ODbL 1.0, CC BY 4.0 credit |
| `js/donostia/geodata.js` | municipal map, b5m, OSM, the terrain | CC BY-SA 3.0 + ODbL 1.0, CC BY 4.0 credit |
| `js/donostia/data-streets.js`, `data-urgull-parts.js` | OSM, municipal map | ODbL 1.0 + CC BY-SA 3.0 |
| `js/donostia/data-bridges.js`, `data-streetscape.js` | OSM, municipal map, the terrain | ODbL 1.0 + CC BY-SA 3.0, CC BY 4.0 credit |
| `js/donostia/data-funicular.js` | OSM | ODbL 1.0 |

The data was modified: reprojected into the local frame, simplified, clipped, rasterised, resampled and combined as
described above. Every generated file names its sources and licences: the extracted layers in their `source` field
(the OSM snapshot in `osm3s.copyright`), the JavaScript modules in their header comment, the PNG images in their
`Copyright` and `Comment` text chunks. The app credits the sources in its data popover (the ⓘ button) and on the full
map.

## Notes

- The LiDAR terrain stores the sea surface as exactly 0 m; `build.mjs` floods it from the open sea and lays the
  isobath sea floor (harmonic fill between contours) under it.
- Building heights: each 1:500 outline takes the area-weighted b5m `AVERAGE_HEIGHT` of the b5m footprints under it.
  Roofs come from `MAX_HEIGHT − AVERAGE_HEIGHT` (a hip roof of rise r averages a third of it); gaps over 12 m are
  neighbouring towers or trees caught in the footprint, not roofs. b5m construction dates are cadastral and often
  record refurbishments.
- The light-building layers repeat each other (EraikinArinak redraws almost every ESTALPEA shed, BEROTEGIA greenhouse
  and KIOSKOA kiosk): `build.mjs` extrudes a light building only when an earlier outline does not already cover it.
- Shapefile rings: outer rings run clockwise and holes counter-clockwise; `extract.py` groups them by orientation, so
  a courtyard that touches its building's outline stays a hole.
- The national Catastro does not cover Gipuzkoa (foral cadastre), hence b5m.
- jsDelivr cannot serve arbitrary three.js commits (the repository exceeds its 50 MB package limit), so `index.html`
  pins the npm release instead of a dev-branch SHA.
