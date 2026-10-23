import * as THREE from 'three/webgpu';
import { Fn, float, vec3, mix, abs, floor, fract, sin, step, clamp, smoothstep, positionWorld, mx_noise_float } from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { PartBin, Frame, WORLD, westMaterials as M, rgb, strut } from './igeldo.js';
import { pointInRing, centroid, distToRing, clipRing } from './geom.js';

// js/donostia/landmarks/tenis-kluba.js
// Real Club de Tenis de San Sebastián at Ondarreta, between the Paseo de Eduardo Chillida and the foot of Igeldo, a
// short walk from the Peine del Viento. The municipal heritage file (Plan Especial de Protección del Patrimonio
// Urbanístico, Grado C, "Real Club Tenis, Paseo de Eduardo Chillida 9") describes what stands: Luis Gutiérrez Soto's
// 1928 club, single-storey neo-Basque pieces in a line in front of the cliff under the Plaza del Funicular, joined by a
// porch; José Antonio Domínguez Salazar's 1940 second porch whose flat top is a terrace for watching the play (the
// tribuna), and his 1944 L-shaped buildings round the access court at the northern end of the courts (concierge and
// changing rooms), neo-Basque again: white render, sandstone, exposed timber and tiled roofs. Here:
//   - the clay courts (tierra batida): the six court rectangles and their enclosures from the municipal 1:500 map
//     (c500_OINEZKOEN_ZONA features 177 and 178, whose holes are the courts' 10.97 x 23.77 m playing areas; Donostiako
//     Udala, CC BY-SA 3.0), orange-red with white lines, nets on their posts, dark green windbreaks on the fences and
//     a screen down the middle of the four northern courts (the strips the map draws between them);
//   - the long club pavilion on its terrace above the courts' western side (the 1:500 outline the b5m names "Tenis"),
//     white with a flat roof terrace and a porch facing the courts and the beach, on the sandstone retaining wall the
//     map draws at the courts' edge;
//   - the clubhouse at the northern end (OSM way 182691330, the site tenis-kluba): two storeys of white render on a
//     sandstone plinth with quoins, timber framing on the upper floor, green shutters, a hipped roof of red tiles on
//     carved eaves brackets, the arcade to the courts.
//
// build(sites, ctx) receives the GEO.landmarks entries ['tenis-kluba', 'tenis-pistak'] and ctx = { GEO, terrain, kit }.
// No site claims the pavilion's 1:500 building, so the model names it in userData.hide and the registry hides its plain
// extrusion along with the clubhouse's.

// The courts: four corners each (two baselines of 10.97 m), from the 1:500 map
const COURTS = [
  [-1355.40, 251.97, -1344.55, 253.68, -1348.33, 277.21, -1359.18, 275.50],
  [-1327.16, 256.55, -1337.97, 254.79, -1341.72, 278.28, -1330.91, 280.04],
  [-1321.62, 221.84, -1332.45, 220.12, -1336.19, 243.58, -1325.36, 245.31],
  [-1339.04, 219.05, -1349.86, 217.30, -1353.61, 240.77, -1342.79, 242.52],
  [-1351.50, 299.51, -1362.44, 297.67, -1366.39, 321.05, -1355.45, 322.89],
  [-1345.57, 300.48, -1334.83, 302.23, -1338.65, 325.62, -1349.39, 323.87]
];
// The fenced clay enclosures round them (the outlines of those 1:500 features, simplified)
const ENCLOSURES = [
  [-1328.5, 286.2, -1355.7, 281.8, -1363.2, 280.5, -1361.9, 272.9, -1357.2, 234.8, -1354.9, 215.9, -1352.8, 213.7, -1347.4, 212.0,
    -1317.4, 216.7, -1322.3, 246.3],
  [-1330.1, 296.1, -1362.0, 291.1, -1364.8, 292.0, -1370.8, 327.2, -1336.5, 333.3]
];
// The screen down the middle of the northern four (the map's thin strips between them, end to end)
const SCREEN = [-1334.8, 214.1, -1345.9, 283.3];
// The retaining wall along the courts' western edge, under the pavilion's terrace
const TERRACE_WALL = [-1354.2, 215.4, -1356.9, 234.8, -1362.1, 271.4];

const TENNIS = { width: 10.97, length: 23.77, singles: 8.23, service: 6.40, postOut: 0.914, line: 0.05, baseline: 0.1 };

