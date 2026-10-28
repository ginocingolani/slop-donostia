import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Fn, float, vec3, vec4, uniform, attribute, varying, uv, positionGeometry, cameraPosition, cameraProjectionMatrix,
  screenSize, normalize, length, cross, select, abs, max, min, exp, fract, atan, sin, smoothstep, clamp, mix, mrt
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { SEAMARKS } from './data-seamarks.js';
import { seamarkClock, freezeSeamarkClock, RISE, FALL } from './seamark-timing.js';

// js/donostia/seamarks.js
// The aids to navigation (js/donostia/data-seamarks.js, baked by tools/donostia/bake-seamarks.mjs from OpenStreetMap's
// seamark tags and checked against NGA Pub. 113, List of Lights; ODbL / U.S. Government work):
//   - Igeldo, Fl(2+1) W 15 s, 26 nm, and Santa Klara, Fl W 5 s, 9 nm: their lanterns are the landmark models'
//     (js/donostia/landmarks/igeldo.js, santa-klara.js), which report their focal planes (userData.seamark) and keep
//     the lantern glass and Igeldo's sweeping beams in step with the glows here;
//   - La Concha's leading lights on the promenade, 158°: the front one Q R on a 16 ft grey post, the rear one Oc R 4 s
//     on a 30 ft post 25 m behind it across the road, so from the bay's entrance on the line the rear shows above the
//     front;
//   - the port's pierhead lights, Fl(2) G 8 s on the marina's mole and Fl(2) R 8 s on the west mole, on painted columns;
//   - the buoys off Ulía: Mompás outfall's yellow pillar (Fl Y 5 s, an X topmark) and Pasaia's fairway buoy (Mo(A) W
//     7 s, red & white stripes, a red ball), riding the tide.
// Every light is one quad of a single instanced draw: a glow facing the camera, its character timed in the vertex
// shader from the lights' clock (js/donostia/seamark-timing.js: real seconds, whatever the frame rate), a revolving
// optic's flashes reaching each bearing as its beams do. It shows at dusk and night (cityUniforms.uInteriorGlow) and
// not by day; none of these lights is lit by day. Seen from afar it keeps a few pixels' core and a halo that grows
// with the light's range, dimming towards the edge of that range; close up it is the lantern's size. A lantern seen
// from well above its horizontal is dimmer, a revolving optic's flashes much more so (its beams are flat). A light
// with a sector shows only within it (none here: see the bake). The posts, columns and buoys are a second draw.
// buildSeamarks(terrain, { seaLevel, landmarks }) -> Object3D; userData.update(dt, elapsed, camera) runs every frame,
// userData.freeze(t) stops the lights' clock at t s (null runs it again), for renders of a flash.

const NM = 1852; // m
const COLOUR = { white: [1.0, 0.86, 0.68], red: [1.0, 0.07, 0.03], green: [0.08, 1.0, 0.42], yellow: [1.0, 0.62, 0.06] };
// A light's glow: the core's radius at least CORE_PX on screen, the halo's at least HALO_PX times the light's
// strength (the square root of its range in units of 7 nm); close up both are the lantern's size (m) times CORE_M
// and HALO_M
const CORE_PX = 2.2, HALO_PX = 12;
const CORE_M = 0.6, HALO_M = 3.2;
const CORE_GAIN = 14, HALO_GAIN = 1.3;
const BEAM_SPREAD = 0.2; // rad: a revolving optic's beams, either side of its horizontal plane
const HEAVE = 0.14; // m: a buoy rising and falling on the swell

// What carries each kind of light (m): the lanterns' radii, the posts', columns' and buoys' parts
const LANTERN = { post: 0.15, column: 0.2, buoy: 0.14 };
const PAINT = {
  grey: 0x8b8f91, green: 0x16703a, red: 0xb0241c, white: 0xebeae4, yellow: 0xe3b512, dark: 0x25292c, glass: 0x3a4044
};

// --- the glows -----------------------------------------------------------------------------------------------------------

const night = () => smoothstep(0.55, 1.2, cityUniforms.uInteriorGlow);

