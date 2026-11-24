// Open-Meteo forecast (current + hourly + 16 days) and seasonal outlook (EC46 weekly + SEAS5 monthly).

import { HOSTS, LOCATION, TZ } from './config.js';
import { fetchJson } from './net.js';
import { normalFor } from './normals.js';
import { addDays, daysBetween } from './time.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHour = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(v);
const hm = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(11, 16) : null);

export const FORECAST_HOURS = 36;

// Models chosen by scoring a year of archived forecasts against Philadelphia airport
// observations (docs/weather-models.md). One request returns every model, with keys
// suffixed by model name (`temperature_2m_ncep_nbm_conus`).
export const MODELS = {
  bm: 'best_match', // HRRR then GFS here; weather codes, rain amounts, sunrise/sunset, day 16
  nbm: 'ncep_nbm_conus', // NOAA National Blend: temperature (with AIFS) and rain chance, ~11 days
  aifs: 'ecmwf_aifs025_single', // ECMWF AI model: temperature, 15 days
  ifs: 'ecmwf_ifs', // ECMWF IFS: temperature with AIFS once NBM ends
};

export function forecastUrl() {
  const q = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    forecast_days: '16',
    timezone: TZ,
    models: Object.values(MODELS).join(','),
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset',
    // Hourly from the current hour; 36 h so a cached copy still covers the next 24 h.
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,is_day',
    forecast_hours: String(FORECAST_HOURS),
  });
  return `${HOSTS.forecast}/v1/forecast?${q}`;
}

/** One model's column from a multi-model response; a single-model response has bare keys (best match). */
function col(section, name, model) {
  const v = section?.[`${name}_${model}`] ?? (model === MODELS.bm ? section?.[name] : undefined);
  return Array.isArray(v) ? v : [];
}

const round1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

/**
 * Temperature from the models' values for one time: the NBM + AIFS average (most accurate
 * through day 11), then IFS + AIFS (days 12–15), then whatever single value exists.
 */
export function blendTemp(nbm, aifs, ifs, bm) {
  if (nbm != null && aifs != null) return (nbm + aifs) / 2;
  if (ifs != null && aifs != null) return (ifs + aifs) / 2;
  return bm ?? nbm ?? aifs ?? ifs ?? null;
}

/**
 * Daily rain chance (%) for the day `index` days from today. Days 1–7: the share of models
 * forecasting ≥ 1 mm (needs at least three), which beat any single model's chance; then
 * NBM's chance; from day 12 nothing beats the usual odds, so none is shown.
 */
export function dailyRainChance(index, sums, pop) {
  if (index >= 11) return null;
  if (index < 7) {
    const v = sums.filter((s) => s != null);
    if (v.length >= 3) return Math.round((100 * v.filter((s) => s >= 1).length) / v.length);
  }
  return pop;
}

/**
 * The blend's offset from best match at `time` ('YYYY-MM-DDTHH:MM'), interpolated between the
 * surrounding hours. `current` only comes from best match, so this moves it onto the blend.
 */
function currentShift(time, htimes, blended, base) {
  if (typeof time !== 'string') return 0;
  const i = htimes.indexOf(`${time.slice(0, 13)}:00`);
  if (i < 0) return 0;
  const diff = (j) => {
    const b = blended(j), a = base(j);
    return b != null && a != null ? b - a : null;
  };
  const d0 = diff(i), d1 = diff(i + 1);
  if (d0 == null) return 0;
  const f = (Number(time.slice(14, 16)) || 0) / 60;
  return d1 == null ? d0 : d0 + (d1 - d0) * f;
}

export function seasonalUrl() {
  // timezone=GMT keeps weekly/monthly period starts on their calendar dates.
  const q = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    timezone: 'GMT',
    weekly: 'temperature_max6h_2m_mean,temperature_min6h_2m_mean,temperature_2m_anomaly,precipitation_mean,precipitation_anomaly',
    monthly: 'temperature_2m_anomaly,precipitation_mean,precipitation_anomaly',
  });
  return `${HOSTS.seasonal}/v1/seasonal?${q}`;
}

export async function fetchForecast() {
  return normaliseForecast(await fetchJson(forecastUrl()));
}

export async function fetchOutlook() {
  return normaliseOutlook(await fetchJson(seasonalUrl()));
}

