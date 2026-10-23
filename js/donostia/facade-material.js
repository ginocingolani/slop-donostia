import * as THREE from 'three/webgpu';
import {
  Fn, If, attribute, varying, float, vec2, vec3, vec4, floor, fract, abs, max, min, mix, smoothstep, step, sin, dot,
  clamp, normalize, length, fwidth, pow, sign, sqrt, select, color, mod, positionWorld, positionView, normalView,
  normalWorldGeometry, cameraPosition, cameraViewMatrix
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { STYLE_PARAMS, WALL, SURF, COVER, FLAG } from './facade-style.js';

// js/donostia/facade-material.js
// Facade and roof shaders of Donostia's buildings (geometry & attributes: js/donostia/facade-mesh.js). One material
// each for every style, which the per-building attributes pick: the Belle Époque ashlar, French windows, iron
// balconies and miradores of the Área Romántica; the rendered narrow houses of the Parte Vieja with painted
// shutters, coloured railings and bar fronts; brick and concrete blocks of the 1950s-80s with roller blinds and
// terraces; whitewashed villas with shutters (some half-timbered); contemporary render; sandstone churches.
// Windows are laid out per facade run (bays fitted between corner piers, storeys fitted to the measured height) and
// anti-aliased with box-filtered pulses; behind them, parallax rooms that light up at random at dusk & night.

// --- Helpers adapted from js/tsl-materials.js (hash2D, noise2D, filteredPulse, bumpNormal) ---------------------------

const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const w = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
});

// Fraction of a footprint `w` wide around `x` where fract() lies in [a, b] (box-filtered periodic pulse: settles to
// the mean coverage b - a once a period shrinks below a pixel). a and b are clamped to the cell.
const filteredPulse = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const lo = clamp(float(a), 0.0, 1.0).toVar();
  const hi = clamp(float(b), 0.0, 1.0).max(lo).toVar();
  const hw = max(float(w), 0.0001).mul(0.5).toVar();
  const integral = (t) => floor(t).mul(hi.sub(lo)).add(clamp(fract(t), lo, hi).sub(lo));
  return integral(p.add(hw)).sub(integral(p.sub(hw))).div(hw.mul(2.0));
});

// Coverage of the band a <= x <= b (metres) for a pixel `w` metres wide, fading to its mean when thinner than a pixel
const band = Fn(([x, a, b, w]) => {
  const p = float(x).toVar();
  const ww = max(float(w), 0.0001).toVar();
  const lo = float(a).toVar();
  const hi = float(b).toVar();
  const inside = clamp(min(p.sub(lo), hi.sub(p)).div(ww).add(0.5), 0.0, 1.0);
  return inside.mul(clamp(hi.sub(lo).div(ww), 0.0, 1.0));
});

// Mikkelsen surface-gradient bump from a scalar height (view space); Fn so `height` is evaluated once before dFdx/dFdy
const bumpNormal = Fn(([height]) => {
  const hgt = float(height).toVar();
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(hgt.dFdx().mul(r1).add(hgt.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
});

// Parallax room behind a window, adapted from evaluateApartmentInterior in js/tsl-materials.js: the wall's own
// tangent (the direction u grows along) replaces New York's axis-aligned facade frame. Rooms span 2-3 bays so their
// partitions land behind piers; drapes hang inside the glass; far away rooms settle to their mean lit level so they
// don't twinkle. Returns vec4(room colour, lit emission). No derivatives inside (`cFwIn`: the pixel footprint of winUV.x),
// so it can run in a branch that only window pixels take.
const roomInterior = Fn(([uCoord, vCoord, winUV, cellId, winW, floorH, seedNode, litProb, fwNode, nW, cFwIn]) => {
  const u = float(uCoord).toVar();
  const v = float(vCoord).toVar();
  const wUV = vec2(winUV).toVar();
  const cid = vec2(cellId).toVar();
  const wW = float(winW).toVar();
  const fH = float(floorH).toVar();
  const sd = float(seedNode).toVar();

  const floorIdx = floor(v.div(fH)).toVar();
  const fHash1 = fract(sin(floorIdx.mul(41.3).add(sd)).mul(43758.5453));
  const fHash2 = fract(sin(floorIdx.mul(73.7).add(sd.mul(1.7))).mul(43758.5453));
  const roomBays = mix(float(2.0), float(3.0), step(0.5, fHash1)).toVar();
  const roomPhase = floor(fHash2.mul(roomBays)).toVar();
  const roomU = u.div(wW).add(roomPhase).div(roomBays).toVar();
  const roomId = vec2(floor(roomU), floorIdx).toVar();
  const roomW = wW.mul(roomBays).toVar();
  const roomH = fH.mul(0.92).toVar();
  const setback = float(0.12);
  const depth = roomH.mul(1.55).toVar();
  const originX = fract(roomU).sub(0.5).mul(roomW).toVar();
  const originY = wUV.y.sub(0.46).mul(roomH.mul(0.62)).toVar();

  const n = vec3(nW).toVar();
  const tangent = vec3(n.z.negate(), 0.0, n.x);
  const rayWorld = normalize(positionWorld.sub(cameraPosition)).toVar();
  const dirX = dot(rayWorld, tangent).toVar();
  const dirY = rayWorld.y.toVar();
  const dirZ = max(dot(rayWorld, n).negate(), 0.05).toVar();

  const halfW = roomW.mul(0.5).toVar();
  const halfH = roomH.mul(0.5).toVar();
  const tFarX = halfW.sub(originX.mul(sign(dirX))).div(max(abs(dirX), 0.0001)).toVar();
  const tFarY = halfH.sub(originY.mul(sign(dirY))).div(max(abs(dirY), 0.0001)).toVar();
  const tFarZ = setback.add(depth).div(dirZ).toVar();
  const t = min(min(tFarX, tFarY), tFarZ).toVar();
  const hit = vec3(originX.add(dirX.mul(t)), originY.add(dirY.mul(t)), dirZ.mul(t)).toVar();
  const q = clamp(vec3(hit.x.div(roomW).add(0.5), hit.y.div(roomH).add(0.5), hit.z.sub(setback).div(depth)), vec3(0.0), vec3(1.0)).toVar();

  const onBack = step(tFarZ, tFarX).mul(step(tFarZ, tFarY)).toVar();
  const isYPlane = step(tFarY, tFarX).mul(step(tFarY, tFarZ)).toVar();
  const onCeil = isYPlane.mul(step(0.0, dirY)).toVar();
  const onFloor = isYPlane.mul(float(1.0).sub(step(0.0, dirY))).toVar();

  const seed1 = hash2D(roomId.add(vec2(sd, 19.4))).toVar();
  const seed2 = hash2D(roomId.add(vec2(sd.mul(1.9), 83.1))).toVar();
  const seed3 = hash2D(roomId.add(vec2(63.2, sd.mul(0.7)))).toVar();
  const lod = smoothstep(0.3, 0.8, max(fwNode.x, fwNode.y)).toVar();
  const litRoom = step(float(1.0).sub(litProb), seed3).toVar();
  const lit = mix(litRoom, 1.0, lod).toVar();

  const warmLight = mix(color(0xffb845), color(0xffe49c), seed1);
  const coolLight = mix(color(0xdfe8ff), color(0xb4c6ff), seed2);
  const lightCol = mix(coolLight, warmLight, step(0.22, seed2)).toVar();

  const wallBase = mix(mix(color(0x9a8b73), color(0x7d8a8e), seed1), color(0xc9bda5), seed2.mul(0.6)).toVar();
  const wallCol = mix(wallBase, wallBase.mul(0.5), smoothstep(0.06, 0.04, q.y)).toVar();
  const seam = step(0.92, fract(q.x.mul(7.0)));
  const boards = mix(color(0x4a3320), color(0x6a4c30), seed1).mul(float(1.0).sub(seam.mul(0.3)));
  const rug = mix(color(0x7a3b32), color(0x3a5760), seed2);
  const inRug = step(abs(q.x.sub(0.5)), 0.28).mul(step(abs(q.z.sub(0.58)), 0.25));
  const floorCol = mix(boards, rug, inRug.mul(0.88)).toVar();
  const lamp = smoothstep(0.18, 0.11, length(vec2(q.x.sub(0.5), q.z.sub(0.5)))).mul(float(1.0).sub(lod));
  const ceilCol = mix(mix(wallBase, color(0xe8e2d5), 0.28), lightCol.mul(mix(float(0.85), float(3.8), lit)), lamp).toVar();
  const doorX = mix(float(0.24), float(0.76), seed1);
  const inDoor = step(abs(q.x.sub(doorX)), 0.09).mul(step(abs(q.y.sub(0.34)), 0.34));
  const picX = mix(float(0.72), float(0.28), step(0.5, seed1));
  const inPic = step(abs(q.x.sub(picX)), 0.075).mul(step(abs(q.y.sub(0.56)), 0.085));
  const doorCol = mix(color(0x5a4631), color(0x39383c), step(0.5, seed2));
  const picCol = mix(color(0x2c3a4a), color(0x7a5a3a), fract(seed1.add(seed2)));
  const backCol = mix(mix(wallCol, doorCol, inDoor), picCol, inPic).toVar();
  const shellCol = mix(mix(mix(wallCol, floorCol, onFloor), ceilCol, onCeil), backCol, onBack).toVar();

  const aoX = smoothstep(0.0, 0.16, q.x).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.x))).toVar();
  const aoY = smoothstep(0.0, 0.16, q.y).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.y))).toVar();
  const aoZ = smoothstep(0.0, 0.16, q.z).mul(smoothstep(0.0, 0.16, float(1.0).sub(q.z))).toVar();
  const edgeAO = mix(mix(aoY.mul(aoZ), aoX.mul(aoZ), isYPlane), aoX.mul(aoY), onBack);
  const shaded = shellCol.mul(mix(float(0.66), float(1.0), edgeAO)).mul(mix(float(1.0), float(0.42), q.z)).toVar();

  // Drapes just inside the glass
  const cUVx = clamp(wUV.x.add(dirX.div(dirZ).mul(0.06)), 0.0, 1.0).toVar();
  const wSeed1 = hash2D(cid.add(vec2(sd.mul(0.8), 41.2))).toVar();
  const wSeed2 = hash2D(cid.add(vec2(17.9, sd.mul(1.3)))).toVar();
  const sL = smoothstep(0.18, 1.0, wSeed1);
  const sR = smoothstep(0.18, 1.0, wSeed2);
  const lw = sL.mul(sL).mul(0.48);
  const rw = sR.mul(sR).mul(0.48);
  const cFw = float(cFwIn).toVar();
  const drapeAA = cFw.add(0.015).toVar();
  const inLeft = smoothstep(lw.add(drapeAA), lw.sub(drapeAA), cUVx).mul(step(0.03, lw));
  const inRight = smoothstep(float(1.0).sub(rw).sub(drapeAA), float(1.0).sub(rw).add(drapeAA), cUVx).mul(step(0.03, rw));
  const inDrape = mix(clamp(max(inLeft, inRight), 0.0, 1.0), 0.29, lod).toVar();
  const pick = fract(seed1.mul(5.7)).mul(5.0);
  const fabric = mix(mix(mix(mix(color(0xcabfa6), color(0x8a7a64), step(1.0, pick)), color(0x5f7079), step(2.0, pick)),
    color(0x6c7558), step(3.0, pick)), color(0x8c5a44), step(4.0, pick));
  const pleat = sin(cUVx.mul(48.0).add(wSeed1.mul(6.28))).mul(float(1.0).sub(smoothstep(0.6, 1.6, cFw.mul(48.0)))).mul(0.2).add(0.95);
  const drapeCol = fabric.mul(pleat).mul(0.92);
  const best = mix(shaded, drapeCol, inDrape);
  const emit = mix(float(1.0), float(0.2), inDrape);
  const roomCol = best.mul(mix(vec3(1.0), lightCol, lit.mul(0.85))).mul(mix(float(0.85), float(1.35), lit));
  return vec4(roomCol, mix(litRoom, litProb, lod).mul(emit));
});

