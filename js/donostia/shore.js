import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, attribute, positionWorld, positionGeometry, positionView, normalView, cameraPosition, mix, smoothstep,
  step, floor, fract, min, max, abs, sin, dot, normalize, fwidth, uniform, time, mx_noise_float
} from 'three/tsl';
import { WALL, COPING, visibleWalls } from './shore-walls.js';
import { SHORE } from './data-shore.js';
import { accessGeometry } from './beach-access.js';
import { BEACH_ACCESS } from './data-beach-access.js';
import { seaUniforms } from './sea-uniforms.js';

// js/donostia/shore.js
// The shore: the masonry of the sea & river walls the terrain now steps down at (GEO.terrain.walls, found in the LiDAR by
// tools/donostia/build.mjs) and the rocks in front of them (tools/donostia/bake-shore.mjs -> data-shore.js).
// - Walls: each wall's face from its crest down below the ground at its foot (leaning back by its batter), capped by a
//   coping: La Concha's & Ondarreta's buff sandstone ashlar under a dressed stone kerb, the Paseo Nuevo's grey-brown
//   rubble with its parapet round Urgull, the Urumea's dark rubble quays under light coping stones, the port's grey
//   ashlar, Zurriola's concrete. Swept along the wall lines into one mesh; the masonry (courses, blocks, mortar joints,
//   wobbly rubble) is worked out in the shader from metres along the wall and the height, per wall from its vertices.
// - Rocks: the flysch sandstone of Urgull's foot (fallen blocks, bedded slabs), the Zurriola dike's concrete cubes, the
//   riprap at the foot of the river walls and boulders along the rocky coast; a few procedural geometries, instanced
//   per kind and per 1 km tile so whole tiles drop out of view, and each kind culled by distance.
// The tidal band darkens walls & rocks below the high-water line and weed grows under half tide, after the tidal bands'
// mark (js/donostia/sea-uniforms.js uTideMark: the water's level with the real-time switch off, so the demo tide moves
// it; the last high water's with it on, so the ebb uncovers the weed); the rocks' swash runs at the water's level
// (seaLevel: the water's userData.seaLevel uniform).
// - The beaches' stairs & ramps (js/donostia/beach-access.js, from data-beach-access.js) in the walls' masonry, in the
//   walls' mesh.
// - Stairs: the other flights of steps down from the walls (the municipal map's, GEO.terrain.stairs: the port's quays,
//   the river's, Santa Klara's), solid stone steps cut square to each flight's fall, in the concrete's grey.
// Draws: one for the walls & the beaches' stairs, one for the other stairs, one per rock kind and tile in view; three
// materials.

const TILE = 1024; // m

// --- walls ---------------------------------------------------------------------------------------------------------------

// Masonry per wall type: base colour (sRGB), course height & block length (m), joint width (m), rubble (0 ashlar .. 1
// random rubble), mortar (multiplies the stone colour). Coping: width behind the face, height above the promenade, depth
// of its front, overhang, colour, stone length. Parapet: thickness, height (the Paseo Nuevo round Urgull).
const STYLE = {
  [WALL.concha]: {
    colour: 0xb39c78, course: 0.5, block: 1.3, joint: 0.012, rubble: 0.05, mortar: 1.1,
    coping: { w: 0.6, h: COPING[WALL.concha], d: 0.3, over: 0.05, colour: 0xc6b99f, block: 1.1 }
  },
  [WALL.paseo]: {
    colour: 0x7e7568, course: 0.24, block: 0.5, joint: 0.022, rubble: 1, mortar: 0.66,
    coping: { w: 0.55, h: 0.1, d: 0.25, over: 0.04, colour: 0xa8a59c, block: 1.5 },
    parapet: { t: 0.5, h: COPING[WALL.paseo] }
  },
  [WALL.river]: {
    colour: 0x5f5850, course: 0.32, block: 0.65, joint: 0.018, rubble: 0.6, mortar: 0.7,
    coping: { w: 0.55, h: COPING[WALL.river], d: 0.4, over: 0.04, colour: 0xb2afa6, block: 1.2 }
  },
  [WALL.quay]: {
    colour: 0x8b887f, course: 0.58, block: 1.2, joint: 0.014, rubble: 0.12, mortar: 0.78,
    coping: { w: 0.6, h: COPING[WALL.quay], d: 0.35, over: 0.03, colour: 0x9e9b93, block: 1.3 }
  },
  [WALL.zurriola]: {
    colour: 0xa29d91, course: 3, block: 3, joint: 0.01, rubble: 0, mortar: 0.85,
    coping: { w: 0.5, h: COPING[WALL.zurriola], d: 0.3, over: 0.03, colour: 0xb5b1a6, block: 3 }
  },
  // the gardens' retaining walls round the tunnels' portals (tools/donostia/tunnels.mjs): the grey limestone rubble of
  // Miramar's garden walls under a dressed coping a little over the garden (Commons photographs of the Pico del Loro's
  // tunnel and the Miramar tunnel, looked at only)
  [WALL.garden]: {
    colour: 0x6e6a63, course: 0.34, block: 0.62, joint: 0.02, rubble: 0.85, mortar: 0.74,
    coping: { w: 0.5, h: COPING[WALL.garden], d: 0.32, over: 0.04, colour: 0xaaa69c, block: 1.1 }
  }
};
const PARAPET_MAX_X = 560; // m: the parapet runs round Urgull, not along the river mouth

