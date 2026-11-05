import * as THREE from 'three/webgpu';
import { PartBin, westMaterials as M, rgb } from './igeldo.js';
import { HARRESIA } from '../data-harresia.js';
import { WALL, COPING } from '../shore-walls.js';

// js/donostia/landmarks/harresia.js
// What stands on and in the old city wall along the port (tools/donostia/harresia.mjs -> js/donostia/data-harresia.js;
// the wall's masonry faces are js/donostia/shore.js's, and the terrain steps at its port face):
// - The wall walk: its flagstones between the port face and the inner face, where it stands over Mari kalea, and the
//   black iron railings along both faces' kerbs (posts, a handrail and bars) and up the flight of Mari kalea's steps.
// - The Portaletas, the gate from the port into Portu kalea: in front of the wall a gatehouse of buff sandstone ashlar,
//   half an octagon on the municipal map's outline, with a wide opening in its front and a door in each oblique side,
//   passages through it into a half-round court, and on it the walk's terrace (10.15 m, its spot height) under a
//   cornice and a railing round both its edges; behind the court, in the wall's line, the inner gate's block (the
//   pedestrian piece of the map under it), its round arch between two doors and a cornice a couple of metres over the
//   terrace. The openings' sizes, the gate's height and the stone were read off Wikimedia Commons photographs
//   («Portaleta - San Sebastian 01-05», «Portaleta 20240511», «Portaletas barrutik»), references only: nothing derived
//   from their pixels is used.
// build(sites, ctx) gets no GEO.landmarks site (the plan is data-harresia.js's) and ctx = { GEO, terrain, kit }.

const SANDSTONE = rgb(0xb09878), GATE_STONE = rgb(0xa8957a), CORNICE = rgb(0xc2b393), FLAGS = rgb(0x9d978b);
const IRON = rgb(0x1b1d20);
const KERB = COPING[WALL.harresia]; // m: the railings stand on the faces' kerb
const RAIL = { h: 1.0, post: 0.06, every: 1.8, bar: 0.018, gap: 0.14, rail: 0.05 }; // m
const BACK = 0.2; // m behind a face's line: the railing on its kerb
// The Portaletas (m): the gatehouse's openings (width, head over the plaza), its cornice; the inner gate's head over the
// terrace, its arch (span, springing over the court) and doors (width, head, their centres off the middle)
const HOUSE = { front: [3.4, 3.5], side: [1.8, 3.3], cornice: 0.3, over: 0.12 };
const GATE = { head: 2.45, span: 3.4, spring: 3.9, door: [1.5, 3.1], doorAt: 3.6, cornice: 0.35, over: 0.15, ring: 0.35 };
const BURY = 0.6; // m below the ground the walls go on

// --- geometry ----------------------------------------------------------------------------------------------------------

// Flat-shaded triangles in plain arrays; each quad wound to face the normal it is given
class Mesh {
  constructor() { this.pos = []; this.nrm = []; }
  tri(a, b, c, n) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const v = g[0] * n[0] + g[1] * n[1] + g[2] * n[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const p of v) { this.pos.push(...p); this.nrm.push(...n); }
  }
  quad(a, b, c, d, n) { this.tri(a, b, c, n); this.tri(a, c, d, n); }
  // box between two points (x, y, z) with a w x h section, its long sides square to the line
  bar(a, b, w, h) {
    const dx = b[0] - a[0], dz = b[2] - a[2], l = Math.hypot(dx, dz) || 1;
    const sx = (-dz / l) * w / 2, sz = (dx / l) * w / 2;
    const c = (p, s, y) => [p[0] + s * sx, p[1] + y, p[2] + s * sz];
    const A = [c(a, -1, 0), c(a, 1, 0), c(a, 1, h), c(a, -1, h)], B = [c(b, -1, 0), c(b, 1, 0), c(b, 1, h), c(b, -1, h)];
    const n = [[-sx * 2 / w, 0, -sz * 2 / w], [sx * 2 / w, 0, sz * 2 / w]];
    this.quad(A[0], B[0], B[3], A[3], n[0]);
    this.quad(A[1], B[1], B[2], A[2], n[1]);
    this.quad(A[3], B[3], B[2], A[2], [0, 1, 0]);
    this.quad(A[0], B[0], B[1], A[1], [0, -1, 0]);
  }
  // upright post of a w x w section from y0 to y1
  post(x, z, w, y0, y1) {
    const h = w / 2;
    const P = (sx, sz, y) => [x + sx * h, y, z + sz * h];
    // (each side: its two corners and its normal)
    for (const [a, b, n] of [[[1, -1], [1, 1], [1, 0, 0]], [[-1, -1], [-1, 1], [-1, 0, 0]], [[-1, 1], [1, 1], [0, 0, 1]], [[-1, -1], [1, -1], [0, 0, -1]]]) {
      this.quad(P(a[0], a[1], y0), P(b[0], b[1], y0), P(b[0], b[1], y1), P(a[0], a[1], y1), n);
    }
    this.quad(P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, 1, y1), [0, 1, 0]);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    return g;
  }
}

