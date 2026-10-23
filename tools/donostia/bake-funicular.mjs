// tools/donostia/bake-funicular.mjs
// usage: node tools/donostia/bake-funicular.mjs
// Bakes the Igeldo data behind js/donostia/landmarks/igeldo.js into js/donostia/data-funicular.js, so the browser never
// converts OpenStreetMap lon/lat:
//   - the 1912 funicular from the Ondarreta station to the summit: OSM railway=funicular ways chained into the two
//     routes the cars take (they share the line but for the passing loop halfway up), with the bridge spans flagged;
//   - the Torreón's corner turrets and the lighthouse's round tower (OSM building:part outlines as circles);
//   - the Montaña Suiza (1928 scenic railway) as a closed centreline: OSM maps only the span over the boating pond, so
//     the loop is traced from the municipal 1:500 map's TRENBIDEA strips (tools/donostia/data/c500_TRENBIDEA.json,
//     features 0, 12, 13, 14), with its gaps (station shed, covered turns) bridged by eye.
// Inputs: tools/donostia/data/osm_streets.json, osm_places.json (© OpenStreetMap contributors, ODbL) and the 1:500 map
// (Donostiako Udala, CC BY-SA 3.0); the output is share-alike like the rest of the derived data.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, loadLayer, lonLatToLocal, log } from './lib.mjs';

const ROOT = path.join(HERE, '..', '..');
const OUT = path.join(ROOT, 'js', 'donostia', 'data-funicular.js');
const r2 = (v) => Math.round(v * 100) / 100;
// the funicular climbs Igeldo's eastern flank: anything outside this box is another funicular (Morlans, Ulía...)
const IGELDO_BOX = { minX: -1700, maxX: -1400, minZ: 0, maxZ: 300 };

// --- Funicular -----------------------------------------------------------------------------------------------------------

function funicularRoutes() {
  const ways = loadLayer('osm_streets.json').elements.filter((e) => e.tags?.railway === 'funicular' && e.geometry);
  const nodes = new Map(); // rounded local position -> { x, z, edges: [{ to, bridge }] }
  const key = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
  const node = (x, z) => {
    const k = key(x, z);
    if (!nodes.has(k)) nodes.set(k, { k, x, z, edges: [] });
    return nodes.get(k);
  };
  for (const w of ways) {
    const pts = w.geometry.map((g) => lonLatToLocal(g.lon, g.lat));
    if (!pts.every(([x, z]) => x > IGELDO_BOX.minX && x < IGELDO_BOX.maxX && z > IGELDO_BOX.minZ && z < IGELDO_BOX.maxZ)) continue;
    const bridge = w.tags.bridge === 'yes';
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = node(...pts[i]), b = node(...pts[i + 1]);
      if (a === b) continue;
      // overlapping ways (the station's covered stub and the bridge share a segment): keep one edge, bridge wins
      const ab = a.edges.find((e) => e.to === b);
      if (ab) { ab.bridge ||= bridge; b.edges.find((e) => e.to === a).bridge ||= bridge; continue; }
      a.edges.push({ to: b, bridge });
      b.edges.push({ to: a, bridge });
    }
  }
  const ends = [...nodes.values()].filter((n) => n.edges.length === 1);
  if (ends.length !== 2) throw new Error(`funicular: expected 2 line ends, found ${ends.length}`);
  // bottom = the lower (southern, Ondarreta) end
  const [bottom, top] = ends.sort((p, q) => q.z - p.z);
  // the two simple paths between the ends (the line is a single passing loop)
  const routes = [];
  const walk = (n, seen, path) => {
    if (n === top) { routes.push(path.slice()); return; }
    for (const e of n.edges) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      path.push(e);
      walk(e.to, seen, path);
      path.pop();
      seen.delete(e.to);
    }
  };
  walk(bottom, new Set([bottom]), []);
  if (routes.length !== 2) throw new Error(`funicular: expected 2 routes, found ${routes.length}`);
  return routes.map((edges) => {
    const pts = [r2(bottom.x), r2(bottom.z)];
    const bridges = [];
    for (const e of edges) {
      pts.push(r2(e.to.x), r2(e.to.z));
      bridges.push(e.bridge ? 1 : 0);
    }
    return { pts, bridges };
  });
}

// --- Building parts (circles fitted to OSM outlines) --------------------------------------------------------------------

function circleOf(ring) {
  let cx = 0, cz = 0;
  for (const [x, z] of ring) { cx += x; cz += z; }
  cx /= ring.length; cz /= ring.length;
  let r = 0;
  for (const [x, z] of ring) r += Math.hypot(x - cx, z - cz);
  return [r2(cx), r2(cz), r2(r / ring.length)];
}

function buildingParts() {
  const byId = new Map(loadLayer('osm_places.json').elements.map((e) => [e.id, e]));
  const ring = (id) => {
    const e = byId.get(id);
    if (!e?.geometry) throw new Error(`OSM way ${id} missing`);
    const pts = e.geometry.map((g) => lonLatToLocal(g.lon, g.lat));
    return { pts: pts.slice(0, -1), tags: e.tags };
  };
  // El Torreón's four corbelled corner turrets: [x, z, radius, bottom, top] (m above the tower's ground)
  const turrets = [1460972037, 1460972038, 1460972039, 1460972040].map((id) => {
    const { pts, tags } = ring(id);
    return [...circleOf(pts), Number(tags.min_height), Number(tags.height)];
  });
  // the Igeldo lighthouse's round tower on the seaward end of the keeper's house
  const lighthouseTower = circleOf(ring(1460977412).pts);
  return { turrets, lighthouseTower };
}

