import * as THREE from 'three/webgpu';
import {
  attribute, float, vec3, abs, clamp, dot, floor, fract, length, mix, mrt, normalView, positionViewDirection,
  positionWorld, pow, sin, smoothstep, step, texture, time, uv, vec4
} from 'three/tsl';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { cityUniforms } from '../../city-uniforms.js';
import { buildFacadeCells } from '../facade-mesh.js';
import { createFacadeMaterial, createRoofMaterial } from '../facade-material.js';
import { wound, simplifyRing, signedArea } from '../facade-geometry.js';
import { pointInRing } from './geom.js';
import { PaintBuilder, FINISH } from './paint.js';

// js/donostia/landmarks/dabadaba.js
// The way into Dabadaba, the music club of Egia (Mundaitz kalea 8), across Mundaitz kalea from the Cristina Enea park:
// a blind alley off the street, then a covered passage (the club's "tunnel") under the building at its end.
//  - The alley, 37 m long and 4 m wide (the municipal 1:500 map's pedestrian zone between the old factory of Mundaitz
//    6, on the right going in, and the flats of Mundaitz 8 on the left), floored in concrete with a kerbed footway
//    along its left side and a yellow line along the right; floodlights on the left-hand wall.
//  - The right-hand wall is painted end to end with murals ("paredes pintadas" in OpenStreetMap, node 5651995821),
//    panels side by side with tags on the bare render between them; the left-hand wall has two more panels and the
//    blue one by the garage at the end, where the flats' ground floor steps back under its first floor (the 1:500
//    outline) for a garage door.
//  - At the end, the 2.9 m front of Mundaitz 6A (the 1:500 outline) is all entrance: the passage's mouth in a front
//    painted charcoal grey, the club's sign above it, a dark glass box with "dabadaba" in red neon script, then a
//    glazed gallery behind white ironwork of rings and crosses, and the building's yellow render with its windows.
//  - The passage, 2.4 m wide, charcoal grey to the dado and salmon pink above, a pale ceiling, a floor of dark slate
//    tiles, wall lamps along its left side and queue posts down the middle, rises with the ground to the club's
//    lit door 11 m in (the LiDAR ground under the building climbs a metre: a ramp).
// From the photographs of the alley and the entrance by day and night (the club's own, the press's and visitors').
// The sign's neon reads as unlit glass tubes by day; at dusk and night (cityUniforms.uInteriorGlow) it glows, its
// light thrown on the walls, the floor and the murals; the lamps light the alley and the passage the same way (emissive
// and additive light pools, no dynamic lights).
// The murals are not the real ones: they are other people's artworks, so the walls carry an original set generated at
// load time (see muralAtlas() below) in their spirit. The club's name on its sign is its own.
//
// Data: the frame and the walls from the municipal 1:500 map (Donostiako Udala, CC BY-SA 3.0) as GEO.buildings holds
// it; Mundaitz 6A's height from b5m (CC BY 4.0); the ground from the LiDAR (geoEuskadi, CC BY 4.0); positions checked
// against OpenStreetMap (© OpenStreetMap contributors, ODbL 1.0: the club, node 5018997807; the murals).
//
// A site-less landmark: build([], ctx) finds Mundaitz 6A's plain extrusion by position and hides it (userData.hide),
// then builds it again through the city's own facade pipeline (js/donostia/facade-mesh.js) less its front on the
// alley, which this model replaces with the entrance. Its neighbours stay plain extrusions; their ground floors along
// the alley get a skin (the murals, the render, the garage).

// Points inside the 1:500 outlines of Mundaitz 6A (the building at the alley's end), 6 (the factory, right) and 8
// (the flats, left), and one in the alley by the end
const SITE = { end: [1000, 632], right: [1030, 612], left: [1030, 641], alley: [1016, 628] };
const TUNNEL = { width: 2.4, height: 2.5, length: 11 };
const FRONT = { gallery: 3.8, galleryTop: 5.35, sign: 3.12 }; // over the alley floor at the mouth
const LEDGE = 3.3; // the flats' first floor over the garage, over the floor there

const lin = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
const RENDER_HEX = 0xecd9a2; // Mundaitz 6A's pale yellow render
const P = (h, finish, rough) => [...lin(h), finish + rough];
// Paints (sRGB, then the finish code and its roughness or strength: see paint.js)
const PAINT = {
  charcoal: P(0x34373e, FINISH.paint, 0.8),
  // the passage's paint: lit by its lamps at night (their pools below), a breath of warm bounce everywhere
  salmon: P(0xd5826d, FINISH.litPaint, 0.015),
  ceiling: P(0xe6e0d4, FINISH.litPaint, 0.02),
  dado: P(0x2f3238, FINISH.litPaint, 0.006),
  grout: P(0x4a4c4f, FINISH.paint, 0.9),
  concrete: P(0x7f7e79, FINISH.paint, 0.88),
  footway: P(0x9a978f, FINISH.paint, 0.85),
  kerb: P(0xb3b0a8, FINISH.paint, 0.8),
  yellowLine: P(0xd9a81c, FINISH.paint, 0.6),
  render: P(RENDER_HEX, FINISH.paint, 0.9),
  white: P(0xefeee8, FINISH.paint, 0.5),
  whiteIron: P(0xf0efe9, FINISH.metal, 0.45),
  iron: P(0x1e2124, FINISH.metal, 0.5),
  steel: P(0x8d9196, FINISH.metal, 0.45),
  garage: P(0x8a8d91, FINISH.metal, 0.55),
  garageFrame: P(0x7d2a22, FINISH.paint, 0.6),
  doorRed: P(0x5a1f1b, FINISH.paint, 0.6),
  pipe: P(0xa3322a, FINISH.paint, 0.5),
  brass: P(0xb08d57, FINISH.metal, 0.35),
  greyDoor: P(0x6e7276, FINISH.metal, 0.6),
  greenDoor: P(0x2f4a3c, FINISH.paint, 0.6),
  signFace: P(0x060708, FINISH.metal, 0.08), // the box's dark mirror glass
  glass: P(0x1d2329, FINISH.litGlass, 0.16), // windows: dark by day, faintly lit at night
  galleryGlass: P(0x2a3036, FINISH.litGlass, 0.08),
  doorway: P(0xf2d79a, FINISH.litPaint, 0.9), // the club's lit hall beyond the passage
  lamp: P(0xffe6bc, FINISH.lamp, 0.9),
  flood: P(0xf6f3ec, FINISH.lamp, 0.95),
  bell: P(0xb3201b, FINISH.paint, 0.4),
  black: P(0x111214, FINISH.paint, 0.6),
  belt: P(0x7a1018, FINISH.paint, 0.7)
};
const TILES = [0x26292d, 0x2c2f34, 0x22252a, 0x30333a].map((h) => P(h, FINISH.paint, 0.32));
// Light: the floodlights' cool white, the passage's warm lamps, the neon's red (linear, with their strength)
const LIGHT = { flood: [1.0, 0.93, 0.8], lamp: [1.0, 0.72, 0.42], neon: [1.0, 0.07, 0.11] };