function createGlowMaterial(uClock, seaLevel) {
  const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  mat.fog = false; // the haze would add its colour too: the glows dim with distance themselves
  // as the lighthouses' flares (js/donostia/landmarks/igeldo.js): leave the normal & metalness buffers the SSR pass reads
  mat.mrtNode = mrt({ normal: vec4(0.0), metalRough: vec4(0.0) });
  const P = attribute('aSeamarkPos', 'vec4'); // x, y, z of the focal plane, lantern radius (m)
  const C = attribute('aSeamarkColour', 'vec4'); // linear rgb, range (nm)
  const T = attribute('aSeamarkTime', 'vec4'); // period, phase (s), rotating (0 | 1), floating (0 | 1)
  const A = attribute('aSeamarkOnA', 'vec4'); // on spans: [start, end, start, end] (s into the period; unused < 0)
  const B = attribute('aSeamarkOnB', 'vec4');
  const S = attribute('aSeamarkSector', 'vec4'); // sector [from, to] (true bearings from seaward, °; from < 0: all round)

  // Per light, in the vertex stage (the quad's corners all agree): plain node expressions, shared by the position and
  // the varyings
  const period = T.x, rotating = T.z.greaterThan(0.5);
  // a buoy rides the tide and the swell, as its pillar does (createCarrierMaterial)
  const heave = sin(uClock.mul(0.9).add(P.x.mul(0.37))).mul(HEAVE).add(seaLevel).mul(T.w);
  const centre = P.xyz.add(vec3(0.0, heave, 0.0));
  const toCam = cameraPosition.sub(centre);
  const dist = max(length(toCam), 0.01);
  const elevation = atan(toCam.y, max(length(toCam.xz), 0.01));
  // the character, as lightLevel() in seamark-timing.js: the spans either side of this period too
  const psi = atan(toCam.z, toCam.x);
  const tau = uClock.add(T.y).sub(select(rotating, psi.mul(period).div(2 * Math.PI), float(0.0)));
  const p = fract(tau.div(period)).mul(period);
  const span = (a, b) => {
    const m = a.add(b).mul(0.5), w = max(b.sub(a).mul(0.5), 0.001);
    const one = (q) => select(rotating, exp(q.sub(m).div(w).pow(2).negate()),
      clamp(q.sub(a).add(RISE).div(2 * RISE), 0.0, 1.0).mul(clamp(b.sub(q).add(FALL).div(2 * FALL), 0.0, 1.0)));
    return select(a.lessThan(0.0), float(0.0), one(p.sub(period)).add(one(p)).add(one(p.add(period))));
  };
  const timed = min(span(A.x, A.y).add(span(A.z, A.w)).add(span(B.x, B.y)).add(span(B.z, B.w)), 1.0);
  // a revolving optic's flashes are its beams, flat; between them its lamp glows faintly behind the lens, close up. A
  // lantern seen from well above is dimmer.
  const beam = exp(elevation.div(BEAM_SPREAD).pow(2).negate());
  const lamp = smoothstep(700.0, 150.0, dist).mul(0.07);
  const lantern = mix(float(0.35), float(1.0), exp(elevation.div(0.35).pow(2).negate()));
  const shown = select(rotating, max(timed.mul(beam), lamp), timed.mul(lantern));
  // a sector light shows within its sector: the light's bearing from the viewer, clockwise from S.x to S.y
  const bearing = atan(toCam.x.negate(), toCam.z).mul(180 / Math.PI).add(360.0);
  const rel = fract(bearing.sub(S.x).div(360.0)).mul(360.0), width = fract(S.y.sub(S.x).add(360.0).div(360.0)).mul(360.0);
  const inSector = select(S.x.lessThan(0.0), float(1.0), smoothstep(width.add(0.4), width.sub(0.4), rel));
  // dimmer towards the edge of its range (nm), off by day
  const fade = exp(dist.div(C.w.mul(NM * 0.8)).pow(2).negate());
  const strength = C.w.div(7.0).sqrt();
  const on = shown.mul(inSector).mul(fade).mul(night());
  // the quad: the halo's radius, the lantern's size close up and never under its pixels on screen; folded away while
  // the light is dark
  const pxPerM = cameraProjectionMatrix.element(1).y.mul(screenSize.y).mul(0.5).div(dist);
  const halo = max(P.w.mul(HALO_M), float(HALO_PX).mul(strength).div(pxPerM));
  const coreM = max(P.w.mul(CORE_M), float(CORE_PX).div(pxPerM));
  const level = varying(on.mul(strength), 'vSeamarkLevel');
  const core = varying(coreM.div(halo), 'vSeamarkCore');

  mat.positionNode = Fn(() => {
    const size = select(on.greaterThan(0.002), halo, float(0.0));
    const dir = toCam.div(dist).toVar();
    const pole = select(abs(dir.y).greaterThan(0.99), vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0));
    const right = normalize(cross(pole, dir)).toVar(), up = cross(dir, right);
    // in front of its own lantern (the glass would hide it) and of what stands just before it (a lighthouse's house
    // would cut its halo, which is glare, not a lit object), never past half way to the camera
    const front = centre.add(dir.mul(min(max(P.w.add(0.6), halo.mul(0.75)), dist.mul(0.5))));
    return front.add(right.mul(positionGeometry.x.mul(size))).add(up.mul(positionGeometry.y.mul(size)));
  })();

  mat.colorNode = Fn(() => {
    const r = length(uv().sub(0.5)).mul(2.0);
    const glow = exp(r.div(core.max(0.001)).pow(2).mul(-1.6)).mul(CORE_GAIN).add(clamp(float(1.0).sub(r), 0.0, 1.0).pow(2.6).mul(HALO_GAIN));
    return C.xyz.mul(glow).mul(level);
  })();
  mat.opacityNode = float(1.0);
  return mat;
}