const len2 = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);

// A vertical wall along a polyline pts [[x, z], ...] from bottom(s) to top (m), facing n(segment) (unit [nx, nz]), with
// openings cut up from the bottom: notches [{ s0, s1, head(s) }] in metres along the line; split at the openings'
// sides and every 0.25 m across them, so an arched head follows its curve
function wallAlong(mesh, pts, bottom, top, normal, notches = []) {
  const S = [0];
  for (let i = 1; i < pts.length; i++) S.push(S[i - 1] + len2(pts[i - 1], pts[i]));
  const total = S[S.length - 1];
  const cuts = new Set(S);
  for (const o of notches) {
    for (let s = Math.max(0, o.s0); s <= Math.min(total, o.s1) + 1e-9; s += 0.25) cuts.add(Math.min(s, total));
    cuts.add(Math.max(0, Math.min(total, o.s1)));
  }
  const at = (s) => {
    let i = 1;
    while (i < S.length - 1 && S[i] < s) i++;
    const t = (s - S[i - 1]) / ((S[i] - S[i - 1]) || 1);
    return { x: pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, z: pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, seg: i - 1 };
  };
  const list = [...cuts].sort((a, b) => a - b);
  for (let k = 0; k + 1 < list.length; k++) {
    const sa = list[k], sb = list[k + 1];
    if (sb - sa < 1e-4) continue;
    const mid = (sa + sb) / 2, o = notches.find((q) => mid > q.s0 && mid < q.s1);
    const A = at(sa), B = at(sb), n = normal(at(mid).seg);
    const ya = o ? o.head(sa) : bottom(A.x, A.z), yb = o ? o.head(sb) : bottom(B.x, B.z);
    if (ya >= top - 1e-3 && yb >= top - 1e-3) continue;
    mesh.quad([A.x, ya, A.z], [B.x, yb, B.z], [B.x, top, B.z], [A.x, top, A.z], [n[0], 0, n[1]]);
  }
}

// Where the ray from p along d first crosses the polyline pts: { t, s (along pts) } or null
function hit(p, d, pts) {
  let best = null, s0 = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], ex = b[0] - a[0], ez = b[1] - a[1], l = Math.hypot(ex, ez);
    const den = d[0] * ez - d[1] * ex;
    if (Math.abs(den) > 1e-9) {
      const t = ((a[0] - p[0]) * ez - (a[1] - p[1]) * ex) / den, u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
      if (t > 0 && u >= 0 && u <= 1 && (!best || t < best.t)) best = { t, s: s0 + u * l };
    }
    s0 += l;
  }
  return best;
}

