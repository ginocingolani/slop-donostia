import * as THREE from 'three/webgpu';
import {
  Fn, attribute, float, vec2, vec3, abs, max, min, mix, floor, fract, sin, dot, clamp, smoothstep, step, select,
  positionWorld, mx_noise_float
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { PartBin, Frame, westMaterials as M, rgb } from './igeldo.js';

// js/donostia/landmarks/miramar.js
// Miramar jauregia / Palacio de Miramar (1889-93): the royal summer palace on the hill between La Concha and Ondarreta,
// designed by Ralph Selden Wornum and built by José Goicoa in an English Queen Anne cottage style with some neo-Gothic
// touches (es.wikipedia "Palacio de Miramar"): exposed red-brown brick with stone dressings, three floors over a
// basement, steep slate roofs with many gables, tall chimneys and an octagonal tower (restored in 2007). The road and
// the old tramway pass under its gardens in a cut-and-cover tunnel.
//
// The model raises brick walls on the OpenStreetMap outline, then covers it with gabled roofs: the outline is cut into
// overlapping rectangles (each a wing with its own ridge, cross-gables where they meet), with chimneys on the ridges,
// dormers on the slopes facing the bay and the octagonal tower on the corner nearest the bay.
//
// build(sites, ctx) receives the GEO.landmarks entries ['miramar'] and ctx = { GEO, terrain, kit }.

const PITCH = THREE.MathUtils.degToRad(50);
const MAX_RISE = 6.5;
const BAY = [-430, 330]; // the middle of La Concha bay
const BRICK = new THREE.Color(0x9a4b36), DRESSING = new THREE.Color(0xd8ccb2);
const POT = rgb(0x8c4a33), STONE = rgb(0xcfc3a8), CREAM = rgb(0xe4dccb);

// Exposed brick with stone dressings: plinth, string courses, quoins and window surrounds, read from the per-wall
// `facade` attribute (u along the wall, v above the principal floor, wall length, seed) like js/donostia/buildings.js;
// v beyond the eaves (gables, chimneys) is plain brick. Sash windows light up at night.
function createBrickMaterial(eaveHeight) {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.userData.attributes = { facade: 4 };
  const f = attribute('facade', 'vec4');
  const u = f.x, v = f.y, len = f.z, seed = f.w;
  const top = float(eaveHeight);
  // soft-edged 0/1 between heights a and b (numbers or nodes)
  const band = (a, b) => smoothstep(float(a).sub(0.03), float(a).add(0.03), v).mul(smoothstep(float(b).add(0.03), float(b).sub(0.03), v));
  const facadeZone = step(v, top.add(0.05));

  const bays = max(floor(len.div(3.6).add(0.5)), 1.0);
  const bayU = u.div(len.div(bays));
  const bu = fract(bayU);
  const valid = step(2.2, len).mul(facadeZone);
  const storeys = band(1.2, 3.25).add(band(4.7, 6.75)).add(band(8.15, 9.85)).mul(step(v, top.sub(0.7)));
  const halo = band(1.0, 3.45).add(band(4.5, 6.95)).add(band(7.95, 10.05)).mul(step(v, top.sub(0.5)));
  const wx = smoothstep(0.205, 0.185, abs(bu.sub(0.5)));
  const window = wx.mul(storeys).mul(valid);
  const surround = smoothstep(0.255, 0.235, abs(bu.sub(0.5))).mul(clamp(halo, 0.0, 1.0)).mul(valid).sub(window).max(0.0);
  const quoinW = mix(float(0.35), float(0.62), step(0.5, fract(v.div(0.62))));
  const quoin = clamp(step(u, quoinW).add(step(len.sub(quoinW), u)), 0.0, 1.0);
  const courses = band(3.85, 4.1).add(band(7.4, 7.62)).add(band(top.sub(0.5), top.add(0.02)));
  const plinth = step(v, 0.8);
  const dressing = clamp(plinth.add(courses).add(quoin).add(surround), 0.0, 1.0).mul(facadeZone);

  // brick tone varies course by course and across the wall; no mortar lines (they would only shimmer at distance)
  const tone = float(0.92).add(mx_noise_float(positionWorld.mul(vec3(1.7, 12.0, 1.7))).mul(0.07))
    .add(mx_noise_float(positionWorld.mul(0.15)).mul(0.05));
  const brick = vec3(BRICK.r, BRICK.g, BRICK.b).mul(tone);
  const stone = vec3(DRESSING.r, DRESSING.g, DRESSING.b).mul(float(0.95).add(mx_noise_float(positionWorld.mul(1.3)).mul(0.04)));
  // white glazing bars: a central mullion and a transom two-thirds up each opening
  const storeyV = fract(v.sub(1.2).div(3.5));
  const bars = max(smoothstep(0.012, 0.004, abs(bu.sub(0.5))), smoothstep(0.02, 0.008, abs(storeyV.sub(0.38))));
  const glass = mix(vec3(0.045, 0.055, 0.065), vec3(0.82, 0.8, 0.75), bars);
  mat.colorNode = Fn(() => mix(mix(brick, stone, dressing), glass, window))();
  mat.roughnessNode = mix(float(0.86), float(0.15), window.mul(float(1.0).sub(bars)));
  mat.metalnessNode = mix(float(0.0), float(0.3), window.mul(float(1.0).sub(bars)));

  // lit rooms at dusk & night: a per-window draw against the preset's interior glow
  const storey = floor(v.sub(1.0).div(3.5));
  const cell = vec2(floor(bayU), storey).add(seed.mul(57.3));
  const h = fract(sin(dot(cell, vec2(12.9898, 78.233))).mul(43758.5453));
  const lit = step(h, clamp(cityUniforms.uInteriorGlow.mul(0.36), 0.0, 0.7)).mul(window).mul(float(1.0).sub(bars));
  const warm = select(h.lessThan(0.15), vec3(1.0, 0.82, 0.6), vec3(1.0, 0.7, 0.4));
  mat.emissiveNode = warm.mul(lit).mul(cityUniforms.uInteriorGlow).mul(1.5);
  return mat;
}

function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

// Drops the outline's centimetre jogs and collinear points; returns the ring wound so edge normals (dz, -dx) point out
function cleanRing(ring) {
  let pts = [];
  for (let k = 0; k < ring.length; k += 2) {
    const p = [ring[k], ring[k + 1]];
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.35) pts.push(p);
  }
  if (pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.35) pts.pop();
  for (let changed = true; changed && pts.length > 3;) {
    changed = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i - 1 + pts.length) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      const lab = Math.hypot(b[0] - a[0], b[1] - a[1]), lbc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      if (Math.abs(cross) < 0.06 * lab * lbc) { pts.splice(i, 1); changed = true; break; }
    }
  }
  const flat = pts.flat();
  if (signedArea(flat) > 0) return flat;
  const out = [];
  for (let k = flat.length - 2; k >= 0; k -= 2) out.push(flat[k], flat[k + 1]);
  return out;
}

