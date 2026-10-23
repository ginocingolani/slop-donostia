import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, abs, fract, sin, max, min, mix, step, smoothstep, fwidth, length, uv, positionWorld, positionView,
  normalView, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/kursaal.js
// Kursaal (1999, Rafael Moneo): two leaning translucent glass prisms — the large auditorium (~27 m) and the chamber hall — on a dark stone podium at the mouth of the Urumea facing Zurriola beach; frosted, faintly green glass that glows from inside at night. The three OSM sites (palace, auditorium, chamber hall) are one model.
//
// build(sites, ctx) receives the GEO.landmarks entries ['kursaal', 'kursaal-auditorium', 'kursaal-kamara'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// Dimensions from Moneo's project report (Arquitectura 309, 1997): the auditorium is a 60 x 48 x 27 m prism "dinamizado
// por una ligera inclinación hacia el mar", the congress hall a 42 x 36 x 24 m one, also leaning. Each wall is a double
// skin of glass: flat inside, curved outside, 250 x 60 cm pieces of 19 mm glass laminated with fluted glass, held by
// horizontal aluminium bars, hence the fine horizontal ribbing. Both stand on the low podium of foyers and halls that
// the municipal map draws as one outline; their centres and orientations come from the OSM outlines, their tops are
// checked against b5m's LiDAR maxima (38.3 m and ~30 m above sea level). OSM gives each roof a slope rising towards the
// prism's outer end (roof:direction 130° and 238° are the low sides) and the leans tilt both towards the sea.

const PRISMS = {
  'kursaal-auditorium': { length: 60, width: 48, low: 26.5, high: 30.5, lowSide: 130, window: { face: 'west', w: 17, y0: 12, y1: 19 } },
  'kursaal-kamara': { length: 42, width: 36, low: 20.5, high: 23.5, lowSide: 238, window: { face: 'east', w: 11, y0: 9, y1: 14 } }
};
const LEAN = THREE.MathUtils.degToRad(4.5); // towards the sea: the tops overhang their feet by about 2 m
const PANEL_W = 2.5, PANEL_H = 0.6; // the curved glass pieces
const PODIUM_ABOVE = 0.15; // the podium roof sits just over the LiDAR's terrace (which the DTM records as ground)

// --- small geometry kit (kept local so each landmark module stands alone) ------------------------------------------------

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

