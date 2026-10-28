import * as THREE from 'three/webgpu';
import { float, vec3, vec4, attribute, uniform, abs, smoothstep, mrt } from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { FERRY } from './data-boats.js';
import { Builder, addHull, V, P, HULL, DECK, GLASS, STEEL, DARK, LIGHT, SLOTS, createBoatMaterial, srgb } from './boats.js';
import { ferryRounds, SERVICE } from './ferry-timeline.js';

// js/donostia/ferries.js
// The two island ferries, the Motoras de la Isla, shuttling between the north basin's ferry pier and Santa Klara's jetty
// on js/donostia/ferry-timeline.js's rounds (the lanes tools/donostia/bake-boats.mjs baked from OSM's route=ferry) while
// the time of day is within the service's hours, and moored at their berths otherwise. The model follows the photos of
// Aitona Julian III (Wikimedia Commons, "Ferry Santa Klara (2026-08-10)", Sneeuwvlakte, CC BY-SA 4.0; looked at, not
// copied): a 15 m launch, blue to its bulwarks under a white capping, a full bow with white wings on it, an open
// passenger deck of benches under a white roof on posts with solar panels & life-raft canisters on it, the wheelhouse
// forward under the roof's front edge, steel rails round the bow. Scaled per ferry to its measured length & beam.
// Built on boats.js's builder & material (its paints, sheer stripe, heave & roll on the sea's level): one instanced mesh
// of two, its poses written on the CPU each frame; under way, a wake of foam behind each (one more mesh for both).
// buildFerries(seaLevel, clock) -> Object3D | null. clock() gives the time of day (h) the lighting shows (main.js: the
// preset's); userData.update(dt, elapsed, camera) moves the ferries; userData.offset (s) shifts their rounds, and
// userData.time (s), when a number, holds them at that moment of their rounds (to look at a ferry under way:
// slopDebug.world.modules.ferries.userData.time = 300).

const FAR = 2600; // m: nothing beyond

// --- the model ---------------------------------------------------------------------------------------------------------

const SPEC = { L: 15, B: 5.4, k: 0.5 }; // as boats.js's SPECS: the model's length & beam, and its height's exponent
const FERRY_HULL = { L: 15, B: 5.4, transom: 0.94, widest: 0.5, entry: 2.4, sheer: [0.95, 1.0, 1.35], keel: 0.85, stations: 12,
  section: [[0, 0], [0.62, 0.12], [0.92, 0.35], [1, 1]] };
const BENCH = P(0xe9e9e5, 0.6);
const SOLAR = P(0x1b2636, 0.18);
const ROOF = 2.3; // m above the deck

