import * as THREE from 'three/webgpu';
import {
  Fn, float, vec3, attribute, uniform, varying, storage, instanceIndex, time, sin, cos, mix, smoothstep, step,
  positionGeometry, normalGeometry, normalLocal, normalize
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { BOATS } from './data-boats.js';

// js/donostia/boats.js
// The boats moored in the port, where geoEuskadi's 2025 orthophoto shows them (tools/donostia/digitise-boats.mjs ->
// bake-boats.mjs -> js/donostia/data-boats.js): low-poly procedural hulls in seven classes, each scaled per boat to its
// measured length & beam. The bake gives each boat its class (from its basin, its row & its size), its paints and its
// options (the optional fitting of its class, an outboard).
// - sail: a 10 m cruiser with a cabin trunk, a cockpit and the sail furled on the boom under its cover; the rig (mast,
//   boom, spreaders, stays, the masthead's all-round light) is a mesh of its own that casts no shadow
// - motor: an 8 m planing cruiser with a cabin and a windscreen forward, a cockpit aft under an optional canopy
// - open: a 4.5 m open boat with thwarts, a bow deck, (most) an outboard and (some) a steering console
// - txipironera: the 5.5 m wooden boat the port's people fish squid from: its sheer swept up at the bow, painted all
//   over with a contrasting gunwale stripe, open with thwarts & an engine box, or under a small wheelhouse; (some) an
//   outboard
// - rib: a 5.5 m RIB, its tubes in their colour, a console and an outboard
// - passenger: a 15 m passenger boat with a saloon and an open upper deck under a wheelhouse
// - fishing: a 12 m inshore fishing boat with its wheelhouse (in its own paint) forward, a mast and a gantry
// The island ferries are js/donostia/ferries.js's, on this module's builder & material (exported below).
// Every mesh (class x level of detail) draws its instances from one storage buffer, a slice each (as the trees do), so
// all of them share one shader & one pipeline per pass. Paints come per vertex (a fixed paint, or the boat's hull, deck
// or accent colour, which come per boat); the hull's antifouling, boot top & sheer stripe are drawn from the height.
// The vertex stage rides each hull on the sea's level (water.js's seaLevel uniform, so the tide lifts it) with a gentle
// heave, roll & pitch of its own, and folds away the optional parts a boat goes without. Near the camera the full
// models; beyond NEAR the far levels (hull, cabin, mast); the rigging, small fittings & the far level beyond FAR drop
// out. Hulls & cabins cast shadows, the rigging doesn't. At night the masthead lights glow (cityUniforms.uInteriorGlow).
// buildBoats(seaLevel) -> Object3D | null; its userData.update(dt, elapsed, camera) picks the levels as the camera moves.

const NEAR = 240; // m: full models within, far levels beyond
const RIG_NEAR = 200; // m: the sailboats' full rigging within, the bare mast beyond
const FAR = 2600; // m: nothing beyond
const RELOD = 8; // m the camera moves before the levels are picked again

// Per family: the model's length & beam (m, scaled to each boat's), and how its height follows its length (sy =
// (length / L)^k: a bigger boat stands taller, not in proportion)
const SPECS = {
  sail: { L: 10, B: 3.3, k: 0.85 },
  motor: { L: 8, B: 2.9, k: 0.75 },
  open: { L: 4.5, B: 1.75, k: 0.6 },
  txipironera: { L: 5.5, B: 2.0, k: 0.7 },
  rib: { L: 5.5, B: 2.3, k: 0.6 },
  passenger: { L: 15, B: 5.5, k: 0.5 },
  fishing: { L: 12, B: 4.2, k: 0.7 }
};

// --- paints ------------------------------------------------------------------------------------------------------------

// A paint: [r, g, b (linear), roughness] and what of the boat's own colours it takes: [hull, deck, accent, glow]
const P = (hex, rough, take = [0, 0, 0, 0]) => {
  const c = new THREE.Color(hex);
  return { paint: [c.r, c.g, c.b, rough], tint: take };
};
const HULL = P(0xffffff, 0.32, [1, 0, 0, 0]);
const DECK = P(0xffffff, 0.55, [0, 1, 0, 0]);
const ACCENT = P(0xffffff, 0.8, [0, 0, 1, 0]); // canvas: sail covers, canopies; a RIB's tubes; a fishing boat's wheelhouse
const GLASS = P(0x0b1014, 0.08);
const STEEL = P(0xb9bcc0, 0.35);
const DARK = P(0x1a1c1e, 0.5); // engines, fenders' & mast fittings' black
const TEAK = P(0x8a6a48, 0.75);
const WOOD = P(0x9c7a52, 0.7); // a txipironera's thwarts & varnished gunwale
const NONSLIP = P(0xd8d6cf, 0.8);
const LIGHT = P(0xfff6e0, 0.3, [0, 0, 0, 1]);
// parts (aPart.y): the optional fitting of a class (shown with option 1), an open boat's inside (shaded darker towards
// its floor), an outboard (shown with option 2)
const OPTIONAL = 1, INSIDE = 2, OUTBOARD = 3;

// --- geometry ------------------------------------------------------------------------------------------------------------

const V = (x, y, z) => new THREE.Vector3(x, y, z);

// Non-indexed triangles with position, normal, aPaint (rgb + roughness), aTint (hull, deck, accent, glow weights) and
// aPart (x: depth below the sheer, m, for the stripes; y: the part, OPTIONAL, INSIDE or OUTBOARD)
class Builder {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.paint = [];
    this.tint = [];
    this.part = [];
  }

  // a triangle with a normal & a sheer depth per corner, wound to face the way its normals do
  tri(a, b, c, na, nb, nc, m, sheer = [99, 99, 99], part = 0) {
    const s = Array.isArray(sheer) ? sheer.slice() : [sheer, sheer, sheer];
    const face = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (face.dot(new THREE.Vector3().add(na).add(nb).add(nc)) < 0) {
      [b, c] = [c, b];
      [nb, nc] = [nc, nb];
      [s[1], s[2]] = [s[2], s[1]];
    }
    [[a, na], [b, nb], [c, nc]].forEach(([p, n], i) => {
      this.pos.push(p.x, p.y, p.z);
      this.nrm.push(n.x, n.y, n.z);
      this.paint.push(...m.paint);
      this.tint.push(...m.tint);
      this.part.push(s[i], part);
    });
  }

  flat(a, b, c, m, part = 0) {
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (n.lengthSq() < 1e-14) return;
    n.normalize();
    this.tri(a, b, c, n, n, n, m, 99, part);
  }

  // a, b, c, d counter-clockwise seen from the front
  quad(a, b, c, d, m, part = 0) {
    this.flat(a, b, c, m, part);
    this.flat(a, c, d, m, part);
  }

  // A frustum between a bottom rectangle (y0, half-widths w0, z from z0 to z1) and a top one (y1, w1, z from z2 to z3):
  // cabins with sloped fronts, consoles, wheelhouses, cowlings. faces: which of [top, bottom] to close.
  frustum(y0, w0, z0, z1, y1, w1, z2, z3, m, { top = true, bottom = false, part = 0, x = 0 } = {}) {
    const b = [V(x - w0, y0, z0), V(x + w0, y0, z0), V(x + w0, y0, z1), V(x - w0, y0, z1)];
    const t = [V(x - w1, y1, z2), V(x + w1, y1, z2), V(x + w1, y1, z3), V(x - w1, y1, z3)];
    // sides: stern (z0), starboard (+x), bow (z1), port (-x)
    this.quad(b[0], t[0], t[1], b[1], m, part);
    this.quad(b[1], t[1], t[2], b[2], m, part);
    this.quad(b[2], t[2], t[3], b[3], m, part);
    this.quad(b[3], t[3], t[0], b[0], m, part);
    if (top) this.quad(t[0], t[3], t[2], t[1], m, part);
    if (bottom) this.quad(b[0], b[1], b[2], b[3], m, part);
  }

  box(x, y, z, w, h, l, m, opts = {}) {
    this.frustum(y, w / 2, z - l / 2, z + l / 2, y + h, w / 2, z - l / 2, z + l / 2, m, { ...opts, x });
  }

  // a bar of square section w from p to q (spars, stays, rails)
  bar(p, q, w, m, part = 0) {
    const d = new THREE.Vector3().subVectors(q, p);
    const len = d.length();
    if (len < 1e-6) return;
    const g = new THREE.BoxGeometry(w, len, w).toNonIndexed();
    const mat = new THREE.Matrix4().compose(new THREE.Vector3().addVectors(p, q).multiplyScalar(0.5),
      new THREE.Quaternion().setFromUnitVectors(V(0, 1, 0), d.normalize()), V(1, 1, 1));
    g.applyMatrix4(mat);
    const pa = g.attributes.position, na = g.attributes.normal;
    for (let i = 0; i < pa.count; i += 3) {
      const at = (k) => V(pa.getX(k), pa.getY(k), pa.getZ(k)), nt = (k) => V(na.getX(k), na.getY(k), na.getZ(k));
      this.tri(at(i), at(i + 1), at(i + 2), nt(i), nt(i + 1), nt(i + 2), m, 99, part);
    }
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('aPaint', new THREE.Float32BufferAttribute(this.paint, 4));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(this.tint, 4));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(this.part, 2));
    g.computeBoundingSphere();
    return g;
  }
}

