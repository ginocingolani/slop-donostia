import * as THREE from 'three/webgpu';
import {
  texture, float, vec2, vec3, max, min, mix, length, smoothstep, positionWorld, normalWorld, materialColor, materialEmissive,
  vertexColor, uv
} from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { STREETLIGHT } from './data-streetlight.js';
import { decodePNGOffThread } from './png.js';
import { releaseImageData } from './terrain.js';

// js/donostia/street-light.js
// The city's public lighting as the things near the ground see it. There are no real lights (thirteen thousand lamps,
// and phones): tools/donostia/bake-streetlight.mjs sums what every street lamp (OSM's mapped ones, La Concha's, the
// Parte Vieja's lanterns and the ones it places along every street that has none mapped) throws on the ground into one
// grey map of the core, 2 m a texel, buildings shadowing it; the ground, the facades' lower storeys, the trees, the
// street furniture, the landmarks, the walls, the port and its boats read it where they stand and add it, times their
// own colour, as light of a warm-white LED's colour (Donostia's streets were relamped from sodium to 3000 K LED in the
// 2010s). It is emitted, not reflected: it needs no light in the scene, casts no shadows of its own and costs one
// filtered texture read per pixel.
//
// It comes on and goes off with cityUniforms.uStreetLight (js/lighting.js: the presets' `streetLight`, 0 by day, and
// js/donostia/time-of-day.js for the real-time switch), which every reader multiplies by: by day the term is exactly
// zero and the picture is what it was, with the same shaders.
//
// The texture has two bytes a texel: the light (the baked map) and the ground's height (m, from the terrain the app
// has loaded anyway, raised to the bridges' decks where js/donostia/bridges.js says they are), so that anything can
// tell how far above the street it stands without an attribute of its own: lamps hang 4 to 9 m up, and what they
// light fades above them (streetLightOn()). The buildings' facades and the trees carry their own heights and read the
// light alone.
//
// The map is a download of its own (data/donostia/street-light.png, about 0.9 MB; 14 MB on the GPU with the heights
// and the mips) that starts when the ground's material is made and never holds the city up: until it arrives, and if
// it fails, the readers see a black texel (no lamplight, as before). loadStreetLight({ coarse: true }) takes the 4 m
// map instead (street-light-low.png, 0.3 MB; 3.6 MB on the GPU): the lowest quality tier's, asked by
// js/donostia/ground.js when it is given the terrain's classes instead of the baked ground maps.
//
//   streetLight(xz)              -> float node: the lamplight at a world position (0 by day; 1 is right under an
//                                   avenue's lamp), 0 outside the core
//   streetLit(albedo, xz, gain)  -> vec3 node for an emissiveNode: that light on a surface of that colour
//   lamplit(albedo, light)       -> the same from a light already read (streetLight()'s, times the reader's own falloff)
//   streetLightOn(position, normal) -> float node: the light on a surface anywhere, by its height over the street
//   takeStreetLight(material)    -> adds that light to a material's emissive, whatever it is made of
//   lampMirrored(p, eye, ...)    -> float node: the lamps mirrored in a wet or watery surface at p seen from eye
//   raiseStreetGround(areas)     -> the bridges' decks (or any other raised street) for the height channel

const { map: MAP, origin: ORIGIN } = STREETLIGHT;
const CORE_W = 4200, CORE_D = 5120; // m (tools/donostia/frame.json's core, which the map covers)

/** The lamplight's colour (linear rgb): a 3000 K LED through a diffuser, a touch towards sodium's amber. */
export const LAMP_COLOUR = [1.0, 0.66, 0.36];
// how bright a white, flat surface right under an avenue's lamp is (scene-linear, before the exposure)
const GAIN = 1.15;
// the height channel: a byte is a metre above sea level, 0 to 255 (Ulia's top stands at 235 m)
const HEIGHT_MAX = 255;

