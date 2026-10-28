// tools/donostia/bake-boats.mjs
// usage: node tools/donostia/bake-boats.mjs [--preview <dir>]
// The port's moored boats for js/donostia/boats.js -> js/donostia/data-boats.js, from the committed
// tools/donostia/data/port_boats.json (digitise-boats.mjs, on geoEuskadi's 2025 orthophoto):
// - Every hull is kept clear of what the port is built of: the municipal map's pontoons, quays, docks & moles
//   (PANTALANA, KAIA, NASA, DIKEA) and OSM's piers (the north basin's floating pontoon, the ferry landing, and the inner
//   basin's walkways where the municipal map leaves them out), and the marina's decks as bake-marina.mjs built them
//   (js/donostia/data-marina.js, so that bake runs first). A hull that touches
//   one slides off it by the least distance (up to 1.5 m), or is trimmed a little; hulls that overlap each other are
//   eased apart.
// - The photo's blur widens every hull by about a pixel each side: lengths & beams lose 15 cm.
// - Classes, the model & paints each boat gets, from where it lies and how big it is (the shape the digitiser read from
//   above, its family, says which boats have a mast, a cabin or tubes): the rows of small boats, wherever the boats
//   within 9 m are mostly under 5.4 m long (the inner basin's west half, its east side, the north basin's south row),
//   are the local txipironeras, the small wooden boats the port's people fish squid from (a cabin seen from above: a
//   small wheelhouse); the big white motor boats, sailboats & dinghies of the marina keep theirs; the passenger boats
//   moored alongside OSM's ferry pier are the two island ferries.
// - Paints, per boat a hull, a deck & an accent colour: hulls a gelcoat white unless the photo shows them painted
//   (painted open & motor boats; a third of the motor launches under 7 m dark blue, red, green or black), decks as
//   photographed (an open boat's: its inside), the accent (a sailboat's sail cover, a motor boat's canopy, a RIB's
//   tubes) as photographed or the usual navy & canvas. The txipironeras & the fishing boats are painted as the port's
//   are (Commons photos, raw/refs/boats): a hull in one of their paints and a gunwale stripe in a contrasting one, a
//   white, grey or pale inside, picked per boat from a hash of its position (the photo's paint where it shows one).
//   The photo's colours come lifted out of its haze.
// - Options, per boat: an open boat's console & outboard, a motor boat's canopy (where the photo shows its colour), a
//   txipironera's wheelhouse or outboard.
// - The island ferries (the Motoras de la Isla: osm_ferry.json's route=ferry "Donostia - Santa Clara"): their berths in
//   the north basin, the island's landing (where the route ends, the bow just off the jetty the terrain has), and per
//   ferry a lane each way: out of the berth astern to where it can turn, then OSM's route, smoothed, kept to starboard
//   of it in the bay (the ferries pass port to port) and to it in the harbour and at the island, with a speed limit
//   per point (harbour, bay); bent round any moored boat it would brush, and checked clear of the quays, pontoons,
//   moored boats and land.
// Deterministic: no randomness, a fixed order.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, DATA, loadLayer, lonLatToLocal, pointInRing, scanRings, encodePNG, previewDir, licenceComment, log } from './lib.mjs';
import { decodePNG } from '../../js/donostia/png.js';

const ROOT = path.resolve(HERE, '../..');
// the pontoons' decks as bake-marina.mjs (run before this bake) builds them: the walkways on OSM's centre lines at the
// widths measured on the orthophoto, which the outlines below only approximate
const { MARINA } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/data-marina.js')).href);
const { GEO } = await import(pathToFileURL(path.join(ROOT, 'js/donostia/geodata.js')).href);
const OUT = path.join(ROOT, 'js/donostia/data-boats.js');
const PREVIEW = previewDir();
const SRC = JSON.parse(fs.readFileSync(path.join(DATA, 'port_boats.json'), 'utf8'));
// the classes boats.js draws (ferries apart: js/donostia/ferries.js)
const CLASSES = ['sail', 'motor', 'open', 'txipironera', 'rib', 'passenger', 'fishing'];
const BLUR = 0.15; // m
const CLEAR = 0.12; // m kept between a hull and a pontoon or quay
const MAX_SLIDE = 1.5; // m

// --- what the port is built of -------------------------------------------------------------------------------------------

