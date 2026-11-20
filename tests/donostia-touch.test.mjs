import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The god camera's touch input (js/donostia/touch.js): the stick's response, its trailing centre, the two-finger
// gesture and the taps as arithmetic, then the stick & buttons wired to a fake page: pointers captured, held and let
// go one by one, the fast gear's latch, and a browser bar that slides away mid-flight.

const root = fileURLToPath(new URL('../', import.meta.url));
const { STICK, stickResponse, trailOrigin, TwoFingerGesture, TapTracker, initTouchControls } =
  await import(pathToFileURL(`${root}js/donostia/touch.js`).href);

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

test('two fingers: a pinch does not slide, a drag does not creep forward', () => {
  const g = new TwoFingerGesture();
  const sum = (moves) => moves.reduce((s, m) => ({ spread: s.spread + m.spread, pan: s.pan + Math.hypot(m.panX, m.panY) }), { spread: 0, pan: 0 });

  // set down and held: nothing
  g.start({ x: 100, y: 300 }, { x: 200, y: 300 });
  assert.deepEqual(g.move({ x: 101, y: 300 }, { x: 199, y: 301 }), { spread: 0, panX: 0, panY: 0 });

  // a pinch whose midpoint wanders a few px
  g.start({ x: 100, y: 300 }, { x: 200, y: 300 });
  const pinch = [];
  for (let i = 1; i <= 20; i++) pinch.push(g.move({ x: 100 - 4 * i, y: 300 + i * 0.4 }, { x: 200 + 4 * i, y: 300 + i * 0.4 }));
  const p = sum(pinch);
  assert.ok(p.spread > 140, `the spread comes through: ${p.spread}`);
  assert.equal(p.pan, 0, 'the midpoint drifting 8 px does not pan');

  // a drag whose spread wobbles
  g.start({ x: 100, y: 300 }, { x: 200, y: 300 });
  const drag = [];
  for (let i = 1; i <= 20; i++) drag.push(g.move({ x: 100 + 6 * i, y: 300 }, { x: 200 + 6 * i + Math.sin(i) * 5, y: 300 }));
  const d = sum(drag);
  assert.ok(d.pan > 100, `the drag comes through: ${d.pan}`);
  assert.equal(d.spread, 0, 'a wobble of the spread does not fly');

  // both at once, in earnest, are both answered
  g.start({ x: 100, y: 300 }, { x: 200, y: 300 });
  const both = [];
  for (let i = 1; i <= 20; i++) both.push(g.move({ x: 100 + 2 * i, y: 300 }, { x: 200 + 8 * i, y: 300 }));
  const b = sum(both);
  assert.ok(b.spread > 60 && b.pan > 60);

  g.end();
  assert.deepEqual(g.move({ x: 0, y: 0 }, { x: 500, y: 500 }), { spread: 0, panX: 0, panY: 0 }, 'a new pair starts from rest');
});

