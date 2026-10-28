// tools/donostia/bake-marina.mjs
// usage: node tools/donostia/bake-marina.mjs [--preview <dir>]   (after build.mjs: it reads js/donostia/geodata.js and
// data/donostia/terrain-core.png)
// The port's moorings for js/donostia/marina.js -> js/donostia/data-marina.js:
// - Pontoons: the floating walkways of the Kirol portua (the inner basin, boats moored bows-to on both sides), the
//   Donostia marina (the north basin's comb of fingers, the pontoons along its quays and the excursion boats' landing)
//   and the old port. Centre lines from OpenStreetMap (man_made=pier), widths measured on the 2025 orthophoto, the
//   fingers and T-heads cut out of the municipal map's pontoons (PANTALANA: what is left once the walkways are taken
//   out, fitted with rectangles); the pontoons neither map has from the orthophoto (ORTHO below).
// - On them: guide piles through hoops on the walkways' edges, cleats along the berths, service pedestals, a few lamp
//   posts. Gangways down from the quay: the municipal map's ramps onto a pontoon, and the quay steps (walls.mjs's
//   flights, GEO.terrain.stairs) that end by a pontoon, where a gangway carries on from the bottom step; an access gate
//   at the head of each.
// - Quays: bollards and, on the old port's masonry, iron mooring rings along the harbour's quay walls (GEO.terrain.walls)
//   where no pontoon lies alongside, iron ladders down their faces, the fishing quay's timber strakes.
// - The old port's slipway: the notch the municipal quays (KAIA) leave at the foot of Kaiarriba, down into the water.
// - The harbour's water inside the moles and its mouth, for js/donostia/water.js's calm basins.
// Deterministic: fixed visiting orders, no randomness.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, loadLayer, lonLatToLocal, scanRings, pointInRing, encodePNG, previewDir, licenceComment, log } from './lib.mjs';
import { decodePNG } from '../../js/donostia/png.js';
import { nearestWall, wallIndex, visibleWalls } from '../../js/donostia/shore-walls.js';
import { inPort, HARBOUR, MOUTH, slipwayRing } from './port.mjs';

const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'js/donostia/data-marina.js');
const PREVIEW = previewDir();
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);
// (the quays' walls: not the hidden runs where the terrain steps down under a flight of quay steps)
const walls = visibleWalls(GEO.terrain.walls || []);
const wallsIndex = wallIndex(walls, 16, 12);
const stairs = GEO.terrain.stairs || [];

// Pontoon section (m): the deck's freeboard over the water, the floats' draft below it, the fingers a little lower
// than the walkways they hang from (so no two decks share a plane)
const FREEBOARD = 0.45, DRAFT = 0.4;

// --- what the 2025 orthophoto shows (Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi; 12.5 cm/px) ----------------------

// Walkway widths per OSM pier (m), measured on the orthophoto
const WIDTH = {
  // the Kirol portua: walkways along the quay walls, the combs' walkways out from them (T-heads at their free ends),
  // the two long walkways with fingers between the berths, the short spurs off the east walkway
  spine: 2.0, tooth: 1.7, finger: 1.6, spur: 1.5,
  // the Donostia marina: the comb's walkway with its long fingers, the pontoons along the quays
  comb: 2.4, combFinger: 1.0, quay: 1.8, landing: 3.0
};
const OSM_PIERS = {
  spine: [185960954, 185960955, 185960975],
  tooth: [185960956, 185960957, 185960958, 185960960, 185960963, 185960964, 185960965, 185960966, 185960970, 185960971,
    185960972, 185960973],
  finger: [185960969, 185960974],
  spur: [185960959, 185960961, 185960967, 185960968],
  comb: [565481470, 565481462],
  combFinger: [565481464, 565481465, 565481466, 565481467, 565481468, 565481469, 1478608318, 1478608319],
  quay: [565481461, 565481463],
  landing: [1549071103]
};
// Pontoons neither map has (or the municipal map draws as one outline with their gangway): [centre line, width, deck]
// (deck: 0 timber, 1 concrete)
const ORTHO_PONTOONS = [
  [[-154.6, -165.5, -131.3, -170.6], 2.3, 0], // the old port's north quay, below the Naval Museum (PANTALANA's outline)
  [[-162.0, -129.4, -146.8, -126.1], 3.2, 1], // inside the west mole's head (its gangway runs along its quay side)
  [[-89.6, -127.6, -66.9, -121.0], 2.9, 0], // the marina mole's head, north side (PANTALANA)
  [[-58.6, -117.4, -56.3, -126.3], 3.2, 1], // by the steps further along it (PANTALANA)
  [[-65.8, -152.8, -51.8, -150.2], 2.4, 0], // the north basin's mole head, south side
  [[-51.6, -165.9, -34.8, -164.7], 2.6, 0] // and its north side, inside the north basin
];
// Gangways the orthophoto shows that neither the ramps nor the steps give: [quay end x, z, pontoon end x, z]
const ORTHO_GANGWAYS = [
  [-50.4, -141.6, -52.2, -149.6] // down the north basin mole's west face to the pontoon on its south side
];
// The fishing quay below the Naval Museum, its face hung with timber strakes
const FISHING_QUAY = { minX: -146, maxX: -76, minZ: -188, maxZ: -164 };

// --- terrain (the 2 m core grid of build.mjs, as bake-shore.mjs) ---------------------------------------------------------

