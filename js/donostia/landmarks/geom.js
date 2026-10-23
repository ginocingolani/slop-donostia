import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// js/donostia/landmarks/geom.js
// Geometry helpers shared by the landmark modules (js/donostia/landmarks/*.js): the per-material merger, footprint ring
// operations, a hip roof, smooth quad grids and box beams. Rings are flat [x0, z0, x1, z1, ...] arrays without a
// repeated closing point. Materials and shader helpers live in kit.js; the western landmarks share igeldo.js's
// vertex-coloured PartBin, the civic and central ones udaletxea.js's CivicModel and bretxa.js's CentreModel.

// --- merging ----------------------------------------------------------------------------------------------------------

const KEEP = ['position', 'normal', 'uv'];
const KEEP_COLOURED = ['position', 'normal', 'uv', 'color'];

// Pieces collected per material and merged into one mesh each: one draw call per material. Every piece keeps only its
// position, normal and uv (zeros when it has none); a vertex-coloured material also keeps the piece's own `color`, or
// gets the colour given to add().
export class Parts {
  constructor() { this.byMaterial = new Map(); }

  add(material, geometry, color = [1, 1, 1]) {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    const keep = material.vertexColors ? KEEP_COLOURED : KEEP;
    for (const name of Object.keys(g.attributes)) if (!keep.includes(name)) g.deleteAttribute(name);
    const count = g.attributes.position.count;
    if (!g.attributes.normal) g.computeVertexNormals();
    if (!g.attributes.uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    if (material.vertexColors && !g.attributes.color) {
      const c = new Float32Array(count * 3);
      for (let k = 0; k < count; k++) c.set(color, 3 * k);
      g.setAttribute('color', new THREE.Float32BufferAttribute(c, 3));
    }
    g.clearGroups();
    if (!this.byMaterial.has(material)) this.byMaterial.set(material, []);
    this.byMaterial.get(material).push(g);
    return g;
  }

  // As add(), then moves the piece by `matrix` (pieces modelled in a local frame)
  addAt(material, geometry, matrix) {
    this.add(material, geometry).applyMatrix4(matrix);
  }

  // What has been added so far, and the way back to it: a module building several sites into one Parts drops the
  // pieces of a site that fails halfway, so a half-built landmark never stands over the plain extrusion kept for it
  mark() {
    return new Map([...this.byMaterial].map(([material, list]) => [material, list.length]));
  }

  rollback(mark) {
    for (const [material, list] of this.byMaterial) {
      const n = mark.get(material) || 0;
      if (n) list.length = n;
      else this.byMaterial.delete(material);
    }
  }

  build(name) {
    const group = new THREE.Group();
    group.name = name;
    for (const [material, list] of this.byMaterial) {
      const geometry = mergeGeometries(list);
      if (!geometry) continue;
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    return group;
  }
}

// --- rings ------------------------------------------------------------------------------------------------------------

// Signed area (shoelace): positive when the ring's edge normals (dz, -dx) point out of it
export function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

export function reverseRing(r) {
  const out = [];
  for (let k = r.length - 2; k >= 0; k -= 2) out.push(r[k], r[k + 1]);
  return out;
}

// Ring with the requested winding (positive: edge normals (dz, -dx) point out of the solid). From wound() in
// js/donostia/buildings.js.
export function wound(r, positive = true) {
  return (ringArea(r) > 0) === positive ? r : reverseRing(r);
}

// Drops near-duplicate neighbours and a closing vertex that repeats the first (OSM rings)
export function cleanRing(r) {
  const out = [];
  for (let k = 0; k < r.length; k += 2) {
    const n = out.length;
    if (n && Math.hypot(r[k] - out[n - 2], r[k + 1] - out[n - 1]) < 0.05) continue;
    out.push(r[k], r[k + 1]);
  }
  while (out.length > 6 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < 0.05) out.length -= 2;
  return out;
}

// Miter offset of a positively wound ring by d towards its inside (negative d grows it); null when an edge flips or
// the ring shrinks below 2 % of its area (a hip roof's ridge inset may leave a thin sliver). From insetRing() in
// js/donostia/buildings.js.
export function insetRing(r, d) {
  const n = r.length / 2;
  const out = new Array(r.length);
  for (let i = 0; i < n; i++) {
    const p = (i + n - 1) % n, q = (i + 1) % n;
    let ax = r[2 * i] - r[2 * p], az = r[2 * i + 1] - r[2 * p + 1];
    let bx = r[2 * q] - r[2 * i], bz = r[2 * q + 1] - r[2 * i + 1];
    const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const n1x = -az, n1z = ax, n2x = -bz, n2z = bx; // inward normals
    const denom = 1 + (n1x * n2x + n1z * n2z);
    if (denom < 0.25) return null;
    out[2 * i] = r[2 * i] + (d * (n1x + n2x)) / denom;
    out[2 * i + 1] = r[2 * i + 1] + (d * (n1z + n2z)) / denom;
  }
  for (let i = 0; i < n; i++) {
    const q = (i + 1) % n;
    const ox = r[2 * q] - r[2 * i], oz = r[2 * q + 1] - r[2 * i + 1];
    const nx = out[2 * q] - out[2 * i], nz = out[2 * q + 1] - out[2 * i + 1];
    if (ox * nx + oz * nz <= 0) return null;
  }
  const a0 = ringArea(r), a1 = ringArea(out);
  if (Math.sign(a0) !== Math.sign(a1) || Math.abs(a1) < 0.02 * Math.abs(a0)) return null;
  return out;
}

// Drops vertices closer than tol to the line through their neighbours (near-collinear runs and tiny jogs), which
// would otherwise flip under the large insets of a hip roof
export function simplify(r, tol = 0.35) {
  const pts = [];
  for (let k = 0; k < r.length; k += 2) pts.push([r[k], r[k + 1]]);
  for (let changed = true; changed && pts.length > 4;) {
    changed = false;
    for (let i = 0; i < pts.length && pts.length > 4; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length];
      const dx = c[0] - a[0], dz = c[1] - a[1];
      if (Math.abs((b[0] - a[0]) * dz - (b[1] - a[1]) * dx) / (Math.hypot(dx, dz) || 1e-9) < tol) {
        pts.splice(i--, 1);
        changed = true;
      }
    }
  }
  return pts.flat();
}

// The part of a ring where a·x + b·z + c >= 0 (a half-plane cut, Sutherland–Hodgman), or null when too little is left
export function clipRing(r, a, b, c) {
  const out = [];
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = r[2 * i], z0 = r[2 * i + 1], x1 = r[2 * j], z1 = r[2 * j + 1];
    const d0 = a * x0 + b * z0 + c, d1 = a * x1 + b * z1 + c;
    if (d0 >= 0) out.push(x0, z0);
    if ((d0 >= 0) !== (d1 >= 0)) {
      const t = d0 / (d0 - d1);
      out.push(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
    }
  }
  const ring = cleanRing(out);
  return ring.length >= 6 && Math.abs(ringArea(ring)) > 1 ? ring : null;
}

// Point in ring (even-odd)
export function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, n = r.length / 2, j = n - 1; i < n; j = i++) {
    const xi = r[2 * i], zi = r[2 * i + 1], xj = r[2 * j], zj = r[2 * j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// Distance from a point to a ring's edges
export function distToRing(x, z, r) {
  let best = Infinity;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const q = (i + 1) % n;
    const ax = r[2 * i], az = r[2 * i + 1], dx = r[2 * q] - ax, dz = r[2 * q + 1] - az;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1e-12)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, z - az - t * dz));
  }
  return best;
}