// ---------------------------------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, terrain } = ctx;
  const iEnd = findBuilding(GEO, SITE.end), iRight = findBuilding(GEO, SITE.right), iLeft = findBuilding(GEO, SITE.left);
  if (iEnd < 0 || iRight < 0 || iLeft < 0) return null;
  const end = GEO.buildings[iEnd];

  // The front at the alley's end and the side walls, as the city draws them (the simplified 1:500 outlines): the
  // factory's long front on the right going in, the flats' on the left
  const face = nearestEdge(cityRing(end), SITE.alley);
  if (!face || face.length < 2 || face.length > 4) return null;
  const rightEdge = sideEdge(cityRing(GEO.buildings[iRight]), face, -1);
  const leftEdge = sideEdge(cityRing(GEO.buildings[iLeft]), face, 1);
  if (!rightEdge || !leftEdge) return null;
  // Frame: u along the alley (the walls' mean direction) from the front out to the street, v across it towards the
  // left-hand (south) wall, y up from the alley floor at the mouth; origin at the middle of the front
  const nx = rightEdge.dir[0] + leftEdge.dir[0], nz = rightEdge.dir[1] + leftEdge.dir[1], nl = Math.hypot(nx, nz);
  const n = [nx / nl, nz / nl], vd = [-n[1], n[0]];
  const O = face.mid;
  const world = (u, v) => [O[0] + u * n[0] + v * vd[0], O[1] + u * n[1] + v * vd[1]];
  const local = (x, z) => [(x - O[0]) * n[0] + (z - O[1]) * n[1], (x - O[0]) * vd[0] + (z - O[1]) * vd[1]];
  const ground = (u, v) => terrain.heightAt(...world(u, v));
  const Y0 = ground(0.6, 0) + 0.04;
  const floorAt = (u, v) => ground(u, v) + 0.04 - Y0; // the alley's floor (local y)
  const W = (u, y, v) => { const [x, z] = world(u, v); return [x, y + Y0, z]; };
  const L = new THREE.Matrix4().makeBasis(new THREE.Vector3(n[0], 0, n[1]), new THREE.Vector3(0, 1, 0), new THREE.Vector3(vd[0], 0, vd[1]))
    .setPosition(O[0], Y0, O[1]);
  const at = (u, y, v, ry = 0) => L.clone().multiply(new THREE.Matrix4().makeRotationY(ry).setPosition(u, y, v));
  const half = face.length / 2;
  const lineOf = (e) => {
    let [ua, va] = local(...e.a), [ub, vb] = local(...e.b);
    if (ua > ub) [ua, va, ub, vb] = [ub, vb, ua, va];
    return { u0: ua, u1: ub, at: (u) => va + ((vb - va) * (u - ua)) / (ub - ua) };
  };
  const right = lineOf(rightEdge), left = lineOf(leftEdge);
  const vR = right.at, vL = left.at;
  const uR1 = right.u1, uL0 = left.u0, uL1 = left.u1;
  // the street end of the alley, from the end of one wall to the other's
  const mouthAt = (v) => uR1 + ((uL1 - uR1) * (v - vR(uR1))) / (vL(uL1) - vR(uR1));
  // Mundaitz 8's corner at the end (1:500 outline): the jog by the front, then the garage's slanting wall
  const JOG = local(1013.76, 629.81), SLANT = local(1016.19, 630.88);

  // Mundaitz 6A through the city's pipeline, less its front; the neighbours' ground floors' height on the way
  const { meshes: rebuilt, groundTop, wallColour } = rebuildBuilding(GEO, iEnd, face);
  // the flats' ground floor skin in the city's own colour for their walls above it
  const flats = P(wallColour.get(iLeft) ?? RENDER_HEX, FINISH.paint, 0.9);
  // the skins cover the neighbours' ground floors (the city's shopfronts) along the alley: heights over the floor
  const skinTop = (j, lo, hi, vf) => (u) => clampN((groundTop.get(j) ?? Y0 + lo) - Y0 - floorAt(u, vf(u)) + 0.25, lo, hi);
  const hR = skinTop(iRight, 3.6, 5.4, vR), hL = skinTop(iLeft, LEDGE + 0.3, 5.0, vL);

  const paint = new PaintBuilder();
  const glow = new GlowBuilder();
  const mural = new MuralBuilder();
  const addBox = (u0, u1, y0, y1, v0, v1, p, ry = 0) => {
    const g = new THREE.BoxGeometry(Math.abs(u1 - u0), Math.abs(y1 - y0), Math.abs(v1 - v0));
    paint.add(g, p, at((u0 + u1) / 2, (y0 + y1) / 2, (v0 + v1) / 2, ry));
  };
  // a flat quad from frame points, facing the frame direction `face` (up by default)
  const dirW = ([du, dy, dv]) => [du * n[0] + dv * vd[0], dy, du * n[1] + dv * vd[1]];
  const quad = (a, b, c, d, p, face = UP) => paint.quad(W(...a), W(...b), W(...c), W(...d), p, dirW(face));
  // light falling on a surface: a disc about a frame point, half-axes along two frame directions, its colour the
  // light's times the surface's (so it reads as that surface lit), clipped along the second axis to [t0, t1] of it
  const pool = (c, ax, ay, light, k, surface = null, group = 0, t0 = -1, t1 = 1) => {
    const rgb = light.map((x, i) => x * k * (surface ? Math.min(1, surface[i] * 1.6) : 1));
    glow.disc(W(...c), ax, ay, rgb, group, t0, t1);
  };
  const fU = (s) => axisDir(L, [1, 0, 0], s), fV = (s) => axisDir(L, [0, 0, 1], s), fY = (s) => new THREE.Vector3(0, s / 2, 0);
  // a pool of light on a sloping floor fy(u, v), su long and sv across, tilted to its slope there
  const poolOn = (fy, u, v, su, sv, light, k, surface = null) => {
    const gu = (fy(u + 1, v) - fy(u - 1, v)) / 2, gv = (fy(u, v + 0.8) - fy(u, v - 0.8)) / 1.6;
    pool([u, fy(u, v) + 0.035, v], fU(su).add(fY(gu * su)), fV(sv).add(fY(gv * sv)), light, k, surface);
  };

  // --- the passage: floor ramp, walls, ceiling, lamps, the club's door at its end ------------------------------------
  const TW = TUNNEL.width / 2, LT = TUNNEL.length;
  const tfRaw = (u) => Math.max(ground(u, -TW + 0.1), ground(u, 0), ground(u, TW - 0.1)) + 0.05 - Y0;
  const steps = Math.ceil(LT / 0.4);
  const tfs = [Math.max(tfRaw(0), floorAt(0.3, 0) + 0.06)];
  for (let k = 1; k <= steps; k++) tfs.push(Math.max(tfs[k - 1], tfRaw(-k * 0.4)));
  const tf = (u) => {
    const s = clampN(-u / 0.4, 0, steps), k = Math.min(Math.floor(s), steps - 1);
    return tfs[k] + (tfs[k + 1] - tfs[k]) * (s - k);
  };
  const tc = (u) => tf(u) + TUNNEL.height, DADO = 1.15;
  // tiles of dark slate 40 cm square on grout, following the ramp
  for (let i = 0; i < steps; i++) {
    const u1 = -i * 0.4, u0 = Math.max(-LT, u1 - 0.4);
    quad([u0, tf(u0) - 0.008, -TW], [u1, tf(u1) - 0.008, -TW], [u1, tf(u1) - 0.008, TW], [u0, tf(u0) - 0.008, TW], PAINT.grout);
    for (let j = 0; j < Math.ceil(TUNNEL.width / 0.4); j++) {
      const v0 = -TW + j * 0.4 + 0.004, v1 = Math.min(TW, v0 + 0.392);
      const a = u0 + 0.004, b = u1 - 0.004;
      quad([a, tf(a), v0], [b, tf(b), v0], [b, tf(b), v1], [a, tf(a), v1], TILES[(i * 7 + j * 3 + ((i * j) % 5)) % TILES.length]);
    }
  }
  // walls: the charcoal dado and the salmon above; the ceiling; one strip a metre along the ramp
  for (let k = 0; k < Math.ceil(LT); k++) {
    const u1 = -k, u0 = Math.max(-LT, -k - 1);
    for (const s of [-1, 1]) {
      const v = s * TW, face = s > 0 ? TO_RIGHT : TO_LEFT;
      const strip = (y0f, y1f, p) => quad([u0, y0f(u0), v], [u1, y0f(u1), v], [u1, y1f(u1), v], [u0, y1f(u0), v], p, face);
      strip((u) => tf(u) - 0.2, (u) => tf(u) + DADO, PAINT.dado);
      strip((u) => tf(u) + DADO, (u) => tf(u) + DADO + 0.04, PAINT.charcoal);
      strip((u) => tf(u) + DADO + 0.04, tc, PAINT.salmon);
    }
    quad([u0, tc(u0), TW], [u1, tc(u1), TW], [u1, tc(u1), -TW], [u0, tc(u0), -TW], PAINT.ceiling, DOWN);
  }
  // the inner end: a salmon wall with the club's lit doorway, a dark door beside it
  {
    const u = -LT, y0 = tf(u), y1 = tc(u);
    const dv0 = -0.75, dv1 = 0.35, dh = 2.15;
    const wallPart = (v0, v1, ya, yb, p) => quad([u, ya, v1], [u, ya, v0], [u, yb, v0], [u, yb, v1], p, OUT);
    wallPart(-TW, dv0, y0 - 0.2, y1, PAINT.salmon);
    wallPart(dv1, TW, y0 - 0.2, y1, PAINT.salmon);
    wallPart(dv0, dv1, y0 + dh, y1, PAINT.salmon);
    // the hall beyond: a lit box
    addBox(u - 1.6, u - 1.5, y0 - 0.1, y0 + 2.6, dv0 - 0.4, dv1 + 0.4, PAINT.doorway);
    addBox(u - 1.6, u, y0 - 0.12, y0 - 0.02, dv0 - 0.4, dv1 + 0.4, TILES[1]);
    for (const v of [dv0 - 0.45, dv1 + 0.45]) addBox(u - 1.6, u, y0 - 0.1, y0 + 2.6, v - 0.05, v + 0.05, PAINT.doorway);
    addBox(u - 1.6, u, y0 + 2.6, y0 + 2.7, dv0 - 0.4, dv1 + 0.4, PAINT.ceiling);
    // the frame, and a black door folded back against the jamb
    addBox(u - 0.06, u + 0.04, y0, y0 + dh + 0.08, dv0 - 0.08, dv0, PAINT.black);
    addBox(u - 0.06, u + 0.04, y0, y0 + dh + 0.08, dv1, dv1 + 0.08, PAINT.black);
    addBox(u - 0.06, u + 0.04, y0 + dh, y0 + dh + 0.08, dv0, dv1, PAINT.black);
    addBox(u + 0.04, u + 0.9, y0, y0 + dh - 0.02, dv1 + 0.02, dv1 + 0.07, PAINT.black);
    addBox(u + 0.005, u + 0.03, y0, y0 + 2.0, 0.6, 1.1, PAINT.black); // a second, closed door
    poolOn((x) => tf(x), u + 0.6, (dv0 + dv1) / 2, 2.4, 2.4, LIGHT.lamp, 0.45);
  }
  // wall lamps along the left-hand side: a brass plate and a glass globe; their light on the walls (salmon over the
  // dado, charcoal below), the floor and the ceiling
  for (const u of [-1.0, -3.9, -6.8, -9.6]) {
    const y = tf(u) + 2.0, d = tf(u) + DADO + 0.02;
    addBox(u - 0.07, u + 0.07, y - 0.1, y + 0.1, TW - 0.03, TW, PAINT.brass);
    paint.add(new THREE.SphereGeometry(0.075, 12, 8), PAINT.lamp, at(u, y, TW - 0.1));
    for (const [v, k, r] of [[TW - 0.012, 1.0, 1.6], [-TW + 0.012, 0.45, 1.9]]) {
      // the disc about the lamp's height, split at the dado's top: [t0, t1] along its height
      const cy = y - 0.1, tSplit = (d - cy) / r;
      pool([u, cy, v], fU(2 * r), fY(2 * r), LIGHT.lamp, k, lin(0xd5826d), 0, tSplit, 1);
      pool([u, cy, v], fU(2 * r), fY(2 * r), LIGHT.lamp, k * 0.5, lin(0x34373e), 0, -1, tSplit);
    }
    poolOn((x) => tf(x), u, 0.35, 4.0, 3.0, LIGHT.lamp, 0.35);
    pool([u, tc(u) - 0.015, TW - 0.5], fU(2.6), fV(2.0), LIGHT.lamp, 0.55, lin(0xe6e0d4));
  }
  // a poster case on the left-hand wall
  {
    const u0 = -5.9, u1 = -4.6, y0 = tf(-5.2) + 0.95;
    addBox(u0, u1, y0, y0 + 1.25, TW - 0.06, TW, PAINT.black);
    const posters = [0xf2c419, 0x1f4fa8, 0xe9e4d8, 0x2f8f4e];
    for (let k = 0; k < 4; k++) {
      const pu = u0 + 0.08 + (k % 2) * 0.58, py = y0 + 0.08 + Math.floor(k / 2) * 0.57;
      addBox(pu, pu + 0.5, py, py + 0.52, TW - 0.07, TW - 0.06, P(posters[k], FINISH.litPaint, 0.12));
    }
  }
  // queue posts down the middle with a red belt
  {
    const posts = [-1.3, -3.1, -4.9, -6.7].map((u) => [u, tf(u)]);
    for (const [u, y] of posts) {
      paint.add(new THREE.CylinderGeometry(0.17, 0.17, 0.03, 12).translate(0, 0.015, 0), PAINT.black, at(u, y, -0.2));
      paint.add(new THREE.CylinderGeometry(0.025, 0.025, 0.95, 8).translate(0, 0.5, 0), PAINT.steel, at(u, y, -0.2));
    }
    for (let k = 0; k + 1 < posts.length; k++) {
      const [ua, ya] = posts[k], [ub, yb] = posts[k + 1];
      for (const face of [TO_LEFT, TO_RIGHT]) quad([ua, ya + 0.86, -0.2], [ub, yb + 0.86, -0.2], [ub, yb + 0.91, -0.2], [ua, ya + 0.91, -0.2], PAINT.belt, face);
    }
  }

  // --- the front at the end: piers & fascia, the sign, the gallery, the render and windows above ---------------------
  const eave = end.eave - Y0;
  const lintel = tc(0);
  {
    const back = -0.32; // the wall's thickness, through to the passage
    // charcoal ground floor: the two piers, the fascia over the mouth
    addBox(back, 0, -0.4, FRONT.gallery, -half - 0.05, -TW, PAINT.charcoal);
    addBox(back, 0, -0.4, FRONT.gallery, TW, half + 0.05, PAINT.charcoal);
    addBox(back, 0, lintel, FRONT.gallery, -TW, TW, PAINT.charcoal);
    // the passage's mouth: a drain grate across it, a step up onto the tiles
    const fg = floorAt(0.2, 0);
    addBox(0.02, 0.38, fg - 0.03, fg + 0.005, -TW + 0.05, TW - 0.05, PAINT.iron);
    for (let k = 0; k < 14; k++) {
      const v = -TW + 0.15 + (k * (TUNNEL.width - 0.3)) / 13;
      addBox(0.02, 0.38, fg + 0.005, fg + 0.012, v - 0.012, v + 0.012, PAINT.steel);
    }
    quad([0, fg - 0.1, -TW], [0, tf(0), -TW], [0, tf(0), TW], [0, fg - 0.1, TW], PAINT.charcoal, OUT);
    // the upper wall: the gallery's back, then the yellow render to the eaves, open for two windows
    const ww = 1.6, wh = 1.35, sills = [6.6, 9.3].filter((s) => s + wh < eave - 0.3);
    addBox(back, 0, FRONT.gallery, eave, -half - 0.05, -ww / 2, PAINT.render);
    addBox(back, 0, FRONT.gallery, eave, ww / 2, half + 0.05, PAINT.render);
    let yb = FRONT.gallery;
    for (const s of sills) { addBox(back, 0, yb, s, -ww / 2, ww / 2, PAINT.render); yb = s + wh; }
    addBox(back, 0, yb, eave, -ww / 2, ww / 2, PAINT.render);
    // the sign: a box of dark mirror glass in a thin black frame, the neon on it (see neonSign below)
    const sw = 1.9, sh = 0.85, sy = FRONT.sign, sd = 0.13;
    addBox(0, 0.05, sy - sh / 2, sy + sh / 2, -sw / 2, sw / 2, PAINT.signFace);
    for (const [y0, y1, v0, v1] of [[sy + sh / 2, sy + sh / 2 + 0.035, -sw / 2 - 0.035, sw / 2 + 0.035],
      [sy - sh / 2 - 0.035, sy - sh / 2, -sw / 2 - 0.035, sw / 2 + 0.035],
      [sy - sh / 2, sy + sh / 2, -sw / 2 - 0.035, -sw / 2], [sy - sh / 2, sy + sh / 2, sw / 2, sw / 2 + 0.035]]) {
      addBox(0, sd, y0, y1, v0, v1, PAINT.black);
    }
    // its cable in a conduit along the fascia's top and down the right-hand pier; a junction box
    paint.add(new THREE.CylinderGeometry(0.016, 0.016, 2.6, 6).rotateX(Math.PI / 2), PAINT.charcoal, at(0.03, FRONT.gallery - 0.12, 0));
    paint.add(new THREE.CylinderGeometry(0.016, 0.016, FRONT.gallery - 1.0, 6).translate(0, (FRONT.gallery - 1.0) / 2, 0), PAINT.charcoal, at(0.03, 0.9, -half + 0.12));
    addBox(0, 0.1, 2.3, 2.62, -half + 0.03, -half + 0.22, P(0x8a8c88, FINISH.paint, 0.6));
    // the gallery: a glazed box on a slab, white ironwork of rings and crosses in front
    const g0 = FRONT.gallery, g1 = FRONT.galleryTop, gw = half - 0.05, gd = 0.32;
    addBox(-0.05, gd + 0.06, g0 - 0.12, g0, -gw - 0.03, gw + 0.03, PAINT.white);
    addBox(-0.05, gd + 0.06, g1, g1 + 0.12, -gw - 0.03, gw + 0.03, PAINT.white);
    addBox(gd - 0.06, gd - 0.04, g0, g1, -gw + 0.04, gw - 0.04, PAINT.galleryGlass);
    for (const s of [-1, 1]) addBox(0, gd - 0.04, g0, g1, s * gw - 0.02, s * gw + 0.02, PAINT.galleryGlass);
    // window frames behind the ironwork: a transom and mullions
    addBox(gd - 0.07, gd - 0.03, g0 + 0.62, g0 + 0.67, -gw, gw, PAINT.white);
    for (let k = 0; k <= 4; k++) addBox(gd - 0.07, gd - 0.03, g0, g1, -gw + (k * 2 * gw) / 4 - 0.025, -gw + (k * 2 * gw) / 4 + 0.025, PAINT.white);
    gallery(paint, at, gd + 0.02, g0, g1, gw);
    // two windows above, each of three lights, white frames, a sill
    for (const sill of sills) {
      addBox(-0.13, -0.11, sill, sill + wh, -ww / 2, ww / 2, PAINT.glass);
      for (const [y0, y1, v0, v1] of [[sill, sill + 0.06, -ww / 2, ww / 2], [sill + wh - 0.06, sill + wh, -ww / 2, ww / 2],
        [sill, sill + wh, -ww / 2, -ww / 2 + 0.06], [sill, sill + wh, ww / 2 - 0.06, ww / 2],
        [sill, sill + wh, -ww / 6 - 0.025, -ww / 6 + 0.025], [sill, sill + wh, ww / 6 - 0.025, ww / 6 + 0.025]]) {
        addBox(-0.12, -0.08, y0, y1, v0, v1, PAINT.white);
      }
      // the reveal round it and the sill
      addBox(-0.13, 0, sill + wh, sill + wh + 0.01, -ww / 2, ww / 2, PAINT.render);
      for (const s of [-1, 1]) addBox(-0.13, 0, sill, sill + wh, s * ww / 2 - 0.005, s * ww / 2 + 0.005, PAINT.render);
      addBox(-0.13, 0.05, sill - 0.05, sill, -ww / 2 - 0.05, ww / 2 + 0.05, PAINT.white);
    }
  }
  // the neon: tubes, their glow round the letters and on the box
  const sign = neonSign(L, FRONT.sign, glow);

  // --- the left-hand corner: the jog, the garage door under the flats' first floor, the ledge ------------------------
  {
    // the jog's face, charcoal under the ledge and render above, with the alarm bell
    const ju = JOG[0];
    addBox(ju - 0.04, ju + 0.03, -0.4, LEDGE, half, JOG[1], PAINT.charcoal);
    addBox(ju - 0.04, ju + 0.03, LEDGE, hL(ju + 0.5), half, JOG[1], flats);
    paint.add(new THREE.CylinderGeometry(0.11, 0.11, 0.08, 14).rotateZ(Math.PI / 2), PAINT.bell, at(ju + 0.06, 2.85, (half + JOG[1]) / 2));
    // the garage: a ribbed grey door in a red frame, set in the slanting wall
    const du = SLANT[0] - JOG[0], dv = SLANT[1] - JOG[1], len = Math.hypot(du, dv);
    const ry = -Math.atan2(dv, du); // box x along the slant
    const mid = (f, off) => [JOG[0] + du * f - (dv / len) * off, JOG[1] + dv * f + (du / len) * off];
    const fl = floorAt((JOG[0] + SLANT[0]) / 2, (JOG[1] + SLANT[1]) / 2);
    const slant = (f, off, w, y0, y1, depth, p) => {
      const [mu, mv] = mid(f, off);
      paint.add(new THREE.BoxGeometry(w, y1 - y0, depth), p, at(mu, (y0 + y1) / 2, mv, ry));
    };
    slant(0.5, -0.02, len + 0.04, fl - 0.3, LEDGE, 0.04, PAINT.charcoal);
    slant(0.5, -0.02, len + 0.04, LEDGE, hL(1.5), 0.04, flats);
    slant(0.5, -0.05, len - 0.2, fl, fl + 2.45, 0.06, PAINT.garageFrame);
    for (let k = 0; k < 16; k++) slant(0.5, -0.09, len - 0.36, fl + 0.05 + k * 0.15, fl + 0.12 + k * 0.15, 0.03, PAINT.garage);
    slant(0.5, -0.075, len - 0.36, fl + 0.05, fl + 2.4, 0.02, P(0x6b6e72, FINISH.metal, 0.6));
    // the flats' first floor over it: a thick slab edge from the front's corner out to the wall
    const ledge = new THREE.Shape([[ju - 0.05, half], [SLANT[0] + 0.35, vL(SLANT[0] + 0.35) - 0.02], [SLANT[0] + 0.35, SLANT[1] + 0.1], [ju - 0.05, SLANT[1] + 0.1]]
      .map(([a, b]) => new THREE.Vector2(a, b)));
    const lg = new THREE.ExtrudeGeometry(ledge, { depth: 0.28, bevelEnabled: false }).rotateX(Math.PI / 2).translate(0, LEDGE + 0.28, 0);
    paint.add(lg, flats, L);
    // the recess's floor, beyond the left-hand wall's line
    const fr = floorAt(SLANT[0] - 0.5, SLANT[1] - 0.3);
    quad([JOG[0], fr, half], [SLANT[0] + 0.1, fr, vL(SLANT[0])], [SLANT[0] + 0.1, fr, SLANT[1] + 0.05], [JOG[0], fr, JOG[1] + 0.05], PAINT.concrete);
  }

  // --- the right-hand corner: a narrow door and the drainpipe -------------------------------------------------------
  {
    const fl = floorAt(0.7, vR(0.7) + 0.3), vd0 = vR(0.6);
    addBox(0.04, 1.3, fl - 0.3, hR(0.6), vd0 - 0.1, vd0 + 0.025, PAINT.charcoal);
    addBox(0.28, 0.97, fl, fl + 2.05, vd0 + 0.025, vd0 + 0.045, PAINT.doorRed);
    for (let k = 0; k < 6; k++) addBox(0.36 + k * 0.11, 0.38 + k * 0.11, fl + 1.2, fl + 1.95, vd0 + 0.045, vd0 + 0.075, PAINT.iron);
    paint.add(new THREE.CylinderGeometry(0.05, 0.05, eave + 0.5, 10).translate(0, (eave + 0.5) / 2 - 0.4, 0), PAINT.pipe, at(1.22, 0, vR(1.22) + 0.08));
  }

  // --- the alley's floor: concrete, the footway along the left, the yellow line along the right ----------------------
  {
    const footU = SLANT[0] + 0.25;
    const kerb = (u) => vL(u) - 0.85;
    // rows across the alley, each between two lines v(u)
    const rows = [[(u) => vR(u) - 0.1, (u) => vR(u) + 0.3, PAINT.concrete], [(u) => vR(u) + 0.3, (u) => vR(u) + 0.4, PAINT.yellowLine],
      [(u) => vR(u) + 0.4, kerb, PAINT.concrete], [kerb, (u) => vL(u) + 0.1, PAINT.concrete]];
    rows.forEach(([va, vb, p], r) => {
      for (let u = 0; u < uR1 + 1; u += 1) {
        const ua = u, ub = u + 1;
        const end0 = Math.min(mouthAt(va(ua)), mouthAt(vb(ua)));
        if (ua >= end0) break;
        const ue = Math.min(ub, end0);
        if (r === 3 && ua >= footU) break; // the footway, below
        const line = r === 1 && ua > 1.4, lift = line ? 0.004 : 0;
        if (r === 1 && !line) {
          quad([ua, floorAt(ua, va(ua)), va(ua)], [ua, floorAt(ua, vb(ua)), vb(ua)], [ue, floorAt(ue, vb(ue)), vb(ue)], [ue, floorAt(ue, va(ue)), va(ue)], PAINT.concrete);
          continue;
        }
        const ub2 = r === 3 ? Math.min(ue, footU) : ue;
        quad([ua, floorAt(ua, va(ua)) + lift, va(ua)], [ua, floorAt(ua, vb(ua)) + lift, vb(ua)], [ub2, floorAt(ub2, vb(ub2)) + lift, vb(ub2)],
          [ub2, floorAt(ub2, va(ub2)) + lift, va(ub2)], p);
      }
    });
    // the footway: a kerbed strip 12 cm up, its end ramped down by the garage
    const uMax = mouthAt(vL(uL1));
    for (let u = footU; u < uMax; u += 1) {
      const ua = u, ub = Math.min(u + 1, uMax);
      const h = (x) => 0.12 * clampN((x - footU) / 0.6, 0, 1);
      quad([ua, floorAt(ua, kerb(ua)) + h(ua), kerb(ua)], [ua, floorAt(ua, vL(ua)) + h(ua), vL(ua) + 0.1], [ub, floorAt(ub, vL(ub)) + h(ub), vL(ub) + 0.1],
        [ub, floorAt(ub, kerb(ub)) + h(ub), kerb(ub)], PAINT.footway);
      quad([ua, floorAt(ua, kerb(ua)) - 0.05, kerb(ua)], [ua, floorAt(ua, kerb(ua)) + h(ua), kerb(ua)], [ub, floorAt(ub, kerb(ub)) + h(ub), kerb(ub)],
        [ub, floorAt(ub, kerb(ub)) - 0.05, kerb(ub)], PAINT.kerb, TO_RIGHT);
    }
    // its end at the street
    const ue = uMax, fk = floorAt(ue, kerb(ue)), fw = floorAt(ue, vL(ue));
    quad([ue, fk - 0.05, kerb(ue)], [ue, fw - 0.05, vL(ue) + 0.1], [ue, fw + 0.12, vL(ue) + 0.1], [ue, fk + 0.12, kerb(ue)], PAINT.kerb, OUT);
    // a manhole cover
    paint.add(new THREE.CylinderGeometry(0.32, 0.32, 0.02, 16), PAINT.iron, at(14.5, floorAt(14.5, 0.3) + 0.005, 0.3));
  }

  // --- the side walls' skins: murals on the right, render with its panels and doors on the left ----------------------
  const MURAL_U = 1.3; // the right-hand wall's murals start past the narrow door
  {
    const atl = muralAtlas();
    const vRs = (u) => vR(u) + 0.025, vLs = (u) => vL(u) - 0.025;
    // the right-hand wall: a band over the factory's ground floor, each panel's top where it rises higher
    mural.wall(W, floorAt, vRs, 1, MURAL_U, uR1, 0, hR, (u) => u - MURAL_U);
    for (const [x0, x1, top] of atl.panels) {
      const u0 = MURAL_U + x0, u1 = Math.min(uR1, MURAL_U + x1);
      if (u1 > u0) mural.wall(W, floorAt, vRs, 1, u0, u1, hR, (u) => Math.max(hR(u), top + 0.05), (u) => u - MURAL_U);
    }
    // the left-hand wall: the blue panel by the garage, two by the street, render between
    const [l0, l1] = ATLAS.leftEnd, [m0, m1] = ATLAS.leftMouth;
    const blueEnd = uL0 + (l1 - l0), mouthStart = uL1 - (m1 - m0);
    mural.wall(W, floorAt, vLs, -1, uL0, blueEnd, 0, 3.05, (u) => l1 - (u - uL0));
    mural.wall(W, floorAt, vLs, -1, mouthStart, uL1, 0, 3.05, (u) => m1 - (u - mouthStart));
    // between them a grey plinth thick with tags (the atlas's band over the left-hand panels, repeated), render above
    const [t0, t1] = ATLAS.leftTags;
    for (let u = blueEnd; u < mouthStart - 0.01; u += t1 - t0) {
      const ub = Math.min(u + (t1 - t0), mouthStart);
      mural.wall(W, floorAt, vLs, -1, u, ub, 0, PLINTH, (x) => t1 - (x - u), TAG_BAND);
    }
    const strip = (u0, u1, h0, h1) => {
      for (let u = u0; u < u1 - 0.01; u += 1) {
        const ua = u, ub = Math.min(u + 1, u1);
        const fa = floorAt(ua, vLs(ua)), fb = floorAt(ub, vLs(ub));
        const A = (h) => [ua, fa + (typeof h === 'function' ? h(ua) : h), vLs(ua)], B = (h) => [ub, fb + (typeof h === 'function' ? h(ub) : h), vLs(ub)];
        quad(B(h0), A(h0), A(h1), B(h1), flats, TO_RIGHT);
      }
    };
    strip(blueEnd, mouthStart, PLINTH, 3.05);
    strip(uL0, uL1, 3.05, hL);
    // doors in the render: a grey service door, a green double door
    for (const [u, w, h, p] of [[11.2, 0.95, 2.1, PAINT.greyDoor], [20.4, 1.6, 2.35, PAINT.greenDoor]]) {
      const fl = floorAt(u, vL(u)) + 0.12, v = vL(u);
      addBox(u - w / 2 - 0.06, u + w / 2 + 0.06, fl, fl + h + 0.06, v - 0.06, v - 0.03, PAINT.charcoal);
      addBox(u - w / 2, u + w / 2, fl, fl + h, v - 0.075, v - 0.06, p);
    }
    // small barred windows high in the ground floor, downpipes, a meter cabinet
    for (const u of [8.6, 15.4, 24.2, 28.0]) {
      const fl = floorAt(u, vL(u)), v = vL(u);
      addBox(u - 0.45, u + 0.45, fl + 2.25, fl + 2.95, v - 0.035, v - 0.025, PAINT.glass);
      for (let k = 0; k < 6; k++) addBox(u - 0.4 + k * 0.16, u - 0.38 + k * 0.16, fl + 2.25, fl + 2.95, v - 0.07, v - 0.05, PAINT.iron);
      addBox(u - 0.5, u + 0.5, fl + 2.2, fl + 2.25, v - 0.08, v - 0.025, PAINT.white);
    }
    const top = GEO.buildings[iLeft].eave - Y0;
    for (const u of [13.8, 26.6]) {
      paint.add(new THREE.CylinderGeometry(0.045, 0.045, top + 0.4, 8).translate(0, (top + 0.4) / 2 - 0.4, 0), PAINT.steel, at(u, 0, vL(u) - 0.08));
    }
    addBox(16.6, 17.3, floorAt(17, vL(17)) + 0.12, floorAt(17, vL(17)) + 1.3, vL(17) - 0.3, vL(17) - 0.025, PAINT.greyDoor);
  }

  // --- the floodlights on the left-hand wall, over the footway, and their light ----------------------------------------
  const floods = [];
  for (const u of [7.0, 19.0, 31.0]) {
    if (u > uL1 - 1) continue;
    const v = vL(u), y = floorAt(u, v) + 4.3;
    addBox(u - 0.03, u + 0.03, y - 0.05, y + 0.05, v - 0.45, v, PAINT.iron);
    addBox(u - 0.17, u + 0.17, y - 0.08, y + 0.04, v - 0.62, v - 0.38, PAINT.iron);
    addBox(u - 0.15, u + 0.15, y - 0.09, y - 0.08, v - 0.6, v - 0.4, PAINT.flood);
    floods.push(W(u, y - 0.1, v - 0.5));
    poolOn(floorAt, u, (vR(u) + v) / 2 - 0.2, 9.0, 5.0, LIGHT.flood, 0.3);
    poolOn((a, b) => floorAt(a, b) + 0.12, u, v - 0.42, 7.0, 0.9, LIGHT.flood, 0.25, lin(0x9a978f));
    pool([u, y - 1.6, v - 0.09], fU(5.6), fY(5.0), LIGHT.flood, 0.22, flats.slice(0, 3));
  }
  // the neon's red on the front, the floor before it, the passage's first metres, the corner's walls
  pool([0.012, FRONT.sign + 0.1, 0], fV(4.4), fY(3.0), LIGHT.neon, 0.5);
  poolOn(floorAt, 2.0, 0, 3.8, 3.6, LIGHT.neon, 0.2);
  poolOn((x) => tf(x), -0.9, 0, 3.0, 2.4, LIGHT.neon, 0.16);
  pool([JOG[0] + 0.045, 2.6, (half + JOG[1]) / 2], fV(0.62), fY(3.2), LIGHT.neon, 0.1);
  pool([uL0 + 0.5, 2.2, vL(uL0 + 0.5) - 0.04], fU(4.8), fY(4.0), LIGHT.neon, 0.15);

  // --- meshes ------------------------------------------------------------------------------------------------------------
  const group = new THREE.Group();
  group.name = 'Dabadaba';
  const painted = paint.build('Dabadaba:paint');
  if (painted) group.add(painted);
  const murals = mural.build(muralMaterial(floods, W(0.1, FRONT.sign, 0)));
  if (murals) group.add(murals);
  group.add(sign);
  const glowMesh = glow.build();
  if (glowMesh) group.add(glowMesh);
  for (const mesh of rebuilt) group.add(mesh);
  group.userData.hide = [iEnd];
  return group;
}

