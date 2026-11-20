import * as THREE from 'three/webgpu';
import { texture, float, vec2, vec3, max, min, length } from 'three/tsl';
import { cityUniforms } from '../city-uniforms.js';
import { STREETLIGHT } from './data-streetlight.js';
import { decodePNGOffThread } from './png.js';

// js/donostia/street-light.js
// The city's public lighting as the things near the ground see it. There are no real lights (fourteen thousand lamps,
// and phones): tools/donostia/bake-streetlight.mjs sums what every street lamp (OSM's mapped ones, La Concha's, the
// Parte Vieja's lanterns and the ones it places along every street that has none mapped) throws on the ground into one
// grey map of the core, 2 m a texel, buildings shadowing it; the ground, the facades' lower storeys, the trees and the
// street furniture read it where they stand and add it, times their own colour, as light of a warm-white LED's colour
// (Donostia's streets were relamped from sodium to 3000 K LED in the 2010s). It is emitted, not reflected: it needs no
// light in the scene, casts no shadows of its own and costs one filtered texture read per pixel.
//
// It comes on and goes off with cityUniforms.uStreetLight (js/lighting.js: the presets' `streetLight`, 0 by day, and
// js/donostia/time-of-day.js for the real-time switch), which every reader multiplies by: by day the term is exactly
// zero and the picture is what it was, with the same shaders.
//
// The map is a download of its own (data/donostia/street-light.png, about 0.95 MB; 7 MB on the GPU with its mips) that
// starts when the first reader is made and never holds the city up: until it arrives, and if it fails, the readers
// see a black texel (no lamplight, as before). loadStreetLight({ coarse: true }) takes the 4 m map instead
// (street-light-low.png, 0.35 MB; 1.8 MB on the GPU): the lowest quality tier's, asked by js/donostia/ground.js when
// it is given the terrain's classes instead of the baked ground maps.
//
//   streetLight(xz)             -> float node: the lamplight at a world position (0 by day; 1 is right under an
//                                  avenue's lamp), 0 outside the core
//   streetLit(albedo, xz, gain) -> vec3 node for an emissiveNode: that light on a surface of that colour
//   lamplit(albedo, light)      -> the same from a light already read (streetLight()'s, times the reader's own falloff)
//   lampMirrored(p, eye, ...)   -> float node: the lamps mirrored in a wet or watery surface at p seen from eye
//   LAMP_COLOUR                 -> the light's colour (linear)

const { map: MAP, origin: ORIGIN } = STREETLIGHT;
const CORE_W = 4200, CORE_D = 5120; // m (tools/donostia/frame.json's core, which the map covers)

/** The lamplight's colour (linear rgb): a 3000 K LED through a diffuser, a touch towards sodium's amber. */
export const LAMP_COLOUR = [1.0, 0.66, 0.36];
// how bright a white, flat surface right under an avenue's lamp is (scene-linear, before the exposure)
const GAIN = 1.15;

function mapTexture(data, w, h, mips) {
  const t = new THREE.DataTexture(data, w, h, THREE.RedFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.generateMipmaps = mips;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; // (the map's rim is black: nothing beyond the core)
  t.needsUpdate = true;
  return t;
}

// one node for every reader: its texture is swapped for the map once that is decoded
const dark = mapTexture(new Uint8Array(4), 2, 2, false);
const mapNode = texture(dark);
let loaded = null; // 'fine' | 'coarse'
let asked = null;

/**
 * Starts the light map's download (once per resolution; a second call with the other one swaps it, as a quality tier
 * picked in a running city does). Resolves to true when the map is in place, false when it could not be had.
 */
export function loadStreetLight({ coarse = false } = {}) {
  const want = coarse ? 'coarse' : 'fine';
  if (asked?.want === want) return asked.promise;
  const url = coarse ? MAP.urlLow : MAP.url;
  const promise = (async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const img = await decodePNGOffThread(await res.arrayBuffer());
      if (img.channels !== 1) throw new Error(`${url}: not a grey map`);
      if (asked?.want !== want) return false; // another resolution was asked for meanwhile
      const old = mapNode.value;
      mapNode.value = mapTexture(img.data, img.width, img.height, true);
      if (old !== dark) old.dispose();
      loaded = want;
      return true;
    } catch (e) {
      console.warn('[street-light] the light map is unavailable: the streets stay dark', e);
      return false;
    }
  })();
  asked = { want, promise };
  return promise;
}

/** Which map is in place ('fine', 'coarse' or null), for slopDebug and the tests. */
export const streetLightState = () => ({ loaded, asked: asked?.want ?? null });

/** The lamplight at world position xz (vec2 node), times the night's switch: 0 by day, ~1 under an avenue's lamp. */
export function streetLight(xz) {
  const uvw = vec2(xz).sub(vec2(ORIGIN[0], ORIGIN[1])).div(vec2(CORE_W, CORE_D));
  // the byte is sqrt(E / max) (the bake's coding: finer steps in the dim light between the lamps)
  const s = mapNode.sample(uvw).r;
  return s.mul(s).mul(MAP.max).mul(cityUniforms.uStreetLight);
}

// the map read at a given mip level (no screen-space derivatives: it may be read inside a branch)
function streetLightLevel(xz, lod) {
  const uvw = vec2(xz).sub(vec2(ORIGIN[0], ORIGIN[1])).div(vec2(CORE_W, CORE_D));
  const s = mapNode.sample(uvw).level(lod).r;
  return s.mul(s).mul(MAP.max).mul(cityUniforms.uStreetLight);
}

/**
 * The street lamps mirrored in a level, glossy surface (a puddle, the bay) at world position p (vec3 node), seen from
 * `eye` (vec3 node): a float node, 0 by day. A lamp `h` metres over the surface shows where the line of sight, mirrored,
 * has climbed h: over the ground h / (the eye's height) times as far beyond p as p is from the eye. There the map is
 * bright under a lamp, and squared it stands for the lamp itself. Two heights (the lamp and twice it) draw the image
 * out towards the eye as ripples do, `wobble` (vec2 node, m) moves it with the surface's own, and no image is looked
 * for further than `reach` metres beyond p, where buildings would hide the lamp anyway.
 */
export function lampMirrored(p, eye, { height = 5, reach = 70, wobble = vec2(0.0), lod = 1 } = {}) {
  const from = vec2(p.xz.sub(eye.xz));
  const up = max(eye.y.sub(p.y), 0.5);
  const tap = (h) => {
    const off = from.mul(float(h).div(up));
    const l = max(length(off), 0.001);
    const e = streetLightLevel(p.xz.add(off.mul(min(l, reach).div(l))).add(wobble.mul(h)), lod);
    return e.mul(e);
  };
  return tap(height).add(tap(height * 2.2).mul(0.6));
}

/** A light read with streetLight() (a float node) on a surface of colour `albedo` (vec3 node), for an emissiveNode. */
export function lamplit(albedo, light) {
  return vec3(albedo).mul(vec3(...LAMP_COLOUR)).mul(float(light).mul(GAIN));
}

/** The lamplight on a surface of colour `albedo` (vec3 node) at xz, for an emissiveNode; gain: its own share. */
export function streetLit(albedo, xz, gain = 1) {
  return lamplit(albedo, streetLight(xz).mul(gain));
}