const terrain = await (async () => {
  const meta = GEO.terrain.core;
  const file = fs.readFileSync(path.join(ROOT, meta.url));
  const img = await decodePNG(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const { x0, z0, w, h, res } = meta;
  const heights = new Float32Array(w * h);
  for (let k = 0; k < heights.length; k++) heights[k] = ((img.data[3 * k] << 8) | img.data[3 * k + 1]) / 100 - GEO.terrain.heightOffset;
  const heightAt = (x, z) => {
    const fx = (x - x0) / res - 0.5, fz = (z - z0) / res - 0.5;
    let i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    i = Math.max(0, Math.min(w - 2, i));
    j = Math.max(0, Math.min(h - 2, j));
    const k = j * w + i;
    return (heights[k] * (1 - tx) + heights[k + 1] * tx) * (1 - tz) + (heights[k + w] * (1 - tx) + heights[k + w + 1] * tx) * tz;
  };
  return { heightAt };
})();

// --- geometry helpers ----------------------------------------------------------------------------------------------------

const r2 = (v) => Math.round(v * 100) / 100;
// distance from (px, pz) to the segment a-b, with the parameter of the nearest point
function segNear(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1e-12;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const x = ax + dx * t, z = az + dz * t;
  return { d: Math.hypot(px - x, pz - z), t, x, z };
}
// nearest point of a polyline [[x, z], ...]: { d, x, z, seg, t, s (m along) }
function lineNear(pts, px, pz) {
  let best = null, s = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1], len = Math.hypot(bx - ax, bz - az);
    const q = segNear(px, pz, ax, az, bx, bz);
    if (!best || q.d < best.d) best = { ...q, seg: k, s: s + q.t * len };
    s += len;
  }
  return best;
}
const lineLength = (pts) => pts.reduce((a, p, k) => (k ? a + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0);
// the point & direction at s m along a polyline
function lineAt(pts, s) {
  let k = 0;
  for (; k + 1 < pts.length; k++) {
    const len = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    if (s <= len || k + 2 === pts.length) {
      const f = len > 0 ? Math.max(0, Math.min(1, s / len)) : 0;
      return { x: pts[k][0] + (pts[k + 1][0] - pts[k][0]) * f, z: pts[k][1] + (pts[k + 1][1] - pts[k][1]) * f, ux: (pts[k + 1][0] - pts[k][0]) / (len || 1), uz: (pts[k + 1][1] - pts[k][1]) / (len || 1) };
    }
    s -= len;
  }
  return { x: pts[0][0], z: pts[0][1], ux: 1, uz: 0 };
}
// A walkway's deck as quads [aL, bL, bR, aR] (flat x, z), mitred at the bends; grow widens it (the cut-out masks)
function strip(pts, W, grow = 0) {
  const h = W / 2 + grow, n = pts.length;
  const dir = (k) => {
    const dx = pts[k + 1][0] - pts[k][0], dz = pts[k + 1][1] - pts[k][1], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  };
  // left offset (-uz, ux) at each vertex, mitred (capped at twice the half width)
  const off = pts.map((p, k) => {
    const a = dir(Math.max(0, k - 1)), b = dir(Math.min(n - 2, k));
    let nx = -(a[1] + b[1]), nz = a[0] + b[0];
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    const m = Math.min(2, 1 / Math.max(0.5, nx * -b[1] + nz * b[0]));
    return [p[0] + nx * h * m, p[1] + nz * h * m, p[0] - nx * h * m, p[1] - nz * h * m];
  });
  // grown masks also reach past the ends
  if (grow) {
    const a = dir(0), b = dir(n - 2);
    off[0] = [off[0][0] - a[0] * grow, off[0][1] - a[1] * grow, off[0][2] - a[0] * grow, off[0][3] - a[1] * grow];
    off[n - 1] = [off[n - 1][0] + b[0] * grow, off[n - 1][1] + b[1] * grow, off[n - 1][2] + b[0] * grow, off[n - 1][3] + b[1] * grow];
  }
  const quads = [];
  for (let k = 0; k + 1 < n; k++) quads.push([off[k][0], off[k][1], off[k + 1][0], off[k + 1][1], off[k + 1][2], off[k + 1][3], off[k][2], off[k][3]]);
  return quads;
}
// Rectangle from a centre line a-b and a width, as a quad
const rectQuad = (ax, az, bx, bz, W) => strip([[ax, az], [bx, bz]], W)[0];

// --- walkways ---------------------------------------------------------------------------------------------------------------

const places = loadLayer('osm_places.json').elements;
const byId = new Map(places.filter((e) => e.type === 'way').map((e) => [e.id, e]));
// { pts, W, role, deck (0 timber, 1 concrete), source }
const walkways = [];
for (const [role, ids] of Object.entries(OSM_PIERS)) {
  for (const id of ids) {
    const e = byId.get(id);
    if (!e?.geometry || e.tags?.man_made !== 'pier') throw new Error(`OSM pier ${id} is missing from the snapshot`);
    walkways.push({ pts: e.geometry.map((p) => lonLatToLocal(p.lon, p.lat)), W: WIDTH[role], role, deck: 0, source: `osm ${id}` });
  }
}
for (const [line, W, deck] of ORTHO_PONTOONS) walkways.push({ pts: [[line[0], line[1]], [line[2], line[3]]], W, role: 'pontoon', deck, source: 'ortho' });

// An end that lies on another walkway stops at its edge (a comb's walkway against the walkway along the quay)
for (const w of walkways) {
  for (const end of [0, w.pts.length - 1]) {
    const [x, z] = w.pts[end];
    let host = null;
    for (const o of walkways) {
      if (o === w) continue;
      const q = lineNear(o.pts, x, z);
      if (q.d < 0.8 && (!host || q.d < host.q.d)) host = { o, q };
    }
    if (!host) continue;
    const nb = w.pts[end === 0 ? 1 : w.pts.length - 2];
    const l = Math.hypot(nb[0] - x, nb[1] - z);
    const cut = host.o.W / 2 - 0.02 - host.q.d;
    if (l > cut + 0.5) w.pts[end] = [x + ((nb[0] - x) * cut) / l, z + ((nb[1] - z) * cut) / l];
    w[end === 0 ? 'joinA' : 'joinB'] = true;
  }
}
// OSM ends drawn onto the quay (the comb's walkway runs on to where its gangway lands): the deck stops where both corners
// of its end stand a quarter of a metre off the wall's face
const clearOfWall = (w, p) => [-1, 1].every((side) => {
  const q = nearestWall(walls, p.x - p.uz * side * w.W / 2, p.z + p.ux * side * w.W / 2, 6, wallsIndex);
  return !q || q.d > 0.25;
});
for (const w of walkways) {
  if (w.source === 'ortho') continue; // (drawn clear of the quays)
  for (const end of [0, 1]) {
    const pts = end ? w.pts.slice().reverse() : w.pts;
    if (clearOfWall(w, lineAt(pts, 0))) continue;
    const L = lineLength(pts);
    for (let s = 0.25; s < L - 1; s += 0.25) {
      const p = lineAt(pts, s);
      if (!clearOfWall(w, p)) continue;
      // cut the line at s
      let k = 0, acc = 0;
      while (k + 1 < pts.length && acc + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]) < s) {
        acc += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
        k++;
      }
      const cut = [[p.x, p.z], ...pts.slice(k + 1)];
      w[end ? 'quayB' : 'quayA'] = pts[0];
      w.pts = end ? cut.reverse() : cut;
      break;
    }
  }
}

