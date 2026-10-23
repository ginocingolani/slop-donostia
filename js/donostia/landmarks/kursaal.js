import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, abs, floor, fract, sin, cos, dot, max, min, mix, clamp, pow, step, smoothstep, fwidth, length,
  normalize, uv, positionWorld, positionView, normalView, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';

// js/donostia/landmarks/kursaal.js
// Kursaal (1999, Rafael Moneo): two leaning translucent glass prisms — the large auditorium (~27 m) and the chamber hall — on a stone podium at the mouth of the Urumea facing Zurriola beach; grey-green ribbed glass by day that glows from inside at night. The three OSM sites (palace, auditorium, chamber hall) are one model.
//
// build(sites, ctx) receives the GEO.landmarks entries ['kursaal', 'kursaal-auditorium', 'kursaal-kamara'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// Dimensions from Moneo's project report (Arquitectura 309, 1997): the auditorium is a 60 x 48 x 27 m prism "dinamizado
// por una ligera inclinación hacia el mar", the congress hall a 42 x 36 x 24 m one, also leaning. Each wall is a double
// skin of glass: flat inside, curved outside, 250 x 60 cm pieces of 19 mm glass laminated with fluted glass, held by
// horizontal aluminium bars, hence the dense horizontal ribbing. Both stand on the low podium of foyers and halls that
// the municipal map draws as one outline; their centres, orientations and sizes come from the OSM outlines, whose
// auditorium edges the 1:500 map traces too (72 x 54 and 46 x 35 m, larger than the report's round figures and closer
// to the photographs' proportions), their tops are checked against b5m's LiDAR maxima (38.3 m and ~30 m above sea
// level). OSM gives each roof a slope rising towards the
// prism's outer end (roof:direction 130° and 238° are the low sides) and the leans tilt both towards the sea.
//
// What the photographs show (Wikimedia Commons: Mariordo 2012, Josugoni; see the reference set): the skin reads as
// grey-green, not white, by day; every 60 cm course is a light rib over a darker band; the 2.5 m pieces' joints line up
// within bands of five courses (3 m) and step by half a piece from one band to the next; the walls run up past the roof
// as a parapet, over a grey roof crossed by skylight strips. The skin is pierced by a few deep-set windows only: on the
// auditorium's face to the esplanade a small square one high in the middle, a wide one low on the right and a small one
// low on the left. The podium is clad in grey slate laid as a mosaic of short sticks under a pale stone coping, and opens
// onto the avenue as the glazed, awninged front of the restaurant.