function glowMesh(lights, uClock, seaLevel) {
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(2, 2);
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  geo.setIndex(quad.index);
  const n = lights.length;
  const arrays = { Pos: [], Colour: [], Time: [], OnA: [], OnB: [], Sector: [] };
  for (const l of lights) {
    arrays.Pos.push(l.at.x, l.at.y, l.at.z, l.lantern);
    arrays.Colour.push(...COLOUR[l.colour], l.range);
    arrays.Time.push(l.period, l.phase, l.rotating ? 1 : 0, l.mount.kind === 'buoy' ? 1 : 0);
    const on = [...l.on];
    while (on.length < 8) on.push(-1, -1);
    arrays.OnA.push(...on.slice(0, 4));
    arrays.OnB.push(...on.slice(4, 8));
    arrays.Sector.push(...(l.sector || [-1, -1]), 0, 0);
  }
  for (const [name, values] of Object.entries(arrays)) {
    geo.setAttribute(`aSeamark${name}`, new THREE.InstancedBufferAttribute(new Float32Array(values), 4));
  }
  geo.instanceCount = n;
  const mesh = new THREE.Mesh(geo, createGlowMaterial(uClock, seaLevel));
  mesh.name = 'Seamark_lights';
  mesh.frustumCulled = false; // the quads are placed in the shader
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = 3; // after the sea & sky (main.js), with the other glows
  return mesh;
}

// --- what carries them ---------------------------------------------------------------------------------------------------

// Parts merged into one mesh: position, normal, colour, and aSeamarkFloat (1 on a buoy: it rides the sea; its x)
class Parts {
  constructor() {
    this.geos = [];
  }

  add(geo, hex, x, y, z, { floating = false, rotateY = 0 } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (rotateY) g.rotateY(rotateY);
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    const n = g.attributes.position.count, c = new THREE.Color(hex);
    const colour = new Float32Array(n * 3), float2 = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      colour.set([c.r, c.g, c.b], i * 3);
      float2.set([floating ? 1 : 0, x], i * 2);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colour, 3));
    g.setAttribute('aSeamarkFloat', new THREE.BufferAttribute(float2, 2));
    this.geos.push(g);
  }

  // an upright cylinder from y0 to y1 at (x, z), radii r0 at the bottom and r1 at the top
  cylinder(x, z, r0, r1, y0, y1, hex, opts) {
    this.add(new THREE.CylinderGeometry(r1, r0, y1 - y0, 16), hex, x, (y0 + y1) / 2, z, opts);
  }

  build() {
    return this.geos.length ? mergeGeometries(this.geos, false) : null;
  }
}

// A light's lantern on top of its carrier: a dark base, the glass round the focal plane, a cap
function lantern(parts, x, y, z, r, opts) {
  parts.cylinder(x, z, r * 1.1, r * 1.1, y - 0.3, y - 0.17, PAINT.dark, opts);
  parts.cylinder(x, z, r, r, y - 0.17, y + 0.17, PAINT.glass, opts);
  parts.cylinder(x, z, r * 1.15, 0.03, y + 0.17, y + 0.32, PAINT.dark, opts);
}

