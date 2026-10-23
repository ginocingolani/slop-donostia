import { CivicModel, civicFrame, facadeStyle, WIN, TONE, rect, ngon, offsetRing } from './udaletxea.js';

// js/donostia/landmarks/victoria-eugenia.js
// Teatro Victoria Eugenia (1912, Francisco de Urcola): Belle Époque theatre with a neo-Plateresque stone front on the
// Paseo de la República Argentina, facing the Urumea and the Kursaal, twin of the Hotel María Cristina beside it. The
// front has a three-arched entrance under a loggia of tall round-arched foyer windows and a sculpted pediment, between
// corner towers capped by small slate cupolas; mansard roofs with oculus dormers run back over the auditorium to the
// stage house. The block (one OSM outline) also takes in the houses along Erregina Erregeordea and Okendo plaza. b5m
// measures the theatre at 18.9 m on average and 26.7 m at the cupolas.
//
// build(sites, ctx) receives the GEO.landmarks entries ['victoria-eugenia'] (footprint ring, at [x, z], buildings,
// height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates; the plain extrusions of the block's 1:500 buildings are hidden.

// Frame (from the OSM outline): +u runs east-north-east to the river front, +v south-south-east to Okendo plaza
const FRONT_DIR = [0.883, -0.469];

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, FRONT_DIR, { front: [32.5, 0] });
  const m = new CivicModel(frame);
  const F = m.facade, trim = materials.limestone, slate = materials.slate, zinc = materials.zinc, iron = materials.iron;
  const P = frame.plinth;
  const T = TONE.ochre;
  const U0 = -28.5, U1 = 28.5, V0 = -20.6, V1 = 20.6, EAVE = 17.0;

  // Ground floor 5.2 m, three upper floors of 3.9 m; the river front has one tall foyer storey of round arches instead
  const side = facadeStyle(WIN.civic, T, { bay: 3.6, ground: 5.2, floor: 3.9 });
  const front = facadeStyle(WIN.arcade, T, { bay: 4.1, ground: 5.6, floor: 6.4 });
  const plain = facadeStyle(WIN.plain, T);

  m.box(F, U0, U1, P, EAVE, V0, V1, side, { faces: [side, plain, side, side], top: false });
  m.cornice(trim, rect(U0, U1, V0, V1), EAVE, 0.6, 0.65);
  // the front between the towers and the centre, one great arch each side (its own walls, so the bays fit)
  for (const [v0, v1] of [[V0 + 6.1, -9.0], [9.0, V1 - 6.1]]) {
    m.box(F, U1 - 0.5, U1 + 0.15, P, EAVE, v0, v1, plain, { faces: [plain, front, plain, plain], top: false });
  }
  m.prism(trim, offsetRing(rect(U0, U1, V0, V1), -0.12), 5.2, 5.5, null, { bottom: true, top: false });

  // Mansard over the whole block with oculus dormers on the long sides and the back
  const roofY = EAVE + 0.65;
  m.mansard(slate, rect(U0, U1, V0, V1), roofY, 3.2, 1.4);
  m.chimneys(trim, offsetRing(rect(U0, U1, V0, V1), 1.4), roofY + 3.2, {
    spacing: 8, inset: 1.0, keep: (u, v) => u < 19 && Math.abs(v) > 12
  });
  for (const [v, dir] of [[V0 - 0.05, '-v'], [V1 + 0.05, '+v']]) {
    for (let u = U0 + 3.0; u < 20; u += 3.6) m.dormer(slate, T, u, v, dir, roofY + 0.3, { w: 1.3, h: 1.9, depth: 1.5 });
  }
  for (let v = V0 + 3.2; v < V1 - 2.5; v += 3.6) {
    m.dormer(slate, T, U0 - 0.05, v, '-u', roofY + 0.3, { w: 1.3, h: 1.9, depth: 1.5 });
  }

  // Auditorium roof rising over the mansard, and the stage house at the back
  m.pitched(slate, -13.5, 15.5, -11.0, 11.0, roofY + 3.2, 3.6, { axis: 'u', hip: true });
  m.box(F, -26.8, -14.0, roofY + 1.0, 24.0, -10.5, 10.5, plain, { top: false });
  m.cornice(trim, rect(-26.8, -14.0, -10.5, 10.5), 24.0, 0.35, 0.4);
  m.pitched(slate, -27.0, -13.8, -10.7, 10.7, 24.4, 2.3, { axis: 'v', endMat: F, endStyle: plain });

  // River front: a projecting centre with the entrance arcade, a balcony on the foyer floor, an attic & pediment
  {
    const u1 = U1 + 0.6, c0 = -9.0, c1 = 9.0;
    m.box(F, U1 - 0.5, u1, P, EAVE + 0.4, c0, c1, front, { faces: [plain, front, plain, plain], top: false });
    m.cornice(trim, rect(U1 - 0.5, u1, c0, c1), EAVE + 0.4, 0.6, 0.65);
    m.box(trim, u1, u1 + 1.2, 5.45, 5.75, c0 - 1.0, c1 + 1.0, null, { bottom: true });
    m.railing(iron, [u1 + 1.15, c0 - 1.0], [u1 + 1.15, c1 + 1.0], 5.75, 1.0, 0.35);
    // giant pilasters between the foyer arches, an entablature over them and stained-glass oculi in the attic storey
    const bw = (c1 - c0) / Math.max(1, Math.round((c1 - c0) / 4.1));
    for (let v = c0; v <= c1 + 0.01; v += bw) m.box(trim, u1, u1 + 0.28, 5.75, 12.3, v - 0.3, v + 0.3, null);
    m.box(trim, u1, u1 + 0.35, 12.3, 12.9, c0 - 0.2, c1 + 0.2, null, { bottom: true });
    for (let v = c0 + bw / 2; v < c1; v += bw) {
      const oculus = facadeStyle(WIN.rose, T, { bay: 1.25, floor: 2.0, base: 12.9 });
      m.box(F, u1, u1 + 0.12, 12.9, 16.9, v - 1.5, v + 1.5, plain, { faces: [plain, oculus, plain, plain] });
    }
    // attic with a balustrade either side of the pediment
    m.box(F, U1 - 1.2, u1 - 0.2, EAVE + 1.05, EAVE + 3.4, -6.0, 6.0, plain, { top: false });
    m.cornice(trim, rect(U1 - 1.2, u1 - 0.2, -6.0, 6.0), EAVE + 3.4, 0.4, 0.45);
    m.pitched(trim, U1 - 1.6, u1 + 0.2, -6.4, 6.4, EAVE + 3.85, 2.4, { axis: 'u' });
    m.dome(zinc, u1 - 0.4, 0, EAVE + 6.2, [[0.45, 0], [0.7, 0.6], [0.35, 1.4], [0.04, 2.2]], 8);
    m.balustrade(trim, T, [u1 + 0.1, c0], [u1 + 0.1, -6.0], EAVE + 1.05);
    m.balustrade(trim, T, [u1 + 0.1, 6.0], [u1 + 0.1, c1], EAVE + 1.05);
    // glazed entrance canopy over the three arches
    m.box(materials.glass, u1, u1 + 2.6, 4.6, 4.75, -6.5, 6.5, null, { bottom: true });
    m.box(iron, u1 + 2.5, u1 + 2.7, 4.45, 4.85, -6.5, 6.5, null, { bottom: true });
  }

  // Corner towers on the river front, a storey above the eaves, under slate cupolas with lanterns
  const towerStyle = facadeStyle(WIN.civic, T, { bay: 3.2, ground: 5.2, floor: 3.9 });
  for (const [v0, v1] of [[V0 - 0.4, V0 + 6.1], [V1 - 6.1, V1 + 0.4]]) {
    const u0 = U1 - 6.1, u1 = U1 + 0.4, cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, a = (u1 - u0) / 2;
    m.box(F, u0, u1, P, 21.2, v0, v1, towerStyle, { top: false });
    m.cornice(trim, rect(u0, u1, v0, v1), EAVE, 0.65, 0.7);
    m.cornice(trim, rect(u0, u1, v0, v1), 21.2, 0.45, 0.55);
    m.prism(trim, offsetRing(rect(u0, u1, v0, v1), -0.12), 5.2, 5.5, null, { bottom: true, top: false });
    const ring = ngon(cu, cv, a * 1.05, 8, Math.PI / 8);
    m.prism(F, ring, 21.75, 22.6, plain, { top: false });
    const cupola = [[a * 1.08, 0], [a * 1.0, 0.7], [a * 0.82, 1.5], [a * 0.52, 2.3], [a * 0.2, 2.75], [0.45, 2.85]];
    m.dome(slate, cu, cv, 22.6, cupola, 8, { phase: Math.PI / 8 });
    m.prism(zinc, ngon(cu, cv, 0.45, 8, Math.PI / 8), 25.45, 26.2, null, { top: false });
    m.dome(zinc, cu, cv, 26.2, [[0.6, 0], [0.6, 0.12], [0.04, 0.8]], 8, { phase: Math.PI / 8 });
  }

  return m.finish('Victoria Eugenia');
}
