import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The usage analytics (js/donostia/analytics.js): when they are off, what the tracker sends and when, the session's
// figures, and that the page wires them in. No browser: the tracker takes a fake SDK and clocks.

const root = fileURLToPath(new URL('../', import.meta.url));
const analytics = await import(pathToFileURL(`${root}js/donostia/analytics.js`).href);
const { analyticsAllowed, createTracker, createSession, cellOf, fpsBucket, deviceInfo, SDK_CONFIG, SDK_URL, CELL_SIZE, DWELL_S, FPS_SAMPLE_S } = analytics;

// a posthog-js stand-in that records its calls; `consent` is the choice it remembers ('granted' for a returning
// visitor who accepted the cookie, 'denied', or 'pending' for a first visit)
function fakeSdk(consent = 'granted') {
  const calls = [];
  const sdk = {
    calls,
    init: (token, config) => calls.push(['init', token, config]),
    register: (props) => calls.push(['register', { ...props }]),
    capture: (name, props, options) => calls.push(['capture', name, { ...props }, options]),
    get_explicit_consent_status: () => consent,
    opt_in_capturing: (options) => { consent = 'granted'; calls.push(['opt_in', options]); },
    opt_out_capturing: () => { consent = 'denied'; calls.push(['opt_out']); }
  };
  return sdk;
}
const captured = (sdk) => sdk.calls.filter((c) => c[0] === 'capture').map((c) => c[1]);

// clocks under test control
function clocks(start = 1000) {
  let t = start;
  return { clock: () => t, now: () => 1_700_000_000_000 + t, advance: (ms) => { t += ms; } };
}

test('the analytics are off where they would only measure us', () => {
  const live = { hostname: 'ginocingolani.github.io', protocol: 'https:', search: '' };
  assert.equal(analyticsAllowed(live), true);
  assert.equal(analyticsAllowed({ ...live, search: '?debug' }), false, '?debug');
  assert.equal(analyticsAllowed({ ...live, webdriver: true }), false, 'a WebDriver harness');
  assert.equal(analyticsAllowed({ ...live, hostname: 'localhost' }), false, 'localhost');
  assert.equal(analyticsAllowed({ ...live, hostname: '127.0.0.1' }), false, 'a loopback address');
  assert.equal(analyticsAllowed({ ...live, hostname: '192.168.1.20' }), false, 'a LAN address');
  assert.equal(analyticsAllowed({ ...live, hostname: 'gino.local' }), false, 'a .local host');
  assert.equal(analyticsAllowed({ hostname: '', protocol: 'file:' }), false, 'a file');
  assert.equal(analyticsAllowed({}), false, 'nothing known');
  // forced on from localhost to test, and off anywhere
  assert.equal(analyticsAllowed({ ...live, hostname: 'localhost', search: '?analytics=1' }), true);
  assert.equal(analyticsAllowed({ ...live, hostname: 'localhost', search: '?debug&analytics=1' }), true);
  assert.equal(analyticsAllowed({ ...live, search: '?analytics=0' }), false);
});

test('a browser that asks not to be tracked is not, whatever the page says', () => {
  const live = { hostname: 'ginocingolani.github.io', protocol: 'https:', search: '?analytics=1' };
  assert.equal(analyticsAllowed({ ...live, doNotTrack: '1' }), false, 'Do Not Track');
  assert.equal(analyticsAllowed({ ...live, doNotTrack: 'yes' }), false, 'Do Not Track (old IE spelling)');
  assert.equal(analyticsAllowed({ ...live, gpc: true }), false, 'Global Privacy Control');
  assert.equal(analyticsAllowed({ ...live, doNotTrack: '0' }), true);
  assert.equal(analyticsAllowed({ ...live, doNotTrack: 'unspecified' }), true);
});

