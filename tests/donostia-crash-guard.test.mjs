import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The crash guard (js/donostia/crash-guard.js) with the quality controller's recovery (js/donostia/quality.js): a
// page the browser kills leaves a note, the next load starts lighter, and no stored setting keeps a visitor in a
// crash loop. boot() below is js/donostia/main.js's start-up, in the order it runs there; a "death" is a boot whose
// guard is simply dropped (no leave(): the dead page sends no pagehide), and the next boot() is the reload.

const root = fileURLToPath(new URL('../', import.meta.url));
const G = await import(pathToFileURL(`${root}js/donostia/crash-guard.js`).href);
const Q = await import(pathToFileURL(`${root}js/donostia/quality.js`).href);

const storage = (initial = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null), setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); }, data
  };
};
const desktop = { coarse: false, touchPoints: 0, uaMobile: false, deviceMemory: 8, cores: 10, dpr: 2, gpu: { vendor: 'apple', architecture: 'metal-3' } };
const iphone = { coarse: true, touchPoints: 5, uaMobile: true, deviceMemory: null, cores: 6, dpr: 3, screenShort: 390, gpu: { vendor: 'apple', architecture: 'metal-3' } };
const PICK = 'donostia-quality';

// One device: its localStorage, a tab's sessionStorage, a clock. boot() is one page load, as main.js's initApp() does
// it: read the last note, stop at the message if it says so, else decide the tier and start this load's note
const device = (env, stored = {}) => {
  const d = { env, local: storage(stored), session: storage(), time: 1_000_000, events: [] };
  d.boot = (search = '') => {
    d.time += 3000; // (the browser reloads a dead page within seconds)
    const guard = G.createCrashGuard({ storage: d.local, session: d.session, mobile: Q.detectTier(env).mobile, now: () => d.time });
    const last = guard.previous;
    if (last.halt) {
      d.events.push({ from_tier: last.failedTier, to_tier: null, halted: true, fails: last.fails });
      return { halted: true, guard, last, retry() { guard.retry(); } };
    }
    const quality = Q.createQuality({ storage: d.local });
    const state = quality.init({
      env, search, now: d.time,
      recovery: last.fails > 0 ? { failedTier: last.failedTier, fails: last.fails, dropPick: last.dropPick } : null
    });
    guard.begin({ tier: state.tier, mode: state.mode, pick: state.source === 'stored' ? state.mode : null });
    if (last.failed) d.events.push({ from_tier: last.failedTier, to_tier: state.tier, halted: false, fails: last.fails, last_stage: last.lastStage });
    const load = (upTo = 'gpu') => {
      for (const stage of ['lighting', 'terrain data', 'terrain mesh', 'landmarks', 'buildings', 'details', 'colliders', 'compile', 'warm-up', 'gpu']) {
        d.time += 800;
        guard.stage(stage);
        if (stage === upTo) break;
      }
    };
    return {
      halted: false, guard, last, quality, state, tier: state.tier,
      // the page is killed in the shader compile: the last step it finished is 'colliders'
      dieLoading() { load('colliders'); },
      // the city shows, and runs for a while
      show(seconds = 20) {
        load();
        guard.shown();
        for (let t = 0; t < seconds; t += 4) { d.time += 4000; guard.beat({ tier: quality.get().tier, realTime: true }); }
      }
    };
  };
  return d;
};