// --- fingers & T-heads: the municipal pontoons less the walkways ------------------------------------------------------------

const pantalana = loadLayer('c500_PANTALANA.json').features.flatMap((f) => f.g).filter((r) => r.length >= 6 && inPort(r[0], r[1]));
const RAST = 0.1; // m
const pieces = []; // { quad, W, L, role: 'finger' | 'head' }
for (const ring of pantalana) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  // the outlines the ORTHO pontoons stand for are theirs
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  if (walkways.some((w) => w.source === 'ortho' && lineNear(w.pts, cx, cz).d < w.W)) continue;
  const x0 = minX - 1, z0 = minZ - 1, w = Math.ceil((maxX - minX + 2) / RAST), h = Math.ceil((maxZ - minZ + 2) / RAST);
  const m = new Uint8Array(w * h);
  scanRings([ring], x0, z0, RAST, w, h, (i, j) => { m[j * w + i] = 1; });
  for (const wk of walkways) {
    for (const quad of strip(wk.pts, wk.W, 0.15)) scanRings([quad], x0, z0, RAST, w, h, (i, j) => { m[j * w + i] = 0; });
  }
  // connected pieces left over
  const label = new Int32Array(w * h).fill(-1);
  for (let k0 = 0; k0 < w * h; k0++) {
    if (!m[k0] || label[k0] >= 0) continue;
    const cells = [k0];
    label[k0] = k0;
    for (let c = 0; c < cells.length; c++) {
      const k = cells[c], i = k % w;
      for (const n of [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w]) {
        if (n >= 0 && n < w * h && m[n] && label[n] < 0) { label[n] = k0; cells.push(n); }
      }
    }
    if (cells.length * RAST * RAST < 1.2) continue;
    // principal axis
    let sx = 0, sz = 0;
    const P = cells.map((k) => { const x = x0 + ((k % w) + 0.5) * RAST, z = z0 + (Math.floor(k / w) + 0.5) * RAST; sx += x; sz += z; return [x, z]; });
    const mx = sx / P.length, mz = sz / P.length;
    let cxx = 0, cxz = 0, czz = 0;
    for (const [x, z] of P) { cxx += (x - mx) ** 2; cxz += (x - mx) * (z - mz); czz += (z - mz) ** 2; }
    const th = 0.5 * Math.atan2(2 * cxz, cxx - czz), ux = Math.cos(th), uz = Math.sin(th);
    const S = P.map(([x, z]) => (x - mx) * ux + (z - mz) * uz).sort((a, b) => a - b);
    const T = P.map(([x, z]) => -(x - mx) * uz + (z - mz) * ux).sort((a, b) => a - b);
    const pct = (A, f) => A[Math.min(A.length - 1, Math.max(0, Math.round(f * (A.length - 1))))];
    const s0 = pct(S, 0.01), s1 = pct(S, 0.99), t0 = pct(T, 0.03), t1 = pct(T, 0.97);
    const L = s1 - s0 + RAST, Wd = t1 - t0 + RAST;
    if (L < 1.8 || Wd < 0.3 || L / Wd < 2.2) continue;
    // square to the walkway it hangs from (slivers along a walkway's edge are the two maps disagreeing)
    const cs = (s0 + s1) / 2, ct = (t0 + t1) / 2, pcx = mx + cs * ux - ct * uz, pcz = mz + cs * uz + ct * ux;
    let host = null;
    for (const wk of walkways) {
      const q = lineNear(wk.pts, pcx, pcz);
      if (!host || q.d - wk.W / 2 < host.gap) host = { wk, q, gap: q.d - wk.W / 2 };
    }
    const hd = lineAt(host.wk.pts, host.q.s);
    if (Math.abs(ux * hd.ux + uz * hd.uz) > 0.82) continue;
    // run the root end on to the walkway's edge
    let ax = pcx - ux * (L / 2), az = pcz - uz * (L / 2), bx = pcx + ux * (L / 2), bz = pcz + uz * (L / 2);
    const gapA = lineNear(host.wk.pts, ax, az).d - host.wk.W / 2, gapB = lineNear(host.wk.pts, bx, bz).d - host.wk.W / 2;
    if (Math.min(gapA, gapB) > 1.2) continue; // hangs from nothing
    if (gapA < gapB) { ax -= ux * (gapA + 0.02); az -= uz * (gapA + 0.02); } else { bx += ux * (gapB + 0.02); bz += uz * (gapB + 0.02); }
    if (gapA >= gapB) [ax, az, bx, bz] = [bx, bz, ax, az]; // a: the root
    const width = Math.min(1.4, Math.max(0.5, Wd));
    // a T-head: across the free end of a comb's walkway
    const hostEnd = host.wk.pts[host.wk.joinB ? 0 : host.wk.pts.length - 1];
    const role = host.wk.role === 'tooth' && Math.hypot(pcx - hostEnd[0], pcz - hostEnd[1]) < 5 ? 'head' : 'finger';
    pieces.push({ ax, az, bx, bz, W: width, role, host: host.wk });
  }
}
// The north basin's comb: its fingers are OSM lines (above), drawn from the walkway's centre: they start at its edge
for (const w of walkways) if (w.role === 'combFinger') w.finger = true;

