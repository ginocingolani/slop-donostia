import {
  wound, simplifyRing, facadeRuns, sharedEdges, splitEdge, offsetRing, ringCentroid, pointInRing, distanceToRing,
  signedArea
} from './facade-geometry.js';
import { STYLE, WALL, SURF, KONSTITUZIO, facadeInfo, bayLayout, hash } from './facade-style.js';

// js/donostia/facade-mesh.js
// Vertex data for every building of the 1:500 map, merged per 512 m cell: walls (with the facade attributes the
// shader lays windows out with) and roofs (hips, gables against party walls, mansards, eaves, parapets, lift housings
// and chimneys), plus the miradores of the Área Romántica. Plain JS so Node can check it; js/donostia/buildings.js
// turns the arrays into meshes. `triangulate(contour, holes)` is THREE.ShapeUtils.triangulateShape's contract with
// {x, y} points.
//
// Walls: facade = (u metres along the facade run, v metres above the building's ground, run length, WALL kind),
// binfo = (style + seed, storey height, ground-floor height (negative: no shops), height of the top storey's ceiling
// above ground), bcol = (wall sRGB, flag bits / 255), acol = (accent sRGB, second seed).
// Roofs: rfac = (u along the eaves, height above the eaves, run length, SURF kind), rinfo = (style + seed, storey
// height, roof rise, wall height), bcol as for walls, rcol = (roof sRGB, COVER / 255).

const CELL = 512;
const SIMPLIFY = 0.22; // m; pier bases & arcade wiggles in the 1:500 outlines
const FASCIA = 0.22, PARAPET_T = 0.22;

class Part {
  constructor() {
    this.cap = 1 << 13;
    this.n = 0;
    this.ni = 0;
    this.pos = new Float32Array(this.cap * 3);
    this.nrm = new Float32Array(this.cap * 3);
    this.fa = new Float32Array(this.cap * 4);
    this.fb = new Float32Array(this.cap * 4);
    this.ca = new Uint8Array(this.cap * 4);
    this.cb = new Uint8Array(this.cap * 4);
    this.index = new Uint32Array(this.cap * 2);
    this.b = [0, 0, 0, 0];
    this.c = [0, 0, 0, 0];
    this.d = [0, 0, 0, 0];
    this.owner = null; // building index per vertex, when debugging
    this.current = -1;
  }

  // Per-building attributes written with every vertex until the next call
  building(b4, c4, d4) {
    this.b = b4;
    this.c = c4;
    this.d = d4;
  }

  reserve(nv, ni) {
    if (this.n + nv > this.cap) {
      let cap = this.cap;
      while (this.n + nv > cap) cap *= 2;
      const grow = (a, k) => { const out = new a.constructor(cap * k); out.set(a); return out; };
      this.pos = grow(this.pos, 3); this.nrm = grow(this.nrm, 3);
      this.fa = grow(this.fa, 4); this.fb = grow(this.fb, 4);
      this.ca = grow(this.ca, 4); this.cb = grow(this.cb, 4);
      this.cap = cap;
    }
    if (this.ni + ni > this.index.length) {
      let len = this.index.length;
      while (this.ni + ni > len) len *= 2;
      const out = new Uint32Array(len);
      out.set(this.index);
      this.index = out;
    }
  }

  v(x, y, z, nx, ny, nz, a0, a1, a2, a3) {
    const i = this.n++;
    this.pos[3 * i] = x; this.pos[3 * i + 1] = y; this.pos[3 * i + 2] = z;
    this.nrm[3 * i] = nx; this.nrm[3 * i + 1] = ny; this.nrm[3 * i + 2] = nz;
    this.fa[4 * i] = a0; this.fa[4 * i + 1] = a1; this.fa[4 * i + 2] = a2; this.fa[4 * i + 3] = a3;
    const { b, c, d } = this;
    this.fb[4 * i] = b[0]; this.fb[4 * i + 1] = b[1]; this.fb[4 * i + 2] = b[2]; this.fb[4 * i + 3] = b[3];
    this.ca[4 * i] = c[0]; this.ca[4 * i + 1] = c[1]; this.ca[4 * i + 2] = c[2]; this.ca[4 * i + 3] = c[3];
    this.cb[4 * i] = d[0]; this.cb[4 * i + 1] = d[1]; this.cb[4 * i + 2] = d[2]; this.cb[4 * i + 3] = d[3];
    if (this.owner) this.owner.push(this.current);
    return i;
  }

