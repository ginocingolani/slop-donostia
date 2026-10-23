// tools/donostia/bake-urgull-parts.mjs
// OpenStreetMap's 3D building parts of Mota castle (the keep, the batteries, the Sagrado Corazón's pedestal & statue)
// and of the Naval Museum (the old Consulado), for js/donostia/landmarks/mota-gaztelua.js & itsas-museoa.js.
//
// OSM outlines were traced on imagery and sit a few metres off the municipal 1:500 map, which is surveyed and agrees
// with the LiDAR. Each landmark's parts are moved by the one translation that best lays the OSM building outline onto
// its 1:500 outline (least squares on vertex-to-outline distances), so the parts land on the hidden extrusion.
//
//   node tools/donostia/bake-urgull-parts.mjs    -> js/donostia/data-urgull-parts.js
//
// Data © OpenStreetMap contributors (ODbL) and Donostiako Udala (CC BY-SA 3.0), like the rest of the derived data.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, loadLayer, lonLatToLocal, pointInRing, ringArea, log } from './lib.mjs';

const OUT = path.join(HERE, '../../js/donostia/data-urgull-parts.js');
const SITES = [
  { id: 'mota-gaztelua', way: 28156564, extras: [3696071481] }, // + the Sagrado Corazón monument node
  { id: 'itsas-museoa', way: 27263481, extras: [] }
];

const r2 = (v) => Math.round(v * 100) / 100;

// closed OSM way -> flat local ring without the repeated closing vertex
function wayRing(e) {
  const ring = e.geometry.flatMap((p) => lonLatToLocal(p.lon, p.lat));
  const n = ring.length;
  if (n >= 4 && ring[0] === ring[n - 2] && ring[1] === ring[n - 1]) ring.length = n - 2;
  return ring;
}

function centroid(r) {
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
}

function distToRing(x, z, r) {
  let best = Infinity;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

// Translation (dx, dz) minimising the mean squared distance of the OSM outline's vertices to the 1:500 outline:
// a coarse grid search, then finer ones around the best
function bestShift(osm, ref) {
  const cost = (dx, dz) => {
    let s = 0;
    for (let k = 0; k < osm.length; k += 2) s += distToRing(osm[k] + dx, osm[k + 1] + dz, ref) ** 2;
    return s / (osm.length / 2);
  };
  let best = [0, 0, cost(0, 0)];
  for (const [span, step] of [[10, 0.5], [1, 0.05], [0.1, 0.01]]) {
    const [cx, cz] = best;
    for (let dx = -span; dx <= span + 1e-9; dx += step) {
      for (let dz = -span; dz <= span + 1e-9; dz += step) {
        const c = cost(cx + dx, cz + dz);
        if (c < best[2]) best = [cx + dx, cz + dz, c];
      }
    }
  }
  return { dx: r2(best[0]), dz: r2(best[1]), rms: Math.sqrt(best[2]), before: Math.sqrt(cost(0, 0)) };
}

const num = (v) => (v == null ? undefined : Number.parseFloat(v));

const osm = loadLayer('osm_places.json').elements;
const byId = new Map(osm.map((e) => [`${e.type}/${e.id}`, e]));
const c500 = loadLayer('c500_ERAIKINA.json').features;
const out = {};

for (const site of SITES) {
  const building = byId.get(`way/${site.way}`);
  if (!building) throw new Error(`${site.id}: OSM way ${site.way} missing from osm_places.json`);
  const outline = wayRing(building);
  const [cx, cz] = centroid(outline);
  // the 1:500 building under the OSM outline: the largest one containing its centroid
  const ref = c500.filter((f) => pointInRing(cx, cz, f.g[0])).sort((a, b) => Math.abs(ringArea(b.g[0])) - Math.abs(ringArea(a.g[0])))[0];
  if (!ref) throw new Error(`${site.id}: no 1:500 building under the OSM outline`);
  const shift = bestShift(outline, ref.g[0]);
  log(`${site.id}: OSM -> 1:500 shift (${shift.dx}, ${shift.dz}) m, outline rms ${shift.before.toFixed(2)} -> ${shift.rms.toFixed(2)} m`);
  const move = (r) => r.map((v, k) => r2(v + (k % 2 ? shift.dz : shift.dx)));

  // building:part ways whose centroid lies inside the OSM outline
  const parts = [];
  for (const e of osm) {
    if (e.type !== 'way' || !e.geometry || !e.tags || !e.tags['building:part']) continue;
    const ring = wayRing(e);
    const [px, pz] = centroid(ring);
    if (!pointInRing(px, pz, outline) && distToRing(px, pz, outline) > 0.5) continue;
    const t = e.tags;
    const part = { osm: e.id, kind: t['building:part'], ring: move(ring), height: num(t.height) };
    if (t['min_height']) part.minHeight = num(t['min_height']);
    if (t['roof:shape']) part.roof = t['roof:shape'];
    if (t['roof:height']) part.roofHeight = num(t['roof:height']);
    if (t['roof:direction']) part.roofDirection = num(t['roof:direction']);
    if (t['building:colour']) part.colour = t['building:colour'];
    if (t['roof:colour']) part.roofColour = t['roof:colour'];
    parts.push(part);
  }
  parts.sort((a, b) => a.osm - b.osm);
  const points = site.extras.map((id) => byId.get(`node/${id}`)).filter(Boolean).map((e) => {
    const [x, z] = lonLatToLocal(e.lon, e.lat);
    return { osm: e.id, name: e.tags && e.tags.name, at: [r2(x + shift.dx), r2(z + shift.dz)] };
  });
  out[site.id] = { osm: site.way, shift: [shift.dx, shift.dz], parts, points };
  log(`${site.id}: ${parts.length} parts, ${points.length} points`);
}

const header = `// js/donostia/data-urgull-parts.js — generated by tools/donostia/bake-urgull-parts.mjs, do not edit.
// OpenStreetMap building parts (© OpenStreetMap contributors, ODbL) laid onto the municipal 1:500 outlines (Donostiako
// Udala, CC BY-SA 3.0). Rings are flat [x0, z0, x1, z1, ...] local metres; heights are metres above the ground.
`;
const list = (items) => (items.length ? `[\n${items.map((p) => `      ${JSON.stringify(p)}`).join(',\n')}\n    ]` : '[]');
const body = Object.entries(out).map(([id, v]) =>
  `  '${id}': {\n    osm: ${v.osm}, shift: ${JSON.stringify(v.shift)},\n    parts: ${list(v.parts)},\n    points: ${list(v.points)}\n  }`
).join(',\n');
fs.writeFileSync(OUT, `${header}\nexport const URGULL_PARTS = {\n${body}\n};\n`);
log(`${path.relative(process.cwd(), OUT)}: ${(fs.statSync(OUT).size / 1024).toFixed(1)} kB`);