// La Concha's arcade (recova) under the promenade's edge, from the foot of Alderdi Eder's ramps to the clock rotunda's
// north-east ramp: a row of round columns carrying segmental arches just under the coping, and the gallery behind them at
// the level of the walkway the first ramp comes down to (spot height 4.1), above the sand. After photographs (Wikimedia
// Commons: «Kontxako arkupeak 0001», Ketari, CC BY-SA 3.0; «Kontxako hondartza 20180801 153128», pere prlpz, CC BY-SA
// 3.0; «Donostia-San Sebastian - Playa de la Concha - 2006 - panoramio», jeffwarder, CC BY-SA 3.0): the municipal map
// leaves it out, under the promenade's deck. line: the wall's line (local x, z) it runs along; floor (m)
const ARCADES = [{
  line: [[287.6, 297.6], [282.1, 304.1], [268.5, 330.6], [262.6, 345.5], [250.9, 367.9], [242.1, 380.8], [222.0, 411.0],
    [208.6, 430.7], [199.6, 446.8]],
  floor: 4.1
}];
// m: a bay, a column's shaft, an arch's rise, its crown under the promenade, the gallery's depth; the reach of its line
const ARCADE = { bay: 3.6, column: 0.42, rise: 0.85, crown: 0.4, depth: 4.2, reach: 2.5 };

// The stretch of a wall line (V: its vertices with u, metres along) that runs along an arcade: [floor, u0, u1] or null
function arcadeAlong(V) {
  for (const a of ARCADES) {
    const L = a.line;
    // (x, z) within reach of the arcade's line, and the wall there going its way
    const on = (x, z, tx, tz) => {
      for (let k = 0; k + 1 < L.length; k++) {
        const [ax, az] = L[k], [bx, bz] = L[k + 1], dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz);
        const t = ((x - ax) * dx + (z - az) * dz) / (l * l);
        if (t < 0 || t > 1) continue;
        if (Math.hypot(x - ax - t * dx, z - az - t * dz) < ARCADE.reach && Math.abs(tx * dx + tz * dz) / l > 0.8) return true;
      }
      return false;
    };
    let u0 = Infinity, u1 = -Infinity;
    for (let k = 0; k + 1 < V.length; k++) {
      const A = V[k], B = V[k + 1], len = B.u - A.u;
      if (len < 1e-6) continue;
      const tx = (B.x - A.x) / len, tz = (B.z - A.z) / len;
      for (let s = 0; s <= len; s += 0.5) {
        if (!on(A.x + tx * s, A.z + tz * s, tx, tz)) continue;
        u0 = Math.min(u0, A.u + s);
        u1 = Math.max(u1, A.u + s);
      }
    }
    if (u1 - u0 >= ARCADE.bay) return [a.floor, u0, u1];
  }
  return null;
}

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