// The hull: a lofted surface between stations from the transom (t = 0) to the stem (t = 1), z = (t - 0.5) L, x across
// (both sides), y up from the waterline. h: { L, B, transom (the transom's half-beam, as a share of the widest),
// widest (t of the widest station), entry (how full the bow: 1 a fine wedge, 2 full), sheer: [stern, middle, bow]
// heights, keel: depth at the middle, section: [[u, v]...] from the keel (0, 0) to the sheer (1, 1) as shares of the
// half-beam & of the height from keel to sheer, stations }. Returns { halfBeam(t), sheer(t), z(t) } for the fittings.
function hullShape(h) {
  const halfBeam = (t) => {
    const B2 = h.B / 2;
    if (t <= h.widest) return B2 * (h.transom + (1 - h.transom) * Math.sin((Math.PI / 2) * (t / h.widest)));
    const u = (t - h.widest) / (1 - h.widest);
    return B2 * Math.max(0, 1 - Math.pow(u, h.entry)) ** 0.75;
  };
  const [s0, s1, s2] = h.sheer;
  const sheer = (t) => s0 * (1 - t) * (1 - 2 * t) + 4 * s1 * t * (1 - t) + s2 * t * (2 * t - 1); // through the three
  const keel = (t) => -h.keel * (1 - Math.pow(t, 3)) + 0.12 * Math.pow(t, 6); // the forefoot rises to the stem
  const z = (t) => (t - 0.5) * h.L;
  return { halfBeam, sheer, keel, z };
}

