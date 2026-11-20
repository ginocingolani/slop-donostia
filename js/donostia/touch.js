// js/donostia/touch.js
// Touch input for the god camera (js/donostia/god-camera.js). The whole scheme is two thumbs: the left one flies on
// the flight stick, the right one looks by dragging on the view (that part is god-camera.js's own pointer handling).
// The stick and its buttons are always there on a touch screen: there is nothing to turn on, and no other gesture to
// learn.
//
// The stick flies forward / back and sideways; two buttons climb and descend while held, and a third latches the
// fast gear. The stick is relative: wherever the thumb lands on the pad is neutral and the push from there is the
// input, so it needs no aim; pushed past its rim it shifts smoothly into the fast gear, and pushed further still its
// centre trails the thumb, so turning back answers at once. Every control captures its pointer: a finger that slides
// off its control keeps it until it lifts, and a second or third finger never disturbs the first.
//
// The arithmetic (stickResponse, trailOrigin) is free of the DOM and is tested in tests/donostia-touch.test.mjs.
// initTouchControls(god, { onChange }) -> { setEnabled(on), reset(), available } wires the stick & buttons, shows them
// on coarse pointers (or after the first touch on hybrid devices) and sets body.touch-enabled for the touch layout
// (css/donostia.css). setEnabled(false) hides them and lets go (the full map covers the view).

export const STICK = {
  radius: 48, // px from neutral to the rim: full speed
  deadZone: 0.12, // of the radius: a resting thumb doesn't drift
  curve: 1.6, // response exponent: fine control near the centre, full speed only at the rim
  overdrive: 0.6 // of the radius past the rim: the fast gear, 0 at the rim to 1 at its end
};
const OLD_FLY_KEY = 'donostia-touch-fly'; // localStorage: the stick's switch of an earlier version, cleared here

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

export function initTouchControls(god, { onChange } = {}) {
  const root = document.getElementById('touch-controls');
  const stick = document.getElementById('touch-stick');
  const knob = document.getElementById('touch-stick-knob');
  const none = { setEnabled() {}, reset() {}, available: false };
  if (!root || !stick || !knob) return none;
  const buttons = [...root.querySelectorAll('[data-touch-action]')];
  const held = new Map(); // pointerId -> { button, action }
  const media = window.matchMedia('(any-pointer: coarse)');
  let stickPointer = null, origin = null, radius = STICK.radius, overdrive = 0;
  let enabled = true, available = false, touchSeen = false, fastGear = false;
  try { localStorage.removeItem(OLD_FLY_KEY); } catch { /* storage unavailable */ }

  const canInteract = () => enabled && available && !document.hidden;
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
    document.body.classList.toggle('touch-enabled', available);
    root.hidden = !enabled || !available;
  };
  const updateAvailability = () => {
    const now = media.matches || touchSeen;
    const changed = now !== available;
    if (changed) reset();
    available = now;
    show();
    if (changed) onChange?.(available);
  };
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
    get available() { return available; }
  };
}
