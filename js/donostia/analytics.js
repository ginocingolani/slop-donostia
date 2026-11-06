// js/donostia/analytics.js
// Usage analytics for Slop Donostia: a few hand-picked events to PostHog Cloud EU, with no cookies, no identifiers
// and nothing stored in the browser. Nothing of this loads on the New York page.
//
// The visitor chooses (js/donostia/consent.js, a small card once the city shows): with a cookie, PostHog's
// first-party one, the same visitor is the same person tomorrow; without, PostHog's cookieless mode, where who a
// visitor is comes from a hash of the IP, the user agent and a salt of the day, computed on PostHog's servers and
// never stored (the IP is dropped there), so one visitor is one "person" for one day and nobody can be followed from
// a day to the next. Until the choice is made the SDK sends nothing (cookieless_mode 'on_reject'): the events wait in
// the queue, as they do while the SDK loads, and go with their timestamps once it is made. PostHog remembers the
// choice (its cookie, or the refusal in localStorage); the data popover shows it and lets it change. No autocapture,
// no session replay, no heatmaps of the page, no feature flags, no surveys: only the events below. The SDK (its slim
// bundle, which loads no extras) is pinned from jsDelivr and imported off the critical path once the app's own module
// runs.
//
// Off on localhost, file: and *.local, with ?debug, under a WebDriver harness (the headless renders), and for a browser
// that says Do Not Track or Global Privacy Control. ?analytics=1 forces it on (to test from localhost; DNT/GPC still
// win), ?analytics=0 off.
//
// The events (every one also carries the SDK's coarse device fields, $browser, $os, $device_type, $screen_*, and ours,
// deviceInfo(): the GPU's vendor and architecture as WebGPU reports them, cores, memory, pixel ratio, touch):
// - the load funnel: $pageview (ours, queued like the rest: the SDK's own would be dropped while the choice is
//   pending) → app_start { webgpu } → world_built → shaders_compiled → app_ready { ms_<step>…, ms_total: the init
//   timings main.js logs } → first_move { after_s }; app_error { after, message } and gpu_lost { after, reason } where
//   it breaks (`after`: the last init step that completed);
// - the choice: cookie_consent { cookies, changed };
// - flying: fps_sample every minute (fps, fps_min, fps_bucket, altitude) and cell_visit when the camera has dwelt
//   DWELL_S in a cell of the CELL_SIZE grid (cell_x, cell_z: where people fly, for a heatmap of the map);
// - the HUD: teleport { id }, time_preset { id }, live_toggle { on }, map_open, hud_hide { hidden };
// - leaving: session_end { seconds, fps_avg, fps_min, teleports, time_presets, live_toggles, map_opens, cells,
//   moved } sent with a beacon on pagehide, and $pageleave (the SDK's own).
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
export const QUEUE_MAX = 400; // events held while the SDK loads or the choice is pending; past it the newest are dropped

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

export function fpsBucket(fps) {
  return fps < 15 ? '<15' : fps < 30 ? '15-30' : fps < 50 ? '30-50' : '50+';
}

// the heatmap's cell of a point of the map (world metres)
export function cellOf(x, z) {
  return [Math.floor(x / CELL_SIZE), Math.floor(z / CELL_SIZE)];
}

const COUNTED = { teleport: 'teleports', time_preset: 'time_presets', live_toggle: 'live_toggles', map_open: 'map_opens' };

