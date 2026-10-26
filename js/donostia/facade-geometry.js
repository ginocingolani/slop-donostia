// js/donostia/facade-geometry.js
// Plain-JS geometry behind js/donostia/buildings.js (no three.js, so Node can test it): ring winding and offsets,
// continuous facade runs along the 1:500 outlines, and the walls neighbours hide (party walls).
// Rings are flat [x0, z0, x1, z1, ...] arrays in local metres (x east, z south).

const DEG = Math.PI / 180;

export function signedArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

// Ring with the requested winding (area > 0 for outer rings, < 0 for holes): edge normals (dz, -dx) then point out
// of the solid for both. Repeated vertices are dropped so every edge has a direction.
export function wound(r, positive) {
  const clean = [];
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    const x = r[2 * i], z = r[2 * i + 1];
    const k = clean.length;
    if (k && Math.abs(clean[k - 2] - x) < 0.02 && Math.abs(clean[k - 1] - z) < 0.02) continue;
    clean.push(x, z);
  }
  while (clean.length > 6 && Math.abs(clean[0] - clean[clean.length - 2]) < 0.02 && Math.abs(clean[1] - clean[clean.length - 1]) < 0.02) {
    clean.length -= 2;
  }
  if ((signedArea(clean) > 0) === positive) return clean;
  const out = [];
  for (let k = clean.length - 2; k >= 0; k -= 2) out.push(clean[k], clean[k + 1]);
  return out;
}

export function ringCentroid(r) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const f = r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    a += f;
    cx += (r[2 * j] + r[2 * i]) * f;
    cz += (r[2 * j + 1] + r[2 * i + 1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let x = 0, z = 0;
    for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
    return [x / (r.length / 2), z / (r.length / 2)];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Distance from a point to the nearest edge of a ring
export function distanceToRing(x, z, r) {
  let best = Infinity;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const l2 = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

// Offset every edge i of a wound ring by dist[i] along its outward normal (negative moves it into the solid) and
// rebuild the vertices where neighbouring offset lines meet. Edges with different distances make weighted insets:
// a party edge at 0 keeps its line while the free edges move in, which turns a hip roof into a gable against the
// neighbour. Returns null when an edge flips, the ring turns inside out or collapses (below `minShare` of its area).
export function offsetRing(r, dist, minShare = 0.08) {
  const n = r.length / 2;
  if (n < 3) return null;
  const nx = new Float64Array(n), nz = new Float64Array(n), dx = new Float64Array(n), dz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    let ex = r[2 * q] - r[2 * i], ez = r[2 * q + 1] - r[2 * i + 1];
    const l = Math.hypot(ex, ez) || 1;
    ex /= l; ez /= l;
    dx[i] = ex; dz[i] = ez;
    nx[i] = ez; nz[i] = -ex;
  }
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n; // edge ending at vertex i
    const x = r[2 * i], z = r[2 * i + 1];
    const da = dist[p], db = dist[i];
    // Offset lines: (x, z) + n_a da + s d_a and (x, z) + n_b db + t d_b
    const cross = dx[p] * dz[i] - dz[p] * dx[i];
    if (Math.abs(cross) < 0.05) {
      // (almost) collinear edges: average the two offsets along the mean normal
      let mx = nx[p] + nx[i], mz = nz[p] + nz[i];
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const d = (da + db) / 2;
      out[2 * i] = x + mx * d;
      out[2 * i + 1] = z + mz * d;
      continue;
    }
    const ax = x + nx[p] * da, az = z + nz[p] * da;
    const bx = x + nx[i] * db, bz = z + nz[i] * db;
    // ax + s dx[p] = bx + t dx[i]  ->  s = ((bx - ax) dz[i] - (bz - az) dx[i]) / cross
    const s = ((bx - ax) * dz[i] - (bz - az) * dx[i]) / cross;
    const ox = ax + s * dx[p], oz = az + s * dz[p];
    // A miter far longer than the offset is a spike at a sharp corner
    const maxD = Math.max(Math.abs(da), Math.abs(db));
    if (Math.hypot(ox - x, oz - z) > 4 * maxD + 0.01) return null;
    out[2 * i] = ox;
    out[2 * i + 1] = oz;
  }
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ox = r[2 * q] - r[2 * i], oz = r[2 * q + 1] - r[2 * i + 1];
    const ex = out[2 * q] - out[2 * i], ez = out[2 * q + 1] - out[2 * i + 1];
    if (ox * ex + oz * ez <= 0) return null;
  }
  const a0 = signedArea(r), a1 = signedArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < minShare * Math.abs(a0)) return null;
  return out;
}

