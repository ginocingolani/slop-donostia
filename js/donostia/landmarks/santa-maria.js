import * as THREE from 'three/webgpu';
import { float, vec3, abs, fract, mix, smoothstep, positionWorld, normalWorld, mx_noise_float } from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { Parts, wound, cleanRing, insetRing, hipRoof, distToRing } from './geom.js';

// js/donostia/landmarks/santa-maria.js
// Basílica de Santa María del Coro (1743-74, baroque): sandstone church at the end of Kale Nagusia at the foot of Urgull, a huge niche portal with a sculpted St Sebastian, one bell tower, the nave aligned towards the Buen Pastor cathedral.
//
// build(sites, ctx) receives the GEO.landmarks entries ['santa-maria'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// Pedro Ignacio Lizardi & Miguel de Salazar's church (1743-74) is a hall of three naves, 48 x 33 m inside, its central
// vault over 27 m high (Wikipedia). Its main front is a retablo-like portal "entre las dos torres": a tall frontispiece
// whose great arched niche holds the door and the martyred St Sebastian, crowned by the city's arms, between the
// bell tower on the west and a slimmer tower on the east. The OSM outline (way 27263141) gives the front's line, facing
// up Kale Nagusia to the Buen Pastor, and its widths: the bell tower 6.4 m, the niche 7.8 m, the east tower 4.5 m.
// Heights fit b5m's LiDAR (roofs averaging ~33 m above sea level, ~39 m at the most) and the 27 m vault: eaves 21 m
// above the portal's step and a hip roof to 29 m. The 1:500 outline adds a lower sacristy wing to the east, built to
// 13 m. The front follows the photographs (Wikimedia Commons: Kale Nagusia views, portal details): golden sandstone; the
// niche's arch tops out under a main cornice at ~18 m that runs across both towers; over it a gable with curving sides
// holds an oval window, St Sebastian bound before an arched window and the clock, and carries the city's arms at ~29 m;
// the towers rise through a pilastered stage to belfries over the gable's shoulders, the west one on to a lantern and
// a bulbous cupola, ball and cross at ~37 m (the LiDAR misses such slender tops).

// The front's line between the towers' outer corners (OSM vertices), west to east
const FRONT = [[156.0, -267.95], [176.27, -273.94]];
const WEST_TOWER = [-10.57, -4.2], NICHE = [-3.63, 4.18], EAST_TOWER = [6.02, 10.57]; // metres along the front
const EAVE = 21, RIDGE = 29, WING = 13;
const CORNICE = 18.2, GABLE_TOP = 27.8; // the main cornice over the niche, the gable's crown under the arms

// --- materials --------------------------------------------------------------------------------------------------------

