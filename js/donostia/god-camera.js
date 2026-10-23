import * as THREE from 'three/webgpu';

// js/donostia/god-camera.js
// Free-flying "god mode" camera for exploring the map before the travel modes arrive: WASD moves along the view,
// Space / E climbs, Q / C descends, Shift boosts, dragging looks around (arrow keys too) and the wheel scales the speed.
// On touch screens one finger looks, a pinch flies along the view and hud.js feeds its virtual stick & buttons into
// `touch`. Speed grows with the height above the ground; the camera never goes under the terrain or the sea, nor
// further out than a little past the context grid's horizon hills.

const isTyping = (e) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
// Keys a focused control acts on itself (Space & Enter press a button, the arrows scroll a list): left to it
const CONTROL_KEYS = /^(Space|Enter|NumpadEnter|Arrow(Up|Down|Left|Right))$/;
const onControl = (e) => e.target instanceof Element &&
  e.target.closest('button, a[href], summary, [role=button], [popover], [role=dialog]') !== null;

const BOUNDS_MARGIN = 500; // m past the context grid
const CEILING = 5000; // m
const EYE = 1.7; // m above the ground or the sea

export class GodCamera {
  constructor(dom, terrain) {
    this.dom = dom;
    this.terrain = terrain;
    const c = terrain.context;
    this.bounds = c ? {
      minX: c.x0 - BOUNDS_MARGIN, maxX: c.x0 + c.width + BOUNDS_MARGIN,
      minZ: c.z0 - BOUNDS_MARGIN, maxZ: c.z0 + c.depth + BOUNDS_MARGIN
    } : null;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.3, 80000);
    this.position = new THREE.Vector3(0, 120, 600);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.25;
    this.speedScale = 1;
    this.keys = new Set();
    // virtual stick & buttons (hud.js): forward / side in -1..1, up in -1..1, boost on or off
    this.touch = { forward: 0, side: 0, up: 0, boost: false };
    this._pinch = 0; // pinch spread since the last frame (px)
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this.flight = null;
    this.enabled = true;
    this._bind();
    this._apply();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      // a keyboard user on a HUD button still flies with WASD, but Space presses the button
      if (CONTROL_KEYS.test(e.code) && onControl(e)) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    const pointers = new Map();
    let pinch = 0;
    // the page must not pan or zoom under the fingers
    this.dom.style.touchAction = 'none';
    // the right button would open the context menu over the view (and must not drag)
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    this.dom.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dom.setPointerCapture(e.pointerId);
      this.flight = null;
    });
    this.dom.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      // a mouse whose release never reached us (dropped outside the window, a system dialog...) must not keep
      // turning the view as it merely hovers
      if (e.pointerType === 'mouse' && e.buttons === 0) { release(e); return; }
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      if (pointers.size === 1) {
        const k = 0.0032 * (this.camera.fov / 55);
        this.yaw -= dx * k;
        this.pitch = THREE.MathUtils.clamp(this.pitch - dy * k, -1.5, 1.5);
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) this._pinch += d - pinch;
        pinch = d;
      }
    });
    function release(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = 0;
    }
    this.dom.addEventListener('pointerup', release);
    this.dom.addEventListener('pointercancel', release);
    this.dom.addEventListener('lostpointercapture', release);
    this.dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.speedScale = THREE.MathUtils.clamp(this.speedScale * Math.pow(1.0015, -e.deltaY), 0.1, 12);
    }, { passive: false });
  }

  get groundHeight() {
    return Math.max(0, this.terrain.heightAt(this.position.x, this.position.z));
  }

  // Fly to a station { from: [x, y, z], to: [x, y, z] } in `duration` seconds
  flyTo(station, duration = 2.2) {
    const from = new THREE.Vector3(...station.from), to = new THREE.Vector3(...station.to);
    const dir = to.clone().sub(from).normalize();
    this.flight = {
      t: 0, duration,
      p0: this.position.clone(), p1: from,
      yaw0: this.yaw, pitch0: this.pitch,
      yaw1: Math.atan2(-dir.x, -dir.z), pitch1: Math.asin(THREE.MathUtils.clamp(dir.y, -1, 1))
    };
    // shortest turn
    while (this.flight.yaw1 - this.flight.yaw0 > Math.PI) this.flight.yaw1 -= 2 * Math.PI;
    while (this.flight.yaw1 - this.flight.yaw0 < -Math.PI) this.flight.yaw1 += 2 * Math.PI;
    this.velocity.set(0, 0, 0);
  }

  clearTouch() {
    Object.assign(this.touch, { forward: 0, side: 0, up: 0, boost: false });
    this._pinch = 0;
  }

  update(dt) {
    if (this.flight) {
      const f = this.flight;
      f.t = Math.min(1, f.t + dt / f.duration);
      const s = f.t * f.t * (3 - 2 * f.t);
      // arc over the city so long hops don't cut through hills
      const lift = Math.sin(Math.PI * s) * Math.min(250, f.p0.distanceTo(f.p1) * 0.25);
      this.position.lerpVectors(f.p0, f.p1, s).y += lift;
      this.yaw = THREE.MathUtils.lerp(f.yaw0, f.yaw1, s);
      this.pitch = THREE.MathUtils.lerp(f.pitch0, f.pitch1, s);
      if (f.t >= 1) this.flight = null;
      this._apply();
      return;
    }
    if (!this.enabled) { this._pinch = 0; this._apply(); return; }
    const k = this.keys, t = this.touch;
    const fwd = THREE.MathUtils.clamp((k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + t.forward, -1, 1);
    const side = THREE.MathUtils.clamp((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + t.side, -1, 1);
    const up = THREE.MathUtils.clamp((k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0) + t.up, -1, 1);
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const tilt = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    this.yaw += turn * 1.4 * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + tilt * 1.0 * dt, -1.5, 1.5);

    const agl = Math.max(0, this.position.y - this.groundHeight);
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') || t.boost ? 4 : 1;
    const speed = THREE.MathUtils.clamp(5 + agl * 0.9, 5, 700) * this.speedScale * boost;
    const forward = this._forward.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    // a pinch moves the camera itself along the view, further per pixel the higher it flies
    if (this._pinch) {
      this.position.addScaledVector(forward, this._pinch * THREE.MathUtils.clamp(0.2 + agl * 0.012, 0.2, 12) * this.speedScale);
      this._pinch = 0;
    }
    const wish = forward.multiplyScalar(fwd).addScaledVector(right, side);
    wish.y += up;
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    this.velocity.lerp(wish, 1 - Math.exp(-6 * dt));
    this.position.addScaledVector(this.velocity, dt);
    this._confine();
    this._apply();
  }

  // Keeps the camera above the ground or the sea, under the ceiling and over the world: past its edges there is only
  // empty space to get lost in
  _confine() {
    const p = this.position, v = this.velocity, b = this.bounds;
    if (b) {
      const x = THREE.MathUtils.clamp(p.x, b.minX, b.maxX), z = THREE.MathUtils.clamp(p.z, b.minZ, b.maxZ);
      if (x !== p.x) { p.x = x; v.x = 0; }
      if (z !== p.z) { p.z = z; v.z = 0; }
    }
    const floorY = this.groundHeight + EYE;
    if (p.y < floorY) { p.y = floorY; v.y = Math.max(0, v.y); }
    if (p.y > CEILING) { p.y = CEILING; v.y = Math.min(0, v.y); }
  }

  _apply() {
    this.camera.position.copy(this.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.updateMatrixWorld();
  }

  onResize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  get state() {
    return { x: this.position.x, y: this.position.y, z: this.position.z, yaw: this.yaw, pitch: this.pitch };
  }

  set state(s) {
    this.restore(s);
  }

  /**
   * Puts the camera at a saved `state` if it is a view of the world: false (camera untouched) for anything else, e.g.
   * a corrupt save or one off the edge of the map. A view under the ground or above the ceiling is lifted or lowered
   * to the nearest allowed height, the pitch kept within the drag's range.
   */
  restore(s) {
    if (!s || typeof s !== 'object' || ![s.x, s.y, s.z, s.yaw, s.pitch].every(Number.isFinite)) return false;
    const b = this.bounds;
    if (b && (s.x < b.minX || s.x > b.maxX || s.z < b.minZ || s.z > b.maxZ)) return false;
    this.position.set(s.x, s.y, s.z);
    this.velocity.set(0, 0, 0);
    this.yaw = THREE.MathUtils.euclideanModulo(s.yaw + Math.PI, 2 * Math.PI) - Math.PI;
    this.pitch = THREE.MathUtils.clamp(s.pitch, -1.5, 1.5);
    this.flight = null;
    this._confine();
    this._apply();
    return true;
  }
}
