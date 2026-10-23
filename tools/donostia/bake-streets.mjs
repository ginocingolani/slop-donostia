// tools/donostia/bake-streets.mjs
// usage: node tools/donostia/bake-streets.mjs
// Bakes js/donostia/data-streets.js for the HUD (js/donostia/hud.js & minimap.js) from tools/donostia/data:
//   streets    named OpenStreetMap highways (osm_streets.json) as simplified polylines, grouped by name, Basque first
//   districts  the auzoak (neighbourhoods) of the municipal map (auzoak.json), with a label point inside the core
//   places     named squares, beaches, parks & water from OpenStreetMap (osm_places.json), plus La Concha bay
// Everything is in the local frame, rounded to whole metres: plenty for "where am I" and a radar.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, FRAME, loadLayer, lonLatToLocal, osmPolygons, simplifyRing, ringArea, pointInRing, log } from './lib.mjs';

const ROOT = path.join(HERE, '..', '..');
const OUT_JS = path.join(ROOT, 'js', 'donostia', 'data-streets.js');
const CORE = FRAME.core;
// Streets and places beyond the core are kept for the radar's view over the edges, up to here
const KEEP = { minX: CORE.minX - 900, maxX: CORE.maxX + 900, minZ: CORE.minZ - 900, maxZ: CORE.maxZ + 900 };

// Road classes, drawn and ranked by the HUD: 0 paths & steps, 1 pedestrian streets & lanes, 2 residential streets,
// 3 tertiary, 4 secondary, 5 primary & motorways
const CLASS = {
  footway: 0, path: 0, steps: 0, cycleway: 0, track: 0, bridleway: 0,
  pedestrian: 1, living_street: 1, service: 1, busway: 1,
  residential: 2, unclassified: 2, road: 2,
  tertiary: 3, tertiary_link: 3,
  secondary: 4, secondary_link: 4,
  primary: 5, primary_link: 5, trunk: 5, trunk_link: 5, motorway: 5, motorway_link: 5
};

// OSM's `name` is Basque in Donostia unless the way only carries the Spanish form; these openings give that away
const SPANISH = /^(Calle|Paseo|Avenida|Plaza|Plazuela|Puente|Pasaje|Alameda|Camino|Carretera|Cuesta|Callejón|Ronda|Glorieta|Túnel|Ascensor|Entrada|Parking|Mercado|Paso|Río|Playa|Parque|Jardín|Jardines|Cala|Subida|Bajada|Travesía|Rotonda|Escalera|Escaleras|Muelle|Puerto)\b/;

// Places whose OSM name is only Spanish or only a bare word
const PLACE_ALIAS = {
  'Río Urumea': ['Urumea ibaia', 'Río Urumea'],
  'Kirol portua': ['Kirol portua', 'Puerto deportivo'],
  Donostia: ['Portua', 'Puerto'],
  Zurriola: ['Zurriola hondartza', 'Playa de la Zurriola'],
  Ondarreta: ['Ondarreta hondartza', 'Playa de Ondarreta'],
  'La Concha': ['Kontxa hondartza', 'Playa de La Concha'], // the beach out to low water
  Urgull: ['Urgull mendia', 'Monte Urgull']
};

// Auzoak: the municipal layer's upper-case Basque names -> [Basque, Spanish], all nineteen of the layer (only those
// under the core are baked)
const DISTRICTS = {
  IGELDO: ['Igeldo', 'Igueldo'], IBAETA: ['Ibaeta', 'Ibaeta'], AÑORGA: ['Añorga', 'Añorga'], ANTIGUA: ['Antigua', 'Antiguo'],
  AIETE: ['Aiete', 'Ayete'], ERDIALDEA: ['Erdialdea', 'Centro'], 'MIRAMON - ZORROAGA': ['Miramon-Zorroaga', 'Miramón-Zorroaga'],
  AMARABERRI: ['Amara Berri', 'Amara Berri'], GROS: ['Gros', 'Gros'], EGIA: ['Egia', 'Egia'],
  'ATEGORRIETA - ULIA': ['Ategorrieta-Ulia', 'Ategorrieta-Ulía'], LOIOLA: ['Loiola', 'Loyola'],
  MARTUTENE: ['Martutene', 'Martutene'], INTXAURRONDO: ['Intxaurrondo', 'Intxaurrondo'], ALTZA: ['Altza', 'Alza'],
  'MIRAKRUZ - BIDEBIETA': ['Mirakruz-Bidebieta', 'Miracruz-Bidebieta'], ZUBIETA: ['Zubieta', 'Zubieta'],
  OARAIN: ['Oarain', 'Oarain'], LANDERBASO: ['Landerbaso', 'Landerbaso']
};
// A district the table does not know yet (the core grew into it) still reads as a name, not as the map's upper case
const titleCase = (key) => key.toLocaleLowerCase('eu').replace(/(^|[\s-])(\p{L})/gu, (m, sep, c) => sep + c.toLocaleUpperCase('eu'));

