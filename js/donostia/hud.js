import { STREETS } from './data-streets.js';
import { StreetIndex, MapLayers, Radar, FullMap } from './minimap.js';
import * as live from './live-state.js';
import { initTouchControls } from './touch.js';

// js/donostia/hud.js
// HUD wiring for index.html: time of day and the real-time switch (Orain) with its readout, the fly-to list, clean
// view, telemetry, the street-name signs (where am I), the radar & the full map [M], the settings sheet with the
// quality control, and what a touch screen needs around the god camera's touch controls (js/donostia/touch.js): the
// phone's bar, the hint, and a page that neither zooms, scrolls nor selects under the fingers.
// initHud({ GEO, god, terrain, lighting, grade, liveSky, renderer, quality }) -> { update(fps), setReady(), mapOpen }:
// main.js calls update() four times a second and setReady() once the city first shows; mapOpen says the full map
// covers the view. `quality` is js/donostia/quality.js where there is one (see initQualityControl).

const TIMES = ['golden', 'midday', 'twilight', 'midnight'];
const LIVE_KEY = 'donostia-live'; // localStorage: '1' while the real-time switch is on
const STREET_RADIUS = 50; // m: beyond this the camera is not "on" a street
const CORNER = 14; // m: a second street this close makes a corner (two signs)

const isTyping = (e) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

