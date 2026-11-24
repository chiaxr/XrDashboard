import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseForecast, upcomingHours, hourlySummary, isWet, forecastUrl, blendTemp, dailyRainChance, trendTemps, withTrend } from '../lib/weather.js';
import { normalFor } from '../lib/normals.js';

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
  assert.equal(q.get('models'), 'best_match,ncep_nbm_conus,ecmwf_aifs025_single,ecmwf_ifs');
  assert.match(q.get('daily'), /precipitation_sum/);
});

test('temperature blend: NBM + AIFS, then IFS + AIFS, then any single model', () => {
  assert.equal(blendTemp(10, 12, 20, 30), 11);
  assert.equal(blendTemp(null, 12, 20, 30), 16);
  assert.equal(blendTemp(null, null, 20, 30), 30);
  assert.equal(blendTemp(null, null, null, null), null);
});

test('daily rain chance: model vote to day 7, then NBM, none from day 12', () => {
  assert.equal(dailyRainChance(0, [2, 0, 1.5, 0.4], 90), 50);
  assert.equal(dailyRainChance(6, [2, null, 1, 3], 10), 100);
  assert.equal(dailyRainChance(3, [2, null, null, 0], 40), 40, 'too few models: NBM chance');
  assert.equal(dailyRainChance(7, [5, 5, 5, 5], 30), 30);
  assert.equal(dailyRainChance(10, [5, 5, 5, 5], 30), 30);
  assert.equal(dailyRainChance(11, [5, 5, 5, 5], 30), null);
});

test('multi-model response is merged per variable', () => {
  const sfx = (o, model) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k === 'time' ? k : `${k}_${model}`, v]));
  const H = ['2026-11-24T08:00', '2026-11-24T09:00'];
  const D = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2026, 10, 24 + i)).toISOString().slice(0, 10));
  const n = (v) => D.map(() => v);
  const raw = {
    current: { time: '2026-11-24T08:30', temperature_2m: 10, apparent_temperature: 7, weather_code: 3 },
    hourly: {
      time: H,
      ...sfx({ temperature_2m: [10, 12], precipitation_probability: [70, 10], precipitation: [0.5, 0], weather_code: [61, 3], is_day: [1, 1] }, 'best_match'),
      ...sfx({ temperature_2m: [8, 9], precipitation_probability: [70, 10] }, 'ncep_nbm_conus'),
      ...sfx({ temperature_2m: [10, 13], precipitation_probability: [null, null] }, 'ecmwf_aifs025_single'),
      ...sfx({ temperature_2m: [0, 0] }, 'ecmwf_ifs'),
    },
    daily: {
      time: D,
      ...sfx({ temperature_2m_max: n(20), temperature_2m_min: n(0), weather_code: n(61), precipitation_probability_max: n(55), precipitation_sum: n(3), sunrise: n('2026-11-24T06:55'), sunset: n('2026-11-24T16:38') }, 'best_match'),
      ...sfx({ temperature_2m_max: n(10).map((v, i) => (i < 10 ? v : null)), temperature_2m_min: n(2).map((v, i) => (i < 10 ? v : null)), precipitation_probability_max: n(40).map((v, i) => (i < 10 ? v : null)), precipitation_sum: n(0) }, 'ncep_nbm_conus'),
      ...sfx({ temperature_2m_max: n(12), temperature_2m_min: n(4), precipitation_sum: n(0) }, 'ecmwf_aifs025_single'),
      ...sfx({ temperature_2m_max: n(16), temperature_2m_min: n(6), precipitation_sum: n(2) }, 'ecmwf_ifs'),
    },
  };
  const { current, hours, days } = normaliseForecast(raw);
  assert.deepEqual(hours.map((h) => h.temp), [9, 11]);
  assert.deepEqual(hours.map((h) => h.pop), [70, 10]);
  assert.equal(hours[0].code, 61);
  // Blend is 1 °C below best match at 08:00 and at 09:00, so the current reading moves by 1.
  assert.equal(current.temp, 9);
  assert.equal(current.feels, 6);
  assert.deepEqual([days[0].hi, days[0].lo], [11, 3], 'NBM + AIFS');
  assert.deepEqual([days[10].hi, days[10].lo], [14, 5], 'IFS + AIFS after NBM ends');
  assert.equal(days[0].pop, 50, 'two of four models wet');
  assert.equal(days[8].pop, 40, 'NBM chance');
  assert.equal(days[11].pop, null, 'no rain chance from day 12');
  assert.equal(days[0].sunset, '16:38');
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

