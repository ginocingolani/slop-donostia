// tools/donostia/bake-seamarks.mjs
// usage: node tools/donostia/bake-seamarks.mjs
// Bakes the aids to navigation behind js/donostia/seamarks.js into js/donostia/data-seamarks.js: every light over the
// terrain's context grid (Igeldo's and Santa Klara's lighthouses, La Concha's leading lights, the lights on the port's
// pierheads, the buoys off Ulía), with its place in the local frame, its colour and character as the times within its
// period that it shows, its range, any sectors, and what carries it (a lighthouse's lantern, a post, a column, a buoy).
//
// Sources:
//   - OpenStreetMap's seamark tags (tools/donostia/data/osm_seamarks.json, queries/seamarks.overpassql; © OpenStreetMap
//     contributors, ODbL): positions, characters, ranges and the Admiralty numbers (D ...) of every light;
//   - NGA Pub. 113, List of Lights, Radio Aids and Fog Signals (2019 edition, corrected to Notice to Mariners 26/2019;
//     U.S. Government work, no copyright claimed): nos. 1788-1800, San Sebastián. Its figures win where the two
//     disagree (OFFICIAL below); it lists neither the port's two lights nor the buoys, which OSM alone gives.
// Not consulted, out of reach when this was written (October 2026): the Instituto Hidrográfico de la Marina's "Faros y
// señales de niebla, Parte I" (publicaciones.defensa.gob.es refused the connection), the Autoridad Portuaria de
// Pasaia's own list (its site did not resolve) and the Admiralty List of Lights (not openly published). The INE's
// 2001 yearbook (table 1.6, from Puertos del Estado) agrees on Igeldo: 43° 19' 18" N 2° 00' 42" W, "grupos de 1 y 2
// destellos, 15 s", 134 m.
//
// Disagreements, and what is followed:
//   - Santa Klara: js/donostia/landmarks/santa-klara.js flashed for 0.7 s; Pub. 113 and OSM give 1 s (followed).
//   - Igeldo's elevation: 134 m in Pub. 113, OSM and the INE; es.wikipedia gives 130 m, and the LiDAR ground under the
//     lighthouse (116.7 m) plus its 13 m tower (Pub. 113: 42 ft) puts the lantern at about 130 m. The light stands at
//     the lantern of igeldo.js's model (129.6 m), as it does at Santa Klara's (53.7 m, the lists' 53 m).
//   - La Concha's leading lights: OSM's sectors (158°-158° and 158°-158.5°) are the leading line's bearing, not
//     visibility sectors, and Pub. 113 gives none: both show all round. Their elevations (12 m and 18 m) sit 2.4 and
//     1.4 m under the tops of the posts Pub. 113 describes (16 ft and 30 ft) set on the LiDAR's promenade (9.5 m) and
//     pavement (10.3 m) across the road, about the height of high water above mean sea level: elevations above high
//     water, the Admiralty's datum. The lanterns go on top of the posts.
//   - The port's lights (D 1485, D 1486): OSM gives Fl(2) 8 s without the flashes' lengths, and no elevation for the
//     red one. Assumed: 0.5 s flashes 1.5 s apart, as Pasaia's Fl(2) lights in Pub. 113, and the green one's 9 m.
//   - La Concha's front light: Q (quick, 60 a minute) with no flash length in either source; 0.3 s assumed.
//   - Pasaia's fairway buoy: Mo(A) W 7 s with no elevation in OSM; 4 m assumed (the Mompás buoy's 5 m less its
//     radar reflector's frame). It lies 69 m north of the context grid, on the open sea that the water plane covers.
//   - Positions: OSM's agree with Pub. 113's (given to 0.1') within its rounding; the leading line runs 157.6° from the
//     front light to the rear one (Pub. 113: "about 25 meters 158° from front"; OSM's posts are 24.4 m apart).
// No light stands on the Zurriola dike or at the Urumea's mouth in either source, nor on Urgull.
//
// Output (js/donostia/data-seamarks.js), SEAMARKS: one record per light: ref (Admiralty number, else the Spanish
// national one), name, osm (node id), x & z (local frame, m), height (m above the sea: the published elevation, or the
// assumed one), mount ({ kind: 'lighthouse', landmark } | { kind: 'post', height } | { kind: 'column', colour } |
// { kind: 'buoy', ... }), colour ('white' | 'red' | 'green' | 'yellow'), char (as charted), period (s), on (flat
// [start, end, ...] s into the period: when it shows), phase (s, a fixed offset of its own so lights don't flash in
// step), range (nautical miles), sector ([from, to] true bearings from seaward, clockwise) or null, rotating (a
// revolving optic: its flashes sweep round, so each bearing sees them at its own moment).
//
// Data © OpenStreetMap contributors (ODbL), like the rest of the derived data.

import fs from 'node:fs';
import path from 'node:path';
import { HERE, FRAME, loadLayer, lonLatToLocal, licenceComment, log } from './lib.mjs';

