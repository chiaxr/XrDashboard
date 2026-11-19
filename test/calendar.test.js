import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, ownerFromUrl, isValidIcalUrl } from '../lib/calendar.js';

const VTZ = `BEGIN:VTIMEZONE
TZID:America/New_York
X-LIC-LOCATION:America/New_York
BEGIN:DAYLIGHT
TZOFFSETFROM:-0500
TZOFFSETTO:-0400
TZNAME:EDT
DTSTART:19700308T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:-0400
TZOFFSETTO:-0500
TZNAME:EST
DTSTART:19701101T020000
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU
END:STANDARD
END:VTIMEZONE`;

const ev = (lines) => `BEGIN:VEVENT\n${lines.trim()}\nEND:VEVENT`;
const cal = (...events) => `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//test//EN\n${VTZ}\n${events.join('\n')}\nEND:VCALENDAR\n`.replace(/\n/g, '\r\n');

const OWNER = 'me@example.com';
const parse = (ics, today = '2026-11-19') => parseCalendar(ics, { today, owner: OWNER }).events;
const hm = (e) => `${String(Math.floor(e.startMin / 60)).padStart(2, '0')}:${String(e.startMin % 60).padStart(2, '0')}`;

test('single timed event in NY time', () => {
  const evs = parse(cal(ev(`
UID:a
DTSTART;TZID=America/New_York:20261119T110000
DTEND;TZID=America/New_York:20261119T120000
SUMMARY:Design review
LOCATION:Room 3, 2nd floor`)));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].title, 'Design review');
  assert.equal(evs[0].startMin, 660);
  assert.equal(evs[0].endMin, 720);
  assert.equal(evs[0].meta, 'Room 3');
  assert.equal(evs[0].date, '2026-11-19');
});

test('UTC event converts to NY local time (EST, UTC−5)', () => {
  const evs = parse(cal(ev(`
UID:b
DTSTART:20261119T140000Z
DTEND:20261119T143000Z
SUMMARY:UTC call`)));
  assert.equal(hm(evs[0]), '09:00');
  assert.equal(evs[0].endMin, 570);
});

test('event in another IANA timezone', () => {
  const evs = parse(cal(ev(`
UID:c
DTSTART;TZID=Europe/London:20261119T150000
DTEND;TZID=Europe/London:20261119T160000
SUMMARY:London sync`)));
  assert.equal(hm(evs[0]), '10:00');
});

test('weekly recurrence across DST keeps wall-clock time; EXDATE and moved exception honoured', () => {
  const ics = cal(
    ev(`
UID:standup
DTSTART;TZID=America/New_York:20250602T090000
DTEND;TZID=America/New_York:20250602T093000
RRULE:FREQ=DAILY
EXDATE;TZID=America/New_York:20261120T090000
SUMMARY:Team standup
ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:you@example.com
DESCRIPTION:Join https://meet.google.com/abc-defg-hij`),
    ev(`
UID:standup
RECURRENCE-ID;TZID=America/New_York:20261119T090000
DTSTART;TZID=America/New_York:20261119T100000
DTEND;TZID=America/New_York:20261119T103000
SUMMARY:Team standup (moved)`),
  );
  const evs = parse(ics);
  const today = evs.filter((e) => e.date === '2026-11-19');
  const tomorrow = evs.filter((e) => e.date === '2026-11-20');
  assert.equal(today.length, 1);
  assert.equal(today[0].title, 'Team standup (moved)');
  assert.equal(hm(today[0]), '10:00');
  assert.equal(tomorrow.length, 0, 'EXDATE removes tomorrow');
  // Summer (EDT) date still at 09:00 local.
  const summer = parse(ics, '2026-07-01');
  assert.equal(hm(summer[0]), '09:00');
  assert.equal(summer[0].meta, 'Meet');
  assert.equal(summer[0].kind, 'meeting');
});

test('exception moved into today from another day is included once', () => {
  const evs = parse(cal(
    ev(`
UID:weekly
DTSTART;TZID=America/New_York:20261102T140000
DTEND;TZID=America/New_York:20261102T150000
RRULE:FREQ=WEEKLY;BYDAY=MO
SUMMARY:Weekly 1:1`),
    ev(`
UID:weekly
RECURRENCE-ID;TZID=America/New_York:20261116T140000
DTSTART;TZID=America/New_York:20261119T153000
DTEND;TZID=America/New_York:20261119T160000
SUMMARY:Weekly 1:1`),
  ));
  assert.equal(evs.length, 1);
  assert.equal(hm(evs[0]), '15:30');
});

test('all-day events, multi-day spans', () => {
  const evs = parse(cal(
    ev(`
UID:allday
DTSTART;VALUE=DATE:20261119
DTEND;VALUE=DATE:20261120
SUMMARY:Holiday`),
    ev(`
UID:trip
DTSTART;VALUE=DATE:20261118
DTEND;VALUE=DATE:20261122
SUMMARY:Conference`),
  ));
  const today = evs.filter((e) => e.date === '2026-11-19');
  assert.deepEqual(today.map((e) => e.title).sort(), ['Conference', 'Holiday']);
  assert.ok(today.every((e) => e.allDay));
  assert.equal(evs.filter((e) => e.date === '2026-11-20').length, 1);
});