// Douglas-Peucker on a closed ring (after simplifyRing in tools/donostia/lib.mjs). The 1:500 outlines trace pilaster
// bases and arcade piers a hand's breadth proud of the wall; walls follow the simplified line so one facade isn't
// creased into dozens of facets. Returns the ring unchanged when simplifying would lose a noticeable share of it.
export function simplifyRing(r, tol) {
  const n = r.length / 2;
  if (n <= 4) return r;
  const keep = new Uint8Array(n);
  keep[0] = 1;
  let far = 0, best = -1;
  for (let i = 1; i < n; i++) {
    const d = (r[2 * i] - r[0]) ** 2 + (r[2 * i + 1] - r[1]) ** 2;
    if (d > best) { best = d; far = i; }
  }
  keep[far] = 1;
  const stack = [[0, far], [far, n]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = r[2 * a], az = r[2 * a + 1], bx = r[2 * (b % n)], bz = r[2 * (b % n) + 1];
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-12;
    let idx = -1, max = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = r[2 * i] - ax, pz = r[2 * i + 1] - az;
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / len2));
      const ex = px - t * dx, ez = pz - t * dz, d2 = ex * ex + ez * ez;
      if (d2 > max) { max = d2; idx = i; }
    }
    if (idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(r[2 * i], r[2 * i + 1]);
  if (out.length < 6) return r;
  const a0 = Math.abs(signedArea(r)), a1 = Math.abs(signedArea(out));
  return Math.abs(a1 - a0) <= 0.06 * a0 ? out : r;
}

// Facade runs. The 1:500 outlines break one facade into many short edges (curves, jogs between parcels, pier bases);
// windows are laid out per run so a curved or jogged front keeps one rhythm of bays. Consecutive edges turning less
// than `maxTurn` belong to the same run. Short edges (< `minor` m) between two long ones that carry on within
// `maxTurn` of each other are wiggles and join the run too; those turning more than `jogTurn` from it are jogs,
// which advance u by their projection on the run and are flagged so the shader keeps them solid.
// Returns per-edge u at both ends (metres along the run), the run's length and index, and the jog flags; zero-length
// edges get run -1.
export function facadeRuns(r, { maxTurn = 20, minor = 1.0, wiggle = 2.5, jogTurn = 50 } = {}) {
  const n = r.length / 2;
  const len = new Float64Array(n), ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ex = r[2 * q] - r[2 * i], ez = r[2 * q + 1] - r[2 * i + 1];
    len[i] = Math.hypot(ex, ez);
    ang[i] = Math.atan2(ez, ex);
  }
  const valid = [];
  for (let i = 0; i < n; i++) if (len[i] >= 0.05) valid.push(i);
  const u0 = new Float64Array(n), u1 = new Float64Array(n), runLen = new Float64Array(n);
  const run = new Int32Array(n).fill(-1), jog = new Uint8Array(n);
  const m = valid.length;
  if (!m) return { u0, u1, runLen, run, jog, runs: 0, closed: false };
  const turnAng = (a, b) => {
    let t = b - a;
    while (t > Math.PI) t -= 2 * Math.PI;
    while (t < -Math.PI) t += 2 * Math.PI;
    return Math.abs(t);
  };
  const turn = (a, b) => turnAng(ang[a], ang[b]);
  const lim = maxTurn * DEG;
  // brk[k]: a new run starts at valid edge k
  const brk = new Uint8Array(m);
  for (let k = 0; k < m; k++) brk[k] = turn(valid[(k + m - 1) % m], valid[k]) >= lim ? 1 : 0;
  // Wiggles: a stretch of short edges between two long edges that carry on in (about) the same direction
  const major = (k) => len[valid[(k + m) % m]] >= minor;
  // per valid edge: direction of the run it was absorbed into (NaN when not absorbed)
  const runAng = new Float64Array(m).fill(NaN);
  if (m >= 3) {
    for (let k = 0; k < m; k++) {
      if (!major(k) || major(k + 1)) continue;
      // k is a long edge followed by short ones: find the next long edge
      let total = 0, s = 1;
      for (; s < m && !major(k + s); s++) total += len[valid[(k + s) % m]];
      if (s >= m || total > wiggle) continue;
      const p = valid[k], q = valid[(k + s) % m];
      if (turn(p, q) >= lim) continue;
      for (let t = 1; t <= s; t++) brk[(k + t) % m] = 0;
      for (let t = 1; t < s; t++) {
        const kk = (k + t) % m;
        runAng[kk] = ang[p];
        if (turnAng(ang[valid[kk]], ang[p]) >= jogTurn * DEG) jog[valid[kk]] = 1;
      }
    }
  }
  let start = brk.indexOf(1);
  const closed = start < 0; // no corner at all (a round building): one run around the ring
  if (closed) start = 0;
  let runIdx = -1, u = 0;
  const members = [];
  const flush = () => { for (const i of members) runLen[i] = u; members.length = 0; };
  for (let s = 0; s < m; s++) {
    const k = (start + s) % m;
    const i = valid[k];
    if (s === 0 || brk[k]) {
      flush();
      runIdx++;
      u = 0;
    }
    // An absorbed wiggle advances u by its length along the run (about nothing for a square jog)
    const du = Number.isNaN(runAng[k]) ? len[i] : Math.max(0, len[i] * Math.cos(ang[i] - runAng[k]));
    u0[i] = u;
    u += du;
    u1[i] = u;
    run[i] = runIdx;
    members.push(i);
  }
  flush();
  return { u0, u1, runLen, run, jog, runs: runIdx + 1, closed };
}