test('assess(): what a note says about the visit that left it', () => {
  const now = 10_000_000;
  const note = (over = {}) => ({ v: 1, id: 'tab-a', live: true, tier: 'medium', mode: 'auto', stage: 'colliders', shown: false, hidden: false, t0: now - 9000, t: now - 2000, fails: 0, failedTier: null, pick: null, pickFails: 0, ...over });
  // no note, or nonsense in its place: a first visit
  for (const nothing of [null, undefined, 'x', 3]) assert.deepEqual([G.assess(nothing, { now }).failed, G.assess(nothing, { now }).fails], [false, 0]);
  // died loading, in view
  let a = G.assess(note(), { now, tabId: 'tab-a', mobile: true });
  assert.deepEqual([a.failed, a.reason, a.fails, a.failedTier, a.lastStage, a.shown, a.sameTab, a.halt, a.dropPick], [true, 'loading', 1, 'medium', 'colliders', false, true, false, false]);
  assert.deepEqual([a.ranMs, a.agoMs], [7000, 2000]);
  // died running, with real time on
  a = G.assess(note({ shown: true, stage: 'running', realTime: true }), { now, tabId: 'tab-a' });
  assert.deepEqual([a.failed, a.reason, a.fails, a.lastStage, a.lastLive], [true, 'running', 1, 'running', true]);
  // left cleanly: nothing
  assert.deepEqual([G.assess(note({ live: false }), { now }).failed, G.assess(note({ live: false }), { now }).reason], [false, 'left']);
  // hidden when last heard of: the browser's business, not a failure
  a = G.assess(note({ hidden: true }), { now, tabId: 'tab-a', mobile: true });
  assert.deepEqual([a.failed, a.reason, a.fails], [false, 'hidden', 0]);
  // older than the window: says nothing, and an earlier count is forgotten
  a = G.assess(note({ t: now - G.WINDOW_MS - 1, fails: 1, failedTier: 'high' }), { now, tabId: 'tab-a', mobile: true });
  assert.deepEqual([a.failed, a.reason, a.fails, a.failedTier], [false, 'old', 0, null]);
  // a desktop: another tab's fresh note is that tab alive in another window; stale, it is a dead page
  assert.deepEqual([G.assess(note(), { now, tabId: 'tab-b' }).failed, G.assess(note(), { now, tabId: 'tab-b' }).reason], [false, 'other-tab']);
  assert.equal(G.assess(note({ t: now - G.STALE_MS - 1 }), { now, tabId: 'tab-b' }).failed, true);
  // a phone shows one tab at a time (and a hidden one says so): a live, visible note is a dead page's, whoever reads it
  assert.equal(G.assess(note(), { now, tabId: 'tab-b', mobile: true }).failed, true);
  assert.equal(G.assess(note(), { now, tabId: null, mobile: true }).failed, true, 'nor does it take sessionStorage to survive');
  // the count runs on, and two in a row with the last at the lowest tier is where it stops
  a = G.assess(note({ tier: 'low', fails: 1, failedTier: 'medium' }), { now, mobile: true });
  assert.deepEqual([a.fails, a.failedTier, a.halt, a.dropPick], [2, 'low', true, true]);
  a = G.assess(note({ tier: 'high', fails: 1, failedTier: 'ultra' }), { now, mobile: true });
  assert.deepEqual([a.fails, a.failedTier, a.halt, a.dropPick], [2, 'high', false, true]);
  // a load the visitor left before the city showed: the earlier failure stands, no new one
  a = G.assess(note({ live: false, fails: 1, failedTier: 'medium', tier: 'low' }), { now, mobile: true });
  assert.deepEqual([a.failed, a.reason, a.fails, a.failedTier, a.halt], [false, 'left', 1, 'medium', false]);
});

test("the owner's phone: ultra stored on an iPhone never boots ultra again, and the pick is cleared at once", () => {
  const d = device(iphone, { [PICK]: 'ultra' });
  const b = d.boot();
  assert.deepEqual([b.state.mode, b.tier, b.state.source, b.state.settings.progressive], ['auto', 'medium', 'auto', true]);
  assert.equal(d.local.getItem(PICK), null, 'the stored pick is gone');
  assert.deepEqual(b.quality.tiers, ['low', 'medium', 'high'], 'and the sheet does not offer ultra');
  b.show();
  assert.equal(d.events.length, 0, 'nothing died');
});

