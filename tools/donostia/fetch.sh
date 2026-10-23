#!/bin/bash
# usage: tools/donostia/fetch.sh
# Downloads the raw Donostia / San Sebastián sources into tools/donostia/raw (gitignored, ~0.6 GB).
# Files already present are kept, so an interrupted run can simply be repeated.
# Sources & licences: see tools/donostia/README.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RAW="$HERE/raw"
UA="slop-donostia (https://github.com/ginocingolani/slop-donostia)"
mkdir -p "$RAW/dtm" "$RAW/carto" "$RAW/b5m" "$RAW/bathy" "$RAW/osm"

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
  "ZUHAITZ TXORKOA" ZuhaiztiGuneak "LORATEGI EREMUA" "LANDARE HESIA" PARTERREA "SASOIKO LORATEGIA" HONDARTZA; do
  get "$CARTO/$layer.zip" "$RAW/carto/$layer.zip"
done
get https://www.donostia.eus/ide/ADMINISTRAZIO_MUGAK-LIMITES_ADMINISTRATIVOS/shp/Auzoak.zip "$RAW/carto/Auzoak.zip"

# OpenStreetMap (ODbL): names, landmarks, bridges and street furniture. Committed, like tools/data/osm_*.json upstream.
for q in "$HERE"/queries/*.overpassql; do
  name=$(basename "$q" .overpassql)
  out="$HERE/data/osm_$name.json"
  if [ ! -s "$out" ]; then
    bash "$HERE/../overpass.sh" "$out" "$q"
  fi
done

echo "raw sources ready in $RAW"
