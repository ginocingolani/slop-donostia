import * as THREE from 'three/webgpu';
import { WALL } from './shore-walls.js';

// js/donostia/beach-access.js
// The stairs & ramps down to the beaches (js/donostia/data-beach-access.js, baked by tools/donostia/build.mjs from
// tools/donostia/beach-access.mjs's inventory): flights of real steps (tread, riser and a small nosing; rises of ~16.5
// cm on the treads each flight's run gives), landings, ramps as sloped slabs, all on a solid masonry body that goes down
// under the sand; along their open sides a stone kerb (the handrails on it are js/donostia/streetscape.js's, La Concha's
// railing down the ramps is the barandilla of tools/donostia/bake-streetscape.mjs); beside a broad flight cut into the
// promenade, a cheek wall up to the promenade; a landing that is a corner of the promenade stands on the sea wall's
// masonry (js/donostia/shore.js). La Concha's & Ondarreta's are built in the sandstone of their sea walls
// (dressed treads & copings, coursed ashlar sides), Zurriola's in its concrete.
// accessGeometry() returns plain arrays with the shore walls' attributes (js/donostia/shore.js: { pos, nrm, col, u, mason,
// mortar, foot, idx }) so they share the walls' mesh, material and draw.

const NOSE = 0.03; // m the nosing stands out over the riser below
const NOSE_T = 0.04; // m: its thickness
const KERB_W = 0.22; // m: the kerb along an open side
const UPSTAND = 0.14; // m: its top over the nosings (as tools/donostia/beach-access.mjs)
const CHEEK_W = 0.3; // m: a cheek wall's thickness

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
// Finishes per wall type: [colour, masonry (course, block, joint, rubble), mortar]
const FINISH = {
  [WALL.concha]: {
    tread: [lin(0xc4b79c), [20, 1.1, 0.008, 0], 0.8], // dressed sandstone
    riser: [lin(0xb9ab8e), [20, 1.1, 0.008, 0], 0.8],
    body: [lin(0xb39c78), [0.5, 1.3, 0.012, 0.05], 1.1], // the sea wall's coursed ashlar
    kerb: [lin(0xc6b99f), [20, 1.1, 0.008, 0], 0.8],
    ramp: [lin(0xb8b0a0), [20, 0.9, 0.006, 0], 0.85] // paving slabs
  },
  [WALL.zurriola]: {
    tread: [lin(0xb5b1a6), [20, 3, 0.01, 0], 0.85],
    riser: [lin(0xa9a598), [20, 3, 0.01, 0], 0.85],
    body: [lin(0xa29d91), [3, 3, 0.01, 0], 0.85],
    kerb: [lin(0xb5b1a6), [20, 3, 0.01, 0], 0.85],
    ramp: [lin(0xaaa69c), [20, 1.5, 0.008, 0], 0.85]
  }
};

// The part of a ring (flat [x, z, ...]) where s = (x, z)·(ux, uz) lies in [a, b] (two Sutherland-Hodgman passes)
function slice(ring, ux, uz, a, b) {
  const pass = (r, s0, keep) => {
    const out = [];
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const da = keep * (r[2 * i] * ux + r[2 * i + 1] * uz - s0), db = keep * (r[2 * j] * ux + r[2 * j + 1] * uz - s0);
      if (da >= 0) out.push(r[2 * i], r[2 * i + 1]);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        out.push(r[2 * i] + (r[2 * j] - r[2 * i]) * t, r[2 * i + 1] + (r[2 * j + 1] - r[2 * i + 1]) * t);
      }
    }
    return out;
  };
  return pass(pass(ring, a, 1), b, -1);
}

/**
 * The beaches' stairs & ramps (BEACH_ACCESS) as one geometry in the shore walls' layout, or null.
 */
