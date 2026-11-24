// Daily normal high/low tables ({ hi: [365], lo: [365] }, °C): the bundled KPHL table
// (lib/normals.js) or one computed from 20 years of Open-Meteo daily history for elsewhere.

import { distanceKm, validPlace } from './location.js';

/** A saved table is reused anywhere within this distance (ERA5's grid is ~30 km). */
export const NORMALS_REUSE_KM = 50;
/** How many places' tables to keep. */
export const NORMALS_KEEP = 10;

const CUM = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

/** 0–364 for 'YYYY-MM-DD'; 29 Feb counts as 28 Feb. Null for a malformed date. */
export function dayIndex(date) {
  const m = Number(String(date).slice(5, 7)), d = Number(String(date).slice(8, 10));
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  return CUM[m - 1] + Math.min(d, m === 2 ? 28 : 31) - 1;
}

/** Normal high/low for a date from a table, or null. */
export function normalFor(date, table) {
  const i = dayIndex(date);
  if (i == null || !validTable(table)) return null;
  return { hi: table.hi[i], lo: table.lo[i] };
}

export function validTable(t) {
  const ok = (a) => Array.isArray(a) && a.length === 365 && a.every((v) => typeof v === 'number' && Number.isFinite(v));
  return !!t && ok(t.hi) && ok(t.lo);
}

/**
 * Normals from daily history: each calendar day's mean high/low over ±15 days of every year,
 * rounded to 0.1 °C. Null with less than about five years of data.
 */
export function normalsFromDaily(times, highs, lows) {
  const hi = Array.from({ length: 365 }, () => [0, 0]), lo = Array.from({ length: 365 }, () => [0, 0]);
  let n = 0;
  for (let k = 0; k < (Array.isArray(times) ? times.length : 0); k++) {
    const i = dayIndex(times[k]);
    const a = highs?.[k], b = lows?.[k];
    if (i == null || typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) continue;
    hi[i][0] += a; hi[i][1]++;
    lo[i][0] += b; lo[i][1]++;
    n++;
  }
  if (n < 5 * 365) return null;
  const smooth = (src) => Array.from({ length: 365 }, (_, i) => {
    let sum = 0, cnt = 0;
    for (let k = -15; k <= 15; k++) {
      const [s, c] = src[(i + k + 365) % 365];
      sum += s; cnt += c;
    }
    return Math.round((sum / cnt) * 10) / 10;
  });
  return { hi: smooth(hi), lo: smooth(lo) };
}

// Saved tables for places away from Philadelphia: storage `normals.data = { places: [...] }`,
// each { name, latitude, longitude, hi, lo }, most recently used first.

/** The saved tables from a stored record's data (a lone table from older versions counts as one). */
export function normalsList(data) {
  const list = Array.isArray(data?.places) ? data.places : data ? [data] : [];
  return list.filter((t) => validPlace(t) && validTable(t)).slice(0, NORMALS_KEEP);
}

/** The nearest saved table within NORMALS_REUSE_KM of the place, or null. */
export function findNormals(list, loc) {
  if (!validPlace(loc)) return null;
  let best = null, bestKm = Infinity;
  for (const t of list) {
    const km = distanceKm(t, loc);
    if (km <= NORMALS_REUSE_KM && km < bestKm) { best = t; bestKm = km; }
  }
  return best;
}

/** The list with `table` first (newly fetched or just used), capped at NORMALS_KEEP. */
export function withNormals(list, table) {
  return [table, ...list.filter((t) => t !== table && distanceKm(t, table) > NORMALS_REUSE_KM)].slice(0, NORMALS_KEEP);
}
