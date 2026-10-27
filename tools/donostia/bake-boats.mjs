// tools/donostia/bake-boats.mjs
// usage: node tools/donostia/bake-boats.mjs [--preview <dir>]
// The port's moored boats for js/donostia/boats.js -> js/donostia/data-boats.js, from the committed
// tools/donostia/data/port_boats.json (digitise-boats.mjs, on geoEuskadi's 2025 orthophoto):
// - Every hull is kept clear of what the port is built of: the municipal map's pontoons, quays, docks & moles
//   (PANTALANA, KAIA, NASA, DIKEA) and OSM's piers (the north basin's floating pontoon, the ferry landing, and the inner
//   basin's walkways where the municipal map leaves them out), as js/donostia's marina builds them. A hull that touches
//   one slides off it by the least distance (up to 1.5 m), or is trimmed a little; hulls that overlap each other are
//   eased apart.
// - The photo's blur widens every hull by about a pixel each side: lengths & beams lose 15 cm.
// - Paints, per boat a hull, a deck & an accent colour: hulls a gelcoat white unless the photo shows them painted (the
//   txalupas, painted open & motor boats), decks as photographed (an open boat's: its inside), the accent (a sailboat's
//   sail cover, a motor boat's canopy, a RIB's tubes, a txalupa's sheer stripe) as photographed or the usual navy &
//   canvas. The photo's colours come lifted out of its haze.
// Deterministic: no randomness, a fixed order.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, DATA, loadLayer, lonLatToLocal, pointInRing, scanRings, encodePNG, previewDir, licenceComment, log } from './lib.mjs';

const ROOT = path.resolve(HERE, '../..');
const OUT = path.join(ROOT, 'js/donostia/data-boats.js');
const PREVIEW = previewDir();
const SRC = JSON.parse(fs.readFileSync(path.join(DATA, 'port_boats.json'), 'utf8'));
const FAMILIES = ['sail', 'motor', 'open', 'txalupa', 'rib', 'passenger', 'fishing'];
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
function outline(b, dx = 0, dz = 0) {
  const h = (b.heading * Math.PI) / 180, fx = Math.sin(h), fz = Math.cos(h);
  // across: (cos h, -sin h)
  return OUTLINE.map(([u, v]) => [b.x + dx + fx * v * b.length + fz * u * b.beam, b.z + dz + fz * v * b.length - fx * u * b.beam]);
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

// --- paints --------------------------------------------------------------------------------------------------------------

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
// [hull, deck, accent]; a hull the photo shows painted all over (its tone well away from grey) keeps that paint; an
// open boat's deck is its inside, the whole boat's tone
function paints(b) {
  const acc = b.accent ? rgb(b.accent) : null, tone = rgb(b.tone || b.colour);
  const deck = b.family === 'open' || b.family === 'txalupa' ? lift(b.tone || b.colour) : lift(b.colour);
  const painted = chroma(tone) > 40 ? tone.map((v) => Math.min(232, v * 1.1)) : null;
  switch (b.family) {
    case 'txalupa': return [unveil(acc || tone), deck, WHITE]; // painted hull, a white sheer stripe
    case 'rib': return [WHITE, deck, acc ? unveil(acc) : TUBE_GREY]; // the tubes
    case 'sail': return [WHITE, deck, acc && chroma(acc) > 40 ? acc : NAVY]; // the sail cover
    case 'open': return [painted || WHITE, deck, acc || NAVY]; // (the accent: the console's & seats' covers)
    case 'passenger': return [WHITE, deck, acc || NAVY];
    case 'fishing': return [acc || [40, 70, 120], WHITE, [190, 40, 35]];
    default: return [painted || WHITE, deck, acc || CANVAS]; // motor: the canopy
  }
}

// --- output ------------------------------------------------------------------------------------------------------------

const cm = (v) => Math.round(v * 100);
const flat = [];
const count = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
for (const b of boats) {
  const [hull, deck, accent] = paints(b);
  flat.push(cm(b.x), cm(b.z), Math.round(b.heading * 10) % 3600, cm(b.length), cm(b.beam), FAMILIES.indexOf(b.family),
    hex(hull), hex(deck), hex(accent));
  count[b.family]++;
}
const DATA_OUT = {
  families: FAMILIES,
  // per boat 9 integers: x, z (cm), heading (tenths of a degree from +z towards +x, of the bow), length, beam (cm),
  // family (index), hull, deck & accent colours (sRGB 0xRRGGBB)
  boats: flat
};
const js = '// js/donostia/data-boats.js — generated by tools/donostia/bake-boats.mjs; do not edit.\n' +
  '// Boats digitised on the 2025 orthophoto: Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi (free use with the credit) · ' +
  'pontoons & quays: Donostiako Udala / Ayuntamiento de San Sebastián, cartografía municipal 1:500 (CC BY-SA 3.0) · ' +
  '© OpenStreetMap contributors (ODbL)\n' +
  licenceComment('c500', 'osm') +
  `//   Eusko Jaurlaritza / Gobierno Vasco. geoEuskadi (Ortofoto 2025): free use with the credit\n` +
  `export const BOATS = ${JSON.stringify(DATA_OUT)};\n`;
fs.writeFileSync(OUT, js);
log(`${path.relative(ROOT, OUT)}: ${boats.length} boats ${JSON.stringify(count)}, ${(js.length / 1e3).toFixed(1)} kB; ` +
  `${slid} slid & ${trimmed} trimmed off the pontoons (${stuck} stuck), ${eased} pairs eased apart, ${narrowed} narrowed`);

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
  fs.writeFileSync(path.join(PREVIEW, 'boats.png'), encodePNG(px, w, h, 3));
}
