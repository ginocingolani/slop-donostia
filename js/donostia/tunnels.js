import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, attribute, positionWorld, cameraPosition, normalize, dot, sqrt, max, min, abs, mix, smoothstep,
  step, floor, fract, sin, exp, select, fwidth, mx_noise_float, atan, sign
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { TUNNELS } from './data-tunnels.js';

// js/donostia/tunnels.js
// The tunnels' portals (tools/donostia/tunnels.mjs, written by tools/donostia/build.mjs to js/donostia/data-tunnels.js).
// Where a road, a path or a railway runs into the hill the terrain steps at the portal's face, a hidden wall of
// GEO.terrain.walls (js/donostia/shore-walls.js); here that face is built: masonry from below the road up to the ground
// over the bore, an arched opening and, through it, the bore going in, traced from the view ray (interior mapping, as
// La Concha's arcade in js/donostia/shore.js: its walls, vault and floor of the opening's section, the lamps along it,
// the far portal's daylight where the bore is short enough to see through; no geometry behind the face). Over the
// head a cornice, and on the old stone portals a parapet with a white railing.
// - the Miramar tunnel (1890, under the palace's gardens; OSM's road and bike lane share it): cream limestone ashlar, a
//   ring of voussoirs round its semicircular arch, its lining light between dark ribs. After Wikimedia Commons:
//   «Miramar tunela» (Joxemai, CC BY-SA 4.0) and the engraving «El túnel del Antiguo» (La Ilustración Española y
//   Americana, 15 September 1890, public domain)
// - the Pico del Loro's footway (Loretopeko tunela): red sandstone ashlar round a grey concrete ring, white walls under
//   the blue & green painted vault of ItsasArte MiramArt (2016). After Wikimedia Commons: «ITSASARTE MIRAMART - TÚNEL
//   MIRAMAR - Tunnel in San Sebastian (Basque Country)» photos 1-3 (Sami Mlouhi, CC BY-SA 4.0)
// - the others (the bypass's, Lugaritz's, the railways'...): board-marked concrete, a plain surround, a grey lining
// The photographs are references only: nothing derived from their pixels is used.
// Draws: two (the faces; the cornices, parapets & railings), two materials. buildTunnels() -> Object3D | null

// as tools/donostia/tunnels.mjs's STONE
const STONE = { limestone: 0, sandstone: 1, concrete: 2 };
// Per stone: the face (sRGB), its courses & blocks (m), the arch's ring, the bore's lining & ribs, its floor, the
// cornice, the railing (none: a plain concrete parapet)
const FINISH = {
  [STONE.limestone]: {
    face: 0xc4b596, course: 0.46, block: 1.05, ring: 0xd2c6aa, lining: 0xa9a7a0, rib: 0x3a3936, floor: 0x2b2b2d,
    cornice: 0xd5ccb6, rail: 0xe9e7e0
  },
  [STONE.sandstone]: {
    face: 0xa47f71, course: 0.3, block: 0.62, ring: 0x7d7a73, lining: 0xdcdedc, rib: 0xb8bcbc, floor: 0x9a978f,
    cornice: 0xa8a198, rail: 0xe9e7e0
  },
  [STONE.concrete]: {
    face: 0x9a9893, course: 1.2, block: 2.4, ring: 0xaeaca6, lining: 0x8d8c87, rib: 0x5b5a56, floor: 0x2f2f31,
    cornice: 0xa7a59f, rail: null
  }
};
const BURY = 0.8; // m the face goes on under the road
const CORNICE = { h: 0.32, over: 0.12, back: 0.55 }; // m: its height under the ground's level, its projection, its depth
const PARAPET = { h: 0.32, t: 0.42 }; // m: the plinth over the ground (the railing on it), its thickness
const CONCRETE_PARAPET = 0.9; // m: the concrete portals' parapet over the ground
const RAIL = { h: 1.0, post: 0.05, every: 1.3 }; // m: the railing over its plinth, its posts & their spacing
const RETURN = 0.9; // m: how far each end of a face turns back into the hill
const PIER = 1.6; // m: a corner pier's sides, along the face and along the wall that runs on from it

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

// --- geometry --------------------------------------------------------------------------------------------------------------

