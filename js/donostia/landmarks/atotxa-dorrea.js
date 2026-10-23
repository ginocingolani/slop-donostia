import { CentreModel, style, FK, FT, rect } from './bretxa.js';

// js/donostia/landmarks/atotxa-dorrea.js
// Torre de Atotxa (Atotxako dorrea, Paseo Duque de Mandas 30/30A, 1973), the tallest building in the city: a slab of
// flats about 47 x 29 m in plan (the 1:500 outlines 298 and 2246, whose b5m heights put the roof 68.5-68.7 m above the
// ground, and the rooftop plant at b5m's 72.5-73.3 m maxima). From the photos (Wikimedia Commons: Zarateman):
//  - seventeen floors of continuous ribbon windows with pale cream frames between spandrels of weathered,
//    board-marked grey concrete streaked by the rain, the bands running round the corners;
//  - a deep vertical slot down the middle of each narrow end;
//  - a crown ~11 m deep that oversails the shaft by about a metre: a solid band, a thin strip of windows, another solid
//    band, a recessed loggia with a red-painted soffit behind slender posts, and the top fascia, ~69 m up;
//  - an entrance storey of glass behind pilotis under the first spandrel, and a lower block to the south (Duque de
//    Mandas 34, outline 201).
//
// build(sites, ctx) receives the GEO.landmarks entries ['atotxa-dorrea'] (footprint ring, at [x, z], buildings, height —
// see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. It returns an Object3D in world (local-frame)
// coordinates.

const H = { lobby: 4.6, floor: 3.14, floors: 17, crown: 1.0, top: 69.0 };