// Walls of a ring between y0 and y1 with the `facade` attribute (u, height above `base`, wall length, seed)
function walls(ring, y0, y1, base, seed) {
  const pos = [], nrm = [], fac = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.05) continue;
    const nx = (bz - az) / len, nz = -(bx - ax) / len;
    const v = [[ax, y0, az, 0], [bx, y0, bz, len], [bx, y1, bz, len], [ax, y1, az, 0]];
    for (const k of [0, 2, 1, 0, 3, 2]) {
      const [x, y, z, u] = v[k];
      pos.push(x, y, z);
      nrm.push(nx, 0, nz);
      fac.push(u, y - base, len, seed + i * 0.137);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('facade', new THREE.Float32BufferAttribute(fac, 4));
  return g;
}

// Cuts the outline (in its frame's u, v) into overlapping wings: repeatedly the largest rectangle of cells not yet
// roofed, grown over roofed cells as far as the outline allows (so wings run into each other like cross-gables)
function wings(uv, cell = 0.5, maxWings = 16) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let k = 0; k < uv.length; k += 2) {
    minU = Math.min(minU, uv[k]); maxU = Math.max(maxU, uv[k]);
    minV = Math.min(minV, uv[k + 1]); maxV = Math.max(maxV, uv[k + 1]);
  }
  const W = Math.ceil((maxU - minU) / cell), H = Math.ceil((maxV - minV) / cell);
  const inside = new Uint8Array(W * H), done = new Uint8Array(W * H);
  const n = uv.length / 2;
  for (let j = 0; j < H; j++) {
    const v = minV + (j + 0.5) * cell;
    for (let i = 0; i < W; i++) {
      const u = minU + (i + 0.5) * cell;
      let c = false;
      for (let a = 0, b = n - 1; a < n; b = a++) {
        const ua = uv[2 * a], va = uv[2 * a + 1], ub = uv[2 * b], vb = uv[2 * b + 1];
        if ((va > v) !== (vb > v) && u < ((ub - ua) * (v - va)) / (vb - va) + ua) c = !c;
      }
      inside[j * W + i] = c ? 1 : 0;
    }
  }
  const total = inside.reduce((s, x) => s + x, 0);
  const out = [];
  const heights = new Int32Array(W);
  for (let w = 0; w < maxWings; w++) {
    // largest all-free rectangle (histogram method)
    heights.fill(0);
    let best = { area: 0 };
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) heights[i] = inside[j * W + i] && !done[j * W + i] ? heights[i] + 1 : 0;
      const stack = [];
      for (let i = 0; i <= W; i++) {
        const h = i < W ? heights[i] : 0;
        let start = i;
        while (stack.length && stack[stack.length - 1][1] >= h) {
          const [s, sh] = stack.pop();
          if (sh * (i - s) > best.area) best = { area: sh * (i - s), i0: s, i1: i - 1, j0: j - sh + 1, j1: j };
          start = s;
        }
        stack.push([start, h]);
      }
    }
    if (best.area * cell * cell < 30) break;
    let { i0, i1, j0, j1 } = best;
    const rowFull = (j, a, b) => { for (let i = a; i <= b; i++) if (!inside[j * W + i]) return false; return true; };
    const colFull = (i, a, b) => { for (let j = a; j <= b; j++) if (!inside[j * W + i]) return false; return true; };
    for (let grew = true; grew;) {
      grew = false;
      if (i0 > 0 && colFull(i0 - 1, j0, j1)) { i0--; grew = true; }
      if (i1 < W - 1 && colFull(i1 + 1, j0, j1)) { i1++; grew = true; }
      if (j0 > 0 && rowFull(j0 - 1, i0, i1)) { j0--; grew = true; }
      if (j1 < H - 1 && rowFull(j1 + 1, i0, i1)) { j1++; grew = true; }
    }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) done[j * W + i] = 1;
    out.push({ u0: minU + i0 * cell, u1: minU + (i1 + 1) * cell, v0: minV + j0 * cell, v1: minV + (j1 + 1) * cell });
    if (done.reduce((s, x) => s + x, 0) > 0.97 * total) break;
  }
  // wide wings get parallel ridges rather than one huge roof
  const split = [];
  for (const r of out) {
    const lu = r.u1 - r.u0, lv = r.v1 - r.v0;
    const alongU = lu >= lv;
    const span = alongU ? lv : lu;
    const parts = Math.max(1, Math.ceil(span / 14));
    for (let k = 0; k < parts; k++) {
      // strip: a second (third...) parallel ridge of the same wing
      if (alongU) split.push({ ...r, v0: r.v0 + (lv * k) / parts, v1: r.v0 + (lv * (k + 1)) / parts, strip: k > 0 });
      else split.push({ ...r, u0: r.u0 + (lu * k) / parts, u1: r.u0 + (lu * (k + 1)) / parts, strip: k > 0 });
    }
  }
  return split;
}

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { kit, GEO } = ctx;
  const ring = cleanRing(site.footprint);
  const g0 = kit.lowestGround(ctx, ring);
  const b5m = GEO.buildings[site.buildings?.[0]];
  // the principal floor sits on b5m's ground level, the eaves on its measured mean height
  const base = b5m && b5m.ground > g0 - 1 && b5m.ground < g0 + 6 ? b5m.ground : g0 + 1;
  const eave = b5m && b5m.eave > base + 8 && b5m.eave < base + 15 ? b5m.eave : base + 11;
  const eaveH = eave - base;
  const ob = kit.orientedBox(ring);
  const fr = new Frame(ob.x, ob.z, ob.angle);
  const brick = createBrickMaterial(eaveH);
  const slate = kit.materials.slate;
  const bin = new PartBin();
  const NO_WINDOWS = { facade: [0, 99, 0, 0] };
  const bayDir = (() => {
    const dx = BAY[0] - ob.x, dz = BAY[1] - ob.z, l = Math.hypot(dx, dz);
    return [dx / l, dz / l];
  })();

  bin.add(brick, walls(ring, g0 - 0.8, eave, base, 0.31));
  // a slate deck at the eaves under the gables, so no gap between wings shows from above
  const shape = new THREE.Shape();
  for (let k = 0; k < ring.length; k += 2) (k ? shape.lineTo : shape.moveTo).call(shape, ring[k], -ring[k + 1]);
  const deck = new THREE.ShapeGeometry(shape);
  deck.rotateX(-Math.PI / 2);
  deck.translate(0, eave + 0.05, 0);
  bin.add(slate, deck);

  // roofs, one gabled wing at a time, built in the wing's own frame (x along the ridge)
  const uv = [];
  for (let k = 0; k < ring.length; k += 2) uv.push(...fr.local(ring[k], ring[k + 1]));
  const m = new THREE.Matrix4(), mWing = new THREE.Matrix4();
  for (const [index, w] of wings(uv).entries()) {
    const lu = w.u1 - w.u0, lv = w.v1 - w.v0;
    const alongU = lu >= lv;
    const L = alongU ? lu : lv, span = alongU ? lv : lu;
    const h = span / 2;
    const rise = Math.min(MAX_RISE, h * Math.tan(PITCH));
    const pitch = Math.atan2(rise, h);
    const over = 0.45;
    mWing.makeRotationY(alongU ? 0 : -Math.PI / 2).setPosition((w.u0 + w.u1) / 2, eave, (w.v0 + w.v1) / 2);
    m.multiplyMatrices(fr.matrix, mWing);
    const put = (geo, mat, color, extra) => bin.add(mat, geo.applyMatrix4(m), color, extra);
    const slopeW = (h + over) / Math.cos(pitch);
    for (const side of [-1, 1]) {
      const g = new THREE.BoxGeometry(L + 0.6, 0.22, slopeW);
      g.rotateX(side * pitch);
      g.translate(0, (rise - over * Math.tan(pitch)) / 2 + 0.11 / Math.cos(pitch), (side * (h + over)) / 2);
      put(g, slate);
    }
    // the gable walls at both ends, and a stone coping on the ridge
    const tri = new THREE.Shape();
    tri.moveTo(-h, -0.05);
    tri.lineTo(h, -0.05);
    tri.lineTo(0, rise);
    tri.closePath();
    for (const end of [-1, 1]) {
      const g = new THREE.ExtrudeGeometry(tri, { depth: 0.4, bevelEnabled: false });
      g.rotateY(Math.PI / 2);
      g.translate(end * (L / 2) - 0.2, 0, 0);
      put(g, brick, null, NO_WINDOWS);
    }
    put(new THREE.BoxGeometry(L + 0.7, 0.18, 0.34).translate(0, rise + 0.14, 0), M.stone, STONE);
    // tall chimney stacks astride the ridge near the gable ends, one or two a wing (not on every parallel ridge)
    if (L > 10 && !w.strip) {
      for (const t of L > 30 ? [-1, 1] : [index % 2 ? 1 : -1]) {
        const x = t * (L / 2 - 2.2);
        put(new THREE.BoxGeometry(1.0, rise + 2.6, 1.7).translate(x, (rise + 2.6) / 2, 0), brick, null, NO_WINDOWS);
        put(new THREE.BoxGeometry(1.3, 0.25, 2.0).translate(x, rise + 2.7, 0), M.stone, STONE);
        for (const z of [-0.45, 0.45]) put(new THREE.CylinderGeometry(0.15, 0.18, 0.7, 8).translate(x, rise + 3.15, z), M.paint, POT);
      }
    }
    // dormers on the slope facing the bay (Queen Anne roofs bristle with them)
    if (L > 14 && h > 3) {
      // world direction of the wing's +z axis
      const zDir = alongU ? [-fr.s, fr.c] : [-fr.c, -fr.s];
      const side = zDir[0] * bayDir[0] + zDir[1] * bayDir[1] > 0 ? 1 : -1;
      const count = Math.floor((L - 6) / 8);
      for (let k = 0; k < count; k++) {
        const x = -L / 2 + 2 + (L - 4) * ((k + 0.5) / count);
        const zf = side * (h - 1.0); // dormer face, set back from the eaves
        const yb = (h - Math.abs(zf)) * Math.tan(pitch);
        const depth = Math.min(2.6, h - 1.2);
        put(new THREE.BoxGeometry(1.7, 1.9, depth).translate(x, yb + 0.95, zf - side * (depth / 2)), brick, null, NO_WINDOWS);
        put(new THREE.BoxGeometry(1.0, 1.15, 0.08).translate(x, yb + 0.95, zf + side * 0.02), kit.materials.glass);
        put(new THREE.BoxGeometry(1.2, 0.12, 0.1).translate(x, yb + 0.33, zf + side * 0.05), M.paint, CREAM);
        // a boarded gable over the window, under the dormer's own little roof
        const pediment = new THREE.Shape();
        pediment.moveTo(-0.85, 1.9);
        pediment.lineTo(0.85, 1.9);
        pediment.lineTo(0, 2.5);
        pediment.closePath();
        const ped = new THREE.ExtrudeGeometry(pediment, { depth: 0.12, bevelEnabled: false });
        ped.translate(x, yb, zf - 0.06);
        put(ped, M.paint, CREAM);
        for (const s of [-1, 1]) {
          const r = new THREE.BoxGeometry(1.25, 0.12, depth + 0.3);
          r.rotateZ(-s * 0.75);
          r.translate(x + s * 0.43, yb + 2.15, zf - side * (depth / 2) + side * 0.15);
          put(r, slate);
        }
      }
    }
  }

  // the octagonal tower on the convex corner nearest the bay
  let corner = null;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, c = (i + 1) % n;
    const ax = ring[2 * a], az = ring[2 * a + 1], bx = ring[2 * i], bz = ring[2 * i + 1], cx = ring[2 * c], cz = ring[2 * c + 1];
    // with the ring wound for outward (dz, -dx) normals, a convex corner turns this way
    const cross = (bx - ax) * (cz - bz) - (bz - az) * (cx - bx);
    if (cross <= 0) continue;
    const d = Math.hypot(bx - BAY[0], bz - BAY[1]);
    if (!corner || d < corner.d) {
      const ux = (ax - bx) / Math.hypot(ax - bx, az - bz) + (cx - bx) / Math.hypot(cx - bx, cz - bz);
      const uz = (az - bz) / Math.hypot(ax - bx, az - bz) + (cz - bz) / Math.hypot(cx - bx, cz - bz);
      const ul = Math.hypot(ux, uz) || 1;
      corner = { d, x: bx + (ux / ul) * 0.9, z: bz + (uz / ul) * 0.9 };
    }
  }
  if (corner) {
    const r = 3.1, top = eave + 4.2;
    const oct = [];
    for (let k = 0; k < 8; k++) {
      const a = fr.angle + Math.PI / 8 + (k * Math.PI) / 4;
      oct.push(corner.x + Math.cos(a) * r, corner.z + Math.sin(a) * r);
    }
    const octRing = [];
    if (signedArea(oct) > 0) octRing.push(...oct);
    else for (let k = oct.length - 2; k >= 0; k -= 2) octRing.push(oct[k], oct[k + 1]);
    bin.add(brick, walls(octRing, g0 - 0.8, top, base, 0.77));
    // an 8-sided CylinderGeometry turned onto the walls' corners (its radius is the corner radius too)
    const octagon = (rTop, rBottom, y0, y1) => {
      const g = new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, 8);
      g.rotateY(-fr.angle - Math.PI / 8 + Math.PI / 2);
      g.translate(corner.x, (y0 + y1) / 2, corner.z);
      return g;
    };
    bin.add(M.stone, octagon(r + 0.3, r + 0.12, top - 0.1, top + 0.35), STONE);
    bin.add(slate, octagon(0.12, r + 0.4, top + 0.35, top + 7.5));
    bin.add(M.metal, octagon(0.04, 0.04, top + 7.5, top + 8.8), rgb(0x2a2a2a));
  }

  const group = new THREE.Group();
  group.name = 'Miramar';
  bin.build(group);
  return group;
}
