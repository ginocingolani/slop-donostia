import * as THREE from 'three/webgpu';
import { decodePNGOffThread } from './png.js';

// js/donostia/terrain.js
// LiDAR terrain of Donostia (geoEuskadi 2017 MDT + 1 m isobaths, baked by tools/donostia/build.mjs): a 2 m core grid
// from Igeldo to Ulía inside an 8 m context grid that reaches the horizon hills. Both are cut into square chunks that
// keep every sample (the chunks along the grids' far edges are as small as what is left of the grid). Each chunk has
// one mesh per level of detail: they share the chunk's vertex buffers and one index buffer per level for every chunk
// of the same size, and switching detail with distance only toggles which one is visible (swapping a geometry's index
// instead makes WebGPURenderer rebuild the draw every time). Skirts hanging under every chunk edge hide the cracks
// between neighbouring levels and the seam with the context grid. Chunks wholly under the sea are never built.

const QUADS = 256; // quads per chunk side
const LOD_STRIDES = [1, 2, 4, 8, 16];
const SKIRT = 6; // m
// m: chunks whose highest sample lies below this are always under the (opaque) sea: the god camera stays above it and
// the tide's low water is 1.6 m down
const SUBMERGED = -3;

// Texture.onUpdate for data that only the GPU reads: drops the CPU copy once three has uploaded it (the texture's
// size stays on its image). The textures it is set on never change after their first upload.
export function releaseImageData(texture) {
  texture.image.data = null;
  texture.onUpdate = null;
}

class HeightField {
  // field: png.js's 'heightField' transform of the baked PNG: { heights (m), classes, half (the heights as half floats) }
  constructor(meta, field) {
    Object.assign(this, { x0: meta.x0, z0: meta.z0, w: meta.w, h: meta.h, res: meta.res });
    if (field.heights.length !== this.w * this.h) throw new Error(`${meta.url}: ${field.width}x${field.height}, expected ${this.w}x${this.h}`);
    this.heights = field.heights;
    this.classes = field.classes; // GEO.terrain.classes ids (B channel)
    this._half = field.half;
  }

  get width() { return this.w * this.res; }
  get depth() { return this.h * this.res; }

  classAt(x, z) {
    const i = Math.floor((x - this.x0) / this.res), j = Math.floor((z - this.z0) / this.res);
    if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
    return this.classes[j * this.w + i];
  }

