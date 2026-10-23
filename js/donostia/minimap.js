// js/donostia/minimap.js
// The map side of the HUD: a street index for the "where am I" look-ups (nearest named street, auzoa, place), the
// north-up radar in the bottom-left corner and the full map [M]. Both maps draw the same ground, rendered once into
// offscreen canvases: the terrain's 2 m class grid (sea, beaches, parks, woods, streets) shaded by the LiDAR relief, the
// 1:500 buildings toned by height and the landmark lots, plus two coarser copies for zoomed-out views; street and
// district names are laid over it at screen resolution.
// Adapted from upstream's js/nyc-map.js (MapView, the radar's cached ground, label placement, the player arrow); the
// data comes from js/donostia/data-streets.js (tools/donostia/bake-streets.mjs). Nothing here runs at import time,
// so node can load the index for tests.

const FONT = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const WATER = 7;
const RADAR_SCALE = 0.32; // radar pixels per metre near the ground; it zooms out as the camera climbs
const FULL_MIN_ZOOM = 0.03;
const FULL_MAX_ZOOM = 3;

// Map palette, in step with upstream's (css/style.css, js/nyc-map.js): graphite ground with the streets lighter than the
// buildings between them (taller ones a shade lighter), muted parks, woods & sand, the sea darkening with depth
export const MAP = {
  deep: [9, 15, 22],
  shallow: [17, 40, 52],
  shore: [79, 91, 107],
  // RGB per ground class (GEO.terrain.classes)
  ground: [
    [28, 40, 31], // 0 natural: meadow, scrub & rock
    [62, 72, 86], // 1 road
    [40, 46, 55], // 2 sidewalk
    [47, 53, 62], // 3 pedestrian
    [30, 58, 38], // 4 garden
    [24, 50, 33], // 5 woodland
    [92, 82, 60], // 6 beach
    [9, 15, 22], // 7 water (painted by depth)
    [22, 26, 32], // 8 building (the vector footprints go over it)
    [84, 54, 50], // 9 bike lane (bidegorri)
    [47, 53, 62], // 10 stairs
    [64, 57, 52] // 11 rail
  ],
  // relief strength per class: the hills read through the parks & woods, faintly through the streets
  relief: [1.3, 0.45, 0.45, 0.45, 1.1, 1.3, 0.7, 0, 0.45, 0.45, 0.45, 0.45],
  buildings: ['#1a1f25', '#1f252c', '#252c34', '#2d353f'], // up to 10 m, 20 m, 32 m, taller
  sea: '#090f16',
  landmarkEdge: 'rgba(255, 255, 255, 0.42)',
  mainRoad: 'rgba(92, 104, 120, 0.9)',
  halo: 'rgba(8, 11, 15, 0.9)',
  label: '#9ba5b3',
  labelMajor: '#e8ebf0',
  district: 'rgba(246, 245, 242, 0.62)',
  search: '#5fd0ff',
  accent: '#ffc21a'
};

// ---------------------------------------------------------------------------------------------------------------------
// Street index: nearest named street, auzoa & place, from a spatial grid of the street segments
// ---------------------------------------------------------------------------------------------------------------------

function pointInRing(x, z, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const zi = r[i + 1], zj = r[j + 1];
    if ((zi > z) !== (zj > z) && x < ((r[j] - r[i]) * (z - zi)) / (zj - zi) + r[i]) inside = !inside;
  }
  return inside;
}

function boundsOfRings(rings) {
  const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
  for (const r of rings) {
    for (let k = 0; k < r.length; k += 2) {
      if (r[k] < b.minX) b.minX = r[k];
      if (r[k] > b.maxX) b.maxX = r[k];
      if (r[k + 1] < b.minZ) b.minZ = r[k + 1];
      if (r[k + 1] > b.maxZ) b.maxZ = r[k + 1];
    }
  }
  return b;
}

