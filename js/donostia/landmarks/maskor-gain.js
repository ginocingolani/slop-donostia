import * as THREE from 'three/webgpu';
import { pointInRing } from './geom.js';
import { PaintBuilder, FINISH, at, box, M4 } from './paint.js';

// js/donostia/landmarks/maskor-gain.js
// Maskor Gain (Mirakontxa pasealekua 12; in Basque "over the shell", La Concha's), the turreted block of flats on the
// lawn above the Paseo de La Concha below Aldapeta, in the manner of the Belle Époque villas of Miraconcha (b5m's
// cadastral date: 1987). Modelled on its 1:500 outline and the photographs (Wikimedia Commons: "Palacete-san
// sebastian-9-2005" from the promenade, "San Sebastian - panoramio (11)" at night, "Kontxa pasealekua, Donostia"),
// references only:
//  - a brick block, deep red, its four corners carried on octagonal turrets painted cream, glazed all round, a white
//    band at every floor, an arcaded top storey of round-headed windows under a broad cornice and a tall slate spire
//    with a finial;
//  - the front to the bay between the turrets is four bow windows rising through the three floors over the ground
//    floor, white and glazed, two broad and two narrow, each with a balcony on top before an arched dormer; arched doors
//    and windows on the ground floor; a slate mansard over a white cornice, with a chimney and arched dormers all round;
//  - a terrace before it behind a white balustrade, rounded into bastions before the turrets; at the back, uphill, a
//    lower wing with a ribbed dome.
// The orthophoto (2025, Eusko Jaurlaritza / Gobierno Vasco, geoEuskadi) shows the turrets' octagonal spires, the
// mansard's dormers, the roof garden on the flat top and the dome. Heights: b5m (CC BY 4.0) measures ~11.6 m mean and
// ~14.6 m at the top over its ground; the floors, the turrets and their ~22 m spires were read off the photographs.
//
// Data: the frame, the block, the turrets and the back wing from the municipal 1:500 map (Donostiako Udala,
// CC BY-SA 3.0) as GEO.buildings holds it; the ground from the LiDAR (geoEuskadi, CC BY 4.0).
//
// A site-less landmark: build([], ctx) finds Maskor Gain's plain extrusion in GEO.buildings by position and hides it
// through userData.hide. One mesh, one material (paint.js).

const deg = THREE.MathUtils.degToRad;
const AT = [-85.4, 750.8]; // the block's centre (local metres), inside its outline
// The frame, read off the outline: +u along the front to the bay (13.47° north of east), +v across it inland; the front
// faces -v
const ANGLE = deg(-13.47);
// The block between the turrets' centres, and the turrets: [u, v, apothem, the spire's top]
const BLOCK = { u0: -11.37, u1: 11.4, v0: -7.69, v1: 7.81 };
const TURRETS = [[-11.09, -7.53, 2.58, 22.4], [11.18, -7.49, 2.58, 22.4], [11.11, 7.43, 2.3, 21.4], [-11.1, 7.4, 2.3, 21.4]];
// Heights over the ground floor: the floors' levels, the main cornice, the mansard's flat top, the turrets' top storey
const FLOORS = [0, 3.4, 6.4, 9.4], CORNICE = 12.4, TOP = 15.0, LANTERN = 15.4;
// The bow windows on the front: centre u, width along the front, projection
const BOWS = [[-6.4, 2.2, 0.8], [-2.4, 3.6, 1.0], [2.4, 3.6, 1.0], [6.4, 2.2, 0.8]];
// The back wing up the slope (the link and the wing) and its dome
const BACK = [[-2.05, 2.02, 7.81, 12.16], [-5.69, 3.73, 12.16, 19.38]];
const DOME = { u: 0.4, v: 15.0, r: 2.5 };

const lin = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };
const P = (h, finish, rough) => [...lin(h), finish + rough];
// Paints (sRGB, then the finish code and its roughness or strength: see paint.js)
const BRICK = P(0x8f4536, FINISH.paint, 0.86), CREAM = P(0xebe4d2, FINISH.paint, 0.6), WHITE = P(0xf5f3ec, FINISH.paint, 0.5);
const SLATE = P(0x40444b, FINISH.paint, 0.48), IRON = P(0x202328, FINISH.metal, 0.5), ZINC = P(0xa7acae, FINISH.metal, 0.45);
const GLASS = P(0x46535e, FINISH.litGlass, 0.35), DOOR = P(0x4a3022, FINISH.paint, 0.7), GRASS = P(0x6a8a46, FINISH.paint, 0.95);
const STONE = P(0xd9d2c0, FINISH.paint, 0.85);