test('wet hour: likely; rain amount only without a chance figure', () => {
  assert.equal(isWet(hour('x', { pop: 50 })), true);
  assert.equal(isWet(hour('x', { pop: 30, precip: 0.2 })), false);
  assert.equal(isWet(hour('x', { pop: null, precip: 0.2 })), true);
  assert.equal(isWet(hour('x', { pop: null, precip: 0.1 })), false);
});

test('hourly summary', () => {
  assert.equal(hourlySummary(series('2026-11-19T08', 24), day), 'Dry next 24 h');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i >= 7 && i < 10 ? { pop: 80, code: 61 } : {})), day), 'Rain from 15:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i < 3 ? { pop: 70, code: 61 } : {})), day), 'Rain until 11:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 24, (i) => (i >= 19 ? { pop: 90, code: 73 } : {})), day), 'Snow from Fri 03:00');
  assert.equal(hourlySummary(series('2026-11-19T08', 6, () => ({ pop: 60, precip: 1, code: 63 })), day), 'Rain for the next 6 h');
  assert.equal(hourlySummary([], day), '');
});

test('normals table covers every date', () => {
  const jan = normalFor('2026-01-20'), jul = normalFor('2026-07-20');
  assert.ok(jul.hi > jan.hi + 15 && jul.lo > jan.lo + 15, 'summer much warmer than winter');
  assert.ok(jan.hi > jan.lo);
  assert.deepEqual(normalFor('2028-02-29'), normalFor('2026-02-28'));
  assert.equal(normalFor('bad'), null);
});

test('trend estimate: normal shifted by the week\'s anomaly', () => {
  const weeks = [{ start: '2026-12-07', anomaly: 2 }, { start: '2026-12-14', anomaly: -1.5 }];
  const n = normalFor('2026-12-09');
  assert.deepEqual(trendTemps('2026-12-09', weeks), { hi: Math.round((n.hi + 2) * 10) / 10, lo: Math.round((n.lo + 2) * 10) / 10 });
  assert.equal(trendTemps('2026-12-13', weeks).hi, Math.round((normalFor('2026-12-13').hi + 2) * 10) / 10, 'Sunday is in the week');
  assert.equal(trendTemps('2026-12-14', weeks).hi, Math.round((normalFor('2026-12-14').hi - 1.5) * 10) / 10);
  assert.equal(trendTemps('2026-12-30', weeks), null, 'no outlook week');
  assert.equal(trendTemps('2026-12-09', null), null);
});

test('days 12+ take the trend estimate when a week covers them', () => {
  const days = ['2026-11-24', '2026-12-04', '2026-12-05', '2026-12-09'].map((date) => ({ date, hi: 30, lo: 20, code: 3, pop: null }));
  const out = withTrend(days, [{ start: '2026-11-30', anomaly: 1 }], '2026-11-24');
  assert.deepEqual(out.slice(0, 2), days.slice(0, 2), 'days 1-11 keep the model values');
  assert.equal(out[2].trend, true, 'day 12');
  assert.equal(out[2].hi, Math.round((normalFor('2026-12-05').hi + 1) * 10) / 10);
  assert.equal(out[2].code, 3, 'other fields kept');
  assert.deepEqual(out[3], days[3], 'no week covering it: model values');
});
