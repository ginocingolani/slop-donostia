// js/donostia/touch.js
// Touch input for the god camera (js/donostia/god-camera.js). The whole scheme is two thumbs: the left one flies on
// the flight stick, the right one looks by dragging on the view (that part is god-camera.js's own pointer handling).
// The stick is always there on a touch screen: there is nothing to turn on, and no other gesture to learn.
//
// The stick flies forward / back and sideways, forward being where the view looks (god-camera.js's forward vector
// has the pitch in it): looking up climbs, looking down descends, so there are no buttons for that (there were two,
// Up and Down, under the right thumb: they took the corner the looking thumb works in; god.touch.up is still read by
// the camera, and nothing here feeds it). The fast gear has no button either: the stick pushed past its rim is the
// fast gear. The stick is relative: wherever the thumb lands on the pad is neutral and the push from there is the
// input, so it needs no aim; pushed past its rim it shifts smoothly into the fast gear, and pushed further still its
// centre trails the thumb, so turning back answers at once. The stick captures its pointer: a finger that slides
// off it keeps it until it lifts, and a second or third finger never disturbs the first.
//
// The arithmetic (stickResponse, trailOrigin) is free of the DOM and is tested in tests/donostia-touch.test.mjs.
// initTouchControls(god, { onChange }) -> { setEnabled(on), reset(), available } wires the stick, shows it on coarse
// pointers (or after the first touch on hybrid devices) and sets body.touch-enabled for the touch layout
// (css/donostia.css). setEnabled(false) hides it and lets go (the full map covers the view).

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
  const media = window.matchMedia('(any-pointer: coarse)');
  let stickPointer = null, origin = null, radius = STICK.radius, overdrive = 0;
  let enabled = true, available = false, touchSeen = false;
  try { localStorage.removeItem(OLD_FLY_KEY); } catch { /* storage unavailable */ }

  const canInteract = () => enabled && available && !document.hidden;
  const releaseCapture = (el, id) => { if (el.hasPointerCapture(id)) el.releasePointerCapture(id); };
  // the fast gear: as far in as the stick is pushed past its rim (0..1)
  const applyBoost = () => { god.touch.boost = overdrive; };

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
  // lets go of the stick
  const reset = () => {
    releaseStick(stickPointer);
    god.clearTouch();
  };

  stick.addEventListener('pointerdown', (e) => {
    if (!canInteract() || e.button !== 0 || stickPointer !== null) return;
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
  // a long press must not open the context menu
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
