import * as THREE from 'three/webgpu';

// js/donostia/trees-atlas.js
// The leaf atlas of Donostia's trees: 3 x 3 tiles of leaf sprays drawn in metres on a canvas and fitted to their tile
// (tileMeters = the card's world size), with a mip chain that keeps each tile's alpha-tested coverage so distant
// crowns don't thin out. Adapted from buildSprays / createLeafAtlas / coverageMips in js/trees.js (slop-newyork, MIT).
//   0 London plane · 1 tamarisk · 2 lime & broadleaf · 3 magnolia & holm oak · 4 pine · 5 palm frond
//   6 far broadleaf clump · 7 far feathery clump (tamarisk, palm) · 8 far conifer clump
// Texels: r = leaf brightness, g = per-leaf hue jitter, b = twig / stalk mask, a = coverage.

export const ATLAS_SIZE = 1536;
export const ATLAS_TILES = 3;
export const TILE = ATLAS_SIZE / ATLAS_TILES;
export const GUTTER = 8; // px kept clear round every tile, so mip levels don't bleed between tiles
export const TILE_FAR = { broadleaf: 6, feathery: 7, conifer: 8 };
const FAR_TILES = new Set(Object.values(TILE_FAR));
export const tileOrigin = (k) => [(k % ATLAS_TILES) * TILE, Math.floor(k / ATLAS_TILES) * TILE];

// Seeded PRNG (mulberry32): the same atlas on every load
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const lerp = (a, b, t) => a + (b - a) * t;