// stoneMaterial() of js/donostia/landmarks/kit.js (ashlar courses on vertical faces) plus the floodlights that light
// the front from the street at dusk and night, strongest low down
function floodlitStone(rgb, { courses = 0.55, grain = 0.12, floodBase = 0, floodTop = 30 } = {}) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.82, metalness: 0 });
  const n = mx_noise_float(positionWorld.mul(0.9));
  const base = vec3(...rgb).mul(float(1).sub(grain).add(n.mul(grain)));
  const joint = smoothstep(0.0, 0.025, abs(fract(positionWorld.y.div(courses)).sub(0.5)).sub(0.47)).oneMinus();
  const vertical = smoothstep(0.6, 0.3, abs(normalWorld.y));
  const stone = mix(base, base.mul(0.62), joint.mul(vertical));
  mat.colorNode = stone;
  const night = smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);
  const flood = smoothstep(float(floodTop), float(floodBase), positionWorld.y).mul(0.55).add(0.45);
  mat.emissiveNode = stone.mul(vec3(1.0, 0.82, 0.6)).mul(night.mul(flood).mul(0.75));
  return mat;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const { GEO, kit } = ctx;
  const site = sites[0];
  if (!site.footprint) return null;
  const footprint = cleanRing(site.footprint);
  // FRONT is fixed in world coordinates (OSM's vertices as fetched): if the outline no longer runs through both its
  // ends, the portal would stand detached from the church, so keep the plain extrusion instead
  if (FRONT.some(([x, z]) => distToRing(x, z, footprint) > 1.5)) return null;
  const outline = site.buildings?.length ? cleanRing(GEO.buildings[site.buildings[0]].g[0]) : footprint;

  // the front's frame: s along the front (west to east), t out into the street, y up from the portal's step
  const [[x0, z0], [x1, z1]] = FRONT;
  const flen = Math.hypot(x1 - x0, z1 - z0);
  const e = new THREE.Vector3((x1 - x0) / flen, 0, (z1 - z0) / flen);
  const n = new THREE.Vector3(-e.z, 0, e.x); // e × up: out of the church, up Kale Nagusia
  const mid = [(x0 + x1) / 2, (z0 + z1) / 2];
  const G = kit.groundAt(ctx, mid[0] + n.x * 3, mid[1] + n.z * 3);
  const basis = new THREE.Matrix4().makeBasis(e, new THREE.Vector3(0, 1, 0), n);
  const F = (s, y, t, rotY = 0) => {
    const m = basis.clone().setPosition(mid[0] + e.x * s + n.x * t, G + y, mid[1] + e.z * s + n.z * t);
    return rotY ? m.multiply(new THREE.Matrix4().makeRotationY(rotY)) : m;
  };
  // box of size (w along the front, h, d out from it) whose base centre stands at (s, y, t) in the front's frame
  const box = (w, h, d, s, y, t) => new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0).applyMatrix4(F(s, y, t));
  // half disc standing in the front's plane, flat side down (arched heads of doors & openings)
  const archHead = (r, d) => new THREE.CylinderGeometry(r, r, d, 14, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2);

  const wall = floodlitStone([0.62, 0.5, 0.33], { floodBase: G, floodTop: G + 12 });
  const front = floodlitStone([0.72, 0.56, 0.33], { floodBase: G, floodTop: G + 32 });
  const glass = kit.materials.glass;
  const tiles = kit.materials.terracotta;
  const lead = kit.materials.slate;
  const dark = kit.materials.dark;
  const parts = new Parts();

  // the hall and the sacristy wing, down to the lowest ground (the church is dug into Urgull's foot on the north)
  const base = kit.lowestGround(ctx, outline) - 0.6;
  parts.add(wall, kit.prism(outline, base, G + WING));
  parts.add(wall, kit.prism(footprint, base, G + EAVE));
  const cornice = insetRing(wound(footprint), -0.4);
  if (cornice) parts.add(wall, kit.prism(cornice, G + EAVE - 0.7, G + EAVE));
  const eaves = insetRing(wound(footprint), -0.6) || footprint;
  parts.add(tiles, hipRoof(eaves, G + EAVE, RIDGE - EAVE, kit.orientedBox(footprint).width * 0.46));

  // Frontispiece between the towers: a slab with the great arched niche cut through it, standing out of OSM's line
  // so the niche reads deep; its back is a stone screen standing clear of the 1:500 walls, which jut forward there
  const [ns0, ns1] = NICHE;
  const nc = (ns0 + ns1) / 2, archR = (ns1 - ns0) / 2 - 0.55, spring = 14.2;
  const slabS0 = WEST_TOWER[1] - 0.3, slabS1 = EAST_TOWER[0] + 0.3;
  const front0 = 1.6; // the slab's face, metres out from OSM's line
  const back = 0.35; // the niche's back
  const shape = new THREE.Shape();
  shape.moveTo(slabS0, -0.6);
  shape.lineTo(nc - archR, -0.6);
  shape.lineTo(nc - archR, spring);
  shape.absarc(nc, spring, archR, Math.PI, 0, true);
  shape.lineTo(nc + archR, -0.6);
  shape.lineTo(slabS1, -0.6);
  shape.lineTo(slabS1, CORNICE);
  shape.lineTo(slabS0, CORNICE);
  shape.lineTo(slabS0, -0.6);
  parts.addAt(front, new THREE.ExtrudeGeometry(shape, { depth: front0 + 1.0, bevelEnabled: false, curveSegments: 16 }), F(0, 0, -1.0));
  // (in the plain stone: the floodlights leave the niche's depth in shadow, so it reads at night)
  parts.add(wall, box(2 * archR + 0.4, spring + archR + 0.2, 0.3, nc, -0.6, back - 0.15));
  // the arch's moulded archivolt, standing proud of the slab
  for (let k = 0; k < 12; k++) {
    const a0 = Math.PI - (k * Math.PI) / 12, a1 = Math.PI - ((k + 1) * Math.PI) / 12, am = (a0 + a1) / 2;
    const r = archR + 0.35, len = 2 * r * Math.sin(Math.PI / 24) + 0.05;
    parts.add(front, new THREE.BoxGeometry(len, 0.7, 0.4).rotateZ(am - Math.PI / 2)
      .translate(nc + r * Math.cos(am), spring + r * Math.sin(am), front0 + 0.2).applyMatrix4(F(0, 0, 0)));
  }
  // pilasters framing the niche, the impost at the arch's spring, the main cornice across the towers
  for (const s of [nc - archR - 0.45, nc + archR + 0.45]) parts.add(front, box(0.7, CORNICE - 1.0, 0.35, s, 0.4, front0 + 0.1));
  for (const [s0, s1] of [[slabS0, nc - archR], [nc + archR, slabS1]]) {
    parts.add(front, box(s1 - s0, 0.6, 0.6, (s0 + s1) / 2, spring - 0.6, front0 + 0.1));
  }
  parts.add(front, box(EAST_TOWER[1] - WEST_TOWER[0] + 1.0, 0.85, 1.1, (WEST_TOWER[0] + EAST_TOWER[1]) / 2, CORNICE - 0.35, front0 + 0.05));
  // in the niche: the door with its arched head, the retablo's columns either side and the Assumption in her niche
  // over the door (photographs: Wikimedia Commons, Kale Nagusia views & portal details)
  parts.add(dark, box(2.8, 5.0, 0.2, nc, -0.2, back + 0.1));
  parts.addAt(dark, archHead(1.4, 0.2), F(nc, 4.8, back + 0.1));
  for (const s of [nc - 2.35, nc - 1.75, nc + 1.75, nc + 2.35]) {
    parts.addAt(front, new THREE.CylinderGeometry(0.2, 0.22, 6.4, 10).translate(0, 3.2, 0), F(s, 0.4, back + 0.5));
  }
  parts.add(front, box(5.6, 0.6, 0.9, nc, 6.8, back + 0.45));
  parts.add(dark, box(1.6, 2.6, 0.2, nc, 7.6, back + 0.1));
  parts.addAt(dark, archHead(0.8, 0.2), F(nc, 10.2, back + 0.1));
  parts.addAt(front, new THREE.CylinderGeometry(0.3, 0.42, 1.9, 10).translate(0, 0.95, 0), F(nc, 7.6, back + 0.45));
  parts.addAt(front, new THREE.SphereGeometry(0.24, 10, 8).translate(0, 2.15, 0), F(nc, 7.6, back + 0.45));
  // the Holy Spirit's glory of rays high in the niche
  parts.addAt(front, new THREE.CylinderGeometry(1.5, 1.7, 0.35, 16).rotateX(Math.PI / 2), F(nc, spring + 0.8, back + 0.2));

  // The gable over the main cornice: its sloping, curving sides rise from the towers to the city's arms; in it, from
  // the bottom, the oval window (with the arms of the Virgin), St Sebastian bound before an arched window, the clock
  const g0 = CORNICE + 0.5, gs0 = WEST_TOWER[1] + 0.1, gs1 = EAST_TOWER[0] - 0.1;
  const gable = new THREE.Shape();
  gable.moveTo(gs0, 0);
  gable.lineTo(gs1, 0);
  gable.lineTo(gs1, 4.6);
  gable.quadraticCurveTo(nc + 2.2, 6.6, nc, GABLE_TOP - g0);
  gable.quadraticCurveTo(nc - 2.2, 6.6, gs0, 4.6);
  gable.lineTo(gs0, 0);
  parts.addAt(front, new THREE.ExtrudeGeometry(gable, { depth: 1.4, bevelEnabled: false, curveSegments: 8 }), F(0, g0, front0 - 1.4));
  // its moulded coping
  const copeAt = (t) => {
    const q = (a, b, c) => (1 - t) * (1 - t) * a + 2 * (1 - t) * t * b + t * t * c;
    return [q(gs1, nc + 2.2, nc), q(4.6, 6.6, GABLE_TOP - g0)];
  };
  for (const side of [1, -1]) {
    for (let k = 0; k < 6; k++) {
      const [sa, ya] = copeAt(k / 6), [sb, yb] = copeAt((k + 1) / 6);
      const a = [nc + side * (sa - nc), ya], b = [nc + side * (sb - nc), yb];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) + 0.1;
      parts.add(front, new THREE.BoxGeometry(len, 0.45, 1.7).rotateZ(Math.atan2(b[1] - a[1], b[0] - a[0]))
        .translate((a[0] + b[0]) / 2, g0 + (a[1] + b[1]) / 2 + 0.15, front0 - 0.65).applyMatrix4(F(0, 0, 0)));
    }
  }
  // volutes at the gable's feet
  for (const s of [gs0 + 0.6, gs1 - 0.6]) {
    parts.addAt(front, new THREE.CylinderGeometry(0.75, 0.75, 1.0, 12).rotateX(Math.PI / 2), F(s, g0 + 0.75, front0 - 0.3));
  }
  const oval = new THREE.CylinderGeometry(0.85, 0.85, 0.2, 18).scale(0.85, 1, 1.2).rotateX(Math.PI / 2);
  parts.addAt(front, new THREE.CylinderGeometry(1.15, 1.15, 0.4, 18).scale(0.85, 1, 1.2).rotateX(Math.PI / 2), F(nc, g0 + 1.3, front0 + 0.05));
  parts.addAt(glass, oval, F(nc, g0 + 1.3, front0 + 0.22));
  // the arched window, its frame, the bracket and St Sebastian bound to the tree, arms raised
  const w0 = g0 + 2.9, wr = 0.75;
  parts.add(front, box(2.3, 2.2, 0.3, nc, w0 - 0.2, front0 + 0.12));
  parts.addAt(front, archHead(1.15, 0.3), F(nc, w0 + 2.0, front0 + 0.12));
  parts.add(glass, box(2 * wr, 2.0, 0.1, nc, w0, front0 + 0.3));
  parts.addAt(glass, archHead(wr, 0.1), F(nc, w0 + 2.0, front0 + 0.3));
  parts.add(front, box(2.2, 0.35, 1.0, nc, w0 - 0.35, front0 + 0.6));
  parts.addAt(front, new THREE.CylinderGeometry(0.1, 0.12, 2.6, 6).translate(0, 1.3, 0), F(nc, w0, front0 + 0.55));
  parts.addAt(front, new THREE.CylinderGeometry(0.2, 0.17, 1.15, 10).translate(0, 0.58, 0), F(nc, w0, front0 + 0.8));
  parts.addAt(front, new THREE.CylinderGeometry(0.24, 0.2, 0.75, 10).translate(0, 1.5, 0), F(nc, w0, front0 + 0.8));
  parts.addAt(front, new THREE.SphereGeometry(0.17, 10, 8).translate(0, 2.08, 0), F(nc, w0, front0 + 0.8));
  for (const side of [-1, 1]) {
    parts.addAt(front, new THREE.CylinderGeometry(0.06, 0.07, 0.75, 6).rotateZ(side * 0.5).translate(side * 0.2, 2.15, 0), F(nc, w0, front0 + 0.75));
  }
  // the clock under the gable's top
  parts.addAt(front, new THREE.CylinderGeometry(1.0, 1.0, 0.35, 20).rotateX(Math.PI / 2), F(nc, GABLE_TOP - 2.0, front0 - 0.2));
  parts.addAt(kit.materials.whiteIron, new THREE.CylinderGeometry(0.8, 0.8, 0.1, 20).rotateX(Math.PI / 2), F(nc, GABLE_TOP - 2.0, front0 + 0.0));
  // the crown: the city's arms (the ship) in a carved frame under a crown, urns on the gable's feet
  parts.add(front, box(2.0, 1.9, 0.6, nc, GABLE_TOP - 0.2, front0 - 0.85));
  parts.add(glass, box(1.2, 1.2, 0.1, nc, GABLE_TOP + 0.2, front0 - 0.5));
  parts.addAt(front, new THREE.CylinderGeometry(0.75, 0.55, 0.6, 10).translate(0, 0.3, 0), F(nc, GABLE_TOP + 1.7, front0 - 0.85));
  for (const s of [nc - 1.3, nc + 1.3]) {
    parts.addAt(front, new THREE.CylinderGeometry(0.22, 0.45, 1.6, 8).translate(0, 0.8, 0), F(s, GABLE_TOP - 0.1, front0 - 0.85));
  }

  // The towers: square shafts up to the main cornice, a tall stage with corner pilasters, a belfry with an arched
  // opening (and its bell) in each face and urns on its corners, then on the west tower a lantern, its bulbous cupola,
  // ball and cross (to ~36 m, past the gable's crown), and on the slimmer east tower a stepped top with a ball
  const towers = [{ s: WEST_TOWER, stage: 25.2, belfry: 30.0, lantern: true }, { s: EAST_TOWER, stage: 24.6, belfry: 28.8, lantern: false }];
  for (const t of towers) {
    const w = t.s[1] - t.s[0], sc = (t.s[0] + t.s[1]) / 2, tc = front0 + 0.2 - w / 2;
    parts.add(front, box(w, CORNICE + 1.0, w, sc, -0.6, tc));
    // the stage over the cornice, with pilasters on its corners and a cornice of its own
    const sw = w - 0.4, s0 = CORNICE + 0.5;
    parts.add(front, box(sw, t.stage - s0, sw, sc, s0, tc));
    for (const [ds, dt] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      parts.add(front, box(0.7, t.stage - s0, 0.7, sc + ds * (sw / 2 - 0.2), s0, tc + dt * (sw / 2 - 0.2)));
    }
    parts.add(front, box(sw + 0.9, 0.7, sw + 0.9, sc, t.stage, tc));
    // the belfry, its corners chamfered (an octagon of short diagonal faces)
    const bw = sw - 0.5, b0 = t.stage + 0.7;
    const oct = new THREE.CylinderGeometry(bw / 2 / Math.cos(Math.PI / 8), bw / 2 / Math.cos(Math.PI / 8), t.belfry - b0, 8)
      .rotateY(Math.PI / 8).translate(0, (t.belfry - b0) / 2, 0);
    parts.addAt(front, oct, F(sc, b0, tc));
    const oh = (t.belfry - b0) * 0.62, ow = Math.min(1.8, bw * 0.4), oy = b0 + 0.6;
    const o = bw / 2 + 0.02;
    for (const [ds, dt, rot] of [[0, o, 0], [0, -o, 0], [o, 0, Math.PI / 2], [-o, 0, Math.PI / 2]]) {
      parts.addAt(dark, new THREE.BoxGeometry(ow, oh, 0.2).translate(0, oh / 2, 0), F(sc + ds, oy, tc + dt, rot));
      parts.addAt(dark, archHead(ow / 2, 0.2).translate(0, oh, 0), F(sc + ds, oy, tc + dt, rot));
    }
    parts.addAt(lead, new THREE.CylinderGeometry(0.25, 0.6, 1.0, 10).translate(0, 0.5, 0), F(sc, oy + 0.9, tc + o - 0.5));
    const top = t.belfry;
    parts.add(front, box(bw + 0.9, 0.6, bw + 0.9, sc, top, tc));
    // urns on the corners
    for (const [ds, dt] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      parts.addAt(front, new THREE.CylinderGeometry(0.22, 0.32, 0.8, 8).translate(0, 0.4, 0), F(sc + ds * (bw / 2 + 0.15), top + 0.6, tc + dt * (bw / 2 + 0.15)));
      parts.addAt(front, new THREE.SphereGeometry(0.28, 10, 8).translate(0, 1.0, 0), F(sc + ds * (bw / 2 + 0.15), top + 0.6, tc + dt * (bw / 2 + 0.15)));
    }
    const y = top + 0.6;
    if (t.lantern) {
      // stepped octagonal base, the lantern with its openings, a bulbous lead cupola, ball and cross
      const r1 = bw * 0.42, r2 = bw * 0.3;
      parts.addAt(front, new THREE.CylinderGeometry(r1, r1 + 0.3, 1.0, 8).rotateY(Math.PI / 8).translate(0, 0.5, 0), F(sc, y, tc));
      parts.addAt(front, new THREE.CylinderGeometry(r2, r2, 2.0, 8).rotateY(Math.PI / 8).translate(0, 1.0, 0), F(sc, y + 1.0, tc));
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2;
        parts.addAt(dark, new THREE.BoxGeometry(0.5, 1.2, 0.12).translate(0, 0.6, r2 * Math.cos(Math.PI / 8) + 0.01).rotateY(a), F(sc, y + 1.4, tc));
      }
      parts.addAt(front, new THREE.CylinderGeometry(r2 + 0.25, r2 + 0.25, 0.3, 8).rotateY(Math.PI / 8).translate(0, 0.15, 0), F(sc, y + 3.0, tc));
      const bulb = [[r2 + 0.1, 0], [r2 + 0.25, 0.4], [r2 * 0.8, 1.1], [0.35, 1.6], [0.22, 1.9], [0.36, 2.15], [0.22, 2.45], [0.06, 2.6]]
        .map(([r, h]) => new THREE.Vector2(r, h));
      parts.addAt(lead, new THREE.LatheGeometry(bulb, 12), F(sc, y + 3.3, tc));
      parts.addAt(lead, new THREE.SphereGeometry(0.3, 10, 8).translate(0, 0.3, 0), F(sc, y + 5.9, tc));
      parts.addAt(lead, new THREE.BoxGeometry(0.08, 1.5, 0.08).translate(0, 0.75, 0), F(sc, y + 6.4, tc));
      parts.addAt(lead, new THREE.BoxGeometry(0.7, 0.08, 0.08), F(sc, y + 7.4, tc));
    } else {
      parts.addAt(front, new THREE.CylinderGeometry(bw * 0.3, bw * 0.45, 0.9, 8).rotateY(Math.PI / 8).translate(0, 0.45, 0), F(sc, y, tc));
      parts.addAt(lead, new THREE.ConeGeometry(bw * 0.3, 1.4, 8).rotateY(Math.PI / 8).translate(0, 0.7, 0), F(sc, y + 0.9, tc));
      parts.addAt(lead, new THREE.SphereGeometry(0.3, 10, 8).translate(0, 0.3, 0), F(sc, y + 2.2, tc));
    }
  }

  const group = parts.build('santa-maria');
  group.userData.front = { x: mid[0], z: mid[1], y: G, facing: [n.x, n.z] };
  return group;
}
