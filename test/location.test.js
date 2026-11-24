import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceKm, validPlace, cityRadius, activeLocation, locationKey, nearHome, nearestCity, placeName, geoErrorText, locationSettings,
  isSettled, SETTLE_MS,
} from '../lib/location.js';
import { normalsList, findNormals, withNormals, NORMALS_KEEP } from '../lib/climate.js';

const PHL = { latitude: 39.95, longitude: -75.17 };

test('distance', () => {
  assert.ok(Math.abs(distanceKm(PHL, { latitude: 40.71, longitude: -74.01 }) - 130) < 5, 'Philadelphia–New York ≈ 130 km');
  assert.equal(distanceKm(PHL, PHL), 0);
});

test('places are validated and rounded to ~1 km', () => {
  assert.deepEqual(validPlace({ name: '  Singapore ', country: 'SG', latitude: 1.28967, longitude: 103.85007 }),
    { name: 'Singapore', country: 'SG', latitude: 1.29, longitude: 103.85 });
  assert.equal(validPlace({ name: 'x', latitude: 91, longitude: 0 }), null);
  assert.equal(validPlace({ latitude: '1', longitude: 2 }), null);
  assert.equal(validPlace(null), null);
  assert.equal(validPlace({ latitude: 1, longitude: 2 }).name, 'Current location');
});

test('active location: manual place, then detected, then Philadelphia', () => {
  const sg = { name: 'Singapore', latitude: 1.29, longitude: 103.85 };
  const nyc = { name: 'New York City', latitude: 40.71, longitude: -74.01 };
  assert.equal(activeLocation({ location: { mode: 'manual', place: sg } }, { place: nyc }).name, 'Singapore');
  assert.equal(activeLocation({ location: { mode: 'auto', place: sg } }, { place: nyc }).source, 'auto');
  assert.equal(activeLocation({ location: { mode: 'auto' } }, null).source, 'default');
  assert.equal(activeLocation({ location: { mode: 'manual', place: null } }, { place: nyc }).source, 'default', 'manual without a place');
  assert.equal(activeLocation(undefined, undefined).name, 'Philadelphia');
  assert.deepEqual(locationSettings({}), { mode: 'auto', place: null });
});

test('location key and home area', () => {
  assert.equal(locationKey({ latitude: 1.2896, longitude: 103.85 }), '1.29,103.85');
  assert.equal(nearHome({ latitude: 39.87, longitude: -75.24 }), true, 'the airport');
  assert.equal(nearHome({ latitude: 1.29, longitude: 103.85 }), false);
});

test('nearest city and its name', () => {
  const lines = 'Philadelphia\tUS\t39.95\t-75.16\t1567\nCamden\tUS\t39.93\t-75.12\t72\nSingapore\tSG\t1.29\t103.85\t5638\nbad line';
  assert.equal(nearestCity(lines, 39.96, -75.17).name, 'Philadelphia');
  assert.equal(nearestCity(lines, 39.87, -75.24).name, 'Philadelphia', 'the airport is inside the big city\'s area');
  assert.equal(nearestCity(lines, 39.93, -75.12).name, 'Camden', 'a town centre keeps its own name');
  assert.equal(nearestCity(lines, 39.6, -74.6).name, 'Camden', 'outside every area: the nearest');
  assert.equal(nearestCity(lines, 1.35, 103.8).name, 'Singapore');
  assert.equal(placeName(nearestCity(lines, 1.35, 103.8)), 'Singapore');
  assert.equal(placeName({ name: 'Camden', km: 40, radius: 3 }), 'Near Camden');
  assert.equal(placeName({ name: 'Singapore', km: 28, radius: 30 }), 'Singapore', 'inside a big city\'s area');
  assert.equal(placeName(null), 'Current location');
  assert.equal(placeName({ name: 'Mastic', km: 1145, radius: 3 }), 'Current location', 'nowhere near a city');
  assert.equal(nearestCity('', 0, 0), null);
});

test('catchment radius grows with population', () => {
  assert.equal(cityRadius(20), 3);
  assert.ok(cityRadius(1567) > 15 && cityRadius(1567) < 16.5);
});

test('geolocation errors read plainly', () => {
  assert.match(geoErrorText({ code: 1 }), /Location Services/);
  assert.match(geoErrorText({ code: 3 }), /timed out/);
  assert.match(geoErrorText({ code: 2, message: 'boom' }), /unavailable: boom/);
});

test('normals wait until a detected place has settled', () => {
  const now = Date.UTC(2026, 10, 24, 12);
  const auto = { name: 'Lancaster', latitude: 40.04, longitude: -76.31, source: 'auto' };
  assert.equal(isSettled(auto, { since: now - SETTLE_MS + 60000 }, now), false, 'just arrived');
  assert.equal(isSettled(auto, { since: now - SETTLE_MS }, now), true, '12 h here');
  assert.equal(isSettled(auto, { checkedAt: now - 2 * SETTLE_MS }, now), false, 'no arrival time yet');
  assert.equal(isSettled({ ...auto, source: 'manual' }, {}, now), true, 'chosen in Options: at once');
  assert.equal(isSettled({ ...auto, source: 'default' }, null, now), true);
});

test('saved normals: reuse within 50 km, newest first, capped', () => {
  const table = (name, latitude, longitude) => ({ name, latitude, longitude, hi: Array(365).fill(30), lo: Array(365).fill(24) });
  const sg = table('Singapore', 1.28, 103.85);
  const kl = table('Kuala Lumpur', 3.14, 101.69);
  assert.deepEqual(normalsList(null), []);
  assert.deepEqual(normalsList(sg), [sg], 'a lone table from before the cache counts as one place');
  assert.deepEqual(normalsList({ places: [sg, { name: 'bad', latitude: 1, longitude: 1, hi: [] }, kl] }), [sg, kl]);

  assert.equal(findNormals([kl, sg], { latitude: 1.35, longitude: 103.99 }), sg, 'Changi, ~17 km from the saved point');
  assert.equal(findNormals([kl, sg], { latitude: 1.49, longitude: 103.74 }), sg, 'Johor Bahru, ~26 km');
  assert.equal(findNormals([kl, sg], { latitude: 2.19, longitude: 102.25 }), null, 'Malacca: nothing within 50 km');
  assert.equal(findNormals([kl, sg], { latitude: 999 }), null);

  assert.deepEqual(withNormals([kl, sg], sg), [sg, kl], 'a reused place moves to the front');
  const many = Array.from({ length: 15 }, (_, i) => table(`P${i}`, -60 + i * 5, 0));
  const kept = withNormals(many.slice(1), many[0]);
  assert.equal(kept.length, NORMALS_KEEP);
  assert.equal(kept[0], many[0]);
});
