// js/donostia/touch.js
// Touch input for the god camera (js/donostia/god-camera.js), in two layers.
//
// The view itself always answers the fingers, with nothing drawn over the city: one finger looks around, two fingers
// move the camera (a pinch flies along the view, a two-finger drag slides it sideways and up or down, the way a map
// pans) and a double tap flies to the place tapped. That is the whole scheme a first-time visitor needs, with the
// fly-to list for the long hops.
//
// The flight stick is the second layer, for those who want to fly: off until the toolbar's Hegan button turns it on
// (remembered per browser). The left thumb flies forward / back and sideways on the stick, the right thumb looks on
// the view, and three buttons climb, descend and latch the fast gear. The stick is relative: wherever the thumb lands
// on the pad is neutral and the push from there is the input, so it needs no aim; pushed past its rim it shifts
// smoothly into the fast gear, and pushed further still its centre trails the thumb, so turning back answers at once.
// Every control captures its pointer: a finger that slides off its control keeps it until it lifts, and a second or
// third finger never disturbs the first.
//
// The arithmetic (stickResponse, trailOrigin, TwoFingerGesture, TapTracker) is free of the DOM and is tested in
// tests/donostia-touch.test.mjs. initTouchControls(god, { onChange }) -> { setEnabled(on), reset(), available, flying }
// wires the stick & buttons, shows them on coarse pointers (or after the first touch on hybrid devices) and sets
// body.touch-enabled / body.touch-fly for the touch layout (css/donostia.css).

export const STICK = {
  radius: 48, // px from neutral to the rim: full speed
  deadZone: 0.12, // of the radius: a resting thumb doesn't drift
  curve: 1.6, // response exponent: fine control near the centre, full speed only at the rim
  overdrive: 0.6 // of the radius past the rim: the fast gear, 0 at the rim to 1 at its end
};
const FLY_KEY = 'donostia-touch-fly'; // localStorage: '1' while the flight stick is on

/**
 * The stick's answer to a thumb `dx`, `dy` px from where it landed: `x`, `y` the direction (screen axes, unit length
 * or zero), `reach` how far the knob is drawn (0..1 of the radius), `strength` the speed asked for (0..1) and `boost`
 * the fast gear (0..1, past the rim).
 */
export function stickResponse(dx, dy, radius = STICK.radius) {
  const dist = Math.hypot(dx, dy);
  if (!dist || !(radius > 0)) return { x: 0, y: 0, reach: 0, strength: 0, boost: 0 };
  const raw = dist / radius;
  const reach = Math.min(raw, 1);
  const live = Math.max(0, (reach - STICK.deadZone) / (1 - STICK.deadZone));
  return {
    x: dx / dist, y: dy / dist, reach,
    strength: Math.pow(live, STICK.curve),
    boost: Math.min(1, Math.max(0, (raw - 1) / STICK.overdrive))
  };
}

/** Where the stick's neutral point goes as the thumb at `point` runs past the fast gear's end: it trails the thumb. */
export function trailOrigin(origin, point, radius = STICK.radius) {
  const dx = point.x - origin.x, dy = point.y - origin.y;
  const dist = Math.hypot(dx, dy), max = radius * (1 + STICK.overdrive);
  if (dist <= max) return origin;
  const k = (dist - max) / dist;
  return { x: origin.x + dx * k, y: origin.y + dy * k };
}

/**
 * Two fingers on the view: `move(a, b)` answers how far (px) their spread grew and their midpoint travelled since the
 * last call. Each waits for its own slop, so two fingers set down don't move the camera, and whichever starts first
 * makes the other wait three times as long: a pan doesn't creep forward, a pinch doesn't slide sideways.
 */
export class TwoFingerGesture {
  constructor(slop = 8) {
    this.slop = slop;
    this.last = null;
  }

  start(a, b) {
    this.last = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    this.spread = 0;
    this.pan = 0;
    this.pinching = this.panning = false;
  }

  end() {
    this.last = null;
  }

