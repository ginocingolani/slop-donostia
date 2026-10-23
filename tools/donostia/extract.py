"""Convert the raw Donostia sources (tools/donostia/raw, see fetch.sh) into compact local-frame JSON layers.

usage: python3 -I tools/donostia/extract.py

Standard library only. Every source is ETRS89 / UTM 30N (EPSG:25830); coordinates are written in the local frame of
frame.json (x east, z south, metres, rounded to cm). Features are kept whole when their bounds touch the core extent
(plus clipMargin); nothing is cut. The DTM tiles are only unzipped here: tools/donostia/build.mjs parses them.

Outputs (committed, like tools/data upstream):
  data/c500_<LAYER>.json   municipal 1:500 cartography layers (CC BY-SA 3.0)
  data/b5m_buildings.json  b5m building footprints with heights (CC BY 4.0)
  data/bathy_isobaths.json geoEuskadi 1 m isobaths over the terrain tiles (CC BY 4.0)
  data/auzoak.json         neighbourhood boundaries (CC BY-SA 3.0)
"""
import io
import json
import os
import sqlite3
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
OUT = os.path.join(HERE, 'data')

with open(os.path.join(HERE, 'frame.json'), encoding='utf-8') as f:
    FRAME = json.load(f)
E0, N0 = FRAME['origin']
CORE = FRAME['core']
MARGIN = FRAME['clipMargin']
# Bathymetry spans the whole terrain-tile union so the sea floor reaches the horizon tiles
WIDE = {'minX': -6200, 'maxX': 4400, 'minZ': -3900, 'maxZ': 3500}

C500_LAYERS = [
    'ERAIKINA', 'ERAIKINA LURREAN', 'EraikinEgitura', 'ARKUPEA', 'ATARIPEA', 'PASABIDEA', 'BARRUKO PATIOA',
    'UHARTE PATIOA', 'EraikinArinak', 'ESTALPEA', 'KIOSKOA', 'AURRIA', 'BEROTEGIA',
    'ERREPIDEA', 'IBILGAILUEN ZONA', 'AUTOBIDEA', 'BIDEA', 'ESPALOIA', 'OINEZKOEN ZONA', 'ESKAILERA',
    'KANPO-IGOGAILUA', 'BIDEGORRIA', 'TRENBIDEA', 'ZUHAITZ TXORKOA', 'ZuhaiztiGuneak', 'LORATEGI EREMUA',
    'LANDARE HESIA', 'PARTERREA', 'SASOIKO LORATEGIA', 'HONDARTZA',
]


def local(e, n):
    return round(e - E0, 2), round(N0 - n, 2)


def touches(bounds, ext, margin=MARGIN):
    """bounds = (minE, minN, maxE, maxN) in UTM."""
    min_x, max_x = bounds[0] - E0, bounds[2] - E0
    min_z, max_z = N0 - bounds[3], N0 - bounds[1]
    return not (max_x < ext['minX'] - margin or min_x > ext['maxX'] + margin or
                max_z < ext['minZ'] - margin or min_z > ext['maxZ'] + margin)


def ring_area(pts):
    """Signed shoelace area of a flat [e0, n0, e1, n1, ...] ring in UTM (counter-clockwise > 0)."""
    a = 0.0
    n = len(pts) // 2
    for i in range(n):
        j = (i + 1) % n
        a += pts[2 * i] * pts[2 * j + 1] - pts[2 * j] * pts[2 * i + 1]
    return a / 2