function addHull(b, h, { open = false, wall = 0.05, floor = 0.15 } = {}) {
  const { halfBeam, sheer, keel, z } = hullShape(h);
  const ts = Array.from({ length: h.stations + 1 }, (_, i) => {
    const u = i / h.stations;
    return 1 - (1 - u) * (1 - u * 0.35); // stations closer together towards the bow, where the shape turns
  });
  const sec = h.section;
  // grid[i][j]: station i, section point j (starboard, x >= 0)
  const grid = ts.map((t) => sec.map(([u, v]) => {
    const k = keel(t), s = sheer(t);
    return V(u * halfBeam(t), k + v * (s - k), z(t));
  }));
  // smooth normals over the grid (starboard), from the neighbouring points along & across
  const nrm = grid.map((row, i) => row.map((p, j) => {
    const a = grid[Math.min(i + 1, ts.length - 1)][j], c = grid[Math.max(i - 1, 0)][j];
    const up = row[Math.min(j + 1, sec.length - 1)], dn = row[Math.max(j - 1, 0)];
    const along = new THREE.Vector3().subVectors(a, c), across = new THREE.Vector3().subVectors(up, dn);
    const n = across.cross(along);
    if (n.lengthSq() < 1e-12) n.set(1, 0, 0);
    n.normalize();
    if (n.x < 0) n.negate();
    return n;
  }));
  const depth = (i, j) => sheer(ts[i]) - grid[i][j].y;
  for (const side of [1, -1]) {
    const P = (i, j) => V(grid[i][j].x * side, grid[i][j].y, grid[i][j].z);
    const N = (i, j) => V(nrm[i][j].x * side, nrm[i][j].y, nrm[i][j].z);
    for (let i = 0; i < ts.length - 1; i++) {
      for (let j = 0; j < sec.length - 1; j++) {
        // quad (i, j) (i+1, j) (i+1, j+1) (i, j+1), wound to face outwards on either side
        const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
        const order = side > 0 ? [0, 3, 2, 1] : [0, 1, 2, 3];
        const [A, Bq, C, D] = order.map((o) => q[o]);
        b.tri(P(...A), P(...Bq), P(...C), N(...A), N(...Bq), N(...C), HULL, [depth(...A), depth(...Bq), depth(...C)]);
        b.tri(P(...A), P(...C), P(...D), N(...A), N(...C), N(...D), HULL, [depth(...A), depth(...C), depth(...D)]);
      }
    }
  }
  // the transom: a fan from its middle
  const t0 = grid[0], mid = V(0, (keel(0) + sheer(0)) / 2, z(0));
  const back = V(0, 0, -1);
  for (let j = 0; j < sec.length - 1; j++) {
    for (const side of [1, -1]) {
      const p = V(t0[j].x * side, t0[j].y, t0[j].z), q = V(t0[j + 1].x * side, t0[j + 1].y, t0[j + 1].z);
      if (side > 0) b.tri(mid, q, p, back, back, back, HULL, [sheer(0) - mid.y, sheer(0) - q.y, sheer(0) - p.y]);
      else b.tri(mid, p, q, back, back, back, HULL, [sheer(0) - mid.y, sheer(0) - p.y, sheer(0) - q.y]);
    }
  }
  if (!open) {
    // the deck, cambered
    const camber = h.B * 0.025;
    for (let i = 0; i < ts.length - 1; i++) {
      const row = (k) => {
        const t = ts[k], hb = halfBeam(t), s = sheer(t);
        return [V(-hb, s, z(t)), V(0, s + camber * (hb / (h.B / 2)), z(t)), V(hb, s, z(t))];
      };
      const [a0, a1, a2] = row(i), [b0, b1, b2] = row(i + 1);
      b.quad(a0, b0, b1, a1, DECK);
      b.quad(a1, b1, b2, a2, DECK);
    }
    return { halfBeam, sheer, keel, z };
  }
  // An open boat: the gunwale (wall thick), the inner sides down to the floor, the floor
  for (let i = 0; i < ts.length - 1; i++) {
    const t = [ts[i], ts[i + 1]];
    const hb = t.map(halfBeam), s = t.map(sheer), zz = t.map(z);
    const inner = hb.map((v) => Math.max(0, v - wall)), fl = hb.map((v) => v * 0.72);
    for (const side of [1, -1]) {
      const o = (k) => V(hb[k] * side, s[k], zz[k]), n = (k) => V(inner[k] * side, s[k], zz[k]);
      const f = (k) => V(fl[k] * side, floor, zz[k]);
      if (side > 0) {
        b.quad(o(0), n(0), n(1), o(1), WOOD);
        b.quad(n(0), f(0), f(1), n(1), DECK, INSIDE);
      } else {
        b.quad(o(0), o(1), n(1), n(0), WOOD);
        b.quad(n(0), n(1), f(1), f(0), DECK, INSIDE);
      }
    }
    b.quad(V(-fl[0], floor, zz[0]), V(-fl[1], floor, zz[1]), V(fl[1], floor, zz[1]), V(fl[0], floor, zz[0]), NONSLIP, INSIDE);
  }
  // the inside of the transom
  const hb0 = halfBeam(0), in0 = Math.max(0, hb0 - wall), z0 = z(0) + wall;
  b.quad(V(-in0, sheer(0), z0), V(-hb0 * 0.72, floor, z0), V(hb0 * 0.72, floor, z0), V(in0, sheer(0), z0), DECK, INSIDE);
  return { halfBeam, sheer, keel, z };
}

// A flat-topped deck patch over the bow of an open boat, from t to the stem
function bowDeck(b, shape, t0, rise = 0.02) {
  const n = 4;
  for (let i = 0; i < n; i++) {
    const ta = t0 + ((1 - t0) * i) / n, tb = t0 + ((1 - t0) * (i + 1)) / n;
    const a = shape.halfBeam(ta), c = shape.halfBeam(tb);
    b.quad(V(-a, shape.sheer(ta) + rise, shape.z(ta)), V(-c, shape.sheer(tb) + rise, shape.z(tb)),
      V(c, shape.sheer(tb) + rise, shape.z(tb)), V(a, shape.sheer(ta) + rise, shape.z(ta)), DECK);
  }
}

// An outboard engine on the transom: the cowling and the leg down into the water
function outboard(b, shape, size = 1, part = 0) {
  const z0 = shape.z(0) - 0.16 * size, y0 = shape.sheer(0) - 0.05 * size;
  b.frustum(y0, 0.15 * size, z0 - 0.22 * size, z0 + 0.12 * size, y0 + 0.42 * size, 0.12 * size, z0 - 0.18 * size, z0 + 0.06 * size, DARK, { part });
  b.box(0, y0 - 0.6 * size, z0 - 0.04 * size, 0.08 * size, 0.6 * size, 0.16 * size, DARK, { top: false, part });
}

// --- the classes -----------------------------------------------------------------------------------------------------------

const SAIL_HULL = { L: 10, B: 3.3, transom: 0.86, widest: 0.42, entry: 1.35, sheer: [0.85, 0.95, 1.18], keel: 0.5,
  section: [[0, 0], [0.45, 0.12], [0.8, 0.35], [0.96, 0.62], [1, 1]] };
const MAST_T = 0.6; // the mast's station
const MAST_H = 13.2; // m above the deck, for the 10 m model

function sailBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...SAIL_HULL, stations: lod ? 4 : 10, section: lod ? [[0, 0], [0.85, 0.4], [1, 1]] : SAIL_HULL.section });
  const deckAt = (t) => shape.sheer(t) + 0.04;
  // cabin trunk: white sides, a band of dark windows, a sloped front
  const zc0 = shape.z(0.36), zc1 = shape.z(0.72), y0 = deckAt(0.5) - 0.05;
  if (lod) {
    b.frustum(y0, 1.0, zc0, zc1, y0 + 0.25, 0.98, zc0, zc1 - 0.2, DECK, { top: false });
    b.frustum(y0 + 0.25, 0.98, zc0, zc1 - 0.2, y0 + 0.45, 0.94, zc0, zc1 - 0.5, GLASS);
  } else {
    b.frustum(y0, 1.02, zc0, zc1, y0 + 0.22, 1.0, zc0, zc1 - 0.18, DECK, { top: false });
    b.frustum(y0 + 0.22, 1.0, zc0, zc1 - 0.18, y0 + 0.4, 0.96, zc0, zc1 - 0.48, GLASS, { top: false });
    b.frustum(y0 + 0.4, 0.96, zc0, zc1 - 0.48, y0 + 0.47, 0.94, zc0 + 0.02, zc1 - 0.56, DECK);
    // the cockpit: a teak sole between coamings
    const zk0 = shape.z(0.06), zk1 = shape.z(0.34), w = shape.halfBeam(0.2) - 0.3;
    b.box(0, deckAt(0.2) - 0.01, (zk0 + zk1) / 2, w * 2, 0.03, zk1 - zk0, TEAK);
    for (const s of [-1, 1]) b.box(s * w, deckAt(0.2), (zk0 + zk1) / 2, 0.08, 0.28, zk1 - zk0, DECK);
    // the pulpit's & pushpit's rails, in the hull's colour from afar
    b.bar(V(-0.35, deckAt(0.98) + 0.62, shape.z(0.93)), V(0.35, deckAt(0.98) + 0.62, shape.z(0.93)), 0.035, STEEL);
  }
  // the sail furled on the boom under its cover: a ridge tapering aft from the mast
  const zm = shape.z(MAST_T), za = shape.z(0.14), yb = deckAt(MAST_T) + 0.95;
  b.frustum(yb, 0.2, za, zm - 0.15, yb + 0.42, 0.06, za + 0.3, zm - 0.25, ACCENT);
  return b.build();
}

// The rig, for the 10 m model: mast, boom, spreaders, stays & shrouds, the masthead light. lod 1: the bare mast & light.
function sailRig(lod) {
  const b = new Builder();
  const { halfBeam, sheer, z } = hullShape(SAIL_HULL);
  const zm = z(MAST_T), y0 = sheer(MAST_T), top = y0 + MAST_H;
  b.frustum(y0, 0.09, zm - 0.12, zm + 0.12, top, 0.06, zm - 0.08, zm + 0.08, STEEL);
  b.box(0, top, zm, 0.16, 0.16, 0.16, LIGHT);
  if (lod) return b.build();
  b.bar(V(0, y0 + 0.95, zm - 0.1), V(0, y0 + 1.0, z(0.12)), 0.09, STEEL); // boom
  const ys = y0 + MAST_H * 0.55, hb = halfBeam(MAST_T);
  b.bar(V(-hb * 0.82, ys, zm), V(hb * 0.82, ys, zm), 0.05, STEEL); // spreaders
  const w = 0.022;
  b.bar(V(0, top - 0.2, zm + 0.05), V(0, sheer(1) + 0.05, z(1) - 0.05), w, DARK); // forestay
  b.bar(V(0, top - 0.1, zm - 0.05), V(0, sheer(0) + 0.25, z(0) + 0.1), w, DARK); // backstay
  for (const s of [-1, 1]) {
    const chain = V(s * hb * 0.9, sheer(MAST_T) + 0.05, zm - 0.2);
    b.bar(V(0, top - 0.3, zm), V(s * hb * 0.8, ys, zm), w, DARK); // cap shrouds over the spreaders
    b.bar(V(s * hb * 0.8, ys, zm), chain, w, DARK);
    b.bar(V(0, ys - 0.2, zm), chain, w, DARK); // lower shrouds
  }
  return b.build();
}

const MOTOR_HULL = { L: 8, B: 2.9, transom: 0.94, widest: 0.38, entry: 1.7, sheer: [1.0, 1.08, 1.38], keel: 0.45,
  section: [[0, 0], [0.5, 0.2], [0.86, 0.36], [0.97, 0.55], [1, 1]] };

function motorBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...MOTOR_HULL, stations: lod ? 4 : 10, section: lod ? [[0, 0], [0.86, 0.36], [1, 1]] : MOTOR_HULL.section });
  const y0 = shape.sheer(0.5) - 0.02;
  // the cabin & windscreen forward of the cockpit
  const zc0 = shape.z(0.36), zc1 = shape.z(0.7), w = shape.halfBeam(0.5) - 0.18;
  if (lod) {
    b.frustum(y0, w, zc0, zc1, y0 + 0.42, w - 0.04, zc0, zc1 - 0.3, DECK, { top: false });
    b.frustum(y0 + 0.42, w - 0.04, zc0, zc1 - 0.3, y0 + 0.82, w - 0.12, zc0, zc1 - 0.9, GLASS);
  } else {
    b.frustum(y0, w, zc0, zc1, y0 + 0.42, w - 0.04, zc0, zc1 - 0.3, DECK, { top: false });
    b.frustum(y0 + 0.42, w - 0.04, zc0, zc1 - 0.3, y0 + 0.78, w - 0.12, zc0, zc1 - 0.85, GLASS, { top: false });
    b.frustum(y0 + 0.78, w - 0.12, zc0, zc1 - 0.85, y0 + 0.86, w - 0.14, zc0 + 0.05, zc1 - 0.95, DECK);
    // the cockpit's sole, a step down in teak
    b.box(0, shape.sheer(0.2) - 0.02, shape.z(0.19), (shape.halfBeam(0.2) - 0.16) * 2, 0.03, shape.z(0.34) - shape.z(0.03), TEAK);
    // the canopy over the cockpit, on two bows (optional)
    const zt0 = shape.z(0.1), zt1 = shape.z(0.36), yt = y0 + 1.75;
    b.box(0, yt, (zt0 + zt1) / 2, w * 2 + 0.1, 0.06, zt1 - zt0, ACCENT, { part: OPTIONAL, bottom: true });
    for (const s of [-1, 1]) {
      b.bar(V(s * w, y0, zt0 + 0.2), V(s * w, yt, zt0 + 0.2), 0.04, STEEL, OPTIONAL);
      b.bar(V(s * w, y0 + 0.86, zt1), V(s * w, yt, zt1 - 0.1), 0.04, STEEL, OPTIONAL);
    }
    // the bow rail
    b.bar(V(-0.4, shape.sheer(0.95) + 0.55, shape.z(0.9)), V(0.4, shape.sheer(0.95) + 0.55, shape.z(0.9)), 0.035, STEEL);
    // an anchor light's post on the cabin
    b.bar(V(0, y0 + 0.86, zc0 + 0.3), V(0, y0 + 1.3, zc0 + 0.3), 0.04, STEEL);
  }
  return b.build();
}

