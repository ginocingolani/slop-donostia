import { pointInRing } from './facade-geometry.js';

// js/donostia/facade-style.js
// Which of Donostia's facade vocabularies a building wears, decided from its district, position, height, footprint and
// cadastral year (b5m), plus the per-building numbers the facade shader reads: storey heights fitted to the measured
// walls, wall / accent / roof colours and a few flags. Plain JS (no three.js) so Node can test it.

export const STYLE = { ROMANTIC: 0, OLDTOWN: 1, MODERN: 2, VILLA: 3, CONTEMPORARY: 4, CIVIC: 5, LIGHT: 6 };

// What a stretch of wall is (the `facade` attribute's w): FRONT gets the full treatment, REAR (courtyards and light
// wells) plain windows, BLANK is a party wall standing above its neighbour, SOLID a jog in a facade, MIRADOR the
// glazed bay windows of the Área Romántica (separate boxes, see buildings.js)
export const WALL = { FRONT: 0, REAR: 1, BLANK: 2, SOLID: 3, MIRADOR: 4 };

// Roof surfaces (the roofs' `rfac` attribute's w) and roof coverings (the roofs' `rcol` alpha)
export const SURF = { FLAT: 0, PITCHED: 1, MANSARD: 2, PARAPET: 3, HOUSING: 4, EAVES: 5, CHIMNEY: 6 };
export const COVER = { TILE: 0, SLATE: 1, ZINC: 2, GRAVEL: 3, METAL: 4 };

// Per style: window bay and corner pier (m, both read by the shader too), storey and ground-floor heights (m), the
// parapet of a flat roof and the eaves overhang of a pitched one (m)
export const STYLE_PARAMS = [
  { bay: 3.3, pier: 1.0, floor: 3.3, ground: 4.6, parapet: 0.9, overhang: 0.45 }, // ROMANTIC
  { bay: 2.5, pier: 0.45, floor: 2.95, ground: 3.6, parapet: 0.6, overhang: 0.8 }, // OLDTOWN
  { bay: 3.0, pier: 0.6, floor: 2.9, ground: 3.9, parapet: 1.0, overhang: 0.35 }, // MODERN
  { bay: 3.6, pier: 0.9, floor: 2.9, ground: 2.9, parapet: 0.4, overhang: 0.65 }, // VILLA
  { bay: 3.4, pier: 0.5, floor: 3.0, ground: 3.9, parapet: 1.0, overhang: 0.3 }, // CONTEMPORARY
  { bay: 5.5, pier: 1.6, floor: 6.0, ground: 6.0, parapet: 0.6, overhang: 0.35 }, // CIVIC
  { bay: 4.0, pier: 0.5, floor: 3.0, ground: 3.0, parapet: 0.0, overhang: 0.25 } // LIGHT
];

// Flag bits of the accent colour's alpha
export const FLAG = { BALCONY_RUN: 1, TIMBER: 2, ASHLAR: 4, BRICK: 8, NO_SHUTTERS: 16, PLAZA: 32 };

// The Parte Vieja between Urgull, the port and the Boulevard (local metres)
export const PARTE_VIEJA = [90, -340, 190, -462, 330, -468, 445, -420, 500, -150, 300, -100, 225, -60, 120, -40, 70, -160];

// Konstituzio plaza, the square enclosed by the facades that face it (local metres, from the 1:500 outlines)
export const KONSTITUZIO = [285.5, -226.6, 336.4, -244.2, 324.2, -279.6, 273.2, -261.0];

const HILLS = new Set(['IGELDO', 'AIETE', 'ATEGORRIETA - ULIA', 'MIRAMON - ZORROAGA']);
// districts whose blocks of flats mostly keep shops on the ground floor
const SHOPPING = new Set(['ERDIALDEA', 'GROS', 'EGIA', 'AMARABERRI']);
const CIVIC_NAME = /(^|[\s,])(eliza|komentua|monasterioa|kapera|basilika|ermita|santutegia|parrokia|katedrala|museoa)([\s,]|$)/i;

