import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The quality system as data and decisions (js/donostia/quality.js): the tiers, the tier a device starts at, the
// drawing buffer's pixel ratio, the frame-time governor and the controller the HUD talks to.

const root = fileURLToPath(new URL('../', import.meta.url));
const Q = await import(pathToFileURL(`${root}js/donostia/quality.js`).href);
const { TIERS, TIER_NAMES, Governor, SCALES } = Q;

const storage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); }, data
  };
};
const desktop = { coarse: false, touchPoints: 0, uaMobile: false, deviceMemory: 8, cores: 10, dpr: 2, gpu: { vendor: 'apple', architecture: 'metal-3' } };
const iphone = { coarse: true, touchPoints: 5, uaMobile: true, deviceMemory: null, cores: 6, dpr: 3, screenShort: 390, gpu: { vendor: 'apple', architecture: 'metal-3' } };
const android = (gpu, deviceMemory = 8, cores = 8) => ({ coarse: true, touchPoints: 5, uaMobile: true, deviceMemory, cores, dpr: 2.6, screenShort: 412, gpu });
// A GPU-bound phone: `fixed` ms a frame whatever is drawn, plus k ms for high's pixels at full scale, each tier's
// pixels costing its share of high's; vsync at 60 Hz. drive() runs a governor or a controller on such a phone
const RATIO = { low: 1.25, medium: 1.5, high: 2 }, COST = { low: 0.5, medium: 0.8, high: 1 };
const phone = (fixed, k) => (tier, scale) => Math.max(16.7, fixed + k * (RATIO[tier] * scale / 2) ** 2 * COST[tier]);
const drive = (target, model, seconds, onChange = null) => {
  const names = ['low', 'medium', 'high'];
  for (let t = 0; t < seconds * 1000;) {
    const at = target.get ? target.get() : { tier: names[target.level], scale: target.scale };
    const ms = model(at.tier, at.scale);
    t += ms;
    if (target.frame(ms) && onChange) onChange(target, t);
  }
};
// frames of `ms` for `seconds` of them; returns how often the governor changed
const run = (target, ms, seconds) => {
  let changes = 0;
  for (let t = 0; t < seconds * 1000; t += ms) if (target.frame(ms)) changes++;
  return changes;
};

test('ultra is the desktop picture as it was; every tier below costs no more than the one above', () => {
  assert.deepEqual(TIER_NAMES, ['low', 'medium', 'high', 'ultra']);
  const u = TIERS.ultra;
  // main.js before the tiers: pixel ratio 1, MSAA, 3072 px cascades, SSR, bloom; vegetation.js's and terrain.js's reaches
  assert.deepEqual([u.maxPixelRatio, u.fixedPixelRatio, u.msaa, u.shadows, u.shadowMapSize, u.shadowFar, u.ssr, u.bloom], [1, true, true, true, 3072, 1, true, true]);
  assert.deepEqual([u.terrainShadows, u.propShadows, u.terrainMesh, u.spray], [true, true, 'full', true]);
  assert.deepEqual([u.terrainLod, u.treeNear, u.treeMid, u.treeBillboards, u.treeFar, u.detailDistance, u.rain, u.envBakeGap], [1, 85, 300, 900, 3400, 1, 1, 0.15]);
  assert.equal(u.adaptive, false);
  assert.equal(u.groundMaps, 'full');
  assert.equal(u.releaseGeometry, false);
  const rising = ['shadowMapSize', 'shadowFar', 'terrainLod', 'treeNear', 'treeMid', 'treeBillboards', 'treeFar', 'detailDistance', 'rain'];
  const flags = ['msaa', 'shadows', 'terrainShadows', 'propShadows', 'ssr', 'bloom', 'spray'];
  for (let i = 1; i < TIER_NAMES.length; i++) {
    const a = TIERS[TIER_NAMES[i - 1]], b = TIERS[TIER_NAMES[i]];
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), 'the tiers set the same knobs');
    for (const k of rising) assert.ok(a[k] <= b[k], `${k}: ${TIER_NAMES[i - 1]} ${a[k]} > ${TIER_NAMES[i]} ${b[k]}`);
    for (const k of flags) assert.ok(!a[k] || b[k], `${k} is on at ${TIER_NAMES[i - 1]} and off at ${TIER_NAMES[i]}`);
    assert.ok(a.envBakeGap >= b.envBakeGap);
  }
  for (const name of ['low', 'medium', 'high']) {
    assert.ok(TIERS[name].adaptive && TIERS[name].releaseGeometry, name);
    assert.ok(SCALES.includes(TIERS[name].minScale), `${name}'s floor is one of the governor's steps`);
  }
});

