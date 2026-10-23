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
const SPIRE_BASE = 45.0, SPIRE_TOP = 73.0;

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, TOWER_DIR, { front: [47.5, 1.0] });
  const m = new CivicModel(frame);
  const F = m.facade, stone = materials.sandstone, slate = materials.slate, iron = materials.iron;
  const P = frame.plinth;
  const T = TONE.sandstone;

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

  // The tower: the portal storey under a great window, a belfry of paired lancets, a gallery with corner pinnacles, and
  // the octagonal openwork spire with crockets up its arrises to the cross at 75 m
  {
    const { u0, u1, v0, v1 } = TOWER;
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
    const base = facadeStyle(WIN.lancet, T, { bay: u1 - u0, ground: 13, floor: 9 });
    const belfry = facadeStyle(WIN.lancet, T, { bay: 4.6, ground: 0, floor: 21, base: 22.1 });
    m.box(F, u0, u1, P, 22.1, v0, v1, base, { top: false });
    m.prism(stone, offsetRing(rect(u0, u1, v0, v1), -0.15), 12.7, 13.1, null, { bottom: true, top: false });
    m.cornice(stone, rect(u0, u1, v0, v1), 21.6, 0.4, 0.5);
    const b = rect(u0 + 0.5, u1 - 0.5, v0 + 0.5, v1 - 0.5);
    m.prism(F, b, 22.1, 43.5, belfry, { top: false });
    m.cornice(stone, b, 43.5, 0.6, 0.7);
    m.cap(stone, offsetRing(b, -0.6), 44.2, true);
    const g = offsetRing(b, -0.35);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      m.balustrade(stone, T, [g[2 * k], g[2 * k + 1]], [g[2 * j], g[2 * j + 1]], 44.2, 1.0);
      m.pinnacle(stone, b[2 * k], b[2 * k + 1], 44.2, 47.2, 0.42, 5.2);
    }
    // stepped diagonal buttresses at the four corners
    for (const [pu, pv] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1]]) {
      const du = Math.sign(pu - cu), dv = Math.sign(pv - cv);
      const at = (d) => [pu + du * d, pv + dv * d];
      const [a1, b1] = at(0.55), [a2, b2] = at(0.4), [a3, b3] = at(0.25);
      // diamonds (ngon phase 0): faces square to the diagonal
      m.prism(stone, ngon(a1, b1, 1.6, 4), P, 15, null, { top: false });
      m.prism(stone, ngon(a2, b2, 1.25, 4), 15, 29, null, { top: false });
      m.prism(stone, ngon(a3, b3, 0.95, 4), 29, 39.5, null, { top: false });
      m.pinnacle(stone, a3, b3, 39.5, 40.5, 0.5, 4.2);
    }
    // spire
    const spire = facadeStyle(WIN.lancet, T, { bay: 1.3, ground: 0, floor: 3.0, base: SPIRE_BASE });
    const r0 = 4.6, r1 = 0.22;
    m.loft(F, [ngon(cu, cv, r0, 8, Math.PI / 8), ngon(cu, cv, r1, 8, Math.PI / 8)], [SPIRE_BASE, SPIRE_TOP], { st: spire });
    for (let k = 0; k < 8; k++) {
      const a = Math.PI / 8 + (k * Math.PI) / 4;
      for (let y = SPIRE_BASE + 2.2; y < SPIRE_TOP - 1.5; y += 2.4) {
        const r = r0 + ((r1 - r0) * (y - SPIRE_BASE)) / (SPIRE_TOP - SPIRE_BASE) + 0.15;
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
