// Timezone-aware date helpers. All "date strings" are 'YYYY-MM-DD' in the given zone
// (America/New_York unless stated). Pure functions; safe to unit-test in Node.

import { TZ } from './config.js';

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Wall-clock parts of an instant in a timezone. */
export function zonedParts(ms, tz = TZ) {
  const p = {};
  for (const { type, value } of partsFormatter(tz).formatToParts(new Date(ms))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour % 24, minute: +p.minute, second: +p.second,
    weekday: WEEKDAYS.indexOf(p.weekday),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function dateStr(ms, tz = TZ) {
  const p = zonedParts(ms, tz);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** Minutes since local midnight. */
export function minutesOfDay(ms, tz = TZ) {
  const p = zonedParts(ms, tz);
  return p.hour * 60 + p.minute;
}

export function parseDateStr(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? { year: +m[1], month: +m[2], day: +m[3] } : null;
}

export function addDays(s, n) {
  const p = parseDateStr(s);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return d.toISOString().slice(0, 10);
}

export function weekdayOf(s) {
  const p = parseDateStr(s);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

/** Whole days from a to b (b − a). */
export function daysBetween(a, b) {
  const pa = parseDateStr(a), pb = parseDateStr(b);
  return Math.round((Date.UTC(pb.year, pb.month - 1, pb.day) - Date.UTC(pa.year, pa.month - 1, pa.day)) / 86400000);
}

function offsetMs(ms, tz) {
  const p = zonedParts(ms, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant of a wall-clock time in a timezone (DST-safe for non-ambiguous times). */
export function zonedToInstant(s, minutes = 0, tz = TZ) {
  const p = parseDateStr(s);
  const wall = Date.UTC(p.year, p.month - 1, p.day, 0, minutes);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}

export function fmtHM(min) {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
}

export function fmtClock(ms, tz = TZ) {
  return fmtHM(minutesOfDay(ms, tz));
}

/** "Thu 19" */
export function fmtDayLabel(s) {
  return `${WEEKDAYS[weekdayOf(s)]} ${parseDateStr(s).day}`;
}

/** "18 Nov" */
export function fmtShortDate(s) {
  const p = parseDateStr(s);
  return `${p.day} ${MONTHS[p.month - 1]}`;
}

/** "Thu 19 Nov 2026" */
export function fmtLongDate(s) {
  const p = parseDateStr(s);
  return `${WEEKDAYS[weekdayOf(s)]} ${p.day} ${MONTHS[p.month - 1]} ${p.year}`;
}

/** "23–29 Nov" or "28 Dec–3 Jan" for a 7-day week starting on s. */
export function fmtWeekRange(s) {
  const e = addDays(s, 6);
  const a = parseDateStr(s), b = parseDateStr(e);
  return a.month === b.month
    ? `${a.day}–${b.day} ${MONTHS[b.month - 1]}`
    : `${a.day} ${MONTHS[a.month - 1]}–${b.day} ${MONTHS[b.month - 1]}`;
}

export function monthName(s) {
  return MONTHS_LONG[parseDateStr(s).month - 1];
}

export function tzAbbrev(ms, tz = TZ) {
  const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
    .formatToParts(new Date(ms)).find((p) => p.type === 'timeZoneName');
  return part ? part.value : '';
}

/** "45m", "1h 30m" style durations; < 2h shown as minutes, as in the design. */
export function fmtDuration(min, { hoursFrom = 120 } = {}) {
  const m = Math.max(0, Math.round(min));
  if (m < hoursFrom) return `${m}m`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h}h ${pad2(r)}m` : `${h}h`;
}

/** Always "Xh YYm" (footer stats). */
export function fmtHours(min) {
  const m = Math.max(0, Math.round(min));
  return `${Math.floor(m / 60)}h ${pad2(m % 60)}m`;
}

/** "8:42 AM" — 12-hour clock (header only; the rest of the UI uses 24-hour times). */
export function fmtClock12(ms, tz = TZ) {
  const p = zonedParts(ms, tz);
  const h = p.hour % 12 || 12;
  return `${h}:${pad2(p.minute)} ${p.hour < 12 ? 'AM' : 'PM'}`;
}

/** "Fri" — weekday of an instant in a timezone. */
export function fmtWeekday(ms, tz = TZ) {
  return WEEKDAYS[zonedParts(ms, tz).weekday];
}

/** "Fri 20 Nov" */
export function fmtDayMonth(s) {
  const p = parseDateStr(s);
  return `${WEEKDAYS[weekdayOf(s)]} ${p.day} ${MONTHS[p.month - 1]}`;
}

/** Monday on or before date s. */
export function mondayOf(s) {
  return addDays(s, -((weekdayOf(s) + 6) % 7));
}