  tri(i, j, k) {
    this.index[this.ni++] = i;
    this.index[this.ni++] = j;
    this.index[this.ni++] = k;
  }

  // Quad p0 p1 p2 p3 ([x, y, z] each) with per-corner (u, h) and shared (len, kind). The corners run like a wall's
  // a-bottom, b-bottom, b-top, a-top seen from outside, i.e. clockwise seen from the side the quad faces; the normal
  // is the opposite of Newell's (right-handed loop normal), so slightly warped quads still shade as one face.
  quad(p, uh, len, kind) {
    let nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 4; k++) {
      const a = p[k], c = p[(k + 1) % 4];
      nx += (a[1] - c[1]) * (a[2] + c[2]);
      ny += (a[2] - c[2]) * (a[0] + c[0]);
      nz += (a[0] - c[0]) * (a[1] + c[1]);
    }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    nx /= -l; ny /= -l; nz /= -l;
    this.reserve(4, 6);
    const i = this.n;
    for (let k = 0; k < 4; k++) this.v(p[k][0], p[k][1], p[k][2], nx, ny, nz, uh[k][0], uh[k][1], len, kind);
    this.tri(i, i + 2, i + 1);
    this.tri(i, i + 3, i + 2);
  }
}

// Wall quad from a to b (ring order, outward normal (dz, -dx)) between y0 and y1. Corners in the loop order the
// index pattern of Part.quad expects: a-bottom, b-bottom, b-top, a-top.
function wall(part, ax, az, bx, bz, y0, y1, ground, ua, ub, len, kind) {
  part.quad([[ax, y0, az], [bx, y0, bz], [bx, y1, bz], [ax, y1, az]],
    [[ua, y0 - ground], [ub, y0 - ground], [ub, y1 - ground], [ua, y1 - ground]], len, kind);
}

// Horizontal polygon(s) at height y facing up (or down with `down`), in roof attributes
function cap(part, rings, y, surf, triangulate, h = 0, down = false) {
  const contour = [], holes = [];
  rings.forEach((r, k) => {
    const pts = [];
    for (let i = 0; i < r.length; i += 2) pts.push(new Pt(r[i], r[i + 1]));
    if (k === 0) contour.push(...pts);
    else holes.push(pts);
  });
  let tris;
  try { tris = triangulate(contour, holes); } catch { return; }
  if (!tris || !tris.length) return;
  const all = [...contour, ...holes.flat()];
  part.reserve(all.length, tris.length * 3);
  const base = part.n;
  const ny = down ? -1 : 1;
  for (const p of all) part.v(p.x, y, p.y, 0, ny, 0, 0, h, 0, surf);
  for (const [a, b, c] of tris) {
    // facing up means counter-clockwise seen from above: (c - a) x (b - a) has +y, i.e. the 2D cross is negative
    const pa = all[a], pb = all[b], pc = all[c];
    const cross = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
    if ((cross > 0) !== down) part.tri(base + a, base + c, base + b);
    else part.tri(base + a, base + b, base + c);
  }
}

// Box on a roof (lift housing, chimney): footprint centre, half extents along / across `angle`, from y0 to y1
function box(part, cx, cz, hw, hd, angle, y0, y1, surf) {
  const dx = Math.cos(angle), dz = Math.sin(angle);
  const px = -dz, pz = dx;
  let r = [
    cx - dx * hw - px * hd, cz - dz * hw - pz * hd, cx + dx * hw - px * hd, cz + dz * hw - pz * hd,
    cx + dx * hw + px * hd, cz + dz * hw + pz * hd, cx - dx * hw + px * hd, cz - dz * hw + pz * hd
  ];
  r = wound(r, true);
  for (let i = 0; i < 4; i++) {
    const q = (i + 1) % 4;
    const len = Math.hypot(r[2 * q] - r[2 * i], r[2 * q + 1] - r[2 * i + 1]);
    wall(part, r[2 * i], r[2 * i + 1], r[2 * q], r[2 * q + 1], y0, y1, y0, 0, len, len, surf);
  }
  // a positively wound ring, in wall order, faces up
  const top = [];
  for (let i = 0; i < 4; i++) top.push([r[2 * i], y1, r[2 * i + 1]]);
  part.quad(top, [[0, y1 - y0], [0, y1 - y0], [0, y1 - y0], [0, y1 - y0]], 0, surf);
}