export function normaliseForecast(raw) {
  if (!raw || typeof raw !== 'object' || raw.error) throw new Error(`Open-Meteo: ${raw?.reason || 'bad response'}`);
  const { bm, nbm, aifs, ifs } = MODELS;
  const tempAt = (section, name, i) => blendTemp(...[nbm, aifs, ifs, bm].map((m) => num(col(section, name, m)[i])));

  const hr = raw.hourly || {};
  const htimes = Array.isArray(hr.time) ? hr.time : [];
  const c = raw.current || {};
  const shift = currentShift(c.time, htimes, (i) => tempAt(hr, 'temperature_2m', i), (i) => num(col(hr, 'temperature_2m', bm)[i]));
  const nowTemp = num(c.temperature_2m), nowFeels = num(c.apparent_temperature);
  const current = {
    time: typeof c.time === 'string' ? c.time.slice(0, 16) : null,
    temp: nowTemp == null ? null : round1(nowTemp + shift),
    feels: nowFeels == null ? null : round1(nowFeels + shift),
    code: num(c.weather_code),
    wind: num(c.wind_speed_10m),
    windDir: num(c.wind_direction_10m),
  };
  if (current.temp == null) throw new Error('Open-Meteo: missing current temperature');

  const d = raw.daily || {};
  const days = [];
  const times = Array.isArray(d.time) ? d.time : [];
  for (let i = 0; i < times.length && i < 16; i++) {
    if (!isDate(times[i])) continue;
    const hi = round1(tempAt(d, 'temperature_2m_max', i)), lo = round1(tempAt(d, 'temperature_2m_min', i));
    if (hi == null || lo == null) continue;
    const sums = [bm, nbm, aifs, ifs].map((m) => num(col(d, 'precipitation_sum', m)[i]));
    const pop = num(col(d, 'precipitation_probability_max', nbm)[i]) ?? num(col(d, 'precipitation_probability_max', bm)[i]);
    days.push({
      date: times[i], hi, lo,
      code: num(col(d, 'weather_code', bm)[i]),
      pop: dailyRainChance(i, sums, pop),
      sunrise: hm(col(d, 'sunrise', bm)[i]),
      sunset: hm(col(d, 'sunset', bm)[i]),
    });
  }
  if (!days.length) throw new Error('Open-Meteo: no daily data');

  const hours = [];
  for (let i = 0; i < htimes.length && hours.length < FORECAST_HOURS; i++) {
    const temp = round1(tempAt(hr, 'temperature_2m', i));
    if (!isHour(htimes[i]) || temp == null) continue;
    // Rain chance is NBM's (best match serves the same numbers in the US).
    const pop = num(col(hr, 'precipitation_probability', nbm)[i]) ?? num(col(hr, 'precipitation_probability', bm)[i]);
    const precip = num(col(hr, 'precipitation', bm)[i]);
    hours.push({
      time: htimes[i], temp,
      pop: pop == null ? null : Math.max(0, Math.min(100, pop)),
      precip: precip == null ? null : Math.max(0, precip),
      code: num(col(hr, 'weather_code', bm)[i]),
      day: col(hr, 'is_day', bm)[i] !== 0,
    });
  }
  return { current, days, hours };
}

const SNOW_CODES = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
/**
 * Rain or snow worth mentioning in an hour: likely (≥ 50%). The rain amount (HRRR) only counts
 * when there is no chance figure; on its own it times rain far worse than NBM's chance.
 */
export const isWet = (h) => (h.pop != null ? h.pop >= 50 : (h.precip ?? 0) >= 0.2);

/** Hours from the current local hour ('YYYY-MM-DDTHH:00'), at most n. */
export function upcomingHours(hours, nowHour, n = 24) {
  return (Array.isArray(hours) ? hours : []).filter((h) => h.time >= nowHour).slice(0, n);
}

/**
 * One-line precipitation outlook for an hourly window:
 * "Rain until 15:00", "Snow from Fri 03:00", "Rain all day", "Dry next 24 h".
 * `dayLabel(dateStr)` names another day (e.g. "Fri"); times on the first day have no day prefix.
 */
export function hourlySummary(hours, dayLabel = (d) => d) {
  if (!hours.length) return '';
  const first = hours[0].time.slice(0, 10);
  const at = (h) => (h.time.slice(0, 10) === first ? h.time.slice(11, 16) : `${dayLabel(h.time.slice(0, 10))} ${h.time.slice(11, 16)}`);
  const what = (list) => (list.some((h) => SNOW_CODES(h.code)) && list.filter((h) => SNOW_CODES(h.code)).length >= list.filter((h) => !SNOW_CODES(h.code)).length ? 'Snow' : 'Rain');
  const span = `${hours.length} h`;
  if (isWet(hours[0])) {
    const end = hours.findIndex((h) => !isWet(h));
    const wet = hours.slice(0, end === -1 ? hours.length : end);
    return end === -1 ? `${what(wet)} for the next ${span}` : `${what(wet)} until ${at(hours[end])}`;
  }
  const start = hours.findIndex(isWet);
  if (start === -1) return `Dry next ${span}`;
  const rest = hours.slice(start);
  const stop = rest.findIndex((h) => !isWet(h));
  return `${what(rest.slice(0, stop === -1 ? rest.length : stop))} from ${at(hours[start])}`;
}

