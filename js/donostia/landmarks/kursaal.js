import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, abs, floor, fract, sin, cos, dot, max, mix, clamp, pow, step, smoothstep, fwidth, length,
  normalize, uv, positionWorld, positionView, normalView, normalWorld, cameraPosition, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { Parts, wound, cleanRing, clipRing, pointInRing, newell } from './geom.js';

// js/donostia/landmarks/kursaal.js
// Kursaal (1999, Rafael Moneo): two leaning translucent glass prisms — the large auditorium and the chamber hall — on a
// low platform at the mouth of the Urumea facing Zurriola beach; grey-green ribbed glass by day that glows from inside
// at night. The three OSM sites (palace, auditorium, chamber hall) are one model.
//
// build(sites, ctx) receives the GEO.landmarks entries ['kursaal', 'kursaal-auditorium', 'kursaal-kamara'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// The prisms. Their centres, orientations and sizes come from the OSM outlines (72 x 54 and 46 x 35 m; the 1:500 map
// traces the auditorium's edges too). Their tops follow b5m's LiDAR maxima (30.8 and 22.4 m over the ground, ~38.5 and
// ~30.3 m above sea level) and OSM's skillion roofs (4 m of fall, roof:direction 130° and 238° the low sides). Moneo
// leaned both "hacia el mar", but not the same way: the photographs from the river show the auditorium's corners
// tilting towards its face to the river mouth, while seen from that face they stand plumb; between the prisms the gap
// widens upwards, so the chamber hall leans the other way, towards its east face, along the beach. Each leans ~4°
// towards its high side.
//
// The skin (Moneo's report, Arquitectura 309, and the photographs, Wikimedia Commons: Mariordo 2012, Josugoni, Zarateman
// and others; see the reference set): 2.5 m x 60 cm pieces of curved laminated glass held by horizontal aluminium bars,
// each 60 cm course a slat bulging out between two bars, so the corners and the parapet read as a scalloped edge. The
// joints of the pieces run up a band of six courses (3.6 m) and shift a little from band to band; heavier transoms close
// each band and the steel frame behind shows as lighter verticals every three pieces (~7.5 m) — the grid that reads dark
// against the lit glass at night, when the whole prism glows amber. By day the glass is a frosted grey-green, about as
// light as the paving round it, not white. The skin starts a metre under the terrace; where the ground falls away (the
// esplanade and the river promenade) it stands on a storey of concrete piers and dark glazing. Its few windows are deep
// boxes with light reveals: on the auditorium's face to the esplanade a small square one high in the middle, a wide one
// low on the right and a small one low on the left, one low on its face to the chamber hall and one low on the chamber
// hall's east face.
//
// The platform (the 1:500 outline): a terrace three to four metres over the avenue between and north of the prisms
// (OSM's Erizain plaza), falling gently to the beach, paved in grey, with slate walls under a pale coping, open under
// its avenue edge as an arcade and stepping down to the beach promenade in a broad flight; the two-storey restaurant,
// glazed and awninged, with a slate-clad block beside it in front of the auditorium's face to the river; and the
// exhibition halls, a two-storey slate block with a glazed ribbon, against the chamber hall's east face.

const PRISMS = {
  'kursaal-auditorium': {
    // tops in metres over the avenue at the high and the low side; lean: bearing of the face it leans towards
    high: 31.0, low: 27.0, lowSide: 130, lean: 308,
    // face: compass bearing of the wall's outward normal; r0..r1: share of the wall from its left end as seen from
    // outside; h0..h1: metres above the skin's foot, on the courses (Mariordo's photos 2579/2588/2592 counted course by
    // course)
    windows: [
      { face: 308, r0: 0.58, r1: 0.625, h0: 9.3, h1: 12.0 },
      { face: 308, r0: 0.695, r1: 0.832, h0: 0.6, h1: 6.0 },
      { face: 308, r0: 0.13, r1: 0.19, h0: 1.2, h1: 4.2 },
      { face: 38, r0: 0.15, r1: 0.21, h0: 1.8, h1: 4.8 }
    ],
    // the restaurant and its slate block stand in front of this face
    restaurant: 218
  },
  'kursaal-kamara': {
    high: 22.8, low: 18.8, lowSide: 238, lean: 56,
    windows: [{ face: 56, r0: 0.69, r1: 0.83, h0: 1.2, h1: 5.4 }],
    // the exhibition halls run along this face from its corner with the avenue's face, for this share of it
    halls: { face: 56, from: 146, share: 0.6 }
  }
};
const LEAN = THREE.MathUtils.degToRad(4); // the tops overhang their feet by about 2 m
const PANEL_H = 0.6; // a course of curved glass
const BAND = 6; // courses per band of aligned joints
const MODULE = 7.5; // the steel frame's bay: three pieces
const BULGE = 0.07; // how far a course's slat bulges out of the line of the bars
const PARAPET = 1.2; // the glass skin runs up past the roof
const SKIN_OUT = 0.3; // the skin stands just outside the outline, so the platform's walls under it stay hidden
const BASE_IN = 0.45; // the base storey stands back under the skin
const REVEAL = 0.9; // depth of the windows' boxes
const SKIN_UNDER = 1.0; // the skin's foot, under the terrace
const TERRACE_ABOVE = 0.15; // the terrace sits just over the LiDAR's (which the DTM records as ground)
const UPPER = 8.6; // the restaurant's and the halls' roofs over the avenue: two storeys
const STEPS = { face: 356, depth: 3.6 }; // the steps to the beach: bearing their edge faces, depth from top to foot

