import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The usage analytics (js/donostia/analytics.js): when they are off, what the tracker sends and when, the session's
// figures, the quality and the interface on every event, the cookie card (js/donostia/consent.js) in the three
// languages, and that the page wires them in. No browser: the tracker takes a fake SDK and clocks.

const root = fileURLToPath(new URL('../', import.meta.url));
const analytics = await import(pathToFileURL(`${root}js/donostia/analytics.js`).href);
const {
  analyticsAllowed, createTracker, createSession, cellOf, fpsBucket, deviceInfo, qualityInfo, interfaceInfo, interfaceReader,
  SDK_CONFIG, SDK_URL, CELL_SIZE, DWELL_S, FPS_SAMPLE_S, LOOK_TURN, QUALITY_GAP_S, QUALITY_MAX
} = analytics;
const i18n = await import(pathToFileURL(`${root}js/donostia/i18n.js`).href);

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
const events = (sdk, name) => sdk.calls.filter((c) => c[0] === 'capture' && c[1] === name).map((c) => c[2]);
const registered = (sdk) => Object.assign({}, ...sdk.calls.filter((c) => c[0] === 'register').map((c) => c[1]));

// clocks under test control
function clocks(start = 1000) {
  let t = start;
  return { clock: () => t, now: () => 1_700_000_000_000 + t, advance: (ms) => { t += ms; } };
}

// js/donostia/quality.js's state, as far as the analytics read it
const qstate = (over = {}) => ({ mode: 'auto', tier: 'medium', scale: 1, capped: false, detected: 'medium', ...over });

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
  assert.equal(SDK_CONFIG.capture_heatmaps, false);
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
  assert.deepEqual(sdk.calls.slice(0, 3).map((call) => call[0]), ['init', 'opt_out', 'register'],
    'the SDK is told "rejected" as it loads: cookieless, and capturing; the super-properties after it (going cookieless it starts afresh)');
  assert.deepEqual(captured(sdk), ['$pageview', 'app_start'], 'the queue goes at once');
  assert.equal(tracker.consentStatus, 'pending', 'not asked yet');
  assert.deepEqual(statuses, ['pending']);
  assert.equal(storage.items.size, 0, 'nothing stored without an answer');
  c.advance(5000);
  tracker.ready();
  tracker.track('teleport', { id: 'urgull' });
  assert.deepEqual(captured(sdk), ['$pageview', 'app_start', 'app_ready', 'teleport'], 'straight through, cookieless');
  tracker.setDevice({ cpu_cores: 8 });
  tracker.decide(true);
  assert.deepEqual(sdk.calls.find((call) => call[0] === 'opt_in'), ['opt_in', { captureEventName: null }], 'the SDK sets its cookie, without an event of its own');
  assert.deepEqual(sdk.calls.at(-1).slice(1, 3), ['cookie_consent', { cookies: true, changed: false }]);
  assert.deepEqual(sdk.calls.at(-2), ['register', { cpu_cores: 8 }], 'the super-properties again: the SDK started afresh with the cookie');
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

// a bare DOM stand-in for the consent card
function fakeDoc(prefix = '') {
  const elements = {};
  const el = (id) => (elements[id] ??= { id, hidden: true, textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, click() { this.handlers.click?.(); }, hidePopover() { this.popoverHidden = true; } });
  return { el, doc: { getElementById: (id) => el(`${prefix}${id}`) } };
}

test('the card shows once the city shows until it is answered, and the popover offers to change the answer', async () => {
  const { initConsent, SHOW_AFTER_MS } = await import(pathToFileURL(`${root}js/donostia/consent.js`).href);
  assert.ok(SHOW_AFTER_MS >= 1000 && SHOW_AFTER_MS <= 5000, 'the city is seen first, and the card does not wait for the background compile');
  i18n.setLang('en');
  const { el, doc } = fakeDoc();
  const sdk = fakeSdk('pending');
  const storage = fakeStorage();
  const tracker = createTracker({ loadSdk: () => sdk, storage, readInterface: () => interfaceInfo({ lang: i18n.getLang() }), ...clocks() });
  const consent = initConsent(tracker, doc, { delay: 0 });
  assert.equal(el('consent-card').hidden, true, 'nothing before the SDK');
  assert.equal(el('consent-line').hidden, true);
  await tracker.loading;
  assert.equal(el('consent-card').hidden, true, 'not over the loading screen');
  consent.setReady();
  assert.equal(consent.shown, true);
  assert.equal(el('consent-line').hidden, false);
  assert.equal(el('consent-state').textContent, 'not answered (none set)');
  // the answer's line follows the language
  i18n.setLang('es');
  assert.equal(el('consent-state').textContent, 'sin responder (sin cookie)');
  el('consent-decline').click();
  assert.equal(consent.shown, false);
  assert.equal(tracker.consentStatus, 'denied');
  assert.equal(el('consent-state').textContent, 'no (sin cookie)');
  assert.deepEqual(events(sdk, 'cookie_consent').at(-1), { lang: 'es', input: 'mouse', display_mode: 'browser', cookies: false, changed: false }, 'the answer says the language the card was read in');
  // choose again from the data popover
  i18n.setLang('eu');
  el('consent-change').click();
  assert.equal(el('credits-popover').popoverHidden, true);
  assert.equal(consent.shown, true);
  el('consent-accept').click();
  assert.equal(consent.shown, false);
  assert.equal(tracker.consentStatus, 'granted');
  assert.equal(el('consent-state').textContent, 'bai (jarrita)');
  const changed = events(sdk, 'cookie_consent').at(-1);
  assert.deepEqual([changed.cookies, changed.changed, changed.lang], [true, true, 'eu']);
  i18n.setLang('en');
  assert.equal(el('consent-state').textContent, 'yes (set)');
  // a visitor who answered never sees the card again
  const second = fakeDoc('back-');
  const back = initConsent(createTracker({ loadSdk: () => fakeSdk('granted'), storage: fakeStorage('yes'), ...clocks() }), second.doc, { delay: 0 });
  await new Promise((r) => setTimeout(r, 0));
  back.setReady();
  assert.equal(back.shown, false);
  assert.equal(second.el('back-consent-line').hidden, false);
  // analytics off: no card, no popover line
  const third = fakeDoc('off-');
  const off = initConsent(createTracker({ enabled: false, loadSdk: () => fakeSdk('pending') }), third.doc, { delay: 0 });
  off.setReady();
  assert.equal(off.shown, false);
  assert.equal(third.el('off-consent-line').hidden, true);
  // with its delay, the card comes a moment after the city, not with it
  const fourth = fakeDoc('late-');
  const lateTracker = createTracker({ loadSdk: () => fakeSdk('pending'), storage: fakeStorage(), ...clocks() });
  const late = initConsent(lateTracker, fourth.doc, { delay: 20 });
  await lateTracker.loading;
  late.setReady();
  assert.equal(late.shown, false);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(late.shown, true);
});

