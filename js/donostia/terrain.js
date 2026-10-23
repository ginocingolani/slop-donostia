import * as THREE from 'three/webgpu';
import { decodePNG } from './png.js';

// js/donostia/terrain.js
// LiDAR terrain of Donostia (geoEuskadi 2017 MDT + 1 m isobaths, baked by tools/donostia/build.mjs): a 2 m core grid
// from Igeldo to Ulía inside an 8 m context grid that reaches the horizon hills. Both are cut into square chunks that
// keep every sample. Each chunk has one mesh per level of detail: they share the chunk's vertex buffers and one index
// buffer per level for the whole grid, and switching detail with distance only toggles which one is visible (swapping
// a geometry's index instead makes WebGPURenderer rebuild the draw every time). Skirts hanging under every chunk edge
// hide the cracks between neighbouring levels and the seam with the context grid.

const QUADS = 256; // quads per chunk side
const LOD_STRIDES = [1, 2, 4, 8, 16];
const SKIRT = 6; // m

class HeightField {
  constructor(meta, image, offset) {
    Object.assign(this, { x0: meta.x0, z0: meta.z0, w: meta.w, h: meta.h, res: meta.res });
    this.heights = new Float32Array(this.w * this.h);
    this.classes = new Uint8Array(this.w * this.h); // GEO.terrain.classes ids (B channel)
    const px = image.data;
    for (let k = 0; k < this.heights.length; k++) {
      this.heights[k] = ((px[3 * k] << 8) | px[3 * k + 1]) / 100 - offset;
      this.classes[k] = px[3 * k + 2];
    }
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
      const half = new Uint16Array(this.heights.length);
      for (let k = 0; k < half.length; k++) half[k] = THREE.DataUtils.toHalfFloat(this.heights[k]);
      const t = new THREE.DataTexture(half, this.w, this.h, THREE.RedFormat, THREE.HalfFloatType);
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
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

// Shared index buffers of one chunk layout: (QUADS + 1)^2 grid vertices followed by 4 * (QUADS + 1) skirt vertices
// (north, south, west, east edges). keep(qi, qj) can drop quads (the context grid's hole under the core).
function chunkIndex(stride, keep = null) {
  const n = QUADS + 1;
  const skirt = (edge, t) => n * n + edge * n + t;
  const idx = [];
  for (let qj = 0; qj < QUADS; qj += stride) {
    for (let qi = 0; qi < QUADS; qi += stride) {
      if (keep && !keep(qi + stride / 2, qj + stride / 2)) continue;
      const a = qj * n + qi, b = a + stride, c = a + stride * n, d = c + stride;
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let t = 0; t < QUADS; t += stride) {
    const u = t + stride;
    if (!keep || keep(t + stride / 2, 0)) idx.push(t, u, skirt(0, t), u, skirt(0, u), skirt(0, t)); // north (j = 0)
    if (!keep || keep(t + stride / 2, QUADS - 1)) {
      const r = QUADS * n;
      idx.push(r + t, skirt(1, t), r + u, r + u, skirt(1, t), skirt(1, u)); // south
    }
    if (!keep || keep(0, t + stride / 2)) idx.push(t * n, skirt(2, t), u * n, u * n, skirt(2, t), skirt(2, u)); // west
    if (!keep || keep(QUADS - 1, t + stride / 2)) {
      idx.push(t * n + QUADS, u * n + QUADS, skirt(3, t), u * n + QUADS, skirt(3, u), skirt(3, t)); // east
    }
  }
  return idx.length ? new THREE.BufferAttribute(new Uint32Array(idx), 1) : null;
}

function chunkGeometry(field, ci, cj, sink = null) {
  const n = QUADS + 1;
  const count = n * n + 4 * n;
  const pos = new Float32Array(count * 3);
  // (8-bit normals would need 4 components: WebGPU has no 3-component 8-bit vertex formats)
  const nrm = new Float32Array(count * 3);
  const i0 = ci * QUADS, j0 = cj * QUADS;
  const r = field.res;
  let minY = Infinity, maxY = -Infinity;
  const put = (v, i, j, drop) => {
    const ii = Math.min(i0 + i, field.w - 1), jj = Math.min(j0 + j, field.h - 1);
    const x = field.sampleX(ii), z = field.sampleZ(jj);
    let y = field.at(ii, jj);
    if (sink && sink(x, z)) y -= 0.8;
    pos[3 * v] = x;
    pos[3 * v + 1] = y - drop;
    pos[3 * v + 2] = z;
    const gx = (field.at(ii + 1, jj) - field.at(ii - 1, jj)) / (2 * r);
    const gz = (field.at(ii, jj + 1) - field.at(ii, jj - 1)) / (2 * r);
    const len = Math.hypot(gx, 1, gz);
    nrm[3 * v] = -gx / len;
    nrm[3 * v + 1] = 1 / len;
    nrm[3 * v + 2] = -gz / len;
    if (!drop) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) put(j * n + i, i, j, 0);
  for (let t = 0; t < n; t++) {
    put(n * n + t, t, 0, SKIRT);
    put(n * n + n + t, t, QUADS, SKIRT);
    put(n * n + 2 * n + t, 0, t, SKIRT);
    put(n * n + 3 * n + t, QUADS, t, SKIRT);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const x0 = field.sampleX(i0), z0 = field.sampleZ(j0);
  const x1 = field.sampleX(Math.min(i0 + QUADS, field.w - 1)), z1 = field.sampleZ(Math.min(j0 + QUADS, field.h - 1));
  geo.boundingBox = new THREE.Box3(new THREE.Vector3(x0, minY - SKIRT, z0), new THREE.Vector3(x1, maxY, z1));
  geo.boundingSphere = geo.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geo;
}

export class Terrain {
  static async load(meta) {
    const fetchField = async (m) => {
      const res = await fetch(m.url);
      if (!res.ok) throw new Error(`${m.url}: HTTP ${res.status}`);
      return new HeightField(m, await decodePNG(await res.arrayBuffer()), meta.heightOffset);
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
  }

  // Ground height (m) at a local (x, z): the 2 m core where it exists, the 8 m context elsewhere
  heightAt(x, z) {
    return this.core.contains(x, z) ? this.core.sample(x, z) : this.context.sample(x, z);
  }

  classAt(x, z) {
    return this.core.contains(x, z) ? this.core.classAt(x, z) : this.context.classAt(x, z);
  }

  build(material) {
    const lods = LOD_STRIDES.map((s) => chunkIndex(s));
    const addGrid = (field, kind) => {
      const ncx = Math.ceil((field.w - 1) / QUADS), ncz = Math.ceil((field.h - 1) / QUADS);
      const core = this.core;
      const insideCore = (x, z) => x > core.sampleX(0) && x < core.sampleX(core.w - 1) && z > core.sampleZ(0) && z < core.sampleZ(core.h - 1);
      for (let cj = 0; cj < ncz; cj++) {
        for (let ci = 0; ci < ncx; ci++) {
          let indices = lods;
          if (kind === 'context' && field.sampleX(ci * QUADS + QUADS) > core.x0 && field.sampleX(ci * QUADS) < core.x0 + core.width &&
            field.sampleZ(cj * QUADS + QUADS) > core.z0 && field.sampleZ(cj * QUADS) < core.z0 + core.depth) {
            // drop the quads that lie inside the core; keep their neighbours (sunk a little) so nothing gaps
            const qx = (qi) => field.sampleX(ci * QUADS + qi), qz = (qj) => field.sampleZ(cj * QUADS + qj);
            const keep = (qi, qj) => !insideCore(qx(qi), qz(qj));
            let any = false, all = true;
            for (let qj = 0; qj < QUADS; qj += 8) for (let qi = 0; qi < QUADS; qi += 8) {
              const k = keep(qi + 4, qj + 4);
              any ||= k;
              all &&= k;
            }
            if (!any) continue;
            if (!all) indices = LOD_STRIDES.map((s) => chunkIndex(s, keep));
          }
          const base = chunkGeometry(field, ci, cj, kind === 'context' ? insideCore : null);
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

  // Pick each chunk's level of detail from its distance to the camera (about one pixel per sample for a 1080p, 55°
  // view), with a little hysteresis so chunks don't flicker between two levels at a boundary
  update(cameraPosition) {
    for (const chunk of this.chunks) {
      const d = chunk.box.distanceToPoint(cameraPosition);
      const reach = (lod) => 200 * LOD_STRIDES[lod] * chunk.res / 2;
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