test('the pixel ratio follows the screen up to the tier\'s cap and its pixel budget; ultra\'s is 1', () => {
  const phone = { dpr: 3, width: 390, height: 844 };
  assert.equal(Q.pixelRatio(TIERS.ultra, phone), 1);
  assert.equal(Q.pixelRatio(TIERS.ultra, { dpr: 2, width: 1440, height: 840 }), 1);
  assert.equal(Q.pixelRatio(TIERS.low, phone), 1.25);
  assert.equal(Q.pixelRatio(TIERS.medium, phone), 1.5);
  assert.equal(Q.pixelRatio(TIERS.high, phone), 2);
  // a screen of fewer pixels than the cap is not supersampled
  assert.equal(Q.pixelRatio(TIERS.high, { dpr: 1, width: 800, height: 600 }), 1);
  // a tablet has four times the pixels: the budget holds the drawing buffer
  const tablet = { dpr: 2, width: 1366, height: 1024 };
  for (const name of ['low', 'medium', 'high']) {
    const r = Q.pixelRatio(TIERS[name], tablet);
    assert.ok(tablet.width * tablet.height * r * r <= TIERS[name].maxPixels * 1.02, `${name}: ratio ${r}`);
    assert.ok(r >= 0.5);
  }
  // the governor's scale multiplies it
  assert.equal(Q.pixelRatio(TIERS.high, phone, 0.6), 1.2);
});

test('autodetect: desktops get ultra, phones start at medium unless known strong or weak', () => {
  assert.equal(Q.detectTier(desktop).tier, 'ultra');
  assert.equal(Q.detectTier(desktop).mobile, false);
  // nothing known at all (no matchMedia, no adapter info): a desktop as before
  assert.equal(Q.detectTier({}).tier, 'ultra');
  assert.equal(Q.detectTier(iphone).tier, 'medium');
  // an iPad says it is a Mac, but its pointer is coarse and it has touch points
  assert.equal(Q.detectTier({ ...iphone, uaMobile: false, screenShort: 820 }).tier, 'medium');
  assert.equal(Q.detectTier(android({ vendor: 'qualcomm', architecture: 'adreno-7xx' })).tier, 'high');
  assert.equal(Q.detectTier(android({ vendor: 'qualcomm', architecture: 'adreno-7xx' }, 4)).tier, 'medium');
  assert.equal(Q.detectTier(android({ vendor: 'qualcomm', architecture: 'adreno-6xx' })).tier, 'medium');
  assert.equal(Q.detectTier(android({ vendor: 'qualcomm', architecture: 'adreno-5xx' })).tier, 'low');
  assert.equal(Q.detectTier(android({ vendor: 'arm', architecture: 'valhall' })).tier, 'medium');
  assert.equal(Q.detectTier(android({ vendor: 'arm', architecture: 'valhall', description: 'mali-g715 immortalis' })).tier, 'high');
  assert.equal(Q.detectTier(android({ vendor: 'arm', architecture: 'bifrost' })).tier, 'low');
  assert.equal(Q.detectTier(android({ vendor: 'samsung', architecture: 'xclipse-940' })).tier, 'high');
  // unknown devices: conservative
  assert.equal(Q.detectTier(android({}, 8)).tier, 'medium');
  assert.equal(Q.detectTier(android({}, 4)).tier, 'low');
  assert.equal(Q.detectTier(android({}, null)).tier, 'low');
  // few cores: a tier lower; little memory: low
  assert.equal(Q.detectTier(android({ vendor: 'qualcomm', architecture: 'adreno-7xx' }, 8, 4)).tier, 'medium');
  assert.equal(Q.detectTier(android({ vendor: 'arm', architecture: 'valhall' }, 2)).tier, 'low');
  // a software adapter, desktop or not
  assert.equal(Q.detectTier({ ...desktop, gpu: { vendor: 'google', architecture: 'swiftshader', fallback: true } }).tier, 'low');
  // never ultra on a phone, and always a reason
  for (const env of [iphone, android({ vendor: 'qualcomm', architecture: 'adreno-8xx' }, 16, 8)]) {
    const d = Q.detectTier(env);
    assert.notEqual(d.tier, 'ultra');
    assert.ok(d.mobile && d.reasons.length > 0);
  }
});