// Spray primitives in metres (x right, y up from the card's attachment point): twigs, stalks & needles (polylines),
// leaves (ovals & palmate blades)
function buildSprays(rng) {
  const R = (a, b) => a + (b - a) * rng();

  // Curving twig from (x, y) at angle a off vertical, len m long, curling by `curl` rad over its length
  const twig = (x, y, a, len, curl, segs = 12) => {
    const pts = [[x, y]];
    let ang = a;
    for (let i = 1; i <= segs; i++) {
      ang += curl / segs + R(-0.035, 0.035);
      const p = pts[i - 1];
      pts.push([p[0] + Math.sin(ang) * len / segs, p[1] + Math.cos(ang) * len / segs]);
    }
    return pts;
  };
  // Point & direction angle at arc fraction t of a polyline
  const at = (pts, t) => {
    const f = Math.min(pts.length - 1.001, t * (pts.length - 1));
    const i = Math.floor(f), k = f - i, a = pts[i], b = pts[i + 1];
    return { p: [lerp(a[0], b[0], k), lerp(a[1], b[1], k)], a: Math.atan2(b[0] - a[0], b[1] - a[1]) };
  };
  // A far-crown clump: a ragged roundish mass of `count` leaves of length len (one card stands for a section of a
  // distant crown); `holes` leaves gaps of sky through it
  const clump = (count, len, wid, lobesN, holes = 0) => {
    const prims = [];
    const lobes = Array.from({ length: lobesN }, () => ({ a: R(0, Math.PI * 2), r: R(0.75, 1.0), w: R(0.5, 0.9) }));
    const edge = (ang) => 1.25 * lobes.reduce((m, l) => Math.max(m, l.r * Math.cos(Math.min(Math.PI / 2, Math.abs(((ang - l.a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) / l.w))), 0.6);
    const gaps = Array.from({ length: holes }, () => [R(-0.8, 0.8), 1.3 + R(-0.8, 0.8), R(0.12, 0.26)]);
    for (let k = 0; k < count; k++) {
      const ang = R(0, Math.PI * 2), rr = Math.sqrt(rng()) * edge(ang);
      const p = [Math.cos(ang) * rr, 1.3 + Math.sin(ang) * rr];
      if (gaps.some(([gx, gy, gr]) => Math.hypot(p[0] - gx, p[1] - gy) < gr)) continue;
      prims.push({ type: 'oval', p, a: R(-Math.PI, Math.PI), len: len * R(0.8, 1.2), wid, t: Math.min(1, Math.max(0, (p[1] - 0.2) / 2.2)) });
    }
    return prims;
  };

  const sprays = [];

  // 0. London plane: four or five twigs fanning out, big palmate leaves on long stalks, alternating along them
  {
    const prims = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const pts = twig(f * 0.08, 0, f * 1.55 + R(-0.1, 0.1), R(0.62, 0.8) * (1 - Math.abs(f) * 0.32), f * 0.6);
      prims.push({ type: 'twig', pts, w0: 0.016, w1: 0.006 });
      let side = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.18, 0.26); t < 0.97; t += R(0.15, 0.19)) {
        const { p, a } = at(pts, t);
        side = -side;
        const la = a + side * R(0.55, 1.05);
        const len = R(0.17, 0.23) * (1 - t * 0.25);
        const stalk = len * 0.32;
        const q = [p[0] + Math.sin(la) * stalk, p[1] + Math.cos(la) * stalk];
        prims.push({ type: 'stalk', a: p, b: q, w: 0.006 });
        prims.push({ type: 'palmate', p: q, a: la + R(-0.25, 0.25), len, t });
      }
      const tip = at(pts, 1);
      prims.push({ type: 'palmate', p: tip.p, a: tip.a + R(-0.2, 0.2), len: R(0.15, 0.19), t: 1 });
    }
    sprays.push(prims);
  }

  // 1. Tamarisk: weeping plumes of slender branchlets clothed in tiny scale leaves (feathery, grey-green, see-through)
  {
    const prims = [];
    const n = 4;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const pts = twig(f * 0.05, 0, f * 1.4 + R(-0.12, 0.12), R(0.6, 0.75), f * 0.9 + R(-0.2, 0.2), 14);
      prims.push({ type: 'twig', pts, w0: 0.01, w1: 0.004 });
      let side = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.08, 0.14); t < 0.98; t += R(0.055, 0.075)) {
        const { p, a } = at(pts, t);
        side = -side;
        const b = twig(p[0], p[1], a + side * R(0.45, 0.8), R(0.12, 0.2) * (1 - t * 0.3), side * R(0.2, 0.6), 6);
        prims.push({ type: 'stalk', pts: b, w: 0.0035 });
        for (let s = 0.08; s <= 1.0; s += 0.075) {
          const q = at(b, s);
          for (const sd of [-1, 1]) prims.push({ type: 'oval', p: q.p, a: q.a + sd * R(0.25, 0.55), len: R(0.016, 0.024), wid: 0.34, t: Math.min(1, t + s * 0.2) });
        }
      }
      // the plume's tip: a dense tassel
      const tip = at(pts, 1);
      for (let k = 0; k < 14; k++) prims.push({ type: 'oval', p: tip.p, a: tip.a + R(-0.9, 0.9), len: R(0.02, 0.03), wid: 0.34, t: 1 });
    }
    sprays.push(prims);
  }

  // 2. Lime & broadleaf: zigzag twigs, drooping a little, with two ranks of oval, pointed, lopsided leaves
  {
    const prims = [];
    const n = 5;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const pts = twig(f * 0.06, 0, f * 1.6 + R(-0.1, 0.1), R(0.5, 0.66) * (1 - Math.abs(f) * 0.25), f * 0.9, 14);
      prims.push({ type: 'twig', pts, w0: 0.012, w1: 0.004 });
      let side = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.1, 0.16); t < 0.97; t += R(0.085, 0.11)) {
        const { p, a } = at(pts, t);
        side = -side;
        prims.push({ type: 'oval', p, a: a + side * R(0.6, 1.0), len: R(0.1, 0.13) * (1 - t * 0.2), wid: 0.62, skew: side * 0.12, t });
      }
      const tip = at(pts, 1);
      prims.push({ type: 'oval', p: tip.p, a: tip.a, len: 0.09, wid: 0.6, t: 1 });
    }
    sprays.push(prims);
  }

  // 3. Magnolia & holm oak: stout twigs ending in whorls of big, glossy, elliptic leaves, more leaves along them
  {
    const prims = [];
    const n = 4;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const pts = twig(f * 0.06, 0, f * 1.5 + R(-0.1, 0.1), R(0.5, 0.62), f * 0.5, 10);
      prims.push({ type: 'twig', pts, w0: 0.016, w1: 0.008 });
      let side = rng() < 0.5 ? 1 : -1;
      for (let t = R(0.2, 0.3); t < 0.8; t += R(0.14, 0.18)) {
        const { p, a } = at(pts, t);
        side = -side;
        prims.push({ type: 'oval', p, a: a + side * R(0.7, 1.1), len: R(0.12, 0.16), wid: 0.44, t, gloss: true });
      }
      const tip = at(pts, 1);
      const whorl = 6 + Math.floor(rng() * 3);
      for (let k = 0; k < whorl; k++) {
        const a = tip.a + ((k + 0.5) / whorl - 0.5) * 3.6 + R(-0.15, 0.15);
        prims.push({ type: 'oval', p: tip.p, a, len: R(0.15, 0.2), wid: 0.42, t: 1, gloss: true });
      }
    }
    sprays.push(prims);
  }

  // 4. Pine: twigs carrying brushes of long needles that sweep forward, densest towards the tips
  {
    const prims = [];
    const n = 3;
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const pts = twig(f * 0.05, 0, f * 1.2 + R(-0.1, 0.1), R(0.55, 0.68), f * 0.3, 10);
      prims.push({ type: 'twig', pts, w0: 0.018, w1: 0.01 });
      for (let t = 0.25; t <= 1.0; t += 0.05) {
        const { p, a } = at(pts, t);
        const count = Math.round(lerp(5, 11, t));
        for (let k = 0; k < count; k++) {
          const na = a + R(-1.15, 1.15) * (1.1 - t * 0.4);
          const len = R(0.11, 0.17);
          const q = [p[0] + Math.sin(na) * len, p[1] + Math.cos(na) * len];
          prims.push({ type: 'needle', a: p, b: q, w: 0.0045, t });
        }
      }
    }
    sprays.push(prims);
  }

  // 5. Palm frond (Canary Island date palm): a rachis up the middle with long leaflets in a V, shortest at both ends
  {
    const prims = [];
    const pts = twig(0, 0, 0, 1.0, R(-0.05, 0.05), 16);
    prims.push({ type: 'twig', pts, w0: 0.022, w1: 0.006 });
    for (let t = 0.1; t < 0.99; t += 0.022) {
      const { p, a } = at(pts, t);
      const len = 0.34 * Math.sin(Math.PI * Math.min(1, (t - 0.05) / 0.98)) ** 0.7 + 0.04;
      for (const sd of [-1, 1]) prims.push({ type: 'oval', p, a: a + sd * R(0.55, 0.75), len: len * R(0.9, 1.05), wid: 0.12, t });
    }
    sprays.push(prims);
  }

  // 6-8. Far-crown clumps: dense broadleaf, feathery (gappy, small leaves), conifer (tufts of needle-like strokes)
  sprays.push(clump(520, 0.19, 0.55, 7));
  sprays.push(clump(900, 0.1, 0.35, 9, 5));
  {
    const prims = [];
    for (let c = 0; c < 26; c++) {
      const ang = R(0, Math.PI * 2), rr = Math.sqrt(rng()) * 1.05;
      const cx = Math.cos(ang) * rr, cy = 1.3 + Math.sin(ang) * rr * 0.85;
      for (let k = 0; k < 40; k++) {
        const na = R(-Math.PI, Math.PI), len = R(0.12, 0.2);
        prims.push({ type: 'needle', a: [cx, cy], b: [cx + Math.sin(na) * len, cy + Math.cos(na) * len], w: 0.016, t: Math.min(1, Math.max(0, (cy - 0.3) / 2)) });
      }
    }
    sprays.push(prims);
  }
  return sprays;
}