// Sweeps every wall's cross-section along its line. Plain arrays: { pos, nrm, col, u, mason, mortar, foot, arc, idx }
// (arc: [floor, crown, u0, u1] of an arcade in the face, zeros elsewhere).
export function wallGeometry(walls, heightAt) {
  const out = { pos: [], nrm: [], col: [], u: [], mason: [], mortar: [], foot: [], arc: [], idx: [] };
  for (const wall of walls) {
    const style = STYLE[wall.t] || STYLE[WALL.quay];
    const p = wall.p, n = p.length / 4;
    if (n < 2) continue;
    // per vertex: low-side normal (mean of the segments'), distance along, levels
    const V = [];
    let along = 0;
    for (let k = 0; k < n; k++) {
      const x = p[4 * k], z = p[4 * k + 1];
      let nx = 0, nz = 0;
      for (const s of [k - 1, k]) {
        if (s < 0 || s >= n - 1) continue;
        const dx = p[4 * s + 4] - p[4 * s], dz = p[4 * s + 5] - p[4 * s + 1], l = Math.hypot(dx, dz) || 1;
        nx += -dz / l;
        nz += dx / l;
      }
      const l = Math.hypot(nx, nz) || 1;
      if (k > 0) along += Math.hypot(x - p[4 * k - 4], z - p[4 * k - 3]);
      const deck = p[4 * k + 2], foot = p[4 * k + 3];
      nx /= l; nz /= l;
      // the ground in front, beyond the samples the terrain moved onto the wall
      const out1 = 2.5 + wall.b * Math.max(0, deck - foot);
      const ground = Math.min(foot, heightAt(x + nx * out1, z + nz * out1), heightAt(x + nx * (out1 + 1.5), z + nz * (out1 + 1.5)));
      V.push({ x, z, nx, nz, u: along, deck, foot, bottom: ground - 0.6 });
    }
    const parapet = style.parapet && V.some((v) => v.x < PARAPET_MAX_X) ? style.parapet : null;
    const c = style.coping;
    const stone = lin(style.colour), cap = lin(c.colour);
    const masonry = [style.course, style.block, style.joint, style.rubble], dressed = [20, c.block, 0.008, 0];
    // cross-section segments: [o0, y0, o1, y1] (o along the low-side normal, y as functions of the vertex), outward
    // hint [o, y], colour, masonry
    const segs = [];
    const top = parapet ? (v) => v.deck + parapet.h : (v) => v.deck + c.h;
    if (parapet) {
      const t = parapet.t, capD = 0.12, lip = 0.04;
      segs.push([() => 0, (v) => v.deck + parapet.h - capD, () => 0, (v) => v.deck, [1, 0], stone, masonry, style.mortar]);
      segs.push([() => -t, (v) => v.deck - 0.2, () => -t, (v) => v.deck + parapet.h - capD, [-1, 0], stone, masonry, style.mortar]);
      segs.push([() => -t - lip, top, () => lip, top, [0, 1], cap, dressed, 0.8]);
      segs.push([() => lip, top, () => lip, (v) => top(v) - capD, [1, 0], cap, dressed, 0.8]);
      segs.push([() => -t - lip, (v) => top(v) - capD, () => -t - lip, top, [-1, 0], cap, dressed, 0.8]);
    } else {
      segs.push([() => c.over, top, () => c.over, (v) => top(v) - c.d, [1, 0], cap, dressed, 0.8]);
      segs.push([() => -c.w, top, () => c.over, top, [0, 1], cap, dressed, 0.8]);
      if (c.h > 0.03) segs.push([() => -c.w, (v) => v.deck - 0.1, () => -c.w, top, [-1, 0], cap, dressed, 0.8]);
      segs.push([() => c.over, (v) => top(v) - c.d, () => 0, (v) => top(v) - c.d, [0, -1], cap, dressed, 0.8]);
    }
    // the face, battered below the promenade (with the arcade's bays where it runs along one)
    const faceTop = parapet ? (v) => v.deck : (v) => top(v) - c.d;
    const face = [() => 0, faceTop, (v) => wall.b * Math.max(0, v.deck - v.bottom), (v) => v.bottom, [1, 0], stone, masonry, style.mortar];
    segs.push(face);
    const arcade = wall.t === WALL.concha && !parapet ? arcadeAlong(V) : null;

    for (const seg of segs) {
      const [o0f, y0f, o1f, y1f, hint, col, mason, mortar] = seg;
      const arc = seg === face && arcade ? (v) => [arcade[0], v.deck - ARCADE.crown, arcade[1], arcade[2]] : () => [0, 0, 0, 0];
      const base = out.pos.length / 3;
      for (const v of V) {
        const o0 = o0f(v), y0 = y0f(v), o1 = o1f(v), y1 = y1f(v);
        // the section's normal in (o, y), turned to the hint
        let no = -(y1 - y0), ny = o1 - o0;
        const l = Math.hypot(no, ny) || 1;
        no /= l; ny /= l;
        if (no * hint[0] + ny * hint[1] < 0) { no = -no; ny = -ny; }
        for (const [o, y] of [[o0, y0], [o1, y1]]) {
          out.pos.push(v.x + v.nx * o, y, v.z + v.nz * o);
          out.nrm.push(v.nx * no, ny, v.nz * no);
          out.col.push(...col);
          out.u.push(v.u);
          out.mason.push(...mason);
          out.mortar.push(mortar);
          out.foot.push(v.foot);
          out.arc.push(...arc(v));
        }
      }
      for (let k = 0; k < n - 1; k++) {
        const a = base + 2 * k, b = a + 1, cc = a + 2, d = a + 3;
        // wind each quad to face its normal
        const P = (i) => out.pos.slice(3 * i, 3 * i + 3);
        const [A, B, C] = [P(a), P(b), P(cc)];
        const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const gn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const N = out.nrm.slice(3 * a, 3 * a + 3);
        if (gn[0] * N[0] + gn[1] * N[1] + gn[2] * N[2] >= 0) out.idx.push(a, b, cc, b, d, cc);
        else out.idx.push(a, cc, b, b, cc, d);
      }
    }
    // end caps of the coping or parapet
    for (const [v, sgn] of [[V[0], -1], [V[n - 1], 1]]) {
      const tx = sgn * v.nz, tz = -sgn * v.nx; // along the wall, outwards at this end
      const o0 = parapet ? -parapet.t : -c.w, o1 = parapet ? 0 : c.over;
      const y0 = v.deck - 0.1, y1 = top(v);
      const base = out.pos.length / 3;
      for (const [o, y] of [[o0, y0], [o1, y0], [o0, y1], [o1, y1]]) {
        out.pos.push(v.x + v.nx * o, y, v.z + v.nz * o);
        out.nrm.push(tx, 0, tz);
        out.col.push(...(parapet ? stone : cap));
        out.u.push(o);
        out.mason.push(...(parapet ? masonry : dressed));
        out.mortar.push(parapet ? style.mortar : 0.8);
        out.foot.push(v.foot);
        out.arc.push(0, 0, 0, 0);
      }
      // wound to face (tx, tz)
      if (sgn < 0) out.idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
      else out.idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }
  }
  return out.idx.length ? out : null;
}