// Flat-shaded faces with uvs; each face is turned so its normal agrees with the `out` hint
class Soup {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }

  face(points, uvs, out) {
    const [a, b, c] = points;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= l; ny /= l; nz /= l;
    let order = points.length === 4 ? [0, 1, 2, 0, 2, 3] : [0, 1, 2];
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) {
      nx = -nx; ny = -ny; nz = -nz;
      order = order.slice().reverse();
    }
    for (const k of order) {
      this.pos.push(...points[k]);
      this.nrm.push(nx, ny, nz);
      this.uv.push(...uvs[k]);
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    return g;
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

const bearing = (deg) => [Math.sin(THREE.MathUtils.degToRad(deg)), -Math.cos(THREE.MathUtils.degToRad(deg))]; // (x east, z south)

// --- TSL helpers (from js/tsl-materials.js) --------------------------------------------------------------------------

// Filter-width anti-aliased repeating grid line: gridLine() in js/tsl-materials.js
const gridLine = Fn(([coord, period, halfWidth]) => {
  const p = float(period).toVar();
  const g = float(coord).div(p).toVar();
  const d = float(0.5).sub(abs(fract(g).sub(0.5))).toVar();
  const aa = fwidth(g).max(0.0001).toVar();
  const hw = float(halfWidth).div(p).toVar();
  const effHw = max(hw, aa.mul(0.5)).toVar();
  const cov = smoothstep(effHw.add(aa), effHw.sub(aa), d);
  return cov.mul(min(float(1.0), hw.div(effHw)));
});

// Surface-gradient bump mapping from a scalar height (view-space normal): bumpNormal() in js/tsl-materials.js
const bumpNormal = Fn(([height]) => {
  const h = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(h.dFdx().mul(r1).add(h.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// --- materials --------------------------------------------------------------------------------------------------------

// Frosted laminated glass in 60 cm courses of curved pieces: each course bulges out and catches the light at its crown,
// the aluminium bars between them read as fine dark lines; at dusk and night the whole prism glows from inside.
// uv.x = metres along the prism's walls.
function glassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0 });
  const u = uv().x, y = positionWorld.y;
  const course = fract(y.div(PANEL_H));
  // the bulge settles to its mean (2 / pi) once a course spans fewer than ~8 pixels, so distant prisms don't moiré
  const fine = smoothstep(0.3, 0.1, fwidth(y.div(PANEL_H)));
  const bulge = mix(float(2 / Math.PI), sin(course.mul(Math.PI)), fine);
  const bars = gridLine(y, PANEL_H, 0.03);
  const joints = gridLine(u, PANEL_W, 0.018);
  const cloud = mx_noise_float(vec3(u.mul(0.05), y.mul(0.08), 0.5)).mul(0.035);
  const glass = vec3(0.76, 0.83, 0.79).mul(bulge.mul(0.12).add(0.88).add(cloud));
  mat.colorNode = glass.mul(bars.mul(0.42).oneMinus()).mul(joints.mul(0.18).oneMinus());
  mat.roughnessNode = mix(float(0.34), float(0.55), bars);
  mat.normalNode = Fn(() => {
    const fade = smoothstep(160.0, 30.0, length(positionWorld.sub(cameraPosition))).mul(fine);
    return bumpNormal(bulge.mul(0.03).mul(fade));
  })();
  // lit halls and foyers behind the glass, brightest at the crown of each course
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const rooms = mx_noise_float(vec3(u.mul(0.09), y.mul(0.13), 3.1)).mul(0.18).add(0.86);
  mat.emissiveNode = vec3(1.0, 0.93, 0.79).mul(night.mul(1.1).mul(rooms).mul(bulge.mul(0.3).add(0.7)).mul(bars.mul(0.75).oneMinus()));
  return mat;
}

// Dark podium: charcoal cladding in horizontal bands; the street fronts (uv.y = 1) glazed, lit warm at night.
// uv.x = metres along the podium's walls.
function podiumMaterial(streetY, top) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.62, metalness: 0.15 });
  const u = uv().x, glazedWall = uv().y, y = positionWorld.y;
  const vertical = smoothstep(0.5, 0.2, abs(normalWorld.y));
  const bands = gridLine(y, 0.45, 0.025).mul(vertical);
  const glazing = glazedWall.mul(step(streetY + 0.25, y)).mul(step(y, top - 0.75)).mul(vertical);
  const pane = glazing.mul(gridLine(u, 1.8, 0.05).oneMinus());
  const cladding = vec3(0.075, 0.08, 0.082).mul(bands.mul(0.4).oneMinus());
  mat.colorNode = mix(cladding, vec3(0.03, 0.04, 0.05), pane);
  mat.roughnessNode = mix(float(0.62), float(0.12), pane);
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  mat.emissiveNode = vec3(1.0, 0.78, 0.52).mul(pane.mul(night).mul(0.9));
  return mat;
}

// --- geometry --------------------------------------------------------------------------------------------------------

// A leaning glass prism with a sloping roof. Returns the wall soup, the roof soup and a function giving points on a
// wall's plane (for the windows).
function leaningPrism(box, spec, y0, seaDir) {
  const [ax, az] = [Math.cos(box.angle), Math.sin(box.angle)]; // long axis
  const [bx, bz] = [-az, ax];
  const hl = spec.length / 2, hw = spec.width / 2;
  const base = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([s, t]) => [box.x + ax * s + bx * t, box.z + az * s + bz * t]);
  // roof height: rises linearly away from the OSM low side
  const [lx, lz] = bearing(spec.lowSide);
  const proj = base.map(([x, z]) => (x - box.x) * lx + (z - box.z) * lz);
  const pMin = Math.min(...proj), pMax = Math.max(...proj);
  const heights = proj.map((p) => spec.high + ((p - pMin) / (pMax - pMin)) * (spec.low - spec.high));
  const tan = Math.tan(LEAN);
  const top = base.map(([x, z], k) => [x + seaDir[0] * tan * heights[k], y0 + heights[k], z + seaDir[1] * tan * heights[k]]);
  const bottom = base.map(([x, z]) => [x, y0, z]);
  const walls = new Soup(), roof = new Soup();
  let u = 0;
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const len = Math.hypot(base[j][0] - base[i][0], base[j][1] - base[i][1]);
    const mx = (base[i][0] + base[j][0]) / 2 - box.x, mz = (base[i][1] + base[j][1]) / 2 - box.z;
    const out = [mx, 0, mz];
    walls.face([bottom[i], bottom[j], top[j], top[i]], [[u, 0], [u + len, 0], [u + len, 1], [u, 1]], out);
    faces.push({ i, j, len, out: [mx / Math.hypot(mx, mz), mz / Math.hypot(mx, mz)] });
    u += len;
  }
  roof.face(top, top.map((p) => [p[0], p[2]]), [0, 1, 0]);
  // point on face f at fraction t along its bottom edge and h metres up the (leaning) wall
  const onFace = (f, t, h, off) => {
    const a = base[f.i], b = base[f.j];
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    return [x + seaDir[0] * tan * h + f.out[0] * off, y0 + h, z + seaDir[1] * tan * h + f.out[1] * off];
  };
  return { walls, roof, faces, onFace, top: Math.max(...heights) + y0 };
}