const OUT = path.join(HERE, '../../js/donostia/data-seamarks.js');
const r2 = (v) => Math.round(v * 100) / 100;
const FT = 0.3048;

// NGA Pub. 113 (2019), San Sebastián: no., character, rhythm (flash+(eclipse)...), elevation (m), range (nm), structure
const OFFICIAL = {
  'D 1483': { no: 1788, name: 'Igueldo', char: 'Fl(2+1) W 15s', sequence: '0.4+(1.8)+0.4+(6)+0.4+(6)', height: 134, range: 26,
    structure: 'White cylindrical tower, dwelling; 42 ft' },
  'D 1482': { no: 1792, name: 'Isla de Santa Clara', char: 'Fl W 5s', sequence: '1+(4)', height: 53, range: 9, structure: 'White cylindrical tower, dwelling; 33 ft' },
  'D 1484': { no: 1796, name: 'La Concha range, front', char: 'Q R', height: 12, range: 7, structure: 'Gray post; 16 ft' },
  'D 1484.1': { no: 1800, name: 'La Concha range, rear', char: 'Oc R 4s', sequence: '3+(1)', height: 18, range: 7, structure: 'Gray post; 30 ft' }
};

// What OSM and Pub. 113 leave out (see the header): rhythms, elevations, a name
const ASSUMED = {
  'D 1484': { sequence: '0.3+(0.7)' },
  'D 1485': { sequence: '0.5+(1.5)+0.5+(5.5)' },
  'D 1486': { name: 'Port entrance, west pierhead', sequence: '0.5+(1.5)+0.5+(5.5)', height: 9 },
  '00125': { height: 4 }
};

// What carries each light. The lighthouses' lanterns are their landmark models' (js/donostia/landmarks/), which report
// where their focal planes are; the posts' heights are Pub. 113's; the pierheads' columns rise to the light.
const MOUNTS = {
  'D 1483': { kind: 'lighthouse', landmark: 'igeldo-itsasargia' },
  'D 1482': { kind: 'lighthouse', landmark: 'santa-klara-itsasargia' },
  'D 1484': { kind: 'post', height: r2(16 * FT) },
  'D 1484.1': { kind: 'post', height: r2(30 * FT) }
};
// Revolving optics: Igeldo's lens turns (its beams sweep the night, js/donostia/landmarks/igeldo.js); the others are
// lanterns that flash in place
const ROTATING = new Set(['D 1483']);

const COLOURS = new Set(['white', 'red', 'green', 'yellow']);
const ABBR = { white: 'W', red: 'R', green: 'G', yellow: 'Y' };

// The tags of each light on an element: seamark:light:* or, for a sectored one, seamark:light:1:*, :2:*...
function lightTags(tags) {
  const lights = new Map();
  for (const [k, v] of Object.entries(tags)) {
    const m = k.match(/^seamark:light:(?:(\d+):)?(.+)$/);
    if (!m || m[2] === 'reference') continue;
    const n = m[1] || '0';
    if (!lights.has(n)) lights.set(n, {});
    lights.get(n)[m[2]] = v;
  }
  return [...lights.values()].filter((l) => l.character);
}

// "0.4+(1.8)+0.4+(6)" (lights and (eclipses)), or "0.5+0.5+1.5+4.5" (alternating, light first) -> [[on, off], ...]
function parseSequence(s) {
  if (!s || !/^[\d.+()\s]+$/.test(s)) return null;
  const parts = s.split('+').map((p) => p.trim()).filter(Boolean);
  const bracketed = parts.some((p) => p.startsWith('('));
  const steps = [];
  for (let i = 0; i < parts.length; i++) {
    const off = bracketed ? parts[i].startsWith('(') : i % 2 === 1;
    const d = Number(parts[i].replace(/[()]/g, ''));
    if (!(d > 0)) return null;
    steps.push([off, d]);
  }
  return steps;
}

// The on-times within the period, as a flat [start, end, ...]; light first. Throws when the rhythm and the period
// disagree.
function schedule(steps, period, ref) {
  const on = [];
  let t = 0;
  for (const [off, d] of steps) {
    if (!off) on.push(r2(t), r2(t + d));
    t += d;
  }
  if (Math.abs(t - period) > 0.01) throw new Error(`${ref}: the rhythm lasts ${t} s, the period ${period} s`);
  if (on.length > 8) throw new Error(`${ref}: more than 4 flashes in a period (seamarks.js takes 4)`);
  return on;
}

// A fixed phase for a light from its reference, so that two lights of one period don't flash in step
function phaseOf(ref, period) {
  let h = 2166136261;
  for (const c of ref) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  return r2((h / 2 ** 32) * period);
}

const osm = loadLayer('osm_seamarks.json');
const { minX, maxX, minZ, maxZ } = FRAME.core;
const context = JSON.parse(fs.readFileSync(path.join(HERE, '../../js/donostia/geodata.js'), 'utf8')
  .match(/"context":(\{"minX"[^}]+\})/)[1]);