export function initHud({ GEO, god, terrain, lighting, grade, liveSky, quality }) {
  // Until the city first shows, main.js compiles the shaders with the scene pass's render target bound (across
  // awaits): a preset applied meanwhile would bake its environment map into that target. A time picked then waits
  // for setReady(), and the shortcuts and the HUD (under the loading screen) don't answer yet.
  let ready = false, pendingTime = null, time = 'golden';
  const timeButtons = document.querySelectorAll('[data-time]');
  // The phone's bar folds the five looks behind one button, which wears the icon and the name of the look in force
  // and opens them as a row above the bar (css/donostia.css); elsewhere the button is not shown
  const toolbar = document.getElementById('hud-toolbar');
  const timeToggle = document.getElementById('btn-time');
  const openTimes = (open) => {
    toolbar?.classList.toggle('time-open', open);
    timeToggle?.setAttribute('aria-expanded', String(open));
  };
  const showTimeToggle = () => {
    const current = liveShown ? liveButton : [...timeButtons].find((b) => b.dataset.time === time);
    if (!timeToggle || !current) return;
    timeToggle.querySelector('use')?.setAttribute('href', current.querySelector('use')?.getAttribute('href') || '#i-live');
    const label = timeToggle.querySelector('.dock-label');
    if (label) label.textContent = current.querySelector('.seg-label')?.textContent || 'Ordua';
  };
  timeToggle?.addEventListener('click', () => openTimes(!toolbar?.classList.contains('time-open')));
  // a look picked, a touch anywhere else or Escape folds the row again
  document.addEventListener('pointerdown', (e) => {
    if (toolbar?.classList.contains('time-open') && !(e.target instanceof Element && e.target.closest('#btn-time, #time-switch'))) openTimes(false);
  }, true);
  // The time buttons show the preset picked last; while real time is on they show it overridden (unpressed, outlined:
  // the look a click goes back to)
  const showTime = (id) => {
    time = id;
    const on = Boolean(liveShown);
    timeButtons.forEach((b) => {
      b.classList.toggle('active', b.dataset.time === id);
      b.setAttribute('aria-pressed', String(!on && b.dataset.time === id));
    });
    showTimeToggle();
  };
  const applyTime = (id) => {
    lighting.applyPreset(id);
    grade.applyPreset(lighting.activePresetId);
    showTime(id);
  };
  // picking a time turns real time off and shows that look, as it always has
  const selectTime = (id) => {
    if (liveShown) {
      time = id; // (the look real time hands back to)
      setLive(false);
    }
    if (ready) applyTime(id);
    else { pendingTime = id; showTime(id); }
  };
  timeButtons.forEach((b) => b.addEventListener('click', () => { selectTime(b.dataset.time); openTimes(false); }));

  // --- Real time (Orain) -----------------------------------------------------------------------------------------------
  // The switch turns js/donostia/live-state.js on and off; js/donostia/live-sky.js does the rest each frame. On by
  // default (the city as it is now), unless this browser turned it off; the choice is remembered. Turned on before the
  // city shows, it waits for setReady(), and the weather and the sea are fetched meanwhile, behind the loading screen.

  const liveButton = document.getElementById('btn-live');
  const timeSwitch = liveButton?.closest('.time-switch');
  const readout = document.getElementById('live-readout');
  const renderLive = initLiveReadout(readout);
  let liveWanted = true, liveShown = null;
  try { liveWanted = localStorage.getItem(LIVE_KEY) !== '0'; } catch { /* storage unavailable */ }
  if (liveWanted) live.refreshLive();
  const showLive = (on) => {
    if (on === liveShown) return;
    liveShown = on;
    liveButton?.classList.toggle('active', on);
    liveButton?.setAttribute('aria-checked', String(on));
    timeSwitch?.classList.toggle('is-live', on);
    if (readout) readout.hidden = !on;
    showTime(time);
  };
  const setLive = (on) => {
    liveWanted = on;
    try { localStorage.setItem(LIVE_KEY, on ? '1' : '0'); } catch { /* storage unavailable */ }
    if (ready) live.setLiveEnabled(on);
    else showLive(on);
  };
  liveButton?.addEventListener('click', () => { setLive(!liveShown); openTimes(false); });
  // the state may change from elsewhere too (slopDebug.live): the switch follows it, and real time turned off brings
  // back the preset picked last
  live.onLive((snap) => {
    if (!ready) return;
    showLive(snap.enabled);
    if (!snap.enabled && lighting.activePresetId === 'live') applyTime(time);
    if (snap.enabled) renderLive(snap);
  });
  showLive(liveWanted);
  applyTime('golden'); // (before the compile: the shaders are built for the lights it sets)

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
    openTimes(false);
  });

  // --- The settings sheet ----------------------------------------------------------------------------------------------
  // The quality control, where there is a quality module, and on touch screens the tools the bar leaves out (clean
  // view, the data credits, the repository). Its button shows when the sheet has either to offer.
  const settings = document.getElementById('settings-popover');
  const settingsButton = document.getElementById('btn-settings');
  const hasQuality = initQualityControl(quality);
  const showSettingsButton = () => {
    if (settingsButton) settingsButton.hidden = !hasQuality && !document.body.classList.contains('touch-enabled');
  };
  document.getElementById('more-clean')?.addEventListener('click', () => {
    settings?.hidePopover?.();
    hudToggle?.click();
  });
  document.getElementById('more-credits')?.addEventListener('click', () => {
    settings?.hidePopover?.();
    document.getElementById('credits-popover')?.showPopover?.();
  });
  guardPageGestures();

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
  // --- Touch -----------------------------------------------------------------------------------------------------------
  // What the fingers do, said once the city shows and again when the flight stick is switched; the first gesture on
  // the view (or a few seconds) takes the line away
  const hint = document.getElementById('touch-hint');
  let hintTimer = 0, hinted = false;
  const hideHint = () => {
    clearTimeout(hintTimer);
    if (hint) hint.hidden = true;
  };
  const sayHint = () => {
    if (!hint || !ready || !touch.available || fullMap.isOpen) return;
    const lines = touch.flying
      ? ['Left thumb flies', 'Right thumb looks', 'Push past the rim to go fast']
      : ['Drag to look', 'Two fingers to move', 'Double-tap to fly there'];
    hint.replaceChildren(...lines.map((text) => Object.assign(document.createElement('span'), { textContent: text })));
    hint.hidden = false;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, 7000);
  };
  document.getElementById('canvas-container')?.addEventListener('pointerup', () => { if (hinted) hideHint(); });
  const touch = initTouchControls(god, {
    // touch found (a hybrid's first touch) or the flight stick switched
    onChange() {
      showSettingsButton();
      if (hinted) sayHint();
    }
  });
  showSettingsButton();
  document.getElementById('btn-fly')?.addEventListener('click', () => openTimes(false));
  keepViewSized();
  // The HUD, the view and the touch controls are inert while the loading screen or the full map (a modal dialog)
  // covers them: Tab stays in front, and screen readers skip what is hidden
  const covered = [...document.querySelectorAll('.hud, #touch-controls, #canvas-container')];
  const updateInert = () => {
    const off = !ready || fullMap.isOpen;
    for (const el of covered) el.inert = off;
  };
  const fullMap = new FullMap({
    layers, index, god, describe, onFly: flyToGround,
    onToggle(open) {
      god.enabled = !open;
      touch.setEnabled(!open);
      if (radar) { radar.hidden = open; radar.invalidate(); }
      document.getElementById('btn-open-map')?.setAttribute('aria-pressed', String(open));
      if (open) { hideHint(); openTimes(false); }
      updateInert();
    }
  });
  updateInert();
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
    // (a held key repeats: a toggle would flip back and forth)
    if (!ready || e.repeat || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    // H & M by the letter they type, wherever the layout puts it; the time digits by their place on the number row
    const key = (e.key || '').toLowerCase(); // (autofill sends keydowns without a key)
    if (key === 'h') hudToggle?.click();
    else if (key === 'm') fullMap.toggle();
    else if (e.key === 'Escape' && fullMap.isOpen) fullMap.toggle(false);
    else if (e.key === 'Escape') openTimes(false);
    const digit = /^Digit([1-5])$/.exec(e.code);
    if (digit?.[1] === '5') setLive(!liveShown);
    else if (digit) selectTime(TIMES[digit[1] - 1]);
  });

  const elFps = document.getElementById('hud-fps');
  const elAlt = document.getElementById('hud-altitude');
  const elLocAlt = document.getElementById('hud-location-alt');
  const elSpeed = document.getElementById('hud-speed');
  return {
    // called by main.js as the loading screen lifts: the time picked meanwhile, the shortcuts and the HUD come alive
    setReady() {
      if (ready) return;
      ready = true;
      if (liveSky) liveSky.ready = true;
      if (pendingTime) applyTime(pendingTime);
      pendingTime = null;
      if (liveWanted) {
        // the city first shows as it is now, not fading in from the preset the shaders were compiled with
        if (liveSky) liveSky.skipFade = true;
        live.setLiveEnabled(true);
      }
      updateInert();
      hinted = true;
      sayHint();
    },
    // the full map covers the whole view (main.js stops rendering it meanwhile)
    get mapOpen() {
      return fullMap.isOpen;
    },
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
      if (liveShown) renderLive(live.liveSnapshot());
    }
  };
}