function ferryBody() {
  const b = new Builder();
  const shape = addHull(b, FERRY_HULL);
  const { halfBeam, sheer, keel, z } = shape;
  // the bulwarks, blue outside (the sheer stripe, white, along their top) & white inside under a white capping, higher
  // towards the bow; and across the stern
  const bulwark = (t) => 0.95 + 0.3 * t * t;
  const n = 14, inset = 0.09, up = V(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    for (const s of [1, -1]) {
      const o0 = V(s * halfBeam(t0), sheer(t0), z(t0)), o1 = V(s * halfBeam(t1), sheer(t1), z(t1));
      const u0 = V(o0.x, o0.y + bulwark(t0), o0.z), u1 = V(o1.x, o1.y + bulwark(t1), o1.z);
      const i0 = V(s * Math.max(0, halfBeam(t0) - inset), u0.y, o0.z), i1 = V(s * Math.max(0, halfBeam(t1) - inset), u1.y, o1.z);
      const j0 = V(i0.x, o0.y, o0.z), j1 = V(i1.x, o1.y, o1.z);
      const out = V(s, 0, 0), inn = V(-s, 0, 0);
      b.tri(o0, o1, u1, out, out, out, HULL, [bulwark(t0), bulwark(t1), 0]);
      b.tri(o0, u1, u0, out, out, out, HULL, [bulwark(t0), 0, 0]);
      b.tri(j0, i1, j1, inn, inn, inn, DECK);
      b.tri(j0, i0, i1, inn, inn, inn, DECK);
      b.tri(u0, u1, i1, up, up, up, DECK);
      b.tri(u0, i1, i0, up, up, up, DECK);
    }
  }
  const hs = halfBeam(0), ys = sheer(0), zs = z(0);
  b.box(0, ys, zs + inset / 2, hs * 2, bulwark(0), inset, HULL);
  b.box(0, ys + bulwark(0), zs + inset / 2, hs * 2, 0.04, inset + 0.02, DECK);
  // the white wings on the bow, either side, on the hull's flare (its half-width at that height, from its sections)
  const across = (t, y) => {
    const v = (y - keel(t)) / (sheer(t) - keel(t)), sec = FERRY_HULL.section;
    let k = 1;
    while (k < sec.length - 1 && sec[k][1] < v) k++;
    const [ua, va] = sec[k - 1], [ub, vb] = sec[k];
    return (ua + ((ub - ua) * (v - va)) / (vb - va)) * halfBeam(t) + 0.02;
  };
  for (const s of [1, -1]) {
    for (const [y, t0, t1] of [[0.62, 0.8, 0.92], [0.8, 0.78, 0.91], [0.98, 0.76, 0.9]]) {
      b.bar(V(s * across(t0, y), y, z(t0)), V(s * across(t1, y + 0.08), y + 0.08, z(t1)), 0.07, DECK);
    }
  }
  const deck = sheer(0.5), yr = deck + ROOF, w = halfBeam(0.5) - 0.2;
  // the wheelhouse under the roof's front edge: white, its windows all round
  const zw0 = z(0.66), zw1 = z(0.79), ww = 1.15;
  b.frustum(deck, ww, zw0, zw1, deck + 1.05, ww, zw0, zw1, DECK, { top: false });
  b.frustum(deck + 1.05, ww, zw0, zw1, deck + 1.85, ww, zw0, zw1 - 0.08, GLASS, { top: false });
  b.frustum(deck + 1.85, ww, zw0, zw1 - 0.08, yr, ww, zw0, zw1 - 0.08, DECK, { top: false });
  // the roof over the deck aft of it, on posts down both sides; its front corners on curved arms from the bulwarks
  const zr0 = z(0.05), zr1 = z(0.79);
  b.box(0, yr, (zr0 + zr1) / 2, w * 2, 0.12, zr1 - zr0, DECK, { bottom: true });
  for (const s of [1, -1]) {
    for (const t of [0.07, 0.27, 0.47]) b.bar(V(s * (w - 0.06), sheer(t) + 0.2, z(t)), V(s * (w - 0.06), yr, z(t)), 0.09, DECK);
    const t = 0.84, foot = V(s * (halfBeam(t) - 0.12), sheer(t) + bulwark(t), z(t)), knee = V(s * (w - 0.1), yr - 0.7, zr1 + 0.25);
    b.bar(foot, knee, 0.12, DECK);
    b.bar(knee, V(s * (w - 0.06), yr, zr1 - 0.05), 0.12, DECK);
    // rails along the roof's edge
    b.bar(V(s * (w - 0.05), yr + 0.5, zr0 + 0.2), V(s * (w - 0.05), yr + 0.5, zr1 - 0.3), 0.04, STEEL);
    // rails round the bow, on the bulwarks
    b.bar(V(s * (halfBeam(0.84) - 0.05), sheer(0.84) + bulwark(0.84) + 0.35, z(0.84)), V(s * 0.2, sheer(0.99) + bulwark(0.99) + 0.35, z(0.985)), 0.04, STEEL);
    // the life-raft canisters on the roof's front corners, a fender or two
    b.box(s * (w - 0.55), yr + 0.06, zr1 - 0.7, 0.62, 0.55, 1.0, DECK);
    for (const t of [0.25, 0.6]) b.box(s * (halfBeam(t) + 0.12), sheer(t) - 0.55, z(t), 0.22, 0.6, 0.22, DECK);
  }
  b.bar(V(-(w - 0.05), yr + 0.5, zr0 + 0.2), V(w - 0.05, yr + 0.5, zr0 + 0.2), 0.04, STEEL);
  // the solar panels in two rows down the roof, a mast with the radar & the masthead light
  for (let k = 0; k < 5; k++) {
    const z0 = zr0 + 1.3 + k * 1.75;
    for (const s of [1, -1]) {
      const x0 = s * 0.15, x1 = s * (w - 1.35), y = yr + 0.13;
      b.quad(V(x0, y, z0), V(x0, y, z0 + 1.55), V(x1, y, z0 + 1.55), V(x1, y, z0), SOLAR);
    }
  }
  b.bar(V(0, yr + 0.06, zr1 - 1.6), V(0, yr + 1.7, zr1 - 1.6), 0.08, STEEL);
  b.box(0, yr + 0.9, zr1 - 1.6, 0.55, 0.22, 0.55, DECK);
  b.box(0, yr + 1.7, zr1 - 1.6, 0.14, 0.14, 0.14, LIGHT);
  // the benches across the deck either side of an aisle, backs to the stern
  for (let t = 0.1; t < 0.6; t += 0.065) {
    for (const s of [1, -1]) {
      const x0 = s * 0.45, x1 = s * (halfBeam(t) - inset - 0.1), zc = z(t);
      b.box((x0 + x1) / 2, deck, zc, Math.abs(x1 - x0), 0.45, 0.42, BENCH);
      b.box((x0 + x1) / 2, deck + 0.45, zc - 0.19, Math.abs(x1 - x0), 0.4, 0.06, BENCH);
    }
  }
  // the engine room's hatch aft, a dark stern ladder
  b.box(0, deck, z(0.03) + 0.6, 1.4, 0.12, 1.0, DARK);
  return b.build();
}

