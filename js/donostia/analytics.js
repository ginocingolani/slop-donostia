// js/donostia/analytics.js
// Usage analytics for Slop Donostia: a few hand-picked events to PostHog Cloud EU, with no cookie and no identifier
// in the browser unless the visitor says yes to the cookie. Nothing of this loads on the New York page.
//
// Cookieless unless the visitor accepts the cookie (js/donostia/consent.js, a small card once the city shows).
// Cookieless is PostHog's mode where who a visitor is comes from a hash of the IP, the user agent and a salt of the
// day, computed on PostHog's servers and never stored (the IP is dropped there), so one visitor is one "person" for
// one day and nobody can be followed from a day to the next; it holds from the first event, before the card is
// answered and after a "no". A "yes" sets PostHog's first-party cookie (ph_<token>_posthog, with its copies in
// localStorage and sessionStorage): the same visitor is the same person tomorrow (the events before it stay under
// that day's hash). The SDK runs in cookieless_mode 'on_reject', which sends nothing until it is told the choice, so
// the tracker tells it "rejected" as it loads and "accepted" on a yes; the answer itself (yes, no, or none yet) is
// ours, in localStorage under CHOICE_KEY, so the card knows whether to ask. What the browser holds without a yes is
// that answer once given, and the SDK's own note of its mode (localStorage __ph_opt_in_out_<token>: 0, from the
// first event: it reads it back on every capture, so it cannot be taken away): neither says who the visitor is.
// The data popover shows the answer and lets it change. No autocapture, no session replay, no heatmaps of the page,
// no feature flags, no surveys: only the events below. The SDK (its slim bundle, which loads no extras) is pinned
// from jsDelivr and imported off the critical path once the app's own module runs; the events before it is there
// wait in a queue with their timestamps. PostHog's SDK drops what a headless or bot browser sends, by its user agent.
//
// Off on localhost, file: and *.local, with ?debug, under a WebDriver harness (the headless renders), and for a browser
// that says Do Not Track or Global Privacy Control: nothing is loaded and nothing is sent. ?analytics=1 forces it on
// (to test from localhost; DNT/GPC still win), ?analytics=0 off.
//
// On every event (PostHog's "super-properties", registered with the SDK and refreshed when they change; ours are also
// stamped on each event as it happens, so one that waited in the queue says what was true then):
// - the SDK's coarse device fields: $browser, $os, $device_type, $screen_*;
// - the device, deviceInfo(): gpu_vendor, gpu_arch (as WebGPU reports them: never the model), cpu_cores, memory_gb,
//   dpr, touch (the screen can be touched at all);
// - the quality, qualityInfo() of js/donostia/quality.js's state: quality_mode ('auto', or the tier picked by hand),
//   quality_tier (the tier in force: 'low' | 'medium' | 'high' | 'ultra'), render_scale (the governor's share of the
//   tier's resolution, 0.6 .. 1), fps_capped (the frame rate is held from outside, e.g. Low Power Mode),
//   quality_detected (the tier this device starts at on auto). From quality.init() on: the page view and app_start
//   are sent before it;
// - the interface, interfaceInfo(): lang ('en' | 'eu' | 'es'), input ('touch': the stick and the phone layouts are
//   on; 'mouse' otherwise), orientation ('portrait' | 'landscape', the window's), display_mode ('browser';
//   'standalone': opened from the home screen; 'fullscreen': a browser tab gone full screen).
//
// The events:
// - the load funnel: $pageview (ours, queued like the rest: the SDK's own goes before it is told the choice, and is
//   dropped) → app_start { webgpu } → world_built → shaders_compiled → app_ready { ms_<step>… (the init timings
//   main.js logs), ms_total, shaders_pending, shaders_total } → details_ready { ms_since_ready, ms_total,
//   shaders_total, quality_changed } → first_move { after_s, by }. The load is progressive: app_ready is "the city
//   shows" (the first view's shaders are compiled; on the phone tiers shaders_pending of the shaders_total jobs
//   still compile behind it), details_ready the end of that background compile (at once, with ms_since_ready 0,
//   where nothing was left; quality_changed: a tier was picked by hand meanwhile, and the time includes applying it).
//   first_move's `by` is 'fly' (the keys or the stick moved the camera) or 'look' (a drag on the view or the arrow
//   keys turned it), whichever came first: the super-property `input` says whether by touch.
//   Where it breaks: app_unsupported { reason: 'no_api' | 'no_adapter' | 'no_device' } (no WebGPU: the page says so
//   and stops), app_error { after, message } and gpu_lost { after, reason, hidden } (`after`: the last init step that
//   completed; `hidden`: the page was in the background, where a phone takes the GPU's memory back);
// - the answer: cookie_consent { cookies, changed, lang } (`changed`: from the popover, after a first answer; `lang`:
//   the language the card was read in);
// - flying: fps_sample every minute (fps, fps_min, fps_bucket, altitude) and cell_visit { cell_x, cell_z, altitude }
//   when the camera has dwelt DWELL_S in a cell of the CELL_SIZE grid (where people fly, for a heatmap of the map);
// - quality: quality_change { from, to, by, from_mode, to_mode } when the mode or the tier in force changes: by
//   'user' (a pick in the settings sheet; from / to are the tiers in force before and after, from_mode / to_mode
//   what was asked for, 'auto' or a tier) or by 'governor' (on auto, the tier stepped for the frame rate; with
//   `steps`, how many of its steps the event stands for). The governor's are rate-limited: one at once, then at
//   most one every QUALITY_GAP_S that sums up the steps since (none if they came back to where they were), and
//   QUALITY_MAX a visit. A change of the render scale alone is no event: render_scale on the next events says it;
// - the HUD: teleport { id }, time_preset { id }, live_toggle { on }, map_open, hud_hide { hidden },
//   language_change { from, to }, fullscreen_toggle { on };
// - leaving: session_end { seconds, fps_avg, fps_min, teleports, time_presets, live_toggles, map_opens, cells,
//   moved, details } sent with a beacon on pagehide (`details`: the background compile had ended), and $pageleave
//   (the SDK's own).
//
// initAnalytics(options) decides, loads and returns the tracker; track(name, props) sends on it from anywhere (hud.js).
// createTracker() and the helpers take their environment as arguments, so tests/donostia-analytics.test.mjs runs them
// without a browser.

