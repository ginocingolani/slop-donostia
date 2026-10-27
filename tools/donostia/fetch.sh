#!/bin/bash
# usage: tools/donostia/fetch.sh [--refresh-osm]
# Downloads the raw Donostia / San Sebastián sources into tools/donostia/raw (gitignored, ~0.6 GB) and the
# OpenStreetMap snapshot into tools/donostia/data/osm_*.json (committed).
# Raw files already present are kept, so an interrupted run can simply be repeated. An OSM query is re-run when its
# snapshot is missing or the query changed since the snapshot was taken (tools/donostia/data/osm_queries.sha256 records
# the hash of each query as sent); --refresh-osm re-runs them all for a fresh snapshot.
# Sources & licences: see tools/donostia/README.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RAW="$HERE/raw"
UA="slop-donostia (https://github.com/ginocingolani/slop-donostia)"
REFRESH_OSM=0
for arg in "$@"; do
  case "$arg" in
    --refresh-osm) REFRESH_OSM=1 ;;
    *) echo "usage: $0 [--refresh-osm]" >&2; exit 1 ;;
  esac
done
mkdir -p "$RAW/dtm" "$RAW/carto" "$RAW/b5m" "$RAW/bathy"

get() { # <url> <out>
  local url=$1 out=$2
  if [ -s "$out" ]; then return 0; fi
  curl -fsS --retry 3 --retry-delay 5 -m 1800 -A "$UA" -o "$out.part" "${url// /%20}"
  mv -- "$out.part" "$out"
  echo "ok $(basename "$out") $(wc -c < "$out" | tr -d ' ') bytes"
}

# 1 m bare-earth terrain (Basque Government LiDAR 2017, CC BY 4.0). Tiles are mdt_<sheet>_<column>_<row>, ~3.5 x 2.5 km.
DTM=https://www.geo.euskadi.eus/lidar/DatosDescarga/MDE/MAX_ACTUALIDAD/MDT_LIDAR_2017_ETRS89/MDT
for tile in 064_4_1 064_5_1 064_6_1 064_4_2 064_5_2 064_6_2 064_4_3 064_5_3 064_6_3 040_6_8; do
  get "$DTM/H0${tile%%_*}/mdt_$tile.zip" "$RAW/dtm/mdt_$tile.zip"
done

# Building footprints with measured heights for all of Gipuzkoa (b5m, Diputación Foral de Gipuzkoa, CC BY 4.0)
get https://b5m.gipuzkoa.eus/datasets/GFA_DSET_BU.gpkg "$RAW/b5m/GFA_DSET_BU.gpkg"

# 1 m isobaths of the Basque coast (geoEuskadi, CC BY 4.0)
get https://www.geo.euskadi.eus/cartografia/DatosDescarga/Elevacion/Batimetria/CT_ISOBATAS_1m_ETRS89.zip "$RAW/bathy/CT_ISOBATAS_1m_ETRS89.zip"

# Municipal 1:500 cartography (Donostiako Udala / Ayuntamiento de San Sebastián, CC BY-SA 3.0)
CARTO=https://www.donostia.eus/ide/LURRALDEA_KARTOGRAFIA-TERRITORIO/KartografiaTematikoa/Kartografia_shp
for layer in ERAIKINA "ERAIKINA LURREAN" EraikinEgitura ARKUPEA ATARIPEA PASABIDEA "BARRUKO PATIOA" "UHARTE PATIOA" \
  EraikinArinak ESTALPEA KIOSKOA AURRIA BEROTEGIA \
  ERREPIDEA "IBILGAILUEN ZONA" AUTOBIDEA BIDEA ESPALOIA "OINEZKOEN ZONA" ESKAILERA KANPO-IGOGAILUA BIDEGORRIA TRENBIDEA \
  "ZUHAITZ TXORKOA" ZuhaiztiGuneak "LORATEGI EREMUA" "LANDARE HESIA" PARTERREA "SASOIKO LORATEGIA" HONDARTZA \
  ARRAPALA KAIA PANTALANA DIKEA KOSTALDEA NASA HORMA KotaPuntuak EZPONDA ZINTARRIA TUNELA; do
  get "$CARTO/$layer.zip" "$RAW/carto/$layer.zip"
done
get https://www.donostia.eus/ide/ADMINISTRAZIO_MUGAK-LIMITES_ADMINISTRATIVOS/shp/Auzoak.zip "$RAW/carto/Auzoak.zip"

# Orthophoto 2025 (geoEuskadi WMS; credit «Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi»): 500 m tiles at 12.5 cm/px
# over the beaches' accesses and the port, named by the local frame of their north-west corner (x east, z south)
mkdir -p "$RAW/ortho"
WMS='https://www.geo.euskadi.eus/WMS_ORTOARGAZKIAK?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=ORTO_2025&STYLES=&CRS=EPSG:25830&WIDTH=4000&HEIGHT=4000&FORMAT=image/jpeg'
for tile in port:-350:-300 concha-ne:0:150 concha-mid:-500:400 concha-w:-1000:400 ondarreta:-1400:100 \
  zurriola-w:900:-900 zurriola-e:1300:-900 aiete:-400:1600 aiete-s:-400:2100; do
  IFS=: read -r name x0 z0 <<< "$tile"
  bbox="$((582000 + x0)),$((4797000 - z0 - 500)),$((582000 + x0 + 500)),$((4797000 - z0))"
  get "$WMS&BBOX=$bbox" "$RAW/ortho/ortho2025-${name}_x${x0}_z${z0}.jpg"
done

# OpenStreetMap (ODbL): names, landmarks, bridges and street furniture. Committed, like tools/data/osm_*.json upstream.
# The queries' {{bbox}} (Overpass Turbo's own placeholder, so a query file also runs there over the map view) is the
# core plus lib.mjs's OSM_MARGIN, which bake-streets.mjs keeps for the radar.
BBOX=$(node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { osmBBox } = await import(pathToFileURL(process.argv[1]).href);
  process.stdout.write(osmBBox());
' "$HERE/lib.mjs")
STAMPS="$HERE/data/osm_queries.sha256"
touch "$STAMPS"
QUERY=$(mktemp "${TMPDIR:-/tmp}/donostia-query.XXXXXX")
trap 'rm -f -- "$QUERY"' EXIT
for q in "$HERE"/queries/*.overpassql; do
  name=$(basename "$q" .overpassql)
  out="$HERE/data/osm_$name.json"
  sed "s/{{bbox}}/$BBOX/g" "$q" > "$QUERY"
  sum=$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(require("node:fs").readFileSync(process.argv[1])).digest("hex"))' "$QUERY")
  if [ "$REFRESH_OSM" = 1 ] || [ ! -s "$out" ] || ! grep -qx "$sum  $name" "$STAMPS"; then
    echo "OSM $name (bbox $BBOX)"
    bash "$HERE/../overpass.sh" "$out" "$QUERY"
    { grep -v "  $name\$" "$STAMPS" || true; echo "$sum  $name"; } | sort -k 2 > "$STAMPS.tmp"
    mv -- "$STAMPS.tmp" "$STAMPS"
  fi
done

echo "raw sources ready in $RAW"
