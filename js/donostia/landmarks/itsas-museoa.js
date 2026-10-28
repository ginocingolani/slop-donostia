import * as THREE from 'three/webgpu';
import { vec3, clamp, mix, step, smoothstep, fract, uv, positionWorld } from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { URGULL_PARTS } from '../data-urgull-parts.js';
import { Parts, wound, cleanRing, insetRing, simplify, hipRoof, pointInRing, distToRing } from './geom.js';
import { gridLine } from './kit.js';

// js/donostia/landmarks/itsas-museoa.js
// Euskal Itsas Museoa (Naval Museum, the 18th-c. Consulado building on the old port: stone & white render, pitched
// roofs) and the Aquarium (the 1928 pavilion at the end of the port by the Paseo Nuevo and its extensions: sandstone and
// grey stone under terraces).
//
// build(sites, ctx) receives the GEO.landmarks entries ['itsas-museoa', 'aquariuma'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings` (and in the model's userData.hide), except those of the sites it lists in
// userData.skipped.
//
// The museum follows OpenStreetMap's building parts (js/donostia/data-urgull-parts.js): the long white block on the
// quay with its tiled roof (14.5 m to the ridge), six dormers on the slope over the port, the square tower at the east
// end under a pyramid roof (18 m), the lower wings at the north-west corner; heights above the quay, which agree with
// b5m's LiDAR (ridge ~19 m above sea level). The Aquarium (Sociedad Oceanográfica de Gipuzkoa, 1928) is OSM's point on
// the 1:500 outline of the Oceanographic Society's building, the whole complex built into the slope under terraces at the
// Paseo Nuevo's level (~17 m): its faces where the ground falls away, the pavilion's front facing the square at the end
// of the port over the terrace before its door (8.5 m).

const PARTS = URGULL_PARTS['itsas-museoa'];
const MAIN = 1510701167, TOWER = 1510701166;
const DORMERS = new Set([1510701158, 1510701159, 1510701160, 1510701161, 1510701162, 1510701163]);
const TOWER_ROOF = 1.5; // OSM's roof part over the tower: 18 m with a 1.5 m pyramid

// --- local helpers ----------------------------------------------------------------------------------------------------

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

// Box of size (w, h, d) whose base centre stands at (x, y, z), its width along the direction (ux, uz)
function box(w, h, d, x, y, z, ux = 1, uz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g.applyMatrix4(_m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, -Math.atan2(uz, ux), 0)), _s));
}

// Lowest ground along a ring's walls, sampled every metre rather than only at the corners (the Aquarium's end stands
// on the cliff over the harbour mouth)
function lowestAlong(ctx, ring, step = 1) {
  let min = Infinity;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * q], bz = ring[2 * q + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / step));
    for (let j = 0; j < k; j++) min = Math.min(min, ctx.kit.groundAt(ctx, ax + ((bx - ax) * j) / k, az + ((bz - az) * j) / k));
  }
  return Number.isFinite(min) ? min : 0;
}

// deterministic per-window draw for the lit-room pattern
function hash(i) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

// --- materials --------------------------------------------------------------------------------------------------------

// Window glass: dark by day, some rooms lit warm at dusk and night. uv.x carries each window's random draw (the share
// of lit rooms follows the interior-glow uniform as in js/donostia/buildings.js).
function windowMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.16, metalness: 0.3 });
  const draw = uv().x;
  mat.colorNode = vec3(0.05, 0.065, 0.08);
  const litShare = clamp(cityUniforms.uInteriorGlow.mul(0.42), 0.0, 0.8);
  const lit = step(draw, litShare);
  const warm = mix(vec3(1.0, 0.72, 0.42), vec3(0.95, 0.85, 0.7), fract(draw.mul(13.1)));
  // (no lit rooms in full daylight, unlike the city's blocks: these are museums, closed by then)
  const evening = smoothstep(0.3, 0.6, cityUniforms.uInteriorGlow);
  mat.emissiveNode = warm.mul(lit.mul(cityUniforms.uInteriorGlow).mul(evening).mul(1.4));
  return mat;
}

