import * as THREE from 'three/webgpu';
import { float, vec3, abs, max, min, mix, smoothstep, uv, vertexColor, positionWorld, mx_noise_float } from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { gridLine } from './kit.js';
import { Parts, grid, beam as boxBeam } from './geom.js';

// js/donostia/landmarks/illunbe.js
// Illunbe bullring (Plaza de toros de Illunbe, 1998): a round arena with a retractable dome roof (used for concerts and basketball), next to Anoeta.
//
// build(sites, ctx) receives the GEO.landmarks entries ['illunbe'] (footprint ring,
// at [x, z], buildings, height — see tools/donostia/build.mjs) and ctx = { GEO, terrain, kit }. Return an Object3D in
// world (local-frame) coordinates, or null to keep the plain extruded buildings. Returning a model hides the 1:500
// buildings listed in the sites' `buildings`.
//
// The Donostia Arena / Illunbe (opened 1998; 11,000 seats for bullfights, OSM capacity) is a low concrete drum ~102 m
// across (the OSM outline, a near-perfect circle) under a silver dome. No brick or arches: as the photos show, a
// ground floor clad in light panels with a maroon band and numbered gates; above it the stepped
// underside of the stands, carried by raking concrete legs that lean out to a glazed clerestory ring; a maroon fascia
// at the eave; and the dome, whose central part is the moving roof — two leaves of over 60 t each (Interempresas,
// 2009) that ride out on rails across the fixed dome to open the ring to the sky. The model shows it closed, the
// leaves meeting on a slightly stepped seam above the fixed dome's opening over the sand.
// Heights: b5m measures the drum at 25.2 m on average and 33.9 m at most above the ground (E_A656950,
// tools/donostia/data/b5m_buildings.json). A dome over a 102 m disc averaging that much under that crown springs from
// an eave ~16 m up, as the photos from the motorway show (the dome stands taller than the drum below its eave): the
// fixed dome climbs 11.5 m to its opening, the leaves stand on a ~2.2 m skirt and crown 4.4 m higher. The ground drops
// ~10 m off the south-west edge, where the drum's terrace stands on a concrete plinth over the road below.

const D2R = Math.PI / 180;
// radii (m) from the drum's centre, heights (m) above the arena floor
const WALL_R = 43.5, WALL_TOP = 6.0; // ground floor
const CLERESTORY_R = 49.9, CLERESTORY = [11.8, 14.6]; // glazed ring under the eave
const FASCIA_TOP = 16.0; // maroon fascia
const DOME_SPHERE = 89.5; // radius of the fixed dome's sphere (11.5 m from the eave up to the opening)
const OPENING_R = 27.5; // the fixed dome's central opening, over the sand (the ruedo and callejón)
const LEAF_R = 28.6, LEAF_EDGE = 29.4, LEAF_CROWN = 33.8, LEAF_STEP = 0.4; // the two moving leaves
const SEAM = 28; // bearing of the leaves' seam (degrees, clockwise from north); they slide out across it
const LEGS = 18; // raking legs round the drum
const N = 144;

const MAROON = [0.25, 0.035, 0.045], CLADDING = [0.74, 0.74, 0.72], CONCRETE = [0.56, 0.55, 0.52], DARK = [0.07, 0.08, 0.09];
const PAVING = [0.44, 0.42, 0.4], RAIL = [0.26, 0.27, 0.28];

// --- local helpers ----------------------------------------------------------------------------------------------------

// geom.js's box beam with zero uvs (Parts fills them in): the drum material draws its panel joints from uv, metres round
// the drum and up it, which a beam's own 0..1 box uvs would scatter across its faces
function beam(p0, p1, w, h = w) {
  const g = boxBeam(p0, p1, w, h);
  g.deleteAttribute('uv');
  return g;
}

// Least-squares circle through a ring [x0, z0, ...] (Kåsa): centre and mean radius
function fitCircle(ring) {
  let sx = 0, sz = 0, n = 0;
  for (let k = 0; k < ring.length; k += 2) { sx += ring[k]; sz += ring[k + 1]; n++; }
  const mx = sx / n, mz = sz / n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let k = 0; k < ring.length; k += 2) {
    const u = ring[k] - mx, v = ring[k + 1] - mz;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const a = (suuu + suvv) / 2, b = (svvv + svuu) / 2, det = suu * svv - suv * suv;
  const uc = (a * svv - b * suv) / det, vc = (b * suu - a * suv) / det;
  return { x: mx + uc, z: mz + vc, r: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

// --- TSL helpers (from js/tsl-materials.js) --------------------------------------------------------------------------

const nightOf = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);

// --- materials --------------------------------------------------------------------------------------------------------

// Concrete, cladding and paint, coloured per piece. uv = (metres round the drum, metres above the arena floor): panel
// joints on the cladding, the risers of the stands on the stepped soffit, board marks on the concrete.
function drumMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 });
  const along = uv().x, h = uv().y;
  const grain = mx_noise_float(positionWorld.mul(0.8)).mul(0.07).add(0.97);
  const joints = gridLine(along, 1.6, 0.025).max(gridLine(h, 1.2, 0.025));
  mat.colorNode = vertexColor().rgb.mul(grain).mul(joints.mul(0.22).oneMinus());
  return mat;
}

