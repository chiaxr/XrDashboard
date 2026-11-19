// Google Calendar via the secret iCal address. Parsing and recurrence expansion use ical.js.

import ICAL from '../vendor/ical.js/ical.js';
import { TZ } from './config.js';
import { addDays, dateStr, minutesOfDay, zonedToInstant } from './time.js';
import { fetchText } from './net.js';

const ICAL_URL_RE = /^https:\/\/calendar\.google\.com\/calendar\/ical\/[^/?#]+\/[^/?#]+\/basic\.ics$/;
const MAX_ITERATIONS = 20000;
const MAX_EVENTS = 3000;
// Days kept around today for the schedule's day navigation.
export const DAYS_BACK = 7;
export const DAYS_AHEAD = 30;

export function isValidIcalUrl(url) {
  return typeof url === 'string' && ICAL_URL_RE.test(url.trim());
}

/** The calendar owner's address, taken from the URL path (used to drop declined invites). */
export function ownerFromUrl(url) {
  try {
    const seg = new URL(url).pathname.split('/')[3] || '';
    const id = decodeURIComponent(seg).toLowerCase();
    return id.includes('@') ? id : null;
  } catch {
    return null;
  }
}

export async function fetchCalendar(url, now = Date.now()) {
  if (!isValidIcalUrl(url)) throw new Error('iCal address must be a Google Calendar "secret address in iCal format"');
  const text = await fetchText(url.trim());
  if (!/BEGIN:VCALENDAR/.test(text.slice(0, 2000))) throw new Error('Response is not an iCal calendar');
  const today = dateStr(now);
  return parseCalendar(text, {
    today, from: addDays(today, -DAYS_BACK), days: DAYS_BACK + DAYS_AHEAD + 1, owner: ownerFromUrl(url),
  });
}

/**
 * Merge several parsed calendars. Each input: { id, name, color, result | error, previous }.
 * Failed calendars keep their previous events. Events seen in two calendars (same UID and
 * time — e.g. an invite on a shared calendar) are shown once, from the first calendar.
 */
export function mergeCalendars(today, inputs) {
  const seen = new Set();
  const events = [];
  const calendars = [];
  for (const [index, c] of inputs.entries()) {
    const evs = c.result ? c.result.events : (c.previous || []);
    for (const e of evs) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      events.push({ ...e, cal: index });
    }
    calendars.push({
      id: c.id, color: c.color,
      name: c.name || c.result?.name || c.previousName || `Calendar ${index + 1}`,
      ...(c.error ? { error: String(c.error).slice(0, 200) } : {}),
    });
  }
  const ranges = inputs.map((c) => c.result).filter(Boolean);
  events.sort((a, b) => a.date.localeCompare(b.date) || (b.allDay - a.allDay) || a.startMin - b.startMin || a.endMin - b.endMin);
  return {
    today,
    from: ranges[0]?.from || today,
    to: ranges[0]?.days?.[ranges[0].days.length - 1] || today,
    calendars,
    events,
  };
}

const ianaCache = new Map();
function isIana(tz) {
  if (!tz) return false;
  if (!ianaCache.has(tz)) {
    let ok = true;
    try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { ok = false; }
    ianaCache.set(tz, ok);
  }
  return ianaCache.get(tz);
}

const pad2 = (n) => String(n).padStart(2, '0');
const timeDate = (t) => `${t.year}-${pad2(t.month)}-${pad2(t.day)}`;

/** Absolute instant (ms) for an ical.js date-time, given the TZID of its property. */
function toInstant(t, tzid) {
  if (t.zone === ICAL.Timezone.utcTimezone) return t.toUnixTime() * 1000;
  const minutes = t.hour * 60 + t.minute;
  if (isIana(tzid)) return zonedToInstant(timeDate(t), minutes, tzid) + t.second * 1000;
  // Non-IANA TZID (e.g. Outlook names) with an embedded VTIMEZONE: let ical.js convert.
  if (t.zone && t.zone !== ICAL.Timezone.localTimezone && t.zone.component) return t.toUnixTime() * 1000;
  // Floating time: interpret as local wall-clock time.
  return zonedToInstant(timeDate(t), minutes, TZ) + t.second * 1000;
}

function recurrenceKey(comp, ev) {
  const rid = ev.recurrenceId;
  if (rid.isDate) return String(zonedToInstant(timeDate(rid), 0));
  return String(toInstant(rid, comp.getFirstProperty('recurrence-id').getParameter('tzid')));
}

function text(v, max = 200) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function describe(component, owner) {
  const status = text(component.getFirstPropertyValue('status')).toUpperCase();
  if (status === 'CANCELLED') return null;
  const attendees = component.getAllProperties('attendee');
  if (owner) {
    for (const a of attendees) {
      const addr = String(a.getFirstValue() || '').replace(/^mailto:/i, '').toLowerCase();
      if (addr === owner && String(a.getParameter('partstat') || '').toUpperCase() === 'DECLINED') return null;
    }
  }
  const title = text(component.getFirstPropertyValue('summary')) || '(No title)';
  const location = text(component.getFirstPropertyValue('location'));
  const desc = String(component.getFirstPropertyValue('description') || '');
  const conf = String(component.getFirstPropertyValue('x-google-conference') || '');
  const blob = `${conf} ${location} ${desc}`;
  let meta = '';
  let conference = true;
  if (/meet\.google\.com/i.test(blob)) meta = 'Meet';
  else if (/zoom\.us/i.test(blob)) meta = 'Zoom';
  else if (/teams\.microsoft\.com/i.test(blob)) meta = 'Teams';
  else {
    conference = false;
    meta = location.split(',')[0].trim().slice(0, 60);
  }
  const transparent = text(component.getFirstPropertyValue('transp')).toUpperCase() === 'TRANSPARENT';
  const kind = conference || attendees.length > 1 ? 'meeting' : transparent ? 'free' : 'personal';
  return { title, meta, kind, busy: !transparent };
}

