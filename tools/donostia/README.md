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
| `build.mjs` (with `walls.mjs`, `beach-access.mjs`) | `raw/dtm/*.asc`, `raw/bathy/isobaths.json`, `tools/donostia/data/` | `data/donostia/terrain-*.png`, `water.png`, `js/donostia/geodata.js` (with the shore walls), `js/donostia/data-beach-access.js` (the beaches' stairs & ramps) |
| `bake-ground.mjs` | `tools/donostia/data/`, the terrain, the beaches' stairs & ramps | `data/donostia/ground-*.png` (surfaces, kerbs, crossings) |
| `bake-bridges.mjs` | OSM bridges, the terrain | `js/donostia/data-bridges.js` |
| `bake-shore.mjs` | the shore walls, the terrain, OSM breakwaters, bare rock & coastline, municipal buildings & beaches, the port's quays (`port.mjs`) | `js/donostia/data-shore.js` (the rocks) |
| `bake-marina.mjs` (with `port.mjs`) | OSM piers, municipal pontoons, quays & ramps, the shore walls & stairs, the terrain, outlines read off the 2025 orthophoto | `js/donostia/data-marina.js` (pontoons, gangways, quay fittings, the slipway, the harbour's water) |
| `bake-streetscape.mjs` | tree pits, woods, OSM furniture, geodata, the beaches' stairs & ramps | `js/donostia/data-streetscape.js` |
| `bake-streets.mjs` | OSM street names, auzoak | `js/donostia/data-streets.js` |
| `bake-urgull-parts.mjs`, `bake-funicular.mjs` | OSM landmark parts, funicular & coaster | `js/donostia/data-*.js` |
| `bake-alderdi.mjs` | the gardens' municipal layers (parterres, beds, hedges...), OSM | `js/donostia/data-alderdi.js` |
| `bake-seamarks.mjs` | OSM's seamarks (`osm_seamarks.json`), checked against NGA Pub. 113 (in the script) | `js/donostia/data-seamarks.js` (the aids to navigation) |
| `digitise-boats.mjs` (with `jpeg.mjs`; only with `raw/ortho`) | the 2025 orthophoto over the port, OSM marinas & piers, the municipal quays & pontoons, the terrain | `tools/donostia/data/port_boats.json` (committed) |
| `bake-boats.mjs` | `port_boats.json`, the municipal quays & pontoons, OSM piers & the ferry route (`osm_ferry.json`), the marina (`data-marina.js`), the terrain | `js/donostia/data-boats.js` (the boats, their classes & paints; the island ferries' berths & lanes) |
| `bake-tifo.mjs` (with `jpeg.mjs`) | the tifo's design (`js/donostia/landmarks/tifo-design.js`); the portrait's photo (`raw/refs/tifo/`, kept as committed without it) | `data/donostia/tifo-banner.png`, `tifo-portrait.png` |

`build.mjs --preview <dir>`, `bake-ground.mjs --preview <dir>`, `bake-streetscape.mjs --preview <dir>`,
`bake-shore.mjs --preview <dir>`, `bake-marina.mjs --preview <dir>`, `bake-alderdi.mjs --preview <dir>`,
`digitise-boats.mjs --preview <dir>`, `bake-boats.mjs --preview <dir>` and `bake-tifo.mjs --preview <dir>` also write debug images for checking a
rebuild.

The OpenStreetMap snapshot is committed and only fetched again when it is missing, when a query changed since it was
taken (`osm_queries.sha256` records the hash of each query as sent) or with `--refresh-osm`. The queries
(`queries/*.overpassql`) cover the core plus 900 m (`OSM_MARGIN` in `lib.mjs`, filled in for `{{bbox}}`), which is
what the radar shows over the core's edges; `seamarks.overpassql` covers the terrain's whole context grid instead (its
box is written out), since a light out at sea is seen from the core. The landmarks are fetched by id; a landmark that the snapshot lacks fails
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
| Orthophoto 2025 (`ORTO_2025`, WMS), 500 m tiles at 12.5 cm/px over the beaches' accesses, the port and Aiete park: outlines and positions read off it (the port's pontoon widths, the pontoons, gangways and harbour outline the maps lack, the moored boats; the roofs, dormers and chimneys of the Miramar palace and Maskor Gain, the Miramar tower's place); the imagery itself is never committed | Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi | free use with the credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi» |
| Municipal 1:500 map: buildings, roads, sidewalks, pedestrian zones, stairs, ramps, gardens, woodland, beaches, tree pits, bike lanes, railway, the port's quays, docks, pontoons and moles, the coast, slopes, kerbs, tunnels; walls and spot heights along the shore; neighbourhoods | Donostiako Udala / Ayuntamiento de San Sebastián | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) |
| Names, landmark footprints, water, bridges, street furniture, the aids to navigation (seamark tags), the island ferry's route | © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (`queries/*.overpassql`, via `tools/overpass.sh`) | [ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) |
| The lights' characters, elevations, ranges and structures, San Sebastián (nos. 1788-1800): [NGA Pub. 113, List of Lights, Radio Aids and Fog Signals](https://msi.nga.mil/Publications/NGALOL) (2019 edition, corrected to Notice to Mariners 26/2019), the check on OSM's seamarks (`bake-seamarks.mjs`) | U.S. National Geospatial-Intelligence Agency | U.S. Government work, no copyright claimed (public domain) |
| La Concha's leading lights' arcs of visibility and the red pierhead's elevation (`bake-seamarks.mjs`): the list of lights of "Costa Cantábrica" (Spanish edition, 2005), p. 201 | RCC Pilotage Foundation (John Lawson) | facts only: no text, plan or photograph of the book is reproduced |
| Aitor Zabaleta's portrait on the tifo's banner: [`File:Reala Kopa 2026 Zabaleta.jpg`](https://commons.wikimedia.org/wiki/File:Reala_Kopa_2026_Zabaleta.jpg) (the Real Sociedad fan zone's screen at the 2026 Copa del Rey final in Seville, remembering him; 960 x 720 px), the disc of his portrait in it | [Goiena.eus](https://goiena.eus/debagoiena/1776352442099-debagoiendarrak-sevillan), via Wikimedia Commons | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) |

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
| `js/donostia/data-beach-access.js` | municipal map (stairs, ramps, spot heights, beaches, buildings), the LiDAR, read against the 2025 orthophoto and OSM | CC BY-SA 3.0 + ODbL 1.0, CC BY 4.0 credit |
| `js/donostia/data-funicular.js` | OSM | ODbL 1.0 |
| `js/donostia/data-seamarks.js` | OSM, checked against NGA Pub. 113 and "Costa Cantábrica"'s list of lights | ODbL 1.0 |
| `js/donostia/data-alderdi.js` | municipal map, OSM | CC BY-SA 3.0 + ODbL 1.0 |
| `tools/donostia/data/port_boats.json`, `js/donostia/data-boats.js` | the 2025 orthophoto (the boats), municipal map & OSM (the basins, quays & pontoons that bound them; the ferry's route & pier), the terrain | CC BY-SA 3.0 + ODbL 1.0, with the credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi» |
| `js/donostia/landmarks/aiete-parkea.js` (the pond's outline; the lamps' and the statue's places, read off the orthophoto) | OSM, orthophoto 2025 | ODbL 1.0, geoEuskadi credit |
| `js/donostia/landmarks/konstituzio-plaza.js` (the square's plan: the arcades' outline, piers and passages, the library's block) | municipal map | CC BY-SA 3.0 |
| `js/donostia/landmarks/miramar.js` (the palace's plan, wings, bays, turret and light-courts; the gate arch's wing; the roofs and the tower's place, read off the orthophoto) | municipal map, OSM, orthophoto 2025 | CC BY-SA 3.0 + ODbL 1.0, geoEuskadi credit |
| `js/donostia/landmarks/maskor-gain.js` (the block, its turrets and the back wing; the roof garden and the dome, read off the orthophoto) | municipal map, orthophoto 2025 | CC BY-SA 3.0, geoEuskadi credit |
| `data/donostia/tifo-portrait.png` | Goiena.eus's photo via Wikimedia Commons (cropped to his portrait's disc, turned to greys, resampled, contrasted) | CC BY-SA 4.0, credit «Goiena.eus, via Wikimedia Commons» |
| `data/donostia/tifo-banner.png` | nothing outside: drawn by `bake-tifo.mjs` from the design | as the code (MIT) |

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
  with the bake), so the ground steps vertically there, and `shore.js` faces the step with masonry and a coping. A
  sample between two walls a couple of cells apart (a quay below a raised walk, a flight's cheek and face) goes onto
  the one with the taller step (the nearer one unless the other's is a metre taller); left off it, the triangle across
  that wall stood as a fin square to it.
  Along the beaches' edges, which are walked first without the notches the map draws round rock ribs (an edge that
  leaves and comes back within 2.5 m over 8-40 m) and then as drawn: when the steepest fall makes no wall the next ones
  are tried; a walk 2 m wide or more with the ground behind it only rising holds a wall up at its own level; and two runs
  a few metres apart at one level, with no stairs or building between them, are one wall. That finds the sea wall under
  the walk round the Pico del Loro (Miramar's garden bank falls faster than the wall in front of it), which the search
  missed: the 2 m grid hung from the walk to the water there as a sawtooth curtain. In front of La Concha's & Zurriola's
  walls the sand or water still a metre over the foot drops too out to 4.5 m (the LiDAR spreads that wall's fall over
  3-4 m), and where the sea comes up to the wall the samples go down to its floor beyond, not the LiDAR's sea surface at
  the foot (a ledge out of the water); `js/donostia/water.js` leaves its rocky shallows' darkening out against a wall.
  `bake-ground.mjs` lays no sand on top of the beaches' walls: behind them, within 3 m, the municipal beach gives way to
  the surface further inland, else the paving.
- La Concha's arcade (`js/donostia/shore.js`, `ARCADES`): the recova under the promenade's edge from the foot of Alderdi
  Eder's ramps to the clock rotunda's north-east ramp, round columns under segmental arches in the sea wall's face and the
  gallery behind them at the walkway's level (4.1 m), traced in the walls' shader (no geometry of its own). The municipal
  map leaves it out under the promenade's deck; its run and form were read off Wikimedia Commons photographs (freely
  licensed, credited in the module) used as references only: nothing derived from their pixels is committed.
- Shore stairs (`walls.mjs`, `GEO.terrain.stairs`): the municipal map's stairs (`ESKAILERA`) by a wall, within 3 m of
  it, or 8 m for a piece that falls a metre or more below the promenade. Each piece gets a plane fitted to the 1 m LiDAR
  inside it, giving its fall, its downhill direction and its top & bottom between the promenade and the wall's foot. A
  piece that hardly falls is a landing. The walls stop half a metre short of them, the 2 m samples inside are kept
  under the slope, and `shore.js` builds them as solid steps of about 17 cm. The beaches' stairs are not among them:
  `beach-access.mjs` builds those (below). In the port (`stairWalls`) a narrow flight down a quay's face (three times
  longer than wide; the pieces the map cuts one flight into, sharing edges, fitted as one) falls along it, from its far
  end a riser under the quay to the lowest LiDAR across it, instead of across it to the water;
  each flight's sides get walls of their own, a cheek where the quay stands 0.8 m or more over the steps and a hidden
  wall where the flight runs on the water (the terrain steps down there; the flight's stone goes on down to the
  harbour's bed, its `base`).
- Beach accesses (`beach-access.mjs` → `js/donostia/data-beach-access.js`, built by `js/donostia/beach-access.js` in the
  shore walls' mesh): every way down from the promenades to La Concha, Ondarreta and Zurriola, inventoried by hand in
  `ACCESS`: each access names the municipal map's stairs (`ESKAILERA`) and ramps (`ARRAPALA`) pieces it is made of, by
  the mean of their outline's vertices, chained from the top to the sand, read against the 2025 orthophoto (steps,
  landings, parapets and the railings' shadows) and OSM's steps (direction, step counts, handrails). Levels: the 1:500
  spot heights (`KotaPuntuak`) where there are some (promenade, landings, the sand at the foot), else the 1 m LiDAR;
  each chain's fall is shared out over its flights' and ramps' runs, between the anchors. Then, deterministically:
  each piece's way down (from the piece before to the piece after, squared to its sides), its steps (rises of about
  16.5 cm, a 3 cm nosing; the last one 12 cm into the sand), and each side of its outline: shared with the next piece,
  against a building, the head, the foot (open to the sand), open (a 14 cm kerb, and the handrail: white-painted tube
  at La Concha & Ondarreta, stainless at Zurriola; La Concha's cast-iron railing down the rotunda's, Alderdi Eder's and
  Ondarreta's ramps), low over the ground beside (the kerb alone), a cheek (a broad flight cut into the promenade) or
  against ground well above it (a retaining wall line from that ground down to the piece, masonry and coping). The
  accesses built in front of a sea wall stand on the sand as blocks of masonry: the terrain under them goes down to the
  sand, the wall runs on behind them (the edge on the promenade's side, spliced onto the shore walls the LiDAR search
  found, which stops at stairs; a corner of the promenade at a piece's own level is a hidden wall line, behind its
  body), and the sand heaped against them by the 2 m grid comes down to the beach within 4.5-6.5 m. Where a wall line
  bends, the samples on it go back by the chord's sagitta (at most 0.45 m, under the coping), so the terrain's face
  never stands in front of the masonry. The railing of `bake-streetscape.mjs` opens at each access's head and runs
  down the ramps that carry it; `bake-ground.mjs` gives the pieces' ground the surfaces round them.
  Inventory (28 accesses built, 116 parts, 616 steps; the Caseta Real's twin flights are La Perla's landmark model):

  | Beach | Accesses |
  |---|---|
  | La Concha | flights along the wall: the west end (63 steps), by La Perla's Eguzki (28) and the Café de la Concha (25); double flights from one opening, each to a landing and on to the sand (at x 85, 53; at x 255, 42); the Pico del Loro switchback down the wall and out across the sand (59); the broad flight to the Miramar bastions' terrace (11); La Perla's service steps (12); the flight up to the doors under the clock rotunda (20); the rotunda's two ramps along the wall to landings, on by ramp and by steps (railing down the ramps); Alderdi Eder's twin ramps, walkway and flights (railing) |
  | Ondarreta | the west ramp along the wall from a landing (40 m, railing), three broad flights cut into the promenade (14, 6 with a ramp beside, 28 in four pieces), the east ramp along the edge, the Pico del Loro's curved flight to its terrace and on down to the rocks (46) |
  | Zurriola | the dike's flight with a landing (25), the Kursaal's corner flight (10) and ramp, the flights by the Kursaal (14), the 40 m ramp (1023), the flight square to the wall to a half-round landing (22), the 1195 ramp along the wall with its terrace and steps, the wall gap's three flights (17), Sagüés' ramp and flights with landings (58) |

  Left to the sand until photographs show them: two 2 m pieces in the corners between La Perla's octagons and the wall
  (around (−83, 675) and (0, 628)): no spot height at their tops and only the wall's smear in the LiDAR; 2 m deep under
  a 5 m drop, they cannot be flights to the promenade (steps up to a door in the wall's base, most likely).
- The port (`walls.mjs` `quayEdges`, `build.mjs` `harbourBed`, `bake-ground.mjs`): the search finds the north basin's
  north quay only in scraps and the old port slipway's sides not at all, so in two boxes the municipal map's quay edges
  (`KAIA`) stand as walls wherever the LiDAR falls 0.8 m or more across them (the quay behind, the water or the
  slipway's floor in front), replacing and joining the search's runs. Elsewhere in the port the search misses them by
  the flights cut into the quays, round the piers' rounded ends and where moored boats lift the LiDAR, so there a quay
  edge stands as a wall where it plainly is one: the LiDAR level on the quay behind and, in front, the water from 2.5 m
  out or a level square 0.8 m or more below (up to 3 m that fail this between two stretches that pass bridge them; the
  quays' thin holes, crane tracks and strips inside the edge, are left out). Then `joinPortWalls` joins a wall ending
  within 3 m of where another starts, going on the same way, and `buildingFaces` gives the buildings the bare-earth
  LiDAR keeps as ground (the Aquarium under its terraces, the stores under the west mole's walk) hidden walls at their
  faces, so the terrain steps at the facade. The LiDAR has the harbour's water at 0 m and no
  isobath reaches inside the moles, so both marinas (OSM ways 157022675 and 565482772) and the outer harbour (a ring
  inside the moles) get a dredged bed of -3 m, below the lowest spring tides (-2.2 m): at once against a quay wall,
  over 6 m from any other shore, never shallower than the sea floor's fill (by the mouth, between the moles' heads, it
  is already deeper). In the port every flat unmapped cell is paved as a quay, however far from the water (the old
  port's square and slipway), a cell beside a quay wall counting its slope on its flat side, and so is every unmapped
  cell of the harbour no higher than the flat quay within 6 m (the ramps the grid leaves where a wall stops short) or
  level along one of the grid's axes (a strip of quay a cell wide between a wall's foot and the water).
  Urgull's slopes over the port (`port.mjs` `urgullWoods`: above 8 m, steeper than 0.45, which the municipal woodland
  stops short of) are woodland, as the orthophoto shows, planted by `bake-streetscape.mjs`.
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
- The port's boats (`digitise-boats.mjs`): the 384 boats moored in the inner basin, the north basin and the old port on
  the 2025 orthophoto (`raw/ortho/ortho2025-port_x-350_z-300.jpg`, decoded by `jpeg.mjs`, a stdlib baseline JPEG
  decoder, so the pixels are the same on every machine). The bright, neutral or painted pixels on the basins' water,
  off everything built, make blobs; a row of boats moored side by side is one blob, cut across its axis at the seams
  between the hulls by dynamic programming (each piece must be as wide as a hull of its length), the axis chosen among
  the seams' sharpest, the blob's own, the edge it is moored to and its neighbours'. Each piece's tightest box gives the
  centre, heading, length & beam, its narrower end the bow, its outline (a long teardrop, widest well aft: a sailboat)
  and colours the family. What the automatic pass gets wrong (the passenger boats & the catamaran, cut across; the
  fishing boat by the fish market, read as five small ones; a boat under way in the fairway; the old port's few boats;
  pale quay edges taken for hulls; a dozen others) is dropped, corrected or added by hand in the script, checked tile by
  tile against the orthophoto. `bake-boats.mjs` takes 15 cm off every length & beam (the photo's blur), slides the hulls
  clear of the quays & pontoons that `port_boats.json` was digitised against (as the marina is built), eases
  overlapping hulls apart and gives each boat its class: the port has two parts, the marina's white motor boats,
  sailboats & dinghies, and the rows of small boats (the boats within 9 m mostly under 5.4 m: the inner basin's west
  half & east side, the north basin's south row), which are the txipironeras, the small wooden boats the port's people
  fish squid from, painted (Commons photographs of the port, `raw/refs/boats/`, looked at only) a deep or bright blue,
  red, orange, green or black under a white gunwale stripe, or white under a coloured one, a cabin seen from above
  making a small wheelhouse; the paints & options (consoles, canopies, wheelhouses, outboards) are picked per boat from
  a hash of its position, the photographed colours where they tell. The passenger boats other than the two ferries
  stay white and unlike them: the one of 16 m or more is the catamaran, the bay tours' Ciudad de San Sebastián at Kaiko
  pasealekua (two hulls under a saloon with an open upper deck of benches, blue stripes; after its photos on the
  tourism office's listing, `raw/refs/boats/catamaran/`, looked at only); those at the Lasta landing beside the ferries
  are open launches, rows of benches and orange life rafts forward, as the orthophoto shows them. `BOATS_DEBUG=x,z
  node tools/donostia/digitise-boats.mjs` logs how the blob at (x, z) was read and cut.
- The island ferries (`bake-boats.mjs`, `js/donostia/ferries.js`, `js/donostia/ferry-timeline.js`): the two passenger
  boats moored at OSM's ferry pier in the north basin are the Motoras de la Isla, blue, modelled after Commons
  photographs of Aitona Julian III. OSM's `route=ferry` "Donostia - Santa Clara" (`queries/ferry.overpassql`) gives
  their way out through the old port and the harbour mouth, across the bay and round the jetty's head to Santa Klara's
  landing; per ferry the bake lays a lane each way: astern off its berth to the nearest point it can turn clear, the
  route smoothed (Chaikin), kept 9 m to starboard of it in the open bay so the two pass port to port, bent round any
  moored boat it would brush, the last stretch straight along the quay or onto the jetty; every point checked clear of
  the quays, pontoons, moored boats and land (the terrain) and given a speed limit (2 m/s in the harbour, 5 m/s in the
  bay). The runtime eases them along those lanes (slower through the bends, accelerating & stopping gently), with
  pauses at each end, one at the island while the other is in port, from 10:00 to 20:00 (the summer timetable,
  motorasdelaisla.com) by the time of day the lighting shows (`presets.js`'s `clock`: under way at midday, moored at
  the other three).
- Miramar jauregia (`js/donostia/landmarks/miramar.js`) is built on the municipal outline in the palace's own frame:
  walls take each edge's height and finish from where it lies (the garden front's canted bays one storey high, the
  loggia, the gallery, the service wing), roofs are rectangles of the plan with jettied half-timbered gables, hips or
  open ends, dormers and stone chimneys, read against the orthophoto. The outline's octagon at the south-east end is a
  low stone turret (its roof on the orthophoto is a short octagonal pyramid with a small shadow); the tower stands at
  the north-west end, where the orthophoto shows its octagonal roof with dormers and a long shadow and where every
  photograph of the garden front puts it (on the right seen from the bay); the outline leaves it inside the wing's
  corner. The gate arch's wing past it is OpenStreetMap's (the 1:500 building stops short of it), moved 3.1 m along the
  palace onto the municipal frame. Maskor Gain (`maskor-gain.js`, Mirakontxa pasealekua 12) replaces its plain
  extrusion with the turreted block on its outline. For both, materials, storeys and details were read off Wikimedia
  Commons photographs (Category:Miramar jauregia; the Maskor Gain photographs near Mirakontxa pasealekua), references
  only: nothing derived from their pixels is committed.
- Konstituzio plaza (`js/donostia/landmarks/konstituzio-plaza.js`): the square's plan is the municipal map's arcade
  (`EraikinEgitura` `ARKUPEA`: the covered walks, their back walls, the passages to the four streets and the piers,
  drawn as notches in the square's edge), embedded in the square's own frame; the arches' rhythm is fitted to those
  piers (20 on the north and south sides, 9 on the east one between the passages' great arches, the old City Hall's
  five). Storey heights, the bays, the balconies' numbering (1-49 on the top floor, 50-98 and 99-147 below, from the
  north side's west end round to the south side's), colours and the library's front were read off Wikimedia Commons
  photographs of the square (its category, freely licensed); the photographs are references only and nothing derived
  from their pixels is committed. The blocks round the square stay the city's extrusions with their eaves levelled at
  the cornice: `buildFacadeCells` (`js/donostia/facade-mesh.js`) takes replaced records (`skip` lists the stretches of
  an outline a landmark builds itself) and phantom neighbours (never drawn, but they hide party walls).
- Bridges over land (`bake-bridges.mjs`): an OSM bridge way often stops a few metres short of where its road lands, over
  the slope of the cutting it spans. That would leave the deck's end in mid-air, its level taken from the slope. So a
  road or railway bridge runs on past an end, along its heading, while the bare-earth ground beyond still climbs faster
  than a steep street (15 %) out of a cutting at least 2.5 m deep, up to 24 m. Ground that keeps climbing is a
  hillside, and footbridges land on steps and ramps, so neither is extended (Aiete pasealekua over Berabera: 35 → 45 m).
  Under a land bridge's deck the municipal map still draws the road on top, in plan. So wherever the ground lies 2.5 m
  or more below the deck, `bake-ground.mjs` (run after `bake-bridges.mjs`) paints the steep cells as the embankment's
  grass and turns a bike lane on the flat cells into carriageway.
- The tifo on Anoeta's south stand (`js/donostia/landmarks/anoeta-tifo.js`, design in `tifo-design.js`), the Aitor
  Zabaleta harmaila / Grada Aitor Zabaleta, named in 2018 after the Real Sociedad fan killed in Madrid in 1998: the
  one its fans raised at La Cartuja for the 2026 Copa del Rey final, laid on Anoeta's stand. A card mosaic over the
  upper tier (blue & white bands, 1909, the ikurriña), the banner with his portrait over the lower tier, flags round
  it. The portrait (`data/donostia/tifo-portrait.png`) is the one texture to replace, and `bake-tifo.mjs` makes it from
  any photo: `node tools/donostia/bake-tifo.mjs --photo <file> --circle cx,cy,r --credit "…" --licence "…"` (the disc
  round his face, in the photo's pixels; `--tones 3|4` posterises it; `--placeholder` leaves a dark disc). Its source
  now is the only freely licensed image of him found (Wikimedia Commons, Flickr's CC search, the Basque press under CC
  BY-SA, October 2026): Goiena.eus's photo of the fan zone's screen, licensed CC BY-SA 4.0 by Goiena. What the screen
  shows, a fan-made medallion from an older photo of him, is a work of its own whose authors and licence the photo
  does not give; a photo of the banner or a mural at Anoeta, taken by whoever replaces it, or one licensed by its
  authors or his family, would give the portrait clean rights of its own. Nothing of the press photograph of the
  Cartuja tifo the design follows is used.
- The aids to navigation (`bake-seamarks.mjs` → `js/donostia/data-seamarks.js`, drawn by `js/donostia/seamarks.js`):
  every lit seamark OSM has over the context grid, its figures checked against NGA Pub. 113, which wins where they
  differ. The list of lights of the derrotero "Costa Cantábrica" (RCC Pilotage Foundation, 2005) adds what both leave
  out: the leading lights' arcs of visibility (the front light from 143° to 173°, the rear one only from 154° to 162°)
  and the red pierhead's 8 m. The script's header lists the disagreements and what was assumed where all are silent. The Instituto
  Hidrográfico's "Faros y señales de niebla", the Autoridad Portuaria de Pasaia's list and the Admiralty's could not be
  consulted (October 2026). No light stands on the Zurriola dike, at the Urumea's mouth or on Urgull in either source.

  | Light | Character | Elevation, range | Carried by |
  |---|---|---|---|
  | Igeldo (D 1483) | Fl(2+1) W 15 s: 0.4 s flashes, eclipses 1.8, 6, 6 s; a revolving optic | 134 m (the model's lantern: 129.6 m), 26 nm | the lighthouse (`landmarks/igeldo.js`) |
  | Isla de Santa Clara (D 1482) | Fl W 5 s: 1 s flashes | 53 m, 9 nm | the lighthouse (`landmarks/santa-klara.js`) |
  | La Concha's leading lights, 158° (D 1484, D 1484.1) | front Q R (0.3 s flashes assumed), visible 143°-173°; rear Oc R 4 s, 3 s light, visible 154°-162° | 12 m & 18 m, 7 nm | grey posts of 16 ft & 30 ft, 25 m apart across Kontxa pasealekua |
  | The port's pierheads (D 1486, D 1485) | west mole Fl(2) R 8 s, marina mole Fl(2) G 8 s (0.5 s flashes 1.5 s apart, assumed) | 8 m & 9 m, 5 & 3 nm | red & green columns |
  | Mompás outfall (00220) | Fl Y 5 s: 0.5 s | 5 m, 3 nm | a yellow pillar buoy, X topmark |
  | Pasaia fairway (00125) | Mo(A) W 7 s | 4 m (assumed), 7 nm | a red & white pillar buoy, red ball (69 m north of the grid, on the open sea) |

  Each light is one quad of a single instanced draw, its character timed in the shader from a clock in real seconds
  (`js/donostia/seamark-timing.js`, which the lighthouses' lanterns and Igeldo's beams share), a revolving optic's
  flashes reaching each bearing as its beams sweep past. In the app's console (`?debug`),
  `slopDebug.world.modules.seamarks.userData.freeze(t)` stops that clock at t s, for renders of a given moment.
- Building heights: each 1:500 outline takes the area-weighted b5m `AVERAGE_HEIGHT` of the b5m footprints under it.
  Roofs come from `MAX_HEIGHT − AVERAGE_HEIGHT` (a hip roof of rise r averages a third of it); gaps over 12 m are
  neighbouring towers or trees caught in the footprint, not roofs. b5m construction dates are cadastral and often
  record refurbishments.
- The light-building layers repeat each other (EraikinArinak redraws almost every ESTALPEA shed, BEROTEGIA greenhouse
  and KIOSKOA kiosk): `build.mjs` extrudes a light building only when an earlier outline does not already cover it.
  A few stretches of wall are drawn as buildings (ERAIKINA): an outline under 8 m² and under 0.9 m wide is left out
  (16; the four on the west mole's walk by the Aquarium, the doors of the stores under it, stood as free door frames).
- The Aquarium (`js/donostia/landmarks/itsas-museoa.js`): the faces of the Oceanographic Society's outline where the
  ground falls away outside it, the 1928 pavilion's in sandstone under maroon eaves with its sign, the extensions' in
  grey stone; read off Wikimedia Commons photographs of the Aquarium (its category), references only, nothing derived
  from their pixels committed.
- Shapefile rings: outer rings run clockwise and holes counter-clockwise; `extract.py` groups them by orientation, so
  a courtyard that touches its building's outline stays a hole.
- The national Catastro does not cover Gipuzkoa (foral cadastre), hence b5m.
- jsDelivr cannot serve arbitrary three.js commits (the repository exceeds its 50 MB package limit), so `index.html`
  pins the npm release instead of a dev-branch SHA.