// A point inside the outline (away from its edges and courtyards) for something standing on the roof
function interiorPoint(rings, rnd, minDist) {
  const outer = rings[0];
  const inside = (x, z) => pointInRing(x, z, outer) && !rings.slice(1).some((h) => pointInRing(x, z, h));
  const clearance = (x, z) => Math.min(...rings.map((r) => distanceToRing(x, z, r)));
  let best = null, bestD = minDist;
  const [cx, cz] = ringCentroid(outer);
  if (inside(cx, cz)) {
    const d = clearance(cx, cz);
    if (d >= bestD) { best = [cx, cz]; bestD = d; }
  }
  if (best && bestD > minDist * 1.6) return best;
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < outer.length; k += 2) {
    minX = Math.min(minX, outer[k]); maxX = Math.max(maxX, outer[k]);
    minZ = Math.min(minZ, outer[k + 1]); maxZ = Math.max(maxZ, outer[k + 1]);
  }
  for (let t = 0; t < 12; t++) {
    const x = minX + (maxX - minX) * rnd(t * 2), z = minZ + (maxZ - minZ) * rnd(t * 2 + 1);
    if (!inside(x, z)) continue;
    const d = clearance(x, z);
    if (d > bestD) { best = [x, z]; bestD = d; }
  }
  return best;
}

function longestEdgeAngle(r) {
  let best = 0, angle = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const dx = r[2 * q] - r[2 * i], dz = r[2 * q + 1] - r[2 * i + 1];
    const l = Math.hypot(dx, dz);
    if (l > best) { best = l; angle = Math.atan2(dz, dx); }
  }
  return angle;
}

const lerp = (a, b, t) => a + (b - a) * t;

// Whether an outline has a wall on the edge of Konstituzio plaza, looking into it
const PLAZA_CENTRE = ringCentroid(KONSTITUZIO);
function facesPlaza(r) {
  if (Math.hypot(r[0] - PLAZA_CENTRE[0], r[1] - PLAZA_CENTRE[1]) > 120) return false;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], bx = r[2 * q], bz = r[2 * q + 1];
    const L = Math.hypot(bx - ax, bz - az);
    if (L < 3) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const tx = PLAZA_CENTRE[0] - mx, tz = PLAZA_CENTRE[1] - mz, d = Math.hypot(tx, tz);
    const facing = ((bz - az) * tx - (bx - ax) * tz) / (L * d);
    if (facing > 0.7 && distanceToRing(mx, mz, KONSTITUZIO) < 2.5) return true;
  }
  return false;
}

// The {x, y} points ShapeUtils.triangulateShape expects (it calls equals() on the end points)
class Pt {
  constructor(x, y) { this.x = x; this.y = y; }
  equals(p) { return p.x === this.x && p.y === this.y; }
}

// Outer ring wound positive, courtyards negative, both simplified (keeping the original when that would flip it)
function prepareRings(b) {
  const prep = (r, positive) => {
    const w = wound(r, positive);
    if (w.length < 6) return null;
    const s = simplifyRing(w, SIMPLIFY);
    return (signedArea(s) > 0) === positive ? s : w;
  };
  const outer = prep(b.g[0], true);
  if (!outer) return null;
  const rings = [outer];
  for (let k = 1; k < b.g.length; k++) {
    const h = prep(b.g[k], false);
    if (h) rings.push(h);
  }
  return rings;
}