// The session's running figures: the fps (all and the last minute's), the cell the camera is in and for how long,
// the first move, the HUD's counts. tick() returns the events the latest figures call for. Times in ms.
export function createSession() {
  let startAt = null, moved = false;
  const all = { sum: 0, n: 0, min: Infinity }, minute = { sum: 0, n: 0, min: Infinity };
  let sampleAt = 0, cellKey = null, cellAt = 0, cellPending = false, cells = 0;
  const counts = { teleports: 0, time_presets: 0, live_toggles: 0, map_opens: 0 };
  const add = (acc, fps) => { acc.sum += fps; acc.n++; acc.min = Math.min(acc.min, fps); };
  const avg = (acc) => (acc.n ? Math.round(acc.sum / acc.n) : null);
  return {
    start(t) { startAt = t; sampleAt = t; },
    get started() { return startAt !== null; },
    count(name) { if (COUNTED[name]) counts[COUNTED[name]]++; },
    tick(t, { fps, x, z, altitude, moving = false } = {}) {
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
      if (moving && !moved) {
        moved = true;
        events.push(['first_move', { after_s: Math.round((t - startAt) / 100) / 10 }]);
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
 * The tracker. loadSdk() resolves to the posthog-js module (or its default export); until it has, and until the
 * visitor's choice is made, track() queues. clock() is a monotonic ms time (performance.now), now() the wall clock
 * (Date.now) for the queued events' timestamps.
 */
export function createTracker({ enabled = true, loadSdk = null, clock = () => performance.now(), now = () => Date.now(), onError = () => {} } = {}) {
  const t0 = clock();
  const session = createSession();
  const device = {};
  const marks = {};
  const listeners = [];
  // ph: the SDK once loaded; sdk: the same once events may go to it (the choice made)
  let ph = null, sdk = null, failed = false, ended = false, queue = [], lastMark = 'start';
  const capture = (name, props, options) => {
    if (sdk) sdk.capture(name, props, options);
    else if (queue.length < QUEUE_MAX) queue.push([name, props, { ...options, timestamp: new Date(now()) }]);
  };
  const track = (name, props = {}) => {
    if (!enabled || failed || ended) return;
    session.count(name);
    capture(name, props);
  };
  const status = () => (ph && !failed ? ph.get_explicit_consent_status() : 'none');
  const notify = () => { const s = status(); for (const fn of listeners) fn(s); };
  // the SDK drops what is captured while the choice is pending: the queue goes once it is made
  const flush = () => {
    sdk = ph;
    for (const [name, props, options] of queue) sdk.capture(name, props, options);
    queue = [];
  };
  const loading = enabled && loadSdk
    ? Promise.resolve().then(loadSdk).then((mod) => {
      const instance = mod?.posthog ?? mod?.default ?? mod;
      instance.init(PROJECT_TOKEN, { ...SDK_CONFIG });
      instance.register(device);
      ph = instance;
      if (status() !== 'pending') flush();
      notify();
    }).catch((e) => { failed = true; queue = []; onError(e); })
    : Promise.resolve();
  return {
    get enabled() { return enabled && !failed; },
    get queued() { return queue.length; },
    loading,
    track,
    // 'pending' | 'granted' | 'denied', or 'none' without an SDK (off, loading, or failed)
    get consentStatus() { return status(); },
    // fn(status) when the SDK is there and whenever the choice changes (at once if it already is)
    onConsent(fn) { listeners.push(fn); if (ph && !failed) fn(status()); },
    // the visitor's choice: the cookie (true) or the cookieless hash (false); again later to change it
    decide(cookies) {
      if (!ph || failed || ended) return;
      const before = status();
      if (cookies) ph.opt_in_capturing({ captureEventName: null });
      else ph.opt_out_capturing();
      if (!sdk) flush();
      if (before === 'pending' || before !== status()) track('cookie_consent', { cookies: Boolean(cookies), changed: before !== 'pending' });
      notify();
    },
    // the device's coarse description, on every event from now on
    setDevice(props) { Object.assign(device, props); if (ph && !failed) ph.register(device); },
    // an init step done, in ms (main.js's markInit)
    mark(label, ms) { marks[label] = Math.round(ms); lastMark = label; },
    get after() { return lastMark; },
    error(e, props = {}) { track('app_error', { after: lastMark, message: String(e?.message ?? e).slice(0, 200), ...props }); },
    // the city shows: the init timings, and the session's clock starts
    ready() {
      const timings = Object.fromEntries(Object.entries(marks).map(([k, v]) => [`ms_${k.replace(/[^a-z0-9]+/gi, '_')}`, v]));
      track('app_ready', { ...timings, ms_total: Math.round(clock() - t0) });
      session.start(clock());
    },
    // a few times a second: { fps, x, z, altitude, moving }
    tick(state) { for (const [name, props] of session.tick(clock(), state)) track(name, props); },
    // the page goes: the session's summary, by beacon
    end() {
      if (!enabled || failed || ended) return;
      ended = true;
      if (sdk) sdk.capture('session_end', session.summary(clock()), { transport: 'sendBeacon', send_instantly: true });
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
  current = createTracker({ enabled, loadSdk, onError: (e) => console.warn('[analytics] off:', e?.message ?? e), ...options });
  return current;
}

/** An event on the page's tracker, from anywhere; nothing without one. */
export function track(name, props) {
  current?.track(name, props);
}