  // GPU copies for the ground & water shaders (built on first use)
  get classTexture() {
    if (!this._classTex) {
      const t = new THREE.DataTexture(this.classes, this.w, this.h, THREE.RedFormat, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this._classTex = t;
    }
    return this._classTex;
  }

  get heightTexture() {
    if (!this._heightTex) {
      const t = new THREE.DataTexture(this._half, this.w, this.h, THREE.RedFormat, THREE.HalfFloatType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      // the half floats exist for the GPU alone: the texture holds them until its upload, then lets them go (the CPU
      // keeps the float heights for heightAt)
      t.onUpdate = releaseImageData;
      this._half = null;
      this._heightTex = t;
    }
    return this._heightTex;
  }

  // samples sit at cell centres
  sampleX(i) { return this.x0 + (i + 0.5) * this.res; }
  sampleZ(j) { return this.z0 + (j + 0.5) * this.res; }
  at(i, j) {
    i = i < 0 ? 0 : i >= this.w ? this.w - 1 : i;
    j = j < 0 ? 0 : j >= this.h ? this.h - 1 : j;
    return this.heights[j * this.w + i];
  }

  contains(x, z) {
    return x >= this.x0 + this.res && x <= this.x0 + (this.w - 1) * this.res && z >= this.z0 + this.res && z <= this.z0 + (this.h - 1) * this.res;
  }

  sample(x, z, values = this.heights) {
    const fx = (x - this.x0) / this.res - 0.5, fz = (z - this.z0) / this.res - 0.5;
    let i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    i = Math.max(0, Math.min(this.w - 2, i));
    j = Math.max(0, Math.min(this.h - 2, j));
    const k = j * this.w + i;
    const a = values[k], b = values[k + 1], c = values[k + this.w], d = values[k + this.w + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }
}

// The quad columns (or rows) a chunk side `q` quads long starts at a level's stride: every stride-th, then the side's
// end, as an edge chunk's side need not be a multiple of the stride (its last quad is narrower)
function steps(q, stride) {
  const s = [];
  for (let t = 0; t < q; t += stride) s.push(t);
  s.push(q);
  return s;
}

// Index buffer of one chunk layout at one level: a (cols + 1) x (rows + 1) vertex grid followed by the skirt vertices of
// the north & south (cols + 1 each) and west & east (rows + 1 each) edges. keep(qi, qj) can drop quads (the context
// grid's hole under the core); null when it drops them all.
function chunkIndex(cols, rows, stride, keep = null) {
  const nx = cols + 1, nz = rows + 1;
  const north = nx * nz, south = north + nx, west = south + nx, east = west + nz;
  const us = steps(cols, stride), vs = steps(rows, stride);
  const qx = us.length - 1, qz = vs.length - 1;
  const idx = new Uint32Array(6 * (qx * qz + 2 * qx + 2 * qz));
  let n = 0;
  const tri = (a, b, c, d, e, f) => {
    idx[n] = a; idx[n + 1] = b; idx[n + 2] = c; idx[n + 3] = d; idx[n + 4] = e; idx[n + 5] = f;
    n += 6;
  };
  for (let b = 0; b < qz; b++) {
    const qj = vs[b], qj1 = vs[b + 1];
    for (let a = 0; a < qx; a++) {
      const qi = us[a], qi1 = us[a + 1];
      if (keep && !keep((qi + qi1) / 2, (qj + qj1) / 2)) continue;
      const p = qj * nx + qi, q = qj * nx + qi1, r = qj1 * nx + qi, s = qj1 * nx + qi1;
      tri(p, r, q, q, r, s);
    }
  }
  const last = rows * nx;
  for (let a = 0; a < qx; a++) {
    const t = us[a], u = us[a + 1], mid = (t + u) / 2;
    if (!keep || keep(mid, 0)) tri(t, u, north + t, u, north + u, north + t);
    if (!keep || keep(mid, rows - 1)) tri(last + t, south + t, last + u, last + u, south + t, south + u);
  }
  for (let b = 0; b < qz; b++) {
    const t = vs[b], u = vs[b + 1], mid = (t + u) / 2;
    if (!keep || keep(0, mid)) tri(t * nx, west + t, u * nx, u * nx, west + t, west + u);
    if (!keep || keep(cols - 1, mid)) tri(t * nx + cols, u * nx + cols, east + t, u * nx + cols, east + u, east + t);
  }
  return n ? new THREE.BufferAttribute(n < idx.length ? idx.slice(0, n) : idx, 1) : null;
}

// The vertex buffers of the chunk whose grid starts at sample (i0, j0) and spans cols x rows quads (exactly: edge
// chunks are smaller, not padded), or null for a chunk wholly under the sea (Terrain.update would never show it).
// sink(x, z): samples sunk 0.8 m (the context grid under the core's edge).
function chunkGeometry(field, i0, j0, cols, rows, sink = null) {
  const { heights, w, h } = field;
  const nx = cols + 1, nz = rows + 1;
  const ys = new Float64Array(nx * nz); // (the skirts' drop is taken off before rounding to 32 bits, as for every vertex)
  let minY = Infinity, maxY = -Infinity;
  for (let j = 0, v = 0; j < nz; j++) {
    const row = (j0 + j) * w + i0, z = field.sampleZ(j0 + j);
    for (let i = 0; i < nx; i++, v++) {
      let y = heights[row + i];
      if (sink !== null && sink(field.sampleX(i0 + i), z)) y -= 0.8;
      ys[v] = y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxY < SUBMERGED) return null;

  const count = nx * nz + 2 * nx + 2 * nz;
  const pos = new Float32Array(count * 3);
  // normals as normalized 16-bit (a third less than floats, the same shading); WebGPU has no 3-component 16-bit
  // vertex format, hence the 4th component
  const nrm = new Int16Array(count * 4);
  const r2 = 2 * field.res;
  const put = (v, i, j, drop) => {
    const ii = i0 + i, jj = j0 + j, k = jj * w + ii;
    pos[3 * v] = field.sampleX(ii);
    pos[3 * v + 1] = ys[j * nx + i] - drop;
    pos[3 * v + 2] = field.sampleZ(jj);
    // central differences, one-sided at the field's edges
    const gx = (heights[ii < w - 1 ? k + 1 : k] - heights[ii > 0 ? k - 1 : k]) / r2;
    const gz = (heights[jj < h - 1 ? k + w : k] - heights[jj > 0 ? k - w : k]) / r2;
    const s = 32767 / Math.sqrt(gx * gx + 1 + gz * gz);
    nrm[4 * v] = Math.round(-gx * s);
    nrm[4 * v + 1] = Math.round(s);
    nrm[4 * v + 2] = Math.round(-gz * s);
  };
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) put(j * nx + i, i, j, 0);
  const north = nx * nz, south = north + nx, west = south + nx, east = west + nz;
  for (let t = 0; t < nx; t++) {
    put(north + t, t, 0, SKIRT);
    put(south + t, t, rows, SKIRT);
  }
  for (let t = 0; t < nz; t++) {
    put(west + t, 0, t, SKIRT);
    put(east + t, cols, t, SKIRT);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 4, true));
  const x0 = field.sampleX(i0), z0 = field.sampleZ(j0), x1 = field.sampleX(i0 + cols), z1 = field.sampleZ(j0 + rows);
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, minY - SKIRT, z0), new THREE.Vector3(x1, maxY, z1));
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geo;
}

