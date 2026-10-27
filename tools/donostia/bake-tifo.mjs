// tools/donostia/bake-tifo.mjs
// usage: node tools/donostia/bake-tifo.mjs [--photo <jpg|png> [--circle cx,cy,r --credit "…" --licence "…"] [--tones 3|4]]
//                                          [--placeholder] [--preview <dir>]
// The two textures of the banner in the tifo on Anoeta's south stand (js/donostia/landmarks/anoeta-tifo.js; the design
// is js/donostia/landmarks/tifo-design.js):
// - data/donostia/tifo-banner.png (RGBA, 1024 x 512): the frame, drawn here from the design: the dark shield with its
//   white & blue edge, AITOR ZABALETA lettered above the medallion, the medallion's white ring and the gold laurel
//   round the shield, tied with a blue ribbon. Alpha is the cloth (the banner is cut to its shape). The medallion's
//   disc is left grey: the shader lays the portrait in it.
// - data/donostia/tifo-portrait.png (8-bit grey, 288 x 288): Aitor Zabaleta's portrait, the one texture to replace.
//   The disc `--circle cx,cy,r` (pixels of the photo) is cut out of a photo and turned to the banner's high-contrast
//   grey: its luma (Rec. 601), cleaned of the JPEG's ringing and blocks (a 3 x 3 median, a Gaussian of 0.6 px),
//   resampled (Catmull-Rom) to the texture, stretched between its 1st and 99th percentiles and put through an S-curve.
//   Nothing is drawn, retouched or invented: what is not in the photo stays out. --tones 3|4 posterises it instead (a
//   painted stencil's flat tones), which suits a sharp photo; on the default source, itself a small print of a
//   stencil, it breaks the face into blotches, so the default keeps the photo's own greys.
//   Without --photo the default source (SOURCE below) is read from the raw cache, where fetch.sh puts it; without it
//   there the committed portrait is kept. --photo with a copy of the default source's very bytes needs no other option.
//   --placeholder writes a plain dark disc instead: the medallion then shows the shield's field under his name.
// The photo's credit & licence go into the portrait's Copyright & Comment text chunks; give them with --credit &
// --licence for any other photo (and add them to tools/donostia/README.md). The default source's licence (CC BY-SA 4.0)
// carries over to the portrait: share-alike.
// Deterministic: no randomness, float64 throughout, a fixed order.

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HERE, RAW, encodePNG, previewDir, log } from './lib.mjs';
import { decodeJPEG } from './jpeg.mjs';

const ROOT = path.resolve(HERE, '../..');
const importJS = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { BANNER, inShield, shieldHalfWidth, mosaic, PALETTE } = await importJS('js/donostia/landmarks/tifo-design.js');
const { textWidth, textCoverage } = await importJS('js/donostia/landmarks/glyphs.js');
const { decodePNG } = await importJS('js/donostia/png.js');

const OUT_BANNER = path.join(ROOT, 'data/donostia/tifo-banner.png');
const OUT_PORTRAIT = path.join(ROOT, 'data/donostia/tifo-portrait.png');
const PREVIEW = previewDir();

// The portrait's source: the Real Sociedad fan zone's screen at the 2026 Copa del Rey final in Seville, remembering
// Aitor Zabaleta (Goiena.eus, CC BY-SA 4.0, via Wikimedia Commons). The disc is his portrait inside the screen's
// medallion, 960 x 720 px original.
const SOURCE = {
  file: path.join(RAW, 'refs/tifo/Reala_Kopa_2026_Zabaleta.jpg'),
  url: 'https://upload.wikimedia.org/wikipedia/commons/4/44/Reala_Kopa_2026_Zabaleta.jpg',
  page: 'https://commons.wikimedia.org/wiki/File:Reala_Kopa_2026_Zabaleta.jpg',
  sha256: '21cf992f47ef49186fb87c797bb54ae68f00664b3d8331eb0aac1e120bc9b952',
  circle: [544, 391, 45.5],
  credit: 'Goiena.eus (https://goiena.eus/debagoiena/1776352442099-debagoiendarrak-sevillan), via Wikimedia Commons: '
    + 'File:Reala Kopa 2026 Zabaleta.jpg (https://commons.wikimedia.org/wiki/File:Reala_Kopa_2026_Zabaleta.jpg)',
  licence: 'CC BY-SA 4.0 https://creativecommons.org/licenses/by-sa/4.0/'
};

