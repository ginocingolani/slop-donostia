import * as THREE from 'three/webgpu';
import { STREETSCAPE } from './data-streetscape.js';
import { createLeafAtlas } from './trees-atlas.js';
import { SPECIES, buildTreeGeometries, buildFarGeometry, buildBillboardGeometry } from './trees-species.js';
import { createTreeMaterial, createFarTreeMaterial, createBillboardTreeMaterial } from './trees-material.js';

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
// - far: one draw for the trees beyond the mid level (a parametric crown & trunk shaped per instance in the shader).
//   Its instance buffers hold only the far trees in (a widened) view, refilled from the 64 m cells that meet the view
//   frustum whenever the camera has moved a few metres or turned past the margin, so the city's ~50,000 trees cost
//   what the few thousand on screen do. The shader still folds away the trees the near & mid meshes draw, measured
//   from the same point (uLodCenter) with the same distance, and shrinks them away towards FAR_END.
// - far shadows: the far trees within the sun's shadow range (lighting.js widens it with the camera's altitude; at
//   street level the mid level covers all of it) on a second instance list: a shadow-only stand-in on
//   SHADOW_ONLY_LAYER, which only the cascade cameras see (main.js), instead of every tree of the city drawn into
//   both cascades

const LOD_NEAR = 85; // m: full detail within
const LOD_MID = 300; // m: cards along the branches within; the far trees beyond
const LOD_HYSTERESIS = 6; // m, between near & mid only (the far shader can't see the history)
const FAR_END = 3400; // m: the far trees shrink away before this
const REPICK = 3; // m the camera moves before the levels are picked again
// m the camera moves before the far trees are refilled: the far lists hold every tree that can turn far meanwhile
// (from LOD_MID - RECULL out, the shader folding away those still mid), the shadow reach has SHADOW_MARGIN to spare
// and VIEW_MARGIN covers the frustum's shift (30 m sideways is under 6 degrees at the mid level's 300 m)
const RECULL = 30;
const CELL = 64; // m, cells searched for trees in reach
const BILLBOARD_START = 900; // m: beyond this a crown spans a few pixels and the far trees are billboards
const VIEW_MARGIN = THREE.MathUtils.degToRad(10); // the far trees are culled to a frustum this much wider on every side
const SHADOW_MARGIN = 30; // m beyond the shadow range whose far trees still cast

