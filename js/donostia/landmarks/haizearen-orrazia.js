import * as THREE from 'three/webgpu';
import { Fn, float, vec3, mix, smoothstep, positionWorld, mx_noise_float } from 'three/tsl';
import { PartBin, WORLD, westMaterials as M, rgb, sweep } from './igeldo.js';

// js/donostia/landmarks/haizearen-orrazia.js
// Haizearen orrazia / Peine del Viento (Eduardo Chillida & Luis Peña Ganchegui, 1976-77) at the western end of
// Ondarreta: a granite plaza stepping down to the sea, with holes through which the waves blow air and spray, and three
// steel sculptures of 10 t each gripping the rocks (es.wikipedia "Peine del Viento"). Chillida's work is still in
// copyright, so the sculptures here are deliberately generic: three rusted, claw-like clusters of square bars, one on
// the rock at the end of the walk and two on the reefs beyond, not a replica of the pieces.
//
// build(sites, ctx) receives the GEO.landmarks entries ['haizearen-orrazia'] (an OSM node on the plaza) and
// ctx = { GEO, terrain, kit }.

const GRANITE = rgb(0x8f8a84), HOLE = rgb(0x0b0c0d);

// Weathering steel: mottled orange-brown rust, darker runs down the faces
function createRustMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  mat.colorNode = Fn(() => {
    const p = positionWorld;
    const mottle = mx_noise_float(p.mul(1.6)).mul(0.5).add(0.5);
    const base = mix(vec3(0.20, 0.065, 0.025), vec3(0.42, 0.16, 0.06), mottle);
    const runs = smoothstep(0.25, 0.75, mx_noise_float(vec3(p.x.mul(7.0), p.y.mul(0.7), p.z.mul(7.0))));
    return base.mul(float(0.9).add(mx_noise_float(p.mul(11.0)).mul(0.1))).mul(float(1.0).sub(runs.mul(0.35)));
  })();
  mat.roughnessNode = float(0.8);
  mat.metalnessNode = float(0.25);
  return mat;
}

// A cluster of square bars rising from a block set in the rock: they leave it fanned out along `dir`, sweep up and
// curl back over at the tips, closing in on each other like a hand gripping
function claw(at, y, dir, size, seed, bin, rust) {
  const [dx, dz] = dir;
  const heading = Math.atan2(dz, dx);
  const block = new THREE.BoxGeometry(1.2 * size, 1.1 * size, 1.2 * size);
  block.rotateY(-heading);
  block.translate(at[0], y + 0.25 * size, at[1]);
  bin.add(rust, block);
  const fan = [-0.75, -0.25, 0.25, 0.75];
  fan.forEach((spread, k) => {
    const a = heading + spread + 0.1 * Math.sin(seed * 2.7 + k);
    const ox = Math.cos(a), oz = Math.sin(a);
    const R = (1.15 + 0.3 * Math.sin(seed * 1.9 + k * 2.1)) * size;
    const sweepTo = 2.0 + 0.35 * Math.cos(seed * 3.3 + k * 1.3); // past the vertical: the tip hooks back
    const path = [];
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const phi = (i / steps) * sweepTo;
      const out = R * Math.sin(phi), up = R * (1 - Math.cos(phi));
      // the tips close in towards the middle of the fan
      const pull = -spread * 0.45 * R * (1 - Math.cos(phi * 0.5));
      const px = at[0] + ox * (0.35 * size + out) - oz * pull, pz = at[1] + oz * (0.35 * size + out) + ox * pull;
      path.push(px, y + 0.3 * size + up, pz);
    }
    const h = 0.16 * size;
    bin.add(rust, sweep(path, () => [-h, -h, h, -h, h, h, -h, h], { caps: true }));
  });
}