test("the card's words are the owner's, in the three languages, with the fuller text in the data popover", () => {
  const copy = {
    en: ['One small cookie?', 'Just to see how the city loads and where people fly. No ads, no following you around the web. Say no and nothing changes.', 'Sure', 'Not now'],
    es: ['Una teja con el café', 'Es solo una cookie, para medir cómo carga la ciudad y por dónde se vuela. Ni anuncios ni rastreo, y puedes pasar.', 'Venga', 'Ahora no'],
    eu: ['Teila bat kafearekin', 'Cookie bat besterik ez da, hiria nola kargatzen den eta nondik hegan egiten den neurtzeko. Iragarkirik ez, jarraipenik ez, eta ezetz esan dezakezu.', 'Aurrera', 'Orain ez']
  };
  for (const [lang, words] of Object.entries(copy)) {
    i18n.setLang(lang);
    assert.deepEqual(['consent.title', 'consent.text', 'consent.accept', 'consent.decline'].map((k) => i18n.t(k)), words, lang);
    for (const key of ['consent.line', 'consent.granted', 'consent.denied', 'consent.pending', 'consent.change']) assert.notEqual(i18n.t(key), key, `${lang}: ${key}`);
    if (lang !== 'en') assert.match(i18n.t('credits.usage'), /<0>PostHog Cloud EU<\/0>.*Do Not Track.*Global Privacy Control.*<1>[^<]+<\/1>/, `${lang}: the popover's paragraph keeps its two links`);
  }
  i18n.setLang('en');
  const html = fs.readFileSync(`${root}index.html`, 'utf8');
  // the page's own text is the English, marked for the other two; the old card's mixed languages are gone
  assert.match(html, /<div id="consent-title"[^>]*data-i18n="consent\.title">One small cookie\?<\/div>/);
  assert.match(html, /<p id="consent-text"[^>]*data-i18n="consent\.text">Just to see how the city loads/);
  assert.match(html, /<button id="consent-accept"[^>]*data-i18n="consent\.accept">Sure<\/button>/);
  assert.match(html, /<button id="consent-decline"[^>]*data-i18n="consent\.decline">Not now<\/button>/);
  assert.match(html, /<p data-i18n-rich="credits\.usage">Usage: [^]*?posthog\.com\/eu[^]*?README\.md#analytics[^]*?<\/p>/);
  const consent = fs.readFileSync(`${root}js/donostia/consent.js`, 'utf8');
  for (const old of ['Bai · Vale', 'Ez · Sin cookie', 'aldatu · cambiar', 'Cookie bat · Una cookie', 'Erabilera neurtzeko', 'galdetu gabe']) {
    assert.ok(!html.includes(old) && !consent.includes(old), `the old card's "${old}" is gone`);
  }
  // the teja: a drawn symbol of the sprite, beside the title
  assert.match(html, /<symbol id="i-teja" viewBox="[^"]+">\s*<path/);
  assert.match(html, /<div class="consent-head">\s*<svg class="icon consent-teja"[^>]*aria-hidden="true"><use href="#i-teja"\/><\/svg>\s*<div id="consent-title"/);
});

test('a disabled tracker never loads the SDK and drops everything', async () => {
  let loaded = 0;
  const tracker = createTracker({ enabled: false, loadSdk: () => { loaded++; return fakeSdk(); }, ...clocks() });
  tracker.track('app_start', { webgpu: true });
  tracker.setQuality(qstate());
  tracker.setQuality(qstate({ mode: 'low', tier: 'low' }));
  tracker.ready();
  tracker.details();
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

test('an SDK that fails to load turns the analytics off quietly, and one that throws never reaches the page', async () => {
  const errors = [];
  const tracker = createTracker({ loadSdk: () => Promise.reject(new Error('blocked')), onError: (e) => errors.push(e.message), ...clocks() });
  tracker.track('app_start');
  await tracker.loading;
  assert.deepEqual(errors, ['blocked']);
  assert.equal(tracker.enabled, false);
  assert.equal(tracker.queued, 0);
  tracker.track('teleport', { id: 'urgull' });
  assert.equal(tracker.queued, 0, 'nothing queues any more');
  // an SDK whose capture throws: the HUD's handler that called track() goes on
  const broken = fakeSdk();
  const t2 = createTracker({ loadSdk: () => broken, storage: fakeStorage('yes'), onError: (e) => errors.push(e.message), ...clocks() });
  await t2.loading;
  broken.capture = () => { throw new Error('no capture'); };
  broken.register = () => { throw new Error('no register'); };
  assert.doesNotThrow(() => { t2.track('teleport', { id: 'urgull' }); t2.setDevice({ dpr: 2 }); t2.setQuality(qstate()); t2.ready(); t2.end(); });
  assert.ok(errors.includes('no capture') && errors.includes('no register'));
});

test('app_ready carries the init timings and what is left to compile, app_error and gpu_lost the step reached', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, ...c });
  await tracker.loading;
  tracker.mark('renderer', 320.4);
  tracker.mark('terrain data', 2100);
  tracker.mark('warm-up', 80);
  assert.equal(tracker.after, 'warm-up');
  c.advance(4000);
  tracker.ready({ shaders_pending: 87, shaders_total: 101 });
  assert.deepEqual(events(sdk, 'app_ready'), [{ ms_renderer: 320, ms_terrain_data: 2100, ms_warm_up: 80, ms_total: 4000, shaders_pending: 87, shaders_total: 101 }]);
  tracker.ready();
  assert.equal(events(sdk, 'app_ready').length, 1, 'the city shows once');
  tracker.error(new Error('Unable to create WebGPU adapter. ' + 'x'.repeat(300)));
  const error = sdk.calls.find((call) => call[1] === 'app_error');
  assert.equal(error[2].after, 'warm-up');
  assert.equal(error[2].message.length, 200, 'messages are cut');
  assert.match(error[2].message, /^Unable to create WebGPU adapter/);
  tracker.error('device lost', { reason: 'destroyed' });
  const lost = sdk.calls.at(-1);
  assert.deepEqual(lost[2], { after: 'warm-up', message: 'device lost', reason: 'destroyed' });
});