export const PROJECT_TOKEN = 'phc_ysAQfKqhXUwXBtcPyK8c2SwxmCDAdoDahYKLTffHLDPC'; // (public: it can only write events)
export const API_HOST = 'https://eu.i.posthog.com';
export const SDK_URL = 'https://cdn.jsdelivr.net/npm/posthog-js@1.447.3/dist/module.slim.no-external.js';
export const CELL_SIZE = 100; // m: the grid of the flight heatmap
export const DWELL_S = 2; // s in a cell before it counts as visited
export const FPS_SAMPLE_S = 60; // s between fps samples
export const MOVE_SPEED = 0.5; // m/s: the camera is being flown (a flight to a viewpoint is not a move)
export const LOOK_TURN = 0.02; // rad between two ticks: the camera is being turned (about a degree)
export const QUALITY_GAP_S = 30; // s between two quality_change events of the governor
export const QUALITY_MAX = 20; // quality_change events of the governor in one visit
export const QUEUE_MAX = 400; // events held while the SDK loads; past it the newest are dropped
export const CHOICE_KEY = 'donostia-cookies'; // localStorage: 'yes' or 'no' once the card is answered

// the answer as stored: 'yes' | 'no' | null
export function readChoice(storage) {
  try {
    const v = storage?.getItem(CHOICE_KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch { return null; }
}

// The SDK's configuration (https://posthog.com/docs/libraries/js/config): cookieless unless the visitor accepts the
// cookie, and every automatic capture but the page leave off (the page view is ours, see above)
export const SDK_CONFIG = Object.freeze({
  api_host: API_HOST,
  defaults: '2026-08-30',
  cookieless_mode: 'on_reject',
  person_profiles: 'never',
  respect_dnt: true,
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: true,
  capture_dead_clicks: false,
  rageclick: false,
  capture_performance: false,
  capture_heatmaps: false,
  disable_session_recording: true,
  disable_surveys: true,
  disable_web_experiments: true,
  advanced_disable_flags: true,
  disable_external_dependency_loading: true
});

/**
 * Whether to track at all, from the page's location and the browser's signals (every field optional):
 * { hostname, protocol, search, webdriver, doNotTrack, gpc }.
 */
export function analyticsAllowed({ hostname = '', protocol = 'https:', search = '', webdriver = false, doNotTrack = null, gpc = false } = {}) {
  // a browser that asks not to be tracked is not, whatever the page says
  if (doNotTrack === '1' || doNotTrack === 'yes' || gpc === true) return false;
  const params = new URLSearchParams(search);
  if (params.has('analytics')) return params.get('analytics') !== '0';
  if (params.has('debug') || webdriver) return false;
  if (protocol !== 'https:' && protocol !== 'http:') return false;
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  if (hostname === '[::1]' || hostname === '::1' || /^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return false;
  return true;
}

// the coarse device: what WebGPU says of the GPU (vendor & architecture only), the cores, the memory, the pixel ratio
export function deviceInfo({ navigator: nav = {}, devicePixelRatio = 1, adapterInfo = null } = {}) {
  const props = {};
  if (adapterInfo?.vendor) props.gpu_vendor = String(adapterInfo.vendor).slice(0, 40);
  if (adapterInfo?.architecture) props.gpu_arch = String(adapterInfo.architecture).slice(0, 40);
  if (Number.isFinite(nav.hardwareConcurrency)) props.cpu_cores = nav.hardwareConcurrency;
  if (Number.isFinite(nav.deviceMemory)) props.memory_gb = nav.deviceMemory;
  if (Number.isFinite(devicePixelRatio)) props.dpr = Math.round(devicePixelRatio * 100) / 100;
  props.touch = (nav.maxTouchPoints ?? 0) > 0;
  return props;
}

// the quality in force, from js/donostia/quality.js's state (quality.get(), or what quality.onChange() hands over)
export function qualityInfo(state) {
  if (!state || typeof state !== 'object') return {};
  const props = {};
  if (state.mode != null) props.quality_mode = String(state.mode);
  if (state.tier != null) props.quality_tier = String(state.tier);
  if (Number.isFinite(state.scale)) props.render_scale = Math.round(state.scale * 100) / 100;
  props.fps_capped = Boolean(state.capped);
  if (state.detected != null) props.quality_detected = String(state.detected);
  return props;
}

/**
 * The interface as the visitor has it: { lang, touch (the touch layout is on), width, height (the window's),
 * standalone (opened from the home screen), fullscreen (a tab gone full screen) } -> the super-properties.
 */
export function interfaceInfo({ lang = null, touch = false, width = 0, height = 0, standalone = false, fullscreen = false } = {}) {
  const props = {};
  if (lang) props.lang = String(lang);
  props.input = touch ? 'touch' : 'mouse';
  if (width > 0 && height > 0) props.orientation = height >= width ? 'portrait' : 'landscape';
  props.display_mode = standalone ? 'standalone' : fullscreen ? 'fullscreen' : 'browser';
  return props;
}

/**
 * A function that reads the interface off the page, for createTracker({ readInterface }). Whether the app was opened
 * from the home screen is settled here, once: the manifest asks for full screen there, so a page that starts in the
 * fullscreen (or standalone) display mode is the installed one, and one that gets there later is a tab gone full
 * screen. getLang() is js/donostia/i18n.js's; body.touch-enabled is js/donostia/touch.js's (a screen that can be
 * touched, or one that has been).
 */
export function interfaceReader({ win = null, doc = null, getLang = () => null } = {}) {
  const media = (query) => { try { return win?.matchMedia?.(query)?.matches === true; } catch { return false; } };
  const standalone = win?.navigator?.standalone === true || media('(display-mode: standalone)') || media('(display-mode: fullscreen)');
  return () => interfaceInfo({
    lang: getLang(),
    // (the touch layout, or before the HUD is there the very test it will make: js/donostia/touch.js)
    touch: doc?.body?.classList?.contains('touch-enabled') === true || media('(any-pointer: coarse)'),
    width: win?.innerWidth, height: win?.innerHeight,
    standalone,
    fullscreen: Boolean(doc?.fullscreenElement || doc?.webkitFullscreenElement) || media('(display-mode: fullscreen)')
  });
}

export function fpsBucket(fps) {
  return fps < 15 ? '<15' : fps < 30 ? '15-30' : fps < 50 ? '30-50' : '50+';
}

// the heatmap's cell of a point of the map (world metres)
export function cellOf(x, z) {
  return [Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE)];
}

const COUNTED = { teleport: 'teleports', time_preset: 'time_presets', live_toggle: 'live_toggles', map_open: 'map_opens' };
const same = (a, b) => { const ka = Object.keys(a), kb = Object.keys(b); return ka.length === kb.length && ka.every((k) => a[k] === b[k]); };
// the least turn between two angles (rad)
const turned = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

// The session's running figures: the fps (all and the last minute's), the cell the camera is in and for how long,
// the first move, the HUD's counts. tick() returns the events the latest figures call for. Times in ms.
export function createSession() {
  let startAt = null, moved = false, heading = null;
  const all = { sum: 0, n: 0, min: Infinity }, minute = { sum: 0, n: 0, min: Infinity };
  let sampleAt = 0, cellKey = null, cellAt = 0, cellPending = false, cells = 0;
  const counts = { teleports: 0, time_presets: 0, live_toggles: 0, map_opens: 0 };
  const add = (acc, fps) => { acc.sum += fps; acc.n++; acc.min = Math.min(acc.min, fps); };
  const avg = (acc) => (acc.n ? Math.round(acc.sum / acc.n) : null);
  return {
    start(t) { startAt = t; sampleAt = t; },
    get started() { return startAt !== null; },
    get startedAt() { return startAt; },
    count(name) { if (COUNTED[name]) counts[COUNTED[name]]++; },
    // { fps, x, z, altitude, moving (the camera is flown: main.js's speed over MOVE_SPEED), yaw, pitch (where it looks,
    // rad), flight (on its way to a viewpoint: neither a move nor a look) }
    tick(t, { fps, x, z, altitude, moving = false, yaw, pitch, flight = false } = {}) {
      if (startAt === null) return [];
      const events = [];
      if (Number.isFinite(fps) && fps > 0) { add(all, fps); add(minute, fps); }
      if (t - sampleAt >= FPS_SAMPLE_S * 1000) {
        if (minute.n) events.push(['fps_sample', { fps: avg(minute), fps_min: minute.min, fps_bucket: fpsBucket(avg(minute)), altitude: Math.round(altitude ?? 0) }]);
        Object.assign(minute, { sum: 0, n: 0, min: Infinity });
        sampleAt = t;
      }
      if (Number.isFinite(x) && Number.isFinite(z)) {
        const [cx, cz] = cellOf(x, z), key = `${cx},${cz}`;
        if (key !== cellKey) { cellKey = key; cellAt = t; cellPending = true; }
        else if (cellPending && t - cellAt >= DWELL_S * 1000) {
          cellPending = false;
          cells++;
          events.push(['cell_visit', { cell_x: cx, cell_z: cz, altitude: Math.round(altitude ?? 0) }]);
        }
      }
      // The first move: the camera flown (the keys, the stick), or turned between two ticks (a drag on the view, by
      // mouse or by finger, or the arrow keys). A flight to a viewpoint turns it too: the heading starts afresh after.
      const looking = Number.isFinite(yaw) && Number.isFinite(pitch) && !flight;
      const looked = looking && heading !== null && turned(yaw, heading[0]) + Math.abs(pitch - heading[1]) > LOOK_TURN;
      heading = looking ? [yaw, pitch] : null;
      if ((moving || looked) && !moved) {
        moved = true;
        events.push(['first_move', { after_s: Math.round((t - startAt) / 100) / 10, by: moving ? 'fly' : 'look' }]);
      }
      return events;
    },
    summary(t) {
      return {
        seconds: startAt === null ? 0 : Math.round((t - startAt) / 1000),
        fps_avg: avg(all), fps_min: all.n ? all.min : null,
        ...counts, cells, moved
      };
    }
  };
}

/**
 * The tracker. loadSdk() resolves to the posthog-js module (or its default export); until it has, track() queues.
 * storage holds the answer (localStorage; anything with getItem/setItem). clock() is a monotonic ms time
 * (performance.now), now() the wall clock (Date.now) for the queued events' timestamps. readInterface() answers the
 * interface's super-properties (interfaceReader()): asked before every event, so each says the language, the input
 * and the display mode of its moment.
 */
export function createTracker({ enabled = true, loadSdk = null, storage = null, clock = () => performance.now(), now = () => Date.now(), readInterface = null, onError = () => {} } = {}) {
  const t0 = clock();
  const session = createSession();
  const device = {};
  const marks = {};
  const listeners = [];
  let sdk = null, failed = false, ended = false, queue = [], lastMark = 'start';
  let choice = readChoice(storage);
  // the super-properties that change: the quality (null until quality.js has booted) and the interface
  let quality = null, face = {};
  let detailsAt = null, picked = false; // the background compile's end; a tier picked by hand before it
  let governed = null, governedAt = null, governedSent = 0; // the governor's steps not yet said, and its last event
  const off = () => !enabled || failed || ended;
  const register = (props) => { try { sdk?.register(props); } catch (e) { onError(e); } };
  const refreshInterface = () => {
    if (!readInterface) return;
    let next;
    try { next = readInterface(); } catch { return; }
    if (!next || same(next, face)) return;
    face = { ...next };
    register(face);
  };
  // (never an error of ours in the page's way: the callers are the HUD's handlers and the render loop)
  const capture = (name, props, options) => {
    if (!sdk) { if (queue.length < QUEUE_MAX) queue.push([name, props, { ...options, timestamp: new Date(now()) }]); return; }
    try { sdk.capture(name, props, options); } catch (e) { onError(e); }
  };
  const track = (name, props = {}) => {
    if (off()) return;
    session.count(name);
    refreshInterface();
    capture(name, { ...quality, ...face, ...props });
  };
  // the governor's steps since its last event, as one (none if the tier is back where it was)
  const flushGoverned = (force = false) => {
    if (!governed) return;
    const t = clock();
    if (!force && governedAt !== null && t - governedAt < QUALITY_GAP_S * 1000) return;
    const { from, to, steps } = governed;
    governed = null;
    if (from === to || governedSent >= QUALITY_MAX) return;
    governedAt = t;
    governedSent++;
    track('quality_change', { from, to, by: 'governor', from_mode: 'auto', to_mode: 'auto', steps });
  };
  // ours, from the answer; the SDK's own consent is what it is told below
  const status = () => (sdk && !failed ? (choice === 'yes' ? 'granted' : choice === 'no' ? 'denied' : 'pending') : 'none');
  const notify = () => { const s = status(); for (const fn of listeners) fn(s); };
  // The SDK is told the answer, or "rejected" without one, so it captures (cookieless) from the start: in 'on_reject'
  // it drops everything until told. Told only what it doesn't already hold (it remembers across visits).
  const tell = (ph) => {
    const wanted = choice === 'yes' ? 'granted' : 'denied';
    if (ph.get_explicit_consent_status() === wanted) return;
    if (wanted === 'granted') ph.opt_in_capturing({ captureEventName: null });
    else ph.opt_out_capturing();
  };
  const loading = enabled && loadSdk
    ? Promise.resolve().then(loadSdk).then((mod) => {
      const ph = mod?.posthog ?? mod?.default ?? mod;
      ph.init(PROJECT_TOKEN, { ...SDK_CONFIG });
      tell(ph);
      // (after the SDK is told: going cookieless it starts afresh, and what was registered before is gone)
      ph.register({ ...device, ...quality, ...face });
      sdk = ph;
      for (const [name, props, options] of queue) sdk.capture(name, props, options);
      queue = [];
      notify();
    }).catch((e) => { failed = true; queue = []; onError(e); })
    : Promise.resolve();
  return {
    get enabled() { return enabled && !failed; },
    get queued() { return queue.length; },
    loading,
    track,
    // the answer: 'pending' (not asked yet: cookieless), 'granted' (the cookie) or 'denied' (cookieless), or 'none'
    // without an SDK (off, loading, or failed)
    get consentStatus() { return status(); },
    // fn(status) when the SDK is there and whenever the answer changes (at once if it already is)
    onConsent(fn) { listeners.push(fn); if (sdk && !failed) fn(status()); },
    // the answer: the cookie (true) or cookieless (false); again later to change it
    decide(cookies) {
      if (!sdk || failed || ended) return;
      const before = status();
      choice = cookies ? 'yes' : 'no';
      try { storage?.setItem(CHOICE_KEY, choice); } catch { /* storage unavailable */ }
      tell(sdk);
      // (the SDK starts afresh when the answer changes: the super-properties again)
      register({ ...device, ...quality, ...face });
      if (before !== status()) {
        refreshInterface();
        track('cookie_consent', { cookies: Boolean(cookies), changed: before !== 'pending', ...(face.lang ? { lang: face.lang } : {}) });
      }
      notify();
    },
    // the device's coarse description, on every event from now on
    setDevice(props) { Object.assign(device, props); register(device); },
    // The quality in force (quality.get() once it has booted, then every state quality.onChange() hands over): on
    // every event from now on, and a quality_change when the mode (a pick by hand) or the tier (the governor) moved
    setQuality(state) {
      if (!enabled || failed) return;
      const next = qualityInfo(state), before = quality;
      if (before && same(before, next)) return;
      quality = next;
      register(quality);
      if (!before || ended) return;
      if (before.quality_mode !== next.quality_mode) {
        flushGoverned(true); // (in the order they happened)
        if (session.started && detailsAt === null) picked = true;
        track('quality_change', { from: before.quality_tier, to: next.quality_tier, by: 'user', from_mode: before.quality_mode, to_mode: next.quality_mode });
      } else if (before.quality_tier !== next.quality_tier) {
        governed = governed ? { ...governed, to: next.quality_tier, steps: governed.steps + 1 } : { from: before.quality_tier, to: next.quality_tier, steps: 1 };
        flushGoverned();
      }
    },
    // an init step done, in ms (main.js's markInit)
    mark(label, ms) { marks[label] = Math.round(ms); lastMark = label; },
    get after() { return lastMark; },
    error(e, props = {}) { track('app_error', { after: lastMark, message: String(e?.message ?? e).slice(0, 200), ...props }); },
    // the city shows: the init timings, what is left to compile behind it, and the session's clock starts
    ready(props = {}) {
      if (session.started) return;
      const timings = Object.fromEntries(Object.entries(marks).map(([k, v]) => [`ms_${k.replace(/[^a-z0-9]+/gi, '_')}`, v]));
      track('app_ready', { ...timings, ms_total: Math.round(clock() - t0), ...props });
      session.start(clock());
    },
    // the background compile ended (or there was none): once, after ready()
    details(props = {}) {
      if (!session.started || detailsAt !== null) return;
      detailsAt = clock();
      track('details_ready', { ms_since_ready: Math.round(detailsAt - session.startedAt), ms_total: Math.round(detailsAt - t0), ...props, quality_changed: picked });
    },
    // a few times a second: { fps, x, z, altitude, moving, yaw, pitch, flight }
    tick(state) {
      if (off()) return;
      flushGoverned();
      for (const [name, props] of session.tick(clock(), state)) track(name, props);
    },
    // the page goes: the session's summary, by beacon
    end() {
      if (off()) return;
      flushGoverned(true);
      refreshInterface();
      ended = true;
      if (sdk) capture('session_end', { ...quality, ...face, ...session.summary(clock()), details: detailsAt !== null }, { transport: 'sendBeacon', send_instantly: true });
    }
  };
}

let current = null;

/** The page's tracker (main.js): decides from the page and the browser, loads the SDK if so. */
export function initAnalytics({ loadSdk = () => import(/* webpackIgnore: true */ SDK_URL), ...options } = {}) {
  const nav = typeof navigator !== 'undefined' ? navigator : {};
  const loc = typeof location !== 'undefined' ? location : {};
  const enabled = analyticsAllowed({
    hostname: loc.hostname, protocol: loc.protocol, search: loc.search,
    webdriver: nav.webdriver === true,
    doNotTrack: nav.doNotTrack ?? (typeof window !== 'undefined' ? window.doNotTrack : null),
    gpc: nav.globalPrivacyControl === true
  });
  let storage = null;
  try { storage = typeof localStorage !== 'undefined' ? localStorage : null; } catch { /* storage blocked: the card asks every visit */ }
  current = createTracker({ enabled, loadSdk, storage, onError: (e) => console.warn('[analytics]', e?.message ?? e), ...options });
  return current;
}

/** An event on the page's tracker, from anywhere; nothing without one. */
export function track(name, props) {
  current?.track(name, props);
}
