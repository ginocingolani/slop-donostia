// js/donostia/colliders.js
// The buildings as solids for the god camera (js/donostia/god-camera.js): each GEO.buildings record is a prism, its
// footprint rings (the outer one and its courtyards) standing from the ground (base) to the ridge (top). The camera is a
// sphere of radius r that slides along the walls it meets, lands on the roofs it comes down onto, and is pushed out of
// any footprint it finds itself inside (a saved view, the end of a flight). It flies freely over the roofs.
//
// Built once from the records: every ring's edges as wall segments (x0, z0, x1, z1, base, top) and the buildings'
// boxes, both bucketed in a uniform grid of CELL m so a step only looks at the walls around it; each cell also keeps the
// highest top in it, so a camera above every roof nearby costs one lookup.
//
// createColliders(buildings) -> { resolve(p, v, prev, r, eye), clearance(x, z), stats }

const CELL = 32; // m
const REACH = 2; // m: the widest radius a step may use (segments are bucketed this far past their ends)

export function createColliders(buildings) {
  // the grid's extent: every footprint, plus the reach
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity, nSeg = 0;
  for (const b of buildings) {
    for (const ring of b.g) {
      for (let i = 0; i < ring.length; i += 2) {
        const x = ring[i], z = ring[i + 1];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
      nSeg += ring.length / 2;
    }
  }
  minX -= REACH + 1; minZ -= REACH + 1; maxX += REACH + 1; maxZ += REACH + 1;
  const nx = Math.max(1, Math.ceil((maxX - minX) / CELL)), nz = Math.max(1, Math.ceil((maxZ - minZ) / CELL));
  const cellOf = (x, z) => {
    const i = Math.floor((x - minX) / CELL), j = Math.floor((z - minZ) / CELL);
    return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
  };

  // wall segments and building boxes
  const seg = new Float32Array(nSeg * 6);
  const box = new Float32Array(buildings.length * 4);
  let k = 0;
  buildings.forEach((b, bi) => {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const ring of b.g) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = ring[2 * i], az = ring[2 * i + 1], bx = ring[2 * j], bz = ring[2 * j + 1];
        if (ax < x0) x0 = ax;
        if (ax > x1) x1 = ax;
        if (az < z0) z0 = az;
        if (az > z1) z1 = az;
        if (ax === bx && az === bz) continue; // a closed ring's repeated point
        seg.set([ax, az, bx, bz, b.base, b.top], 6 * k++);
      }
    }
    box.set([x0, z0, x1, z1], 4 * bi);
  });
  const segCount = k;

  // the cells' lists (CSR): segments within the reach of a cell, buildings whose box touches it; the cell's highest top
  const segCells = (s) => {
    const o = 6 * s;
    return [seg[o], seg[o + 1], seg[o + 2], seg[o + 3]];
  };
  const span = (ax, az, bx, bz, pad, fn) => {
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - pad - minX) / CELL)), i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + pad - minX) / CELL));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - pad - minZ) / CELL)), j1 = Math.min(nz - 1, Math.floor((Math.max(az, bz) + pad - minZ) / CELL));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * nx + i);
  };
  const csr = (count, each) => {
    const start = new Uint32Array(nx * nz + 1);
    for (let s = 0; s < count; s++) each(s, (c) => start[c + 1]++);
    for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
    const fill = start.slice(0, nx * nz), list = new Uint32Array(start[nx * nz]);
    for (let s = 0; s < count; s++) each(s, (c) => { list[fill[c]++] = s; });
    return { start, list };
  };
  const walls = csr(segCount, (s, add) => { const [ax, az, bx, bz] = segCells(s); span(ax, az, bx, bz, REACH, add); });
  const homes = csr(buildings.length, (bi, add) => { const o = 4 * bi; span(box[o], box[o + 1], box[o + 2], box[o + 3], 0, add); });
  const ceiling = new Float32Array(nx * nz).fill(-Infinity);
  for (let s = 0; s < segCount; s++) {
    const [ax, az, bx, bz] = segCells(s), top = seg[6 * s + 5];
    span(ax, az, bx, bz, REACH, (c) => { if (top > ceiling[c]) ceiling[c] = top; });
  }

  // even-odd test over all of a building's rings, so its courtyards are open to the sky
  function inside(b, x, z) {
    let hit = false;
    for (const ring of b.g) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[2 * i], zi = ring[2 * i + 1], xj = ring[2 * j], zj = ring[2 * j + 1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
      }
    }
    return hit;
  }

  // the nearest point on building bi's walls to (x, z): [x, z, distance]
  function nearestWall(bi, x, z) {
    const b = buildings[bi];
    let best = Infinity, bx = x, bz = z;
    for (const ring of b.g) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [cx, cz] = closest(ring[2 * i], ring[2 * i + 1], ring[2 * j], ring[2 * j + 1], x, z);
        const d = Math.hypot(x - cx, z - cz);
        if (d < best) { best = d; bx = cx; bz = cz; }
      }
    }
    return [bx, bz, best];
  }

  /**
   * Keeps the sphere at p (a THREE.Vector3, eye height included) out of the buildings, in place: v (its velocity) loses
   * what pushes into a wall or a roof. prev is where the camera was before this step (to tell a landing from a walk
   * into a wall). r: the sphere's radius (≤ REACH); eye: the height kept over a roof. Returns true if it moved p.
   */
  function resolve(p, v, prev, r = 0.8, eye = 1.7) {
    const c = cellOf(p.x, p.z);
    if (c < 0 || p.y > ceiling[c] + eye + r) return false;
    let moved = false;
    // inside a footprint, under its roof: onto the roof if it came down from above (or came from nowhere: a saved view,
    // a flight's end), else out through the nearest wall
    for (let q = homes.start[c]; q < homes.start[c + 1]; q++) {
      const bi = homes.list[q], b = buildings[bi], o = 4 * bi;
      if (p.x < box[o] || p.x > box[o + 2] || p.z < box[o + 1] || p.z > box[o + 3]) continue;
      const roof = b.top + eye;
      if (p.y >= roof || !inside(b, p.x, p.z)) continue;
      if (!prev || prev.y >= roof - 1e-3) {
        p.y = roof;
        if (v.y < 0) v.y = 0;
      } else {
        const [wx, wz, d] = nearestWall(bi, p.x, p.z);
        const nx_ = d > 1e-6 ? (wx - p.x) / d : 1, nz_ = d > 1e-6 ? (wz - p.z) / d : 0; // outwards
        p.x = wx + nx_ * r;
        p.z = wz + nz_ * r;
        const vn = v.x * nx_ + v.z * nz_;
        if (vn < 0) { v.x -= nx_ * vn; v.z -= nz_ * vn; }
      }
      moved = true;
    }
    // the walls within r, twice over for the corners
    for (let pass = 0; pass < 2; pass++) {
      const cc = cellOf(p.x, p.z);
      if (cc < 0) break;
      for (let q = walls.start[cc]; q < walls.start[cc + 1]; q++) {
        const o = 6 * walls.list[q];
        if (p.y > seg[o + 5] + 0.25 || p.y < seg[o + 4] - eye) continue;
        const [cx, cz] = closest(seg[o], seg[o + 1], seg[o + 2], seg[o + 3], p.x, p.z);
        const dx = p.x - cx, dz = p.z - cz, d = Math.hypot(dx, dz);
        if (d >= r) continue;
        let nx_, nz_;
        if (d > 1e-6) { nx_ = dx / d; nz_ = dz / d; } else {
          // on the wall's line: out along its normal, the side the camera came from
          const ex = seg[o + 2] - seg[o], ez = seg[o + 3] - seg[o + 1], el = Math.hypot(ex, ez) || 1;
          nx_ = -ez / el; nz_ = ex / el;
          if (prev && (prev.x - cx) * nx_ + (prev.z - cz) * nz_ < 0) { nx_ = -nx_; nz_ = -nz_; }
        }
        p.x = cx + nx_ * r;
        p.z = cz + nz_ * r;
        const vn = v.x * nx_ + v.z * nz_;
        if (vn < 0) { v.x -= nx_ * vn; v.z -= nz_ * vn; }
        moved = true;
      }
    }
    return moved;
  }

  // the height a camera at (x, z) must clear to fly over every roof within the reach (for the step size)
  const clearance = (x, z) => { const c = cellOf(x, z); return c < 0 ? -Infinity : ceiling[c]; };

  return { resolve, clearance, stats: { buildings: buildings.length, walls: segCount, cells: nx * nz } };
}

// the point of segment a-b nearest to p
function closest(ax, az, bx, bz, px, pz) {
  const ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
  const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * ex + (pz - az) * ez) / l2)) : 0;
  return [ax + ex * t, az + ez * t];
}