// Mean of a ring's vertices
export function centroid(r) {
  let x = 0, z = 0;
  for (let k = 0; k < r.length; k += 2) { x += r[k]; z += r[k + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
}

// --- solids -----------------------------------------------------------------------------------------------------------

// Newell normal of a planar polygon [[x, y, z], ...], or null when it is degenerate
export function newell(pts) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    nx += (p[1] - q[1]) * (p[2] + q[2]);
    ny += (p[2] - q[2]) * (p[0] + q[0]);
    nz += (p[0] - q[0]) * (p[1] + q[1]);
  }
  const l = Math.hypot(nx, ny, nz);
  return l < 1e-12 ? null : [nx / l, ny / l, nz / l];
}

// Hip roof over a ring: slopes rising `rise` from the eaves to a ridge (an inset of about half the ring's width);
// flat just over the walls' top when no inset survives
export function hipRoof(ring, eave, rise, inset) {
  const r = wound(simplify(ring));
  const pos = [], nrm = [];
  const tri = (a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; [b, c] = [c, b]; }
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-9) return;
    for (const p of [a, b, c]) { pos.push(...p); nrm.push(nx / l, ny / l, nz / l); }
  };
  const cap = (ring2, y) => {
    const pts = [];
    for (let k = 0; k < ring2.length; k += 2) pts.push(new THREE.Vector2(ring2[k], ring2[k + 1]));
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(pts, [])) {
      tri([pts[a].x, y, pts[a].y], [pts[b].x, y, pts[b].y], [pts[c].x, y, pts[c].y]);
    }
  };
  let inner = null;
  for (let d = inset, k = 0; k < 8 && !inner; k++, d *= 0.8) inner = insetRing(r, d);
  if (!inner) cap(r, eave + 0.08);
  else {
    const top = eave + rise;
    for (let i = 0, n = r.length / 2; i < n; i++) {
      const q = (i + 1) % n;
      const o0 = [r[2 * i], eave, r[2 * i + 1]], o1 = [r[2 * q], eave, r[2 * q + 1]];
      const i0 = [inner[2 * i], top, inner[2 * i + 1]], i1 = [inner[2 * q], top, inner[2 * q + 1]];
      tri(o0, o1, i1);
      tri(o0, i1, i0);
    }
    cap(inner, top);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

// A smooth quad grid: point(i, j) -> [x, y, z] for i in 0..nu, j in 0..nv, texcoord(i, j) -> [u, v]. Normals are
// turned to agree with out(i, j) (a direction hint); a closed loop (column nu repeating column 0) gets one normal there.
export function grid(nu, nv, point, texcoord, out, closed = true) {
  const n = (nu + 1) * (nv + 1);
  const pos = new Float32Array(n * 3), tex = new Float32Array(n * 2);
  for (let j = 0, k = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++, k++) {
      pos.set(point(i, j), 3 * k);
      tex.set(texcoord(i, j), 2 * k);
    }
  }
  const index = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i, b = a + 1, c = a + nu + 1, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(tex, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  const nrm = g.attributes.normal.array;
  const im = nu >> 1, jm = nv >> 1, km = jm * (nu + 1) + im, hint = out(im, jm);
  if (nrm[3 * km] * hint[0] + nrm[3 * km + 1] * hint[1] + nrm[3 * km + 2] * hint[2] < 0) {
    for (let t = 0; t < index.length; t += 3) [index[t + 1], index[t + 2]] = [index[t + 2], index[t + 1]];
    g.setIndex(index);
    for (let k = 0; k < nrm.length; k++) nrm[k] = -nrm[k];
  }
  if (closed) {
    for (let j = 0; j <= nv; j++) {
      const a = 3 * j * (nu + 1), b = 3 * (j * (nu + 1) + nu);
      for (let c = 0; c < 3; c++) nrm[a + c] = nrm[b + c] = (nrm[a + c] + nrm[b + c]) / 2;
    }
  }
  return g;
}

// A box beam of section w x h from p0 to p1 (h measured square to the beam, towards the up side)
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
export function beam(p0, p1, w, h = w) {
  _y.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
  const len = _y.length();
  _y.normalize();
  _x.set(0, 1, 0).cross(_y);
  if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0).cross(_y);
  _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z).setPosition((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  return new THREE.BoxGeometry(w, len, h).applyMatrix4(_m);
}