test('the load is progressive: details_ready once, when the background compile ends', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, ...c });
  await tracker.loading;
  tracker.setQuality(qstate());
  tracker.details({ shaders_total: 101 });
  assert.deepEqual(events(sdk, 'details_ready'), [], 'not before the city shows');
  c.advance(3000);
  tracker.ready({ shaders_pending: 87, shaders_total: 101 });
  c.advance(42_100.4);
  tracker.details({ shaders_total: 102 });
  assert.deepEqual(events(sdk, 'details_ready'), [{ ...qualityInfo(qstate()), ms_since_ready: 42_100, ms_total: 45_100, shaders_total: 102, quality_changed: false }]);
  // (main.js says 'done' again after every tier applied)
  c.advance(9000);
  tracker.details({ shaders_total: 102 });
  assert.equal(events(sdk, 'details_ready').length, 1);
  tracker.end();
  assert.equal(events(sdk, 'session_end')[0].details, true);
  // nothing left for the background (the desktop): at once, with no wait
  const sdk2 = fakeSdk();
  const t2 = createTracker({ loadSdk: () => sdk2, ...clocks() });
  await t2.loading;
  t2.ready({ shaders_pending: 0, shaders_total: 240 });
  t2.details({ shaders_total: 240 });
  assert.deepEqual(events(sdk2, 'details_ready'), [{ ms_since_ready: 0, ms_total: 0, shaders_total: 240, quality_changed: false }]);
  // a tier picked by hand meanwhile: the time includes applying it, and the event says so
  const sdk3 = fakeSdk();
  const c3 = clocks();
  const t3 = createTracker({ loadSdk: () => sdk3, ...c3 });
  await t3.loading;
  t3.setQuality(qstate());
  t3.ready();
  c3.advance(5000);
  t3.setQuality(qstate({ mode: 'low', tier: 'low' }));
  c3.advance(20_000);
  t3.details();
  assert.equal(events(sdk3, 'details_ready')[0].quality_changed, true);
  assert.equal(events(sdk3, 'details_ready')[0].quality_mode, 'low');
  // the page left before the end: the session says so
  const sdk4 = fakeSdk();
  const t4 = createTracker({ loadSdk: () => sdk4, ...clocks() });
  await t4.loading;
  t4.ready();
  t4.end();
  assert.equal(events(sdk4, 'session_end')[0].details, false);
});