export function accessGeometry(data) {
  if (!data || !data.parts || !data.parts.length) return null;
  const out = { pos: [], nrm: [], col: [], u: [], mason: [], mortar: [], foot: [], idx: [] };
  let finish = null, foot = 0;
  const vert = (x, y, z, n, u) => {
    out.pos.push(x, y, z);
    out.nrm.push(n[0], n[1], n[2]);
    out.col.push(...finish[0]);
    out.u.push(u);
    out.mason.push(...finish[1]);
    out.mortar.push(finish[2]);
    out.foot.push(foot);
    return out.pos.length / 3 - 1;
  };
  // a planar polygon [[x, y, z], ...] wound to face n; u along (ax, az)
  const face = (pts, n, ax = 1, az = 0) => {
    if (pts.length < 3) return;
    const base = out.pos.length / 3;
    for (const [x, y, z] of pts) vert(x, y, z, n, x * ax + z * az);
    const tri = (a, b, c) => {
      const A = pts[a], B = pts[b], C = pts[c];
      const cx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
      const cy = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
      const cz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
      const d = cx * n[0] + cy * n[1] + cz * n[2];
      if (Math.abs(d) < 1e-10) return;
      if (d > 0) out.idx.push(base + a, base + b, base + c);
      else out.idx.push(base + a, base + c, base + b);
    };
    if (pts.length === 3) tri(0, 1, 2);
    else if (pts.length === 4) { tri(0, 1, 2); tri(0, 2, 3); } else {
      // horizontal or sloped tops: triangulate in plan
      const contour = pts.map(([x, , z]) => new THREE.Vector2(x, z));
      for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(contour, [])) tri(a, b, c);
    }
  };
  // a vertical quad over the segment a -> b (plan) between heights (y0a, y1a) at a and (y0b, y1b) at b, facing (nx, nz)
  const wallQuad = (ax, az, bx, bz, y0a, y1a, y0b, y1b, nx, nz) => {
    if (y1a - y0a < 1e-3 && y1b - y0b < 1e-3) return;
    const l = Math.hypot(bx - ax, bz - az);
    if (l < 1e-4) return;
    face([[ax, y0a, az], [bx, y0b, bz], [bx, y1b, bz], [ax, y1a, az]], [nx, 0, nz], (bx - ax) / l, (bz - az) / l);
  };
  // a flat or sloped polygon in plan with heights from y(x, z), facing up
  const top = (ring, y, ax, az) => {
    const pts = [];
    for (let k = 0; k < ring.length; k += 2) pts.push([ring[k], y(ring[k], ring[k + 1]), ring[k + 1]]);
    // the normal of a sloped top: from its plane
    let n = [0, 1, 0];
    if (pts.length >= 3) {
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      n = ny < 0 ? [-nx / l, -ny / l, -nz / l] : [nx / l, ny / l, nz / l];
    }
    face(pts, n, ax, az);
  };

  for (const part of data.parts) {
    const F = FINISH[part.m] || FINISH[WALL.concha];
    const rail = data.accesses[part.a]?.[4] || '';
    const { p: ring, u: [ux, uz], y: [y0, y1], s: [s0, s1], b: base } = part;
    const n = ring.length / 2;
    const flags = part.e || '0'.repeat(n);
    const along = -uz, alongZ = ux; // across the way down (the steps' length)
    const run = s1 - s0 || 1;
    const sOf = (x, z) => x * ux + z * uz;
    // the walking surface at (x, z): a flight's pitch line through its nosings, a ramp's slope, a landing's level
    const pitch = (x, z) => (part.k === 'l' ? y0 : y0 + ((y1 - y0) * Math.max(0, Math.min(1, (sOf(x, z) - s0) / run))));
    foot = base + 0.7;
    // the kerb's top along an open side (barandilla sides carry the railing's own plinth)
    const kerbed = (i) => (flags[i] === '1' || flags[i] === '2') && !(rail === 'barandilla' && flags[i] === '1');

    if (part.k === 'f') {
      const steps = part.n, rise = (y0 - y1) / steps, tread = run / steps;
      for (let k = 0; k < steps; k++) {
        const sa = s0 + k * tread, sb = s0 + (k + 1) * tread, yk = y0 - (k + 1) * rise;
        const last = k === steps - 1;
        const body = slice(ring, ux, uz, sa, sb);
        if (body.length < 6) continue;
        // the tread, out over the riser below by the nosing
        finish = F.tread;
        top(last ? body : slice(ring, ux, uz, sa, sb + NOSE), () => yk, along, alongZ);
        // the riser below its nosing, and the nosing's front & underside
        if (!last) {
          const edge = cutLine(ring, ux, uz, sb, along, alongZ), front = cutLine(ring, ux, uz, sb + NOSE, along, alongZ);
          finish = F.riser;
          if (edge) {
            const [ax, az, bx, bz] = edge;
            wallQuad(ax, az, bx, bz, yk - rise, yk - NOSE_T, yk - rise, yk - NOSE_T, ux, uz);
          }
          finish = F.tread;
          if (front) {
            const [ax, az, bx, bz] = front;
            wallQuad(ax, az, bx, bz, yk - NOSE_T, yk, yk - NOSE_T, yk, ux, uz);
            if (edge) face([[edge[0], yk - NOSE_T, edge[1]], [edge[2], yk - NOSE_T, edge[3]], [bx, yk - NOSE_T, bz], [ax, yk - NOSE_T, az]], [0, -1, 0], along, alongZ);
          }
        }
        if (k === 0) {
          // the first riser, from the level above
          const edge = cutLine(ring, ux, uz, sa + 1e-3, along, alongZ);
          finish = F.riser;
          if (edge) wallQuad(edge[0], edge[1], edge[2], edge[3], yk, y0, yk, y0, ux, uz);
        }
        // the sides of its body down into the ground: the outline's own edges, up to the kerb where the side is open
        finish = F.body;
        const m = body.length / 2;
        for (let q = 0; q < m; q++) {
          const r = (q + 1) % m;
          const ax = body[2 * q], az = body[2 * q + 1], bx = body[2 * r], bz = body[2 * r + 1];
          const da = sOf(ax, az), db = sOf(bx, bz);
          if (Math.abs(da - db) < 1e-3 && (Math.abs(da - sa) < 2e-3 || Math.abs(da - sb) < 2e-3)) continue; // a cut
          const l = Math.hypot(bx - ax, bz - az);
          if (l < 1e-4) continue;
          const nx = (bz - az) / l, nz = -(bx - ax) / l;
          const ei = edgeOf(ring, (ax + bx) / 2, (az + bz) / 2);
          const up = ei >= 0 && kerbed(ei);
          const ya = up ? pitch(ax, az) + UPSTAND : yk, yb = up ? pitch(bx, bz) + UPSTAND : yk;
          wallQuad(ax, az, bx, bz, base, ya, base, yb, nx, nz);
        }
      }
    } else {
      // a landing or a ramp: its top, and its body's sides
      finish = part.k === 'r' ? F.ramp : F.tread;
      top(ring, pitch, along, alongZ);
      finish = F.body;
      for (let q = 0; q < n; q++) {
        if (flags[q] === '5') continue; // the sea wall's face
        const r = (q + 1) % n;
        const ax = ring[2 * q], az = ring[2 * q + 1], bx = ring[2 * r], bz = ring[2 * r + 1];
        const l = Math.hypot(bx - ax, bz - az);
        if (l < 1e-4) continue;
        const up = kerbed(q);
        wallQuad(ax, az, bx, bz, base, pitch(ax, az) + (up ? UPSTAND : 0), base, pitch(bx, bz) + (up ? UPSTAND : 0), (bz - az) / l, -(bx - ax) / l);
      }
    }

    // kerbs along the open sides: the top and the face towards the walk (the outer face is the body's side, carried up)
    for (let q = 0; q < n; q++) {
      if (!kerbed(q)) continue;
      const r = (q + 1) % n;
      const ax = ring[2 * q], az = ring[2 * q + 1], bx = ring[2 * r], bz = ring[2 * r + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.05) continue;
      const nx = (bz - az) / l, nz = -(bx - ax) / l; // outward
      const ix = -nx * KERB_W, iz = -nz * KERB_W;
      const ya = pitch(ax, az) + UPSTAND, yb = pitch(bx, bz) + UPSTAND;
      finish = F.kerb;
      face([[ax, ya, az], [bx, yb, bz], [bx + ix, yb, bz + iz], [ax + ix, ya, az + iz]], [0, 1, 0], (bx - ax) / l, (bz - az) / l);
      // the inner face: down to the walking surface (a flight's treads lie under its pitch line: the face reaches them)
      const drop = part.k === 'f' ? (y0 - y1) / part.n : 0;
      wallQuad(bx + ix, bz + iz, ax + ix, az + iz, pitch(bx + ix, bz + iz) - drop, yb, pitch(ax + ix, az + iz) - drop, ya, -nx, -nz);
      // its ends
      for (const [px, pz, py, sgn] of [[ax, az, ya, -1], [bx, bz, yb, 1]]) {
        wallQuad(px + ix, pz + iz, px, pz, py - UPSTAND - drop, py, py - UPSTAND - drop, py, sgn * (bx - ax) / l, sgn * (bz - az) / l);
      }
    }
    // cheek walls beside a broad flight cut into higher ground: up to the flight's top level
    for (let q = 0; q < n; q++) {
      if (flags[q] !== '4') continue;
      const r = (q + 1) % n;
      const ax = ring[2 * q], az = ring[2 * q + 1], bx = ring[2 * r], bz = ring[2 * r + 1];
      const l = Math.hypot(bx - ax, bz - az);
      if (l < 0.05) continue;
      const nx = (bz - az) / l, nz = -(bx - ax) / l;
      const ox = nx * CHEEK_W, oz = nz * CHEEK_W, h = y0 + 0.02;
      finish = F.kerb;
      face([[ax, h, az], [bx, h, bz], [bx + ox, h, bz + oz], [ax + ox, h, az + oz]], [0, 1, 0], (bx - ax) / l, (bz - az) / l);
      finish = F.body;
      wallQuad(bx, bz, ax, az, base, h, base, h, -nx, -nz);
      wallQuad(ax + ox, az + oz, bx + ox, bz + oz, base, h, base, h, nx, nz);
      wallQuad(ax, az, ax + ox, az + oz, base, h, base, h, -(bx - ax) / l, -(bz - az) / l);
      wallQuad(bx + ox, bz + oz, bx, bz, base, h, base, h, (bx - ax) / l, (bz - az) / l);
    }
  }
  return out.idx.length ? out : null;
}