// The posts, columns and buoys that carry the lights, and where each light's focal plane is. A lighthouse's comes
// from its model (anchors: ref -> { x, y, z, radius }); without one it stands at its charted place and elevation.
function carriers(lights, terrain, anchors) {
  const parts = new Parts();
  for (const l of lights) {
    const { x, z, mount } = l;
    const ground = terrain.heightAt(x, z);
    if (mount.kind === 'lighthouse') {
      const a = anchors.get(l.ref);
      l.at = a ? { x: a.x, y: a.y, z: a.z } : { x, y: l.height, z };
      l.lantern = a ? a.radius : 1.0;
    } else if (mount.kind === 'post') {
      // a grey steel post of the charted height, the lantern at its top
      const r = LANTERN.post, y = ground + mount.height - 0.32;
      parts.cylinder(x, z, 0.11, 0.08, ground - 0.3, y - 0.3, PAINT.grey);
      parts.cylinder(x, z, 0.2, 0.2, ground - 0.3, ground + 0.12, PAINT.grey); // its foot
      lantern(parts, x, y, z, r);
      l.at = { x, y, z };
      l.lantern = r;
    } else if (mount.kind === 'column') {
      // a round concrete column on the pierhead in the side's colour, a white band under the lantern, up to the
      // charted elevation
      const r = LANTERN.column, y = Math.max(l.height, ground + 2.5);
      parts.cylinder(x, z, 0.42, 0.34, ground - 0.4, y - 0.95, PAINT[mount.colour] ?? PAINT.white);
      parts.cylinder(x, z, 0.36, 0.36, y - 0.95, y - 0.6, PAINT.white);
      parts.cylinder(x, z, 0.5, 0.5, y - 0.6, y - 0.5, PAINT.dark); // the gallery
      parts.cylinder(x, z, 0.08, 0.08, y - 0.5, y - 0.3, PAINT.dark);
      lantern(parts, x, y, z, r);
      l.at = { x, y, z };
      l.lantern = r;
    } else if (mount.kind === 'buoy') {
      // a pillar buoy, relative to the sea's level: the float, the pillar to the lantern, the topmark above it
      const opts = { floating: true };
      const r = LANTERN.buoy, y = l.height, [c0, c1 = c0] = mount.colours.map((c) => PAINT[c] ?? PAINT.white);
      parts.cylinder(x, z, 1.05, 1.15, -0.9, 0.45, c0, opts);
      parts.cylinder(x, z, 1.15, 0.5, 0.45, 0.8, c0, opts);
      if (mount.pattern === 'vertical') {
        // vertical stripes: eight staves of the pillar, alternately the two colours
        for (let k = 0; k < 8; k++) {
          const g = new THREE.CylinderGeometry(0.28, 0.45, y - 1.2, 8, 1, true, (k * Math.PI) / 4, Math.PI / 4);
          parts.add(g, k % 2 ? c1 : c0, x, (0.8 + y - 0.4) / 2, z, opts);
        }
      } else parts.cylinder(x, z, 0.45, 0.28, 0.8, y - 0.4, c0, opts);
      parts.cylinder(x, z, 0.4, 0.4, y - 0.4, y - 0.3, PAINT.dark, opts);
      lantern(parts, x, y, z, r, opts);
      const top = PAINT[mount.topmarkColour] ?? c0;
      parts.cylinder(x, z, 0.03, 0.03, y + 0.32, y + 0.75, PAINT.dark, opts);
      if (mount.topmark === 'sphere') parts.add(new THREE.SphereGeometry(0.28, 14, 10), top, x, y + 1.0, z, opts);
      else if (mount.topmark === 'x-shape') {
        for (const a of [Math.PI / 4, -Math.PI / 4]) {
          const g = new THREE.BoxGeometry(0.1, 0.75, 0.06);
          g.rotateZ(a);
          parts.add(g, top, x, y + 1.05, z, opts);
        }
      }
      l.at = { x, y, z };
      l.lantern = r;
    }
  }
  return parts.build();
}

function createCarrierMaterial(uClock, seaLevel) {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.0 });
  const f = attribute('aSeamarkFloat', 'vec2');
  // a buoy's parts ride the tide and the swell (the same heave as its light's glow)
  const heave = sin(uClock.mul(0.9).add(f.y.mul(0.37))).mul(HEAVE).add(seaLevel).mul(f.x);
  mat.positionNode = positionGeometry.add(vec3(0.0, heave, 0.0));
  return mat;
}

// --- build -----------------------------------------------------------------------------------------------------------------

export function buildSeamarks(terrain, { seaLevel = uniform(0), landmarks = null } = {}) {
  if (!SEAMARKS.length) return null;
  const group = new THREE.Group();
  group.name = 'DonostiaSeamarks';
  // the lighthouses' lanterns, as their models built them
  const anchors = new Map();
  landmarks?.traverse((o) => {
    const s = o.userData.seamark;
    if (s) anchors.set(s.ref, s);
  });
  const lights = SEAMARKS.map((l) => ({ ...l }));
  const uClock = uniform(0);
  const carrierGeo = carriers(lights, terrain, anchors);
  if (carrierGeo) {
    const mesh = new THREE.Mesh(carrierGeo, createCarrierMaterial(uClock, seaLevel));
    mesh.name = 'Seamark_carriers';
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    // the buoys' heave is not in the geometry's bounds
    mesh.geometry.computeBoundingSphere();
    mesh.geometry.boundingSphere.radius += 6;
    group.add(mesh);
  }
  const glows = glowMesh(lights, uClock, seaLevel);
  group.add(glows);

  let frames = 0;
  group.userData.update = () => {
    uClock.value = seamarkClock();
    // drawn at dusk & night only; every frame for the first few, so the warm-up compiles its pipeline
    glows.visible = frames++ < 4 || cityUniforms.uInteriorGlow.value > 0.55;
  };
  group.userData.freeze = freezeSeamarkClock;
  group.userData.lights = lights;
  return group;
}