// Bounding box of a spray (metres), with leaves treated as discs round their centre
function sprayBounds(prims) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y, r = 0) => {
    minX = Math.min(minX, x - r);
    maxX = Math.max(maxX, x + r);
    minY = Math.min(minY, y - r);
    maxY = Math.max(maxY, y + r);
  };
  for (const q of prims) {
    if (q.type === 'twig' || (q.type === 'stalk' && q.pts)) for (const p of q.pts) add(p[0], p[1]);
    else if (q.type === 'stalk' || q.type === 'needle') {
      add(q.a[0], q.a[1]);
      add(q.b[0], q.b[1]);
    } else add(q.p[0] + Math.sin(q.a) * q.len * 0.5, q.p[1] + Math.cos(q.a) * q.len * 0.5, q.len * 0.62);
  }
  return { minX, maxX, minY, maxY };
}

/**
 * Draws the atlas (2D canvas) and returns { texture, tileMeters }.
 */
export function createLeafAtlas() {
  const ctx2d = () => {
    const c = document.createElement('canvas');
    c.width = c.height = ATLAS_SIZE;
    return c.getContext('2d', { willReadFrequently: true });
  };
  const col = ctx2d(); // r leaf brightness, g hue jitter, b twig mask
  const cov = ctx2d(); // coverage
  // Mean leaf value under the empty texels, so filtering never pulls black (or twig brown) into the leaf edges
  col.fillStyle = 'rgb(170, 128, 0)';
  col.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  for (const c of [col, cov]) {
    c.lineCap = 'round';
    c.lineJoin = 'round';
  }
  const rng = mulberry32(20261023);
  const R = (a, b) => a + (b - a) * rng();
  const sprays = buildSprays(rng);
  const tileMeters = [];

  sprays.forEach((prims, k) => {
    // Fit: attachment point at the bottom centre of the tile (the far clumps: centred), widest extent to the gutter
    const b = sprayBounds(prims);
    const [ox, oy] = tileOrigin(k);
    const room = TILE - 2 * GUTTER;
    let s, cx, by;
    if (FAR_TILES.has(k)) {
      s = room / Math.max(b.maxX - b.minX, b.maxY - b.minY);
      cx = ox + TILE / 2 - ((b.minX + b.maxX) / 2) * s;
      by = oy + TILE / 2 + ((b.minY + b.maxY) / 2) * s;
    } else {
      s = Math.min((room / 2) / Math.max(-b.minX, b.maxX), room / Math.max(b.maxY, 0.01));
      cx = ox + TILE / 2;
      by = oy + TILE - GUTTER;
    }
    tileMeters[k] = room / s;
    const X = (p) => cx + p[0] * s;
    const Y = (p) => by - p[1] * s;
    // Point (u along, v across) of a leaf from P at angle a, L long & W wide (canvas space)
    const frame = (P, a, L, W) => {
      const d = [Math.sin(a), -Math.cos(a)];
      const x0 = X(P), y0 = Y(P);
      return (u, v) => [x0 + d[0] * u * L * s - d[1] * v * W * s, y0 + d[1] * u * L * s + d[0] * v * W * s];
    };
    const ovalPath = (c, f, skew = 0) => {
      c.moveTo(...f(0, 0));
      c.bezierCurveTo(...f(0.05, 0.6 + skew), ...f(0.6, 0.62), ...f(1, 0));
      c.bezierCurveTo(...f(0.6, -0.62), ...f(0.05, -0.6 + skew), ...f(0, 0));
    };
    const halfPath = (c, f, skew = 0) => {
      c.moveTo(...f(0, 0));
      c.bezierCurveTo(...f(0.05, 0.6 + skew), ...f(0.6, 0.62), ...f(1, 0));
      c.closePath();
    };
    // Same path on both canvases: data colour on one, white coverage on the other
    const fill = (path, rgb) => {
      for (const [c, style] of [[col, rgb], [cov, '#fff']]) {
        c.beginPath();
        path(c);
        c.fillStyle = style;
        c.fill();
      }
    };
    const stroke = (pts, w0, w1, rgb) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const w = Math.max(0.8, lerp(w0, w1, i / (pts.length - 1)) * s);
        for (const [c, style] of [[col, rgb], [cov, '#fff']]) {
          c.beginPath();
          c.moveTo(X(pts[i]), Y(pts[i]));
          c.lineTo(X(pts[i + 1]), Y(pts[i + 1]));
          c.lineWidth = w;
          c.strokeStyle = style;
          c.stroke();
        }
      }
    };
    // brighter towards the sunlit outer end of the spray, a few darker or older leaves; glossy leaves vary more
    const leafRGB = (t, gloss = false) => {
      const lo = gloss ? 0.45 : 0.6, hi = gloss ? 0.98 : 0.9;
      const r = Math.min(255, Math.round(255 * R(lo, hi) * (0.8 + 0.2 * t)));
      return [r, Math.round(255 * rng())];
    };
    const rgb = (r, g, bl = 0) => `rgb(${r}, ${g}, ${bl})`;

    for (const q of prims) {
      if (q.type === 'twig') stroke(q.pts, q.w0, q.w1, rgb(110, 128, 255));
      else if (q.type === 'stalk') stroke(q.pts || [q.a, q.b], q.w, q.w * 0.7, rgb(120, 128, 150));
      else if (q.type === 'needle') {
        const [r, g] = leafRGB(q.t);
        stroke([q.a, q.b], q.w, q.w * 0.6, rgb(r, g));
      } else if (q.type === 'oval') {
        const [r, g] = leafRGB(q.t, q.gloss);
        const f = frame(q.p, q.a, q.len, q.len * q.wid);
        fill((c) => ovalPath(c, f, q.skew || 0), rgb(r, g));
        if (q.len * s > 9) {
          // one half of the blade a little darker (folded along the midrib)
          col.beginPath();
          halfPath(col, f, q.skew || 0);
          col.fillStyle = rgb(Math.round(r * 0.84), g);
          col.fill();
        }
      } else if (q.type === 'palmate') {
        // Five pointed lobes radiating from the blade centre: main, two side & two small basal ones
        const [r, g] = leafRGB(q.t);
        const L = q.len;
        const cP = [q.p[0] + Math.sin(q.a) * L * 0.22, q.p[1] + Math.cos(q.a) * L * 0.22];
        const lobes = [[0, 0.78, 0.36], [0.85, 0.62, 0.34], [-0.85, 0.62, 0.34], [1.65, 0.34, 0.36], [-1.65, 0.34, 0.36]];
        lobes.forEach(([da, ll, ww], li) => {
          const f = frame(cP, q.a + da + R(-0.08, 0.08), L * ll, L * ll * ww);
          const shade = li === 0 ? 1 : (da > 0 ? 0.88 : 0.95);
          fill((c) => ovalPath(c, f), rgb(Math.round(r * shade), g));
        });
        fill((c) => c.arc(X(cP), Y(cP), L * 0.24 * s, 0, Math.PI * 2), rgb(Math.round(r * 0.96), g));
      }
    }
  });

  // Colour data + coverage -> level 0, then a mip chain whose alpha keeps each tile's coverage
  const data = col.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const mask = cov.getImageData(0, 0, ATLAS_SIZE, ATLAS_SIZE).data;
  const level0 = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE * 4);
  for (let i = 0; i < level0.length; i += 4) {
    level0[i] = data[i];
    level0[i + 1] = data[i + 1];
    level0[i + 2] = data[i + 2];
    level0[i + 3] = mask[i + 3];
  }
  const tex = new THREE.DataTexture(level0, ATLAS_SIZE, ATLAS_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.mipmaps = coverageMips(level0, ATLAS_SIZE, ATLAS_TILES);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'DonostiaLeafAtlas';
  return { texture: tex, tileMeters };
}

