// Open-Meteo forecast (current + hourly + 16 days) and seasonal outlook (EC46 weekly + SEAS5 monthly).

import { HOSTS, LOCATION, TZ } from './config.js';
import { fetchJson } from './net.js';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isHour = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:00$/.test(v);
const hm = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) ? v.slice(11, 16) : null);

export const FORECAST_HOURS = 36;

export function forecastUrl() {
  const q = new URLSearchParams({
    latitude: String(LOCATION.latitude),
    longitude: String(LOCATION.longitude),
    forecast_days: '16',
    timezone: TZ,
    current: 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    // Hourly from the current hour; 36 h so a cached copy still covers the next 24 h.
    hourly: 'temperature_2m,precipitation_probability,precipitation,weather_code,is_day',
    forecast_hours: String(FORECAST_HOURS),
  });
  return `${HOSTS.forecast}/v1/forecast?${q}`;
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
  const c = raw.current || {};
  const current = {
    time: typeof c.time === 'string' ? c.time.slice(0, 16) : null,
    temp: num(c.temperature_2m),
    feels: num(c.apparent_temperature),
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
    const hi = num(d.temperature_2m_max?.[i]), lo = num(d.temperature_2m_min?.[i]);
    if (hi == null || lo == null) continue;
    days.push({
      date: times[i], hi, lo,
      code: num(d.weather_code?.[i]),
      pop: num(d.precipitation_probability_max?.[i]),
      sunrise: hm(d.sunrise?.[i]),
      sunset: hm(d.sunset?.[i]),
    });
  }
  if (!days.length) throw new Error('Open-Meteo: no daily data');
  const hr = raw.hourly || {};
  const hours = [];
  const htimes = Array.isArray(hr.time) ? hr.time : [];
  for (let i = 0; i < htimes.length && hours.length < FORECAST_HOURS; i++) {
    const temp = num(hr.temperature_2m?.[i]);
    if (!isHour(htimes[i]) || temp == null) continue;
    const pop = num(hr.precipitation_probability?.[i]);
    const precip = num(hr.precipitation?.[i]);
    hours.push({
      time: htimes[i], temp,
      pop: pop == null ? null : Math.max(0, Math.min(100, pop)),
      precip: precip == null ? null : Math.max(0, precip),
      code: num(hr.weather_code?.[i]),
      day: hr.is_day?.[i] !== 0,
    });
  }
  return { current, days, hours };
}

const SNOW_CODES = (c) => (c >= 71 && c <= 77) || c === 85 || c === 86;
/** Rain or snow worth mentioning in an hour: likely (≥ 50%) or measurable (≥ 0.2 mm). */
export const isWet = (h) => (h.pop ?? 0) >= 50 || (h.precip ?? 0) >= 0.2;

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