const OPEN_HULL = { L: 4.5, B: 1.75, transom: 0.86, widest: 0.42, entry: 1.5, sheer: [0.55, 0.6, 0.78], keel: 0.25,
  section: [[0, 0], [0.55, 0.22], [0.9, 0.45], [1, 1]] };

function openBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...OPEN_HULL, stations: lod ? 4 : 8, section: lod ? [[0, 0], [0.9, 0.45], [1, 1]] : OPEN_HULL.section },
    { open: !lod, floor: 0.16 });
  if (lod) return b.build();
  bowDeck(b, shape, 0.8);
  // thwarts
  for (const t of [0.3, 0.6]) b.box(0, shape.sheer(t) - 0.22, shape.z(t), shape.halfBeam(t) * 1.9, 0.05, 0.28, DECK);
  // a steering console amidships (optional), the outboard (optional)
  b.box(0.15, 0.16, shape.z(0.48), 0.5, 0.75, 0.45, DECK, { part: OPTIONAL });
  b.frustum(0.91, 0.25, shape.z(0.48) + 0.05, shape.z(0.48) + 0.22, 1.12, 0.25, shape.z(0.48) + 0.05, shape.z(0.48) + 0.1, GLASS, { part: OPTIONAL, x: 0.15 });
  outboard(b, shape, 0.8, OUTBOARD);
  return b.build();
}

const TXIPI_HULL = { L: 5.5, B: 2.0, transom: 0.6, widest: 0.45, entry: 1.2, sheer: [0.74, 0.64, 1.08], keel: 0.32,
  section: [[0, 0], [0.5, 0.18], [0.88, 0.42], [1, 1]] };

function txipironeraBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...TXIPI_HULL, stations: lod ? 4 : 10, section: lod ? [[0, 0], [0.88, 0.42], [1, 1]] : TXIPI_HULL.section },
    { open: !lod, floor: 0.2, wall: 0.06 });
  // the wheelhouse (optional) amidships: a small white box, windows all round under its roof (raked forward), a mast &
  // its light on top
  const zw0 = shape.z(0.26), zw1 = shape.z(0.47), ww = shape.halfBeam(0.36) - 0.32, part = OPTIONAL;
  if (lod) {
    b.frustum(shape.sheer(0.36) - 0.05, ww, zw0, zw1, 0.95, ww, zw0, zw1, DECK, { top: false, part });
    b.frustum(0.95, ww, zw0, zw1, 1.32, ww - 0.03, zw0, zw1 - 0.18, GLASS, { part });
    return b.build();
  }
  bowDeck(b, shape, 0.84, 0.0);
  for (const t of [0.16, 0.68]) b.box(0, shape.sheer(t) - 0.24, shape.z(t), shape.halfBeam(t) * 1.9, 0.06, 0.3, WOOD);
  // the engine's box amidships, a bitt at the bow
  b.box(0, 0.2, shape.z(0.38), 0.55, 0.45, 0.75, DECK);
  b.bar(V(0, shape.sheer(0.9), shape.z(0.9)), V(0, shape.sheer(0.9) + 0.35, shape.z(0.9)), 0.08, WOOD);
  b.frustum(0.2, ww, zw0, zw1, 0.95, ww, zw0, zw1, DECK, { top: false, part });
  b.frustum(0.95, ww, zw0, zw1, 1.3, ww - 0.03, zw0 + 0.02, zw1 - 0.18, GLASS, { top: false, part });
  b.box(0, 1.3, (zw0 + zw1) / 2 - 0.06, ww * 2 + 0.1, 0.05, zw1 - zw0 + 0.02, DECK, { part, bottom: true });
  b.bar(V(0, 1.35, zw0 + 0.2), V(0, 2.1, zw0 + 0.2), 0.035, STEEL, part);
  b.box(0, 2.1, zw0 + 0.2, 0.08, 0.08, 0.08, LIGHT, { part });
  outboard(b, shape, 0.7, OUTBOARD);
  return b.build();
}

const RIB_HULL = { L: 5.5, B: 2.3, transom: 0.92, widest: 0.4, entry: 1.6, sheer: [0.5, 0.52, 0.62], keel: 0.3,
  section: [[0, 0], [0.55, 0.3], [0.85, 0.6], [0.88, 1]] };

function ribBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...RIB_HULL, stations: lod ? 4 : 8, section: lod ? [[0, 0], [0.85, 0.6], [0.88, 1]] : RIB_HULL.section });
  // the tubes: an octagonal tube along each side from the transom round the bow
  const r = 0.24, n = lod ? 4 : 8, steps = lod ? 4 : 10;
  const centre = (t) => {
    const hb = shape.halfBeam(Math.min(t, 0.985));
    return [Math.max(0.05, hb - r * 0.75), shape.sheer(t) + 0.06];
  };
  for (const side of [1, -1]) {
    for (let i = 0; i < steps; i++) {
      const ta = (i / steps) * 0.99, tb = ((i + 1) / steps) * 0.99;
      const [xa, ya] = centre(ta), [xb, yb] = centre(tb), za = shape.z(ta), zb = shape.z(tb);
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2, a1 = ((k + 1) / n) * Math.PI * 2;
        const ring = (x, y, zz, a) => V(side * (x + Math.cos(a) * r), y + Math.sin(a) * r, zz);
        const nr = (a) => V(side * Math.cos(a), Math.sin(a), 0);
        const p00 = ring(xa, ya, za, a0), p01 = ring(xa, ya, za, a1), p10 = ring(xb, yb, zb, a0), p11 = ring(xb, yb, zb, a1);
        if (side > 0) {
          b.tri(p00, p10, p11, nr(a0), nr(a0), nr(a1), ACCENT);
          b.tri(p00, p11, p01, nr(a0), nr(a1), nr(a1), ACCENT);
        } else {
          b.tri(p00, p11, p10, nr(a0), nr(a1), nr(a0), ACCENT);
          b.tri(p00, p01, p11, nr(a0), nr(a1), nr(a1), ACCENT);
        }
      }
    }
  }
  if (lod) return b.build();
  // console with its screen, a seat behind it, the outboard
  b.box(0, shape.sheer(0.5), shape.z(0.48), 0.6, 0.7, 0.55, DECK);
  b.frustum(shape.sheer(0.5) + 0.7, 0.3, shape.z(0.48) + 0.05, shape.z(0.48) + 0.27, shape.sheer(0.5) + 0.98, 0.3,
    shape.z(0.48) + 0.05, shape.z(0.48) + 0.12, GLASS);
  b.box(0, shape.sheer(0.3), shape.z(0.3), 0.7, 0.45, 0.5, DARK);
  outboard(b, shape, 1.0);
  return b.build();
}

