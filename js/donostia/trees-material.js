import * as THREE from 'three/webgpu';
import {
  Fn, If, float, vec2, vec3, vec4, color, attribute, uniform, varying, uv, texture, time, sin, cos, abs, floor, fract, mix,
  step, smoothstep, clamp, max, dot, length, normalize, pow, select, frontFacing, positionLocal, positionGeometry,
  normalLocal, normalGeometry, normalView, normalViewGeometry, positionViewDirection, cameraViewMatrix, instanceIndex,
  storage, transformNormal
} from 'three/tsl';

// js/donostia/trees-material.js
// Materials of Donostia's trees (js/donostia/vegetation.js). Adapted from createTreeMaterial, FoliageLightingModel,
// TreeNodeMaterial, hash2D & noise2D in js/tsl-materials.js (slop-newyork, MIT), without New York's street-canyon
// occlusion and with a bark per species.
// - createTreeMaterial: the near & mid levels (one instanced draw per species / variant / level). Attributes as
//   upstream: uv (atlas on cards, metres on bark), normal (crown-shell normals on cards), aTree (vec4: leaf flag,
//   crown occlusion, sway weight, per-card random); per tree, from two storage buffers shared by all the meshes
//   (vegetation.js), its matrix and its data (vec4: linear foliage tint, species + random).
// - createFarTreeMaterial: one draw for the far trees in view (an InstancedBufferGeometry of the unit far tree from
//   trees-species.js), shaped per instance (aFarPos: x, y, z, yaw; aFarShape: crown centre height, crown radius,
//   crown half-height, trunk radius) and folded away where the near & mid meshes stand (within uMidEnd of uLodCenter,
//   the camera position of the last level pass, exactly as vegetation.js chose them) or beyond uFarEnd.
// - createBillboardTreeMaterial: the far trees beyond vegetation.js's BILLBOARD_START, one camera-facing quad each.

// Fast deterministic 2D -> 1D hash
const hash2D = Fn(([p]) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453)));

