import * as THREE from 'three/webgpu';
import { STREETSCAPE } from './data-streetscape.js';
import { createLeafAtlas } from './trees-atlas.js';
import { SPECIES, buildTreeGeometries, buildFarGeometry } from './trees-species.js';
import { createTreeMaterial, createFarTreeMaterial } from './trees-material.js';

// js/donostia/vegetation.js
// Donostia's trees: the municipal tree pits (9,118 street trees), OSM's mapped trees, the woodland masses of Urgull,
// Igeldo, Ulía, Miramar, Cristina Enea & Aiete and a scatter over the gardens, baked with their species and scale by
// tools/donostia/bake-streetscape.mjs (js/donostia/data-streetscape.js). Grown by trees-species.js, shaded by
// trees-material.js, standing on terrain.heightAt.
// buildVegetation(GEO, terrain) -> Promise<Object3D>; its userData.update(dt, elapsed, camera) runs every frame.
//
// Levels of detail, picked per tree from the camera (3D distance to mid-crown) whenever it has moved a few metres:
// - near (every twig) & mid (cards along the branches): one instanced mesh per species / variant / level, refilled
//   with the trees in reach (found by searching only the 64 m cells within LOD_MID of the camera)
// - far: one draw for all the trees of the city (a parametric crown & trunk shaped per instance in the shader), which
//   folds away the trees the near & mid meshes drew, measured from the same point (uLodCenter) with the same distance,
//   so the hand-over needs no per-tree upload and the city's ~27,000 trees cost one static buffer

const LOD_NEAR = 85; // m: full detail within
const LOD_MID = 300; // m: cards along the branches within; the far trees beyond
const LOD_HYSTERESIS = 6; // m, between near & mid only (the far shader can't see the history)
const FAR_END = 3400; // m: the far trees shrink away before this
const REPICK = 3; // m the camera moves before the levels are picked again
const CELL = 64; // m, cells searched for trees in reach