// polygons (flat rings) and bands ([ax, az, bx, bz, half-width])
const polys = [];
for (const name of ['c500_PANTALANA.json', 'c500_KAIA.json', 'c500_NASA.json', 'c500_DIKEA.json']) {
  for (const f of loadLayer(name).features) {
    const r = f.g[0];
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < r.length; k += 2) {
      minX = Math.min(minX, r[k]); maxX = Math.max(maxX, r[k]);
      minZ = Math.min(minZ, r[k + 1]); maxZ = Math.max(maxZ, r[k + 1]);
    }
    if (maxX < -400 || minX > 200 || maxZ < -320 || minZ > 0) continue; // the port only
    polys.push({ rings: f.g, minX, maxX, minZ, maxZ });
  }
}
const segDist = (x, z, ax, az, bx, bz) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, z - az - t * dz);
};
const inPoly = (x, z, m = 0) => polys.some((p) => {
  if (x < p.minX - m || x > p.maxX + m || z < p.minZ - m || z > p.maxZ + m) return false;
  let inside = false;
  for (const r of p.rings) if (pointInRing(x, z, r)) inside = !inside;
  if (inside || !m) return inside;
  for (const r of p.rings) {
    for (let k = 0; k < r.length; k += 2) {
      const j = (k + 2) % r.length;
      if (segDist(x, z, r[k], r[k + 1], r[j], r[j + 1]) < m) return true;
    }
  }
  return false;
});
const bands = [];
for (const e of loadLayer('osm_places.json').elements) {
  const t = e.tags || {};
  if (t.man_made !== 'pier' || !e.geometry) continue;
  const pts = e.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
  if (pts.every(([x, z]) => x < -400 || x > 200 || z < -320 || z > 0)) continue;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[k + 1];
    if (t.floating === 'yes' || t.ferry === 'yes') {
      bands.push([ax, az, bx, bz, t.ferry === 'yes' ? 1.5 : pts.length > 2 ? 0.9 : 0.35]);
      continue;
    }
    // an inner-basin walkway: only where it runs off the municipal outlines (as digitise-boats.mjs masks it)
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    let run = null;
    for (let q = 0; q <= n; q++) {
      const x = ax + ((bx - ax) * q) / n, z = az + ((bz - az) * q) / n, inside = inPoly(x, z, 0.6);
      if (!inside && !run) run = [x, z, x, z];
      else if (!inside) { run[2] = x; run[3] = z; }
      if ((inside || q === n) && run) {
        if (run[0] !== run[2] || run[1] !== run[3]) bands.push([...run, 0.7]);
        run = null;
      }
    }
  }
}
// rasterised at 10 cm over the port, CLEAR wider (one cell), for the many tests below
const G = { x0: -190, z0: -260, res: 0.1, w: 3300, h: 2200 };
const grid = (() => {
  const g = new Uint8Array(G.w * G.h);
  const mark = (i, j) => { g[j * G.w + i] = 1; };
  for (const p of polys) scanRings(p.rings, G.x0, G.z0, G.res, G.w, G.h, mark);
  for (const [ax, az, bx, bz, hw] of bands) {
    const l = Math.hypot(bx - ax, bz - az) || 1, nx = (-(bz - az) / l) * hw, nz = ((bx - ax) / l) * hw;
    scanRings([[ax + nx, az + nz, bx + nx, bz + nz, bx - nx, bz - nz, ax - nx, az - nz]], G.x0, G.z0, G.res, G.w, G.h, mark);
  }
  // the marina's decks (per piece: four corners x, z, then its kind and finish)
  for (let k = 0; k < MARINA.decks.length; k += 10) scanRings([MARINA.decks.slice(k, k + 8)], G.x0, G.z0, G.res, G.w, G.h, mark);
  const out = g.slice();
  for (let j = 1; j < G.h - 1; j++) {
    for (let i = 1; i < G.w - 1; i++) {
      const k = j * G.w + i;
      if (!g[k] && (g[k - 1] || g[k + 1] || g[k - G.w] || g[k + G.w])) out[k] = 1;
    }
  }
  return out;
})();
const blocked = (x, z) => {
  const i = Math.floor((x - G.x0) / G.res), j = Math.floor((z - G.z0) / G.res);
  if (i < 0 || j < 0 || i >= G.w || j >= G.h) return inPoly(x, z, CLEAR);
  return grid[j * G.w + i] === 1;
};

// --- hulls -------------------------------------------------------------------------------------------------------------

// A hull's outline from above (local: u across, v along, bow at +v), as fractions of its beam & length
const OUTLINE = [[0, 0.5], [0.22, 0.42], [0.42, 0.25], [0.5, 0.05], [0.48, -0.3], [0.45, -0.5],
  [-0.45, -0.5], [-0.48, -0.3], [-0.5, 0.05], [-0.42, 0.25], [-0.22, 0.42]];
function outline(b, dx = 0, dz = 0, shape = OUTLINE) {
  const h = (b.heading * Math.PI) / 180, fx = Math.sin(h), fz = Math.cos(h);
  // across: (cos h, -sin h)
  return shape.map(([u, v]) => [b.x + dx + fx * v * b.length + fz * u * b.beam, b.z + dz + fz * v * b.length - fx * u * b.beam]);
}
const hits = (b, dx = 0, dz = 0) => {
  const pts = outline(b, dx, dz);
  // the outline's corners and the midpoints of its sides
  for (let k = 0; k < pts.length; k++) {
    const [x, z] = pts[k], [x2, z2] = pts[(k + 1) % pts.length];
    if (blocked(x, z) || blocked((x + x2) / 2, (z + z2) / 2)) return true;
  }
  return blocked(b.x + dx, b.z + dz);
};

