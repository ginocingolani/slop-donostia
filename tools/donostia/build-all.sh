#!/bin/bash
# usage: tools/donostia/build-all.sh [--fetch]
# Rebuilds every Donostia data file in dependency order. With --fetch it first downloads the raw sources and
# re-extracts them (tools/donostia/fetch.sh + extract.py); otherwise it starts from the committed tools/donostia/data.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
cd "$ROOT"
NODE="node --max-old-space-size=8192"

if [ "${1:-}" = "--fetch" ]; then
  bash "$HERE/fetch.sh"
  python3 -I "$HERE/extract.py"
fi

# terrain, water, buildings, landmarks & teleports -> data/donostia/terrain-*.png, water.png, js/donostia/geodata.js
$NODE "$HERE/build.mjs"
# these read build.mjs's outputs
$NODE "$HERE/bake-ground.mjs"        # data/donostia/ground-*.png
$NODE "$HERE/bake-bridges.mjs"       # js/donostia/data-bridges.js
$NODE "$HERE/bake-streetscape.mjs"   # js/donostia/data-streetscape.js (trees, railing, lamps, benches)
$NODE "$HERE/bake-streets.mjs"       # js/donostia/data-streets.js (street names & districts for the HUD)
$NODE "$HERE/bake-urgull-parts.mjs"  # js/donostia/data-urgull-parts.js
$NODE "$HERE/bake-funicular.mjs"     # js/donostia/data-funicular.js
echo "Donostia data rebuilt"