// La Concha bay, drawn by hand generously over the land: only its water counts (the HUD checks the ground class).
// The mouth runs from the Peine del Viento at the foot of Igeldo to the tip of Urgull.
const BAY = ['Kontxako badia', 'Bahía de La Concha', [
  -1420, -40, -1330, -110, -460, -420, -330, -380, -60, -260, 150, -120, 300, 60, 200, 700, -500, 900, -1450, 500
]];
const SEA = ['Kantauri itsasoa', 'Mar Cantábrico'];

const round = (v) => Math.round(v);
const flatLocal = (geom) => geom.flatMap((p) => lonLatToLocal(p.lon, p.lat));
const inKeep = (flat) => {
  for (let k = 0; k < flat.length; k += 2) {
    if (flat[k] > KEEP.minX && flat[k] < KEEP.maxX && flat[k + 1] > KEEP.minZ && flat[k + 1] < KEEP.maxZ) return true;
  }
  return false;
};

// Douglas-Peucker on an open flat polyline
function simplifyLine(p, tol) {
  const n = p.length / 2;
  if (n <= 2) return p;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = p[2 * a], az = p[2 * a + 1], dx = p[2 * b] - ax, dz = p[2 * b + 1] - az;
    const len2 = dx * dx + dz * dz || 1e-12;
    let idx = -1, max = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = p[2 * i] - ax, pz = p[2 * i + 1] - az;
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / len2));
      const ex = px - t * dx, ez = pz - t * dz, d2 = ex * ex + ez * ez;
      if (d2 > max) { max = d2; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out;
}