const inBounds = (b, x, z) => x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ;
const fold = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export class StreetIndex {
  constructor(data, cell = 64) {
    this.names = data.names; // [[Basque, Spanish?]]
    this.ways = data.ways; // [name, class, x0, z0, x1, z1, ...]
    this.sea = data.sea;
    this.cell = cell;

    // Segments as flat arrays: endpoints, name & class
    let n = 0;
    for (const w of this.ways) n += (w.length - 2) / 2 - 1;
    const seg = new Float32Array(n * 4);
    const segName = new Uint16Array(n);
    const segClass = new Uint8Array(n);
    this.nameClass = new Uint8Array(this.names.length);
    let s = 0;
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    for (const w of this.ways) {
      this.nameClass[w[0]] = Math.max(this.nameClass[w[0]], w[1]);
      for (let k = 2; k + 3 < w.length; k += 2) {
        seg.set([w[k], w[k + 1], w[k + 2], w[k + 3]], s * 4);
        segName[s] = w[0];
        segClass[s] = w[1];
        s++;
        b.minX = Math.min(b.minX, w[k], w[k + 2]);
        b.maxX = Math.max(b.maxX, w[k], w[k + 2]);
        b.minZ = Math.min(b.minZ, w[k + 1], w[k + 3]);
        b.maxZ = Math.max(b.maxZ, w[k + 1], w[k + 3]);
      }
    }
    Object.assign(this, { seg, segName, segClass, count: n });

    // Grid (CSR): every segment sits in each cell its bounding box touches
    this.gx0 = Math.floor(b.minX / cell) * cell;
    this.gz0 = Math.floor(b.minZ / cell) * cell;
    this.gw = Math.floor((b.maxX - this.gx0) / cell) + 1;
    this.gh = Math.floor((b.maxZ - this.gz0) / cell) + 1;
    const cellsOf = (i, visit) => {
      const ax = seg[4 * i], az = seg[4 * i + 1], bx = seg[4 * i + 2], bz = seg[4 * i + 3];
      const i0 = Math.floor((Math.min(ax, bx) - this.gx0) / cell), i1 = Math.floor((Math.max(ax, bx) - this.gx0) / cell);
      const j0 = Math.floor((Math.min(az, bz) - this.gz0) / cell), j1 = Math.floor((Math.max(az, bz) - this.gz0) / cell);
      for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) visit(j * this.gw + ii);
    };
    const start = new Uint32Array(this.gw * this.gh + 1);
    for (let i = 0; i < n; i++) cellsOf(i, (c) => { start[c + 1]++; });
    for (let c = 0; c < this.gw * this.gh; c++) start[c + 1] += start[c];
    const fill = start.slice(0, -1);
    const items = new Uint32Array(start[start.length - 1]);
    for (let i = 0; i < n; i++) cellsOf(i, (c) => { items[fill[c]++] = i; });
    this.cellStart = start;
    this.cellItems = items;
    this._best = new Map();

    this.districts = data.districts.map((d) => ({ ...d, bounds: boundsOfRings(d.rings) }));
    this.places = data.places.map((p) => ({ ...p, bounds: boundsOfRings([p.ring]) }));
  }

  /**
   * The nearest named streets around (x, z) within `radius` metres (paths and steps count a few metres further away
   * than streets, so a street wins over the footway beside it). Returns up to two distinct streets, nearest first:
   * [{ name, es, d }].
   */
  nearest(x, z, radius = 50) {
    const best = this._best;
    best.clear();
    const { cell, seg } = this;
    const ci = Math.floor((x - this.gx0) / cell), cj = Math.floor((z - this.gz0) / cell);
    const reach = Math.ceil(radius / cell);
    const r2 = radius * radius;
    for (let j = cj - reach; j <= cj + reach; j++) {
      if (j < 0 || j >= this.gh) continue;
      for (let i = ci - reach; i <= ci + reach; i++) {
        if (i < 0 || i >= this.gw) continue;
        const c = j * this.gw + i;
        for (let k = this.cellStart[c]; k < this.cellStart[c + 1]; k++) {
          const s = this.cellItems[k];
          const ax = seg[4 * s], az = seg[4 * s + 1], dx = seg[4 * s + 2] - ax, dz = seg[4 * s + 3] - az;
          const len2 = dx * dx + dz * dz;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
          const ex = ax + t * dx - x, ez = az + t * dz - z;
          const d2 = ex * ex + ez * ez;
          if (d2 > r2) continue;
          const d = Math.sqrt(d2) + (this.segClass[s] === 0 ? 8 : 0);
          const name = this.segName[s];
          const prev = best.get(name);
          if (prev === undefined || d < prev) best.set(name, d);
        }
      }
    }
    let a = -1, da = Infinity, b = -1, db = Infinity;
    for (const [name, d] of best) {
      if (d < da) { b = a; db = da; a = name; da = d; } else if (d < db) { b = name; db = d; }
    }
    const out = [];
    if (a >= 0 && da <= radius) out.push({ name: this.names[a][0], es: this.names[a][1] || null, d: da });
    if (b >= 0 && db <= radius) out.push({ name: this.names[b][0], es: this.names[b][1] || null, d: db });
    return out;
  }

  /** The auzoa (district) containing (x, z): { name, es } or null */
  districtAt(x, z) {
    for (const d of this.districts) {
      if (!inBounds(d.bounds, x, z)) continue;
      let inside = false;
      for (const r of d.rings) if (pointInRing(x, z, r)) inside = !inside;
      if (inside) return d;
    }
    return null;
  }

  /** The most specific named place (square, beach, park, water) containing (x, z); the bay only counts over water */
  placeAt(x, z, onWater = false) {
    for (const p of this.places) {
      if ((p.kind === 'bay' && !onWater) || !inBounds(p.bounds, x, z)) continue;
      if (pointInRing(x, z, p.ring)) return p;
    }
    return null;
  }

  /** Name indices whose Basque or Spanish name contains the query (accents & case ignored), best matches first */
  search(query, limit = 40) {
    const q = fold(query.trim());
    if (!q) return [];
    const hits = [];
    this.names.forEach((n, i) => {
      const eu = fold(n[0]), es = n[1] ? fold(n[1]) : '';
      const at = Math.min(...[eu.indexOf(q), es.indexOf(q)].map((v) => (v < 0 ? Infinity : v)));
      if (at !== Infinity) hits.push([i, (at === 0 ? 0 : 100) - this.nameClass[i] * 10 + eu.length * 0.1]);
    });
    return hits.sort((a, b) => a[1] - b[1]).slice(0, limit).map((h) => h[0]);
  }

  /** Bounds and longest way of a street, for framing a search hit */
  streetExtent(name) {
    const b = { minX: Infinity, maxX: -Infinity, minZ: Infinity, maxZ: -Infinity };
    let longest = null, longestLen = -1;
    for (const w of this.ways) {
      if (w[0] !== name) continue;
      let len = 0;
      for (let k = 2; k < w.length; k += 2) {
        b.minX = Math.min(b.minX, w[k]);
        b.maxX = Math.max(b.maxX, w[k]);
        b.minZ = Math.min(b.minZ, w[k + 1]);
        b.maxZ = Math.max(b.maxZ, w[k + 1]);
        if (k > 2) len += Math.hypot(w[k] - w[k - 2], w[k + 1] - w[k - 1]);
      }
      if (len > longestLen) { longestLen = len; longest = w; }
    }
    if (!longest) return null;
    // the vertex halfway along the longest stretch
    let half = longestLen / 2, mid = [longest[2], longest[3]];
    for (let k = 4; k < longest.length; k += 2) {
      const l = Math.hypot(longest[k] - longest[k - 2], longest[k + 1] - longest[k - 1]);
      if (half <= l) {
        const t = l > 0 ? half / l : 0;
        mid = [longest[k - 2] + (longest[k] - longest[k - 2]) * t, longest[k - 1] + (longest[k + 1] - longest[k - 1]) * t];
        break;
      }
      half -= l;
    }
    return { ...b, mid };
  }

  /**
   * Label anchors along each straight run of every street (fixed in the world, so names never slide while the map
   * pans): the run's middle, then every ~260 m either side, each with the street's direction there (never upside
   * down) and the room the run leaves around it (`len`, centred)
   */
  get anchors() {
    if (this._anchors) return this._anchors;
    const out = [];
    for (const w of this.ways) {
      const n = (w.length - 2) / 2;
      const X = (i) => w[2 + 2 * i], Z = (i) => w[3 + 2 * i];
      for (let i = 0; i + 1 < n;) {
        const dir = Math.atan2(Z(i + 1) - Z(i), X(i + 1) - X(i));
        let j = i + 1;
        while (j + 1 < n) {
          let turn = Math.abs(Math.atan2(Z(j + 1) - Z(j), X(j + 1) - X(j)) - dir);
          if (turn > Math.PI) turn = 2 * Math.PI - turn;
          if (turn > 0.2) break;
          j++;
        }
        const ax = X(i), az = Z(i), cx = X(j), cz = Z(j);
        i = j;
        const len = Math.hypot(cx - ax, cz - az);
        if (len < 24) continue;
        let ang = Math.atan2(cz - az, cx - ax);
        if (ang >= Math.PI * 0.5 - 0.01) ang -= Math.PI;
        else if (ang < -Math.PI * 0.5 - 0.01) ang += Math.PI;
        const step = 260 / len;
        for (let m = 0; m === 0 || 0.5 + m * step < 0.9; m++) {
          for (const t of m ? [0.5 - m * step, 0.5 + m * step] : [0.5]) {
            out.push({ x: ax + (cx - ax) * t, z: az + (cz - az) * t, ang, len: 2 * Math.min(t, 1 - t) * len, name: w[0], cls: w[1] });
          }
        }
      }
    }
    this._anchors = out;
    return out;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Ground raster: classes coloured & shaded by the relief (pure, so node can check it)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Paints a terrain HeightField ({ w, h, res, heights, classes }) into `out` (RGBA, w * h * 4): ground classes in the map
 * palette lit from the north-west (the cartographers' light), the sea by depth with a light shoreline.
 */
export function paintGround(field, out) {
  const { w, h, res, heights, classes } = field;
  const sinEl = Math.sin(0.75), a = Math.cos(0.75) / Math.SQRT2;
  const H = (k) => (heights[k] > 0 ? heights[k] : 0);
  const { ground, relief, deep, shallow, shore } = MAP;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const c = classes[k];
      let r, g, b;
      if (c === WATER) {
        const coast = (i > 0 && classes[k - 1] !== WATER) || (i < w - 1 && classes[k + 1] !== WATER) ||
          (j > 0 && classes[k - w] !== WATER) || (j < h - 1 && classes[k + w] !== WATER);
        if (coast) [r, g, b] = shore;
        else {
          const t = Math.min(1, Math.max(0, -heights[k] / 18));
          r = shallow[0] + (deep[0] - shallow[0]) * t;
          g = shallow[1] + (deep[1] - shallow[1]) * t;
          b = shallow[2] + (deep[2] - shallow[2]) * t;
        }
      } else {
        const col = ground[c] || ground[0];
        const gx = (H(i < w - 1 ? k + 1 : k) - H(i > 0 ? k - 1 : k)) / (2 * res);
        const gz = (H(j < h - 1 ? k + w : k) - H(j > 0 ? k - w : k)) / (2 * res);
        // a slope rising to the south-east faces the light
        const shade = (gx * a + gz * a + sinEl) / Math.sqrt(1 + gx * gx + gz * gz);
        const m = Math.min(1.5, Math.max(0.4, 1 + (shade - sinEl) * (relief[c] ?? 1)));
        r = col[0] * m;
        g = col[1] * m;
        b = col[2] * m;
      }
      const o = 4 * k;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return out;
}

// Appends a ring (flat [x, z, ...]) wound like Path2D.rect for outers and the other way for holes, so overlapping
// outers of one path union under the nonzero rule and holes still cut through
function addRing(path, r, outer = true) {
  const n = r.length / 2;
  if (n < 3) return;
  let area = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) area += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  if ((area >= 0) === outer) {
    path.moveTo(r[0], r[1]);
    for (let i = 1; i < n; i++) path.lineTo(r[2 * i], r[2 * i + 1]);
  } else {
    path.moveTo(r[2 * n - 2], r[2 * n - 1]);
    for (let i = n - 2; i >= 0; i--) path.lineTo(r[2 * i], r[2 * i + 1]);
  }
  path.closePath();
}

/** A map viewport: centre (cx, cz) in local metres, s CSS pixels per metre, w x h CSS pixels at pixel ratio dpr */
class MapView {
  constructor(cx, cz, s, w, h, dpr = 1) {
    Object.assign(this, { cx, cz, s, w, h, dpr });
    this.minX = cx - w / (2 * s);
    this.maxX = cx + w / (2 * s);
    this.minZ = cz - h / (2 * s);
    this.maxZ = cz + h / (2 * s);
  }

  world(ctx) {
    const { s, dpr } = this;
    ctx.setTransform(s * dpr, 0, 0, s * dpr, dpr * (this.w * 0.5 - this.cx * s), dpr * (this.h * 0.5 - this.cz * s));
  }

  /** CSS pixels from the view's centre (what toX / toY return) */
  screen(ctx) {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, this.dpr * this.w * 0.5, this.dpr * this.h * 0.5);
  }

  toX(x) { return (x - this.cx) * this.s; }
  toY(z) { return (z - this.cz) * this.s; }
}