  move(a, b) {
    if (!this.last) { this.start(a, b); return { spread: 0, panX: 0, panY: 0 }; }
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const out = { spread: d - this.last.d, panX: mx - this.last.mx, panY: my - this.last.my };
    this.last = { d, mx, my };
    this.spread += out.spread;
    this.pan += Math.hypot(out.panX, out.panY);
    if (!this.pinching && Math.abs(this.spread) > this.slop * (this.panning ? 3 : 1)) this.pinching = true;
    if (!this.panning && this.pan > this.slop * (this.pinching ? 3 : 1)) this.panning = true;
    if (!this.pinching) out.spread = 0;
    if (!this.panning) out.panX = out.panY = 0;
    return out;
  }
}

/**
 * Taps on the view: a touch that lifts within `time` ms without leaving its `slop` is a tap, and a second one close
 * to the first, soon after, a double tap. `up()` answers 'tap', 'double' or null; `dragging` says the finger has left
 * its slop (the look only starts then, so a tap doesn't nudge the view).
 */
export class TapTracker {
  constructor({ slop = 8, time = 280, gap = 320, reach = 36 } = {}) {
    Object.assign(this, { slop, time, gap, reach });
    this.press = null;
    this.lastTap = null;
  }

  down(x, y, t) {
    this.press = { x, y, t, moved: false };
  }

  move(x, y) {
    const p = this.press;
    if (p && !p.moved && Math.hypot(x - p.x, y - p.y) > this.slop) p.moved = true;
  }

  get dragging() {
    return Boolean(this.press?.moved);
  }

  // a second finger, a cancel: whatever was pressed is no tap
  cancel() {
    this.press = null;
    this.lastTap = null;
  }

  up(x, y, t) {
    const p = this.press;
    this.press = null;
    if (!p || p.moved || t - p.t > this.time) { this.lastTap = null; return null; }
    const last = this.lastTap;
    if (last && t - last.t <= this.gap && Math.hypot(x - last.x, y - last.y) <= this.reach) {
      this.lastTap = null;
      return 'double';
    }
    this.lastTap = { x, y, t };
    return 'tap';
  }
}