// Whole metres, without the repeated vertices rounding makes
function roundPoints(p, closed = false) {
  const out = [];
  for (let k = 0; k < p.length; k += 2) {
    const x = round(p[k]), z = round(p[k + 1]);
    if (out.length && out[out.length - 2] === x && out[out.length - 1] === z) continue;
    out.push(x, z);
  }
  if (closed && out.length > 2 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

// OSM splits a street into a way per block (or wherever a tag changes): join the ways of one street that share an end
// into longer chains, taking the straightest continuation at a fork, so names have room along them and the radar
// draws fewer, longer lines
function chainLines(lines) {
  const key = (x, z) => `${x},${z}`;
  const at = new Map();
  lines.forEach((l, i) => {
    for (const k of [key(l[0], l[1]), key(l[l.length - 2], l[l.length - 1])]) {
      if (!at.has(k)) at.set(k, []);
      at.get(k).push(i);
    }
  });
  const reverse = (l) => {
    const r = [];
    for (let i = l.length - 2; i >= 0; i -= 2) r.push(l[i], l[i + 1]);
    return r;
  };
  const used = new Uint8Array(lines.length);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    let chain = lines[i];
    for (const forward of [true, false]) {
      for (;;) {
        const n = chain.length;
        const [ex, ez, px, pz] = forward ? [chain[n - 2], chain[n - 1], chain[n - 4], chain[n - 3]] : [chain[0], chain[1], chain[2], chain[3]];
        const out0 = Math.atan2(ez - pz, ex - px);
        let best = null, bestTurn = Infinity;
        for (const j of at.get(key(ex, ez)) || []) {
          if (used[j]) continue;
          const l = lines[j][0] === ex && lines[j][1] === ez ? lines[j] : reverse(lines[j]);
          let turn = Math.abs(Math.atan2(l[3] - l[1], l[2] - l[0]) - out0);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          if (turn < bestTurn) { bestTurn = turn; best = [j, l]; }
        }
        if (!best) break;
        used[best[0]] = 1;
        chain = forward ? chain.concat(best[1].slice(2)) : reverse(best[1]).concat(chain.slice(2));
      }
    }
    out.push(chain);
  }
  return out;
}

// --- Streets -----------------------------------------------------------------------------------------------------------

function bakeStreets() {
  const ways = loadLayer('osm_streets.json').elements.filter((e) => {
    const t = e.tags || {};
    if (e.type !== 'way' || !t.name || !e.geometry || e.geometry.length < 2) return false;
    if (!(t.highway in CLASS)) return false;
    // a tunnel or an underground passage is not the street you are standing on
    if ((t.tunnel && t.tunnel !== 'no') || (t.covered && t.covered !== 'no') || Number(t.layer) < 0) return false;
    return true;
  });

  // Spanish <-> Basque pairs that some ways carry, for the ways that only carry one of them
  const esToEu = new Map(), euToEs = new Map();
  for (const e of ways) {
    const t = e.tags;
    if (t['name:eu'] && t['name:es']) {
      esToEu.set(t['name:es'], t['name:eu']);
      euToEs.set(t['name:eu'], t['name:es']);
    }
  }
  const namesOf = (t) => {
    const spanishOnly = !t['name:eu'] && SPANISH.test(t.name);
    let eu = t['name:eu'] || (spanishOnly ? esToEu.get(t.name) || null : t.name);
    let es = t['name:es'] || (spanishOnly ? t.name : (eu && euToEs.get(eu)) || null);
    if (!eu) { eu = es; es = null; }
    if (es === eu) es = null;
    return [eu, es];
  };

  // Group by name, ignoring case ("Aralar mendiaren kalea" / "Aralar Mendiaren kalea"); the commonest spelling wins
  const groups = new Map();
  for (const e of ways) {
    const [eu, es] = namesOf(e.tags);
    const key = eu.toLowerCase();
    let g = groups.get(key);
    if (!g) groups.set(key, g = { spellings: new Map(), es: new Map(), ways: [] });
    g.spellings.set(eu, (g.spellings.get(eu) || 0) + 1);
    if (es) g.es.set(es, (g.es.get(es) || 0) + 1);
    const line = flatLocal(e.geometry);
    if (!inKeep(line)) continue;
    g.ways.push({ cls: CLASS[e.tags.highway], line: roundPoints(simplifyLine(line, 1.0)) });
  }
  const commonest = (m) => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;

  const names = [], out = [];
  let points = 0;
  for (const g of [...groups.values()].sort((a, b) => commonest(a.spellings).localeCompare(commonest(b.spellings), 'eu'))) {
    if (!g.ways.length) continue;
    const idx = names.length;
    const eu = commonest(g.spellings);
    const es = commonest(g.es);
    names.push(es && es !== eu ? [eu, es] : [eu]);
    const byClass = new Map();
    for (const w of g.ways) {
      if (w.line.length < 4) continue;
      if (!byClass.has(w.cls)) byClass.set(w.cls, []);
      byClass.get(w.cls).push(w.line);
    }
    for (const [cls, lines] of byClass) {
      for (const chain of chainLines(lines)) {
        const line = roundPoints(simplifyLine(chain, 1.0));
        if (line.length < 4) continue;
        out.push([idx, cls, ...line]);
        points += line.length / 2;
      }
    }
  }
  log(`streets: ${names.length} names, ${out.length} chains of ${ways.length} ways, ${points} points`);
  return { names, ways: out };
}

// --- Districts ---------------------------------------------------------------------------------------------------------

function bakeDistricts() {
  const byName = new Map();
  for (const f of loadLayer('auzoak.json').features) {
    const key = f.p.IzenAuzo;
    if (!DISTRICTS[key] && !byName.has(key)) log(`district ${key} has no display name in DISTRICTS: shown as ${titleCase(key)}`);
    const [eu, es] = DISTRICTS[key] || [titleCase(key), titleCase(key)];
    let d = byName.get(key);
    if (!d) byName.set(key, d = { name: eu, es: es !== eu ? es : null, rings: [] });
    for (const ring of f.g) {
      const r = roundPoints(simplifyRing(ring, 3), true);
      if (r.length >= 6) d.rings.push(r);
    }
  }
  // Label point: the centre of the district's part of the core, pulled onto that part when the centre falls outside
  const STEP = 40;
  for (const d of byName.values()) {
    const cells = [];
    const inside = (x, z) => d.rings.reduce((acc, r) => acc !== pointInRing(x, z, r), false);
    for (let z = CORE.minZ + STEP / 2; z < CORE.maxZ; z += STEP) {
      for (let x = CORE.minX + STEP / 2; x < CORE.maxX; x += STEP) if (inside(x, z)) cells.push([x, z]);
    }
    if (cells.length < 20) continue;
    let cx = 0, cz = 0;
    for (const [x, z] of cells) { cx += x; cz += z; }
    cx /= cells.length;
    cz /= cells.length;
    if (!inside(cx, cz)) [cx, cz] = cells.reduce((best, c) => (Math.hypot(c[0] - cx, c[1] - cz) < Math.hypot(best[0] - cx, best[1] - cz) ? c : best));
    d.label = [round(cx), round(cz)];
  }
  const out = [...byName.values()];
  log(`districts: ${out.length}, ${out.reduce((n, d) => n + d.rings.reduce((m, r) => m + r.length / 2, 0), 0)} points`);
  return out;
}

// --- Places ------------------------------------------------------------------------------------------------------------

function bakePlaces() {
  const out = [];
  for (const e of loadLayer('osm_places.json').elements) {
    const t = e.tags || {};
    if (!t.name) continue;
    const kind = t.place === 'square' ? 'square'
      : t.natural === 'beach' ? 'beach'
        : t.leisure === 'park' || t.leisure === 'garden' ? 'park'
          : t.natural === 'water' || t.leisure === 'marina' ? 'water'
            : null;
    if (!kind) continue;
    let [eu, es] = PLACE_ALIAS[t.name] || [t['name:eu'] || t.name, t['name:es'] || null];
    if (!t['name:eu'] && !PLACE_ALIAS[t.name] && SPANISH.test(t.name)) [eu, es] = [t.name, null];
    if (es === eu) es = null;
    // closed ways, and multipolygons (a square or park split over several ways): each outer ring makes a place of the
    // same name; holes do not matter to "where am I"
    for (const [outer] of osmPolygons(e)) {
      const ring = roundPoints(simplifyRing(outer, 1.0), true);
      if (ring.length < 6 || !inKeep(ring)) continue;
      out.push({ name: eu, es, kind, area: round(Math.abs(ringArea(ring))), ring });
    }
  }
  out.push({ name: BAY[0], es: BAY[1], kind: 'bay', area: round(Math.abs(ringArea(BAY[2]))), ring: BAY[2] });
  // smallest first: the first place containing a point is the most specific one
  out.sort((a, b) => a.area - b.area);
  log(`places: ${out.length}`);
  return out;
}

const STREETS = { ...bakeStreets(), districts: bakeDistricts(), places: bakePlaces(), sea: SEA };
const js = '// js/donostia/data-streets.js — generated by tools/donostia/bake-streets.mjs; do not edit.\n' +
  '// © OpenStreetMap contributors (ODbL) · Donostiako Udala / Ayuntamiento de San Sebastián, auzoak (CC BY-SA 3.0)\n' +
  '// names: [Basque, Spanish?]; ways: [name index, road class 0-5, x0, z0, x1, z1, ...] in whole local metres;\n' +
  '// districts & places: rings as flat [x0, z0, x1, z1, ...]\n' +
  `export const STREETS = ${JSON.stringify(STREETS)};\n`;
fs.writeFileSync(OUT_JS, js);
log(`${path.relative(ROOT, OUT_JS)}: ${(js.length / 1024).toFixed(0)} KB`);