// Smooth 2D value noise
const noise2D = Fn(([p]) => {
  const pv = vec2(p).toVar();
  const i = floor(pv).toVar();
  const f = fract(pv).toVar();
  const u = f.mul(f).mul(float(3.0).sub(f.mul(2.0))).toVar();
  const a = hash2D(i);
  const b = hash2D(i.add(vec2(1.0, 0.0)));
  const c = hash2D(i.add(vec2(0.0, 1.0)));
  const d = hash2D(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
});

// Sunlight shining through leaves (Barré-Brisebois & Bouchard's fast translucency approximation): looking against
// the light, a leaf glows with the light it lets through. It takes the direct light's colour, so shadows (the crown's
// own included) dim it like the sunlit side. Materials set `translucencyNode` (vec3, 0 where nothing shines through)
// and may set `directOcclusionNode` (float): the share of the direct light that reaches the leaf (the far crowns'
// stand-in for their own shadow where the sun's shadow maps don't reach).
class FoliageLightingModel extends THREE.PhysicalLightingModel {
  direct(lightData, builder) {
    const occlusion = builder.material.directOcclusionNode;
    if (occlusion) lightData = { ...lightData, lightColor: lightData.lightColor.mul(occlusion) };
    const { lightDirection, lightColor, reflectedLight } = lightData;
    const translucency = builder.material.translucencyNode;
    if (translucency) {
      const scatter = normalize(lightDirection.add(normalView.mul(0.3)));
      const through = pow(clamp(dot(positionViewDirection, scatter.negate()), 0.0, 1.0), 3.0);
      reflectedLight.directDiffuse.addAssign(lightColor.mul(translucency).mul(through));
    }
    super.direct(lightData, builder);
  }
}

class DonostiaTreeMaterial extends THREE.MeshStandardNodeMaterial {
  static get type() {
    return 'DonostiaTreeMaterial';
  }

  constructor(parameters) {
    super(parameters);
    this.translucencyNode = null;
    this.directOcclusionNode = null;
  }

  setupLightingModel() {
    return new FoliageLightingModel();
  }
}

// Prevailing wind (xz): the north-westerlies off the Bay of Biscay, blowing south-east over the city
const TREE_WIND = vec2(0.6, 0.8);

// Bark by species (uv in metres: x round the stem, y along it), species order of trees-species.js SPECIES
const barkColour = Fn(([species, bu, rnd]) => {
  const n1 = noise2D(vec2(bu.x.mul(5.0), bu.y.mul(1.1)).add(rnd.mul(17.0)));
  const n2 = noise2D(bu.mul(vec2(3.2, 1.9)).add(rnd.mul(31.0)));
  const ridge = float(1.0).sub(abs(n1.sub(0.5).mul(2.0)));
  // 0 London plane: olive bark flaking to cream & tan
  const plane = mix(mix(color(0x645e4b), color(0x948c73), smoothstep(0.56, 0.66, n2)), color(0x4a3f31), float(1.0).sub(smoothstep(0.22, 0.3, n2)));
  // 1 tamarisk: dark, deeply fissured, the fissures winding round the twisted stem
  const twist = noise2D(vec2(bu.x.add(bu.y.mul(0.7)).mul(6.0), bu.y.mul(1.6)).add(rnd.mul(7.0)));
  const tamarisk = mix(color(0x241d18), color(0x5a4b3f), smoothstep(0.45, 0.85, float(1.0).sub(abs(twist.sub(0.5).mul(2.0)))));
  // 2 lime & broadleaf: furrowed grey-brown ridges
  const furrowed = mix(color(0x2e261f), color(0x5c5043), smoothstep(0.35, 0.9, ridge));
  // 3 magnolia & holm oak: smooth grey with darker blotches
  const smoothGrey = mix(color(0x4a4741), color(0x6d6961), smoothstep(0.3, 0.7, n2));
  // 4 pine: reddish plates between dark cracks
  const plates = noise2D(bu.mul(vec2(3.5, 1.6)).add(rnd.mul(13.0)));
  const pine = mix(color(0x2a1d16), mix(color(0x6b3f2a), color(0x8f6044), n1), smoothstep(0.32, 0.42, plates));
  // 5 palm: the diamond scars of old leaf bases
  const da = fract(bu.x.mul(3.0).add(bu.y.mul(2.6))), db = fract(bu.x.mul(3.0).sub(bu.y.mul(2.6)));
  const scar = float(1.0).sub(smoothstep(0.0, 0.08, da)).max(float(1.0).sub(smoothstep(0.0, 0.08, db)));
  const palm = mix(mix(color(0x6e604c), color(0x8a7a60), n2), color(0x3a3127), scar);
  const s = species;
  return select(s.lessThan(0.5), plane, select(s.lessThan(1.5), tamarisk, select(s.lessThan(2.5), furrowed,
    select(s.lessThan(3.5), smoothGrey, select(s.lessThan(4.5), pine, palm)))));
});

// Foliage colour from the per-tree tint and the atlas texel: a share of sun-yellowed and of cooler leaves, brown twigs
const foliageColour = Fn(([tint, leaf]) => {
  const base = tint.mul(leaf.r.mul(1.4));
  const warm = smoothstep(0.62, 1.0, leaf.g).mul(0.55);
  const cool = float(1.0).sub(smoothstep(0.0, 0.38, leaf.g)).mul(0.45);
  const leafCol = mix(mix(base, base.mul(vec3(1.25, 1.08, 0.5)), warm), base.mul(vec3(0.8, 0.92, 1.05)), cool);
  return mix(leafCol, color(0x4a3b2c), leaf.b);
});

/**
 * Instanced near & mid level tree material: bark tubes and alpha-tested leaf cards in one draw per mesh.
 */
export function createTreeMaterial(leafAtlas, instances) {
  // The alpha test is given as nodes (alphaTestNode on the scene pass, maskShadowNode in the shadow maps) rather than
  // `alphaTest`, which the shadow passes copy onto a shared shadow material (see createTreeMaterial upstream)
  const mat = new DonostiaTreeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0.0, roughness: 0.8 });

  // Instancing by hand (what three's instance() does for an InstancedMesh): every near & mid mesh reads its trees from
  // one pair of storage buffers, starting at its own offset (a per-object uniform), so the 24 meshes share one shader
  // and one pipeline per pass instead of compiling 24 (an InstancedMesh's buffer gets a name of its own in the code)
  const base = uniform(0, 'uint').onObjectUpdate(({ object }) => object.userData.instanceBase);
  const index = instanceIndex.add(base);
  const instanceMatrix = storage(instances.matrices, 'mat4', instances.matrices.count).element(index);
  const aData = varying(storage(instances.data, 'vec4', instances.data.count).element(index), 'vTreeData');

  const aTree = attribute('aTree', 'vec4');
  const isLeaf = aTree.x;
  const crownAO = aTree.y;
  const rnd = fract(aData.w);
  const species = floor(aData.w);
  const leaf = texture(leafAtlas, uv());

  // Wind. positionLocal is instanced first (world space); positionGeometry is the tree's own frame (metres)
  mat.positionNode = Fn(() => {
    positionLocal.assign(instanceMatrix.mul(positionLocal).xyz);
    normalLocal.assign(transformNormal(normalLocal, instanceMatrix));
    const p = positionLocal;
    const g = positionGeometry;
    const phase = rnd.mul(6.2832);
    // gusts rolling downwind across the city
    const gust = sin(time.mul(0.5).sub(dot(p.xz, TREE_WIND).mul(0.045))).mul(0.5).add(0.5);
    const strength = gust.mul(gust).mul(0.7).add(0.3);
    // the whole tree bends with height, leaning downwind and rocking across it
    const h = g.y.div(11.0);
    const bend = h.mul(h);
    const lean = sin(time.mul(0.85).add(phase)).mul(0.45).add(0.55).mul(strength).mul(0.2);
    const rock = sin(time.mul(0.67).add(phase.mul(1.7))).mul(0.06).mul(strength);
    const sway = vec3(TREE_WIND.x.mul(lean).sub(TREE_WIND.y.mul(rock)), 0.0, TREE_WIND.y.mul(lean).add(TREE_WIND.x.mul(rock))).mul(bend);
    // branches bob, the phase flowing smoothly through the crown so joints stay together
    const bob = sin(time.mul(2.1).add(g.x.mul(0.9)).add(g.z.mul(0.7)).add(phase)).mul(0.05).mul(aTree.z).mul(strength);
    // leaves flutter, every card on its own
    const flutter = sin(time.mul(8.0).add(aTree.w.mul(37.0)).add(g.y.mul(2.0))).mul(0.03).mul(isLeaf).mul(aTree.z).mul(strength.add(0.25));
    return p.add(sway).add(vec3(0.0, bob, 0.0)).add(normalLocal.mul(flutter));
  })();

  // Coverage: leaf cards from the atlas; bark is opaque from outside (its back faces are dropped)
  const alpha = mix(float(frontFacing), leaf.a, isLeaf);
  mat.alphaTestNode = float(0.5);
  mat.maskShadowNode = alpha.greaterThan(0.5);

  // Leaf cards & bark tubes are whole triangles of one or the other: the bark's noise only runs on the bark (the atlas
  // read, with its implicit derivatives, stays in the main flow)
  const light = leafLight(aData.xyz, leaf, crownAO);
  mat.colorNode = Fn(() => {
    const c = light.colour.toVar();
    If(isLeaf.lessThan(0.5), () => {
      c.assign(barkColour(species, uv(), rnd).mul(crownAO.mul(0.4).add(0.6)));
    });
    return vec4(c, alpha);
  })();

  mat.roughnessNode = mix(float(0.93), float(0.72).sub(leaf.r.mul(0.1)), isLeaf);
  // Card normals are crown-shell normals on both faces: no back-face flip
  mat.normalNode = normalViewGeometry;
  mat.aoNode = light.ao;
  mat.translucencyNode = light.translucency.mul(isLeaf);
  return mat;
}