// --- decks ----------------------------------------------------------------------------------------------------------------

// [corners (8: aL, bL, bR, aR), kind]: kind 0 walkway, 1 finger or T-head; deck 0 timber, 1 concrete
const decks = [];
for (const w of walkways) {
  for (const q of strip(w.pts, w.W)) decks.push({ q, kind: w.finger ? 1 : 0, deck: w.deck, w });
}
for (const p of pieces) decks.push({ q: rectQuad(p.ax, p.az, p.bx, p.bz, p.W), kind: 1, deck: 0, w: p });

// the deck under (x, z), with a margin
const quadHas = (q, x, z, m = 0) => {
  // convex quad: inside every edge (either winding)
  let pos = 0, neg = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[2 * k], az = q[2 * k + 1], bx = q[(2 * k + 2) % 8], bz = q[(2 * k + 3) % 8];
    const l = Math.hypot(bx - ax, bz - az) || 1;
    const c = ((bx - ax) * (z - az) - (bz - az) * (x - ax)) / l;
    if (c > -m) pos++;
    if (c < m) neg++;
  }
  return pos === 4 || neg === 4;
};
const onDeck = (x, z, m = 0) => decks.some((d) => quadHas(d.q, x, z, m));
const nearDeck = (x, z, r, own = null) => decks.some((d) => {
  if (d.w === own) return false;
  for (let k = 0; k < 4; k++) if (segNear(x, z, d.q[2 * k], d.q[2 * k + 1], d.q[(2 * k + 2) % 8], d.q[(2 * k + 3) % 8]).d < r) return true;
  return quadHas(d.q, x, z);
});

// --- piles, hoops, cleats, pedestals, lamps ------------------------------------------------------------------------------

