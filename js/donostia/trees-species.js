import * as THREE from 'three/webgpu';
import { ATLAS_SIZE, TILE, GUTTER, TILE_FAR, tileOrigin, mulberry32 } from './trees-atlas.js';

// js/donostia/trees-species.js
// Donostia's trees grown from seeded per-species rules, adapted from js/trees.js (slop-newyork, MIT: SPECIES,
// growTree, addTube, addCard, makeCrown, placeCards, buildTreeGeometries):
// - a flared trunk / leader carrying scaffold limbs, branches and twigs as tapered, curving bark tubes (uv in metres
//   for the bark shader); tamarisks lean and their trunks & limbs are knotted and twisted
// - leaf sprays on alpha-tested cards hung from the twigs, cut from the leaf atlas (js/donostia/trees-atlas.js)
// - palms grown apart: a ringed trunk under a crown of arching fronds (cards bent in three)
// - crown-shell normals, interior occlusion & sway weights baked per vertex (attribute aTree, read by
//   js/donostia/trees-material.js)
// Two levels of detail per species & variant (near: every twig; mid: cards along the branches) and one parametric
// far tree shared by all species (a prism trunk under a shell of whole-crown cards, shaped per instance).

const V3 = THREE.Vector3;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// =====================================================================================================================
// SPECIES (ids shared with tools/donostia/bake-streetscape.mjs): trunk / leader (radius, top, lean, wander = how much
// it twists, gnarl = knots round its girth), scaffold limbs (count, heights up the leader, tilt off vertical and
// length blended from the lowest to the highest limb), branches & twigs (count, span along the parent, angle off it,
// length as a share of the parent or in metres), bending per metre (up: toward the sky, out: away from the trunk,
// droop: down, growing toward the tips), leaf cards per twig (scale, droop), per-tree foliage tints (sRGB), the bark
// (0 furrowed, 1 plane camouflage, 2 tamarisk, 3 smooth grey, 4 pine plates, 5 palm leaf bases) and the far tile.
// Scale 1 is a mature park tree; street trees are planted smaller. The trees are in spring leaf: the deciduous ones
// full and fresh light green, twigged densely enough that their near crowns read as full as the far ones; the
// evergreens & pines darker.
// =====================================================================================================================
export const SPECIES = [
  { // 0: London plane (Boulevard, Libertad, Easo, the ensanche): tall clear trunk, heavy ascending limbs, broad crown
    name: 'plane', tile: 0, bark: 1, far: TILE_FAR.broadleaf,
    trunk: { r: 0.3, top: 8.6, lean: 0.04, segs: 8 },
    limbs: { n: 6, y: [3.4, 7.4], tilt: [1.0, 0.36], len: [4.6, 2.8], r: 0.62, up: 0.07, out: 0, droop: 0, jitter: 0.07, segs: 6 },
    branches: { n: 6, t: [0.3, 0.98], angle: [0.55, 0.95], len: [0.62, 0.42], up: 0.06, out: 0.02, droop: 0, jitter: 0.1, segs: 4 },
    twigs: { n: 4, t: [0.3, 1.0], angle: [0.6, 1.05], len: [1.15, 0.75], up: 0.02, out: 0, droop: 0.04, jitter: 0.12, segs: 2 },
    cards: { perTwig: 2, scale: [0.85, 1.1], droop: 0.05 },
    tints: [0x5c862b, 0x699331, 0x507827]
  },
  { // 1: Tamarisk (La Concha, Ondarreta, Alderdi Eder): a short, leaning, knotted trunk forking low into twisting limbs
    // that spread into a low umbrella of weeping, feathery grey-green plumes
    name: 'tamarisk', tile: 1, bark: 2, far: TILE_FAR.feathery,
    trunk: { r: 0.3, top: 2.9, lean: 0.34, segs: 6, wander: 0.2, gnarl: 0.2 },
    limbs: { n: 6, y: [2.0, 2.9], tilt: [1.12, 0.7], len: [4.2, 3.2], r: 0.72, up: 0.09, out: 0.02, droop: 0.05, jitter: 0.3, segs: 7, gnarl: 0.14 },
    branches: { n: 5, t: [0.25, 1.0], angle: [0.45, 0.95], len: [0.5, 0.36], up: 0.05, out: 0.02, droop: 0.05, jitter: 0.26, segs: 4 },
    twigs: { n: 4, t: [0.25, 1.0], angle: [0.45, 0.95], len: [0.95, 0.65], up: 0, out: 0, droop: 0.12, jitter: 0.16, segs: 2 },
    cards: { perTwig: 3, scale: [1.05, 1.35], droop: 0.28 },
    tints: [0x6e8852, 0x7b965b, 0x627b4a]
  },
  { // 2: Lime & broadleaf (side streets, gardens, the hill woods' oaks, chestnuts & ashes): an ovoid crown
    name: 'broadleaf', tile: 2, bark: 0, far: TILE_FAR.broadleaf,
    trunk: { r: 0.27, top: 6.8, lean: 0.03, segs: 7 },
    limbs: { n: 7, y: [2.8, 6.4], tilt: [1.0, 0.32], len: [4.0, 2.2], r: 0.6, up: 0.08, out: 0, droop: 0, jitter: 0.09, segs: 6 },
    branches: { n: 5, t: [0.3, 0.98], angle: [0.5, 0.9], len: [0.6, 0.42], up: 0.05, out: 0.02, droop: 0.01, jitter: 0.1, segs: 4 },
    twigs: { n: 4, t: [0.3, 1.0], angle: [0.55, 1.0], len: [1.1, 0.75], up: 0.01, out: 0, droop: 0.06, jitter: 0.12, segs: 2 },
    cards: { perTwig: 2, scale: [0.85, 1.1], droop: 0.12 },
    tints: [0x537d2b, 0x608c31, 0x486f27]
  },
  { // 3: Magnolia & holm oak (gardens, Urgull): a short trunk under a dense, rounded, dark evergreen crown
    name: 'evergreen', tile: 3, bark: 3, far: TILE_FAR.broadleaf,
    trunk: { r: 0.28, top: 3.6, lean: 0.06, segs: 6, wander: 0.05 },
    limbs: { n: 8, y: [1.9, 3.5], tilt: [1.05, 0.4], len: [3.6, 2.6], r: 0.62, up: 0.09, out: 0, droop: 0, jitter: 0.12, segs: 6 },
    branches: { n: 4, t: [0.3, 1.0], angle: [0.5, 0.95], len: [0.55, 0.4], up: 0.06, out: 0.02, droop: 0, jitter: 0.12, segs: 4 },
    twigs: { n: 3, t: [0.3, 1.0], angle: [0.5, 1.0], len: [0.9, 0.6], up: 0.02, out: 0, droop: 0.04, jitter: 0.12, segs: 2 },
    cards: { perTwig: 3, scale: [0.85, 1.1], droop: 0.06 },
    tints: [0x2c4a22, 0x35532a, 0x284020]
  },
  { // 4: Maritime & Monterey pine (Igeldo, Ulía, Aiete): a tall bare stem under a flat-topped, irregular crown
    name: 'pine', tile: 4, bark: 4, far: TILE_FAR.conifer,
    trunk: { r: 0.3, top: 15, lean: 0.07, segs: 9, wander: 0.05 },
    limbs: { n: 9, y: [9.0, 14.2], tilt: [1.3, 0.55], len: [4.4, 1.8], r: 0.42, up: 0.12, out: 0, droop: 0, jitter: 0.12, segs: 5 },
    branches: { n: 4, t: [0.35, 1.0], angle: [0.6, 1.1], len: [0.55, 0.38], up: 0.1, out: 0.02, droop: 0, jitter: 0.14, segs: 3 },
    twigs: { n: 3, t: [0.4, 1.0], angle: [0.5, 0.9], len: [0.9, 0.6], up: 0.08, out: 0, droop: 0, jitter: 0.12, segs: 2 },
    cards: { perTwig: 2, scale: [0.9, 1.15], droop: -0.15 },
    tints: [0x3a5030, 0x435a37, 0x32482a]
  },
  { // 5: Canary Island date palm (gardens, the seafront): a thick ringed trunk under a ball of arching fronds
    name: 'palm', tile: 5, bark: 5, far: TILE_FAR.feathery, palm: { height: 7.5, r: 0.36, fronds: 34, length: 4.2 },
    tints: [0x5b7334, 0x66803a, 0x4f672e]
  }
];

