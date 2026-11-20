import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Slop Donostia as an installable web app: the manifest (full screen from the home screen, under whatever path the
// site is served from), its icons at the sizes it names, and index.html's Apple tags. And no service worker.

const root = fileURLToPath(new URL('../', import.meta.url));
const html = await readFile(`${root}index.html`, 'utf8');
const manifest = JSON.parse(await readFile(`${root}manifest.webmanifest`, 'utf8'));

// a PNG's width & height (its IHDR chunk)
const pngSize = async (file) => {
  const b = await readFile(`${root}${file}`);
  assert.equal(b.subarray(1, 4).toString('latin1'), 'PNG', file);
  return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
};

test('the manifest asks for full screen, relative to wherever the site is served', async () => {
  assert.equal(manifest.name, 'Slop Donostia');
  assert.ok(manifest.short_name.length <= 12, 'a short name fits under a home-screen icon');
  assert.equal(manifest.display, 'fullscreen');
  assert.deepEqual(manifest.display_override, ['fullscreen', 'standalone']);
  assert.equal(manifest.orientation, 'any');
  // (GitHub Pages serves the site under /slop-donostia/)
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/);
  assert.equal(manifest.background_color, manifest.theme_color);
  const sizes = manifest.icons.map((i) => `${i.sizes} ${i.purpose}`).sort();
  assert.deepEqual(sizes, ['192x192 any', '512x512 any', '512x512 maskable']);
  for (const icon of manifest.icons) {
    assert.ok(!icon.src.startsWith('/'), 'icons are relative too');
    assert.equal(await pngSize(icon.src), icon.sizes, icon.src);
  }
});

test('index.html links the manifest and carries the Apple tags, with no service worker', async () => {
  assert.match(html, /<link rel="manifest" href="\.\/manifest\.webmanifest" \/>/);
  assert.ok(html.includes(`<meta name="theme-color" content="${manifest.theme_color}" />`));
  for (const [name, content] of [['mobile-web-app-capable', 'yes'], ['apple-mobile-web-app-capable', 'yes'],
    ['apple-mobile-web-app-status-bar-style', 'black-translucent'], ['apple-mobile-web-app-title', 'Slop Donostia']]) {
    assert.ok(html.includes(`<meta name="${name}" content="${content}" />`), name);
  }
  const touchIcon = html.match(/<link rel="apple-touch-icon" sizes="180x180" href="\.\/([^"]+)" \/>/);
  assert.equal(await pngSize(touchIcon[1]), '180x180');
  assert.match(html, /viewport-fit=cover/, 'the view runs under the notch; the layout keeps clear by the safe-area insets');
  const sources = html + await readFile(`${root}js/donostia/hud.js`, 'utf8') + await readFile(`${root}js/donostia/i18n.js`, 'utf8');
  assert.ok(!/serviceWorker\b/.test(sources), 'no service worker');
});

test('full screen is asked for from a click only, and the icons are the rosette the HUD draws', async () => {
  const hud = await readFile(`${root}js/donostia/hud.js`, 'utf8');
  // the one call sits in the button's click handler
  assert.equal([...hud.matchAll(/request\.call\(/g)].length, 1);
  assert.match(hud, /button\.addEventListener\('click', \(\) => \{[^]*?request\.call\(el/);
  const rosette = html.match(/<symbol id="i-rosette"[^]*?<path [^>]*d="([^"]+)"/)[1];
  for (const file of ['icons/icon.svg', 'icons/icon-maskable.svg']) {
    assert.ok((await readFile(`${root}${file}`, 'utf8')).includes(rosette), `${file} draws the HUD's rosette`);
  }
});