// ---------------------------------------------------------------------------------------------------------------------
// Finding the place in the 1:500 outlines
// ---------------------------------------------------------------------------------------------------------------------

const clampN = (x, a, b) => Math.min(b, Math.max(a, x));
const UP = [0, 1, 0], DOWN = [0, -1, 0], OUT = [1, 0, 0], TO_LEFT = [0, 0, 1], TO_RIGHT = [0, 0, -1];

function findBuilding(GEO, [x, z]) {
  return GEO.buildings.findIndex((b) => b.g?.[0] && pointInRing(x, z, b.g[0]));
}

// A building's outer ring as the city's walls follow it (prepareRings() in js/donostia/facade-mesh.js): wound with
// its edge normals (dz, -dx) pointing out, simplified unless that would flip it
const SIMPLIFY = 0.22;
function cityRing(b) {
  const w = wound(b.g[0], true);
  const s = simplifyRing(w, SIMPLIFY);
  return signedArea(s) > 0 ? s : w;
}

// The ring's edge nearest to a point: its ends, middle, length and outward normal
function nearestEdge(ring, [px, pz]) {
  let best = null, bestD = Infinity;
  for (let i = 0, n = ring.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], dx = ring[2 * q] - ax, dz = ring[2 * q + 1] - az;
    const l = Math.hypot(dx, dz);
    if (l < 0.5) continue;
    const t = clampN(((px - ax) * dx + (pz - az) * dz) / (l * l), 0, 1);
    const d = Math.hypot(px - ax - t * dx, pz - az - t * dz);
    if (d < bestD) { bestD = d; best = { mid: [ax + dx / 2, az + dz / 2], length: l, normal: [dz / l, -dx / l], a: [ax, az], b: [ax + dx, az + dz] }; }
  }
  return best;
}