// Pieces of the stretch [t0, t1] (metres along the wall a -> b) and the height each must start above: a building's
// `skip` lists stretches of its outline ([ax, az, bx, bz, y]) that a landmark builds itself below y (Infinity: all of
// it), such as Konstituzio plaza's fronts and the mouths of its passages. A wall takes a stretch when it runs along it,
// both ends within 0.4 m of its line.
function skipPieces(ax, az, bx, bz, t0, t1, skip) {
  const L = Math.hypot(bx - ax, bz - az);
  if (!skip || L < 1e-6) return [[t0, t1, -Infinity]];
  const ux = (bx - ax) / L, uz = (bz - az) / L;
  const cuts = [t0, t1], spans = [];
  for (const [sx, sz, ex, ez, y] of skip) {
    const sl = Math.hypot(ex - sx, ez - sz);
    if (sl < 1e-6 || Math.abs(((ex - sx) * uz - (ez - sz) * ux) / sl) > 0.05) continue;
    const off = (px, pz) => Math.abs((px - sx) * (ez - sz) - (pz - sz) * (ex - sx)) / sl;
    if (off(ax, az) > 0.4 || off(bx, bz) > 0.4) continue;
    const p = (sx - ax) * ux + (sz - az) * uz, q = (ex - ax) * ux + (ez - az) * uz;
    const lo = Math.max(t0, Math.min(p, q)), hi = Math.min(t1, Math.max(p, q));
    if (hi - lo < 0.05) continue;
    spans.push([lo, hi, y]);
    cuts.push(lo, hi);
  }
  if (!spans.length) return [[t0, t1, -Infinity]];
  cuts.sort((a, b) => a - b);
  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k + 1];
    if (b - a < 0.02) continue;
    const mid = (a + b) / 2;
    let y = -Infinity;
    for (const [lo, hi, h] of spans) if (mid > lo && mid < hi) y = Math.max(y, h);
    const last = out[out.length - 1];
    if (last && last[2] === y && Math.abs(last[1] - a) < 1e-6) last[1] = b;
    else out.push([a, b, y]);
  }
  return out;
}

