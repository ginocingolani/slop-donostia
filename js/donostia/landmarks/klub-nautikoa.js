import * as THREE from 'three/webgpu';
import { Parts, ringArea, reverseRing } from './geom.js';
import { PaintBuilder, at, box, cyl, M4 } from './paint.js';

// js/donostia/landmarks/klub-nautikoa.js
// The Real Club Náutico de San Sebastián (Klub Nautikoa; José Manuel Aizpurua & Joaquín Labayen, 1929), the white
// rationalist "ship" moored on the seawall between the harbour and La Concha, at the western end of Alderdi Eder: a
// landmark of the Spanish modern movement (GATEPAC). Modelled on the 1:500 outline (a hull ~64 x 7 m along the
// seawall) and the photographs (Wikimedia Commons: the club from the pier and from the promenade, the bow from the
// quay):
//  - the hull: a white wall on the seawall's apron with a row of portholes, the decks' floor level with the promenade;
//  - the main deck: a saloon of dark varnished panelling and glass, rounded at the bow end under the bridge, set back
//    behind a covered terrace along the sea side with a white tubular railing of three rails on slender round columns;
//  - the upper deck: the bridge over the northern half, a half-round bow with a ribbon of windows between a solid
//    white parapet and a deep white fascia; behind it a glazed pavilion and an open deck, all behind white railings;
//  - the mast on the bridge: a white signal mast with a yard and a gaff, stayed to the roof.
// b5m measures it at ~6.9 m over the promenade (eaves) and ~9.7 m (top).
//
// A site-less landmark: build([], ctx) finds the club's plain extrusion in GEO.buildings by position (its 1:500
// outline lies about (175, -3)) and hides it through userData.hide.

const AT = [175.2, -3.3]; // the outline's centre (local metres)
const DECK = 0.45, DECK2 = 3.4, SLAB = 0.3, BRIDGE = 6.7; // over the promenade: deck floors, upper slab, bridge roof
const WOOD = [0.11, 0.045, 0.018, 0.45], DARK = [0.025, 0.03, 0.035, 1.15], PLANK = [0.2, 0.12, 0.07, 0.75];
// the club's windows: dark glass by day, lit warm at night (a restaurant and bar)
const GLASS = [0.035, 0.045, 0.055, 3.35];