// The longest edge of a ring running out from the front (along its normal) within 4 m to one side of its middle line
// (side 1: the left going in, -1: the right); its ends and its direction pointed away from the front
function sideEdge(ring, face, side) {
  let best = null;
  const [nx, nz] = face.normal, [mx, mz] = face.mid;
  for (let i = 0, cnt = ring.length / 2; i < cnt; i++) {
    const q = (i + 1) % cnt;
    const a = [ring[2 * i], ring[2 * i + 1]], b = [ring[2 * q], ring[2 * q + 1]];
    const dx = b[0] - a[0], dz = b[1] - a[1], l = Math.hypot(dx, dz);
    if (l < 10) continue;
    const along = (dx * nx + dz * nz) / l;
    if (Math.abs(along) < 0.98) continue;
    const lat = -((a[0] + b[0]) / 2 - mx) * nz + ((a[1] + b[1]) / 2 - mz) * nx;
    if (side * lat < 0.5 || side * lat > 4) continue;
    if (!best || l > best.length) best = { a, b, length: l, dir: along > 0 ? [dx / l, dz / l] : [-dx / l, -dz / l] };
  }
  return best;
}

// A frame direction (in L's basis) as a world vector of length s / 2: a disc's half-axis
const axisDir = (L, d, s) => new THREE.Vector3(...d).transformDirection(L).multiplyScalar(s / 2);

// ---------------------------------------------------------------------------------------------------------------------
// Mundaitz 6A again, through the city's facade pipeline
// ---------------------------------------------------------------------------------------------------------------------
// The building and its neighbours (so its party walls and gables come out as the city's) go through buildFacadeCells
// on their own; only the building's own triangles are kept, less those of its front on the alley. The facade and
// roof materials are fresh instances of the city's: their shaders are the same, so the GPU pipelines are shared.

const WALL_ATTRIBUTES = ['facade', 'binfo', 'bcol', 'acol'];
const ROOF_ATTRIBUTES = ['rfac', 'rinfo', 'bcol', 'rcol'];

function rebuildBuilding(GEO, index, face) {
  const ring = GEO.buildings[index].g[0];
  const sparse = new Array(GEO.buildings.length);
  sparse[index] = GEO.buildings[index];
  // its neighbours: every outline with a vertex on one of its own (within 0.7 m, x and z distances summed)
  GEO.buildings.forEach((b, j) => {
    if (j === index || !b.g?.[0]) return;
    const r = b.g[0];
    for (let k = 0; k < r.length; k += 2) {
      let near = false;
      for (let q = 0; q < ring.length && !near; q += 2) near = Math.abs(r[k] - ring[q]) + Math.abs(r[k + 1] - ring[q + 1]) < 0.7;
      if (near) { sparse[j] = b; return; }
    }
  });
  const triangulate = (contour, holes) => THREE.ShapeUtils.triangulateShape(contour, holes);
  const { cells } = buildFacadeCells({ ...GEO, buildings: sparse }, { triangulate, debug: true });
  // the front's triangles: within 0.3 m of its line, facing out along its normal
  const [ax, az] = face.a, [bx, bz] = face.b, [nx, nz] = face.normal;
  const fx = bx - ax, fz = bz - az, fl2 = fx * fx + fz * fz;
  const onFront = (pos, i) => {
    const x = pos[3 * i], z = pos[3 * i + 2];
    const t = ((x - ax) * fx + (z - az) * fz) / fl2;
    return t > -0.05 && t < 1.05 && Math.abs((x - ax) * nx + (z - az) * nz) < 0.3;
  };
  const out = [], groundTop = new Map(), wallColour = new Map();
  const facade = createFacadeMaterial(), roofs = createRoofMaterial();
  for (const cell of cells.values()) {
    // the neighbours' ground floors and walls: their vertices carry the ground floor's height (binfo.z, negative when
    // it has no shops) and the wall's colour (bcol, sRGB bytes)
    for (let i = 0; i < cell.walls.n; i++) {
      const j = cell.walls.owner[i];
      if (j === index || groundTop.has(j)) continue;
      groundTop.set(j, GEO.buildings[j].ground + Math.abs(cell.walls.fb[4 * i + 2]));
      const c = cell.walls.ca;
      wallColour.set(j, (c[4 * i] << 16) | (c[4 * i + 1] << 8) | c[4 * i + 2]);
    }
    for (const [part, names, mat, isWall] of [[cell.walls, WALL_ATTRIBUTES, facade, true], [cell.roofs, ROOF_ATTRIBUTES, roofs, false]]) {
      const keep = [];
      for (let t = 0; t < part.ni; t += 3) {
        const a = part.index[t], b = part.index[t + 1], c = part.index[t + 2];
        if (part.owner[a] !== index || part.owner[b] !== index || part.owner[c] !== index) continue;
        if (isWall && part.nrm[3 * a] * nx + part.nrm[3 * a + 2] * nz > 0.8 && onFront(part.pos, a) && onFront(part.pos, b) && onFront(part.pos, c)) continue;
        keep.push(a, b, c);
      }
      if (!keep.length) continue;
      // compact the kept vertices
      const remap = new Map();
      const idx = keep.map((v) => { if (!remap.has(v)) remap.set(v, remap.size); return remap.get(v); });
      const n = remap.size;
      const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), fa = new Float32Array(n * 4), fb = new Float32Array(n * 4);
      const ca = new Uint8Array(n * 4), cb = new Uint8Array(n * 4);
      for (const [src, dst] of remap) {
        for (let k = 0; k < 3; k++) { pos[3 * dst + k] = part.pos[3 * src + k]; nrm[3 * dst + k] = part.nrm[3 * src + k]; }
        for (let k = 0; k < 4; k++) {
          fa[4 * dst + k] = part.fa[4 * src + k]; fb[4 * dst + k] = part.fb[4 * src + k];
          ca[4 * dst + k] = part.ca[4 * src + k]; cb[4 * dst + k] = part.cb[4 * src + k];
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
      geo.setAttribute(names[0], new THREE.BufferAttribute(fa, 4));
      geo.setAttribute(names[1], new THREE.BufferAttribute(fb, 4));
      geo.setAttribute(names[2], new THREE.BufferAttribute(ca, 4, true));
      geo.setAttribute(names[3], new THREE.BufferAttribute(cb, 4, true));
      geo.setIndex(idx);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = isWall ? 'Dabadaba:building' : 'Dabadaba:roof';
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      out.push(mesh);
    }
  }
  return { meshes: out, groundTop, wallColour };
}

// ---------------------------------------------------------------------------------------------------------------------
// The gallery's ironwork: a white grid of four by two squares, a ring in each, crosses from the corners to the rings
// ---------------------------------------------------------------------------------------------------------------------

function gallery(paint, at, u, y0, y1, hw) {
  const cols = 4, rows = 2, bar = 0.035;
  const cw = (2 * hw) / cols, chh = (y1 - y0) / rows;
  const p = PAINT.whiteIron;
  const box = (yA, yB, vA, vB) => paint.add(new THREE.BoxGeometry(0.03, yB - yA, vB - vA), p, at(u, (yA + yB) / 2, (vA + vB) / 2));
  for (let c = 0; c <= cols; c++) { const v = -hw + c * cw; box(y0, y1, v - bar / 2, v + bar / 2); }
  for (let r = 0; r <= rows; r++) { const y = y0 + r * chh; box(y - bar / 2, y + bar / 2, -hw, hw); }
  const R = Math.min(cw, chh) * 0.36;
  const ring = new THREE.TorusGeometry(R, 0.013, 4, 20).rotateY(Math.PI / 2);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      const cv = -hw + (c + 0.5) * cw, cy = y0 + (r + 0.5) * chh;
      paint.add(ring, p, at(u, cy, cv));
      paint.add(new THREE.TorusGeometry(R * 0.3, 0.011, 4, 12).rotateY(Math.PI / 2), p, at(u, cy, cv));
      // the crosses: from each corner of the square to the ring
      for (const [sy, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ey = cy + sy * (chh / 2 - bar / 2), ev = cv + sv * (cw / 2 - bar / 2);
        const ky = cy + sy * R * Math.SQRT1_2, kv = cv + sv * R * Math.SQRT1_2;
        const len = Math.hypot(ey - ky, ev - kv);
        const g = new THREE.BoxGeometry(0.02, len, 0.02);
        const m = at(u, (ey + ky) / 2, (ev + kv) / 2).multiply(new THREE.Matrix4().makeRotationX(Math.atan2(ev - kv, ey - ky)));
        paint.add(g, p, m);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------------------------------------------------

const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
// Effects that must not touch the normal / metalness buffers the SSR pass reads (as igeldo.js's effectMRT)
const effectMRT = mrt({ normal: vec4(0.0, 0.0, 0.0, 0.0), metalRough: vec4(0.0, 0.0, 0.0, 0.0) });

// The neon's stutter: group 0 burns steadily; group 1 (one letter) catches now and then, a fraction of a second of
// flicker every nine seconds or so
function flicker(group) {
  const burst = step(0.93, fract(time.div(9.0)));
  const on = step(0.4, fract(sin(floor(time.mul(16.0)).mul(91.7)).mul(43758.5453)));
  return float(1.0).sub(burst.mul(group).mul(on.oneMinus()).mul(0.8));
}

// The tubes: dull pink glass by day; lit, a white-hot core in a red skin of light. aNeon = (brightness, flicker group,
// glass: 1 for the tubes, 0 for the box's red-lit edge, dark by day and red without a core at night)
function neonMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.22, metalness: 0.0 });
  const a = attribute('aNeon', 'vec3');
  const core = smoothstep(0.25, 0.95, abs(dot(normalView, positionViewDirection))).mul(a.z);
  mat.colorNode = mix(vec3(0.03, 0.025, 0.025), vec3(0.72, 0.46, 0.48), a.z);
  const tint = mix(vec3(1.0, 0.05, 0.09), vec3(1.0, 0.62, 0.58), core.mul(core));
  mat.emissiveNode = tint.mul(night().mul(mix(float(3.5), float(9.0), core)).add(0.03)).mul(a.x).mul(flicker(a.y));
  mat.name = 'DabadabaNeon';
  return mat;
}

// Light that falls on surfaces: additive discs, brightest at their middle (uv (0.5, 0.5)) and fading to their rim, off
// by day. aGlow = (linear rgb with its strength, flicker group).
function glowMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
  mat.fog = false;
  mat.mrtNode = effectMRT;
  const g = attribute('aGlow', 'vec4');
  const r = length(uv().sub(0.5)).mul(2.0);
  const fall = pow(clamp(float(1.0).sub(r), 0.0, 1.0), 2.0);
  mat.colorNode = g.xyz.mul(fall).mul(night()).mul(flicker(g.w));
  mat.opacityNode = float(1.0);
  mat.name = 'DabadabaGlow';
  return mat;
}

// The murals: the atlas's paint, matt; at night lit by the floodlights across the alley and the neon at its end (light
// falling off with distance, times the paint: a wash, not a dynamic light)
function muralMaterial(lamps, neonAt) {
  const { data, width, height } = muralAtlas();
  const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0.0 });
  const albedo = texture(tex, uv()).rgb;
  mat.colorNode = albedo;
  let wash = vec3(0.0);
  for (const [x, y, z] of lamps) {
    const d = length(positionWorld.sub(vec3(x, y, z)));
    wash = wash.add(vec3(...LIGHT.flood).mul(pow(clamp(float(1.0).sub(d.div(8.0)), 0.0, 1.0), 1.6).mul(1.1)));
  }
  const dn = length(positionWorld.sub(vec3(...neonAt)));
  wash = wash.add(vec3(...LIGHT.neon).mul(pow(clamp(float(1.0).sub(dn.div(4.5)), 0.0, 1.0), 2.0).mul(0.75)));
  mat.emissiveNode = albedo.mul(wash).mul(night());
  mat.name = 'DabadabaMurals';
  return mat;
}

