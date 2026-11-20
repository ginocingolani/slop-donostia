import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The interface's languages (js/donostia/i18n.js): English by default whatever the browser speaks, the choice
// remembered, every key index.html and the HUD's scripts ask for said in all three languages, the fly-to places
// named, and the loading screen's English lines recognised. Then the full map's limits (js/donostia/minimap.js,
// confineMapView): it never shows further than the map that was built.

const root = fileURLToPath(new URL('../', import.meta.url));
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
// (a browser that speaks Basque: not looked at)
Object.defineProperty(globalThis, 'navigator', { value: { language: 'eu-ES', languages: ['eu-ES', 'es'] }, configurable: true });
const i18n = await import(pathToFileURL(`${root}js/donostia/i18n.js`).href);
const { LANGS, DEFAULT_LANG, t, getLang, setLang, onLang, placeName, translateStatus, compassNames, PLACES_EN } = i18n;
const read = (file) => readFile(`${root}${file}`, 'utf8');

test('English is the default for everyone; a choice is remembered and switches at once', () => {
  assert.equal(DEFAULT_LANG, 'en');
  assert.deepEqual(LANGS, ['en', 'eu', 'es']);
  assert.equal(getLang(), 'en', 'not picked from the browser');
  assert.equal(t('tool.map'), 'Map');
  const heard = [];
  const off = onLang((lang) => heard.push(lang));
  assert.equal(setLang('eu'), 'eu');
  assert.equal(t('tool.flyTo'), 'Joan');
  assert.equal(store.get('donostia-lang'), 'eu');
  setLang('es');
  assert.equal(t('settings.quality'), 'Calidad');
  assert.equal(t('quality.autoNote', { tier: t('quality.high') }), 'Auto: Alta');
  assert.equal(setLang('fr'), 'es', 'an unknown language changes nothing');
  setLang('en');
  assert.equal(store.has('donostia-lang'), false, 'English is the absence of a choice');
  assert.deepEqual(heard, ['eu', 'es', 'en']);
  off();
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('every key the page and the scripts ask for is said in the three languages', async () => {
  const html = await read('index.html');
  const sources = (await Promise.all(['hud.js', 'minimap.js', 'i18n.js', 'consent.js'].map((f) => read(`js/donostia/${f}`)))).join('\n');
  const asked = new Set();
  for (const [, key] of html.matchAll(/data-i18n="([^"]+)"/g)) asked.add(key);
  for (const [, pairs] of html.matchAll(/data-i18n-attr="([^"]+)"/g)) for (const pair of pairs.split(';')) asked.add(pair.split(':')[1]);
  for (const [, key] of sources.matchAll(/\bt\('([\w.]+)'/g)) asked.add(key);
  // (keys built at run time: the weather kinds, the tiers, the loading screen's lines)
  for (const k of ['clear', 'cloudy', 'overcast', 'fog', 'drizzle', 'rain', 'showers', 'snow', 'storm']) asked.add(`weather.${k}`);
  for (const k of ['auto', 'low', 'medium', 'high', 'ultra']) asked.add(`quality.${k}`);
  // (the cookie's answer in the data popover: js/donostia/consent.js picks the key by the tracker's status)
  for (const k of ['granted', 'denied', 'pending']) asked.add(`consent.${k}`);
  assert.ok(asked.size > 90, `${asked.size} keys found`);
  const rich = [...html.matchAll(/data-i18n-rich="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(rich.length, 12, 'the data credits, and what the usage analytics send');
  for (const lang of LANGS) {
    setLang(lang);
    for (const key of asked) {
      assert.notEqual(t(key), key, `${lang}: ${key}`);
      if (lang !== 'en' && !/^(quality\.(auto|ultra)|gauge\.alt|hint\.map|tool\.map|hint\.fast)$/.test(key)) {
        // (a few words are the same in two languages; a whole sentence left in English would not be)
        if (t(key).length > 12) assert.notEqual(t(key), englishOf(key), `${lang}: ${key} is still English`);
      }
    }
    // the credits keep their links: as many <n>…</n> as the paragraph has child elements
    if (lang !== 'en') {
      for (const key of rich) {
        const p = html.match(new RegExp(`<p data-i18n-rich="${key}">(.*?)</p>`))[1];
        const kids = [...p.matchAll(/<(a|i)\b/g)].length;
        assert.equal([...t(key).matchAll(/<(\d)>.*?<\/\1>/g)].length, kids, `${lang}: ${key}`);
      }
    }
    assert.equal(compassNames().length, 8);
  }
  setLang('en');
});

// the English wording of a key, whatever language is in force
function englishOf(key) {
  const now = getLang();
  setLang('en');
  const text = t(key);
  setLang(now);
  return text;
}

test('the page reads English before any script runs, with no Basque or Spanish chrome left in it', async () => {
  const html = await read('index.html');
  assert.match(html, /<html lang="en">/);
  for (const old of ['Hegan', 'Gehiago', 'Kalitatea', 'Jainko-kamera', 'Recargar', 'Bilatu', 'Itxi', '>Joan<', '>Mapa<', 'Igo', 'Jaitsi', 'Azkar', 'Ilunabarra']) {
    assert.ok(!html.includes(old), `index.html still says ${old}`);
  }
  // the marked elements' own text is the English string
  setLang('en');
  for (const [, key, text] of html.matchAll(/data-i18n="([^"]+)">([^<]*)</g)) {
    assert.equal(text.replace(/&amp;/g, '&'), t(key), key);
  }
  const hud = await read('js/donostia/hud.js');
  assert.ok(!/needsReload|Recargar|Berrabiarazi|location\.reload/.test(hud.replace(/^\s*\/\/.*$/gm, '')), 'no reload control in the quality row');
});

test('the fly-to places have an English name each, and keep their own under it', async () => {
  const { GEO } = await import(pathToFileURL(`${root}js/donostia/geodata.js`).href);
  assert.deepEqual(Object.keys(PLACES_EN).sort(), GEO.teleports.map((p) => p.id).sort());
  const igeldo = GEO.teleports.find((p) => p.id === 'igeldo');
  setLang('en');
  assert.deepEqual(placeName(igeldo), { name: 'Mount Igeldo', sub: 'Igeldo mendia' });
  setLang('eu');
  assert.deepEqual(placeName(igeldo), { name: 'Igeldo mendia', sub: 'Monte Igueldo' });
  setLang('es');
  assert.deepEqual(placeName(igeldo), { name: 'Monte Igueldo', sub: 'Igeldo mendia' });
  // a name that is the same in both is said once
  assert.equal(placeName({ id: 'x', name: 'Alderdi Eder', name_es: 'Alderdi Eder' }).sub, '');
  setLang('en');
  assert.equal(placeName({ id: 'new-place', name: 'Ulia' }).name, 'Ulia', 'a place without an English name keeps its own');
});

test("main.js's loading lines are said in the language picked, and unknown ones come through", async () => {
  const main = await read('js/donostia/main.js');
  const html = await read('index.html');
  // the fixed lines, as main.js and index.html word them today: if one is reworded there, this says so
  const lines = [
    'Loading LiDAR terrain & sea floor…', 'Building the bay, the hills & the streets…', 'Raising the landmarks…',
    'Planting trees & dressing the streets…', 'Compiling shaders…',
    'This browser has no WebGPU, which Slop Donostia needs to draw the city.',
    "WebGPU is there, but this device's graphics are not supported by it (or it is turned off).",
    'WebGPU could not start on this device (the browser gave no GPU device). Close other tabs and reload, or try another browser.',
    'On iPhone and iPad it comes with iOS 26 (Safari 26).', 'On Android it needs Chrome 121 or later on Android 12 or later.',
    'Try a current Chrome or Edge, or Safari 26 or later.', 'WebGPU also needs a secure (https) page.'
  ];
  for (const line of lines) assert.ok(main.includes(line), `main.js no longer says: ${line}`);
  assert.ok(html.includes('Could not load the app (network or browser support).'));
  setLang('en');
  assert.equal(translateStatus(lines[0]), lines[0]);
  for (const lang of ['eu', 'es']) {
    setLang(lang);
    for (const line of [...lines, 'Starting…', 'Could not load the app (network or browser support).']) assert.notEqual(translateStatus(line), line, `${lang}: ${line}`);
    assert.equal(translateStatus('Something main.js says tomorrow'), 'Something main.js says tomorrow');
  }
  setLang('es');
  assert.equal(translateStatus('Raising 12,345 buildings…'), 'Levantando 12,345 edificios…');
  assert.equal(translateStatus('Compiling shaders… 40%'), 'Compilando shaders… 40 %');
  assert.equal(translateStatus('Initializing three.js r186 WebGPURenderer…'), 'Iniciando three.js r186 WebGPURenderer…');
  assert.equal(translateStatus('Could not start: x is not defined'), 'No se pudo iniciar: x is not defined');
  assert.equal(translateStatus('The GPU was reset (device lost). Reload the page to continue.'), 'La GPU se ha reiniciado (device lost). Recarga la página para continuar.');
  assert.equal(
    translateStatus('This browser has no WebGPU, which Slop Donostia needs to draw the city. Try a current Chrome or Edge, or Safari 26 or later. WebGPU also needs a secure (https) page.'),
    'Este navegador no tiene WebGPU, que Slop Donostia necesita para dibujar la ciudad. Prueba con un Chrome o Edge actual, o con Safari 26 o posterior. WebGPU también necesita una página segura (https).'
  );
  setLang('en');
});

test('the full map never zooms out or pans beyond the map that was built', async () => {
  const { confineMapView } = await import(pathToFileURL(`${root}js/donostia/minimap.js`).href);
  const { GEO } = await import(pathToFileURL(`${root}js/donostia/geodata.js`).href);
  const core = GEO.frame.core, margin = 120;
  const spanX = core.maxX - core.minX + 2 * margin, spanZ = core.maxZ - core.minZ + 2 * margin;
  for (const [w, h] of [[1440, 900], [390, 844], [844, 390], [820, 1180]]) {
    const fit = Math.min(w / spanX, h / spanZ);
    // zoomed out as far as it goes, from anywhere: the whole map, centred, and no wider
    const wide = confineMapView({ cx: 9000, cz: -9000, zoom: 0.001 }, core, w, h, margin);
    assert.ok(Math.abs(wide.zoom - fit) < 1e-12, `${w}x${h}: the widest zoom fits the map`);
    assert.ok(Math.abs(wide.cx - (core.minX + core.maxX) / 2) < 1e-9 || w / wide.zoom < spanX);
    assert.ok(Math.abs(wide.cz - (core.minZ + core.maxZ) / 2) < 1e-9 || h / wide.zoom < spanZ);
    // along the axis that fits exactly, and at any closer zoom, the view's edges stay inside
    for (const zoom of [fit, fit * 1.5, 0.35, 1, 3]) {
      for (const [cx, cz] of [[-99999, -99999], [99999, 99999], [0, 0], [core.minX, core.maxZ]]) {
        const v = confineMapView({ cx, cz, zoom }, core, w, h, margin);
        assert.equal(v.zoom, Math.max(zoom, fit));
        if (w / v.zoom <= spanX + 1e-9) {
          assert.ok(v.cx - w / v.zoom / 2 >= core.minX - margin - 1e-6 && v.cx + w / v.zoom / 2 <= core.maxX + margin + 1e-6, `${w}x${h} @${zoom}: x`);
        } else assert.ok(Math.abs(v.cx - (core.minX + core.maxX) / 2) < 1e-9, 'the spare axis is centred');
        if (h / v.zoom <= spanZ + 1e-9) {
          assert.ok(v.cz - h / v.zoom / 2 >= core.minZ - margin - 1e-6 && v.cz + h / v.zoom / 2 <= core.maxZ + margin + 1e-6, `${w}x${h} @${zoom}: z`);
        } else assert.ok(Math.abs(v.cz - (core.minZ + core.maxZ) / 2) < 1e-9, 'the spare axis is centred');
      }
    }
    // a view already inside is left alone
    const inside = { cx: 100, cz: 200, zoom: 1.2 };
    assert.deepEqual(confineMapView(inside, core, w, h, margin), inside);
  }
  assert.equal(confineMapView({ cx: 0, cz: 0, zoom: 99 }, core, 800, 600).zoom, 3, 'the closest zoom is unchanged');
});