// A per-style value: `values[k]` for style k (numbers or [r, g, b] in linear light)
function byStyle(style, values) {
  const node = (x) => (Array.isArray(x) ? vec3(...x) : float(x));
  let out = node(values[values.length - 1]);
  for (let k = values.length - 2; k >= 0; k--) out = select(style.lessThan(k + 0.5), node(values[k]), out);
  return out;
}

const is = (x, k) => float(1.0).sub(step(0.5, abs(x.sub(k))));
const srgbToLinear = (c) => pow(c, vec3(2.2));
const TAU = Math.PI * 2;

// Shares of lit rooms and shops follow the time of day (uInteriorGlow: ~0.24 at midday, 1.55 at night)
const litShare = () => clamp(cityUniforms.uInteriorGlow.mul(0.3).add(0.05), 0.0, 0.6);

export function createFacadeMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const fac = attribute('facade', 'vec4');
  const inf = attribute('binfo', 'vec4');
  const bcol = attribute('bcol', 'vec4');
  const acol = attribute('acol', 'vec4');

  const u = fac.x, v = fac.y, runLen = fac.z, kind = fac.w;
  const style = floor(inf.x);
  const seed = fract(inf.x);
  const floorH = inf.y;
  const shops = step(0.0, inf.z);
  const groundH = abs(inf.z);
  const storeyTop = inf.w;
  const nW = normalWorldGeometry;
  // Per-style constants are picked once per vertex: as select chains they would run for every pixel
  const PV = (values) => byStyle(style, values);
  const styleA = varying(vec4(PV(STYLE_PARAMS.map((p) => p.pier)), PV(STYLE_PARAMS.map((p) => p.bay)), PV([0.40, 0.46, 0.56, 0.34, 0.55, 0.26, 0.4]),
    PV([0.80, 0.78, 0.80, 0.76, 0.86, 0.86, 0.8])), 'vFacadeStyleA');
  const styleB = varying(vec4(PV([0.04, 0.05, 0.30, 0.30, 0.10, 0.28, 0.3]), PV([1, 1, 2, 0, 3, 0, 0]), PV([0.96, 0.9, 0.38, 0.0, 0.5, 0.0, 0.0]),
    PV([0.45, 0.12, 0.85, 0.2, 0.6, 0.0, 0.0])), 'vFacadeStyleB');
  const wallV = varying(vec4(srgbToLinear(bcol.xyz), bcol.w), 'vFacadeWall');
  const accentV = varying(vec4(srgbToLinear(acol.xyz), acol.w), 'vFacadeAccent');
  const seed2 = accentV.w;
  const flags = floor(wallV.w.mul(255.0).add(0.5));
  const flag = (bit) => step(0.5, fract(flags.div(bit * 2)));

  const kFront = is(kind, WALL.FRONT), kRear = is(kind, WALL.REAR), kBlank = is(kind, WALL.BLANK);
  const kSolid = is(kind, WALL.SOLID), kMir = is(kind, WALL.MIRADOR);
  const sRom = is(style, 0), sOld = is(style, 1), sMod = is(style, 2), sVil = is(style, 3), sCon = is(style, 4);
  const sCiv = is(style, 5), sLight = is(style, 6);
  const modernish = clamp(sMod.add(sCon), 0.0, 1.0);
  const plaza = flag(FLAG.PLAZA);
  // A few more per-style numbers as sums over the style masks (cheaper than another varying: the vertex outputs are
  // a scarce resource with the shadow cascades & fog on top)
  const styleMasks = [sRom, sOld, sMod, sVil, sCon, sCiv, sLight];
  const perStyle = (values) => styleMasks.reduce((sum, m, k) => (values[k] ? sum.add(m.mul(values[k])) : sum), float(0.0));

  const wallBase = wallV.xyz;
  const accent = accentV.xyz;

  // --- Bays along the run, storeys up the wall (same arithmetic as bayLayout in facade-style.js)
  const pier = min(styleA.x, runLen.mul(0.12));
  const inner = max(runLen.sub(pier.mul(2.0)), 0.01);
  const bays = max(floor(inner.div(styleA.y).add(0.5)), 1.0);
  const bayW = inner.div(bays);
  const gx = u.sub(pier).div(bayW);
  const bayIdx = floor(gx);
  const cu = fract(gx);
  const inBays = step(0.0, gx).mul(step(gx, bays)).mul(step(1.1, inner));
  const lv = v.sub(groundH).div(floorH);
  const storey = floor(lv);
  const cv = fract(lv);
  // Pixel footprints: u and v are linear across each quad, so every scaled coordinate's derivative follows from theirs
  const dU = max(fwidth(u), 0.00001), dV = max(fwidth(v), 0.00001);
  const fw = vec2(dU.div(bayW), dV.div(floorH));
  const mpp = max(max(dU, dV), 0.0005); // metres per pixel
  const aboveGround = step(0.0, v);
  const inGround = aboveGround.mul(step(v, groundH));
  const inUpper = step(groundH, v).mul(step(v, storeyTop));
  const nUp = floor(storeyTop.sub(groundH).div(floorH).add(0.5));
  const isTop = step(nUp.sub(1.5), storey).mul(inUpper);
  const fromTop = storeyTop.sub(v); // metres below the top storey's ceiling (the cornice line)
  const opening = max(kFront, kRear).mul(float(1.0).sub(sLight));
  const cellId = vec2(bayIdx, storey);
  const salt = vec2(seed.mul(71.3), seed2.mul(37.1).add(runLen.mul(0.173)));

  // --- Windows: ground floors without shops (and courtyard ground floors) get windows like the storeys above
  const resGround = inGround.mul(max(float(1.0).sub(shops), kRear));
  const winZone = max(inUpper, resGround).mul(opening).mul(inBays);
  const wwM = clamp(styleA.z.mul(bayW), 0.55, 2.2).mul(mix(float(1.0), float(0.8), kRear));
  const ww = min(wwM.div(bayW), 0.8);
  const wx0 = float(0.5).sub(ww.mul(0.5)), wx1 = float(0.5).add(ww.mul(0.5));
  const head = styleA.w;

  // Balconies: iron on every floor of the Área Romántica (a run of them across the first floor on some), painted rails
  // in the Parte Vieja, stacked terraces on 1950s-80s blocks, glass on recent ones
  const balType = styleB.y;
  const balShare = max(styleB.z, plaza);
  const colHash = hash2D(vec2(bayIdx, seed.mul(53.7)));
  const cellHash = hash2D(cellId.add(salt));
  const cellHashUp = hash2D(cellId.add(vec2(0.0, 1.0)).add(salt));
  const hasBal = step(mix(cellHash, colHash, sMod), balShare).mul(step(0.5, balType)).mul(inUpper).mul(kFront).mul(inBays);
  const runBal = flag(FLAG.BALCONY_RUN).mul(is(storey, 0)).mul(inUpper).mul(kFront).mul(inBays);
  const sill = mix(mix(styleB.x, 0.03, hasBal.mul(modernish)), max(styleB.x, 0.3), kRear);

  const inWX = filteredPulse(cu, wx0, wx1, fw.x);
  const inWY = filteredPulse(cv, sill, head, fw.y);
  // Round-headed windows of the churches
  const xm = cu.sub(0.5).mul(bayW);
  const rArch = ww.mul(bayW).mul(0.5);
  const springM = head.mul(floorH).sub(rArch);
  const archD = length(vec2(xm, max(cv.mul(floorH).sub(springM), 0.0))).sub(rArch);
  const archCov = mix(clamp(float(0.5).sub(archD.div(mpp)), 0.0, 1.0), float(1.0), smoothstep(0.25, 0.6, max(fw.x, fw.y)));
  // One street door per run, in a bay picked by the run
  const doorBay = floor(hash2D(vec2(runLen.mul(0.731), seed.mul(13.1))).mul(bays));
  const isDoorBay = is(bayIdx, doorBay).mul(kFront).mul(step(2.5, runLen)).mul(inBays).mul(float(1.0).sub(sLight)).mul(float(1.0).sub(sCiv));
  const win = inWX.mul(inWY).mul(winZone).mul(mix(float(1.0), archCov, sCiv)).mul(float(1.0).sub(isDoorBay.mul(inGround)));
  const wuv = clamp(vec2(cu.sub(wx0).div(max(wx1.sub(wx0), 0.01)), cv.sub(sill).div(max(head.sub(sill), 0.01))), vec2(0.0), vec2(1.0));
  const fwW = vec2(fw.x.div(max(wx1.sub(wx0), 0.01)), fw.y.div(max(head.sub(sill), 0.01)));

  // Shutters: painted wooden leaves folded back beside the windows of the Parte Vieja & villas, some closed
  const shutStyle = max(sOld, sVil).mul(float(1.0).sub(flag(FLAG.NO_SHUTTERS)));
  const shW = wx1.sub(wx0).mul(0.5);
  const shL = filteredPulse(cu, wx0.sub(shW).sub(0.012), wx0.sub(0.012), fw.x);
  const shR = filteredPulse(cu, wx1.add(0.012), wx1.add(shW).add(0.012), fw.x);
  const closed = step(hash2D(cellId.add(vec2(17.0, 3.0)).add(salt)), 0.2).mul(shutStyle);

  // Roller blinds (persianas) let down part of the way
  const blindHash = hash2D(cellId.add(vec2(5.0, 9.0)).add(salt));
  const blindDown = step(blindHash, styleB.w).mul(fract(blindHash.mul(91.7)).mul(0.9).add(0.1));
  // sashes: cream paint, white, aluminium, dark frames
  const frameCol = vec3(perStyle([0.7, 0.77, 0.43, 0.79, 0.07, 0.05, 0.4]))
    .mul(mix(vec3(1.0), vec3(1.0, 0.96, 0.87), perStyle([1.0, 0.4, 0.0, 0.3, 0.0, 0.0, 0.0])));
  const litProb = litShare();
  const roomSeed = seed.mul(97.0).add(runLen.mul(0.37));

  // --- Shopfronts & doors on the ground floor (Konstituzio plaza: an arcade of round arches instead)
  const shopZone = inGround.mul(shops).mul(kFront).mul(inBays).mul(float(1.0).sub(sLight)).mul(float(1.0).sub(isDoorBay));
  const shopW = mix(perStyle([0.74, 0.66, 0.78, 0.6, 0.82, 0.5, 0.5]), float(0.8), plaza).mul(bayW);
  const shopTop = mix(min(groundH.mul(0.8), 3.6), groundH.sub(0.45), plaza);
  const riser = mix(mix(float(0.3), float(0.06), sOld), float(-0.5), plaza);
  const rShop = min(shopW.mul(0.5), shopTop.mul(0.45));
  const springS = shopTop.sub(rShop);
  const dRect = max(abs(xm).sub(shopW.mul(0.5)), max(riser.sub(v), v.sub(shopTop)));
  const dArch = select(v.greaterThan(springS), length(vec2(xm, v.sub(springS))).sub(rShop), max(abs(xm).sub(rShop), riser.sub(v)));
  const shopCov = clamp(float(0.5).sub(mix(dRect, dArch, max(sRom, plaza)).div(mpp)), 0.0, 1.0);
  const shop = mix(shopCov, float(0.62), smoothstep(0.3, 0.8, fw.x)).mul(shopZone);
  const doorW = min(bayW.mul(0.42), 1.5);
  const doorH = min(groundH.mul(0.82), mix(float(2.4), float(3.1), shops));
  const door = clamp(float(0.5).sub(max(abs(xm).sub(doorW.mul(0.5)), v.sub(doorH)).div(mpp)), 0.0, 1.0).mul(isDoorBay).mul(inGround);

  // --- Balconies
  const ym = cv.mul(floorH);
  const ext = mix(float(0.1), float(0.05), sOld).div(bayW);
  // a little wider than the window, or (terraces) nearly the whole bay
  const balSpan = filteredPulse(cu, mix(wx0.sub(ext), float(0.03), modernish), mix(wx1.add(ext), float(0.97), modernish), fw.x);
  const balX = max(balSpan.mul(hasBal), runBal);
  const balcony = balX.mul(filteredPulse(cv, 0.0, float(1.0).div(floorH), fw.y)).mul(inUpper).mul(kFront);
  // Shade under the balcony slab on the storey below
  const hasBalUp = step(mix(cellHashUp, colHash, sMod), balShare).mul(step(0.5, balType)).mul(step(-0.5, storey.add(1.0))).mul(step(storey.add(1.5), nUp))
    .mul(kFront).mul(inBays);
  const runBalUp = flag(FLAG.BALCONY_RUN).mul(is(storey, -1)).mul(kFront).mul(inBays);
  const underSlab = max(balSpan.mul(hasBalUp), runBalUp).mul(smoothstep(0.45, 0.0, float(1.0).sub(cv).mul(floorH))).mul(step(v, storeyTop)).mul(aboveGround);

  // --- Trim: cornices, string courses, window surrounds, quoins
  const trimCol = min(mix(wallBase.mul(1.12), vec3(0.78, 0.74, 0.66), 0.35), vec3(1.0));
  const cornice = band(fromTop, 0.0, 0.6, mpp).mul(max(sRom, sCiv)).add(band(fromTop, 0.0, 0.22, mpp).mul(sOld));
  const dentils = filteredPulse(fract(u.div(0.24)), 0.0, 0.45, dU.div(0.24)).mul(band(fromTop, 0.36, 0.48, mpp)).mul(sRom);
  const corniceShade = band(fromTop, 0.6, 0.95, mpp).mul(max(sRom, sCiv)).mul(smoothstep(0.95, 0.6, fromTop));
  const groundCornice = band(v, groundH.sub(0.34), groundH, mpp).mul(sRom).mul(shops);
  const groundShade = band(v, groundH.sub(0.5), groundH.sub(0.34), mpp).mul(sRom).mul(shops);
  const course = filteredPulse(cv, 0.0, float(0.05).div(floorH), fw.y).mul(inUpper).mul(max(sRom, sMod.mul(0.9)));
  const surM = perStyle([0.14, 0.12, 0.0, 0.1, 0.0, 0.2, 0.0]); // window surround (m)
  const surX = surM.div(bayW), surY = surM.div(floorH);
  const surround = filteredPulse(cu, wx0.sub(surX), wx1.add(surX), fw.x).mul(filteredPulse(cv, sill.sub(surY.mul(0.5)), head.add(surY), fw.y))
    .mul(winZone).mul(float(1.0).sub(win)).mul(step(0.01, surM));
  const hood = filteredPulse(cu, wx0.sub(surX.mul(2.0)), wx1.add(surX.mul(2.0)), fw.x)
    .mul(filteredPulse(cv, head.add(surY), head.add(surY).add(float(0.12).div(floorH)), fw.y))
    .mul(winZone).mul(sRom);
  const qW = mix(float(0.36), float(0.6), mod(floor(v.div(0.34)), 2.0));
  const quoin = max(step(u, qW), step(runLen.sub(u), qW)).mul(max(sOld, sCiv)).mul(max(kFront, kRear)).mul(step(3.0, runLen));
  const quoinJoint = filteredPulse(fract(v.div(0.34)), 0.0, 0.07, dV.div(0.34));
  const trim = clamp(cornice.add(groundCornice).add(course).add(surround).add(hood).add(quoin.mul(0.8)), 0.0, 1.0);
  const trimTint = mix(trimCol, srgbToLinear(vec3(0.78, 0.71, 0.56)), max(sOld, sVil)); // sandstone dressings on render

  // --- Wall materials: ashlar, render, brick
  const ashlar = clamp(max(max(sRom, sCiv), flag(FLAG.ASHLAR)).add(sOld.mul(inGround).mul(shops)), 0.0, 1.0);
  const isBrick = flag(FLAG.BRICK);
  const jointFade = float(1.0).sub(smoothstep(0.02, 0.06, mpp));
  const fineFade = float(1.0).sub(smoothstep(0.04, 0.15, mpp));
  const mottle = noise2D(vec2(u.mul(0.07), v.mul(0.11)).add(seed.mul(17.0))).sub(0.5).mul(0.12);
  const streakDepth = mix(float(0.06), float(0.16), max(sOld, sRom));

  // Timber framing on the top storey of some villas
  const timberOn = flag(FLAG.TIMBER).mul(sVil).mul(isTop).mul(step(0.5, nUp.sub(0.5))).mul(max(kFront, kRear));

  // Party walls left standing above a lower neighbour: grey render or bare brick
  const partyCol = mix(mix(wallBase.mul(0.72), vec3(0.3, 0.29, 0.27), 0.55), vec3(0.3, 0.13, 0.08), step(0.55, seed2).mul(max(sOld, sRom)));

  const glassTint = vec3(0.045, 0.055, 0.065);
  const viewDir = normalize(cameraPosition.sub(positionWorld));
  const fresnel = pow(clamp(float(1.0).sub(abs(dot(viewDir, nW))), 0.0, 1.0), 2.0);
  const skyRefl = mix(cityUniforms.uSkyHorizonColor, cityUniforms.uSkyTopColor, 0.35);

  // The colour pass works out windows, balconies, shopfronts and miradores only where they are (branches), and leaves
  // what the other slots need in these
  const emitV = vec3(0.0).toVar('facadeEmit');
  const roughV = float(0.9).toVar('facadeRough');
  const metalV = float(0.0).toVar('facadeMetal');
  const reliefV = float(0.0).toVar('facadeRelief'); // height field (m) for the bump in the normal slot

  // TSL keeps a shared node in the variable it was first assigned to: one first built inside a branch would be stale
  // wherever that branch didn't run. Everything the branches below share (and the pixel footprints, which want uniform
  // control flow) is therefore built up front, in the main flow.
  const shared = [
    u, v, runLen, seed, seed2, floorH, groundH, storeyTop, shops, plaza, modernish, kFront, kRear, kBlank, kSolid, kMir,
    sRom, sOld, sMod, sVil, sCon, sCiv, sLight, dU, dV, mpp, fw.x, fw.y, pier, bayW, cu, cv, storey, bayIdx, inBays,
    inUpper, inGround, aboveGround, isTop, nUp, fromTop, opening, cellId.x, salt.x, winZone, wx0, wx1, sill, head, inWY,
    win, isDoorBay, shutStyle, hasBal, balType, balX, balcony, underSlab, xm, ym, course, trimTint.x, isBrick, jointFade,
    fineFade, mottle, fresnel, skyRefl.x, litProb, roomSeed, wallBase.x, accent.x
  ];

  mat.colorNode = Fn(() => {
    emitV.assign(vec3(shared.reduce((sum, n) => sum.add(n), float(0.0)).mul(0.0)));
    roughV.assign(float(0.9));
    metalV.assign(float(0.0));
    reliefV.assign(float(0.0));

    // wall surface: render by default, ashlar or brick where the building has it
    const masonry = wallBase.mul(mottle.add(1.0)).toVar();
    If(ashlar.greaterThan(0.5), () => {
      const rowC = v.div(0.5);
      const rowI = floor(rowC);
      const colC = u.div(1.15).add(mod(rowI, 2.0).mul(0.5));
      const stoneJoint = max(filteredPulse(fract(rowC), 0.0, 0.05, dV.div(0.5)), filteredPulse(fract(colC), 0.0, 0.025, dU.div(1.15)).mul(0.7));
      const stoneVar = hash2D(vec2(floor(colC), rowI).add(seed.mul(9.1))).sub(0.5).mul(jointFade);
      const rusticated = sRom.mul(inGround).mul(shops).add(sCiv.mul(step(v, 1.2)));
      const stone = wallBase.mul(stoneVar.mul(0.1).add(1.0)).mul(float(1.0).sub(stoneJoint.mul(jointFade.mul(0.18).add(0.06))))
        .mul(float(1.0).sub(rusticated.mul(filteredPulse(fract(v.div(0.45)), 0.0, 0.1, dV.div(0.45))).mul(0.3)));
      const groundStone = srgbToLinear(vec3(0.78, 0.71, 0.56)).mul(stoneVar.mul(0.1).add(1.0)).mul(float(1.0).sub(stoneJoint.mul(0.14)));
      masonry.assign(mix(stone, groundStone, sOld.mul(inGround)));
    });
    If(isBrick.greaterThan(0.5), () => {
      const brickRow = v.div(0.075);
      const brickCol = u.div(0.25).add(mod(floor(brickRow), 2.0).mul(0.5));
      const brickJoint = max(filteredPulse(fract(brickRow), 0.0, 0.16, dV.div(0.075)), filteredPulse(fract(brickCol), 0.0, 0.05, dU.div(0.25)));
      const brickVar = hash2D(vec2(floor(brickCol), floor(brickRow)).add(seed.mul(3.7))).sub(0.5).mul(float(1.0).sub(smoothstep(0.01, 0.03, mpp)));
      masonry.assign(wallBase.mul(brickVar.mul(0.18).add(1.0)).mul(mix(float(1.0), float(1.45), brickJoint.mul(fineFade.mul(0.6).add(0.4)))));
    });
    const plinth = band(v, -20.0, 0.6, mpp).mul(max(sVil, sCon));
    masonry.assign(mix(masonry, srgbToLinear(vec3(0.55, 0.53, 0.5)), plinth.mul(0.8)));
    // dressings: cornices, string courses, window surrounds & hoods, quoins (styles that have them)
    If(max(max(sRom, sOld), max(sVil, sCiv)).greaterThan(0.5), () => {
      masonry.assign(mix(masonry, trimTint.mul(float(1.0).sub(quoinJoint.mul(quoin).mul(0.25))), trim.mul(float(1.0).sub(isBrick.mul(0.4)))));
      masonry.assign(masonry.mul(float(1.0).sub(dentils.mul(0.35))).mul(float(1.0).sub(corniceShade.mul(0.3))).mul(float(1.0).sub(groundShade.mul(0.3))));
      reliefV.assign(cornice.mul(0.18).add(groundCornice.mul(0.12)).add(course.mul(0.04)).add(surround.mul(0.03)).add(hood.mul(0.06)));
    });
    If(sMod.greaterThan(0.5), () => {
      masonry.assign(mix(masonry, trimTint, course.mul(float(1.0).sub(isBrick.mul(0.4)))));
      reliefV.assign(course.mul(0.04));
    });
    If(timberOn.greaterThan(0.5), () => {
      const posts = filteredPulse(fract(u.div(0.62)), 0.0, 0.18, dU.div(0.62));
      const beams = max(filteredPulse(cv, 0.0, 0.07, fw.y), filteredPulse(cv, 0.93, 1.0, fw.y));
      const timber = clamp(max(posts, beams), 0.0, 1.0);
      masonry.assign(mix(masonry, mix(accent, vec3(0.2, 0.09, 0.05), 0.3), timber));
      reliefV.assign(reliefV.add(timber.mul(0.025)));
    });
    // rain streaks below sills & cornices; their mean darkening far away
    const streaks = streakDepth.mul(0.18).toVar();
    If(mpp.lessThan(0.15), () => {
      const streakN = noise2D(vec2(u.mul(1.3), v.mul(0.05)).add(seed.mul(5.0)));
      streaks.assign(smoothstep(0.35, 0.85, mix(float(0.5), streakN, fineFade.mul(0.7).add(0.3))).mul(streakDepth));
    });
    masonry.assign(masonry.mul(float(1.0).sub(streaks)).mul(float(1.0).sub(underSlab.mul(0.35))));
    // below the building's ground (downhill side of a slope): a plain plinth
    masonry.assign(mix(masonry, srgbToLinear(vec3(0.5, 0.48, 0.45)).mul(mottle.add(1.0)), float(1.0).sub(aboveGround)));
    const col = mix(masonry, partyCol.mul(mottle.add(1.0)), kBlank).toVar();
    // sheds: painted block or corrugated sheet
    If(sLight.greaterThan(0.5), () => {
      col.assign(wallBase.mul(float(1.0).sub(filteredPulse(fract(u.div(0.18)), 0.0, 0.3, dU.div(0.18)).mul(0.12))));
    });

    // windows: sashes, blinds, shutters, and the room behind
    If(win.add(inWY.mul(winZone).mul(shutStyle)).greaterThan(0.0005), () => {
      const shutter = clamp(shL.add(shR).mul(inWY).mul(winZone).mul(shutStyle).mul(float(1.0).sub(closed)).add(win.mul(closed)), 0.0, 1.0);
      const blind = smoothstep(float(1.0).sub(blindDown).sub(fwW.y), float(1.0).sub(blindDown).add(fwW.y), wuv.y).mul(win).mul(float(1.0).sub(closed));
      const frameRect = float(1.0).sub(filteredPulse(wuv.x, 0.06, 0.94, fwW.x).mul(filteredPulse(wuv.y, 0.04, 0.96, fwW.y)));
      const mullion = filteredPulse(wuv.x, 0.485, 0.515, fwW.x).mul(max(max(sRom, sOld), max(sVil, sCiv)));
      const transom = filteredPulse(wuv.y, 0.75, 0.78, fwW.y).mul(max(sRom, sCiv));
      const sash = clamp(frameRect.add(mullion).add(transom), 0.0, 1.0);
      const room = roomInterior(u.sub(pier), v.sub(groundH), wuv, cellId, bayW, floorH, roomSeed, litProb, fw, nW, fwW.x);
      const glass = mix(mix(room.xyz.mul(0.85), glassTint, 0.5), skyRefl, fresnel.mul(0.6).add(0.08));
      const slats = float(1.0).sub(filteredPulse(fract(v.div(0.05)), 0.0, 0.25, dV.div(0.05)).mul(0.25));
      const blindCol = mix(mix(accent, vec3(0.62, 0.55, 0.44), max(sRom, sOld)), vec3(0.7, 0.7, 0.68), sVil).mul(slats);
      const louvres = float(1.0).sub(filteredPulse(fract(v.div(0.07)), 0.0, 0.35, dV.div(0.07)).mul(0.3));
      const pane = mix(glass, blindCol, blind.div(max(win, 0.001)).min(1.0));
      col.assign(mix(col, mix(pane, frameCol, sash), win.mul(float(1.0).sub(closed))));
      col.assign(mix(col, accent.mul(louvres), shutter));
      const openGlass = win.mul(float(1.0).sub(closed)).mul(float(1.0).sub(blind)).mul(float(1.0).sub(sash));
      emitV.assign(room.xyz.mul(room.w).mul(openGlass).mul(0.8));
      reliefV.assign(reliefV.sub(win.mul(0.12)).add(shutter.mul(0.03)));
      roughV.assign(mix(roughV, float(0.08).add(smoothstep(0.3, 0.0, wuv.y).mul(0.25)), openGlass));
      metalV.assign(openGlass.mul(0.3));
    });

    // balconies over the windows: iron railings, solid terrace fronts, glass
    If(balcony.greaterThan(0.0005), () => {
      const railTop = float(1.0);
      const rB = u.div(0.11);
      const balusters = filteredPulse(fract(rB), 0.0, 0.26, dU.div(0.11)).mul(band(ym, 0.1, railTop, mpp));
      const rails = max(max(band(ym, railTop.sub(0.05), railTop, mpp), band(ym, 0.1, 0.15, mpp)), band(ym, 0.55, 0.58, mpp).mul(sRom));
      const railCov = select(balType.lessThan(1.5), max(balusters, rails), select(balType.lessThan(2.5), float(1.0), max(float(0.55), rails)));
      const railing = balcony.mul(railCov);
      const slab = band(ym, 0.0, 0.09, mpp).mul(balcony);
      const railCol = select(balType.lessThan(1.5), mix(vec3(0.018, 0.018, 0.02), accent, sOld),
        select(balType.lessThan(2.5), mix(wallBase, vec3(0.62, 0.61, 0.58), 0.55), vec3(0.16, 0.2, 0.22)));
      col.assign(mix(col, col.mul(0.82), balcony.mul(0.5)));
      col.assign(mix(col, railCol, railing));
      col.assign(mix(col, trimTint, slab));
      roughV.assign(mix(roughV, float(0.55), railing.mul(step(balType, 1.5))));
      reliefV.assign(reliefV.add(slab.mul(0.12)));
    });

    // shopfronts, signs & doors
    If(inGround.mul(kFront).greaterThan(0.5), () => {
      const shopHash = hash2D(vec2(bayIdx, runLen).add(seed.mul(7.3)));
      const shopLit = step(0.22, shopHash);
      const bulb = mix(vec3(1.0, 0.55, 0.24), vec3(1.0, 0.78, 0.5), fract(shopHash.mul(13.0)));
      const sy = clamp(v.sub(riser).div(max(shopTop.sub(riser), 0.1)), 0.0, 1.0);
      const shelves = float(1.0).sub(step(0.78, fract(sy.mul(3.0))).mul(0.35));
      const shopInterior = bulb.mul(smoothstep(0.0, 1.0, sy).mul(0.16).add(0.06)).mul(shelves).mul(mix(float(0.3), float(1.0), shopLit));
      const shopBars = max(filteredPulse(fract(xm.div(1.15).add(0.5)), 0.0, 0.05, dU.div(1.15)), band(v, shopTop.sub(0.95), shopTop.sub(0.88), mpp)).mul(shop)
        .mul(float(1.0).sub(plaza));
      const signBand = band(v, shopTop.add(0.08), min(shopTop.add(0.62), groundH.sub(0.12)), mpp).mul(shopZone).mul(step(0.3, fract(shopHash.mul(5.3))))
        .mul(float(1.0).sub(plaza));
      const signPick = fract(shopHash.mul(3.1));
      const signCol = mix(mix(vec3(0.03, 0.08, 0.05), vec3(0.18, 0.03, 0.03), step(0.35, signPick)), vec3(0.02, 0.025, 0.05), step(0.7, signPick));
      const letters = filteredPulse(fract(u.div(0.32)), 0.15, 0.75, dU.div(0.32)).mul(band(v, shopTop.add(0.22), shopTop.add(0.45), mpp))
        .mul(step(0.1, fract(u.mul(0.37).add(shopHash)))).mul(step(abs(cu.sub(0.5)), 0.32));
      const fanlight = band(v, doorH.sub(0.5), doorH.sub(0.08), mpp).mul(door);
      const doorPanels = max(filteredPulse(fract(xm.div(doorW).add(0.5)), 0.48, 0.52, dU.div(doorW)), band(v, 1.0, 1.06, mpp));
      const doorWood = mix(mix(vec3(0.06, 0.035, 0.02), accent, max(sOld, sVil)), vec3(0.25, 0.26, 0.27), modernish);
      const shopGlass = mix(mix(glassTint, shopInterior, 0.5), skyRefl, fresnel.mul(0.5).add(0.08));
      const shopFrame = mix(vec3(0.03, 0.03, 0.03), accent.mul(0.6), sOld);
      // under the plaza's arcade the shopfronts stand back in shade
      const shopFront = mix(mix(shopGlass, shopFrame, shopBars), mix(vec3(0.03, 0.026, 0.022), shopInterior.mul(0.3), 0.35), plaza);
      col.assign(mix(col, shopFront, shop));
      col.assign(mix(col, mix(signCol, vec3(0.75, 0.68, 0.5), letters), signBand));
      const doorCol = mix(doorWood.mul(float(1.0).sub(doorPanels.mul(0.4))), mix(glassTint, vec3(0.5, 0.42, 0.3), 0.3), fanlight);
      col.assign(mix(col, doorCol, door));
      // shop lights only tell against the daylight from dusk on
      const shopsLit = bulb.mul(shopLit).mul(shop).mul(float(1.0).sub(shopBars)).mul(mix(float(0.32), float(0.5), sOld)).mul(sy.mul(0.5).add(0.5))
        .mul(smoothstep(0.2, 1.3, cityUniforms.uInteriorGlow).mul(0.9).add(0.1));
      emitV.assign(emitV.add(shopsLit).add(vec3(1.0, 0.75, 0.45).mul(fanlight).mul(0.25)).add(vec3(0.9, 0.8, 0.6).mul(letters).mul(signBand).mul(shopLit).mul(0.5)));
      roughV.assign(mix(roughV, float(0.12), shop.mul(0.8)));
      metalV.assign(metalV.add(shop.mul(0.25)));
      reliefV.assign(reliefV.sub(shop.mul(0.15)).sub(door.mul(0.12)));
    });

    // miradores: white-painted glazed boxes, panelled below the sills, panes split by a glazing bar
    If(kMir.greaterThan(0.5), () => {
      const mPanes = max(floor(runLen.div(0.85).add(0.5)), 1.0);
      const mu = u.div(max(runLen, 0.01)).mul(mPanes);
      const muFw = dU.mul(mPanes).div(max(runLen, 0.01));
      const mHoriz = step(0.5, abs(nW.y));
      const mirGlass = filteredPulse(fract(mu), 0.08, 0.92, muFw).mul(filteredPulse(cv, 0.34, 0.94, fw.y))
        .mul(float(1.0).sub(filteredPulse(cv, 0.73, 0.76, fw.y))).mul(float(1.0).sub(mHoriz));
      const mirLit = step(float(1.0).sub(litProb.mul(1.2)), hash2D(vec2(storey, runLen.mul(3.1)).add(salt)));
      const mirUV = clamp(vec2(fract(mu), cv.sub(0.34).div(0.6)), vec2(0.0), vec2(1.0));
      const room = roomInterior(u, v.sub(groundH), mirUV, vec2(floor(mu), storey), runLen.div(mPanes), floorH, roomSeed, litProb, fw, nW, muFw);
      const mirWhite = vec3(0.6, 0.59, 0.56);
      const mirTop = select(nW.y.greaterThan(0.0), vec3(0.32, 0.34, 0.36), mirWhite.mul(0.85));
      const mirPane = mix(mix(room.xyz.mul(0.7), glassTint, 0.55), skyRefl, fresnel.mul(0.55).add(0.1));
      col.assign(mix(mix(mirWhite, mirPane, mirGlass), mirTop, mHoriz));
      emitV.assign(vec3(1.0, 0.8, 0.55).mul(mirLit).mul(mirGlass).mul(0.6));
      roughV.assign(mix(float(0.6), float(0.1), mirGlass));
      metalV.assign(mirGlass.mul(0.3));
      reliefV.assign(mirGlass.mul(-0.03));
    });
    // jogs in a facade: plain wall; party walls & jogs stay flat
    col.assign(mix(col, wallBase.mul(mottle.add(1.0)), kSolid));
    reliefV.assign(reliefV.mul(float(1.0).sub(kBlank)).mul(float(1.0).sub(kSolid)));
    return col;
  })();

  mat.roughnessNode = roughV;
  mat.metalnessNode = metalV;
  mat.emissiveNode = emitV.mul(float(1.0).sub(fresnel.mul(0.8))).mul(cityUniforms.uInteriorGlow);

  // Relief (window reveals, balcony slabs, cornices & string courses, shutters, shopfronts) from the height the colour
  // pass leaves, faded out with distance before it shrinks to sparkling pixels
  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const fade = float(1.0).sub(smoothstep(25.0, 220.0, camDist)).mul(float(1.0).sub(smoothstep(0.06, 0.2, max(fw.x, fw.y))));
    return bumpNormal(reliefV.mul(fade));
  })();

  // Street canyons of the old centre are darker at their foot
  mat.aoNode = mix(mix(float(0.8), float(1.0), smoothstep(0.0, 4.0, v)), mix(float(0.62), float(1.0), smoothstep(0.0, 11.0, v)), max(sRom, sOld).mul(kFront));
  return mat;
}