// ---------------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------------

// Additive light: discs (a centre and two half-axes, cut along one of them if need be), merged into one mesh
class GlowBuilder {
  constructor() { this.pos = []; this.uv = []; this.glow = []; this.index = []; }

  // a disc about c with half-axes a and b (world vectors), cut to [t0, t1] (of -1..1) along b
  disc(c, a, b, rgb, group = 0, t0 = -1, t1 = 1) {
    t0 = Math.max(-1, t0); t1 = Math.min(1, t1);
    if (t1 <= t0) return;
    const base = this.pos.length / 3;
    const corners = [[-1, t0, 0, (t0 + 1) / 2], [1, t0, 1, (t0 + 1) / 2], [1, t1, 1, (t1 + 1) / 2], [-1, t1, 0, (t1 + 1) / 2]];
    for (const [s, t, uu, vv] of corners) {
      this.pos.push(c[0] + a.x * s + b.x * t, c[1] + a.y * s + b.y * t, c[2] + a.z * s + b.z * t);
      this.uv.push(uu, vv);
      this.glow.push(rgb[0], rgb[1], rgb[2], group);
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  build() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aGlow', new THREE.Float32BufferAttribute(this.glow, 4));
    g.setIndex(this.index);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, glowMaterial());
    mesh.name = 'Dabadaba:light';
    mesh.renderOrder = 1;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

// The murals' skin: strips along a wall following the floor, mapped into the atlas (x by a function of u, y by the
// height over the floor)
class MuralBuilder {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }

  // a strip on the wall along v = vf(u) (facing +v when side is 1, -v when -1) from u0 to u1, between heights h0 and
  // h1 over the floor (numbers or functions of u; 0 reaches 30 cm under it), atlas x = ax(u) metres, atlas y the
  // height plus ay
  wall(W, floorAt, vf, side, u0, u1, h0, h1, ax, ay = 0) {
    const n = Math.max(1, Math.ceil((u1 - u0) / 1.0));
    const H = (h, u) => (typeof h === 'function' ? h(u) : h);
    const vert = (u, h) => {
      const v = vf(u), f = floorAt(u, v);
      const y = h === 0 ? f - 0.3 : f + h;
      return { p: W(u, y, v), t: [ax(u) / ATLAS_LEN, (ay + Math.max(0, h)) / ATLAS_TOP] };
    };
    const normal = W(0, 0, side).map((c, k) => c - W(0, 0, 0)[k]);
    for (let k = 0; k < n; k++) {
      const ua = u0 + ((u1 - u0) * k) / n, ub = u0 + ((u1 - u0) * (k + 1)) / n;
      const la = H(h0, ua), lb = H(h0, ub), ta = Math.max(H(h1, ua), la), tb = Math.max(H(h1, ub), lb);
      if (ta - la < 0.01 && tb - lb < 0.01) continue;
      const a = vert(ua, la), b = vert(ub, lb), c = vert(ub, tb), d = vert(ua, ta);
      // wound to face the alley (a, b, c turn about +v in the frame)
      const tri = side > 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
      for (const q of tri) {
        this.pos.push(...q.p);
        this.nrm.push(...normal);
        this.uv.push(...q.t);
      }
    }
  }

  build(material) {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, material);
    mesh.name = 'Dabadaba:murals';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}

const neonAttribute = (g, brightness, group, glass) => {
  const a = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < a.length; i += 3) { a[i] = brightness; a[i + 1] = group; a[i + 2] = glass; }
  return new THREE.Float32BufferAttribute(a, 3);
};

// The sign's neon: one tube per letter bent along scriptPaths(), its ends turned back into the box; a thin red line
// round the box's edge; the glow on the dark glass and round the letters
function neonSign(L, y, glow) {
  const paths = scriptPaths(1.6);
  const tubeU = 0.085, faceU = 0.05;
  // the sign's plane: text left to right is -v (the viewer in the alley faces -u)
  const P3 = (x, yy, u) => new THREE.Vector3(u, y + yy, -x).applyMatrix4(L);
  const Linv = L.clone().invert();
  const side = new THREE.Vector3(0, 0, 1).transformDirection(L), up = new THREE.Vector3(0, 1, 0);
  const pieces = [];
  paths.forEach((path, k) => {
    const pts = path.map(([x, yy]) => P3(x, yy, tubeU));
    // electrodes: the tube's ends dive back through the glass
    pts.unshift(P3(path[0][0], path[0][1], faceU - 0.02));
    pts.push(P3(path[path.length - 1][0], path[path.length - 1][1], faceU - 0.02));
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    const g = new THREE.TubeGeometry(curve, path.length * 6, 0.0105, 6, false);
    const group = k === 6 ? 1 : 0; // the second b
    g.setAttribute('aNeon', neonAttribute(g, 1, group, 1));
    pieces.push(g);
    // the glow round the letter: soft discs every 3 cm along the tube, in the glass's plane (overlapping, so a band
    // that never folds on itself at the script's tight turns)
    const len = curve.getLength(), count2 = Math.ceil(len / 0.03);
    for (const p of curve.getSpacedPoints(count2).slice(2, -2)) {
      const q = p.clone().applyMatrix4(Linv);
      const c = new THREE.Vector3(faceU + 0.012, q.y, q.z).applyMatrix4(L);
      glow.disc([c.x, c.y, c.z], side.clone().multiplyScalar(0.085), up.clone().multiplyScalar(0.085), LIGHT.neon.map((x) => x * 0.16), group);
    }
  });
  // the red line round the box's edge
  const sw = 1.9, sh = 0.85, lip = 0.013;
  for (const [x0, x1, y0, y1] of [[-sw / 2, sw / 2, sh / 2, sh / 2 + lip], [-sw / 2, sw / 2, -sh / 2 - lip, -sh / 2],
    [-sw / 2 - lip, -sw / 2, -sh / 2, sh / 2], [sw / 2, sw / 2 + lip, -sh / 2, sh / 2]]) {
    const g = new THREE.BoxGeometry(0.012, y1 - y0, x1 - x0).translate(0.128, y + (y0 + y1) / 2, -(x0 + x1) / 2).applyMatrix4(L);
    g.setAttribute('aNeon', neonAttribute(g, 0.3, 0, 0));
    pieces.push(g.toNonIndexed());
  }
  const merged = mergeGeometries(pieces.map((g) => (g.index ? g.toNonIndexed() : g)));
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, neonMaterial());
  mesh.name = 'Dabadaba:neon';
  mesh.matrixAutoUpdate = false;
  // the glass box lit from within its edge to its middle
  const c = new THREE.Vector3(faceU + 0.008, y, 0).applyMatrix4(L);
  glow.disc([c.x, c.y, c.z], new THREE.Vector3(0, 0, -1.0).transformDirection(L).multiplyScalar(1.05), new THREE.Vector3(0, 0.5, 0), LIGHT.neon.map((k) => k * 0.45), 0);
  return mesh;
}

// ---------------------------------------------------------------------------------------------------------------------
// Street art: a procedural mural atlas
// ---------------------------------------------------------------------------------------------------------------------
// The alley's walls carry murals, pieces, throw-ups and tags, repainted every few years. None of the real works is
// reproduced: everything here is generated at load time from a fixed seed (shapes, invented words in a home-made
// skeleton alphabet, palettes), in the spirit of the place: big panels side by side, tags on the bare render between
// them and along the foot. One strip of 45 m of wall 5.6 m tall at 1.1 cm a pixel: the right-hand wall (36.6 m), then
// the left-hand one's three panels, with over them the tagged plinth its plain stretch repeats.

const ATLAS_W = 4096, ATLAS_H = 512;
const ATLAS_LEN = 45; // m of wall in the strip
const PPM = ATLAS_W / ATLAS_LEN; // pixels a metre
const ATLAS_TOP = ATLAS_H / PPM; // m
const ATLAS = { right: [0, 36.6], leftEnd: [36.6, 40.2], leftMouth: [40.2, 45], leftTags: [36.6, 45] };
// the left-hand wall's tagged plinth: a band PLINTH tall from TAG_BAND up, over its panels in the strip
const PLINTH = 1.05, TAG_BAND = 3.4;

// Seeded random numbers (mulberry32), so every visit paints the same walls
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const RENDER = hex(RENDER_HEX);
const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// Hash and value noise for the render's grain and the spray's overspray
function hash2(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

// An sRGB float canvas, rows bottom-up (row 0 is the foot of the wall). Shapes take metres along the strip (x) and up
// the wall (y), and paint as an [r, g, b] or a function (x, y, out) in metres; coverage is anti-aliased over `soft`
// pixels (more for sprayed edges).
class Wall {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.c = new Float32Array(w * h * 3);
    this.scratch = new Float32Array(1 << 18);
    this.tmp = [0, 0, 0];
  }

  // composite paint over pixel box [x0, x1] x [y0, y1] with coverage cov(px, py) (pixel units)
  region(x0, y0, x1, y1, cov, paint, alpha = 1) {
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(this.w - 1, Math.ceil(x1)); y1 = Math.min(this.h - 1, Math.ceil(y1));
    const c = this.c, fn = typeof paint === 'function', out = this.tmp;
    let r = 0, g = 0, b = 0;
    if (!fn) [r, g, b] = paint;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        let a = cov(x + 0.5, y + 0.5);
        if (a <= 0) continue;
        a *= alpha;
        if (fn) { paint((x + 0.5) / PPM, (y + 0.5) / PPM, out); r = out[0]; g = out[1]; b = out[2]; }
        const i = 3 * (y * this.w + x);
        c[i] += (r - c[i]) * a;
        c[i + 1] += (g - c[i + 1]) * a;
        c[i + 2] += (b - c[i + 2]) * a;
      }
    }
  }

  rect(x0, y0, x1, y1, paint, { soft = 1, alpha = 1, rough = 0 } = {}) {
    const X0 = x0 * PPM, Y0 = y0 * PPM, X1 = x1 * PPM, Y1 = y1 * PPM, s = soft, edge = s + rough;
    this.region(X0 - edge, Y0 - edge, X1 + edge, Y1 + edge, (px, py) => {
      let d = Math.max(X0 - px, px - X1, Y0 - py, py - Y1);
      if (d < -edge) return 1; // well inside: no noise to draw
      if (rough) d += (vnoise(px * 0.08, py * 0.08) - 0.5) * rough;
      return clamp01(0.5 - d / s);
    }, paint, alpha);
  }

  // an opaque flat fill of a box (no edges to soften): the bare walls
  fill(x0, y0, x1, y1, [r, g, b]) {
    const X0 = Math.max(0, Math.round(x0 * PPM)), X1 = Math.min(this.w, Math.round(x1 * PPM));
    const Y0 = Math.max(0, Math.round(y0 * PPM)), Y1 = Math.min(this.h, Math.round(y1 * PPM));
    const c = this.c;
    for (let y = Y0; y < Y1; y++) for (let i = 3 * (y * this.w + X0), e = 3 * (y * this.w + X1); i < e; i += 3) { c[i] = r; c[i + 1] = g; c[i + 2] = b; }
  }

  disc(cx, cy, r, paint, { soft = 1, alpha = 1, sx = 1, sy = 1 } = {}) {
    const X = cx * PPM, Y = cy * PPM, R = r * PPM, ax = R * sx, ay = R * sy, m = Math.min(ax, ay);
    const inner = Math.max(0, 1 - (soft + 1) / m) ** 2;
    this.region(X - ax - soft, Y - ay - soft, X + ax + soft, Y + ay + soft, (px, py) => {
      const dx = (px - X) / ax, dy = (py - Y) / ay, q = dx * dx + dy * dy;
      if (q < inner) return 1;
      return clamp01(0.5 - ((Math.sqrt(q) - 1) * m) / soft);
    }, paint, alpha);
  }

  ring(cx, cy, r, t, paint, opts = {}) {
    const X = cx * PPM, Y = cy * PPM, R = r * PPM, T = (t * PPM) / 2, soft = opts.soft || 1;
    this.region(X - R - T - soft, Y - R - T - soft, X + R + T + soft, Y + R + T + soft, (px, py) => {
      const d = Math.abs(Math.sqrt((px - X) * (px - X) + (py - Y) * (py - Y)) - R) - T;
      return clamp01(0.5 - d / soft);
    }, paint, opts.alpha ?? 1);
  }

  // Filled polygon [[x, y], ...] (even-odd), edges anti-aliased by their distance
  poly(pts, paint, { soft = 1, alpha = 1 } = {}) {
    const n = pts.length, P = new Float64Array(2 * n);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    pts.forEach(([x, y], k) => {
      P[2 * k] = x * PPM; P[2 * k + 1] = y * PPM;
      x0 = Math.min(x0, P[2 * k]); y0 = Math.min(y0, P[2 * k + 1]); x1 = Math.max(x1, P[2 * k]); y1 = Math.max(y1, P[2 * k + 1]);
    });
    this.region(x0 - soft, y0 - soft, x1 + soft, y1 + soft, (px, py) => {
      let inside = false, best = Infinity;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = P[2 * i], yi = P[2 * i + 1], xj = P[2 * j], yj = P[2 * j + 1];
        if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        const dx = xj - xi, dy = yj - yi, l2 = dx * dx + dy * dy || 1e-9;
        const t = clamp01(((px - xi) * dx + (py - yi) * dy) / l2);
        const ex = px - xi - t * dx, ey = py - yi - t * dy;
        best = Math.min(best, Math.sqrt(ex * ex + ey * ey));
      }
      return clamp01(0.5 + (inside ? best : -best) / soft);
    }, paint, alpha);
  }

  // A round-capped stroke along a polyline [[x, y], ...] of radius r (m); overlapping segments do not double up
  stroke(pts, r, paint, { soft = 1, alpha = 1 } = {}) {
    if (pts.length < 2) pts = [pts[0], [pts[0][0] + 1e-4, pts[0][1]]];
    const R = Math.max(r * PPM, 0.6), pad = R + soft + 1;
    const P = pts.map(([x, y]) => [x * PPM, y * PPM]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of P) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
    x1 = Math.min(this.w - 1, Math.ceil(x1 + pad)); y1 = Math.min(this.h - 1, Math.ceil(y1 + pad));
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw <= 0 || bh <= 0) return;
    if (bw * bh > this.scratch.length) this.scratch = new Float32Array(bw * bh * 2);
    const S = this.scratch;
    S.fill(0, 0, bw * bh);
    // a faint thinning for sub-pixel lines, so far tags keep their weight instead of vanishing
    const thin = Math.min(1, (r * PPM) / 0.6);
    for (let k = 0; k + 1 < P.length; k++) {
      const [ax, ay] = P[k], [bx, by] = P[k + 1];
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
      const sx0 = Math.max(x0, Math.floor(Math.min(ax, bx) - pad)), sx1 = Math.min(x1, Math.ceil(Math.max(ax, bx) + pad));
      const sy0 = Math.max(y0, Math.floor(Math.min(ay, by) - pad)), sy1 = Math.min(y1, Math.ceil(Math.max(ay, by) + pad));
      for (let y = sy0; y <= sy1; y++) {
        for (let x = sx0; x <= sx1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const t = clamp01(((px - ax) * dx + (py - ay) * dy) / l2);
          const ex = px - ax - t * dx, ey = py - ay - t * dy;
          const d = Math.sqrt(ex * ex + ey * ey) - R;
          const a = clamp01(0.5 - d / soft) * thin;
          const i = (y - y0) * bw + (x - x0);
          if (a > S[i]) S[i] = a;
        }
      }
    }
    // composite the mask (flat paint straight; graded paint through region())
    if (typeof paint === 'function') {
      this.region(x0, y0, x1, y1, (px, py) => S[(Math.floor(py) - y0) * bw + (Math.floor(px) - x0)], paint, alpha);
      return;
    }
    const [r0, g0, b0] = paint, c = this.c;
    for (let y = y0, k = 0; y <= y1; y++) {
      for (let x = x0, i = 3 * (y * this.w + x0); x <= x1; x++, k++, i += 3) {
        const a = S[k] * alpha;
        if (a <= 0) continue;
        c[i] += (r0 - c[i]) * a; c[i + 1] += (g0 - c[i + 1]) * a; c[i + 2] += (b0 - c[i + 2]) * a;
      }
    }
  }

  // Paint runs: thin drips falling from (x, y) — sprayed or rolled paint that ran
  drip(x, y, len, r, paint) {
    this.stroke([[x, y], [x + 0.002, y - len * 0.6], [x, y - len]], r, paint);
    this.disc(x, y - len, r * 1.35, paint);
  }
}

