import * as THREE from 'three/webgpu';
import { TIME_PRESETS } from '../lighting.js';

// js/donostia/presets.js
// The four looks of js/lighting.js re-aimed for Donostia (43.32° N, local frame x = east, z = south): the golden-hour sun
// goes down west-north-west over the sea behind Igeldo, as in the postcards from Urgull and the Kontxa. clock: the time of
// day each shows (h), for what keeps hours (the island ferries' service).

// azimuth clockwise from north, elevation above the horizon, in degrees
function sun(azimuth, elevation) {
  const a = THREE.MathUtils.degToRad(azimuth), e = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

// The camera for those looks (js/post-processing.js's options): AgX tone mapping rolls highlights off smoothly instead
// of clipping them to white (the sunlit facades of the Kontxa, the sun's glow over the Urumea) and keeps the golden and
// blue hours from turning orange; gentler than ACES in the mid-tones, so the looks expose a touch brighter by day and
// carry more saturation. Bloom only takes what is really bright (a high threshold) and stays tight (a small radius), so
// lamps and the sun glow without flooding the frame; contrast stops lifting at a luminance of 1.2.
export const DONOSTIA_CAMERA = {
  toneMapping: THREE.AgXToneMapping,
  bloomRadius: 0.22,
  contrastCeiling: 1.2,
  looks: {
    golden: { exposure: 1.12, contrast: 1.12, saturation: 1.24, balance: [1.045, 1.00, 0.955], bloom: 0.14, threshold: 1.70 },
    midday: { exposure: 1.08, contrast: 1.10, saturation: 1.22, balance: [1.015, 1.00, 0.985], bloom: 0.11, threshold: 1.90 },
    twilight: { exposure: 1.10, contrast: 1.10, saturation: 1.24, balance: [1.025, 0.995, 1.015], bloom: 0.17, threshold: 1.50 },
    midnight: { exposure: 0.96, contrast: 1.10, saturation: 1.20, balance: [0.985, 1.00, 1.035], bloom: 0.18, threshold: 1.40 }
  }
};

export const DONOSTIA_PRESETS = {
  golden: { ...TIME_PRESETS.golden, name: 'Ilunabarra · 20:30', clock: 20.5, sunDir: sun(290, 11), fogDensity: 0.00020 },
  midday: { ...TIME_PRESETS.midday, name: 'Eguerdia · 14:00', clock: 14, sunDir: sun(195, 63), fogDensity: 0.00015 },
  twilight: { ...TIME_PRESETS.twilight, name: 'Ordu urdina · 21:40', clock: 21 + 40 / 60, sunDir: sun(302, 5) },
  midnight: { ...TIME_PRESETS.midnight, name: 'Gaua · 23:30', clock: 23.5, sunDir: sun(150, 38) }
};