const boats = SRC.boats.map((b) => ({ ...b, length: Math.max(1.5, b.length - BLUR), beam: Math.max(0.8, b.beam - BLUR) }));
let slid = 0, trimmed = 0, stuck = 0;
for (const b of boats) {
  if (!hits(b)) continue;
  let done = false;
  for (let trim = 0; trim < 3 && !done; trim++) {
    if (trim) { b.length *= 0.92; b.beam *= 0.96; }
    for (let d = 0.05; d <= MAX_SLIDE + 1e-9 && !done; d += 0.05) {
      for (let a = 0; a < 24; a++) {
        const dx = Math.cos((a * Math.PI) / 12) * d, dz = Math.sin((a * Math.PI) / 12) * d;
        if (!hits(b, dx, dz)) { b.x += dx; b.z += dz; done = true; break; }
      }
    }
    if (done && trim) trimmed++;
    else if (done) slid++;
  }
  if (!done) { stuck++; log(`boat at ${b.x}, ${b.z} (${b.family}, ${b.length.toFixed(1)} m) stays on a pontoon or quay`); }
}

// Hulls that overlap each other (two pieces of one boat, rafted boats measured too wide): each pair is eased apart along
// the line between their centres, half the overlap each, where that keeps both clear of the pontoons; failing that the
// smaller one narrows
const SAT = (A, B) => {
  let best = Infinity;
  for (const poly of [A, B]) {
    for (let k = 0; k < poly.length; k++) {
      const [x1, z1] = poly[k], [x2, z2] = poly[(k + 1) % poly.length];
      const nx = z2 - z1, nz = x1 - x2, l = Math.hypot(nx, nz) || 1;
      const proj = (P) => P.map(([x, z]) => (x * nx + z * nz) / l);
      const a = proj(A), b = proj(B);
      const o = Math.min(Math.max(...a), Math.max(...b)) - Math.max(Math.min(...a), Math.min(...b));
      if (o <= 0) return 0;
      best = Math.min(best, o);
    }
  }
  return best;
};
let eased = 0, narrowed = 0;
for (let pass = 0; pass < 6; pass++) {
  let any = false;
  for (let i = 0; i < boats.length; i++) {
    for (let j = i + 1; j < boats.length; j++) {
      const a = boats[i], b = boats[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) > (a.length + b.length) / 2) continue;
      const o = SAT(outline(a), outline(b));
      if (o < 0.05) continue;
      any = true;
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1, push = Math.min(0.4, o / 2 + 0.02);
      const ux = (dx / l) * push, uz = (dz / l) * push;
      if (!hits(a, -ux, -uz) && !hits(b, ux, uz)) {
        a.x -= ux; a.z -= uz; b.x += ux; b.z += uz;
        eased++;
      } else {
        const small = a.length * a.beam < b.length * b.beam ? a : b;
        small.beam = Math.max(0.8, small.beam - Math.min(0.3, o));
        narrowed++;
      }
    }
  }
  if (!any) break;
}

// --- classes ------------------------------------------------------------------------------------------------------------