// The far & billboard crowns are lit as the near ones (leafLight), each leaf taking for its crown occlusion the near
// cards' mean at its height in the crown, from the bottom to the top (measured over every species' near cards; their
// leaves deep in the crown are as dark as those out on the shell are bright)
const FAR_CROWN_AO = [0.62, 0.73];
// Beyond the view depth the sun's shadow maps reach (lighting.js widens it with the camera's altitude, from 300 m at
// street level) no crown is shadowed, by itself or its neighbours: there the far & billboard crowns let the sun reach
// only the leaves turned to it, fading in from a little short of side-on (the dot of the leaf's direction from the
// crown's middle with the sun's) to FAR_SUNWARD[1]. Measured against the mid crowns the shadow maps darken just
// nearer: as bright within ~3% over the forced-level views (street, park, air; midday, golden hour, night), where the
// shell's former shading left the far woods a third brighter.
const FAR_SUNWARD = [-0.05, 0.65];

// A leaf's colour, sky light (ao) & light through it given its crown occlusion (aTree.y on the near cards)
function leafLight(tint, leaf, crownAO) {
  return {
    colour: foliageColour(tint, leaf).mul(crownAO.mul(0.45).add(0.55)),
    // sky light: deep inside the crown far less
    ao: crownAO.mul(0.75).add(0.25),
    // light through the leaves: yellow-green, strongest out on the thin shell
    translucency: tint.mul(vec3(1.0, 1.2, 0.45)).mul(leaf.r.mul(1.5)).mul(crownAO.mul(0.8).add(0.2))
  };
}