test('a stored pick that kills the page: lighter on the next load, dropped after two failed boots', () => {
  // a phone with high stored (the heaviest pick a phone keeps): high dies loading, medium dies loading
  let d = device(iphone, { [PICK]: 'high' });
  let b = d.boot();
  assert.deepEqual([b.state.mode, b.tier, b.state.source], ['high', 'high', 'stored']);
  b.dieLoading();
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.fails, b.last.failedTier, b.last.lastStage], [true, 1, 'high', 'colliders']);
  assert.deepEqual([b.state.mode, b.tier, b.state.source, b.state.recovered], ['auto', 'medium', 'recovery', { from: 'high', to: 'medium', fails: 1 }]);
  assert.equal(d.local.getItem(PICK), 'high', 'one failure does not drop the pick: it is only not obeyed');
  b.dieLoading();
  // the third boot: at a lower tier still, and the pick is gone
  b = d.boot();
  assert.deepEqual([b.halted, b.last.fails, b.tier, b.state.mode, b.state.source], [false, 2, 'low', 'auto', 'recovery']);
  assert.equal(d.local.getItem(PICK), null, 'two failed boots in a row: the stored pick is cleared');
  b.show();
  assert.deepEqual(d.events.map((e) => [e.from_tier, e.to_tier, e.fails]), [['high', 'medium', 1], ['medium', 'low', 2]]);
  b.guard.leave();
  // and the visit after that: auto, held under the tier that died for a week (the phone's memo)
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.fails, b.state.mode, b.tier, b.state.source], [false, 0, 'auto', 'low', 'auto']);
  assert.equal(JSON.parse(d.local.getItem('donostia-quality-auto')).ceiling, 'low');

  // the same on a desktop with ultra stored: ultra, high, then the lowest, the pick cleared
  d = device(desktop, { [PICK]: 'ultra' });
  b = d.boot();
  assert.equal(b.tier, 'ultra');
  b.dieLoading();
  b = d.boot();
  assert.deepEqual([b.tier, b.state.mode, d.local.getItem(PICK)], ['high', 'auto', 'ultra']);
  b.dieLoading();
  b = d.boot();
  assert.deepEqual([b.halted, b.tier, b.state.mode, d.local.getItem(PICK)], [false, 'low', 'auto', null]);
  b.show();
  b.guard.leave();
  assert.equal(d.local.getItem(G.RUN_KEY), null, 'a good visit left cleanly leaves no note');
  // (a desktop keeps no memo: its next visit is auto's ultra again, without the pick)
  assert.deepEqual([d.boot().tier, d.local.getItem(PICK)], ['ultra', null]);
});

test('a pick that dies, with good visits at the lower tier in between, is dropped the second time', () => {
  const d = device(iphone, { [PICK]: 'high' });
  d.boot().dieLoading();
  let b = d.boot();
  assert.equal(b.tier, 'medium');
  b.show();
  b.guard.leave();
  assert.equal(d.local.getItem(PICK), 'high');
  // the next visit obeys the pick again (the city showed in between: the count of boots started over)...
  b = d.boot();
  assert.deepEqual([b.tier, b.state.source], ['high', 'stored']);
  b.dieLoading();
  // ...and its second death settles it
  b = d.boot();
  assert.deepEqual([b.last.fails, b.last.pickFails, b.last.dropPick, b.tier, b.state.mode], [1, 2, true, 'medium', 'auto']);
  assert.equal(d.local.getItem(PICK), null);
  // a good visit at the picked tier would have cleared the count instead
  const e = device(iphone, { [PICK]: 'high' });
  e.boot().dieLoading();
  b = e.boot();
  b.show();
  b.guard.leave();
  b = e.boot();
  b.show();
  b.guard.leave();
  assert.equal(e.local.getItem(G.RUN_KEY), null);
  e.boot().dieLoading();
  assert.deepEqual([e.boot().last.pickFails, e.local.getItem(PICK)], [1, 'high']);
});

