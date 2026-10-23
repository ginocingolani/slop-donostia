import * as THREE from 'three/webgpu';
import { float, vec3, abs, fract, mix, smoothstep, positionWorld, normalWorld, mx_noise_float } from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/santa-maria.js
// Basílica de Santa María del Coro (1743-74, baroque): sandstone church at the end of Kale Nagusia at the foot of Urgull, a huge niche portal with a sculpted St Sebastian, one bell tower, the nave aligned towards the Buen Pastor cathedral.
//
// build(sites, ctx) receives the GEO.landmarks entries ['santa-maria'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// Pedro Ignacio Lizardi & Miguel de Salazar's church (1743-74) is a hall of three naves, 48 x 33 m inside, its central
// vault over 27 m high (Wikipedia). Its main front is a retablo-like portal "entre las dos torres": a tall frontispiece
// whose great arched niche holds the door and the martyred St Sebastian, crowned by the city's arms, between the
// bell tower on the west and a slimmer tower on the east. The OSM outline (way 27263141) gives the front's line, facing
// up Kale Nagusia to the Buen Pastor, and its widths: the bell tower 6.4 m, the niche 7.8 m, the east tower 4.5 m.
// Heights fit b5m's LiDAR (roofs averaging ~33 m above sea level, ~39 m at the most) and the 27 m vault: eaves 21 m
// above the portal's step and a hip roof to 29 m, the frontispiece 24.5 m (its crown ~29 m), the bell tower's dome
// ~32 m. The 1:500 outline adds a lower sacristy wing to the east, built to 13 m.

// The front's line between the towers' outer corners (OSM vertices), west to east
const FRONT = [[156.0, -267.95], [176.27, -273.94]];
const WEST_TOWER = [-10.57, -4.2], NICHE = [-3.63, 4.18], EAST_TOWER = [6.02, 10.57]; // metres along the front
const EAVE = 21, RIDGE = 29, WING = 13, FRONT_TOP = 24.5;

// --- small geometry kit (kept local so each landmark module stands alone) ------------------------------------------------

// Pieces collected per material and merged into one mesh each: one draw call per material
class Parts {
  constructor() { this.byMaterial = new Map(); }

  add(material, geometry, matrix = null) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (matrix) g.applyMatrix4(matrix);
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

// Drops a closing vertex that repeats the first (OSM rings) and near-duplicate neighbours
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

// --- materials --------------------------------------------------------------------------------------------------------

// stoneMaterial() of js/donostia/landmarks/kit.js (ashlar courses on vertical faces) plus the floodlights that light
// the front from the street at dusk and night, strongest low down
function floodlitStone(rgb, { courses = 0.55, grain = 0.12, floodBase = 0, floodTop = 30 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const n = mx_noise_float(positionWorld.mul(0.9));
  const base = vec3(...rgb).mul(float(1).sub(grain).add(n.mul(grain)));
  const joint = smoothstep(0.0, 0.025, abs(fract(positionWorld.y.div(courses)).sub(0.5)).sub(0.47)).oneMinus();
  const vertical = smoothstep(0.6, 0.3, abs(normalWorld.y));
  const stone = mix(base, base.mul(0.62), joint.mul(vertical));
  mat.colorNode = stone;
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const flood = smoothstep(float(floodTop), float(floodBase), positionWorld.y).mul(0.55).add(0.45);
  mat.emissiveNode = stone.mul(vec3(1.0, 0.82, 0.6)).mul(night.mul(flood).mul(0.75));
  return mat;
}

const darkMaterial = () => new THREE.MeshStandardNodeMaterial({ color: 0x15120e, roughness: 0.9, metalness: 0 });

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, kit } = ctx;
  const site = sites[0];
  if (!site.footprint) return null;
  const footprint = cleanRing(site.footprint);
  const outline = site.buildings?.length ? cleanRing(GEO.buildings[site.buildings[0]].g[0]) : footprint;

