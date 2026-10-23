import * as THREE from 'three/webgpu';
import { CentreModel, style, FK, FT, rect } from './bretxa.js';

// js/donostia/landmarks/tabakalera.js
// Tabakalera: the tobacco factory of 1913 beside the Estación del Norte, the International Centre for Contemporary
// Culture since its renovation in 2015. A 113 x 77 m block of a ground floor and two upper floors round four courtyards
// (OSM relation 3266749 draws them as its inner rings). From the photos (Wikimedia Commons: Tabakalera, Remux, Unuaiga,
// Sami Mlouhi):
//  - the wings: a ground floor of golden sandstone ashlar with tall rectangular windows, then two floors of
//    round-headed windows in plain white render, a sandstone entablature and cornice, light grey standing-seam roofs;
//  - corner pavilions barely proud of the wings: sandstone quoins and piers framing white render panels, three
//    round-headed windows a floor on each face in sandstone surrounds, each over a little balustraded balcony;
//  - in the middle of the west front (towards the railway) a pavilion rising a storey higher, square windows in its
//    attic and the clock in a scrolled aedicule on top between pedestals;
//  - on the roof of the central block the 2015 "Prisma": a glass storey under a long box clad in bronze mesh, with the
//    lookout terrace in front of it to the west (OSM node "Terraza Tabakalera (Prisma)").
// b5m: 23.3 m mean, 34.7 m at the Prisma.
//
// build(sites, ctx) receives the GEO.landmarks entries ['tabakalera'] (footprint ring, at [x, z], buildings, height —
// see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates.

// The block's corners and the courtyards (inner rings of the OSM relation), local frame [x, z]
const CORNERS = [1010.6, 455.0, 999.3, 568.2, 1075.0, 576.5, 1087.5, 463.7];
const COURTYARDS = [
  [1020.5, 494.8, 1023.4, 469.4, 1042.9, 471.6, 1040.1, 496.9],
  [1054.0, 472.5, 1073.5, 474.7, 1070.0, 505.9, 1050.5, 503.8],
  [1016.9, 530.6, 1036.1, 532.8, 1033.1, 558.5, 1013.9, 556.3],
  [1044.0, 559.3, 1047.4, 528.8, 1066.8, 530.9, 1063.4, 561.4]
];

// Heights above the ground: plinth, first floor, frieze, cornice; the clock pavilion's attic
const Y = { plinth: 1.6, first: 7.4, frieze: 18.0, cornice: 19.4, attic: 23.6 };

function offsetOut(r, d) {
  return [r[0] - d, r[1] - d, r[2] + d, r[3] - d, r[4] + d, r[5] + d, r[6] - d, r[7] + d];
}

