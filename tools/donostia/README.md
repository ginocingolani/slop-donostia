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
| `build.mjs` (with `walls.mjs`) | `raw/dtm/*.asc`, `raw/bathy/isobaths.json`, `tools/donostia/data/` | `data/donostia/terrain-*.png`, `water.png`, `js/donostia/geodata.js` (with the shore walls) |
| `bake-ground.mjs` | `tools/donostia/data/`, the terrain | `data/donostia/ground-*.png` (surfaces, kerbs, crossings) |
| `bake-bridges.mjs` | OSM bridges, the terrain | `js/donostia/data-bridges.js` |
| `bake-shore.mjs` | the shore walls, the terrain, OSM breakwaters, bare rock & coastline, municipal buildings & beaches, the port's quays (`port.mjs`) | `js/donostia/data-shore.js` (the rocks) |
| `bake-marina.mjs` (with `port.mjs`) | OSM piers, municipal pontoons, quays & ramps, the shore walls & stairs, the terrain, outlines read off the 2025 orthophoto | `js/donostia/data-marina.js` (pontoons, gangways, quay fittings, the slipway, the harbour's water) |
| `bake-streetscape.mjs` | tree pits, woods, OSM furniture, geodata | `js/donostia/data-streetscape.js` |
| `bake-streets.mjs` | OSM street names, auzoak | `js/donostia/data-streets.js` |
| `bake-urgull-parts.mjs`, `bake-funicular.mjs` | OSM landmark parts, funicular & coaster | `js/donostia/data-*.js` |
| `bake-alderdi.mjs` | the gardens' municipal layers (parterres, beds, hedges...), OSM | `js/donostia/data-alderdi.js` |
| `digitise-boats.mjs` (with `jpeg.mjs`; only with `raw/ortho`) | the 2025 orthophoto over the port, OSM marinas & piers, the municipal quays & pontoons, the terrain | `tools/donostia/data/port_boats.json` (committed) |
| `bake-boats.mjs` | `port_boats.json`, the municipal quays & pontoons, OSM piers | `js/donostia/data-boats.js` |

`build.mjs --preview <dir>`, `bake-ground.mjs --preview <dir>`, `bake-streetscape.mjs --preview <dir>`,
`bake-shore.mjs --preview <dir>`, `bake-marina.mjs --preview <dir>`, `bake-alderdi.mjs --preview <dir>`,
`digitise-boats.mjs --preview <dir>` and `bake-boats.mjs --preview <dir>` also write debug images for checking a rebuild.

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
| Orthophoto 2025 (`ORTO_2025`, WMS), 500 m tiles at 12.5 cm/px over the beaches' accesses, the port and Aiete park: outlines and positions read off it (the port's pontoon widths, the pontoons, gangways and harbour outline the maps lack, the moored boats); the imagery itself is never committed | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | free use with the credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi» |
| Municipal 1:500 map: buildings, roads, sidewalks, pedestrian zones, stairs, ramps, gardens, woodland, beaches, tree pits, bike lanes, railway, the port's quays, docks, pontoons and moles, the coast, slopes, kerbs, tunnels; walls and spot heights along the shore; neighbourhoods | Donostiako Udala / Ayuntamiento de San Sebastián | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
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
| `js/donostia/data-bridges.js`, `data-streetscape.js`, `data-shore.js` | OSM, municipal map, the terrain | ODbL 1.0 + CC BY-SA 3.0, CC BY 4.0 credit |
| `js/donostia/data-marina.js` | OSM, municipal map, the terrain, the 2025 orthophoto | ODbL 1.0 + CC BY-SA 3.0, CC BY 4.0 & geoEuskadi credits |
| `js/donostia/data-funicular.js` | OSM | ODbL 1.0 |
| `js/donostia/data-alderdi.js` | municipal map, OSM | CC BY-SA 3.0 + ODbL 1.0 |
| `tools/donostia/data/port_boats.json`, `js/donostia/data-boats.js` | the 2025 orthophoto (the boats), municipal map & OSM (the basins, quays & pontoons that bound them) | CC BY-SA 3.0 + ODbL 1.0, with the credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi» |
| `js/donostia/landmarks/aiete-parkea.js` (the pond's outline; the lamps' and the statue's places, read off the orthophoto) | OSM, orthophoto 2025 | ODbL 1.0, geoEuskadi credit |

The data was modified: reprojected into the local frame, simplified, clipped, rasterised, resampled and combined as
described above. Every generated file names its sources and licences: the extracted layers in their `source` field
(the OSM snapshot in `osm3s.copyright`), the JavaScript modules in their header comment, the PNG images in their
`Copyright` and `Comment` text chunks. The app credits the sources in its data popover (the ⓘ button) and on the full
map.

## Notes

- The LiDAR terrain stores the sea surface as exactly 0 m; `build.mjs` floods it from the open sea and lays the
  isobath sea floor (harmonic fill between contours) under it.
- Shore walls (`walls.mjs`, `GEO.terrain.walls`): the 1 m LiDAR keeps a sea wall as a 2-3 m ramp and the 2 m grid smears
  it over a cell or two. Every shoreline the maps know of (the municipal beaches' edges, the OSM river & docks at sea
  level, the OSM coastline & breakwaters, in that order) is walked metre by metre with a profile square to it; a steep
  fall of 1.4 m or more from flat paving to the beach, rocks or water is a wall (not at stairs, buildings or bridges).
  Each wall keeps its crest line, the promenade level behind it, the LiDAR ground at its foot and, for the Paseo
  Nuevo's and the river's walls, a batter. Only the 2 m samples within reach of a wall change: the ones in front drop to
  its foot (never rising: the river bed stays) and take the ground class beyond, the smeared ones behind come back to the
  promenade level (the Paseo Nuevo's parapet hump is flattened, `js/donostia/shore.js` models the parapet). At runtime
  `js/donostia/terrain.js` moves the samples either side of a wall line onto it (`js/donostia/shore-walls.js`, shared
  with the bake), so the ground steps vertically there, and `shore.js` faces the step with masonry and a coping.
- Shore stairs (`walls.mjs`, `GEO.terrain.stairs`): the municipal map's stairs (`ESKAILERA`) by a wall, within 3 m of
  it, or 8 m for a piece that falls a metre or more below the promenade. Each piece gets a plane fitted to the 1 m LiDAR
  inside it, giving its fall, its downhill direction and its top & bottom between the promenade and the wall's foot. A
  piece that hardly falls is a landing. The walls stop half a metre short of them, the 2 m samples inside are kept
  under the slope, and `shore.js` builds them as solid steps of about 17 cm.
- Shore rocks (`bake-shore.mjs`): seeded dart throwing over the 2 m cells of each zone (the Paseo Nuevo's apron and
  flysch platforms, the Zurriola dike & the Kursaal's bank of the river mouth, the river walls' toe where the LiDAR found
  the bed above mean sea level, the port's two moles, the OSM bare rock & rocky coastline), never on paving, buildings,
  beaches, bridges or the Kursaal's podium. The port's moles (OSM breakwaters 859798080 & 859798081, `port.mjs`) get
  concrete cubes, as the orthophoto shows, on what their outlines hold beyond the municipal quays; no rock lies on the
  quays (`KAIA`, a cell's margin round them) or down the old port's slipway.
- The port (`bake-marina.mjs`, `js/donostia/marina.js`): the pontoons' centre lines are the OSM piers (the Kirol
  portua's walkways, the Donostia marina's comb and quay pontoons), their widths measured on the 2025 orthophoto; the
  fingers and T-heads are what is left of the municipal map's pontoons (`PANTALANA`) once the walkways are taken out,
  each fitted with a rectangle and run on to its walkway's edge; the pontoons neither map has are read off the
  orthophoto (`ORTHO_PONTOONS`). An OSM end drawn onto the quay stops a quarter of a metre off the wall. The decks float
  at 0.45 m freeboard and ride the tide (the water's `getSeaLevel()`), settling no lower than mean sea level, since the
  basins' LiDAR bed lies only 0.3 m down. Gangways hang from the quay at the municipal ramps that end by a pontoon, at
  the quay steps whose bottom step does, and where an OSM walkway meets the wall, pitched to the pontoons' level every
  frame the tide moves them; each has a gate at its head. Guide piles stand along the walkways (one every ~14 m,
  alternately either side, never under another deck or against a wall), cleats every 3 m along the berths' edges,
  service pedestals every 11 m. On the harbour's quay walls (the walls inside `port.mjs`'s `HARBOUR` ring, over water
  in front and with no pontoon, steps or gangway alongside): a bollard every 12 m, iron rings between them on the old
  port, a ladder every 36 m, timber strakes on the fishing quay below the Naval Museum. The old port's slipway is the
  notch the municipal quays (`KAIA`) leave at the foot of Kaiarriba, cut off at its toe, its concrete a quadric fitted to
  the LiDAR inside it (3 m clear of its smeared edges, outliers dropped) and lifted over the terrain.
- Calm water in the harbour (`js/donostia/water.js`): `port.mjs`'s `HARBOUR` ring (the water inside the moles, drawn on
  the orthophoto over their crests) and `MOUTH` give two blurred fields on a 2 m grid: inside (rising to 1 within 20 m
  past the mouth: the harbour's green water, no surf or swash, its colour never the turquoise of a sandy shallow) and
  sheltered (rising to 1 within 70 m: the waves down to 28 % of the open sea's, so reflections sharpen). The open sea is
  unchanged.
- The port's boats (`digitise-boats.mjs`): the 389 boats moored in the inner basin, the north basin and the old port on
  the 2025 orthophoto (`raw/ortho/ortho2025-port_x-350_z-300.jpg`, decoded by `jpeg.mjs`, a stdlib baseline JPEG
  decoder, so the pixels are the same on every machine). The bright, neutral or painted pixels on the basins' water,
  off everything built, make blobs; a row of boats moored side by side is one blob, cut across its axis at the seams
  between the hulls by dynamic programming (each piece must be as wide as a hull of its length), the axis chosen among
  the seams' sharpest, the blob's own, the edge it is moored to and its neighbours'. Each piece's tightest box gives the
  centre, heading, length & beam, its narrower end the bow, its outline (a long teardrop, widest well aft: a sailboat)
  and colours the family. What the automatic pass gets wrong (the passenger boats & the catamaran, cut across; the
  old port's few boats; pale quay edges taken for hulls; a dozen others) is dropped, corrected or added by hand in the
  script, checked tile by tile against the orthophoto. `bake-boats.mjs` takes 15 cm off every length & beam (the photo's
  blur), slides the hulls clear of the quays & pontoons that `port_boats.json` was digitised against (as the marina
  is built), eases overlapping hulls apart and picks each boat's hull, deck & accent paints from its photographed
  colours. `BOATS_DEBUG=x,z node tools/donostia/digitise-boats.mjs` logs how the blob at (x, z) was read and cut.
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