const piles = [], cleats = [], pedestals = [], lamps = [];
const PILE_R = 0.25, PILE_STEP = 14, PILE_TOP = 3.8;
const yawOf = (ux, uz) => Math.atan2(ux, uz); // rotation about y taking +z to (ux, uz)
const wallSide = (x, z, r) => { const q = nearestWall(walls, x, z, r, wallsIndex); return q ? q.d : Infinity; };
const BERTHS = new Set(['tooth', 'finger', 'spur', 'comb', 'quay', 'landing', 'pontoon', 'spine']);
for (const w of walkways) {
  if (w.finger) continue;
  const L = lineLength(w.pts);
  if (L < 3) continue;
  // piles at both ends and evenly between, alternately either side, clear of the other decks
  const n = Math.max(2, Math.ceil((L - 2) / PILE_STEP) + 1);
  for (let i = 0; i < n; i++) {
    const s = 1 + ((L - 2) * i) / (n - 1);
    const p = lineAt(w.pts, s);
    for (const side of i % 2 ? [1, -1] : [-1, 1]) {
      const off = w.W / 2 + PILE_R + 0.12;
      const x = p.x - p.uz * off * side, z = p.z + p.ux * off * side;
      if (onDeck(x, z, PILE_R + 0.1) || nearDeck(x, z, PILE_R + 0.15, w) || wallSide(x, z, 3) < 0.8) continue;
      const bed = terrain.heightAt(x, z);
      piles.push({ x, z, top: PILE_TOP, bottom: Math.min(bed, -0.3) - 1.5, ux: p.uz * side, uz: -p.ux * side });
      break;
    }
  }
  // cleats along the berths on the edges that face open water, every 3 m
  if (BERTHS.has(w.role)) {
    for (let s = 1.5; s < L - 0.8; s += 3) {
      const p = lineAt(w.pts, s);
      for (const side of [-1, 1]) {
        const off = w.W / 2 - 0.12;
        const x = p.x - p.uz * off * side, z = p.z + p.ux * off * side;
        const ox = x - p.uz * 0.9 * side, oz = z + p.ux * 0.9 * side; // the water beyond the edge
        if (onDeck(ox, oz) || wallSide(ox, oz, 2) < 1.2 || piles.some((q) => Math.hypot(q.x - x, q.z - z) < 0.9)) continue;
        cleats.push({ x, z, yaw: yawOf(p.ux, p.uz) });
      }
    }
  }
  // service pedestals (water & power) every 11 m, alternately either side, on the walkways with berths
  if (BERTHS.has(w.role) && w.role !== 'spine' && L > 6) {
    let i = 0;
    for (let s = 3; s < L - 2; s += 11, i++) {
      const p = lineAt(w.pts, s), side = i % 2 ? 1 : -1;
      const off = w.W / 2 - 0.3;
      const x = p.x - p.uz * off * side, z = p.z + p.ux * off * side;
      if (piles.some((q) => Math.hypot(q.x - x, q.z - z) < 1.2) || cleats.some((q) => Math.hypot(q.x - x, q.z - z) < 0.4)) continue;
      pedestals.push({ x, z, yaw: yawOf(-p.uz * side, p.ux * side) });
    }
  }
  // lamp posts: at the free end of the combs' walkways, and every 30 m along the walkways by the quays
  const lamp = (s, side) => {
    const p = lineAt(w.pts, s), off = w.W / 2 - 0.2;
    lamps.push({ x: p.x - p.uz * off * side, z: p.z + p.ux * off * side });
  };
  if (['tooth', 'finger', 'comb'].includes(w.role) && L > 8) {
    if (!w.joinB) lamp(L - 0.6, 1);
    else if (!w.joinA) lamp(0.6, 1);
  }
  if (w.role === 'spine') for (let s = 15; s < L - 5; s += 30) lamp(s, wallSide(lineAt(w.pts, s).x, lineAt(w.pts, s).z, 4) < 4 ? 1 : -1);
}
// the fingers' cleats: by the root and at the tip, either side
for (const p of pieces.concat(walkways.filter((w) => w.finger).map((w) => ({ ax: w.pts[0][0], az: w.pts[0][1], bx: w.pts[w.pts.length - 1][0], bz: w.pts[w.pts.length - 1][1], W: w.W })))) {
  const L = Math.hypot(p.bx - p.ax, p.bz - p.az), ux = (p.bx - p.ax) / L, uz = (p.bz - p.az) / L;
  for (const s of [0.6, L - 0.35]) {
    for (const side of [-1, 1]) {
      const off = p.W / 2 - 0.1;
      cleats.push({ x: p.ax + ux * s - uz * off * side, z: p.az + uz * s + ux * off * side, yaw: yawOf(ux, uz) });
    }
  }
}
// lamps clear of the piles & pedestals
for (let i = lamps.length - 1; i >= 0; i--) {
  const l = lamps[i];
  if (piles.some((q) => Math.hypot(q.x - l.x, q.z - l.z) < 0.9) || pedestals.some((q) => Math.hypot(q.x - l.x, q.z - l.z) < 0.8)) lamps.splice(i, 1);
}
for (let i = cleats.length - 1; i >= 0; i--) {
  const c = cleats[i];
  if (lamps.some((q) => Math.hypot(q.x - c.x, q.z - c.z) < 0.5)) cleats.splice(i, 1);
}

// --- gangways ----------------------------------------------------------------------------------------------------------------

