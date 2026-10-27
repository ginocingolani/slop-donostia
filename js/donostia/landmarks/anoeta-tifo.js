import * as THREE from 'three/webgpu';
import {
  Fn, float, vec2, vec3, vec4, attribute, varying, time, sin, cos, abs, min, mix, step, smoothstep, floor, fract,
  length, pow, uv, texture, positionGeometry, normalGeometry, normalLocal, normalize
} from 'three/tsl';
import { cityUniforms } from '../../city-uniforms.js';
import { decodePNG } from '../png.js';
import { grid } from './geom.js';
import { mosaic, PALETTE, BLUE, WHITE, BANNER, medallionUV } from './tifo-design.js';

// js/donostia/landmarks/anoeta-tifo.js
// The tifo on Anoeta's south stand, the Aitor Zabaleta harmaila (named in 2018 after the Real Sociedad fan killed in
// Madrid in 1998), after the one its fans raised at La Cartuja for the 2026 Copa del Rey final: a mosaic of cards held
// up over the upper tier, the banner with Aitor Zabaleta's portrait spread over the lower tier and the fans' flags
// waving round it. The design is tifo-design.js; anoeta.js hands over its stands (buildTifo(stand)).
// - The cards: one quad per spectator, every 0.5 m along the rows the bowl's shader draws (0.4 m of rise apart), held
//   up at head height and leaning back towards the pitch, each a little off in height, lean, heading and shade; the
//   aisles stay empty and a few fans hold none. The colour is the mosaic's at the card's place.
// - The banner: a cloth BANNER.width wide (along the rows, at every row) spread over the lower tier at arm's height,
//   sagging at its edges, rippling as the hands under it push. Its frame and the portrait are two textures
//   (data/donostia/tifo-banner.png, tifo-portrait.png: tools/donostia/bake-tifo.mjs) laid together by its shader.
//   The portrait is from a photo by Goiena.eus via Wikimedia Commons (CC BY-SA 4.0; see tools/donostia/README.md).
// - The flags: on the lower tier either side of the banner and in its top rows, about one fan in three: blue, white
//   round the banner, a few ikurriñas and striped ones. Each is waved side to side and its cloth ripples (vertex
//   shader).
// Cards and flags are two instanced meshes of one material (one pipeline); the banner is a third mesh. The flags are
// dropped beyond FLAGS_FAR from the stand. The floodlights light all three at night. The group's userData.update(dt,
// elapsed, camera) does the culling; hide the group to hide the tifo (slopDebug.tifo(false) in ?debug).

const T = 0.72; // the tifo spans the stand from -T to T radians round the pitch's centre (into the corners)
const CARD = { w: 0.48, h: 0.42, lift: 1.25 }; // m; the card's foot above the tier
const SEAT = 0.5; // m between spectators along a row
const FLAG = { w: 1.05, h: 0.7, hands: 1.5, top: 1.2 }; // m; the hands over the tier, the pole's top over the hands
const LIFT = { middle: 1.95, edge: 1.4 }; // the banner over the tier, held up by the fans under it
const FLAGS_FAR = 650; // m from the stand's centre
const KIND = { card: 0, cloth: 1, pole: 2 };
const IKURRINA = 4, STRIPES = 5; // flag codes after the palette's

const night = () => smoothstep(0.35, 1.3, cityUniforms.uInteriorGlow);

