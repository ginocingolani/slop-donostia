import * as THREE from 'three/webgpu';

// js/donostia/god-camera.js
// Free-flying "god mode" camera for exploring the map before the travel modes arrive: WASD moves along the view,
// Space / E climbs, Q / C descends, Shift boosts, dragging looks around (arrow keys too) and the wheel scales the speed.
// Speed grows with the height above the ground; the camera never goes under the terrain or the sea.

const isTyping = (e) => e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

export class GodCamera {
  constructor(dom, terrain) {
    this.dom = dom;
    this.terrain = terrain;
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.3, 80000);
    this.position = new THREE.Vector3(0, 120, 600);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.25;
    this.speedScale = 1;
    this.keys = new Set();
    this.flight = null;
    this.enabled = true;
    this._bind();
    this._apply();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    const pointers = new Map();
    let pinch = 0;
    this.dom.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dom.setPointerCapture(e.pointerId);
      this.flight = null;
    });
    this.dom.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
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
        if (pinch) this._touchPush = (this._touchPush || 0) + (d - pinch) * 0.02;
        pinch = d;
      }
    });
    const release = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = 0; };
    this.dom.addEventListener('pointerup', release);
    this.dom.addEventListener('pointercancel', release);
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
    if (!this.enabled) { this._apply(); return; }
    const k = this.keys;
    const fwd = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + (this._touchPush || 0);
    const side = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const up = (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('KeyQ') || k.has('KeyC') ? 1 : 0);
    this._touchPush = 0;
    const turn = (k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0);
    const tilt = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    this.yaw += turn * 1.4 * dt;
    this.pitch = THREE.MathUtils.clamp(this.pitch + tilt * 1.0 * dt, -1.5, 1.5);

    const agl = Math.max(0, this.position.y - this.groundHeight);
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 4 : 1;
    const speed = THREE.MathUtils.clamp(5 + agl * 0.9, 5, 700) * this.speedScale * boost;
    const forward = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = forward.multiplyScalar(fwd).addScaledVector(right, side);
    wish.y += up;
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(speed);
    this.velocity.lerp(wish, 1 - Math.exp(-6 * dt));
    this.position.addScaledVector(this.velocity, dt);
    const floorY = this.groundHeight + 1.7;
    if (this.position.y < floorY) { this.position.y = floorY; this.velocity.y = Math.max(0, this.velocity.y); }
    this._apply();
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
    if (![s.x, s.y, s.z, s.yaw, s.pitch].every(Number.isFinite)) return;
    this.position.set(s.x, s.y, s.z);
    this.yaw = s.yaw;
    this.pitch = s.pitch;
    this._apply();
  }
}
