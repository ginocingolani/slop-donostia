// js/donostia/landmarks/glyphs.js
// Bold sans capitals and a few figures, cap height 1, for the lettering the landmarks build out of triangles (Anoeta's
// REALE ARENA and REAL SOCIEDAD) and for the tifo on its south stand (the 1909 of the card mosaic, the name on the
// banner; tools/donostia/bake-tifo.mjs rasterises them). No imports: Node's bakes load it as it is.
//
// A glyph is { w: advance, parts }, each part one of ['rect', x0, y0, x1, y1], ['poly', [[x, y], ...]] (convex) and
// ['ring', cx, cy, outer rx, outer ry, inner rx, inner ry, from°, to°] (an elliptic annulus sector, counter-clockwise).

const D2R = Math.PI / 180;

export const GLYPHS = {
  A: { w: 0.78, parts: [['poly', [[0, 0], [0.19, 0], [0.48, 1], [0.3, 1]]], ['poly', [[0.59, 0], [0.78, 0], [0.48, 1], [0.3, 1]]], ['rect', 0.18, 0.2, 0.6, 0.35]] },
  B: { w: 0.7, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0.84, 0.38, 1], ['rect', 0, 0.43, 0.4, 0.58], ['rect', 0, 0, 0.4, 0.16], ['ring', 0.38, 0.715, 0.28, 0.285, 0.12, 0.13, -90, 90], ['ring', 0.4, 0.29, 0.3, 0.29, 0.13, 0.135, -90, 90]] },
  C: { w: 0.76, parts: [['ring', 0.4, 0.5, 0.4, 0.5, 0.22, 0.33, 42, 318]] },
  D: { w: 0.74, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0, 0.3, 0.17], ['rect', 0, 0.83, 0.3, 1], ['ring', 0.3, 0.5, 0.44, 0.5, 0.26, 0.33, -90, 90]] },
  E: { w: 0.6, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0.84, 0.6, 1], ['rect', 0, 0.42, 0.54, 0.58], ['rect', 0, 0, 0.6, 0.16]] },
  I: { w: 0.18, parts: [['rect', 0, 0, 0.18, 1]] },
  L: { w: 0.56, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0, 0.56, 0.16]] },
  N: { w: 0.72, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0.54, 0, 0.72, 1], ['poly', [[0, 1], [0.2, 1], [0.72, 0], [0.52, 0]]]] },
  O: { w: 0.8, parts: [['ring', 0.4, 0.5, 0.4, 0.5, 0.22, 0.33, 0, 360]] },
  R: { w: 0.7, parts: [['rect', 0, 0, 0.18, 1], ['rect', 0, 0.84, 0.4, 1], ['rect', 0, 0.4, 0.4, 0.56], ['ring', 0.4, 0.7, 0.3, 0.3, 0.14, 0.14, -90, 90], ['poly', [[0.3, 0.42], [0.5, 0.42], [0.72, 0], [0.5, 0]]]] },
  S: { w: 0.66, parts: [['ring', 0.33, 0.745, 0.33, 0.255, 0.16, 0.085, 25, 270], ['ring', 0.33, 0.255, 0.33, 0.255, 0.16, 0.085, -155, 90]] },
  T: { w: 0.66, parts: [['rect', 0, 0.84, 0.66, 1], ['rect', 0.24, 0, 0.42, 0.84]] },
  Z: { w: 0.64, parts: [['rect', 0, 0.84, 0.64, 1], ['rect', 0, 0, 0.64, 0.16], ['poly', [[0, 0.16], [0.24, 0.16], [0.64, 0.84], [0.4, 0.84]]]] },
  // figures: the club's founding year, 1909
  0: { w: 0.66, parts: [['ring', 0.33, 0.5, 0.33, 0.5, 0.15, 0.32, 0, 360]] },
  1: { w: 0.46, parts: [['rect', 0.22, 0, 0.42, 1], ['poly', [[0.0, 0.7], [0.22, 0.82], [0.22, 1.0], [0.0, 0.88]]]] },
  9: { w: 0.66, parts: [['ring', 0.33, 0.66, 0.33, 0.34, 0.15, 0.16, 0, 360], ['rect', 0.48, 0.3, 0.66, 0.66], ['ring', 0.33, 0.33, 0.33, 0.33, 0.15, 0.15, 200, 360]] }
};
export const TRACKING = 0.12, SPACE = 0.35;

// Triangles of a primitive, in its own 2D units
export function primitiveTriangles(p, emit) {
  if (p[0] === 'rect') {
    const [, x0, y0, x1, y1] = p;
    emit([x0, y0], [x1, y0], [x1, y1]);
    emit([x0, y0], [x1, y1], [x0, y1]);
  } else if (p[0] === 'poly') {
    const v = p[1];
    for (let k = 1; k + 1 < v.length; k++) emit(v[0], v[k], v[k + 1]);
  } else {
    const [, cx, cy, rxo, ryo, rxi, ryi, a0, a1] = p;
    const n = Math.max(4, Math.ceil(Math.abs(a1 - a0) / 8));
    for (let k = 0; k < n; k++) {
      const t0 = (a0 + ((a1 - a0) * k) / n) * D2R, t1 = (a0 + ((a1 - a0) * (k + 1)) / n) * D2R;
      const o0 = [cx + rxo * Math.cos(t0), cy + ryo * Math.sin(t0)], o1 = [cx + rxo * Math.cos(t1), cy + ryo * Math.sin(t1)];
      const i0 = [cx + rxi * Math.cos(t0), cy + ryi * Math.sin(t0)], i1 = [cx + rxi * Math.cos(t1), cy + ryi * Math.sin(t1)];
      emit(i0, o0, o1);
      emit(i0, o1, i1);
    }
  }
}

export function textWidth(text) {
  let w = 0;
  for (const ch of text) w += ch === ' ' ? SPACE : GLYPHS[ch].w + TRACKING;
  return w - TRACKING;
}

// Lays a string out from x = 0 and hands each triangle (cap height 1) to emit
export function textTriangles(text, emit) {
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') { x += SPACE; continue; }
    const g = GLYPHS[ch];
    for (const p of g.parts) primitiveTriangles(p, (a, b, c) => emit([a[0] + x, a[1]], [b[0] + x, b[1]], [c[0] + x, c[1]]));
    x += g.w + TRACKING;
  }
}

// A string's triangles as a point test: inside(x, y) in cap heights from its left end's baseline
export function textCoverage(text) {
  const tris = [];
  textTriangles(text, (a, b, c) => tris.push([a, b, c]));
  const side = (p, a, b) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  return (x, y) => {
    const p = [x, y];
    for (const [a, b, c] of tris) {
      const d0 = side(p, a, b), d1 = side(p, b, c), d2 = side(p, c, a);
      if ((d0 >= 0 && d1 >= 0 && d2 >= 0) || (d0 <= 0 && d1 <= 0 && d2 <= 0)) return true;
    }
    return false;
  };
}