// A gangway: hinged on the quay at (hx, hy, hz), its foot rolling on a pontoon's walkway; its length gives a slope of
// about 1 in 3 at mean sea level. { hx, hz, hy, fx, fz, L, W }
const gangways = [];
const SLOPE = 3.2;
const deckWalkway = (x, z) => {
  let best = null;
  for (const w of walkways) {
    if (w.finger) continue;
    const q = lineNear(w.pts, x, z);
    if (!best || q.d - w.W / 2 < best.gap) best = { w, q, gap: q.d - w.W / 2 };
  }
  return best;
};
// the foot: on the walkway's centre line, as far from the hinge as the gangway's length needs, away from the walkway's
// nearer end
function gangwayTo(hx, hz, hy, hint = null) {
  // the walkway by the hinge, or by the hint (the pontoon end of a ramp)
  let host = deckWalkway(...(hint || [hx, hz]));
  if (host && hint) host = { ...host, q: lineNear(host.w.pts, hx, hz) };
  if (!host || (!hint && host.gap > 4)) return null;
  const drop = hy - FREEBOARD;
  const L = Math.min(14, Math.max(3.5, drop * SLOPE));
  const run = Math.sqrt(Math.max(0.5, L * L - drop * drop));
  const len = lineLength(host.w.pts);
  const dirs = hint ? [Math.sign(lineNear(host.w.pts, hint[0], hint[1]).s - host.q.s) || 1] : host.q.s < len / 2 ? [1, -1] : [-1, 1];
  for (const dir of dirs) {
    for (let s = Math.min(len - 0.3, Math.max(0.3, host.q.s)); s >= 0.3 && s <= len - 0.3; s += dir * 0.1) {
      const p = lineAt(host.w.pts, s);
      if (Math.hypot(p.x - hx, p.z - hz) >= run) return { hx, hz, hy, fx: p.x, fz: p.z, L, W: 1.2, walkway: host.w };
    }
  }
  return null;
}
const keep = (g) => {
  if (!g || gangways.some((o) => Math.hypot(o.hx - g.hx, o.hz - g.hz) < (o.walkway === g.walkway ? 20 : 12))) return;
  gangways.push(g);
};
// the municipal map's ramps that end by a pontoon: the gangway along its long axis, hinged at its quay end
for (const f of loadLayer('c500_ARRAPALA.json').features) {
  for (const r of f.g) {
    if (r.length < 8 || !inPort(r[0], r[1])) continue;
    // the two ends of the long axis: the mean of the vertices beyond each end's quarter
    const pts = [];
    for (let k = 0; k < r.length; k += 2) pts.push([r[k], r[k + 1]]);
    let far = [0, 1], fd = 0;
    for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) {
      const d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
      if (d > fd) { fd = d; far = [a, b]; }
    }
    const A = pts[far[0]], B = pts[far[1]], ux = (B[0] - A[0]) / fd, uz = (B[1] - A[1]) / fd;
    const end = (sgn) => {
      const sel = pts.filter((p) => sgn * ((p[0] - A[0]) * ux + (p[1] - A[1]) * uz - fd / 2) > fd / 4);
      return [sel.reduce((a, p) => a + p[0], 0) / sel.length, sel.reduce((a, p) => a + p[1], 0) / sel.length];
    };
    const [e0, e1] = [end(-1), end(1)];
    const near0 = deckWalkway(...e0), near1 = deckWalkway(...e1);
    if (Math.min(near0?.gap ?? 9, near1?.gap ?? 9) > 2.5) continue;
    // the quay end: the one whose continuation along the ramp's axis runs up onto the quay
    const rise0 = terrain.heightAt(e0[0] - ux * 1.5, e0[1] - uz * 1.5), rise1 = terrain.heightAt(e1[0] + ux * 1.5, e1[1] + uz * 1.5);
    const [quayEnd, padEnd] = rise0 > rise1 ? [e0, e1] : [e1, e0];
    const q = nearestWall(walls, quayEnd[0], quayEnd[1], 6, wallsIndex);
    const hy = q ? q.deck : terrain.heightAt(...quayEnd);
    keep(gangwayTo(quayEnd[0], quayEnd[1], hy, padEnd));
  }
}
for (const [hx, hz, fx, fz] of ORTHO_GANGWAYS) {
  const q = nearestWall(walls, hx, hz, 6, wallsIndex);
  keep(gangwayTo(hx, hz, q ? q.deck : terrain.heightAt(hx, hz), [fx, fz]));
}
// OSM walkways drawn onto the quay: the gangway lands where the line meets the wall
for (const w of walkways.filter((o) => o.source !== 'ortho')) {
  for (const key of ['quayA', 'quayB']) {
    if (!w[key]) continue;
    const q = nearestWall(walls, w[key][0], w[key][1], 6, wallsIndex);
    if (q) keep(gangwayTo(q.x - q.nx * 0.3, q.z - q.nz * 0.3, q.deck));
  }
}
// quay steps that end by a pontoon: the gangway carries on from the bottom step
for (const st of stairs) {
  if (!inPort(st.p[0], st.p[1])) continue;
  let cx = 0, cz = 0, s1 = -Infinity;
  const n = st.p.length / 2;
  for (let k = 0; k < st.p.length; k += 2) { cx += st.p[k]; cz += st.p[k + 1]; s1 = Math.max(s1, st.p[k] * st.ux + st.p[k + 1] * st.uz); }
  cx /= n; cz /= n;
  const s = cx * st.ux + cz * st.uz;
  // the middle of the bottom step's edge
  const bx = cx + st.ux * (s1 - s), bz = cz + st.uz * (s1 - s);
  const host = deckWalkway(bx, bz);
  if (!host || host.gap > 3.5 || st.bot - FREEBOARD < 0.6) continue;
  keep(gangwayTo(bx, bz, st.bot));
}

// --- quays: bollards, rings, ladders, strakes ------------------------------------------------------------------------------------

const inHarbour = (x, z) => pointInRing(x, z, HARBOUR);
const bollards = [], rings = [], ladders = [], strakes = [];
const BOLLARD_STEP = 12, LADDER_STEP = 36;
const nearStairs = (x, z, r) => stairs.some((st) => {
  for (let k = 0; k < st.p.length; k += 2) {
    const j = (k + 2) % st.p.length;
    if (segNear(x, z, st.p[k], st.p[k + 1], st.p[j], st.p[j + 1]).d < r) return true;
  }
  return false;
});
const nearGangway = (x, z, r) => gangways.some((g) => segNear(x, z, g.hx, g.hz, g.fx, g.fz).d < r);
walls.forEach((wall) => {
  const p = wall.p, nv = p.length / 4;
  if (!inPort(p[0], p[1])) return;
  let along = 0;
  for (let k = 0; k + 1 < nv; k++) {
    const ax = p[4 * k], az = p[4 * k + 1], bx = p[4 * k + 4], bz = p[4 * k + 5];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 1e-3) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len, nx = -uz, nz = ux; // n: towards the water
    for (let s = Math.ceil(along / 3) * 3 - along; s < len; s += 3) {
      const at = along + s, f = s / len;
      const x = ax + ux * s, z = az + uz * s;
      const deck = p[4 * k + 2] + (p[4 * k + 6] - p[4 * k + 2]) * f, foot = p[4 * k + 3] + (p[4 * k + 7] - p[4 * k + 3]) * f;
      // the harbour's water in front, no pontoon alongside, no steps or gangway here
      if (!inHarbour(x + nx * 4, z + nz * 4) || deck - foot < 2 || terrain.heightAt(x + nx * 3, z + nz * 3) > 0.5 || nearDeck(x + nx * 2.5, z + nz * 2.5, 2) || nearStairs(x, z, 2) || nearGangway(x, z, 2.5)) continue;
      const yaw = yawOf(nx, nz);
      const slot = Math.round(at / 3);
      if (slot % (BOLLARD_STEP / 3) === 0) bollards.push({ x: x - nx * 0.55, y: deck, z: z - nz * 0.55, yaw });
      else if (slot % (BOLLARD_STEP / 3) === 2 && x < -60) rings.push({ x: x + nx * 0.02, y: deck - 0.45, z: z + nz * 0.02, yaw });
      if (slot % (LADDER_STEP / 3) === 6) ladders.push({ x, z, yaw, top: deck, bottom: Math.min(foot, 0) - 1.2 });
      if (x > FISHING_QUAY.minX && x < FISHING_QUAY.maxX && z > FISHING_QUAY.minZ && z < FISHING_QUAY.maxZ && slot % (LADDER_STEP / 3) !== 6) {
        strakes.push({ x, z, yaw, top: deck - 0.12, bottom: Math.min(foot, 0) - 0.8 });
      }
    }
    along += len;
  }
});