// Mikkelsen's surface-gradient bump (as js/donostia/ground.js), as a view-space normal
const bumpNormal = Fn(([height]) => {
  const hgt = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(hgt.dFdx().mul(r1).add(hgt.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

const hash = Fn(([q]) => fract(sin(dot(q, vec2(127.1, 311.7))).mul(43758.5453)));

// The tidal band: dark & wet up to ~1.7 m over the sea, weed below half a metre (h: metres above the sea; n: noise)
const tidal = (c, h, n) => {
  const wet = smoothstep(1.9, 0.5, h.add(n.mul(0.5)));
  const weed = smoothstep(0.55, -0.15, h.add(n.mul(0.3)));
  return mix(mix(c, c.mul(vec3(0.5, 0.5, 0.46)), wet), vec3(0.045, 0.06, 0.03), weed.mul(0.85));
};

function wallMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.88, metalness: 0 });
  const u = attribute('aU', 'float'), y = positionWorld.y;
  const mason = attribute('aMason', 'vec4'), mortar = attribute('aMortar', 'float'), foot = attribute('aFoot', 'float');
  const base = attribute('color', 'vec3');
  const course = mason.x, block = mason.y, jw = mason.z, rubble = mason.w;
  // rubble: courses wander and change height, stones change length along a course and from course to course
  const wobble = mx_noise_float(vec3(u.mul(0.9), y.mul(0.3), 3.7)).mul(rubble).mul(0.5);
  const cy = y.div(course).add(wobble).toVar();
  const row = floor(cy);
  const stretch = mix(float(1), hash(vec2(row, 7.1)).mul(0.9).add(0.55), rubble);
  const warp = mx_noise_float(vec3(u.div(block).mul(0.8), row.mul(1.7), 9.2)).mul(rubble).mul(0.45);
  const cu = u.div(block.mul(stretch)).add(warp).add(hash(vec2(row, 1.3)).mul(rubble.mul(0.8).add(0.5))).add(row.mul(0.5)).toVar();
  const tone = hash(vec2(floor(cu), row)).toVar();
  const fwU = fwidth(cu).max(0.0001), fwY = fwidth(cy).max(0.0001);
  const dU = min(fract(cu), float(1).sub(fract(cu))).mul(block.mul(stretch));
  const dY = min(fract(cy), float(1).sub(fract(cy))).mul(course);
  const aaU = fwU.mul(block.mul(stretch)), aaY = fwY.mul(course);
  const jointU = smoothstep(jw.add(aaU), jw, dU).mul(smoothstep(0.5, 0.15, fwU));
  const jointY = smoothstep(jw.add(aaY), jw, dY).mul(smoothstep(0.5, 0.15, fwY));
  const joint = max(jointU, jointY).toVar();
  const grain = mx_noise_float(positionWorld.mul(1.7)).mul(0.08).add(mx_noise_float(positionWorld.mul(0.35)).mul(0.1)).toVar();

  // The arcade (ARCADES; aArc: floor, crown, u0, u1): whole bays centred in the stretch, an opening in each between two
  // columns under a segmental arch ringed by dressed voussoirs; through it the gallery behind (back wall, floor & ceiling
  // under the deck), traced from the view ray in the face's plane (interior mapping: no geometry behind the face)
  const arc = attribute('aArc', 'vec4');
  const { bay, column, rise, crown, depth } = ARCADE;
  const half = (bay - column) / 2, radius = (half * half + rise * rise) / (2 * rise);
  const span = arc.w.sub(arc.z), bays = floor(span.div(bay));
  const ua = u.sub(arc.z).sub(span.sub(bays.mul(bay)).mul(0.5));
  const inArcade = step(0.5, arc.y.sub(arc.x)).mul(step(0, ua)).mul(step(ua, bays.mul(bay))).mul(step(arc.x, y)).mul(step(y, arc.y.add(0.3))).toVar();
  const sb = fract(ua.div(bay)).sub(0.5).mul(bay).toVar(); // from the bay's middle (the columns at ±bay / 2)
  const aa = fwidth(u).add(fwidth(y)).max(0.002);
  const centre = arc.y.sub(radius), spring = arc.y.sub(rise);
  const archTop = centre.add(float(radius * radius).sub(sb.mul(sb)).max(0).sqrt());
  const open = smoothstep(aa.negate(), aa, min(min(float(half).sub(abs(sb)), archTop.sub(y)), y.sub(arc.x))).mul(inArcade).toVar();
  const ringD = vec2(sb, y.sub(centre)).length().sub(radius);
  const ring = smoothstep(aa.negate(), aa, ringD).mul(smoothstep(0.24 + 0.002, 0.24, ringD)).mul(step(spring.sub(0.05), y))
    .mul(step(abs(sb), half + 0.3)).mul(inArcade);
  // columns: the shaft, a base & a capital wider than it
  const axis = float(bay / 2).sub(abs(sb));
  const shaft = smoothstep(column / 2 + 0.002, column / 2, axis);
  const capital = smoothstep(0.33, 0.32, axis).mul(step(spring.sub(0.24), y));
  const plinth = smoothstep(0.31, 0.3, axis).mul(step(y, arc.x.add(0.3)));
  const col = max(shaft, max(capital, plinth)).mul(step(y, spring)).mul(inArcade).toVar();
  const roundness = float(1).sub(axis.div(column / 2).clamp(0, 1).pow(2)).sqrt();
  // the gallery: the view ray from this point of the opening to the back wall, the floor or the ceiling
  const rd = normalize(positionWorld.sub(cameraPosition));
  const faceXZ = attribute('normal', 'vec3').xz, faceN = faceXZ.div(faceXZ.length().max(0.0001)); // (0 on the coping's top)
  const into = dot(rd.xz, faceN).negate().max(0.001);
  const tBack = float(depth).div(into);
  const tFloor = y.sub(arc.x).div(rd.y.negate().max(0.0001));
  const tCeil = arc.y.add(0.15).sub(y).div(rd.y.max(0.0001));
  const tHit = min(tBack, min(tFloor, tCeil));
  const behind = into.mul(tHit).div(depth).clamp(0, 1);
  const onFloor = step(tFloor, min(tBack, tCeil)), onCeil = step(tCeil, min(tBack, tFloor));
  const hitAlong = u.add(dot(rd.xz, vec2(faceN.y, faceN.x.negate())).mul(tHit));
  const backWall = vec3(0.3, 0.27, 0.23).mul(mx_noise_float(vec3(hitAlong.mul(0.7), y.mul(0.5), 4.4)).mul(0.15).add(1));
  const gallery = mix(mix(backWall, vec3(0.36, 0.33, 0.28), onFloor), vec3(0.12, 0.11, 0.1), onCeil).mul(float(1).sub(behind.mul(0.5)));
  const dressedStone = vec3(0.42, 0.41, 0.375).mul(grain.add(1));

  mat.colorNode = Fn(() => {
    // stones vary in tone (rubble also in hue: ochre & grey), mortar lighter or darker than the stone
    const ochre = mix(vec3(1), vec3(1.16, 1.0, 0.8), step(0.6, tone).mul(rubble));
    const stoneCol = base.mul(tone.sub(0.5).mul(mix(0.16, 0.34, rubble)).add(1)).mul(ochre).mul(grain.add(1));
    const c = mix(stoneCol, base.mul(mortar).mul(grain.add(1)), joint).toVar();
    // damp sand & splash at the foot of the beach walls
    c.assign(mix(c, c.mul(0.72), smoothstep(0.9, 0.1, y.sub(foot)).mul(step(1.5, foot))));
    // iron & weathering streaks down the quays
    const streak = smoothstep(0.55, 0.85, mx_noise_float(vec3(u.mul(0.6), y.mul(0.04), 1.1))).mul(0.18);
    c.assign(c.mul(float(1).sub(streak)));
    // the arcade: the gallery through the openings, the columns & the arches' rings in dressed stone
    c.assign(mix(c, gallery, open.mul(float(1).sub(col))));
    c.assign(mix(c, dressedStone.mul(mix(float(1), roundness.mul(0.35).add(0.65), shaft)), max(col, ring)));
    return tidal(c, y.sub(seaUniforms.uTideMark), grain.mul(4));
  })();
  mat.normalNode = bumpNormal(joint.mul(-0.012).add(grain.mul(0.004)).mul(float(1).sub(max(open, col))));
  // (the sky lights the face, not the gallery under the deck)
  mat.aoNode = float(1).sub(open.mul(float(1).sub(col)).mul(0.55));
  return mat;
}

// Appends geometry b (the same layout, arc optional) to a; either may be null
function mergeInto(a, b) {
  if (!a || !b) return a || b;
  const base = a.pos.length / 3;
  for (const key of ['pos', 'nrm', 'col', 'u', 'mason', 'mortar', 'foot']) for (const v of b[key]) a[key].push(v);
  for (let i = 0; i < b.pos.length / 3; i++) for (let k = 0; k < 4; k++) a.arc.push(b.arc ? b.arc[4 * i + k] : 0);
  for (const i of b.idx) a.idx.push(base + i);
  return a;
}

function wallMesh(GEO, terrain) {
  const walls = wallGeometry(visibleWalls(GEO.terrain.walls || []), (x, z) => terrain.heightAt(x, z));
  const g = mergeInto(walls || { pos: [], nrm: [], col: [], u: [], mason: [], mortar: [], foot: [], arc: [], idx: [] }, accessGeometry(BEACH_ACCESS));
  if (!g.idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(g.col, 3));
  geo.setAttribute('aU', new THREE.Float32BufferAttribute(g.u, 1));
  geo.setAttribute('aMason', new THREE.Float32BufferAttribute(g.mason, 4));
  geo.setAttribute('aMortar', new THREE.Float32BufferAttribute(g.mortar, 1));
  geo.setAttribute('aFoot', new THREE.Float32BufferAttribute(g.foot, 1));
  geo.setAttribute('aArc', new THREE.Float32BufferAttribute(g.arc, 4));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(g.idx), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, wallMaterial());
  mesh.name = 'DonostiaShoreWalls';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// --- stairs --------------------------------------------------------------------------------------------------------------

const RISE = 0.17; // m: a step's rise; the treads' depth follows from each flight's fitted slope
const STAIR_BASE = 0.6; // m the steps' masonry goes on under the lowest one (or down to a flight's base, if it has one)

// The part of a ring (flat [x, z, ...]) where (x, z)·(ux, uz) >= s (keep 1) or <= s (keep -1): a Sutherland-Hodgman pass
function clipHalf(ring, ux, uz, s, keep) {
  const out = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
    const da = keep * (ax * ux + az * uz - s), db = keep * (bx * ux + bz * uz - s);
    if (da >= 0) out.push(ax, az);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push(ax + (bx - ax) * t, az + (bz - az) * t);
    }
  }
  return out;
}