// --- The real-time readout -------------------------------------------------------------------------------------------
// The hour in Donostia, the weather (its icon, its name in Basque, °C), the tide (its level above mean sea level,
// rising or falling, the next high or low water) and the waves (height, period), each with a tooltip in Basque,
// Spanish and English. While the data loads, and if Open-Meteo doesn't answer, the clock runs on and says so; the sky
// keeps to the clock with calm weather (live-state.js's defaults) meanwhile.

// weather kind -> [icon, Basque, Spanish, English]
const WEATHER = {
  clear: ['i-sun', 'Oskarbi', 'despejado', 'clear'],
  cloudy: ['i-cloud', 'Hodeitsu', 'nuboso', 'cloudy'],
  overcast: ['i-cloud', 'Estalia', 'cubierto', 'overcast'],
  fog: ['i-fog', 'Lainoa', 'niebla', 'fog'],
  drizzle: ['i-rain', 'Zirimiria', 'sirimiri', 'drizzle'],
  rain: ['i-rain', 'Euria', 'lluvia', 'rain'],
  showers: ['i-rain', 'Zaparradak', 'chubascos', 'showers'],
  snow: ['i-snow', 'Elurra', 'nieve', 'snow'],
  storm: ['i-storm', 'Ekaitza', 'tormenta', 'storm']
};
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const km = (m) => (m >= 10000 ? `${Math.round(m / 1000)} km` : `${(m / 1000).toFixed(1)} km`);
const signed = (v, digits) => `${v >= 0 ? '+' : '\u2212'}${Math.abs(v).toFixed(digits)}`;

