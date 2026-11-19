import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGaps, groupTodos, fillGaps, loadStats, matchEvent, layoutEvents, nextLabel } from '../lib/plan.js';

const D = '2026-11-19';
const at = (h, m = 0) => h * 60 + m;
const ev = (id, title, s, e, extra = {}) => ({ id, title, date: D, allDay: false, startMin: s, endMin: e, busy: true, ...extra });
const todo = (id, title, extra = {}) => ({ id, title, due: null, estimate: null, related: '', ...extra });

// The sample day from the design mockup.
const EVENTS = [
  ev('standup', 'Team standup', at(9), at(9, 30)),
  ev('review', 'Design review', at(11), at(12)),
  ev('lunch', 'Lunch', at(13), at(14)),
  ev('oneone', '1:1 check-in', at(15, 30), at(16)),
  ev('gym', 'Gym', at(18, 30), at(20)),
];

test('gaps between events from 08:00, ignoring short ones', () => {
  const gaps = computeGaps(EVENTS, D, at(7));
  assert.deepEqual(gaps.map((g) => [g.start, g.end]), [
    [at(8), at(9)], [at(9, 30), at(11)], [at(12), at(13)], [at(14), at(15, 30)], [at(16), at(18, 30)],
  ]);
});

test('gaps start at now; passed gaps are dropped; gaps < 15 min dropped', () => {
  const gaps = computeGaps(EVENTS, D, at(8, 50));
  assert.deepEqual(gaps[0], { start: at(9, 30), end: at(11), minutes: 90 });
  const g2 = computeGaps(EVENTS, D, at(10, 50));
  assert.equal(g2[0].start, at(12), '10 min left before 11:00 is too short');
  assert.deepEqual(computeGaps(EVENTS, D, at(20, 5)), []);
});

test('overlapping events, all-day events, free events and other days do not create bogus gaps', () => {
  const events = [
    ev('a', 'A', at(9), at(11)),
    ev('b', 'B', at(10), at(10, 30)),
    ev('c', 'C', at(10, 45), at(12)),
    ev('allday', 'Holiday', 0, 1440, { allDay: true }),
    ev('free', 'Focus (free)', at(13), at(14), { busy: false }),
    { ...ev('tmr', 'Tomorrow', at(12), at(19)), date: '2026-11-20' },
  ];
  const gaps = computeGaps(events, D, 0);
  assert.deepEqual(gaps.map((g) => [g.start, g.end]), [[at(8), at(9)], [at(12), at(20)]]);
});

test('empty day is one big gap', () => {
  assert.deepEqual(computeGaps([], D, at(6)).map((g) => g.minutes), [720]);
});

test('related event matching is case-insensitive and only for upcoming events', () => {
  assert.equal(matchEvent('design REVIEW', EVENTS, D, at(8)).id, 'review');
  assert.equal(matchEvent('design review', EVENTS, D, at(11, 30)), null, 'already started');
  assert.equal(matchEvent('', EVENTS, D, at(8)), null);
  assert.equal(matchEvent('xx', EVENTS, D, at(8)), null);
});

const TODOS = [
  todo('exp', 'Submit expense report', { due: '2026-11-17', estimate: 20 }),
  todo('slides', 'Prepare slides', { due: '2026-11-19', estimate: 60, related: 'Design review' }),
  todo('landlord', 'Reply to landlord about lease', { due: D, estimate: 15 }),
  todo('flights', 'Book December flights', { due: D, estimate: 30 }),
  todo('passport', 'Renew passport', { due: '2026-11-20' }),
  todo('boots', 'Order winter boots', { due: '2026-11-22', estimate: 10 }),
  todo('thanks', 'Plan Thanksgiving dinner', { due: '2026-11-26' }),
  todo('someday', 'Learn Rust'),
  todo('far', 'Taxes', { due: '2027-04-15' }),
];

test('grouping order: overdue → prep → today → this week; rest is later', () => {
  const { groups, later } = groupTodos(TODOS, EVENTS, D, at(8, 42));
  assert.deepEqual(groups.map((g) => g.name), ['Overdue', 'Prep for 11:00 Design review', 'Today', 'This week']);
  assert.deepEqual(groups[0].items.map((t) => t.id), ['exp']);
  assert.deepEqual(groups[1].items.map((t) => t.id), ['slides']);
  assert.deepEqual(groups[2].items.map((t) => t.id), ['flights', 'landlord']);
  assert.deepEqual(groups[3].items.map((t) => t.id), ['passport', 'boots', 'thanks']);
  assert.deepEqual(later.map((t) => t.id), ['far', 'someday']);
});

test('overdue wins over prep; prep falls back to due group once the event has started', () => {
  const t = [todo('x', 'Overdue prep', { due: '2026-11-18', related: 'Design review' })];
  assert.equal(groupTodos(t, EVENTS, D, at(8)).groups[0].kind, 'overdue');
  const t2 = [todo('y', 'Late prep', { due: D, related: 'Design review' })];
  assert.equal(groupTodos(t2, EVENTS, D, at(11, 5)).groups[0].kind, 'today');
});