// The clerestory: dark glass between mullions every 2.2 m and a transom; the concourse behind it lit at night
function glassMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.12, metalness: 0.4 });
  const along = uv().x, h = uv().y;
  const frame = gridLine(along, 2.2, 0.08).max(gridLine(h, 1.6, 0.07));
  mat.colorNode = mix(vec3(0.05, 0.06, 0.07), vec3(0.55, 0.56, 0.57), frame);
  mat.roughnessNode = mix(float(0.1), float(0.5), frame);
  const lit = mx_noise_float(vec3(along.mul(0.05), 0.3, 0.0)).mul(0.3).add(0.75);
  mat.emissiveNode = vec3(1.0, 0.82, 0.58).mul(frame.oneMinus().mul(nightOf()).mul(lit).mul(0.7));
  return mat;
}

// The fixed dome's silver standing-seam sheeting (seams converging on the centre) and the moving leaves' panels.
// uv = (metres round the eave at the panel's bearing, radius) on the dome; leaves: metres across, along.
function metalMaterial(leaves) {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0.3 });
  const a = uv().x, b = uv().y;
  const lines = leaves ? gridLine(a, 2.4, 0.05).max(gridLine(b, 3.2, 0.06)) : gridLine(a, 1.9, 0.035).max(gridLine(b, 7.5, 0.05).mul(0.6));
  const mottle = mx_noise_float(positionWorld.mul(0.15)).mul(0.04).add(1.0);
  const base = leaves ? vec3(0.5, 0.51, 0.5) : vec3(0.36, 0.38, 0.4);
  mat.colorNode = base.mul(mottle).mul(lines.mul(0.25).oneMinus());
  return mat;
}

// --- build --------------------------------------------------------------------------------------------------------------