test('the quality and the interface are on every event, and refreshed when they change', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const face = { lang: 'en', touch: false, width: 390, height: 844, standalone: false, fullscreen: false };
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const tracker = createTracker({ loadSdk: () => pending, storage: fakeStorage('no'), readInterface: () => interfaceInfo(face), ...c });
  tracker.track('app_start', { webgpu: true }); // (before quality.js has booted)
  tracker.setQuality(qstate());
  tracker.track('world_built');
  face.touch = true; // (the HUD turned the touch layout on)
  tracker.track('shaders_compiled');
  resolve(sdk);
  await tracker.loading;
  const quality = { quality_mode: 'auto', quality_tier: 'medium', render_scale: 1, fps_capped: false, quality_detected: 'medium' };
  // the queued events say what was true when they happened
  assert.deepEqual(events(sdk, 'app_start'), [{ lang: 'en', input: 'mouse', orientation: 'portrait', display_mode: 'browser', webgpu: true }]);
  assert.deepEqual(events(sdk, 'world_built'), [{ ...quality, lang: 'en', input: 'mouse', orientation: 'portrait', display_mode: 'browser' }]);
  assert.deepEqual(events(sdk, 'shaders_compiled'), [{ ...quality, lang: 'en', input: 'touch', orientation: 'portrait', display_mode: 'browser' }]);
  // and the SDK holds them as super-properties, for its own events (the page leave)
  assert.deepEqual(registered(sdk), { ...quality, lang: 'en', input: 'touch', orientation: 'portrait', display_mode: 'browser' });
  // a change of the language, the orientation, the display mode: on the very next event, and registered
  const before = sdk.calls.length;
  face.lang = 'eu'; face.width = 844; face.height = 390; face.fullscreen = true;
  tracker.track('language_change', { from: 'en', to: 'eu' });
  assert.deepEqual(sdk.calls.slice(before).map((call) => call[0]), ['register', 'capture']);
  assert.deepEqual(sdk.calls[before][1], { lang: 'eu', input: 'touch', orientation: 'landscape', display_mode: 'fullscreen' });
  assert.deepEqual(events(sdk, 'language_change'), [{ ...quality, lang: 'eu', input: 'touch', orientation: 'landscape', display_mode: 'fullscreen', from: 'en', to: 'eu' }]);
  // nothing changed: nothing registered again
  tracker.track('map_open');
  assert.equal(sdk.calls.at(-2)[0], 'capture');
  // the governor lowers the resolution: no event, the next ones say it; then the frame rate is found capped
  tracker.setQuality(qstate({ scale: 0.853 }));
  assert.deepEqual(sdk.calls.at(-1), ['register', { ...quality, render_scale: 0.85 }]);
  tracker.setQuality(qstate({ scale: 0.853 }));
  assert.equal(sdk.calls.at(-2)[0], 'capture', 'the same state again registers nothing');
  tracker.setQuality(qstate({ scale: 1, capped: true }));
  tracker.track('teleport', { id: 'igeldo' });
  assert.deepEqual([events(sdk, 'teleport')[0].render_scale, events(sdk, 'teleport')[0].fps_capped], [1, true]);
  assert.deepEqual(events(sdk, 'quality_change'), [], 'the render scale alone is no event');
  // the session's end carries them too, though it goes by its own way
  tracker.ready();
  tracker.end();
  const end = events(sdk, 'session_end')[0];
  assert.deepEqual([end.quality_tier, end.fps_capped, end.lang, end.input, end.orientation, end.display_mode], ['medium', true, 'eu', 'touch', 'landscape', 'fullscreen']);
});

test('quality_change: a pick by hand at once, the governor rate-limited', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, ...c });
  await tracker.loading;
  const changes = () => events(sdk, 'quality_change').map((p) => [p.from, p.to, p.by, p.from_mode, p.to_mode, p.steps]);
  tracker.setQuality(qstate()); // (what the city booted with: not a change)
  tracker.ready();
  assert.deepEqual(changes(), []);
  // the governor steps down: said at once, with the new tier on the event itself
  c.advance(10_000);
  tracker.setQuality(qstate({ tier: 'low', scale: 1 }));
  assert.deepEqual(changes(), [['medium', 'low', 'governor', 'auto', 'auto', 1]]);
  assert.equal(events(sdk, 'quality_change')[0].quality_tier, 'low');
  // it pumps: up and down again within the gap is not said at all
  c.advance(5000);
  tracker.setQuality(qstate({ tier: 'medium' }));
  c.advance(5000);
  tracker.setQuality(qstate({ tier: 'low' }));
  c.advance(QUALITY_GAP_S * 1000);
  tracker.tick({ fps: 60 });
  assert.equal(changes().length, 1);
  // several steps within the gap are one event when the gap is over, from the first tier to the last
  tracker.setQuality(qstate({ tier: 'medium' })); // (the gap since the last event is over: at once)
  assert.deepEqual(changes().at(-1), ['low', 'medium', 'governor', 'auto', 'auto', 1]);
  c.advance(4000);
  tracker.setQuality(qstate({ tier: 'high' }));
  c.advance(4000);
  tracker.setQuality(qstate({ tier: 'medium' }));
  c.advance(4000);
  tracker.setQuality(qstate({ tier: 'low' }));
  tracker.tick({ fps: 60 });
  assert.equal(changes().length, 2, 'held meanwhile');
  c.advance(QUALITY_GAP_S * 1000 - 12_000);
  tracker.tick({ fps: 60 });
  assert.deepEqual(changes().at(-1), ['medium', 'low', 'governor', 'auto', 'auto', 3]);
  assert.equal(changes().length, 3);
  // a pick by hand: at once, after what the governor still held, with the tiers in force and what was asked for
  c.advance(1000);
  tracker.setQuality(qstate({ tier: 'medium' }));
  assert.equal(changes().length, 3, 'held');
  tracker.setQuality(qstate({ mode: 'high', tier: 'high' }));
  assert.deepEqual(changes().slice(3), [['low', 'medium', 'governor', 'auto', 'auto', 1], ['medium', 'high', 'user', 'auto', 'high', undefined]]);
  // back to auto on the tier already in force: the mode changed, and that is an event
  tracker.setQuality(qstate({ mode: 'auto', tier: 'high' }));
  assert.deepEqual(changes().at(-1), ['high', 'high', 'user', 'high', 'auto', undefined]);
  // what the governor holds as the page goes is said before the session's end
  c.advance(1000);
  tracker.setQuality(qstate({ tier: 'medium' }));
  tracker.end();
  assert.deepEqual(changes().at(-1), ['high', 'medium', 'governor', 'auto', 'auto', 1]);
  assert.deepEqual(captured(sdk).slice(-2), ['quality_change', 'session_end']);
  // a governor that never settles cannot flood: QUALITY_MAX events a visit
  const sdk2 = fakeSdk();
  const c2 = clocks();
  const t2 = createTracker({ loadSdk: () => sdk2, ...c2 });
  await t2.loading;
  t2.setQuality(qstate());
  t2.ready();
  for (let i = 0; i < 3 * QUALITY_MAX; i++) {
    c2.advance(QUALITY_GAP_S * 1000 + 1);
    t2.setQuality(qstate({ tier: i % 2 ? 'medium' : 'low' }));
  }
  assert.equal(events(sdk2, 'quality_change').length, QUALITY_MAX);
  // a hundred steps in a minute: two or three events
  const sdk3 = fakeSdk();
  const c3 = clocks();
  const t3 = createTracker({ loadSdk: () => sdk3, ...c3 });
  await t3.loading;
  t3.setQuality(qstate());
  t3.ready();
  for (let i = 0; i < 100; i++) {
    c3.advance(600);
    t3.setQuality(qstate({ tier: ['low', 'medium', 'high'][i % 3] }));
    t3.tick({ fps: 30 });
  }
  assert.ok(events(sdk3, 'quality_change').length <= 3, `${events(sdk3, 'quality_change').length} events for 100 steps in a minute`);
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
  assert.deepEqual(s.tick(4000, { fps: 60, x: 250, z: -250, altitude: 40, moving: true }), [['first_move', { after_s: 3, by: 'fly' }]]);
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
    seconds: 2 * FPS_SAMPLE_S, hidden_s: 0, fps_avg: 41, fps_min: 10,
    teleports: 2, time_presets: 0, live_toggles: 0, map_opens: 1, cells: 3, moved: true
  });
});