// sRGB hex palettes: walls per style, accents (shutters, railings, doors, blinds), roofs
const WALLS = [
  // sandstone & cream ashlar of the Área Romántica
  [0xd9c7a5, 0xe3d6bb, 0xcfb894, 0xe8e0cf, 0xd6c3a0, 0xc9b28c, 0xe6d2b0, 0xdcd3c2],
  // render of the Parte Vieja: cream, ochre, sand, grey-green, salmon, pale blue, white, apricot
  [0xe8d9b5, 0xe5c98f, 0xd8b38a, 0xc9cfc0, 0xe2b9a2, 0xbfcdd3, 0xf0ece2, 0xd9a77e, 0xdcc9a0, 0xe9e1cc],
  // 1950s-80s: render & concrete (brick in BRICK_WALLS)
  [0xbdb7aa, 0xd0cabc, 0xa8a59c, 0xe0dccf, 0xc7b49a, 0xd6cdb8],
  // villas: whitewash & cream
  [0xf2efe6, 0xeee6d2, 0xe9dcc0, 0xf0e9dd, 0xe4dccb],
  // since the late 80s: white & grey render, stone cladding, dark brick
  [0xe9e7e1, 0xcfcac0, 0x9a958c, 0xc8b9a0, 0xdcd6ca, 0xb5a58a],
  // churches & convents: sandstone
  [0xcdb894, 0xbfae8e, 0xd4c4a4],
  // sheds, canopies & glasshouses: sheet metal & painted block
  [0xb8b6b0, 0xd8d6d0, 0x8c9a8a, 0xa88f72, 0xc9c3b5]
];
const BRICK_WALLS = [0x9a5a44, 0xa86b4f, 0x8a4a3a, 0xb98a68, 0xc4a27e, 0x93604a];
const OLD_STONE = [0xc8b48e, 0xbfa883, 0xd1bf9a];
const ACCENTS = [
  [0x1b1c1e, 0x2a2622, 0x1f2a24], // ROMANTIC: wrought iron, dark doors
  [0x2f5a3a, 0x7a2a22, 0x2c4a6e, 0x5a3a24, 0xe8e6e0, 0x1f2f26, 0x3f6a6a, 0x8a4a2a], // OLDTOWN: painted shutters & rails
  [0xe4e2dc, 0x8a9a7a, 0x9a8a72, 0x6a7a8a, 0xc9b99a, 0x7a6a5a], // MODERN: roller blinds
  [0x6a2a1e, 0x2f5a3a, 0x5a3a24, 0x3a5a7a, 0x7a3a2a], // VILLA: shutters & timber
  [0x3a3c40, 0x8a8e92, 0xd8d6d0, 0x5a4a3a], // CONTEMPORARY: frames
  [0x3a2a1e, 0x2a2a2a], // CIVIC
  [0x6a6a6a, 0x4a5a4a] // LIGHT
];
const TILES = [0x9a5a45, 0x8c5240, 0xa0604a, 0x7d4a3a, 0x8f5c4a, 0x955746, 0x84564a];
const SLATES = [0x4a4d55, 0x3d4048, 0x55585e];
const ZINCS = [0x8a9096, 0x7a8086, 0x949a9c];
const GRAVELS = [0x8e8a82, 0x77736c, 0x9c978d, 0x6e6c68];
const METALS = [0x8a8d90, 0x6f7a6e, 0x8a5a48, 0xa8a8a2];