export function build(sites, ctx) {
  const site = sites[0];
  const { GEO, kit } = ctx;
  const parts = (site?.buildings || []).map((i) => GEO.buildings[i]).filter((b) => b?.g?.[0]);
  const tower = parts.filter((b) => b.top - b.ground > 40);
  const podium = parts.filter((b) => b.top - b.ground <= 40);
  if (!tower.length) return null;
  // the tower's box over its outlines' points (the outlines share their edges, so the box is the slab's own)
  const pts = tower.flatMap((b) => b.g[0]);
  const ob = kit.orientedBox(pts);
  if (!(ob.length > 30 && ob.length < 60 && ob.width > 18)) return null;
  const grounds = tower.map((b) => b.ground).sort((a, b) => a - b);
  const ground = grounds[grounds.length >> 1];
  const P = kit.lowestGround(ctx, pts) - ground - 0.3;
  const m = new CentreModel();
  const F = m.facade;
  m.use({ x: ob.x, z: ob.z, angle: ob.angle, ground });

  const L2 = ob.length / 2, W2 = ob.width / 2;
  const concrete = style(FK.plain, FT.concrete);
  const shaftTop = H.lobby + H.floor * H.floors; // 58 m
  const ribbon = style(FK.ribbon, FT.concrete, { bay: 1.3, floor: H.floor, base: H.lobby });

  // Entrance storey: glass set 1.6 m back behind pilotis, under the first spandrel
  m.prism(F, rect(-L2 + 1.6, L2 - 1.6, -W2 + 1.6, W2 - 1.6), P, H.lobby, style(FK.glazed, FT.grey, { bay: 2.2, floor: H.lobby }), { top: false });
  for (const [a, b, n] of [[[-L2, -W2], [L2, -W2], 8], [[-L2, W2], [L2, W2], 8], [[-L2, -W2], [-L2, W2], 5], [[L2, -W2], [L2, W2], 5]]) {
    for (let k = 0; k <= n; k++) {
      const u = a[0] + ((b[0] - a[0]) * k) / n, v = a[1] + ((b[1] - a[1]) * k) / n;
      const cu = Math.max(-L2 + 0.35, Math.min(L2 - 0.35, u)), cv = Math.max(-W2 + 0.35, Math.min(W2 - 0.35, v));
      m.box(F, cu - 0.35, cu + 0.35, P, H.lobby, cv - 0.35, cv + 0.35, concrete, { top: false });
    }
  }

  // The shaft: a core between the two end slots, and the four end blocks either side of them
  const slot = 1.0, depth = 1.4;
  m.box(F, -L2 + depth, L2 - depth, H.lobby, shaftTop, -W2, W2, ribbon, { top: false, bottom: true });
  for (const su of [-1, 1]) {
    const u0 = su > 0 ? L2 - depth : -L2, u1 = su > 0 ? L2 : -L2 + depth;
    for (const [v0, v1] of [[-W2, -slot], [slot, W2]]) {
      m.box(F, u0, u1, H.lobby, shaftTop, v0, v1, ribbon, { top: false, bottom: true });
    }
  }

  // The crown, a metre proud all round: solid band, window strip, solid band, loggia, top fascia
  const c = H.crown, crown = rect(-L2 - c, L2 + c, -W2 - c, W2 + c);
  let y = shaftTop;
  m.prism(F, crown, y, y + 2.5, concrete, { top: false, bottom: true });
  m.prism(F, crown, y + 2.5, y + 3.3, style(FK.ribbon, FT.concrete, { bay: 1.3, floor: 1.6, base: y + 1.7 }), { top: false });
  m.prism(F, crown, y + 3.3, y + 5.8, concrete, { top: false });
  y += 5.8; // the loggia: glass well back behind posts, under a red soffit
  const yl = H.top - 3.0;
  m.prism(F, rect(-L2 + 0.6, L2 - 0.6, -W2 + 0.6, W2 - 0.6), y, yl, style(FK.glazed, FT.grey, { bay: 2.0, floor: yl - y, base: y }), { top: false });
  m.cap(F, crown, y + 0.01, true, concrete);
  for (const [a, b, n] of [[[-L2 - c, -W2 - c], [L2 + c, -W2 - c], 8], [[-L2 - c, W2 + c], [L2 + c, W2 + c], 8], [[-L2 - c, -W2 - c], [-L2 - c, W2 + c], 5], [[L2 + c, -W2 - c], [L2 + c, W2 + c], 5]]) {
    for (let k = 0; k <= n; k++) {
      const u = a[0] + ((b[0] - a[0]) * k) / n, v = a[1] + ((b[1] - a[1]) * k) / n;
      const cu = Math.max(-L2 - c + 0.15, Math.min(L2 + c - 0.15, u)), cv = Math.max(-W2 - c + 0.15, Math.min(W2 + c - 0.15, v));
      m.box(F, cu - 0.14, cu + 0.14, y, yl, cv - 0.14, cv + 0.14, style(FK.plain, FT.grey), { top: false });
    }
  }
  m.box(F, -L2 - c, L2 + c, yl - 0.05, yl, -W2 - c, W2 + c, style(FK.plain, FT.red), { top: false, bottom: true });
  m.prism(F, crown, yl, H.top, concrete, { top: true });

  // Rooftop plant behind the fascia (b5m's 72.5-73.3 m maxima) and two thin masts
  for (const [u0, u1, v0, v1, h] of [[-12, -5, -4, 4, 3.0], [5, 11, -5, 3, 2.4]]) {
    m.box(F, u0, u1, H.top, H.top + h, v0, v1, concrete);
  }
  m.beam(F, [-9, H.top + 3.0, 0], [-9, H.top + 7.0, 0], 0.1, 0.1);
  m.beam(F, [8, H.top + 2.4, -1], [8, H.top + 5.4, -1], 0.08, 0.08);

  // The lower block to the south (Duque de Mandas 34): a glazed ground floor, then ribbon windows like the tower's
  for (const b of podium) {
    const ring = b.g[0];
    const pg = b.ground;
    m.use({ x: 0, z: 0, angle: 0, ground: pg });
    const top = Math.max(b.eave - pg, 5);
    const low = kit.lowestGround(ctx, ring) - pg - 0.3;
    m.prism(F, ring, low, Math.min(4.2, top - 1), style(FK.glazed, FT.grey, { bay: 2.4, floor: 4.2 }), { top: false });
    m.prism(F, ring, Math.min(4.2, top - 1), top, style(FK.ribbon, FT.concrete, { bay: 1.3, floor: 3.6, base: 4.2 }), { top: true });
  }

  return m.finish('AtotxaDorrea');
}