// a hash in [0, 1) of a boat's position and a salt: it picks paints & options per boat, and a boat keeps them however
// many others come or go in the data
const hashAt = (b, k) => {
  let h = Math.imul((Math.round(b.x * 100) * 73856093) ^ (Math.round(b.z * 100) * 19349663) ^ (k * 83492791), 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

// The rows of small boats: where the boats within ROW_R (itself included) are mostly (the median) under ROW_SMALL long.
// Their open & motor boats up to TXIPI_MAX are txipironeras.
const ROW_R = 9, ROW_SMALL = 5.4, TXIPI_MAX = 7.5; // m
for (const b of boats) {
  const near = boats.filter((o) => Math.hypot(o.x - b.x, o.z - b.z) <= ROW_R).map((o) => o.length).sort((p, q) => p - q);
  b.rowLength = near[near.length >> 1];
}

// The island ferries: the passenger boats moored alongside OSM's ferry pier (within 12 m of it), west to east
const FERRY_PIER = loadLayer('osm_places.json').elements.find((e) => e.tags?.man_made === 'pier' && e.tags?.ferry === 'yes' && e.geometry);
if (!FERRY_PIER) throw new Error('the ferry pier (man_made=pier, ferry=yes) is missing from the OSM snapshot');
const pierLine = FERRY_PIER.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
const pierNear = (x, z) => {
  let best = { d: Infinity };
  for (let k = 0; k + 1 < pierLine.length; k++) {
    const [ax, az] = pierLine[k], [bx, bz] = pierLine[k + 1];
    const d = segDist(x, z, ax, az, bx, bz);
    if (d < best.d) {
      const dx = bx - ax, dz = bz - az, t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      best = { d, x: ax + dx * t, z: az + dz * t };
    }
  }
  return best;
};
const ferries = boats.filter((b) => b.family === 'passenger' && pierNear(b.x, b.z).d < 12).sort((a, b) => a.x - b.x);
if (ferries.length !== 2) log(`WARNING: ${ferries.length} island ferries at the ferry pier (2 expected)`);
ferries.splice(2);

function classify(b) {
  if (ferries.includes(b)) return 'ferry';
  if (b.family === 'txalupa') return 'txipironera';
  if ((b.family === 'open' || b.family === 'motor') && b.rowLength <= ROW_SMALL && b.length <= TXIPI_MAX) return 'txipironera';
  return b.family; // sail, motor, open, rib, passenger, fishing
}
for (const b of boats) b.cls = classify(b);

// --- paints & options ----------------------------------------------------------------------------------------------------

const rgb = (hex) => [1, 3, 5].map((o) => parseInt(hex.slice(o, o + 2), 16));
const hex = (c) => c.reduce((v, x) => v * 256 + Math.max(0, Math.min(255, Math.round(x))), 0);
// (gelcoat white is no paper white: a little under the promenade's paving, so the boats keep their shape at noon)
const WHITE = [226, 227, 223], NAVY = [32, 44, 70], CANVAS = [214, 208, 192], TUBE_GREY = [92, 96, 100];
const chroma = (c) => Math.max(...c) - Math.min(...c);
// a colour of the photo's, lifted towards the paint under the haze & shade a 12.5 cm pixel averages in
const lift = (hex) => {
  const c = rgb(hex);
  const m = Math.max(...c);
  return m > 0 ? c.map((v) => Math.min(232, (v * Math.min(1.25, 228 / m)))) : WHITE;
};
// a paint seen through the photo's haze (a pale veil over everything): its colour pushed away from grey, half as far
// again, and darkened a little
const unveil = (c) => {
  const m = (c[0] + c[1] + c[2]) / 3;
  return c.map((v) => Math.max(0, Math.min(232, (m + (v - m) * 1.6) * 0.92)));
};
// The port's small boats & fishing boats as the photos show them (raw/refs/boats): the txipironeras' hulls deep or bright
// blue, red, orange, green or black under a white gunwale stripe, or white under a coloured one, white, grey or a pale
// blue or green inside; the fishing boats' hulls black, blue or red, their wheelhouses white or (on a black hull)
// orange. The island ferries are the Motoras de la Isla's blue, white above.
const TXIPI_HULLS = [[28, 47, 92], [31, 86, 168], [64, 150, 206], [178, 38, 42], [222, 84, 44], [30, 88, 58], [36, 132, 112], [27, 29, 32]];
const TXIPI_STRIPES = [[178, 38, 42], [31, 86, 168], [30, 88, 58], [28, 47, 92]];
const TXIPI_INSIDES = [[224, 222, 212], [224, 222, 212], [198, 202, 202], [172, 202, 216], [180, 208, 186], [162, 208, 202]];
const FISHING_HULLS = [[27, 29, 32], [36, 82, 160], [178, 34, 36]];
// the small launches' hulls (a third of the motor boats under 7 m), as the photos show them among the white ones
const LAUNCH_HULLS = [[28, 47, 92], [150, 32, 36], [30, 80, 55], [31, 86, 168], [24, 26, 30]];
const FERRY_PAINT = [[31, 108, 196], WHITE, WHITE];
const pick = (list, t) => list[Math.min(list.length - 1, Math.floor(t * list.length))];
// [hull, deck, accent]; a hull the photo shows painted all over (its tone well away from grey) keeps that paint; an
// open boat's deck is its inside, the whole boat's tone
function paints(b) {
  const acc = b.accent ? rgb(b.accent) : null, tone = rgb(b.tone || b.colour);
  const deck = b.family === 'open' || b.family === 'txalupa' ? lift(b.tone || b.colour) : lift(b.colour);
  const painted = chroma(tone) > 40 ? tone.map((v) => Math.min(232, v * 1.1)) : null;
  switch (b.cls) {
    case 'txipironera': {
      // the ones the photo shows painted all over keep their paint; the rest (seen from above: the white gunwale & the
      // inside) one of the port's, a third of them white
      const inside = chroma(deck) > 35 ? deck : pick(TXIPI_INSIDES, hashAt(b, 10));
      if (b.family === 'txalupa') return [unveil(acc || tone), inside, WHITE];
      if (hashAt(b, 6) < 0.3) return [WHITE, inside, pick(TXIPI_STRIPES, hashAt(b, 7))];
      const hull = pick(TXIPI_HULLS, hashAt(b, 8));
      return [hull, inside, hashAt(b, 9) < 0.8 ? WHITE : pick(TXIPI_STRIPES.filter((s) => s !== hull), hashAt(b, 7))];
    }
    case 'fishing': {
      const hull = acc && Math.max(...acc) < 60 ? FISHING_HULLS[0] : pick(FISHING_HULLS, hashAt(b, 8));
      return [hull, [200, 201, 197], hull === FISHING_HULLS[0] ? [214, 110, 40] : WHITE]; // (the accent: the wheelhouse)
    }
    case 'ferry': return FERRY_PAINT;
    case 'rib': return [WHITE, deck, acc ? unveil(acc) : TUBE_GREY]; // the tubes
    case 'sail': return [WHITE, deck, acc && chroma(acc) > 40 ? acc : NAVY]; // the sail cover
    case 'open': return [painted || WHITE, deck, acc || NAVY]; // (the accent: the console's & seats' covers)
    case 'passenger': return [WHITE, deck, acc || NAVY];
    default: { // motor: the canopy
      const launch = b.length < 7 && hashAt(b, 11) < 0.35 ? pick(LAUNCH_HULLS, hashAt(b, 12)) : null;
      return [painted || launch || WHITE, deck, acc || CANVAS];
    }
  }
}
// Options, bits: 1 the class's optional fitting (an open boat's console, a motor boat's canopy where the photo shows its
// colour, a txipironera's wheelhouse where a cabin shows from above), 2 an outboard (open boats, txipironeras without one)
function options(b) {
  switch (b.cls) {
    case 'open': return (hashAt(b, 2) >= 0.55 ? 1 : 0) | (hashAt(b, 5) < 0.85 ? 2 : 0);
    case 'motor': return b.accent || hashAt(b, 3) >= 0.75 ? 1 : 0;
    case 'txipironera': return b.family === 'motor' ? 1 : hashAt(b, 5) < 0.35 ? 2 : 0;
    default: return 0;
  }
}

// --- the island ferries' lanes ---------------------------------------------------------------------------------------------

// The terrain (the 2 m core grid of build.mjs, as bake-marina.mjs reads it, between its cells' centres as the ground is
// drawn): land beyond the port's grid above, where it stands 0.2 m out of the sea
const heightAt = await (async () => {
  const { x0, z0, w, h, res, url } = GEO.terrain.core;
  const file = fs.readFileSync(path.join(ROOT, url));
  const img = await decodePNG(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
  const at = (i, j) => {
    const k = Math.max(0, Math.min(h - 1, j)) * w + Math.max(0, Math.min(w - 1, i));
    return ((img.data[3 * k] << 8) | img.data[3 * k + 1]) / 100 - GEO.terrain.heightOffset;
  };
  return (x, z) => {
    const fx = (x - x0) / res - 0.5, fz = (z - z0) / res - 0.5, i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    return (at(i, j) * (1 - tx) + at(i + 1, j) * tx) * (1 - tz) + (at(i, j + 1) * (1 - tx) + at(i + 1, j + 1) * tx) * tz;
  };
})();
const inGrid = (x, z) => x >= G.x0 && z >= G.z0 && x < G.x0 + G.w * G.res && z < G.z0 + G.h * G.res;
const solid = (x, z) => blocked(x, z) || (!inGrid(x, z) && heightAt(x, z) > 0.2);
// a ferry's outline from above: a blunt bow, as the Motoras' (the photo's ferries, and their photos)
const FERRY_OUTLINE = [[0.3, 0.5], [0.45, 0.42], [0.5, 0.25], [0.5, -0.5], [-0.5, -0.5], [-0.5, 0.25], [-0.45, 0.42], [-0.3, 0.5]];
// what the ferry f at (x, z, heading) with m metres to spare touches: 'built' (quays, pontoons, land), a moored boat, or
// nothing (the other ferry is away whenever this one moves)
function ferryHits(f, x, z, heading, m) {
  const pts = outline({ x, z, heading, length: f.length + 2 * m, beam: f.beam + 2 * m }, 0, 0, FERRY_OUTLINE);
  for (let k = 0; k < pts.length; k++) {
    const [ax, az] = pts[k], [bx, bz] = pts[(k + 1) % pts.length];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let q = 0; q < n; q++) if (solid(ax + ((bx - ax) * q) / n, az + ((bz - az) * q) / n)) return 'built';
  }
  if (solid(x, z)) return 'built';
  for (const o of boats) {
    if (o.cls === 'ferry' || Math.hypot(o.x - x, o.z - z) > (o.length + f.length) / 2 + m + 1) continue;
    if (SAT(pts, outline(o)) > 0) return o;
  }
  return null;
}
const unit = (h) => [Math.sin((h * Math.PI) / 180), Math.cos((h * Math.PI) / 180)];
const headingOf = (dx, dz) => ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360;
// signed turn from heading a to b, the short way (degrees)
const turnTo = (a, b) => ((b - a + 540) % 360) - 180;

// OSM's route (way 28161360, "Donostia - Santa Clara"): from the ferry pier in the north basin, out through the old port
// & the harbour mouth, across the bay and round the island jetty's head to its landing
const ROUTE = loadLayer('osm_ferry.json').elements.find((e) => e.tags?.route === 'ferry' && /Santa Clara/.test(e.tags?.name || '') && e.geometry);
if (!ROUTE || !ferries.length) throw new Error('the island ferry route (route=ferry, Donostia - Santa Clara) or its ferries are missing');
const route = ROUTE.geometry.map((p) => lonLatToLocal(p.lon, p.lat));
const ISLAND_END = route[route.length - 1];
const HARBOUR = MARINA.harbour.ring;
const inHarbour = (x, z) => pointInRing(x, z, HARBOUR);
const SPEED = { harbour: 2.0, bay: 5.0 }; // m/s
const OFFSET = 9; // m to starboard of OSM's line in the bay, either way (the harbour & the island's approach: on it)
const STEP = 4; // m between a lane's points

// the island's landing for a ferry: its bow on the route's end, heading as the route's last 10 m, then back along its
// axis till its outline clears the jetty by 0.1 m
function islandLanding(f) {
  let k = route.length - 2;
  while (k > 0 && Math.hypot(route[k][0] - ISLAND_END[0], route[k][1] - ISLAND_END[1]) < 10) k--;
  const heading = headingOf(ISLAND_END[0] - route[k][0], ISLAND_END[1] - route[k][1]), [ux, uz] = unit(heading);
  for (let d = f.length / 2; d < f.length / 2 + 15; d += 0.1) {
    const x = ISLAND_END[0] - ux * d, z = ISLAND_END[1] - uz * d;
    if (!ferryHits(f, x, z, heading, 0.1)) return { x, z, heading };
  }
  throw new Error('no clear landing at the island jetty');
}
// Astern from a berth to the nearest point (12 m back or more, as little as may be off the berth's line towards `away`,
// a unit [x, z]) where the ferry turns clear to `toward` ([x, z] of where it heads next): the way back clear at the
// berth's heading, and every heading of the turn (the short way, else the long one)
function asternTurn(f, berth, toward, away = [0, 0]) {
  const [ux, uz] = unit(berth.heading);
  for (let d = 12; d <= 45; d += 1) {
    for (let e = 0; e <= 12; e += 2) {
      const x = berth.x - ux * d + away[0] * e, z = berth.z - uz * d + away[1] * e;
      let clear = true;
      for (let q = 1, n = Math.ceil(Math.hypot(d, e)); q <= n && clear; q++) {
        if (ferryHits(f, berth.x + ((x - berth.x) * q) / n, berth.z + ((z - berth.z) * q) / n, berth.heading, 0)) clear = false;
      }
      if (!clear) continue;
      const short = turnTo(berth.heading, headingOf(toward[0] - x, toward[1] - z));
      for (const turn of [short, short - Math.sign(short) * 360]) {
        let ok = true;
        for (let q = 1; q <= 24 && ok; q++) if (ferryHits(f, x, z, berth.heading + (turn * q) / 24, 0.5)) ok = false;
        if (ok) return { x, z, turn };
      }
    }
  }
  throw new Error(`no room to turn astern of the berth at ${berth.x.toFixed(1)}, ${berth.z.toFixed(1)}`);
}
// Chaikin's corner cutting (the ends kept), then points STEP apart
function smooth(pts, rounds = 4) {
  let p = pts;
  for (let r = 0; r < rounds; r++) {
    const q = [p[0]];
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, az] = p[k], [bx, bz] = p[k + 1];
      if (k > 0) q.push([0.75 * ax + 0.25 * bx, 0.75 * az + 0.25 * bz]);
      if (k + 2 < p.length) q.push([0.25 * ax + 0.75 * bx, 0.25 * az + 0.75 * bz]);
    }
    q.push(p[p.length - 1]);
    p = q;
  }
  const out = [p[0]];
  let carry = 0;
  for (let k = 0; k + 1 < p.length; k++) {
    const [ax, az] = p[k], [bx, bz] = p[k + 1], l = Math.hypot(bx - ax, bz - az);
    let s = STEP - carry;
    for (; s < l; s += STEP) out.push([ax + ((bx - ax) * s) / l, az + ((bz - az) * s) / l]);
    carry = l - (s - STEP);
  }
  const last = p[p.length - 1], end = out[out.length - 1];
  if (Math.hypot(last[0] - end[0], last[1] - end[1]) > STEP * 0.4) out.push(last);
  else out[out.length - 1] = last;
  return out;
}
// A lane: the points kept to starboard by OFFSET out in the bay (eased in over 100 m from the harbour mouth and the
// island's landing), smoothed; each with its speed limit
function lane(pts, island) {
  const mouth = MARINA.harbour.mouth;
  const ramp = (d) => Math.min(1, Math.max(0, (d - 30) / 100)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (d - 30) / 100)));
  const shifted = pts.map(([x, z], k) => {
    if (k === 0 || k === pts.length - 1 || inHarbour(x, z)) return [x, z];
    const [px, pz] = pts[k - 1], [nx, nz] = pts[k + 1], l = Math.hypot(nx - px, nz - pz) || 1;
    const w = OFFSET * ramp(Math.hypot(x - mouth[0], z - mouth[1])) * ramp(Math.hypot(x - island.x, z - island.z));
    return [x - ((nz - pz) / l) * w, z + ((nx - px) / l) * w]; // starboard of (dx, dz): (-dz, dx)
  });
  return smooth(shifted).map(([x, z]) => [x, z, inHarbour(x, z) ? SPEED.harbour : SPEED.bay]);
}
// Where the ferry f on a lane would brush a moored boat (OSM draws the fairway, not round what moors beside it) the lane
// bends away from the boat: each such point's least sideways shift that clears it by 0.6 m, eased out over 30 m either
// way (the ends stay put)
function keepClear(f, pts) {
  const normal = (k) => {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return { h: headingOf(b[0] - a[0], b[1] - a[1]), nx: -(b[1] - a[1]) / l, nz: (b[0] - a[0]) / l };
  };
  const R = Math.round(30 / STEP), n = pts.length;
  for (let round = 0; round < 4; round++) {
    const push = new Float64Array(n);
    let any = false;
    for (let k = 2; k < n - 2; k++) {
      const [x, z] = pts[k], { h, nx, nz } = normal(k), hit = ferryHits(f, x, z, h, 0.3);
      if (!hit || hit === 'built') continue;
      const side = Math.sign((x - hit.x) * nx + (z - hit.z) * nz) || 1;
      for (let d = 0.25; d <= 6; d += 0.25) {
        if (!ferryHits(f, x + nx * side * d, z + nz * side * d, h, 0.6)) { push[k] = side * d; any = true; break; }
      }
    }
    if (!any) break;
    pts = pts.map(([x, z, v], k) => {
      let best = 0;
      for (let j = Math.max(0, k - R); j <= Math.min(n - 1, k + R); j++) {
        const t = 1 - Math.abs(k - j) / R, p = push[j] * t * t * (3 - 2 * t);
        if (Math.abs(p) > Math.abs(best)) best = p;
      }
      best *= Math.min(1, k / 5, (n - 1 - k) / 5);
      const { nx, nz } = normal(k);
      return [x + nx * best, z + nz * best, v];
    });
  }
  return pts;
}
// the route's points from the first one 45 m clear of every ferry's berth (the ferries' own approaches replace the rest)
const routeFrom = route.findIndex(([x, z]) => ferries.every((f) => Math.hypot(x - f.x, z - f.z) > 45));
const FERRIES_OUT = ferries.map((f) => {
  const berth = { x: f.x, z: f.z, heading: f.heading };
  const island = islandLanding(f);
  // out: astern off the berth, turn towards the route, the route to 20 m short of the landing, the last 18 m straight in
  const [iux, iuz] = unit(island.heading);
  const shared = route.slice(routeFrom).filter(([x, z]) => Math.hypot(x - island.x, z - island.z) > 20);
  const p = pierNear(f.x, f.z), port = asternTurn(f, berth, shared[0], [(f.x - p.x) / p.d, (f.z - p.z) / p.d]);
  const out = keepClear(f, lane([[port.x, port.z], ...shared, [island.x - iux * 18, island.z - iuz * 18], [island.x, island.z]], island));
  // back: astern off the landing, turn towards the route reversed from its first point 25 m off, the route, the last 40 m
  // along the berth's line
  const rev = route.slice(routeFrom).reverse(), from = rev.findIndex(([x, z]) => Math.hypot(x - island.x, z - island.z) > 30);
  const isl = asternTurn(f, island, rev[from]);
  const [bux, buz] = unit(berth.heading);
  const back = keepClear(f, lane([[isl.x, isl.z], ...rev.slice(from), [berth.x - bux * 40, berth.z - buz * 40], [berth.x, berth.z]], island));
  // every point of both lanes clear (by 0.3 m; coming alongside, the last 8 m, by what the berth itself has), at the
  // heading the ferry has there
  let worst = 0;
  for (const pts of [out, back]) {
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], b = pts[Math.min(pts.length - 1, k + 1)];
      const hit = ferryHits(f, pts[k][0], pts[k][1], headingOf(b[0] - a[0], b[1] - a[1]), k >= pts.length - 3 ? 0 : 0.3);
      if (hit) { worst++; if (worst <= 6) log(`ferry lane at ${pts[k][0].toFixed(1)}, ${pts[k][1].toFixed(1)} touches ${hit === 'built' ? 'a quay, pontoon or land' : `the ${hit.cls} at ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`}`); }
    }
  }
  if (worst) throw new Error(`${worst} points of the ferry's lanes are not clear`);
  return { f, berth, island, turns: [port.turn, isl.turn], out, back };
});