test('readEnvironment survives a browser that tells nothing', () => {
  const env = Q.readEnvironment(null, {});
  assert.equal(env.deviceMemory, null);
  assert.equal(env.gpu.vendor, '');
  assert.equal(env.limits, null);
  const full = Q.readEnvironment({ info: { vendor: 'Qualcomm', architecture: 'Adreno-7xx' }, limits: { maxTextureDimension2D: 8192, maxBufferSize: 1 << 30 } },
    { navigator: { maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Linux; Android 14) Mobile', deviceMemory: 8, hardwareConcurrency: 8 }, matchMedia: (q) => ({ matches: q.includes('coarse') }), devicePixelRatio: 2.6, screen: { width: 412, height: 915 } });
  assert.deepEqual([full.coarse, full.uaMobile, full.deviceMemory, full.cores, full.screenShort, full.gpu.vendor], [true, true, 8, 8, 412, 'qualcomm']);
  assert.equal(Q.detectTier(full).tier, 'high');
});

test('the device\'s limits trim the boot settings; a reload is asked only for what cannot change live', () => {
  // WebGPU's compatibility mode: 4096 px textures. No 4200 x 5120 ground map, cascades of 2048
  const compat = Q.bootSettings('ultra', { maxTextureDimension2D: 4096 });
  assert.equal(compat.groundMaps, 'classes');
  assert.equal(compat.shadowMapSize, 2048);
  assert.equal(Q.bootSettings('ultra', { maxTextureDimension2D: 8192 }).shadowMapSize, 3072);
  assert.equal(Q.bootSettings('high', null).groundMaps, 'full');
  const b = (name) => Q.bootSettings(name);
  assert.equal(Q.needsReload(b('ultra'), b('ultra')), false);
  assert.equal(Q.needsReload(b('ultra'), b('high')), false, 'high differs from ultra in live settings only');
  assert.equal(Q.needsReload(b('high'), b('medium')), true, 'MSAA');
  assert.equal(Q.needsReload(b('medium'), b('low')), true, 'shadows, ground maps');
  assert.equal(Q.needsReload({ ...b('high'), ssr: true }, { ...b('high'), ssr: false }), false, 'SSR turns off live');
  assert.equal(Q.needsReload({ ...b('high'), ssr: false }, { ...b('high'), ssr: true }), true, 'but not on');
});

test('the governor lowers the scale when the frame rate stays under the target, then the tier', () => {
  const levels = ['low', 'medium', 'high'].map((n) => ({ minScale: TIERS[n].minScale, ratio: TIERS[n].maxPixelRatio }));
  const g = new Governor({ levels });
  assert.deepEqual([g.level, g.scale], [2, 1]);
  // 60 fps: nothing to do, however long
  assert.equal(run(g, 16.7, 30), 0);
  // one slow second is not a trend (and the settle windows at the start are skipped)
  const h = new Governor({ levels });
  run(h, 16.7, 3);
  run(h, 25, 1.1);
  assert.equal(run(h, 16.7, 3), 0);
  assert.deepEqual([h.level, h.scale], [2, 1]);
  // a phone too slow for any of it (19.2 ms before a pixel is drawn): the scale steps down to the tier's floor, then
  // the tier goes with the resolution about where it was (2 x 0.6 = 1.2 = 1.5 x 0.77), down to the very bottom
  const steps = [];
  drive(g, phone(19.2, 7), 120, (gov) => steps.push([gov.level, gov.scale]));
  assert.deepEqual(steps, [[2, 0.88], [2, 0.77], [2, 0.68], [2, 0.6], [1, 0.77], [1, 0.68], [0, 0.77], [0, 0.68]]);
  assert.deepEqual([g.demoted, g.floored, g.capped], [true, true, false]);
  assert.equal(run(g, 21, 20), 0, 'at the bottom it says so and stops');
  // a hitch or a hidden tab is no frame rate
  const k = new Governor({ levels });
  run(k, 16.7, 3);
  for (let i = 0; i < 40; i++) { k.frame(16.7); k.frame(400); }
  assert.deepEqual([k.level, k.scale], [2, 1]);
  // 20 fps: two steps at once
  const f = new Governor({ levels });
  for (let i = 0; i < 180; i++) f.frame(16.7); // (three windows of 60 frames)
  for (let i = 0; i < 20; i++) f.frame(50); // (one of 20)
  assert.equal(f.scale, 0.77);
});

test('the governor tries a step up with the target held, and backs off when the step does not hold', () => {
  const levels = ['low', 'medium', 'high'].map((n) => ({ minScale: TIERS[n].minScale, ratio: TIERS[n].maxPixelRatio }));
  // a phone that holds 60 fps at medium, and at high up to 0.68 of its resolution (16 ms), not above (20 ms)
  const model = phone(0, 34);
  const g = new Governor({ levels, level: 0, scale: 0.68 });
  const tries = [];
  let downs = 0, last = [0, 0.68];
  drive(g, model, 1800, (gov, t) => {
    const up = gov.level > last[0] || (gov.level === last[0] && gov.scale > last[1]);
    if (up && gov.level === 2 && gov.scale === 0.77) tries.push(t);
    if (!up) downs++;
    last = [gov.level, gov.scale];
  });
  // it climbed to high and settled a step under what does not hold...
  assert.deepEqual([g.level, g.scale === 0.68 || g.scale === 0.77], [2, true]);
  // ...trying that step again later and later: no pumping
  const gaps = tries.slice(1).map((t, n) => Math.round((t - tries[n]) / 1000));
  assert.ok(gaps.length >= 2 && gaps.length <= 12, `${gaps.length + 1} tries in half an hour: ${JSON.stringify(gaps)}`);
  for (let n = 1; n < gaps.length; n++) assert.ok(gaps[n] >= gaps[n - 1] * 0.95, `the tries get no closer together: ${JSON.stringify(gaps)}`);
  assert.ok(gaps[gaps.length - 1] >= 200, `minutes apart by the end: ${JSON.stringify(gaps)}`);
  assert.equal(downs, tries.length, 'every step down is a try taken back');
  assert.equal(g.capped, false);
  // a device with headroom everywhere ends at the top and stays
  const fast = new Governor({ levels, level: 0, scale: 0.68 });
  run(fast, 16.7, 120);
  assert.deepEqual([fast.level, fast.scale], [2, 1]);
  assert.equal(run(fast, 16.7, 60), 0);
});

test('a frame rate held from outside (Low Power Mode\'s 30 fps) is not chased: the resolution comes back', () => {
  const levels = ['low', 'medium', 'high'].map((n) => ({ minScale: TIERS[n].minScale, ratio: TIERS[n].maxPixelRatio }));
  const g = new Governor({ levels, level: 1 });
  let lowest = 1;
  for (let t = 0; t < 60e3; t += 33.3) { g.frame(33.3); lowest = Math.min(lowest, g.scale); }
  // it went down to the tier's floor, saw the frame time unmoved, and came back: same tier, full scale, 30 fps target
  assert.equal(lowest, TIERS.medium.minScale);
  assert.deepEqual([g.level, g.scale, g.capped, Math.round(g.targetFps), g.demoted], [1, 1, true, 30, false]);
  assert.equal(run(g, 33.3, 120), 0, 'and stays');
  // a rate that drops under the cap still counts
  run(g, 50, 6);
  assert.ok(g.scale < 1);
  // the cap lifted: 60 fps is the target again
  run(g, 16.7, 5);
  assert.deepEqual([g.capped, g.targetFps], [false, 60]);
  // a GPU-bound phone is not mistaken for one: its frame time follows the pixels
  const h = new Governor({ levels, level: 1 });
  drive(h, phone(4, 40), 120);
  assert.equal(h.capped, false);
  assert.ok(h.level < 1 || h.scale < 1, 'it settled lower instead');
});

test('the controller: URL, stored choice, auto, set() and change events', () => {
  const view = [390, 844, 3];
  // auto on a phone: the detected tier, adaptive
  let q = Q.createQuality({ storage: storage() });
  let s = q.init({ env: iphone, search: '' });
  q.viewport(...view);
  assert.deepEqual([s.mode, s.tier, s.source, s.detected], ['auto', 'medium', 'auto', 'medium']);
  assert.equal(q.get().pixelRatio, 1.5);
  assert.equal(q.get().adaptive, true);
  assert.deepEqual(q.tiers, TIER_NAMES);
  assert.equal(q.describe('high'), TIERS.high);
  assert.equal(q.describe('nope'), null);
  // desktop: ultra, never adaptive, whatever the frames say
  q = Q.createQuality({ storage: storage() });
  s = q.init({ env: desktop, search: '?debug' });
  q.viewport(1440, 840, 2);
  assert.deepEqual([s.tier, q.get().pixelRatio, q.get().adaptive, q.get().needsReload], ['ultra', 1, false, false]);
  assert.equal(run(q, 40, 20), 0);
  assert.equal(q.get().tier, 'ultra');
  // ?quality= wins over the stored choice and is not remembered; ?quality=auto ignores the stored choice
  const st = storage({ 'donostia-quality': 'low' });
  q = Q.createQuality({ storage: st });
  assert.deepEqual([q.init({ env: iphone, search: '?quality=high' }).tier, q.get().source], ['high', 'url']);
  assert.equal(st.getItem('donostia-quality'), 'low');
  assert.deepEqual([q.init({ env: iphone, search: '' }).tier, q.get().source], ['low', 'stored']);
  assert.equal(q.init({ env: iphone, search: '?quality=auto' }).mode, 'auto');
  assert.equal(q.init({ env: iphone, search: '?quality=bogus' }).tier, 'low', 'an unknown tier is no choice: the stored one stands');
  // set(): applies, remembers, tells
  const store = storage();
  q = Q.createQuality({ storage: store });
  q.init({ env: iphone, search: '' });
  q.viewport(...view);
  const seen = [], applied = [];
  const off = q.onChange((state) => seen.push(state.tier));
  q.attach((state) => applied.push([state.tier, state.pixelRatio, state.settings.shadows, state.settings.treeMid]));
  s = q.set('low');
  assert.deepEqual([s.mode, s.tier, s.needsReload, s.pixelRatio], ['low', 'low', true, 1.25]);
  assert.equal(store.getItem('donostia-quality'), 'low');
  // (booted at medium: the shadows stay until the reload, the trees' reach changes at once)
  assert.deepEqual(applied.at(-1), ['low', 1.25, true, TIERS.low.treeMid]);
  s = q.set('high');
  assert.deepEqual([s.tier, s.needsReload, s.settings.ssr, s.settings.msaa], ['high', true, false, false], 'booted without SSR & MSAA: they wait for the reload');
  assert.equal(s.settings.shadowMapSize, 2048, 'the shadow map resizes live');
  s = q.set('auto');
  assert.deepEqual([s.mode, s.tier, s.needsReload], ['auto', 'medium', false]);
  assert.equal(store.getItem('donostia-quality'), null);
  assert.deepEqual(seen, ['low', 'high', 'medium']);
  off();
  q.set('low', { persist: false });
  assert.equal(seen.length, 3);
  assert.equal(store.getItem('donostia-quality'), null);
  assert.throws(() => q.set('extreme'), /not one of/);
  // ultra picked on a phone: the desktop's settings at the phone's resolution (not the desktop's fixed ratio of 1)
  q = Q.createQuality({ storage: storage() });
  s = q.init({ env: iphone, search: '?quality=ultra' });
  q.viewport(...view);
  assert.deepEqual([s.tier, s.mobile, q.get().pixelRatio, q.get().adaptive], ['ultra', true, 2, false]);
  // storage that throws is no storage
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  q = Q.createQuality({ storage: broken });
  assert.equal(q.init({ env: iphone, search: '' }).tier, 'medium');
  assert.equal(q.set('high').tier, 'high');
});

test('the controller on auto: the governor moves the tier, and the next visit starts where this one settled', () => {
  const store = storage();
  let q = Q.createQuality({ storage: store });
  q.init({ env: iphone, search: '' });
  q.viewport(390, 844, 3);
  const applied = [];
  q.attach((state) => applied.push([state.tier, state.scale, state.pixelRatio]));
  // a slow phone: down the scale, then to low
  drive(q, phone(19.2, 7), 40);
  assert.equal(q.get().tier, 'low');
  assert.ok(applied.length >= 3 && applied.some(([tier, scale]) => tier === 'medium' && scale < 1), JSON.stringify(applied));
  assert.equal(q.get().needsReload, false, 'auto never asks for a reload');
  // it could not hold the tier it booted with, from the start: the next visit boots low and stays at most there
  let memo = JSON.parse(store.getItem('donostia-quality-auto'));
  assert.deepEqual([memo.detected, memo.tier, memo.ceiling], ['medium', 'low', 'low']);
  q = Q.createQuality({ storage: store });
  let s = q.init({ env: iphone, search: '' });
  q.viewport(390, 844, 3);
  assert.deepEqual([s.tier, s.bootTier, s.settings.shadows], ['low', 'low', false]);
  run(q, 16.7, 300);
  assert.equal(q.get().tier, 'low', 'not above the ceiling');
  assert.equal(q.get().scale, 1);
  // ...until the ceiling runs out
  q = Q.createQuality({ storage: store });
  s = q.init({ env: iphone, search: '', now: Date.now() + 8 * 86400e3 });
  assert.equal(s.tier, 'low', 'it still boots where it settled');
  q.viewport(390, 844, 3);
  run(q, 16.7, 300);
  assert.equal(q.get().tier, 'high', 'but may climb again, to one tier above the detected one');

  // a fast phone: up to high's live settings, remembered once settled; the next visit boots high
  const fast = storage();
  q = Q.createQuality({ storage: fast });
  q.init({ env: iphone, search: '' });
  q.viewport(390, 844, 3);
  run(q, 16.7, 120);
  s = q.get();
  assert.deepEqual([s.tier, s.bootTier, s.scale, s.settings.msaa, s.settings.ssr], ['high', 'medium', 1, false, false]);
  memo = JSON.parse(fast.getItem('donostia-quality-auto'));
  assert.deepEqual([memo.tier, memo.ceiling], ['high', null]);
  q = Q.createQuality({ storage: fast });
  s = q.init({ env: iphone, search: '' });
  assert.deepEqual([s.tier, s.bootTier, s.settings.msaa, s.settings.ssr], ['high', 'high', true, true]);
  // a later slowdown (a hot phone) lowers the tier without a ceiling
  q.viewport(390, 844, 3);
  run(q, 16.7, 200);
  drive(q, phone(19.2, 7), 60);
  assert.notEqual(q.get().tier, 'high');
  memo = JSON.parse(fast.getItem('donostia-quality-auto'));
  assert.equal(memo.ceiling, null);
  // a slow start that passes (the phone was busy): the tier is given up, then held again, and no ceiling is left
  const busy = storage();
  q = Q.createQuality({ storage: busy });
  q.init({ env: iphone, search: '' });
  q.viewport(390, 844, 3);
  drive(q, phone(19.2, 7), 40);
  assert.equal(JSON.parse(busy.getItem('donostia-quality-auto')).ceiling, 'low');
  run(q, 16.7, 200);
  assert.deepEqual([q.get().tier, JSON.parse(busy.getItem('donostia-quality-auto')).ceiling], ['high', null]);
  // another device behind the same storage (the memo's detected tier differs): the memo is not for it
  q = Q.createQuality({ storage: fast });
  assert.equal(q.init({ env: android({ vendor: 'arm', architecture: 'bifrost' }), search: '' }).tier, 'low');

  // a tier picked by hand: the governor scales its resolution and leaves the tier alone
  q = Q.createQuality({ storage: storage() });
  q.init({ env: iphone, search: '?quality=high' });
  q.viewport(390, 844, 3);
  drive(q, phone(19.2, 7), 120);
  assert.deepEqual([q.get().tier, q.get().scale, q.get().floored], ['high', TIERS.high.minScale, true]);
  run(q, 16.7, 300);
  assert.deepEqual([q.get().tier, q.get().scale], ['high', 1]);

  // a lost GPU device on auto: the next start is a tier lower
  const lost = storage();
  q = Q.createQuality({ storage: lost });
  q.init({ env: iphone, search: '' });
  q.deviceLost();
  q = Q.createQuality({ storage: lost });
  assert.equal(q.init({ env: iphone, search: '' }).tier, 'low');
  // ...but not when the tier was picked by hand, or on a desktop
  const kept = storage();
  q = Q.createQuality({ storage: kept });
  q.init({ env: desktop, search: '' });
  q.deviceLost();
  assert.equal(kept.getItem('donostia-quality-auto'), null);
});

test('?debug overrides single settings of a tier, to measure a knob', () => {
  const q = Q.createQuality({ storage: storage() });
  let s = q.init({ env: desktop, search: '?debug&quality=ultra&q.shadows=false&q.treeMid=190&q.nonsense=1' });
  assert.deepEqual([s.tier, s.settings.shadows, s.settings.treeMid, s.settings.ssr], ['ultra', false, 190, true]);
  assert.equal('nonsense' in s.settings, false);
  // without ?debug they are ignored
  s = q.init({ env: desktop, search: '?quality=ultra&q.shadows=false' });
  assert.equal(s.settings.shadows, true);
});
