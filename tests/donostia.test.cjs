const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { dirname, join, normalize, relative } = require('node:path');
const test = require('node:test');

// Slop Donostia (index.html): the import map, and a module graph that never reaches New York's data-laden modules

const root = join(__dirname, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const importMap = JSON.parse(html.match(/<script type="importmap">([^]*?)<\/script>/)[1]);
const entries = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)].map((m) => m[1]);

// Every module reachable from a file through relative static imports
function graph(start) {
  const seen = new Set();
  const stack = [normalize(join(root, start))];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const [, spec] of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]+)['"]/g)) {
      const target = normalize(join(dirname(file), spec));
      assert.ok(existsSync(target), `${relative(root, file)} imports a missing module: ${spec}`);
      stack.push(target);
    }
  }
  return [...seen].map((f) => relative(root, f));
}

test('three.js comes from one pinned release', () => {
  const urls = Object.values(importMap.imports);
  const versions = new Set(urls.map((u) => (u.match(/three@([^/]+)\//) || [])[1]));
  assert.equal(versions.size, 1, 'all three.js entries share a version');
  assert.match([...versions][0], /^\d+\.\d+\.\d+$/, 'an exact npm release, not a branch');
  assert.equal(importMap.imports.three, importMap.imports['three/webgpu'], 'three and three/webgpu share one module instance');
});

test('the Donostia entry never loads New York modules', () => {
  assert.deepEqual(entries, ['./js/donostia/main.js']);
  const modules = graph('js/donostia/main.js');
  const nyc = ['js/tsl-materials.js', 'js/city-config.js', 'js/nyc-geodata.js', 'js/trees.js', 'js/buildings.js', 'js/landmarks.js', 'js/main.js'];
  for (const m of nyc) assert.ok(!modules.includes(m), `${m} is reachable from js/donostia/main.js`);
});

test('the display fonts ship with their licences, and Harri never ships at all', () => {
  const preload = html.match(/<link rel="preload" href="\.\/([^"]+\.woff2)" as="font"/)[1];
  const css = readFileSync(join(root, 'css/donostia.css'), 'utf8');
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => ({
    family: body.match(/font-family:\s*'([^']+)'/)[1],
    url: body.match(/url\('\.\.\/([^']+)'\)/)[1],
  }));
  assert.ok(faces.length >= 1, 'css/donostia.css declares its display fonts');
  assert.equal(faces[0].url, preload, 'the preloaded font is the first one css/donostia.css declares');
  const stack = css.match(/--font-display:\s*([^;]+);/)[1];
  assert.match(stack, new RegExp(`^'${faces[0].family}'`), 'the preloaded face leads --font-display');
  for (const { url } of faces) {
    assert.ok(existsSync(join(root, url)), `${url} exists`);
    // each font lives in its own folder under fonts/ (fonts/<name>/…), which carries the SIL OFL
    const fontDir = join(root, ...url.split('/').slice(0, 2));
    assert.match(readFileSync(join(fontDir, 'OFL.txt'), 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/, `${fontDir}/OFL.txt`);
  }
  // Harri (Blancoletters) is commercial: its EULA forbids giving third parties access to the font files
  const files = require('node:fs').readdirSync(join(root, 'fonts'), { recursive: true });
  assert.deepEqual(files.filter((f) => /harri/i.test(f)), [], 'no Harri font files in the repository');
});

test('the generated geodata keeps its shape', async () => {
  const { pathToFileURL } = require('node:url');
  const { GEO } = await import(pathToFileURL(join(root, 'js/donostia/geodata.js')).href);
  for (const key of ['frame', 'terrain', 'districts', 'buildings', 'landmarks', 'teleports']) assert.ok(GEO[key], `GEO.${key}`);
  assert.ok(GEO.buildings.length > 5000);
  for (const b of GEO.buildings.slice(0, 500)) {
    assert.ok(b.g[0].length >= 6 && b.g[0].length % 2 === 0);
    assert.ok(b.base <= b.ground && b.ground < b.eave && b.eave <= b.top, 'base <= ground < eave <= top');
  }
  for (const t of GEO.teleports) assert.ok([...t.from, ...t.to].every(Number.isFinite), t.id);
  for (const f of ['core', 'context']) assert.ok(existsSync(join(root, GEO.terrain[f].url)), GEO.terrain[f].url);
});
