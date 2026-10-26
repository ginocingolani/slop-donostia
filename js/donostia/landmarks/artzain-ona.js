import { CivicModel, civicFrame, facadeStyle, WIN, TONE, rect, ngon, arc, offsetRing } from './udaletxea.js';

// js/donostia/landmarks/artzain-ona.js
// Artzain Onaren katedrala / Catedral del Buen Pastor (1888-97, Manuel de Echave): neo-Gothic cathedral of Igeldo
// sandstone with an Angers slate roof. Its single west tower carries an openwork spire to 75 m over the main portal, the
// tallest in Gipuzkoa; b5m only measures the 22 m nave. The plan (es.wikipedia, after the diocese): a Latin cross 64 m
// long and 36 m wide at the transept, three naves of six bays (the central one 25 m high inside), the side naves
// splitting into two each beyond the crossing, a pentagonal apse without ambulatory, rose windows in both transept
// gables, buttresses and pinnacles all round.
//
// build(sites, ctx) receives the GEO.landmarks entries ['artzain-ona'] (footprint ring, at [x, z], buildings, height —
// see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates; the plain extrusions of the cathedral's 1:500 buildings are hidden.

// Frame (from the OSM outline): +u runs north-north-west along the nave to the tower, v across (+v east-north-east).
// Plan positions are metres from the outline's centre in that frame.
const TOWER_DIR = [-0.479, -0.878];

