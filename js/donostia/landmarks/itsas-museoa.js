import * as THREE from 'three/webgpu';
import { vec3, clamp, mix, step, smoothstep, fract, uv } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';
import { URGULL_PARTS } from '../data-urgull-parts.js';

// js/donostia/landmarks/itsas-museoa.js
// Euskal Itsas Museoa (Naval Museum, the 18th-c. Consulado building on the old port) and the Aquarium (1928 pavilion at the end of the port by the Paseo Nuevo): stone & white render, pitched roofs.
//
// build(sites, ctx) receives the GEO.landmarks entries ['itsas-museoa', 'aquariuma'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// The museum follows OpenStreetMap's building parts (js/donostia/data-urgull-parts.js): the long white block on the
// quay with its tiled roof (14.5 m to the ridge), six dormers on the slope over the port, the square tower at the east
// end under a pyramid roof (18 m), the lower wings at the north-west corner; heights above the quay, which agree with
// b5m's LiDAR (ridge ~19 m above sea level). The Aquarium (Sociedad Oceanográfica de Gipuzkoa, 1928) is OSM's point on
// the 1:500 outline of the Oceanographic Society's building: one storey above the Paseo Nuevo, two more down to the port,
// under a hip roof (b5m: roof ~20-24 m above sea level), its entrance front facing the square at the end of the port.

const PARTS = URGULL_PARTS['itsas-museoa'];
const MAIN = 1510701167, TOWER = 1510701166;
const DORMERS = new Set([1510701158, 1510701159, 1510701160, 1510701161, 1510701162, 1510701163]);
const TOWER_ROOF = 1.5; // OSM's roof part over the tower: 18 m with a 1.5 m pyramid

// --- small geometry kit (kept local so each landmark module stands alone) ------------------------------------------------

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();
const _v = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1);

// Pieces collected per material and merged into one mesh each: one draw call per material
class Parts {
  constructor() { this.byMaterial = new Map(); }

  add(material, geometry) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (!this.byMaterial.has(material)) this.byMaterial.set(material, []);
    this.byMaterial.get(material).push(g);
  }

  build(name) {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, list] of this.byMaterial) {
      const geometry = mergeGeometries(list);
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }
}

// Box of size (w, h, d) whose base centre stands at (x, y, z), its width along the direction (ux, uz)
function box(w, h, d, x, y, z, ux = 1, uz = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, h / 2, 0);
  return g.applyMatrix4(_m.compose(_v.set(x, y, z), _q.setFromEuler(_e.set(0, -Math.atan2(uz, ux), 0)), _s));
}

function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

// Ring wound so edge normals (dz, -dx) point out of the solid. From wound() in js/donostia/buildings.js.
function wound(r) {
  if (signedArea(r) > 0) return r;
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
}

// Drops near-duplicate neighbours and a closing vertex that repeats the first
function cleanRing(r) {
  const out = [];
  for (let k = 0; k < r.length; k += 2) {
    const n = out.length;
    if (n && Math.hypot(r[k] - out[n - 2], r[k + 1] - out[n - 1]) < 0.05) continue;
    out.push(r[k], r[k + 1]);
  }
  while (out.length > 6 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 0.05) out.length -= 2;
  return out;
}

// Miter offset of a ring by d towards its inside (negative d grows it); null when an edge flips or the ring collapses.
// From insetRing() in js/donostia/buildings.js.
function insetRing(r, d) {
  const n = r.length / 2;
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let ax = r[2 * i] - r[2 * p], az = r[2 * i + 1] - r[2 * p + 1];
    let bx = r[2 * q] - r[2 * i], bz = r[2 * q + 1] - r[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx;
    const denom = 1 + (n1x * n2x + n1z * n2z);
    if (denom < 0.25) return null;
    out[2 * i] = r[2 * i] + (d * (n1x + n2x)) / denom;
    out[2 * i + 1] = r[2 * i + 1] + (d * (n1z + n2z)) / denom;
  }
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ox = r[2 * q] - r[2 * i], oz = r[2 * q + 1] - r[2 * i + 1];
    const nx = out[2 * q] - out[2 * i], nz = out[2 * q + 1] - out[2 * i + 1];
    if (ox * nx + oz * nz <= 0) return null;
  }
  const a0 = signedArea(r), a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.02 * Math.abs(a0)) return null;
  return out;
}

// Drops vertices closer than tol to the line through their neighbours (near-collinear runs and tiny jogs), which
// would otherwise flip under the large insets of a hip roof
function simplify(r, tol = 0.35) {
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push([r[k], r[k + 1]]);
  for (let changed = true; changed && pts.length > 4;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 4; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      if (Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / (Math.hypot(dx, dz) || 1e-9) < tol) {
        pts.splice(i--, 1);
        changed = true;
      }
    }
  }
  return pts.flat();
}

