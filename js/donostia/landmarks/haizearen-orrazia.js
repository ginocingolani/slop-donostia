import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, mix, abs, floor, fract, sin, dot, max, clamp, smoothstep, distance, positionWorld, normalWorld,
  cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { PartBin, westMaterials as M, rgb, sweep } from './igeldo.js';
import { pointInRing } from './geom.js';

// js/donostia/landmarks/haizearen-orrazia.js
// Haizearen orrazia / Peine del Viento XV (Eduardo Chillida, sculptor, and Luis Peña Ganchegui, architect, 1976-77) at
// the western end of Ondarreta, where the Paseo ends against the foot of Igeldo (es.wikipedia "Peine del Viento").
// An open-view public artwork, modelled as a photograph would show it (the photos in tools/donostia's reference set):
//   - three pieces of weathering steel of about 10 t each, square bars some 30-45 cm thick that come out of the rock
//     and curl like the teeth of a comb: one gripping the cliff face at the end of the plaza (two heavy bars out of
//     the rock, one rising in an arch, a long one reaching out and dipping at its tip, a lower one turning up into the
//     knot and a hook hanging under it), one gripping the top of the big rock off the plaza (a heavy stem that splits
//     into an upper hook and a lower one whose tips almost close, and a bar curling back down into the rock), and one
//     standing on the rock out at sea (two posts that curl outwards into loops). Their places are the OpenStreetMap
//     artwork nodes 13039815488, 13039815489 and 13039815487 (tools/donostia/data/osm_furniture.json); the cliff and
//     the outer pieces reach out to sea, the rock piece back towards the cliff;
//   - the rocks they grip, which the LiDAR terrain does not keep (it floods the sea to 0 m): layered sandstone of the
//     Igeldo flysch;
//   - Peña Ganchegui's plaza: pink granite setts on three terraces stepping down from the cliff, the steps between them
//     and the seven blowholes on the lowest one, through which the surf blows air and spray. The terraces and steps are
//     the municipal 1:500 map's (c500_OINEZKOEN_ZONA features 161-163, c500_ESKAILERA 405-406; Donostiako Udala,
//     CC BY-SA 3.0), their levels the LiDAR's.
//
// build(sites, ctx) receives the GEO.landmarks entries ['haizearen-orrazia'] (an OSM node on the plaza) and
// ctx = { GEO, terrain, kit }.

// The three pieces (local frame) and where they stand
const PIECES = {
  cliff: [-1374.7, -30.5],
  rock: [-1353.1, -32.7],
  sea: [-1362.0, -52.3]
};

// The plaza's terraces from the 1:500 map, highest first: the upper one at the foot of the cliff, the middle one, and
// the lowest, cut off where the Paseo starts
const TERRACES = [
  [-1363.7, -22.0, -1366.9, -15.9, -1367.5, -16.2, -1371.0, -9.7, -1371.4, -10.3, -1373.2, -14.8, -1373.7, -15.5, -1374.6, -17.2,
    -1374.4, -17.8, -1374.3, -19.7, -1374.7, -20.1, -1374.5, -20.9, -1374.9, -21.4, -1376.1, -21.5, -1376.0, -21.8, -1375.3, -22.1,
    -1375.1, -23.3, -1375.3, -24.6, -1375.9, -24.5, -1376.0, -25.2, -1375.3, -25.6, -1375.8, -27.8, -1374.5, -27.6],
  [-1353.8, -16.8, -1363.6, -12.7, -1368.1, -6.9, -1369.2, -7.4, -1369.8, -7.8, -1369.2, -8.7, -1369.4, -9.3, -1369.7, -9.8,
    -1370.1, -10.0, -1363.7, -22.0, -1355.7, -17.8],
  [-1367.2, -6.7, -1362.9, -12.2, -1354.4, -15.7, -1331.3, -3.7, -1328.4, 11.5, -1332.1, 11.5, -1340.5, 9.9, -1341.2, 13.7,
    -1345.9, 14.6, -1352.5, 16.3, -1352.1, 15.4, -1352.4, 13.2, -1353.0, 12.2, -1358.5, 13.8, -1357.8, 13.2, -1357.2, 9.6,
    -1358.3, 9.4, -1356.5, 8.8, -1354.9, 8.6, -1354.5, 8.0, -1354.9, 6.7, -1357.4, 7.0, -1358.1, 6.2, -1359.2, 6.3, -1360.2, 5.7,
    -1361.3, 3.5, -1361.8, 1.0, -1361.8, 0.6, -1360.3, 0.0, -1361.3, -2.2, -1364.7, -1.5, -1365.2, -2.2, -1366.1, -4.5,
    -1367.0, -5.6]
];
// The steps between them (a line along the riser each)
const STAIRS = [
  [-1370.4, -10.1, -1367.2, -16.1], // upper to middle terrace
  [-1367.6, -6.8, -1363.3, -12.4] // middle to lower terrace
];
// The lowest terrace's seaward edge, along which the blowholes open
const SEA_EDGE = [-1354.4, -15.7, -1331.3, -3.7];

