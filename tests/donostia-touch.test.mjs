import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The god camera's touch input (js/donostia/touch.js): the stick's response and its trailing centre as arithmetic,
// then the stick & buttons wired to a fake page: always there on a touch screen, pointers captured, held and let go
// one by one, the fast gear that is the stick's alone, and a browser bar that slides away mid-flight.

const root = fileURLToPath(new URL('../', import.meta.url));
const touchModule = await import(pathToFileURL(`${root}js/donostia/touch.js`).href);
const { STICK, stickResponse, trailOrigin, initTouchControls } = touchModule;

test('the stick rests in its dead zone, eases in, and is flat out at the rim', () => {
  assert.deepEqual(stickResponse(0, 0), { x: 0, y: 0, reach: 0, strength: 0, boost: 0 });
  assert.equal(stickResponse(3, -3).strength, 0, 'a resting thumb does not drift');
  const half = stickResponse(0, -STICK.radius / 2);
  assert.ok(half.strength > 0.2 && half.strength < 0.5, `half way is well under half speed: ${half.strength}`);
  assert.equal(half.y, -1);
  const rim = stickResponse(STICK.radius, 0);
  assert.equal(rim.strength, 1);
  assert.equal(rim.boost, 0);
  assert.equal(rim.x, 1);
  // monotonic all the way out
  let last = 0;
  for (let d = 0; d <= STICK.radius; d += 2) {
    const s = stickResponse(d, 0).strength;
    assert.ok(s >= last);
    last = s;
  }
});

test('past the rim the stick shifts into the fast gear by degrees', () => {
  const r = STICK.radius;
  assert.equal(stickResponse(0, -r * (1 + STICK.overdrive / 2)).boost.toFixed(3), '0.500');
  const far = stickResponse(0, -r * 5);
  assert.equal(far.boost, 1);
  assert.equal(far.strength, 1);
  assert.equal(far.reach, 1, 'the knob stays on the rim');
});

test('the centre trails a thumb that runs past the fast gear, so turning back answers', () => {
  const r = STICK.radius, max = r * (1 + STICK.overdrive);
  const origin = { x: 100, y: 500 };
  assert.equal(trailOrigin(origin, { x: 100, y: 500 - max }), origin, 'within reach it stays put');
  const trailed = trailOrigin(origin, { x: 100, y: 200 });
  assert.ok(Math.abs(trailed.y - (200 + max)) < 1e-9 && trailed.x === 100);
  // back by the gear's length and a radius: flying the other way
  const back = stickResponse(0, 200 + max + r - trailed.y);
  assert.equal(back.y, 1);
  assert.equal(back.strength, 1);
});

test('the stick and a drag on the view are the whole scheme: no other gesture is left', async () => {
  const { readFile } = await import('node:fs/promises');
  assert.deepEqual(Object.keys(touchModule).sort(), ['STICK', 'initTouchControls', 'stickResponse', 'trailOrigin']);
  const camera = await readFile(`${root}js/donostia/god-camera.js`, 'utf8');
  for (const gone of ['TwoFingerGesture', 'TapTracker', '_pinch', '_pan', 'flyToward']) assert.ok(!camera.includes(gone), `god-camera.js still has ${gone}`);
  const html = await readFile(`${root}index.html`, 'utf8');
  for (const gone of ['btn-fly', 'touch-hint']) assert.ok(!html.includes(gone), `index.html still has #${gone}`);
});

// --- the stick & buttons on a fake page ------------------------------------------------------------------------------

function element(dataset = {}) {
  const listeners = new Map(), classes = new Set(), captures = new Set(), attrs = {}, styles = new Map();
  return {
    hidden: false, dataset, attrs,
    classList: {
      add: (...n) => n.forEach((c) => classes.add(c)),
      remove: (...n) => n.forEach((c) => classes.delete(c)),
      contains: (n) => classes.has(n),
      toggle(n, force) { if (force ?? !classes.has(n)) classes.add(n); else classes.delete(n); }
    },
    style: { setProperty: (k, v) => styles.set(k, v), getPropertyValue: (k) => styles.get(k) },
    setAttribute: (k, v) => { attrs[k] = v; },
    getAttribute: (k) => attrs[k],
    addEventListener(type, fn) { (listeners.get(type) ?? listeners.set(type, []).get(type)).push(fn); },
    dispatch(type, init = {}) {
      const e = { type, pointerId: 1, pointerType: 'touch', button: 0, detail: 1, clientX: 66, clientY: 66, preventDefault() {}, stopPropagation() {}, ...init };
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 132, height: 132 }),
    setPointerCapture: (id) => captures.add(id),
    hasPointerCapture: (id) => captures.has(id),
    releasePointerCapture(id) { if (captures.delete(id)) this.dispatch('lostpointercapture', { pointerId: id }); },
    querySelectorAll: () => []
  };
}