// The far crowns' occlusion at height `y` in the unit crown (-1 bottom, 1 top)
const farCrownAO = (y) => mix(float(FAR_CROWN_AO[0]), float(FAR_CROWN_AO[1]), smoothstep(-0.9, 0.9, y));

// Share of the sun reaching a far crown's leaf (or trunk side) at direction `dir` (any length) from the crown's middle,
// given how far `beyond` the shadow maps the crown stands (0: within them, where it casts & receives its own shadow)
const farSunOcclusion = (dir, sunDir, beyond) =>
  mix(float(1.0), smoothstep(FAR_SUNWARD[0], FAR_SUNWARD[1], dot(normalize(dir), sunDir)), beyond);

/**
 * The far trees: returns { material, uniforms: { lodCenter, midEnd, view, farEnd, sunDir, shadowEnd } }.
 * farTiles[species] = the atlas tile of the species' far crown (6, 7 or 8: the bottom row, left to right).
 * sunDir (towards the sun) & shadowEnd (the view depth where the sun's shadow maps end; 0: no shadow maps) are kept
 * up to date by vegetation.js.
 */
export function createFarTreeMaterial(leafAtlas, farTiles) {
  const mat = new DonostiaTreeMaterial({ side: THREE.DoubleSide, alphaToCoverage: true, metalness: 0.0, roughness: 0.8 });
  const uniforms = {
    lodCenter: uniform(new THREE.Vector3(0, -1e5, 0)),
    midEnd: uniform(0),
    view: uniform(new THREE.Vector3()),
    farEnd: uniform(3200),
    sunDir: uniform(new THREE.Vector3(0, 1, 0)),
    shadowEnd: uniform(0)
  };

  const P = attribute('aFarPos', 'vec4');
  const S = attribute('aFarShape', 'vec4');
  const aData = attribute('aTreeData', 'vec4');
  const isCrown = attribute('aFarPart', 'float').greaterThan(0.5);
  const species = floor(aData.w);
  const rnd = fract(aData.w);
  const g = positionGeometry;

  const yawed = (v) => {
    const c = cos(P.w), s = sin(P.w);
    return vec3(v.x.mul(c).add(v.z.mul(s)), v.y, v.z.mul(c).sub(v.x.mul(s)));
  };

  mat.positionNode = Fn(() => {
    const local = select(isCrown, vec3(g.x.mul(S.y), S.x.add(g.y.mul(S.z)), g.z.mul(S.y)), vec3(g.x.mul(S.w), g.y.mul(S.x), g.z.mul(S.w)));
    const centre = P.xyz.add(vec3(0.0, S.x, 0.0));
    // the near & mid meshes draw this tree (vegetation.js picked them with the same distance from the same point)
    const far = step(uniforms.midEnd, length(centre.sub(uniforms.lodCenter)));
    // shrink away past the draw distance
    const fade = float(1.0).sub(smoothstep(uniforms.farEnd.mul(0.85), uniforms.farEnd, length(centre.sub(uniforms.view))));
    // a slow sway of the whole crown, so the far woods are not frozen
    const sway = sin(time.mul(0.7).add(rnd.mul(6.2832)).sub(dot(P.xz, TREE_WIND).mul(0.03))).mul(0.06).mul(S.z).mul(select(isCrown, g.y.add(1.0), 0.0));
    return P.xyz.add(yawed(local).mul(far.mul(fade))).add(vec3(TREE_WIND.x, 0.0, TREE_WIND.y).mul(sway));
  })();

  // Normals turned with the tree, in view space: the unit shapes' own, not stretched with the crown. The near cards'
  // shell normals point along their position in the unit crown, so a flattened crown's top doesn't face the sky more
  // squarely in the far level (flat crowns, tamarisks, magnolias, came out bright under a high sun); the prism's are
  // level either way
  const worldNormal = varying(yawed(normalGeometry), 'vFarNormal');
  mat.normalNode = cameraViewMatrix.transformDirection(worldNormal);

  // The species' far tile is the broadleaf one slid along the bottom row of the atlas
  const tile = select(species.lessThan(0.5), float(farTiles[0]), select(species.lessThan(1.5), float(farTiles[1]),
    select(species.lessThan(2.5), float(farTiles[2]), select(species.lessThan(3.5), float(farTiles[3]),
      select(species.lessThan(4.5), float(farTiles[4]), float(farTiles[5]))))));
  // (one read, in a variable: built as a plain node, the colour, alpha, roughness & translucency slots each sampled it)
  const leaf = texture(leafAtlas, uv().add(vec2(tile.sub(6.0).div(3.0), 0.0))).toVar('farLeaf');
  // the near cards' occlusion at the card's height (the trunk: under its crown)
  const crownAO = varying(select(isCrown, farCrownAO(g.y), float(0.85)), 'vFarCrownAO');
  const light = leafLight(aData.xyz, leaf, crownAO);
  // their own shadow beyond the sun's shadow maps, which fade out over their last 7.5% (the trunk: its sunny side)
  const centreDepth = cameraViewMatrix.mul(vec4(P.xyz.add(vec3(0.0, S.x, 0.0)), 1.0)).z.negate();
  const beyond = smoothstep(uniforms.shadowEnd.mul(0.925), uniforms.shadowEnd, centreDepth);
  mat.directOcclusionNode = varying(farSunOcclusion(yawed(select(isCrown, g, vec3(g.x, 0.0, g.z))), uniforms.sunDir, beyond), 'vFarSun');

  const alpha = select(isCrown, leaf.a, float(frontFacing));
  mat.alphaTestNode = float(0.5);
  mat.maskShadowNode = alpha.greaterThan(0.5);
  mat.colorNode = Fn(() => {
    const c = light.colour.toVar();
    If(isCrown.not(), () => {
      c.assign(barkColour(species, uv().mul(vec2(3.0, 4.0)), rnd).mul(0.8));
    });
    return vec4(c, alpha);
  })();
  mat.roughnessNode = select(isCrown, float(0.72).sub(leaf.r.mul(0.1)), float(0.93));
  mat.aoNode = light.ao;
  mat.translucencyNode = select(isCrown, light.translucency, vec3(0.0));
  return { material: mat, uniforms };
}