// Surfaces of the platform's material, chosen per face by uv.y = mode * 1000 + depth under the face's top (metres)
const M = { slate: 0, restaurant: 1, base: 2, pane: 3, reveal: 4, prismRoof: 5, paving: 6, flatRoof: 7, ribbon: 8, arcade: 9, concrete: 10 };

// --- local helpers ----------------------------------------------------------------------------------------------------

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

  // Convex polygon fanned from its first point, wound to face `normal`, which all its vertices take: the scalloped skin
  // keeps its wall's normal and leaves the bulge of each course to the shader
  poly(points, uvs, normal) {
    const n = newell(points);
    if (!n) return;
    const order = points.map((_, k) => k);
    if (n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] < 0) order.reverse();
    for (let k = 1; k < order.length - 1; k++) {
      for (const q of [order[0], order[k], order[k + 1]]) {
        this.pos.push(...points[q]);
        this.nrm.push(...normal);
        this.uv.push(...uvs[q]);
      }
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

const bearing = (deg) => [Math.sin(THREE.MathUtils.degToRad(deg)), -Math.cos(THREE.MathUtils.degToRad(deg))]; // (x east, z south)
const bearingOf = (x, z) => (THREE.MathUtils.radToDeg(Math.atan2(x, -z)) + 360) % 360;
const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const code = (mode, depth = 0) => mode * 1000 + depth;

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

// The laminated glass skin. uv = (frame bays along the wall, metres above the skin's foot). Each 60 cm course: the
// aluminium bar at its top over a dark line of shadow, then the slat, lighter towards its crown where it faces the sky;
// the pieces' joints every third of a bay, shifting a little from band to band; lighter transoms and frame verticals.
// A frosted grey-green by day, the sky caught at grazing angles; at night the halls light it from inside, the slats
// glowing between the darker bars and the frame's grid.
function glassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.34, metalness: 0.04 });
  const bay = uv().x, h = uv().y;
  // the "shared" prelude: every pattern below is built once and reused by all the outputs
  const cy = h.div(PANEL_H);
  const fwC = fwidth(cy);
  const course = fract(cy);
  const bar = filteredPulse(cy, 0.93, 1.0, fwC);
  const gap = filteredPulse(cy, 0.85, 0.93, fwC);
  const cb = cy.div(BAND);
  const band = floor(cb);
  const transom = filteredPulse(cb.add(0.025), 0.0, 0.05, fwidth(cb));
  const piece = bay.mul(3).add(hash2(vec2(band, 3.7)).sub(0.5).mul(0.24));
  const joint = filteredPulse(piece.add(0.01), 0.0, 0.02, fwidth(piece));
  const frame = filteredPulse(bay.add(0.018), 0.0, 0.036, fwidth(bay));
  // the slat's curve: darker where it turns in under the bar, lighter at its crown; its mean once a course is a pixel
  const crown = mix(mix(float(0.88), float(1.06), smoothstep(0.05, 0.8, course)), float(0.98), smoothstep(0.25, 0.6, fwC));
  // per piece & band tone, fading out before a piece shrinks to a few pixels (no sparkle at distance)
  const far = smoothstep(0.25, 0.6, fwidth(piece));
  const tone = hash2(vec2(floor(piece), band)).sub(0.5).mul(0.08).mul(far.oneMinus());
  const cloud = mx_noise_float(positionWorld.mul(vec3(0.03, 0.05, 0.03))).mul(0.05);

  // (a yellower green than it looks: the sky's blue fill brings it back to the photographs' grey-green)
  const body = vec3(0.225, 0.285, 0.235).mul(float(1).add(tone).add(cloud)).mul(crown);
  let glass = mix(body, body.mul(0.45), gap);
  glass = mix(glass, vec3(0.46, 0.52, 0.44), bar);
  glass = mix(glass, body.mul(1.5), max(joint.mul(0.6), max(frame, transom).mul(0.6)));
  // the sky in the outer glass at grazing angles
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 4.0);
  mat.colorNode = mix(glass, cityUniforms.uSkyHorizonColor.mul(0.7), fres.mul(0.2));
  mat.roughnessNode = mix(float(0.32), float(0.48), max(bar, max(frame, transom)));

  // the bulge of each course, settling to flat once a course spans fewer than ~8 pixels
  const fine = smoothstep(0.3, 0.1, fwC);
  mat.normalNode = Fn(() => {
    const fade = smoothstep(160.0, 30.0, length(positionWorld.sub(cameraPosition))).mul(fine);
    return bumpNormal(sin(course.mul(Math.PI)).mul(0.012).mul(fade));
  })();

  // lit halls and foyers behind the glass: bay by bay and band by band a little brighter or dimmer, the bars, joints and
  // the frame darker against the glow (the steel behind the glass shadows a band wider than its aluminium caps: ~45 cm
  // posts, ~30 cm beams)
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const rooms = hash2(vec2(floor(bay), band.add(11.0))).mul(0.25).add(0.75);
  const post = filteredPulse(bay.add(0.03), 0.0, 0.06, fwidth(bay));
  const beam = filteredPulse(cb.add(0.04), 0.0, 0.08, fwidth(cb));
  const glowMask = float(1).sub(bar.mul(0.5)).sub(gap.mul(0.45)).sub(max(joint.mul(0.4), max(post, beam).mul(0.85))).max(0.0);
  mat.emissiveNode = vec3(1.0, 0.68, 0.32).mul(glowMask.mul(rooms).mul(0.62)).mul(night);
  return mat;
}