  // the front's frame: s along the front (west to east), t out into the street, y up from the portal's step
  const [[x0, z0], [x1, z1]] = FRONT;
  const flen = Math.hypot(x1 - x0, z1 - z0);
  const e = new THREE.Vector3((x1 - x0) / flen, 0, (z1 - z0) / flen);
  const n = new THREE.Vector3(-e.z, 0, e.x); // e × up: out of the church, up Kale Nagusia
  const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
  const G = kit.groundAt(ctx, mid[0] + n.x * 3, mid[1] + n.z * 3);
  const basis = new THREE.Matrix4().makeBasis(e, new THREE.Vector3(0, 1, 0), n);
  const F = (s, y, t, rotY = 0) => {
    const m = basis.clone().setPosition(mid[0] + e.x * s + n.x * t, G + y, mid[1] + e.z * s + n.z * t);
    return rotY ? m.multiply(new THREE.Matrix4().makeRotationY(rotY)) : m;
  };
  // box of size (w along the front, h, d out from it) whose base centre stands at (s, y, t) in the front's frame
  const box = (w, h, d, s, y, t) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0).applyMatrix4(F(s, y, t));
  // half disc standing in the front's plane, flat side down (arched heads of doors & openings)
  const archHead = (r, d) => new THREE.CylinderGeometry(r, r, d, 14, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2);

  const wall = kit.materials.sandstone;
  const front = floodlitStone([0.66, 0.55, 0.39], { floodBase: G, floodTop: G + 32 });
  const tiles = kit.materials.terracotta;
  const lead = kit.materials.slate;
  const dark = darkMaterial();
  const parts = new Parts();

  // the hall and the sacristy wing, down to the lowest ground (the church is dug into Urgull's foot on the north)
  const base = kit.lowestGround(ctx, outline) - 0.6;
  parts.add(wall, kit.prism(outline, base, G + WING));
  parts.add(wall, kit.prism(footprint, base, G + EAVE));
  const cornice = insetRing(wound(footprint), -0.4);
  if (cornice) parts.add(wall, kit.prism(cornice, G + EAVE - 0.7, G + EAVE));
  const eaves = insetRing(wound(footprint), -0.6) || footprint;
  parts.add(tiles, hipRoof(eaves, G + EAVE, RIDGE - EAVE, kit.orientedBox(footprint).width * 0.46));

  // Frontispiece between the towers: a slab with the great arched niche cut through it, standing out of OSM's line
  // so the niche reads deep; its back is a stone screen standing clear of the 1:500 walls, which jut forward there
  const [ns0, ns1] = NICHE;
  const nc = (ns0 + ns1) / 2, archR = (ns1 - ns0) / 2 - 0.55, spring = 14.2;
  const slabS0 = WEST_TOWER[1] - 0.3, slabS1 = EAST_TOWER[0] + 0.3;
  const front0 = 1.6; // the slab's face, metres out from OSM's line
  const back = 0.35; // the niche's back
  const shape = new THREE.Shape();
  shape.moveTo(slabS0, -0.6);
  shape.lineTo(nc - archR, -0.6);
  shape.lineTo(nc - archR, spring);
  shape.absarc(nc, spring, archR, Math.PI, 0, true);
  shape.lineTo(nc + archR, -0.6);
  shape.lineTo(slabS1, -0.6);
  shape.lineTo(slabS1, FRONT_TOP);
  shape.lineTo(slabS0, FRONT_TOP);
  shape.lineTo(slabS0, -0.6);
  parts.add(front, new THREE.ExtrudeGeometry(shape, { depth: front0 + 1.0, bevelEnabled: false, curveSegments: 16 }), F(0, 0, -1.0));
  // (in the plain stone: the floodlights leave the niche's depth in shadow, so it reads at night)
  parts.add(wall, box(2 * archR + 0.4, spring + archR + 0.2, 0.3, nc, -0.6, back - 0.15));
  // pilasters framing the niche, the impost at the arch's spring, the main cornice across the towers
  for (const s of [nc - archR - 0.45, nc + archR + 0.45]) parts.add(front, box(0.7, FRONT_TOP - 1.2, 0.35, s, 0.4, front0 + 0.1));
  for (const [s0, s1] of [[slabS0, nc - archR], [nc + archR, slabS1]]) {
    parts.add(front, box(s1 - s0, 0.6, 0.6, (s0 + s1) / 2, spring - 0.6, front0 + 0.1));
  }
  parts.add(front, box(EAST_TOWER[1] - WEST_TOWER[0] + 0.8, 0.8, 1.0, (WEST_TOWER[0] + EAST_TOWER[1]) / 2, FRONT_TOP - 0.4, front0));
  // in the niche: the door with its arched head, St Sebastian bound to the tree on a bracket above it, an oculus
  parts.add(dark, box(2.8, 5.0, 0.2, nc, -0.2, back + 0.1));
  parts.add(dark, archHead(1.4, 0.2), F(nc, 4.8, back + 0.1));
  parts.add(front, box(2.2, 0.6, 0.9, nc, 6.6, back + 0.45));
  parts.add(front, new THREE.CylinderGeometry(0.22, 0.28, 3.4, 8).translate(0, 1.7, 0), F(nc, 7.2, back + 0.3));
  parts.add(front, new THREE.CylinderGeometry(0.3, 0.26, 1.7, 10).translate(0, 0.85, 0), F(nc, 7.4, back + 0.65));
  parts.add(front, new THREE.SphereGeometry(0.24, 10, 8).translate(0, 1.95, 0), F(nc, 7.4, back + 0.65));
  parts.add(front, new THREE.CylinderGeometry(0.11, 0.11, 1.3, 6).rotateZ(Math.PI / 2 - 0.5).translate(0, 1.9, 0), F(nc, 7.4, back + 0.6));
  parts.add(dark, new THREE.CylinderGeometry(0.9, 0.9, 0.2, 16).rotateX(Math.PI / 2), F(nc, 12.6, back + 0.1));
  // the crown: the city's arms on an attic with a curved top, urns on the corners, the Virgin on top
  const attic = new THREE.Shape();
  attic.moveTo(-3.0, 0);
  attic.lineTo(3.0, 0);
  attic.lineTo(3.0, 2.6);
  attic.absarc(0, 0.2, 3.85, Math.atan2(2.4, 3.0), Math.PI - Math.atan2(2.4, 3.0), false);
  attic.lineTo(-3.0, 0);
  const atticGeo = new THREE.ExtrudeGeometry(attic, { depth: 1.4, bevelEnabled: false, curveSegments: 12 });
  parts.add(front, atticGeo, F(nc, FRONT_TOP + 0.4, front0 - 1.4));
  parts.add(front, new THREE.CylinderGeometry(1.0, 1.0, 0.35, 16).rotateX(Math.PI / 2), F(nc, FRONT_TOP + 2.0, front0 + 0.15));
  parts.add(front, new THREE.CylinderGeometry(0.3, 0.42, 1.8, 10).translate(0, 0.9, 0), F(nc, FRONT_TOP + 4.0, front0 - 0.7));
  parts.add(front, new THREE.SphereGeometry(0.24, 10, 8).translate(0, 2.0, 0), F(nc, FRONT_TOP + 4.0, front0 - 0.7));
  for (const s of [slabS0 + 0.6, slabS1 - 0.6]) {
    parts.add(front, new THREE.CylinderGeometry(0.28, 0.4, 1.1, 10).translate(0, 0.55, 0), F(s, FRONT_TOP + 0.4, front0 - 0.2));
    parts.add(front, new THREE.SphereGeometry(0.3, 10, 8).translate(0, 1.35, 0), F(s, FRONT_TOP + 0.4, front0 - 0.2));
  }

  // The towers: square shafts a little proud of the front up to the main cornice, an open belfry stage with its own
  // cornice, then a lead dome & lantern on the bell tower and a stone spirelet on the slimmer east tower
  const towers = [{ s: WEST_TOWER, belfry: 28.4, dome: true }, { s: EAST_TOWER, belfry: 27.6, dome: false }];
  for (const t of towers) {
    const w = t.s[1] - t.s[0], sc = (t.s[0] + t.s[1]) / 2, tc = front0 + 0.2 - w / 2;
    parts.add(front, box(w, FRONT_TOP + 0.6, w, sc, -0.6, tc));
    const bw = w - 0.6, b0 = FRONT_TOP + 0.4;
    parts.add(front, box(bw, t.belfry - b0, bw, sc, b0, tc));
    parts.add(front, box(bw + 0.8, 0.6, bw + 0.8, sc, t.belfry, tc));
    // a bell opening in each face of the belfry: dark arched slots just proud of the stone
    const oh = (t.belfry - b0) * 0.55, ow = Math.min(1.9, bw * 0.42), oy = b0 + 0.5;
    const o = bw / 2 + 0.02;
    for (const [ds, dt, rot] of [[0, o, 0], [0, -o, 0], [o, 0, Math.PI / 2], [-o, 0, Math.PI / 2]]) {
      parts.add(dark, new THREE.BoxGeometry(ow, oh, 0.2).translate(0, oh / 2, 0), F(sc + ds, oy, tc + dt, rot));
      parts.add(dark, archHead(ow / 2, 0.2).translate(0, oh, 0), F(sc + ds, oy, tc + dt, rot));
    }
    const top = t.belfry + 0.6;
    if (t.dome) {
      const r = Math.min(2.4, bw / 2 - 0.2);
      parts.add(front, new THREE.CylinderGeometry(r, r, 0.6, 8).translate(0, 0.3, 0), F(sc, top, tc));
      parts.add(lead, new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), F(sc, top + 0.6, tc));
      parts.add(lead, new THREE.CylinderGeometry(0.42, 0.5, 1.3, 8).translate(0, 0.65, 0), F(sc, top + 0.6 + r - 0.15, tc));
      parts.add(lead, new THREE.SphereGeometry(0.34, 10, 8).translate(0, 1.6, 0), F(sc, top + 0.6 + r - 0.15, tc));
    } else {
      parts.add(lead, new THREE.ConeGeometry(bw / 2 + 0.25, 2.4, 4).rotateY(Math.PI / 4).translate(0, 1.2, 0), F(sc, top, tc));
      parts.add(front, new THREE.SphereGeometry(0.3, 10, 8).translate(0, 2.6, 0), F(sc, top, tc));
    }
    // urns on the belfry cornice's corners
    for (const [ds, dt] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      const urn = new THREE.CylinderGeometry(0.2, 0.3, 0.9, 8).translate(0, 0.45, 0);
      parts.add(front, urn, F(sc + ds * (bw / 2 + 0.15), top, tc + dt * (bw / 2 + 0.15)));
    }
  }

  const group = parts.build('santa-maria');
  group.userData.front = { x: mid[0], z: mid[1], y: G, facing: [n.x, n.z] };
  return group;
}