const PASSENGER_HULL = { L: 15, B: 5.5, transom: 0.92, widest: 0.42, entry: 1.8, sheer: [1.25, 1.3, 1.65], keel: 0.8,
  section: [[0, 0], [0.62, 0.15], [0.92, 0.38], [1, 1]] };

function passengerBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...PASSENGER_HULL, stations: lod ? 4 : 10, section: lod ? [[0, 0], [0.92, 0.38], [1, 1]] : PASSENGER_HULL.section });
  const y0 = shape.sheer(0.5) - 0.02, zs0 = shape.z(0.08), zs1 = shape.z(0.8), w = shape.halfBeam(0.45) - 0.25;
  // the saloon: white below, a band of windows, the upper deck on top, a little wider
  if (lod) {
    b.frustum(y0, w, zs0, zs1, y0 + 0.9, w, zs0, zs1 - 0.15, HULL, { top: false });
    b.frustum(y0 + 0.9, w, zs0, zs1 - 0.15, y0 + 2.2, w, zs0, zs1 - 0.6, GLASS);
  } else {
    b.frustum(y0, w, zs0, zs1, y0 + 0.9, w, zs0, zs1 - 0.15, HULL, { top: false });
    b.frustum(y0 + 0.9, w, zs0, zs1 - 0.15, y0 + 1.95, w, zs0, zs1 - 0.55, GLASS, { top: false });
    b.frustum(y0 + 1.95, w + 0.15, zs0 - 0.1, zs1 - 0.45, y0 + 2.2, w + 0.15, zs0 - 0.1, zs1 - 0.5, HULL);
    // the upper deck's rails & the wheelhouse forward on it
    const yr = y0 + 2.2, zw0 = shape.z(0.55), zw1 = shape.z(0.7);
    b.frustum(yr, 1.1, zw0, zw1, yr + 0.9, 1.05, zw0, zw1 - 0.25, HULL, { top: false });
    b.frustum(yr + 0.9, 1.05, zw0, zw1 - 0.25, yr + 1.45, 1.0, zw0, zw1 - 0.45, GLASS, { top: false });
    b.box(0, yr + 1.45, (zw0 + zw1) / 2 - 0.15, 2.3, 0.1, zw1 - zw0 + 0.2, HULL);
    for (const s of [-1, 1]) b.bar(V(s * (w + 0.1), yr + 0.95, zs0), V(s * (w + 0.1), yr + 0.95, zs1 - 0.6), 0.05, STEEL);
    b.bar(V(-(w + 0.1), yr + 0.95, zs0), V(w + 0.1, yr + 0.95, zs0), 0.05, STEEL);
    // benches along the upper deck, under the sky
    for (const s of [-1, 1]) b.box(s * (w - 0.5), yr, (zs0 + zw0) / 2, 0.5, 0.45, zw0 - zs0 - 1.2, ACCENT);
    // the forward deck's rail
    b.bar(V(-0.8, shape.sheer(0.95) + 0.9, shape.z(0.92)), V(0.8, shape.sheer(0.95) + 0.9, shape.z(0.92)), 0.05, STEEL);
    b.bar(V(0, y0 + 2.2 + 1.55, zw0 + 0.6), V(0, y0 + 2.2 + 2.6, zw0 + 0.6), 0.06, STEEL);
    b.box(0, y0 + 2.2 + 2.6, zw0 + 0.6, 0.14, 0.14, 0.14, LIGHT);
  }
  return b.build();
}

const FISHING_HULL = { L: 12, B: 4.2, transom: 0.8, widest: 0.45, entry: 1.5, sheer: [1.3, 1.25, 2.0], keel: 0.9,
  section: [[0, 0], [0.5, 0.15], [0.9, 0.4], [1, 1]] };

function fishingBody(lod) {
  const b = new Builder();
  const shape = addHull(b, { ...FISHING_HULL, stations: lod ? 4 : 10, section: lod ? [[0, 0], [0.9, 0.4], [1, 1]] : FISHING_HULL.section });
  // the wheelhouse forward of amidships, in its own paint (the accent)
  const y0 = shape.sheer(0.6), zw0 = shape.z(0.52), zw1 = shape.z(0.7);
  if (lod) {
    b.frustum(y0, 1.3, zw0, zw1, y0 + 1.3, 1.3, zw0, zw1 - 0.05, ACCENT, { top: false });
    b.frustum(y0 + 1.3, 1.3, zw0, zw1 - 0.05, y0 + 2.1, 1.2, zw0, zw1 - 0.3, GLASS);
  } else {
    b.frustum(y0, 1.3, zw0, zw1, y0 + 1.3, 1.3, zw0, zw1 - 0.05, ACCENT, { top: false });
    b.frustum(y0 + 1.3, 1.3, zw0, zw1 - 0.05, y0 + 2.0, 1.25, zw0, zw1 - 0.3, GLASS, { top: false });
    b.box(0, y0 + 2.0, (zw0 + zw1) / 2 - 0.1, 2.8, 0.12, zw1 - zw0 + 0.2, ACCENT);
    // the mast with its lights over the wheelhouse, the gantry over the stern
    b.bar(V(0, y0 + 2.1, zw0 + 0.5), V(0, y0 + 6.5, zw0 + 0.5), 0.12, STEEL);
    b.box(0, y0 + 6.5, zw0 + 0.5, 0.18, 0.18, 0.18, LIGHT);
    for (const s of [-1, 1]) b.bar(V(s * 1.5, shape.sheer(0.05), shape.z(0.05)), V(s * 1.2, shape.sheer(0.05) + 3.2, shape.z(0.05)), 0.12, STEEL);
    b.bar(V(-1.2, shape.sheer(0.05) + 3.2, shape.z(0.05)), V(1.2, shape.sheer(0.05) + 3.2, shape.z(0.05)), 0.12, STEEL);
    // the net drum on the after deck
    b.frustum(shape.sheer(0.25), 0.9, shape.z(0.22), shape.z(0.32), shape.sheer(0.25) + 0.9, 0.9, shape.z(0.22), shape.z(0.32), DARK);
  }
  return b.build();
}