// The faces: per segment of each face's line a quad from under the road to the ground over the bore, carrying its
// opening (the one nearest along the face): aU (m along the face), aOpen (centre u, half span, floor, springing),
// aArch (the arch circle's centre height & radius, the ring's depth, the stone), aBore (the bore's direction into the
// hill, the opening's centre on the face), aLen (the bore's length). A quad with no opening has half = -1.
function faceGeometry(portals) {
  const pos = [], nrm = [], col = [], u = [], open = [], arch = [], bore = [], len = [], idx = [];
  const vertex = (x, y, z, n, c, uu, o) => {
    pos.push(x, y, z); nrm.push(n[0], 0, n[1]); col.push(...c); u.push(uu);
    open.push(o.uc, o.half, o.floor, o.spring); arch.push(o.cy, o.R, o.ring, o.stone); bore.push(o.ax, o.az, o.ox, o.oz); len.push(o.len);
  };
  const quad = (a, b, c, d) => { idx.push(a, b, c, b, d, c); };
  for (const P of portals) {
    const F = FINISH[P.k] || FINISH[STONE.concrete];
    const face = lin(F.face);
    const p = P.p, n = p.length / 4;
    const V = [];
    let along = 0;
    for (let k = 0; k < n; k++) {
      if (k) along += Math.hypot(p[4 * k] - p[4 * k - 4], p[4 * k + 1] - p[4 * k - 3]);
      V.push({ x: p[4 * k], z: p[4 * k + 1], deck: p[4 * k + 2], foot: p[4 * k + 3], u: along });
    }
    // each opening's shape and bore, where it sits on the face
    const at = (uu) => {
      for (let k = 0; k + 1 < V.length; k++) {
        const A = V[k], B = V[k + 1];
        if (uu <= B.u || k + 2 === V.length) {
          const t = (uu - A.u) / Math.max(B.u - A.u, 1e-6);
          return [A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t];
        }
      }
      return [V[0].x, V[0].z];
    };
    const openings = P.o.map(([u0, u1, fl, spring, rise, ring, ax, az, l]) => {
      const half = (u1 - u0) / 2, R = (half * half + rise * rise) / (2 * rise);
      const [ox, oz] = at((u0 + u1) / 2);
      return { uc: (u0 + u1) / 2, half, floor: fl, spring: fl + spring, cy: fl + spring + rise - R, R, ring, stone: P.k, ax, az, ox, oz, len: l };
    });
    const none = { ...openings[0], half: -1 };
    for (let k = 0; k + 1 < V.length; k++) {
      const A = V[k], B = V[k + 1], l = B.u - A.u;
      if (l < 1e-6) continue;
      const tx = (B.x - A.x) / l, tz = (B.z - A.z) / l, nn = [-tz, tx];
      const mid = (A.u + B.u) / 2;
      const o = openings.reduce((best, q) => (Math.abs(q.uc - mid) < Math.abs(best.uc - mid) ? q : best), openings[0]);
      const base = pos.length / 3;
      vertex(A.x, A.foot - BURY, A.z, nn, face, A.u, o);
      vertex(A.x, A.deck, A.z, nn, face, A.u, o);
      vertex(B.x, B.foot - BURY, B.z, nn, face, B.u, o);
      vertex(B.x, B.deck, B.z, nn, face, B.u, o);
      quad(base, base + 2, base + 1, base + 3);
    }
    // the ends turn back into the hill (the terrain beside them stands off the face)
    for (const [E, F2, sg] of [[V[0], V[1], -1], [V[V.length - 1], V[V.length - 2], 1]]) {
      const l = Math.hypot(E.x - F2.x, E.z - F2.z) || 1;
      const tx = (E.x - F2.x) / l, tz = (E.z - F2.z) / l; // outwards along the face at this end
      // back into the hill: away from the low side (on the left of the face's travel)
      const lowX = -sg * tz, lowZ = sg * tx;
      const hx = -lowX * RETURN, hz = -lowZ * RETURN;
      const base = pos.length / 3;
      vertex(E.x, E.foot - BURY, E.z, [tx, tz], face, E.u, none);
      vertex(E.x, E.deck, E.z, [tx, tz], face, E.u, none);
      vertex(E.x + hx, E.foot - BURY, E.z + hz, [tx, tz], face, E.u + RETURN * sg, none);
      vertex(E.x + hx, E.deck, E.z + hz, [tx, tz], face, E.u + RETURN * sg, none);
      if (sg > 0) quad(base, base + 2, base + 1, base + 3);
      else quad(base, base + 1, base + 2, base + 3);
    }
    // a pier in each corner where a retaining wall runs on from the face (the 2 m terrain cannot turn that corner: a
    // sample in it ramps from one wall's top to the other's foot): its two faces square to the face and to the wall
    (P.e || []).forEach((d, end) => {
      if (!d) return;
      const E = end ? V[V.length - 1] : V[0], N = end ? V[V.length - 2] : V[1];
      const l = Math.hypot(N.x - E.x, N.z - E.z) || 1, tx = (N.x - E.x) / l, tz = (N.z - E.z) / l;
      const edge = openings.reduce((m, o) => Math.min(m, Math.abs((end ? V[V.length - 1].u - (o.uc + o.half) : o.uc - o.half - V[0].u))), Infinity);
      const pf = Math.min(PIER, edge - 0.25), pw = PIER;
      if (pf < 0.5) return;
      const [dx, dz] = d;
      const A1 = [E.x + tx * pf, E.z + tz * pf], A2 = [A1[0] + dx * pw, A1[1] + dz * pw], A3 = [E.x + dx * pw, E.z + dz * pw];
      const y0 = E.foot - BURY, y1 = E.deck;
      const side = (a, b, away) => {
        const sx = b[0] - a[0], sz = b[1] - a[1], sl = Math.hypot(sx, sz) || 1;
        let nx = -sz / sl, nz = sx / sl;
        if (nx * away[0] + nz * away[1] < 0) { nx = -nx; nz = -nz; }
        const base = pos.length / 3;
        vertex(a[0], y0, a[1], [nx, nz], face, 0, none);
        vertex(a[0], y1, a[1], [nx, nz], face, 0, none);
        vertex(b[0], y0, b[1], [nx, nz], face, sl, none);
        vertex(b[0], y1, b[1], [nx, nz], face, sl, none);
        // wound to face (nx, nz): on the left of a -> b, or on its right
        if (sx * nz - sz * nx > 0) quad(base, base + 2, base + 1, base + 3); else quad(base, base + 1, base + 2, base + 3);
      };
      side(A1, A2, [tx, tz]);
      side(A2, A3, [dx, dz]);
      // its top, level with the ground behind
      const base = pos.length / 3;
      for (const [x, z] of [[E.x, E.z], A1, A3, A2]) vertex(x, y1, z, [0, 0], face, 0, none);
      nrm.splice(nrm.length - 12, 12, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0);
      const cross = (A1[0] - E.x) * (A3[1] - E.z) - (A1[1] - E.z) * (A3[0] - E.x);
      if (cross < 0) quad(base, base + 1, base + 2, base + 3); else quad(base, base + 2, base + 1, base + 3);
    });
  }
  return { pos, nrm, col, u, open, arch, bore, len, idx };
}