test('the SDK is pinned, cookieless unless the cookie is accepted, and captures nothing of its own but the page leave', () => {
  assert.match(SDK_URL, /^https:\/\/cdn\.jsdelivr\.net\/npm\/posthog-js@\d+\.\d+\.\d+\/dist\/module\.slim\.no-external\.js$/);
  assert.equal(SDK_CONFIG.cookieless_mode, 'on_reject');
  assert.equal(SDK_CONFIG.person_profiles, 'never');
  assert.equal(SDK_CONFIG.api_host, 'https://eu.i.posthog.com', 'EU cloud');
  assert.match(SDK_CONFIG.defaults, /^\d{4}-\d{2}-\d{2}$/, 'the SDK defaults are a dated snapshot');
  assert.equal(SDK_CONFIG.autocapture, false);
  assert.equal(SDK_CONFIG.disable_session_recording, true);
  assert.equal(SDK_CONFIG.disable_surveys, true);
  assert.equal(SDK_CONFIG.advanced_disable_flags, true);
  assert.equal(SDK_CONFIG.disable_external_dependency_loading, true);
  assert.equal(SDK_CONFIG.capture_pageview, false, "the SDK's own page view goes before it is told the choice, and is dropped: main.js queues one");
  assert.equal(SDK_CONFIG.capture_pageleave, true);
  assert.equal(SDK_CONFIG.respect_dnt, true);
});

// the answer as the page remembers it (localStorage)
const fakeStorage = (choice = null) => {
  const items = new Map(choice ? [[analytics.CHOICE_KEY, choice]] : []);
  return { getItem: (k) => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v)), items };
};

test('cookieless from the first event, before the card is answered; the cookie on a yes', async () => {
  const sdk = fakeSdk('pending'); // (the SDK has no choice stored: a first visit)
  const storage = fakeStorage();
  const c = clocks();
  const statuses = [];
  const tracker = createTracker({ loadSdk: () => sdk, storage, ...c });
  tracker.onConsent((s) => statuses.push(s));
  assert.equal(tracker.consentStatus, 'none', 'no SDK yet');
  tracker.track('$pageview');
  tracker.track('app_start', { webgpu: true });
  await tracker.loading;
  assert.deepEqual(sdk.calls.slice(0, 3).map((call) => call[0]), ['init', 'register', 'opt_out'], 'the SDK is told "rejected" as it loads: cookieless, and capturing');
  assert.deepEqual(captured(sdk), ['$pageview', 'app_start'], 'the queue goes at once');
  assert.equal(tracker.consentStatus, 'pending', 'not asked yet');
  assert.deepEqual(statuses, ['pending']);
  assert.equal(storage.items.size, 0, 'nothing stored without an answer');
  c.advance(5000);
  tracker.ready();
  tracker.track('teleport', { id: 'urgull' });
  assert.deepEqual(captured(sdk), ['$pageview', 'app_start', 'app_ready', 'teleport'], 'straight through, cookieless');
  tracker.decide(true);
  assert.deepEqual(sdk.calls.find((call) => call[0] === 'opt_in'), ['opt_in', { captureEventName: null }], 'the SDK sets its cookie, without an event of its own');
  assert.deepEqual(sdk.calls.at(-1).slice(1, 3), ['cookie_consent', { cookies: true, changed: false }]);
  assert.equal(storage.getItem(analytics.CHOICE_KEY), 'yes');
  assert.equal(tracker.consentStatus, 'granted');
  assert.deepEqual(statuses, ['pending', 'granted']);
  // changed later, from the data popover: the SDK goes cookieless again, and the change is an event
  tracker.decide(false);
  assert.equal(sdk.calls.filter((call) => call[0] === 'opt_out').length, 2);
  assert.deepEqual(sdk.calls.at(-1).slice(1, 3), ['cookie_consent', { cookies: false, changed: true }]);
  assert.equal(storage.getItem(analytics.CHOICE_KEY), 'no');
  assert.deepEqual(statuses, ['pending', 'granted', 'denied']);
  // the same answer again changes nothing
  tracker.decide(false);
  assert.equal(captured(sdk).filter((name) => name === 'cookie_consent').length, 2);
  assert.equal(sdk.calls.filter((call) => call[0] === 'opt_out').length, 2);
});

