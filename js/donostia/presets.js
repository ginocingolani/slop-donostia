import * as THREE from 'three/webgpu';
import { TIME_PRESETS } from '../lighting.js';

// js/donostia/presets.js
// The four looks of js/lighting.js re-aimed for Donostia (43.32° N, local frame x = east, z = south): the golden-hour sun
// goes down west-north-west over the sea behind Igeldo, as in the postcards from Urgull and the Kontxa. clock: the time of
// day each shows (h), for what keeps hours (the island ferries' service); daylight: how much of it each look stands for
// (cityUniforms.uDaylight). With the HUD's real-time switch on they are the keyframes of js/donostia/time-of-day.js, and
// the hours are the city's own (js/donostia/live-sky.js).

// azimuth clockwise from north, elevation above the horizon, in degrees
function sun(azimuth, elevation) {
  const a = THREE.MathUtils.degToRad(azimuth), e = THREE.MathUtils.degToRad(elevation);
  return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
}

export const DONOSTIA_PRESETS = {
  golden: { ...TIME_PRESETS.golden, name: 'Ilunabarra · 20:30', clock: 20.5, daylight: 0.72, sunDir: sun(290, 11), fogDensity: 0.00020 },
  midday: { ...TIME_PRESETS.midday, name: 'Eguerdia · 14:00', clock: 14, daylight: 1, sunDir: sun(195, 63), fogDensity: 0.00015 },
  twilight: { ...TIME_PRESETS.twilight, name: 'Ordu urdina · 21:40', clock: 21 + 40 / 60, daylight: 0.3, sunDir: sun(302, 5) },
  midnight: { ...TIME_PRESETS.midnight, name: 'Gaua · 23:30', clock: 23.5, daylight: 0.05, sunDir: sun(150, 38) }
};