// Everything else, one material: uv.y = mode * 1000 + metres under the face's top, uv.x = metres along the walls (frame
// bays on the base storey, metres along the long axis on the prisms' roofs). The slate is laid as a mosaic of short
// sticks at random angles under a pale coping; the restaurant is two storeys of glass between concrete piers under a
// dark fascia; the prisms' base storey is concrete piers on the frame's bays with dark glass between; the terrace is
// paved in grey slabs, the prisms' roofs are grey crossed by lighter skylight strips. The glass lights warm at night.
function stoneMaterial(streetY) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0 });
  const u = uv().x, y = positionWorld.y;
  const mode = floor(uv().y.mul(0.001).add(0.00001));
  const d = uv().y.sub(mode.mul(1000));
  const is = (k) => float(1).sub(step(0.5, abs(mode.sub(k))));
  const grain = mx_noise_float(positionWorld.mul(0.35)).mul(0.05).add(1.0);
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fres = pow(float(1).sub(clamp(abs(dot(viewDir, normalWorld)), 0.0, 1.0)), 3.0);
  const darkGlass = mix(vec3(0.025, 0.03, 0.035), cityUniforms.uSkyHorizonColor.mul(0.55), fres.mul(0.7).add(0.08));
  const concrete = vec3(0.46, 0.46, 0.43).mul(grain);

  // slate sticks: 0.6 m cells, each laid at its own angle, four sticks across a cell with dark gaps between; they fade
  // to their mean before they alias
  const p = vec2(u, y).div(0.6);
  const cell = floor(p);
  const a = hash2(cell).mul(Math.PI);
  const along = dot(fract(p), vec2(cos(a), sin(a))).mul(4.0);
  const fw = fwidth(p.x).add(fwidth(p.y));
  const sticks = mix(filteredPulse(along, 0.0, 0.72, fwidth(along)), float(0.72), smoothstep(0.12, 0.35, fw));
  const stone = vec3(0.2, 0.195, 0.185).mul(hash2(cell.add(7.1)).mul(0.2).add(0.9));
  const slate = mix(stone.mul(0.6), stone, sticks);
  const slateWall = mix(slate, vec3(0.5, 0.49, 0.46).mul(grain), step(d, 0.55));

  // the restaurant: two storeys of glass between concrete piers every 4.8 m and mullions every 1.2 m, a concrete slab
  // edge between them and a dark grey fascia over the upper one
  const ry = y.sub(streetY);
  const glazed = max(step(0.15, ry).mul(step(ry, 3.5)), step(4.1, ry)).mul(step(1.5, d));
  const pier = filteredPulse(u.div(4.8).add(0.04), 0.0, 0.08, fwidth(u.div(4.8)));
  const mullion = filteredPulse(u.div(1.2).add(0.02), 0.0, 0.04, fwidth(u.div(1.2)));
  const rGlass = glazed.mul(float(1).sub(pier)).mul(float(1).sub(mullion.mul(0.8)));
  const restaurant = mix(mix(concrete.mul(0.8), vec3(0.15, 0.155, 0.16), step(d, 1.5)), darkGlass, rGlass);

  // the prisms' base storey: concrete piers on the frame's bays, a concrete head, dark glass with mullions between
  const bPier = filteredPulse(u.add(0.11), 0.0, 0.22, fwidth(u));
  const bMullion = filteredPulse(u.mul(4).add(0.04), 0.0, 0.08, fwidth(u.mul(4)));
  const bGlass = float(1).sub(max(bPier, step(d, 0.35))).mul(float(1).sub(bMullion.mul(0.7)));
  const base = mix(concrete, darkGlass, bGlass);

  // the prisms' roofs: grey, crossed by lighter skylight strips every 10 m
  const strip = filteredPulse(u.div(10).add(0.2), 0.0, 0.2, fwidth(u.div(10)));
  const prismRoof = mix(vec3(0.13, 0.14, 0.145), vec3(0.26, 0.27, 0.28), strip).mul(grain);

  // the terrace: grey granite slabs 1.2 m square
  const wx = positionWorld.x.div(1.2), wz = positionWorld.z.div(1.2);
  const joints = filteredPulse(wx, 0.0, 0.03, fwidth(wx)).add(filteredPulse(wz, 0.0, 0.03, fwidth(wz))).min(1.0);
  const paving = vec3(0.25, 0.255, 0.26).mul(grain).mul(float(1).sub(joints.mul(0.25)));

  // the halls: slate with a ribbon of glass under the coping, mullions every 1.5 m
  const ribbonBand = step(1.2, d).mul(step(d, 3.4));
  const rbMullion = filteredPulse(u.div(1.5).add(0.03), 0.0, 0.06, fwidth(u.div(1.5)));
  const ribbonGlass = ribbonBand.mul(float(1).sub(rbMullion));
  const ribbon = mix(mix(slateWall, concrete.mul(0.8), ribbonBand), darkGlass, ribbonGlass);

  // the arcade under the terrace's avenue edge: a concrete fascia, the shadowed hall behind columns every 7.5 m
  const column = filteredPulse(u.div(7.5).add(0.04), 0.0, 0.08, fwidth(u.div(7.5)));
  const hollow = step(1.3, d).mul(float(1).sub(column));
  const arcade = mix(concrete, vec3(0.035, 0.035, 0.04), hollow);

  let col = slateWall;
  col = mix(col, restaurant, is(M.restaurant));
  col = mix(col, base, is(M.base));
  col = mix(col, darkGlass, is(M.pane));
  col = mix(col, vec3(0.56, 0.55, 0.51).mul(grain), is(M.reveal));
  col = mix(col, prismRoof, is(M.prismRoof));
  col = mix(col, paving, is(M.paving));
  col = mix(col, vec3(0.15, 0.155, 0.16).mul(grain), is(M.flatRoof));
  col = mix(col, ribbon, is(M.ribbon));
  col = mix(col, arcade, is(M.arcade));
  col = mix(col, concrete, is(M.concrete));
  mat.colorNode = col;

  const glass = rGlass.mul(is(M.restaurant)).add(bGlass.mul(is(M.base))).add(is(M.pane)).add(ribbonGlass.mul(is(M.ribbon))).min(1.0);
  mat.roughnessNode = mix(mix(float(0.82), float(0.4), strip.mul(is(M.prismRoof))), float(0.1), glass);
  mat.metalnessNode = glass.mul(0.2);
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  // the restaurant brightest, the foyers under the prisms and the halls dimmer, the windows' boxes dimmer still (they
  // read as dark holes in the lit skin)
  const lit = mx_noise_float(vec3(u.mul(0.15), y.mul(0.2), 1.7)).mul(0.3).add(0.8);
  const glow = rGlass.mul(is(M.restaurant)).mul(0.9).add(bGlass.mul(is(M.base)).mul(0.5)).add(is(M.pane).mul(0.2))
    .add(ribbonGlass.mul(is(M.ribbon)).mul(0.6)).mul(lit).add(hollow.mul(is(M.arcade)).mul(0.08));
  mat.emissiveNode = vec3(1.0, 0.8, 0.55).mul(glow).mul(night);
  return mat;
}