// The Aquarium extensions' cladding: grey stone slabs in courses of 0.6 m
function greyStoneMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75 });
  const base = vec3(0.4, 0.41, 0.4);
  mat.colorNode = mix(base, base.mul(0.7), gridLine(positionWorld.y, 0.6, 0.008));
  return mat;
}

// --- shared pieces ---------------------------------------------------------------------------------------------------

// Windows with stone surrounds along a ring's long walls, one row per storey sill height in `sills`, skipping any that
// would sit below the ground outside
function addWindows(parts, mats, ctx, ring, sills, { w = 1.3, h = 2.0, bay = 3.4, minWall = 4.5, seed = 0 } = {}) {
  const r = wound(simplify(ring, 0.3)); // whole walls, not the stubs between OSM's dormer & tower nodes
  let k = seed;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < minWall) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len, ox = uz, oz = -ux;
    const count = Math.max(1, Math.floor((len - 1.2) / bay));
    const step0 = len / count;
    for (let c = 0; c < count; c++) {
      const t = (c + 0.5) * step0;
      const x = ax + ux * t, z = az + uz * t;
      const outside = ctx.kit.groundAt(ctx, x + ox * 1.5, z + oz * 1.5);
      for (const sill of sills) {
        if (sill < outside + 0.5) continue;
        const pane = box(w, h, 0.2, x + ox * 0.08, sill, z + oz * 0.08, ux, uz);
        const draw = hash(++k * 7 + 3);
        pane.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pane.attributes.position.count * 2).fill(draw), 2));
        parts.add(mats.window, pane);
        parts.add(mats.stone, box(w + 0.45, h + 0.45, 0.14, x + ox * 0.03, sill - 0.25, z + oz * 0.03, ux, uz));
      }
    }
  }
}

// A building block: render walls on a stone plinth, a stone cornice, an overhanging tiled hip roof
function block(parts, mats, ctx, ring, ground, eave, rise, { plinth = 1.2, cornice = true } = {}) {
  const r = wound(ring);
  const foot = Math.min(ground, lowestAlong(ctx, r)) - 0.6;
  parts.add(mats.render, ctx.kit.prism(r, foot, eave));
  const sock = insetRing(r, -0.08);
  if (sock && plinth > 0) parts.add(mats.stone, ctx.kit.prism(sock, foot, ground + plinth));
  const band = insetRing(r, -0.22);
  if (cornice && band) parts.add(mats.stone, ctx.kit.prism(band, eave - 0.45, eave));
  if (rise > 0) {
    const eaves = insetRing(r, -0.45) || r;
    parts.add(mats.tiles, hipRoof(eaves, eave, rise, ctx.kit.orientedBox(r).width * 0.5));
  }
}

// --- the Naval Museum --------------------------------------------------------------------------------------------------

function buildMuseum(parts, mats, ctx) {
  if (!PARTS?.parts.length) return false;
  const byId = new Map(PARTS.parts.map((p) => [p.osm, p]));
  const main = byId.get(MAIN);
  if (!main) return false;
  const g0 = ctx.kit.lowestGround(ctx, main.ring); // the quay: OSM heights are measured from here
  const mainEave = g0 + main.height - (main.roofHeight || 2.5);
  for (const p of PARTS.parts) {
    if (p.kind === 'roof' || !p.height) continue;
    const ring = cleanRing(p.ring);
    if (DORMERS.has(p.osm)) {
      // dormers breaking the main roof's slope over the port
      parts.add(mats.render, ctx.kit.prism(ring, mainEave - 0.6, g0 + p.height - (p.roofHeight || 0.4)));
      parts.add(mats.tiles, hipRoof(insetRing(wound(ring), -0.15) || ring, g0 + p.height - (p.roofHeight || 0.4), 0.55, 0.9));
      continue;
    }
    if (p.kind === 'steps' || p.height < 3) {
      parts.add(mats.stone, ctx.kit.prism(ring, g0 - 0.6, g0 + p.height));
      continue;
    }
    if (p.osm === TOWER) {
      block(parts, mats, ctx, ring, g0, g0 + p.height, TOWER_ROOF);
      continue;
    }
    const rise = p.roofHeight || 0;
    block(parts, mats, ctx, ring, g0, g0 + p.height - rise, rise);
  }
  // three storeys of windows, those on the uphill side only where they clear the ground
  addWindows(parts, mats, ctx, cleanRing(main.ring), [g0 + 1.0, g0 + 4.9, g0 + 8.4], { w: 1.25, h: 2.1, bay: 3.3 });
  const tower = byId.get(TOWER);
  if (tower) addWindows(parts, mats, ctx, cleanRing(tower.ring), [g0 + 12.4], { w: 0.9, h: 1.6, bay: 2.4, minWall: 3, seed: 400 });
  return true;
}