function initLiveReadout(root) {
  if (!root) return () => {};
  const hhmm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const part = (id) => {
    const item = root.querySelector(`#${id}`);
    return item && { item, use: item.querySelector('use'), word: item.querySelector('.live-word'), num: item.querySelector('.live-num'), sub: item.querySelector('.live-sub') };
  };
  const clock = root.querySelector('#live-time'), weather = part('live-weather'), tide = part('live-tide'), waves = part('live-waves');
  // write only what changed (four times a second)
  const set = (node, value) => {
    if (node && node.textContent !== value) node.textContent = value;
  };
  const attr = (node, name, value) => {
    if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
  };
  return (snap) => {
    set(clock, hhmm.format(snap.date));
    const missing = (what) => snap.status === 'error' || (snap.status === 'partial' && (snap.error || '').includes(`${what}:`));
    root.classList.toggle('is-loading', snap.status === 'loading');

    if (weather) {
      const w = snap.weather;
      weather.item.classList.toggle('is-error', snap.status !== 'loading' && missing('weather'));
      if (snap.status === 'loading') {
        attr(weather.use, 'href', '#i-cloud');
        set(weather.word, 'Kargatzen…');
        set(weather.num, '');
        attr(weather.item, 'title', 'Kargatzen · cargando · loading the weather and the sea (Open-Meteo)');
      } else if (missing('weather')) {
        attr(weather.use, 'href', '#i-alert');
        set(weather.word, 'Daturik ez');
        set(weather.num, '');
        attr(weather.item, 'title', `Daturik ez · sin datos · no weather from Open-Meteo (${snap.error || 'no answer'}): the sky keeps to the clock with calm weather, and asks again every 15 min`);
      } else {
        const [icon, eu, es, en] = WEATHER[w.kind] ?? WEATHER.cloudy;
        attr(weather.use, 'href', icon === 'i-sun' && snap.sun.elevation < -0.8 ? '#i-moon' : `#${icon}`);
        set(weather.word, eu);
        set(weather.num, `${Math.round(w.temperature)} °C`);
        attr(weather.item, 'title', `${eu} · ${es} · ${en}, ${Math.round(w.temperature)} °C; haizea · viento · wind ${Math.round(w.windSpeed * 3.6)} km/h from the ${compass(w.windFrom)}; ${Math.round(w.cloudCover * 100)}% cloud; ${km(w.visibility)} visibility`);
      }
    }

    const sea = snap.sea, t = sea.tide;
    const seaShown = snap.status !== 'loading' && !missing('sea');
    if (tide) {
      tide.item.hidden = !seaShown;
      if (seaShown) {
        const arrow = t.rate > 0.02 ? '↑ ' : t.rate < -0.02 ? '↓ ' : '';
        set(tide.num, `${arrow}${signed(t.level, 1)} m`);
        const turn = t.next[0];
        const names = turn && (turn.kind === 'high' ? ['Itsasgora', 'pleamar', 'high water'] : ['Itsasbehera', 'bajamar', 'low water']);
        set(tide.sub, turn ? `${names[0]} ${hhmm.format(turn.date)}` : '');
        attr(tide.item, 'title', `Itsasaldia · marea · tide: ${signed(t.level, 2)} m on mean sea level, ${t.rate > 0.02 ? 'rising' : t.rate < -0.02 ? 'falling' : 'turning'}` +
          (turn ? `; ${names.join(' · ')} at ${hhmm.format(turn.date)} (${signed(turn.level, 2)} m)` : ''));
      }
    }
    if (waves) {
      waves.item.hidden = !seaShown;
      if (seaShown) {
        set(waves.num, `${sea.waveHeight.toFixed(1)} m · ${Math.round(sea.wavePeriod)} s`);
        attr(waves.item, 'title', `Olatuak · oleaje · waves: ${sea.waveHeight.toFixed(1)} m every ${Math.round(sea.wavePeriod)} s from the ${compass(sea.waveFrom)}` +
          (Number.isFinite(sea.temperature) ? `; itsasoa · el mar · the sea ${Math.round(sea.temperature)} °C` : ''));
      }
    }
  };
}

// --- The quality control ---------------------------------------------------------------------------------------------
// A row of choices (Auto and the tiers) in the settings sheet, for js/donostia/quality.js. That module is the
// renderer's and may not be there, or may name things otherwise: everything this file assumes about it is in
// qualityApi() below, which answers null where there is nothing to drive (the control then stays hidden).
//   quality.tiers            the tiers, lowest first: ids, or { id, label } records, or an object keyed by id
//   quality.get()            the choice: 'auto' or a tier id; or { choice | mode, tier } with the tier Auto settled on
//   quality.set(id | 'auto')
//   quality.onChange(fn)     (or subscribe / addEventListener('change')) when the choice or Auto's tier changes
// main.js hands it to initHud({ quality }); window.slopQuality is looked at too, so it can be tried without that.

const TIER_NAMES = { auto: 'Auto', low: 'Baxua', medium: 'Ertaina', high: 'Altua', ultra: 'Ultra' };