// replace: Map(building index -> record) drawn instead of GEO.buildings[index] (a landmark that keeps a building but
// changes it: Konstituzio plaza's blocks, their eaves levelled and their fronts on the square left to the landmark);
// phantoms: records that stand next to the city's buildings (their party walls hidden, their roofs gabled against
// them) but are never drawn, for a landmark modelled in full whose neighbours stay the city's
export function buildFacadeCells(GEO, { hidden = new Set(), triangulate, debug = false, replace = null, phantoms = null } = {}) {
  const real = GEO.buildings.length;
  const B = replace || phantoms
    ? [...GEO.buildings.map((b, j) => replace?.get(j) || b), ...(phantoms || [])]
    : GEO.buildings;
  // Walls follow simplified outlines; hidden landmarks leave no rings (and hide no neighbours' walls)
  const ringSets = B.map((b, j) => (hidden.has(j) ? null : prepareRings(b)));
  const shared = sharedEdges(ringSets);

  // Per-building style & storeys
  const infos = new Array(B.length).fill(null);
  B.forEach((b, j) => {
    const rings = ringSets[j];
    if (!rings || j >= real) return;
    const outer = rings[0];
    let perim = 0, partyLen = 0;
    for (let i = 0, n = outer.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const L = Math.hypot(outer[2 * q] - outer[2 * i], outer[2 * q + 1] - outer[2 * i + 1]);
      perim += L;
      const hits = shared[j][0][i];
      if (hits) for (const [a, c, o] of hits) if (B[o].kind === 0) partyLen += c - a;
    }
    const area = Math.abs(signedArea(outer)) - rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0);
    const [cx, cz] = ringCentroid(outer);
    infos[j] = facadeInfo(b, {
      index: j, district: GEO.districts[b.district] || '', cx, cz, area, plaza: b.plaza ?? facesPlaza(outer),
      partyShare: perim > 0 ? Math.min(partyLen / perim, 1) : 0, flat: b.roof === 0 || b.top - b.eave < 0.5
    });
    infos[j].cx = cx;
    infos[j].cz = cz;
    infos[j].area = area;
  });
  // Height up to which building j hides a shared wall: its roof surface at the eaves (inside a flat roof's parapet)
  const roofBase = (j) => B[j].eave - (infos[j] ? infos[j].parapet : 0);
  const topOf = (j) => roofBase(j);
  const partyOf = (j) => B[j].kind === 0;

  const cells = new Map();
  const cellFor = (x, z) => {
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    let c = cells.get(key);
    if (!c) {
      cells.set(key, (c = { walls: new Part(), roofs: new Part() }));
      if (debug) c.walls.owner = [], c.roofs.owner = [];
    }
    return c;
  };

  const stats = { buildings: 0, miradores: 0, housings: 0, chimneys: 0 };
  B.forEach((b, j) => {
    const rings = ringSets[j];
    const info = infos[j];
    if (!rings || !info) return;
    stats.buildings++;
    const cell = cellFor(info.cx, info.cz);
    cell.walls.current = cell.roofs.current = j;
    const rnd = (k) => hash(j * 977 + k * 131 + 7);
    const styleSeed = info.style + info.seed;
    const groundSigned = info.shops ? info.groundH : -info.groundH;
    const bcol = [info.wall[0], info.wall[1], info.wall[2], info.flags];
    cell.walls.building([styleSeed, info.floorH, groundSigned, info.storeyTop],
      bcol, [info.accent[0], info.accent[1], info.accent[2], Math.floor(rnd(1) * 255)]);
    const rise = Math.max(b.top - b.eave, 0);
    cell.roofs.building([styleSeed, info.floorH, rise, info.wallH], bcol,
      [info.roof[0], info.roof[1], info.roof[2], info.cover]);

    const runsOf = rings.map((r) => facadeRuns(r));
    const segOf = rings.map((r, k) => {
      const n = r.length / 2, out = new Array(n);
      for (let i = 0; i < n; i++) {
        const q = (i + 1) % n;
        const L = Math.hypot(r[2 * q] - r[2 * i], r[2 * q + 1] - r[2 * i + 1]);
        out[i] = { L, segs: splitEdge(L, shared[j][k][i], topOf, partyOf) };
      }
      return out;
    });

    // --- Walls
    rings.forEach((r, k) => {
      const R = runsOf[k];
      for (let i = 0, n = r.length / 2; i < n; i++) {
        if (R.run[i] < 0) continue;
        const q = (i + 1) % n;
        const { L, segs } = segOf[k][i];
        for (const [t0, t1, top, party] of segs) {
          const kind = party && top > -Infinity ? WALL.BLANK : R.jog[i] ? WALL.SOLID : k > 0 ? WALL.REAR : WALL.FRONT;
          for (const [p0, p1, low] of skipPieces(r[2 * i], r[2 * i + 1], r[2 * q], r[2 * q + 1], t0, t1, b.skip)) {
            const y0 = Math.max(b.base, top, low);
            if (y0 >= b.eave - 0.05) continue;
            const s0 = p0 / L, s1 = p1 / L;
            wall(cell.walls,
              lerp(r[2 * i], r[2 * q], s0), lerp(r[2 * i + 1], r[2 * q + 1], s0),
              lerp(r[2 * i], r[2 * q], s1), lerp(r[2 * i + 1], r[2 * q + 1], s1),
              y0, b.eave, b.ground, lerp(R.u0[i], R.u1[i], s0), lerp(R.u0[i], R.u1[i], s1), R.runLen[i], kind);
          }
        }
      }
    });

    if (info.style === STYLE.ROMANTIC) stats.miradores += addMiradores(cell.walls, b, rings[0], runsOf[0], segOf[0], info, rnd);

    // --- Roofs
    // Edges against a neighbour whose roof meets ours get no eaves and no slope: a gable (or a shared parapet)
    const weights = rings.map((r, k) => segOf[k].map(({ L, segs }) => {
      let covered = 0;
      for (const [t0, t1, top, party] of segs) if (party && top >= b.eave - 1.2) covered += t1 - t0;
      return covered >= 0.5 * L ? 0 : 1;
    }));
    const flat = info.flat || b.kind === 1;
    if (flat) {
      flatRoof(cell.roofs, b, rings, runsOf, segOf, info, triangulate, rnd, stats);
      return;
    }
    pitchedRoof(cell.roofs, b, rings, runsOf, segOf, weights, info, triangulate, rnd, stats);
  });

  return { cells, stats };
}