// --- Materials ---------------------------------------------------------------------------------------------------------

// Weathering steel: mottled orange-brown rust, darker runs down the faces; at night the plaza's floodlights pick the
// pieces out of the dark, strongest on the faces they look up at
function createRustMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const rust = Fn(() => {
    const p = positionWorld;
    const mottle = mx_noise_float(p.mul(1.6)).mul(0.5).add(0.5);
    const base = mix(vec3(0.13, 0.042, 0.017), vec3(0.33, 0.115, 0.042), mottle);
    const runs = smoothstep(0.25, 0.75, mx_noise_float(vec3(p.x.mul(7.0), p.y.mul(0.7), p.z.mul(7.0))));
    return base.mul(float(0.9).add(mx_noise_float(p.mul(11.0)).mul(0.12))).mul(float(1.0).sub(runs.mul(0.35)));
  })();
  mat.colorNode = rust;
  const night = smoothstep(0.9, 1.35, cityUniforms.uInteriorGlow);
  const fromBelow = clamp(normalWorld.y.mul(-0.7).add(0.5), 0.12, 1.2);
  mat.emissiveNode = rust.mul(vec3(1.0, 0.85, 0.65)).mul(night.mul(fromBelow).mul(1.2));
  mat.roughnessNode = float(0.78);
  mat.metalnessNode = float(0.25);
  return mat;
}

// Igeldo flysch: the vertex colour (ochre sandstone, darker reefs) in thin tilted strata, wet and dark near the sea
function createRockMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true });
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const n = mx_noise_float(p.mul(0.7));
    const strata = fract(dot(p, vec3(0.22, 0.93, 0.3)).mul(2.6).add(n.mul(0.35)));
    const seam = smoothstep(0.0, 0.05, abs(strata.sub(0.5)).sub(0.43));
    const grain = float(0.86).add(mx_noise_float(p.mul(3.1)).mul(0.1)).add(n.mul(0.08));
    const wet = smoothstep(2.6, 0.4, p.y).mul(0.42);
    return vec3(grain).mul(float(1.0).sub(seam.mul(0.28))).mul(float(1.0).sub(wet));
  })();
  mat.roughnessNode = float(0.92);
  return mat;
}

// Peña Ganchegui's pink granite: setts about 20 x 11 cm in staggered rows along the plaza on the treads, big blocks on
// the risers and walls; each stone its own shade, the joints dark; the pattern fades out with distance (no shimmer)
function createGraniteMaterial(angle) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const c = Math.cos(angle), s = Math.sin(angle);
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const a = p.x.mul(c).add(p.z.mul(s)), b = p.z.mul(c).sub(p.x.mul(s));
    const flat = smoothstep(0.5, 0.8, abs(normalWorld.y));
    // treads: setts; walls: 0.6 x 0.3 m blocks along the face
    const along = mix(p.x.mul(normalWorld.z).sub(p.z.mul(normalWorld.x)), a, flat);
    const across = mix(p.y, b, flat);
    const sizeU = mix(float(0.6), float(0.2), flat), sizeV = mix(float(0.3), float(0.11), flat);
    const row = floor(across.div(sizeV));
    const fu = along.div(sizeU).add(row.mul(0.5));
    const col = floor(fu);
    const ju = fract(fu), jv = fract(across.div(sizeV));
    const joint = max(smoothstep(0.06, 0.0, ju).add(smoothstep(0.94, 1.0, ju)), smoothstep(0.08, 0.0, jv).add(smoothstep(0.92, 1.0, jv)));
    const shade = fract(sin(row.mul(12.9898).add(col.mul(78.233))).mul(43758.5453));
    const fade = smoothstep(70.0, 25.0, distance(cameraPosition, p));
    const base = vec3(0.26, 0.19, 0.165).mul(float(0.84).add(shade.mul(0.3).mul(fade)));
    const speck = mx_noise_float(p.mul(9.0)).mul(0.06);
    return base.add(speck).mul(float(1.0).sub(joint.mul(0.45).mul(fade)));
  })();
  mat.roughnessNode = float(0.8);
  return mat;
}