// Walls hidden by neighbours. Every edge of every outline is matched against the edges of other buildings that run
// the other way along the same line (within `tol` metres): those stretches are shared walls. `ringSets[j]` holds
// building j's rings, or null to leave it out (hidden landmarks: their replacement models may not cover the shared
// wall). Returns, per building, per ring, per edge, a list of [t0, t1, j] (metres along the edge, neighbour index) or
// null when nothing touches it.
export function sharedEdges(ringSets, { tol = 0.35, cell = 16 } = {}) {
  // Flat edge table
  let count = 0;
  ringSets.forEach((rings) => { if (rings) for (const r of rings) count += r.length / 2; });
  const ax = new Float64Array(count), az = new Float64Array(count), bx = new Float64Array(count), bz = new Float64Array(count);
  const owner = new Int32Array(count), ringOf = new Int32Array(count), edgeOf = new Int32Array(count);
  let e = 0;
  ringSets.forEach((rings, j) => {
    if (!rings) return;
    rings.forEach((r, k) => {
      for (let i = 0, n = r.length / 2; i < n; i++) {
        const q = (i + 1) % n;
        ax[e] = r[2 * i]; az[e] = r[2 * i + 1]; bx[e] = r[2 * q]; bz[e] = r[2 * q + 1];
        owner[e] = j; ringOf[e] = k; edgeOf[e] = i;
        e++;
      }
    });
  });
  const grid = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let f = 0; f < count; f++) {
    const i0 = Math.floor((Math.min(ax[f], bx[f]) - tol) / cell), i1 = Math.floor((Math.max(ax[f], bx[f]) + tol) / cell);
    const j0 = Math.floor((Math.min(az[f], bz[f]) - tol) / cell), j1 = Math.floor((Math.max(az[f], bz[f]) + tol) / cell);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = key(i, j);
      let list = grid.get(k);
      if (!list) grid.set(k, (list = []));
      list.push(f);
    }
  }
  const out = ringSets.map((rings) => (rings ? rings.map((r) => new Array(r.length / 2).fill(null)) : null));
  const stamp = new Int32Array(count).fill(-1);
  for (let f = 0; f < count; f++) {
    const ex = bx[f] - ax[f], ez = bz[f] - az[f];
    const L = Math.hypot(ex, ez);
    if (L < 0.05) continue;
    const ux = ex / L, uz = ez / L;
    const i0 = Math.floor((Math.min(ax[f], bx[f]) - tol) / cell), i1 = Math.floor((Math.max(ax[f], bx[f]) + tol) / cell);
    const j0 = Math.floor((Math.min(az[f], bz[f]) - tol) / cell), j1 = Math.floor((Math.max(az[f], bz[f]) + tol) / cell);
    let hits = null;
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const list = grid.get(key(i, j));
      if (!list) continue;
      for (const g of list) {
        if (stamp[g] === f || owner[g] === owner[f]) continue;
        stamp[g] = f;
        const gx = bx[g] - ax[g], gz = bz[g] - az[g];
        const lg = Math.hypot(gx, gz);
        if (lg < 0.05 || (gx * ux + gz * uz) / lg > -0.97) continue;
        // both ends of g on the line of f
        const d0 = Math.abs((ax[g] - ax[f]) * uz - (az[g] - az[f]) * ux);
        const d1 = Math.abs((bx[g] - ax[f]) * uz - (bz[g] - az[f]) * ux);
        if (d0 > tol || d1 > tol) continue;
        const t0 = (ax[g] - ax[f]) * ux + (az[g] - az[f]) * uz;
        const t1 = (bx[g] - ax[f]) * ux + (bz[g] - az[f]) * uz;
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
        if (hi - lo < 0.1) continue;
        (hits ||= []).push([lo, hi, owner[g]]);
      }
    }
    if (hits) out[owner[f]][ringOf[f]][edgeOf[f]] = hits;
  }
  return out;
}

// Split an edge of length L into stretches by the neighbours touching it: [[t0, t1, top, party], ...] covering 0..L,
// where `top` is the highest wall top hiding that stretch (-Infinity when free) and `party` whether the hider is a
// proper building (a party wall: windowless above it) rather than a shed. topOf(j) / partyOf(j) describe neighbour j.
export function splitEdge(L, hits, topOf, partyOf) {
  if (!hits) return [[0, L, -Infinity, false]];
  const cuts = [0, L];
  for (const [a, b] of hits) cuts.push(a, b);
  cuts.sort((p, q) => p - q);
  const out = [];
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a = cuts[k], b = cuts[k + 1];
    if (b - a < 0.02) continue;
    const mid = (a + b) / 2;
    let top = -Infinity, party = false;
    for (const [h0, h1, j] of hits) {
      if (mid < h0 || mid > h1) continue;
      const t = topOf(j);
      if (t > top) top = t;
      if (partyOf(j)) party = true;
    }
    const last = out[out.length - 1];
    if (last && last[2] === top && last[3] === party) last[1] = b;
    else out.push([a, b, top, party]);
  }
  return out;
}