const PRISMS = {
  'kursaal-auditorium': {
    low: 26.5, high: 30.5, lowSide: 130,
    // face: compass bearing of the wall's outward normal; r0..r1: share of the wall from its left end as seen from
    // outside; h0..h1: metres above the prism's foot (Mariordo's photos 2579/2588/2592, scaled on the 60 m face)
    windows: [
      { face: 315, r0: 0.58, r1: 0.623, h0: 11.0, h1: 13.6 },
      { face: 315, r0: 0.70, r1: 0.83, h0: 3.2, h1: 8.2 },
      { face: 315, r0: 0.13, r1: 0.19, h0: 3.6, h1: 6.6 },
      { face: 45, r0: 0.15, r1: 0.21, h0: 2.2, h1: 5.4 }
    ]
  },
  'kursaal-kamara': {
    low: 20.5, high: 23.5, lowSide: 238,
    windows: [{ face: 45, r0: 0.69, r1: 0.83, h0: 2.4, h1: 5.6 }]
  }
};
const LEAN = THREE.MathUtils.degToRad(4.5); // towards the sea: the tops overhang their feet by about 2 m
const PANEL_W = 2.5, PANEL_H = 0.6; // the curved glass pieces
const BAND = 5; // courses per band of aligned joints
const PARAPET = 1.2; // the glass skin runs up past the roof
const BASE_BAND = 3.0; // dark stone & doors at the foot of the skin, metres above the (buried) foot
const SKIN_OUT = 0.3; // the skin stands just outside the outline, so the podium's walls under it stay hidden
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

  // Hexahedron from 8 corners (bottom four, then the four above them), faces turned out from its centre
  hexa(c, uvOf = () => [0, 0]) {
    const centre = [0, 1, 2].map((k) => c.reduce((s, p) => s + p[k], 0) / 8);
    for (const q of [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) {
      const pts = q.map((k) => c[k]);
      const fc = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / 4);
      this.face(pts, pts.map(uvOf), [fc[0] - centre[0], fc[1] - centre[1], fc[2] - centre[2]]);
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

// Box-filtered periodic pulse: the share of a footprint `w` wide around x where fract() lies in [a, b]; settles to the
// mean (b - a) once a period shrinks below a pixel, so the dense courses don't moiré. filteredPulse() in
// js/tsl-materials.js.
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
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

const hash2 = (p) => fract(sin(dot(p, vec2(12.9898, 78.233))).mul(43758.5453));

// --- materials --------------------------------------------------------------------------------------------------------

// The laminated glass skin. uv = (metres along the prism's walls, metres above its foot). Each 60 cm course is a curved
// piece: a light rib (the aluminium bar and the crown of the curve) over a darker band where the curve turns in, then the
// fluted glass body; the 2.5 m pieces' joints line up within 3 m bands and step by half a piece between them, with a
// heavier transom between bands. Grey-green by day, faintly mottled piece by piece and catching the sky at grazing
// angles; at dusk the halls light it from inside, the glass bodies glowing between darker bars.
function glassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.05 });
  const u = uv().x, h = uv().y, y = positionWorld.y;
  // the "shared" prelude: every pattern below is built once, outside any branch, and reused by all four outputs
  const cy = y.div(PANEL_H);
  const fwC = fwidth(cy);
  const course = fract(cy);
  const rib = filteredPulse(cy, 0.88, 1.0, fwC);
  const shade = filteredPulse(cy, 0.62, 0.88, fwC);
  const bandH = PANEL_H * BAND;
  const band = floor(y.div(bandH));
  const shift = fract(band.mul(0.5)).mul(PANEL_W); // half a piece on every other band
  const su = u.add(shift).div(PANEL_W);
  const joint = filteredPulse(su.add(0.008), 0.0, 0.016, fwidth(su));
  const transom = filteredPulse(y.div(bandH).add(0.03), 0.0, 0.06, fwidth(y.div(bandH)));
  // per piece & band tone, fading out before a piece shrinks to a few pixels (no sparkle at distance)
  const far = smoothstep(0.25, 0.6, fwidth(su));
  const tone = hash2(vec2(floor(su), band)).sub(0.5).mul(0.09).mul(far.oneMinus());
  const cloud = mx_noise_float(vec3(u.mul(0.04), y.mul(0.05), 0.5)).mul(0.05);
  const base = smoothstep(BASE_BAND + 0.04, BASE_BAND - 0.04, h);
  // glazed doors, 1.8 m wide every 9 m, in the dark stone footing
  const doors = filteredPulse(u.div(9.0), 0.4, 0.6, fwidth(u.div(9.0))).mul(step(h, BASE_BAND - 0.5));

  const body = vec3(0.42, 0.52, 0.46).mul(float(1).add(tone).add(cloud));
  const ribCol = vec3(0.66, 0.74, 0.69);
  let glass = mix(body, body.mul(0.62), shade);
  glass = mix(glass, ribCol, rib);
  glass = mix(glass, vec3(0.62, 0.7, 0.65), max(joint.mul(0.75), transom.mul(0.85)));
  // the sky in the outer glass at grazing angles
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 4.0);
  glass = mix(glass, cityUniforms.uSkyHorizonColor.mul(0.8), fres.mul(0.5));
  const stone = vec3(0.26, 0.26, 0.25).mul(cloud.add(0.95));
  const footing = mix(stone, vec3(0.03, 0.04, 0.045), doors);
  mat.colorNode = mix(glass, footing, base);
  mat.roughnessNode = mix(mix(float(0.28), float(0.45), max(rib, transom)), mix(float(0.7), float(0.1), doors), base);

  // the bulge of each course, settling to flat once a course spans fewer than ~8 pixels
  const fine = smoothstep(0.3, 0.1, fwC);
  mat.normalNode = Fn(() => {
    const fade = smoothstep(160.0, 30.0, length(positionWorld.sub(cameraPosition))).mul(fine);
    return bumpNormal(sin(course.mul(Math.PI)).mul(0.03).mul(fade));
  })();

  // lit halls and foyers behind the glass: the bodies glow, the bars and joints stay darker; brightest low down where
  // the foyers are, with the odd darker hall
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const rooms = mx_noise_float(vec3(u.mul(0.06), y.mul(0.09), 3.1)).mul(0.22).add(0.88);
  const lift = smoothstep(32.0, 4.0, h).mul(0.25).add(0.75);
  const glowMask = float(1).sub(rib.mul(0.7)).sub(shade.mul(0.3)).sub(max(joint, transom).mul(0.6)).max(0.0);
  const skinGlow = vec3(1.0, 0.9, 0.74).mul(glowMask.mul(rooms).mul(lift).mul(0.22));
  const doorGlow = vec3(1.0, 0.78, 0.5).mul(doors.mul(0.6));
  mat.emissiveNode = mix(skinGlow, doorGlow, base).mul(night);
  return mat;
}