test('the lowest tier dying too ends at the message, not in a loop; its button allows one more try', () => {
  // auto on a phone: medium dies, low dies, and the third load stops
  let d = device(iphone);
  let b = d.boot();
  assert.equal(b.tier, 'medium');
  b.dieLoading();
  b = d.boot();
  assert.equal(b.tier, 'low');
  b.dieLoading();
  b = d.boot();
  assert.deepEqual([b.halted, b.last.fails, b.last.failedTier], [true, 2, 'low']);
  const note = d.local.getItem(G.RUN_KEY);
  // a reload of the message is the message again: nothing was written, nothing is retried
  for (let i = 0; i < 3; i++) assert.equal(d.boot().halted, true);
  assert.equal(d.local.getItem(G.RUN_KEY), note);
  // the button: one more boot, at the lowest tier
  b.retry();
  b = d.boot();
  assert.deepEqual([b.halted, b.tier, b.last.failed, b.last.fails], [false, 'low', false, 1]);
  b.dieLoading();
  assert.equal(d.boot().halted, true, 'and if that dies too, the message again');
  // ...or it works, and all is forgotten
  d.boot().retry();
  b = d.boot();
  b.show();
  b.guard.leave();
  b = d.boot();
  assert.deepEqual([b.halted, b.last.fails, b.tier], [false, 0, 'low']);
  // half an hour later the message no longer stands: a fresh try (on a phone under the remembered cap)
  d = device(iphone);
  d.boot().dieLoading();
  d.boot().dieLoading();
  assert.equal(d.boot().halted, true);
  d.time += G.WINDOW_MS;
  b = d.boot();
  assert.deepEqual([b.halted, b.tier, b.last.reason], [false, 'low', 'old']);

  // low stored (or picked through the URL) and dying: twice, then the message
  d = device(iphone, { [PICK]: 'low' });
  d.boot().dieLoading();
  b = d.boot();
  assert.deepEqual([b.halted, b.tier], [false, 'low']);
  b.dieLoading();
  assert.equal(d.boot().halted, true);
  d = device(iphone);
  d.boot('?quality=low').dieLoading();
  d.boot('?quality=low').dieLoading();
  assert.equal(d.boot('?quality=low').halted, true);

  // whatever is stored, on any device, the city or the message within four loads
  for (const env of [iphone, desktop]) {
    for (const pick of [null, 'low', 'medium', 'high', 'ultra']) {
      const x = device(env, pick ? { [PICK]: pick } : {});
      const tiers = [];
      let stopped = false;
      for (let i = 0; i < 4 && !stopped; i++) {
        const load = x.boot();
        stopped = load.halted;
        if (!stopped) { tiers.push(load.tier); load.dieLoading(); }
      }
      assert.ok(stopped, `${env === iphone ? 'iphone' : 'desktop'} with ${pick} stored: ${tiers.join(' > ')} and then the message`);
      assert.ok(tiers.length <= 3 && tiers.at(-1) === 'low' && tiers.every((t, i) => i === 0 || Q.TIER_NAMES.indexOf(t) <= Q.TIER_NAMES.indexOf(tiers[i - 1])), tiers.join(' > '));
    }
  }
});

test('a page that dies while it runs: the next load is a tier lower, and the count of boots starts again', () => {
  const d = device(iphone);
  let b = d.boot();
  b.show(60);
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.reason, b.last.shown, b.last.lastLive, b.last.fails, b.tier], [true, 'running', true, true, 1, 'low']);
  assert.ok(b.last.ranMs >= 60000);
  // low showed, and died again: still low, and never the message (the city does come up)
  b.show(60);
  b = d.boot();
  assert.deepEqual([b.halted, b.last.fails, b.tier], [false, 1, 'low']);
  // ?quality= in the URL is obeyed all the same (for testing), and the event still tells
  b.show();
  b = d.boot('?quality=ultra');
  assert.deepEqual([b.tier, b.state.source, b.state.recovered, b.state.settings.progressive], ['ultra', 'url', null, true]);
});