// --- the skeleton alphabet ----------------------------------------------------------------------------------------------
// Capitals drawn as centre lines in a box one unit tall (widths per letter), for tags (thin, slanted, jittered),
// throw-ups (fat round strokes, outlined) and pieces (thick strokes, gradient fills, arrows). Home-made, plain shapes.
const arc = (cx, cy, rx, ry, a0, a1, n = 10) => {
  const out = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
};
const PI = Math.PI;
const GLYPHS = {
  A: [0.9, [[[0, 0], [0.45, 1], [0.9, 0]], [[0.2, 0.4], [0.7, 0.4]]]],
  B: [0.8, [[[0, 0], [0, 1], [0.48, 1], ...arc(0.48, 0.77, 0.24, 0.23, PI / 2, -PI / 2, 6).slice(1), [0, 0.54]],
    [[0.45, 0.54], ...arc(0.5, 0.27, 0.29, 0.27, PI / 2, -PI / 2, 6).slice(1), [0, 0]]]],
  D: [0.85, [[[0, 0], [0, 1], [0.35, 1], ...arc(0.35, 0.5, 0.5, 0.5, PI / 2, -PI / 2, 8).slice(1), [0, 0]]]],
  E: [0.72, [[[0.72, 1], [0, 1], [0, 0], [0.72, 0]], [[0, 0.52], [0.58, 0.52]]]],
  G: [0.86, [[...arc(0.45, 0.5, 0.43, 0.5, 0.35 * PI, 1.95 * PI, 12), [0.88, 0.45], [0.52, 0.45]]]],
  I: [0.3, [[[0.15, 0], [0.15, 1]], [[0, 1], [0.3, 1]], [[0, 0], [0.3, 0]]]],
  K: [0.8, [[[0, 0], [0, 1]], [[0.78, 1], [0, 0.42]], [[0.24, 0.6], [0.82, 0]]]],
  L: [0.68, [[[0, 1], [0, 0], [0.68, 0]]]],
  M: [0.95, [[[0, 0], [0.05, 1], [0.47, 0.42], [0.9, 1], [0.95, 0]]]],
  N: [0.8, [[[0, 0], [0, 1], [0.8, 0], [0.8, 1]]]],
  O: [0.9, [arc(0.45, 0.5, 0.45, 0.5, PI / 2, PI / 2 + 2 * PI, 16)]],
  P: [0.75, [[[0, 0], [0, 1], [0.45, 1], ...arc(0.45, 0.74, 0.3, 0.26, PI / 2, -PI / 2, 6).slice(1), [0, 0.48]]]],
  R: [0.8, [[[0, 0], [0, 1], [0.45, 1], ...arc(0.45, 0.74, 0.3, 0.26, PI / 2, -PI / 2, 6).slice(1), [0, 0.48]], [[0.38, 0.48], [0.82, 0]]]],
  S: [0.78, [[...arc(0.4, 0.75, 0.36, 0.25, 0.1 * PI, PI * 1.45, 8), ...arc(0.4, 0.25, 0.38, 0.25, PI / 2, -0.9 * PI, 8).slice(1)]]],
  T: [0.8, [[[0, 1], [0.8, 1]], [[0.4, 1], [0.4, 0]]]],
  U: [0.8, [[[0, 1], ...arc(0.4, 0.4, 0.4, 0.4, PI, 2 * PI, 8), [0.8, 1]]]],
  X: [0.8, [[[0, 0], [0.8, 1]], [[0, 1], [0.8, 0]]]],
  Z: [0.78, [[[0, 1], [0.78, 1], [0, 0], [0.78, 0]]]]
};
const CONSONANTS = 'BDGKLMNPRSTXZ', VOWELS = 'AEIOU';
function word(rnd, n) {
  let w = '';
  for (let k = 0; k < n; k++) w += k % 2 === (rnd() < 0.25 ? 1 : 0) ? CONSONANTS[Math.floor(rnd() * CONSONANTS.length)] : VOWELS[Math.floor(rnd() * VOWELS.length)];
  return w;
}

// Chaikin corner cutting: a hand's curves from a skeleton's corners
function chaikin(pts, it = 2) {
  for (let k = 0; k < it; k++) {
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// A word laid out from (x, y) at height h: one polyline list per letter, slanted by `slant`, letters overlapping by
// `tight` of their width, each point jittered by `jitter` (m); also its width
function layout(text, x, y, h, { slant = 0.2, tight = 0.1, jitter = 0, rnd = Math.random, smooth = 0, bounce = 0 } = {}) {
  const letters = [];
  let cx = x;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) { cx += h * 0.4; continue; }
    const [w, lines] = g;
    const dy = bounce ? (rnd() - 0.5) * bounce * h : 0;
    const tilt = bounce ? (rnd() - 0.5) * bounce * 0.6 : 0;
    letters.push(lines.map((line) => {
      let pts = line.map(([u, v]) => {
        const lx = (u - w / 2) * Math.cos(tilt) - (v - 0.5) * Math.sin(tilt) + w / 2;
        const ly = (u - w / 2) * Math.sin(tilt) + (v - 0.5) * Math.cos(tilt) + 0.5;
        return [cx + (lx + ly * slant) * h + (rnd() - 0.5) * jitter, y + dy + ly * h + (rnd() - 0.5) * jitter];
      });
      if (smooth) pts = chaikin(pts, smooth);
      return pts;
    }));
    cx += (w * (1 - tight) + 0.18) * h;
  }
  return { letters, width: cx - x };
}

// --- pieces of the wall ---------------------------------------------------------------------------------------------------

const INK = hex(0x141414), WHITE = hex(0xf4f2ec), SILVER = hex(0xc9cbcd);
const PALETTES = [
  [0xd8262b, 0xf2c419, 0x1f4fa8, 0x141414, 0x2f8f4e, 0xf08cab], // primaries
  [0x6a3d9a, 0xb9a2d8, 0xf7b267, 0xf4845f, 0x2a1b3d, 0x8ad3c7], // lilac & peach
  [0x0b7a75, 0x7bd389, 0xf2e86d, 0xff6f59, 0x1d3557, 0xf1faee], // teal & lime
  [0xe63946, 0xffb703, 0x219ebc, 0x023047, 0xfb8500, 0x8ecae6], // sunset
  [0xff4fa3, 0x2de2e6, 0x261447, 0xff9933, 0xf6019d, 0xffffff] // fluo
];
const pick = (rnd, a) => a[Math.floor(rnd() * a.length)];
const paletteOf = (rnd) => pick(rnd, PALETTES).map(hex);

// A panel's ground: a sprayed rectangle with a ragged top, flat or graded up the wall
function ground(W, x0, x1, top, c0, c1 = c0) {
  const grade = (x, y, out) => { const t = clamp01(y / top); out[0] = c0[0] + (c1[0] - c0[0]) * t; out[1] = c0[1] + (c1[1] - c0[1]) * t; out[2] = c0[2] + (c1[2] - c0[2]) * t; };
  W.rect(x0, -0.1, x1, top, c0 === c1 ? c0 : grade, { soft: 2.5, rough: 9 });
}

// Abstract: big flat shapes on a pale ground, joined by black lines; stars, crescents, eyes and dots
function abstractPanel(W, x0, x1, top, rnd) {
  const pal = paletteOf(rnd);
  ground(W, x0, x1, top, mixRGB(WHITE, pal[1], 0.12));
  const w = x1 - x0, at = () => [x0 + 0.3 + rnd() * (w - 0.6), 0.5 + rnd() * (top - 1.0)];
  const spots = [];
  for (let k = 0; k < 3 + w * 0.8; k++) {
    const [x, y] = at(), r = 0.18 + rnd() * 0.45, c = pal[k % pal.length];
    spots.push([x, y]);
    const kind = rnd();
    if (kind < 0.35) {
      W.disc(x, y, r, c);
      if (rnd() < 0.5) W.ring(x, y, r, 0.035, INK);
    } else if (kind < 0.55) {
      // a crescent: a disc bitten by the ground's colour
      W.disc(x, y, r, c);
      W.disc(x + r * 0.45, y + r * 0.25, r * 0.85, mixRGB(WHITE, pal[1], 0.12));
    } else if (kind < 0.75) {
      const a = rnd() * 6.28;
      W.poly([0, 1, 2].map((i) => [x + r * 1.3 * Math.cos(a + i * 2.1), y + r * 1.3 * Math.sin(a + i * 2.1)]), c);
    } else if (kind < 0.88) {
      // an eye
      W.disc(x, y, r * 0.9, WHITE, { sx: 1.5 });
      W.disc(x, y, r * 0.45, c);
      W.disc(x, y, r * 0.2, INK);
      W.stroke(arc(x, y, r * 1.35, r * 0.9, 0.15, PI - 0.15, 10), 0.03, INK);
    } else {
      // a star of crossed lines
      for (let i = 0; i < 4; i++) {
        const a = (i * PI) / 4 + rnd() * 0.2;
        W.stroke([[x - Math.cos(a) * r, y - Math.sin(a) * r], [x + Math.cos(a) * r, y + Math.sin(a) * r]], 0.025, INK);
      }
    }
  }
  // lines wandering between the shapes, ending in dots
  for (let k = 0; k + 1 < spots.length; k += 2) {
    const [ax, ay] = spots[k], [bx, by] = spots[k + 1];
    const mx = (ax + bx) / 2 + (rnd() - 0.5) * 0.8, my = (ay + by) / 2 + (rnd() - 0.5) * 0.8;
    W.stroke(chaikin([[ax, ay], [mx, my], [bx, by]], 3), 0.022, INK);
    W.disc(bx, by, 0.06, INK);
  }
  for (let k = 0; k < w * 5; k++) { const [x, y] = at(); W.disc(x, y, 0.025 + rnd() * 0.04, pick(rnd, [INK, pal[0], pal[2]])); }
}