const arg = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return null;
  const v = process.argv[at + 1];
  if (!v || v.startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
};
const PLACEHOLDER = process.argv.includes('--placeholder');
const TONE_COUNT = Number(arg('tones') ?? 0);
const CONTRAST = 0.7; // the S-curve's share in the photo's greys (--tones 0)
if (![0, 3, 4].includes(TONE_COUNT)) throw new Error('--tones is 3 or 4 (or 0: the photo\'s own greys)');

// --- small image helpers ---------------------------------------------------------------------------------------------

const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smoothstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const srgb = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];

// Catmull-Rom sample of a w x h float image at (x, y) (pixel centres at integers), edges clamped
function bicubic(img, w, h, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const k = (t) => [((-t + 2) * t - 1) * t / 2, (((3 * t - 5) * t) * t + 2) / 2, ((-3 * t + 4) * t + 1) * t / 2, ((t - 1) * t * t) / 2];
  const kx = k(fx), ky = k(fy);
  let v = 0;
  for (let j = 0; j < 4; j++) {
    const yy = Math.min(h - 1, Math.max(0, y0 - 1 + j));
    let row = 0;
    for (let i = 0; i < 4; i++) row += kx[i] * img[yy * w + Math.min(w - 1, Math.max(0, x0 - 1 + i))];
    v += ky[j] * row;
  }
  return v;
}

// --- the portrait ----------------------------------------------------------------------------------------------------

async function readImage(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xd8) { const j = decodeJPEG(buf); return { ...j, channels: 3 }; }
  const p = await decodePNG(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return p;
}