export function build(sites, ctx) {
  const { GEO, kit, terrain } = ctx;
  const { materials } = kit;
  // the plain extrusion(s) whose centre lies within 12 m of the club's, the largest giving the frame
  const hide = [];
  let ring = null, best = 0;
  GEO.buildings.forEach((b, i) => {
    const r = b.g?.[0];
    if (!r) return;
    let cx = 0, cz = 0;
    for (let k = 0; k < r.length; k += 2) { cx += r[k]; cz += r[k + 1]; }
    cx /= r.length / 2; cz /= r.length / 2;
    if (Math.hypot(cx - AT[0], cz - AT[1]) > 12) return;
    hide.push(i);
    const a = Math.abs(ringArea(r));
    if (a > best) { best = a; ring = r; }
  });
  if (!ring || best < 250) return null;

  // Frame: +u along the hull towards the bow (north), +v across towards the promenade (east), the sea at -v; y = 0 on
  // the promenade beside the club
  const ob = kit.orientedBox(ring);
  let angle = ob.angle;
  if (Math.sin(angle) > 0) angle += Math.PI; // the bow points north (-z)
  const c = Math.cos(angle), s = Math.sin(angle);
  const toU = (x, z) => [(x - ob.x) * c + (z - ob.z) * s, -(x - ob.x) * s + (z - ob.z) * c];
  const G = Math.max(0, terrain.heightAt(ob.x - s * 8, ob.z + c * 8)); // the promenade, 8 m inland of the axis
  const low = kit.lowestGround(ctx, ring) - G - 0.3;
  const F = M4().makeRotationY(-angle).setPosition(ob.x, G, ob.z);
  const L = (m) => F.clone().multiply(m);

  // the outline in the frame, wound positive; its extent along u and across v at each end
  let foot = [];
  for (let k = 0; k < ring.length; k += 2) foot.push(...toU(ring[k], ring[k + 1]));
  if (ringArea(foot) < 0) foot = reverseRing(foot);
  let u0 = Infinity, u1 = -Infinity, vSea = Infinity, vLand = -Infinity;
  for (let k = 0; k < foot.length; k += 2) {
    u0 = Math.min(u0, foot[k]); u1 = Math.max(u1, foot[k]);
    vSea = Math.min(vSea, foot[k + 1]); vLand = Math.max(vLand, foot[k + 1]);
  }
  const W = vLand - vSea, vc = (vSea + vLand) / 2;

  const parts = new Parts();
  const white = materials.whiteRender, iron = materials.whiteIron;
  const paint = new PaintBuilder();
  const add = (mat, geo, m = M4()) => parts.addAt(mat, geo, L(m));
  const addP = (geo, p, m = M4()) => paint.add(geo, p, L(m));

  // --- the hull: the outline from the apron up to the deck, portholes along the sea side -----------------------------
  {
    const shape = new THREE.Shape();
    for (let k = 0; k < foot.length; k += 2) (k ? shape.lineTo : shape.moveTo).call(shape, foot[k], -foot[k + 1]);
    const g = new THREE.ExtrudeGeometry(shape, { depth: DECK - low, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.translate(0, low, 0);
    add(white, g);
    // portholes: dark glass in white rims, one every 3.2 m, two metres under the deck
    // (facing the sea, -v)
    const disc = new THREE.CircleGeometry(0.24, 14).rotateY(Math.PI);
    const rim = new THREE.TorusGeometry(0.26, 0.04, 6, 14);
    for (let u = u0 + 2.5; u < u1 - 2; u += 3.2) {
      // the sea face at this u: the smallest v of the outline there
      const v = seaEdgeAt(foot, u);
      if (v === null) continue;
      for (const y of [-2.1]) {
        if (y < low + 0.6) continue;
        addP(disc, DARK, at(u, y, v - 0.02));
        add(iron, rim.clone(), at(u, y, v - 0.03));
      }
    }
    // the doors onto the apron
    for (const u of [u0 + 14, u0 + 34]) {
      const v = seaEdgeAt(foot, u);
      if (v !== null && low < -2.6) addP(new THREE.PlaneGeometry(1.1, 2.1).rotateY(Math.PI), [0.35, 0.33, 0.3, 0.6], at(u, -3.1 + 1.05 + Math.max(0, low + 3.1), v - 0.02));
    }
    // the deck: a boarded top over the hull's outline (a hand's breadth proud of it)
    const deck = new THREE.ExtrudeGeometry(shape, { depth: 0.04, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, DECK, 0);
    addP(deck, PLANK);
  }

  // --- the main deck: the saloon set back behind the sea-side terrace ------------------------------------------------
  const terrace = 2.0; // the covered terrace's width along the sea side
  const vS = vSea + terrace, vL = vLand - 0.15; // the saloon's sea & land faces
  const uS = u0 + 3.0, uBow = u1 - 0.6; // its south end; the bow end (round) under the bridge
  const rBow = (vL - vS) / 2, cBow = uBow - rBow, vMid = (vS + vL) / 2;
  {
    // walls of panelling and glass: piers of dark wood between tall panes, a wood dado, a white head
    const H0 = DECK + 0.04, H1 = DECK2;
    // the land side: a white wall with a row of square windows (the street side of the saloon)
    const landRun = (p0, p1) => {
      const du = p1[0] - p0[0], dv = p1[1] - p0[1], len = Math.hypot(du, dv);
      const n = Math.max(1, Math.round(len / 2.6)), ry = Math.atan2(du, dv) - Math.PI / 2;
      for (let k = 0; k < n; k++) {
        const w = len / n, t = (k + 0.5) / n, m = at(p0[0] + du * t, 0, p0[1] + dv * t, ry);
        add(white, box(w, 1.0, 0.25, 0, H0, 0), m);
        add(white, box(w * 0.38, H1 - H0 - 1.0, 0.25, -w * 0.31, H0 + 1.0, 0), m);
        add(white, box(w * 0.38, H1 - H0 - 1.0, 0.25, w * 0.31, H0 + 1.0, 0), m);
        add(white, box(w * 0.24, H1 - H0 - 2.4, 0.25, 0, H0 + 2.4, 0), m);
        addP(box(w * 0.24, 1.4, 0.1, 0, H0 + 1.0, 0), GLASS, m);
      }
    };
    const wallRun = (p0, p1) => {
      const du = p1[0] - p0[0], dv = p1[1] - p0[1], len = Math.hypot(du, dv);
      if (len < 0.05) return;
      const n = Math.max(1, Math.round(len / 1.9)), ry = Math.atan2(du, dv) - Math.PI / 2;
      for (let k = 0; k < n; k++) {
        const t0 = k / n, t1 = (k + 1) / n, w = len / n;
        const mu = p0[0] + du * (t0 + t1) / 2, mv = p0[1] + dv * (t0 + t1) / 2;
        const m = at(mu, 0, mv, ry);
        addP(box(w, 0.75, 0.12, 0, H0, 0), WOOD, m); // dado
        addP(box(0.32, H1 - H0 - 0.75, 0.14, -w / 2 + 0.16, H0 + 0.75, 0), WOOD, m); // pier
        addP(box(w - 0.32, H1 - H0 - 1.05, 0.05, 0.16, H0 + 0.75, 0), GLASS, m); // pane
        addP(box(w, 0.3, 0.14, 0, H1 - 0.3, 0), WOOD, m); // head
      }
    };
    wallRun([uS, vS], [cBow, vS]);
    landRun([cBow, vL], [uS, vL]);
    wallRun([uS, vL], [uS, vS]);
    // the bow end: a half round of panelling with portholes
    const seg = 10;
    for (let k = 0; k < seg; k++) {
      const a0 = -Math.PI / 2 + (Math.PI * k) / seg, a1 = -Math.PI / 2 + (Math.PI * (k + 1)) / seg;
      const p0 = [cBow + rBow * Math.cos(a0), vMid + rBow * Math.sin(a0)], p1 = [cBow + rBow * Math.cos(a1), vMid + rBow * Math.sin(a1)];
      const du = p1[0] - p0[0], dv = p1[1] - p0[1], len = Math.hypot(du, dv), ry = Math.atan2(du, dv) - Math.PI / 2;
      const m = at((p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2, ry);
      addP(box(len + 0.02, DECK2 - DECK, 0.14, 0, DECK, 0), WOOD, m);
      if (k % 3 === 1) {
        // (the run turns about the bow anticlockwise: its outside is the box's -z)
        addP(new THREE.CircleGeometry(0.32, 14).rotateY(Math.PI).translate(0, 1.75, -0.075), [0.75, 0.74, 0.7, 0.4], m);
        addP(new THREE.CircleGeometry(0.26, 14).rotateY(Math.PI).translate(0, 1.75, -0.08), DARK, m);
      }
    }
    // the saloon's ceiling is the upper deck's slab (below)
  }
  // the terrace's columns and railing along the sea side, round the bow and along the south end
  const railLine = [];
  {
    const vR = vSea + 0.12;
    railLine.push([u0 + 0.3, vLand - 0.3], [u0 + 0.3, vR]);
    for (let u = u0 + 0.3; u <= u1 - rBow - 0.6; u += 1.5) railLine.push([u, seaEdgeAt(foot, u, vR - 0.12) + 0.12]);
    const cb = u1 - (vLand - vSea) / 2 - 0.2, rb = (vLand - vSea) / 2 - 0.15;
    for (let k = 0; k <= 8; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / 8;
      railLine.push([cb + rb * Math.cos(a), vc + rb * Math.sin(a)]);
    }
    railing(add, iron, railLine, DECK, 1.05);
    for (let u = u0 + 4; u < u1 - 3; u += 4.2) {
      add(iron, cyl(0.09, 0.09, DECK2 - DECK, 10, DECK), at(u, 0, seaEdgeAt(foot, u, vSea) + 0.45));
    }
  }

  // --- the upper deck: the slab over the whole hull, the bridge, the pavilion, railings ------------------------------
  const over = 0.35; // the slab's overhang on the sea side
  {
    const slab = new THREE.Shape();
    const ss = [];
    // the slab follows the hull outline pushed out a little on the sea side, and rounds the bow
    const bowC = u1 - W / 2, R = W / 2 + over;
    ss.push([u0 - 0.1, vLand + 0.1], [u0 - 0.1, vSea - over]);
    ss.push([bowC, vSea - over]);
    for (let k = 1; k < 12; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / 12;
      ss.push([bowC + R * Math.cos(a), vc + R * Math.sin(a)]);
    }
    ss.push([bowC, vLand + 0.1]);
    ss.forEach(([u, v], k) => (k ? slab.lineTo(u, -v) : slab.moveTo(u, -v)));
    const g = new THREE.ExtrudeGeometry(slab, { depth: SLAB, bevelEnabled: false, curveSegments: 12 }).rotateX(-Math.PI / 2).translate(0, DECK2, 0);
    add(white, g);
  }
  const Y2 = DECK2 + SLAB;
  const bridgeU0 = u0 + 0.45 * (u1 - u0); // the bridge covers the northern half and a little more
  {
    // plan: a rectangle from bridgeU0 to the bow, the bow a half round over the hull's width
    const R = W / 2 + 0.2, bowC = u1 - R + 0.4;
    const outline = [[bridgeU0, vLand], [bridgeU0, vSea - 0.2]];
    for (let k = 0; k <= 16; k++) {
      const a = -Math.PI / 2 + (Math.PI * k) / 16;
      outline.push([bowC + R * Math.cos(a), vc + R * Math.sin(a)]);
    }
    outline.push([bridgeU0 + 0.01, vLand]);
    // walls: parapet (white), the ribbon of windows (glass with white mullions), the fascia (white); the land side solid
    const yP = Y2 + 0.75, yW = Y2 + 2.35, yTop = BRIDGE;
    for (let k = 0; k + 1 < outline.length; k++) {
      const p0 = outline[k], p1 = outline[k + 1];
      const du = p1[0] - p0[0], dv = p1[1] - p0[1], len = Math.hypot(du, dv);
      if (len < 0.01) continue;
      const ry = Math.atan2(du, dv) - Math.PI / 2, m = at((p0[0] + p1[0]) / 2, 0, (p0[1] + p1[1]) / 2, ry);
      const landSide = Math.abs(dv) < 0.2 * len && p0[1] > vc + 0.5;
      add(white, box(len + 0.03, yP - Y2, 0.22, 0, Y2, 0), m);
      add(white, box(len + 0.03, yTop - yW, 0.22, 0, yW, 0), m);
      if (landSide) {
        // the land side: a run of windows in the white wall
        const n = Math.max(1, Math.round(len / 2.4));
        for (let q = 0; q < n; q++) {
          const w = len / n, x = -len / 2 + w * (q + 0.5);
          addP(box(w - 0.5, yW - yP - 0.3, 0.12, x, yP + 0.15, 0), GLASS, m);
          add(white, box(0.5, yW - yP, 0.22, x - w / 2 + 0.25, yP, 0), m);
          add(white, box(w - 0.5, 0.15, 0.22, x, yP, 0), m);
          add(white, box(w - 0.5, 0.15, 0.22, x, yW - 0.15, 0), m);
        }
      } else {
        addP(box(len + 0.02, yW - yP, 0.1, 0, yP, 0), GLASS, m);
        const n = Math.max(1, Math.round(len / 1.15));
        for (let q = 0; q <= n; q++) add(white, box(0.07, yW - yP, 0.14, -len / 2 + (len * q) / n, yP, 0), m);
      }
    }
    // the roof: a flat white slab with a slim projecting lip
    const roof = new THREE.Shape();
    outline.forEach(([u, v], k) => (k ? roof.lineTo(u, -v) : roof.moveTo(u, -v)));
    add(white, new THREE.ExtrudeGeometry(roof, { depth: 0.12, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, yTop, 0));

    // the mast: a white signal mast rising from the bridge roof, with a yard, a gaff and its stays
    const mu = bowC - 9.5, mv = vc;
    const top = yTop + 11.5;
    add(iron, cyl(0.07, 0.13, top - yTop, 10, yTop), at(mu, 0, mv));
    add(iron, new THREE.CylinderGeometry(0.05, 0.05, 5.2, 8).rotateX(Math.PI / 2).translate(0, yTop + 7.6, 0), at(mu, 0, mv));
    add(iron, new THREE.CylinderGeometry(0.04, 0.05, 3.2, 8).rotateZ(-1.05).translate(-1.3, yTop + 5.0, 0), at(mu, 0, mv));
    add(iron, new THREE.SphereGeometry(0.12, 8, 6).translate(0, top + 0.08, 0), at(mu, 0, mv));
    const stay = (a, b) => add(iron, beamBetween(a, b, 0.018));
    for (const [du, dv] of [[3.5, -W / 2], [3.5, W / 2], [-4.5, -W / 2], [-4.5, W / 2]]) stay([mu, top - 0.4, mv], [mu + du, yTop + 0.1, mv + dv]);
    stay([mu, yTop + 7.6, mv - 2.55], [mu, top - 0.6, mv]);
    stay([mu, yTop + 7.6, mv + 2.55], [mu, top - 0.6, mv]);
    // a pennant at the masthead, the club's ensign at the gaff's peak
    addP(new THREE.BoxGeometry(1.4, 0.35, 0.02).translate(-0.75, 0, 0), [0.6, 0.04, 0.05, 0.6], at(mu, top - 0.35, mv));
    addP(new THREE.BoxGeometry(1.1, 0.75, 0.02).translate(-0.6, 0, 0), [0.03, 0.08, 0.35, 0.6], at(mu - 2.7, yTop + 6.6, mv));
  }
  {
    // behind the bridge: a glazed pavilion on the open deck, then the deck open to the south end; white railings
    const pu0 = bridgeU0 - 13, pu1 = bridgeU0;
    const v0 = vSea + 1.0, v1 = vLand - 0.8, yR = Y2 + 2.6;
    for (const [a, b] of [[[pu0, v0], [pu1, v0]], [[pu0, v1], [pu1, v1]], [[pu0, v0], [pu0, v1]]]) {
      const du = b[0] - a[0], dv = b[1] - a[1], len = Math.hypot(du, dv), ry = Math.atan2(du, dv) - Math.PI / 2;
      const m = at((a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2, ry);
      addP(box(len, yR - Y2 - 0.1, 0.06, 0, Y2, 0), GLASS, m);
      const n = Math.max(1, Math.round(len / 1.6));
      for (let q = 0; q <= n; q++) add(iron, box(0.06, yR - Y2, 0.08, -len / 2 + (len * q) / n, Y2, 0), m);
      add(white, box(len + 0.3, 0.22, 0.4, 0, yR - 0.1, 0), m);
    }
    const pr = new THREE.Shape();
    [[pu0 - 0.2, v0 - 0.2], [pu1, v0 - 0.2], [pu1, v1 + 0.2], [pu0 - 0.2, v1 + 0.2]].forEach(([u, v], k) => (k ? pr.lineTo(u, -v) : pr.moveTo(u, -v)));
    add(white, new THREE.ExtrudeGeometry(pr, { depth: 0.18, bevelEnabled: false }).rotateX(-Math.PI / 2).translate(0, yR, 0));
    // the upper deck's railing: round the open deck from the bridge's sea corner to its land corner
    const rail = [[bridgeU0, vSea - 0.2], [u0 + 0.1, vSea - over + 0.1], [u0 + 0.1, vLand], [bridgeU0, vLand]];
    railing(add, iron, rail, Y2, 1.0);
  }

  const group = parts.build('KlubNautikoa');
  const painted = paint.build('KlubNautikoa:paint');
  if (painted) group.add(painted);
  group.name = 'KlubNautikoa';
  group.userData.hide = hide;
  return group;
}

// The sea face's v at u along the hull: the outline's smallest v there (null past its ends); `fallback` if none
function seaEdgeAt(foot, u, fallback = null) {
  let best = null;
  for (let i = 0, n = foot.length / 2; i < n; i++) {
    const j = (i + 1) % n, a = foot[2 * i], b = foot[2 * j];
    if ((a - u) * (b - u) > 0 || a === b) continue;
    const t = (u - a) / (b - a), v = foot[2 * i + 1] + (foot[2 * j + 1] - foot[2 * i + 1]) * t;
    if (best === null || v < best) best = v;
  }
  return best === null ? fallback : best;
}

// A box beam between two frame points, w thick
function beamBetween(a, b, w) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const len = d.length();
  const g = new THREE.BoxGeometry(w, w, len);
  g.lookAt(d);
  g.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
  return g;
}

// The white tubular railing: posts every ~1.5 m and three rails, along a polyline [[u, v], ...] standing on y
function railing(add, iron, line, y, h) {
  for (let k = 0; k + 1 < line.length; k++) {
    const [a0, b0] = line[k], [a1, b1] = line[k + 1];
    const len = Math.hypot(a1 - a0, b1 - b0);
    if (len < 0.02) continue;
    for (const f of [0.36, 0.7, 1.0]) add(iron, beamBetween([a0, y + h * f, b0], [a1, y + h * f, b1], f === 1.0 ? 0.06 : 0.04));
    const n = Math.max(1, Math.round(len / 1.5));
    for (let q = 0; q < n; q++) {
      const t = q / n;
      add(iron, box(0.045, h, 0.045, a0 + (a1 - a0) * t, y, b0 + (b1 - b0) * t));
    }
  }
  const [ua, va] = line[line.length - 1];
  add(iron, box(0.045, h, 0.045, ua, y, va));
}
