import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The port's boats: the digitised data (tools/donostia/data/port_boats.json) and its bake (js/donostia/data-boats.js)

const root = fileURLToPath(new URL('../', import.meta.url));

test('the digitised boats and their bake agree and stay in the port', async () => {
  const src = JSON.parse(fs.readFileSync(`${root}tools/donostia/data/port_boats.json`, 'utf8'));
  const { BOATS } = await import(pathToFileURL(`${root}js/donostia/data-boats.js`).href);
  assert.match(src.source, /geoEuskadi/);
  assert.deepEqual(BOATS.families, src.families);
  const N = BOATS.boats.length / 9;
  assert.ok(Number.isInteger(N) && N > 300, `${N} boats`);
  assert.equal(N, src.boats.length);
  for (let i = 0; i < N; i++) {
    const [x, z, heading, length, beam, family, ...paints] = BOATS.boats.slice(9 * i, 9 * i + 9);
    assert.ok(x > -18000 && x < 13000 && z > -25000 && z < -6000, `boat ${i} at ${x / 100}, ${z / 100} lies in the port`);
    assert.ok(heading >= 0 && heading < 3600, `boat ${i}: heading ${heading}`);
    assert.ok(length >= 150 && length <= 2500 && beam >= 80 && beam <= length, `boat ${i}: ${length} x ${beam} cm`);
    assert.ok(family >= 0 && family < BOATS.families.length, `boat ${i}: family ${family}`);
    for (const c of paints) assert.ok(Number.isInteger(c) && c >= 0 && c <= 0xffffff, `boat ${i}: colour ${c}`);
  }
});
