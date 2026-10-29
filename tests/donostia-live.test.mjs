import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The real-time state (js/donostia/live-state.js): the sun and the moon over the city, Open-Meteo's weather and sea in
// one shape, the tide between the hours, the debug override. The fixtures are real Open-Meteo responses for Donostia
// (29 October 2026; data by Open-Meteo.com, CC BY 4.0).

const root = fileURLToPath(new URL('../', import.meta.url));
const live = await import(pathToFileURL(`${root}js/donostia/live-state.js`).href);
const fixture = (name) => JSON.parse(fs.readFileSync(`${root}tests/fixtures/open-meteo-${name}.json`, 'utf8'));

test('the sun stands where the almanac puts it over Donostia', () => {
  // solar noon at the June solstice: 12:00 UTC + 1.98° of longitude (7.9 min) + the equation of time (1.6 min) =
  // 12:09.5 UTC, 14:09 in Madrid; due south, 90 - 43.32 + 23.44 ≈ 70.1° high
  const noon = live.sunPosition(new Date('2026-06-21T12:09:30Z'));
  assert.ok(Math.abs(noon.azimuth - 180) < 1, `azimuth ${noon.azimuth.toFixed(1)}`);
  assert.ok(Math.abs(noon.elevation - 70.1) < 0.5, `elevation ${noon.elevation.toFixed(2)}`);
  // the winter solstice's noon: 90 - 43.32 - 23.44 ≈ 23.2°
  const winter = live.sunPosition(new Date('2026-12-21T12:09:00Z'));
  assert.ok(Math.abs(winter.elevation - 23.2) < 0.5, `elevation ${winter.elevation.toFixed(2)}`);
  // sunset over the sea at the summer solstice: half the day (H0 = 115.5° for -0.833°, 7 h 42 min) after noon, 19:51.5
  // UTC, 21:51 in Madrid; west-north-west, acos(sin 23.44° / cos 43.32°) = 56.9° short of north: 303°; the refracted
  // centre stands about 0.3° under the horizon when the upper limb touches it
  const set = live.sunPosition(new Date('2026-06-21T19:51:30Z'));
  assert.ok(Math.abs(set.elevation + 0.27) < 0.6 && Math.abs(set.azimuth - 303) < 2, JSON.stringify(set));
  // midnight: well below the horizon
  assert.ok(live.sunPosition(new Date('2026-10-29T23:00:00Z')).elevation < -30);
});

test('the moon is full when it is full', () => {
  // full moon 2026-10-26 04:12 UTC; new moon 2026-11-09 07:02 UTC
  const full = live.moonPosition(new Date('2026-10-26T04:12:00Z'));
  assert.ok(full.illumination > 0.98, `full ${full.illumination}`);
  const fresh = live.moonPosition(new Date('2026-11-09T07:02:00Z'));
  assert.ok(fresh.illumination < 0.02, `new ${fresh.illumination}`);
  assert.ok(live.moonPosition(new Date('2026-11-02T00:00:00Z')).waxing === false);
});

test('WMO codes become a kind and an intensity', () => {
  assert.deepEqual(live.weatherKind(0), { kind: 'clear', intensity: 0, frozen: false, hail: false });
  assert.equal(live.weatherKind(65).kind, 'rain');
  assert.ok(live.weatherKind(65).intensity > live.weatherKind(61).intensity);
  assert.equal(live.weatherKind(99).hail, true);
  assert.equal(live.weatherKind(45).kind, 'fog');
  assert.equal(live.weatherKind(1234).kind, 'cloudy'); // unknown codes stay drawable
});

test("Open-Meteo's weather and sea, normalised", () => {
  const w = live.weatherFromOpenMeteo(fixture('weather'));
  assert.ok(w.cloudCover >= 0 && w.cloudCover <= 1 && w.visibility > 0 && w.windSpeed >= 0);
  assert.ok(typeof w.kind === 'string' && !Number.isNaN(Date.parse(w.time)));
  const s = live.seaFromOpenMeteo(fixture('marine'));
  assert.ok(s.waveHeight > 0 && s.wavePeriod > 0 && s.tide.t.length === 72);
  // the local hours with the +01:00 offset: the first is 23:00 UTC the day before
  assert.equal(new Date(s.tide.t[0]).toISOString(), '2026-10-27T23:00:00.000Z');
});