def point_in_ring(e, n, pts):
    inside = False
    m = len(pts) // 2
    j = m - 1
    for i in range(m):
        xi, yi, xj, yj = pts[2 * i], pts[2 * i + 1], pts[2 * j], pts[2 * j + 1]
        if (yi > n) != (yj > n) and e < (xj - xi) * (n - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def group_rings(rings):
    """Shapefile/WKB rings -> polygons [outer, *holes]. The outer ring is the larger-magnitude one; holes go to the
    outer ring that contains their first vertex (shapefiles store outers clockwise, but WKB writers vary)."""
    if len(rings) == 1:
        return [rings]
    by_size = sorted(rings, key=lambda r: -abs(ring_area(r)))
    polys = []
    for r in by_size:
        host = None
        for poly in polys:
            if point_in_ring(r[0], r[1], poly[0]) and not any(point_in_ring(r[0], r[1], h) for h in poly[1:]):
                host = poly
        if host is not None and len(host) >= 1 and abs(ring_area(r)) < abs(ring_area(host[0])):
            host.append(r)
        else:
            polys.append([r])
    return polys


def drop_closing(pts):
    if len(pts) >= 4 and pts[0] == pts[-2] and pts[1] == pts[-1]:
        return pts[:-2]
    return pts


def simplify(pts, tol, closed):
    """Douglas-Peucker on a flat [e, n, ...] list. Closed rings keep >= 3 vertices, open lines their end points."""
    n = len(pts) // 2
    if tol <= 0 or n <= (4 if closed else 2):
        return pts
    keep = [False] * n
    keep[0] = keep[n - 1] = True
    if closed:  # split the ring at the vertex farthest from vertex 0
        far = max(range(1, n), key=lambda i: (pts[2 * i] - pts[0]) ** 2 + (pts[2 * i + 1] - pts[1]) ** 2)
        keep[far] = True
        stack = [(0, far), (far, n - 1)]
    else:
        stack = [(0, n - 1)]
    tol2 = tol * tol
    while stack:
        a, b = stack.pop()
        ax, ay, bx, by = pts[2 * a], pts[2 * a + 1], pts[2 * b], pts[2 * b + 1]
        dx, dy = bx - ax, by - ay
        len2 = dx * dx + dy * dy or 1e-12
        idx, best = -1, tol2
        for i in range(a + 1, b):
            px, py = pts[2 * i] - ax, pts[2 * i + 1] - ay
            t = max(0.0, min(1.0, (px * dx + py * dy) / len2))
            ex, ey = px - t * dx, py - t * dy
            d2 = ex * ex + ey * ey
            if d2 > best:
                idx, best = i, d2
        if idx >= 0:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    out = [v for i in range(n) if keep[i] for v in (pts[2 * i], pts[2 * i + 1])]
    return out if len(out) >= (6 if closed else 4) else pts


TOLERANCE = 0.05  # m; the 1:500 survey is good to about a decimetre


def to_local_flat(pts, closed=True, tol=TOLERANCE):
    pts = simplify(pts, tol, closed)
    out = []
    for i in range(0, len(pts), 2):
        x, z = local(pts[i], pts[i + 1])
        out += [x, z]
    return out


# --- Shapefile (.shp + .dbf) --------------------------------------------------------------------------------------

def read_dbf(data, encoding):
    nrec, hlen, rlen = struct.unpack('<IHH', data[4:12])
    fields = []
    pos = 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b'\0')[0].decode('ascii', 'replace')
        ftype = chr(data[pos + 11])
        flen = data[pos + 16]
        fields.append((name, ftype, flen))
        pos += 32
    records = []
    for r in range(nrec):
        base = hlen + r * rlen
        if data[base] == 0x2A:  # deleted
            records.append(None)
            continue
        off = base + 1
        rec = {}
        for name, ftype, flen in fields:
            raw = data[off:off + flen]
            off += flen
            text = raw.decode(encoding, 'replace').strip()
            if ftype in 'NF':
                try:
                    num = float(text) if text else None
                    rec[name] = int(num) if num is not None and num.is_integer() and 'e' not in text.lower() else num
                except ValueError:
                    rec[name] = None
            else:
                rec[name] = text or None
        records.append(rec)
    return records


def read_shp(data):
    """Yields (shape_type, bounds, parts) per record; parts are flat [e, n, ...] lists (points: one part [e, n])."""
    pos = 100
    size = len(data)
    while pos + 8 <= size:
        _num, clen = struct.unpack('>ii', data[pos:pos + 8])
        content = data[pos + 8:pos + 8 + clen * 2]
        pos += 8 + clen * 2
        stype = struct.unpack('<i', content[:4])[0]
        if stype == 0:
            yield 0, None, []
            continue
        base = stype % 10
        if base == 1:  # Point / PointZ / PointM
            e, n = struct.unpack('<2d', content[4:20])
            yield 1, (e, n, e, n), [[e, n]]
        elif base in (3, 5):  # PolyLine / Polygon (+Z, +M)
            bounds = struct.unpack('<4d', content[4:36])
            nparts, npts = struct.unpack('<2i', content[36:44])
            starts = list(struct.unpack(f'<{nparts}i', content[44:44 + 4 * nparts]))
            coords = struct.unpack(f'<{2 * npts}d', content[44 + 4 * nparts:44 + 4 * nparts + 16 * npts])
            starts.append(npts)
            parts = [list(coords[2 * starts[i]:2 * starts[i + 1]]) for i in range(nparts)]
            yield base, bounds, parts
        elif base == 8:  # MultiPoint
            bounds = struct.unpack('<4d', content[4:36])
            npts = struct.unpack('<i', content[36:40])[0]
            coords = struct.unpack(f'<{2 * npts}d', content[40:40 + 16 * npts])
            yield 8, bounds, [list(coords[2 * i:2 * i + 2]) for i in range(npts)]
        else:
            raise ValueError(f'unsupported shape type {stype}')