export function build(sites, ctx) {
  const site = sites.find((s) => s.id === 'illunbe') || sites[0];
  if (!site?.footprint) return null;
  const { kit } = ctx;
  const c = fitCircle(site.footprint);
  const R = c.r; // the fascia's outer edge
  const G = kit.groundAt(ctx, c.x, c.z); // the arena floor (the DTM is flat across the drum)
  const at = (t, r, y) => [c.x + r * Math.cos(t), G + y, c.z + r * Math.sin(t)];
  const radial = (t) => [Math.cos(t), 0, Math.sin(t)];
  const th = (i, n = N) => (i / n) * Math.PI * 2;
  const up = [0, 1, 0], down = [0, -1, 0];
  // a band round the drum between (r0, y0) and (r1, y1); uv = (metres round at r1, height)
  const band = (r0, y0, r1, y1, out, nv = 1) => grid(N, nv,
    (i, j) => at(th(i), r0 + ((r1 - r0) * j) / nv, y0 + ((y1 - y0) * j) / nv),
    (i, j) => [th(i) * r1, y0 + ((y1 - y0) * j) / nv], (i) => out(th(i)));

  const parts = new Parts();
  const drum = drumMaterial(), glass = glassMaterial(), dome = metalMaterial(false), leaves = metalMaterial(true);

  // terrace under the eave and the plinth at its edge (inside the OSM outline), down to wherever the ground falls
  // away; the deck just over the LiDAR's bumps round the drum (at most a metre above the arena floor)
  const terraceR = R - 0.2;
  let deck = 0.05;
  for (let i = 0; i < N; i += 2) {
    for (const r of [WALL_R + 1, (WALL_R + terraceR) / 2, terraceR - 0.5]) {
      const [x, , z] = at(th(i), r, 0);
      deck = Math.max(deck, Math.min(kit.groundAt(ctx, x, z) - G + 0.08, 1.0));
    }
  }
  parts.add(drum, band(WALL_R - 0.1, deck, terraceR, deck, () => up), PAVING);
  parts.add(drum, grid(N, 1, (i, j) => {
    const t = th(i);
    const [x, , z] = at(t, terraceR + 1.5, 0);
    return at(t, terraceR, j ? deck : Math.min(kit.groundAt(ctx, x, z), G) - G - 0.6);
  }, (i, j) => [th(i) * terraceR, j * 3], radial), CONCRETE);

  // ground floor: light cladding with the maroon band, gates (dark, numbered in the photos) in every bay
  parts.add(drum, band(WALL_R, -0.6, WALL_R, WALL_TOP, radial), CLADDING);
  parts.add(drum, band(WALL_R + 0.06, 4.4, WALL_R + 0.06, 5.2, radial), MAROON);
  for (let k = 0; k < LEGS; k++) {
    const t = th(k + 0.5, LEGS), w = 5.5 / WALL_R;
    parts.add(drum, grid(6, 1, (i, j) => at(t - w / 2 + (w * i) / 6, WALL_R + 0.08, j ? 3.6 : 0.05), (i, j) => [i, j], () => radial(t), false), DARK);
  }
  // the stepped underside of the stands, leaning out to the clerestory; the raking legs and their pilasters
  parts.add(drum, band(WALL_R, WALL_TOP, CLERESTORY_R, CLERESTORY[0], (t) => [Math.cos(t), -0.7, Math.sin(t)]), CONCRETE);
  for (let k = 0; k < LEGS; k++) {
    const t = th(k, LEGS);
    parts.add(drum, beam(at(t, WALL_R + 0.45, -0.6), at(t, WALL_R + 0.45, WALL_TOP - 0.4), 1.1, 0.9), CONCRETE);
    parts.add(drum, beam(at(t, WALL_R + 0.45, WALL_TOP - 0.6), at(t, CLERESTORY_R + 0.25, CLERESTORY[0] + 0.2), 1.1, 0.9), CONCRETE);
  }
  // clerestory, eave soffit and fascia
  parts.add(glass, band(CLERESTORY_R, CLERESTORY[0], CLERESTORY_R, CLERESTORY[1], radial));
  parts.add(drum, band(CLERESTORY_R, CLERESTORY[1], R, CLERESTORY[1], () => down), CONCRETE);
  parts.add(drum, band(R, CLERESTORY[1], R, FASCIA_TOP, radial), MAROON);

  // the fixed dome: a spherical zone from the eave up to the central opening
  const sag = Math.sqrt(DOME_SPHERE ** 2 - R * R);
  const domeY = (r) => FASCIA_TOP + Math.sqrt(DOME_SPHERE ** 2 - r * r) - sag;
  const NR = 10;
  parts.add(dome, grid(N, NR, (i, j) => { const r = R + ((OPENING_R - R) * j) / NR; return at(th(i), r, domeY(r)); },
    (i, j) => [th(i) * R, R + ((OPENING_R - R) * j) / NR], () => up));

  // the moving roof, closed: two half-discs of a flatter sphere meeting on the seam, one a step higher; skirts round
  // their edges; the rails they open along run out across the fixed dome
  const seam = [Math.sin(SEAM * D2R), -Math.cos(SEAM * D2R)]; // (x east, z south)
  const across = [-seam[1], seam[0]];
  const leafSphere = (LEAF_R ** 2 + (LEAF_CROWN - LEAF_EDGE) ** 2) / (2 * (LEAF_CROWN - LEAF_EDGE));
  const leafY = (r) => LEAF_CROWN - (leafSphere - Math.sqrt(leafSphere ** 2 - r * r));
  const seamAngle = Math.atan2(seam[1], seam[0]);
  for (const side of [0, 1]) {
    const lift = side * LEAF_STEP, t0 = seamAngle + side * Math.PI, NL = 48, NRL = 8;
    const p = (i, j) => { const t = t0 + (Math.PI * i) / NL, r = (LEAF_R * j) / NRL; return at(t, r, leafY(r) + lift); };
    parts.add(leaves, grid(NL, NRL, p, (i, j) => {
      const q = p(i, j);
      return [(q[0] - c.x) * seam[0] + (q[2] - c.z) * seam[1], (q[0] - c.x) * across[0] + (q[2] - c.z) * across[1]];
    }, () => up, false));
    // skirt round the arc, down into the fixed dome
    parts.add(leaves, grid(NL, 1, (i, j) => {
      const t = t0 + (Math.PI * i) / NL;
      return at(t, LEAF_R, j ? leafY(LEAF_R) + lift : domeY(LEAF_R) - 0.3);
    }, (i, j) => [i * 2, j], (i) => radial(t0 + (Math.PI * i) / NL), false));
    if (side) {
      // the step along the seam
      parts.add(leaves, grid(16, 1, (i, j) => {
        const r = -LEAF_R + (2 * LEAF_R * i) / 16, x = c.x + seam[0] * r, z = c.z + seam[1] * r, y = leafY(Math.abs(r));
        return [x, G + y + (j ? LEAF_STEP : 0), z];
      }, (i, j) => [i * 3, j], () => [across[0], 0, across[1]], false));
    }
    // two rails per leaf, out across the fixed dome to the eave
    const outDir = side ? [-across[0], -across[1]] : across;
    for (const off of [-15, 15]) {
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        const s0 = Math.sqrt(LEAF_R ** 2 - off * off), s1 = Math.sqrt((R - 0.6) ** 2 - off * off), s = s0 + ((s1 - s0) * k) / 8;
        const x = c.x + seam[0] * off + outDir[0] * s, z = c.z + seam[1] * off + outDir[1] * s;
        pts.push([x, G + domeY(Math.hypot(x - c.x, z - c.z)) + 0.2, z]);
      }
      for (let k = 0; k < 8; k++) parts.add(drum, beam(pts[k], pts[k + 1], 0.7, 0.45), RAIL);
    }
  }

  const group = parts.build('illunbe');
  group.userData.top = G + LEAF_CROWN + LEAF_STEP;
  return group;
}