test('the tide between the hours: on the curve, rising and falling, with its next turns', () => {
  const s = live.seaFromOpenMeteo(fixture('marine'));
  const { t, level } = s.tide;
  // on the hour the curve passes through the data
  const at = live.tideAt(s.tide, new Date(t[30]));
  assert.ok(Math.abs(at.level - level[30]) < 1e-9);
  // between the hours it stays within the neighbours' range plus a little overshoot
  for (let k = 2; k < t.length - 3; k++) {
    const mid = live.tideAt(s.tide, new Date((t[k] + t[k + 1]) / 2)).level;
    const lo = Math.min(level[k], level[k + 1]) - 0.15, hi = Math.max(level[k], level[k + 1]) + 0.15;
    assert.ok(mid >= lo && mid <= hi, `hour ${k}: ${mid}`);
  }
  // the rate's sign follows the data, and the next two turns alternate
  const rising = live.tideAt(s.tide, new Date(2026 - 10, 0));
  assert.equal(rising, null); // outside the curve
  const k = level.findIndex((v, i) => i > 2 && level[i + 1] > v + 0.3);
  const now = live.tideAt(s.tide, new Date(t[k] + 1800000));
  assert.ok(now.rate > 0, `rate ${now.rate}`);
  assert.equal(now.next.length, 2);
  assert.notEqual(now.next[0].kind, now.next[1].kind);
  assert.equal(now.next[0].kind, 'high');
});

test('the override replaces time, weather and sea, and runs the clock at its rate', async () => {
  live.setLiveOverride({ time: '2026-01-15T07:30:00Z', rate: 0, weather: 'storm', sea: { level: -2, waveHeight: 3 } });
  const snap = live.liveSnapshot();
  assert.equal(snap.date.toISOString(), '2026-01-15T07:30:00.000Z');
  assert.equal(snap.weather.kind, 'storm');
  assert.equal(snap.sea.tide.level, -2);
  assert.equal(snap.sea.waveHeight, 3);
  assert.ok(snap.sun.elevation < 0); // before a January sunrise
  live.setLiveOverride({ time: '2026-01-15T07:30:00Z', rate: 3600 });
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(live.liveNow().getTime() > Date.parse('2026-01-15T07:30:00Z') + 300000); // ~7 minutes of city time
  live.clearLiveOverride();
  assert.ok(Math.abs(live.liveNow().getTime() - Date.now()) < 1000);
  assert.equal(live.liveSnapshot().weather.kind, live.CALM_WEATHER.kind);
});

test('fetching: a failed request keeps the calm defaults and says so', async () => {
  const fail = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const ok = async (url) => ({ ok: true, status: 200, json: async () => fixture(url.includes('marine') ? 'marine' : 'weather') });
  let seen = 0;
  const off = live.onLive(() => seen++);
  live.setLiveEnabled(true, fail);
  let snap = await live.refreshLive(fail);
  assert.equal(snap.status, 'error');
  assert.equal(snap.weather.kind, live.CALM_WEATHER.kind);
  snap = await live.refreshLive(ok);
  assert.equal(snap.status, 'ok');
  assert.equal(snap.sea.tide.t, undefined); // the snapshot carries the tide at its moment, not the curve
  live.setLiveEnabled(false);
  off();
  assert.ok(seen >= 3);
});

test('a fetch made before the switch goes on (behind the loading screen) is used, not repeated', async () => {
  let calls = 0;
  const ok = async (url) => { calls++; return { ok: true, status: 200, json: async () => fixture(url.includes('marine') ? 'marine' : 'weather') }; };
  await live.refreshLive(ok);
  assert.equal(calls, 2);
  assert.equal(live.liveSnapshot().status, 'off');
  live.setLiveEnabled(true, ok);
  assert.equal(calls, 2); // fresh: no second fetch
  assert.equal(live.liveSnapshot().status, 'ok');
  live.setLiveEnabled(false);
});