// --- the wakes ---------------------------------------------------------------------------------------------------------

// Behind a ferry under way, a ribbon on the water from its stern: where the stern was, a sample every WAKE.step metres
// it went (WAKE.samples of them, kept WAKE.life seconds), as wide as the hull at the stern and spreading as a Kelvin
// wake's arms do (19.5° either side: 0.35 m a metre behind). Two things show on it: the churned water straight behind,
// a pale band little wider than the hull that dies out over WAKE.wash metres, and the two arms, thin lines of foam
// along its edges that last WAKE.arms metres; both fade with age and with how slowly the ferry went (full at
// WAKE.full m/s, as its square). One mesh for both ferries, rebuilt on the CPU each frame.
const WAKE = { samples: 40, step: 2.5, life: 40, lift: 0.06, wash: 45, arms: 110, full: 4 };

function createWakeMaterial() {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide });
  // aWake: across the ribbon (-1..1), the arms' opacity, the wash's, the wash's half-width as a share of the ribbon's
  const w = attribute('aWake', 'vec4'), across = abs(w.x);
  const wash = w.z.mul(float(1).sub(smoothstep(w.w.mul(0.55), w.w, across)));
  const arms = w.y.mul(smoothstep(0.9, 0.965, across)).mul(float(1).sub(smoothstep(0.975, 1.0, across)));
  mat.colorNode = vec3(0.92, 0.95, 0.95).mul(float(1).sub(smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow).mul(0.8)));
  mat.opacityNode = wash.max(arms);
  // (as streetscape.js's pools of lamplight: the water's normal & glossiness under the foam go, so it reflects no sky)
  mat.mrtNode = mrt({ normal: vec4(0.0), metalRough: vec4(0.0) });
  return mat;
}