// --- the slipway: the notch the municipal quays leave at the foot of Kaiarriba, cut off in the water ------------------------

// Its concrete: a smooth surface (a quadric, the ramp a little steeper towards its toe) fitted to the LiDAR inside it, 3 m
// clear of its edges (where the 2 m terrain smears the walls either side into banks) and above the basin's bed, once more
// without the samples far off the first fit (cars, boats on their trolleys), then lifted so the terrain stays under it; y = c0 + c1 x' + c2 z' + c3 x'^2 + c4 x' z' + c5 z'^2 with x', z' from its middle
const slipway = (() => {
  const ring = slipwayRing(loadLayer);
  if (!ring) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
    minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  const ox = r2((minX + maxX) / 2), oz = r2((minZ + maxZ) / 2);
  const S = [];
  for (let z = Math.ceil(minZ); z <= maxZ; z++) for (let x = Math.ceil(minX); x <= maxX; x++) {
    if (!pointInRing(x, z, ring)) continue;
    let edge = Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      const j = (k + 2) % ring.length;
      edge = Math.min(edge, segNear(x, z, ring[k], ring[k + 1], ring[j], ring[j + 1]).d);
    }
    const y = terrain.heightAt(x, z);
    if (edge >= 3 && y > 0) S.push([x - ox, z - oz, y]);
  }
  // least squares through the normal equations (6 x 6, Gaussian elimination)
  const basis = (x, z) => [1, x, z, x * x, x * z, z * z];
  const solve = (pts) => {
    const A = Array.from({ length: 6 }, () => new Float64Array(7));
    for (const [x, z, y] of pts) {
      const b = basis(x, z);
      for (let i = 0; i < 6; i++) { for (let j = 0; j < 6; j++) A[i][j] += b[i] * b[j]; A[i][6] += b[i] * y; }
    }
    for (let i = 0; i < 6; i++) {
      let piv = i;
      for (let r = i + 1; r < 6; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r;
      [A[i], A[piv]] = [A[piv], A[i]];
      for (let r = 0; r < 6; r++) {
        if (r === i) continue;
        const f = A[r][i] / A[i][i];
        for (let c = i; c < 7; c++) A[r][c] -= f * A[i][c];
      }
    }
    return A.map((row, i) => row[6] / row[i]);
  };
  let coef = solve(S);
  const off = (c, [x, z, y]) => y - basis(x, z).reduce((a, b, i) => a + b * c[i], 0);
  const rms0 = Math.sqrt(S.reduce((a, p) => a + off(coef, p) ** 2, 0) / S.length);
  coef = solve(S.filter((p) => Math.abs(off(coef, p)) < 2 * rms0));
  const fit = (x, z) => basis(x, z).reduce((a, b, i) => a + b * coef[i], 0);
  const res = S.map(([x, z, y]) => y - fit(x, z)).sort((a, b) => a - b);
  const rms = Math.sqrt(res.reduce((a, v) => a + v * v, 0) / res.length);
  // the lift: the terrain stays under the slab but for the odd bump (95th percentile of the residuals)
  const lift = Math.max(0.04, res[Math.floor(res.length * 0.95)] + 0.03);
  coef[0] += lift;
  log(`slipway: ${S.length} m² of LiDAR, ${(rms * 100).toFixed(0)} cm rms off the fitted surface, lifted ${(lift * 100).toFixed(0)} cm`);
  return { ring, origin: [ox, oz], surface: coef.map((c) => Math.round(c * 1e6) / 1e6) };
})();

// --- the floating level ----------------------------------------------------------------------------------------------------

// Pontoons ride the tide down to the bed: at low water they sit on their floats on the bottom (the median bed under them).
// The bed build.mjs lays in the basins (no isobaths there) lies only 0.3 m under mean sea level, too shallow for the
// floats: they settle no higher than mean sea level, so with the tide off they float as built
const beds = decks.map((d) => terrain.heightAt((d.q[0] + d.q[4]) / 2, (d.q[1] + d.q[5]) / 2)).sort((a, b) => a - b);
const ground = Math.min(0, r2(beds[beds.length >> 1] + DRAFT + 0.05));