// =====================================================================================================================
// SKELETON
// =====================================================================================================================

// Unit vector `angle` off `dir`, turned `azimuth` round it
function deflect(dir, angle, azimuth) {
  const ref = Math.abs(dir.y) < 0.95 ? new V3(0, 1, 0) : new V3(1, 0, 0);
  const u = new V3().crossVectors(dir, ref).normalize();
  const w = new V3().crossVectors(dir, u);
  return dir.clone().multiplyScalar(Math.cos(angle))
    .addScaledVector(u, Math.sin(angle) * Math.cos(azimuth))
    .addScaledVector(w, Math.sin(angle) * Math.sin(azimuth))
    .normalize();
}

// A branch as a polyline from p0 along dir, len metres in segs steps (or at the given length fractions), bending per
// metre toward the sky (up), away from the trunk axis (out) and downward toward its tip (droop), with some wander
function growBranch(p0, dir, len, r0, r1, segs, bend, rng, level, schedule = null) {
  const ts = schedule || Array.from({ length: segs + 1 }, (_, i) => i / segs);
  const pts = [p0.clone()];
  const rad = [r0];
  const d = dir.clone();
  const p = p0.clone();
  const out = new V3();
  for (let i = 1; i < ts.length; i++) {
    const t = ts[i];
    const step = (t - ts[i - 1]) * len;
    out.set(p.x, 0, p.z);
    if (out.lengthSq() > 1e-6) out.normalize();
    d.x += out.x * bend.out * step + (rng() - 0.5) * bend.jitter;
    d.y += (bend.up - bend.droop * t * 2.0) * step + (rng() - 0.5) * bend.jitter * 0.6;
    d.z += out.z * bend.out * step + (rng() - 0.5) * bend.jitter;
    d.normalize();
    p.addScaledVector(d, step);
    pts.push(p.clone());
    rad.push(r0 + (r1 - r0) * Math.pow(t, 0.8));
  }
  return { pts, rad, len, level, ts, gnarl: bend.gnarl || 0 };
}

