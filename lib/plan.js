// Schedule ↔ to-do logic. Pure functions (no DOM, no storage), unit-tested in test/plan.test.js.
// Times are minutes since local midnight; dates are 'YYYY-MM-DD' (America/New_York).

import { addDays, fmtHM } from './time.js';

export const DAY_START = 8 * 60;
export const DAY_END = 20 * 60;
export const MIN_GAP = 15;
export const MAX_SUGGESTIONS = 2;

const timedOn = (events, date) => events.filter((e) => e.date === date && !e.allDay);

/** Free gaps ≥ minGap between max(now, dayStart) and dayEnd, around busy timed events. */
export function computeGaps(events, date, nowMin, { dayStart = DAY_START, dayEnd = DAY_END, minGap = MIN_GAP } = {}) {
  const start = Math.max(dayStart, nowMin);
  if (start >= dayEnd) return [];
  const busy = timedOn(events, date)
    .filter((e) => e.busy !== false && e.endMin > e.startMin)
    .map((e) => [e.startMin, e.endMin])
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cursor = start;
  for (const [s, e] of busy) {
    if (e <= cursor) continue;
    if (s > cursor) gaps.push({ start: cursor, end: Math.min(s, dayEnd) });
    cursor = Math.max(cursor, e);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });
  return gaps
    .map((g) => ({ ...g, minutes: g.end - g.start }))
    .filter((g) => g.minutes >= minGap);
}

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The earliest upcoming timed event today whose title matches the to-do's "Related event". */
export function matchEvent(related, events, date, nowMin) {
  const r = norm(related);
  if (!r) return null;
  return timedOn(events, date)
    .filter((e) => e.startMin > nowMin)
    .sort((a, b) => a.startMin - b.startMin)
    .find((e) => {
      const t = norm(e.title);
      return t === r || (r.length >= 3 && t.includes(r));
    }) || null;
}

const rankOf = (t) => (t.priority && t.priority.rank != null ? t.priority.rank : Infinity);
/** Within a group: priority (unset last), then due date, then title. */
const byDueThenTitle = (a, b) => (rankOf(a) - rankOf(b) || 0)
  || (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title);

/**
 * Group open to-dos: Overdue → Prep for <event> (one group per event) → Today → This week.
 * Returns { groups: [{ key, kind, name, event?, items }], later: [...] } (empty groups omitted).
 */
export function groupTodos(todos, events, date, nowMin) {
  const weekEnd = addDays(date, 7);
  const overdue = [], today = [], week = [], later = [];
  const prep = new Map();
  for (const t of todos) {
    if (t.due && t.due < date) { overdue.push(t); continue; }
    const ev = matchEvent(t.related, events, date, nowMin);
    if (ev) {
      if (!prep.has(ev.id)) prep.set(ev.id, { event: ev, items: [] });
      prep.get(ev.id).items.push(t);
      continue;
    }
    if (t.due === date) today.push(t);
    else if (t.due && t.due <= weekEnd) week.push(t);
    else later.push(t);
  }
  const groups = [];
  if (overdue.length) groups.push({ key: 'overdue', kind: 'overdue', name: 'Overdue', items: overdue.sort(byDueThenTitle) });
  for (const { event, items } of [...prep.values()].sort((a, b) => a.event.startMin - b.event.startMin)) {
    groups.push({ key: `prep:${event.id}`, kind: 'prep', name: `Prep for ${fmtHM(event.startMin)} ${event.title}`, event, items: items.sort(byDueThenTitle) });
  }
  if (today.length) groups.push({ key: 'today', kind: 'today', name: 'Today', items: today.sort(byDueThenTitle) });
  if (week.length) groups.push({ key: 'week', kind: 'week', name: 'This week', items: week.sort(byDueThenTitle) });
  return { groups, later: later.sort(byDueThenTitle) };
}

/**
 * Walk gaps in time order and suggest to-dos: prep items (only in gaps that end before
 * their event), then overdue, then today. An item fits if estimate ≤ remaining gap.
 * Items without an estimate are never placed. At most MAX_SUGGESTIONS per gap.
 * Returns { gaps: [{ ...gap, suggestions: [{ todo, kind }] }], placements: Map<todoId, gapStart> }.
 */
export function fillGaps(gaps, groups) {
  const prepItems = groups.filter((g) => g.kind === 'prep')
    .flatMap((g) => g.items.map((todo) => ({ todo, kind: 'prep', before: g.event.startMin })));
  const rest = ['overdue', 'today'].flatMap((kind) =>
    groups.filter((g) => g.kind === kind).flatMap((g) => g.items.map((todo) => ({ todo, kind }))));
  const candidates = [...prepItems, ...rest];
  const placements = new Map();
  const out = [...gaps].sort((a, b) => a.start - b.start).map((gap) => {
    let remaining = gap.end - gap.start;
    const suggestions = [];
    for (const c of candidates) {
      if (suggestions.length >= MAX_SUGGESTIONS) break;
      if (placements.has(c.todo.id) || c.todo.estimate == null) continue;
      if (c.before != null && gap.end > c.before) continue;
      if (c.todo.estimate <= remaining) {
        suggestions.push({ todo: c.todo, kind: c.kind });
        placements.set(c.todo.id, gap.start);
        remaining -= c.todo.estimate;
      }
    }
    return { ...gap, suggestions };
  });
  return { gaps: out, placements };
}

/** Footer stats: estimated minutes due today (overdue + prep + today) vs free gap minutes. */
export function loadStats(groups, gaps) {
  const due = groups.filter((g) => g.kind !== 'week')
    .flatMap((g) => g.items)
    .reduce((sum, t) => sum + (t.estimate || 0), 0);
  const free = gaps.reduce((sum, g) => sum + (g.end - g.start), 0);
  return { due, free, fits: due <= free, over: Math.max(0, due - free) };
}

/** Overlapping events side by side: adds { col, cols }. */
export function layoutEvents(events) {
  const sorted = [...events].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out = [];
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    const colEnds = [];
    const placed = cluster.map((e) => {
      let col = colEnds.findIndex((end) => end <= e.startMin);
      if (col === -1) { col = colEnds.length; colEnds.push(0); }
      colEnds[col] = Math.max(e.endMin, e.startMin + 15);
      return { ...e, col };
    });
    for (const p of placed) out.push({ ...p, cols: colEnds.length });
    cluster = [];
  };
  for (const e of sorted) {
    const end = Math.max(e.endMin, e.startMin + 15);
    if (cluster.length && e.startMin >= clusterEnd) flush();
    if (!cluster.length) clusterEnd = end;
    cluster.push(e);
    clusterEnd = Math.max(clusterEnd, end);
  }
  if (cluster.length) flush();
  return out;
}

/** Header text for the schedule panel: "Next: Team standup in 18 min" / "Now: … until 11:00". */
export function nextLabel(events, date, nowMin) {
  const timed = timedOn(events, date).sort((a, b) => a.startMin - b.startMin);
  const current = timed.find((e) => e.startMin <= nowMin && e.endMin > nowMin && e.busy !== false);
  const next = timed.find((e) => e.startMin > nowMin);
  if (next) {
    const mins = next.startMin - nowMin;
    const when = mins < 60 ? `in ${mins} min` : `at ${fmtHM(next.startMin)}`;
    return `Next: ${next.title} ${when}`;
  }
  if (current) return `Now: ${current.title} until ${fmtHM(current.endMin)}`;
  return timed.length ? 'No more events today' : '';
}