// The photo's disc (cx, cy, r) -> the portrait, S x S grey bytes (outside the disc: white). tones 0: the photo's own
// greys under a contrast curve; 3 or 4: posterised to that many tones
function stencil(img, [cx, cy, r], S, tones) {
  const { width: W, height: H, channels: C, data } = img;
  // luma of the disc's bounding box (and a margin for the filters)
  const bx0 = Math.max(0, Math.floor(cx - r) - 3), by0 = Math.max(0, Math.floor(cy - r) - 3);
  const bx1 = Math.min(W - 1, Math.ceil(cx + r) + 3), by1 = Math.min(H - 1, Math.ceil(cy + r) + 3);
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const luma = new Float64Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const k = ((by0 + y) * W + bx0 + x) * C;
    const g = C < 3 ? data[k] : 0.299 * data[k] + 0.587 * data[k + 1] + 0.114 * data[k + 2];
    luma[y * bw + x] = g / 255;
  }
  // 3 x 3 median: the JPEG's ringing and mosquito noise go, the edges stay
  const med = new Float64Array(bw * bh), win = new Float64Array(9);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let n = 0;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      win[n++] = luma[Math.min(bh - 1, Math.max(0, y + j)) * bw + Math.min(bw - 1, Math.max(0, x + i))];
    }
    win.sort();
    med[y * bw + x] = win[4];
  }
  // a light Gaussian (sigma 0.6 px, separable) over the JPEG's 8 x 8 blocks
  const G = [-1, 0, 1].map((d) => Math.exp(-(d * d) / (2 * 0.36))), gs = G[0] + G[1] + G[2];
  const tmp = new Float64Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let v = 0;
    for (let i = -1; i <= 1; i++) v += G[i + 1] * med[y * bw + Math.min(bw - 1, Math.max(0, x + i))];
    tmp[y * bw + x] = v / gs;
  }
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    let v = 0;
    for (let j = -1; j <= 1; j++) v += G[j + 1] * tmp[Math.min(bh - 1, Math.max(0, y + j)) * bw + x];
    med[y * bw + x] = v / gs;
  }
  // resample the disc to S x S, and stretch it between its 1st and 99th percentiles
  const up = new Float64Array(S * S), inside = new Uint8Array(S * S);
  const values = [];
  for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) {
    const u = ((i + 0.5) / S) * 2 - 1, v = ((j + 0.5) / S) * 2 - 1;
    const k = j * S + i;
    up[k] = bicubic(med, bw, bh, cx + u * r - bx0 - 0.5, cy + v * r - by0 - 0.5);
    if (u * u + v * v <= 1) { inside[k] = 1; values.push(up[k]); }
  }
  values.sort((a, b) => a - b);
  const q = (p) => values[Math.min(values.length - 1, Math.floor(p * values.length))];
  const lo = q(0.01), hi = q(0.99);
  for (let k = 0; k < up.length; k++) up[k] = clamp01((up[k] - lo) / Math.max(1e-6, hi - lo));
  const out = new Uint8Array(S * S).fill(255);
  if (!tones) {
    // the photo's own greys under an S-curve: the banner's high-contrast print, nothing redrawn
    for (let k = 0; k < out.length; k++) {
      const v = up[k];
      if (inside[k]) out[k] = Math.round(255 * (v + (v * v * (3 - 2 * v) - v) * CONTRAST));
    }
    log('portrait: the photo\'s greys, contrast curve ' + CONTRAST);
    return out;
  }
  // posterised: a 1-D k-means over the disc (started at evenly spread quantiles) finds the tones, each cut falls at the
  // emptiest level of the histogram between two neighbouring tones (between the photo's own tones, not through them)
  const TONES = { 3: [0.08, 0.46, 0.93], 4: [0.07, 0.33, 0.66, 0.95] }[tones], K = TONES.length, EDGE = 0.03;
  const norm = values.map((v) => clamp01((v - lo) / Math.max(1e-6, hi - lo)));
  let centres = Array.from({ length: K }, (_, i) => norm[Math.floor(((i + 0.5) / K) * norm.length)]);
  for (let it = 0; it < 40; it++) {
    const sum = new Array(K).fill(0), cnt = new Array(K).fill(0);
    for (const v of norm) {
      let best = 0;
      for (let c = 1; c < K; c++) if (Math.abs(v - centres[c]) < Math.abs(v - centres[best])) best = c;
      sum[best] += v; cnt[best]++;
    }
    centres = centres.map((c, i) => (cnt[i] ? sum[i] / cnt[i] : c)).sort((a, b) => a - b);
  }
  const BINS = 64, hist = new Float64Array(BINS);
  for (const v of norm) hist[Math.min(BINS - 1, Math.floor(v * BINS))]++;
  const smooth = hist.map((_, i) => (hist[Math.max(0, i - 1)] + 2 * hist[i] + hist[Math.min(BINS - 1, i + 1)]) / 4);
  const cuts = [];
  for (let c = 0; c + 1 < K; c++) {
    let best = -1;
    for (let i = Math.ceil(centres[c] * BINS); i < Math.floor(centres[c + 1] * BINS); i++) if (best < 0 || smooth[i] < smooth[best]) best = i;
    cuts.push(best < 0 ? (centres[c] + centres[c + 1]) / 2 : (best + 0.5) / BINS);
  }
  for (let k = 0; k < out.length; k++) {
    if (!inside[k]) continue;
    let t = TONES[0];
    for (let c = 0; c + 1 < K; c++) t += (TONES[c + 1] - TONES[c]) * smoothstep(cuts[c] - EDGE, cuts[c] + EDGE, up[k]);
    out[k] = Math.round(255 * t);
  }
  log(`portrait: ${K} tones at ${centres.map((c) => c.toFixed(2)).join(', ')}, cuts ${cuts.map((c) => c.toFixed(2)).join(', ')}`);
  return out;
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function bakePortrait() {
  const S = BANNER.portraitSize;
  const photo = arg('photo');
  let pixels, text;
  if (PLACEHOLDER) {
    pixels = new Uint8Array(S * S).fill(26);
    text = {
      Comment: 'Slop Donostia: the placeholder for Aitor Zabaleta\'s portrait on the tifo\'s banner (a dark disc); '
        + 'tools/donostia/bake-tifo.mjs --photo makes the portrait from a photo'
    };
  } else {
    const file = photo ? path.resolve(photo) : SOURCE.file;
    if (!fs.existsSync(file)) {
      if (photo) throw new Error(`no such photo: ${file}`);
      log(`tifo-portrait.png kept: no ${path.relative(ROOT, SOURCE.file)} (fetch.sh downloads it from ${SOURCE.url})`);
      return null;
    }
    // the default source, wherever it is (a copy of its very bytes), needs no options
    const known = sha256(file) === SOURCE.sha256;
    const opt = (name, fallback) => arg(name) ?? (known ? fallback : null);
    const circle = (opt('circle', SOURCE.circle.join(',')) || '').split(',').map(Number);
    if (circle.length !== 3 || !circle.every(Number.isFinite)) throw new Error('--circle cx,cy,r (pixels of the photo) is needed with --photo');
    const credit = opt('credit', SOURCE.credit), licence = opt('licence', SOURCE.licence);
    if (!credit || !licence) throw new Error('--credit and --licence are needed with --photo: the portrait carries them');
    pixels = stencil(await readImage(file), circle, S, TONE_COUNT);
    text = {
      Copyright: `${credit} (${licence})`.replace(/[^\x20-\xff]/g, '?'),
      Comment: `Slop Donostia: Aitor Zabaleta's portrait for the tifo's banner: the disc (${circle.join(', ')}) of the `
        + `source photo, in greys (${TONE_COUNT ? `${TONE_COUNT} tones` : 'its own, contrast curve'}), by `
        + 'tools/donostia/bake-tifo.mjs; licence as in Copyright (share-alike)'
    };
  }
  fs.writeFileSync(OUT_PORTRAIT, encodePNG(pixels, S, S, 1, text));
  log(`${path.relative(ROOT, OUT_PORTRAIT)}: ${S} x ${S}${PLACEHOLDER ? ' (placeholder)' : ''}`);
  return pixels;
}

