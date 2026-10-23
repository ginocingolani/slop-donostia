import * as THREE from 'three/webgpu';
import { float, vec3, mix, positionWorld, mx_noise_float, normalWorld, abs, smoothstep, fract } from 'three/tsl';

// js/donostia/landmarks/kit.js
// Shared helpers for the hand-modelled landmarks (js/donostia/landmarks/*.js): a few materials in the city's palette
// and small geometry utilities. Landmark modules may build their own materials too; keep this file stable.

function stoneMaterial(rgb, { roughness = 0.82, grain = 0.12, courses = 0 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const n = mx_noise_float(positionWorld.mul(0.9));
  const base = vec3(...rgb).mul(float(1).sub(grain).add(n.mul(grain)));
  if (courses > 0) {
    // ashlar courses: thin darker joints every `courses` metres on vertical faces
    const joint = smoothstep(0.0, 0.025, abs(fract(positionWorld.y.div(courses)).sub(0.5)).sub(0.47)).oneMinus();
    const vertical = smoothstep(0.6, 0.3, abs(normalWorld.y));
    mat.colorNode = mix(base, base.mul(0.62), joint.mul(vertical));
  } else {
    mat.colorNode = base;
  }
  mat.roughnessNode = float(roughness);
  return mat;
}

export const materials = {
  // Igeldo / Monte Ulía sandstone of the Área Romántica, whiter limestone, and the dark slate & zinc of the mansards
  sandstone: stoneMaterial([0.62, 0.52, 0.38], { courses: 0.55 }),
  limestone: stoneMaterial([0.78, 0.75, 0.68], { courses: 0.5 }),
  whiteRender: stoneMaterial([0.86, 0.85, 0.80], { grain: 0.06 }),
  slate: stoneMaterial([0.16, 0.17, 0.19], { roughness: 0.55, grain: 0.08 }),
  terracotta: stoneMaterial([0.52, 0.24, 0.15], { roughness: 0.8 }),
  rock: stoneMaterial([0.36, 0.33, 0.28], { roughness: 0.95, grain: 0.3 }),
  zinc: new THREE.MeshStandardNodeMaterial({ color: 0x6f767c, roughness: 0.42, metalness: 0.6 }),
  iron: new THREE.MeshStandardNodeMaterial({ color: 0x1d2126, roughness: 0.5, metalness: 0.75 }),
  whiteIron: new THREE.MeshStandardNodeMaterial({ color: 0xe9ece8, roughness: 0.45, metalness: 0.2 }),
  copper: new THREE.MeshStandardNodeMaterial({ color: 0x5f9c86, roughness: 0.55, metalness: 0.35 }), // verdigris
  bronze: new THREE.MeshStandardNodeMaterial({ color: 0x4a3a28, roughness: 0.45, metalness: 0.85 }),
  glass: new THREE.MeshStandardNodeMaterial({ color: 0x1c2a33, roughness: 0.08, metalness: 0.5 }),
  // the Kursaal's laminated glass prisms read as frosted, faintly green slabs by day and glow at night
  frostedGlass: new THREE.MeshStandardNodeMaterial({ color: 0xc9d6cf, roughness: 0.35, metalness: 0.05 }),
  lamp: new THREE.MeshStandardNodeMaterial({ color: 0xfff1d0, emissive: 0xffd9a0, emissiveIntensity: 2.0, roughness: 0.4 })
};

// Ground height under a point (the LiDAR DTM): ctx.terrain.heightAt(x, z)
export function groundAt(ctx, x, z) {
  return Math.max(0, ctx.terrain.heightAt(x, z));
}

// Lowest ground under a flat footprint ring [x0, z0, x1, z1, ...] (so walls never float on a slope)
export function lowestGround(ctx, ring) {
  let min = Infinity;
  for (let k = 0; k < ring.length; k += 2) min = Math.min(min, ctx.terrain.heightAt(ring[k], ring[k + 1]));
  return Number.isFinite(min) ? min : 0;
}

// Vertical prism of a footprint ring between y0 and y1 (walls + top cap), local-frame coordinates
export function prism(ring, y0, y1) {
  const shape = new THREE.Shape();
  // ExtrudeGeometry extrudes along +z of a shape in the xy plane; we map shape (x, -z) and rotate to stand upright
  for (let k = 0; k < ring.length; k += 2) {
    const x = ring[k], y = -ring[k + 1];
    if (k === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  const geo = new THREE.ExtrudeGeometry(shape, { depth: y1 - y0, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, y0, 0);
  return geo;
}

// Centre, principal direction and size of a footprint ring (oriented minimum-area box over the ring's edge directions)
export function orientedBox(ring) {
  let best = null;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[2 * j] - ring[2 * i], dz = ring[2 * j + 1] - ring[2 * i + 1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    const ux = dx / len, uz = dz / len;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (let k = 0; k < n; k++) {
      const px = ring[2 * k], pz = ring[2 * k + 1];
      const u = px * ux + pz * uz, v = -px * uz + pz * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (!best || area < best.area) {
      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      best = { area, angle: Math.atan2(uz, ux), length: maxU - minU, width: maxV - minV, x: cu * ux - cv * uz, z: cu * uz + cv * ux };
    }
  }
  // angle: direction of the long axis, measured from +x towards +z; for an Object3D use rotation.y = -angle
  if (best && best.width > best.length) {
    [best.length, best.width] = [best.width, best.length];
    best.angle += Math.PI / 2;
  }
  return best;
}