def open_shapefile(zip_path):
    """Returns (shp bytes, dbf bytes, encoding) of the first shapefile in a zip (searches sub-folders)."""
    with zipfile.ZipFile(zip_path) as z:
        names = z.namelist()
        shp = next(n for n in names if n.lower().endswith('.shp'))
        stem = shp[:-4]
        find = lambda ext: next((n for n in names if n.lower() == (stem + ext).lower()), None)
        dbf = z.read(find('.dbf'))
        cpg = find('.cpg')
        enc = 'latin-1'
        if cpg:
            label = z.read(cpg).decode('ascii', 'replace').strip().lower()
            enc = 'utf-8' if '65001' in label or 'utf' in label else ('latin-1' if '1252' in label or '8859' in label else enc)
        return z.read(shp), dbf, enc


def extract_shapefile(zip_path, ext, drop_fields=('Azalera', 'Shape_Leng', 'Shape_Area'), tol=TOLERANCE):
    shp, dbf, enc = open_shapefile(zip_path)
    records = read_dbf(dbf, enc)
    features = []
    kind = None
    for (stype, bounds, parts), props in zip(read_shp(shp), records):
        if stype == 0 or props is None or not touches(bounds, ext):
            continue
        props = {k: v for k, v in props.items() if v is not None and k not in drop_fields}
        if stype == 5:
            kind = 'polygon'
            for poly in group_rings([drop_closing(p) for p in parts if len(p) >= 6]):
                features.append({'p': props, 'g': [to_local_flat(r, True, tol) for r in poly]})
        elif stype == 3:
            kind = 'line'
            features.append({'p': props, 'g': [to_local_flat(p, False, tol) for p in parts if len(p) >= 4]})
        else:
            kind = 'point'
            for p in parts:
                features.append({'p': props, 'g': list(local(p[0], p[1]))})
    return kind, features


# --- GeoPackage (b5m buildings) -----------------------------------------------------------------------------------

def gpkg_rings(blob):
    """GeoPackage geometry blob -> list of polygons, each a list of flat UTM rings."""
    flags = blob[3]
    env = (0, 32, 48, 48, 64)[(flags >> 1) & 7]
    wkb = blob[8 + env:]
    polys = []

    def parse(off):
        bo = '<' if wkb[off] == 1 else '>'
        gtype = struct.unpack(bo + 'I', wkb[off + 1:off + 5])[0]
        dims = 2
        if gtype & 0x80000000 or 1000 <= (gtype & 0xFFFF) < 2000:
            dims = 3
        if 3000 <= (gtype & 0xFFFF) < 4000:
            dims = 4
        if 2000 <= (gtype & 0xFFFF) < 3000 or gtype & 0x40000000:
            dims = 3 if dims == 2 else 4
        base = (gtype & 0x0FFFFFFF) % 1000
        off += 5
        if base == 3:
            nrings = struct.unpack(bo + 'I', wkb[off:off + 4])[0]
            off += 4
            rings = []
            for _ in range(nrings):
                npts = struct.unpack(bo + 'I', wkb[off:off + 4])[0]
                off += 4
                vals = struct.unpack(bo + f'{npts * dims}d', wkb[off:off + 8 * npts * dims])
                off += 8 * npts * dims
                flat = []
                for i in range(npts):
                    flat += [vals[i * dims], vals[i * dims + 1]]
                rings.append(drop_closing(flat))
            polys.append(rings)
        elif base == 6:
            count = struct.unpack(bo + 'I', wkb[off:off + 4])[0]
            off += 4
            for _ in range(count):
                off = parse(off)
        else:
            raise ValueError(f'unsupported WKB type {gtype}')
        return off

    parse(0)
    return polys