// --- prisms -----------------------------------------------------------------------------------------------------------

// The frame of a leaning prism: its skin's four bottom corners (the OSM box grown by SKIN_OUT) at the skin's foot y0, the
// walls (outward normal, bearing, length, frame bays, tops), the lean (metres sideways per metre up) and the corners'
// heights over the foot
function prismFrame(box, spec, y0, street) {
  const [ax, az] = [Math.cos(box.angle), Math.sin(box.angle)]; // long axis
  const [bx, bz] = [-az, ax];
  const hl = box.length / 2 + SKIN_OUT, hw = box.width / 2 + SKIN_OUT;
  const base = [[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]].map(([s, t]) => [box.x + ax * s + bx * t, box.z + az * s + bz * t]);
  // roof height: rises linearly away from the OSM low side
  const [lx, lz] = bearing(spec.lowSide);
  const proj = base.map(([x, z]) => (x - box.x) * lx + (z - box.z) * lz);
  const pMin = Math.min(...proj), pMax = Math.max(...proj);
  const heights = proj.map((p) => street + spec.high + ((p - pMin) / (pMax - pMin)) * (spec.low - spec.high) - y0);
  const faces = [];
  let bays = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    const ex = base[j][0] - base[i][0], ez = base[j][1] - base[i][1];
    const len = Math.hypot(ex, ez);
    const mx = (base[i][0] + base[j][0]) / 2 - box.x, mz = (base[i][1] + base[j][1]) / 2 - box.z;
    const ml = Math.hypot(mx, mz);
    const modules = Math.max(1, Math.round(len / MODULE));
    faces.push({ i, j, len, out: [mx / ml, mz / ml], bearing: bearingOf(mx, mz), h0: heights[i], h1: heights[j], modules, u0: bays });
    bays += modules + 100; // each wall's bays start whole, so the frame meets the corners
  }
  const leanFace = faces.reduce((b, f) => (angleBetween(f.bearing, spec.lean) < angleBetween(b.bearing, spec.lean) ? f : b));
  const tan = Math.tan(LEAN);
  const P = { box, base, faces, y0, heights, axis: [ax, az], lean: [leanFace.out[0] * tan, leanFace.out[1] * tan] };
  // each wall's normal, tilted by the lean: (edge) x (up the wall), turned out
  for (const f of faces) {
    const ex = base[f.j][0] - base[f.i][0], ez = base[f.j][1] - base[f.i][1];
    let n = [-ez, ez * P.lean[0] - ex * P.lean[1], ex];
    if (n[0] * f.out[0] + n[2] * f.out[1] < 0) n = n.map((v) => -v);
    const l = Math.hypot(...n);
    f.normal = n.map((v) => v / l);
  }
  return P;
}

const nearestFace = (P, deg) => P.faces.reduce((b, f) => (angleBetween(f.bearing, deg) < angleBetween(b.bearing, deg) ? f : b));

// A point of wall f: t along its bottom edge, h metres above the skin's foot (carried sideways by the lean above it),
// `off` metres out of the wall. At the corners the offset follows both walls, so neighbours meet in a mitre.
function onFace(P, f, t, h, off) {
  const a = P.base[f.i], b = P.base[f.j];
  let ox = f.out[0] * off, oz = f.out[1] * off;
  if (off !== 0 && t <= 1e-9) {
    const g = P.faces[(f.i + 3) % 4];
    ox += g.out[0] * off; oz += g.out[1] * off;
  } else if (off !== 0 && t >= 1 - 1e-9) {
    const g = P.faces[(f.i + 1) % 4];
    ox += g.out[0] * off; oz += g.out[1] * off;
  }
  const hl = Math.max(h, 0);
  return [a[0] + (b[0] - a[0]) * t + P.lean[0] * hl + ox, P.y0 + h, a[1] + (b[1] - a[1]) * t + P.lean[1] * hl + oz];
}

const bulge = (h) => BULGE * Math.sin(Math.PI * (h / PANEL_H - Math.floor(h / PANEL_H)));

// The part of a polygon [[t, h], ...] under the wall's sloping top, h <= h0 + (h1 - h0) t
function underTop(poly, h0, h1) {
  const g = ([t, h]) => h0 + (h1 - h0) * t - h;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const gp = g(p), gq = g(q);
    if (gp >= 0) out.push(p);
    if ((gp >= 0) !== (gq >= 0)) {
      const s = gp / (gp - gq);
      out.push([p[0] + (q[0] - p[0]) * s, p[1] + (q[1] - p[1]) * s]);
    }
  }
  return out;
}

