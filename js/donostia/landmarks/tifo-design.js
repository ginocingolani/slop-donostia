import { textWidth, textCoverage } from './glyphs.js';

// js/donostia/landmarks/tifo-design.js
// The design of the tifo on Anoeta's south stand, the Aitor Zabaleta harmaila (js/donostia/landmarks/anoeta-tifo.js
// builds it), after the one Real Sociedad's fans raised at La Cartuja for the 2026 Copa del Rey final. No three.js:
// tools/donostia/bake-tifo.mjs reads it too, to draw the banner and preview the mosaic.
//
// - The card mosaic over the upper tier, as seen from the pitch: x from 0 (left, the east corner) to 1 (right, the
//   west corner), y from 0 (the tier's front row) to 1 (its back row). A field of blue and white bands, the club's
//   founding year in white on a blue panel, and the ikurriña on the right, each between white bands.
// - The banner over the lower tier: Aitor Zabaleta's portrait in a round medallion on a dark shield, his name above it,
//   a gold laurel round it. Its frame is baked into data/donostia/tifo-banner.png and his portrait, the one texture
//   to replace (see tools/donostia/README.md), into data/donostia/tifo-portrait.png.

// The card colours, in linear RGB: 0 the club's blue, 1 white, 2 red, 3 green
export const PALETTE = [[0.0, 0.11, 0.48], [0.82, 0.83, 0.84], [0.62, 0.02, 0.018], [0.0, 0.3, 0.07]];
export const BLUE = 0, WHITE = 1, RED = 2, GREEN = 3;

// Across the tier: 18 bands (blue first), the year's panel over bands 4-10 and the ikurriña over 12-16, each between
// two white bands, both the tier's full height
export const BANDS = 18;
export const YEAR = { text: '1909', x0: 4 / 18, x1: 11 / 18, y0: 0, y1: 1, height: 0.62 };
export const IKURRINA = { x0: 12 / 18, x1: 17 / 18, y0: 0, y1: 1, cross: 0.07, saltire: 0.075 };

const inBox = (x, y, b) => x >= b.x0 && x < b.x1 && y >= b.y0 && y <= b.y1;

// The ikurriña at (fx, fy) in [0, 1]² over a flag `aspect` times as wide as tall: a red field, the green saltire, the
// white cross over it (arm widths as shares of the height)
export function ikurrinaAt(fx, fy, aspect, cross = IKURRINA.cross, saltire = IKURRINA.saltire) {
  const px = fx * aspect, py = fy, n = Math.hypot(1, aspect);
  if (Math.abs(px - aspect / 2) < cross || Math.abs(py - 0.5) < cross) return WHITE;
  const d1 = Math.abs(px - py * aspect) / n, d2 = Math.abs(px - (1 - py) * aspect) / n;
  return Math.min(d1, d2) < saltire ? GREEN : RED;
}

/**
 * The mosaic: a palette index for the card at (x, y). aspect: the tier's width over its height as seen from the pitch,
 * so the year's figures and the ikurriña keep their proportions.
 */
export function mosaic(aspect) {
  const { text, height } = YEAR;
  const inside = textCoverage(text);
  const yh = (YEAR.y1 - YEAR.y0) * height; // the figures' height, a share of the tier
  const w = (textWidth(text) * yh) / aspect; // ... and their width, a share of its width
  const tx0 = (YEAR.x0 + YEAR.x1) / 2 - w / 2, ty0 = (YEAR.y0 + YEAR.y1) / 2 - yh / 2;
  const flagAspect = ((IKURRINA.x1 - IKURRINA.x0) * aspect) / (IKURRINA.y1 - IKURRINA.y0);
  return (x, y) => {
    if (inBox(x, y, YEAR)) return inside((x - tx0) * aspect / yh, (y - ty0) / yh) ? WHITE : BLUE;
    if (inBox(x, y, IKURRINA)) return ikurrinaAt((x - IKURRINA.x0) / (IKURRINA.x1 - IKURRINA.x0), (y - IKURRINA.y0) / (IKURRINA.y1 - IKURRINA.y0), flagAspect);
    return Math.floor(x * BANDS) % 2 ? WHITE : BLUE;
  };
}

// --- the banner ------------------------------------------------------------------------------------------------------

// Its art in metres, x across (0 at the left as seen from the pitch) and y up the tier (0 at the front): the shield,
// the medallion, the name and the laurel. The model stretches it over the cloth it spreads on the lower tier.
export const BANNER = {
  width: 36, height: 18, // m, the design's frame; the texture is TEX_W x TEX_H
  texW: 1024, texH: 512,
  shield: { cx: 18, top: 17.0, arch: 0.45, halfWidth: 10.4, shoulder: 7.2, bottom: 0.5 },
  medallion: { cx: 18, cy: 8.6, r: 5.5, ring: 0.42 },
  name: { text: 'AITOR ZABALETA', base: 14.65, cap: 1.45 },
  portraitSize: 288 // px, the portrait texture's side (square: the medallion's disc fills it)
};

// The medallion's disc in the banner's uv (u across, v up), for the shader that lays the portrait in it
export function medallionUV() {
  const { width, height, medallion: m } = BANNER;
  return { u: m.cx / width, v: m.cy / height, ru: m.r / width, rv: m.r / height };
}

// The shield's half-width at height y (0 above its top or below its point)
export function shieldHalfWidth(y) {
  const s = BANNER.shield;
  if (y < s.bottom || y > s.top + s.arch) return 0;
  if (y >= s.shoulder) return s.halfWidth;
  const k = (s.shoulder - y) / (s.shoulder - s.bottom); // 0 at the shoulders, 1 at the point
  return s.halfWidth * Math.pow(1 - Math.pow(k, 1.7), 0.62);
}

// Is (x, y) inside the shield (its top arching up by `arch` at the middle)?
export function inShield(x, y, grow = 0) {
  const s = BANNER.shield, dx = x - s.cx;
  const top = s.top + s.arch * Math.max(0, 1 - (dx / s.halfWidth) ** 2) + grow;
  if (y > top || y < s.bottom - grow) return false;
  return Math.abs(dx) <= shieldHalfWidth(Math.min(Math.max(y, s.bottom), s.top)) + grow;
}