const overlaps = (boxes, b) => boxes.some((o) => b[0] < o[2] && b[2] > o[0] && b[1] < o[3] && b[3] > o[1]);

// Camera arrow at the (already rotated) origin: white on a dark halo (upstream's drawPlayerArrow)
function drawArrow(ctx, tipY, halfWidth, tailY) {
  ctx.beginPath();
  ctx.moveTo(0, tipY);
  ctx.lineTo(halfWidth, tailY);
  ctx.lineTo(0, tailY * 0.45);
  ctx.lineTo(-halfWidth, tailY);
  ctx.closePath();
  ctx.lineJoin = 'round';
  ctx.strokeStyle = MAP.halo;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fill();
}

// The camera's view cone & arrow at the view's centre (screen transform); yaw as in GodCamera (0 looks north)
function drawCamera(ctx, cone, yaw, pitch, hfov, radius, arrowScale = 1) {
  ctx.save();
  ctx.rotate(-yaw);
  // the cone fades as the camera looks down: a top-down view has no heading to speak of
  const look = Math.min(1, Math.cos(pitch) * 1.3);
  if (look > 0.05) {
    ctx.globalAlpha = look;
    ctx.fillStyle = cone;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, -Math.PI / 2 - hfov / 2, -Math.PI / 2 + hfov / 2);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  drawArrow(ctx, -9 * arrowScale, 6.5 * arrowScale, 7 * arrowScale);
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------------
// Ground layers: the pre-rendered map both views draw from
// ---------------------------------------------------------------------------------------------------------------------

export class MapLayers {
  constructor({ GEO, terrain, index }) {
    Object.assign(this, { GEO, terrain, index });
    this.ready = false;
    this.textWidths = new Map();
    // the radar's small type writes "kalea" as "k." (as the municipal addresses do), so more names fit along a block
    this.shortNames = index.names.map((n) => n[0].replace(/ kalea$/, ' k.'));
    this.version = 0;
    // street names measured before the web font arrived would be spaced for the fallback font
    globalThis.document?.fonts?.ready.then(() => { this.textWidths.clear(); this.version++; });
  }

  // ~100 ms of work, done once (hud.js schedules it while the shaders compile)
  build() {
    if (this.ready) return;
    const t0 = performance.now();
    const { core, context } = this.terrain;
    this.context = { field: context, canvas: this.groundCanvas(context) };
    const full = this.groundCanvas(core);
    const ctx = full.getContext('2d');
    // 1:500 buildings, lighter as they rise, and the landmark lots
    ctx.setTransform(1 / core.res, 0, 0, 1 / core.res, -core.x0 / core.res, -core.z0 / core.res);
    const tones = MAP.buildings.map(() => new Path2D());
    for (const b of this.GEO.buildings) {
      const h = b.top - b.ground;
      const path = tones[h < 10 ? 0 : h < 20 ? 1 : h < 32 ? 2 : 3];
      b.g.forEach((ring, r) => addRing(path, ring, r === 0));
    }
    tones.forEach((p, i) => { ctx.fillStyle = MAP.buildings[i]; ctx.fill(p); });
    const lots = new Path2D();
    for (const l of this.GEO.landmarks) if (l.footprint) addRing(lots, l.footprint);
    ctx.strokeStyle = MAP.landmarkEdge;
    ctx.lineWidth = core.res * 0.8;
    ctx.stroke(lots);

    // Coarser copies for zoomed-out views (a halving with smoothing is a 2 x 2 box filter); the main roads are drawn
    // into the coarsest one, where the class grid's streets fade into the blocks
    const half = (src) => {
      const c = document.createElement('canvas');
      c.width = Math.ceil(src.width / 2);
      c.height = Math.ceil(src.height / 2);
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = true;
      x.imageSmoothingQuality = 'high';
      x.drawImage(src, 0, 0, c.width, c.height);
      return c;
    };
    const quarter = half(half(full));
    const qctx = quarter.getContext('2d');
    const qres = core.res * 4;
    qctx.setTransform(1 / qres, 0, 0, 1 / qres, -core.x0 / qres, -core.z0 / qres);
    qctx.strokeStyle = MAP.mainRoad;
    qctx.lineWidth = qres;
    qctx.lineJoin = qctx.lineCap = 'round';
    const roads = new Path2D();
    for (const w of this.index.ways) {
      if (w[1] < 4) continue;
      roads.moveTo(w[2], w[3]);
      for (let k = 4; k < w.length; k += 2) roads.lineTo(w[k], w[k + 1]);
    }
    qctx.stroke(roads);
    this.core = [
      { canvas: full, res: core.res },
      { canvas: half(full), res: core.res * 2 },
      { canvas: quarter, res: qres }
    ];
    this.ready = true;
    this.version++;
    console.log(`[map] ground layers in ${Math.round(performance.now() - t0)} ms`);
  }

  groundCanvas(field) {
    const canvas = document.createElement('canvas');
    canvas.width = field.w;
    canvas.height = field.h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(field.w, field.h);
    paintGround(field, img.data);
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** Sea, context hills and the core ground of view v (clears the canvas) */
  drawGround(ctx, v) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.sea;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    if (!this.ready) return;
    // plain bilinear: the copy picked below is never minified much
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';
    v.world(ctx);
    const cf = this.context.field;
    ctx.drawImage(this.context.canvas, cf.x0, cf.z0, cf.w * cf.res, cf.h * cf.res);
    // the finest copy that still spans at least ~0.6 device pixels per texel
    const px = v.s * v.dpr;
    const layer = this.core.find((l) => px * l.res >= 0.6) || this.core[this.core.length - 1];
    const core = this.terrain.core;
    ctx.drawImage(layer.canvas, core.x0, core.z0, core.w * core.res, core.h * core.res);
  }

  textWidth(ctx, text) {
    const key = `${ctx.font}|${text}`;
    let w = this.textWidths.get(key);
    if (w === undefined) {
      w = ctx.measureText(text).width;
      this.textWidths.set(key, w);
    }
    return w;
  }

  /** Auzoa names at their label points, upper case (screen transform of v); returns their boxes */
  drawDistrictLabels(ctx, v, fontPx, placed = []) {
    ctx.font = `700 ${fontPx}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0.12em';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    ctx.fillStyle = MAP.district;
    for (const d of this.index.districts) {
      if (!d.label) continue;
      const X = v.toX(d.label[0]), Y = v.toY(d.label[1]);
      const text = d.name.toUpperCase();
      const hw = this.textWidth(ctx, text) * 0.5 + 4;
      const box = [X - hw, Y - fontPx * 0.7, X + hw, Y + fontPx * 0.7];
      if (Math.abs(X) > v.w * 0.5 - hw || Math.abs(Y) > v.h * 0.5 - fontPx || overlaps(placed, box)) continue;
      placed.push(box);
      ctx.strokeText(text, X, Y);
      ctx.fillText(text, X, Y);
    }
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    return placed;
  }

  /**
   * Street names along the streets (screen transform of v): the best anchor of each street that fits its name, one
   * per street per `sameNameGap` pixels, none overlapping another or the boxes already `placed` (upstream's
   * drawRoadLabels)
   */
  drawStreetLabels(ctx, v, { fontPx = 10, maxLabels = 400, sameNameGap = 240, placed = [], highlight = null, short = false } = {}) {
    const s = v.s;
    // minor streets only once they are wide enough on screen to carry a name
    const minClass = s >= 0.5 ? 0 : s >= 0.22 ? 1 : s >= 0.12 ? 3 : 4;
    ctx.font = `600 ${fontPx}px ${FONT}`;
    const inset = (fontPx * 2.5) / s;
    const minX = v.minX + inset, maxX = v.maxX - inset, minZ = v.minZ + inset, maxZ = v.maxZ - inset;
    const cands = [];
    const names = this.index.names;
    for (const a of this.index.anchors) {
      if (a.x < minX || a.x > maxX || a.z < minZ || a.z > maxZ) continue;
      const hit = highlight !== null && highlight.has(a.name);
      if (a.cls < minClass && !hit) continue;
      const text = short ? this.shortNames[a.name] : names[a.name][0];
      const width = this.textWidth(ctx, text);
      if (a.len < (width + 10) / s) continue;
      const d = Math.hypot(a.x - v.cx, a.z - v.cz) * s;
      cands.push({ a, text, width, hit, score: (hit ? 1e6 : 0) + a.cls * 600 + Math.min(a.len * s, 400) - d * 0.5 });
    }
    cands.sort((p, q) => q.score - p.score);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = MAP.halo;
    const byName = new Map();
    let n = 0;
    for (const c of cands) {
      if (n >= maxLabels) break;
      const X = v.toX(c.a.x), Y = v.toY(c.a.z);
      const same = byName.get(c.a.name);
      if (same && same.some(([x, y]) => Math.hypot(x - X, y - Y) < sameNameGap)) continue;
      const hw = c.width * 0.5 + 3, hh = fontPx * 0.5 + 2;
      const ca = Math.abs(Math.cos(c.a.ang)), sa = Math.abs(Math.sin(c.a.ang));
      const bx = hw * ca + hh * sa, by = hw * sa + hh * ca;
      const box = [X - bx, Y - by, X + bx, Y + by];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      if (same) same.push([X, Y]);
      else byName.set(c.a.name, [[X, Y]]);
      ctx.save();
      ctx.translate(X, Y);
      ctx.rotate(c.a.ang);
      ctx.fillStyle = c.hit ? MAP.search : c.a.cls >= 4 ? MAP.labelMajor : MAP.label;
      ctx.strokeText(c.text, 0, 0);
      ctx.fillText(c.text, 0, 0);
      ctx.restore();
      n++;
    }
    return placed;
  }

  /** Landmark dots (screen transform of v), with their names when `named` */
  drawLandmarks(ctx, v, { r = 2.8, named = false, fontPx = 11, placed = [] } = {}) {
    if (named) {
      ctx.font = `650 ${fontPx}px ${FONT}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
    }
    for (const l of this.GEO.landmarks) {
      const X = v.toX(l.at[0]), Y = v.toY(l.at[1]);
      if (Math.abs(X) > v.w * 0.5 - 4 || Math.abs(Y) > v.h * 0.5 - 4) continue;
      ctx.fillStyle = MAP.halo;
      ctx.beginPath();
      ctx.arc(X, Y, r + 1.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fill();
      if (!named) continue;
      const width = this.textWidth(ctx, l.name);
      const box = [X + r + 3, Y - fontPx * 0.7, X + r + 7 + width, Y + fontPx * 0.7];
      if (overlaps(placed, box)) continue;
      placed.push(box);
      ctx.lineWidth = 3;
      ctx.strokeStyle = MAP.halo;
      ctx.strokeText(l.name, X + r + 5, Y);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(l.name, X + r + 5, Y);
    }
    return placed;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Radar: north-up, centred on the camera, zooming out as it climbs; click or tap to fly there
// ---------------------------------------------------------------------------------------------------------------------

export class Radar {
  constructor({ canvas, layers, god, terrain, onFly }) {
    Object.assign(this, { canvas, layers, god, terrain, onFly });
    this.ctx = canvas.getContext('2d');
    this.scale = RADAR_SCALE;
    this.cache = null; // { canvas, ctx, cx, cz, s, version }: ground & names over twice the radar's size
    this.view = null;
    this.drawn = { x: NaN, z: NaN, yaw: NaN, pitch: NaN, s: NaN, version: -1 };
    this.hidden = false;

    // a press that barely moves is a click (a drag that leaves the radar is not)
    let down = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || e.pointerId !== down.id) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 8 || !this.view) return;
      const rect = canvas.getBoundingClientRect();
      const v = this.view;
      this.onFly(v.cx + (e.clientX - rect.left - rect.width / 2) / v.s, v.cz + (e.clientY - rect.top - rect.height / 2) / v.s);
    });
    canvas.addEventListener('pointercancel', () => { down = null; });
  }

  // Called every animation frame by hud.js; draws only when the camera or the ground changed
  draw(dt) {
    const { canvas, layers, god } = this;
    if (this.hidden || !layers.ready || !canvas.offsetParent || document.body.classList.contains('hud-minimized')) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
      this.cache = null;
      this.drawn.version = -1;
    }

    const p = god.position;
    const agl = p.y - Math.max(0, this.terrain.heightAt(p.x, p.z));
    const target = Math.max(0.035, RADAR_SCALE / (1 + Math.max(0, agl - 25) / 180));
    this.scale += (target - this.scale) * Math.min(1, dt * 4);
    const s = this.scale;

    const d = this.drawn;
    if (d.version === layers.version && Math.abs(p.x - d.x) * s < 0.15 && Math.abs(p.z - d.z) * s < 0.15 &&
      Math.abs(god.yaw - d.yaw) < 0.004 && Math.abs(god.pitch - d.pitch) < 0.01 && Math.abs(s / d.s - 1) < 0.002) return;
    Object.assign(d, { x: p.x, z: p.z, yaw: god.yaw, pitch: god.pitch, s, version: layers.version });

    // Ground & names come from a cached render twice the radar's size, redrawn when the camera nears its edge or the
    // zoom drifts
    let c = this.cache;
    if (!c || c.version !== layers.version || Math.abs(s / c.s - 1) > 0.12 ||
      Math.abs(p.x - c.cx) > w / c.s - w / (2 * s) - 8 / s || Math.abs(p.z - c.cz) > h / c.s - h / (2 * s) - 8 / s) {
      if (!c) {
        const cv = document.createElement('canvas');
        cv.width = bw * 2;
        cv.height = bh * 2;
        c = this.cache = { canvas: cv, ctx: cv.getContext('2d') };
      }
      Object.assign(c, { cx: p.x, cz: p.z, s, version: layers.version });
      const cv = new MapView(p.x, p.z, s, w * 2, h * 2, dpr);
      layers.drawGround(c.ctx, cv);
      cv.screen(c.ctx);
      const placed = s < 0.16 ? layers.drawDistrictLabels(c.ctx, cv, 9) : [];
      layers.drawStreetLabels(c.ctx, cv, { fontPx: 9.5, maxLabels: 40, sameNameGap: 200, placed, short: true });
    }

    const ctx = this.ctx;
    const v = this.view = new MapView(p.x, p.z, s, w, h, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = MAP.sea;
    ctx.fillRect(0, 0, bw, bh);
    const k = s / c.s;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(c.canvas, dpr * ((c.cx - w / c.s - p.x) * s + w * 0.5), dpr * ((c.cz - h / c.s - p.z) * s + h * 0.5),
      dpr * w * 2 * k, dpr * h * 2 * k);
    v.screen(ctx);
    layers.drawLandmarks(ctx, v);
    if (!this.cone) {
      this.cone = ctx.createRadialGradient(0, 0, 2, 0, 0, 58);
      this.cone.addColorStop(0, 'rgba(255, 255, 255, 0.32)');
      this.cone.addColorStop(1, 'rgba(255, 255, 255, 0)');
    }
    const cam = god.camera;
    const hfov = 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect);
    drawCamera(ctx, this.cone, god.yaw, god.pitch, hfov, 58);
  }

  invalidate() {
    this.drawn.version = -1;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Full map [M]: pan, zoom, search a street, click to fly there
// ---------------------------------------------------------------------------------------------------------------------

export class FullMap {
  constructor({ layers, index, god, describe, onFly, onToggle }) {
    Object.assign(this, { layers, index, god, describe, onFly, onToggle });
    this.modal = document.getElementById('fullmap-modal');
    this.canvas = document.getElementById('fullmap-canvas');
    this.wrap = document.getElementById('fullmap-canvas-wrap');
    this.elHover = document.getElementById('fullmap-hover-info');
    this.elHere = document.getElementById('fullmap-player-info');
    this.elSearch = document.getElementById('fullmap-search');
    this.ctx = this.canvas?.getContext('2d');
    this.isOpen = false;
    this.cx = 0;
    this.cz = 0;
    this.zoom = 0.35;
    this.dpr = 1;
    this.highlight = null; // Set of name indices
    this.highlightPath = null;
    this.hoverText = '';
    this.queued = false;
    if (!this.modal || !this.canvas) return;
    this.hoverDefault = this.elHover?.textContent || '';
    this.canvas.style.touchAction = 'none';
    // the dialog itself takes the focus when it opens (see toggle)
    if (!this.modal.hasAttribute('tabindex')) this.modal.tabIndex = -1;
    this.returnFocus = null;

    document.getElementById('close-fullmap-btn')?.addEventListener('click', () => this.toggle(false));
    document.getElementById('map-zoom-in')?.addEventListener('click', () => this.zoomBy(1.5));
    document.getElementById('map-zoom-out')?.addEventListener('click', () => this.zoomBy(1 / 1.5));
    document.getElementById('map-center-player')?.addEventListener('click', () => {
      this.cx = god.position.x;
      this.cz = god.position.z;
      this.zoom = Math.max(this.zoom, 0.9);
      this.request();
    });
    document.getElementById('map-view-all')?.addEventListener('click', () => this.fitAll());
    this.elSearch?.addEventListener('input', () => this.search(this.elSearch.value));
    this.elSearch?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.hits?.length) {
        const ext = index.streetExtent(this.hits[0]);
        if (ext) this.fly(ext.mid[0], ext.mid[1]);
      } else if (e.key === 'Escape') {
        this.elSearch.blur();
        this.toggle(false);
      }
    });

    // Pan with one pointer, pinch-zoom with two, click (a press that barely moved) to fly
    const pointers = new Map();
    let press = null, pinch = null;
    const local = (e) => {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    };
    this.canvas.addEventListener('pointerdown', (e) => {
      if (!this.isOpen || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      // (preventing the default keeps the focus where it was: let go of the search box, so M & Esc work again)
      this.elSearch?.blur();
      this.canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) press = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.cx, cz: this.cz, moved: false };
      else { press = null; pinch = null; }
      this.wrap?.classList.add('is-panning');
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!this.isOpen) return;
      const p = pointers.get(e.pointerId);
      if (!p) {
        if (e.pointerType === 'mouse') this.hover(local(e));
        return;
      }
      p.x = e.clientX;
      p.y = e.clientY;
      if (pointers.size === 1 && press && e.pointerId === press.id) {
        const dx = e.clientX - press.x, dy = e.clientY - press.y;
        if (Math.hypot(dx, dy) > 6) press.moved = true;
        if (press.moved) {
          this.cx = press.cx - dx / this.zoom;
          this.cz = press.cz - dy / this.zoom;
          this.request();
        }
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const r = this.canvas.getBoundingClientRect();
        const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top, dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) {
          // the world point under the previous midpoint follows the fingers, scaled by their spread
          const wx = this.cx + (pinch.mx - r.width / 2) / this.zoom, wz = this.cz + (pinch.my - r.height / 2) / this.zoom;
          this.zoom = Math.min(FULL_MAX_ZOOM, Math.max(FULL_MIN_ZOOM, this.zoom * dist / Math.max(1, pinch.dist)));
          this.cx = wx - (mx - r.width / 2) / this.zoom;
          this.cz = wz - (my - r.height / 2) / this.zoom;
          this.request();
        }
        pinch = { mx, my, dist };
      }
    });
    const release = (e, cancelled) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!pointers.size) this.wrap?.classList.remove('is-panning');
      if (!cancelled && press && e.pointerId === press.id && !press.moved) {
        const p = local(e);
        this.fly(this.cx + (p.x - p.w / 2) / this.zoom, this.cz + (p.y - p.h / 2) / this.zoom);
      }
      if (press && e.pointerId === press.id) press = null;
    };
    this.canvas.addEventListener('pointerup', (e) => release(e, false));
    this.canvas.addEventListener('pointercancel', (e) => release(e, true));
    this.canvas.addEventListener('pointerleave', () => this.setHover(''));
    // wheel zoom about the cursor (the place under it stays put)
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = local(e);
      this.zoomBy(Math.pow(1.0018, -e.deltaY), p.x, p.y);
    }, { passive: false });
    window.addEventListener('resize', () => { if (this.isOpen) { this.resize(); this.request(); } });
  }

  toggle(open = !this.isOpen) {
    if (!this.modal || open === this.isOpen) return;
    if (open) {
      // A keyboard user's place (say the Mapa button) to come back to; a mouse click leaves no focus to return to
      // (hud.js blurs clicked buttons), and none matches :focus-visible
      const active = document.activeElement;
      this.returnFocus = active instanceof HTMLElement && active !== document.body && active.matches(':focus-visible') ? active : null;
    }
    this.isOpen = open;
    this.modal.classList.toggle('hidden', !open);
    this.onToggle?.(open);
    if (open) {
      // the HUD's popovers live in the top layer, above the map
      for (const pop of document.querySelectorAll('.popover[popover]')) if (pop.matches(':popover-open')) pop.hidePopover?.();
      this.layers.build();
      this.cx = this.god.position.x;
      this.cz = this.god.position.z;
      this.resize();
      this.request();
      const here = this.describe(this.cx, this.cz);
      if (this.elHere) this.elHere.textContent = here ? `Hemen zaude · You are at ${here}` : 'Donostia / San Sebastián';
      // Focus moves into the dialog (screen readers announce it; Tab reaches the search next). The dialog rather
      // than the search box, so M still closes it, and rather than the close button, so Space doesn't. It fades in:
      // until its visibility turns on (the transition's first frame) it can't take the focus, so retry a few frames.
      const focusDialog = (tries) => {
        if (!this.isOpen || this.modal.contains(document.activeElement)) return;
        this.modal.focus({ preventScroll: true });
        if (document.activeElement !== this.modal && tries > 0) requestAnimationFrame(() => focusDialog(tries - 1));
      };
      focusDialog(10);
    } else {
      this.elSearch?.blur();
      this.setHover('');
      const back = this.returnFocus;
      this.returnFocus = null;
      if (back?.isConnected) back.focus({ preventScroll: true });
      else if (this.modal.contains(document.activeElement)) document.activeElement.blur();
    }
  }

  resize() {
    // layout size, at most ~6 megapixels however large the screen (as upstream)
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(6e6 / Math.max(1, w * h)));
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
  }

  size() {
    return { w: this.canvas.width / this.dpr, h: this.canvas.height / this.dpr };
  }

  zoomBy(f, mx, my) {
    const { w, h } = this.size();
    if (mx === undefined) { mx = w / 2; my = h / 2; }
    const wx = this.cx + (mx - w / 2) / this.zoom, wz = this.cz + (my - h / 2) / this.zoom;
    this.zoom = Math.min(FULL_MAX_ZOOM, Math.max(FULL_MIN_ZOOM, this.zoom * f));
    this.cx = wx - (mx - w / 2) / this.zoom;
    this.cz = wz - (my - h / 2) / this.zoom;
    this.request();
  }

  fitAll() {
    const core = this.layers.terrain.core;
    const { w, h } = this.size();
    this.cx = core.x0 + (core.w * core.res) / 2;
    this.cz = core.z0 + (core.h * core.res) / 2;
    this.zoom = Math.max(FULL_MIN_ZOOM, Math.min(w / (core.w * core.res * 1.05), h / (core.h * core.res * 1.05)));
    this.request();
  }

  fly(x, z) {
    this.toggle(false);
    this.onFly(x, z);
  }

  search(text) {
    this.hits = text.trim() ? this.index.search(text) : [];
    this.highlight = this.hits.length ? new Set(this.hits) : null;
    this.highlightPath = null;
    if (this.highlight) {
      // every street that matches, in the search colour
      const path = new Path2D();
      for (const w of this.index.ways) {
        if (!this.highlight.has(w[0])) continue;
        path.moveTo(w[2], w[3]);
        for (let k = 4; k < w.length; k += 2) path.lineTo(w[k], w[k + 1]);
      }
      this.highlightPath = path;
      // frame the best match
      const ext = this.index.streetExtent(this.hits[0]);
      if (ext) {
        const { w, h } = this.size();
        this.cx = (ext.minX + ext.maxX) / 2;
        this.cz = (ext.minZ + ext.maxZ) / 2;
        const fit = Math.min(w / ((ext.maxX - ext.minX) * 1.4 + 1), h / ((ext.maxZ - ext.minZ) * 1.4 + 1));
        this.zoom = Math.max(0.08, Math.min(1.6, fit));
      }
      const [eu, es] = this.index.names[this.hits[0]];
      this.setHover(`${eu}${es ? ` · ${es}` : ''} — Enter: fly there`);
    } else this.setHover('');
    this.request();
  }

  hover(p) {
    const x = this.cx + (p.x - p.w / 2) / this.zoom, z = this.cz + (p.y - p.h / 2) / this.zoom;
    const here = this.describe(x, z);
    this.setHover(here ? `${here} · Click to fly there` : 'Click to fly there');
  }

  setHover(text) {
    const t = text || this.hoverDefault;
    if (this.elHover && t !== this.hoverText) {
      this.hoverText = t;
      this.elHover.textContent = t;
    }
  }

  request() {
    if (this.queued || !this.isOpen) return;
    this.queued = true;
    requestAnimationFrame(() => {
      this.queued = false;
      this.draw();
    });
  }

  draw() {
    if (!this.isOpen || !this.ctx) return;
    const ctx = this.ctx;
    const { w, h } = this.size();
    const v = new MapView(this.cx, this.cz, this.zoom, w, h, this.dpr);
    this.layers.drawGround(ctx, v);
    if (this.highlightPath) {
      v.world(ctx);
      ctx.lineJoin = ctx.lineCap = 'round';
      ctx.strokeStyle = MAP.halo;
      ctx.lineWidth = Math.max(5 / v.s, 9);
      ctx.stroke(this.highlightPath);
      ctx.strokeStyle = MAP.search;
      ctx.lineWidth = Math.max(3 / v.s, 6);
      ctx.stroke(this.highlightPath);
    }
    v.screen(ctx);
    const placed = [];
    if (v.s < 0.3) this.layers.drawDistrictLabels(ctx, v, 12, placed);
    this.layers.drawLandmarks(ctx, v, { r: 3.6, named: v.s >= 0.25, placed });
    this.layers.drawStreetLabels(ctx, v, { fontPx: 11, maxLabels: 260, sameNameGap: 320, placed, highlight: this.highlight });
    // the camera, where it is on the map
    const p = this.god.position;
    ctx.translate(v.toX(p.x), v.toY(p.z));
    if (!this.cone) {
      this.cone = ctx.createRadialGradient(0, 0, 3, 0, 0, 70);
      this.cone.addColorStop(0, 'rgba(255, 194, 26, 0.45)');
      this.cone.addColorStop(1, 'rgba(255, 194, 26, 0)');
    }
    const cam = this.god.camera;
    drawCamera(ctx, this.cone, this.god.yaw, this.god.pitch, 2 * Math.atan(Math.tan((cam.fov * Math.PI) / 360) * cam.aspect), 70, 1.25);
  }
}