// A small integer hash -> [0, 1): the tifo is the same on every load
const hash = (i, k) => {
  let h = Math.imul(i * 2654435761 + k * 974634151, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

// --- materials -------------------------------------------------------------------------------------------------------

/**
 * Cards and flags. Per instance: aTifoA = (x, y, z of its foot, heading: the way its face looks), aTifoB = (colour code:
 * palette index + 0.5 + shade x 0.4, phase, scale, lean back); per vertex aTifoKind: 0 a card, 1 a flag's cloth, 2 its
 * pole.
 */
function tifoMaterial() {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  mat.name = 'AnoetaTifo';
  const A = attribute('aTifoA', 'vec4'), B = attribute('aTifoB', 'vec4'), kind = attribute('aTifoKind', 'float');
  const cloth = step(0.5, kind).mul(step(kind, 1.5)), flag = step(0.5, kind), card = float(1).sub(flag);
  mat.positionNode = Fn(() => {
    const g = positionGeometry, n = normalGeometry, phase = B.y, scale = B.z;
    // a flag's cloth ripples, more away from the pole; the whole flag is waved side to side from the hands, a card
    // bobs a little in them
    const ripple = sin(time.mul(5.2).sub(g.x.mul(4.5)).add(phase.mul(3.0))).mul(g.x.div(FLAG.w).mul(0.24)).mul(cloth);
    const roll = sin(time.mul(1.15).add(phase)).mul(0.38).mul(flag);
    const bob = sin(time.mul(1.6).add(phase.mul(2.0))).mul(0.025).mul(card);
    const p = vec3(g.x, g.y, g.z.add(ripple)).mul(scale);
    const cr = cos(roll), sr = sin(roll);
    const x1 = p.x.mul(cr).sub(p.y.mul(sr)), y1 = p.x.mul(sr).add(p.y.mul(cr));
    const nx1 = n.x.mul(cr).sub(n.y.mul(sr)), ny1 = n.x.mul(sr).add(n.y.mul(cr));
    // the ripple's slope turns the cloth's normal
    const nz0 = n.z.sub(cos(time.mul(5.2).sub(g.x.mul(4.5)).add(phase.mul(3.0))).mul(cloth).mul(0.6));
    // lean back (the top away from the face), then the heading
    const ca = cos(B.w), sa = sin(B.w);
    const y2 = y1.mul(ca).add(p.z.mul(sa)), z2 = p.z.mul(ca).sub(y1.mul(sa));
    const ny2 = ny1.mul(ca).add(nz0.mul(sa)), nz2 = nz0.mul(ca).sub(ny1.mul(sa));
    const s = sin(A.w), c = cos(A.w);
    normalLocal.assign(normalize(vec3(nx1.mul(c).add(nz2.mul(s)), ny2, nz2.mul(c).sub(nx1.mul(s)))));
    return vec3(A.x.add(x1.mul(c)).add(z2.mul(s)), A.y.add(y2).add(bob), A.z.sub(x1.mul(s)).add(z2.mul(c)));
  })();

  const code = varying(B.x, 'vTifoCode'), part = varying(kind, 'vTifoKind');
  mat.colorNode = Fn(() => {
    const idx = floor(code), shade = fract(code).sub(0.5).mul(2.5);
    const is = (k) => step(k - 0.5, idx).mul(step(idx, k + 0.5));
    let col = vec3(...PALETTE[0]).mul(is(0));
    for (let k = 1; k < PALETTE.length; k++) col = col.add(vec3(...PALETTE[k]).mul(is(k)));
    // a flag's own pattern: the ikurriña (red, the green saltire, the white cross) and blue & white stripes
    const f = uv(), aspect = FLAG.w / FLAG.h, px = f.x.mul(aspect), py = f.y;
    const crossW = step(abs(px.sub(aspect / 2)), 0.07).max(step(abs(py.sub(0.5)), 0.07));
    const nd = Math.hypot(1, aspect);
    const d1 = abs(px.sub(py.mul(aspect))).div(nd), d2 = abs(px.sub(py.oneMinus().mul(aspect))).div(nd);
    const saltire = step(min(d1, d2), 0.075);
    const ikurrina = mix(mix(vec3(...PALETTE[2]), vec3(...PALETTE[3]), saltire), vec3(...PALETTE[1]), crossW);
    const stripes = mix(vec3(...PALETTE[0]), vec3(...PALETTE[1]), step(0.5, fract(f.x.mul(3.0))));
    col = col.add(ikurrina.mul(is(IKURRINA))).add(stripes.mul(is(STRIPES)));
    // paper & cloth a little off each other; the poles pale wood
    col = col.mul(shade.mul(0.07).add(1.0));
    return mix(col, vec3(0.42, 0.36, 0.27), step(1.5, part));
  })();
  // floodlit at night, as the stands are (a little more: paper and flags under the lamps)
  mat.emissiveNode = mat.colorNode.mul(night().mul(0.42));
  return mat;
}

// The banner: the frame's colour and cut (alpha), and the portrait in the medallion's disc. uv: u across, v up the tier.
// (The textures' rows run from the top of the image: v is flipped to read them.)
function bannerMaterial(frame, portrait) {
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness: 0.88, metalness: 0 });
  mat.name = 'AnoetaTifoBanner';
  const m = medallionUV(), q = uv();
  const colour = frame.node(vec2(q.x, q.y.oneMinus()));
  const d = length(vec2(q.x.sub(m.u).div(m.ru), q.y.sub(m.v).div(m.rv)));
  const pu = q.x.sub(m.u).div(m.ru * 2).add(0.5), pv = q.y.sub(m.v).div(m.rv * 2).add(0.5);
  // the portrait's bytes are sRGB greys
  const grey = pow(portrait.node(vec2(pu, pv.oneMinus())).r, float(2.2));
  const rgb = mix(colour.rgb, vec3(grey), smoothstep(1.0, 0.99, d));
  mat.colorNode = vec4(rgb, colour.a);
  mat.alphaTestNode = float(0.5);
  mat.emissiveNode = rgb.mul(night().mul(0.42));
  return mat;
}