// One wall of the skin: strips a quarter course high, each set out by its course's bulge so the corners and the top
// show the scalloped edge, clipped to the sloping top and cut around the windows' boxes
function skinWall(P, f, holes, soup) {
  const dh = PANEL_H / 4;
  const top = Math.max(f.h0, f.h1);
  for (let k = 0; k * dh < top; k++) {
    const ha = k * dh, hb = Math.min((k + 1) * dh, top);
    let spans = [[0, 1]];
    for (const w of holes) {
      if (w.h0 >= hb - 1e-6 || w.h1 <= ha + 1e-6) continue;
      spans = spans.flatMap(([s0, s1]) => [[s0, Math.min(s1, w.t0)], [Math.max(s0, w.t1), s1]].filter(([x0, x1]) => x1 - x0 > 1e-6));
    }
    for (const [s0, s1] of spans) {
      const poly = underTop([[s0, ha], [s1, ha], [s1, hb], [s0, hb]], f.h0, f.h1);
      if (poly.length < 3) continue;
      soup.poly(poly.map(([t, h]) => onFace(P, f, t, h, bulge(h))), poly.map(([t, h]) => [f.u0 + t * f.modules, h]), f.normal);
    }
  }
}

// A leaning glass prism with a sloping roof sunk inside a parapet: the skin's walls, the parapet's inner faces and its
// coping into `skin`; the roof, the windows' boxes, the base storey and its soffit into `stone`
function leaningPrism(P, spec, stone, skin, ctx, kit) {
  const holes = new Map(P.faces.map((f) => [f, []]));
  for (const w of spec.windows) {
    const f = nearestFace(P, w.face);
    // seen from outside the wall's right is (out.z, -out.x): measure r from the left end
    const a = P.base[f.i], b = P.base[f.j];
    const rightward = (b[0] - a[0]) * f.out[1] - (b[1] - a[1]) * f.out[0] > 0;
    const t0 = rightward ? w.r0 : 1 - w.r1, t1 = rightward ? w.r1 : 1 - w.r0;
    holes.get(f).push({ t0, t1, h0: w.h0, h1: w.h1 });
    prismWindow(P, f, t0, t1, w.h0, w.h1, stone);
  }
  for (const f of P.faces) {
    skinWall(P, f, holes.get(f), skin);
    // the parapet's inner face, looking back over the roof, and the coping over the scalloped top
    const t = [onFace(P, f, 0, f.h0, 0), onFace(P, f, 1, f.h1, 0)];
    const s = [onFace(P, f, 0, f.h0 - PARAPET, 0), onFace(P, f, 1, f.h1 - PARAPET, 0)];
    const u0 = f.u0, u1 = f.u0 + f.modules;
    skin.face([s[0], s[1], t[1], t[0]], [[u0, f.h0 - PARAPET], [u1, f.h1 - PARAPET], [u1, f.h1], [u0, f.h0]], [-f.out[0], 0, -f.out[1]]);
    const o = [onFace(P, f, 0, f.h0, bulge(f.h0)), onFace(P, f, 1, f.h1, bulge(f.h1))];
    const inner = (p) => [p[0] - f.out[0] * 0.3, p[1] + 0.02, p[2] - f.out[1] * 0.3];
    stone.face([o[0], o[1], inner(t[1]), inner(t[0])], [[0, code(M.concrete)], [0, code(M.concrete)], [0, code(M.concrete)], [0, code(M.concrete)]], [0, 1, 0]);
    // the base storey under the skin, down into the lowest ground along the wall, and the soffit over it
    let g = Infinity;
    for (let k = 0; k <= 8; k++) {
      const q = onFace(P, f, k / 8, 0, 1.5);
      g = Math.min(g, kit.groundAt(ctx, q[0], q[2]));
    }
    const hb = Math.min(g - 0.6 - P.y0, -0.3);
    const quad = [[0, hb], [1, hb], [1, 0.02], [0, 0.02]];
    stone.face(quad.map(([tt, h]) => onFace(P, f, tt, h, -BASE_IN)), quad.map(([tt, h]) => [f.u0 + tt * f.modules, code(M.base, Math.max(0, -h))]), [f.out[0], 0, f.out[1]]);
    const soffit = [[0, -BASE_IN], [1, -BASE_IN], [1, 0], [0, 0]];
    stone.face(soffit.map(([tt, off]) => onFace(P, f, tt, 0, off)), soffit.map(() => [0, code(M.concrete)]), [0, -1, 0]);
  }
  // the roof inside the parapet, uv.x along the prism's long axis for the skylight strips
  const sunk = P.faces.map((f) => onFace(P, f, 0, f.h0 - PARAPET, 0));
  stone.face(sunk, sunk.map(([x, , z]) => [(x - P.box.x) * P.axis[0] + (z - P.box.z) * P.axis[1], code(M.prismRoof)]), [0, 1, 0]);
}