// --- the banner's frame ----------------------------------------------------------------------------------------------

const COL = {
  field: srgb(0x101218), // the shield
  white: srgb(0xf0efe9),
  blue: srgb(0x0a5aa6), // the edge's keyline, the medallion's outer ring, the ribbon
  gold: srgb(0xe0ad36), goldShade: srgb(0xbb8622), goldDark: srgb(0x7a5210),
  disc: srgb(0x808080) // under the portrait
};

// The laurel: a branch each side up the shield's flanks from its point, leaves in pairs along it
function laurel() {
  const { shield: s } = BANNER;
  const leaves = [], stems = [];
  const K = 12, y0 = s.bottom + 0.35, y1 = s.top - 4.4;
  for (const side of [-1, 1]) {
    const at = (tau) => {
      const y = y0 + (y1 - y0) * tau;
      const off = 0.75 + 0.65 * Math.min(1, tau * 3);
      return [s.cx + side * (shieldHalfWidth(Math.max(y, s.bottom + 0.05)) + off), y];
    };
    const pts = [];
    for (let i = 0; i <= 60; i++) pts.push(at(i / 60));
    stems.push(pts);
    for (let k = 0; k < K; k++) {
      for (const lean of [1, -1]) {
        // the outer leaves (away from the shield) and the inner ones alternate along the branch, all sweeping towards
        // its tip
        const tau = (k + (lean > 0 ? 0.3 : 0.8)) / K;
        const [px, py] = at(tau), [qx, qy] = at(Math.min(1, tau + 0.01));
        const ang = Math.atan2(qy - py, qx - px);
        const size = 1 - 0.3 * tau;
        leaves.push({ x: px, y: py, a: ang + lean * side * -0.5, L: 2.5 * size, W: 1.15 * size, flip: lean });
      }
    }
    const [tx, ty] = at(1), [sx, sy] = at(0.985);
    leaves.push({ x: tx, y: ty, a: Math.atan2(ty - sy, tx - sx), L: 1.7, W: 0.7, flip: 1 });
  }
  // bounding boxes, for the rasteriser
  for (const l of leaves) {
    const ex = l.x + Math.cos(l.a) * l.L, ey = l.y + Math.sin(l.a) * l.L;
    l.box = [Math.min(l.x, ex) - l.W, Math.min(l.y, ey) - l.W, Math.max(l.x, ex) + l.W, Math.max(l.y, ey) + l.W];
  }
  return { leaves, stems };
}