// Hip roof over a ring: slopes rising `rise` from the eaves to a ridge (an inset of about half the ring's width)
function hipRoof(ring, eave, rise, inset) {
  const r = wound(simplify(ring));
  const pos = [], nrm = [];
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    for (const p of [a, b, c]) { pos.push(...p); nrm.push(nx / l, ny / l, nz / l); }
  };
  const cap = (ring2, y) => {
    const pts = [];
    for (let k = 0; k < ring2.length; k += 2) pts.push(new THREE.Vector2(ring2[k], ring2[k + 1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      tri([pts[a].x, y, pts[a].y], [pts[b].x, y, pts[b].y], [pts[c].x, y, pts[c].y]);
    }
  };
  let inner = null;
  for (let d = inset, k = 0; k < 8 && !inner; k++, d *= 0.8) inner = insetRing(r, d);
  if (!inner) cap(r, eave + 0.08); // flat, just over the walls' top
  else {
    const top = eave + rise;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const o0 = [r[2 * i], eave, r[2 * i + 1]], o1 = [r[2 * q], eave, r[2 * q + 1]];
      const i0 = [inner[2 * i], top, inner[2 * i + 1]], i1 = [inner[2 * q], top, inner[2 * q + 1]];
      tri(o0, o1, i1);
      tri(o0, i1, i0);
    }
    cap(inner, top);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function distToRing(x, z, r) {
  let best = Infinity;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
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

function buildAquarium(parts, mats, ctx, site) {
  const { GEO, kit } = ctx;
  const idx = aquariumBuilding(GEO, site.at);
  if (idx < 0) return false;
  const b = GEO.buildings[idx];
  const ring = cleanRing(b.g[0]);
  const low = lowestAlong(ctx, ring);
  const eave = b.ground + 3.0, rise = 3.2;
  block(parts, mats, ctx, ring, low, eave, rise, { plinth: 1.6 });
  addWindows(parts, mats, ctx, ring, [eave - 2.9, eave - 6.6, eave - 10.3], { w: 1.4, h: 2.1, bay: 3.6, seed: 900 });

  // the entrance front: the end wall on the side of OSM's point, looking down the port, with a projecting centre bay
  // under a pediment and the door
  const r = wound(simplify(ring, 0.3));
  const axis = kit.orientedBox(r);
  let ex = Math.cos(axis.angle), ez = Math.sin(axis.angle);
  if ((site.at[0] - axis.x) * ex + (site.at[1] - axis.z) * ez < 0) { ex = -ex; ez = -ez; }
  let face = null, best = -Infinity;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 6) continue;
    const facing = ((bz - az) * ex - (bx - ax) * ez) / len; // outward normal (dz, -dx) · axis
    if (facing > best) { best = facing; face = { ax, az, bx, bz, len }; }
  }
  if (face) {
    const { ax, az, bx, bz, len } = face;
    const ux = (bx - ax) / len, uz = (bz - az) / len, ox = uz, oz = -ux;
    const cx = (ax + bx) / 2, cz = (az + bz) / 2;
    const bw = Math.min(7, len * 0.45);
    const foot = Math.max(kit.groundAt(ctx, cx + ox * 1.2, cz + oz * 1.2), kit.groundAt(ctx, cx + ox * 2.5, cz + oz * 2.5));
    const y0 = Math.min(foot, low) - 0.6;
    parts.add(mats.render, box(bw, eave + 0.9 - y0, 0.8, cx + ox * 0.4, y0, cz + oz * 0.4, ux, uz));
    parts.add(mats.stone, box(bw + 0.5, 0.5, 1.0, cx + ox * 0.45, eave + 0.4, cz + oz * 0.45, ux, uz));
    // pediment: a low triangle over the bay
    const tri = new THREE.Shape();
    tri.moveTo(-bw / 2 - 0.25, 0);
    tri.lineTo(bw / 2 + 0.25, 0);
    tri.lineTo(0, 1.9);
    tri.lineTo(-bw / 2 - 0.25, 0);
    const ped = new THREE.ExtrudeGeometry(tri, { depth: 0.9, bevelEnabled: false });
    // (extruded inwards from 0.9 m out, so the basis stays right-handed)
    _m.makeBasis(new THREE.Vector3(ux, 0, uz), new THREE.Vector3(0, 1, 0), new THREE.Vector3(-ox, 0, -oz));
    ped.applyMatrix4(_m.setPosition(cx + ox * 0.9, eave + 0.9, cz + oz * 0.9));
    parts.add(mats.stone, ped);
    // the door in a stone surround
    const door = box(2.4, 3.4, 0.2, cx + ox * 0.85, foot, cz + oz * 0.85, ux, uz);
    door.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(door.attributes.position.count * 2).fill(0.05), 2));
    parts.add(mats.window, door);
    parts.add(mats.stone, box(3.0, 3.8, 0.12, cx + ox * 0.82, foot - 0.1, cz + oz * 0.82, ux, uz));
  }
  // The site is an OSM point, so build.mjs found no 1:500 building under it: name the one replaced here, as
  // landmarks/index.js hides each site's `buildings` once build() returns
  site.buildings = [idx];
  return true;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { kit } = ctx;
  const mats = {
    render: kit.materials.whiteRender, stone: kit.materials.sandstone, tiles: kit.materials.terracotta, window: windowMaterial()
  };
  const parts = new Parts();
  let any = false;
  for (const site of sites) {
    let ok = false;
    try {
      if (site.id === 'itsas-museoa') ok = buildMuseum(parts, mats, ctx);
      else if (site.id === 'aquariuma' && site.at) ok = buildAquarium(parts, mats, ctx, site);
    } catch (e) {
      // one failing building shouldn't take the other down with it
      console.warn(`[landmark ${site.id}]`, e);
    }
    // keep the plain extrusion of a building that wasn't modelled
    if (!ok) site.buildings = [];
    any ||= ok;
  }
  return any ? parts.build('itsas-museoa') : null;
}
