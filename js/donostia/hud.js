import { STREETS } from './data-streets.js';
import { StreetIndex, MapLayers, Radar, FullMap } from './minimap.js';

// js/donostia/hud.js
// HUD wiring for index.html: time of day, the fly-to list, clean view, telemetry, the street-name signs (where am I),
// the radar & the full map [M], and the god camera's touch controls.
// initHud({ GEO, god, terrain, lighting, grade, renderer }) -> { update(fps) }, called by main.js four times a second.

const TIMES = ['golden', 'midday', 'twilight', 'midnight'];
const STREET_RADIUS = 50; // m: beyond this the camera is not "on" a street
const CORNER = 14; // m: a second street this close makes a corner (two signs)

const isTyping = (e) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

export function initHud({ GEO, god, terrain, lighting, grade }) {
  const timeButtons = document.querySelectorAll('[data-time]');
  const selectTime = (id) => {
    lighting.applyPreset(id);
    grade.applyPreset(lighting.activePresetId);
    timeButtons.forEach((b) => b.classList.toggle('active', b.dataset.time === id));
  };
  timeButtons.forEach((b) => b.addEventListener('click', () => selectTime(b.dataset.time)));
  selectTime('golden');

  const teleportList = document.getElementById('teleport-list');
  for (const t of GEO.teleports) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-item tp-btn';
    const name = document.createElement('span');
    name.className = 'pop-name';
    name.textContent = t.name;
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    sub.textContent = t.name_es;
    btn.append(name, sub);
    btn.addEventListener('click', () => {
      god.flyTo(t);
      document.getElementById('teleport-popover')?.hidePopover?.();
    });
    teleportList?.appendChild(btn);
  }

  // a mouse click mustn't leave the focus on a HUD button (Space would press it again)
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });
  const hudToggle = document.getElementById('btn-toggle-hud');
  hudToggle?.addEventListener('click', () => {
    const min = document.body.classList.toggle('hud-minimized');
    hudToggle.setAttribute('aria-pressed', String(min));
  });

  // --- Where am I ------------------------------------------------------------------------------------------------------

  const index = new StreetIndex(STREETS);
  const WATER = GEO.terrain.classes.water;
  // landmark lots (OSM outlines) and the landmarks known only by a point
  const landmarks = GEO.landmarks.map((l) => {
    const r = l.footprint;
    if (!r) return { l, at: l.at };
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let k = 0; k < r.length; k += 2) {
      minX = Math.min(minX, r[k]); maxX = Math.max(maxX, r[k]);
      minZ = Math.min(minZ, r[k + 1]); maxZ = Math.max(maxZ, r[k + 1]);
    }
    return { l, ring: r, minX, maxX, minZ, maxZ };
  });
  const inRing = (x, z, r) => {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
      if ((r[i + 1] > z) !== (r[j + 1] > z) && x < ((r[j] - r[i]) * (z - r[i + 1])) / (r[j + 1] - r[i + 1]) + r[i]) inside = !inside;
    }
    return inside;
  };
  const landmarkAt = (x, z) => {
    for (const m of landmarks) {
      if (m.ring ? x >= m.minX && x <= m.maxX && z >= m.minZ && z <= m.maxZ && inRing(x, z, m.ring)
        : Math.hypot(x - m.at[0], z - m.at[1]) < 30) return { name: m.l.name, es: m.l.name_es };
    }
    return null;
  };

  // The camera's ground point: auzoa, the place it falls in (landmark, square, park, beach, river, bay or sea) and the
  // nearest named streets
  const locate = (x, z) => {
    const onWater = terrain.classAt(x, z) === WATER;
    const d = index.districtAt(x, z);
    let district = d ? { name: d.name, es: d.es } : null;
    let place = landmarkAt(x, z) || index.placeAt(x, z, onWater) || (onWater ? { name: index.sea[0], es: index.sea[1] } : null);
    // out at sea there is no auzoa: the water's name takes its line
    if (!district && place) { district = place; place = null; }
    const streets = index.nearest(x, z, onWater ? STREET_RADIUS / 2 : STREET_RADIUS);
    if (streets.length > 1 && (streets[1].d > CORNER || streets[1].d - streets[0].d > 10)) streets.length = 1;
    // a square's own street name says it already
    if (place && streets.some((s) => s.name === place.name)) place = null;
    return { district, place, streets };
  };
  // one line for the full map: "Kale Nagusia · Erdialdea"
  const describe = (x, z) => {
    const { district, place, streets } = locate(x, z);
    return [streets[0]?.name, place?.name, district?.name].filter(Boolean).join(' · ');
  };

  const elDistrict = document.getElementById('hud-district');
  const elPoi = document.getElementById('hud-location-poi');
  const elSigns = document.getElementById('hud-location-signs');
  const shown = { district: null, poi: null, signs: null };
  const twoNames = (el, n) => {
    const eu = document.createElement('span');
    eu.className = 'loc-eu';
    eu.textContent = n.name;
    el.replaceChildren(eu);
    if (n.es && n.es !== n.name) {
      const es = document.createElement('span');
      es.className = 'loc-es';
      es.textContent = n.es;
      el.append(es);
    }
  };
  const render = ({ district, place, streets }) => {
    const dKey = district ? `${district.name}|${district.es}` : '';
    if (elDistrict && dKey !== shown.district) {
      shown.district = dKey;
      if (district) twoNames(elDistrict, district);
      else elDistrict.replaceChildren();
    }
    const pKey = place ? `${place.name}|${place.es}` : '';
    if (elPoi && pKey !== shown.poi) {
      shown.poi = pKey;
      elPoi.hidden = !place;
      // a fresh node replays the rise-in entrance
      const line = document.createElement('div');
      line.className = 'location-poi-line';
      if (place) twoNames(line, place);
      elPoi.replaceChildren(line);
    }
    const sKey = streets.map((s) => s.name).join('|');
    if (elSigns && sKey !== shown.signs) {
      shown.signs = sKey;
      // Basque name on the blade, Spanish under it where it differs
      const row = document.createElement('div');
      row.className = 'location-signs';
      for (const s of streets) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.title = s.es ? `${s.name} · ${s.es}` : s.name;
        const eu = document.createElement('span');
        eu.className = 'sign-eu';
        eu.textContent = s.name;
        sign.append(eu);
        if (s.es) {
          const es = document.createElement('span');
          es.className = 'sign-es';
          es.textContent = s.es;
          sign.append(es);
        }
        row.append(sign);
      }
      elSigns.replaceChildren(...(streets.length ? [row] : []));
    }
  };

  // --- Radar & full map ------------------------------------------------------------------------------------------------

  const layers = new MapLayers({ GEO, terrain, index });
  // ~100 ms of rasterising: let it run while main.js waits for the shaders to compile
  setTimeout(() => layers.build(), 0);

  // Fly to a map point: ~60 m above the ground, looking at it from the south-west
  const ground = (x, z) => Math.max(0, terrain.heightAt(x, z));
  const flyToGround = (x, z) => {
    const fx = x - 60, fz = z + 60;
    const gy = ground(x, z);
    god.flyTo({ from: [fx, Math.max(gy + 60, ground(fx, fz) + 25), fz], to: [x, gy, z] });
  };

  const radarCanvas = document.getElementById('minimap-canvas');
  const radar = radarCanvas ? new Radar({ canvas: radarCanvas, layers, god, terrain, onFly: flyToGround }) : null;
  const touch = initTouchControls(god);
  const fullMap = new FullMap({
    layers, index, god, describe, onFly: flyToGround,
    onToggle(open) {
      god.enabled = !open;
      touch.setEnabled(!open);
      if (radar) { radar.hidden = open; radar.invalidate(); }
      document.getElementById('btn-open-map')?.setAttribute('aria-pressed', String(open));
    }
  });
  document.getElementById('btn-open-map')?.addEventListener('click', () => fullMap.toggle());
  document.getElementById('radar-expand')?.addEventListener('click', () => fullMap.toggle(true));

  // the radar follows the camera every frame (main.js only calls update() four times a second)
  let last = performance.now();
  const frame = (now) => {
    radar?.draw(Math.min(0.1, Math.max(0, now - last) / 1000));
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === 'KeyH') hudToggle?.click();
    else if (e.code === 'KeyM') fullMap.toggle();
    else if (e.code === 'Escape' && fullMap.isOpen) fullMap.toggle(false);
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (digit) selectTime(TIMES[digit[1] - 1]);
  });

  const elFps = document.getElementById('hud-fps');
  const elAlt = document.getElementById('hud-altitude');
  const elLocAlt = document.getElementById('hud-location-alt');
  const elSpeed = document.getElementById('hud-speed');
  return {
    // called by main.js four times a second
    update(fps) {
      if (elFps) {
        elFps.textContent = String(fps);
        elFps.className = fps >= 50 ? 'fps-ok' : fps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      const alt = Math.round(god.position.y).toLocaleString('en-US');
      if (elAlt) elAlt.textContent = alt;
      if (elLocAlt) elLocAlt.textContent = alt;
      if (elSpeed) elSpeed.textContent = String(Math.round(god.velocity.length() * 3.6));
      render(locate(god.position.x, god.position.z));
    }
  };
}