// distance from (x, y) to a polyline
function polyDist(pts, x, y) {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], dx = bx - ax, dy = by - ay;
    const t = clamp01(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1e-12));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function bakeBanner() {
  const { texW: W, texH: H, width: BW, height: BH, medallion: m, name, shield } = BANNER;
  const { leaves, stems } = laurel();
  const nameCover = textCoverage(name.text);
  const nameW = textWidth(name.text) * name.cap, nameX0 = BANNER.shield.cx - nameW / 2;
  const EDGE = 0.36, KEY = 0.16; // the shield's white edge and the blue keyline inside it
  const ribbon = { cx: shield.cx, cy: shield.bottom + 0.15, w: 1.5, h: 0.55 };

  // one sample: [r, g, b] or null (no cloth)
  const sample = (x, y) => {
    // the laurel, over everything else
    for (const l of leaves) {
      if (x < l.box[0] || y < l.box[1] || x > l.box[2] || y > l.box[3]) continue;
      const dx = x - l.x, dy = y - l.y, ca = Math.cos(l.a), sa = Math.sin(l.a);
      const a = dx * ca + dy * sa, b = -dx * sa + dy * ca;
      if (a < 0 || a > l.L) continue;
      const half = (l.W / 2) * Math.pow(Math.sin((Math.PI * a) / l.L), 0.75);
      if (Math.abs(b) > half) continue;
      if (Math.abs(b) < 0.05 + 0.03 * (1 - a / l.L) || Math.abs(b) > half - 0.07) return COL.goldDark;
      return b * l.flip > 0 ? COL.gold : COL.goldShade;
    }
    // the ribbon tying the branches under the shield's point
    if (Math.abs(x - ribbon.cx) < ribbon.w && Math.abs(y - ribbon.cy) < ribbon.h * (0.55 + 0.45 * Math.abs(x - ribbon.cx) / ribbon.w)) {
      return Math.abs(y - ribbon.cy) < 0.1 ? COL.white : COL.blue;
    }
    for (const pts of stems) if (polyDist(pts, x, y) < 0.13) return COL.goldDark;
    if (!inShield(x, y, EDGE)) return null;
    if (!inShield(x, y)) return COL.white;
    if (!inShield(x, y, -KEY)) return COL.blue;
    // the medallion: white ring, blue ring, the disc
    const d = Math.hypot(x - m.cx, y - m.cy);
    if (d <= m.r) return COL.disc;
    if (d <= m.r + m.ring) return COL.white;
    if (d <= m.r + m.ring + 0.2) return COL.blue;
    // the name
    if (y >= name.base - 0.05 && y <= name.base + name.cap + 0.05 && nameCover((x - nameX0) / name.cap, (y - name.base) / name.cap)) return COL.white;
    return COL.field;
  };

  const SS = 3, px = new Uint8Array(W * H * 4);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      // image row 0 is the banner's top (the back of the tier)
      const x = ((i + (si + 0.5) / SS) / W) * BW, y = (1 - (j + (sj + 0.5) / SS) / H) * BH;
      const c = sample(x, y);
      if (!c) continue;
      r += c[0]; g += c[1]; b += c[2]; n++;
    }
    const k = (j * W + i) * 4;
    if (n) { px[k] = Math.round(r / n); px[k + 1] = Math.round(g / n); px[k + 2] = Math.round(b / n); }
    px[k + 3] = Math.round((255 * n) / (SS * SS));
  }
  // bleed the edge colours outwards under the transparent texels (their coverage stays 0), so the mipmaps and the
  // filtering at the cut keep no dark fringe
  const filled = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) filled[k] = px[k * 4 + 3] > 0 ? 1 : 0;
  for (let pass = 0; pass < 8; pass++) {
    const was = filled.slice();
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = j * W + i;
      if (was[k]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= W || jj >= H || !was[jj * W + ii]) continue;
        const kk = (jj * W + ii) * 4;
        r += px[kk]; g += px[kk + 1]; b += px[kk + 2]; n++;
      }
      if (!n) continue;
      px[k * 4] = Math.round(r / n); px[k * 4 + 1] = Math.round(g / n); px[k * 4 + 2] = Math.round(b / n);
      filled[k] = 1;
    }
  }
  return px;
}