/**
 * The flights of steps down from the shore walls (GEO.terrain.stairs, tools/donostia/walls.mjs) in one geometry: each
 * flight cut square to its fall into steps of about RISE, every step a solid prism of its slice of the flight's outline
 * from its tread down under the lowest step; a landing is one slab. -> { pos, nrm, tint } (flat-shaded triangles)
 */
export function stairGeometry(stairs) {
  const pos = [], nrm = [], tint = [];
  const up = [0, 1, 0];
  const tri = (a, b, c, n, t) => {
    // wound to face n
    const cx = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    const cy = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
    const cz = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const d = cx * n[0] + cy * n[1] + cz * n[2];
    if (Math.abs(d) < 1e-9) return;
    if (d > 0) pos.push(...a, ...b, ...c);
    else pos.push(...a, ...c, ...b);
    for (let k = 0; k < 3; k++) { nrm.push(...n); tint.push(t); }
  };
  for (const st of stairs) {
    const { p, top, bot, ux, uz } = st;
    let s0 = Infinity, s1 = -Infinity;
    for (let k = 0; k < p.length; k += 2) {
      const s = p[k] * ux + p[k + 1] * uz;
      s0 = Math.min(s0, s);
      s1 = Math.max(s1, s);
    }
    const n = top > bot ? Math.max(1, Math.round((top - bot) / RISE)) : 1;
    const base = Math.min(bot - STAIR_BASE, st.base ?? Infinity);
    // each flight its own shade of the grey stone
    const t = 0.35 + 0.3 * (Math.abs(Math.sin(p[0] * 12.9898 + p[1] * 78.233) * 43758.5453) % 1);
    for (let i = 0; i < n; i++) {
      const piece = n > 1
        ? clipHalf(clipHalf(p, ux, uz, s0 + ((s1 - s0) * i) / n, 1), ux, uz, s0 + ((s1 - s0) * (i + 1)) / n, -1)
        : p;
      const m = piece.length / 2;
      if (m < 3) continue;
      const y = top - ((top - bot) * i) / n;
      // the tread
      const contour = [];
      for (let k = 0; k < m; k++) contour.push(new THREE.Vector2(piece[2 * k], piece[2 * k + 1]));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) {
        tri([contour[a].x, y, contour[a].y], [contour[b].x, y, contour[b].y], [contour[c].x, y, contour[c].y], up, t);
      }
      // the risers & sides, facing away from the piece's middle
      let mx = 0, mz = 0;
      for (let k = 0; k < m; k++) { mx += piece[2 * k]; mz += piece[2 * k + 1]; }
      mx /= m; mz /= m;
      for (let k = 0; k < m; k++) {
        const ax = piece[2 * k], az = piece[2 * k + 1], bx = piece[(2 * k + 2) % (2 * m)], bz = piece[(2 * k + 3) % (2 * m)];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-4) continue;
        let nx = (bz - az) / len, nz = -(bx - ax) / len;
        if (nx * ((ax + bx) / 2 - mx) + nz * ((az + bz) / 2 - mz) < 0) { nx = -nx; nz = -nz; }
        const nn = [nx, 0, nz];
        tri([ax, y, az], [bx, y, bz], [bx, base, bz], nn, t);
        tri([ax, y, az], [bx, base, bz], [ax, base, az], nn, t);
      }
    }
  }
  return pos.length ? { pos, nrm, tint } : null;
}