test('gap filling: prep before its event first, then overdue, then today; max two per gap', () => {
  const now = at(8, 42);
  const { groups } = groupTodos(TODOS, EVENTS, D, now);
  const gaps = computeGaps(EVENTS, D, now);
  const { gaps: filled, placements } = fillGaps(gaps, groups);
  const show = filled.map((g) => g.suggestions.map((s) => s.todo.id));
  // 08:42–09:00 (18m): landlord 15 fits (prep slides 60 and expense 20 don't).
  // 09:30–11:00 (90m): slides 60 → expense 20 (remaining 10, nothing else fits).
  // 12:00–13:00 (60m): flights 30.
  assert.deepEqual(show, [['landlord'], ['slides', 'exp'], ['flights'], [], []]);
  assert.equal(placements.get('slides'), at(9, 30));
  assert.ok(!placements.has('passport'), 'no estimate → never placed');
  assert.ok(!placements.has('boots'), 'this-week items are not auto-placed');
});

test('prep items never go into a gap that ends after their event starts', () => {
  const events = [ev('rev', 'Review', at(9), at(10))];
  const groups = groupTodos([todo('p', 'Prep', { estimate: 30, related: 'Review' })], events, D, at(8, 45)).groups;
  const gaps = computeGaps(events, D, at(8, 45)); // 08:45–09:00 (15m), 10:00–20:00
  const { gaps: filled } = fillGaps(gaps, groups);
  assert.deepEqual(filled.map((g) => g.suggestions.length), [0, 0]);
});

test('each item placed at most once; fills in order by remaining space', () => {
  const groups = [{ kind: 'today', items: [todo('a', 'A', { estimate: 50 }), todo('b', 'B', { estimate: 20 }), todo('c', 'C', { estimate: 10 })] }];
  const { gaps } = fillGaps([{ start: 0, end: 60 }, { start: 100, end: 160 }], groups);
  assert.deepEqual(gaps.map((g) => g.suggestions.map((s) => s.todo.id)), [['a', 'c'], ['b']]);
});

test('load stats: fits vs over by', () => {
  const { groups } = groupTodos(TODOS, EVENTS, D, at(8, 42));
  const gaps = computeGaps(EVENTS, D, at(8, 42));
  const s = loadStats(groups, gaps);
  assert.equal(s.due, 125); // 20 + 60 + 15 + 30, matches "2h 05m" in the mockup
  assert.equal(s.free, 18 + 90 + 60 + 90 + 150);
  assert.equal(s.fits, true);
  const tight = loadStats(groups, [{ start: 0, end: 100 }]);
  assert.deepEqual([tight.fits, tight.over], [false, 25]);
});

test('layout puts overlapping events side by side', () => {
  const out = layoutEvents([ev('a', 'A', 540, 600), ev('b', 'B', 570, 630), ev('c', 'C', 660, 690)]);
  const by = Object.fromEntries(out.map((e) => [e.id, [e.col, e.cols]]));
  assert.deepEqual(by, { a: [0, 2], b: [1, 2], c: [0, 1] });
});

test('next label', () => {
  assert.equal(nextLabel(EVENTS, D, at(8, 42)), 'Next: Team standup in 18 min');
  assert.equal(nextLabel(EVENTS, D, at(19)), 'Now: Gym until 20:00');
  assert.equal(nextLabel(EVENTS, D, at(16, 10)), 'Next: Gym at 18:30');
  assert.equal(nextLabel([], D, at(9)), '');
});

test('priority orders items within a group (unset last), then due date', () => {
  const p = (rank) => ({ label: String(rank), rank });
  const todos = [
    todo('none', 'A no priority', { due: D, estimate: 10 }),
    todo('low', 'B low', { due: D, estimate: 10, priority: p(3) }),
    todo('high', 'C high', { due: D, estimate: 10, priority: p(1) }),
    todo('high2', 'D high later due', { due: '2026-11-21', priority: p(1) }),
    todo('high3', 'E high sooner due', { due: '2026-11-20', priority: p(1) }),
  ];
  const { groups } = groupTodos(todos, [], D, at(8));
  assert.deepEqual(groups.find((g) => g.kind === 'today').items.map((t) => t.id), ['high', 'low', 'none']);
  assert.deepEqual(groups.find((g) => g.kind === 'week').items.map((t) => t.id), ['high3', 'high2']);
});

test('gap filling takes higher-priority items first within a kind', () => {
  const p = (rank) => ({ label: String(rank), rank });
  const todos = [
    todo('low', 'Low', { due: D, estimate: 30, priority: p(3) }),
    todo('high', 'High', { due: D, estimate: 30, priority: p(1) }),
  ];
  const { groups } = groupTodos(todos, [], D, at(8));
  const { gaps } = fillGaps([{ start: at(9), end: at(9, 30) }], groups);
  assert.deepEqual(gaps[0].suggestions.map((s) => s.todo.id), ['high']);
});

test('time helpers: 12-hour clock, Singapore, Monday', async () => {
  const { fmtClock12, fmtWeekday, mondayOf, fmtDayMonth } = await import('../lib/time.js');
  const t = Date.parse('2026-11-19T13:42:00Z'); // 08:42 EST, 21:42 SGT
  assert.equal(fmtClock12(t), '8:42 AM');
  assert.equal(fmtClock12(t, 'Asia/Singapore'), '9:42 PM');
  assert.equal(fmtClock12(Date.parse('2026-11-19T05:05:00Z')), '12:05 AM');
  assert.equal(fmtClock12(Date.parse('2026-11-19T17:00:00Z')), '12:00 PM');
  assert.equal(fmtWeekday(Date.parse('2026-11-20T02:00:00Z'), 'Asia/Singapore'), 'Fri');
  assert.equal(mondayOf('2026-11-19'), '2026-11-16');
  assert.equal(mondayOf('2026-11-16'), '2026-11-16');
  assert.equal(mondayOf('2026-11-22'), '2026-11-16');
  assert.equal(fmtDayMonth('2026-11-20'), 'Fri 20 Nov');
});