// The windows' panes: dark glass catching the sky at grazing angles, the foyers behind them lit at night
function paneMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.08, metalness: 0.2 });
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  mat.colorNode = mix(vec3(0.03, 0.04, 0.05), cityUniforms.uSkyHorizonColor.mul(0.6), fres.mul(0.7).add(0.1));
  mat.emissiveNode = vec3(1.0, 0.82, 0.56).mul(smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow).mul(0.45));
  return mat;
}

// Grey roofs inside the parapets, crossed by lighter skylight strips. uv = (metres along the prism's long axis, across).
function roofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.85, metalness: 0 });
  const s = uv().x;
  const strip = filteredPulse(s.div(7.5).add(0.2), 0.0, 0.3, fwidth(s.div(7.5)));
  const grain = mx_noise_float(positionWorld.mul(0.3)).mul(0.05).add(1.0);
  mat.colorNode = mix(vec3(0.24, 0.25, 0.25), vec3(0.42, 0.44, 0.44), strip).mul(grain);
  mat.roughnessNode = mix(float(0.85), float(0.35), strip);
  return mat;
}

// The podium: grey slate laid as a mosaic of short sticks at random angles, under a pale stone coping, with a grey
// paved terrace on top; the avenue front (uv.y = 1) is the restaurant's glazing in grey frames, lit warm at night.
// uv.x = metres along the podium's walls.
function podiumMaterial(streetY, top) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.75, metalness: 0 });
  const u = uv().x, glazedWall = uv().y, y = positionWorld.y;
  const vertical = smoothstep(0.5, 0.2, abs(normalWorld.y));
  const roof = float(1).sub(vertical);
  // slate sticks: 0.6 m cells, each laid at its own angle, ~5 sticks across a cell; fade before they alias
  const p = vec2(u, y).div(0.6);
  const cell = floor(p);
  const a = hash2(cell).mul(Math.PI);
  const along = dot(fract(p), vec2(cos(a), sin(a))).mul(5.0);
  const fw = fwidth(p.x).add(fwidth(p.y));
  const sticks = filteredPulse(along, 0.0, 0.18, fwidth(along)).mul(smoothstep(0.35, 0.12, fw));
  const slate = vec3(0.2, 0.2, 0.19).mul(hash2(cell.add(7.1)).mul(0.12).add(0.92)).mul(float(1).sub(sticks.mul(0.45)));
  const coping = step(top - 0.55, y).mul(vertical);
  const paving = filteredPulse(positionWorld.x.div(1.2), 0.0, 0.03, fwidth(positionWorld.x.div(1.2)))
    .add(filteredPulse(positionWorld.z.div(1.2), 0.0, 0.03, fwidth(positionWorld.z.div(1.2)))).min(1.0);
  const terrace = vec3(0.3, 0.3, 0.29).mul(float(1).sub(paving.mul(0.25)));
  // the restaurant: glass between grey mullions every 2.4 m, a grey fascia over the lower storey and at the top
  const glazing = glazedWall.mul(step(streetY + 0.25, y)).mul(step(y, top - 0.9)).mul(vertical);
  const fascia = step(streetY + 3.1, y).mul(step(y, streetY + 3.8)).add(step(top - 1.5, y)).min(1.0);
  const mullion = filteredPulse(u.div(2.4).add(0.02), 0.0, 0.04, fwidth(u.div(2.4)));
  const pane = glazing.mul(float(1).sub(fascia)).mul(float(1).sub(mullion));
  const frame = glazing.mul(float(1).sub(pane));
  let col = mix(slate, vec3(0.5, 0.49, 0.46), coping);
  col = mix(col, vec3(0.2, 0.21, 0.22), frame);
  col = mix(col, vec3(0.03, 0.04, 0.05), pane);
  mat.colorNode = mix(col, terrace, roof);
  mat.roughnessNode = mix(mix(float(0.78), float(0.12), pane), float(0.9), roof);
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const lit = mx_noise_float(vec3(u.mul(0.15), 0.0, 1.7)).mul(0.3).add(0.8);
  mat.emissiveNode = vec3(1.0, 0.78, 0.52).mul(pane.mul(night).mul(lit).mul(0.9));
  return mat;
}

// --- geometry --------------------------------------------------------------------------------------------------------