test('timed event crossing midnight is sliced per day', () => {
  const evs = parse(cal(ev(`
UID:late
DTSTART;TZID=America/New_York:20261119T230000
DTEND;TZID=America/New_York:20261120T010000
SUMMARY:Late`)));
  assert.equal(evs.length, 2);
  assert.equal(evs[0].endMin, 1440);
  assert.equal(evs[1].startMin, 0);
  assert.equal(evs[1].endMin, 60);
});

test('declined and cancelled events are dropped', () => {
  const evs = parse(cal(
    ev(`
UID:declined
DTSTART;TZID=America/New_York:20261119T130000
DTEND;TZID=America/New_York:20261119T140000
SUMMARY:Declined thing
ATTENDEE;PARTSTAT=DECLINED:mailto:ME@example.com
ATTENDEE;PARTSTAT=ACCEPTED:mailto:other@example.com`),
    ev(`
UID:cancelled
DTSTART;TZID=America/New_York:20261119T150000
DTEND;TZID=America/New_York:20261119T160000
STATUS:CANCELLED
SUMMARY:Cancelled thing`),
  ));
  assert.equal(evs.length, 0);
});

test('free (transparent) events are not busy; control characters stripped', () => {
  const evs = parse(cal(ev(`
UID:free
DTSTART;TZID=America/New_York:20261119T120000
DTEND;TZID=America/New_York:20261119T130000
TRANSP:TRANSPARENT
SUMMARY:<b>Lunch</b>\\nmaybe`)));
  assert.equal(evs[0].busy, false);
  assert.equal(evs[0].kind, 'free');
  assert.equal(evs[0].title, '<b>Lunch</b> maybe');
});

test('URL helpers', () => {
  const url = 'https://calendar.google.com/calendar/ical/me%40example.com/private-abc123/basic.ics';
  assert.ok(isValidIcalUrl(url));
  assert.equal(ownerFromUrl(url), 'me@example.com');
  assert.ok(!isValidIcalUrl('https://evil.example.com/calendar/ical/a/b/basic.ics'));
  assert.ok(!isValidIcalUrl('http://calendar.google.com/calendar/ical/a/b/basic.ics'));
});

test('date range: events before and after today are kept, with the calendar name', async () => {
  const { parseCalendar: parse2 } = await import('../lib/calendar.js');
  const ics = cal(
    ev(`
UID:past
DTSTART;TZID=America/New_York:20261115T100000
DTEND;TZID=America/New_York:20261115T110000
SUMMARY:Past`),
    ev(`
UID:future
DTSTART;TZID=America/New_York:20261215T100000
DTEND;TZID=America/New_York:20261215T110000
SUMMARY:Future`),
    ev(`
UID:outside
DTSTART;TZID=America/New_York:20270115T100000
DTEND;TZID=America/New_York:20270115T110000
SUMMARY:Too far`),
  ).replace('PRODID:-//test//EN', 'PRODID:-//test//EN\r\nX-WR-CALNAME:Work');
  const r = parse2(ics, { today: '2026-11-19', from: '2026-11-12', days: 38 });
  assert.equal(r.name, 'Work');
  assert.equal(r.from, '2026-11-12');
  assert.deepEqual(r.events.map((e) => [e.title, e.date]), [['Past', '2026-11-15'], ['Future', '2026-12-15']]);
});

test('merging calendars: tags, de-duplicates shared events, keeps previous events on failure', async () => {
  const { mergeCalendars } = await import('../lib/calendar.js');
  const e = (id, title, date = '2026-11-19', startMin = 600) => ({ id, title, date, startMin, endMin: startMin + 60, allDay: false });
  const merged = mergeCalendars('2026-11-19', [
    { id: 'a', name: '', color: '#1', result: { name: 'me@example.com', from: '2026-11-12', days: ['2026-11-12', '2026-12-19'], events: [e('x|1|d', 'Shared'), e('y|1|d', 'Mine', '2026-11-19', 540)] } },
    { id: 'b', name: 'Work', color: '#2', result: { name: 'Work feed', events: [e('x|1|d', 'Shared'), e('z|1|d', 'Work thing', '2026-11-19', 700)] } },
    { id: 'c', name: '', color: '#3', error: 'HTTP 404', previous: [{ ...e('w|1|d', 'Old'), cal: 2 }], previousName: 'Family' },
  ]);
  assert.deepEqual(merged.events.map((x) => [x.title, x.cal]), [['Mine', 0], ['Shared', 0], ['Old', 2], ['Work thing', 1]]);
  assert.deepEqual(merged.calendars.map((c) => [c.name, c.error || null]), [['me@example.com', null], ['Work', null], ['Family', 'HTTP 404']]);
  assert.equal(merged.from, '2026-11-12');
  assert.equal(merged.to, '2026-12-19');
});

test('config migrates a single icalUrl to the calendars list', async () => {
  const { withDefaults } = await import('../lib/config.js');
  const c = withDefaults({ icalUrl: ' https://calendar.google.com/calendar/ical/a/b/basic.ics ' });
  assert.deepEqual(c.calendars, [{ url: 'https://calendar.google.com/calendar/ical/a/b/basic.ics', name: '' }]);
  assert.equal('icalUrl' in c, false);
  assert.deepEqual(withDefaults({ calendars: [{ url: 'u', name: ' Work ' }, { url: '' }] }).calendars, [{ url: 'u', name: 'Work' }]);
});