function createWakes(rounds, seaLevel) {
  const S = WAKE.samples + 1, n = rounds.length;
  const pos = new Float32Array(n * S * 2 * 3), attr = new Float32Array(n * S * 2 * 4), index = [];
  for (let k = 0; k < n; k++) {
    for (let i = 0; i + 1 < S; i++) {
      const a = (k * S + i) * 2;
      index.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geo.setAttribute('aWake', new THREE.BufferAttribute(attr, 4).setUsage(THREE.DynamicDrawUsage));
  geo.setIndex(index);
  geo.boundingSphere = new THREE.Sphere();
  const mesh = new THREE.Mesh(geo, createWakeMaterial());
  mesh.name = 'FerryWakes';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  // per ferry, its stern's track: [x, z, time, speed] newest first
  const tracks = rounds.map(() => []);
  const stern = (r, p) => {
    const h = (p.heading * Math.PI) / 180;
    return [p.x - Math.sin(h) * r.length * 0.45, p.z - Math.cos(h) * r.length * 0.45];
  };
  // poses: the ferries' now; poseAt(k, t): ferry k's at another time (the rounds), to lay the track it left afresh
  const update = (poses, now, poseAt) => {
    const y = (seaLevel?.value ?? 0) + WAKE.lift;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    poses.forEach((p, k) => {
      const r = rounds[k], h = (p.heading * Math.PI) / 180, fx = Math.sin(h), fz = Math.cos(h);
      const [sx, sz] = stern(r, p), track = tracks[k];
      // at first, or after a jump (the time of day changed, the rounds were shifted), the track it left till now
      if (!track.length || Math.hypot(sx - track[0][0], sz - track[0][1]) > 30) {
        track.length = 0;
        for (let back = 0; back <= WAKE.life && track.length < WAKE.samples; back += 0.5) {
          const q = poseAt(k, now - back), [x, z] = stern(r, q), last = track[track.length - 1];
          if (!last || Math.hypot(x - last[0], z - last[1]) >= WAKE.step) track.push([x, z, now - back, Math.abs(q.speed)]);
        }
      }
      if (Math.hypot(sx - track[0][0], sz - track[0][1]) >= WAKE.step) {
        track.unshift([sx, sz, now, Math.abs(p.speed)]);
        if (track.length > WAKE.samples) track.length = WAKE.samples;
      }
      // the ribbon: the stern now, then the track (the last sample repeated, unseen, to the end); d: metres behind
      const ribbon = [[sx, sz, now, Math.abs(p.speed)], ...track], last = ribbon.length - 1;
      let d = 0;
      for (let i = 0; i < S; i++) {
        const q = ribbon[Math.min(i, last)];
        if (i > 0 && i <= last) d += Math.hypot(q[0] - ribbon[i - 1][0], q[1] - ribbon[i - 1][1]);
        // across the track, from the samples before & after (the ferry's middle before the stern)
        const a = i === 0 ? [p.x, p.z] : ribbon[Math.min(i - 1, last)], b = ribbon[Math.min(i + 1, last)];
        let nx = -(a[1] - b[1]), nz = a[0] - b[0];
        const l = Math.hypot(nx, nz);
        if (l > 1e-6) { nx /= l; nz /= l; } else { nx = fz; nz = -fx; }
        const half = r.beam * 0.45 + 0.35 * d, age = now - q[2];
        const fade = i > last ? 0 : Math.max(0, 1 - age / WAKE.life) ** 2 * Math.min(1, q[3] / WAKE.full) ** 2;
        const arms = 0.32 * fade * Math.exp(-d / WAKE.arms), wash = 0.55 * fade * Math.exp(-d / WAKE.wash);
        const share = Math.min(1, (r.beam * 0.4 + 0.04 * d) / half);
        const v = (k * S + i) * 2;
        pos.set([q[0] + nx * half, y, q[1] + nz * half, q[0] - nx * half, y, q[1] - nz * half], v * 3);
        attr.set([1, arms, wash, share, -1, arms, wash, share], v * 4);
        minX = Math.min(minX, q[0] - half); maxX = Math.max(maxX, q[0] + half);
        minZ = Math.min(minZ, q[1] - half); maxZ = Math.max(maxZ, q[1] + half);
      }
    });
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aWake.needsUpdate = true;
    geo.boundingSphere.center.set((minX + maxX) / 2, y, (minZ + maxZ) / 2);
    geo.boundingSphere.radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 1;
  };
  return { mesh, update };
}

// --- build -------------------------------------------------------------------------------------------------------------

/**
 * The island ferries. seaLevel: water.js's level uniform (the tide); clock() -> the hour the lighting shows.
 */
export function buildFerries(seaLevel = null, clock = () => 12) {
  try {
    const rounds = ferryRounds();
    if (!rounds.length) return null;
    const N = rounds.length;
    const instances = new THREE.StorageBufferAttribute(new Float32Array(N * SLOTS * 4), 4);
    const [hull, deck, accent] = FERRY.paint.map(srgb);
    rounds.forEach((r, k) => {
      // as boats.js: [pose], [scale across, up, along, phase], [hull, roll], [deck, options], [accent, stripe]
      instances.array.set([0, 0, 0, 1, r.beam / SPEC.B, Math.pow(r.length / SPEC.L, SPEC.k), r.length / SPEC.L, 1.3 + k * 2.1,
        ...hull, 0.006, ...deck, 0, ...accent, 0.06], k * SLOTS * 4);
    });
    const material = createBoatMaterial(instances, seaLevel || uniform(0));
    const body = ferryBody();
    const geo = new THREE.InstancedBufferGeometry();
    for (const name of Object.keys(body.attributes)) geo.setAttribute(name, body.attributes[name]);
    geo.instanceCount = N;
    geo.boundingSphere = new THREE.Sphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.name = 'Ferries';
    mesh.userData.instanceBase = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    const wakes = createWakes(rounds, seaLevel);
    const group = new THREE.Group();
    group.name = 'DonostiaFerries';
    group.add(mesh, wakes.mesh);
    group.userData.offset = 0;
    group.userData.time = null;

    // Each frame: the ferries' poses (under way within the service's hours, else at their berths) into the storage
    // buffer, the bounding sphere round both, their wakes
    const poses = rounds.map((r) => r.berth), sphere = geo.boundingSphere;
    group.userData.update = (dt, elapsed, camera) => {
      const hour = clock(), sailing = hour >= SERVICE.from && hour < SERVICE.to;
      const now = typeof group.userData.time === 'number' ? group.userData.time : elapsed + group.userData.offset;
      const poseAt = (k, t) => (sailing ? rounds[k].pose(t) : rounds[k].berth);
      const a = instances.array;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      rounds.forEach((r, k) => {
        const p = poseAt(k, now), h = (p.heading * Math.PI) / 180;
        poses[k] = p;
        a.set([p.x, p.z, Math.sin(h), Math.cos(h)], k * SLOTS * 4);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
      });
      instances.needsUpdate = true;
      sphere.center.set((minX + maxX) / 2, 3, (minZ + maxZ) / 2);
      sphere.radius = Math.hypot(maxX - minX, maxZ - minZ) / 2 + 12;
      mesh.visible = camera.position.distanceTo(sphere.center) - sphere.radius < FAR;
      wakes.update(poses, now, poseAt);
      wakes.mesh.visible = mesh.visible && sailing;
    };
    group.userData.stats = () => ({ ferries: N, triangles: body.attributes.position.count / 3, poses: poses.map((p) => ({ ...p })) });
    return group;
  } catch (e) {
    // the city stands without its ferries rather than not at all (main.js skips a null module)
    console.warn('[ferries]', e);
    return null;
  }
}