// The billboards' lighting, matched on the mean colour of the benchmark's aerial views' distant woods against the far
// shell's cards at golden hour, midday and night (within ~0.15 of a level over the whole image): how squarely the
// crown normals face the camera (1: a solid ball), how far they lean skyward, the roughness (one quad's coherent
// normals caught a sheen of sky the shell's scattered cards don't: bright blue-grey woods at night) and a tone for
// the shell's self-shading. Checked again since the shell is lit as the near crowns and shades its own sunless side
// beyond the shadow maps: as bright on average, though darker seen level and lighter seen from above (a solid ball's
// normals were further off).
const BILLBOARD_FACING = 0.5;
const BILLBOARD_LEAN = 0.5;
const BILLBOARD_ROUGHNESS = 0.95;
const BILLBOARD_TONE = 0.95;
// The quad's size against the crown's spheroid: with the tile read twice it then shows as much leaf as the far shell
// and the near crowns, seen from the street as from the air
const BILLBOARD_SIZE = 0.93;

// The species' far tile (6, 7 or 8) as the u offset from the broadleaf tile's uvs
const farTileShift = (species, farTiles) => {
  const tile = select(species.lessThan(0.5), float(farTiles[0]), select(species.lessThan(1.5), float(farTiles[1]),
    select(species.lessThan(2.5), float(farTiles[2]), select(species.lessThan(3.5), float(farTiles[3]),
      select(species.lessThan(4.5), float(farTiles[4]), float(farTiles[5]))))));
  return vec2(tile.sub(6.0).div(3.0), 0.0);
};