test('first_move also fires for a look: a drag on the view, by mouse or by finger, with no flying at all', () => {
  // (on a phone the first thing a thumb does is drag the view; the stick moves the camera, which is the 'fly' above)
  const s = createSession();
  s.start(0);
  assert.deepEqual(s.tick(0, { fps: 60, yaw: 0.4, pitch: -0.2 }), [], 'the heading it starts with');
  assert.deepEqual(s.tick(250, { fps: 60, yaw: 0.4 + LOOK_TURN / 4, pitch: -0.2 }), [], 'under the threshold');
  // a flight to a viewpoint turns the camera: not a look, and the heading starts afresh after it
  assert.deepEqual(s.tick(500, { fps: 60, yaw: 1.4, pitch: -0.3, flight: true }), []);
  assert.deepEqual(s.tick(750, { fps: 60, yaw: 2.2, pitch: -0.4, flight: true }), []);
  assert.deepEqual(s.tick(1000, { fps: 60, yaw: 2.4, pitch: -0.4 }), [], 'where the flight left it');
  assert.deepEqual(s.tick(1250, { fps: 60, yaw: 2.4, pitch: -0.4 }), []);
  assert.deepEqual(s.tick(1500, { fps: 60, yaw: 2.4 + 0.05, pitch: -0.41 }), [['first_move', { after_s: 1.5, by: 'look' }]]);
  assert.deepEqual(s.tick(1750, { fps: 60, yaw: 2.9, pitch: -0.1, moving: true }), [], 'once');
  assert.equal(s.summary(2000).moved, true);
  // across the turn of the compass (pi to -pi) a small turn stays small
  const w = createSession();
  w.start(0);
  w.tick(0, { yaw: Math.PI - 0.002, pitch: 0 });
  assert.deepEqual(w.tick(250, { yaw: -Math.PI + 0.002, pitch: 0 }), []);
  // the pitch alone counts, and flying while turning is a 'fly'
  assert.deepEqual(w.tick(500, { yaw: -Math.PI + 0.002, pitch: 0.1 }), [['first_move', { after_s: 0.5, by: 'look' }]]);
  const f = createSession();
  f.start(0);
  f.tick(0, { yaw: 0, pitch: 0 });
  assert.deepEqual(f.tick(250, { yaw: 0.5, pitch: 0, moving: true }), [['first_move', { after_s: 0.3, by: 'fly' }]]);
  // a tick that knows no heading (an older caller) is no look
  const n = createSession();
  n.start(0);
  n.tick(0, { fps: 60 });
  assert.deepEqual(n.tick(250, { fps: 60 }), []);
});

test("the visit's summary goes by beacon when the page unloads, once", async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, visitId: 'v1', ...c });
  await tracker.loading;
  tracker.ready();
  c.advance(90_000);
  tracker.tick({ fps: 58, x: 10, z: 10, altitude: 30, moving: true });
  tracker.track('time_preset', { id: 'midnight' });
  // the unload: pagehide, and the visibilitychange the browser sends with it
  tracker.hide('pagehide');
  tracker.hide('hidden');
  tracker.end();
  const ends = sdk.calls.filter((call) => call[1] === 'session_end');
  assert.equal(ends.length, 1);
  assert.deepEqual(ends[0][2], {
    visit_id: 'v1', seq: 1, reason: 'pagehide', ready: true, seconds: 90, hidden_s: 0, fps_avg: 58, fps_min: 58,
    teleports: 0, time_presets: 1, live_toggles: 0, map_opens: 0, cells: 0, moved: true, details: false
  });
  assert.deepEqual(ends[0][3], { transport: 'sendBeacon', send_instantly: true });
});