// Blobs: the panel packed with rounded cells (a Voronoi of jittered seeds) outlined in black, some patterned inside
function blobPanel(W, x0, x1, top, rnd) {
  const pal = paletteOf(rnd);
  const seeds = [];
  const n = Math.round((x1 - x0) * top * 2.2);
  for (let k = 0; k < n; k++) seeds.push([x0 + rnd() * (x1 - x0), rnd() * top, pal[k % pal.length], rnd()]);
  const X0 = Math.floor(x0 * PPM), X1 = Math.ceil(x1 * PPM), Y1 = Math.min(W.h - 1, Math.ceil(top * PPM));
  const S = seeds.map(([x, y]) => [x * PPM, y * PPM]);
  const edge = 0.035 * PPM;
  const c = W.c;
  for (let y = 0; y <= Y1; y++) {
    for (let x = Math.max(0, X0); x <= Math.min(W.w - 1, X1); x++) {
      let d1 = Infinity, d2 = Infinity, k1 = 0;
      for (let k = 0; k < S.length; k++) {
        const dx = x - S[k][0], dy = y - S[k][1], d = dx * dx + dy * dy;
        if (d < d1) { d2 = d1; d1 = d; k1 = k; } else if (d < d2) d2 = d;
      }
      const gap = (Math.sqrt(d2) - Math.sqrt(d1)) * 0.5;
      const [, , col, pat] = seeds[k1];
      let rgb = col;
      // patterns: dots, stripes or a ring inside some cells
      const sx = S[k1][0], sy = S[k1][1];
      if (pat < 0.25 && ((Math.floor(x / 9) + Math.floor(y / 9)) & 1) && hash2(Math.floor(x / 9), Math.floor(y / 9)) < 0.6) rgb = WHITE;
      else if (pat > 0.8 && (Math.floor((x + y) / 7) & 1)) rgb = mixRGB(col, INK, 0.35);
      else if (pat > 0.6 && Math.abs(Math.sqrt((x - sx) * (x - sx) + (y - sy) * (y - sy)) - 10) < 2.2) rgb = INK;
      const ink = clamp01(edge - gap + 0.5);
      // ragged top: the cells stop under a sprayed edge
      const topEdge = top * PPM + (vnoise(x * 0.05, 3.1) - 0.5) * 10;
      const a = clamp01(topEdge - y);
      if (a <= 0) continue;
      const i = 3 * (y * W.w + x);
      const r = rgb[0] + (INK[0] - rgb[0]) * ink, g = rgb[1] + (INK[1] - rgb[1]) * ink, b = rgb[2] + (INK[2] - rgb[2]) * ink;
      c[i] += (r - c[i]) * a; c[i + 1] += (g - c[i + 1]) * a; c[i + 2] += (b - c[i + 2]) * a;
    }
  }
}

// Bubble letters: a block shadow, a fat outline, a fill and a shine, letter by letter; drips from the fills
function throwUp(W, text, x, y, h, rnd, { fill, line, shade }) {
  const { letters } = layout(text, x, y, h, { slant: 0.08, tight: 0.32, rnd, smooth: 2, bounce: 0.25, jitter: h * 0.03 });
  const r = h * 0.2, o = Math.max(0.025, h * 0.045);
  const sh = [h * 0.06, -h * 0.06];
  for (const L of letters) for (const ln of L) W.stroke(ln.map(([a, b]) => [a + sh[0], b + sh[1]]), r + o, shade);
  // each letter outlined then filled, so the next one's outline bites into it
  for (const L of letters) {
    for (const ln of L) W.stroke(ln, r + o, line);
    for (const ln of L) W.stroke(ln, r, fill);
    for (const ln of L) {
      const [px, py] = ln[0];
      W.stroke([[px - r * 0.35, py + r * 0.3], [px - r * 0.1, py + r * 0.5]], r * 0.12, WHITE);
    }
    if (rnd() < 0.5) {
      const ln = L[0], [px, py] = ln[Math.floor(rnd() * ln.length)];
      W.drip(px + (rnd() - 0.5) * r, py - r * 0.8, 0.15 + rnd() * 0.35, 0.012, fill);
    }
  }
}

// A tag: a quick signature, slanted, one thin line, often underlined with a swash
function tag(W, x, y, h, rnd, colour) {
  const { letters, width } = layout(word(rnd, 3 + Math.floor(rnd() * 3)), x, y, h, {
    slant: 0.25 + rnd() * 0.35, tight: 0.25 + rnd() * 0.25, jitter: h * 0.06, rnd, smooth: 1, bounce: 0.3
  });
  const r = Math.max(0.006, h * (0.035 + rnd() * 0.03));
  for (const L of letters) for (const line of L) W.stroke(line, r, colour);
  if (rnd() < 0.55) {
    const y0 = y - h * 0.15;
    W.stroke(chaikin([[x - h * 0.1, y0 + h * 0.1], [x + width * 0.4, y0 - h * 0.08], [x + width, y0], [x + width + h * 0.25, y0 + h * 0.3]], 2), r, colour);
  }
  if (rnd() < 0.2) W.stroke([[x + width * 0.3, y + h * 1.15], [x + width * 0.4, y + h * 1.35], [x + width * 0.5, y + h * 1.2], [x + width * 0.6, y + h * 1.4], [x + width * 0.7, y + h * 1.15]], r, colour);
  return width;
}

// A piece: one word in thick strokes, a graded fill, highlights, a black outline, a 3D block, arrows, on a sprayed
// cloud of colour; the crew's initials small below
function piece(W, x0, x1, top, rnd) {
  const pal = paletteOf(rnd);
  const back = mixRGB(pal[4], INK, 0.45);
  ground(W, x0, x1, top, back, mixRGB(back, pal[2], 0.35));
  const w = x1 - x0;
  const n = w > 3.6 ? 5 : 4;
  const h = Math.min(top * 0.5, (w - 0.35) / (n * 0.88));
  const text = word(rnd, n);
  const probe = layout(text, 0, 0, h, { slant: 0.15, tight: 0.28 });
  const lx = x0 + (w - probe.width) / 2, ly = top * 0.45 - h / 2;
  // a sprayed cloud behind the letters, rings and dots round it
  for (let k = 0; k < 9; k++) {
    W.disc(lx + rnd() * probe.width, ly + h * (0.1 + rnd() * 0.8), h * (0.35 + rnd() * 0.3), pal[5], { soft: 6 });
  }
  for (let k = 0; k < 10; k++) {
    const x = x0 + 0.2 + rnd() * (w - 0.4), y = 0.3 + rnd() * (top - 0.6), r = 0.04 + rnd() * 0.12;
    W.ring(x, y, r, 0.02, rnd() < 0.5 ? WHITE : pal[3]);
  }
  const { letters } = layout(text, lx, ly, h, { slant: 0.15, tight: 0.28, rnd, bounce: 0.3 });
  const r = h * 0.14, o = Math.max(0.025, h * 0.04);
  const top0 = pal[0], bottom0 = pal[3], split = ly + h * (0.45 + rnd() * 0.15);
  // a two-tone fill split by a wavy line, the lower half graded
  const graded = (x, y, out) => {
    const wave = split + Math.sin(x * 9) * h * 0.04;
    const c = y > wave ? top0 : mixRGB(bottom0, mixRGB(bottom0, top0, 0.4), clamp01((y - ly) / h));
    out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
  };
  const depth = mixRGB(pal[2], INK, 0.6);
  // a pale line round the whole block, then the 3D block (the outline stroke stepped down and right), the black outline
  const shift = (line, s) => line.map(([a, b]) => [a + s * h * 0.011, b - s * h * 0.015]);
  for (const s of [0, 3.5, 7]) for (const L of letters) for (const line of L) W.stroke(shift(line, s), r + o + 0.03, WHITE);
  for (let s = 7; s >= 1; s--) for (const L of letters) for (const line of L) W.stroke(shift(line, s), r + o, depth);
  for (const L of letters) for (const line of L) W.stroke(line, r + o, INK);
  // arrows off some stroke ends
  for (const L of letters) {
    if (rnd() < 0.6) {
      const line = L[Math.floor(rnd() * L.length)];
      const [ax, ay] = line[line.length - 2], [bx, by] = line[line.length - 1];
      const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
      const tip = [bx + ux * h * 0.32, by + uy * h * 0.32];
      W.stroke([[bx, by], tip], r * 0.7 + o, INK);
      W.poly([[tip[0] + ux * r * 2.2, tip[1] + uy * r * 2.2], [tip[0] - uy * r * 2, tip[1] + ux * r * 2], [tip[0] + uy * r * 2, tip[1] - ux * r * 2]], INK);
      W.poly([[tip[0] + ux * r * 1.4, tip[1] + uy * r * 1.4], [tip[0] - uy * r * 1.3, tip[1] + ux * r * 1.3], [tip[0] + uy * r * 1.3, tip[1] - ux * r * 1.3]], pal[3]);
      W.stroke([[bx, by], tip], r * 0.7, graded);
    }
  }
  for (const L of letters) for (const line of L) W.stroke(line, r, graded);
  // highlights: short white dashes along the strokes' upper-left edges
  for (const L of letters) {
    for (const line of L) {
      for (let k = 0; k + 1 < line.length; k += 2) {
        const [ax, ay] = line[k], [bx, by] = line[k + 1];
        W.stroke([[ax - r * 0.4, ay + r * 0.45], [ax * 0.6 + bx * 0.4 - r * 0.4, ay * 0.6 + by * 0.4 + r * 0.45]], r * 0.14, WHITE);
      }
    }
  }
  // sparkles
  for (let k = 0; k < 5; k++) {
    const x = x0 + 0.3 + rnd() * (w - 0.6), y = ly - 0.2 + rnd() * (h + 0.6), s = 0.06 + rnd() * 0.08;
    W.poly([[x, y + s * 2], [x + s * 0.3, y + s * 0.3], [x + s * 2, y], [x + s * 0.3, y - s * 0.3], [x, y - s * 2], [x - s * 0.3, y - s * 0.3], [x - s * 2, y], [x - s * 0.3, y + s * 0.3]], WHITE);
  }
  tag(W, x0 + 0.3 + rnd() * 0.6, ly - 0.55, 0.22, rnd, WHITE);
}

// A character: a big round creature with odd eyes (or one eye and an antenna), on a graded ground strewn with dots
function characterPanel(W, x0, x1, top, rnd, cyclops = false) {
  const pal = paletteOf(rnd);
  ground(W, x0, x1, top, mixRGB(pal[2], INK, 0.2), mixRGB(pal[4], pal[2], 0.3));
  const w = x1 - x0, cx = x0 + w * (0.4 + rnd() * 0.2), cy = top * 0.56, R = Math.min(w * 0.36, top * 0.3);
  for (let k = 0; k < w * 14; k++) W.disc(x0 + rnd() * w, rnd() * top, 0.012 + rnd() * 0.03, pick(rnd, [WHITE, pal[1], pal[5]]), { alpha: 0.85 });
  const skin = pal[1], shadow = mixRGB(skin, pal[4], 0.45);
  // the body: a blob under the head, arms out
  W.disc(cx, cy - R * 1.45, R * 0.95, INK, { sx: 1.1, sy: 1.0 });
  W.disc(cx, cy - R * 1.45, R * 0.89, pal[3], { sx: 1.1, sy: 1.0 });
  for (const s of [-1, 1]) {
    const arm = chaikin([[cx + s * R * 0.8, cy - R * 1.3], [cx + s * R * 1.5, cy - R * 1.0], [cx + s * R * 1.7, cy - R * 0.4]], 2);
    W.stroke(arm, R * 0.16 + 0.025, INK);
    W.stroke(arm, R * 0.16, pal[3]);
    W.disc(arm[arm.length - 1][0], arm[arm.length - 1][1], R * 0.2, skin);
  }
  if (cyclops) {
    // an antenna with a ball, stripes across the body
    const stem = chaikin([[cx, cy + R * 0.9], [cx + R * 0.2, cy + R * 1.35], [cx - R * 0.1, cy + R * 1.7]], 2);
    W.stroke(stem, 0.035, INK);
    W.disc(stem[stem.length - 1][0], stem[stem.length - 1][1], R * 0.16, INK);
    W.disc(stem[stem.length - 1][0], stem[stem.length - 1][1], R * 0.12, pal[0]);
    for (let k = 0; k < 4; k++) W.stroke(arc(cx, cy - R * 1.45, R * 1.0, R * 0.5, PI + 0.4, 2 * PI - 0.4, 10).map(([x, y]) => [x, y + R * (0.5 - k * 0.32)]), R * 0.07, pal[5]);
  } else {
    // ears or horns
    for (const s of [-1, 1]) {
      const tip = [cx + s * R * 0.95, cy + R * 1.25];
      W.poly([[cx + s * R * 0.35, cy + R * 0.8], tip, [cx + s * R * 0.9, cy + R * 0.35]], INK, { soft: 1.2 });
      W.poly([[cx + s * R * 0.42, cy + R * 0.78], [tip[0] - s * R * 0.06, tip[1] - R * 0.1], [cx + s * R * 0.83, cy + R * 0.4]], pal[0]);
    }
  }
  W.disc(cx, cy, R + 0.04, INK);
  W.disc(cx, cy, R, skin);
  // a shadow crescent on one side and a highlight on the other
  W.disc(cx + R * 0.25, cy - R * 0.1, R * 0.85, shadow, { alpha: 0.9 });
  W.disc(cx - R * 0.08, cy + R * 0.04, R * 0.86, skin);
  W.disc(cx - R * 0.45, cy + R * 0.5, R * 0.14, WHITE, { alpha: 0.7, sx: 1.4 });
  // odd eyes: a big one and a small one, pupils looking aside (or the cyclops's one)
  const look = rnd() < 0.5 ? -1 : 1;
  const eyes = cyclops ? [[cx, cy + R * 0.22, R * 0.42]] : [[cx - R * 0.38, cy + R * 0.18, R * 0.3], [cx + R * 0.35, cy + R * 0.22, R * 0.2]];
  for (const [ex, ey, er] of eyes) {
    W.disc(ex, ey, er + 0.025, INK);
    W.disc(ex, ey, er, WHITE);
    W.disc(ex + look * er * 0.35, ey - er * 0.1, er * 0.5, INK);
    W.disc(ex + look * er * 0.2, ey + er * 0.15, er * 0.15, WHITE);
  }
  // a wide mouth with two teeth
  const mouth = arc(cx, cy - R * 0.2, R * 0.55, R * 0.35, PI + 0.35, 2 * PI - 0.35, 12);
  W.poly([...mouth, [mouth[mouth.length - 1][0], mouth[0][1] + R * 0.02]], mixRGB(INK, pal[0], 0.35));
  W.stroke(mouth, 0.02, INK);
  W.stroke([[mouth[0][0], mouth[0][1]], [mouth[mouth.length - 1][0], mouth[mouth.length - 1][1]]], 0.02, INK);
  for (const s of [-0.18, 0.12]) W.rect(cx + s * R, cy - R * 0.33, cx + s * R + R * 0.12, cy - R * 0.2, WHITE);
}