// Upright disc in the u-y plane centred on (u, y), t thick along v (the clock)
function disc(m, mat, u, y, v, r, t, n, st) {
  const ring = [];
  for (let k = 0; k < n; k++) ring.push([u + r * Math.cos((2 * Math.PI * k) / n), y + r * Math.sin((2 * Math.PI * k) / n)]);
  m.faceDir(mat, ring.map(([a, b]) => [a, b, v - t / 2]), [0, 0, -1], st);
  m.faceDir(mat, ring.map(([a, b]) => [a, b, v + t / 2]), [0, 0, 1], st);
  for (let k = 0; k < n; k++) {
    const [a0, b0] = ring[k], [a1, b1] = ring[(k + 1) % n];
    m.faceDir(mat, [[a0, b0, v - t / 2], [a1, b1, v - t / 2], [a1, b1, v + t / 2], [a0, b0, v + t / 2]], [a0 + a1 - 2 * u, b0 + b1 - 2 * y, 0], st);
  }
}

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const ob = ctx.kit.orientedBox(CORNERS);
  // the hand-placed plan follows the 2026 outline; if the outline ever moves, keep the plain extrusion
  const fob = ctx.kit.orientedBox(site.footprint);
  if (Math.hypot(fob.x - ob.x, fob.z - ob.z) > 12) return null;
  // +u runs north along the west front, +v east: the west front (towards the railway) faces -v
  let angle = ob.angle;
  if (Math.sin(angle) > 0) angle += Math.PI;
  const c = Math.cos(angle), s = Math.sin(angle);
  const toLocal = (x, z) => [(x - ob.x) * c + (z - ob.z) * s, -(x - ob.x) * s + (z - ob.z) * c];
  const ringLocal = (r) => {
    const out = [];
    for (let k = 0; k < r.length; k += 2) out.push(...toLocal(r[k], r[k + 1]));
    return out;
  };
  const corners = ringLocal(CORNERS);
  let U = 0, V = 0;
  for (let k = 0; k < 8; k += 2) { U = Math.max(U, Math.abs(corners[k])); V = Math.max(V, Math.abs(corners[k + 1])); }
  const geoGround = (site.buildings || []).map((i) => ctx.GEO.buildings[i]?.ground).find(Number.isFinite);
  const ground = Number.isFinite(geoGround) ? geoGround : Math.max(0, ctx.terrain.heightAt(ob.x, ob.z));
  const P = ctx.kit.lowestGround(ctx, site.footprint) - ground - 0.3;
  const courts = COURTYARDS.map(ringLocal);
  const courtBox = courts.map((r) => {
    const us = [r[0], r[2], r[4], r[6]], vs = [r[1], r[3], r[5], r[7]];
    return { u0: Math.min(...us), u1: Math.max(...us), v0: Math.min(...vs), v1: Math.max(...vs) };
  });
  // the perimeter wings end where the courtyards begin
  const northEdge = Math.max(...courtBox.map((b) => b.u1)), southEdge = Math.min(...courtBox.map((b) => b.u0));
  const westEdge = Math.min(...courtBox.map((b) => b.v0)), eastEdge = Math.max(...courtBox.map((b) => b.v1));

  const zinc = new THREE.MeshStandardNodeMaterial({ color: 0x8e9599, roughness: 0.45, metalness: 0.5 });
  const m = new CentreModel();
  m.use({ x: ob.x, z: ob.z, angle, ground });
  const F = m.facade;
  const sand = style(FK.plain, FT.sand);
  const rustic = style(FK.rustic, FT.sand, { floor: 3 });
  const groundFloor = style(FK.rect, FT.sand, { bay: 4.4, ground: Y.first - Y.plinth, floor: 5, base: Y.plinth });
  const upper = style(FK.arched, FT.white, { bay: 4.4, floor: 5.3, base: Y.first });

  // The block: outer walls, then the courtyards' walls facing in, storey by storey; a flat roof with the courtyards
  // open, a string course at the first floor and the cornice round the outside
  const outer = rect(-U, U, -V, V);
  const bands = [[P, Y.plinth, rustic], [Y.plinth, Y.first, groundFloor], [Y.first, Y.frieze, upper], [Y.frieze, Y.cornice, sand]];
  for (const [y0, y1, st] of bands) {
    m.prism(F, outer, y0, y1, st, { top: false });
    for (const r of courts) m.innerWalls(F, r, y0, y1, st);
  }
  m.capHoles(F, outer, courts, Y.cornice, true, style(FK.plain, FT.grey));
  m.corniceBand(F, outer, Y.cornice - 0.15, 0.7, 0.75);
  m.prism(F, offsetOut(outer, 0.12), Y.first - 0.05, Y.first + 0.4, sand, { top: false, bottom: true });
  m.prism(F, offsetOut(outer, 0.08), Y.plinth - 0.1, Y.plinth + 0.15, sand, { top: false, bottom: true });

  // Corner pavilions, 12.5 m a side and 0.5 m proud
  const cw = 12.5, out = 0.5;
  const panelled = style(FK.arched, FT.sandPanelGlass, { bay: 4.1, floor: 5.3, base: Y.first });
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      const u0 = su > 0 ? U - cw : -U - out, u1 = su > 0 ? U + out : -U + cw;
      const v0 = sv > 0 ? V - cw : -V - out, v1 = sv > 0 ? V + out : -V + cw;
      const pr = rect(u0, u1, v0, v1);
      m.prism(F, pr, P, Y.plinth, rustic, { top: false });
      m.prism(F, pr, Y.plinth, Y.first, groundFloor, { top: false });
      m.prism(F, pr, Y.first, Y.frieze, panelled, { top: false });
      m.prism(F, pr, Y.frieze, Y.cornice + 0.9, sand, { top: true });
      m.cornice(F, pr, Y.cornice - 0.1, 0.75, 0.8);
      m.prism(F, offsetOut(pr, 0.15), Y.first - 0.05, Y.first + 0.45, sand, { top: false, bottom: true });
      // sandstone quoins at the outer corner
      const qu = su > 0 ? u1 : u0, qv = sv > 0 ? v1 : v0;
      const box = (a0, a1, b0, b1) => m.box(F, Math.min(a0, a1), Math.max(a0, a1), Y.first, Y.frieze, Math.min(b0, b1), Math.max(b0, b1), sand, { top: false });
      box(qu, qu - su * 1.4, qv - sv * 0.02, qv + sv * 0.12);
      box(qu - su * 0.02, qu + su * 0.12, qv, qv - sv * 1.4);
      // a little balustraded balcony under each of the three windows of both upper floors, on both outer faces
      const vf = sv > 0 ? v1 : v0, uf = su > 0 ? u1 : u0;
      const thirds = (a0, a1) => [0, 1, 2].map((k) => a0 + ((k + 0.5) * (a1 - a0)) / 3);
      for (const y of [Y.first + 5.3 * 0.2 - 0.95, Y.first + 5.3 * 1.2 - 0.95]) {
        for (const u of thirds(u0, u1)) {
          m.box(F, u - 1.0, u + 1.0, y - 0.2, y, Math.min(vf, vf + sv * 0.45), Math.max(vf, vf + sv * 0.45), sand, { bottom: true });
          m.balustrade(F, FT.sand, [u - 0.85, vf + sv * 0.3], [u + 0.85, vf + sv * 0.3], y, 0.85);
        }
        for (const v of thirds(v0, v1)) {
          m.box(F, Math.min(uf, uf + su * 0.45), Math.max(uf, uf + su * 0.45), y - 0.2, y, v - 1.0, v + 1.0, sand, { bottom: true });
          m.balustrade(F, FT.sand, [uf + su * 0.3, v - 0.85], [uf + su * 0.3, v + 0.85], y, 0.85);
        }
      }
      // a scrolled crest on the parapet over each face
      m.fan(F, (u0 + u1) / 2, Y.cornice + 0.9, sv > 0 ? v1 - 0.2 : v0 + 0.2, 1.2, 0.35, 'u', 10);
      m.fan(F, su > 0 ? u1 - 0.2 : u0 + 0.2, Y.cornice + 0.9, (v0 + v1) / 2, 1.2, 0.35, 'v', 10);
    }
  }

  // The west front's clock pavilion, 16 m wide and a metre proud, rising an attic storey above the wings
  {
    const v0 = -V - 1.0, v1 = -V + 2.0, u0 = -8, u1 = 8;
    const pr = rect(u0, u1, v0, v1);
    m.prism(F, pr, P, Y.plinth, rustic, { top: false });
    m.prism(F, pr, Y.plinth, Y.first, groundFloor, { top: false });
    m.prism(F, pr, Y.first, Y.frieze, style(FK.arched, FT.sandPanelGlass, { bay: 4.0, floor: 5.3, base: Y.first }), { top: false });
    m.prism(F, pr, Y.frieze, Y.attic, style(FK.rect, FT.sandPanelGlass, { bay: 3.2, floor: Y.attic - Y.frieze - 0.6, base: Y.frieze + 0.6 }), { top: true });
    m.cornice(F, pr, Y.attic - 0.1, 0.7, 0.75);
    m.prism(F, offsetOut(pr, 0.15), Y.first - 0.05, Y.first + 0.45, sand, { top: false, bottom: true });
    m.prism(F, offsetOut(pr, 0.12), Y.frieze - 0.1, Y.frieze + 0.5, sand, { top: false, bottom: true });
    m.box(F, u0 - 0.3, u0 + 0.9, Y.first, Y.attic - 0.1, v0 - 0.15, v0 + 0.4, sand, { top: false });
    m.box(F, u1 - 0.9, u1 + 0.3, Y.first, Y.attic - 0.1, v0 - 0.15, v0 + 0.4, sand, { top: false });
    // the balcony on corbels across the second floor
    const yb = Y.first + 5.3 - 0.95 + 0.2;
    m.box(F, u0 + 0.6, u1 - 0.6, yb - 0.25, yb, v0 - 0.55, v0, sand, { bottom: true });
    m.balustrade(F, FT.sand, [u0 + 0.8, v0 - 0.4], [u1 - 0.8, v0 - 0.4], yb, 0.95);
    // the clock aedicule: a scrolled segmental pediment over the dial, pedestals with finials on the corners
    const yp = Y.attic + 0.65;
    m.box(F, u0 + 0.2, u1 - 0.2, Y.attic + 0.55, Y.attic + 1.15, v0 + 0.2, v0 + 0.6, sand); // parapet
    m.box(F, -2.3, 2.3, yp, yp + 2.9, v0 + 0.3, v0 + 1.2, sand);
    m.fan(F, 0, yp + 2.9, v0 + 0.75, 2.5, 0.75, 'u', 14);
    m.fan(F, 0, yp + 4.9, v0 + 0.75, 0.55, 0.5, 'u', 8);
    m.fan(F, -2.7, yp, v0 + 0.75, 0.95, 0.55, 'u', 8);
    m.fan(F, 2.7, yp, v0 + 0.75, 0.95, 0.55, 'u', 8);
    for (const u of [u0 + 0.6, u1 - 0.6]) {
      m.box(F, u - 0.55, u + 0.55, yp - 0.1, yp + 1.4, v0 + 0.1, v0 + 1.2, sand);
      m.dome(F, u, v0 + 0.65, yp + 1.4, [[0.3, 0], [0.45, 0.35], [0.2, 0.75], [0.25, 0.85], [0.03, 1.0]], 8);
    }
    // the dial: white in a stone ring, dark hands at ten past ten
    const yc = yp + 1.55, vf = v0 + 0.3;
    disc(m, F, 0, yc, vf - 0.1, 1.05, 0.2, 24, sand);
    disc(m, F, 0, yc, vf - 0.24, 0.85, 0.06, 24, style(FK.plain, FT.grey));
    const dark = style(FK.plain, FT.bronze);
    m.beam(F, [0, yc, vf - 0.3], [0.42, yc + 0.3, vf - 0.3], 0.03, 0.08, dark);
    m.beam(F, [0, yc, vf - 0.33], [-0.6, yc + 0.35, vf - 0.33], 0.03, 0.06, dark);
  }

  // The east entrance block on the plaza: 24 m wide, 3 m proud
  {
    const pr = rect(-11.9, 12.0, V - 1.0, V + 3.1);
    m.prism(F, pr, P, Y.plinth, rustic, { top: false });
    m.prism(F, pr, Y.plinth, Y.first, style(FK.arcade, FT.sand, { bay: 4.8, ground: Y.first - Y.plinth, floor: 5, base: Y.plinth }), { top: false });
    m.prism(F, pr, Y.first, Y.frieze, style(FK.arched, FT.sandPanelGlass, { bay: 4.8, floor: 5.3, base: Y.first }), { top: false });
    m.prism(F, pr, Y.frieze, Y.cornice + 0.9, sand, { top: true });
    m.cornice(F, pr, Y.cornice - 0.1, 0.75, 0.8);
    m.prism(F, offsetOut(pr, 0.12), Y.first - 0.05, Y.first + 0.4, sand, { top: false, bottom: true });
    m.fan(F, 0, Y.cornice + 0.9, V + 2.9, 2.2, 0.4, 'u', 12);
  }

  // Roofs: low standing-seam roofs over the perimeter wings and the spine; the central block is flat round the Prisma,
  // and the west wing's middle stays flat for the terrace
  const ye = Y.cornice;
  const pr = (u0, u1, v0, v1, axis) => m.pitched(zinc, u0, u1, v0, v1, ye, Math.min(2.6, 0.22 * Math.min(u1 - u0, v1 - v0)), { axis, hip: true });
  pr(northEdge, U - 0.5, -V + cw, V - cw, 'v');
  pr(-U + 0.5, southEdge, -V + cw, V - cw, 'v');
  pr(-U + cw, -12.5, -V + 0.5, westEdge, 'u');
  pr(12.5, U - cw, -V + 0.5, westEdge, 'u');
  pr(-U + cw, -12.5, eastEdge, V - 0.5, 'u');
  pr(12.5, U - cw, eastEdge, V - 0.5, 'u');
  const spine = (bs) => [Math.max(...bs.filter((b) => b.v1 < 0).map((b) => b.v1)), Math.min(...bs.filter((b) => b.v0 > 0).map((b) => b.v0))];
  const north = courtBox.filter((b) => b.u0 > 0), south = courtBox.filter((b) => b.u1 < 0);
  const [nv0, nv1] = spine(north), [sv0, sv1] = spine(south);
  pr(Math.min(...north.map((b) => b.u0)), northEdge, nv0, nv1, 'u');
  pr(southEdge, Math.max(...south.map((b) => b.u1)), sv0, sv1, 'u');

  // The Prisma (2015): a glass storey set back 1 m under a long box clad in bronze mesh over the central block, its top
  // 34 m up (b5m 34.7 m); the lookout terrace on the west wing in front of it, behind a glass parapet
  {
    const u0 = -8, u1 = 8, v0 = -27, v1 = 22, yb = Y.cornice, ym = yb + 4.2, yt = 34.0;
    m.prism(F, rect(u0 + 1, u1 - 1, v0 + 1, v1 - 1), yb, ym, style(FK.glazed, FT.grey, { bay: 1.5, floor: 4.2, base: yb }), { top: false });
    m.prism(F, rect(u0, u1, v0, v1), ym, yt, style(FK.mesh, FT.bronze, { bay: 3, floor: 1.2, base: ym }), { top: true, bottom: true });
    const glassRail = style(FK.glazed, FT.grey, { bay: 1.2, floor: 1.1, base: yb });
    const tv = -V + 0.6;
    m.wall(F, [u0 - 3, tv], [u1 + 3, tv], 0.06, yb, yb + 1.1, glassRail);
    m.wall(F, [u0 - 3, tv], [u0 - 3, v0], 0.06, yb, yb + 1.1, glassRail);
    m.wall(F, [u1 + 3, tv], [u1 + 3, v0], 0.06, yb, yb + 1.1, glassRail);
  }

  return m.finish('Tabakalera');
}