test('a visitor who answered is not asked again, and the SDK is told only what it does not hold', async () => {
  // the usual case: the SDK remembers the same answer
  for (const [choice, held, status] of [['yes', 'granted', 'granted'], ['no', 'denied', 'denied']]) {
    const sdk = fakeSdk(held);
    const tracker = createTracker({ loadSdk: () => sdk, storage: fakeStorage(choice), ...clocks() });
    tracker.track('$pageview');
    await tracker.loading;
    assert.equal(tracker.consentStatus, status);
    assert.deepEqual(captured(sdk), ['$pageview']);
    assert.ok(!sdk.calls.some((call) => call[0] === 'opt_in' || call[0] === 'opt_out'), 'nothing to tell the SDK');
  }
  // the SDK's storage gone but ours not (or the reverse): the SDK is told again
  const sdk = fakeSdk('pending');
  const tracker = createTracker({ loadSdk: () => sdk, storage: fakeStorage('yes'), ...clocks() });
  await tracker.loading;
  assert.equal(sdk.calls.filter((call) => call[0] === 'opt_in').length, 1);
  assert.equal(tracker.consentStatus, 'granted');
  const sdk2 = fakeSdk('granted');
  const tracker2 = createTracker({ loadSdk: () => sdk2, storage: fakeStorage(), ...clocks() });
  await tracker2.loading;
  assert.equal(sdk2.calls.filter((call) => call[0] === 'opt_out').length, 1, 'no answer of ours: cookieless until asked');
  assert.equal(tracker2.consentStatus, 'pending');
  // a listener added late hears the answer at once
  const heard = [];
  tracker.onConsent((s) => heard.push(s));
  assert.deepEqual(heard, ['granted']);
  // no storage at all: asked every visit, still cookieless
  const bare = createTracker({ loadSdk: () => fakeSdk('pending'), ...clocks() });
  await bare.loading;
  assert.equal(bare.consentStatus, 'pending');
  bare.decide(true);
  assert.equal(bare.consentStatus, 'granted');
  // decide() before the SDK is there, or after it failed, does nothing
  const early = createTracker({ loadSdk: () => new Promise(() => {}), storage: fakeStorage(), ...clocks() });
  early.decide(true);
  assert.equal(early.consentStatus, 'none');
  assert.equal(analytics.readChoice({ getItem: () => 'maybe' }), null, 'only yes or no count');
  assert.equal(analytics.readChoice({ getItem: () => { throw new Error('blocked'); } }), null);
});

test('the queue is bounded while the SDK loads', async () => {
  const sdk = fakeSdk('pending');
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const tracker = createTracker({ loadSdk: () => pending, ...clocks() });
  for (let i = 0; i < analytics.QUEUE_MAX + 50; i++) tracker.track('cell_visit', { cell_x: i, cell_z: 0 });
  assert.equal(tracker.queued, analytics.QUEUE_MAX);
  resolve(sdk);
  await tracker.loading;
  assert.equal(captured(sdk).length, analytics.QUEUE_MAX);
});

// the consent card (js/donostia/consent.js) against a bare DOM stand-in
test('the card shows once the city shows until it is answered, and the popover offers to change the answer', async () => {
  const { initConsent } = await import(pathToFileURL(`${root}js/donostia/consent.js`).href);
  const elements = {};
  const el = (id) => (elements[id] ??= { id, hidden: true, textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, click() { this.handlers.click?.(); }, hidePopover() { this.popoverHidden = true; } });
  const doc = { getElementById: (id) => el(id) };
  const sdk = fakeSdk('pending');
  const storage = fakeStorage();
  const tracker = createTracker({ loadSdk: () => sdk, storage, ...clocks() });
  const consent = initConsent(tracker, doc);
  assert.equal(el('consent-card').hidden, true, 'nothing before the SDK');
  assert.equal(el('consent-line').hidden, true);
  await tracker.loading;
  assert.equal(el('consent-card').hidden, true, 'not over the loading screen');
  consent.setReady();
  assert.equal(consent.shown, true);
  assert.equal(el('consent-line').hidden, false);
  assert.match(el('consent-state').textContent, /sin responder \(sin cookie\)/);
  el('consent-decline').click();
  assert.equal(consent.shown, false);
  assert.equal(tracker.consentStatus, 'denied');
  assert.match(el('consent-state').textContent, /^ez .*sin cookie\)$/);
  // choose again from the data popover
  el('consent-change').click();
  assert.equal(el('credits-popover').popoverHidden, true);
  assert.equal(consent.shown, true);
  el('consent-accept').click();
  assert.equal(consent.shown, false);
  assert.equal(tracker.consentStatus, 'granted');
  assert.match(el('consent-state').textContent, /^bai .*\(cookie\)$/);
  // a visitor who answered never sees the card again
  const back = initConsent(createTracker({ loadSdk: () => fakeSdk('granted'), storage: fakeStorage('yes'), ...clocks() }), { getElementById: (id) => el(`back-${id}`) });
  await new Promise((r) => setTimeout(r, 0));
  back.setReady();
  assert.equal(back.shown, false);
  assert.equal(el('back-consent-line').hidden, false);
  // analytics off: no card, no popover line
  const off = initConsent(createTracker({ enabled: false, loadSdk: () => fakeSdk('pending') }), { getElementById: (id) => el(`off-${id}`) });
  off.setReady();
  assert.equal(off.shown, false);
  assert.equal(el('off-consent-line').hidden, true);
});