// The cornices along the faces' heads, the parapets & railings over them: flat-shaded boxes in plain colours
function trimGeometry(portals) {
  const pos = [], nrm = [], col = [];
  const tri = (a, b, c, n, colour) => {
    // wound to face n
    const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (cx * n[0] + cy * n[1] + cz * n[2] >= 0) pos.push(...a, ...b, ...c); else pos.push(...a, ...c, ...b);
    for (let k = 0; k < 3; k++) { nrm.push(...n); col.push(...colour); }
  };
  const quad = (a, b, c, d, n, colour) => { tri(a, b, c, n, colour); tri(b, d, c, n, colour); };
  // a box swept along a polyline: a section [o0, o1] x [y0(v), y1(v)] (o across, + towards the low side)
  const sweep = (V, o0, o1, y0, y1, colour, caps = true) => {
    for (let k = 0; k + 1 < V.length; k++) {
      const A = V[k], B = V[k + 1];
      const pt = (Q, o, y) => [Q.x + Q.nx * o, y, Q.z + Q.nz * o];
      const n = [A.nx + B.nx, 0, A.nz + B.nz], nl = Math.hypot(n[0], n[2]) || 1;
      const front = [n[0] / nl, 0, n[2] / nl], back = [-front[0], 0, -front[2]];
      quad(pt(A, o1, y0(A)), pt(B, o1, y0(B)), pt(A, o1, y1(A)), pt(B, o1, y1(B)), front, colour);
      quad(pt(A, o0, y0(A)), pt(B, o0, y0(B)), pt(A, o0, y1(A)), pt(B, o0, y1(B)), back, colour);
      quad(pt(A, o0, y1(A)), pt(B, o0, y1(B)), pt(A, o1, y1(A)), pt(B, o1, y1(B)), [0, 1, 0], colour);
      quad(pt(A, o0, y0(A)), pt(B, o0, y0(B)), pt(A, o1, y0(A)), pt(B, o1, y0(B)), [0, -1, 0], colour);
    }
    if (!caps) return;
    for (const [Q, R2] of [[V[0], V[1]], [V[V.length - 1], V[V.length - 2]]]) {
      const l = Math.hypot(Q.x - R2.x, Q.z - R2.z) || 1, n = [(Q.x - R2.x) / l, 0, (Q.z - R2.z) / l];
      const pt = (o, y) => [Q.x + Q.nx * o, y, Q.z + Q.nz * o];
      quad(pt(o0, y0(Q)), pt(o1, y0(Q)), pt(o0, y1(Q)), pt(o1, y1(Q)), n, colour);
    }
  };
  for (const P of portals) {
    const F = FINISH[P.k] || FINISH[STONE.concrete];
    const p = P.p, n = p.length / 4;
    // the face's vertices with their low-side normals (the mean of their segments')
    const V = [];
    for (let k = 0; k < n; k++) {
      let nx = 0, nz = 0;
      for (const s of [k - 1, k]) {
        if (s < 0 || s >= n - 1) continue;
        const dx = p[4 * s + 4] - p[4 * s], dz = p[4 * s + 5] - p[4 * s + 1], l = Math.hypot(dx, dz) || 1;
        nx += -dz / l; nz += dx / l;
      }
      const l = Math.hypot(nx, nz) || 1;
      V.push({ x: p[4 * k], z: p[4 * k + 1], deck: p[4 * k + 2], nx: nx / l, nz: nz / l });
    }
    const cornice = lin(F.cornice);
    sweep(V, -CORNICE.back, CORNICE.over, (q) => q.deck - CORNICE.h, (q) => q.deck + 0.04, cornice);
    if (!F.rail) {
      // a plain parapet of the concrete
      sweep(V, -PARAPET.t - 0.05, -0.05, (q) => q.deck, (q) => q.deck + CONCRETE_PARAPET, lin(F.face));
      continue;
    }
    sweep(V, -PARAPET.t - 0.04, -0.04, (q) => q.deck, (q) => q.deck + PARAPET.h, cornice);
    // the railing: posts along it, a handrail and a middle rail, on the plinth's middle
    const rail = lin(F.rail), o = -PARAPET.t / 2 - 0.04, w = RAIL.post / 2;
    const top = (q) => q.deck + PARAPET.h + RAIL.h;
    sweep(V, o - 0.03, o + 0.03, (q) => top(q) - 0.05, top, rail, false);
    sweep(V, o - 0.015, o + 0.015, (q) => q.deck + PARAPET.h + 0.12, (q) => q.deck + PARAPET.h + 0.16, rail, false);
    sweep(V, o - 0.015, o + 0.015, (q) => q.deck + PARAPET.h + RAIL.h * 0.55, (q) => q.deck + PARAPET.h + RAIL.h * 0.55 + 0.03, rail, false);
    for (let k = 0; k + 1 < V.length; k++) {
      const A = V[k], B = V[k + 1], l = Math.hypot(B.x - A.x, B.z - A.z);
      const tx = (B.x - A.x) / (l || 1), tz = (B.z - A.z) / (l || 1);
      for (let s = k ? 0 : 0.1; s < l - 0.05; s += RAIL.every) {
        const f = s / (l || 1), deck = A.deck + (B.deck - A.deck) * f;
        const cx = A.x + (B.x - A.x) * f + A.nx * o, cz = A.z + (B.z - A.z) * f + A.nz * o;
        const y0 = deck + PARAPET.h, y1 = deck + PARAPET.h + RAIL.h;
        const c = (a, b) => [cx + tx * a - tz * b, cz + tz * a + tx * b];
        const corners = [c(-w, -w), c(w, -w), c(w, w), c(-w, w)];
        for (let e = 0; e < 4; e++) {
          const [ax, az] = corners[e], [bx, bz] = corners[(e + 1) % 4];
          const el = Math.hypot(bx - ax, bz - az) || 1;
          quad([ax, y0, az], [bx, y0, bz], [ax, y1, az], [bx, y1, bz], [(bz - az) / el, 0, -(bx - ax) / el], rail);
        }
      }
    }
  }
  return { pos, nrm, col };
}