// --- Montaña Suiza ----------------------------------------------------------------------------------------------------

// Centreline traced from the 1:500 TRENBIDEA strips (each strip is the 1.8 m wide track), clockwise from above starting
// at the north-eastern end of the western leg; points between strips are where the map shows no track
const COASTER_TRACE = [
  [-1744.2, 20.4], [-1755.1, 26.0], [-1766.8, 31.8], [-1774.5, 35.6], [-1779.6, 39.3], [-1781.8, 43.9], [-1784.0, 60.0],
  [-1786.9, 86.3], [-1788.0, 91.7], [-1786.6, 96.3], [-1784.5, 97.6], [-1781.4, 98.1], [-1778.3, 97.8], [-1775.8, 96.6],
  [-1773.0, 93.6], [-1769.1, 89.3], [-1766.0, 86.1], [-1754.5, 79.3], [-1747.7, 75.2], [-1737.8, 69.5], [-1726.3, 62.6],
  [-1716.3, 57.0], [-1704.7, 50.3], [-1696.2, 45.8], [-1687.0, 39.4], [-1674.0, 32.2], [-1671.0, 29.6], [-1669.3, 26.5],
  [-1668.8, 22.4], [-1669.6, 17.4], [-1672.6, 12.6], [-1677.6, 9.0], [-1684.3, 6.3], [-1687.7, 2.0], [-1689.7, -0.9],
  [-1692.2, -2.0], [-1695.0, -2.4], [-1697.3, -2.1], [-1700.3, -0.8], [-1712.6, 5.9], [-1723.9, 10.7], [-1734.0, 15.6]
];

// Closed centripetal Catmull-Rom through the trace, resampled every `step` metres
function closedSpline(pts, step) {
  const n = pts.length;
  const P = (i) => pts[((i % n) + n) % n];
  const dense = [];
  for (let i = 0; i < n; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    const tj = (a, b) => Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])) || 1e-4;
    const t1 = tj(p0, p1), t2 = t1 + tj(p1, p2), t3 = t2 + tj(p2, p3);
    for (let k = 0; k < 20; k++) {
      const t = t1 + ((t2 - t1) * k) / 20;
      const out = [0, 0];
      for (let c = 0; c < 2; c++) {
        const a1 = ((t1 - t) / t1) * p0[c] + (t / t1) * p1[c];
        const a2 = ((t2 - t) / (t2 - t1)) * p1[c] + ((t - t1) / (t2 - t1)) * p2[c];
        const a3 = ((t3 - t) / (t3 - t2)) * p2[c] + ((t - t2) / (t3 - t2)) * p3[c];
        const b1 = ((t2 - t) / t2) * a1 + (t / t2) * a2;
        const b2 = ((t3 - t) / (t3 - t1)) * a2 + ((t - t1) / (t3 - t1)) * a3;
        out[c] = ((t2 - t) / (t2 - t1)) * b1 + ((t - t1) / (t2 - t1)) * b2;
      }
      dense.push(out);
    }
  }
  dense.push(dense[0]);
  let total = 0;
  const cum = [0];
  for (let i = 1; i < dense.length; i++) cum.push((total += Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1])));
  const count = Math.round(total / step);
  const out = [];
  let j = 0;
  for (let k = 0; k < count; k++) {
    const s = (k * total) / count;
    while (cum[j + 1] < s) j++;
    const f = (s - cum[j]) / (cum[j + 1] - cum[j] || 1);
    out.push(r2(dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f), r2(dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f));
  }
  return { pts: out, length: total };
}

// --- Write ------------------------------------------------------------------------------------------------------------

const routes = funicularRoutes();
const parts = buildingParts();
const coaster = closedSpline(COASTER_TRACE, 1.5);
const lengths = routes.map((r) => {
  let l = 0;
  for (let k = 2; k < r.pts.length; k += 2) l += Math.hypot(r.pts[k] - r.pts[k - 2], r.pts[k + 1] - r.pts[k - 1]);
  return l;
});

const data = {
  funicular: routes,
  turrets: parts.turrets,
  lighthouseTower: parts.lighthouseTower,
  coaster: coaster.pts
};
const js = `// js/donostia/data-funicular.js — generated by tools/donostia/bake-funicular.mjs, do not edit.
// Igeldo: funicular routes, Torreón turrets, lighthouse tower, Montaña Suiza centreline (local frame, metres).
// © OpenStreetMap contributors (ODbL); Donostiako Udala 1:500 map (CC BY-SA 3.0).
export const IGELDO = ${JSON.stringify(data)};
`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${(js.length / 1e3).toFixed(1)} kB; funicular routes ${lengths.map((l) => l.toFixed(0)).join(' / ')} m ` +
  `(plan), ${routes.map((r) => r.bridges.filter(Boolean).length).join(' / ')} bridge spans; coaster ${coaster.length.toFixed(0)} m`);