// --- output ------------------------------------------------------------------------------------------------------------

const cm = (v) => Math.round(v * 100);
const deg10 = (h) => Math.round((((h % 360) + 360) % 360) * 10) % 3600;
const flat = [];
const count = Object.fromEntries([...CLASSES, 'ferry'].map((c) => [c, 0]));
for (const b of boats) {
  count[b.cls]++;
  if (b.cls === 'ferry') continue;
  const [hull, deck, accent] = paints(b);
  flat.push(cm(b.x), cm(b.z), deg10(b.heading), cm(b.length), cm(b.beam), CLASSES.indexOf(b.cls), options(b),
    hex(hull), hex(deck), hex(accent));
}
const DATA_OUT = {
  classes: CLASSES,
  // per boat 10 integers: x, z (cm), heading (tenths of a degree from +z towards +x, of the bow), length, beam (cm),
  // class (index), options (bits: 1 the class's optional fitting, 2 an outboard), hull, deck & accent colours (sRGB
  // 0xRRGGBB)
  boats: flat
};
const FERRY_DATA = {
  // hull, deck & accent colours (sRGB 0xRRGGBB)
  paint: FERRY_PAINT.map(hex),
  // per ferry: its berth [x, z (cm), heading (tenths of a degree), length, beam (cm)]; the island's landing [x, z,
  // heading]; the turns it makes astern of each [berth, landing] (tenths of a degree, signed); its lanes out & back,
  // points STEP m apart from the turn astern to the landing / the berth: [x, z (cm), speed limit (cm/s)] each
  ferries: FERRIES_OUT.map(({ f, berth, island, turns, out, back }) => ({
    berth: [cm(berth.x), cm(berth.z), deg10(berth.heading), cm(f.length), cm(f.beam)],
    island: [cm(island.x), cm(island.z), deg10(island.heading)],
    turns: turns.map((t) => Math.round(t * 10)),
    out: out.flatMap(([x, z, v]) => [cm(x), cm(z), cm(v)]),
    back: back.flatMap(([x, z, v]) => [cm(x), cm(z), cm(v)])
  }))
};
const js = '// js/donostia/data-boats.js — generated by tools/donostia/bake-boats.mjs; do not edit.\n' +
  '// Boats digitised on the 2025 orthophoto: Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi (free use with the credit) · ' +
  'pontoons & quays: Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0) · ' +
  'the ferry route & pier: © OpenStreetMap contributors (ODbL)\n' +
  licenceComment('c500', 'osm') +
  `//   Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi (Ortofoto 2025): free use with the credit\n` +
  `export const BOATS = ${JSON.stringify(DATA_OUT)};\n` +
  `export const FERRY = ${JSON.stringify(FERRY_DATA)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${boats.length} boats ${JSON.stringify(count)}, ${(js.length / 1e3).toFixed(1)} kB; ` +
  `${slid} slid & ${trimmed} trimmed off the pontoons (${stuck} stuck), ${eased} pairs eased apart, ${narrowed} narrowed; ` +
  `ferry lanes ${FERRIES_OUT.map(({ out, back }) => `${((out.length - 1) * STEP).toFixed(0)} & ${((back.length - 1) * STEP).toFixed(0)} m`).join(', ')}`);