// A railing along a polyline of [x, y, z] (y: where it stands): posts, a handrail, a bottom rail and bars
function railing(mesh, pts) {
  if (pts.length < 2) return;
  let carry = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (l < 1e-3) continue;
    const lift = (p, y) => [p[0], p[1] + y, p[2]];
    mesh.bar(lift(a, RAIL.h - RAIL.rail), lift(b, RAIL.h - RAIL.rail), RAIL.rail, RAIL.rail);
    mesh.bar(lift(a, 0.08), lift(b, 0.08), RAIL.rail * 0.7, RAIL.rail * 0.7);
    const posts = Math.max(1, Math.round(l / RAIL.every));
    for (let k = 0; k < posts; k++) {
      const t = k / posts, y = a[1] + (b[1] - a[1]) * t;
      mesh.post(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, RAIL.post, y, y + RAIL.h + 0.04);
    }
    for (let s = carry; s < l; s += RAIL.gap) {
      const t = s / l, y = a[1] + (b[1] - a[1]) * t;
      mesh.post(a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, RAIL.bar, y + 0.08, y + RAIL.h - RAIL.rail);
      carry = s + RAIL.gap - l;
    }
  }
  const e = pts[pts.length - 1];
  mesh.post(e[0], e[2], RAIL.post, e[1], e[1] + RAIL.h + 0.04);
}

// A face's line [x, z, deck, foot, ...] moved `back` m behind it (to its high side), at its deck + y
function behind(p, back, y) {
  const n = p.length / 4, out = [];
  for (let k = 0; k < n; k++) {
    let nx = 0, nz = 0;
    for (const s of [k - 1, k]) {
      if (s < 0 || s >= n - 1) continue;
      const dx = p[4 * s + 4] - p[4 * s], dz = p[4 * s + 5] - p[4 * s + 1], l = Math.hypot(dx, dz) || 1;
      nx += -dz / l; nz += dx / l;
    }
    const l = Math.hypot(nx, nz) || 1;
    out.push([p[4 * k] - (nx / l) * back, p[4 * k + 2] + y, p[4 * k + 1] - (nz / l) * back]);
  }
  return out;
}

// The polygon [[x, z], ...] at level y(x, z) as triangles facing up
function floorOf(mesh, ring, y) {
  const contour = ring.map(([x, z]) => new THREE.Vector2(x, z));
  for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    const P = (i) => [ring[i][0], y(ring[i][0], ring[i][1]), ring[i][1]];
    mesh.tri(P(a), P(b), P(c), [0, 1, 0]);
  }
}

// --- the wall walk ------------------------------------------------------------------------------------------------------

function walk(stone, iron, ground, house) {
  for (const s of HARRESIA.walk) {
    const n = s.length / 5;
    const O = (k) => [s[5 * k], s[5 * k + 1]], I = (k) => [s[5 * k + 2], s[5 * k + 3]], Y = (k) => s[5 * k + 4];
    for (let k = 0; k + 1 < n; k++) {
      const a = O(k), b = I(k), c = I(k + 1), d = O(k + 1);
      stone.quad([a[0], Y(k), a[1]], [b[0], Y(k), b[1]], [c[0], Y(k + 1), c[1]], [d[0], Y(k + 1), d[1]], [0, 1, 0]);
    }
    // each end: on to the gatehouse's terrace (the corner by the gate's block), else down to the street it meets
    for (const k of [0, n - 1]) {
      const o = O(k), i = I(k), y = Y(k);
      const end = house.find((h) => len2(h, o) < 0.4);
      if (end) {
        const c = HARRESIA.gate.court, ends = [[c[0], c[1]], [c[c.length - 2], c[c.length - 1]]];
        const near = ends.sort((p, q) => len2(p, i) - len2(q, i))[0];
        stone.tri([o[0], y, o[1]], [i[0], y, i[1]], [near[0], y, near[1]], [0, 1, 0]);
        continue;
      }
      const j = k ? k - 1 : 1, m = [(O(j)[0] + I(j)[0]) / 2, (O(j)[1] + I(j)[1]) / 2], mid = [(o[0] + i[0]) / 2, (o[1] + i[1]) / 2];
      const l = len2(m, mid) || 1, nrm = [(mid[0] - m[0]) / l, 0, (mid[1] - m[1]) / l];
      const g = Math.min(ground(o[0], o[1]), ground(i[0], i[1])) - 0.3;
      stone.quad([o[0], y, o[1]], [i[0], y, i[1]], [i[0], g, i[1]], [o[0], g, o[1]], nrm);
    }
  }
  for (const f of HARRESIA.faces) railing(iron, behind(f.p, BACK, KERB));
}