export class Terrain {
  static async load(meta) {
    const fetchField = async (m) => {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
      return new HeightField(m, await decodePNGOffThread(await res.arrayBuffer(), 'heightField', meta.heightOffset));
    };
    const [core, context] = await Promise.all([fetchField(meta.core), fetchField(meta.context)]);
    return new Terrain(core, context);
  }

  constructor(core, context) {
    this.core = core;
    this.context = context;
    this.group = new THREE.Group();
    this.group.name = 'DonostiaTerrain';
    this.chunks = [];
    this.lodScale = 1; // distance multiplier of every level's reach (smaller: coarser levels sooner)
  }

  // Ground height (m) at a local (x, z): the 2 m core where it exists, the 8 m context elsewhere
  heightAt(x, z) {
    return this.core.contains(x, z) ? this.core.sample(x, z) : this.context.sample(x, z);
  }

  classAt(x, z) {
    return this.core.contains(x, z) ? this.core.classAt(x, z) : this.context.classAt(x, z);
  }

  // Every chunk's meshes share `material`; build() may run before it exists (main.js builds the chunks while the
  // ground maps still decode) and setMaterial() hand it over
  setMaterial(material) {
    for (const chunk of this.chunks) for (const mesh of chunk.meshes) if (mesh) mesh.material = material;
  }