// Lumps of rock, so the reefs the outer pieces stand on break the water
function reef(x, z, top, bin, rock, seed) {
  for (let k = 0; k < 3; k++) {
    const g = new THREE.IcosahedronGeometry(1, 0);
    const a = seed * 2.1 + k * 2.4;
    g.scale(2.2 - k * 0.4, 1.0 + top * 0.5, 1.7 - k * 0.2);
    g.rotateY(a);
    g.translate(x + Math.cos(a) * k * 0.9, top - 1.0 - k * 0.25, z + Math.sin(a) * k * 0.9);
    bin.add(rock, g);
  }
}

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.at) return null;
  const { kit, terrain } = ctx;
  const [x0, z0] = site.at;
  const plaza = kit.groundAt(ctx, x0, z0);
  const bin = new PartBin();
  const rust = createRustMaterial();

  // The pieces, placed from the LiDAR around the plaza's end (the OSM node): the first on the rock knob just west of
  // the walk's end (about 9 m high), the other two on the low reefs 15-25 m out to the north. Each reaches towards
  // the others.
  const pieces = [
    { at: [x0 - 11.0, z0 - 9.5], face: [x0 - 2, z0 - 22], size: 1.0, onRock: true },
    { at: [x0 - 3.0, z0 - 18.0], face: [x0 - 10, z0 - 9], size: 0.95 },
    { at: [x0 + 2.5, z0 - 25.5], face: [x0 - 6, z0 - 14], size: 0.9 }
  ];
  pieces.forEach((p, k) => {
    const [px, pz] = p.at;
    let y = terrain.heightAt(px, pz);
    if (!p.onRock || y < 1.5) {
      // a reef awash at high tide: rock to ~1.6 m above mean sea level
      const top = Math.max(1.6, y + 0.3);
      reef(px, pz, top, bin, kit.materials.rock, k + 1);
      y = top - 0.2;
    } else {
      y -= 0.3;
    }
    const dx = p.face[0] - px, dz = p.face[1] - pz, l = Math.hypot(dx, dz) || 1;
    claw(p.at, y, [dx / l, dz / l], p.size, k + 1, bin, rust);
  });

  // the blowholes: granite-rimmed holes in a gentle arc across the plaza near its seaward edge
  let holes = 0;
  for (let k = 0; k < 24 && holes < 7; k++) {
    const a = -2.35 + k * 0.14;
    const hx = x0 + 3.0 + Math.cos(a) * 7.5, hz = z0 + 1.5 + Math.sin(a) * 7.5;
    if (terrain.classAt(hx, hz) !== 3) continue;
    const hy = terrain.heightAt(hx, hz);
    if (Math.abs(hy - plaza) > 1.2) continue;
    bin.add(M.stone, WORLD.cylinder(hx, hz, 0.62, 0.66, hy - 0.3, hy + 0.06, 16), GRANITE);
    bin.add(M.paint, WORLD.cylinder(hx, hz, 0.36, 0.36, hy + 0.06, hy + 0.075, 16), HOLE);
    holes++;
    k++; // keep them a little apart
  }

  // the granite edge of the plaza's terraces: blocks wherever plaza meets the drop to the rocks or the sea
  const kerb = new Set();
  for (let z = z0 - 22; z <= z0 + 22; z += 1) {
    for (let x = x0 - 16; x <= x0 + 40; x += 1) {
      if (terrain.classAt(x, z) !== 3) continue;
      const y = terrain.heightAt(x, z);
      for (const [ox, oz] of [[0, -1.5], [-1.5, 0], [0, 1.5], [1.5, 0]]) {
        const nx = x + ox, nz = z + oz, c = terrain.classAt(nx, nz);
        if (c === 3 || c === 2 || c === 1) continue;
        if (terrain.heightAt(nx, nz) > y - 0.9) continue;
        const key = `${Math.round(x)},${Math.round(z)}`;
        if (kerb.has(key)) continue;
        kerb.add(key);
        bin.add(M.stone, WORLD.box(x + ox * 0.25, z + oz * 0.25, ox ? 0.6 : 1.04, oz ? 0.6 : 1.04, y - 0.6, y + 0.3), GRANITE);
      }
    }
  }

  const group = new THREE.Group();
  group.name = 'HaizearenOrrazia';
  bin.build(group);
  return group;
}