// --- materials -------------------------------------------------------------------------------------------------------------

const hash = Fn(([q]) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453)));
const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);

// The faces: ashlar (or board-marked concrete) round the opening, the arch's ring, and the bore through the opening
function faceMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  const u = attribute('aU', 'float'), op = attribute('aOpen', 'vec4'), ar = attribute('aArch', 'vec4');
  const bo = attribute('aBore', 'vec4'), boreLen = attribute('aLen', 'float');
  const base = attribute('color', 'vec3');
  const P = positionWorld, y = P.y;
  const uc = op.x, half = op.y, floorY = op.z, springY = op.w;
  const cy = ar.x, R = ar.y, ring = ar.z, stone = ar.w;
  const concrete = step(1.5, stone), sandstone = step(0.5, stone).mul(float(1).sub(concrete));
  const limestone = float(1).sub(step(0.5, stone));
  const lu = u.sub(uc).toVar();
  const aa = fwidth(u).add(fwidth(y)).max(0.002).toVar();
  // the opening: the jambs under the springing, the arch's circle over it (signed distance, + inside)
  const dc = vec2(lu, y.sub(cy)).length().toVar();
  const inside = select(y.lessThan(springY), min(half.sub(abs(lu)), y.sub(floorY)), min(R.sub(dc), y.sub(floorY)));
  const open = smoothstep(aa.negate(), aa, inside).mul(step(0, half)).toVar();
  // the ring round the arch (the voussoirs, or the concrete surround down the jambs too)
  const ringD = select(y.lessThan(springY), abs(lu).sub(half), dc.sub(R));
  const ringBand = smoothstep(aa.negate(), aa, ringD).mul(smoothstep(aa.negate(), aa, ring.sub(ringD))).mul(step(0, half))
    .mul(max(step(springY.sub(0.02), y), max(concrete, sandstone))).mul(step(floorY, y)).toVar();

  // the masonry: courses & blocks (the ring's voussoirs radial), tones per block, the joints
  const course = mix(mix(float(FINISH[0].course), float(FINISH[1].course), sandstone), float(FINISH[2].course), concrete);
  const block = mix(mix(float(FINISH[0].block), float(FINISH[1].block), sandstone), float(FINISH[2].block), concrete);
  const cyN = y.div(course).toVar();
  const row = floor(cyN);
  const cuN = u.div(block).add(row.mul(0.5)).toVar();
  const theta = atan(y.sub(cy), lu); // 0 .. pi over the arch
  const vous = max(float(1), floor(R.mul(Math.PI).div(0.6)));
  const vN = theta.div(Math.PI).mul(vous).toVar();
  const jointW = mix(float(0.012), float(0.004), concrete);
  const jw = (d, s) => smoothstep(jointW.add(fwidth(d).mul(s)), jointW, min(fract(d), float(1).sub(fract(d))).mul(s));
  const jointsWall = max(jw(cyN, course), jw(cuN, block));
  const jointsRing = jw(vN, R.mul(Math.PI).div(vous)).mul(float(1).sub(concrete));
  const joints = mix(jointsWall, jointsRing, ringBand).mul(float(1).sub(open)).toVar();
  const tone = hash(vec2(floor(mix(cuN, vN, ringBand)), mix(row, float(7), ringBand)));
  const grain = mx_noise_float(P.mul(1.3)).mul(0.07).add(mx_noise_float(P.mul(0.3)).mul(0.08)).toVar();
  const ringCol = mix(mix(vec3(...lin(FINISH[0].ring)), vec3(...lin(FINISH[1].ring)), sandstone), vec3(...lin(FINISH[2].ring)), concrete);
  const stoneCol = mix(base, ringCol, ringBand).mul(tone.sub(0.5).mul(mix(0.22, 0.08, concrete)).add(1)).mul(grain.add(1));
  const masonry = mix(stoneCol, stoneCol.mul(0.62), joints)
    // damp & grime at the foot and streaks down the face
    .mul(mix(float(1), float(0.78), smoothstep(1.2, 0.0, y.sub(floorY)).mul(step(0, half))))
    .mul(float(1).sub(smoothstep(0.55, 0.85, mx_noise_float(vec3(u.mul(0.5), y.mul(0.05), 2.3))).mul(0.16)));

  // The bore: the view ray from this point of the opening, in the bore's frame (A into the hill, W across it), its
  // across measured in the face's metres (the face may cross the bore at a skew: the bore's section is the opening's)
  const rd = normalize(P.sub(cameraPosition)).toVar();
  const A = vec2(bo.x, bo.y), W = vec2(bo.y.negate(), bo.x);
  const faceN = attribute('normal', 'vec3').xz;
  const skew = abs(dot(faceN, A)).max(0.3);
  const rel = P.xz.sub(bo.zw);
  const s0 = dot(rel, A), a0 = lu;
  const along = vec2(faceN.y, faceN.x.negate()); // (the face's way, u growing)
  const ds = dot(rd.xz, A).max(0.02), da = dot(rd.xz, W).div(skew).mul(sign(dot(W, along))), dy = rd.y;
  const big = float(1e4);
  const tWall = select(abs(da).greaterThan(1e-4), sign(da).mul(half).sub(a0).div(da), big).max(0);
  const tFloor = select(dy.lessThan(-1e-4), floorY.sub(y).div(dy), big).max(0);
  const iy = y.sub(cy);
  const qa = da.mul(da).add(dy.mul(dy)).max(1e-6), qb = a0.mul(da).add(iy.mul(dy)), qc = a0.mul(a0).add(iy.mul(iy)).sub(R.mul(R));
  const tVault = qb.negate().add(sqrt(max(qb.mul(qb).sub(qa.mul(qc)), 0))).div(qa);
  const yWall = y.add(dy.mul(tWall));
  const tSide = select(yWall.lessThan(springY), tWall, tVault);
  const onFloor = step(tFloor, tSide).toVar();
  const tHit = min(tSide, tFloor).toVar();
  const depth = s0.add(ds.mul(tHit)).max(0).toVar();
  const hitY = y.add(dy.mul(tHit)), hitA = a0.add(da.mul(tHit));
  const onVault = float(1).sub(onFloor).mul(step(springY, hitY.add(0.01)));
  // the far portal: daylight where the ray reaches the bore's other end before any surface
  const through = step(boreLen, depth).toVar();
  // surfaces: the floor (the road's asphalt, a path's paving), the lining with ribs across it every 3 m (on the
  // footway's vault the painted sea, blues & greens)
  const ribs = smoothstep(0.4, 0.44, abs(fract(depth.div(3)).sub(0.5))).mul(float(1).sub(onFloor));
  const liningCol = mix(mix(vec3(...lin(FINISH[0].lining)), vec3(...lin(FINISH[1].lining)), sandstone), vec3(...lin(FINISH[2].lining)), concrete);
  const ribCol = mix(mix(vec3(...lin(FINISH[0].rib)), vec3(...lin(FINISH[1].rib)), sandstone), vec3(...lin(FINISH[2].rib)), concrete);
  const sea = mx_noise_float(vec3(depth.mul(0.35), hitA.mul(0.6), hitY.mul(0.6))).toVar();
  const mural = mix(mix(vec3(0.03, 0.12, 0.42), vec3(0.04, 0.38, 0.36), smoothstep(-0.3, 0.4, sea)), vec3(0.75, 0.8, 0.82),
    smoothstep(0.45, 0.8, sea));
  const wallCol = mix(mix(liningCol, ribCol, ribs.mul(float(1).sub(sandstone))), mural, onVault.mul(sandstone));
  const floorCol = mix(mix(vec3(...lin(FINISH[0].floor)), vec3(...lin(FINISH[1].floor)), sandstone), vec3(...lin(FINISH[2].floor)), concrete);
  const surface = mix(wallCol, floorCol, onFloor);
  // the lamps: a row along each side under the springing every 4.5 m (along the crown in a narrow bore), their light
  // on the lining & the floor; daylight from the mouth on the first metres; the bore dimmer with depth
  const lampY = springY.sub(0.35);
  const sLamp = abs(fract(depth.div(4.5)).sub(0.5)).mul(4.5);
  const lamp = smoothstep(0.55, 0.4, sLamp).mul(smoothstep(0.16, 0.08, abs(hitY.sub(lampY)))).mul(float(1).sub(onFloor))
    .mul(step(springY.sub(1.2), hitY)).toVar();
  const pool = smoothstep(2.2, 0.3, sLamp).mul(0.6).add(0.4);
  const lit = mix(float(0.9), float(1.6), night()).mul(pool).mul(exp(depth.negate().div(60)).mul(0.7).add(0.3));
  const day = float(1).sub(night()).mul(exp(depth.negate().div(2.5))).mul(2.2);
  const inner = surface.mul(lit.add(day)).mul(0.22).add(vec3(1.0, 0.86, 0.62).mul(lamp).mul(mix(float(1.2), float(3.0), night())));
  const farLight = mix(vec3(0.9, 0.95, 1.0).mul(2.0), vec3(0.06, 0.07, 0.09), night());
  const bore = mix(inner, farLight, through);

  mat.colorNode = mix(masonry, vec3(0.0), open);
  mat.emissiveNode = bore.mul(open);
  mat.roughnessNode = mix(mix(float(0.88), float(0.95), concrete), float(1), open);
  return mat;
}

function trimMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8, metalness: 0, vertexColors: true });
  return mat;
}

/**
 * The tunnels' portals (js/donostia/data-tunnels.js). Returns a Group (the faces and their trim), or null with none.
 */
export function buildTunnels() {
  try {
    const portals = TUNNELS.portals || [];
    if (!portals.length) return null;
    const group = new THREE.Group();
    group.name = 'DonostiaTunnels';
    const f = faceGeometry(portals);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(f.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(f.nrm, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(f.col, 3));
    geo.setAttribute('aU', new THREE.Float32BufferAttribute(f.u, 1));
    geo.setAttribute('aOpen', new THREE.Float32BufferAttribute(f.open, 4));
    geo.setAttribute('aArch', new THREE.Float32BufferAttribute(f.arch, 4));
    geo.setAttribute('aBore', new THREE.Float32BufferAttribute(f.bore, 4));
    geo.setAttribute('aLen', new THREE.Float32BufferAttribute(f.len, 1));
    geo.setIndex(f.idx);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    const faces = new THREE.Mesh(geo, faceMaterial());
    faces.name = 'DonostiaTunnelPortals';
    faces.castShadow = faces.receiveShadow = true;
    faces.matrixAutoUpdate = false;
    group.add(faces);
    const t = trimGeometry(portals);
    const tgeo = new THREE.BufferGeometry();
    tgeo.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
    tgeo.setAttribute('normal', new THREE.Float32BufferAttribute(t.nrm, 3));
    tgeo.setAttribute('color', new THREE.Float32BufferAttribute(t.col, 3));
    tgeo.computeBoundingBox();
    tgeo.computeBoundingSphere();
    const trim = new THREE.Mesh(tgeo, trimMaterial());
    trim.name = 'DonostiaTunnelTrim';
    trim.castShadow = trim.receiveShadow = true;
    trim.matrixAutoUpdate = false;
    group.add(trim);
    group.userData.stats = { portals: portals.length, triangles: f.idx.length / 3 + t.pos.length / 9 };
    return group;
  } catch (e) {
    // the city stands without its portals rather than not at all (main.js skips a null module)
    console.warn('[tunnels]', e);
    return null;
  }
}