function flatRoof(part, b, rings, runsOf, segOf, info, triangulate, rnd, stats) {
  let level = b.eave - info.parapet;
  let inner = null;
  if (info.parapet > 0) {
    inner = rings.map((r) => offsetRing(r, new Array(r.length / 2).fill(-PARAPET_T), 0.3));
    if (inner.some((r) => !r)) { inner = null; level = b.eave; }
  }
  cap(part, rings, level, SURF.FLAT, triangulate, level - b.eave);
  if (inner) {
    rings.forEach((r, k) => {
      const s = inner[k], R = runsOf[k];
      for (let i = 0, n = r.length / 2; i < n; i++) {
        const q = (i + 1) % n;
        const { L, segs } = segOf[k][i];
        if (L < 0.05) continue;
        let prevOn = null;
        for (const [t0, t1, top] of segs) {
          // A neighbour standing at least as high as our roof hides the parapet's inner face
          const on = top < level + 0.3;
          const a0 = t0 / L, a1 = t1 / L;
          const ox0 = lerp(r[2 * i], r[2 * q], a0), oz0 = lerp(r[2 * i + 1], r[2 * q + 1], a0);
          const ox1 = lerp(r[2 * i], r[2 * q], a1), oz1 = lerp(r[2 * i + 1], r[2 * q + 1], a1);
          const ix0 = lerp(s[2 * i], s[2 * q], a0), iz0 = lerp(s[2 * i + 1], s[2 * q + 1], a0);
          const ix1 = lerp(s[2 * i], s[2 * q], a1), iz1 = lerp(s[2 * i + 1], s[2 * q + 1], a1);
          const u0 = lerp(R.u0[i], R.u1[i], a0), u1 = lerp(R.u0[i], R.u1[i], a1);
          if (on) {
            // inner face looks into the roof: run it backwards so its normal points inward
            wall(part, ix1, iz1, ix0, iz0, level, b.eave, b.eave, u1, u0, R.runLen[i], SURF.PARAPET);
            part.quad([[ox0, b.eave, oz0], [ox1, b.eave, oz1], [ix1, b.eave, iz1], [ix0, b.eave, iz0]],
              [[u0, 0], [u1, 0], [u1, 0], [u0, 0]], R.runLen[i], SURF.PARAPET);
          }
          if (prevOn !== null && prevOn !== on) {
            // parapet end against a party wall: closed both ways
            wall(part, ox0, oz0, ix0, iz0, level, b.eave, b.eave, 0, PARAPET_T, PARAPET_T, SURF.PARAPET);
            wall(part, ix0, iz0, ox0, oz0, level, b.eave, b.eave, 0, PARAPET_T, PARAPET_T, SURF.PARAPET);
          }
          prevOn = on;
        }
      }
    });
  }
  // Lift housing & stair head on blocks of flats (b5m's maximum height over a flat roof is mostly these)
  const tall = info.storeyTop > 10 && info.area > 140;
  if (info.housing > 0 || (tall && (info.style === STYLE.MODERN || info.style === STYLE.CONTEMPORARY || info.style === STYLE.ROMANTIC))) {
    const p = interiorPoint(rings, rnd, 2.2);
    if (p) {
      const big = info.storeyTop > 28;
      const angle = longestEdgeAngle(rings[0]);
      const hgt = info.housing > 0 ? Math.max(2.4, info.housing) : big ? 3.4 : 2.6;
      box(part, p[0], p[1], big ? 2.2 : 1.6, big ? 1.8 : 1.3, angle, level - 0.1, level + hgt, SURF.HOUSING);
      stats.housings++;
    }
  }
}

