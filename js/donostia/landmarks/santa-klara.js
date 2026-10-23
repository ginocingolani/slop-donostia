import * as THREE from 'three/webgpu';
import { PartBin, Frame, WORLD, westMaterials as M, rgb, createLighthouseLight, relayUpdate } from './igeldo.js';
import { pointInRing } from './geom.js';

// js/donostia/landmarks/santa-klara.js
// Santa Klara island: its small white lighthouse house on the summit, the jetty on the bay side; the island itself is
// in the LiDAR terrain.
//
// The lighthouse (lit September 1864): a white two-storey keeper's house with a short polygonal tower on its seaward
// (north) side; 10 m to the top, focal plane 53 m above the sea, Fl W 5 s, 9 nm (es.wikipedia "Faro de la isla de Santa
// Clara"; OSM way 28161366). Since 2021 Cristina Iglesias' "Hondalea" fills the house; its outside is unchanged.
//
// build(sites, ctx) receives the GEO.landmarks entries ['santa-klara-itsasargia'] and ctx = { GEO, terrain, kit }.

const WHITE = rgb(0xefede7), TRIM = rgb(0xb3ada2), ROOF = rgb(0xbdb8b0), DARK = rgb(0x26302b), IRON = rgb(0x2a2d30);
const CONCRETE = rgb(0xa29d93);

// The house is the footprint's oriented box without the tower's bulge: rows (or columns) of the outline much narrower
// than the widest belong to the bulge. Returns the frame, the house rectangle and the bulge's centre and radius.
function splitBulge(ring, kit) {
  const ob = kit.orientedBox(ring);
  const fr = new Frame(ob.x, ob.z, ob.angle);
  const uv = [];
  for (let k = 0; k < ring.length; k += 2) uv.push(...fr.local(ring[k], ring[k + 1]));
  const inside = (u, v) => pointInRing(u, v, uv);
  const cell = 0.25, hu = ob.length / 2, hv = ob.width / 2;
  const best = { score: -Infinity };
  for (const axis of ['v', 'u']) {
    // widths of the rows across `axis`
    const span = axis === 'v' ? hv : hu, across = axis === 'v' ? hu : hv;
    const rows = [];
    for (let a = -span + cell / 2; a < span; a += cell) {
      let w = 0;
      for (let b = -across + cell / 2; b < across; b += cell) if (axis === 'v' ? inside(b, a) : inside(a, b)) w += cell;
      rows.push([a, w]);
    }
    const max = Math.max(...rows.map((r) => r[1]));
    const full = rows.filter((r) => r[1] > 0.6 * max);
    const a0 = full[0][0] - cell / 2, a1 = full[full.length - 1][0] + cell / 2;
    // the candidate rectangle should be full: score what it covers, less twice what it covers in vain
    let covered = 0;
    for (const [a, w] of rows) if (a > a0 && a < a1) covered += w * cell;
    const score = covered - 2 * ((a1 - a0) * 2 * across - covered);
    if (score > best.score) Object.assign(best, { score, axis, a0, a1 });
  }
  const rect = best.axis === 'v' ? { u0: -hu, u1: hu, v0: best.a0, v1: best.a1 } : { u0: best.a0, u1: best.a1, v0: -hv, v1: hv };
  // the bulge: what lies outside the rectangle, measured along the wall it stands on and out from it
  const onV = best.axis === 'v';
  let n = 0, side = 0, minA = Infinity, maxA = -Infinity;
  const cells = [];
  for (let u = -hu + cell / 2; u < hu; u += cell) {
    for (let v = -hv + cell / 2; v < hv; v += cell) {
      if (!inside(u, v) || (u > rect.u0 && u < rect.u1 && v > rect.v0 && v < rect.v1)) continue;
      cells.push([u, v]);
      side += onV ? v : u;
      n++;
    }
  }
  if (n < 8) return { fr, rect, bulge: null };
  const out = Math.sign(side) || 1;
  const edge = onV ? (out > 0 ? rect.v1 : rect.v0) : (out > 0 ? rect.u1 : rect.u0);
  let reach = 0;
  for (const [u, v] of cells) {
    const a = onV ? u : v, p = ((onV ? v : u) - edge) * out;
    if (p < 0.35) continue; // clear of the rectangle edge's own slivers
    minA = Math.min(minA, a);
    maxA = Math.max(maxA, a);
    reach = Math.max(reach, p);
  }
  // a polygonal tower as wide as the bulge, set into the wall so its far side reaches the bulge's tip
  const r = (maxA - minA + cell) / 2;
  const a = (minA + maxA) / 2, o = edge + out * Math.max(0, reach + cell / 2 - r);
  return { fr, rect, bulge: { u: onV ? a : o, v: onV ? o : a, r, out: onV ? [0, out] : [out, 0] } };
}