function mapTexture(data, w, h, mips) {
  const t = new THREE.DataTexture(data, w, h, THREE.RGFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; // (the map's rim is black: nothing beyond the core)
  t.needsUpdate = true;
  if (mips) t.onUpdate = releaseImageData; // only the shaders read it
  return t;
}

// one node for every reader: its texture is swapped for the map once that is decoded
const dark = mapTexture(new Uint8Array(8), 2, 2, false);
const mapNode = texture(dark);
let loaded = null; // 'fine' | 'coarse'
let asked = null;
let raised = []; // raiseStreetGround()'s areas
let retired = null; // the texture the one in place replaced

// The light bytes and the terrain's heights (js/donostia/terrain.js's core HeightField: its samples are the map's
// texels, or 2 x 2 of them for the coarse map) as the texture's two bytes a texel
function lightAndHeight(light, w, h, field) {
  const data = new Uint8Array(2 * w * h);
  const step = field ? Math.round(field.w / w) : 1, x0 = ORIGIN[0], z0 = ORIGIN[1], res = CORE_W / w;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      data[2 * k] = light[k];
      if (!field) continue;
      let y;
      if (step === 1) y = field.heights[k];
      else {
        const a = 2 * j * field.w + 2 * i;
        y = (field.heights[a] + field.heights[a + 1] + field.heights[a + field.w] + field.heights[a + field.w + 1]) / 4;
      }
      data[2 * k + 1] = Math.min(HEIGHT_MAX, Math.max(0, Math.round(y)));
    }
  }
  for (const area of raised) {
    const i0 = Math.max(0, Math.floor((area.minX - x0) / res)), i1 = Math.min(w - 1, Math.ceil((area.maxX - x0) / res));
    const j0 = Math.max(0, Math.floor((area.minZ - z0) / res)), j1 = Math.min(h - 1, Math.ceil((area.maxZ - z0) / res));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const y = area.heightAt(x0 + (i + 0.5) * res, z0 + (j + 0.5) * res);
        if (y != null) data[2 * (j * w + i) + 1] = Math.min(HEIGHT_MAX, Math.max(data[2 * (j * w + i) + 1], Math.round(y)));
      }
    }
  }
  return data;
}

/**
 * Starts the light map's download (once per resolution; a second call with the other one swaps it, as a quality tier
 * picked in a running city does). terrain: js/donostia/terrain.js's, for the heights. Resolves to true when the map
 * is in place, false when it could not be had.
 */
export function loadStreetLight({ coarse = false, terrain = null, again = false } = {}) {
  const want = coarse ? 'coarse' : 'fine';
  if (asked?.want === want && !again) return asked.promise;
  const field = terrain?.core ?? asked?.field ?? null;
  const url = coarse ? MAP.urlLow : MAP.url;
  const ticket = {};
  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const img = await decodePNGOffThread(await res.arrayBuffer());
      if (img.channels !== 1) throw new Error(`${url}: not a grey map`);
      if (asked?.ticket !== ticket) return false; // asked again meanwhile (another resolution, or the decks)
      const fits = field && field.heights && (field.w === img.width || field.w === 2 * img.width);
      // The texture before this one may still be bound by shaders compiling in the background (a quality tier picked
      // in a running city compiles for a while), and one disposed under them would be uploaded again, without its
      // released bytes: it lives until the next swap, and the one before it goes now
      if (retired && retired !== dark) retired.dispose();
      retired = mapNode.value;
      mapNode.value = mapTexture(lightAndHeight(img.data, img.width, img.height, fits ? field : null), img.width, img.height, true);
      loaded = want;
      return true;
    } catch (e) {
      console.warn('[street-light] the light map is unavailable: the streets stay dark', e);
      return false;
    }
  })();
  asked = { want, promise, field, ticket };
  return promise;
}

/**
 * Streets that run above the terrain (the bridges' decks): areas [{ minX, maxX, minZ, maxZ, heightAt(x, z) -> m or
 * null }]. What stands on them is then lit as on a street, and what hangs under them is not. If the map is in place
 * already it is made again (from the browser's cache).
 */
export function raiseStreetGround(areas) {
  raised = areas || [];
  if (asked) loadStreetLight({ coarse: asked.want === 'coarse', again: true });
}

/** Which map is in place ('fine', 'coarse' or null), for slopDebug and the tests. */
export const streetLightState = () => ({ loaded, asked: asked?.want ?? null });

const mapUV = (xz) => vec2(xz).sub(vec2(ORIGIN[0], ORIGIN[1])).div(vec2(CORE_W, CORE_D));
// the byte is sqrt(E / max) (the bake's coding: finer steps in the dim light between the lamps)
const decoded = (s) => s.mul(s).mul(MAP.max).mul(cityUniforms.uStreetLight);

/** The lamplight at world position xz (vec2 node), times the night's switch: 0 by day, ~1 under an avenue's lamp. */
export function streetLight(xz) {
  return decoded(mapNode.sample(mapUV(xz)).r);
}

// the map read at a given mip level (no screen-space derivatives: it may be read inside a branch)
function streetLightLevel(xz, lod) {
  return decoded(mapNode.sample(mapUV(xz)).level(lod).r);
}