// Terre battue: brick-red crushed clay, swept, a little patchy, paler where the players' feet have worn it
function createClayMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const patch = mx_noise_float(p.mul(0.35)).mul(0.5).add(0.5);
    const fine = mx_noise_float(p.mul(4.0)).mul(0.05);
    const base = mix(vec3(0.40, 0.085, 0.03), vec3(0.50, 0.13, 0.045), patch);
    // the sweeping drags: faint bands along x
    const drag = smoothstep(0.3, 0.9, abs(mx_noise_float(vec3(p.x.mul(0.25), 0.0, p.z.mul(3.0))))).mul(0.06);
    return base.add(fine).mul(float(1.0).sub(drag));
  })();
  mat.roughnessNode = float(0.95);
  return mat;
}

// Glazing: dark glass by day; after dusk a share of the rooms lit, warm (after miramar.js's windows)
function createWindowMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ color: 0x1c2a33, roughness: 0.1, metalness: 0.5 });
  mat.emissiveNode = Fn(() => {
    const cell = floor(positionWorld.mul(vec3(0.55, 0.36, 0.55)));
    const h = fract(sin(cell.x.mul(12.9898).add(cell.y.mul(78.233)).add(cell.z.mul(37.719))).mul(43758.5453));
    const lit = step(h, clamp(cityUniforms.uInteriorGlow.mul(0.3), 0.0, 0.55));
    return vec3(1.0, 0.78, 0.5).mul(lit).mul(cityUniforms.uInteriorGlow).mul(0.75);
  })();
  return mat;
}

const WHITE_LINE = rgb(0xf0efe9), NET = rgb(0x1d2420), POST = rgb(0x1f4a33), SCREEN_GREEN = rgb(0x1e4b34);
const SAND = rgb(0xc9b089), SAND_DARK = rgb(0xa88f6a), TIMBER = rgb(0x4a3322), SHUTTER = rgb(0x24573a), ROOF_GREY = rgb(0xa7a49c);

// A box from a to b (flat [x, z] ends) of width w, between y0 and y1
function wallBox(a, b, w, y0, y1) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const g = new THREE.BoxGeometry(len, y1 - y0, w);
  g.rotateY(-Math.atan2(b[1] - a[1], b[0] - a[0]));
  g.translate((a[0] + b[0]) / 2, (y0 + y1) / 2, (a[1] + b[1]) / 2);
  return g;
}

// Median of the ground over a ring (sampled every metre inside its bounding box)
function groundOver(ctx, ring) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]); minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  const hs = [];
  for (let x = minX; x <= maxX; x += 1) for (let z = minZ; z <= maxZ; z += 1) if (pointInRing(x, z, ring)) hs.push(ctx.terrain.heightAt(x, z));
  hs.sort((p, q) => p - q);
  return hs.length ? hs[Math.floor(hs.length / 2)] : ctx.terrain.heightAt(ring[0], ring[1]);
}

// The DTM's sample lattice (cell centres of ctx.terrain's core field, 2 m), on which the ground mesh has its vertices
function lattice(ctx) {
  const f = ctx.terrain.core;
  const res = f?.res || 2;
  return { res, ox: f ? f.x0 + 0.5 * res : 0, oz: f ? f.z0 + 0.5 * res : 0 };
}

// Highest ground on the lattice within one cell of a ring: the ground mesh never rises above it there
function groundMax(ctx, ring) {
  const { res, ox, oz } = lattice(ctx);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]); minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  let max = -Infinity;
  for (let i = Math.floor((minX - res - ox) / res); ox + i * res <= maxX + res; i++) {
    for (let j = Math.floor((minZ - res - oz) / res); oz + j * res <= maxZ + res; j++) {
      const x = ox + i * res, z = oz + j * res;
      if (pointInRing(x, z, ring) || distToRing(x, z, ring) < res) max = Math.max(max, ctx.terrain.heightAt(x, z));
    }
  }
  return max;
}