export function initTouchControls(god, { onChange } = {}) {
  const root = document.getElementById('touch-controls');
  const stick = document.getElementById('touch-stick');
  const knob = document.getElementById('touch-stick-knob');
  const flyButton = document.getElementById('btn-fly');
  const none = { setEnabled() {}, reset() {}, available: false, flying: false };
  if (!root || !stick || !knob) return none;
  const buttons = [...root.querySelectorAll('[data-touch-action]')];
  const held = new Map(); // pointerId -> { button, action }
  const media = window.matchMedia('(any-pointer: coarse)');
  let stickPointer = null, origin = null, radius = STICK.radius, overdrive = 0;
  let enabled = true, available = false, touchSeen = false, flying = false, fastGear = false;
  try { flying = localStorage.getItem(FLY_KEY) === '1'; } catch { /* storage unavailable */ }

  const canInteract = () => enabled && available && flying && !document.hidden;
  const releaseCapture = (el, id) => { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); };
  // the fast gear: latched by its button, or as far in as the stick is pushed past its rim
  const applyBoost = () => { god.touch.boost = Math.max(fastGear ? 1 : 0, overdrive); };

  const moveStick = (e) => {
    const point = { x: e.clientX, y: e.clientY };
    origin = trailOrigin(origin, point, radius);
    const r = stickResponse(point.x - origin.x, point.y - origin.y, radius);
    knob.style.setProperty('--stick-x', `${r.x * r.reach * radius}px`);
    knob.style.setProperty('--stick-y', `${r.y * r.reach * radius}px`);
    stick.classList.toggle('is-fast', r.boost > 0);
    god.touch.forward = -r.y * r.strength || 0; // (never -0)
    god.touch.side = r.x * r.strength;
    overdrive = r.boost;
    applyBoost();
  };
  const releaseStick = (id) => {
    if (stickPointer === null || id !== stickPointer) return;
    stickPointer = null;
    releaseCapture(stick, id);
    stick.classList.remove('is-pressed', 'is-fast');
    knob.style.setProperty('--stick-x', '0px');
    knob.style.setProperty('--stick-y', '0px');
    god.touch.forward = god.touch.side = 0;
    overdrive = 0;
    applyBoost();
  };
  const applyButtons = () => {
    const actions = new Set([...held.values()].map((h) => h.action));
    god.touch.up = (actions.has('up') ? 1 : 0) - (actions.has('down') ? 1 : 0);
    applyBoost();
    for (const b of buttons) {
      const pressed = b.dataset.touchAction === 'boost' ? fastGear : [...held.values()].some((h) => h.button === b);
      b.classList.toggle('is-pressed', pressed);
      b.setAttribute('aria-pressed', String(pressed));
    }
  };
  const releaseButton = (id) => {
    const h = held.get(id);
    if (!h) return;
    held.delete(id);
    releaseCapture(h.button, id);
    applyButtons();
  };
  // lets go of everything held (the fast gear stays latched: it is a setting, not a press)
  const reset = () => {
    releaseStick(stickPointer);
    for (const id of [...held.keys()]) releaseButton(id);
    god.clearTouch();
    applyButtons();
  };

  stick.addEventListener('pointerdown', (e) => {
    if (!canInteract() || e.button !== 0 || stickPointer !== null || held.has(e.pointerId)) return;
    e.preventDefault();
    e.stopPropagation();
    // (the pad is larger than the ring drawn in it, css/donostia.css: the thumb finds it without looking)
    const rect = stick.getBoundingClientRect();
    radius = Math.min(STICK.radius, Math.min(rect.width, rect.height) / 2) || STICK.radius;
    origin = { x: e.clientX, y: e.clientY };
    stickPointer = e.pointerId;
    stick.setPointerCapture(e.pointerId);
    stick.classList.add('is-pressed');
    moveStick(e);
  });
  stick.addEventListener('pointermove', (e) => {
    if (e.pointerId !== stickPointer) return;
    e.preventDefault();
    moveStick(e);
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    stick.addEventListener(type, (e) => releaseStick(e.pointerId));
  }
  for (const button of buttons) {
    const action = button.dataset.touchAction;
    button.addEventListener('pointerdown', (e) => {
      if (!canInteract() || e.button !== 0 || held.has(e.pointerId) || e.pointerId === stickPointer) return;
      e.preventDefault();
      e.stopPropagation();
      // climbing and descending are held; the fast gear is a latch (holding it would take the looking thumb away)
      if (action === 'boost') fastGear = !fastGear;
      held.set(e.pointerId, { button, action });
      button.setPointerCapture(e.pointerId);
      applyButtons();
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      button.addEventListener(type, (e) => releaseButton(e.pointerId));
    }
    // (a keyboard or a switch presses the latch too; the held buttons have the keys E & Q)
    if (action === 'boost') {
      button.addEventListener('click', (e) => {
        if (e.detail !== 0 || !canInteract()) return; // (pointer presses were handled above)
        fastGear = !fastGear;
        applyButtons();
      });
    }
    // a long press must not open the context menu or select the label
    button.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  stick.addEventListener('contextmenu', (e) => e.preventDefault());

  const show = () => {
    const on = available && flying;
    document.body.classList.toggle('touch-enabled', available);
    document.body.classList.toggle('touch-fly', on);
    root.hidden = !enabled || !on;
    flyButton?.setAttribute('aria-pressed', String(on));
  };
  const updateAvailability = () => {
    const now = media.matches || touchSeen;
    const changed = now !== available;
    if (changed) reset();
    available = now;
    show();
    if (changed) onChange?.(available);
  };
  flyButton?.addEventListener('click', () => {
    flying = !flying;
    try { localStorage.setItem(FLY_KEY, flying ? '1' : '0'); } catch { /* storage unavailable */ }
    if (!flying) { fastGear = false; reset(); }
    show();
    onChange?.(available);
  });
  media.addEventListener('change', updateAvailability);
  // hybrid devices can report a fine pointer until their first touch; capture runs before the controls' handlers
  document.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || touchSeen) return;
    touchSeen = true;
    updateAvailability();
  }, { capture: true, passive: true });
  window.addEventListener('blur', reset);
  // Turning the phone moves the controls from under the thumbs: let go. A browser bar sliding away mid-flight only
  // changes the height, and must not drop the stick.
  let width = window.innerWidth;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    reset();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(); });
  updateAvailability();

  return {
    setEnabled(on) {
      enabled = Boolean(on);
      if (!enabled) reset();
      show();
    },
    reset,
    get available() { return available; },
    get flying() { return available && flying; }
  };
}