// Geometric: bands of triangles, stripes and rings in a few flat colours
function geometricPanel(W, x0, x1, top, rnd) {
  const pal = paletteOf(rnd);
  ground(W, x0, x1, top, pal[5]);
  let y = 0;
  while (y < top - 0.2) {
    const bh = 0.35 + rnd() * 0.6, kind = rnd(), a = pick(rnd, pal), b = pick(rnd, pal);
    const yb = Math.min(top, y + bh);
    if (kind < 0.35) {
      // zigzag
      const step = bh * 0.8;
      for (let x = x0; x < x1; x += step) W.poly([[x, y], [x + step / 2, yb], [x + step, y]], a);
    } else if (kind < 0.6) {
      for (let x = x0; x < x1; x += 0.24) W.poly([[x, y], [x + 0.12, y], [x + 0.12 + bh * 0.5, yb], [x + bh * 0.5, yb]], a);
    } else if (kind < 0.85) {
      W.rect(x0, y, x1, yb, a, { soft: 1 });
      for (let x = x0 + bh / 2; x < x1; x += bh * 1.1) { W.disc(x, (y + yb) / 2, bh * 0.38, b); W.disc(x, (y + yb) / 2, bh * 0.18, a); }
    } else {
      W.rect(x0, y, x1, yb, INK, { soft: 1 });
      for (let x = x0; x < x1; x += 0.16) W.rect(x, y + 0.05, x + 0.08, yb - 0.05, b);
    }
    y = yb + 0.03;
  }
}

// The left-hand wall's blue panel by the garage: ornament of black & white lines on sky blue, a zigzag crest
function ornamentPanel(W, x0, x1, top, rnd) {
  ground(W, x0, x1, top, hex(0x8cc4e6), hex(0x6fb0de));
  const w = x1 - x0;
  for (let k = 0; k < 6; k++) {
    const cx = x0 + rnd() * w, cy = 0.5 + rnd() * (top - 1.2);
    for (let r = 0.12; r < 0.9; r += 0.09) W.stroke(arc(cx, cy, r, r * (0.7 + rnd() * 0.5), rnd() * 6, rnd() * 6 + 2.5, 18), 0.012, r % 0.18 < 0.09 ? INK : WHITE);
  }
  for (let k = 0; k < 4; k++) {
    let p = [x0 + rnd() * w, 0.3], line = [p];
    for (let i = 0; i < 9; i++) { p = [p[0] + (rnd() - 0.5) * 0.6, p[1] + 0.3]; line.push(p); }
    W.stroke(chaikin(line, 3), 0.03, hex(0x0e3d6b));
    W.stroke(chaikin(line, 3), 0.012, WHITE);
  }
  for (let k = 0; k < 5; k++) {
    const x = x0 + rnd() * w, y = 0.4 + rnd() * (top - 1);
    for (let i = 0; i < 5; i++) { const a = (i * 2 * PI) / 5; W.disc(x + Math.cos(a) * 0.06, y + Math.sin(a) * 0.06, 0.05, hex(0xf2a0c0)); }
    W.disc(x, y, 0.04, WHITE);
  }
  // the crest: black teeth along the top
  for (let x = x0; x < x1; x += 0.16) W.poly([[x, top - 0.18], [x + 0.08, top], [x + 0.16, top - 0.18]], INK);
  W.rect(x0, top - 0.3, x1, top - 0.18, INK);
}

// Posters pasted on the bare wall: faded blocks with lines of "type"
function poster(W, x, y, w, h, rnd) {
  const c = mixRGB(pick(rnd, PALETTES[pick(rnd, [0, 3, 4])].map(hex)), WHITE, 0.3);
  W.rect(x, y, x + w, y + h, c);
  for (let k = 0; k < 4; k++) W.rect(x + w * 0.1, y + h * (0.15 + k * 0.12), x + w * (0.4 + rnd() * 0.5), y + h * (0.2 + k * 0.12), INK, { alpha: 0.6 });
  W.rect(x + w * 0.1, y + h * 0.7, x + w * 0.9, y + h * 0.9, mixRGB(c, INK, 0.5));
  W.rect(x + rnd() * w * 0.5, y, x + w, y + h * 0.3 * rnd(), mixRGB(WHITE, c, 0.3), { alpha: 0.7, rough: 6 }); // torn
}

// ---------------------------------------------------------------------------------------------------------------------
// The sign's script
// ---------------------------------------------------------------------------------------------------------------------
// "dabadaba" in a slanted, joined lowercase script, as the club's sign: one tube per letter, bent along these centre
// lines (x-height 1, baseline 0; each letter from its own origin), the d's and b's with tall looped stems.
const SCRIPT = {
  a: [1.0, [[0.8, 0.8], [0.6, 0.98], [0.3, 0.97], [0.1, 0.74], [0.03, 0.4], [0.13, 0.1], [0.36, 0.0], [0.6, 0.16], [0.76, 0.52],
    [0.84, 0.98], [0.8, 0.52], [0.78, 0.16], [0.86, 0.01], [1.0, 0.03], [1.1, 0.16]]],
  d: [1.06, [[0.8, 0.8], [0.6, 0.98], [0.3, 0.97], [0.1, 0.74], [0.03, 0.4], [0.13, 0.1], [0.36, 0.0], [0.6, 0.16], [0.78, 0.6],
    [0.92, 1.3], [1.0, 1.85], [0.95, 2.04], [0.86, 1.94], [0.83, 1.4], [0.8, 0.7], [0.79, 0.2], [0.88, 0.01], [1.02, 0.03], [1.12, 0.16]]],
  b: [0.84, [[0.0, 0.2], [0.18, 0.75], [0.33, 1.45], [0.38, 1.9], [0.28, 2.06], [0.16, 1.9], [0.12, 1.3], [0.1, 0.6], [0.12, 0.12],
    [0.3, 0.0], [0.56, 0.1], [0.7, 0.42], [0.62, 0.8], [0.4, 0.92], [0.25, 0.8], [0.5, 0.84], [0.78, 0.9], [0.95, 0.92]]]
};
const SLANT = 0.24;

// The letters' centre lines, scaled so the word is `width` metres wide, centred on (0, 0): [[x, y], ...] per letter
function scriptPaths(width) {
  const text = 'dabadaba';
  let x = 0;
  const raw = [];
  for (const ch of text) {
    const [adv, pts] = SCRIPT[ch];
    raw.push(pts.map(([u, v]) => [x + u + v * SLANT, v]));
    x += adv;
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of raw) for (const [u, v] of p) { x0 = Math.min(x0, u); x1 = Math.max(x1, u); y0 = Math.min(y0, v); y1 = Math.max(y1, v); }
  const s = width / (x1 - x0), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return raw.map((p) => p.map(([u, v]) => [(u - cx) * s, (v - cy) * s]));
}

let atlas = null;
function muralAtlas() {
  if (atlas) return atlas;
  const W = new Wall(ATLAS_W, ATLAS_H);
  const rnd = seeded(20120927); // any fixed seed
  // the bare wall: off-white render, greyer and dirtier towards the foot
  const bare = hex(0xd9d6cc);
  W.fill(0, 0, ATLAS_LEN, ATLAS_TOP, bare);

  // The right-hand wall: panels side by side from the tunnel to the street, bare render between some of them; the
  // first, by the tunnel, the tallest (as the real one there)
  const throwUps = (W, x0, x1, top, rnd) => {
    const pal = paletteOf(rnd);
    ground(W, x0, x1, top, pal[2]);
    throwUp(W, word(rnd, 4), x0 + 0.3, top * 0.5, Math.min(1.25, top * 0.28), rnd, { fill: SILVER, line: INK, shade: mixRGB(pal[2], INK, 0.6) });
    throwUp(W, word(rnd, 3), x0 + 0.5, top * 0.1, Math.min(1.1, top * 0.25), rnd, { fill: pal[1], line: pal[4], shade: INK });
  };
  const cyclops = (W, x0, x1, top, rnd) => characterPanel(W, x0, x1, top, rnd, true);
  const order = [abstractPanel, throwUps, blobPanel, piece, geometricPanel, cyclops, abstractPanel, piece, blobPanel, throwUps];
  let x = 0, k = 0;
  const panels = [], gaps = [];
  const [, rightEnd] = ATLAS.right;
  while (x < rightEnd - 0.8) {
    const first = k === 0;
    const w = Math.min(first ? 4.6 : 2.6 + rnd() * 2.2, rightEnd - x);
    const top = first ? 5.5 : 3.6 + rnd() * 1.6;
    panels.push([x, x + w, top]);
    (first ? characterPanel : order[(k - 1) % order.length])(W, x, x + w, top, rnd);
    const gap = rnd() < 0.3 ? 0 : 0.25 + rnd() * 0.6;
    if (gap) gaps.push([x + w, x + w + gap]);
    x += w + gap;
    k++;
  }
  gaps.push([x, rightEnd]);
  // Posters on the bare stretches; tags thick there, along the foot of everything, and now and then over a panel
  const tagInks = [INK, INK, INK, SILVER, WHITE, hex(0xd8262b), hex(0x1f4fa8), hex(0x2f8f4e)];
  for (const [g0, g1] of gaps) {
    if (g1 - g0 > 0.5 && rnd() < 0.7) poster(W, g0 + 0.05, 1.0 + rnd() * 0.6, Math.min(0.42, g1 - g0 - 0.1), 0.6, rnd);
    for (let t = 0; t < 2 + (g1 - g0) * 4; t++) tag(W, g0 - 0.2 + rnd() * (g1 - g0), 0.4 + rnd() * 2.6, 0.12 + rnd() * 0.22, rnd, pick(rnd, tagInks));
  }
  for (let tx = 0.3; tx < rightEnd - 0.5; tx += 0.8 + rnd() * 1.4) tag(W, tx, 0.12 + rnd() * 0.75, 0.1 + rnd() * 0.28, rnd, pick(rnd, tagInks));
  for (let t = 0; t < 8; t++) tag(W, rnd() * (rightEnd - 1), 1.2 + rnd() * 1.6, 0.15 + rnd() * 0.3, rnd, pick(rnd, tagInks));

  // The left-hand wall: the blue ornament by the garage, and two panels by the street
  const [l0, l1] = ATLAS.leftEnd, [m0, m1] = ATLAS.leftMouth;
  W.fill(l0, 0, ATLAS_LEN, ATLAS_TOP, RENDER); // the yellow render behind them
  ornamentPanel(W, l0 + 0.05, l1 - 0.05, 3.05, rnd);
  abstractPanel(W, m0 + 0.1, m0 + 2.4, 3.0, rnd);
  piece(W, m0 + 2.55, m1 - 0.1, 3.0, rnd);
  for (let tx = l0 + 0.2; tx < ATLAS_LEN - 0.5; tx += 0.9 + rnd() * 1.2) tag(W, tx, 0.15 + rnd() * 1.4, 0.1 + rnd() * 0.22, rnd, pick(rnd, tagInks));
  // above them, the plinth the rest of the left-hand wall repeats: grey paint, tags over tags, a sticker or two
  const [g0, g1] = ATLAS.leftTags;
  W.fill(g0, TAG_BAND - 0.15, g1, TAG_BAND + PLINTH + 0.15, hex(0x5d5c58));
  const plinthInks = [WHITE, WHITE, SILVER, INK, hex(0xf08cab), hex(0x8ad3c7), hex(0xf2c419)];
  for (let tx = g0 - 0.3; tx < g1; tx += 0.35 + rnd() * 0.5) {
    tag(W, tx, TAG_BAND + 0.12 + rnd() * 0.5, 0.12 + rnd() * 0.3, rnd, pick(rnd, plinthInks));
  }
  for (let k = 0; k < 6; k++) {
    const x = g0 + rnd() * (g1 - g0 - 0.1), y = TAG_BAND + 0.3 + rnd() * 0.6;
    W.rect(x, y, x + 0.08, y + 0.06, pick(rnd, [WHITE, hex(0xf2c419), hex(0xd8262b)]));
  }

  // Weather: grain in the render, rain streaks down the wall, grime and splashes along the foot
  const c = W.c, out = new Uint8Array(ATLAS_W * ATLAS_H * 4);
  const streaks = new Float32Array(ATLAS_W);
  for (let x = 0; x < ATLAS_W; x++) streaks[x] = 0.07 * clamp01(vnoise(x * 0.35, 0.5) * 2.2 - 1.1) + 0.03 * vnoise(x * 0.02, 7.5);
  const grain = new Float32Array(4096); // a tile of grain, read at a stride that never lines up
  for (let k = 0; k < grain.length; k++) grain[k] = 0.95 + 0.07 * hash2(k, 17);
  const footRows = Math.ceil(0.5 * PPM);
  for (let y = 0; y < ATLAS_H; y++) {
    const m = y / PPM, foot = clamp01(1 - m / 0.45), fade = 0.6 + 0.4 * (m / ATLAS_TOP), g0 = (y * 2731) & 4095;
    for (let x = 0, i = y * ATLAS_W; x < ATLAS_W; x++, i++) {
      let f = grain[(g0 + x * 37) & 4095] * (1 - streaks[x] * fade) * 255;
      if (y < footRows) f *= 1 - foot * (0.3 + 0.3 * vnoise(x * 0.1, y * 0.1));
      const r = c[3 * i] * f, g = c[3 * i + 1] * f, b = c[3 * i + 2] * f * 0.98;
      out[4 * i] = r > 255 ? 255 : r + 0.5;
      out[4 * i + 1] = g > 255 ? 255 : g + 0.5;
      out[4 * i + 2] = b > 255 ? 255 : b + 0.5;
      out[4 * i + 3] = 255;
    }
  }
  atlas = { data: out, width: ATLAS_W, height: ATLAS_H, panels };
  return atlas;
}
