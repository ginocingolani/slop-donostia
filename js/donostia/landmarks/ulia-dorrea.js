import * as THREE from 'three/webgpu';
import { PartBin, WORLD, westMaterials as M, rgb } from './igeldo.js';

// js/donostia/landmarks/ulia-dorrea.js
// Uliako dorrea: the old lookout tower on Monte Ulía, east of Sagüés.
//
// Ulía's lookouts watched for whales from the 16th century (a 1611 request to build a hut "for the watch" survives);
// the early-20th-century pleasure park on the hill rebuilt its lookout features in a romantic, historicist way
// (Donostia heritage inventory, Mirall watchtower). The round tower here follows the OSM outline (way 417178149,
// about 7.8 m across); its height is not documented, ~9 m to the merlons reads right for that girth.
//
// build(sites, ctx) receives the GEO.landmarks entries ['ulia-dorrea'] and ctx = { GEO, terrain, kit }.

const RUBBLE = rgb(0xa39d90), DARK_STONE = rgb(0x847d70);

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { kit } = ctx;
  const ring = site.footprint;
  let cx = 0, cz = 0;
  const n = ring.length / 2;
  for (let k = 0; k < ring.length; k += 2) { cx += ring[k]; cz += ring[k + 1]; }
  cx /= n; cz /= n;
  let r = 0;
  for (let k = 0; k < ring.length; k += 2) r += Math.hypot(ring[k] - cx, ring[k + 1] - cz);
  r /= n;

  // the ground there is the 8 m context grid: sink the base well in
  const g = kit.lowestGround(ctx, ring) - 0.4;
  const bin = new PartBin();
  const body = g + 8.6;
  bin.add(M.stone, WORLD.cylinder(cx, cz, r - 0.2, r + 0.15, g - 1.5, body, 28), RUBBLE);
  bin.add(M.stone, WORLD.cylinder(cx, cz, r + 0.35, r + 0.35, g - 1.5, g + 0.6, 28), DARK_STONE); // battered footing
  bin.add(M.stone, WORLD.cylinder(cx, cz, r - 0.05, r - 0.05, g + 4.4, g + 4.7, 28), DARK_STONE); // string course
  // corbelled parapet with merlons
  bin.add(M.stone, WORLD.cylinder(cx, cz, r + 0.25, r - 0.2, body, body + 0.6, 28), DARK_STONE);
  bin.add(M.stone, WORLD.cylinder(cx, cz, r + 0.25, r + 0.25, body + 0.6, body + 1.2, 28), RUBBLE);
  const merlons = 12;
  for (let k = 0; k < merlons; k++) {
    const a = (k / merlons) * Math.PI * 2;
    bin.add(M.stone, WORLD.box(cx + Math.cos(a) * (r + 0.05), cz + Math.sin(a) * (r + 0.05), 1.0, 0.45, body + 1.2, body + 2.0, a + Math.PI / 2), RUBBLE);
  }
  // a door facing the path up from the south-west, and narrow lights up the shaft
  const glass = kit.materials.glass;
  const door = 2.4;
  bin.add(glass, WORLD.box(cx + Math.cos(door) * (r + 0.05), cz + Math.sin(door) * (r + 0.05), 1.1, 0.3, g, g + 2.2, door + Math.PI / 2));
  bin.add(M.stone, WORLD.box(cx + Math.cos(door) * (r + 0.1), cz + Math.sin(door) * (r + 0.1), 1.5, 0.3, g + 2.2, g + 2.6, door + Math.PI / 2), DARK_STONE);
  for (const [a, y] of [[0.3, 3.0], [1.9, 5.6], [3.6, 3.4], [5.0, 6.2]]) {
    bin.add(glass, WORLD.box(cx + Math.cos(a) * (r + 0.02), cz + Math.sin(a) * (r + 0.02), 0.35, 0.25, g + y, g + y + 1.1, a + Math.PI / 2));
  }

  const group = new THREE.Group();
  group.name = 'UliaDorrea';
  bin.build(group);
  return group;
}