// A leaning glass prism with a sloping roof sunk inside a parapet. Returns the skin soup (outer walls and the parapet's
// inner faces), the roof soup and the walls with a function giving points on a wall's plane (for the windows).
function leaningPrism(box, spec, y0, seaDir) {
  const [ax, az] = [Math.cos(box.angle), Math.sin(box.angle)]; // long axis
  const [bx, bz] = [-az, ax];
  const hl = box.length / 2 + SKIN_OUT, hw = box.width / 2 + SKIN_OUT;
  const local = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]];
  const base = local.map(([s, t]) => [box.x + ax * s + bx * t, box.z + az * s + bz * t]);
  // roof height: rises linearly away from the OSM low side
  const [lx, lz] = bearing(spec.lowSide);
  const proj = base.map(([x, z]) => (x - box.x) * lx + (z - box.z) * lz);
  const pMin = Math.min(...proj), pMax = Math.max(...proj);
  const heights = proj.map((p) => spec.high + ((p - pMin) / (pMax - pMin)) * (spec.low - spec.high));
  const tan = Math.tan(LEAN);
  const lean = (x, z, h) => [x + seaDir[0] * tan * h, y0 + h, z + seaDir[1] * tan * h];
  const top = base.map(([x, z], k) => lean(x, z, heights[k]));
  const sunk = base.map(([x, z], k) => lean(x, z, heights[k] - PARAPET));
  const bottom = base.map(([x, z]) => [x, y0, z]);
  const skin = new Soup(), roof = new Soup();
  let u = 0;
  const faces = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const len = Math.hypot(base[j][0] - base[i][0], base[j][1] - base[i][1]);
    const mx = (base[i][0] + base[j][0]) / 2 - box.x, mz = (base[i][1] + base[j][1]) / 2 - box.z;
    const ml = Math.hypot(mx, mz);
    skin.face([bottom[i], bottom[j], top[j], top[i]], [[u, 0], [u + len, 0], [u + len, heights[j]], [u, heights[i]]], [mx, 0, mz]);
    // the parapet's inner face, looking back over the roof
    skin.face([sunk[i], sunk[j], top[j], top[i]],
      [[u, heights[i] - PARAPET], [u + len, heights[j] - PARAPET], [u + len, heights[j]], [u, heights[i]]], [-mx, 0, -mz]);
    faces.push({ i, j, len, out: [mx / ml, mz / ml] });
    u += len;
  }
  roof.face(sunk, local, [0, 1, 0]);
  // coping along the parapet's top
  for (const f of faces) {
    const a = top[f.i], b = top[f.j];
    roof.face([a, b, [b[0] - f.out[0] * 0.35, b[1], b[2] - f.out[1] * 0.35], [a[0] - f.out[0] * 0.35, a[1], a[2] - f.out[1] * 0.35]],
      [[0, 0], [0, 0], [0, 0], [0, 0]], [0, 1, 0]);
  }
  // point on face f at fraction t along its bottom edge, h metres up the (leaning) wall, `off` metres out of it
  const onFace = (f, t, h, off) => {
    const a = base[f.i], b = base[f.j];
    const x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
    return [x + seaDir[0] * tan * h + f.out[0] * off, y0 + h, z + seaDir[1] * tan * h + f.out[1] * off];
  };
  return { skin, roof, faces, onFace, top: Math.max(...heights) + y0 };
}

// A deep-set window in a prism's skin: a dark pane just proud of the glass inside an aluminium reveal standing out of
// it (the skin is a double layer some 60 cm deep, so the openings read as deep boxes)
function prismWindow(p, f, t0, t1, h0, h1, glassSoup, frameSoup) {
  const D = 0.55, T = 0.22; // reveal depth out of the skin, frame thickness
  glassSoup.face([p.onFace(f, t0, h0, 0.04), p.onFace(f, t1, h0, 0.04), p.onFace(f, t1, h1, 0.04), p.onFace(f, t0, h1, 0.04)],
    [[0, 0], [1, 0], [1, 1], [0, 1]], [f.out[0], 0, f.out[1]]);
  const dt = T / f.len;
  const side = (a0, a1, b0, b1) => frameSoup.hexa([
    p.onFace(f, a0, b0, 0), p.onFace(f, a1, b0, 0), p.onFace(f, a1, b0, D), p.onFace(f, a0, b0, D),
    p.onFace(f, a0, b1, 0), p.onFace(f, a1, b1, 0), p.onFace(f, a1, b1, D), p.onFace(f, a0, b1, D)
  ]);
  side(t0 - dt, t1 + dt, h0 - T, h0); // sill
  side(t0 - dt, t1 + dt, h1, h1 + T); // head
  side(t0 - dt, t0, h0, h1); // jambs
  side(t1, t1 + dt, h0, h1);
}