function qualityApi(q = globalThis.slopQuality) {
  if (!q || typeof q.set !== 'function' || typeof q.get !== 'function') return null;
  const raw = q.tiers ?? q.TIERS ?? q.levels ?? [];
  const tiers = (Array.isArray(raw) ? raw : Object.keys(raw).map((id) => ({ id, ...(typeof raw[id] === 'object' ? raw[id] : {}) })))
    .map((t) => (typeof t === 'object' ? { id: String(t.id ?? t.name), label: t.label } : { id: String(t) }))
    .filter((t) => t.id && t.id !== 'auto' && t.id !== 'undefined');
  if (!tiers.length) return null;
  return {
    tiers,
    // -> { choice: 'auto' | tier id, tier: the tier in force (null if the module doesn't say) }
    read() {
      const v = q.get();
      if (v && typeof v === 'object') {
        const tier = v.tier ?? v.active ?? v.effective ?? null;
        return { choice: String(v.auto === true ? 'auto' : v.choice ?? v.mode ?? v.setting ?? tier), tier };
      }
      return { choice: String(v), tier: v === 'auto' ? q.tier ?? q.active ?? q.effective ?? null : v };
    },
    set: (id) => q.set(id),
    watch(fn) {
      if (typeof q.onChange === 'function') q.onChange(fn);
      else if (typeof q.subscribe === 'function') q.subscribe(fn);
      else if (typeof q.addEventListener === 'function') q.addEventListener('change', fn);
    }
  };
}

function initQualityControl(quality) {
  const root = document.getElementById('quality-control');
  const row = document.getElementById('quality-options');
  const note = document.getElementById('quality-note');
  const api = qualityApi(quality || undefined);
  if (!root || !row || !api) return false;
  const name = (t) => t.label || TIER_NAMES[t.id] || t.id.charAt(0).toUpperCase() + t.id.slice(1);
  const buttons = [{ id: 'auto' }, ...api.tiers].map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.dataset.quality = t.id;
    b.textContent = name(t);
    b.addEventListener('click', () => { api.set(t.id); show(); });
    row.append(b);
    return b;
  });
  function show() {
    const { choice, tier } = api.read();
    for (const b of buttons) {
      b.classList.toggle('active', b.dataset.quality === choice);
      b.setAttribute('aria-pressed', String(b.dataset.quality === choice));
    }
    // Auto says which tier it settled on for this device
    const settled = choice === 'auto' && tier != null ? api.tiers.find((t) => t.id === String(tier)) : null;
    if (note) note.textContent = settled ? `Auto: ${name(settled)}` : '';
  }
  api.watch(() => show());
  show();
  root.hidden = false;
  return true;
}

// --- The page under the fingers ----------------------------------------------------------------------------------------
// css/donostia.css keeps the page from zooming, scrolling, selecting and calling out (touch-action, user-select,
// overscroll-behavior); these are the cases only script can reach.

function guardPageGestures() {
  // Safari's own pinch (it does not honour user-scalable=no) would zoom the whole page from any HUD panel
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (e) => e.preventDefault());
  // a long press must not open the browser's menu over the HUD; links and the search box keep theirs
  document.addEventListener('contextmenu', (e) => {
    const touched = e.pointerType === 'touch' || (e.pointerType === undefined && document.body.classList.contains('touch-enabled'));
    if (touched && !(e.target instanceof Element && e.target.closest('a[href], input, textarea'))) e.preventDefault();
  });
}

// main.js sizes the renderer to window.innerWidth x innerHeight on the window's resize. On phones the view can change
// without one that reads right: iOS turns the phone before the new size is in, and the browser's bars slide away. The
// view's box (#canvas-container, the dynamic viewport: css/donostia.css) is watched here, and whenever the canvas is
// left a different size the resize is asked for again.
function keepViewSized() {
  const container = document.getElementById('canvas-container');
  if (!container || typeof ResizeObserver !== 'function') return;
  let asked = '';
  const check = () => {
    const canvas = container.querySelector('canvas');
    const w = container.clientWidth, h = container.clientHeight;
    if (!canvas || !w || !h) return;
    const key = `${w}x${h}:${window.innerWidth}x${window.innerHeight}`;
    if ((Math.abs(canvas.clientWidth - w) > 1 || Math.abs(canvas.clientHeight - h) > 1) && key !== asked) {
      asked = key; // (once per size: if innerWidth x innerHeight is not the box, asking again changes nothing)
      window.dispatchEvent(new Event('resize'));
    }
  };
  const later = () => requestAnimationFrame(check);
  new ResizeObserver(later).observe(container);
  window.addEventListener('orientationchange', () => setTimeout(check, 300));
  window.visualViewport?.addEventListener('resize', later);
}
