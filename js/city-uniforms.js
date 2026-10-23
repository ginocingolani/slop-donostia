import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// js/city-uniforms.js
// Shared lighting uniforms that the time-of-day presets (lighting.js) drive and the city's materials read. Its own
// module so a city can use the lighting without loading tsl-materials.js (and with it New York's city-config & geodata).

const cityUniforms = {
  uSunColor: uniform(new THREE.Color(0xffca92)),
  uSkyTopColor: uniform(new THREE.Color(0x2c568c)),
  uSkyHorizonColor: uniform(new THREE.Color(0xebd1b5)),
  uSkySunDir: uniform(new THREE.Vector3(-0.66, 0.34, -0.67).normalize()),
  uInteriorGlow: uniform(0.78),
  uRoadWetness: uniform(0.38),
  uCanyonBounce: uniform(0.52)
};

export { cityUniforms };
