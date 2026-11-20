import { STREETS } from './data-streets.js';
import { StreetIndex, MapLayers, Radar, FullMap } from './minimap.js';
import * as live from './live-state.js';
import { initTouchControls } from './touch.js';
import { LANGS, LANG_NAMES, t, getLang, setLang, onLang, placeName, compassNames } from './i18n.js';
import { track } from './analytics.js';

// js/donostia/hud.js
// HUD wiring for index.html: time of day and the real-time switch ("Now") with its readout, the fly-to list, clean
// view, telemetry, the street-name signs (where am I), the radar & the full map [M], the settings sheet with the
// quality control and the language, and what a touch screen needs around the god camera's touch controls
// (js/donostia/touch.js): the phone's bar, and a page that neither zooms, scrolls nor selects under the fingers.
// Every word shown comes from js/donostia/i18n.js (index.html's marked elements are rewritten there; what this file
// writes itself is written again when the language changes); the city's own names are data and stay as they are.
// initHud({ GEO, god, terrain, lighting, grade, liveSky, renderer, quality }) -> { update(fps), setReady(), mapOpen }:
// main.js calls update() four times a second and setReady() once the city first shows; mapOpen says the full map
// covers the view. `quality` is js/donostia/quality.js where there is one (see initQualityControl).
// What the visitor does with the HUD goes to the usage analytics by track() (js/donostia/analytics.js, where the events
// are listed; nothing happens where they are off).

const TIMES = ['golden', 'midday', 'twilight', 'midnight'];
const OLD_LIVE_KEY = 'donostia-live'; // localStorage: where the real-time switch was remembered (no more: removed)
const STREET_RADIUS = 50; // m: beyond this the camera is not "on" a street
const CORNER = 14; // m: a second street this close makes a corner (two signs)

const isTyping = (e) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