// Clay over the ground inside a ring wherever the ground rises above `level` (the ramp the LiDAR keeps at the foot of
// the terrace wall): `over` metres above the ground mesh, on its own lattice. Each lattice cell is a fan of four
// triangles round its centre, raised to the higher of its two diagonals' midpoints, so the clay stays above the
// ground whichever diagonal the ground mesh splits the cell along; cells cut by the ring are clipped to it, with a
// skirt down to the ground along the cut. Cells left flat at `level` are the prism's top.
function drape(ctx, ring, level, over = 0.05) {
  const { res, ox, oz } = lattice(ctx);
  const ground = (x, z) => ctx.terrain.heightAt(x, z);
  const lift = (x, z) => Math.max(level + 0.015, ground(x, z) + over);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < ring.length; k += 2) {
    minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]); minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
  }
  const pos = [];
  const tri = (a, b, c) => {
    const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    if (Math.abs(ny) < 1e-9) return;
    if (ny > 0) pos.push(...a, ...b, ...c);
    else pos.push(...a, ...c, ...b);
  };
  for (let i = Math.floor((minX - ox) / res); ox + i * res < maxX; i++) {
    for (let j = Math.floor((minZ - oz) / res); oz + j * res < maxZ; j++) {
      const x0 = ox + i * res, z0 = oz + j * res, x1 = x0 + res, z1 = z0 + res;
      const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => [x, lift(x, z), z]);
      if (Math.max(c[0][1], c[1][1], c[2][1], c[3][1]) <= level + 0.016) continue;
      const mid = [(x0 + x1) / 2, Math.max((c[0][1] + c[2][1]) / 2, (c[1][1] + c[3][1]) / 2), (z0 + z1) / 2];
      for (let k = 0; k < 4; k++) {
        const a = c[k], b = c[(k + 1) % 4];
        // the part of the ring over this fan triangle (its sides wound counter-clockwise, so inside is to the left)
        let piece = ring;
        for (const [p, q] of [[a, b], [b, mid], [mid, a]]) {
          if (!piece) break;
          const ex = q[0] - p[0], ez = q[2] - p[2];
          piece = clipRing(piece, -ez, ex, ez * p[0] - ex * p[2]);
        }
        if (!piece) continue;
        // heights on the fan triangle's plane
        const det = (b[0] - a[0]) * (mid[2] - a[2]) - (mid[0] - a[0]) * (b[2] - a[2]);
        const at = (x, z) => {
          const u = ((x - a[0]) * (mid[2] - a[2]) - (mid[0] - a[0]) * (z - a[2])) / det;
          const v = ((b[0] - a[0]) * (z - a[2]) - (x - a[0]) * (b[2] - a[2])) / det;
          return [x, a[1] + u * (b[1] - a[1]) + v * (mid[1] - a[1]), z];
        };
        const pts = [];
        for (let m = 0; m < piece.length; m += 2) pts.push(new THREE.Vector2(piece[m], piece[m + 1]));
        for (const [p, q, r] of THREE.ShapeUtils.triangulateShape(pts, [])) {
          tri(at(pts[p].x, pts[p].y), at(pts[q].x, pts[q].y), at(pts[r].x, pts[r].y));
        }
        // the skirt along the ring's own edges
        for (let m = 0, n = piece.length / 2; m < n; m++) {
          const px = piece[2 * m], pz = piece[2 * m + 1], qx = piece[(2 * m + 2) % piece.length], qz = piece[(2 * m + 3) % piece.length];
          if (distToRing((px + qx) / 2, (pz + qz) / 2, ring) > 1e-3) continue;
          const P = at(px, pz), Q = at(qx, qz);
          const P0 = [px, Math.min(ground(px, pz), level) - 0.3, pz], Q0 = [qx, Math.min(ground(qx, qz), level) - 0.3, qz];
          pos.push(...P, ...P0, ...Q0, ...P, ...Q0, ...Q);
        }
      }
    }
  }
  if (!pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// --- Courts ------------------------------------------------------------------------------------------------------------

function buildCourts(ctx, bin, clay) {
  const { kit } = ctx;
  ENCLOSURES.forEach((ring, e) => {
    // The clay: flat at the enclosure's median ground, or as high as the ground under its courts if that is higher
    // (the courts stay flat; the LiDAR keeps a few centimetres of tilt and noise under them), and draped over the
    // ground wherever that rises higher still, so the ground mesh never shows through
    const courts = COURTS.filter((c) => pointInRing(...centroid(c), ring));
    const median = groundOver(ctx, ring) + 0.06;
    const level = Math.min(median + 0.3, Math.max(median, ...courts.map((c) => groundMax(ctx, c) + 0.04)));
    bin.add(clay, kit.prism(ring, level - 0.8, level));
    const draped = drape(ctx, ring, level);
    if (draped) bin.add(clay, draped);
    // the fence: green posts every three metres or so, a top rail, and the windbreak on the lower 2.4 m
    for (let k = 0; k < ring.length; k += 2) {
      const a = [ring[k], ring[k + 1]], b = [ring[(k + 2) % ring.length], ring[(k + 3) % ring.length]];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      bin.add(M.paint, wallBox(a, b, 0.03, level, level + 2.4), SCREEN_GREEN);
      bin.add(M.paint, wallBox(a, b, 0.05, level + 3.45, level + 3.52), POST);
      const count = Math.max(1, Math.round(len / 3));
      for (let j = 0; j < count; j++) {
        const t = j / count;
        bin.add(M.paint, WORLD.box(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.07, 0.07, level - 0.1, level + 3.5), POST);
      }
    }
    if (e === 0) bin.add(M.paint, wallBox(SCREEN.slice(0, 2), SCREEN.slice(2), 0.03, level, level + 1.6), SCREEN_GREEN);
    // floodlight masts (OSM: lit=yes) along the two longest sides, their lamps leaning over the courts
    const sides = [];
    for (let k = 0; k < ring.length; k += 2) {
      const a = [ring[k], ring[k + 1]], b = [ring[(k + 2) % ring.length], ring[(k + 3) % ring.length]];
      sides.push({ a, b, len: Math.hypot(b[0] - a[0], b[1] - a[1]) });
    }
    sides.sort((p, q) => q.len - p.len);
    let cx = 0, cz = 0;
    for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
    cx /= ring.length / 2; cz /= ring.length / 2;
    for (const { a, b } of sides.slice(0, 2)) {
      for (const t of [0.17, 0.5, 0.83]) {
        const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const dx = cx - x, dz = cz - z, d = Math.hypot(dx, dz) || 1;
        bin.add(M.paint, WORLD.cylinder(x - (dx / d) * 0.5, z - (dz / d) * 0.5, 0.09, 0.14, level - 0.2, level + 10.5, 8), POST);
        const foot = [x - (dx / d) * 0.5, level + 10.4, z - (dz / d) * 0.5], head = [x + (dx / d) * 0.4, level + 10.1, z + (dz / d) * 0.4];
        bin.add(M.paint, strut(foot, head, 0.75, 0.3), rgb(0x2b2f2d));
      }
    }
    for (const c of courts) buildCourt(c, level, bin);
  });
}

function buildCourt(c, level, bin) {
  // court frame: u across the court (along a baseline), v along it (net at v = 0)
  const cx = (c[0] + c[2] + c[4] + c[6]) / 4, cz = (c[1] + c[3] + c[5] + c[7]) / 4;
  const e1 = [c[2] - c[0], c[3] - c[1]], e2 = [c[4] - c[2], c[5] - c[3]];
  const across = Math.hypot(...e1) < Math.hypot(...e2) ? e1 : e2;
  const fr = new Frame(cx, cz, Math.atan2(across[1], across[0]));
  const T = TENNIS, hw = T.width / 2, hl = T.length / 2, hs = T.singles / 2;
  const y0 = level, y1 = level + 0.012;
  const line = (u, v, su, sv) => bin.add(M.paint, fr.box(u, v, su, sv, y0, y1), WHITE_LINE);
  for (const s of [-1, 1]) {
    line(0, s * (hl - T.baseline / 2), T.width, T.baseline); // baselines
    line(s * (hw - T.line / 2), 0, T.line, T.length); // doubles sidelines
    line(s * (hs - T.line / 2), 0, T.line, T.length); // singles sidelines
    line(0, s * T.service, T.singles, T.line); // service lines
    line(0, s * (hl - T.baseline - 0.05), T.line, 0.1); // centre marks
  }
  line(0, 0, T.line, 2 * T.service); // centre service line
  // the net: posts 0.914 m outside the doubles lines, 1.07 m high, the net sagging to 0.914 m in the middle, its
  // white band on top
  const po = hw + T.postOut;
  for (const s of [-1, 1]) bin.add(M.paint, fr.box(s * po, 0, 0.08, 0.08, level, level + 1.07), POST);
  for (const s of [-1, 1]) {
    const a = fr.world(s * po, 0), m = fr.world(0, 0);
    bin.add(M.paint, strut([a[0], level + 0.55, a[1]], [m[0], level + 0.47, m[1]], 0.025, 0.95 - 0.08), NET);
    bin.add(M.paint, strut([a[0], level + 1.04, a[1]], [m[0], level + 0.89, m[1]], 0.035, 0.06), WHITE_LINE);
  }
}

// --- The pavilion on the terrace ---------------------------------------------------------------------------------------

function buildPavilion(ctx, bin, b, glass) {
  const { kit } = ctx;
  const ring = b.g[0];
  const base = b.ground, eave = Math.max(b.eave, base + 3.2);
  bin.add(kit.materials.whiteRender, kit.prism(ring, base - 1.2, eave));
  bin.add(M.paint, kit.prism(ring, eave - 0.05, eave + 0.12), ROOF_GREY); // the flat roof
  // the edges facing the courts (outward normal towards +x, the courts and the beach): glazed doors in green frames
  // under a porch whose flat top is a terrace with a railing, the parapet and railing of the roof terrace above
  let cx = 0, cz = 0;
  for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
  cx /= ring.length / 2; cz /= ring.length / 2;
  for (let k = 0; k < ring.length; k += 2) {
    const a = [ring[k], ring[k + 1]], bb = [ring[(k + 2) % ring.length], ring[(k + 3) % ring.length]];
    const len = Math.hypot(bb[0] - a[0], bb[1] - a[1]);
    if (len < 2.5) continue;
    const tx = (bb[0] - a[0]) / len, tz = (bb[1] - a[1]) / len;
    let nx = tz, nz = -tx; // a normal; turn it outwards
    const mx = (a[0] + bb[0]) / 2, mz = (a[1] + bb[1]) / 2;
    if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
    const front = nx > 0.6;
    // parapet all round, railing on the courts' side
    const pa = [a[0] - nx * 0.1, a[1] - nz * 0.1], pb = [bb[0] - nx * 0.1, bb[1] - nz * 0.1];
    bin.add(kit.materials.whiteRender, wallBox(pa, pb, 0.22, eave, eave + 0.45));
    if (!front) continue;
    const at = (t, off) => [a[0] + tx * t + nx * off, a[1] + tz * t + nz * off];
    const doors = Math.max(1, Math.floor(len / 3.2));
    for (let j = 0; j < doors; j++) {
      const t = ((j + 0.5) * len) / doors;
      const [px, pz] = at(t, 0.02);
      const door = new THREE.BoxGeometry(1.5, 2.3, 0.08);
      door.rotateY(-Math.atan2(tz, tx));
      door.translate(px, base + 1.15, pz);
      bin.add(glass, door);
      const frame = new THREE.BoxGeometry(1.7, 2.45, 0.06);
      frame.rotateY(-Math.atan2(tz, tx));
      frame.translate(px - nx * 0.01, base + 1.22, pz - nz * 0.01);
      bin.add(M.paint, frame, SHUTTER);
    }
    // the porch: a slab 2.4 m deep on timber posts, its top a terrace behind a white railing
    bin.add(M.paint, wallBox(at(0, 1.2), at(len, 1.2), 2.4, base + 2.85, base + 3.1), ROOF_GREY);
    const posts = Math.max(1, Math.round(len / 3.2));
    for (let j = 0; j <= posts; j++) {
      const [px, pz] = at((j * len) / posts, 2.25);
      bin.add(M.paint, WORLD.box(px, pz, 0.2, 0.2, base, base + 2.85), TIMBER);
      bin.add(M.paint, WORLD.box(px, pz, 0.06, 0.06, base + 3.1, base + 4.05), WHITE_LINE);
    }
    bin.add(M.paint, wallBox(at(0, 2.35), at(len, 2.35), 0.07, base + 3.98, base + 4.06), WHITE_LINE);
    bin.add(M.paint, wallBox(at(0, 2.35), at(len, 2.35), 0.04, base + 3.55, base + 3.6), WHITE_LINE);
    // the roof terrace's railing
    bin.add(M.paint, wallBox(at(0, -0.1), at(len, -0.1), 0.06, eave + 0.95, eave + 1.0), WHITE_LINE);
    for (let j = 0; j <= posts; j++) {
      const [px, pz] = at((j * len) / posts, -0.1);
      bin.add(M.paint, WORLD.box(px, pz, 0.05, 0.05, eave + 0.45, eave + 0.97), WHITE_LINE);
    }
  }
}

// --- The clubhouse -----------------------------------------------------------------------------------------------------

// Hipped roof over a rectangle (frame, length L along u, width W, overhang o) from y0 at the eaves to y1 at the ridge
function hipRoof(fr, L, W, o, y0, y1) {
  const a = L / 2 + o, b = W / 2 + o;
  const r = Math.max(0, a - b); // half the ridge
  const P = (u, v, y) => {
    const [x, z] = fr.world(u, v);
    return [x, y, z];
  };
  const c = [P(-a, -b, y0), P(a, -b, y0), P(a, b, y0), P(-a, b, y0)];
  const r0 = P(-r, 0, y1), r1 = P(r, 0, y1);
  const tris = [
    [c[0], r1, c[1]], [c[0], r0, r1], // side v < 0
    [c[2], r0, c[3]], [c[2], r1, r0], // side v > 0
    [c[1], r1, c[2]], [c[3], r0, c[0]] // hips
  ];
  const pos = [];
  for (const [p, q, s] of tris) {
    // keep each face turned up
    const e1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], e2 = [s[0] - p[0], s[1] - p[1], s[2] - p[2]];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    if (ny >= 0) pos.push(...p, ...q, ...s);
    else pos.push(...p, ...s, ...q);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function buildClubhouse(ctx, bin, site, b, glass) {
  const { kit } = ctx;
  const ring = b?.g[0] || site.footprint;
  if (!ring) return;
  const ob = kit.orientedBox(ring);
  const fr = new Frame(ob.x, ob.z, ob.angle);
  const L = ob.length, W = ob.width;
  const g = kit.lowestGround(ctx, ring);
  const eave = b && b.eave > g + 4.5 && b.eave < g + 8 ? b.eave : g + 5.4;
  const top = b && b.top > eave + 1.5 && b.top < eave + 5 ? b.top : eave + 3.0;
  const floor1 = g + 3.0;
  bin.add(kit.materials.whiteRender, fr.box(0, 0, L, W, g - 0.6, eave));
  bin.add(M.stone, fr.box(0, 0, L + 0.12, W + 0.12, g - 0.6, g + 0.75), SAND_DARK); // plinth
  // sandstone quoins, the timber floor band and the posts of the timber-framed upper floor
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      for (let y = g + 0.75, k = 0; y < eave - 0.2; y += 0.55, k++) {
        const w = k % 2 ? 0.45 : 0.75;
        bin.add(M.stone, fr.box(su * (L / 2 - w / 2 + 0.04), sv * (W / 2 + 0.03), w, 0.08, y, y + 0.5), SAND);
        bin.add(M.stone, fr.box(su * (L / 2 + 0.03), sv * (W / 2 - (1.2 - w) / 2 + 0.04), 0.08, 1.2 - w, y, y + 0.5), SAND);
      }
    }
  }
  const faces = [[0, -1, L], [0, 1, L], [-1, 0, W], [1, 0, W]]; // outward (u, v) and the face's length
  for (const [nu, nv, len] of faces) {
    const off = (nu ? L : W) / 2 + 0.04;
    const box = (t, su, y0, y1, depth = 0.08) => fr.box(nu ? nu * off : t, nv ? nv * off : t, nu ? depth : su, nv ? depth : su, y0, y1);
    bin.add(M.paint, box(0, len + 0.1, floor1 - 0.12, floor1 + 0.16, 0.12), TIMBER);
    const bays = Math.max(2, Math.round((len - 1.5) / 2.6));
    for (let j = 0; j <= bays; j++) {
      const t = -len / 2 + 0.75 + ((len - 1.5) * j) / bays;
      bin.add(M.paint, box(t, 0.16, floor1 + 0.16, eave - 0.05), TIMBER);
    }
    for (let j = 0; j < bays; j++) {
      const t = -len / 2 + 0.75 + ((len - 1.5) * (j + 0.5)) / bays;
      // upper windows between the posts, green shutters folded back; tall windows below
      bin.add(glass, box(t, 0.95, floor1 + 0.75, floor1 + 2.05, 0.1));
      for (const s of [-1, 1]) bin.add(M.paint, box(t + s * 0.78, 0.48, floor1 + 0.72, floor1 + 2.08, 0.06), SHUTTER);
      bin.add(glass, box(t, 1.1, g + 0.9, g + 2.55, 0.1));
      for (const s of [-1, 1]) bin.add(M.paint, box(t + s * 0.86, 0.55, g + 0.86, g + 2.6, 0.06), SHUTTER);
      bin.add(M.stone, box(t, 1.4, g + 0.78, g + 0.9, 0.16), SAND); // sills
    }
  }
  // the hipped roof of red tiles over deep eaves, carved brackets under them
  bin.add(kit.materials.terracotta, hipRoof(fr, L, W, 0.8, eave + 0.18, top));
  bin.add(M.paint, fr.box(0, 0, L + 1.5, W + 1.5, eave + 0.02, eave + 0.2), TIMBER); // eaves board
  for (const [nu, nv, len] of faces) {
    const off = (nu ? L : W) / 2 + 0.35;
    const n = Math.round(len / 1.3);
    for (let j = 0; j <= n; j++) {
      const t = -len / 2 + (len * j) / n;
      bin.add(M.paint, fr.box(nu ? nu * off : t, nv ? nv * off : t, nu ? 0.75 : 0.14, nv ? 0.75 : 0.14, eave - 0.25, eave + 0.02), TIMBER);
    }
  }
  // the arcade on the courts' side (the face looking towards the courts' middle)
  const toCourts = fr.local(-1340, 250);
  let best = faces[0], bestDot = -Infinity;
  for (const f of faces) {
    const d = f[0] * toCourts[0] + f[1] * toCourts[1];
    if (d > bestDot) { bestDot = d; best = f; }
  }
  const [nu, nv] = best;
  const off = (nu ? L : W) / 2;
  for (let j = 0; j < 3; j++) {
    const t = -1.9 + j * 1.9;
    bin.add(glass, fr.box(nu ? nu * (off + 0.02) : t, nv ? nv * (off + 0.02) : t, nu ? 0.06 : 1.3, nv ? 0.06 : 1.3, g, g + 2.5));
  }
  for (let j = 0; j < 4; j++) {
    const t = -2.85 + j * 1.9;
    bin.add(M.stone, fr.box(nu ? nu * (off + 0.12) : t, nv ? nv * (off + 0.12) : t, 0.4, 0.4, g, g + 2.75), SAND);
  }
  bin.add(M.stone, fr.box(nu ? nu * (off + 0.1) : 0, nv ? nv * (off + 0.1) : 0, nu ? 0.36 : 6.2, nv ? 0.36 : 6.2, g + 2.75, g + 3.0), SAND);
}

