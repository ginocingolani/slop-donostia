#!/bin/bash
# usage: tools/donostia/build-all.sh [--fetch [--refresh-osm]]
# Rebuilds every Donostia data file in dependency order. With --fetch it first downloads the raw sources and
# re-extracts them (tools/donostia/fetch.sh, which also takes --refresh-osm, + extract.py). Without it, build.mjs reruns
# from the raw cache an earlier --fetch left in tools/donostia/raw (the DTM tiles and isobaths are not committed); on a
# fresh clone, where there is none, only the bake-*.mjs steps rerun, on the committed tools/donostia/data and the
# committed outputs of build.mjs.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
NODE="node --max-old-space-size=8192"

if [ "${1:-}" = "--fetch" ]; then
  shift
  bash "$HERE/fetch.sh" "$@"
  python3 -I "$HERE/extract.py"
elif [ "$#" -gt 0 ]; then
  echo "usage: $0 [--fetch [--refresh-osm]]" >&2
  exit 1
fi

# terrain, shore walls, water, buildings, landmarks & teleports -> data/donostia/terrain-*.png, water.png, js/donostia/geodata.js
if compgen -G "$HERE/raw/dtm/*.asc" > /dev/null && [ -s "$HERE/raw/bathy/isobaths.json" ]; then
  $NODE "$HERE/build.mjs"
else
  echo "build.mjs skipped: no raw cache (tools/donostia/raw/dtm/*.asc, raw/bathy/isobaths.json; run with --fetch to" \
    "make one). Keeping the committed terrain-*.png, water.png and geodata.js." >&2
fi
# these read build.mjs's outputs
$NODE "$HERE/bake-ground.mjs"        # data/donostia/ground-*.png
$NODE "$HERE/bake-bridges.mjs"       # js/donostia/data-bridges.js
$NODE "$HERE/bake-shore.mjs"         # js/donostia/data-shore.js (rocks of the shore; the walls are build.mjs's)
$NODE "$HERE/bake-streetscape.mjs"   # js/donostia/data-streetscape.js (trees, railing, lamps, benches)
$NODE "$HERE/bake-streets.mjs"       # js/donostia/data-streets.js (street names & districts for the HUD)
$NODE "$HERE/bake-urgull-parts.mjs"  # js/donostia/data-urgull-parts.js
$NODE "$HERE/bake-funicular.mjs"     # js/donostia/data-funicular.js
$NODE "$HERE/bake-alderdi.mjs"       # js/donostia/data-alderdi.js (Alderdi Eder's gardens)
echo "Donostia data rebuilt"