// --preview <dir>: the hulls over the pontoons & quays, from above (8 px/m)
if (PREVIEW) {
  const x0 = -180, z0 = -250, w = 310 * 8, h = 200 * 8, px = new Uint8Array(w * h * 3).fill(20);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const x = x0 + (i + 0.5) / 8, z = z0 + (j + 0.5) / 8, o = (j * w + i) * 3;
      if (blocked(x, z)) { px[o] = 150; px[o + 1] = 130; px[o + 2] = 110; }
    }
  }
  for (const b of boats) {
    const pts = outline(b), [r, g, bl] = paints(b)[0];
    for (let j = 0; j < h; j++) {
      const z = z0 + (j + 0.5) / 8;
      if (Math.abs(z - b.z) > b.length) continue;
      for (let i = 0; i < w; i++) {
        const x = x0 + (i + 0.5) / 8;
        if (Math.abs(x - b.x) > b.length) continue;
        let inside = false;
        for (let a = 0, c = pts.length - 1; a < pts.length; c = a++) {
          if ((pts[a][1] > z) !== (pts[c][1] > z) && x < ((pts[c][0] - pts[a][0]) * (z - pts[a][1])) / (pts[c][1] - pts[a][1]) + pts[a][0]) inside = !inside;
        }
        if (inside) { const o = (j * w + i) * 3; px[o] = r; px[o + 1] = g; px[o + 2] = bl; }
      }
    }
  }
  // the ferries' lanes: out in yellow, back in magenta
  const dot = (img, wi, hi, i, j, c) => {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < wi && jj < hi) img.set(c, (jj * wi + ii) * 3);
    }
  };
  const lanes = (img, wi, hi, ox, oz, s) => FERRIES_OUT.forEach(({ out, back }) => [[out, [250, 220, 0]], [back, [240, 0, 200]]].forEach(([pts, c]) =>
    pts.forEach(([x, z]) => dot(img, wi, hi, Math.floor((x - ox) * s), Math.floor((z - oz) * s), c))));
  lanes(px, w, h, x0, z0, 8);
  fs.writeFileSync(path.join(PREVIEW, 'boats.png'), encodePNG(px, w, h, 3));
  // ... and over the bay to the island (1 px/m): land & what is built in grey
  const fx0 = -960, fz0 = -260, fw = 1040, fh = 440, fpx = new Uint8Array(fw * fh * 3).fill(20);
  for (let j = 0; j < fh; j++) {
    for (let i = 0; i < fw; i++) if (solid(fx0 + i + 0.5, fz0 + j + 0.5)) fpx.set([150, 130, 110], (j * fw + i) * 3);
  }
  lanes(fpx, fw, fh, fx0, fz0, 1);
  fs.writeFileSync(path.join(PREVIEW, 'ferry.png'), encodePNG(fpx, fw, fh, 3));
}
