// js/donostia/hud.js
// HUD wiring for index.html: time of day, the fly-to list, clean view, telemetry.
// initHud({ GEO, god, terrain, lighting, grade, renderer }) -> { update(dt, elapsed, fps) }

const TIMES = ['golden', 'midday', 'twilight', 'midnight'];

export function initHud({ GEO, god, lighting, grade }) {
  const timeButtons = document.querySelectorAll('[data-time]');
  const selectTime = (id) => {
    lighting.applyPreset(id);
    grade.applyPreset(lighting.activePresetId);
    timeButtons.forEach((b) => b.classList.toggle('active', b.dataset.time === id));
  };
  timeButtons.forEach((b) => b.addEventListener('click', () => selectTime(b.dataset.time)));
  selectTime('golden');

  const teleportList = document.getElementById('teleport-list');
  for (const t of GEO.teleports) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pop-item tp-btn';
    const name = document.createElement('span');
    name.className = 'pop-name';
    name.textContent = t.name;
    const sub = document.createElement('span');
    sub.className = 'pop-sub';
    sub.textContent = t.name_es;
    btn.append(name, sub);
    btn.addEventListener('click', () => {
      god.flyTo(t);
      document.getElementById('teleport-popover')?.hidePopover?.();
    });
    teleportList?.appendChild(btn);
  }

  // a mouse click mustn't leave the focus on a HUD button (Space would press it again)
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });
  const hudToggle = document.getElementById('btn-toggle-hud');
  hudToggle?.addEventListener('click', () => {
    const min = document.body.classList.toggle('hud-minimized');
    hudToggle.setAttribute('aria-pressed', String(min));
  });
  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.code === 'KeyH') hudToggle?.click();
    const digit = /^Digit([1-4])$/.exec(e.code);
    if (digit) selectTime(TIMES[digit[1] - 1]);
  });

  const elFps = document.getElementById('hud-fps');
  const elAlt = document.getElementById('hud-altitude');
  const elSpeed = document.getElementById('hud-speed');
  return {
    // called by main.js four times a second
    update(fps) {
      if (elFps) {
        elFps.textContent = String(fps);
        elFps.className = fps >= 50 ? 'fps-ok' : fps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elAlt) elAlt.textContent = Math.round(god.position.y).toLocaleString('en-US');
      if (elSpeed) elSpeed.textContent = String(Math.round(god.velocity.length() * 3.6));
    }
  };
}