// Where the line s = (x, z)·(ux, uz) crosses a (convex enough) ring: its two ends [ax, az, bx, bz] ordered along
// (tx, tz), or null
function cutLine(ring, ux, uz, s, tx, tz) {
  const pts = [];
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const da = ring[2 * i] * ux + ring[2 * i + 1] * uz - s, db = ring[2 * j] * ux + ring[2 * j + 1] * uz - s;
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      pts.push([ring[2 * i] + (ring[2 * j] - ring[2 * i]) * t, ring[2 * i + 1] + (ring[2 * j + 1] - ring[2 * i + 1]) * t]);
    }
  }
  if (pts.length < 2) return null;
  pts.sort((p, q) => p[0] * tx + p[1] * tz - (q[0] * tx + q[1] * tz));
  const a = pts[0], b = pts[pts.length - 1];
  return [a[0], a[1], b[0], b[1]];
}

// The index of the ring's edge through (x, z), or -1
function edgeOf(ring, x, z) {
  const n = ring.length / 2;
  let best = -1, bd = 0.02;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[2 * i], az = ring[2 * i + 1], dx = ring[2 * j] - ax, dz = ring[2 * j + 1] - az;
    const l2 = dx * dx + dz * dz || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    const d = Math.hypot(x - ax - t * dx, z - az - t * dz);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