// Heights above the plaza (m): aisle eaves, the top of the lean-to aisle roofs, clerestory eaves, ridge
const AISLE = 11.5, AISLE_TOP = 15.5, EAVE = 24.0, RIDGE = 33.3;
// Central nave & choir walls, transept, tower
const NV0 = -6.2, NV1 = 6.8, VC = (NV0 + NV1) / 2;
const TR0 = -8.5, TR1 = 3.6, TW = 18.7;
const TOWER = { u0: 33.3, u1: 44.4, v0: -4.6, v1: 6.5 };
// The tower's stages (scaled from the frontal photograph, Wikimedia Commons "Catedral del Buen Pastor (9225828442)", on
// the 75 m total): the square base with the portal, a traceried window and the rose to ~30 m; a clock stage between the
// corner buttresses' tall pinnacles (to ~49 m); the belfry of paired lancets under gablets and pinnacles to ~53 m; the
// octagonal openwork spire with crockets on its arrises to the cross
const BASE_TOP = 30.0, CLOCK_TOP = 37.6, BELFRY_TOP = 52.6, SPIRE_TOP = 73.5;

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, TOWER_DIR, { front: [47.5, 1.0] });
  const T = TONE.sandstone;
  const m = new CivicModel(frame, { tone: T });
  // buttresses, pinnacles and tracery in the facade's own stone (one material, one tone)
  const F = m.facade, stone = F, slate = materials.slate, iron = materials.iron;
  const P = frame.plinth;

  const plain = facadeStyle(WIN.plain, T);
  const aisleStyle = facadeStyle(WIN.lancet, T, { bay: 5.0, ground: 0, floor: AISLE });
  const highStyle = facadeStyle(WIN.lancet, T, { bay: 4.4, ground: 0, floor: 12 });
  const cross = (u, v, y, h = 1.8) => {
    m.beam(iron, [u, y, v], [u, y + h, v], 0.12, 0.12);
    m.beam(iron, [u, y + h * 0.68, v - h * 0.28], [u, y + h * 0.68, v + h * 0.28], 0.1, 0.1);
  };

  // Nave aisles (six bays between the facade and the crossing), lit by tall lancets, under lean-to roofs
  const aisles = [[3.6, 33.0, -14.2, NV0, -1], [3.6, 33.0, NV1, 15.4, 1]];
  // Chancel aisles: the side naves doubled from the crossing to the east end
  const chancel = [[-44.2, TR0, -TW, NV0, -1], [-44.2, TR0, NV1, TW, 1]];
  for (const [u0, u1, v0, v1, side] of [...aisles, ...chancel]) {
    const outer = side < 0 ? v0 : v1, inner = side < 0 ? v1 : v0;
    const end = u0 < 0 ? aisleStyle : plain; // the chancel aisles' east ends are seen; the nave aisles' west ends are not
    const faces = side < 0 ? [aisleStyle, plain, plain, end] : [plain, plain, aisleStyle, end];
    m.box(F, u0, u1, P, AISLE, v0, v1, plain, { faces, top: false });
    m.prism(stone, offsetRing(rect(u0, u1, v0, v1), -0.3), AISLE, AISLE + 0.4, null, { bottom: true, top: false });
    m.shed(slate, u0 - (u0 < 0 ? 0.3 : 0), u1, outer + side * 0.35, inner, AISLE + 0.4, AISLE_TOP);
  }

  // Clerestory of the nave and the choir, with an openwork parapet and steep slate roofs
  for (const [u0, u1] of [[TR1, 33.0], [-38.0, TR0]]) {
    m.box(F, u0, u1, P, EAVE, NV0, NV1, highStyle, { faces: [highStyle, plain, highStyle, plain], top: false });
    m.prism(stone, offsetRing(rect(u0, u1, NV0, NV1), -0.35), EAVE, EAVE + 0.45, null, { bottom: true });
    m.balustrade(stone, T, [u0, NV0 - 0.2], [u1, NV0 - 0.2], EAVE + 0.45, 0.9);
    m.balustrade(stone, T, [u0, NV1 + 0.2], [u1, NV1 + 0.2], EAVE + 0.45, 0.9);
    m.pitched(slate, u0, u1, NV0 + 0.3, NV1 - 0.3, EAVE + 0.45, RIDGE - EAVE - 0.45, { axis: 'u', endMat: F, endStyle: plain });
  }

  // Transept: lancets below, a rose window high in each gable end
  {
    const lower = facadeStyle(WIN.lancet, T, { bay: 4.0, ground: 0, floor: 12 });
    const upper = facadeStyle(WIN.lancet, T, { bay: 4.4, ground: 0, floor: 12, base: 12 });
    const rose = facadeStyle(WIN.rose, T, { bay: 3.9, floor: 4.9, base: 12 });
    m.box(F, TR0, TR1, P, 12, -TW, TW, lower, { top: false });
    m.box(F, TR0, TR1, 12, EAVE, -TW, TW, upper, { faces: [rose, upper, rose, upper], top: false });
    m.prism(stone, offsetRing(rect(TR0, TR1, -TW, TW), -0.35), EAVE, EAVE + 0.48, null, { bottom: true });
    m.pitched(slate, TR0 - 0.2, TR1 + 0.2, -TW - 0.2, TW + 0.2, EAVE + 0.45, RIDGE - EAVE - 0.45, {
      axis: 'v', endMat: F, endStyle: plain
    });
    for (const s of [-1, 1]) {
      cross((TR0 + TR1) / 2, s * (TW + 0.2), RIDGE);
      // diagonal buttresses at the transept corners, ending in pinnacles
      for (const u of [TR0, TR1]) {
        const du = u === TR0 ? -1 : 1;
        const cu = u + du * 0.7, cv = s * (TW + 0.7);
        m.prism(stone, ngon(cu, cv, 1.5, 4), P, 14, null, { top: false });
        m.dome(stone, cu, cv, 14, [[1.5, 0], [1.05, 1.2]], 4, { smooth: false });
        m.prism(stone, ngon(cu, cv, 1.05, 4), 15.2, 22, null, { top: false });
        m.pinnacle(stone, cu, cv, 22, 23.5, 0.45, 5.0);
      }
    }
  }

  // Pentagonal apse closing the choir, under a half-cone of slate
  {
    const cu = -38.0, r = VC - NV0;
    const ring = arc(cu, VC, r, Math.PI / 2, (3 * Math.PI) / 2, 5);
    m.prism(F, ring, P, EAVE, highStyle, { top: false });
    const eaveRing = offsetRing(ring, -0.35);
    m.prism(stone, eaveRing, EAVE, EAVE + 0.42, null, { bottom: true });
    m.loft(slate, [eaveRing, eaveRing.map((x, k) => (k % 2 ? VC : cu))], [EAVE + 0.45, RIDGE], { top: false });
    cross(cu, VC, RIDGE - 0.2, 1.6);
  }

  // Buttresses between the bays, with pinnacles; flying buttresses over the aisles prop the clerestory
  const buttress = (u, wallV, side, flyTo) => {
    const v0 = side < 0 ? wallV - 1.5 : wallV, v1 = side < 0 ? wallV : wallV + 1.5;
    m.box(stone, u - 0.6, u + 0.6, P, AISLE + 0.6, v0, v1, null, { top: false });
    const slope = side < 0 ? rect(u - 0.6, u + 0.6, wallV - 0.8, wallV) : rect(u - 0.6, u + 0.6, wallV, wallV + 0.8);
    m.loft(stone, [rect(u - 0.6, u + 0.6, v0, v1), slope], [AISLE + 0.6, AISLE + 1.6]);
    const pv = wallV + side * 0.95;
    m.pinnacle(stone, u, pv, AISLE + 0.8, AISLE + 2.6, 0.38, 3.2);
    if (flyTo == null) return;
    const span = Math.abs(flyTo - pv);
    if (span > 10) {
      // two flights over the double aisles, meeting on a pier pinnacle at the aisles' dividing arcade
      const mid = pv + (flyTo - pv) * 0.48;
      const roofY = AISLE + 0.4 + ((AISLE_TOP - AISLE - 0.4) * Math.abs(mid - (side < 0 ? -TW : TW))) / (TW - NV1);
      m.prism(stone, rect(u - 0.4, u + 0.4, mid - 0.4, mid + 0.4), roofY - 0.5, roofY + 3.2, null, { top: false });
      m.pinnacle(stone, u, mid, roofY + 3.2, roofY + 3.7, 0.42, 2.8);
      m.beam(stone, [u, AISLE + 2.0, pv], [u, roofY + 2.4, mid], 0.55, 0.7);
      m.beam(stone, [u, roofY + 2.6, mid], [u, 21.0, flyTo], 0.55, 0.7);
    } else {
      m.beam(stone, [u, AISLE + 2.0, pv], [u, 21.0, flyTo], 0.55, 0.7);
    }
  };
  for (const [u0, u1, v0, v1, side] of aisles) {
    const n = Math.round((u1 - u0) / 5.0), bw = (u1 - u0) / n;
    for (let k = 1; k < n; k++) buttress(u0 + k * bw, side < 0 ? v0 : v1, side, side < 0 ? NV0 - 0.1 : NV1 + 0.1);
  }
  for (const [u0, u1, v0, v1, side] of chancel) {
    const n = Math.round((u1 - u0) / 5.0), bw = (u1 - u0) / n;
    for (let k = 1; k < n; k++) {
      const u = u1 - k * bw;
      buttress(u, side < 0 ? v0 : v1, side, u > -37 ? (side < 0 ? NV0 - 0.1 : NV1 + 0.1) : null);
    }
  }

  // East corners: octagonal stair turrets rising over the chancel aisles
  for (const s of [-1, 1]) {
    const cu = -43.4, cv = s * 17.9;
    const ring = ngon(cu, cv, 1.9, 8, Math.PI / 8);
    m.prism(F, ring, P, 16.5, facadeStyle(WIN.lancet, T, { bay: 1.5, ground: 0, floor: 5.5 }), { top: false });
    m.cornice(stone, ring, 16.5, 0.25, 0.35);
    m.dome(stone, cu, cv, 16.85, [[2.0, 0], [2.0, 0.3], [0.1, 6.0]], 8, { phase: Math.PI / 8, smooth: false });
  }

  // West front: the aisle ends under gablets, octagonal stair turrets at the corners
  for (const [v0, v1] of [[-14.2, TOWER.v0], [TOWER.v1, 15.4]]) {
    const front = facadeStyle(WIN.lancet, T, { bay: 9, ground: 0, floor: 15.5 });
    m.box(F, 33.0, 35.5, P, 15.5, v0, v1, plain, { faces: [plain, front, plain, plain], top: false });
    m.pitched(stone, 32.8, 35.7, v0, v1, 15.5, 3.6, { axis: 'u' });
    m.pinnacle(stone, 35.4, (v0 + v1) / 2, 19.1, 19.6, 0.3, 1.8);
  }
  for (const cv of [-15.6, 16.4]) {
    const ring = ngon(32.6, cv, 2.2, 8, Math.PI / 8);
    m.prism(F, ring, P, 26, facadeStyle(WIN.lancet, T, { bay: 1.6, ground: 0, floor: 5.0 }), { top: false });
    m.cornice(stone, ring, 26, 0.25, 0.35);
    m.dome(stone, 32.6, cv, 26.35, [[2.3, 0], [2.3, 0.3], [0.12, 7.6]], 8, { phase: Math.PI / 8, smooth: false });
  }

  // The tower: the portal storey under a gablet, a great traceried window and the rose; the clock stage between the
  // corner buttresses' pinnacles; the belfry of paired lancets under gablets; the octagonal openwork spire with crockets
  // up its arrises to the cross at 75 m
  {
    const { u0, u1, v0, v1 } = TOWER;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const base = facadeStyle(WIN.lancet, T, { bay: u1 - u0, ground: 13, floor: 8.5 });
    const rose = facadeStyle(WIN.rose, T, { bay: 2.3, floor: 4.0, base: 21.5 });
    const upper = facadeStyle(WIN.lancet, T, { bay: 3.6, ground: 0, floor: 8.5, base: 21.5 });
    m.box(F, u0, u1, P, 21.5, v0, v1, base, { top: false });
    m.box(F, u0, u1, 21.5, BASE_TOP, v0, v1, upper, { faces: [upper, rose, upper, plain], top: false });
    m.prism(stone, offsetRing(rect(u0, u1, v0, v1), -0.15), 12.7, 13.1, null, { bottom: true, top: false });
    // the gablet over the portal, and a smaller one over the great window
    m.pitched(stone, u1 - 0.3, u1 + 0.6, cv - 3.0, cv + 3.0, 13.1, 4.6, { axis: 'u' });
    m.pinnacle(stone, u1 + 0.2, cv, 17.5, 18.0, 0.25, 1.6);
    m.cornice(stone, rect(u0, u1, v0, v1), BASE_TOP - 0.5, 0.45, 0.6);
    // the clock stage: blind tracery, a clock on each face, a gallery of openwork parapet at its foot
    const c = rect(u0 + 0.6, u1 - 0.6, v0 + 0.6, v1 - 0.6);
    m.prism(F, c, BASE_TOP, CLOCK_TOP, facadeStyle(WIN.lancet, T, { bay: 1.6, ground: 0, floor: 4.2, base: BASE_TOP }), { top: false });
    const g = offsetRing(rect(u0, u1, v0, v1), -0.1);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      m.balustrade(stone, T, [g[2 * k], g[2 * k + 1]], [g[2 * j], g[2 * j + 1]], BASE_TOP + 0.1, 0.9);
    }
    const cy = CLOCK_TOP - 1.7, cr = 1.05;
    for (const [nu, nv] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const pu = nu ? (nu > 0 ? u1 - 0.55 : u0 + 0.55) : cu, pv = nv ? (nv > 0 ? v1 - 0.55 : v0 + 0.55) : cv;
      const pts = [];
      for (let k = 0; k < 18; k++) {
        const a = (k * Math.PI * 2) / 18, h = cr * Math.cos(a);
        pts.push([pu + (nv ? h : 0), cy + cr * Math.sin(a), pv + (nu ? h : 0)]);
      }
      m.faceDir(materials.whiteIron, pts, [nu, 0, nv]);
    }
    m.cornice(stone, c, CLOCK_TOP, 0.4, 0.5);
    // the belfry: paired lancets, a gablet over each face, pinnacles at its corners
    const b = rect(u0 + 1.0, u1 - 1.0, v0 + 1.0, v1 - 1.0);
    const belfry = facadeStyle(WIN.lancet, T, { bay: (u1 - u0 - 2.0) / 2, ground: 0, floor: BELFRY_TOP - CLOCK_TOP - 0.5, base: CLOCK_TOP + 0.5 });
    m.prism(F, b, CLOCK_TOP + 0.5, BELFRY_TOP, belfry, { top: false });
    m.cornice(stone, b, BELFRY_TOP, 0.35, 0.4);
    const bu0 = u0 + 1.0, bu1 = u1 - 1.0, bv0 = v0 + 1.0, bv1 = v1 - 1.0, h = 3.4;
    m.pitched(stone, cu - 2.4, cu + 2.4, bv0 - 0.3, bv0 + 0.4, BELFRY_TOP - 1.2, h, { axis: 'v' });
    m.pitched(stone, cu - 2.4, cu + 2.4, bv1 - 0.4, bv1 + 0.3, BELFRY_TOP - 1.2, h, { axis: 'v' });
    m.pitched(stone, bu0 - 0.3, bu0 + 0.4, cv - 2.4, cv + 2.4, BELFRY_TOP - 1.2, h, { axis: 'u' });
    m.pitched(stone, bu1 - 0.4, bu1 + 0.3, cv - 2.4, cv + 2.4, BELFRY_TOP - 1.2, h, { axis: 'u' });
    for (const [pu, pv] of [[bu0, bv0], [bu1, bv0], [bu1, bv1], [bu0, bv1]]) {
      m.pinnacle(stone, pu, pv, CLOCK_TOP + 0.5, BELFRY_TOP + 1.2, 0.5, 3.8);
    }
    // stepped diagonal buttresses at the four corners, rising into the tall pinnacles beside the clock stage
    for (const [pu, pv] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
      const du = Math.sign(pu - cu), dv = Math.sign(pv - cv);
      const at = (d) => [pu + du * d, pv + dv * d];
      const [a1, b1] = at(0.55), [a2, b2] = at(0.4), [a3, b3] = at(0.3);
      // diamonds (ngon phase 0): faces square to the diagonal
      m.prism(stone, ngon(a1, b1, 1.6, 4), P, 15, null, { top: false });
      m.prism(stone, ngon(a2, b2, 1.25, 4), 15, 24, null, { top: false });
      m.prism(stone, ngon(a3, b3, 1.0, 4), 24, BASE_TOP + 1.5, null, { top: false });
      m.prism(stone, ngon(a3, b3, 0.8, 8, Math.PI / 8), BASE_TOP + 1.5, 41.0, facadeStyle(WIN.lancet, T, { bay: 0.6, ground: 0, floor: 3.2, base: BASE_TOP + 1.5 }), { top: false });
      m.cornice(stone, ngon(a3, b3, 0.8, 8, Math.PI / 8), 41.0, 0.2, 0.3);
      m.dome(stone, a3, b3, 41.3, [[0.85, 0], [0.85, 0.25], [0.06, 7.2]], 8, { phase: Math.PI / 8, smooth: false });
      cross(a3, b3, 48.4, 1.1);
    }
    // the spire, octagonal and pierced, with crockets on its arrises
    const spire = facadeStyle(WIN.lancet, T, { bay: 1.3, ground: 0, floor: 3.0, base: BELFRY_TOP + 0.4 });
    const r0 = 4.1, r1 = 0.22;
    m.loft(F, [ngon(cu, cv, r0, 8, Math.PI / 8), ngon(cu, cv, r1, 8, Math.PI / 8)], [BELFRY_TOP + 0.4, SPIRE_TOP], { st: spire });
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      for (let y = BELFRY_TOP + 2.2; y < SPIRE_TOP - 1.5; y += 2.0) {
        const r = r0 + ((r1 - r0) * (y - BELFRY_TOP - 0.4)) / (SPIRE_TOP - BELFRY_TOP - 0.4) + 0.15;
        m.prism(stone, ngon(cu + r * Math.cos(a), cv + r * Math.sin(a), 0.24, 4, a), y - 0.16, y + 0.16);
      }
    }
    m.dome(stone, cu, cv, SPIRE_TOP, [[0.24, 0], [0.5, 0.3], [0.45, 0.6], [0.15, 0.85], [0.05, 0.95]], 8);
    cross(cu, cv, SPIRE_TOP + 0.9, 1.7);
    // steps before the portal
    m.box(stone, u1, u1 + 2.4, P, 0.2, cv - 3.2, cv + 3.2, null);
    m.box(stone, u1, u1 + 1.4, P, 0.4, cv - 3.2, cv + 3.2, null);
  }

  return m.finish('Artzain Ona');
}