export function build(sites, ctx) {
  const { GEO, kit, terrain } = ctx;
  const index = GEO.buildings.findIndex((b) => b.g?.[0] && pointInRing(AT[0], AT[1], b.g[0]));
  if (index < 0) return null;
  const rec = GEO.buildings[index];
  const ring = rec.g[0];
  const G = Math.max(0, terrain.heightAt(AT[0], AT[1])); // the ground floor (the LiDAR's flat under the block)
  const foot = kit.lowestGround(ctx, ring) - G - 0.4;
  const F = M4().makeRotationY(-ANGLE).setPosition(AT[0], G, AT[1]);
  const c = Math.cos(ANGLE), s = Math.sin(ANGLE);
  const world = (u, v) => [AT[0] + u * c - v * s, AT[1] + u * s + v * c];
  const pb = new PaintBuilder();
  const add = (geo, paint, m = M4()) => pb.add(geo, paint, F.clone().multiply(m));
  // a face's frame: (u, y, v) on it, local +z outward along the direction at angle a (from +u towards +v)
  const face = (u, y, v, a) => at(u, y, v, Math.PI / 2 - a);
  const NORTH = -Math.PI / 2, SOUTH = Math.PI / 2, EAST = 0, WEST = Math.PI;

  // A window on a face's frame m, its sill at y: glass, a white frame, a mullion and transom when broad; round-headed
  // when arched (the glass and the frame go on up in a half round)
  const windowAt = (m, y, w, h, arched = false) => {
    add(new THREE.PlaneGeometry(w, h).translate(0, y + h / 2, 0.035), GLASS, m);
    add(box(w + 0.2, 0.12, 0.1, 0, y - 0.12, 0.03), WHITE, m);
    add(box(0.1, h, 0.08, -w / 2 - 0.05, y, 0.03), WHITE, m);
    add(box(0.1, h, 0.08, w / 2 + 0.05, y, 0.03), WHITE, m);
    if (arched) {
      add(new THREE.CircleGeometry(w / 2, 10, 0, Math.PI).translate(0, y + h, 0.035), GLASS, m);
      add(new THREE.RingGeometry(w / 2, w / 2 + 0.11, 10, 1, 0, Math.PI).translate(0, y + h, 0.045), WHITE, m);
    } else {
      add(box(w + 0.2, 0.12, 0.1, 0, y + h, 0.03), WHITE, m);
    }
    if (w > 1.1) add(box(0.07, h, 0.06, 0, y, 0.045), WHITE, m);
    add(box(w, 0.06, 0.06, 0, y + h * 0.72, 0.045), WHITE, m);
  };

  // --- the block: brick walls to the cornice, windows in bays on the sides and the back ------------------------------
  const { u0, u1, v0, v1 } = BLOCK;
  add(box(u1 - u0, CORNICE - foot, v1 - v0, (u0 + u1) / 2, foot, (v0 + v1) / 2), BRICK);
  const sideBays = [-3.1, 0, 3.1], backBays = [-6.6, -4.0, 4.0, 6.6];
  for (const y of FLOORS) {
    const sill = y ? y + 0.75 : 0.85, h = y ? 1.95 : 2.1;
    for (const v of sideBays) {
      windowAt(face(u1, 0, v, EAST), sill, 1.25, h);
      windowAt(face(u0, 0, v, WEST), sill, 1.25, h);
    }
    for (const u of backBays) windowAt(face(u, 0, v1, SOUTH), sill, 1.25, h);
  }
  // white bands at the floors on the sides and the back (the front's are the bows')
  for (const y of FLOORS.slice(1)) {
    add(box(0.12, 0.2, v1 - v0, u1 + 0.05, y - 0.1, (v0 + v1) / 2), WHITE);
    add(box(0.12, 0.2, v1 - v0, u0 - 0.05, y - 0.1, (v0 + v1) / 2), WHITE);
    add(box(u1 - u0, 0.2, 0.12, (u0 + u1) / 2, y - 0.1, v1 + 0.05), WHITE);
  }
  // the front's ground floor: an arched door under each narrow bow, a three-light window under each broad one
  for (const [cu, w] of BOWS) {
    const m = face(cu, 0, v0, NORTH);
    if (w < 3) {
      add(new THREE.PlaneGeometry(1.2, 2.3).translate(0, 1.15 + 0.05, 0.03), DOOR, m);
      add(new THREE.CircleGeometry(0.6, 10, 0, Math.PI).translate(0, 2.4, 0.03), GLASS, m);
      add(new THREE.RingGeometry(0.6, 0.78, 10, 1, 0, Math.PI).translate(0, 2.4, 0.05), WHITE, m);
      for (const e of [-1, 1]) add(box(0.18, 2.4, 0.1, e * 0.69, 0, 0.04), WHITE, m);
    } else {
      for (const e of [-1, 0, 1]) windowAt(face(cu + e * 1.05, 0, v0, NORTH), 0.85, 0.85, 2.0);
    }
  }

  // --- the bows: white prisms from a corbel to the cornice, glazed on every facet and floor, a balcony on top ---------
  for (const [cu, w, p] of BOWS) {
    const cut = w > 3 ? 0.6 : 0.45;
    const plan = [[cu - w / 2, v0], [cu - w / 2 + cut, v0 - p], [cu + w / 2 - cut, v0 - p], [cu + w / 2, v0]];
    const y0 = FLOORS[1] - 0.45, y1 = CORNICE;
    for (let k = 0; k < 3; k++) {
      const [a, b] = [plan[k], plan[k + 1]];
      const du = b[0] - a[0], dv = b[1] - a[1], len = Math.hypot(du, dv);
      const out = Math.atan2(-du, dv); // the facet's outward normal (the plan runs with the bow on its right)
      const m = face((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2, out);
      add(box(len, y1 - y0, 0.12, 0, y0, -0.06), CREAM, m);
      for (const y of FLOORS.slice(1)) {
        windowAt(m, y + 0.55, len - 0.34, 2.05);
        add(box(len + 0.06, 0.24, 0.16, 0, y - 0.12, 0.02), WHITE, m);
      }
      add(box(len + 0.1, 0.3, 0.2, 0, y1 - 0.15, 0.04), WHITE, m);
      // the balcony's railing on the bow's roof
      add(box(len, 0.06, 0.06, 0, y1 + 1.0, -0.05), IRON, m);
      for (let t = 0.1; t < 0.95; t += 0.2) add(box(0.04, 1.0, 0.04, (t - 0.5) * len, y1 + 0.05, -0.05), IRON, m);
    }
    // the corbel under it and the balcony's floor over it
    const shape = new THREE.Shape(plan.map(([u, v]) => new THREE.Vector2(u, -v)));
    add(new THREE.ExtrudeGeometry(shape, { depth: 0.45, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y0 - 0.05, 0), WHITE);
    add(new THREE.ExtrudeGeometry(shape, { depth: 0.18, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, y1, 0), WHITE);
  }

  // --- the turrets: cream octagons glazed all round, a white band at every floor, round-headed windows up top, a broad
  // cornice and a slate spire with a finial ----------------------------------------------------------------------------
  for (const [tu, tv, ap, spire] of TURRETS) {
    const R = ap / Math.cos(Math.PI / 8);
    const oct = (rTop, rBottom, y0, y1, paint) => add(new THREE.CylinderGeometry(rTop, rBottom, y1 - y0, 8).rotateY(-Math.PI / 8).translate(tu, (y0 + y1) / 2, tv), paint);
    oct(R, R, foot, LANTERN, CREAM);
    for (const y of FLOORS.slice(1)) oct(R + 0.1, R + 0.1, y - 0.12, y + 0.1, WHITE);
    oct(R + 0.3, R + 0.15, CORNICE - 0.2, CORNICE + 0.25, WHITE);
    oct(R + 0.55, R + 0.2, LANTERN - 0.1, LANTERN + 0.45, WHITE);
    oct(0.06, R + 0.35, LANTERN + 0.45, spire, SLATE);
    add(new THREE.CylinderGeometry(0.035, 0.05, 1.3, 6).translate(tu, spire + 0.55, tv), IRON);
    add(new THREE.SphereGeometry(0.1, 8, 6).translate(tu, spire + 0.25, tv), IRON);
    // windows on the faces that stand clear of the block
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const fu = tu + Math.cos(a) * ap, fv = tv + Math.sin(a) * ap;
      if (fu > u0 + 0.3 && fu < u1 - 0.3 && fv > v0 + 0.3 && fv < v1 - 0.3) continue;
      const m = face(fu, 0, fv, a);
      const side = 2 * ap * Math.tan(Math.PI / 8);
      for (const y of FLOORS) windowAt(m, y ? y + 0.6 : 0.85, side - 0.6, 2.0);
      windowAt(m, CORNICE + 0.6, side - 0.7, 1.65, true);
    }
  }

  // --- the roof: a white cornice, the slate mansard, a garden on the flat top, a chimney, arched dormers ---------------
  {
    const o = 0.3, inset = 0.85;
    add(box(u1 - u0 + 2 * o, 0.4, v1 - v0 + 2 * o, (u0 + u1) / 2, CORNICE - 0.2, (v0 + v1) / 2), WHITE);
    const lo = [[u0 - 0.1, v0 - 0.1], [u1 + 0.1, v0 - 0.1], [u1 + 0.1, v1 + 0.1], [u0 - 0.1, v1 + 0.1]];
    const hi = [[u0 + inset, v0 + inset], [u1 - inset, v0 + inset], [u1 - inset, v1 - inset], [u0 + inset, v1 - inset]];
    const yl = CORNICE + 0.2;
    for (let k = 0; k < 4; k++) {
      const j = (k + 1) % 4;
      const pts = [[lo[k][0], yl, lo[k][1]], [lo[j][0], yl, lo[j][1]], [hi[j][0], TOP, hi[j][1]], [hi[k][0], TOP, hi[k][1]]].map(([u, y, v]) => {
        const p = new THREE.Vector3(u, y, v).applyMatrix4(F);
        return [p.x, p.y, p.z];
      });
      const mid = new THREE.Vector3((lo[k][0] + lo[j][0]) / 2, 0, (lo[k][1] + lo[j][1]) / 2);
      const n = new THREE.Vector3(mid.x - (u0 + u1) / 2, 0, mid.z - (v0 + v1) / 2).normalize().applyMatrix4(new THREE.Matrix4().makeRotationY(-ANGLE));
      pb.quad(pts[0], pts[1], pts[2], pts[3], SLATE, [n.x, 0.5, n.z]);
    }
    // the flat top: a white parapet round a lawn, the stair's slate housing
    const [a, b] = hi[0], [cU, cV] = hi[2];
    add(box(cU - a, 0.08, cV - b, (a + cU) / 2, TOP - 0.05, (b + cV) / 2), GRASS);
    for (const [w, d, u, v] of [[cU - a, 0.3, (a + cU) / 2, b + 0.15], [cU - a, 0.3, (a + cU) / 2, cV - 0.15], [0.3, cV - b, a + 0.15, (b + cV) / 2], [0.3, cV - b, cU - 0.15, (b + cV) / 2]]) {
      add(box(w, 0.55, d, u, TOP - 0.05, v), WHITE);
    }
    add(box(2.6, 2.2, 5.0, 0.6, TOP, 2.2), SLATE);
    add(box(1.0, 3.0, 1.9, 0, TOP - 1.0, -5.4), BRICK);
    add(box(1.25, 0.25, 2.15, 0, TOP + 2.0, -5.4), WHITE);
    // arched dormers: over each bow on the front (behind its balcony), and in the bays of the sides and the back
    const dormer = (u, v, a, w) => {
      const m = face(u, 0, v, a);
      const shape = new THREE.Shape();
      const h = 2.0, rise = w * 0.22;
      shape.moveTo(-w / 2, 0);
      shape.lineTo(w / 2, 0);
      shape.lineTo(w / 2, h);
      shape.quadraticCurveTo(0, h + 2 * rise, -w / 2, h);
      shape.closePath();
      add(new THREE.ShapeGeometry(shape, 6).translate(0, CORNICE + 0.25, -0.15), WHITE, m);
      add(box(w - 0.5, h - 0.3, 0.05, 0, CORNICE + 0.45, -0.12), GLASS, m);
      add(box(w - 0.1, h + rise + 0.1, 1.5, 0, CORNICE + 0.2, -0.95), SLATE, m);
    };
    for (const [cu, w] of BOWS) dormer(cu, v0 - 0.1, NORTH, w - 0.3);
    for (const v of sideBays) { dormer(u1 + 0.1, v, EAST, 1.6); dormer(u0 - 0.1, v, WEST, 1.6); }
    for (const u of backBays) dormer(u, v1 + 0.1, SOUTH, 1.6);
  }

  // --- the back wing up the slope: brick, windows, a flat top and the ribbed dome ------------------------------------
  {
    const top = 8.8;
    for (const [a, b, c0, d] of BACK) add(box(b - a, top - foot, d - c0, (a + b) / 2, foot, (c0 + d) / 2), BRICK);
    const d = BACK[1][3];
    for (const y of [3.2, 6.0]) for (const u of [-4.2, -1.0, 2.2]) windowAt(face(u, 0, d, SOUTH), y + 0.6, 1.1, 1.7);
    for (const [a1, b1, c1, d1] of BACK) add(box(b1 - a1 + 0.4, 0.35, d1 - c1 + 0.4, (a1 + b1) / 2, top - 0.1, (c1 + d1) / 2), WHITE);
    const dome = new THREE.SphereGeometry(DOME.r, 16, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    add(dome.translate(DOME.u, top + 0.25, DOME.v), ZINC);
    add(new THREE.CylinderGeometry(0.25, 0.3, 0.6, 8).translate(DOME.u, top + 0.25 + DOME.r + 0.2, DOME.v), WHITE);
  }

  // --- the terrace before the front: a white balustrade on a plinth, rounded into bastions before the turrets --------
  {
    const vt = -12.2, yT = -0.5;
    // the half rounds towards the bay (-v), and the straight run between them
    const arc = (tu) => Array.from({ length: 9 }, (_, k) => {
      const t = Math.PI + (Math.PI * k) / 8;
      return [tu + 2.9 * Math.cos(t), vt + 2.9 * Math.sin(t)];
    });
    const runs = [arc(-11.1), [[-8.2, vt], [8.25, vt]], arc(11.15)];
    for (const run of runs) {
      for (let k = 0; k + 1 < run.length; k++) {
        const [pa, pb2] = [run[k], run[k + 1]];
        const du = pb2[0] - pa[0], dv = pb2[1] - pa[1], len = Math.hypot(du, dv);
        const mu = (pa[0] + pb2[0]) / 2, mv = (pa[1] + pb2[1]) / 2;
        const ground = Math.max(0, terrain.heightAt(...world(mu, mv))) - G;
        const m = at(mu, 0, mv, Math.atan2(du, dv) - Math.PI / 2);
        if (ground < yT - 0.1) add(box(len + 0.05, yT - ground + 0.3, 0.35, 0, ground - 0.3, 0), STONE, m);
        add(box(len + 0.05, 0.16, 0.34, 0, yT, 0), WHITE, m);
        add(box(len + 0.05, 0.12, 0.3, 0, yT + 0.86, 0), WHITE, m);
        const n = Math.max(1, Math.round(len / 0.32));
        for (let i = 0; i < n; i++) add(box(0.12, 0.7, 0.12, ((i + 0.5) / n - 0.5) * len, yT + 0.16, 0), WHITE, m);
      }
    }
    // the bastions' paving
    for (const tu of [-11.1, 11.15]) {
      add(new THREE.CircleGeometry(2.85, 12, 0, Math.PI).rotateX(-Math.PI / 2).translate(tu, yT + 0.02, vt), STONE);
    }
  }

  const mesh = pb.build('MaskorGain');
  const group = new THREE.Group();
  group.name = 'MaskorGain';
  if (mesh) group.add(mesh);
  group.userData.hide = [index];
  return group;
}
