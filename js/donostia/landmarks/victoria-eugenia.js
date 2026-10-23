import { CivicModel, civicFrame, facadeStyle, WIN, TONE, rect, ngon, offsetRing } from './udaletxea.js';

// js/donostia/landmarks/victoria-eugenia.js
// Teatro Victoria Eugenia (1912, Francisco de Urcola): Belle Époque theatre of golden sandstone with a neo-Plateresque
// front on the Paseo de la República Argentina, facing the Urumea and the Kursaal, twin of the Hotel María Cristina
// beside it. b5m measures the block at 16.7 m to the eaves and 23.3 m at its highest.
//
// From the photographs (Wikimedia Commons: the river front, the Okendo plaza side, the stage-house back): the river
// front is symmetrical. Two square corner towers carry, over the main cornice, an open belvedere of three round arches
// a side under a balustrade bristling with pinnacles (no domes). Between them the centre opens three great arched
// windows over the foyer balcony, framed by paired columns, over three arched doors under a glass canopy; an entablature
// lettered TEATRO VICTORIA EUGENIA, an attic of six small arched windows round the city's arms and statues, and a small
// pediment crown it. Behind rises the auditorium's low-pitched roof, its front gable rendered cream with a glazed
// lantern on the ridge, and at the back the stage house's tall cream gable. The long sides are four storeys of square-
// headed windows (a rusticated ground floor of shop windows, pedimented windows on the main floor, small attic windows
// in the frieze) under a cornice and a balustrade, with a centrepiece of arched windows under a pediment; the roofs
// behind the balustrades are low and grey.
//
// build(sites, ctx) receives the GEO.landmarks entries ['victoria-eugenia'] (footprint ring, at [x, z], buildings,
// height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates; the plain extrusions of the block's 1:500 buildings are hidden.

// Frame (from the OSM outline): +u runs east-north-east to the river front, +v south-south-east to Okendo plaza
const FRONT_DIR = [0.883, -0.469];