// --- previews: the banner with its portrait, and the card mosaic ------------------------------------------------------

function writePreviews(banner, portrait) {
  const { texW: W, texH: H, width: BW, height: BH, medallion: m } = BANNER;
  const S = BANNER.portraitSize;
  const rgb = new Uint8Array(W * H * 3);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = j * W + i, a = banner[k * 4 + 3] / 255;
    const x = ((i + 0.5) / W) * BW, y = (1 - (j + 0.5) / H) * BH;
    let c = [banner[k * 4], banner[k * 4 + 1], banner[k * 4 + 2]];
    const d = Math.hypot(x - m.cx, y - m.cy) / m.r;
    if (d < 1 && portrait) {
      const pu = ((x - m.cx) / m.r + 1) / 2, pv = (1 - (y - m.cy) / m.r) / 2;
      const g = portrait[Math.min(S - 1, Math.floor(pv * S)) * S + Math.min(S - 1, Math.floor(pu * S))];
      c = [g, g, g];
    }
    for (let ch = 0; ch < 3; ch++) rgb[k * 3 + ch] = Math.round(c[ch] * a + 70 * (1 - a));
  }
  fs.writeFileSync(path.join(PREVIEW, 'tifo-banner-preview.png'), encodePNG(rgb, W, H, 3));
  // the mosaic at one pixel per card, as from the pitch (the tier ~5.75 times as wide as tall)
  const MW = 280, MH = 40, design = mosaic(5.75);
  const mos = new Uint8Array(MW * MH * 3);
  const toS = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    const c = PALETTE[design((i + 0.5) / MW, 1 - (j + 0.5) / MH)];
    for (let ch = 0; ch < 3; ch++) mos[(j * MW + i) * 3 + ch] = toS(c[ch]);
  }
  fs.writeFileSync(path.join(PREVIEW, 'tifo-mosaic-preview.png'), encodePNG(mos, MW, MH, 3));
  log(`previews in ${PREVIEW}`);
}

// --- main --------------------------------------------------------------------------------------------------------------

const banner = bakeBanner();
fs.writeFileSync(OUT_BANNER, encodePNG(banner, BANNER.texW, BANNER.texH, 4, {
  Comment: 'Slop Donostia: the frame of the banner in the tifo on Anoeta\'s south stand (shield, name, medallion, laurel), '
    + 'drawn by tools/donostia/bake-tifo.mjs from js/donostia/landmarks/tifo-design.js; alpha: the cloth'
}));
log(`${path.relative(ROOT, OUT_BANNER)}: ${BANNER.texW} x ${BANNER.texH}`);
let portrait = await bakePortrait();
if (PREVIEW) {
  if (!portrait && fs.existsSync(OUT_PORTRAIT)) {
    const b = fs.readFileSync(OUT_PORTRAIT), p = await decodePNG(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    portrait = p.data;
  }
  writePreviews(banner, portrait);
}