// A window's box sunk into the skin: light reveals from just proud of the bulging slats back to the dark pane
function prismWindow(P, f, t0, t1, h0, h1, stone) {
  const F = BULGE + 0.01, D = -REVEAL;
  const ex = (P.base[f.j][0] - P.base[f.i][0]) / f.len, ez = (P.base[f.j][1] - P.base[f.i][1]) / f.len;
  const reveal = [0, code(M.reveal)];
  const box = (pa, pb, n) => stone.face([pa[0], pa[1], pb[1], pb[0]], [reveal, reveal, reveal, reveal], n);
  box([onFace(P, f, t0, h0, F), onFace(P, f, t0, h0, D)], [onFace(P, f, t0, h1, F), onFace(P, f, t0, h1, D)], [ex, 0, ez]);
  box([onFace(P, f, t1, h0, F), onFace(P, f, t1, h0, D)], [onFace(P, f, t1, h1, F), onFace(P, f, t1, h1, D)], [-ex, 0, -ez]);
  box([onFace(P, f, t0, h0, F), onFace(P, f, t0, h0, D)], [onFace(P, f, t1, h0, F), onFace(P, f, t1, h0, D)], [0, 1, 0]);
  box([onFace(P, f, t0, h1, F), onFace(P, f, t0, h1, D)], [onFace(P, f, t1, h1, F), onFace(P, f, t1, h1, D)], [0, -1, 0]);
  const pane = [[t0, h0], [t1, h0], [t1, h1], [t0, h1]];
  stone.face(pane.map(([t, h]) => onFace(P, f, t, h, D + 0.05)), pane.map(([t]) => [t * f.len, code(M.pane)]), [f.out[0], 0, f.out[1]]);
}

// --- platform ---------------------------------------------------------------------------------------------------------

// Half-plane a·x + b·z + c >= 0 at `off` metres out of a prism's wall (towards its outside); `flip` keeps the inside
function wallPlane(P, f, off, flip = false) {
  const a = P.base[f.i];
  const c = -(f.out[0] * a[0] + f.out[1] * a[1]) - off;
  return flip ? [-f.out[0], -f.out[1], -c] : [f.out[0], f.out[1], c];
}
const onPlane = (pl, x, z) => Math.abs(pl[0] * x + pl[1] * z + pl[2]) < 1e-4;
const clip = (ring, ...planes) => planes.reduce((r, pl) => (r ? clipRing(r, ...pl) : null), ring);

// Walls and roof of a ring between y0 and its top: a height or a plane, top(x, z). wallMode(edge) picks each wall's
// surface (null: no wall: an edge shared with a neighbouring block); uv.x runs in metres along the walls. Returns the
// walls built.
function block(ring, y0, top, wallMode, capMode, soup) {
  if (!ring) return [];
  const y1 = typeof top === 'function' ? top : () => top;
  const r = wound(cleanRing(ring));
  const walls = [];
  let u = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.02) continue;
    const edge = { a: [ax, az], b: [bx, bz], len, out: [(bz - az) / len, -(bx - ax) / len] };
    const mode = wallMode(edge);
    if (mode != null) {
      const ya = y1(ax, az), yb = y1(bx, bz);
      soup.face([[ax, y0, az], [bx, y0, bz], [bx, yb, bz], [ax, ya, az]],
        [[u, code(mode, ya - y0)], [u + len, code(mode, yb - y0)], [u + len, code(mode)], [u, code(mode)]], [edge.out[0], 0, edge.out[1]]);
      walls.push({ ...edge, mode });
    }
    u += len;
  }
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push(new THREE.Vector2(r[k], r[k + 1]));
  const cap = [0, code(capMode)];
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
    const p = [pts[a], pts[b], pts[c]].map((v) => [v.x, y1(v.x, v.y), v.y]);
    soup.face(p, [cap, cap, cap], [0, 1, 0]);
  }
  return walls;
}

// White canvas awnings over glazing: one per 4.8 m bay, sloping `reach` metres out and `drop` down from y
function awnings(walls, y, reach, drop, soup) {
  for (const w of walls) {
    const n = Math.floor(w.len / 4.8);
    if (n < 1) continue;
    const pad = (w.len - n * 4.8) / 2;
    const dx = (w.b[0] - w.a[0]) / w.len, dz = (w.b[1] - w.a[1]) / w.len;
    for (let k = 0; k < n; k++) {
      const s0 = pad + k * 4.8 + 0.15, s1 = s0 + 4.5;
      const at = (s, out, dy) => [w.a[0] + dx * s + w.out[0] * out, y + dy, w.a[1] + dz * s + w.out[1] * out];
      soup.hexa([at(s0, 0.05, -0.08), at(s1, 0.05, -0.08), at(s1, reach, -drop - 0.08), at(s0, reach, -drop - 0.08),
        at(s0, 0.05, 0), at(s1, 0.05, 0), at(s1, reach, -drop), at(s0, reach, -drop)]);
      // the valance hanging at the front
      soup.hexa([at(s0, reach - 0.02, -drop - 0.35), at(s1, reach - 0.02, -drop - 0.35), at(s1, reach + 0.04, -drop - 0.35), at(s0, reach + 0.04, -drop - 0.35),
        at(s0, reach - 0.02, -drop - 0.02), at(s1, reach - 0.02, -drop - 0.02), at(s1, reach + 0.04, -drop - 0.02), at(s0, reach + 0.04, -drop - 0.02)]);
    }
  }
}