// --- Build -------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const club = sites.find((s) => s.id === 'tenis-kluba');
  const courts = sites.find((s) => s.id === 'tenis-pistak');
  if (!club && !courts) return null;
  const { GEO, terrain } = ctx;
  const bin = new PartBin();
  const clay = createClayMaterial();
  const glass = createWindowMaterial();

  buildCourts(ctx, bin, clay);

  // the retaining wall under the pavilion's terrace: sandstone from the courts up to the terrace, a coping on top
  for (let k = 0; k + 3 < TERRACE_WALL.length; k += 2) {
    const a = TERRACE_WALL.slice(k, k + 2), b = TERRACE_WALL.slice(k + 2, k + 4);
    const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 4);
    for (let j = 0; j < steps; j++) {
      const p = [a[0] + ((b[0] - a[0]) * j) / steps, a[1] + ((b[1] - a[1]) * j) / steps];
      const q = [a[0] + ((b[0] - a[0]) * (j + 1)) / steps, a[1] + ((b[1] - a[1]) * (j + 1)) / steps];
      const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
      const top = Math.max(terrain.heightAt(mx - 2.0, mz), terrain.heightAt(mx, mz) + 0.6) + 0.05;
      bin.add(M.stone, wallBox(p, q, 0.6, terrain.heightAt(mx + 1.5, mz) - 0.6, top), SAND_DARK);
      bin.add(M.stone, wallBox(p, q, 0.75, top, top + 0.15), SAND);
    }
  }

  // the club pavilion: the 1:500 building the b5m names "Tenis" on the terrace west of the courts
  const pavilion = GEO.buildings.findIndex((b) => {
    if (b.name !== 'Tenis' || !b.g?.[0]) return false;
    const [x, z] = centroid(b.g[0]);
    return x > -1395 && x < -1355 && z > 225 && z < 315;
  });
  if (pavilion >= 0) buildPavilion(ctx, bin, GEO.buildings[pavilion], glass);

  if (club) buildClubhouse(ctx, bin, club, GEO.buildings[club.buildings?.[0]], glass);

  const group = new THREE.Group();
  group.name = 'TenisKluba';
  bin.build(group);
  if (pavilion >= 0) group.userData.hide = [pavilion];
  return group;
}