// --- the Aquarium --------------------------------------------------------------------------------------------------------

// The 1:500 building under the Aquarium's OSM point: the Oceanographic Society's, else the nearest within a few metres
function aquariumBuilding(GEO, at) {
  let best = -1, bestD = 4;
  GEO.buildings.forEach((b, i) => {
    const r = b.g[0];
    const d = pointInRing(at[0], at[1], r) ? 0 : distToRing(at[0], at[1], r);
    const named = /ozeanografi|aquarium/i.test(b.name || '');
    const score = named ? d - 3 : d;
    if (score < bestD) { bestD = score; best = i; }
  });
  return best;
}

// The faces of the Oceanographic Society's outline: the whole complex, the 1928 pavilion at its east end and the
// extensions behind it, built into the slope at the end of the port under terraces at the Paseo Nuevo's level, which the
// LiDAR keeps as ground (tools/donostia/build.mjs steps the terrain at the outline: GEO.terrain.walls). A face stands
// along the outline wherever the ground falls away outside it, from that ground up to the terrace, a glass railing on
// top; the pavilion's, PAVILION m deep from its front, in sandstone ashlar under deep maroon eaves on paired carved
// brackets, with two storeys of windows round its arched door and the blue AQVARIVM sign along its roof; the rest in
// the extensions' grey stone. (Read off Wikimedia Commons photographs of the Aquarium, its category.)
const PAVILION = 16; // m: the 1928 pavilion's depth behind its front
const FACE_DROP = 1.2; // m the ground falls outside the outline where a face stands
const FACE = 0.35; // m: the faces' thickness, outside the outline (the terrain's step lies just inside it)