export function createRoofMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial();
  const rf = attribute('rfac', 'vec4');
  const ri = attribute('rinfo', 'vec4');
  const bcol = attribute('bcol', 'vec4');
  const rcol = attribute('rcol', 'vec4');
  const u = rf.x, h = rf.y, runLen = rf.z, surf = rf.w;
  const style = floor(ri.x);
  const seed = fract(ri.x);
  const rise = ri.z;
  const nW = normalWorldGeometry;
  // Colours to linear light, and the bays of the facade below (for dormers), once per vertex
  const PV = (values) => byStyle(style, values);
  const roofV = varying(vec4(srgbToLinear(rcol.xyz), rcol.w), 'vRoofColour');
  const wallV = varying(vec4(srgbToLinear(bcol.xyz), PV(STYLE_PARAMS.map((p) => p.pier))), 'vRoofWall');
  const cover = floor(roofV.w.mul(255.0).add(0.5));
  const roofBase = roofV.xyz;
  const wallBase = wallV.xyz;
  const sRom = is(style, 0), sOld = is(style, 1), sVil = is(style, 3);
  const isSurf = (k) => is(surf, k);
  const isCover = (k) => is(cover, k);
  const vertical = float(1.0).sub(step(0.3, abs(nW.y)));
  const facingUp = step(0.3, nW.y);
  const sinP = max(sqrt(max(float(1.0).sub(nW.y.mul(nW.y)), 0.0)), 0.15);
  const along = h.div(sinP); // metres up the slope from the eaves
  // pixel footprints (u, along the slope and h are linear across each face)
  const dU = max(fwidth(u), 0.00001), dA = max(fwidth(along), 0.00001), dH = max(fwidth(h), 0.0005);
  const mpp = max(max(dU, dA), 0.0005);
  const fineFade = float(1.0).sub(smoothstep(0.02, 0.08, mpp));
  const tileFade = float(1.0).sub(smoothstep(0.03, 0.09, mpp));
  const slope = max(isSurf(SURF.PITCHED), isSurf(SURF.MANSARD)).mul(float(1.0).sub(vertical));
  // Dormers stand on mansards (and on the steeper pitched roofs of the Área Romántica), one per bay of the facade below
  const dormerOK = step(1.6, rise).mul(max(isSurf(SURF.MANSARD), isSurf(SURF.PITCHED).mul(sRom).mul(step(2.4, rise)).mul(step(seed, 0.6))))
    .mul(step(2.4, runLen)).mul(float(1.0).sub(vertical)).mul(step(nW.y, 0.9));

  // The colour pass leaves the dormer masks here for the other slots
  const dormerV = float(0.0).toVar('roofDormer');
  const dGlassV = float(0.0).toVar('roofDormerGlass');
  const dLitV = float(0.0).toVar('roofDormerLit');
  const reliefV = float(0.0).toVar('roofRelief'); // height field (m) for the bump in the normal slot

  // Shared nodes are built up front, in the main flow (see the facade material)
  const shared = [u, h, runLen, seed, rise, dU, dA, dH, mpp, fineFade, tileFade, slope, along, facingUp, vertical, sRom, sOld, sVil,
    roofBase.x, wallBase.x, dormerOK, nW.x];

  mat.colorNode = Fn(() => {
    dormerV.assign(shared.reduce((sum, n) => sum.add(n), float(0.0)).mul(0.0));
    dGlassV.assign(float(0.0));
    dLitV.assign(float(0.0));
    reliefV.assign(float(0.0));
    const col = roofBase.toVar();
    // coverings, one branch per roof (a building has one)
    If(isCover(COVER.TILE).greaterThan(0.5), () => {
      // Roman tile channels run down the slope, courses across it
      const tu = u.div(0.21);
      const channel = sin(fract(tu).mul(TAU)).mul(0.5).add(0.5);
      const tv = along.div(0.36);
      const tileVar = hash2D(vec2(floor(tu), floor(tv)).add(seed.mul(13.0))).sub(0.5).mul(tileFade);
      const overlap = smoothstep(0.82, 1.0, fract(tv)).mul(0.2).mul(tileFade);
      const tileShade = mix(float(0.88), mix(float(0.72), float(1.08), channel), tileFade).mul(float(1.0).sub(overlap));
      const moss = noise2D(positionWorld.xz.mul(0.3).add(seed.mul(40.0)));
      // tiles read as plain tile colour on the flat tops of hips
      const pattern = mix(roofBase.mul(tileVar.mul(0.22).add(1.0)).mul(tileShade), roofBase.mul(0.95), step(0.95, nW.y));
      col.assign(pattern.mul(float(1.0).sub(smoothstep(0.5, 0.9, moss).mul(0.25))));
      reliefV.assign(channel.mul(0.035).mul(slope));
    });
    If(isCover(COVER.SLATE).greaterThan(0.5), () => {
      const sv = along.div(0.15);
      const su = u.div(0.3).add(mod(floor(sv), 2.0).mul(0.5));
      const slateJoint = max(filteredPulse(fract(sv), 0.0, 0.12, dA.div(0.15)), filteredPulse(fract(su), 0.0, 0.06, dU.div(0.3)));
      const slateVar = hash2D(vec2(floor(su), floor(sv)).add(seed.mul(7.0))).sub(0.5).mul(fineFade);
      col.assign(roofBase.mul(slateVar.mul(0.18).add(1.0)).mul(float(1.0).sub(slateJoint.mul(fineFade.mul(0.3).add(0.1)))));
    });
    If(isCover(COVER.ZINC).greaterThan(0.5), () => {
      const seam = filteredPulse(fract(u.div(0.55)), 0.0, 0.06, dU.div(0.55));
      col.assign(roofBase.mul(float(1.0).add(seam.mul(0.25))));
      reliefV.assign(seam.mul(0.01));
    });
    If(isCover(COVER.GRAVEL).greaterThan(0.5), () => {
      const grit = noise2D(positionWorld.xz.mul(3.0)).sub(0.5).mul(fineFade).mul(0.16);
      const gravel = grit.add(noise2D(positionWorld.xz.mul(0.2).add(seed.mul(11.0))).sub(0.5).mul(0.18));
      col.assign(roofBase.mul(gravel.add(1.0)));
    });
    If(isCover(COVER.METAL).greaterThan(0.5), () => {
      const cw = positionWorld.x.add(positionWorld.z).div(0.12);
      col.assign(roofBase.mul(float(1.0).sub(filteredPulse(fract(cw), 0.0, 0.5, mpp.div(0.12)).mul(0.12))));
    });
    // parapets, gables & lift housings in the walls' colours
    const partyGrey = mix(wallBase.mul(0.75), vec3(0.3, 0.29, 0.27), 0.45);
    const coping = mix(wallBase, vec3(0.62, 0.6, 0.56), 0.6);
    col.assign(mix(col, mix(partyGrey, coping, facingUp), isSurf(SURF.PARAPET)));
    col.assign(mix(col, mix(mix(wallBase, vec3(0.7, 0.68, 0.64), 0.5), roofBase.mul(0.9), facingUp), isSurf(SURF.HOUSING)));
    // eaves: dark timber with rafters in the Parte Vieja & on villas, painted cornice elsewhere
    If(isSurf(SURF.EAVES).greaterThan(0.5), () => {
      const rafters = filteredPulse(fract(u.div(0.6)), 0.0, 0.18, dU.div(0.6));
      const wood = vec3(0.13, 0.075, 0.04).mul(float(1.0).sub(rafters.mul(0.4)));
      col.assign(mix(mix(wallBase, vec3(0.82, 0.8, 0.76), 0.5), wood, max(sOld, sVil.mul(step(0.5, seed)))));
    });
    const chimney = mix(mix(vec3(0.3, 0.13, 0.08), wallBase, max(sOld, sVil)), vec3(0.04, 0.035, 0.03), facingUp);
    col.assign(mix(col, chimney, isSurf(SURF.CHIMNEY)));
    // dormers: painted frame, glass, a small zinc cap
    If(dormerOK.greaterThan(0.5), () => {
      const pier = min(wallV.w, runLen.mul(0.12));
      const inner = max(runLen.sub(pier.mul(2.0)), 0.01);
      const bays = max(floor(inner.div(byStyle(style, STYLE_PARAMS.map((p) => p.bay))).add(0.5)), 1.0);
      const bayW = inner.div(bays);
      const gx = u.sub(pier).div(bayW);
      const cu = fract(gx);
      const fwx = dU.div(bayW);
      const inBays = step(0.0, gx).mul(step(gx, bays));
      const dW = min(float(1.1), bayW.mul(0.5)).div(bayW);
      // (shorter on a pitched roof, where the same height runs a long way up the slope)
      const dBot = float(0.3), dTop = min(dBot.add(mix(float(1.7), float(0.9), isSurf(SURF.PITCHED))), rise.sub(0.35));
      const dormer = filteredPulse(cu, float(0.5).sub(dW.mul(0.5)), float(0.5).add(dW.mul(0.5)), fwx).mul(band(h, dBot, dTop, dH)).mul(inBays);
      const inset = float(0.13).div(bayW);
      const glassX = filteredPulse(cu, float(0.5).sub(dW.mul(0.5)).add(inset), float(0.5).add(dW.mul(0.5)).sub(inset), fwx);
      const dGlass = glassX.mul(band(h, dBot.add(0.12), dTop.sub(0.26), dH)).mul(dormer);
      const dCap = band(h, dTop.sub(0.2), dTop, dH).mul(dormer);
      const viewDir = normalize(cameraPosition.sub(positionWorld));
      const fres = pow(clamp(float(1.0).sub(abs(dot(viewDir, nW))), 0.0, 1.0), 2.0);
      const dGlassCol = mix(vec3(0.05, 0.06, 0.07), cityUniforms.uSkyHorizonColor, fres.mul(0.5).add(0.1));
      const inDormer = (mask) => mask.div(max(dormer, 0.001)).min(1.0);
      const dormerCol = mix(mix(vec3(0.5, 0.48, 0.44), dGlassCol, inDormer(dGlass)), vec3(0.28, 0.3, 0.32), inDormer(dCap));
      col.assign(mix(col, dormerCol, dormer));
      dormerV.assign(dormer);
      dGlassV.assign(dGlass);
      dLitV.assign(step(float(1.0).sub(litShare()), hash2D(vec2(floor(gx), runLen.mul(1.7)).add(seed.mul(31.0)))));
    });
    return col;
  })();

  mat.roughnessNode = mix(mix(mix(float(0.82), float(0.6), isCover(COVER.SLATE)), float(0.42), max(isCover(COVER.ZINC), isCover(COVER.METAL))), float(0.1), dGlassV)
    .add(isSurf(SURF.PARAPET).mul(0.08));
  mat.metalnessNode = max(isCover(COVER.ZINC), isCover(COVER.METAL)).mul(slope.add(step(0.95, nW.y).mul(isSurf(SURF.FLAT)))).mul(0.45).mul(float(1.0).sub(dormerV))
    .add(dGlassV.mul(0.3));
  mat.emissiveNode = vec3(1.0, 0.78, 0.5).mul(dGlassV).mul(dLitV).mul(0.65).mul(cityUniforms.uInteriorGlow);

  mat.normalNode = Fn(() => {
    const camDist = length(positionWorld.sub(cameraPosition));
    const fade = float(1.0).sub(smoothstep(20.0, 160.0, camDist)).mul(tileFade);
    const bumped = bumpNormal(reliefV.mul(fade));
    // a dormer's window stands upright out of the slope
    const upright = cameraViewMatrix.transformDirection(normalize(vec3(nW.x, 0.0, nW.z).add(vec3(0.0, 0.0, 0.0001))));
    return normalize(mix(bumped, upright, dormerV));
  })();
  return mat;
}