/**
 * Parse ICS text into day-sliced events for `days` NY dates starting at `from` (default today).
 * Returns { from, days, name, events: [{ id, date, title, meta, kind, busy, allDay, startMin, endMin, start, end }] }
 */
export function parseCalendar(icsText, { today, from = today, owner = null, days = 2 } = {}) {
  const root = new ICAL.Component(ICAL.parse(icsText));
  const dayList = Array.from({ length: days }, (_, i) => addDays(from, i));
  const bounds = dayList.map((d) => [d, zonedToInstant(d, 0), zonedToInstant(addDays(d, 1), 0)]);
  const rangeStart = bounds[0][1];
  const rangeEnd = bounds[bounds.length - 1][2];
  const allDayEnd = addDays(from, days);

  const vevents = root.getAllSubcomponents('vevent');
  const masters = new Map();
  const exceptions = new Map();
  for (const v of vevents) {
    const uid = String(v.getFirstPropertyValue('uid') || '');
    if (v.hasProperty('recurrence-id')) {
      if (!exceptions.has(uid)) exceptions.set(uid, []);
      exceptions.get(uid).push(v);
    } else if (!masters.has(uid) || !uid) {
      masters.set(uid || `__${masters.size}`, v);
    }
  }

  const out = [];
  const seen = new Set();

  const emit = (component, startT, endT, uid, recurKey) => {
    const key = `${uid}|${recurKey}`;
    if (seen.has(key)) return;
    const info = describe(component, owner);
    if (!info) { seen.add(key); return; }
    const startProp = component.getFirstProperty('dtstart');
    const tzid = startProp ? startProp.getParameter('tzid') : null;
    if (startT.isDate) {
      const s = timeDate(startT);
      const e = endT ? timeDate(endT) : addDays(s, 1);
      if (e <= dayList[0] || s >= allDayEnd) return;
      seen.add(key);
      for (const d of dayList) {
        if (d >= s && d < (e > s ? e : addDays(s, 1))) {
          out.push({ id: `${key}|${d}`, date: d, allDay: true, startMin: 0, endMin: 1440, start: null, end: null, ...info });
        }
      }
      return;
    }
    const start = toInstant(startT, tzid);
    const endProp = component.getFirstProperty('dtend');
    const end = endT ? toInstant(endT, endProp?.getParameter('tzid') || tzid) : start;
    if (end <= rangeStart && !(end === start && start === rangeStart)) return;
    if (start >= rangeEnd) return;
    seen.add(key);
    for (const [d, d0, d1] of bounds) {
      if (start < d1 && (end > d0 || (start === end && start >= d0))) {
        const startMin = start <= d0 ? 0 : minutesOfDay(start);
        const endMin = end >= d1 ? 1440 : Math.max(startMin, minutesOfDay(end));
        out.push({ id: `${key}|${d}`, date: d, allDay: false, startMin, endMin, start, end, ...info });
      }
    }
  };

  for (const [uid, comp] of masters) {
    const exs = exceptions.get(uid) || [];
    let ev;
    try {
      ev = new ICAL.Event(comp, { exceptions: exs });
    } catch {
      continue;
    }
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      emit(comp, ev.startDate, ev.endDate, uid, 'single');
      continue;
    }
    const tzid = comp.getFirstProperty('dtstart').getParameter('tzid');
    const it = ev.iterator();
    let next, n = 0;
    while ((next = it.next()) && n++ < MAX_ITERATIONS) {
      // Occurrence keys are compared by wall time; stop well after the range.
      const occStart = next.isDate ? zonedToInstant(timeDate(next), 0) : toInstant(next, tzid);
      if (occStart >= rangeEnd + 2 * 86400000) break;
      if (occStart < rangeStart - 2 * 86400000) continue;
      let details;
      try { details = ev.getOccurrenceDetails(next); } catch { continue; }
      emit(details.item.component, details.startDate, details.endDate, uid, String(occStart));
    }
    // Exceptions moved into the range from an occurrence outside it.
    for (const exComp of exs) {
      const exEv = new ICAL.Event(exComp, { exceptions: [] });
      if (exEv.startDate) emit(exComp, exEv.startDate, exEv.endDate, uid, recurrenceKey(exComp, exEv));
    }
  }
  // Orphan exceptions (no master in the feed).
  for (const [uid, exs] of exceptions) {
    if (masters.has(uid)) continue;
    for (const exComp of exs) {
      const exEv = new ICAL.Event(exComp, { exceptions: [] });
      if (exEv.startDate) emit(exComp, exEv.startDate, exEv.endDate, uid, recurrenceKey(exComp, exEv));
    }
  }

  out.sort((a, b) => a.date.localeCompare(b.date) || (b.allDay - a.allDay) || a.startMin - b.startMin || a.endMin - b.endMin);
  const name = text(root.getFirstPropertyValue('x-wr-calname'), 80);
  return { from, days: dayList, name, events: out.slice(0, MAX_EVENTS) };
}