const BODIES = { sail: sailBody, motor: motorBody, open: openBody, txipironera: txipironeraBody, rib: ribBody, passenger: passengerBody, fishing: fishingBody };

// --- material ------------------------------------------------------------------------------------------------------------

const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
const SLOTS = 5; // vec4s per instance in the storage buffer

/**
 * One material for every boat mesh. Each instance: [x, z, sin, cos of the heading], [scale across, up, along, phase],
 * [hull rgb, roll], [deck rgb, options], [accent rgb, class's stripe]; a mesh's instances start at its instanceBase.
 */
export function createBoatMaterial(instances, seaLevel) {
  const mat = new THREE.MeshStandardNodeMaterial({ metalness: 0.0, roughness: 0.5 });
  const base = uniform(0, 'uint').onObjectUpdate(({ object }) => object.userData.instanceBase);
  const index = instanceIndex.add(base).mul(SLOTS);
  const buf = storage(instances, 'vec4', instances.count);
  const pose = buf.element(index), scale = buf.element(index.add(1));
  const hull = varying(buf.element(index.add(2)), 'vBoatHull');
  const deck = varying(buf.element(index.add(3)), 'vBoatDeck');
  const accent = varying(buf.element(index.add(4)), 'vBoatAccent');
  const part = attribute('aPart', 'vec2');
  const localY = varying(positionGeometry.y, 'vBoatY');

  mat.positionNode = Fn(() => {
    const g = positionGeometry, n = normalGeometry;
    const phase = scale.w, roll = hull.w;
    // an optional fitting or an outboard the boat goes without (its options' bits 1 & 2) folds away to its middle
    const outboard = step(1.5, deck.w), fitting = deck.w.sub(outboard.mul(2));
    const shown = float(1).sub(step(0.5, part.y).mul(step(part.y, 1.5)).mul(float(1).sub(fitting)))
      .sub(step(2.5, part.y).mul(float(1).sub(outboard)));
    const p = g.mul(scale.xyz).mul(shown).toVar();
    // heave, roll & pitch: slow swell periods, each boat at its own phase, smaller boats livelier
    const t = time;
    const r = sin(t.mul(0.93).add(phase)).mul(roll);
    const q = sin(t.mul(0.61).add(phase.mul(1.7))).mul(roll.mul(0.3));
    const heave = sin(t.mul(0.71).add(phase.mul(2.3))).mul(roll.mul(1.6)).add(seaLevel);
    const cr = cos(r), sr = sin(r), cq = cos(q), sq = sin(q);
    // roll about the fore-and-aft axis, then pitch about the athwartships one
    const x1 = p.x.mul(cr).sub(p.y.mul(sr)), y1 = p.x.mul(sr).add(p.y.mul(cr));
    const y2 = y1.mul(cq).add(p.z.mul(sq)), z2 = p.z.mul(cq).sub(y1.mul(sq));
    const nx1 = n.x.mul(cr).sub(n.y.mul(sr)), ny1 = n.x.mul(sr).add(n.y.mul(cr));
    const ny2 = ny1.mul(cq).add(n.z.mul(sq)), nz2 = n.z.mul(cq).sub(ny1.mul(sq));
    // then the heading: local +z (the bow) to (sin, cos)
    const s = pose.z, c = pose.w;
    const nScaled = vec3(nx1, ny2, nz2).div(scale.xyz);
    normalLocal.assign(normalize(vec3(nScaled.x.mul(c).add(nScaled.z.mul(s)), nScaled.y, nScaled.z.mul(c).sub(nScaled.x.mul(s)))));
    return vec3(pose.x.add(x1.mul(c)).add(z2.mul(s)), y2.add(heave), pose.y.sub(x1.mul(s)).add(z2.mul(c)));
  })();

  const paint = attribute('aPaint', 'vec4'), tint = attribute('aTint', 'vec4');
  mat.colorNode = Fn(() => {
    const own = tint.x.add(tint.y).add(tint.z);
    const c = paint.xyz.mul(float(1).sub(own)).add(hull.xyz.mul(tint.x)).add(deck.xyz.mul(tint.y)).add(accent.xyz.mul(tint.z)).toVar();
    // on the hull's sides: antifouling below the waterline, a dark boot top above it, the sheer stripe in the accent (a
    // txipironera's gunwale stripe broad, the others' a thin cove line)
    const y = localY;
    const boot = smoothstep(-0.005, 0.005, y).mul(float(1).sub(smoothstep(0.075, 0.085, y)));
    const anti = float(1).sub(smoothstep(-0.01, 0.0, y));
    const stripeW = accent.w;
    const stripe = float(1).sub(smoothstep(stripeW, stripeW.add(0.012), part.x)).mul(step(0.02, part.x.add(0.02)));
    const onHull = tint.x;
    c.assign(mix(c, vec3(0.03, 0.05, 0.09), boot.mul(onHull).mul(0.85)));
    c.assign(mix(c, accent.xyz, stripe.mul(onHull)));
    c.assign(mix(c, vec3(0.12, 0.03, 0.025), anti.mul(onHull)));
    // an open boat's inside darkens towards its floor, out of the sky's light
    const inside = step(1.5, part.y).mul(step(part.y, 2.5));
    return c.mul(mix(float(1), smoothstep(0.0, 0.8, y).mul(0.45).add(0.5), inside));
  })();
  mat.roughnessNode = paint.w;
  mat.emissiveNode = vec3(1.0, 0.93, 0.78).mul(tint.w.mul(night().mul(7.0).add(0.15)));
  return mat;
}

// the builder, hull, paints & instance layout js/donostia/ferries.js builds the island ferries with
export { Builder, addHull, V, P, HULL, DECK, ACCENT, GLASS, STEEL, DARK, NONSLIP, LIGHT, SLOTS };

// --- build -------------------------------------------------------------------------------------------------------------------