// Returns the index of the 1:500 building the Aquarium replaces, or -1
function buildAquarium(parts, mats, ctx, site) {
  const { GEO, kit } = ctx;
  const idx = aquariumBuilding(GEO, site.at);
  if (idx < 0) return -1;
  const b = GEO.buildings[idx];
  const r = wound(simplify(cleanRing(b.g[0]), 0.3));
  const n = r.length / 2;
  const ground = (x, z) => kit.groundAt(ctx, x, z);

  // the front: the end of the long axis on the side of OSM's point, the edge (6 m or more) facing it most squarely
  const axis = kit.orientedBox(r);
  let ex = Math.cos(axis.angle), ez = Math.sin(axis.angle);
  if ((site.at[0] - axis.x) * ex + (site.at[1] - axis.z) * ez < 0) { ex = -ex; ez = -ez; }
  const edges = [];
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.3) continue;
    const ux = (bx - ax) / len, uz = (bz - az) / len;
    let ox = uz, oz = -ux; // outwards
    if (pointInRing((ax + bx) / 2 + ox * 0.3, (az + bz) / 2 + oz * 0.3, r)) { ox = -ox; oz = -oz; }
    edges.push({ ax, az, bx, bz, len, ux, uz, ox, oz, facing: ox * ex + oz * ez });
  }
  const front = edges.filter((e) => e.len >= 6).reduce((best, e) => (!best || e.facing > best.facing ? e : best), null);
  if (!front) return -1;
  // how far a point lies behind the front: the pavilion is the outline's first PAVILION m
  const depth = (x, z) => (front.ax - x) * front.ox + (front.az - z) * front.oz;

  // the faces: runs along each edge (1 m steps) where the ground outside lies FACE_DROP or more under the terrace inside
  let terrace = -Infinity; // the pavilion's roof: the terrace over its front
  for (const e of edges) {
    const steps = Math.max(1, Math.round(e.len));
    let run = null;
    const flush = () => {
      if (!run) return;
      const { s0, s1, top, bottom } = run;
      const L = s1 - s0, mx = e.ax + e.ux * (s0 + L / 2), mz = e.az + e.uz * (s0 + L / 2);
      const stone = depth(mx, mz) < PAVILION ? mats.stone : mats.grey;
      const fx = mx + e.ox * FACE / 2, fz = mz + e.oz * FACE / 2;
      parts.add(stone, box(L + FACE, top - bottom, FACE, fx, bottom, fz, e.ux, e.uz));
      // a coping, and the glass railing on it
      parts.add(stone, box(L + FACE + 0.1, 0.2, FACE + 0.15, fx, top, fz, e.ux, e.uz));
      const rail = box(L, 1.0, 0.04, mx + e.ox * 0.12, top + 0.2, mz + e.oz * 0.12, e.ux, e.uz);
      rail.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(rail.attributes.position.count * 2).fill(0.99), 2));
      parts.add(mats.glass, rail);
      if (e === front) terrace = Math.max(terrace, top);
      run = null;
    };
    for (let k = 0; k <= steps; k++) {
      const s = (e.len * k) / steps, x = e.ax + e.ux * s, z = e.az + e.uz * s;
      const inside = Math.max(ground(x - e.ox * 2.5, z - e.oz * 2.5), ground(x - e.ox * 4, z - e.oz * 4));
      const outside = Math.min(ground(x + e.ox, z + e.oz), ground(x + e.ox * 2.5, z + e.oz * 2.5), ground(x + e.ox * 4, z + e.oz * 4));
      if (inside - outside < FACE_DROP) { flush(); continue; }
      if (!run) run = { s0: s, s1: s, top: inside, bottom: outside - 0.6 };
      run.s1 = s;
      run.top = Math.max(run.top, inside);
      run.bottom = Math.min(run.bottom, outside - 0.6);
    }
    flush();
  }
  if (!Number.isFinite(terrace)) return -1;

  // the pavilion's eaves: a deep maroon fascia along its front and its sides, 1.3 m out, on paired brackets
  const eave = terrace - 0.7;
  for (const e of edges) {
    if (e !== front && Math.abs(e.facing) > 0.5) continue;
    // (the stretch of the edge within the pavilion's depth)
    const d0 = depth(e.ax, e.az), d1 = depth(e.bx, e.bz);
    if (Math.min(d0, d1) > PAVILION) continue;
    const t0 = d0 <= PAVILION ? 0 : (d0 - PAVILION) / (d0 - d1), t1 = d1 <= PAVILION ? 1 : (PAVILION - d0) / (d1 - d0);
    const from = e.len * Math.min(t0, t1), L = e.len * Math.abs(t1 - t0);
    if (L < 1) continue;
    const mx = e.ax + e.ux * (from + L / 2), mz = e.az + e.uz * (from + L / 2);
    parts.add(mats.maroon, box(L + 1.3, 0.45, 1.3, mx + e.ox * 0.65, eave, mz + e.oz * 0.65, e.ux, e.uz));
    const pairs = Math.max(1, Math.floor(L / 3.6));
    for (let k = 0; k < pairs; k++) {
      const s = from + (L * (k + 0.5)) / pairs;
      for (const off of [-0.22, 0.22]) {
        const bx = e.ax + e.ux * (s + off) + e.ox * 0.45, bz = e.az + e.uz * (s + off) + e.oz * 0.45;
        parts.add(mats.maroon, box(0.9, 1.3, 0.2, bx, eave - 1.3, bz, e.ox, e.oz));
      }
    }
  }

  // the front: the blue sign over the eaves, two storeys of windows in maroon frames round the arched door
  const { ax, az, len, ux, uz, ox, oz } = front;
  const at = (d, s = 0) => [ax + ux * (len / 2 + s) + ox * d, az + uz * (len / 2 + s) + oz * d];
  const base = Math.max(ground(...at(3)), ground(...at(5)));
  const signW = Math.min(len - 1.5, 13), [sx, sz] = at(0.2);
  parts.add(mats.sign, box(signW, 1.15, 0.15, sx, terrace - 0.05, sz, ux, uz));
  const letters = 8, pitch = (signW - 1) / letters, [lx, lz] = at(0.3);
  for (let k = 0; k < letters; k++) {
    const s = -signW / 2 + 0.5 + pitch * (k + 0.5);
    parts.add(mats.letters, box(pitch * 0.62, 0.72, 0.05, lx + ux * s, terrace + 0.16, lz + uz * s, ux, uz));
  }
  const storey = (eave - 1.3 - base) / 2;
  let draw = 900;
  for (const [h, sill] of [[2.0, base + 1.0], [1.6, base + storey + 0.9]]) {
    for (const s of [-0.36, -0.2, 0.2, 0.36].map((f) => f * len)) {
      const [wx, wz] = at(FACE + 0.02, s);
      parts.add(mats.maroon, box(1.5, h + 0.3, 0.08, wx, sill - 0.15, wz, ux, uz));
      const pane = box(1.2, h, 0.08, wx + ox * 0.03, sill, wz + oz * 0.03, ux, uz);
      pane.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(pane.attributes.position.count * 2).fill(hash(++draw)), 2));
      parts.add(mats.window, pane);
    }
  }
  const [dx, dz] = at(FACE + 0.02);
  parts.add(mats.stone, box(3.4, 4.2, 0.3, dx, base, dz, ux, uz));
  parts.add(mats.door, box(1.7, 3.0, 0.3, dx + ox * 0.03, base, dz + oz * 0.03, ux, uz));
  // (the site is an OSM point, so build.mjs found no 1:500 building under it: build() names this one in
  // userData.hide)
  return idx;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { kit } = ctx;
  const glass = windowMaterial();
  const mats = {
    render: kit.materials.whiteRender, stone: kit.materials.sandstone, tiles: kit.materials.terracotta, window: glass,
    // the Aquarium's: the extensions' grey stone, the pavilion's maroon woodwork (its door too), its sign, the letters
    // on it in the museum's white, the railings in the windows' glass
    grey: greyStoneMaterial(), maroon: new THREE.MeshStandardNodeMaterial({ color: 0x5b1f2b, roughness: 0.55 }),
    sign: new THREE.MeshStandardNodeMaterial({ color: 0x223c78, roughness: 0.4, metalness: 0.1 }),
    letters: kit.materials.whiteRender, glass, door: null
  };
  mats.door = mats.maroon;
  const parts = new Parts();
  const hide = [], skipped = [];
  for (const site of sites) {
    // one failing building shouldn't take the other down with it: its pieces are dropped and its plain extrusion stays
    const mark = parts.mark();
    let ok = false;
    try {
      if (site.id === 'itsas-museoa') ok = buildMuseum(parts, mats, ctx);
      else if (site.id === 'aquariuma' && site.at) {
        const idx = buildAquarium(parts, mats, ctx, site);
        if (idx >= 0) {
          hide.push(idx);
          ok = true;
        }
      }
    } catch (e) {
      console.warn(`[landmark ${site.id}]`, e);
    }
    if (!ok) {
      parts.rollback(mark);
      skipped.push(site.id);
    }
  }
  if (skipped.length === sites.length) return null;
  const model = parts.build('itsas-museoa');
  Object.assign(model.userData, { hide, skipped });
  return model;
}