test('a disabled tracker never loads the SDK and drops everything', async () => {
  let loaded = 0;
  const tracker = createTracker({ enabled: false, loadSdk: () => { loaded++; return fakeSdk(); }, ...clocks() });
  tracker.track('app_start', { webgpu: true });
  tracker.ready();
  tracker.tick({ fps: 60, x: 0, z: 0, altitude: 10, moving: true });
  tracker.end();
  await tracker.loading;
  assert.equal(loaded, 0);
  assert.equal(tracker.enabled, false);
  assert.equal(tracker.queued, 0);
});

test('events before the SDK is there wait with their timestamps, then go in order', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const tracker = createTracker({ loadSdk: () => pending, storage: fakeStorage('yes'), ...c }); // (answered before: the SDK is told nothing)
  tracker.track('app_start', { webgpu: true });
  c.advance(1500);
  tracker.mark('renderer', 1500);
  tracker.setDevice({ gpu_vendor: 'apple', cpu_cores: 8 });
  tracker.track('world_built');
  assert.equal(tracker.queued, 2);
  assert.equal(sdk.calls.length, 0, 'nothing yet');
  resolve(sdk);
  await tracker.loading;
  assert.equal(tracker.queued, 0);
  assert.deepEqual(sdk.calls[0].slice(0, 2), ['init', analytics.PROJECT_TOKEN]);
  assert.deepEqual(sdk.calls[0][2], { ...SDK_CONFIG });
  assert.deepEqual(sdk.calls[1], ['register', { gpu_vendor: 'apple', cpu_cores: 8 }], 'the device goes on every event');
  assert.deepEqual(captured(sdk), ['app_start', 'world_built']);
  const [, , startProps, startOptions] = sdk.calls[2];
  assert.deepEqual(startProps, { webgpu: true });
  assert.equal(startOptions.timestamp.getTime(), 1_700_000_000_000 + 1000, 'the queued event keeps the time it happened');
  assert.equal(sdk.calls[3][3].timestamp.getTime(), 1_700_000_000_000 + 2500);
  // the module may hand the instance over as its default export or as `posthog`
  const sdk2 = fakeSdk();
  const t2 = createTracker({ loadSdk: () => ({ default: sdk2 }), storage: fakeStorage('yes'), ...clocks() });
  t2.track('app_start');
  await t2.loading;
  assert.deepEqual(captured(sdk2), ['app_start']);
  // once it is there, events go straight through, without a timestamp of ours
  t2.setDevice({ dpr: 2 });
  t2.track('teleport', { id: 'urgull' });
  assert.deepEqual(sdk2.calls.at(-2), ['register', { dpr: 2 }]);
  assert.deepEqual(sdk2.calls.at(-1), ['capture', 'teleport', { id: 'urgull' }, undefined]);
});

test('an SDK that fails to load turns the analytics off quietly', async () => {
  const errors = [];
  const tracker = createTracker({ loadSdk: () => Promise.reject(new Error('blocked')), onError: (e) => errors.push(e.message), ...clocks() });
  tracker.track('app_start');
  await tracker.loading;
  assert.deepEqual(errors, ['blocked']);
  assert.equal(tracker.enabled, false);
  assert.equal(tracker.queued, 0);
  tracker.track('teleport', { id: 'urgull' });
  assert.equal(tracker.queued, 0, 'nothing queues any more');
});