// Point, direction & radius at length fraction t of a branch
function along(b, t) {
  const ts = b.ts;
  let i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  const k = Math.min(1, Math.max(0, (t - ts[i]) / (ts[i + 1] - ts[i])));
  return {
    p: b.pts[i].clone().lerp(b.pts[i + 1], k),
    d: b.pts[i + 1].clone().sub(b.pts[i]).normalize(),
    r: lerp(b.rad[i], b.rad[i + 1], k)
  };
}

function growTree(sp, seed) {
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const branches = [];

  // Trunk & leader: leaning, flaring at the root (dense rings at the base), tapering to a slim top
  const T = sp.trunk;
  const still = { up: 0, out: 0, droop: 0, jitter: T.wander ?? 0.025, gnarl: T.gnarl || 0 };
  const lean = R(0, Math.PI * 2);
  const trunkDir = new V3(Math.cos(lean) * T.lean, 1, Math.sin(lean) * T.lean).normalize();
  const schedule = [0, 0.03, 0.08];
  for (let i = 1; i <= T.segs; i++) schedule.push(0.08 + (0.92 * i) / T.segs);
  const trunk = growBranch(new V3(0, 0, 0), trunkDir, T.top, T.r, T.r * 0.3, T.segs, still, rng, 0, schedule);
  trunk.rad = trunk.rad.map((r, i) => r * (1 + 0.75 * Math.exp(-(trunk.ts[i] * T.top) / 0.28)));
  branches.push(trunk);

  // Scaffold limbs spiralling up the leader by the golden angle; branches along each limb; twigs along each branch
  const L = sp.limbs, B = sp.branches, W = sp.twigs;
  let az = R(0, Math.PI * 2);
  for (let i = 0; i < L.n; i++) {
    const f = L.n > 1 ? i / (L.n - 1) : 0;
    const y = lerp(L.y[0], L.y[1], f) + R(-0.25, 0.25);
    const base = along(trunk, Math.min(0.98, y / T.top));
    az += 2.39996 + R(-0.35, 0.35);
    const tilt = lerp(L.tilt[0], L.tilt[1], f) + R(-0.08, 0.08);
    const dir = new V3(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
    const len = lerp(L.len[0], L.len[1], f) * R(0.88, 1.1);
    const limb = growBranch(base.p, dir, len, base.r * L.r, 0.035, L.segs, L, rng, 1);
    branches.push(limb);

    const nb = B.n + (rng() < 0.5 ? 1 : 0);
    let baz = R(0, Math.PI * 2);
    for (let j = 0; j < nb; j++) {
      const bt = lerp(B.t[0], B.t[1], (j + R(0.15, 0.85)) / nb);
      const a = along(limb, bt);
      baz += 2.39996 + R(-0.4, 0.4);
      const bdir = deflect(a.d, R(B.angle[0], B.angle[1]), baz);
      const outw = new V3(a.p.x, 0, a.p.z).normalize();
      if (bdir.dot(outw) < -0.15) bdir.addScaledVector(outw, 0.7).normalize(); // keep out of the crown core
      const blen = len * lerp(B.len[0], B.len[1], bt) * R(0.85, 1.12);
      const br = growBranch(a.p, bdir, blen, Math.max(0.022, a.r * 0.62), 0.014, B.segs, B, rng, 2);
      branches.push(br);

      const nw = W.n + (rng() < 0.4 ? 1 : 0);
      let taz = R(0, Math.PI * 2);
      for (let k = 0; k < nw; k++) {
        const tt = lerp(W.t[0], W.t[1], (k + R(0.2, 0.8)) / nw);
        const ta = along(br, tt);
        taz += 2.39996 + R(-0.5, 0.5);
        const tdir = deflect(ta.d, R(W.angle[0], W.angle[1]), taz);
        branches.push(growBranch(ta.p, tdir, lerp(W.len[0], W.len[1], tt) * R(0.8, 1.2), Math.max(0.012, ta.r * 0.7), 0.006, W.segs, W, rng, 3));
      }
    }
  }
  return branches;
}

// =====================================================================================================================
// GEOMETRY
// =====================================================================================================================
class TreeGeometryBuilder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.attr = [];
    this.idx = [];
  }

  vertex(p, n, u, v, leaf, ao, sway, rnd) {
    this.pos.push(p.x, p.y, p.z);
    this.nrm.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.attr.push(leaf, ao, sway, rnd);
    return this.pos.length / 3 - 1;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aTree', new THREE.Float32BufferAttribute(this.attr, 4));
    const vCount = this.pos.length / 3;
    g.setIndex(vCount > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}

// Tapered tube along a branch with parallel-transported rings (every `stride`-th skeleton point); uv in metres.
// A gnarled branch bulges in knots that wind round and along it.
function addTube(gb, b, radial, stride, aoAt, swayAt) {
  const n = b.pts.length;
  const keep = [];
  for (let i = 0; i < n; i += stride) keep.push(i);
  if (keep[keep.length - 1] !== n - 1) keep.push(n - 1);
  const tangent = (i) => b.pts[Math.min(n - 1, i + 1)].clone().sub(b.pts[Math.max(0, i - 1)]).normalize();
  let T = tangent(keep[0]);
  const N = Math.abs(T.y) < 0.9 ? new V3(0, 1, 0).cross(T).normalize() : new V3(1, 0, 0).cross(T).normalize();
  const q = new THREE.Quaternion();
  const around = 2 * Math.PI * Math.max(b.rad[0], 0.02);
  let vLen = 0;
  const base = gb.pos.length / 3;
  const dir = new V3(), p = new V3();
  const phase = b.pts[0].x * 3.1 + b.pts[0].z * 1.7;
  keep.forEach((i, ki) => {
    if (ki > 0) {
      const T2 = tangent(i);
      q.setFromUnitVectors(T, T2);
      N.applyQuaternion(q).normalize();
      T = T2;
      vLen += b.pts[i].distanceTo(b.pts[keep[ki - 1]]);
    }
    const Bn = new V3().crossVectors(T, N);
    const t = b.ts[i];
    const ao = aoAt(b.pts[i]);
    const sway = swayAt(b, t);
    for (let j = 0; j <= radial; j++) {
      const ang = (j / radial) * Math.PI * 2;
      dir.copy(N).multiplyScalar(Math.cos(ang)).addScaledVector(Bn, Math.sin(ang));
      const knot = b.gnarl ? 1 + b.gnarl * (0.6 * Math.sin(3 * ang + vLen * 2.3 + phase) + 0.4 * Math.sin(5 * ang - vLen * 4.1 + phase * 1.3)) : 1;
      p.copy(b.pts[i]).addScaledVector(dir, b.rad[i] * knot);
      gb.vertex(p, dir, (j / radial) * around, vLen, 0, ao, sway, 0);
    }
  });
  // Rings run counter-clockwise round the tangent, so (a, a + 1, c) is counter-clockwise seen from outside: the front
  // faces point out along the normals (the material drops the bark's back faces)
  for (let k = 0; k < keep.length - 1; k++) {
    for (let j = 0; j < radial; j++) {
      const a = base + k * (radial + 1) + j, c = a + radial + 1;
      gb.idx.push(a, a + 1, c, a + 1, c + 1, c);
    }
  }
}

// uv rectangle of atlas tile k (u0 < u1, vTop < vBot: canvas rows run down)
function tileUV(k) {
  const [ox, oy] = tileOrigin(k);
  return { u0: (ox + GUTTER) / ATLAS_SIZE, u1: (ox + TILE - GUTTER) / ATLAS_SIZE, vTop: (oy + GUTTER) / ATLAS_SIZE, vBot: (oy + TILE - GUTTER) / ATLAS_SIZE };
}

// Leaf card: bottom edge centred on `at`, rising along `up`, facing `face`; uv over atlas tile `tile` (mirrored or not)
function addCard(gb, at, up, face, size, tile, mirror, rnd, crown) {
  const side = new V3().crossVectors(up, face).normalize();
  const nrm = new V3().crossVectors(side, up).normalize();
  let { u0, u1 } = tileUV(tile);
  const { vTop, vBot } = tileUV(tile);
  if (mirror) [u0, u1] = [u1, u0];
  const corners = [[-0.5, 0, u0, vBot], [0.5, 0, u1, vBot], [0.5, 1, u1, vTop], [-0.5, 1, u0, vTop]];
  const base = gb.pos.length / 3;
  const p = new V3();
  for (const [sx, sy, u, v] of corners) {
    p.copy(at).addScaledVector(side, sx * size).addScaledVector(up, sy * size);
    const { n, ao } = crown.shade(p, nrm);
    gb.vertex(p, n, u, v, 1, ao, lerp(0.8, 1.0, sy), rnd);
  }
  gb.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

// A frond: a card bent along `pts` (from the stalk to the tip), `width` wide across `side`; the tile's full height is
// spread over the bends
function addFrond(gb, pts, side, width, tile, mirror, rnd, crown) {
  let { u0, u1 } = tileUV(tile);
  const { vTop, vBot } = tileUV(tile);
  if (mirror) [u0, u1] = [u1, u0];
  const base = gb.pos.length / 3;
  const p = new V3(), seg = new V3();
  let total = 0;
  for (let k = 1; k < pts.length; k++) total += pts[k].distanceTo(pts[k - 1]);
  let acc = 0;
  pts.forEach((c, k) => {
    if (k > 0) acc += c.distanceTo(pts[k - 1]);
    const f = acc / total;
    seg.copy(pts[Math.min(pts.length - 1, k + 1)]).sub(pts[Math.max(0, k - 1)]).normalize();
    const nrm = new V3().crossVectors(side, seg).normalize();
    for (const [sx, u] of [[-0.5, u0], [0.5, u1]]) {
      p.copy(c).addScaledVector(side, sx * width);
      const { n, ao } = crown.shade(p, nrm);
      gb.vertex(p, n, u, lerp(vBot, vTop, f), 1, ao, lerp(0.75, 1.0, f), rnd);
    }
  });
  for (let k = 0; k < pts.length - 1; k++) {
    const a = base + 2 * k;
    gb.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
}

// Crown ellipsoid (from the foliage) for shell normals & interior occlusion
function makeCrown(points) {
  const box = new THREE.Box3().setFromPoints(points);
  const C = box.getCenter(new V3());
  const Rr = box.getSize(new V3()).multiplyScalar(0.5).max(new V3(0.5, 0.5, 0.5));
  const tmp = new V3(), sn = new V3();
  return {
    C,
    R: Rr,
    bottom: box.min.y,
    top: box.max.y,
    // Shell normal (out from the centre, a little skyward) blended with the card face (turned to agree with it)
    shade(p, face) {
      tmp.copy(p).sub(C).divide(Rr);
      const e = tmp.length();
      sn.copy(tmp).normalize();
      sn.y += 0.22;
      sn.normalize();
      const f = face.dot(sn) < 0 ? face.clone().negate() : face.clone();
      const n = sn.clone().multiplyScalar(0.72).addScaledVector(f, 0.28).normalize();
      const top = Math.min(1, Math.max(-1, (p.y - C.y) / Rr.y));
      const ao = (0.22 + 0.78 * smooth(0.15, 1.0, e)) * (0.86 + 0.14 * top);
      return { n, ao };
    },
    // Bark: open below the crown, darker the deeper inside it
    barkAO(p) {
      if (p.y < box.min.y) return 0.9;
      tmp.copy(p).sub(C).divide(Rr);
      return lerp(0.32, 0.8, smooth(0.2, 1.0, tmp.length()));
    }
  };
}

// Sway weight along the hierarchy: 0 on the trunk (whole-tree bend is height based), rising to 1 at the twig tips
function swayWeight(b, t) {
  switch (b.level) {
    case 0: return 0;
    case 1: return 0.18 * t;
    case 2: return 0.18 + 0.4 * t;
    default: return 0.58 + 0.4 * t;
  }
}

// Share of the near level's card area the mid level's cards carry (see buildTreeGeometries): measured to give both
// levels the same leaf coverage seen from round the crown
const MID_CARD_AREA = 0.7;

// Leaf cards of one tree: near level on every twig, mid level fewer & larger along the branches
function placeCards(sp, branches, lod, tileMeters, rng, crown) {
  const R = (a, b) => a + (b - a) * rng();
  const cards = [];
  const outward = (p) => new V3(p.x - crown.C.x, (p.y - crown.C.y) * 0.6, p.z - crown.C.z).normalize();
  const orient = (p, d, droop) => {
    const o = outward(p);
    const up = d.clone().multiplyScalar(0.55).addScaledVector(o, 0.45).add(new V3(R(-0.3, 0.3), R(-0.2, 0.3), R(-0.3, 0.3)));
    up.y -= droop;
    up.normalize();
    let face = o.clone().add(new V3(R(-0.9, 0.9), R(-0.6, 0.9), R(-0.9, 0.9))).normalize();
    face.addScaledVector(up, -face.dot(up));
    if (face.lengthSq() < 1e-4) face = new V3(0, 1, 0).cross(up);
    return { up, face: face.normalize() };
  };
  const size = tileMeters[sp.tile];
  if (lod === 0) {
    for (const b of branches) {
      if (b.level !== 3) continue;
      const n = sp.cards.perTwig;
      for (let k = 0; k < n; k++) {
        const a = along(b, lerp(0.4, 1.0, (k + R(0.3, 0.9)) / n));
        const { up, face } = orient(a.p, a.d, sp.cards.droop);
        cards.push({ at: a.p, up, face, size: size * R(sp.cards.scale[0], sp.cards.scale[1]) });
      }
    }
    // a card at the end of every branch fills the gap between its twigs
    for (const b of branches) {
      if (b.level !== 2) continue;
      const a = along(b, 1);
      const { up, face } = orient(a.p, a.d, sp.cards.droop);
      cards.push({ at: a.p, up, face, size: size * R(0.9, 1.1) });
    }
  } else {
    for (const b of branches) {
      if (b.level !== 2) continue;
      for (const t of [0.42, 0.72, 1.0]) {
        const a = along(b, Math.min(1, t + R(-0.06, 0.04)));
        const { up, face } = orient(a.p, a.d, sp.cards.droop);
        const at = a.p.clone().addScaledVector(outward(a.p), 0.35);
        cards.push({ at, up, face, size: size * R(1.35, 1.6) });
      }
    }
  }
  return cards;
}

// Palm: a slightly curving trunk swelling at the crown, and fronds springing from its top in rings, the upper ones
// steep, the lower ones arching down past the horizontal (old fronds, the gardeners prune the dead ones)
function buildPalm(sp, variant, lod, tileMeters) {
  const P = sp.palm;
  const seed = 7919 * (SPECIES.indexOf(sp) + 1) + 104729 * (variant + 1);
  const rng = mulberry32(seed);
  const R = (a, b) => a + (b - a) * rng();
  const lean = R(0, Math.PI * 2), leanAmt = R(0.02, 0.06);
  const H = P.height * R(0.92, 1.08);
  const trunkPts = [], trunkRad = [], ts = [];
  const segs = lod === 0 ? 10 : 5;
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    trunkPts.push(new V3(Math.cos(lean) * leanAmt * H * t * t, H * t, Math.sin(lean) * leanAmt * H * t * t));
    // a swollen base and a fat crown shaft
    trunkRad.push(P.r * (1 + 0.5 * Math.exp(-t * H / 0.5) + 0.25 * smooth(0.8, 1.0, t)));
    ts.push(t);
  }
  const trunk = { pts: trunkPts, rad: trunkRad, ts, len: H, level: 0, gnarl: 0 };
  const top = trunkPts[segs];

  const count = lod === 0 ? P.fronds : Math.round(P.fronds * 0.6);
  const fronds = [];
  for (let k = 0; k < count; k++) {
    const az = k * 2.39996 + R(-0.2, 0.2);
    const ring = k / count; // 0 = youngest, steep; 1 = oldest, hanging
    const rise = lerp(1.05, -0.35, ring) + R(-0.12, 0.12);
    const len = P.length * R(0.85, 1.08) * (1 - ring * 0.12);
    const pts = [];
    const n = lod === 0 ? 4 : 3;
    const d = new V3(Math.cos(az) * Math.cos(rise), Math.sin(rise), Math.sin(az) * Math.cos(rise));
    const p = top.clone().addScaledVector(d, 0.25);
    pts.push(p.clone());
    for (let s = 1; s <= n; s++) {
      d.y -= 0.32 * (len / n) * 0.45;
      d.normalize();
      p.addScaledVector(d, len / n);
      pts.push(p.clone());
    }
    const side = new V3(-Math.sin(az), 0, Math.cos(az)).applyAxisAngle(d, R(-0.5, 0.5)).normalize();
    fronds.push({ pts, side, width: len * R(0.8, 0.95) });
  }
  const crownPts = fronds.flatMap((f) => f.pts);
  const crown = makeCrown(crownPts);
  const gb = new TreeGeometryBuilder();
  addTube(gb, trunk, lod === 0 ? 10 : 6, 1, () => 0.9, () => 0);
  for (const f of fronds) addFrond(gb, f.pts, f.side, f.width, sp.tile, rng() < 0.5, rng(), crown);
  const g = gb.build();
  g.userData = { species: sp.name, variant, lod, cards: fronds.length, triangles: gb.idx.length / 3 };
  return { geometry: g, crown };
}

// One species / variant: { geometries: [near, mid], crown, far } (the crown of the near level's foliage, the far crown
// fitted to its leaf)
export function buildTreeGeometries(speciesIndex, variant, tileMeters) {
  const sp = SPECIES[speciesIndex];
  if (sp.palm) {
    const near = buildPalm(sp, variant, 0, tileMeters);
    const { C, R } = near.crown;
    // (the fronds' ball, as before: a palm's far crown is its bounding box's)
    const far = { y: C.y, r: ((R.x + R.z) / 2) * 0.92, h: R.y };
    return { geometries: [near.geometry, buildPalm(sp, variant, 1, tileMeters).geometry], crown: near.crown, far };
  }
  const seed = 7919 * (speciesIndex + 1) + 104729 * (variant + 1);
  const branches = growTree(sp, seed);

  // Crown from the full-detail foliage: card anchors pushed out by half a card
  const rngC = mulberry32(seed ^ 0x5bd1e995);
  const tips = [];
  for (const b of branches) if (b.level === 3) tips.push(b.pts[b.pts.length - 1]);
  const roughCrown = makeCrown(tips);
  const cards0 = placeCards(sp, branches, 0, tileMeters, rngC, roughCrown);
  const pts = [];
  for (const c of cards0) {
    pts.push(c.at.clone().addScaledVector(c.up, c.size * 0.5));
    pts.push(c.at.clone().addScaledVector(c.up, c.size));
  }
  const crown = makeCrown(pts);

  const geometries = [0, 1].map((lod) => {
    const gb = new TreeGeometryBuilder();
    const rng = mulberry32(seed + lod * 31337);
    const aoAt = (p) => crown.barkAO(p);
    // Bark: near everything, mid trunk + limbs (coarser; from 85 m the branches are under a pixel thick, and hidden
    // in the spring leaf)
    for (const b of branches) {
      if (lod === 0) addTube(gb, b, [9, 6, 4, 3][b.level], 1, aoAt, swayWeight);
      else if (b.level <= 1) addTube(gb, b, [6, 5][b.level], 2, aoAt, swayWeight);
    }
    const cards = lod === 0 ? cards0 : placeCards(sp, branches, lod, tileMeters, rng, crown);
    if (lod === 1) {
      // The mid cards, fewer & larger, are sized to carry MID_CARD_AREA of the near level's card area (spread wider,
      // they overlap less), so the crown keeps its density when it changes level whatever the species' twigs
      const area = (list) => list.reduce((a, c) => a + c.size * c.size, 0);
      const k = Math.sqrt(MID_CARD_AREA * area(cards0) / area(cards));
      for (const c of cards) c.size *= k;
    }
    for (const c of cards) addCard(gb, c.at, c.up, c.face, c.size, sp.tile, rng() < 0.5, rng(), crown);
    const g = gb.build();
    g.userData = { species: sp.name, variant, lod, cards: cards.length, triangles: gb.idx.length / 3 };
    return g;
  });
  return { geometries, crown, far: leafCrown(cards0) };
}

// The far crown of a tree (the far shell & billboard's spheroid, trees-material.js): centred on the near level's leaf
// (the cards' middles, weighted by their area), FAR_SPREAD standard deviations of it out round the trunk and up & down.
// (The bounding box of the cards, which a long limb or a drooping card stretches, made the far crowns of some species a
// third fuller than their near ones.) The spreads are measured to give the far shell the leaf the near crown shows,
// within ~10% seen from the street as from the air, for every species.
// Returns { y: centre height, r: radius, h: half-height } in the tree's frame.
const FAR_SPREAD = { r: 2.15, h: 2.45 };
function leafCrown(cards) {
  let w = 0, y = 0, rr = 0, yy = 0;
  const m = new V3();
  for (const c of cards) {
    const a = c.size * c.size;
    m.copy(c.at).addScaledVector(c.up, c.size * 0.5);
    w += a;
    y += a * m.y;
    rr += a * (m.x * m.x + m.z * m.z);
    yy += a * m.y * m.y;
  }
  y /= w;
  // round the trunk's axis, not the leaf's own middle (a leaning crown spreads wider round the trunk)
  return { y, r: FAR_SPREAD.r * Math.sqrt(rr / w / 2), h: FAR_SPREAD.h * Math.sqrt(Math.max(1e-4, yy / w - y * y)) };
}

// The far tree, in unit space, shaped per instance by js/donostia/trees-material.js: a five-sided prism trunk (y 0..1,
// radius 1; aFarPart 0) and 12 whole-crown cards round a unit sphere (aFarPart 1), fewer underneath, facing out with
// shell normals; uv over the broadleaf far tile (the shader slides it to the species' far tile)
export function buildFarGeometry() {
  const pos = [], nrm = [], uv = [], part = [], idx = [];
  const sides = 5;
  for (let j = 0; j <= sides; j++) {
    const a = (j / sides) * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
    for (const y of [0, 1]) {
      pos.push(x, y, z);
      nrm.push(x, 0, z);
      uv.push(j / sides, y);
      part.push(0);
    }
  }
  for (let j = 0; j < sides; j++) {
    const a = 2 * j;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const { u0, u1, vTop, vBot } = tileUV(TILE_FAR.broadleaf);
  const rng = mulberry32(4242);
  const n = 12;
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 1.6; // 1 .. -0.6
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const ph = i * 2.39996 + (rng() - 0.5) * 0.4;
    const dir = new V3(Math.cos(ph) * r, y, Math.sin(ph) * r).normalize();
    const face = dir.clone().add(new V3(rng() - 0.5, rng() - 0.5, rng() - 0.5).multiplyScalar(0.4)).normalize();
    let up = new V3(0, 1, 0).addScaledVector(face, -face.y);
    if (up.lengthSq() < 1e-3) up = new V3(1, 0, 0);
    up.normalize().applyAxisAngle(face, (rng() - 0.5) * 1.0);
    const side = new V3().crossVectors(up, face).normalize();
    const centre = dir.clone().multiplyScalar(0.5);
    // (large enough for the clumps, gappy in spring leaf, to reach the crown's rim: the near crowns' leaf does)
    const size = 1.45;
    const mirror = rng() < 0.5;
    const base = pos.length / 3;
    for (const [sx, sy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const p = centre.clone().addScaledVector(side, sx * size).addScaledVector(up, sy * size);
      // shell normal, a little skyward, blended with the card's face
      const sn = p.clone().normalize();
      sn.y += 0.22;
      const nn = sn.normalize().multiplyScalar(0.72).addScaledVector(face, 0.28).normalize();
      pos.push(p.x, p.y, p.z);
      nrm.push(nn.x, nn.y, nn.z);
      uv.push((sx < 0) !== mirror ? u0 : u1, sy < 0 ? vBot : vTop);
      part.push(1);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aFarPart', new THREE.Float32BufferAttribute(part, 1));
  g.setIndex(idx);
  return g;
}

// The most distant trees' impostor: a camera-facing quad over the broadleaf far tile for the crown (x, y in -1..1) and
// an upright one for the trunk (x in -1..1, y in 0..1), turned to the camera and sized by trees-material.js
// createBillboardTreeMaterial; aFarPart as in buildFarGeometry (1 crown, 0 trunk)
export function buildBillboardGeometry() {
  const { u0, u1, vTop, vBot } = tileUV(TILE_FAR.broadleaf);
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0,
    -1, 0, 0, 1, 0, 0, 1, 1, 0, -1, 1, 0
  ], 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(8).fill([0, 0, 1]).flat(), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, vBot, u1, vBot, u1, vTop, u0, vTop, 0, 0, 1, 0, 1, 1, 0, 1], 2));
  // the tile turned half round, read as a second layer (the far shell's crown is its cards seen through one another;
  // mirrored, the clump's gaps met on its middle line)
  g.setAttribute('uv1', new THREE.Float32BufferAttribute([u1, vTop, u0, vTop, u0, vBot, u1, vBot, 0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setAttribute('aFarPart', new THREE.Float32BufferAttribute([1, 1, 1, 1, 0, 0, 0, 0], 1));
  // the trunk first: the crown, drawn after, hides its top
  g.setIndex([4, 5, 6, 4, 6, 7, 0, 1, 2, 0, 2, 3]);
  return g;
}