// Heights above the river front's pavement (m), scaled from the frontal photograph onto b5m's 23.3 m maximum
const EAVE = 16.2, CORNICE = 16.8; // main cornice of the sides & the towers
const BALCONY = 5.5; // foyer balcony
const ENTABLATURE = 12.3, ATTIC = 13.6; // over the foyer windows; the attic storey up to the cornice
const BELV0 = 17.4, BELV_SPRING = 19.3, BELV1 = 21.1; // the towers' belvederes
const GABLE = 22.4; // the auditorium roof's ridge

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, FRONT_DIR, { front: [32.5, 0] });
  const T = TONE.golden;
  const m = new CivicModel(frame, { tone: T });
  const F = m.facade, zinc = materials.zinc, iron = materials.iron, glass = materials.glass;
  const P = frame.plinth;
  const U0 = -28.5, U1 = 28.5, V0 = -20.6, V1 = 20.6;

  const plain = facadeStyle(WIN.plain, T);
  const render = facadeStyle(WIN.plain, TONE.cream); // the rendered gables
  // the long sides & the back: ground floor 5.6 m of shop windows, then 3.6 m storeys of square-headed windows
  const side = facadeStyle(WIN.square, T, { bay: 3.9, ground: 5.6, floor: 3.6 });

  // --- the main block, its cornice and the balustrade round its roof ---------------------------------------------------
  const TU = U1 - 7.6; // the towers' back walls
  m.box(F, U0, TU, P, EAVE, V0, V1, side, { faces: [side, plain, side, side], top: false });
  m.box(F, TU, U1 - 0.6, P, EAVE, V0 + 7.0, V1 - 7.0, plain, { top: false });
  m.prism(F, offsetRing(rect(U0, TU, V0, V1), -0.12), 5.45, 5.75, null, { bottom: true, top: false });
  m.cornice(F, rect(U0, TU, V0, V1), EAVE, 0.6, CORNICE - EAVE);
  for (const [a, b] of [[[U0, V0 - 0.3], [TU, V0 - 0.3]], [[U0, V1 + 0.3], [TU, V1 + 0.3]], [[U0 - 0.3, V0], [U0 - 0.3, V1]]]) {
    m.balustrade(F, T, a, b, CORNICE, 1.0);
  }
  // pinnacled posts along the balustrades
  for (let u = U0 + 4; u < TU - 2; u += 7.8) {
    for (const v of [V0 - 0.3, V1 + 0.3]) m.pinnacle(F, u, v, CORNICE, CORNICE + 1.3, 0.28, 1.4);
  }
  // low grey roofs behind the balustrades
  m.pitched(zinc, U0 + 0.4, U1 - 1.0, V0 + 0.4, V1 - 0.4, CORNICE - 0.2, 2.0, { axis: 'u', hip: true });

  // --- centrepieces of the long sides: arched windows on the main floor, a pediment over the cornice -------------------
  const sideCentre = facadeStyle(WIN.civic, T, { bay: 3.9, ground: 5.6, floor: 3.6 });
  for (const [v, s] of [[V0, -1], [V1, 1]]) {
    const v0 = s < 0 ? v - 0.45 : v - 0.1, v1 = s < 0 ? v + 0.1 : v + 0.45;
    const faces = s < 0 ? [sideCentre, plain, plain, plain] : [plain, plain, sideCentre, plain];
    m.box(F, -6.0, 5.7, P, EAVE + 0.3, v0, v1, plain, { faces, top: false });
    m.pitched(F, -6.4, 6.1, s < 0 ? v - 1.6 : v - 0.1, s < 0 ? v + 0.1 : v + 1.6, CORNICE, 2.2, { axis: 'v', endStyle: plain });
  }
  // and of the back, before the stage house
  m.pitched(F, U0 - 1.6, U0 + 0.1, -5.8, 5.8, CORNICE, 2.0, { axis: 'u', endStyle: plain });

  // --- the auditorium roof, its cream front gable and lantern; the stage house behind -------------------------------
  {
    const a0 = -12.0, a1 = TU - 0.5, w = 11.5;
    m.pitched(zinc, a0, a1, -w - 0.3, w + 0.3, CORNICE + 0.2, GABLE - CORNICE - 0.2, { axis: 'u', endMat: F, endStyle: render });
    // the lantern on the ridge, near the front
    const lu = a1 - 4.5, ly = GABLE - 1.2;
    m.box(glass, lu - 1.6, lu + 1.6, ly, ly + 1.3, -1.4, 1.4, null);
    m.box(zinc, lu - 1.8, lu + 1.8, ly + 1.3, ly + 1.45, -1.6, 1.6, null);
    m.pitched(zinc, lu - 1.8, lu + 1.8, -1.6, 1.6, ly + 1.45, 0.9, { axis: 'u', hip: true });
    m.beam(iron, [lu, ly + 2.3, 0], [lu, ly + 3.1, 0], 0.08, 0.08);
    // the stage house: a cream-rendered box over the back with its tall gable to the back street
    const s0 = U0 + 1.6, s1 = a0;
    m.box(F, s0, s1, CORNICE - 0.5, 20.4, -w, w, render, { top: false });
    m.cornice(F, rect(s0, s1, -w, w), 20.4, 0.35, 0.4);
    m.pitched(zinc, s0 - 0.2, s1 + 0.2, -w - 0.2, w + 0.2, 20.8, 23.3 - 20.8, { axis: 'u', endMat: F, endStyle: render });
  }

  // --- the river front's centre ---------------------------------------------------------------------------------------
  {
    const c0 = -8.2, c1 = 8.2, u1 = U1 + 0.6;
    // ground storey of three arched doors and the three great foyer windows over the balcony (one 5.5 m bay each)
    const centre = facadeStyle(WIN.arcade, T, { bay: (c1 - c0) / 3, ground: BALCONY, floor: 7.2 });
    m.box(F, U1 - 0.6, u1, P, ATTIC, c0, c1, plain, { faces: [plain, centre, plain, plain], top: false });
    m.prism(F, offsetRing(rect(U1 - 0.6, u1, c0, c1), -0.15), BALCONY - 0.35, BALCONY, null, { bottom: true, top: false });
    // the balcony slab and its balustrade
    m.box(F, u1, u1 + 0.9, BALCONY - 0.3, BALCONY, c0 - 0.3, c1 + 0.3, null, { bottom: true });
    m.balustrade(F, T, [u1 + 0.8, c0 - 0.3], [u1 + 0.8, c1 + 0.3], BALCONY, 1.0);
    // paired columns between and beside the windows, on pedestals, carrying the entablature
    const bw = (c1 - c0) / 3;
    for (let k = 0; k <= 3; k++) {
      const v = c0 + k * bw;
      for (const dv of [-0.42, 0.42]) {
        const cv = v + (k === 0 ? 0.42 : k === 3 ? -0.42 : 0) + dv * (k === 0 || k === 3 ? 0.9 : 1);
        m.box(F, u1 + 0.05, u1 + 0.75, BALCONY, BALCONY + 1.0, cv - 0.35, cv + 0.35, null);
        m.prism(F, ngon(u1 + 0.4, cv, 0.27, 10), BALCONY + 1.0, ENTABLATURE - 0.4, null, { top: false, smooth: true });
        m.box(F, u1 + 0.05, u1 + 0.75, ENTABLATURE - 0.4, ENTABLATURE, cv - 0.38, cv + 0.38, null);
      }
    }
    // entablature (the lettered frieze) and its cornice, then the attic: six small arched windows round the arms
    m.box(F, U1 - 0.6, u1 + 0.8, ENTABLATURE, ATTIC, c0 - 0.4, c1 + 0.4, null, { bottom: true });
    m.cornice(F, rect(U1 - 0.6, u1 + 0.8, c0 - 0.4, c1 + 0.4), ATTIC - 0.4, 0.35, 0.4);
    const attic = facadeStyle(WIN.arcade, T, { bay: 1.85, ground: 0, floor: 2.6, base: ATTIC });
    for (const [v0, v1] of [[c0, -2.6], [2.6, c1]]) {
      m.box(F, U1 - 0.6, u1, ATTIC, CORNICE, v0, v1, plain, { faces: [plain, attic, plain, plain], top: false });
    }
    m.box(F, U1 - 0.6, u1, ATTIC, CORNICE, -2.6, 2.6, plain, { top: false });
    // the city's arms in a carved frame, and the four statues on pedestals either side of the attic windows
    m.box(F, u1, u1 + 0.35, ATTIC + 0.3, CORNICE - 0.2, -1.8, 1.8, null);
    m.dome(F, u1 + 0.5, 0, ATTIC + 1.0, [[0.9, 0], [1.0, 0.8], [0.7, 1.6], [0.1, 2.0]], 10);
    for (const v of [c0 - 0.1, -2.95, 2.95, c1 + 0.1]) {
      m.box(F, u1 + 0.1, u1 + 0.9, ATTIC, ATTIC + 0.5, v - 0.45, v + 0.45, null);
      m.dome(F, u1 + 0.5, v, ATTIC + 0.5, [[0.36, 0], [0.4, 0.6], [0.3, 1.3], [0.2, 1.55], [0.22, 1.7], [0.02, 2.05]], 8);
    }
    m.cornice(F, rect(U1 - 0.6, u1, c0, c1), CORNICE, 0.55, 0.6);
    // the pediment over the arms, with acroteria
    m.pitched(F, U1 - 1.4, u1 + 0.3, -3.8, 3.8, CORNICE + 0.6, 2.6, { axis: 'u', endStyle: plain });
    for (const [v, y] of [[0, CORNICE + 3.2], [-3.6, CORNICE + 0.6], [3.6, CORNICE + 0.6]]) {
      m.dome(F, u1 + 0.1, v, y, [[0.3, 0], [0.35, 0.3], [0.12, 0.8], [0.02, 1.0]], 8);
    }
    // the glass canopy over the three doors
    m.box(glass, u1, u1 + 2.8, 4.2, 4.32, -7.2, 7.2, null, { bottom: true });
    m.box(iron, u1 + 2.7, u1 + 2.9, 4.05, 4.45, -7.2, 7.2, null, { bottom: true });
  }

  // --- between the centre and the towers: tall bays with a ground-floor window, the balcony & the balustrade --------
  const bay = facadeStyle(WIN.square, T, { bay: 4.0, ground: BALCONY, floor: 11.5 });
  for (const [v0, v1] of [[V0 + 6.6, -8.2], [8.2, V1 - 6.6]]) {
    m.box(F, U1 - 0.7, U1 + 0.1, P, EAVE, v0, v1, plain, { faces: [plain, bay, plain, plain], top: false });
    m.box(F, U1 + 0.1, U1 + 0.7, BALCONY - 0.3, BALCONY, v0, v1, null, { bottom: true });
    m.balustrade(F, T, [U1 + 0.6, v0], [U1 + 0.6, v1], BALCONY, 1.0);
    m.cornice(F, rect(U1 - 0.7, U1 + 0.1, v0, v1), EAVE, 0.5, CORNICE - EAVE);
    m.balustrade(F, T, [U1 + 0.2, v0], [U1 + 0.2, v1], CORNICE, 1.0);
    // a carved cartouche high on the wall
    m.box(F, U1 + 0.1, U1 + 0.4, 9.5, 12.5, (v0 + v1) / 2 - 1.1, (v0 + v1) / 2 + 1.1, null);
  }

  // --- the corner towers, with their open belvederes ------------------------------------------------------------------
  const towerFront = facadeStyle(WIN.square, T, { bay: 7.1, ground: BALCONY, floor: 11.5 });
  const towerSide = facadeStyle(WIN.square, T, { bay: 3.9, ground: 5.6, floor: 3.6 });
  for (const [v0, v1, s] of [[V0 - 0.4, V0 + 6.7, -1], [V1 - 6.7, V1 + 0.4, 1]]) {
    const u0 = TU, u1 = U1 + 0.8, cv = (v0 + v1) / 2;
    const faces = s < 0 ? [towerSide, towerFront, plain, towerSide] : [plain, towerFront, towerSide, towerSide];
    m.box(F, u0, u1, P, EAVE, v0, v1, plain, { faces, top: false });
    m.prism(F, offsetRing(rect(u0, u1, v0, v1), -0.12), 5.45, 5.75, null, { bottom: true, top: false });
    m.cornice(F, rect(u0, u1, v0, v1), EAVE, 0.65, CORNICE - EAVE);
    // the medallion on the tower's front
    m.box(F, u1, u1 + 0.3, 10.0, 12.6, cv - 1.0, cv + 1.0, null);
    // the belvedere: three open arches a side on a plinth, a cornice, a balustrade and its pinnacles
    const b = 0.45, bu0 = u0 + b, bu1 = u1 - b, bv0 = v0 + b, bv1 = v1 - b;
    m.box(F, bu0, bu1, CORNICE, BELV0, bv0, bv1, null);
    const d = 0.55;
    m.openArcade(F, [bu0, bv0 + d / 2], [bu1, bv0 + d / 2], BELV0, BELV_SPRING, BELV1, 3, { depth: d, pier: 0.62 });
    m.openArcade(F, [bu0, bv1 - d / 2], [bu1, bv1 - d / 2], BELV0, BELV_SPRING, BELV1, 3, { depth: d, pier: 0.62 });
    m.openArcade(F, [bu0 + d / 2, bv0 + d], [bu0 + d / 2, bv1 - d], BELV0, BELV_SPRING, BELV1, 3, { depth: d, pier: 0.5 });
    m.openArcade(F, [bu1 - d / 2, bv0 + d], [bu1 - d / 2, bv1 - d], BELV0, BELV_SPRING, BELV1, 3, { depth: d, pier: 0.5 });
    m.cornice(F, rect(bu0, bu1, bv0, bv1), BELV1, 0.5, 0.55);
    m.box(zinc, bu0 + d, bu1 - d, BELV1 - 0.1, BELV1 + 0.4, bv0 + d, bv1 - d, null);
    const top = BELV1 + 0.55, g = offsetRing(rect(bu0, bu1, bv0, bv1), -0.3);
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      const a = [g[2 * k], g[2 * k + 1]], c = [g[2 * j], g[2 * j + 1]];
      m.balustrade(F, T, a, c, top, 0.75);
      // pinnacles on the corners and two along each side
      for (const t of [0, 1 / 3, 2 / 3]) m.pinnacle(F, a[0] + (c[0] - a[0]) * t, a[1] + (c[1] - a[1]) * t, top, top + 0.9, 0.2, 1.3);
    }
  }

  return m.finish('Victoria Eugenia');
}