export function build(sites, ctx) {
  const site = sites[0];
  if (!site?.footprint) return null;
  const { kit, GEO, terrain } = ctx;
  const ring = site.footprint;
  const g = kit.lowestGround(ctx, ring);
  const { fr, rect, bulge } = splitBulge(ring, kit);
  const cu = (rect.u0 + rect.u1) / 2, cv = (rect.v0 + rect.v1) / 2;
  const L = rect.u1 - rect.u0, W = rect.v1 - rect.v0;
  const b5m = GEO.buildings[site.buildings?.[0]];
  const eave = b5m && b5m.eave > g + 4 && b5m.eave < g + 10 ? b5m.eave : g + 7;
  const bin = new PartBin();
  const white = kit.materials.whiteRender, glass = kit.materials.glass;

  // the house: white walls on a stone plinth, stone quoins, cornice and a parapet round the flat roof
  bin.add(white, fr.box(cu, cv, L, W, g - 0.8, eave));
  bin.add(M.stone, fr.box(cu, cv, L + 0.14, W + 0.14, g - 0.8, g + 0.5), TRIM);
  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      for (let k = 0; k * 0.62 + 0.5 < eave - g - 0.3; k++) {
        const long = k % 2 === 0;
        const u = cu + su * (L / 2 - (long ? 0.35 : 0.25)), v = cv + sv * (W / 2 - (long ? 0.25 : 0.35));
        bin.add(M.stone, fr.box(u, v, long ? 0.8 : 0.6, long ? 0.6 : 0.8, g + 0.5 + k * 0.62, g + 0.5 + k * 0.62 + 0.56), TRIM);
      }
    }
  }
  bin.add(M.stone, fr.box(cu, cv, L + 0.45, W + 0.45, eave - 0.1, eave + 0.22), TRIM);
  for (const [u, v, su, sv] of [[cu, rect.v0, L + 0.3, 0.28], [cu, rect.v1, L + 0.3, 0.28], [rect.u0, cv, 0.28, W], [rect.u1, cv, 0.28, W]]) {
    bin.add(white, fr.box(u, v, su, sv, eave + 0.22, eave + 0.85));
  }
  bin.add(M.paint, fr.box(cu, cv, L - 0.2, W - 0.2, eave, eave + 0.3), ROOF);

  // windows: three a floor on the long sides, two on the ends; the door on the landward side away from the tower
  const out = bulge ? bulge.out : [0, 1];
  const opening = (u, v, nu, nv, w, y0, h) => {
    bin.add(M.stone, fr.box(u, v, nu ? 0.14 : w + 0.3, nv ? 0.14 : w + 0.3, y0 - 0.14, y0 + h + 0.14), TRIM);
    bin.add(glass, fr.box(u + nu * 0.03, v + nv * 0.03, nu ? 0.14 : w, nv ? 0.14 : w, y0, y0 + h));
  };
  const floors = [g + 1.0, g + 1.0 + (eave - g) / 2];
  for (const [nu, nv] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const len = nu ? W : L;
    const count = len > 9 ? 3 : 2;
    const base = [cu + nu * (L / 2 + 0.04), cv + nv * (W / 2 + 0.04)];
    const towerSide = bulge && nu === out[0] && nv === out[1];
    const doorSide = nu === -out[0] && nv === -out[1];
    for (let i = 0; i < count; i++) {
      const t = -len / 2 + (len * (i + 0.5)) / count;
      if (towerSide && Math.abs(t - (nu ? bulge.v - cv : bulge.u - cu)) < bulge.r + 0.8) continue;
      const u = nu ? base[0] : cu + t, v = nv ? base[1] : cv + t;
      for (const [f, y0] of floors.entries()) {
        if (doorSide && f === 0 && i === Math.floor(count / 2)) opening(u, v, nu, nv, 1.2, g, 2.4);
        else opening(u, v, nu, nv, 0.95, y0, 1.6);
      }
    }
  }

  // the tower: an octagon on the seaward wall, gallery, lantern and dome
  let light = null;
  if (bulge) {
    const [tx, tz] = fr.world(bulge.u, bulge.v);
    const r = Math.min(1.5, Math.max(1.1, bulge.r));
    // the gallery just clears the parapet, which puts the lamp at the published 53 m
    const top = Math.max(eave + 0.8, g + 7.5);
    const octagon = (rTop, rBottom, y0, y1) => {
      const geo = new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, 8);
      geo.rotateY(Math.PI / 8 - fr.angle);
      geo.translate(tx, (y0 + y1) / 2, tz);
      return geo;
    };
    bin.add(white, octagon(r, r, g - 0.6, top));
    bin.add(M.stone, octagon(r + 0.14, r + 0.14, eave - 0.1, eave + 0.22), TRIM);
    bin.add(M.stone, octagon(r + 0.45, r + 0.05, top - 0.4, top), TRIM);
    bin.add(M.stone, octagon(r + 0.45, r + 0.45, top, top + 0.2), TRIM);
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      bin.add(M.metal, WORLD.box(tx + Math.cos(a) * (r + 0.35), tz + Math.sin(a) * (r + 0.35), 0.05, 0.05, top + 0.2, top + 1.1), IRON);
    }
    const rail = new THREE.TorusGeometry(r + 0.35, 0.035, 6, 32);
    rail.rotateX(Math.PI / 2);
    rail.translate(tx, top + 1.1, tz);
    bin.add(M.metal, rail, IRON);
    // narrow lights up the tower, facing the sea
    for (const y0 of [g + 2.0, g + 5.0]) {
      const [wx, wz] = fr.world(bulge.u + bulge.out[0] * (r - 0.02), bulge.v + bulge.out[1] * (r - 0.02));
      bin.add(glass, WORLD.box(wx, wz, 0.45, 0.16, y0, y0 + 1.3, Math.atan2(bulge.out[1], bulge.out[0]) + fr.angle + Math.PI / 2));
    }
    const lr = 0.8;
    bin.add(M.paint, WORLD.cylinder(tx, tz, lr + 0.1, lr + 0.12, top + 0.2, top + 0.75, 16), WHITE);
    const lanternTop = top + 2.15;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      bin.add(M.metal, WORLD.box(tx + Math.cos(a) * (lr + 0.02), tz + Math.sin(a) * (lr + 0.02), 0.06, 0.06, top + 0.75, lanternTop), DARK);
    }
    bin.add(M.paint, WORLD.cylinder(tx, tz, 0.1, lr + 0.25, lanternTop, lanternTop + 0.7, 16), DARK);
    bin.add(M.metal, WORLD.box(tx, tz, 0.04, 0.04, lanternTop + 0.7, lanternTop + 1.2), DARK);
    const focal = (top + 0.75 + lanternTop) / 2;
    light = createLighthouseLight({ x: tx, y: focal, z: tz, radius: lr, period: 5, flashes: [0], flashLength: 0.7 });
    bin.add(light.lantern, WORLD.cylinder(tx, tz, lr, lr, top + 0.75, lanternTop, 16));
  }

  // the jetty on the bay side: the LiDAR keeps its concrete tongue (x -748..-738, z -12..-1, 1-3 m); the deck runs on
  // from where the ground drops below it, out over the water, with steps down its eastern flank and bollards
  const dir = [0.34, 0.94]; // along the tongue, out into the bay to the south-south-east
  const DECK = 2.6; // m above mean sea level: dry at all but the spring high tides (range ~4.5 m)
  let jx = -747.5, jz = -14.5;
  for (let k = 0; k < 40 && terrain.heightAt(jx, jz) > DECK - 0.2; k++) { jx += dir[0] * 0.5; jz += dir[1] * 0.5; }
  const length = 16, width = 4.2;
  const angle = Math.atan2(dir[1], dir[0]);
  const jf = new Frame(jx + (dir[0] * length) / 2, jz + (dir[1] * length) / 2, angle);
  // (in the jetty's frame +u runs out to sea and +v points west: the boats from the port come alongside the east side)
  if (Math.hypot(jx - site.at[0], jz - site.at[1]) < 120) {
    bin.add(M.stone, jf.box(0, 0, length + 2, width, -3.0, DECK), CONCRETE);
    bin.add(M.stone, jf.box(0.3, width / 2 - 0.2, length + 1.4, 0.4, DECK, DECK + 0.5), CONCRETE); // parapet to the swell
    for (let k = 0; k < 7; k++) {
      // steps down the eastern side to the low-tide landing at the end
      const y1 = DECK - 0.35 * (k + 1);
      bin.add(M.stone, jf.box(length / 2 - 1.2 - (6 - k) * 0.55, -width / 2 - 0.6, 0.6, 1.2, -3.0, y1), CONCRETE);
    }
    for (const u of [-length / 2 + 2, -1, 3]) {
      const [bx, bz] = jf.world(u, -width / 2 + 0.45);
      bin.add(M.metal, WORLD.cylinder(bx, bz, 0.16, 0.2, DECK, DECK + 0.55, 10), IRON);
    }
  }

  const group = new THREE.Group();
  group.name = 'SantaKlara';
  bin.build(group);
  if (light) {
    group.add(light.object);
    relayUpdate(group, (dt, elapsed, camera) => light.update(elapsed, camera));
  }
  return group;
}