// --- Touch controls ----------------------------------------------------------------------------------------------------
// Virtual stick & hold buttons for the god camera, adapted from upstream's js/touch-controls.js: the stick flies
// forward / back and sideways (one finger on the view looks around, a pinch flies along it), the buttons climb,
// descend and boost. They appear on coarse pointers, or after the first touch on hybrid devices, and set
// body.touch-enabled for the touch layout (css/style.css & css/donostia.css).

const DEAD_ZONE = 0.15;
const MAX_RADIUS = 44;

function initTouchControls(god) {
  const root = document.getElementById('touch-controls');
  const stick = document.getElementById('touch-stick');
  const knob = document.getElementById('touch-stick-knob');
  if (!root || !stick || !knob) return { setEnabled() {}, reset() {} };
  const buttons = [...root.querySelectorAll('[data-touch-action]')];
  const held = new Map(); // pointerId -> { button, action }
  const media = window.matchMedia('(any-pointer: coarse)');
  let stickPointer = null, center = null, radius = MAX_RADIUS;
  let enabled = true, available = false, touchSeen = false;

  const canInteract = () => enabled && available && !document.hidden;
  const releaseCapture = (el, id) => { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); };

  const moveStick = (e) => {
    const dx = e.clientX - center.x, dy = e.clientY - center.y;
    const dist = Math.hypot(dx, dy);
    const reach = Math.min(dist / radius, 1);
    const strength = Math.max(0, (reach - DEAD_ZONE) / (1 - DEAD_ZONE));
    const x = dist ? dx / dist : 0, y = dist ? dy / dist : 0;
    knob.style.setProperty('--stick-x', `${x * reach * radius}px`);
    knob.style.setProperty('--stick-y', `${y * reach * radius}px`);
    god.touch.forward = -y * strength;
    god.touch.side = x * strength;
  };
  const releaseStick = (id) => {
    if (stickPointer === null || id !== stickPointer) return;
    stickPointer = null;
    releaseCapture(stick, id);
    stick.classList.remove('is-pressed');
    knob.style.setProperty('--stick-x', '0px');
    knob.style.setProperty('--stick-y', '0px');
    god.touch.forward = god.touch.side = 0;
  };
  const applyButtons = () => {
    const actions = new Set([...held.values()].map((h) => h.action));
    god.touch.up = (actions.has('up') ? 1 : 0) - (actions.has('down') ? 1 : 0);
    god.touch.boost = actions.has('boost');
    for (const b of buttons) {
      const pressed = [...held.values()].some((h) => h.button === b);
      b.classList.toggle('is-pressed', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    }
  };
  const releaseButton = (id) => {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    releaseCapture(h.button, id);
    applyButtons();
  };
  const reset = () => {
    releaseStick(stickPointer);
    for (const id of [...held.keys()]) releaseButton(id);
    god.clearTouch();
  };

  stick.addEventListener('pointerdown', (e) => {
    if (!canInteract() || e.button !== 0 || stickPointer !== null || held.has(e.pointerId)) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = stick.getBoundingClientRect();
    center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    radius = Math.min(MAX_RADIUS, Math.min(rect.width, rect.height) / 2) || MAX_RADIUS;
    stickPointer = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stick.classList.add('is-pressed');
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointer) return;
    e.preventDefault();
    moveStick(e);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(type, (e) => releaseStick(e.pointerId));
  }
  for (const button of buttons) {
    const action = button.dataset.touchAction;
    button.addEventListener('pointerdown', (e) => {
      if (!canInteract() || e.button !== 0 || held.has(e.pointerId) || e.pointerId === stickPointer) return;
      e.preventDefault();
      e.stopPropagation();
      held.set(e.pointerId, { button, action });
      button.setPointerCapture(e.pointerId);
      applyButtons();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, (e) => releaseButton(e.pointerId));
    }
    // a long press must not open the context menu or select the label
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  const updateAvailability = () => {
    const now = media.matches || touchSeen;
    if (now !== available) reset();
    available = now;
    document.body.classList.toggle('touch-enabled', available);
    root.hidden = !enabled || !available;
  };
  media.addEventListener('change', updateAvailability);
  // hybrid devices can report a fine pointer until their first touch; capture runs before the controls' handlers
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || touchSeen) return;
    touchSeen = true;
    updateAvailability();
  }, { capture: true, passive: true });
  window.addEventListener('blur', reset);
  window.addEventListener('resize', reset);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  updateAvailability();

  return {
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) reset();
      root.hidden = !enabled || !available;
    },
    reset
  };
}
