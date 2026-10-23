import { CivicModel, civicFrame, facadeStyle, WIN, TONE, rect, ngon, arc, offsetRing, ccwRing } from './udaletxea.js';

// js/donostia/landmarks/hotel-maria-cristina.js
// Hotel María Cristina (1912, Charles Mewès, the architect of the Paris and London Ritz): a Belle Époque hotel of the
// same golden sandstone as the Victoria Eugenia, on the Urumea, opened with the theatre across Okendo plaza. A U-shaped
// block of a tall rusticated ground floor of round-arched windows and five floors of French windows behind net
// curtains (stone balconies on the first floor, iron ones on the second, a continuous iron balcony along the top floor),
// a slate mansard with a row of dormers, a domed rotunda on the corner facing the theatre and the river, a raised
// pavilion over the centre of the river front and a round porch beside it (Wikimedia Commons photographs of the river
// and garden fronts). b5m measures 21 m to the eaves, 23 m on average and 28.9 m at the dome.
//
// build(sites, ctx) receives the GEO.landmarks entries ['hotel-maria-cristina'] (footprint ring, at [x, z], buildings,
// height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates; the plain extrusions of the hotel's 1:500 buildings are hidden.

// Frame (from the OSM outline): +u runs north-north-west to Okendo street (towards the theatre), +v east-north-east to
// the river; the U's courtyard opens to -v
const RIVER_DIR = [-0.472, -0.882];

// The OSM outline without the two porches (modelled on their own) and with the slight kink of the south-south-east
// wall straightened, so the mansard's insets stay valid
const RING = [36.6, 23.9, 33.4, 28.0, -36.6, 27.8, -35.8, -29.8, -14.6, -29.4, -14.4, -4.6, -11.6, -0.9, 3.5, -0.7,
  6.8, -4.0, 7.3, -29.8, 36.3, -29.4];
const EAVE = 21.0, ROOF = 21.6;
const ROTUNDA = { u: 32.3, v: 23.6, r: 5.0 };

// Straight walls of the outline, for balconies & dormers: [a, b] in the frame, outward normal (wound like the ring)
function walls(ring) {
  const r = ccwRing(ring), n = r.length / 2, out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = [r[2 * i], r[2 * i + 1]], b = [r[2 * j], r[2 * j + 1]];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > 1e-6) out.push({ a, b, l, n: [(b[1] - a[1]) / l, -(b[0] - a[0]) / l] });
  }
  return out;
}