// A texture filled in when its PNG arrives (an empty one until then): the RGBA frame, or the portrait's greys (from
// any PNG: its luma). node(uv) makes a sampling node; every one made gets the texture when it is loaded.
function lateTexture(url, grey) {
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  blank.needsUpdate = true;
  const nodes = [];
  let current = blank;
  (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const { width, height, channels, data } = await decodePNG(await res.arrayBuffer());
    let tex;
    if (grey) {
      const g = new Uint8Array(width * height);
      for (let k = 0; k < g.length; k++) {
        const o = k * channels;
        g[k] = channels < 3 ? data[o] : Math.round(0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2]);
      }
      tex = new THREE.DataTexture(g, width, height, THREE.RedFormat);
    } else {
      if (channels !== 4) throw new Error(`${url}: RGBA expected`);
      tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
      tex.colorSpace = THREE.SRGBColorSpace;
    }
    tex.name = url.split('/').pop();
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 8;
    tex.needsUpdate = true;
    current = tex;
    for (const n of nodes) n.value = tex;
  })().catch((e) => console.warn('[anoeta tifo]', e));
  return { node: (at) => { const n = texture(current, at); nodes.push(n); return n; } };
}

// --- geometry --------------------------------------------------------------------------------------------------------

// The shared vertex layout: position, normal, uv, aTifoKind; plus the two instanced vec4s
function base(pos, nrm, tex, kinds, index) {
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(tex, 2));
  g.setAttribute('aTifoKind', new THREE.Float32BufferAttribute(kinds, 1));
  g.setIndex(index);
  return g;
}

// A card: a quad facing +z, its foot at the origin
function cardGeometry() {
  const { w, h } = CARD;
  return base([-w / 2, 0, 0, w / 2, 0, 0, w / 2, h, 0, -w / 2, h, 0], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    [0, 0, 1, 0, 1, 1, 0, 1], [0, 0, 0, 0], [0, 1, 2, 0, 2, 3]);
}

// A flag: its pole up from the hands (two crossed strips), the cloth flying to +x from its top, facing +z
function flagGeometry() {
  const pos = [], nrm = [], tex = [], kinds = [], index = [];
  const quad = (a, b, c, d, n, kind, uvs) => {
    const k = pos.length / 3;
    for (const [p, t] of [[a, uvs[0]], [b, uvs[1]], [c, uvs[2]], [d, uvs[3]]]) { pos.push(...p); nrm.push(...n); tex.push(...t); kinds.push(kind); }
    index.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const r = 0.018, top = FLAG.top;
  const flat = [[0, 0], [1, 0], [1, 1], [0, 1]];
  quad([-r, -0.3, 0], [r, -0.3, 0], [r, top, 0], [-r, top, 0], [0, 0, 1], KIND.pole, flat);
  quad([0, -0.3, -r], [0, -0.3, r], [0, top, r], [0, top, -r], [1, 0, 0], KIND.pole, flat);
  // the cloth: 8 x 2 cells, so the ripple bends it
  const NX = 8, NY = 2, k0 = pos.length / 3;
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    pos.push((i / NX) * FLAG.w, top - FLAG.h + (j / NY) * FLAG.h, 0);
    nrm.push(0, 0, 1); tex.push(i / NX, j / NY); kinds.push(KIND.cloth);
  }
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = k0 + j * (NX + 1) + i;
    index.push(a, a + 1, a + NX + 2, a, a + NX + 2, a + NX + 1);
  }
  return base(pos, nrm, tex, kinds, index);
}