/**
 * The most distant far trees (vegetation.js hands over those beyond BILLBOARD_START, where a crown spans a few pixels):
 * one camera-facing quad per tree over its species' far tile, as wide as the far shell's crown and as tall as that
 * spheroid looks from the camera's elevation, lit as a round crown (sphere normals leaning skyward like the shell's)
 * with the far trees' colour, shade & translucency. It stands in for the shell's twelve overlapping alpha-tested
 * cards, which made the distant woods the costliest pixels of the aerial views. Same instance attributes as the far
 * trees (aFarPos, aFarShape, aTreeData) and the far material's uniforms (view, farEnd).
 */
export function createBillboardTreeMaterial(leafAtlas, farTiles, uniforms) {
  const mat = new DonostiaTreeMaterial({ alphaToCoverage: true, metalness: 0.0, roughness: 0.8 });
  const P = attribute('aFarPos', 'vec4');
  const S = attribute('aFarShape', 'vec4');
  const aData = attribute('aTreeData', 'vec4');
  const isCrown = attribute('aFarPart', 'float').greaterThan(0.5);
  const species = floor(aData.w);
  const g = positionGeometry; // the quad's corner: crown x & y in -1..1, trunk x in -1..1 & y in 0..1

  mat.positionNode = Fn(() => {
    // the far shell's crown, a little above its centre
    const centre = P.xyz.add(vec3(0.0, S.x.add(S.z.mul(0.09)), 0.0)).toVar();
    const toCam = normalize(uniforms.view.sub(centre)).toVar();
    const pole = select(abs(toCam.y).greaterThan(0.99), vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 0.0));
    const right = normalize(pole.cross(toCam)).toVar();
    const up = toCam.cross(right);
    // the crown spheroid (radius S.y, half-height S.z) seen from the camera's elevation
    const sinE = toCam.y, cosE = float(1.0).sub(sinE.mul(sinE)).max(0.0).sqrt();
    const halfW = S.y.mul(BILLBOARD_SIZE);
    const halfH = S.z.mul(cosE).mul(S.z.mul(cosE)).add(S.y.mul(sinE).mul(S.y.mul(sinE))).sqrt().mul(BILLBOARD_SIZE);
    const crown = centre.add(right.mul(g.x.mul(halfW)).add(up.mul(g.y.mul(halfH))));
    // the trunk: upright, turned to the camera, from the root flare to under the crown
    const trunkTop = max(S.x.sub(S.z.mul(0.3)), S.x.mul(0.5));
    const trunk = P.xyz.add(right.mul(g.x.mul(S.w))).add(vec3(0.0, g.y.mul(trunkTop), 0.0));
    // shrink away past the draw distance, as the far trees
    const fade = float(1.0).sub(smoothstep(uniforms.farEnd.mul(0.85), uniforms.farEnd, length(centre.sub(uniforms.view))));
    return mix(P.xyz, select(isCrown, crown, trunk), fade);
  })();

  // a round crown: sphere normals over the quad, leaning skyward like the far shell's (a cylinder's on the trunk). The
  // shell is seen through its gaps too, cards facing away included: the normals turn from the camera more than a
  // solid ball's would (BILLBOARD_FACING; the lean is added in view space, unnormalised)
  const q = varying(vec2(g.x, select(isCrown, g.y, 0.0)), 'vBillboard');
  const sphere = vec3(q.mul(0.8), float(1.0).sub(dot(q, q).mul(0.64)).max(0.0).sqrt().mul(BILLBOARD_FACING));
  mat.normalNode = normalize(sphere.add(cameraViewMatrix.mul(vec4(0.0, BILLBOARD_LEAN, 0.0, 0.0)).xyz));

  // The tile twice, the second time turned half round (uv1), and the leaf of whichever covers more: the quad stands in
  // for the far shell's crown, the clump of its cards seen through one another, and a single layer of the tile was
  // sparser
  const shift = farTileShift(species, farTiles);
  const leaf1 = texture(leafAtlas, uv().add(shift)), leaf2 = texture(leafAtlas, uv(1).add(shift));
  const leaf = select(leaf1.a.greaterThanEqual(leaf2.a), leaf1, leaf2).toVar('billboardLeaf');
  // lit as the far shell, over the ball the quad stands for (the trunk: a cylinder): the near cards' occlusion at the
  // height in the crown, and the crown's own shadow beyond the sun's shadow maps
  const light = leafLight(aData.xyz, leaf, farCrownAO(q.y));
  const centreDepth = cameraViewMatrix.mul(vec4(P.xyz.add(vec3(0.0, S.x, 0.0)), 1.0)).z.negate();
  const beyond = varying(smoothstep(uniforms.shadowEnd.mul(0.925), uniforms.shadowEnd, centreDepth), 'vBillboardBeyond');
  const ball = vec3(q, float(1.0).sub(dot(q, q)).max(0.0).sqrt());
  mat.directOcclusionNode = farSunOcclusion(ball, cameraViewMatrix.transformDirection(uniforms.sunDir), beyond);
  const alpha = select(isCrown, leaf.a, float(1.0));
  // the trunk's bark, barkColour() averaged per species (it is a fraction of a pixel wide out here)
  const bark = select(species.lessThan(0.5), color(0x7a735e), select(species.lessThan(1.5), color(0x40352c),
    select(species.lessThan(2.5), color(0x4a3e32), select(species.lessThan(3.5), color(0x5c5952),
      select(species.lessThan(4.5), color(0x6e4632), color(0x7a6b55)))))).mul(0.8);
  mat.alphaTestNode = float(0.5);
  mat.colorNode = vec4(select(isCrown, light.colour.mul(BILLBOARD_TONE), bark), alpha);
  mat.roughnessNode = select(isCrown, float(BILLBOARD_ROUGHNESS), float(0.93));
  mat.aoNode = select(isCrown, light.ao, float(0.89));
  mat.translucencyNode = select(isCrown, light.translucency, vec3(0.0));
  return mat;
}
