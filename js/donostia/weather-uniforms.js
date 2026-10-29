import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// js/donostia/weather-uniforms.js
// The uniforms through which the real-time weather (js/donostia/weather.js) moves the city's own shaders: the trees'
// sway (trees-material.js), the flags (the tifo's, Alderdi Eder's ikurriña) and the rain on the puddles (ground.js).
// Their defaults are the city as it is with the real-time switch off, today's fixed breeze from the north-west, so a
// shader reading them gives exactly its old picture until the weather moves them. The streets' wetness from the rain
// is cityUniforms.uRainWetness (js/city-uniforms.js), next to the time of day's uRoadWetness.

export const weatherUniforms = {
  // the way the wind blows (xz, unit): the trees' old fixed breeze from the north-west
  uWindDir: uniform(new THREE.Vector2(0.6, 0.8)),
  // the trees' sway, bob & flutter against that breeze (1: as today)
  uWindSway: uniform(1),
  // the trees' steady lean downwind (m at 11 m up; 0: none, as today)
  uWindLean: uniform(0),
  // a phase added to the gusts rolling across the city (radians; the CPU runs it on with the wind's speed)
  uGustPhase: uniform(0),
  // the flags: how far the tifo's turn to stream downwind (0: as the fans hold them), their cloth's flapping (1: as
  // today) and its phase (radians, run on with the wind)
  uFlagStream: uniform(0),
  uFlagFlap: uniform(1),
  uFlagPhase: uniform(0),
  // the wind at the flags' height (m/s, gusts included), for the flags that fly only with the switch on
  uFlagWind: uniform(0),
  // rain falling now on the puddles (0..1: their ripples)
  uRainfall: uniform(0)
};