/**
 * The lamplight on a surface anywhere in the city (a float node, 0 by day): what falls on the street 1.5 m in front of
 * it (under it, for a floor), by how far above that street it stands. All of it (0.85: a wall takes the light at a
 * slant) at the street's level, half 7 m up, a tenth at 20 m, as on the buildings' facades; nothing on what faces the
 * sky above the lamps (roofs, terraces: from 4 m up, none from 9 m), and nothing on what hangs below the street (a
 * bridge's piers and soffit, a quay's face under its edge is lit from the water's side or not at all).
 */
export function streetLightOn(position = positionWorld, normal = normalWorld) {
  const s = mapNode.sample(mapUV(position.xz.add(normal.xz.mul(1.5))));
  const h = position.y.sub(s.g.mul(255.0));
  const fall = float(0.85).div(max(h, 0.0).div(7.0).pow2().add(1.0)).mul(smoothstep(-2.5, -0.5, h))
    .mul(mix(float(1.0), smoothstep(9.0, 4.0, h), max(normal.y, 0.0)));
  return decoded(s.r).mul(fall);
}

/** A light read with streetLight() (a float node) on a surface of colour `albedo` (vec3 node), for an emissiveNode. */
export function lamplit(albedo, light) {
  return vec3(albedo).mul(vec3(...LAMP_COLOUR)).mul(float(light).mul(GAIN));
}

/** The lamplight on a surface of colour `albedo` (vec3 node) at xz, for an emissiveNode; gain: its own share. */
export function streetLit(albedo, xz, gain = 1) {
  return lamplit(albedo, streetLight(xz).mul(gain));
}

/**
 * Gives a material the street lamps' light at night, on top of whatever it emits already (a landmark's floodlights,
 * its lit windows: those stay what lights it; the lamps add to its lower metres). The colour is the material's own:
 * its colorNode, or its colour (times its map and its vertex colours, as the renderer has them). Once per material;
 * not for what is no surface (a glow, a beam, a line: unlit or additive materials) nor one that says
 * userData.noStreetLight. Returns the material.
 */
export function takeStreetLight(material, gain = 1) {
  const m = material;
  if (!m || !m.isNodeMaterial || m.userData.streetLight || m.userData.noStreetLight) return m;
  if (!(m.isMeshStandardNodeMaterial || m.isMeshPhysicalNodeMaterial || m.isMeshLambertNodeMaterial || m.isMeshPhongNodeMaterial)) return m;
  if (m.blending === THREE.AdditiveBlending) return m;
  let albedo;
  if (m.colorNode) albedo = vec3(m.colorNode);
  else {
    albedo = materialColor;
    if (m.map) albedo = albedo.mul(texture(m.map, uv()).rgb);
    if (m.vertexColors) albedo = albedo.mul(vertexColor().rgb);
  }
  m.emissiveNode = (m.emissiveNode || materialEmissive).add(lamplit(albedo, streetLightOn().mul(gain)));
  m.userData.streetLight = true;
  return m;
}

/** takeStreetLight() for every material under an object (a landmark's model). */
export function takeStreetLightAll(object, gain = 1) {
  object.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) takeStreetLight(m, gain);
  });
  return object;
}

/**
 * The street lamps mirrored in a level, glossy surface (a puddle, the bay) at world position p (vec3 node), seen from
 * `eye` (vec3 node): a float node, 0 by day. A lamp `h` metres over the surface shows where the line of sight, mirrored,
 * has climbed h: over the ground h / (the eye's height) times as far beyond p as p is from the eye. There the map is
 * bright under a lamp, and squared it stands for the lamp itself (`core` [from, to]: only the light right under a
 * lamp counts, from nothing to all of it between the two: a tighter image, for the open water). Two heights (the lamp and twice it) draw
 * the image out towards the eye as ripples do, `wobble` (vec2 node: twice the surface's tilt) breaks it into glints as the ripples do, and no image
 * is looked for further than `reach` metres beyond p, where buildings would hide the lamp anyway.
 */
export function lampMirrored(p, eye, { height = 5, reach = 70, wobble = vec2(0.0), lod = 1, core = null } = {}) {
  const from = vec2(p.xz.sub(eye.xz));
  const up = max(eye.y.sub(p.y), 0.5);
  const tap = (h) => {
    const off = from.mul(float(h).div(up));
    const l = max(length(off), 0.001);
    // (a ripple's tilt throws the image aside by twice the tilt over the way to the lamp)
    const e = streetLightLevel(p.xz.add(off.mul(min(l, reach).div(l))).add(wobble.mul(min(l, reach).add(h))), lod);
    const lit = core ? smoothstep(core[0], core[1], e) : e;
    return lit.mul(lit);
  };
  return tap(height).add(tap(height * 2.2).mul(0.6));
}