test('taps: a tap, a double tap, and what is neither', () => {
  const t = new TapTracker();
  t.down(100, 100, 0);
  t.move(103, 102);
  assert.equal(t.dragging, false, 'within the slop the finger is not dragging');
  assert.equal(t.up(103, 102, 90), 'tap');
  t.down(110, 96, 200);
  assert.equal(t.up(110, 96, 260), 'double');
  // a third tap starts over
  t.down(110, 96, 400);
  assert.equal(t.up(110, 96, 450), 'tap');
  // too late, or too far, for a double
  t.down(110, 96, 1200);
  assert.equal(t.up(110, 96, 1250), 'tap');
  t.down(300, 300, 1400);
  assert.equal(t.up(300, 300, 1450), 'tap');
  // a drag and a long press are no taps, and forget the tap before them
  t.down(300, 300, 1500);
  t.move(330, 300);
  assert.equal(t.dragging, true);
  assert.equal(t.up(330, 300, 1560), null);
  t.down(330, 300, 1600);
  assert.equal(t.up(330, 300, 1650), 'tap');
  t.down(330, 300, 1700);
  assert.equal(t.up(330, 300, 2400), null, 'held too long');
  // a second finger cancels
  t.down(10, 10, 3000);
  t.cancel();
  assert.equal(t.up(10, 10, 3050), null);
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
  const rootEl = element(), stick = element(), knob = element(), fly = element();
  const buttons = Object.fromEntries(['up', 'down', 'boost'].map((a) => [a, element({ touchAction: a })]));
  rootEl.querySelectorAll = () => Object.values(buttons);
  const doc = Object.assign(element(), {
    body: element(), hidden: false,
    getElementById: (id) => ({ 'touch-controls': rootEl, 'touch-stick': stick, 'touch-stick-knob': knob, 'btn-fly': fly })[id]
  });
  const store = new Map(stored === null ? [] : [['donostia-touch-fly', stored]]);
  globalThis.window = win;
  globalThis.document = doc;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const god = {
    touch: { forward: 0, side: 0, up: 0, boost: 0 },
    clearTouch() { Object.assign(this.touch, { forward: 0, side: 0, up: 0, boost: 0 }); }
  };
  const changes = [];
  const controls = initTouchControls(god, { onChange: (a) => changes.push(a) });
  return { win, doc, media, rootEl, stick, knob, fly, buttons, god, controls, store, changes };
}

test('the stick is off until Hegan turns it on, and the choice is remembered', () => {
  const p = page();
  assert.equal(p.doc.body.classList.contains('touch-enabled'), true);
  assert.equal(p.doc.body.classList.contains('touch-fly'), false);
  assert.equal(p.rootEl.hidden, true, 'a first visit has no stick over the city');
  p.stick.dispatch('pointerdown');
  p.stick.dispatch('pointermove', { clientY: 20 });
  assert.equal(p.god.touch.forward, 0, 'a hidden stick takes no input');

  p.fly.dispatch('click');
  assert.equal(p.rootEl.hidden, false);
  assert.equal(p.doc.body.classList.contains('touch-fly'), true);
  assert.equal(p.fly.attrs['aria-pressed'], 'true');
  assert.equal(p.store.get('donostia-touch-fly'), '1');
  assert.equal(p.controls.flying, true);

  const again = page({ stored: '1' });
  assert.equal(again.rootEl.hidden, false, 'remembered');
  // a mouse-only desktop has no touch layout whatever was stored
  const desk = page({ coarse: false, stored: '1' });
  assert.equal(desk.rootEl.hidden, true);
  assert.equal(desk.doc.body.classList.contains('touch-enabled'), false);
  assert.equal(desk.controls.flying, false);
  // until its first touch (a hybrid)
  desk.doc.dispatch('pointerdown', { pointerType: 'touch' });
  assert.equal(desk.rootEl.hidden, false);
  assert.deepEqual(desk.changes, [true]);
});

test('the stick is relative, captured, and independent of the other fingers', () => {
  const p = page({ stored: '1' });
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

test('climb and descend are held; the fast gear is a latch', () => {
  const p = page({ stored: '1' });
  p.buttons.up.dispatch('pointerdown', { pointerId: 1 });
  p.buttons.down.dispatch('pointerdown', { pointerId: 2 });
  assert.equal(p.god.touch.up, 0, 'both held cancel out');
  p.buttons.up.dispatch('pointercancel', { pointerId: 1 });
  assert.equal(p.god.touch.up, -1);
  p.buttons.down.dispatch('pointerup', { pointerId: 2 });
  assert.equal(p.god.touch.up, 0);

  p.buttons.boost.dispatch('pointerdown', { pointerId: 4 });
  p.buttons.boost.dispatch('pointerup', { pointerId: 4 });
  p.buttons.boost.dispatch('click', { detail: 1 }); // (the click a touch also sends: not a second toggle)
  assert.equal(p.god.touch.boost, 1, 'latched after the finger lifts');
  assert.equal(p.buttons.boost.attrs['aria-pressed'], 'true');
  // the stick's own fast gear does not undo the latch
  p.stick.dispatch('pointerdown', { pointerId: 5 });
  p.stick.dispatch('pointerup', { pointerId: 5 });
  assert.equal(p.god.touch.boost, 1);
  // a keyboard's click (detail 0) switches it too
  p.buttons.boost.dispatch('click', { detail: 0 });
  assert.equal(p.god.touch.boost, 0);
  assert.equal(p.buttons.boost.attrs['aria-pressed'], 'false');
});

test('a browser bar sliding away keeps the stick; turning the phone, the full map and Hegan off let go', () => {
  const p = page({ stored: '1' });
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

  p.buttons.boost.dispatch('pointerdown', { pointerId: 3 });
  p.buttons.boost.dispatch('pointerup', { pointerId: 3 });
  push();
  p.fly.dispatch('click');
  assert.deepEqual(p.god.touch, { forward: 0, side: 0, up: 0, boost: 0 }, 'the stick switched off: at rest, the latch too');
  assert.equal(p.rootEl.hidden, true);
  assert.equal(p.store.get('donostia-touch-fly'), '0');
});