test('app_ready carries the init timings, app_error and gpu_lost the step reached', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, ...c });
  await tracker.loading;
  tracker.mark('renderer', 320.4);
  tracker.mark('terrain data', 2100);
  tracker.mark('warm-up', 80);
  assert.equal(tracker.after, 'warm-up');
  c.advance(4000);
  tracker.ready();
  const ready = sdk.calls.find((call) => call[1] === 'app_ready');
  assert.deepEqual(ready[2], { ms_renderer: 320, ms_terrain_data: 2100, ms_warm_up: 80, ms_total: 4000 });
  tracker.error(new Error('Unable to create WebGPU adapter. ' + 'x'.repeat(300)));
  const error = sdk.calls.find((call) => call[1] === 'app_error');
  assert.equal(error[2].after, 'warm-up');
  assert.equal(error[2].message.length, 200, 'messages are cut');
  assert.match(error[2].message, /^Unable to create WebGPU adapter/);
  tracker.error('device lost', { reason: 'destroyed' });
  const lost = sdk.calls.at(-1);
  assert.deepEqual(lost[2], { after: 'warm-up', message: 'device lost', reason: 'destroyed' });
});

test('the session samples the fps by the minute, counts a cell after a dwell, and the first move once', () => {
  const s = createSession();
  assert.deepEqual(s.tick(0, { fps: 60, x: 0, z: 0, moving: true }), [], 'nothing before the city shows');
  s.start(1000);
  // the camera sits in one cell: nothing for 2 s, then the visit
  assert.deepEqual(s.tick(1000, { fps: 60, x: 150, z: -250, altitude: 40 }), []);
  assert.deepEqual(s.tick(1000 + DWELL_S * 1000 - 1, { fps: 55, x: 160, z: -240, altitude: 40 }), []);
  assert.deepEqual(s.tick(1000 + DWELL_S * 1000, { fps: 50, x: 160, z: -240, altitude: 40.6 }), [['cell_visit', { cell_x: 1, cell_z: -3, altitude: 41 }]]);
  assert.deepEqual(s.tick(1000 + DWELL_S * 1000 + 250, { fps: 50, x: 170, z: -240, altitude: 40 }), [], 'once per stay');
  // a fast pass through a cell doesn't count; the next stay does, and a move is reported once
  assert.deepEqual(s.tick(4000, { fps: 60, x: 250, z: -250, altitude: 40, moving: true }), [['first_move', { after_s: 3 }]]);
  assert.deepEqual(s.tick(4500, { fps: 60, x: 350, z: -250, altitude: 40, moving: true }), []);
  assert.deepEqual(s.tick(6500, { fps: 60, x: 350, z: -250, altitude: 40, moving: true }), [['cell_visit', { cell_x: 3, cell_z: -3, altitude: 40 }]]);
  // back in the first cell: a new visit
  assert.deepEqual(s.tick(7000, { fps: 30, x: 150, z: -250, altitude: 40 }), []);
  assert.deepEqual(s.tick(9000, { fps: 30, x: 150, z: -250, altitude: 40 }), [['cell_visit', { cell_x: 1, cell_z: -3, altitude: 40 }]]);
  // a minute on: the sample of that minute's fps
  const [sample] = s.tick(1000 + FPS_SAMPLE_S * 1000, { fps: 20, x: 150, z: -250, altitude: 40 });
  assert.equal(sample[0], 'fps_sample');
  assert.deepEqual(sample[1], { fps: 48, fps_min: 20, fps_bucket: '30-50', altitude: 40 });
  // the next minute starts afresh
  assert.deepEqual(s.tick(1000 + FPS_SAMPLE_S * 1000 + 250, { fps: 10, x: 150, z: -250, altitude: 40 }), []);
  const [again] = s.tick(1000 + 2 * FPS_SAMPLE_S * 1000, { fps: 10, x: 150, z: -250, altitude: 40 });
  assert.deepEqual(again[1], { fps: 10, fps_min: 10, fps_bucket: '<15', altitude: 40 });
  s.count('teleport');
  s.count('teleport');
  s.count('map_open');
  s.count('fps_sample');
  // (60 55 50 50 60 60 60 30 30 20 10 10: 495 / 12)
  assert.deepEqual(s.summary(1000 + 2 * FPS_SAMPLE_S * 1000 + 400), {
    seconds: 2 * FPS_SAMPLE_S, fps_avg: 41, fps_min: 10,
    teleports: 2, time_presets: 0, live_toggles: 0, map_opens: 1, cells: 3, moved: true
  });
});