test('a phone may never unload the page: the summary goes when it is hidden, and again, brought up to date, if the visitor comes back', async () => {
  const sdk = fakeSdk();
  const c = clocks();
  const tracker = createTracker({ loadSdk: () => sdk, visitId: 'v2', ...c });
  await tracker.loading;
  tracker.ready();
  const ends = () => events(sdk, 'session_end');
  // 20 s in view, in one cell for the last of it
  for (let i = 0; i < 80; i++) { c.advance(250); tracker.tick({ fps: 60, x: 150, z: -250, altitude: 40 }); }
  tracker.track('teleport', { id: 'urgull' });
  // the phone is locked: the summary so far, at once (the tab may be killed before it is ever seen again)
  tracker.hide('hidden');
  assert.equal(ends().length, 1);
  assert.deepEqual([ends()[0].visit_id, ends()[0].seq, ends()[0].reason, ends()[0].ready, ends()[0].seconds, ends()[0].hidden_s, ends()[0].teleports, ends()[0].cells, ends()[0].fps_min],
    ['v2', 1, 'hidden', true, 20, 0, 1, 1, 60]);
  assert.deepEqual(sdk.calls.at(-1)[3], { transport: 'sendBeacon', send_instantly: true });
  // ten minutes in a pocket: nothing ticks, and a stray tick counts for nothing
  c.advance(300_000);
  tracker.tick({ fps: 1, x: 950, z: 950, altitude: 40, moving: true });
  c.advance(300_000);
  // a lost GPU while hidden is still said
  tracker.track('gpu_lost', { after: 'gpu', reason: 'destroyed', hidden: true });
  assert.equal(captured(sdk).at(-1), 'gpu_lost');
  // back: the visit carries on. main.js's first rate is its frames over the whole gap: not a frame rate
  tracker.show();
  tracker.show();
  tracker.tick({ fps: 0.001, x: 150, z: -250, altitude: 40 });
  assert.deepEqual(captured(sdk).filter((n) => n === 'cell_visit' || n === 'fps_sample' || n === 'first_move').length, 1, 'no fps sample of the hidden minutes, no second visit of the cell it never left');
  // 10 s more in view, flying into another cell
  for (let i = 0; i < 40; i++) { c.advance(250); tracker.tick({ fps: 30, x: 450, z: -250, altitude: 40, moving: true }); }
  assert.deepEqual(events(sdk, 'first_move'), [{ after_s: 20.3, by: 'fly' }], 'the delay leaves the hidden time out');
  tracker.track('teleport', { id: 'igeldo' });
  // hidden again, then the tab is closed while hidden: one more summary, the whole visit's, and no third
  tracker.hide('hidden');
  tracker.hide('pagehide');
  assert.equal(ends().length, 2);
  const last = ends()[1];
  assert.deepEqual([last.visit_id, last.seq, last.reason, last.seconds, last.hidden_s, last.teleports, last.cells, last.moved, last.fps_min, last.fps_avg],
    ['v2', 2, 'hidden', 30, 600, 2, 2, true, 30, 50]);
  // the fps minute and the dwell were held over the gap, not reset: 30 s in view is no fps sample yet
  assert.deepEqual(events(sdk, 'fps_sample'), []);
  // out of the back/forward cache after an unload: the visit carries on there too
  tracker.show();
  c.advance(31_000);
  tracker.tick({ fps: 60, x: 450, z: -250, altitude: 40 });
  assert.equal(events(sdk, 'fps_sample').length, 1, 'a minute in view, three stretches of it');
  tracker.hide('pagehide');
  assert.deepEqual([ends()[2].seq, ends()[2].reason, ends()[2].seconds, ends()[2].hidden_s], [3, 'pagehide', 61, 600]);
  // a query keeps the highest seq of each visit_id: the figures are the visit's, never a part's
  assert.deepEqual(ends().map((e) => e.seconds), [20, 30, 61]);
});