function stairMesh(stairs, material) {
  const g = stairGeometry(stairs);
  if (!g) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
  geo.setAttribute('aTint', new THREE.Float32BufferAttribute(g.tint, 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = 'DonostiaShoreStairs';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.matrixAutoUpdate = false;
  return mesh;
}

// --- rock geometries (deterministic) -------------------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Triangle soup -> flat-shaded geometry scaled into the unit cube (-0.5..0.5) so an instance's scale is its size
function soup(tris) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const t of tris) for (const p of t) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], p[a]); max[a] = Math.max(max[a], p[a]); }
  const pos = new Float32Array(tris.length * 9), nrm = new Float32Array(tris.length * 9);
  tris.forEach((t, i) => {
    const q = t.map((p) => p.map((v, a) => (v - (min[a] + max[a]) / 2) / (max[a] - min[a])));
    const e1 = [0, 1, 2].map((a) => q[1][a] - q[0][a]), e2 = [0, 1, 2].map((a) => q[2][a] - q[0][a]);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    for (let v = 0; v < 3; v++) for (let a = 0; a < 3; a++) {
      pos[9 * i + 3 * v + a] = q[v][a];
      nrm[9 * i + 3 * v + a] = n[a] / l;
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.computeBoundingSphere();
  return geo;
}

// A boulder: an icosphere cut by a few random planes (the flat fracture faces of sandstone blocks), dented by noise
function boulder(seed, detail = 1) {
  const rnd = mulberry32(seed);
  const ico = new THREE.IcosahedronGeometry(1, detail).getAttribute('position');
  const cuts = [];
  for (let i = 0; i < 9; i++) {
    const a = rnd() * Math.PI * 2, b = Math.acos(2 * rnd() - 1);
    cuts.push([Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a), 0.5 + rnd() * 0.3]);
  }
  const bump = (x, y, z) => 0.08 * Math.sin(3.1 * x + seed) * Math.sin(2.7 * y + 1.3 * seed) * Math.sin(3.3 * z + 2.1);
  const tris = [];
  for (let i = 0; i < ico.count; i += 3) {
    const t = [];
    for (let v = 0; v < 3; v++) {
      let p = [ico.getX(i + v), ico.getY(i + v), ico.getZ(i + v)];
      const r = 1 + bump(...p);
      p = p.map((c) => c * r);
      for (const [nx, ny, nz, d] of cuts) {
        const e = p[0] * nx + p[1] * ny + p[2] * nz - d;
        if (e > 0) p = [p[0] - nx * e, p[1] - ny * e, p[2] - nz * e];
      }
      t.push(p);
    }
    tris.push(t);
  }
  return soup(tris);
}

// A flysch slab: two or three bedded layers, each an irregular polygon a little smaller and shifted over the one below
function slab(seed, layers) {
  const rnd = mulberry32(seed);
  const tris = [];
  let y = 0;
  let shiftX = 0, shiftZ = 0, shrink = 1;
  for (let L = 0; L < layers; L++) {
    const m = 9, h = 0.7 + rnd() * 0.6;
    const ring = [];
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const r = (0.8 + rnd() * 0.25) * shrink;
      ring.push([Math.cos(a) * r * 1.3 + shiftX, Math.sin(a) * r + shiftZ]);
    }
    const y0 = y, y1 = y + h;
    for (let i = 0; i < m; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % m];
      // sides (outward: the ring runs counter-clockwise seen from above in x, z)
      tris.push([[ax, y0, az], [ax, y1, az], [bx, y1, bz]], [[ax, y0, az], [bx, y1, bz], [bx, y0, bz]]);
      // top fan, and the bottom of the lowest layer
      tris.push([[shiftX, y1, shiftZ], [bx, y1, bz], [ax, y1, az]]);
      if (L === 0) tris.push([[shiftX, y0, shiftZ], [ax, y0, az], [bx, y0, bz]]);
    }
    y = y1;
    shiftX += (rnd() - 0.5) * 0.3;
    shiftZ += (rnd() - 0.5) * 0.3;
    shrink *= 0.78 + rnd() * 0.12;
  }
  return soup(fixWinding(tris));
}