function page({ coarse = true, stored = null } = {}) {
  const win = Object.assign(element(), { innerWidth: 390, innerHeight: 844 });
  const media = Object.assign(element(), { matches: coarse });
  win.matchMedia = () => media;
  const rootEl = element(), stick = element(), knob = element();
  const buttons = Object.fromEntries(['up', 'down'].map((a) => [a, element({ touchAction: a })]));
  rootEl.querySelectorAll = () => Object.values(buttons);
  const doc = Object.assign(element(), {
    body: element(), hidden: false,
    getElementById: (id) => ({ 'touch-controls': rootEl, 'touch-stick': stick, 'touch-stick-knob': knob })[id]
  });
  const store = new Map(stored === null ? [] : [['donostia-touch-fly', stored]]);
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  const god = {
    touch: { forward: 0, side: 0, up: 0, boost: 0 },
    clearTouch() { Object.assign(this.touch, { forward: 0, side: 0, up: 0, boost: 0 }); }
  };
  const changes = [];
  const controls = initTouchControls(god, { onChange: (a) => changes.push(a) });
  return { win, doc, media, rootEl, stick, knob, buttons, god, controls, store, changes };
}

test('the stick is always there on a touch screen, with nothing to turn on and nothing stored', () => {
  const p = page();
  assert.equal(p.doc.body.classList.contains('touch-enabled'), true);
  assert.equal(p.rootEl.hidden, false, 'a first visit has the stick');
  assert.equal(p.controls.available, true);
  p.stick.dispatch('pointerdown');
  p.stick.dispatch('pointermove', { clientY: 66 - STICK.radius });
  assert.equal(p.god.touch.forward, 1);
  assert.equal(p.store.size, 0, 'nothing is remembered');

  // the switch an earlier version stored is cleared, whatever it said
  for (const stored of ['0', '1']) {
    const old = page({ stored });
    assert.equal(old.rootEl.hidden, false);
    assert.equal(old.store.has('donostia-touch-fly'), false);
  }
  // a mouse-only desktop has no touch layout
  const desk = page({ coarse: false });
  assert.equal(desk.rootEl.hidden, true);
  assert.equal(desk.doc.body.classList.contains('touch-enabled'), false);
  assert.equal(desk.controls.available, false);
  desk.stick.dispatch('pointerdown');
  desk.stick.dispatch('pointermove', { clientY: 20 });
  assert.equal(desk.god.touch.forward, 0, 'a hidden stick takes no input');
  // until its first touch (a hybrid)
  desk.doc.dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(desk.rootEl.hidden, false);
  assert.equal(desk.doc.body.classList.contains('touch-enabled'), true);
  assert.deepEqual(desk.changes, [true]);
});

test('the stick is relative, captured, and independent of the other fingers', () => {
  const p = page();
  // the thumb lands off-centre: neutral
  p.stick.dispatch('pointerdown', { pointerId: 7, clientX: 90, clientY: 100 });
  assert.equal(p.god.touch.forward, 0);
  assert.equal(p.stick.hasPointerCapture(7), true);
  // up by the radius: flat out forward; the knob is on the rim
  p.stick.dispatch('pointermove', { pointerId: 7, clientX: 90, clientY: 100 - STICK.radius });
  assert.equal(p.god.touch.forward, 1);
  assert.equal(p.god.touch.side, 0);
  assert.equal(p.knob.style.getPropertyValue('--stick-y'), `${-STICK.radius}px`);
  // far off the pad: still held, in the fast gear
  p.stick.dispatch('pointermove', { pointerId: 7, clientX: 90, clientY: -400 });
  assert.equal(p.god.touch.forward, 1);
  assert.ok(p.god.touch.boost > 0.999);
  assert.equal(p.stick.classList.contains('is-fast'), true);
  // another finger's moves and lifts on the stick's element are not the stick's
  p.stick.dispatch('pointermove', { pointerId: 8, clientX: 0, clientY: 900 });
  p.stick.dispatch('pointerup', { pointerId: 8 });
  assert.equal(p.god.touch.forward, 1);
  // a second finger cannot take the stick over
  p.stick.dispatch('pointerdown', { pointerId: 9, clientX: 10, clientY: 10 });
  assert.equal(p.stick.hasPointerCapture(9), false);
  // climbing with a third finger, slid off its button, while the stick flies
  p.buttons.up.dispatch('pointerdown', { pointerId: 3 });
  assert.equal(p.god.touch.up, 1);
  assert.equal(p.buttons.up.attrs['aria-pressed'], 'true');
  p.buttons.up.dispatch('pointerup', { pointerId: 3 });
  assert.equal(p.god.touch.up, 0);
  assert.equal(p.god.touch.forward, 1, 'lifting the climb finger leaves the stick');
  // the stick lifted: everything of it at rest
  p.stick.dispatch('pointerup', { pointerId: 7 });
  assert.deepEqual(p.god.touch, { forward: 0, side: 0, up: 0, boost: 0 });
  assert.equal(p.knob.style.getPropertyValue('--stick-y'), '0px');
  assert.equal(p.stick.classList.contains('is-pressed'), false);
});