// hashPos of js/trees.js (slop-newyork)
function hashPos(x, y, z) {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function decodeBase64(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Packed by the bake: Int32 x, z (cm) interleaved | Uint8 species | Uint8 scale x 100
function decodeTrees({ count: n, data }) {
  const bytes = decodeBase64(data);
  const view = new DataView(bytes.buffer);
  const x = new Float32Array(n), z = new Float32Array(n), sp = new Uint8Array(n), s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = view.getInt32(8 * i, true) / 100;
    z[i] = view.getInt32(8 * i + 4, true) / 100;
    sp[i] = Math.min(SPECIES.length - 1, bytes[8 * n + i]);
    s[i] = bytes[9 * n + i] / 100;
  }
  return { n, x, z, sp, s };
}

export async function buildVegetation(GEO, terrain) {
  const trees = decodeTrees(STREETSCAPE.trees);
  const N = trees.n;
  const group = new THREE.Group();
  group.name = 'DonostiaTrees';
  if (!N) return null;

  const atlas = createLeafAtlas();
  const material = createTreeMaterial(atlas.texture);
  const far = createFarTreeMaterial(atlas.texture, SPECIES.map((sp) => sp.far));
  far.uniforms.midEnd.value = LOD_MID;
  far.uniforms.farEnd.value = FAR_END;

  // Geometries & crowns: [species][variant] = { geometries: [near, mid], crown }
  const kits = SPECIES.map((_, s) => [0, 1].map((v) => buildTreeGeometries(s, v, atlas.tileMeters)));

  // Per-tree transform & data
  const mats = new Float32Array(N * 16);
  const data = new Float32Array(N * 4);
  const farPos = new Float32Array(N * 4);
  const farShape = new Float32Array(N * 4);
  const meshOf = new Uint8Array(N); // (species * 2 + variant) * 2 = its near mesh, + 1 = its mid mesh
  const capacity = new Uint32Array(SPECIES.length * 4);
  const dummy = new THREE.Object3D();
  const tint = new THREE.Color();
  for (let i = 0; i < N; i++) {
    const x = trees.x[i], z = trees.z[i], sp = trees.sp[i], spec = SPECIES[sp];
    const r1 = hashPos(x, 1.3, z), r2 = hashPos(z, 7.1, x), r3 = hashPos(x + z, 3.3, 0.7);
    const variant = hashPos(x, 5.9, z) < 0.5 ? 0 : 1;
    const s = trees.s[i];
    const sx = s * (0.9 + r3 * 0.2), sy = s * (0.88 + r1 * 0.24), sz = s * (0.9 + r2 * 0.2);
    // sink the root flare into slopes so the downhill side doesn't float
    const h = terrain.heightAt(x, z);
    const slope = Math.hypot(terrain.heightAt(x + 1, z) - terrain.heightAt(x - 1, z), terrain.heightAt(x, z + 1) - terrain.heightAt(x, z - 1)) / 2;
    const y = h - Math.min(1.2, 0.1 + slope * 0.6 * s);
    const yaw = r2 * Math.PI * 2;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, yaw, 0);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    dummy.matrix.toArray(mats, i * 16);
    tint.setHex(spec.tints[Math.floor(r3 * 2.999)]).multiplyScalar(0.82 + r1 * 0.36);
    data[i * 4] = tint.r;
    data[i * 4 + 1] = tint.g;
    data[i * 4 + 2] = tint.b;
    data[i * 4 + 3] = sp + r2 * 0.999;
    const { C, R } = kits[sp][variant].crown;
    farPos.set([x, y, z, yaw], i * 4);
    farShape.set([C.y * sy, ((R.x + R.z) / 2) * 0.92 * (sx + sz) / 2, R.y * sy, (spec.trunk ? spec.trunk.r : spec.palm.r) * s], i * 4);
    meshOf[i] = (sp * 2 + variant) * 2;
    capacity[meshOf[i]]++;
    capacity[meshOf[i] + 1]++;
  }

  // Near & mid meshes
  const meshes = [];
  for (let sp = 0; sp < SPECIES.length; sp++) {
    for (let v = 0; v < 2; v++) {
      for (let l = 0; l < 2; l++) {
        const src = kits[sp][v].geometries[l];
        const geo = new THREE.BufferGeometry();
        for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.attributes[name]);
        geo.setIndex(src.index);
        geo.boundingSphere = src.boundingSphere;
        const cap = Math.max(1, capacity[meshes.length]);
        // Static usage on purpose (see createTreeField upstream): rebuild() uploads just the instances in use, and only
        // when the levels change
        geo.setAttribute('aTreeData', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
        const mesh = new THREE.InstancedMesh(geo, material, cap);
        // matrices in a storage buffer: small instanced meshes otherwise keep them in a uniform buffer that is
        // re-uploaded on every draw of every pass
        mesh.instanceMatrix = new THREE.StorageInstancedBufferAttribute(mesh.instanceMatrix.array, 16);
        mesh.name = `Trees_${SPECIES[sp].name}_v${v}_${l ? 'mid' : 'near'}`;
        // one degenerate (all-zero matrix) instance until the first pick, so the shaders compile behind the loading screen
        mesh.instanceMatrix.array.fill(0, 0, 16);
        mesh.count = 1;
        mesh.frustumCulled = false; // instances surround the camera: the levels do the culling
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        meshes.push(mesh);
      }
    }
  }

  // Far trees: every tree, one draw
  const farGeo = buildFarGeometry();
  farGeo.setAttribute('aFarPos', new THREE.InstancedBufferAttribute(farPos, 4));
  farGeo.setAttribute('aFarShape', new THREE.InstancedBufferAttribute(farShape, 4));
  farGeo.setAttribute('aTreeData', new THREE.InstancedBufferAttribute(data, 4));
  farGeo.instanceCount = N;
  const farMesh = new THREE.Mesh(farGeo, far.material);
  farMesh.name = 'Trees_far';
  farMesh.frustumCulled = false;
  farMesh.castShadow = true;
  farMesh.receiveShadow = true;
  farMesh.matrixAutoUpdate = false;
  group.add(farMesh);

  // Cells of trees (counting sort), so a pick only looks at the trees that can be in reach
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < N; i++) {
    minX = Math.min(minX, trees.x[i]); maxX = Math.max(maxX, trees.x[i]);
    minZ = Math.min(minZ, trees.z[i]); maxZ = Math.max(maxZ, trees.z[i]);
  }
  const gw = Math.floor((maxX - minX) / CELL) + 1, gh = Math.floor((maxZ - minZ) / CELL) + 1;
  const cellStart = new Uint32Array(gw * gh + 1);
  const cellOf = (i) => Math.floor((trees.z[i] - minZ) / CELL) * gw + Math.floor((trees.x[i] - minX) / CELL);
  for (let i = 0; i < N; i++) cellStart[cellOf(i) + 1]++;
  for (let c = 0; c < gw * gh; c++) cellStart[c + 1] += cellStart[c];
  const order = new Uint32Array(N);
  const fill = cellStart.slice(0, gw * gh);
  for (let i = 0; i < N; i++) order[fill[cellOf(i)]++] = i;

  const lod = new Uint8Array(N).fill(2); // 0 near, 1 mid, 2 far
  const seen = new Uint32Array(N);
  let active = new Uint32Array(N), next = new Uint32Array(N), activeCount = 0, stamp = 0;
  const counts = new Uint32Array(meshes.length);

  // Refill the near & mid meshes with the trees in reach
  function rebuild() {
    counts.fill(0);
    for (let a = 0; a < activeCount; a++) {
      const i = active[a];
      const m = meshOf[i] + lod[i];
      const c = counts[m]++;
      const mesh = meshes[m];
      const ma = mesh.instanceMatrix.array, da = mesh.geometry.attributes.aTreeData.array;
      for (let k = 0; k < 16; k++) ma[c * 16 + k] = mats[i * 16 + k];
      for (let k = 0; k < 4; k++) da[c * 4 + k] = data[i * 4 + k];
    }
    for (let m = 0; m < meshes.length; m++) {
      const mesh = meshes[m], n = counts[m];
      if (n > 0) {
        for (const attr of [mesh.instanceMatrix, mesh.geometry.attributes.aTreeData]) {
          attr.clearUpdateRanges();
          attr.addUpdateRange(0, n * attr.itemSize);
          attr.needsUpdate = true;
        }
      }
      mesh.count = n;
      mesh.visible = n > 0;
    }
  }

  const lastPick = new THREE.Vector3(Infinity, Infinity, Infinity);
  function pick(cam) {
    lastPick.copy(cam);
    far.uniforms.lodCenter.value.copy(cam);
    stamp++;
    let changed = false, count = 0;
    const i0 = Math.max(0, Math.floor((cam.x - LOD_MID - minX) / CELL)), i1 = Math.min(gw - 1, Math.floor((cam.x + LOD_MID - minX) / CELL));
    const j0 = Math.max(0, Math.floor((cam.z - LOD_MID - minZ) / CELL)), j1 = Math.min(gh - 1, Math.floor((cam.z + LOD_MID - minZ) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let ci = i0; ci <= i1; ci++) {
        const c = j * gw + ci;
        for (let o = cellStart[c]; o < cellStart[c + 1]; o++) {
          const i = order[o];
          // the same crown centre & distance as the far shader (float32 inputs from its buffers)
          const dx = farPos[i * 4] - cam.x, dy = farPos[i * 4 + 1] + farShape[i * 4] - cam.y, dz = farPos[i * 4 + 2] - cam.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          const cur = lod[i];
          let l = d >= LOD_MID ? 2 : d < LOD_NEAR ? 0 : 1;
          if (l < 2 && cur < 2 && l !== cur && Math.abs(d - LOD_NEAR) < LOD_HYSTERESIS) l = cur;
          if (l !== cur) { lod[i] = l; changed = true; }
          if (l < 2) { next[count++] = i; seen[i] = stamp; }
        }
      }
    }
    // trees that left the searched cells are beyond LOD_MID: far
    for (let a = 0; a < activeCount; a++) {
      const i = active[a];
      if (seen[i] !== stamp) { lod[i] = 2; changed = true; }
    }
    const t = active; active = next; next = t;
    activeCount = count;
    if (changed || stamp === 1) rebuild();
  }

  group.userData.update = (dt, elapsed, camera) => {
    const cam = camera.position;
    far.uniforms.view.value.copy(cam);
    if (cam.distanceToSquared(lastPick) >= REPICK * REPICK) pick(cam);
  };

  const triangles = kits.map((v) => v.map((k) => k.geometries.map((g) => g.userData.triangles)));
  group.userData.stats = { trees: N, triangles, meshes: meshes.length + 1 };
  return group;
}