// A concrete cube with chamfered edges
function cube(c = 0.06) {
  const s = 0.5, t = 0.5 - c;
  const tris = [];
  const corner = (sx, sy, sz) => [[sx * s, sy * t, sz * t], [sx * t, sy * s, sz * t], [sx * t, sy * t, sz * s]];
  const signs = [-1, 1];
  for (const sx of signs) for (const sy of signs) for (const sz of signs) tris.push(corner(sx, sy, sz));
  // faces
  for (let a = 0; a < 3; a++) for (const sa of signs) {
    const q = [];
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0];
      p[a] = sa * s; p[(a + 1) % 3] = u * t; p[(a + 2) % 3] = v * t;
      q.push(p);
    }
    tris.push([q[0], q[1], q[2]], [q[0], q[2], q[3]]);
  }
  // edge bevels: between faces a and b along the third axis
  for (let a = 0; a < 3; a++) {
    const b = (a + 1) % 3, e = (a + 2) % 3;
    for (const sa of signs) for (const sb of signs) {
      const pts = [];
      for (const se of signs) {
        const pa = [0, 0, 0], pb = [0, 0, 0];
        pa[a] = sa * s; pa[b] = sb * t; pa[e] = se * t;
        pb[a] = sa * t; pb[b] = sb * s; pb[e] = se * t;
        pts.push(pa, pb);
      }
      tris.push([pts[0], pts[1], pts[3]], [pts[0], pts[3], pts[2]]);
    }
  }
  return soup(fixWinding(tris));
}

// Turns every triangle of a convex-ish solid round the origin to face outwards
function fixWinding(tris) {
  let cx = 0, cy = 0, cz = 0, n = 0;
  for (const t of tris) for (const p of t) { cx += p[0]; cy += p[1]; cz += p[2]; n++; }
  cx /= n; cy /= n; cz /= n;
  return tris.map((t) => {
    const e1 = [0, 1, 2].map((a) => t[1][a] - t[0][a]), e2 = [0, 1, 2].map((a) => t[2][a] - t[0][a]);
    const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const m = [(t[0][0] + t[1][0] + t[2][0]) / 3 - cx, (t[0][1] + t[1][1] + t[2][1]) / 3 - cy, (t[0][2] + t[1][2] + t[2][2]) / 3 - cz];
    return nn[0] * m[0] + nn[1] * m[1] + nn[2] * m[2] < 0 ? [t[0], t[2], t[1]] : t;
  });
}

// KINDS of tools/donostia/bake-shore.mjs, in order
// cull: metres from the camera beyond which a kind is not drawn, about where it shrinks to a few pixels. Far rocks are
// all sub-pixel triangles, which cost the GPU far more than their count says (it shades 2x2 pixel quads), and once more
// in the shadow map; beyond, the ground's weathered-rock colour stands in. The pebbles cast no shadow.
const KINDS = [
  { name: 'boulder', make: () => boulder(101), concrete: false, cull: 420 },
  { name: 'boulder2', make: () => boulder(202), concrete: false, cull: 420 },
  { name: 'boulder3', make: () => boulder(303), concrete: false, cull: 420 },
  { name: 'slab', make: () => slab(404, 3), concrete: false, cull: 700 },
  { name: 'slab2', make: () => slab(505, 2), concrete: false, cull: 700 },
  { name: 'cube', make: () => cube(), concrete: true, cull: 600 },
  { name: 'pebble', make: () => boulder(606, 0), concrete: false, cull: 160, noShadow: true }
];
const RECULL = 8; // m the camera moves before the rocks are culled again

function rockMaterials(seaLevel) {
  const tint = attribute('aTint', 'float');
  const p = positionWorld;
  const n1 = mx_noise_float(p.mul(0.9)).toVar(), n2 = mx_noise_float(p.mul(3.3)).toVar();
  // the swash: a band of foam that runs up and down the rocks at the water's edge
  const swash = (h) => {
    const run = sin(time.mul(0.7).add(p.x.mul(0.21)).add(p.z.mul(0.17))).mul(0.18).add(0.12);
    return smoothstep(0.1, 0.0, abs(h.sub(run))).mul(smoothstep(0.35, 0.8, n2.add(0.5))).mul(0.3);
  };

  // Urgull's flysch: buff to brown sandstone with grey blocks among them, bedded along the stone's own layers
  const rock = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0 });
  rock.colorNode = Fn(() => {
    const sand = mix(vec3(0.22, 0.17, 0.11), vec3(0.34, 0.27, 0.17), tint);
    const base = mix(sand, vec3(0.24, 0.215, 0.18), step(0.82, tint)).toVar();
    const bed = sin(positionGeometry.y.mul(26).add(n1.mul(2.5))).mul(0.5).add(0.5);
    const c = base.mul(mix(float(0.9), float(1.07), bed)).mul(n1.mul(0.14).add(n2.mul(0.08)).add(1)).toVar();
    c.assign(tidal(c, p.y.sub(seaUniforms.uTideMark), n1));
    return mix(c, vec3(0.75, 0.78, 0.78), swash(p.y.sub(seaLevel)));
  })();
  rock.normalNode = bumpNormal(n2.mul(0.03).add(n1.mul(0.05)));

  // the dike's concrete: grey-beige, pitted, stained
  const concrete = new THREE.MeshStandardNodeMaterial({ roughness: 0.9, metalness: 0 });
  concrete.colorNode = Fn(() => {
    const base = mix(vec3(0.17, 0.165, 0.145), vec3(0.27, 0.255, 0.22), tint);
    const pits = smoothstep(0.55, 0.75, mx_noise_float(p.mul(9.0))).mul(0.25);
    // weathered: darker patches and rust-brown runs on each cube
    const stain = smoothstep(0.2, 0.7, mx_noise_float(p.mul(0.45).add(vec3(tint.mul(40), 0, 0)))).mul(0.3);
    const c = base.mul(n1.mul(0.12).add(n2.mul(0.06)).add(1)).mul(float(1).sub(pits)).mul(float(1).sub(stain)).toVar();
    c.assign(tidal(c, p.y.sub(seaUniforms.uTideMark), n1));
    return mix(c, vec3(0.75, 0.78, 0.78), swash(p.y.sub(seaLevel)));
  })();
  concrete.normalNode = bumpNormal(n2.mul(0.01));
  return { rock, concrete };
}