def extract_b5m(gpkg_path):
    db = sqlite3.connect(f'file:{gpkg_path}?mode=ro', uri=True)
    min_e, max_e = E0 + CORE['minX'] - MARGIN, E0 + CORE['maxX'] + MARGIN
    min_n, max_n = N0 - CORE['maxZ'] - MARGIN, N0 - CORE['minZ'] + MARGIN
    rows = db.execute(
        '''select b.FID, b.geom, b.AVERAGE_HEIGHT, b.MAX_HEIGHT, b.DATE_CONSTRUCTION, b.NAME_BUILDING_EU,
                  b.NAME_BUILDING_ES, b.STREET_EU, b.STREET_ES, b.HOUSE_NUMBER, b.BIS, b.TYPE_EN, b.SUBTYPE_EN,
                  b.MUNI_EU, b.B5MCODE
           from GFA_DSET_BU b join rtree_GFA_DSET_BU_geom r on r.id = b.FID
           where r.maxx >= ? and r.minx <= ? and r.maxy >= ? and r.miny <= ?''',
        (min_e, max_e, min_n, max_n))
    keys = ['fid', None, 'avg', 'max', 'built', 'name_eu', 'name_es', 'street_eu', 'street_es', 'number', 'bis',
            'type', 'subtype', 'muni', 'code']
    features = []
    for row in rows:
        props = {}
        for k, v in zip(keys, row):
            if k is None or v is None or v == '':
                continue
            props[k] = round(v, 2) if isinstance(v, float) else v
        for rings in gpkg_rings(row[1]):
            for poly in group_rings([r for r in rings if len(r) >= 6]):
                features.append({'p': props, 'g': [to_local_flat(r) for r in poly]})
    return features


# --- main ---------------------------------------------------------------------------------------------------------

def write(name, payload):
    path = name if os.path.isabs(name) else os.path.join(OUT, name)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{os.path.basename(path)}: {len(payload.get("features", []))} features, {os.path.getsize(path) / 1e6:.2f} MB')


def main():
    os.makedirs(OUT, exist_ok=True)
    c500 = 'Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0)'
    for layer in C500_LAYERS:
        path = os.path.join(RAW, 'carto', layer + '.zip')
        if not os.path.exists(path):
            print(f'missing {path}', file=sys.stderr)
            continue
        kind, features = extract_shapefile(path, CORE)
        write(f'c500_{layer.replace(" ", "_")}.json', {'layer': layer, 'kind': kind, 'source': c500, 'features': features})

    auzoak = os.path.join(RAW, 'carto', 'Auzoak.zip')
    if os.path.exists(auzoak):
        kind, features = extract_shapefile(auzoak, CORE)
        write('auzoak.json', {'layer': 'Auzoak', 'kind': kind, 'source': 'Donostiako Udala, auzoak (CC BY-SA 3.0)',
                              'features': features})

    write('b5m_buildings.json', {
        'layer': 'GFA_DSET_BU', 'kind': 'polygon',
        'source': 'b5m, Gipuzkoako Foru Aldundia / Diputación Foral de Gipuzkoa (CC BY 4.0), https://b5m.gipuzkoa.eus',
        'note': 'avg / max = AVERAGE_HEIGHT / MAX_HEIGHT in metres above ground; built = cadastral date (often a refurbishment)',
        'features': extract_b5m(os.path.join(RAW, 'b5m', 'GFA_DSET_BU.gpkg'))})

    # Bake-only input (tens of MB even simplified), so it stays in the gitignored raw cache
    bathy = os.path.join(RAW, 'bathy', 'CT_ISOBATAS_1m_ETRS89.zip')
    if os.path.exists(bathy):
        kind, features = extract_shapefile(bathy, WIDE, drop_fields=('ID', 'Length'), tol=1.5)
        write(os.path.join(RAW, 'bathy', 'isobaths.json'), {
            'layer': 'CT_ISOBATAS_1m', 'kind': kind, 'note': 'CONTOUR = depth in metres (negative)',
            'source': 'Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi, isobatas 1 m (CC BY 4.0)', 'features': features})

    dtm_dir = os.path.join(RAW, 'dtm')
    for name in sorted(os.listdir(dtm_dir)):
        if not name.endswith('.zip'):
            continue
        with zipfile.ZipFile(os.path.join(dtm_dir, name)) as z:
            for member in z.namelist():
                target = os.path.join(dtm_dir, os.path.basename(member))
                if member.lower().endswith('.asc') and not os.path.exists(target):
                    with z.open(member) as src, open(target, 'wb') as dst:
                        while chunk := src.read(1 << 20):
                            dst.write(chunk)
                    print(f'unzipped {os.path.basename(member)}')


if __name__ == '__main__':
    main()