test('a visit left during the load says so; its id is random, in memory, and on its summaries alone', async () => {
  const sdk = fakeSdk();
  let resolve;
  const pending = new Promise((r) => { resolve = r; });
  const storage = fakeStorage();
  const tracker = createTracker({ loadSdk: () => pending, storage, ...clocks() });
  tracker.track('app_start', { webgpu: true });
  tracker.hide('hidden'); // (before the SDK is there: it waits in the queue like any event)
  resolve(sdk);
  await tracker.loading;
  const [end] = events(sdk, 'session_end');
  assert.deepEqual([end.seq, end.reason, end.ready, end.seconds, end.hidden_s, end.moved, end.details], [1, 'hidden', false, 0, 0, false, false]);
  assert.match(end.visit_id, /^[0-9a-f]{16}$/);
  assert.equal(storage.items.size, 0, 'nothing stored');
  assert.ok(!JSON.stringify(sdk.calls.filter((call) => call[1] !== 'session_end')).includes(end.visit_id), 'on no other event, and not registered');
  // another load of the page is another visit
  const ids = new Set(Array.from({ length: 50 }, () => analytics.makeVisitId()));
  assert.equal(ids.size, 50);
  const other = fakeSdk();
  const t2 = createTracker({ loadSdk: () => other, ...clocks() });
  await t2.loading;
  t2.hide('pagehide');
  assert.notEqual(events(other, 'session_end')[0].visit_id, end.visit_id);
  // the page wires both ways out, and the way back
  const main = fs.readFileSync(`${root}js/donostia/main.js`, 'utf8');
  assert.match(main, /addEventListener\('pagehide', \(\) => analytics\.hide\('pagehide'\)\)/);
  assert.match(main, /addEventListener\('visibilitychange', \(\) => \{\s*if \(document\.visibilityState === 'hidden'\) analytics\.hide\('hidden'\);\s*else analytics\.show\(\);/);
  assert.match(main, /addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted\) analytics\.show\(\); \}\)/);
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

test("the quality's and the interface's super-properties", async () => {
  // js/donostia/quality.js's own state, whole
  const { createQuality } = await import(pathToFileURL(`${root}js/donostia/quality.js`).href);
  const q = createQuality();
  q.init({ env: { coarse: true, touchPoints: 5, gpuVendor: 'apple', gpuArchitecture: 'metal-3', memory: 4, cores: 6, width: 390, height: 844, dpr: 3, ua: 'iPhone' }, search: '' });
  const props = qualityInfo(q.get());
  assert.deepEqual(Object.keys(props), ['quality_mode', 'quality_tier', 'render_scale', 'fps_capped', 'quality_detected']);
  assert.equal(props.quality_mode, 'auto');
  assert.ok(q.tiers.includes(props.quality_tier) && q.tiers.includes(props.quality_detected));
  assert.equal(props.render_scale, 1);
  assert.equal(props.fps_capped, false);
  // a pick by hand reaches the tracker through quality.onChange(), as main.js wires it
  const sdk = fakeSdk();
  const tracker = createTracker({ loadSdk: () => sdk, ...clocks() });
  await tracker.loading;
  tracker.setQuality(q.get());
  q.onChange((state) => tracker.setQuality(state));
  q.set('low', { persist: false });
  assert.deepEqual(events(sdk, 'quality_change').map((p) => [p.to, p.by, p.from_mode, p.to_mode, p.quality_mode, p.quality_tier]), [['low', 'user', 'auto', 'low', 'low', 'low']]);
  q.busy(true); // (main.js rebuilding for the tier: a change of state, but not of the quality)
  q.busy(false);
  assert.equal(events(sdk, 'quality_change').length, 1);
  assert.deepEqual(qualityInfo({ mode: 'auto', tier: 'medium', scale: 0.8499, capped: true, detected: 'high' }),
    { quality_mode: 'auto', quality_tier: 'medium', render_scale: 0.85, fps_capped: true, quality_detected: 'high' });
  assert.deepEqual(qualityInfo(null), {});

  assert.deepEqual(interfaceInfo({ lang: 'eu', touch: true, width: 390, height: 844 }), { lang: 'eu', input: 'touch', orientation: 'portrait', display_mode: 'browser' });
  assert.deepEqual(interfaceInfo({ lang: 'en', width: 1440, height: 840, fullscreen: true }), { lang: 'en', input: 'mouse', orientation: 'landscape', display_mode: 'fullscreen' });
  assert.equal(interfaceInfo({ standalone: true, fullscreen: true }).display_mode, 'standalone', 'from the home screen, whatever mode the system gave it');
  assert.deepEqual(interfaceInfo(), { input: 'mouse', display_mode: 'browser' });

  // read off a page: a phone in a browser tab, which then goes full screen and is turned on its side
  const media = new Set(['(any-pointer: coarse)']);
  const classes = new Set();
  const win = { innerWidth: 390, innerHeight: 844, navigator: {}, matchMedia: (query) => ({ matches: media.has(query) }) };
  const doc = { body: { classList: { contains: (name) => classes.has(name) } }, fullscreenElement: null };
  let lang = 'en';
  const read = interfaceReader({ win, doc, getLang: () => lang });
  assert.deepEqual(read(), { lang: 'en', input: 'touch', orientation: 'portrait', display_mode: 'browser' }, 'a touch screen, before the HUD has set its layout');
  doc.fullscreenElement = {};
  media.add('(display-mode: fullscreen)');
  Object.assign(win, { innerWidth: 844, innerHeight: 390 });
  lang = 'es';
  assert.deepEqual(read(), { lang: 'es', input: 'touch', orientation: 'landscape', display_mode: 'fullscreen' });
  // opened from the home screen (the manifest asks for full screen there): settled as the page starts
  assert.equal(interfaceReader({ win, doc: { body: doc.body }, getLang: () => 'en' })().display_mode, 'standalone');
  assert.equal(interfaceReader({ win: { ...win, navigator: { standalone: true }, matchMedia: () => ({ matches: false }) }, doc: { body: doc.body } })().display_mode, 'standalone', 'iOS');
  // a desktop with a mouse, until its screen is touched (js/donostia/touch.js sets the class)
  const desk = interfaceReader({ win: { innerWidth: 1440, innerHeight: 840, matchMedia: () => ({ matches: false }) }, doc, getLang: () => 'en' });
  assert.equal(desk().input, 'mouse');
  classes.add('touch-enabled');
  assert.equal(desk().input, 'touch');
  // no page at all (node): nothing to read, nothing thrown
  assert.deepEqual(interfaceReader()(), { input: 'mouse', display_mode: 'browser' });
});

// the events named in a text: `name { props }` and bare `name` after a list's dash, an arrow or a comma
const SENT = ['$pageview', 'app_start', 'world_built', 'shaders_compiled', 'app_ready', 'details_ready', 'first_move', 'app_unsupported', 'app_error', 'gpu_lost',
  'cookie_consent', 'fps_sample', 'cell_visit', 'quality_change', 'teleport', 'time_preset', 'live_toggle', 'map_open', 'hud_hide', 'language_change',
  'fullscreen_toggle', 'session_end'];

test('the event list in the header is exact: every event sent is listed, and every one listed is sent', () => {
  const source = fs.readFileSync(`${root}js/donostia/analytics.js`, 'utf8');
  const header = source.slice(0, source.indexOf('export const PROJECT_TOKEN'));
  const code = source.slice(header.length) + fs.readFileSync(`${root}js/donostia/main.js`, 'utf8') + fs.readFileSync(`${root}js/donostia/hud.js`, 'utf8');
  // every name the code hands to track() or capture(), or returns from the session's tick()
  const sent = new Set();
  for (const [, name] of code.matchAll(/\b(?:track|capture)\('([$\w]+)'/g)) sent.add(name);
  for (const [, name] of code.matchAll(/events\.push\(\['(\w+)'/g)) sent.add(name);
  assert.deepEqual([...sent].sort(), [...SENT].sort(), 'the events the code sends');
  const readme = fs.readFileSync(`${root}tools/donostia/README.md`, 'utf8');
  const section = readme.slice(readme.indexOf('## Analytics'), readme.indexOf('## Notes'));
  for (const name of [...SENT, '$pageleave']) {
    assert.ok(new RegExp(`(^|[^\\w$])${name.replace('$', '\\$')}([^\\w]|$)`).test(header), `analytics.js's header lists ${name}`);
    assert.ok(section.includes(`\`${name}`), `the README lists ${name}`);
  }
  // and nothing in the header that is not sent: every snake_case word followed by its { properties }
  for (const [, name] of header.matchAll(/(?:^|[\s(→])([a-z]+(?:_[a-z]+)+) \{/gm)) assert.ok(sent.has(name), `the header lists ${name}, which nothing sends`);
  // the properties new with the phone interface, by name, in both
  for (const prop of ['quality_mode', 'quality_tier', 'render_scale', 'fps_capped', 'quality_detected', 'lang', 'input', 'orientation', 'display_mode',
    'ms_since_ready', 'shaders_pending', 'shaders_total', 'quality_changed', 'from_mode', 'to_mode', 'steps', 'visit_id', 'seq', 'hidden_s', 'reason', 'ready']) {
    assert.ok(header.includes(prop), `the header names ${prop}`);
    assert.ok(section.includes(prop), `the README names ${prop}`);
  }
});

test('the page wires the analytics in, Donostia only, and says so in the data popover', () => {
  const main = fs.readFileSync(`${root}js/donostia/main.js`, 'utf8');
  const hud = fs.readFileSync(`${root}js/donostia/hud.js`, 'utf8');
  assert.match(main, /from '\.\/analytics\.js'/);
  assert.match(main, /from '\.\/consent\.js'/);
  assert.match(main, /initAnalytics\(\{ readInterface: interfaceReader\(/);
  for (const event of ['$pageview', 'app_start', 'app_unsupported', 'world_built', 'shaders_compiled', 'gpu_lost']) assert.ok(main.includes(`'${event}'`), `main.js sends ${event}`);
  assert.ok(main.indexOf("'$pageview'") < main.indexOf("'app_start'"), 'the page view opens the funnel');
  assert.ok(main.indexOf("'app_start'") < main.indexOf('await probeWebGPU()'), 'before WebGPU is asked for: a browser without it is counted');
  assert.match(main, /analytics\.ready\(\{ shaders_pending: view\.compiler\.pending, shaders_total: view\.compiler\.total \}\)/);
  assert.match(main, /if \(stage === 'done'\) analytics\.details\(/, "the background compile's end, where main.js says it");
  assert.match(main, /else analytics\.details\(/, 'and at once where nothing was left to compile');
  assert.match(main, /analytics\.setQuality\(quality\.get\(\)\)/);
  assert.match(main, /quality\.onChange\(\(state\) => analytics\.setQuality\(state\)\)/);
  assert.match(main, /analytics\.tick\(\{[^}]*yaw: god\.yaw, pitch: god\.pitch, flight: Boolean\(god\.flight\)/, 'the heading, for the first look');
  assert.match(main, /consent\.setReady\(\)/);
  assert.ok(main.indexOf('hud.setReady()') < main.indexOf('consent.setReady()'), 'the card after the city shows');
  for (const event of ['teleport', 'time_preset', 'live_toggle', 'map_open', 'hud_hide', 'language_change', 'fullscreen_toggle']) assert.ok(hud.includes(`track('${event}'`), `hud.js sends ${event}`);
  const html = fs.readFileSync(`${root}index.html`, 'utf8');
  assert.match(html, /<div id="credits-popover"[^]*posthog\.com[^]*<\/div>/, 'the data popover says where the usage events go');
  for (const id of ['consent-card', 'consent-accept', 'consent-decline', 'consent-line', 'consent-state', 'consent-change']) assert.ok(html.includes(`id="${id}"`), `index.html has #${id}`);
  assert.match(html, /<aside id="consent-card"[^>]*\bhidden\b/, 'the card starts hidden');
  assert.match(html, /<aside id="consent-card"[^>]*role="dialog"/);
  assert.match(html, /<p id="consent-line"[^>]*\bhidden\b/, "the answer's line starts hidden");
  const css = fs.readFileSync(`${root}css/donostia.css`, 'utf8');
  assert.match(css, /\.hud-consent\s*{/, 'the card has its place in css/donostia.css');
  // on the upright phone: above the stick and the bar, within the safe areas
  assert.match(css, /@media \(max-width: 620px\) and \(min-height: 501px\) \{\s*body\.touch-enabled \.hud-consent \{[^}]*left: var\(--safe-l\);[^}]*right: var\(--safe-r\);[^}]*bottom: calc\(var\(--safe-b\) \+ var\(--dock-h\) \+ 132px \+ \d+px\);/);
  assert.match(css, /body\.touch-enabled \.consent-btn \{ height: 44px; \}/, 'buttons a thumb can hit');
  assert.ok(!html.includes('posthog-js'), 'the SDK is not on the page: analytics.js imports it when allowed');
  assert.equal([...(main + hud + html).matchAll(/phc_\w+/g)].length, 0, 'the project token is in analytics.js alone');
  const newyork = fs.readFileSync(`${root}newyork.html`, 'utf8');
  assert.ok(!/posthog|analytics|consent/.test(newyork), 'nothing on the New York page');
  for (const file of fs.readdirSync(`${root}js`).filter((f) => f.endsWith('.js'))) {
    assert.ok(!/analytics\.js|consent\.js/.test(fs.readFileSync(`${root}js/${file}`, 'utf8')), `${file} (New York) never imports the analytics`);
  }
});