// Layer of the shadow-only stand-ins: main.js enables it on the sun's cascade cameras; the view camera never sees it
export const SHADOW_ONLY_LAYER = 3;

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

  // Near & mid meshes. Their trees live in one pair of storage buffers (matrices, data) with a slice per mesh
  // (instanceBase), read by createTreeMaterial's own instancing: one shader & pipeline per pass for all 24 meshes.
  // rebuild() uploads just the slices in use, and only when the levels change.
  const bases = new Uint32Array(capacity.length);
  let slots = 0;
  for (let m = 0; m < capacity.length; m++) { bases[m] = slots; slots += Math.max(1, capacity[m]); }
  const instances = {
    matrices: new THREE.StorageBufferAttribute(new Float32Array(slots * 16), 16),
    data: new THREE.StorageBufferAttribute(new Float32Array(slots * 4), 4)
  };
  const material = createTreeMaterial(atlas.texture, instances);
  const meshes = [];
  for (let sp = 0; sp < SPECIES.length; sp++) {
    for (let v = 0; v < 2; v++) {
      for (let l = 0; l < 2; l++) {
        const src = kits[sp][v].geometries[l];
        const geo = new THREE.InstancedBufferGeometry();
        for (const name of Object.keys(src.attributes)) geo.setAttribute(name, src.attributes[name]);
        geo.setIndex(src.index);
        geo.boundingSphere = src.boundingSphere;
        // one degenerate (all-zero matrix) instance until the first pick, so the shaders compile behind the loading screen
        geo.instanceCount = 1;
        const mesh = new THREE.Mesh(geo, material);
        mesh.userData.instanceBase = bases[meshes.length];
        mesh.name = `Trees_${SPECIES[sp].name}_v${v}_${l ? 'mid' : 'near'}`;
        mesh.frustumCulled = false; // instances surround the camera: the levels do the culling
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
        meshes.push(mesh);
      }
    }
  }

  // Far trees: one draw of the far trees in view, refilled by cull() below. The per-tree data stays in farPos,
  // farShape & data; the instance buffers get the trees to draw packed at their front.
  // (static usage on purpose: three's WebGPU backend re-uploads a DynamicDrawUsage attribute whole on every draw;
  // cull() uploads just the trees in use, and only when it refills)
  const farAttributes = (geo) => ['aFarPos', 'aFarShape', 'aTreeData'].map((name) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(N * 4), 4);
    geo.setAttribute(name, a);
    return a;
  });
  const farGeo = buildFarGeometry();
  const farInView = farAttributes(farGeo);
  farGeo.instanceCount = 1; // one degenerate (all-zero) tree until the first cull, so the pipelines compile
  const farMesh = new THREE.Mesh(farGeo, far.material);
  farMesh.name = 'Trees_far';
  farMesh.frustumCulled = false; // the instances are culled on the CPU
  farMesh.castShadow = false; // the stand-in below casts
  farMesh.receiveShadow = true;
  farMesh.matrixAutoUpdate = false;
  group.add(farMesh);
  // the far trees beyond BILLBOARD_START in view: one camera-facing quad each
  const billboardGeo = buildBillboardGeometry();
  const billboardsInView = farAttributes(billboardGeo);
  billboardGeo.instanceCount = 1;
  const billboardMesh = new THREE.Mesh(billboardGeo, createBillboardTreeMaterial(atlas.texture, SPECIES.map((sp) => sp.far), far.uniforms));
  billboardMesh.name = 'Trees_billboard';
  billboardMesh.frustumCulled = false;
  billboardMesh.castShadow = false;
  billboardMesh.receiveShadow = true;
  billboardMesh.matrixAutoUpdate = false;
  group.add(billboardMesh);
  // the far trees within shadow range, seen only by the sun's cascade cameras
  const shadowGeo = new THREE.InstancedBufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'aFarPart']) shadowGeo.setAttribute(name, farGeo.attributes[name]);
  shadowGeo.setIndex(farGeo.index);
  const farInShadow = farAttributes(shadowGeo);
  shadowGeo.instanceCount = 1;
  const shadowMesh = new THREE.Mesh(shadowGeo, far.material);
  shadowMesh.name = 'Trees_far_shadow';
  shadowMesh.layers.set(SHADOW_ONLY_LAYER);
  shadowMesh.frustumCulled = false;
  shadowMesh.castShadow = true;
  shadowMesh.receiveShadow = false;
  shadowMesh.matrixAutoUpdate = false;
  group.add(shadowMesh);

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

  // Bounds of every cell's trees, crowns included, for the frustum test: min x, y, z, max x, y, z
  const cellBox = new Float32Array(gw * gh * 6);
  for (let c = 0; c < gw * gh; c++) cellBox.set([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity], c * 6);
  for (let i = 0; i < N; i++) {
    const b = cellOf(i) * 6, r = farShape[i * 4 + 1];
    const x = farPos[i * 4], y0 = farPos[i * 4 + 1], z = farPos[i * 4 + 2], y1 = y0 + farShape[i * 4] + farShape[i * 4 + 2];
    cellBox[b] = Math.min(cellBox[b], x - r);
    cellBox[b + 1] = Math.min(cellBox[b + 1], y0);
    cellBox[b + 2] = Math.min(cellBox[b + 2], z - r);
    cellBox[b + 3] = Math.max(cellBox[b + 3], x + r);
    cellBox[b + 4] = Math.max(cellBox[b + 4], y1);
    cellBox[b + 5] = Math.max(cellBox[b + 5], z + r);
  }

  const lod = new Uint8Array(N).fill(2); // 0 near, 1 mid, 2 far
  const seen = new Uint32Array(N);
  let active = new Uint32Array(N), next = new Uint32Array(N), activeCount = 0, stamp = 0;
  const counts = new Uint32Array(meshes.length);

  // Refill the near & mid meshes with the trees in reach
  function rebuild() {
    counts.fill(0);
    const ma = instances.matrices.array, da = instances.data.array;
    for (let a = 0; a < activeCount; a++) {
      const i = active[a];
      const m = meshOf[i] + lod[i];
      const slot = bases[m] + counts[m]++;
      for (let k = 0; k < 16; k++) ma[slot * 16 + k] = mats[i * 16 + k];
      for (let k = 0; k < 4; k++) da[slot * 4 + k] = data[i * 4 + k];
    }
    for (const attr of [instances.matrices, instances.data]) attr.clearUpdateRanges();
    let any = false;
    for (let m = 0; m < meshes.length; m++) {
      const mesh = meshes[m], n = counts[m];
      if (n > 0) {
        for (const attr of [instances.matrices, instances.data]) attr.addUpdateRange(bases[m] * attr.itemSize, n * attr.itemSize);
        any = true;
      }
      mesh.geometry.instanceCount = n;
      // (the first mesh stays in the scene with or without trees: its pipeline, which all of them share, compiles
      // behind the loading screen wherever the camera starts)
      mesh.visible = n > 0 || m === 0;
    }
    // With no tree near or mid there is nothing to upload (no mesh draws an instance), and an update without ranges
    // would make three's WebGPU backend write both whole buffers (~8 MB)
    if (any) instances.matrices.needsUpdate = instances.data.needsUpdate = true;
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

  // The far trees in view and those in shadow range, packed at the front of their instance buffers
  const cullCamera = new THREE.PerspectiveCamera();
  const frustum = new THREE.Frustum(), bounds = new THREE.Box3(), projScreen = new THREE.Matrix4();
  // (quat: the whole orientation, roll included; turn: how far it may turn from there, see cull)
  const lastCull = { pos: new THREE.Vector3(Infinity, 0, 0), quat: new THREE.Quaternion(), turn: 0, fov: 0, aspect: 0, reach: -1 };
  let billboardStart = BILLBOARD_START;
  // (a quality knob: the distance where far trees turn into billboards; Infinity keeps the cards; refills next frame)
  group.userData.setBillboardStart = (d) => { billboardStart = d; lastCull.reach = -Infinity; };
  const pack = ([p, s, d], n, i) => {
    for (let k = 0; k < 4; k++) {
      p.array[n * 4 + k] = farPos[i * 4 + k];
      s.array[n * 4 + k] = farShape[i * 4 + k];
      d.array[n * 4 + k] = data[i * 4 + k];
    }
  };
  // (both meshes stay visible: with no instances three skips the draw but keeps the pipeline, so the precompile & the
  // warm-up frame always reach it)
  const upload = (attrs, geo, n) => {
    geo.instanceCount = n;
    if (!n) return;
    for (const a of attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * 4);
      a.needsUpdate = true;
    }
  };
  function cull(camera, reach) {
    const cam = camera.position;
    lastCull.pos.copy(cam);
    lastCull.quat.copy(camera.quaternion);
    lastCull.fov = camera.fov;
    lastCull.aspect = camera.aspect;
    lastCull.reach = reach;
    // the view frustum widened by VIEW_MARGIN on every side and reaching FAR_END, so a small turn needs no refill
    const halfV = THREE.MathUtils.degToRad(camera.fov / 2), halfH = Math.atan(Math.tan(halfV) * camera.aspect);
    const wideV = Math.min(halfV + VIEW_MARGIN, 1.5), wideH = Math.min(halfH + VIEW_MARGIN, 1.5);
    // How far the view can then turn, about any axis, before a ray of it leaves the widened frustum: a rotation by an
    // angle moves no ray further than that angle, and the rays nearest a widened side are the view's corners,
    // asin(sin(margin) * cos(the corner's angle off the side's mid-line)) from it (7.7 degrees for 55 degrees at 16:9)
    const tanV = Math.tan(halfV), tanH = Math.tan(halfH), corner = Math.hypot(1, tanV, tanH);
    lastCull.turn = Math.min(Math.asin(Math.sin(wideV - halfV) * Math.hypot(1, tanV) / corner),
      Math.asin(Math.sin(wideH - halfH) * Math.hypot(1, tanH) / corner));
    cullCamera.fov = THREE.MathUtils.radToDeg(2 * wideV);
    cullCamera.aspect = Math.tan(wideH) / Math.tan(wideV);
    cullCamera.near = 0.5;
    cullCamera.far = FAR_END;
    cullCamera.updateProjectionMatrix();
    cullCamera.position.copy(cam);
    cullCamera.quaternion.copy(camera.quaternion);
    cullCamera.updateMatrixWorld();
    frustum.setFromProjectionMatrix(projScreen.multiplyMatrices(cullCamera.projectionMatrix, cullCamera.matrixWorldInverse));
    const farEnd2 = FAR_END * FAR_END, shadow2 = (reach + SHADOW_MARGIN) ** 2, billboard2 = billboardStart * billboardStart;
    const farStart2 = Math.max(0, LOD_MID - RECULL) ** 2;
    let nView = 0, nShadow = 0, nBillboard = 0;
    for (let c = 0; c < gw * gh; c++) {
      if (cellStart[c] === cellStart[c + 1]) continue;
      bounds.min.fromArray(cellBox, c * 6);
      bounds.max.fromArray(cellBox, c * 6 + 3);
      const near2 = bounds.distanceToPoint(cam) ** 2;
      const inShadow = near2 < shadow2;
      const inView = near2 < farEnd2 && frustum.intersectsBox(bounds);
      if (!inView && !inShadow) continue;
      for (let o = cellStart[c]; o < cellStart[c + 1]; o++) {
        const i = order[o];
        // the far shader's crown-centre distance
        const dx = farPos[i * 4] - cam.x, dy = farPos[i * 4 + 1] + farShape[i * 4] - cam.y, dz = farPos[i * 4 + 2] - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        // the trees that can turn far before the next refill (the shader folds them away while they are mid)
        if (d2 < farStart2) continue;
        if (inView && d2 < farEnd2) {
          if (d2 < billboard2) pack(farInView, nView++, i);
          else pack(billboardsInView, nBillboard++, i);
        }
        if (inShadow && d2 < shadow2) pack(farInShadow, nShadow++, i);
      }
    }
    upload(farInView, farGeo, nView);
    upload(billboardsInView, billboardGeo, nBillboard);
    upload(farInShadow, shadowGeo, nShadow);
  }

  // the sun's shadow range (main.js points it at lighting.js); without one, no far tree casts
  group.userData.shadowReach = () => LOD_MID - SHADOW_MARGIN;
  group.userData.update = (dt, elapsed, camera) => {
    const cam = camera.position;
    far.uniforms.view.value.copy(cam);
    if (cam.distanceToSquared(lastPick) >= REPICK * REPICK) pick(cam);
    const reach = group.userData.shadowReach();
    // Refill before the view can turn out of the widened frustum. The whole rotation since the last refill counts, not
    // just the view direction's: yawing while looking steeply down is mostly a roll about the view axis, which swings
    // the frustum's sides & corners round while the direction barely moves.
    if (cam.distanceToSquared(lastCull.pos) >= RECULL * RECULL || camera.quaternion.angleTo(lastCull.quat) > lastCull.turn ||
      camera.fov !== lastCull.fov || camera.aspect !== lastCull.aspect || Math.abs(reach - lastCull.reach) > 10) cull(camera, reach);
  };

  const triangles = kits.map((v) => v.map((k) => k.geometries.map((g) => g.userData.triangles)));
  group.userData.stats = { trees: N, triangles, meshes: meshes.length + 3 };
  group.userData.farCounts = () => ({ view: farGeo.instanceCount, billboards: billboardGeo.instanceCount, shadow: shadowGeo.instanceCount });
  return group;
}