// Broad steps down from the terrace to the beach promenade along the platform's edges to Zurriola, where the ground just
// inside the edge is the terrace's (not the halls'): the aerial photographs' stepped band, which the LiDAR records as
// the terrace's three metres falling over some four metres out of the 1:500 outline
function beachSteps(outline, L, groundAt, soup) {
  const r = wound(cleanRing(outline));
  for (let i = 0, m = r.length / 2; i < m; i++) {
    const q = (i + 1) % m;
    const a = [r[2 * i], r[2 * i + 1]], b = [r[2 * q], r[2 * q + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 20) continue;
    const e = [(b[0] - a[0]) / len, (b[1] - a[1]) / len], out = [e[1], -e[0]];
    if (angleBetween(bearingOf(...out), STEPS.face) > 30) continue;
    const mid = [(a[0] + b[0]) / 2 - out[0] * 1.5, (a[1] + b[1]) / 2 - out[1] * 1.5];
    if (groundAt(...mid) < L.terraceAt(...mid) - 1.0) continue;
    // risers of ~18 cm from the terrace's edge (which follows its slope along the edge) to the avenue's level
    const h0 = L.terraceAt(...a) - L.street, h1 = L.terraceAt(...b) - L.street;
    const n = Math.max(2, Math.round(Math.max(h0, h1) / 0.18));
    const tread = STEPS.depth / (n - 1);
    const at = (s, o, k) => {
      const y = k < 0 ? L.foot : L.street + (h0 + ((h1 - h0) * s) / len) * (1 - k / n);
      return [a[0] + e[0] * s + out[0] * o, y, a[1] + e[1] * s + out[1] * o];
    };
    const tr = [0, code(M.paving)], rs = [0, code(M.concrete)], sl = [0, code(M.slate)];
    for (let k = 1; k < n; k++) {
      // step k: its tread from k - 1 to k treads out of the edge, its riser at its outer edge down to the next tread
      const o0 = (k - 1) * tread, o1 = k * tread, below = k === n - 1 ? -1 : k + 1;
      soup.face([at(0, o0, k), at(len, o0, k), at(len, o1, k), at(0, o1, k)], [tr, tr, tr, tr], [0, 1, 0]);
      soup.face([at(0, o1, below), at(len, o1, below), at(len, o1, k), at(0, o1, k)], [rs, rs, rs, rs], [out[0], 0, out[1]]);
      // the flight's ends, step by step
      for (const [s, dir] of [[0, -1], [len, 1]]) {
        soup.face([at(s, o0, -1), at(s, o1, -1), at(s, o1, k), at(s, o0, k)], [sl, sl, sl, sl], [e[0] * dir, 0, e[1] * dir]);
      }
    }
  }
}

// The platform: the outline split by the prisms' walls into the restaurant & slate block (in front of the auditorium's
// face to the river), the exhibition halls (along the chamber hall's face to the beach) and the terrace round the rest
function platform(outline, prisms, L, stone, canvas) {
  const aud = prisms.find((p) => p.spec.restaurant != null);
  const kam = prisms.find((p) => p.spec.halls);
  let rest = outline;
  // restaurant and slate block: the outline beyond the auditorium's wall, split where the restaurant's front steps out
  if (aud) {
    const f = nearestFace(aud.P, aud.spec.restaurant);
    const out = wallPlane(aud.P, f, -0.05), inside = wallPlane(aud.P, f, -0.05, true);
    const wedge = clipRing(outline, ...out);
    rest = clipRing(outline, ...inside);
    if (wedge) {
      const a = aud.P.base[f.i], e = [(aud.P.base[f.j][0] - a[0]) / f.len, (aud.P.base[f.j][1] - a[1]) / f.len];
      const sOf = (x, z) => (x - a[0]) * e[0] + (z - a[1]) * e[1];
      const offOf = (x, z) => (x - a[0]) * f.out[0] + (z - a[1]) * f.out[1];
      const front = [], back = [];
      for (let k = 0; k < wedge.length; k += 2) {
        const o = offOf(wedge[k], wedge[k + 1]);
        if (o > 12) front.push(sOf(wedge[k], wedge[k + 1]));
        else if (o > 1) back.push(sOf(wedge[k], wedge[k + 1]));
      }
      const meanBack = back.reduce((s, v) => s + v, 0) / Math.max(back.length, 1);
      const meanFront = front.reduce((s, v) => s + v, 0) / Math.max(front.length, 1);
      const forward = !back.length || meanFront > meanBack;
      const sCut = front.length ? (forward ? Math.min(...front) - 0.3 : Math.max(...front) + 0.3) : Infinity;
      // half-planes s >= sCut (restaurant) and s <= sCut (slate block), for `forward`; reversed otherwise
      const ge = [e[0], e[1], -(e[0] * a[0] + e[1] * a[1]) - sCut], le = ge.map((v) => -v);
      const [restPlane, slatePlane] = forward ? [ge, le] : [le, ge];
      const restaurantRing = Number.isFinite(sCut) ? clipRing(wedge, ...restPlane) : wedge;
      const slateRing = Number.isFinite(sCut) ? clipRing(wedge, ...slatePlane) : null;
      const shared = (w) => [out, restPlane].some((pl) => onPlane(pl, ...w.a) && onPlane(pl, ...w.b));
      const glazedWalls = block(restaurantRing, L.foot, L.upper, (w) => {
        if (shared(w)) return null;
        // glazed where the walls look away from the auditorium, to the river promenade and the avenue's corner
        return w.out[0] * f.out[0] + w.out[1] * f.out[1] > 0.3 ? M.restaurant : M.slate;
      }, M.flatRoof, stone).filter((w) => w.mode === M.restaurant);
      block(slateRing, L.foot, L.upper, (w) => (shared(w) ? null : M.slate), M.flatRoof, stone);
      // the awnings: a deep row under the fascia, a shallower one over the ground floor's windows
      awnings(glazedWalls, L.upper - 1.5, 2.3, 0.9, canvas);
      awnings(glazedWalls, L.street + 3.5, 1.7, 0.75, canvas);
    }
  }
  // the exhibition halls: beyond the chamber hall's wall to the beach, from its corner with the avenue's wall
  let pieces = [[rest, []]];
  if (kam && rest) {
    const { face, from, share } = kam.spec.halls;
    const f = nearestFace(kam.P, face), g = nearestFace(kam.P, from);
    const c = g.j === f.i || g.i === f.i ? kam.P.base[f.i] : kam.P.base[f.j];
    const o = c === kam.P.base[f.i] ? kam.P.base[f.j] : kam.P.base[f.i];
    const e = [(o[0] - c[0]) / f.len, (o[1] - c[1]) / f.len];
    const lim = share * f.len;
    const beyond = wallPlane(kam.P, f, 0.05), within = wallPlane(kam.P, f, 0.05, true);
    const near = [-e[0], -e[1], e[0] * c[0] + e[1] * c[1] + lim], farther = near.map((v) => -v);
    const halls = clip(rest, beyond, near);
    pieces = [[clip(rest, within), [within]], [clip(rest, beyond, farther), [beyond, farther]]];
    const cut = [beyond, near];
    block(halls, L.foot, L.upper, (w) => {
      if (cut.some((pl) => onPlane(pl, ...w.a) && onPlane(pl, ...w.b))) return M.slate; // over the terrace
      return M.ribbon;
    }, M.flatRoof, stone);
  }
  // the terrace: slate walls, an arcade along the avenue (walls facing as the chamber hall's face to the avenue does)
  const avenue = kam ? bearing(nearestFace(kam.P, kam.spec.halls.from).bearing) : [0, 1];
  for (const [ring, planes] of pieces) {
    block(ring, L.foot, L.terraceAt, (w) => {
      if (planes.some((pl) => onPlane(pl, ...w.a) && onPlane(pl, ...w.b))) return null;
      return w.out[0] * avenue[0] + w.out[1] * avenue[1] > 0.82 ? M.arcade : M.slate;
    }, M.paving, stone);
  }
}

// The terrace's top, y = a + b·x + c·z: a least-squares plane through the LiDAR's ground inside the outline where it
// stands well over the avenue (the platform's roof, which the DTM records as ground), raised by TERRACE_ABOVE; flat at
// the avenue + 3 m when too little of it is found
function terracePlane(outline, street, groundAt) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let k = 0; k < outline.length; k += 2) {
    minX = Math.min(minX, outline[k]); maxX = Math.max(maxX, outline[k]);
    minZ = Math.min(minZ, outline[k + 1]); maxZ = Math.max(maxZ, outline[k + 1]);
  }
  // normal equations, centred on the outline's box for conditioning
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const S = new Array(9).fill(0), R = [0, 0, 0];
  let n = 0;
  for (let x = minX; x <= maxX; x += 2) {
    for (let z = minZ; z <= maxZ; z += 2) {
      if (!pointInRing(x, z, outline)) continue;
      const y = groundAt(x, z);
      if (y < street + 2) continue;
      const v = [1, x - cx, z - cz];
      for (let i = 0; i < 3; i++) {
        R[i] += v[i] * y;
        for (let j = 0; j < 3; j++) S[3 * i + j] += v[i] * v[j];
      }
      n++;
    }
  }
  const m = new THREE.Matrix3().fromArray(S); // symmetric, so its column-major order does not matter
  if (n < 30 || Math.abs(m.determinant()) < 1e-6) return () => street + 3;
  const p = new THREE.Vector3(...R).applyMatrix3(m.invert());
  return (x, z) => p.x + p.y * (x - cx) + p.z * (z - cz) + TERRACE_ABOVE;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, kit } = ctx;
  const palace = sites.find((s) => s.id === 'kursaal');
  const prismSites = sites.filter((s) => PRISMS[s.id] && s.footprint);
  if (!prismSites.length) return null;
  const hiddenIdx = palace?.buildings?.[0] ?? prismSites[0].buildings?.[0];
  const outline = cleanRing(hiddenIdx != null ? GEO.buildings[hiddenIdx].g[0] : palace?.footprint || prismSites[0].footprint);

  // levels: the avenue (the outline's median ground), the walls' foot (its lowest), the terrace just above the LiDAR's
  // "ground" on the platform's roof (a plane fitted to it: it falls ~0.8 m from between the prisms to the beach), the
  // two-storey blocks over the avenue
  const ground = [];
  for (let k = 0; k < outline.length; k += 2) ground.push(kit.groundAt(ctx, outline[k], outline[k + 1]));
  ground.sort((a, b) => a - b);
  const street = ground[ground.length >> 1];
  const L = { street, foot: ground[0] - 0.6, terraceAt: terracePlane(outline, street, (x, z) => kit.groundAt(ctx, x, z)) };
  L.terrace = 0;
  for (let k = 0; k < outline.length; k += 2) L.terrace = Math.max(L.terrace, L.terraceAt(outline[k], outline[k + 1]));
  L.upper = Math.max(street + UPPER, L.terrace + 2.5);

  const parts = new Parts();
  const skin = new Soup(), stone = new Soup(), canvas = new Soup();
  const prisms = [];
  let top = L.upper;
  for (const site of prismSites) {
    const spec = PRISMS[site.id];
    const box = kit.orientedBox(cleanRing(site.footprint));
    if (!box) continue;
    const P = prismFrame(box, spec, L.terraceAt(box.x, box.z) - SKIN_UNDER, street);
    leaningPrism(P, spec, stone, skin, ctx, kit);
    prisms.push({ P, spec });
    top = Math.max(top, P.y0 + Math.max(...P.heights));
  }
  platform(outline, prisms, L, stone, canvas);
  beachSteps(outline, L, (x, z) => kit.groundAt(ctx, x, z), stone);

  parts.add(glassMaterial(), skin.geometry());
  parts.add(stoneMaterial(street), stone.geometry());
  parts.add(kit.materials.whiteIron, canvas.geometry());
  const group = parts.build('kursaal');
  group.userData.top = top;
  return group;
}