function pitchedRoof(part, b, rings, runsOf, segOf, weights, info, triangulate, rnd, stats) {
  const rise = b.top - b.eave;
  const mansard = b.roof === 2;
  const pitch = mansard ? 70 : info.style === STYLE.OLDTOWN || info.style === STYLE.VILLA ? 32 : 35;
  const tanP = Math.tan((pitch * Math.PI) / 180);
  if (weights.every((w) => w.every((x) => x === 0))) {
    // walled in all round by neighbours as tall: a flat roof at the eaves
    cap(part, rings, b.eave, SURF.FLAT, triangulate);
    return;
  }
  let d = rise / tanP, inner = null;
  for (let attempt = 0; attempt < 5 && !inner; attempt++, d *= 0.6) {
    const rs = rings.map((r, k) => offsetRing(r, weights[k].map((w) => -d * w)));
    if (rs.every(Boolean)) inner = rs;
  }
  if (!inner) {
    cap(part, rings, b.eave, SURF.FLAT, triangulate);
    return;
  }
  d /= 0.6;
  const top = b.eave + Math.min(rise, d * tanP);
  // Eaves overhang on free edges (wooden eaves of the Parte Vieja & villas, a cornice elsewhere); small light wells
  // keep their opening
  const outer = rings.map((r, k) => {
    const area = Math.abs(signedArea(r));
    const ov = k > 0 ? (area < 40 ? 0 : Math.min(info.overhang, 0.4)) : mansard ? 0.35 : info.overhang;
    if (ov <= 0) return r;
    return offsetRing(r, weights[k].map((w) => w * ov), 0.5) || r;
  });
  const surf = mansard ? SURF.MANSARD : SURF.PITCHED;
  rings.forEach((r, k) => {
    const o = outer[k], s = inner[k], R = runsOf[k];
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const { L } = segOf[k][i];
      if (L < 0.05) continue;
      const u0 = R.run[i] < 0 ? 0 : R.u0[i], u1 = R.run[i] < 0 ? L : R.u1[i], len = R.run[i] < 0 ? L : R.runLen[i];
      // A party edge rises as a vertical gable; the neighbour's gable on the same line faces the other way, so the
      // two never fight
      const gable = weights[k][i] === 0;
      part.quad([[o[2 * i], b.eave, o[2 * i + 1]], [o[2 * q], b.eave, o[2 * q + 1]], [s[2 * q], top, s[2 * q + 1]], [s[2 * i], top, s[2 * i + 1]]],
        [[u0, 0], [u1, 0], [u1, top - b.eave], [u0, top - b.eave]], len, gable ? SURF.PARAPET : surf);
      if (o !== r && !gable) {
        // underside of the eaves, from the wall below the roof line out to the roof's edge
        const ys = b.eave - FASCIA;
        part.quad([[r[2 * i], ys, r[2 * i + 1]], [r[2 * q], ys, r[2 * q + 1]], [o[2 * q], b.eave, o[2 * q + 1]], [o[2 * i], b.eave, o[2 * i + 1]]],
          [[u0, -FASCIA], [u1, -FASCIA], [u1, 0], [u0, 0]], len, SURF.EAVES);
      }
    }
  });
  cap(part, inner, top, mansard ? SURF.FLAT : SURF.PITCHED, triangulate, top - b.eave);

  // Chimney stacks: on the ridge of tiled houses, in a row on the flat top of a mansard
  const chimneyShare = info.style === STYLE.OLDTOWN ? 0.75 : info.style === STYLE.VILLA ? 0.6 : info.style === STYLE.ROMANTIC ? 0.7 : 0.25;
  if (b.kind === 0 && rnd(40) < chimneyShare && info.area > 30) {
    const count = mansard ? 1 + Math.floor(rnd(41) * 3) : 1;
    const angle = longestEdgeAngle(rings[0]);
    for (let c = 0; c < count; c++) {
      const p = interiorPoint(inner, (t) => rnd(50 + c * 30 + t), 0.5);
      if (!p) break;
      const w = 0.3 + rnd(42 + c) * 0.18, hgt = 1.0 + rnd(43 + c) * 0.7;
      box(part, p[0], p[1], w, w * (mansard ? 1.8 : 1.2), angle, top - 0.4, top + hgt, SURF.CHIMNEY);
      stats.chimneys++;
    }
  }
}