// Walls of a ring between y0 and y1 with uv = (metres along the walls, 1 on walls facing `glazeDir`), plus the roof cap.
// Returns the geometry and the glazed walls (for the restaurant's awnings).
function podium(ring, y0, y1, glazeDir) {
  const r = wound(cleanRing(ring));
  const s = new Soup();
  const glazedWalls = [];
  let u = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02) continue;
    const ox = (bz - az) / len, oz = -(bx - ax) / len;
    const glazed = len > 4 && ox * glazeDir[0] + oz * glazeDir[1] > 0.55 ? 1 : 0;
    if (glazed) glazedWalls.push({ a: [ax, az], b: [bx, bz], len, out: [ox, oz] });
    const uvs = [[u, glazed], [u + len, glazed], [u + len, glazed], [u, glazed]];
    s.face([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]], uvs, [ox, 0, oz]);
    u += len;
  }
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
    s.face([[pts[a].x, y1, pts[a].y], [pts[b].x, y1, pts[b].y], [pts[c].x, y1, pts[c].y]], [[0, 0], [0, 0], [0, 0]], [0, 1, 0]);
  }
  return { geometry: s.geometry(), glazedWalls };
}

// White canvas awnings over the restaurant's glazing: one per 4.8 m bay, sloping 1.8 m out from the fascia
function awnings(walls, y, soup) {
  for (const w of walls) {
    const n = Math.floor(w.len / 4.8);
    if (n < 1) continue;
    const pad = (w.len - n * 4.8) / 2;
    const dx = (w.b[0] - w.a[0]) / w.len, dz = (w.b[1] - w.a[1]) / w.len;
    for (let k = 0; k < n; k++) {
      const s0 = pad + k * 4.8 + 0.15, s1 = s0 + 4.5;
      const at = (s, out, dy) => [w.a[0] + dx * s + w.out[0] * out, y + dy, w.a[1] + dz * s + w.out[1] * out];
      soup.hexa([at(s0, 0.05, -0.08), at(s1, 0.05, -0.08), at(s1, 1.8, -0.98), at(s0, 1.8, -0.98),
        at(s0, 0.05, 0), at(s1, 0.05, 0), at(s1, 1.8, -0.9), at(s0, 1.8, -0.9)]);
      // the valance hanging at the front
      soup.hexa([at(s0, 1.78, -1.25), at(s1, 1.78, -1.25), at(s1, 1.84, -1.25), at(s0, 1.84, -1.25),
        at(s0, 1.78, -0.92), at(s1, 1.78, -0.92), at(s1, 1.84, -0.92), at(s0, 1.84, -0.92)]);
    }
  }
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
  const roofMat = roofMaterial();
  const aluminium = new THREE.MeshStandardNodeMaterial({ color: 0xb4bab8, roughness: 0.45, metalness: 0.15 });
  const canvas = new THREE.MeshStandardNodeMaterial({ color: 0xe8e4d8, roughness: 0.85, metalness: 0 });
  // the avenue runs along the outline's landward (south) side
  const pod = podium(outline, street - 0.6, podiumTop, [0, 1]);
  parts.add(podiumMaterial(street, podiumTop), pod.geometry);
  const awningSoup = new Soup();
  awnings(pod.glazedWalls, street + 3.1, awningSoup);
  parts.add(canvas, awningSoup.geometry());

  let top = podiumTop;
  const panes = new Soup(), frames = new Soup();
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
    parts.add(glass, p.skin.geometry());
    parts.add(roofMat, p.roof.geometry());
    top = Math.max(top, p.top);
    for (const w of spec.windows) {
      const want = bearing(w.face);
      const f = p.faces.reduce((b, f) => (f.out[0] * want[0] + f.out[1] * want[1] > b.out[0] * want[0] + b.out[1] * want[1] ? f : b));
      // seen from outside the wall's right is (out.z, -out.x): measure r from the left end
      const a = 0, b = 1;
      const pa = p.onFace(f, a, 0, 0), pb = p.onFace(f, b, 0, 0);
      const rightward = (pb[0] - pa[0]) * f.out[1] - (pb[2] - pa[2]) * f.out[0] > 0;
      const t0 = rightward ? w.r0 : 1 - w.r1, t1 = rightward ? w.r1 : 1 - w.r0;
      prismWindow(p, f, t0, t1, w.h0, w.h1, panes, frames);
    }
  }
  parts.add(paneMaterial(), panes.geometry());
  parts.add(aluminium, frames.geometry());

  const group = parts.build('kursaal');
  group.userData.top = top;
  return group;
}