export function hash(i) {
  let x = Math.imul((i | 0) ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

const pick = (list, h) => list[Math.min(list.length - 1, Math.floor(h * list.length))];
const rgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

// ctx: { district (name), cx, cz, area, partyShare (share of the outline against other buildings), flat (bool) }
export function chooseStyle(b, ctx) {
  if (b.kind === 1) return STYLE.LIGHT;
  const wallH = b.eave - b.ground;
  if (b.name && CIVIC_NAME.test(b.name) && wallH >= 6) return STYLE.CIVIC;
  const y = b.built || 0;
  const modernYear = y >= 1950 && y <= 1985;
  const detached = ctx.partyShare < 0.15;
  const lowDetached = wallH <= 12 && detached && ctx.area < 900;
  if (pointInRing(ctx.cx, ctx.cz, PARTE_VIEJA)) {
    if (ctx.area > 2500 || wallH > 30) return y && y < 1950 ? STYLE.ROMANTIC : STYLE.MODERN;
    return STYLE.OLDTOWN;
  }
  if (wallH > 32) return STYLE.MODERN;
  const oldGros = ctx.district === 'GROS' && ctx.cx < 1250 && (!y || y < 1950 || y > 1985);
  if (ctx.district === 'ERDIALDEA' || oldGros) {
    if (modernYear) return STYLE.MODERN;
    if (lowDetached && !ctx.flat) return STYLE.VILLA;
    if (wallH < 7) return detached ? STYLE.VILLA : STYLE.OLDTOWN;
    return STYLE.ROMANTIC;
  }
  if (lowDetached && (HILLS.has(ctx.district) || !ctx.flat || ctx.area < 300)) return STYLE.VILLA;
  if (modernYear) return STYLE.MODERN;
  if (y && y < 1950) return wallH >= 8 ? STYLE.OLDTOWN : STYLE.VILLA;
  if (!y) return wallH < 8 ? STYLE.CONTEMPORARY : STYLE.MODERN;
  return STYLE.CONTEMPORARY;
}

// Everything the facade & roof shaders need about one building. ctx as for chooseStyle, plus `index`.
export function facadeInfo(b, ctx) {
  const style = chooseStyle(b, ctx);
  const P = STYLE_PARAMS[style];
  const h = (k) => hash(ctx.index * 131 + k * 7919);
  const seed = 0.05 + 0.9 * h(1);
  const wallH = b.eave - b.ground;
  const rise = b.top - b.eave;
  // The rise b5m finds over a deep block of flats is its lift housing, not a mansard
  const modernBlock = (style === STYLE.MODERN || style === STYLE.CONTEMPORARY) && b.roof === 2;
  const flat = b.roof === 0 || rise < 0.5 || modernBlock;
  const housing = modernBlock ? Math.min(rise, 3.6) : 0;
  // Flat roofs hide behind a parapet inside the measured height (b5m's mean height includes it)
  const parapet = flat && style !== STYLE.LIGHT && wallH > 5 ? Math.min(P.parapet, wallH * 0.12) : 0;
  const storeyTop = wallH - parapet;

  let shops = false;
  if (style === STYLE.ROMANTIC) shops = h(2) < 0.92;
  else if (style === STYLE.OLDTOWN) shops = storeyTop > 7 && (h(2) < 0.88 || ctx.plaza);
  else if (style === STYLE.MODERN) shops = h(2) < (SHOPPING.has(ctx.district) ? 0.75 : 0.35);
  else if (style === STYLE.CONTEMPORARY) shops = storeyTop > 10 && h(2) < 0.4;
  if (ctx.partyShare < 0.05 && style !== STYLE.ROMANTIC && style !== STYLE.OLDTOWN && storeyTop < 10) shops = false;

  // Storeys fitted to the measured wall: whole floors between the ground floor and the eaves
  let groundH = shops ? P.ground : P.floor;
  let floorH = P.floor;
  if (style === STYLE.CIVIC) {
    groundH = floorH = Math.max(storeyTop, 3);
  } else if (storeyTop < groundH + 0.6 * P.floor) {
    groundH = Math.max(storeyTop, 2.4);
  } else {
    const n = Math.max(1, Math.round((storeyTop - groundH) / P.floor));
    floorH = (storeyTop - groundH) / n;
    if (floorH < 0.85 * P.floor || floorH > 1.25 * P.floor) {
      groundH = Math.min(Math.max(storeyTop - n * P.floor, 0.8 * groundH), 1.35 * groundH);
      floorH = (storeyTop - groundH) / n;
    }
    // a residential ground floor is one more storey of the same height
    if (!shops) groundH = floorH;
  }

  let flags = 0;
  let wall, accent;
  if (style === STYLE.ROMANTIC) {
    if (h(3) < 0.5) flags |= FLAG.BALCONY_RUN;
    flags |= FLAG.ASHLAR;
  }
  if (style === STYLE.OLDTOWN && b.built && b.built < 1860 && h(4) < 0.5) flags |= FLAG.ASHLAR;
  // Konstituzio plaza: one uniform front of cream render, white balconies on every floor over an arcade
  const plaza = ctx.plaza && style === STYLE.OLDTOWN;
  if (plaza) flags = (flags & ~FLAG.ASHLAR) | FLAG.PLAZA | FLAG.NO_SHUTTERS;
  if (style === STYLE.VILLA && h(5) < 0.35) flags |= FLAG.TIMBER;
  if ((style === STYLE.VILLA && h(6) < 0.3) || (style === STYLE.OLDTOWN && h(6) < 0.55)) flags |= FLAG.NO_SHUTTERS;
  if (style === STYLE.CIVIC) flags |= FLAG.ASHLAR;
  if ((style === STYLE.MODERN && h(7) < 0.45) || (style === STYLE.CONTEMPORARY && h(7) < 0.15)) flags |= FLAG.BRICK;
  if (flags & FLAG.BRICK) wall = pick(BRICK_WALLS, h(8));
  else if (style === STYLE.OLDTOWN && flags & FLAG.ASHLAR) wall = pick(OLD_STONE, h(8));
  else wall = pick(WALLS[style], h(8));
  accent = pick(ACCENTS[style], h(9));
  if (plaza) { wall = 0xe8d9ae; accent = 0xeeece4; }

  // Roof covering: slate & zinc mansards in the centre, Roman tile almost everywhere else, gravel on flat roofs
  let cover, roof;
  const r = h(10);
  if (style === STYLE.LIGHT) { cover = COVER.METAL; roof = pick(METALS, h(11)); }
  else if (flat) {
    cover = style === STYLE.ROMANTIC && r < 0.5 ? COVER.ZINC : COVER.GRAVEL;
    roof = cover === COVER.ZINC ? pick(ZINCS, h(11)) : pick(GRAVELS, h(11));
  } else if (style === STYLE.ROMANTIC && b.roof === 2) {
    cover = r < 0.65 ? COVER.SLATE : COVER.ZINC;
    roof = cover === COVER.SLATE ? pick(SLATES, h(11)) : pick(ZINCS, h(11));
  } else if ((style === STYLE.ROMANTIC || style === STYLE.CIVIC) && r < 0.5) {
    cover = COVER.SLATE; roof = pick(SLATES, h(11));
  } else if ((style === STYLE.MODERN || style === STYLE.CONTEMPORARY) && r < 0.25) {
    cover = COVER.SLATE; roof = pick(SLATES, h(11));
  } else { cover = COVER.TILE; roof = pick(TILES, h(11)); }

  return {
    style, seed, flat, housing, parapet, shops, groundH, floorH, storeyTop, wallH, flags,
    wall: rgb(wall), accent: rgb(accent), roof: rgb(roof), cover,
    overhang: P.overhang, bay: P.bay, pier: P.pier
  };
}

// Window bays of a run (same arithmetic as the facade shader, see facade-material.js)
export function bayLayout(runLen, style) {
  const P = STYLE_PARAMS[style];
  const pier = Math.min(P.pier, runLen * 0.12);
  const inner = Math.max(runLen - 2 * pier, 0.01);
  const bays = Math.max(Math.floor(inner / P.bay + 0.5), 1);
  return { pier, inner, bays, bayW: inner / bays };
}
