import * as THREE from 'three/webgpu';
import { buildFacadeCells } from './facade-mesh.js';
import { createFacadeMaterial, createRoofMaterial } from './facade-material.js';

// js/donostia/buildings.js
// Every building of the municipal 1:500 map (Donostiako Udala, CC BY-SA 3.0) extruded from its LiDAR ground to the
// eaves measured by b5m (Gipuzkoa, CC BY 4.0), dressed in the facade vocabulary of its part of town (see
// facade-style.js), with walls hidden where neighbours stand against them, roofs inferred from the gap between b5m's
// mean and maximum height (hips, gables against party walls, mansards with dormers, eaves, parapets, lift housings,
// chimneys) and the miradores of the Área Romántica (facade-mesh.js). Shaders: facade-material.js.
// Geometry is merged per 512 m cell: two draw calls per cell, while the camera frustum still culls whole cells.

const WALL_ATTRIBUTES = ['facade', 'binfo', 'bcol', 'acol'];
const ROOF_ATTRIBUTES = ['rfac', 'rinfo', 'bcol', 'rcol'];

function toGeometry(part, names) {
  if (!part.ni) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(part.pos.slice(0, part.n * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(part.nrm.slice(0, part.n * 3), 3));
  geo.setAttribute(names[0], new THREE.BufferAttribute(part.fa.slice(0, part.n * 4), 4));
  geo.setAttribute(names[1], new THREE.BufferAttribute(part.fb.slice(0, part.n * 4), 4));
  // colours & flags as normalised bytes (unorm8x4)
  geo.setAttribute(names[2], new THREE.BufferAttribute(part.ca.slice(0, part.n * 4), 4, true));
  geo.setAttribute(names[3], new THREE.BufferAttribute(part.cb.slice(0, part.n * 4), 4, true));
  geo.setIndex(new THREE.BufferAttribute(part.index.slice(0, part.ni), 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

// hidden: GEO.buildings indices the landmarks replace; replace & phantoms: see buildFacadeCells (facade-mesh.js)
export function buildDonostiaBuildings(GEO, { hidden = new Set(), replace = null, phantoms = null } = {}) {
  const group = new THREE.Group();
  group.name = 'DonostiaBuildings';
  const triangulate = (contour, holes) => THREE.ShapeUtils.triangulateShape(contour, holes);
  const { cells, stats } = buildFacadeCells(GEO, { hidden, replace, phantoms, triangulate });
  const facadeMat = createFacadeMaterial();
  const roofMat = createRoofMaterial();
  for (const cell of cells.values()) {
    for (const [part, mat, names] of [[cell.walls, facadeMat, WALL_ATTRIBUTES], [cell.roofs, roofMat, ROOF_ATTRIBUTES]]) {
      const geo = toGeometry(part, names);
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
  }
  group.userData.stats = stats;
  return group;
}