// Point t metres along wall w, pushed `off` metres out
const along = (w, t, off = 0) => [0, 1].map((k) => w.a[k] + ((w.b[k] - w.a[k]) * t) / w.l + w.n[k] * off);

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { materials } = ctx.kit;
  const frame = civicFrame(ctx, site, RIVER_DIR, { front: [0, 31.0] });
  const T = TONE.honey;
  const m = new CivicModel(frame, { tone: T });
  // stone trim (cornices, string courses, balconies) in the facade's own stone
  const F = m.facade, trim = F, slate = materials.slate, zinc = materials.zinc, iron = materials.iron;
  const P = frame.plinth;

  // Ground floor 5 m (lobby & salons) of round-arched windows, five floors of 3.2 m with French windows
  const rooms = facadeStyle(WIN.hotel, T, { bay: 3.4, ground: 5.0, floor: 3.2 });
  const plain = facadeStyle(WIN.plain, T);
  const arcade = facadeStyle(WIN.arcade, T, { bay: 2.6, ground: 4.6, floor: 4 });

  m.prism(F, RING, P, EAVE, rooms, { top: false });
  m.cornice(trim, RING, EAVE, 0.6, 0.6);
  m.prism(trim, offsetRing(RING, -0.12), 4.85, 5.15, null, { bottom: true, top: false });
  m.mansard(slate, RING, ROOF, 4.0, 1.5, { rise2: 0.9, inset2: 2.5 });
  const crown = offsetRing(RING, 4.0);
  if (crown) {
    m.chimneys(trim, crown, ROOF + 4.9, {
      spacing: 9, inset: 1.2,
      keep: (u, v) => Math.hypot(u - ROTUNDA.u, v - ROTUNDA.v) > ROTUNDA.r + 2 && !(Math.abs(u) < 8 && v > 18)
    });
  }

  // Dormers and balconies along the outer walls (the river front, the Okendo and south-south-east ends, and the ends of
  // the courtyard's arms), clear of the rotunda and the central pavilion
  const clear = (p) => Math.hypot(p[0] - ROTUNDA.u, p[1] - ROTUNDA.v) > ROTUNDA.r + 1.2 && !(Math.abs(p[0]) < 7.6 && p[1] > 20);
  for (const w of walls(RING)) {
    const river = w.n[1] > 0.9, ends = Math.abs(w.n[0]) > 0.9 && Math.abs(w.a[0]) > 30;
    const arms = w.n[1] < -0.9 && Math.abs(w.a[1]) > 25;
    if (w.l < 20 || !(river || ends || arms)) continue;
    // dormers in line with the window bays
    const bays = Math.max(1, Math.round(w.l / 3.4)), bw = w.l / bays;
    const dir = Math.abs(w.n[0]) > Math.abs(w.n[1]) ? (w.n[0] > 0 ? '+u' : '-u') : (w.n[1] > 0 ? '+v' : '-v');
    for (let k = 0; k < bays; k++) {
      const p = along(w, (k + 0.5) * bw, 0.05);
      if (k === 0 || k === bays - 1 || !clear(p)) continue;
      m.dormer(slate, T, p[0], p[1], dir, ROOF + 0.3, { w: 1.5, h: 2.4, depth: 1.7 });
    }
    // the street fronts (not the courtyard ends): a stone balcony with balusters at every first-floor window and an
    // iron one at every second-floor window, a continuous iron balcony along the top floor
    if (w.n[1] < -0.9) continue;
    for (let k = 0; k < bays; k++) {
      const t = (k + 0.5) * bw;
      if (k === 0 || k === bays - 1 || !clear(along(w, t, 0.5))) continue;
      m.wall(trim, along(w, t - 1.0, 0.33), along(w, t + 1.0, 0.33), 0.66, 4.95, 5.22);
      m.balustrade(trim, T, along(w, t - 1.0, 0.6), along(w, t + 1.0, 0.6), 5.22, 0.9);
      m.wall(trim, along(w, t - 0.85, 0.25), along(w, t + 0.85, 0.25), 0.5, 8.24, 8.42);
      m.railing(iron, along(w, t - 0.85, 0.47), along(w, t + 0.85, 0.47), 8.42, 0.95, 0.42);
    }
    for (const y of [17.86]) {
      let t0 = null;
      const flush = (t1) => {
        if (t0 == null || t1 - t0 < 3) return;
        const a = along(w, t0, 0.45), b = along(w, t1, 0.45);
        m.wall(trim, a, b, 0.9, y - 0.22, y);
        m.railing(iron, along(w, t0, 0.86), along(w, t1, 0.86), y, 1.0, 0.55);
      };
      for (let t = 0.6; t <= w.l - 0.6; t += 0.5) {
        const ok = clear(along(w, t, 0.5));
        if (ok && t0 == null) t0 = t;
        if (!ok && t0 != null) { flush(t - 0.5); t0 = null; }
      }
      flush(w.l - 0.6);
    }
  }

  // Corner rotunda facing the theatre and the river: windows all round, a slate dome and a lantern
  {
    const { u, v, r } = ROTUNDA;
    const ring = ngon(u, v, r, 20);
    const round = facadeStyle(WIN.hotel, T, { bay: 3.0, ground: 5.0, floor: 3.2 });
    m.prism(F, ring, P, EAVE, round, { top: false, smooth: true, continuous: true });
    m.cornice(trim, ring, EAVE, 0.6, 0.66);
    m.prism(trim, offsetRing(ring, -0.12), 4.9, 5.2, null, { bottom: true, top: false });
    // the photographs show the dome standing well clear of the mansard's crest (b5m's maximum stops at the crest): a
    // steep slate drum with dormers, then the ribbed dome and its lantern
    const D = 2.9; // drum height
    m.dome(slate, u, v, ROOF, [[r + 0.25, 0], [r + 0.05, 1.2], [r * 0.9, D]], 20);
    m.dome(slate, u, v, ROOF + D, [[r * 0.9, 0], [r * 0.88, 0.8], [r * 0.78, 2.2], [r * 0.6, 3.5], [r * 0.38, 4.4], [r * 0.16, 4.9],
      [0.6, 5.0]], 20, { smooth: false });
    m.prism(zinc, ngon(u, v, 0.6, 10), ROOF + D + 5.0, ROOF + D + 6.0, null, { top: false });
    m.dome(zinc, u, v, ROOF + D + 6.0, [[0.8, 0], [0.8, 0.15], [0.05, 1.1]], 10);
    // dormers in the drum over the two street fronts
    m.dormer(slate, T, u + r + 0.2, v, '+u', ROOF + 0.4, { w: 1.2, h: 1.8, depth: 1.6 });
    m.dormer(slate, T, u, v + r + 0.2, '+v', ROOF + 0.4, { w: 1.2, h: 1.8, depth: 1.6 });
  }

  // Central pavilion of the river front: slightly proud, under a taller roof with three dormers
  {
    const v1 = 28.7;
    m.box(F, -6.5, 6.5, P, EAVE, 26.5, v1, rooms, { faces: [plain, plain, rooms, plain], top: false });
    m.cornice(trim, rect(-6.5, 6.5, 26.5, v1), EAVE, 0.6, 0.7);
    m.prism(trim, offsetRing(rect(-6.5, 6.5, 26.5, v1), -0.12), 4.8, 5.1, null, { bottom: true, top: false });
    const roof = [rect(-6.65, 6.65, 20.5, v1 + 0.15), rect(-5.5, 5.5, 21.7, v1 - 1.1), rect(-4.0, 4.0, 23.2, v1 - 2.6)];
    m.loft(slate, roof, [ROOF, ROOF + 4.6, ROOF + 6.2]);
    for (const u of [-3.4, 0, 3.4]) m.dormer(slate, T, u, v1 + 0.15, '+v', ROOF + 0.3, { w: 1.6, h: 2.6, depth: 1.8 });
    m.railing(iron, [-4.0, 23.2], [4.0, 23.2], ROOF + 6.2, 0.5, 0.5);
    m.railing(iron, [-4.0, v1 - 2.6], [4.0, v1 - 2.6], ROOF + 6.2, 0.5, 0.5);
  }

  // Round porch on the river front, arcaded, with a balustraded terrace on top
  {
    const cu = -15.1, cv = 27.5, r = 3.8;
    const ring = arc(cu, cv, r, 0, Math.PI, 8);
    m.prism(F, ring, P, 4.6, arcade, { continuous: true, smooth: true });
    m.cornice(trim, ring, 4.6, 0.35, 0.45);
    const top = arc(cu, cv, r + 0.15, 0, Math.PI, 8);
    for (let k = 0; k < 8; k++) {
      m.balustrade(trim, T, [top[2 * k], top[2 * k + 1]], [top[2 * k + 2], top[2 * k + 3]], 5.05, 0.95);
    }
  }

  // Winter-garden porch in the courtyard, glass-roofed
  m.box(F, -8.8, 1.9, P, 5.0, -6.0, -0.5, facadeStyle(WIN.arcade, T, { bay: 3.0, ground: 5.0, floor: 4 }), { top: false });
  m.box(materials.glass, -9.0, 2.1, 5.0, 5.25, -6.2, -0.5, null, { bottom: true });

  return m.finish('Hotel María Cristina');
}