test('the session ends once, by beacon, with its summary', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, ...c });
  await tracker.loading;
  tracker.ready();
  c.advance(90_000);
  tracker.tick({ fps: 58, x: 10, z: 10, altitude: 30, moving: true });
  tracker.track('time_preset', { id: 'midnight' });
  tracker.end();
  tracker.end();
  tracker.track('teleport', { id: 'igeldo' });
  const ends = sdk.calls.filter((call) => call[1] === 'session_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0][2], { seconds: 90, fps_avg: 58, fps_min: 58, teleports: 0, time_presets: 1, live_toggles: 0, map_opens: 0, cells: 0, moved: true });
  assert.deepEqual(ends[0][3], { transport: 'sendBeacon', send_instantly: true });
  assert.equal(sdk.calls.at(-1)[1], 'session_end', 'nothing after the end');
});

test('the helpers', () => {
  assert.deepEqual(cellOf(0, 0), [0, 0]);
  assert.deepEqual(cellOf(CELL_SIZE - 0.01, -0.01), [0, -1]);
  assert.deepEqual(cellOf(-2200, 3519), [-22, 35]);
  assert.deepEqual(['<15', '15-30', '30-50', '50+'], [fpsBucket(14.9), fpsBucket(15), fpsBucket(49), fpsBucket(50)]);
  const info = deviceInfo({ navigator: { hardwareConcurrency: 10, deviceMemory: 8, maxTouchPoints: 0 }, devicePixelRatio: 2.0000001, adapterInfo: { vendor: 'apple', architecture: 'metal-3', device: '', description: 'Apple M2 Pro (secret)' } });
  assert.deepEqual(info, { gpu_vendor: 'apple', gpu_arch: 'metal-3', cpu_cores: 10, memory_gb: 8, dpr: 2, touch: false }, 'the GPU model and description stay out');
  assert.deepEqual(deviceInfo({ navigator: { maxTouchPoints: 5 } }), { dpr: 1, touch: true });
  assert.deepEqual(deviceInfo(), { dpr: 1, touch: false });
});

test('the page wires the analytics in, Donostia only, and says so in the data popover', () => {
  const main = fs.readFileSync(`${root}js/donostia/main.js`, 'utf8');
  const hud = fs.readFileSync(`${root}js/donostia/hud.js`, 'utf8');
  assert.match(main, /from '\.\/analytics\.js'/);
  assert.match(main, /from '\.\/consent\.js'/);
  assert.match(main, /initAnalytics\(/);
  for (const event of ['$pageview', 'app_start', 'world_built', 'shaders_compiled', 'gpu_lost']) assert.ok(main.includes(`'${event}'`), `main.js sends ${event}`);
  assert.ok(main.indexOf("'$pageview'") < main.indexOf("'app_start'"), 'the page view opens the funnel');
  assert.match(main, /analytics\.ready\(\)/);
  assert.match(main, /analytics\.end\(\)/);
  assert.match(main, /analytics\.tick\(/);
  assert.match(main, /consent\.setReady\(\)/);
  for (const event of ['teleport', 'time_preset', 'live_toggle', 'map_open', 'hud_hide']) assert.ok(hud.includes(`'${event}'`), `hud.js sends ${event}`);
  const html = fs.readFileSync(`${root}index.html`, 'utf8');
  assert.match(html, /<div id="credits-popover"[^]*posthog\.com[^]*<\/div>/, 'the data popover says where the usage events go');
  for (const id of ['consent-card', 'consent-accept', 'consent-decline', 'consent-line', 'consent-state', 'consent-change']) assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  assert.match(html, /<aside id="consent-card"[^>]*\bhidden\b/, 'the card starts hidden');
  assert.match(html, /<aside id="consent-card"[^>]*role="dialog"/);
  const css = fs.readFileSync(`${root}css/donostia.css`, 'utf8');
  assert.match(css, /\.hud-consent\s*{/, 'the card has its place in css/donostia.css');
  assert.ok(!html.includes('posthog-js'), 'the SDK is not on the page: analytics.js imports it when allowed');
  const newyork = fs.readFileSync(`${root}newyork.html`, 'utf8');
  assert.ok(!newyork.includes('posthog'), 'nothing on the New York page');
  for (const file of fs.readdirSync(`${root}js`).filter((f) => f.endsWith('.js'))) {
    assert.ok(!fs.readFileSync(`${root}js/${file}`, 'utf8').includes('analytics.js'), `${file} (New York) never imports the analytics`);
  }
});