const lights = [];
for (const e of osm.elements) {
  const tags = e.tags || {};
  const found = lightTags(tags);
  if (!found.length) continue;
  const [x, z] = e.type === 'node' ? lonLatToLocal(e.lon, e.lat) : lonLatToLocal(e.center.lon, e.center.lat);
  // the query's box is the context grid's in lon/lat: a little wider at its corners
  if (x < context.minX - 150 || x > context.maxX + 150 || z < context.minZ - 150 || z > context.maxZ + 150) continue;
  const refs = (tags['seamark:light:reference'] || '').split('/').map((s) => s.trim().replace(/^D[-\s]*/, 'D '));
  const ref = refs.find((r) => r.startsWith('D ')) || refs[0];
  if (!ref) throw new Error(`OSM ${e.type} ${e.id}: a light with no reference`);
  if (found.length > 1) throw new Error(`${ref}: sectored lights of several characters are not handled`);
  const l = found[0];
  const off = OFFICIAL[ref] || {}, guess = ASSUMED[ref] || {};
  const colour = l.colour;
  if (!COLOURS.has(colour)) throw new Error(`${ref}: colour ${colour}`);
  const period = Number(l.period) || (l.character === 'Q' ? 1 : NaN);
  const steps = parseSequence(off.sequence) || parseSequence(l.sequence) || parseSequence(guess.sequence);
  if (!steps) throw new Error(`${ref}: no rhythm for ${l.character} ${l.period} s`);
  const osmSteps = parseSequence(l.sequence);
  if (off.sequence && osmSteps && JSON.stringify(osmSteps) !== JSON.stringify(parseSequence(off.sequence))) {
    log(`${ref}: OSM's rhythm ${l.sequence} differs from Pub. 113's ${off.sequence} (followed)`);
  }
  const height = off.height ?? (l.height ? Number(l.height) : guess.height);
  if (!(height > 0)) throw new Error(`${ref}: no elevation`);
  if (off.height && l.height && Number(l.height) !== off.height) log(`${ref}: OSM's elevation ${l.height} m, Pub. 113's ${off.height} m (followed)`);
  const range = off.range ?? Number(l.range);
  if (off.range && l.range && Number(l.range) !== off.range) log(`${ref}: OSM's range ${l.range} nm, Pub. 113's ${off.range} nm (followed)`);
  // a leading light's sector tags give the leading line, not where it shows
  const leading = /^(upper|lower|leading|front|rear)$/.test(l.category || '');
  const sector = !leading && l.sector_start != null && l.sector_end != null && Number(l.sector_start) !== Number(l.sector_end)
    ? [Number(l.sector_start), Number(l.sector_end)] : null;
  // the carrier: a lighthouse or post as above, a lateral beacon's column, a buoy's pillar
  const type = tags['seamark:type'];
  let mount = MOUNTS[ref];
  if (!mount && type.startsWith('beacon_')) mount = { kind: 'column', colour: tags[`seamark:${type}:colour`] || colour };
  if (!mount && type.startsWith('buoy_')) {
    mount = {
      kind: 'buoy', shape: tags[`seamark:${type}:shape`] || 'pillar',
      colours: (tags[`seamark:${type}:colour`] || colour).split(';'),
      pattern: tags[`seamark:${type}:colour_pattern`] || null,
      topmark: tags['seamark:topmark:shape'] || null, topmarkColour: tags['seamark:topmark:colour'] || null
    };
  }
  if (!mount) throw new Error(`${ref}: nothing to carry it (${type})`);
  const group = l.group && l.group !== '1' ? `(${l.group})` : '';
  const char = off.char || `${l.character}${group} ${ABBR[colour]}${l.character === 'Q' ? '' : ` ${period}s`}`;
  const name = off.name || guess.name || tags['seamark:name'] || tags.name || ref;
  lights.push({
    ref, name, osm: e.id, x: r2(x), z: r2(z), height, mount, colour, char, period,
    on: schedule(steps, period, ref), phase: phaseOf(ref, period), range, sector, rotating: ROTATING.has(ref),
    core: x >= minX && x <= maxX && z >= minZ && z <= maxZ
  });
}
lights.sort((a, b) => a.ref.localeCompare(b.ref, 'en', { numeric: true }));
for (const ref of Object.keys(OFFICIAL)) if (!lights.some((l) => l.ref === ref)) throw new Error(`${ref} (Pub. 113) is missing from OSM`);

const js = `// js/donostia/data-seamarks.js — generated by tools/donostia/bake-seamarks.mjs, do not edit.
// The aids to navigation over the terrain's context grid: lights, their characters and carriers (local frame, m; s).
// © OpenStreetMap contributors (ODbL), checked against NGA Pub. 113, List of Lights (2019; U.S. Government work).
${licenceComment('osm')}export const SEAMARKS = ${JSON.stringify(lights)};
`;
fs.writeFileSync(OUT, js);
log(`${path.relative(path.join(HERE, '../..'), OUT)}: ${lights.length} lights (${lights.filter((l) => l.core).length} in the core): ` +
  lights.map((l) => `${l.ref} ${l.char}`).join(', '));
