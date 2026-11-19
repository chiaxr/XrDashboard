import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseForecast, upcomingHours, hourlySummary, isWet, forecastUrl } from '../lib/weather.js';

const hour = (time, extra = {}) => ({ time, temp: 5, pop: 0, precip: 0, code: 0, day: true, ...extra });
const series = (start, n, f = () => ({})) => Array.from({ length: n }, (_, i) => {
  const d = new Date(Date.parse(`${start}:00Z`) + i * 3600000).toISOString().slice(0, 13);
  return hour(`${d}:00`, f(i));
});
const day = (d) => ({ '2026-11-20': 'Fri' })[d] || d;

test('forecast URL asks for hourly data from the current hour', () => {
  const q = new URL(forecastUrl()).searchParams;
  assert.equal(q.get('forecast_hours'), '36');
  assert.match(q.get('hourly'), /precipitation_probability/);
});

test('hourly normalisation validates and clamps', () => {
  const raw = {
    current: { time: '2026-11-19T08:15', temperature_2m: 4 },
    daily: { time: ['2026-11-19'], temperature_2m_max: [10], temperature_2m_min: [2] },
    hourly: {
      time: ['2026-11-19T08:00', 'bad', '2026-11-19T10:00', '2026-11-19T11:00'],
      temperature_2m: [4, 5, null, 7],
      precipitation_probability: [130, 0, 0, -5],
      precipitation: [0.4, 0, 0, null],
      weather_code: [61, 0, 0, 2],
      is_day: [1, 1, 1, 0],
    },
  };
  const { hours } = normaliseForecast(raw);
  assert.deepEqual(hours, [
    { time: '2026-11-19T08:00', temp: 4, pop: 100, precip: 0.4, code: 61, day: true },
    { time: '2026-11-19T11:00', temp: 7, pop: 0, precip: null, code: 2, day: false },
  ]);
  assert.deepEqual(normaliseForecast({ ...raw, hourly: undefined }).hours, []);
});

test('upcoming hours start at the current hour', () => {
  const hs = series('2026-11-19T06', 36);
  const up = upcomingHours(hs, '2026-11-19T08:00');
  assert.equal(up.length, 24);
  assert.equal(up[0].time, '2026-11-19T08:00');
  assert.equal(upcomingHours(hs, '2026-11-20T12:00').length, 6, 'stale cache: only what is left');
});

test('wet hour: likely or measurable', () => {
  assert.equal(isWet(hour('x', { pop: 50 })), true);
  assert.equal(isWet(hour('x', { pop: 30, precip: 0.2 })), true);
  assert.equal(isWet(hour('x', { pop: 40, precip: 0.1 })), false);
});

test('hourly summary', () => {
  assert.equal(hourlySummary(series('2026-11-19T08', 24), day), 'Dry next 24 h');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i >= 7 && i < 10 ? { pop: 80, code: 61 } : {})), day), 'Rain from 15:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i < 3 ? { pop: 70, code: 61 } : {})), day), 'Rain until 11:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i >= 19 ? { pop: 90, code: 73 } : {})), day), 'Snow from Fri 03:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 6, () => ({ precip: 1, code: 63 })), day), 'Rain for the next 6 h');
  assert.equal(hourlySummary([], day), '');
});