log(`marina: ${walkways.length} walkways (${walkways.filter((w) => w.source === 'ortho').length} from the orthophoto), ${pieces.filter((p) => p.role === 'finger').length + walkways.filter((w) => w.finger).length} fingers, ${pieces.filter((p) => p.role === 'head').length} T-heads, ${decks.length} deck pieces; ${piles.length} piles, ${gangways.length} gangways, ${cleats.length} cleats, ${pedestals.length} pedestals, ${lamps.length} lamps; quays: ${bollards.length} bollards, ${rings.length} rings, ${ladders.length} ladders, ${strakes.length} strakes; slipway ${slipway ? slipway.ring.length / 2 : 0} vertices; grounding at ${ground} m`);

// --- output ------------------------------------------------------------------------------------------------------------------

const deg = (a) => Math.round((((a * 180) / Math.PI) % 360 + 360) % 360);
const DATA_OUT = {
  // m: the decks' freeboard & the floats' draft; the level the pontoons settle at on the bottom
  level: { freeboard: FREEBOARD, draft: DRAFT, ground },
  // per deck piece: 4 corners x, z (the first two along its walkway's direction, then back on the other side), kind (0
  // walkway, 1 finger or T-head), deck (0 timber, 1 concrete)
  decks: decks.flatMap((d) => [...d.q.map(r2), d.kind, d.deck]),
  // x, z, top, bottom, yaw (deg, towards the pontoon)
  piles: piles.flatMap((p) => [r2(p.x), r2(p.z), p.top, r2(p.bottom), deg(yawOf(p.ux, p.uz))]),
  // hinge x, z, y (on the quay), foot x, z (on the walkway at mean sea level), length, width
  gangways: gangways.flatMap((g) => [r2(g.hx), r2(g.hz), r2(g.hy), r2(g.fx), r2(g.fz), r2(g.L), g.W]),
  // x, z, yaw (deg)
  cleats: cleats.flatMap((c) => [r2(c.x), r2(c.z), deg(c.yaw)]),
  pedestals: pedestals.flatMap((c) => [r2(c.x), r2(c.z), deg(c.yaw)]),
  lamps: lamps.flatMap((c) => [r2(c.x), r2(c.z)]),
  // x, y, z, yaw (deg, facing the water)
  bollards: bollards.flatMap((b) => [r2(b.x), r2(b.y), r2(b.z), deg(b.yaw)]),
  rings: rings.flatMap((b) => [r2(b.x), r2(b.y), r2(b.z), deg(b.yaw)]),
  // x, z (on the wall's face), yaw (deg, facing the water), top, bottom
  ladders: ladders.flatMap((l) => [r2(l.x), r2(l.z), deg(l.yaw), r2(l.top), r2(l.bottom)]),
  strakes: strakes.flatMap((l) => [r2(l.x), r2(l.z), deg(l.yaw), r2(l.top), r2(l.bottom)]),
  // the slipway's outline (x, z), and its surface y = c0 + c1 x' + c2 z' + c3 x'^2 + c4 x' z' + c5 z'^2 (x', z' from
  // origin)
  slipway,
  // the harbour's water (x, z ring) and its mouth (x, z, width)
  harbour: { ring: HARBOUR, mouth: MOUTH }
};
const js = '// js/donostia/data-marina.js — generated by tools/donostia/bake-marina.mjs; do not edit.\n' +
  '// © OpenStreetMap contributors (ODbL) · Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal ' +
  '1:500 (CC BY-SA 3.0) · Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi (CC BY 4.0): the LiDAR terrain and the 2025 ' +
  'orthophoto («Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi»)\n' +
  licenceComment('osm', 'c500', 'geoeuskadi') +
  `export const MARINA = ${JSON.stringify(DATA_OUT)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${(js.length / 1e3).toFixed(1)} kB`);

// --preview <dir>: the port from above, the decks, piles, gangways and the quays' fittings
if (PREVIEW) {
  fs.mkdirSync(PREVIEW, { recursive: true });
  const vx0 = -300, vz0 = -260, vx1 = 160, vz1 = -40, mpp = 0.2;
  const w = Math.round((vx1 - vx0) / mpp), h = Math.round((vz1 - vz0) / mpp), px = new Uint8Array(w * h * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const y = terrain.heightAt(vx0 + (i + 0.5) * mpp, vz0 + (j + 0.5) * mpp);
    px.set(y < 0.05 ? [40, 70, 110] : [90 + Math.min(120, y * 12), 90 + Math.min(120, y * 12), 80], 3 * (j * w + i));
  }
  const paint = (rings, col) => scanRings(rings, vx0, vz0, mpp, w, h, (i, j) => px.set(col, 3 * (j * w + i)));
  const dot = (x, z, r, col) => paint([[x - r, z - r, x + r, z - r, x + r, z + r, x - r, z + r]], col);
  if (slipway) paint([slipway.ring], [150, 150, 140]);
  for (const d of decks) paint([d.q], d.kind ? [230, 190, 120] : d.deck ? [200, 200, 200] : [200, 140, 70]);
  for (const g of gangways) paint([rectQuad(g.hx, g.hz, g.fx, g.fz, g.W)], [255, 255, 255]);
  for (const p of piles) dot(p.x, p.z, 0.3, [255, 255, 255]);
  for (const b of bollards) dot(b.x, b.z, 0.3, [255, 60, 60]);
  for (const b of ladders) dot(b.x, b.z, 0.3, [60, 255, 60]);
  for (const b of strakes) dot(b.x, b.z, 0.15, [140, 90, 40]);
  for (const b of pedestals) dot(b.x, b.z, 0.2, [60, 120, 255]);
  fs.writeFileSync(path.join(PREVIEW, 'marina.png'), encodePNG(px, w, h, 3));
  log(`previews in ${PREVIEW}`);
}