// --- Geometry helpers --------------------------------------------------------------------------------------------------

// A piece's frame: anchor (x, y, z), u horizontal along `heading`, v to its right, y up
function pieceFrame(x, y, z, heading) {
  const ux = Math.cos(heading), uz = Math.sin(heading);
  return (u, v, h) => [x + u * ux - v * uz, y + h, z + u * uz + v * ux];
}

// [u, y] points of a circular arc in the piece's vertical plane, from angle a0 to a1 (degrees, 0 = +u, 90 = up)
function arc(cu, cy, r, a0, a1, steps = 14) {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const a = THREE.MathUtils.degToRad(a0 + ((a1 - a0) * i) / steps);
    out.push([cu + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// [u, y] points of a smooth curve through `pts` (centripetal Catmull-Rom)
function smooth(pts, steps = 24) {
  const curve = new THREE.CatmullRomCurve3(pts.map(([u, y]) => new THREE.Vector3(u, y, 0)), false, 'centripetal');
  return curve.getPoints(steps).map((p) => [p.x, p.y]);
}

// A square bar w (across) x h along [u, y] points at lateral offset v (or along [u, v, y] points), ends cut square
function bar(frame, pts, w, h, v = 0) {
  const path = [];
  let last = null;
  for (const p of pts) {
    const q = p.length === 3 ? frame(p[0], p[1], p[2]) : frame(p[0], v, p[1]);
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) < 1e-3) continue;
    path.push(...q);
    last = q;
  }
  return sweep(path, () => [-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2], { caps: true });
}

// A craggy block of rock: a subdivided box, its top drawn in, every vertex pushed about by smooth hashes of where it
// is (faces of the box that meet share their displaced corners), faceted
function rock(x, z, heading, su, sv, y0, y1, seed, rough = 0.35, taper = 0.25) {
  const g = new THREE.BoxGeometry(1, 1, 1, 4, 6, 4);
  const pos = g.attributes.position;
  const c = Math.cos(heading), s = Math.sin(heading);
  const n = (a, b, d, f) => Math.sin(a * 7.1 * f + seed * 1.7) * Math.sin(b * 5.3 * f + seed * 2.3) * Math.cos(d * 6.7 * f + seed);
  const noise = (a, b, d) => 0.65 * n(a, b, d, 1) + 0.35 * n(b, d, a, 2.3);
  for (let i = 0; i < pos.count; i++) {
    const bx = pos.getX(i), by = pos.getY(i) + 0.5, bz = pos.getZ(i);
    // drawn in towards the top, the corners rounded off
    const k = (1 - taper * by * by) * (1 - 0.18 * Math.abs(bx * bz) * 4);
    const lu = bx * su * k + rough * noise(bx, by, bz), lv = bz * sv * k + rough * noise(bz, bx, by);
    const ly = y0 + by * (y1 - y0) + rough * 0.9 * noise(by, bz, bx) * (by > 0.95 ? 1.6 : 1);
    pos.setXYZ(i, x + lu * c - lv * s, ly, z + lu * s + lv * c);
  }
  const flat = g.toNonIndexed();
  g.dispose();
  flat.computeVertexNormals();
  return flat;
}

// --- The pieces --------------------------------------------------------------------------------------------------------

// On the cliff at the end of the plaza: u = 0 at the rock face, y = 0 at the bottom of the lowest bar
function cliffPiece(frame) {
  return [
    bar(frame, [[-0.9, 1.44], [1.05, 1.44]], 0.34, 0.46), // the heavy upper bar out of the rock
    bar(frame, arc(1.45, 1.62, 0.58, 180, 0, 16), 0.3, 0.28), // rising from it in an arch
    bar(frame, smooth([[0.55, 1.36], [1.5, 1.37], [2.05, 1.35], [2.3, 1.29], [2.43, 1.17]], 12), 0.3, 0.34, 0.22), // reaching out
    bar(frame, [[-0.9, 0.16], [0.85, 0.16], ...arc(0.85, 0.46, 0.3, 270, 360, 6).slice(1), [1.15, 1.3]], 0.32, 0.32, 0.26), // lower
    bar(frame, arc(1.45, 0.95, 0.62, 155, 355, 18), 0.3, 0.3, -0.25) // the hook under the knot
  ];
}

// On the big rock: u = 0 at the rock face, y = 0 on the stem's axis
function rockPiece(frame) {
  return [
    bar(frame, [[-0.9, 0], [1.1, 0]], 0.38, 0.44),
    bar(frame, smooth([[0.95, 0.1], [1.2, 0.55], [1.55, 0.95], [1.98, 1.1], [2.3, 0.95], [2.36, 0.6]]), 0.3, 0.3, 0.1),
    bar(frame, smooth([[0.95, -0.15], [1.35, -0.55], [1.85, -0.7], [2.3, -0.55], [2.48, -0.2], [2.42, 0.28]]), 0.3, 0.3, -0.1),
    bar(frame, smooth([[0.9, -0.1], [0.98, -0.7], [0.75, -1.15], [0.25, -1.3], [-0.6, -1.3]], 16), 0.3, 0.3, -0.05)
  ];
}

// Standing on the rock out at sea: u = 0, y = 0 on the rock's top; the loops open sideways (v), facing the plaza
function seaPiece(frame) {
  const parts = [];
  for (const side of [-1, 1]) {
    const u = 0.08 * side;
    const pts = [[u, 0.3 * side, -0.6], [u, 0.31 * side, 1.6]];
    // curl outwards over the top and round, the end coming back towards the post
    for (const [cv, cy] of arc(0, 1.6, 0.4, side < 0 ? 0 : 180, side < 0 ? 320 : -140, 18)) pts.push([u, cv + 0.71 * side, cy]);
    parts.push(bar(frame, pts.slice(0, 2).concat(pts.slice(3)), 0.28, 0.28));
  }
  return parts;
}

// --- Build -------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.at) return null;
  const { terrain } = ctx;
  const bin = new PartBin();
  const rust = createRustMaterial();
  const stone = createRockMaterial();
  const [ex0, ez0, ex1, ez1] = SEA_EDGE;
  const edgeAngle = Math.atan2(ez1 - ez0, ex1 - ex0);
  const granite = createGraniteMaterial(edgeAngle);

  // The terraces: flat granite platforms at the LiDAR's level (the top of what it measured inside), deep enough to
  // stand as walls down the drop to the rocks
  const levels = TERRACES.map((ring) => {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < ring.length; k += 2) {
      minX = Math.min(minX, ring[k]); maxX = Math.max(maxX, ring[k]);
      minZ = Math.min(minZ, ring[k + 1]); maxZ = Math.max(maxZ, ring[k + 1]);
    }
    const hs = [];
    for (let x = minX; x <= maxX; x += 1) {
      for (let z = minZ; z <= maxZ; z += 1) if (pointInRing(x, z, ring)) hs.push(terrain.heightAt(x, z));
    }
    hs.sort((p, q) => p - q);
    return hs.length ? hs[Math.floor(hs.length * 0.9)] + 0.06 : 5.4;
  });
  TERRACES.forEach((ring, k) => bin.add(granite, ctx.kit.prism(ring, Math.min(levels[k] - 1.5, 1.0), levels[k])));
  // the steps between terraces: treads 40 cm deep down from the upper level to the lower, along the riser
  STAIRS.forEach(([x0, z0, x1, z1], k) => {
    const hi = levels[k], lo = levels[k + 1];
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(z1 - z0, x1 - x0);
    // which side is the lower terrace
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2, nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
    const down = pointInRing(mx + nx * 1.5, mz + nz * 1.5, TERRACES[k + 1]) ? 1 : -1;
    const count = Math.max(1, Math.round((hi - lo) / 0.16));
    for (let j = 1; j < count; j++) {
      const top = hi - ((hi - lo) * j) / count;
      const off = down * (0.2 + 0.4 * (j - 1));
      const step = new THREE.BoxGeometry(len, top - lo + 0.3, 0.42);
      step.rotateY(-ang);
      step.translate(mx + nx * off, (top + lo - 0.3) / 2, mz + nz * off);
      bin.add(granite, step);
    }
  });
  // the seven blowholes, in a row a couple of metres in from the lowest terrace's seaward edge: a dark shaft in a
  // ring of granite
  const lowest = levels[2];
  const ex = Math.cos(edgeAngle), ez = Math.sin(edgeAngle);
  for (let k = 0; k < 7; k++) {
    const t = 4 + k * 2.4;
    const hx = ex0 + ex * t - ez * 2.4, hz = ez0 + ez * t + ex * 2.4;
    const ringGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.04, 20);
    ringGeo.translate(hx, lowest + 0.02, hz);
    bin.add(granite, ringGeo);
    const shaft = new THREE.CylinderGeometry(0.2, 0.2, 0.03, 16);
    shaft.translate(hx, lowest + 0.045, hz);
    bin.add(M.paint, shaft, rgb(0x070707));
  }

  // The rocks the pieces grip and the reefs around them (the LiDAR keeps only their footings, at sea level)
  const SAND = rgb(0x93805f), DARK = rgb(0x655848);
  const headingTo = (from, to) => Math.atan2(to[1] - from[1], to[0] - from[0]);
  const upper = levels[0];

  // the cliff piece: anchored in a rock face at the end of the upper terrace, reaching out towards the other two
  const cliffHeading = headingTo(PIECES.cliff, [(PIECES.rock[0] + PIECES.sea[0]) / 2, (PIECES.rock[1] + PIECES.sea[1]) / 2]);
  const cu = [Math.cos(cliffHeading), Math.sin(cliffHeading)];
  const face = [PIECES.cliff[0] - cu[0] * 1.0, PIECES.cliff[1] - cu[1] * 1.0];
  const cliffBase = upper + 1.25;
  bin.add(stone, rock(face[0] - cu[0] * 1.9, face[1] - cu[1] * 1.9, cliffHeading, 3.8, 5.0, 1.0, cliffBase + 4.4, 1, 0.4, 0.12), SAND);
  const behind = [face[0] - cu[0] * 4.2 + cu[1] * 1.2, face[1] - cu[1] * 4.2 - cu[0] * 1.2];
  bin.add(stone, rock(behind[0], behind[1], cliffHeading + 0.3, 4.5, 6.0, 3.0, cliffBase + 6.5, 4, 0.6, 0.3), SAND);
  for (const g of cliffPiece(pieceFrame(face[0], cliffBase, face[1], cliffHeading))) bin.add(rust, g);

  // the rock piece: the big block off the lowest terrace, the claw on its western face reaching back to the cliff
  const rockHeading = headingTo(PIECES.rock, PIECES.cliff);
  const ru = [Math.cos(rockHeading), Math.sin(rockHeading)];
  const rockTop = lowest + 3.0;
  bin.add(stone, rock(PIECES.rock[0] - ru[0] * 2.4, PIECES.rock[1] - ru[1] * 2.4, rockHeading, 4.8, 5.0, -1.5, rockTop, 2, 0.4, 0.1), SAND);
  const shoulder = [PIECES.rock[0] - ru[0] * 4.6 + ru[1] * 1.5, PIECES.rock[1] - ru[1] * 4.6 - ru[0] * 1.5];
  bin.add(stone, rock(shoulder[0], shoulder[1], rockHeading - 0.4, 3.4, 3.6, -1.5, rockTop - 1.9, 5, 0.45, 0.35), DARK);
  for (const g of rockPiece(pieceFrame(PIECES.rock[0], rockTop - 0.32, PIECES.rock[1], rockHeading))) bin.add(rust, g);

  // the sea piece: on its own rock, its loops opening across the view from the plaza
  const seaHeading = headingTo(PIECES.sea, site.at);
  const seaTop = 4.3;
  bin.add(stone, rock(PIECES.sea[0], PIECES.sea[1], seaHeading + 0.4, 3.6, 3.0, -1.6, seaTop, 3, 0.45, 0.45), DARK);
  for (const g of seaPiece(pieceFrame(PIECES.sea[0], seaTop - 0.05, PIECES.sea[1], seaHeading))) bin.add(rust, g);

  // reefs breaking the water around them: [x, z, top above the sea, size]
  const REEFS = [
    [-1346.5, -36.0, 1.6, 2.2], [-1357.5, -38.5, 1.1, 1.8], [-1344.0, -30.5, 2.1, 2.4], [-1360.5, -44.0, 0.9, 1.6],
    [-1369.5, -40.0, 1.5, 2.0], [-1366.0, -46.5, 1.0, 1.5], [-1355.5, -48.5, 1.3, 1.7], [-1357.5, -55.5, 1.6, 1.9],
    [-1367.0, -55.0, 1.1, 1.4], [-1372.5, -34.5, 2.4, 2.2], [-1349.5, -42.0, 0.7, 1.3]
  ];
  REEFS.forEach(([x, z, top, size], k) => {
    bin.add(stone, rock(x, z, k * 1.3, size, size * 0.8, -1.6, top, 10 + k, 0.3, 0.5), DARK);
  });

  const group = new THREE.Group();
  group.name = 'HaizearenOrrazia';
  bin.build(group);
  return group;
}