// Box-filtered mip chain whose alpha is rescaled per tile so the share of texels above the alpha-test cutoff stays as
// it is at level 0 (otherwise alpha-tested foliage thins out and vanishes at distance). Odd sizes (1536 / 2^n reaches
// 3) round down; the 3 -> 1 step samples the top-left 2 x 2.
export function coverageMips(level0, size, tiles, cutoff = 128) {
  const levels = [{ data: level0, width: size, height: size }];
  const target = [];
  const tilePx = size / tiles;
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      let n = 0;
      for (let y = ty * tilePx; y < (ty + 1) * tilePx; y++) {
        for (let x = tx * tilePx; x < (tx + 1) * tilePx; x++) if (level0[(y * size + x) * 4 + 3] >= cutoff) n++;
      }
      target.push(n / (tilePx * tilePx));
    }
  }
  const meanTarget = target.reduce((a, b) => a + b, 0) / target.length;
  let src = level0, w = size;
  const hist = new Uint32Array(256);
  while (w > 1) {
    const h = w >> 1;
    const dst = new Uint8Array(h * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < h; x++) {
        const i0 = ((2 * y) * w + 2 * x) * 4, i1 = i0 + w * 4, o = (y * h + x) * 4;
        for (let c = 0; c < 4; c++) dst[o + c] = (src[i0 + c] + src[i0 + 4 + c] + src[i1 + c] + src[i1 + 4 + c] + 2) >> 2;
      }
    }
    const nt = h % tiles === 0 ? tiles : 1;
    const tp = h / nt;
    for (let ty = 0; ty < nt; ty++) {
      for (let tx = 0; tx < nt; tx++) {
        const want = (nt === tiles ? target[ty * tiles + tx] : meanTarget) * tp * tp;
        hist.fill(0);
        for (let y = ty * tp; y < (ty + 1) * tp; y++) for (let x = tx * tp; x < (tx + 1) * tp; x++) hist[dst[(y * h + x) * 4 + 3]]++;
        let acc = 0, aStar = 255;
        for (let a = 255; a >= 1; a--) {
          acc += hist[a];
          if (acc >= want) { aStar = a; break; }
        }
        const scale = cutoff / Math.max(aStar, 1);
        if (Math.abs(scale - 1) < 0.01) continue;
        for (let y = ty * tp; y < (ty + 1) * tp; y++) {
          for (let x = tx * tp; x < (tx + 1) * tp; x++) {
            const i = (y * h + x) * 4 + 3;
            dst[i] = Math.min(255, Math.round(dst[i] * scale));
          }
        }
      }
    }
    levels.push({ data: dst, width: h, height: h });
    src = dst;
    w = h;
  }
  return levels;
}