test('what is not a death: a clean leave, a hidden page, the back/forward cache, an abandoned load, another window', () => {
  // closed, reloaded or navigated away from (pagehide), loading or running
  let d = device(iphone);
  let b = d.boot();
  b.show();
  b.guard.leave();
  assert.deepEqual([d.boot().last.failed, d.events.length], [false, 0]);
  d = device(iphone);
  b = d.boot();
  b.dieLoading(); // (as far as the compile...)
  b.guard.leave(); // ...and the visitor gives up: pagehide
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.reason, b.last.fails, b.tier], [false, 'left', 0, 'medium']);
  // an abandoned recovery boot keeps what was learnt before it: still a tier lower, and no second event
  d = device(iphone);
  d.boot().dieLoading();
  b = d.boot();
  b.dieLoading();
  b.guard.leave();
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.fails, b.last.failedTier, b.tier, d.events.length], [false, 1, 'medium', 'low', 1]);
  // in the background when it died (the tab switcher, another app, the phone locked): the browser's doing
  d = device(iphone);
  b = d.boot();
  b.show();
  b.guard.hidden(true);
  b = d.boot();
  assert.deepEqual([b.last.failed, b.last.reason, b.tier], [false, 'hidden', 'medium']);
  // ...but back in view and then dead is a death
  b.show();
  b.guard.hidden(true);
  b.guard.hidden(false);
  assert.equal(d.boot().last.failed, true);
  // the back/forward cache: pagehide as the page is put away, alive again when it comes back, dead if it then dies
  d = device(iphone);
  b = d.boot();
  b.show();
  b.guard.leave();
  assert.equal(d.local.getItem(G.RUN_KEY), null);
  b.guard.resume();
  assert.equal(JSON.parse(d.local.getItem(G.RUN_KEY)).live, true);
  assert.equal(d.boot().last.failed, true);
  // a desktop with the city in two windows: the second does not take the first for dead
  d = device(desktop);
  b = d.boot();
  b.show();
  const second = G.createCrashGuard({ storage: d.local, session: storage(), mobile: false, now: () => d.time + 1000 });
  assert.deepEqual([second.previous.failed, second.previous.reason], [false, 'other-tab']);
  // a note that is not this code's, or storage that throws: a first visit
  for (const junk of ['{', '[]', '"x"', '{"live":true}']) {
    const g = G.createCrashGuard({ storage: storage({ [G.RUN_KEY]: junk }), session: storage(), mobile: true, now: () => 5 * G.WINDOW_MS });
    assert.equal(g.previous.failed, false, junk);
  }
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  const g = G.createCrashGuard({ storage: broken, session: broken, mobile: true });
  assert.equal(g.previous.failed, false);
  g.begin({ tier: 'medium' });
  g.stage('compile');
  g.shown();
  g.leave();
  // the heartbeat is not written more often than BEAT_MS
  d = device(iphone);
  b = d.boot();
  b.show();
  const before = d.local.getItem(G.RUN_KEY);
  b.guard.beat({ tier: 'low' });
  assert.equal(d.local.getItem(G.RUN_KEY), before);
  d.time += G.BEAT_MS;
  b.guard.beat({ tier: 'low' });
  assert.equal(JSON.parse(d.local.getItem(G.RUN_KEY)).tier, 'low');
});

test('main.js wires the guard in: before the tier is decided, at every step, and on the clean ways out', () => {
  const main = fs.readFileSync(`${root}js/donostia/main.js`, 'utf8');
  assert.match(main, /from '\.\/crash-guard\.js'/);
  const at = (text) => { const i = main.indexOf(text); assert.ok(i > 0, text); return i; };
  assert.ok(at('createCrashGuard({') < at('if (lastVisit.halt)') && at('if (lastVisit.halt)') < at('quality.init({') && at('quality.init({') < at('guard.begin({'), 'read, halt, decide, begin');
  assert.ok(at('guard.begin({') < at('new THREE.WebGPURenderer('), 'the note is there before anything heavy is made');
  assert.match(main, /recovery: lastVisit\.fails > 0 \? \{ failedTier: lastVisit\.failedTier, fails: lastVisit\.fails, dropPick: lastVisit\.dropPick \} : null/);
  assert.match(main, /addEventListener\('pagehide', \(\) => guard\.leave\(\)\)/);
  assert.match(main, /addEventListener\('pageshow', \(e\) => \{ if \(e\.persisted\) guard\.resume\(\); \}\)/);
  assert.match(main, /addEventListener\('visibilitychange', \(\) => guard\.hidden\(document\.visibilityState === 'hidden'\)\)/);
  for (const call of ['guard.stage(label)', 'guard.shown()', 'guard.beat({ tier: quality.get().tier, realTime: live.liveEnabled() })', 'guard.retry()']) assert.ok(main.includes(call), call);
  // the message and its button, and the line on the loading screen, in the three languages
  const i18n = fs.readFileSync(`${root}js/donostia/i18n.js`, 'utf8');
  const english = /halt\('(This device ran out of memory[^']+)', 'memory'\)/.exec(main)?.[1];
  assert.ok(english && i18n.includes(`'status.memory': '${english}'`), "main.js's line is the one i18n.js knows");
  for (const key of ['status.memory', 'loading.retry', 'recovery.lowered', 'recovery.again']) assert.equal(i18n.split(`'${key}':`).length, 4, `${key} in en, eu and es`);
  assert.match(fs.readFileSync(`${root}index.html`, 'utf8'), /<div id="loading-recovery" hidden><\/div>/);
});