// Walls of a ring between y0 and y1 with uv = (metres along the walls, 1 on walls facing `glazeDir`), plus the roof cap
function podium(ring, y0, y1, glazeDir) {
  const r = wound(cleanRing(ring));
  const s = new Soup();
  let u = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02) continue;
    const ox = (bz - az) / len, oz = -(bx - ax) / len;
    const glazed = len > 4 && ox * glazeDir[0] + oz * glazeDir[1] > 0.55 ? 1 : 0;
    const uvs = [[u, glazed], [u + len, glazed], [u + len, glazed], [u, glazed]];
    s.face([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], uvs, [ox, 0, oz]);
    u += len;
  }
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
    s.face([[pts[a].x, y1, pts[a].y], [pts[b].x, y1, pts[b].y], [pts[c].x, y1, pts[c].y]], [[0, 0], [0, 0], [0, 0]], [0, 1, 0]);
  }
  return s.geometry();
}

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, kit } = ctx;
  const palace = sites.find((s) => s.id === 'kursaal');
  const prisms = sites.filter((s) => PRISMS[s.id] && s.footprint);
  if (!prisms.length) return null;
  const hiddenIdx = palace?.buildings?.[0] ?? prisms[0].buildings?.[0];
  const outline = cleanRing(hiddenIdx != null ? GEO.buildings[hiddenIdx].g[0] : palace?.footprint || prisms[0].footprint);

  // podium top: just above the highest LiDAR "ground" inside the outline (the terrace on the podium's roof)
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < outline.length; k += 2) lo = Math.min(lo, kit.groundAt(ctx, outline[k], outline[k + 1]));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < outline.length; k += 2) {
    minX = Math.min(minX, outline[k]); maxX = Math.max(maxX, outline[k]);
    minZ = Math.min(minZ, outline[k + 1]); maxZ = Math.max(maxZ, outline[k + 1]);
  }
  for (let x = minX; x <= maxX; x += 3) {
    for (let z = minZ; z <= maxZ; z += 3) if (pointInRing(x, z, outline)) hi = Math.max(hi, kit.groundAt(ctx, x, z));
  }
  const street = lo;
  const podiumTop = Math.max(hi + PODIUM_ABOVE, street + 3);

  const parts = new Parts();
  const glass = glassMaterial();
  const roofMat = new THREE.MeshStandardNodeMaterial({ color: 0x8e918c, roughness: 0.85, metalness: 0 });
  // the avenue runs along the outline's landward (south) side
  parts.add(podiumMaterial(street, podiumTop), podium(outline, street - 0.6, podiumTop, [0, 1]));

  let top = podiumTop;
  for (const site of prisms) {
    const spec = PRISMS[site.id];
    const box = kit.orientedBox(cleanRing(site.footprint));
    if (!box) continue;
    // lean towards the sea: of the box's four sides, the one facing most to the north (-z)
    let seaDir = [0, -1], best = -Infinity;
    for (let k = 0; k < 4; k++) {
      const a = box.angle + (k * Math.PI) / 2;
      if (-Math.sin(a) > best) { best = -Math.sin(a); seaDir = [Math.cos(a), Math.sin(a)]; }
    }
    const y0 = kit.lowestGround(ctx, site.footprint) - 0.6;
    const p = leaningPrism(box, spec, y0, seaDir);
    parts.add(glass, p.walls.geometry());
    parts.add(roofMat, p.roof.geometry());
    top = Math.max(top, p.top);
    // the large foyer window, clear glass in the frosted skin (the auditorium's frames Urgull, the chamber hall's the sea)
    const want = spec.window.face === 'west' ? [-1, 0] : [1, 0];
    const f = p.faces.reduce((b, f) => (f.out[0] * want[0] + f.out[1] * want[1] > b.out[0] * want[0] + b.out[1] * want[1] ? f : b));
    const t0 = 0.5 - spec.window.w / 2 / f.len, t1 = 0.5 + spec.window.w / 2 / f.len;
    const { y0: h0, y1: h1 } = spec.window;
    const win = new Soup();
    win.face([p.onFace(f, t0, h0, 0.12), p.onFace(f, t1, h0, 0.12), p.onFace(f, t1, h1, 0.12), p.onFace(f, t0, h1, 0.12)],
      [[0, 0], [1, 0], [1, 1], [0, 1]], [f.out[0], 0, f.out[1]]);
    parts.add(kit.materials.glass, win.geometry());
  }

  const group = parts.build('kursaal');
  group.userData.top = top;
  return group;
}