// --- the Portaletas ------------------------------------------------------------------------------------------------------

function portaletas(stone, gate, trim, flags, iron, ground) {
  const G = HARRESIA.gate;
  const pairs = (a) => { const o = []; for (let k = 0; k < a.length; k += 2) o.push([a[k], a[k + 1]]); return o; };
  const house = pairs(G.house), court = pairs(G.court), block = pairs(G.block);
  const T = G.terrace;
  const all = [...house, ...court, ...block];
  const base = Math.min(...all.map(([x, z]) => ground(x, z))) - BURY;
  const bottom = () => base;
  // the block: its west face (towards the court) and its axis
  const bc = [(block[0][0] + block[2][0]) / 2, (block[0][1] + block[2][1]) / 2];
  const faces = [[block[0], block[1]], [block[1], block[2]], [block[2], block[3]], [block[3], block[0]]];
  faces.sort((p, q) => len2(...q) - len2(...p));
  const hc = house.reduce((s, p) => [s[0] + p[0] / house.length, s[1] + p[1] / house.length], [0, 0]);
  const longFaces = faces.slice(0, 2).sort((p, q) =>
    len2([(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2], hc) - len2([(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2], hc));
  const [west, east] = longFaces, ends = faces.slice(2);
  const ux = (west[1][0] - west[0][0]) / len2(...west), uz = (west[1][1] - west[0][1]) / len2(...west);

  // the gatehouse: each facet of its front, outward on the port's side; the front facet lies along the block, the
  // obliques beside it
  const facets = [];
  for (let i = 0; i + 1 < house.length; i++) {
    const a = house[i], b = house[i + 1], l = len2(a, b);
    const d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
    let n = [-d[1], d[0]];
    const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    if ((m[0] - bc[0]) * n[0] + (m[1] - bc[1]) * n[1] < 0) n = [-n[0], -n[1]];
    facets.push({ a, b, l, d, n, m, along: Math.abs(d[0] * ux + d[1] * uz) });
  }
  const frontIdx = facets.reduce((best, f, i) => (f.l > 4 && f.along > facets[best].along ? i : best), 0);
  const floorAt = (f) => ground(f.m[0] + f.n[0] * 1.5, f.m[1] + f.n[1] * 1.5);
  const passages = [];
  facets.forEach((f, i) => {
    const kind = i === frontIdx ? HOUSE.front : Math.abs(i - frontIdx) === 1 ? HOUSE.side : null;
    if (!kind) return;
    const [w, h] = kind, head = floorAt(f) + h;
    const s0 = f.l / 2 - w / 2, s1 = f.l / 2 + w / 2;
    const P = (s) => [f.a[0] + f.d[0] * s, f.a[1] + f.d[1] * s];
    const inward = [-f.n[0], -f.n[1]];
    const ha = hit(P(s0), inward, court), hb = hit(P(s1), inward, court);
    if (!ha || !hb || ha.t > 9 || hb.t > 9) return;
    f.notch = { s0, s1, head: () => head };
    passages.push({ pa: P(s0), pb: P(s1), qa: [P(s0)[0] + inward[0] * ha.t, P(s0)[1] + inward[1] * ha.t],
      qb: [P(s1)[0] + inward[0] * hb.t, P(s1)[1] + inward[1] * hb.t], c0: Math.min(ha.s, hb.s), c1: Math.max(ha.s, hb.s), head });
  });
  for (const f of facets) wallAlong(stone, [f.a, f.b], bottom, T, () => f.n, f.notch ? [f.notch] : []);
  // the court's curve, facing the court (away from the gatehouse's front), with the passages coming out through it
  const courtNormal = (i) => {
    const a = court[i], b = court[i + 1], l = len2(a, b) || 1;
    let n = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    if ((a[0] + b[0]) / 2 * n[0] + (a[1] + b[1]) / 2 * n[1] - (hc[0] * n[0] + hc[1] * n[1]) < 0) n = [-n[0], -n[1]];
    return n;
  };
  wallAlong(stone, court, bottom, T, courtNormal, passages.map((p) => ({ s0: p.c0, s1: p.c1, head: () => p.head })));
  // the passages' sides and ceilings
  for (const p of passages) {
    const mid = [(p.pa[0] + p.pb[0]) / 2, (p.pa[1] + p.pb[1]) / 2];
    for (const [a, b] of [[p.pa, p.qa], [p.pb, p.qb]]) {
      const l = len2(a, b) || 1;
      let n = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
      if ((mid[0] - a[0]) * n[0] + (mid[1] - a[1]) * n[1] < 0) n = [-n[0], -n[1]];
      wallAlong(stone, [a, b], bottom, p.head, () => n);
    }
    stone.quad([p.pa[0], p.head, p.pa[1]], [p.pb[0], p.head, p.pb[1]], [p.qb[0], p.head, p.qb[1]], [p.qa[0], p.head, p.qa[1]], [0, -1, 0]);
  }
  // the terrace, its cornice and railings (round the front and over the court)
  const terrace = [...house, ...court];
  floorOf(flags, terrace, () => T);
  for (const f of facets) {
    const o = HOUSE.over;
    const a = [f.a[0] + f.n[0] * o / 2 - f.d[0] * o, T - HOUSE.cornice, f.a[1] + f.n[1] * o / 2 - f.d[1] * o];
    const b = [f.b[0] + f.n[0] * o / 2 + f.d[0] * o, T - HOUSE.cornice, f.b[1] + f.n[1] * o / 2 + f.d[1] * o];
    trim.bar(a, b, o * 2, HOUSE.cornice + 0.02);
  }
  const inset = (pts, normal, by) => pts.map((p, i) => {
    const n0 = normal(Math.max(0, i - 1)), n1 = normal(Math.min(pts.length - 2, i));
    const nx = n0[0] + n1[0], nz = n0[1] + n1[1], l = Math.hypot(nx, nz) || 1;
    return [p[0] - (nx / l) * by, T + 0.04, p[1] - (nz / l) * by];
  });
  railing(iron, inset(house, (i) => facets[i].n, BACK));
  railing(iron, inset(court, courtNormal, BACK));

  // the inner gate's block: its arch and doors through it, from the court to Portu kalea
  const top = T + GATE.head, floor = G.floor;
  const L = len2(...west), r = GATE.span / 2, spring = floor + GATE.spring;
  const [dw, dh] = GATE.door;
  const archHead = (c) => (s) => spring + Math.sqrt(Math.max(0, r * r - (s - c) ** 2));
  // (s along each long face from the corners at its west face's first end)
  const holes = [
    { s0: L / 2 - r, s1: L / 2 + r, head: archHead(L / 2) },
    { s0: L / 2 - GATE.doorAt - dw / 2, s1: L / 2 - GATE.doorAt + dw / 2, head: () => floor + dh },
    { s0: L / 2 + GATE.doorAt - dw / 2, s1: L / 2 + GATE.doorAt + dw / 2, head: () => floor + dh }
  ];
  const outward = (a, b) => {
    const l = len2(a, b) || 1;
    let n = [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
    if (((a[0] + b[0]) / 2 - bc[0]) * n[0] + ((a[1] + b[1]) / 2 - bc[1]) * n[1] < 0) n = [-n[0], -n[1]];
    return n;
  };
  // (the east face runs from the corner across from the west face's first, so the openings line up)
  const eastLine = len2(east[0], west[0]) < len2(east[1], west[0]) ? east : [east[1], east[0]];
  for (const line of [west, eastLine]) wallAlong(gate, line, bottom, top, () => outward(...line), holes);
  for (const e of ends) wallAlong(gate, e, bottom, top, () => outward(...e));
  floorOf(trim, block, () => top);
  // the openings' linings, square through the block from the west face to the east one
  const vx = eastLine[0][0] - west[0][0], vz = eastLine[0][1] - west[0][1];
  const W = (s, y) => [west[0][0] + ux * s, y, west[0][1] + uz * s];
  const E = (s, y) => [west[0][0] + ux * s + vx, y, west[0][1] + uz * s + vz];
  const c = L / 2;
  const jamb = (s, y0, y1, sign) => gate.quad(W(s, y0), E(s, y0), E(s, y1), W(s, y1), [ux * sign, 0, uz * sign]);
  for (const dc of [-GATE.doorAt, GATE.doorAt]) {
    jamb(c + dc - dw / 2, base, floor + dh, 1);
    jamb(c + dc + dw / 2, base, floor + dh, -1);
    gate.quad(W(c + dc - dw / 2, floor + dh), W(c + dc + dw / 2, floor + dh), E(c + dc + dw / 2, floor + dh), E(c + dc - dw / 2, floor + dh), [0, -1, 0]);
  }
  jamb(c - r, base, spring, 1);
  jamb(c + r, base, spring, -1);
  const SEG = 16;
  for (let k = 0; k < SEG; k++) {
    const a0 = Math.PI * (k / SEG), a1 = Math.PI * ((k + 1) / SEG);
    const s0 = c - r * Math.cos(a0), s1 = c - r * Math.cos(a1), y0 = spring + r * Math.sin(a0), y1 = spring + r * Math.sin(a1);
    const am = (a0 + a1) / 2, n = [ux * Math.cos(am), -Math.sin(am), uz * Math.cos(am)];
    gate.quad(W(s0, y0), W(s1, y1), E(s1, y1), E(s0, y0), n);
  }
  // the arch's dressed ring on both faces, the cornice round the head
  for (const line of [west, eastLine]) {
    const n = outward(...line);
    const P = (s, y) => [line[0][0] + ux * s + n[0] * 0.04, y, line[0][1] + uz * s + n[1] * 0.04];
    for (let k = 0; k < SEG; k++) {
      const a0 = Math.PI * (k / SEG), a1 = Math.PI * ((k + 1) / SEG);
      const ring = (a, rr) => [c - rr * Math.cos(a), spring + rr * Math.sin(a)];
      const [s0, y0] = ring(a0, r), [s1, y1] = ring(a1, r), [t0, z0] = ring(a0, r + GATE.ring), [t1, z1] = ring(a1, r + GATE.ring);
      trim.quad(P(s0, y0), P(s1, y1), P(t1, z1), P(t0, z0), [n[0], 0, n[1]]);
    }
  }
  for (const [a, b] of faces) {
    const n = outward(a, b), l = len2(a, b), d = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], o = GATE.over;
    trim.bar([a[0] + n[0] * o / 2 - d[0] * o, top - GATE.cornice, a[1] + n[1] * o / 2 - d[1] * o],
      [b[0] + n[0] * o / 2 + d[0] * o, top - GATE.cornice, b[1] + n[1] * o / 2 + d[1] * o], o * 2, GATE.cornice + 0.05);
  }
}

export function build(sites, ctx) {
  if (!HARRESIA?.faces?.length) return null;
  const ground = (x, z) => ctx.terrain.heightAt(x, z);
  const house = new Mesh(), gate = new Mesh(), trim = new Mesh(), flags = new Mesh(), iron = new Mesh();
  const front = [];
  for (let k = 0; k < HARRESIA.gate.house.length; k += 2) front.push([HARRESIA.gate.house[k], HARRESIA.gate.house[k + 1]]);
  walk(flags, iron, ground, front);
  portaletas(house, gate, trim, flags, iron, ground);
  // stone in one draw (the colours per part), the railings in another, casting no shadow (thin bars alias in the map)
  const bin = new PartBin(), rails = new PartBin();
  bin.add(M.stone, house.geometry(), SANDSTONE);
  bin.add(M.stone, gate.geometry(), GATE_STONE);
  bin.add(M.stone, trim.geometry(), CORNICE);
  bin.add(M.stone, flags.geometry(), FLAGS);
  rails.add(M.metal, iron.geometry(), IRON);
  const group = new THREE.Group();
  group.name = 'Harresia';
  bin.build(group);
  rails.build(group, { castShadow: false });
  return group;
}