  build(material = null) {
    material ||= new THREE.MeshBasicNodeMaterial();
    // one set of index buffers per chunk layout (the full one and the edge chunks' smaller ones), core & context alike
    const layouts = new Map();
    const layoutIndices = (cols, rows) => {
      const key = `${cols}x${rows}`;
      if (!layouts.has(key)) layouts.set(key, LOD_STRIDES.map((s) => chunkIndex(cols, rows, s)));
      return layouts.get(key);
    };
    const addGrid = (field, kind) => {
      const ncx = Math.ceil((field.w - 1) / QUADS), ncz = Math.ceil((field.h - 1) / QUADS);
      const core = this.core;
      const insideCore = (x, z) => x > core.sampleX(0) && x < core.sampleX(core.w - 1) && z > core.sampleZ(0) && z < core.sampleZ(core.h - 1);
      for (let cj = 0; cj < ncz; cj++) {
        for (let ci = 0; ci < ncx; ci++) {
          const i0 = ci * QUADS, j0 = cj * QUADS;
          const cols = Math.min(QUADS, field.w - 1 - i0), rows = Math.min(QUADS, field.h - 1 - j0);
          let keep = null;
          if (kind === 'context' && field.sampleX(i0 + cols) > core.x0 && field.sampleX(i0) < core.x0 + core.width &&
            field.sampleZ(j0 + rows) > core.z0 && field.sampleZ(j0) < core.z0 + core.depth) {
            // drop the quads that lie inside the core; keep their neighbours (sunk a little) so nothing gaps
            const outside = (qi, qj) => !insideCore(field.sampleX(i0 + qi), field.sampleZ(j0 + qj));
            let any = false, all = true;
            for (let qj = 0; qj < rows; qj += 8) for (let qi = 0; qi < cols; qi += 8) {
              const k = outside(qi + 4, qj + 4);
              any ||= k;
              all &&= k;
            }
            if (!any) continue;
            if (!all) keep = outside;
          }
          const base = chunkGeometry(field, i0, j0, cols, rows, kind === 'context' ? insideCore : null);
          if (!base) continue; // under the sea for good
          const indices = keep ? LOD_STRIDES.map((s) => chunkIndex(cols, rows, s, keep)) : layoutIndices(cols, rows);
          const chunk = { box: base.boundingBox, res: field.res, lod: -1, meshes: [] };
          indices.forEach((index) => {
            if (!index) { chunk.meshes.push(null); return; }
            const geo = new THREE.BufferGeometry();
            geo.setAttribute('position', base.getAttribute('position'));
            geo.setAttribute('normal', base.getAttribute('normal'));
            geo.setIndex(index);
            geo.boundingBox = base.boundingBox;
            geo.boundingSphere = base.boundingSphere;
            const mesh = new THREE.Mesh(geo, material);
            mesh.receiveShadow = true;
            mesh.castShadow = kind === 'core';
            mesh.matrixAutoUpdate = false;
            mesh.visible = false;
            this.group.add(mesh);
            chunk.meshes.push(mesh);
          });
          this.chunks.push(chunk);
        }
      }
    };
    addGrid(this.core, 'core');
    addGrid(this.context, 'context');
    return this.group;
  }

  // Shows every level of every chunk (for the pipeline warm-up frame) or restores the distance-based choice
  setAllVisible(all) {
    for (const chunk of this.chunks) {
      chunk.meshes.forEach((m, lod) => { if (m) m.visible = all || lod === chunk.lod; });
    }
  }

  // Pick each chunk's level of detail from its distance to the camera (triangles of 4-8 px for a 1080p, 55° view),
  // with a little hysteresis so chunks don't flicker between two levels at a boundary
  update(cameraPosition) {
    for (const chunk of this.chunks) {
      const d = chunk.box.distanceToPoint(cameraPosition);
      const reach = (l) => 200 * LOD_STRIDES[l] * chunk.res / 2 * this.lodScale;
      let lod = 0;
      while (lod < LOD_STRIDES.length - 1 && d > reach(lod + 1)) lod++;
      if (chunk.lod >= 0 && Math.abs(lod - chunk.lod) === 1) {
        const edge = reach(Math.max(lod, chunk.lod));
        if (Math.abs(d - edge) < 0.08 * edge) lod = chunk.lod;
      }
      while (lod > 0 && !chunk.meshes[lod]) lod--;
      if (lod === chunk.lod) continue;
      if (chunk.lod >= 0 && chunk.meshes[chunk.lod]) chunk.meshes[chunk.lod].visible = false;
      if (chunk.meshes[lod]) chunk.meshes[lod].visible = true;
      chunk.lod = lod;
    }
  }
}