test('climb and descend are held; the fast gear is the stick past its rim, with no button and no latch', async () => {
  const p = page();
  p.buttons.up.dispatch('pointerdown', { pointerId: 1 });
  p.buttons.down.dispatch('pointerdown', { pointerId: 2 });
  assert.equal(p.god.touch.up, 0, 'both held cancel out');
  p.buttons.up.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(p.god.touch.up, -1);
  p.buttons.down.dispatch('pointerup', { pointerId: 2 });
  assert.equal(p.god.touch.up, 0);

  // the fast gear follows the stick: in by degrees past the rim, out again as the thumb comes back or lifts
  p.stick.dispatch('pointerdown', { pointerId: 5, clientX: 66, clientY: 66 });
  p.stick.dispatch('pointermove', { pointerId: 5, clientX: 66, clientY: 66 - STICK.radius * (1 + STICK.overdrive / 2) });
  assert.equal(p.god.touch.boost.toFixed(3), '0.500');
  p.buttons.up.dispatch('pointerdown', { pointerId: 6 });
  assert.equal(p.god.touch.boost.toFixed(3), '0.500', 'a button pressed meanwhile leaves the gear as the stick has it');
  p.buttons.up.dispatch('pointerup', { pointerId: 6 });
  p.stick.dispatch('pointermove', { pointerId: 5, clientX: 66, clientY: 66 - STICK.radius });
  assert.equal(p.god.touch.boost, 0, 'back at the rim: the normal gear');
  p.stick.dispatch('pointermove', { pointerId: 5, clientX: 66, clientY: -400 });
  assert.equal(p.god.touch.boost, 1);
  p.stick.dispatch('pointerup', { pointerId: 5 });
  assert.equal(p.god.touch.boost, 0, 'nothing stays latched');

  // the page has the two buttons and no third
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(`${root}index.html`, 'utf8');
  assert.deepEqual([...html.matchAll(/data-touch-action="(\w+)"/g)].map((m) => m[1]), ['up', 'down']);
  const sources = html + await readFile(`${root}js/donostia/touch.js`, 'utf8') + await readFile(`${root}css/donostia.css`, 'utf8') + await readFile(`${root}js/donostia/i18n.js`, 'utf8');
  for (const gone of ['touch-boost', 'fastGear', 'touch.fast', "'boost'"]) assert.ok(!sources.includes(gone), `${gone} is still there`);
});

test('a browser bar sliding away keeps the stick; turning the phone and the full map let go', () => {
  const p = page();
  const push = () => {
    p.stick.dispatch('pointerdown', { pointerId: 1, clientX: 66, clientY: 66 });
    p.stick.dispatch('pointermove', { pointerId: 1, clientX: 66, clientY: 0 });
    assert.equal(p.god.touch.forward, 1);
  };
  push();
  p.win.innerHeight = 780; // (the height only)
  p.win.dispatch('resize');
  assert.equal(p.god.touch.forward, 1, 'mid-flight, the bar hides: still flying');
  p.win.innerWidth = 844;
  p.win.innerHeight = 390;
  p.win.dispatch('resize');
  assert.equal(p.god.touch.forward, 0, 'turned: let go');
  assert.equal(p.stick.hasPointerCapture(1), false);

  push();
  p.controls.setEnabled(false); // (the full map opens)
  assert.equal(p.god.touch.forward, 0);
  assert.equal(p.rootEl.hidden, true);
  p.stick.dispatch('pointerdown', { pointerId: 2 });
  assert.equal(p.stick.hasPointerCapture(2), false, 'no input while the map covers the view');
  p.controls.setEnabled(true);
  assert.equal(p.rootEl.hidden, false);

  // letting go of everything leaves nothing on, the fast gear neither
  p.stick.dispatch('pointerdown', { pointerId: 3, clientX: 66, clientY: 66 });
  p.stick.dispatch('pointermove', { pointerId: 3, clientX: 66, clientY: -400 });
  assert.equal(p.god.touch.boost, 1);
  p.controls.reset();
  assert.deepEqual(p.god.touch, { forward: 0, side: 0, up: 0, boost: 0 });
});