// Miradores: glazed bay windows standing out of the Belle Époque fronts, over the middle bay of long fronts and the
// whole of the chamfered corners, from the first floor to the top floor (or the one below)
function addMiradores(part, b, ring, R, segs, info, rnd) {
  if (rnd(60) > 0.7 || info.storeyTop - info.groundH < 2 * info.floorH - 0.1) return 0;
  const nUp = Math.round((info.storeyTop - info.groundH) / info.floorH);
  const storeys = nUp - (rnd(61) < 0.5 ? 1 : 0);
  if (storeys < 2) return 0;
  const y0 = b.ground + info.groundH, y1 = y0 + storeys * info.floorH;
  const n = ring.length / 2;
  // runs of the outer ring: length and the edges they span
  const runs = new Map();
  for (let i = 0; i < n; i++) {
    if (R.run[i] < 0) continue;
    if (!runs.has(R.run[i])) runs.set(R.run[i], { len: R.runLen[i], edges: [] });
    runs.get(R.run[i]).edges.push(i);
  }
  let count = 0;
  for (const [id, run] of runs) {
    if (run.len < 2.6) continue;
    const lay = bayLayout(run.len, STYLE.ROMANTIC);
    const pickBays = [];
    if (lay.bays <= 2 && run.len < 9) {
      if (rnd(70 + id) < 0.55) for (let k = 0; k < lay.bays; k++) pickBays.push(k);
    } else if (lay.bays >= 3) {
      if (lay.bays % 2) pickBays.push((lay.bays - 1) / 2);
      else if (rnd(80 + id) < 0.6) pickBays.push(lay.bays / 2 - 1, lay.bays / 2);
      if (lay.bays >= 5 && rnd(90 + id) < 0.35) pickBays.push(0, lay.bays - 1);
    }
    for (const bay of pickBays) {
      const w = Math.min(lay.bayW * 0.86, 3.0);
      if (w < 1.2) continue;
      const uc = lay.pier + (bay + 0.5) * lay.bayW;
      const ua = uc - w / 2, ub = uc + w / 2;
      const pa = pointAt(ring, R, run.edges, ua), pb = pointAt(ring, R, run.edges, ub);
      if (!pa || !pb) continue;
      // straight stretch of wall only, and none of it hidden behind a neighbour above the ground floor
      let ok = true;
      for (const i of run.edges) {
        if (R.u1[i] < ua || R.u0[i] > ub) continue;
        if (R.jog[i]) { ok = false; break; }
        const vx = ring[2 * i], vz = ring[2 * i + 1];
        if (R.u0[i] > ua && R.u0[i] < ub && chordDistance(pa, pb, vx, vz) > 0.08) { ok = false; break; }
        for (const [t0, t1, top] of segs[i].segs) {
          const L = segs[i].L, e0 = lerp(R.u0[i], R.u1[i], t0 / L), e1 = lerp(R.u0[i], R.u1[i], t1 / L);
          if (e1 > ua && e0 < ub && top > y0) { ok = false; break; }
        }
        if (!ok) break;
      }
      if (!ok) continue;
      const dx = pb.x - pa.x, dz = pb.z - pa.z;
      const len = Math.hypot(dx, dz);
      if (len < 1) continue;
      const nx = dz / len, nz = -dx / len;
      const depth = w > 2.2 ? 0.8 : 0.65;
      const fa = [pa.x + nx * depth, pa.z + nz * depth], fb = [pb.x + nx * depth, pb.z + nz * depth];
      const g = b.ground;
      // front, sides, soffit and a little zinc roof
      wall(part, fa[0], fa[1], fb[0], fb[1], y0, y1, g, 0, len, len, WALL.MIRADOR);
      wall(part, pa.x, pa.z, fa[0], fa[1], y0, y1, g, 0, depth, depth, WALL.MIRADOR);
      wall(part, fb[0], fb[1], pb.x, pb.z, y0, y1, g, 0, depth, depth, WALL.MIRADOR);
      part.quad([[pa.x, y0, pa.z], [pb.x, y0, pb.z], [fb[0], y0, fb[1]], [fa[0], y0, fa[1]]],
        [[0, y0 - g], [len, y0 - g], [len, y0 - g], [0, y0 - g]], len, WALL.MIRADOR);
      part.quad([[pa.x, y1, pa.z], [fa[0], y1, fa[1]], [fb[0], y1, fb[1]], [pb.x, y1, pb.z]],
        [[0, y1 - g], [0, y1 - g], [len, y1 - g], [len, y1 - g]], len, WALL.MIRADOR);
      count++;
    }
  }
  return count;
}

function pointAt(ring, R, edges, u) {
  const n = ring.length / 2;
  for (const i of edges) {
    if (u < R.u0[i] - 1e-6 || u > R.u1[i] + 1e-6 || R.u1[i] - R.u0[i] < 1e-6) continue;
    const t = (u - R.u0[i]) / (R.u1[i] - R.u0[i]);
    const q = (i + 1) % n;
    return { x: lerp(ring[2 * i], ring[2 * q], t), z: lerp(ring[2 * i + 1], ring[2 * q + 1], t) };
  }
  return null;
}

function chordDistance(a, b, x, z) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return Math.abs((x - a.x) * dz - (z - a.z) * dx) / l;
}