const hash = (i, k) => {
  let h = Math.imul(i * 2654435761 + k * 974634151, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};
export const srgb = (v) => {
  const c = new THREE.Color().setHex(v, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};
const STRIDE = 10; // integers per boat in BOATS.boats
// the sheer stripe's depth per class (m): a txipironera's gunwale stripe, a passenger boat's band, a cove line
const STRIPES = { txipironera: 0.12, passenger: 0.25, sail: 0.05, fishing: 0.0 };

/**
 * The port's boats. seaLevel: the water's level uniform (js/donostia/water.js userData.seaLevel), so the hulls ride the
 * tide; mean sea level without it.
 */
export function buildBoats(seaLevel = null) {
  try {
    const level = seaLevel || uniform(0);
    const { classes, boats: flat } = BOATS;
    const N = flat.length / STRIDE;
    if (!N) return null;
    // per boat: its class and its five vec4s
    const fam = new Uint8Array(N), rows = new Float32Array(N * SLOTS * 4), at = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const [xc, zc, hd, lc, bc, f, options, hullHex, deckHex, accentHex] = flat.slice(i * STRIDE, (i + 1) * STRIDE);
      const name = classes[f], spec = SPECS[name];
      const x = xc / 100, z = zc / 100, h = (hd / 10) * (Math.PI / 180), length = lc / 100, beam = bc / 100;
      const sy = Math.pow(length / spec.L, spec.k);
      // small boats roll more (radians); a little bit each of its own
      const roll = (0.022 / Math.sqrt(Math.max(1, length / 4))) * (0.7 + 0.6 * hash(i, 1));
      rows.set([x, z, Math.sin(h), Math.cos(h), beam / spec.B, sy, length / spec.L, hash(i, 4) * 6.2832,
        ...srgb(hullHex), roll, ...srgb(deckHex), options, ...srgb(accentHex), STRIPES[name] ?? 0.035], i * SLOTS * 4);
      fam[i] = f;
      at[i * 2] = x;
      at[i * 2 + 1] = z;
    }

    // Meshes: per class a near & a far level, and the sailboats' rigging near & far; each a slice of the storage buffer
    // as long as its class
    const counts = classes.map((_, f) => fam.reduce((n, g) => n + (g === f ? 1 : 0), 0));
    const levels = [];
    classes.forEach((name, f) => {
      if (!counts[f]) return;
      levels.push({ f, name: `Boats_${name}`, geo: BODIES[name](0), from: 0, to: NEAR, shadow: true });
      levels.push({ f, name: `Boats_${name}_far`, geo: BODIES[name](1), from: NEAR, to: FAR, shadow: true });
      if (name === 'sail') {
        levels.push({ f, name: 'Boats_sail_rig', geo: sailRig(0), from: 0, to: RIG_NEAR, shadow: false });
        levels.push({ f, name: 'Boats_sail_mast', geo: sailRig(1), from: RIG_NEAR, to: FAR, shadow: false });
      }
    });
    let slots = 0;
    for (const l of levels) { l.base = slots; slots += Math.max(1, counts[l.f]); }
    const instances = new THREE.StorageBufferAttribute(new Float32Array(slots * SLOTS * 4), 4);
    const material = createBoatMaterial(instances, level);

    // the port's bounds (with the masts): every mesh's bounding sphere, so the port off screen draws nothing
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < N; i++) {
      minX = Math.min(minX, at[i * 2]); maxX = Math.max(maxX, at[i * 2]);
      minZ = Math.min(minZ, at[i * 2 + 1]); maxZ = Math.max(maxZ, at[i * 2 + 1]);
    }
    const sphere = new THREE.Sphere(new THREE.Vector3((minX + maxX) / 2, 4, (minZ + maxZ) / 2), Math.hypot(maxX - minX, maxZ - minZ) / 2 + 20);

    const group = new THREE.Group();
    group.name = 'DonostiaBoats';
    const meshes = levels.map((l, m) => {
      const geo = new THREE.InstancedBufferGeometry();
      for (const name of Object.keys(l.geo.attributes)) geo.setAttribute(name, l.geo.attributes[name]);
      geo.boundingSphere = sphere;
      geo.instanceCount = 0;
      const mesh = new THREE.Mesh(geo, material);
      mesh.name = l.name;
      mesh.userData.instanceBase = l.base;
      mesh.castShadow = l.shadow;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      return mesh;
    });

    // Refill each level with the boats in its range of distance from the camera
    const fill = new Int32Array(levels.length);
    function relevel(cam) {
      fill.fill(0);
      const a = instances.array;
      for (let i = 0; i < N; i++) {
        const d = Math.hypot(at[i * 2] - cam.x, cam.y, at[i * 2 + 1] - cam.z);
        for (let m = 0; m < levels.length; m++) {
          const l = levels[m];
          if (l.f !== fam[i] || d < l.from || d >= l.to) continue;
          a.set(rows.subarray(i * SLOTS * 4, (i + 1) * SLOTS * 4), (l.base + fill[m]++) * SLOTS * 4);
        }
      }
      instances.clearUpdateRanges();
      let any = false;
      levels.forEach((l, m) => {
        const n = fill[m];
        meshes[m].geometry.instanceCount = n;
        // (the first mesh stays in the scene with or without boats: its pipeline, which all share, compiles behind the
        // loading screen wherever the camera starts)
        meshes[m].visible = n > 0 || m === 0;
        if (n) { instances.addUpdateRange(l.base * SLOTS * 4, n * SLOTS * 4); any = true; }
      });
      if (any) instances.needsUpdate = true;
    }
    const last = new THREE.Vector3(Infinity, Infinity, Infinity);
    group.userData.update = (dt, elapsed, camera) => {
      if (camera.position.distanceToSquared(last) < RELOD * RELOD) return;
      last.copy(camera.position);
      relevel(camera.position);
    };
    group.userData.stats = () => ({
      boats: N, perClass: Object.fromEntries(classes.map((f, i) => [f, counts[i]])),
      meshes: levels.map((l, m) => ({ name: l.name, triangles: l.geo.attributes.position.count / 3, instances: meshes[m].geometry.instanceCount }))
    });
    return group;
  } catch (e) {
    // the city stands without its boats rather than not at all (main.js skips a null module)
    console.warn('[boats]', e);
    return null;
  }
}