function instanced(geo, rows, name, sphere) {
  const n = rows.length / 8;
  const a = new Float32Array(n * 4), b = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    a.set(rows.slice(i * 8, i * 8 + 4), i * 4);
    b.set(rows.slice(i * 8 + 4, i * 8 + 8), i * 4);
  }
  geo.setAttribute('aTifoA', new THREE.InstancedBufferAttribute(a, 4));
  geo.setAttribute('aTifoB', new THREE.InstancedBufferAttribute(b, 4));
  geo.instanceCount = n;
  geo.boundingSphere = sphere;
  return geo;
}

// --- build -----------------------------------------------------------------------------------------------------------

/**
 * stand: anoeta.js's bowl. at(t, r, y) -> [x, y, z]; dirOf(t) -> [dx, dz] (t radians round the pitch's centre from the
 * south end, positive towards the west); the rings' radii rF (front), rM1 (top of the lower tier), rM2 (foot of the
 * upper tier), rBk (its back); their heights yF, yM1, yM2, yBk; arcF (metres along the front at N steps of 2π/N, the
 * bowl shader's aisles: every 12 m on the lower tier, 15 m on the upper); rowRise (the seats' rows).
 */
export function buildTifo(stand) {
  const { at, dirOf, rF, rM1, rM2, rBk, yF, yM1, yM2, yBk, arcF, N, rowRise } = stand;
  const along = (t) => {
    const f = (((t / (Math.PI * 2)) % 1) + 1) % 1 * N, i = Math.floor(f);
    return arcF[i] + (arcF[i + 1] - arcF[i]) * (f - i) - (t < 0 ? arcF[N] : 0);
  };
  const inAisle = (t, period, half) => {
    const s = along(t), d = Math.abs(s - Math.round(s / period) * period);
    return d < half;
  };
  const heading = (t) => { const [dx, dz] = dirOf(t); return Math.atan2(-dx, -dz); }; // facing the pitch's centre
  const group = new THREE.Group();
  group.name = 'AnoetaTifo';
  const [cx, , cz] = at(0, (rF(0) + rBk(0)) / 2, 0);
  const centre = new THREE.Vector3(cx, (yF + yBk) / 2, cz);
  const sphere = new THREE.Sphere(centre, 95);

  // the card mosaic on the upper tier, row by row (the rows the bowl's shader draws, 0.4 m of rise apart)
  const midR = (rM2(0) + rBk(0)) / 2;
  const slope = Math.hypot(rBk(0) - rM2(0), yBk - yM2);
  const design = mosaic((2 * T * midR) / (slope * 0.85)); // the tier's width over its height, as seen from the pitch
  const cards = [];
  let i = 0;
  for (let k = Math.ceil(yM2 / rowRise); (k + 1) * rowRise <= yBk; k++) {
    const yc = (k + 0.5) * rowRise, f = (yc - yM2) / (yBk - yM2);
    const r0 = rM2(0) + (rBk(0) - rM2(0)) * f, n = Math.floor((2 * T * r0) / SEAT);
    for (let j = 0; j <= n; j++, i++) {
      const t = -T + (2 * T * j) / n;
      if (inAisle(t, 15, 0.55) || hash(i, 1) < 0.03) continue; // the aisles, and a few fans without a card
      const r = rM2(t) + (rBk(t) - rM2(t)) * f;
      const [x, , z] = at(t + (hash(i, 2) - 0.5) * (0.06 / r), r - 0.12, 0);
      const colour = design((t + T) / (2 * T), f);
      const code = colour + 0.5 + (hash(i, 3) - 0.5) * 0.8;
      cards.push(x, yc + CARD.lift + (hash(i, 4) - 0.5) * 0.12, z, heading(t) + (hash(i, 5) - 0.5) * 0.16,
        code, hash(i, 6) * 6.2832, 0.96 + hash(i, 7) * 0.08, 0.3 + (hash(i, 8) - 0.5) * 0.24);
    }
  }
  const material = tifoMaterial();
  const cardMesh = new THREE.Mesh(instanced(cardGeometry(), cards, 'cards', sphere), material);
  cardMesh.name = 'AnoetaTifo_cards';

  // the banner over the lower tier: BANNER.width along every row, from just above the front to just below the top
  const { width: BW } = BANNER;
  const lowerAt = (t, f) => {
    const r = rF(t) + (rM1(t) - rF(t)) * f;
    return [r, yF + (yM1 - yF) * f];
  };
  const F0 = 0.03, F1 = 0.97, NU = 64, NV = 24;
  const halfT = (f) => BW / 2 / lowerAt(0, f)[0];
  const cloth = grid(NU, NV, (iu, jv) => {
    const f = F0 + ((F1 - F0) * jv) / NV, u = iu / NU, t = (u - 0.5) * 2 * halfT(f);
    const [r, y] = lowerAt(t, f);
    // highest in the middle, sagging to the edges where fewer hands hold it, a little lumpy over the heads
    const edge = Math.max(Math.abs(u - 0.5) * 2, Math.abs(jv / NV - 0.5) * 2);
    const lift = LIFT.middle + (LIFT.edge - LIFT.middle) * edge ** 3 + (hash(iu * 97 + jv, 9) - 0.5) * 0.18;
    return at(t, r, y + lift);
  }, (iu, jv) => [iu / NU, jv / NV], () => [0, 1, 0], false);
  const bannerMat = bannerMaterial(lateTexture('data/donostia/tifo-banner.png', false), lateTexture('data/donostia/tifo-portrait.png', true));
  // the cloth ripples where the hands under it push (vertex stage, along the tier's up)
  bannerMat.positionNode = Fn(() => {
    const p = positionGeometry, t = time;
    const w = sin(t.mul(1.25).add(p.x.mul(0.31)).add(p.z.mul(0.27))).mul(sin(t.mul(0.73).sub(p.x.mul(0.17)).add(p.z.mul(0.23))));
    return p.add(vec3(0, w.mul(0.2), 0));
  })();
  const banner = new THREE.Mesh(cloth, bannerMat);
  banner.name = 'AnoetaTifo_banner';

  // the flags: lower tier, either side of the banner and over its top rows
  const flags = [];
  const bannerHalf = (f) => halfT(f) + 0.35 / lowerAt(0, f)[0];
  i = 0;
  for (let k = Math.ceil(yF / rowRise); (k + 1) * rowRise <= yM1; k++) {
    const yc = (k + 0.5) * rowRise, f = (yc - yF) / (yM1 - yF);
    const r0 = lowerAt(0, f)[0], n = Math.floor((2 * T * r0) / 1.05);
    const overBanner = f > F1 - 0.01 || f < F0;
    for (let j = 0; j <= n; j++, i++) {
      const t = -T + (2 * T * j) / n + (hash(i, 10) - 0.5) * (0.5 / r0);
      const out = Math.abs(t) - bannerHalf(f); // > 0 off the banner's sides
      if (!overBanner && out < 0) continue;
      if (Math.abs(t) > T || inAisle(t, 12, 0.5) || hash(i, 11) < 0.25) continue;
      const [r] = lowerAt(t, f);
      const [x, , z] = at(t, r - 0.1, 0);
      // white round the banner, blue further out; a few ikurriñas and striped flags everywhere
      const nearBanner = overBanner || out * r0 < 5.5;
      const roll = hash(i, 12);
      const code = roll < 0.07 ? IKURRINA : roll < 0.11 ? STRIPES : (nearBanner ? hash(i, 13) < 0.72 : hash(i, 13) < 0.12) ? WHITE : BLUE;
      // the cloth flies off either way
      const yaw = heading(t) + (hash(i, 14) < 0.5 ? 0 : Math.PI) + (hash(i, 15) - 0.5) * 0.5;
      flags.push(x, yc + FLAG.hands, z, yaw, code + 0.5 + (hash(i, 16) - 0.5) * 0.8, hash(i, 17) * 6.2832,
        0.92 + hash(i, 18) * 0.16, (hash(i, 19) - 0.5) * 0.3);
    }
  }
  const flagMesh = new THREE.Mesh(instanced(flagGeometry(), flags, 'flags', sphere), material);
  flagMesh.name = 'AnoetaTifo_flags';

  for (const mesh of [cardMesh, banner, flagMesh]) {
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  }
  group.userData.stats = { cards: cards.length / 8, flags: flags.length / 8, bannerTriangles: NU * NV * 2 };
  // flags only near the stadium (a card's mosaic still reads from afar)
  group.userData.update = (dt, elapsed, camera) => {
    if (!group.visible) return;
    flagMesh.visible = camera.position.distanceTo(centre) < FLAGS_FAR;
  };
  return group;
}