export function normaliseOutlook(raw) {
  if (!raw || typeof raw !== 'object' || raw.error) throw new Error(`Open-Meteo seasonal: ${raw?.reason || 'bad response'}`);
  const w = raw.weekly || {}, m = raw.monthly || {};
  const weeks = [];
  (Array.isArray(w.time) ? w.time : []).forEach((t, i) => {
    const row = {
      start: t,
      hi: num(w.temperature_max6h_2m_mean?.[i]),
      lo: num(w.temperature_min6h_2m_mean?.[i]),
      anomaly: num(w.temperature_2m_anomaly?.[i]),
      precip: num(w.precipitation_mean?.[i]),
      precipAnomaly: num(w.precipitation_anomaly?.[i]),
    };
    if (isDate(t) && row.anomaly != null) weeks.push(row);
  });
  const months = [];
  (Array.isArray(m.time) ? m.time : []).forEach((t, i) => {
    const row = {
      start: t,
      anomaly: num(m.temperature_2m_anomaly?.[i]),
      precip: num(m.precipitation_mean?.[i]),
      precipAnomaly: num(m.precipitation_anomaly?.[i]),
    };
    if (isDate(t) && row.anomaly != null) months.push(row);
  });
  if (!weeks.length && !months.length) throw new Error('Open-Meteo seasonal: no data');
  return { weeks, months };
}

/**
 * First day ahead (1 = today) whose high/low come from the trend estimate: from day 12 the
 * models' daily temperatures were worse than the plain normal (docs/weather-models.md).
 */
export const TREND_FROM_DAY = 12;

/**
 * Trend estimate for a date: the KPHL normal high/low shifted by the EC46 temperature anomaly
 * of the week containing it. Null when no outlook week covers the date.
 */
export function trendTemps(date, weeks) {
  const n = normalFor(date);
  const w = (Array.isArray(weeks) ? weeks : []).find((x) => x.start <= date && date < addDays(x.start, 7));
  if (!n || w?.anomaly == null) return null;
  return { hi: round1(n.hi + w.anomaly), lo: round1(n.lo + w.anomaly) };
}

/** Forecast days with the high/low from TREND_FROM_DAY on replaced by the trend estimate (`trend: true`). */
export function withTrend(days, weeks, today) {
  return (Array.isArray(days) ? days : []).map((d) => {
    if (daysBetween(today, d.date) + 1 < TREND_FROM_DAY) return d;
    const t = trendTemps(d.date, weeks);
    return t ? { ...d, ...t, trend: true } : d;
  });
}

/** 'wetter' | 'drier' | 'normal' from forecast mean and anomaly (mm). */
export function precipTendency(mean, anomaly) {
  if (mean == null || anomaly == null) return null;
  const usual = mean - anomaly;
  const ratio = usual > 1 ? anomaly / usual : anomaly / 5;
  if (ratio > 0.2) return 'wetter';
  if (ratio < -0.2) return 'drier';
  return 'normal';
}

// WMO weather interpretation codes → icon kind + description.
export function describeCode(code) {
  if (code == null) return { kind: 'cloud', text: '—' };
  if (code === 0) return { kind: 'sun', text: 'clear' };
  if (code === 1) return { kind: 'sun', text: 'mostly clear' };
  if (code === 2) return { kind: 'partly', text: 'partly cloudy' };
  if (code === 3) return { kind: 'cloud', text: 'overcast' };
  if (code === 45 || code === 48) return { kind: 'cloud', text: 'fog' };
  if (code >= 51 && code <= 57) return { kind: 'rain', text: 'drizzle' };
  if (code >= 61 && code <= 67) return { kind: 'rain', text: code >= 66 ? 'freezing rain' : 'rain' };
  if (code >= 71 && code <= 77) return { kind: 'snow', text: 'snow' };
  if (code >= 80 && code <= 82) return { kind: 'rain', text: 'showers' };
  if (code === 85 || code === 86) return { kind: 'snow', text: 'snow showers' };
  if (code >= 95) return { kind: 'rain', text: 'thunderstorm' };
  return { kind: 'cloud', text: 'cloudy' };
}

export function compass(deg) {
  if (deg == null) return '';
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return dirs[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}