// The baked rocks: { kind, matrix, tint } grouped per kind & tile
function decodeRocks() {
  const { count: N, data } = SHORE.rocks;
  if (!N) return [];
  const bin = typeof atob === 'function' ? Uint8Array.from(atob(data), (ch) => ch.charCodeAt(0)) : new Uint8Array(Buffer.from(data, 'base64'));
  const view = new DataView(bin.buffer);
  const out = [];
  const q = new THREE.Quaternion(), e = new THREE.Euler(), m = new THREE.Matrix4();
  const pos = new THREE.Vector3(), scl = new THREE.Vector3();
  const deg = Math.PI / 180;
  for (let i = 0; i < N; i++) {
    const x = view.getInt32(8 * i, true) / 100, z = view.getInt32(8 * i + 4, true) / 100;
    const y = view.getInt16(8 * N + 2 * i, true) / 100;
    const o = 10 * N + 8 * i;
    e.set((bin[o + 1] - 128) * deg, (bin[o] / 256) * Math.PI * 2, (bin[o + 2] - 128) * deg, 'YXZ');
    q.setFromEuler(e);
    m.compose(pos.set(x, y, z), q, scl.set(bin[o + 3] / 20, bin[o + 4] / 20, bin[o + 5] / 20));
    out.push({ kind: bin[o + 6], tint: bin[o + 7] / 255, matrix: m.clone(), x, z });
  }
  return out;
}

function rockMeshes({ rock, concrete }) {
  const rocks = decodeRocks();
  if (!rocks.length) return [];
  const geos = KINDS.map((k) => k.make());
  const groups = new Map();
  for (const r of rocks) {
    const key = `${r.kind}:${Math.floor(r.x / TILE)}:${Math.floor(r.z / TILE)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const meshes = [];
  for (const [key, list] of [...groups].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kind = list[0].kind, base = geos[kind];
    // a geometry of its own for the tints, sharing the kind's vertex buffers
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('normal', base.getAttribute('normal'));
    geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(Float32Array.from(list, (r) => r.tint), 1));
    const mesh = new THREE.InstancedMesh(geo, KINDS[kind].concrete ? concrete : rock, list.length);
    list.forEach((r, i) => mesh.setMatrixAt(i, r.matrix));
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    mesh.name = `DonostiaShoreRocks-${KINDS[kind].name}-${key}`;
    mesh.castShadow = !KINDS[kind].noShadow;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.userData.cull = new RockCull(mesh, KINDS[kind].cull);
    meshes.push(mesh);
  }
  return meshes;
}

// Keeps a rock mesh's instances within maxDist of the camera at the front of its buffers (matrices & tints), drawing
// only those: streetscape.js's DistanceCulled, with the tint attribute kept in step
class RockCull {
  constructor(mesh, maxDist) {
    this.mesh = mesh;
    this.tint = mesh.geometry.getAttribute('aTint');
    this.srcM = mesh.instanceMatrix.array.slice();
    this.srcT = this.tint.array.slice();
    this.n = this.srcT.length;
    this.max2 = maxDist * maxDist;
    this.inside = new Uint8Array(this.n).fill(1);
  }

  update(cam) {
    const src = this.srcM;
    let changed = false;
    for (let i = 0; i < this.n; i++) {
      const dx = src[16 * i + 12] - cam.x, dy = src[16 * i + 13] - cam.y, dz = src[16 * i + 14] - cam.z;
      const inside = dx * dx + dy * dy + dz * dz < this.max2 ? 1 : 0;
      if (inside !== this.inside[i]) { this.inside[i] = inside; changed = true; }
    }
    if (!changed) return;
    const mesh = this.mesh, dstM = mesh.instanceMatrix.array, dstT = this.tint.array;
    let c = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.inside[i]) continue;
      for (let k = 0; k < 16; k++) dstM[16 * c + k] = src[16 * i + k];
      dstT[c] = this.srcT[i];
      c++;
    }
    mesh.count = c;
    mesh.visible = c > 0;
    if (c > 0) {
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, c * 16);
      mesh.instanceMatrix.needsUpdate = true;
      this.tint.clearUpdateRanges();
      this.tint.addUpdateRange(0, c);
      this.tint.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }
}

/**
 * The shore walls & rocks. seaLevel: the water's level uniform (js/donostia/water.js userData.seaLevel), for the rocks'
 * swash; a fixed mean sea level without it.
 */
export async function buildShore(GEO, terrain, seaLevel = null) {
  try {
    const level = seaLevel || uniform(0);
    const group = new THREE.Group();
    group.name = 'DonostiaShore';
    const walls = wallMesh(GEO, terrain);
    if (walls) group.add(walls);
    const stone = rockMaterials(level);
    const stairs = stairMesh(GEO.terrain.stairs || [], stone.concrete);
    if (stairs) group.add(stairs);
    const rocks = rockMeshes(stone);
    for (const m of rocks) group.add(m);
    const last = new THREE.Vector3(Infinity, Infinity, Infinity);
    group.userData.update = (dt, elapsed, camera) => {
      if (camera.position.distanceToSquared(last) < RECULL * RECULL) return;
      last.copy(camera.position);
      for (const m of rocks) m.userData.cull.update(camera.position);
    };
    return group.children.length ? group : null;
  } catch (e) {
    // the city stands without its shore rather than not at all (main.js skips a null module)
    console.warn('[shore]', e);
    return null;
  }
}
