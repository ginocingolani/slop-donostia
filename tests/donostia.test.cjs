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