export function initHud({ GEO, god, terrain, lighting, grade, liveSky, quality }) {
  // js/donostia/main.js's pill while the shaders compile behind the city ('Loading details…', 'Applying quality…'):
  // its words in the HUD's language, from the 'slop-compile' event it sends right after writing its own English
  let compiling = null;
  const compileNote = () => {
    const note = document.getElementById('compile-note');
    if (!note || !compiling || compiling.stage === 'done') return;
    const n = compiling.total ? Math.round((100 * compiling.done) / compiling.total) : 0;
    note.textContent = t(compiling.stage === 'applying' ? 'compile.applying' : 'compile.details', { n });
  };
  window.addEventListener('slop-compile', (e) => { compiling = e.detail; compileNote(); });
  onLang(compileNote);
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
    if (label) label.textContent = current.querySelector('.seg-label')?.textContent || t('time.label');
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
    track('time_preset', { id });
    if (liveShown) {
      time = id; // (the look real time hands back to)
      setLive(false);
    }
    if (ready) applyTime(id);
    else { pendingTime = id; showTime(id); }
  };
  timeButtons.forEach((b) => b.addEventListener('click', () => { selectTime(b.dataset.time); openTimes(false); }));

  // --- Real time ("Now") -----------------------------------------------------------------------------------------------
  // The switch turns js/donostia/live-state.js on and off; js/donostia/live-sky.js does the rest each frame. Every
  // visit starts in real time (the city as it is now), whatever was picked the last time: a time preset holds for the
  // visit it was picked in and is not remembered (it used to be, and a phone that had once tapped a preset came up
  // in the golden hour ever after; what that left in localStorage is cleared). The weather and the sea are fetched
  // behind the loading screen, and the switch itself waits for setReady().

  const liveButton = document.getElementById('btn-live');
  const timeSwitch = liveButton?.closest('.time-switch');
  const readout = document.getElementById('live-readout');
  const renderLive = initLiveReadout(readout);
  let liveWanted = true, liveShown = null;
  try { localStorage.removeItem(OLD_LIVE_KEY); } catch { /* storage unavailable */ }
  live.refreshLive();
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
    if (ready) live.setLiveEnabled(on);
    else showLive(on);
  };
  // (the switch itself, by the button or key 5; a preset turning it off is a time_preset)
  const toggleLive = () => {
    track('live_toggle', { on: !liveShown });
    setLive(!liveShown);
  };
  liveButton?.addEventListener('click', () => { toggleLive(); openTimes(false); });
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

  // The fly-to list: each place by its name in the language in force, the place's own (Basque) name under it
  const teleportList = document.getElementById('teleport-list');
  const places = GEO.teleports.map((place) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-item tp-btn';
    const name = document.createElement('span');
    name.className = 'pop-name';
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    btn.append(name, sub);
    btn.addEventListener('click', () => {
      track('teleport', { id: place.id });
      god.flyTo(place);
      document.getElementById('teleport-popover')?.hidePopover?.();
    });
    teleportList?.appendChild(btn);
    return { place, name, sub };
  });
  const namePlaces = () => {
    for (const { place, name, sub } of places) {
      const n = placeName(place);
      name.textContent = n.name;
      sub.textContent = n.sub;
    }
  };
  namePlaces();

  // a mouse click mustn't leave the focus on a HUD button (Space would press it again)
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });
  const hudToggle = document.getElementById('btn-toggle-hud');
  hudToggle?.addEventListener('click', () => {
    const min = document.body.classList.toggle('hud-minimized');
    hudToggle.setAttribute('aria-pressed', String(min));
    track('hud_hide', { hidden: min });
    openTimes(false);
  });

  // --- The settings sheet ----------------------------------------------------------------------------------------------
  // The quality control, where there is a quality module, the language, and on touch screens the tools the bar leaves
  // out (clean view, the data credits, the repository).
  const settings = document.getElementById('settings-popover');
  const showQuality = initQualityControl(quality);
  initLanguageControl();
  const showFullscreen = initFullscreenControl();
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
  const elStreet = document.getElementById('hud-location-street');
  const shown = { district: null, poi: null, signs: null };
  const twoNames = (el, n) => {
    const eu = document.createElement('span');
    eu.className = 'loc-eu';
    eu.lang = 'eu'; // (the city's own names, whatever the page's language: a screen reader says them as Basque)
    eu.textContent = n.name;
    el.replaceChildren(eu);
    if (n.es && n.es !== n.name) {
      const es = document.createElement('span');
      es.className = 'loc-es';
      es.lang = 'es';
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
      // the touch layouts say the street inside the card instead, as plain text (css/donostia.css): the Basque name
      // alone, both streets at a corner, on one line that gives way with an ellipsis
      if (elStreet) {
        elStreet.textContent = streets.map((s) => s.name).join(' · ');
        elStreet.hidden = !streets.length;
      }
      // Basque name on the blade, Spanish under it where it differs
      const row = document.createElement('div');
      row.className = 'location-signs';
      for (const s of streets) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.title = s.es ? `${s.name} · ${s.es}` : s.name;
        const eu = document.createElement('span');
        eu.className = 'sign-eu';
        eu.lang = 'eu';
        eu.textContent = s.name;
        sign.append(eu);
        if (s.es) {
          const es = document.createElement('span');
          es.className = 'sign-es';
          es.lang = 'es';
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
  // The flight stick & its buttons are there on every touch screen (js/donostia/touch.js)
  const touch = initTouchControls(god);
  keepViewSized();
  // The HUD, the view and the touch controls are inert while the loading screen or the full map (a modal dialog)
  // covers them: Tab stays in front, and screen readers skip what is hidden
  const covered = [...document.querySelectorAll('.hud, #touch-controls, #canvas-container')];
  const updateInert = () => {
    const off = !ready || fullMap.isOpen;
    for (const el of covered) el.inert = off;
  };
  const fullMap = new FullMap({
    layers, index, god, describe, onFly: flyToGround, bounds: GEO.frame?.core,
    onToggle(open) {
      if (open) track('map_open');
      god.enabled = !open;
      touch.setEnabled(!open);
      if (radar) { radar.hidden = open; radar.invalidate(); }
      document.getElementById('btn-open-map')?.setAttribute('aria-pressed', String(open));
      if (open) openTimes(false);
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
    if (digit?.[1] === '5') toggleLive();
    else if (digit) selectTime(TIMES[digit[1] - 1]);
  });

  // What this file wrote in the language that was: the fly-to list, the time button's name, the tiers, the readout
  // (update() writes the readout again four times a second; this is for a still page) and the map's lines
  onLang(() => {
    namePlaces();
    showTimeToggle();
    showQuality();
    showFullscreen();
    if (liveShown) renderLive(live.liveSnapshot());
    fullMap.relabel();
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
// The hour in Donostia, the weather (its icon, its name, °C), the tide (its level above mean sea level, rising or
// falling, the next high or low water) and the waves (height, period), each with a tooltip that says it in full, in
// the language in force. While the data loads, and if Open-Meteo doesn't answer, the clock runs on and says so; the
// sky keeps to the clock with calm weather (live-state.js's defaults) meanwhile.

// weather kind -> icon (its name is t('weather.<kind>'))
const WEATHER = {
  clear: 'i-sun', cloudy: 'i-cloud', overcast: 'i-cloud', fog: 'i-fog', drizzle: 'i-rain', rain: 'i-rain', showers: 'i-rain',
  snow: 'i-snow', storm: 'i-storm'
};
const compass = (deg) => compassNames()[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
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
        set(weather.word, t('live.loading'));
        set(weather.num, '');
        attr(weather.item, 'title', t('live.loadingTitle'));
      } else if (missing('weather')) {
        attr(weather.use, 'href', '#i-alert');
        set(weather.word, t('live.noData'));
        set(weather.num, '');
        attr(weather.item, 'title', t('live.noDataTitle', { error: snap.error || t('live.noAnswer') }));
      } else {
        const kind = w.kind in WEATHER ? w.kind : 'cloudy';
        const icon = WEATHER[kind], word = t(`weather.${kind}`);
        attr(weather.use, 'href', icon === 'i-sun' && snap.sun.elevation < -0.8 ? '#i-moon' : `#${icon}`);
        set(weather.word, word);
        set(weather.num, `${Math.round(w.temperature)} °C`);
        attr(weather.item, 'title', t('live.weatherTitle', {
          word, temp: Math.round(w.temperature), wind: Math.round(w.windSpeed * 3.6), dir: compass(w.windFrom),
          cloud: Math.round(w.cloudCover * 100), vis: km(w.visibility)
        }));
      }
    }

    const sea = snap.sea, tideNow = sea.tide;
    const seaShown = snap.status !== 'loading' && !missing('sea');
    if (tide) {
      tide.item.hidden = !seaShown;
      if (seaShown) {
        const arrow = tideNow.rate > 0.02 ? '↑ ' : tideNow.rate < -0.02 ? '↓ ' : '';
        set(tide.num, `${arrow}${signed(tideNow.level, 1)} m`);
        const turn = tideNow.next[0];
        const name = turn && t(turn.kind === 'high' ? 'tide.high' : 'tide.low');
        set(tide.sub, turn ? `${name} ${hhmm.format(turn.date)}` : '');
        attr(tide.item, 'title', t('live.tideTitle', { level: signed(tideNow.level, 2), trend: t(tideNow.rate > 0.02 ? 'tide.rising' : tideNow.rate < -0.02 ? 'tide.falling' : 'tide.turning') }) +
          (turn ? t('live.tideNext', { name, time: hhmm.format(turn.date), level: signed(turn.level, 2) }) : ''));
      }
    }
    if (waves) {
      waves.item.hidden = !seaShown;
      if (seaShown) {
        set(waves.num, `${sea.waveHeight.toFixed(1)} m · ${Math.round(sea.wavePeriod)} s`);
        attr(waves.item, 'title', t('live.wavesTitle', { height: sea.waveHeight.toFixed(1), period: Math.round(sea.wavePeriod), dir: compass(sea.waveFrom) }) +
          (Number.isFinite(sea.temperature) ? t('live.seaTemp', { temp: Math.round(sea.temperature) }) : ''));
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
// Every setting applies as it is picked: there is nothing to reload for, and the module's needsReload is not read.
// The tiers are named here by their ids (t('quality.<id>')); a tier this file has no name for shows the module's own
// label. initQualityControl() answers the function that writes the names again (for a change of language).

function qualityApi(q = globalThis.slopQuality) {
  if (!q || typeof q.set !== 'function' || typeof q.get !== 'function') return null;
  const raw = q.tiers ?? q.TIERS ?? q.levels ?? [];
  const tiers = (Array.isArray(raw) ? raw : Object.keys(raw).map((id) => ({ id, ...(typeof raw[id] === 'object' ? raw[id] : {}) })))
    .map((x) => (typeof x === 'object' ? { id: String(x.id ?? x.name), label: x.label } : { id: String(x) }))
    .filter((x) => x.id && x.id !== 'auto' && x.id !== 'undefined');
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
  if (!root || !row || !api) return () => {};
  const name = (tier) => {
    const key = `quality.${tier.id}`, known = t(key);
    return known !== key ? known : tier.label || tier.id.charAt(0).toUpperCase() + tier.id.slice(1);
  };
  const all = [{ id: 'auto' }, ...api.tiers];
  const buttons = all.map((tier) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.dataset.quality = tier.id;
    b.addEventListener('click', () => { api.set(tier.id); show(); });
    row.append(b);
    return b;
  });
  function show() {
    const { choice, tier } = api.read();
    buttons.forEach((b, i) => { b.textContent = name(all[i]); });
    for (const b of buttons) {
      b.classList.toggle('active', b.dataset.quality === choice);
      b.setAttribute('aria-pressed', String(b.dataset.quality === choice));
    }
    // Auto says which tier it settled on for this device
    const settled = choice === 'auto' && tier != null ? api.tiers.find((x) => x.id === String(tier)) : null;
    if (note) note.textContent = settled ? t('quality.autoNote', { tier: name(settled) }) : '';
    // a pick is applied in the running city (js/donostia/quality.js): no second pick while one is being applied
    const applying = !!quality?.get?.()?.applying;
    for (const b of buttons) b.disabled = applying;
  }
  api.watch(() => show());
  show();
  root.hidden = false;
  return show;
}

// --- The language ------------------------------------------------------------------------------------------------------
// A row of choices in the settings sheet, each language by its own name (and said in it: lang). English is in force
// until another is picked; the pick applies at once and is remembered (js/donostia/i18n.js).

function initLanguageControl() {
  const row = document.getElementById('language-options');
  if (!row) return;
  const buttons = LANGS.map((id) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn';
    b.dataset.lang = id;
    b.lang = id;
    b.textContent = LANG_NAMES[id];
    b.addEventListener('click', () => {
      const from = getLang();
      // (after the change, so the event says its new language like every one after it)
      if (setLang(id) !== from) track('language_change', { from, to: id });
    });
    row.append(b);
    return b;
  });
  const show = () => {
    for (const b of buttons) {
      b.classList.toggle('active', b.dataset.lang === getLang());
      b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
    }
  };
  onLang(show);
  show();
}

// --- Full screen -------------------------------------------------------------------------------------------------------
// A page cannot go full screen by itself: it takes the visitor's hand, by one of two ways. Where the browser has the
// Fullscreen API (Android, iPad, desktop) the settings sheet has a button that asks for it on the click and follows
// the state (Esc and the browser's own gesture leave it too); a refusal is left at that. iPhone has no Fullscreen API
// for pages: there the sheet says, in one line, that the app runs full screen from the home screen (the manifest and
// index.html's Apple tags make it installable). Run from the home screen already, neither is shown. Answers the
// function that writes the button's name again (for a change of language).

function initFullscreenControl() {
  const root = document.getElementById('fullscreen-control');
  const button = document.getElementById('btn-fullscreen');
  const hint = document.getElementById('fullscreen-hint');
  if (!root || !button || !hint) return () => {};
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  const can = Boolean((document.fullscreenEnabled ?? document.webkitFullscreenEnabled) && request && exit);
  const standalone = navigator.standalone === true || window.matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches;
  const ua = navigator.userAgent || '';
  const apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const on = () => Boolean(document.fullscreenElement || document.webkitFullscreenElement);
  const name = button.querySelector('.pop-name');
  const show = () => {
    button.setAttribute('aria-pressed', String(on()));
    // (the name is the button's own: i18n.js must not put the other one back)
    if (name) { name.dataset.i18n = on() ? 'screen.exit' : 'screen.full'; name.textContent = t(name.dataset.i18n); }
  };
  button.hidden = !can || standalone;
  hint.hidden = can || standalone || !apple;
  root.hidden = button.hidden && hint.hidden;
  if (button.hidden) return () => {};
  button.addEventListener('click', () => {
    // (the prefixed calls answer nothing; the standard ones a promise that rejects when the browser says no)
    try {
      Promise.resolve(on() ? exit.call(document) : request.call(el, { navigationUI: 'hide' })).catch(() => {});
    } catch { /* refused: the page stays as it is */ }
  });
  // (a browser may send both events for one change: the analytics hear of it once, whoever asked: the button, Esc or
  // the browser's own gesture)
  let was = on();
  const changed = () => {
    show();
    if (on() === was) return;
    was = on();
    track('fullscreen_toggle', { on: was });
  };
  for (const type of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(type, changed);
  show();
  return show;
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
